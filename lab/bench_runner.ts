import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { LabAgentHarness } from "./harness";

export async function runProtocolSimulation(name = "standard-task-flow") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "consol-lab-"));
  const harness = new LabAgentHarness({ vault: tempDir, agent: "lab-tester" });

  console.log(`[Lab] Starting experiment: ${name}`);
  await harness.setup();

  // Phase 1: Pre-task continuous recall
  console.log("[Lab] Simulating agent turn 1: Context retrieval before task execution...");
  const t0 = performance.now();
  await harness.callRecall('"v1.2.0" configuration postgres');
  harness.telemetry.completeTurn({
    turnIndex: 1,
    input: "Configure PostgreSQL connection pool for v1.2.0 release",
    output: "Recalled database constraints. Preparing connection configuration.",
    latencyMs: performance.now() - t0,
  });

  // Phase 2: Memory write & task execution
  console.log("[Lab] Simulating agent turn 2: Writing durable knowledge...");
  const t1 = performance.now();
  const mem = await harness.callRemember(
    "[Date: 2026-08-31] Set max_connections=50 on PostgreSQL pool for v1.2.0 to avoid memory exhaustion.",
    "infrastructure"
  );
  harness.telemetry.completeTurn({
    turnIndex: 2,
    input: "Document PostgreSQL memory pool rule",
    output: `Persisted note ${mem.docId}`,
    latencyMs: performance.now() - t1,
  });

  // Phase 3: Post-action outcome recording
  console.log("[Lab] Simulating agent turn 3: Appending post-task evaluation evidence...");
  const t2 = performance.now();
  await harness.callRecord("outcome", {
    evaluator: "pass",
    outcome: "success",
    metrics: { p99LatencyMs: 14.2, connPoolExhaustion: 0 },
  });
  harness.telemetry.completeTurn({
    turnIndex: 3,
    input: "Record deployment outcome",
    output: "Evidence appended for downstream distillation.",
    latencyMs: performance.now() - t2,
  });

  harness.close();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  console.log("\n" + harness.telemetry.summary());
  return harness.telemetry.computeMetrics();
}

if (import.meta.main) {
  runProtocolSimulation().catch(console.error);
}
