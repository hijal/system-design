# Lesson 5.2 — Schema & Data Modeling: Normalization and Deliberate Denormalization

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 4.3):** Why is cache invalidation said to be hard? And if the invalidation code is forgotten somewhere, what role does the TTL play?

**Prerequisite:** Lesson 5.1 (SQL vs NoSQL), Lesson 4.3 (Invalidation, TTL)

**By the end of this lesson you will be able to:**

1. Spot the update, insert and delete anomalies in a bad schema, and fix them using the rules of 1NF, 2NF and 3NF
2. Model 1:N and M:N relationships (with a junction table) in Sequelize, fully typed
3. Decide **by measuring** when to denormalise on purpose, and understand the cost of keeping denormalised data correct (atomic updates, reconciliation)

**Tier:** 1 — Runnable Code

---

## 0. Where TaskFlow Is Right Now

Lesson 5.1's decision: TaskFlow stays on Postgres. But being on Postgres doesn't mean the data is **well organised**.

The very first version of TaskFlow was built in two days at a hackathon. Back then everything was put in one table — "we'll fix it later". That "later" has now arrived, with three strange complaints in support:

1. Rahim changed his name in his profile from "Rahim" to "Rahim Uddin". But some tasks show the new name, and some still show the old one.
2. Filtering by the "bug" tag also returns tasks whose tag is actually "debug".
3. The marketing team deleted the last task in their project — and the whole project vanished from the list.

And at the same time, a new request from the product team: **"the 10 busiest projects"** on the dashboard (the ones with the most open tasks). TaskFlow now has about 400,000 tasks, and the query counts all of them every time.

Today's lesson has two halves: first we fix the first three problems with **normalisation**. Then, for the dashboard, we **break normalisation on purpose** — and see what that costs.

---

## 1. Theory

### 1.1 The language of data modelling — entity, relationship, cardinality

Data modelling means deciding: what "things" (entities) exist in the system, what information each carries, and how they are connected to one another.

**Cardinality** — in a relationship between two entities, how many on one side can be connected to how many on the other. Three kinds:

```
1 : 1     User ──────── Profile        one user has exactly one profile
1 : N     Project ────< Task           a project has many tasks, each task belongs to one project
M : N     Task >──────< Tag            a task has many tags, a tag is on many tasks
```

You write these in Sequelize every day, perhaps without thinking of them by these names:

| Cardinality | Sequelize                                    | What actually exists in the database                      |
| ----------- | -------------------------------------------- | --------------------------------------------------------- |
| 1 : 1       | `hasOne` + `belongsTo`                       | a foreign key on one side (unique)                        |
| 1 : N       | `hasMany` + `belongsTo`                      | a foreign key in the "N" side's table (`tasks.projectId`) |
| M : N       | `belongsToMany` (from both sides, `through`) | a third table — the **junction table**                    |

**Junction table** — a separate table for storing an M:N relationship, in which every row is a pair (`taskId`, `tagId`). A relational database has no other good way to store M:N directly — why becomes clear in 1.3.

**A common trap:** Postgres **does not create an index on a foreign key column by itself**. Without an index on `tasks.projectId`, both "all tasks in this project" and a JOIN may scan the whole table. That is why we added the index by hand in the exercise's model. Details in Lesson 5.4.

### 1.2 The three diseases of a bad schema — anomalies

TaskFlow's hackathon version had a table like this:

```
bad_tasks
┌────┬───────────────────┬─────────────┬────────────────────┬──────────────┬────────────┐
│ id │ title             │ projectName │ assigneeEmail      │ assigneeName │ tags       │
├────┼───────────────────┼─────────────┼────────────────────┼──────────────┼────────────┤
│ 1  │ Fix the login bug │ Website     │ rahim@taskflow.app │ Rahim        │ bug,urgent │
│ 2  │ Add logging       │ Website     │ rahim@taskflow.app │ Rahim        │ debug      │
│ 3  │ Q3 campaign plan  │ Marketing   │ karim@taskflow.app │ Karim        │ planning   │
└────┴───────────────────┴─────────────┴────────────────────┴──────────────┴────────────┘
```

On day one this is wonderfully simple — one query gets you everything, no JOINs. The problem is that **the same fact lives in several places** (Rahim's name in two rows, "Website" in two rows), and **one fact survives by leaning on another** (the Marketing project's existence depends on one task).

**Data anomaly** — incorrect or inconsistent data produced while inserting, updating or deleting, because of the way the schema is structured. Three kinds:

- **Update anomaly:** changing one fact doesn't change all its copies. The code for renaming Rahim updated only the task being edited — now the same email has **two names**.
- **Delete anomaly:** deleting one thing loses the information about something else. Delete Marketing's last task and the Marketing project itself disappears, because the project has no row of its own.
- **Insert anomaly:** storing one thing requires something else that doesn't exist yet. You want to create a new project, but there is no place for a project without a task — you'd have to invent a fake task.

And the `tags` column's "bug,urgent" — that is a separate disease, covered in the next section.

The exercise's `npm run anomalies` performs exactly these three operations, on both schemas side by side:

```
━━ Denormalized (bad_tasks) — everything in one table
1. How many names does rahim@taskflow.app have?  2 → "Rahim", "Rahim Uddin"
2. How many tasks with the "bug" tag?            2 → "Add logging", "Fix the login bug"
3. How many projects after deleting the task?    1 → Website  (Marketing is gone!)

━━ Normalized (users / projects / tasks / tags)
1. How many names does rahim@taskflow.app have?  1 → "Rahim Uddin"
2. How many tasks with the "bug" tag?            1 → "Fix the login bug"
3. How many projects after deleting the task?    2 → Marketing, Website
```

The scariest part: **none** of the first three lines produced an error. The database happily kept wrong data. Anomalies don't crash production — they quietly corrupt data, and get caught a month later in an annoyed user's support ticket.

### 1.3 Normalisation — 1NF, 2NF, 3NF

**Normalization** — splitting tables so that every fact lives in **exactly one place**, leaving no room for anomalies.

**Normal form** — a stage of normalisation. Each stage removes one particular kind of redundancy. In practice, knowing three is enough:

**1NF — one value per cell.** `tags = "bug,urgent"` breaks 1NF. With a list in one cell, the database can't look inside it — so you search with `LIKE '%bug%'`, which also catches "debug". No index can help either, and renaming a tag means hunting through every string to change it.

The fix: tags in their own table, and the task–tag pairs in a junction table. That's the M:N:

```
tasks                task_tags               tags
┌────┬───────┐       ┌────────┬───────┐      ┌────┬──────────┐
│ id │ title │       │ taskId │ tagId │      │ id │ name     │
├────┼───────┤       ├────────┼───────┤      ├────┼──────────┤
│ 1  │ Login │◄──────│ 1      │ 1     │─────►│ 1  │ bug      │
│ 2  │ Log…  │◄──┐   │ 1      │ 2     │─┐    │ 2  │ urgent   │
└────┴───────┘   └───│ 2      │ 3     │ └───►│ 3  │ debug    │
                     └────────┴───────┘      └────┴──────────┘
                     primary key = (taskId, tagId)
```

**2NF — depend on the whole composite key, not part of it.** Say someone adds a `tagName` column to `task_tags` for convenience: `(taskId, tagId, tagName)`. Now `tagName` depends only on `tagId` — on **half** of the key. The result? If the "urgent" tag is on 1,000 tasks, its name is copied 1,000 times — the old update anomaly is back.

**3NF — don't depend on anything but the key.** If `tasks` keeps both `assigneeId` and `assigneeEmail`, `assigneeEmail` isn't really a fact about the task — it is a fact about the **user**, connected to the task through `assigneeId`. This is called a transitive dependency (task → user → email). The fix: email lives only in the `users` table.

There's an old line for remembering it — every column should depend on:

> "**the key** (1NF), **the whole key** (2NF), and **nothing but the key** (3NF)"

**An honest caveat:** there are normal forms beyond 3NF — BCNF, 4NF, 5NF. They matter in database theory, but in an ordinary product schema, once you reach 3NF their problems almost never show up. In an interview, explaining up to 3NF clearly is enough.

TaskFlow's normalised schema in Sequelize (from the exercise's `src/models/good.ts`, the association part):

```typescript
Project.hasMany(Task, { foreignKey: { name: 'projectId', allowNull: false }, onDelete: 'CASCADE' });
Task.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: false } });

User.hasMany(Task, { foreignKey: 'assigneeId', onDelete: 'SET NULL' });
Task.belongsTo(User, { as: 'assignee', foreignKey: 'assigneeId' });

Task.belongsToMany(Tag, { through: TaskTag, foreignKey: 'taskId', otherKey: 'tagId' });
Tag.belongsToMany(Task, { through: TaskTag, foreignKey: 'tagId', otherKey: 'taskId' });
```

Why the two `onDelete`s differ, in one line: when a project is deleted its tasks have no reason to exist (`CASCADE`), but when a user leaves, their tasks stay, just unassigned (`SET NULL`). That is a **business decision**, not a database decision.

**But is every copy wrong?** No — this is where many people get confused. Copying a product's price into an e-commerce order does not break normalisation. The order's price is **the price at the moment of purchase** — a historical fact. If the product's price changes later, the old order's price should definitely not change. This is called a **snapshot**. The question is always: "is this copy **supposed to change in step** with the original?" If yes, it is denormalisation (and keeping it in sync is your job). If no, it is a snapshot, and copying is the right thing to do.

### 1.4 Denormalisation — breaking the rules on purpose

In a normalised schema every fact is in one place — writing is easy and safe. But **reading** can be expensive, because building the answer needs JOINs and counting.

**Denormalization** — deliberately copying data or precomputing it to make reads faster, knowing that keeping it in sync is now your responsibility.

Three common forms:

- **A copied column** — keeping `projectName` in `tasks`, so the task list needs no JOIN
- **A precomputed value (derived data)** — `projects.openTaskCount`, so you don't need `COUNT(*)` every time
- **A prebuilt view** — computing a whole report in advance (a materialized view in Postgres, which has to be refreshed periodically)

Now TaskFlow's dashboard. The exercise's `npm run dashboard` creates 500 projects and 400,000 tasks and measures the same question several ways (on my machine, median of 30 runs):

```
question                       counted (simple)   counted (LATERAL)   read counter
page of 20 projects               39.18 ms            1.78 ms            0.42 ms
10 busiest projects               39.34 ms               —               0.31 ms
```

Look carefully at the first line — the most important lesson of this lesson is hiding there.

The simple query (`LEFT JOIN ... GROUP BY p.id ORDER BY p.name LIMIT 20`) takes 39 ms. Because, as `EXPLAIN ANALYZE` shows: even with `LIMIT 20`, Postgres first builds the count for **all 500 projects** (a Seq Scan + HashAggregate over 400,000 tasks), then keeps 20. Write the query a little differently — pick the 20 projects first, then count **only their** tasks (`LATERAL`) — and the time drops to **1.78 ms, without changing the schema**.

```sql
SELECT p.id, p.name, c.open
FROM (SELECT id, name FROM projects ORDER BY name LIMIT 20) p
CROSS JOIN LATERAL (
  SELECT count(*) AS open FROM tasks t
  WHERE t."projectId" = p.id AND t.status <> 'done'
) c
ORDER BY p.name;
```

(`LATERAL` means "for every row on the left, run the subquery on the right". With the `(projectId, status)` index, each count is done by reading the index alone.)

But in the second line — "the 10 busiest" — this trick doesn't work. **To know which 10 are busiest, you have to count them all first.** No query trick avoids that. Here the `openTaskCount` column (even better with an index on it) makes a roughly 100× difference.

> **The rule:** fix the query before you denormalise. Denormalisation's real place is when you want to **sort or filter by a derived value**, or when a measured, hot read path is still slow after fixing the query.

**Do you recognise what this really is?** `openTaskCount` is **a cache inside the database** — a computed copy of the source of truth (the `tasks` table). And from Module 4 you know the hardest problem of caching: **invalidation**. Denormalisation has exactly the same problem under a different name.

### 1.5 The cost — keeping the counter correct

Once the counter exists, every write path has to remember it. The exercise's `npm run counter` creates **200 tasks at once** in one project, three ways:

```
a. read-modify-write               counter =   1   actual = 200   ✗ 199 lost
b. transaction + increment         counter = 200   actual = 200   ✓ correct
c. 50 bulk imports after b         counter = 200   actual = 250   ✗ 50 lost
```

**The code for (a) looks perfectly innocent:**

```typescript
async function naive(projectId: number): Promise<void> {
	await Task.create({ title: 'naive', projectId, assigneeId: null });
	const project = await Project.findByPk(projectId);
	if (!project) throw new Error('project missing');
	project.openTaskCount = project.openTaskCount + 1;
	await project.save();
}
```

The problem: "read → add 1 in JS → write" is three separate steps. If two requests read the counter as 41 at the same time, both write 42 — one increment is lost. This is called a **lost update**. Losing 199 in the exercise sounds extreme — it happens because the 200 `INSERT`s get into the pool's queue first, so every `SELECT` runs while the counter is still 0. Real traffic won't lose this many, but a gap of a few milliseconds between two requests is enough. And if you test it alone on your local machine, this bug is **never caught**.

**(b) — the fixed version:**

```typescript
async function atomic(projectId: number): Promise<void> {
	await sequelize.transaction(async (transaction) => {
		await Task.create({ title: 'atomic', projectId, assigneeId: null }, { transaction });
		await Project.increment('openTaskCount', { by: 1, where: { id: projectId }, transaction });
	});
}
```

Two separate things are at work here:

- `Project.increment` produces `UPDATE projects SET "openTaskCount" = "openTaskCount" + 1 WHERE id = ...` — the **database itself** does the arithmetic, holding the row lock. Nobody can overwrite anyone else's write.
- The `transaction` guarantees that creating the task and incrementing the counter — **either both happen or neither does**. If the server crashes after creating the task but before incrementing, both are rolled back.

Remember — a transaction alone does not prevent lost updates. What happens if you write (a)'s read-modify-write inside a transaction, and why — that is the exercise's experiment 3, fully explained in Lesson 5.5 (isolation levels).

**(c) — the most common real-world failure isn't a race, it's forgetting.** Six months later someone builds a CSV import feature with `Task.bulkCreate` — the counter never crossed their mind. No error; the counter quietly falls 50 behind.

The remedy is a **safety net** much like Module 4's TTL — a **reconciliation job**: periodically (say every night) it recomputes the derived data from the source of truth and fixes any mismatch (and logs/alerts the number of mismatches — that number is what tells you some write path has forgotten the counter). In the exercise:

```
ran reconcile() — 2 projects had a wrong counter, fixed
```

**Three ways to keep the counter in sync, with trade-offs:**

| Approach                                    | Upside                                                    | Cost                                                                                  |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| In app code, in the same transaction (b)    | Explicit; you can see it by reading the code              | Every write path has to remember it (c)                                               |
| Database trigger                            | Impossible to forget a path, even bulk imports            | Logic is hidden in the DB — invisible when reading app code; harder to debug and test |
| Async — update later via a queue (Module 7) | Fast writes; the counter's load isn't on the main request | The counter lags for a while (eventual) — often fine for a dashboard, not for money   |

And whichever you choose — **keep a reconciliation job**.

There is also a hidden cost: every increment locks **the same single row** of that project. In a huge project, if 30 people create tasks at the same time, they all queue for that one row. This is called a hot row — the database version of Lesson 4.6's hot key. Its solutions (splitting the counter into several pieces, or counting in Redis and writing to the DB later) are topics for later lessons.

> **Trade-off Table — Normalized vs Denormalized**

| Aspect                      | Normalized                                | Denormalized                                              |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Writes                      | Simple, in one place                      | Every copy/counter must also be updated                   |
| Reads                       | Need JOIN/COUNT — usually fast enough     | Very fast, especially sorting/filtering by derived values |
| Correctness                 | The schema itself protects it             | Your code and a reconciliation job protect it             |
| New questions (flexibility) | Any JOIN can be written                   | A new question may need a new copy                        |
| When it goes wrong          | Anomalies — stop once the schema is fixed | Drift — silent, undetected without reconciliation         |

### 1.6 The decision rules

```
1. Start normalised (3NF)                       ── this is the default
2. A read path is slow? → measure first         ── EXPLAIN ANALYZE, not guesses
3. Can the query/index be fixed? → do that first ── LATERAL, index (Lesson 5.4)
4. Still slow, or sorting by a derived value?  ── now denormalise — one specific thing
5. When you denormalise, write down:            ── which write paths change it,
                                                   how it stays in sync, where reconciliation runs
```

And keep the alternative in mind: sometimes it is better to denormalise **in the cache** (Module 4) rather than in the database — a counter or computed result in Redis, with a TTL. Then the source of truth stays cleanly normalised, and the "speed" lives in the cache layer, which loses nothing if it is wiped.

---

## 2. Interview Angle

**"Design a database schema for X"** — a very common part of system design interviews. The steps of a good answer:

1. **State the entities and relationships first:** "User, Project, Task, Tag — Project and Task are 1:N, Task and Tag are M:N, so a junction table"
2. **Start normalised** — draw the tables and keys
3. **Then look for hot read paths:** "the feed shows a like count every time, and the read:write ratio is very high — so I'll denormalise `likeCount`"
4. **Name the cost yourself:** "on a like, an atomic increment in the same transaction; plus a reconciliation job" — saying this before the interviewer asks shows you have seen it in production

**Common follow-ups:**

- _"What happens to the `likeCount` row when a post suddenly gets millions of likes?"_ — A hot row: every increment queues for one row's lock. Solutions: keep the counter split into several pieces (sum them when reading), or `INCR` in Redis and write to the DB every few seconds — in both, the counter may lag a little
- _"Is copying the product price into the order table denormalisation?"_ — No, that's a snapshot (1.3)
- _"What is 3NF?"_ — "the key, the whole key, and nothing but the key", with an example for each

**In real production:** most schemas start normalised, and over time a handful of counters or copied columns get added — each because of a measured problem. The opposite — "denormalise everything from day one, we'll see later" — almost always ends in a jungle of anomalies, exactly like TaskFlow's hackathon version.

---

## 3. Key Takeaway

- Cardinality comes in three kinds — 1:1, 1:N, M:N; M:N needs a junction table; Postgres doesn't index foreign keys by itself
- The same fact in several places breeds update, insert and delete anomalies — and they raise no error, they quietly corrupt data
- 1NF (one value per cell), 2NF (the whole key), 3NF (nothing but the key) — "the key, the whole key, and nothing but the key"
- Not every copy is denormalisation — the price at the moment of purchase is a **snapshot**, and copying it is correct
- **Fix the query before denormalising** — in the exercise, LATERAL alone took 39 ms down to 1.78 ms; denormalisation's real place is sorting/filtering by derived values
- Denormalised data is really a cache inside the database — so it has the same invalidation problem
- To keep a counter correct: an atomic update in the same transaction, and always a **reconciliation job** — because someday someone will forget the counter in some write path

---

## 4. New Terms (Glossary)

| Term                   | Meaning                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Cardinality**        | In a relationship between two entities, how many on one side connect to how many on the other — 1:1, 1:N, M:N |
| **Junction Table**     | A separate table storing an M:N relationship, each row a pair from the two sides (e.g. `taskId`, `tagId`)     |
| **Data Anomaly**       | Wrong or inconsistent data produced on insert, update or delete because of the schema's structure             |
| **Normalization**      | Splitting tables so every fact lives in exactly one place, leaving no room for anomalies                      |
| **Normal Form**        | A stage of normalisation (1NF, 2NF, 3NF…) — each removes one particular kind of redundancy                    |
| **Denormalization**    | Deliberately copying or precomputing data to speed up reads — keeping it in sync is your responsibility       |
| **Reconciliation Job** | Periodically recomputing derived data from the source of truth to catch and fix mismatches                    |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. TaskFlow has an activity log: "Rahim moved task #42 to Done". Should each log row store `actorId` (the user's id) or `actorName` (a copy of the name)? If Rahim later changes his name, what will each show? Which is "correct" — and is this a technical question, or something else?
2. To keep `openTaskCount` in sync, a senior engineer said: "Not in app code — use a database trigger, then nobody can ever forget it." What is the strength of this argument, and what do you lose? Is a reconciliation job still needed with a trigger?
3. Suppose a huge enterprise project has 50,000 tasks, and at 9 a.m. 40 people create tasks at the same time. (b)'s atomic increment works correctly, the counter isn't wrong — yet a new problem can appear. What is it, and why?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Both are valid, because the question is really **a product question**: should the log show "who they were then", or "who they are now"?

- Store `actorId`: when showing the log, JOIN to get the **current** name — "Rahim Uddin moved task #42 to Done". Normalised, but history changes.
- Copy `actorName`: the name **at the moment of the event** — "Rahim moved task #42 to Done". This is a snapshot, not an update anomaly — because it is deliberately not supposed to change.

In practice many systems keep both: `actorId` (for relationships and filtering) + an `actorName` snapshot (for audit). In audit/compliance logs a snapshot is usually essential — history shouldn't change later. The key lesson: whether a copy is wrong depends on **whether the fact is supposed to change**.

**Question 2:** The strength: the trigger lives inside the database, so whatever path a task arrives by — app code, bulk import, even someone running an `INSERT` by hand in `psql` — the counter changes. Failures like (c) become nearly impossible. What you lose: the logic can't be seen by reading app code — a new developer won't understand why an `INSERT` is slow or why a row is being locked; testing and debugging are harder; the trigger's code has to be versioned in migrations. And the hot-row problem (question 3) is the same with a trigger. A reconciliation job should still be kept — someone may disable the trigger temporarily for a bulk load, the trigger's own logic may have a bug (say, forgetting the `status`-change case), or data may drift after a restore. The safety net is cheap; its absence is expensive.

**Question 3:** **Hot-row lock contention.** Each atomic increment holds the lock on that project's row until the transaction ends. With 40 people writing at once, they queue for that one row — every task creation now waits for the previous transaction to finish. The counter is correct, but write latency grows, and if transactions are long (say something slow happens inside them) the problem grows too. This is the database version of Lesson 4.6's hot key. Remedies: keep transactions short (increment at the very end), split the counter into several pieces (sum them when reading), or make the counter async (Module 7) — in which case the counter lags a few seconds, usually acceptable for a dashboard.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **Ready to run in the repo:** [`exercises/lesson-5.2-data-modeling/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.2-data-modeling) — `docker compose up -d --wait && npm install`, then `npm run anomalies`, `npm run dashboard`, `npm run counter`. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

This exercise holds the same TaskFlow data in two schemas — the hackathon's "everything in one table" version, and a normalised (3NF) version with the `openTaskCount` counter. Verified by running it in the sandbox: `tsc --noEmit` is clean, the three scripts' output matches the README, and the query plans were checked with `EXPLAIN ANALYZE`. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these four:**

1. Run `npm run dashboard`. What are the three columns on your machine? Is the simple-vs-LATERAL ratio close to the ~22× I got? Then remove the `{ fields: ['projectId', 'status'] }` index from `src/models/good.ts` and run it again — **which column** changed the most, and why?

2. Add a random delay at the start of `naive()` in `src/counter.ts`:

   ```typescript
   await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));
   ```

   Run it a few times — how many are lost now? With a 500 ms delay? Does the number ever reliably reach zero? Write one paragraph on the difference between "loses fewer" and "loses none".

3. Inside `atomic()`, replace `Project.increment` with `naive()`-style `findByPk` → `+1` → `save()`, but keep everything inside the transaction (passing `{ transaction }`). Do you get 200 now? Write down the result — we'll open up why in Lesson 5.5.

4. **Design part (Tier 3 style):** to keep `openTaskCount` correct, at **what other events** in a task's life does it need to change? (Besides creating a task — find at least four.) For each: +1, −1, or two separate changes in two projects?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1
Current: 5.2 — Schema & Data Modeling
TaskFlow state: Nginx + 4 Express instances, CDN, Redis cache, one PostgreSQL primary;
schema normalized (users / projects / tasks / tags + task_tags junction),
projects.openTaskCount denormalized counter (atomic increment + reconciliation job)
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.3 — Storage Engine Internals (B-tree vs LSM-tree, WAL)
=======================
```

---

## 8. Next Lesson

Run the exercise and send me your numbers — especially which column changed after removing the index in #1, and your list for #4. When you are ready, write `next` — Lesson 5.3: **Storage Engine Internals** — how a database actually keeps data on disk, the difference between B-trees and LSM-trees, why the WAL saves data even after a crash, and why Postgres and Cassandra do the same job so differently.
