# Module 7 — Exit Challenge (Asynchronous Processing & Messaging)

**Module 7 — Asynchronous Processing & Messaging**

Module 7's six lessons are done — why synchronous work drags a system down, queue vs pub/sub vs log, BullMQ jobs and their lives, idempotency and retry and DLQs and backpressure, events and the outbox, and finally batch vs stream and OLTP vs OLAP. In each lesson we measured one question on its own. In real life, in a bad month, everything comes at once — and one mistake often hides another. This Exit Challenge is that kind of month.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow has had a bad month. You've been handed the whole month's incidents for an incident review. The current state of TaskFlow's async parts (some decisions follow this module's lessons, some don't):
>
> - **Webhooks:** `task.completed` webhooks for enterprise customers — an engineer, "so the customer gets it immediately", sends them **inside the HTTP route** for task completion, `await`ed, with a 10-second timeout, before the database transaction ends.
> - **BullMQ:** a single queue, `notifications` — mention emails, password resets, daily digests, and the month-end **invoice PDF** (building the PDF takes ~40 seconds, with a synchronous library). One worker process, `concurrency: 50`, `lockDuration` default (30 s). Retry: `attempts: 10` on every error, `backoff: { type: 'fixed', delay: 2000 }`. Job IDs default (BullMQ's increasing number).
> - **CSV import:** when a customer imports 100 thousand tasks, one "assigned" email job per task — into that same `notifications` queue.
> - **Events:** every write route writes to the outbox (as in 7.5). Relay: **two** relays for high availability, both reading with `SELECT … WHERE id > :last ORDER BY id LIMIT 100`, keeping `last` in Redis. Consumers: notification, search, analytics, Slack — Redis Streams consumer groups.
> - **The notification consumer's dedupe:** it keeps the Redis Stream entry ID (like `1735689600000-0`) in a `processed` set; skips it if it's already there.
> - **Analytics:** finance's Metabase dashboard goes directly to the **primary** Postgres. Product's live "completed tasks per hour" dashboard is on the stream, counting by **processing time**.
>
> **The month's incidents:**
>
> 1. **The 3rd:** one enterprise customer's webhook server is slow (~8 seconds per call). That morning, not just that customer's — **every** customer's task completion is slow, and opening the board and logging in give `503`. Database CPU is 10%.
> 2. **The 1st (month-end invoices):** 37 customers got two invoice emails each, and 12 invoice jobs are `failed` — with the reason `job stalled more than allowable limit`. At the same time, mention emails are about a minute late each.
> 3. **The 11th:** a customer imported 100 thousand tasks. For the next 45 minutes nobody got a password reset email; a flood of tickets to support.
> 4. **Every day at 9 a.m.:** at digest time the provider returns `429`, and on the 15th the provider blocked TaskFlow's account for 20 minutes.
> 5. **The search team's report:** roughly 0.3% of comments never show up in search. The comment is in the database, its row is in the outbox, there's no `published` mark — but the relay's `last` passed its id long ago.
> 6. **The 20th, after a relay deploy:** a few hundred users got the same mention email twice — even though the notification consumer has dedupe, and the log shows the dedupe running correctly.
> 7. **The 24th:** the event pipeline was stuck for 40 minutes. On the live dashboard that period is almost zero, then a jump. The billing team asked whether this dashboard's numbers can be used to estimate this month's usage.
> 8. **Every Monday at 10 a.m.:** as soon as finance opens Metabase, the board's p99 goes up tenfold.
> 9. **A new architect's proposal:** "Move everything to Kafka — drop BullMQ, Redis Streams, all of it. Kafka has exactly-once semantics, so the duplicate problem is completely over, and there's no more hassle with retries either."

Your task — for each question below, apply Module 7's concepts (and earlier modules' where relevant) to make a decision, with your reasoning. Wherever possible, give **numbers**.

**1. A slow webhook, and `503` for everyone (Lesson 7.1)**
How did one customer's slow server bring down everyone's login — the critical path, the shared resource (which one?), and a number from Little's Law (say 10 task completions per second, 10 connections in the pool, and 8 seconds inside the transaction). "Cut the timeout from 10 to 2 seconds" — why isn't that enough? Your solution: where will webhooks go, which queue, and what will stop one customer's dead server from holding up other customers' webhooks?

**2. Two invoices and stalled jobs (Lesson 7.3 + 6.1)**
A 40-second synchronous PDF and a 30-second lock — draw on a timeline what happened. Why were not just the invoices but **the other 49 running jobs on the same worker** affected too, and why were mention emails late? Why are 12 `failed` because of `maxStalledCount`? Give three changes — to the structure of the worker/processor, to how queues are split, and to the invoice email's idempotency (which key, where).

**3. The 100 thousand import and 45 minutes of password resets (Lesson 7.4 + 7.1)**
Calculate the backlog: 100 thousand jobs, `concurrency: 50`, ~200 ms per email — how long until the queue is empty, and where does a password reset stand in the meantime? Your calculation doesn't match 45 minutes — which other incident of the month could make this delay even longer? What kind of problem is this (burst or sustained)? At least three solutions — one in the structure of the queues, one in the design of the import itself (are 100 thousand separate emails really needed?), and one on backpressure/priority.

**4. The 9 a.m. `429` (Lesson 7.4)**
"10 times on every error, fixed 2 seconds" — find three separate mistakes in this policy (which errors, how it waits, where the limit is). Write down the sequence in which the retry storm happens. To never send the provider more than 300 again (say its limit is 100/s), what will you put in place — which BullMQ option, which change to the cron, and which header on the `429`?

**5. 0.3% of comments never reach search (Lesson 7.5)**
With the relay's `id > :last` and two relays — on exactly what timeline is an outbox row skipped forever? (Id assignment vs commit order.) If `last` is shared between two relays, what else goes wrong (sent twice, order)? What will the fixed relay look like? And the 0.3% that have already been skipped — how will you recover them now, safely, without fear of duplicates?

**6. Duplicates despite dedupe (Lesson 7.4 + 7.5)**
What happened at the moment of the relay deploy (at which step must the relay die for the same event to go again)? Why couldn't dedupe by stream entry ID catch it? Which key should the dedupe have used — the event's `eventId`, or the effect's identity (`mention:{commentId}:{userId}`)? In what situation does the difference between the two matter? And where should the `processed` set live, and in what order relative to sending the email should it be written (which of 7.4's six techniques)?

**7. The 40-minute hole and billing's question (Lesson 7.6)**
The dashboard's hole and jump — the cause in one sentence. What would have changed if it counted by event time — and how much watermark lateness would have caught this 40-minute backlog (and at what price)? Answer billing's question: can usage be estimated with this number? If not, where, how and when will usage be calculated?

**8. Monday at 10 a.m. (Lesson 7.6 + 5.7)**
Where will you move finance's Metabase — a replica, a nightly export + DuckDB/Parquet, or CDC → a column store? For each: how stale the data is, the impact on production, and what new things have to be run. Which at TaskFlow's size, and what will you tell finance about their numbers now being "as of yesterday"?

**9. "Everything on Kafka" (Lesson 7.2 + 7.4 + 7.3)**
Which part of the proposal is right, and which is wrong? (a) In what scope does Kafka's "exactly-once semantics" actually work — and do the duplicates of TaskFlow's mention email (an external provider) go away with it? (b) What happens if you put BullMQ's jobs (per-job retry, delay, DLQ, separate priorities) on Kafka's log — head-of-line blocking, poison messages. (c) Given TaskFlow's size (a few hundred thousand events a day) and the team's size, your recommendation in one paragraph — what moves to Kafka (if anything), what stays, and which number would change the decision.

**10. The design doc and priorities (Lesson 7.1–7.6)**
(a) A one-page design doc for TaskFlow's async architecture: a list of every message (at least eight) — "task" or "news", which path it goes along (which BullMQ queue, or a stream), the key, the retry policy, the idempotency technique, who looks at the DLQ, and whether it gets shed under overload.
(b) A **priority list**: what this week (before it happens again), what this month, what this quarter — beside each, which lesson, and how you'll measure success (which metric, which number).

**Things to remember:** in this module there are three places where it's easiest to go wrong — (a) **thinking async means safe** — moving work into a queue isn't enough; a shared queue, shared workers, one event loop — cascading failure comes back in a new place; (b) **believing in "exactly once"** — in the name of a broker, a library or a tool; everything is at-least-once, and exactly once comes only from an idempotent effect; (c) **writing to two systems together** — the database and the broker, the broker and a cursor, the email and "I sent it" — every such gap will go wrong in one direction or another. All three are in today's scenario, several times over. And Module 7's most important habit: for every async flow, ask — **"if the process dies right after this step, what is lost, and what happens twice?"** If the answer is "I don't know", that's the next piece of work.

I'll critique this step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

- [ ] I can state the difference between "synchronous" in system design (the answer waits for the work to finish) and JavaScript's `await`; I can draw a request's critical path and calculate latency (sum) and availability (product)
- [ ] I can show, with numbers from Little's Law, how a slow dependency causes cascading failure through a shared resource (a pool, workers, a queue)
- [ ] I can decide with four questions which work stays on the request's path and which moves off it; I know the difference between fire-and-forget, an in-memory queue and a durable queue; I know a queue doesn't create capacity
- [ ] I recognise any messaging system by three questions (who gets it, whether it stays, in what order); I can give the separate answers for a queue, pub/sub and a log; I can choose between RabbitMQ, Kafka, Redis Pub/Sub and Redis Streams per message
- [ ] I can draw consumer groups, partition keys and order; hot partitions; head-of-line blocking on a whiteboard
- [ ] I can draw a BullMQ job's life (waiting, delayed, prioritized, active, completed, failed, stalled); I can say what happens when the API, the worker or Redis dies; why the queue's Redis is `noeviction` + AOF and separate from the cache
- [ ] A job lock is a lease — what happens when the event loop is blocked (6.1's pause), and its three remedies; graceful shutdown and the grace period
- [ ] Idempotent consumers: I can say which crash point or race breaks each of the six techniques; why the dedupe key comes from the effect's identity; where the gap gets closed (the provider's key, the same transaction)
- [ ] Retry: transient vs permanent, at one layer, bounded in time; the difference between exponential backoff and jitter — where a retry storm comes from, with numbers
- [ ] Poison messages, the DLQ and the rules of redrive; backpressure vs load shedding; a queue absorbs a burst but doesn't fix sustained overload — limit = wait × rate
- [ ] Event vs command; choreography's benefits and price (invisible flow, chains); how much data in an event (notification, state transfer, sourcing)
- [ ] Why dual write isn't fixed by any order; I can build a transactional outbox (`SKIP LOCKED`, a flag not a cursor, small batches, cleanup); polling vs CDC; the event's contract (eventId, occurredAt, version, additive changes)
- [ ] OLTP vs OLAP; why analytics doesn't belong on production; why row stores and column stores are so different
- [ ] How I'd choose between batch and stream; event time vs processing time; windows, watermarks, the three policies for late data — and which mistake is never fixed

---

## 3. Recommendation

**To read:**

- **Martin Kleppmann — _Designing Data-Intensive Applications_.** This time the last three parts: chapter 11 of the first edition ("Stream Processing" — 7.2's log, 7.5's CDC and event sourcing, 7.6's event time and windows — all in one place), chapter 10 ("Batch Processing"), and the "Column-Oriented Storage" part of chapter 3 (7.6). Chapter numbers may have changed in the new edition — search by name.
- **Jay Kreps — "The Log: What every software engineer should know about real-time data's unifying abstraction" (2013).** By one of Kafka's creators; why 7.2's log is a fundamental idea — from the database's WAL to stream processing. Long, but the whole story of the module in one place.
- **Gregor Hohpe and Bobby Woolf — _Enterprise Integration Patterns_.** Old (2003), but the names of messaging come from here: competing consumers, dead letter channel, idempotent receiver, message router. Its website has short descriptions of the patterns — worth keeping as a reference.
- **AWS Builders' Library — "Timeouts, retries, and backoff with jitter" and "Avoiding insurmountable queue backlogs".** 7.4's retry storm and 7.1/7.4's backlog — written from the experience of running them at large scale. Also Marc Brooker's "Exponential Backoff And Jitter" (AWS Architecture Blog).
- **Martin Fowler — "What do you mean by 'Event-Driven'?" (2017)** and **the "Transactional outbox" pattern on Chris Richardson's microservices.io.** 7.5's two sources, short and clear.
- **Tyler Akidau — "Streaming 101" and "Streaming 102" (O'Reilly articles), and the book _Streaming Systems_.** Event time, processing time, watermarks, windows — 7.6's ideas, explained by the person who popularised them.

**To watch:**

- **Martin Kleppmann — "Turning the database inside-out" (conference talk).** What architecture looks like when you take the replication log out of the database and make it an event stream — the philosophical side of 7.5's CDC.
- **The "Guide" section of BullMQ's documentation** — its own explanations and examples of every option in 7.3 and 7.4 (retry, backoff, rate limit, sandboxed processor, stalled jobs). Read it for your version — the options change.

**For a project:**

- **TaskFlow's notification pipeline, end to end:** Express route → outbox (the same transaction) → relay (`SKIP LOCKED`) → Redis Stream → notification consumer (idempotent by eventId, claim + status in `sent_notifications`) → BullMQ job (job ID from the effect's key, exponential + jitter, DLQ on permanent errors) → a fake provider (with idempotency key support). Then a **chaos test**: a script that `SIGKILL`s any process at random moments, and reconciles at the end — did every comment's mention email go exactly once? All the exercises of 7.3–7.5 in one place.
- **Your own small stream processor:** read `task.completed` from a Redis Stream and count it in event-time hourly windows, with a watermark and lateness, upserting the result into a Postgres table (with corrections). Then create an outage like 7.6's exercise (by stopping the consumer) — does a hole appear in the graph?
- **A nightly analytics export:** the previous day's `task_events` from a replica into Parquet files (a folder per day), and finance's monthly report with DuckDB. Who finds out if the job fails — with a small alert.

---

Do the exit challenge and send it over. When you are ready, write `next` and we'll move to **Module 8: Storage Systems** — starting with Lesson 8.1: how Object / Blob storage (S3-style) works, and when you need it.

Across Module 7, data meant small things — a row, a message, an event, a few hundred bytes. But TaskFlow's users give us files too: task attachments, screenshots, design PDFs, now and then a video of a few GB. These can't be kept in the database (why is the first question), can't be sent through a queue — so where? And what happens if the network drops halfway through uploading a 1 GB file? Module 8 has that answer — and much of this module (async processing, idempotency, events) will be useful again there: when a file is uploaded, building thumbnails, virus scanning, the search index — all events and background jobs.
