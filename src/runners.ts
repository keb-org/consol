import path from "node:path";
import { existsSync } from "node:fs";
import { $ } from "bun";
import type { Job, Proposal } from "./reflection";
import type { VaultConfig } from "./config";

export type RunnerName = "sampling" | "claude" | "codex" | "endpoint" | "manual" | "none";

const SYSTEM = `You are a memory reflection assistant. Given unreviewed cases and related memory, propose precise patches.
Return JSON: {"proposals":[{"id":"...","action":"create|update|merge|split|supersede|contradict|promote|demote|archive|skip","targetKind":"memory|case|experience|skill","targetId":"...","before":"...","after":"...","baseHash":"...","sourceRefs":["..."],"scope":"...","expectedEffect":"...","disconfirming":"...","alternatives":"...","rationale":"..."}]}
Rules: cite exact sourceRefs, no secrets, no erasure, self-citation invalid, confidence is not truth.`;

function jobPrompt(job: Job) {
  return JSON.stringify({ packet: job.packet, instructions: SYSTEM }, null, 2);
}

async function tryClaude(job: Job): Promise<Proposal[] | null> {
  try {
    const prompt = jobPrompt(job);
    const proc = Bun.spawn(["claude", "-p", prompt], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(out);
    const text = parsed.result ?? out;
    const j = JSON.parse(extractJson(text));
    return j.proposals ?? [];
  } catch { return null; }
}

async function tryCodex(job: Job): Promise<Proposal[] | null> {
  try {
    const prompt = jobPrompt(job);
    const proc = Bun.spawn(["codex", "exec", "--json", prompt], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const j = JSON.parse(extractJson(out));
    return j.proposals ?? j.events?.find((e: any) => e.proposals)?.proposals ?? null;
  } catch { return null; }
}

async function tryEndpoint(job: Job, config: VaultConfig): Promise<Proposal[] | null> {
  const url = config.runner.endpoint;
  const envName = config.runner.apiKeyEnv;
  const model = config.runner.model ?? "gpt-4o-mini";
  if (!url || !envName) return null;
  const key = process.env[envName];
  if (!key) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: jobPrompt(job) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const content = j.choices?.[0]?.message?.content ?? j.output ?? "";
    const parsed = JSON.parse(extractJson(content));
    return parsed.proposals ?? [];
  } catch { return null; }
}

function extractJson(text: string) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) return text.slice(s, e + 1);
  return text;
}

export async function runReflection(job: Job, config: VaultConfig, samplingFn?: (prompt: string) => Promise<string>): Promise<{ runner: RunnerName; proposals: Proposal[] }> {
  if (samplingFn) {
    try {
      const raw = await samplingFn(jobPrompt(job));
      const j = JSON.parse(extractJson(raw));
      if (Array.isArray(j.proposals)) return { runner: "sampling", proposals: j.proposals };
    } catch {}
  }
  const claude = await tryClaude(job);
  if (claude) return { runner: "claude", proposals: claude };
  const codex = await tryCodex(job);
  if (codex) return { runner: "codex", proposals: codex };
  const endpoint = await tryEndpoint(job, config);
  if (endpoint) return { runner: "endpoint", proposals: endpoint };
  return { runner: "none", proposals: [] };
}

export async function hasClaude(): Promise<boolean> {
  try { await $`which claude`.quiet(); return true; } catch { return false; }
}
export async function hasCodex(): Promise<boolean> {
  try { await $`which codex`.quiet(); return true; } catch { return false; }
}
