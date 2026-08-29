import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { atomicWrite, hashContent, parseFrontmatter, stableId } from "./vault";
import { recall } from "./retrieval";
import type { VaultConfig } from "./config";

export type ProposalAction =
  | "create" | "update" | "merge" | "split" | "supersede"
  | "contradict" | "promote" | "demote" | "archive" | "forget" | "skip";

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

export type Job = {
  id: string;
  createdAt: string;
  status: "pending" | "claimed" | "done" | "failed";
  packet: { query: string; items: any[] };
  proposals?: Proposal[];
};

export async function selectCases(agentRoot: string, limit = 12): Promise<string[]> {
  const evidenceDir = path.join(agentRoot, "evidence");
  if (!existsSync(evidenceDir)) return [];
  const years = await readdir(evidenceDir).catch(() => []);
  const candidates: { path: string; score: number }[] = [];
  for (const y of years) {
    const months = await readdir(path.join(evidenceDir, y)).catch(() => []);
    for (const m of months) {
      const file = path.join(evidenceDir, y, m);
      const text = await readFile(file, "utf8").catch(() => "");
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines.slice(-20)) {
        try {
          const rec = JSON.parse(line);
          const isUnreviewed = !rec.reviewed;
          const isFailure = rec.data?.outcome === "failure" || rec.data?.evaluator === "fail";
          const isCorrection = rec.kind === "correction";
          if (isUnreviewed && (isFailure || isCorrection || rec.kind === "case")) {
            candidates.push({ path: rec.id, score: (isFailure ? 3 : 0) + (isCorrection ? 2 : 0) + 1 });
          }
        } catch {}
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map((c) => c.path);
}

export async function buildPacket(
  db: Database,
  vault: string,
  agentRoot: string,
  config: VaultConfig,
): Promise<{ query: string; items: any[] }> {
  const cases = await selectCases(agentRoot, 8);
  if (cases.length === 0) return { query: "recent learning", items: [] };
  const query = cases.slice(0, 3).join(" ");
  const pkt = await recall(db, vault, query, config.budgets);
  return { query, items: pkt.items.slice(0, 8) };
}

export function validateProposal(p: Proposal, agentRoot: string): { ok: boolean; reason?: string } {
  if (!p.rationale?.trim()) return { ok: false, reason: "missing rationale" };
  if (!p.sourceRefs?.length && p.action !== "skip") return { ok: false, reason: "missing sourceRefs" };
  if (p.action === "forget") return { ok: false, reason: "forget requires explicit plan" };
  if (p.after && /sk-[A-Za-z0-9]{20,}|API_KEY|BEGIN PRIVATE KEY/.test(p.after)) return { ok: false, reason: "secret in proposal" };
  if (p.before && p.baseHash) {
    const beforeHash = hashContent(p.before);
    if (beforeHash !== p.baseHash) return { ok: false, reason: "stale baseHash" };
  }
  if (p.after && p.after.includes(p.rationale) && p.sourceRefs.length === 1 && p.sourceRefs[0] === p.targetId) {
    return { ok: false, reason: "self-citation" };
  }
  return { ok: true };
}

export async function stageProposals(
  vault: string,
  agentRoot: string,
  jobId: string,
  proposals: Proposal[],
  db?: Database,
) {
  const jobPath = path.join(agentRoot, "jobs", `${jobId}.json`);
  const job: Job = existsSync(jobPath) ? JSON.parse(await readFile(jobPath, "utf8")) : { id: jobId, createdAt: new Date().toISOString(), status: "pending", packet: { query: "", items: [] } };
  const valid = proposals.filter((p) => validateProposal(p, agentRoot).ok);
  job.proposals = valid;
  job.status = "done";
  await atomicWrite(jobPath, JSON.stringify(job, null, 2));

  for (const p of valid) {
    if (p.action === "create" && p.after && p.targetId) {
      const kind = (p.targetKind as any) ?? "memory";
      const file = path.join(agentRoot, kind === "experience" ? "experiences" : kind === "case" ? "cases" : kind === "skill" ? "skills" : "memories", `${p.targetId}.md`);
      const fm = `---\nid: ${p.targetId}\nkind: ${kind}\nstatus: candidate\nsource: ${p.sourceRefs.join(",")}\n---\n`;
      await atomicWrite(file, `${fm}${p.after}\n`);
    }
    if (p.action === "update" && p.after && p.targetId) {
      const dirs = ["memories", "cases", "experiences", "skills", "core"];
      for (const d of dirs) {
        const file = path.join(agentRoot, d, `${p.targetId}.md`);
        if (existsSync(file)) {
          const existing = await readFile(file, "utf8");
          const { meta } = parseFrontmatter(existing);
          const currentHash = hashContent(existing);
          const expected = (p.baseHash ?? currentHash);
          if (expected !== currentHash && p.baseHash) continue;
          const fm = `---\nid: ${p.targetId}\nkind: ${meta.kind ?? "memory"}\nstatus: ${meta.status ?? "candidate"}\nupdated: ${new Date().toISOString()}\n---\n`;
          await atomicWrite(file, `${fm}${p.after}\n`);
          break;
        }
      }
    }
  }
  if (db) {
    const { syncVault } = await import("./index");
    const agent = path.basename(agentRoot);
    await syncVault(db, vault, agentRoot, agent);
  }
  return { staged: valid.length, total: proposals.length };
}

export async function createJob(vault: string, agentRoot: string, config: VaultConfig, db: Database): Promise<Job> {
  const packet = await buildPacket(db, vault, agentRoot, config);
  const id = stableId("job-");
  const job: Job = { id, createdAt: new Date().toISOString(), status: "pending", packet };
  await atomicWrite(path.join(agentRoot, "jobs", `${id}.json`), JSON.stringify(job, null, 2));
  return job;
}
