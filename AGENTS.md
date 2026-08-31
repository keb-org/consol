# AGENTS.md — Agent Operating Standards & Guidelines

Consol is a local, inspectable memory engine and experience distillation harness for AI agents (MCP server, SQLite disposable index projections, Bun runtime).

This document is the Single Source of Truth (SSOT) for all AI agents collaborating on the Consol codebase.

## 1. Mandatory Architecture & Engineering Rules

1. **Path Imports**:
   - Always use `@/` alias for imports within `src/` (e.g. `import { recall } from "@/retrieval";`), `@package` for `package.json`, and `@lab/` for `lab/`.
   - Never use relative parent traversal (`../` or `../../..`).

2. **SOLID Domain-Driven Hierarchy**:
   - Every file must have a single responsibility, readable in under 3 minutes, under 300 LOC.
   - Storage model: Markdown canonical truth on disk (vault) + disposable SQLite index projections.
   - Deleting `index.sqlite` causes zero knowledge loss; re-indexed automatically on startup.
   - Code structure:
     - `src/core/`: Constants (`RRF_K=60`), config, identity sanitization, parsing helpers, security redaction.
     - `src/storage/`: Vault atomic file I/O, file locks, erasure engine, SQLite index subsystem (`src/storage/index/`).
     - `src/retrieval/`: Search orchestrator (`recall.ts`), RRF ranking + 3× ledger weighting, wire packets, transfer scoring.
     - `src/lifecycle/`: Mutations (`remember`, `record`), reflection job runner, proposal validator, FSM state transitions.
     - `src/server/`: MCP server protocol adapter with compact schema definitions (`mcp.ts`).
     - `src/cli/`: CLI subcommands (`main.ts`).
     - `lab/`: Observability, live MCP watcher (`lab/observer/`), benchmarks (`lab/bench/`), telemetry (`lab/telemetry.ts`).

3. **Protocol Co-Design over Hardcoded Dictionaries**:
   - Zero English/Vietnamese hardcoded string dictionaries or stopword bloat.
   - Use LLM prompt-protocol co-design and structural signals (digits `\d`, currencies `$€£¥₫`, versions `v1.2.3`, ISO dates `[Date: YYYY-MM-DD]`, quoted anchors `"Sprint 1"`).
   - Cross-lingual search handled via `access.aliases/entities/facets/likelyQueries` hidden routing surfaces.

4. **Code Complexity & Style**:
   - YAGNI: deletion before addition. No unrequested abstractions, no one-implementation factories, no premature config.
   - Self-explaining code over excessive comments. Add comments only when explaining non-obvious architectural rationale (WHY).

## 2. Continuous Memory Protocol (Consol MCP)

1. **BEFORE Substantive Action**:
   - Call `recall(query, agent="linus")` with dense 2-6 content words and quoted anchors (e.g., `recall('"v1.2.0" configuration postgres', agent="linus")`).
   - Read returned refs via `read(ref)`.

2. **MID-Task Context Branching**:
   - Call `recall` again on assumption failures, tool errors, branch changes, or missing domain context.

3. **AFTER Action (Evidence Append)**:
   - Call `record(kind="outcome", data={evaluator: "pass"|"fail", outcome: "success"|"failure"}, refs=[...])` to supply evidence for downstream distillation.

## 3. Hermetic & Isolated Testing Invariant

- All unit tests must pass hermetically offline. Never hit external networks or download live HuggingFace weights during test runs.
- Use `setEmbedderForTests` mock fixtures for deterministic test execution.
- Always run `bun test` and `bun run typecheck` to verify zero regressions.
