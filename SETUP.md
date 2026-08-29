# consol — Agent Self-Installation & Interactive Setup Protocol

> **INSTRUCTION FOR THE AI AGENT READING THIS**:  
> You are installing and configuring `@kryat/consol` (Long-Horizon Memory MCP) in this environment.  
> Keep the entire setup process 100% inside the chat interface. Guide the user, ask needed preferences, inspect your environment, and write the configuration autonomously.

**Source of Truth URL**:  
`https://raw.githubusercontent.com/keb-org/consol/main/SETUP.md`

---

## 1. Interactive Chat Onboarding

When the user asks you to set up `consol`, briefly confirm what you detected and ask 2 quick questions in chat before writing config:

1. **Vault Storage Location**:
   - Option A: **Global** (`~/.memory-vault`) — one persistent memory shared across all projects (Recommended).
   - Option B: **Project-local** (`./.vault` or custom directory) — isolated strictly to this workspace.
   - *Ask the user which they prefer, or use Global if they have no preference.*

2. **Agent Identity / Persona**:
   - Ask what name or role they want to give this memory bank (e.g., `default`, `developer`, or their own name), or default cleanly to the OS user.

---

## 2. Environment Auto-Discovery

While interacting with the user, discover your runtime in the background:

- **Host Client**: Find where your active client stores MCP configuration (look for MCP config files in user home directory and current workspace root).
- **Package Runner**: Check for `bunx` or `npx` on `PATH` (prefer `bunx` for instant cold starts; fallback to `npx -y`).
- **Transport**: Default to stdio. (Only use `--http` if running in a remote/containerized headless setup).

---

## 3. Apply Configuration

Merge the `consol` server entry into your detected MCP configuration file under `mcpServers` (preserve all existing servers):

```json
{
  "mcpServers": {
    "consol": {
      "command": "<detected-runner>",
      "args": ["@kryat/consol", "serve"],
      "env": {
        "VAULT": "<user-chosen-or-default-vault-path>",
        "AGENT": "<user-chosen-or-default-agent-name>"
      }
    }
  }
}
```

---

## 4. Bootstrap & Self-Check

Run a quick health check via your shell:

```bash
<runner> @kryat/consol doctor --vault <chosen-vault-path>
```

Report back to the user in chat that memory is active, showing:
- Active vault path
- Active agent identity
- Available tools (`recall`, `remember`, `record`, `read`, `forget`, `send`)

---

## 5. Operating Protocol

Once installed, use memory autonomously throughout future conversations:

- **`recall(query)`**: Search memories, guidelines, and lessons before starting complex tasks.
- **`remember(statement, scope?)`**: Permanently save user preferences, architecture decisions, and rules.
- **`record(kind, data)`**: Log task outcomes, bug fixes, and lessons learned after completing work.
- **`read(ref)`**: Fetch deep chunk content only when requested by recall.
- **`forget(target, confirmation?)`**: Two-phase verified erasure.
- **`send(to, kind, content)`**: Coordinate and share threads with other agents or team mailboxes.

---

## 6. System Directive

Inject this directive into your system instructions or project rules file:
```text
Persistent long-horizon memory active via consol MCP tools. Recall past lessons before tasks, record outcomes after completions.
```
