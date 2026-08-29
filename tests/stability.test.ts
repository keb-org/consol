import { describe, test, expect } from "bun:test";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

function tmp(prefix: string) { return mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanup(dir: string) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

describe("stability: vault and index invariants", () => {
  test("reindex is deterministic", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault, rebuild } = await import("../src/index");
    const vault = tmp("stability-reindex-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "mem-a.md"), "---\nid: mem-a\nkind: memory\n---\nThe deploy pipeline uses blue-green with health checks\n");
    await atomicWrite(path.join(aRoot, "memories", "mem-b.md"), "---\nid: mem-b\nkind: memory\n---\nPrefers Bun over Node for local tooling\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const before = (db.query("SELECT count(*) as n FROM chunks").get() as any).n;
    expect(before).toBeGreaterThan(0);
    const beforeFiles = (db.query("SELECT count(*) as n FROM files").get() as any).n;
    await rebuild(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) as n FROM chunks").get() as any).n).toBe(before);
    expect((db.query("SELECT count(*) as n FROM files").get() as any).n).toBe(beforeFiles);
    db.close(); cleanup(vault);
  }, 15000);

  test("crash around atomic commit: index tracks committed hash", async () => {
    const { ensureVault, atomicWrite, hashContent } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-atomic-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const db = openIndex(aRoot);
    const p = path.join(aRoot, "memories", "mem-atomic.md");
    await atomicWrite(p, "---\nid: mem-atomic\nkind: memory\n---\nAtomic content v1\n");
    await syncVault(db, vault, aRoot, "alice");
    const h1 = hashContent(await readFile(p, "utf8"));
    await atomicWrite(p, "---\nid: mem-atomic\nkind: memory\n---\nAtomic content v2 with more detail\n");
    await syncVault(db, vault, aRoot, "alice");
    const h2 = hashContent(await readFile(p, "utf8"));
    expect(h2).not.toBe(h1);
    const all = db.query("SELECT path, hash FROM files").all() as any[];
    const row = all.find((r) => String(r.path).includes("mem-atomic"));
    expect(row).toBeDefined();
    expect((row as any).hash).toBe(h2);
    db.close(); cleanup(vault);
  }, 15000);

  test("stale lock recovery: 30s stale cleared, active blocks", async () => {
    const { ensureVault, withVaultLock, atomicWrite } = await import("../src/vault");
    const vault = tmp("stability-lock-");
    await ensureVault(vault, "alice");
    await atomicWrite(path.join(vault, ".lock"), `${Date.now() - 40000}\n99999`);
    let ran = false;
    await withVaultLock(vault, async () => { ran = true; });
    expect(ran).toBe(true);
    await atomicWrite(path.join(vault, ".lock"), `${Date.now()}\n99999`);
    await expect(withVaultLock(vault, async () => {})).rejects.toThrow("vault locked");
    cleanup(vault);
  }, 15000);

  test("malformed external edit does not corrupt index", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const vault = tmp("stability-malformed-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "bad.md"), "---\nkind: memory\nid: bad\nbad-yaml: [unclosed\n---\nBody still here\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const rows = db.query("SELECT * FROM chunks WHERE doc_id='bad'").all() as any[];
    expect(Array.isArray(rows)).toBe(true);
    db.close(); cleanup(vault);
  }, 15000);

  test("external delete reconciles chunks/fts/vectors/files", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const vault = tmp("stability-delete-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "to-delete.md"), "---\nid: to-delete\nkind: memory\n---\nThis will be deleted externally\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id='to-delete'").get() as any).n).toBeGreaterThan(0);
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(aRoot, "memories", "to-delete.md"));
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id='to-delete'").get() as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM files WHERE path='memories/to-delete.md'").get() as any).n).toBe(0);
    db.close(); cleanup(vault);
  }, 15000);
});

describe("stability: retrieval under real budgets", () => {
  test("exact ID navigation wins", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-exact-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-exact-123";
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), `---\nid: ${id}\nkind: memory\n---\nExact doc for navigation\n`);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const pkt = await recall(db, vault, id, Budgets.parse({}));
    expect(pkt.items[0].docId).toBe(id);
    expect(pkt.items[0].rrf).toBe(1);
    db.close(); cleanup(vault);
  }, 15000);

  test("typed quotas prevent starvation", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-quota-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    for (let i = 0; i < 6; i++) {
      await atomicWrite(path.join(aRoot, "memories", `mem-q-${i}.md`), `---\nid: mem-q-${i}\nkind: memory\n---\nMemory about deployment region ${i}\n`);
    }
    for (let i = 0; i < 6; i++) {
      await atomicWrite(path.join(aRoot, "experiences", `exp-q-${i}.md`), `---\nid: exp-q-${i}\nkind: experience\n---\nExperience about deployment region ${i}\n`);
    }
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const budgets = Budgets.parse({ quotas: { memory: 2, experience: 2, case: 1, skill: 1, inbox: 1 } });
    const pkt = await recall(db, vault, "deployment region", budgets);
    expect(pkt.items.filter((x) => x.kind === "memory").length).toBeLessThanOrEqual(2);
    expect(pkt.items.filter((x) => x.kind === "experience").length).toBeLessThanOrEqual(2);
    db.close(); cleanup(vault);
  }, 15000);

  test("L2 byte ceiling holds on readChunk", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall, readChunk } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-l2-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const big = "X".repeat(8000);
    await atomicWrite(path.join(aRoot, "memories", "mem-big.md"), `---\nid: mem-big\nkind: memory\n---\n${big}\n`);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const pkt = await recall(db, vault, "mem-big", Budgets.parse({}));
    expect(pkt.items.length).toBeGreaterThan(0);
    const chunk = readChunk(db, pkt.items[0].ref, Budgets.parse({ l2Bytes: 4096 }));
    expect(chunk.text.length).toBeLessThanOrEqual(4096);
    db.close(); cleanup(vault);
  }, 15000);

  test("stale ref rejected after content changes (old chunk gone)", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall, readChunk } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-stale-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-stale";
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), `---\nid: ${id}\nkind: memory\n---\nVersion one\n`);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const pkt = await recall(db, vault, id, Budgets.parse({}));
    const ref = pkt.items[0].ref;
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), `---\nid: ${id}\nkind: memory\n---\nVersion two completely different\n`);
    await syncVault(db, vault, aRoot, "alice");
    expect(() => readChunk(db, ref, Budgets.parse({}))).toThrow();
    db.close(); cleanup(vault);
  }, 15000);

  test("per-arm cap prevents crowding", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-cap-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    for (let i = 0; i < 8; i++) {
      await atomicWrite(path.join(aRoot, "memories", `mem-cap-${i}.md`), `---\nid: mem-cap-${i}\nkind: memory\n---\nKeyword deployment ${i}\n`);
    }
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const budgets = Budgets.parse({ perArmCap: 2, quotas: { memory: 10, experience: 10, case: 10, skill: 10, inbox: 10 } });
    const pkt = await recall(db, vault, "deployment", budgets);
    expect(pkt.attribution.lexCapped).toBeLessThanOrEqual(2);
    db.close(); cleanup(vault);
  }, 15000);
});

describe("stability: isolation and provenance", () => {
  test("cross-bank recall does not leak private content", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-cross-");
    await ensureVault(vault, "alice");
    await ensureVault(vault, "bob");
    const bRoot = path.join(vault, "agents", "bob");
    await atomicWrite(path.join(bRoot, "memories", "mem-bob-secret.md"), "---\nid: mem-bob-secret\nkind: memory\n---\nBob secret token should not leak\n");
    const dbBob = openIndex(bRoot);
    await syncVault(dbBob, vault, bRoot, "bob");
    dbBob.close();
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "mem-alice.md"), "---\nid: mem-alice\nkind: memory\n---\nAlice public note\n");
    const dbAlice = openIndex(aRoot);
    await syncVault(dbAlice, vault, aRoot, "alice");
    const pkt = await recall(dbAlice, vault, "secret token", Budgets.parse({}), "agent:alice");
    expect(pkt.items.every((x) => x.docId !== "mem-bob-secret")).toBe(true);
    dbAlice.close(); cleanup(vault);
  }, 15000);

  test("forged ref with wrong owner rejected", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall, readChunk, decodeRef } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-forged-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "mem-forge.md"), "---\nid: mem-forge\nkind: memory\n---\nForge target\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const pkt = await recall(db, vault, "mem-forge", Budgets.parse({}));
    const decoded = decodeRef(pkt.items[0].ref);
    const forged = Buffer.from(JSON.stringify({ ...decoded, o: "agent:bob" })).toString("base64url");
    expect(() => readChunk(db, forged, Budgets.parse({}))).toThrow("owner mismatch");
    db.close(); cleanup(vault);
  }, 15000);

  test("secret rejected on remember and reflection", async () => {
    const { ensureVault } = await import("../src/vault");
    const vault = tmp("stability-secret-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const { remember } = await import("../src/memory");
    await expect(remember(vault, aRoot, "alice", { statement: "key is sk-123456789012345678901234567890" })).rejects.toThrow();
    const { validateProposal } = await import("../src/reflection");
    expect(validateProposal({ id: "p1", action: "create", rationale: "r", sourceRefs: ["s1"], after: "contains sk-123456789012345678901234567890" } as any, vault).ok).toBe(false);
    cleanup(vault);
  }, 15000);
});

describe("stability: forgetting and lifecycle", () => {
  test("forget is two-phase and cascading", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { forgetPlan, forgetConfirm } = await import("../src/memory");
    const vault = tmp("stability-forget-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-forget-me";
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), `---\nid: ${id}\nkind: memory\n---\nForget this content\n`);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id=?").get(id) as any).n).toBeGreaterThan(0);
    const plan = await forgetPlan(vault, aRoot, id);
    expect(plan.requiresConfirmation).toBe(true);
    const res = await forgetConfirm(vault, aRoot, "alice", id, plan.token, db);
    expect(res.erased).toBeGreaterThanOrEqual(1);
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id=?").get(id) as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM files WHERE path LIKE ?").get(`%${id}%`) as any).n).toBe(0);
    db.close(); cleanup(vault);
  }, 15000);

  test("forget candidate cannot escape agent root", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { forgetPlan, forgetConfirm } = await import("../src/memory");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-escape-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const plan = await forgetPlan(vault, aRoot, "mem-escape");
    const evil = path.join(vault, "agents", "bob", "memories", "evil.md");
    const raw = JSON.parse(await readFile(path.join(aRoot, "jobs", `forget-${plan.token}.json`), "utf8"));
    raw.candidates = [evil];
    await atomicWrite(path.join(aRoot, "jobs", `forget-${plan.token}.json`), JSON.stringify(raw));
    await expect(forgetConfirm(vault, aRoot, "alice", "mem-escape", plan.token)).rejects.toThrow("escapes agent root");
    cleanup(vault);
  }, 15000);

  test("proposal requires sources/rationale, rejects self-citation and stale base", async () => {
    const { validateProposal } = await import("../src/reflection");
    const { hashContent } = await import("../src/vault");
    const vault = tmp("stability-proposal-");
    expect(validateProposal({ id: "p1", action: "create", rationale: "r", sourceRefs: [], after: "x" } as any, vault).ok).toBe(false);
    expect(validateProposal({ id: "p2", action: "create", rationale: "", sourceRefs: ["s1"], after: "x" } as any, vault).ok).toBe(false);
    expect(validateProposal({ id: "p3", action: "forget", rationale: "r", sourceRefs: ["s1"] } as any, vault).ok).toBe(false);
    expect(validateProposal({ id: "p4", action: "create", rationale: "x", sourceRefs: ["s1"], targetId: "s1", after: "x" } as any, vault).ok).toBe(false);
    const before = "original";
    expect(validateProposal({ id: "p5", action: "update", rationale: "r", sourceRefs: ["s1"], before, baseHash: "bad", after: "new" } as any, vault).ok).toBe(false);
    expect(validateProposal({ id: "p6", action: "update", rationale: "r", sourceRefs: ["s1"], before, baseHash: hashContent(before), after: "new" } as any, vault).ok).toBe(true);
    cleanup(vault);
  }, 15000);

  test("stageProposals enforces baseHash", async () => {
    const { ensureVault, atomicWrite, hashContent } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { stageProposals } = await import("../src/reflection");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-stage-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-stage-bh";
    const original = `---\nid: ${id}\nkind: memory\nstatus: candidate\n---\nOriginal\n`;
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), original);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const jobId = "job-test-123";
    await atomicWrite(path.join(aRoot, "jobs", `${jobId}.json`), JSON.stringify({ id: jobId, createdAt: new Date().toISOString(), status: "pending", packet: { query: "", items: [] } }));
    await stageProposals(vault, aRoot, jobId, [{ id: "p1", action: "update", targetId: id, before: original, baseHash: "stalehash", after: "New", sourceRefs: ["s1"], rationale: "r" } as any], db);
    expect((await readFile(path.join(aRoot, "memories", `${id}.md`), "utf8")).includes("Original")).toBe(true);
    await stageProposals(vault, aRoot, jobId, [{ id: "p2", action: "update", targetId: id, before: original, baseHash: hashContent(original), after: "Updated", sourceRefs: ["s1"], rationale: "r" } as any], db);
    expect((await readFile(path.join(aRoot, "memories", `${id}.md`), "utf8")).includes("Updated")).toBe(true);
    db.close(); cleanup(vault);
  }, 15000);
});

describe("stability: MCP behavior and budgets", () => {
  test("recall packet stays bounded as history grows", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-bounded-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    for (let i = 0; i < 20; i++) {
      await atomicWrite(path.join(aRoot, "memories", `mem-b-${i}.md`), `---\nid: mem-b-${i}\nkind: memory\n---\nNote ${i} about deployment pipeline ${"detail ".repeat(30)}\n`);
    }
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const pkt = await recall(db, vault, "deployment pipeline", Budgets.parse({}));
    expect(pkt.items.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(pkt).length).toBeLessThan(30000);
    db.close(); cleanup(vault);
  }, 15000);

  test("concurrent record appends do not corrupt evidence", async () => {
    const { ensureVault } = await import("../src/vault");
    const vault = tmp("stability-conc-ev-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const { record } = await import("../src/memory");
    const ops = Array.from({ length: 8 }, (_, i) => record(vault, aRoot, "alice", { kind: "case", data: { idx: i } }));
    const results = await Promise.all(ops);
    expect(results.length).toBe(8);
    expect(new Set(results.map((r) => r.id)).size).toBe(8);
    cleanup(vault);
  }, 15000);
});
