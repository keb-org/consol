# Consol Design Notes

Status: shipped boundary plus measured target; see [architecture](architecture.md)
Last updated: 2026-08-29

Local, token-efficient memory and experience evidence for Claude Code, Codex, Claude Desktop, and other MCP hosts.

**One command** — `consol serve --vault <path> --agent <default-id>` — starts one Bun stdio MCP process. Optional `agent` on each tool call routes multiple private banks. Vault-local q8 model auto-downloads once when vectors are available, then retrieval runs offline. No Docker, Postgres, Redis, graph DB, required daemon, or custom frontend.

| Doc | Purpose |
|---|---|
| [Architecture](architecture.md) | Shipped boundary and target: files-only truth, q8 hybrid RAG, bounded retrieval, reflection, multi-agent mail, Caveman option |
| [Rationale](rationale.md) | Principles, ADRs, rejected alternatives, when to change them |
| [Evaluation](evaluation.md) | What proves learning vs storage; gates for embeddings/scheduler/Caveman |
| [Open questions](open-questions.md) | Unresolved calibration questions that need measurement |

## Invariants

```text
evidence != memory != case != experience != procedure != core
private bank != team knowledge
retrieved != consulted != applied != successful
one success != learned
similarity != factual support
repetition / peer echo != independent corroboration
retrieval failure != source erasure
model confidence != epistemic support
compressed context != source truth
```

## How shipped flow works

Explicit assertions become Markdown; observations/outcomes become JSONL evidence; reflection may create or update candidate notes; recall returns bounded descriptors; host reads opaque refs and explicitly records applied guidance plus outcome. SQLite is a disposable FTS5/optional-`vec0` index. Six tools: `recall / read / remember / record / forget / send` — admin stays CLI/internal.

## Retrieval

Exact IDs run first, then bounded BM25 and optional `vec0` vector arms are capped independently and fused with equal-weight RRF `k=60`. Authorized one-hop wiki-link expansion and typed quotas feed adaptive 10/20/30 descriptor targets. Progressive disclosure: L0 summary, small current L1 overview/section cue, UTF-8 byte-bounded L2 pages via `read`.

## Reflection and lifecycle

Reflection currently accepts only `create`, `update`, and `skip`; invalid or empty runs remain retryable. Inferred notes start `candidate`. Explicit lifecycle transitions can stage, activate, dispute, retire, or supersede notes; activation needs two distinct successful application roots. Semantic entailment, recursive lineage checks, automatic contradiction handling, utility decay, and demonstrated task-level transfer remain target/evaluation work. Human-memory ideas are functional hypotheses, not biological claims.

## Change discipline

Measure first. A new dep/service/tool survives only if equal-model, equal-budget evaluation shows task success improves. Update this doc set together; no silent scope creep.
