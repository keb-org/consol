import { Database } from "bun:sqlite";
import { hashContent } from "@/storage/vault";
import { embedTexts } from "./embedding";
import { surfaceFtsAvailable, surfaceTableAvailable, surfaceVectorAvailable } from "./schema";

export const SURFACE_KINDS = new Set(["alias", "entity", "facet", "likely_query"]);

export type SurfaceRow = { kind: string; provenance: string; text: string };

function normalizeSurfaceText(text: string): string {
  return text.trim().replace(/\s+/g, " ").normalize("NFC");
}

function surfaceTextHash(text: string): string {
  return hashContent(normalizeSurfaceText(text).toLowerCase());
}

function chunkContextForSurface(chunk: { section: string; text: string }, docId: string): string {
  const heading = chunk.section.replace(/#\d+$/, "").trim();
  const excerpt = chunk.text.replace(/^\s*\[Date:[^\]]+\]\s*/i, "").trim().split("\n")[0]?.slice(0, 100) ?? "";
  const ctx = heading ? `${heading}: ${excerpt}` : excerpt || docId;
  return ctx.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function buildSurfacesForChunk(
  chunk: { section: string; text: string },
  access: Record<string, unknown> | null,
  docId: string,
): SurfaceRow[] {
  if (!access) return [];
  const ctx = chunkContextForSurface(chunk, docId);
  const out: SurfaceRow[] = [];
  const push = (kind: string, provenance: string, values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const raw of values) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const v = raw.trim().slice(0, 120);
      const text = `${v} — ${ctx}`.slice(0, 280);
      if (!text) continue;
      out.push({ kind, provenance, text });
    }
  };
  push("alias", "host:alias", (access as any).aliases);
  push("entity", "host:entity", (access as any).entities);
  push("facet", "host:facet", (access as any).facets);
  push("likely_query", "host:likely-query", (access as any).likelyQueries);
  out.sort((a, b) => a.kind.localeCompare(b.kind) || normalizeSurfaceText(a.text).localeCompare(normalizeSurfaceText(b.text)));
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.kind}:${normalizeSurfaceText(s.text).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function purgeSurfacesForChunkIds(db: Database, chunkIds: number[]): void {
  if (!chunkIds.length || !surfaceTableAvailable(db)) return;
  for (const chunkId of chunkIds) {
    try {
      const rows = db.query("SELECT surface_id FROM retrieval_surfaces WHERE chunk_id=?").all(chunkId) as { surface_id: number }[];
      for (const { surface_id } of rows) {
        try { db.query("DELETE FROM retrieval_surfaces_fts WHERE rowid=?").run(surface_id); } catch {}
        try { db.query("DELETE FROM retrieval_surface_vectors WHERE surface_id=?").run(surface_id); } catch {}
      }
      db.query("DELETE FROM retrieval_surfaces WHERE chunk_id=?").run(chunkId);
    } catch {}
  }
}

export async function insertSurfaces(db: Database, vault: string, chunkId: number, surfaces: SurfaceRow[]): Promise<void> {
  if (!surfaces.length || !surfaceTableAvailable(db)) return;
  const insert = db.query("INSERT OR IGNORE INTO retrieval_surfaces(chunk_id,surface_kind,provenance,text,text_hash) VALUES(?,?,?,?,?)");
  const ftsInsert = db.query("INSERT OR IGNORE INTO retrieval_surfaces_fts(rowid,text) VALUES(?,?)");
  const lexicalKinds = new Set(["alias", "entity", "facet"]);
  const vectorKinds = new Set(["likely_query"]);
  for (const s of surfaces) {
    const hash = surfaceTextHash(s.text);
    if (lexicalKinds.has(s.kind) && surfaceFtsAvailable(db)) {
      try {
        const df = (db.query("SELECT COUNT(DISTINCT chunk_id) as c FROM retrieval_surfaces WHERE text_hash=?").get(hash) as any)?.c ?? 0;
        if (df > 8) continue;
      } catch {}
    }
    const res = insert.run(chunkId, s.kind, s.provenance, s.text, hash) as any;
    let surfaceId: number | null = null;
    if (Number(res.lastInsertRowid) > 0) surfaceId = Number(res.lastInsertRowid);
    else {
      const existing = db.query("SELECT surface_id FROM retrieval_surfaces WHERE chunk_id=? AND surface_kind=? AND text_hash=?").get(chunkId, s.kind, hash) as { surface_id: number } | null;
      if (!existing) continue;
      surfaceId = existing.surface_id;
    }
    if (lexicalKinds.has(s.kind) && surfaceFtsAvailable(db)) {
      try { ftsInsert.run(surfaceId, s.text); } catch {}
    }
  }
  const vecSurfaces = surfaces.filter((s) => vectorKinds.has(s.kind));
  if (vecSurfaces.length && surfaceVectorAvailable(db)) {
    const rows = db.query("SELECT surface_id, text FROM retrieval_surfaces WHERE chunk_id=? AND surface_kind='likely_query'").all(chunkId) as { surface_id: number; text: string }[];
    const missing = rows.filter((r) => {
      try { const c = db.query("SELECT count(*) as n FROM retrieval_surface_vectors WHERE surface_id=?").get(r.surface_id) as any; return Number(c.n) === 0; } catch { return true; }
    });
    if (missing.length) {
      try {
        const vectors = await embedTexts(vault, missing.map((r) => r.text));
        const vInsert = db.query("INSERT OR REPLACE INTO retrieval_surface_vectors(surface_id,embedding) VALUES(?,?)");
        for (let i = 0; i < missing.length; i++) vInsert.run(missing[i].surface_id, JSON.stringify(vectors[i]));
      } catch {}
    }
  }
}

export async function repairMissingSurfaceVectors(db: Database, vault: string): Promise<void> {
  if (!surfaceVectorAvailable(db) || !surfaceTableAvailable(db)) return;
  const missing = db.query(`
    SELECT s.surface_id, s.text FROM retrieval_surfaces s
    LEFT JOIN retrieval_surface_vectors v ON v.surface_id = s.surface_id
    WHERE s.surface_kind='likely_query' AND v.surface_id IS NULL
    ORDER BY s.surface_id
  `).all() as { surface_id: number; text: string }[];
  if (!missing.length) return;
  const insert = db.query("INSERT OR REPLACE INTO retrieval_surface_vectors(surface_id,embedding) VALUES(?,?)");
  try {
    for (let start = 0; start < missing.length; start += 32) {
      const batch = missing.slice(start, start + 32);
      const vectors = await embedTexts(vault, batch.map((r) => r.text));
      for (let i = 0; i < batch.length; i++) insert.run(batch[i].surface_id, JSON.stringify(vectors[i]));
    }
  } catch {}
}
