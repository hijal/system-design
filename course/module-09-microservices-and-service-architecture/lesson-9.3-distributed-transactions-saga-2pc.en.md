# Lesson 9.3 — Distributed Transactions: Saga Pattern, 2PC

**Module 9 — Microservices & Service Architecture**

> **Spaced Repetition (Lesson 6.2):** In Raft, does the cluster stop when the leader suddenly dies? How many nodes' consent does electing a new leader need — all of them, or most of them? Today we look at an older protocol where the answers to those two questions are different — and that difference is its greatest weakness.

**Prerequisite:** Lesson 2.5 (Idempotency keys), Lesson 5.5 (Transactions, locks, isolation), Lesson 6.1 (Partial failure, the uncertainty of a timeout), Lesson 6.2 (Raft, majorities), Lesson 7.4 (Idempotent consumers, retry, DLQ), Lesson 7.5 (Outbox), Lesson 9.1 (Database per service, the 83 mismatches), Lesson 9.2 (Synchronous vs events)

**By the end of this lesson you will be able to:**

1. Say how **two-phase commit** works and where it breaks — how an **in-doubt** transaction and its locks stop everyone else when the coordinator dies, with measured numbers; and why almost nobody uses 2PC between services while databases like Spanner use it internally
2. Design a **saga** — the order of steps, each step's reverse action, the pivot, the saga's log and recovery, idempotent steps — and choose between orchestration and choreography
3. Recognise the price of a saga having no isolation (others see the middle) and address it with tools like a **semantic lock** — deciding which error you are willing to tolerate

**Tier:** 1 — Runnable Code (Postgres in Docker — two separate databases as two "services"; real 2PC with Postgres's `PREPARE TRANSACTION`, and a saga orchestrator with its log and recovery)

---

## 0. Where TaskFlow Is Right Now

Lesson 9.1's decision was: billing does not get extracted now — because "create task" and incrementing usage are in the same transaction. In Lesson 9.2 a gateway and BFFs went in front. Meanwhile TaskFlow started taking card payments through Stripe, and its first big customer asked for a security audit report. Three things:

1. **The audit.** The auditor's condition: billing's data (card tokens, invoices, payments) in a separate database with separate access — the web app's database user must not be able to touch it at all; billing's code with its own review and its own deploy. Billing has to come out. What blocked it in 9.1 — the shared transaction — now needs an answer.
2. **A week in staging.** Billing in a separate database, with two separate writes as in 9.1. Finance's report: the free plan's limit is 100 tasks, yet several workspaces have 103; and in some the invoice shows more tasks than actually exist. Two causes: requests dying mid-way during a deploy, and tasks that failed on "project archived" — whose usage had already been incremented.
3. **A plan upgrade.** A customer's card was charged, but the workspace did not move to pro — the billing service restarted right after the charge. Support ticket: "you took the money and I got nothing." An engineer refunded it by hand.

Two proposals on the team. One, from someone with DBA experience: "Postgres has two-phase commit — `PREPARE TRANSACTION`. Let's bind the two databases into one transaction and be done." The other: "In microservices the answer to this is a saga — each step commits separately, and failures are undone by a reverse action." The CTO: "Measure both — the same 3000 operations from 9.1, the same 83 crashes."

---

## 1. Theory

### 1.1 What we want, and why it is not easy

Recall 9.1's result: 3000 "create task" operations, with a crash after the first write in 83 of them. One transaction in one database — zero mismatches. Two writes across two databases — 83 mismatches, and the write ordering decides which direction they fall.

We want Lesson 5.5's **atomicity** — either both writes happen or neither — but across two databases each of which can only commit **its own** part. Why is that hard? Two truths from Lesson 6.1: anyone can die at any moment, and there is no way to know for certain what happened on the other side of the network (a timeout means "I don't know", not "it didn't happen").

There are two old answers to this, with opposite philosophies:

- **2PC:** everyone gets "prepared" before anyone commits, and then one party decides. Atomic — but everyone holds locks and waits until the decision arrives.
- **Saga:** each step commits immediately, and if something goes wrong the earlier steps get a reverse action. Nobody waits — but everybody can see the middle.

### 1.2 Two-Phase Commit — "everyone agree? then commit"

**Two-Phase Commit (2PC)** — a protocol in which one coordinator brings several participants (databases) to one decision in two phases: in phase 1 (prepare) each participant makes its own part durable on disk and says "yes, I can commit" (or "no"); if all say yes the coordinator writes the commit decision to its own log, and in phase 2 tells everyone. If even one says no, everyone rolls back.

```
  coordinator (work service)          tasks_svc                  billing_svc
  ──────────────────────────          ─────────                  ───────────
  BEGIN, do the work ─────────────►   INSERT task (takes locks)  UPDATE counter (takes locks)

  phase 1: "PREPARE?" ─────────────►  durable on disk → "yes"    durable on disk → "yes"
           ◄──────────── two "yes"es ────────────

  decision: "commit" in its own log  ◄── this write IS the whole transaction's moment of commit

  phase 2: "COMMIT" ───────────────►  commit, release locks      commit, release locks
```

The heart of it is the word "prepare". A participant makes a promise: "I will be able to commit — even if I die right now and come back up." That is why it writes its part to disk. And in exchange it gives up its own freedom: from now on it can neither roll back nor commit on its own — only on the coordinator's word.

Postgres really does have this — the core of the exercise's coordinator:

```typescript
// exercises/lesson-9.3-saga-2pc/src/twopc.ts — the coordinator (abridged)
await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
await a.query(insertTask, [op.workspaceId, op.title]); // tasks_svc — holds the locks, no commit
await b.query(bumpCounter, [op.workspaceId]); // billing_svc — holds the locks, no commit
// phase 1 — after this neither database can decide on its own anymore
await Promise.all([
	a.query(`PREPARE TRANSACTION '${gid}:tasks'`),
	b.query(`PREPARE TRANSACTION '${gid}:billing'`)
]);
// the decision — in the coordinator's own log
await a.query('INSERT INTO twopc_log (gid, decision) VALUES ($1, $2)', [gid, 'commit']);
// phase 2
await Promise.all([
	a.query(`COMMIT PREPARED '${gid}:tasks'`),
	b.query(`COMMIT PREPARED '${gid}:billing'`)
]);
```

The two writes take locks without committing; after the two `PREPARE TRANSACTION`s neither database can decide anything on its own any more; the coordinator's own log write is the decision; then phase 2. (`PREPARE TRANSACTION` is off by default in Postgres — `max_prepared_transactions = 0`. Postgres's own documentation says it is not meant for applications but for an external "transaction manager". In the Java world the standard for this is called **XA**; MySQL has XA too.)

The exercise's `npm run twopc`, part A — 9.1's same 3000 operations and same 83 crashes:

```
── A. 3000 "create task", 100 workspaces, crash after the first write in 83 (3%), 8 concurrent ──
   path                                     ok failed    tasks  counter   bad ws   result                  ops/s      p50
   monolith: one transaction (9.1)        2917     83     2917     2917        0   they match               2775   2.3 ms
   services: two separate writes (9.1)    2917     83     3000     2917       57   83 tasks with no bill    1594   4.4 ms
   services: 2PC                          2917     83     2917     2917        0   they match               1027   7.1 ms
```

- **2PC has zero mismatches.** If the coordinator dies before PREPARE its connection drops, and the two databases roll back their halves on their own — just like the monolith. The DBA was right: 2PC really is atomic.
- **The price:** 1027 ops/s instead of the monolith's 2775, p50 from 2.3 to 7.1 ms — slower even than two separate writes. Count why: 6–7 sequential round trips from the coordinator's side, and **five** writes that wait to be durable on disk (two PREPAREs, the log, two COMMIT PREPAREDs) — against one in the monolith. And for that entire time both databases' rows are locked, at the pace of the slowest participant. (The timing numbers move between runs — the monolith ranged 1973–3666 ops/s across runs; 2PC was always lowest.)

The price could have been paid. The real problem is elsewhere.

### 1.3 2PC's weakness — when the coordinator dies

What if the coordinator dies **after PREPARE and before COMMIT**?

**In-doubt Transaction** — a transaction that has been prepared at a participant but whose coordinator decision (commit or roll back) has not arrived. The participant cannot decide for itself (it made a promise), so it holds its locks and waits — until the coordinator returns. This is why 2PC is called a **blocking** protocol.

Part B: five workspaces' transactions left in doubt (out of 100), then 8 clients creating new tasks for 3 seconds:

```
── B. The coordinator died after PREPARE, before COMMIT — 5 workspaces' transactions "in doubt" ──
   left prepared: 5 in tasks_svc, 5 in billing_svc · "commit" in the coordinator's log: 2
   reading workspace 1's task_count (SELECT): 0 — 0.4 ms, not blocked (MVCC: the committed old value)
   then 8 clients creating new tasks for 3 s (2PC, random among 100 workspaces):
   billing's lock_timeout       ok   ops/s    lock fails       p99       stuck at end   all stuck at
   none (Postgres default)      90      30             0   23.9 ms              8 / 8   at 156.8 ms
   200 ms                     1348     449            57  317.8 ms              0 / 8   —
```

- **Reads do not block** — Lesson 5.3/5.5's MVCC: a SELECT sees the committed old value. It is **writes** that block.
- **Without `lock_timeout`: all 8 of 8 clients were stuck within 157 ms.** Each client works on a random workspace; with 5% probability it picks one whose counter row is held by an in-doubt transaction — and there it waits forever. 90 tasks in three seconds, then zero. The other 95 workspaces are blameless, yet their work stopped too — because every client is stuck. README experiment 1: just **one** in-doubt transaction (1 out of 100) — everyone stuck within 806 ms. Lesson 7.1's cascading failure, this time through locks.
- **`lock_timeout` 200 ms:** nobody waits forever, but 5% of requests fail and p99 is 318 ms — not 200, because `lock_timeout` is counted separately for each lock wait: with two clients queued on the same workspace the second waits nearly twice. A timeout limits the damage — the in-doubt transactions are still sitting there.

So why does billing not just decide for itself? Part C:

```
── C. What next: deciding the in-doubt transactions ──
   who decided                                  tasks_svc              billing_svc            bad ws   result
   coordinator, from its log (none → rollback)  commit 2 · rollback 3  commit 2 · rollback 3       0   they match
   billing rolled back alone, then coordinator  commit 2 · rollback 3  commit 0 · rollback 5       2   2 tasks with no bill
```

- **The coordinator returns and reads its log:** those with "commit" in the log (2) get committed; those without (3) get rolled back, because absence from the log means the commit decision was never made (this rule is called "presumed abort"). Zero mismatches.
- **Billing rolled back rather than waiting:** the 2 whose decision was commit got committed by tasks — but do not exist in billing. Two mismatches. Billing had no way to know: the coordinator might have written commit and told tasks before it died. (In commercial databases this is called a "heuristic decision" — and cleaning up the consequences is a human's job.)

**The spaced repetition's answer:** in Raft, when the leader dies the others elect a new one — with **most** of them consenting (3 of 5) — and the cluster carries on. In 2PC both are reversed: committing needs **everyone's** yes, and the decision is known to exactly **one** party — the coordinator, whom nobody can stand in for. So the fix also came from consensus: Jim Gray and Leslie Lamport's 2006 "Paxos Commit" — keeping the coordinator's decision on several nodes via Paxos, so it is not lost when one dies. (3PC — three-phase commit — was another old attempt, but it assumes there is a bound on network delay, which is not true in reality — Lesson 6.1.)

**2PC is not dead — it moved inside the database.** Google Spanner, CockroachDB and YugabyteDB use 2PC (or a variant) to run transactions across shards — but there every participant and the coordinator are themselves a Raft/Paxos group. A coordinator "dying" is a leader change — the decision is not lost, and there is almost no blocking. Kafka's transactions are internally 2PC-like too — but only across Kafka's own partitions.

**So why not between TaskFlow's services?**

- **Blocking** — you just saw it. Plus the warning in Postgres's documentation: a prepared transaction left sitting for a long time stops VACUUM from cleaning old rows, and in the extreme the database shuts itself down (to protect against transaction ID wraparound).
- **Everyone has to be alive at once** — Lesson 9.1's availability multiplication, this time on every write.
- **External systems do not understand PREPARE.** Incident 3's Stripe charge, an email, another company's API — you cannot tell any of them "get ready, I'll tell you later". Redis, most message brokers and many managed databases have no XA either.
- **Locks cross the boundary.** The work service's coordinator holds locks on billing's rows — exactly the entanglement that separating services was meant to escape in 9.1.

The rule: if you find 2PC **inside** a database (with its own replicated coordinator) — use it, you will not even notice. Do not build it yourself between your own services.

### 1.4 Saga — small commits, and reverse actions

**Saga** — dividing one large business transaction into several steps, each of which is an ordinary local transaction in one service's own database (committing immediately); if a step fails, the earlier successful steps get reverse actions, in reverse order. (Hector Garcia-Molina and Kenneth Salem, 1987 — originally to avoid long transactions holding locks inside one database; the idea became popular again with microservices.)

**Compensating Transaction** — the business reverse of a step that has already committed. It is not a rollback (that is no longer possible after a commit) — it is a **new** write that cancels the effect: releasing a reservation, refunding a charge, an email saying "the previous email was wrong".

TaskFlow's "create task" as a saga:

```
  step                 local transaction (whose database)             reverse action on failure
  ────                 ──────────────────────────────────             ─────────────────────────
  1. reserve usage     billing: task_count + 1, if within the limit   billing: task_count − 1 (release)
                       (if not — "limit reached", saga ends, nothing to undo)
  2. create the task   work: INSERT task                              — (last step)

  happy path:          [1 ✓] ──► [2 ✓] ──► done
  project archived:    [1 ✓] ──► [2 ✗] ──► [reverse of 1] ──► done ("returned")
```

**Which step first?** The step that can say "no" for business reasons (limit reached, card declined) and whose reverse is cheap goes first. The step that cannot be reversed goes as late as possible. Here the reservation is first, because "limit reached" is not the most likely outcome; and creating the task first and deleting it later means the user might glimpse it, and a notification might go out.

**Pivot Transaction** — the step in a saga after which there is no way back (it cannot be reversed, or reversing is very expensive). The steps before it can be compensated; those after it can only go forward — so the later steps have to be ones that will eventually succeed if retried.

Incident 3's plan upgrade, as a saga:

```
  1. billing: create a 'pending' subscription            reverse: 'cancelled'
  2. Stripe: charge the card (Idempotency-Key = saga id)  ◄── pivot: the money moved — forward only from here
  3. billing: subscription 'active'                       retry — will not fail for business reasons, only be delayed
  4. identity: workspace plan = pro, raise the limit       retry
  5. notifications: receipt email (event)                  retry
```

What actually happened in incident 3: the pivot succeeded, then a crash — and steps 3–4 were never run by anyone. What was needed was not a refund (that is compensation — the wrong direction after a pivot); what was needed was someone who knows "this saga got as far as step 2" and finishes the rest. That is 1.5. And if the card had been declined (step 2 failing) — only step 1's reverse.

Three subtleties about compensation:

- **A reverse action ≠ undo.** A refund does not bring back the card fee; a sent email cannot be unsent — which is why emails always go last (after the pivot).
- **Compensation can fail too** — billing is down at that moment. So: retries, idempotency, and finally a human's hands if it keeps failing (Lesson 7.4's DLQ).
- **Compensation must not be able to say "no" for business reasons** — design it that way. A "release" never says no; nor should a "refund".

### 1.5 Protecting a saga from crashes — log, recovery, idempotency

Every step of a saga commits separately — so what if the orchestrator dies mid-way? The exercise's `npm run saga`, part A — the same 83 crashes (this time after writing to billing but before writing to the orchestrator's log — the worst possible moment), plus 44 operations whose project is archived:

```
── A. 3000 "create task" — crash after writing to billing in 83 (3%), 44 with an archived project, 8 concurrent ──
   path                                       done  archived  crash   pending    tasks  counter   bad ws   result                  ops/s      p50
   two writes, no saga                        2873        44     83         —     2873     3000       58   127 bills with no task   1979   3.9 ms
   saga (idempotent steps)                    2873        44     83        83     2873     2956       57   83 bills with no task     966   7.9 ms
     … recovery from the log (234.1 ms)       2955        45      —         0     2955     2955        0   they match                  —        —
   saga, steps not idempotent                 2873        44     83        83     2873     2956       57   83 bills with no task     992   7.7 ms
     … recovery from the log (282.5 ms)       2955        45      —         0     2955     3038       57   83 bills with no task       —        —
```

- **Without a saga:** 127 bills with no task — 83 from crashes and 44 from archived projects. The archived ones have no reverse action at all. Incident 2.
- **With a saga:** the 44 archived ones were properly returned. But **immediately after** the crashes the saga shows the same 83 mismatches — a saga does not by itself protect you from crashes. The difference is in one column: **83 unfinished** — the orchestrator's log knows which 83 sagas are mid-way.
- **Recovery:** the orchestrator restarts, reads the log, and advances each unfinished saga from where it stopped — zero mismatches in 234 ms. (Archived going from 44 to 45: one of the 83 crashed operations also had an archived project — recovery returned that one.) A saga means it matches **eventually** — not always.
- **When the steps are not idempotent:** 83 extra bills even after recovery — created by **recovery itself**. Why: the log says the saga is 'started', and the orchestrator does not know whether the write to billing happened (Lesson 6.1: dying before the answer arrives makes "it happened" and "it didn't" indistinguishable). So it has to call again. With an idempotent step the second call returns the previous answer; without one, it counts twice.

The idempotent form uses billing's own ledger, keyed by the saga's id (Lesson 2.5's idempotency key, 7.4's idempotent consumer — now on every step of a saga and every reverse action):

```typescript
// billing service — step 1 (abridged, inside one local transaction)
const prev = await c.query('SELECT status FROM reservations WHERE saga_id = $1', [sagaId]);
if (prev.rows[0] !== undefined) return previousAnswer(prev.rows[0]); // already done — don't count it again
const r = await c.query(
	'UPDATE workspaces SET task_count = task_count + 1 WHERE id = $1 AND task_count < task_limit RETURNING id',
	[workspaceId]
);
const status = r.rowCount === 1 ? 'reserved' : 'rejected';
await c.query('INSERT INTO reservations (saga_id, workspace_id, status) VALUES ($1, $2, $3)', [
	sagaId,
	workspaceId,
	status
]);

// the reverse action — only from 'reserved' to 'released'; called twice, it decreases once
// WITH r AS (UPDATE reservations SET status = 'released' WHERE saga_id = $1 AND status = 'reserved' RETURNING workspace_id)
// UPDATE workspaces w SET task_count = task_count - 1 FROM r WHERE w.id = r.workspace_id
```

If the saga id is already in the ledger, it returns the previous answer instead of counting again. The reverse action moves only from `'reserved'` to `'released'`, so calling it twice still decrements once.

And the orchestrator — the saga's state as a small state machine in the work service's own `sagas` table:

```
  started ──reserve ✓──► reserved ──task ✓──► done
     │                      │
     └─reserve "no"─► rejected    └─archived─► compensating ──release──► compensated
```

The rules:

- **Log first, then act.** `started` before the saga begins; `compensating` before a reverse action. Then whenever it dies, recovery knows where to pick up.
- **Your own step and the log in the same local transaction.** Work's step (creating the task) and `state = 'done'` in one transaction — because both are in work's database. Another service's step cannot share a transaction with your log — which is exactly why idempotency and recovery exist.
- **Recovery = before the pivot, advance or reverse; after it, only advance.** The exercise's `recover()` runs every unfinished saga through the same `advance()` — new sagas and recovery share one code path.
- **Messaging other services:** direct calls here. Doing it with events means Lesson 7.5's outbox — the "tell billing to reserve" message in the same transaction as the saga's log, with the relay sending it later, at-least-once — so idempotency again on the consumer's side.

**The price:** the saga's 966 ops/s is half of two separate writes' 1979 — log writes, ledger writes, more round trips. Idempotency is not free either: the non-idempotent variant (992) is slightly faster. And it is not faster than `twopc`'s 2PC (1027) — though they are separate scripts doing different work (the saga also checks limits and archived projects), so they are not directly comparable. A saga's benefit is **not speed**. The benefit is: nobody waits holding anybody's locks. If billing is down for an hour, not one of work's rows is stuck — the sagas pile up in their log and advance when billing returns.

### 1.6 Who drives it — Orchestration vs Choreography

**Orchestration / Choreography** — Orchestration: a central orchestrator holds the saga's state and tells each service what to do (commands), taking the answer and deciding the next step. Choreography: there is no centre — each service listens for an event, does its step, and emits the next event (Lesson 7.5's event-driven).

```
  orchestration                                  choreography
  ─────────────                                  ────────────
       ┌─ orchestrator (work) ─┐                 work ──task.requested──► billing
       │ sagas table: the state│                   ▲                         │
       └──┬──────────────┬─────┘                   │               quota.reserved / quota.rejected
   "reserve" │      │ "release"                    │                         │
          ▼         ▼                              └─────────────────────────┘
       billing    work (its own step)             work ──task.failed──► billing (release)
   where is the saga? — look at one table         where is the saga? — piece together every service's logs
```

|                      | Orchestration                                                       | Choreography                                                                       |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Where the flow lives | In one place, readable in code                                      | Written nowhere — scattered across every service's listeners                       |
| "Where is the saga?" | One query                                                           | By piecing together every service's events (Lesson 10.4's tracing)                 |
| Timeouts, retries    | The orchestrator watches — "reserved for 10 minutes"                | Who watches? Usually nobody                                                        |
| Coupling             | The orchestrator knows every service                                | Services only know events — less at first; as steps grow, event tangles and cycles |
| Risk                 | Business rules accumulating in the orchestrator ("smart pipe", 9.2) | Adding a step and forgetting which event needs compensation                        |
| When                 | 3+ steps, compensation, timeouts, "where is it stuck?"              | 2–3 steps, one direction, almost no compensation                                   |

In practice there are purpose-built tools for large orchestrations — **durable workflow engines** (Temporal, AWS Step Functions, Camunda): you write the saga like ordinary code, and the engine logs every step, resumes exactly where it stopped after a crash, and handles retries and timeouts. The exercise's `sagas` table and `recover()` are a very small version of that.

### 1.7 The saga's gap — no isolation

The **I** in Lesson 5.5's ACID — isolation: others do not see a transaction's middle. A saga does not have it: the moment step 1 commits, everyone else can see it — even if it is later reversed. Where does that bite? Near a limit. Part B: 50 workspaces, each with a limit of 10 and 8 tasks already (2 free slots) — and 4 concurrent "create task" attempts in each, a quarter of which have archived projects:

```
── B. Near the limit: 50 workspaces, limit 10, 8 tasks already — 4 concurrent "create task" in each, 41 with an archived project ──
   rule                                      made  undone     refused  ws over limit       extra  false refusals
   reserve → task → release (saga)             75      25         100              0           0              25
   check → task → count usage at end          159       —           0             42          61               0
```

- **Reserve first (our saga):** the limit is never exceeded — exactly 2 reservations per workspace, with the other 100 attempts told "limit reached". But 25 reservations were later released (archived) — and those who were told "no" for the sake of those slots were told no **wrongly**. The middle state (reserved, but the task not yet created) changed other people's decisions.
- **Check first, count at the end:** all four attempts simultaneously see "8 < 10, there is room", all four create tasks — 42 workspaces went over the limit, with 61 extra tasks. Lesson 5.5's write skew — but this time across two databases, where `SERIALIZABLE` cannot save you. Incident 2's "103 tasks". (README experiment 3: even with the artificial delay set to zero, the same 42 — the gap of a few round trips is enough.)

**Semantic Lock** — keeping a saga's middle state as an explicit marker in the data (`pending`, `reserved`), so that other transactions know it is not final yet and behave accordingly — waiting, saying "try again shortly", or counting it. Not a database lock — a lock in the business rules.

Our `reservations` ledger is exactly that. A better form (README experiment 5): separate `reserved` (pending) from `confirmed` in the ledger — when the limit is full but something is pending, say "try again shortly" instead of "limit reached". Chris Richardson's "Microservices Patterns" (drawing on a 1998 paper by Lars Frank and Torben Zahle) lists several more approaches — such as **commutative updates** (+1 and −1 give the same result in any order, so ordering stops mattering) and **reread value** (reading again before the last step to see whether anything changed — Lesson 5.5's optimistic lock).

The most familiar real-world semantic lock: a **card authorization hold**. At hotel check-in your card has money "held" (authorized) — not taken; at check-out the real amount is taken (capture) and the rest released (void). In between, your bank sees it as "pending" — and it reduces your limit for other spending, exactly like our reservation. And a hold has an expiry — you cannot hold something forever.

Which error you will tolerate is not an engineering decision, it is a **business** one. Exceeding TaskFlow's free plan limit by 2 might go unnoticed (plenty of SaaS limits are deliberately "soft"); an overdraft on a bank account never will.

### 1.8 TaskFlow's decision

- **No 2PC.** Blocking between services, Stripe cannot be enrolled, and billing's locks end up in work's hands. (If TaskFlow ever moves to a distributed database, its internal 2PC will work out of our sight — that is a different matter.)
- **Billing gets extracted** — its own database, its own deploy (the audit's condition).
- **"Create task" = an orchestrated saga**, with the orchestrator in the work service: reserve in billing (idempotent by saga id) → create the task (plus `done`, in the same transaction) → release if the project was archived. The `sagas` table lives in work's database; a recovery job advances unfinished sagas older than 30 s every few seconds; if compensation keeps failing, an alert and a human queue. The call to billing is synchronous (a user is waiting — 9.2's rule) with a timeout; on timeout the user gets an error — and the user's request's Idempotency-Key _is_ the saga's id, so "try again" does not create a new saga but shows the old one's outcome (9.1's duplicate problem solved).
- **The limit:** reserve first (a semantic lock) — it can never be exceeded; when something is pending, "try again shortly", and when genuinely full, "limit reached".
- **Plan upgrade = a saga with a pivot:** a pending subscription → the Stripe charge (Idempotency-Key = saga id, so a retry does not charge twice) → active → raise the plan → the receipt. Steps after the pivot only retry. Incident 3 cannot recur — recovery finishes it. If the steps grow, consider a durable workflow engine (Temporal, say).
- **Counting usage for the monthly invoice** (how many tasks, how much storage) needs no saga: nobody says "no" here, so outbox → events (Lesson 7.5) is enough, eventually consistent.
- **A nightly reconcile job** (9.1's experiment 5): work's task count versus billing's counter — alert on a mismatch. Because even with the saga correct, there will be bugs in the code.

> **Trade-off Table — one business operation across two databases**

| Approach                      | Atomic?                                        | Isolation                          | When something dies                                                | Cost (measured)                                          | When                                                                           |
| ----------------------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| One database, one transaction | Yes                                            | Yes (5.5)                          | Everything rolls back                                              | Cheapest (2775 ops/s)                                    | As long as possible — the modular monolith (9.1)                               |
| 2PC (XA, `PREPARE`)           | Yes                                            | Yes — via locks                    | Coordinator dies → in doubt: locks held, everyone blocks           | 1027 ops/s; with 5 in doubt, all clients stuck in 157 ms | Inside one database system (Spanner) — almost never between your own services  |
| Saga — orchestration          | Eventually (via compensation)                  | No — filled in with semantic locks | Recovery from the log; double-counting if steps are not idempotent | 966 ops/s; mismatches are visible before recovery        | A few steps, a step that can say "no", external APIs — **TaskFlow**            |
| Saga — choreography           | Eventually                                     | No                                 | Each service's own retries; finding the saga is hard               | Close to orchestration, flow scattered                   | 2–3 steps, one direction, almost no compensation                               |
| Outbox → events only (7.5)    | Eventually — but the next step cannot say "no" | No                                 | Events pile up and arrive later                                    | One local transaction plus a later event                 | When the next step never rejects — usage counting, search index, notifications |

---

## 2. Interview Angle

**In any design question involving "money and goods"** (e-commerce checkout, hotel or flight booking, an Uber ride, a payment system — Lesson 11.7) a moment arrives: order, inventory and payment are separate services — "how do you make sure they all happen together?" A weak answer: "with a distributed transaction" or "2PC". A good answer: a saga — the order of the steps, each one's compensation, which is the pivot (nearly always payment), every step with an idempotency key (including the idempotency key of an API like Stripe's own), why orchestration, and the isolation problem — the last one being what happens when two people buy the last item (an inventory reservation = a semantic lock, with an expiry).

**"Why wouldn't you use 2PC?"** — blocking (when the coordinator dies after PREPARE the participants hold locks and wait — and deciding for themselves produces mismatches), the coordinator is alone (no majority as in Raft), everyone has to be alive at once (the availability multiplication), and external APIs cannot be enrolled. Bonus: Spanner/CockroachDB do use 2PC — because their coordinator is itself replicated by consensus.

**"What if compensation fails?"** — retry (safe because it is idempotent), backoff, and after repeated failures a DLQ and a human (7.4); and designing compensation up front so it cannot say "no" for business reasons.

**In production, in practice:** the most familiar stories: a saga stuck mid-way because there is no recovery job ("pending" orders for months); the same card charged twice on a retry (no idempotency key — the inverse of incident 3); a new step added but nobody writing its compensation; two services in an endless cycle over each other's events in a choreography; and reservations with no expiry — a failed checkout's inventory "reserved" forever, stock on the shelf that nobody can buy.

---

## 3. Key Takeaway

- Database per service means no atomicity across the boundary — two old answers: **2PC** (everyone prepares and waits, one party decides) and the **saga** (each step commits immediately, mistakes get reverse actions)
- **2PC really is atomic** — zero mismatches across 83 crashes; the price: 1027 versus 2775 ops/s (five durable writes, locks held throughout)
- 2PC's real weakness is **blocking**: when the coordinator dies after PREPARE, **in-doubt** transactions hold locks — with 5 of 100 in doubt and no `lock_timeout`, every client was stuck within 157 ms. A participant deciding for itself produces mismatches. There is no majority as in Raft — so 2PC survives only inside databases built on consensus (Spanner)
- **Saga**: order the steps — those that can say "no" and are cheap to reverse first, and after the **pivot** only steps that can be retried; **compensation** is a new write, not an undo — and it needs retries and idempotency of its own
- A saga does not protect you from crashes by itself — the **log** (log first, then act) and **recovery** do: 83 mismatches after the crashes, 0 after recovery. When steps are not **idempotent**, recovery itself creates 83 extra bills
- **Orchestration** (the flow in one place, "where is the saga" is one query) versus **choreography** (no centre, workable for small one-directional flows); at scale, a durable workflow engine (Temporal, Step Functions)
- A saga has **no isolation** — "check first" lets 42 workspaces exceed their limit; a **semantic lock** (reserve first) never exceeds it but produces 25 wrong "no"s. Which error you tolerate is a business decision

---

## 4. New Terms (Glossary)

| Term                             | Meaning                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two-Phase Commit (2PC)**       | A coordinator brings several participants to one decision in two phases: prepare (each makes its part durable and says yes/no), then the decision in the coordinator's log and commit/rollback for everyone       |
| **In-doubt Transaction**         | Prepared at a participant but the coordinator's decision has not arrived — the participant cannot decide for itself, so it holds its locks and waits; this is why 2PC is a blocking protocol                      |
| **Saga**                         | Dividing a large business operation into several steps — each one a local transaction in one service's own database (committing immediately); on failure, reverse actions for the earlier steps, in reverse order |
| **Compensating Transaction**     | The business reverse of a step that has already committed — not a rollback but a new write (release, refund); it has to be idempotent and retryable itself                                                        |
| **Pivot Transaction**            | The step in a saga after which there is no way back — steps before it can be compensated, steps after it only move forward by retrying                                                                            |
| **Orchestration / Choreography** | Orchestration — a central orchestrator holds the saga's state and issues commands to each service; Choreography — no centre, each service listens for an event, does its step and emits the next event            |
| **Semantic Lock**                | A saga's middle state kept as an explicit marker in the data (`pending`, `reserved`), so others know it is not final and behave accordingly; not a database lock but a lock in the business rules                 |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines in your own words for each.

1. An online shop's checkout: an order service (creating the order), an inventory service (reserving the item), payment (charging via Stripe), a shipping service (creating a courier label — an external API), and notifications (the confirmation email). (a) In what order would you arrange the saga's steps, and why? Which is the pivot? (b) What is each step's compensation — which ones have none, and why is that fine? (c) The last item in stock, with two people checking out at once. What happens, and how would you design the inventory reservation so a failed checkout does not hold the item forever?
2. The DBA has a new proposal: "Let's keep 2PC — with `lock_timeout` at 200 ms nobody blocks any more, the exercise showed it." Using the exercise's numbers: which problem does `lock_timeout` fix and which does it not? How long do the in-doubt transactions themselves sit there, and what other damage happens inside Postgres in that time? The coordinator's process was running on a machine that will never come back — what do you do then?
3. Another team built the "create task" saga with choreography: work emits `task.requested` → billing reserves and emits `quota.reserved` or `quota.rejected` → work creates the task and emits `task.created`, or `task.failed` if archived → billing hears `task.failed` and releases. (a) Where does the saga's state live now? A user asks "why isn't my task showing up?" — what would you have to look at to find out? (b) Billing is down for an hour — what happens, and what does the user see? (c) Next month a third step is added: "add the task to the search index" (the search service, listening for `task.created`). Is that part of the saga? Does it need compensation? Compare with orchestration.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) A reasonable order:

1. **Create the order** — in a `pending` state (itself a semantic lock — "this order is not final"). Reverse: `cancelled`.
2. **Reserve inventory** — it can say "no" (out of stock), and its reverse is cheap (release it). So before payment: if there is no stock there is no need to touch the card at all.
3. **Payment (the Stripe charge)** — the **pivot**: once the money has moved, reversing it means a refund — expensive (fees), bad in the customer's eyes, and it takes days. Idempotency-Key = the saga/order id, so a retry does not charge twice. (Many shops authorize here and capture on shipping — pushing the pivot even later.)
4. **Order `confirmed`**, 5. **Shipping label**, 6. **Email** — all after the pivot, retry only.

(b) Compensation: order → cancelled; inventory → release; payment → refund (only if something becomes truly impossible after the pivot — the item is found broken in the warehouse, say; at that point it is no longer the saga's normal path but a separate business process). The shipping label and the email have no compensation — and need none, because they are after the pivot: they never end up in a "reverse it" situation, only "finish it". If the label API fails, retry; if it fails for a day, a human. That is the whole logic of the ordering — put what cannot be reversed after the pivot, so the question of reversing never arises.

(c) Two at once: both sagas reach step 2. If the inventory reservation happens under an atomic condition (`UPDATE stock SET reserved = reserved + 1 WHERE available - reserved >= 1` — like the exercise's `task_count < task_limit`), one gets it and the other is told "out of stock" — before payment. The second person's card was never touched. But what if the first person's card is declined? The reservation goes back — and the second person has left by then (the exercise's "wrong limit reached"). That is tolerable; the opposite (both charged, one item) is not.

Not holding it forever: give the reservation an **expiry** — `reserved_until = now() + 15 min`. A job releases expired reservations; and if the saga's orchestrator reaches payment later (after the expiry), it renews the reservation first — and if it cannot, it fails before payment. Like a hotel's card hold. The saga needs a timeout of its own too — stuck at step 2 for 15 minutes means compensate.

**Question 2:** What `lock_timeout` fixes: **new** requests no longer block forever — in the exercise, 8/8 stuck became 0/8 and ops/s went from 30 to 449. What it does not fix:

- **The in-doubt transactions themselves** — they are still sitting there, holding locks. Nobody can create a task in those 5 workspaces (57 failures, each after 200–400 ms of waiting). In the customer's eyes: "tasks can't be created in that workspace" — until the coordinator returns.
- **How long they sit:** until someone runs COMMIT/ROLLBACK PREPARED — there is no bound. They survive a Postgres restart (that is the whole point of writing them to disk).
- **The damage inside Postgres:** a prepared transaction holds an old snapshot — VACUUM cannot clean up rows that died after it, and the table bloats (Lesson 5.3). Left for days it risks transaction ID wraparound, at which point Postgres stops accepting writes. It also consumes `max_prepared_transactions` slots.
- **The coordinator's machine will never come back:** if its log (`twopc_log`) lives in a surviving database (here in tasks_svc — not on the machine's disk), a new coordinator process can read that log and run the same recovery. If the log is lost too — nobody knows what the decision was. Then a human looks at both sides' data and fixes each transaction by hand (heuristically), and reconciles the mismatches. This is exactly why 2PC coordinators get replicated (Paxos Commit, Spanner).

So the answer: `lock_timeout` shrinks the blast radius — it does not remove the blocking.

**Question 3:**

(a) In choreography the saga's state is nowhere in one piece — work has "requested" and "created/failed", billing has the reservation and the release, and the middle state lives in the stream's offsets. Answering "why isn't my task showing up" means: is `task.requested` in work's log? Has billing read it (the consumer group's lag, Lesson 7.2)? Did it emit `quota.*`? Has work read that? — four places and two teams. Distributed tracing (Lesson 10.4) with one trace id on every event makes it easier; without it, a long time. In orchestration: `SELECT state FROM sagas WHERE id = …` — one query.

(b) Billing down: the `task.requested` events accumulate in the stream (7.2) — nothing is lost, but nothing advances either. The user sees the task "being created…" for an hour — or, if the UI expects a synchronous answer, a timeout. When billing returns, the accumulated events are processed all at once (backpressure, 7.4) — and the limits may have changed during that hour. Orchestration has the same fundamental problem (no reservation without billing) — but the orchestrator knows how long each saga has been `started` and can apply a policy ("after 30 s, error to the user and cancel the saga"). In choreography, who watches that timeout — nobody's job, unless somebody builds it.

(c) The search index is usually **not** part of the saga — it is Lesson 7.5's event-carried state / a derived copy: the task has been created (the saga is over), and then whoever needs it listens. It needs no compensation, because it says "no" to nobody — on failure, retry, or the next reconcile/reindex (8.3). But one subtlety: after `task.failed` the task was never created — nothing went to search, which is fine; and if a task is ever created and later reversed (in some other flow), search will have to remove it on `task.deleted`. Choreography's advantage shows here: adding a new listener required changing nobody. The price: one day somebody will change what `task.created` means ("we now emit it for draft tasks too") — and every listener will silently be wrong. In orchestration this step would have lived in the orchestrator's code — explicit, but every new step means changing the orchestrator. The rule: a step that can change the saga's outcome (that can say "no") belongs in orchestration; one that only wants to know the outcome listens for an event.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (Postgres 17 in Docker — two separate databases as two "services")

> **Ready to run in the repo:** [`exercises/lesson-9.3-saga-2pc/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.3-saga-2pc) — `npm install`, `docker compose up -d --wait`, then `npm run twopc` and `npm run saga`. The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in the `README.md` there.

`twopc` runs real 2PC across two databases with Postgres's `PREPARE TRANSACTION` — 9.1's same 3000 operations and 83 crashes — then kills the coordinator after PREPARE to create in-doubt transactions, runs 8 clients against their locks (with and without `lock_timeout`), and shows recovery from the coordinator's log versus a participant deciding for itself. `saga` runs an orchestrated saga — reserve in billing, create the task, compensate on an archived project — with crashes, recovery from the log, and both idempotent and non-idempotent steps; and it runs many concurrent sagas near the limit to count the wrong "no"s from "reserve first" versus "check first".

**Honest notes:** Verified by running in the sandbox on Node 26 with Postgres 17 in Docker: `tsc --noEmit` and ESLint clean; `twopc` and `saga` five times each — the counted columns (ok, mismatches, unfinished, stuck clients, over the limit) identical every time; timings move a lot (monolith 1973–3666 ops/s, 2PC 1027–1165, "everyone stuck" 147–161 ms); in `saga`'s part B the saga row's "created" was 74–78 and "returned" plus wrong "limit reached" 22–26 (which two attempts get the reservation first is a matter of timing). README experiments 1–3 were run and their numbers are in the README; 4 and 5 involve changing code — those are yours. The two "services" are two databases in one Postgres container — not separate machines, the same disk, no network delay; the services' code is functions in one Node process, and network calls (9.1, 9.2) are not measured here. `twopc`'s and `saga`'s ops/s are not directly comparable — they do different work. The "crash" is a pretence — dropping the connection in 2PC (where Postgres then rolls back exactly as it would on a real crash), and stopping the operation in the saga; but the prepared transactions and their locks are real. The coordinator code in 1.2 and billing's code in 1.5 are excerpts from the exercise; the plan-upgrade saga in 1.4 and the decision in 1.8 are a design, not something that was run. Spanner, CockroachDB, Paxos Commit and Richardson's book are summarised from their published writing.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `twopc`, write down — 100 workspaces with 5 in doubt, 8 clients working on random workspaces, no `lock_timeout`. How long until everyone is stuck — a second? a minute? never? (Hint: one operation is ~5 ms, and each has a 5% chance.) Then compare, and predict again for experiment 1 (only one in doubt).

2. **Counting the steps:** read `twoPhase()` in `twopc.ts` and count — how many sequential round trips from the coordinator's side, and how many writes wait to be durable. Compare with the monolith. Then run experiment 2 (`CRASH_RATE=0`) and see how well your counted ratio matches the ops/s — where it does not, why?

3. **A crash in the middle of compensation:** experiment 4 — add a crash in `advance()` after the `compensating` log write and before `release()`. What does recovery do? Then make `release()` non-idempotent (just `task_count - 1`) and run recovery twice (as two recovery processes at once — which does happen in reality). What breaks, and how does the exercise's idempotent form prevent it?

4. **Reducing wrong "no"s:** experiment 5 — separate `reserved` from `confirmed`, say "try again shortly" when something is pending, and have the orchestrator retry once after 20 ms. How many wrong "limit reached"s now? What did it cost in p50 or ops/s? From a user's point of view, what is the difference between "limit reached" and "try again shortly" — which one generates a support ticket?

5. **The design part:** a one-page design of TaskFlow's plan-upgrade saga: (a) the steps, each one's service, local transaction and compensation (or "retry only"); mark the pivot; (b) the saga's state machine (states and arrows) and the orchestrator's `sagas` table columns; (c) each step's idempotency key, and which one goes into the Stripe call; (d) how long stuck in which state means recovery does what, and when it calls a human; (e) what happens if two admins upgrade the same workspace at once — which semantic lock is needed.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8 (complete, with exit challenges), 9.1, 9.2
Current: 9.3 — Distributed transactions: Saga pattern, 2PC
TaskFlow state: modular monolith (work, identity, files, search) + files processing service +
billing service (its own database — the audit); an API gateway + web/mobile BFF in front (9.2);
"create task" = an orchestrated saga with the orchestrator in work: reserve in billing (idempotent
by saga id, a semantic lock — "try again shortly" while pending) → create the task (+ the saga's
state, in the same local transaction) → release if archived; a sagas table + a recovery job, with an
alert if compensation keeps failing; the user's Idempotency-Key = the saga id; plan upgrade = a saga
with the Stripe charge as the pivot (Idempotency-Key = saga id), later steps retry only; counting
monthly usage = an outbox event (not a saga); a nightly reconcile job; no 2PC between services
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall,
Over-fetching, Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication,
Service Mesh (mTLS), Two-Phase Commit (2PC), In-doubt Transaction, Saga, Compensating Transaction,
Pivot Transaction, Orchestration / Choreography, Semantic Lock
Weak spots: [where you got stuck — write it yourself]
Next: 9.4 — Service discovery, circuit breaker, bulkhead
=======================
```

---

## 8. Next Step

Run the exercise and send me the results — especially your prediction in 1 and the design in 5. When you are ready, write `next` — in Lesson 9.4 we go to **service discovery, circuit breakers, and bulkheads.** In today's saga the work service calls billing synchronously, with a timeout. But billing has three instances — how will work know which is where, and which is alive (service discovery)? If billing gets slow, every "create task" waits until the timeout — a thousand requests, a thousand waits; how do you stop calling a dying service (circuit breaker)? And how do you keep billing's slowness from eating all of work's connections and workers — so the board keeps opening (bulkhead)? The next step after Lesson 9.1's "timeout + fallback" — measured.
