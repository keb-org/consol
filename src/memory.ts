import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { atomicWrite, appendJsonl, evidencePath, frontmatter, hashContent, notePath, parseFrontmatter, stableId, withVaultLock } from "./vault";
import { syncVault } from "./index";

export type RememberInput = { statement: string; scope?: string; refs?: string[] };
export type RecordInput = { kind: string; data: Record<string, unknown>; refs?: string[] };
export type ForgetInput = { target: string; confirmation?: string };

export async function remember(vault: string, agentRoot: string, agent: string, input: RememberInput, db?: Database) {
  if (!input.statement?.trim()) throw new Error("empty statement");
  if (input.statement.includes("API_KEY") || /sk-[A-Za-z0-9]{20,}/.test(input.statement)) throw new Error("secret rejected");
  const dedup = await findDuplicate(agentRoot, input.statement);
  if (dedup) return { id: dedup, dedup: true };
  const id = stableId("mem-");
  const file = notePath(agentRoot, "memory", id);
  const fm = frontmatter("memory", id, { scope: input.scope ?? "", updated: new Date().toISOString(), source: agent });
  const body = input.refs?.length ? `${input.statement}\n\nRefs: ${input.refs.join(", ")}` : input.statement;
  await withVaultLock(vault, async () => {
    await atomicWrite(file, `${fm}${body}\n`);
  });
  if (db) await syncVault(db, vault, agentRoot, agent);
  return { id, path: file };
}

async function findDuplicate(agentRoot: string, statement: string) {
  const normalized = statement.trim().slice(0, 80);
  return null as string | null;
}

export async function record(vault: string, agentRoot: string, agent: string, input: RecordInput) {
  if (!input.kind) throw new Error("kind required");
  const id = stableId("ev-");
  const rec = { id, at: new Date().toISOString(), agent, kind: input.kind, data: input.data, refs: input.refs ?? [] };
  const file = evidencePath(agentRoot, new Date());
  await appendJsonl(file, rec);
  return rec;
}

export async function forgetPlan(vault: string, agentRoot: string, target: string) {
  const candidates: string[] = [];
  const dirs = ["memories", "cases", "experiences", "skills", "core"];
  for (const d of dirs) {
    const dir = path.join(agentRoot, d);
    if (!existsSync(dir)) continue;
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir).catch(() => []);
    for (const e of entries as string[]) {
      if (e.includes(target) || target === e.replace(/\.md$/, "")) candidates.push(path.join(dir, e));
      if (e.endsWith(".md")) {
        const text = await readFile(path.join(dir, e), "utf8").catch(() => "");
        if (text.toLowerCase().includes(target.toLowerCase())) candidates.push(path.join(dir, e));
      }
    }
  }
  const token = hashContent(`${target}:${Date.now()}:${Math.random()}`).slice(0, 16);
  const planPath = path.join(agentRoot, "jobs", `forget-${token}.json`);
  await atomicWrite(planPath, JSON.stringify({ target, token, candidates: [...new Set(candidates)], createdAt: new Date().toISOString() }, null, 2));
  return { token, candidates: [...new Set(candidates)], requiresConfirmation: true };
}

export async function forgetConfirm(vault: string, agentRoot: string, agent: string, target: string, confirmation: string, db?: Database) {
  const planPath = path.join(agentRoot, "jobs", `forget-${confirmation}.json`);
  if (!existsSync(planPath)) throw new Error("unknown confirmation token");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (plan.target !== target) throw new Error("target mismatch");
  const aRootReal = path.resolve(agentRoot);
  for (const p of plan.candidates as string[]) {
    const r = path.resolve(p);
    if (r !== aRootReal && !r.startsWith(aRootReal + path.sep)) throw new Error("forget candidate escapes agent root");
  }
  await withVaultLock(vault, async () => {
    for (const p of plan.candidates as string[]) {
      const { unlink } = await import("node:fs/promises");
      await unlink(p).catch(() => {});
      if (db) {
        const rel = path.relative(aRootReal, path.resolve(p)).split(path.sep).join("/");
        const ids = db.query("SELECT chunk_id FROM chunks WHERE path=?").all(rel) as { chunk_id: number }[];
        for (const { chunk_id } of ids) {
          try { db.query("DELETE FROM chunks_fts WHERE rowid=?").run(chunk_id); } catch {}
          try { db.query("DELETE FROM chunk_vectors WHERE chunk_id=?").run(chunk_id); } catch {}
        }
        db.query("DELETE FROM chunks WHERE path=?").run(rel);
        db.query("DELETE FROM files WHERE path=?").run(rel);
      }
    }
    const { unlink } = await import("node:fs/promises");
    await unlink(planPath).catch(() => {});
  });
  return { erased: (plan.candidates as string[]).length, target };
}

export async function readNote(agentRoot: string, docId: string) {
  const dirs = ["memories", "cases", "experiences", "skills", "core"];
  for (const d of dirs) {
    const p = path.join(agentRoot, d, `${docId}.md`);
    if (existsSync(p)) return { path: p, text: await readFile(p, "utf8") };
  }
  const teamsRoot = path.join(path.dirname(path.dirname(agentRoot)), "teams");
  if (existsSync(teamsRoot)) {
    const { readdir } = await import("node:fs/promises");
    const teams = await readdir(teamsRoot).catch(() => []) as string[];
    for (const t of teams) {
      for (const d of ["memories", "experiences"]) {
        const p = path.join(teamsRoot, t, d, `${docId}.md`);
        if (existsSync(p)) return { path: p, text: await readFile(p, "utf8") };
      }
    }
  }
  throw new Error("not found");
}
