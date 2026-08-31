import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ensureVault, atomicWrite } from "@/storage/vault";
import { openIndex } from "@/storage/index/schema";
import { syncVault } from "@/storage/index/sync";
import { recall, type RecallMode } from "@/retrieval";
import { resolveConfig } from "@/core/config";
import { TEST_CASES, evaluateRetrievedIds, type RetrievalTestCase } from "./retrieval_transfer_cases";

export async function runTestCase(tc: RetrievalTestCase, tmpVault: string, agent = "tester") {
  const config = resolveConfig({ vault: tmpVault, agent });
  const { agentRoot } = await ensureVault(tmpVault, agent);

  for (const n of tc.notes) {
    const p = path.join(agentRoot, n.subdir, n.filename);
    await atomicWrite(p, n.content);
  }

  const db = openIndex(agentRoot);
  try {
    await syncVault(db, tmpVault, agentRoot, agent);
    const start = performance.now();
    const packet = await recall(db, tmpVault, tc.question, config.budgets, `agent:${agent}`, "auto");
    const durationMs = Math.round(performance.now() - start);
    const returnedIds = packet.items.map((i) => i.docId);
    const verdict = evaluateRetrievedIds(returnedIds, tc.expectation);

    return {
      tc,
      verdict,
      returnedIds,
      packet,
      durationMs,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "consol-retrieval-20cases-"));
  try {
    console.log(`Running full 20-case retrieval transfer & gating benchmark (Noise decoys: ${process.env.RETRIEVAL_EVAL_DECOYS ?? 100})...\n`);

    let passedCount = 0;
    const results = [];

    for (const tc of TEST_CASES) {
      const res = await runTestCase(tc, tmpVault);
      results.push(res);
      if (res.verdict.pass) passedCount++;

      console.log(`[Case ${tc.id}] ${tc.category}`);
      console.log(`  Verdict:  ${res.verdict.pass ? "PASS" : "FAIL"}`);
      if (!res.verdict.pass) {
        if (res.verdict.missing.length) console.log(`  Missing:   [${res.verdict.missing.join(", ")}]`);
        if (res.verdict.missingAny.length) console.log(`  MissingAny:[${res.verdict.missingAny.join(", ")}]`);
        if (res.verdict.forbidden.length) console.log(`  Forbidden: [${res.verdict.forbidden.join(", ")}]`);
        if (res.verdict.emptyViolation) console.log(`  EmptyViolation: returned items when expected empty`);
      }
      console.log(`  Returned: [${res.returnedIds.join(", ")}]`);
      console.log(`  Latency:  ${res.durationMs}ms | Items: ${res.packet.items.length} | Bytes: ${res.packet.attribution.packetBytes}`);
      console.log("");
    }

    console.log("==========================================");
    console.log(`FINAL RETRIEVAL SCORE: ${passedCount} / ${TEST_CASES.length} (${((passedCount / TEST_CASES.length) * 100).toFixed(1)}%)`);
    console.log("==========================================");
  } finally {
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  }
}

if (import.meta.main) {
  await main();
}
