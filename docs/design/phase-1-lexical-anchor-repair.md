# Phase 1 — Anchor-Aware Lexical Repair

**Status:** approved correctness fix, ships unconditionally if regressions pass
**Scope:** `src/index.ts` only — query construction, no schema or fingerprint change
**Goal:** make the candidate pool contain the right docs in the first place.

## 1. Why this phase exists

Current `ftsSearch()` at `src/index.ts:470` is broken in a way no ranking tweak can rescue:

```ts
// before
const raw = query.trim().replace(/["'*]/g, " ");
const words = raw.split(/\s+/).filter(Boolean);
const ftsQuery = words.length > 1 ? words.join(" OR ") : raw;
try {
  return db.query(`... WHERE chunks_fts MATCH ? ...`).all(ftsQuery, limit);
} catch {}
// swallows FTS5 parser error, then:
return db.query(`... WHERE text LIKE ? OR ... ORDER BY doc_id, chunk_id`).all(...)
```

* `?`, `:`, `()`, `"` survive into `MATCH`. A normal BEAM question like `"What is Sprint 1 deadline?"` throws `fts5: syntax error near "?"`.
* The `catch {}` swallows it. Fallback does `LIKE '%what%' OR '%is%' OR '%sprint%' OR '%1%' OR '%deadline?%'` — stopword-heavy, unescaped, ordered by earliest `doc_id`.
* At 1M this returns 60 earliest docs with any stopword. At 10M it returns 60 earliest out of 10x more. Two live traces for `Sprint 1` both returned `rank:-1` and 0/20 relevant docs.
* `numericLedgerSearch()` at `src/index.ts:511` does `LIMIT max(limit*4) ORDER BY f.rank` then re-ranks by exact-token `coverage`. The exact `Sprint 1 Feb 15` row is cut before coverage is counted. Newer `Sprint 7 Sep 10` wins on global `occurred_at`.

If the gold doc is not in `perArmCap=60` / `poolLimit=target*3`, `RRF(k=60)` and `ledger weight 3` at `src/retrieval.ts:187` are mathematically irrelevant. Fixing inclusion is binary per question, not +0.1%.

## 2. Design: typed anchor parser + strict/relaxed tiers

Replace the single `OR` string with a tiny local parser that emits:

* **typed anchor groups** — exact discriminators that must not be split:
  * quoted phrases: `"database connection pool"`
  * ordinal anchors: `Sprint 1`, `Sprint-1`, `Sprint #1` (normalized to canonical `sprint 1`)
  * acronyms: `QPS`, `TTL`, `RAG`
  * versions: `v1.2.3`, `18.2`
  * ISO dates: `2024-02-15`, `Feb 15, 2024`
  * hyphenated IDs: `APP-1234`
* **retained content terms** — no scaffolding stoplist in code. Scaffolding is removed by the AI via the `recall` prompt (see §2.1). Parser just lowercases, enforces `len>=2`, caps 16 terms. Queries with `? : () "` are sanitized so they never throw FTS5.

Both lists are deterministically ordered and capped (anchors first, then up to 16 terms).

Prompt scaffolding handles `what is / when was / how many` — see §2.1 below. No language-specific stoplist.

Build only safely quoted FTS5 expressions:

```
strict:  "sprint 1" AND "deadline"          -- every token inside each anchor required,
                                            -- anchors ANDed together
relaxed: deadline OR sprint                 -- recall only, no anchor requirement
```

* Quote every literal: `"` -> `""` inside, wrap whole token in `"..."`.
* Never emit bare `*`, `OR`, `AND`, `NEAR` from user text — only from this builder.
* Merge: strict results first, then unseen relaxed results. A `chunk_id` receives **one** lexical rank (first appearance), no duplicate RRF credit.

Fallback rules:

* Valid zero-result FTS is zero results — do not trigger `LIKE`.
* `LIKE` runs only on real FTS execution failure. Escape `%` and `_` (`\%`, `\_` with `ESCAPE '\'`), rank by `(anchorCoverage DESC, termCoverage DESC, doc_id, chunk_id)`. Never `ORDER BY doc_id` alone.

Ledger reuse:

* `numericLedgerSearch()` calls the same parser. Fetch strict-anchor rows before relaxed rows, then sort by `(typedAnchorMatch DESC, coverage DESC, occurred_at DESC, f.rank)`. This prevents pre-truncation from deleting exact entity rows and stops global recency from promoting unrelated entities.

### 2.1 Prompt-based scaffolding (no code)

No scaffolding stoplist, no language detector. AI compliance is best-effort, parser stays lean:

* **MCP tool description** (`src/mcp.ts`): `recall(query) — 2–6 keywords, exact phrases in "quotes" when it must stay together (names, IDs, versions). No question words, no sentences.`
* **Agent system prompt** (`bench/beam_harness/run.ts:155` and `src/mcp.ts` instructions): `Start with recall using keywords, not the full question. Example: "Sprint 1" deadline not "What is the Sprint 1 deadline?"`
* If AI slips and sends the full question, the 2-tier strict→relaxed still limits damage — no stopword-heavy `LIKE` pool.

Fingerprint unchanged — this is query-time only, so cached indexes remain valid.

## 3. Implementation checklist

* New helpers in `src/index.ts` (no new deps):
  * `parseAnchors(query): { anchors: string[][], terms: string[] }`
  * `ftsQuote(s: string): string`
  * `buildStrictQuery(anchors): string | null`
  * `buildRelaxedQuery(terms): string | null`
  * `likeEscape(s): string`
* Rewrite `ftsSearch(db, query, limit)` to use strict→relaxed merge.
* Rewrite `numericLedgerSearch()` to use same anchors and new ordering. Keep exact-token `numericTokens()` + `Set.has()` check — the token fix stays.
* Keep `src/tokenizer.ts` untouched per constraint; new parser is independent.

## 4. Tests (production-path)

Add to `tests/retrieval.test.ts` / `tests/stability.test.ts`:

* Stopword-heavy `"What is the Sprint 1 deadline?"` with trailing `?` resolves via FTS5 (no `rank:-1`) and ranks exact `Sprint 1` above 5/7/9 distractors.
* Quoted phrase, acronym, version, ISO date, hyphenated ID each remain safe and searchable (`"` and `'` do not throw).
* Valid zero-result FTS returns `[]` (no fallback pollution). Forced FTS failure (inject bad `MATCH`) uses escaped deterministic fallback.
* Exact numeric anchor survives beyond old `limit*4` window — `numericLedgerSearch("Sprint 1 deadline", 2)` returns `[1, 2]` even when 20 newer distractors exist before it.

## 5. Gate

Stays as correctness fix if regressions pass: no increase in stale-only, packet bytes +10% max, cached recall latency +20% max. No HitAny gate required — but expect +3–5 wins on 1M 1–3 from pool rescue alone.

## 6. What this does not do

Does not solve stale-beats-updated or single-winner problems — that is Phase 2. Does not add tables, embeddings, or background jobs.
