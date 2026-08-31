import { Database } from "bun:sqlite";
import { MAX_VECTOR_DISTANCE } from "@/core/config";
import {
  boundedContentTerms,
  buildFtsAnd,
  buildFtsOr,
  escapeLike,
  extractTypedAnchors,
  numericQueryTerms,
  numericTokens,
} from "@/core/parse";
import { surfaceFtsAvailable, surfaceTableAvailable, surfaceVectorAvailable } from "./schema";

export type NumericLedgerSearchRow = {
  chunk_id: number;
  value: string;
  value_kind: string;
  statement: string;
  occurred_at: string | null;
  position: number;
};

function ftsSearchInner(db: Database, table: string, ftsQuery: string, limit: number, idCol = "rowid"): { chunk_id: number; rank: number }[] | null {
  try {
    const sql = `SELECT ${idCol} as chunk_id, rank FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`;
    const rows = db.query(sql).all(ftsQuery, limit) as { chunk_id: number; rank: number }[];
    return rows;
  } catch {
    return null;
  }
}

function coverageOrderedLikeCandidates(db: Database, terms: string[], limit: number): { chunk_id: number; rank: number }[] {
  if (!terms.length) return [];
  const likeTerms = terms.slice(0, 6).map(escapeLike);
  const clauses = likeTerms.map(() => "text LIKE ? ESCAPE '\\'").join(" OR ");
  const pool = Math.max(limit * 4, 24);
  const rows = db.query(`SELECT chunk_id, text FROM chunks WHERE ${clauses} LIMIT ?`).all(...likeTerms.map((t) => `%${t}%`), pool) as { chunk_id: number; text: string }[];
  const termSet = likeTerms.map((t) => t.toLowerCase());
  const scored = rows.map((r) => {
    const lower = r.text.toLowerCase();
    const coverage = termSet.filter((t) => lower.includes(t)).length;
    return { chunk_id: r.chunk_id, coverage };
  });
  scored.sort((a, b) => b.coverage - a.coverage || a.chunk_id - b.chunk_id);
  return scored.slice(0, limit).map((s) => ({ chunk_id: s.chunk_id, rank: -1 }));
}

export function ftsSearch(db: Database, query: string, limit: number): { chunk_id: number; rank: number }[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const anchors = extractTypedAnchors(trimmed);
  const content = boundedContentTerms(trimmed, anchors, 10);
  const strictTerms = [...anchors, ...content.slice(0, 3)];
  const relaxedTerms = [...new Set([...anchors, ...content])];
  const strictQuery = anchors.length || content.length ? buildFtsAnd(strictTerms) : null;
  const relaxedQuery = buildFtsOr(relaxedTerms);

  let strictRows: { chunk_id: number; rank: number }[] | null = null;
  let relaxedRows: { chunk_id: number; rank: number }[] | null = null;
  let ftsFailed = false;

  if (strictQuery) {
    const res = ftsSearchInner(db, "chunks_fts", strictQuery, limit);
    if (res === null) ftsFailed = true;
    else strictRows = res;
  }
  if (!ftsFailed && relaxedQuery) {
    const res = ftsSearchInner(db, "chunks_fts", relaxedQuery, limit * 2);
    if (res === null) ftsFailed = true;
    else relaxedRows = res;
  }
  if (ftsFailed) {
    return coverageOrderedLikeCandidates(db, relaxedTerms.length ? relaxedTerms : content, limit);
  }
  if (strictRows && strictRows.length) {
    const seen = new Set(strictRows.map((r) => r.chunk_id));
    const merged = [...strictRows];
    if (relaxedRows) for (const r of relaxedRows) if (!seen.has(r.chunk_id)) { merged.push(r); if (merged.length >= limit) break; }
    const validZero = strictRows.length === 0 && (relaxedRows?.length ?? 0) === 0;
    if (validZero) return [];
    return merged.slice(0, limit);
  }
  if (strictRows && strictRows.length === 0) {
    if (relaxedRows && relaxedRows.length) return relaxedRows.slice(0, limit);
    return [];
  }
  if (relaxedRows) return relaxedRows.slice(0, limit);
  return [];
}

export function surfaceFtsSearch(db: Database, query: string, limit: number): { chunk_id: number; surface_id: number; rank: number }[] {
  if (!surfaceFtsAvailable(db) || !surfaceTableAvailable(db)) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  const anchors = extractTypedAnchors(trimmed);
  const content = boundedContentTerms(trimmed, anchors, 10);
  const strictTerms = [...anchors, ...content.slice(0, 3)];
  const relaxedTerms = [...new Set([...anchors, ...content])];
  const strictQuery = anchors.length || content.length ? buildFtsAnd(strictTerms) : null;
  const relaxedQuery = buildFtsOr(relaxedTerms);
  try {
    const out: { chunk_id: number; surface_id: number; rank: number }[] = [];
    const seen = new Set<number>();
    if (strictQuery) {
      const rows = db.query(`SELECT s.chunk_id as chunk_id, s.surface_id as surface_id, f.rank as rank FROM retrieval_surfaces_fts f JOIN retrieval_surfaces s ON s.surface_id = f.rowid WHERE retrieval_surfaces_fts MATCH ? ORDER BY rank LIMIT ?`).all(strictQuery, limit) as { chunk_id: number; surface_id: number; rank: number }[];
      for (const r of rows) { if (!seen.has(r.surface_id)) { seen.add(r.surface_id); out.push(r); } }
      if (out.length) return out.slice(0, limit);
    }
    if (relaxedQuery) {
      const rows = db.query(`SELECT s.chunk_id as chunk_id, s.surface_id as surface_id, f.rank as rank FROM retrieval_surfaces_fts f JOIN retrieval_surfaces s ON s.surface_id = f.rowid WHERE retrieval_surfaces_fts MATCH ? ORDER BY rank LIMIT ?`).all(relaxedQuery, limit * 2) as { chunk_id: number; surface_id: number; rank: number }[];
      for (const r of rows) if (!seen.has(r.surface_id)) { seen.add(r.surface_id); out.push(r); if (out.length >= limit) break; }
    }
    return out.slice(0, limit);
  } catch {
    if (!relaxedTerms.length) return [];
    const likeTerms = relaxedTerms.slice(0, 4).map(escapeLike);
    const clauses = likeTerms.map(() => "s.text LIKE ? ESCAPE '\\'").join(" OR ");
    const pool = Math.max(limit * 3, 16);
    const rows = db.query(`SELECT s.chunk_id as chunk_id, s.surface_id as surface_id, s.text as text FROM retrieval_surfaces s WHERE ${clauses} LIMIT ?`).all(...likeTerms.map((t) => `%${t}%`), pool) as { chunk_id: number; surface_id: number; text: string }[];
    const lowerTerms = likeTerms.map((t) => t.toLowerCase());
    const scored = rows.map((r) => ({ ...r, coverage: lowerTerms.filter((t) => r.text.toLowerCase().includes(t)).length }));
    scored.sort((a, b) => b.coverage - a.coverage || a.surface_id - b.surface_id);
    return scored.slice(0, limit).map(({ chunk_id, surface_id }) => ({ chunk_id, surface_id, rank: -1 }));
  }
}

function typedAnchorMatchScore(row: { value: string; statement: string }, anchors: string[]): number {
  if (!anchors.length) return 0;
  const hay = `${row.value} ${row.statement}`.toLowerCase();
  let score = 0;
  for (const a of anchors) if (hay.includes(a.toLowerCase())) score++;
  return score;
}

export function numericLedgerSearch(db: Database, query: string, limit: number): NumericLedgerSearchRow[] {
  const words = numericQueryTerms(query);
  if (!words.length) return [];
  const anchors = extractTypedAnchors(query);
  const tryQuery = (terms: string[]) => {
    const fq = terms.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
    try {
      return db.query(`
        SELECT n.chunk_id, n.value, n.value_kind, n.statement, n.occurred_at, n.position, f.rank
        FROM numeric_ledger_fts f
        JOIN numeric_ledger n ON n.ledger_id = f.rowid
        WHERE numeric_ledger_fts MATCH ?
        ORDER BY f.rank, n.chunk_id, n.position
        LIMIT ?
      `).all(fq, limit * 8) as (NumericLedgerSearchRow & { rank: number })[];
    } catch { return [] as (NumericLedgerSearchRow & { rank: number })[]; }
  };
  const strictTerms = anchors.length ? [...new Set([...numericTokens(anchors.join(" ")), ...words.slice(0, 4)])] : words;
  let rows = tryQuery(strictTerms);
  if (rows.length < limit && strictTerms.length !== words.length) {
    const relaxed = tryQuery(words);
    const seen = new Set(rows.map((r) => `${r.chunk_id}:${r.position}:${r.value}`));
    for (const r of relaxed) { const k = `${r.chunk_id}:${r.position}:${r.value}`; if (!seen.has(k)) { rows.push(r); seen.add(k); } }
  }
  if (!rows.length) return [];
  return rows
    .map((row) => {
      const tokens = new Set(numericTokens(`${row.value} ${row.statement}`));
      return { row, coverage: words.filter((word) => tokens.has(word)).length, anchorMatch: typedAnchorMatchScore(row, anchors) };
    })
    .sort((a, b) =>
      b.anchorMatch - a.anchorMatch ||
      b.coverage - a.coverage ||
      Number(Boolean(b.row.occurred_at)) - Number(Boolean(a.row.occurred_at)) ||
      (b.row.occurred_at ?? "").localeCompare(a.row.occurred_at ?? "") ||
      a.row.rank - b.row.rank ||
      a.row.chunk_id - b.row.chunk_id ||
      a.row.position - b.row.position)
    .slice(0, limit)
    .map(({ row: { rank, ...row } }) => row);
}

export function vecSearch(db: Database, embedding: number[], limit: number, maxDistance = MAX_VECTOR_DISTANCE) {
  try {
    const rows = db.query(`SELECT chunk_id, distance FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance`).all(JSON.stringify(embedding), limit) as { chunk_id: number; distance: number }[];
    return rows.filter((r) => r.distance <= maxDistance);
  } catch { return []; }
}

export function surfaceVecSearch(db: Database, embedding: number[], limit: number, maxDistance = MAX_VECTOR_DISTANCE): { chunk_id: number; surface_id: number; distance: number }[] {
  if (!surfaceVectorAvailable(db) || !surfaceTableAvailable(db)) return [];
  try {
    const rows = db.query(`SELECT surface_id, distance FROM retrieval_surface_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance`).all(JSON.stringify(embedding), limit * 3) as { surface_id: number; distance: number }[];
    const validRows = rows.filter((r) => r.distance <= maxDistance);
    if (!validRows.length) return [];
    const ids = validRows.map((r) => r.surface_id);
    const placeholders = ids.map(() => "?").join(",");
    const chunkMap = db.query(`SELECT surface_id, chunk_id FROM retrieval_surfaces WHERE surface_id IN (${placeholders})`).all(...ids) as { surface_id: number; chunk_id: number }[];
    const byId = new Map(chunkMap.map((r) => [r.surface_id, r.chunk_id]));
    return validRows.flatMap((r) => { const cid = byId.get(r.surface_id); return cid !== undefined ? [{ chunk_id: cid, surface_id: r.surface_id, distance: r.distance }] : []; }).slice(0, limit);
  } catch { return []; }
}
