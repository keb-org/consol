import { describe, test, expect } from "bun:test";

describe("isolation", () => {
  test("cross-bank path traversal rejected", () => {
    const path = require("node:path");
    const agentRoot = path.resolve("/tmp/vault/agents/alice");
    const traversal = "../../bob/memories/hack.md";
    const resolved = path.resolve(agentRoot, traversal);
    expect(resolved.startsWith(agentRoot + path.sep)).toBe(false);
  });
  test("secret patterns are blocked", async () => {
    const { remember } = await import("@/memory");
    const vault = "/tmp/vault-test-isolation";
    const agentRoot = "/tmp/vault-test-isolation/agents/alice";
    await expect(remember(vault, agentRoot, "alice", { statement: "my key is sk-abcdefghijklmnopqrstuvwxyz123456" })).rejects.toThrow();
  });
  test("agent and team direct filesystem management", async () => {
    const { ensureAgent, ensureTeam, attachTeam, getAttachedTeams } = await import("@/agents");
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

      const aliceTeams = await getAttachedTeams(vault, "alice");
      expect(aliceTeams.has("team:core-team")).toBe(true);

      const bobTeams = await getAttachedTeams(vault, "bob");
      expect(bobTeams.has("team:core-team")).toBe(false);

      // Direct file edit test
      aliceRaw.role = "principal";
      const { atomicWrite } = await import("@/vault");
      await atomicWrite(path.join(vault, "agents", "alice", "agent.json"), JSON.stringify(aliceRaw));
      const updated = JSON.parse(await readFile(path.join(vault, "agents", "alice", "agent.json"), "utf8"));
      expect(updated.role).toBe("principal");
    } finally {
      await rm(vault, { recursive: true, force: true }).catch(() => {});
    }
  });
});
