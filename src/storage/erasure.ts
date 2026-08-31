import path from "node:path";
import { readFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { atomicWrite, hashContent, parseFrontmatter, stableId, withVaultLock } from "./vault";
import { removeIndexedPath, syncVault } from "./index/sync";

export type ForgetPlan = {
  targetHash: string;
  token: string;
  candidates: string[];
  createdAt: string;
};

export type DerivativeMutation =
  | { action: "rewrite"; file: string; previous: string; next: string }
  | { action: "delete"; file: string; previous: string | Uint8Array };

export type ErasedRefs = {
  docIds: Set<string>;
  evidenceIds: Set<string>;
  opaqueRefs: Set<string>;
  packetIds: Set<string>;
  revisionIds: Set<string>;
  snapshotHashes: Set<string>;
  blobHashes: Set<string>;
};

export type ErasureReceipt = {
  id: string;
  at: string;
  agent: string;
  targetHash: string;
  erased: number;
  derivatives: number;
};

function collectErasedRefs(target: string, candidates: string[], texts: Map<string, string>): ErasedRefs {
  const refs: ErasedRefs = {
    docIds: new Set([target]),
    evidenceIds: new Set(),
    opaqueRefs: new Set(),
    packetIds: new Set(),
    revisionIds: new Set(),
    snapshotHashes: new Set(),
    blobHashes: new Set(),
  };
  for (const file of candidates) {
    const text = texts.get(file) ?? "";
    if (file.endsWith(".md")) {
      const { meta } = parseFrontmatter(text);
      if (meta.id) refs.docIds.add(meta.id);
    }
  }
  for (const [file, text] of texts) {
    const ext = path.extname(file).toLowerCase();
    const values: unknown[] = [];
    if (ext === ".jsonl") {
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { values.push(JSON.parse(line)); } catch {}
      }
    } else if (ext === ".json") {
      try { values.push(JSON.parse(text)); } catch {}
    }
    for (const value of values) collectRefsFromValue(value, refs);
  }
  return refs;
}

function blobHash(value: string) {
  const match = /^(?:sha256:)?([a-f0-9]{64})(?:\.[a-z0-9._-]+)?$/i.exec(value.trim());
  return match?.[1].toLowerCase();
}

const BLOB_KEYS = /^(?:blob|blobHash|blobHashes|blobs|attachment|attachments)$/i;

function collectBlobHashes(value: unknown, hashes: Set<string>, matched = false) {
  if (typeof value === "string") {
    if (matched) {
      const hash = blobHash(value);
      if (hash) hashes.add(hash);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectBlobHashes(item, hashes, matched));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectBlobHashes(child, hashes, matched || BLOB_KEYS.test(key));
  }
}

function collectRefsFromValue(value: unknown, refs: ErasedRefs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const strings = (key: string) => Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const matchesDoc = typeof record.docId === "string" && refs.docIds.has(record.docId);
  const matchesTarget = typeof record.targetId === "string" && refs.docIds.has(record.targetId);
  const matchesEvidence = typeof record.evidenceId === "string" && refs.evidenceIds.has(record.evidenceId);
  const matchesRefs = [...strings("refs"), ...strings("sourceRefs"), ...strings("appliedRefs")]
    .some((ref) => erasedString(ref, refs));
  const matchesItem = Array.isArray(record.items) && record.items.some((item) =>
    item && typeof item === "object" && (
      refs.docIds.has((item as Record<string, unknown>).docId as string) ||
      refs.opaqueRefs.has((item as Record<string, unknown>).ref as string)
    )
  );
  const matchesPacketEvidence = record.packet && typeof record.packet === "object" &&
    Array.isArray((record.packet as Record<string, unknown>).evidence) &&
    ((record.packet as Record<string, unknown>).evidence as unknown[]).some((item) =>
      item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" &&
      refs.evidenceIds.has((item as Record<string, unknown>).id as string)
    );
  const matchesPacket = typeof record.packetId === "string" && refs.packetIds.has(record.packetId);
  const matched = matchesDoc || matchesTarget || matchesEvidence || matchesRefs || matchesItem ||
    matchesPacketEvidence || matchesPacket;
  if (matched) {
    collectBlobHashes(record, refs.blobHashes);
    if (typeof record.id === "string" && record.id.startsWith("ev-")) refs.evidenceIds.add(record.id);
    if (typeof record.id === "string" && record.id.startsWith("rev-")) refs.revisionIds.add(record.id);
    if (typeof record.packetId === "string") refs.packetIds.add(record.packetId);
    if (typeof record.beforeHash === "string" && /^[a-f0-9]{64}$/.test(record.beforeHash)) {
      refs.snapshotHashes.add(record.beforeHash);
    }
    if (typeof record.afterHash === "string" && /^[a-f0-9]{64}$/.test(record.afterHash)) {
      refs.snapshotHashes.add(record.afterHash);
    }
  }
  if (matchesDoc && typeof record.ref === "string") refs.opaqueRefs.add(record.ref);
  if (matchesItem && typeof record.packetId === "string") refs.packetIds.add(record.packetId);
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach((item) => collectRefsFromValue(item, refs));
    else collectRefsFromValue(child, refs);
  }
}

function erasedString(value: string, refs: ErasedRefs) {
  return refs.docIds.has(value) ||
    refs.evidenceIds.has(value) ||
    refs.opaqueRefs.has(value) ||
    refs.packetIds.has(value) ||
    refs.revisionIds.has(value);
}

function objectErased(record: Record<string, unknown>, refs: ErasedRefs) {
  return (typeof record.id === "string" && (refs.evidenceIds.has(record.id) || refs.revisionIds.has(record.id))) ||
    (typeof record.evidenceId === "string" && refs.evidenceIds.has(record.evidenceId)) ||
    (typeof record.targetId === "string" && refs.docIds.has(record.targetId)) ||
    (typeof record.docId === "string" && refs.docIds.has(record.docId)) ||
    (typeof record.ref === "string" && refs.opaqueRefs.has(record.ref)) ||
    (typeof record.packetId === "string" && refs.packetIds.has(record.packetId));
}

function containsErasedValue(value: unknown, target: string, refs: ErasedRefs): boolean {
  if (typeof value === "string") return erasedString(value, refs) || value.includes(target);
  if (Array.isArray(value)) return value.some((item) => containsErasedValue(item, target, refs));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return objectErased(record, refs) || Object.values(record).some((child) => containsErasedValue(child, target, refs));
}

function scrubValue(
  value: unknown,
  target: string,
  refs: ErasedRefs,
  key = "",
  scrubBlobs = false,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (erasedString(value, refs)) return { value: "[ERASED]", changed: true };
    if (!value.includes(target)) return { value, changed: false };
    return { value: value.split(target).join("[ERASED]"), changed: true };
  }
  if (Array.isArray(value)) {
    const dropRefs = ["refs", "sourceRefs", "appliedRefs", "items", "candidates"].includes(key);
    const dropBlobs = BLOB_KEYS.test(key);
    let changed = false;
    const next: unknown[] = [];
    for (const item of value) {
      if (
        (dropRefs && (typeof item === "string" ? erasedString(item, refs) : item && typeof item === "object" && objectErased(item as Record<string, unknown>, refs))) ||
        (scrubBlobs && dropBlobs && typeof item === "string" && refs.blobHashes.has(blobHash(item) ?? ""))
      ) {
        changed = true;
        continue;
      }
      const scrubbed = scrubValue(item, target, refs, "", scrubBlobs);
      changed ||= scrubbed.changed;
      next.push(scrubbed.value);
    }
    return { value: next, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (
      scrubBlobs &&
      BLOB_KEYS.test(childKey) &&
      typeof child === "string" &&
      refs.blobHashes.has(blobHash(child) ?? "")
    ) {
      changed = true;
      continue;
    }
    const scrubbed = scrubValue(child, target, refs, childKey, scrubBlobs);
    changed ||= scrubbed.changed;
    next[childKey] = scrubbed.value;
  }
  return { value: next, changed };
}

function scrubJsonl(text: string, target: string, refs: ErasedRefs) {
  const lines: string[] = [];
  let changed = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const erased = objectErased(parsed, refs);
      if (erased) {
        changed = true;
        continue;
      }
      const scrubbed = scrubValue(parsed, target, refs, "", containsErasedValue(parsed, target, refs));
      changed ||= scrubbed.changed;
      lines.push(JSON.stringify(scrubbed.value));
    } catch {
      if (line.includes(target)) changed = true;
      else lines.push(line);
    }
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "", changed };
}

async function filesUnder(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function refCount(refs: ErasedRefs) {
  return refs.evidenceIds.size + refs.opaqueRefs.size + refs.packetIds.size +
    refs.revisionIds.size + refs.snapshotHashes.size + refs.blobHashes.size;
}

export async function derivativeMutations(
  agentRoot: string,
  target: string,
  candidates: string[],
  excluded: ReadonlySet<string>,
): Promise<DerivativeMutation[]> {
  const roots = [
    "memories",
    "cases",
    "experiences",
    "skills",
    "core",
    "evidence",
    "audit",
    "jobs",
    "blobs",
    "messages",
  ];
  const files = (await Promise.all(roots.map((root) => filesUnder(path.join(agentRoot, root))))).flat();
  const blobRoot = path.resolve(agentRoot, "blobs");
  const textFiles = files.filter((file) => {
    const resolved = path.resolve(file);
    return resolved !== blobRoot && !resolved.startsWith(`${blobRoot}${path.sep}`);
  });
  const texts = new Map<string, string>();
  for (const file of [...new Set([...textFiles, ...candidates])]) {
    texts.set(file, await readFile(file, "utf8").catch(() => ""));
  }
  const refs = collectErasedRefs(target, candidates, texts);
  while (true) {
    const before = refCount(refs);
    for (const file of textFiles) {
      const text = texts.get(file) ?? "";
      const ext = path.extname(file).toLowerCase();
      const values: unknown[] = [];
      if (ext === ".jsonl") {
        for (const line of text.split("\n")) {
          if (!line) continue;
          try { values.push(JSON.parse(line)); } catch {}
        }
      } else if (ext === ".json") {
        try { values.push(JSON.parse(text)); } catch {}
      }
      values.forEach((value) => collectRefsFromValue(value, refs));
    }
    if (refCount(refs) === before) break;
  }

  const mutations: DerivativeMutation[] = [];
  for (const file of textFiles) {
    if (excluded.has(path.resolve(file))) continue;
    const text = texts.get(file) ?? "";
    const ext = path.extname(file).toLowerCase();
    if (
      path.basename(path.dirname(file)) === "snapshots" &&
      refs.snapshotHashes.has(path.basename(file, ext))
    ) {
      mutations.push({ action: "delete", file, previous: text });
    } else if (ext === ".jsonl") {
      const scrubbed = scrubJsonl(text, target, refs);
      if (scrubbed.changed) mutations.push({ action: "rewrite", file, previous: text, next: scrubbed.text });
    } else if (ext === ".json") {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (
          objectErased(parsed, refs) ||
          (path.basename(path.dirname(file)) === "jobs" && containsErasedValue(parsed, target, refs))
        ) mutations.push({ action: "delete", file, previous: text });
        else {
          const scrubbed = scrubValue(
            parsed,
            target,
            refs,
            "",
            containsErasedValue(parsed, target, refs),
          );
          if (scrubbed.changed) {
            mutations.push({ action: "rewrite", file, previous: text, next: `${JSON.stringify(scrubbed.value, null, 2)}\n` });
          }
        }
      } catch {
        if (text.includes(target)) {
          mutations.push({ action: "rewrite", file, previous: text, next: text.split(target).join("[ERASED]") });
        }
      }
    } else if (text.includes(target)) {
      mutations.push({ action: "rewrite", file, previous: text, next: text.split(target).join("[ERASED]") });
    }
  }

  const retainedSnapshotHashes = new Set<string>();
  for (const file of textFiles) {
    if (excluded.has(path.resolve(file))) continue;
    const mutation = mutations.find((entry) => path.resolve(entry.file) === path.resolve(file));
    if (mutation?.action === "delete") continue;
    const text = mutation?.action === "rewrite" ? mutation.next : texts.get(file) ?? "";
    const ext = path.extname(file).toLowerCase();
    const values: unknown[] = [];
    if (ext === ".jsonl") {
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { values.push(JSON.parse(line)); } catch {}
      }
    } else if (ext === ".json") {
      try { values.push(JSON.parse(text)); } catch {}
    }
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      for (const hash of [record.beforeHash, record.afterHash]) {
        if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) retainedSnapshotHashes.add(hash);
      }
    }
  }
  for (let i = mutations.length - 1; i >= 0; i--) {
    const mutation = mutations[i];
    const ext = path.extname(mutation.file).toLowerCase();
    if (
      mutation.action === "delete" &&
      path.basename(path.dirname(mutation.file)) === "snapshots" &&
      retainedSnapshotHashes.has(path.basename(mutation.file, ext))
    ) {
      mutations.splice(i, 1);
    }
  }

  const changedFiles = new Set(mutations.map((mutation) => path.resolve(mutation.file)));
  const retainedBlobHashes = new Set<string>();
  for (const file of textFiles) {
    if (excluded.has(path.resolve(file))) continue;
    const mutation = mutations.find((entry) => path.resolve(entry.file) === path.resolve(file));
    if (mutation?.action === "delete") continue;
    const text = mutation?.action === "rewrite" ? mutation.next : texts.get(file) ?? "";
    const ext = path.extname(file).toLowerCase();
    if (ext === ".jsonl") {
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { collectBlobHashes(JSON.parse(line), retainedBlobHashes); } catch {}
      }
    } else if (ext === ".json") {
      try { collectBlobHashes(JSON.parse(text), retainedBlobHashes); } catch {}
    }
  }
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(`${blobRoot}${path.sep}`) || changedFiles.has(resolved)) continue;
    const hash = blobHash(path.basename(file));
    if (!hash || !refs.blobHashes.has(hash) || retainedBlobHashes.has(hash)) continue;
    mutations.push({ action: "delete", file, previous: await readFile(file) });
  }
  return mutations;
}

export async function forgetPlan(vault: string, agentRoot: string, target: string) {
  if (!target?.trim()) throw new Error("empty target — category: type error (forget target must be a non-empty docId or search string). Fix: pass a non-empty target string identifying the memory to forget");
  const candidates: string[] = [];
  const dirs = ["memories", "cases", "experiences", "skills", "core"];
  for (const d of dirs) {
    const dir = path.join(agentRoot, d);
    if (!existsSync(dir)) continue;
    for (const e of await readdir(dir).catch(() => [])) {
      const file = path.join(dir, e);
      if (e.includes(target) || target === e.replace(/\.md$/, "")) candidates.push(file);
      if (e.endsWith(".md")) {
        const text = await readFile(file, "utf8").catch(() => "");
        if (text.toLowerCase().includes(target.toLowerCase())) candidates.push(file);
      }
    }
  }
  const token = hashContent(`${target}:${Date.now()}:${Math.random()}`).slice(0, 16);
  const planPath = path.join(agentRoot, "jobs", `forget-${token}.json`);
  const plan: ForgetPlan = {
    targetHash: hashContent(target),
    token,
    candidates: [...new Set(candidates)],
    createdAt: new Date().toISOString(),
  };
  await atomicWrite(planPath, JSON.stringify(plan, null, 2));
  return { token, candidates: plan.candidates, requiresConfirmation: true };
}

export async function forgetConfirm(vault: string, agentRoot: string, agent: string, target: string, confirmation: string, db?: Database) {
  const planPath = path.join(agentRoot, "jobs", `forget-${confirmation}.json`);
  if (!existsSync(planPath)) throw new Error("unknown confirmation token — category: stale or type error (no forget plan file for this confirmation; token may be typo, expired, or from different agent). Fix: run forget without confirmation first to get a fresh token, then confirm with the same target string");
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Partial<ForgetPlan> & { target?: string };
  const targetMatchesPlan = plan.targetHash
    ? plan.targetHash === hashContent(target)
    : plan.target === target;
  if (!targetMatchesPlan) throw new Error("target mismatch — category: type error (confirmation token was issued for a different target string). Fix: call forgetConfirm with the exact same target you used in forgetPlan; do not change target between plan and confirm");
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const aRootReal = path.resolve(agentRoot);
  const allowedDirs = new Set(["memories", "cases", "experiences", "skills", "core"]);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const rel = path.relative(aRootReal, resolved);
    const segments = rel.split(path.sep);
    if (
      resolved === aRootReal ||
      rel.startsWith("..") ||
      path.isAbsolute(rel) ||
      segments.length !== 2 ||
      !allowedDirs.has(segments[0]) ||
      !segments[1].endsWith(".md")
    ) {
      throw new Error("forget candidate escapes agent root or canonical note roots — category: unauthorized (path escapes allowed canonical note roots). Fix: pass target as a docId or substring that resolves within <agentRoot>/{memories|cases|experiences|skills|core}/*.md; do not use path traversal or absolute paths");
    }
  }
  const candidateSet = new Set(candidates.map((candidate) => path.resolve(candidate)));
  const mutations = await derivativeMutations(
    agentRoot,
    target,
    candidates,
    new Set([...candidateSet, path.resolve(planPath)]),
  );
  const appliedMutations: DerivativeMutation[] = [];
  const backups = new Map<string, string>();
  const receipt: ErasureReceipt = {
    id: stableId("erase-"),
    at: new Date().toISOString(),
    agent,
    targetHash: plan.targetHash ?? hashContent(target),
    erased: candidates.length,
    derivatives: mutations.length,
  };
  const receiptFile = path.join(agentRoot, "audit", "erasures.jsonl");
  const previousReceipts = await readFile(receiptFile, "utf8").catch(() => "");

  await withVaultLock(vault, async () => {
    try {
      for (const mutation of mutations) {
        if (mutation.action === "delete") await unlink(mutation.file);
        else await atomicWrite(mutation.file, mutation.next);
        appliedMutations.push(mutation);
      }
      for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        backups.set(candidate, await readFile(candidate, "utf8"));
        await unlink(candidate);
      }
      await atomicWrite(receiptFile, `${previousReceipts}${JSON.stringify(receipt)}\n`);
      await unlink(planPath);
    } catch (error) {
      for (const [file, content] of backups) await atomicWrite(file, content).catch(() => {});
      for (const mutation of appliedMutations.reverse()) await atomicWrite(mutation.file, mutation.previous).catch(() => {});
      await atomicWrite(receiptFile, previousReceipts).catch(() => {});
      throw error;
    }
  });

  let indexError: string | undefined;
  if (db) {
    try {
      db.exec("SAVEPOINT forget_index");
      for (const candidate of candidates) {
        const rel = path.relative(aRootReal, path.resolve(candidate)).split(path.sep).join("/");
        removeIndexedPath(db, rel);
      }
      if (mutations.some((mutation) => mutation.file.endsWith(".md"))) {
        await syncVault(db, vault, agentRoot, agent);
      }
      db.exec("RELEASE SAVEPOINT forget_index");
    } catch {
      try { db.exec("ROLLBACK TO SAVEPOINT forget_index; RELEASE SAVEPOINT forget_index"); } catch {}
      indexError = "canonical erasure committed; index sync failed, run reindex";
    }
  }
  return {
    erased: candidates.length,
    derivatives: mutations.length,
    receipt: receipt.id,
    ...(indexError ? { indexError } : {}),
  };
}
