import { Database } from "bun:sqlite";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EMBED_DIMS, MODEL_ID, MODEL_REVISION, MODEL_DTYPE, vaultModelCache, indexFingerprint } from "./config";
import { chunkMarkdown, parseFrontmatter, hashContent } from "./vault";

let embedder: any = null;
let embedderError: string | null = null;
let embedderLoading: Promise<any> | null = null;
let embedInvocationTail: Promise<void> = Promise.resolve();

export type VectorStatus = {
  available: boolean;
  indexed: number;
  reason?: string;
};

function metaValue(db: Database, key: string) {
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value;
}

function setMeta(db: Database, key: string, value: string) {
  db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, value);
}

function deleteMeta(db: Database, key: string) {
  db.query("DELETE FROM meta WHERE key=?").run(key);
}

function vectorTableAvailable(db: Database) {
  try {
    db.exec("SELECT chunk_id FROM chunk_vectors LIMIT 0");
    return true;
  } catch {
    return false;
  }
}

function vectorCount(db: Database) {
  if (!vectorTableAvailable(db)) return 0;
  try {
    return Number((db.query("SELECT count(*) AS n FROM chunk_vectors").get() as { n: number | bigint }).n);
  } catch {
    return 0;
  }
}

export function vectorStatus(db: Database): VectorStatus {
  const indexed = vectorCount(db);
  if (!vectorTableAvailable(db)) {
    return { available: false, indexed: 0, reason: "sqlite-vec unavailable" };
  }
  const status = metaValue(db, "vector_status") ?? (indexed > 0 ? "ready" : "empty");
  const error = metaValue(db, "vector_error") ?? undefined;
  if (status === "degraded") return { available: false, indexed, reason: error ?? "embedding unavailable" };
  return {
    available: true,
    indexed,
    reason: indexed === 0 ? (error ?? "no vectors indexed") : undefined,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export async function getEmbedder(vault: string) {
  if (embedder) return embedder;
  if (embedderLoading) return embedderLoading;
  const cache = vaultModelCache(vault);
  const cachedModel = path.join(cache, "Xenova", "all-MiniLM-L6-v2");
  embedderLoading = (async () => {
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = cache;
      env.allowRemoteModels = true;
      embedder = await withTimeout(
        (pipeline as any)("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE, revision: MODEL_REVISION }),
        existsSync(cachedModel) ? 30_000 : 300_000,
        "embedding model load",
      );
      embedderError = null;
      return embedder;
    } catch (error) {
      embedderLoading = null;
      embedderError = error instanceof Error ? error.message : String(error);
      throw new Error(`embed unavailable: ${embedderError}`);
    }
  })();
  return embedderLoading;
}

async function invokeEmbedder(pipe: any, texts: string[]) {
  const previous = embedInvocationTail;
  let release!: () => void;
  embedInvocationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await pipe(texts, { pooling: "mean", normalize: true });
  } finally {
    release();
  }
}

export async function embedTexts(vault: string, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  try {
    const pipe = await getEmbedder(vault);
    const out: any = await invokeEmbedder(pipe, texts);
    const vectors = out.tolist() as number[][];
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBED_DIMS || v.some((n) => !Number.isFinite(n)))) {
      throw new Error("invalid embedding shape or values");
    }
    return vectors;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    embedderError = message;
    throw new Error(message.startsWith("embed unavailable") ? message : `embed unavailable: ${message}`);
  }
}

export function setEmbedderForTests(fn: any, vault: string) {
  embedder = fn;
  embedderError = null;
  embedderLoading = null;
}

export function openIndex(agentRoot: string) {
  const dbPath = path.join(agentRoot, "index.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  try {
    const vec: any = typeof require !== "undefined" ? require("sqlite-vec") : (globalThis as any).require?.("sqlite-vec");
    if (vec?.load) vec.load(db as any);
  } catch {}
  ensureSchema(db);
  if (!vectorTableAvailable(db)) {
    try {
      const vec: any = typeof require !== "undefined" ? require("sqlite-vec") : (globalThis as any).require?.("sqlite-vec");
      if (vec?.load) vec.load(db as any);
      db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIMS}] DISTANCE_METRIC=cosine)`);
      if (!metaValue(db, "vector_status")) setMeta(db, "vector_status", "empty");
    } catch {
      setMeta(db, "vector_status", "unavailable");
      setMeta(db, "vector_error", "sqlite-vec unavailable");
    }
  }
  return db;
}

export function ensureSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, hash TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS chunks(
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT, path TEXT, section TEXT, kind TEXT, owner TEXT, scope TEXT, source_refs TEXT, status TEXT, updated TEXT, hash TEXT, text TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS numeric_ledger(
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      value_kind TEXT NOT NULL,
      statement TEXT NOT NULL,
      occurred_at TEXT,
      position INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS numeric_ledger_fts USING fts5(value, statement, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS links(src TEXT, dst TEXT);
    CREATE TABLE IF NOT EXISTS temporal(doc_id TEXT, valid_from TEXT, valid_to TEXT);
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_owner_status ON chunks(owner, status);
    CREATE INDEX IF NOT EXISTS idx_numeric_ledger_chunk ON numeric_ledger(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_numeric_ledger_time ON numeric_ledger(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_links_src ON links(src);
    CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);
  `);
  try { db.exec("ALTER TABLE chunks ADD COLUMN source_refs TEXT DEFAULT ''"); } catch {}
  const fp = indexFingerprint();
  const cur = db.query("SELECT value FROM meta WHERE key='fingerprint'").get() as any;
  if (cur?.value !== fp) {
    db.exec("DELETE FROM numeric_ledger; DELETE FROM chunks; DELETE FROM links; DELETE FROM temporal; DELETE FROM files;");
    try { db.exec("DELETE FROM numeric_ledger_fts;"); } catch {}
    try { db.exec("DELETE FROM chunks_fts;"); } catch {}
    try { db.exec("DELETE FROM chunk_vectors;"); } catch {}
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('fingerprint',?)").run(fp);
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('vector_status','empty')").run();
    db.query("DELETE FROM meta WHERE key IN ('vector_error','vector_updated')").run();
  }
}

type NumericEvidence = {
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

function canonicalDate(value: string | undefined) {
  if (!value) return null;
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = value.trim().match(/^([A-Za-z]+)[ -](\d{1,2})(?:,|[ -])\s*(\d{4})$/);
  const month = named && MONTHS[named[1].toLowerCase()];
  return named && month ? `${named[3]}-${month}-${named[2].padStart(2, "0")}` : null;
}

function numericChronology(body: string, updated?: string) {
  const anchor = body.match(/^\s*\[Date:\s*([^\]]+)\]/i)?.[1];
  return canonicalDate(anchor) ?? canonicalDate(updated);
}

function statementAround(text: string, start: number, end: number) {
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

function versionContext(text: string, start: number) {
  const before = text.slice(Math.max(0, start - 48), start);
  if (/[-_#]$/.test(before) || /\b(?:id|ticket|issue)\s*[-#:]?\s*$/i.test(before)) return false;
  if (/(?:\bversion\s*|\bv\s*)$/i.test(before)) return true;
  return /\b(?:[A-Z][A-Za-z0-9+#_-]*|[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z0-9._-]+)\s*$/.test(before);
}

function meaningfulPlainNumber(text: string, start: number, end: number, value: string) {
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

// ponytail: patterns cover explicit source values; add learned extraction only after measured category misses prove this ceiling.
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

function removeNumericLedgerChunk(db: Database, chunkId: number) {
  const rows = db.query("SELECT ledger_id FROM numeric_ledger WHERE chunk_id=?").all(chunkId) as { ledger_id: number }[];
  for (const { ledger_id } of rows) {
    try { db.query("DELETE FROM numeric_ledger_fts WHERE rowid=?").run(ledger_id); } catch {}
  }
  db.query("DELETE FROM numeric_ledger WHERE chunk_id=?").run(chunkId);
}

// Normalizes path separators to '/' so Windows backslashes never cause duplicate index rows.
function toRel(agentRoot: string, full: string) { return path.relative(agentRoot, full).split(path.sep).join("/"); }

export function removeIndexedPath(db: Database, rel: string) {
  const rows = db.query("SELECT chunk_id, doc_id FROM chunks WHERE path=?").all(rel) as { chunk_id: number; doc_id: string }[];
  for (const { chunk_id } of rows) {
    removeNumericLedgerChunk(db, chunk_id);
    try { db.query("DELETE FROM chunks_fts WHERE rowid=?").run(chunk_id); } catch {}
    try { db.query("DELETE FROM chunk_vectors WHERE chunk_id=?").run(chunk_id); } catch {}
  }
  for (const docId of new Set(rows.map((row) => row.doc_id))) {
    db.query("DELETE FROM links WHERE src=? OR dst=?").run(docId, docId);
    db.query("DELETE FROM temporal WHERE doc_id=?").run(docId);
  }
  db.query("DELETE FROM chunks WHERE path=?").run(rel);
  db.query("DELETE FROM files WHERE path=?").run(rel);
}

export async function syncVault(db: Database, vault: string, agentRoot: string, agent: string) {
  const files = await collectNotes(vault, agentRoot);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const hash = hashContent(text);
    const rel = toRel(agentRoot, file);
    const existing = db.query("SELECT hash FROM files WHERE path=?").get(rel) as any;
    if (existing?.hash === hash) continue;
    await indexFile(db, file, rel, text, hash, agent);
    db.query("INSERT OR REPLACE INTO files(path,hash,updated) VALUES(?,?,?)").run(rel, hash, new Date().toISOString());
  }
  const current = new Set(files.map((file) => toRel(agentRoot, file)));
  const known = db.query("SELECT path FROM files").all() as { path: string }[];
  for (const { path: p } of known) {
    if (!current.has(p)) removeIndexedPath(db, p);
  }
  await repairMissingVectors(db, vault);
  refreshVectorMeta(db);
}

async function attachedTeams(agentRoot: string) {
  try {
    const raw = JSON.parse(await readFile(path.join(agentRoot, "agent.json"), "utf8")) as { teams?: unknown };
    if (!Array.isArray(raw.teams)) return [];
    return raw.teams.filter((team): team is string => typeof team === "string" && /^[A-Za-z0-9._-]+$/.test(team));
  } catch {
    return [];
  }
}

async function collectNotes(vault: string, agentRoot: string): Promise<string[]> {
  const roots = ["memories", "cases", "experiences", "skills", "core"];
  const out: string[] = [];
  for (const r of roots) {
    const dir = path.join(agentRoot, r);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(dir, e.name));
  }
  for (const team of await attachedTeams(agentRoot)) {
    const td = path.join(vault, "teams", team);
    for (const sub of ["memories", "experiences"]) {
      const d = path.join(td, sub);
      if (!existsSync(d)) continue;
      const es = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of es) if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(d, e.name));
    }
  }
  return out.sort();
}

async function repairMissingVectors(db: Database, vault: string) {
  if (!vectorTableAvailable(db)) return;
  const missing = db.query(`
    SELECT c.chunk_id, c.text
    FROM chunks c
    LEFT JOIN chunk_vectors v ON v.chunk_id = c.chunk_id
    WHERE v.chunk_id IS NULL
    ORDER BY c.chunk_id
  `).all() as { chunk_id: number; text: string }[];
  if (!missing.length) return;
  const insert = db.query("INSERT OR REPLACE INTO chunk_vectors(chunk_id,embedding) VALUES(?,?)");
  try {
    for (let start = 0; start < missing.length; start += 64) {
      const batch = missing.slice(start, start + 64);
      const vectors = await embedTexts(vault, batch.map((row) => row.text));
      for (let i = 0; i < batch.length; i++) insert.run(batch[i].chunk_id, JSON.stringify(vectors[i]));
    }
    setMeta(db, "vector_updated", new Date().toISOString());
    deleteMeta(db, "vector_error");
  } catch (error) {
    setMeta(db, "vector_status", "degraded");
    setMeta(db, "vector_error", error instanceof Error ? error.message : String(error));
  }
}

async function indexFile(db: Database, full: string, rel: string, text: string, hash: string, agent: string) {
  const { meta, body } = parseFrontmatter(text);
  const docId = meta.id ?? path.basename(full, ".md");
  const kind = meta.kind ?? "memory";
  const scope = meta.scope ?? "";
  const sourceRefs = meta.source_refs ?? "";
  const status = meta.status ?? "active";
  const occurredAt = numericChronology(body, meta.updated);
  const updated = meta.updated ?? new Date().toISOString();
  const owner = full.replace(/\\/g, "/").includes("/teams/") ? `team:${path.basename(path.dirname(path.dirname(full)))}` : `agent:${agent}`;

  const old = db.query("SELECT chunk_id, doc_id FROM chunks WHERE path=?").all(rel) as { chunk_id: number; doc_id: string }[];
  for (const { chunk_id } of old) {
    removeNumericLedgerChunk(db, chunk_id);
    try { db.query("DELETE FROM chunks_fts WHERE rowid=?").run(chunk_id); } catch {}
    try { db.query("DELETE FROM chunk_vectors WHERE chunk_id=?").run(chunk_id); } catch {}
  }
  for (const oldDocId of new Set(old.map((row) => row.doc_id))) db.query("DELETE FROM links WHERE src=?").run(oldDocId);
  db.query("DELETE FROM chunks WHERE path=?").run(rel);
  const chunks = chunkMarkdown(text);
  if (chunks.length === 0) return;

  const insert = db.query("INSERT INTO chunks(doc_id,path,section,kind,owner,scope,source_refs,status,updated,hash,text) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const ftsInsert = db.query("INSERT INTO chunks_fts(rowid,text) VALUES(?,?)");
  const ledgerInsert = db.query("INSERT INTO numeric_ledger(chunk_id,value,value_kind,statement,occurred_at,position) VALUES(?,?,?,?,?,?)");
  const ledgerFtsInsert = db.query("INSERT INTO numeric_ledger_fts(rowid,value,statement) VALUES(?,?,?)");
  for (const chunk of chunks) {
    const r = insert.run(docId, rel, chunk.section, kind, owner, scope, sourceRefs, status, updated, hash, chunk.text) as any;
    const chunkId = Number(r.lastInsertRowid);
    ftsInsert.run(chunkId, chunk.text);
    for (const evidence of extractNumericEvidence(chunk.text)) {
      const ledger = ledgerInsert.run(chunkId, evidence.value, evidence.valueKind, evidence.statement, occurredAt, evidence.position) as any;
      ledgerFtsInsert.run(Number(ledger.lastInsertRowid), evidence.value, evidence.statement);
    }
  }
  const links = extractWikiLinks(body);
  db.query("DELETE FROM links WHERE src=?").run(docId);
  for (const dst of links) db.query("INSERT INTO links(src,dst) VALUES(?,?)").run(docId, dst);
}

function refreshVectorMeta(db: Database) {
  const chunks = Number((db.query("SELECT count(*) AS n FROM chunks").get() as { n: number | bigint }).n);
  const indexed = vectorCount(db);
  if (!vectorTableAvailable(db)) {
    setMeta(db, "vector_status", "unavailable");
    setMeta(db, "vector_error", "sqlite-vec unavailable");
  } else if (chunks === 0) {
    setMeta(db, "vector_status", "empty");
    deleteMeta(db, "vector_error");
  } else if (indexed === chunks) {
    setMeta(db, "vector_status", "ready");
    deleteMeta(db, "vector_error");
  } else {
    const error = metaValue(db, "vector_error");
    setMeta(db, "vector_status", "degraded");
    if (!error) setMeta(db, "vector_error", `${chunks - indexed} chunks missing vectors`);
  }
}

function extractWikiLinks(text: string) {
  const re = /\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|[^\]]*)?\]\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return [...new Set(out)];
}

export async function rebuild(db: Database, vault: string, agentRoot: string, agent: string) {
  db.exec("DELETE FROM numeric_ledger; DELETE FROM numeric_ledger_fts; DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM files; DELETE FROM links; DELETE FROM temporal;");
  try { db.exec("DELETE FROM chunk_vectors;"); } catch {}
  setMeta(db, "vector_status", vectorTableAvailable(db) ? "empty" : "unavailable");
  deleteMeta(db, "vector_error");
  deleteMeta(db, "vector_updated");
  await syncVault(db, vault, agentRoot, agent);
}

export function ftsSearch(db: Database, query: string, limit: number) {
  const raw = query.trim().replace(/["'*]/g, " ");
  if (!raw) return [];
  const words = raw.split(/\s+/).filter(Boolean);
  const ftsQuery = words.length > 1 ? words.join(" OR ") : raw;
  try {
    const res = db.query(`SELECT rowid as chunk_id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, limit) as { chunk_id: number; rank: number }[];
    if (res.length) return res;
  } catch {}
  if (words.length > 1) {
    const clauses = words.map(() => "text LIKE ?").join(" OR ");
    return db.query(`SELECT chunk_id, -1 as rank FROM chunks WHERE ${clauses} ORDER BY doc_id, chunk_id LIMIT ?`).all(...words.map((w) => `%${w}%`), limit) as { chunk_id: number; rank: number }[];
  }
  return db.query(`SELECT chunk_id, -1 as rank FROM chunks WHERE text LIKE ? ORDER BY doc_id, chunk_id LIMIT ?`).all(`%${query.trim()}%`, limit) as { chunk_id: number; rank: number }[];
}

export type NumericLedgerSearchRow = {
  chunk_id: number;
  value: string;
  value_kind: string;
  statement: string;
  occurred_at: string | null;
  position: number;
};

const NUMERIC_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from", "had", "has", "have",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "said", "set", "that", "the", "to", "was", "were", "what",
  "when", "which", "with", "you", "your",
]);

function numericTokens(text: string) {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
}

function numericQueryTerms(query: string) {
  return [...new Set(numericTokens(query)
    .filter((word) => !NUMERIC_QUERY_STOPWORDS.has(word)))]
    .slice(0, 16);
}

export function numericLedgerSearch(db: Database, query: string, limit: number): NumericLedgerSearchRow[] {
  const words = numericQueryTerms(query);
  if (!words.length) return [];
  const ftsQuery = words.map((word) => `"${word.replace(/"/g, "")}"`).join(" OR ");
  try {
    const rows = db.query(`
      SELECT n.chunk_id, n.value, n.value_kind, n.statement, n.occurred_at, n.position, f.rank
      FROM numeric_ledger_fts f
      JOIN numeric_ledger n ON n.ledger_id = f.rowid
      WHERE numeric_ledger_fts MATCH ?
      ORDER BY f.rank, n.chunk_id, n.position
      LIMIT ?
    `).all(ftsQuery, Math.max(limit * 4, limit)) as (NumericLedgerSearchRow & { rank: number })[];
    return rows
      .map((row) => {
        const tokens = new Set(numericTokens(`${row.value} ${row.statement}`));
        return { row, coverage: words.filter((word) => tokens.has(word)).length };
      })
      .sort((a, b) =>
        b.coverage - a.coverage ||
        Number(Boolean(b.row.occurred_at)) - Number(Boolean(a.row.occurred_at)) ||
        (b.row.occurred_at ?? "").localeCompare(a.row.occurred_at ?? "") ||
        a.row.rank - b.row.rank ||
        a.row.chunk_id - b.row.chunk_id ||
        a.row.position - b.row.position)
      .slice(0, limit)
      .map(({ row: { rank, ...row } }) => row);
  } catch {
    return [];
  }
}

export function vecSearch(db: Database, embedding: number[], limit: number) {
  try {
    return db.query(`SELECT chunk_id, distance FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance`).all(JSON.stringify(embedding), limit) as { chunk_id: number; distance: number }[];
  } catch { return []; }
}
