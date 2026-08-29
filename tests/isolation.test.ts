import { describe, test, expect } from "bun:test";

describe("isolation", () => {
  test("opaque ref binds owner and hash", async () => {
    const { decodeRef } = await import("../src/retrieval");
    const ref = Buffer.from(JSON.stringify({ c: 1, d: "doc", h: "abc123", o: "agent:alice" })).toString("base64url");
    const decoded = decodeRef(ref);
    expect(decoded.o).toBe("agent:alice");
    expect(decoded.h).toBe("abc123");
  });
  test("cross-bank path traversal rejected", () => {
    const path = require("node:path");
    const agentRoot = path.resolve("/tmp/vault/agents/alice");
    const traversal = "../../bob/memories/hack.md";
    const resolved = path.resolve(agentRoot, traversal);
    expect(resolved.startsWith(agentRoot + path.sep)).toBe(false);
  });
  test("secret patterns are blocked", async () => {
    const { remember } = await import("../src/memory");
    const vault = "/tmp/vault-test-isolation";
    const agentRoot = "/tmp/vault-test-isolation/agents/alice";
    await expect(remember(vault, agentRoot, "alice", { statement: "my key is sk-abcdefghijklmnopqrstuvwxyz123456" })).rejects.toThrow();
  });
  test("unattached team threads stay private", async () => {
    const { ensureAgent, ensureTeam, attachTeam, send, readThread } = await import("../src/agents");
    const { rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { mkdtempSync } = await import("node:fs");
    const vault = mkdtempSync(path.join(os.tmpdir(), "team-thread-acl-"));
    try {
      await ensureAgent(vault, "alice");
      await ensureTeam(vault, "red");
      const message = await send(vault, "bob", "team:red", "result", "private team result");
      await expect(send(vault, "bob", "team:red", "result", "safe", ["Bearer fixture-send-ref-secret-123456"]))
        .rejects.toThrow("secret rejected");
      await expect(send(vault, "../bob", "team:red", "result", "safe")).rejects.toThrow("invalid identifier");
      await expect(send(vault, "bob", "../red", "result", "safe")).rejects.toThrow("invalid identifier");
      await expect(readThread(vault, "alice", message.id)).rejects.toThrow("thread not found");
      await attachTeam(vault, "alice", "red");
      expect((await readThread(vault, "alice", message.id)).content).toBe("private team result");
      await expect(readThread(vault, "alice", "../../escape")).rejects.toThrow("invalid identifier");
    } finally {
      await rm(vault, { recursive: true, force: true }).catch(() => {});
    }
  });
  test("agent and team direct filesystem management", async () => {
    const { ensureAgent, ensureTeam, attachTeam, send, inbox } = await import("../src/agents");
    const { readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { mkdtempSync } = await import("node:fs");
    const vault = mkdtempSync(path.join(os.tmpdir(), "agent-fs-"));
    try {
      await ensureAgent(vault, "alice", "lead");
      await ensureAgent(vault, "bob", "developer");
      await ensureTeam(vault, "core-team");
      await attachTeam(vault, "alice", "core-team");

      // Verify file manifest created
      const aliceRaw = JSON.parse(await readFile(path.join(vault, "agents", "alice", "agent.json"), "utf8"));
      expect(aliceRaw.id).toBe("alice");
      expect(aliceRaw.teams).toContain("core-team");

      const teamRaw = JSON.parse(await readFile(path.join(vault, "teams", "core-team", "team.json"), "utf8"));
      expect(teamRaw.members).toContain("alice");

      // Verify durable thread communication
      const msg = await send(vault, "alice", "bob", "task", "Check migration script");
      expect(msg.from).toBe("alice");
      expect(msg.to).toBe("bob");

      const bobInbox = await inbox(vault, "bob");
      expect(bobInbox.length).toBeGreaterThan(0);
      expect(bobInbox.some((m) => m.content === "Check migration script")).toBe(true);

      // Direct file edit test
      aliceRaw.role = "principal";
      const { atomicWrite } = await import("../src/vault");
      await atomicWrite(path.join(vault, "agents", "alice", "agent.json"), JSON.stringify(aliceRaw));
      const updated = JSON.parse(await readFile(path.join(vault, "agents", "alice", "agent.json"), "utf8"));
      expect(updated.role).toBe("principal");
    } finally {
      await rm(vault, { recursive: true, force: true }).catch(() => {});
    }
  });
});
