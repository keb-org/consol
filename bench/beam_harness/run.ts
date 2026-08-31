#!/usr/bin/env bun
// Can't-cheat BEAM harness v3 — real memory-tool agent loop + bounded parallel runner.
//
// Adapter sees only chat at ingest and query/tool args at retrieval. Never rubric/ideal.
// Agent sees only system retrieval rule + query + recall/read tools. No preloaded context.
// Same agent conversation produces final answer after tool use; no duplicate answer call.
// Judge remains independent; official prompt receives rubric item + answer and leaves <question> literal.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildAnswerPrompt, buildOfficialJudgePrompt, answer_generation_for_rag, unified_llm_judge_base_prompt } from "./prompts";
import {
  resolveGatewayConfig,
  chatCompletion,
  configureGatewayConcurrency,
  judgeOnce,
  type ChatMessage,
  type GatewayConfig,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from "./gateway";
import type { BeamAdapter } from "./adapters/types";
import { makeConsolAdapter } from "./adapters/consol";

const BEAM_ROOT = path.resolve(import.meta.dir, "../../.research/BEAM/chats");
export const CATS = [
  "abstention", "contradiction_resolution", "event_ordering", "information_extraction", "instruction_following",
  "knowledge_update", "multi_session_reasoning", "preference_following", "summarization", "temporal_reasoning",
] as const;

export type Args = {
  dataset: "1M" | "10M";
  chats: string;
  adapter: string;
  concurrency: number;       // global gateway request cap; use 10 or 20
  chatConcurrency: number;   // parallel chat ingestion/eval jobs
  maxToolRounds: number;     // agent tool-call rounds per question
  toolBudgetBytes: number;   // total tool-result payload budget per question
  readBytes: number;         // one read page
  outDir: string;
  model?: string;
  singleStep?: boolean;      // honest ablation: recall descriptors then answer
  dryRun?: boolean;
  numericLedger: boolean;
  limitQuestions?: number;   // smoke/debug only; visible in run header
};

function parseArgs(): Args {
  const raw = Object.fromEntries(process.argv.slice(2).map((s) => {
    const i = s.indexOf("=");
    if (s.startsWith("--") && i > 2) return [s.slice(2, i), s.slice(i + 1)] as const;
    return [s.replace(/^--/, ""), "1"] as const;
  }));
  return {
    dataset: (raw.dataset || "1M") as "1M" | "10M",
    chats: raw.chats || "1",
    adapter: raw.adapter || "consol",
    concurrency: Number(raw.concurrency || 10),
    chatConcurrency: Number(raw.chatConcurrency || 2),
    maxToolRounds: Number(raw.maxToolRounds || 4),
    toolBudgetBytes: Number(raw.toolBudgetBytes || 28000),
    readBytes: Number(raw.readBytes || 1800),
    outDir: raw.outDir || path.resolve(import.meta.dir, "../../bench/beam_harness/out"),
    model: raw.model,
    singleStep: raw["single-step"] === "1" || raw.singleStep === "1",
    dryRun: raw["dry-run"] === "1" || raw.dryRun === "1",
    numericLedger: raw.numericLedger !== "0",
    limitQuestions: raw.limitQuestions ? Number(raw.limitQuestions) : undefined,
  };
}

function hashFile(file: string, length = 16) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, length);
}

function listChatIds(dataset: "1M" | "10M", spec: string) {
  const base = path.join(BEAM_ROOT, dataset);
  const all = fs.readdirSync(base)
    .filter((name) => /^\d+$/.test(name) && fs.existsSync(path.join(base, name, "chat.json")))
    .sort((a, b) => Number(a) - Number(b));
  if (spec === "all") return all;
  const wanted = new Set(spec.split(",").map((s) => s.trim()).filter(Boolean));
  return all.filter((id) => wanted.has(id));
}

function loadJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
  return out;
}

function addUsage(total: TokenUsage, usage?: TokenUsage) {
  if (!usage) return;
  total.prompt_tokens += usage.prompt_tokens || 0;
  total.completion_tokens += usage.completion_tokens || 0;
  total.total_tokens += usage.total_tokens || 0;
}

const MEMORY_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "recall",
      description: "Search memory. Call initially and again with a narrower query when another entity, date, value, or subtopic remains unresolved. Returns compact descriptors with opaque refs.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Specific memory search query" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read full evidence behind one ref returned by recall. Read every plausible descriptor before answering.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Opaque ref from recall" },
          cursor: { type: "string", description: "Cursor from an incomplete prior read of this ref" },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  },
];

const AGENT_SYSTEM = `Answer the user's question using only memory tools and their results. Start with recall. Recall returns compact descriptors, not evidence: read every plausible ref before answering. Recall again with narrower terms for unresolved entities, dates, values, or subtopics. Stop when evidence is sufficient or memory clearly has none. Be direct and concise; output only the answer. Never use outside knowledge.`;

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitJson(value: unknown, maxBytes: number) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return json;
  if (maxBytes >= 2) return "{}";
  throw new Error(`tool result budget ${maxBytes} cannot hold valid JSON`);
}

export function compactPacket(packet: any, maxBytes: number) {
  const out: any = {
    items: (packet.items ?? []).map((item: any) => ({ ref: item.ref, summary: item.summary, ...(item.section ? { section: item.section } : {}) })).slice(0, 30),
  };
  while (out.items.length && jsonBytes(out) > maxBytes) out.items.pop();
  return fitJson(out, maxBytes);
}

function readResult(page: NonNullable<Awaited<ReturnType<NonNullable<BeamAdapter["readRef"]>>>>) {
  return {
    text: page.text,
    ...(page.section ? { section: page.section } : {}),
    done: page.done,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

async function readWithinBudget(
  adapter: BeamAdapter,
  ref: string,
  cursor: string | undefined,
  rctx: { db: any; vaultRoot: string; agentRoot: string },
  maxPageBytes: number,
  maxResultBytes: number,
) {
  let pageBytes = Math.min(maxPageBytes, maxResultBytes);
  while (pageBytes >= 1) {
    const page = await adapter.readRef?.(ref, cursor, rctx, pageBytes);
    if (!page) return { page: null, result: fitJson({ error: "invalid or stale ref/cursor" }, maxResultBytes) };
    const value = readResult(page);
    if (jsonBytes(value) <= maxResultBytes) return { page, result: JSON.stringify(value) };
    pageBytes = Math.min(pageBytes - 1, Math.floor(pageBytes * 0.75));
  }
  return { page: null, result: fitJson({}, maxResultBytes) };
}

function parseToolArgs(call: ToolCall) {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type AgentRun = {
  answer: string;
  usage: TokenUsage;
  trace: any[];
  calls: number;
  recalls: number;
  reads: number;
  toolBytes: number;
};

export async function runMemoryAgent(
  cfg: GatewayConfig,
  adapter: BeamAdapter,
  rctx: { db: any; vaultRoot: string; agentRoot: string },
  question: string,
  args: Args,
  completion: typeof chatCompletion = chatCompletion,
): Promise<AgentRun> {
  const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const trace: any[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: question },
  ];
  let calls = 0, recalls = 0, reads = 0, toolBytes = 0;

  if (args.singleStep || args.dryRun) {
    const packet = await adapter.recall(question, rctx);
    recalls++;
    const context = compactPacket(packet, args.toolBudgetBytes);
    toolBytes = Buffer.byteLength(context, "utf8");
    if (args.dryRun) return { answer: context, usage, trace: [{ action: "recall", query: question }], calls, recalls, reads, toolBytes };
    const prompt = buildAnswerPrompt(context, question);
    const res = await completion(cfg, cfg.answerModel, [{ role: "user", content: prompt }], { maxTokens: 700, label: "single-step-answer" });
    addUsage(usage, res.usage);
    return { answer: res.content.trim(), usage, trace: [{ action: "recall", query: question }], calls: 1, recalls, reads, toolBytes };
  }

  for (let round = 0; round < args.maxToolRounds; round++) {
    const response = await completion(cfg, cfg.answerModel, messages, {
      maxTokens: 700,
      tools: MEMORY_TOOLS,
      toolChoice: round === 0 ? { type: "function", function: { name: "recall" } } : "auto",
      label: `memory-agent:${round + 1}`,
    });
    calls++;
    addUsage(usage, response.usage);
    messages.push(response.message);

    const toolCalls = response.message.tool_calls ?? [];
    if (!toolCalls.length) {
      return { answer: response.content.trim(), usage, trace, calls, recalls, reads, toolBytes };
    }

    const roundBudget = args.toolBudgetBytes - toolBytes;
    if (roundBudget < toolCalls.length * 2) {
      throw new Error(`${toolCalls.length} tool calls cannot fit ${roundBudget}-byte remaining budget`);
    }
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const call = toolCalls[callIndex];
      const params = parseToolArgs(call);
      const siblingsLeft = toolCalls.length - callIndex;
      const allocation = Math.floor((args.toolBudgetBytes - toolBytes) / siblingsLeft);
      let result: string;
      if (call.function.name === "recall") {
        const query = typeof params.query === "string" && params.query.trim() ? params.query.trim() : question;
        const packet = await adapter.recall(query, rctx);
        recalls++;
        result = compactPacket(packet, allocation);
        trace.push({ round: round + 1, tool: "recall", query, returned: packet.items?.length ?? 0, bytes: Buffer.byteLength(result, "utf8") });
      } else if (call.function.name === "read") {
        const ref = typeof params.ref === "string" ? params.ref : "";
        const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
        const fitted = ref
          ? await readWithinBudget(adapter, ref, cursor, rctx, args.readBytes, allocation)
          : { page: null, result: fitJson({ error: "invalid or stale ref/cursor" }, allocation) };
        reads++;
        result = fitted.result;
        trace.push({ round: round + 1, tool: "read", ok: Boolean(fitted.page?.text), continued: Boolean(cursor), done: fitted.page?.done, bytes: Buffer.byteLength(result, "utf8") });
      } else {
        result = fitJson({ error: "unknown tool" }, allocation);
      }

      toolBytes += Buffer.byteLength(result, "utf8");
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    if (toolBytes >= args.toolBudgetBytes) break;
  }

  // Tool rounds exhausted: same conversation, tools disabled, one final concise answer.
  messages.push({ role: "system", content: "Tool access ended. Answer now using only memory evidence already returned. If evidence is absent, say so directly." });
  const final = await completion(cfg, cfg.answerModel, messages, { maxTokens: 700, label: "memory-agent:final" });
  calls++;
  addUsage(usage, final.usage);
  return { answer: final.content.trim(), usage, trace, calls, recalls, reads, toolBytes };
}

export function rankTauB(referenceRanks: number[], systemRanks: number[]) {
  let concordant = 0, discordant = 0, tiesReference = 0, tiesSystem = 0;
  for (let i = 0; i < referenceRanks.length; i++) for (let j = i + 1; j < referenceRanks.length; j++) {
    const a = Math.sign(referenceRanks[i] - referenceRanks[j]);
    const b = Math.sign(systemRanks[i] - systemRanks[j]);
    if (a === 0 && b !== 0) tiesReference++;
    else if (b === 0 && a !== 0) tiesSystem++;
    else if (a * b > 0) concordant++;
    else if (a * b < 0) discordant++;
  }
  const denominator = Math.sqrt((concordant + discordant + tiesReference) * (concordant + discordant + tiesSystem));
  return denominator ? (concordant - discordant) / denominator : 0;
}

async function officialEventOrderingScore(cfg: GatewayConfig, rubric: string[], answer: string, usage: TokenUsage) {
  const system = answer.split("\n");
  const used = new Set<number>();
  const aligned: string[] = [];
  for (const line of system) {
    let match = -1;
    for (let i = 0; i < rubric.length; i++) {
      if (used.has(i)) continue;
      const prompt = `First snippet: ${rubric[i]} \n\n                       Second snippet: ${line}\n                    `;
      const result = await chatCompletion(cfg, cfg.judgeModel, [
        { role: "system", content: `
            You are a binary classifier.
            If the TWO snippets describe the SAME event/fact, reply **YES**
            Otherwise reply **NO**. No extra words.
            DO NOT provide any exaplanation.
        ` },
        { role: "user", content: prompt },
      ], { maxTokens: 8, label: "event-equivalence" });
      addUsage(usage, result.usage);
      if (result.content.toLowerCase().includes("yes")) { match = i; break; }
    }
    if (match >= 0) { used.add(match); aligned.push(rubric[match]); }
    else aligned.push(line);
  }
  const union = [...new Set([...rubric, ...aligned])];
  const tieRank = union.length + 1;
  const toRanks = (items: string[]) => {
    const ranks = new Map(items.map((item, i) => [item, i + 1]));
    return union.map((item) => ranks.get(item) ?? tieRank);
  };
  const tau = rankTauB(toRanks(rubric), toRanks(aligned));
  return (tau + 1) / 2;
}

export function officialNonEventQuestionScore(scores: number[]) {
  return scores.length ? scores.reduce((sum, score) => sum + Math.trunc(score), 0) / scores.length : 0;
}

export function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function officialCategoryScores(chatScores: Record<string, Partial<Record<(typeof CATS)[number], number>>>) {
  return Object.fromEntries(CATS.map((category) => {
    const values = Object.values(chatScores).flatMap((scores) => scores[category] === undefined ? [] : [scores[category]]);
    return [category, { score: mean(values), chats: values.length }];
  }));
}

function keywordScore(answer: string, rubric: string[]) {
  const stop = new Set(["should","contain","mention","state","the","and","for","with","that","have","you","also","your","from","into","been","being","this","these","about","over","there","what","which","when","where","how","will","would","could","might","response","llm","based","provided","chat","information","related"]);
  let sum = 0;
  for (const item of rubric) {
    const keys = item.replace(/^llm response should (?:state|contain|mention):\s*/i, "").replace(/[^a-z0-9 ]/gi, " ").toLowerCase().split(/\s+/).filter((word) => word.length > 3 && !stop.has(word));
    if (!keys.length) { sum++; continue; }
    const ratio = keys.filter((key) => answer.toLowerCase().includes(key)).length / keys.length;
    sum += ratio >= 0.5 ? 1 : ratio >= 0.3 ? 0.5 : 0;
  }
  return rubric.length ? sum / rubric.length : 1;
}

export async function runQuestion(
  cfg: GatewayConfig,
  adapter: BeamAdapter,
  rctx: { db: any; vaultRoot: string; agentRoot: string; chatId: string },
  question: { category: string; q: string; rubric: string[]; ideal?: string; index: number },
  args: Args,
  memoryAgent: typeof runMemoryAgent = runMemoryAgent,
) {
  const agent = await memoryAgent(cfg, adapter, rctx, question.q, args);
  const scores: number[] = [];
  const reasons: string[] = [];
  const raw: string[] = [];
  const judgeUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let tauNorm: number | undefined;
  if (args.dryRun) {
    for (const item of question.rubric) {
      scores.push(keywordScore(agent.answer, [item]));
      reasons.push("dry-run keyword score");
      raw.push("");
    }
  } else if (question.category === "event_ordering") {
    tauNorm = await officialEventOrderingScore(cfg, question.rubric, agent.answer, judgeUsage);
  } else {
    // Official BEAM leaves <question> unresolved in the judge prompt.
    const judged = await Promise.all(question.rubric.map((item) => judgeOnce(cfg, buildOfficialJudgePrompt(item, agent.answer))));
    for (const result of judged) {
      scores.push(result.score);
      reasons.push(result.reason);
      raw.push(result.raw);
      addUsage(judgeUsage, result.usage);
    }
  }

  const llmJudgeScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const qScore = args.dryRun
    ? llmJudgeScore ?? 0
    : question.category === "event_ordering"
      ? tauNorm ?? 0
      : officialNonEventQuestionScore(scores);
  return {
    kind: "question",
    chatId: rctx.chatId,
    category: question.category,
    qIdx: question.index,
    question: question.q,
    rubric: question.rubric,
    ideal_response: question.ideal,
    agent: { calls: agent.calls, recalls: agent.recalls, reads: agent.reads, toolBytes: agent.toolBytes, usage: agent.usage, trace: agent.trace },
    answer: agent.answer,
    rubricScores: scores,
    llmJudgeScore,
    tauNorm,
    qScore,
    kwScore: keywordScore(agent.answer, question.rubric),
    judgeReasons: reasons,
    judgeRaw: raw,
    judgeUsage,
  };
}

export async function main() {
  const args = parseArgs();
  if (args.dataset !== "1M" && args.dataset !== "10M") throw new Error("--dataset must be 1M or 10M");
  if (args.adapter !== "consol") throw new Error("--adapter must be consol");
  if (!Number.isSafeInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 100) throw new Error("--concurrency must be 1..100");
  if (!Number.isSafeInteger(args.chatConcurrency) || args.chatConcurrency < 1 || args.chatConcurrency > 20) throw new Error("--chatConcurrency must be 1..20");
  if (!Number.isSafeInteger(args.maxToolRounds) || args.maxToolRounds < 1 || args.maxToolRounds > 100) throw new Error("--maxToolRounds must be 1..100");
  if (!Number.isSafeInteger(args.toolBudgetBytes) || args.toolBudgetBytes < 256 || args.toolBudgetBytes > 1_000_000) throw new Error("--toolBudgetBytes must be 256..1000000");
  if (!Number.isSafeInteger(args.readBytes) || args.readBytes < 1 || args.readBytes > 1_000_000) throw new Error("--readBytes must be 1..1000000");
  if (args.limitQuestions !== undefined && (!Number.isSafeInteger(args.limitQuestions) || args.limitQuestions < 1)) throw new Error("--limitQuestions must be a positive integer");
  configureGatewayConcurrency(args.concurrency);

  const cfg: GatewayConfig = args.dryRun
    ? { baseUrl: "https://dryrun.invalid", apiKey: "dryrun", answerModel: "dryrun", judgeModel: "dryrun" }
    : resolveGatewayConfig();
  if (args.model) cfg.answerModel = cfg.judgeModel = args.model;

  const files = ["prompts.ts", "gateway.ts", "run.ts", "adapters/types.ts", "adapters/consol.ts"].map((name) => path.join(import.meta.dir, name));
  const harnessHash = files.map((file) => hashFile(file)).join("|");
  const answerPromptHash = crypto.createHash("sha256").update(answer_generation_for_rag).digest("hex").slice(0, 16);
  const judgePromptHash = crypto.createHash("sha256").update(unified_llm_judge_base_prompt).digest("hex").slice(0, 16);
  const chatIds = listChatIds(args.dataset, args.chats);
  if (!chatIds.length) throw new Error(`no chats for dataset=${args.dataset} chats=${args.chats}`);

  fs.mkdirSync(args.outDir, { recursive: true });
  const runId = `${args.dataset}-${args.chats === "all" ? "all" : chatIds.join(",")}-${Date.now().toString(36)}`;
  const logPath = path.join(args.outDir, `run-${runId}.jsonl`);
  const summaryPath = path.join(args.outDir, `summary-${runId}.json`);
  const appendLog = (record: unknown) => fs.appendFileSync(logPath, JSON.stringify(record) + "\n");

  appendLog({
    kind: "run_header", at: new Date().toISOString(), dataset: args.dataset, chatIds,
    mode: args.dryRun ? "dry-run" : args.singleStep ? "single-step" : "memory-tool-agent",
    gateway: { baseUrl: cfg.baseUrl, answerModel: cfg.answerModel, judgeModel: cfg.judgeModel },
    comparator: { officialJudgeModel: "gpt-4.1-mini", judgeModelMatchesOfficial: cfg.judgeModel === "gpt-4.1-mini" },
    harnessHash, answerPromptHash, judgePromptHash, args, cats: CATS,
  });

  const adapter = makeConsolAdapter(`consol-${args.dataset}`, { numericLedger: args.numericLedger });
  const totals = { questions: 0, rubricItems: 0, score: 0, agentUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, judgeUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, recalls: 0, reads: 0, toolBytes: 0 };
  const questionCategories: Record<string, { sum: number; n: number }> = Object.fromEntries(CATS.map((cat) => [cat, { sum: 0, n: 0 }]));
  const chatCategoryScores: Record<string, Partial<Record<(typeof CATS)[number], number>>> = {};
  const chatQuestionCounts: Record<string, Partial<Record<(typeof CATS)[number], number>>> = {};

  async function runChat(chatId: string) {
    const chatPath = path.join(BEAM_ROOT, args.dataset, chatId, "chat.json");
    const chatJson = loadJson(chatPath);
    const sourceHash = hashFile(chatPath, 64);
    const probing = loadJson(path.join(BEAM_ROOT, args.dataset, chatId, "probing_questions", "probing_questions.json"));
    const allQuestions: { category: string; q: string; rubric: string[]; ideal?: string; index: number }[] = [];
    for (const category of CATS) for (const row of probing[category] ?? []) {
      allQuestions.push({ category, q: String(row.question), rubric: row.rubric ?? [], ideal: row.ideal_response, index: allQuestions.length });
    }
    const questions = args.limitQuestions ? allQuestions.slice(0, args.limitQuestions) : allQuestions;

    const started = Date.now();
    let rctx: { db: any; vaultRoot: string; agentRoot: string; chatId: string } | undefined;
    try {
      const cacheRoot = path.join(import.meta.dir, ".cache");
      const { agentRoot, db } = await adapter.ingestChat(chatJson, {
        vaultRoot: cacheRoot,
        tmpDir: "",
        dataset: args.dataset,
        chatId,
        sourceHash,
      });
      const vaultRoot = (db as any).__vaultRoot || "";
      appendLog({
        kind: "ingest",
        chatId,
        ingestMs: Date.now() - started,
        cacheHit: Boolean((db as any).__cacheHit),
        chunks: (db.query("SELECT count(*) AS n FROM chunks").get() as any)?.n,
      });
      rctx = { db, vaultRoot, agentRoot, chatId };

      // Gateway semaphore controls global network fanout. This pool controls local question work.
      const results = await mapWithConcurrency(questions, args.concurrency, (question) => runQuestion(cfg, adapter, rctx!, question, args));
      const perChat = Object.fromEntries(CATS.map((category) => {
        const records = results.filter((record) => record.category === category);
        return [category, records.length ? mean(records.map((record) => record.qScore)) : undefined];
      })) as Partial<Record<(typeof CATS)[number], number>>;
      chatCategoryScores[chatId] = perChat;
      chatQuestionCounts[chatId] = Object.fromEntries(CATS.map((category) => [category, results.filter((record) => record.category === category).length]));
      for (const record of results) {
        appendLog(record);
        totals.questions++;
        totals.rubricItems += record.rubric.length || 1;
        totals.score += record.qScore;
        totals.recalls += record.agent.recalls;
        totals.reads += record.agent.reads;
        totals.toolBytes += record.agent.toolBytes;
        addUsage(totals.agentUsage, record.agent.usage);
        addUsage(totals.judgeUsage, record.judgeUsage);
        questionCategories[record.category].sum += record.qScore;
        questionCategories[record.category].n++;
      }
      console.log(`[harness] chat ${chatId} done — ${results.length} questions — running ${(totals.score / Math.max(1, totals.questions)).toFixed(3)}`);
    } finally {
      if (rctx) await adapter.close?.(rctx);
    }
  }

  await mapWithConcurrency(chatIds, args.chatConcurrency, (chatId) => runChat(chatId));

  const beamCategoryScores = officialCategoryScores(chatCategoryScores);
  const reportedCategories = Object.values(beamCategoryScores).filter((value) => value.chats > 0);
  const summary = {
    kind: "summary", at: new Date().toISOString(), dataset: args.dataset, chatIds,
    mode: args.dryRun ? "dry-run" : args.singleStep ? "single-step" : "memory-tool-agent",
    gateway: { baseUrl: cfg.baseUrl, answerModel: cfg.answerModel, judgeModel: cfg.judgeModel },
    comparator: {
      officialJudgeModel: "gpt-4.1-mini",
      judgeModelMatchesOfficial: cfg.judgeModel === "gpt-4.1-mini",
      scoringMatchesOfficialCode: !args.dryRun,
      aggregation: "mean questions within each chat/category, then mean chats per category",
      scalarOverallIsOfficial: false,
    },
    harnessHash, answerPromptHash, judgePromptHash,
    totals,
    beamCategoryScores,
    perChat: Object.fromEntries(chatIds.map((chatId) => [chatId, {
      categoryScores: chatCategoryScores[chatId],
      questionCounts: chatQuestionCounts[chatId],
    }])),
    nonOfficialDiagnostics: {
      questionWeightedMacro: totals.questions ? totals.score / totals.questions : 0,
      categoryMacro: mean(reportedCategories.map((value) => value.score)),
      questionWeightedCategories: Object.fromEntries(CATS.map((category) => [category, {
        score: questionCategories[category].n ? questionCategories[category].sum / questionCategories[category].n : 0,
        questions: questionCategories[category].n,
      }])),
    },
    logPath,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nlog: ${logPath}\nsummary: ${summaryPath}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
