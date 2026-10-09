# Lesson 7.1 - Why a System Dies When Everything Is Synchronous: Async Thinking

**Module 7 - Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 1.5):** TaskFlow's SLO is 99.9%. How many minutes of error budget is that in a 30-day month? Today you'll see that however many external services sit on a request's path, this budget gets shared among all of them - whether you want it to or not.

**Prerequisite:** Lesson 1.5 (Latency, availability), Lesson 2.5 (Idempotency), Lesson 5.5 (Transactions), Lesson 5.6 (Connection pool, pool exhaustion, Little's Law), Lesson 6.1 (Partial failure, a timeout means "I don't know")

**By the end of this lesson you will be able to:**

1. Draw a request's **critical path**, and calculate how each synchronous dependency on that path adds latency and multiplies availability down
2. Explain how one **slow** dependency (not dead, just slow) takes over a shared resource (the connection pool) and brings down the whole app - with numbers, using Little's Law
3. Decide with a list of questions whether a piece of work stays inside the request or moves out of it; and say what fire-and-forget, an in-memory queue and a durable queue each solve - and what they **don't**

**Tier:** 1 - Runnable Code (three real Node processes: a fake email provider, four versions of the TaskFlow API, and a load generator)

---

## 0. Where TaskFlow Is Right Now

At the end of Module 6, TaskFlow looks like this: 6 Express instances behind Nginx, a Redis cache, a PostgreSQL primary + 3 read replicas, failover with Patroni + etcd. The consistency design doc is written, and the reminder job is protected by a fencing token.

The product team's new request is one of the most ordinary requests there is: **"When someone is assigned a task, send them an email."**

The work is done in one afternoon. The code is clean, typed, and everyone is happy in review:

```typescript
router.post(
	'/tasks/:id/assign',
	async (req: Request<{ id: string }>, res: Response<AssignResponse>): Promise<void> => {
		const { assigneeId } = assignSchema.parse(req.body);
		const task = await sequelize.transaction(async (t) => {
			const task = await Task.findByPk(Number(req.params.id), {
				transaction: t,
				lock: t.LOCK.UPDATE
			});
			if (!task) throw new NotFoundError('task');
			const assignee = await User.findByPk(assigneeId, { transaction: t, rejectOnEmpty: true });
			await task.update({ assigneeId }, { transaction: t });
			await Activity.create({ taskId: task.id, kind: 'assigned' }, { transaction: t });
			// if the email fails, the whole transaction rolls back - "all of it, or none of it"
			await mailer.send({
				to: assignee.email,
				template: 'task-assigned',
				data: { taskId: task.id }
			});
			return task;
		});
		res.json({ taskId: task.id, assigneeId });
	}
);
```

Why is the email inside the transaction? The author's reasoning sounds good: "if the email doesn't go, the assign doesn't happen either - atomic." (The reasoning is actually wrong - why, in 1.4.)

For three weeks everything is fine. Then one Monday, 10:02 a.m. A yellow line on the email provider's status page: _"Degraded performance - elevated API latency."_ Their API hasn't died - it's just answering in 4 seconds where it used to answer in 150 ms.

At 10:03 TaskFlow's on-call engineer's phone is ringing. But the alert isn't about email - the alert says: **the dashboard isn't loading, the task list isn't coming, login is failing.** The whole app is down.

What the monitoring showed was the most confusing part:

- CPU on the Express instances: 12%. The event loop isn't blocked.
- Postgres CPU: 8%. No slow queries.
- The log is full of one single error, from **every** route: `ConnectionAcquireTimeoutError`.

And a different kind of ticket in support: _"I assigned it, it showed an error. I did it again. Now the assignee says they got two emails."_

In the post-mortem someone said: "The email provider got slow, and our whole app went down. We were **only** sending an email."

This lesson's question is that word "only". In the exercise we'll build that Monday exactly - then three more versions of the same feature, and see where the damage lands in each.

---

## 1. Theory

### 1.1 Synchronous means "waiting" - and waiting isn't free

First let's pin down two words, because for people who write `async`/`await` in JavaScript they're confusing.

**Synchronous processing** - the one who asked for the work (the caller) waits until it has the result of the finished work in hand, then moves on.

**Asynchronous processing** - the caller hands the work off somewhere and moves on immediately; the work is done later, by someone else, at another time.

Notice: code with `await mailer.send(...)` in it is "async" in Node.js terms - it doesn't block the event loop, other requests run while it waits. But **in system design terms it's synchronous**, because the HTTP request stays open until the email is done, and the user sits waiting for their answer. In this lesson "synchronous" always means the second: **does the request's answer wait for this work to finish?**

Monday's biggest confusion comes from right here: "the event loop wasn't blocked, CPU was 12% - so why did the app die?" Because waiting doesn't eat CPU, but it **holds on to other things**. As long as a request is open, it occupies:

```
  What one open request holds on to
  ──────────────────────────────────
  • the TCP connection with the client (and two connections on either side of Nginx - 3.3)
  • memory: request, response, closures, buffers
  • a database connection - if the wait is inside a transaction   ← Monday
  • row locks - the lock from `SELECT … FOR UPDATE` until the transaction ends
  • the user's patience - after 5–10 seconds they give up, or hit refresh
```

The scarcest of these is the database connection - there are only a handful in the pool (Lesson 5.6). And that's what ran out on Monday.

### 1.2 Critical Path - every step adds latency and multiplies availability

**Critical path** - the sequence of steps that **must** finish before a request can be answered. The answer's latency is the sum of the steps on this path, and the probability the answer succeeds is the product of the probabilities that each of them succeeds.

The assign route's critical path:

```
  client ──► Nginx ──► Express ──► Postgres (lock + update + insert) ──► Email API ──► COMMIT ──► answer
              ~1 ms      ~1 ms              ~5 ms                        150 ms         ~1 ms
                                                                         ▲
                                                            90%+ of the whole path's time is here
```

**Latency adds up.** On a normal day the email provider is the slowest step on the path - 150 ms out of assign's ~165 ms. And on Monday it's 4000 ms. The step that isn't under your control is the one setting your p99.

**Availability multiplies.** Let's start with the answer to today's spaced repetition question: a 99.9% SLO means 43.2 minutes of error budget in 30 days. Now suppose (example numbers, not any particular vendor's) the Postgres cluster is 99.95% available, and the email provider 99.9%. Both are on the same request's path, synchronously - so assign succeeds only when **both** are fine at the same time:

```
  0.9995 × 0.999 = 0.9985   →   99.85%   →   ~65 minutes of failure a month

  Your whole budget is 43.2 minutes. The email provider alone can eat 43 minutes on average -
  without a single bug in your own code.
```

Add one more dependency to the path (say a Slack webhook, 99.9%) - 99.75%, ~108 minutes a month. Every synchronous dependency multiplies your availability by its own availability, and multiplying by a number smaller than 1 can only make it smaller.

This has a name:

**Temporal coupling** - two parts joined in such a way that for one to succeed, the other has to be alive and fast **at exactly the same time**.

The assign route and the email provider are temporally coupled: the provider's bad 5 minutes are TaskFlow's assign's bad 5 minutes. But ask the question - **at the moment of assigning, does the email really have to go right then?** If the assignee gets the email 30 seconds later, will anyone notice? No. So this coupling didn't come from a need; it came from the way the code was written.

### 1.3 Cascading Failure - how a slow dependency kills other routes

Now the real mystery of Monday: the task list route doesn't touch email at all, so why did it die?

The answer is Lesson 5.6's Little's Law - **average work in progress = work arriving per second × time per piece of work.** Here "work" means an assign request holding one of the pool's connections. The exercise's load: 20 assigns per second, 10 connections in the pool.

```
  normal day:  20 assign/s × 0.17 s  =  ~3.4 connections always busy   (out of 10 - comfortable)
  Monday:      20 assign/s × 4.0 s   =   80 connections needed         (there are 10)
```

80 needed, 10 available. The other 70 assign requests stand in line. And the line isn't just for assigns - **there's one pool**, so every task list request (which needs a connection for just 5 ms) stands in that same line, behind the assigns. Only 10 ÷ 4 = 2.5 assigns per second are coming out of the pool now; 20 assigns + 50 lists are going in. The line gets longer every second. After 3 seconds in line (the `acquire` limit) a request comes back with an error - assign or list alike.

```
                      ┌──────────── connection pool (max 10) ────────────┐
   assign ──┐         │  [assign ⏳4s] [assign ⏳4s] [assign ⏳4s] …       │──► email API (slow)
   assign ──┤         │  all 10 held by assigns, all waiting on email    │
   list   ──┼──► line │                                                  │
   login  ──┤   (200+)└──────────────────────────────────────────────────┘
   list   ──┘     │
                  └──► after 3 s: ConnectionAcquireTimeoutError - on every route
```

This is Monday's log: the same error from every route, while the CPU sits idle. Nobody is working - everyone is waiting, and the place to wait has run out.

**Cascading failure** - a problem in one part (here the slow email provider) spreads through some shared resource into parts that have no direct relationship with it.

The `sync-in-tx` mode in the exercise's `npm run compare` - exactly the code above:

```
── mode: sync-in-tx ────────────────────────────────────────
   phase            assign p50 / p99   assign failed    list p99   list failed
   normal            168 ms / 195 ms              0%       27 ms            0%
   provider slow      3.0 s / 5.0 s              57%       3.0 s           52%
   after recovery    168 ms / 1.4 s               0%       1.2 s            0%

   assign: ok 387, failed 91  (pool exhausted 81, client timeout 10, other 0)
   list:   failed 207 / 1188   ← this route never touches email
     max pool queue: 210
   told "failed", yet email sent: 10
```

(The script prints its labels in Bangla; the output shown in this edition is translated - the numbers are identical.)

Look at three things:

1. **Half of the list requests failed** - 207 of them - while list's code doesn't even mention email. List's p99 went from 27 ms to 3 seconds, which is exactly the `acquire` limit: it didn't get slow by working, it got slow by standing in line.
2. **The scar remains after recovery** - even in the phase after the provider recovered, list's p99 is 1.2 seconds. The requests piled up in the line have to get out first. One trait of cascading failure: the effects stay for a while even after the cause is gone.
3. **"Told 'failed', yet the email went: 10"** - that Monday ticket. The client gave up at 5 seconds, but the server doesn't know the client has left; it kept holding the connection, sent the email, then committed. The user saw an error and pressed again - two emails. Exactly what Lesson 6.1 said: **a timeout doesn't mean "failed", a timeout means "I don't know".**

**"Why not just make the pool bigger?"** - The exercise's experiment 4: with `POOL_MAX=100` the list survives. But remember Lesson 5.6's arithmetic: 6 instances × 100 = 600 connections, and Postgres's `max_connections` is 100. And each connection is now a 4-second **open transaction** - with the `FOR UPDATE` row lock. Anyone else who wants to touch that task is also stuck for 4 seconds. Enlarging the pool pushes the problem from the pool into the database; and if the provider is 40 seconds slow instead of 4, 100 will run out too. When the "time" in Little's Law can be unbounded, no finite pool is enough.

(A side note: in Node.js there's another kind of slow work besides "waiting" - **CPU work**: building a big PDF, resizing an image, a huge `JSON.parse`. These don't wait, they block the event loop - and then every request in the process really does stop, like Lesson 6.1's process pause. The direction of the fix is the same: move the work off the request's path, into a separate worker process.)

### 1.4 The first three attempts - and where each gets stuck

Three proposals came up in the post-mortem. Each is partly right - and each was measured in the exercise.

**Attempt 1 - Put a timeout on the email.** With a 1-second timeout on `fetch`, a connection is held for at most 1 second, and the cascading shrinks. But then when the provider is slow, **the assign fails** - a user couldn't assign a task because another company's email server was slow. And after the timeout, whether the email went is once again "I don't know". The exercise's experiment 5 puts exactly this in (1 second): list's failures drop from 52% to 18% - lower, not zero, because by Little's Law 20/s × 1 s = 20 connections are still needed, and there are 10. And 80 users saw an error on assign while their email arrived just fine - our timeout stops our waiting, not the provider's work. Timeouts are necessary (no external call should be left without a timeout - and `fetch`, axios and most SDKs have **no** timeout by default) - but this makes the damage smaller, it doesn't remove it.

**Attempt 2 - Commit first, then email.** This is a genuine improvement, and it's where the real mistake of "the email inside the transaction" shows. The reason for putting it inside was "atomic". But think: the email **went out**, then `COMMIT` failed (a deadlock, a failover, anything). The transaction rolled back - the assign didn't happen - but the email can't be taken back. A database transaction can only undo database things; not something sent out into the outside world. So the "atomic" was never really there - the connection was just being held longer.

Sending the email after the commit returns the connection in 5 ms - `sync-after-commit`:

```
── mode: sync-after-commit ─────────────────────────────────
   phase            assign p50 / p99   assign failed    list p99   list failed
   normal            168 ms / 186 ms              0%       26 ms            0%
   provider slow      4.0 s / 4.0 s              37%       27 ms            0%
   after recovery    165 ms / 184 ms              1%       26 ms            0%

   assign: ok 417, failed 61  (pool exhausted 0, client timeout 0, other 61)
   list:   failed 0 / 1187
   provider returned 429 (rate limited): 61
```

List **survived completely** - 0 failures, p99 27 ms. The cascading failure is over, because the slow dependency no longer holds a shared resource. But look at assign's own state: in the slow phase every assign takes 4 seconds, and 37% fail. Why do they fail? 20 assigns per second × 4 seconds = 80 emails at the provider at once - and the provider doesn't accept more than 50 at a time (like a real provider's rate limit; in the exercise this limit is an assumed number). The extras get `429`.

And the worst part: those 61 "failed" assigns actually **happened** - the commit came first. The user saw an error, but the task is now assigned. The temporal coupling is still there, it's just moved from the database into the user's experience. (Experiment 3: if the provider is 6 seconds slow - more than the client's 5-second timeout - assign shows **100%** failure in the slow phase, while 159 people's emails went out just fine.)

**Attempt 3 - Don't wait at all: fire-and-forget.**

**Fire-and-forget** - work is started and nobody waits for its result, and if the work fails, nobody even knows.

```typescript
await task.update({ assigneeId });            // commit
void mailer.send({ to: assignee.email, … });  // started it - won't look at the result
res.json({ taskId: task.id, assigneeId });    // answer immediately
```

`fire-and-forget`:

```
── mode: fire-and-forget ───────────────────────────────────
   phase            assign p50 / p99   assign failed    list p99   list failed
   normal             10 ms / 27 ms               0%       26 ms            0%
   provider slow      11 ms / 25 ms               0%       27 ms            0%
   after recovery     11 ms / 24 ms               0%       26 ms            0%

  max concurrent at provider: 50
   provider returned 429 (rate limited): 60
   told "ok", email never sent: 61
```

It looks perfect: assign is always 10 ms, nobody saw a single error. But read the last line - **60 users were told "succeeded", and their assignees never got an email.** And nobody knows. No error page, no alert, just a `.catch(() => {})` that silently swallowed it.

There are two problems, and both are structural:

- **There's no limit.** Every request starts a new email, as fast as requests arrive. When the provider slows down, the number of emails in flight keeps growing by Little's Law (20 × 4 = 80) - and at 50 it hits the provider's wall. If the provider hadn't stopped it, your process's memory would have.
- **There's no memory.** The email that failed isn't written down anywhere to be tried again. If the process dies (a deploy, a crash), whatever hadn't started just vanishes.

Fire-and-forget did one thing right: it freed the user from waiting. But it didn't give **responsibility** for the work to anyone.

### 1.5 Job Queue - write the work down, someone will do it later

The fourth version is the answer to exactly fire-and-forget's two problems: a limit, and memory.

**Job queue** - a list where "work that needs doing" is written down. The one who writes it is called the **producer** (here the API), and the one who takes it from the list and actually does the work is called the **worker** (or consumer). Producers and workers run at different speeds.

```
                   the request's path (critical path)                │   off the request's path
                                                                     │
  client ──► Express ──► Postgres (update + commit) ──► queue.add() ──► answer (10 ms)
                                                          │          │
                                                          ▼          │
                                               ┌─────────────────┐   │
                                               │ job │ job │ job │ … │  ← backlog
                                               └────────┬────────┘   │
                                                        ▼            │
                                           worker × 8 (at most 8 at once) ──► email API
```

The assign route now just writes down an "intent to do work" and answers. Sending the email is the worker's responsibility, and workers do a **fixed number** of jobs at a time - 8 here, however slow the provider is. `queue`:

```
── mode: queue ─────────────────────────────────────────────
   phase            assign p50 / p99   assign failed    list p99   list failed
   normal             11 ms / 27 ms               0%       27 ms            0%
   provider slow       9 ms / 26 ms               0%       26 ms            0%
   after recovery   9 ms / 26 ms            0%       27 ms          0%

   emails pending (max): 152  max concurrent at provider: 8
   provider returned 429 (rate limited): 0   email delivery (from assign) p99: 7.6 s
   told "ok", email never sent: 0
```

Assign is 10 ms, list is untouched, the provider never saw more than 8 at once, so there's not one `429`, and **not a single email was lost**. So where did the damage go? Because the provider really was 4 seconds slow - that time has to be paid somewhere.

The answer is in two numbers - `emails pending (max): 152` and `email p99: 7.6 s`.

**Backlog** - the amount of work piled up in the queue that hasn't started yet. If work arrives faster than workers finish it, the backlog grows; the other way round, it shrinks.

Work it out by hand, Little's Law turned around - how many workers can finish per second:

```
  slow phase:   8 workers ÷ 4 s     =   2 emails/s go out,  20 arrive  →  backlog +18/s × 8 s  ≈  144
  recovered:    8 workers ÷ 0.15 s  ≈  53 emails/s go out,  20 arrive  →  backlog −33/s  →  empty in ~5 seconds
```

The measured 152 is close to the calculated 144 (the rest is time at the phase's edges). The damage wasn't lost - **it moved from the user's latency into the backlog and delay**. Someone who assigned at the end of the slow phase had their assignee get the email ~7 seconds later, instead of 150 ms. And this is the core trade of the whole lesson: **instead of making the user wait, make the work wait.** For email this is clearly a good trade - nobody even notices a 7-second-late email, but everyone notices a 4-second assign button.

The queue separated two things that were one in the synchronous code:

- **The speed of taking work** (the API, at the speed of requests) and **the speed of doing work** (the worker, at the speed of the downstream). In between, the queue is a buffer - it absorbs waves of load.
- **Success for the user** ("assigned") and **success of the work** ("email delivered"). The first right now, the second "later, but for certain".

**But a "queue" isn't magic - two warnings, both measured in the exercise.**

**First: a queue doesn't create capacity.** Experiment 1: `WORKERS=2`. Now even on a normal day 2 ÷ 0.15 ≈ 13 emails/s go out, and 20 arrive. The backlog grows **from the very first second** - even without a slow phase. Measured: backlog 265, email p99 ~20 seconds, and unbounded if the load keeps going. A queue only evens out differences in time (more now, less later); if on average the workers are slower than the arrivals, a queue is a slow death, just out of the user's sight. That's why a queue's most important metrics in production are: **the size of the backlog, and the age of the oldest job.** (The technique for stopping an unbounded backlog - backpressure - is in Lesson 7.4.)

**Second: this queue is in memory.** Experiment 2: `CRASH_AT_MS=14000` - in the middle of the slow phase the API process is `SIGKILL`ed (like any deploy or crash), and a new process starts:

```
    14.0 s  API process SIGKILL - deploy/crash; starting a new process
   …
   told "ok", email never sent: 103
```

103 users saw "succeeded"; their jobs were in line in the process's memory; they vanished along with the process. Fire-and-forget's "no memory" problem, just bigger - because the queue now deliberately holds work. Lesson 3.4's graceful shutdown would have saved some (draining the queue before shutting down) - but not on a crash, an OOM kill, or a dead machine.

The fix: keep the queue **outside** the process, somewhere durable - Redis, RabbitMQ, Kafka, or a database table. Then even if the API process dies the jobs remain, and any worker (on any machine) picks them up. In the Node world the best-known form of this is BullMQ (on top of Redis) - the whole of Lesson 7.3. Which kind of queue is for which job is Lesson 7.2.

### 1.6 Which work stays on the request's path, and which moves out

Not all work can be made async, nor should it be. The **only good reason** to keep work on the request's path: the user's next step depends on this work's result. Four questions for each piece of work:

1. **Does the user want to see this work's result in the answer?** Whether the task was created, what its id is - yes. Whether the email went - no, they don't even know when it goes.
2. **If the work fails, does the user need to know right now so they can change something?** A validation error, no permission, card declined - yes. A search index update failed - no, we'll retry it ourselves.
3. **How long does the work take, and how uncertain is it?** A 5 ms indexed query - no harm on the path. A 30-second export, or an external API whose latency isn't in your control - move it off the path.
4. **Does the work depend on someone outside?** Every external dependency is one more number in 1.2's product. Keep it on the path and its bad day is your bad day.

Applied to TaskFlow:

| Work                                          | On path / off | Why                                                                                                                 |
| --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| The database write for task create/assign     | On path       | This is the user's result; if it fails they must be told                                                            |
| Permission check, input validation            | On path       | If it fails the user will change something; and it's fast, and ours                                                 |
| The assign email, push notification           | Off           | The user doesn't see when it goes; an external provider                                                             |
| Slack/webhook integration                     | Off           | Another company's server - don't let its latency and availability into your product                                 |
| Search index update (8.3), activity feed      | Off           | Fine if it shows up a few seconds later - though a user who can't find what they just wrote is confused (see below) |
| A CSV export of 50 thousand tasks             | Off           | 30+ seconds - in an HTTP request it hits Nginx/browser timeouts; a job + "we'll send a link when it's ready"        |
| Building an attachment's thumbnail            | Off           | CPU work - it blocks Node's event loop (1.3's note); a separate worker process                                      |
| The card charge for upgrading to the Pro plan | On path\*     | The user must know right now whether the card worked - but with a timeout and an idempotency key (2.5, 6.1)         |

\*Payment is a good example that the answer isn't always clear. The charge stays on the path because the user needs the result; but everything around it - the receipt email, the invoice PDF, the entry in the accounting system, the provider's later webhook - is off it. A feature is almost never entirely sync or entirely async; ask the question for each **step** separately.

**The price of async - the thing everyone forgets in interviews.** Moving work off the path doesn't come free:

- **"Done" now means "will be done".** If the search index is async, a user who creates a task and searches right away may not find it. This is Module 6's eventual consistency, in a new place - and 6.3's read-your-writes question comes back. The fix in the UI is often simple: show the user's own new thing on the client immediately, or a "processing…" state.
- **How will you report the result?** For long work (an export) the usual shape: answer the request with `202 Accepted` and a job id; the client asks for the status with that id (polling), or the server sends the news - Lesson 2.4's SSE/WebSocket.
- **A job can be lost, or run twice.** The worker sent the email, then died before writing "done" - another one will send it again. Durable queues usually give "at least once", not "exactly once". So every job has to be idempotent (Lesson 2.5, 6.1) - details in 7.4.
- **The database and the queue - writing in two places.** The assign committed, then the process died before writing the job to the queue - the assign exists, the email's job doesn't. In the opposite order: the job was written, the commit failed - an email will go for an assign that didn't happen. This problem of writing to two separate systems together is called **dual write**, and its well-known solution (the transactional outbox) is in Lesson 7.5.
- **Debugging is harder.** In synchronous code an error's stack trace tells the whole story. In async, the answer to "why didn't the email go" is spread across three processes and a queue - you need job ids, logs, and Lesson 10.4's tracing.

> **Trade-off Table - Five ways to send the assign email**

| Approach                      | Assign latency (when the provider is slow) | Other routes protected? | Load on the provider limited?  | Email lost (provider fails)                          | Email lost (process dies)        | Price                                                     |
| ----------------------------- | ------------------------------------------ | ----------------------- | ------------------------------ | ---------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| Sync inside the transaction   | Same as the provider, plus the pool's line | No - cascading          | Yes, but it spends the pool    | No, the assign fails too (or "don't know")           | No - the request shows as failed | The whole app's availability is in the provider's hands   |
| Sync after the commit         | Same as the provider                       | Yes                     | No                             | No - but the assign happens and still shows an error | No - the request shows as failed | Assign's UX is in the provider's hands                    |
| Fire-and-forget               | ~10 ms                                     | Yes                     | No - unbounded                 | **Yes, silently**                                    | Yes, whatever hadn't started     | Failures are invisible; no retry                          |
| In-memory queue + worker      | ~10 ms                                     | Yes                     | Yes - by the number of workers | No (if you add retry)                                | **Yes, the whole backlog**       | You have to watch the backlog; lost on deploy             |
| Durable queue (Redis/BullMQ…) | ~10 ms (+ writing to the queue)            | Yes                     | Yes                            | No - retry, DLQ (7.4)                                | No - the job stays in the queue  | New infrastructure; at-least-once, dual write, monitoring |

In practice the answer is almost always the last row - and the rest of the module is that row's details: which queue (7.2), how to build it (7.3), what to do on failure (7.4), and what happens when the queue stops being just "a list of work" and becomes "news of what happened" (7.5).

---

## 2. Interview Angle

**"When a user signs up, send a welcome email - design it."** - A small question, but the interviewer wants to see whether you move the email off the request's path on your own. A good answer's order: sign-up's database write sync → the email async, through a queue → why (keeping the provider's latency and availability out of sign-up's product; 1.2's arithmetic in one line) → why the queue is durable (so nothing is lost on deploy) → why the job is idempotent (no two welcome emails when the worker retries). Bonus: "what happens if there's a crash between the sign-up commit and writing the job?" - naming dual write and raising the outbox.

**"This service got slow, and the whole system with it - why might that be?"** - A cascading-failure question in disguise. A good answer looks for the shared resource: connection pool, thread pool, workers, memory. Then a number with Little's Law: "20 requests a second × 4 seconds = 80 at once; the pool is 10." The fix on three levels: move slow work off the path (async), timeouts on external calls, and separate the shared resources (a separate pool for slow work - Lesson 9.4's bulkhead).

**"Then why don't we just make everything async?"** - A trap question. The answer: because async has a price - eventual results, at-least-once and therefore idempotency, dual write, harder debugging, backlog monitoring. And a queue doesn't create capacity: if on average workers are slower than arrivals, the backlog grows without bound. Work stays sync if the user's next step depends on its result - 1.6's four questions.

**In real production:** behind almost every big web app there's a background job system - in the Ruby world Sidekiq (and before it Resque, built by GitHub), in Python Celery, in Node BullMQ, in Java various queue clients. And there are alerts on **two** metrics of a queue: the size of the backlog, and the age of the oldest waiting job. The second is more useful - a backlog of 10 thousand jobs can be fine if the oldest is 2 seconds old; a backlog of 10 jobs is danger if the oldest has been sitting there for an hour (the worker has died).

---

## 3. Key Takeaway

- In system design, "synchronous" means **the request's answer waits for the work to finish** - Node code with `await` is synchronous in this sense too. Waiting doesn't eat CPU, but it holds connections, locks, memory and the user's patience
- Every step on the **critical path** **adds** latency and **multiplies** availability down - a 99.95% database and a 99.9% provider on the path together give 99.85%, ~65 minutes a month
- **Temporal coupling**: for one to succeed, the other must be alive at the same moment. Ask - does this work have to happen **right now**?
- A slow dependency (not dead, slow) takes over a shared resource and causes **cascading failure** - Little's Law: 20/s × 4 s = 80 connections needed, there are 10; in the exercise, half of the list route (which never touches email) failed
- A timeout makes the damage smaller, not gone; sending after the commit saves the pool but the user still waits; **fire-and-forget** removes the wait but also removes the limit and the memory - it silently loses emails
- A **job queue** separates taking work from doing it: the user gets an answer in 10 ms, workers work at a fixed rate, and the damage moves into the **backlog** and delay. But a queue doesn't create capacity, and an in-memory queue loses its whole backlog on a deploy - you need a durable queue
- Keep work on the path only if the user's next step depends on its result; moving it off has a price - eventual results, at-least-once and therefore idempotency, dual write, harder debugging

---

## 4. New Terms (Glossary)

| Term                                      | Meaning                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Synchronous / Asynchronous Processing** | Sync: the caller waits until it has the result of the finished work; Async: the caller hands off the work and moves on, someone else does it later |
| **Critical Path**                         | The steps that must finish before a request is answered - latency is their sum, availability their product                                         |
| **Temporal Coupling**                     | A joining of two parts such that for one to succeed, the other must be alive and fast at exactly the same time                                     |
| **Cascading Failure**                     | A problem in one part spreads through a shared resource (pool, threads, memory) into parts that have no direct relationship with it                |
| **Fire-and-Forget**                       | Work is started and nobody waits for the result - if it fails nobody knows, and there's no written record of the work                              |
| **Job Queue (Producer / Worker)**         | A list of "work to be done"; the producer writes, the worker takes it and does it at its own pace (a fixed number at once)                         |
| **Backlog**                               | Work piled up in the queue that hasn't started yet - grows when arrivals outpace the workers, shrinks when they don't                              |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines for each in your own words.

1. TaskFlow's "comment on a task" route now does four things, all `await`ed, one after another: (a) write the comment to Postgres, ~5 ms; (b) email everyone `@mention`ed in the comment, ~150 ms each at the provider on average; (c) a webhook to the task's Slack channel, ~300 ms, availability say 99.5%; (d) a search index update, ~40 ms. Calculate the comment route's latency and availability (assuming the database 99.95%, the email provider 99.9%, search 99.9%) - for a comment that mentions 3 people. Then which work would you keep on the path and which would you move off, and after moving it, what are the latency and availability?
2. An engineer says: "We don't need a queue. Just do `setImmediate(() => sendEmail())` and the request returns immediately, and Node is a single process anyway - the email will go." Which part of what they said is right, and which is wrong? Name at least three situations where the email won't go - and in each, whether anyone will know.
3. On Black Friday one of TaskFlow's enterprise customers imported 200 thousand tasks at once; for each task an "assigned" email job went into the queue. There are 8 workers, each email ~150 ms. (a) How long until the last email goes? (b) Meanwhile what happens to every other customer's assign emails - and why? (c) What would you change?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Everything is sequential now, so latency adds up: 5 + (3 × 150) + 300 + 40 = **~795 ms** - and that's the average on a normal day; p99 is worse, because a bad moment in any one of the four steps is a bad moment for the whole request. Availability multiplies (the three email calls go to the same provider, so counting the provider once is reasonable - though each call can fail separately, which lowers the number further): 0.9995 × 0.999 × 0.995 × 0.999 ≈ **0.9925 → 99.25%** - about five and a half hours of failure a month, where the database alone would be ~22 minutes. Slack alone is eating the biggest share - another company's webhook.

Only (a) stays on the path - whether the comment was written is the user's result. (b), (c) and (d) all move off, as three separate jobs in the queue (or one "comment created" job that fans out into the three - the idea of 7.5's events). After moving them: latency ~5 ms + writing to the queue (one network round trip to a durable queue, say ~1–2 ms) ≈ **~7 ms**; availability ≈ the database × the queue's availability - the three external dependencies are no longer in the product. The price: your own comment shows up in the search index a few seconds later - and the dual-write question of "the comment was written, the job wasn't".

**Question 2:** The right part: the request returns immediately, and the event loop isn't blocked - the user's latency is fixed. The wrong part: "the email will go". This is really fire-and-forget, and here's where the email won't go:

- **A deploy or crash:** a new version is deployed, the old process shuts down - the emails sitting in `setImmediate`, or started and waiting for an answer, are gone. With an OOM kill or a dead machine there isn't even a graceful shutdown. Nobody will know.
- **The provider fails or rate limits:** the email gets a 500 or a `429` - there's no retry, because the work isn't written down anywhere. In the exercise, exactly 60. If there's a log in the `.catch`, maybe someone will see it in the logs later; the user and the assignee won't know.
- **The provider is slow and load is high:** the number of emails in flight grows without bound (Little's Law), the process's memory and outbound connections grow, it hits the provider's limit - and the extra emails fail (silently, for the reason above).
- Bonus: "Node is a single process" is itself a misconception - TaskFlow has 6 instances, and each can die separately.

The core point: `setImmediate` changes **when** the work happens, but doesn't give anyone **responsibility** for the work (writing it down, retrying on failure, how many at once).

**Question 3:** (a) 8 workers ÷ 0.15 s ≈ 53 emails/s. 200,000 ÷ 53 ≈ 3,750 seconds ≈ **~1 hour 2 minutes** - assuming the provider accepts this rate (in reality probably slower, due to rate limits). (b) There's one queue, FIFO - so after the import, any other customer's assign email is **behind** 200 thousand jobs. One customer's giant job delayed everyone's emails by an hour. This is the shape of cascading failure again - this time the shared resource is the queue and the workers. (c) Several approaches, together:

- **Separate queues or priorities:** emails from assigns done by hand go to a high-priority queue, bulk import emails to a separate low-priority queue, with separate workers - neither blocks the other (the idea of 9.4's bulkhead).
- **A per-customer limit (fairness):** a cap on how many of one customer's jobs run at once, so everyone gets a turn.
- **Change the work itself:** nobody wants 200 thousand separate emails. On a bulk import, one summary email per assignee ("430 tasks have been assigned to you") - a few hundred jobs instead of 200 thousand.
- **Monitoring:** an alert on the age of the oldest job - noticing in a few minutes, not an hour.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (three real Node processes)

> **Ready to run in the repo:** [`exercises/lesson-7.1-async-thinking/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.1-async-thinking) - `npm install`, then `npm run compare` (four modes in a row, ~1 minute 40 seconds) or `npm run scenario -- <mode>`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`provider` is a fake email provider (its latency can be changed; more than 50 at once gets a `429`), `api` is TaskFlow's Express API - four versions of the assign route, and a list route that never touches email - and `scenario` generates load, makes the provider slow partway through, then measures per phase. The connection pool is a small imitation of Sequelize's pool (max, a line, an `acquire` limit) - the database isn't real, because today's question is about **who holds** the pool, not about queries.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; `npm run compare` was run twice with the same shape (the numbers differ slightly - real processes, real timers; e.g. `sync-in-tx`'s list failures were 215 once and 207 once). All five of the README's experiments were run (number 5 by changing `api.ts`, then reverting it), and the numbers are in the README. The provider's "50 at once" limit is an assumed number - a real provider's limit differs by account and plan, and is usually expressed as "so many per second". (The scripts print their labels in Bangla; the output shown in this edition is translated - the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Guess first, then run:** **before** running `npm run compare`, guess and write down every cell of the four rows of the comparison table (which are zero, which are big). Then run it and compare. Which cell surprised you most, and why?

2. **Explain it with Little's Law:** why is list's p99 in `sync-in-tx`'s slow phase almost exactly 3.0 seconds - not 2.5 or 4? And work out the `emails pending (max)` number of `queue` mode by hand (like 1.5), then again with `WORKERS=2` (experiment 1) - why is the backlog growing **even in the normal phase**?

3. **Add a timeout** (experiment 5): add `signal: AbortSignal.timeout(1000)` to `sendEmail` in `api.ts`, then `npm run scenario -- sync-in-tx`. Did list survive? How many assign failures? And `told "failed", yet the email went` - what is that number saying now? In one line: what the timeout fixed and what it didn't.

4. **The in-memory queue's weakness** (experiment 2): run both `CRASH_AT_MS=14000 npm run scenario -- queue` and `CRASH_AT_MS=14000 npm run scenario -- fire-and-forget`. Which lost more emails, and why? (Hint: which one **holds** work, and which pushes all its work at the provider immediately - and what was the price of that?)

5. **Design part:** make a list of all of TaskFlow's routes (at least 8: create task, assign, comment, change status, attachment upload, CSV export, sign-up, Pro plan upgrade). For each: write down every **step** inside the route, and mark each step "on path" or "off" using 1.6's four questions. Then calculate each route's critical-path availability (with numbers you assume, but write them down). Finally two lines: how many different **kinds** of job will come into TaskFlow's queue, and will you keep them in one queue or separate ones (with question 3 in mind)?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (complete, including exit challenges)
Current: 7.1 - Async Thinking: why a system dies when everything is synchronous
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; decided to move assign/comment emails, the Slack webhook, the
search index and exports off the request's path; for now an in-memory job queue + 8 workers
(prototype) - the durable queue is still to come (7.3); timeouts on every external call
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog
Weak spots: [where you got stuck - fill this in yourself]
Next: 7.2 - Message Queue vs Pub/Sub: comparing RabbitMQ, Kafka, Redis Streams
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over - especially your Little's Law arithmetic in #2 and your list of routes in #5. When you are ready, write `next` - we'll go to Lesson 7.2: **Message Queue vs Pub/Sub - comparing RabbitMQ, Kafka and Redis Streams.** Today we called an array a queue, and saw it die on a deploy. When you go to choose a durable queue, the questions change: will one job go to just one worker, or will the email service, the search service and analytics - all three - want the same "comment created" news? Will a message be deleted after it's read, or stay, so that tomorrow a new service can come and read all the old news again? And order - will two events for the same task always arrive in the same order? The answers to these three questions are exactly the differences between the three tools.
