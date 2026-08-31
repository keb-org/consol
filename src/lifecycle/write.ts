import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { ACCESS_FRONTMATTER_KEY, atomicWrite, appendJsonl, encodeAccessValue, evidencePath, frontmatter, notePath, parseFrontmatter, stableId, withVaultLock } from "../storage/vault";
import { syncVault } from "../storage/index/sync";
import { containsSecret } from "../core/security";
import { nearDuplicateStatement } from "../retrieval/transfer";
import type { Packet, RetrievalUsageItem } from "../retrieval/packet";

export type AccessIntent = {
  aliases?: string[];
  entities?: string[];
  facets?: string[];
  likelyQueries?: string[];
};

export type RememberInput = { statement: string; scope?: string; refs?: string[]; access?: AccessIntent };
export type RecordInput = { kind: string; data: Record<string, unknown>; refs?: string[] };
export type UsageStage = "retrieved" | "packet-included" | "consulted";
export type UsageRecord = {
  id: string;
  at: string;
  agent: string;
  kind: "usage";
  stage: UsageStage;
  packetId?: string;
  mode?: string;
  items?: RetrievalUsageItem[];
  ref?: string;
  docId?: string;
  owner?: string;
  offset?: number;
};

const ACCESS_LIMITS = { aliases: 8, entities: 8, facets: 8, likelyQueries: 6 } as const;
const ACCESS_MAX_ITEM_BYTES = 120;
const ACCESS_MAX_ENCODED_BYTES = 2048;
const ACCESS_GENERIC_HUBS = new Set(["system", "project", "memory", "task", "note", "document", "file", "data", "info", "information"]);

function normalizeAccessItem(value: string) {
  return value.trim().normalize("NFC");
}

function isGenericSingleTokenFacet(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.includes(" ") || trimmed.includes("-") || trimmed.includes("_")) return false;
  return ACCESS_GENERIC_HUBS.has(trimmed);
}

function extractStructuredTokens(text: string): string[] {
  const out: string[] = [];
  const pushAll = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[0].toLowerCase());
  };
  pushAll(/\b\d{4}-\d{2}-\d{2}\b/g);
  pushAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)[ -]\d{1,2}(?:st|nd|rd|th)?(?:,|[ -])\s*\d{4}\b/gi);
  pushAll(/(?:[$€£¥]\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:USD|EUR|GBP|JPY)\b)/gi);
  pushAll(/\b\d[\d,]*(?:\.\d+)?\s*%/g);
  pushAll(/\bv(?:ersion)?\s*\d+(?:\.\d+){0,3}\b/gi);
  pushAll(/\b[A-Za-z]+-\d+[A-Za-z0-9-]*\b/g);
  pushAll(/\b[A-Za-z]*\d+[A-Za-z0-9._-]*\b/g);
  return [...new Set(out)];
}

function canonicalTokenSet(statement: string, scope?: string, refs?: string[]) {
  const combined = [statement, scope ?? "", ...(refs ?? [])].join(" ").toLowerCase();
  const tokens = combined.match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  const structured = extractStructuredTokens(combined);
  return new Set([...tokens, ...structured]);
}

function validateAccessField(
  field: string,
  values: string[] | undefined,
  canonicalTokens: Set<string>,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${field} must be string[] — category: type error (expected array of strings for access.${field}). Fix: pass string[] or omit the field`);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") throw new Error(`${field} entries must be strings — category: type error (every access.${field} entry must be a string). Fix: coerce or drop non-string entries`);
    const value = normalizeAccessItem(raw);
    if (!value) continue;
    if (Buffer.byteLength(value, "utf8") > ACCESS_MAX_ITEM_BYTES) throw new Error(`${field} entry exceeds ${ACCESS_MAX_ITEM_BYTES} bytes — category: out-of-bounds. Fix: shorten this ${field} entry to <= ${ACCESS_MAX_ITEM_BYTES} UTF-8 bytes (trim aliases/entities/facets/likelyQueries)`);
    if (/[\r\n\x00-\x1F\x7F]/.test(value)) throw new Error(`${field} entry contains control characters — category: type error (control/line-break characters not allowed). Fix: remove \\r, \\n, or ASCII controls from this ${field} entry`);
    if (/\[\[|\]\]/.test(value)) throw new Error(`${field} entry contains wiki-link syntax — category: type error ([[ ] ] is reserved for canonical evidence). Fix: remove [[wiki-link]] brackets from access intent; use plain phrases`);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (field === "facets" && isGenericSingleTokenFacet(value)) throw new Error(`generic facet rejected: ${value} — category: type error (single-token generic hubs like system/project/memory/task become retrieval hubs). Fix: use a more specific multi-token or narrow facet, or drop this generic facet`);
    for (const token of extractStructuredTokens(value)) {
      const supported = canonicalTokens.has(token) || [...canonicalTokens].some((ct) => ct.includes(token) || token.includes(ct));
      if (!supported) throw new Error(`${field} entry introduces unsupported structured value: ${token} — category: type error (access may only route to facts already in statement/scope/refs, not invent new IDs/dates/versions). Fix: ensure '${token}' appears verbatim or as substring in the canonical statement/scope/refs, or remove it from access.${field}`);
    }
    normalized.push(value);
  }
  const limit = ACCESS_LIMITS[field as keyof typeof ACCESS_LIMITS];
  if (normalized.length > limit) throw new Error(`${field} exceeds limit ${limit} — category: out-of-bounds (bounded routing metadata). Fix: keep at most ${limit} entries in access.${field}; drop lowest-value aliases/entities/facets/queries`);
  return normalized.length ? normalized : undefined;
}

export function normalizeAccessIntent(
  access: AccessIntent | undefined,
  statement: string,
  scope?: string,
  refs?: string[],
): AccessIntent | undefined {
  if (!access) return undefined;
  if (typeof access !== "object" || Array.isArray(access)) throw new Error("access must be an object — category: type error (expected {aliases?:string[], entities?:string[], facets?:string[], likelyQueries?:string[]} object). Fix: pass an object or omit access entirely; do not pass a string/array/null");
  const canonicalTokens = canonicalTokenSet(statement, scope, refs);
  const out: AccessIntent = {};
  const aliases = validateAccessField("aliases", (access as Record<string, unknown>).aliases as string[] | undefined, canonicalTokens);
  const entities = validateAccessField("entities", (access as Record<string, unknown>).entities as string[] | undefined, canonicalTokens);
  const facets = validateAccessField("facets", (access as Record<string, unknown>).facets as string[] | undefined, canonicalTokens);
  const likelyQueries = validateAccessField("likelyQueries", (access as Record<string, unknown>).likelyQueries as string[] | undefined, canonicalTokens);
  if (aliases) out.aliases = aliases;
  if (entities) out.entities = entities;
  if (facets) out.facets = facets;
  if (likelyQueries) out.likelyQueries = likelyQueries;
  if (!out.aliases && !out.entities && !out.facets && !out.likelyQueries) return undefined;
  const encoded = encodeAccessValue(out);
  if (Buffer.byteLength(encoded, "utf8") > ACCESS_MAX_ENCODED_BYTES) throw new Error(`access payload exceeds ${ACCESS_MAX_ENCODED_BYTES} bytes — category: out-of-bounds (encoded access_v1 frontmatter too large). Fix: shorten aliases/entities/facets/likelyQueries entries or reduce count until encoded size <= ${ACCESS_MAX_ENCODED_BYTES}`);
  return out;
}

function normalizeStatement(statement: string) {
  return statement.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

async function findDuplicate(agentRoot: string, statement: string) {
  const normalized = normalizeStatement(statement);
  for (const dir of ["memories", "core"]) {
    const root = path.join(agentRoot, dir);
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const text = await readFile(path.join(root, entry.name), "utf8").catch(() => "");
      const { meta, body } = parseFrontmatter(text);
      const assertion = body.replace(/\n\nRefs:[\s\S]*$/i, "");
      if (normalizeStatement(assertion) === normalized) return meta.id ?? entry.name.slice(0, -3);
      if (nearDuplicateStatement(assertion, statement)) return meta.id ?? entry.name.slice(0, -3);
    }
  }
  return null;
}

export async function remember(vault: string, agentRoot: string, agent: string, input: RememberInput, db?: Database) {
  if (!input.statement?.trim()) throw new Error("empty statement — category: type error (statement is required and must be non-empty). Fix: provide a 1–2000 char factual statement; do not call remember with empty or whitespace-only text");
  const refs = [...new Set((input.refs ?? []).map((ref) => ref.trim()).filter(Boolean))];
  const access = normalizeAccessIntent(input.access, input.statement, input.scope, refs);
  if (containsSecret({ statement: input.statement, scope: input.scope, refs, access })) throw new Error("secret rejected: input contains a credential/API key/secret pattern — category: unauthorized (secret must not be persisted). Fix: redact the secret from statement/scope/refs/access and retry; use a placeholder like [REDACTED]");
  if (refs.some((ref) => ref.length > 500 || /[\r\n\[\]]/.test(ref))) throw new Error("invalid ref — category: type error (each ref must be <=500 chars and must not contain \\r, \\n, [ or ]). Fix: pass short provenance strings without line breaks or bracket syntax; trim refs before calling remember");
  const dedup = await findDuplicate(agentRoot, input.statement);
  if (dedup) return { id: dedup, dedup: true };
  const id = stableId("mem-");
  const file = notePath(agentRoot, "memory", id);
  const extra: Record<string, string> = {
    scope: input.scope ?? "",
    updated: new Date().toISOString(),
    created_by: agent,
  };
  if (access) extra[ACCESS_FRONTMATTER_KEY] = encodeAccessValue(access);
  const fm = frontmatter("memory", id, extra);
  const body = refs.length
    ? `${input.statement}\n\nRefs: ${refs.map((ref) => `[[${ref}]]`).join(", ")}`
    : input.statement;
  await withVaultLock(vault, async () => {
    await atomicWrite(file, `${fm}${body}\n`);
  });
  if (db) await syncVault(db, vault, agentRoot, agent);
  return { id, path: file };
}

const RECORD_KINDS = new Set(["observation", "action", "feedback", "result", "outcome", "case", "correction"]);
const OUTCOME_VALUES = new Set(["success", "failure", "partial", "unknown"]);
const EVALUATOR_VALUES = new Set(["pass", "fail", "mixed", "unknown"]);

function stringField(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringRefs(value: unknown, key: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new Error(`${key} must be string[] — category: type error (expected array of non-empty strings). Fix: pass ${key} as string[] with non-empty entries or omit it`);
  }
  return [...new Set(value.map((ref) => ref.trim()))];
}

function validateCaseData(data: Record<string, unknown>) {
  if (!stringField(data, "rootSource")) throw new Error("case rootSource required — category: type error (record kind=case requires data.rootSource non-empty string). Fix: include data.rootSource describing the root source/origin");
  if (!stringField(data, "task")) throw new Error("case task required — category: type error (case requires data.task). Fix: include data.task string");
  if (!stringField(data, "environment")) throw new Error("case environment required — category: type error (case requires data.environment). Fix: include data.environment string");
  if (!stringField(data, "action")) throw new Error("case action required — category: type error (case requires data.action). Fix: include data.action string");
  if (!stringField(data, "observableOutcome")) throw new Error("case observableOutcome required — category: type error (case requires data.observableOutcome). Fix: include data.observableOutcome describing what was observed");
  if (!stringField(data, "evaluator")) throw new Error("case evaluator required — category: type error (case requires data.evaluator). Fix: include data.evaluator");
  const outcome = stringField(data, "outcome");
  if (!outcome || !OUTCOME_VALUES.has(outcome)) throw new Error("case outcome must be success, failure, partial, or unknown — category: type error. Fix: set data.outcome to one of success|failure|partial|unknown");
  return stringRefs(data.appliedRefs, "appliedRefs");
}

function validateOutcomeData(data: Record<string, unknown>, refs: string[]) {
  const outcome = stringField(data, "outcome");
  if (!outcome || !OUTCOME_VALUES.has(outcome)) throw new Error("outcome must be success, failure, partial, or unknown — category: type error. Fix: set data.outcome to one of success|failure|partial|unknown");
  const evaluator = stringField(data, "evaluator");
  if (!evaluator || !EVALUATOR_VALUES.has(evaluator)) throw new Error("evaluator must be pass, fail, mixed, or unknown — category: type error. Fix: set data.evaluator to one of pass|fail|mixed|unknown");
  const appliedRefs = stringRefs(data.appliedRefs, "appliedRefs");
  if (appliedRefs.some((ref) => !refs.includes(ref))) throw new Error("appliedRefs must also appear in refs — category: type error (every appliedRef must be listed in top-level refs for traceability). Fix: include each data.appliedRefs entry in the top-level refs array too");
  return appliedRefs;
}

export async function record(vault: string, agentRoot: string, agent: string, input: RecordInput) {
  if (!RECORD_KINDS.has(input.kind)) throw new Error(`unsupported record kind: ${input.kind} — category: type error (expected one of ${[...RECORD_KINDS].join("|")}). Fix: use a valid kind string`);
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) throw new Error("data object required — category: type error (record data must be a non-array object). Fix: pass data as {key: value} object, not string/array/null");
  const refs = [...new Set((input.refs ?? []).map((ref) => ref.trim()).filter(Boolean))];
  if (containsSecret({ data: input.data, refs })) throw new Error("secret rejected: input contains a credential/API key/secret pattern — category: unauthorized. Fix: redact secrets from data/refs and retry");
  if (refs.some((ref) => ref.length > 500 || /[\r\n]/.test(ref))) throw new Error("invalid ref — category: type error (each ref must be <=500 chars and must not contain \\r/\\n). Fix: shorten refs and remove line breaks");
  const appliedRefs = input.kind === "case"
    ? validateCaseData(input.data)
    : input.kind === "outcome"
      ? validateOutcomeData(input.data, refs)
      : [];
  if (appliedRefs.length) input.data = { ...input.data, appliedRefs };
  const id = stableId("ev-");
  const rec = { id, at: new Date().toISOString(), agent, kind: input.kind, data: input.data, refs };
  const file = evidencePath(agentRoot, new Date());
  await withVaultLock(vault, async () => appendJsonl(file, rec));
  return rec;
}

function usagePath(agentRoot: string) {
  return path.join(agentRoot, "audit", "usage.jsonl");
}

function usageItems(items: RetrievalUsageItem[]) {
  return items.map(({ ref, docId, kind, owner, source }) => ({ ref, docId, kind, owner, source }));
}

export async function recordRecallUsage(
  vault: string,
  agentRoot: string,
  agent: string,
  packet: Packet,
  retrieved: RetrievalUsageItem[],
) {
  const at = new Date().toISOString();
  const records: UsageRecord[] = [
    {
      id: stableId("use-"),
      at,
      agent,
      kind: "usage",
      stage: "retrieved",
      packetId: packet.id,
      mode: packet.mode,
      items: usageItems(retrieved),
    },
    {
      id: stableId("use-"),
      at,
      agent,
      kind: "usage",
      stage: "packet-included",
      packetId: packet.id,
      mode: packet.mode,
      items: usageItems(packet.items),
    },
  ];
  const file = usagePath(agentRoot);
  await withVaultLock(vault, async () => {
    for (const recordItem of records) await appendJsonl(file, recordItem);
  });
  return { recorded: records.length };
}

export async function recordConsultedUsage(
  vault: string,
  agentRoot: string,
  agent: string,
  input: { ref: string; docId: string; owner: string; offset: number; packetId?: string },
) {
  const recordItem: UsageRecord = {
    id: stableId("use-"),
    at: new Date().toISOString(),
    agent,
    kind: "usage",
    stage: "consulted",
    ref: input.ref,
    docId: input.docId,
    owner: input.owner,
    offset: input.offset,
    ...(input.packetId ? { packetId: input.packetId } : {}),
  };
  await withVaultLock(vault, async () => appendJsonl(usagePath(agentRoot), recordItem));
  return recordItem;
}

export async function readNote(agentRoot: string, docId: string) {
  const dirs = ["memories", "cases", "experiences", "skills", "core"];
  for (const d of dirs) {
    const p = path.join(agentRoot, d, `${docId}.md`);
    if (existsSync(p)) return { path: p, text: await readFile(p, "utf8") };
  }
  const vault = path.dirname(path.dirname(agentRoot));
  const teamsRoot = path.join(vault, "teams");
  if (existsSync(teamsRoot)) {
    const { getAttachedTeams } = await import("../core/identity");
    const agent = path.basename(agentRoot);
    for (const owner of await getAttachedTeams(vault, agent)) {
      const team = owner.slice("team:".length);
      for (const d of ["memories", "experiences"]) {
        const p = path.join(teamsRoot, team, d, `${docId}.md`);
        if (existsSync(p)) return { path: p, text: await readFile(p, "utf8") };
      }
    }
  }
  throw new Error("not found — category: stale or type error (no note matches docId in memories/cases/experiences/skills/core or attached team memories/experiences). Fix: verify docId spelling and that the note exists; re-run recall to obtain a current docId");
}
