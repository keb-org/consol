import { Database } from "bun:sqlite";
import path from "node:path";
import { EMBED_DIMS, indexFingerprint, SURFACE_SCHEMA_VERSION, SURFACE_DERIVATION_VERSION } from "@/core/config";

export function metaValue(db: Database, key: string): string | undefined {
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, value);
}

export function deleteMeta(db: Database, key: string): void {
  db.query("DELETE FROM meta WHERE key=?").run(key);
}

export function vectorTableAvailable(db: Database): boolean {
  try {
    db.exec("SELECT chunk_id FROM chunk_vectors LIMIT 0");
    return true;
  } catch {
    return false;
  }
}

export function vectorCount(db: Database): number {
  if (!vectorTableAvailable(db)) return 0;
  try {
    return Number((db.query("SELECT count(*) AS n FROM chunk_vectors").get() as { n: number | bigint }).n);
  } catch {
    return 0;
  }
}

export function surfaceTableAvailable(db: Database): boolean {
  try {
    db.exec("SELECT surface_id FROM retrieval_surfaces LIMIT 0");
    return true;
  } catch {
    return false;
  }
}

export function surfaceFtsAvailable(db: Database): boolean {
  try {
    db.exec("SELECT surface_id FROM retrieval_surfaces_fts LIMIT 0");
    return true;
  } catch {
    return false;
  }
}

export function surfaceVectorAvailable(db: Database): boolean {
  try {
    db.exec("SELECT surface_id FROM retrieval_surface_vectors LIMIT 0");
    return true;
  } catch {
    return false;
  }
}

export function surfaceVectorCount(db: Database): number {
  if (!surfaceVectorAvailable(db)) return 0;
  try {
    return Number((db.query("SELECT count(*) AS n FROM retrieval_surface_vectors").get() as { n: number | bigint }).n);
  } catch {
    return 0;
  }
}

export function openIndex(agentRoot: string): Database {
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

export function ensureSchema(db: Database): void {
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_surfaces(
      surface_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      surface_kind TEXT NOT NULL,
      provenance TEXT NOT NULL,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      UNIQUE(chunk_id, surface_kind, text_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_surfaces_chunk ON retrieval_surfaces(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_surfaces_kind ON retrieval_surfaces(surface_kind);
  `);
  try { db.exec("CREATE VIRTUAL TABLE retrieval_surfaces_fts USING fts5(text, tokenize='porter unicode61')"); } catch {}
  try {
    const vec: any = typeof require !== "undefined" ? require("sqlite-vec") : (globalThis as any).require?.("sqlite-vec");
    if (vec?.load) vec.load(db as any);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_surface_vectors USING vec0(surface_id INTEGER PRIMARY KEY, embedding FLOAT[${EMBED_DIMS}] DISTANCE_METRIC=cosine)`);
  } catch {}
  try { db.exec("ALTER TABLE chunks ADD COLUMN source_refs TEXT DEFAULT ''"); } catch {}
  const fp = indexFingerprint();
  const cur = db.query("SELECT value FROM meta WHERE key='fingerprint'").get() as any;
  if (cur?.value !== fp) {
    db.exec("DELETE FROM numeric_ledger; DELETE FROM chunks; DELETE FROM links; DELETE FROM temporal; DELETE FROM files;");
    try { db.exec("DELETE FROM retrieval_surfaces;"); } catch {}
    try { db.exec("DELETE FROM retrieval_surfaces_fts;"); } catch {}
    try { db.exec("DELETE FROM retrieval_surface_vectors;"); } catch {}
    try { db.exec("DELETE FROM numeric_ledger_fts;"); } catch {}
    try { db.exec("DELETE FROM chunks_fts;"); } catch {}
    try { db.exec("DELETE FROM chunk_vectors;"); } catch {}
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('fingerprint',?)").run(fp);
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('vector_status','empty')").run();
    db.query("DELETE FROM meta WHERE key IN ('vector_error','vector_updated')").run();
  }
  // Ensure surface schema version tracking
  const sver = `${SURFACE_SCHEMA_VERSION}:${SURFACE_DERIVATION_VERSION}`;
  const curSver = metaValue(db, "surface_schema");
  if (curSver !== sver) {
    try { db.exec("DELETE FROM retrieval_surfaces; DELETE FROM retrieval_surfaces_fts; DELETE FROM retrieval_surface_vectors;"); } catch {}
    setMeta(db, "surface_schema", sver);
  }
}
