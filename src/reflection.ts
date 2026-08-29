import path from "node:path";
import { readFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { atomicWrite, hashContent, parseFrontmatter, stableId, withVaultLock } from "./vault";
import { decodeRef, recall } from "./retrieval";
import { containsSecret, redactSecrets } from "./security";
import { abstractionLevel } from "./transfer";
import type { VaultConfig } from "./config";

export type ProposalAction = "create" | "update" | "skip";

export type Proposal = {
  id: string;
  action: ProposalAction;
  targetKind?: string;
  targetId?: string;
  before?: string;
  after?: string;
  baseHash?: string;
  sourceRefs: string[];
  scope?: string;
  expectedEffect?: string;
  disconfirming?: string;
  alternatives?: string;
  rationale: string;
};

export type EvidenceRecord = {
  id: string;
  at: string;
  agent: string;
  kind: string;
  data: Record<string, unknown>;
  refs: string[];
};

type Rejection = { proposalId?: string; reason: string };

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

const TARGET_DIRS = {
  memory: "memories",
  case: "cases",
  experience: "experiences",
  skill: "skills",
} as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ACTIVE_TRANSITIONS = new Set(["candidate:staging", "staging:active"]);
const INACTIVE_TRANSITIONS = new Set([
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

type AuditRevision = {
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

function auditPath(agentRoot: string) {
  return path.join(agentRoot, "audit", "revisions.jsonl");
}

async function auditRevisions(agentRoot: string): Promise<AuditRevision[]> {
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

function independentSuccessRoots(records: EvidenceRecord[], targetId: string) {
  const roots = new Set<string>();
  for (const record of records) {
    const applied = Array.isArray(record.data.appliedRefs)
      ? record.data.appliedRefs.filter((ref): ref is string => typeof ref === "string")
      : [];
    if (!applied.includes(targetId)) continue;
    if (record.data.outcome !== "success" || record.data.evaluator !== "pass") continue;
    const root = typeof record.data.rootSource === "string" && record.data.rootSource.trim()
      ? record.data.rootSource.trim()
      : record.refs.find((ref) => ref !== targetId);
    if (root) roots.add(root);
  }
  return roots;
}

async function reviewedIds(agentRoot: string) {
  const file = path.join(agentRoot, "evidence", "reviewed.jsonl");
  const text = await readFile(file, "utf8").catch(() => "");
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.evidenceId === "string") ids.add(rec.evidenceId);
    } catch {}
  }
  return ids;
}

async function evidenceRecords(agentRoot: string): Promise<EvidenceRecord[]> {
  const evidenceDir = path.join(agentRoot, "evidence");
  if (!existsSync(evidenceDir)) return [];
  const years = (await readdir(evidenceDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));
  const records: EvidenceRecord[] = [];
  for (const year of years) {
    const months = (await readdir(path.join(evidenceDir, year.name), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const month of months) {
      const text = await readFile(path.join(evidenceDir, year.name, month.name), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Partial<EvidenceRecord>;
          if (
            typeof value.id !== "string" ||
            typeof value.at !== "string" ||
            typeof value.agent !== "string" ||
            typeof value.kind !== "string" ||
            !value.data ||
            typeof value.data !== "object" ||
            Array.isArray(value.data)
          ) continue;
          records.push({
            id: value.id,
            at: value.at,
            agent: value.agent,
            kind: value.kind,
            data: value.data,
            refs: Array.isArray(value.refs)
              ? value.refs.filter((ref): ref is string => typeof ref === "string")
              : [],
          });
        } catch {}
      }
    }
  }
  return records;
}

export async function selectEvidence(agentRoot: string, limit = 12): Promise<EvidenceRecord[]> {
  const reviewed = await reviewedIds(agentRoot);
  const agent = path.basename(agentRoot);
  const byRoot = new Map<string, number>();
  for (const record of await evidenceRecords(agentRoot)) {
    const root = typeof record.data.rootSource === "string" ? record.data.rootSource.trim() : "";
    if (root) byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
  }
  const candidates: { record: EvidenceRecord; score: number }[] = [];
  for (const record of await evidenceRecords(agentRoot)) {
    if (record.agent !== agent || reviewed.has(record.id)) continue;
    const isFailure = record.data.outcome === "failure" || record.data.evaluator === "fail";
    const isSuccess = record.data.outcome === "success" && record.data.evaluator === "pass";
    const isCorrection = record.kind === "correction";
    const isReusableEvidence = Array.isArray(record.data.appliedRefs) && record.data.appliedRefs.length > 0;
    const root = typeof record.data.rootSource === "string" ? record.data.rootSource.trim() : "";
    const diversity = root ? Math.min(2, byRoot.get(root) ?? 1) : 0;
    if (isFailure || isCorrection || record.kind === "case" || record.kind === "outcome") {
      const reusableBonus = isReusableEvidence ? 1.5 : 0;
      const transferSignal = isSuccess && isReusableEvidence ? 2 : 0;
      candidates.push({
        record,
        score: (isFailure ? 3 : 0) + (isCorrection ? 2 : 0) + transferSignal + reusableBonus + diversity * 0.3 + 1,
      });
    }
  }
  candidates.sort((a, b) =>
    b.score - a.score ||
    b.record.at.localeCompare(a.record.at) ||
    a.record.id.localeCompare(b.record.id)
  );
  return candidates.slice(0, limit).map((candidate) => candidate.record);
}

export async function selectCases(agentRoot: string, limit = 12): Promise<string[]> {
  return (await selectEvidence(agentRoot, limit)).map((record) => record.id);
}

function evidenceCue(records: EvidenceRecord[]) {
  const text = records.flatMap((record) => [
    record.kind,
    ...Object.entries(record.data).flatMap(([key, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [key, String(value)]
        : []
    ),
  ]).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 1000) || "recent learning";
}

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
  const { getAttachedTeams } = await import("./agents");
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

export function validateProposal(p: Proposal, _agentRoot: string): { ok: boolean; reason?: string } {
  if (!p || typeof p !== "object" || !["create", "update", "skip"].includes(p.action)) {
    return { ok: false, reason: "unsupported action" };
  }
  if (typeof p.id !== "string" || !p.id.trim()) return { ok: false, reason: "missing proposal id" };
  if (typeof p.rationale !== "string" || !p.rationale.trim()) return { ok: false, reason: "missing rationale" };
  const sourceRefs = Array.isArray(p.sourceRefs)
    ? p.sourceRefs.filter((ref): ref is string => typeof ref === "string" && Boolean(ref.trim()))
    : [];
  if (p.action !== "skip" && sourceRefs.length === 0) return { ok: false, reason: "missing sourceRefs" };
  if (sourceRefs.some((ref) => ref.length > 500 || /[\r\n]/.test(ref))) {
    return { ok: false, reason: "invalid sourceRef" };
  }
  if (containsSecret(p)) return { ok: false, reason: "secret in proposal" };
  if (p.scope?.match(/[\r\n]/)) return { ok: false, reason: "invalid scope" };
  const kind = (p.targetKind ?? "experience") as string;
  const distinctRoots = new Set(sourceRefs).size;
  const level = abstractionLevel(kind, sourceRefs.length, distinctRoots);
  if (level === "specific" && kind === "skill" && sourceRefs.length < 2) {
    return { ok: false, reason: "skill requires at least two distinct sources" };
  }
  if (p.action !== "skip") {
    if (!p.targetId || !SAFE_ID.test(p.targetId)) return { ok: false, reason: "invalid targetId" };
    if (!p.after?.trim()) return { ok: false, reason: "missing after" };
    if (sourceRefs.includes(p.targetId)) return { ok: false, reason: "self-citation" };
  }
  if (p.action === "create" && p.targetKind && !Object.hasOwn(TARGET_DIRS, p.targetKind)) {
    return { ok: false, reason: "invalid targetKind" };
  }
  if (p.action === "update") {
    if (!p.baseHash?.match(/^[a-f0-9]{64}$/)) return { ok: false, reason: "missing baseHash" };
    if (p.before && hashContent(p.before) !== p.baseHash) return { ok: false, reason: "stale baseHash" };
  }
  return { ok: true };
}

function packetSourceRefs(job: Job) {
  const refs = new Set<string>();
  for (const record of job.packet.evidence ?? []) refs.add(record.id);
  for (const item of job.packet.items ?? []) {
    if (typeof item?.ref === "string") refs.add(item.ref);
  }
  return refs;
}

async function validatePacketItemRefs(
  vault: string,
  job: Job,
  db: Database | undefined,
  agent: string,
): Promise<Rejection[]> {
  if (!job.packet.items?.length) return [];
  if (!db) return [{ reason: "packet refs require current index validation" }];
  const { getAttachedTeams } = await import("./agents");
  const allowedOwners = new Set([`agent:${agent}`, ...await getAttachedTeams(vault, agent)]);
  const rejections: Rejection[] = [];
  for (const item of job.packet.items) {
    if (typeof item?.ref !== "string") {
      rejections.push({ reason: "packet item missing ref" });
      continue;
    }
    try {
      const decoded = decodeRef(item.ref);
      const row = db.query("SELECT doc_id, hash, owner FROM chunks WHERE chunk_id=?").get(decoded.c) as {
        doc_id: string;
        hash: string;
        owner: string;
      } | null;
      if (!row) rejections.push({ reason: `packet ref no longer exists: ${item.ref}` });
      else if (row.doc_id !== decoded.d || row.hash.slice(0, 12) !== decoded.h) rejections.push({ reason: `packet ref is stale or forged: ${item.ref}` });
      else if (row.owner !== decoded.o) rejections.push({ reason: `packet ref owner mismatch: ${item.ref}` });
      else if (!allowedOwners.has(row.owner)) rejections.push({ reason: `packet ref owner not attached: ${item.ref}` });
    } catch {
      rejections.push({ reason: `invalid packet ref: ${item.ref}` });
    }
  }
  return rejections;
}

function failureReason(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function failJob(
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

type PreparedMutation = {
  proposalId: string;
  targetId: string;
  action: ProposalAction | "transition";
  targetKind?: keyof typeof TARGET_DIRS;
  sourceRefs: string[];
  rationale: string;
  fromStatus?: string;
  toStatus?: string;
  file: string;
  next: string;
  previous?: string;
};

function splitRefs(value: string | undefined) {
  return (value ?? "").split(/[;,]/).map((ref) => ref.trim()).filter(Boolean);
}

async function prepareMutations(
  agentRoot: string,
  proposals: Proposal[],
): Promise<{ mutations: PreparedMutation[]; rejections: Rejection[] }> {
  const mutations: PreparedMutation[] = [];
  const rejections: Rejection[] = [];
  const targets = new Set<string>();
  const directories = [...Object.values(TARGET_DIRS), "core"];

  for (const proposal of proposals) {
    if (proposal.action === "skip") continue;
    const targetId = proposal.targetId!;
    if (targets.has(targetId)) {
      rejections.push({ proposalId: proposal.id, reason: "duplicate target in job" });
      continue;
    }
    targets.add(targetId);

    const matches = directories
      .map((directory) => path.join(agentRoot, directory, `${targetId}.md`))
      .filter(existsSync);

    if (proposal.action === "create") {
      if (matches.length) {
        rejections.push({ proposalId: proposal.id, reason: "target already exists" });
        continue;
      }
      const kind = (proposal.targetKind ?? "memory") as keyof typeof TARGET_DIRS;
      const file = path.join(agentRoot, TARGET_DIRS[kind], `${targetId}.md`);
      const updated = new Date().toISOString();
      const metadata = [
        `id: ${targetId}`,
        `kind: ${kind}`,
        "status: candidate",
        ...(proposal.scope ? [`scope: ${proposal.scope}`] : []),
        `source_refs: ${proposal.sourceRefs.join(", ")}`,
        `updated: ${updated}`,
      ];
      mutations.push({
        proposalId: proposal.id,
        targetId,
        action: proposal.action,
        targetKind: kind,
        sourceRefs: proposal.sourceRefs,
        rationale: proposal.rationale,
        toStatus: "candidate",
        file,
        next: `---\n${metadata.join("\n")}\n---\n${proposal.after!.trim()}\n`,
      });
      continue;
    }

    if (matches.length !== 1) {
      rejections.push({
        proposalId: proposal.id,
        reason: matches.length ? "target id is ambiguous" : "update target not found",
      });
      continue;
    }
    const file = matches[0];
    if (path.basename(path.dirname(file)) === "core") {
      rejections.push({ proposalId: proposal.id, reason: "core is protected" });
      continue;
    }
    const existing = await readFile(file, "utf8");
    if (hashContent(existing) !== proposal.baseHash) {
      rejections.push({ proposalId: proposal.id, reason: "target changed since reflection" });
      continue;
    }
    const { meta } = parseFrontmatter(existing);
    const sources = [...new Set([
      ...splitRefs(meta.source_refs),
      ...proposal.sourceRefs,
    ])];
    const nextMeta = {
      ...meta,
      id: targetId,
      kind: meta.kind ?? "memory",
      status: meta.status ?? "candidate",
      ...(proposal.scope ? { scope: proposal.scope } : {}),
      source_refs: sources.join(", "),
      updated: new Date().toISOString(),
    };
    const fm = Object.entries(nextMeta).map(([key, value]) => `${key}: ${value}`).join("\n");
    mutations.push({
      proposalId: proposal.id,
      targetId,
      action: proposal.action,
      sourceRefs: proposal.sourceRefs,
      rationale: proposal.rationale,
      fromStatus: meta.status ?? "candidate",
      toStatus: nextMeta.status,
      file,
      previous: existing,
      next: `---\n${fm}\n---\n${proposal.after!.trim()}\n`,
    });
  }
  return { mutations, rejections };
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
  if (!SAFE_ID.test(targetId)) throw new Error("invalid targetId");
  if (!rationale.trim()) throw new Error("missing rationale");
  if (!sourceRefs.length || sourceRefs.some((ref) => !ref.trim() || ref.length > 500 || /[\r\n]/.test(ref))) {
    throw new Error("invalid sourceRefs");
  }
  const directories = [...Object.values(TARGET_DIRS), "core"];
  const matches = directories
    .map((directory) => path.join(agentRoot, directory, `${targetId}.md`))
    .filter(existsSync);
  if (matches.length !== 1) throw new Error(matches.length ? "target id is ambiguous" : "target not found");
  if (path.basename(path.dirname(matches[0])) === "core") throw new Error("core is protected");
  const file = matches[0];
  const existing = await readFile(file, "utf8");
  const { meta, body } = parseFrontmatter(existing);
  const fromStatus = meta.status ?? "candidate";
  const transition = `${fromStatus}:${toStatus}`;
  if (!ACTIVE_TRANSITIONS.has(transition) && !INACTIVE_TRANSITIONS.has(transition)) {
    throw new Error(`invalid lifecycle transition: ${transition}`);
  }
  const canonical = await evidenceRecords(agentRoot);
  const canonicalIds = new Set(canonical.filter((record) => record.agent === agent).map((record) => record.id));
  if (sourceRefs.some((ref) => !canonicalIds.has(ref))) throw new Error("source evidence not found or owned by another agent");
  if (toStatus === "active") {
    const roots = independentSuccessRoots(canonical, targetId);
    if (roots.size < 2) throw new Error("activation requires two independent successful application roots");
    const appliedEvidence = canonical.filter((record) => {
      const applied = Array.isArray(record.data.appliedRefs) ? record.data.appliedRefs : [];
      return applied.includes(targetId) && record.data.outcome === "success" && record.data.evaluator === "pass";
    });
    if (sourceRefs.some((ref) => !appliedEvidence.some((record) => record.id === ref))) {
      throw new Error("activation sources must be successful application outcomes");
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
    if (hashContent(current) !== beforeHash) throw new Error("target changed during transition");
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
    const { syncVault } = await import("./index");
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
  if (!revision || revision.agent !== agent) throw new Error("revision not found");
  if (revisions.some((entry) => entry.actor === "rollback" && entry.sourceRefs.includes(revisionId))) {
    throw new Error("revision already rolled back");
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
  if (!matches.length && !createFile) throw new Error("rollback target not found or ambiguous");
  if (matches.length > 1) throw new Error("rollback target not found or ambiguous");
  const file = matches[0] ?? createFile!;
  if (path.basename(path.dirname(file)) === "core") throw new Error("core is protected");
  const current = matches.length ? await readFile(file, "utf8") : "";
  if (matches.length && hashContent(current) !== revision.afterHash) throw new Error("target changed since revision");
  if (!matches.length && revision.afterHash !== hashContent("")) throw new Error("target changed since revision");

  const currentHash = hashContent(current);
  const currentSnapshot = matches.length
    ? path.join(agentRoot, "audit", "snapshots", `${currentHash}.md`)
    : undefined;
  let previous: string | undefined;
  if (revision.action === "rollback" && revision.beforeHash) {
    const original = revisions.find((entry) => entry.id === revision.sourceRefs[0]);
    if (!original) throw new Error("rollback source revision not found");
    previous = await readFile(
      path.join(agentRoot, "audit", "snapshots", `${original.afterHash}.md`),
      "utf8",
    ).catch(() => { throw new Error("revision snapshot not found"); });
  } else if (revision.beforeHash) {
    previous = await readFile(
      path.join(agentRoot, "audit", "snapshots", `${revision.beforeHash}.md`),
      "utf8",
    ).catch(() => { throw new Error("revision snapshot not found"); });
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
    if (matches.length !== Number(latestExists)) throw new Error("target changed during rollback");
    if (latestExists && hashContent(await readFile(file, "utf8")) !== currentHash) {
      throw new Error("target changed during rollback");
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
    const { syncVault } = await import("./index");
    await syncVault(db, vault, agentRoot, agent);
  }
  return {
    rolledBack: revisionId,
    targetId: revision.targetId,
    revisionId: rollback.id,
    deleted: previous === undefined,
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
  if (!existsSync(jobPath)) throw new Error(`reflection job not found: ${jobId}`);
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
        throw new Error("evidence reviewed concurrently");
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
      const { syncVault } = await import("./index");
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
