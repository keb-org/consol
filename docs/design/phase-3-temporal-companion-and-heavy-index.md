# Phase 3 — Narrow Temporal Companion + Optional Heavy-Index Evolution

**Status:** conditional — ships only if additive ablation passes; heavy-index variant is a follow-on, not required to clear Hindsight
**Scope:** `src/retrieval.ts` for companion; `src/index.ts` + `src/config.ts` + `src/vault.ts` for heavy-index evolution (schema/fingerprint bump)
**Goal:** rescue the small set of temporal/state-change questions needing two same-entity records, and — if you want absolute limits — shift intelligence to background indexing where hours of compute are free.

## 1. Why a third phase at all

Phases 1+2 fix pool inclusion and evidence-set reservation. After them, a query like:

> "How many days between when I set the Sprint 1 deadline and when I adjusted it to mid-February?"

has its `Sprint 1 Feb 15` current-state reserved. But the `Sprint 1 Jan 15` prior-state may still sit at fused rank 40 behind `Sprint 5/7/9` distractors, outside `targetCandidates 10/20/30`. The BEAM category that suffers is exactly `temporal_reasoning` / `knowledge_update` / `contradiction_resolution` — verified in `chats/10M/*`: each chat has 100 distinct `time_anchor` values, `knowledge_update` rubrics are 100% numeric, `event_ordering` needs ordered sequences.

Phase 3 does not build a general temporal reasoner. It reserves **at most one** distinct-date companion for explicit state-change intent, and optionally — since you said indexing can run for hours — materializes an entity timeline so `Sprint 1` lookups become an ordered chain instead of a ranked search.

## 2. Part A — Narrow temporal companion (lean, no schema change)

### 2.1 When it activates

Gate on explicit state-change/comparison intent in the query, detected by a tiny cue set (no LLM):

```
before, after, between, changed, adjusted, updated, originally, previous,
prior, current, latest, first, last, timeline, order, sequence
```

`hasNumericIntent(query)` at `src/retrieval.ts:157` already exists; this is an additional `hasTemporalComparisonIntent(query)` check. Non-temporal queries do not pay any cost.

### 2.2 Selection rule

Runs after Phase 2 evidence-set selection, over the same authorized candidate set:

1. Take the reserved current-state leader from Phase 2 (`Sprint 1 Feb 15`, `pool 75`).
2. Find the best candidate sharing **all** typed anchors (`sprint 1`, not `sprint 7`) with:
   * a distinct `stateSignature` (different value/date/version/bool),
   * a distinct `occurred_at`/`updated` (normalized dates differ).
3. Rank companions by `(anchorCoverage DESC, temporalDistanceToLeader DESC, occurred_at ASC)` — prefer the chronologically useful prior, not the nearest lexical duplicate.
4. Reserve at most **one** slot for it, inserted at position 1 (right after leader). If no companion exists, nothing is added.

### 2.3 Hard limits

* One companion max. No validity intervals, no supersession inference, no graph walk, no interval algebra.
* Never promotes unauthorized/inactive/wrong-mode rows — same `fetchAuthorized()` boundary as Phase 2.
* Non-temporal queries must not show history. `recall("What is the current TTL?", …)` must still return `20-minute` first, `15-minute` second (already tested in `tests/stability.test.ts:37`), not a forced pair.

### 2.4 Tests for Part A

* Temporal query: `recall("How many days between setting Sprint 1 deadline and adjusting it to mid-February?", …)` with vectors unavailable contains both `Feb 15` and `Jan 15` records in the packet, leader first.
* Non-temporal query: `recall("What is the current Redis TTL?", …)` does not force a prior-state companion beyond the existing `ledgerCapped` ordering.
* Unauthorized stronger distractor with better anchor coverage never displaces the companion slot.

### 2.5 Gate for Part A — must clear to stay

Beyond Phase 1+2, on the same 1M 1–3 (51-label) dev set, Part A must:

* rescue **≥3 previously missed evaluable temporal/update questions** (questions where `bothRetained` was false and becomes true),
* with no loss in overall `HitAny`, `MRR`, `updateBothRetained`, `currentStatePreferred`,
* no increase in `staleOnly`, mean packet bytes +10% max, cached recall latency +20% max.

If it fails, delete the companion code — Phases 1+2 remain. This is the `+0.1%` filter you asked for.

---

## 3. Part B — Heavy-index evolution (only if you push to absolute limits)

You stated: *"the indexing layer is not important as people will leave their computer for hours, background tasks, doesnt hurt user experience."* That unlocks the real architectural change Hindsight cannot match without cloud infra.

**Invariant:** retrieval stays `O(perArmCap + RRF)` bounded. Indexing becomes `O(n log n)` heavy, runs in `syncVault` / `rebuild` background, and is a disposable projection (files remain canonical). This is spirit-compliant: `index.sqlite` is already rebuildable; fingerprint bump just triggers one rebuild.

### 3.1 Entity State Timeline Index (highest leverage for 10M)

**Today:** `chunks` are flat text, `numeric_ledger` is `value + statement + occurred_at` grep. `Sprint 1` vs `Sprint 01` vs `Sprint #1` are different tokens.

**Heavy index — new tables, all rebuildable from Markdown:**

```sql
entities(id INTEGER PK, canonical TEXT UNIQUE, aliases TEXT)  -- aliases = JSON array
entity_postings(entity_id, chunk_id, positions TEXT)
entity_states(entity_id, value TEXT, value_kind TEXT, occurred_at TEXT, updated TEXT, chunk_id, is_current INT)
entity_graph(src_entity INT, dst_entity INT, weight REAL)     -- co-occurrence in same note
```

* Build at `syncVault` time: regex + local NER (`@huggingface/transformers` q8, same runtime as embedder) extracts entities, canonicalizes ordinals (`Sprint-1` → `sprint 1`), injects alias headers before embedding so vector no longer drowns on `Sprint 1 vs 7`.
* `facet_key = canonical_entity + attribute_slug` (e.g. `sprint-1.deadline`, `redis.ttl`) — deterministic, no LLM.
* Schema bump → `indexFingerprint()` in `src/config.ts` changes, old `index.sqlite` is dropped once.

**Query time:** parse `Sprint 1 deadline` → resolve to `entity_id=7` →

```sql
SELECT * FROM entity_states WHERE entity_id=7 ORDER BY occurred_at DESC
-- returns Feb 15 (current) + Jan 15 (prior) as a pair, no FTS pollution
```

HitAny at 10M goes from "find needle in 60" to "lookup timeline". This is Hindsight's graph+temporal arms, but deterministic, local, zero LLM at recall. Estimated +15–20% rescue on `knowledge_update` / `preference_following` where `ledger-triggered HitAny` is already 90.5% vs 70.6% overall.

### 3.2 Spreading Activation via PPR on Entity Graph

Heavy index also materializes `entity_graph` edges weighted by co-occurrence. At query time, seed PPR from matched entities (`Sprint 1=1.0, deadline=0.5`) and walk 2 hops:

```
scores0[seed]=1.0
scores_{t+1}= α·scores0 + (1-α)·propagate(scores_t, edges)   -- α=0.15, 3 iterations
```

A `multi_session_reasoning` question needing `X + Y` across sessions now surfaces via graph distance, not vector cosine. Hindsight does 1-hop only (`tanh(entity_count×0.5)`), no PPR. Cost: ~5ms integer PPR after background precompute, vs ~200ms cross-encoder rerank with provider call.

### 3.3 Canonicalization choice (needs your call)

Strict `Sprint 1 === Sprint-1 === Sprint #1` or keep distinct? Strict maximizes recall, distinct maximizes `contradiction_resolution` precision. Recommend strict canonical + preserve raw form in `aliases` for exact-match filter — but this is the one decision where your help is highest leverage.

### 3.4 When to build Part B

Only after Phases 1+2 freeze and validate on remaining 1M chats (positive HitAny/recall deltas, no guardrail regression). Then:

1. Implement Part B behind fingerprint bump.
2. Re-run `bench/beam_harness/retrieval_ablation.ts` on 1M 1–3 — must still clear Phase 2 gate plus ≥3 additional temporal rescues.
3. Validate on remaining 1M, then 10M holdout (chats beyond 1,2) — no per-question tuning.
4. Full `bench/beam_harness/run.ts` memory-tool agent loop with official judge before any Hindsight claim.

Heavy index costs one rebuild; retrieval latency and packet ceilings stay identical. If it fails its gate, revert fingerprint — no lasting cost.

## 4. Implementation checklist

* **Part A lean companion:** edits `src/retrieval.ts` only — add `hasTemporalComparisonIntent()`, companion reservation pass after `selectEvidenceSet()`.
* **Part B heavy index:** edits `src/index.ts` (entity extraction + postings + states + graph build), `src/config.ts` (fingerprint), `src/vault.ts` if chunk header injection needed. No new runtime dependency beyond existing `transformers` q8.
* Both keep `RRF_K=60`, `ledger weight 3`, quotas, ceilings, and authorization boundaries.

## 5. Verification

Same as Phases 1+2:

1. `bun run typecheck`
2. `bun test tests/retrieval.test.ts tests/stability.test.ts`
3. `bun test`
4. `bun run build`
5. Staged `retrieval_ablation.ts` runs — inspect raw changed cases, not just aggregates
6. Full `run.ts` agent loop only after frozen validation

## 6. What this does not do

Part A does not build validity intervals or supersession graphs. Part B does not add a daemon, graph DB, or provider call at recall time. Both keep the host `recall → read → narrower recall` loop unchanged — but its first packet no longer needs a second query to find the prior state.
