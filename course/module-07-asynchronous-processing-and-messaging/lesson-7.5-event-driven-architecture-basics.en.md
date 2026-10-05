# Lesson 7.5 — Event-Driven Architecture Basics

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.3 + 5.7):** What is Postgres's WAL — what gets written where before a commit? And in async replication, how does the replica get **every** change on the primary, in exactly the right order? Today we'll put this same stream to another use — making events from the database's changes.

**Prerequisite:** Lesson 5.3 (WAL), Lesson 5.5 (Transactions), Lesson 5.7 (Replication), Lesson 7.2 (Log, consumer group, partition key), Lesson 7.3 (BullMQ, the dual-write question), Lesson 7.4 (Idempotent consumer)

**By the end of this lesson you will be able to:**

1. Tell events from commands, and say when arranging a flow around events (choreography) helps and when it builds an invisible tangle
2. Show with the exercise's numbers why dual write can't be fixed by arranging the order — and close it with a transactional outbox (a polling relay or CDC)
3. Design an event's contract — name, ID, version, how much data — so that producer and consumer can change independently

**Tier:** 1 — Runnable Code (Postgres + Redis in Docker; the writer and the relay really are `SIGKILL`ed midway)

---

## 0. Where TaskFlow Is Right Now

Following Lesson 7.2's decision, TaskFlow's "news" goes into a Redis Stream. The comment-creation route is now:

```typescript
await sequelize.transaction(async (t) => {
	await Comment.create({ taskId, authorId, body }, { transaction: t });
});
await redis.xadd('events:comments', '*', 'data', JSON.stringify(event)); // after the commit
res.status(201).json(comment);
```

And that stream has four consumer groups: notification (mention emails — 7.3, 7.4), the search index, analytics, the Slack integration. Three incidents in three weeks:

1. **After a deploy:** a few users said their new comments weren't showing up in search, and the people they mentioned got no email. The comments are in the database. The stream has no events for them.
2. **Three seconds of a Redis failover:** every comment written in those 3 seconds — the same state. No errors, because the `xadd` failure was `catch`ed and logged (we have to give the user a 201 — the comment was saved, after all).
3. **An engineer reversed the order** — "event first, then commit, then the event won't be lost." A week later: someone got an email "Rahim mentioned you in a comment", clicked the link — 404. And during the next Redis maintenance, for five minutes **nobody could comment at all.**

At the same time, a different argument in the product meeting. When a task is completed, six things are now supposed to happen: notifications to the assignee and watchers, analytics, billing's usage (7.4), customers' webhooks, auto-closing the parent task, and updating the sprint's progress. Six calls are piling up in the task service's `complete()` function. One person said: "Instead of calling everyone, just emit one `task.completed` event — whoever needs it can listen." Another warned: "Then six months from now nobody will be able to say exactly what happens when a task is completed."

Both are right. Today, two questions: when event-driven design is good and when it's harmful — and how an event is **reliably created**, the question we've been putting off since 7.3.

---

## 1. Theory

### 1.1 Event and command — "it happened" vs "do this"

In Lesson 7.2 we split messages into two kinds — "tasks" and "news". Today, their formal names.

**Command** — asking someone to do a specific piece of work ("send this email", "charge this card"); there's one specific recipient, who can do the work or refuse it, and the sender knows at the time of sending what ought to happen.

**Event** — news of something that has already happened ("a comment was created", "a task was completed"); it's a fact, there's nothing to refuse, and the publisher doesn't know (and doesn't need to know) who is listening or what they'll do on hearing it.

The difference shows in the names: commands are imperative (`SendMentionEmail`, `ChargeCard`), events are in the past tense (`comment.created`, `task.completed`). And the direction of responsibility is reversed:

```
   command:  task service ──"send a notification"──► notification service
             (the task service knows notification exists, and what it should do)

   event:    task service ──"a task was completed"──► [ stream ] ──► notification
                                                                 ──► analytics
                                                                 ──► billing …
             (the task service only knows what happened; who does what is their decision)
```

A common mistake: sending a command under an event's name — `task.completed.sendEmailToAssignee`. Here the publisher is really deciding both the recipient and the work, and only the name looks like an event. You get the faults of both at once: a command's coupling, an event's invisibility.

### 1.2 Event-driven architecture — what you get, what you give

Event-driven architecture means services **react to** events instead of calling each other directly. The six jobs of task completion can be arranged in two ways:

```
  a) direct calls (one knows everything)        b) events (nobody knows everything)

  complete() {                                    complete() {
    notify(assignee, watchers)                      db: status = done
    analytics.track(...)                            publish('task.completed')
    billing.countUsage(...)                       }
    webhooks.send(...)                                 │
    if (parent.autoClose) parent.complete()            ├──► notification (decides who, itself)
    sprint.updateProgress(...)                         ├──► analytics
  }                                                    ├──► billing
                                                       ├──► webhooks
                                                       ├──► parent auto-close
                                                       └──► sprint progress
```

(b) is called **choreography** — like a dance troupe, where everyone knows their own part and moves on hearing a cue, with no director. Where, as in (a), a central coordinator says who does what when, that's **orchestration** — both come back in Lesson 9.3's saga.

**Choreography** — a big piece of work split across several services, where nobody gives anyone orders; each listens to events and does its own part, and emits its own events if needed.

**What you get:**

- **Less coupling in the producer.** A new job (say "sync to Jira when a task is completed") means a new consumer — the task service's code isn't even touched.
- **Temporal decoupling (7.1).** If analytics is down for an hour, task completion doesn't stop; analytics comes back and reads the part it missed (7.2's log).
- **Separate scaling, separate failures.** A slow webhook customer doesn't slow down billing.

**What you give:**

- **The flow becomes invisible.** In (a), the answer to "what happens when a task is completed" is in one function you can read. In (b), the answer is spread over six repos, and which service listens to which event isn't written down in any one place. This is what the second person in the meeting was saying.
- **Chains of events.** Parent auto-close emits a new `task.completed`, which wakes parent auto-close again… Events can build a web of triggering each other that nobody designed — and loops.
- **Eventual consistency.** The task is complete, but the sprint's progress changes a second later. In (b) there's no such thing as "all at once".
- **Harder debugging.** Finding the cause of one mistake means joining the logs of five services — every event needs a correlation ID (Lesson 10.4's tracing).
- **An event's shape is a public contract.** If the producer renames one field, an unknown number of consumers break (1.6).

So what's the rule? Roughly: **work that is a side effect of the main work, whose result the main work's caller doesn't need, and which can fail independently — goes on an event.** Work that is part of the main work (if it fails, the main work should fail too), or whose order and coordination are complex and important to the business — goes direct, or through orchestration. Of task completion's six, notification, analytics, webhooks and sprint progress are clearly events. Billing's usage too (7.4's idempotent consumer). Parent auto-close needs thought: it's a business rule, and it builds chains — many teams keep it inside the task service.

### 1.3 How much data in an event?

Martin Fowler's 2017 piece "What do you mean by 'Event-Driven'?" shows that people mean several different things by "event-driven". Three for today:

**Event notification — just the news and an ID:** `{ type: 'task.completed', taskId: 42 }`. If a consumer needs anything else it asks the task service. The event is small, but every consumer calls back (load on the task service, and its availability is back on the consumer's path — 7.1's temporal coupling returns), and by the time it reads back the data may already have changed again.

**Event-carried state transfer** — the data consumers will need travels with the event itself (`taskId`, `title`, `assigneeId`, `completedBy`, `completedAt`, `projectId`), so consumers don't have to go back and ask the producer; a consumer can keep its own copy if it wants.

Consumers become independent — even with the task service down, everything notification needs is in the event. The price: bigger events, copies of data in many places (and every copy a little stale — eventual), and whatever you put in an event everyone sees (personal information, secrets — never).

**Event sourcing** — making events the source of truth: a task's current state isn't a row in the database, but the result of replaying all its events (`created`, `assigned`, `renamed`, `completed`) from the beginning. Powerful (the whole history, the state at any time can be rebuilt), but it changes the design of the whole system — 7.2's 1.4 warning applies here too. Not today's topic; in TaskFlow the database stays the source of truth, and events are **news of its changes**.

For TaskFlow, the middle ground: IDs in the event, plus the few fields almost every consumer needs — for the rest, the consumer asks back if needed.

### 1.4 Dual write — no order fixes it

Now incidents 1–3. The problem's name:

**Dual write** — writing to two separate systems for one piece of work (here Postgres and Redis), with no shared transaction between them — so if something breaks in between, one gets written and the other doesn't.

This is the twin of the gap in Lesson 7.4's 1.2. There, "sending the email" and "writing down that I sent it" — two systems, a gap between them. Here, "writing the comment" and "sending the event" — the same gap. And the same lesson: changing the order only changes which way it goes wrong.

The exercise's `npm run scenario` — 2000 comments, and on roughly one in every 50 the writer `SIGKILL`s itself exactly between the two writes (which comment is decided from its id — so it's the same 41 in every mode). At the end, Postgres and the Redis Stream are reconciled:

```
   mode            comments    lost  phantom    extra (same eventId)
   commit-first        2000      41        0        0
   publish-first       1959       0       41        0
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

- **`commit-first`** (incident 1): 41 comments exist with no event. Search, notification, analytics — none of them will ever know.
- **`publish-first`** (incident 3): the event went out first, then the process died — the open transaction was rolled back by Postgres itself when the connection broke. 41 **phantom** events: news of comments that don't exist. The 404 mention email.

And without a crash, just Redis down for 3 seconds (experiment 1, incident 2) — two orders, two different miseries:

```
   mode             comments   lost   user saw an error
   commit-first        2000     449                  0      ← 449 events silently missing
   publish-first       1466       0                534      ← 534 people couldn't comment at all
```

`publish-first` is "consistent" — no comment exists without its event — but it paid for that in availability: every bad second of Redis is now a bad second of the comment feature. 7.1's critical-path product again — Redis is now on the path of creating a comment.

**"Can't the two systems be tied into one transaction?"** — Two-phase commit (2PC/XA) is an attempt to do exactly that (details in Lesson 9.3). But Redis Streams, Kafka and most brokers don't take part in it, and where they do it's slow and gets stuck when a coordinator fails. In practice the answer lies in another direction: don't write to two systems — write to **one**.

### 1.5 Transactional outbox — write to one system, send later

**Transactional outbox** — instead of sending the event straight to the broker, writing it into an `outbox` table **in the same database transaction** as the business data; a separate relay process later reads from the outbox, sends to the broker, and marks it "sent".

```
   API (writer)                         Postgres                        relay               Redis Stream
   ────────────                         ────────                        ─────               ────────────
   BEGIN
     INSERT comments (…)          ──►   comments      ┐
     INSERT outbox_events (…)     ──►   outbox_events ┘ the same transaction
   COMMIT                               both exist, or neither does
                                                                        SELECT … FOR UPDATE
                                                                        SKIP LOCKED (batch)
                                                                        XADD each ─────────► event
                                                                        UPDATE publishedAt
                                                                        COMMIT
```

Dual write's two writes are now one transaction in one database — Lesson 5.5's atomicity. The technique is just like 7.4's technique 6: the gap closes because the two writes are now in the same system.

The exercise's third row:

```
   mode            comments    lost  phantom    extra (same eventId)
   outbox              1959       0        0      160
   relay crashes: 11 · from commit to reaching the stream p50 118 ms, p99 457 ms
```

(The extra and relay-crash numbers change a little between runs — which batch a relay crash lands in depends on timing.)

- **0 lost, 0 phantom.** When the writer crashes, the comment and the outbox row roll back together — the user sees an error, and nothing exists anywhere. Consistent.
- **With Redis down (experiment 1):** 0 lost, 0 user errors — creating a comment now needs only Postgres. The events wait in the outbox, and the relay sends them when Redis comes back (delay p99 4.1 s). Redis has left the comment's critical path.
- **160 extra.** The relay sent them, then died before writing `publishedAt` — the next relay sends them again. The outbox is **at-least-once**, not exactly-once. But look: "distinct eventIds" = 1959 = the number of comments: the extras are all exact copies, **with the same eventId** — so 7.4's idempotent consumer (dedupe by eventId or the effect's key) safely drops them. The outbox and the idempotent consumer are a pair — each is half without the other.
- **Delay.** The event doesn't go at the moment of commit — it goes on the relay's next search (p50 ~100 ms, ~840 ms with `POLL_MS=1000`).

**The details of building a relay** (the exercise's `relay.ts`):

- `FOR UPDATE SKIP LOCKED` — if several relays run (or a new one starts while the old one is stuck), two don't take the same row; each skips rows locked by the other and takes the next ones.
- A partial index on `WHERE "publishedAt" IS NULL` — the search stays fast even with millions of old rows in the outbox.
- **The batch size is a trade-off.** A big batch = fewer round trips; but a batch is one transaction, and if it fails midway the whole thing goes again. Experiment 3: with a 5% crash per event, the probability that a batch of 50 finishes without any crash is 0.95⁵⁰ ≈ 8% — the relay nearly stops (1050 still pending after 60 seconds). With a batch of 5 everything gets through. A relative of 7.4's poison message: one bad thing holds up everything with it.
- **Keep the outbox clean.** Sent rows keep piling up (2000 at the end of the exercise). Delete them after a few days — at large scale, partition by date and drop whole partitions (Lesson 5.8).

**Order — a subtle trap (experiment 4).** An outbox `id` is assigned at insert time, not at commit time. Two transactions at once: T1 got id 10, T2 got id 11, T2 committed first. If the relay searches at this moment it sees 11 (10 isn't visible yet) and sends it; later it sends 10 — in reverse order. Searching by `publishedAt IS NULL`, 10 isn't lost, just late. But if someone writes the relay with "`WHERE id > last sent id`" (which looks more efficient), then after sending 11 the cursor is at 11 — and 10 is **never** sent. The rule: in an outbox, a flag, not a cursor (or CDC, below). And if the order of one task's events matters (7.2), that task's writes commit in order by themselves (a lock on the same row), so it's usually fine — but with several relays you have to make sure per-task order is preserved (e.g. one relay, or relays split by key).

**Not polling — Change Data Capture.** The relay asks the database every 200 ms — and most of the time the answer is "nothing". Two improvements:

- **`LISTEN`/`NOTIFY`** — a `NOTIFY outbox` in the writer's transaction (Postgres sends it right at commit), and the relay, `LISTEN`ing, wakes up. Less delay, fewer empty queries. (Notifications can be lost — so keep polling now and then anyway.)
- **CDC:**

**Change Data Capture (CDC)** — reading the database's own ledger of changes (Postgres's WAL, via logical decoding) and emitting each change as an event — the application code makes no separate query or call.

The spaced repetition answer is used here: just as a replica gets every change on the primary from the WAL in exactly **commit order**, a CDC tool (the best known is Debezium, on top of Kafka Connect) gets them in exactly the same way — and writes them to the broker. Combined with the outbox: CDC reads only the inserts into the `outbox_events` table and makes events from them (Debezium has an "outbox event router" for exactly this). The gain: no polling, less delay, and commit order (the trap above is gone). The price: another system to run (Debezium, Kafka Connect), turning on logical replication in the database, and the risk that if the replication slot isn't read properly, WAL piles up and fills the database's disk. At TaskFlow's size a polling relay is enough; the day there are many events and delay matters, CDC.

(Know the name of the consumer side's twin pattern too: the **inbox** — the IDs of the messages a consumer has processed, in a table, in the same transaction as the effect. It's really 7.4's technique 6, under a new name.)

### 1.6 The event's contract — so both sides can change independently

Once an event is out, you don't know who's reading it — so its shape is like a public API. The event in the exercise's `events.ts`:

```typescript
export const commentCreatedSchema = z.object({
	eventId: z.string().uuid(), // fixed — doesn't change on retries or relay duplicates; the consumer's dedupe key
	type: z.literal('comment.created'), // past tense
	version: z.literal(1), // for when the shape changes
	occurredAt: z.string(), // when it happened — not when it was sent (in an outbox those two differ)
	taskId: z.number().int().positive(), // the key for order and partitioning (7.2)
	commentId: z.number().int().positive()
});
```

The rules:

- **A fixed `eventId` on every event** — made when the outbox row is created, the same on every resend by the relay. Without it a consumer can't recognise duplicates.
- **`occurredAt` is separate from the time of sending.** In an outbox an event can go out even 4 seconds later (a Redis outage) — let the consumer's logic run on the time of the event.
- **Change the shape only by adding.** Adding a new optional field is safe (old consumers ignore it — a "tolerant reader"). Renaming a field, deleting one, changing its meaning — a new version (`version: 2`, or a new event type), send both for a while, and turn off the old one when every consumer has moved.
- **Consumers parse with Zod** (the exercise's relay does too — the outbox's JSONB can hold rows of an old version). On an unknown version, don't crash — send it to the DLQ (7.4).
- **Never secrets or unnecessary personal information.** It sits in the event log, many consumers read it, and it stays until retention.

> **Trade-off Table — five ways to "write data and send an event"**

| Approach                | On a crash                                 | With the broker down             | Duplicates        | Delay             | Price                                                                          |
| ----------------------- | ------------------------------------------ | -------------------------------- | ----------------- | ----------------- | ------------------------------------------------------------------------------ |
| Commit, then publish    | The event is **lost** (41 in the exercise) | Events silently lost (449)       | No                | None              | Simplest; the most silent mistakes                                             |
| Publish, then commit    | **Phantom** events (41)                    | The feature is down (534 errors) | No                | None              | The broker is on the critical path; phantom events are the consumers' headache |
| 2PC / XA                | Consistent (if the coordinator is fine)    | The feature is down              | No                | More              | Most brokers don't support it; slow, complex (9.3)                             |
| Outbox + polling relay  | Consistent                                 | Nobody notices, events are late  | Yes, same eventId | The poll interval | Outbox table, relay, cleanup; the ordering trap; idempotent consumers          |
| Outbox + CDC (Debezium) | Consistent                                 | Nobody notices                   | Yes, same eventId | Low               | Running CDC, logical replication, the risk of WAL piling up                    |

### 1.7 TaskFlow's decision

- **Every comment, task and assignment event through the outbox.** A row in `outbox_events` inside every write route's transaction. One polling relay (`SKIP LOCKED`, partial index, batch ~20), later woken by `NOTIFY` if needed. Sent rows deleted after 7 days.
- **Every consumer idempotent** — by `eventId` or the effect's key (7.4).
- **Task completion's six jobs:** notification, analytics, billing usage, webhooks, sprint progress — consumers of `task.completed` (choreography). Parent auto-close — inside the task service, in the same transaction (a business rule, and to avoid chains of events).
- **A list of who listens to what** — a document or an `events/` folder with each event's schema and the names of its consumers. The cheapest cure for choreography's invisibility.
- **And 7.3's BullMQ jobs?** The email-sending job is a "command" too — and it's a dual write as well (commit + `queue.add`). The same solution: the notification consumer reads the event and adds the job (idempotent on the consumer's side, by job ID), or the job too is lifted from the outbox. The core rule: **whatever leaves the database is born from the database's commit.**

---

## 2. Interview Angle

**"When an order is created, an event has to be sent — how?"** — This is almost always a test of dual write. A weak answer: "I'll save it and publish to Kafka." A good answer raises the question itself: "what if there's a crash between the save and the publish? And in the opposite order? — so a transactional outbox: an outbox row in the same transaction, a relay or CDC sends it, at-least-once, so the consumer is idempotent." Bonus: the polling vs CDC trade-off, and the outbox's id-order vs commit-order trap.

**"How will the microservices talk — synchronous calls or events?"** — After "it depends", give a rule: needed for the caller's answer and part of the main work → synchronous (or orchestration); a side effect, many listeners, can fail independently → event. Then state events' price, yourself: invisible flow, eventual consistency, the schema contract, debugging. A candidate who only lists the benefits gets asked about the price in the next question.

**"What will you put in an event?"** — Notification vs event-carried state, and why the middle ground; a fixed event ID, occurredAt, version, key; additive changes.

**In real production:** the best-known failures of an outbox: the relay has died and nobody knows (alert on the number of unsent outbox rows and the age of the oldest — just like 7.1's queue metric); the outbox is never cleaned and the table is enormous; the CDC replication slot gets stuck and the primary's disk fills up; and the subtlest — someone forgets the outbox on a "small" route and publishes directly, and dual write quietly comes back. (For some teams, "no publishing directly to the broker" is a lint rule or a line in the code review checklist.)

---

## 3. Key Takeaway

- **Command** = "do this" (one recipient, can be refused); **event** = "it happened" (a fact, the publisher doesn't know the listeners) — names in the past tense, and no commands disguised as events
- **Choreography** reduces the producer's coupling, makes new consumers cheap, gives temporal decoupling — the price is invisible flow, chains of events, eventual consistency, harder debugging. Side effects on events, the main work and complex coordination direct/orchestration
- How much data in an event: **notification** (small, but calls back), **event-carried state transfer** (consumers independent, but copies and bigger events), **event sourcing** (events are the source of truth — a separate, big decision)
- **Dual write** isn't fixed by any order: commit-first lost 41 events, publish-first made 41 phantoms; in a Redis outage one silently lost 449, in the other 534 people couldn't comment at all
- **Transactional outbox**: the event row in the same transaction, the relay sends later — 0 lost, 0 phantom, the feature works even with the broker down; the price is at-least-once (duplicates with the same eventId — needs an idempotent consumer) and a little delay
- The relay: `SKIP LOCKED`, a partial index, small batches, cleanup; **a flag, not a cursor** (id order ≠ commit order); instead of polling, **CDC** reads from the WAL in commit order, but it's a new system to run
- The event's contract: a fixed eventId, occurredAt, version, key; change only by adding; consumers parse, unknown goes to the DLQ; never secrets

---

## 4. New Terms (Glossary)

| Term                             | Meaning                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Command**                      | Asking one specific recipient to do a piece of work — the recipient can do it or refuse; the name is imperative                          |
| **Event**                        | News of something that has already happened — a fact; the publisher doesn't know who's listening; the name is in the past tense          |
| **Choreography**                 | Without a central director, each service listens to events and does its own part — the opposite of orchestration                         |
| **Event-carried State Transfer** | Sending the data consumers need with the event itself, so they don't go back and ask the producer                                        |
| **Dual Write**                   | Writing to two separate systems for one piece of work, without a shared transaction — a break in between writes one and not the other    |
| **Transactional Outbox**         | Writing the event into an outbox table in the same transaction as the business data; a relay later sends it to the broker                |
| **Change Data Capture (CDC)**    | Reading the database's own ledger of changes (the WAL) and turning each change into an event — in commit order, without application code |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. Design TaskFlow's `task.completed` event. Consumers: notification (emails to the assignee and watchers — needs their names and the task's title), analytics (project, time), billing (workspace, month), customer webhooks (what can be shown to the customer). Exactly which fields will you put in the event, and which won't you — and why? Three months later product asks to add "who completed it" (`completedBy`), and to rename `projectId` to `boardId` — how will you make each change so that no consumer breaks?
2. A teammate built an outbox, but a little differently: the relay keeps the last sent outbox `id` in a Redis key, and reads with `SELECT … WHERE id > :last ORDER BY id LIMIT 100` each time; sent rows aren't deleted immediately, but after 7 days. And to increase throughput it runs three relays. Find at least three separate mistakes — what is lost or done twice in each — and fix them.
3. A choreography chain: TaskFlow has three consumers — (a) "parent auto-close": when all subtasks are complete it completes the parent (which in turn emits `task.completed`); (b) "sprint auto-advance": when all of a sprint's tasks are complete it closes the sprint, opens the next, and moves the unfinished tasks (`task.moved`); (c) "recurring task": when a recurring task is completed it creates next week's copy (`task.created`). When all the subtasks of the parent of a recurring subtask are complete, write in order what happens. Where are the dangers (loops, order, partial failure)? Will this flow stay in choreography, or become something else?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

```typescript
{
	eventId: 'uuid',                 // fixed, dedupe
	type: 'task.completed',
	version: 1,
	occurredAt: '2026-…',            // the moment of completion
	workspaceId: 12,                 // billing, and partition/tenancy
	projectId: 7,                    // analytics
	taskId: 42,                      // key (7.2)
	title: 'Release 2.1 notes',      // notification and webhooks — so they don't call back
	assigneeId: 9,
	watcherIds: [3, 5]               // notification — but if it's large, only IDs, not emails
}
```

What I won't include: users' email addresses (the notification service gets them itself, or from the user service — email is personal information and shouldn't be spread through the event log), the task's full description (large, and not everything is fit for every customer to see in a webhook — it's better to build a separate external payload for webhooks, not send the internal event straight to customers), permissions or internal flags.

The changes: `completedBy` — added as an optional field (`completedBy?: number`), `version` can stay the same (an additive change); old consumers ignore it, and new consumers handle its absence. `projectId` → `boardId` — a rename is a breaking change. The way: send **both** for a while (`projectId` and `boardId`, the same value), move the consumers to `boardId` one by one, and when all have moved (the consumer list — 1.7 — is useful here) drop `projectId` in `version: 2`. Never rename in one deploy.

**Question 2:**

1. **A cursor and commit order:** the transaction with id 10 is slow, id 11 commits first; the relay sends 11 and the cursor goes to 11 — 10 is never sent. **Events are lost**, silently. The fix: not a cursor, a `publishedAt IS NULL` flag (as in the exercise) — or CDC, which reads in commit order.
2. **The cursor in Redis, publishing to Redis too, but the rows in Postgres:** the relay published, then died before updating the cursor → sends again (a duplicate — this is at-least-once, acceptable). But if Redis's data is lost (7.3's 1.8 — async replication on failover) the cursor goes backwards → old events again (a big wave of duplicates), or if the cursor is lost, from zero — all 7 days again. And the cursor and the publish are two separate writes — dual write again, inside the relay. The fix: the mark of "what's been sent" goes on the outbox row itself, in the same database.
3. **Three relays, no locks:** all three read the same `WHERE id > :last` and send the same rows → every event three times; and the three cursors overwrite each other. The fix: `FOR UPDATE SKIP LOCKED` (each row to one relay), or just one relay (active-passive, a leader via a lock — 6.1). And with three relays per-task order isn't preserved — two events of the same task can land in two relays and go out in reverse order. If throughput really is needed, split by key (`taskId % 3`).
4. (Bonus) Not deleting for 7 days is fine for the `id > :last` search (an index), but moving to the flag approach needs a partial index (`WHERE publishedAt IS NULL`) — otherwise it's a search over millions of rows.

**Question 3:** The order (one possible one):

1. The last subtask S (recurring) is completed → `task.completed(S)`
2. (c) recurring: next week's copy S' of S is created → `task.created(S')` — **under the same parent?** Then the parent now has an unfinished subtask
3. (a) parent auto-close: hears `task.completed(S)` and checks "are all subtasks complete?" — yes if it checks before step 2, no if after. **A race** — two consumers on the same event, and the result depends on who runs first
4. If the parent is completed → `task.completed(parent)` → (a) again (for its parent), (b) sprint, (c) if the parent is recurring too…
5. (b) all of the sprint's tasks complete → the sprint closes, the next opens, unfinished tasks move → `task.moved(S')` — will S' go into the new sprint? And if step 2's `task.created` arrives (late) after the sprint has closed, which sprint is S' in?

The dangers: **a race** (the outcome of two consumers on the same event depends on order), **chains/loops** (completed → created → … a sequence nobody designed; with a recurring parent, a chain week after week), **partial failure** (the sprint closed, moving the tasks got halfway and the consumer died — nobody owns the whole flow, so nobody restarts or rolls it back), and **invisibility** (nobody can read one place and say what will happen).

The decision: this flow is a business rule, order matters, and it needs an owner — not a place for choreography. Parent auto-close inside the task service in the same transaction (1.7), sprint advance an explicit **orchestrated** process (a "sprint close" command, one coordinator that runs the steps in order and knows where it is if it fails — Lesson 9.3's saga). Make the rule for creating recurring copies clear (the new copy outside the parent, or not counted in the parent's "all subtasks"). And notification, analytics — these stay on events; they change nothing, they only listen.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (Postgres + Redis in Docker; the writer and the relay really are `SIGKILL`ed midway)

> **Ready to run in the repo:** [`exercises/lesson-7.5-outbox/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.5-outbox) — `docker compose up -d --wait && npm install`, then `npm run scenario` (three modes in a row, ~40 seconds). The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in that folder's `README.md`.

`writer.ts` creates comments in three modes and `SIGKILL`s itself exactly between the two writes; `relay.ts` sends from the outbox to the Redis Stream (`FOR UPDATE SKIP LOCKED`), and it too sometimes dies between sending and committing; `scenario.ts` starts new ones in place of dead writers/relays, stops Redis if asked, and at the end reconciles Postgres's comments with the stream's events by comment id.

**Honest note:** verified by running it in the sandbox with Postgres 17 and Redis 8 in Docker: `tsc --noEmit` is clean; `npm run scenario` several times — the writer's 41 crashes, `commit-first`'s 41 lost and `publish-first`'s 41 phantoms were exactly the same every time (the crash is decided by the comment's id); the outbox's extra events and relay crashes change between runs (101–160 extra on this machine), but 0 lost, 0 phantom, and "distinct eventIds = number of comments" every time. The README's experiments 1, 2, 3 and 5 were run; 4 is a drawing-by-hand task. There's no CDC (Debezium) here — a polling relay. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Match incidents 1–3:** run `npm run scenario`. Which cell of the comparison table is each of TaskFlow's three incidents? Then experiment 1 (the Redis outage) — `commit-first`'s 449 and `publish-first`'s 534 — in one line each, what the damage looks like through the user's eyes.

2. **Where the extra events come from:** roughly explain the outbox's "extra" number from the number of relay crashes and the batch size (on average, how many events go again per crash?). Then write a small consumer (Redis `XREADGROUP`) that dedupes by `eventId` and writes to a `search_index` table — with 7.4's technique 6 — and show that the table has exactly 1959 rows.

3. **The ordering trap** (experiment 4): draw a timeline — two writers, ids 10 and 11, 11 commits first — and show what happens with the `publishedAt` flag approach and with the `id > cursor` approach. Then: can two comments on the same task (two separate transactions) reach the stream in reverse order? When?

4. **Batches and the relay** (experiment 3): run batches of 50 and 5 with `RELAY_CRASH_RATE=0.05`, and calculate 0.95^batch. What batch size will TaskFlow's relay use, and what metric will tell you the relay is "stuck"?

5. **Design part:** a list of TaskFlow's events — at least six (`comment.created`, `task.created`, `task.assigned`, `task.completed`, `task.moved`, `member.invited` …). For each: the schema (with fields), the key, which consumers and what they do, and in which route's which transaction the outbox row is written. Then look for a chain like question 3's in your list — is there one? If so, how will you handle it?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (complete, including exit challenges), 7.1, 7.2, 7.3, 7.4
Current: 7.5 — Event-Driven Architecture basics
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; an outbox_events row in every write route's transaction → polling
relay (SKIP LOCKED, partial index, small batches, publishedAt flag, deleted after 7 days) → Redis
Streams; every consumer idempotent (eventId/effect key); task.completed's side effects via
choreography (notification, analytics, billing, webhooks, sprint progress), parent
auto-close inside the task service; event schema: eventId, type (past tense), version,
occurredAt, key — additive changes; BullMQ jobs (7.3/7.4) are born from event consumers
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF, Idempotent Consumer, Retry Storm, Jitter,
Poison Message, Dead Letter Queue, Backpressure, Load Shedding, Command, Event,
Choreography, Event-carried State Transfer, Dual Write, Transactional Outbox, Change Data
Capture
Weak spots: [where you got stuck — fill this in yourself]
Next: 7.6 — Batch vs Stream, OLTP vs OLAP
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your deduping consumer in #2 and your list of events in #5. When you are ready, write `next` — we'll go to Lesson 7.6: **Batch vs Stream, OLTP vs OLAP — which path when.** Today every change in TaskFlow goes into the stream as an event. The analytics team now wants a dashboard from that stream of "how many tasks were completed in which project this week" — and finance wants every workspace's monthly usage for last year. Will the first be calculated as each event arrives (stream), or once a night for the whole day (batch)? And what happens if the second question is run on TaskFlow's production Postgres — why is the database that "has all the data" exactly the wrong place for this question? Module 7's last lesson.
