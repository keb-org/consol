# Beating Hindsight on BEAM 10M — Part 1: Evidence Base, Shared Substrate, Design A

Status: proposal (hypothetical; unproven until run through the can't-cheat harness)
Date: 2026-08-30
Companion: [beat-hindsight-2-designs-b-c-and-decisions.md](beat-hindsight-2-designs-b-c-and-decisions.md)

---

## 0. Ground rules

1. **Target**: Hindsight's published **64.1% on BEAM 10M** (next-best published: Mem0 48.6, Honcho 40.6, LIGHT 26.6, RAG 24.9). Our honest interim best: 41.8. Aim: 70+ to clear 64.1 with margin, not by luck.
2. **No leakage, ever**: engines never see rubrics, `question_type`, probing files, or anything derived from them. Category-aware *behavior* must emerge from the query itself (temporal expressions, numeric intent, instruction phrasing), which any real user query exhibits. Anything else is disqualification.
3. **Spirit constraints (consol's core promises)**: Bun + `bun:sqlite` + `sqlite-vec` only; no daemon, no Postgres, no graph DB, no cloud. Files are canonical; SQLite is a rebuildable projection. Deterministic code controls authority. **No generative LLM inside the engine** — small local neural models (Q8 ONNX embedder/reranker class) are already part of the design and are allowed; LLM extraction happens at the write boundary by the host agent or the harness, exactly like `remember`/`record` already work. The same engine must serve the daily MCP loop (≤1.2K packets) and the benchmark (budget tier) — benchmark features must be product features, or they are benchmark maxing.
4. **What "winning" means**: same questions, same answerer model, same judge for every system — including re-running Hindsight/Mem0 OSS through our can't-cheat harness, because published numbers mix answerer backbones.

---

## 1. The measured enemy — BEAM failure anatomy (verified from data, not blogs)

### 1.1 Corpus shape (`chats/10M/*`, verified)

- 10 chats × ~11.6M tokens = 116M tokens total. Per chat: **exactly 100 batches, each with a distinct `time_anchor`** (`July-01-2024` → onward) — **100 dated sessions for free**. 1M chats: 10 batches / 10 anchors.
- ~9,950 user messages (~534 chars) + ~9,000 assistant messages (~4,426 chars) per chat. Assistant messages carry most of the facts (users state intents; assistants state results/numbers).
- `question_type` on user messages: `main_question` (6,228), `followup_question` (2,755), `answer_ai_question` (965) — natural, engine-visible signal, no leakage.

### 1.2 What each category's rubrics are made of (content analysis of 10M/1)

| Category | Rubric content | What retrieval must return |
|---|---|---|
| information_extraction | exact values ("98% detection rate") | the atomic fact |
| knowledge_update | 100% numeric ("17 tasks", "88%") | **current** value per facet, with the old value as distractor |
| multi_session_reasoning | numeric aggregates across sessions ("1.8M total") | all component values grouped by facet |
| preference_following | numeric cost constants ("$0.11/hour", "500 instances") | preference facts, latest |
| temporal_reasoning | date arithmetic ("14 days", "Feb 15 → Mar 1") | both endpoint facts with absolute dates |
| event_ordering | ordered list of exactly 20 items | ordered sequence, not a set |
| summarization | thematic phrases over a date range | session-level themes in the window |
| contradiction_resolution | assert/deny pair ("you mentioned X / you said never X") | both polarity facts for one facet |
| instruction_following | answer-shape demands ("include latency numbers") | the user's meta-instructions on the topic |
| abstention | "there is no information related to X" | **calibrated emptiness** — must not flood noise |

Key structural facts: temporal/knowledge_update/multi_session rubrics are 100% numeric — a system with no numeric-state representation leaves ~30% of the benchmark to luck. Abstention rewards returning nothing — every "return top-k regardless" design bleeds points here. Event ordering is partly answer-side (the model must enumerate), but only ordered retrieval input makes ordered enumeration likely.

### 1.3 The judge is a step function

BEAM grades 0 / 0.5 / 1.0 per rubric item and averages; 0.5 is deliberately easy (partial coverage). Consequence: getting the *right evidence into the answer* is most of the score; perfection is not required, but noise is fatal (it drowns the evidence and flips 0.5→0).

---

## 2. Hindsight source teardown (what actually makes 64.1)

Verified from `.research/hindsight/hindsight-api-slim` source:

**Load-bearing mechanisms:**

1. **Consolidated observations + proof_count.** Background consolidation merges facts into `observation` rows ("one canonical observation with many source facts is always better"), each carrying `proof_count` from distinct sources. Observations compete in every retrieval arm and their proof_count multiplies the rerank score. This is compounding corpus quality — a 20-proof observation outranks any single noisy fact.
2. **Cross-encoder rerank with date injection.** Local `ms-marco-MiniLM-L-6-v2`, top-300 candidates, input pair = `query vs "[Date: June 5, 2022 (2022-06-05)] {context}: {text}"` — the cross-encoder becomes temporally aware for free. Sigmoid normalization, then multiplicative boosts: `final = CE × recency × temporal × proof` (alphas 0.2/0.2/0.1, max swing ≈ +21%/−19%).
3. **Four parallel arms + RRF(K=60).** Semantic (bge-small-en-v1.5 384-d, over-fetch `max(limit,20)`), BM25 (Postgres `ts_rank_cd` with IDF-based term *selection* only — 16 lowest-df terms), graph (1-hop from 20 semantic seeds: `tanh(entity_count×0.5) + semantic_kNN_weight + causal_weight`, additive), temporal (8 time-bucket coverage entry points + BFS spreading ≤5 iterations over temporal/causal links, causal boost 2.0).
4. **Extraction discipline.** Facts carry what/when/where/who/why, `occurred_start/end`, entities, and **causal relations extracted in the same call**; relative dates converted to absolute *inside the fact text*; coreference resolved ("my roommate" → "Emily (user's roommate)").
5. **Dual temporal columns**: `occurred_*` (event time) vs `mentioned_at` (statement time) threaded through everything.

**Their exploitable weaknesses (source-verified):**

| # | Weakness | Evidence |
|---|---|---|
| W1 | Tiny embedder (bge-small 384-d) caps dense recall | `config.py:977,1003` |
| W2 | Temporal analyzer returns a **single-day** window; spans/second dates degrade | `query_analyzer.py:412-416` |
| W3 | **No query-time entity resolution** — query entities never touch the entity graph; graph arm is entirely seed-mediated | teardown §2 |
| W4 | Graph arm is **1-hop only**, no PPR/multi-hop | `link_expansion_retrieval.py` |
| W5 | Recency-by-default (−19% for year-old facts) penalizes old-but-relevant | `reranking.py:79-82` |
| W6 | **No numeric state tracking** — consolidation prompt literally says "NO COMPUTATION … never do arithmetic" | `consolidation/prompts.py:34-52` |
| W7 | `ts_rank_cd` is not true BM25 (no IDF at scoring; df stats tenant-global) | `bm25_term_selection.py:20-23` |
| W8 | Contradictions resolved only by single-batch consolidation LLM; no query-time contradiction surfacing | teardown §5 |

W6 is the biggest: it maps directly onto the three 100%-numeric categories (§1.2). W3, W2, W4 are free wins. W8 maps onto contradiction_resolution. Nothing in their stack handles abstention calibration, instruction-shaped memory, or session-level themes.

---

## 3. Where the points are — category → mechanism map

Per-category point budget on 10M (each category = 20 questions; 200 total). Our honest 41.8 baseline → required path to 70+:

| Category | Ours (honest) | Hindsight-implied | Lever |
|---|---|---|---|
| information_extraction | 60 | ~85 | facts + hybrid + CE rerank (optimization) |
| knowledge_update | 75 | ~80 | **numeric state ledger (innovation)** |
| multi_session_reasoning | 51 | ~65 | **ledger grouping + session units (innovation)** |
| preference_following | 25 | ~75 | preference facets + latest-state (innovation + optimization) |
| temporal_reasoning | 31 | ~65 | span parsing + date-typed facts (fix W2) |
| event_ordering | 35 | ~50 | timeline projection (innovation) |
| summarization | 23 | ~55 | **session digests (innovation)** |
| contradiction_resolution | 33 | ~60 | **contradiction pair index (fix W8)** |
| instruction_following | 25 | ~55 | **instruction ledger (innovation)** |
| abstention | 60 | ~85 | abstention gate (innovation) |

Retrieval alone does not decide the score — the answerer does. All designs ship with the can't-cheat harness (harness owns answer generation + LLM judge; engine only exports `recall`). Predicted ranges in Part 2 §10 assume a haiku-class answerer.

---

## 4. Shared substrate (all three designs build on this)

Everything here is **required** before any design differentiates. Each element is either already proven in our worktrees or is a fix to a verified Hindsight weakness.

### 4.1 Write boundary — atomic facts (host/harness LLM; engine stays pure)

Per turn-pair, the host extracts (same shape as `remember`/`record` today; 1 LLM call per batch, mirroring Mem0/Hindsight economics):

```
fact {
  id, text            // self-contained; names resolved; absolute dates in text
  entities[]          // canonical + alias strings
  occurred_start, occurred_end   // event time (nullable)
  mentioned_at, session_id       // statement time = session anchor (free from BEAM; = turn time in prod)
  turn_ref            // opaque back-pointer (evidence remains distinct: R3)
  numbers[]           // deterministic post-pass, see 4.2
  polarity            // deterministic post-pass: assert | negate
}
```

Deterministic engine-side post-passes (no LLM): numeric extraction (`$0.11/hour`, `500 instances`, `98%`, `17 tasks`, dates), polarity cue classification ("never", "didn't", "not"), alias map building (string ops + embedding clustering of entity strings).

**Spirit mapping**: facts land as Markdown notes (canonical) + projections in SQLite (rebuildable). This *is* consol's memory model — BEAM ingest is just `remember()` driven by the harness adapter.

### 4.2 Index (SQLite, all rebuildable from files)

```sql
facts          (FTS5 multi-col bm25 w/ tokenchars '-_./:@#'  [a908-proven] + vec0 float[384] real MiniLM Q8)
entity, entity_links(fact_id, entity_id)          -- inverted entity index (Mem0/Hindsight-proven)
numeric_ledger (facet_key, value, unit, occurred_at, session_id, supersedes)  -- Design A innovation
sessions       (session_id, date, digest)         -- Design B innovation
contradiction_pairs (fact_a, fact_b, facet_key)   -- Design B innovation
instructions   (topic_keys[], text, session_id)   -- Design B innovation
timeline       (session_id, fact_id, ord)         -- Design B innovation
lattice edges  (entity-facet graph, temporal chain) -- Design C innovation
```

`facet_key = canonical_entity + attribute_slug` (deterministic slug of the fact's head relation, e.g. `jira.tasks_logged`, `logs.detection_rate`).

### 4.3 Query-time deterministic analyzers (fixes W2, W3)

1. **Temporal span parser** (upgrades a908's tokenizer work): parse multi-date ranges ("from Feb 15 till Mar 1", "2024-08-01 to 2024-10-22", "last spring") → `(start, end)` window. Hindsight returns a single day (W2).
2. **Query-side entity resolution** (fixes W3): alias-expand query entities against the entity table *before* the arms run, so the entity arm and boosts fire even when seeds miss.
3. **Numeric intent detector**: query mentions quantities/units/count-phrases → widen ledger arm participation.
4. **Instruction-intent detector**: "how should I", "what improvements", "remember to include" → instruction section activates.
5. **Abstention signal**: weak entity match + low lexical density + no numeric anchor → abstention path arms down (see Design A §5.4).

### 4.4 Fusion + rerank + packing (optimizations — needed, not differentiating)

- **RRF(K=60)** across arms (already our design; equal weights like Hindsight).
- **Local cross-encoder** (`ms-marco-MiniLM-L-6-v2`-class, Q8 ONNX via `@huggingface/transformers` — same runtime as our embedder, ~23MB, no new infra): rerank top-300, **date-prefixed CE input** (copy their proven trick), sigmoid normalization.
- **Multiplicative boosts** `final = CE × recency × temporal_proximity × proof` — but with **query-conditional recency** (fix W5): α_recency = 0.2 only when the query is not "state-of-affairs historical"; 0 for archaeology queries. Hindsight applies decay unconditionally.
- **Density knapsack packing** into typed sections (a051-proven allocator, upgraded from flat list to dossier — see Part 2).
- **Budget tiers** via existing `Budgets` zod: `lean` (MCP daily, ≤1.2K tok, no CE), `mid` (≤4K, CE top-100), `bench` (≤6.9K, CE top-300) — matches Mem0/Hindsight's ~6.7–7.0K regime for a fair fight, and is the *same* recall tool with a budget argument, not a benchmark-only path.

### 4.5 Spirit compliance checklist (applies to all designs)

- No daemon/Postgres/graph-DB; one `bun:sqlite` per bank. ✔
- Files canonical; every new table (ledger/sessions/pairs/lattice) is a rebuildable projection of Markdown facts. ✔
- Deterministic authority: engines compute *candidates and structure*, never answers; aggregation arithmetic is left to the answerer (we list values with dates; we never state the sum). ✔
- Small local neural models only (embedder + CE reranker, both Q8 ONNX in the existing `@huggingface/transformers` runtime). No API keys, no network at recall time. ✔
- Same 6-tool MCP surface; budget tier is a parameter, not a second product. ✔
- Attribution extended: packet sections carry refs so `retrieved ⊆ packet ⊆ consulted ⊆ applied` tracking still works. ✔

---

## 5. Design A — "FUSED STATE"

**Thesis**: beat Hindsight with its own architecture, executed on better foundations, plus the two innovations that attack their hardest weakness (W6) and our worst bleeder (abstention). Every other element is proven-by-someone; A's risk is lowest and it is the **mandatory base** for B and C.

### 5.1 Arms (6)

| Arm | Source | Candidates | Notes |
|---|---|---|---|
| semantic | vec0 MiniLM Q8 (real embeddings — the harness's dummy-vector era ends here) | 300 | fixes W1-parity: MiniLM-L6 ≈ their bge-small class |
| BM25 | FTS5 `bm25()` multi-col, a908 tokenizer | 300 | fixes W7: true IDF scoring |
| entity | inverted index, alias-expanded query entities (fix W3), boost damped `1/(1+0.001·(n−1)²)` (Mem0's proven anti-hub damping) | 200 | |
| temporal | date-window filter from span parser (fix W2) + 8-bucket coverage entry points + bounded BFS spreading (their proven pattern) | 200 | |
| **ledger** | numeric_ledger by facet_key + numeric-intent match | 100 | **INNOVATION I-1** (no competitor has this) |
| recent | last-N sessions raw facts (working memory; LIGHT-proven) | 60 | guarantees recency coverage without recency bias |

RRF(K=60) → CE rerank top-300 → boosts → knapsack into **typed packet sections**:

```
STATE      current ledger values per facet (+ prior value + date)     ← I-1
FACTS      top atomic facts
TIMELINE   ordered events (session, ord) when temporal/EO intent
SESSIONS   session digests (Design B; empty in A)
DIRECTIVES instruction ledger hits (Design B; empty in A)
CONTRA     contradiction pairs (Design B; empty in A)
MARKER     NO-EVIDENCE flag when abstention gate fires                ← I-2
```

A ships with sections STATE/FACTS/TIMELINE/MARKER active.

### 5.2 Innovation I-1: Numeric State Ledger

**What**: every extracted number lands in `numeric_ledger(facet_key, value, unit, occurred_at, session_id, supersedes)`. Queries with numeric intent return the *facet chain*: current value first, then superseded values with dates.

**Why it beats Hindsight**: their consolidation prompt forbids arithmetic/state (W6) — they can rank a fact containing "17 tasks" but cannot know it *supersedes* "12 tasks" from the prior sprint. Mem0's ADD-only store resurfaces stale values (their own docs admit knowledge_update weakness). The ledger turns "what changed" from a ranking problem into a lookup problem. On BEAM: knowledge_update, multi_session_reasoning, preference_following, and temporal_reasoning rubrics are predominantly numeric — this is the largest single attack surface in the benchmark (~35–40% of questions have numeric rubric content in our sample).

**Decision evaluation**:
- *Alternative: let the LLM consolidate values at write time (Mem0-style UPDATE).* Rejected — violates our "evidence ≠ inference" invariant (R3) and hides LLM calls inside the engine. The ledger is deterministic; the *chain* is evidence.
- *Alternative: no ledger, rely on recency boost.* Rejected — recency is exactly what W5 shows breaks old-but-relevant facts, and multi_session needs *all* component values, not just the latest.
- *Risk*: facet_key collisions (same slug, different meaning). Mitigation: facet_key includes canonical entity; ambiguous slugs fall back to plain FACTS section. Deterministic, auditable.
- *What would falsify*: if bench runs show ledger sections crowding out FACTS within 6.9K tokens without category gains, cut budget share.

### 5.3 Innovation I-2: Abstention gate (calibrated emptiness)

**What**: deterministic pre-decision on packet composition. Gate inputs (all engine-local): best CE score, entity-arm hit count, lexical arm max score, numeric anchors. If all below calibrated thresholds → packet = `MARKER: no relevant memory found for this query` + at most 2 lowest-risk candidate facts (for the answerer to inspect and decline), instead of a full dossier.

**Why it beats Hindsight**: they always fill `max_tokens` with something; their rerank fallback even synthesizes scores to keep the pipeline meaningful. Abstention questions reward the opposite behavior. Our honest 60% on abstention came *despite* flooding; a gate targets ~85%.

**Decision evaluation**:
- *Alternative: answer-side fix (prompt the answerer to say "no info")*. Necessary but insufficient — the judge can see the model ignoring noise only if the noise is actually withheld. Retrieval-side emptiness is the honest mechanism; it also serves real users (a memory system that returns garbage on a miss trains the host to distrust it — R6).
- *Risk*: over-abstention on genuinely-hard queries. Mitigation: gate is two-stage (soft: shrink dossier; hard: full emptiness); thresholds are config, benchmarked on held-out non-BEAM paraphrase fixtures first.
- *What would falsify*: abstention accuracy rising while other categories fall → gate too aggressive; recalibrate.

### 5.4 Design A decision log (summary)

| Decision | Chosen | Over | Why |
|---|---|---|---|
| Embedder | keep MiniLM-L6-v2 Q8 | bge-large / >100M models | spirit (same pinned runtime), parity with Hindsight's small embedder; upgrade is benchmark-gated later (R9) |
| CE reranker | local ms-marco-MiniLM class Q8 | no-CE / API reranker | proven +21% class of gain; local, deterministic, same runtime; budget-tiered so daily MCP stays lean |
| Candidate generation | 6 arms + RRF | 2 arms | arm consensus is Hindsight/Mem0-validated; our arms add ledger+recent |
| Packet shape | typed sections | flat list | required by I-1/I-2; also the bridge to B |
| Recency | query-conditional | unconditional decay | fixes W5 without losing fresh-fact priority |
| BM25 | FTS5 bm25 + tokenchars | ts_rank_cd copy | strictly better (W7) and already proven in a908 |

### 5.5 Design A predicted scorecard (hypothetical — harness decides)

Per-category honest-judge estimates, 10M: IE 80–85 · KU 70–78 · MS 60–70 · PF 60–70 · TR 55–65 · EO 35–45 · S 45–55 · CR 50–60 · IF 40–50 · ABS 75–85 → **overall ≈ 58–66**. Clears Mem0 comfortably; touches Hindsight's 64.1 at the top of the range but does not *reliably* clear it. That is the point of B and C.

---

## 6. Implementation sequencing (A)

1. Real-embedder harness upgrade (can't-cheat: LLM answer + judge) — blocks everything, since A's numbers are meaningless without it.
2. Boundary fact extraction adapter (harness-side, exported `recall()` only).
3. Entity index + alias expansion + span parser + true-BM25/tokenchars port.
4. CE reranker module + budget tiers + query-conditional recency.
5. Ledger + abstention gate + typed sections.
6. Full 10M run → then 1M.

Worktrees: A lands as one lineage; B and C (Part 2) branch from A's tree so their deltas stay attributable.
