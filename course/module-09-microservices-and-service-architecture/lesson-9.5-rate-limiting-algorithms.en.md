# Lesson 9.5 - Rate Limiting Algorithms

**Module 9 - Microservices & Service Architecture**

> **Spaced Repetition (Lesson 4.3):** What is Redis's default `maxmemory-policy`, and which one did I tell you to set for a pure cache? And the difference between `allkeys-lru` and `volatile-lru` in one line? Today that decision comes back in an unexpected place - when your rate limiter's counters live in that same Redis.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.5 (p99), Lesson 2.5 (Error contract, 429, headers), Lesson 4.3 (TTL, eviction policy), Lesson 4.6 (Thundering herd), Lesson 7.4 (Retry, backoff, backpressure), Lesson 9.2 (An API gateway's duties), Lesson 9.4 (Bulkhead, fail fast, breaker)

**By the end of this lesson you will be able to:**

1. State the differences between five rate limiting algorithms **with numbers** - which lets double through at a window boundary, which is exact and how much memory it costs, and which tolerates bursts
2. Choose between a token bucket and a leaky bucket - because the question is not "how much" but "how much at once"; and say exactly what capacity means
3. Spot the real problem with enforcing a limit across several instances (the limit × the instance count) and the price of fixing it - a shared store, its atomicity, and whether you fail open or fail closed when it dies

**Tier:** 1 - Runnable Code (five algorithms measured deterministically on a virtual clock, plus middleware on three real Express instances - no Docker needed)

---

## 0. Where TaskFlow Is Right Now

In Lesson 9.2 "rate limit" was written into the gateway's list of duties, but never installed. In Lesson 9.4 we partitioned our own workers - but never limited the load arriving from outside. This month the bill came, in three forms:

1. **One customer's script.** An integration was written to fetch all tasks every 5 seconds - but because of a bug it fell into a retry loop with no backoff (the exact opposite of Lesson 7.4). 900 requests per second from one API key. Every other customer's p99 tripled.
2. **Brute force on login.** A report from the security team: 12,000 login attempts from one IP in 40 minutes, across 200 different email addresses. There was no limit, so nobody stopped it.
3. **An axe to our own foot.** The billing service (9.3, 9.4) is called from work. A migration script, reconciling quota for 50,000 workspaces at once, sent 2,000 calls per second into billing. Billing's p99 hit 2 seconds - and 9.4's breaker opened. In other words, one of our own scripts took down one of our own services.

Someone on the team said: "Let's just drop in `express-rate-limit`, 100 per minute, done." The CTO: "Which algorithm? And we have six instances - so what is the limit actually? Measure it."

---

## 1. Theory

### 1.1 What rate limiting is, and why it comes after the bulkhead

**Rate Limiting** - deciding how many requests will be accepted in a given period for a particular identity (user, API key, IP, tenant), and turning the rest away (usually with HTTP 429).

The bulkhead from 9.4 and this are two sides of one problem. A bulkhead says "of my 16 slots, 12 are for billing" - that is **partitioning your own resources**. Rate limiting says "you may not ask for more than 10 per second" - that is **limiting the demand**. There is no third option, because resources are finite and demand has no natural ceiling.

Why one tool is not enough: a bulkhead gives you no fairness. In 9.4's exercise the create pool had 12 slots - that one customer's script from incident 1 can take nearly all 12, and every other customer queues behind it. The bulkhead saved the board, but it decided nothing about who gets what share inside task creation. The only way to decide that is to count per identity.

And one thing that is often misunderstood: a rate limit is **a fairness tool, not a security tool**. It helps against incident 2 (brute force), but it will not stop a DDoS - in an attack from a million IPs, every IP's limit is respected perfectly. That one is answered at another layer (Lesson 10.5).

### 1.2 Fixed Window Counter - the simplest, and double at the boundary

**Fixed Window Counter** - dividing time into fixed-length wall-clock windows (say each second), keeping one count per key for the current window, and resetting the count to zero when the window rolls over.

In code this is three lines - a `Map`, a `windowStart`, a `count`. In Redis, `INCR` plus `EXPIRE`. That simplicity is exactly why it is the most widely used, and its problem the most widely ignored.

The problem is that "10 per second" does **not** mean "10 in any one second" - it means "10 in each wall-clock second". At the junction of two windows, two full quotas sit side by side:

```
   limit: 10 per 1000 ms

   window 1 [0 .. 1000)          window 2 [1000 .. 2000)
   ───────────────────────┬──────────────────────────
                    ●●●●●●●●●●│●●●●●●●●●●
                    ↑ 985 ms  │  ↑ 1009 ms
                              │
                 20 got through in these 24 ms - twice the limit
```

From the exercise, `npm run window`, part A - 10 attempts at the end of a window, 10 right at the start of the next:

```
   algorithm                  allowed          span   times the limit
   fixed window                    20         24 ms              2.0x
   sliding log                     10          9 ms              1.0x
   sliding counter                 11         16 ms              1.1x
```

**20 in 24 ms.** The downstream you prepared for 10 per second gets double in that moment. And this is not a rare event - quite the opposite: if a client follows the logic "limit reached, wait for the next window" (and a good client does exactly that, obeying `Retry-After`), it will **always** land at the start of a window. The burst becomes the rule, not the exception.

### 1.3 Sliding Window Log - exact, but it costs

**Sliding Window Log** - storing the timestamp of every allowed request per key; on a new request, dropping the timestamps outside the window and counting what is left - allowed if the count is below the limit.

This is exact by definition: it answers precisely the question "how many in the last 1000 ms?" In the table above, **1.0x**, and 1.0x in every test.

It costs two things, and the second matters more:

```
── c. Memory - 50,000 users, 10 requests each ──
   algorithm                  entries    bytes/user
   fixed window                 50000           109
   sliding log                  50000           253
   sliding counter              50000           117
```

- **Memory is proportional to the limit, per user** - ~253 bytes/user at a limit of 10 (~2.3× the others). At a million users that is ~253 MB just to hold rate limits. And if the limit is not 10 but 1000 (1000 per minute - a perfectly ordinary API limit), this is roughly 100× more. The estimation habit from Lesson 1.3 applies directly: limit × user count × 8 bytes is your floor, and V8's or Redis's overhead sits on top.
- **The work per request** can be O(limit) (pruning the old entries). In Redis this is usually a sorted set (`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`) - three commands, and a Lua script for atomicity.

So the log has its place, but a specific one: **small limits on expensive resources.** Something like "5 password reset emails per hour" - exactness matters there, and keeping 5 timestamps is cheap.

### 1.4 Sliding Window Counter - and how one measurement misleads

**Sliding Window Counter** - keeping two counts (the current window and the one just before), and assuming a proportional share of the previous window's count based on how far into the current window you are: `estimate = previous × (1 − elapsed fraction) + current`.

The idea is elegant - as cheap as a fixed window (~117 bytes/user, two numbers), yet it smooths away the boundary burst. In part A above it scores **1.1x** - nearly perfect.

But this is where something surfaced while writing the exercise, and it is the most useful part of this lesson. Part A looks at **one specific** burst. The real question is different: **how much can one user get through at most?** Answering that means searching over every possible start time for the worst case:

```
   ── b. The most one user can send - the worst over every start time ──
   algorithm              worst / 1000 ms   times the limit          at phase
   fixed window                        20              2.0x            100 ms
   sliding log                         10              1.0x              0 ms
   sliding counter                     19              1.9x            820 ms
```

**Not 1.1x - 1.9x.** The same algorithm, the same code, two different measurements. Where the difference comes from: on a **new** key the previous window's count is zero, so the first window hands out the whole quota immediately; then in the next window the estimate decays gradually and drips more through. Start at the right moment (offset 820 ms here) and those two combine into 19 inside one 1000 ms span.

Two lessons come out of this, and the second is bigger than the algorithm:

1. A sliding window counter is an **approximation** - it saves memory, not accuracy. It is used at places like Cloudflare because 1.9x is acceptable to them and the memory saving is enormous. Whether it is acceptable for you is decided by your downstream, not by the algorithm's name.
2. **Never judge a protection by one measurement.** Looking at part A I could have concluded the counter was nearly as good as the log - and been wrong. A protection question is always "what happens in the worst case", never "what usually happens". That was true of 9.4's breaker too, and it will be true through almost all of Module 10.

### 1.5 Token Bucket and Leaky Bucket - the question is not "how much" but "how much at once"

The three algorithms above answer one question: "has the limit been exceeded?" The two buckets ask a different one: "in what shape will the load arrive downstream?"

**Token Bucket** - a bucket per key into which tokens accumulate at a fixed rate up to a maximum capacity; each request spends one token, and a request with no token available is rejected - meaning saved-up tokens can let a burst through, after which you are bound to the refill rate.

**Leaky Bucket** - a queue of fixed size that requests enter and leave at a fixed rate; if the queue is full new requests are rejected, and accepted requests **wait** and leave at an even pace.

The key difference is not in the acceptance rate - it is in the **shape of the output**. From the exercise, `npm run bucket`, the same arrivals (a burst of 30 at t=0, then 5/s), rate 10/s, capacity 10:

```
   token bucket - the burst goes out at once:
         0 ms   11  ███████████
       250 ms    1  █
       500 ms    1  █
       750 ms    1  █
   leaky bucket - the same arrivals, going out at an even pace:
         0 ms    3  ███
       250 ms    2  ██
       500 ms    3  ███
       750 ms    2  ██

   peak instantaneous load downstream (per 250 ms): token bucket 11 · leaky bucket 3
```

The average rate is ~10/s for both. But what the downstream feels is not the average - it is the **peak**: 11 versus 3. And the leaky bucket's price is right there: accepted requests have to wait (the longest measured wait was 1.00 s), which means the user's latency goes up. A token bucket makes nobody wait - either go now, or get a 429.

And capacity means exactly what it says:

```
   capacity                     passed  passed in burst       load/250ms
   1                                16                1                2
   5                                20                5                6
   10                               25               10               11
   50                               45               30               31
```

**Capacity = how large a burst you are willing to let reach your downstream.** This is not a magic tuning number, it is a direct decision. And there is a real tension here: capacity 1 gives the lowest load (2), but when TaskFlow's board opens the browser fires 8 API calls at once - capacity 1 means seven 429s, every time. So the right capacity comes from your **normal** client's behaviour: how many calls in one page load? That is your floor.

Broadly: **a token bucket in front of an API** (clients are naturally bursty, and a fast 429 beats making them wait - the same fail-fast reasoning as 9.4); **a leaky bucket in front of a fragile downstream** (it has to be fed at an even pace, and waiting is acceptable) - like incident 3's migration script, which would never have opened the breaker had it called billing at an even pace.

### 1.6 Six instances, one limit - this is where the real mistake is

Now the most expensive part, and it is not a question about algorithms at all.

`express-rate-limit`'s default store is **in-memory** - each process's own `Map`. TaskFlow's six instances mean six separate counts. The gateway (9.2) round-robins the traffic, so one user's requests spread across six - and each instance independently believes it is under the limit.

From the exercise, `npm run distributed` - three real Express instances, limit 10, one user sending 60 requests round-robin:

```
   where counted                   200      429     real limit  store call
   each instance counts its own    30       30         3.0x             0
   shared store (RTT 1 ms)            10       50         1.0x            60
```

**The actual limit = your written limit × the instance count.** Three instances give 3.0x, six give 6x. And the most dangerous part: under autoscaling your limit rises **by itself**, with no deploy and no alert. The config still says "100 per minute" while reality is 600 - and nobody notices until the downstream falls over.

**Distributed Rate Limiting** - keeping the count in a store shared by everyone (usually Redis) instead of in each instance's own memory, so the limit does not depend on the instance count.

It costs three things, and I will be honest about which I measured and which I did not:

- **One extra network call per request** - 60 store calls for 60 requests in the exercise, counted. But its latency cost **could not be measured** here (p99 swings between 0.7 and 2.1 ms; the store is in the same process and the RTT is a 1 ms pretence). Against a real Redis, especially across availability zones, this is added to every single request.
- **Atomicity** - if "read, then increment" are two separate calls, two instances can read the same stale value at the same time and both allow. Redis's answer is `INCR` (atomic by itself) or a Lua script (the whole decision in one step). The exercise does not simulate this - one process, so no race; in a real distributed limiter it is the subtlest part.
- **The store is now a hard dependency** - what happens when Redis dies? **Fail open** (let them through, no limit) or **fail closed** (429 for everyone)? Both are bad, and the answer differs per endpoint: fail open for reading the board (having no rate limit is a temporary risk, but the site stays up), fail closed for login (brute force would run unchecked, and that is not acceptable). This has exactly the same shape as 9.4's "error or fallback when the breaker opens" - and, the same way, it is **a business decision, not the tool's**.

And this is where today's spaced repetition comes back: if the limiter's keys live in that same Redis as the cache, with `maxmemory-policy` set to `allkeys-lru` (Lesson 4.3), then under memory pressure **the limiter's counters can be evicted** - and an evicted counter means the limit silently disappears. The remedy: a separate Redis for the limiter (or a separate database/namespace), and caution even with `volatile-lru` - because the limiter's keys do have TTLs, which puts them squarely on the list of eviction candidates.

### 1.7 What the 429 response should look like

Enforcing the limit is half the job; telling the client properly is the other half. A continuation of the error contract from Lesson 2.5:

```
   attempt 1: status 200 · x-ratelimit-remaining: 1
   attempt 2: status 200 · x-ratelimit-remaining: 0
   attempt 3: status 429 · x-ratelimit-remaining: 0 · retry-after: 1s
```

- **429, not 503** - 429 says "you are asking for too much", 503 says "I have fallen over". A client's behaviour should differ between the two.
- **`Retry-After`** - without it, even a good client will retry blindly, and that is precisely a retry storm (7.4). The limiter itself knows the number (the exercise's `retryAfterMs`), so there is no reason to withhold it.
- **`X-RateLimit-Limit` / `-Remaining`** - so a client can slow itself down **before** it reaches the limit. With these, incident 1's integration might have throttled itself.
- **Which key the limit is on** - user id (logged in), API key (integrations), IP (anonymous, and login). Incident 2's brute force needs separate limits on both IP and email, because one IP was trying many emails.

One subtlety that is often got wrong: the 429 response has to be **cheap**. If you still touch the database after the limiter's decision (to check whether the user is valid, say), then the attacker is making you do exactly the work you were trying to prevent. The middleware goes first - before the routes, as in the exercise's `app.use(middleware)`, and in a real system earlier still, at the gateway (9.2).

### 1.8 TaskFlow's decision

**Where:** in two layers. A coarse limit at the gateway (9.2) per API key and per IP - cheap, and this is what stops incidents 1 and 2 before any service is touched. Then each service's own finer limits on its expensive endpoints (search, export, invoice).

**Which algorithm:** a **token bucket** for ordinary API limits - clients are bursty (8 calls when the board opens), and a fast 429 beats making them wait. Capacity is twice a normal page load (20), with a refill rate of 10/s per user. Fixed window is **not** being used, because of the 2× in 1.2; the sliding log only where limits are small and the work expensive: password reset (5 per hour), invite emails (20 per hour), exports (3 per day).

**Login:** a sliding log per IP (20 attempts per hour) **and** a separate count per email (10 per hour) - whichever runs out first. Exactness matters here and the numbers are small, so the log's cost is negligible.

**Our own scripts (incident 3):** this is not a rate-limiting question at all - the migration script has to throttle **itself** with a **leaky bucket** (client-side), calling billing at an even pace. The real rule is simple: **our own batch work never enters a user's path without a limit.**

**Store:** a **separate Redis instance** for the limiter, not shared with the cache - because of the eviction problem in 1.6. The decision in a single Lua script (atomicity). When Redis dies: fail open for reading the board and tasks, but fail closed for login, export and invoice. Each of those decisions goes in the runbook, not hidden in code.

**Three numbers on the dashboard:** the 429 rate (per endpoint), the number of users approaching their limit (those past 80% - this shows up first if a limit is set too low), and the limiter store's p99. Without the first two you cannot tell whether the limit is hurting users or protecting them.

---

## 2. Interview Angle

**"Design a rate limiter"** - this is such a standard question that Module 11 devotes a whole case study to it (11.2). The structure: first **what the limit is keyed on** (user / API key / IP - and why several layers), then the **algorithm** (why a token bucket by default, the 2× problem with fixed windows, where the sliding log belongs), then **where the counting lives** (this is the real question - in-memory means the limit × the instance count, hence Redis; Lua for atomicity), then **failure** (fail open or closed when Redis dies, differing per endpoint), and finally the **contract** (429, `Retry-After`, `X-RateLimit-*`).

**"What's wrong with a fixed window?"** - say it with numbers: limit 10/second, yet 20 in 24 ms at a window junction - 2×. And if a good client obeys `Retry-After` and waits, the burst becomes the rule. A bonus almost nobody mentions: the sliding window **counter** is an approximation too - change how you measure and it goes up to 1.9x.

**"Token bucket versus leaky bucket?"** - weak answer: "one accumulates tokens, the other leaks." A good answer talks about shape: the average rate is the same, but the peak load downstream is 11 versus 3; a token bucket makes nobody wait (429), a leaky bucket does (latency). Hence a token bucket in front of an API, a leaky bucket in front of a fragile downstream.

**In production, in practice:** the familiar stories - shipping `express-rate-limit`'s default in-memory store to production, then having the limit rise by itself under autoscaling; not sending `Retry-After` and getting a synchronised retry storm from all clients; putting the limiter's keys in the cache's Redis and having the limit vanish on eviction; using `req.ip` behind a proxy so every user shares one IP (the load balancer's) and all traffic lands in one bucket; keying on IP so everyone behind one office or NAT gets blocked together; and leaving your own batch jobs outside the limits, then taking down your own service.

---

## 3. Key Takeaway

- Rate limiting and the bulkhead (9.4) are two sides of one problem - a bulkhead **partitions your own resources**, a rate limit **limits demand**; a bulkhead gives no fairness, and that requires counting per identity
- **A fixed window lets double through at the boundary** - measured: limit 10/s, yet 20 in 24 ms; and if good clients obey `Retry-After`, the burst is the rule, not the exception
- **The sliding log is exact (1.0x) but its memory is proportional to the limit, per user** - ~253 bytes/user, ~253 MB at a million users; its place is small limits on expensive work
- **The sliding counter is an approximation** - 1.1x by one measurement, **1.9x** across all offsets; and the larger lesson: a protection cannot be judged by one measurement, the question is always "what is the worst case"
- **Token versus leaky - the question is not "how much" but "how much at once"** - same average rate, peak load downstream 11 versus 3; a token bucket gives a 429, a leaky bucket makes you wait
- **Capacity = how large a burst you are willing to let reach your downstream** - literally (capacity 10 → exactly 10 in the burst); the floor comes from your normal client's behaviour
- **The actual limit = the written limit × the instance count** - measured 3.0x; and under autoscaling it rises by itself, with no deploy and no alert
- A shared store's cost: one call per request, **atomicity** (Lua in Redis), and **fail open or fail closed** when it dies - differing per endpoint, and a business decision
- Keeping the limiter's keys in the cache's Redis lets `allkeys-lru` (4.3) **evict** them - the limit silently disappears
- The 429 response must be cheap and must carry `Retry-After` plus `X-RateLimit-*` - otherwise you are manufacturing a retry storm yourself

---

## 4. New Terms (Glossary)

| Term                          | Meaning                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rate Limiting**             | Deciding how many requests will be accepted in a given period for a particular identity (user, API key, IP, tenant), and turning the rest away (usually with HTTP 429)                                            |
| **Fixed Window Counter**      | Dividing time into wall-clock windows and keeping one count per key for the current window; simple and cheap, but it places two full quotas side by side at a window junction (twice the limit)                   |
| **Sliding Window Log**        | Storing every allowed request's timestamp per key, pruning those outside the window and counting the rest; exact by definition, but memory and work are proportional to the limit, per user                       |
| **Sliding Window Counter**    | A weighted estimate from the current and previous windows' counts (`previous × (1 − elapsed) + current`); as cheap as a fixed window, but an approximation - up to roughly 2× in the worst case                   |
| **Token Bucket**              | Tokens accumulate at a fixed rate up to a capacity; each request spends one, and with none left you get a 429 - saved tokens let through a burst exactly the size of the capacity, and nobody ever waits          |
| **Leaky Bucket**              | Requests enter a fixed-size queue and leave at a fixed rate; a full queue means rejection, and accepted requests wait - the downstream receives load at an even pace, at the price of added latency               |
| **Distributed Rate Limiting** | Keeping the count in a shared store (usually Redis) rather than each instance's own memory, so the actual limit does not depend on the instance count; the price - an extra call, atomicity, and a new dependency |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines in your own words for each.

1. TaskFlow's public API has a limit of "1000 requests per hour per API key". (a) With a fixed window, what is the most requests a client can send within any one hour (any 60-minute span), and in how little time? (b) Work out the sliding log's memory for this limit, assuming 50,000 API keys (scale from the exercise's bytes/user). Is it viable? (c) Which algorithm would you choose, and how would you break "1000 per hour" up so a client cannot spend the whole quota in a minute?

2. TaskFlow's limiter is now in Redis, a fixed window using `INCR` + `EXPIRE`. (a) What happens if the process dies after the `INCR` but before the `EXPIRE`, and how long does that consequence last? How would you fix it? (b) Why is "read, compare, increment" unsafe when two instances work on the same key at the same time - and how does `INCR` avoid it? Why is `INCR` not enough for a token bucket (which needs floating-point numbers and time)? (c) Redis was down for 30 seconds. Write your fail open / fail closed decision separately for `/api/tasks` (a read), `/api/login`, and `/api/export`, with the reason for each.

3. A new enterprise customer's 800 employees sit behind one office NAT - they all share one public IP. And TaskFlow's apps, behind a load balancer, use `req.ip`. (a) There are two distinct bugs here - name them separately, and say what each looks like from a user's point of view. (b) What is the fix for each? (c) Even after fixing them, those 800 people are still on one IP - how will you apply limits: on what key, and what will you do for anonymous (pre-login) requests?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) With a fixed window the window is one hour. In the worst case a client sends 1000 at the very end of one hour and 1000 at the very start of the next - **2000 requests**, and the timing can be within a few seconds (as long as it takes to send 2000 requests; the exercise showed 24 ms at a limit of 10). The ratio is the same - **2×** - but the quantity is frighteningly larger, because the window is large. That is the danger of a large window: the ratio does not change, the size of the burst does.

(b) In the exercise, at a limit of 10, the sliding log used ~253 bytes/user, of which ~109 bytes is roughly fixed overhead (the Map entry, the key string) and the remaining ~144 bytes covers 10 timestamps plus array overhead - about ~14 bytes per timestamp. At a limit of 1000 that is roughly `109 + 1000 × 14 ≈ 14 KB` per key. At 50,000 keys, **~700 MB**. Not viable - at least not for a rate limiter, and the number scales directly with the client count. (The figure is an estimate from the exercise's measured ratio; run experiment 2 with `LIMIT=1000` to measure the real number.)

(c) A **token bucket**, with "1000 per hour" split into two dimensions: a refill rate of `1000/3600 ≈ 0.28` tokens/s, and a small capacity (say 50). The long-run rate is still 1000 per hour, but at most 50 can go at once - spending the whole quota in a minute becomes impossible. This is the loveliest property of a token bucket: **the long-run rate and the instantaneous burst are set separately**, whereas a window-based algorithm has to express both with one number. You could add another layer (a per-minute limit), but the capacity already does the job.

**Question 2:**

(a) `INCR` creates a new key **without a TTL** (a new key in Redis has no expiry by default). If the process dies before the `EXPIRE`, that key lives **forever** - and its value never returns to zero, meaning that user is limited permanently (or the window never resets). The fix: make the two commands one - `SET key 0 EX 60 NX` followed by `INCR`, or best of all, put the whole decision in a **Lua script** (Redis runs Lua scripts atomically). On modern Redis, `EXPIRE` only when the key is new - also inside the Lua.

(b) "Read, compare, increment" is three separate steps - two instances read the same stale value (say 9) at the same time, both see 9 < 10, both allow, and both write 10. Result: 11 got through on a limit of 10. This has exactly the shape of the lost update from Lesson 5.5, now in Redis. `INCR` avoids it because Redis executes one command to completion single-threadedly - reading and incrementing are indivisible, and it returns the value after incrementing, so no separate read is needed to decide.

`INCR` is not enough for a token bucket because the state there is not one number - it is at least two (`tokens` and `last`), and the arithmetic is time-dependent floating point (`gained = (now − last) × rate`). That does not fit in one atomic integer operation. So doing a token bucket in a distributed way needs a Lua script that reads both fields, computes with the clock, decides and writes - all in one step. (This is why many libraries fall back to a fixed window or sliding counter in distributed mode - those fit into `INCR`.)

(c) Three different answers:

- `/api/tasks` (a read) - **fail open**. Some extra reads happen without a limit; that is a tolerable risk. Fail closed would turn Redis's 30-second problem into a 30-second outage of the whole product. The reasoning from 9.4 applies: a supporting dependency must not take down the main job.
- `/api/login` - **fail closed** (or at least a strict in-memory fallback limit). Login without a limit is an open door for brute force, and 30 seconds is enough to do real damage. Here, 30 seconds of no logins is less bad than the security risk.
- `/api/export` - **fail closed**. Exports are expensive (CPU, memory, object storage - Module 8). Unlimited exports mean a handful of people can take the service down. And an export is rarely needed instantly, so 30 seconds of unavailability is acceptable.

The general rule: **where the risk of having no limit exceeds the inconvenience of having one, fail closed.**

**Question 3:**

(a) Two bugs:

1. **`req.ip` is showing the load balancer's IP.** With a proxy in front of the app, the TCP connection comes from the proxy, so `req.ip` is the same for every user (the LB's). That puts **all traffic in one bucket** - the limit is exhausted within seconds, and then everyone gets a 429. From a user's point of view: "nothing works, for all of us at once", and oddly worse during the busy morning period.
2. **800 people behind one NAT share one public IP.** This survives the first fix: now the limit really is keyed on the client IP, but that office's 800 people have one IP between them. From a user's point of view: "TaskFlow is slow/429 in our office, fine from home" - the hardest kind of support ticket, because the symptom looks geographic.

(b) The fixes:

1. Set `app.set('trust proxy', …)` correctly in Express (how many proxy hops to trust - as a number, not `true`), so `req.ip` reads the right part of `X-Forwarded-For`. Important: trusting `trust proxy = true` blindly lets a client send its own `X-Forwarded-For` and claim any IP - an easy way around your limit. So trust only your own LB's hops. Better still, use your LB's own trustworthy header (the same reasoning as 9.2's signed gateway header - a client's claims cannot be trusted).
2. The NAT problem is not solvable with IPs - **the identity has to change**.

(c) Three layers of key, using the most specific identity available:

- **Logged-in requests:** key = user id (and for enterprises, a separate larger limit per workspace/tenant alongside it). Then each of those 800 people gets their own quota and the office NAT becomes irrelevant. The per-tenant limit is needed too - otherwise one customer's 800 people can eat everyone else's resources (which is 1.1's fairness question again, this time at tenant level).
- **Integrations:** key = API key. The IP is irrelevant.
- **Anonymous (pre-login):** there is no user id here, so there is little alternative to IP - but keep the limit **generous** (thinking of NATs), and do not rest login's security on an IP limit alone: a separate count per email (as in 1.8), increasing delays after failed attempts, and a CAPTCHA or second factor after several failures. In other words, on the anonymous path a rate limit is one layer, not the only defence - the practical form of 1.1's "a rate limit is a fairness tool, not the sole security tool".

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (Express middleware + real HTTP; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-9.5-rate-limiting/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.5-rate-limiting) - `npm install`, then `npm run window`, `npm run bucket` and `npm run distributed`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`window` puts the three window algorithms through the same test - a burst arranged around a window boundary, then the worst case over **every possible start offset** for how much one user can send, and finally how much memory each costs per user at 50,000 users (measuring the heap before and after with `--expose-gc`). `bucket` runs identical arrivals (a burst of 30 at t=0, then 5/s) through a token bucket and a queue-based leaky bucket and draws the **shape of the output** side by side, then shows burst tolerance versus peak downstream load at capacities of 1 / 5 / 10 / 50. `distributed` runs three real Express instances with the same middleware - once with per-instance counting, once with a shared store - and finally prints the real 429 response (`retry-after`, `x-ratelimit-*`).

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` and ESLint clean; the three scripts **three times each** - **every count identical on every run** (20, 10, 19, 11, 3, 30, 10, 60), fixed window at 108–109 bytes/user in the memory test (the other two unchanged), and `distributed`'s p99 swinging between 0.7 and 2.1 ms. In the first two scripts **time is virtual** - `check(key, now)` is handed a hand-counted `now`, so the results are fully deterministic, the same on any machine; that is deliberate, so that scheduler noise does not leak into a comparison of algorithms. In the third script Express, HTTP, the middleware, the 429 and the headers are all real. **The "shared store" is not Redis** - it is an object in the same process with an `await sleep(1)` pretending to be RTT; so that RTT's latency cost **could not be measured** here (the p99 difference is the size of the noise), and Redis's atomicity (`INCR`, Lua) is not simulated either - one process, so no race; 1.6 discusses it without running it. The memory figures are `heapUsed` deltas - an estimate, not hand-counted bytes; the comparison is what matters, not the absolute number. The leaky bucket here is a queue; the "meter" form is not shown. **Not measured:** what happens when the limiter dies (fail open vs fail closed), races between one user's concurrent requests, key TTLs and eviction, IP vs user vs API key, and multiple tiers of limit - 1.6–1.8 and the Answer Key discuss these. TaskFlow's decision in 1.8 is a design, not something that was run. The remark about Cloudflare using a sliding counter is a summary of their published writing.

**Once the setup checks out, do these five:**

1. **Predict first:** before running `window`, write down - limit 10/second, fixed window. What is the most that can get through at a window boundary, and in how little time? Then the same question for the sliding window **counter** - is your guess 1.1x or 1.9x? Compare the two tables, and write one line on whatever surprised you.

2. **The memory wall:** experiment 2 - `LIMIT=1000 USERS=20000 npm run window`. What are the bytes/user for all three? In the Answer Key for question 1(b) I estimated ~14 KB/key by scaling - what is the measured number, and how wrong was I? How much RAM for each algorithm at a million clients?

3. **Capacity and user experience:** experiment 3 - `CAPACITY=1 npm run bucket`, then `CAPACITY=100`. Note the "load/250ms" column. Now think about TaskFlow's board opening (the browser fires 8 calls at once): at capacity 1, 5 and 20 - what does the user see in each? Which would you pick, and where did that number come from?

4. **How a limit rises by itself:** experiment 4 - add two ports to `PORTS` in `distributed.ts` to make five instances. What happened to the "actual limit" column? Now compute: if TaskFlow runs 2 instances at night and 20 during the day, what does your "100 per minute" actually range between? Which single metric on a dashboard would have caught this?

5. **The design part:** a one-page rate limiting design for TaskFlow: (a) a table - endpoint class (read, write, login, export, invite, public API), and for each the key (user / API key / IP / tenant), algorithm, limit and capacity; (b) where it is enforced (gateway or service) and why; (c) for each class, fail open or fail closed when Redis dies, with the reason; (d) the argument for keeping the limiter's Redis separate from the cache's, plus the naming and TTL rules for keys; (e) three numbers for the dashboard, and the value at which you would alert on each; (f) how your own batch jobs (migration, reconcile, reindex) will throttle themselves - which algorithm, and what number.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8 (complete, with exit challenges), 9.1, 9.2, 9.3, 9.4
Current: 9.5 - Rate limiting algorithms (Token Bucket, Sliding Window - Express middleware)
TaskFlow state: modular monolith (work, identity, files, search) + files processing + billing service;
gateway + web/mobile BFF (9.2); "create task" = orchestrated saga (9.3); billing discovery =
Kubernetes Service + readiness probe, breaker per dependency+endpoint, bulkhead 12/4 (9.4);
rate limits in two layers - a coarse limit at the gateway (API key + IP), finer limits in each
service on expensive endpoints; ordinary APIs = token bucket (capacity 20 = twice a normal page
load, refill 10/s per user), fixed window not used (2× at the boundary); sliding log only for
small-limit expensive work (password reset 5/hour, invites 20, exports 3/day); login = 20/hour per
IP plus 10/hour per email, whichever runs out first; a separate Redis for the limiter (the cache's
allkeys-lru was evicting its keys), the decision in one Lua script; when Redis dies: fail open on
reads, fail closed on login/export/invoice - written in the runbook; our own batch jobs (migration,
reconcile) throttle themselves with a client-side leaky bucket; dashboard: 429 rate per endpoint,
users past 80% of their limit, limiter store p99
Terms learned (Module 9): Monolith / Microservices, Database per Service, Conway's Law, Modular
Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall, Over-fetching,
Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication, Service Mesh (mTLS),
Two-Phase Commit (2PC), In-doubt Transaction, Saga, Compensating Transaction, Pivot Transaction,
Orchestration / Choreography, Semantic Lock, Service Discovery, Service Registry, Client-side /
Server-side Discovery, Circuit Breaker, Half-Open Probe, Bulkhead, Fail Fast, Rate Limiting, Fixed
Window Counter, Sliding Window Log, Sliding Window Counter, Token Bucket, Leaky Bucket, Distributed
Rate Limiting
Weak spots: [where you got stuck - write it yourself]
Next: Module 9 Exit Challenge
=======================
```

---

## 8. Next Step

That is all five lessons of Module 9. One thread ran from start to finish: in **9.1** we measured the three costs of breaking up a monolith and decided to break it carefully; in **9.2** we put a gateway and a BFF in front of the extracted services; in **9.3** we handled a transaction crossing a boundary with a saga; in **9.4** we surrounded one of that saga's calls with discovery, a breaker and a bulkhead; and in **9.5** we decided who is allowed to ask for how much. The same pattern returned at every step - **each convenience opened a new path to failure, and handling that took a new tool.** That is the real cost of microservices: not the shape of the code, but the number of these tools and their tuning.

When you are ready, write `next` - we go to the **Module 9 Exit Challenge**: an incident review where the decisions from these five lessons appear together, and in several places deliberately installed wrong. The old questions from Modules 5–8 (dual writes, eventual consistency, idempotency, replica lag) will come back in new clothes too - because in reality they never go away, they only get harder once they cross a service boundary.
