# Architecture — Master Target

Status: approved master target; implementation follows this document
Last updated: 2026-08-28

## 1. Contract

One Bun process per agent. One stdio MCP command. One configurable vault path.

```text
Agent host / OS scheduler
        |
  stdio MCP + local CLI
        |
  memory application core
   |       |        |
 vault   retrieval  reflection / coordination
   |       |        |
 files   SQLite     interchangeable LLM runner
   |    FTS5 + vec0 |
   +------ RAG -----+
             |
      bounded context packet
             |
       optional Caveman (explicit opt-in)
```

- No Docker, no Postgres/pgvector, no Redis, no graph DB, no web UI, no required daemon.
- Obsidian is an optional editor over the vault, never a runtime dependency.
- Canonical state is files. SQLite is a derived, rebuildable index. Deleting `index.sqlite` must not lose knowledge.
- First use auto-initializes vault, creates indexes, downloads pinned q8 model into vault cache. After that, indexing and retrieval run offline.
- Learning means held-out future tasks improve under equal model, tools, environment, and context budget. Storage count, summary polish, similarity, and model confidence are not learning.

Related: [README](README.md) · [Rationale](rationale.md) · [Evaluation](evaluation.md) · [Open questions](open-questions.md)

## 2. Invariants

```text
history/evidence != declarative memory
memory != case
case != experience
experience != procedure/skill
procedure != identity/core policy
private bank != team knowledge
retrieved != consulted != applied != successful
one success != learned
similarity != factual support
repetition / peer echo != independent corroboration
prediction error != proof memory should change
retrieval failure != source erasure
model confidence != epistemic support
compressed context != source truth
```

## 3. Runtime boundary

- `Bun + TypeScript + bun:sqlite` + stdio MCP.
- Only add a dependency where the platform lacks the capability:
  - `@modelcontextprotocol/sdk` + `zod` for MCP
  - `@huggingface/transformers` for local ONNX q8 embeddings
  - `sqlite-vec` for `vec0` cosine search
  - `@caveman-ai/sdk` only when gateway packing is explicitly configured
- No ORM, web framework, scheduler, provider SDK collection, or custom frontend.
- Functional core with thin shells (filesystem / SQLite / process / network). Cohesive modules, plain types, direct composition. No one-implementation factories.

## 4. Filesystem is the source of truth

One fact has one authoritative representation; links reference it, never copy it as new support.

- **Markdown** — identity, declarative memory, cases, experiences, procedures, shared knowledge, task state.
- **JSONL** — evidence, actions, tool results, feedback, outcomes, retrieval/application traces, audit revisions.
- **JSON** — vault/agent manifests, capability snapshots, reflection jobs/proposals, threads, tasks, erasure plans.
- **Blobs** — content-addressed large/binary evidence referenced by hash.

SQLite holds no unique fact: FTS, vectors, links, temporal lookup, hashes, ephemeral scheduling convenience. Write canonical file atomically first, append audit, then update index. Startup reconciles by content hash; `reindex` rebuilds everything.

Normal evidence is append-oriented. Explicit user erasure may rewrite segments and cascade through derivatives, vectors, blobs, and caches. Audit describes mutations but is never duplicate truth.

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

External Obsidian edits are detected by hash, validated (frontmatter, bank path), recorded as attributed edits, and reindexed. An external edit alone cannot cross banks, activate experience, rewrite core, or execute code. Canonical mutations use a vault-local lock plus base-hash checks; team mail uses append-only unique event IDs for idempotent concurrent writes.

## 6. Memory model

- **Evidence** — observable source material; searchable, never wholesale-injected.
- **Declarative memory** — facts, preferences, decisions, entities, current/historical state.
- **Case** — one bounded intent: goal, initial/environment state, actions, retrieved/consulted/applied guidance, expected result when known, observable result, outcome, evaluator evidence.
- **Experience** — reusable scoped guidance (trigger, applicability, action, avoid, expected effect, counterexamples, verification), supported by multiple cases.
- **Procedure / skill** — stable multi-step method loaded on demand; never from one success.
- **Core** — tiny always-on identity, explicit preferences, strongest broadly validated rules, critical constraints, retrieval cue.
- **Shared / team knowledge** — separately owned, explicitly attached/published; never a union of private banks.

Cases split at user/task/event boundaries, not arbitrary session length. Keep similar-but-distinct cases (different goal/env/tool/version/time/outcome) before dedup. Merge only byte- or lineage-identical evidence. Experience states: `candidate → staging → active → disputed/retired`; core requires repeated broad value per byte. Explicit user policy may be durable immediately; inferred experience/procedure/core needs staged validation.

Track retrieved vs packet-included vs successfully `read` (consulted) vs applied vs outcome separately. Discount same-session and same-lineage repeats. Keep negative cases and counterexamples.

## 7. Hybrid RAG

### Indexing

- Heading-aware Markdown and bounded JSONL-window chunks with stable IDs (`id + section + source hash`).
- Each chunk: kind, owner, scope, status, timestamps, source ref, L0 summary, optional L1 overview, text.
- `FTS5` for BM25; `vec0` as `float[384] distance_metric=cosine` for normalized vectors; ordinary tables for links/backlinks and temporal fields.
- One lazy embedding singleton, batched. Pinned model `Xenova/all-MiniLM-L6-v2` `q8` rev `751bff37182d3f1213fa05d7196b954e230abad9` (from `sentence-transformers/all-MiniLM-L6-v2`), `mean` pooling, L2-normalized, 384 dims. Stored vectors stay `float32`. Vault-local cache, auto-download once, offline after. Fingerprint (model rev + dtype + pooling + chunker version) triggers rebuild when changed. `doctor` reports missing assets; never silently swaps models.

Probe:

```ts
env.cacheDir = vaultModelCache
const embed = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  dtype: "q8", revision: "751bff37182d3f1213fa05d7196b954e230abad9",
})
const out = await embed(texts, { pooling: "mean", normalize: true })
```

### Query path

1. Normalize, infer cheap intent allocation (facts / guidance / history / inbox / balanced).
2. Exact ID/alias navigation first.
3. Bounded `FTS5` BM25 and `vec0` cosine over authorized types/owners/statuses/temporal validity/compatible environment.
4. Cap each arm independently before fusion.
5. Fuse ranks with weighted RRF: `RRF(item) = sum(weight / (60 + rank))`. Never mix BM25 and cosine scores. Default equal weights until evaluation says otherwise.
6. Apply bank/attachment ACL and scope/environment/status/temporal/trust filters; suppress stale/superseded/low-accessibility unless history requested.
7. One-hop wiki-link expansion from seeds only — reconstructs detail without mutating sources.
8. Diversify across type, lineage, outcome, near-neighbor cluster; include counterexamples where negative transfer is plausible.
9. Allocate hard typed quotas, return L0 (+ few L1). L2 only via `read`. Attribute packet ID, source refs, channel ranks, and filters so later records distinguish retrieved/included/consulted/applied.

### Progressive disclosure

- **L0** — opaque ref, kind, one-line summary, scope, status.
- **L1** — compact overview, key relations, uncertainty/provenance, section map.
- **L2** — one heading-aware chunk or bounded event range.

No arbitrary paths, unlimited `k`, unlimited bytes, or full-file reads. Preserve code, errors, commands, URLs, paths, IDs, numbers exactly. Core, quotas, packet size, L0/L1/L2 ceilings are hard budgets — history growth cannot inflate normal prompts.

## 8. Tool surface

Exactly six model-visible tools (CLI-only for admin):

- `recall(query, mode?)` — compact typed packet, never a vault listing.
- `read(ref, cursor?)` — one bounded section from an opaque ref.
- `remember(statement, scope?, refs?)` — create/update explicit assertion with provenance; dedup, not blind append; cannot activate inferred experience.
- `record(kind, data, refs?)` — append observation/action/feedback/result/outcome and attribution; later reflection derives memory/experience.
- `forget(target, confirmation?)` — two-phase: plan + token, then confirmed erase. Broad/destructive needs human confirmation.
- `send(to, kind, content, refs?)` — durable thread message (question/reply/task/result/handoff); no arbitrary peer-bank reads.

`recall` surfaces inbound threads; `read` opens a thread. Reflection, indexing, publishing, scheduling, diagnostics, rollback, bank admin stay CLI/internal.

## 9. Reflection and learning

Fast path records evidence and closes cases. Slow path derives and validates abstractions asynchronously. One semantic pipeline for manual, scheduled, hook, and sampling execution:

1. Select unreviewed cases by inspectable dimensions: correction, externally observed failure, severity/risk, contradiction, novelty, recurrence, cost, expected future value, fragile/decaying access. Not by age alone.
2. Build bounded **interleaved** packet: exact source fragments, related objects, applied guidance, successes, failures, near-neighbors, incompatible envs, counterexamples, capability snapshot. Preserve root lineage.
3. Call available runner with structured output, no mutation/deletion/sharing tools.
4. Propose `create | update | merge | split | supersede | contradict | promote | demote | archive | forget | skip` — each carries before/after, base hash/version, root source refs, applicability, expected effect, observable disconfirming result, alternative explanations, rationale. Confidence is metadata, never authority.
5. Deterministic validator checks source existence, lineage independence, citation entailment, recursive contamination, secrets, env scope, stale base, allowed transitions, deletion/sharing/core authority. A `forget` proposal can only make a plan.
6. Stage valid inferred patches as `candidate/staging`, preserve predecessor/lineage, audit, reindex. Explicit user assertions may be immediate; inferred rules need gating.
7. Validate staging guidance on later independent cases or controlled evaluators. Promotion needs outcome-backed transfer; failure keeps prior state (may split scope, create competing rule, dispute, or retire).
8. Revisit active items only on new evidence, mismatch, drift, or contradiction. Retrieval alone never mutates.

No hidden chain-of-thought. Exact values stay verbatim evidence; gist stays derived and linked. Recalled text, paraphrases, copied peer claims, and repeated citations sharing one root lineage cannot become independent corroboration.

### Human-inspired behavior (functional, not biological)

Three classes: **robust principles** (bounded context, active retrieval, spacing, interleaving, source monitoring, objective feedback) motivate design but need evaluation; **computational analogies** (fast episodes + slow consolidation, separation/completion, schemas, context access, adaptive forgetting, replay, prospective cues) map to lean measurable behavior; **excluded literal mechanisms** (neurons/engrams, hippocampus services, neurotransmitters, animal strength equations, sleep stages, oscillations, fixed learning styles). Never claim biological mechanisms occurred.

Operational loop (kept lean — these are rules inside vault/retrieval/reflection, not new services):

- **Encode fast** — append evidence immediately; capture expectation before result when known, actual after; include source ID and only useful env cues. Never fabricate retrospective predictions.
- **Separate episodes** — split multi-intent streams; keep near-neighbors; dedup only exact/lineage-identical evidence.
- **Complete from cues** — exact navigation + hybrid RAG + scope filters + bounded one-hop links reconstruct detail from partial cues; packet creation is not a new source.
- **Act and observe** — mark inclusion/read/application/expected-vs-actual/evaluator separately; real independent use counts, synthetic rereading does not.
- **Replay selectively** — offline reflection interleaves useful/failed/fragile/costly/contradictory/near-neighbor cases; “sleep-like” means one-shot offline consolidation.
- **Consolidate slowly** — derive gist/experience across independent cases; retain sources; procedure only after repeated stable reuse.
- **Assimilate or accommodate** — congruent evidence may extend a scoped object; incompatible evidence splits scope, creates alternate rule, or disputes — never silent overwrite; label inferred links.
- **Mismatch = salience** — expected-vs-actual mismatch makes a case eligible for review, not proof the rule is wrong; consider stale env, misuse, retrieval failure, source error, new learning, structural drift.
- **Update observably** — mechanism-neutral states (`retrieved → contradicted → update candidate → patched → validated → disputed/retired`), versioned patches, old lineage recoverable; broad/core needs broader evidence.
- **Rehearse via outcomes** — spaced successful application can raise retrieval utility; failure can lower/narrow it. Neither raises factual support. Support, utility, and confidence stay separate.
- **Control interference** — keep incompatible rules distinct; filter by goal/host/workspace/tool/version/role/temporal validity; current probes beat remembered env; include counterexamples.
- **Monitor** — expose missing support, contradictions, stale context, alternatives, abstention; prefer delayed objective outcomes; measure whether monitoring itself helps (it costs context).
- **Social without echo** — reuse normal evidence/outcome machinery for peers; track source/domains/permissions/root lineage and outcome-calibrated domain reliability; peer confidence is not truth; copied claims count once.
- **Prospective memory** — durable jobs/tasks encode cue/deadline/owner/status/completion evidence; `recall` surfaces matches; scheduler runs one-shot checks when available; no scheduler means pending, never “done.”

Add a field only when it controls a decision or enables evaluation.

### Adaptive forgetting

Forgetting changes **access**, not source existence, and is value-sensitive — not age decay:

1. Lower default utility after non-use, stale scope, redundancy, or negative transfer; exact refs and history mode still work.
2. Suppress low-value items from normal `recall`; retain source/audit.
3. Merge true duplicates, compact redundant derived prose, retire superseded derivatives.
4. Archive inactive derived objects; exact/context cue or later success can reactivate.
5. Physically delete only under explicit retention policy or confirmed `forget` cascade.

No age-only decay; no failed-recall deletion. Stable preferences, explicit policy, severe failures, contradictions, audit/legal retention, root lineage, and currently useful experience stay protected. Source evidence normally survives retirement of derivatives; loss of support forces derivatives to recompute/dispute/retire. User erasure is separate and cascading.

## 10. Reflection runners

All runners consume the same durable job JSON and return the same proposal JSON; runner never changes semantics.

Priority: (1) MCP sampling while connected → (2) host lifecycle / headless (`claude -p`, `codex exec`) → (3) direct endpoint via `fetch` (OpenAI-compatible mapper; add protocol only when a configured endpoint needs it) → (4) manual CLI → (5) no model (queue, explicit `remember`, deterministic index/mail still work).

Host/OS scheduler runs `memory reflect --once`; core is not a scheduler and needs no daemon. File job claim/status/result survives crash and SQLite rebuild. MCP alone cannot force offline peers or observe whole conversations.

A capability snapshot (sampling/hooks/lifecycle/scheduling, structured output/context/tools, OS/workspace/network, role/peers, embedding/cache, Caveman connectivity, retention policy) picks the strongest available path but never relaxes ownership, provenance, budgets, secrets, erasure, or hidden-reasoning invariants. Online research is attributed untrusted evidence. Current probes beat remembered state; version/fingerprint mismatch makes dependent experience `staging/disputed`.

## 11. Multi-agent communication

- Registry files: stable ID, role, declared/observed capabilities, permissions, private bank, team attachments, env, runner availability, mailbox path.
- Connection fixes agent identity; model requests never pass `bank_id`.
- Team workspace: explicit project facts, decisions, artifacts, task state, published experience (owner + lineage + review/status + revision).
- Durable threads: ask/reply, delegation/result, handoff, peer review, coordinator-worker, blackboard, debate/consensus for high-risk decisions. Targeted `send`, not broadcast.
- Live adapter may notify peer; otherwise mailbox waits for peer turn/scheduler. No execution claim until result file arrives.
- Peer answers are attributed evidence, never truth; local reflection decides retention. Publishing private content to team scope is explicit and reviewed; private usage stats stay private.

## 12. Caveman token optimization

Only after local retrieval, filtering, disclosure, diversity, and budgets.

- Use `Cave.context.pack()` at packet boundary only when gateway is explicitly configured; retain every original fragment and `deferredId` locally. Connected selector is intentionally lossy and sends item bytes.
- Do not call both `context.pack()` and `compress()` by default — RAG already removes irrelevant material. Consider `compress()` only if evaluation shows added value on prose-heavy packets without breaking exact recovery.
- Compressed/packed output is transient, never canonical, never indexed, never evidence. Preserve exact technical fields outside lossy text.
- Transport/malformed-report failure passes through the bounded original. No gateway means skip Caveman; do not add a second compressor.
- Credentials are environment/OS-secret references, never vault content. Use requires explicit opt-in because bytes leave the machine.
- Benchmark task outcome, recovery fidelity, exact-field fidelity, latency, and model-bound bytes against bounded RAG before enabling. No savings claim without measurement.

## 13. Security, authority, audit

- Vault-local lock + base-hash checks; never interleave partial mutations across MCP/CLI/scheduler/Obsidian reconciliations. Team mail uses append-only unique IDs.
- OS permissions and canonical path checks bound banks; opaque refs bind owner and source hash.
- Secrets excluded/redacted before persistence/model calls; never serialize environment wholesale.
- External docs, web results, Obsidian edits, shared notes, peer messages, model proposals are untrusted attributed inputs.
- Deterministic code alone authorizes bank access, sharing, activation, core changes, deletion, executable behavior.
- Learned Markdown and skills are instructions only; no auto-generated script/hook/plugin becomes executable without explicit review.
- Every semantic mutation records actor, runner/model, reason, source refs, before/after hashes, and status transition. Git is optional user interop, not audit mechanism.
- Identity needs explicit direction or strong sustained evidence; one reflection cannot rewrite persona.
- Provider/Caveman keys remain env/OS-secret references.

## 14. Implementation structure

```text
package.json
src/
  main.ts                 CLI composition
  config.ts               vault/agent/budgets/runner config
  vault.ts                canonical files, atomic commits
  index.ts                schema, sync, chunking, q8 embedder, FTS5/vec0
  retrieval.ts            BM25/vector, RRF, graph/filter/packet
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

Use Bun's test runner and fixture vaults. Keep checks fast and offline; mark network/model/Caveman and long-horizon suites separately.

- **Deterministic correctness** — RRF order/ties, per-arm caps, typed quotas, cursor invalidation, case boundaries, lifecycle, provenance cycles, access-suppression protection, deletion cascade.
- **Vault** — crash around atomic commit/index sync, stale lock recovery, base-hash conflict, duplicate delivery, concurrent MCP/CLI/scheduler writes, malformed external edit, rollback, hash integrity.
- **Isolation** — path traversal, forged refs, cross-bank search, shared detach, private usage leakage, spoofing, unauthorized publish all fail.
- **Local model / retrieval** — fresh vault auto-downloads pinned q8, offline after cache warmup, keyword-only vs paraphrase-only hybrids survive caps, exact IDs stay BM25-findable, delete-and-rebuild is deterministic, fingerprint change rebuilds derived state only.
- **MCP / token budgets** — six-tool stdio, no full-file path, packet/core ceilings hold as history grows toward 100k cases, Caveman-unavailable falls back to bounded packet preserving refs/deferred IDs.
- **Learning** — same fixture through every runner yields contract-valid proposals under identical validators; unsupported/copied-lineage/stale/private/erasure/recursive/recency-fabricated citations never apply; segmentation, interference, source monitoring, mechanism-neutral update, spacing/interleaving, schema positive/negative transfer, calibration/abstention all exercised; held-out families measure near/far transfer, correction speed, abstention, reliability under drift; ablate source monitoring / interleaving / context filters / staged validation / access decay individually and keep only what proves out.
- **Multi-agent** — offline threads survive restart; A cannot search B; misinformation stays attributed/disputed; handoff refs let recipient fetch bounded shared artifacts.
- **Forgetting** — suppressed/archived items remain recoverable by exact/history cue and reactivatable by later success; failed recall never deletes; protected classes survive.
- Ship only when files survive index deletion/rebuild, no cross-bank leak or unconfirmed erase, q8 offline retrieval works per OS, budgets hold, lineage survives rename/relay/rebuild, no derived claim becomes its own source, and at least one held-out family shows validated experience beats equal-budget no-experience without unacceptable negative transfer.
