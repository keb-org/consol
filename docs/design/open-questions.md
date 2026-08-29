# Open Questions and Calibration Backlog

Status: unresolved calibration questions that need measurement — not spec gaps
Last updated: 2026-08-28

These block final numeric tuning and strong claims, not the architecture itself.
Close each one with an experiment, then update architecture/ADRs and add a
regression test.

## Calibration (need measured value to finalize)

### Q1. RRF and per-arm caps
Current: equal lexical/vector weights, RRF `k=60`, independent caps before
fusion. Need ablations over per-channel top-N, RRF `k`, weights, and one-hop vs
two-hop expansion under equal packet budget. Keep candidate set bounded and
inspectable; no learned reranker until hybrid fails measurably.

### Q2. Core and packet budgets
Current: core ~600–900 tokens (ceiling ~1,200 tokens / 4 KiB), normal packet
~1,200 tokens (ceiling ~3,000), L2 chunk ≤4 KiB, typed quotas. Tune only if
ablation shows larger core/packet beats retrieval at equal cost.

### Q3. Lifecycle thresholds
Candidate → staging needs ~2 independent supports; active needs ~3 successful
applied uses or held-out gain; core needs repeated broad value per byte.
Calibrate against false-promotion, delayed activation, negative transfer, and
value per byte. Statuses stay; numbers move.

### Q4. Utility suppression
When does lowering retrieval utility / suppressing from normal `recall` help vs
hurt? Measure duplicate compaction, stale-scope suppression, negative-transfer
penalty, and reactivation by exact/history cue or later success. No age-only
decay.

### Q5. Chunking
Heading-aware Markdown + bounded JSONL windows with stable IDs (`id + section +
source hash`). Verify heading parsing, overlap, chunk map coverage, and L2
recovery across large notes/events.

### Q6. Token estimation
Conservative byte/character heuristic with hard byte ceilings remains valid even
if a host tokenizer is available. Never label heuristic as exact.

## Gates for optional behavior (do not implement without passing gate)

### Q7. Caveman packing
Already-gated: `context.pack()` only after bounded RAG at packet boundary,
connected and lossy, `deferredId`s preserved, exact fields outside lossy text.
Enable only if task outcome + recovery fidelity + exact-field fidelity + bytes
all beat no-Caveman under equal budget. Default: off.

### Q8. Each human-inspired mechanism
Every inspired behavior (spacing/interleaving, mechanism-neutral mismatch
review, source monitoring, staged validation, access suppression) ships only if
equal-model, equal-budget held-out ablation shows task gain without unacceptable
negative transfer. Otherwise delete it.

## Resolved (do not reopen without new evidence)

- No model-weight training claim; learning = held-out outcome gain.
- No Docker / Postgres / pgvector / Redis / graph DB / web UI / required daemon.
- No vector service — vault-local q8 `Xenova/all-MiniLM-L6-v2` is baseline; offline after first download.
- Obsidian is optional editor; filesystem is sole durable truth; `index.sqlite` is disposable.
- Exactly six MCP tools (`recall / read / remember / record / forget / send`); admin stays CLI/internal.
- Hybrid is BM25 (FTS5) + `vec0` cosine fused by RRF; similarity never proves support.
- Private banks are structural; team knowledge is explicit and reviewed; peer echo counts once.
- Recall is read-only; mismatch is eligibility, not proof of wrong memory; mechanism claims are excluded.
- Forgetting is accessibility/suppression/archive first; confirmed `forget` alone deletes.

## How to close a question

1. Record experiment, corpus, config, and seed-like inputs.
2. State result, limitations, and thresholds.
3. Update `architecture.md` and `rationale.md` (ADR).
4. Add/adjust evaluation fixture.
5. Move conclusion into Resolved or delete the obsolete alternative.
