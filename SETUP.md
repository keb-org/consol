# Consol setup

Install one `@kryat/consol@latest` MCP server. Server can route multiple private banks through optional `agent` argument; do not create one server per bank.

## 1. Choose vault and default bank

Ask user only when values are unknown:

- Vault: global path such as `~/.memory-vault`, or project-local path.
- Default agent ID: stable short ID such as `default`, `linus`, or `ilya`.

Do not inspect or overwrite unrelated MCP entries. Before editing existing config, read it and preserve all servers and settings. Never copy credentials into vault, chat output, docs, or committed config.

## 2. Configure stdio MCP

Use installed `bunx` when available; otherwise `npx -y`. Example:

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

First vector-capable setup may download pinned q8 embedding model into vault model cache. `MEMORY_OFFLINE=1` disables download; missing model then gives explicit lexical-only degradation.

Restart or reload host MCP connections after config change. Verify exactly six tools appear:

- `recall`
- `read`
- `remember`
- `record`
- `forget`
- `send`

## 4. Routing

Pass `agent` on each tool call when using non-default bank. Example domain rule:

```text
Use agent="linus" for implementation, debugging, architecture, code review, performance, refactoring, and systems/tooling work.
Use agent="ilya" for AI research, ML architecture, papers, hypotheses, training/scaling, and AI strategy.
Recall from matched bank before substantive work.
```

Agent IDs reject traversal. One process keeps separate SQLite indexes and canonical roots per bank.

## 5. Host operating rule

Install concise host rule where host supports project/global instructions:

```text
Persistent memory uses Consol MCP. Before substantive work, call recall on matched agent bank, semantically rerank compact descriptors, and read every plausible ref. Recall again with narrower cues when task branches, assumptions fail, evidence conflicts, context is missing, or before high-impact decisions. After work, call record with observable outcome and evaluator. Put only guidance actually applied in data.appliedRefs and repeat those refs in refs. Retrieval or read alone never means application or success.
```

Tool semantics:

- `recall(query, mode?, agent?)`: bounded descriptor packet.
- `read(ref, cursor?, agent?)`: one UTF-8 byte-bounded page; continue with returned cursor.
- `remember(statement, scope?, refs?, agent?)`: explicit durable assertion. Exact normalized assertion deduplicates.
- `record(kind, data, refs?, agent?)`: evidence for later reflection.
- `forget(target, confirmation?, agent?)`: first call returns plan/token; second call only after user confirms same target.
- `send(to, kind, content, refs?, agent?)`: durable direct/team thread message.

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

Do not reindex or migrate production vault during package-development experiments without tested backup/migration path.
