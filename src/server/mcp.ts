import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "@package";
import { resolveConfig } from "@/core/config";
import { getAttachedTeams, sanitizeId } from "@/core/identity";
import { ensureVault } from "@/storage/vault";
import { openIndex } from "@/storage/index/schema";
import { syncVault } from "@/storage/index/sync";
import { decodeRef, getRetrievalUsage, recall, readChunk, type Packet, type RecallMode, type RetrievalUsageItem } from "@/retrieval";
import { remember, record, recordConsultedUsage, recordRecallUsage, readNote } from "@/lifecycle/write";
import { forgetPlan, forgetConfirm } from "@/storage/erasure";

export type AgentCtx = { agent: string; aRoot: string; db: Database; teamOwners: Set<string>; syncWarning?: string };
export type UsageHooks = {
  recall?: (ctx: AgentCtx, packet: Packet, retrieved: RetrievalUsageItem[]) => Promise<void>;
  read?: (ctx: AgentCtx, input: { ref: string; docId: string; owner: string; offset: number; packetId?: string }) => Promise<void>;
};

const PROTOCOL_INSTRUCTIONS = `MANDATORY MEMORY PROTOCOL — Continuous injection mandatory. Single-recall-then-never violates protocol.

LOOP:
1. BEFORE: recall(query, agent). Read every plausible ref.
2. MID: recall again on branch, error, assumption fail, missing context.
3. AFTER: record outcome='success'|'failure'|'partial', evaluator='pass'|'fail'|'mixed', appliedRefs=[...].
4. Subagents MUST inherit protocol.

WRITE (remember/record):
• Time: prefix '[Date: YYYY-MM-DD]'.
• Values: verbatim numbers, currencies ($100, 1.5M₫, €50), versions (v1.2.3).
• Cross-lingual: fill access.aliases/entities/facets/likelyQueries in target languages.
• Dedup: exact assertions auto-deduplicate.

QUERY (recall):
• Anchors: quote exact names, IDs, versions ('"Sprint 1" deadline', '"v2.4.0"').
• Terms: 2–6 dense content words. No conversational fluff.
• Modes: auto (fusion), facts (notes), guidance (skills), history (audit/superseded).`;

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
    const raw = (requestedAgent?.trim() || config.agent).trim();
    const agent = sanitizeId(raw, "agent");
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
    { instructions: PROTOCOL_INSTRUCTIONS },
  );

  const agentParam = z.string().min(1).optional().describe("Agent/bank ID (e.g. linus, ilya). Defaults to server AGENT.");

  server.registerTool(
    "recall",
    {
      description: "MANDATORY — Retrieve candidates (<1k tokens). Query: 2-6 words, quote exact anchors ('\"v1.2\" port'). Modes: auto, facts, guidance, history. Repeat mid-task when context branches.",
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
      const response = JSON.stringify({ ...packet, agent: ctx.agent, syncWarning: ctx.syncWarning });
      const ceiling = Math.min(config.budgets.packetTokens, config.budgets.packetCeiling) * 4;
      if (Buffer.byteLength(response, "utf8") > ceiling) {
        throw new Error(`MCP recall response exceeds ${ceiling}-byte ceiling — category: out-of-bounds. Fix: lower perArmCap/targetCandidates or shorten summaries`);
      }
      return { content: [{ type: "text" as const, text: response }] };
    },
  );

  server.registerTool(
    "read",
    {
      description: "MANDATORY after recall. Read byte-bounded chunk from ref; pass cursor for next page. Read all plausible refs before decisions.",
      inputSchema: { ref: z.string().min(1), cursor: z.string().optional(), agent: agentParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref, cursor, agent }) => {
      const decoded = decodeRef(ref);
      const ownerAgent = decoded.o.startsWith("agent:") ? decoded.o.slice("agent:".length) : undefined;
      const ctx = await resolveCtx(agent ?? ownerAgent);
      const allowedOwners = new Set([`agent:${ctx.agent}`, ...ctx.teamOwners]);
      if (!allowedOwners.has(decoded.o)) throw new Error(`unauthorized ref owner: ${decoded.o} not in {agent:${ctx.agent}, ${[...ctx.teamOwners].join(", ")}} — category: unauthorized. Fix: call read with agent="${decoded.o.replace(/^(agent|team):/, "")}" or attach team`);
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
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...chunk, agent: ctx.agent }) }] };
    },
  );

  const accessIntentSchema = z.object({
    aliases: z.array(z.string()).max(8).optional().describe("Alternate names/translations (<=8 entries, <=120 bytes)."),
    entities: z.array(z.string()).max(8).optional().describe("Entities/proper nouns (<=8 entries)."),
    facets: z.array(z.string()).max(8).optional().describe("Semantic categories (<=8 entries, no generic single words)."),
    likelyQueries: z.array(z.string()).max(6).optional().describe("Predicted search queries/questions (<=6 entries)."),
  }).optional().describe("Future-access routing metadata for hidden search surfaces.");

  server.registerTool(
    "remember",
    {
      description: "Persist durable assertion. Prefix temporal with '[Date: YYYY-MM-DD]'. Use access for cross-lingual lookup.",
      inputSchema: { statement: z.string().min(1), scope: z.string().optional(), refs: z.array(z.string()).optional(), access: accessIntentSchema, agent: agentParam },
      annotations: { idempotentHint: true },
    },
    async ({ statement, scope, refs, access, agent }) => {
      const ctx = await resolveCtx(agent);
      const res = await remember(config.vault, ctx.aRoot, ctx.agent, { statement, scope, refs, access } as any, ctx.db);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...res, agent: ctx.agent }) }] };
    },
  );

  server.registerTool(
    "record",
    {
      description: "MANDATORY — Append evidence for skill distillation. Post-task outcome: outcome='success'|'failure', evaluator='pass'|'fail', appliedRefs=[...].",
      inputSchema: { kind: z.enum(["observation", "action", "feedback", "result", "outcome", "case", "correction"]), data: z.record(z.unknown()), refs: z.array(z.string()).optional(), agent: agentParam },
    },
    async ({ kind, data, refs, agent }) => {
      const ctx = await resolveCtx(agent);
      const rec = await record(config.vault, ctx.aRoot, ctx.agent, { kind, data: data as Record<string, unknown>, refs });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...rec, agent: ctx.agent }) }] };
    },
  );

  server.registerTool(
    "forget",
    {
      description: "Two-phase erasure. Omit confirmation to get plan/token; provide confirmation token to execute cascade scrub.",
      inputSchema: { target: z.string().min(1), confirmation: z.string().optional(), agent: agentParam },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ target, confirmation, agent }) => {
      const ctx = await resolveCtx(agent);
      if (!confirmation) {
        const plan = await forgetPlan(config.vault, ctx.aRoot, target);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...plan, agent: ctx.agent }) }] };
      }
      const res = await forgetConfirm(config.vault, ctx.aRoot, ctx.agent, target, confirmation, ctx.db);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...res, agent: ctx.agent }) }] };
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
