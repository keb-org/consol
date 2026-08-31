import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { sanitizeId } from "./identity";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2" as const;
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9" as const;
export const MODEL_DTYPE = "q8" as const;
export const EMBED_DIMS = 384 as const;
// RRF constant k=60 prevents high-ranked items from dominating fused score disproportionately.
export const RRF_K = 60 as const;
// Maximum cosine distance for vector matches (1 - cosSim). 0.75 corresponds to cosSim >= 0.25,
// preserving cross-domain knowledge transfer while gating out pure random noise.
export const MAX_VECTOR_DISTANCE = 0.75 as const;

export const Budgets = z.object({
  coreTokens: z.number().int().positive().default(900),
  coreCeiling: z.number().int().positive().default(1200),
  packetTokens: z.number().int().positive().default(3000),
  packetCeiling: z.number().int().positive().default(3000),
  l2Bytes: z.number().int().positive().default(4096),
  perArmCap: z.number().int().positive().max(200).default(60),
  quotas: z.object({
    memory: z.number().int().nonnegative().default(12),
    experience: z.number().int().nonnegative().default(10),
    case: z.number().int().nonnegative().default(6),
    skill: z.number().int().nonnegative().default(4),
  }).default({}),
}).refine((b) => b.coreTokens <= b.coreCeiling, "coreTokens exceeds coreCeiling")
  .refine((b) => b.packetTokens <= b.packetCeiling, "packetTokens exceeds packetCeiling");

export type Budgets = z.infer<typeof Budgets>;

export const VaultConfig = z.object({
  vault: z.string(),
  agent: z.string().min(1),
  budgets: Budgets.default({}),
  runner: z.object({
    endpoint: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    model: z.string().optional(),
  }).default({}),
});

export type VaultConfig = z.infer<typeof VaultConfig>;

export function resolveConfig(argv: Record<string, string | boolean | undefined>): VaultConfig {
  const rawVault = (argv.vault as string) || process.env.CONSOL_VAULT || process.env.MEMORY_VAULT || process.env.VAULT || path.join(os.homedir(), ".consol-vault");
  const vault = rawVault.startsWith("~")
    ? path.join(os.homedir(), rawVault.slice(1).replace(/^[/\\]/, ""))
    : path.isAbsolute(rawVault)
      ? path.resolve(rawVault)
      : path.resolve(process.cwd(), rawVault);
  const rawAgent = (argv.agent as string) || process.env.MEMORY_AGENT || process.env.AGENT || process.env.USER || process.env.USERNAME || "default";
  const agent = sanitizeId(rawAgent, "agent");
  const raw: VaultConfig = {
    vault,
    agent,
    budgets: Budgets.parse({}),
    runner: {
      endpoint: process.env.CONSOL_ENDPOINT || process.env.MEMORY_ENDPOINT,
      apiKeyEnv: (process.env.CONSOL_API_KEY || process.env.MEMORY_API_KEY) ? (process.env.CONSOL_API_KEY ? "CONSOL_API_KEY" : "MEMORY_API_KEY") : undefined,
      model: process.env.CONSOL_MODEL || process.env.MEMORY_MODEL,
    },
  };
  return VaultConfig.parse(raw);
}

export function defaultModelCache(): string {
  if (process.env.CONSOL_CACHE_DIR) return path.resolve(process.env.CONSOL_CACHE_DIR);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return path.join(local, "consol", "models");
  } else if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "consol", "models");
  } else {
    const xdg = process.env.XDG_CACHE_HOME;
    if (xdg) return path.join(xdg, "consol", "models");
  }
  return path.join(os.homedir(), ".cache", "consol", "models");
}

export function agentRoot(vault: string, agent: string) {
  return path.join(vault, "agents", agent);
}

export function teamRoot(vault: string, team: string) {
  return path.join(vault, "teams", team);
}

// Sparse globally. Clustered locally. Local clusters interconnected globally.
// Surface schema version bumps fingerprint so disposable SQLite rebuilds without touching canonical Markdown.
export const SURFACE_SCHEMA_VERSION = "v1" as const;
export const SURFACE_DERIVATION_VERSION = "v1" as const;

// Fingerprint changes force SQLite index drop and rebuild without touching canonical files.
export function indexFingerprint() {
  return `${MODEL_ID}@${MODEL_REVISION}:${MODEL_DTYPE}:mean:l2:${EMBED_DIMS}:chunk-v4-sourcerefs-numeric-ledger-v1:surfaces-${SURFACE_SCHEMA_VERSION}-${SURFACE_DERIVATION_VERSION}`;
}
