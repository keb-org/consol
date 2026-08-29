import path from "node:path";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
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
  const backup = `${tmp}.bak`;
  if (typeof content === "string") await writeFile(tmp, content, "utf8");
  else await writeFile(tmp, content);
  try {
    await rename(tmp, filePath);
  } catch (firstError) {
    if (!existsSync(filePath)) {
      await unlink(tmp).catch(() => {});
      throw firstError;
    }
    // Windows cannot always replace an existing file. Preserve a byte-for-byte backup before removing it.
    await copyFile(filePath, backup);
    try {
      await unlink(filePath);
      try {
        await rename(tmp, filePath);
      } catch (replaceError) {
        try {
          await rename(backup, filePath);
        } catch (restoreError) {
          throw new AggregateError([replaceError, restoreError], `atomic replacement and restore failed: ${filePath}`);
        }
        throw replaceError;
      }
      await unlink(backup).catch(() => {});
    } catch (error) {
      await unlink(tmp).catch(() => {});
      await unlink(backup).catch(() => {});
      throw error;
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

export function chunkMarkdown(text: string, maxChars = 1800, overlapChars = 180) {
  const { body } = parseFrontmatter(text);
  const sections = body.split(/^##\s+/m);
  const chunks: { section: string; text: string }[] = [];
  const MAX_CHUNKS = 128;
  const step = Math.max(1, maxChars - Math.min(overlapChars, Math.floor(maxChars / 2)));
  for (const sec of sections) {
    if (chunks.length >= MAX_CHUNKS) break;
    const content = sec.trim();
    if (!content) continue;
    const title = content.split("\n", 1)[0].slice(0, 80);
    if (content.length <= maxChars) {
      chunks.push({ section: title, text: content });
      continue;
    }
    for (let start = 0, part = 0; start < content.length && chunks.length < MAX_CHUNKS; start += step, part++) {
      chunks.push({ section: `${title}#${part}`, text: content.slice(start, start + maxChars) });
    }
    if (chunks.length >= MAX_CHUNKS && content.length > maxChars) {
      const tail = content.slice(Math.max(0, content.length - maxChars));
      const last = chunks[chunks.length - 1];
      if (last && last.text !== tail) last.text = tail;
    }
  }
  return chunks.slice(0, MAX_CHUNKS);
}
