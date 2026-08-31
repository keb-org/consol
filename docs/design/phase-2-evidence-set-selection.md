# Phase 2 — Evidence-Set Selection (the architectural bet)

**Status:** the high-impact innovation; ships only if it clears the HitAny gate
**Scope:** `src/retrieval.ts` only — no schema, no new dependency, no provider call
**Goal:** return the small evidence *set* needed to answer, not N individually-high rows.

## 1. Why ranking top-N cannot win at 10M

Current `src/retrieval.ts:187` `rankRows()` fuses three arms with `RRF(k=60)`:

```
rrf = 1/(60+lexRank+1) + 1/(60+vecRank+1) + 3/(60+ledgerRank+1)
```

A stale row `pool 50` with `lex + vec` gets `2/(60+rank)`. An exact updated row `pool 75` with only `ledger rank 0` gets `3/61`. The stale row wins. Live trace: ledger rank 1 `75` lost the packet to stale `50`.

`dedupByStatement()` at `src/retrieval.ts:252` collapses near-duplicate wording by `nearDuplicateStatement()` without looking at values. `TTL 15-minute` and `TTL 20-minute` read as "same wording" and one is dropped — exactly the `current + prior` pair a temporal / `knowledge_update` question needs.

`oneHop` + `allocate()` then fill `targetCandidates 10/20/30` in fused order. A question needing two records for `Sprint 1` (original + adjusted deadline) gets one winner and 9 distractors.

At 1M many questions need 1 doc so this hides (`HitAny 70.6%`). At 10M the corpus has 9 other `Sprint N` + 20 generic deadlines; `HitAny 55.1%`, `MRR 0.35`, `recall 32.8%`. Evidence-set vs ranked-list is categorical, not a weight tweak. This is why Hindsight's 4 arms + cross-encoder still caps at 64.1 — they rank better, but still rank.

## 2. Design: state-aware evidence-set selector

This phase runs **after** `fetchAuthorized()` + authorized `oneHop` + `dedup` + `boostReusable()`, **before** `allocate()`. It only reorders the authorized candidate set already in memory. It never reads unauthorized, inactive, or wrong-mode rows.

### 2.1 Add chronology to the chunk projection

```ts
type ChunkRow = {
  chunk_id, doc_id, text, section, kind, scope, source_refs, status, hash, owner,
  updated: string | null  // NEW — from files.updated, already in DB
}
```

No packet shape change. `updated` is internal only, alongside `ledger.occurred_at`.

### 2.2 State signature (no LLM, no new table)

Derive a deterministic signature per candidate, priority order:

1. `ledger` present → `ledger.value + ledger.value_kind + ledger.occurred_at`
2. else extract from `text`: distinct normalized sets of
   * numbers / percentages / money (`75`, `15%`, `$0.11/hour`)
   * dates (`Feb 15, 2024`, `2024-02-15`)
   * versions (`18.2`, `v1.2.3`)
   * booleans/state literals (`enabled`, `disabled`, `never`, `TTL`)
3. Signature = sorted join of those sets. Two rows with different `75` vs `50` are distinct even if wording is 95% identical.

### 2.3 State-aware dedup

Replace `dedupByStatement()` rule:

```
collapse only if nearDuplicateStatement(a.summary, b.summary)
              AND stateSignature(a) === stateSignature(b)
              AND kind same
```

`Sprint 1 deadline Feb 15` and `Sprint 1 deadline Feb 20` no longer collapse. True wording duplicates with same state still collapse (saves packet bytes).

### 2.4 Bounded selector (the core)

Input: `candidates` in fused order, `typedAnchors` from Phase 1 parser, `hasNumericIntent(query)` already exists at `src/retrieval.ts:157`.

Steps, all deterministic:

1. **Anchor filter** — prefer candidates satisfying *all* typed anchors. `Sprint 7` cannot displace `Sprint 1` evidence because `"sprint 1"` anchor fails. This is a filter, not a weight.

2. **Reserve current-state slot** (only if `hasNumericIntent` or numeric/date/version in query):
   * Among anchor-satisfying candidates with a state signature, pick the best by `(anchorCoverage DESC, occurred_at/updated DESC, fusedOrder)`.
   * This is the `pool 75` / `TTL 20-minute` / `Feb 15` row. It is *reserved* at position 0 or 1 even if its raw RRF lost.
   * Selection is within authorized rows only.

3. **Cover missing anchors** — iterate fused order, add the first candidate covering each still-uncovered typed anchor or distinct query term, skipping already-reserved docs.

4. **Fill** — remaining slots in fused order, no new scoring.

No new weighted score is invented. The selector is a coverage + state reservation pass over existing order. `oneHop` links remain, but their `0.5 * seed RRF` never overrides the reserved state slot.

### 2.5 Why this preserves token efficiency

* Packet targets `10/20/30` and `packetCeiling` unchanged. Reserved state slot is 1 item, not 10.
* No extra recall, no extra embedding, no cross-encoder. The host `recall → read → narrower recall` loop is untouched — but its first packet now actually contains the evidence it would have had to re-query for.
* Heavy indexing is *not* required here — this phase is intentionally lean so it validates fast. The heavy-index variant (entity timeline + PPR graph) is Phase 3 if this gate passes.

## 3. Implementation checklist

* `src/retrieval.ts`:
  * extend `ChunkRow` + all `SELECT ... FROM chunks` projections to include `updated`
  * add `stateSignature(row): string` (ledger-first, then regex sets)
  * update `dedupByStatement()` to be state-aware
  * add `selectEvidenceSet(candidates, anchors, query)` implementing §2.4, called between `boostReusable()` and `allocate()`
  * keep `RRF_K=60`, `ledger weight 3`, quotas, ceilings, and `fetchAuthorized` boundaries
* `src/index.ts`: no change in this phase (Phase 1 parser is reused for anchors)

## 4. Tests

* State-aware dedup retains `15-minute` vs `20-minute` with near-identical wording; collapses true same-state duplicate.
* `SELECT` leakage test: stronger unauthorized/inactive distractor with better anchor coverage never enters selection.
* End-to-end with vectors unavailable (`vecCapped 0`): `recall("current Redis TTL", ...)` returns `redis-new` (20-min) before `redis-old`; `maximumPacket.ledgerCapped > 0`.
* Rebuild produces identical ordering; packet stays under `packetCeiling`.

## 5. Gate — must clear to ship

On **1M chats 1–3 (51 complete labels)** vs same-code exact-token baseline, combined Phase 1+2 must:

* **+5 HitAny wins** (~+9.8pp) and **+8pp mean source recall**
* no loss in `MRR`, `updateUpdatedRetrieved`, or `currentStatePreferred`
* no increase in `staleOnly`, mean packet bytes +10% max, cached recall latency +20% max

If it fails, delete the selector — lexical repair stays as the correctness fix. This is the `+10–20%` vs `+0.1%` gate you asked for.

## 6. What this enables but does not yet do

Does not build validity intervals, supersession graphs, or general temporal inference — that is Phase 3. Does not claim cross-session aggregation (multi-hop sums) — that would need the heavy entity-index variant where indexing can run for hours in background (see Phase 3).
