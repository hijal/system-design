# Lesson 4.3 — Invalidation, TTL & Eviction: When to Delete, Who to Kick Out

**Module 4 — Caching**

> **Spaced Repetition (Lesson 1.3):** In back-of-the-envelope estimation, with 1 million users and 1 KB of data per user — roughly how much memory would you need? (Do the math in your head.)

**Prerequisite:** Lesson 4.2 (Caching Strategies), Lesson 1.3 (Estimation)

**By the end of this lesson you will be able to:**

1. Understand why TTL, explicit invalidation and eviction are three different things, and which one answers which problem
2. Work out, by looking at the key design, exactly which cache keys have to be deleted when a write happens
3. Explain the difference between the LRU and LFU eviction policies, and which one you would pick in Redis for TaskFlow

**Tier:** 3 — Design Exercise (hands-on Redis implementation comes in the next lesson, 4.4)

---

## 0. Where TaskFlow Is Right Now

In the last lesson TaskFlow's caching strategy was settled — **Cache-Aside** for reads, and for writes, **write to the DB and invalidate the cache key**. On paper, the decision is clear.

But at the end of the last lesson I left an extra question: _when a user updates a task, exactly **which** keys have to be deleted? Is the key of that task alone enough?_

The question looks innocent, but hidden inside it is caching's most notorious problem. You know Phil Karlton's famous line —

> "There are only two hard things in Computer Science: cache invalidation and naming things."

Today's lesson is about the first of those "two hard things". And at the end we will see that the first is actually tangled up with the second — **if keys aren't named properly, invalidation will never be easy.**

---

## 1. Theory

### 1.1 Really three separate questions

People often lump everything together as "the cache expired". But there are three completely different questions here, and three different answers:

```
1. TTL          → "after how long does it delete itself?"     (time decides)
2. Invalidation → "the data changed, delete it right now"     (you decide)
3. Eviction     → "memory is full, who do I kick out?"        (Redis decides)
```

Notice the difference — **who is making the decision** is the key point. With TTL the clock decides, with invalidation your code decides, and with eviction Redis itself is forced to decide — because it has no space left.

### 1.2 TTL — the simplest, and the least reliable

TTL (Time To Live) means — "this key will die by itself after N seconds."

```typescript
await redis.set(cacheKey, JSON.stringify(tasks), 'EX', 300); // 5 minutes
```

Its beauty is that it is **automatic**. Even if you forget to invalidate, the old data goes away by itself after at most 5 minutes. It is a safety net — the last line of defence.

But TTL's price is a window:

```
t=0s      the user updated the task  →  new value in the DB
                                         the cache still has the old value
t=0-300s  the user sees old data this whole time  ← Staleness Window
t=300s    TTL ends  →  the next read brings the new value from the DB
```

This in-between period is called the **staleness window** — the time during which the cache and the DB disagree.

From this comes TTL's core trade-off:

| TTL         | Cache hit ratio | Staleness | DB load |
| ----------- | --------------- | --------- | ------- |
| Short (10s) | Low             | Low       | High    |
| Long (1h)   | High            | High      | Low     |

**So what is the right value?** It depends on how much harm stale data causes:

- TaskFlow's task list → showing it 5 minutes out of date won't kill anyone, but it will annoy people → **30-60 seconds**
- A user's profile picture → an hour out of date is fine → **1 hour**
- Account balance or payment status → **not even one second of staleness is acceptable** → shouldn't be cached at all, or only with a very short TTL and mandatory invalidation

### 1.3 Explicit Invalidation — delete, don't update

TTL is just the safety net. The real work is telling the cache **the moment** data changes. There are two ways to do it, and one is clearly better:

```
Way 1 (update):  write to the DB  →  write the new value into the cache
Way 2 (delete):  write to the DB  →  delete the cache key   ← usually the better one
```

**Why is delete better?** Three reasons:

1. **To update, you have to build the new value** — meaning another DB query, another serialize. Delete doesn't have that cost, and if someone actually wants to read the data, it will be loaded then anyway.
2. **Fewer race conditions.** If two people update at the same time, with the "update" approach it is uncertain whose value ends up in the cache — an old value can even land on top of the new one. Delete avoids this particular race; if the cache is empty, the next read brings the DB's truth. But delete doesn't make races disappear completely — see the note below.
3. **Maybe nobody will read that data again.** Then why waste memory putting a new value in the cache?

In your stack:

```typescript
async function updateTask(
	redis: Redis,
	userId: number,
	taskId: number,
	title: string
): Promise<void> {
	// Step 1 — the source of truth (DB) first
	await Task.update({ title }, { where: { id: taskId, userId } });

	// Step 2 — then delete from the cache
	await redis.del(`task:${taskId}`, `tasks:user:${userId}`);
}
```

**The order matters — DB first, cache after.** Do it the other way round and there is a subtle bug: you deleted the cache, but the DB write failed — if someone reads in between, they will fetch the **old** value from the DB and fill it back into the cache. The old data returns to the cache and stays there until the TTL ends.

**An honest note — even "DB first, then delete" has one narrow race left:**

```
t=0   Reader  : cache miss → reads the OLD value from the DB (a slow query)
t=1   Writer  : writes the NEW value to the DB
t=2   Writer  : deletes the cache key (it is already empty — nothing to delete)
t=3   Reader  : its slow query finishes → writes the OLD value into the cache
```

Now the cache holds old data until the TTL ends. It needs an unlucky timing (a read that started before the write and finished after the delete), so it is rare — but under high load, rare things happen daily. This is one more reason the **TTL safety net** is non-negotiable. Common mitigations: a second, slightly delayed delete (_delayed double delete_), or a lease/version check so a stale reader isn't allowed to fill the cache (Facebook's memcache paper calls this a _lease_).

### 1.4 Which keys to delete — the answer to last lesson's question

Did you notice that in the code above I deleted **two** keys? That was the answer to last lesson's extra question.

When a task is updated, these cache entries go stale:

```
task:42                  ← that task's own copy
tasks:user:7             ← that user's whole list (the task is in this list)
tasks:user:7:completed   ← the list filtered by "completed"
tasks:user:7:page:1      ← the paginated view
tasks:project:3          ← if the task belongs to a project
```

**One write, five stale keys.** This is what makes invalidation hard — the data is one thing, but remembering how many different "views" it has seeped into is hard. Forget to add a new endpoint to the invalidation code — and that is the bug that returns a month later as "sometimes shows old data".

**This is where "naming things" and "cache invalidation" become one.** If keys are namespaced following a rule, deleting them together is easy:

```
tasks:user:7:*     ← delete every key with this prefix at once
```

But careful — running `KEYS tasks:user:7:*` in Redis is **dangerous in production**, because it scans the whole keyspace and blocks Redis the entire time (Redis is single-threaded). Alternatives: `SCAN` (gradual, non-blocking), or even better — keep a separate list of each user's keys (in a Redis Set), so you know exactly which ones to delete.

Another clean technique — the **version/generation key**:

```
tasks:user:7:v12    ← v is the version number
```

When something of the user's changes, bump the version by one (`INCR tasks:user:7:version`). Nobody looks up the old `v12` keys any more — everyone now asks for `v13`. The old ones die by themselves when their TTL ends. No deleting needed.

### 1.5 Eviction — who goes when memory is full

TTL and invalidation are both about "the data is no longer correct". Eviction is a completely different question — **the data may be perfectly correct, but there is no space.**

In Redis you set a memory limit and tell it what to do when the limit is exceeded:

```bash
maxmemory 2gb
maxmemory-policy allkeys-lru
```

The policies (a few important ones):

| Policy           | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `noeviction`     | Deletes nothing; new writes **return an error** (default) |
| `allkeys-lru`    | Among all keys, drops the one **used longest ago**        |
| `allkeys-lfu`    | Among all keys, drops the one **used the fewest times**   |
| `volatile-lru`   | LRU only among keys that have a TTL set                   |
| `allkeys-random` | Drops any key at random                                   |

**`noeviction` is the default — and that is often unexpected.** Many people set up Redis, forget to set `maxmemory-policy`, and are then surprised when memory fills up and they suddenly see an `OOM command not allowed` error. **If you use Redis as a pure cache** (that is, losing data is fine because the real copy is in the DB), `allkeys-lru` is almost always the right choice.

### 1.6 LRU vs LFU — which one when

The two follow different logic:

- **LRU (Least Recently Used)** — drop the one "nobody has touched for the longest time". The question: **when** was it last used?
- **LFU (Least Frequently Used)** — drop the one "used the fewest times". The question: **how many times** has it been used?

An example makes the difference clear. Say in TaskFlow:

```
key A : read 10,000 times in the last 3 months, but not once in the last 2 hours
key B : read only 3 times in the last 3 months, but read 5 minutes ago
```

**LRU** says: B was used recently, so **drop A**.
**LFU** says: A is very popular, so **drop B**.

Who is right? It depends on the character of your traffic:

- **LRU is better** when usage has "recency" — someone working today means they will keep working a while longer. This is natural for TaskFlow's normal usage.
- **LFU is better** when some things are permanently popular — like a news site's homepage. LRU gets into trouble here: if a scan or a bot suddenly reads a pile of unfamiliar keys, they become "recent" and push the truly popular data out — this is called **cache pollution**.

> **Trade-off Table — The Three Processes at a Glance**

|                  | **TTL**             | **Invalidation**    | **Eviction**          |
| ---------------- | ------------------- | ------------------- | --------------------- |
| Who decides      | The clock           | Your code           | Redis (forced to)     |
| Why it happens   | Time ran out        | Data changed        | Memory ran out        |
| How precise      | Approximate         | Precise             | Unrelated to the data |
| If it goes wrong | Staleness window    | Old data is visible | Hit ratio drops       |
| In TaskFlow      | 30-60s on task list | `del` on write      | `allkeys-lru`         |

**You need all three together.** Invalidation is the precise weapon, TTL is the safety net against forgetting, and eviction is the last resort when memory runs out. You can't do the job of the other two with just one.

---

## 2. Interview Angle

Cache invalidation comes up in almost every system design interview, but not directly — indirectly. The most common form: **"In your design, a user updated something but someone else is seeing the old version — why, and how would you fix it?"** Here you need to talk about both TTL and explicit invalidation, and say why TTL alone isn't enough (the staleness window) and why invalidation alone isn't enough either (you will forget to delete it in some place).

A good follow-up that many people get stuck on: **"When invalidating, DB first or cache first?"** — answer: **DB first, cache after**, and you have to be able to give the reason (a read can come in between and fill the old value back into the cache).

And the eviction question is almost always the same: **"LRU or LFU?"** — don't stop at "LRU is better". Bring up the traffic pattern: LRU for recency-driven access, LFU when there is permanent popularity — and if you can say that LFU protects against cache pollution caused by scans/bots, you are clearly ahead.

---

## 3. Key Takeaway

- **Three separate processes**, don't mix them up: TTL (the clock decides), invalidation (you decide), eviction (Redis is forced to decide)
- TTL is a safety net, not a precise solution — its price is the **staleness window**
- On writes, **delete rather than update** the cache — usually better: less cost, fewer race conditions
- The order is always **DB first, cache after** — reversed, the old value can come back into the cache
- A single write usually makes **several keys** stale (item, list, filtered list, paginated view) — you have to think about all of them
- Without good key naming (namespaces, or version keys), invalidation will never be easy
- Don't run `KEYS pattern*` in production — Redis is single-threaded, it will block everyone; use `SCAN` or a version key
- Redis's default `maxmemory-policy` is `noeviction` — for a pure cache, setting `allkeys-lru` is almost always right

---

## 4. New Terms (Glossary)

| Term                   | Meaning                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| **TTL (Time To Live)** | How long a cache entry lives, after which it deletes itself                                                    |
| **Staleness Window**   | The time between the data changing and the cache finding out — while an old answer is served                   |
| **Cache Invalidation** | Deliberately deleting the related cache entries because the data has changed                                   |
| **Eviction Policy**    | The rule Redis uses to choose which keys to kick out when memory is full                                       |
| **LRU**                | Least Recently Used — the key used longest ago is dropped                                                      |
| **LFU**                | Least Frequently Used — the key used the fewest times is dropped                                               |
| **Cache Pollution**    | Unneeded data (for example, brought in by a scan/bot) filling the cache and pushing out the truly popular data |

---

## 5. Reflection Questions

Think about your answer first, then open the Answer Key.

1. A user marked a task as "completed" in TaskFlow. Your cache has the keys below. Which ones have to be invalidated, and which don't need to be touched — why?
   `task:99` · `tasks:user:7` · `tasks:user:7:completed` · `tasks:user:12` · `user:7:profile`

2. A developer says: "I'll just give every key a 10-second TTL, then there's no invalidation hassle at all — at most it shows 10-second-old data, that's it." The reasoning sounds right. What is the problem with it?

3. `maxmemory-policy` was never set on TaskFlow's Redis (the default `noeviction`). One day memory filled up. What exactly happens in the application — do reads fail, or writes, or both? And what does it look like from the user's point of view?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

- `task:99` — **yes**, this is the task itself; its `completed` field changed
- `tasks:user:7` — **yes**, task 99 is in this list, and its status changed
- `tasks:user:7:completed` — **yes**, and this is the easiest one to forget. The task will now **enter** this filtered list, yet it isn't in the cached version
- `tasks:user:12` — **no**, a different user; this task isn't in their list
- `user:7:profile` — **no**, profile data (name, picture, timezone) doesn't change when a task is updated

The core lesson: **filtered/derived views are the ones missed most often**. You remember the main object and its list, but "completed only", "page 2", "by project" — these are easy to forget.

**Question 2:** The reasoning isn't bad from a correctness point of view, but **from a performance point of view it makes the cache nearly useless**.

Think about it — if a key gets on average 3 requests every 10 seconds, the first is a miss (goes to the DB), the next two are hits. Hit ratio ~67%. But on a less popular key, where there is one request every 30 seconds — **every request is a miss**, because the previous entry has already died by then. Hit ratio almost 0%.

So you are taking on Redis's cost, complexity and an extra network hop, yet the DB load barely drops. On top of that, **every 10 seconds** all the popular keys will expire together — this sends sudden waves of load to the DB (the **cache stampede** of Lesson 4.6).

The right way: **a reasonable TTL (30-60s) + explicit invalidation**. TTL is the safety net, invalidation does the real work.

**Question 3:** With `noeviction`, **reads keep working fine**, but **writes fail** — Redis returns an `OOM command not allowed when used memory > 'maxmemory'` error.

From the application's point of view this is a strange state: what is in the cache can be read, but nothing new can be put into the cache. In Cache-Aside, step 3 (writing into the cache) will fail every time, meaning **every cache miss stays a miss forever** — that data can never get into the cache.

From the user's point of view: the site gradually gets slower (the more new data is requested, the more everything goes to the DB), but nothing "breaks". This silent degradation is what makes it dangerous — no loud alarm goes off, latency just keeps rising.

And if the Redis error isn't handled properly in your code (`redis.set` without a try/catch), that error will reach the request handler and **show the user a 500** — even though the DB is perfectly healthy. That is why cache writes must always be fail-safe: failing to write to the cache should never be a reason to fail the request.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

A new feature is coming to TaskFlow — **shared projects**. A project can have multiple users, and a task belongs to a project. The cache now has these keys:

```
task:{taskId}
tasks:user:{userId}
tasks:user:{userId}:completed
tasks:project:{projectId}
project:{projectId}:members
```

**What to do:**

1. User 7 changed the title of a task (id 99) in project 3. Which keys get invalidated? If project 3 has 4 more members, what happens to their cached lists — and what new problem does this create?

2. How can the **version key** approach help avoid the problem above? Write out a version-based key design for `tasks:project:3`.

3. Which `maxmemory-policy` would you choose for TaskFlow's Redis, and why? Also say in your answer — if the same Redis instance holds both the cache **and** session data (losing which logs the user out), does your choice change?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (complete), 4.1, 4.2
Current: 4.3 — Invalidation, TTL & Eviction
TaskFlow state: Nginx reverse proxy + LB in front, horizontal-scale-ready backend,
caching design complete on paper (Cache-Aside + invalidate-on-write, TTL 30-60s,
allkeys-lru) — not a single line of code written yet; Redis goes in next lesson
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution
Weak spots: [where you got stuck — fill this in yourself]
Next: 4.4 — Redis Hands-on: a caching layer in Express + Sequelize (Tier 1, the first
runnable code in this module)
=======================
```

---

## 8. Next Lesson

Send the exercise over — especially the last part of #3 (cache and sessions together); there is a trap there.

When you are ready, write `next` — in Lesson 4.4, finally, **code**. Everything we decided over the last three lessons — Cache-Aside, invalidate-on-write, TTL, LRU — we will put together into a real Redis caching layer for TaskFlow, with Express + Sequelize + Redis. And we will measure how much difference the cache actually made.
