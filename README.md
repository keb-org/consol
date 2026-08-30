# consol

> Local, inspectable memory engine with compounding knowledge transfer for MCP agents.

[![npm version](https://img.shields.io/npm/v/@kryat/consol.svg)](https://www.npmjs.com/package/@kryat/consol)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Most agent memory frameworks just dump raw transcripts into a vector DB. They burn 5–15k tokens per search, suffer high query latency, and when the agent encounters an unseen task, it fails completely.

**Consol** is a 100% local, high-performance MCP memory server that enables **Compounding Knowledge Transfer** — allowing agents to learn like humans by transferring principles across domains.

---

## The Core Innovation: Compounding Knowledge Transfer

Standard RAG searches for direct keyword or embedding overlaps. If you teach an agent to grow 🍌 **banana** and 🍓 **strawberry**. When tasked with 🍉 **watermelon**, standard RAG returns empty or irrelevant matches.

Consol operates on an **abstraction hierarchy**:

$$\text{Principle} > \text{Pattern} > \text{Specific}$$

1. **Lineage Indexing**: When an agent solves multiple tasks, Consol distills the shared heuristics (e.g. deep irrigation, root moisture retention, soil balancing).
2. **Novelty-Weighted Transfer Boost**: When lexical coverage is low (an unseen task like 🍉 **watermelon**), Consol automatically boosts high-abstraction principles derived from multiple distinct root experiences (🍌 + 🍓).
3. **Compounding Capability**: Every validated lesson becomes a reusable prior for all future tasks. The agent gets exponentially smarter over months and years with **zero retraining**.

---

## Why Consol Crushes Everything Else

- ⚡ **10x Faster**: **~30ms** warm query latency (local Q8 `sqlite-vec` + FTS5 BM25, zero cloud API calls).
- 💰 **5x Token Savings**: Bounded candidate descriptors (**<1k tokens/recall** vs 5–10k in naive RAG).
- 🔍 **Zero Black Box**: Plain Markdown notes + `[[wikilinks]]`. Open the vault in **Obsidian** to see your agent's knowledge graph expand live:

- 🔒 **100% Local & Inspectable**: Back up to Git, edit notes by hand, zero Docker/Redis/cloud DBs.
- 👥 **Multi-Agent Multiplexing**: Switch between specialist banks (e.g. `coder`, `researcher`, `architect`) in one MCP server.
- 🛡️ **Outcome-Gated Evolution**: Inferred experiences start as `candidate`. Promoted to `active` only after 2 independent successful runs in production.

---

## 30-Second Setup

Paste this prompt to your AI coding agent (Claude Code, Cursor, Codex) — customize the options to your liking:

```text
Read https://raw.githubusercontent.com/keb-org/consol/main/SETUP.md and set up consol memory for this environment:
- Vault: <default: ~/.consol-vault>
- Agents: <default: jarvis>
```

Your agent will automatically install the package, initialize your local vault, configure multi-agent routing, wire the MCP server, and ask follow-up questions to customize additional agent specialists or automated reflection. Zero manual configuration.

---

## License

MIT © [Kryat](https://github.com/keb-org)
