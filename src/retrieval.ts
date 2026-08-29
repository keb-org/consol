import { Database } from "bun:sqlite";
import type { Budgets } from "./config";
import { RRF_K } from "./config";
import { embedTexts, ftsSearch, vecSearch } from "./index";

export type PacketItem = {
  ref: string;
  docId: string;
  kind: string;
  summary: string;
  scope: string;
  status: string;
  rrf: number;
  rankLex?: number;
  rankVec?: number;
};

export type Packet = {
  id: string;
  query: string;
  items: PacketItem[];
  l1?: { ref: string; overview: string }[];
  attribution: { lexCapped: number; vecCapped: number; fused: number };
};

function normalize(q: string) {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

// Encodes chunkId, docId, content hash prefix, and owner to verify ref freshness and boundary.
function encodeRef(chunkId: number, docId: string, hash: string, owner: string) {
  return Buffer.from(JSON.stringify({ c: chunkId, d: docId, h: hash.slice(0, 12), o: owner })).toString("base64url");
}

export function decodeRef(ref: string) {
  return JSON.parse(Buffer.from(ref, "base64url").toString("utf8")) as { c: number; d: string; h: string; o: string };
}

export function summaryOf(text: string) {
  const first = text.split("\n").map((s) => s.trim()).find((s) => s.length > 20) ?? text.slice(0, 120);
  return first.slice(0, 140).replace(/\s+/g, " ");
}

export async function recall(
  db: Database,
  vault: string,
  query: string,
  budgets: Budgets,
  ownerFilter?: string,
): Promise<Packet> {
  const q = normalize(query);
  const id = `pkt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const exact = db.query("SELECT chunk_id, doc_id, text, kind, scope, status, hash, owner FROM chunks WHERE doc_id=? LIMIT 1").get(q) as any;
  if (exact) {
    return {
      id,
      query,
      items: [{ ref: encodeRef(exact.chunk_id, exact.doc_id, exact.hash, exact.owner), docId: exact.doc_id, kind: exact.kind, summary: summaryOf(exact.text), scope: exact.scope, status: exact.status, rrf: 1 }],
      attribution: { lexCapped: 0, vecCapped: 0, fused: 1 },
    };
  }

  const perArm = budgets.perArmCap ?? 20;
  const lexRaw = ftsSearch(db, q, perArm * 2).slice(0, perArm);
  let vecRaw: { chunk_id: number; distance: number }[] = [];
  try {
    const vec = await Promise.race([
      embedTexts(vault, [q]),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("vec timeout")), 8000)),
    ]);
    vecRaw = vecSearch(db, vec[0], perArm * 2).slice(0, perArm);
  } catch {}

  const lexRank = new Map<number, number>();
  lexRaw.forEach((r, i) => lexRank.set(r.chunk_id, i));
  const vecRank = new Map<number, number>();
  vecRaw.forEach((r, i) => vecRank.set(r.chunk_id, i));

  const allIds = new Set([...lexRank.keys(), ...vecRank.keys()]);
  const scored: { id: number; rrf: number }[] = [];
  for (const cid of allIds) {
    let s = 0;
    const lr = lexRank.get(cid);
    if (lr !== undefined) s += 1 / (RRF_K + lr);
    const vr = vecRank.get(cid);
    if (vr !== undefined) s += 1 / (RRF_K + vr);
    scored.push({ id: cid, rrf: s });
  }
  scored.sort((a, b) => b.rrf - a.rrf);

  const rows: PacketItem[] = [];
  for (const { id: cid, rrf } of scored) {
    const row = db.query("SELECT chunk_id, doc_id, text, kind, scope, status, hash, owner FROM chunks WHERE chunk_id=?").get(cid) as any;
    if (!row) continue;
    if (ownerFilter && row.owner !== ownerFilter && !row.owner.startsWith("team:")) continue;
    if (row.status === "retired" || row.status === "suppressed") continue;
    rows.push({
      ref: encodeRef(row.chunk_id, row.doc_id, row.hash, row.owner),
      docId: row.doc_id,
      kind: row.kind,
      summary: summaryOf(row.text),
      scope: row.scope,
      status: row.status,
      rrf,
      rankLex: lexRank.get(cid),
      rankVec: vecRank.get(cid),
    });
  }

  const expanded = oneHop(rows, db, budgets);
  const diversified = diversify(expanded);
  const capped = applyQuotas(diversified, budgets);

  const l1 = capped.slice(0, 3).map((it) => ({ ref: it.ref, overview: it.summary.slice(0, 220) }));

  return {
    id,
    query,
    items: capped,
    l1: l1.length ? l1 : undefined,
    attribution: { lexCapped: lexRaw.length, vecCapped: vecRaw.length, fused: scored.length },
  };
}

function oneHop(seeds: PacketItem[], db: Database, _budgets: Budgets) {
  if (seeds.length === 0) return seeds;
  const seedIds = new Set(seeds.map((s) => s.docId));
  const linked = new Set<string>();
  for (const s of seeds.slice(0, 5)) {
    const rs = db.query("SELECT dst FROM links WHERE src=? LIMIT 5").all(s.docId) as { dst: string }[];
    for (const r of rs) if (!seedIds.has(r.dst)) linked.add(r.dst);
  }
  for (const dst of [...linked].slice(0, 5)) {
    const row = db.query("SELECT chunk_id, doc_id, text, kind, scope, status, hash, owner FROM chunks WHERE doc_id=? LIMIT 1").get(dst) as any;
    if (!row || row.status === "retired") continue;
    seeds.push({
      ref: encodeRef(row.chunk_id, row.doc_id, row.hash, row.owner),
      docId: row.doc_id,
      kind: row.kind,
      summary: summaryOf(row.text),
      scope: row.scope,
      status: row.status,
      rrf: 0.01,
    });
  }
  seeds.sort((a, b) => b.rrf - a.rrf);
  return seeds;
}

function diversify(items: PacketItem[]) {
  const seen = new Set<string>();
  const out: PacketItem[] = [];
  for (const it of items) {
    const key = `${it.kind}:${it.docId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function applyQuotas(items: PacketItem[], budgets: Budgets) {
  const quotas = budgets.quotas as Record<string, number>;
  const counts: Record<string, number> = {};
  const out: PacketItem[] = [];
  for (const it of items) {
    const k = it.kind in quotas ? it.kind : "memory";
    const q = quotas[k] ?? 4;
    counts[k] = (counts[k] ?? 0) + 1;
    if (counts[k] > q) continue;
    out.push(it);
    if (out.length >= 12) break;
  }
  return out;
}

export function readChunk(db: Database, ref: string, budgets: Budgets) {
  const { c, h, o } = decodeRef(ref);
  const row = db.query("SELECT text, doc_id, hash, owner FROM chunks WHERE chunk_id=?").get(c) as any;
  if (!row) throw new Error("unknown ref");
  if (o && row.owner !== o) throw new Error("ref owner mismatch");
  if (h && row.hash.slice(0, 12) !== h) throw new Error("stale ref: content hash changed");
  const max = budgets.l2Bytes ?? 4096;
  const text = row.text.length > max ? row.text.slice(0, max) : row.text;
  return { docId: row.doc_id, hash: row.hash, owner: row.owner, text };
}
