// parse.ts — SSOT for query/text parsing, Unicode tokenization, typed anchors, and FTS helpers.

export const NUMERIC_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from", "had", "has", "have",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "said", "set", "that", "the", "to", "was", "were", "what",
  "when", "which", "with", "you", "your",
]);

// Unicode-aware tokenization supporting Latin, Greek, Cyrillic, CJK, Vietnamese, Arabic, Devanagari, etc.
export function numericTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
}

export function numericQueryTerms(query: string): string[] {
  return [...new Set(numericTokens(query).filter((w) => !NUMERIC_QUERY_STOPWORDS.has(w)))].slice(0, 16);
}

export function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function extractQuoted(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{2,80})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

// Canonical typed-anchor grammar: quoted phrases, ISO/international dates, hyphen IDs, versions, acronyms, ordinals.
// cap=8 for indexing/search surfacing; callers needing a smaller cap (e.g. retrieval evidence-set 6) pass it explicitly.
export function extractTypedAnchors(query: string, cap = 8): string[] {
  const anchors: string[] = [];
  for (const q of extractQuoted(query)) anchors.push(q);
  // ISO (2026-08-31), Slash (2026/08/31), Dot (2026.08.31), CJK (2026年08月31日)
  const iso = query.match(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{4}年\d{1,2}月\d{1,2}日\b/gu) ?? [];
  for (const v of iso) anchors.push(v);
  const named = query.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)[ -]\d{1,2}(?:st|nd|rd|th)?(?:,|[ -])\s*\d{4}\b/gi) ?? [];
  for (const v of named) anchors.push(v.trim());
  const hyphen = query.match(/\b[\p{L}]+-\d+[\p{L}\p{N}-]*\b/gu) ?? [];
  for (const v of hyphen) anchors.push(v);
  const version = query.match(/\bv(?:ersion)?\s*\d+(?:\.\d+){1,3}\b/gi) ?? [];
  for (const v of version) anchors.push(v.trim());
  const versionBare = (query.match(/(?<![\p{L}\p{N}_.-])\d+\.\d+(?:\.\d+){0,2}(?![\p{L}\p{N}_.-])/gu) as string[] | null) ?? [];
  for (const v of versionBare) if (!(anchors as string[]).includes(v)) (anchors as string[]).push(v);
  const acronymRaw = (query.match(/\b[\p{Lu}]{2,}[\p{Lu}\p{N}]*\b/gu) as string[] | null) ?? [];
  for (const v of acronymRaw) if (!(hyphen as string[]).includes(v) && v.length <= 12) (anchors as string[]).push(v);
  const ordinalRe = /\b([\p{L}]{2,})\s*[#-]?\s*(\d{1,4})\b/gu;
  let om: RegExpExecArray | null;
  while ((om = ordinalRe.exec(query))) {
    const phrase = `${om[1]} ${om[2]}`;
    if (!(anchors as string[]).includes(phrase) && !(hyphen as string[]).includes(`${om[1]}-${om[2]}`)) (anchors as string[]).push(phrase);
  }
  return [...new Set(anchors.map((a) => a.replace(/^"|"$/g, "").trim()).filter(Boolean))].slice(0, cap);
}

export function boundedContentTerms(query: string, anchors: string[], cap = 10): string[] {
  const anchorTokens = new Set(anchors.join(" ").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []);
  const tokens = numericTokens(query).filter((w) => !NUMERIC_QUERY_STOPWORDS.has(w) && !anchorTokens.has(w));
  const uniq = [...new Set(tokens)];
  return uniq.slice(0, cap);
}

export function buildFtsAnd(terms: string[]): string | null {
  if (!terms.length) return null;
  return terms.map(ftsQuote).join(" AND ");
}

export function buildFtsOr(terms: string[]): string | null {
  if (!terms.length) return null;
  return terms.map(ftsQuote).join(" OR ");
}
