import { afterEach, describe, test, expect } from "bun:test";
import { validateProposal } from "@/reflection";

const TEST_SECRET_ENV = "CONSOL_TEST_API_KEY";

afterEach(() => {
  delete process.env[TEST_SECRET_ENV];
});

describe("memory lifecycle", () => {
  test("rejects secrets in every remember field", async () => {
    const { remember } = await import("@/memory");
    const vault = "/tmp/vault-test";
    const agentRoot = "/tmp/vault-test/agents/a";
    await expect(remember(vault, agentRoot, "a", { statement: "key sk-123456789012345678901234567890" })).rejects.toThrow("secret rejected");
    await expect(remember(vault, agentRoot, "a", { statement: "safe", scope: "Bearer fixture-scope-secret-123456" })).rejects.toThrow("secret rejected");
    await expect(remember(vault, agentRoot, "a", { statement: "safe", refs: ["password=fixture-ref-secret-123456"] })).rejects.toThrow("secret rejected");
  });
  test("configured secret values are rejected and redacted without enumerating environment", async () => {
    const configured = "fixture-configured-secret-123456789";
    process.env[TEST_SECRET_ENV] = configured;
    const { containsSecret, redactSecrets, secretInText } = await import("@/security");
    expect(secretInText(`prefix ${configured} suffix`)).toBe(true);
    expect(containsSecret({ note: configured })).toBe(true);
    const redacted = redactSecrets(`failed with ${configured}`);
    expect(redacted).toBe("failed with [REDACTED]");
    expect(redacted).not.toContain(configured);
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
  test("remember deduplicates exact normalized assertions", async () => {
    const { ensureVault } = await import("@/vault");
    const { remember } = await import("@/memory");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const vault = mkdtempSync(path.join(os.tmpdir(), "memory-dedup-"));
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const first = await remember(vault, agentRoot, "alice", { statement: "Prefer bounded retrieval packets." });
      const second = await remember(vault, agentRoot, "alice", { statement: "  prefer   bounded retrieval packets.  " });
      expect(second.id).toBe(first.id);
      expect(second.dedup).toBe(true);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
  test("record rejects unsupported kinds and secret-shaped data", async () => {
    const { ensureVault } = await import("@/vault");
    const { record } = await import("@/memory");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const vault = mkdtempSync(path.join(os.tmpdir(), "memory-record-validation-"));
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await expect(record(vault, agentRoot, "alice", { kind: "claim", data: {} })).rejects.toThrow("unsupported record kind");
      await expect(record(vault, agentRoot, "alice", { kind: "outcome", data: { apiKey: "redacted" } })).rejects.toThrow("secret rejected");
      await expect(record(vault, agentRoot, "alice", { kind: "observation", data: { text: "Bearer abcdefghijklmnopqrstuvwxyz" } })).rejects.toThrow("secret rejected");
      await expect(record(vault, agentRoot, "alice", { kind: "observation", data: { text: "github_pat_abcdefghijklmnopqrstuvwxyz123456" } })).rejects.toThrow("secret rejected");
      await expect(record(vault, agentRoot, "alice", {
        kind: "observation",
        data: { text: "safe" },
        refs: ["Bearer fixture-record-ref-secret-123456"],
      })).rejects.toThrow("secret rejected");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
