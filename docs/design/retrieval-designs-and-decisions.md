# Beating Hindsight on BEAM 10M — Part 2: Designs B & C, Decisions, and Why Optimization Alone Cannot Take #1

Status: proposal (hypothetical; unproven until run through the can't-cheat harness)
Date: 2026-08-30
Companion: [beat-hindsight-1-evidence-and-foundation.md](beat-hindsight-1-evidence-and-foundation.md) — read first for corpus anatomy, Hindsight teardown (W1–W8), shared substrate, and Design A

---

## 0. Why this document exists

Part 1 proved that Design A ("Fused State" — better arms + cross-encoder + numeric ledger + abstention gate) *closes* the gap to Hindsight's 64.1, with a predicted 58–66 range that overlaps but does not reliably clear it. The user asked for the opposite of a close call: **three designs that each hypothetically claim #1, with effort spent on innovations (new structure), not just optimizations (better scoring of the same structure).**

This document delivers Designs B and C as *increments on A*. Every optimization that can be copied from Hindsight is already inside A — B and C therefore do not optimize A harder. They add structure Hindsight does not have, each attacking a disjoint set of categories. The thesis is: **you beat a system by building the memory it chose not to build.**

---

## 1. The optimization ceiling — why copying Hindsight is not enough

Hindsight's stack is already near-optimal *for what it indexes*. Their RRF(K=60), cross-encoder rerank with date injection, and multiplicative boosts are load-bearing (≈+21% class of gain) and we subsume them in the shared substrate. Copying them well gets us to parity — not past it.

What remains is **structural**: categories where no ranking of atomic facts suffices.

| Category failure mode | Why ranking faits cannot fix it | What structure is missing |
|---|---|---|
| summarization (23% honest) asks for *session-level themes over a date window* | facts are per-turn; a summary is not a top-k fact, it is a compression of many facts | session digests |
| event_ordering (35%) asks for *exactly 20 items in order* | a set has no order; the answer needs a timeline | ordered timeline projection |
| instruction_following (25%) asks for *user's meta-instructions about answer shape* | instructions are not facts about the world | instruction ledger |
| contradiction_resolution (33%) asks for *both sides of a polarity pair* | single-fact ranking returns the best fact; the task needs the pair | contradiction pair index |
| multi_session_reasoning (51%) aggregates *across sessions* | needs grouping by session/facet, not flat top-k | session + facet grouping |
| preference_following (25%) needs *latest preference per facet* | needs per-facet latest, not global recency | facet latest-state |

All six map to structure Hindsight has no table for. Optimizing CE batch size or BM25 `k` cannot create a digest or a timeline — they can only reorder noise. This is why B and C are *innovations*.

The shared ritual phrase: **add a table, not a weight.**

---

## 2. Design B — "CRYSTALLIZED DOSSIER"

### 2.1 Thesis

Beat Hindsight by giving the answerer what Hindsight never gives it: **a query-filtered, ordered, typed dossier** — not a flat fact list. Where Hindsight returns "top-k memories," B returns a *crystallized view* over the session graph: session digests for the window, timeline-ordered events, instruction facets, and contradiction pairs — all rebuilt deterministically from the same canonical facts, all query-filtered.

B directly attacks the four lowest-scoring categories in our honest runs (summarization, event_ordering, instruction_following, contradiction_resolution) — a combined 80 questions (40% of the benchmark) where Hindsight's stack has no structural answer.

### 2.2 What B adds on top of A (delta, not replacement)

All of A's 6 arms, RRF, CE rerank, ledger, and abstention gate remain. B adds **four query-conditional projections**, each a deterministic SQLite view materialized at recall time, each feeding its own packet section.

#### Projection 1 — Session digests (attacks summarization + multi_session)

```sql
-- sessions(session_id, date, digest, fact_count)
-- digest = deterministic extractive summary of the session's facts
-- produced at ingest: top-5 facts by intra-session centrality (entity overlap)
--                      + one-line template "Session {date}: {entities} · {k} facts"
-- query path: window = span_parser(query) || all sessions; rank digests by BM25/semantic
```

*Why it works for BEAM*: summarization rubrics are phrases like "you explored various vector indexing strategies" — they are *session-level* claims. Returning a session digest that already contains that phrase is a direct hit; returning 20 scattered facts forces the answerer to synthesize under token pressure.

*Construction — deterministic, no LLM*:
- At ingest, after facts for a session are committed, compute per-fact entity-overlap degree within the session graph. Take top-3 facts verbatim.
- Append a one-line session header derived from the session's entity histogram (no generation).
- Digest length capped at 400 chars; total sessions table is ~100 rows per chat (verified §1.1: exactly 100 sessions), so query-time ranking is trivial.
- This is LIGHT's "scratchpad" idea *without* an LLM inside the engine — the summarization happens at ingest via selection, not generation.

*Spirit mapping*: session digests are a **typed projection** of facts (like Hindsight's observations, but deterministic and per-session). Files remain canonical; digests are rebuildable. This is the "observation" concept made to serve summarization rather than proof-count.

#### Projection 2 — Ordered timeline (attacks event_ordering + temporal_reasoning)

```sql
-- timeline(session_id, fact_id, ord, date)
-- ord = global order key = (session_date, batch_index, turn_index)
-- query path: when temporal/EO intent detected, return facts in timeline order
--             as a single ordered section, not interleaved with relevance ranking
```

*Why it works*: event_ordering demands "MUST mention exactly 20 items in order." A relevance-ranked list has no stable order. An ordered timeline *is* the answer's skeleton — the answerer copies the order.

*Construction*:
- `ord` is already free from BEAM's batch structure (we verified `->-> b,t` markers and `time_anchor` per batch). In prod, `ord = mentioned_at`.
- Query-time: filter timeline to the parsed window (or all if no window), return up to 20 items in `ord` order. This section bypasses CE reranking — order *is* the signal.
- The timeline section renders as `1. [2024-07-01] …` so the answerer can quote the ordering directly.

#### Projection 3 — Instruction ledger (attacks instruction_following)

```sql
-- instructions(topic_key, text, session_id, date)
-- topic_key = entity-derived slug of the instruction's subject (e.g. rag.ingestion, rag.query_latency)
-- populated by deterministic cue pass: "remember to…", "make sure to include…",
--   "when you answer…", question-form instructions
-- query path: topic_key overlap with query entities → instruction section
```

*Why it works*: instruction_following rubrics demand answer-shape compliance ("must include latency numbers"). Those directives live in user messages as meta-instructions. Without a dedicated index, they drown in fact noise. A separate ledger surfaces them as directives, not facts.

*Why deterministic cues, not an LLM classifier*: the cue set is small and high-precision; a classifier would add latency and false positives where falsely surfacing an instruction is worse than missing one (it mis-directs the answerer).

#### Projection 4 — Contradiction pair index (attacks contradiction_resolution, fixes W8)

```sql
-- contradiction_pairs(facet_key, fact_a, fact_b, polarity_a, polarity_b, session_a, session_b)
-- populated deterministically: same facet_key, opposite polarity, different sessions
-- query path: when query contains contradiction cues ("have I…", "did I ever…",
--             or when facet has a pair) → CONTRA section with both facts verbatim
```

*Why it beats Hindsight*: their consolidation LLM resolves contradictions *once at write time* within a single batch — cross-batch contradictions (the benchmark's design) survive. Our pairs are query-time, exhaustive, and return both sides — exactly what the rubric grades ("you mentioned X" *and* "you said never X" plus "there is contradictory information").

*Polarity*: deterministic cue pass as in §4.3 — "never", "didn't", "no", "not" near the facet mention → `negate`; otherwise `assert`. Same-session negations are excluded (they are self-corrections, not contradictions).

### 2.3 Packet shape (B)

```
STATE      current ledger values per facet (+ superseded chain)
FACTS      top atomic facts (CE-reranked)
TIMELINE   ordered events for the window          ← new, bypasses CE
SESSIONS   ranked session digests for the window  ← new
DIRECTIVES instruction hits for the topic         ← new
CONTRA     contradiction pairs for the facet      ← new
MARKER     abstention flag (when gate fires)
```

Each section has its own budget slice (knapsack per-section, then global). No section starves another — the harness can always answer from the right section even when another section is full.

### 2.4 Design B decision log

| Decision | Chosen | Over | Why | Risk & mitigation |
|---|---|---|---|---|
| Digest construction | extractive top-k per session (entity centrality) | LLM abstractive summary | spirit (no LLM in engine), deterministic, rebuildable, fast (100 rows) | less fluent than LLM summary; answerer supplies fluency — retrieval supplies evidence |
| Timeline ordering | global `ord` bypass CE | CE-reranked timeline | order is the answer; reranking destroys it | timeline section is query-conditional — only when EO/temporal intent detected |
| Instruction detection | cue set + topic_key | LLM classifier | precision > recall (false instruction is catastrophic) | log cue hit rate; widen set only if IF remains low |
| Contradiction scope | cross-session pairs only | include same-session | same-session negations are corrections, not contradictions | verified from BEAM: contradictions are planted across sessions |
| Budget allocation | per-section knapsack | global knapsack | guarantees dossier shape; prevents FACTS starving TIMELINE | section caps are config; bench run can rebalance |

### 2.5 Predicted scorecard (hypothetical)

On top of A's 58–66, B adds primarily to the 40% it targets:

- summarization 45–55 → **65–80** (+20)
- event_ordering 35–45 → **55–70** (+20)
- instruction_following 40–50 → **60–75** (+20)
- contradiction_resolution 50–60 → **65–80** (+15)

Overall: **65–74**. The low end already clears Hindsight's 64.1; the high end is #1 with margin. B's risk is that EO/TIMELINE gains depend on the answerer actually copying order — a prompt detail, not a retrieval guarantee. The packet *enables* the right answer; it cannot *force* it.

---

## 3. Design C — "LATTICE"

### 3.1 Thesis

Beat Hindsight by replacing their 1-hop star graph with a **lattice** — a multi-hop, typed entity-facet graph over sessions — and by making numeric state and contradiction *first-class citizens of the graph*, not afterthoughts. Where Hindsight expands one hop from seeds, C walks the lattice; where Hindsight stores values as text inside facts, C stores them as typed edges the query can traverse.

C attacks the reasoning-heavy categories: multi_session_reasoning, temporal_reasoning, knowledge_update, preference_following — the questions that require *hopping* (entity → facet → session → related entity) and *state reasoning* (what is current vs superseded).

### 3.2 The lattice

Nodes: `entity` and `facet` (entity+attribute). Edges:

```
entity --[mentioned_in]--> session        (when the entity appears in the session)
facet  --[state_at]------> session        (numeric ledger entry in that session)
facet  --[supersedes]----> facet          (ledger chain)
session --[next]---------> session        (temporal chain, free from time_anchor order)
entity --[co_mention]----> entity         (same fact mentions both; weight = co-occurrence count)
facet  --[contradicts]---> facet          (polarity-opposite pair)
```

All edges have `weight` (co-occurrence count, recency, or 1.0 for structural) and `session_id` for temporal filtering. The graph has at most ~100 session nodes + ~few-thousand entity/facet nodes per chat — tiny.

### 3.3 Spreading activation (fixes W4)

Where Hindsight does `tanh(entity_count×0.5) + semantic_kNN + causal` in one hop from 20 seeds, C runs **personalized PageRank / spreading activation over the lattice**:

```
seeds = alias-expanded query entities + ledger facets with numeric intent
        + session nodes in the parsed window

scores_0[seed] = 1.0  (or BM25/semantic score for seed facts)
for iter in 0..3:   // 3 hops, alpha=0.15 (small teleport keeps walk local)
  scores_{t+1} = alpha * scores_0 + (1-alpha) * propagate(scores_t, edges)
  propagate = sum over incoming edges: score[neighbor] * edge_weight / out_degree
```

- 3 iterations, alpha 0.15 — shallow and local, intentionally. BEAM reasoning is 2–3 hops (entity → facet → session → entity), not deep graph reasoning.
- Edge types have type-specific weights: `state_at` and `contradicts` weighted higher than `co_mention` (typed signal > coincidental signal).
- Output: ranked *facts* via fact→facet→entity→lattice mapping, merged with the 6 arms via RRF (lattice is a 7th arm).

*Why this beats Hindsight's graph*: their arm is 1-hop from seeds with no propagation — a fact two hops away (entity A mentioned with B, B mentioned with query entity C) is unreachable. Multi_session questions ("how many documents across ES and Solr?") require exactly this: ES facts → session → Solr facts. The lattice makes that a 2-hop walk.

### 3.4 Typed numeric reasoning (deepening A's ledger)

A's ledger stores values; C's lattice stores them as **typed, traversable state**:

- Queries like "how many total when combining X and Y" activate *two* facet seeds; the lattice walk surfaces both facet chains; the packet's STATE section lists both chains with dates and units — the answerer sums.
- "days between X and Y" is not an arithmetic task for the engine (spirit: we list, answerer computes) — but the lattice ensures *both endpoints* rank highly via session-proximity edges, whereas pure semantic ranking may surface only one.
- Knowledge_update's supersession is a graph edge: the current value is the *sink* of the supersedes chain — unambiguous, not rank-dependent.

### 3.5 Packet shape (C)

```
STATE      current ledger chains per facet (with superseded history)
FACTS      top atomic facts (including lattice-surfaced facts)
LATTICE    hop path for the answerer's reasoning trace
           e.g. "ES --state_at--> 2024-08 (1.2M docs) --next--> 2024-09 (0.6M docs)"
TIMELINE   ordered events (when temporal intent)
CONTRA     contradiction pairs (lattice edge)
MARKER     abstention flag
```

The `LATTICE` section is novel: it gives the answerer a *reasoning trace* ("X connects to Y via session S") that plain facts do not. This is the closest we come to Hindsight's "observations" — but ours is a deterministic graph path, not an LLM synthesis.

### 3.6 Design C decision log

| Decision | Chosen | Over | Why | Risk & mitigation |
|---|---|---|---|---|
| Walk depth | 3 hops, alpha 0.15 | PPR to convergence / 1-hop | BEAM is 2–3 hop reasoning; deeper walks add noise without signal | cap iterations; weight typed edges higher than co-mention |
| Lattice size | entity+facet+session (~k nodes) | fact-level graph (~10k nodes) | session-level keeps the walk fast (<5ms) and semantically coherent; fact-level would be noisy and slow | fact→facet mapping preserves fact granularity at output |
| Numeric handling | typed edges, list values, answerer sums | engine-side arithmetic | spirit: engine never states computed answers; listing with dates is auditable | packet explicitly lists values so judge can verify |
| Contradiction as edge | lattice edge `contradicts` | text-only pair listing | lets the walk surface contradictions even when neither fact is a seed | same deterministic pair logic as B |
| Arm count | 7 (A's 6 + lattice) | replace an arm | lattice is additive signal; RRF handles it | RRF equal weights; lattice weight tuned via rerank input |

### 3.7 Predicted scorecard (hypothetical)

On top of A's base:

- multi_session_reasoning 60–70 → **70–85** (+15)
- temporal_reasoning 55–65 → **65–80** (+15)
- knowledge_update 70–78 → **75–88** (+8, deeper ledger)
- preference_following 60–70 → **65–80** (+8)
- event_ordering gets timeline benefit as in B → **55–70**

Overall: **66–75**. Slightly higher ceiling than B on reasoning-heavy categories, slightly lower on summarization/instruction (where B's dedicated projections still win). C and B are complementary — the lattice could host B's digests as session-node attributes.

---

## 4. Cross-design decision matrix

| Decision | Design A | Design B (dossier) | Design C (lattice) | Shared? |
|---|---|---|---|---|
| Arms | 6 (semantic/BM25/entity/temporal/ledger/recent) | A's 6 + 4 projection rankers | A's 6 + lattice (7th arm) | A's 6 are shared |
| RRF K | 60 equal | 60 equal | 60 equal | yes |
| Cross-encoder | local Q8, top-300, date injection | same | same | yes |
| Recency | query-conditional | same | same | yes |
| Packet | typed (STATE/FACTS/TIMELINE/MARKER) | typed + SESSIONS/DIRECTIVES/CONTRA | typed + LATTICE (+ optional SESSIONS) | A's shape is base |
| Innovation | ledger + abstention gate | + digests + timeline + instruction ledger + contra pairs | + lattice walk + typed numeric edges | B/C build on A |
| Extra tables | numeric_ledger | + sessions, instructions, contradiction_pairs, timeline | + lattice edges | A's ledger is base |
| Engine LLM calls | 0 | 0 | 0 | all 0 |
| Ingest LLM calls | 1 per batch (boundary extraction) | same | same | same harness adapter |

**One-line differentiation**: A fixes *what is ranked* (values, emptiness); B fixes *what is returned* (ordered, typed dossier); C fixes *how far ranking reaches* (multi-hop lattice). Together they cover every category; alone, each clears Hindsight only at the top of its range.

---

## 5. Spirit compliance — why none of this is benchmark maxing

Every new table is a **projection of facts that already exist as Markdown notes** — the same facts a real user would have written via `remember`. In production:

- Session digests = "what happened in session S" — useful for any agent recalling history by time.
- Timeline = ordered view of events — useful for any temporal query.
- Instruction ledger = the user's directives about answer shape — useful for preference following in prod.
- Contradiction pairs = surfacing conflicting guidance — useful for any agent deciding what to trust.
- Ledger + lattice = typed state over time — useful for any system tracking evolving values.

None of these tables reference BEAM rubrics, question types, or probing files. None are benchmark-only. The same `recall(query, budget)` serves MCP daily use and the benchmark — budget tier is the only knob, and it is the same knob Hindsight uses (`low`/`mid`/`high` mapping to recall budget).

The determinism claim: every new component is either a deterministic SQLite view, a string cue pass, or a small local neural model (embedder/reranker) — the same class already in our pinned runtime. The graph walk is arithmetic over stored weights. Nothing generates text inside the engine.

---

## 6. What would falsify each design (and what we would do)

| Design | Falsification signal (from harness) | Response |
|---|---|---|
| A | ledger crowding FACTS without KU/MS gains | cut ledger budget share; tighten facet_key |
| A | abstention gate over-firing (other cats drop) | recalibrate thresholds on held-out paraphrase fixtures; two-stage gate |
| B | timeline not improving EO (answerer ignores order) | move timeline to first packet section; add ordinal markers answerer can copy verbatim |
| B | digests not improving summarization | increase digest extractive k; try session-entity histogram phrasing variants |
| B | instruction ledger polluting non-IF queries | tighten cue set; gate DIRECTIVES section on instruction-intent detector |
| C | lattice walk adding noise (worse than no-lattice) | reduce hops to 2; raise type-weight for `state_at`/`contradicts` vs `co_mention` |
| C | lattice helping MS but hurting TR | temporal chain weight too high — decouple temporal vs causal edge weights |

---

## 7. Implementation sequencing (whole program)

```
Phase 0  harness upgrade: real MiniLM Q8 embeddings + LLM answer + LLM judge
         (blocks all measurement; no design can be scored without it)
           │
Phase 1  Design A on main: entity index, span parser, BM25/tokenchars,
         CE reranker, budget tiers, ledger, abstention, typed sections
           │  full 10M run → proves ≥58 (Mem0 cleared) or fix before proceeding
           ├──────────────────────────────────────┐
Phase 2a Design B branch (from A's tree)          Phase 2b Design C branch
         digests, timeline,                         lattice, spreading
         instructions, contra pairs                  activation, typed edges
           │                                         │
Phase 3  head-to-head on can't-cheat harness (same answerer, same judge):
         A vs B vs C vs Hindsight-OSS vs Mem0-OSS, 10M then 1M, 3 seeds each
         Report: per-category means + 95% CIs; claim #1 only if lower CI > 64.1
```

Worktree discipline: A is one lineage; B and C branch from A's commit so deltas stay attributable. No design merges to main until its lower 95% CI clears 64.1 on 10M (not point estimate).

---

## 8. Predicted leaderboard (hypothetical — harness is the judge)

| System | BEAM 10M (pred.) | 95% CI width* | BEAM 1M (pred.) |
|---|---|---|---|
| Hindsight (published) | 64.1 | — | 73.9 |
| Mem0 (published) | 48.6 | — | 64.1 |
| Honcho (published) | 40.6 | — | 63.1 |
| Consol honest today | 41.8 | — | 40.5 |
| **Design A (Fused State)** | **58–66** | ~±3.5 | 62–70 |
| **Design B (Crystallized Dossier)** | **65–74** | ~±3.2 | 68–76 |
| **Design C (Lattice)** | **66–75** | ~±3.5 | 69–77 |
| B+C combined (if merged) | 70–78 | — | 72–80 |

\* CI estimate from 10 chats × 20 Q = 200 Q; variance dominated by per-chat difficulty spread. True CI measured from harness runs.

Design A *touches* #1 at its ceiling; B and C *claim* #1 at their midpoints. A combined B+C (lattice hosting digests) is the natural post-tournament merge — but the tournament should first prove B and C independently so the winning mechanism is attributable.

---

## 9. Related work and provenance

- Hindsight source: `.research/hindsight/hindsight-api-slim` (cloned 2026-08-30, commit `37e8f…`; see `docs/research/` for pinned SHA and inspected files).
- BEAM paper: "Beyond a Million Tokens" (ICLR 2026, Tavakoli et al.) — corpus verified from `.research/BEAM/chats/`.
- Hindsight retrieval docs: `hindsight.vectorize.io/developer/retrieval` (TEMPR, RRF, CE rerank, boosts).
- Honcho BEAM report: `plasticlabs.ai/blog/research/Benchmarking-Honcho` (40.6 on 10M, methodology).
- Mem0 April 2026 pipeline: `mem0.ai/blog/ai-memory-benchmarks-in-2026` (ADD-only, entity linking, 6.7–6.9K tokens).

---

## 10. Open questions (not blockers for the designs, but needed before a paper claim)

1. **Answerer prompt sensitivity**: EO and summarization are partly answer-side; the harness's `answer_generation_for_rag` prompt must be held constant across systems and ablated (with vs without dossier sections) to attribute gains correctly.
2. **Embedder upgrade gate**: W1 (bge-small) is parity, not superiority — a larger embedder (bge-base/large) is a benchmark-gated follow-up (R9: prove on harness before adopting).
3. **1M vs 10M divergence**: Hindsight's 1M (73.9) > 500K (71.1) suggests compounding; our digests/lattice should show the same, but 1M has only 10 sessions — session-structure gains are smaller there. Expect B's edge to compress on 1M.
4. **Cost**: B's digests and C's lattice add ingest-time compute (graph build, digest extraction) — measure indexing time and packet bytes; neither should regress p50 recall past Hindsight's regime (~1s at 10M).

---

*Next step: Phase 0 harness upgrade. No design code lands until the harness can score real embeddings with an LLM judge — otherwise we repeat the dummy-vector era.*
