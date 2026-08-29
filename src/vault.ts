import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

export type Kind = "memory" | "case" | "experience" | "skill" | "identity" | "core";

export function hashContent(text: string | Uint8Array) {
  return createHash("sha256").update(text).digest("hex");
}

export function stableId(prefix = "") {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}-${r}`;
}

// Atomic write via tmp+rename ensures indexers never read partial writes on crash.
export async function atomicWrite(filePath: string, content: string | Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (typeof content === "string") await writeFile(tmp, content, "utf8");
  else await writeFile(tmp, content as unknown as string);
  try {
    await rename(tmp, filePath);
  } catch {
    // Windows fallback if destination is briefly locked
    try { await unlink(filePath); } catch {}
    try { await rename(tmp, filePath); } catch {
      if (typeof content === "string") await writeFile(filePath, content, "utf8");
      else await writeFile(filePath, content as unknown as string);
      try { await unlink(tmp); } catch {}
    }
  }
}

export async function appendJsonl(filePath: string, obj: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(obj) + "\n";
  const { appendFile } = await import("node:fs/promises");
  try { await appendFile(filePath, line, "utf8"); } catch { await atomicWrite(filePath, line); }
}

export function frontmatter(kind: Kind, id: string, extra: Record<string, string> = {}) {
  const lines = ["---", `id: ${id}`, `kind: ${kind}`];
  for (const [k, v] of Object.entries(extra)) if (v) lines.push(`${k}: ${v}`);
  lines.push("---", "");
  return lines.join("\n");
}

export function parseFrontmatter(text: string) {
  if (!text.startsWith("---")) return { meta: {} as Record<string, string>, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {} as Record<string, string>, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body };
}

export function evidencePath(agentRoot: string, at = new Date()) {
  const y = String(at.getUTCFullYear());
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return path.join(agentRoot, "evidence", y, `${m}.jsonl`);
}

export function notePath(agentRoot: string, kind: Kind, id: string) {
  const dir =
    kind === "memory" ? "memories" :
    kind === "case" ? "cases" :
    kind === "experience" ? "experiences" :
    kind === "skill" ? "skills" : "core";
  return path.join(agentRoot, dir, `${id}.md`);
}

export async function ensureVault(vault: string, agent: string) {
  const aRoot = path.join(vault, "agents", agent);
  const dirs = [
    path.join(vault, "models"),
    path.join(aRoot, "core"),
    path.join(aRoot, "memories"),
    path.join(aRoot, "cases"),
    path.join(aRoot, "experiences"),
    path.join(aRoot, "skills"),
    path.join(aRoot, "evidence"),
    path.join(aRoot, "jobs"),
    path.join(aRoot, "messages"),
    path.join(aRoot, "blobs"),
    path.join(aRoot, "audit"),
  ];
  for (const d of dirs) await mkdir(d, { recursive: true });
  const vJson = path.join(vault, "vault.json");
  if (!existsSync(vJson)) {
    await atomicWrite(vJson, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }, null, 2));
  }
  const aJson = path.join(aRoot, "agent.json");
  if (!existsSync(aJson)) {
    await atomicWrite(aJson, JSON.stringify({ id: agent, createdAt: new Date().toISOString() }, null, 2));
  }
  return { vault, agentRoot: aRoot };
}

export async function withVaultLock<T>(vault: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(vault, ".lock");
  const start = Date.now();
  while (true) {
    try {
      await writeFile(lock, `${Date.now()}\n${process.pid}`, { flag: "wx" });
      break;
    } catch {
      if (Date.now() - start > 5000) {
        const stat = await readFile(lock, "utf8").catch(() => "");
        const ts = Number(stat.split("\n")[0] || 0);
        if (ts && Date.now() - ts > 30000) {
          try { await unlink(lock); } catch {}
          continue;
        }
        throw new Error("vault locked");
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

export function wikiLinks(text: string) {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

export function chunkMarkdown(text: string, maxChars = 1800, maxChunks = 32) {
  const { body } = parseFrontmatter(text);
  const sections = body.split(/^##\s+/m);
  const chunks: { section: string; text: string }[] = [];
  for (const sec of sections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const title = lines[0].slice(0, 80);
    const content = trimmed;
    if (content.length <= maxChars) {
      chunks.push({ section: title, text: content });
    } else {
      for (let i = 0; i < content.length && chunks.length < maxChunks; i += maxChars) {
        chunks.push({ section: `${title}#${Math.floor(i / maxChars)}`, text: content.slice(i, i + maxChars) });
      }
    }
    if (chunks.length >= maxChunks) break;
  }
  if (chunks.length === 0 && body.trim()) chunks.push({ section: "body", text: body.trim().slice(0, maxChars) });
  return chunks.slice(0, maxChunks);
}
