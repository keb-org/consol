import { describe, test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { atomicWrite, ensureVault } from "../src/vault";
import { openIndex, syncVault } from "../src/index";
import { recall } from "../src/retrieval";
import { remember } from "../src/memory";
import { Budgets } from "../src/config";
import { abstractionLevel, nearDuplicateStatement, tokenEstimate, transferBoost, valuePerToken } from "../src/transfer";

describe("transfer invariants", () => {
  test("reusable kinds outrank specifics; watermelon still recalls irrigate principle", async () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "watermelon-invariants-"));
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await remember(vault, agentRoot, "alice", { statement: "Grow wheat: irrigate deeply, mulch, stagger sowings." });
      await remember(vault, agentRoot, "alice", { statement: "Grow strawberry: irrigate deeply, mulch for moisture." });
      await atomicWrite(path.join(agentRoot, "skills", "irrigate-principle.md"), `---\nid: irrigate-principle\nkind: skill\nstatus: active\nsource_refs: wheat-case, strawberry-case\n---\nIrrigate deeply and mulch to retain moisture.\n`);
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");
      const budgets = Budgets.parse({ perArmCap: 12, quotas: { memory: 8, experience: 8, case: 4, skill: 8 } });
      const packet = await recall(db, vault, "how to grow watermelon", budgets, "agent:alice");
      expect(packet.items.some((item) => item.docId === "irrigate-principle")).toBe(true);
      db.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }, 15000);

  test("nearDuplicate compresses but does not collapse distinct tasks", () => {
    expect(nearDuplicateStatement("Grow wheat: irrigate deeply, mulch, stagger sowings.", "Grow wheat irrigate deeply, mulch, stagger sowings")).toBe(true);
    expect(nearDuplicateStatement("Grow wheat: irrigate deeply, mulch", "Grow watermelon: irrigate deeply, mulch")).toBe(false);
  });

  test("token efficiency: reusable principle has higher valuePerToken than one-offs", () => {
    const principle = valuePerToken(8, 2, 900);
    const onOff = valuePerToken(1, 0, 900);
    expect(principle).toBeGreaterThan(onOff * 2);
    expect(tokenEstimate("hello world")).toBeGreaterThan(0);
  });

  test("transferBoost prefers reusable/active when lexical is sparse", () => {
    const sparsePrinciple = transferBoost({ kind: "skill", status: "active", sourceCount: 2, distinctRoots: 2, lexicalCoverage: 0, perArmCap: 10 });
    const sparseSpecific = transferBoost({ kind: "memory", status: "candidate", sourceCount: 0, lexicalCoverage: 0, perArmCap: 10 });
    const densePrinciple = transferBoost({ kind: "skill", status: "active", sourceCount: 2, distinctRoots: 2, lexicalCoverage: 10, perArmCap: 10 });
    expect(sparsePrinciple).toBeGreaterThan(sparseSpecific);
    expect(sparsePrinciple).toBeGreaterThan(densePrinciple);
  });

  test("abstractionLevel gates skills on distinct roots", () => {
    expect(abstractionLevel("skill", 1, 1)).toBe("specific");
    expect(abstractionLevel("skill", 2, 2)).toBe("principle");
    expect(abstractionLevel("experience", 2, 1)).toBe("pattern");
  });
});
