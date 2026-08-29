import path from "node:path";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { atomicWrite, stableId } from "./vault";
import { containsSecret } from "./security";

export type AgentMeta = {
  id: string;
  role?: string;
  capabilities?: string[];
  teams?: string[];
  createdAt: string;
};

export type TeamMeta = {
  id: string;
  members: string[];
  createdAt: string;
};

export type ThreadEvent = {
  id: string;
  at: string;
  from: string;
  to: string;
  kind: "question" | "reply" | "task" | "result" | "handoff";
  content: string;
  refs?: string[];
};

function sanitizeId(id: string) {
  if (!id || typeof id !== "string" || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`invalid identifier: ${id}`);
  }
  return id;
}

export async function ensureAgent(vault: string, agent: string, role = "assistant") {
  sanitizeId(agent);
  const dir = path.join(vault, "agents", agent);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "agent.json");
  if (!existsSync(file)) {
    const meta: AgentMeta = { id: agent, role, capabilities: [], teams: [], createdAt: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(meta, null, 2));
  }
  await mkdir(path.join(dir, "messages"), { recursive: true });
  return file;
}

export async function ensureTeam(vault: string, team: string) {
  sanitizeId(team);
  const dir = path.join(vault, "teams", team);
  await mkdir(dir, { recursive: true });
  for (const sub of ["memories", "experiences", "threads", "tasks", "audit"]) await mkdir(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, "team.json");
  if (!existsSync(file)) {
    const meta: TeamMeta = { id: team, members: [], createdAt: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(meta, null, 2));
  }
  return dir;
}

export async function getAttachedTeams(vault: string, agent: string) {
  sanitizeId(agent);
  const file = path.join(vault, "agents", agent, "agent.json");
  if (!existsSync(file)) return new Set<string>();
  try {
    const meta = JSON.parse(await readFile(file, "utf8")) as AgentMeta;
    return new Set((meta.teams ?? []).filter((team) => {
      try { sanitizeId(team); return true; } catch { return false; }
    }).map((team) => `team:${team}`));
  } catch {
    return new Set<string>();
  }
}

export async function attachTeam(vault: string, agent: string, team: string) {
  await ensureTeam(vault, team);
  await ensureAgent(vault, agent);
  const file = path.join(vault, "agents", agent, "agent.json");
  const meta = JSON.parse(await readFile(file, "utf8")) as AgentMeta;
  if (!meta.teams?.includes(team)) {
    meta.teams = [...(meta.teams ?? []), team];
    await atomicWrite(file, JSON.stringify(meta, null, 2));
  }
  const teamFile = path.join(vault, "teams", team, "team.json");
  const teamMeta = JSON.parse(await readFile(teamFile, "utf8")) as TeamMeta;
  if (!teamMeta.members.includes(agent)) {
    teamMeta.members.push(agent);
    await atomicWrite(teamFile, JSON.stringify(teamMeta, null, 2));
  }
}

export async function send(vault: string, from: string, to: string, kind: ThreadEvent["kind"], content: string, refs?: string[]) {
  if (!content?.trim()) throw new Error("empty content");
  sanitizeId(from);
  const isTeam = to.startsWith("team:") || existsSync(path.join(vault, "teams", to));
  const teamId = isTeam ? to.replace(/^team:/, "") : null;
  sanitizeId(teamId ?? to);
  if (containsSecret({ content, refs })) throw new Error("secret rejected");
  const id = stableId("msg-");
  const ev: ThreadEvent = { id, at: new Date().toISOString(), from, to, kind, content, refs };
  if (teamId) {
    await ensureTeam(vault, teamId);
    const thread = path.join(vault, "teams", teamId, "threads", `${id}.json`);
    await atomicWrite(thread, JSON.stringify(ev, null, 2));
  } else {
    await ensureAgent(vault, to);
    const inbox = path.join(vault, "agents", to, "messages", `${id}.json`);
    await atomicWrite(inbox, JSON.stringify(ev, null, 2));
  }
  const senderCopy = path.join(vault, "agents", from, "messages", `${id}.json`);
  if (!existsSync(senderCopy)) {
    await ensureAgent(vault, from);
    await atomicWrite(senderCopy, JSON.stringify({ ...ev, copy: "sent" }, null, 2));
  }
  return ev;
}

export async function inbox(vault: string, agent: string, limit = 10): Promise<ThreadEvent[]> {
  const dir = path.join(vault, "agents", agent, "messages");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir).catch(() => []);
  const out: ThreadEvent[] = [];
  for (const e of entries.slice(-limit * 2)) {
    try {
      const j = JSON.parse(await readFile(path.join(dir, e), "utf8"));
      if (j.to === agent || j.from === agent) out.push(j);
    } catch {}
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(-limit);
}

export async function readThread(vault: string, agent: string, threadId: string) {
  sanitizeId(agent);
  sanitizeId(threadId.replace(/\.json$/, ""));
  const candidates = [
    path.join(vault, "agents", agent, "messages", `${threadId}.json`),
    path.join(vault, "agents", agent, "messages", threadId),
  ];
  for (const p of candidates) if (existsSync(p)) return JSON.parse(await readFile(p, "utf8")) as ThreadEvent;
  for (const owner of await getAttachedTeams(vault, agent)) {
    const team = owner.slice("team:".length);
    const p = path.join(vault, "teams", team, "threads", `${threadId}.json`);
    if (existsSync(p)) return JSON.parse(await readFile(p, "utf8")) as ThreadEvent;
    const p2 = path.join(vault, "teams", team, "threads", threadId);
    if (existsSync(p2)) return JSON.parse(await readFile(p2, "utf8")) as ThreadEvent;
  }
  throw new Error("thread not found");
}
