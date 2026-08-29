#!/usr/bin/env bun
import path from "node:path";
import { existsSync } from "node:fs";
import { resolveConfig, agentRoot, vaultModelCache } from "./config";
import { ensureVault } from "./vault";
import { openIndex, syncVault, rebuild } from "./index";
import { createJob, stageProposals } from "./reflection";
import { runReflection } from "./runners";
import { serve } from "./mcp";

function parseArgs(argv: string[]): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdio") out.stdio = true;
    else if (a === "--once") out.once = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) { out[k] = v; i++; }
      else out[k] = true;
    } else if (!out._cmd) out._cmd = a;
  }
  return out;
}

async function cmdDoctor(args: Record<string, string | boolean | undefined>) {
  const config = resolveConfig(args);
  const aRoot = agentRoot(config.vault, config.agent);
  const checks: any[] = [];
  checks.push({ name: "vault", path: config.vault, exists: existsSync(config.vault) });
  checks.push({ name: "agentRoot", path: aRoot, exists: existsSync(aRoot) });
  checks.push({ name: "index", path: path.join(aRoot, "index.sqlite"), exists: existsSync(path.join(aRoot, "index.sqlite")) });
  const modelCache = vaultModelCache(config.vault);
  checks.push({ name: "modelCache", path: modelCache, exists: existsSync(modelCache) });
  checks.push({ name: "q8 model", id: "Xenova/all-MiniLM-L6-v2 q8 751bff3", ready: existsSync(path.join(modelCache, "Xenova", "all-MiniLM-L6-v2")) });
  console.log(JSON.stringify({ config: { vault: config.vault, agent: config.agent, fingerprint: (await import("./config")).indexFingerprint() }, checks }, null, 2));
}

async function cmdSetup(args: Record<string, string | boolean | undefined>) {
  const config = resolveConfig(args);
  const { agentRoot: aRoot } = await ensureVault(config.vault, config.agent);
  const db = openIndex(aRoot);
  await syncVault(db, config.vault, aRoot, config.agent);
  try {
    const { getEmbedder } = await import("./index");
    await getEmbedder(config.vault);
    console.log(JSON.stringify({ ok: true, vault: config.vault, agent: config.agent, cache: vaultModelCache(config.vault) }));
  } catch (e: any) {
    console.log(JSON.stringify({ ok: true, vault: config.vault, agent: config.agent, note: "index ready; model will download on first recall" }));
  }
  db.close();
}

async function cmdReindex(args: Record<string, string | boolean | undefined>) {
  const config = resolveConfig(args);
  const aRoot = agentRoot(config.vault, config.agent);
  await ensureVault(config.vault, config.agent);
  const db = openIndex(aRoot);
  await rebuild(db, config.vault, aRoot, config.agent);
  console.log(JSON.stringify({ ok: true, rebuilt: true }));
  db.close();
}

async function cmdReflect(args: Record<string, string | boolean | undefined>) {
  const config = resolveConfig(args);
  const aRoot = agentRoot(config.vault, config.agent);
  await ensureVault(config.vault, config.agent);
  const db = openIndex(aRoot);
  await syncVault(db, config.vault, aRoot, config.agent).catch(() => {});
  const job = await createJob(config.vault, aRoot, config, db);
  console.log(JSON.stringify({ job: job.id, packet: job.packet }, null, 2));
  if (args.once) {
    const { proposals, runner } = await runReflection(job, config);
    const res = await stageProposals(config.vault, aRoot, job.id, proposals, db);
    console.log(JSON.stringify({ runner, ...res }, null, 2));
  }
  db.close();
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = (args._cmd as string) ?? "";

  if (cmd === "serve") {
    await serve(args);
    return;
  }
  if (cmd === "doctor") { await cmdDoctor(args); return; }
  if (cmd === "setup") { await cmdSetup(args); return; }
  if (cmd === "reindex") { await cmdReindex(args); return; }
  if (cmd === "reflect") { await cmdReflect(args); return; }
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(`long-horizon-memory

Usage:
  consol serve [--vault <path>] [--agent <id>] [--http] [--port <port>]
  consol setup [--vault <path>] [--agent <id>]
  consol doctor [--vault <path>] [--agent <id>]
  consol reindex [--vault <path>] [--agent <id>]
  consol reflect --once [--vault <path>] [--agent <id>]

MCP tools (stdio by default, http via --http): recall / read / remember / record / forget / send
Env: VAULT (or MEMORY_VAULT), AGENT (or MEMORY_AGENT), MEMORY_ENDPOINT, MEMORY_API_KEY, MEMORY_MODEL, CAVEMAN_API_KEY, CAVEMAN_BASE_URL
`);
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
