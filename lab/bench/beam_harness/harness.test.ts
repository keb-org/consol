import { describe, expect, test } from "bun:test";
import type { ChatMessage, GatewayConfig } from "./gateway";
import {
  CATS,
  compactPacket,
  mapWithConcurrency,
  officialCategoryScores,
  officialNonEventQuestionScore,
  rankTauB,
  runMemoryAgent,
  runQuestion,
  type Args,
} from "./run";
import { buildOfficialJudgePrompt } from "./prompts";
import { buildBeamNotes } from "./adapters/consol";
import {
  resolveSourceLabels,
  sourceMessageDocs,
  sourceMetrics,
  updateMetrics,
  type SourceLabels,
} from "./retrieval_ablation";
import type { BeamAdapter } from "./adapters/types";

const cfg: GatewayConfig = {
  baseUrl: "https://invalid.test/v1",
  apiKey: "unused",
  answerModel: "test",
  judgeModel: "test",
};

function args(overrides: Partial<Args> = {}): Args {
  return {
    dataset: "1M",
    chats: "1",
    adapter: "consol",
    concurrency: 10,
    chatConcurrency: 1,
    maxToolRounds: 1,
    toolBudgetBytes: 256,
    readBytes: 180,
    outDir: "unused",
    numericLedger: true,
    ...overrides,
  };
}

describe("official BEAM scoring helpers", () => {
  test("leaves official judge question placeholder unresolved", () => {
    const prompt = buildOfficialJudgePrompt("contains 42", "42");
    expect(prompt).toContain("<question>");
    expect(prompt).toContain("contains 42");
    expect(prompt).toContain("42");
  });

  test("truncates partial non-event rubric scores", () => {
    expect(officialNonEventQuestionScore([1, 0.5, 0])).toBe(1 / 3);
  });

  test("computes tau-b exact, reverse, and tied rankings", () => {
    expect(rankTauB([1, 2, 3], [1, 2, 3])).toBe(1);
    expect(rankTauB([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(rankTauB([1, 2, 3], [1, 2, 2])).toBeCloseTo(2 / Math.sqrt(6));
  });

  test("averages each category by chat, not question count", () => {
    const scores = officialCategoryScores({
      a: { abstention: 1 },
      b: { abstention: 0 },
    });
    expect(scores.abstention).toEqual({ score: 0.5, chats: 2 });
    for (const category of CATS.slice(1)) expect(scores[category]).toEqual({ score: 0, chats: 0 });
  });
});

describe("bounded tool conversation", () => {
  test("compact recall packet never exceeds byte ceiling", () => {
    const packet = { items: Array.from({ length: 30 }, (_, i) => ({ ref: `r${i}`, summary: "é".repeat(200) })) };
    const json = compactPacket(packet, 128);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(128);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("shares byte budget across parallel tool calls and finalizes same conversation", async () => {
    const calls: { messages: ChatMessage[]; opts: any }[] = [];
    let completionCall = 0;
    const completion: any = async (_cfg: any, _model: string, messages: ChatMessage[], opts: any) => {
      calls.push({ messages: structuredClone(messages), opts });
      completionCall++;
      if (completionCall === 1) {
        return {
          content: "",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "recall", arguments: '{"query":"first"}' } },
              { id: "b", type: "function", function: { name: "recall", arguments: '{"query":"second"}' } },
            ],
          },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      }
      return {
        content: "final answer",
        message: { role: "assistant", content: "final answer" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    };
    const adapter: BeamAdapter = {
      name: "fake",
      async ingestChat() { throw new Error("unused"); },
      async recall(query) {
        return { items: [{ ref: query, summary: "x".repeat(500) }] };
      },
    };

    const result = await runMemoryAgent(cfg, adapter, { db: {}, vaultRoot: "", agentRoot: "" }, "question", args(), completion);
    expect(result.answer).toBe("final answer");
    expect(result.recalls).toBe(2);
    expect(result.toolBytes).toBeLessThanOrEqual(256);
    const finalMessages = calls[1].messages;
    expect(finalMessages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(finalMessages.at(-1)?.content).toContain("Tool access ended");
    expect(calls[1].opts.tools).toBeUndefined();
    expect(calls[1].opts.toolChoice).toBeUndefined();
  });

  test("supports recall, read, narrower recall, read, then same-conversation answer", async () => {
    const calls: { messages: ChatMessage[]; opts: any }[] = [];
    const steps = [
      { name: "recall", arguments: '{"query":"broad topic"}' },
      { name: "read", arguments: '{"ref":"broad-ref"}' },
      { name: "recall", arguments: '{"query":"narrow date value"}' },
      { name: "read", arguments: '{"ref":"narrow-ref"}' },
    ];
    const completion: any = async (_cfg: any, _model: string, messages: ChatMessage[], opts: any) => {
      calls.push({ messages: structuredClone(messages), opts });
      const step = steps[calls.length - 1];
      if (step) return {
        content: "",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `tool-${calls.length}`, type: "function", function: step }],
        },
      };
      return { content: "final answer", message: { role: "assistant", content: "final answer" } };
    };
    const recalled: string[] = [];
    const read: string[] = [];
    const adapter: BeamAdapter = {
      name: "fake",
      async ingestChat() { throw new Error("unused"); },
      async recall(query) {
        recalled.push(query);
        return {
          items: [{
            ref: query === "broad topic" ? "broad-ref" : "narrow-ref",
            summary: `${query} descriptor`,
          }],
        };
      },
      async readRef(ref) {
        read.push(ref);
        return { text: `${ref} evidence`, docId: ref, done: true };
      },
    };

    const result = await runMemoryAgent(
      cfg,
      adapter,
      { db: {}, vaultRoot: "", agentRoot: "" },
      "question",
      args({ maxToolRounds: 4, toolBudgetBytes: 1024, readBytes: 128 }),
      completion,
    );

    expect(result.answer).toBe("final answer");
    expect(recalled).toEqual(["broad topic", "narrow date value"]);
    expect(read).toEqual(["broad-ref", "narrow-ref"]);
    expect(result.trace.map((entry) => entry.tool)).toEqual(["recall", "read", "recall", "read"]);
    expect(calls).toHaveLength(5);
    expect(calls[0].opts.toolChoice).toEqual({ type: "function", function: { name: "recall" } });
    expect(calls[1].opts.toolChoice).toBe("auto");
    expect(calls[4].opts.tools).toBeUndefined();
    expect(calls[4].opts.toolChoice).toBeUndefined();
    expect(calls[4].messages.filter((message) => message.role === "tool")).toHaveLength(4);
    expect(calls[4].messages.map((message) => message.content).join(" ")).toContain("broad-ref evidence");
    expect(calls[4].messages.map((message) => message.content).join(" ")).toContain("narrow-ref evidence");
  });

  test("keeps rubric, ideal response, and category outside memory agent", async () => {
    const seen: string[] = [];
    const memoryAgent: typeof runMemoryAgent = async (_cfg, _adapter, _rctx, question) => {
      seen.push(question);
      return {
        answer: "answer",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        trace: [],
        calls: 0,
        recalls: 0,
        reads: 0,
        toolBytes: 0,
      };
    };
    const adapter: BeamAdapter = {
      name: "fake",
      async ingestChat() { throw new Error("unused"); },
      async recall() { return { items: [] }; },
    };

    await runQuestion(
      cfg,
      adapter,
      { db: {}, vaultRoot: "", agentRoot: "", chatId: "1" },
      {
        category: "RUBRIC_CATEGORY_SENTINEL",
        q: "visible query",
        rubric: ["RUBRIC_SECRET_SENTINEL"],
        ideal: "IDEAL_SECRET_SENTINEL",
        index: 0,
      },
      args({ dryRun: true }),
      memoryAgent,
    );

    expect(seen).toEqual(["visible query"]);
  });

  test("shrinks read page while preserving returned cursor", async () => {
    let readBytes = 0;
    const adapter: BeamAdapter = {
      name: "fake",
      async ingestChat() { throw new Error("unused"); },
      async recall() { return { items: [] }; },
      async readRef(_ref, _cursor, _ctx, maxBytes) {
        readBytes = maxBytes;
        return { text: "é".repeat(maxBytes), docId: "d", done: false, cursor: `cursor-${maxBytes}` };
      },
    };
    let completionCall = 0;
    const completion: any = async (_cfg: any, _model: string, messages: ChatMessage[]) => {
      completionCall++;
      if (completionCall === 1) return {
        content: "",
        message: { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read", arguments: '{"ref":"ref"}' } }] },
      };
      const tool = messages.find((message) => message.role === "tool")!;
      const payload = JSON.parse(tool.content!);
      expect(payload.cursor).toBe(`cursor-${readBytes}`);
      expect(Buffer.byteLength(tool.content!, "utf8")).toBeLessThanOrEqual(256);
      return { content: "done", message: { role: "assistant", content: "done" } };
    };

    await runMemoryAgent(cfg, adapter, { db: {}, vaultRoot: "", agentRoot: "" }, "question", args(), completion);
    expect(readBytes).toBeLessThan(180);
  });
});

describe("BEAM source construction and retrieval diagnostics", () => {
  test("propagates only first-message anchor within each batch", () => {
    const pair = (id: number, content: string, time_anchor?: string) => [
      { id, role: "user", content, ...(time_anchor ? { time_anchor } : {}) },
      { id: id + 1, role: "assistant", content: `${content} answer` },
    ];
    const notes = buildBeamNotes([
      {
        time_anchor: null,
        turns: [
          pair(1, "batch one first", "March-01-2024"),
          pair(3, "batch one later"),
        ],
      },
      {
        time_anchor: null,
        turns: [
          pair(5, "batch two first", "March-12-2024"),
          pair(7, "batch two later"),
        ],
      },
      { time_anchor: null, turns: [pair(9, "undated batch")] },
    ], "1M", "fixture");

    expect(notes).toHaveLength(5);
    expect(notes[0]).toContain("[Date: March-01-2024] USER: batch one first");
    expect(notes[1]).toContain("[Date: March-01-2024] USER: batch one later");
    expect(notes[2]).toContain("[Date: March-12-2024] USER: batch two first");
    expect(notes[3]).toContain("[Date: March-12-2024] USER: batch two later");
    expect(notes[4]).not.toContain("[Date:");
  });

  test("maps raw message IDs to adapter-equivalent note IDs", () => {
    const mapped = sourceMessageDocs([
      {
        turns: [[
          { id: 0, role: "assistant", content: "orphan" },
          { id: 1, role: "user", content: "one" },
          { id: 2, role: "assistant", content: "answer" },
        ], [
          { id: 3, role: "user", content: "unanswered" },
          { id: 4, role: "user", content: "next" },
          { id: 5, role: "assistant", content: "next answer" },
        ]],
      },
    ], "1M", "7");

    expect(mapped.noteCount).toBe(3);
    expect(Object.fromEntries(mapped.docs)).toEqual({
      "1": "beam-1m-7-00000",
      "2": "beam-1m-7-00000",
      "3": "beam-1m-7-00001",
      "4": "beam-1m-7-00002",
      "5": "beam-1m-7-00002",
    });
  });

  test("rejects absent, empty, and unmapped source-label groups distinctly", () => {
    const docs = new Map([["1", "a"], ["2", "b"]]);
    expect(resolveSourceLabels(undefined, docs).reason).toBe("no-labels");
    expect(resolveSourceLabels({ original_info: [], updated_info: [2] }, docs).reason).toBe("empty-group");
    const missing = resolveSourceLabels({ original_info: [1], updated_info: [99] }, docs);
    expect(missing.reason).toBe("unmapped-source-id");
    expect(missing.missingSourceIds).toEqual([99]);
    expect(missing.complete).toBeFalse();

    const complete = resolveSourceLabels({ original_info: [1, 1], updated_info: [2] }, docs);
    expect(complete.complete).toBeTrue();
    expect(complete.expectedDocs).toEqual(["a", "b"]);
    expect(complete.groups).toEqual({ original_info: ["a"], updated_info: ["b"] });
  });

  test("scores ranked source documents without group-cardinality inflation", () => {
    expect(sourceMetrics(["b", "x", "a"], ["a", "b", "c", "b"])).toEqual({
      expectedDocs: 3,
      hitDocs: 2,
      hitAt1: true,
      hitAny: true,
      sourceRecall: 2 / 3,
      reciprocalRank: 1,
      firstRelevantRank: 1,
    });
  });

  test("distinguishes all knowledge-update retrieval states", () => {
    const labels: SourceLabels = {
      complete: true,
      expectedDocs: ["o1", "o2", "u"],
      groups: { original_info: ["o1", "o2"], updated_info: ["u"] },
      missingSourceIds: [],
    };
    const updatedOnly = updateMetrics(["u"], labels);
    expect(updatedOnly).toMatchObject({
      evaluable: true,
      originalDocs: 2,
      updatedDocs: 1,
      originalRank: null,
      updatedRank: 1,
      originalRetrieved: false,
      updatedRetrieved: true,
      bothRetained: false,
      currentStatePreferred: true,
      staleOnly: false,
      neitherRetrieved: false,
    });
    expect(updateMetrics(["o2"], labels)).toMatchObject({
      originalRank: 1,
      updatedRank: null,
      currentStatePreferred: false,
      staleOnly: true,
      neitherRetrieved: false,
    });
    expect(updateMetrics(["u", "o1"], labels)).toMatchObject({
      bothRetained: true,
      updatedDominatesWhenBoth: true,
      currentStatePreferred: true,
    });
    expect(updateMetrics(["o1", "u"], labels)).toMatchObject({
      bothRetained: true,
      updatedDominatesWhenBoth: false,
      currentStatePreferred: false,
    });
    expect(updateMetrics([], labels)).toMatchObject({
      updatedRetrieved: false,
      originalRetrieved: false,
      bothRetained: false,
      staleOnly: false,
      neitherRetrieved: true,
    });
  });
});

test("worker pool stops assigning new work after first failure", async () => {
  const started: number[] = [];
  await expect(mapWithConcurrency([0, 1, 2, 3], 1, async (item) => {
    started.push(item);
    if (item === 1) throw new Error("stop");
    return item;
  })).rejects.toThrow("stop");
  expect(started).toEqual([0, 1]);
});
