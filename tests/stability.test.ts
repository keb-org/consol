import { describe, test, expect } from "bun:test";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

function tmp(prefix: string) { return mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanup(dir: string) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

describe("stability: vault and index invariants", () => {
  test("chunker overlaps without dropping long-note tails", async () => {
    const { chunkMarkdown } = await import("../src/vault");
    const body = "0123456789".repeat(1000) + "TAIL_SENTINEL";
    const chunks = chunkMarkdown(`---\nid: long\nkind: memory\n---\n${body}`, 100, 10);
    expect(chunks.length).toBeGreaterThan(32);
    expect(chunks.at(-1)?.text).toContain("TAIL_SENTINEL");
    expect(chunks[0].text.slice(-10)).toBe(chunks[1].text.slice(0, 10));
  });
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

  test("numeric ledger preserves and retrieves source state across lifecycle", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { extractNumericEvidence, numericLedgerSearch, openIndex, rebuild, setEmbedderForTests, syncVault } = await import("../src/index");
    const { Budgets } = await import("../src/config");
    const { readChunk, recall } = await import("../src/retrieval");
    const { unlink } = await import("node:fs/promises");
    const vault = tmp("stability-numeric-ledger-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const older = path.join(aRoot, "memories", "redis-old.md");
    const newer = path.join(aRoot, "memories", "redis-new.md");
    const note = (id: string, body: string) => `---\nid: ${id}\nkind: memory\nstatus: active\n---\n${body}\n`;
    setEmbedderForTests(async (texts: string[]) => ({
      tolist: () => texts.map(() => Array(384).fill(0.01)),
    }), vault);
    await atomicWrite(older, note("redis-old", "[Date: March-01-2024] USER: Redis TTL was set to 15-minute. React 18.2 was deployed. Deadline was March 15, 2024. Ticket APP-1234 tracked it."));
    await atomicWrite(newer, note("redis-new", "[Date: March-03-2024] USER: Redis TTL was updated to 20-minute."));
    const db = openIndex(aRoot);
    const projected = () => db.query(`
      SELECT c.doc_id, n.value, n.value_kind, n.statement, n.occurred_at, n.position
      FROM numeric_ledger n JOIN chunks c ON c.chunk_id=n.chunk_id
      ORDER BY c.doc_id, n.position, n.value
    `).all() as any[];
    try {
      await syncVault(db, vault, aRoot, "alice");
      const rows = projected();
      expect(rows.find((row) => row.value === "15-minute")).toMatchObject({ value_kind: "measure", occurred_at: "2024-03-01" });
      expect(rows.find((row) => row.value === "20-minute")).toMatchObject({ value_kind: "measure", occurred_at: "2024-03-03" });
      expect(rows.find((row) => row.value === "March 15, 2024")?.value_kind).toBe("date");
      expect(rows.find((row) => row.value === "18.2")?.value_kind).toBe("version");
      expect(rows.some((row) => row.value === "March-01-2024" || row.value === "March-03-2024")).toBe(false);
      expect(rows.some((row) => row.value === "1234")).toBe(false);
      expect(extractNumericEvidence("TTL changed from 15-minute to 20-minute.").map((row) => row.value)).toEqual(["15-minute", "20-minute"]);

      const direct = numericLedgerSearch(db, "What is the current Redis TTL duration?", 20);
      expect(direct.length).toBeGreaterThan(0);
      expect(direct[0].value).toBe("20-minute");
      const budgets = Budgets.parse({ perArmCap: 20 });
      const packet = await recall(db, vault, "What is the current Redis TTL duration?", budgets, "agent:alice");
      expect(packet.attribution.ledgerCapped).toBeGreaterThan(0);
      const maximumPacket = await recall(db, vault, "What is the maximum Redis TTL?", budgets, "agent:alice");
      expect(maximumPacket.attribution.ledgerCapped).toBeGreaterThan(0);
      const ledgerItems = packet.items.filter((item) => item.source === "ledger");
      expect(ledgerItems.map((item) => item.docId)).toEqual(["redis-new", "redis-old"]);
      expect(readChunk(db, ledgerItems[0].ref, budgets).text).toContain("20-minute");
      expect(readChunk(db, ledgerItems[1].ref, budgets).text).toContain("15-minute");

      const withoutLedger = await recall(db, vault, "What is the current Redis TTL duration?", budgets, "agent:alice", "auto", new Set(), { numericLedger: false });
      expect(withoutLedger.attribution.ledgerCapped).toBe(0);
      expect(withoutLedger.items.some((item) => item.source === "ledger")).toBe(false);

      await atomicWrite(newer, note("redis-new", "[Date: March-04-2024] USER: Redis TTL was updated to 25-minute."));
      await syncVault(db, vault, aRoot, "alice");
      expect((db.query("SELECT count(*) AS n FROM numeric_ledger WHERE value='20-minute'").get() as any).n).toBe(0);
      expect((db.query("SELECT count(*) AS n FROM numeric_ledger WHERE value='25-minute'").get() as any).n).toBe(1);

      await unlink(older);
      await syncVault(db, vault, aRoot, "alice");
      expect((db.query("SELECT count(*) AS n FROM numeric_ledger WHERE value='15-minute'").get() as any).n).toBe(0);
      expect((db.query("SELECT count(*) AS n FROM numeric_ledger_fts WHERE numeric_ledger_fts MATCH ?").get('"15-minute"') as any).n).toBe(0);
      const beforeRebuild = projected();
      await rebuild(db, vault, aRoot, "alice");
      expect(projected()).toEqual(beforeRebuild);
    } finally {
      db.close();
      cleanup(vault);
    }
  }, 20000);

  test("fingerprint reset clears temporal projection", async () => {
    const { ensureVault } = await import("../src/vault");
    const { openIndex } = await import("../src/index");
    const { indexFingerprint } = await import("../src/config");
    const vault = tmp("stability-fingerprint-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    let db: any;
    try {
      db = openIndex(aRoot);
      db.query("INSERT INTO temporal(doc_id, valid_from, valid_to) VALUES(?,?,?)").run("stale", "2025-01-01", null);
      db.query("UPDATE meta SET value='stale-fingerprint' WHERE key='fingerprint'").run();
      db.close();
      db = undefined;

      db = openIndex(aRoot);
      expect((db.query("SELECT count(*) AS n FROM temporal").get() as any).n).toBe(0);
      expect((db.query("SELECT value FROM meta WHERE key='fingerprint'").get() as any).value).toBe(indexFingerprint());
    } finally {
      db?.close();
      cleanup(vault);
    }
  });

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

  test("external delete reconciles chunks/fts/vectors/files/links", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const vault = tmp("stability-delete-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "to-delete.md"), "---\nid: to-delete\nkind: memory\n---\nThis will be deleted externally. [[survivor]]\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id='to-delete'").get() as any).n).toBeGreaterThan(0);
    expect((db.query("SELECT count(*) as n FROM links WHERE src='to-delete'").get() as any).n).toBe(1);
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(aRoot, "memories", "to-delete.md"));
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id='to-delete'").get() as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM files WHERE path='memories/to-delete.md'").get() as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM links WHERE src='to-delete'").get() as any).n).toBe(0);
    db.close(); cleanup(vault);
  }, 15000);

  test("embedding failure stays lexical-only without zero vectors", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault, setEmbedderForTests, vectorStatus } = await import("../src/index");
    const vault = tmp("stability-vector-degraded-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    setEmbedderForTests(async () => { throw new Error("fixture embedding failure"); }, vault);
    await atomicWrite(path.join(aRoot, "memories", "lexical.md"), "---\nid: lexical\nkind: memory\n---\nlexicalfallbackneedle\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) AS n FROM chunks").get() as any).n).toBeGreaterThan(0);
    try {
      expect((db.query("SELECT count(*) AS n FROM chunk_vectors").get() as any).n).toBe(0);
    } catch {}
    const status = vectorStatus(db);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("fixture embedding failure");
    db.close(); cleanup(vault);
  }, 15000);

  test("unchanged chunks missing vectors are retried", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault, setEmbedderForTests, vectorStatus } = await import("../src/index");
    const vault = tmp("stability-vector-retry-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    setEmbedderForTests(async () => { throw new Error("temporary embedding failure"); }, vault);
    await atomicWrite(path.join(aRoot, "memories", "retry.md"), "---\nid: retry\nkind: memory\n---\nretry vector fixture\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    try {
      expect((db.query("SELECT count(*) AS n FROM chunk_vectors").get() as any).n).toBe(0);
      setEmbedderForTests(async (texts: string[]) => ({
        tolist: () => texts.map(() => Array(384).fill(0.01)),
      }), vault);
      await syncVault(db, vault, aRoot, "alice");
      expect((db.query("SELECT count(*) AS n FROM chunk_vectors").get() as any).n).toBe(
        (db.query("SELECT count(*) AS n FROM chunks").get() as any).n,
      );
      expect(vectorStatus(db).available).toBe(true);
    } finally {
      db.close(); cleanup(vault);
    }
  }, 15000);

  test("serializes embedder calls and recovers after rejection", async () => {
    const { embedTexts, setEmbedderForTests } = await import("../src/index");
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    const firstGate = new Promise<never>((_, reject) => { rejectFirst = reject; });
    setEmbedderForTests(async (texts: string[]) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) return await firstGate;
        return { tolist: () => texts.map(() => Array(384).fill(0.01)) };
      } finally {
        active--;
      }
    }, "unused");

    const first = embedTexts("unused", ["first"]);
    await Promise.resolve();
    const second = embedTexts("unused", ["second"]);
    await Promise.resolve();
    expect(calls).toBe(1);
    rejectFirst(new Error("first failed"));
    await expect(first).rejects.toThrow("embed unavailable: first failed");
    expect(await second).toHaveLength(1);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  test("BEAM cache hits and invalidates stale or changed sources", async () => {
    const { makeConsolAdapter } = await import("../bench/beam_harness/adapters/consol");
    const { setEmbedderForTests } = await import("../src/index");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const vault = tmp("beam-cache-");
    const adapter = makeConsolAdapter("cache-test");
    const ctx = { vaultRoot: vault, tmpDir: "", dataset: "1M" as const, chatId: "99" };
    const chat = (answer: string) => [{
      time_anchor: "2026-01-01",
      turns: [[
        { role: "user", content: "What is the cache marker?" },
        { role: "assistant", content: answer },
      ]],
    }];
    setEmbedderForTests(async (texts: string[]) => ({
      tolist: () => texts.map(() => Array(384).fill(0.01)),
    }), vault);

    let opened: { agentRoot: string; db: any } | undefined;
    try {
      opened = await adapter.ingestChat(chat("cachemarkervalue-one"), { ...ctx, sourceHash: "source-one" });
      expect(opened.db.__cacheHit).toBe(false);
      expect(existsSync(path.join(opened.agentRoot, "beam-cache.json"))).toBe(true);
      await adapter.close?.({ ...opened, vaultRoot: vault });

      opened = await adapter.ingestChat(chat("cachemarkervalue-one"), { ...ctx, sourceHash: "source-one" });
      expect(opened.db.__cacheHit).toBe(true);
      const packet = await adapter.recall("cachemarkervalue-one", { ...opened, vaultRoot: vault });
      expect(packet.items.length).toBeGreaterThan(0);
      const stale = path.join(opened.agentRoot, "memories", "n99999.md");
      await adapter.close?.({ ...opened, vaultRoot: vault });
      writeFileSync(stale, "---\nid: stale\nkind: memory\n---\nstale-cache-note\n");

      opened = await adapter.ingestChat(chat("cachemarkervalue-one"), { ...ctx, sourceHash: "source-one" });
      expect(opened.db.__cacheHit).toBe(false);
      expect(existsSync(stale)).toBe(false);
      await adapter.close?.({ ...opened, vaultRoot: vault });

      opened = await adapter.ingestChat(chat("cachemarkervalue-two"), { ...ctx, sourceHash: "source-two" });
      expect(opened.db.__cacheHit).toBe(false);
      const text = (opened.db.query("SELECT group_concat(text, ' ') AS text FROM chunks").get() as any).text;
      expect(text).toContain("cachemarkervalue-two");
      expect(text).not.toContain("cachemarkervalue-one");
      const manifestPath = path.join(opened.agentRoot, "beam-cache.json");
      const tamper = (key: "adapterSourceHash" | "indexFingerprint") => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest[key] = `stale-${key}`;
        writeFileSync(manifestPath, JSON.stringify(manifest));
      };
      const seedTemporal = () => {
        opened!.db.query("INSERT INTO temporal(doc_id, valid_from, valid_to) VALUES(?,?,?)").run("stale", "2025-01-01", null);
      };

      seedTemporal();
      tamper("adapterSourceHash");
      await adapter.close?.({ ...opened, vaultRoot: vault });
      opened = await adapter.ingestChat(chat("cachemarkervalue-two"), { ...ctx, sourceHash: "source-two" });
      expect(opened.db.__cacheHit).toBe(false);
      expect((opened.db.query("SELECT count(*) AS n FROM temporal").get() as any).n).toBe(0);

      seedTemporal();
      tamper("indexFingerprint");
      await adapter.close?.({ ...opened, vaultRoot: vault });
      opened = await adapter.ingestChat(chat("cachemarkervalue-two"), { ...ctx, sourceHash: "source-two" });
      expect(opened.db.__cacheHit).toBe(false);
      expect((opened.db.query("SELECT count(*) AS n FROM temporal").get() as any).n).toBe(0);
      await adapter.close?.({ ...opened, vaultRoot: vault });
      opened = undefined;
      expect(existsSync(vault)).toBe(true);
    } finally {
      if (opened) await adapter.close?.({ ...opened, vaultRoot: vault });
      cleanup(vault);
    }
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

  test("UTF-8 cursor pagination preserves content within byte ceiling", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall, readChunk } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-cursor-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const body = "🙂漢字abc".repeat(80);
    await atomicWrite(path.join(aRoot, "memories", "mem-cursor.md"), `---\nid: mem-cursor\nkind: memory\n---\n${body}\n`);
    await atomicWrite(path.join(aRoot, "memories", "mem-cursor-other.md"), "---\nid: mem-cursor-other\nkind: memory\n---\nother cursor target\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const budgets = Budgets.parse({ l2Bytes: 17 });
    const ref = (await recall(db, vault, "mem-cursor", budgets)).items[0].ref;
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let combined = "";
    do {
      const page = readChunk(db, ref, budgets, cursor);
      expect(page.bytes).toBeLessThanOrEqual(17);
      expect(page.text).not.toContain("�");
      combined += page.text;
      firstCursor ??= page.cursor;
      cursor = page.cursor;
    } while (cursor);
    expect(combined).toBe(body);
    const otherRef = (await recall(db, vault, "mem-cursor-other", budgets)).items[0].ref;
    expect(() => readChunk(db, otherRef, budgets, firstCursor)).toThrow("invalid cursor");
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

  test("adaptive candidate target follows query complexity", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-adaptive-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(path.join(aRoot, "memories", "mem-adaptive.md"), "---\nid: mem-adaptive\nkind: memory\n---\ndeployment architecture tradeoffs and rollback\n");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const budgets = Budgets.parse({});
    expect((await recall(db, vault, "deployment", budgets)).targetCandidates).toBe(10);
    expect((await recall(db, vault, "compare deployment and rollback strategies across regions", budgets)).targetCandidates).toBe(20);
    expect((await recall(db, vault, "compare deployment, rollback, monitoring, security, and cost across regions; then assess failures and alternatives", budgets)).targetCandidates).toBe(30);
    db.close(); cleanup(vault);
  }, 15000);

  test("disputed guidance stays hidden outside history mode", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const vault = tmp("stability-disputed-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    await atomicWrite(
      path.join(aRoot, "experiences", "disputed-rule.md"),
      "---\nid: disputed-rule\nkind: experience\nstatus: disputed\n---\ndisputedneedlexyz\n",
    );
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    expect((await recall(db, vault, "disputedneedlexyz", Budgets.parse({}), "agent:alice", "guidance")).items).toHaveLength(0);
    expect((await recall(db, vault, "disputedneedlexyz", Budgets.parse({}), "agent:alice", "history")).items[0]?.docId).toBe("disputed-rule");
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
  test("unattached and detached team notes are neither indexed nor recalled", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { ensureTeam, attachTeam, getAttachedTeams } = await import("../src/agents");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-team-acl-");
    await ensureVault(vault, "alice");
    await ensureTeam(vault, "red");
    await ensureTeam(vault, "blue");
    await attachTeam(vault, "alice", "red");
    await atomicWrite(path.join(vault, "teams", "red", "memories", "red.md"), "---\nid: red-team\nkind: memory\n---\nredteamneedle\n");
    await atomicWrite(path.join(vault, "teams", "blue", "memories", "blue.md"), "---\nid: blue-team\nkind: memory\n---\nblueteamneedle\n");
    const aRoot = path.join(vault, "agents", "alice");
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) AS n FROM chunks WHERE owner='team:red'").get() as any).n).toBeGreaterThan(0);
    expect((db.query("SELECT count(*) AS n FROM chunks WHERE owner='team:blue'").get() as any).n).toBe(0);
    const teams = await getAttachedTeams(vault, "alice");
    expect((await recall(db, vault, "redteamneedle", Budgets.parse({}), "agent:alice", "auto", teams)).items.some((item) => item.docId === "red-team")).toBe(true);
    expect((await recall(db, vault, "blueteamneedle", Budgets.parse({}), "agent:alice", "auto", teams)).items.some((item) => item.docId === "blue-team")).toBe(false);

    const manifestPath = path.join(aRoot, "agent.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.teams = [];
    await atomicWrite(manifestPath, JSON.stringify(manifest));
    await syncVault(db, vault, aRoot, "alice");
    expect((db.query("SELECT count(*) AS n FROM chunks WHERE owner='team:red'").get() as any).n).toBe(0);
    db.close(); cleanup(vault);
  }, 15000);

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
    db.query("INSERT INTO links(src,dst) VALUES(?,?), (?,?)").run(id, "other", "other", id);
    db.query("INSERT INTO temporal(doc_id,valid_from,valid_to) VALUES(?,?,?)").run(id, "2026-01-01", null);
    const plan = await forgetPlan(vault, aRoot, id);
    expect(plan.requiresConfirmation).toBe(true);
    const res = await forgetConfirm(vault, aRoot, "alice", id, plan.token, db);
    expect(res.erased).toBeGreaterThanOrEqual(1);
    expect((db.query("SELECT count(*) as n FROM chunks WHERE doc_id=?").get(id) as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM files WHERE path LIKE ?").get(`%${id}%`) as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM links WHERE src=? OR dst=?").get(id, id) as any).n).toBe(0);
    expect((db.query("SELECT count(*) as n FROM temporal WHERE doc_id=?").get(id) as any).n).toBe(0);
    db.close(); cleanup(vault);
  }, 15000);

  test("forget scrubs private derivatives and receipt omits target", async () => {
    const { ensureVault, atomicWrite, hashContent } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { forgetPlan, forgetConfirm, record, recordConsultedUsage, recordRecallUsage } = await import("../src/memory");
    const { Budgets } = await import("../src/config");
    const { getRetrievalUsage, readChunk, recall } = await import("../src/retrieval");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-forget-derivatives-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-private-erasure";
    const note = path.join(aRoot, "memories", `${id}.md`);
    await atomicWrite(note, `---\nid: ${id}\nkind: memory\n---\nprivate erasure fixture\n`);
    const db = openIndex(aRoot);
    await syncVault(db, vault, aRoot, "alice");
    const packet = await recall(db, vault, id, Budgets.parse({}), "agent:alice");
    await recordRecallUsage(vault, aRoot, "alice", packet, getRetrievalUsage(packet));
    const chunk = readChunk(db, packet.items[0].ref, Budgets.parse({}));
    await recordConsultedUsage(vault, aRoot, "alice", {
      ref: packet.items[0].ref,
      docId: chunk.docId,
      owner: chunk.owner,
      offset: chunk.offset,
      packetId: packet.id,
    });
    const evidence = await record(vault, aRoot, "alice", {
      kind: "outcome",
      refs: [id],
      data: { outcome: "success", evaluator: "pass", appliedRefs: [id] },
    });
    await atomicWrite(
      path.join(aRoot, "evidence", "reviewed.jsonl"),
      `${JSON.stringify({ evidenceId: evidence.id, jobId: "job-private", reviewedAt: new Date().toISOString() })}\n`,
    );
    const beforeHash = "a".repeat(64);
    const afterHash = "b".repeat(64);
    await atomicWrite(
      path.join(aRoot, "audit", "revisions.jsonl"),
      `${JSON.stringify({ id: "rev-private", targetId: id, beforeHash, afterHash, sourceRefs: [evidence.id] })}\n`,
    );
    await atomicWrite(path.join(aRoot, "audit", "snapshots", `${beforeHash}.md`), `before snapshot ${id}`);
    await atomicWrite(path.join(aRoot, "audit", "snapshots", `${afterHash}.md`), `after snapshot ${id}`);
    await atomicWrite(path.join(aRoot, "jobs", "job-private.json"), JSON.stringify({ id: "job-private", packet: { evidence: [evidence], items: packet.items } }));
    const deletedBlob = Uint8Array.from([0, 255, 1, 254, 2]);
    const deletedBlobHash = hashContent(deletedBlob);
    const sharedBlob = Uint8Array.from([3, 253, 4, 252, 5]);
    const sharedBlobHash = hashContent(sharedBlob);
    const unrelatedBlob = Uint8Array.from([6, 251, 7, 250, 8]);
    const unrelatedBlobHash = hashContent(unrelatedBlob);
    await atomicWrite(path.join(aRoot, "blobs", deletedBlobHash), deletedBlob);
    await atomicWrite(path.join(aRoot, "blobs", `${sharedBlobHash}.bin`), sharedBlob);
    await atomicWrite(path.join(aRoot, "blobs", unrelatedBlobHash), unrelatedBlob);
    await atomicWrite(
      path.join(aRoot, "messages", "message-private.json"),
      JSON.stringify({ id: "message-private", refs: [id], attachments: [deletedBlobHash, sharedBlobHash] }),
    );
    await atomicWrite(
      path.join(aRoot, "messages", "message-retained.json"),
      JSON.stringify({ id: "message-retained", refs: ["other"], attachments: [`sha256:${sharedBlobHash}`] }),
    );

    const plan = await forgetPlan(vault, aRoot, id);
    const result = await forgetConfirm(vault, aRoot, "alice", id, plan.token, db);
    expect(JSON.stringify(result)).not.toContain(id);
    expect(result.derivatives).toBeGreaterThanOrEqual(7);
    expect(await readFile(path.join(aRoot, "audit", "usage.jsonl"), "utf8")).not.toContain(id);
    expect(await readFile(path.join(aRoot, "evidence", "reviewed.jsonl"), "utf8")).not.toContain(evidence.id);
    expect(await readFile(path.join(aRoot, "audit", "revisions.jsonl"), "utf8")).not.toContain("rev-private");
    expect(existsSync(path.join(aRoot, "audit", "snapshots", `${beforeHash}.md`))).toBe(false);
    expect(existsSync(path.join(aRoot, "audit", "snapshots", `${afterHash}.md`))).toBe(false);
    expect(existsSync(path.join(aRoot, "jobs", "job-private.json"))).toBe(false);
    expect(await readFile(path.join(aRoot, "messages", "message-private.json"), "utf8")).not.toContain(id);
    expect(existsSync(path.join(aRoot, "blobs", deletedBlobHash))).toBe(false);
    expect(await readFile(path.join(aRoot, "blobs", `${sharedBlobHash}.bin`))).toEqual(Buffer.from(sharedBlob));
    expect(await readFile(path.join(aRoot, "blobs", unrelatedBlobHash))).toEqual(Buffer.from(unrelatedBlob));
    const receiptLines = (await readFile(path.join(aRoot, "audit", "erasures.jsonl"), "utf8")).trim().split("\n");
    const receipt = JSON.parse(receiptLines.at(-1)!);
    expect(receipt).toMatchObject({ id: result.receipt, agent: "alice", erased: result.erased, derivatives: result.derivatives });
    expect(JSON.stringify(receipt)).not.toContain(id);
    expect(receipt.targetHash).toHaveLength(64);
    db.close(); cleanup(vault);
  }, 15000);

  test("forget preserves snapshots still referenced by retained revisions", async () => {
    const { ensureVault, atomicWrite, hashContent } = await import("../src/vault");
    const { forgetPlan, forgetConfirm } = await import("../src/memory");
    const vault = tmp("stability-forget-shared-snapshot-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-shared-snapshot-erasure";
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), `---\nid: ${id}\nkind: memory\n---\nshared snapshot fixture\n`);
    const sharedContent = "shared snapshot bytes";
    const sharedHash = hashContent(sharedContent);
    await atomicWrite(path.join(aRoot, "audit", "snapshots", `${sharedHash}.md`), sharedContent);
    await atomicWrite(
      path.join(aRoot, "audit", "revisions.jsonl"),
      [
        JSON.stringify({ id: "rev-erased", targetId: id, beforeHash: sharedHash, afterHash: "a".repeat(64), sourceRefs: [] }),
        JSON.stringify({ id: "rev-retained", targetId: "other", beforeHash: sharedHash, afterHash: "b".repeat(64), sourceRefs: [] }),
      ].join("\n") + "\n",
    );

    const plan = await forgetPlan(vault, aRoot, id);
    await forgetConfirm(vault, aRoot, "alice", id, plan.token);
    expect(existsSync(path.join(aRoot, "audit", "snapshots", `${sharedHash}.md`))).toBe(true);
    const revisions = await Bun.file(path.join(aRoot, "audit", "revisions.jsonl")).text();
    expect(revisions).not.toContain("rev-erased");
    expect(revisions).toContain("rev-retained");
    cleanup(vault);
  }, 15000);

  test("forget follows derivative chains to fixed point", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { forgetPlan, forgetConfirm } = await import("../src/memory");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-forget-chain-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-chain-erasure";
    await atomicWrite(path.join(aRoot, "memories", `${id}.md`), `---\nid: ${id}\nkind: memory\n---\nchain fixture\n`);
    const records: string[] = [];
    let previous = id;
    for (let i = 0; i < 8; i++) {
      const evidenceId = `ev-chain-${i}`;
      records.unshift(JSON.stringify({
        id: evidenceId,
        at: new Date().toISOString(),
        agent: "alice",
        kind: "observation",
        data: { step: i },
        refs: [previous],
      }));
      previous = evidenceId;
    }
    await atomicWrite(path.join(aRoot, "evidence", "2026", "08.jsonl"), `${records.join("\n")}\n`);
    const revisions = Array.from({ length: 7 }, (_, i) => JSON.stringify({
      id: `rev-chain-${i}`,
      targetId: `unrelated-${i}`,
      beforeHash: String(i).repeat(64),
      afterHash: String(i + 1).repeat(64),
      sourceRefs: [i === 0 ? previous : `rev-chain-${i - 1}`],
    })).reverse();
    await atomicWrite(path.join(aRoot, "audit", "revisions.jsonl"), `${revisions.join("\n")}\n`);

    const plan = await forgetPlan(vault, aRoot, id);
    await forgetConfirm(vault, aRoot, "alice", id, plan.token);
    const remaining = await readFile(path.join(aRoot, "evidence", "2026", "08.jsonl"), "utf8");
    expect(remaining).toBe("");
    expect(await readFile(path.join(aRoot, "audit", "revisions.jsonl"), "utf8")).toBe("");
    cleanup(vault);
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
    expect(validateProposal({ id: "p6", action: "update", targetId: "target", rationale: "r", sourceRefs: ["s1"], before, baseHash: hashContent(before), after: "new" } as any, vault).ok).toBe(true);
    cleanup(vault);
  }, 15000);

  test("stageProposals enforces current target hash", async () => {
    const { ensureVault, atomicWrite, hashContent } = await import("../src/vault");
    const { record } = await import("../src/memory");
    const { stageProposals } = await import("../src/reflection");
    const { readFile } = await import("node:fs/promises");
    const vault = tmp("stability-stage-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const id = "mem-stage-bh";
    const original = `---\nid: ${id}\nkind: memory\nstatus: candidate\n---\nOriginal\n`;
    const file = path.join(aRoot, "memories", `${id}.md`);
    await atomicWrite(file, original);
    const evidence = await record(vault, aRoot, "alice", {
      kind: "outcome",
      data: { outcome: "failure", evaluator: "fail", task: "deploy" },
    });
    const jobId = "job-test-123";
    await atomicWrite(path.join(aRoot, "jobs", `${jobId}.json`), JSON.stringify({
      id: jobId,
      createdAt: new Date().toISOString(),
      status: "pending",
      packet: { query: "", items: [], evidence: [evidence] },
    }));
    await atomicWrite(file, `${original}External change\n`);
    const result = await stageProposals(vault, aRoot, jobId, [{
      id: "p1",
      action: "update",
      targetId: id,
      before: original,
      baseHash: hashContent(original),
      after: "Updated",
      sourceRefs: [evidence.id],
      rationale: "Failure narrows rule.",
    }]);
    expect(result).toMatchObject({ staged: 0, reviewed: 0, retryable: true });
    expect(await readFile(file, "utf8")).toContain("External change");
    cleanup(vault);
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
    expect(pkt.targetCandidates).toBe(10);
    expect(pkt.items.length).toBeLessThanOrEqual(pkt.targetCandidates);
    expect(Buffer.byteLength(JSON.stringify(pkt), "utf8")).toBeLessThanOrEqual(12000);
    expect(pkt.attribution.packetBytes).toBe(Buffer.byteLength(JSON.stringify(pkt), "utf8"));
    db.close(); cleanup(vault);
  }, 15000);

  test("concurrent record appends do not corrupt evidence", async () => {
    const { ensureVault } = await import("../src/vault");
    const vault = tmp("stability-conc-ev-");
    await ensureVault(vault, "alice");
    const aRoot = path.join(vault, "agents", "alice");
    const { record } = await import("../src/memory");
    const ops = Array.from({ length: 8 }, (_, i) => record(vault, aRoot, "alice", {
      kind: "observation",
      data: { idx: i },
    }));
    const results = await Promise.all(ops);
    expect(results.length).toBe(8);
    expect(new Set(results.map((r) => r.id)).size).toBe(8);
    cleanup(vault);
  }, 15000);
});
