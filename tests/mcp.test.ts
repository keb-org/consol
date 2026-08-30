import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp";
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
  test("five tools expose attribution-bearing recall and read", async () => {
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
      ]);
      expect(client.getInstructions()).toContain("MANDATORY MEMORY PROTOCOL");
      expect(client.getInstructions()).toContain("recall");

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
});

