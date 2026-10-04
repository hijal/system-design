# Exercises

`course/main.md` §৬ অনুযায়ী প্রতিটা **Tier 1 (runnable code)** আর **Tier 2 (infra setup)**
exercise এখানে আলাদা, চালানোর মতো project হিসেবে থাকে — lesson এর ভেতরে code block
copy-paste করতে হয় না।

Tier 3 (design exercise) এখানে থাকে না — সেখানে চিন্তাটাই deliverable, code নেই।

| Exercise                                                                           | Lesson                                              | Tier | কী দেখায়                                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| [`lesson-2.5-idempotency/`](lesson-2.5-idempotency/)                               | 2.5 — API Design at Scale                           | 1    | Idempotency-Key দিয়ে retry-safe POST                                                                   |
| [`lesson-3.3-nginx-reverse-proxy/`](lesson-3.3-nginx-reverse-proxy/)               | 3.3 — Reverse Proxy vs Forward Proxy                | 2    | Nginx reverse proxy + Round Robin LB                                                                    |
| [`lesson-4.4-redis-cache/`](lesson-4.4-redis-cache/)                               | 4.4 — Redis Hands-on                                | 1    | Cache-Aside + invalidate-on-write, মাপা সহ                                                              |
| [`lesson-5.2-data-modeling/`](lesson-5.2-data-modeling/)                           | 5.2 — Schema & Data Modeling                        | 1    | Anomaly, denormalized counter, মাপা সহ                                                                  |
| [`lesson-5.4-indexing/`](lesson-5.4-indexing/)                                     | 5.4 — Indexing Deep Dive                            | 1    | EXPLAIN ANALYZE lab, index এর লেখার দাম                                                                 |
| [`lesson-5.5-transactions/`](lesson-5.5-transactions/)                             | 5.5 — Transactions & Isolation                      | 1    | Anomaly timeline, lost update এর ৭টা সমাধান                                                             |
| [`lesson-5.6-pooling-nplusone/`](lesson-5.6-pooling-nplusone/)                     | 5.6 — Connection Pooling & N+1                      | 1    | Pool size sweep, N+1, hydration মাপা                                                                    |
| [`lesson-5.7-replication/`](lesson-5.7-replication/)                               | 5.7 — Replication                                   | 2    | Primary + replica, lag, read-your-writes, failover                                                      |
| [`lesson-5.8-sharding/`](lesson-5.8-sharding/)                                     | 5.8 — Sharding & Partitioning                       | 1    | Partition pruning, retention, shard key, scatter-gather                                                 |
| [`lesson-5.9-quorum/`](lesson-5.9-quorum/)                                         | 5.9 — CAP & Quorum                                  | 1    | Quorum simulation (R+W>N), CP বনাম AP partition                                                         |
| [`lesson-6.1-split-brain/`](lesson-6.1-split-brain/)                               | 6.1 — Failure Model & Split Brain                   | 1    | Timeout trade-off, process pause, fencing token                                                         |
| [`lesson-6.2-raft/`](lesson-6.2-raft/)                                             | 6.2 — Consensus & Raft                              | 1    | Raft election, partition, election restriction                                                          |
| [`lesson-6.3-session-guarantees/`](lesson-6.3-session-guarantees/)                 | 6.3 — Quorum in Practice                            | 1    | Replica routing, consistent prefix, read repair                                                         |
| [`lesson-6.4-logical-clocks/`](lesson-6.4-logical-clocks/)                         | 6.4 — Logical Clocks                                | 1    | Clock skew LWW, Lamport, vector clock + siblings                                                        |
| [`lesson-6.5-consistency-models/`](lesson-6.5-consistency-models/)                 | 6.5 — Consistency Models                            | 1    | History checker (mini Jepsen), model ladder                                                             |
| [`lesson-7.1-async-thinking/`](lesson-7.1-async-thinking/)                         | 7.1 — Async Thinking                                | 1    | ধীর provider, cascading failure, sync বনাম queue                                                        |
| [`lesson-7.2-queue-vs-pubsub/`](lesson-7.2-queue-vs-pubsub/)                       | 7.2 — Message Queue vs Pub/Sub                      | 1    | Queue, pub/sub, log: fanout, crash, replay, ordering                                                    |
| [`lesson-7.3-bullmq/`](lesson-7.3-bullmq/)                                         | 7.3 — BullMQ Hands-on                               | 1    | API/worker/Redis crash, stalled job, retry, job ID dedupe                                               |
| [`lesson-7.4-reliable-consumers/`](lesson-7.4-reliable-consumers/)                 | 7.4 — Idempotency, Retry, DLQ, Backpressure         | 1    | Crash point গোনা, retry storm, poison/DLQ, backpressure                                                 |
| [`lesson-7.5-outbox/`](lesson-7.5-outbox/)                                         | 7.5 — Event-Driven Architecture                     | 1    | Dual write বনাম transactional outbox, crash আর Redis outage সহ                                          |
| [`lesson-7.6-batch-stream-olap/`](lesson-7.6-batch-stream-olap/)                   | 7.6 — Batch vs Stream, OLTP vs OLAP                 | 1    | Postgres বনাম DuckDB, OLTP এর উপর analytics এর চাপ, watermark                                           |
| [`lesson-8.1-object-storage/`](lesson-8.1-object-storage/)                         | 8.1 — Object / Blob Storage                         | 1    | bytea বনাম object storage, stateless, erasure coding, S3 API                                            |
| [`lesson-8.2-file-upload/`](lesson-8.2-file-upload/)                               | 8.2 — File Upload at Scale                          | 1    | App এর ভেতর দিয়ে বনাম presigned, multipart resume, CDN cache key                                       |
| [`lesson-8.3-search/`](lesson-8.3-search/)                                         | 8.3 — Search & Inverted Index                       | 1    | ILIKE বনাম trigram বনাম full-text, নিজের inverted index, BM25                                           |
| [`lesson-9.1-monolith-vs-microservices/`](lesson-9.1-monolith-vs-microservices/)   | 9.1 — Monolith vs Microservices                     | 1    | Function বনাম network call, আলাদা ব্যর্থতা, ভাঙা transaction                                            |
| [`lesson-9.2-gateway-bff/`](lesson-9.2-gateway-bff/)                               | 9.2 — API Gateway & BFF                             | 1    | BFF বনাম সরাসরি (round trip, byte), gateway এর দাম, পরিচয়, canary                                      |
| [`lesson-9.3-saga-2pc/`](lesson-9.3-saga-2pc/)                                     | 9.3 — Distributed Transactions: Saga, 2PC           | 1    | আসল 2PC আর in-doubt lock, saga এর recovery আর idempotency, isolation                                    |
| [`lesson-9.4-discovery-breaker-bulkhead/`](lesson-9.4-discovery-breaker-bulkhead/) | 9.4 — Service Discovery, Circuit Breaker, Bulkhead  | 1    | Registry বনাম static list, fail-fast এর লাভ, board কে ডুবতে না দেওয়া                                   |
| [`lesson-9.5-rate-limiting/`](lesson-9.5-rate-limiting/)                           | 9.5 — Rate Limiting Algorithms                      | 1    | Boundary burst, token বনাম leaky, আর instance সংখ্যার সমান ফাঁস                                         |
| [`lesson-10.1-consistent-hashing/`](lesson-10.1-consistent-hashing/)               | 10.1 — Consistent Hashing Deep Dive                 | 1    | কত key নড়ে আর কোথায়, virtual node, cache এর DB চাপ, hot key                                           |
| [`lesson-10.2-bloom-hll/`](lesson-10.2-bloom-hll/)                                 | 10.2 — Bloom Filter, HyperLogLog                    | 1    | Penetration এ Bloom বনাম negative cache, পুরনো filter, HLL merge, CMS                                   |
| [`lesson-10.3-fault-tolerance/`](lesson-10.3-fault-tolerance/)                     | 10.3 — Fault Tolerance, Graceful Degradation, Chaos | 1    | Dependency matrix, redundancy এর ফাঁকি, brownout, static stability, blast radius                        |
| [`lesson-10.4-observability/`](lesson-10.4-observability/)                         | 10.4 — Observability: Logging, Metrics, Tracing     | 1    | Percentile আর rollup, label cardinality, head/tail sampling, burn rate, আসল trace                       |
| [`lesson-10.5-security-jwt-oauth-ddos/`](lesson-10.5-security-jwt-oauth-ddos/)     | 10.5 — Security at Scale                            | 1    | জাল JWT, BOLA, revoke এর দেরি, OAuth এর আক্রমণ, ফাঁস হওয়া secret, credential stuffing, DDoS            |
| [`lesson-10.6-deployment/`](lesson-10.6-deployment/)                               | 10.6 — Deployment: Blue-Green, Canary, Feature Flag | 1    | কৌশল ধরে খারাপ version এর ক্ষতি, canary এর পরিসংখ্যান, graceful shutdown, lock queue, expand/contract   |
| [`lesson-10.7-cost/`](lesson-10.7-cost/)                                           | 10.7 — Cost & Cloud Economics                       | 1    | লাইন ধরে বিল, unit economics, autoscale আর commit, storage tier এর ফাঁদ, NAT আর cross-AZ                |
| [`lesson-10.8-multi-region/`](lesson-10.8-multi-region/)                           | 10.8 — Multi-Region & Geo-Distribution              | 1    | Topology ধরে latency, DR এর RTO/RPO আর দাম, DNS এর লেজ, split brain, LWW এর হারানো লেখা, data residency |
| [`lesson-11.1-url-shortener/`](lesson-11.1-url-shortener/)                         | 11.1 — Case Study: Design a URL Shortener           | 1    | Estimation, code এর চার পথ আর range allocation, redirect এর cache আর 301/302, আসল Express shortener     |

প্রতিটা folder এ নিজস্ব `README.md` আছে — setup, run, acceptance criteria, আর "নিজে ভেঙে
দেখো" experiment সহ।

## Code এর নিয়ম

`main.md` §১১ এর তিনটা hard rule এখানেও প্রযোজ্য:

1. সব code **TypeScript** এ, `strict: true`
2. **`any` একবারও না** — `unknown` + narrow, বা proper generic
3. প্রতি Tier 1 / Tier 2 exercise এ একটা `README.md`

তার সাথে প্রতিটা `tsconfig.json` এ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride` on থাকে।

## Typecheck

প্রতিটা TypeScript exercise আলাদাভাবে typecheck হয়। প্রতিটা লাইন নিজের subshell এ চলে, তাই পুরো
block একসাথে paste করা যায়, আবার একটা লাইন আলাদা করেও চালানো যায় — `exercises/` থেকে:

```bash
(cd lesson-2.5-idempotency && npm install && npm run typecheck)
(cd lesson-3.3-nginx-reverse-proxy/backend && npm install && npm run typecheck)
(cd lesson-4.4-redis-cache && npm install && npm run typecheck)
(cd lesson-5.2-data-modeling && npm install && npm run typecheck)
(cd lesson-5.4-indexing && npm install && npm run typecheck)
(cd lesson-5.5-transactions && npm install && npm run typecheck)
(cd lesson-5.6-pooling-nplusone && npm install && npm run typecheck)
(cd lesson-5.7-replication && npm install && npm run typecheck)
(cd lesson-5.8-sharding && npm install && npm run typecheck)
(cd lesson-5.9-quorum && npm install && npm run typecheck)
(cd lesson-6.1-split-brain && npm install && npm run typecheck)
(cd lesson-6.2-raft && npm install && npm run typecheck)
(cd lesson-6.3-session-guarantees && npm install && npm run typecheck)
(cd lesson-6.4-logical-clocks && npm install && npm run typecheck)
(cd lesson-6.5-consistency-models && npm install && npm run typecheck)
(cd lesson-7.1-async-thinking && npm install && npm run typecheck)
(cd lesson-7.2-queue-vs-pubsub && npm install && npm run typecheck)
(cd lesson-7.3-bullmq && npm install && npm run typecheck)
(cd lesson-7.4-reliable-consumers && npm install && npm run typecheck)
(cd lesson-7.5-outbox && npm install && npm run typecheck)
(cd lesson-7.6-batch-stream-olap && npm install && npm run typecheck)
(cd lesson-8.1-object-storage && npm install && npm run typecheck)
(cd lesson-8.2-file-upload && npm install && npm run typecheck)
(cd lesson-8.3-search && npm install && npm run typecheck)
(cd lesson-9.1-monolith-vs-microservices && npm install && npm run typecheck)
(cd lesson-9.2-gateway-bff && npm install && npm run typecheck)
(cd lesson-9.3-saga-2pc && npm install && npm run typecheck)
(cd lesson-9.4-discovery-breaker-bulkhead && npm install && npm run typecheck)
(cd lesson-9.5-rate-limiting && npm install && npm run typecheck)
(cd lesson-10.1-consistent-hashing && npm install && npm run typecheck)
(cd lesson-10.2-bloom-hll && npm install && npm run typecheck)
(cd lesson-10.3-fault-tolerance && npm install && npm run typecheck)
(cd lesson-10.4-observability && npm install && npm run typecheck)
(cd lesson-10.5-security-jwt-oauth-ddos && npm install && npm run typecheck)
(cd lesson-10.6-deployment && npm install && npm run typecheck)
(cd lesson-10.7-cost && npm install && npm run typecheck)
(cd lesson-10.8-multi-region && npm install && npm run typecheck)
(cd lesson-11.1-url-shortener && npm install && npm run typecheck)
```

এগুলো root SvelteKit app এর `bun run check` এর অংশ না — আলাদা project, আলাদা dependency।
