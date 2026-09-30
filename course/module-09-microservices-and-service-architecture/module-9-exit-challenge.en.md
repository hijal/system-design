# Module 9 — Exit Challenge (Microservices & Service Architecture)

**Module 9 — Microservices & Service Architecture**

That is the five lessons of Module 9 — when to split and when not to, what sits in front of the services you have split out (gateway, BFF), transactions across a boundary (saga, 2PC), the three tools that surround one call (discovery, breaker, bulkhead), and who is allowed to ask for how much (rate limiting). Each lesson measured one question in isolation. In reality all of it arrives at once during six months of a "microservices migration" — and the old questions from Modules 5–8 (dual writes, replica lag, idempotency, eventual consistency) come back in new clothes, because crossing a service boundary does not make them easier, it makes them harder. This Exit Challenge is such a six months.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** while you were away (three months on another project) TaskFlow went through a "microservices migration". You are back now, and you have been asked to run a six-month incident review. Here is where things stand (some decisions follow this module's lessons, many do not):
>
> - **Split into 11 services**, by layer: `api-gateway`, `web-api`, `mobile-api`, `task-read`, `task-write`, `comment`, `user`, `billing`, `notification`, `search`, `file`. Each with its own repo and its own deploy pipeline.
> - **Databases:** `task-read`, `task-write` and `comment` all use the same schema in the same Postgres ("so we can still JOIN"). `billing`, `user` and `search` have their own databases. `notification` and `file` have none.
> - **The browser:** SvelteKit pages call 7 services directly (`task-read`, `comment`, `user`, `file`, `search`, `billing`, `notification`) — through the gateway, but with no BFF. The board's page load makes 23 requests.
> - **The gateway:** verifies the JWT, then sets `X-User-Id` and `X-Workspace-Id` headers on the way to the services behind it. The services trust those headers. The services' ports are inside the VPC, but there are no network policies.
> - **Addresses:** every service's config holds a list of the others' addresses (`BILLING_URLS=10.0.3.11:8080,10.0.3.12:8080,10.0.3.13:8080`). Everyone has a health endpoint: `app.get('/health', (_, res) => res.status(200).send('ok'))`.
> - **Call rules:** every internal call has a 30 s timeout ("so the work finishes even when it's slow"). On failure, 3 immediate retries with no backoff. No circuit breakers. Each service has one HTTP connection pool (maxSockets 50) and one Postgres pool (10).
> - **"Create task":** `task-write` runs a distributed transaction — 2PC across `task-write`'s database and `billing`'s database using Postgres's `PREPARE TRANSACTION`. The coordinator is that `task-write` process, and its log is on its own local disk.
> - **"Plan upgrade":** a saga — a Stripe charge in `billing` → change the plan in `user` → an email in `notification`. None of the steps has a compensation written ("if it fails we get an alert and fix it by hand"). The saga's state is never written down anywhere; the orchestrator is an HTTP request handler.
> - **Rate limits:** `express-rate-limit` in every service, with the default (in-memory) store, `1000 per hour`, key = `req.ip`. Each service runs 8 instances. The apps are behind a load balancer, and `trust proxy` is not set.
> - **Cache and limiter:** one Redis, `maxmemory 4gb`, `maxmemory-policy allkeys-lru`. It holds: the task list cache, sessions, and (newly added) the rate limiter's counters.
> - **A proposal:** a senior engineer says, "What we need is a service mesh, and then all of this goes away."
>
> **The six months' incidents:**
>
> 1. **Deploy speed.** Before the migration there were 4 deploys a day. Now there are 2 a week — because nearly every feature requires changing 3–5 services, which then have to be deployed in a particular order. One small feature ("due dates on tasks") took 11 days, 4 services and 3 teams.
> 2. **The board's p99.** 80 ms before the migration. Now 940 ms on desktop and 4.2 s on mobile. Every backend service's own p99 is under 15 ms — nobody is slow.
> 3. **The 21st, 10:05.** An index had gone missing from `billing`'s database and its p99 rose to 2 s. At 10:06 every `task-write` instance's connection pool was full. At 10:07 the board stopped opening (`task-read` had stopped too). At 10:09 login stopped. At 10:11 the whole site was down. The postmortem found that `billing` never died completely — it was only slow.
> 4. **A machine replacement.** The cloud provider replaced `10.0.3.12` with a new IP, `10.0.3.47`. For the next 9 days 33% of "create task" calls failed. There was an alert, but it watched "billing 5xx rate" — and these were not 5xx, they were connection refused.
> 5. **A bad deploy.** A `billing` deploy went out with the wrong database credentials. All 8 instances came up, `/health` returned 200, the LB kept every one of them in rotation, and every real call returned 500. Every "create task" failed for 40 minutes.
> 6. **An in-doubt transaction.** On the 3rd, a `task-write` instance died of an OOM after PREPARE. In 2 workspaces no task could be created for the next 6 hours, and `VACUUM` was blocked in `billing`'s database. The machine the coordinator had been running on was gone via autoscaling — and the log went with it.
> 7. **Took the money, gave nothing.** 41 customers were charged but their plan did not change. Two different causes: (a) the `user` service was slow and the saga's second step timed out; (b) for some, the plan changed in `user` but Stripe was charged **twice** (because of the retries). Finance counted 18 double charges.
> 8. **Rate limiting's two faces.** (a) One integration sent 900 requests per second from one API key for three days and nobody stopped it. (b) Meanwhile an enterprise customer's office (800 people behind one NAT) reported "all of us get 429s at 9 a.m." — and an engineer had written "the problem is on your side" in their support ticket.
> 9. **The 28th, at night.** Redis reached 4 GB of memory (a large export's cache). Over the next hour rate limiting effectively disappeared — a scraper sent 400,000 requests and nobody got a 429. Nobody worked out what had happened, because Redis's dashboard was all green.
> 10. **An axe to our own foot.** A nightly reconcile script sent 2,000 calls per second into `billing` while reconciling quota for 50,000 workspaces. `billing` fell over, and (exactly as in incident 3) three more services went with it.
> 11. **A researcher's report.** An authenticated user changed the `X-User-Id` header from their own browser and read another user's tasks — not through the gateway but directly against the service's port (they were on the VPN, thanks to a misconfigured VPC peering).
> 12. **The manager's question:** "We went to microservices to move faster. Now we are slower, we have more outages, and we need three more engineers. What went wrong — and will a service mesh fix it?"

Your job — for each question below, apply Module 9's concepts (and earlier modules where relevant) and make a decision, with your reasoning. Where possible, say it with **numbers**.

**1. The boundaries of the split (Lesson 9.1)**
On what principle were these 11 services divided, and what is wrong with it? Why is `task-read` and `task-write` being separate services a wrong boundary — and which principle does their sharing one schema break? Which word from 9.1 describes incident 1's 11-day feature, and what other symptoms of that disease are in this scenario (at least three)? How many services would you reduce the 11 to — list them by name with the reasoning for each boundary, and say which ones go back into one deployment.

**2. The board's p99 (Lesson 9.2 + 1.3)**
Every service's p99 is under 15 ms, yet the board's is 940 ms (4.2 s on mobile) — where does that gap come from, by name? For 23 requests on mobile (assume an RTT of 100 ms), how much time is round trips alone, and how many steps once you account for the browser's concurrent connection limit? Design it with a BFF: why separate ones for web and mobile, how many requests the board's page comes down to, and what the BFF does internally (ordering, concurrency, what it returns on partial failure).

**3. From 10:05 to 10:11 (Lesson 9.4 + 7.1 + 5.6)**
Write the six-minute cascading failure as a timeline — from `billing` getting slow to login stopping, naming the resource that ran out at each step. Four decisions made this cascade possible (timeout, retry, breaker, pool) — give the right value or rule for each, with numbers. In particular: what should the 30 s timeout be instead, and **from what measurement** would you get that number? Why did `task-read` stop when it does not call `billing` at all — and exactly what would have prevented that?

**4. The health endpoint and the addresses (Lesson 9.4 + 3.4)**
Incidents 4 and 5 are two different problems — separate them, and say what each one needed. Which question does `res.status(200).send('ok')` answer and which does it not (which two words from 3.4)? Write a correct health endpoint for billing (what it checks, what it does **not** check, what timeout). And incident 4's 9 days: with a registry or the platform's discovery, how long would it have taken to heal, and what would the alert have had to watch to catch it?

**5. 2PC and in doubt (Lesson 9.3 + 5.5 + 5.3)**
Explain incident 6: when the coordinator dies after PREPARE, exactly what state are things left in, and why could **nobody else** create tasks in those 2 workspaces? Why was `VACUUM` blocked, and what would have happened had it gone on for days? Why is keeping the coordinator's log on its own disk a fundamental mistake — where should it have been? And the biggest question: was 2PC even the right choice here? Give your alternative design, and say which number would make you tell them to drop 2PC.

**6. 41 customers, and 18 double charges (Lesson 9.3 + 7.4 + 2.5)**
Explain incident 7's two causes separately. Redesign this saga: the **order** of the steps (and why that order), which is the **pivot**, each one's compensation (or "retry only"), where and in which transaction the saga's state gets written, and what the recovery job does. What exactly does preventing double charges take — which Stripe feature, and what would its key be? "If it fails we get an alert and fix it by hand" — at what scale of failure does that policy work, and where does it not?

**7. Three mistakes in rate limiting (Lesson 9.5 + 4.3)**
Incidents 8 and 9 contain **at least four** distinct mistakes — name each one, its symptom, and its fix. In particular: (a) with 8 instances and an in-memory store, what is "1000 per hour" actually? How does that number change under autoscaling? (b) What did `req.ip` plus the missing `trust proxy` produce, and is incident 8(b)'s problem with those 800 people the same one or a different one? (c) In incident 9, how did rate limiting "disappear" — because of which decision from Lesson 4.3, and what is the remedy? (d) With a fixed window at `1000/hour`, what is the most a client can send and in how little time — and which algorithm plus which two numbers would you change it to?

**8. Identity and boundaries (Lesson 9.2 + a preview of 10.5)**
Write incident 11's attack step by step. "The gateway verifies the JWT and then sets headers" — what does that design assume, and when does the assumption break? Give at least **three** layers of defence (network, token, the service's own verification), and say why each one alone is insufficient. Which part of this problem does a service mesh (mTLS) fix and which does it not?

**9. Our own batch jobs (Lesson 9.5 + 9.4 + 7.4)**
What did the reconcile script in incident 10 do wrong, and why is it more embarrassing than incident 3? Give a rule for that script — which algorithm should throttle it (and why that one, not a token bucket), at what rate, and where you would get that rate from. Beyond that, give two more safeguards so that no internal script can take down a service in future.

**10. The manager's question, and priorities (Lessons 9.1–9.5)**
(a) An answer to incident 12 — one paragraph, without blame: which problem do microservices solve, was that actually TaskFlow's problem, and which decisions caused "slower + more outages + more engineers". What will a service mesh fix (be specific) and what will it not — and is it the priority right now?
(b) A **priority list**: what this week (before it happens again), what this month, what this quarter — with, for each, the lesson it comes from, the incident it would have prevented, and how you will measure success (which metric, what number).
(c) What do you want TaskFlow's architecture to look like in six months — how many services, on which boundaries, what in front, and which tools are mandatory around each service (a checklist to follow when creating a new service).

**Things to remember:** there are four places in this module where mistakes come easiest — (a) confusing **splitting by layer** (`task-read`/`task-write`) with **splitting by business boundary**; the first produces a distributed monolith, which has all of microservices' costs and none of their benefits; (b) **writing a network call like a function call** — no timeout, no breaker, no bulkhead, as though someone is always there on the other side; (c) **mistaking "I'm alive" for "I'm working"** — a health endpoint, a heartbeat and a registry all report liveness, not readiness; (d) **keeping shared state in one process's memory** — a rate limiter's counters, a saga's state, a breaker's counts, a 2PC log — each of which dies with one instance, and the mistake grows with the instance count. All four are in today's scenario, several times over. And Module 9's most important habit: for every service boundary, ask — **"what happens if this call fails, is slow, or happens twice — and who is handling that?"**

I will critique this step by step.

---

## 2. Self-Check — By the End of This Module You Should Be Able To

- [ ] State the three costs of splitting a monolith (function call → network call, spreading failure, the lost transaction) with numbers
- [ ] Explain which problem microservices solve (many teams, independent deploys, independent scaling) and which they do not ("the app is slow") — using Conway's Law
- [ ] Draw boundaries along bounded contexts, and recognise the symptoms of a distributed monolith; know when to choose a modular monolith and a strangler fig
- [ ] Say why database per service is a condition, and exactly what is lost when two services share one schema
- [ ] Recognise request waterfalls and over-fetching; design a BFF (and why web and mobile need separate ones) and do the round-trip arithmetic
- [ ] Say what an API gateway is responsible for and what it is not; where a token is verified, and how identity travels safely behind the gateway (and the danger of trusting a header)
- [ ] Decide with a rule which conversation goes synchronously and which as an event
- [ ] Explain how 2PC works, what an in-doubt transaction is, and why it is blocking — and why almost nobody uses it between services
- [ ] Design a saga: step order, compensation, pivot, the saga's log and recovery, every step idempotent; choose between orchestration and choreography
- [ ] Understand the price of a saga having no isolation, and mitigating it with a semantic lock
- [ ] Explain why service discovery is needed, how a registry with heartbeats and TTL works, and why the TTL window cannot be reduced to zero; client-side vs server-side discovery
- [ ] Explain that a heartbeat/health endpoint reports liveness and not readiness — what follows from that, and what a correct readiness probe looks like
- [ ] Explain a circuit breaker's three states, the trade-off in threshold and duration, why half-open sends exactly one probe — and who a breaker protects first
- [ ] Draw a damage boundary with a bulkhead, and state its price (the healthy path survives, the sick path gets slower) with numbers
- [ ] Know the differences between five rate limiting algorithms — the fixed window's 2×, the sliding log's memory, the sliding counter's approximation, token versus leaky's shape
- [ ] Explain why the actual limit = the written limit × the instance count, and the three costs of a shared store (an extra call, atomicity, a new dependency)
- [ ] Give the correct 429 contract (`Retry-After`, `X-RateLimit-*`), which key the limit is on, and fail open versus fail closed when the limiter dies — per endpoint

---

## 3. Recommendation

**To read:**

- **Sam Newman — _Building Microservices_ (2nd edition).** The best single source for almost every decision in this module — especially the chapters on drawing boundaries, the strangler fig, and "when not to split". His short book **_Monolith to Microservices_** is even more direct: how to extract step by step, and the patterns for splitting a database.
- **Chris Richardson — _Microservices Patterns_ and the patterns on `microservices.io`.** Saga, transactional outbox, API composition, database per service, circuit breaker — almost the whole structure of 9.3 comes from here. Each pattern is documented with its **costs**, which is where the value is.
- **Michael Nygard — _Release It!_ (2nd edition).** Circuit breaker, bulkhead, timeouts, the "stability patterns" and "antipatterns" — the real source of 9.4, and a book made entirely of stories about things breaking in production. If you read one book from this list, read this one.
- **The Google SRE Book — the "Handling Overload" and "Addressing Cascading Failures" chapters.** Free to read. The most realistic discussion of 9.4's cascades and 9.5's load shedding and rate limiting, with Google's own numbers — especially "why retries make things worse" and adaptive throttling.
- **Cloudflare's blog — "How we built rate limiting capable of scaling to millions of domains".** Why and how they use a sliding window counter in 9.5, and how they accepted its approximation — the real-world context for our measured 1.9x.
- **Martin Kleppmann — _Designing Data-Intensive Applications_, the "Distributed Transactions and Consensus" part of chapter 9.** The clearest explanation of 2PC's problems, including XA's practical weaknesses — the deeper form of 9.3's 1.2–1.3.

**To watch:**

- **Sam Newman's conference talks** ("Confusion In The Land Of The Serverless", "Don't Start With A Monolith", and his talks arguing the other way) — the same person arguing both sides, which is the most useful habit to acquire on this subject.
- **"Mastering Chaos — A Netflix Guide to Microservices" (Josh Evans).** Lessons from Netflix's own mistakes — service boundaries, failure cascades, and why they invested so heavily in fallbacks and bulkheads. An old talk, but the reasoning has not aged.
- **Kubernetes' documentation on "Configure Liveness, Readiness and Startup Probes" and on Services/Endpoints** — the practical form of 9.4's discovery and readiness, and the ordering of graceful shutdown (`preStop`, `terminationGracePeriodSeconds`).

**To build:**

- **Extract one service, with the full toolkit:** take one bounded context out of a monolith of your own (or a toy like TaskFlow) — with a strangler fig, keeping the old path alive for a while. Then put everything around that one call: timeout, a breaker (using a library), a bulkhead, discovery (Kubernetes or Consul), and a rate limit. Then **break it**: make the service slow, kill it, make it return 500 — and measure the caller's p99 and error rate in each case. You will rediscover every number from this module with your own hands.
- **A saga, with recovery:** two services, two databases, a three-step saga (with a pivot) — the orchestrator's `sagas` table, every step idempotent (by idempotency key), and a recovery job that finds stuck sagas and either advances or compensates them. Then kill the orchestrator between each step (five different places) — what does recovery do each time? Make compensation fail deliberately and watch what lands in the DLQ and the alert.
- **Your own distributed rate limiter:** a token bucket in Redis with a Lua script (two fields, time-dependent arithmetic, all in one step). Put it in front of three Express instances and verify that the actual limit equals the limit (not a multiple of the instance count). Then turn Redis off and see how your fail open / fail closed decision behaves; and push load from two instances at once to measure whether there is a race (once without Lua, once with).

---

Do the exit challenge and send it to me. When you are ready, write `next` and we will go to **Module 10: Reliability, Security & Operations** — starting with Lesson 10.1: **Consistent Hashing, in depth**, which was only introduced in Lesson 3.2 and touched on in 5.8 in the context of shards.

Throughout Module 9 TaskFlow was split apart, and every split added a new tool — a gateway, a BFF, a saga, a registry, a breaker, a bulkhead, a rate limiter. Each one works, and each has its own tuning. But there is one question we avoided all module: **while all of this is running, how do you know what is happening?** Incident 4 took 9 days because the alert was watching the wrong thing; in incident 9 nobody even realised rate limiting had disappeared, because Redis's dashboard was green; and the postmortem for incident 3 took days to reconstruct a six-minute sequence. Module 10's question: hash rings, Bloom filters, observability, security, deployment, cost and multi-region — that is, not just whether the system works, but whether it can be **operated**.
