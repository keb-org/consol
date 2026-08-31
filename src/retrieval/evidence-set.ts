import { extractTypedAnchors } from "@/core/parse";
import { nearDuplicateStatement } from "./transfer";
import type { ChunkRow, PacketItem, Scored } from "./packet";

export function stateSignature(row: ChunkRow): string {
  const text = row.text;
  const candidates: string[] = [];
  const dateRe = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|(?:January|February|March|April|May|June|July|August|September|October|November|December)[ -]\d{1,2}(?:,|[ -])\s*\d{4})\b/giu;
  const verRe = /\bv(?:ersion)?\s*\d+(?:\.\d+){1,3}\b/gi;
  const pctRe = /\b\d[\d,]*(?:\.\d+)?\s*%/g;
  const moneyRe = /(?:[$€£¥₫₩₽฿₪₴₦₵]\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP|JPY|VND|CNY|KRW|AUD|CAD|CHF|BTC|ETH)\b)/giu;
  for (const re of [dateRe, verRe, pctRe, moneyRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) candidates.push(m[0].toLowerCase());
  }
  const scopeBools = (row.scope ?? "").toLowerCase().match(/\b(?:true|false|enabled|disabled|active|archived)\b/g) ?? [];
  candidates.push(...scopeBools);
  if (!candidates.length) {
    let m: RegExpExecArray | null;
    const r = /\b\d[\d,]*(?:\.\d+)?\b/g;
    while ((m = r.exec(text))) candidates.push(m[0]);
  }
  const sig = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))].sort().join("|").slice(0, 400) || `hash:${row.hash.slice(0, 8)}`;
  return `${row.kind}:${sig}`;
}

export function rowSatisfiesAnchors(row: ChunkRow, anchors: string[]): boolean {
  if (!anchors.length) return true;
  const hay = `${row.text} ${row.doc_id} ${row.scope}`.toLowerCase();
  return anchors.every((a) => hay.includes(a.toLowerCase()));
}

export function dedupByStatement(items: PacketItem[], chunkByDoc?: Map<string, ChunkRow>): PacketItem[] {
  const seenDoc = new Set<string>();
  const out: PacketItem[] = [];
  for (const item of items) {
    if (seenDoc.has(item.docId)) continue;
    if (item.source !== "ledger") {
      const dup = out.find((kept) => kept.source !== "ledger" && nearDuplicateStatement(kept.summary, item.summary) && kept.kind === item.kind);
      if (dup && chunkByDoc) {
        const a = chunkByDoc.get(dup.docId);
        const b = chunkByDoc.get(item.docId);
        if (a && b && stateSignature(a) === stateSignature(b)) { continue; }
        if (!a || !b) continue;
      } else if (dup) continue;
    }
    seenDoc.add(item.docId);
    out.push(item);
  }
  return out;
}

export function selectEvidenceSet(
  fused: Scored[],
  query: string,
  target: 10 | 20 | 30,
): Scored[] {
  const anchors = extractTypedAnchors(query, 6);
  // Pure structural signals: digits, currencies, versions, quotes
  const hasDigitSignal = /\d|[$€£¥₫₩₽฿₪₴₦₵%]|\bv\d/i.test(query);
  const anchorFiltered = anchors.length ? fused.filter((r) => rowSatisfiesAnchors(r as unknown as ChunkRow, anchors)) : fused;
  const pool = anchorFiltered.length ? anchorFiltered : fused;

  const byChunk = new Map<number, Scored>();
  for (const r of pool) if (!byChunk.has(r.chunk_id)) byChunk.set(r.chunk_id, r);

  let reserved: Scored[] = [];
  if (hasDigitSignal && anchors.length) {
    const candidates = [...byChunk.values()].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || b.rrf - a.rrf);
    const latest = candidates[0];
    if (latest) reserved.push(latest);
    if (candidates.length > 1) {
      const sigLatest = stateSignature(latest as unknown as ChunkRow);
      const prior = candidates.find((c) => stateSignature(c as unknown as ChunkRow) !== sigLatest);
      if (prior) reserved.push(prior);
    }
  } else if (anchors.length) {
    const candidates = [...byChunk.values()].sort((a, b) => b.rrf - a.rrf);
    if (candidates[0]) reserved.push(candidates[0]);
  }

  const reservedIds = new Set(reserved.map((r) => r.chunk_id));
  const remaining = fused.filter((r) => !reservedIds.has(r.chunk_id));
  const ordered: Scored[] = [...reserved];
  for (const r of remaining) { if (ordered.length >= target) break; ordered.push(r); }
  return ordered;
}
