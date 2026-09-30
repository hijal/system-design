# Lesson 9.4 — Service Discovery, Circuit Breaker, Bulkhead

**Module 9 — Microservices & Service Architecture**

> **Spaced Repetition (Lesson 3.4):** In stock (open-source) Nginx, which kind of health check runs by default — passive or active? And who pays for it: your monitoring system, or real users? Today that same bill comes back — not inside the load balancer this time, but in your own service's code.

**Prerequisite:** Lesson 1.5 (Availability, p99), Lesson 3.1 (L4 vs L7), Lesson 3.4 (Health checks, liveness vs readiness, graceful shutdown), Lesson 4.6 (Thundering herd), Lesson 5.6 (Connection pool), Lesson 6.1 (Partial failure, timeout means "I don't know"), Lesson 7.1 (Cascading failure, event loop), Lesson 7.4 (Retry, backoff, backpressure), Lesson 9.1 (Timeout + fallback, spreading failure), Lesson 9.2 (Synchronous calls), Lesson 9.3 (The saga's first step — calling billing)

**By the end of this lesson you will be able to:**

1. Say where a service gets another service's **address** from — a hand-written list, a registry with heartbeats and TTL, client-side vs server-side discovery — and show with measured numbers which problem a registry fixes and which window it leaves open
2. Design a **circuit breaker** — three states, threshold, open duration, half-open probe — and say who it protects first: yourself, or the service that is dying
3. Use a **bulkhead** to stop one slow dependency from sinking your whole service — and state its price (the healthy path survives, the sick path gets slower) with numbers

**Tier:** 1 — Runnable Code (real HTTP servers on separate ports — three billing instances; registry, breaker and bulkhead written by hand; no Docker needed)

---

## 0. Where TaskFlow Is Right Now

After Lesson 9.3, billing is a separate service with its own database. "Create task" is now a saga, and its **first step** is a synchronous call from the work service into billing — reserving quota. Billing runs three instances, and the work service's config has their three addresses written by hand.

Three things happened in three weeks:

1. **The lost address.** The cloud provider replaced a machine (routine maintenance) — new instance, new IP. The old address stayed in the config. For the next two days one in every three "create task" calls failed — exactly 33%, and it did not heal on its own. Not until someone deployed a config change.
2. **Alive, but not working.** A bad billing deploy — the instance came up, the port opened, but its database credentials were wrong, so every call returned 500. As far as the work service was concerned it was still "alive". Failures again, and again no self-healing.
3. **The worst one.** An index had gone missing from billing's database; queries started taking 2 seconds. Every "create task" in the work service now waited the full 300 ms timeout and then failed. But the support ticket that came in wasn't about tasks — **"the board won't even open."** Opening the board doesn't touch billing at all. The whole app looked dead anyway.

The third one is what made people think. One engineer: "Billing is slow — fine, I get that. But the board doesn't talk to billing at all. Why did it die?" The CTO: "Those are three different problems, and I suspect they have three different answers. Measure them — same as before."

---

## 1. Theory

### 1.1 Three questions, three tools

The three incidents above look the same ("create task fails because of billing"), but they are three different questions:

```
  1. "Where is billing?"              →  Service Discovery
     The address is wrong or stale. Nobody died — we just don't know who's alive.

  2. "Billing is sick, when do I stop?" →  Circuit Breaker
     The address is right, the instance answers — but with the wrong answer, or late.
     By calling it over and over we waste our own time, and never let it recover.

  3. "Billing is sinking and pulling me down" →  Bulkhead
     My own resources (workers, connections) are stuck waiting on one dependency.
     Work that has nothing to do with billing is dying too.
```

Three different tools, and none of them substitutes for another — that is the main point. Discovery removes dead instances but cannot detect a sick one. A breaker takes your hand off a sick dependency but does not partition your workers. A bulkhead draws a boundary around the damage but fixes no failure at all.

### 1.2 Service Discovery — where the address comes from

**Service Discovery** — the process of finding the current addresses (host + port) of a service's instances in a running system, so that a caller's config does not have to be edited by hand when instances come, go, or change address.

In the monolith this problem did not exist — billing was a function call (Lesson 9.1). Now billing is several processes on several machines, and that count changes: autoscaling, deploys, crashes, maintenance. A hand-written list means treating **a snapshot of one moment** as permanent truth.

**Service Registry** — a central store where each instance registers itself on startup and then sends regular **heartbeats**; if no heartbeat arrives for a given time (the TTL), the registry assumes the instance is gone and removes it from the list.

```
   billing-1 ──register, then heartbeat every 100 ms──►┐
   billing-2 ──────────────────────────────────────────►│  Registry
   billing-3 ──────────────────────────────────────────►┘  (TTL 300 ms)
                                                             │
   work service ──"give me billing's live addresses"─────────►┘
                ◄──[billing-1, billing-3]── (billing-2's last heartbeat is older than 300 ms)
```

From the exercise, `npm run discovery` — three instances, 300 "create task" calls per phase, 8 concurrent; halfway through, one instance's process is killed (connection refused):

```
   strategy                             before     on death    after TTL
   static list                         0 ( 0%)    100 (33%)    100 (33%)
   registry + heartbeat/TTL            0 ( 0%)    100 (33%)      0 ( 0%)

   time for the registry to drop the dead instance: 230.2 ms (heartbeat 100 ms + TTL 300 ms)
```

Two things to read here, and the second matters more:

- **A static list does not heal.** 33% failures during the incident, still 33% after — for hours, until a human edits the config and deploys. TaskFlow's incident 1 was exactly this, for two days.
- **A registry heals, but not instantly.** In the "on death" column the registry is also at 33% — because at that moment the registry does not know yet. It will know one TTL after the last heartbeat. Measured: ~230 ms (the smaller the gap between the last heartbeat and the death, the less). **That window is discovery's real number** — inside it, calls will go to a dead address.

To shrink the window, lower the TTL — but not for free. A TTL of 100 ms means more frequent heartbeats and more writes into the registry; and a healthy instance's brief GC pause (Lesson 7.1) or a network hiccup will get it declared dead by mistake — it leaves the list, load on the others rises, they get slower too. That old truth from Lesson 6.1 applies here as well: **"not answering" and "dead" are not the same thing**, and a timeout cannot tell them apart.

### 1.3 Client-side vs Server-side Discovery

Who holds the list and who picks — that question has two answers:

**Client-side Discovery** — the caller fetches the list of live instances from the registry itself and picks one (round robin, least connections — Lesson 3.2); **Server-side Discovery** — the caller sends to one fixed address (a load balancer or proxy), and what sits behind that address is decided by the load balancer using the registry.

```
  client-side                              server-side
  ───────────                              ───────────
  work ──asks the registry──► [1,3]        work ──► billing.internal (one fixed name)
  work ──picks itself──► billing-3                     │
                                                       ▼
  logic lives in the caller's code              LB / proxy / mesh ──► billing-3
  a library per language                        the caller knows nothing
  one hop fewer                                 one hop more (9.2's price)
```

What you will actually meet: **DNS** is the oldest server-side form (one name → several IPs) — but DNS TTLs get cached in the client, the OS and libraries, so an instance that has gone away lingers in caches for a long time; DNS alone is not enough for instances that change fast. In **Kubernetes** a Service gives a fixed name and ClusterIP, and the Endpoints behind it are added and removed according to the kubelet's readiness probe (Lesson 3.4) — effectively server-side discovery, with Kubernetes itself as the registry. **Consul, etcd and Eureka** run as separate registries, and a **service mesh** (seen in 9.2) puts a sidecar proxy next to every pod and takes the whole business out of the caller's code.

For TaskFlow there is a simple truth here: a gateway already went in during 9.2, and the services are on a private network. Before running a separate registry, ask — does your platform (Kubernetes, ECS, Nomad) already give you this? The answer is almost always yes, and then writing your own registry is one more moving part you did not need.

### 1.4 The limit of a heartbeat — "I'm alive" vs "I'm working"

Now TaskFlow's second incident: the instance is up, sending heartbeats, and returning 500 on every real call. From the exercise, part B — two instances left, one of them sick:

```
   strategy                            healthy  sick (500)
   registry + heartbeat/TTL            0 ( 0%)    150 (50%)
```

50% failures, and the registry is unmoved — because the heartbeats keep arriving. A heartbeat answers "my process is alive" (**liveness**), but the question was "I can do work" (**readiness**) — the very distinction from Lesson 3.4, now in the context of a registry. There are three answers to this, and in practice all three are used together:

1. **Readiness probe** — have the heartbeat/health endpoint verify its real dependencies instead of just saying "I'm running" (a `SELECT 1` against the database). This catches the failures an instance can know about itself.
2. **Active health check** — let the registry or load balancer send its own probes (3.4), instead of waiting for a user's request to find out.
3. **Passive detection** — let the caller decide for itself from the results of real calls. In 3.4 this was Nginx's `max_fails`. In the caller's own code its name is **circuit breaker** — and that is the next section.

Why the third one cannot be dropped: however good a probe is, it does not run _your_ query. An instance can fail on exactly **your** call (one dead shard, a bug on one code path). A failure that only shows up in real traffic can only be seen by the caller.

### 1.5 Circuit Breaker — the timeout wall

TaskFlow's third incident: billing is slow, 2 seconds. The work service's timeout is 300 ms. What happens?

Every call waits 300 ms and then fails. Because we have a timeout we think we have protected ourselves — but we are paying 300 ms **every single time**, a thousand times over. From the exercise, `npm run circuit`, 400 calls, 8 concurrent:

```
   path                                ok      failed   fast-fail     reached       ops/s         p50         p99
   no breaker                           0         400           0         400          27    301.0 ms    307.9 ms
   breaker                              0         400         388          12         663      0.0 ms    302.0 ms
```

**Circuit Breaker** — a small state machine on the caller's side that counts recent failures; when failures cross a threshold it goes "open" and fails subsequent calls immediately **without actually sending them**, then after a while tries once more to see whether the dependency has recovered.

```
                 N failures in a row
      ┌────────┐ ──────────────────► ┌──────┐
      │ closed │                     │ open │  the call never goes out — instant failure
      │        │ ◄────────────────── │      │  (fail fast)
      └────────┘   probe succeeded    └──────┘
           ▲                             │ the duration (500 ms here) expires
           │                             ▼
           │                      ┌───────────┐
           └──────────────────────│ half-open │  lets exactly one call through
                probe succeeded   └───────────┘
                                        │ probe failed → open again
                                        ▼
```

**Fail Fast** — failing a call immediately, without making it wait, when it is unlikely to succeed, so the caller's time and resources are not stuck in a timeout.

Read the numbers, and notice what did **not** change:

- **Failures did not go down.** 400 calls failed in both runs — a breaker does not fix billing. What changed is **how fast** they failed: p50 from 301 ms to **0.0 ms**, ops/s from 27 to 663 (24×). The user used to wait 300 ms for an error; now they get it immediately. "A fast error" sounds bad, but it beats holding a worker and a connection for 300 ms — the next section shows why.
- **The biggest number is `reached`: 400 → 12.** Load on the dying billing is **97% lower**. This is the breaker's less-discussed but real job: calling a struggling service over and over means it never gets to stand back up (Lesson 4.6's thundering herd, now at a service's door). The breaker gives it room to breathe.

### 1.6 Half-Open — how recovery gets noticed

If a breaker just sits there open it will never learn whether billing recovered — because it is not calling. Hence the third state.

**Half-Open Probe** — when the open duration expires, the breaker lets exactly **one** call through; if it succeeds the breaker closes and returns to normal, and if it fails the breaker opens again and starts a new duration.

The "exactly one" part matters. If every waiting call were released at once when the duration expired, a billing that had just got back on its feet would fall over immediately — the thundering herd again. In the exercise, after making billing healthy:

```
   time for the breaker to close again after billing recovered: 208.1 ms
   (the rest of the open duration + one probe; at worst the full 500 ms)
   half-open probes sent in that time: 1
```

So a breaker has a price of its own: **traffic does not return for a while even after billing has recovered** — at worst the entire open duration. A longer duration gives the dying service more rest but delays recovery; a shorter one does the opposite. 500 ms here; in production often a few seconds.

And one subtlety that surfaced while writing the exercise: if failures from calls that come back **after** the breaker opened are counted too, the breaker keeps "re-opening" for no reason. You have to stop counting failures while open — otherwise the `opened` count lies, and the duration arithmetic goes wrong.

A breaker can err in two directions, both real: with too small a threshold (say 2) it will open on a brief hiccup and pull a healthy service out for no reason; with too large a one (say 50) a great many users will have waited before it ever opens. That is why production breakers usually do not count consecutively but look at the failure **rate** over a time window — and treat slow calls as failures too, because a "successful" answer that took 2 seconds still kills your p99.

### 1.7 Bulkhead — why the board died

Now the most important question: opening the board does not touch billing, so why did the board die?

Because of **workers**. The work service can handle some fixed number of concurrent requests — in Node that is the event loop and the connection pool (Lesson 5.6), however many sockets and in-flight promises sit in front of Express. Say 16 slots. Billing is 2 seconds slow, the timeout is 300 ms. Every "create task" takes a slot and sits there for 300 ms. With enough traffic all 16 slots belong to "create task" — and "open board" stands in line.

```
  shared pool (16 slots)                   bulkhead
  ──────────────────────                   ────────
  [c][c][c][c][c][c][c][c]                 create: [c][c][c][c][c][c][c][c][c][c][c][c]  (12)
  [c][c][c][c][c][c][c][c]   ← all taken   board:  [b][b][b][b]                          (4)
   board ──► waits in line                  board ──► its own slot, free
```

**Bulkhead** — like the watertight compartments of a ship: splitting your own resources (workers, connections, threads) into separate shares and giving each dependency or kind of work a fixed share, so that one share filling up does not stop the others.

From the exercise, `npm run isolation` — 600 requests, 40 clients, 16 slots, 70% "create task" and 30% "open board", billing 2 seconds slow:

```
── A. "open board" — the work that has nothing to do with billing ──
   pool                              ok      failed        shed         p50         p99
   shared (16)                      171           0           0    305.0 ms    595.9 ms
   bulkhead (4 board)               171           0           0      2.1 ms      7.4 ms

── B. "create task" — the work that really does depend on the slow billing ──
   pool                              ok      failed        shed         p50         p99
   shared (16)                        0         429           0    603.3 ms    901.1 ms
   bulkhead (12 create)               0         429           0    906.3 ms      1.21 s
```

- **The board's p99: 596 ms → 7.4 ms** (p50 305 → 2.1). The same slow billing, the same load, the same total slots — only partitioned. The board's own work takes 2 ms; in the shared pool it was taking 300× longer, all of it standing in someone else's queue.
- **And the price, honestly:** create's p99 rose from 901 ms to **1.21 s** — because its slots went from 16 to 12. A bulkhead **does not improve the sick path; it makes it slightly worse.** All it guarantees is that the sick path cannot drag the healthy one down.

That is what the decision really looks like: you are choosing **which work you are willing to let sink**. There is no option to say "all work is equal" — resources are finite, and not partitioning them means deciding, without noticing, that everything sinks together.

A bulkhead takes several forms, all the same idea: separate connection pools (10 for billing, a separate one for everyone else — 5.6), separate thread/worker pools, separate queues (7.4's backpressure), and at the coarsest grain — separate deployments, where "create task" and "read board" run in different processes.

### 1.8 TaskFlow's decision

Three tools, three separate decisions:

**Discovery:** no home-grown registry. TaskFlow is already on Kubernetes — one Service for billing (`billing.internal`), behind it a readiness probe that runs a `SELECT 1` against billing's database. Server-side discovery, because then the work service's code carries no registry client, and the price of one hop is acceptable here just as it was for 9.2's gateway.

**Breaker:** on every work → billing call, using an established library (the hand-written breaker is for the exercise — not for production). The threshold is not a consecutive count but 50% failures over a 10-second window; slow calls (>250 ms) count as failures too; open duration 5 s; one probe in half-open. **A breaker per dependency, per endpoint** — billing's `reserve` breaker and its `invoice` breaker are separate, so a problem on one endpoint does not remove all of billing.

**What happens when the breaker opens** — this is the real business decision, and here it has two different answers:

- **Create task:** fall back — the task gets created, the quota reservation is skipped, and a `quota_pending` marker is set for the nightly reconcile job (9.3) to settle. The reasoning: quota limits going soft for a few minutes costs little, while "tasks can't be created" means the whole product is useless. Part C of the exercise measured this path — 388 calls succeeded from the user's point of view, 12 failed.
- **Plan upgrade (money):** no fallback — an immediate, explicit error, "try again shortly". You cannot guess where money is involved (9.3's pivot reasoning).

**Bulkhead:** two shares inside the work service — anything that calls billing in one limited pool (concurrency 12), and everything else (reading the board, task lists, comments) in another (4 plus the rest). Plus a separate HTTP connection pool for billing. There is exactly one goal, and it will be written in the runbook: **the board opens even if billing is completely dead.**

And what is deliberately **not** being done: retries. When billing is slow a retry makes things worse — the same work twice, double the load (7.4's retry storm). If a breaker and retries are used together the rule is that retries live **inside** the breaker, and a retry's failures count toward the breaker too.

---

## 2. Interview Angle

**In any microservices design** a moment arrives: "service A calls service B — what happens when B is slow?" A weak answer: "I'll set a timeout." A timeout is essential but not sufficient alone, and these numbers show it: timeout 300 ms, billing 2 s slow — every call burns 300 ms, 27 ops/s. A good answer has three layers: timeout (the bound), circuit breaker (stop banging on that wall — 27 to 663 ops/s, and 97% less load on the dying service), bulkhead (the damage boundary — the board's p99 from 596 to 7 ms). Then the fallback decision: which work tolerates a degraded answer and which does not.

**"How will you do service discovery?"** — first turn the question around: what platform? On Kubernetes, Service plus readiness probe is already there and a separate registry is unnecessary. Then the client-side vs server-side trade-off, the problem with DNS TTL caching, and the thing that will impress most: the **detection window** — inside the registry's TTL, calls will go to a dead instance, so discovery alone is not enough and the caller needs passive detection too.

**"Who does a circuit breaker protect?"** — most candidates say "the caller". The complete answer runs both ways: the caller saves its own workers and time, **and the callee gets rest** — a struggling service that is called constantly can never get back up. Why half-open sends exactly one probe follows from this too.

**In production, in practice:** the most familiar stories — one breaker for all dependencies (a problem on one endpoint cuts off the whole service); a threshold so large the breaker effectively never opens; a breaker with nobody having decided the fallback, so when it opens users get the same error, only faster; a health endpoint that just does `return 200`, making readiness meaningless; no graceful shutdown (3.4), so every deploy produces failures during the registry's TTL window; and the most expensive of all — connection pools not partitioned, so one slow dependency eats every connection the service has.

---

## 3. Key Takeaway

- Three separate problems, three separate tools: **where** (discovery), **when do I stop** (breaker), **how much sinks** (bulkhead) — none substitutes for another
- **A static list does not heal** — measured: 33% failures forever after an instance dies; with a registry, 0% after ~230 ms
- **A registry's TTL is an open window** — for that long, calls will go to a dead address; the price of a smaller TTL is declaring healthy instances dead
- **Heartbeat = liveness, not readiness** — 50% failures against a sick instance that keeps heart-beating, with the registry unmoved; hence the caller needs passive detection
- **A breaker does not reduce failures, it reduces the cost of failure** — 400 calls failed either way, but p50 went 301 ms → 0 ms and ops/s 27 → 663
- **A breaker's real benefit is on the callee's side** — calls reaching the dying service went 400 → 12 (97% fewer), so it can stand back up
- **Half-open has a price** — even after the dependency recovers, traffic takes the rest of the open duration to return (measured 208 ms, at most 500)
- **A bulkhead does not fix the sick path** — the board's p99 went 596 → 7 ms, but create's p99 went 901 ms → 1.21 s; you are choosing what sinks
- What happens when the breaker opens (error or fallback) is a **business decision**, not the tool's; create task tolerates a fallback, a money transaction does not

---

## 4. New Terms (Glossary)

| Term                                    | Meaning                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Service Discovery**                   | Finding the current addresses of a service's instances in a running system, so a caller's config need not be edited by hand when instances come, go, or change address                                       |
| **Service Registry**                    | A central store where instances register on startup and send regular heartbeats; if no heartbeat arrives within the TTL, the registry removes the instance from the list                                     |
| **Client-side / Server-side Discovery** | Client-side — the caller fetches the list from the registry and picks an instance itself; Server-side — the caller sends to one fixed name, and a load balancer or proxy decides what sits behind it         |
| **Circuit Breaker**                     | A state machine on the caller's side that counts recent failures; past a threshold it opens and fails calls without sending them, then after a while tries again to see whether the dependency has recovered |
| **Half-Open Probe**                     | When the open duration expires the breaker lets exactly one call through — on success it closes, on failure it opens again; "exactly one" so a service that has just recovered does not fall over again      |
| **Bulkhead**                            | Splitting your own resources (workers, connections, threads) into separate shares and giving each dependency or kind of work a fixed share, so one share filling up does not stop the others                 |
| **Fail Fast**                           | Failing a call immediately, without making it wait, when it is unlikely to succeed, so the caller's time and resources are not stuck in a timeout                                                            |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines in your own words for each.

1. One of billing's instances is being deployed. The registry's TTL is 300 ms, heartbeats every 100 ms. (a) If the instance receives `SIGTERM` and shuts down immediately, for how long and at what percentage will calls fail — use the exercise's numbers. (b) How does this join up with graceful shutdown from Lesson 3.4 — to bring deploy-time failures to **zero**, exactly what should that instance do, and in what order? (c) Who does all of this for you on Kubernetes, and why do some failures remain anyway?

2. An engineer says: "A breaker and a bulkhead both limit damage — surely one of them is enough, why both?" (a) If you kept only the breaker and dropped the bulkhead, which number from the exercise would still be bad, and why? (b) And if you kept only the bulkhead and dropped the breaker? (c) Imagine a failure where **neither** helps — what is it, and what would you need then?

3. Billing's `reserve` endpoint is fine, but its `invoice` endpoint (the monthly statement — a heavy query) has become slow. (a) With a single breaker for the service, what happens, and how does it look to a user? (b) What changes with a breaker per endpoint, and what does that cost? (c) What can **billing itself** do to keep those two endpoints apart — and that is another form of which tool?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) The instant the instance dies the registry does not know yet — it will know 300 ms after the last heartbeat. Heartbeats are 100 ms apart, so the gap between death and the last heartbeat averages 50 ms; the window is therefore roughly 250 ms (measured ~230 ms in the exercise). One of three instances has died and the client is round-robining — so in that window roughly **33% of calls fail** (the exercise's "on death" column: 100/300). After the window, 0%.

(b) The ordering from 3.4's graceful shutdown has to be thought about from the other end here — **leave the list first, then die**:

1. On `SIGTERM`, **first** deregister from the registry (or start failing the readiness probe) — from now on no new calls arrive. This step is what erases the TTL window: the registry does not have to discover anything, the instance said so itself.
2. **Wait** a little (drain) — let in the requests from callers who already hold your address (in a client-side discovery cache, or in the LB's in-flight routing). The wait has to be longer than the callers' refresh interval.
3. Stop accepting new connections, **finish the in-flight requests**, then exit.

Do those three and deploy-time failures are effectively zero — because no call ever went to a dead address.

(c) On Kubernetes, removing the pod from a Service's Endpoints, the readiness probe, the `preStop` hook and `terminationGracePeriodSeconds` implement steps 1–3. Failures remain anyway because **a change to Endpoints does not reach everywhere at once**: it takes time to propagate to kube-proxy/iptables or a mesh's sidecars, and the caller's own connection pool may still hold an open socket. That is exactly why step 2's wait cannot be skipped — and why the caller also needs a retry (if idempotent, 7.4) or a breaker. No single layer can deliver "zero failures" on its own.

**Question 2:**

(a) Breaker only, no bulkhead: **until** the breaker opens (the time it takes to reach the threshold) every "create task" holds a worker slot for 300 ms — and that is precisely when the board's p99 rises. Once the breaker is open things are much better (the call never goes out, the slot is released fast). But two gaps remain: the time before it opens, and the half-open probe moments (when the duration expires some calls go out again). Broadly: a breaker reduces the **duration** of damage but does not draw its **boundary** — one dependency's problem can still spread through your shared pool.

(b) Bulkhead only, no breaker: the board survives (p99 7 ms — this is exactly the situation the exercise measured, and there is no breaker in it). But the create pool's 12 slots sit in timeouts indefinitely, every call burning 300 ms (that 27 ops/s state), and all 400 calls keep reaching the dying billing — it gets no chance to recover. Broadly: a bulkhead draws the boundary but does not stop the waste inside it, and does not protect the callee.

So you need both, and they do different things — the breaker works on time, the bulkhead on space.

(c) Where neither works: **when the failure is not slowness but a wrong answer** — billing returns 200 OK, returns it fast, but the answer is wrong (wrong quota, stale data). The breaker counts nothing (everything succeeded), and there is nothing for the bulkhead to do (nobody is waiting). This needs other things: validating the response (checking the schema with Zod — at least the shape), alerting on business invariants (9.3's reconcile job — a mismatch between the bill and the real tasks), and observability (Lesson 10.4) — because this failure is silent. It is the most dangerous class of all: the failure that produces no error.

**Question 3:**

(a) With a single breaker, `invoice`'s failures get counted and the breaker opens — and then **`reserve` gets cut off too**, even though it was working perfectly. From a user's point of view: the monthly statement page is slow, and as a result **creating tasks stops** — two unrelated things, one killing the other. This is exactly the cascading failure we were trying to prevent, except this time through our own tooling.

(b) With a breaker per endpoint (better still: per dependency + per endpoint), `invoice`'s breaker opens and `reserve`'s does not — the damage stays on that endpoint. The cost: many more breakers, each with its own state and tuning; on a rarely used endpoint the sample of failures is small, so reaching the threshold can take longer (which is why rate-based breakers include a minimum-calls condition); and there is more to look at on a dashboard. Even so this is almost always the right choice — the guiding principle: **match the breaker's boundary to the failure's boundary**.

(c) Billing itself can send the heavy `invoice` queries to a separate connection pool (5.6), separate workers, or an entirely separate process/deployment; even a separate read replica (5.7). Then `invoice`'s heavy queries cannot eat `reserve`'s connections. This is **another form of the bulkhead** — this time not on the caller's side but inside the callee. The general rule follows from here: a bulkhead is not a thing that lives in one place, it is an idea you can apply at every layer of the stack — threads, connections, queues, processes, machines.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (real HTTP servers on separate ports; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-9.4-discovery-breaker-bulkhead/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.4-discovery-breaker-bulkhead) — `npm install`, then `npm run discovery`, `npm run circuit` and `npm run isolation`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`discovery` runs three billing instances, kills one, and counts failures for a static list versus a registry with heartbeats and TTL — measuring the TTL window along the way; then it makes an instance "sick" (still heart-beating, but returning 500) to show why the registry is unmoved. `circuit` makes billing 2 seconds slow and counts ops/s, p50 and calls reaching the dying service with and without a breaker, then makes billing healthy and measures recovery through half-open, and finally runs a fallback instead of fail-fast. `isolation` mixes 70% "create task" with 30% "open board" — once on a shared pool, once with separate bulkheads — and reports p50/p99 separately for the two kinds of work.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` clean; the three scripts **three times each** — every counted column (100, 150, 400, 388, 12, 171, 429) identical, timing numbers varying by under 2% (registry removal 225.5–231.7 ms; 661–663 ops/s with the breaker; recovery 208.1–209.7 ms; the board's p99 594.7–595.9 ms shared and 7.1–7.7 ms with the bulkhead). Timings will differ on your machine; the counts will not. The billing instances are real HTTP servers (`node:http`, separate ports), but all on one machine in one process — no network latency, no packet loss, no DNS. "Slow" means the server deliberately waits; "dead" means `server.close()` — close to a real crash but not identical; in particular a **hung** machine gives you a timeout, not connection refused (shown here via `slow` mode). The registry is an in-process `Map` — not a replicated store like Consul/etcd/Kubernetes, and **what happens when the registry itself dies is not measured here**. The breaker counts consecutively; production breakers usually look at a failure rate over a time window and count slow calls too — 1.6 says so, but does not run it. The bulkhead here is a semaphore in one process; separate connection pools and separate deployments are discussed, not measured. TaskFlow's decision in 1.8 and the Kubernetes part are a design, not something that was run. Experiments 1–4 in the README are runnable; 5 involves changing code — that one is yours.

**Once the setup checks out, do these five:**

1. **Predict first:** before running `circuit`, write down — billing 2 s slow, timeout 300 ms, 8 clients. What ops/s without a breaker? (Hint: each client does one per 300 ms.) And with a breaker, how many calls reach billing — 10? 100? Then compare, and write one line on why whichever you got wrong was wrong.

2. **Measure the window:** experiment 1 — `TTL_MS=100 HEARTBEAT_MS=30 npm run discovery`, then `TTL_MS=2000`. How did the "on death" failures change? Now the reverse question: with a 100 ms TTL, what happens when a healthy instance has a 200 ms GC pause, and what follows from that (load on the others → they get slower → …)? That has a name — which lesson did you meet it in?

3. **Both sides of the threshold:** experiment 2 — run both `THRESHOLD=50` and `THRESHOLD=2`. Note `reached` and ops/s for each. Now think: with `THRESHOLD=2`, what happens on two brief hiccups of a healthy billing, and who pays for that mistake? Which number would you choose for TaskFlow — and from what measurement?

4. **Change the split:** experiment 4 — in `isolation.ts` give board 8 and create 8. What are the p50/p99 for each? Now try board at 2. Draw a line: what happens to create as you give board more slots? How would you set this number in production — by guessing, or from some measurement?

5. **The design part:** a one-page resilience design for TaskFlow's work service: (a) a list of every external dependency (billing, files, search, gateway) with the timeout, breaker threshold/duration and bulkhead share for each; (b) what happens when each dependency's breaker opens — error or fallback, and if a fallback, exactly what answer goes out and who settles it later; (c) which three numbers live on the dashboard that would tell you a breaker or bulkhead is mis-tuned; (d) which TaskFlow features work and which do not if billing is dead for a full hour — a list, destined for the runbook.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8 (complete, with exit challenges), 9.1, 9.2, 9.3
Current: 9.4 — Service discovery, circuit breaker, bulkhead
TaskFlow state: modular monolith (work, identity, files, search) + files processing service +
billing service (own database); gateway + web/mobile BFF in front (9.2); "create task" =
orchestrated saga (9.3), whose first step is a synchronous work → billing call; billing runs 3
instances behind a Kubernetes Service + readiness probe (SELECT 1 on its database) — no home-grown
registry, server-side discovery; graceful shutdown: deregister first, then drain, then exit;
circuit breaker on every work → billing call — per dependency + per endpoint, 50% failures over a
10 s window, slow calls (>250 ms) count as failures, open 5 s, one probe in half-open; when the
breaker opens: create task = fallback (quota_pending, nightly reconcile), plan upgrade = explicit
error; bulkhead inside work — anything calling billing at concurrency 12, everything else in a
separate pool, plus a separate HTTP connection pool for billing; the goal: the board opens even if
billing is dead; no retries for now (retry storms)
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall,
Over-fetching, Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication,
Service Mesh (mTLS), Two-Phase Commit (2PC), In-doubt Transaction, Saga, Compensating Transaction,
Pivot Transaction, Orchestration / Choreography, Semantic Lock, Service Discovery, Service Registry,
Client-side / Server-side Discovery, Circuit Breaker, Half-Open Probe, Bulkhead, Fail Fast
Weak spots: [where you got stuck — write it yourself]
Next: 9.5 — Rate limiting algorithms hands-on (Token Bucket, Sliding Window — Express middleware)
=======================
```

---

## 8. Next Step

That is four lessons of Module 9 — so, following `main.md`'s rule, a short one-paragraph recap: **9.1** showed the three costs of breaking up a monolith — function call to network call, failure now living inside your app, and the lost transaction — and so the decision was a modular monolith, extracting one service at a time when needed. **9.2** showed what sits in front of the extracted services — a BFF (each frontend's own backend) and an API gateway (one door, token verification in one place). **9.3** showed there is no atomicity across a boundary — 2PC is atomic but blocking, hence the saga: each step commits immediately, failure is undone by compensation, and past the pivot you only go forward. **9.4** took hold of that saga's very first step — calling billing — and showed what has to surround that one call: an address (discovery), a rule for stopping (breaker), and a damage boundary (bulkhead). One thread has run through all four without being pulled: **who is allowed to ask for how much.** "Rate limit" appeared in the gateway's list of duties in 9.2, and in 9.4's bulkhead we partitioned our own resources but never limited the demand arriving from outside — and the `shed` column in 1.7 was zero throughout.

Run the exercise and send me the results — especially your prediction in 1 and the design in 5. When you are ready, write `next` — in Lesson 9.5 we go to **rate limiting algorithms, hands-on.** Token Bucket, Leaky Bucket, Fixed Window, Sliding Window — which one tolerates bursts, which lets double the traffic through at a window boundary, and how much memory each costs; we will write them by hand as Express middleware and measure, and see where the counting has to live once there are several instances (Redis) — finishing off that unfinished duty of 9.2's gateway.
