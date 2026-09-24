# Lesson 4.4 — Redis Hands-on: A Real Caching Layer in TaskFlow

**Module 4 — Caching**

> **Spaced Repetition (Lesson 2.5):** What problem does an Idempotency Key solve, and in that exercise where did we store the keys — what was the limitation of that place?

**Prerequisite:** Lesson 4.2 (Caching Strategies), Lesson 4.3 (Invalidation, TTL, Eviction)

**By the end of this lesson you will be able to:**

1. Write a working Cache-Aside layer yourself with Express + Sequelize + Redis
2. Validate data kept in the cache as runtime input with Zod, instead of trusting it with `as`
3. **Measure** the benefit of the cache, and see with your own eyes exactly what happens when Redis dies

**Tier:** 1 — Runnable Code

---

## 0. Where TaskFlow Is Right Now

Over the last three lessons we made a lot of decisions, but didn't write a single line of code:

```
4.1 →  understood the hierarchy, decided: an app-level cache for personalized data
4.2 →  strategy decided: Cache-Aside (read) + invalidate (write)
4.3 →  TTL 30-60s, DB first then cache, derived views must be deleted too, allkeys-lru
```

Today we put this whole paper design into TaskFlow — and then **measure whether we actually gained anything**.

This matters, because there is a common trap with caching: people set up Redis and assume the system is now fast. But if you **don't measure** how much the cache is helping, you have no idea whether your TTL is right, whether your key design works, or even whether the cache is being hit at all. That is why today's exercise also includes a bench script.

And at the end of the lesson we will do something many people never try — **kill Redis**, and see what happens to TaskFlow. The answer will surprise you.

---

## 1. Theory

Today there is less theory and more code. But let's first clear up four things, because they are the backbone of the exercise.

### 1.1 Data kept in the cache is runtime input too

In Lesson 2.5 we learned a rule — **never trust runtime input with a type assertion**. Back then it was `req.body`. Today the same rule applies in another place that many people don't notice: **data returned from Redis is runtime input too**.

Why? What is in Redis may have been written by your older code, the shape may have changed during a deploy, or another service may have written there. The result of `JSON.parse()` is `unknown` — and passing it off as `as TaskDTO[]` is lying.

In Lesson 4.2 I deliberately left an `as` in and wrote in a comment "we'll remove this with Zod in 4.4". Today I keep that promise:

```typescript
export const taskSchema = z.object({
	id: z.number().int(),
	userId: z.number().int(),
	title: z.string(),
	completed: z.boolean()
});
export const taskListSchema = z.array(taskSchema);
export type TaskDTO = z.infer<typeof taskSchema>;
```

Notice — the type isn't written separately; it is derived from the schema with `z.infer`. That means the schema and the type can never drift apart.

### 1.2 A cache miss and a cache error are not the same thing

In most tutorials a cache lookup has two outcomes: found it, or didn't. But in reality there are **three**:

```
hit    →  it's in the cache, here you go
miss   →  it's not in the cache, go to the DB
error  →  Redis isn't even answering (down, timeout, network)
```

In the last two your code does the same thing (goes to the DB), so it is tempting to lump them together. But **keeping them separate lets you measure** — is the cache hit ratio low because of the TTL, or is Redis actually struggling? The treatment for these two is completely different.

This course's code rules include one — _"Model state with a discriminated union, don't build a jungle of optional fields."_ This is exactly the place for it:

```typescript
export type CacheLookup<T> =
	{ status: 'hit'; value: T } | { status: 'miss' } | { status: 'error'; reason: string };
```

The `value` field exists only on `hit`. That means TypeScript won't let you read `value` without checking `status` — the bug is caught at compile time.

### 1.3 A cache failure must never fail the request

In question 3 of Lesson 4.3 we saw — if failing to write to Redis lets that error bubble up, the user sees a 500 while the DB is perfectly healthy. That makes no sense: the cache is an **optimization**, not the source of truth. If it fails, the system should get slower, not break.

So in the exercise, every cache operation swallows its own errors:

```typescript
export async function writeList(key: string, value: TaskDTO[], ttlSeconds: number): Promise<void> {
	try {
		await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
	} catch {
		// failing to write to the cache should never be a reason to fail the request
	}
}
```

Notice there is no `catch (error: any)` — just a bare `catch`, because we don't use the error at all. And where we do use it, it is caught as `catch (error: unknown)` and narrowed.

### 1.4 Typing the Sequelize model

Another of the course's code rules — a Sequelize model must never be left untyped:

```typescript
export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare userId: number;
	declare title: string;
	declare completed: CreationOptional<boolean>;
}
```

`InferAttributes` derives the fields from the model itself, so there's no hassle of writing a separate interface and keeping two places in sync. `CreationOptional` says which fields don't have to be given at creation time (`id` is auto-increment, `completed` has a default).

---

## 2. Interview Angle

This lesson is hands-on, but it is where the sharpest interview question comes from: **"What happens when your cache dies?"**

Most candidates say _"nothing, requests just go to the DB"_ — and that is exactly the answer that will trip you up, because it is a half-truth. In today's exercise you will see with your own eyes that correctness holds, but **latency jumps from 12 ms to several seconds, and keeps growing with every request** — not because of the extra DB load, but because the client library puts each command in a queue and waits for Redis to come back before giving up.

In other words, **your cache client's settings (offline queue, command timeout) decide whether a cache outage is "a bit slower" or "a full outage".** And the funny part — the setting everyone suspects first (`connectTimeout`) doesn't help here at all. If you can say this, you come across as someone who has actually run a cache in production.

The second common question: **"What is a good cache hit ratio?"** — the right answer is "it depends". A 95% hit ratio sounds great, but if the misses are the most expensive queries, the gain is small. And a 60% hit ratio can be enough if that 60% is your heaviest endpoint. **Measure, then speak** — that is the core point.

---

## 3. Key Takeaway

- Data coming from the cache is **runtime input** too — parse it with Zod, don't trust it with `as`
- A cache lookup has **three** outcomes (hit/miss/error), not two — model them with a discriminated union
- No cache failure should ever fail a request — every cache call is fail-safe
- Remember the order: **DB first, then cache invalidate** (Lesson 4.3)
- A write has to delete the **derived views too** — `tasks:user:7:completed` along with `tasks:user:7`
- In Sequelize use `InferAttributes`/`InferCreationAttributes`, not an untyped model
- **Don't claim the cache's benefit, measure it** — an `X-Cache` header and a bench script are enough
- **A cache outage doesn't just mean "a bit slower"** — unless the client's offline queue is off or its command timeout is short, it can become a full outage

---

## 4. New Terms (Glossary)

| Term                      | Meaning                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Cache Hit Ratio**       | What share of all requests were served from the cache — a measure of how useful the cache is           |
| **Discriminated Union**   | A type separated by a `status`-like field, so reading the wrong field is caught at compile time        |
| **Fail-safe (cache)**     | A design where a cache failure doesn't fail the request, but quietly falls back to the DB              |
| **Offline Queue**         | Where the client holds commands while there is no connection to Redis, waiting to reconnect            |
| **Cold Path / Warm Path** | The path of a cache miss (going to the DB) and of a cache hit (returning from the cache), respectively |

---

## 5. Reflection Questions

Think about your answer first, then open the Answer Key.

1. In the exercise, a cache miss on `GET /api/tasks` does three things: look in Redis, query the DB, write to Redis. But we `await` the result of the last step (`writeList`) — **before** sending the response to the client. Is that right? What would we gain by not doing it, and what is the risk?

2. The bench showed the DB path at ~12 ms and the cache path at ~3.7 ms — only ~3.3x faster. Yet Lesson 4.1 said memory and disk differ by ~1000x. Why so little? Where did the difference go?

3. With Redis stopped, 5 requests were sent in a row: 623 ms, 1492 ms, 2299 ms, 3095 ms, 3895 ms — the time is **growing**. If the cache were simply "not working", every request should take the same time. Why is it growing?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Strictly speaking, it is better not to `await` — the data has already been fetched from the DB, so it can be sent to the client immediately and the cache write done in the background. That removes one Redis round trip of latency from the miss path.

But there are two risks: (a) a floating promise in Node — if it rejects and nobody catches it, you get an unhandled rejection; (b) nondeterminism in tests — a state where the response has arrived but the cache write hasn't finished yet.

In the exercise `await` is kept for simplicity (and `writeList` itself never throws, so risk (a) doesn't exist). In production this is usually done fire-and-forget, but with a rejection handler. **The takeaway:** every extra hop on the miss path is worth counting — because the miss is your slowest path.

**Question 2:** Because **most of the 12 ms or 3.7 ms isn't actually a memory or disk read**. Both paths do the same work here: turning 5000 tasks into JSON and sending it over the network. That cost is the same on both paths, so it squashes the ratio.

What differs is only this: on the DB path, a query to Postgres + turning 5000 rows into JS objects; on the cache path, one Redis `GET` + `JSON.parse`.

This is an important reality — **Lesson 1.3's latency numbers are ingredients, not the whole recipe.** A real endpoint adds serialization, network and framework overhead. So expecting a 1000x improvement because "Redis is 1000x faster" is wrong. The real gain is actually elsewhere: **moving load off the DB**, so the DB can breathe for writes and complex queries.

(If you want to see for yourself: change `TASK_COUNT` from 5000 to 50 and run the bench — with a smaller payload the ratio changes.)

**Question 3:** Because you are not measuring the cache's **absence**, you are measuring **waiting for the cache**.

When Redis is down, ioredis doesn't say "not there" immediately. Instead of dropping the command, it keeps it in an **offline queue** (`enableOfflineQueue`, default `true`) — to send once Redis comes back. Then it tries to reconnect, and after every failed attempt it pushes the next attempt further out (the default retry strategy: `min(times × 50, 2000)` ms). A command waiting in the queue only comes back with an error once it passes the `maxRetriesPerRequest` limit. So the longer Redis is down, the longer each request waits.

**Why doesn't `connectTimeout` help here?** Because when the Redis container is stopped, a connection attempt is refused immediately — there is never any waiting up to a timeout. I measured it: changing `connectTimeout` from 1000 to 100 brings no improvement (1763 → 5496 ms, still growing).

**This is the biggest lesson of this exercise.** "The cache is optional" is true from a correctness point of view, but **can be completely false from a latency point of view** — if your cache client holds commands back and waits. A 4-second response is effectively an outage to the user, and upstream the load balancer will start timing out.

The fix — measured on the same machine:

```
default (offline queue on)        : 623 → 3895 ms, keeps growing
connectTimeout: 100               : 1763 → 5496 ms, no improvement
commandTimeout: 100               : ~210 ms every time, stable
enableOfflineQueue: false         : ~12 ms every time — instant error when Redis is gone, straight to the DB
```

So on a cache client, **turn the offline queue off** (there's no point queueing and waiting for a cache), or at least set a **short command timeout**, and ideally add a **circuit breaker** — after a few consecutive failures, stop going to Redis for a while and go straight to the DB. Circuit breakers are covered in detail in Lesson 9.4.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **It is ready to run in the repo:** [`exercises/lesson-4.4-redis-cache/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-4.4-redis-cache) — `docker compose up -d && npm install && npm run seed`, then `npm run build && npm start`. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

This exercise puts all of Module 4's decisions together — Cache-Aside reads, invalidate-on-write (including derived views), TTL 60s, `allkeys-lru`, and a fail-safe cache layer.

**Once the setup is verified, do these four:**

1. Run `npm run bench`. What are the MISS and HIT medians on your machine? Is the ratio close to the ~3.3x I got, or different? If different, why do you think so?

2. In `src/server.ts` change `TTL_SECONDS` from 60 to **2** and rebuild. First run `npm run bench` — you'll see the hit ratio is **still 20/20**! Why? (Hint: how long do the bench's 20 HIT requests take in total?) Now test by hand: send a request, **wait 3 seconds**, send it again — what does the `X-Cache` header say?

   ```bash
   curl -s -D - -o /dev/null "http://localhost:3000/api/tasks?userId=7" | grep X-Cache
   sleep 3
   curl -s -D - -o /dev/null "http://localhost:3000/api/tasks?userId=7" | grep X-Cache
   ```

   Putting the two results together — what does the hit ratio really depend on: the TTL alone, or the relationship between **the TTL and the rate at which requests arrive for the same key**? Match it against the reasoning in question 2 of Lesson 4.3. (And one extra lesson from this: if a benchmark sends requests in a pattern unlike real traffic, its numbers tell the wrong story.)

3. In the `PATCH` handler, remove the `keys.completedByUser(...)` line from the `affected` array. Now: cache the completed list → change a task's `completed` → read the completed list again. **What is wrong?** After how long does it fix itself, and why?

4. **The most important one:** do `docker compose stop redis` and send 5 requests in a row, noting each one's `tookMs`. Then change the Redis client options in `src/cache.ts` and repeat the same test three times (rebuild each time, and before each test `docker compose start redis`, start the server, then stop Redis again):

   - (a) `connectTimeout` from 1000 to **100**
   - (b) `connectTimeout` back as before, plus `commandTimeout: 100`
   - (c) drop `commandTimeout`, add `enableOfflineQueue: false`

   Put the four sets of numbers side by side. Which one brought no improvement at all, and why? Write one paragraph — **how a single client setting can turn "cache down" into "site down", and why the setting everyone suspects first is the wrong place to look.**

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (complete), 4.1, 4.2, 4.3
Current: 4.4 — Redis Hands-on
TaskFlow state: Nginx reverse proxy + LB, horizontal-scale-ready backend,
and now a real Redis caching layer — Cache-Aside read (TTL 60s),
invalidate-on-write (including derived views), fail-safe cache client, allkeys-lru.
Measured: DB path ~12ms, cache path ~3.7ms (5000 tasks), hit ratio 20/20
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution, Cache Hit Ratio,
Discriminated Union, Fail-safe, Offline Queue
Weak spots: [where you got stuck — fill this in yourself]
Next: 4.5 — How a CDN works
=======================
```

---

## 8. Next Lesson

Definitely do exercise number four — skip it and you miss the real lesson of this one. Send me the numbers.

When you are ready, write `next` — in Lesson 4.5 we go into the CDN. In 4.1 we saw the CDN at a glance in the hierarchy; now we go inside — how an edge server actually makes decisions, what the cache key is built from, what the `Cache-Control` directives mean, and how a purge reaches all 300+ PoPs.
