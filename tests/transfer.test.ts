import { describe, test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { atomicWrite, ensureVault } from "@/vault";
import { openIndex, syncVault, setEmbedderForTests } from "@/index";
import { recall } from "@/retrieval";
import { remember } from "@/memory";
import { Budgets } from "@/config";
import { abstractionLevel, nearDuplicateStatement, tokenEstimate, transferBoost, valuePerToken } from "@/transfer";

describe("transfer invariants", () => {
  test("reusable kinds outrank specifics; watermelon still recalls irrigate principle", async () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "watermelon-invariants-"));
    setEmbedderForTests(async (texts: string[]) => ({
      tolist: () => texts.map((t) => {
        const v = Array(384).fill(0.01);
        if (t.includes("irrigate") || t.includes("water") || t.includes("Grow")) v[0] = 0.9;
        return v;
      }),
    }), vault);
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await remember(vault, agentRoot, "alice", { statement: "Grow 🍌 banana: irrigate deeply, mulch, stagger sowings." });
      await remember(vault, agentRoot, "alice", { statement: "Grow 🍓 strawberry: irrigate deeply, mulch for moisture." });
      await atomicWrite(path.join(agentRoot, "skills", "irrigate-principle.md"), `---\nid: irrigate-principle\nkind: skill\nstatus: active\nsource_refs: banana-case, strawberry-case\n---\nIrrigate deeply and mulch to retain moisture.\n`);
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");
      const budgets = Budgets.parse({ perArmCap: 12, quotas: { memory: 8, experience: 8, case: 4, skill: 8 } });
      const packet = await recall(db, vault, "how to grow 🍉 watermelon", budgets, "agent:alice");
      expect(packet.items.some((item) => item.docId === "irrigate-principle")).toBe(true);
      db.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }, 15000);

  test("nearDuplicate compresses but does not collapse distinct tasks", () => {
    expect(nearDuplicateStatement("Grow 🍌 banana: irrigate deeply, mulch, stagger sowings.", "Grow 🍌 banana irrigate deeply, mulch, stagger sowings")).toBe(true);
    expect(nearDuplicateStatement("Grow 🍌 banana: irrigate deeply, mulch", "Grow 🍉 watermelon: irrigate deeply, mulch")).toBe(false);
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
