import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, maybePack } from "../src/mcp";
import { atomicWrite, ensureVault } from "../src/vault";

function tmp(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("unexpected task result");
  const part = content.find((entry: any) => entry?.type === "text");
  if (!part || typeof part.text !== "string") throw new Error("missing text result");
  return JSON.parse(part.text);
}

describe("MCP protocol", () => {
  test("six tools expose attribution-bearing recall and read", async () => {
    const vault = tmp("mcp-protocol-");
    const usage: { recall: any[]; read: any[] } = { recall: [], read: [] };
    let client: Client | undefined;
    let created: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await atomicWrite(
        path.join(agentRoot, "memories", "deploy-rule.md"),
        "---\nid: deploy-rule\nkind: memory\n---\nUse staged health checks before deployment cutover.\n",
      );
      created = await createServer(
        { vault, agent: "alice" },
        {
          recall: async (_ctx, packet, retrieved) => { usage.recall.push({ packet, retrieved }); },
          read: async (_ctx, input) => { usage.read.push(input); },
        },
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "consol-test", version: "1.0.0" });
      await created.server.server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "forget",
        "read",
        "recall",
        "record",
        "remember",
        "send",
      ]);
      expect(client.getInstructions()).toContain("recall before substantive work");

      const recalled = textResult(await client.callTool({
        name: "recall",
        arguments: { query: "deploy-rule", agent: "alice" },
      }));
      expect(recalled.items[0].docId).toBe("deploy-rule");
      expect(usage.recall).toHaveLength(1);
      expect(usage.recall[0].retrieved[0].docId).toBe("deploy-rule");

      const decoded = JSON.parse(Buffer.from(recalled.items[0].ref, "base64url").toString("utf8"));
      expect(decoded.p).toBe(recalled.id);
      const read = textResult(await client.callTool({
        name: "read",
        arguments: { ref: recalled.items[0].ref, agent: "alice" },
      }));
      expect(read.text).toContain("staged health checks");
      expect(usage.read).toHaveLength(1);
      expect(usage.read[0].packetId).toBe(recalled.id);
    } finally {
      await client?.close().catch(() => {});
      await created?.server.close().catch(() => {});
      for (const ctx of created?.ctxCache.values() ?? []) ctx.db.close();
      try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }, 15000);

  test("Caveman skips secret-shaped egress and secret-shaped output", async () => {
    const query = "Bearer fixture-secret-token-123456789";
    const packet = {
      id: "pkt-test",
      mode: "auto" as const,
      targetCandidates: 10 as const,
      items: [],
      next: "read",
      attribution: {
        lexCapped: 0,
        vecCapped: 0,
        fused: 0,
        linked: 0,
        returned: 0,
        packetBytes: 0,
        packetTokensEstimate: 0,
        vector: { available: false, indexed: 0 },
        filters: { owner: "agent:alice", statuses: ["active"], kinds: null },
      },
    };
    const config = {
      vault: "/tmp/test",
      agent: "alice",
      budgets: {
        coreTokens: 900,
        coreCeiling: 1200,
        packetTokens: 3000,
        packetCeiling: 3000,
        l2Bytes: 4096,
        perArmCap: 60,
        quotas: { memory: 12, experience: 10, case: 6, skill: 4, inbox: 3 },
      },
      caveman: { enabled: true },
      runner: {},
    };
    let calls = 0;
    const skipped = await maybePack(packet, query, config, async () => {
      calls++;
      return { packed: "should not run" };
    });
    expect(calls).toBe(0);
    expect(skipped).toBe(packet);

    const rejected = await maybePack(packet, "safe retrieval cue", config, async () => {
      calls++;
      return { packed: "password=fixture-secret-value-123" };
    });
    expect(calls).toBe(1);
    expect(rejected).toBe(packet);
  });
});
