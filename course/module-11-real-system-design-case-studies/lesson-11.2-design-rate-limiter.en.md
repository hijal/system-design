# Lesson 11.2 - Case Study: Design a Rate Limiter Service

**Module 11 - Real System Design Case Studies**

> **Spaced Repetition (Lesson 5.5):** What is a "lost update"? When two transactions read the same row, do their own maths, then write, what gets lost? And what were the two ways to make a read-modify-write safe? Today exactly this mistake will sit inside a rate limiter, and we will measure how many times over the limit it lets through during an attack.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.5 (Latency budget), Lesson 5.5 (Lost update), Lesson 6.1 (Timeout, partial failure), Lesson 9.2 (API gateway), Lesson 9.4 (Circuit breaker), Lesson 9.5 (Rate limiting algorithms), Lesson 10.1 (Hash slot), Lesson 10.3 (Hard/soft dependency, static stability), Lesson 10.7 (Cross-AZ cost), Lesson 11.1 (The shape of a case study)

**By the end of this lesson you will be able to:**

1. Design a rate limiter not as a library or middleware but as a **service**: separate rate limits from quotas in the requirements, work out the Redis shards, network and cross-AZ cost from estimation, and state the trade-offs of where the limiter sits (library, sidecar, separate service)
2. Compare the four ways of counting centrally (atomic on every request, splitting the limit, token leases, async sync) with numbers: how accurate, how fast, how much load on the centre, and **in which situation each one breaks** (races without atomicity, skewed traffic, attacks, tokens stuck in leases). And how to handle a hot tenant
3. Protect the API when the limiter is slow or dead: the timeout budget, the breaker, per-rule fail modes, and the price of a generous local fallback (blocking legitimate users vs letting an abuser have more)

**Tier:** 1 - Runnable Code (four deterministic models and a real limiter service + client library + API servers; no Docker or Redis needed)

---

## 0. Today's System

The interview room, second round. The interviewer:

> "We run a public API platform. 500,000 requests a second at peak, 400 API servers, several hundred thousand customers, each plan with its own limits. Design a rate limiter **service**."

If you have read 9.5, the first answer is ready: "Token bucket, in Redis, atomic in one Lua script, fail open if Redis dies. Done." A correct answer, for one process. But this time the interviewer's follow-ups are about size:

- "You go to Redis on every request? 500,000 op/s, does that fit in one Redis? How many shards? What does it cost a month?"
- "The limiter adds to the latency of every API request. What is your budget, and what happens when Redis is slow?"
- "One customer alone is 8% of all traffic. Which shard is their key on, and what happens to that shard?"
- "Give each server a share of the limit and you never need to go to the centre. What's the problem?"
- "The customer's monthly quota (10 million calls a month, billed beyond that) - is that in the same Redis too?"

9.5's question was "which algorithm". Today's question is "**where and how often do we count**", because at this size the algorithms are about equal, and the differences come from where the counting happens, distance, and failure.

---

## 1. Theory

### 1.1 Step 1 - Requirements: a rate limit and a quota are not the same thing

The questions, and what was assumed:

```
Question                                    Assumed
Limit by what?                              API key (customer), plus IP (login and anonymous endpoints)
How many rules per request?                 2 on average: the key's per-second limit + the endpoint's own limit
How often do limits change?                 when a plan changes, or by hand in an incident - must take effect in seconds
How accurate must it be?                    ±10% is fine on a protective limit; but nobody under the limit may be blocked
How much latency may the limiter add?       the API's p99 is 50 ms; the limiter gets 1 ms
If the limiter dies?                        the API keeps running; which rules open and which close is decided per rule
Several regions?                            one region today, discussed at the end
```

And one question candidates rarely ask: **what is the limit for?** Two very different things come under the same name.

**Quota (vs Rate Limit)** - A rate limit is a **protection**: "no more than 1,000 a second", so one customer's load does not hurt the others. A little over or under and nobody notices, and losing the state (a Redis restart) costs a few seconds. A quota is a **contract**: "10 million calls a month, then this much per thousand". Here every count is money, so nothing can be lost, nothing can be approximate, and in a dispute you have to show proof.

So the design has two separate paths. Rate limit state is fast, in memory, and losing it does no harm (Redis, fine without persistence). Quotas are counted from **usage events**, like 11.1's clicks: after every request an event goes to a log, a job counts it, stores it in a durable database, and once a minute sends a "this customer's quota is used up" flag to the rate limiter's rules. A few seconds of extra requests after the quota runs out will be accepted, and that is written into the contract ("quota accounting is a few minutes behind"). The opposite mistake, keeping quotas in the rate limiter's Redis, means one Redis failover sets a customer's month to zero. 9.5's eviction problem becomes a money problem here.

### 1.2 Step 2 - Estimation

`npm run estimate`:

```
── Part A - load: 500,000 API requests/s at peak, 400 API servers, 2 rules per request ──
                                                          Redis op/s  shards needed       network  cross-AZ / month
a separate Redis call per rule                             1,000,000             20      300 MB/s           $10,368
all rules in one Lua script (on the same shard)              500,000             10      150 MB/s            $5,184

── Part B - memory ──
token bucket, 300,000 active keys (150 B/state)                      600,000     90.0 MB
sliding log, limit 1,000 an hour, the same keys (16 B/entry)  300,000      4.8 GB

── Part C - the latency budget: the API's p99 is 50 ms, the limiter gets 1 ms ──
1,250 requests/s on one API server - if the limiter holds each for 1 ms, ~1 are waiting at a time; slow at 50 ms, ~63.
```

Four things:

1. **The load is in op/s, not in memory.** The whole state of three hundred thousand active keys is 90 MB, a small corner of one Redis. But one op per request means 500,000 ops a second, and with one Redis shard's comfortable capacity (with Lua scripts, an assumed ~100,000, keeping half free) that is 10 shards. So the question is not "how much data" but "**how often do we go to the centre**". Every deep dive that follows answers that question.
2. **Two rules in one call.** A separate call per rule means double the ops, double the shards, double the network. Checking every rule in one Lua script and deciding together is half the cost, and more correct too: if one rule passes and another blocks, the first one's token should not be spent, which is hard to handle across separate calls. The condition: every key has to be on the same shard (1.3's hash tag).
3. **A hidden line of cost.** With the Redis shards spread over three AZs, two-thirds of the API servers' calls go to another AZ, and 10.7's cross-AZ price is ~$5,000 to $10,000 a month, just to ask "am I allowed". The next part's leases cut this too.
4. **A sliding log is expensive at this size.** 9.5's exact algorithm is 4.8 GB for a limit of 1,000 an hour, 50 times a token bucket. So logs only for small, expensive rules (login, password reset), token buckets for everything else.

And the latency budget: 1 ms of the API's 50 ms p99 (2%) belongs to the limiter. One network round trip, one script, and **no retries**. The last line is Little's law (in flight at once = rate × wait time): if the limiter slows to 50 ms, 63 requests on each API server sit at once just waiting for the limiter's answer. In 1.7 this gets worse.

### 1.3 API, rules and data model

**The limiter's API** (internal, for API servers and the gateway):

```
POST /v1/check   { key, cost = 1 }        → { allowed, limit, remaining, retryAfterMs }
POST /v1/lease   { key, want }            → { granted, retryAfterMs, ttlMs }    (1.5's token lease)
```

**Rules (config, not data):**

```
{ prefix: "api:",    rate: 1000/s, burst: 200, failMode: "local"  }    ← by plan
{ prefix: "login:",  rate: 5/s,    burst: 5,   failMode: "closed" }
{ prefix: "search:", rate: 50/s,   burst: 50,  failMode: "open"   }
```

The rules live in a small config service, with versions, cached on every API server, pushed or polled every few seconds. If the rule service dies, the servers run on the last known rules (10.3's static stability). This is the path for "drop this customer to 10/s right now" in an incident, so it needs no deploy.

**Redis keys:** `rl:{acme}:api` and `rl:{acme}:search`. The part inside the curly braces is the real trick. **Hash Tag** - in Redis Cluster, only the part of a key inside `{` and `}` is used to work out the hash slot (10.1). So every rule's key for the same customer is in the same slot, on the same shard, and one Lua script can read and write them all together. The price: all of one customer's load on one shard (1.6). Each key is a small hash (`tokens`, `ts`) with TTL = the time an empty bucket takes to fill: a key unused for a while deletes itself, because a full bucket and a missing key mean the same thing.

### 1.4 Step 3 - High-level design: where the limiter sits

Three places, and all three are seen in production:

```
(a) library, inside the API server/gateway          (b) sidecar, next to every server              (c) separate limiter service

 client ─► [gateway + limiter lib] ─► service       client ─► [proxy ─► sidecar] ─► service       client ─► [gateway] ─► service
                  │                                                 │                                        │ gRPC
                  ▼                                                 ▼                                        ▼
            [Redis cluster]                                   [Redis cluster]                     [limiter service] ─► [Redis cluster]
```

| Place                | Latency                | Language and rule consistency                  | Central view                        | Failure                                       |
| -------------------- | ---------------------- | ---------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| (a) library          | one hop (Redis direct) | a separate library per language, version drift | none, Redis is the truth            | every server has its own timeout and fallback |
| (b) sidecar          | localhost + one hop    | one implementation                             | none                                | the sidecar is a new thing that can die       |
| (c) separate service | two hops               | one, rules and metrics in one place            | yes: leases, hot keys, rule changes | a separate fleet, its own scaling and SLO     |

Proxies like Envoy have both: a local limit inside every proxy, and an external global rate limit service (asked over gRPC). In this design: **a library inside the gateway (a)**, straight to the Redis cluster, because a 1 ms budget has no room for an extra hop and the gateway is written in one language. The "service" is at the logical level: Redis cluster + rule config service + client library + dashboard, owned by one team. Leases (1.5) need logic at the centre, and that stays in Redis's Lua script.

### 1.5 Deep dive 1 - How often to go to the centre: accuracy, latency and load

`npm run accuracy`: one API key, limit 1,000/s (burst 200), 50 API servers, 10 seconds, the centre's RTT median 0.5 ms. Six strategies, four situations. First, let's make the real question clear: **no strategy wins in every situation.** So we look at each one in four situations.

**Situation 1 - demand twice the limit, spread evenly over all servers:**

```
strategy                                          accepted/s  of limit    highest in 1 s  blocked   centre op/s  extra p50  extra p99
each server its own bucket (full limit)                2,010     2.01x             2.10x     0.0%             0    0.00 ms    0.00 ms
split the limit (limit / N on each server)             1,010     1.01x             1.11x    49.7%             0    0.00 ms    0.00 ms
central, every request, atomic (Lua)                   1,020     1.02x             1.20x    49.3%         2,010    0.50 ms    1.25 ms
central, GET then SET (not atomic)                     1,355     1.35x             1.63x    32.6%         4,020    1.04 ms    2.03 ms
token lease (4 at a time, wait if not granted)         1,016     1.02x             1.16x    49.5%         1,166    0.33 ms    1.15 ms
local + sync every 100 ms (async)                        998     1.00x             1.22x    50.4%           495    0.00 ms    0.00 ms
```

The first row is 9.5's old mistake (limit × servers, here as much as the demand). All the others are ~1.0x. In this situation everyone looks good, so stopping here would lead to the wrong decision.

**The spaced repetition answer, and the fourth row:** a lost update means two parties read the same old value, both write their own result, and one's work is lost. There were two ways out: reading and writing in one atomic step (`UPDATE ... SET x = x - 1`), or a lock/version. In a rate limiter, "GET to see the tokens, then SET to take one away" is exactly that mistake: between two servers' GETs the other's SET has not arrived, and both spend the same token. At twice the demand it is 1.35x, and at twenty times the demand (below) **5.8x**: the more concurrent requests, the more of them inside the race window. Meaning the limit leaks most **exactly during an attack.** So in Redis the whole decision (refill, compare, decrement) is in one Lua script, which Redis runs in one go, with no other command slipping in between.

**Situation 2 - the same demand, but 90% of traffic on 5 servers** (common in reality: one customer's connection pool is stuck on a few keep-alive connections to a few servers, 3.2):

```
split the limit (limit / N on each server)               287     0.29x             0.32x    85.8%             0    0.00 ms    0.00 ms
token lease (4 at a time, wait if not granted)         1,007     1.01x             1.16x    50.1%           835    0.00 ms    1.09 ms
local + sync every 100 ms (async)                        966     0.97x             1.16x    52.1%           495    0.00 ms    0.00 ms
```

**Splitting the limit collapses.** Each server's share is 20/s. The five servers where the traffic has piled up use up their shares and block, while the other 45 servers' shares sit unused. The customer gets 29% of their limit. And in situation 4 it is even worse.

**Situation 3 - an attack: demand 20 times the limit:**

```
central, every request, atomic (Lua)                   1,020     1.02x             1.20x    94.9%        20,033    0.50 ms    1.27 ms
central, GET then SET (not atomic)                     5,799     5.80x             7.33x    71.1%        40,065    1.04 ms    2.04 ms
token lease (4 at a time, wait if not granted)         1,019     1.02x             1.19x    94.9%         9,360    0.25 ms    1.14 ms
local + sync every 100 ms (async)                      2,016     2.02x             2.08x    89.9%           495    0.00 ms    0.00 ms
```

**Approximate Sync (local counting + periodic sync)** - each server counts by itself and every T ms sends its count to the centre and gets everyone's total back; in between, it decides with the last known total + its own count. No network on the request's path (zero extra latency), and the centre's load is not the number of requests but servers × sync rate (here 495/s). The price: during the sync window no server sees the others. In calm conditions you don't notice it. But in an attack, in the first moment after a sync all 50 servers think "there's room" at once: **2.02x**. Experiment 1: with a 500 ms sync, **7.02x**. The error grows with T × the number of servers, and is worst exactly when demand is highest. So this strategy belongs where the limit is a coarse protection and a 2× error is tolerable (counting across many PoPs at a CDN's edge is in this family), and is in the wrong place when there is a fragile downstream behind the limit.

**Situation 4 - demand at 80% of the limit, 90% of traffic on 5 servers.** Blocking anyone here is wrong:

```
split the limit (limit / N on each server)               176     0.18x             0.20x    78.3%             0    0.00 ms    0.00 ms
central, every request, atomic (Lua)                     813     0.81x             0.88x     0.0%           813    0.50 ms    1.26 ms
token lease (4 at a time, wait if not granted)           813     0.81x             0.88x     0.0%           215    0.00 ms    0.99 ms
local + sync every 100 ms (async)                        813     0.81x             0.88x     0.0%           495    0.00 ms    0.00 ms
```

**78%** of the requests of a customer under their limit blocked, just because their traffic was not spread evenly. This is the worst kind of mistake: the customer comes to support and says "my limit is 1,000, I'm sending 800, I'm getting 429s", and the dashboard shows their total rate below the limit. Experiment 2: with 200 servers they get 10% of their limit. Adding servers (autoscale) shrinks the customer's limit.

**Token Lease** - each server "borrows" a few tokens from the centre at once (say 4, with an expiry), then spends them from its own memory, and comes back when they run out. The centre is still the only truth (the token accounting is there), so the limit does not leak. But it goes there once every few requests, not on every request. 11.1's range allocation idea, for tokens. If a server cannot get the full lease (few tokens at the centre), it takes nothing and says "no" itself for the time tokens take to accumulate, so not every blocked request goes to the centre.

The result: in situation 4 the centre's load goes from 813 to **215 op/s**, with no wrong blocking, and the limit correct. But the lease size is a trap:

```
── lease size: 50 servers, burst 200 - when lease × servers passes the burst ──
lease     lease × server  2x, 5 servers: accepted   centre op/s  80%: wrongly blocked   centre op/s
1                     50                   1.02x         1,791              0.0%           813
4                    200                   1.01x           835              0.0%           215
10                   500                   0.93x           494              0.8%           106
20                 1,000                   0.89x           341             11.6%           108
50                 2,500                   0.83x           237             21.7%            94
```

With a lease of 20, 11.6% of an under-the-limit customer's requests are blocked. The reason: each of the 50 servers has borrowed 20 tokens and is sitting on them (1,000), most of them on quiet servers, unused, waiting to expire. The bucket only holds 200 in total (the burst). The busy servers go to the centre and find it empty. The rule: **lease × number of servers ≤ burst.** Which means the lease size is not fixed; it should come from each key's own rate on each server (that server's requests for this key over the last few hundred ms). Busy servers take big leases, quiet servers small or none (experiment 5).

And an honest caveat: in an attack (situation 3) a lease halves the centre's load (20,033 to 9,360), not to zero, because with an empty bucket every server asks again and again. The real answer to keeping an attack's load off the centre is earlier, in front of the gateway (10.5's DDoS layers), and a local cache of "this key is blocked for the next 1 second".

> **Trade-off Table - where to count**

| Strategy                        | Accuracy                       | Wrong blocking (skewed) | Extra latency   | Load on the centre          | Where it fits                                     |
| ------------------------------- | ------------------------------ | ----------------------- | --------------- | --------------------------- | ------------------------------------------------- |
| Each server its own, full limit | ✗ limit × servers              | No                      | 0               | 0                           | Never (only to protect the server itself)         |
| Limit / N                       | ✓ on even traffic              | **78%**                 | 0               | 0                           | As a fallback, generously (1.7)                   |
| Central, atomic                 | ✓ (1.02x)                      | No                      | p99 ~1.3 ms     | 1 per request               | Default, small and medium keys                    |
| Central, GET + SET              | ✗ 5.8x in an attack            | No                      | two round trips | 2 per request               | Never                                             |
| Token lease                     | ✓ (if lease × servers ≤ burst) | if the lease is big     | mostly 0        | 1 per lease (4 times fewer) | Big, busy keys, hot tenants                       |
| Async sync                      | ✓ when calm, 2–7x in an attack | No                      | 0               | servers × sync rate         | Coarse protection, spread over many places (edge) |

### 1.6 Deep dive 2 - The hot tenant

Customers' traffic is not equal. `npm run hotkey`: 500,000 requests/s, three hundred thousand active keys, Zipf (s = 1):

```
biggest tenant: 37,911 req/s (7.6%); tenants above 1,000/s: 37

plan                                          total op/s  avg shard  busiest shard  of capacity  busiest / avg
one op per request, 16 shards                    500,000     31,250         63,494          63%          2.03x
the same, 32 shards                              500,000     15,625         52,306          52%          3.35x
leases on big tenants (> 1,000/s)                413,256     25,828         33,521          34%          1.30x
big tenants' keys split 8 ways (rl:k#0..7)       500,000     31,250         36,431          36%          1.17x
```

- **One customer is more than half a shard.** The price of 1.3's hash tag: all of one customer's keys on one shard. The average shard is 31k, the busiest 63k.
- **Doubling the shards changes almost nothing** (63k to 52k), because one key does not split. 10.1's and 4.6's hot key, this time in the limiter. The average halved, the busiest stayed about the same, and the ratio got worse (3.35x). Experiment 4 (s = 1.2): the busiest shard at 114% of capacity, and still 107% with 32 shards. At that point it is no longer optional.
- **Leases on just the 37 big tenants** cut total ops by 17% and halve the busiest shard. Lease size by 1.5's rule: the limit's 0.2 s burst ÷ 400 servers, 18 tokens for the biggest customer.

**Key Splitting** - splitting a big key's limit into K parts (`rl:{acme#0}` ... `rl:{acme#7}`, each on a separate shard, each with limit / K), and each request picks a part **at random**. It sounds like 1.5's "limit / N", but the difference is fundamental: there the share was decided by which server the request arrived at, which is skewed; here it is decided by a random number, so the parts get even traffic on their own. The price: random fluctuation across the parts (more for small limits), and losing the ability to check all rules together in one Lua script (the parts are on different shards). So key splitting only for truly big keys, whose limits are so big that the fluctuation is negligible.

### 1.7 Deep dive 3 - When the limiter is slow or dead

A rate limiter is a protection. But because it sits on the path of every request, its own failure can bring down the whole API. 9.5 said "fail open or closed, per endpoint". Today the question comes in its hard form: Redis **doesn't die, it gets slow**, or there's a blackhole in the network (no answer ever comes). `npm run failure`: one shard's keys, 200 ordinary keys (under the limit) and one abuser (10 times the limit), 50 API servers:

```
── store slow (median 40 ms) ──
policy                                                  extra p50  extra p99  hanging per server  ordinary blocked   abuser got
no timeout, wait for the answer                             40 ms     128 ms                  57              0.0%   1.1x limit
timeout 5 ms → fail open                                  5.00 ms    5.00 ms                   6              0.0%  10.1x limit
timeout 5 ms → fail closed (503)                          5.00 ms    5.00 ms                   6            100.0%   0.0x limit
timeout 5 ms → local bucket (limit / N)                   5.00 ms    5.00 ms                   6             16.4%   1.0x limit
+ breaker → local bucket, generous (3 × limit / N)        0.00 ms    0.00 ms                   0              0.0%   3.1x limit

── blackhole on the store's network (no answer; TCP gives up after 30 s) ──
no timeout, wait for the answer                           30.00 s    30.00 s              37,500              0.0%   1.0x limit
timeout 5 ms → fail open                                  5.00 ms    5.00 ms                   6              0.0%  10.0x limit
timeout 5 ms → fail closed (503)                          5.00 ms    5.00 ms                   6            100.0%   0.0x limit
timeout 5 ms → local bucket (limit / N)                   5.00 ms    5.00 ms                   6             16.2%   1.0x limit
+ breaker → local bucket, generous (3 × limit / N)        0.00 ms    0.00 ms                   0              0.0%   3.1x limit
```

- **Without a timeout, the limiter takes the whole API down.** When slow, 40 ms on every request (p99 128), and in a blackhole 30 seconds, with 37,500 requests hanging at once on every server: memory, sockets, threads all used up. A "soft" protection then becomes the hardest dependency (10.3). So the limiter call's timeout is close to its latency budget (here 5 ms), and no retries.
- **What after the timeout?** Fail open (the abuser gets the full 10 times), fail closed (everyone is blocked, 100%). The middle road: a **local bucket (limit / N)**, each server counting by itself, approximately. It keeps the abuser at the limit (1.0x), but blocks **16%** of ordinary users, for exactly the reason in 1.5's situation 4: limit / N is small and traffic is random.
- **Breaker + generous fallback.** The breaker (9.4) stops asking the limiter for a while after a few failures, so you no longer pay even the 5 ms timeout on every request (zero extra latency). And the fallback's limit is generous, 3 × limit / N: 0% of ordinary users blocked, and the abuser gets 3.1 times the limit. Experiment 3: with a 50 ms timeout, 40–50 ms on every request when slow, and 48 requests hanging.

**Degraded Mode (local fallback limit)** - when the centre can't be reached, each server runs an approximate limit in its own memory; a share of the limit, with a generosity multiplier. The multiplier is a conscious decision: too low and legitimate customers get blocked during a limiter outage (your outage becomes theirs), too high and the abuser gets more for a while. For most APIs the right direction is generous, because the abuser's 3 times for a few minutes is handled by the downstream's bulkheads and breakers (9.4), but failing 16% of every customer's requests breaks the SLO directly.

That is why the rules have `failMode`. Login: `closed` (no brute force without a limit; 503 and `Retry-After`); the ordinary API: generous `local`; a cheap, read-only endpoint: `open`.

### 1.8 A real limiter: service, client, and two API servers

`npm run smoke` runs every decision together: an Express limiter service (`/v1/check`, `/v1/lease`, rules with Zod), a client library (timeout with `AbortSignal.timeout`, breaker, leases, per-rule fail mode, local fallback), and API servers that call the client from middleware:

```
#   step                                                      result
1   key acme: 15 on A, 15 on B, alternating                   A: 200 × 5, 429 × 10 | B: 200 × 5, 429 × 10
2   the last 429's headers                                    Retry-After: 1, source: limiter
3   clock forward 1 s, 12 more                                200 × 10, 429 × 2
4   key big-plain (1,000/s): 100 on A, check on every request  200 × 100; 100 calls to the limiter
5   key big-co: 100 to the API with leases (5)                200 × 100; 20 lease calls to the limiter
6   limiter 200 ms slow, timeout 20 ms: GET /data (local)     200, source: fallback, under 100 ms
7   at the same time POST /login (fail closed)                503, Retry-After: 1, under 100 ms
8   limiter down: 8 GET /data on A                            200 × 5, 429 × 3; source: fallback
9   network calls toward the limiter during that              3 (the breaker opens after 3 failures)
10  limiter down: POST /login                                 503, Retry-After: 1
11  limiter back, 300 ms after the breaker                    200, source: limiter, 1 network call(s)
```

- Step 1: exactly 10 across the two API servers, because counting is central. No sign of 9.5's 3x problem.
- Step 5: with leases, the same 100 requests make 20 calls to the centre instead of 100.
- Steps 6–7: the limiter is slow, but the API answers within 100 ms. `/data` runs on the fallback, login returns 503. The same outage, two behaviours by rule.
- Step 8: even with the limiter down, the fallback keeps a limit (5 pass, then 429; there are 2 servers here, so limit / 2). Step 9: after the first three failures the breaker opens, and the remaining requests never touch the network.
- Step 11: when the limiter is back, one call when the breaker's time is up, and central accounting again.

### 1.9 Several regions (not measured, for thinking)

If a customer's limit is "10,000/s across the whole world", and the API runs in three regions: going to another region's centre on every request is impossible (100+ ms, 10.8). Two ways: (1) each region has its own centre and its own **budget** (a share of the limit), and the budgets are re-divided every few seconds according to the regions' real usage: 1.5's async sync at the scale of regions, accepting its price (error during the sync window). (2) The customer has a home region (10.8's cells), and all their traffic goes there. For most APIs (1) is enough, because a few seconds of error is fine on a protective limit. Quotas are free of this question, because they are counted from usage events (1.1), which arrive in one place across regions with a delay.

### 1.10 Step 5 - Trade-offs and wrap-up

**The final design:**

- **Where:** a client library inside the gateway, straight to a Redis cluster (10 shards, with replicas across AZs). Rules in a config service, cached in every gateway.
- **How to count:** one Lua script per request on ordinary keys (all rules together, on the same shard by hash tag). Token leases on big keys (> 1,000/s), sized from the rate (lease × servers ≤ burst). Key splitting on the very biggest few keys.
- **Failure:** a 5 ms timeout, no retries, a breaker, then the rule's `failMode`: a generous local fallback for the ordinary API (3 × limit / N), closed for login, open for cheap reads.
- **Quotas:** not in the rate limiter. Usage events → log → counting → durable database; a flag in the rules when used up.
- **Deliberately absent:** GET + SET (races), limit / N as the main strategy (78% wrong on skewed traffic), async sync for the main protection (2–7x in an attack), sliding logs on ordinary rules (4.8 GB).

**What breaks first:** the hot tenant (with a sharper Zipf, one shard passes 100%, so keep leases and splitting ready for big keys from day one); the limiter having no metrics of its own (the 429 rate, the rate of requests running on the fallback, breaker openings), because a limiter running on its fallback looks healthy from outside; and a wrong rule change (one zero too many or too few), which can block every customer without a deploy. So rule changes go step by step too, like 10.6, first in "count, but don't block" (shadow mode).

---

## 2. Interview Angle

"Design a rate limiter" is one of the most common questions, and it often comes in two layers: first the algorithm (9.5), then "now it's on 500 servers". The second layer is what sets a senior apart. The shape of a good answer:

1. **What the limit is for, first.** Protection (rate limit) and contract (quota) are separate, with separate stores and separate accuracy. Limit by what (key, IP, endpoint), how many rules.
2. **Numbers.** Shards from op/s, saying that memory is not the problem, the latency budget (2% of the API's p99), and hidden costs like cross-AZ.
3. **Where to count, in four situations.** Central atomic as the default; why GET + SET is wrong (lost update, grows in an attack); why limit / N breaks on skewed traffic; leases and their sizing rule; where async sync is acceptable.
4. **Failure.** A timeout inside the budget, a breaker, per-rule fail modes, the fallback's generosity and its price.

**Follow-ups that are almost certain:**

- _"Why Redis? Each server counting by itself is faster."_ - Counting by itself gives limit × servers (9.5). Limit / N is right on even traffic, but when traffic piles onto a few servers it blocks 78% of an under-the-limit customer, and autoscaling shrinks the limit.
- _"Isn't going to Redis on every request too expensive in latency?"_ - In the same AZ, p99 ~1 ms, inside the budget. Leases on big keys (4 times fewer calls). And never a retry, with a timeout near the budget.
- _"A hot customer?"_ - The hash tag puts all their keys on one shard. More shards don't help. Leases or key splitting (random parts, even traffic).
- _"What if Redis dies?"_ - Don't stop at "fail open". Slow is worse than dead (without a timeout, thousands of requests hang on every server). Behaviour by rule, and the price of the local fallback's generosity in numbers.
- _"One global limit across two regions?"_ - Crossing regions on every request is not an option. A budget per region and re-dividing the shares every few seconds, accepting the sync window's error.
- _"Is the customer's monthly quota in this same system?"_ - No: a quota is money, so durable and exact, counted from usage events. The rate limiter only gets a "used up" flag.

**In real production:** the most common incidents: the limiter having no timeout or a long one, and the whole API's latency jumping during one slow moment of Redis (the protection itself becomes the outage); a wrong rule change that blocks everyone; one big customer's key heating up a Redis shard; nobody knowing for days that the limiter is running on its fallback, because it has no metrics; and keeping quotas in the rate limiter's store, then losing a month's accounting in a failover.

---

## 3. Key Takeaway

- **A rate limit is protection, a quota is a contract.** The first is fast and can be approximate, and losing it does no harm; the second is money, counted durably from usage events. Keep them in the same store and an eviction or failover loses money
- **A limiter's load is in op/s, not in memory.** Three hundred thousand keys are 90 MB, but 500,000 op/s means 10 shards and thousands of dollars a month in cross-AZ. All rules in one Lua script (same shard by hash tag) is half the cost
- **Without atomicity, the limit leaks during an attack:** GET + SET is 1.35x normally and 5.8x at twenty times the demand - 5.5's lost update
- **Limit / N breaks on skewed traffic:** it blocks 78% of an under-the-limit customer, and more as servers are added. **Async sync** is exact when calm and 2x in an attack (7x with a 500 ms sync)
- **Token leases cut the centre's load without breaking the limit, if lease × servers ≤ burst.** Otherwise tokens get stuck on quiet servers (11.6% wrongly blocked with a lease of 20). The size should come from the rate
- **More shards don't save you from a hot tenant** (63k → 52k). Leases or random key splitting
- **When the limiter dies, the API should not.** Without a timeout, a blackhole leaves 37,500 hanging requests on every server. A 5 ms timeout, no retries, a breaker, per-rule fail modes; and the fallback's generosity is a price: stingy (limit / N) blocks 16% of legitimate users, generous (3×) gives an abuser 3 times

---

## 4. New Terms (Glossary)

| Term                                     | Meaning                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quota (vs Rate Limit)**                | A rate limit is a protection (how many per second), approximate is fine, losing the state does no harm; a quota is a contract (how many a month, billed beyond), and must be exact and durable - counted from usage events, not in the rate limiter's store |
| **Hash Tag**                             | In Redis Cluster, only the part of a key inside `{...}` is used to work out the hash slot - all of one customer's rule keys land on one shard, so one Lua script can check them together; the price is all their load on one shard                          |
| **Approximate Sync**                     | Each server counts by itself and reconciles the total with the centre every T ms; no network on the request path, but everyone is blind during the sync window - several times the limit in an attack, growing with T and the number of servers             |
| **Token Lease**                          | A server borrows a few tokens with an expiry from the centre at once and spends them locally; the centre stays the truth and calls drop - on condition that lease × servers ≤ burst, or stuck tokens block legitimate requests                              |
| **Key Splitting**                        | A big key's limit split into K parts on separate shards; each request picks a part at random, so the parts get even traffic - spreads a hot tenant's load, at the price of fluctuation on small limits and losing all rules in one script                   |
| **Degraded Mode (Local Fallback Limit)** | When the centre can't be reached, each server runs a share of the limit × a generosity multiplier by itself - stingy blocks legitimate users, generous gives an abuser more; the middle road between fail open/closed, by rule                              |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. An enterprise customer opened a support ticket: "Our plan is 1,000/s, our dashboard says we're sending 600/s, yet we're getting 429s, especially in the morning." For which of this lesson's reasons could this happen (at least four)? For each, which metric or log would you look at to be sure? And which are the customer's fault, and which yours?

2. A new endpoint on the API: `POST /exports`, which builds a big report, takes 5 to 60 seconds, and runs heavy queries on the database. Why is the ordinary request limit (1,000/s) meaningless here? (a) Instead of "how many per second", what limit is needed, and how does it relate to Little's law? (b) What would a design that treats a request as less or more "expensive" (cost) look like? (c) What is the fail mode if this limit dies?

3. A SaaS like TaskFlow wants limits between its own services too (9.x): the billing service cannot take more than 2,000 calls a second, and six different services call it. Someone said "let's put the same rate limiter in front of billing." (a) What is the fundamental difference between an external customer's limit and protecting an internal service? (b) Why might something other than returning 429 be better here (9.4, 7.4)? (c) How will you split 2,000 among the six callers, and what happens to a caller's share when it is quiet?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

Possible causes, each with its evidence:

1. **Degraded mode.** One of the limiter's shards is slow in the morning (the morning peak), the breaker opens, and the servers run on the local fallback. If the fallback is stingy (limit / N) and the traffic is not spread evenly, it blocks below the limit (1.7's 16%). Evidence: a source header on the 429 response (`X-RateLimit-Source: fallback`, as in the exercise), and the limiter's metric for the rate of requests on the fallback, by shard. **Your fault.**
2. **Tokens stuck in leases.** The customer's traffic has piled onto a few servers, and the lease size is fixed and big: tokens are stuck in the other servers' hands (1.5's 11.6%). Evidence: the ratio of leases to use for this key per server, a metric for tokens expiring unspent. **Your fault.**
3. **Bursts, not the average.** 600/s on the dashboard is the minute's average. The customer's job might send 18,000 in 2 seconds at the start of every minute (a morning cron). With a burst of 200, they really are over the limit at that moment. Evidence: a histogram per second (or per 100 ms), not the average (10.4). **The customer's behaviour**, but your dashboard is showing them the wrong picture, and that is yours.
4. **Several rules.** The key's limit is 1,000 but an endpoint has its own limit (search 50/s), and in the morning the customer searches more. Evidence: which rule blocked it in the 429 response (the rule's name in a header or the log). **Nobody's fault, the contract is unclear**: every rule belongs in the customer's documentation.
5. **Counting retries.** The customer's client retries immediately on a 429, ignoring `Retry-After`; every retry is counted too, so it looks like more than the real demand. Evidence: repeats of the same request id or the same payload. **The customer's**, but you should show it to them.

The lesson: log three things on every 429: which rule, which source (centre, lease, fallback), and how much was left at the centre at the time. Without these, the answer to this ticket is a guess.

**Question 2:**

(a) An export's damage comes from **how many are running at once**, not how many start per second. One export a second, each lasting 60 seconds, means 60 heavy queries at once (Little's law: at once = rate × time). So a **concurrency limit**: at most 2 exports at once per customer, and 20 in the whole system. The design: increment a counter in Redis at the start (`INCR`, and decrement and 429 if over the limit), decrement at the end. And since a dead server never calls "end", each slot is a lease (with an expiry, renewed while the work runs), or a dead server's slot is stuck forever. (Stripe's published writing names a "concurrent requests limiter" separately for exactly this job.) Better still: make the export a job instead of a sync request (7.3): `POST /exports` → 202 and a job id, and the number of workers is the concurrency limit.

(b) **Cost:** a `cost` on the check (it is in the exercise's API) - an ordinary request 1 token, search 5, export 100. The same bucket, but expensive work spends more. If the cost is not known in advance (the export's size), take an estimated cost up front, then settle the real price at the end with a charge or a refund (credit), but only in the accounting, without blocking the request.

(c) An export is expensive and heavy: if the limiter can't be reached, **fail closed** (503 and `Retry-After`), or a very stingy local fallback (1 per server). Because waiting for an export is fine, but exports without a limit can bring the database down, which hurts every customer.

**Question 3:**

(a) An external limit is **fairness and contract**: each customer gets their plan, and asking for more gets refused. Internal protection is about **capacity**: billing's total is 2,000, and everyone is the same company. Nobody is an "enemy", and a refused request is often a user's work that has to happen at some point anyway.

(b) What will the caller do on a 429? Retry (7.4) - and if the backoff and jitter are not right, a retry storm. Better ways: (1) a **leaky bucket / client-side throttle** on the caller's side (the lesson of TaskFlow's migration script in 9.5): the caller itself sends at an even pace, and the extra work waits in a queue. (2) A queue in front of billing (7.2): it absorbs the waves, and billing takes work at its own pace. (3) **Load shedding** by billing itself: measuring its own capacity (latency or concurrency), it drops lower-priority calls first (10.3's brownout). Internally, "making it wait" is often better than "refusing", because the work must not be lost.

(c) The split: each caller gets a guaranteed share (say by priority: checkout 800, invoices 400, the other four 100 each = 1,600) and the remaining 400 is a shared pool, first come first served. And others may **borrow** a quiet caller's guaranteed share (work-conserving), but must give it back when it returns. This is exactly the thinking of token leases and async sync: re-dividing the shares every few seconds from real usage. And most important: a floor on checkout's share that can never be lent out, because that is money.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (four deterministic models and a real limiter service + client library + API servers; no Docker or Redis needed)

> **Ready to run in the repo:** [`exercises/lesson-11.2-rate-limiter-service/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.2-rate-limiter-service) - `npm install`, then `npm run estimate`, `npm run accuracy`, `npm run hotkey`, `npm run failure`, `npm run smoke`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out op/s, shards, network, cross-AZ cost, memory and the latency budget. `accuracy` runs six strategies (own bucket, limit / N, atomic, GET + SET, token lease, async sync) in four situations in virtual time, plus a sweep of lease sizes. `hotkey` places Zipf tenants onto shards by hash slot and measures the busiest shard. `failure` compares five policies with the store healthy, slow and blackholed. `smoke` runs a real Express limiter, client library and API servers and checks 11 steps.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the five scripts twice each (smoke three times), output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **The estimation inputs are assumed** (500,000 requests/s, 400 servers, 2 rules), and "~100,000 op/s with Lua" per Redis shard is a rough guess, not measured; the cross-AZ price is approximate, as in 10.7. `accuracy`, `hotkey` and `failure` are virtual-time models: the store's RTT is lognormal (median 0.5 ms), and GET + SET's race is in the model, not in a real Redis; async sync is simplified (all servers sync together); the breaker is simplified. `smoke` runs real HTTP, but the limiter's store is in memory, not Redis, and the limiter's clock is fake. Envoy's global rate limit service and Stripe's concurrent request limiter come from published writing, not verified here. **Not measured:** a real Redis Cluster's throughput and latency, the cost of Lua scripts, hash tag behaviour, several regions.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `accuracy`, write down: at twenty times the demand, how many times the limit will GET + SET's race let in? 1.1x? 2x? 10x? Then run it and compare, and again with `RTT_MS=2`: why does the race grow when RTT grows?

2. **Your own fallback:** `SLACK=1.5 npm run failure` and `SLACK=5 npm run failure`. How do ordinary users' blocking and the abuser's take change? If your API's SLO is 99.9%, at which multiplier does an hour-long limiter outage not break the SLO?

3. **Sync vs lease:** run `accuracy` with `SERVERS=200`. Why did async sync's load on the centre become higher than even the requests, and what happened to leases? In which situation is async sync really cheap?

4. **Changing code:** the README's experiment 5 (lease size from the rate). Then add a local cache of "this key is blocked until `retryAfterMs`" to `src/client.ts`, only for the centre's `deny`. Add an attack-like step to `smoke` and show how much the calls to the centre drop.

5. **The design part:** a "one-page design doc" for this limiter, in Lesson 1.2's five steps: (a) the separate requirements of rate limits and quotas, (b) five numbers and one decision from each, (c) where the limiter sits and why, (d) the counting strategy, with the numbers from the four situations, (e) a failure runbook: which rule has which fail mode, the fallback's multiplier, and which three metrics tell you the limiter is running on its fallback.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges), 11.1
Current: 11.2 - Case Study: Design a Rate Limiter Service
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 - URL shortener (11.1).
Case study 2 - rate limiter service: 500,000 requests/s, 400 API servers, 300,000 active keys. Rate limit (protection,
Redis) and quota (contract, usage events → durable counting) separate. Client library inside the gateway → Redis cluster
(10 shards; memory only 90 MB, the load is in op/s); all rules in one Lua script, same shard by hash tag (half the ops
and cross-AZ, ~$5k/month). Counting: atomic per request on ordinary keys; token leases on big keys (lease × servers ≤
burst, sized from the rate); random key splitting on the biggest keys. Rejected: GET + SET (5.8x in an attack), limit / N
as the main strategy (78% wrongly blocked when skewed), async sync for the main protection (2–7x in an attack). Failure:
5 ms timeout, no retries, breaker, per-rule fail mode (API generous local fallback 3×, login closed); without a timeout,
a blackhole leaves 37,500 hanging requests on every server. Multi-region: a budget per region, re-divided every few seconds.
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (vs Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit)
Weak spots: [where you got stuck - write it yourself]
Next: 11.3 - Case Study: Design a Chat System (WhatsApp-style)
=======================
```

---

## 8. Next Step

Today's thread: **at this size the question is not the algorithm but "where and how often do we count".** Every strategy looks perfect in one situation and breaks in another: GET + SET in an attack, limit / N on skewed traffic, async sync in a burst, leases when they get big. So measure all four situations, not just the pretty one. And for a protection that sits on the path of every request, its own failure is the biggest risk: without a timeout, a breaker, and fail modes decided in advance, it becomes the cause of your outage.

When you are ready, write `next` - we go to **Lesson 11.3: Design a Chat System (WhatsApp-style)**. For the first time, a system where the server has to reach the client on its own, over millions of open connections (2.4's WebSocket, this time at scale). The questions are new: which server does a message go to when the recipient is connected to another server? Where does an offline user's message wait? Who decides the order of two messages (6.4's clocks come back)? And how many writes are "delivered" and "read", the two ticks, really?
