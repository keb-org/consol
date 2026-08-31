export interface ToolCallTrace {
  timestamp: number;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  tokensEstimate: number;
  resultSummary?: string;
  error?: string;
}

export interface TurnTelemetry {
  turnIndex: number;
  input: string;
  output: string;
  toolCalls: ToolCallTrace[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface ExperimentMetrics {
  totalTurns: number;
  totalToolCalls: number;
  totalTokensEstimate: number;
  recallsBeforeDecisions: number;
  recordsAfterActions: number;
  protocolAdherenceRate: number;
  averageRecallLatencyMs: number;
  unauthorizedRefErrors: number;
  turns: TurnTelemetry[];
}

export class LabTelemetryCollector {
  private turns: TurnTelemetry[] = [];
  private currentTurnToolCalls: ToolCallTrace[] = [];

  recordToolCall(trace: ToolCallTrace): void {
    this.currentTurnToolCalls.push(trace);
  }

  completeTurn(turn: { turnIndex: number; input: string; output: string; tokensIn?: number; tokensOut?: number; latencyMs?: number }): void {
    this.turns.push({
      turnIndex: turn.turnIndex,
      input: turn.input,
      output: turn.output,
      toolCalls: [...this.currentTurnToolCalls],
      tokensIn: turn.tokensIn ?? 0,
      tokensOut: turn.tokensOut ?? 0,
      latencyMs: turn.latencyMs ?? 0,
    });
    this.currentTurnToolCalls = [];
  }

  computeMetrics(): ExperimentMetrics {
    let totalToolCalls = 0;
    let totalTokens = 0;
    let recallLatencies: number[] = [];
    let recallsCount = 0;
    let recordsCount = 0;
    let protocolAdheredTurns = 0;
    let unauthorizedErrors = 0;

    for (const turn of this.turns) {
      totalToolCalls += turn.toolCalls.length;
      let hasRecall = false;
      let hasRecordOrRemember = false;

      for (const call of turn.toolCalls) {
        totalTokens += call.tokensEstimate;
        if (call.tool === "recall") {
          hasRecall = true;
          recallsCount++;
          recallLatencies.push(call.durationMs);
        }
        if (call.tool === "record" || call.tool === "remember") {
          hasRecordOrRemember = true;
          recordsCount++;
        }
        if (call.error?.includes("unauthorized")) {
          unauthorizedErrors++;
        }
      }

      if (hasRecall) protocolAdheredTurns++;
    }

    const avgLatency = recallLatencies.length
      ? recallLatencies.reduce((a, b) => a + b, 0) / recallLatencies.length
      : 0;

    return {
      totalTurns: this.turns.length,
      totalToolCalls,
      totalTokensEstimate: totalTokens,
      recallsBeforeDecisions: recallsCount,
      recordsAfterActions: recordsCount,
      protocolAdherenceRate: this.turns.length ? protocolAdheredTurns / this.turns.length : 1.0,
      averageRecallLatencyMs: Math.round(avgLatency * 100) / 100,
      unauthorizedRefErrors: unauthorizedErrors,
      turns: this.turns,
    };
  }

  summary(): string {
    const m = this.computeMetrics();
    return [
      `--- Lab Telemetry Summary ---`,
      `Turns: ${m.totalTurns} | Tool Calls: ${m.totalToolCalls}`,
      `Protocol Adherence: ${(m.protocolAdherenceRate * 100).toFixed(1)}%`,
      `Recalls: ${m.recallsBeforeDecisions} | Records: ${m.recordsAfterActions}`,
      `Avg Recall Latency: ${m.averageRecallLatencyMs}ms`,
      `Est Token Overhead: ${m.totalTokensEstimate} bytes`,
      `Errors (Unauthorized): ${m.unauthorizedRefErrors}`,
    ].join("\n");
  }
}
