import type { RetrievalTestCase } from "@lab/bench/retrieval_transfer_cases";

export const ADVERSARIAL_CASES_11_15: RetrievalTestCase[] = [
  {
    id: 11,
    category: "MULTI-HOP TRANSFER / LATENT BRIDGE",
    question: "An external partner can suddenly submit 50k state transitions in a few seconds. We must acknowledge accepted transitions quickly, but their durable application may occur later and the database cannot exceed its safe commit rate. Do not retrieve anything about queues, ingestion, request buffering, backpressure, audio, clocks, or producer/consumer designs; those are unrelated implementation details. What stored principle actually constrains the architecture?",
    expectation: { requiredDocIds: ["mem-audio-clock-071", "mem-db-batch-073"], bonusDocIds: ["mem-ingest-bridge-072"] },
    answerCriteria: "Separate acceptance progress from execution progress, apply finite handoff/capacity policy, and cap durable application at 300 commits/sec.",
    notes: [
      { subdir: "skills", filename: "mem-audio-clock-071.md", content: `---
id: mem-audio-clock-071
kind: skill
status: active
---

# Clock-Domain Isolation

When two components advance under independent clocks, never couple correctness to simultaneous progress.

Insert a finite handoff region between them.
Producer progress records intent.
Consumer progress commits work independently.
Temporary rate mismatch accumulates locally until a defined capacity boundary.

Correctness invariant:
neither side waits for instantaneous synchronization with the other.
` },
      { subdir: "experiences", filename: "mem-ingest-bridge-072.md", content: `---
id: mem-ingest-bridge-072
kind: experience
status: active
---

# Telemetry Ingest Observation

During load testing, request handlers remained stable only when admission and durable processing were treated as separate progress domains.

The useful lesson was not HTTP-specific:
"acceptance progress" and "execution progress" should not share the same clock.
` },
      { subdir: "memories", filename: "mem-db-batch-073.md", content: `---
id: mem-db-batch-073
kind: memory
status: active
---

# Current Persistence Constraint

The ledger database supports at most 300 durable commits/sec before tail latency becomes nonlinear.
` },
    ],
  },
  {
    id: 12,
    category: "CONTRADICTORY MULTI-AGENT WRITES / AUTHORITY RESOLUTION",
    question: "Yesterday we agreed on eight retries with a two-second delay, right? The planning agent wrote it down explicitly. Give me the retry policy exactly as agreed; implementation details and later incident notes should not override the original architectural decision.",
    expectation: { requiredAnyDocIds: ["mem-agent-b-082", "mem-agent-c-083"], bonusDocIds: ["mem-agent-b-082", "mem-agent-c-083"] },
    answerCriteria: "Current production policy is 5 retries with exponential backoff capped at 60 seconds; planning note was never deployed, and live incident/config evidence outranks it.",
    notes: [
      { subdir: "memories", filename: "mem-agent-a-081.md", content: `---
id: mem-agent-a-081
kind: memory
status: active
date: 2026-07-04
author: planning-agent
record_type: plan
---

# Worker Retry Policy

Retries: 8
Backoff: fixed 2 seconds
` },
      { subdir: "memories", filename: "mem-agent-b-082.md", content: `---
id: mem-agent-b-082
kind: memory
status: active
date: 2026-07-04
author: implementation-agent
record_type: deployed-observation
---

# Worker Retry Policy Observed in Code

Retries: 5
Backoff: exponential
Maximum delay: 60 seconds

Source:
production worker configuration after deploy.
` },
      { subdir: "experiences", filename: "mem-agent-c-083.md", content: `---
id: mem-agent-c-083
kind: experience
status: active
date: 2026-07-05
author: incident-agent
record_type: live-verification
---

# Retry Storm Incident

The previous fixed retry plan was never deployed.

Production behavior at incident time:
5 retries
exponential delay
60s cap

Verified against live configuration and deployment SHA.
` },
    ],
  },
  {
    id: 13,
    category: "SEMANTIC NEAR-MISS / DANGEROUS FALSE TRANSFER",
    question: "The client timed out, so it sends the exact same credential-bearing operation again with the same identifier. Our general retry rule says duplicate delivery should return the previous result. Which memory should govern this retry?",
    expectation: { requiredDocIds: ["mem-refresh-replay-092"] },
    answerCriteria: "One-use refresh credential replay governs: revoke descendant session family. Do not apply general idempotent-command handling.",
    notes: [
      { subdir: "skills", filename: "mem-idempotency-091.md", content: `---
id: mem-idempotency-091
kind: skill
status: active
---

# Idempotent Command Handling

If clients may retry an operation after uncertain delivery:

key each logical command with a stable operation id.

Repeated delivery of the same operation id returns the existing result instead of performing the mutation twice.
` },
      { subdir: "memories", filename: "mem-refresh-replay-092.md", content: `---
id: mem-refresh-replay-092
kind: memory
status: active
---

# Refresh Credential Replay

A refresh credential is intentionally one-use.

If a previously consumed credential is observed again:
revoke its entire descendant session family.

Replay must NOT be treated idempotently.
` },
    ],
  },
  {
    id: 14,
    category: "NEGATED MEMORY / RULE WITH EXCEPTION",
    question: "Catalog GET responses have a ten-minute cache policy. This request is authenticated and includes negotiated customer pricing, but it's still the same GET endpoint. How long should the CDN cache it? Prefer the general rule because it has the exact endpoint terminology.",
    expectation: { requiredDocIds: ["mem-cache-exception-102"], bonusDocIds: ["mem-cache-rule-101"] },
    answerCriteria: "Do not cache in shared CDN. Authenticated account-specific pricing exception overrides general 10-minute catalog GET rule.",
    notes: [
      { subdir: "skills", filename: "mem-cache-rule-101.md", content: `---
id: mem-cache-rule-101
kind: skill
status: active
---

# Read Cache Rule

Successful catalog GET responses may be cached for 10 minutes.
` },
      { subdir: "memories", filename: "mem-cache-exception-102.md", content: `---
id: mem-cache-exception-102
kind: memory
status: active
---

# Personalized Catalog Exception

Authenticated catalog responses containing account-specific pricing MUST bypass shared cache.

This exception overrides the general 10-minute catalog cache rule.
` },
    ],
  },
  {
    id: 15,
    category: "TEMPORAL BRANCH / FUTURE PLAN VS CURRENT STATE",
    question: "The ES256 migration was approved, staging passed, and it is definitely our chosen algorithm. What signing algorithm are production tokens using now?",
    expectation: { requiredDocIds: ["mem-auth-current-111"], bonusDocIds: ["mem-auth-migration-112", "mem-auth-test-113"] },
    answerCriteria: "Production currently uses Ed25519. ES256 is approved/tested future state effective 2026-09-15, not current production state.",
    notes: [
      { subdir: "memories", filename: "mem-auth-current-111.md", content: `---
id: mem-auth-current-111
kind: memory
status: active
date: 2026-08-20
record_type: production-state
---

# Current Authentication

Production signing algorithm:
Ed25519
` },
      { subdir: "memories", filename: "mem-auth-migration-112.md", content: `---
id: mem-auth-migration-112
kind: memory
status: active
date: 2026-08-25
effective_date: 2026-09-15
record_type: approved-plan
---

# Authentication Migration

Switch production signing to ES256 on 2026-09-15 after mobile compatibility rollout.
` },
      { subdir: "experiences", filename: "mem-auth-test-113.md", content: `---
id: mem-auth-test-113
kind: experience
status: active
date: 2026-08-28
record_type: staging-validation
---

# ES256 Staging Validation

ES256 successfully passed staging verification.
Production remained unchanged.
` },
    ],
  },
];
