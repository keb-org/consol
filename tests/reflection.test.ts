import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  rollbackRevision,
  selectEvidence,
  stageProposals,
  transitionCandidate,
  validateProposal,
  type EvidenceRecord,
  type Job,
  type Proposal,
} from "@/reflection";
import { record } from "@/memory";
import { atomicWrite, ensureVault, hashContent } from "@/vault";

function tmp(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function writeJob(agentRoot: string, jobId: string, evidence: EvidenceRecord[], items: any[] = []) {
  const job: Job = {
    id: jobId,
    createdAt: new Date().toISOString(),
    status: "pending",
    packet: { query: "deploy failure", items, evidence },
  };
  await atomicWrite(path.join(agentRoot, "jobs", `${jobId}.json`), JSON.stringify(job, null, 2));
}

function skip(evidenceId: string): Proposal {
  return {
    id: `skip-${evidenceId}`,
    action: "skip",
    sourceRefs: [evidenceId],
    rationale: "No durable rule follows from this isolated outcome.",
  };
}

describe("reflection validation", () => {
  test("rejects missing rationale", () => {
    const result = validateProposal({
      id: "p1",
      action: "create",
      targetId: "new-rule",
      sourceRefs: ["s1"],
      after: "x",
      rationale: "",
    }, "/tmp");
    expect(result).toEqual({ ok: false, reason: "missing rationale" });
  });

  test("update requires target snapshot hash", () => {
    const missing = validateProposal({
      id: "p1",
      action: "update",
      targetId: "rule",
      rationale: "fix scope",
      sourceRefs: ["s1"],
      after: "new content",
    }, "/tmp");
    expect(missing).toEqual({ ok: false, reason: "missing baseHash" });

    const before = "original";
    const stale = validateProposal({
      id: "p2",
      action: "update",
      targetId: "rule",
      rationale: "fix scope",
      sourceRefs: ["s1"],
      before,
      baseHash: "a".repeat(64),
      after: "new content",
    }, "/tmp");
    expect(stale).toEqual({ ok: false, reason: "stale baseHash" });
  });

  test("rejects self-citation and unsupported lifecycle actions", () => {
    expect(validateProposal({
      id: "p1",
      action: "create",
      targetId: "s1",
      rationale: "r",
      sourceRefs: ["s1"],
      after: "rule",
    }, "/tmp")).toEqual({ ok: false, reason: "self-citation" });
    expect(validateProposal({
      id: "p2",
      action: "promote",
      targetId: "x",
      rationale: "r",
      sourceRefs: ["s1"],
    } as any, "/tmp")).toEqual({ ok: false, reason: "unsupported action" });
  });

  test("no-op reflection stays retryable and leaves evidence unreviewed", async () => {
    const vault = tmp("reflection-noop-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      await writeJob(agentRoot, "job-noop", [evidence]);
      const result = await stageProposals(
        vault,
        agentRoot,
        "job-noop",
        [],
        undefined,
        { runner: "none", diagnostics: ["claude: unavailable"] },
      );
      expect(result).toMatchObject({ reviewed: 0, retryable: true, reason: "no reflection runner succeeded" });
      expect((await selectEvidence(agentRoot)).map((record) => record.id)).toContain(evidence.id);
      const job = JSON.parse(await readFile(path.join(agentRoot, "jobs", "job-noop.json"), "utf8"));
      expect(job.status).toBe("failed");
      expect(job.failure.diagnostics).toEqual(["claude: unavailable"]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("invalid proposal stays retryable and records rejection", async () => {
    const vault = tmp("reflection-invalid-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      await writeJob(agentRoot, "job-invalid", [evidence]);
      const result = await stageProposals(vault, agentRoot, "job-invalid", [{
        id: "bad",
        action: "create",
        targetId: "bad/rule",
        sourceRefs: [evidence.id],
        after: "rule",
        rationale: "derived",
      }]);
      expect(result).toMatchObject({ staged: 0, reviewed: 0, retryable: true });
      expect((await selectEvidence(agentRoot)).map((record) => record.id)).toContain(evidence.id);
      const job = JSON.parse(await readFile(path.join(agentRoot, "jobs", "job-invalid.json"), "utf8"));
      expect(job.failure.rejections).toContainEqual({ proposalId: "bad", reason: "invalid targetId" });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("accepted skip explicitly reviews evidence", async () => {
    const vault = tmp("reflection-skip-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      await writeJob(agentRoot, "job-skip", [evidence]);
      const result = await stageProposals(vault, agentRoot, "job-skip", [skip(evidence.id)]);
      expect(result).toMatchObject({ staged: 0, skipped: 1, reviewed: 1, retryable: false });
      expect((await selectEvidence(agentRoot)).map((record) => record.id)).not.toContain(evidence.id);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("proposal must cite exact packet evidence", async () => {
    const vault = tmp("reflection-source-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      await writeJob(agentRoot, "job-source", [evidence]);
      const result = await stageProposals(vault, agentRoot, "job-source", [{
        id: "p-source",
        action: "skip",
        sourceRefs: ["forged-evidence"],
        rationale: "No durable update.",
      }]);
      expect(result).toMatchObject({ reviewed: 0, retryable: true });
      const job = JSON.parse(await readFile(path.join(agentRoot, "jobs", "job-source.json"), "utf8"));
      expect(job.failure.rejections).toContainEqual({
        proposalId: "p-source",
        reason: "source not present in job packet: forged-evidence",
      });
      expect(job.failure.rejections).toContainEqual({
        reason: `packet evidence not addressed: ${evidence.id}`,
      });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("forged evidence snapshot cannot be reviewed", async () => {
    const vault = tmp("reflection-forged-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      const forged = {
        ...evidence,
        data: { ...evidence.data, outcome: "success" },
      };
      await writeJob(agentRoot, "job-forged", [forged]);
      const result = await stageProposals(vault, agentRoot, "job-forged", [skip(evidence.id)]);
      expect(result).toMatchObject({ reviewed: 0, retryable: true });
      const job = JSON.parse(await readFile(path.join(agentRoot, "jobs", "job-forged.json"), "utf8"));
      expect(job.failure.rejections).toContainEqual({
        reason: `evidence changed or packet was forged: ${evidence.id}`,
      });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("opaque packet refs are revalidated before review", async () => {
    const vault = tmp("reflection-stale-ref-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      const { openIndex, syncVault } = await import("@/index");
      const { recall } = await import("@/retrieval");
      const { Budgets } = await import("@/config");
      const note = path.join(agentRoot, "memories", "guidance.md");
      await atomicWrite(note, "---\nid: guidance\nkind: memory\n---\nDeploy guidance\n");
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");
      const item = (await recall(db, vault, "guidance", Budgets.parse({}), "agent:alice")).items[0];
      await writeJob(agentRoot, "job-stale-ref", [evidence], [item]);
      await atomicWrite(note, "---\nid: guidance\nkind: memory\n---\nChanged guidance\n");
      await syncVault(db, vault, agentRoot, "alice");

      const result = await stageProposals(vault, agentRoot, "job-stale-ref", [skip(evidence.id)], db);
      expect(result).toMatchObject({ reviewed: 0, retryable: true });
      const job = JSON.parse(await readFile(path.join(agentRoot, "jobs", "job-stale-ref.json"), "utf8"));
      expect(job.failure.rejections.some((entry: { reason: string }) => entry.reason.startsWith("packet ref no longer exists:"))).toBe(true);
      db.close();
    } finally {
      try { rmSync(vault, { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  test("packet refs cannot be accepted without current index", async () => {
    const vault = tmp("reflection-no-index-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      await writeJob(agentRoot, "job-no-index", [evidence], [{ ref: "opaque" }]);
      const result = await stageProposals(vault, agentRoot, "job-no-index", [skip(evidence.id)]);
      expect(result).toMatchObject({ reviewed: 0, retryable: true });
      const job = JSON.parse(await readFile(path.join(agentRoot, "jobs", "job-no-index.json"), "utf8"));
      expect(job.failure.rejections).toContainEqual({ reason: "packet refs require current index validation" });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("stale target keeps evidence retryable", async () => {
    const vault = tmp("reflection-stale-target-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      const file = path.join(agentRoot, "memories", "rule.md");
      const before = "---\nid: rule\nkind: memory\nstatus: candidate\n---\nOriginal\n";
      await atomicWrite(file, before);
      await writeJob(agentRoot, "job-stale-target", [evidence]);
      await atomicWrite(file, `${before}External change\n`);
      const result = await stageProposals(vault, agentRoot, "job-stale-target", [{
        id: "update-rule",
        action: "update",
        targetId: "rule",
        before,
        baseHash: hashContent(before),
        after: "Updated",
        sourceRefs: [evidence.id],
        rationale: "Failure shows rule needs refinement.",
      }]);
      expect(result).toMatchObject({ staged: 0, reviewed: 0, retryable: true });
      expect(await readFile(file, "utf8")).toContain("External change");
      expect((await selectEvidence(agentRoot)).map((record) => record.id)).toContain(evidence.id);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("semantic updates write auditable reversible revisions", async () => {
    const vault = tmp("reflection-audit-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      const file = path.join(agentRoot, "memories", "audited-rule.md");
      const before = "---\nid: audited-rule\nkind: memory\nstatus: candidate\n---\nOriginal rule\n";
      await atomicWrite(file, before);
      await writeJob(agentRoot, "job-audit", [evidence]);
      const result = await stageProposals(vault, agentRoot, "job-audit", [{
        id: "update-audited-rule",
        action: "update",
        targetId: "audited-rule",
        before,
        baseHash: hashContent(before),
        after: "Narrowed rule",
        sourceRefs: [evidence.id],
        rationale: "Observed failure narrows applicability.",
      }]);
      expect(result.staged).toBe(1);
      const auditLines = (await readFile(path.join(agentRoot, "audit", "revisions.jsonl"), "utf8")).trim().split("\n");
      const revision = JSON.parse(auditLines.at(-1)!);
      expect(revision).toMatchObject({ targetId: "audited-rule", action: "update", beforeHash: hashContent(before) });
      expect(await readFile(path.join(agentRoot, "audit", "snapshots", `${hashContent(before)}.md`), "utf8")).toBe(before);

      const rolledBack = await rollbackRevision(vault, agentRoot, "alice", revision.id);
      expect(await readFile(file, "utf8")).toBe(before);
      const afterRollback = (await readFile(path.join(agentRoot, "audit", "revisions.jsonl"), "utf8")).trim().split("\n");
      const rollbackAudit = JSON.parse(afterRollback.at(-1)!);
      expect(rollbackAudit).toMatchObject({ actor: "rollback", action: "rollback", sourceRefs: [revision.id] });
      expect(rolledBack.revisionId).toBe(rollbackAudit.id);

      const redone = await rollbackRevision(vault, agentRoot, "alice", rollbackAudit.id);
      expect(await readFile(file, "utf8")).toContain("Narrowed rule");
      expect(redone.deleted).toBe(false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("creation rollback deletes and restores candidate note", async () => {
    const vault = tmp("reflection-create-rollback-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const evidence = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        data: { outcome: "failure", evaluator: "fail", task: "deploy" },
      });
      await writeJob(agentRoot, "job-create-rollback", [evidence]);
      const result = await stageProposals(vault, agentRoot, "job-create-rollback", [{
        id: "create-rule",
        action: "create",
        targetKind: "experience",
        targetId: "created-rule",
        after: "Created candidate rule",
        sourceRefs: [evidence.id],
        rationale: "Failure supports candidate.",
      }]);
      expect(result.staged).toBe(1);
      const file = path.join(agentRoot, "experiences", "created-rule.md");
      expect(await readFile(file, "utf8")).toContain("Created candidate rule");
      const revisions = (await readFile(path.join(agentRoot, "audit", "revisions.jsonl"), "utf8")).trim().split("\n");
      const created = JSON.parse(revisions.at(-1)!);
      expect(created).toMatchObject({ action: "create", targetKind: "experience" });

      const removed = await rollbackRevision(vault, agentRoot, "alice", created.id);
      expect(removed.deleted).toBe(true);
      expect(existsSync(file)).toBe(false);
      const afterRemoval = (await readFile(path.join(agentRoot, "audit", "revisions.jsonl"), "utf8")).trim().split("\n");
      const removal = JSON.parse(afterRemoval.at(-1)!);
      await rollbackRevision(vault, agentRoot, "alice", removal.id);
      expect(await readFile(file, "utf8")).toContain("Created candidate rule");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("candidate activation requires independent successful application roots", async () => {
    const vault = tmp("reflection-activation-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const file = path.join(agentRoot, "experiences", "deploy-policy.md");
      await atomicWrite(file, "---\nid: deploy-policy\nkind: experience\nstatus: candidate\n---\nUse staged health checks.\n");
      const seed = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        refs: ["deploy-policy", "case-seed"],
        data: {
          rootSource: "case-seed",
          task: "deploy",
          outcome: "success",
          evaluator: "pass",
          appliedRefs: ["deploy-policy"],
        },
      });
      await transitionCandidate(vault, agentRoot, "alice", "deploy-policy", "staging", [seed.id], "Ready for transfer validation.");
      await expect(transitionCandidate(
        vault,
        agentRoot,
        "alice",
        "deploy-policy",
        "active",
        [seed.id],
        "Activate.",
      )).rejects.toThrow("two independent successful application roots");

      const transfer = await record(vault, agentRoot, "alice", {
        kind: "outcome",
        refs: ["deploy-policy", "case-transfer"],
        data: {
          rootSource: "case-transfer",
          task: "deploy another service",
          outcome: "success",
          evaluator: "pass",
          appliedRefs: ["deploy-policy"],
        },
      });
      const activated = await transitionCandidate(
        vault,
        agentRoot,
        "alice",
        "deploy-policy",
        "active",
        [seed.id, transfer.id],
        "Two independent applications passed.",
      );
      expect(activated.toStatus).toBe("active");
      expect(await readFile(file, "utf8")).toContain("status: active");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
