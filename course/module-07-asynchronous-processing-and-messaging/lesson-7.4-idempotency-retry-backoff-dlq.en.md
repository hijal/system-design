# Lesson 7.4 — Idempotency, Retry, Exponential Backoff, DLQ, Backpressure

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.5):** Two transactions run `SELECT … FROM sent_notifications WHERE key = 'X'` at the same time, both find nothing, then both `INSERT`. What happens under `READ COMMITTED`, what under `SERIALIZABLE` — and what one thing, if present, will stop one of the two whatever the isolation level? Today you'll see exactly this race in the shape of an email.

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 5.5 (Transactions, unique constraints), Lesson 6.1 (A timeout means "I don't know", fencing), Lesson 7.1 (Backlog, Little's Law), Lesson 7.2 (Ack, at-least-once), Lesson 7.3 (BullMQ, stalled jobs, retry, job ID)

**By the end of this lesson you will be able to:**

1. Make a consumer idempotent — and for any technique, say exactly which crash point or which race breaks it (lost, or twice)
2. Say which errors to retry and which not, for how long, at which layer — and show with numbers why exponential backoff needs jitter
3. Set these policies for each of TaskFlow's jobs: moving poison messages to a dead letter queue, and backpressure or load shedding when more work arrives than the consumer can handle

**Tier:** 1 — Runnable Code (four deterministic simulations — one counts every crash point and every interleaving)

---

## 0. Where TaskFlow Is Right Now

In Lesson 7.3 TaskFlow's email moved to BullMQ: a separate worker, jobs in Redis, retry and backoff, its own job IDs. Nothing is lost any more. In the first two weeks in production, three things happened:

1. **Mention emails twice.** We saw it in 7.3 itself: when a worker dies, its running jobs stall and run again. An engineer shipped a fix — look in the `sent_notifications` table before sending, skip if it's there. The duplicates dropped, but didn't stop. Someone else changed the order to "stop them completely" — write to the table first, then send. A week later, a ticket: _"I was mentioned in a comment, and got no email."_ In the log: a worker deploy at exactly that moment.
2. **Wednesday, 9 a.m.** The daily digest cron releases 40 thousand jobs at once. The provider's rate limit was exceeded, `429`. The retry was "again after 1 second" — so at 9:00:01 almost 40 thousand again, at 9:00:02 again. The provider's abuse detection blocked TaskFlow's account for 15 minutes. And in those 15 minutes, whoever asked for a password reset — their email didn't go either.
3. **Friday afternoon.** A broken email address in one project's data. Every job for that address fails — and just the week before, someone had made `attempts` infinite "so that nothing is lost". On Monday morning there were 50 thousand jobs in the queue, the workers busy most of the time with those broken jobs, and ordinary emails an hour late. No alert fired — because nothing had "failed", everything was just "retrying."

Behind all three incidents is one sentence that has come up again and again across Module 7: **failures will always happen — the question is what the system does after a failure.** Today, that "what it does" in five parts: idempotency (when it comes twice), retry and backoff (when it fails), the dead letter queue (when it will never succeed), and backpressure (when more arrives than can be handled).

---

## 1. Theory

### 1.1 Why "at least once" — and where "exactly once" comes from

The last three lessons in one paragraph: in 7.2 we saw that the ack and the work are two separate events, and a crash can always come in between — so the broker's choice is between lost (at-most-once) and twice (at-least-once). In 7.3 we saw BullMQ is at-least-once: 8 emails twice when a worker died, 9 when the event loop was blocked. And duplicates come from the producer's side too (a double click) — we stopped those with job IDs.

So a message comes to a consumer again in two ways:

```
  (a) one after another:  worker A did the work ──► ✗ crash (no ack) ──► the broker gave it again ──► worker B did the work
  (b) at the same time:   worker A is working (stuck, lost the lock) ─────────────────────────────►
                                     worker B picked up the same job ────────────────────────────►
```

Two different problems, and today you'll see that one technique often fixes one but not the other.

Then where does "exactly once" come from? Not from delivery — from **processing**:

```
   at-least-once delivery   +   idempotent processing   =   exactly-once effect
   (the broker gives it)        (your responsibility)       (what the user sees)
```

The user doesn't see how many times a message came; they see how many emails are in their inbox. The first half of today is the ways to keep that number at 1.

### 1.2 Idempotent consumer — six techniques, every crash point

In Lesson 2.5 we learned idempotency from the HTTP API's side: the client's `Idempotency-Key`, and the server returns the earlier answer. Today, the other side:

**Idempotent consumer** — a consumer that, even if it gets the same message several times (one after another or at the same time), causes its external effect (an email, a database change, a charge) only once.

The first approach is often forgotten: **make the work itself naturally idempotent.** Running `UPDATE tasks SET status = 'done' WHERE id = 7` ten times gives the same result. Running `UPDATE usage SET count = count + 1` ten times gives ten times as much. "Set" is idempotent, "increment" isn't. Wherever possible, write the effect in the language of "set" — upserts, fixed values, rows written by key. But sending an email can't be made a "set" — sending is always a new event. There you need a **dedupe key**, and you have to write down somewhere "this has been done."

Where you write it, and when you write it — that's where all the mistakes are. The exercise's `npm run idempotency` takes each of six techniques and assumes **a crash after every step** (after which the message comes again), and when two workers come at once it counts **every** order in which their steps can interleave. There's no randomness — every possibility is counted:

```
   technique                                       crash: lost / twice     concurrent: twice
   1. nothing: send → ack                            0 / 1 (1 point)         6 / 6
   2. check first: check → send → insert → ack       0 / 1 (3 points)       60 / 66
   3. claim first: insert (unique) → send → ack      1 / 0 (2 points)        0 / 12
   4. claim + status (no provider key)               0 / 1 (3 points)       60 / 66
   5. claim + status + provider key                  0 / 0 (3 points)        0 / 66
   6. same transaction (the effect is in the DB)     0 / 0 (1 point)         0 / 6
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

(The right column is "in how many possible orders there's a duplicate" — the orders aren't all equally likely, but zero versus non-zero is what matters.)

**Technique 2 — "check first"** — incident 1's first fix. Two gaps:

- A crash after `send`, before `insert` → nothing in the table → the next delivery sends again. The crash gap.
- Two at once: A checks (not there), B checks (not there), A sends, B sends. Duplicates in 60 of the 66 orders. This is the spaced repetition race — **check-then-act**: someone else gets in between the checking and the doing. In Lesson 5.5's language, an `INSERT` based on the result of a `SELECT`, and at ordinary isolation levels both see the same "not there".

**Technique 3 — "claim first"** — incident 1's second fix. `INSERT … ON CONFLICT DO NOTHING` first, on a unique constraint: the race is over (12 orders instead of 66, not a duplicate in any of them) — because the database itself won't let two rows with the same key exist together, whatever the isolation level. That's the spaced repetition answer: **a unique constraint**. But: a crash after the claim, before sending → the next delivery sees "already claimed" → skips it → the email **never goes**. Incident 1's second ticket, exactly. Duplicates were traded for losses — at-least-once into at-most-once.

**Technique 4 — claim + status:** at claim time `status = 'pending'`, after sending `'sent'`. The next delivery skips if it sees `sent`; if it sees `pending` it understands the previous one stopped midway — and sends again. No more losses! But "sent it, then crashed before writing `sent`" → `pending` → sends again → twice. And two at once both see `pending` and send. This is Lesson 6.1's core point: **"sending" and "writing down that I sent" are two separate events on two separate machines** — the gap between them can't be closed by arranging the order. You can only choose which way it goes wrong if you fall into the gap: lost (technique 3) or twice (technique 4).

**Technique 5 — closing the gap at the provider.** Technique 4, but give the provider a fixed key when sending — and the provider itself won't send when it sees that key a second time. Now even sending again after "sent it but couldn't write it down" does no harm — the provider knows. Exactly once at every crash point and in all 66 orders. In 6.1's language: a fencing token works when the resource itself checks; here the resource is the provider, and the mark it checks is the idempotency key. That's exactly what Stripe's `Idempotency-Key` header does (according to Stripe's documentation, keys are remembered for at least 24 hours).

**Technique 6 — if the effect is in your own database, the same transaction.** If the effect isn't an email but a write in your own database (incrementing billing's usage count), the gap doesn't exist at all: writing the dedupe row and the effect in the same transaction — both happen together, or neither does (Lesson 5.5's atomicity). This is the only place where "exactly once" is real, with no conditions.

What techniques 5 and 6 look like in TaskFlow:

```typescript
// sent_notifications: key (PRIMARY KEY), status ('pending' | 'sent'), createdAt
async function sendMention(msg: MentionMessage): Promise<void> {
	// the dedupe key comes from the work's identity — not from the message ID (why, at the end of 1.2)
	const key = `mention:${msg.commentId}:${msg.userId}`;
	// claim: create it as pending if it isn't there; if it is, return what's there
	const [row] = await SentNotification.findOrCreate({
		where: { key },
		defaults: { key, status: 'pending' }
	});
	if (row.status === 'sent') return; // already done — ack
	// pending: new, or someone before stopped midway — sending again with the same key is safe, because the provider dedupes
	await mailer.send({ to: msg.email, template: 'mention', idempotencyKey: key });
	await row.update({ status: 'sent' });
}

async function countCompletedTask(msg: TaskCompletedMessage): Promise<void> {
	await sequelize.transaction(async (t) => {
		// unique constraint on processed_messages.key; if it's already there, do nothing
		const [, created] = await ProcessedMessage.findOrCreate({
			where: { key: `usage:${msg.taskId}:${msg.completedAt}` },
			transaction: t
		});
		if (!created) return;
		await Usage.increment('completedTasks', {
			where: { workspaceId: msg.workspaceId, month: msg.month },
			transaction: t
		});
	});
}
```

(`findOrCreate` itself relies on the unique constraint internally to handle the race — without a constraint on the table, this is technique 2's race again. The constraint is the real defence, not the code.)

**What if the provider doesn't take an idempotency key?** Many email providers don't. Then the honest answer: technique 4's small gap will remain — "sent it, died before writing `sent`" — and now and then there'll be a duplicate. For most notifications that's acceptable (better than losing it); keep the gap small (write right after sending), and count how often it happens. For money it isn't acceptable — there, choose a provider that takes a key.

**Three practical decisions:**

- **What is the dedupe key of?** Not the message's ID — **the identity of the effect**: `mention:{commentId}:{userId}`. Because the same effect sometimes arrives as two different messages (a producer's retry, or a duplicate from the next lesson's outbox relay) — their message IDs differ, but the user should get the same email only once.
- **How long do you keep the key?** As long as the same message can come again: the queue's retention, the total retry time, the time to redrive from the DLQ (1.4) — longer than that. In TaskFlow 30 days, then delete the old rows (in a table partitioned by date, drop whole partitions — Lesson 5.8).
- **Where do you dedupe?** Best: as close as possible to where the effect happens — in the same transaction if it's the same database (technique 6), with its own key if it's external (technique 5).

### 1.3 Retry and backoff — when, how many times, and why jitter

Idempotency makes retry **safe**. Now the question is making retry **effective** — without harming yourself.

**Which errors do you retry?** Failures are of two kinds:

- **Transient (temporary):** timeouts, dropped connections, `503`, `429`, most `500`s — can succeed on another try.
- **Permanent:** `400` (invalid address), `401`/`403`, `404`, validation errors, a bug in your code — the same result after a thousand tries. (In 7.3's BullMQ, `UnrecoverableError`.)

Retrying permanent errors isn't just a waste of time — in 1.4 you'll see it drags the whole system down.

And `429` and `503` often come with a `Retry-After` header — the provider itself is telling you when to come. Respect it; it knows its state better than your backoff calculation.

**At which layer do you retry?** An almost ignored question. Suppose TaskFlow's worker tries the email service 3 times, the email service tries the provider's SDK 3 times, and the SDK itself tries HTTP 3 times. When the provider is slow, one job sends 3 × 3 × 3 = **27** requests to the provider — exactly when it's weakest. The rule: **retry in one place**, usually at the top layer (the one that owns the work — here the BullMQ job), and let the lower layers fail fast. Big systems add a **retry budget** on top: retries no more than a small fraction of total requests (there's a form of this in the "Handling Overload" chapter of Google's SRE book) — then even if everything fails, the load is at most 1.1 times, not 27.

**How to wait — and the retry storm.**

**Retry storm** — many clients fail together and retry together, and that wave arriving together overloads the downstream again by itself — the failure keeps itself alive.

Wednesday's incident is exactly this. The exercise's `npm run storm`, scenario (a) — 1000 jobs at exactly the same moment (the 9 o'clock cron), the provider can take 10 per 100 ms (100/s), at most 10 attempts per job:

```
   policy                        total attempts   max per 100ms   succeeded   gave up   last success   delay p99
   retry immediately                    9750              1990         50        950       450 ms       450 ms
   fixed, after 1 s                     9550              1000        100        900        9.5 s        9.5 s
   exponential (no jitter)              9550              1000        100        900       46.0 s       46.0 s
   exponential + full jitter            7152              1456       1000          0       20.3 s       16.6 s

   attempts arriving at the provider per second:
   second                           0     1     2     3     4     5     6     7
   fixed, after 1 s              1000   990   980   970   960   950   940   930
   exponential (no jitter)       3940   960     0   950     0     0   940     0
   exponential + full jitter     4547   964   521   302   256   139    89    91
```

- **Retry immediately:** all 10 attempts done in 0.5 seconds, 950 give up. The most pressure, the least work.
- **Fixed 1 second:** every second the whole pack comes back together — 1000, 990, 980… — and each time the provider can only take 10 at that moment. 100 succeed in 10 attempts. Wednesday morning.
- **Exponential, no jitter:** the wait grows (100 ms, 200, 400, 800 …) — but **it grows for everyone together**. The pack still comes back together, just progressively later: clumps at 0, 1, 3, 6 seconds. Still only those 100 succeed — and the last one at 46 seconds.
- **Exponential + full jitter:** all 1000 succeed, with the fewest total attempts.

**Jitter** — deliberate randomness in a retry's wait, so clients that failed together come back at different moments. With "full jitter", wait = `random(0, min(cap, base × 2^(n−1)))` — anywhere **below** the exponential limit.

(This formula and comparison are famous from AWS's Marc Brooker's piece "Exponential Backoff And Jitter" — it's also in the AWS Builders' Library's "Timeouts, retries, and backoff with jitter". Worth reading.)

Hold on to the core point: exponential backoff reduces **how many times** pressure is applied; jitter breaks up pressure applied **together**. The real disease of a retry storm is the second. Experiment 2: raising attempts from 10 to 20 raises the successes of fixed and no-jitter exponential from 100 to 200 — the root of the problem isn't touched, there are just more waves.

**The honest part — scenario (b):** when jobs arrive spread out anyway (50/s), and the provider comes back after being down for 5 seconds:

```
   policy                        total attempts   max per 100ms   succeeded   gave up   last success   delay p99
   retry immediately                    3205                50        767        233       20.0 s       350 ms
   fixed, after 1 s                     2192                30       1000          0       20.0 s        8.4 s
   exponential (no jitter)              2415                30       1000          0       20.0 s       13.1 s
   exponential + full jitter            2682                44       1000          0       28.0 s       13.3 s
```

Here jitter brings no benefit — slightly more attempts, in fact. Because there was no synchronisation; the jobs were spread out as they arrived. And in experiment 3 (a 15-second outage) 53 of full jitter's jobs give up, none of no-jitter exponential's — full jitter's average wait is half the limit, so for the same number of attempts the total time is shorter. The lesson: jitter is the cure for synchronisation, not a cure-all; and set the limit by **time** ("keep trying for 10 minutes"), not just by count. In production, synchronisation almost always comes from somewhere — a cron, a deploy, the end of an outage, cache entries expiring together — so keep jitter as the default. (There's nothing to be said for "retry immediately" in any scenario.)

### 1.4 Poison messages and the dead letter queue

Friday's incident.

**Poison message** — a message that will fail processing every time, because the fault is in the message itself (broken data, a bug in the code that hits this particular data) — waiting or retrying will never fix it.

**Dead letter queue (DLQ)** — a separate place where messages that still fail after a set number of attempts (or fail permanently) are moved — taken out of the main queue, but not thrown away — so a person can look, find the cause, fix it, and run them again (redrive).

Every broker has a form of it: in BullMQ the `failed` set (7.3); in RabbitMQ the dead-letter exchange (the queue's `x-dead-letter-exchange` — a message goes there when it's rejected, expires, or exceeds the queue's limit; on quorum queues you can also set a limit on how many times it can be delivered); in AWS SQS the redrive policy (into the DLQ after being received `maxReceiveCount` times). Kafka's broker has nothing of its own — because of 7.2's head-of-line blocking, the consumer itself writes the failing message to a separate topic and moves on.

`npm run dlq` — 5 minutes, 20 emails a second, 4 workers, 100 ms per good job. 2% poison (works for 2 seconds each time, then `400`). A provider outage from 60–90 seconds (all `503`). At 400 seconds a person looks at the DLQ, fixes things and redrives:

```
   policy                                  worker time on poison   longest line   good delay p99   to DLQ (good / poison)   redrive → delivered   left at end (good / poison)
   retry forever (no limit)                                 74%            1489           93.8 s                    0 / 0                 0 → 0                       0 / 131
   5 times, then DLQ                                        68%            1292           76.1 s                  0 / 135                 0 → 0                         0 / 0
   5 times; permanent straight to DLQ                       28%             352          338.5 s                159 / 135             159 → 159                         0 / 0
   permanent straight away; transient 12 times              28%             417           45.9 s                  0 / 135                 0 → 0                         0 / 0
```

**The first row — Friday:** 2% of poison jobs eat **74%** of the workers' time. Each poison comes back every 30 seconds (the backoff's cap) and takes 2 seconds — and new poison keeps arriving, none ever leaves. Their cost grows linearly with time, and eventually exceeds the workers' whole capacity. A line of 1489, the good jobs' p99 a minute and a half, and at 600 seconds 131 poison jobs still going round. And the most dangerous part: no job is "failed" — no alert.

**The second row — a limit, but all errors treated alike:** poison goes to the DLQ after 5 times, but eats 5 × 2 s before that — still 68%. (There's an accident here that's easy to misread: not a single good job went to the DLQ, but not thanks to the policy — the line is so long because of the poison that the next attempt of a job that failed during the outage gets past the outage just waiting in line. In a healthy system this policy would have behaved like the third row.)

**The third row — permanent separated out:** straight to the DLQ on a `400` — poison's cost 28% (each 2 s only once). But a new problem: transient errors also stop at 5 times, and 1 + 2 + 4 + 8 = 15 seconds of retries doesn't cover a 30-second outage — **159 good jobs in the DLQ.** They weren't lost (all 159 are delivered on the redrive at 400 s) — but they sat until a person came, so p99 is **338 seconds**. A DLQ is a safety net, but landing in the net means a person's work and delay.

**The fourth row — both decisions right:** permanent straight to the DLQ, transient given a long time (12 attempts, ~7 minutes — enough to cover an outage). Only poison in the DLQ, and the good jobs' p99 is 46 s.

The DLQ's rules from this:

1. **There is always a limit.** Infinite retry means poison's cost is infinite — and silent.
2. **Separate the kinds of error.** Permanent straight to the DLQ; think of transient's limit in **time** ("longer than a normal outage"), not in number of attempts.
3. **The DLQ isn't a dustbin.** Alert as soon as the DLQ's size is > 0. Someone will look, find the cause (keep the last error and the attempt count with the message), fix the data or the code, then redrive.
4. **Redrive must be safe** — meaning the consumer is idempotent (1.2). A job in the DLQ may actually have done its work the first time, and only broken at the ack.
5. **The DLQ's retention > the time for a human to respond** — Friday afternoon's DLQ must still be there on Monday morning. (That's why `removeOnFail` was 7 days in 7.3.)

### 1.5 Backpressure — when more arrives than can be handled

The second half of Wednesday's incident: the provider blocked TaskFlow, and password resets didn't go either. A big, not-very-urgent wave drowned a small, very urgent job.

In Lesson 7.1 we saw a queue **doesn't create capacity** — if the arrival rate is higher than the work rate on average, the backlog grows without bound. A queue handles two separate things, and it's important to look at them separately:

- **Burst:** more for a while, then less — manageable on average. This is the queue's real job: absorbing waves.
- **Sustained overload:** always more. A queue only buys time; in the end someone has to stop, or something has to be dropped.

**Backpressure** — when the downstream (the consumer) can't take work, sending that news upstream (to the producer), so the producer slows down, waits, or stops taking new work — instead of letting things pile up without bound.

**Load shedding** — under overload, deliberately turning away or dropping some work (usually the less urgent), so the rest gets done in time — rather than everything slowing down and everyone failing.

`npm run backpressure` — the consumer does 100/s, half the jobs are urgent (password reset, mention), half less urgent (digest, analytics), four policies:

```
── burst (300/s for 5 s, then 50/s)
   policy                                  queue max   blocked at producer   turned away (urgent / less)   wait p99 (all / urgent)
   unbounded queue                              1001                     0                         0 / 0           9.8 s / 9.8 s
   limit 500, 503 above it                       500                     0                     250 / 251           5.0 s / 5.0 s
   limit 500, the producer waits                 500                   501                         0 / 0           9.8 s / 9.8 s
   priority: drop less urgent above 300          475                     0                       0 / 584           9.6 s / 2.4 s

── sustained (130/s all the time)
   unbounded queue                              1801                     0                         0 / 0         17.8 s / 17.8 s
   limit 500, 503 above it                       500                     0                     650 / 651           5.0 s / 5.0 s
   limit 500, the producer waits                 500                  1301                         0 / 0         17.8 s / 17.8 s
   priority: drop less urgent above 300          301                     0                      0 / 1501            8.6 s / 0 ms
```

Four policies, four lessons:

1. **An unbounded queue** is great in a burst — it absorbs the wave of 1000, nobody is turned away, everyone within 10 seconds. But under sustained load the line is 1800 at 60 seconds, and unbounded if the load doesn't stop — until memory runs out (with 7.3's `noeviction`, `queue.add` then starts failing — uncontrolled backpressure).
2. **A limit + `503`** keeps the wait bounded: `500 ÷ 100/s = 5 s` — whatever gets in is done within 5 seconds. But in a burst it turns away 501 pieces of work the queue could have handled. **A limit is a limit on waiting** — Little's Law in reverse: `limit = acceptable wait × work rate`. Experiment 4: with a limit of 1500 nobody is turned away in the burst, 301 under sustained load, with waits up to 15 s.
3. **A limit + the producer waits** — the queue stops at 500, but the wait equals the unbounded case. The line has just **moved**: 1301 requests are hanging at the producer. For an API that means 1301 HTTP connections open (the ingredients of 7.1's cascading failure). Backpressure means sending the pressure upwards; if nobody up there (the user, the client, their timeout) stops, the pressure just changes place. In the end, somewhere, someone has to say "no".
4. **Priority** — under sustained load the urgent jobs' p99 is **0 ms**, and 1501 of the less urgent ones are dropped. Under overload some work will be dropped anyway — choosing **which** gets dropped is what load shedding is. Had this been in place on Wednesday morning, the password resets would have gone out, and the digests would have been late.

**Where in TaskFlow you can actually say "no":**

- **On the producer side (the API):** check the queue's length before `queue.add` (`queue.getWaitingCount()`), and above the limit return `503` + `Retry-After` for less urgent work (or tell the user the work will be done later). A rate limit (Lesson 9.5) is another form on the producer's side.
- **Separate queues:** urgent and less urgent not in the same queue (7.1's question 3). Password reset has its own queue and worker — the digest wave doesn't touch it.
- **On the provider side:** the worker's rate tied to below the provider's limit (BullMQ's `limiter: { max, duration }`) — the 40 thousand digests don't go at once, they go at the provider's pace; then `429` never comes.
- **Spreading out the cron:** not 40 thousand jobs at 9 all at once — a random `delay` on each (0–15 minutes). Jitter, in the cron's language.

(A familiar example you may already have seen: Node's streams. When `writable.write()` returns `false`, stop writing and wait for the `'drain'` event — that's backpressure, inside one process. And a Kafka consumer pulls at its own pace — backpressure is natural in 7.2's log: a slow consumer only increases its lag, the broker doesn't push anything at it.)

### 1.6 TaskFlow's policy — per job

> **Trade-off Table — failure policies for TaskFlow's jobs**

| Job                | Dedupe key                       | Idempotency technique                                    | Retry (transient)                          | Permanent / DLQ                             | Queue / priority                                                         |
| ------------------ | -------------------------------- | -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| Password reset     | `reset:{tokenId}`                | Claim + status + provider key (5)                        | Exponential + jitter, up to 15 minutes     | `400` straight to DLQ; alert on DLQ > 0     | Separate, highest; never shed                                            |
| Mention email      | `mention:{commentId}:{userId}`   | 5 (4 if the provider has no key, count the duplicates)   | Same, up to 1 hour                         | Same                                        | Notification queue, high                                                 |
| Daily digest       | `digest:{userId}:{date}`         | 5                                                        | Same, up to 6 hours; respect `Retry-After` | Same                                        | Separate, low; provider limiter; cron jitter; shed under overload        |
| Usage count        | `usage:{taskId}:{completedAt}`   | Same transaction (6)                                     | Exponential + jitter                       | DB constraint error → DLQ                   | Billing queue; never shed                                                |
| Webhook (customer) | `webhook:{eventId}:{endpointId}` | The receiver's responsibility — send an `eventId` header | Up to 24 hours, at growing intervals       | Endpoint `410` → disable; show the customer | A per-customer limit — one customer's dead server doesn't block everyone |

---

## 2. Interview Angle

**"How would you make a consumer reading from a message queue exactly-once?"** — The first sentence of the answer: "delivery isn't exactly-once, it's at-least-once — I'll make the effect idempotent." Then the technique: a dedupe key (from the effect's identity), a unique constraint (why the check-then-act race breaks, in one sentence), and where the effect is: in the same transaction if it's your own database, its idempotency key if it's external. Finally, the honest limit: if the external system doesn't take a key, there's a small duplicate window — where, why, and how you'll measure it. This last part is usually what separates a senior answer from a mid-level one.

**"How will you retry?"** — Say five words, with reasons: **transient only** (not 4xx), **exponential backoff**, **jitter** (to break synchronisation — say the name "retry storm"), **a limit** (in time, and once per layer — retry amplification), **idempotent** (otherwise the retry itself is a bug). Bonus: respecting `Retry-After`, a retry budget.

**"The consumer is slow, the queue is growing — what will you do?"** — First a question: burst or sustained? If it's a burst, that's exactly the queue's job — watch the lag, and if it's within limits, do nothing. If sustained: scale the consumer (if the downstream can take it), otherwise backpressure (`503`/`429` at the producer), load shedding by priority, less urgent work into a separate queue. And "make the queue bigger" isn't an answer — that only makes the line longer.

**In real production:** the list of the most common mistakes is almost fixed — "check first" dedupe (the race), infinite retry (poison), no alert on the DLQ (a silent graveyard), retry at every layer (27 times), backoff without jitter (the cron's wave), and urgent and less urgent in the same queue (Wednesday). Going through this list once before launching a new queue saves a lot of incidents.

---

## 3. Key Takeaway

- Delivery is **at-least-once**; "exactly once" comes from **idempotent processing**. The same message comes again in two ways — one after another after a crash, and at the same time on a stall
- **"Check first"** gives twice on a crash and twice in the race (60 of 66 orders); **"claim first"** (unique constraint) fixes the race but **loses** on a crash; the gap between the work and writing "the work is done" can't be closed by arranging the order — it's closed by the effect's own **idempotency key**, or by the **same transaction** if the effect is in your own database
- Dedupe key = the effect's identity (not the message ID); keep the key longer than the redrive time; the constraint is the defence
- Retry only on transient errors, at one layer, within a time limit; exponential backoff reduces **how many times**, **jitter** breaks up **together** — in a synchronised wave, 100 of 1000 succeed without jitter, all 1000 with it; with spread-out load jitter brings almost nothing
- A **poison message** under unbounded retry eats 74% of the workers, silently; a limit + permanent errors straight to the **DLQ** + transient given enough time to cover an outage = poison at 28%, only poison in the DLQ. Alert on DLQ > 0, and redrive must be safe
- A queue absorbs a **burst**, it doesn't fix **sustained overload**; **backpressure** sends pressure upwards (but somewhere a "no" has to be said), limit = wait × rate; **load shedding** chooses by priority what gets dropped — urgent p99 0 ms

---

## 4. New Terms (Glossary)

| Term                        | Meaning                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Idempotent Consumer**     | A consumer that causes its external effect only once even if it gets the same message several times (one after another or at once) |
| **Retry Storm**             | Many clients fail together and retry together, and that wave overloads the downstream again — the failure keeps itself alive       |
| **Jitter**                  | Deliberate randomness in a retry's wait (full jitter: `random(0, exponential limit)`), so clients come back at different moments   |
| **Poison Message**          | A message that will fail every time through its own fault (broken data, a specific bug) — waiting or retrying doesn't fix it       |
| **Dead Letter Queue (DLQ)** | A separate place to set messages aside after the attempt limit or on a permanent failure — a person looks, fixes, and redrives     |
| **Backpressure**            | When the downstream can't take work, sending that news upstream — the producer slows down, waits, or takes no new work             |
| **Load Shedding**           | Under overload, deliberately turning away some work (usually the less urgent) so the rest gets done in time                        |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. TaskFlow's billing: every `task.completed` message increments the workspace's monthly usage count by 1, and at the end of the month the invoice is made from that count. But the usage count is now kept in **Redis** (`INCR usage:{workspaceId}:{month}`), and for dedupe someone proposed a Postgres `processed_messages` table. In this design, what breaks at which crash point? Which of the six techniques is it like? Give two solutions — one where the count stays in Redis, one where it doesn't — and which you'd choose.
2. TaskFlow sends webhooks to customers' servers (a POST to their URL on `task.completed`). One big customer's server is down for 6 hours. For each of the four — retry, DLQ, backpressure and idempotency — say what you'd do so that (a) that customer's events aren't lost, (b) the other customers' webhooks aren't delayed, (c) when that customer's server comes back it isn't knocked over again by a 6-hour wave at once, and (d) events received twice do no harm on their side.
3. Design Wednesday's incident again. 40 thousand digests, the provider's limit 100/s, a few hundred password resets a day but each needs to go within 1 minute. What changes would you make (at least four, from four different parts of this lesson), and which part of the incident does each stop? How long will the 40 thousand digests take to finish, and is that acceptable?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The effect (Redis `INCR`) and the dedupe row (Postgres) are in two separate systems — so technique 6's "same transaction" is gone; it's one of 2, 3 or 4, and breaks according to the order:

- Claim in Postgres first, then `INCR` (technique 3): a crash after the claim → the next delivery skips it → the count is **too low** (the task wasn't counted — the customer was billed less).
- `INCR` first, then claim: a crash after the `INCR` → `INCR` again → the count is **too high** (the customer was billed more — even worse).
- Check, then both (technique 2): in the race both `INCR`.

Solution A — the count stays in Redis, but the dedupe is in Redis too, in the same atomic operation: a Lua script (or `MULTI`) that does `INCR` only if `SET processed:{key} 1 NX` succeeds — both in the same Redis, in the same atomic step → the Redis form of technique 6. The catch: losing writes on Redis's persistence and failover (7.3's 1.8) — a risk for billing.

Solution B — change the count from "increment" to "count": in Postgres, `completed_tasks_usage (taskId PRIMARY KEY, workspaceId, month)` — every message inserts one row (`ON CONFLICT DO NOTHING`). Usage = `COUNT(*)`. This is naturally idempotent (1.2's language of "set") — one row even if it comes ten times. The dedupe and the effect are the same thing. If Redis is needed, only as a cache for fast display, not as the source of truth.

The choice: B. Billing is money — the source of truth belongs in the database, and making the effect itself idempotent is the strongest solution.

**Question 2:**

- **Retry:** each webhook's retry bounded in time — e.g. up to 24 hours, exponential + jitter, with a maximum gap of about an hour. That covers the whole 6-hour outage. (Big providers like Stripe retry webhooks over days.)
- **Backpressure / isolation (for b):** if every customer's webhooks go through one queue with the same workers, the dead server's timeouts (say 10 s each) tie up the workers — delaying everyone else (7.1's cascading). So: a limit on concurrent requests per customer (endpoint) (1–2), a short timeout (5 s), and marking an endpoint that keeps failing as temporarily "closed" and holding back its jobs — a circuit breaker (Lesson 9.4). At larger scale: a separate queue or partition per customer.
- **The wave on return (c):** when the server comes back, not 6 hours of events at once — a rate limit per endpoint (e.g. 10 per second), and thanks to the retries' jitter the events are spread out anyway.
- **DLQ:** if it's still failing after 24 hours, the DLQ — and show it on the customer's dashboard ("these events weren't delivered", with a "send again" button). If the endpoint returns `410 Gone` (permanent) — no more attempts, disable the endpoint, tell the customer.
- **Idempotency (d):** it's at-least-once, so the customer may get it twice — send a fixed `eventId` header with every webhook, and say in the documentation "dedupe by `eventId`." Idempotency on the receiver's side is their responsibility; yours is making it possible for them (a fixed ID that doesn't change on retry).

**Question 3:** The changes, by part:

1. **Backpressure / isolation — a separate queue:** password reset gets its own queue and worker. No digest wave touches it. (This alone stops the worst part of the incident — password resets not going.)
2. **Backpressure — tied to the provider's pace:** `limiter: { max: 80, duration: 1000 }` on the digest worker — a little below the provider's limit, leaving room for password resets. `429` never comes, so there's no reason for the account to be blocked.
3. **Jitter — spreading the cron:** `delay = random(0, 15 minutes)` on every digest job — the 40 thousand don't enter the queue at once. (With the limiter this is extra safety — nor are there 40 thousand waiting in Redis at once.)
4. **Retry — respect `Retry-After` on `429`, exponential + jitter:** if a `429` comes anyway, there's no wave.
5. **Idempotency:** the `digest:{userId}:{date}` key and a provider key — if the cron runs twice (at the moment of a deploy, or 6.1's two leaders), nobody gets two digests.
6. **DLQ:** digests to invalid addresses straight to the DLQ, so poison doesn't take up room during the wave.

Time: 40,000 ÷ 80/s = 500 s ≈ **8–9 minutes** (if it's spread over jitter's 15 minutes, those same 15 minutes). For a digest "between 9 and 9:15" is completely acceptable — nobody expects the digest at exactly 9:00:00. And password reset's 1-minute target no longer depends on the digest.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (deterministic simulation)

> **Ready to run in the repo:** [`exercises/lesson-7.4-reliable-consumers/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.4-reliable-consumers) — `npm install`, then `npm run idempotency`, `npm run storm`, `npm run dlq`, `npm run backpressure`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`idempotency.ts` writes the six consumer techniques as lists of steps, then counts a crash after every step and every interleaving of two workers — no randomness. `storm.ts`, `dlq.ts` and `backpressure.ts` are seeded simulations — the exact same numbers every time.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; each of the four scripts was run twice with identical output; the README's experiments 1–5 were run (number 1 by changing `idempotency.ts`, then reverting it), and the numbers are in the README. These are models: every step is assumed atomic, the provider's idempotency key is assumed always available (in reality not every provider offers one), the storm's provider returns 503 immediately under overload instead of slowing down, and the interleaving count is "how many orders are possible" — not equally likely. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Incident 1 by hand:** **before** running `idempotency`, guess and write down the result (0, 1 or 2) at every crash point of techniques 2, 3 and 4. Then run and compare. Then experiment 1: "check → write → send" — which faults of techniques 2 and 3 does this take on together?

2. **Count the waves:** under storm (a)'s "fixed, after 1 s" policy 100 succeed — explain it by hand (how many in each wave, how many succeed in one of the provider's 100 ms windows, how many waves). Then experiment 2 (`MAX_ATTEMPTS=20`) — why 200, and why isn't this a solution?

3. **The cost of poison:** roughly calculate dlq's first-row "74%" — how many poison jobs arrive per second, how often each comes back and how long it takes, how many pile up in 300 seconds. The workers' capacity is 4 worker-seconds per second — at what moment does poison alone start eating all of it?

4. **Calculating the limit:** for TaskFlow's mention email, users will accept at most 2 minutes of delay, and the workers' rate is 50/s. What limit will you set on the queue? Change `LIMIT` and run backpressure to see how many are turned away in the burst with your number (like experiment 4).

5. **Design part:** extend 1.6's table for three more of TaskFlow's jobs — the CSV export (7.3's question 1), the attachment thumbnail, and the search index update (from `comment.created`). For each: the dedupe key, the idempotency technique (which of the six, and why), the retry time limit, which errors are permanent, who looks if it lands in the DLQ, and whether it gets shed under overload. For the search index especially, think: can the effect be made naturally idempotent (1.2's language of "set")?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (complete, including exit challenges), 7.1, 7.2, 7.3
Current: 7.4 — Idempotency, retry, exponential backoff, DLQ, backpressure
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; BullMQ (separate Redis, noeviction + AOF) — policy per job:
dedupe key = the effect's identity, sent_notifications (pending/sent) + provider idempotency key,
usage = same transaction; retry only transient, exponential + full jitter, bounded in time,
respect Retry-After; permanent → straight to DLQ (failed set), alert on DLQ > 0; separate queues:
password reset (high) / notification / digest (low, limiter, cron jitter, shed under overload);
events → Redis Streams (7.2); still to come: the database ↔ queue dual write (7.5)
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF, Idempotent Consumer, Retry Storm, Jitter,
Poison Message, Dead Letter Queue, Backpressure, Load Shedding
Weak spots: [where you got stuck — fill this in yourself]
Next: 7.5 — Event-Driven Architecture basics
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your poison calculation in #3 and your table in #5. When you are ready, write `next` — we'll go to Lesson 7.5: **Event-Driven Architecture basics.** For three lessons we've kept putting one question off: the assign's database commit happened, then the API died before `queue.add` — the assign exists, the email's job doesn't. In the opposite order: the job exists, the commit failed. This dual-write problem of writing to two separate systems together isn't fixed by any of today's techniques — because all of today's techniques start by assuming "the message has arrived". In 7.5, how that message is reliably **created** — the transactional outbox — and with it the difference between events and commands, and when event-driven design helps and when it builds an invisible tangle.
