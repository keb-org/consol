import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { atomicWrite } from "@/storage/vault";

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

// SSOT: Canonical identifier validation for agents, teams, and bank roots
export function sanitizeId(id: string, label = "identifier"): string {
  if (!id || typeof id !== "string" || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`invalid ${label}: ${id} — category: type error (${label} must match /^[A-Za-z0-9._-]+$/ without '..', '/', '\\'). Fix: pass plain name like 'linus'`);
  }
  return id.trim();
}

export async function ensureAgent(vault: string, agent: string, role = "assistant") {
  sanitizeId(agent, "agent");
  const dir = path.join(vault, "agents", agent);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "agent.json");
  if (!existsSync(file)) {
    const meta: AgentMeta = { id: agent, role, capabilities: [], teams: [], createdAt: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(meta, null, 2));
  }
  return file;
}

export async function ensureTeam(vault: string, team: string) {
  sanitizeId(team, "team");
  const dir = path.join(vault, "teams", team);
  await mkdir(dir, { recursive: true });
  for (const sub of ["memories", "experiences", "tasks", "audit"]) await mkdir(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, "team.json");
  if (!existsSync(file)) {
    const meta: TeamMeta = { id: team, members: [], createdAt: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(meta, null, 2));
  }
  return dir;
}

export async function getAttachedTeams(vault: string, agent: string): Promise<Set<string>> {
  sanitizeId(agent, "agent");
  const file = path.join(vault, "agents", agent, "agent.json");
  if (!existsSync(file)) return new Set<string>();
  try {
    const meta = JSON.parse(await readFile(file, "utf8")) as AgentMeta;
    return new Set((meta.teams ?? []).filter((team) => {
      try { sanitizeId(team, "team"); return true; } catch { return false; }
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
