import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { hashContent, parseFrontmatter } from "../storage/vault";
import { decodeRef } from "../retrieval/packet";
import { containsSecret } from "../core/security";
import { abstractionLevel } from "../retrieval/transfer";
import type { EvidenceRecord } from "./evidence";

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

export type Rejection = { proposalId?: string; reason: string };

export const TARGET_DIRS = {
  memory: "memories",
  case: "cases",
  experience: "experiences",
  skill: "skills",
} as const;

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

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

export function packetSourceRefs(job: { packet: { items?: any[]; evidence?: EvidenceRecord[] } }): Set<string> {
  const refs = new Set<string>();
  for (const record of job.packet.evidence ?? []) refs.add(record.id);
  for (const item of job.packet.items ?? []) {
    if (typeof item?.ref === "string") refs.add(item.ref);
  }
  return refs;
}

export async function validatePacketItemRefs(
  vault: string,
  job: { packet: { items?: any[] } },
  db: Database | undefined,
  agent: string,
): Promise<Rejection[]> {
  if (!job.packet.items?.length) return [];
  if (!db) return [{ reason: "packet refs require current index validation" }];
  const { getAttachedTeams } = await import("../core/identity");
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
      else if (row.doc_id !== decoded.d || !row.hash.startsWith(decoded.h)) rejections.push({ reason: `packet ref is stale or forged: ${item.ref}` });
      else if (row.owner !== decoded.o) rejections.push({ reason: `packet ref owner mismatch: ${item.ref}` });
      else if (!allowedOwners.has(row.owner)) rejections.push({ reason: `packet ref owner not attached: ${item.ref}` });
    } catch {
      rejections.push({ reason: `invalid packet ref: ${item.ref}` });
    }
  }
  return rejections;
}

export type PreparedMutation = {
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

export function splitRefs(value: string | undefined): string[] {
  return (value ?? "").split(/[;,]/).map((ref) => ref.trim()).filter(Boolean);
}

export async function prepareMutations(
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
