import { describe, test, expect } from "bun:test";
import { validateProposal } from "../src/reflection";
import { hashContent } from "../src/vault";

describe("reflection validation", () => {
  test("rejects missing rationale", () => {
    const r = validateProposal({ id: "p1", action: "create", sourceRefs: ["s1"], after: "x", rationale: "" } as any, "/tmp");
    expect(r.ok).toBe(false);
  });
  test("rejects stale baseHash", () => {
    const before = "original";
    const r = validateProposal({ id: "p1", action: "update", rationale: "r", sourceRefs: ["s1"], before, baseHash: "bad", after: "new" } as any, "/tmp");
    expect(r.ok).toBe(false);
  });
  test("accepts valid proposal", () => {
    const before = "original";
    const r = validateProposal({ id: "p1", action: "update", rationale: "fix scope", sourceRefs: ["s1"], before, baseHash: hashContent(before), after: "new content" } as any, "/tmp");
    expect(r.ok).toBe(true);
  });
  test("retrieval alone is not a source", () => {
    const r = validateProposal({ id: "p1", action: "create", rationale: "r", sourceRefs: ["s1"], targetId: "s1", after: "r" } as any, "/tmp");
    expect(r.ok).toBe(false);
  });
});
