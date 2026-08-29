import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveConfig, agentRoot } from "./config";
import { ensureVault } from "./vault";
import { openIndex, syncVault } from "./index";
import { recall, readChunk } from "./retrieval";
import { remember, record, forgetPlan, forgetConfirm } from "./memory";
import { inbox, readThread, send } from "./agents";

export async function createServer(argv: Record<string, string | boolean | undefined>) {
  const config = resolveConfig(argv);
  const { agentRoot: aRoot } = await ensureVault(config.vault, config.agent);
  const db = openIndex(aRoot);
  await syncVault(db, config.vault, aRoot, config.agent).catch(() => {});

  const server = new McpServer({ name: "consol", version: "0.1.0" });

  server.tool(
    "recall",
    "Retrieve relevant memory and experience. Returns a bounded typed packet; use read for detail.",
    { query: z.string().min(1), mode: z.enum(["auto", "facts", "guidance", "history", "inbox"]).optional() },
    async ({ query, mode }) => {
      if (mode === "inbox") {
        const msgs = await inbox(config.vault, config.agent, 8);
        const text = JSON.stringify({ inbox: msgs }, null, 2);
        return { content: [{ type: "text" as const, text }] };
      }
      const packet = await recall(db, config.vault, query, config.budgets, `agent:${config.agent}`);
      const packed = await maybePack(packet, query, config);
      return { content: [{ type: "text" as const, text: JSON.stringify(packed, null, 2) }] };
    },
  );

  server.tool(
    "read",
    "Read one bounded section from a recall ref or a thread id.",
    { ref: z.string().min(1), cursor: z.string().optional() },
    async ({ ref }) => {
      try {
        const chunk = readChunk(db, ref, config.budgets);
        return { content: [{ type: "text" as const, text: JSON.stringify(chunk, null, 2) }] };
      } catch {
        const thread = await readThread(config.vault, config.agent, ref);
        return { content: [{ type: "text" as const, text: JSON.stringify(thread, null, 2) }] };
      }
    },
  );

  server.tool(
    "remember",
    "Persist an explicit durable assertion with provenance. Deduplicates; cannot activate inferred experience.",
    { statement: z.string().min(1), scope: z.string().optional(), refs: z.array(z.string()).optional() },
    async ({ statement, scope, refs }) => {
      const res = await remember(config.vault, aRoot, config.agent, { statement, scope, refs }, db);
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.tool(
    "record",
    "Append an observation, action, result, or outcome for later reflection.",
    { kind: z.string().min(1), data: z.record(z.unknown()), refs: z.array(z.string()).optional() },
    async ({ kind, data, refs }) => {
      const rec = await record(config.vault, aRoot, config.agent, { kind, data: data as Record<string, unknown>, refs });
      return { content: [{ type: "text" as const, text: JSON.stringify(rec, null, 2) }] };
    },
  );

  server.tool(
    "forget",
    "Two-phase erasure. First call returns plan+token; second call with confirmation erases.",
    { target: z.string().min(1), confirmation: z.string().optional() },
    async ({ target, confirmation }) => {
      if (!confirmation) {
        const plan = await forgetPlan(config.vault, aRoot, target);
        return { content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }] };
      }
      const res = await forgetConfirm(config.vault, aRoot, config.agent, target, confirmation, db);
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.tool(
    "send",
    "Send a durable thread message to an agent or team. No arbitrary peer-bank reads.",
    { to: z.string().min(1), kind: z.enum(["question", "reply", "task", "result", "handoff"]), content: z.string().min(1), refs: z.array(z.string()).optional() },
    async ({ to, kind, content, refs }) => {
      const ev = await send(config.vault, config.agent, to, kind, content, refs);
      return { content: [{ type: "text" as const, text: JSON.stringify(ev, null, 2) }] };
    },
  );

  return { server, config, db, aRoot };
}

async function maybePack(packet: any, query: string, config: any) {
  if (!config.caveman?.enabled) return packet;
  const apiKey = config.caveman.apiKeyEnv ? process.env[config.caveman.apiKeyEnv] : undefined;
  const baseURL = config.caveman.baseURL;
  if (!apiKey || !baseURL) return packet;
  try {
    const { Cave } = await import("@caveman-ai/sdk");
    const cave = new Cave({ apiKey, baseURL, agent: config.agent });
    const items = packet.items.map((it: any) => ({ id: it.ref, text: it.summary, meta: it }));
    const result: any = await (cave.context as any).pack(query, items, {});
    if (result?.packed) return { ...packet, packed: result.packed, deferredIds: result.deferredIds, fallback: packet };
  } catch {}
  return packet;
}

export async function serve(argv: Record<string, string | boolean | undefined>) {
  const { server } = await createServer(argv);
  if (argv.http || argv.port) {
    const http = await import("node:http");
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
    let transport: any = null;
    const port = Number(argv.port || process.env.MEMORY_PORT || process.env.PORT || 8765);
    const host = (argv.host as string) || "127.0.0.1";
    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/sse") {
        transport = new SSEServerTransport("/message", res);
        await server.connect(transport);
      } else if (url.pathname === "/message") {
        if (transport) await transport.handlePostMessage(req, res);
        else { res.writeHead(400); res.end("No active SSE session"); }
      } else {
        res.writeHead(404); res.end("Not found");
      }
    });
    httpServer.listen(port, host, () => {
      console.log(`MCP SSE server listening at http://${host}:${port}/sse`);
    });
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
