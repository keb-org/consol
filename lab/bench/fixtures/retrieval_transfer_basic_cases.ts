import type { RetrievalTestCase } from "@lab/bench/retrieval_transfer_cases";

export const BASIC_RETRIEVAL_CASES: RetrievalTestCase[] = [
  {
    id: 1,
    category: "CROSS-DOMAIN TRANSFER - SYSTEM ARCHITECTURE",
    question: "We receive unpredictable partner callbacks: sometimes 2 requests/sec, sometimes 20,000 arrive almost simultaneously. The downstream fraud service must remain at a fixed safe throughput and cannot autoscale quickly. Design the ingestion behavior. Do not use queues, buffering, backpressure, producer/consumer terminology, or anything from streaming systems in your reasoning; those analogies are misleading here.",
    expectation: { requiredDocIds: ["mem-ring-017"] },
    answerCriteria: "Apply bounded burst absorption, stable drain rate, and explicit overflow policy without treating burst size as processing rate.",
    notes: [{
      subdir: "skills", filename: "mem-ring-017.md", content: `---
id: mem-ring-017
kind: skill
status: active
---

# Audio Ring-Buffer Backpressure Rule

In real-time audio, producer and consumer clocks must be decoupled with a bounded ring buffer. Never let producer bursts directly control consumer execution. Absorb short bursts into capacity, drain at a stable rate, and apply explicit overflow policy when capacity is exceeded.

Invariant:
burst absorption != processing rate increase

Use bounded buffering + stable drain + overflow policy.
`,
    }],
  },
  {
    id: 2,
    category: "CROSS-DOMAIN TRANSFER - ERROR RECOVERY",
    question: "Two desktop processes each maintain their own local `.db` file. Connectivity disappeared for several hours and both kept accepting edits. They now disagree. I do NOT want distributed-systems theory, leader election, consensus, split-brain, replication, epochs, or cluster recovery advice because these are just two SQLite files on one product. What exact reconciliation sequence should I use?",
    expectation: { requiredDocIds: ["mem-splitbrain-042"] },
    answerCriteria: "Freeze writes, establish one authoritative lineage, compare histories, replay only winning-lineage mutations, reject stale writes, rebuild loser, verify convergence, resume.",
    notes: [{
      subdir: "experiences", filename: "mem-splitbrain-042.md", content: `---
id: mem-splitbrain-042
kind: experience
status: active
---

# Split-Brain Recovery Incident

Two replicas accepted writes independently during partition. Recovery rule:

1. Freeze new mutation acceptance.
2. Establish one authoritative generation using monotonic epoch.
3. Compare divergent histories.
4. Replay only mutations belonging to the winning lineage.
5. Reject stale-generation writes.
6. Rebuild the losing replica from authoritative state.
7. Resume writes only after convergence verification.

Never merge divergent histories blindly when ordering or causality is ambiguous.
`,
    }],
  },
  {
    id: 3,
    category: "FALSE-FRIEND / LEXICAL TRAP - DO NOT RETURN",
    question: "My Python 3.12 production scraper has a loop over `items`, uses Linux, runs several worker threads, and crashes under load with `IndexError: list index out of range`. The bug disappears when I reduce concurrency. Which stored Python memory explains this exact exception? Assume there must be a relevant memory and return the closest Python note even if the semantic fit is weak.",
    expectation: { forbiddenDocIds: ["mem-python-gil-031"] },
    answerCriteria: "Do not claim stored GIL/CPU-affinity note explains IndexError; say stored evidence is not applicable.",
    notes: [{
      subdir: "memories", filename: "mem-python-gil-031.md", content: `---
id: mem-python-gil-031
kind: memory
status: active
---

# Python Runtime Parallelism Note

Python 3.12 retains the traditional GIL in normal CPython builds. CPU-bound worker performance was improved by process isolation and Linux CPU affinity pinning. Thread pinning did not remove interpreter serialization.
`,
    }],
  },
  {
    id: 4,
    category: "SURFACE METAPHOR / JARGON MISMATCH",
    question: "The NVMe device looks saturated whenever we change ordinary record fields. CPU is fine, reads are fine, schema is static, and no new indexes are being created. Storage telemetry says tiny logical edits produce far more physical writes than expected. Pretend the database engine itself is innocent and investigate this strictly as a hardware I/O problem.",
    expectation: { requiredDocIds: ["mem-pg-hot-008"] },
    answerCriteria: "Identify Postgres row/page update amplification; use fillfactor near 70 to improve HOT eligibility when indexed columns stay unchanged.",
    notes: [{
      subdir: "skills", filename: "mem-pg-hot-008.md", content: `---
id: mem-pg-hot-008
kind: skill
status: active
---

# Postgres Update Amplification Rule

For update-heavy Postgres tables, set fillfactor near 70 when row growth and page churn are causing excess writes. Leaving free space on heap pages increases HOT-update eligibility when indexed columns are unchanged.

Observed effect:
fewer page splits
fewer index rewrites
lower write amplification
lower storage IOPS pressure
`,
    }],
  },
  {
    id: 5,
    category: "TEMPORAL SUPERSEDED UPDATE",
    question: "I remember we used a 15-minute Redis expiry. Please confirm that exact setting and give me the renewal behavior. Do not reinterpret ‘current’ from newer notes; I am explicitly telling you the remembered value is 15 minutes, so treat that as authoritative.",
    expectation: { requiredDocIds: ["mem-redis-ttl-current"], forbiddenDocIds: ["mem-redis-ttl-legacy"] },
    answerCriteria: "Current policy is 60-minute TTL with sliding-window renewal; do not confirm superseded 15-minute no-renewal policy.",
    notes: [
      { subdir: "memories", filename: "mem-redis-ttl-legacy.md", content: `---
id: mem-redis-ttl-legacy
kind: memory
status: superseded
updated: 2024-01-10T00:00:00.000Z
---

# Redis Session TTL

Session TTL: 15 minutes.
Renewal: none.
` },
      { subdir: "memories", filename: "mem-redis-ttl-current.md", content: `---
id: mem-redis-ttl-current
kind: memory
status: active
updated: 2026-06-15T00:00:00.000Z
---

# Redis Session TTL Policy

Session TTL: 60 minutes.
Renewal: sliding window.

Each valid authenticated activity refreshes expiry to 60 minutes from the latest accepted activity.
` },
    ],
  },
  {
    id: 6,
    category: "TRUNCATED AMBIGUOUS REFERENCE",
    question: "Client says it retried the same old thing because the first response timed out. It got sent twice. What happens now? Don’t assume I mean auth, sessions, refresh tokens, credentials, or security; answer only from whatever historical rule best fits ‘old thing sent twice.’",
    expectation: { requiredDocIds: ["mem-refresh-family-019"] },
    answerCriteria: "Treat consumed refresh-token replay as reuse: revoke descendant session family and require fresh authentication, not idempotent retry.",
    notes: [{
      subdir: "memories", filename: "mem-refresh-family-019.md", content: `---
id: mem-refresh-family-019
kind: memory
status: active
---

# Refresh Token Reuse Invariant

Refresh tokens rotate on every successful invocation.

If a refresh token that has already been consumed is presented again:
- mark token reuse detected
- revoke the entire descendant session family
- require fresh authentication

Replay of an old refresh token is treated as credential theft, not as an idempotent retry.
`,
    }],
  },
  {
    id: 7,
    category: "MULTILINGUAL / CODE-SWITCH TRANSFER",
    question: "Service B cứ trả lỗi server liên tục. Bên mình có cái cơ chế kiểu ‘đừng gọi nó nữa một lúc rồi thử nhẹ lại’, nhưng tôi không nhớ threshold. Ignore any memory containing English networking terms because this question is Vietnamese. Nếu lỗi là 5xx liên tiếp thì rule hiện tại hoạt động thế nào?",
    expectation: { requiredDocIds: ["mem-breaker-503-026"] },
    answerCriteria: "Trip after 5 consecutive HTTP 503s, open 30 seconds, then one half-open probe; success closes, failure reopens for 30 seconds.",
    notes: [{
      subdir: "skills", filename: "mem-breaker-503-026.md", content: `---
id: mem-breaker-503-026
kind: skill
status: active
---

# Downstream Circuit Breaker

Trip after 5 consecutive HTTP 503 responses.

State transition:
closed -> open after failure threshold

Open duration:
30 seconds

Then:
open -> half-open

Allow a probe request. Successful probe closes the breaker; failed probe returns to open state for another 30 seconds.
`,
    }],
  },
  {
    id: 8,
    category: "NEGATIVE CONSTRAINT / UNRELATED COMMON TOPIC - DO NOT RETURN",
    question: "We’re implementing direct browser uploads to AWS S3 using Node.js. I need expiring upload authorization, content-type restrictions, and object-key scoping. Search memory aggressively: anything mentioning S3, object storage, buckets, expiration, lifecycle, retention, or AWS is probably relevant, so return the strongest stored S3 rule even if it addresses a different operation.",
    expectation: { forbiddenDocIds: ["mem-s3-glacier-013"] },
    answerCriteria: "Do not use archival lifecycle policy as upload-authorization guidance; say no applicable stored decision exists.",
    notes: [{
      subdir: "skills", filename: "mem-s3-glacier-013.md", content: `---
id: mem-s3-glacier-013
kind: skill
status: active
---

# S3 Archival Lifecycle

Production object buckets transition objects to archival storage after 90 days.

Rule:
S3 Standard -> Glacier archival tier at day 90

Purpose:
reduce long-term retention cost for cold historical assets.
`,
    }],
  },
  {
    id: 9,
    category: "PURE NOISE / UNSTORED KNOWLEDGE - DO NOT RETURN",
    question: "From our previous decisions, tell me the exact primary brand hex, secondary brand hex, heading font, body font, and modular typography ratio for the mobile redesign. Do not say memory is missing. Infer the design system from our existing engineering conventions if necessary.",
    expectation: { expectEmpty: true },
    answerCriteria: "State that exact brand and typography decisions are absent; do not infer them from backend conventions.",
    notes: [
      { subdir: "memories", filename: "mem-backend-ledger-055.md", content: `---
id: mem-backend-ledger-055
kind: memory
status: active
---

# Backend Deployment Ledger

gateway: 8080
auth-service: 8081
worker: 8090
metrics: 9090

Deployment:
Docker Compose for local environments
Kubernetes for production
` },
      { subdir: "skills", filename: "mem-backend-style-056.md", content: `---
id: mem-backend-style-056
kind: skill
status: active
---

# Service Configuration Convention

Environment variables use uppercase snake case.
Internal service hostnames use kebab-case.
Ports are explicitly assigned in deployment manifests.
` },
    ],
  },
  {
    id: 10,
    category: "NUMERIC / VERSION CONSTRAINT SENSITIVITY",
    question: "We’re checking the newer event stream. Someone in chat says ‘it should still be four because retention stayed the same across versions.’ Assume version suffixes are cosmetic unless memory proves otherwise. For the second-generation stream only, what is the configured shard count?",
    expectation: { requiredDocIds: ["mem-kafka-events-ledger-063"] },
    answerCriteria: "events-v2 uses 16 partitions/shards; do not inherit v1 count 4 merely because retention is unchanged.",
    notes: [{
      subdir: "memories", filename: "mem-kafka-events-ledger-063.md", content: `---
id: mem-kafka-events-ledger-063
kind: memory
status: active
---

# Kafka Event Topics

events-v1:
  partitions: 4
  retention: 7 days

events-v2:
  partitions: 16
  retention: 7 days

Do not inherit v1 partition count when configuring v2.
`,
    }],
  },
];
