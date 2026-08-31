import { Database } from "bun:sqlite";
import { RRF_K, type Budgets } from "@/core/config";
import type { NumericLedgerSearchRow } from "@/storage/index/search";
import { parseSourceRefCount, transferBoost } from "./transfer";
import type { ChunkRow, PacketItem, RecallMode, Scored } from "./packet";

export const ACTIVE_STATUSES = ["active", "candidate", "staging", ""];
export const HISTORY_STATUSES = ["active", "candidate", "staging", "disputed", "retired", "suppressed", "superseded", "archived", ""];
export const GUIDANCE_KINDS = ["experience", "skill", "case", "core", "memory"];
export const FACT_KINDS = ["memory", "core", "case", "experience", "skill"];

export function modeKinds(mode: RecallMode): string[] | null {
  if (mode === "guidance") return GUIDANCE_KINDS;
  if (mode === "facts") return FACT_KINDS;
  return null;
}

export function allowedOwner(owner: string, ownerFilter?: string, teamOwners = new Set<string>()): boolean {
  if (!ownerFilter) return true;
  return owner === ownerFilter || teamOwners.has(owner);
}

export function rowAllowed(row: Pick<ChunkRow, "owner" | "status" | "kind">, mode: RecallMode, ownerFilter?: string, teamOwners = new Set<string>()): boolean {
  if (!allowedOwner(row.owner, ownerFilter, teamOwners)) return false;
  const statuses = mode === "history" ? HISTORY_STATUSES : ACTIVE_STATUSES;
  if (!statuses.includes(row.status ?? "")) return false;
  const kinds = modeKinds(mode);
  return !kinds || kinds.includes(row.kind);
}

export function rankRows(
  rows: ChunkRow[],
  lexRank: Map<number, number>,
  vecRank: Map<number, number>,
  ledgerRank: Map<number, number>,
  ledgerByChunk: Map<number, NumericLedgerSearchRow>,
): Scored[] {
  return rows.map((row) => {
    const lr = lexRank.get(row.chunk_id);
    const vr = vecRank.get(row.chunk_id);
    const nr = ledgerRank.get(row.chunk_id);
    // WHY: ledger 3× so exact numeric evidence survives RRF tie-break; lexical/vector are noisier.
    return {
      ...row,
      rrf:
        (lr === undefined ? 0 : 1 / (RRF_K + lr + 1)) +
        (vr === undefined ? 0 : 1 / (RRF_K + vr + 1)) +
        (nr === undefined ? 0 : 3 / (RRF_K + nr + 1)),
      rankLex: lr,
      rankVec: vr,
      rankLedger: nr,
      ledger: ledgerByChunk.get(row.chunk_id),
      source: nr !== undefined ? "ledger" as const : "fused" as const,
    };
  }).sort((a, b) => b.rrf - a.rrf || a.doc_id.localeCompare(b.doc_id) || a.chunk_id - b.chunk_id);
}

export function multiHop(
  seeds: Scored[],
  db: Database,
  mode: RecallMode,
  ownerFilter?: string,
  teamOwners = new Set<string>(),
  maxHops = 2,
): Scored[] {
  const bestByDoc = new Map<string, Scored>();
  for (const seed of seeds) if (!bestByDoc.has(seed.doc_id)) bestByDoc.set(seed.doc_id, seed);

  // BFS graph traversal up to maxHops with monotonic decay (0.5 per hop)
  let currentFrontier = new Map<string, number>();
  for (const seed of [...bestByDoc.values()].slice(0, 8)) {
    currentFrontier.set(seed.doc_id, seed.rrf);
  }

  const visited = new Set<string>(bestByDoc.keys());
  const expansion = new Map<string, number>();

  for (let hop = 1; hop <= maxHops; hop++) {
    const nextFrontier = new Map<string, number>();
    for (const [docId, score] of currentFrontier.entries()) {
      const links = db.query(
        "SELECT dst FROM links WHERE src=? UNION SELECT src AS dst FROM links WHERE dst=? ORDER BY dst LIMIT 8",
      ).all(docId, docId) as { dst: string }[];

      for (const { dst } of links) {
        if (visited.has(dst)) continue;
        const inherited = score / 2;
        const prev = nextFrontier.get(dst) ?? 0;
        if (inherited > prev) nextFrontier.set(dst, inherited);
      }
    }

    for (const [docId, score] of nextFrontier.entries()) {
      visited.add(docId);
      expansion.set(docId, Math.max(expansion.get(docId) ?? 0, score));
    }
    currentFrontier = nextFrontier;
    if (currentFrontier.size === 0) break;
  }

  for (const [docId, score] of [...expansion.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16)) {
    const row = db.query(
      "SELECT chunk_id, doc_id, text, section, kind, scope, source_refs, status, hash, owner FROM chunks WHERE doc_id=? ORDER BY chunk_id LIMIT 1",
    ).get(docId) as ChunkRow | null;
    if (!row || !rowAllowed(row, mode, ownerFilter, teamOwners)) continue;
    bestByDoc.set(docId, { ...row, rrf: score, source: "link" });
  }
  return [...bestByDoc.values()].sort((a, b) => b.rrf - a.rrf || a.doc_id.localeCompare(b.doc_id));
}

export function isTransferable(item: PacketItem): boolean {
  if (item.kind === "skill" && (item.status ?? "active") === "active") return true;
  const n = parseSourceRefCount(item.source_refs || item.scope);
  const roots = new Set((item.source_refs || item.scope || "").split(/[;,]/).map((v) => v.trim()).filter(Boolean)).size;
  if (n >= 2 || roots >= 2) return true;
  if (item.kind === "experience" && item.status !== "candidate") return true;
  return false;
}

export function boostReusable(items: PacketItem[], lexCount: number, perArmCap: number): PacketItem[] {
  return [...items]
    .map((item) => {
      const raw = item.source_refs || item.scope;
      const sourceCount = parseSourceRefCount(raw);
      const distinctRoots = sourceCount;
      const boost = transferBoost({
        kind: item.kind,
        status: item.status ?? "active",
        sourceCount,
        distinctRoots,
        lexicalCoverage: lexCount,
        perArmCap,
      });
      return { ...item, rrf: Math.round((item.rrf + boost) * 1000) / 1000 };
    })
    .sort((a, b) => b.rrf - a.rrf || a.docId.localeCompare(b.docId));
}

export function quotaOrder(items: PacketItem[], budgets: Budgets): PacketItem[] {
  const quotas = budgets.quotas as Record<string, number>;
  const selected: PacketItem[] = [];
  const counts: Record<string, number> = {};
  for (const item of items) {
    const limit = Object.hasOwn(quotas, item.kind) ? quotas[item.kind] : 0;
    if ((counts[item.kind] ?? 0) >= limit) continue;
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    selected.push(item);
  }
  return selected;
}

export function allocate(items: PacketItem[], target: 10 | 20 | 30, budgets: Budgets): PacketItem[] {
  const ordered = quotaOrder(items, budgets);
  const out: PacketItem[] = [];
  for (const item of ordered) {
    if (out.length >= target) break;
    out.push(item);
  }
  return out;
}
