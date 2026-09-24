# Lesson 4.2 — Caching Strategies: Cache-Aside, Read-Through, Write-Through, Write-Behind

**Module 4 — Caching**

> **Spaced Repetition (Lesson 1.6):** What does a stateless server mean, and why does being stateless make horizontal scaling easy? (Answer in a line or two.)

**Prerequisite:** Lesson 4.1 (Cache Hierarchy), Lesson 1.6 (Stateless vs Stateful)

**By the end of this lesson you will be able to:**

1. Understand why the read path and the write path each have their own caching strategies
2. Explain how the four patterns — Cache-Aside, Read-Through, Write-Through, Write-Behind — work, and their trade-offs
3. Look at a specific TaskFlow endpoint and pick a suitable strategy with reasoning

**Tier:** 3 — Design Exercise (hands-on Redis implementation comes in Lesson 4.4)

---

## 0. Where TaskFlow Is Right Now

In the last lesson we saw the whole cache hierarchy — everywhere a cache can sit between the browser and the database. For TaskFlow the decision was: personalized data like `/api/tasks` needs an **application-level cache** (Redis), because it can't be kept in the browser or on the CDN.

But saying "we'll add Redis" doesn't finish the job. A pile of questions arrives immediately:

- **Who** puts the data into Redis — your Express code, or the cache itself?
- On a cache miss, **who** goes to the database?
- And the hardest question — when a user **updates** a task, what happens to the old copy sitting in Redis?

Notice that the last question is a different kind from the first two. The first two are about **reads**; the last one is about **writes**. That difference is the foundation of this whole lesson — a caching strategy is really split in two: how reads happen, and how writes happen.

---

## 1. Theory

### 1.1 Why reads and writes have to be thought about separately

A cache essentially answers two separate questions:

```
READ path :  I need data → is it in the cache? → if not, where do I get it from, and who fetches it?
WRITE path:  data is changing → when do I write to the DB, when to the cache, which one first?
```

The read path strategy decides your **latency and DB load**. The write path strategy decides your **consistency and durability** — that is, how long the cache and DB can disagree, and how big the risk of losing data is if something crashes suddenly.

If you don't think about these two separately, you will mix them up in interviews — and in production you will get bugs that are hard to even reproduce.

### 1.2 Cache-Aside (Lazy Loading) — the most widely used

Here the **application itself** manages both the cache and the database directly. The cache doesn't even know the database exists — it is just a key-value box.

```
READ:
  App ──1── "is tasks:user:42 there?" ──> [Redis]
                                            │
              HIT: value returned <─────────┘  → done, no need to go to the DB at all
              MISS: null <──────────────────┘
   │
   2── query the DB ──> [PostgreSQL]
   3── write the result into Redis (with a TTL)
   4── give the result to the client
```

In your stack it looks like this:

```typescript
import type { Redis } from 'ioredis';

interface TaskDTO {
	id: number;
	title: string;
	completed: boolean;
}

const TASKS_TTL_SECONDS = 300;

async function getTasksForUser(redis: Redis, userId: number): Promise<TaskDTO[]> {
	const cacheKey = `tasks:user:${userId}`;

	// Step 1 — look in the cache first
	const cached = await redis.get(cacheKey);
	if (cached !== null) {
		// The string coming from Redis is runtime input — it can't be trusted directly,
		// so the result of JSON.parse is treated as unknown.
		const parsed: unknown = JSON.parse(cached);
		if (Array.isArray(parsed)) {
			// `as` is needed here because Array.isArray only narrows to unknown[] —
			// it does not check whether the elements really are TaskDTO.
			// So this is an incomplete, temporary solution. In Lesson 4.4 we replace it
			// with a Zod schema, and then `as` won't be needed at all.
			return parsed as TaskDTO[];
		}
	}

	// Step 2 — cache miss, so go to the DB
	const rows = await Task.findAll({ where: { userId } });
	const tasks: TaskDTO[] = rows.map((row) => ({
		id: row.id,
		title: row.title,
		completed: row.completed
	}));

	// Step 3 — keep it in the cache for next time
	await redis.set(cacheKey, JSON.stringify(tasks), 'EX', TASKS_TTL_SECONDS);

	return tasks;
}
```

**Why "lazy"?** Because data enters the cache **only when someone asks for it the first time**. Nothing is filled in ahead of time. As a result, the cache only accumulates data that someone is actually reading — no memory is wasted.

**Advantages:** simple, direct, and **the app survives even if the cache goes down** — if Redis doesn't answer, every request goes to the DB (slower, but nothing breaks). This "cache is optional" property is its biggest strength.

**Disadvantages:** every cache miss costs **three round trips** (Redis → DB → Redis). And the first request is always slow — this is called a **cold start**.

### 1.3 Read-Through — the cache fetches from the DB itself

The difference from Cache-Aside is just one thing, but an important one: here the **application does not talk to the DB directly**. The app only asks the cache; on a miss, the **cache itself** fetches from the DB, keeps it, and then hands it to the app.

```
Cache-Aside :  App ──> Cache
               App ──> DB          (on a miss the App goes to the DB itself)

Read-Through:  App ──> Cache ──> DB   (the App only knows the Cache)
```

This keeps the application code clean — the caching logic is hidden inside a library or cache layer. But the price is that you need a cache layer that knows how to load from the DB (with a "loader function"). Redis doesn't do this on its own — you have to write a wrapper, or use a library that provides this pattern.

**In practice:** pure Read-Through is relatively rare in the Node.js ecosystem; most teams write Cache-Aside and then wrap it in a helper function — which effectively ends up close to Read-Through.

### 1.4 Write-Through — write to the cache and the DB together

Now the write path. With Write-Through, every write goes to **both the cache and the DB**, and the client is told "success" only after both are done.

```
WRITE:
  App ──> [write to DB] ──> [write to Cache] ──> then give the client a 200
          └──────────── success only when both are done ────────────┘
```

Note the order — **DB first, cache after**. Do it the other way round (cache first) and if the DB write fails, the cache is left holding a value that was never written to the DB, and every later read gets that false value. This "source of truth first" rule comes back in the next lesson (4.3).

**Advantages:** the cache is never "stale" — as soon as the write finishes, the new value is in the cache. The next read is always a cache hit, and a correct one.

**Disadvantages:** every write is now **slower**, because it has to be written in two places. And there is a hidden waste — data that nobody may ever read also ends up in the cache. If someone bulk-imports 500 tasks into TaskFlow, Write-Through fills all of them into the cache, even though the user may only look at the 20 on the first page.

There is a direct answer to this problem — **Write-Around**: the write goes only to the DB, and the cache isn't touched at all (or only the old key is deleted). The data enters the cache only when someone actually wants to read it. For data that is write-heavy but rarely read, this is the natural choice — an audit log, for example.

### 1.5 Write-Behind (Write-Back) — cache first, DB later

The fastest, and the riskiest. Here the write goes **only to the cache**, and the client is told "success" immediately. Writing to the DB happens later, in the background — usually by collecting several writes together (a batch).

```
WRITE:
  App ──> [write to Cache] ──> immediately give the client a 200
                │
                └── (background) a little later, the collected writes together ──> [DB]
```

**Advantages:** write latency is almost as fast as in-memory — remarkably fast. And the write pressure on the DB drops a lot, because 100 separate writes become one batch.

**Disadvantages, and this one is serious:** if the cache node crashes **before** the data is written to the DB, those writes are **lost forever** — even though the client was already told "success". You are buying speed in exchange for durability.

**So when do you use it?** When losing data is tolerable and the volume of writes is huge. The classic example — a view counter, "how many times was this viewed" type metrics. In TaskFlow it makes sense to keep a counter of how many times a task was opened in Write-Behind; but **never** the task itself — if someone creates a task, sees "saved", and it then vanishes, that is unforgivable.

### 1.6 All four together

> **Trade-off Table — Which Strategy When**

| Strategy          | Who does the read | Where the write goes  | Main advantage                             | Main risk                               | Suitable in TaskFlow                      |
| ----------------- | ----------------- | --------------------- | ------------------------------------------ | --------------------------------------- | ----------------------------------------- |
| **Cache-Aside**   | The App itself    | (separate write path) | Simple; the app runs even if cache is down | 3 round trips per miss; cold start      | `GET /api/tasks` — **default choice**     |
| **Read-Through**  | The Cache itself  | (separate write path) | App code stays clean                       | Needs a separate cache layer/library    | When many endpoints need the same pattern |
| **Write-Through** | —                 | Cache + DB, both sync | Cache is never stale                       | Slow writes; unneeded data in the cache | User profile — written rarely, read often |
| **Write-Behind**  | —                 | Cache first, DB async | Extremely fast writes; less DB load        | **Data loss on crash**                  | View counter — fine if lost               |
| **Write-Around**  | —                 | DB only               | No junk piles up in the cache              | The next read is a guaranteed miss      | Bulk import, audit log                    |

**The most common pairing in practice:** **Cache-Aside (read) + Write-Around/invalidate (write)**. That is — lazy-load on reads, and on writes, write to the DB and **delete** the related cache key. When someone next comes to read, they refill the cache with the new data.

But "delete the key" is not as easy in practice as it sounds — which keys have to be deleted, when, and what if someone reads just before the delete? That whole tangle is the next lesson (4.3).

---

## 2. Interview Angle

In this topic the question almost always starts from the same place — **"How would you do caching in your system?"** The weak answer is "I'll use Redis". The good answer describes the read path and write path separately: _"Cache-Aside for reads — the key is `tasks:user:{id}`, TTL 5 minutes. For writes, I write to the DB and invalidate that key."_ Saying just that already sets you apart from the rest, because you are showing that caching isn't only about reads.

The most common follow-up: **"Why would anyone use Write-Behind knowing it can lose data?"** — here the interviewer wants to see whether you can think in trade-off terms. Answer based on the **nature** of the data: nobody even notices if a view counter is lost, but payments or task creation can't be lost. Saying "this price is worth paying for this data" instead of "this design is the best" is the mature answer.

Another question that comes up: **"What happens in Cache-Aside when the cache goes down?"** — answer: the app keeps running, it just gets slower, because every request goes to the DB. But also add that suddenly putting the entire load on the DB can bring the DB down — that is the **thundering herd**, the topic of Lesson 4.6.

---

## 3. Key Takeaway

- A caching strategy has to be thought about in two parts — the **read path** (latency, DB load) and the **write path** (consistency, durability)
- **Cache-Aside**: the app manages both the cache and the DB itself; the most common, and the app survives even if the cache is down
- **Read-Through**: the cache loads from the DB itself; clean app code, but needs a separate cache layer
- **Write-Through**: write to cache + DB in sync; the cache is never stale, but writes are slower
- **Write-Behind**: cache first, DB later; the fastest, but data loss on crash — only for "fine if lost" data
- **Write-Around**: write only to the DB; protects the cache from junk for bulk/write-heavy data
- The most widely used pairing in practice — **Cache-Aside + invalidate on write**
- No strategy is "the best"; how important the data is and how often it is read/written decides it

---

## 4. New Terms (Glossary)

| Term                           | Meaning                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| **Cache-Aside (Lazy Loading)** | The app checks the cache itself, and on a miss fetches from the DB itself and fills the cache |
| **Read-Through**               | The cache loads data from the DB itself; the app only talks to the cache                      |
| **Write-Through**              | Every write goes to both the cache and the DB synchronously, then success                     |
| **Write-Behind (Write-Back)**  | Writes go only to the cache first, to the DB later in the background/batch — fast but risky   |
| **Write-Around**               | Writes go only to the DB, bypassing the cache; data enters the cache on its first read        |
| **Cold Start**                 | The state where the cache is empty, so the early requests all miss and go to the DB           |

---

## 5. Reflection Questions

Think about your answer first, then open the Answer Key.

1. A new feature is coming to TaskFlow — a "how many times viewed" counter on every task that goes up by 1 every time the task is opened. A popular task can be opened 10,000 times a day. Which write strategy would you choose for this counter, and why? Would you use the same strategy for the task's title/description?

2. A junior developer set up Write-Through on TaskFlow's `POST /api/tasks` — when a new task is created, it is immediately written to Redis as well. But they have noticed that Redis memory usage is growing fast, while the cache hit ratio hasn't gone up. What is going wrong, and what should be done?

3. In Cache-Aside, the application keeps running when the cache goes down — this was described as an advantage. But there is a hidden danger in it. What is it?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** **Write-Behind** fits the counter. Because (a) the volume of writes is huge — one DB write per view would sink the DB, (b) losing the data does little harm — nobody will even notice if the counter shows 2 less. Incrementing in the cache and writing the accumulated value to the DB once every 30 seconds is enough.

**Never** for the title/description. That is the user's real data — if it disappears after the user sees "Saved" and something crashes, that is a breach of trust. There, do a sync write to the DB, then invalidate the cache. This is the core lesson: **even inside the same application, different data needs different strategies** — forcing one rule on the whole app is wrong.

**Question 2:** This is Write-Through's classic weakness — **every created task enters the cache, but most of them are never read**. Memory is filling up with data that has no read demand, so the hit ratio isn't rising. Worse, this unneeded data is taking up space and pushing the truly popular data out of the cache (eviction, Lesson 4.3).

The fix: move to **Write-Around** — on `POST`, write only to the DB and delete that user's `tasks:user:{id}` key. The task enters the cache when someone actually wants to read it.

**Question 3:** The danger is that the moment the cache goes down, **all the traffic lands on the DB at once**. Normally perhaps 95% of requests were served from the cache and the DB handled only 5%. When the cache goes, the DB suddenly has to take **20x** the load — which it was never sized for. The DB slows down, timeouts start, and the whole system can collapse.

So "the cache is optional" is true from a performance point of view, but **not from a capacity point of view** — whether the DB can take that load when the cache is gone has to be thought about separately. This is the **thundering herd** problem of Lesson 4.6.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

TaskFlow has the four operations below. For each one, say — **which read strategy, which write strategy**, what TTL, and what the cache key will be. Give one or two lines of reasoning behind each decision.

1. `GET /api/tasks` — the logged-in user's own task list (read about 50 times a day on average, changes 5 times a week)
2. `PATCH /api/tasks/:id` — changing a task's title or completed status
3. `GET /api/users/:id/profile` — the user's name, picture, timezone (read very often, changes once a month)
4. `POST /api/tasks/:id/view` — increment a task's view counter by 1 (10,000+ times a day on a popular task)

**One extra question, a bit harder:** in #2, when you update a task, exactly which cache keys have to be invalidated? Is the key of that task alone enough?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (complete), 4.1
Current: 4.2 — Caching Strategies
TaskFlow state: Nginx reverse proxy + LB in front, horizontal-scale-ready backend,
caching strategy decided (Cache-Aside read + invalidate-on-write), but
Redis has not been set up yet
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start
Weak spots: [where you got stuck — fill this in yourself]
Next: 4.3 — Invalidation, TTL, Eviction (LRU, LFU)
=======================
```

---

## 8. Next Lesson

Send the exercise over — especially the extra question at the end; that one is the door to the next lesson. When you are ready, write `next` — we move to Lesson 4.3: Invalidation, TTL and Eviction. "When do I delete from the cache" and "who do I kick out when space runs out" — one of the two most notoriously hard problems in Computer Science lives right here.
