# Design Rationale and Decision Log

Status: shipped decisions and measured targets; target-only behavior is labeled
Last updated: 2026-08-29

This document explains current decisions, target decisions still awaiting
implementation or measurement, rejected alternatives, and evidence that would
justify change. Future implementation must preserve these arguments or explicitly
replace them with stronger evidence.

## 1. Governing principles

### R1. Optimize behavior, not stored volume

A memory system succeeds only when future work improves. Storage count,
retrieval similarity, and polished summaries are intermediate metrics.

Consequence: outcome attribution and held-out evaluation are architecture, not
optional analytics.

### R2. Experience is not memory

Facts answer "what is true?" Experience answers "under these conditions, what
action tends to work, what fails, and how should success be checked?"
Procedures answer "what exact reusable steps should run?" Identity answers
"what must shape behavior every time?"

Collapsing these into one store causes:

- wrong retrieval ranking;
- mixed prompt rendering;
- accidental policy promotion from factual statements;
- inability to evaluate action guidance separately;
- bloat in always-on identity;
- dangerous sharing across agents.

Consequence: separate schemas, tables, directories, budgets, status machines,
and packet sections.

### R3. Evidence remains distinct from inference

Model-generated summaries and policies can be wrong. If they overwrite source
history, later consolidation cannot audit or correct them and generated claims
can recursively become their own evidence.

Consequence: immutable normal-operation evidence, cited derivations, content
hashes, and explicit contamination stripping.

### R4. Confidence comes from outcomes

An LLM's numeric confidence mostly describes its own presentation, not actual
reliability. Repeated support can also be fake if all records derive from one
source event.

Consequence: confidence combines source quality, source independence, relevant
recency, contradictions, and downstream outcomes. Activation thresholds are
deterministic and conservative.

### R5. Prompt size stays bounded while history grows

Long-horizon memory fails if each retained item increases every future prompt.
Always-on context must behave as a scarce cache of identity and high-value
policy, not a complete autobiography.

Consequence: hard core budget, independent category quotas, L0/L1/L2
progressive disclosure, fixed packet ceilings, and promotion/demotion.

### R6. Observable truth outranks remembered state

Tools, paths, APIs, and environments change. Old operational knowledge can
actively harm future work.

Consequence: current status/scope filters and disputed/history behavior reduce
some stale guidance. Environment fingerprints, compatibility probes, and
version-aware invalidation remain target work.

### R7. Isolation is structural

A per-call bank selector is safe only when deterministic code validates IDs,
resolves separate roots/indexes, and enforces owner-bound refs and team ACLs.
Prompt instructions alone are not isolation.

Consequence: one process may route optional `agent` on all six tools, but each
validated bank keeps a separate canonical root and SQLite index. Team access is
explicitly attached; arbitrary peer-bank reads remain inexpressible.

### R8. Deterministic code controls authority

Models help classify, summarize, and propose. They must not decide access,
delete evidence, activate policy, rewrite identity, or execute generated code.

Consequence: bounded no-tool extractors, deterministic validation, state
machines, ACLs, confirmation flows, and audit journal.

### R9. Infrastructure needs measured justification

Operational burden reduces reliability and adoption. Every service or package
adds install, update, security, privacy, failure, and context costs.

Consequence: begin with Bun, filesystem, SQLite FTS5, and official MCP SDK.
Benchmark-gate embeddings and every larger component.

### R10. Host limitations must be stated honestly

MCP is a capability protocol, not a universal conversation lifecycle bus.
Pretending otherwise would produce an architecture that silently misses turns
and outcomes.

Consequence: shipped MCP instructions and setup rules remain best effort.
Reliable automatic capture/injection requires a future host lifecycle adapter;
manual or host/OS scheduling runs reflection today.

## 2. Architecture decision records

### ADR-001: Bun-only core

**Decision:** Use Bun with `bun:sqlite`, native APIs, and official MCP SDK.

**Why:**

- meets one-command local setup goal;
- SQLite and filesystem cover baseline persistence/retrieval;
- no interpreter environment, service stack, or container lifecycle;
- native streams and crypto cover evidence ingestion and hashing;
- small dependency graph reduces maintenance and attack surface.

**Rejected:** uv/Python core. Python can also be lean, but current reference
systems demonstrate dependency drift around parsing, providers, web servers,
and model integrations. Bun gives tighter initial boundary for this product.

**Revisit when:** Bun lacks a required stable platform feature, current MCP SDK
cannot run correctly, or measured production reliability favors a small uv
package enough to outweigh migration cost.

### ADR-002: Stdio MCP, no daemon or HTTP server

**Decision:** Host starts one process over stdio.

**Why:**

- no port, service manager, process-health UI, authentication layer, or manual
  startup;
- lifecycle follows host;
- local data path can be explicit in command config;
- smallest path to Desktop and Code compatibility.

**Rejected:** always-on local daemon, FastAPI/Uvicorn, REST control plane.

**Tradeoff:** no autonomous work after host exits. Durable reflection jobs remain
on disk; a later manual or externally scheduled `consol reflect --once` can retry
work. External scheduler is optional and explicit.

**Revisit when:** proven use case requires cross-host coordination or guaranteed
background work while every client is closed. Even then, keep stdio adapter and
make daemon optional.

### ADR-003: Evidence journal + Markdown semantics + rebuildable SQLite

**Decision:** Canonical files and disposable index have explicit roles.

**Why:**

- JSONL preserves exact evidence and audit events cheaply;
- Markdown gives inspectability, Obsidian-rendered wiki-link navigation,
  portability, and manual edits;
- JSON stores manifests, jobs, messages, and erasure plans;
- SQLite provides FTS, vectors, link lookup, and content-hash reconciliation;
- index can be deleted/rebuilt without losing canonical knowledge;
- avoids forcing raw event volume into thousands of Markdown files.

Current retrieval indexes Markdown only. JSONL remains reflection input, not a
search corpus. Temporal and queue tables are not shipped semantics.

**Rejected:**

- SQLite as only source: opaque and poor Obsidian interoperability;
- Markdown as only store: weak structured journals, jobs, usage audit, and
  high-volume event ingestion;
- two writable canonical copies of every object: undefined conflict behavior;
- Git as mandatory database: adds process, lock, identity, and merge burden.

**Revisit when:** rebuild tests expose information loss or external editing
requires stronger conflict semantics. Fix ownership rules before adding another
store.

### ADR-004: Typed ontology, not generic memory records

**Decision:** Evidence, facts, cases, experiences, procedures, core, and shared
ownership remain distinct.

**Why:** Each has different truth, mutation, retrieval, rendering, retention,
sharing, and evaluation semantics.

**Rejected:** one `memories` collection with a loose `type` label and common
prompt rendering.

**Revisit when:** never for semantic collapse. Physical storage may be
optimized only if external type invariants remain enforced and separately
measurable.

### ADR-005: Hybrid BM25 + vector with RRF and vault-local q8

**Decision:** Baseline retrieval uses bounded BM25 (FTS5) and optional bounded
`vec0` cosine (`sqlite-vec`), fused by equal-weight RRF `k=60`, plus exact
document IDs, one-hop wiki links, owner/status/kind filters, and deterministic
ties. Vectors come from a pinned vault-local q8 model
(`Xenova/all-MiniLM-L6-v2`, `q8`, rev
`751bff37182d3f1213fa05d7196b954e230abad9`, mean pooling, L2-normalized, 384 dims,
stored `float32`). Alias navigation, temporal-validity filtering, and
environment compatibility remain target work.

**Why:**

- lexical excels at exact identifiers/codes; vectors cover paraphrase — caps per
  arm prevent crowding before fusion; RRF avoids mixing incomparable scores;
- q8 cuts model download/memory while stored vectors remain `float32`;
  vault-local cache makes later use offline; fingerprint triggers rebuild on
  model/chunker change;
- keeps hybrid retrieval without Postgres/pgvector: `bun:sqlite` + optional
  `sqlite-vec` form one disposable/rebuildable index;
- embedding or `sqlite-vec` failure is reported as lexical-only degradation;
  missing vectors remain retryable and no zero-vector substitute is stored.

**Rejected:** lexical-only baseline that punished paraphrase, mandatory
pgvector/vector service, cross-encoder reranker, storing quantized vectors before
measured need.

**Tradeoff:** one-time model download and vector build cost.

**Revisit when:** RRF weights or per-arm caps need calibration, or stored-vector
quantization is justified by measured storage/latency win.

### ADR-006: Hard progressive disclosure

**Decision:** `recall` returns L0/selected L1; `read` returns overview or one
bounded L2 chunk. No model-visible full-file option.

**Why:**

- prevents accidental context flooding;
- makes cost independent of source file size;
- forces navigation before detail;
- lets retrieval diversify across memory types;
- addresses agents missing distant content in long files.

**Rejected:** caller-supplied arbitrary `limit`, raw file reads, top-k full
content dumps.

**Tradeoff:** extra round trips for deep evidence inspection.

**Revisit when:** measurements show bounded reads materially harm task success.
Prefer larger fixed ceiling or better section maps before adding unbounded read.

### ADR-007: Tiny compiled core

**Decision:** Target 600–900 estimated tokens, hard ceiling around 1,200 tokens
and 4 KiB. Automatic core compilation/injection is not shipped.

**Why:**

- always-on tokens compound across every turn;
- core must prime retrieval and stable behavior, not contain detailed history;
- OpenViking demonstrates aggressive progressive disclosure;
- Letta correctly notes in-context detail provides priming, but its suggested
  15–20K core is too expensive for this lean layer;
- fixed competition prevents infinite identity growth.

**Rejected:** full agent memory or large summaries in system prompt.

**Tradeoff:** deferred knowledge is useful only if retrieval triggers correctly.

**Revisit when:** controlled ablation shows larger core improves success enough
to outweigh recurring token cost. Increase only affected quota, not whole core.

### ADR-008: Case/outcome-driven experience

**Decision:** Derive candidate experience from exact case/outcome/correction
records and explicit usage attribution. Do not call it validated learning until
held-out transfer is measured.

**Why:** Similarity and transcript summaries do not tell whether an action was
correct. Cases provide unit of evidence; outcome and evaluator provide update
signal; held-out cases must test transfer.

**Rejected:** create experience after every session or every apparent success.

**Tradeoff:** some useful lessons remain candidates longer; many cases have
unknown outcomes.

**Revisit when:** thresholds are calibrated, not when faster accumulation feels
better. Measure false promotion and missed learning.

### ADR-009: Experience lifecycle and conservative activation

**Decision:** Shipped note states include candidate, staging, active, disputed,
retired, and superseded. Explicit internal transitions enforce allowed edges;
`staging → active` needs two distinct successful, passing application roots.
Automatic contradiction response and core promotion are not shipped.

**Why:**

- one case can be anomalous;
- policies become harmful when scope changes;
- contradictions need visible state, not silent overwrite;
- retirement must preserve history and negative evidence;
- core deserves stricter evidence than deferred retrieval.

**Rejected:** binary present/deleted memory and unconstrained confidence scores.

**Revisit when:** benchmark calibration supports different numeric thresholds.
Statuses and separation remain.

### ADR-010: Six MCP tools; everything else is CLI

**Decision:** `recall`, `read`, `remember`, `record`, `forget`, `send` —
exactly six model-visible verbs. Shipped CLI exposes setup, doctor, reindex,
reflect, and rollback. Team attach APIs and lifecycle transitions are internal;
publishing, bank CRUD, and scheduling are host/future concerns, not shipped CLI.

**Why:** Each of the six survives the deletion test:

- remove `recall`: no task-oriented retrieval;
- remove `read`: no safe bounded detail (no full-file fallback);
- remove `remember`: no explicit durable assertion/correction;
- remove `record`: no evidence/outcome stream for later reflection;
- remove `forget`: no user-controlled erasure (two-phase plan+confirm);
- remove `send`: no durable multi-agent ask/reply/delegation/handoff.

Schemas stay concise so tool choice remains sharp.

**Rejected:** Hindsight-style broad administrative CRUD, separate `record_outcome`
name (now `record`), and exposing reflection/indexing as model tools.

**Revisit when:** a capability cannot be expressed without semantic overload.
Prefer the CLI surface.

### ADR-011: Single server with validated per-call bank routing

**Decision:** One MCP server exposes optional `agent` on every tool. Missing
`agent` uses configured default. Each validated bank gets separate canonical root,
derived SQLite index, audit actor, and attached-team ACL.

**Why:** Desktop hosts need one server while implementation and AI-research work
must route to distinct private banks. One process avoids duplicate server config;
path-safe IDs, owner-bound opaque refs, per-bank contexts, and attachment checks
preserve isolation.

**Rejected:** duplicate `consol-linus`/`consol-ilya` servers and unvalidated path-like
bank IDs.

**Revisit when:** host supplies authenticated connection identity. Host metadata
may then set default, but explicit routing must still pass same ACL and ownership
checks.

### ADR-012: Attached team content is read-only from private banks

**Decision:** Team Markdown remains separately owned and enters an agent's index
only through explicit attachment. Owner-bound refs and current attachment checks
control reads. No reviewed publishing workflow ships yet.

**Why:** Copying creates drift and destroys ownership. Writable shared memory
allows one agent's mistaken inference to contaminate others.

**Rejected:** global common bank and automatic cross-agent learning.

**Revisit when:** explicit publishing workflow has conflict, review, audit, and
rollback semantics. Private evidence must remain private by default.

### ADR-013: Model proposes; deterministic system authorizes

**Decision:** Reflection runners receive bounded durable job input and return
`create | update | skip` proposals. Code validates packet membership, exact
evidence snapshots, current opaque refs, ownership, paths, schemas, protected
core, and base hashes. It does not yet prove semantic citation entailment or
recursive lineage independence.

**Why:** Consolidation needs semantic judgment, but authority and safety must be
predictable. This also makes different model providers replaceable.

**Rejected:** autonomous reflection agent with unrestricted file/tool access as
baseline.

**Revisit when:** never for access and deletion authority. Models may gain
additional proposal tools only inside a deterministic sandbox with measured
need.

### ADR-014: Interchangeable reflection runners (sampling, Claude, Codex, endpoint)

**Decision:** One reflection job format; runners are interchangeable.

Priority when available:

1. MCP sampling while connected
2. Headless CLIs: `claude -p`, `codex exec`
3. Explicitly configured endpoint via `fetch`
4. No model — durable job remains retryable; explicit `remember`, index, and mail
   still work

`consol reflect --once` creates and attempts one job; host/OS scheduling is
external. No required provider SDK collection. MCP sampling alone cannot observe
whole conversations or force offline peers.

**Rejected:** single hard-coded model path or requiring many provider SDKs in core.
Core never gains new authority from whichever runner executes.

**Revisit when:** a new host exposes stronger lifecycle events — add an adapter,
not a new storage/learning concept.

### ADR-015: Host adapter required for reliable automatic capture

**Decision:** Current MCP server instructions and installed host rules are best
effort. No Consol Claude Code hook adapter ships. A future host adapter is
required for reliable automatic capture/injection; generic MCP hosts remain
best effort.

**Why:** Current MCP server receives requested tool calls, not universal host
transcript and lifecycle events. It cannot force recall or rewrite host system
prompt.

**Rejected:** claiming MCP instructions or sampling guarantees automatic memory.

**Revisit when:** MCP or host adds authenticated lifecycle/capture capabilities.
Update adapter, not ontology/storage core.

### ADR-016: Audit journal required; Git optional

**Decision:** Record semantic revisions and hashes internally. Support Git as
user interoperability rather than runtime dependency.

**Why:** Audit and rollback are necessary; invoking Git for every event is not.
Git performs poorly as high-volume event log and introduces locking/setup
burden.

**Rejected:** Letta-style mandatory Git-backed memory runtime.

**Revisit when:** users need distributed collaborative editing. Git can wrap
semantic Markdown while evidence/index semantics remain unchanged.

### ADR-017: Environment knowledge is volatile and scoped

**Decision:** Current notes can carry free-form `scope`, but machine/workspace/
project fingerprints, verification methods, expiry, and live compatibility
probes remain target work.

**Why:** Operational knowledge ages differently from identity and preferences.
Stale tool knowledge creates negative transfer.

**Rejected:** permanent global tool rules inferred from one environment.

**Revisit when:** probe cost or false invalidation is measured. Adjust probing
and fingerprints, not type distinction.

### ADR-018: No automatic executable skill generation

**Decision:** Learned procedures may become Markdown instructions only.
Generated scripts are never created or run automatically.

**Why:** A semantic inference is insufficient authority to create executable
persistent code. Supply-chain and persistence risks exceed early benefit.

**Rejected:** autonomous self-modifying scripts/mods/hooks.

**Revisit when:** explicit user-reviewed build path includes sandbox, code
review, tests, signatures, permissions, and rollback. Keep outside baseline
learning loop.

### ADR-019: Filesystem is sole durable truth; SQLite is disposable projection

**Decision:** Markdown/JSONL/JSON and optional content-addressed blobs are
canonical; SQLite holds only FTS, vectors, links, hashes, and currently unused
temporal schema. One fact has one authoritative representation — links reference,
not copy as new support. Canonical files write first, then index syncs. Startup
reconciles Markdown by content hash. Vault-local lock + base-hash checks serialize
caught mutations; team mail uses unique event IDs. Confirmed private erasure may
delete a hash-named blob only when an erased parsed record explicitly references
its SHA-256 hash and no surviving parsed record references it; binary bytes are
never decoded or rewritten.

**Why:** Deleting `index.sqlite` must never lose knowledge. Markdown edits are
reindexed on sync, but full external-edit validation/attribution and power-loss
recovery across multi-file commits are not shipped.

**Rejected:** SQLite as canonical truth, dual-writable mirrors, treating audit or
recall traces as duplicate evidence sources.

### ADR-020: Optional Caveman packing only after bounded RAG

**Decision:** When explicitly configured with a gateway, call
`Cave.context.pack()` once at packet boundary after retrieval/filtering/quota.
Failure returns bounded original. Packed output remains transient and original
packet remains local. No savings claim exists without measurement.

Current adapter sends query plus item summaries and metadata, bypasses packing
for secret-shaped input, and discards secret-shaped output. It does not yet
verify gateway `deferredId` recovery semantics, so this path remains
experimental and default-off.

**Why:** RAG already removes irrelevant material; one final lossy selection is
enough. Packed output must never become canonical, indexed, or evidence.

**Rejected:** local compressor, dual-transform stacking, and any savings claim
without measurement.

### ADR-021: Vault-local pinned q8 embeddings

**Decision:** Pinned `Xenova/all-MiniLM-L6-v2` q8 at rev
`751bff37182d3f1213fa05d7196b954e230abad9`, `mean` + L2, 384 dims, `float32` stored
vectors in `vec0(distance_metric=cosine)`, vault-local cache under
`<vault>/models`, lazy download unless `MEMORY_OFFLINE=1`, offline after warmup.
Missing model or `sqlite-vec` yields explicit lexical-only degradation.

**Why:** Local setup, reproducible behavior across installs, portability, and
lean path to hybrid retrieval without vector service.

**Revisit when:** another quantized conversion measurably beats this one under
same tokenizer and held-out retrieval/task success.

### ADR-022: Durable mail for multi-agent work

**Decision:** Agent manifests, team workspaces, and durable message files ship.
`send` targets explicit agent/team IDs; `recall(mode="inbox")` lists direct
messages and `read` opens own or currently attached-team threads. Role/capability
routing, reviewed publication, and live delivery do not ship.

**Why:** Agents can coordinate without arbitrary peer-bank reads. Peer messages
stay attributed messages, never automatic truth.

### ADR-023: Human-inspired behavior without biological simulation

**Decision:** Treat consolidation, salience, replay, interference, source
monitoring, metacognition, and adaptive accessibility as testable design
hypotheses, not shipped biological behavior. Exclude literal neuron/engram,
neurotransmitter, and sleep-stage simulations; never claim biological
mechanisms.

**Why:** Hypotheses help; mechanism claims mislead. Every inspired feature must
prove held-out task value before shipping or remain target work.

## 3. Reference-system findings

Research snapshots used while forming design:

| System | Repository revision examined |
|---|---|
| Hindsight | `vectorize-io/hindsight` at `4b01d02f42035c248c6bf863b9231b63007b448c` |
| OpenViking | `volcengine/OpenViking` at `5e0754f371501b981294de9fe0223d432bc34faa` |
| Letta Code | `letta-ai/letta-code` at `5b3fc7bd8b6e002fdf8983f3d26311876ae9f687` |

These are snapshots from 2026-08-28. Upstream architectures and benchmark claims
may change.

### 3.1 Hindsight

Keep:

- write-time fact extraction and entity resolution;
- raw-text provenance;
- semantic, lexical, graph, and temporal retrieval idea;
- dual time axes;
- consolidation, contradiction, and evidence-backed observations;
- isolated banks;
- bounded streaming during large retention.

Reject for this product:

- PostgreSQL/pgvector and service stack as default;
- mandatory embeddings/rerankers;
- broad provider/infrastructure integration surface;
- very large MCP tool catalog;
- model-visible administrative CRUD.

Reason: strongest lessons are semantic structure and retrieval diversity, not
specific infrastructure.

Relevant local research files:

- `../../.memory-research/hindsight/hindsight-api-slim/hindsight_api/api/mcp.py`
- `../../.memory-research/hindsight/hindsight-api-slim/hindsight_api/engine/search/`
- `../../.memory-research/hindsight/hindsight-api-slim/hindsight_api/engine/consolidation/`
- `../../.memory-research/hindsight/hindsight-docs/blog/2026-07-13-inside-retain-agent-memory.md`
- `../../.memory-research/hindsight/hindsight-docs/blog/2026-08-27-retain-memory-budget.md`

### 3.2 OpenViking

Keep:

- L0/L1/L2 progressive disclosure;
- directory summaries and hierarchical navigation;
- typed resource/memory/skill separation;
- cases, trajectories, and experiences as distinct objects;
- experience rendered as Trigger/Do/Avoid/Scope/Check;
- task-gated experience retrieval;
- trajectory-to-experience lineage;
- evaluation feedback injected into trajectory analysis;
- removing recalled context before recapture;
- explicit tenant/user/peer scopes.

Reject for this product:

- large Python dependency and ingestion stack;
- mandatory server/vector infrastructure;
- LLM planning for ordinary search;
- full platform abstraction when local files and SQLite suffice.

Relevant local research files:

- `../../.memory-research/openviking/docs/en/concepts/03-context-layers.md`
- `../../.memory-research/openviking/docs/en/concepts/07-retrieval.md`
- `../../.memory-research/openviking/docs/en/concepts/08-session.md`
- `../../.memory-research/openviking/docs/design/openclaw-agent-experience-memory-design.md`
- `../../.memory-research/openviking/openviking/session/memory/agent_experience_context_provider.py`
- `../../.memory-research/openviking/openviking/session/memory/experience_lineage.py`
- `../../.memory-research/openviking/openviking/session/train/domain.py`
- `../../.memory-research/openviking/openviking/session/train/components/trajectory_analyzer.py`

### 3.3 Letta Code

Keep:

- persistent agent identity independent of current model engine;
- editable future token-space context;
- immutable message history separated from editable semantic state;
- root always-on context versus deferred child content;
- background reflection concept;
- auditable context evolution;
- separately attached shared memory;
- skills as procedural memory;
- warning that tool schemas themselves consume context.

Reject for this product:

- replacing Claude host with an entire agent harness;
- treating raw message history as "experience" in this ontology;
- large always-on core target;
- mandatory Git workflow;
- broad autonomous context/harness modification;
- unrestricted reflection agent as authority.

Relevant local research files:

- `../../.memory-research/letta-code/src/agent/prompts/letta_root_memfs.md`
- `../../.memory-research/letta-code/src/agent/subagents/builtin/reflection-v2.md`
- `../../.memory-research/letta-code/src/agent/subagents/builtin/memory-v2.md`
- `../../.memory-research/letta-code/src/tools/descriptions/MemoryV2.md`
- `../../.memory-research/letta-code/src/skills/builtin/context-doctor/ROOT_MEMORY.md`

## 4. Rejected shortcuts

### "Store everything and let vector search solve it"

Fails because retrieval does not establish truth, time, scope, outcome, or
applicability. It also makes deletion, audit, contradiction, and policy
activation ambiguous.

### "Summarize every session into experience"

Fails because sessions can contain unrelated intents, unknown outcomes, model
mistakes, and recalled-content contamination.

### "Put frequently recalled items into system prompt"

Frequency can indicate recurring noise, not value. Core promotion requires
broad measured utility per byte and strong evidence.

### "Success means exit code zero"

Tool execution can succeed while user goal fails. Outcome evidence hierarchy
must remain richer.

### "Use confidence threshold from extractor"

Self-reported confidence is not calibrated evidence. System state transition
uses deterministic source/outcome rules.

### "Share all agents' memories to maximize learning"

Creates privacy leakage, identity contamination, incompatible environment
rules, and untraceable negative transfer. Share explicitly by reference.

### "MCP server instructions make memory automatic"

They can encourage behavior but cannot force tool use or provide missing host
lifecycle events.

### "Git gives audit, so no internal journal needed"

Git does not encode semantic lineage, source events, usage attribution, or
privacy erasure by itself and is too heavy for every event.

### "Human-like learning requires deep-learning infrastructure"

This layer cannot train weights. Its useful target is evidence-backed
in-context policy adaptation. Calling it deeper learning would misstate
capability.

## 5. Change checklist

Any future architecture proposal must answer:

1. Which measured failure exists?
2. Which invariant remains intact?
3. Is solution possible through deletion, schema change, SQL, or stdlib first?
4. Does change add model-visible schema tokens?
5. Does it add always-on prompt tokens?
6. Does it add service, credential, native binary, or provider dependency?
7. How does it affect bank isolation and shared ownership?
8. How does it affect evidence provenance and recursive contamination?
9. How does it affect user erasure and rebuild?
10. What benchmark demonstrates benefit under equal conditions?
11. What is migration path?
12. What is rollback path?
13. What new failure modes appear?
14. Which documentation and ADR must change?

A new component without answers is not architecture; it is dependency drift.
