# Lesson 7.3 — BullMQ Hands-on: Background Job Processing in Express

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 4.3):** Why did we choose `maxmemory-policy allkeys-lru` for TaskFlow's cache Redis — what happens when memory fills up, and why is that fine for a cache? Today we'll want to keep jobs in Redis, and you'll see this one line of config has to be exactly the opposite.

**Prerequisite:** Lesson 3.4 (Graceful shutdown), Lesson 4.3–4.4 (Redis, eviction policy), Lesson 6.1 (Lease, process pause), Lesson 7.1 (Job queue, backlog, the weakness of an in-memory queue), Lesson 7.2 (Ack, at-least-once, competing consumers)

**By the end of this lesson you will be able to:**

1. Build a durable background job on BullMQ with an Express API (producer) and a separate worker process (consumer) — with typed job data via Zod, retry, backoff, and your own job IDs
2. Draw a job's whole life (waiting → active → completed/failed, delayed, stalled), and say what happens to a job when the API, the worker or Redis dies — with numbers
3. Make the decisions for running TaskFlow's job system in production: Redis's config, the lock's duration, concurrency, graceful shutdown, and what to measure

**Tier:** 1 — Runnable Code (Redis in Docker; the API, the worker and a fake email provider as separate Node processes)

---

## 0. Where TaskFlow Is Right Now

Lesson 7.2's decision: TaskFlow's messages are of two kinds. "News" (a comment was created, a task was completed) goes into a log. And "tasks" (send this email, build this export) go into a queue — with per-message acks, retry, delay. TaskFlow's stack already has Node and Redis, so for tasks the choice was **BullMQ**: a Node/TypeScript job queue library built on top of Redis.

Today we build it. And after building it, a test we've been waiting two lessons for. Remember Lesson 7.1's last experiment: an in-memory queue, a slow provider, and `SIGKILL` on the API process right in the middle. The result was:

```
   told "succeeded", the email never went: 103
```

103 users saw "assigned"; their assignees never got an email; nobody even knows. Today, the same test, with BullMQ.

Along with it, four more questions from the team, raised in code review:

1. "What if the **worker** dies midway, not the API — while sending the email?"
2. "What if the provider returns `503` now and then?"
3. "If the user clicks twice, or the browser resends after a timeout — two emails?"
4. "And what if Redis **itself** dies? All the jobs are in there."

Today we'll measure the answer to each in the exercise.

---

## 1. Theory

### 1.1 Three parts: the Queue, the Worker, and Redis

BullMQ has three players:

```
   ┌──────────────── API process (×6) ────────────────┐
   │  Express route → queue.add('assign-email', data) │   producer
   └──────────────────────────┬───────────────────────┘
                              │  writes the job (into Redis)
                              ▼
   ┌─────────────────────── Redis ───────────────────────┐
   │  wait: [job, job, job …]   delayed   active   …     │   all state lives here
   └──────────────────────────┬──────────────────────────┘
                              │  picks up a job (with a lock)
                              ▼
   ┌──────────────── worker process (×N) ─────────────┐
   │  new Worker('emails', processor, { concurrency })│   consumer
   └──────────────────────────────────────────────────┘
```

- **`Queue`** — the producer's side. `queue.add(name, data, options)` writes the job into Redis, and returns once it has been written.
- **`Worker`** — the consumer's side. It picks up jobs from Redis, runs your processor function, and moves the job to its next state depending on the result. `concurrency: 8` means one process runs 8 jobs at once (enough in Node for waiting-type work — as in Lesson 7.1).
- **Redis** — the only place where a job's state lives. Not in the memory of the API or the worker. Every answer today follows from this one sentence.

The producer's side, from the exercise's `api.ts` (the core part):

```typescript
const queue = new Queue<AssignEmail>(QUEUE_NAME, { connection });

app.post('/api/tasks/:id/assign', async (req: Request, res: Response): Promise<void> => {
	// … taskId and body validated with Zod …
	try {
		// queue.add returns once the job is written to Redis — after this the job survives even if the API dies
		const job = await queue.add(JOB_ASSIGN_EMAIL, data, {
			...assignJobOptions(env.ATTEMPTS), // attempts, backoff, removeOnComplete …
			jobId: assignJobId(data) // `assign-${taskId}-${assigneeId}` — in 1.7
		});
		res.status(202).json({ taskId: data.taskId, jobId: job.id });
	} catch (error: unknown) {
		// Redis can't be reached — the job wasn't written. Quietly returning 202 would be 7.1's fire-and-forget.
		res.status(503).json({ error: 'QUEUE_UNAVAILABLE' });
	}
});
```

Notice two things. `202 Accepted` — "taken, it'll happen later" (Lesson 7.1's 1.6). And the `503` in the `catch` — honestly telling the user it failed if the job couldn't be written. Fire-and-forget's biggest sin in 7.1 was exactly the opposite: saying "succeeded" without having taken the work.

The consumer's side, `worker.ts`:

```typescript
async function processAssignEmail(job: Job): Promise<void> {
	// data coming from Redis — another process wrote it, so parse it instead of trusting it
	const data = assignEmailSchema.parse(job.data);
	const res = await fetch(`${env.PROVIDER_URL}/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ key: job.id, to: data.to }),
		signal: AbortSignal.timeout(env.SEND_TIMEOUT_MS) // no external call without a timeout (7.1)
	});
	if (!res.ok) throw new Error(`provider responded ${res.status}`);
}

const worker = new Worker(QUEUE_NAME, processAssignEmail, {
	connection,
	concurrency: env.CONCURRENCY,
	lockDuration: env.LOCK_MS, // in 1.5
	stalledInterval: env.STALLED_MS
});
```

**Why parse job data with Zod?** Main.md's rule — don't trust runtime input with `as` — is especially important here. The job data was written by **another process**, maybe by **another version** of the code. A deploy goes out on Wednesday, a new field is added to the job's shape — but 500 jobs of Tuesday's old shape are still waiting in the queue. The new worker will read them. The generic on `Queue<AssignEmail>` is only a compile-time promise; what's in Redis is JSON, and its shape has to be checked at runtime. (So think of changing a job's shape like a small migration — keep new fields optional, or put a version in the job's name.)

**Why is the worker a separate process?** Three reasons, all from earlier lessons. (a) Separate scaling: when the backlog grows, add workers, not APIs. (b) Separate deploys and crashes: a bug in the worker doesn't bring down the API. (c) CPU work (PDFs, images) blocks the worker's event loop, not the API's — in 1.5 you'll see why this matters even more. And one small rule: the worker's Redis connection needs `maxRetriesPerRequest: null` (the worker waits on a "blocking" command; this stops ioredis from failing the command if Redis is briefly unavailable) — BullMQ itself warns you if it's missing.

### 1.2 A job's life

**Job state** — in BullMQ every job is in exactly one state at any moment, and moves from one state to another only by fixed rules.

```
                      queue.add()
                          │
            ┌─────────────┼───────────────────┐
            │ with delay  │ normal            │ with priority
            ▼             ▼                   ▼
        [delayed] ──► [waiting] ◄──────── [prioritized]
            ▲             │
            │             │ a worker picked it up (with a lock)
            │             ▼
            │         [active] ────────────────────────┐
            │          │    │                           │ lost the lock
            │  success │    │ throw                     │ (worker dead/stuck)
            │          ▼    ▼                           ▼
            │   [completed] attempts left? ── no ──► [failed]    stalled → [waiting]
            │                │                                  (again and again → failed)
            └── yes: backoff ┘
```

**Delayed job** — a job that isn't for running now but after a set time; until then it waits in the `delayed` state, and when the time comes it moves to `waiting`.

Delayed comes from two places: when you ask for it (`queue.add(…, { delay: 24 * 3600_000 })` — "send the deadline reminder tomorrow morning"), and from retries — when an attempt fails, the job sits in delayed for the backoff time.

Read this picture in Lesson 7.2's language: `active → completed` is the **ack**. BullMQ moves the job to completed when the processor function returns successfully — not before. So BullMQ is naturally **at-least-once**: the work happened, something broke before "completed" was written — the job will come again. You'll see this in numbers in 1.5.

### 1.3 What's inside — and why Redis's config is the opposite

The exercise's `npm run inspect` creates one job in each state in a small queue and shows the Redis keys directly (on BullMQ 5.81; the details may change between versions):

```
   Redis keys (bull:inspect-demo:*):
     completed            zset    demo-completed
     delayed              zset    demo-delayed
     demo-completed       hash
     demo-delayed         hash
     …
     events               stream  16 events
     failed               zset    demo-failed
     prioritized          zset    demo-prioritized
     wait                 list    demo-waiting
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

Each job is a Redis **hash** (name, data, opts, failedReason, timestamp …). And the states are separate collections: `wait` is a list (FIFO), `delayed` is a sorted set (score = when it becomes due — so "which one is due next" can be found quickly), `completed`/`failed` are sorted sets (score = the time it finished). `events` is a Redis Stream — Lesson 7.2's log! — holding news of every state change, so other processes (a dashboard, `QueueEvents`) can listen.

Moving from one state to another means changing several keys together (take it out of the list, write the lock on the hash, add it to active). If there were a crash midway, the job would be half here, half there. BullMQ does this with **Lua scripts** — Redis runs a script atomically, and no other command can get in between. (Lesson 5.5's idea of a transaction, in Redis's language.) This is why the rule is: **don't touch the Redis keys directly, always go through BullMQ's API.**

**Now the spaced repetition answer — and today's easiest config to get wrong.** In Lesson 4.3 we chose `allkeys-lru` for the cache Redis: when memory fills, Redis drops the least recently used keys. For a cache that's perfect — a dropped key comes back from the database.

The same config on a queue's Redis means: when memory fills, Redis **will drop jobs** — silently. Which jobs? The least recently touched ones — that is, the oldest jobs in the line, the ones that have waited longest. Exactly when the backlog is biggest (exactly when you need the queue most). So on the queue's Redis:

```yaml
command: redis-server --maxmemory 256mb --maxmemory-policy noeviction --appendonly yes --appendfsync everysec
```

- **`noeviction`** — when memory fills, drop nothing; new writes fail (an `OOM` error). Then `queue.add` throws and the API returns `503` — failing loudly is better than losing things silently. BullMQ itself checks the policy at startup, and warns if it isn't `noeviction` (`IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"`).
- **`appendonly yes`** — AOF, in 1.8.

And the direct consequence: **the cache and the queue shouldn't be on the same Redis instance.** Their memory policies are opposites, and a big wave of cache can eat the queue's space. Separate instances (or, on a managed service, a separate database/cluster).

### 1.4 When the API dies — the answer to 103

Now the test. The load is the same as Lesson 7.1: 20 assigns per second, 8 seconds normal → 8 seconds slow (the provider takes 2 seconds per email) → 8 seconds normal again. One worker process, concurrency 8. First, nobody dies — `npm run scenario`:

```
   phase            API p50 / p99    API failed
   normal             22 ms / 53 ms            0
   provider slow      30 ms / 53 ms            0
   after recovery     29 ms / 35 ms            0

   most in the queue: waiting 127, delayed (waiting to retry) 0
   email delivery (from job added): p50 194 ms, p99 6.8 s, max 6.8 s
   "got 202, the email never went": 0
```

The same shape as 7.1's queue: even when the provider is slow the API takes a few tens of ms, and the damage goes into the backlog and delay. Check the backlog by hand: in the slow phase 8 workers ÷ 2 s = 4 emails/s go out, 20 arrive → +16/s × 8 s = **128** (measured 127). One difference: the API's p50 is now ~20–30 ms, not the ~10 ms of 7.1's in-memory queue — every `queue.add` is a network round trip to Redis. The price of durability, and a cheap price.

Now the real test — `CRASH=api`, `SIGKILL` on the API process in the middle of the slow phase (at 12 seconds), and a new API right away:

```
    12.0 s  API process SIGKILL — a new API is starting

   phase            API p50 / p99    API failed
   provider slow      32 ms / 53 ms            3

   "got 202, the email never went": 0
```

**Zero.** From 103 to 0. Because of 1.1's sentence: the job was never in the API's memory at all. The moment `queue.add` returns, the job is in Redis; after that, whether the API dies or lives — the worker will get the job.

And look at "API failed 3" — this is correct behaviour too. The users of the 3 requests that went to the dead API saw an error; they'll try again. Not a single false "succeeded". The real achievement of a durable queue is this pair of numbers: **whoever was told "done" will have the work done; whoever's work couldn't be taken knows it.**

(There's still a gap, deliberately kept out of the exercise: in the real route, the assign is first committed to the database, then `queue.add`. The commit happened, the API died before `queue.add` — the assign exists, the job doesn't. In Lesson 7.1's 1.6 we named this dual write; the fix — the transactional outbox — is in Lesson 7.5.)

### 1.5 When the worker dies — the lock, stalled jobs, and twice

Now the team's first question: the worker picked up a job, sent a request to the provider — then died. The job is now in the `active` state in Redis. Does anyone know that its worker is gone?

Lesson 6.1's question, in a new place: "is the other one dead, or just slow?" And the answer is also the same — a **lease**.

**Job lock** — when a worker picks up a job, it takes a lock with an expiry in Redis (`lockDuration`, default 30 seconds), and renews it regularly while the work runs (by default every half of the duration); if it isn't renewed, the lock goes away when it expires.

**Stalled job** — an `active` job whose lock has expired, meaning its worker is no longer renewing it (dead or stuck); BullMQ's stalled checker (every `stalledInterval`, default 30 seconds) moves such a job back to `waiting`, for another worker.

`CRASH=worker-kill` — `SIGKILL` on the worker at 12 seconds, and a new worker right away (in the exercise `lockDuration` is 10 s and `stalledInterval` 5 s — to keep the run short; both defaults are 30 s):

```
    12.0 s  worker SIGKILL (active in the queue at the time: 8) — a new worker is starting

   jobs: completed 478, failed 0   · attempts needed: 1 → 478
   email delivery (from job added): p50 194 ms, p99 18.7 s, max 18.9 s
   "got 202, the email never went": 0
   the same email delivered twice (or more): 8
```

Read it:

1. **Nothing was lost** — the dead worker's 8 active jobs became stalled when their locks expired, and the new worker picked them up.
2. **8 emails went twice** — exactly those 8. Before the worker died, their requests had reached the provider; the provider had sent them; the worker died before writing "completed". Lesson 7.2's 1.3 picture, exactly: ack after the work, and a crash in between → **at-least-once**.
3. **Delay max ~19 seconds** — until the lock expired (10 s) and the stalled checker's turn came, nobody touched those 8 jobs. With the production defaults (30 s / 30 s), in the exercise's experiment 4 this is **~94 seconds** — Lesson 6.1's timeout trade-off: a short lock = a dead worker is caught quickly, but…
4. **"Attempts needed: 1" for everyone** — coming back from stalled doesn't count as an "attempt" in BullMQ's bookkeeping. But there's a limit: if a job stalls again and again (`maxStalledCount`, default 1 — meaning being moved back once is allowed, not a second time) it becomes `failed`, with the reason `job stalled more than allowable limit`.

**…but the danger of a short lock — Lesson 6.1 again.** The lock is a lease, and in 6.1 we saw how leases break: **process pauses**. If the worker's event loop gets stuck for some reason (a big `JSON.parse`, building a PDF synchronously, GC), the lock-renewal timer doesn't run — the worker is alive and working, but dead in Redis's eyes. The exercise's experiment 5 is exactly this: a 12-second synchronous loop in one job's processor (lock 10 s):

```
   worker error: could not renew lock for job assign-100-1
   …
   jobs: completed 476, failed 2
   reason for failed: "job stalled more than allowable limit" × 2
   the same email delivered twice (or more): 9
```

One job was stuck, but **all of them** lost their locks — because there's one event loop; the whole process had stopped, so the locks of none of its 8 running jobs were renewed. All stalled, all ran again, 9 duplicates. And the stuck job itself? When it ran again it got stuck for 12 seconds again, stalled again — the second time, so `failed`. An archetype of the job that breaks every time, like 7.2's "poison message".

The lesson, just like 6.1: **the lock's safety depends on pauses being much shorter than the lock's duration.** Three remedies:

- Don't block the worker's event loop. Put heavy CPU work in BullMQ's **sandboxed processor** — the processor is in a separate file, which BullMQ runs in a separate child process (or worker thread); then the lock is renewed by the main process, whose event loop is free.
- Keep `lockDuration` longer than the work's worst pause — and accept that a dead worker will take that much longer to be noticed.
- And since duplicates will happen anyway: **make the job idempotent** (the provider's idempotency key, or a unique constraint in `sent_notifications` — Lessons 6.1 and 7.4). In the exercise the worker deliberately sends `job.id` to the provider as `key` — on a real provider that's where the idempotency key goes, and then the provider itself would have discarded these 8 and 9 duplicates.

**And graceful shutdown — how a deploy should go.** `CRASH=worker-term` — the same moment, but `SIGTERM` instead of `SIGKILL`:

```
    12.0 s  worker SIGTERM (active in the queue at the time: 8) — a new worker is starting
   email delivery (from job added): p50 199 ms, p99 6.7 s, max 7.0 s
   the same email delivered twice (or more): 0
```

**0** duplicates, and no jump in the delay. The worker's SIGTERM handler (Lesson 3.4's graceful shutdown) calls `worker.close()`: stop taking new jobs, finish the 8 running ones, then exit. Kubernetes or any deploy system sends SIGTERM first, then SIGKILL after a grace period (30 seconds by default in Kubernetes). So the rule: **the grace period must be longer than your longest job** — otherwise every deploy is a `worker-kill`.

### 1.6 When the provider fails — retry and backoff

The team's second question. What happens when the processor throws is decided by the job's options (`config.ts`):

```typescript
{
	attempts: 5,
	// 1 s, 2 s, 4 s, 8 s … — and ±50% jitter
	backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
	removeOnComplete: { age: 3600, count: 10_000 },
	removeOnFail: { age: 7 * 24 * 3600 }
}
```

**Exponential backoff** — after each failed attempt the wait grows multiplicatively (in BullMQ `2^(attempt−1) × delay`: 1, 2, 4, 8 seconds); plus jitter — a little randomness in each wait — so hundreds of jobs that failed together don't all jump back in at the same moment.

Why multiplicatively? If the provider is under temporary strain, retrying immediately adds to its strain; growing the wait gives it time to recover. (The details — when not to retry, up to how many times, the maths of jitter — are the whole of Lesson 7.4.)

`FAIL_RATE=0.3` — the provider returns `503` 30% of the time:

```
   most in the queue: waiting 143, delayed (waiting to retry) 21
   jobs: completed 477, failed 1   · attempts needed: 1 → 341, 2 → 86, 3 → 36, 4 → 11, 5 → 3
   provider: distinct emails delivered 477, returned 503 208 times
   email delivery (from job added): p50 2.2 s, p99 14.5 s, max 18.8 s
   "got 202, the email never went": 1
```

Look at the distribution of attempts — nearly geometric: ~70% succeed each time, so each step is ~30% of the one before. The probability of failing all 5 times is 0.3⁵ ≈ 0.24%, ~1.2 out of 478 — and exactly **1** job is `failed`. Without retry (experiment 3, `ATTEMPTS=1`), 142 fail, ~30%.

And that 1? "Got 202, the email never went: 1" — but there's a fundamental difference from the 60 of 7.1's fire-and-forget: this one is **visible**. It's in the `failed` set, with the reason (`provider responded 503`), and will stay for 7 days (`removeOnFail`). Someone can see it, alert on it, fix it and run it again (`job.retry()`). Failures will always exist; the only question is where failures go — into silence, or into a list. (This list's formal name is the dead letter queue — 7.4.)

Two subtleties:

- **Not every failure deserves a retry.** A `503` is temporary — retrying is worth it. But "the email address is invalid" (the provider's `400`) is permanent — 5 attempts just waste time. In BullMQ, throwing `UnrecoverableError` for this skips the remaining attempts and goes straight to failed.
- **You need `removeOnComplete`.** By default BullMQ keeps every finished job forever. A million emails a day means a million hashes a day — and with `noeviction`, when Redis fills up (1.3) the queue itself stops.

### 1.7 When the same work is added twice — your own job ID

The team's third question: the user clicked twice, or the browser resent after a timeout (Lesson 6.1 — a timeout means "I don't know", so the client sends again). BullMQ's default job ID is an increasing number — two requests, two jobs, two emails.

**Job ID deduplication** — building the job's ID yourself, from the work's data (e.g. `assign-{taskId}-{assigneeId}`), so that if the same work is added twice both get the same ID; BullMQ doesn't add a second job with an ID that already exists.

`DOUBLE_SUBMIT=1` — every assign sent twice:

```
   API returned 202: 954 times, distinct jobs: 477
   provider: distinct emails delivered 477
   the same email delivered twice (or more): 0
```

954 requests, 477 jobs, 477 emails. The queue form of Lesson 2.5's idempotency key — and this time the key didn't come from the client, it came from the **identity** of the work.

Three limits, each important:

1. **Choosing the ID is a design decision.** `assign-{taskId}-{assigneeId}` means: if the same person is assigned to the same task again (removed, then assigned again), a second email won't go — if the first job is still in Redis. Is that what you want? If not, add the assignment's own id or version to the ID. (And BullMQ's custom IDs can't contain `:`, nor be just a number — hence `-`.)
2. **Dedupe only lasts as long as the job is in Redis.** `removeOnComplete` deletes the job after an hour; after that the same ID can be added again. For long-term "only once", a unique constraint in the database (7.4). (BullMQ also has a separate `deduplication` option, for a set TTL — for debounce/throttle-type work.)
3. **This stops duplicates from adding, not from processing.** 1.5's stalled-job duplicate is the same job with the same ID, **run** twice — the ID doesn't stop that. Two separate problems, two separate solutions.

### 1.8 When Redis itself dies

The last question, and the one that needs the most honest answer: "all the jobs are in Redis — what if Redis dies?"

The first part: Redis's data is in memory. A restart means empty memory — **unless** Redis writes something to disk. Two ways: RDB (a full snapshot every so often — writes between two snapshots are at risk) and AOF.

**AOF (Append-only File)** — Redis appends every write command to the end of a file; on restart it replays the file to bring the data back. `appendfsync everysec` means the file is made durable on disk every second — so a sudden death can lose at most ~1 second of writes; with `always`, on every write (safe, but much slower).

(Reminded of Lesson 5.3's WAL? The same idea — write it in the ledger first, then remember it.)

The exercise's experiment 1 — stopping Redis from another terminal while the scenario runs:

- `docker compose restart redis` (SIGTERM — Redis shuts down tidily, ~1 second): nothing was lost; the API's p99 rose to 1 second, not a single failure.
- `docker compose kill redis`, start again after 2 seconds (SIGKILL — Redis gets no chance to tidy anything): in this run nothing was lost either, 0 duplicates; the API's p99 was 3 seconds, not a single failure.

Why didn't the API fail? Because when ioredis (BullMQ's Redis client) loses its connection it holds commands itself and sends them after reconnecting — so the API's `queue.add` waited 3 seconds rather than failing. Convenient — but what if Redis doesn't come back for 30 seconds? Then every API request will hang (the familiar shape of 7.1's cascading failure). So it's good to put a limit on the API side's connection (ioredis's `enableOfflineQueue`/`commandTimeout` — like Lesson 4.4's experiment 4), so that when Redis isn't there `queue.add` fails fast and returns `503`.

Now the honest part:

- **"Nothing was lost in this run" doesn't mean "nothing will ever be lost".** With `everysec`, the last ~1 second of writes at the moment of SIGKILL is at risk — this run got lucky. If a job that was given a `202` was in that second, it's gone.
- **In production Redis usually runs with a replica, and replication is async.** The primary dies, the replica is promoted — jobs written to the primary but not yet reached the replica are lost. Lesson 5.7's RPO, exactly.
- So BullMQ's guarantee can't be stronger than Redis's. For email that's more than enough. But for work that must **never** be lost (the steps after a payment, billing), the job's source should be the database — write "this work must be done" inside the database's transaction, then lift it from there into the queue. That's the transactional outbox, Lesson 7.5.

### 1.9 TaskFlow's production checklist

All together — what has to be settled before TaskFlow's job system goes live:

| Decision                  | For TaskFlow                                                                  | Why                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Redis                     | A separate instance, `noeviction`, AOF `everysec`, a replica                  | Jobs must not be dropped (1.3); survives a restart (1.8)                     |
| Worker                    | Deployed separately, CPU work in a sandboxed processor                        | Separate scaling/crashes; a blocked event loop loses locks (1.5)             |
| Concurrency               | Little's Law: `arrival rate × work time`, and below the provider's rate limit | Too low → backlog, too high → provider `429` (7.1); BullMQ's `limiter`       |
| `lockDuration`            | Keep the default 30 s, keep the work short                                    | Short = caught quickly, but false stalls on a pause (1.5)                    |
| Graceful shutdown         | SIGTERM → `worker.close()`; grace period > the longest job                    | Otherwise duplicates on every deploy (1.5)                                   |
| Retry                     | 5 times, exponential + jitter; `UnrecoverableError` on permanent errors       | Temporary failures heal, no time wasted on permanent ones (1.6)              |
| Job ID                    | From the work's identity (`assign-{taskId}-{assigneeId}`)                     | One job on a double submit (1.7)                                             |
| Idempotency               | An idempotency key at the provider / a `sent_notifications` unique constraint | Duplicates from stalls and crashes will happen (1.5) — 7.4                   |
| Job data                  | Small — IDs, not whole objects; parsed with Zod                               | Jobs from old versions; and let the worker read fresh data from the database |
| `removeOnComplete`/`Fail` | Finished: 1 hour, failed: 7 days                                              | Redis doesn't fill up; there's time to look at the failed ones               |
| Measure                   | The waiting count, **the age of the oldest waiting job**, the failed rate     | Catching backlogs and dead workers (7.1); a dashboard (e.g. Bull Board)      |

One line on "keep job data small": if the assign email's job holds the whole task object, by the time the job runs (maybe 30 seconds later, in the backlog) the task's title may have changed — the email would show the old title. Keep only `taskId` in the job, and let the worker read fresh data from the database. (The exception: when you deliberately want the data as of that moment — like "who did the assigning at the time of assignment".)

---

## 2. Interview Angle

**"Design a background job system" or "how will the notification system send emails?"** — BullMQ's name isn't needed here; the ideas are, and the interviewer's list of follow-ups is almost fixed: what happens when a worker dies (lock/visibility timeout → it comes again → at-least-once → idempotent consumer); how retries work (exponential backoff + jitter, temporary vs permanent errors); what happens when it fails repeatedly (dead letter — the failed set); what happens when the same work is added twice (a deterministic job ID); what happens when the queue's store dies (persistence, replication lag, and the outbox for important work). With these five answers ready, it works under any queue tool's name — AWS SQS's "visibility timeout" and BullMQ's "lock" are the same idea.

**"How would you build a delayed job — like a reminder one day before a deadline?"** — Two paths, and stating the trade-off is essential: (a) a delayed job when the task is created (`delay` = deadline − 1 day − now) — simple, but if the deadline changes the old job has to be cancelled (easy with your own job ID: remove `reminder-{taskId}` and add a new one), and a job for a month from now sits in Redis for a month; (b) a repeatable/cron job every few minutes looks in the database for "tasks with a deadline tomorrow" — the database is the source of truth, changing the deadline requires nothing, but a query runs again and again. For large numbers and times that keep changing, (b) is often safer — and then, like Lesson 6.1, you have to make sure only one runs the cron (BullMQ's repeatable jobs have their own mechanism for this).

**In real production:** the most common incidents are almost always one line of this lesson: the cache and the queue on the same Redis, `allkeys-lru` — jobs lost on the day of the backlog; no `removeOnComplete` — Redis's memory slowly fills and one day `OOM`; a synchronous heavy task in the worker — "why did the same invoice go twice?"; a deploy grace period shorter than the job — a few duplicates on every deploy; and nobody looks at the `failed` set — a few hundred tasks a month quietly lying there.

---

## 3. Key Takeaway

- BullMQ: `Queue` in the API (producer), `Worker` in a separate process (consumer), and **all state in Redis** — in nobody's memory. Job data is written by another process/version, so parse it with Zod
- A job's life: waiting/delayed/prioritized → active (with a lock) → completed (= ack) or retry (backoff → delayed) or failed; on losing the lock, stalled → waiting again
- **`noeviction` + AOF** on the queue's Redis, the opposite of a cache; the cache and the queue on separate instances
- When the API dies: 7.1's **103 → 0** — the job is in Redis before `queue.add` returns; and whoever's job couldn't be taken gets a `503`, not a false "succeeded"
- When the worker dies: the **job lock** expires → **stalled** → runs again — nothing is lost, but the running ones happen **twice** (8 in the exercise). The same when the event loop is blocked (6.1's pause); with a graceful shutdown (SIGTERM → `worker.close()`) 0 duplicates
- **Exponential backoff** + jitter heals temporary failures (at 30% failure, 477 of 478 are delivered), and the rest stays **visible** in `failed` — not silently
- Your own **job ID** stops duplicates from adding (954 requests → 477 emails), not from processing; the limits of Redis's persistence and async replication are the queue's limits — the outbox for important work (7.5)

---

## 4. New Terms (Glossary)

| Term                       | Meaning                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Job State**              | A job's state in BullMQ (waiting, delayed, prioritized, active, completed, failed) — one at any moment, changing by fixed rules |
| **Delayed Job**            | A job to run after a set time — it stays in `delayed` until then; asked for yourself, or from a retry's backoff                 |
| **Job Lock**               | A lock with an expiry (`lockDuration`) the worker takes in Redis when it picks up a job, renewed while the work runs — a lease  |
| **Stalled Job**            | An active job whose lock has expired (the worker dead or stuck); the stalled checker moves it back to waiting                   |
| **Exponential Backoff**    | After each failed attempt the wait grows multiplicatively (1, 2, 4, 8 s …), with jitter so everyone doesn't come back at once   |
| **Job ID Deduplication**   | A job ID built from the work's data — the same work added twice gets the same ID, and the second isn't added                    |
| **AOF (Append-only File)** | Redis appends every write to a file and replays it on restart to bring the data back; with `everysec`, at most ~1 s at risk     |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. TaskFlow's CSV export: when the user presses "export", one job — read 50 thousand tasks, build a CSV (CPU work, ~40 seconds), upload to S3, then email the user a link. Settle everything: the worker's options (`lockDuration`, concurrency, attempts), where the processor runs, what data goes in the job, and how the user will know whether the export is ready. What would have happened if you'd left the default `lockDuration` (30 s) — like which experiment in the exercise?
2. An engineer says: "We already have the cache Redis, 16 GB, half empty. Why pay for running another Redis? Let's put the queue there." What would you answer — what can go wrong, in what sequence of events? If there really is no budget, what's the least bad alternative?
3. Deadline reminder: "email the assignee 24 hours before a task's deadline." For both designs — (a) a delayed job when the task is created, (b) a repeatable job every 5 minutes that searches the database — say what has to be done when the deadline changes, when the task is deleted, when Redis's data is lost, and how you'd stop the same reminder going twice. Which would you choose?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

- **Where the processor runs:** building the CSV is CPU work and will block the event loop for 40 seconds — so a **sandboxed processor** (a separate child process/worker thread). Otherwise, like 1.5's experiment 5: the lock won't be renewed for 40 seconds, the default 30 s lock will be lost, the job will stall and run again — and so will **every other** running job of that worker (there's one event loop). The second time is 40 seconds too, stalled again → `job stalled more than allowable limit` → failed. The export will never finish.
- **A separate queue:** not the export in the email queue — a separate queue called `exports`, with separate workers. Otherwise a 40-second task blocks the email workers' slots (like 7.1's question 3).
- **Options:** low concurrency (1–2 per worker, CPU work — based on the number of cores); if sandboxed, the default `lockDuration` is fine (the main process renews it), otherwise longer than the work's worst time; attempts 3, exponential backoff — for temporary problems with S3 or the database.
- **Job data:** `{ exportId, userId, filters }` — not the tasks. The worker reads from the database. And a row in an `exports` table (`status: 'pending' | 'running' | 'done' | 'failed'`, `url`) — the source of truth.
- **How the user knows:** the API returns `202` and the `exportId`; the UI polls with `GET /api/exports/:id` (or SSE, Lesson 2.4); at the end, a link by email. Job ID = `export-{exportId}` — no two exports on a double click.
- **Idempotency:** if the job runs twice (stalled), it uploads twice to the same key in S3 — no harm (the same file overwritten); but the email can go twice → check `exports.emailSentAt` before sending.

**Question 2:** The sequence of events: the cache Redis has `allkeys-lru` (right for a cache). One day the provider is slow, and the email backlog is 200 thousand jobs. At the same time the cache is growing under traffic pressure. Memory reaches its limit — Redis drops keys by LRU: the least recently touched keys, meaning **the oldest waiting jobs** (and their hashes). No error, no log (BullMQ gave only one warning, at startup). If half of a job remains (the ID in the list, no hash), the worker will see strange errors. The other way round, with `noeviction` — the cache's writes will fail with `OOM`, meaning as soon as the cache fills, the whole app's cache layer will start returning errors (and the app itself, without 4.4's fail-safe). The two policies can't both be in force at once.

Also: a wave of cache traffic (big keys, lots of misses) increases the queue's latency; for a cache it's right to keep persistence off (faster), for a queue you need AOF — opposites again.

The least bad alternative (if there's no budget): **two Redis processes** on the same machine (separate ports, separate `maxmemory`, separate policies, AOF on the queue's one) — almost the same cost, separate policies. Or, on a managed service, a small separate instance — a queue's memory is usually small (if `removeOnComplete` is set right). What mustn't be done: assuming two policies in one process.

**Question 3:**

| Event                   | (a) Delayed job when the task is created                                                                                 | (b) Repeatable job every 5 minutes, searching the database                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Deadline changed        | Remove the old job and add a new one (easy with a `reminder-{taskId}` ID) — forget, and the email goes at the wrong time | Nothing — the next search sees the new deadline                                                  |
| Task deleted            | The job must be removed, otherwise the worker has to check "does the task exist"                                         | Nothing                                                                                          |
| Redis's data lost       | Every future reminder is gone — and nobody knows                                                                         | Nothing is lost — the database is the source of truth; again on the next search                  |
| Stopping it going twice | Job ID dedupe + idempotent sending for stalls                                                                            | Not twice between search and send — a `reminder_sent_at` column, a conditional update (like 6.1) |
| Cost                    | Next month's reminder sits in Redis all month                                                                            | One query every 5 minutes (needs an index: `deadline`, `reminder_sent_at`)                       |

The choice: for TaskFlow, (b) — deadlines change often, and there's no reason to take the risk of "future reminders silently gone if Redis's data is lost". The search job itself is run by only one (BullMQ's repeatable job ensures this with a fixed job ID), and each reminder goes into the queue as a separate email job (`reminder-{taskId}-{deadline}`) — that way the email's retries and failures are accounted for separately. (a)'s right place: one-off work at times that don't change — "a tip email 3 days after sign-up".

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (Redis in Docker; the API, the worker and a fake email provider as separate Node processes)

> **Ready to run in the repo:** [`exercises/lesson-7.3-bullmq/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.3-bullmq) — `docker compose up -d --wait && npm install`, then `npm run scenario` (with `CRASH=api`, `CRASH=worker-kill`, `CRASH=worker-term`, `FAIL_RATE=0.3`, `DOUBLE_SUBMIT=1`) and `npm run inspect`. The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in that folder's `README.md`.

`api.ts` is the producer, `worker.ts` the consumer (with graceful shutdown), `provider.ts` a fake email provider that counts which email was delivered how many times, and `scenario.ts` runs everyone, generates load, kills someone when needed, and reconciles at the end — who was given a `202` versus what actually reached the provider.

**Honest note:** verified by running it in the sandbox with Redis 8 in Docker and BullMQ 5.81.5: `tsc --noEmit` is clean; the baseline and five runs (`CRASH=api`, `worker-kill`, `worker-term`, `FAIL_RATE=0.3`, `DOUBLE_SUBMIT=1`), `WORKER_PROCS=2`, `ATTEMPTS=1` (twice), the production default lock, the blocked event loop (experiment 5, by changing `worker.ts` and then reverting it), and Redis's restart and kill — all were run, and the numbers are in the README. Real processes and real timers, and `FAIL_RATE`'s failures are random — so the numbers will differ slightly each time. The scenario uses `lockDuration` 10 s and `stalledInterval` 5 s (defaults 30/30) — to keep the run short. "Nothing was lost" after the Redis kill is the result of one run — with `everysec` the ~1 second of risk is always there. The part of experiment 1 that turns AOF off wasn't run — that one's yours. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Avenging 103:** run `CRASH=api npm run scenario`, and put Lesson 7.1's `CRASH_AT_MS=14000 npm run scenario -- queue` result beside it. Write the reason for the difference between the two numbers in one sentence. Then: this exercise has no database — in the real route, what happens if the API dies between the database commit and `queue.add`? (Write the question down for Lesson 7.5.)

2. **Kill vs Term:** run `CRASH=worker-kill` and `CRASH=worker-term`. Explain the difference in "delivered twice" and "delay max" — with the lock, the stalled checker, and `worker.close()`. Then experiment 4 (the production default lock) — what was the delay, and what grace period will you set for TaskFlow's deploys?

3. **Block the event loop** (experiment 5): change `worker.ts` as instructed, run it, and read the worker's log and the result. Why did eight locks go when one job was stuck? What's the reason for the failures, and why exactly 2? Then turn the processor into a BullMQ sandboxed processor (a separate file, `new Worker(QUEUE_NAME, path.join(__dirname, 'processor.js'), …)`) and run again — what changed? (Put the code back as it was at the end.)

4. **The retry arithmetic:** run `FAIL_RATE=0.3` and `FAIL_RATE=0.3 ATTEMPTS=1`. Work out the distribution of attempts by hand (if 70% succeed each time, how many of 478 in 1 attempt, in 2 …), and compare. Then change the provider so it always returns `400` for one particular address in `to`, and throw `UnrecoverableError` in the worker on a `400` — how many times was that job attempted?

5. **Design part:** a list of all of TaskFlow's background jobs (at least 6: assign email, mention email, password reset, CSV export, attachment thumbnail, deadline reminder). For each: which queue (one, or separate — why), how you'll build the job ID, attempts and backoff, concurrency (with Little's Law, using numbers you assume), whether it's sandboxed if it's CPU work, and what the harm of a duplicate is and how you'll stop it. Finally, the config of TaskFlow's queue Redis (policy, persistence, memory) — the reason for each in one line.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (complete, including exit challenges), 7.1, 7.2
Current: 7.3 — BullMQ hands-on: background job processing in Express
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; background jobs: BullMQ, a separate queue Redis (noeviction + AOF
everysec, separate from the cache), a separate worker process (graceful shutdown), the assign
email's job ID = assign-{taskId}-{assigneeId}, attempts 5 + exponential backoff/jitter, failed kept
7 days; events (comment.created, task.completed) → Redis Streams (7.2); still to come: idempotent
consumers (7.4), the database ↔ queue dual write (7.5)
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF
Weak spots: [where you got stuck — fill this in yourself]
Next: 7.4 — Idempotency, retry, exponential backoff, DLQ, backpressure
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your explanation of the event loop in #3 and your list of jobs in #5. When you are ready, write `next` — we'll go to Lesson 7.4: **Idempotency, Retry, Exponential Backoff, DLQ, and Backpressure.** Today we hit the same wall three times: 8 duplicates on the worker kill, 9 on the blocked event loop, and each time the answer was "make the consumer idempotent — in 7.4." Now we build it: a consumer that sends the email only once even if it gets the same job ten times — and exactly where even that can break. Along with it, the rest of retry's questions: when not to retry, up to how many times, and how, when everyone retries together, you knock over your own provider (a retry storm); what to do with the list of failed jobs — the dead letter queue; and when the backlog really is growing without bound, the way to tell the producer "stop" — backpressure.
