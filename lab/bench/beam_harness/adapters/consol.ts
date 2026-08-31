import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureVault, atomicWrite, frontmatter, withVaultLock } from "@/vault";
import { openIndex, rebuild, vectorStatus } from "@/index";
import { recall as consolRecall, readChunk } from "@/retrieval";
import { Budgets, indexFingerprint } from "@/config";
import type { BeamAdapter, AdapterPacket, AdapterRead } from "./types";

// Real-construction adapter — no dummy vectors, no role filtering, no 50-msg blobs.
// Per BEAM chat: one vault, one index. Facts keep their session date (section prefix)
// so temporal ranking and date-prefixed reranking have signal for free.

function validTimeAnchor(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function batchTimeAnchor(batch: any) {
  const direct = validTimeAnchor(batch?.time_anchor);
  if (direct) return direct;
  for (const turn of batch?.turns ?? []) {
    for (const message of turn ?? []) {
      if (message?.role && message?.content) return validTimeAnchor(message.time_anchor);
    }
  }
  return undefined;
}

function* iterBatches(chatJson: any): Generator<{ batch: any; timeAnchor?: string }> {
  if (!Array.isArray(chatJson)) return;
  for (const entry of chatJson) {
    if (Array.isArray(entry?.turns)) {
      yield { batch: entry, timeAnchor: batchTimeAnchor(entry) };
      continue;
    }
    for (const batches of Object.values(entry ?? {})) {
      if (!Array.isArray(batches)) continue;
      for (const batch of batches) {
        if (Array.isArray(batch?.turns)) yield { batch, timeAnchor: batchTimeAnchor(batch) };
      }
    }
  }
}

function* iterMessages(chatJson: any): Generator<{ msg: any; timeAnchor?: string; batchIdx: number; turnIdx: number }> {
  let batchIdx = 0;
  for (const { batch, timeAnchor } of iterBatches(chatJson)) {
    let turnIdx = 0;
    for (const turn of batch?.turns ?? []) {
      for (const msg of turn ?? []) {
        if (msg?.role && msg?.content) yield { msg, timeAnchor, batchIdx, turnIdx };
      }
      turnIdx++;
    }
    batchIdx++;
  }
}

const CACHE_MANIFEST = "beam-cache.json";
const ADAPTER_SOURCE_HASH = createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheFingerprint(chatJson: any, sourceHash?: string) {
  return {
    sourceHash: sourceHash ?? sha256(JSON.stringify(chatJson)),
    adapterSourceHash: ADAPTER_SOURCE_HASH,
    indexFingerprint: indexFingerprint(),
  };
}

function sameFingerprint(left: any, right: any) {
  return left?.sourceHash === right.sourceHash &&
    left?.adapterSourceHash === right.adapterSourceHash &&
    left?.indexFingerprint === right.indexFingerprint;
}

function count(db: any, table: string) {
  return Number((db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
}

function clearCanonicalAgentFiles(agentRoot: string) {
  const keep = new Set([".lock", "index.sqlite", "index.sqlite-shm", "index.sqlite-wal"]);
  for (const name of fs.readdirSync(agentRoot)) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(agentRoot, name), { recursive: true, force: true });
  }
}

function cacheIsComplete(db: any, agentRoot: string, expectedNotes: number) {
  const notes = fs.readdirSync(path.join(agentRoot, "memories"))
    .filter((name) => /^n\d{5}\.md$/.test(name));
  if (notes.length !== expectedNotes || count(db, "files") !== expectedNotes) return false;
  const chunks = count(db, "chunks");
  const vectors = vectorStatus(db);
  if (!chunks || !vectors.available || vectors.indexed !== chunks) return false;
  const check = db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
  return check ? Object.values(check)[0] === "ok" : false;
}

function cleanContent(raw: string): string {
  return String(raw || "").replace(/->->.*$/, "").trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on", "for", "with", "at", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them", "my", "your", "our", "their",
  "as", "so", "than", "too", "very", "can", "will", "just", "should", "now", "about", "into", "over", "under",
]);

function keywords(text: string, max = 6): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9._-]{2,}/g) ?? []) {
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

// One note per turn-pair: user question + assistant answer, date-anchored.
// Locally clustered (a coherent exchange), globally sparse (one fact per note).
function buildNote(m1: any, m2: any | null, timeAnchor: string | undefined, id: string): string {
  const date = timeAnchor ? `[Date: ${timeAnchor}] ` : "";
  const u = cleanContent(m1.content);
  const a = m2 ? cleanContent(m2.content) : "";
  const body = a ? `${date}USER: ${u}\n\nASSISTANT: ${a}` : `${date}${m1.role.toUpperCase()}: ${u}`;
  const kw = keywords(`${u} ${a}`.slice(0, 4000));
  const fm = frontmatter("memory", id, {
    status: "active",
    scope: kw.join(","),
  } as any);
  return fm + body + "\n";
}

export function buildBeamNotes(chatJson: any, dataset: "1M" | "10M", chatId: string) {
  let cur: { msg: any; timeAnchor?: string } | null = null;
  const notes: string[] = [];
  const addNote = (m1: any, m2: any | null, timeAnchor?: string) => {
    const id = `beam-${dataset.toLowerCase()}-${chatId}-${String(notes.length).padStart(5, "0")}`;
    notes.push(buildNote(m1, m2, timeAnchor, id));
  };
  for (const { msg, timeAnchor } of iterMessages(chatJson)) {
    if (!cur) {
      if (msg.role === "assistant") continue;
      cur = { msg, timeAnchor };
    } else if (msg.role === "assistant") {
      addNote(cur.msg, msg, cur.timeAnchor ?? timeAnchor);
      cur = null;
    } else {
      addNote(cur.msg, null, cur.timeAnchor);
      cur = { msg, timeAnchor };
    }
  }
  if (cur) addNote(cur.msg, null, cur.timeAnchor);
  return notes;
}

export function makeConsolAdapter(label = "consol-real", options: { numericLedger?: boolean } = {}): BeamAdapter {
  const budgets = Budgets.parse({ perArmCap: 60 });
  const owner = (ctx: { agentRoot: string }) => `agent:${path.basename(ctx.agentRoot)}`;
  return {
    name: label,

    async ingestChat(chatJson: any, ctx) {
      const temporary = !ctx.vaultRoot;
      const vaultRoot = ctx.vaultRoot || fs.mkdtempSync(path.join(os.tmpdir(), `beam-${ctx.dataset}-${ctx.chatId}-`));
      const agent = temporary ? "user" : `beam-${ctx.dataset.toLowerCase()}-${ctx.chatId}`;
      const notes = buildBeamNotes(chatJson, ctx.dataset, ctx.chatId);

      const fingerprint = cacheFingerprint(chatJson, ctx.sourceHash);
      let db: any;
      try {
        const { agentRoot } = await ensureVault(vaultRoot, agent);
        return await withVaultLock(agentRoot, async () => {
          const manifestPath = path.join(agentRoot, CACHE_MANIFEST);
          let manifest: any;
          try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")); } catch {}

          db = openIndex(agentRoot);
          if (!temporary && sameFingerprint(manifest, fingerprint) && cacheIsComplete(db, agentRoot, notes.length)) {
            db.__vaultRoot = vaultRoot;
            db.__cacheHit = true;
            db.__temporaryRoot = false;
            return { agentRoot, db };
          }

          clearCanonicalAgentFiles(agentRoot);
          const rebuilt = await ensureVault(vaultRoot, agent);
          for (let i = 0; i < notes.length; i++) {
            await atomicWrite(path.join(rebuilt.agentRoot, "memories", `n${String(i).padStart(5, "0")}.md`), notes[i]);
          }
          await rebuild(db, vaultRoot, rebuilt.agentRoot, agent);
          if (!cacheIsComplete(db, rebuilt.agentRoot, notes.length)) {
            throw new Error("BEAM cache build incomplete");
          }
          if (!temporary) {
            await atomicWrite(manifestPath, JSON.stringify({ ...fingerprint, notes: notes.length }));
          }
          db.__vaultRoot = vaultRoot;
          db.__cacheHit = false;
          db.__temporaryRoot = temporary;
          return { agentRoot: rebuilt.agentRoot, db };
        });
      } catch (error) {
        try { db?.close?.(); } catch {}
        if (temporary) {
          try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch {}
        }
        throw error;
      }
    },

    async recall(question: string, ctx): Promise<AdapterPacket> {
      const packet: any = await consolRecall(ctx.db, ctx.vaultRoot, question, budgets, owner(ctx), "auto", new Set(), options);
      return {
        items: (packet.items || []).map((it: any) => ({ ref: it.ref, summary: String(it.summary || ""), section: it.section })),
        attribution: packet.attribution,
        raw: { id: packet.id },
      };
    },

    async readRef(ref: string, cursor, ctx, maxBytes): Promise<AdapterRead> {
      try {
        const chunk = readChunk(ctx.db, ref, { ...budgets, l2Bytes: maxBytes }, cursor);
        return { text: chunk.text, docId: chunk.docId, section: chunk.section, done: chunk.done, cursor: chunk.cursor };
      } catch {
        return null; // stale ref etc. — agent loop treats as dead candidate
      }
    },

    async close(ctx) {
      const temporary = Boolean((ctx.db as any)?.__temporaryRoot);
      const root = (ctx.db as any)?.__vaultRoot || ctx.vaultRoot;
      try { ctx.db?.close?.(); } catch {}
      if (temporary) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      }
    },
  };
}
