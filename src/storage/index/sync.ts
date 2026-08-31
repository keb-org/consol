import { Database } from "bun:sqlite";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ACCESS_FRONTMATTER_KEY, chunkMarkdown, decodeAccessValue, hashContent, parseFrontmatter, wikiLinks } from "../vault";
import { repairMissingVectors, refreshVectorMeta } from "./embedding";
import { buildSurfacesForChunk, insertSurfaces, purgeSurfacesForChunkIds, repairMissingSurfaceVectors } from "./surfaces";
import { extractNumericEvidence, numericChronology } from "./ledger";
import { vectorTableAvailable, setMeta, deleteMeta } from "./schema";

function removeNumericLedgerChunk(db: Database, chunkId: number) {
  const rows = db.query("SELECT ledger_id FROM numeric_ledger WHERE chunk_id=?").all(chunkId) as { ledger_id: number }[];
  for (const { ledger_id } of rows) {
    try { db.query("DELETE FROM numeric_ledger_fts WHERE rowid=?").run(ledger_id); } catch {}
  }
  db.query("DELETE FROM numeric_ledger WHERE chunk_id=?").run(chunkId);
}

function toRel(agentRoot: string, full: string) {
  return path.relative(agentRoot, full).split(path.sep).join("/");
}

export function removeIndexedPath(db: Database, rel: string): void {
  const rows = db.query("SELECT chunk_id, doc_id FROM chunks WHERE path=?").all(rel) as { chunk_id: number; doc_id: string }[];
  purgeSurfacesForChunkIds(db, rows.map((r) => r.chunk_id));
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

async function attachedTeams(agentRoot: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(agentRoot, "agent.json"), "utf8")) as { teams?: unknown };
    if (!Array.isArray(raw.teams)) return [];
    return raw.teams.filter((team): team is string => typeof team === "string" && /^[A-Za-z0-9._-]+$/.test(team));
  } catch {
    return [];
  }
}

export async function collectNotes(vault: string, agentRoot: string): Promise<string[]> {
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

export async function indexFile(db: Database, vault: string, full: string, rel: string, text: string, hash: string, agent: string) {
  const { meta, body } = parseFrontmatter(text);
  const docId = meta.id ?? path.basename(full, ".md");
  const kind = meta.kind ?? "memory";
  const scope = meta.scope ?? "";
  const sourceRefs = meta.source_refs ?? "";
  const status = meta.status ?? "active";
  const occurredAt = numericChronology(body, meta.updated);
  const updated = meta.updated ?? new Date().toISOString();
  const owner = full.replace(/\\/g, "/").includes("/teams/") ? `team:${path.basename(path.dirname(path.dirname(full)))}` : `agent:${agent}`;
  const accessRaw = (meta as Record<string, string>)[ACCESS_FRONTMATTER_KEY];
  const accessDecoded = accessRaw ? (decodeAccessValue(accessRaw) as Record<string, unknown> | null) : null;

  const old = db.query("SELECT chunk_id, doc_id FROM chunks WHERE path=?").all(rel) as { chunk_id: number; doc_id: string }[];
  purgeSurfacesForChunkIds(db, old.map((r) => r.chunk_id));
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
    const surfaces = buildSurfacesForChunk(chunk, accessDecoded, docId);
    await insertSurfaces(db, vault, chunkId, surfaces);
  }
  const links = [...new Set(wikiLinks(body))];
  db.query("DELETE FROM links WHERE src=?").run(docId);
  for (const dst of links) db.query("INSERT INTO links(src,dst) VALUES(?,?)").run(docId, dst);
}

export async function syncVault(db: Database, vault: string, agentRoot: string, agent: string) {
  const files = await collectNotes(vault, agentRoot);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const hash = hashContent(text);
    const rel = toRel(agentRoot, file);
    const existing = db.query("SELECT hash FROM files WHERE path=?").get(rel) as any;
    if (existing?.hash === hash) continue;
    await indexFile(db, vault, file, rel, text, hash, agent);
    db.query("INSERT OR REPLACE INTO files(path,hash,updated) VALUES(?,?,?)").run(rel, hash, new Date().toISOString());
  }
  const current = new Set(files.map((file) => toRel(agentRoot, file)));
  const known = db.query("SELECT path FROM files").all() as { path: string }[];
  for (const { path: p } of known) {
    if (!current.has(p)) removeIndexedPath(db, p);
  }
  await repairMissingVectors(db, vault);
  await repairMissingSurfaceVectors(db, vault);
  refreshVectorMeta(db);
}

export async function rebuild(db: Database, vault: string, agentRoot: string, agent: string) {
  db.exec("DELETE FROM numeric_ledger; DELETE FROM numeric_ledger_fts; DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM files; DELETE FROM links; DELETE FROM temporal;");
  try { db.exec("DELETE FROM retrieval_surfaces;"); } catch {}
  try { db.exec("DELETE FROM retrieval_surfaces_fts;"); } catch {}
  try { db.exec("DELETE FROM retrieval_surface_vectors;"); } catch {}
  try { db.exec("DELETE FROM chunk_vectors;"); } catch {}
  setMeta(db, "vector_status", vectorTableAvailable(db) ? "empty" : "unavailable");
  deleteMeta(db, "vector_error");
  deleteMeta(db, "vector_updated");
  await syncVault(db, vault, agentRoot, agent);
}
