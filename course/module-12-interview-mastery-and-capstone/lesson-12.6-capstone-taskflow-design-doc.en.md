# Lesson 12.6 - Capstone: TaskFlow Complete Design Doc

**Module 12 - Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 5.5):** What is a lost update? And does Postgres's default isolation level (READ COMMITTED) prevent it? If not, which level catches it, and when it does, what does the application have to do? Today's core piece's first test is exactly this question, with 50 people at once.

**Prerequisite:** the whole course. Especially Lessons 1.2 (framework), 2.5 (Idempotency-Key), 5.5 (Lost update), 7.4 and 7.5 (Retry, outbox), 9.1 (Modular monolith), 10.3 (Failure), 10.7 (Cost), 10.8 (Multi-region), 12.2 (Estimation), 12.5 (Story bank)

**By the end of this lesson you will be able to:**

1. Write a full design doc for a system, the way it goes to a real team's design review: goals and non-goals, estimation, architecture, schema, scaling triggers, a failure mode table, cost, rejected alternatives, and open questions
2. Build and measure one of the doc's core pieces (TaskFlow's task write path) in real code to show that the doc's claims are true: nothing is silently lost on concurrent edits, no duplicates on retries, no lost or phantom emails on a crash
3. Tie eleven modules' decisions into one coherent story, which becomes the strongest story in 12.5's story bank

**Tier:** 1 - Runnable Code (the core piece: Postgres + Redis in Docker, Express + Sequelize + Zod + BullMQ; five scripts, real HTTP)

---

## 0. Where TaskFlow Is Right Now

In Module 1 TaskFlow was one Express server and one Postgres, 100 users. Eleven modules later: a CDN, a gateway, two BFFs, a modular monolith and a separate billing service, a Postgres primary and three replicas, a cache ring, an outbox and a queue, observability, DR in Mumbai, and an EU cell in Frankfurt. Every piece came from a bad week: an outage, a lost edit, a bill.

But this whole picture still isn't **written down in one place.** When a new engineer joins they'd have to read eleven postmortems. And if someone asks "what breaks if we triple next year?", the answer is in someone's head, not on any page.

Today we write it: a TaskFlow design doc, the way a team takes one to its design review. The curriculum said we'd decide the scope together. You chose **the task write path** as the core piece: creating, moving and assigning a task, and a notification on assignment. TaskFlow's most central path, and where four of the course's biggest lessons (lost update, idempotency, dual write, at-least-once) come together. The rest of the doc is on paper. This part is in real code, with measured numbers.

**Design Doc** - a written form of a proposed (or current) design, for the team's review: what the problem is, what the goals are and what they aren't, what the design is, from which numbers, which alternatives were rejected and why, what can break, what it costs, and what still isn't known. Its job is to catch mistakes before code is written, and afterwards to keep the answer to "why is it like this".

Section 1 below is itself the doc. I'm writing it the way it would go to a real review.

---

## 1. Theory - TaskFlow Design Doc

```
Title:    TaskFlow - system design, the state in 2026 and the plan for the next 12 months
Status:   Draft, for review
Date:     2026-10-06
Scope:    the whole platform's picture; detailed design and implementation of the core write path
```

### 1.1 Context and goals

TaskFlow is a team task management app: workspaces, boards, columns, tasks, comments, attachments, share links, notifications, and paid plans. Web (SvelteKit) and mobile clients.

**Goals (next 12 months):**

- Handle ~3× today's traffic without a big change to the design
- The board-open SLO: 99.9% success, and in 30 days 99% of boards under 500 ms (10.4)
- No write silently lost: on a concurrent edit the loser knows they lost, no duplicates on retries, no lost or phantom notifications on a crash
- DR: if the home region (Singapore) is lost, RPO ~5 s, RTO ~40 minutes; in the EU cell RTO ~27 minutes (10.8)
- All personal data of EU customers in the EU (10.8)

**Non-Goal** - the things this design deliberately **doesn't** solve, written down clearly so nobody in the review assumes they're covered, and the scope doesn't creep. TaskFlow's non-goals:

- Writing together in a task's description like Google Docs (OT/CRDT). Two people changing the same task at the same moment is rare (measured in 1.8); a 409 on conflict is enough.
- Writing in several regions at once (active-active). 10.8's pilot silently lost ~2,000 edits a day; all writes in one region.
- Breaking everything into microservices. The modular monolith stays (9.1); only billing and files processing have been pulled out.

### 1.2 Estimation

From the earlier lessons' measured numbers, in 12.2's chain. Where a number is assumed, it says so.

```
Today:          ~300 req/s on average (10.4) → ~26 million requests a day
                writes ~10% (10.8) → ~30 writes/s on average; peak × 3 → ~90 writes/s, ~900 req/s
In 12 months ×3: peak ~2,700 req/s, ~270 writes/s, ~2,430 reads/s
Outbox:         ~1.5 events per write on average (assumed) → today ~3.9 million a day, × 500 B ≈ 2 GB/day; kept 7 days → ~14 GB
Task rows:      ~20% of writes are new tasks (assumed) → ~500,000 a day × ~2 KB (with indexes) ≈ 1 GB/day → ~380 GB a year; ~1.1 TB at ×3
The write path: measured on a laptop at ~700 moves/s (1.8, load), each: a read + a conditional UPDATE + an outbox INSERT, in one transaction
```

**"So":**

- **There's no question of sharding for writes.** The peak 12 months out is ~270 writes/s, and Postgres in Docker on a **laptop** takes ~700/s on this write path. The production database machine is much bigger, but even without assuming that, a laptop gives ~2.6× headroom. (The medicine for 12.1's mistake 5, this time measured.)
- **Read load goes to replicas and the cache:** ~2,430 reads/s spread across three replicas and the board cache, with a replica in each AZ (10.7).
- **The storage question is about time, not size:** the task table may head towards ~1 TB a year. The problem isn't queries (there are indexes), it's **the time to restore from backup**: how many TB can be restored within an RTO of 40 minutes? So big, old, rarely read data like the activity log and the outbox is kept separately (1.5).
- **The outbox stays small** if it's deleted regularly (7 days): ~14 GB. If not, ~700 GB a year, and even though the relay's partial index saves it, vacuum and backups suffer.

### 1.3 Architecture

```
        [web (SvelteKit)]   [mobile]
               │                │
               ▼                ▼
          [CDN: static, images, share pages, TLS termination (10.8)]
                         │
                         ▼
          [API gateway: JWT validation, rate limits in two layers, request id (9.2, 9.5, 10.5)]
               │                          │
               ▼                          ▼
        [web BFF (SvelteKit server)]  [mobile BFF]
               │                          │
               └────────────┬─────────────┘
                            ▼
   [modular monolith: work · identity · files · search]  ──REST + breaker + bulkhead──►  [billing service (own DB)]
        │            │              │
        │            │              └──► [Redis: cache ring (160 vnodes)]   [Redis: limiter]
        │            ▼
        │   [Postgres primary] ──async──► [replica × 3, one per AZ] ──async──► [Mumbai: DR replica]
        │   (Patroni + etcd)
        │            │
        │            └── outbox_events ──relay (SKIP LOCKED)──► [Redis Streams] ──► consumer ──► [BullMQ: email, webhook, …]
        │
        └──► [S3: attachments (presigned, multipart), lifecycle] ──► [CDN signed URL]
             [files processing service: thumbnails, scanning]

   Everywhere: OpenTelemetry traces, structured logs, burn-rate alerts (10.4)
   EU cell (Frankfurt): the same stack, all data of EU workspaces; the global layer only routing and billing (10.8)
```

Three design principles that run through the whole picture:

- **One place of truth, for each thing.** A task and its events: the primary Postgres, the same transaction. Cache, replicas, search, Streams: all derived, rebuildable if lost.
- **The user is waiting → synchronous, everything else → events.** Writing a task is synchronous; notifications, analytics, webhooks, the search index, billing usage: from the outbox (7.5).
- **Every dependency is either hard or soft, written down.** For opening a board, billing and the replicas are soft (10.3). When a soft dependency dies, a feature hides, not the page.

### 1.4 Data model

The core tables, only what matters to the decisions:

```
workspaces(id, region, plan, created_at)                         -- region = the home cell (10.8)
users(id, email_hash, …)                                         -- routed to a cell by the email's hash
memberships(workspace_id, user_id, role, PK(workspace_id, user_id))
boards(id, workspace_id, name, share_slug UNIQUE NULL)
tasks(id, board_id, workspace_id, title, column, position, assignee_id NULL,
      version, created_at, updated_at)
      INDEX (board_id, column, position)                          -- opening a board
      INDEX (assignee_id) WHERE assignee_id IS NOT NULL           -- "my tasks"
comments(id, task_id, author_id, body, created_at)
idempotency_keys(key PK, request_hash, status_code, response_body, created_at)   -- deleted after 24 hours
outbox_events(id BIGSERIAL, event_id UUID UNIQUE, type, task_id, payload JSONB,
              created_at, published_at NULL)
      INDEX (id) WHERE published_at IS NULL                       -- the relay only looks at this
notifications(event_id PK, task_id, recipient_id, status, created_at)           -- the consumer's dedupe
activity(…) PARTITION BY RANGE (created_at), one per month; to Parquet on S3 after 90 days (10.7)
sagas(id, type, state, …)                                         -- task creation's billing saga (9.3)
```

Four decisions, each from an earlier lesson:

- **`tasks.version`:** every update is `WHERE id = ? AND version = ?`, and sets `version + 1`. If it doesn't match, 409 and the current state (5.5's optimistic lock).
- **`tasks.workspace_id` denormalized:** it can be derived from the board, but it's kept directly for every authorization check and as a future shard key (5.2, 10.5's BOLA).
- **Sequential ids aren't exposed** where there's an enumeration risk (an 8-character slug for share links, 10.2); internal ids are integers, because the index is small and fast.
- **The full response in `idempotency_keys`:** the same answer, the same status, on a retry (2.5). The request's hash goes with the key, so using the same key for a different request gives a 422.

### 1.5 Scaling plan: by trigger, not by date

**Scaling Trigger** - a measured number which, when it crosses a limit, starts a specific design change, written down in advance. Not "we'll shard next year", but "when the primary's CPU passes 60% at sustained peak writes, or ...". That way change comes when it's needed, not early (cost, complexity) and not late (an outage).

| stage | trigger (measured)                                                                                    | change                                                                                                       | why in this order                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 0     | today                                                                                                 | primary + 3 replicas, cache ring, autoscale (60%, min 3, max 40)                                             | 1.2: writes ~90/s, even a laptop does ~700/s                                        |
| 1     | replica CPU over 60% at peak for a week                                                               | another replica (one per AZ), review the board cache's TTL                                                   | the cheapest, no code change                                                        |
| 2     | the primary's write p99 over half the SLO at peak, or the database so big that restore > half the RTO | a bigger machine (vertical); activity and outbox into a separate database                                    | vertical first (1.6): a day's work; separating keeps things small and restores fast |
| 3     | one workspace alone over 10% of the primary's writes, or slowing others' p99                          | that workspace into its own cell (10.8's cell path, the same code)                                           | before hash sharding: the cell already exists, and a big tenant is the usual load   |
| 4     | still at the primary's limit after stages 2-3, or too many cells in one region                        | more cells within a region by workspace - meaning workspace_id is the shard key, routing in the global layer | every query is within a workspace, so cross-shard queries barely exist              |

Notice: TaskFlow's path to sharding isn't hash sharding, it's **cells.** The cell built for the EU in 10.8 is the same one for a big tenant, and later for everyone. One mechanism, three reasons (residency, a big tenant, size). And every trigger's number is a judgement, to be checked with a load test in production (1.10's open questions).

### 1.6 Failure modes

**Failure Mode Table** - for each important part of the system: how it breaks, how we'll know, what the user sees, and what the design does. Most review questions land here, and every row is a test that should be run in CI or on a game day (10.3).

| part                     | how it breaks                        | how we'll know                               | what the user sees                         | what the design does                                                                       |
| ------------------------ | ------------------------------------ | -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| primary Postgres         | dies                                 | Patroni, health checks                       | writes fail for a few seconds, then work   | Patroni failover; the client's retry carries the Idempotency-Key, so no duplicates         |
| replica                  | falls behind (the tail, 6.3)         | an alert on `replay_lag`'s p99               | nothing                                    | per-user version token; if a replica dies, boards from the primary (8-connection bulkhead) |
| cache node               | dies, or is added to the ring (10.1) | the miss rate, the DB's queries/s            | a bit slower                               | 160 vnodes, slow addition, single-flight                                                   |
| billing service          | slow or down                         | the breaker open                             | the plan badge hidden; task creation works | breaker + fallback (quota_pending, a nightly reconcile) (9.4)                              |
| outbox relay             | gets stuck                           | the age of the oldest unpublished event      | notifications late                         | several relays, SKIP LOCKED; events aren't lost, only delayed                              |
| notification worker      | dies after sending                   | job retries, the DLQ's size                  | nothing (1.8: 15 crashes, 0 duplicates)    | event-id dedupe in the consumer + the provider's idempotency key                           |
| two people change a task | at the same moment                   | the 409 rate (a metric)                      | the loser sees "this has changed"          | optimistic lock (1.8: of 50 people one 200, 49 409s, 0 silently lost)                      |
| flags service            | dies (10.3)                          | the snapshot's age                           | nothing                                    | defaults in code + the last snapshot in memory                                             |
| home region              | down for hours (10.8)                | probes, the provider's status                | down ~40 minutes, then served from Mumbai  | pilot-light DR, failover on a human's decision with one button; RPO ~5 s                   |
| deploy                   | in-flight requests die (10.6)        | a 5xx spike, the canary gate                 | nothing                                    | readiness 503 → drain → close; canary; expand/contract migrations                          |
| credential stuffing      | millions of login attempts (10.5)    | the login failure rate, the diversity of IPs | almost nothing for real users              | IP + email limits, a breached-password check, MFA                                          |

### 1.7 Cost

Adding up the earlier lessons' numbers:

```
core platform (after 10.7)              ~$8,276/month
DR, Mumbai (pilot light, 10.8)          ~$833/month
EU cell, Frankfurt (10.8)               ~$4,870/month
total                                   ~$13,979/month
```

**What grows with ×3 traffic over the next 12 months:** app instances (autoscale, roughly linear with traffic), egress and the CDN (linear), logs and traces (more than linear without sampling, 10.4), storage (it accumulates, so it grows with time, not traffic). What barely grows: the database primary (1.2's headroom; the same machine until stage 2), DR (pilot light), a cell's fixed part. So the total bill shouldn't triple; exactly how much has to be worked out line by line as in 10.7, and it's one of this doc's open questions. A line for "monthly price and its drivers" is mandatory in every design review (10.7).

### 1.8 The core piece: the task write path

This part of the doc isn't on paper, it's in code. The design:

```
 client ──POST /boards/:id/tasks (Idempotency-Key)──►  ┌─ one transaction ──────────────────────────────────┐
 client ──PATCH /tasks/:id { version, … }───────────►  │ idempotency_keys: INSERT … ON CONFLICT DO NOTHING │
                                                        │ tasks: INSERT, or UPDATE … WHERE version = ?      │
                                                        │ outbox_events: task.created / moved / assigned     │
                                                        │ idempotency_keys: the full response                │
                                                        └───────────────────────────────────────────────────┘
                                                                         │
             relay: SELECT … FOR UPDATE SKIP LOCKED → queue.add(jobId = event_id) → published_at
                                                                         │
             worker: notifications INSERT … ON CONFLICT DO NOTHING → sent? stop → provider.send(key = event_id) → sent
```

**The spaced repetition answer:** a lost update means two transactions read the same value, change it by their own calculation and write it back, and one's write is silently wiped out by the other's (5.5). Postgres's READ COMMITTED doesn't prevent it. REPEATABLE READ (and SERIALIZABLE) catch it, with a `40001` error, and then the application has to retry the whole transaction. We took a different path: staying on READ COMMITTED with an optimistic lock (`version`) at the application level, because here on a conflict the right behaviour is **telling the user, not retrying**: if two people assign the same task to two different people, the system "trying again" by itself and making the second one win is also a silent decision.

`npm run concurrency` - 50 people assign the same task at the same moment, each to a different person:

```
strategy                                   200   409  silently lost  emails  to the wrong person
read, then write (no version check)         50     0             49      50                   49
optimistic lock (WHERE version = ?)          1    49              0       1                    0
```

With read-then-write all 50 see "success", 49 people's choices don't hold, and 49 emails go to people the task wasn't actually given to: each request built its event from the stale state it read. This is a lost update's second harm, which 5.5 didn't show: **side effects coming out of wrong data.** With the optimistic lock one wins and 49 know they lost. And on an ordinary day its price is nearly zero: in `load`, 20 clients changing their own tasks, 0 conflicts in 7,552 moves.

`npm run idempotency` - 1,000 tasks created, 10% of responses lost on the way back (timeout), the client sends again:

```
client                                    requests   tasks  duplicates  replayed
retry without a key                          1,104   1,104         104         0
retry with the same Idempotency-Key          1,104   1,000           0       104

responses 201: 200/200 · replayed: 100 · tasks in the database: 100
```

The second part is subtle: the retry arrived **before** the first request finished, 100 pairs. Zero duplicates without any "in progress" state, because the second request's `INSERT ... ON CONFLICT DO NOTHING` waits on Postgres's unique index for the first one's commit, then reads its committed answer and returns it. The key, the task and the answer are in one transaction, so a half state is never visible.

`npm run crash` - 1,000 assignments, a crash at 2% of the risky moments:

```
write order                          tasks  emails  no email  email, no task  crashes
commit, then enqueue                 1,000     970        30               0       30
enqueue, then commit                   970   1,000         0              30       30
outbox in the same transaction       1,000   1,000         0               0       30
outbox, on top of the relay crashes: 15 worker crashes after sending the email; provider calls 1,015 for 1,000 emails
```

7.5's lesson, this time on TaskFlow's real route: changing the order changes the kind of damage, it doesn't remove the damage. Commit first and 30 people don't know they were given a task; queue first and 30 people get emails about a task that doesn't exist. With the outbox both are zero. And the price of at-least-once shows in the last line: the relay and the worker both crashed and ran again, 1,015 calls went to the provider, but exactly 1,000 emails, because there's idempotency by the event's id at every layer: `notifications`'s primary key in the consumer, the idempotency key at the provider. In the experiment, at a 10% crash rate the first two rows are 108 each, the outbox still zero.

`npm run smoke` runs everything together over real HTTP, 11 steps: idempotent creation, replay, a 422 for a different body on the same key, a move, a 409 on a stale version, an assignment, relay and worker crashes, and at the end exactly one email and zero unpublished events. And `load` gives the number in the doc's 1.2: on this laptop ~700 moves/s, p50 ~25 ms, p99 ~57 ms.

**The difference between doc and code, honestly:** in the production design the outbox goes to Redis Streams, and the notification consumer creates BullMQ jobs from there (7.5). In the exercise the relay sends straight to BullMQ, one layer fewer, because the question (writing and sending together) is the same in both. Authorization, rate limits, the saga and traces aren't in the exercise.

### 1.9 Rejected alternatives

**Alternatives Considered** - the part of the doc that records, for each big decision, the alternatives that were considered and **why they weren't taken**. It's the advance answer to "why not X?" in the review, and when someone proposes the same alternative two years later, the record of which condition would have to change for it to be reconsidered.

| alternative                              | why not, now                                                                                          | when to reconsider                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| full microservices                       | the team's size and boundaries aren't settled yet; the price of distributed transactions (9.1, 9.3)   | when a module's deploy rhythm and team diverge from the rest            |
| active-active writes, in several regions | 10.8's pilot silently lost ~2,000 edits a day                                                         | if latency demands can't be met from the home region, with a CRDT model |
| Kafka                                    | at ~90 events/s Redis Streams is enough; the cost of running another cluster (7.2)                    | when long replay history and many independent consumers are needed      |
| hash sharding today                      | 1.2: there's headroom for writes; the price of cross-shard queries and migration                      | 1.5's stage 4, on the cell path                                         |
| pessimistic lock (`SELECT … FOR UPDATE`) | a lock can't be held through the user's thinking time; a lock across two HTTP requests is meaningless | for a small read-modify-write inside the server (e.g. a counter)        |
| CRDT in descriptions                     | a non-goal; writing together is rare                                                                  | if user research shows demand for writing together                      |

### 1.10 Risks and open questions

- **The triggers' numbers aren't measured.** 1.5's 60%, 10%, "half the RTO" are judgement. Production hardware needs a load test and a restore drill (how many minutes to restore the whole database from backup).
- **1.2's two assumed numbers** (1.5 events per write, 20% of writes being new tasks) need checking against production metrics. Both change the storage and outbox size, not the design.
- **What the total bill is at ×3:** it needs a line-by-line model (1.7).
- **The idempotency key's expiry:** set at 24 hours. If a mobile client retries after more than a day offline, a duplicate is possible. To be settled once the mobile offline queue's behaviour is known.
- **The 409's UI:** what the losing user sees, and what they can do ("see the current state, try again"). A decision with product.

**Rollout:** the core write path's changes (the version column, idempotency, the outbox) in expand/contract (10.6): first add the column and tables, then the code runs both behind a flag, a canary on 1% of workspaces, widened while watching the 409 and duplicate metrics, and finally the old path removed.

---

## 2. Interview Angle

This doc helps in interviews in three ways:

- **On 12.5's question:** "Tell me about a system you designed". Now you have a full design doc and a measured core piece, as a learning project, told by that name (12.5's 1.6). The 5-minute story: the write path, 50 people's lost update and 49 wrong emails, the optimistic lock, and crashes in three orders.
- **In a design round:** this doc is the core of almost any CRUD-heavy system ("design Trello", "design Jira", "design a todo app at scale"). And the follow-ups are exactly 1.6's and 1.9's rows: "what if the primary dies?", "what if two people change it at once?", "why not Kafka?"
- **The senior signal:** stating the scaling plan with **triggers**, not dates; using the existing cell as the path to sharding; and bringing up non-goals and open questions yourself. A mid-level candidate gives a design; a senior says where the design ends, what isn't known yet, and which number will move them to the next stage.

**In real production:** a design doc's real value isn't on the review day, it's two years later. Someone will ask "why didn't we do hash sharding?", and the answer and the condition for reconsidering it are in 1.9's row. And the most common failure is never touching the doc again after writing it: the system changes, the doc stays as it was, and a new engineer learns the wrong picture. So with every big change, update the doc's relevant part, or write a small new doc that references it.

---

## 3. Key Takeaway

- **A design doc's job is to catch mistakes before the code and to keep the "why" afterwards:** goals, non-goals, estimation, architecture, schema, scaling triggers, failure modes, cost, rejected alternatives, open questions
- **With non-goals and open questions written down, the review is honest:** it's clear what isn't covered and what isn't known
- **Scale by trigger, not by date:** first replicas, then vertical and separating big data, then a big tenant into its own cell, finally cells by workspace - TaskFlow's path to sharding is cells
- **Measured numbers make the doc strong:** a laptop does ~700 moves/s on this write path, the peak 12 months out is ~270 - so there's no question of sharding for writes
- **A lost update's second harm is wrong side effects:** of 50 people 49's choices are silently lost **and** 49 emails go to the wrong person; with the optimistic lock one 200, 49 409s, 0 wrong emails
- **The Idempotency-Key in one transaction:** from 104 duplicates on 10% lost responses down to zero, even for concurrent pairs - waiting on the unique index is the "in progress" state
- **Writing and sending in one transaction, and dedupe at every layer:** with a dual write 30 lost or 30 phantom emails, with the outbox zero; exactly 1,000 emails from 1,015 provider calls

---

## 4. New Terms (Glossary)

| Term                        | Meaning                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design Doc**              | The written form of a design, for the team's review: problem, goals, non-goals, numbers, design, rejected alternatives, risks, cost, open questions - catching mistakes before the code, keeping the "why" afterwards |
| **Non-Goal**                | What the design deliberately doesn't solve, written down clearly - prevents wrong assumptions in the review and scope creep                                                                                           |
| **Scaling Trigger**         | A measured number which, when it crosses a limit, starts a specific design change, written in advance - change comes when needed, neither early nor late                                                              |
| **Failure Mode Table**      | For each important part: how it breaks, how we'll know, what the user sees, what the design does - every row a test for CI or a game day                                                                              |
| **Alternatives Considered** | The alternatives considered at each big decision, why they weren't taken, and which condition would have to change to reconsider - the advance answer to "why not X?" and a record for the future                     |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. In the review a senior engineer said: "With the optimistic lock a 409 means the user has to do it again. Changing a task's column (a move) is a drag-and-drop, users do it again and again. When two people work on the same board, won't the 409s be annoying?" (a) In which cases is a 409 needed and in which not - are a move and an assignment the same? (b) Give an alternative design for moves that reduces conflicts but silently loses nothing. (c) Which part of the doc does this decision go into?

2. 1.5's stage 3: "If one workspace alone is over 10% of the primary's writes, it goes into its own cell." (a) What metric is needed to measure this trigger, and how does 10.4's label-cardinality problem come up here? (b) What are the steps to move a running workspace from its home cell to a new cell, with no or little downtime? (c) What happens to that workspace's unpublished events in the outbox during the move?

3. In `npm run crash`'s outbox row, 1,015 calls went to the provider for 1,000 emails. (a) If the provider **didn't** offer an idempotency key, how many people would get two emails, and in what situation? (b) Inside the worker, what's lost by changing the order ("send, then write sent" vs "write sent, then send")? (c) Without the provider's idempotency key, which would you choose, and why - which lesson's which decision does it resemble?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) A 409 is needed for an assignment: giving a task to two different people is two conflicting decisions, and if one silently wins, the other stays under a false impression (and a wrong email goes out, 1.8). A move is different: two people taking the same task to two columns is a conflict, but moving **two different tasks on the same board** isn't, yet both may change `position`. If positions are dense integers (1, 2, 3 ...) and one move changes the positions of everything next to it, then moves of different tasks collide with each other too - that's where the annoying 409s come from.

(b) **Fractional positions:** each task's position is a number (or a string, lexicographic) between its two neighbours, so a move changes only that task's row, nobody else's. Then moves of different tasks never touch each other's version, and a 409 comes only when two people really change the same task at the same time. The price: now and then the room between two neighbours runs out (number precision or string length), and then a column's positions are re-laid out (rebalance) - a rare, background job. Another subtle path: a version per field (one for the column, another for the assignee), so one person's move and another's assignment don't block each other.

(c) In two places: 1.4's data model (the kind of position and the `version` rule), and 1.9's rejected alternatives (dense integer positions, why not). And an open question in 1.10: how often a rebalance will be needed, to be measured.

**Question 2:**

(a) The write rate per workspace. But making `workspace_id` a Prometheus metric label means thousands of workspaces, thousands of series (10.4's cardinality explosion). The path: not a label in the metric, but (1) counting the biggest N workspaces separately (top-K, with a structure like 10.2's count-min sketch), or (2) an hourly analytics query from the logs or the outbox's events ("writes per workspace in the last hour, top 20"). The trigger doesn't need minute-level precision; an hour is enough.

(b) One possible order: (1) copy the workspace's data to the new cell (a snapshot, then replicating ongoing changes, by logical replication or the outbox's events); (2) when the lag shrinks to a few seconds, make the workspace read-only for a short while (a few seconds to a minute); (3) once the last changes have arrived, workspace → new cell in the global layer's routing table (10.8); (4) lift read-only; (5) keep the data in the old cell for a while, then delete it. Downtime isn't zero, but it's only for writes and short - and the customer is told in advance.

(c) Before the move, wait until all of that workspace's unpublished events in the old cell have been sent (in the read-only state no new events arrive, so the outbox will empty). Then the new cell's relay takes over. The consumers are idempotent by event id, so even if an event goes twice at the boundary there's no harm - exactly 1.8's at-least-once principle.

**Question 3:**

(a) 15 people, the ones whose jobs were retried after a worker crash: the worker sent the email, then crashed before writing "sent", and on the retry the notification's row was `pending`, so it sent again. Had the provider not deduplicated, these 15 would have got two emails. (The jobs the relay sent again usually stop at the consumer's dedupe, because by then the row is `sent`.)

(b) "Send, then write sent" (ours): a crash in between means sending again on the retry - a **duplicate** is possible, not a loss. "Write sent, then send": a crash in between means the retry sees the row as `sent` and stops - the email is **lost**, not duplicated. The first is at-least-once, the second at-most-once.

(c) Usually at-least-once (our order): getting a task assignment email twice is annoying, not getting it means someone doesn't know about the work. But it depends on the kind of email: for an email like an OTP or "your card has been charged", a duplicate is also bad, and then the provider's idempotency key or a unique message id in advance is almost mandatory. It's like 11.5's notification decision (duplicate vs loss on failover), and a light form of 11.7's payments' "a timeout means I don't know": with external systems there's no exactly-once, only at-least-once and dedupe.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (Postgres + Redis in Docker; Express + Sequelize + Zod + BullMQ, real HTTP)

> **Ready to run in the repo:** [`exercises/lesson-12.6-capstone-taskflow/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-12.6-capstone-taskflow) - `docker compose up -d --wait`, `npm install`, then `npm run smoke`, `npm run concurrency`, `npm run idempotency`, `npm run crash`, `npm run load`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`smoke` runs the write path's 11 steps over real HTTP. `concurrency` compares read-then-write and the optimistic lock on 50 simultaneous assignments. `idempotency` measures lost responses and retries, including concurrent pairs. `crash` injects crashes into three write orders. `load` measures this write path's throughput and latency.

**Honest notes:** Verified by running in the sandbox on Node 26 and Docker (`postgres:17-alpine`, `redis:8-alpine`): `tsc --noEmit`, ESLint and Prettier clean; `smoke`, `concurrency`, `idempotency` and `crash` twice each, output byte-for-byte identical; `load` twice (711 and 755 moves/s - machine-dependent, a laptop, Postgres in Docker, a pool of 10 connections). The README's experiments 1 and 2 were run, numbers above. A crash is a simulated exception (the relay's transaction rolls back, the worker's job retries), not a real `SIGKILL` (7.5's exercise had real crashes); the email provider is fake. The rest of the design doc (1.1-1.7, 1.9-1.10) is on paper, from the earlier lessons' numbers; 1.2's two numbers and 1.5's trigger limits are assumed, written as open questions in 1.10.

**Once the setup checks out, do these five:**

1. **Guess first:** **before** running `crash`, write down what the first two rows' damage will be at a 2% crash rate, and how many provider calls the outbox will make. Then run it and compare. If the provider call count differs from your guess, why?

2. **Changing code - fractional positions:** question 1's (b). Make `position` a number between its two neighbours, and add a new part to `concurrency`: 50 people move 50 **different** tasks on the same board at once. With dense integers (where a move changes its neighbours' positions), how many 409s, and with fractional positions?

3. **Changing code - the README's experiments 4 and 5:** the client's retry on a 409, and the outbox cleanup job.

4. **Your own doc:** in this lesson's doc format (1.1-1.10), write a design doc for one of your own systems - the question from 12.1's exercise, or the project chosen in 12.5. At least: two non-goals, an estimation with three "so"s, a three-stage scaling trigger plan, a five-row failure mode table, three rejected alternatives, three open questions.

5. **Present the doc:** present this lesson's TaskFlow doc in 10 minutes to an imaginary reviewer, out loud, with a recording - practice for 12.5's 20-minute version. Then pick three rows from 1.6 and 1.9 where you think the reviewer will press hardest, and write a four-level depth ladder (12.5) for each.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 11 (complete, with exit challenges), 12.1 – 12.5
Current: 12.6 - Capstone: TaskFlow Complete Design Doc (core piece: the task write path, your choice)
TaskFlow state: the whole picture in one design doc - CDN, gateway, web/mobile BFF, modular monolith (work, identity, files,
search) + billing + files processing; Postgres primary + 3 replicas (Patroni), cache ring, limiter Redis; outbox → Redis
Streams → BullMQ; S3 + CDN; OpenTelemetry; DR in Mumbai (RPO ~5 s, RTO ~40 min); an EU cell in Frankfurt. Today ~300 req/s,
peak ~90 writes/s; at ×3 in 12 months → ~270 writes/s. The bill ~$13,979/month (core + DR + EU cell). Scaling by trigger:
replicas → vertical + separating big data → a big tenant into its own cell → cells by workspace. The core piece (measured):
on 50 simultaneous assignments read-then-write loses 49 silently + 49 wrong emails, the optimistic lock gives one 200 + 49
409s; with an Idempotency-Key, 10% lost responses go from 104 duplicates → 0 (even for concurrent pairs); at a 2% crash
rate a dual write gives 30 lost or 30 phantom emails, the outbox 0; 1,000 emails from 1,015 provider calls; ~700 moves/s
on a laptop.
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram, Content-Addressed Block, Content-Defined Chunking, Change Journal,
Namespace, Conflicted Copy, Dedupe Side Channel, Design Narrative, Impact Metric, Retrospective Insight, Depth Probe,
Ownership Signal, Story Bank, Design Doc, Non-Goal, Scaling Trigger, Failure Mode Table, Alternatives Considered
Weak spots: [where you got stuck - write it yourself]
Next: Module 12 Exit Challenge
=======================
```

---

## 8. Next Step

Today's thread: **each of eleven modules' decisions came from a bad week; the design doc ties them into one picture, and next to each, its reason, its number, and the condition under which it will change.** And the doc's claims are strongest when a part of it is measured in code: 49 wrong emails from 50 people, 104 duplicates, 30 lost notifications - and next to each, zero.

When you are ready, write `next` - **Module 12 Exit Challenge,** the end of the whole course. There'll be one last mock: a new system, 60 minutes, without the help of any script or closed section, with follow-ups that each test a skill from one of this module's lessons; a self-check for the whole course; and what to read next, what to build, and what to do in the week before an interview.
