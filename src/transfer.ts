export type ReusableClass = "principle" | "pattern" | "specific";

export function trigramSet(text: string): Set<string> {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length < 3) return new Set([normalized]);
  const out = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) out.add(normalized.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function nearDuplicateStatement(a: string, b: string, threshold = 0.85): boolean {
  const an = a.trim().replace(/\s+/g, " ").toLowerCase();
  const bn = b.trim().replace(/\s+/g, " ").toLowerCase();
  if (an === bn) return true;
  if (Math.abs(an.length - bn.length) > Math.max(an.length, bn.length) * 0.45) return false;
  return jaccard(trigramSet(an), trigramSet(bn)) >= threshold;
}

export function reusableKindWeight(kind: string): number {
  if (kind === "skill") return 1.0;
  if (kind === "experience") return 0.85;
  if (kind === "case") return 0.55;
  if (kind === "core") return 0.75;
  return 0.35;
}

export function reusableStatusWeight(status: string): number {
  if (status === "active") return 1.0;
  if (status === "staging") return 0.7;
  if (status === "candidate") return 0.45;
  return 0.15;
}

export function parseSourceRefCount(frontmatterSourceRefs: string | undefined): number {
  if (!frontmatterSourceRefs) return 0;
  return frontmatterSourceRefs.split(/[;,]/).map((s) => s.trim()).filter(Boolean).length;
}

export function abstractionLevel(kind: string, sourceCount: number, distinctRoots: number): ReusableClass {
  if (kind === "skill" && (sourceCount >= 2 || distinctRoots >= 2)) return "principle";
  if ((kind === "experience" || kind === "skill") && sourceCount >= 2) return "pattern";
  if (sourceCount >= 3) return "pattern";
  return "specific";
}

export function transferBoost(args: {
  kind: string;
  status: string;
  sourceCount: number;
  distinctRoots?: number;
  lexicalCoverage: number;
  perArmCap: number;
}): number {
  const kindW = reusableKindWeight(args.kind);
  const statusW = reusableStatusWeight(args.status);
  const sourceW = Math.min(1, args.sourceCount / 3);
  const rootsW = args.distinctRoots !== undefined ? Math.min(1, args.distinctRoots / 2) : sourceW * 0.6;
  const novelty = 1 - Math.min(1, args.lexicalCoverage / Math.max(1, args.perArmCap));
  const reusableSignal = 0.45 * kindW + 0.2 * statusW + 0.2 * sourceW + 0.15 * rootsW;
  return reusableSignal * novelty * 0.06;
}

export function transferBoostForChunk(args: {
  kind: string;
  status: string;
  text: string;
  lexicalCoverage: number;
  perArmCap: number;
}): number {
  const sourceCount = parseSourceRefCount(parseFrontmatterLite(args.text).source_refs);
  return transferBoost({ kind: args.kind, status: args.status, sourceCount, lexicalCoverage: args.lexicalCoverage, perArmCap: args.perArmCap });
}

function parseFrontmatterLite(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const raw = text.slice(3, end).trim();
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return meta;
}

export function compressionSavingsBytes(originalBytes: number, compressedBytes: number): number {
  return Math.max(0, originalBytes - compressedBytes);
}

export function tokenEstimate(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function valuePerToken(reuseCount: number, distinctRoots: number, bytes: number): number {
  const tokens = Math.max(1, Math.ceil(bytes / 4));
  const reusableValue = reuseCount * 0.7 + distinctRoots * 1.2 + 1;
  return reusableValue / tokens;
}
