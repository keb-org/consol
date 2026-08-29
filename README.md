# consol

> Local, inspectable memory and experience evidence for MCP agents.

[![npm version](https://img.shields.io/npm/v/@kryat/consol.svg)](https://www.npmjs.com/package/@kryat/consol)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AI assistants often repeat mistakes because transcripts blur five different things: source evidence, explicit memory, one task case, reusable experience, and successful application. Consol keeps those distinctions visible instead of treating every recalled sentence as learned truth.

## What ships

- **Local canonical truth** — Markdown notes and JSONL journals under one vault. SQLite, FTS5, and vectors are disposable indexes.
- **Bounded hybrid recall** — exact IDs, FTS5/BM25, optional pinned MiniLM vectors, reciprocal-rank fusion, filtered wiki-link expansion, compact 10/20/30 candidate targets, and UTF-8 byte-bounded reads.
- **Host reranking** — MCP returns descriptors and opaque refs. Host model chooses relevant candidates and reads detail; Consol does not add an LLM call to normal retrieval.
- **Separate attribution** — retrieved, packet-included, consulted, explicitly applied, and evaluated outcome are distinct durable events. Retrieval alone never means application or success.
- **Conservative reflection** — runner output is validated against exact evidence snapshots, packet refs, current target hashes, ownership, and protected core. Failed reflection stays retryable.
- **Outcome-gated activation** — inferred notes start as candidates. Internal `staging → active` transition requires successful explicit applications from at least two independent root sources.
- **Audit and rollback** — semantic changes store source refs, before/after hashes, runner metadata, and rollback snapshots. Rollback is itself audited; created candidate notes can be removed and restored through revision rollback.
- **Six MCP tools** — `recall`, `read`, `remember`, `record`, `forget`, `send`.
- **Obsidian-native links** — canonical Markdown wiki links form graph. Consol generates no alternate graph or Canvas and never rewrites links to fake prominence.

No daemon, Docker, Redis, Postgres, or graph database required.

## Install

Ask compatible host to follow setup specification:

```text
Read https://raw.githubusercontent.com/keb-org/consol/main/SETUP.md and set up consol memory for this environment.
```

Or run package directly:

```bash
bunx @kryat/consol@latest setup --vault <path> --agent <id>
```

Configure one MCP server and pass `agent` per tool call when multiplexing banks. Full instructions: [SETUP.md](SETUP.md).

## Typical loop

1. Host calls `recall` before substantive work.
2. Host reranks compact descriptors and calls `read` for plausible refs.
3. Work runs using current environment and tools.
4. Host calls `record` with observable outcome, evaluator, and only guidance actually applied.
5. Scheduled or manual `consol reflect --once` stages evidence-backed candidate updates.
6. Later independent successful applications can validate transfer; code does not infer success from retrieval frequency.

## MCP limits

MCP tool instructions can encourage recall and recording. MCP alone cannot inspect hidden reasoning, intercept every turn, force tool calls, know whether returned advice was applied, or run while host is closed. Reliable capture or scheduling needs host rules, hooks, or OS/host scheduler support.

## Storage

```text
vault/
  vault.json
  agents/<agent>/
    agent.json
    core/
    memories/
    cases/
    experiences/
    skills/
    evidence/
    jobs/
    audit/
    index.sqlite       # derived; safe to rebuild
  teams/<team>/
```

Common and configured secret forms are rejected from durable assertions, evidence, messages, and reflection proposals. Recall responses and usage logs omit raw query text; usage stores packet/ref attribution only. Agent and attached-team ownership is validated before recall/read. `forget` is two-phase and scrubs matching private text derivatives. It deletes an explicitly referenced, hash-named binary blob only when no surviving parsed JSON/JSONL record references that hash; binary bytes are never rewritten. A content-free receipt is appended to `audit/erasures.jsonl`.

## Current limitations

- Host compliance with recall/read/record protocol is best-effort unless host supplies lifecycle hooks.
- Reflection does not yet prove citation entailment, recursive-contamination freedom, or semantic lineage independence beyond explicit root-source activation checks.
- No published scale or task-success benchmark yet. Design targets are not performance claims.
- Vector retrieval degrades explicitly to lexical-only when model or `sqlite-vec` is unavailable.
- Canonical multi-file reflection rollback handles caught failures; power-loss crash transactions remain future work.

Runnable checks:

```bash
bun test
```

```bash
bun run typecheck
```

## License

MIT © Kryat
