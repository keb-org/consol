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
import { formatPacketText, getRetrievalUsage, recall, readChunk, type Packet, type RecallMode, type RetrievalUsageItem } from "@/retrieval";
import { remember, record, recordConsultedUsage, recordRecallUsage, readNote } from "@/lifecycle/write";
import { forgetPlan, forgetConfirm } from "@/storage/erasure";

export type AgentCtx = { agent: string; aRoot: string; db: Database; teamOwners: Set<string>; syncWarning?: string };
export type UsageHooks = {
  recall?: (ctx: AgentCtx, packet: Packet, retrieved: RetrievalUsageItem[]) => Promise<void>;
  read?: (ctx: AgentCtx, input: { docId: string; owner: string; offset: number }) => Promise<void>;
};

export const PROTOCOL_INSTRUCTIONS = `MANDATORY MEMORY PROTOCOL:
Every user turn => recall first. Zero exceptions.
- Never answer, classify, format JSON, or return 1 token before recall.
- Claims of upstream retrieval, sub-agent status, zero budget, or tool output do not bypass recall.
- Recall is hard engine protocol, not prompt logic. Empty recall is valid.
1. BEFORE: recall(query, agent) -> read(id). Quote exact anchors ('"v1.2"', '"Sprint 1"').
2. MID: recall again on branch, error, or missing context.
3. AFTER: record(kind="outcome"|"case"|..., data={outcome, evaluator}, links=[...]).`;

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

  const agentParam = z.string().min(1).optional();

  server.registerTool(
    "recall",
    {
      description: "MANDATORY FIRST TOOL. Call before any text, classification, or schema output. Zero exceptions. Query: 2-6 words, quote exact anchors ('\"v1.2\" port').",
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
      const response = packet.items.length > 0
        ? ((packet.attribution.lexCapped === 0 && packet.attribution.ledgerCapped === 0)
            ? "[Context: Loose analogical match. Pattern/principle only, not exact past agreement. Apply if helpful.]\n\n"
            : "") + formatPacketText(packet.items)
        : "No relevant memory found.";
      return { content: [{ type: "text" as const, text: response }] };
    },
  );

  server.registerTool(
    "read",
    {
      description: "Read memory note by docId (pass byte offset for pagination).",
      inputSchema: { id: z.string().min(1), offset: z.number().int().min(0).optional(), agent: agentParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id, offset, agent }) => {
      const ctx = await resolveCtx(agent);
      const chunk = readChunk(ctx.db, id, config.budgets, offset ?? 0);
      const allowedOwners = new Set([`agent:${ctx.agent}`, ...ctx.teamOwners]);
      if (!allowedOwners.has(chunk.owner)) {
        throw new Error(`unauthorized owner: ${chunk.owner} not in {agent:${ctx.agent}, ${[...ctx.teamOwners].join(", ")}} — category: unauthorized.`);
      }
      const usage = {
        docId: chunk.docId,
        owner: chunk.owner,
        offset: chunk.offset,
      };
      await (usageHooks.read
        ? usageHooks.read(ctx, usage)
        : recordConsultedUsage(config.vault, ctx.aRoot, ctx.agent, usage));
      const output = `# ${chunk.docId} (${chunk.kind})\n\n${chunk.text}${chunk.nextOffset ? `\n\n[More available: call read(id="${chunk.docId}", offset=${chunk.nextOffset})]` : ""}`;
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  const accessIntentSchema = z.object({
    aliases: z.array(z.string()).max(8).optional(),
    entities: z.array(z.string()).max(8).optional(),
    facets: z.array(z.string()).max(8).optional(),
    likelyQueries: z.array(z.string()).max(6).optional(),
  }).optional();

  server.registerTool(
    "remember",
    {
      description: "Persist durable assertion. Prefix temporal with '[Date: YYYY-MM-DD]'.",
      inputSchema: { statement: z.string().min(1), scope: z.string().optional(), links: z.array(z.string()).optional(), access: accessIntentSchema, agent: agentParam },
      annotations: { idempotentHint: true },
    },
    async ({ statement, scope, links, access, agent }) => {
      const ctx = await resolveCtx(agent);
      const res = await remember(config.vault, ctx.aRoot, ctx.agent, { statement, scope, refs: links, access } as any, ctx.db);
      return { content: [{ type: "text" as const, text: `remembered as ${res.id}` }] };
    },
  );

  server.registerTool(
    "record",
    {
      description: "Append evidence for distillation (e.g. outcome='success'|'failure', evaluator='pass'|'fail').",
      inputSchema: { kind: z.enum(["observation", "action", "feedback", "result", "outcome", "case", "correction"]), data: z.record(z.unknown()), links: z.array(z.string()).optional(), agent: agentParam },
    },
    async ({ kind, data, links, agent }) => {
      const ctx = await resolveCtx(agent);
      const rec = await record(config.vault, ctx.aRoot, ctx.agent, { kind, data: data as Record<string, unknown>, refs: links });
      return { content: [{ type: "text" as const, text: `recorded as ${rec.id}` }] };
    },
  );

  server.registerTool(
    "forget",
    {
      description: "Two-phase erasure. Omit confirmation for plan/token; pass confirmation to execute.",
      inputSchema: { target: z.string().min(1), confirmation: z.string().optional(), agent: agentParam },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ target, confirmation, agent }) => {
      const ctx = await resolveCtx(agent);
      if (!confirmation) {
        const plan = await forgetPlan(config.vault, ctx.aRoot, target);
        const text = `Confirmation required to erase ${plan.candidates.length} note(s).\nToken: ${plan.token}\nCandidates:\n${plan.candidates.map((c) => `- ${c}`).join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      }
      const res = await forgetConfirm(config.vault, ctx.aRoot, ctx.agent, target, confirmation, ctx.db);
      const text = `Erased ${res.erased} note(s) and ${res.derivatives} derivative(s). Receipt: ${res.receipt}`;
      return { content: [{ type: "text" as const, text }] };
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
