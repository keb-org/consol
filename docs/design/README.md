# Consol Design & Architecture Notes

Status: shipped v0.2.x boundary plus active target architecture; see [architecture](architecture.md)
Last updated: 2026-08-31

Local, token-efficient, inspectable memory engine and experience distillation harness for Claude Code, Codex, Claude Desktop, and other MCP hosts.

**One command** — `bun run src/main.ts serve --vault <path> --agent <default-id>` or `consol serve` — starts the Bun stdio MCP server. Optional `agent` parameter on every tool call routes across isolated agent banks (`linus`, `ilya`, etc.). Pinned local q8 embedding model (`Xenova/all-MiniLM-L6-v2`) downloads into vault-local cache on first run and runs 100% offline thereafter. Zero Docker, zero Postgres/pgvector, zero cloud lock-in.

| Doc | Purpose |
|---|---|
| [Architecture](architecture.md) | SOLID domain hierarchy, multi-arm RRF, ledger intent gating, lifecycle state machine, MCP protocol |
| [Rationale](rationale.md) | Governing principles, prompt-protocol co-design vs dictionary bloat, ADRs |
| [Retrieval Designs](retrieval-designs-and-decisions.md) | RRF fusion, 3× ledger arm, access_v1 hidden routing surfaces, typed anchors |
| [Evaluation](evaluation.md) | BEAM benchmark harness, honest evaluation, lab observer & telemetry |
| [Open questions](open-questions.md) | Unresolved calibration questions and empirical frontiers |

## Core Invariants

```text
evidence != memory != case != experience != procedure != core
private bank != team knowledge
retrieved != consulted != applied != successful
one success != learned
similarity != factual support
repetition / peer echo != independent corroboration
retrieval failure != source erasure
model confidence != epistemic support
protocol co-design > hardcoded dictionaries
```

## Shipped Runtime System

- **Canonical Storage**: Markdown files on local disk (vault) are ground truth. Disposable SQLite index projections (`chunks`, `chunk_vectors`, `numeric_ledger`, `retrieval_surfaces`).
- **Code Organization**: SOLID domain-driven directory structure (`src/core/`, `src/storage/`, `src/retrieval/`, `src/lifecycle/`, `src/server/`, `src/cli/`). Absolute `@/*` path aliases with zero `../` traversals.
- **Tools**: MCP protocol tools (`recall / read / remember / record / forget`).
- **Lab & Observability**: Dedicated `lab/` tree with `lab/bench/` (BEAM suites), `lab/observer/` (live event tracing), and `lab/telemetry.ts` (agent protocol adherence).
