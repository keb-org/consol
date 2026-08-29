import { z } from "zod";
import path from "node:path";
import os from "node:os";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2" as const;
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9" as const;
export const MODEL_DTYPE = "q8" as const;
export const EMBED_DIMS = 384 as const;
// RRF constant k=60 prevents high-ranked items from dominating fused score disproportionately.
export const RRF_K = 60 as const;

export const Budgets = z.object({
  coreTokens: z.number().default(900),
  coreCeiling: z.number().default(1200),
  packetTokens: z.number().default(1200),
  packetCeiling: z.number().default(3000),
  l2Bytes: z.number().default(4096),
  perArmCap: z.number().default(20),
  quotas: z.object({
    memory: z.number().default(4),
    experience: z.number().default(4),
    case: z.number().default(3),
    skill: z.number().default(2),
    inbox: z.number().default(3),
  }).default({}),
});

export type Budgets = z.infer<typeof Budgets>;

export const VaultConfig = z.object({
  vault: z.string(),
  agent: z.string().min(1),
  budgets: Budgets.default({}),
  caveman: z.object({
    enabled: z.boolean().default(false),
    apiKeyEnv: z.string().optional(),
    baseURL: z.string().optional(),
  }).default({ enabled: false }),
  runner: z.object({
    endpoint: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    model: z.string().optional(),
  }).default({}),
});

export type VaultConfig = z.infer<typeof VaultConfig>;

export function resolveConfig(argv: Record<string, string | boolean | undefined>): VaultConfig {
  const rawVault = (argv.vault as string) || process.env.MEMORY_VAULT || process.env.VAULT || path.join(os.homedir(), ".memory-vault");
  const vault = rawVault.startsWith("~")
    ? path.resolve(os.homedir(), rawVault.slice(1).replace(/^[/\\]/, ""))
    : path.resolve(rawVault);
  const agent = (argv.agent as string) || process.env.MEMORY_AGENT || process.env.AGENT || process.env.USER || process.env.USERNAME || "default";
  const raw: VaultConfig = {
    vault,
    agent,
    budgets: Budgets.parse({}),
    caveman: {
      enabled: Boolean(process.env.CAVEMAN_API_KEY && process.env.CAVEMAN_BASE_URL),
      apiKeyEnv: process.env.CAVEMAN_API_KEY ? "CAVEMAN_API_KEY" : undefined,
      baseURL: process.env.CAVEMAN_BASE_URL,
    },
    runner: {
      endpoint: process.env.MEMORY_ENDPOINT,
      apiKeyEnv: process.env.MEMORY_API_KEY ? "MEMORY_API_KEY" : undefined,
      model: process.env.MEMORY_MODEL,
    },
  };
  return VaultConfig.parse(raw);
}

export function vaultModelCache(vault: string) {
  return path.join(vault, "models");
}

export function agentRoot(vault: string, agent: string) {
  return path.join(vault, "agents", agent);
}

export function teamRoot(vault: string, team: string) {
  return path.join(vault, "teams", team);
}

// Fingerprint changes force SQLite index drop and rebuild without touching canonical files.
export function indexFingerprint() {
  return `${MODEL_ID}@${MODEL_REVISION}:${MODEL_DTYPE}:mean:l2:${EMBED_DIMS}:chunk-v1`;
}
