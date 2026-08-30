import { describe, test, expect } from "bun:test";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";

function tmp(prefix: string) { return mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanup(dir: string) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

describe("adversarial & edge-case suite", () => {
  const MOCK_EMBED = async (texts: string[]) => texts.map(() => Array(384).fill(0.01));
  test("SQL injection attempts in search queries fail safely without throwing or corrupting", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");

    const vault = tmp("adv-sql-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await atomicWrite(path.join(agentRoot, "memories", "doc.md"), "---\nid: doc\nkind: memory\n---\nProduction db creds\n");
      const { setEmbedderForTests: _mockEmbed } = await import("../src/index");
      _mockEmbed(MOCK_EMBED, vault);
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");

      const evilQueries = [
        `' OR 1=1; DROP TABLE chunks; --`,
        `" OR ""="`,
        `admin' --`,
        `' UNION SELECT null, null, null, null, null, null, null, null, null, null, null --`,
        `*`,
        `"*"`,
        `AND OR NOT`,
        `(((`,
        `{"json": "injection"}`,
        `\0nullbyte`,
      ];

      for (const q of evilQueries) {
        const pkt = await recall(db, vault, q, Budgets.parse({}));
        expect(pkt).toBeDefined();
        expect(Array.isArray(pkt.items)).toBe(true);
      }

      // Verify DB schema was not tampered with or dropped
      const count = db.query("SELECT count(*) as n FROM chunks").get() as any;
      expect(count.n).toBeGreaterThan(0);
      db.close();
    } finally {
      cleanup(vault);
    }
  });

  test("unicode, emoji, RTL, zero-width characters and multi-megabyte payloads handled gracefully", async () => {
    const { ensureVault, atomicWrite, hashContent } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall, readChunk } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");

    const vault = tmp("adv-unicode-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const weirdContent = `---
id: unicode-doc
kind: memory
tags: ["🚀", "مرحبا", "שלום", "日本語"]
---
# 🚀 Extreme Unicode ​‌‍﻿ Test

Arabic: هذا اختبار للذاكرة مع اتجاه من اليمين إلى اليسار
Hebrew: זהו מבחן זיכרון
Japanese: これはエッジケースのテストです
Emoji: 🤖🧠💾🔒⚡️🎯
Math symbols: ∀x ∈ ℝ, ∃y: y > x ∧ ∫ f(x)dx = F(x) + C
`;
      await atomicWrite(path.join(agentRoot, "memories", "unicode.md"), weirdContent);
      const { setEmbedderForTests: _mockEmbed } = await import("../src/index");
      _mockEmbed(MOCK_EMBED, vault);
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");

      const pkt = await recall(db, vault, "これは 🚀", Budgets.parse({}));
      expect(pkt.items.length).toBeGreaterThan(0);

      const chunk = readChunk(db, pkt.items[0].ref, Budgets.parse({}));
      expect(chunk.text).toContain("Extreme Unicode");
      expect(chunk.text).toContain("Arabic");

      db.close();
    } finally {
      cleanup(vault);
    }
  });

  test("corrupted / empty / malformed files do not crash vault sync", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");

    const vault = tmp("adv-corrupt-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      const memDir = path.join(agentRoot, "memories");

      // 1. Completely empty file
      writeFileSync(path.join(memDir, "empty.md"), "");

      // 2. File with only whitespace and newlines
      writeFileSync(path.join(memDir, "whitespace.md"), "   \n\n\t\t\n  ");

      // 3. Broken unclosed frontmatter
      writeFileSync(path.join(memDir, "broken-fm.md"), "---\nid: test\nkind: [unclosed");

      // 4. Huge single continuous line without whitespace (capped to 32 chunks via chunkMarkdown)
      const hugeLine = "A".repeat(2 * 1024 * 1024);
      writeFileSync(path.join(memDir, "huge-line.md"), `---\nid: huge\nkind: memory\n---\n${hugeLine}`);

      const { setEmbedderForTests: _mockEmbed } = await import("../src/index");
      _mockEmbed(MOCK_EMBED, vault);
      const db = openIndex(agentRoot);
      // Must not throw or hang
      await syncVault(db, vault, agentRoot, "alice");

      const row = db.query("SELECT count(*) as n FROM files").get() as any;
      expect(row.n).toBeGreaterThan(0);

      db.close();
    } finally {
      cleanup(vault);
    }
  }, 15000);

  test("rapid concurrent lock acquisition and release maintains linear integrity", async () => {
    const { ensureVault, withVaultLock, atomicWrite } = await import("../src/vault");

    const vault = tmp("adv-lock-");
    try {
      await ensureVault(vault, "alice");
      const testFile = path.join(vault, "counter.txt");
      await atomicWrite(testFile, "0");

      const workers = Array.from({ length: 15 }, async (_, i) => {
        return withVaultLock(vault, async () => {
          const current = parseInt(await readFile(testFile, "utf8"), 10);
          await new Promise((r) => setTimeout(r, 5));
          await atomicWrite(testFile, String(current + 1));
          return i;
        });
      });

      const results = await Promise.all(workers);
      expect(results.length).toBe(15);
      const finalCount = parseInt(await readFile(testFile, "utf8"), 10);
      expect(finalCount).toBe(15);
    } finally {
      cleanup(vault);
    }
  });

  test("path traversal attacks on agent and memory APIs are blocked", async () => {
    const { ensureVault } = await import("../src/vault");
    const { ensureAgent, attachTeam } = await import("../src/agents");
    const { forgetPlan } = await import("../src/memory");

    const vault = tmp("adv-traversal-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await ensureVault(vault, "bob");

      // Attempt agent path traversal
      const evilTarget = "../../../etc/passwd";
      await expect(ensureAgent(vault, evilTarget)).rejects.toThrow();
      await expect(attachTeam(vault, "alice", evilTarget)).rejects.toThrow();

      // Attempt to forget via relative path
      const evilDocId = "../../../system32/cmd.exe";
      const plan = await forgetPlan(vault, agentRoot, evilDocId);
      expect(plan.candidates.length).toBe(0);
    } finally {
      cleanup(vault);
    }
  });

  test("ref forgery with modified chunk_id or hash throws security error", async () => {
    const { ensureVault, atomicWrite } = await import("../src/vault");
    const { openIndex, syncVault } = await import("../src/index");
    const { recall, readChunk, decodeRef } = await import("../src/retrieval");
    const { Budgets } = await import("../src/config");

    const vault = tmp("adv-ref-");
    try {
      const { agentRoot } = await ensureVault(vault, "alice");
      await atomicWrite(path.join(agentRoot, "memories", "secret.md"), "---\nid: sec\nkind: memory\n---\nSecret data\n");
      const { setEmbedderForTests: _mockEmbed } = await import("../src/index");
      _mockEmbed(MOCK_EMBED, vault);
      const db = openIndex(agentRoot);
      await syncVault(db, vault, agentRoot, "alice");

      const pkt = await recall(db, vault, "Secret", Budgets.parse({}));
      const originalRef = pkt.items[0].ref;
      const parsed = decodeRef(originalRef);

      // 1. Alter hash
      const fakeHashRef = Buffer.from(JSON.stringify({ ...parsed, h: "fakehash1234" })).toString("base64url");
      expect(() => readChunk(db, fakeHashRef, Budgets.parse({}))).toThrow(/stale ref/);

      // 2. Non-existent chunk ID
      const fakeChunkRef = Buffer.from(JSON.stringify({ ...parsed, c: 999999 })).toString("base64url");
      expect(() => readChunk(db, fakeChunkRef, Budgets.parse({}))).toThrow(/unknown ref/);

      // 3. Foreign owner
      const fakeOwnerRef = Buffer.from(JSON.stringify({ ...parsed, o: "agent:mallory" })).toString("base64url");
      expect(() => readChunk(db, fakeOwnerRef, Budgets.parse({}))).toThrow(/owner mismatch/);

      db.close();
    } finally {
      cleanup(vault);
    }
  });
});
