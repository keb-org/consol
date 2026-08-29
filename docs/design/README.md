# Long-Horizon Agent Memory

Status: master target approved; implementation follows [architecture](architecture.md)
Last updated: 2026-08-28

Local, token-efficient memory and experience for Claude Code, Codex, Claude Desktop, and other MCP hosts.

**One command** — `memory-server serve --stdio --vault <path> --agent <id>` — starts one Bun process scoped to one agent. Vault-local q8 model auto-downloads once, then retrieval runs offline. No Docker, Postgres, Redis, graph DB, daemon, HTTP server, or custom frontend.

| Doc | Purpose |
|---|---|
| [Architecture](architecture.md) | Master target: files-only truth, q8 hybrid RAG, bounded RAG, reflection, multi-agent mail, Caveman option |
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

## How it works (30 seconds)

Evidence → cases → outcome-validated experience/procedures → bounded recall packets → future behavior. Files are durable truth (Markdown + JSONL + JSON + blobs, Obsidian-readable). SQLite is the disposable index (FTS5 + `vec0` cosine via `sqlite-vec`, links, hashes). Six tools: `recall / read / remember / record / forget / send` — everything else is CLI/internal.

## Retrieval

Hybrid: exact IDs first, then bounded BM25 and `vec0` vector search capped independently and fused with RRF `k=60`. One-hop wiki-link expansion, type/lineage/outcome diversity, typed quotas. Progressive disclosure: `L0` ref + summary, `L1` compact overview, `L2` bounded chunk via `read`. Hard packet/core ceilings hold as history grows.

## Learning (lean, not literal neuroscience)

Fast encode (append evidence, close bounded cases) → slow consolidation (interleaved replay → scoped experience, procedures only after repeated reuse, assimilation vs accommodation) → staged validation on independent cases. Access can decay/suppress/archive; only confirmed policy/`forget` deletes. Source lineage survives relay and rebuild; peer echo counts once; retrieval never mutates truth. Human-memory ideas are functional hypotheses — keep only what proves held-out value.

## Change discipline

Measure first. A new dep/service/tool survives only if equal-model, equal-budget evaluation shows task success improves. Update this doc set together; no silent scope creep.
