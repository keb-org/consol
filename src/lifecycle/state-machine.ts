import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { atomicWrite, hashContent, parseFrontmatter, stableId, withVaultLock } from "../storage/vault";
import { evidenceRecords, independentSuccessRoots } from "./evidence";
import { SAFE_ID, splitRefs, TARGET_DIRS, type ProposalAction } from "./proposals";

export const ACTIVE_TRANSITIONS = new Set(["candidate:staging", "staging:active"]);
export const INACTIVE_TRANSITIONS = new Set([
  "candidate:disputed",
  "candidate:retired",
  "staging:disputed",
  "staging:retired",
  "active:disputed",
  "active:retired",
  "active:superseded",
  "disputed:staging",
  "disputed:retired",
]);

export type AuditRevision = {
  id: string;
  at: string;
  agent: string;
  actor: "reflection" | "rollback";
  jobId: string;
  proposalId: string;
  targetId: string;
  targetKind?: keyof typeof TARGET_DIRS;
  action: ProposalAction | "transition" | "rollback";
  fromStatus?: string;
  toStatus?: string;
  beforeHash?: string;
  afterHash: string;
  sourceRefs: string[];
  rationale: string;
  runner?: string;
};

export function auditPath(agentRoot: string): string {
  return path.join(agentRoot, "audit", "revisions.jsonl");
}

export async function auditRevisions(agentRoot: string): Promise<AuditRevision[]> {
  const text = await readFile(auditPath(agentRoot), "utf8").catch(() => "");
  const revisions: AuditRevision[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as AuditRevision;
      if (value?.targetId && value?.afterHash) revisions.push(value);
    } catch {}
  }
  return revisions;
}

export async function transitionCandidate(
  vault: string,
  agentRoot: string,
  agent: string,
  targetId: string,
  toStatus: "staging" | "active" | "disputed" | "retired" | "superseded",
  sourceRefs: string[],
  rationale: string,
  db?: Database,
) {
  if (!SAFE_ID.test(targetId)) throw new Error("invalid targetId — category: type error (must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/). Fix: pass targetId like my-note_1 matching that pattern");
  if (!rationale.trim()) throw new Error("missing rationale — category: type error (rationale is required and must be non-empty). Fix: provide a non-empty rationale string explaining why");
  if (!sourceRefs.length || sourceRefs.some((ref) => !ref.trim() || ref.length > 500 || /[\r\n]/.test(ref))) {
    throw new Error("invalid sourceRefs — category: type error (need >=1 refs, each non-empty <=500 chars, no \\r/\\n). Fix: pass 1+ short provenance strings without line breaks");
  }
  const directories = [...Object.values(TARGET_DIRS), "core"];
  const matches = directories
    .map((directory) => path.join(agentRoot, directory, `${targetId}.md`))
    .filter(existsSync);
  if (matches.length !== 1) throw new Error(matches.length ? "target id is ambiguous — category: type error (targetId maps to multiple files across memories/cases/experiences/skills/core). Fix: use a fully-qualified or unique targetId; check vault for duplicates" : "target not found — category: stale or type error (no file matches targetId in memories/cases/experiences/skills/core). Fix: verify targetId spelling and that the note exists; re-list vault notes");
  if (path.basename(path.dirname(matches[0])) === "core") throw new Error("core is protected — category: unauthorized (core notes are immutable via this transition). Fix: do not transition core entries; copy the content to a non-core kind if you need a mutable version");
  const file = matches[0];
  const existing = await readFile(file, "utf8");
  const { meta, body } = parseFrontmatter(existing);
  const fromStatus = meta.status ?? "candidate";
  const transition = `${fromStatus}:${toStatus}`;
  if (!ACTIVE_TRANSITIONS.has(transition) && !INACTIVE_TRANSITIONS.has(transition)) {
    throw new Error(`invalid lifecycle transition: ${transition} — category: type error (transition not allowed). Fix: use one of candidate:staging, staging:active, candidate:disputed, candidate:retired, staging:disputed, staging:retired, active:disputed, active:retired, active:superseded, disputed:staging, disputed:retired`);
  }
  const canonical = await evidenceRecords(agentRoot);
  const canonicalIds = new Set(canonical.filter((record) => record.agent === agent).map((record) => record.id));
  if (sourceRefs.some((ref) => !canonicalIds.has(ref))) throw new Error("source evidence not found or owned by another agent — category: stale or unauthorized (sourceRefs must point to evidence owned by this agent). Fix: re-run recall/record so the evidence exists under this agent; check agent: prefix and team attachment");
  if (toStatus === "active") {
    const roots = independentSuccessRoots(canonical, targetId);
    if (roots.size < 2) throw new Error("activation requires two independent successful application roots — category: out-of-bounds (need >=2 distinct rootSource values from success/pass evidence where appliedRefs includes targetId). Fix: record at least two separate successful applications with different rootSource before activating");
    const appliedEvidence = canonical.filter((record) => {
      const applied = Array.isArray(record.data.appliedRefs) ? record.data.appliedRefs : [];
      return applied.includes(targetId) && record.data.outcome === "success" && record.data.evaluator === "pass";
    });
    if (sourceRefs.some((ref) => !appliedEvidence.some((record) => record.id === ref))) {
      throw new Error("activation sources must be successful application outcomes — category: type error (every sourceRef for activation must be a success/pass evidence that applied this targetId). Fix: use only evidence where outcome=success, evaluator=pass, and appliedRefs includes targetId");
    }
  }
  const nextMeta = {
    ...meta,
    id: targetId,
    kind: meta.kind ?? "memory",
    status: toStatus,
    source_refs: [...new Set([...splitRefs(meta.source_refs), ...sourceRefs])].join(", "),
    updated: new Date().toISOString(),
  };
  const fm = Object.entries(nextMeta).map(([key, value]) => `${key}: ${value}`).join("\n");
  const next = `---\n${fm}\n---\n${body.trim()}\n`;
  const auditFile = auditPath(agentRoot);
  const previousAudit = await readFile(auditFile, "utf8").catch(() => "");
  const beforeHash = hashContent(existing);
  const snapshot = path.join(agentRoot, "audit", "snapshots", `${beforeHash}.md`);
  const nextHash = hashContent(next);
  const nextSnapshot = path.join(agentRoot, "audit", "snapshots", `${nextHash}.md`);
  const revision: AuditRevision = {
    id: stableId("rev-"),
    at: new Date().toISOString(),
    agent,
    actor: "reflection",
    jobId: "lifecycle",
    proposalId: "lifecycle",
    targetId,
    action: "transition",
    fromStatus,
    toStatus,
    beforeHash,
    afterHash: nextHash,
    sourceRefs: [...new Set(sourceRefs)],
    rationale,
  };
  await withVaultLock(vault, async () => {
    const current = await readFile(file, "utf8");
    if (hashContent(current) !== beforeHash) throw new Error("target changed during transition — category: stale (file was edited after transitionCandidate read it). Fix: re-read the note to get current hash/status and retry the transition");
    const snapshotExisted = existsSync(snapshot);
    const nextSnapshotExisted = existsSync(nextSnapshot);
    try {
      if (!snapshotExisted) await atomicWrite(snapshot, existing);
      if (!nextSnapshotExisted) await atomicWrite(nextSnapshot, next);
      await atomicWrite(file, next);
      await atomicWrite(auditFile, `${previousAudit}${JSON.stringify(revision)}\n`);
    } catch (error) {
      await atomicWrite(file, existing).catch(() => {});
      await atomicWrite(auditFile, previousAudit).catch(() => {});
      if (!snapshotExisted) await unlink(snapshot).catch(() => {});
      if (!nextSnapshotExisted) await unlink(nextSnapshot).catch(() => {});
      throw error;
    }
  });
  if (db) {
    const { syncVault } = await import("../storage/index/sync");
    await syncVault(db, vault, agentRoot, agent);
  }
  return { targetId, fromStatus, toStatus, revisionId: revision.id };
}

export async function rollbackRevision(
  vault: string,
  agentRoot: string,
  agent: string,
  revisionId: string,
  db?: Database,
) {
  const revisions = await auditRevisions(agentRoot);
  const revision = revisions.find((entry) => entry.id === revisionId);
  if (!revision || revision.agent !== agent) throw new Error("revision not found — category: stale or type error (no audit entry matches this revisionId for this agent). Fix: list audit revisions and use a valid revisionId owned by this agent");
  if (revisions.some((entry) => entry.actor === "rollback" && entry.sourceRefs.includes(revisionId))) {
    throw new Error("revision already rolled back — category: stale (this revision was already the target of a rollback). Fix: pick a different revisionId; check audit for prior rollback entries over this revision");
  }
  const directories = [...Object.values(TARGET_DIRS), "core"];
  const matches = directories
    .map((directory) => path.join(agentRoot, directory, `${revision.targetId}.md`))
    .filter(existsSync);
  const original = revision.action === "rollback"
    ? revisions.find((entry) => entry.id === revision.sourceRefs[0])
    : undefined;
  const createKind = original && !original.beforeHash ? original.targetKind : undefined;
  const createFile = createKind
    ? path.join(agentRoot, TARGET_DIRS[createKind], `${revision.targetId}.md`)
    : undefined;
  if (!matches.length && !createFile) throw new Error("rollback target not found or ambiguous — category: stale or type error (no unique file for this revision targetId). Fix: verify revisionId and that its target note still exists uniquely");
  if (matches.length > 1) throw new Error("rollback target not found or ambiguous — category: type error (targetId maps to multiple files). Fix: resolve duplicate targetIds in the vault so only one file matches");
  const file = matches[0] ?? createFile!;
  if (path.basename(path.dirname(file)) === "core") throw new Error("core is protected — category: unauthorized (core notes cannot be rolled back via this path). Fix: recover core via vault backup/history instead");
  const current = matches.length ? await readFile(file, "utf8") : "";
  if (matches.length && hashContent(current) !== revision.afterHash) throw new Error("target changed since revision — category: stale (file was edited after this revision). Fix: re-read audit and use the latest revisionId; do not rollback a stale afterHash");
  if (!matches.length && revision.afterHash !== hashContent("")) throw new Error("target changed since revision — category: stale (expected deleted file still hashes to empty, but target now exists). Fix: re-read audit; target was recreated — use the current revision");

  const currentHash = hashContent(current);
  const currentSnapshot = matches.length
    ? path.join(agentRoot, "audit", "snapshots", `${currentHash}.md`)
    : undefined;
  let previous: string | undefined;
  if (revision.action === "rollback" && revision.beforeHash) {
    const originalRev = revisions.find((entry) => entry.id === revision.sourceRefs[0]);
    if (!originalRev) throw new Error("rollback source revision not found — category: stale (rollback target revision points to a source revision that no longer exists in audit). Fix: re-read audit and use a valid revisionId that still has its source");
    previous = await readFile(
      path.join(agentRoot, "audit", "snapshots", `${originalRev.afterHash}.md`),
      "utf8",
    ).catch(() => { throw new Error("revision snapshot not found — category: stale (snapshot file for this revision's afterHash is missing on disk). Fix: snapshots are stored under <agentRoot>/audit/snapshots/<hash>.md; check vault integrity or use a different revisionId"); });
  } else if (revision.beforeHash) {
    previous = await readFile(
      path.join(agentRoot, "audit", "snapshots", `${revision.beforeHash}.md`),
      "utf8",
    ).catch(() => { throw new Error("revision snapshot not found — category: stale (snapshot file for this revision's beforeHash is missing on disk). Fix: check <agentRoot>/audit/snapshots/ for missing file; vault may have been pruned — use a different revisionId"); });
  }
  const auditFile = auditPath(agentRoot);
  const previousAudit = await readFile(auditFile, "utf8").catch(() => "");
  const rollback: AuditRevision = {
    id: stableId("rev-"),
    at: new Date().toISOString(),
    agent,
    actor: "rollback",
    jobId: "rollback",
    proposalId: revisionId,
    targetId: revision.targetId,
    action: "rollback",
    fromStatus: revision.toStatus,
    toStatus: revision.fromStatus,
    beforeHash: currentHash,
    afterHash: previous === undefined ? hashContent("") : hashContent(previous),
    sourceRefs: [revisionId],
    rationale: `Rollback revision ${revisionId}`,
  };

  await withVaultLock(vault, async () => {
    const latestExists = existsSync(file);
    if (matches.length !== Number(latestExists)) throw new Error("target changed during rollback — category: stale (existence flipped between reading revision and acquiring lock). Fix: re-read audit and use the current revision/state");
    if (latestExists && hashContent(await readFile(file, "utf8")) !== currentHash) {
      throw new Error("target changed during rollback — category: stale (file hash changed between reading revision and acquiring lock). Fix: re-read audit and use the latest revisionId");
    }
    const snapshotExisted = currentSnapshot ? existsSync(currentSnapshot) : true;
    try {
      if (currentSnapshot && !snapshotExisted) await atomicWrite(currentSnapshot, current);
      if (previous === undefined) await unlink(file);
      else await atomicWrite(file, previous);
      await atomicWrite(auditFile, `${previousAudit}${JSON.stringify(rollback)}\n`);
    } catch (error) {
      if (matches.length) await atomicWrite(file, current).catch(() => {});
      else await unlink(file).catch(() => {});
      await atomicWrite(auditFile, previousAudit).catch(() => {});
      if (currentSnapshot && !snapshotExisted) await unlink(currentSnapshot).catch(() => {});
      throw error;
    }
  });
  if (db) {
    const { syncVault } = await import("../storage/index/sync");
    await syncVault(db, vault, agentRoot, agent);
  }
  return {
    rolledBack: revisionId,
    targetId: revision.targetId,
    revisionId: rollback.id,
    deleted: previous === undefined,
  };
}
