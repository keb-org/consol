import { Database } from "bun:sqlite";
import path from "node:path";
import { existsSync } from "node:fs";
import { EMBED_DIMS, MODEL_DTYPE, MODEL_ID, MODEL_REVISION, vaultModelCache } from "../../core/config";
import { metaValue, setMeta, deleteMeta, vectorTableAvailable, vectorCount } from "./schema";

let embedder: any = null;
let embedderError: string | null = null;
let embedderLoading: Promise<any> | null = null;
let embedInvocationTail: Promise<void> = Promise.resolve();

export type VectorStatus = {
  available: boolean;
  indexed: number;
  reason?: string;
};

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
      throw new Error(`embed unavailable: ${embedderError} — category: out-of-bounds (model load failed: network/cache/timeout or incompatible env). Fix: check network/cache at ${cache}, retry; vector search will degrade gracefully while model is unavailable`);
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
      throw new Error("invalid embedding shape or values — category: type error (embedder returned wrong count/dims or non-finite values; expected 384-d finite vectors). Fix: retry embedding; if persistent, re-download model cache or check transformer version");
    }
    return vectors;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    embedderError = message;
    const wrapped = message.startsWith("embed unavailable") ? message : `embed unavailable: ${message}`;
    throw new Error(wrapped.includes("category:") ? wrapped : `${wrapped} — category: out-of-bounds (embedding failed: network/cache/timeout or incompatible env). Fix: check network/cache, retry; vector search degrades gracefully while model is unavailable`);
  }
}

export function setEmbedderForTests(fn: any, vault: string) {
  embedder = fn;
  embedderError = null;
  embedderLoading = null;
}

export async function repairMissingVectors(db: Database, vault: string) {
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

export function refreshVectorMeta(db: Database) {
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
