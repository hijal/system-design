# Lesson 5.6 — Connection Pooling, the N+1 Problem, and Query Optimization

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 3.2):** When does the Least Connections algorithm beat Round Robin? For what kind of requests is the difference biggest?

**Prerequisite:** Lesson 1.4 (Keep-alive), Lesson 1.6 (Horizontal scaling), Lesson 5.4 (EXPLAIN), Lesson 5.5 (Transactions)

**By the end of this lesson you will be able to:**

1. Explain why a connection pool is needed and what Sequelize's `pool` options actually do — and measure for yourself why **a bigger pool isn't faster**
2. Calculate when several app instances together exceed the database's connection limit, and know how to avoid it
3. Spot and fix N+1 queries in Sequelize code (`include`, batching, `separate`), and cut extra cost with `raw`/`attributes`

**Tier:** 1 — Runnable Code

---

## 0. Where TaskFlow Is Right Now

TaskFlow's marketing team ran a campaign, and that morning traffic tripled. As in Lesson 3, the ops team scaled Express from 4 instances to 8. And a developer thought, let's speed up the database side too — and raised Sequelize's `pool.max` from 10 to 20. "More connections means more work at once, right?"

Ten minutes later the error log filled up:

```
SequelizeConnectionError: sorry, too many clients already
```

And the requests that were succeeding got **slower** than before.

The same day, another complaint: the workspace dashboard takes several seconds to load. On the developer's local machine it's perfectly fast. The production log showed — **over a thousand SQL queries for a single dashboard request**.

Both problems sit **in front of** the database — not how good the queries are (that was Lesson 5.4), but how the app talks to the database: through how many connections, and how many times. Today we measure both.

---

## 1. Theory

### 1.1 What a connection really is, and why it is expensive

When you run `sequelize.query(...)`, the query actually travels over a **connection** — an open, authenticated conversation between the app and the database. Opening a new connection involves:

```
App                                           PostgreSQL
 │ ── TCP handshake (Lesson 2.2) ───────────────► │
 │ ── (TLS handshake, across a network) ────────► │
 │ ── username + password (SCRAM auth) ─────────► │
 │                                                │ ── a new OS process is created
 │ ◄──────────────────────────── ready ────────── │    (one per connection)
 │ ── SELECT 1 ─────────────────────────────────► │
```

That last line is a Postgres peculiarity: for every connection it runs a **separate OS process**. Opening 5 connections in the exercise's container showed exactly that — 5 separate `postgres: taskflow ... SELECT` processes. Every process needs its own memory, so connections aren't "free" — not even for the database server.

Step 1 of the exercise's `npm run pool` — 200 `SELECT 1`s, one at a time:

```
new connection every time      5.78 ms / query
from the pool                  0.13 ms / query   (~44x faster)
```

And that's **on the same machine**, without TLS. With the app and database on different machines, every new connection adds network round trips and a TLS handshake.

Remember keep-alive from Lesson 1.4? Same reasoning: build the expensive thing (a connection) once, and reuse it again and again.

### 1.2 The connection pool — what Sequelize's `pool` option really is

**Connection pool** — a set of database connections opened in advance, from which each query borrows a connection and returns it when done.

```
Express requests              Pool (max: 10)                PostgreSQL
─────────────────             ──────────────                ──────────
req 1 ──┐                     ┌─ conn 1 (busy) ───────────────► process
req 2 ──┤                     ├─ conn 2 (busy) ───────────────► process
req 3 ──┼── need one ─────►   ├─ conn 3 (free)                  …
  …     │                     │   …
req 25 ─┘                     └─ conn 10
          ▲
          └── when every connection is busy, they queue here (waiting to acquire)
```

You write these options in Sequelize; here is what each one means:

| Option    | Meaning                                                                                 | Sequelize default |
| --------- | --------------------------------------------------------------------------------------- | ----------------- |
| `max`     | The maximum number of connections open at once                                          | 5                 |
| `min`     | The minimum number kept open at all times                                               | 0                 |
| `idle`    | How long a connection can sit unused before it is closed (ms)                           | 10000             |
| `acquire` | When every connection is busy, how long a query waits in the queue before erroring (ms) | 60000             |

(These defaults are Sequelize v6's — check the documentation if your version differs.)

Notice something important: **time spent queuing for the pool shows up as part of the query's time.** The query might take 2 ms in the database, but the user sees 300 ms — because it spent 298 ms in the pool's queue. `EXPLAIN ANALYZE` (Lesson 5.4) will never show you that.

### 1.3 Pool size — bigger isn't faster

Now the developer's reasoning: "a bigger pool runs more queries at once, so it's faster." Step 2 of the exercise measures exactly this: 64 requests at once, 320 queries in total, and pool sizes from 1 to 64. The database container is deliberately limited to **2 CPU cores**. Two kinds of query:

- **CPU** — the database really has to compute (big aggregates, sorts)
- **WAIT** — the database just waits (`pg_sleep`) — like waiting for a lock or a slow disk

```
pool max │   CPU query: q/s    p50 ms    p99 ms │  WAIT query: q/s    p50 ms    p99 ms
       1 │       26      2492      2518        │       48      1329      1334
       2 │       50      1269      1298        │       97       662       665
       4 │       50      1286      1302        │      194       328       333
       8 │       45      1402      1502        │      386       166       167
      16 │       26      2487      2696        │      773        82        84
      32 │       26      2460      3561        │     1535        41        45
      64 │       26      2397      5500        │     1914        20        85
```

**The CPU column** — the most important numbers in this lesson. Throughput peaks at **pool = 2** — exactly the database's core count. Going higher gains nothing, and at 16 or more throughput **halves** (50 → 26 q/s), while p99 leaps (1.3 s → 5.5 s). Because running 64 queries at once on 2 cores makes nobody faster — the CPU keeps switching between them (context switches), caches get thrashed, and every query runs slowly together. In real life, contention for locks and for the disk adds to this.

**The WAIT column** — the opposite picture. The queries don't use the CPU, they just wait — so the more connections, the more waiting happens in parallel, and throughput grows almost proportionally.

So what's the right pool size? The answer: **it depends on what the connections are doing.** Real TaskFlow queries are a mix — some CPU (aggregates, sorts), some waiting (reading pages from disk, locks). A well-known starting point (popularised by the documentation of HikariCP, a Java pool): `connections ≈ (database cores × 2) + number of disks`. It is **a starting estimate**, not a law — then measure on your own workload.

One more calculation helps — **Little's Law**: the average number of things in progress in a system = how many arrive per second × how long each one stays. A TaskFlow example:

```
500 queries per second × 5 ms each on average (0.005 s) = 2.5 connections busy on average
```

So at average load only 2–3 connections are working at any moment. At peak, a few times that. "Pool max 100" is almost never needed — and when it seems to be, it's usually a symptom of slow queries or long transactions (if a query takes 500 ms instead of 5 ms, the same traffic needs 250 connections).

### 1.4 The connection limit — the hidden multiplier of horizontal scaling

Now `sorry, too many clients already`. Postgres has a limit — `max_connections` (default **100**) — the maximum number of connections it accepts at once. The arithmetic is a simple multiplication:

```
number of app instances × pool max per instance  ≤  max_connections − (a few for admin, migrations, cron)

TaskFlow in the morning:  4 × 10 = 40    ✓
after the campaign:       8 × 20 = 160   ✗  more than 100
```

In Lesson 1.6 you learned the app must be stateless to scale horizontally — but every instance has **its own pool**. Double the instances and you double the connections on the database side, and the database's number is limited. With autoscaling it's even more dangerous — instances multiply as load grows, and the connection limit breaks at exactly the worst moment.

Step 3 of the exercise: 5 instances × pool max 25 = asking for 125 connections:

```
succeeded: 75
failed: 50 → "sorry, too many clients already"
```

(How many fail varies every time — 46, 66 and 50 in three runs — because who gets a slot when depends on timing. But failures come every time.)

And there's a different failure too — not the database's limit but **your own pool running out**. **Pool exhaustion** — every connection in the pool is busy, and new queries wait until the `acquire` timeout and then fail. In the exercise: max 2, a 1-second acquire limit, and ten 0.8-second queries:

```
succeeded: 4, ConnectionAcquireTimeoutError: 6
```

The most common cause of pool exhaustion isn't slow queries — it is **long transactions**. In Lesson 5.5 we said: no network calls inside a transaction. Here's why: while a transaction is open, a connection stays tied up. A 2-second payment API call inside a transaction means nobody can use that connection for those 2 seconds. Ten of those at once, and a 10-connection pool is gone.

**The fixes:**

1. **Size the pool by calculation** — keep `instances × max` under the limit, using autoscaling's maximum count. Often the fix is a **smaller** pool.
2. **A connection proxy** — a separate pooler between the app and the database, like **PgBouncer**. **Connection proxy** — accepts many app connections and shares them over a few real database connections. A thousand app connections → 50 database connections. The cost: in "transaction pooling" mode (the most effective one), an app connection may get a different database connection for each transaction, so session-dependent things (session settings via `SET`, session-level advisory locks, `LISTEN`) may not work properly. And prepared-statement support depends on the PgBouncer version — check your version's documentation before using it.
3. **Raise `max_connections`** — possible, but every connection is a process and memory; and as in 1.3, more concurrent queries crowd the CPU. Usually a last resort.
4. **Fail fast** — keep the `acquire` limit low (say a few seconds). A request waiting 60 seconds (the default) is a hanging page to the user; a quick, clear error (and a retry, or "try again shortly") is better. This comes back as part of graceful degradation in Lesson 10.3.

### 1.5 The N+1 problem

Now the dashboard's thousand queries. TaskFlow's code looks perfectly ordinary (from the exercise's `nplusone.ts`):

```typescript
async function nPlusOne(): Promise<Row[]> {
	const rows: Row[] = [];
	const projects = await Project.findAll({ order: [['id', 'ASC']] }); // 1 query
	for (const project of projects) {
		const tasks = await Task.findAll({ where: { projectId: project.id }, order: [['id', 'ASC']] }); // N
		for (const task of tasks) {
			const assignee = await User.findByPk(task.assigneeId); // N×M more
			rows.push({ project: project.name, task: task.title, assignee: assignee?.name ?? '?' });
		}
	}
	return rows;
}
```

**N+1 query** — fetching N things with one query, then running another separate query for each of them — N+1 in total (or, as here, even more when it goes one level deeper). Every line of the code is innocent; the problem only shows when you count how many times it goes to the database.

The exercise's `npm run nplusone` fetches the same dashboard (50 projects, 1,000 tasks, each one's assignee) three ways, and counts every SQL statement:

```
approach                         queries    rows   measured    if RTT = 1 ms*
a. N+1 (findByPk in a loop)        1051    2,050   210.0 ms      1261 ms
b. include (one JOIN)                 1    1,000     7.2 ms         8 ms
c. batching (3 with IN)               3    1,250     3.7 ms         7 ms
```

\* The last column is **a calculation, not a measurement**: `measured time + number of queries × 1 ms`.

There's a trap worth understanding here: in the exercise the app and database are **on the same machine**, so each query's network round trip is nearly zero, and N+1 takes "only" 210 ms. That's why N+1 hides on a developer's machine. In production the app and database are on different machines — every query needs at least one network round trip. Even at 1 ms per round trip, 1,051 queries spend over a second just travelling back and forth. That is the mystery of TaskFlow's "several-second dashboard".

**Fix 1 — eager loading (`include`).** **Eager loading** — fetching the related data at the same time as the main data (usually with a JOIN), rather than one by one later:

```typescript
async function eager(): Promise<Row[]> {
	const projects = await Project.findAll({
		include: [{ model: Task, as: 'tasks', include: [{ model: User, as: 'assignee' }] }],
		order: [
			['id', 'ASC'],
			[{ model: Task, as: 'tasks' }, 'id', 'ASC']
		]
	});
	return projects.flatMap((p) =>
		(p.tasks ?? []).map((t) => ({
			project: p.name,
			task: t.title,
			assignee: t.assignee?.name ?? '?'
		}))
	);
}
```

From 1,051 queries to 1.

**Fix 2 — batching.** One query per level, with `WHERE id IN (...)`: first the projects, then all their tasks at once, then all those tasks' assignees at once — 3 queries in total, joined up in JS with a `Map`. This is the idea behind **DataLoader** in the GraphQL world (remember GraphQL's N+1 problem from Lesson 2.3). Here it is even a little faster than include — because a JOIN repeats the project's data on every task row, while batching fetches each thing once.

**Which one when?** In the ordinary case `include` is simplest. But there's an exception, and it's very common in practice.

**Cartesian explosion.** Including **two** hasMany relations on a project at once — tasks (20 per project) and members (10 per project):

```
approach                         queries    rows   measured
include, one JOIN                     1   10,000    28.2 ms
include, separate: true               3    1,550     8.7 ms
```

**Cartesian explosion** — when one JOIN brings in two separate one-to-many relationships at once, producing, for every "one", a number of rows equal to the **product** of both sides. For each project 20 × 10 = 200 rows (every task paired with every member); 10,000 across 50 projects — while the actual data is only 1,000 tasks + 500 members. Sequelize breaks them apart again, but the database and network work has already been done. With bigger numbers (100 tasks × 50 members) it becomes terrible very quickly.

Sequelize has the fix built in — `separate: true`, which runs a separate `WHERE projectId IN (...)` query for that hasMany:

```typescript
async function twoHasManySeparate(): Promise<number> {
	const projects = await Project.findAll({
		include: [
			{ model: Task, as: 'tasks', separate: true }, // separate query: WHERE projectId IN (...)
			{ model: Member, as: 'members', separate: true }
		]
	});
	return projects.length;
}
```

From 10,000 rows to 1,550, and 3× faster. The lesson: **"always one query" isn't the goal in itself** — the goal is fewer round trips **and** less unnecessary data.

**How do you find N+1?** Rarely by reading code — an `await Model.findX(...)` inside a `for` loop, or `instance.getTasks()` inside a `.map`, slips past review. The reliable way is **counting queries per request**: in development with Sequelize's `logging` (exactly how the exercise counts them), and in production with a tracing tool (Lesson 10.4), which shows how many database calls happened under each request.

### 1.6 Query optimization — the cost outside the database

Even when a query is fast in the database, the cost isn't over — once the data arrives, Sequelize turns every row into a full Model instance (getters, setters, tracking what changed). This is called hydration. With a few rows you don't notice; with many rows you do. The exercise's `npm run hydration` — the same 100,000 tasks:

```
Model instance (default)              200 ms   (100,000 rows, 1.0x)
raw: true                              96 ms   (100,000 rows, 2.1x)
raw: true + only the needed columns    68 ms   (100,000 rows, 2.9x)
```

- **`raw: true`** — returns plain JS objects instead of Model instances. When you don't need `.save()` or association methods afterwards (say, for a report or an export), this is enough — and twice as fast.
- **`attributes: [...]`** — only the columns you need. Less data from the database, over the network and in memory. And a bonus: Lesson 5.4's covering index only helps when the query asks for just the index's columns — with `SELECT *` it never will.

The remaining rules come from earlier lessons, gathered here:

- Always paginate big lists — with a cursor (Lessons 2.5, 5.4)
- `EXPLAIN ANALYZE` first for slow queries (Lesson 5.4)
- Short transactions — they hold pool connections (1.4, Lesson 5.5)
- If a counter or aggregate is needed again and again, denormalise or cache it (Lesson 5.2, Module 4)

> **Trade-off Table — ways to fetch related data**

| Approach                         | Queries     | Good when                                                      | Trap                                                                   |
| -------------------------------- | ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Separate queries in a loop (N+1) | N+1         | Almost never (perhaps for 3–4 items)                           | Fast locally, round trips multiply in production                       |
| `include` (JOIN)                 | 1           | belongsTo, and a single hasMany                                | Two or more hasMany at once → cartesian explosion                      |
| `include` + `separate`           | 1 + k       | Several hasMany relations                                      | One extra round trip per separate include                              |
| Batching (`IN`, DataLoader)      | 1 per level | Complex data or data from different sources; GraphQL resolvers | You write the join-up code yourself; very large `IN` lists have limits |

---

## 2. Interview Angle

**Three very common questions:**

1. **"We scaled app servers from 3 to 10 and now get database connection errors. Why?"** — Each instance has its own pool; `instances × pool max` now exceeds `max_connections`. Fixes: shrink the pools, add a connection proxy like PgBouncer, calculate using autoscaling's maximum. Bonus: "enlarging the pool usually isn't the fix — far more concurrent queries than the database's cores reduces throughput" (even better if you can quote measured numbers behind it).

2. **"A page is slow, but every database query is fast. What could it be?"** — Look at the number of queries per request — N+1. Or pool waiting (the query itself is fast, but getting a connection is slow). Or hydrating many rows. "Every query is fast" doesn't mean "the request is fast".

3. **"How big should the pool be?"** — Not a number, an argument: start from the database's core count (cores × 2 + disks is a well-known starting point), compute the need with Little's Law (queries/s × average time), respect the `instances × max` limit, then measure with a load test.

**In real production:** in serverless (e.g. AWS Lambda) the problem is even sharper — every function instance opens its own connection, and a thousand instances can start suddenly. That's why serverless is almost always paired with a connection proxy (PgBouncer, or the cloud provider's own proxy).

---

## 3. Key Takeaway

- A new connection is expensive — TCP, auth, and in Postgres a separate OS process for each; in the exercise the pool was ~44× faster
- Time queuing for the pool is query time in the user's eyes — `EXPLAIN` doesn't show it
- **Bigger pool ≠ faster** — for CPU work, throughput peaks at the database's core count and drops beyond it while p99 grows; for waiting work it grows. Calculate with Little's Law, then measure
- `instances × pool max ≤ max_connections` — horizontal scaling and autoscaling multiply this number; the fixes are smaller pools and a connection proxy (PgBouncer, knowing its limitations)
- The biggest cause of pool exhaustion is long transactions; fail fast with a low `acquire` limit
- **N+1** hides locally, and round trips multiply in production; `include`, batching, and counting queries per request
- Two hasMany in one JOIN → **cartesian explosion** (10,000 rows instead of 1,000); `separate: true`; `raw: true` and `attributes` for many rows

---

## 4. New Terms (Glossary)

| Term                    | Meaning                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Connection Pool**     | A set of database connections opened in advance; each query borrows one and returns it when done                         |
| **Pool Exhaustion**     | Every connection in the pool is busy, and new queries wait until the acquire timeout and then fail                       |
| **Little's Law**        | The average number of things in progress = arrivals per second × the average time each one takes                         |
| **Connection Proxy**    | A pooler between the app and the database (e.g. PgBouncer) — shares many app connections over a few database connections |
| **N+1 Query**           | Fetching N things with one query, then running another separate query for each                                           |
| **Eager Loading**       | Fetching related data together with the main data (`include` in Sequelize), not one by one later                         |
| **Cartesian Explosion** | When one JOIN brings in two one-to-many relations, producing the product of both sides' rows for every "one"             |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. TaskFlow's database has 8 cores and `max_connections = 100`. There are 4 Express instances, autoscaling up to 12 at peak. There's also a background worker process running its own pool. What pool max would you give each instance, and why? Show the calculation.
2. An endpoint's p99 latency is suddenly 8 seconds, yet the database's slow query log shows nothing and the database's CPU is at 30%. What could it be? Where would you look?
3. To fix an N+1, a developer wrote one huge `include` — the project with its tasks, members, comments, attachments, activity log — all in one query. The page got even slower than before. Why? How would you arrange it?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Budget first: out of 100, keep some for admin, migrations, monitoring and emergency `psql` — say 10. That leaves 90. Give the background worker, say, 10. That leaves 80, shared across 12 instances → at most **6** per instance. Is that enough? By 1.3's reasoning: on an 8-core database, more than a few dozen connections doing real work at once doesn't pay off (cores × 2 + disks ≈ the low 20s); 12 × 6 = 72 concurrent queries is already well above that. So 6 is enough, and probably less would work too. If Little's Law says you need more (e.g. the queries are slow), the real fix is making queries or transactions faster, or PgBouncer — not raising `max_connections`. The key lesson: calculate with the **maximum** number of instances, not the average.

**Question 2:** Queries are fast in the database and the CPU is idle — so the time is going **outside** the database. Most likely: **pool exhaustion** — requests are queuing for a connection (an 8-second p99 means some are waiting a long time). Why? Some endpoint holds a transaction open while making a slow external API call inside it, or an N+1 borrows a connection hundreds of times in one request. Where to look: the pool's metrics (how many connections are busy, how many are queued — from Sequelize's pool or from tracing), the number of queries per request, and `pg_stat_activity` in the database — many connections in the `idle in transaction` state tell you the app is holding transactions open while doing other work.

**Question 3:** Five hasMany relations in one JOIN — the extreme form of **cartesian explosion**. For each project, tasks × members × comments × attachments × activity rows — say 50 × 10 × 200 × 30 × 500 — in the tens of millions. The database and network are busy building and shipping that enormous row set, and Sequelize has to break it apart again. The fix: keep belongsTo relations (like the project's owner) in the JOIN, but put `separate: true` on every hasMany — one `IN` query each, 6 queries in total, with row counts equal to the real data. And question it — does one page really need every comment and the entire activity log? Probably the latest few, paginated, in a separate request.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **Ready to run in the repo:** [`exercises/lesson-5.6-pooling-nplusone/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.6-pooling-nplusone) — `docker compose up -d --wait && npm install`, then `npm run pool`, `npm run nplusone`, `npm run hydration`. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

Three scripts: the cost of connections and pool size (the database container is limited to 2 cores, so results look the same on any machine), N+1 and cartesian explosion (counting every SQL statement), and hydration. Verified by running it in the sandbox: `tsc --noEmit` is clean, pool step 2 run twice with nearly identical numbers, `nplusone`'s query and row counts identical, and the three approaches return the same data. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run the three scripts. Where does the CPU column peak on your machine? Does it match the README?

2. **Add cores** (README experiment 1): set `cpus: '4'` and run `npm run pool -- 2`. Where did the peak move? Write the pool-size rule in your own words in one paragraph, using the result.

3. **Fail fast vs waiting** (experiment 2): change `acquire` from 1 second to 60 seconds. How many succeeded, and how long did the last one wait? Which would you choose for an API, and why?

4. **Hide an N+1** (experiment 4): remove the assignee include from `eager()` and call `findByPk` in the loop instead. How many queries now? Then think — how could TaskFlow's code review catch this? (Hint: a limit on queries per request in tests.)

5. **Design part:** TaskFlow now has 4 Express instances (10 at peak), a BullMQ worker (coming in Module 7, with its own pool), and a database with 8 cores and `max_connections = 100`. Write a **pool plan**: each process's pool max, the `acquire` limit, and under what conditions (which numbers) you would add PgBouncer. Show the calculation.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2, 5.3, 5.4, 5.5
Current: 5.6 — Connection Pooling, N+1, Query Optimization
TaskFlow state: Nginx + 4–8 Express instances, CDN, Redis cache, one PostgreSQL primary;
pool sizes calculated so instances × max ≤ max_connections; the dashboard's N+1 fixed
(include + separate); raw + attributes for reports
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.7 — Replication (Master-Slave, Master-Master, Read Scaling)
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially where the peak moved after adding cores in #2, and your pool plan in #5. When you are ready, write `next` — Lesson 5.7: **Replication** — when one database can no longer handle the reads, what then? How data travels from a primary to a replica (remember Lesson 5.3's WAL?), scaling reads with read replicas, replication lag and its strange bug ("I just saved it, but it isn't showing!"), and failover — hands-on, with a real Postgres primary + replica in Docker.
