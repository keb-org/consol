import { describe, test, expect } from "bun:test";
import { validateProposal } from "../src/reflection";

describe("memory lifecycle", () => {
  test("rejects secret in remember", async () => {
    const { remember } = await import("../src/memory");
    await expect(remember("/tmp/vault-test", "/tmp/vault-test/agents/a", "a", { statement: "key sk-123456789012345678901234567890" })).rejects.toThrow();
  });
  test("proposal validation requires sources", () => {
    const r = validateProposal({ id: "p1", action: "create", rationale: "because", sourceRefs: [], after: "new content" } as any, "/tmp");
    expect(r.ok).toBe(false);
  });
  test("proposal validation rejects secret", () => {
    const r = validateProposal({ id: "p1", action: "create", rationale: "r", sourceRefs: ["s1"], after: "contains sk-12345678901234567890" } as any, "/tmp");
    expect(r.ok).toBe(false);
  });
  test("forget proposal alone cannot erase", () => {
    const r = validateProposal({ id: "p1", action: "forget", rationale: "r", sourceRefs: ["s1"] } as any, "/tmp");
    expect(r.ok).toBe(false);
  });
});
