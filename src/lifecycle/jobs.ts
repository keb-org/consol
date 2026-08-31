import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { atomicWrite, hashContent, stableId, withVaultLock } from "../storage/vault";
import { recall } from "../retrieval/recall";
import { redactSecrets } from "../core/security";
import type { VaultConfig } from "../core/config";
import { evidenceCue, evidenceRecords, reviewedIds, selectEvidence, type EvidenceRecord } from "./evidence";
import {
  packetSourceRefs,
  prepareMutations,
  validatePacketItemRefs,
  validateProposal,
  type PreparedMutation,
  type Proposal,
  type Rejection,
} from "./proposals";
import { auditPath, type AuditRevision } from "./state-machine";

export type Job = {
  id: string;
  createdAt: string;
  status: "pending" | "claimed" | "done" | "failed";
  packet: { query: string; items: any[]; evidence?: EvidenceRecord[] };
  proposals?: Proposal[];
  completedAt?: string;
  runner?: string;
  failure?: {
    reason: string;
    at: string;
    retryable: true;
    rejections: Rejection[];
    diagnostics?: string[];
  };
};

export type ReflectionExecution = {
  runner?: string;
  diagnostics?: string[];
};

export async function buildPacket(
  db: Database,
  vault: string,
  agentRoot: string,
  config: VaultConfig,
): Promise<{ query: string; items: any[]; evidence: EvidenceRecord[] }> {
  const evidence = await selectEvidence(agentRoot, 8);
  if (evidence.length === 0) return { query: "recent learning", items: [], evidence: [] };
  const query = evidenceCue(evidence);
  const agent = path.basename(agentRoot);
  const { getAttachedTeams } = await import("../core/identity");
  const pkt = await recall(
    db,
    vault,
    query,
    config.budgets,
    `agent:${agent}`,
    "guidance",
    await getAttachedTeams(vault, agent),
  );
  return { query, items: pkt.items.slice(0, 8), evidence };
}

export async function createJob(
  vault: string,
  agentRoot: string,
  config: VaultConfig,
  db: Database,
): Promise<Job> {
  const packet = await buildPacket(db, vault, agentRoot, config);
  const id = stableId("job-");
  const job: Job = { id, createdAt: new Date().toISOString(), status: "pending", packet };
  await atomicWrite(path.join(agentRoot, "jobs", `${id}.json`), JSON.stringify(job, null, 2));
  return job;
}

function failureReason(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function failJob(
  jobPath: string,
  job: Job,
  reason: string,
  rejections: Rejection[],
  execution: ReflectionExecution,
) {
  const at = new Date().toISOString();
  job.status = "failed";
  job.runner = execution.runner;
  delete job.completedAt;
  job.failure = {
    reason,
    at,
    retryable: true,
    rejections,
    ...(execution.diagnostics?.length ? { diagnostics: execution.diagnostics.slice(0, 20) } : {}),
  };
  await atomicWrite(jobPath, JSON.stringify(job, null, 2));
  return {
    staged: 0,
    skipped: 0,
    rejected: rejections.length,
    total: job.proposals?.length ?? 0,
    reviewed: 0,
    retryable: true,
    reason,
  };
}

export async function stageProposals(
  vault: string,
  agentRoot: string,
  jobId: string,
  proposals: Proposal[],
  db?: Database,
  execution: ReflectionExecution = {},
) {
  const jobPath = path.join(agentRoot, "jobs", `${jobId}.json`);
  if (!existsSync(jobPath)) throw new Error(`reflection job not found: ${jobId} — category: stale or type error (no jobs/${jobId}.json for this agent). Fix: verify jobId spelling and that the job was created for this agent; list ${path.join(agentRoot, "jobs")} to find valid ids`);
  const job = JSON.parse(await readFile(jobPath, "utf8")) as Job;
  job.proposals = proposals;
  job.runner = execution.runner;
  delete job.failure;
  delete job.completedAt;

  const evidenceIds = [...new Set(
    (job.packet.evidence ?? [])
      .map((record) => record.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )];

  if (evidenceIds.length === 0) {
    if (proposals.length) {
      return failJob(jobPath, job, "job has no evidence", [], execution);
    }
    job.status = "done";
    job.completedAt = new Date().toISOString();
    await atomicWrite(jobPath, JSON.stringify(job, null, 2));
    return {
      staged: 0,
      skipped: 0,
      rejected: 0,
      total: 0,
      reviewed: 0,
      retryable: false,
    };
  }

  const reviewedBefore = await reviewedIds(agentRoot);
  const alreadyReviewed = evidenceIds.filter((id) => reviewedBefore.has(id));
  if (alreadyReviewed.length === evidenceIds.length) {
    job.status = "done";
    job.completedAt = new Date().toISOString();
    await atomicWrite(jobPath, JSON.stringify(job, null, 2));
    return {
      staged: 0,
      skipped: 0,
      rejected: 0,
      total: proposals.length,
      reviewed: 0,
      retryable: false,
      alreadyReviewed: evidenceIds.length,
    };
  }
  if (alreadyReviewed.length) {
    return failJob(
      jobPath,
      job,
      "job packet is partially stale",
      alreadyReviewed.map((id) => ({ reason: `evidence already reviewed: ${id}` })),
      execution,
    );
  }

  if (proposals.length === 0) {
    const reason = execution.runner === "none"
      ? "no reflection runner succeeded"
      : "runner returned no proposals";
    return failJob(jobPath, job, reason, [], execution);
  }

  const validations = proposals.map((proposal) => ({
    proposal,
    validation: validateProposal(proposal, agentRoot),
  }));
  const rejections: Rejection[] = validations
    .filter(({ validation }) => !validation.ok)
    .map(({ proposal, validation }) => ({
      ...(typeof proposal?.id === "string" ? { proposalId: proposal.id } : {}),
      reason: validation.reason ?? "invalid proposal",
    }));
  const evidenceSet = new Set(evidenceIds);
  const allowedSources = packetSourceRefs(job);
  rejections.push(...await validatePacketItemRefs(vault, job, db, path.basename(agentRoot)));
  for (const { proposal, validation } of validations) {
    if (!validation.ok) continue;
    const refs = Array.isArray(proposal.sourceRefs) ? proposal.sourceRefs : [];
    for (const ref of refs) {
      if (!allowedSources.has(ref)) {
        rejections.push({ proposalId: proposal.id, reason: `source not present in job packet: ${ref}` });
      }
    }
    if (!refs.some((ref) => evidenceSet.has(ref))) {
      rejections.push({ proposalId: proposal.id, reason: "proposal cites no packet evidence" });
    }
  }
  for (const evidenceId of evidenceIds) {
    if (!proposals.some((proposal) => proposal.sourceRefs?.includes(evidenceId))) {
      rejections.push({ reason: `packet evidence not addressed: ${evidenceId}` });
    }
  }

  const canonical = new Map((await evidenceRecords(agentRoot)).map((record) => [record.id, record]));
  const agent = path.basename(agentRoot);
  for (const packetRecord of job.packet.evidence ?? []) {
    const stored = canonical.get(packetRecord.id);
    if (!stored) {
      rejections.push({ reason: `evidence not found: ${packetRecord.id}` });
    } else if (stored.agent !== agent) {
      rejections.push({ reason: `evidence owner mismatch: ${packetRecord.id}` });
    } else if (hashContent(JSON.stringify(stored)) !== hashContent(JSON.stringify(packetRecord))) {
      rejections.push({ reason: `evidence changed or packet was forged: ${packetRecord.id}` });
    }
  }

  if (rejections.length) {
    return failJob(jobPath, job, "runner returned invalid or incomplete proposals", rejections, execution);
  }

  const prepared = await prepareMutations(agentRoot, proposals);
  if (prepared.rejections.length) {
    return failJob(
      jobPath,
      job,
      "proposals conflict with current vault state",
      prepared.rejections,
      execution,
    );
  }

  const reviewedPath = path.join(agentRoot, "evidence", "reviewed.jsonl");
  const previousReviewedText = await readFile(reviewedPath, "utf8").catch(() => "");
  const reviewedAt = new Date().toISOString();
  const newReviewLines = evidenceIds.map((evidenceId) =>
    JSON.stringify({ evidenceId, jobId, reviewedAt })
  );
  const nextReviewedText = `${previousReviewedText}${newReviewLines.join("\n")}\n`;
  const auditFile = auditPath(agentRoot);
  const previousAuditText = await readFile(auditFile, "utf8").catch(() => "");
  const snapshotDir = path.join(agentRoot, "audit", "snapshots");
  const revisions: AuditRevision[] = prepared.mutations.map((mutation) => ({
    id: stableId("rev-"),
    at: reviewedAt,
    agent: path.basename(agentRoot),
    actor: "reflection",
    jobId,
    proposalId: mutation.proposalId,
    targetId: mutation.targetId,
    targetKind: mutation.targetKind,
    action: mutation.action,
    fromStatus: mutation.fromStatus,
    toStatus: mutation.toStatus,
    beforeHash: mutation.previous === undefined ? undefined : hashContent(mutation.previous),
    afterHash: hashContent(mutation.next),
    sourceRefs: mutation.sourceRefs,
    rationale: mutation.rationale,
    runner: execution.runner,
  }));
  const nextAuditText = `${previousAuditText}${revisions.map((revision) => JSON.stringify(revision)).join("\n")}${revisions.length ? "\n" : ""}`;
  const applied: PreparedMutation[] = [];
  const createdSnapshots: string[] = [];

  try {
    await withVaultLock(vault, async () => {
      const currentReviewed = await reviewedIds(agentRoot);
      if (evidenceIds.some((id) => currentReviewed.has(id))) {
        throw new Error("evidence reviewed concurrently — category: stale (another worker marked this evidence as reviewed between packet build and staging). Fix: build a fresh packet and retry; do not reuse this jobId");
      }
      try {
        for (const mutation of prepared.mutations) {
          const snapshots = [
            ...(mutation.previous === undefined ? [] : [{ hash: hashContent(mutation.previous), content: mutation.previous }]),
            { hash: hashContent(mutation.next), content: mutation.next },
          ];
          for (const { hash, content } of snapshots) {
            const snapshot = path.join(snapshotDir, `${hash}.md`);
            if (!existsSync(snapshot)) {
              await atomicWrite(snapshot, content);
              createdSnapshots.push(snapshot);
            }
          }
          await atomicWrite(mutation.file, mutation.next);
          applied.push(mutation);
        }
        if (revisions.length) await atomicWrite(auditFile, nextAuditText);
        await atomicWrite(reviewedPath, nextReviewedText);
        job.status = "done";
        job.completedAt = reviewedAt;
        await atomicWrite(jobPath, JSON.stringify(job, null, 2));
      } catch (error) {
        await atomicWrite(reviewedPath, previousReviewedText);
        await atomicWrite(auditFile, previousAuditText).catch(() => {});
        for (const mutation of applied.reverse()) {
          if (mutation.previous === undefined) await unlink(mutation.file).catch(() => {});
          else await atomicWrite(mutation.file, mutation.previous);
        }
        for (const snapshot of createdSnapshots) await unlink(snapshot).catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    return failJob(
      jobPath,
      job,
      "proposal staging failed",
      [{ reason: failureReason(error) }],
      execution,
    );
  }

  let indexError: string | undefined;
  if (db && prepared.mutations.length) {
    try {
      const { syncVault } = await import("../storage/index/sync");
      await syncVault(db, vault, agentRoot, agent);
    } catch {
      indexError = "canonical mutation committed; index sync failed, run reindex";
    }
  }
  return {
    staged: prepared.mutations.length,
    skipped: proposals.filter((proposal) => proposal.action === "skip").length,
    rejected: 0,
    total: proposals.length,
    reviewed: evidenceIds.length,
    retryable: false,
    ...(indexError ? { indexError } : {}),
  };
}
