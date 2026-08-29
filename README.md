# consol

> **Autonomous long-horizon memory for AI agents.**  
> Give your agent the ability to remember, adapt, and learn from its own mistakes across sessions — with zero setup, zero cloud databases, and 100% local privacy.

[![npm version](https://img.shields.io/npm/v/@kryat/consol.svg)](https://www.npmjs.com/package/@kryat/consol)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## The AI Amnesia Problem

Every AI assistant starts blank every session:
- It makes the exact same mistake you corrected yesterday.
- It forgets your project preferences, habits, and past decisions.
- Traditional "memory" solutions dump massive chat histories into cloud vector DBs — bloating token costs and making the model slower and confused.

`consol` gives your agent an autonomous, self-healing memory vault stored as clean Markdown files on your local disk.

---

## How to Install

Do not configure JSON files manually. Drop this single instruction into your AI assistant (Claude Code, Cursor, Windsurf, Cline, Roo Code, etc.):

```text
Read https://raw.githubusercontent.com/keb-org/consol/main/SETUP.md and set up consol memory for this environment.
```

Your agent will inspect your setup, pick optimal storage paths, write the MCP config, and bootstrap its own memory vault.

Full specification: [SETUP.md](SETUP.md).

---

## How It Works

* **Self-Bootstrapping**: On first boot, the agent auto-creates its workspace and runs local embedding models. No manual initialization required.
* **Bounded Context**: History can scale to 100,000 cases; the agent only loads the precise 2–3 relevant sentences, keeping prompts lean and fast.
* **Readable Markdown Vault**: All memory lives as plain Markdown and JSON on your machine. Open it in Obsidian, VS Code, or Notepad anytime.
* **True Learning**: Distinguishes between fleeting observations, durable facts, and reusable experience from past successes and failures.

---

## License

MIT © Kryat
