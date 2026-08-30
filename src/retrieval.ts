import { Database } from "bun:sqlite";
import type { Budgets } from "./config";
import { RRF_K } from "./config";
import { embedTexts, ftsSearch, vecSearch, vectorStatus } from "./index";
import { nearDuplicateStatement, parseSourceRefCount, transferBoost } from "./transfer";

export type RecallMode = "auto" | "facts" | "guidance" | "history";

export type PacketItem = {
  ref: string;
  docId: string;
  kind: string;
  summary: string;
  section?: string;
  scope?: string;
  source_refs?: string;
  status?: string;
  owner: string;
  rrf: number;
  source: "exact" | "fused" | "link";
};

export type Packet = {
  id: string;
  mode: RecallMode;
  targetCandidates: 10 | 20 | 30;
  items: PacketItem[];
  l1?: { ref: string; overview: string; section: string }[];
  next: string;
  attribution: {
    lexCapped: number;
    vecCapped: number;
    fused: number;
    linked: number;
    returned: number;
    packetBytes: number;
    packetTokensEstimate: number;
    vector: { available: boolean; indexed: number; reason?: string };
    filters: { owner: string | null; statuses: string[]; kinds: string[] | null };
  };
};

export type RetrievalUsageItem = Pick<PacketItem, "ref" | "docId" | "kind" | "owner" | "source">;

// ponytail: process-local metadata avoids changing MCP packet shape; durable audit begins at MCP boundary.
const RETRIEVAL_USAGE: unique symbol = Symbol("retrievalUsage");
type PacketWithUsage = Packet & { [RETRIEVAL_USAGE]?: RetrievalUsageItem[] };

function attachRetrievalUsage(packet: Packet, items: PacketItem[]) {
  const usage = items.map(({ ref, docId, kind, owner, source }) => ({ ref, docId, kind, owner, source }));
  Object.defineProperty(packet, RETRIEVAL_USAGE, { value: usage });
  return packet;
}

export function getRetrievalUsage(packet: Packet): RetrievalUsageItem[] {
  return (packet as PacketWithUsage)[RETRIEVAL_USAGE] ?? packet.items.map(({ ref, docId, kind, owner, source }) => ({ ref, docId, kind, owner, source }));
}

type ChunkRow = {
  chunk_id: number;
  doc_id: string;
  text: string;
  section: string;
  kind: string;
  scope: string;
  source_refs: string;
  status: string;
  hash: string;
  owner: string;
};

type Scored = ChunkRow & {
  rrf: number;
  rankLex?: number;
  rankVec?: number;
  source: PacketItem["source"];
};

const ACTIVE_STATUSES = ["active", "candidate", "staging", ""];
const HISTORY_STATUSES = ["active", "candidate", "staging", "disputed", "retired", "suppressed", "superseded", "archived", ""];
const GUIDANCE_KINDS = ["experience", "skill", "case", "core", "memory"];
const FACT_KINDS = ["memory", "core", "case", "experience", "skill"];

function normalize(q: string) {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function encodeRef(chunkId: number, docId: string, hash: string, owner: string, packetId: string) {
  return Buffer.from(JSON.stringify({ c: chunkId, d: docId, h: hash.slice(0, 8), o: owner, p: packetId })).toString("base64url");
}

export function decodeRef(ref: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid ref");
  }
  const r = decoded as Record<string, unknown>;
  if (
    !Number.isSafeInteger(r.c) ||
    typeof r.d !== "string" ||
    typeof r.h !== "string" ||
    typeof r.o !== "string" ||
    (r.p !== undefined && typeof r.p !== "string")
  ) {
    throw new Error("invalid ref");
  }
  return r as { c: number; d: string; h: string; o: string; p?: string };
}

export function summaryOf(text: string, section = "") {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && line !== "---" && !/^[\w-]+:\s/.test(line));
  const excerpt = lines.find((line) => line.length >= 24) ?? lines[0] ?? text.trim();
  const clean = excerpt.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").slice(0, 220);
  const heading = section.replace(/#\d+$/, "").trim();
  return heading && !clean.toLowerCase().startsWith(heading.toLowerCase()) ? `${heading}: ${clean}`.slice(0, 240) : clean;
}

function modeKinds(mode: RecallMode) {
  if (mode === "guidance") return GUIDANCE_KINDS;
  if (mode === "facts") return FACT_KINDS;
  return null;
}

function allowedOwner(owner: string, ownerFilter?: string, teamOwners = new Set<string>()) {
  if (!ownerFilter) return true;
  return owner === ownerFilter || teamOwners.has(owner);
}

function rowAllowed(row: Pick<ChunkRow, "owner" | "status" | "kind">, mode: RecallMode, ownerFilter?: string, teamOwners = new Set<string>()) {
  if (!allowedOwner(row.owner, ownerFilter, teamOwners)) return false;
  const statuses = mode === "history" ? HISTORY_STATUSES : ACTIVE_STATUSES;
  if (!statuses.includes(row.status ?? "")) return false;
  const kinds = modeKinds(mode);
  return !kinds || kinds.includes(row.kind);
}

function inferTarget(query: string): 10 | 20 | 30 {
  const words = query.trim().split(/\s+/).filter(Boolean).length;
  const branches = (query.match(/\b(and|or|versus|vs\.?|compare|across|then|also|plus)\b|[,;:?]/gi) ?? []).length;
  if (words >= 28 || branches >= 4) return 30;
  if (words >= 12 || branches >= 2) return 20;
  return 10;
}

export function packetCeilingBytes(budgets: Budgets) {
  return Math.min(budgets.packetTokens, budgets.packetCeiling) * 4;
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function toItem(row: Scored, packetId: string): PacketItem {
  return {
    ref: encodeRef(row.chunk_id, row.doc_id, row.hash, row.owner, packetId),
    docId: row.doc_id,
    kind: row.kind,
    summary: summaryOf(row.text, row.section),
    ...(row.section ? { section: row.section } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.source_refs ? { source_refs: row.source_refs } : {}),
    ...((row.status && row.status !== "active") ? { status: row.status } : {}),
    owner: row.owner,
    rrf: Math.round(row.rrf * 1000) / 1000,
    source: row.source,
  } as PacketItem;
}

function rankRows(
  rows: ChunkRow[],
  lexRank: Map<number, number>,
  vecRank: Map<number, number>,
): Scored[] {
  return rows.map((row) => {
    const lr = lexRank.get(row.chunk_id);
    const vr = vecRank.get(row.chunk_id);
    return {
      ...row,
      rrf: (lr === undefined ? 0 : 1 / (RRF_K + lr + 1)) + (vr === undefined ? 0 : 1 / (RRF_K + vr + 1)),
      rankLex: lr,
      rankVec: vr,
      source: "fused" as const,
    };
  }).sort((a, b) => b.rrf - a.rrf || a.doc_id.localeCompare(b.doc_id) || a.chunk_id - b.chunk_id);
}

function oneHop(
  seeds: Scored[],
  db: Database,
  mode: RecallMode,
  ownerFilter?: string,
  teamOwners = new Set<string>(),
): Scored[] {
  const bestByDoc = new Map<string, Scored>();
  for (const seed of seeds) if (!bestByDoc.has(seed.doc_id)) bestByDoc.set(seed.doc_id, seed);
  const expansion = new Map<string, number>();
  for (const seed of [...bestByDoc.values()].slice(0, 8)) {
    const links = db.query("SELECT dst FROM links WHERE src=? UNION SELECT src AS dst FROM links WHERE dst=? ORDER BY dst LIMIT 8").all(seed.doc_id, seed.doc_id) as { dst: string }[];
    for (const { dst } of links) {
      if (bestByDoc.has(dst)) continue;
      const inherited = seed.rrf / 2;
      expansion.set(dst, Math.max(expansion.get(dst) ?? 0, inherited));
    }
  }
  for (const [docId, score] of [...expansion.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)) {
    const row = db.query("SELECT chunk_id, doc_id, text, section, kind, scope, source_refs, status, hash, owner FROM chunks WHERE doc_id=? ORDER BY chunk_id LIMIT 1").get(docId) as ChunkRow | null;
    if (!row || !rowAllowed(row, mode, ownerFilter, teamOwners)) continue;
    bestByDoc.set(docId, { ...row, rrf: score, source: "link" });
  }
  return [...bestByDoc.values()].sort((a, b) => b.rrf - a.rrf || a.doc_id.localeCompare(b.doc_id));
}

function quotaOrder(items: PacketItem[], budgets: Budgets) {
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

function dedupByStatement(items: PacketItem[]): PacketItem[] {
  const seenDoc = new Set<string>();
  const out: PacketItem[] = [];
  for (const item of items) {
    if (seenDoc.has(item.docId)) continue;
    if (out.some((kept) => nearDuplicateStatement(kept.summary, item.summary) && kept.kind === item.kind)) continue;
    seenDoc.add(item.docId);
    out.push(item);
  }
  return out;
}

function isTransferable(item: PacketItem): boolean {
  if (item.kind === "skill" && (item.status ?? "active") === "active") return true;
  const n = parseSourceRefCount(item.source_refs || item.scope);
  const roots = new Set((item.source_refs || item.scope || "").split(/[;,]/).map(v=>v.trim()).filter(Boolean)).size;
  if (n >= 2 || roots >= 2) return true;
  if (item.kind === "experience" && item.status !== "candidate") return true;
  return false;
}

function boostReusable(items: PacketItem[], lexCount: number, perArmCap: number): PacketItem[] {
  return [...items]
    .map((item) => {
      const sourceCount = parseSourceRefCount(item.source_refs || item.scope);
      const distinctRoots = (item.source_refs || item.scope) ? parseSourceRefCount(item.source_refs || item.scope) : sourceCount;
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

function allocate(items: PacketItem[], target: 10 | 20 | 30, budgets: Budgets) {
  const ordered = quotaOrder(items, budgets);
  const out: PacketItem[] = [];
  for (const item of ordered) {
    if (out.length >= target) break;
    out.push(item);
  }
  return out;
}

export async function recall(
  db: Database,
  vault: string,
  query: string,
  budgets: Budgets,
  ownerFilter?: string,
  mode: RecallMode = "auto",
  teamOwners: ReadonlySet<string> = new Set(),
): Promise<Packet> {
  const q = normalize(query);
  const id = `pkt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const targetCandidates = inferTarget(query);
  const teams = new Set(teamOwners);
  const statuses = mode === "history" ? HISTORY_STATUSES : ACTIVE_STATUSES;
  const kinds = modeKinds(mode);
  const vector = vectorStatus(db);

  const exactRows = db.query("SELECT chunk_id, doc_id, text, section, kind, scope, source_refs, status, hash, owner FROM chunks WHERE lower(doc_id)=? ORDER BY chunk_id").all(q) as ChunkRow[];
  const exact = exactRows.find((row) => rowAllowed(row, mode, ownerFilter, teams));
  if (exact) {
    const item = toItem({ ...exact, rrf: 1, source: "exact" }, id);
    const packet = fitPacket({
      id,
      mode,
      targetCandidates,
      items: [item],
      next: "Exact ID resolved. Read ref for bounded detail.",
      attribution: {
        lexCapped: 0,
        vecCapped: 0,
        fused: 1,
        linked: 0,
        vector,
        filters: { owner: ownerFilter ?? null, statuses, kinds },
      },
    }, budgets);
    return attachRetrievalUsage(packet, [item]);
  }

  const perArm = budgets.perArmCap;
  const poolLimit = Math.max(perArm * 4, targetCandidates * 3);
  const lexCandidates = ftsSearch(db, q, poolLimit);
  const lexRows = fetchAuthorized(db, lexCandidates.map((row) => row.chunk_id), mode, ownerFilter, teams).slice(0, perArm);
  const lexRank = new Map(lexRows.map((row, index) => [row.chunk_id, index]));

  let vecRows: ChunkRow[] = [];
  let vectorReason = vector.reason;
  if (vector.available && vector.indexed > 0) {
    try {
      const embedded = await embedTexts(vault, [q]);
      const candidates = vecSearch(db, embedded[0], poolLimit);
      vecRows = fetchAuthorized(db, candidates.map((row) => row.chunk_id), mode, ownerFilter, teams).slice(0, perArm);
    } catch (error) {
      vectorReason = error instanceof Error ? error.message : "query embedding unavailable";
    }
  }
  const vecRank = new Map(vecRows.map((row, index) => [row.chunk_id, index]));
  const ids = [...new Set([...lexRank.keys(), ...vecRank.keys()])];
  const authorized = fetchAuthorized(db, ids, mode, ownerFilter, teams);
  const fused = rankRows(authorized, lexRank, vecRank);
  const expanded = oneHop(fused, db, mode, ownerFilter, teams);
  const rawCandidates = expanded.map((row) => toItem(row, id));
  const retrieved = rawCandidates.slice(0, Math.max(lexRows.length, vecRows.length, targetCandidates));
  const deduped = dedupByStatement(rawCandidates);
  const boosted = boostReusable(deduped, lexRows.length, perArm);
  const candidates = (lexRows.length === 0 && boosted.length > 3)
    ? [...boosted].sort((a,b)=> (Number(isTransferable(b))-Number(isTransferable(a))) || (b.rrf-a.rrf) || a.docId.localeCompare(b.docId))
    : boosted;
  const allocated = allocate(candidates, targetCandidates, budgets);
  const packet = fitPacket({
    id,
    mode,
    targetCandidates,
    items: allocated,
    next: "Host: rerank descriptors for current goal; read every plausibly needed ref. Recall again with narrower cues after branch, contradiction, failed assumption, or missing context.",
    attribution: {
      lexCapped: lexRows.length,
      vecCapped: vecRows.length,
      fused: fused.length,
      linked: expanded.filter((row) => row.source === "link").length,
      vector: { ...vector, reason: vectorReason },
      filters: { owner: ownerFilter ?? null, statuses, kinds },
    },
  }, budgets);
  return attachRetrievalUsage(packet, retrieved);
}

type PacketDraft = Omit<Packet, "l1" | "attribution"> & {
  attribution: Omit<Packet["attribution"], "returned" | "packetBytes" | "packetTokensEstimate">;
};

function materializePacket(draft: PacketDraft, items: PacketItem[], l1Count: number): Packet {
  const l1 = items.slice(0, l1Count).map((item) => ({
    ref: item.ref,
    overview: item.summary,
    section: item.section ?? "",
  }));
  const packet: Packet = {
    ...draft,
    items,
    l1: l1.length ? l1 : undefined,
    attribution: {
      ...draft.attribution,
      returned: items.length,
      packetBytes: 0,
      packetTokensEstimate: 0,
    },
  };
  for (let i = 0; i < 4; i++) {
    const bytes = serializedBytes(packet);
    packet.attribution.packetBytes = bytes;
    packet.attribution.packetTokensEstimate = Math.ceil(bytes / 4);
  }
  return packet;
}

function fitPacket(draft: PacketDraft, budgets: Budgets): Packet {
  const ceiling = packetCeilingBytes(budgets);
  let items = draft.items.slice();
  let l1Count = 0; // compact: l1 duplicates items[].summary — drop to save ~15%
  while (true) {
    const packet = materializePacket(draft, items, l1Count);
    if (packet.attribution.packetBytes <= ceiling) return packet;
    if (l1Count > 0) {
      l1Count--;
      continue;
    }
    if (items.length) {
      items = items.slice(0, -1);
      continue;
    }
    throw new Error(`packet metadata exceeds ${ceiling}-byte ceiling`);
  }
}

function fetchAuthorized(
  db: Database,
  ids: number[],
  mode: RecallMode,
  ownerFilter?: string,
  teamOwners = new Set<string>(),
): ChunkRow[] {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db.query(`SELECT chunk_id, doc_id, text, section, kind, scope, source_refs, status, hash, owner FROM chunks WHERE chunk_id IN (${placeholders})`).all(...unique) as ChunkRow[];
  const byId = new Map(rows.filter((row) => rowAllowed(row, mode, ownerFilter, teamOwners)).map((row) => [row.chunk_id, row]));
  return unique.flatMap((chunkId) => {
    const row = byId.get(chunkId);
    return row ? [row] : [];
  });
}

function sliceUtf8(text: string, start: number, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, start + maxBytes);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const chunk = bytes.subarray(start, end).toString("utf8");
  return { text: chunk, nextOffset: end, totalBytes: bytes.length };
}

function encodeCursor(ref: string, offset: number) {
  return Buffer.from(JSON.stringify({ r: ref, b: offset })).toString("base64url");
}

function decodeCursor(cursor: string, ref: string) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed.r !== ref || !Number.isSafeInteger(parsed.b) || parsed.b < 0) throw new Error();
    return parsed.b as number;
  } catch {
    throw new Error("invalid cursor");
  }
}

export function readChunk(db: Database, ref: string, budgets: Budgets, cursor?: string) {
  const { c, d, h, o } = decodeRef(ref);
  const row = db.query("SELECT text, doc_id, section, hash, owner, status FROM chunks WHERE chunk_id=?").get(c) as any;
  if (!row) throw new Error("unknown ref");
  if (row.doc_id !== d) throw new Error("ref document mismatch");
  if (row.owner !== o) throw new Error("ref owner mismatch");
  if (!row.hash.startsWith(h)) throw new Error("stale ref: content hash changed");
  const offset = cursor ? decodeCursor(cursor, ref) : 0;
  const page = sliceUtf8(row.text, offset, budgets.l2Bytes);
  if (offset > page.totalBytes) throw new Error("cursor past end");
  const done = page.nextOffset >= page.totalBytes;
  return {
    docId: row.doc_id,
    section: row.section,
    hash: row.hash,
    owner: row.owner,
    status: row.status,
    text: page.text,
    bytes: Buffer.byteLength(page.text, "utf8"),
    offset,
    totalBytes: page.totalBytes,
    done,
    cursor: done ? undefined : encodeCursor(ref, page.nextOffset),
  };
}
