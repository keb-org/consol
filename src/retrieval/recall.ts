import { Database } from "bun:sqlite";
import type { Budgets } from "@/core/config";
import { extractTypedAnchors } from "@/core/parse";
import { embedTexts, vectorStatus } from "@/storage/index/embedding";
import { ftsSearch, numericLedgerSearch, surfaceFtsSearch, surfaceVecSearch, vecSearch, type NumericLedgerSearchRow } from "@/storage/index/search";
import { dedupByStatement, selectEvidenceSet } from "./evidence-set";
import {
  fitPacket,
  toItem,
  type ChunkRow,
  type Packet,
  type PacketItem,
  type RecallMode,
  type RetrievalUsageItem,
  type Scored,
} from "./packet";
import {
  allocate,
  boostReusable,
  isTransferable,
  modeKinds,
  oneHop,
  rankRows,
  rowAllowed,
  ACTIVE_STATUSES,
  HISTORY_STATUSES,
} from "./ranking";

export type RecallOptions = {
  numericLedger?: boolean;
};

const RETRIEVAL_USAGE: unique symbol = Symbol("retrievalUsage");
type PacketWithUsage = Packet & { [RETRIEVAL_USAGE]?: RetrievalUsageItem[] };

function attachRetrievalUsage(packet: Packet, items: PacketItem[]): Packet {
  const usage = items.map(({ docId, kind, owner, source }) => ({ docId, kind, owner, source }));
  Object.defineProperty(packet, RETRIEVAL_USAGE, { value: usage });
  return packet;
}

export function getRetrievalUsage(packet: Packet): RetrievalUsageItem[] {
  return (packet as PacketWithUsage)[RETRIEVAL_USAGE] ?? packet.items.map(({ docId, kind, owner, source }) => ({ docId, kind, owner, source }));
}

function normalize(q: string) {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function inferTarget(query: string): 10 | 20 | 30 {
  const words = query.trim().split(/\s+/).filter(Boolean).length;
  const punctuation = (query.match(/[,;:?&/|+\-—–"'`]/g) ?? []).length;
  if (words >= 16 || punctuation >= 3) return 30;
  if (words >= 6 || punctuation >= 1) return 20;
  return 10;
}

function hasNumericIntent(query: string): boolean {
  if (/\d|[$€£¥₫₩₽฿₪₴₦₵%]|\bv\d/i.test(query)) return true;
  return extractTypedAnchors(query, 1).length > 0;
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
  const rows = db.query(`SELECT chunk_id, doc_id, text, section, kind, scope, source_refs, status, hash, owner, updated FROM chunks WHERE chunk_id IN (${placeholders})`).all(...unique) as ChunkRow[];
  const byId = new Map(rows.filter((row) => rowAllowed(row, mode, ownerFilter, teamOwners)).map((row) => [row.chunk_id, row]));
  return unique.flatMap((chunkId) => {
    const row = byId.get(chunkId);
    return row ? [row] : [];
  });
}

export async function recall(
  db: Database,
  vault: string,
  query: string,
  budgets: Budgets,
  ownerFilter?: string,
  mode: RecallMode = "auto",
  teamOwners: ReadonlySet<string> = new Set(),
  options: RecallOptions = {},
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
    const item = toItem({ ...exact, rrf: 1, source: "exact" });
    const packet = fitPacket({
      id,
      mode,
      targetCandidates,
      items: [item],
      attribution: {
        lexCapped: 0,
        vecCapped: 0,
        ledgerCapped: 0,
        fused: 1,
        linked: 0,
        vector,
        filters: { owner: ownerFilter ?? null, statuses, kinds },
      },
    }, budgets);
    return attachRetrievalUsage(packet, [item]);
  }

  const perArm = budgets.perArmCap;
  // WHY: perArm*4 fetches before quota caps so quotas select among broad lexical candidates rather than truncating early.
  const poolLimit = Math.max(perArm * 4, targetCandidates * 3);
  const hasAsciiToken = /[A-Za-z0-9]{2,}/.test(q);
  let lexCandidates: { chunk_id: number; rank: number }[] = [];
  if (hasAsciiToken) {
    lexCandidates = ftsSearch(db, q, poolLimit);
  } else {
    // Unicode/emoji-only query (e.g. Japanese, Arabic, emojis without Latin words): fall back to recent chunks
    try {
      const fallback = db.query("SELECT chunk_id FROM chunks ORDER BY chunk_id DESC LIMIT ?").all(poolLimit) as { chunk_id: number }[];
      lexCandidates = fallback.map((r, i) => ({ chunk_id: r.chunk_id, rank: i }));
    } catch { lexCandidates = []; }
  }
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

  let ledgerRows: NumericLedgerSearchRow[] = [];
  if (options.numericLedger !== false && hasNumericIntent(query)) {
    const candidates = numericLedgerSearch(db, q, poolLimit);
    const authorizedIds = new Set(fetchAuthorized(db, candidates.map((row) => row.chunk_id), mode, ownerFilter, teams).map((row) => row.chunk_id));
    const seen = new Set<number>();
    ledgerRows = candidates.filter((row) => authorizedIds.has(row.chunk_id) && !seen.has(row.chunk_id) && Boolean(seen.add(row.chunk_id))).slice(0, perArm);
  }
  const ledgerRank = new Map(ledgerRows.map((row, index) => [row.chunk_id, index]));
  const ledgerByChunk = new Map(ledgerRows.map((row) => [row.chunk_id, row]));

  const lexSurfaceHits = surfaceFtsSearch(db, q, poolLimit);
  const lexSurfaceChunkIds = lexSurfaceHits.map((r) => r.chunk_id);
  const lexAuthorizedSet = new Set(fetchAuthorized(db, [...lexRank.keys(), ...lexSurfaceChunkIds], mode, ownerFilter, teams).map((r) => r.chunk_id));
  const lexCollapsed = new Map<number, number>();
  for (const [cid, r] of lexRank) if (lexAuthorizedSet.has(cid)) { const cur = lexCollapsed.get(cid); if (cur === undefined || r < cur) lexCollapsed.set(cid, r); }
  lexSurfaceHits.forEach((hit, idx) => {
    if (!lexAuthorizedSet.has(hit.chunk_id)) return;
    const cur = lexCollapsed.get(hit.chunk_id);
    if (cur === undefined || idx < cur) lexCollapsed.set(hit.chunk_id, idx);
  });

  let vecSurfaceHits: { chunk_id: number; surface_id: number; distance: number }[] = [];
  if (vector.available && vector.indexed > 0) {
    try {
      const emb = await embedTexts(vault, [q]);
      try { vecSurfaceHits = surfaceVecSearch(db, emb[0], poolLimit); } catch {}
    } catch {}
  }
  const vecSurfaceChunkIds = vecSurfaceHits.map((r) => r.chunk_id);
  const vecAuthorizedSet = new Set(fetchAuthorized(db, [...vecRank.keys(), ...vecSurfaceChunkIds], mode, ownerFilter, teams).map((r) => r.chunk_id));
  const vecCollapsed = new Map<number, number>();
  for (const [cid, r] of vecRank) if (vecAuthorizedSet.has(cid)) { const cur = vecCollapsed.get(cid); if (cur === undefined || r < cur) vecCollapsed.set(cid, r); }
  vecSurfaceHits.forEach((hit, idx) => {
    if (!vecAuthorizedSet.has(hit.chunk_id)) return;
    const cur = vecCollapsed.get(hit.chunk_id);
    if (cur === undefined || idx < cur) vecCollapsed.set(hit.chunk_id, idx);
  });

  const ids = [...new Set([...lexCollapsed.keys(), ...vecCollapsed.keys(), ...ledgerRank.keys()])];
  const authorized = fetchAuthorized(db, ids, mode, ownerFilter, teams);
  const fused = rankRows(authorized, lexCollapsed, vecCollapsed, ledgerRank, ledgerByChunk);
  const canonicalSeedIds = new Set([...lexRank.keys(), ...ledgerRank.keys()]);
  const hopSeeds = fused.filter((r) => canonicalSeedIds.has(r.chunk_id));
  const expanded = oneHop(hopSeeds.length ? hopSeeds : fused.slice(0, 8), db, mode, ownerFilter, teams);
  const hopExtra = expanded.filter((r) => !fused.some((f) => f.doc_id === r.doc_id));
  const hopAppended = [...fused, ...hopExtra];
  const evidenceSet = selectEvidenceSet(hopAppended, query, targetCandidates);
  const rawCandidates = evidenceSet.map((row) => toItem(row));

  const retrievedPool = hopAppended.map((row) => toItem(row));
  const retrieved = retrievedPool.slice(0, Math.max(lexCollapsed.size, vecCollapsed.size, ledgerRows.length, targetCandidates, rawCandidates.length + 2));
  const chunkByDoc = new Map<string, ChunkRow>();
  for (const r of authorized) chunkByDoc.set(r.doc_id, r);
  for (const r of fetchAuthorized(db, expanded.map((x) => x.chunk_id), mode, ownerFilter, teams)) chunkByDoc.set(r.doc_id, r as ChunkRow);
  const deduped = dedupByStatement(rawCandidates, chunkByDoc);
  const boosted = boostReusable(deduped, lexCollapsed.size, perArm);
  const candidates = (boosted.length > 0)
    ? [...boosted].sort((a, b) => (b.rrf - a.rrf) || (Number(isTransferable(b)) - Number(isTransferable(a))) || a.docId.localeCompare(b.docId))
    : boosted;
  const allocated = allocate(candidates, targetCandidates, budgets);
  const packet = fitPacket({
    id,
    mode,
    targetCandidates,
    items: allocated,
    attribution: {
      lexCapped: lexRows.length,
      vecCapped: vecRows.length,
      ledgerCapped: ledgerRows.length,
      fused: fused.length,
      linked: expanded.filter((row) => row.source === "link").length,
      vector: { ...vector, reason: vectorReason },
      filters: { owner: ownerFilter ?? null, statuses, kinds },
    },
  }, budgets);
  return attachRetrievalUsage(packet, retrieved);
}
