# Lesson 4.6 — Cache Failure Patterns: Stampede, Hot Key, Penetration

**Module 4 — Caching**

> **Spaced Repetition (Lesson 3.4):** What are the steps of a graceful shutdown, and why does it work for planned maintenance but not for a sudden crash?

**Prerequisite:** Lesson 4.4 (Redis Hands-on), Lesson 4.3 (TTL, Eviction)

**By the end of this lesson you will be able to:**

1. Tell apart four kinds of failure — cache stampede, hot key, penetration and avalanche
2. Choose the right remedy for each (single-flight, TTL jitter, local cache, negative caching)
3. Trigger a stampede on your own machine, then fix it — and show the difference **in numbers**

**Tier:** 1 — Runnable Code

---

## 0. Where TaskFlow Is Right Now

Throughout Module 4 we added caching to TaskFlow, and it works — measured: DB path ~12 ms, cache path ~3.7 ms, hit ratio 20/20.

So everything is fine? No.

Today's core idea will sound a little odd, but it is the truth:

> **A cache's most dangerous failures happen when the cache was working fine.**

Without a cache your DB would take 100% of the load every day — slow, but stable. After adding the cache, the DB now takes 5%. But that means your DB is now sized for a load that is smaller than what can come back at any moment. **The cache has created a dependency, and that dependency has its own ways of breaking.**

Today we look at those ways — and the first one we won't just read about, we will **trigger** it on our own machine.

---

## 1. Theory

### 1.1 Cache Stampede — everyone missing at once

Picture the scene. A popular TaskFlow list, `tasks:user:7`, with a 60-second TTL. 50 requests are arriving per second.

```
t = 59.9s   in the cache   →  all 50 requests HIT, the DB is calm
t = 60.0s   TTL ends       →  the key is deleted
t = 60.1s   50 requests    →  all 50 MISS
                           →  all 50 send the same query to the DB at the same moment
```

50 requests, asking for **the same answer**, asking the DB 50 separate times. 49 of those queries are pure waste — once the first one's answer arrived, everyone else's work would have been done.

This is called a **cache stampede** (or **thundering herd** — like a herd of buffalo charging together). At 50 you might survive, but at 5000 the DB's connection pool runs out, the query queue piles up, latency rises — and as latency rises, even more requests pile up together. It is a self-feeding cycle.

**This isn't just theory — in the exercise you will trigger it yourself.** Measured on my machine:

```
50 requests at once, cache just emptied, DB query ~200ms:

  without single-flight : DB queries  50   (802 ms)
  with single-flight    : DB queries   1   (254 ms)
```

**From 50 to 1.**

### 1.2 An essential condition — the stampede's "window"

Did you notice `DB query ~200ms` in the measurement above? It isn't decorative — **it is the condition for the whole thing**.

When building this exercise I first tried with the real query (~12 ms), and the stampede **didn't happen at all** — sending 50 requests produced only 1-2 DB queries. Because:

```
t=0ms    req1 missed, went to the DB
t=12ms   req1's answer arrived, written to the cache
t=13ms   req2..req50 arrived  →  found it in the cache  →  HIT
```

The first request finished so fast that the cache was filled before the rest arrived. **The span of time during which the cache is empty and the first load is running — that is the stampede's window.** If the window is narrow, the problem effectively doesn't exist.

The lesson from this:

> **A stampede is dangerous only when the origin's work is slow** — a heavy aggregation, an external API call, a complex join. Worrying about stampedes on cheap queries is a waste of time.

That is why the exercise simulates an "expensive query" with `?delay=200` — otherwise the problem wouldn't even be visible. In your production, the question is therefore two-step: _which endpoints are slow?_ and _which of those are popular?_ — stampedes live where these two intersect.

### 1.3 Single-flight — one key, one load

The idea behind the fix is simple: **for a given key, only one DB query runs at a time**, and the rest wait for its result.

```
without:  req1 ──> DB        req2 ──> DB       req3 ──> DB     (3 queries)

with   :  req1 ──> DB ──┐
          req2 ─────────┤ waiting for the same promise          (1 query)
          req3 ─────────┘
```

In Node this takes surprisingly little code, because **a promise is itself something that can be shared**:

```typescript
const inFlight = new Map<string, Promise<unknown>>();

export async function single<T>(key: string, load: () => Promise<T>): Promise<T> {
	const running = inFlight.get(key);
	if (running !== undefined) {
		// someone else is already loading this key — instead of running a new query,
		// wait for their result
		return (await running) as T;
	}

	const promise = load().finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
}
```

**A subtle trap — what you wrap matters.** When building this exercise I first wrapped only the DB load in `single()` and left the cache write outside. Result: instead of 50, **2** DB queries — not 1. Because a narrow gap was left:

```
load finishes  →  finally runs, the in-flight entry is deleted
                  ↑ at this moment nothing has been written to the cache yet
                  ↑ a request arriving right now will miss, and won't find it in-flight either
                  ↑ so it will start another load
written to the cache
```

The fix: **wrap the load and the cache write together**, so the in-flight entry survives until the cache is filled:

```typescript
const loadAndCache = async (): Promise<TaskDTO[]> => {
	const rows = await loadFromDatabase(userId, completedOnly);
	await writeList(key, rows, TTL_SECONDS);
	return rows;
};
const tasks = await single(key, loadAndCache);
```

Only after fixing this does the number drop from 2 to 1. The general lesson: **in concurrency problems, if the boundary of "what am I protecting" is off by one step, a bug remains** — and such bugs never show up while load is low.

**An important limitation:** this Map lives **inside one process**. If TaskFlow runs 4 server instances (remember Module 3?), each instance has its own Map — so 50 queries won't drop to 1, they'll drop to **4**. 50 to 4 is a huge improvement too, but to get 1 you need a **distributed lock** (`SET key value NX PX 5000` in Redis), which is the topic of Lesson 6.4.

**An alternative technique, without code:** remember `stale-while-revalidate` from Lesson 4.5? The same logic works in Redis too — keep the stale value for a while even after the TTL ends, and when someone asks, **serve the stale one immediately** while one worker fetches the new one in the background. Nobody waits, and the DB takes only one hit.

### 1.4 TTL Jitter — so they don't all die together

Stampede has a big brother. Imagine your server restarted (a deploy, or after Lesson 3.4's graceful shutdown). The cache is empty. In the first minute 1000 different keys enter the cache — **all with a TTL of exactly 300 seconds**.

```
t = 0s     1000 keys entered the cache, all with a 300s TTL
t = 300s   1000 keys die together  →  1000 stampedes at once
```

Every 5 minutes your DB will take a wave. This is called a **cache avalanche** — many keys expiring together.

The remedy is laughably simple — mix a little **randomness** into the TTL:

```typescript
const BASE_TTL = 300;
const ttl = BASE_TTL + Math.floor(Math.random() * 60); // 300–360s
```

Now those 1000 keys die spread across 60 seconds, not together. This is called **TTL jitter**. A one-line change, but without it your DB keeps getting periodic spikes — and finding the cause of those spikes is terribly hard, because on a graph they look like "a mysterious peak every 5 minutes".

### 1.5 Hot Key — a key so popular it is the problem itself

Now a completely different kind of failure. Say a shared project's task list in TaskFlow is viewed by **the whole company** — 50,000 requests a second, all on the same key.

Cache hit ratio 100%. No problem with the TTL. Yet the system is struggling. Why?

Because **a key always lives on one specific Redis node**. In a Redis cluster, keys are hashed and split across shards — so even if you add 10 nodes, all of that one key's traffic goes to **one node**. And since Redis is single-threaded, that one node's CPU sits at 100% while the other 9 are idle.

This is called the **hot key** problem. There are two solutions:

**(a) Local (in-process) cache — an L1 layer.** Keep the most popular keys in **each app server's own memory** for a few seconds:

```
request ──> [process memory, TTL 5s] ──> [Redis] ──> [DB]
                  ~0.001 ms              ~0.5 ms
```

With a 5-second local cache, 50,000 req/s towards Redis can be brought down to roughly **number of servers ÷ 5**. The price: another layer of staleness is added, and each server may hold slightly different data.

**(b) Key splitting.** Keep the same value under several different keys (`hot:project:3:0` … `hot:project:3:9`), and have each request pick one at random. Different key means different hash, means different node — the load is spread. The price: to invalidate, you have to delete all 10.

### 1.6 Cache Penetration — repeatedly looking for what doesn't exist

This kind is the craftiest, because here the cache seems to be "working".

Someone (a buggy script, or an attacker) keeps asking for ids that **don't exist at all**:

```
GET /api/tasks/999999   →  not in the cache (normal, the thing doesn't exist)
                        →  went to the DB  →  the DB also says "not found"
                        →  nothing is written to the cache  ← this is the trap
                        →  next time, the same thing happens again
```

Every request goes all the way to the DB. These are counted as misses in the hit ratio, but next to the total traffic the number is small, so it doesn't stand out — and unlike normal misses, they never "heal": **the same key misses again and again**. For those keys, **the cache has effectively been bypassed.**

Remedies:

**(a) Negative caching** — cache the "not found" answer too, but only for a short time:

```typescript
if (task === null) {
	await redis.set(key, 'NOT_FOUND', 'EX', 30); // short TTL
}
```

Keeping the TTL short is essential, otherwise even if the thing really does get created, it will keep saying "not found" for 30 seconds.

**(b) Bloom filter** — a tiny probabilistic structure that can say "this id **definitely doesn't exist**" or "it might exist". If it is "definitely doesn't exist", there's no need to go to the DB at all. This is the topic of Lesson 10.2.

### 1.7 All four together

> **Trade-off Table — Which Failure, Which Remedy**

| Failure         | When it happens                           | Symptom                                 | Remedy                                |
| --------------- | ----------------------------------------- | --------------------------------------- | ------------------------------------- |
| **Stampede**    | A popular key expires                     | DB spikes in rhythm with the TTL        | single-flight, stale-while-revalidate |
| **Avalanche**   | Many keys expire together (or cache down) | DB spikes at regular intervals          | **TTL jitter**, origin shield         |
| **Hot Key**     | Abnormal traffic on one key               | One Redis node at 100% CPU, others idle | local (L1) cache, key splitting       |
| **Penetration** | Missing ids requested repeatedly          | Good hit ratio, yet the DB is busy      | negative caching, bloom filter        |

Notice — **the four have different symptoms, so the diagnosis is the real work**. Seeing "the DB is under heavy load" and slapping on any one remedy won't work. Is the DB spike coming in rhythm with the TTL (stampede/avalanche), constantly (penetration), or is one Redis node hot (hot key) — that is your first question.

---

## 2. Interview Angle

In an interview, this lesson is where you move up from "I know caching" to "I've run caching". Almost every candidate can describe Cache-Aside; **very few can say what new problems exist because of the cache**.

The most common question: **"One of your popular cache entries expired, and at that exact moment 1000 requests arrived — what happens?"** This is directly the stampede question. In your answer, name the problem, then the remedies — single-flight/lock, and stale-while-revalidate. If you can add that an in-process lock only _reduces_ it across multiple instances, it doesn't _eliminate_ it (a distributed lock is needed), you clearly stand out.

The second often comes as a follow-up: **"The cache hit ratio is 98%, yet the DB load is high — why might that be?"** Both answers are good here: (a) penetration — keys that never get cached keep missing and going to the DB; 2% misses look harmless, but they never turn into hits; (b) maybe that 2% is the heaviest queries.

And one question used to gauge seniority: **"I added nodes to the Redis cluster, yet one node's CPU is at 100% — why?"** — hot key. Keys are hashed to a shard, so a single key's traffic is never split. Knowing this means you don't treat Redis as a black box.

---

## 3. Key Takeaway

- **A cache's failures are created by the cache's existence** — the DB is now sized for a load that can come back at any time
- **Stampede** — when a popular key expires, N concurrent misses, N identical DB queries (measured: 50 requests → 50 queries)
- **Single-flight** brings it down to 1 (measured: 50 → 1), but an in-process lock across multiple instances only brings it down to the number of instances
- In single-flight, **wrap both the load and the cache write** together — otherwise a narrow gap remains
- **A stampede is dangerous only when the origin's work is slow** — for cheap queries the window itself is narrow, the problem effectively doesn't exist
- **Avalanche** — many keys expiring together; the remedy is **TTL jitter**, a one-line change
- **Hot Key** — a key always lives on one node; adding nodes doesn't fix it. Remedies: local (L1) cache or key splitting
- **Penetration** — repeatedly asking for missing ids; the hit ratio looks good, yet the DB is busy. Remedies: negative caching (short TTL), bloom filter
- The four have **different symptoms** — whether the DB spike follows the TTL's rhythm or is constant is the first question
- `stale-while-revalidate` (Lesson 4.5) isn't just a CDN thing — the same logic works in Redis too

---

## 4. New Terms (Glossary)

| Term                 | Meaning                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Cache Stampede**   | When a key expires, many requests miss at the same moment and pile onto the DB             |
| **Thundering Herd**  | Another name for the same event — a crowd of requests rushing at the same resource at once |
| **Single-flight**    | Merging concurrent loads of the same key into a single real query                          |
| **TTL Jitter**       | Adding a little randomness to TTLs so keys don't expire together                           |
| **Cache Avalanche**  | Many keys expiring together (or the whole cache going down), sending a wave to the origin  |
| **Hot Key**          | A key with so much traffic that it saturates a node on its own                             |
| **Negative Caching** | Caching the answer "this thing doesn't exist" too, for a short time                        |

---

## 5. Reflection Questions

Think about your answer first, then open the Answer Key.

1. In the exercise, single-flight brought 50 DB queries down to 1. But TaskFlow production runs 4 server instances. What will the number be then, and why? What would it take to bring it down to 1?

2. To prevent stampedes, a developer raised the TTL from 60 seconds to **1 hour** — reasoning: "fewer expiries, fewer stampedes". Will stampedes actually decrease? And what new problems did this decision create?

3. TaskFlow's monitoring shows: cache hit ratio **97%**, Redis CPU normal, no hot node, DB load **constantly high** — no spikes, no rhythm, just always high. Which failure would you suspect, and what would you look at to confirm it?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The number will be **4** — one per instance.

Because the `inFlight` Map lives in **a process's own memory**. Instance A has no idea that instance B is already loading that key. So each instance goes to the DB once on its own.

50 → 4 is still huge (a 92% reduction), and it is effectively free — no extra infrastructure was needed. In practice, for most systems this alone is enough.

To bring it down to 1 you need a **distributed lock** — `SET lock:tasks:user:7 <id> NX PX 5000` in Redis. The instance that gets the lock goes to the DB, the others wait a bit and read from the cache. But this brings new complexity: what if the lock holder crashes? (hence PX/expiry is mandatory), and what about the latency of requests waiting for the lock? That whole discussion is in Lesson 6.4.

**The core lesson:** "One remedy cut the problem by 92% — do I take on 10x the complexity for the remaining 8%?" — that question is engineering.

**Question 2:** The **number of stampedes will drop**, but **each one will be worse**, and other problems come along.

- Fewer events: it expires once an hour, so 24 stampedes a day (1440 before)
- Each one worse: data has been piling up for an hour, so more requests are waiting at the moment of expiry
- **Staleness of 1 hour** (Lesson 4.3) — a user changes a task and sees the old one for an hour. This is the biggest cost
- Keys sitting in memory longer = more eviction pressure (Lesson 4.3)

The point: **trying to fix stampedes with the TTL is the wrong medicine**. The TTL's job is to set freshness; the medicine for stampedes is single-flight or stale-while-revalidate. Turn the wrong knob for a problem and you pay the price somewhere else.

**Question 3:** You would suspect **cache penetration**.

The reasoning, by elimination:

- No spikes, no rhythm → not a stampede or avalanche (both produce spikes in rhythm with the TTL)
- No hot node → not a hot key
- Hit ratio 97% yet the DB is busy → meaning the problem is inside that **3% of misses**, and those misses never turn into hits

That is penetration's signature. After a normal miss the key enters the cache, so the next request is a hit — misses "heal" by themselves. But for a missing key nothing is ever written to the cache, so **the same key keeps missing again and again**, and goes all the way to the DB every time. These are counted as misses in the hit ratio (Redis's `keyspace_misses`), but nobody gets suspicious over 3% misses — yet that 3% is what keeps the DB constantly busy.

**What to look at to confirm:** in the DB's query log, what share of queries return **zero rows**. If that is abnormally high (say 40%), you've caught it. Also look at the rate of 404 responses in the application log — it will tell the same story.

Remedies: negative caching (with a short TTL), and if the ids fall in a known range, reject out-of-range requests before they ever reach the DB.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **It is ready to run in the repo:** [`exercises/lesson-4.4-redis-cache/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-4.4-redis-cache) — the same setup as Lesson 4.4, with `npm run stampede` added for this lesson.

```bash
docker compose up -d && npm install && npm run seed
npm run build && npm start     # in a separate terminal
npm run stampede
```

**What to do:**

1. Run `npm run stampede`. On your machine, how many DB queries are there without and with single-flight? Does it match my 50 → 1?

2. In `src/stampede.ts` change `CONCURRENCY` from 50 to **200**. How does the time without single-flight grow — linearly, or faster than that? Why do you think so? (Hint: `pool: { max: 10 }` in `src/db.ts`.)

3. **Add TTL jitter.** In `src/server.ts`, instead of `TTL_SECONDS`, use a TTL with ±10% randomness mixed in. Then explain — does this change help with the stampede of §1.1, or the avalanche of §1.4? Why are the two problems different?

4. **Build negative caching.** Add a new endpoint `GET /api/tasks/:id` that uses Cache-Aside. Now repeatedly ask for an id that doesn't exist (for example `999999`) — looking at `/api/_stats` you'll see it goes to the DB every time. Now cache the "not found" answer too with a 30-second TTL, and measure again to show the difference.

5. **A thinking question (no code needed):** what would happen if single-flight's `inFlight` Map never deleted in `finally`? What kind of bug is that — and how many days would it take to show up in production?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (complete), 4.1, 4.2, 4.3, 4.4, 4.5
Current: 4.6 — Cache Failure Patterns
TaskFlow state: Nginx reverse proxy + LB, horizontal-scale-ready backend,
Redis caching layer (Cache-Aside + invalidate, measured 12ms → 3.7ms),
CDN design decided, and now stampede-resistant single-flight in place
(measured: with 50 concurrent misses, DB queries 50 → 1)
Terms learned (Module 4 complete): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution, Cache Hit Ratio,
Discriminated Union, Fail-safe, Offline Queue, Anycast, Cache Key,
s-maxage, stale-while-revalidate, ETag, Purge, Origin Shield,
Cache Stampede, Thundering Herd, Single-flight, TTL Jitter,
Cache Avalanche, Hot Key, Negative Caching
Weak spots: [where you got stuck — fill this in yourself]
Next: Module 4 Exit Challenge
=======================
```

---

## 8. Next Lesson

Send the exercise over — especially numbers 2 and 4; what you see hands-on in those two can't be understood by reading.

When you are ready, write `next` — the **Module 4 Exit Challenge**. Everything from the six lessons together, in a realistic high-pressure scenario. Then Module 5: Database Design & Scaling — where we go inside the very DB we have been trying to protect all this time.
