import { Database } from "bun:sqlite";
import { ensureVault } from "@/storage/vault";
import { openIndex } from "@/storage/index/schema";
import { syncVault } from "@/storage/index/sync";
import { recall, readChunk, type Packet } from "@/retrieval";
import { remember, record } from "@/lifecycle/write";
import { resolveConfig } from "@/core/config";
import { LabTelemetryCollector, type ToolCallTrace } from "@lab/telemetry";

export interface LabAgentHarnessConfig {
  vault: string;
  agent: string;
  systemPrompt?: string;
}

export class LabAgentHarness {
  private db: Database | null = null;
  private vault: string;
  private agent: string;
  private aRoot: string = "";
  public telemetry = new LabTelemetryCollector();

  constructor(config: LabAgentHarnessConfig) {
    this.vault = config.vault;
    this.agent = config.agent;
  }

  async setup(): Promise<void> {
    const { agentRoot } = await ensureVault(this.vault, this.agent);
    this.aRoot = agentRoot;
    this.db = openIndex(agentRoot);
    await syncVault(this.db, this.vault, this.aRoot, this.agent).catch(() => {});
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async callRecall(query: string, mode: "auto" | "facts" | "guidance" | "history" = "auto"): Promise<Packet> {
    if (!this.db) throw new Error("Harness not initialized. Run setup() first.");
    const start = performance.now();
    const config = resolveConfig({ vault: this.vault, agent: this.agent });
    let errorStr: string | undefined;
    let packet: Packet;
    try {
      packet = await recall(this.db, this.vault, query, config.budgets, `agent:${this.agent}`, mode);
    } catch (e: any) {
      errorStr = e?.message ?? String(e);
      throw e;
    } finally {
      const durationMs = performance.now() - start;
      const trace: ToolCallTrace = {
        timestamp: Date.now(),
        tool: "recall",
        args: { query, mode },
        durationMs,
        tokensEstimate: packet!?.attribution?.packetBytes ?? 0,
        resultSummary: packet! ? `${packet!.items.length} items (fused: ${packet!.attribution.fused})` : undefined,
        error: errorStr,
      };
      this.telemetry.recordToolCall(trace);
    }
    return packet;
  }

  async callRead(ref: string, cursor?: string): Promise<any> {
    if (!this.db) throw new Error("Harness not initialized. Run setup() first.");
    const start = performance.now();
    const config = resolveConfig({ vault: this.vault, agent: this.agent });
    let errorStr: string | undefined;
    let res: any;
    try {
      res = readChunk(this.db, ref, config.budgets, cursor);
    } catch (e: any) {
      errorStr = e?.message ?? String(e);
      throw e;
    } finally {
      const durationMs = performance.now() - start;
      this.telemetry.recordToolCall({
        timestamp: Date.now(),
        tool: "read",
        args: { ref, cursor },
        durationMs,
        tokensEstimate: res ? Buffer.byteLength(res.text, "utf8") : 0,
        resultSummary: res ? `docId: ${res.docId} offset: ${res.offset} remaining: ${res.remainingBytes}` : undefined,
        error: errorStr,
      });
    }
    return res;
  }

  async callRemember(statement: string, scope?: string, refs?: string[]): Promise<any> {
    if (!this.db) throw new Error("Harness not initialized. Run setup() first.");
    const start = performance.now();
    let errorStr: string | undefined;
    let res: any;
    try {
      res = await remember(this.vault, this.aRoot, this.agent, { statement, scope, refs }, this.db);
    } catch (e: any) {
      errorStr = e?.message ?? String(e);
      throw e;
    } finally {
      const durationMs = performance.now() - start;
      this.telemetry.recordToolCall({
        timestamp: Date.now(),
        tool: "remember",
        args: { statement, scope, refs },
        durationMs,
        tokensEstimate: Buffer.byteLength(statement, "utf8"),
        resultSummary: res ? `action: ${res.action} docId: ${res.docId}` : undefined,
        error: errorStr,
      });
    }
    return res;
  }

  async callRecord(kind: "observation" | "action" | "feedback" | "result" | "outcome" | "case" | "correction", data: Record<string, unknown>, refs?: string[]): Promise<any> {
    const start = performance.now();
    let errorStr: string | undefined;
    let res: any;
    try {
      res = await record(this.vault, this.aRoot, this.agent, { kind, data, refs });
    } catch (e: any) {
      errorStr = e?.message ?? String(e);
      throw e;
    } finally {
      const durationMs = performance.now() - start;
      this.telemetry.recordToolCall({
        timestamp: Date.now(),
        tool: "record",
        args: { kind, data, refs },
        durationMs,
        tokensEstimate: Buffer.byteLength(JSON.stringify(data), "utf8"),
        resultSummary: res ? `id: ${res.id} kind: ${res.kind}` : undefined,
        error: errorStr,
      });
    }
    return res;
  }
}
