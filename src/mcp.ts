import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { resolveConfig, agentRoot as resolveAgentRoot } from "./config";
import { ensureVault } from "./vault";
import { openIndex, syncVault } from "./index";
import { recall, readChunk } from "./retrieval";
import { remember, record, forgetPlan, forgetConfirm } from "./memory";
import { inbox, readThread, send } from "./agents";

type AgentCtx = { agent: string; aRoot: string; db: Database };

export async function createServer(argv: Record<string, string | boolean | undefined>) {
  const config = resolveConfig(argv);
  const defaultCtx = await getOrCreateCtx(config.vault, config.agent);
  const ctxCache = new Map<string, AgentCtx>([[config.agent, defaultCtx]]);

  async function getOrCreateCtx(vault: string, agent: string): Promise<AgentCtx> {
    const { agentRoot: aRoot } = await ensureVault(vault, agent);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, agent).catch(() => {});
    return { agent, aRoot, db };
  }

  async function resolveCtx(requestedAgent?: string): Promise<AgentCtx> {
    const agent = (requestedAgent?.trim() || config.agent).trim();
    if (agent.includes("..") || agent.includes("/") || agent.includes("\\") || !agent) throw new Error(`invalid agent: ${agent}`);
    const cached = ctxCache.get(agent);
    if (cached) return cached;
    const ctx = await getOrCreateCtx(config.vault, agent);
    ctxCache.set(agent, ctx);
    return ctx;
  }

  const server = new McpServer({ name: "consol", version: "0.1.0" });

  const agentParam = z.string().min(1).optional().describe("Agent/bank id (e.g. linus, ilya). Defaults to server AGENT.");

  server.tool(
    "recall",
    "Retrieve relevant memory and experience. Returns a bounded typed packet; use read for detail. Use agent to route (linus: systems/code/arch, ilya: AI/research).",
    { query: z.string().min(1), mode: z.enum(["auto", "facts", "guidance", "history", "inbox"]).optional(), agent: agentParam },
    async ({ query, mode, agent }) => {
      const ctx = await resolveCtx(agent);
      if (mode === "inbox") {
        const msgs = await inbox(config.vault, ctx.agent, 8);
        const text = JSON.stringify({ inbox: msgs, agent: ctx.agent }, null, 2);
        return { content: [{ type: "text" as const, text }] };
      }
      const packet = await recall(ctx.db, config.vault, query, config.budgets, `agent:${ctx.agent}`);
      const packed = await maybePack(packet, query, { ...config, agent: ctx.agent });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...packed, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.tool(
    "read",
    "Read one bounded section from a recall ref or a thread id. Pass agent hint to disambiguate when needed.",
    { ref: z.string().min(1), cursor: z.string().optional(), agent: agentParam },
    async ({ ref, agent }) => {
      const tryAgents = agent ? [agent] : [config.agent, ...[...ctxCache.keys()].filter((k) => k !== config.agent)];
      for (const a of tryAgents) {
        try {
          const ctx = await resolveCtx(a);
          const chunk = readChunk(ctx.db, ref, config.budgets);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...chunk, agent: ctx.agent }, null, 2) }] };
        } catch {}
      }
      // Fallback: try any cached db by ref owner decode, else thread
      for (const a of tryAgents) {
        try {
          const ctx = await resolveCtx(a);
          const thread = await readThread(config.vault, ctx.agent, ref);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...thread, agent: ctx.agent }, null, 2) }] };
        } catch {}
      }
      // Last resort: try default agent thread
      const ctx = await resolveCtx(agent);
      const thread = await readThread(config.vault, ctx.agent, ref);
      return { content: [{ type: "text" as const, text: JSON.stringify(thread, null, 2) }] };
    },
  );

  server.tool(
    "remember",
    "Persist an explicit durable assertion with provenance. Deduplicates; cannot activate inferred experience. Use agent to choose bank.",
    { statement: z.string().min(1), scope: z.string().optional(), refs: z.array(z.string()).optional(), agent: agentParam },
    async ({ statement, scope, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const res = await remember(config.vault, ctx.aRoot, ctx.agent, { statement, scope, refs }, ctx.db);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...res, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.tool(
    "record",
    "Append an observation, action, result, or outcome for later reflection. Use agent to choose bank.",
    { kind: z.string().min(1), data: z.record(z.unknown()), refs: z.array(z.string()).optional(), agent: agentParam },
    async ({ kind, data, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const rec = await record(config.vault, ctx.aRoot, ctx.agent, { kind, data: data as Record<string, unknown>, refs });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...rec, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.tool(
    "forget",
    "Two-phase erasure. First call returns plan+token; second call with confirmation erases. Use agent to target bank.",
    { target: z.string().min(1), confirmation: z.string().optional(), agent: agentParam },
    async ({ target, confirmation, agent }) => {
      const ctx = await resolveCtx(agent);
      if (!confirmation) {
        const plan = await forgetPlan(config.vault, ctx.aRoot, target);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...plan, agent: ctx.agent }, null, 2) }] };
      }
      const res = await forgetConfirm(config.vault, ctx.aRoot, ctx.agent, target, confirmation, ctx.db);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...res, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.tool(
    "send",
    "Send a durable thread message to an agent or team. No arbitrary peer-bank reads. agent is the sender.",
    { to: z.string().min(1), kind: z.enum(["question", "reply", "task", "result", "handoff"]), content: z.string().min(1), refs: z.array(z.string()).optional(), agent: agentParam },
    async ({ to, kind, content, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const ev = await send(config.vault, ctx.agent, to, kind, content, refs);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...ev, from: ctx.agent }, null, 2) }] };
    },
  );

  return { server, config, db: defaultCtx.db, aRoot: defaultCtx.aRoot, ctxCache, resolveCtx };
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
