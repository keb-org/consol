import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Budgets } from "../src/config";
import { openIndex, syncVault } from "../src/index";
import { record, recordConsultedUsage, recordRecallUsage } from "../src/memory";
import { getRetrievalUsage, readChunk, recall } from "../src/retrieval";
import { atomicWrite, ensureVault } from "../src/vault";

function tmp(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function usageRecords(agentRoot: string) {
  const text = await readFile(path.join(agentRoot, "audit", "usage.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

describe("usage attribution", () => {
  test("retrieval, packet inclusion, and consultation remain separate", async () => {
    const vault = tmp("usage-attribution-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      for (let i = 0; i < 24; i++) {
        await atomicWrite(
          path.join(agentRoot, "memories", `deploy-${i}.md`),
          `---\nid: deploy-${i}\nkind: memory\n---\nDeployment rollback fixture ${i}\n`,
        );
      }
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");
      const budgets = Budgets.parse({
        perArmCap: 20,
        quotas: { memory: 10, experience: 0, case: 0, skill: 0, inbox: 0 },
      });
      const packet = await recall(db, vault, "deployment rollback", budgets, "agent:alice");
      const retrieved = getRetrievalUsage(packet);
      expect(retrieved.length).toBeGreaterThan(packet.items.length);

      await recordRecallUsage(vault, agentRoot, "alice", packet, retrieved);
      const first = readChunk(db, packet.items[0].ref, budgets);
      await recordConsultedUsage(vault, agentRoot, "alice", {
        ref: packet.items[0].ref,
        docId: first.docId,
        owner: first.owner,
        offset: first.offset,
        packetId: packet.id,
      });

      const records = await usageRecords(agentRoot);
      expect(records.find((entry) => entry.stage === "retrieved")?.items).toHaveLength(retrieved.length);
      expect(records.find((entry) => entry.stage === "packet-included")?.items).toHaveLength(packet.items.length);
      expect(records.some((entry) => Object.hasOwn(entry, "query"))).toBe(false);
      expect(records.some((entry) => Object.hasOwn(entry, "queryHash"))).toBe(false);
      expect(records.filter((entry) => entry.stage === "consulted")).toHaveLength(1);
      expect(records.find((entry) => entry.stage === "consulted")?.packetId).toBe(packet.id);
      expect(records.some((entry) => entry.stage === "applied")).toBe(false);
      db.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }, 15000);

  test("raw recall query is never persisted", async () => {
    const vault = tmp("usage-query-private-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await atomicWrite(
        path.join(agentRoot, "memories", "private-query.md"),
        "---\nid: private-query\nkind: memory\n---\nprivate query fixture\n",
      );
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");
      const query = "password=do-not-persist-this-value";
      const packet = await recall(db, vault, query, Budgets.parse({}), "agent:alice");
      expect(JSON.stringify(packet)).not.toContain(query);
      expect(Object.hasOwn(packet, "query")).toBe(false);
      await recordRecallUsage(vault, agentRoot, "alice", packet, getRetrievalUsage(packet));
      const stored = await readFile(path.join(agentRoot, "audit", "usage.jsonl"), "utf8");
      expect(stored).not.toContain(query);
      expect(stored).not.toContain("do-not-persist-this-value");
      db.close();
    } finally {
      try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }, 15000);

  test("outcome requires evaluator and only explicit refs become applied", async () => {
    const vault = tmp("usage-outcome-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await expect(record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "success" },
      })).rejects.toThrow("evaluator");
      await expect(record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "success", evaluator: "pass", appliedRefs: ["ref-a"] },
      })).rejects.toThrow("appliedRefs must also appear in refs");

      const outcome = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        refs: ["ref-a", "ref-b"],
        data: {
          task: "deploy",
          outcome: "success",
          evaluator: "pass",
          observableOutcome: "smoke test passed",
          appliedRefs: ["ref-a"],
        },
      });
      expect(outcome.data.appliedRefs).toEqual(["ref-a"]);
      expect(outcome.refs).toEqual(["ref-a", "ref-b"]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("case records require decision-bearing fields", async () => {
    const vault = tmp("usage-case-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await expect(record(vault, agentRoot, "alice", {
        kind: "case",
        data: { task: "deploy" },
      })).rejects.toThrow("case rootSource required");

      const caseRecord = await record(vault, agentRoot, "alice", {
        kind: "case",
        refs: ["session-1"],
        data: {
          rootSource: "session-1",
          task: "deploy",
          environment: "bun-1.3.14/windows",
          expectation: "service stays healthy",
          action: "run staged deploy",
          appliedRefs: [],
          observableOutcome: "health checks passed",
          outcome: "success",
          evaluator: "smoke-test",
        },
      });
      expect(caseRecord.kind).toBe("case");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
