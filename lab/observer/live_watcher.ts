import { createServer } from "@/server/mcp";
import type { AgentCtx } from "@/server/mcp";
import type { Packet, RetrievalUsageItem } from "@/retrieval";

export interface ObserverEvent {
  timestamp: string;
  type: "recall" | "read" | "remember" | "record" | "forget";
  agent: string;
  payload: Record<string, unknown>;
  latencyMs?: number;
}

export class AgentMcpObserver {
  private events: ObserverEvent[] = [];

  logEvent(event: Omit<ObserverEvent, "timestamp">): void {
    const fullEvent: ObserverEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.events.push(fullEvent);
    console.log(`[Observer][${fullEvent.type.toUpperCase()}] agent=${fullEvent.agent} at=${fullEvent.timestamp}`);
    console.log(`  Payload:`, JSON.stringify(fullEvent.payload));
  }

  getEvents(): ObserverEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export async function createObservedServer(argv: Record<string, string | boolean | undefined>, observer: AgentMcpObserver) {
  return createServer(argv, {
    recall: async (ctx: AgentCtx, packet: Packet, retrieved: RetrievalUsageItem[]) => {
      observer.logEvent({
        type: "recall",
        agent: ctx.agent,
        payload: {
          packetId: packet.id,
          targetCandidates: packet.targetCandidates,
          itemsCount: packet.items.length,
          fused: packet.attribution.fused,
          vectorAvailable: packet.attribution.vector.available,
          items: packet.items.map((i) => ({ docId: i.docId, rrf: i.rrf, source: i.source, summary: i.summary })),
        },
      });
    },
    read: async (ctx: AgentCtx, input: { ref: string; docId: string; owner: string; offset: number; packetId?: string }) => {
      observer.logEvent({
        type: "read",
        agent: ctx.agent,
        payload: {
          ref: input.ref,
          docId: input.docId,
          owner: input.owner,
          offset: input.offset,
          packetId: input.packetId,
        },
      });
    },
  });
}

if (import.meta.main) {
  const observer = new AgentMcpObserver();
  console.log("Starting MCP Server with live agent observation hooks on stdio...");
  const { server } = await createObservedServer({}, observer);
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
