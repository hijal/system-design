# Module 5 — Exit Challenge (Database Design & Scaling)

**Module 5 — Database Design & Scaling**

Module 5's nine lessons are done — the real trade-off behind SQL vs NoSQL, schemas and normalisation, the inside of a storage engine, indexes, transactions and isolation, connection pools and N+1, replication, sharding, and CAP/quorums. Each lesson looked at one problem on its own. In real life problems don't come alone — they come on the same day, tangled up with each other. This Exit Challenge is exactly that kind of day.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** it's the week of TaskFlow's biggest launch of the year. 2,000,000 daily active users, ~2,800 writes a second on the primary database at peak. TaskFlow's current state:
>
> - Express instances autoscaled from 4 to 12 on launch day, each with Sequelize `pool: { max: 20 }`; Postgres has `max_connections = 200`
> - One PostgreSQL primary and one async read replica; last month Sequelize's `replication` config was switched on, so every read outside a transaction goes to the replica
> - The `activity_log` table is 2.3 TB and not partitioned; every night a job runs `DELETE FROM activity_log WHERE "createdAt" < now() - interval '1 year'`
> - The task-assignment code: `const task = await Task.findByPk(id, { transaction }); if (task.assigneeId === null) await task.update({ assigneeId }, { transaction });` — default isolation (READ COMMITTED)
> - The `tasks` table has indexes on `("projectId", status)` and `("assigneeId")`
> - One enterprise customer alone accounts for 45% of all writes
>
> **What's happening:**
>
> 1. On launch morning, as soon as there are 12 instances, the error log fills with `sorry, too many clients already`. The requests that do succeed are slow too.
> 2. The workspace dashboard takes 4–6 seconds in production. On a developer's machine the same page takes 200 ms. Tracing shows ~1,400 SQL queries in one request.
> 3. Two kinds of support tickets: (a) "I created a new task, it said 'Saved', but it isn't in the list"; (b) "the same task showed both of us as assigned at once, then one name disappeared".
> 4. The "overdue tasks" report — `WHERE date("dueAt") < current_date AND status <> 'done'` — takes 30+ seconds every time, and everything else slows down while it runs.
> 5. The nightly cleanup job now runs for 5 hours. During that time the replica's lag reaches 40 minutes, and the table isn't getting any smaller.
> 6. Someone on the team proposed: "writes are growing, let's split into 8 shards by `hash(taskId)` right now — the split will be perfectly even." Someone else said: "forget all this, let's move everything to MongoDB — it's schemaless, and NoSQL scales."
> 7. The board has approved a second region in Singapore. The CTO wants to know: what happens when the link between the two regions goes down?

Your task — for each question below, make a decision by applying Module 5's concepts (and earlier modules' where relevant), with your reasoning. Wherever possible, use **numbers**.

**1. `too many clients` (Lesson 5.6)**
Show the arithmetic — why did this happen at 12 instances? And "successful requests are slow too" — is that the same cause, or a different one? In your fix, what's each instance's pool max, and why do you lower the number rather than raise it — relate it to the database's core count. Under what conditions would you need PgBouncer, and which of its limitations would you keep in mind?

**2. The 1,400-query dashboard (Lesson 5.6)**
What kind of problem is it, and why was it hiding on the developer's machine — explain with numbers (assume 1 ms per round trip). What trap might you fall into if you stuff everything into one big `include` to fix it? And what process would you put in place so it never creeps back in?

**3. The two kinds of tickets (Lessons 5.7 + 5.5)**
(a) and (b) are two different bugs with different causes. Name each (which anomaly or consistency guarantee is broken), say exactly how it happens, and give the fix. For (b), give at least two fixes and say which you'd choose. Remember: the task-assignment code is **already inside a transaction** — so why doesn't it work?

**4. The 30-second report (Lessons 5.4 + 5.7)**
Why is it so slow despite the indexes — find at least two reasons (look carefully at both the query and the indexes). How would you rewrite the query, and which index would you add? And "everything else slows down while it runs" — should this report run on the primary at all?

**5. The nightly cleanup and replica lag (Lessons 5.8 + 5.3 + 5.7)**
Three symptoms — 5 hours, 40 minutes of lag, no shrinking — explain why each happens using the WAL and MVCC. What's your fix, and what's the path to moving a **live** 2.3 TB table onto that fix? And what happens to problem 3(a) during the replica's 40 minutes of lag?

**6. The sharding and MongoDB proposals (Lessons 5.8 + 5.1)**
Answer both proposals, with numbers. What's wrong with `hash(taskId)` — which queries and transactions will break? If you really have to shard, which key would you use, and how would you handle the 45% customer? And what would you do before sharding? Check the MongoDB proposal's three claims ("schemaless", "no migrations needed", "it scales") one by one.

**7. Singapore and CAP (Lesson 5.9)**
For at least five kinds of TaskFlow data, say: CP or AP when the link goes down, and latency or consistency on a normal day (PACELC). Then answer the CTO in three lines. And if you went multi-leader (tasks writable in both regions), what conflicts would arise, and why wouldn't you rely on last-write-wins?

**8. The whole plan on one page (Lessons 5.1–5.9)**
Putting all of the above together, build a **priority list**: what you'd do today on launch day (within hours), this week, and this quarter. Next to each, one line: which lesson, and how you'll measure success (which metric).

**Things to remember:** the three easiest places to go wrong in this module are — (a) thinking "a transaction makes it safe", (b) thinking "a bigger pool = faster", (c) deciding to shard or switch databases without numbers. All three are hiding in today's scenario. And the most important habit, carried over from Module 4: **diagnose before you prescribe** — for each symptom, first say how you'd confirm what the cause really is (which metric, which `EXPLAIN`, which log).

I'll critique it step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

- [ ] I can name the real four axes of "SQL vs NoSQL" (data model, where the schema lives, query flexibility, guarantees), and check the claim "NoSQL scales" with numbers
- [ ] I know the difference between schema-on-write and schema-on-read — and why "schemaless" doesn't mean migrations disappear, only that they move
- [ ] I can recognise update, insert and delete anomalies and fix them with 1NF/2NF/3NF; I know the difference between a snapshot (the price at purchase time) and denormalisation
- [ ] I fix the query **before** denormalising (the LATERAL example), and can keep a denormalised counter correct with an atomic update + a reconciliation job
- [ ] I can explain how pages, the B-tree and the WAL work — why 4 pages are enough among 400,000 rows, and how committed data comes back after a crash
- [ ] I can state the trade-offs between B-trees and LSM-trees (write, read, space amplification), and I know "B-tree for reads, LSM for writes" is a rule of thumb, not a law
- [ ] I can read `EXPLAIN (ANALYZE, BUFFERS)` — Seq Scan, Index Scan, Bitmap, Index Only Scan, Sort, and why `pages` is often more honest than time
- [ ] I can explain, with examples, column order in composite indexes (equality first, range/ORDER BY after), the leftmost prefix, the function/cast trap, selectivity, and partial/expression/covering indexes
- [ ] I know the write cost (time and WAL) of every index, and I build indexes **from queries**, not from columns
- [ ] I can recognise the five anomalies (dirty read, non-repeatable, phantom, lost update, write skew), and I've seen for myself which Postgres isolation level prevents which
- [ ] I understand why "a transaction alone doesn't prevent races"; and I can choose correctly among an atomic update, `FOR UPDATE`, optimistic locking, and SERIALIZABLE + retry
- [ ] I know that a retry means the whole transaction, only on retryable errors, with backoff + jitter; and why side effects (emails) are dangerous with retries
- [ ] I can explain with core counts and Little's Law why pool size isn't "the bigger the better"; I can calculate `instances × pool max ≤ max_connections`
- [ ] I can spot and fix N+1 (`include`, batching), and I know why joining two hasMany relations at once causes a cartesian explosion
- [ ] I've measured how replication lag causes the read-your-writes bug, and where the three fixes (useMaster, an LSN token, sync commit) put their cost
- [ ] I can explain async vs sync replication, the failover steps, RPO/RTO, and that a timeout on a sync commit isn't a rollback
- [ ] I know the difference between partitioning and sharding; when partitioning helps (retention) and when it doesn't (as a substitute for indexes)
- [ ] I know the four rules for choosing a shard key, can recognise hot partitions, and can say what breaks across shards (scatter-gather, transactions, unique IDs); and what to try before sharding
- [ ] I can state CAP correctly (not "two of three"), that CAP's C = linearizability, and explain the everyday latency-vs-consistency choice with PACELC
- [ ] I can explain why `R + W > N` prevents stale reads — with both the reasoning and measured results; and make a separate CAP choice for **each piece of data** in a system

---

## 3. Recommendation

**To read:**

- **Martin Kleppmann — _Designing Data-Intensive Applications_ (O'Reilly).** The book closest to this module — the deep version of nearly every lesson is here. Start with chapter 3 (storage and retrieval — Lesson 5.3), chapter 5 (replication — 5.7), chapter 6 (partitioning — 5.8) and chapter 7 (transactions — 5.5). Chapter 9 (consistency and consensus) is most useful if read before Module 6.
- **Markus Winand — _Use The Index, Luke!_ (use-the-index-luke.com, free).** The full version of Lesson 5.4 — composite indexes, the function trap, pagination — database-neutral, with very clear examples.
- **The official PostgreSQL documentation** — four pages: "Transaction Isolation" (the source of 5.5's table), "Explicit Locking", "Using EXPLAIN" (5.4), and "Table Partitioning" (5.8). Postgres's documentation is unusually well written — the first place to go whenever you're unsure how your database behaves.

**To watch:**

- **The Carnegie Mellon University Database Group's lectures (YouTube)** — Andy Pavlo's "Intro to Database Systems" course. Storage, indexes, concurrency control and recovery — the machinery inside today's lessons, through a database researcher's eyes.
- **Jepsen's analyses (jepsen.io)** — hands-on tests of whether various distributed databases' consistency claims actually hold. Read them after Lesson 5.9 and you'll see how often claims like "CA" or "strongly consistent" break in practice — and how they get caught.

**For a project:**

- Go back to Lesson 5.5's exercise and build TaskFlow's **task-assignment** race yourself: assigning after checking `assigneeId IS NULL`, 20 callers at once. First the naive version (see how many "succeed"), then fix it with a conditional atomic update (`UPDATE ... WHERE id = ? AND "assigneeId" IS NULL`, counting affected rows) — until exactly 1 succeeds.
- In Lesson 5.7's cluster, keeping Sequelize's replication config, write a small Express middleware: reads by a user who wrote something in the last 10 seconds (the time kept in a cookie) go through `useMaster: true`. Then measure it like `npm run lag` — zero stale reads, while most reads still go to the replica.
- To go one step further: using Lesson 5.8's `activity` partitioned table, try the path of moving a **live** table into a partitioned one — create a new partitioned table and `ATTACH` the old table as one partition. This is direct practice for question 5 of the challenge.

---

Send the exit challenge over when you've done it. When you're ready, write `next` and we'll move on to **Module 6: Distributed Systems Core** — starting with Lesson 6.1: what breaks in a distributed system, network partitions and split brain.

Throughout Module 5 we spread the database across several machines — replicas, shards, a second region. And every time, one question came up and stopped us: "is the other machine dead, or just slow?", "who becomes the leader?", "which of two events happened first?". In Module 6 we face exactly those questions — why they're so hard, and how distributed systems still manage to work.
