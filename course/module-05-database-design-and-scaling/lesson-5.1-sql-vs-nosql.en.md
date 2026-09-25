# Lesson 5.1 — SQL vs NoSQL: The Real Trade-off

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 2.3):** Which is "the best" of REST, GraphQL and gRPC — what was the right answer to that question, and what kind of questions did we use to decide?

**Prerequisite:** Lesson 1.2 (Design Framework), Lesson 1.3 (Estimation), Lesson 1.6 (Horizontal Scaling), Lesson 4.4 (Redis Hands-on)

**By the end of this lesson you will be able to:**

1. Name the real differences hiding behind the label "SQL vs NoSQL" — the data model, where the schema is enforced, how flexible queries are, and what guarantees you get
2. Recognise the four NoSQL families (key-value, document, wide-column, graph) — what problem each was built for, and where each is weak
3. Catch myths like "NoSQL because it scales" when choosing a database for a new feature, and justify the decision with numbers and access patterns

**Tier:** 3 — Design Exercise (hands-on Sequelize modelling comes in Lesson 5.2)

---

## 0. Where TaskFlow Is Right Now

By the end of Module 4, TaskFlow is quite sturdy — four Express instances behind Nginx, a CDN in front, a Redis cache on the side (Cache-Aside + single-flight, with measured gains). But underneath everything there is still **a single PostgreSQL**. All through Module 4 we tried to **protect** this DB — now it is time to go **inside** it.

Today's problem comes from the product team. Two new feature requests:

1. **Custom fields:** every team wants its own fields. The marketing team wants `campaign` and `budget`, the engineering team wants `storyPoints` and `sprint`, an agency wants `clientName`. Different fields per project, and users must be able to filter by them.
2. **Activity log:** "Rahim moved task #42 to Done" — a record for every event; the project page shows the latest 50; keep them for a year.

A new engineer on the team said in the meeting:

> "Postgres's schema is too rigid — every new field needs a migration. Let's move to MongoDB, it's schemaless. And the activity log will be a lot of data — NoSQL scales well, SQL doesn't."

Sounds reasonable, doesn't it? That one sentence actually contains **three separate claims** — "schemaless", "no migrations needed", and "SQL doesn't scale". By the end of today's lesson you will be able to check each claim on its own — which is true, which is half-true, and which is wrong.

---

## 1. Theory

### 1.1 The name itself is misleading

"SQL vs NoSQL" makes it sound as if the difference is the **query language** — in one you write SQL, in the other you don't. It isn't:

- Cassandra's query language is called **CQL** — it looks almost like SQL (`SELECT ... FROM ... WHERE ...`), yet Cassandra is a NoSQL database
- In a PostgreSQL `JSONB` column you can store whole JSON documents, index them, and query by fields inside them — Postgres itself does much of a document store's job
- The word "NoSQL" became popular around 2009 as a hashtag for a meetup; later many people read it as "Not only SQL"

So where is the real difference? Along four axes:

```
                    Relational (SQL)              NoSQL (generally)
                    ─────────────────             ──────────────────
Data model      →   table, row, relation          key-value / document /
                                                  wide-column / graph
Where's schema  →   the database enforces it      the application code enforces it
Query           →   data first, any question      questions first, shape data
                    later                         to match
Guarantee       →   multi-row ACID transaction    usually strong within one
                    (default)                     record/partition, limited beyond
```

Let's take each axis on its own. We will get to the question of scale at the end, because that is where most of the misconceptions live.

### 1.2 The Relational Model — what you already know

**Relational model** — storing data in tables (rows and columns), and expressing the relationships between tables with foreign keys. You do this every day in Sequelize:

```
┌──────────────┐       ┌──────────────────┐       ┌───────────────────────┐
│    users     │       │     projects     │       │         tasks         │
├──────────────┤       ├──────────────────┤       ├───────────────────────┤
│ id        PK │◄──┐   │ id            PK │◄──┐   │ id                 PK │
│ name         │   └───│ ownerId       FK │   └───│ projectId          FK │
│ email        │       │ name             │   ┌───│ assigneeId         FK │
└──────────────┘       └──────────────────┘   │   │ title                 │
       ▲                                      │   │ status                │
       └──────────────────────────────────────┘   └───────────────────────┘
```

When you write `Task.belongsTo(User, { as: 'assignee' })` you are declaring exactly this foreign key, and when you pass `include: [{ model: User, as: 'assignee' }]`, Sequelize builds a `JOIN` behind the scenes.

The relational model's biggest strength is often overlooked: **you don't need to know tomorrow's questions today.** If you keep the data normalised, and six months later the product manager asks "which team had the most overdue tasks last month?" — you write a new `JOIN` + `GROUP BY` and you have the answer. The shape of the data doesn't change. (Normalisation, and when to deliberately break it, is Lesson 5.2.)

The second strength — **transactions across multiple rows or tables.** "Mark the task Done **and** increment the project's `completedCount`" — either both happen or neither does. That's what you do with `sequelize.transaction(async (t) => { ... })` in Sequelize. How it works and what it costs is Lesson 5.5.

### 1.3 The first real axis — where does the schema live?

The new engineer's first claim was "MongoDB is schemaless". This is where the biggest misunderstanding lies. **There is no such thing as data without a schema** — because your code always reads data assuming some shape. When you write `task.title.toUpperCase()`, you are assuming `title` exists and is a string. The only question is — **who enforces the schema, and when?**

- **Schema-on-write** — the database checks at write time. With `title TEXT NOT NULL` in Postgres, a row without a title simply won't get in. Bad data is **stopped at the door**.
- **Schema-on-read** — the database stores whatever it is given; the application decides the data's shape when it reads it. Bad data **gets inside**, and is caught at read time — or never caught.

You have already seen both, perhaps without noticing. Remember what we did after reading data from Redis in the Lesson 4.4 exercise?

```typescript
const parsed: unknown = JSON.parse(raw);
const result = taskListSchema.safeParse(parsed);
if (!result.success) {
	// garbage in the cache — treat it as a miss; the DB is the source of truth
	return { status: 'miss' };
}
```

That is **schema-on-read**. Redis checks no shape — it stores any string. So we had to validate it ourselves with Zod when reading. In a document database you have to do exactly this **on every read path**.

Now look at the claim "no migrations needed". Say TaskFlow is on MongoDB, and you change `assignee: "rahim@x.com"` (a string) to `assignee: { id: 7, email: "..." }` (an object). You didn't have to run a migration on the database — true. But now the database holds **two kinds of documents**, old and new. Your code has to handle both — forever, or until you convert the old ones with a background script (which is really a migration by another name).

**So the accurate statement is:** in a document database, migrations **don't disappear, they move** — from the database into the application code. Sometimes that is a real advantage (where records naturally have different shapes); sometimes it is hidden debt.

### 1.4 The second real axis — data first, or questions first?

**Access pattern** — exactly the ways in which the application reads and writes data ("the latest 50 activities of project X", "all tasks of user Y").

The design process in the two worlds runs in opposite directions:

```
Relational:     identify the entities ──> normalise ──> write any query
                (the data's natural shape)              (whatever you need later)

Access-pattern  write every query down first ──> shape the data for each query
first (NoSQL):  ("what will we ask?")            (the same data in several places
                                                  if needed)
```

You have seen this too. In Lesson 4.4 our Redis keys were `tasks:user:{id}` and `tasks:user:{id}:completed` — **two separate keys, because they answer two separate questions.** You can't ask Redis "give me every task whose title contains 'bug'" — the keys weren't built for that question. A new question means a new key, a new data layout.

In databases like Cassandra or DynamoDB this principle is the foundation of the whole design. A good design there means: **every important query is answered from one partition in a single sip**, with no joins. The price — a query you didn't plan for is either very slow or outright impossible until you reshape the data.

> **In one line:** a relational database gives you **flexibility** ("ask whatever you like later"); an access-pattern-first database gives you **predictability** ("what you said you'd ask is fast at any scale"). Getting both fully at once is hard.

### 1.5 The four NoSQL families

"NoSQL" isn't one database — it is four separate families, each built for a different problem:

```
KEY-VALUE                        DOCUMENT
─────────                        ────────
"session:abc" → "{...}"          { _id: 42, title: "Fix login",
"tasks:user:7" → "[...]"           assignee: { id: 7, name: "Rahim" },
                                   tags: ["bug", "urgent"],
give a key, get a value.           comments: [ {...}, {...} ] }
the DB doesn't know what's
inside.                          the whole object in one place — nested,
                                 queryable by inner fields.

WIDE-COLUMN                      GRAPH
───────────                      ─────
partition: project_42            (Rahim)──COLLABORATES──>(Karim)
  ├─ 2026-09-25T10:01 | moved…      │                      │
  ├─ 2026-09-25T10:03 | assigned…   MEMBER_OF          MEMBER_OF
  └─ 2026-09-25T10:07 | commented…  ▼                      ▼
                                 (Team A)             (Team B)
sorted rows under one
partition key — built for        nodes and edges — built for finding
huge write volumes.              "friend of a friend" relationships.
```

| Family          | Examples                      | Best fit                                                              | Weakness                                                           |
| --------------- | ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Key-value**   | Redis, Memcached, DynamoDB\*  | Cache, session, rate-limit counter — one lookup when you know the key | Querying inside the value is nearly impossible                     |
| **Document**    | MongoDB, Couchbase, Firestore | Shapes vary per record; nested data read together (product catalog)   | Joins across documents are weak; duplicated data is hard to update |
| **Wide-column** | Cassandra, ScyllaDB, HBase    | Huge write volume, time-ordered data (messages, events, sensors)      | Almost no ad-hoc queries; access patterns must be known up front   |
| **Graph**       | Neo4j, Amazon Neptune         | Deep relationships — recommendations, fraud rings, "who knows whom"   | Little advantage over relational for plain CRUD and aggregates     |

\* **An honest caveat:** the boundaries between these categories are blurry. DynamoDB describes itself as both key-value **and** document. Redis has lists, sorted sets and streams — not just "key → string". So in an interview, talking in terms of **data model and access pattern** is far more useful than reciting categories.

**A real example (Discord):** Discord wrote on their engineering blog that in 2017 they moved message storage from MongoDB to Cassandra, and in 2023 from Cassandra to ScyllaDB (Cassandra-compatible). Notice the reason — their core access pattern is essentially one: **"the latest N messages of channel X"**. Huge write volume, time-ordered, no joins needed. That is exactly the problem wide-column was built for. They didn't move because "NoSQL is better" — they moved because of **a specific access pattern and a measured scale problem**.

### 1.6 The biggest myth — "SQL doesn't scale"

Now the new engineer's third claim. There is a truth behind it, but not the way it is usually told.

**What's true:** many NoSQL systems like Cassandra and DynamoDB were designed **from day one** to spread data across many machines. Add a node, and data spreads itself out. (That "spreading" is sharding — Lesson 5.8; how it is divided is consistent hashing — Lesson 10.1.)

**What stays hidden:** the **price** of that easy horizontal scaling — no cross-partition joins, and transactions across partitions are either missing or limited and expensive. In other words, they bought scale by **giving up** the two strengths from 1.2 — flexible queries and multi-row transactions. It isn't a free lunch; it is a trade-off.

**What's wrong:** "SQL doesn't scale." In reality:

- A single PostgreSQL instance on good hardware can handle very large workloads — exactly how large varies enormously with queries, indexes and hardware, so don't trust any single number; **measure on your own workload**
- Reads grow → read replicas (Lesson 5.7)
- Writes grow → partitioning and sharding (Lesson 5.8), tools like Citus or Vitess
- Want distributed SQL from the start → CockroachDB, YugabyteDB, Google Spanner (often called "NewSQL")

And the line is blurring from the other side too — in 2018 (version 4.0) MongoDB added multi-document ACID transactions. So today the neat split "SQL = transactions, NoSQL = scale" is no longer true.

**Let's check with TaskFlow's numbers (as in Lesson 1.3):** say TaskFlow now has 100,000 DAU, each doing on average 20 writes a day (creating tasks, changing status, commenting).

```
100,000 × 20 = 2,000,000 writes/day
2,000,000 ÷ 86,400 seconds ≈ 23 writes/second (average)
Peak (assume ~5× the average)  ≈ 120 writes/second
```

120 writes a second — for an ordinary Postgres instance that is a very comfortable zone. So **there is no "scale" reason for TaskFlow to switch databases right now.** This is the most important lesson: always check claims about scale **with numbers**, not with feelings.

### 1.7 A decision framework — and TaskFlow's answer

Five questions before choosing a new database:

```
1. What shape is the data?           ── lots of relations and joins? or self-contained records?
2. Are the access patterns known?    ── stable questions? or new reports all the time?
3. How much consistency is needed?   ── several records changed together? money?
4. What are the scale numbers?       ── estimate (like 1.6), don't guess
5. Team and operations?              ── who runs it, how is it backed up, who's on call?
```

Don't take the last question lightly. Every new database means a new backup strategy, new monitoring, new failure modes, and someone who can debug it at 3 a.m.

**Polyglot persistence** — several kinds of databases in one system, each for its own job. The funny thing is, TaskFlow is **already** polyglot: Postgres (the source of truth) + Redis (cache). More will come — object storage for files (Lesson 8.1), a search engine for full-text search (Lesson 8.3). So the question is never "SQL **or** NoSQL" — it is "which one for **this particular data and access pattern**?"

Now TaskFlow's first feature — custom fields. Does the whole app need to move to MongoDB for this? No. Postgres's `JSONB` column is made for exactly this — **a structured core + a flexible edge**:

```typescript
import {
	DataTypes,
	Model,
	Op,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';

type CustomFieldValue = string | number | boolean;

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare projectId: number;
	declare title: string; // core field — enforced by the DB (schema-on-write)
	declare customFields: CreationOptional<Record<string, CustomFieldValue>>; // the flexible edge
}

Task.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		projectId: { type: DataTypes.INTEGER, allowNull: false },
		title: { type: DataTypes.STRING, allowNull: false },
		customFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
	},
	{ sequelize, tableName: 'tasks', indexes: [{ fields: ['customFields'], using: 'gin' }] }
);

// "the tasks in this project where sprint = N" — a JSONB containment (@>) query
export async function tasksInSprint(projectId: number, sprint: number): Promise<Task[]> {
	return Task.findAll({
		where: {
			[Op.and]: [
				{ projectId },
				Sequelize.where(
					Sequelize.col('customFields'),
					Op.contains,
					Sequelize.cast(JSON.stringify({ sprint }), 'jsonb')
				)
			]
		}
	});
}
// Generated SQL: ... WHERE ("Task"."projectId" = 42
//                      AND "customFields" @> CAST('{"sprint":14}' AS JSONB))
```

There are two non-obvious decisions here, both verified:

- **Why `@>` (containment)?** The GIN index can use this operator. With Sequelize's simple nested syntax (`customFields: { sprint: 14 }`) the SQL becomes `CAST(("customFields"#>>'{sprint}') AS DOUBLE PRECISION) = 14` — which that index can't serve. Running `EXPLAIN` on a 300,000-row Postgres 17 table showed: the `@>` query gets a **Bitmap Index Scan**, the nested query a **Seq Scan of the whole table**. Why that happens becomes clear in Lesson 5.4 (Indexing).
- **Why `Sequelize.where(...)` rather than `customFields: { [Op.contains]: {...} }` directly?** At runtime both produce the same `@>`. But Sequelize v6's type definitions only type `Op.contains` for arrays and ranges — pass a JSONB object and `tsc` errors. Instead of hiding that with `as` or `any` (main.md §6), we used `Sequelize.where`, which is type-correct and produces the same SQL. A library's types and its runtime don't always agree — knowing that honestly and handling it is part of the learning.

And remember — `customFields` is now **schema-on-read** territory. The DB only guarantees it is valid JSON; whether `sprint` inside is a number or a string must be validated with Zod in the API layer. We took the best of both worlds, but also the responsibilities of both.

The second feature — the activity log — is that a job for a wide-column database? That is part of today's exercise. 😉

---

## 2. Interview Angle

**The most common trap:** when asked "which database would you use?", immediately saying "MongoDB, because it scales" or "Postgres, because it's reliable". Both answers are weak — because neither is **tied to the requirements.**

**The structure of a good answer** (match it with the Lesson 1.2 framework):

1. **State the access patterns:** "the main read in this system is X, the main write is Y"
2. **State the consistency need:** "there are payments, so we need multi-row transactions" or "a like count can lag a few seconds"
3. **State the numbers:** "by estimation, ~N writes/s at peak" — then decide
4. **Acknowledge the trade-off:** "with Cassandra we gain write scale but lose ad-hoc analytics queries — so we'd ship the data to a separate analytics store"

**Common follow-ups:**

- _"What if later you need to query by a new field?"_ — in relational, add an index; in an access-pattern-first design, perhaps a new table or secondary index, duplicating data if necessary
- _"How do you update two documents atomically in a document database?"_ — multi-document transactions (if the DB supports them, and you know the cost), or model the data so the atomic update stays inside a single document
- _"Does SQL scale horizontally?"_ — the answer from 1.6: yes, with read replicas and sharding, or with distributed SQL — though the work is more manual and joins/transactions get more expensive

**In real production:** at most product companies, core business data (users, orders, payments) lives in a relational database, with specialised stores alongside for specific jobs — Redis for caching, Elasticsearch/OpenSearch for search, Kafka for events. "We're all-NoSQL" is the exception, not the rule.

---

## 3. Key Takeaway

- The real difference in "SQL vs NoSQL" isn't the query language — it is **the data model, where the schema is enforced, query flexibility, and guarantees**
- There's no such thing as "schemaless" — the schema lives either **in the DB (schema-on-write)** or **in your code (schema-on-read)**; migrations don't disappear, they move
- Relational: data first, any question later. Access-pattern-first: questions first, data shaped to match — **flexibility vs predictability**
- Four NoSQL families — key-value, document, wide-column, graph — each for a different problem; the boundaries are blurry
- NoSQL's easy horizontal scale is paid for by giving up joins and cross-partition transactions; and SQL **does scale** — with replicas, sharding, distributed SQL
- Always check scale claims **with estimation numbers**
- The question isn't "SQL or NoSQL" — it is "which one for this data and this access pattern" (**polyglot persistence**); a good default: start with Postgres, switch when you have a measured reason

---

## 4. New Terms (Glossary)

| Term                     | Meaning                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **Relational Model**     | Storing data in tables/rows, and expressing the relationships between tables with foreign keys     |
| **Schema-on-write**      | The database checks the data's shape at write time — bad data can't get in                         |
| **Schema-on-read**       | The database doesn't check; the application decides and validates the data's shape when reading it |
| **Access Pattern**       | Exactly the ways the application reads and writes data — the starting point of NoSQL design        |
| **Document Store**       | A database for nested, self-contained records (usually JSON-like) — e.g. MongoDB                   |
| **Wide-column Store**    | Keeps sorted rows under a partition key; built for huge write volumes — e.g. Cassandra             |
| **Polyglot Persistence** | Several kinds of databases in one system, each used for the job it suits best                      |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. The new engineer said "on MongoDB we'll never have to write a migration again." Six months later, when the shape of the `assignee` field has to change, what exactly will the problems be? And what are two ways to handle them?
2. In the Discord message storage example — which exact characteristics made a wide-column database the right fit? If Discord suddenly had to find "the 10 users who used the most emoji last month", what problem would that design have?
3. TaskFlow wants a report: "who completed the most tasks in each team over the last 30 days." How hard is that in Postgres? And if TaskFlow lived entirely in an access-pattern-first database where this report had not been planned for — what then?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The database will then hold **documents of two shapes** — `assignee` a string in the old ones, an object in the new ones. Every read path has to handle both; forget it in one place and you get errors like `Cannot read properties of undefined` in production — and only on **old** data, which makes it hard to catch in tests. Two ways to handle it:

- **Lazy migration** — when you read an old shape, convert it to the new shape and write it back; it is good to keep a version field in the code (`schemaVersion: 2`) and parse both versions with something like Zod
- **Backfill** — convert all old documents at once with a background script — which is really a migration

In other words the migration didn't disappear; it just moved from the database into the code.

**Question 2:** The characteristics: (a) essentially one access pattern, and a stable one — "the latest N messages of channel X"; (b) the data is time-ordered, so keeping it sorted within a partition lets you read it in one sip; (c) huge write volume, and messages are almost never updated; (d) no joins needed. "The 10 biggest emoji users" is an **ad-hoc aggregate across all partitions** — exactly the query the design was not built for. It would mean scanning all the data: impossibly slow and a heavy load on the cluster. The practical solution: ship the data to a separate analytics system for this kind of question (Lesson 7.6's OLTP vs OLAP), or keep a dedicated counter up front.

**Question 3:** In Postgres it is one query — join `tasks` with `users` and `team`, filter on `completedAt`, `GROUP BY` and `ORDER BY` — perhaps fifteen minutes of work (with a lot of data you might need an index). In an access-pattern-first database where data is organised as "a user's tasks" or "a project's tasks", there is no partition built for "a 30-day aggregate across a team". The alternatives: a full scan (slow and expensive), a new table/counter updated **from now on** (but old data needs a backfill), or exporting the data to an analytics store. That is what 1.4's "flexibility vs predictability" trade-off looks like in real life — and for a product like TaskFlow, where new reports are requested all the time, flexibility is worth a lot.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

I'm not giving a model answer yet — I'll critique yours after you try.

> Four new features are coming to TaskFlow. For each, decide where the data lives — **in the existing Postgres** (with `JSONB` or a new table if needed), **in Redis**, or in **a new database** you add (which family).
>
> 1. **Custom fields** — up to 20 custom fields per project, filterable (you saw one answer in today's lesson — now check it yourself: what is its weakness?)
> 2. **Activity log** — a record of every event ("Rahim moved task #42 to Done"); the project page shows the latest 50; kept for 1 year. Assume 100,000 DAU, each generating 50 events a day on average, each record ~200 bytes.
> 3. **"People you could work with"** — suggestions of a user's collaborators' collaborators who aren't yet in any project with them
> 4. **Online presence** — who is online in the project right now (the green dot)
>
> For each, write:
>
> - **(a)** the shape of the data and the main access pattern
> - **(b)** how much consistency is needed — is lagging a few seconds acceptable?
> - **(c)** your choice, and **what you are giving up** (the trade-off)
>
> For feature 2, **estimate** first (Lesson 1.3): how many writes a day, how many per second on average and at peak, and how much storage in a year — then decide. The number should be the basis of your reasoning, not a feeling.

**Hint (only read it if you get stuck):** it is natural for the four answers not to be the same. And remember — the cost of adding a new database (question 5 in 1.7) has to be part of the calculation too.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete)
Current: 5.1 — SQL vs NoSQL: The Real Trade-off
TaskFlow state: Nginx reverse proxy + LB, 4 Express instances, CDN,
Redis caching layer (Cache-Aside + single-flight), one PostgreSQL primary;
new feature requests: custom fields (JSONB proposed) and an activity log
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.2 — Schema & Data Modeling (normalization, denormalization, with Sequelize models)
=======================
```

---

## 8. Next Lesson

Send the exercise over — especially the activity-log estimation, because that number will show whether the decision stands on reasoning. When you are ready, write `next` — Lesson 5.2: **Schema & Data Modeling** — what normalisation is and why, when to denormalise on purpose (and what it costs), all with TaskFlow's Sequelize models, hands-on.
