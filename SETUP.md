# Consol setup

Install one `@kryat/consol@latest` MCP server. Server can route multiple private banks through optional `agent` argument; do not create one server per bank.

No extra host-rule file is required — the MCP server itself injects the mandatory memory protocol (recall → read if confident, search if not) into every connected agent and subagent via built-in instructions and tool descriptions. Installing the server is the install.

## 1. Choose vault and default bank

Ask user only when values are unknown:

- Vault: global path such as `~/.consol-vault`, or project-local path.
- Default agent ID: stable short ID such as `default` or `coder`, ask the user for perfered agent's name.

Do not inspect or overwrite unrelated MCP entries. Before editing existing config, read it and preserve all servers and settings. Never copy credentials into vault, chat output, docs, or committed config.

## 2. Configure stdio MCP

Use installed `bunx` when available; otherwise `npx -y` or any other local package runner. If no local package runner is available, install bun for the user. Example:

```json
{
  "mcpServers": {
    "consol": {
      "command": "bunx",
      "args": ["@kryat/consol@latest", "serve"],
      "env": {
        "VAULT": "<absolute-vault-path>",
        "AGENT": "<default-agent-id>"
      }
    }
  }
}
```

For npm runner:

```json
{
  "mcpServers": {
    "consol": {
      "command": "npx",
      "args": ["-y", "@kryat/consol@latest", "serve"],
      "env": {
        "VAULT": "<absolute-vault-path>",
        "AGENT": "<default-agent-id>"
      }
    }
  }
}
```

Default transport is stdio. Legacy `--http`/SSE exists for compatibility, not normal local setup.

## 3. Bootstrap and verify

```bash
bunx @kryat/consol@latest setup --vault <absolute-vault-path> --agent <default-agent-id>
```

```bash
bunx @kryat/consol@latest doctor --vault <absolute-vault-path> --agent <default-agent-id>
```

First vector-capable setup downloads pinned q8 embedding model into vault model cache (`models/`). Once cached, embeddings and vector search run completely locally with zero cloud API calls.

Restart or reload host MCP connections after config change. Verify exactly five tools appear:

- `recall`
- `read`
- `remember`
- `record`
- `forget`

## 4. Routing

Pass `agent` on each tool call when using non-default bank. Example domain rule:

```text
Use agent="coder" for implementation, debugging, architecture, code review, and performance.
Use agent="researcher" for background research, papers, theory, and exploration.
Recall from matched bank before substantive work.
```

Agent IDs reject traversal. One process keeps separate SQLite indexes and canonical roots per bank.

## 5. Memory protocol (built into the MCP server — no host file required)

The MCP server injects this protocol into every connected agent and subagent via `instructions` and tool `description`. It is active as soon as the server is configured — no `CLAUDE.md`/`AGENTS.md`/`.cursorrules` edit needed. Treat the block below as reference; the live protocol is the server's `instructions` response.

```text
MANDATORY MEMORY PROTOCOL — Every agent and every spawned subagent MUST use Consol as human-like, continuously-injected memory. One recall at start is NOT enough.

1. Before ANY substantive work, call recall on the matched agent bank and rerank descriptors.
2. Strong, relevant match → read every plausible ref and apply it.
3. No/weak/uncertain match → search online/docs (web search, Context7 for library docs, codebase search), then proceed. Do not hallucinate when Consol has no answer.
4. MID-REASONING — after every tool result, before every edit/decision/subagent spawn, ask "do I need memory for this next step?" If yes, recall again with a narrower query derived from new context. Mandatory triggers: task branches, new error/observation, assumption failed, evidence conflicts, context missing, or before any high-impact change. Recall is bounded and cheap (<1k tokens) — no token-saving excuse.
5. After every substantive step AND at task end, MUST call record with observable outcome, evaluator, and appliedRefs (repeat those refs in top-level refs). Mid-reasoning record keeps the vault current for the next recall. Retrieval/read alone never means application or success.
6. Parent agents MUST propagate this protocol to every subagent they spawn.
```

Optional hardening: if the host supports persistent instructions, mirroring this block in `CLAUDE.md`/`AGENTS.md`/`.cursorrules` adds per-turn and per-subagent re-injection, but it is not required for the protocol to be active.

Tool semantics:

- `recall(query, mode?, agent?)`: bounded descriptor packet.
- `read(ref, cursor?, agent?)`: one UTF-8 byte-bounded page; continue with returned cursor.
- `remember(statement, scope?, refs?, agent?)`: explicit durable assertion. Exact normalized assertion deduplicates.
- `record(kind, data, refs?, agent?)`: evidence for later reflection.
- `forget(target, confirmation?, agent?)`: first call returns plan/token; second call only after user confirms same target.

Outcome example:

```json
{
  "kind": "outcome",
  "data": {
    "task": "deploy service",
    "observableOutcome": "smoke tests passed",
    "outcome": "success",
    "evaluator": "pass",
    "appliedRefs": ["<opaque-ref-or-guidance-id>"]
  },
  "refs": ["<opaque-ref-or-guidance-id>"]
}
```

Allowed outcome values: `success`, `failure`, `partial`, `unknown`. Allowed evaluator values for outcome records: `pass`, `fail`, `mixed`, `unknown`.

Case records require `rootSource`, `task`, `environment`, `action`, `observableOutcome`, `outcome`, and `evaluator`; `expectation` and `appliedRefs` remain optional.

## 6. Reflection scheduling

Run one-shot reflection manually or through host/OS scheduler:

```bash
bunx @kryat/consol@latest reflect --once --vault <absolute-vault-path> --agent <agent-id>
```

Consol has no required daemon. MCP alone cannot force calls, observe hidden reasoning, infer application, or run while host is closed. Scheduling and reliable lifecycle capture depend on host hooks or scheduler.

Reflection failures remain durable and retryable. Inferred creations remain `candidate`; model output cannot edit core, erase data, or activate inferred guidance directly.

## 7. Admin recovery

SQLite index is derived:

```bash
bunx @kryat/consol@latest reindex --vault <absolute-vault-path> --agent <agent-id>
```

Rollback audited semantic revision:

```bash
bunx @kryat/consol@latest rollback --revision <revision-id> --vault <absolute-vault-path> --agent <agent-id>
```

Rollback writes another revision. Rolling back a creation removes candidate note; rolling back that rollback restores it while current hash/state still matches.

`forget` plans first, then confirms only after user approval. Confirmation scrubs matching private text derivatives (evidence, usage, jobs, revisions, snapshots, and messages). It deletes an explicitly referenced, hash-named blob only if no surviving parsed JSON/JSONL record references that hash; it never rewrites binary bytes. `audit/erasures.jsonl` keeps a content-free receipt with hashes/counts, never erased target.

## 8. Post-Install Verification

After setup completes, the installer MUST confirm the built-in memory protocol is active:

1. Print the exact vault path: `<absolute-vault-path>`.
2. Run `doctor` and confirm MCP reports `instructions` containing `MANDATORY MEMORY PROTOCOL`. If missing, re-check `mcpServers` config and reload host connections. Common fix: `command` should be `bunx` (or `npx -y`), `args` must include `@kryat/consol@latest serve`, and `env.VAULT`/`env.AGENT` must be absolute.
3. If either check fails, fail setup with explicit guidance — do not silently complete without memory enforcement.
4. Optional hardening: mirror the protocol from §5 into `CLAUDE.md`/`AGENTS.md`/`.cursorrules` for extra per-turn/subagent re-injection. Not required — the MCP server already injects it — but recommended where the host supports it.

## 9. Post-Install Follow-Up & Customization

After verification above completes successfully, present these follow-up options:

1. **Obsidian Visual Graph**:
   - Install Obsidian: https://obsidian.md/download
   - Open vault folder: `<absolute-vault-path>`
   - Inspect notes and view the expanding `[[wikilinks]]` knowledge graph.

2. **Add Specialist Agents**:
   - Initialize dedicated memory banks for specialist roles (e.g. `coder`, `researcher`, `reviewer`, `architect`).
   - Ask user: "Would you like to initialize additional specialist agent banks in your vault?"

3. **Background Reflection LLM Runner**:
   - Consol distills past experiences into reusable principles during reflection.
   - Requires an OpenAI-compatible LLM endpoint and key.
   - Configure environment variables in MCP server config:
     * `CONSOL_ENDPOINT`: LLM base URL (e.g. `https://api.openai.com/v1`)
     * `CONSOL_API_KEY`: API key for reflection LLM
     * `CONSOL_MODEL`: Model name (e.g. `gpt-4o-mini`, `claude-3-5-sonnet`)
   - Ask user: "Would you like to configure automated reflection with an LLM endpoint and API key?"

4. **Automated Reflection Scheduling**:
   - Trigger periodic reflection runs via OS cron / task scheduler:
     ```bash
     bunx @kryat/consol@latest reflect --once --vault <absolute-vault-path> --agent <default-agent-id>
     ```
