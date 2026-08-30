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
import { getAttachedTeams } from "./agents";
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
      instructions: "MANDATORY MEMORY PROTOCOL — Every agent and every spawned subagent MUST use Consol as human-like, continuously-injected memory. One recall at the start is NOT enough — memory must be injected throughout reasoning. Single-recall-then-never-again violates protocol.\n\nHuman loop (repeat until task done):\n1. BEFORE work: call recall on the matched agent bank and rerank descriptors for the current goal.\n2. Strong match → read every plausible ref and apply it.\n3. No/weak/uncertain match → search online/docs (web search, Context7 for library docs, codebase search), then proceed. Do not hallucinate when Consol has no answer.\n4. MID-REASONING — after every tool result, before every edit/decision/subagent spawn, ask 'do I need memory for this next step?' If yes, recall again with a narrower query derived from new context. Mandatory triggers: task branches, new error/observation, assumption failed, evidence conflicts, context missing, or before any high-impact code change/decision. Recall is bounded and cheap (<1k tokens) — no token-saving excuse.\n5. AFTER work: MUST call record with observable outcome, evaluator, and appliedRefs (repeat those refs in top-level refs). Retrieval/read alone never means application or success.\n6. Parent agents MUST propagate this protocol to every subagent they spawn.",
    },
  );

  const agentParam = z.string().min(1).optional().describe("Agent/bank id (e.g. linus, ilya). Defaults to server AGENT.");

  server.registerTool(
    "recall",
    {
      description: "MANDATORY — call repeatedly, not just once. Retrieve bounded compact candidates (<1k tokens). Protocol: (a) call before ANY substantive work, (b) call AGAIN mid-reasoning after every tool result / before every edit/decision/subagent spawn when the next step could benefit from memory — mandatory triggers: task branches, new error/observation, assumption failed, evidence conflicts, context missing, before high-impact change. Then rerank descriptors; if no strong match or low confidence, search online/docs (web search, Context7, codebase search) instead of hallucinating. One recall at start then never again violates protocol.",
      inputSchema: { query: z.string().min(1), mode: z.enum(["auto", "facts", "guidance", "history"]).optional(), agent: agentParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, mode, agent }) => {
      const ctx = await resolveCtx(agent);
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
      const response = JSON.stringify({ ...packet, agent: ctx.agent, syncWarning: ctx.syncWarning }, null, 2);
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
      description: "MANDATORY after each recall that returns candidates — including mid-reasoning recalls. Read one UTF-8 byte-bounded page from a recall ref; pass cursor for next page. Pass agent when reading team-owned refs. Every plausible candidate MUST be read before the next decision. If recall returned nothing useful, search online/docs instead — do not skip.",
      inputSchema: { ref: z.string().min(1), cursor: z.string().optional(), agent: agentParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref, cursor, agent }) => {
      const decoded = decodeRef(ref);
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
      description: "MANDATORY — call after every substantive step AND at task end (not just at end). Append evidence for later reflection. For outcome, pass outcome=success|failure|partial|unknown, evaluator=pass|fail|mixed|unknown, and optional appliedRefs also listed in refs. Retrieval/read/recall alone never means application or success. Mid-reasoning record keeps the vault current for the next recall.",
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

  return { server, config, db: defaultCtx.db, aRoot: defaultCtx.aRoot, ctxCache, resolveCtx };
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
