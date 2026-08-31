# Architecture — Target and Current Boundary

Status: shipped v0.2.x boundary plus active target architecture
Last updated: 2026-08-31

## 1. Contract

One Bun MCP process serves multiple validated per-call agent banks. One stdio MCP command. One configurable vault path.

```text
Agent host / OS scheduler
        |
  stdio MCP + local CLI (src/main.ts)
        |
  SOLID domain hierarchy (@/*)
   |       |        |
 vault   retrieval  lifecycle / reflection
   |       |        |
 files   SQLite     interchangeable LLM runner
   |    FTS5 + vec0 |
   +------ RAG -----+
             |
      bounded context packet
             |
      protocol co-design
```

- Zero Docker, no Postgres/pgvector, no Redis, no graph DB, no web UI, no required daemon.
- Obsidian is an optional editor over the vault, never a runtime dependency.
- Canonical state is files on disk. SQLite is a derived, disposable, rebuildable index. Deleting `index.sqlite` causes zero data loss.
- First use initializes vault and index. Setup downloads pinned q8 model (`Xenova/all-MiniLM-L6-v2`) into vault-local cache; after cache warmup, vector indexing and retrieval run 100% offline.
- Learning means held-out future tasks improve under equal model, tools, environment, and context budget.

Related: [README](README.md) · [Rationale](rationale.md) · [Retrieval](retrieval-designs-and-decisions.md) · [Evaluation](evaluation.md)

## 2. Invariants

```text
evidence != memory != case != experience != procedure != core
private bank != team knowledge
retrieved != consulted != applied != successful
one success != learned
similarity != factual support
repetition / peer echo != independent corroboration
retrieval failure != source erasure
model confidence != epistemic support
protocol co-design > hardcoded dictionary bloat
```

## 3. SOLID Domain Hierarchy

The codebase is organized into strict single-responsibility domain modules with absolute path aliases:

- `src/core/` — Primitives, config, constants (`RRF_K=60`), identity sanitization, parse utilities (`extractTypedAnchors`), security redactor.
- `src/storage/` — Atomic vault file I/O, file locks, frontmatter parsing, erasure engine (`forgetPlan`/`forgetConfirm`), and the SQLite indexing subsystem (`src/storage/index/`: schema, sync, search, embeddings, surfaces, ledger).
- `src/retrieval/` — Search orchestrator (`recall.ts`), RRF ranking + 3× ledger weighting (`ranking.ts`), wire packet encoder/decoder (`packet.ts`), state-aware evidence set (`evidence-set.ts`), transfer scoring (`transfer.ts`).
- `src/lifecycle/` — Memory write mutations (`write.ts`), reflection job runner (`jobs.ts`, `runners.ts`), proposal validator (`proposals.ts`), FSM state machine (`state-machine.ts`).
- `src/server/` — MCP server protocol adapter with compact schema definitions (`mcp.ts`).
- `src/cli/` — CLI subcommands (`main.ts`: doctor, setup, reindex, reflect, rollback, serve).
- `lab/` — Agent behavior laboratory: `lab/bench/` (benchmarks), `lab/observer/` (live event tracing), `lab/telemetry.ts` (protocol adherence metrics).

## 3. Runtime boundary

- `Bun + TypeScript + bun:sqlite` + stdio MCP.
- Only add a dependency where the platform lacks the capability:
  - `@modelcontextprotocol/sdk` + `zod` for MCP
  - `@huggingface/transformers` for local ONNX q8 embeddings
  - `sqlite-vec` for `vec0` cosine search
- No ORM, web framework, scheduler, provider SDK collection, or custom frontend.
- Functional core with thin shells (filesystem / SQLite / process / network). Cohesive modules, plain types, direct composition. No one-implementation factories.

## 4. Filesystem is the source of truth

One fact has one authoritative representation; links reference it, never copy it as new support.

- **Markdown** — identity, declarative memory, cases, experiences, procedures, shared knowledge, task state.
- **JSONL** — evidence, actions, tool results, feedback, outcomes, retrieval/application traces, audit revisions.
- **JSON** — shipped vault/agent manifests, reflection jobs, messages, and erasure plans; capability snapshots and durable task semantics remain target work.
- **Blobs** — optional content-addressed large/binary evidence. Shipped erasure recognizes explicit `blob`, `blobHash`, `blobHashes`, `blobs`, `attachment`, or `attachments` JSON fields containing a bare/`sha256:` SHA-256 value; no general blob-write API ships.

SQLite holds no unique fact: shipped FTS, vectors, links, and content hashes; temporal table exists but temporal retrieval semantics do not. Canonical files write first, then applicable audit and index updates follow. Startup sync reconciles Markdown by content hash; `reindex` rebuilds derived retrieval state.

Normal evidence is append-oriented. Explicit user erasure may rewrite text derivatives and remove exact content-addressed blobs once no surviving JSON/JSONL record references their hash. Audit describes mutations but is never duplicate truth.

## 5. Vault and Obsidian

```text
<vault>/
  vault.json
  models/                          # pinned q8 cache (vault-local)
  agents/<agent>/
    agent.json
    core/
    memories/ cases/ experiences/ skills/
    evidence/YYYY/MM/*.jsonl
    jobs/ messages/ blobs/ audit/
    index.sqlite
  teams/<team>/
    team.json
    memories/ experiences/ threads/ tasks/
    audit/ index.sqlite
```

**Markdown** — minimal envelope:

```yaml
---
id: stable-id
kind: memory | case | experience | skill | identity
---
```

`summary / scope / status / source / updated` are optional. Body is normal Markdown with `[[wiki links]]`, tags, tables, headings. Experience often renders as Trigger / Scope / Do / Avoid / Check — a rendering convention, not a schema.

**Evidence JSONL** — minimal envelope:

```json
{"id":"...","at":"...","agent":"...","kind":"...","data":{},"refs":[]}
```

`refs` appears only when relationships exist. Session, tool, environment, outcome, case, thread, scope live in `data` when relevant.

External Markdown edits are detected by hash and reindexed on next sync. Current indexing parses frontmatter but does not reject malformed semantic edits or record them as attributed edit evidence. Obsidian renders links directly from canonical Markdown; Consol generates no parallel graph/Canvas files and never rewrites links to tune visual prominence. An external edit under a canonical note root can change indexed content/status, so OS permissions and vault ownership remain trust boundaries. Reflection/core mutation APIs still enforce their own protections. Canonical mutations use vault-local lock plus base-hash checks; team mail uses unique event IDs, but process-death transactions and duplicate-delivery dedup are not complete.

## 6. Memory model

- **Evidence** — observable source material; searchable, never wholesale-injected.
- **Declarative memory** — facts, preferences, decisions, entities, current/historical state.
- **Case** — one bounded intent: goal, initial/environment state, actions, retrieved/consulted/applied guidance, expected result when known, observable result, outcome, evaluator evidence.
- **Experience** — reusable scoped guidance (trigger, applicability, action, avoid, expected effect, counterexamples, verification), supported by multiple cases.
- **Procedure / skill** — stable multi-step method loaded on demand; never from one success.
- **Core** — canonical protected Markdown category. Tiny always-on compilation/injection remains target work.
- **Shared / team knowledge** — separately owned and explicitly attached; reviewed publication does not ship, and team content is never a union of private banks.

Current `record` validates required case/outcome fields at trust boundary; it does not automatically segment arbitrary transcripts into cases. Exact normalized `remember` assertions deduplicate. Reflection preserves distinct source records and creates/updates candidates. Experience states support explicit transitions among `candidate/staging/active/disputed/retired/superseded`; automatic core promotion and broad value-per-byte compilation remain target work. Explicit user assertion may be durable immediately; inferred creations start `candidate`.

Track retrieved vs packet-included vs successfully `read` (consulted) vs applied vs outcome separately. Runtime writes bounded private usage events to `agents/<agent>/audit/usage.jsonl`; only explicit `record` outcome/case fields can mark application and evaluation. Discount same-session and same-lineage repeats. Keep negative cases and counterexamples.

## 7. Hybrid RAG

### Indexing

Current implementation indexes canonical Markdown notes. JSONL evidence remains canonical reflection input but is not yet retrieval-indexed.

- Heading-aware Markdown chunks carry document ID, section, source hash, kind, owner, scope, status, and updated time.
- Each indexed row stores kind, owner, scope, status, updated time, source hash, section, and text. L0/L1 descriptors are derived at recall time.
- `FTS5` for BM25; optional `vec0` as `float[384] distance_metric=cosine` for normalized vectors; ordinary tables for links/backlinks. Temporal table is reserved but unused.
- One lazy embedding singleton. Pinned model `Xenova/all-MiniLM-L6-v2` `q8` rev `751bff37182d3f1213fa05d7196b954e230abad9` (from `sentence-transformers/all-MiniLM-L6-v2`), `mean` pooling, L2-normalized, 384 dims. Stored vectors stay `float32`. Vault-local cache, lazy download unless offline, offline after warmup. Fingerprint (model rev + dtype + pooling + chunker version) clears derived retrieval rows when changed. `doctor` reports model cache/vector state; model failures remain explicit lexical-only degradation.

Probe:

```ts
env.cacheDir = vaultModelCache
const embed = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  dtype: "q8", revision: "751bff37182d3f1213fa05d7196b954e230abad9",
})
const out = await embed(texts, { pooling: "mean", normalize: true })
```

### Query path

Current shipped path:

1. Normalize query; `facts`, `guidance`, and `history` select kind/status sets, while `auto` stays balanced and `inbox` bypasses retrieval for direct messages.
2. Resolve exact document ID first.
3. Request oversized lexical and, when available, vector pools; then enforce owner/attachment, status, and kind authorization before independently taking each arm cap.
4. Fuse one-based lexical/vector ranks with equal-weight RRF: `RRF(item) = sum(1 / (60 + rank))`. Never mix BM25 and cosine scores.
5. Expand deterministic one-hop outgoing/backlinks from top seed documents and reapply owner/status/kind checks.
6. Apply typed quotas and adaptive 10/20/30 descriptor target; fit hard packet bytes. Return L0 plus limited L1. L2 only via `read`.
7. Attribute packet ID, channel ranks, filters, returned candidates, vector state, and packet size so durable usage can distinguish retrieved/packet-included/consulted.

Target, not shipped: alias resolution, temporal validity, environment/scope compatibility filtering, lineage/cluster diversity, counterexample injection, utility suppression/reactivation, and weighted fusion.

### Progressive disclosure

- **L0** — opaque ref, kind, one-line summary, scope, status.
- **L1** — current implementation repeats compact top-item overview plus section cue; richer relations/provenance maps remain target work.
- **L2** — one heading-aware chunk or bounded event range.

No arbitrary paths, unlimited `k`, unlimited bytes, or full-file reads. Retrieval preserves source chunk text for bounded `read`; compact summaries are lossy descriptors and must not be treated as exact evidence. Quotas, packet bytes, and L2 bytes are enforced. Core token budget is configuration/target only until core compilation/injection ships.

## 8. Tool surface

Exactly six model-visible tools (CLI-only for admin):

- `recall(query, mode?, agent?)` — compact typed packet, never a vault listing.
- `read(ref, cursor?, agent?)` — one bounded section from an opaque ref.
- `remember(statement, scope?, refs?, agent?)` — create explicit assertion with exact normalized dedup; cannot activate inferred experience.
- `record(kind, data, refs?, agent?)` — append observation/action/feedback/result/outcome/case/correction and attribution; later reflection may derive memory/experience.
- `forget(target, confirmation?, agent?)` — two-phase: plan + token, then confirmed private-bank erase. Broad/destructive needs human confirmation.
- `send(to, kind, content, refs?, agent?)` — durable thread message (question/reply/task/result/handoff); no arbitrary peer-bank reads.

`recall(mode="inbox")` surfaces direct inbox/sent messages; `read` opens own or attached-team thread files. Shipped CLI handles setup, doctor, reindex, reflection, and rollback. Lifecycle transitions and team attachment exist as internal APIs. Publishing, bank admin, and scheduling do not ship as Consol CLI operations.

## 9. Reflection and learning

Fast path records evidence and closes cases. Slow path derives and validates abstractions asynchronously. One semantic pipeline for manual, scheduled, hook, and sampling execution:

Current shipped loop:

1. Select unreviewed failure, correction, case, and outcome evidence with deterministic priority.
2. Build a bounded packet from exact evidence plus related recall descriptors.
3. Call sampling, Claude CLI, Codex CLI, or an explicitly configured endpoint; failure leaves the job inspectable and retryable.
4. Accept only `create | update | skip`. Every proposal must address packet evidence, cite packet refs only, pass secret/path/core/base-hash checks, and survive current opaque-ref validation.
5. Stage valid inferred patches as `candidate`, preserve sources, write before/after hashes plus rollback snapshots under `audit/`, and reindex. Rollback is itself audited; create rollback deletes and can restore the candidate note.
6. Internal lifecycle accepts declared transitions among `candidate/staging/active/disputed/retired/superseded`. `staging → active` requires at least two distinct `rootSource` values from explicit successful, passing outcome records that list target in `appliedRefs`.
7. Revisit active items only through an explicit later mutation. Retrieval alone never mutates.

Target, not shipped: interleaved counterexample/environment packets, semantic citation entailment, recursive lineage-contamination checks, contradiction-driven automatic lifecycle changes, and actions beyond `create | update | skip`.

No hidden chain-of-thought. Exact values stay verbatim evidence; gist stays derived and linked. Recalled text, paraphrases, copied peer claims, and repeated citations sharing one root lineage cannot become independent corroboration.

### Human-inspired behavior (functional, not biological)

Three classes: **robust principles** (bounded context, active retrieval, spacing, interleaving, source monitoring, objective feedback) motivate design but need evaluation; **computational analogies** (fast episodes + slow consolidation, separation/completion, schemas, context access, adaptive forgetting, replay, prospective cues) are possible information-system designs; **excluded literal mechanisms** (neurons/engrams, hippocampus services, neurotransmitters, animal strength equations, sleep stages, oscillations, fixed learning styles) never enter claims. No biological mechanism is implemented or inferred.

Current shipped pieces:

- append explicit evidence with optional expectation/outcome/application fields;
- retrieve via exact IDs, hybrid cues, status/kind/owner checks, and bounded one-hop links;
- track retrieval, packet inclusion, successful `read`, explicit application, outcome, and evaluator separately;
- prioritize unreviewed failure/correction/case/outcome evidence for reflection;
- preserve exact sources, candidate state, audited revisions, and explicit lifecycle transitions;
- require outcome-backed roots before activation.

Target, not shipped: automatic episode segmentation, interleaved replay, semantic assimilation/splitting, contradiction-driven updates, utility learning, environment compatibility, calibrated peer reliability, metacognitive abstention, prospective cue/deadline tasks, and held-out transfer proof.

Add a field only when it controls a decision or enables evaluation.

### Adaptive forgetting

Shipped behavior: normal recall excludes disputed/retired/superseded statuses; history mode includes them. Explicit lifecycle transitions can dispute, retire, or supersede derived notes. Confirmed two-phase `forget` physically erases matching private-bank canonical notes and tracked derivatives.

Target, not shipped: value-sensitive utility decay, automatic suppression/archive/reactivation, redundancy compaction, contradiction-triggered dispute, and support-loss recomputation. No age-only or failed-recall deletion should be added.

## 10. Reflection runners

All runners consume the same durable job JSON and return the same proposal JSON; runner never changes semantics.

Runner priority: (1) MCP sampling when callback is supplied → (2) headless `claude -p` → (3) `codex exec` → (4) explicitly configured endpoint via `fetch` → (5) none. `consol reflect --once` creates and attempts one durable job; host/OS scheduling is external. No runner success leaves evidence unreviewed and job retryable. Job files survive SQLite rebuild. Process-death recovery across multi-file commit is not implemented. MCP alone cannot force offline peers or observe whole conversations.

Target, not shipped: host capability/environment snapshots, lifecycle adapters, automatic version/scope compatibility transitions, attributed online-research capture, and scheduler negotiation. These may choose execution path later but must never relax ownership, provenance, budgets, secrets, erasure, or hidden-reasoning boundaries.

## 11. Multi-agent communication

Current shipped boundary:

- Agent manifests hold stable ID, role, capabilities, and explicit team attachments.
- Every MCP tool accepts optional validated `agent`; one server routes to that bank. Path-like IDs fail.
- Team Markdown is readable only while attached. `send` writes targeted durable agent/team messages; `read` opens only own or currently attached-team threads.
- Peer answers remain attributed messages, not automatically trusted memory.

Target, not shipped: permission-rich registries, reviewed publish workflows, capability/environment snapshots, live peer notification, coordinator workflows, and reliability scoring.

## 12. Caveman token optimization

Only after local retrieval, filtering, disclosure, diversity, and budgets.

Current experimental adapter calls `Cave.context.pack()` at packet boundary only when gateway, base URL, and environment credential are explicitly configured. It sends query plus compact item summaries/metadata; secret-shaped input bypasses gateway, secret-shaped output is discarded, and transport/malformed output falls back to bounded original. Packed output is transient, never canonical, indexed, or evidence. No gateway means no call.

Quality blockers before production enablement: verify returned item/deferred-reference recovery, preserve exact technical fields outside lossy output, and benchmark outcome/recovery/fidelity/latency/bytes. Do not stack `compress()`. No savings claim without measurement.

## 13. Security, authority, audit

- Vault-local lock + base-hash checks serialize supported canonical mutations. Caught failures restore prior files; process death/power loss across multi-file mutation remains unsupported. Team mail uses unique IDs but no complete replay/dedup ledger.
- OS permissions and canonical path checks bound banks; opaque refs bind owner, source hash prefix, and packet ID.
- Common/configured secret forms are rejected from assertions, evidence, messages, and reflection proposals; runner diagnostics are redacted. Private recall responses and usage logs omit raw query text. Optional Caveman packing bypasses secret-shaped input and discards secret-shaped output before returning it.
- Confirmed erasure writes a content-free receipt to `audit/erasures.jsonl`. Closure is private-bank-local. Binary files are never decoded or rewritten: only hash-named files under `blobs/` referenced by an erased JSON/JSONL record are deleted, and only when no surviving parsed record references that hash. Cross-owner copies and references hidden in malformed/unstructured text remain outside this guarantee.
- External docs, web results, direct Markdown edits, shared notes, peer messages, and model proposals are untrusted inputs. Not every external input is currently captured as attributed evidence.
- Deterministic code authorizes shipped bank access, lifecycle transitions, protected-core mutation rejection, and deletion. Reviewed publishing and executable skill generation do not ship.
- Reflection create/update/transition mutations record actor, runner where applicable, rationale, source refs, before/after hashes, and status. `remember` and direct external edits are not semantic revision events. Git remains optional user interop.
- Provider/Caveman keys remain environment references and must never enter vault content.

## 14. Implementation structure

```text
package.json
src/
  main.ts                 CLI composition
  config.ts               vault/agent/budgets/runner config
  vault.ts                canonical files, atomic commits
  index.ts                schema, sync, chunking, q8 embedder, FTS5/vec0
  retrieval.ts            BM25/vector, RRF, link/filter/packet
  memory.ts               six operation semantics + cases/lifecycle
  reflection.ts           selection, proposals, validation, consolidation
  runners.ts              sampling / Claude / Codex / endpoint / manual
  agents.ts               registry, teams, threads, tasks, send
  mcp.ts                  stdio transport, six tools, final Caveman adapter
tests/
  retrieval.test.ts  memory.test.ts  reflection.test.ts
  isolation.test.ts  e2e.test.ts
```

No repository/service/controller/entity layers, generic bus, plugin framework, per-runner factories, schema registry, or DTO duplication. Extract a module only when one responsibility blurs.

## 15. Verification

Current offline suites cover exact-ID and hybrid mechanics with test embeddings, equal-weight RRF/ties, independent arm caps, quotas, adaptive targets, UTF-8 cursors, stale/forged refs, bank/team ACLs, secret rejection, exact assertion dedup, usage-stage separation, reflection retry/validation, lifecycle gates, audit/rollback including create undo/redo, disputed filtering, and private-bank derivative erasure including fixed-point JSONL chains. Latest measured result belongs in test output, not architecture prose.

Still required before broad capability claims:

- real q8 online-download/offline-restart tests across supported OSes and dense paraphrase fixtures;
- 1k/10k/optional-100k indexing, latency, packet, and vector-coverage measurements;
- semantic citation-entailment, recursive/cyclic lineage, environment/scope compatibility, contradiction, and negative-transfer fixtures;
- process-death journal/recovery, injected filesystem/index-sync failures, malformed JSON/JSONL, shared snapshot hash, nested blob-layout, and cross-owner erasure tests;
- host-compliance and narrower mid-task recall scenario;
- equal-model/equal-budget no-memory/facts/experience/full-system held-out task evaluation.

No task-level experiential-transfer or human-memory claim ships until those tests produce reproducible results.
