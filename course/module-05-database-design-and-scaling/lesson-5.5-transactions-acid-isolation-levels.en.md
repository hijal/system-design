# Lesson 5.5 — Transactions, ACID, Isolation Levels: How Concurrent Work Corrupts Itself

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 4.6):** What is a hot key, and why doesn't adding more servers behind one Redis node solve a hot key problem?

**Prerequisite:** Lesson 5.2 (The counter and the lost update), Lesson 5.3 (WAL, a glimpse of MVCC)

**By the end of this lesson you will be able to:**

1. Say what the four letters of ACID actually guarantee (and what they don't), and understand how Postgres's MVCC shows each transaction a "snapshot"
2. Recognise the five anomalies — dirty read, non-repeatable read, phantom, lost update, write skew — and say which Postgres isolation level prevents which (with results you've seen yourself)
3. Pick the right fix for a race condition — `FOR UPDATE`, an atomic update, optimistic locking, or `SERIALIZABLE` + retry — and know what each costs

**Tier:** 1 — Runnable Code

---

## 0. Where TaskFlow Is Right Now

In Lesson 5.2 we left a question open. The naive counter code — "read, add 1 in JS, write" — kept losing updates even **inside a transaction**. "Transactions make everything safe", don't they?

And this week another strange ticket arrived in support:

> "Our project now has **no admin at all**. Nobody can change settings or add anyone."

Yet TaskFlow's code states the rule clearly: when someone wants to remove themselves as admin, it first checks that at least one other admin exists. If not, it's not allowed. Digging through the logs: the project's two admins, Rahim and Karim, removed themselves **in the same second**. Both requests checked the rule, both saw "there are 2 admins", both passed.

Both bugs have the same root: **what concurrent transactions see of each other, and what they don't.** That is called isolation — today's topic. And it is an area where even experienced developers write code for years with wrong assumptions, because these bugs are **never visible** when you test alone locally.

---

## 1. Theory

### 1.1 Transactions and ACID — four promises

You know **transactions** from Sequelize — running several queries as one unit. In database textbooks their promises are collectively called **ACID**:

- **A — Atomicity:** all or nothing. If an error or crash happens mid-transaction, every earlier change is undone. (It is really "abortability" — the ability to throw the whole thing away. Thanks to Lesson 5.3's WAL, it holds even through a crash.)
- **C — Consistency:** at the end of a transaction the data is always in a valid state. But there's a subtle point — the database can only protect the rules you **told it**: foreign keys, `UNIQUE`, `CHECK`, `NOT NULL`. A rule like "there must be at least one admin" is unknown to the database — it is your code's responsibility. And that is exactly where today's second bug lives.
- **I — Isolation:** concurrent transactions won't interfere with each other — **how much** they won't is set by the isolation level. Today's main topic.
- **D — Durability:** once committed, the data won't be lost, even in a crash. Lesson 5.3's WAL + fsync.

> A warning: ACID's "C" and the "C" of the CAP theorem in Lesson 5.9 share a name but mean completely different things. Mixing them up is a very common interview mistake.

**Transactions in Sequelize** — two kinds:

```typescript
// Managed — commits when the callback finishes, rolls back automatically on throw
await sequelize.transaction(async (transaction) => {
	await Task.create({ title, projectId }, { transaction });
	await Project.increment('openTaskCount', { by: 1, where: { id: projectId }, transaction });
});
```

Unmanaged (`const t = await sequelize.transaction()`, then `t.commit()`/`t.rollback()` yourself) — this is what the exercise's `anomalies.ts` uses to arrange two transactions' steps by hand.

**The most common Sequelize bug:** forgetting to pass `{ transaction }` to every query. Forget it and that query runs **outside the transaction, on another connection from the pool** — none of the transaction's guarantees apply to it. And if that row is locked by the transaction, the query waits for the transaction to finish, while the transaction waits for the query — the app hangs forever. (You'll see it yourself in the exercise's experiment 4.)

### 1.2 Why not just run every transaction one at a time?

The simplest isolation would be: only one transaction runs at a time, the rest queue up. No races. But then TaskFlow's 100 users' 100 requests would run one by one — throughput would collapse.

So databases let transactions run **concurrently**, and in return leave room for some strange events (anomalies). **Isolation level** — a declared level of which anomalies a database will allow and which it will prevent. The stricter the level, the fewer anomalies — but the more waiting or failed transactions.

### 1.3 MVCC — every transaction sees a "snapshot"

Without understanding how Postgres keeps concurrent transactions apart, isolation levels remain something to memorise. In Lesson 5.3 you saw a glimpse — after an `UPDATE` the row's `ctid` changed, because Postgres doesn't delete the old row but writes a **new version**.

**MVCC (Multi-Version Concurrency Control)** — keeping several versions of a row at once, so each transaction can see a "snapshot" of one particular moment — regardless of whether someone else is changing that row.

```
time ──────────────────────────────────────────────────────────────►

projects row (id=1):   [v1: name="Website"] ─────────┐
                                                      │  B UPDATE + COMMIT
                                                      └─► [v2: name="Website v2"]

Transaction A (REPEATABLE READ):  |──── takes snapshot ─── reads ──────── reads again ──|
                                        (v1 visible)       "Website"     "Website"
                                                                          (still v1!)
Transaction A (READ COMMITTED):   |── reads ──────────────── reads again ──|
                                      "Website"                "Website v2"
                                      (a new snapshot for every statement)
```

Its biggest benefit: **reads never block writes, and writes never block reads.** Someone running a big report query doesn't stop everyone else from creating tasks. Only when **two writes hit the same row** does one have to wait.

And the difference between Postgres's two main levels in one line:

- **READ COMMITTED (Postgres's default):** takes a new snapshot at the start of **every statement**
- **REPEATABLE READ:** takes one snapshot at the transaction's **first statement**, and the whole transaction sees that

VACUUM cleans up the old versions later (Lesson 5.3).

### 1.4 The five anomalies — seen with your own eyes

The exercise's `npm run anomalies` runs each step of two transactions (A and B) in a hand-arranged order — no reliance on races, so the result is the same every time. All the output below comes from there.

**1. Dirty read — reading data that hasn't been committed.** A changes a name but hasn't committed; B sees it; then A rolls back — B has seen something that **was never true**.

```
[B = READ UNCOMMITTED]
  A: renamed to "Draft name" — not committed yet
  B: read: "Website"
```

In Postgres this **never** happens — not even when you ask for `READ UNCOMMITTED`. Postgres quietly runs it as `READ COMMITTED`. In MVCC an uncommitted version is simply never visible in anyone else's snapshot.

**2. Non-repeatable read — reading the same row twice and getting different values.**

```
[READ COMMITTED]    A: first "Website"  → B changes and commits → A: second "Website v2"
[REPEATABLE READ]   A: first "Website"  → B changes and commits → A: second "Website"
```

Where does this hurt in TaskFlow? A report transaction first reads the projects' names, then counts their tasks — if someone changes something in between, the report's two halves show the truth of two different moments.

**3. Phantom read — searching twice with the same condition and getting a different number of rows.**

```
[READ COMMITTED]    A: 3 tasks  → B adds a new task and commits → A: 4 tasks
[REPEATABLE READ]   A: 3 tasks  → B adds a new task and commits → A: 3 tasks
```

**4. Lost update — one of two writes silently disappears.** This is Lesson 5.2's mystery:

```
[READ COMMITTED]
  A: read 5
  B: read 5
  A: wrote 6, COMMIT
  B: wrote 6, COMMIT
    → final value 6 (should be 7) — one update silently lost, nobody got an error
```

Look — both are in transactions, both succeed, no errors. READ COMMITTED only guarantees you'll read **committed** data; it doesn't guarantee that what you read **stays true** until you write. The "5" that B read was no longer true when B wrote.

The same thing under REPEATABLE READ:

```
[REPEATABLE READ]
  A: read 5 · B: read 5 · A: wrote 6, COMMIT
  B: tried to write → ERROR 40001 — could not serialize access (serialization failure), ROLLBACK
    → final value 6 — B's work didn't happen, but B knows it; a retry gives 7. Not silently lost
```

Here Postgres caught it: in B's snapshot the row looks one way, yet before B could write, someone else changed and committed it. It doesn't let B write — it throws a **serialization failure** (SQLSTATE `40001`). The meaning: "the data you read is stale; run the whole transaction again from the start." The update still hasn't happened — but it **wasn't silently lost**, and that difference is everything.

**5. Write skew — both followed the rule, yet the rule broke.** This is the admin bug:

```
[REPEATABLE READ]  rule: there must always be at least 1 admin
  A: Rahim checked: 2 admins → "one will remain if I leave" ✓
  B: Karim checked: 2 admins → "one will remain if I leave" ✓
  A: Rahim made himself a member
  B: Karim made himself a member
  A: COMMIT ✓
  B: COMMIT ✓
    → admins now: 0 — the rule is broken, even though both checked it!
```

Why couldn't REPEATABLE READ catch this, when it caught the lost update? Because here the two changed **different rows** — Rahim his own row, Karim his own row. No row got written by both, so no conflict is visible. The problem isn't in a row — the problem is that **the condition both of them read and decided on** ("2 admins") was made false by the other's write.

**Write skew** — two transactions read the same data to check a condition, then write to **different** rows, and their combined result breaks that condition. The pattern is always the same: **read → check a condition → write somewhere else based on that condition.** Real examples: two people booking the same meeting room for the same slot, two people buying the last ticket, two doctors taking the same night off from on-call.

The same events under SERIALIZABLE:

```
[SERIALIZABLE]
  … (the same four steps) …
  A: COMMIT ✓
  B: COMMIT → ERROR 40001 — could not serialize access (serialization failure)
    → admins now: 1 — the rule holds
```

Postgres's SERIALIZABLE (whose internal technique is called Serializable Snapshot Isolation, SSI) tracks not just write conflicts but **who read what**. It sees: B changed what A had read, and A changed what B had read — there is no order in which running them one after the other would have produced this result. So it aborts one.

> **What each level prevents in Postgres** (measured in the exercise, Postgres 17):

| Anomaly             | READ COMMITTED (default) | REPEATABLE READ         | SERIALIZABLE     |
| ------------------- | ------------------------ | ----------------------- | ---------------- |
| Dirty read          | prevented                | prevented               | prevented        |
| Non-repeatable read | **happens**              | prevented               | prevented        |
| Phantom read        | **happens**              | prevented               | prevented        |
| Lost update         | **happens silently**     | caught — raises `40001` | caught — `40001` |
| Write skew          | **happens**              | **happens**             | caught — `40001` |

**An honest caveat:** this table is for **Postgres**. In the SQL standard, REPEATABLE READ isn't required to prevent phantoms — Postgres gives more. And MySQL's (InnoDB's) default is also "REPEATABLE READ", but its internal technique differs, so its guarantees aren't exactly the same. **Same level name, different behaviour in different databases** — if you switch databases, read your database's documentation; don't assume from the name.

### 1.5 How to fix write skew

Three ways:

1. **SERIALIZABLE + retry.** The most common fix — Postgres finds it by itself. Cost: failed transactions and retries, and extra work for the database to track reads.
2. **Lock what you read.** Read the admin rows with `SELECT ... FOR UPDATE` and the second transaction has to wait for the first to finish — then it sees the new state (1 admin). (The exercise's experiment 2.)
3. **Bring the conflict onto one row.** Sometimes the rows you read can't be locked — for example, checking "there is **no** booking in this slot" in a meeting-room system; how do you lock a row that doesn't exist? Then one specific row is used as a "lock" — say, `FOR UPDATE` on that project's row — so every membership change in that project happens one at a time.

And if the rule can be expressed as a database constraint (`UNIQUE`, `CHECK`, an exclusion constraint), that is best of all — the database protects it itself, whatever the level.

### 1.6 Lost update — seven strategies, measured

Now Lesson 5.2's counter. The exercise's `npm run lostupdate` runs **100 `+1`s at once** on one counter, with seven strategies (10 connections in the pool):

```
strategy                                   final value   retries    time
1. read-modify-write, no transaction      ✗   1/100        0     145 ms
2. same, in a READ COMMITTED transaction  ✗  10/100        0     113 ms
3. SELECT ... FOR UPDATE                  ✓ 100/100        0     141 ms
4. atomic UPDATE … SET x = x + 1          ✓ 100/100        0     106 ms
5. REPEATABLE READ + retry                ✓ 100/100      348     371 ms
6. optimistic locking (version) + retry   ✓ 100/100     1206     801 ms
7. SERIALIZABLE + retry                   ✓ 100/100      339     347 ms
```

The first two lines answer Lesson 5.2's mystery: **the transaction alone fixed nothing** (90 out of 100 lost). The other five are correct — but they come from three completely different philosophies:

**a. Take the lock first — pessimistic locking.** "Assume a conflict will happen; claim the row the moment you read it." **Pessimistic locking** — locking the row at read time (`SELECT ... FOR UPDATE`), so anyone else who wants to change or lock that row waits. In Sequelize:

```typescript
sequelize.transaction({ isolationLevel: READ_COMMITTED }, async (transaction) => {
	const p = await Project.findByPk(projectId, { transaction, lock: transaction.LOCK.UPDATE });
	if (!p) throw new Error('missing');
	await Project.update(
		{ openTaskCount: p.openTaskCount + 1 },
		{ where: { id: projectId }, transaction }
	);
});
```

The `anomalies` timeline showed what happens: when B tries to read the same row `FOR UPDATE`, it is still waiting 300 ms later; as soon as A commits, B reads **the new value (6)** and writes 7. No retries, no errors — just a queue.

**b. Give the arithmetic to the database — an atomic update.** `UPDATE projects SET "openTaskCount" = "openTaskCount" + 1` — reading and writing in one statement. Safe even under READ COMMITTED: if two arrive together, the second waits for the row lock, and once it gets the lock Postgres redoes the arithmetic on the row's **latest committed version**. The fastest and simplest of the seven. When you can, this is the first choice.

A powerful form of this — a **conditional atomic update**, for problems like selling the last item:

```sql
UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0
```

Then check how many rows changed — 0 means out of stock. The check and the write are one statement, so two people can't buy the last item.

**c. Detect the conflict, try again — optimistic.** "Assume conflicts are rare; take no locks; at write time check whether anyone changed it in between; if so, try again." Three strategies belong to this family:

- **REPEATABLE READ / SERIALIZABLE (5, 7)** — Postgres itself detects the conflict and raises `40001`
- **Optimistic locking (6)** — the application detects it. **Optimistic locking** — keeping a `version` column on the row; writing with `WHERE version = <the one I read>`, and if 0 rows change, someone changed it first. In Sequelize, `version: true` on the model makes `save()` do this itself and throw `OptimisticLockError`:

```typescript
withRetry(async () => {
	const p = await Project.findByPk(projectId);
	if (!p) throw new Error('missing');
	p.openTaskCount = p.openTaskCount + 1;
	await p.save();
}, stats);
```

In this family **nothing works without retry** — without it they would just throw errors. The exercise's retry helper:

```typescript
export async function withRetry<T>(
	fn: () => Promise<T>,
	stats: RetryStats,
	maxAttempts = 50
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error: unknown) {
			if (!isRetryable(error) || attempt >= maxAttempts) throw error;
			stats.retries++;
			const backoff = Math.min(100, 2 ** Math.min(attempt, 6));
			await sleep(Math.random() * backoff);
		}
	}
}
```

Notice three things: (1) it retries only on **retryable** errors — `40001`, deadlock (`40P01`), `OptimisticLockError`; every other error goes straight up. (2) The **whole transaction** runs again, not just the failed query — because what the transaction read is now stale. (3) **Backoff + jitter** — if everyone retries at once they'll collide at once again; the same reasoning as Lesson 4.6's TTL jitter, and Lesson 7.4 goes into it in full depth.

**The most instructive number in the table:** optimistic locking needed **1,206 retries** — an average of 12 failed attempts per successful write, and the slowest of all. Because 100 callers are writing **the same row** — the worst possible situation for optimistic locking. Optimistic belongs where conflicts are **rare**: two people editing the same task's description at the same moment — a rare event, and then not taking locks is the big win. For a hot counter, pessimistic or atomic is far better.

> **Trade-off Table — which strategy when**

| Strategy                | When                                                            | Cost                                                               |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Atomic update           | The arithmetic fits in one statement (`x = x + 1`, `stock > 0`) | The lowest; complex business logic doesn't fit in one statement    |
| `SELECT ... FOR UPDATE` | Read → decide in JS → write, on one specific row                | Waiting; long transactions make everyone queue; possible deadlocks |
| Optimistic (`version`)  | Rare conflicts; users edit for a long time (form left open)     | A storm of retries under high contention; retry logic is mandatory |
| REPEATABLE READ + retry | A consistent snapshot across the transaction (reports)          | Catches lost updates but **not write skew**; needs retries         |
| SERIALIZABLE + retry    | Complex rules checked by reading many rows (admins, bookings)   | More failed transactions; retry mandatory; extra overhead          |

### 1.7 Practical rules

- **The default READ COMMITTED is enough for most work** — as long as you know what it doesn't give you. Whenever you see the pattern "read → decide → write", stop and ask: could what I read change before I write?
- **Use an atomic update when you can.** Then `FOR UPDATE` for row-specific work. SERIALIZABLE for complex rules.
- **Be careful with side effects when retrying.** Send an email inside a transaction that gets retried three times, and the user gets three emails, while the data changed only once. Email, payment API calls, messages — do them **after the commit** (the safe way is the "outbox pattern", in Module 7).
- **Keep transactions short.** While a transaction is open it holds its locks (Lesson 5.2's hot row) and ties up a connection (Lesson 5.6). Never make network calls inside a transaction.

---

## 2. Interview Angle

**This topic shows up in interviews in three ways:**

1. **Directly:** "Explain the isolation levels." — naming the four levels isn't enough. Give an **exact example** of each anomaly, and say what your database's (Postgres's) default is and what it doesn't prevent. Saying "Postgres's default READ COMMITTED doesn't prevent lost updates" shows you have actually seen it.

2. **Hidden inside a design question:** "Design a ticket booking system" / "How would you decrement inventory without overselling?" — here the interviewer wants to see whether you spot the race condition on your own. A good answer: "two people could buy the last seat at once — `UPDATE seats SET status = 'booked' WHERE id = ? AND status = 'free'`, then count affected rows; 0 means the seat is gone."

3. **Payments/money:** "Transfer money between two accounts" — atomicity (both balances change together), and making sure two concurrent transfers can't withdraw more than an account holds (locks, or a conditional atomic update `WHERE balance >= amount`). And deadlocks: when two transfers lock two accounts in opposite orders — the fix is always to lock in the same order (e.g. smaller id first).

**Common follow-ups:**

- _"So why not always use SERIALIZABLE?"_ — more failed transactions, retries needed everywhere, overhead; and retries mean handling side effects. Use it where needed
- _"Optimistic or pessimistic?"_ — decide by the conflict rate: low → optimistic (no locking cost), high → pessimistic (to avoid a retry storm). In the exercise, 100 callers on one row made optimistic take 1,200+ retries

---

## 3. Key Takeaway

- A large part of ACID's "C" is your responsibility — the database only protects the rules you declared to it as constraints
- **A transaction alone doesn't prevent races** — under READ COMMITTED, 90 of 100 updates were lost even inside a transaction
- Postgres's MVCC: each transaction sees a snapshot; READ COMMITTED takes a new one per statement, REPEATABLE READ one for the whole transaction; reads and writes don't block each other
- In Postgres: never dirty reads; under READ COMMITTED non-repeatable reads, phantoms, **silent lost updates**, write skew; REPEATABLE READ catches lost updates but **not write skew**; SERIALIZABLE catches everything
- **Write skew** — read → check a condition → write to a different row; being different rows, the conflict is invisible; fix with SERIALIZABLE, `FOR UPDATE` on the rows read, or turn one row into a lock
- The order of fixes: **atomic update** (conditional too) → **`FOR UPDATE`** → **SERIALIZABLE + retry**; optimistic only where conflicts are rare
- Retry means **the whole transaction**, only on retryable errors, with backoff + jitter; side effects after the commit; transactions short and free of network calls

---

## 4. New Terms (Glossary)

| Term                    | Meaning                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **ACID**                | A transaction's four promises — Atomicity (all or nothing), Consistency, Isolation, Durability                                |
| **Isolation Level**     | A declared level of which anomalies the database will allow between concurrent transactions                                   |
| **MVCC**                | Keeping several versions of a row so each transaction sees a snapshot of one moment — reads and writes don't block each other |
| **Lost Update**         | Two transactions read the same value, change it and write it back, and one's write silently erases the other's                |
| **Write Skew**          | Two transactions read the same data to check a condition and write to different rows, and their combined result breaks it     |
| **Pessimistic Locking** | Locking the row at read time (`SELECT ... FOR UPDATE`) so others wait                                                         |
| **Optimistic Locking**  | Taking no lock but keeping a `version`; checking it at write time, and retrying on a mismatch                                 |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. An online shop's code: `const p = await Product.findByPk(id, { transaction }); if (p.stock > 0) await p.update({ stock: p.stock - 1 }, { transaction });` — inside a READ COMMITTED transaction. Stock is 1, and two people press "Buy" at the same moment. What happens? Which anomaly is it? And how would you fix it with **one** SQL statement?
2. TaskFlow's "add a user to a project" transaction is SERIALIZABLE with retries, and inside the transaction it sends the new member a welcome email. At busy times some users get two or three welcome emails. Why? How would you fix it?
3. Postgres's REPEATABLE READ prevents phantoms and catches lost updates. So why can't it be called fully "serializable"? Which result from the exercise proves it?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Both read `stock = 1` (under READ COMMITTED the other hasn't committed yet), both pass the check, both write `stock: 0` — **two items sold with one in stock**, and at the end stock shows 0, so nobody even notices. It's a **lost update** (both read the same row, changed it and wrote it back; the second write covered the first — here two "−1"s merged into one "−1"). The one-statement fix — a conditional atomic update:

```sql
UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0
```

Then count affected rows: 1 means the sale succeeded, 0 means out of stock. The second UPDATE waits for the first one's lock, then the condition is re-checked against the row's new state (`stock = 0`) — it no longer matches, 0 rows change. In Sequelize:

```typescript
const [affected] = await Product.update(
	{ stock: sequelize.literal('stock - 1') },
	{ where: { id, stock: { [Op.gt]: 0 } } }
);
const sold = affected === 1;
```

(Verified: stock 1, 20 buyers at once — five runs, exactly 1 success each time, stock never went negative.) One trap: `Product.decrement(...)` produces the same SQL, but on Postgres its return value doesn't match its type definition (a nested array comes back) — to count affected rows, `update` is the reliable one.

**Question 2:** On a serialization failure the whole transaction runs again — including the code that sends the email. But an email is a **side effect** — the database's rollback can't take it back. The first attempt sent the email, then the transaction failed, and the second attempt sent it again. The fix: send the email **after the commit succeeds**, outside the transaction. Even safer: inside the transaction, write "this email needs sending" into an `outbox` table (which disappears with a rollback), and have a separate worker read from it and send the email — that's the outbox pattern, detailed in Module 7. And an idempotency key (Lesson 2.5) on the email service also prevents an accidental double send.

**Question 3:** Because REPEATABLE READ (in Postgres, really snapshot isolation) only catches conflicts between **two writes to the same row**. When two transactions **read** the same data but write to **different rows**, there's no write-write conflict — yet the result is one no serial execution could produce. That is write skew. The proof: the exercise's `anomalies` step 4 — under REPEATABLE READ Rahim and Karim both committed successfully, and the admin count hit zero; under SERIALIZABLE the second got `40001`. "Serializable" means: the result is as if the transactions ran one after another in some order — write skew's result breaks that definition.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **Ready to run in the repo:** [`exercises/lesson-5.5-transactions/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.5-transactions) — `docker compose up -d --wait && npm install`, then `npm run anomalies` and `npm run lostupdate`. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

Two scripts: `anomalies` runs two transactions' steps in a hand-arranged order to show the five anomalies — identical output every time; `lostupdate` measures 100 concurrent `+1`s with seven strategies. The retry helper recognises Postgres error codes with Zod (not with `as`). Verified by running it in the sandbox: `tsc --noEmit` is clean, `anomalies` run twice with byte-identical output, `lostupdate` run three times with strategies 3–7 at 100/100 every time. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run both scripts. Does `anomalies` match the README exactly? In `lostupdate`, how many survived with strategy 2, and how many retries did optimistic (6) take?

2. **Remove the retry** (README experiment 1): take `withRetry` off strategy 7 and run it. What happened? Write one line on why retry isn't "optional" once you choose SERIALIZABLE.

3. **Fix write skew without SERIALIZABLE** (experiment 2): lock the admin rows with `FOR UPDATE` and run under REPEATABLE READ. Did B wait, get an error, or both? Explain why from the result.

4. **Reduce contention** (experiment 3): spread the 100 increments over 10 projects. How far did optimistic's retries drop? From this number, write the rule "when is optimistic good" in your own words.

5. **Design part:** three new TaskFlow features. For each: what's the race condition, which anomaly, and which strategy (from 1.6's table) would you use — with reasons:
   - (a) a task can be assigned to only one person — two managers assign the same task to two different people at the same moment
   - (b) the free plan allows at most 5 projects per workspace — a sixth project is created from two tabs at once
   - (c) a task's description — two people open the same task's form, write for 10 minutes, then both save

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2, 5.3, 5.4
Current: 5.5 — Transactions, ACID, Isolation Levels
TaskFlow state: Nginx + 4 Express instances, CDN, Redis cache, one PostgreSQL primary;
normalized schema + query-driven indexes; atomic increment for the counter;
the admin-removal rule under SERIALIZABLE + retry (write skew bug fixed)
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.6 — Connection Pooling, N+1 Problem, Query Optimization
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially the result of #3 and your three designs in #5. When you are ready, write `next` — Lesson 5.6: **Connection Pooling, N+1 Problem, Query Optimization** — what the "10 connections in the pool" that kept coming up today really is, how to size a pool (bigger isn't better), when Sequelize's `include` builds one query and when hundreds, and how four Express instances together blow past Postgres's connection limit — hands-on, measured.
