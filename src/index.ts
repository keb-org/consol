import { Database } from "bun:sqlite";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EMBED_DIMS, MODEL_ID, MODEL_REVISION, MODEL_DTYPE, vaultModelCache, indexFingerprint } from "./config";
import { chunkMarkdown, parseFrontmatter, hashContent } from "./vault";

let embedder: any = null;
let embedderVault: string | null = null;

export async function getEmbedder(vault: string) {
  if (embedder && embedderVault === vault) return embedder;
  const cache = vaultModelCache(vault);
  const cachedModel = path.join(cache, "Xenova", "all-MiniLM-L6-v2");
  if (!existsSync(cachedModel) && process.env.MEMORY_EAGER_EMBED !== "1") {
    throw new Error("model not cached; use MEMORY_EAGER_EMBED=1 to download");
  }
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cache;
  env.allowRemoteModels = true;
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("embed timeout")), ms))]);
  embedder = await withTimeout(
    pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE as any, revision: MODEL_REVISION } as any),
    8000,
  );
  embedderVault = vault;
  return embedder;
}

export async function embedTexts(vault: string, texts: string[]): Promise<number[][]> {
  try {
    const pipe = await getEmbedder(vault);
    const out: any = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  } catch {
    throw new Error("embed unavailable");
  }
}

export function setEmbedderForTests(fn: any, vault: string) {
  embedder = fn;
  embedderVault = vault;
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
  try {
    db.exec("SELECT * FROM chunk_vectors LIMIT 0");
  } catch {
    try {
      const vec: any = typeof require !== "undefined" ? require("sqlite-vec") : (globalThis as any).require?.("sqlite-vec");
      if (vec?.load) vec.load(db as any);
      db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIMS}] DISTANCE_METRIC=cosine)`);
    } catch {}
  }
  return db;
}

export function ensureSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, hash TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS chunks(
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT, path TEXT, section TEXT, kind TEXT, owner TEXT, scope TEXT, status TEXT, updated TEXT, hash TEXT, text TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS links(src TEXT, dst TEXT);
    CREATE TABLE IF NOT EXISTS temporal(doc_id TEXT, valid_from TEXT, valid_to TEXT);
  `);
  const fp = indexFingerprint();
  const cur = db.query("SELECT value FROM meta WHERE key='fingerprint'").get() as any;
  if (cur?.value !== fp) {
    db.exec("DELETE FROM chunks; DELETE FROM links; DELETE FROM files;");
    try { db.exec("DELETE FROM chunks_fts;"); } catch {}
    try { db.exec("DELETE FROM chunk_vectors;"); } catch {}
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('fingerprint',?)").run(fp);
  }
}

// Normalizes path separators to '/' so Windows backslashes never cause duplicate index rows.
function toRel(agentRoot: string, full: string) { return path.relative(agentRoot, full).split(path.sep).join("/"); }
function fromRel(agentRoot: string, rel: string) { return path.join(agentRoot, ...rel.split("/")); }

export async function syncVault(db: Database, vault: string, agentRoot: string, agent: string) {
  const files = await collectNotes(agentRoot);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const hash = hashContent(text);
    const rel = toRel(agentRoot, file);
    const existing = db.query("SELECT hash FROM files WHERE path=?").get(rel) as any;
    if (existing?.hash === hash) continue;
    await indexFile(db, vault, file, rel, text, hash, agent);
    db.query("INSERT OR REPLACE INTO files(path,hash,updated) VALUES(?,?,?)").run(rel, hash, new Date().toISOString());
  }
  const known = db.query("SELECT path FROM files").all() as { path: string }[];
  for (const { path: p } of known) {
    const full = fromRel(agentRoot, p);
    if (!existsSync(full)) {
      const ids = db.query("SELECT chunk_id FROM chunks WHERE path=?").all(p) as { chunk_id: number }[];
      for (const { chunk_id } of ids) {
        try { db.query("DELETE FROM chunks_fts WHERE rowid=?").run(chunk_id); } catch {}
        try { db.query("DELETE FROM chunk_vectors WHERE chunk_id=?").run(chunk_id); } catch {}
      }
      db.query("DELETE FROM chunks WHERE path=?").run(p);
      db.query("DELETE FROM files WHERE path=?").run(p);
      db.query("DELETE FROM links WHERE src IN (SELECT doc_id FROM chunks WHERE path=?)").run(p);
    }
  }
}

async function collectNotes(agentRoot: string): Promise<string[]> {
  const roots = ["memories", "cases", "experiences", "skills", "core"];
  const out: string[] = [];
  for (const r of roots) {
    const dir = path.join(agentRoot, r);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(dir, e.name));
  }
  const vault = path.dirname(path.dirname(agentRoot));
  const teamsRoot = path.join(vault, "teams");
  if (existsSync(teamsRoot)) {
    const teams = await readdir(teamsRoot, { withFileTypes: true }).catch(() => []);
    for (const t of teams) if (t.isDirectory()) {
      const td = path.join(teamsRoot, t.name);
      for (const sub of ["memories", "experiences"]) {
        const d = path.join(td, sub);
        if (!existsSync(d)) continue;
        const es = await readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of es) if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(d, e.name));
      }
    }
  }
  return out;
}

async function indexFile(db: Database, vault: string, full: string, rel: string, text: string, hash: string, agent: string) {
  const { meta, body } = parseFrontmatter(text);
  const docId = meta.id ?? path.basename(full, ".md");
  const kind = meta.kind ?? "memory";
  const scope = meta.scope ?? "";
  const status = meta.status ?? "active";
  const updated = meta.updated ?? new Date().toISOString();
  const owner = full.includes(`${path.sep}teams${path.sep}`) ? `team:${path.basename(path.dirname(path.dirname(full)))}` : `agent:${agent}`;

  const old = db.query("SELECT chunk_id FROM chunks WHERE path=?").all(rel) as { chunk_id: number }[];
  for (const { chunk_id } of old) {
    try { db.query("DELETE FROM chunks_fts WHERE rowid=?").run(chunk_id); } catch {}
    try { db.query("DELETE FROM chunk_vectors WHERE chunk_id=?").run(chunk_id); } catch {}
  }
  db.query("DELETE FROM chunks WHERE path=?").run(rel);
  const chunks = chunkMarkdown(text);
  if (chunks.length === 0) return;
  const vectors = await embedTexts(vault, chunks.map((c) => c.text)).catch(() => chunks.map(() => Array(EMBED_DIMS).fill(0)));
  const insert = db.query("INSERT INTO chunks(doc_id,path,section,kind,owner,scope,status,updated,hash,text) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const ftsInsert = db.query("INSERT INTO chunks_fts(rowid,text) VALUES(?,?)");
  for (let i = 0; i < chunks.length; i++) {
    const r = insert.run(docId, rel, chunks[i].section, kind, owner, scope, status, updated, hash, chunks[i].text) as any;
    const id = Number(r.lastInsertRowid);
    ftsInsert.run(id, chunks[i].text);
    const vec = vectors[i];
    try {
      db.query("INSERT INTO chunk_vectors(chunk_id,embedding) VALUES(?,?)").run(id, JSON.stringify(vec));
    } catch {}
  }
  const links = extractWikiLinks(body);
  db.query("DELETE FROM links WHERE src=?").run(docId);
  for (const dst of links) db.query("INSERT INTO links(src,dst) VALUES(?,?)").run(docId, dst);
}

function extractWikiLinks(text: string) {
  const re = /\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|[^\]]*)?\]\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return [...new Set(out)];
}

export async function rebuild(db: Database, vault: string, agentRoot: string, agent: string) {
  db.exec("DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM files; DELETE FROM links;");
  try { db.exec("DELETE FROM chunk_vectors;"); } catch {}
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
    return db.query(`SELECT chunk_id, -1 as rank FROM chunks WHERE ${clauses} LIMIT ?`).all(...words.map((w) => `%${w}%`), limit) as { chunk_id: number; rank: number }[];
  }
  return db.query(`SELECT chunk_id, -1 as rank FROM chunks WHERE text LIKE ? LIMIT ?`).all(`%${query.trim()}%`, limit) as { chunk_id: number; rank: number }[];
}

export function vecSearch(db: Database, embedding: number[], limit: number) {
  try {
    return db.query(`SELECT chunk_id, distance FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance`).all(JSON.stringify(embedding), limit) as { chunk_id: number; distance: number }[];
  } catch { return []; }
}
