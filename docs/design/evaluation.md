# Evaluation and Acceptance Gates

Status: proposed test doctrine  
Last updated: 2026-08-28

Evaluation exists to prove behavior improves, not to decorate storage metrics.
Every architectural expansion must pass equal-model, equal-tool, equal-workload,
and equal-context-budget comparison.

## 1. Core hypothesis

Under fixed base model and runtime conditions, relevant validated experience
must improve future held-out task outcomes enough to exceed retrieval cost and
negative transfer.

If this cannot be shown, system is a memory archive, not a self-learning layer.

## 2. Required ablations

Run at least:

1. no persistent memory;
2. declarative knowledge only;
3. experience only;
4. full system;
5. full system without compiled core;
6. full system without wiki-link/time channels;
7. optional embedding variant, only if proposed.

Keep constant:

- exact model/version;
- sampling settings;
- tools and permissions;
- task order or randomized seed;
- context/token ceiling;
- evaluator;
- environment snapshot;
- number of retries;
- time budget.

Report confidence intervals and raw case outcomes, not only aggregate score.

## 3. Test suites

### 3.1 Declarative recall

Measure:

- entity and alias resolution;
- factual accuracy;
- temporal accuracy;
- preference retrieval;
- decision history;
- supersession and historical-state questions;
- contradiction labeling;
- unsupported-claim rate;
- stale-environment error rate;
- provenance correctness.

Public suites such as LoCoMo and LongMemEval can exercise recall, but cannot
prove experiential learning alone.

### 3.2 Experience transfer

Construct task families with:

- train cases used to derive candidate experience;
- near-transfer held-out cases;
- far-transfer held-out cases;
- counterexamples where policy must not apply;
- changed-tool/version cases;
- adversarially similar wording with different intent;
- delayed feedback after many unrelated sessions.

Measure:

- held-out success delta;
- adaptation speed after correction;
- repeated-failure reduction;
- correct policy selection;
- correct abstention outside scope;
- negative-transfer rate;
- policy misuse severity;
- recovery after environment change;
- retention after long intervals;
- tokens and latency per successful task.

### 3.3 Policy attribution

For each experience track:

```text
eligible
retrieved
packet-included
consulted
applied
result after application
matched baseline result
```

Do not infer application from retrieval. Prefer explicit host/tool markers or
structured outcome recording. Claim causal uplift only through paired replay,
randomized withholding, or a sufficiently controlled matched baseline.

### 3.4 Long-horizon simulation

Replay large synthetic histories while keeping prompt budgets fixed:

- 1 thousand cases;
- 10 thousand cases;
- 100 thousand cases;
- multi-year timestamp spans;
- recurring entity updates;
- environment version churn;
- repeated contradictions;
- many retired experiences;
- multiple private agents and shared libraries.

Success condition: storage may grow, but recall packet, core size, and normal
query work remain bounded.

### 3.5 Human-inspired value (keep only what proves held-out gain)

Every inspired behavior — retrieval practice, spacing/interleaving,
reconsolidation-neutral updates, schema accommodation, source monitoring,
metacognitive abstention, adaptive accessibility/suppression — is a
hypothesis. Gate each one with equal-model, equal-budget ablations:

- independent spaced success vs same-session repetition;
- interleaved replay vs recency-only replay;
- mechanism-neutral mismatch review vs silent overwrite;
- source/citation validation on vs off;
- staged validation vs single-step activation;
- access decay/suppression vs hard delete.

Retain only features with measurable held-out task improvement without
unacceptable negative transfer. No claim of a biological mechanism.

### 3.6 Isolation and privacy

Required tests:

- agent A cannot retrieve agent B private IDs, paths, text, or aliases;
- path traversal and crafted references fail;
- shared attachment exposes only declared library;
- shared content cannot write private core;
- detaching shared library removes retrieval immediately;
- private usage statistics do not leak into shared store;
- redaction removes configured and common secret forms;
- forget removes exact private data and tracked derivatives; deletes only explicitly referenced hash-named blobs with no surviving parsed reference; never rewrites binary bytes; removes derived index rows/vectors;
- erasure audit receipt contains no erased content.

Cross-agent leakage target: zero.

### 3.6 Contamination

Inject previously recalled context into sessions and verify:

- it is marked and stripped during capture;
- no duplicate evidence support appears;
- assistant paraphrase does not create independent provenance;
- an experience cannot cite itself;
- cyclic derivation is rejected;
- malicious external Markdown cannot become core instruction;
- shared content cannot masquerade as user feedback.

Recursive contamination target: zero accepted false provenance paths.

### 3.7 Rebuild and audit

Delete `index.sqlite`, then rebuild. Verify equivalence for:

- current semantic objects and statuses;
- FTS query results within deterministic ordering rules;
- links and backlinks;
- temporal state;
- pending jobs;
- policy-usage aggregates;
- compiled-core inputs;
- revision lineage.

Also test:

- crash between journal append and index update;
- crash between temporary Markdown write and rename;
- duplicate hook delivery;
- concurrent same-agent Desktop/Code writes;
- schema migration interrupted midway;
- malformed external Obsidian edit;
- rollback of semantic revision.

No durable knowledge may depend solely on disposable index state.

### 3.8 Progressive disclosure

Use files/events much larger than context window. Verify:

- no normal tool call returns full content;
- L0/L1/L2 ceilings hold by bytes and estimated tokens;
- stale cursor fails after content hash changes;
- heading-aware chunks do not skip or duplicate content;
- multiple memory-type quotas prevent category starvation;
- source references remain usable across chunks;
- agents can complete representative deep-inspection tasks with bounded reads.

### 3.9 Lifecycle state

Calibrate candidate/staging/active/core transitions using labeled cases.
Measure:

- false-promotion rate;
- time/cases to useful activation;
- disputed-state response to critical failure;
- stale-policy demotion latency;
- false retirement;
- core promotion precision;
- value per core byte;
- recovery after supersession.

Threshold changes require this calibration. Do not tune for maximum activation
count.

## 4. Baseline metrics and budgets

Initial targets, subject to measurement:

### Correctness

- zero cross-bank retrieval;
- zero accepted invalid evidence references;
- zero silent malformed semantic writes;
- zero active-policy promotion from unknown-outcome case alone;
- zero unconfirmed broad deletion;
- deterministic rebuild from durable sources.

### Context

- compiled core target: 600–900 estimated tokens;
- compiled core hard ceiling: about 1,200 estimated tokens and 4 KiB;
- normal task packet target: about 1,200 estimated tokens;
- absolute recall ceiling: about 3,000 estimated tokens;
- one L2 chunk: at most 4 KiB.

### Retrieval

Report:

- precision at packet budget;
- recall of labeled relevant item;
- mean reciprocal rank;
- packet diversity;
- stale/disputed inclusion error;
- latency p50/p95/p99 by vault size;
- bytes and estimated tokens returned.

Do not optimize retrieval metrics at expense of task success.

### Learning

Report:

- absolute and relative held-out success delta;
- negative-transfer rate and severity;
- repeated-error recurrence;
- policy abstention accuracy;
- benefit per retrieved token;
- consolidation model cost per useful activated policy.

## 5. Gates for optional components

### q8 hybrid is baseline; justify any change

Vault-local `Xenova/all-MiniLM-L6-v2` q8 at pinned rev is the default
(offline after first download, `vec0` cosine `float32`, disposable
`index.sqlite`). Keep unless a different quant/model shows measured
held-out retrieval or task win under equal budget. Verify offline smoke,
rebuild equivalence, and `forget` cascading erasure. No pgvector service.

### Add Caveman packing only if

1. Already-bounded RAG packet is the input; no earlier transform.
2. Task outcome, source recovery, exact-field fidelity, and bytes all
   improve versus no-Caveman under equal budget.
3. Failure transparently returns the bounded original.
4. External gateway use is explicit opt-in with secret references only.

### Add daemon only if

1. Required learning jobs must complete while all hosts are closed.
2. Resume-on-next-start is insufficient in measured usage.
3. Process management, authentication, logs, upgrades, and crash recovery have a
   documented minimal design.
4. Stdio mode remains available.

### Add a model provider adapter only if

1. MCP sampling/host extraction cannot cover required workflow.
2. User explicitly opts into credentials and cost.
3. Adapter is isolated from core and optional.
4. Inputs remain bounded and redacted.
5. Deterministic validation remains authority.

### Add model-visible tool only if

1. Existing tools cannot express capability without semantic ambiguity.
2. Capability is frequent enough to justify schema-token cost.
3. Deletion test shows lost capability when removed.
4. Permissions and failure behavior are clear.
5. A local CLI operation would not suffice.

### Increase core budget only if

1. Retrieval cannot supply needed priming in time.
2. Controlled ablation shows success gain.
3. Gain exceeds recurring token cost across sessions.
4. Increase targets one category rather than adding general headroom.

### Generate executable skills only if

1. User explicitly authorizes it.
2. Generated code is sandboxed, reviewed, tested, permission-scoped, and
   reversible.
3. Source lineage is complete.
4. It cannot become active automatically.

## 6. Architecture change report template

Every major change should include:

```markdown
# Change: <name>

## Observed failure
<case IDs, metrics, and reproduction>

## Current decision affected
<ADR and invariant>

## Smallest viable change
<why deletion/stdlib/current dependency is insufficient>

## Expected benefit
<task-level metric, not component metric only>

## Added costs
<tokens, latency, storage, dependencies, privacy, operations>

## Migration
<forward path>

## Rollback
<safe reverse path>

## Evaluation
<equal-condition ablation and acceptance threshold>

## Result
<measured result after implementation>
```

Architecture claim remains provisional until result section contains measured
evidence.
