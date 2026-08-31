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
import { TEST_CASES, evaluateRetrievedIds, type RetrievalTestCase, type RetrievalVerdict } from "./retrieval_transfer_cases";

export type AgentCaseRunResult = {
  id: number;
  category: string;
  recalled: boolean;
  retrievalVerdict: RetrievalVerdict;
  allRetrievedIds: string[];
  toolCallLogs: string[];
  finalAnswer: string;
  rounds: number;
};

export async function runAgentTestCase(tc: RetrievalTestCase, tmpVault: string): Promise<AgentCaseRunResult> {
  const agent = "tester";
  const client = await createLocalMcpClient(tmpVault, agent);
  const cfg = resolveGatewayConfig();

  const messages: ChatMessage[] = [
    { role: "system", content: client.instructions },
    { role: "user", content: tc.question },
  ];

  let recalled = false;
  let finalAnswer = "";
  const toolCallLogs: string[] = [];
  const allRetrievedIdsSet = new Set<string>();

  try {
    let rounds = 0;
    for (let round = 0; round < 6; round++) {
      rounds++;
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
        toolCallLogs.push(`${call.function.name}(${JSON.stringify(args)})`);

        if (call.function.name === "recall") {
          recalled = true;
        }

        const toolResultText = await client.callTool(call.function.name, args);

        const docIdMatches = toolResultText.matchAll(/\[(mem-[a-z0-9-]+)\]/g);
        for (const m of docIdMatches) {
          allRetrievedIdsSet.add(m[1]);
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResultText,
        });
      }
    }

    const allRetrievedIds = [...allRetrievedIdsSet];
    const retrievalVerdict = evaluateRetrievedIds(allRetrievedIds, tc.expectation);

    return {
      id: tc.id,
      category: tc.category,
      recalled,
      retrievalVerdict,
      allRetrievedIds,
      toolCallLogs,
      finalAnswer,
      rounds,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "consol-agent-eval-20cases-"));
  try {
    const agent = "tester";
    const { agentRoot } = await ensureVault(tmpVault, agent);

    for (const tc of TEST_CASES) {
      for (const n of tc.notes) {
        const p = path.join(agentRoot, n.subdir, n.filename);
        await atomicWrite(p, n.content);
      }
    }

    console.log(`Running full end-to-end agent evaluation across all 20 cases on model: ${process.env.LLM_ANSWER_MODEL || "claude-haiku-4-6"}...\n`);

    const results: AgentCaseRunResult[] = [];
    let retrievalPassCount = 0;

    for (const tc of TEST_CASES) {
      console.log(`Evaluating [Case ${tc.id}] ${tc.category}...`);
      const r = await runAgentTestCase(tc, tmpVault);
      results.push(r);
      if (r.retrievalVerdict.pass) retrievalPassCount++;
    }

    console.log("\n========================================================");
    console.log("AGENT EVALUATION RESULTS SUMMARY (20 CASES)");
    console.log("========================================================");
    for (const r of results) {
      console.log(`\n[Case ${r.id}] ${r.category}`);
      console.log(`  Recall Called:    ${r.recalled ? "YES" : "NO"}`);
      console.log(`  Retrieval Pass:   ${r.retrievalVerdict.pass ? "PASS" : "FAIL"}`);
      if (!r.retrievalVerdict.pass) {
        if (r.retrievalVerdict.missing.length) console.log(`  Missing:          [${r.retrievalVerdict.missing.join(", ")}]`);
        if (r.retrievalVerdict.missingAny.length) console.log(`  MissingAny:       [${r.retrievalVerdict.missingAny.join(", ")}]`);
        if (r.retrievalVerdict.forbidden.length) console.log(`  Forbidden:        [${r.retrievalVerdict.forbidden.join(", ")}]`);
      }
      console.log(`  Retrieved IDs:    [${r.allRetrievedIds.join(", ")}]`);
      console.log(`  Tools Executed:   ${r.toolCallLogs.join(" -> ")}`);
      console.log(`  Answer Preview:   ${r.finalAnswer.slice(0, 180).replace(/\n/g, " ")}...`);
    }

    console.log("\n========================================================");
    console.log(`AGENT RETRIEVAL SCORE: ${retrievalPassCount} / ${TEST_CASES.length} (${((retrievalPassCount / TEST_CASES.length) * 100).toFixed(1)}%)`);
    console.log("========================================================");
  } finally {
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  }
}

if (import.meta.main) {
  await main();
}
