import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "../package.json";
import { resolveConfig, agentRoot as resolveAgentRoot } from "./config";
import { ensureVault } from "./vault";
import { openIndex, syncVault } from "./index";
import { decodeRef, getRetrievalUsage, recall, readChunk, type Packet, type RecallMode, type RetrievalUsageItem } from "./retrieval";
import { remember, record, recordConsultedUsage, recordRecallUsage, forgetPlan, forgetConfirm } from "./memory";
import { getAttachedTeams, inbox, readThread, send } from "./agents";
import { containsSecret } from "./security";

type AgentCtx = { agent: string; aRoot: string; db: Database; teamOwners: Set<string>; syncWarning?: string };
type UsageHooks = {
  recall?: (ctx: AgentCtx, packet: Packet, retrieved: RetrievalUsageItem[]) => Promise<void>;
  read?: (ctx: AgentCtx, input: { ref: string; docId: string; owner: string; offset: number; packetId?: string }) => Promise<void>;
};

export async function createServer(
  argv: Record<string, string | boolean | undefined>,
  usageHooks: UsageHooks = {},
) {
  const config = resolveConfig(argv);
  const defaultCtx = await getOrCreateCtx(config.vault, config.agent);
  const ctxCache = new Map<string, AgentCtx>([[config.agent, defaultCtx]]);

  async function getOrCreateCtx(vault: string, agent: string): Promise<AgentCtx> {
    const { agentRoot: aRoot } = await ensureVault(vault, agent);
    const db = openIndex(aRoot);
    let syncWarning: string | undefined;
    try {
      await syncVault(db, vault, aRoot, agent);
    } catch (error) {
      syncWarning = error instanceof Error ? error.message : String(error);
    }
    return { agent, aRoot, db, teamOwners: await getAttachedTeams(vault, agent), syncWarning };
  }

  async function resolveCtx(requestedAgent?: string): Promise<AgentCtx> {
    const agent = (requestedAgent?.trim() || config.agent).trim();
    if (agent.includes("..") || agent.includes("/") || agent.includes("\\") || !agent) throw new Error(`invalid agent: ${agent}`);
    const cached = ctxCache.get(agent);
    if (cached) {
      cached.teamOwners = await getAttachedTeams(config.vault, agent);
      return cached;
    }
    const ctx = await getOrCreateCtx(config.vault, agent);
    ctxCache.set(agent, ctx);
    return ctx;
  }

  const server = new McpServer(
    { name: "consol", version: pkg.version },
    {
      instructions: "Use recall before substantive work, then semantically rerank its compact descriptors for the current goal and read every plausibly needed ref. Recall again with narrower cues when the task branches, assumptions fail, evidence conflicts, context is missing, or before a high-impact decision. Record outcomes after work. MCP guidance cannot force host tool use.",
    },
  );

  const agentParam = z.string().min(1).optional().describe("Agent/bank id (e.g. linus, ilya). Defaults to server AGENT.");

  server.registerTool(
    "recall",
    {
      description: "Retrieve bounded compact candidates. Host must semantically rerank descriptors for current goal, read every plausible ref, and recall again with narrower cues after branches, contradictions, failed assumptions, missing context, or before high-impact decisions.",
      inputSchema: { query: z.string().min(1), mode: z.enum(["auto", "facts", "guidance", "history", "inbox"]).optional(), agent: agentParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, mode, agent }) => {
      const ctx = await resolveCtx(agent);
      if (mode === "inbox") {
        const msgs = await inbox(config.vault, ctx.agent, 8);
        const text = JSON.stringify({ inbox: msgs, agent: ctx.agent }, null, 2);
        return { content: [{ type: "text" as const, text }] };
      }
      const packet = await recall(
        ctx.db,
        config.vault,
        query,
        config.budgets,
        `agent:${ctx.agent}`,
        (mode ?? "auto") as RecallMode,
        ctx.teamOwners,
      );
      const retrieved = getRetrievalUsage(packet);
      await (usageHooks.recall
        ? usageHooks.recall(ctx, packet, retrieved)
        : recordRecallUsage(config.vault, ctx.aRoot, ctx.agent, packet, retrieved));
      const packed = await maybePack(packet, query, { ...config, agent: ctx.agent });
      const response = JSON.stringify({ ...packed, agent: ctx.agent, syncWarning: ctx.syncWarning }, null, 2);
      const ceiling = Math.min(config.budgets.packetTokens, config.budgets.packetCeiling) * 4;
      if (Buffer.byteLength(response, "utf8") > ceiling) {
        throw new Error(`MCP recall response exceeds ${ceiling}-byte ceiling`);
      }
      return { content: [{ type: "text" as const, text: response }] };
    },
  );

  server.registerTool(
    "read",
    {
      description: "Read one UTF-8 byte-bounded page from a recall ref; pass returned cursor for next page. Thread IDs remain supported. Pass agent when reading team-owned refs.",
      inputSchema: { ref: z.string().min(1), cursor: z.string().optional(), agent: agentParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref, cursor, agent }) => {
      let decoded: ReturnType<typeof decodeRef> | null = null;
      try { decoded = decodeRef(ref); } catch {}
      if (decoded) {
        const ownerAgent = decoded.o.startsWith("agent:") ? decoded.o.slice("agent:".length) : undefined;
        const ctx = await resolveCtx(agent ?? ownerAgent);
        const allowedOwners = new Set([`agent:${ctx.agent}`, ...ctx.teamOwners]);
        if (!allowedOwners.has(decoded.o)) throw new Error("ref owner not attached to agent");
        const chunk = readChunk(ctx.db, ref, config.budgets, cursor);
        const usage = {
          ref,
          docId: chunk.docId,
          owner: chunk.owner,
          offset: chunk.offset,
          packetId: decoded.p,
        };
        await (usageHooks.read
          ? usageHooks.read(ctx, usage)
          : recordConsultedUsage(config.vault, ctx.aRoot, ctx.agent, usage));
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...chunk, agent: ctx.agent }, null, 2) }] };
      }
      if (cursor) throw new Error("cursor requires recall ref");
      const ctx = await resolveCtx(agent);
      const thread = await readThread(config.vault, ctx.agent, ref);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...thread, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.registerTool(
    "remember",
    {
      description: "Persist explicit durable assertion with provenance. Exact assertions deduplicate; inferred experience cannot become active through this tool.",
      inputSchema: { statement: z.string().min(1), scope: z.string().optional(), refs: z.array(z.string()).optional(), agent: agentParam },
      annotations: { idempotentHint: true },
    },
    async ({ statement, scope, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const res = await remember(config.vault, ctx.aRoot, ctx.agent, { statement, scope, refs }, ctx.db);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...res, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.registerTool(
    "record",
    {
      description: "Append evidence for later reflection. For outcome, pass outcome=success|failure|partial|unknown, evaluator=pass|fail|mixed|unknown, and optional appliedRefs also listed in refs. Retrieval/read are tracked separately and never imply application or success.",
      inputSchema: { kind: z.enum(["observation", "action", "feedback", "result", "outcome", "case", "correction"]), data: z.record(z.unknown()), refs: z.array(z.string()).optional(), agent: agentParam },
    },
    async ({ kind, data, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const rec = await record(config.vault, ctx.aRoot, ctx.agent, { kind, data: data as Record<string, unknown>, refs });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...rec, agent: ctx.agent }, null, 2) }] };
    },
  );

  server.registerTool(
    "forget",
    {
      description: "Two-phase erasure. Omit confirmation to inspect plan and token; provide returned token only after user confirms same target.",
      inputSchema: { target: z.string().min(1), confirmation: z.string().optional(), agent: agentParam },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
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

  server.registerTool(
    "send",
    {
      description: "Send durable thread message to agent or team. No arbitrary peer-bank reads; agent is sender.",
      inputSchema: { to: z.string().min(1), kind: z.enum(["question", "reply", "task", "result", "handoff"]), content: z.string().min(1), refs: z.array(z.string()).optional(), agent: agentParam },
    },
    async ({ to, kind, content, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const ev = await send(config.vault, ctx.agent, to, kind, content, refs);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...ev, from: ctx.agent }, null, 2) }] };
    },
  );

  return { server, config, db: defaultCtx.db, aRoot: defaultCtx.aRoot, ctxCache, resolveCtx };
}

export async function maybePack(
  packet: Packet,
  query: string,
  config: ReturnType<typeof resolveConfig>,
  pack?: (query: string, items: unknown[]) => Promise<any>,
) {
  if (!config.caveman.enabled || containsSecret({ query, items: packet.items })) return packet;
  const apiKey = config.caveman.apiKeyEnv ? process.env[config.caveman.apiKeyEnv] : undefined;
  const baseURL = config.caveman.baseURL;
  if (!pack && (!apiKey || !baseURL)) return packet;
  try {
    const items = packet.items.map((item) => ({ id: item.ref, text: item.summary, meta: item }));
    let result: any;
    if (pack) result = await pack(query, items);
    else {
      const { Cave } = await import("@caveman-ai/sdk");
      const cave = new Cave({ apiKey: apiKey!, baseURL: baseURL!, agent: config.agent });
      result = await (cave.context as any).pack(query, items, {});
    }
    if (containsSecret(result)) return packet;
    if (result?.packed) return { ...packet, packed: result.packed, deferredIds: result.deferredIds };
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
