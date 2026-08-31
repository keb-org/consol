#!/usr/bin/env bun
// Offline retrieval-only ablation. Dataset labels score packets after recall; labels never enter retrieval.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CATS, compactPacket, mapWithConcurrency, mean } from "./run";
import { makeConsolAdapter } from "./adapters/consol";
import type { AdapterPacket } from "./adapters/types";

const BEAM_ROOT = path.resolve(import.meta.dir, "../../.research/BEAM/chats");
const TOOL_BUDGET_BYTES = 28_000;

export type SourceLabels = {
  complete: boolean;
  expectedDocs: string[];
  groups: Record<string, string[]>;
  missingSourceIds: number[];
  reason?: "no-labels" | "empty-group" | "unmapped-source-id";
};

export type SourceMetrics = {
  expectedDocs: number;
  hitDocs: number;
  hitAt1: boolean;
  hitAny: boolean;
  sourceRecall: number;
  reciprocalRank: number;
  firstRelevantRank: number | null;
};

export type UpdateMetrics = {
  evaluable: boolean;
  originalDocs: number;
  updatedDocs: number;
  originalRank: number | null;
  updatedRank: number | null;
  originalRetrieved: boolean;
  updatedRetrieved: boolean;
  bothRetained: boolean;
  updatedDominatesWhenBoth: boolean;
  currentStatePreferred: boolean;
  staleOnly: boolean;
  neitherRetrieved: boolean;
};

type ConditionMetrics = {
  bytes: number;
  docs: string[];
  ledgerCandidates: number;
  source: SourceMetrics | null;
  update: UpdateMetrics;
};

type AblationRecord = {
  chatId: string;
  category: string;
  qIdx: number;
  question: string;
  ledgerTriggered: boolean;
  labels: SourceLabels;
  on: ConditionMetrics;
  off: ConditionMetrics;
};

function* batches(chatJson: any): Generator<any> {
  if (!Array.isArray(chatJson)) return;
  for (const entry of chatJson) {
    if (Array.isArray(entry?.turns)) {
      yield entry;
      continue;
    }
    for (const nested of Object.values(entry ?? {})) {
      if (!Array.isArray(nested)) continue;
      for (const batch of nested) if (Array.isArray(batch?.turns)) yield batch;
    }
  }
}

function* messages(chatJson: any): Generator<any> {
  for (const batch of batches(chatJson)) {
    for (const turn of batch.turns ?? []) {
      for (const message of turn ?? []) {
        if (message?.role && message?.content) yield message;
      }
    }
  }
}

// Mirrors adapter turn-pair construction. Every raw message ID maps to its generated canonical note.
export function sourceMessageDocs(chatJson: any, dataset: "1M" | "10M", chatId: string) {
  const docs = new Map<string, string>();
  let current: any | null = null;
  let note = 0;
  const add = (first: any, second: any | null) => {
    const docId = `beam-${dataset.toLowerCase()}-${chatId}-${String(note++).padStart(5, "0")}`;
    for (const message of [first, second]) {
      if (message?.id !== undefined && message?.id !== null) docs.set(String(message.id), docId);
    }
  };

  for (const message of messages(chatJson)) {
    if (!current) {
      if (message.role === "assistant") continue;
      current = message;
    } else if (message.role === "assistant") {
      add(current, message);
      current = null;
    } else {
      add(current, null);
      current = message;
    }
  }
  if (current) add(current, null);
  return { docs, noteCount: note };
}

function sourceIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(sourceIds);
  if (value && typeof value === "object") return Object.values(value).flatMap(sourceIds);
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) ? [id] : [];
}

export function resolveSourceLabels(value: unknown, sourceDocs: Map<string, string>): SourceLabels {
  const objectGroups = value && !Array.isArray(value) && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>)
    : [["all", value] as const];
  const groups: Record<string, string[]> = {};
  const missing = new Set<number>();
  let emptyGroup = false;

  for (const [name, raw] of objectGroups) {
    const ids = [...new Set(sourceIds(raw))];
    if (!ids.length) emptyGroup = true;
    groups[name] = [...new Set(ids.flatMap((id) => {
      const doc = sourceDocs.get(String(id));
      if (!doc) missing.add(id);
      return doc ? [doc] : [];
    }))];
  }

  const expectedDocs = [...new Set(Object.values(groups).flat())];
  const hasSourceIds = objectGroups.some(([, raw]) => sourceIds(raw).length > 0);
  const reason = !hasSourceIds
    ? "no-labels" as const
    : emptyGroup
      ? "empty-group" as const
      : missing.size
        ? "unmapped-source-id" as const
        : undefined;
  return {
    complete: reason === undefined,
    expectedDocs,
    groups,
    missingSourceIds: [...missing].sort((a, b) => a - b),
    ...(reason ? { reason } : {}),
  };
}

export function sourceMetrics(rankedDocs: string[], expectedDocs: string[]): SourceMetrics {
  const expected = new Set(expectedDocs);
  const hits = [...expected].filter((doc) => rankedDocs.includes(doc));
  const first = rankedDocs.findIndex((doc) => expected.has(doc));
  return {
    expectedDocs: expected.size,
    hitDocs: hits.length,
    hitAt1: first === 0,
    hitAny: first >= 0,
    sourceRecall: expected.size ? hits.length / expected.size : 0,
    reciprocalRank: first >= 0 ? 1 / (first + 1) : 0,
    firstRelevantRank: first >= 0 ? first + 1 : null,
  };
}

export function updateMetrics(rankedDocs: string[], labels: SourceLabels): UpdateMetrics {
  const original = labels.groups.original_info ?? [];
  const updated = labels.groups.updated_info ?? [];
  const rank = (docs: string[]) => {
    const set = new Set(docs);
    const index = rankedDocs.findIndex((doc) => set.has(doc));
    return index >= 0 ? index + 1 : null;
  };
  const originalRank = rank(original);
  const updatedRank = rank(updated);
  const evaluable = original.length > 0 && updated.length > 0;
  const originalRetrieved = evaluable && originalRank !== null;
  const updatedRetrieved = evaluable && updatedRank !== null;
  const bothRetained = originalRetrieved && updatedRetrieved;
  return {
    evaluable,
    originalDocs: original.length,
    updatedDocs: updated.length,
    originalRank,
    updatedRank,
    originalRetrieved,
    updatedRetrieved,
    bothRetained,
    updatedDominatesWhenBoth:
      originalRank !== null && updatedRank !== null && updatedRank < originalRank,
    currentStatePreferred:
      evaluable && updatedRank !== null && (originalRank === null || updatedRank < originalRank),
    staleOnly: originalRetrieved && !updatedRetrieved,
    neitherRetrieved: evaluable && !originalRetrieved && !updatedRetrieved,
  };
}

function docId(ref: string) {
  try {
    const payload = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
    return typeof payload?.d === "string" ? payload.d : null;
  } catch {
    return null;
  }
}

function rankedDocs(packet: AdapterPacket) {
  const seen = new Set<string>();
  return packet.items.flatMap((item) => {
    const doc = docId(item.ref);
    if (!doc || seen.has(doc)) return [];
    seen.add(doc);
    return [doc];
  });
}

function condition(packet: AdapterPacket, labels: SourceLabels): ConditionMetrics {
  const docs = rankedDocs(packet);
  return {
    bytes: Buffer.byteLength(compactPacket(packet, TOOL_BUDGET_BYTES), "utf8"),
    docs,
    ledgerCandidates: Number(packet.attribution?.ledgerCapped ?? 0),
    source: labels.complete ? sourceMetrics(docs, labels.expectedDocs) : null,
    update: updateMetrics(docs, labels),
  };
}

function aggregate(records: AblationRecord[], side: "on" | "off") {
  const labeled = records.flatMap((record) => record[side].source ? [record[side].source!] : []);
  const updates = records.map((record) => record[side].update).filter((metric) => metric.evaluable);
  const both = updates.filter((metric) => metric.bothRetained);
  const bytes = records.map((record) => record[side].bytes);
  return {
    questions: records.length,
    labeledQuestions: labeled.length,
    hitAt1: mean(labeled.map((metric) => Number(metric.hitAt1))),
    hitAny: mean(labeled.map((metric) => Number(metric.hitAny))),
    meanSourceRecall: mean(labeled.map((metric) => metric.sourceRecall)),
    mrr: mean(labeled.map((metric) => metric.reciprocalRank)),
    updatePairs: updates.length,
    updateOriginalRetrieved: mean(updates.map((metric) => Number(metric.originalRetrieved))),
    updateUpdatedRetrieved: mean(updates.map((metric) => Number(metric.updatedRetrieved))),
    updateBothRetained: mean(updates.map((metric) => Number(metric.bothRetained))),
    updateBothRetainedPairs: both.length,
    updatedDominatesWhenBoth: mean(both.map((metric) => Number(metric.updatedDominatesWhenBoth))),
    currentStatePreferred: mean(updates.map((metric) => Number(metric.currentStatePreferred))),
    staleOnly: mean(updates.map((metric) => Number(metric.staleOnly))),
    neitherRetrieved: mean(updates.map((metric) => Number(metric.neitherRetrieved))),
    meanOriginalGroupDocs: mean(updates.map((metric) => metric.originalDocs)),
    meanUpdatedGroupDocs: mean(updates.map((metric) => metric.updatedDocs)),
    meanPacketBytes: mean(bytes),
    totalPacketBytes: bytes.reduce((sum, value) => sum + value, 0),
  };
}

function delta(on: ReturnType<typeof aggregate>, off: ReturnType<typeof aggregate>) {
  return {
    hitAt1: on.hitAt1 - off.hitAt1,
    hitAny: on.hitAny - off.hitAny,
    meanSourceRecall: on.meanSourceRecall - off.meanSourceRecall,
    mrr: on.mrr - off.mrr,
    updateOriginalRetrieved: on.updateOriginalRetrieved - off.updateOriginalRetrieved,
    updateUpdatedRetrieved: on.updateUpdatedRetrieved - off.updateUpdatedRetrieved,
    updateBothRetained: on.updateBothRetained - off.updateBothRetained,
    updatedDominatesWhenBoth: on.updatedDominatesWhenBoth - off.updatedDominatesWhenBoth,
    currentStatePreferred: on.currentStatePreferred - off.currentStatePreferred,
    staleOnly: on.staleOnly - off.staleOnly,
    neitherRetrieved: on.neitherRetrieved - off.neitherRetrieved,
    meanPacketBytes: on.meanPacketBytes - off.meanPacketBytes,
    totalPacketBytes: on.totalPacketBytes - off.totalPacketBytes,
  };
}

function summarize(records: AblationRecord[]) {
  const summarizeGroup = (group: AblationRecord[]) => {
    const on = aggregate(group, "on");
    const off = aggregate(group, "off");
    return { on, off, delta: delta(on, off) };
  };
  const triggered = records.filter((record) => record.ledgerTriggered);
  return {
    coverage: {
      questions: records.length,
      labeledComplete: records.filter((record) => record.labels.complete).length,
      skippedLabels: Object.fromEntries(["no-labels", "empty-group", "unmapped-source-id"].map((reason) => [
        reason,
        records.filter((record) => record.labels.reason === reason).length,
      ])),
      ledgerTriggered: triggered.length,
      packetsChanged: records.filter((record) => record.on.docs.join("\0") !== record.off.docs.join("\0")).length,
    },
    all: summarizeGroup(records),
    ledgerTriggered: summarizeGroup(triggered),
    perChat: Object.fromEntries([...new Set(records.map((record) => record.chatId))].map((chatId) => {
      const group = records.filter((record) => record.chatId === chatId && record.ledgerTriggered);
      return [chatId, summarizeGroup(group)];
    })),
    perCategory: Object.fromEntries(CATS.map((category) => {
      const group = triggered.filter((record) => record.category === category);
      return [category, summarizeGroup(group)];
    })),
  };
}

function parseArgs() {
  const raw = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const index = arg.indexOf("=");
    return index > 2 ? [arg.slice(2, index), arg.slice(index + 1)] : [arg.replace(/^--/, ""), "1"];
  }));
  return {
    dataset: (raw.dataset || "1M") as "1M" | "10M",
    chats: (raw.chats || "1,2,3").split(",").map((chat) => chat.trim()).filter(Boolean),
    chatConcurrency: Number(raw.chatConcurrency || 2),
    questionConcurrency: Number(raw.questionConcurrency || 20),
    outDir: raw.outDir || path.join(import.meta.dir, "out"),
  };
}

async function main() {
  const args = parseArgs();
  if (!(["1M", "10M"] as string[]).includes(args.dataset)) throw new Error("--dataset must be 1M or 10M");
  if (!Number.isSafeInteger(args.chatConcurrency) || args.chatConcurrency < 1 || args.chatConcurrency > 20) throw new Error("--chatConcurrency must be 1..20");
  if (!Number.isSafeInteger(args.questionConcurrency) || args.questionConcurrency < 1 || args.questionConcurrency > 100) throw new Error("--questionConcurrency must be 1..100");

  const cacheRoot = path.join(import.meta.dir, ".cache");
  const onAdapter = makeConsolAdapter(`consol-${args.dataset}-ledger-on`, { numericLedger: true });
  const offAdapter = makeConsolAdapter(`consol-${args.dataset}-ledger-off`, { numericLedger: false });

  const perChat = await mapWithConcurrency(args.chats, args.chatConcurrency, async (chatId) => {
    const chatPath = path.join(BEAM_ROOT, args.dataset, chatId, "chat.json");
    const probingPath = path.join(BEAM_ROOT, args.dataset, chatId, "probing_questions", "probing_questions.json");
    const chatJson = JSON.parse(fs.readFileSync(chatPath, "utf8"));
    const probing = JSON.parse(fs.readFileSync(probingPath, "utf8"));
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(chatPath)).digest("hex");
    const mapping = sourceMessageDocs(chatJson, args.dataset, chatId);
    let rctx: { db: any; vaultRoot: string; agentRoot: string } | undefined;

    try {
      const { db, agentRoot } = await onAdapter.ingestChat(chatJson, {
        vaultRoot: cacheRoot,
        tmpDir: "",
        dataset: args.dataset,
        chatId,
        sourceHash,
      });
      rctx = { db, agentRoot, vaultRoot: db.__vaultRoot || cacheRoot };
      const indexed = new Set((db.query("SELECT DISTINCT doc_id FROM chunks").all() as { doc_id: string }[]).map((row) => row.doc_id));
      const missingDocs = [...new Set(mapping.docs.values())].filter((doc) => !indexed.has(doc));
      if (missingDocs.length || indexed.size !== mapping.noteCount) {
        throw new Error(`source map drift for chat ${chatId}: notes=${mapping.noteCount}, indexed=${indexed.size}, missing=${missingDocs.length}`);
      }

      const questions = CATS.flatMap((category) => (probing[category] ?? []).map((row: any, index: number) => ({ category, index, row })));
      return await mapWithConcurrency(questions, args.questionConcurrency, async ({ category, index, row }) => {
        const question = String(row.question);
        // Retrieval boundary receives question only. Source labels are resolved after both calls return.
        const [onPacket, offPacket] = await Promise.all([
          onAdapter.recall(question, rctx!),
          offAdapter.recall(question, rctx!),
        ]);
        const labels = resolveSourceLabels(row.source_chat_ids, mapping.docs);
        const on = condition(onPacket, labels);
        const off = condition(offPacket, labels);
        return {
          chatId,
          category,
          qIdx: index,
          question,
          ledgerTriggered: on.ledgerCandidates > 0,
          labels,
          on,
          off,
        } satisfies AblationRecord;
      });
    } finally {
      if (rctx) await onAdapter.close?.(rctx);
    }
  });

  const records = perChat.flat();
  const summary = {
    kind: "beam-retrieval-ablation",
    at: new Date().toISOString(),
    dataset: args.dataset,
    chats: args.chats,
    toolBudgetBytes: TOOL_BUDGET_BYTES,
    evaluationBoundary: "source_chat_ids score returned doc ranks offline; retrieval receives question only; no rubric, ideal, answer, or source labels enter recall",
    ...summarize(records),
    records,
  };
  fs.mkdirSync(args.outDir, { recursive: true });
  const out = path.join(args.outDir, `retrieval-ablation-${args.dataset}-${args.chats.join(",")}-${Date.now().toString(36)}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, records: undefined, out }, null, 2));
}

if (import.meta.main) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
