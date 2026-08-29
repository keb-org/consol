import { describe, expect, test } from "bun:test";
import {
  parseClaudeOutput,
  parseCodexOutput,
  parseEndpointOutput,
} from "../src/runners";

const proposal = {
  id: "skip-1",
  action: "skip" as const,
  sourceRefs: ["ev-1"],
  rationale: "No durable update.",
};

const envelope = JSON.stringify({ proposals: [proposal] });

describe("reflection runner parsers", () => {
  test("parses Claude JSON result envelope", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: envelope,
    });
    expect(parseClaudeOutput(output)).toEqual([proposal]);
  });

  test("parses Codex JSONL agent message", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: envelope },
      }),
    ].join("\n");
    expect(parseCodexOutput(output)).toEqual([proposal]);
  });

  test("parses endpoint chat completion envelope", () => {
    const output = {
      choices: [{ message: { content: envelope } }],
    };
    expect(parseEndpointOutput(output)).toEqual([proposal]);
  });

  test("rejects malformed runner output", () => {
    expect(() => parseClaudeOutput(JSON.stringify({ result: "{}" }))).toThrow("missing proposals");
    expect(() => parseCodexOutput(JSON.stringify({ type: "done" }))).toThrow("missing proposal envelope");
    expect(() => parseEndpointOutput({ output: "not-json" })).toThrow();
  });
});
