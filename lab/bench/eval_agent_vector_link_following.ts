import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ensureVault, atomicWrite } from "@/storage/vault";
import {
  chatCompletion,
  resolveGatewayConfig,
  type ChatMessage,
} from "./beam_harness/gateway";
import { createLocalMcpClient } from "../local_mcp_client";

export type VectorLinkTestCase = {
  id: number;
  name: string;
  question: string;
  targetDocId: string;
  notes: { filename: string; subdir: "memories" | "experiences" | "skills"; content: string }[];
  expectedHops: 1 | 2;
  rationale: string;
};

export const VECTOR_LINK_CASES: VectorLinkTestCase[] = [
  {
    id: 1,
    name: "1-hop latent link from audio buffer seed to persistence rate limit",
    question: "A high-frequency telemetry burst arrives from IoT gateways. We acknowledge receipt immediately into local memory, but write to disk at a capped rate. What exact maximum durable write rate is supported?",
    targetDocId: "mem-db-batch-073",
    expectedHops: 2,
    rationale: "Query hits mem-audio-clock-071 or mem-ingest-bridge-072 via vector semantics, then 2-hop links lead to mem-db-batch-073 (300 commits/sec).",
    notes: [
      {
        subdir: "skills",
        filename: "mem-audio-clock-071.md",
        content: `---
id: mem-audio-clock-071
kind: skill
status: active
---

# Clock-Domain Isolation

When two components advance under independent clocks, never couple correctness to simultaneous progress. Insert finite handoff region between them.

Connected system constraints: [[mem-ingest-bridge-072]].
`,
      },
      {
        subdir: "experiences",
        filename: "mem-ingest-bridge-072.md",
        content: `---
id: mem-ingest-bridge-072
kind: experience
status: active
source_refs: mem-audio-clock-071; mem-db-batch-073
---

# Telemetry Ingest Observation

Admission and durable processing were decoupled across clock boundaries.
Downstream persistence bottleneck: [[mem-db-batch-073]].
`,
      },
      {
        subdir: "memories",
        filename: "mem-db-batch-073.md",
        content: `---
id: mem-db-batch-073
kind: memory
status: active
---

# Current Persistence Constraint

The ledger database supports at most 300 durable commits/sec before tail latency becomes nonlinear.
`,
      },
    ],
  },
  {
    id: 2,
    name: "2-hop rename chain: legacy Orchid limit reached via Relay alias",
    question: "We are configuring Courier's outstanding delivery lease pool. What is the historical maximum limit established when the system was originally architected?",
    targetDocId: "mem-orchid-limit-122",
    expectedHops: 1,
    rationale: "Vector search finds Courier/Relay rename record, 1-2 hops reveal Orchid 2048 lease limit.",
    notes: [
      {
        subdir: "memories",
        filename: "mem-service-rename-121.md",
        content: `---
id: mem-service-rename-121
kind: memory
status: active
source_refs: mem-orchid-limit-122; mem-courier-new-123
---

# Service Rename Chain

"Orchid" -> "Relay" -> "Courier".
All refer to the same delivery service.
Historical limits: [[mem-orchid-limit-122]].
Recent configuration: [[mem-courier-new-123]].
`,
      },
      {
        subdir: "memories",
        filename: "mem-orchid-limit-122.md",
        content: `---
id: mem-orchid-limit-122
kind: memory
status: active
---

# Orchid Throughput Constraint

Maximum safe outstanding delivery leases: 2048.
`,
      },
      {
        subdir: "memories",
        filename: "mem-courier-new-123.md",
        content: `---
id: mem-courier-new-123
kind: memory
status: active
---

# Courier Batch Size

Default outbound batch: 128 messages.
`,
      },
    ],
  },
  {
    id: 3,
    name: "10-year-old clustered memory linked from modern architecture note",
    question: "We hit an obscure POSIX FIFO pipe buffer wrap-around deadlock on Linux kernel 6.x. I recall solving this exact non-blocking edge-case in an ancient C daemon decade ago. What was the exact workaround?",
    targetDocId: "mem-legacy-fifo-2016",
    expectedHops: 2,
    rationale: "Recent IPC note links to legacy kernel workarounds where exact O_NONBLOCK + epoll drain pattern is recorded.",
    notes: [
      {
        subdir: "skills",
        filename: "mem-modern-ipc-2026.md",
        content: `---
id: mem-modern-ipc-2026
kind: skill
status: active
---

# Modern IPC Architecture

Fast local IPC uses Unix domain sockets or shared memory ringbuffers.
For pipe/FIFO fallback mechanisms, see historical kernel diagnostics: [[mem-bridge-fifo-diagnostics]].
`,
      },
      {
        subdir: "experiences",
        filename: "mem-bridge-fifo-diagnostics.md",
        content: `---
id: mem-bridge-fifo-diagnostics
kind: experience
status: active
source_refs: mem-modern-ipc-2026; mem-legacy-fifo-2016
---

# Linux Pipe Buffer Sizing Incident

When pipe buffers fill under asymmetric producer scheduling, write(2) blocks even with partial space if packet size exceeds PIPE_BUF (4096 bytes).
Archived root resolution: [[mem-legacy-fifo-2016]].
`,
      },
      {
        subdir: "memories",
        filename: "mem-legacy-fifo-2016.md",
        content: `---
id: mem-legacy-fifo-2016
kind: memory
status: active
updated: 2016-04-12T00:00:00.000Z
---

# Linux FIFO Deadlock Resolution (2016)

To prevent circular wait on full pipe buffers:
1. Open FIFO with O_NONBLOCK | O_RDWR.
2. Chunk all writes to <= 4096 bytes (atomic write boundary).
3. Drain reader eagerly on EPOLLIN before scheduling subsequent writes.
`,
      },
    ],
  },
];

export async function runVectorLinkEval() {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "consol-vector-link-eval-"));
  try {
    const agent = "tester";
    const { agentRoot } = await ensureVault(tmpVault, agent);

    for (const tc of VECTOR_LINK_CASES) {
      for (const n of tc.notes) {
        const p = path.join(agentRoot, n.subdir, n.filename);
        await atomicWrite(p, n.content);
      }
    }

    const client = await createLocalMcpClient(tmpVault, agent);
    const cfg = resolveGatewayConfig();

    console.log("========================================================");
    console.log("MID-REASONING MEMORY RECALL & VECTOR LINK FOLLOWING EVAL");
    console.log("========================================================");

    let passCount = 0;

    for (const tc of VECTOR_LINK_CASES) {
      console.log(`\n[Vector Link Case ${tc.id}] ${tc.name}`);
      const messages: ChatMessage[] = [
        { role: "system", content: client.instructions },
        { role: "user", content: tc.question },
      ];

      let targetRetrieved = false;
      let targetRead = false;
      const toolLogs: string[] = [];
      let finalAnswer = "";

      for (let round = 0; round < 6; round++) {
        const res = await chatCompletion(cfg, cfg.answerModel, messages, {
          tools: client.tools,
          toolChoice: "auto",
          temperature: 0.1,
          maxTokens: 1024,
        });

        const msg = res.message;
        messages.push(msg);

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalAnswer = msg.content || "";
          break;
        }

        for (const call of msg.tool_calls) {
          let args: any = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
          toolLogs.push(`${call.function.name}(${JSON.stringify(args)})`);

          const toolResult = await client.callTool(call.function.name, args);

          if (toolResult.includes(tc.targetDocId)) {
            targetRetrieved = true;
          }
          if (call.function.name === "read" && args.id === tc.targetDocId) {
            targetRead = true;
          }

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult,
          });
        }
      }

      const passed = targetRetrieved && (targetRead || finalAnswer.length > 0);
      if (passed) passCount++;

      console.log(`  Target Doc:      ${tc.targetDocId}`);
      console.log(`  Target Found:    ${targetRetrieved ? "YES" : "NO"}`);
      console.log(`  Target Read:     ${targetRead ? "YES" : "NO"}`);
      console.log(`  Tools Sequence:  ${toolLogs.join(" -> ")}`);
      console.log(`  Answer Excerpt:  ${finalAnswer.slice(0, 160).replace(/\n/g, " ")}...`);
    }

    console.log("\n========================================================");
    console.log(`VECTOR LINK SCORE: ${passCount} / ${VECTOR_LINK_CASES.length} (${((passCount / VECTOR_LINK_CASES.length) * 100).toFixed(1)}%)`);
    console.log("========================================================");
    client.close();
  } finally {
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  }
}

if (import.meta.main) {
  await runVectorLinkEval();
}
