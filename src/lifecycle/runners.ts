import { $ } from "bun";
import type { VaultConfig } from "../core/config";
import { redactSecrets } from "../core/security";
import type { Proposal } from "./proposals";
import type { Job } from "./jobs";

export type RunnerName = "sampling" | "claude" | "codex" | "endpoint" | "manual" | "none";

export type ReflectionRunResult = {
  runner: RunnerName;
  proposals: Proposal[];
  diagnostics: string[];
};

const SYSTEM = `Distill unreviewed evidence into candidate patches.
Rules:
• Drop articles, pronouns, filler, fluff. Ultra-concise fragments.
• No meta-discourse. Preserve exact code, IDs, paths, values.
• Return JSON: {"proposals":[{"id":"...","action":"create|update|skip","targetKind":"memory|case|experience|skill","targetId":"...","before":"...","after":"...","baseHash":"...","sourceRefs":["..."],"scope":"...","expectedEffect":"...","disconfirming":"...","alternatives":"...","rationale":"..."}]}
• Address every evidence record. Cite exact evidence ID. Cite only refs in packet. No secrets, no erasure, no direct core edits. Use skip with sourceRefs and rationale when no durable patch warranted.`;

function jobPrompt(job: Job) {
  return JSON.stringify({ packet: job.packet, instructions: SYSTEM }, null, 2);
}

function diagnostic(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function runCli(command: string[], timeoutMs = 120_000) {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`${command[0]} timed out after ${timeoutMs}ms — category: out-of-bounds. Fix: shorten prompt or raise timeout`));
        }, timeoutMs);
      }),
    ]);
    if (exitCode !== 0) {
      throw new Error(`${command[0]} exited ${exitCode}${stderr.trim() ? ` — stderr: ${stderr.trim().slice(0, 600)}` : ""} — category: out-of-bounds. Fix: check CLI installation and arguments`);
    }
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function proposalEnvelope(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(extractJson(value)) : value;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).proposals)) {
    throw new Error("runner output missing proposals — category: type error. Fix: ensure JSON envelope has {proposals: [...]}");
  }
  return (parsed as { proposals: Proposal[] }).proposals;
}

export function parseClaudeOutput(text: string) {
  const parsed = JSON.parse(text);
  const result = parsed?.result ?? parsed?.structured_output ?? parsed;
  return proposalEnvelope(result);
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => typeof part === "string" ? part : contentText((part as any)?.text ?? (part as any)?.content))
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

export function parseCodexOutput(text: string) {
  const events = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((event): event is Record<string, any> => Boolean(event));
  for (const event of [...events].reverse()) {
    const candidate = contentText(
      event.item?.text ??
      event.item?.content ??
      event.message?.content ??
      event.output_text ??
      event.text,
    );
    if (!candidate) continue;
    try { return proposalEnvelope(candidate); } catch {}
  }
  throw new Error("codex output missing proposal envelope — category: type error (no JSONL event contained a valid {proposals: [...]} envelope). Fix: ensure codex exec --json outputs an item/message/output_text field with valid proposals JSON; check codex version and prompt format");
}

export function parseEndpointOutput(value: unknown) {
  const response = value as any;
  const content = response?.choices?.[0]?.message?.content ?? response?.output ?? response;
  return proposalEnvelope(content);
}

async function runClaude(job: Job) {
  const output = await runCli(["claude", "-p", "--output-format", "json", jobPrompt(job)]);
  return parseClaudeOutput(output);
}

async function runCodex(job: Job) {
  const output = await runCli(["codex", "exec", "--json", jobPrompt(job)]);
  return parseCodexOutput(output);
}

async function runEndpoint(job: Job, config: VaultConfig) {
  const url = config.runner.endpoint;
  const envName = config.runner.apiKeyEnv;
  const model = config.runner.model ?? "gpt-4o-mini";
  if (!url || !envName) throw new Error("endpoint not configured — category: type error (VaultConfig.runner.endpoint and apiKeyEnv required for endpoint runner). Fix: set config runner endpoint URL and apiKeyEnv name, and set that env var");
  const key = process.env[envName];
  if (!key) throw new Error(`endpoint credential env missing: ${envName} — category: unauthorized (env var not set or empty). Fix: export ${envName}=<api-key> in env before running reflection`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
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
  if (!res.ok) throw new Error(`endpoint HTTP ${res.status} — category: out-of-bounds or unauthorized (remote endpoint returned error status ${res.status}). Fix: check endpoint URL, auth key in ${envName}, and payload validity; retry with backoff on 5xx; verify endpoint is reachable and key has not expired`);
  return parseEndpointOutput(await res.json());
}

export async function runReflection(
  job: Job,
  config: VaultConfig,
  samplingFn?: (prompt: string) => Promise<string>,
): Promise<ReflectionRunResult> {
  const diagnostics: string[] = [];
  const attempts: { name: Exclude<RunnerName, "manual" | "none">; run: () => Promise<Proposal[]> }[] = [];
  if (samplingFn) {
    attempts.push({
      name: "sampling",
      run: async () => proposalEnvelope(await samplingFn(jobPrompt(job))),
    });
  }
  attempts.push(
    { name: "claude", run: () => runClaude(job) },
    { name: "codex", run: () => runCodex(job) },
  );
  if (config.runner.endpoint || config.runner.apiKeyEnv) {
    attempts.push({ name: "endpoint", run: () => runEndpoint(job, config) });
  }

  for (const attempt of attempts) {
    try {
      const proposals = await attempt.run();
      if (proposals.length) return { runner: attempt.name, proposals, diagnostics };
      diagnostics.push(`${attempt.name}: returned no proposals`);
    } catch (error) {
      diagnostics.push(`${attempt.name}: ${diagnostic(error)}`);
    }
  }
  return { runner: "none", proposals: [], diagnostics };
}

export async function hasClaude(): Promise<boolean> {
  try { await $`which claude`.quiet(); return true; } catch { return false; }
}

export async function hasCodex(): Promise<boolean> {
  try { await $`which codex`.quiet(); return true; } catch { return false; }
}
