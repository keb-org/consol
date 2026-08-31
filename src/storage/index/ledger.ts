// ledger.ts — SSOT for numeric & temporal evidence extraction NLP.

export type NumericEvidence = {
  value: string;
  valueKind: "date" | "money" | "percentage" | "measure" | "version" | "number";
  statement: string;
  position: number;
};

type NumericMatch = Omit<NumericEvidence, "statement"> & { end: number };

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

export function canonicalDate(value: string | undefined): string | null {
  if (!value) return null;
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = value.trim().match(/^([A-Za-z]+)[ -](\d{1,2})(?:,|[ -])\s*(\d{4})$/);
  const month = named && MONTHS[named[1].toLowerCase()];
  return named && month ? `${named[3]}-${month}-${named[2].padStart(2, "0")}` : null;
}

export function numericChronology(body: string, updated?: string): string | null {
  const anchor = body.match(/^\s*\[Date:\s*([^\]]+)\]/i)?.[1];
  return canonicalDate(anchor) ?? canonicalDate(updated);
}

export function statementAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextLine = text.indexOf("\n", end);
  const lineEnd = nextLine === -1 ? text.length : nextLine;
  let from = Math.max(lineStart, start - 220);
  let to = Math.min(lineEnd, end + 220);
  if (from > lineStart) {
    const space = text.indexOf(" ", from);
    if (space >= 0 && space < start) from = space + 1;
  }
  if (to < lineEnd) {
    const space = text.lastIndexOf(" ", to);
    if (space > end) to = space;
  }
  return text.slice(from, to).replace(/\s+/g, " ").trim();
}

function versionContext(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 48), start);
  if (/[-_#]$/.test(before) || /\b(?:id|ticket|issue)\s*[-#:]?\s*$/i.test(before)) return false;
  if (/(?:\bversion\s*|\bv\s*)$/i.test(before)) return true;
  return /\b(?:[A-Z][A-Za-z0-9+#_-]*|[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z0-9._-]+)\s*$/.test(before);
}

function meaningfulPlainNumber(text: string, start: number, end: number, value: string): boolean {
  const before = text.slice(Math.max(0, start - 64), start);
  const context = text.slice(Math.max(0, start - 64), Math.min(text.length, end + 64));
  if (/[-_#]$/.test(before) || /\b(?:id|ticket|issue)\s*[-#:]?\s*$/i.test(before)) return false;
  if (/\b(?:version|port|ttl|count|total|target|score|accuracy|rate|price|cost|latency|duration|deadline|capacity|quantity|number|from|to)\b/i.test(context)) return true;
  if (/^(?:19|20)\d{2}$/.test(value.replace(/,/g, ""))) return false;
  return versionContext(text, start);
}

function addNumericMatches(
  out: NumericMatch[],
  text: string,
  re: RegExp,
  valueKind: NumericEvidence["valueKind"],
  accept: (match: RegExpExecArray) => boolean = () => true,
) {
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const position = match.index;
    const end = position + match[0].length;
    if (!accept(match) || out.some((item) => position < item.end && end > item.position)) continue;
    out.push({ value: match[0], valueKind, position, end });
  }
}

export function extractNumericEvidence(chunkText: string): NumericEvidence[] {
  const text = chunkText.replace(/^\s*\[Date:\s*[^\]]+\]\s*/i, "");
  const matches: NumericMatch[] = [];
  addNumericMatches(matches, text, /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)[ -]\d{1,2}(?:st|nd|rd|th)?(?:,|[ -])\s*\d{4}\b/gi, "date");
  addNumericMatches(matches, text, /\b\d{4}-\d{2}-\d{2}\b/g, "date");
  addNumericMatches(matches, text, /(?:[$€£¥]\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP|JPY)\b)(?:\s*\/\s*[A-Za-z]+)?/gi, "money");
  addNumericMatches(matches, text, /\b\d[\d,]*(?:\.\d+)?\s*%/g, "percentage");
  addNumericMatches(matches, text, /\b\d[\d,]*(?:\.\d+)?\s*[KMB]?(?:\s+|-)?(?:milliseconds?|msecs?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|qps|rps|tps|req(?:uests?)?\/s|requests?\s+per\s+second|records?|documents?|instances?|tasks?|items?|users?|tokens?|bytes?|kb|mb|gb|tb|apis?|endpoints?)\b/gi, "measure");
  addNumericMatches(matches, text, /\bv(?:ersion)?\s*\d+(?:\.\d+){0,3}\b/gi, "version");
  addNumericMatches(matches, text, /\b\d+(?:\.\d+){0,3}\b/g, "version", (match) => versionContext(text, match.index));
  addNumericMatches(matches, text, /\b\d[\d,]*(?:\.\d+)?\b/g, "number", (match) => meaningfulPlainNumber(text, match.index, match.index + match[0].length, match[0]));
  return matches
    .sort((a, b) => a.position - b.position || a.end - b.end)
    .map(({ end, ...match }) => ({ ...match, statement: statementAround(text, match.position, end) }));
}
