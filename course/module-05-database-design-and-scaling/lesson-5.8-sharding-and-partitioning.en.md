# Lesson 5.8 — Sharding & Partitioning: Splitting the Data, and the Price of the Split

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 1.3):** 2,000,000 new rows a day, each ~500 bytes — roughly how much storage in a year? Do it in your head, then write down the steps.

**Prerequisite:** Lesson 1.6 (Vertical vs Horizontal), Lesson 5.4 (Indexes), Lesson 5.5 (Transactions), Lesson 5.7 (Replication)

**By the end of this lesson you will be able to:**

1. Tell partitioning and sharding apart, and say when Postgres partitioning really helps (and when it doesn't) — with measured numbers
2. Choose a shard key for a system, and explain how hot partitions arise and how to avoid them
3. Understand what breaks after sharding — cross-shard queries, transactions, unique IDs, resharding — and answer "do we need to shard right now?" with numbers

**Tier:** 1 — Runnable Code (three Postgres instances in Docker)

---

## 0. Where TaskFlow Is Right Now

TaskFlow isn't small anymore. In a year it has reached 2,000,000 daily active users, and several big companies are customers. Lesson 5.7 added a read replica — the read pressure is solved. But Monday morning's metrics bring new worries:

- **Writes:** ~3,000 writes a second on the primary at peak, and growing every quarter. Replicas don't help here — **every write still goes to one primary**.
- **Size:** the biggest table is `activity_log` — tens of millions of events a day. The disk is filling up, and the nightly job that deletes events older than a year now runs for hours and slows the database down.
- **The biggest customer:** one enterprise company alone creates 40% of all TaskFlow tasks.

In Lesson 1.6 you learned: making one machine bigger (vertical scaling) has a limit. Replicas spread reads; to spread writes and storage you have to **split the data itself**. That's today's lesson — and also what you lose by splitting. Because sharding is one of the most expensive decisions in system design, and once it's done it is very hard to go back.

---

## 1. Theory

### 1.1 Two words, one idea — partitioning and sharding

The core idea of both is the same: split a big data set into smaller pieces so each piece can be handled separately.

- **Partitioning** — splitting a big table into several smaller pieces (partitions) by a rule (such as month). The pieces can live **on the same database server**. To the app it is still one table.
- **Sharding** — splitting the data into pieces kept **on separate database servers**. Each server (a shard) holds only its share of the data, and handles the reads and writes for its share.

So sharding is partitioning across machines. One stays within one machine's limits (storage becomes easier to manage, but there's still one CPU and one disk); the other breaks those limits (writes and storage really are split across machines) — but at a huge price.

**Ask first — do we need to shard yet?** Sharding is so complex that these are usually tried before it:

1. **Vertical scaling** — a bigger machine. In today's cloud, one database server can have hundreds of cores and several TB of memory.
2. **Read replicas and caching** (Lesson 5.7, Module 4) — to move read load away
3. **Fixing queries and indexes** (Lessons 5.4, 5.6)
4. **Partitioning** — inside the same database, for big tables (1.2)
5. **Archiving** — moving old data somewhere cheaper (object storage — Lesson 8.1)
6. **Moving one big table to its own database** — e.g. `activity_log` into its own database. This is a kind of split too (functional partitioning), but much simpler than sharding — no single table is being spread across several places.

When, after all that, writes or storage still don't fit on one machine — then shard.

### 1.2 Postgres partitioning — where it helps, and where it doesn't

TaskFlow's `activity_log` is the ideal example for partitioning: data arrives by time, most queries want recent data, and old data has to be deleted regularly. In Postgres (declarative partitioning):

```sql
CREATE TABLE activity (
  id bigserial,
  "projectId" integer NOT NULL,
  action text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  PRIMARY KEY (id, "createdAt")          -- the partition key must be in the primary key
) PARTITION BY RANGE ("createdAt");

CREATE TABLE activity_2026_09 PARTITION OF activity
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
-- one per month
```

To the app it's still a single `activity` table — on `INSERT`, Postgres itself puts the row in the right partition. (Sequelize can't generate this DDL — you write raw SQL in the migration.)

**Partition pruning** — looking at the query's conditions, the planner reads only the partitions it needs and doesn't touch the rest.

The exercise's `npm run partition` — 12 months × 100,000 = 1,200,000 events, the same data in a plain table and in a partitioned table:

```
query                                    plain table     partitioned
project 42, last 7 days                  0.03 ms         0.04 ms — activity_2026_09
project 42, all time (no time condition) 0.22 ms         0.62 ms — 12 partitions
every event of a whole month (August)    22.41 ms        9.14 ms — activity_2026_08
```

Here's an honest point many articles don't make: **partitioning isn't a substitute for an index.** First line — for a query with an index, partitioning gave no benefit. Second line — when the query lacks the partition key (`createdAt`), the partitioned table is **nearly three times slower**, because it has to walk the 12 indexes of 12 partitions. Only in the third line — where one whole partition has to be read — is the gain clear.

The real gain is elsewhere — **deleting old data**:

```
plain table: DELETE (103,334 rows)        99 ms   WAL   11.5 MB   table size 142.2 MB → 142.2 MB
partitioned: DETACH + DROP partition       8 ms   WAL    0.1 MB   (the whole file is gone)
```

`DELETE` marks every row "dead" one by one, writes WAL for each (Lesson 5.3), and — notice — the table **didn't shrink by a single byte**. VACUUM later makes the dead rows' space reusable, but doesn't return the disk space to the operating system. Dropping a partition, on the other hand, means deleting its file outright — almost no WAL, and the disk is freed immediately. That is the answer to TaskFlow's hours-long nightly cleanup job.

**When to partition:** time-series data (logs, events, metrics) that is queried by time and deleted by time. **When not to:** just because "the table is big" — with the right indexes a big table is fast too, and queries without the partition key will get slower.

### 1.3 Sharding — routing

With sharding, each shard is a completely separate database. So before every query the question is: **which shard is this data on?** The value that decides it is the —

**Shard key** — the column (or columns' values) that decides which shard a row lives on. For TaskFlow: `workspaceId`.

```
                        ┌─────────────────────────────┐
  Express app ────────► │  routing: shard = f(key)    │
  (workspaceId = 42)    └──────┬──────────┬───────────┘
                               │          │           │
                        ┌──────▼───┐ ┌────▼─────┐ ┌───▼──────┐
                        │ shard0   │ │ shard1   │ │ shard2   │
                        │ ws 3,8,… │ │ ws 1,42,…│ │ ws 5,9,… │
                        └──────────┘ └──────────┘ └──────────┘
                   each is a full Postgres of its own (with its own replicas)
```

`f(key)` can take three forms:

- **Hash** — `hash(key) % number of shards`. Spreads evenly (if the hash is good), but neighbouring keys scatter — range queries go to every shard.
- **Range** — by key ranges (workspaces 1–1000 → shard0, …). Range queries are easy; but if new keys always go to the last shard, that one gets hot (1.4).
- **Directory (lookup table)** — a separate table recording which key lives on which shard. The most flexible — a specific customer can be moved at will — but that table is itself a dependency, and a lookup before every query (usually cached).

The exercise's routing is the simplest hash:

```typescript
export function hash32(key: string): number {
	return fmix32(fnv1a(key));
}

// the simplest routing: hash % number of shards
export function moduloShard(key: string, shardCount: number): number {
	return hash32(key) % shardCount;
}
```

Two things matter here. First, the hash must be **stable** — the same key always goes to the same shard, on any app instance, on any day. Second — and this was caught while building the exercise — the hash must be **well mixed**. I first used plain FNV-1a; on nearly identical keys it split so unevenly that one shard got 47% of the keys and another 12%. In the end a mixing step (`fmix32`, from MurmurHash3) had to be added. In production, don't build your own hash — use something tested like MurmurHash3 or xxHash.

The exercise's `npm run shard` — 300 workspaces, 300,000 tasks, 3 shards. A query inside a workspace goes only to its shard:

```
"how many open tasks in workspace 42?"  → goes only to shard0: 201, 0.27 ms
```

### 1.4 Choosing the shard key — the most important decision

Changing the shard key later is almost as hard as rebuilding the whole system. A good shard key:

1. **Has many distinct values** — with only 5 values, more than 5 shards will never help
2. **Spreads data and load evenly** — no single value is abnormally big
3. **Makes the most frequent queries finish on one shard** — Lesson 5.1's access patterns again
4. **Keeps together what changes together in a transaction** — because there are no transactions across shards (1.5)

The exercise's `npm run keys` splits the same day's 1,000,000 writes across 4 shards with four different keys (40% of the writes come from one huge workspace):

```
shard key                      share of writes per shard      busiest   shards holding workspace 7's data
hash(workspaceId)               14%  16%  15%  55%                55%        1
hash(taskId)                    25%  25%  25%  25%                25%        4
range(createdAt) — quarterly     0%   0%   0% 100%               100%        1
hash(workspaceId, projectId)    17%  33%  25%  25%                33%        4
```

Each line is a separate lesson:

- **`hash(workspaceId)`** — all of a workspace's queries and transactions on one shard (rules 3 and 4 ✓). But the big customer's shard eats 55% of the writes (rule 2 ✗).
- **`hash(taskId)`** — a perfectly even split. But one workspace's tasks are scattered across all 4 shards — every ordinary query like "all open tasks in this workspace" now goes to every shard (rule 3 ✗).
- **`range(createdAt)`** — the worst: **all** of today's writes land on the last shard; the other three sit idle. The classic trap of a time-based range key — range sharding by an auto-increment id does exactly the same.
- **`hash(workspaceId, projectId)`** — a middle ground: the big workspace spread over 4 shards, and queries inside a project still hit one shard. But notice the split isn't fully even (33%) — the big workspace has only 20 projects, and 20 pieces don't fall evenly into 4 shards. The more values the key has, the smoother the split (rule 1).

**There's no perfect key.** For TaskFlow, `workspaceId` is a good start — nearly all work happens inside a workspace, and with a workspace's data together, JOINs and transactions work as before. In SaaS products this is called **sharding by tenant** — the most common pattern. The only problem is the big customer (next section).

### 1.5 Hot partitions

**Hot partition** — one partition or shard accumulating far more data or traffic than the others, so that it becomes the bottleneck of the whole system.

The exercise's `npm run shard` with `hash(workspaceId)` over 3 shards:

```
shard0:  94 workspaces   175,986 tasks  ███████████████████████  ← workspace 7 (40%) is here
shard1: 106 workspaces    63,812 tasks  █████████
shard2: 100 workspaces    60,200 tasks  ████████
```

The number of workspaces is nearly even (94, 106, 100) — the hash did its job. But the **data** isn't even, because one workspace is almost as big as the other 299 combined. A hash spreads **keys** evenly; it knows nothing of each key's **weight**. Remember Lesson 4.6's hot key? The same problem, in the database.

Remedies:

- **Isolate the big tenant** — with directory routing, put the big customer on its own shard (or a more powerful machine for it), and hash everyone else. The most common in practice.
- **Make the key finer-grained** — `hash(workspaceId, projectId)` (1.4) — the cost: workspace-wide queries now span several shards.
- **Salting** — attaching a small random number to a hot key (`key#0` … `key#9`) so it spreads over 10 places; reads then have to read all 10 and merge. Systems like Twitter use this kind of technique for "celebrity" accounts.

### 1.6 What breaks across shards

This is where sharding's real price lies. In Lesson 5.1 the relational database had two big strengths: any query (including JOINs), and multi-row transactions. **Both stop at the shard boundary.**

**1. Queries without the shard key — scatter-gather.** "Which 10 workspaces have the most open tasks?" — the answer is spread across all three shards.

**Scatter-gather** — sending one query to every shard at once (scatter), and merging and re-sorting the results in the app (gather).

```
→ sent to all 3 shards at once (scatter), merged and sorted in the app (gather): 11.0 ms total
  shard0: 11.0 ms, shard1: 4.8 ms, shard2: 4.6 ms — the total equals the slowest one
```

The total time equals the slowest shard — and the slowest one is the hot shard0. The more shards, the more likely one of them is slow (remember tail latency from Lesson 1.5). And every such query makes every shard work — 10 shards means 10× the database work. That's why "across all workspaces" reports usually aren't run on the sharded database — the data is shipped to a separate analytics store (Lesson 7.6's OLAP).

**2. JOINs across shards** — the database can't do them; the app has to fetch from each shard and join them itself (Lesson 5.6's batching, now across several databases).

**3. Transactions across shards.** Moving a project from one workspace to another, when the two are on different shards. Step 4 of the exercise:

```
project 8: workspace 8 (shard0) → workspace 5 (shard2)
step 1: project written to shard2 — COMMIT ✓
step 2: the app crashed before deleting it from shard0 ✗
→ project 8 is now on shard0 (1) and on shard2 (1) — in both places! No single transaction could prevent it
```

Two separate databases, two separate COMMITs — Lesson 5.5's atomicity doesn't exist here. The fixes (the Saga pattern, two-phase commit) are the whole subject of Lesson 9.3. For now the rule: **choose the shard key so that such operations are rare.**

**4. Unique IDs.** If every shard has its own `serial`/auto-increment, two shards will generate the same id — "task 1001" is two different tasks. So in sharded systems ids are usually generated outside the database — UUIDs, or ids built from time + machine + sequence (Twitter's Snowflake is the famous example of this idea), unique across shards and roughly sorted by time.

**5. Unique constraints** — "each email only once" — if email isn't the shard key, one shard doesn't know whether another shard has the same email. You need a separate lookup table sharded by email.

**6. Operations** — 10 shards means migrations on 10 databases, 10 backups, 10 sets of monitoring, and each with its own replicas (Lesson 5.7).

### 1.7 Resharding — adding shards

TaskFlow started with 3 shards; a year later it needs 4. What happens when N changes in `hash % N`? The exercise's `npm run keys`:

```
Going from 3 to 4 shards — how many of 100,000 workspaces must move to another shard?
hash % N               74.9%   (74,874)
consistent hashing     26.3%   (26,274)
ideal (only the new shard's share = 1/4)    25.0%
```

**Resharding** — changing the number of shards or how data is divided among them, and moving data from one shard to another accordingly.

With `hash % N`, adding one shard makes nearly **three-quarters** of the data move — because almost every key's remainder changes. Ideally only the new shard's share (25%) should move. **Consistent hashing** does exactly that — placing both keys and shards on a circle so a new shard takes only the section next to it. How it works and why virtual nodes are needed is Lesson 10.1's full deep dive; for today, just remember the number: 75% vs ~25%.

Another option that's very common in practice: **many more logical shards from the start** (say 1,024), kept on a few physical servers. When you add a machine, some logical shards move to it wholesale — no key ever changes its shard.

Moving the data is itself hard — on a live system, with no downtime: copying to the new place, writing to both places during the move, verifying, then moving the reads. That's why many teams don't build sharding themselves — tools like Citus for Postgres or Vitess for MySQL, or a distributed database from the start (Lesson 5.1's CockroachDB, YugabyteDB, DynamoDB), which handle the splitting and moving themselves. Choosing the shard key is still your job, though.

> **Trade-off Table — kinds of routing**

| Kind               | How it splits                    | Range queries       | Adding a shard                   | Special trap                                           |
| ------------------ | -------------------------------- | ------------------- | -------------------------------- | ------------------------------------------------------ |
| Hash % N           | Even (with a good hash)          | Every shard         | ~(N−1)/N of the data moves       | Knows nothing of a key's weight — big tenants get hot  |
| Consistent hashing | Even (with virtual nodes)        | Every shard         | Only the new shard's share moves | Complex to understand and build correctly (10.1)       |
| Range              | Depends on the shape of the data | One or a few shards | Split a range                    | New data on the last shard — hot                       |
| Directory          | However you decide               | Depends             | Change the lookup, move data     | The lookup table is itself a dependency and bottleneck |

---

## 2. Interview Angle

**"How would you scale this system?"** — sharding comes up often, but the weak answer is an immediate "I'll shard the database". A good answer gives numbers first (Lesson 1.3): "how many writes/s at peak, how many TB of data — does it fit on one machine?" Often the answer is "yes, for a long time", and being able to say that is a senior signal.

**If you do have to shard, the interviewer's follow-ups are nearly certain:**

- _"What's the shard key, and why?"_ — argue from the access patterns: "in a chat app, `conversationId`, because every message read and write happens inside a conversation"
- _"What about a celebrity / a big customer?"_ — hot partitions, and the remedies (a dedicated shard, salting)
- _"What if you need more shards?"_ — the problem with `hash % N`, consistent hashing or many logical shards
- _"We need a report across all users?"_ — the cost of scatter-gather, and a separate store for analytics
- _"A transaction across two shards?"_ — avoid it (via the key); if you can't, a Saga (Lesson 9.3)
- _"How will you generate IDs?"_ — UUIDs or Snowflake-style ids; not auto-increment

**In real production:** in big companies' engineering blogs, sharding migrations are often described as months-long projects — expensive and risky work. So the decision is made as late as possible, and when it is made, the most time goes into the shard key.

---

## 3. Key Takeaway

- **Partitioning** = splitting a table into pieces (can be on the same server); **sharding** = the pieces on separate servers — writes and storage really are split
- Before sharding: a bigger machine, replicas, caching, queries/indexes, partitioning, archiving, moving a big table to its own database
- Postgres partitioning **isn't a substitute for an index** — queries without the partition key get slower (0.22 → 0.62 ms); the real gain is deleting old time-series data (DELETE: 99 ms, 11.5 MB WAL, size unchanged; DROP: 8 ms)
- **Shard key**: many distinct values, an even split, frequent queries on one shard, data that changes together kept together; a time/auto-increment range key → the last shard 100% hot
- **Hot partitions** — a hash spreads keys evenly, not their weight; isolate the big tenant or make the key finer-grained
- Lost across shards: queries without the shard key (**scatter-gather**, as slow as the slowest shard), JOINs, **transactions**, auto-increment ids, unique constraints
- **Resharding**: going from 3→4 with `hash % N` moves ~75% of the data, consistent hashing ~25%; and the hash function itself must mix well

---

## 4. New Terms (Glossary)

| Term                  | Meaning                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Partitioning**      | Splitting a big table into smaller pieces by a rule (such as month) — they can live on the same server        |
| **Sharding**          | Splitting data into pieces kept on separate database servers — each server handles reads/writes for its share |
| **Shard Key**         | The column whose value decides which shard a row lives on                                                     |
| **Partition Pruning** | Looking at the query's conditions, the planner reads only the partitions it needs and skips the rest          |
| **Hot Partition**     | A partition or shard with far more data or traffic than the others — the bottleneck of the whole system       |
| **Scatter-Gather**    | Sending one query to every shard at once (scatter) and merging the results in the app (gather)                |
| **Resharding**        | Changing the number of shards or how data is divided, and moving data between shards accordingly              |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. A chat app's (WhatsApp-like) message table needs sharding. Two proposals: `userId` (the sender) or `conversationId`. How would the query "show a conversation's latest 50 messages" run under each? Which would you choose, and what happens with a group of a million members?
2. TaskFlow runs on 4 shards, each with its own Postgres `serial` ids. A developer says, "to avoid id collisions, let shard0 use odd ids and shard1 even ids — simple." What's wrong with that? What would you propose?
3. TaskFlow's CTO says: "we're at 300 writes/s and a 200 GB database. To be ready for scale, let's split into 16 shards right now." What would you say? Argue with numbers, and say under what conditions you'd start planning for sharding.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** With `userId`: a conversation's messages come from different senders — who live on different shards. "The latest 50" becomes scatter-gather, merged by time — the most frequent query becomes the most expensive. With `conversationId`: all of a conversation's messages on one shard, sorted — one shard, one index scan. So `conversationId` — rule 3 (frequent queries on one shard). (Extra: an index or partitioning on `(conversationId, createdAt)` within messages — Lesson 5.4, and this is exactly the access pattern Discord chose a wide-column database for, Lesson 5.1.) The huge group: if one conversation gets abnormally many messages, its shard gets hot — a hot partition. The remedy: split that conversation's messages further into time buckets — the key becomes `(conversationId, week)` — so a conversation's messages from different times go to different places, while "the latest 50" still usually sits in one bucket.

**Question 2:** Odd/even only works for 2 shards. With 4? An offset via `id % 4` — possible, but when the number of shards changes (1.7) the whole scheme breaks, and old ids change meaning. And even if you can tell the shard from the id, the id has no relationship to the shard key (the workspace) — confusing. The better fix: generate ids outside the database — UUIDs (simple, no coordination; the cost: they're big, and random UUIDs land in random places in a B-tree index — Lesson 5.3 — so time-ordered UUIDv7 is better), or Snowflake-style 64-bit ids (time + machine id + sequence — small, roughly time-ordered).

**Question 3:** The numbers: 300 writes/s and 200 GB — a comfortable zone for an ordinary Postgres server (as in Lesson 5.1's estimation). 16 shards now means: thinking about the shard key in every feature, scatter-gather for any cross-workspace report, no cross-shard transactions, migrations, backups and monitoring for 16 databases — and above all, a shard key chosen on today's guesses may not match the access patterns two years from now, when changing it will be even harder. What to say: keep it simple now, but **be ready** — keep `workspaceId` on every table, avoid JOINs and transactions across workspaces, generate ids outside the database (so sharding later is easier). Signals to start planning: the write rate reaching a large fraction of a big machine's measured limit (say 50–60%, and computing from the growth rate when it will hit the limit), storage growth heading past one machine's disk, or one particular table (the activity log) growing much faster than everything else — in which case, split that one off first.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (three Postgres instances in Docker)

> **Ready to run in the repo:** [`exercises/lesson-5.8-sharding/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.8-sharding) — `docker compose up -d --wait && npm install`, then `npm run partition`, `npm run shard`, `npm run keys`. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

Three separate Postgres instances, each a shard. `partition` measures monthly partitioning inside one database; `shard` shows real routing by `workspaceId`, scatter-gather and cross-shard operations; `keys` computes shard keys and resharding without a database (deterministic). Verified by running it in the sandbox: `tsc --noEmit` is clean; `partition` twice, `shard` and `keys` three times — the shard split and `keys`'s numbers identical every time. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run the three scripts. In `partition`, which query was **slower** on the partitioned table on your machine, and why? Write in one line when you'd use partitioning.

2. **Isolate the big customer** (README experiment 2): workspace 7 on shard0, everyone else on shard1 and shard2. How did the tasks split? What new responsibilities come with maintaining this routing?

3. **The subtlety of composite keys** (experiment 3): change the project count from 20 to 200. What happened to the "busiest" column? Explain it with the shard-key rule "many distinct values".

4. **Fewer virtual nodes** (experiment 4): from 200 to 1. What % moved, and how is each shard's share? Write down one question you want answered in Lesson 10.1.

5. **Design part:** TaskFlow's three big tables — `tasks`, `activity_log`, `notifications` (per user, kept for 30 days). For each, say: partition, shard, both, or neither — and the partition or shard key, with reasons. Which cross-workspace features does your decision make hard, and how will you handle them?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
Current: 5.8 — Sharding & Partitioning
TaskFlow state: Nginx + Express instances, CDN, Redis cache; PostgreSQL primary + read
replica; activity_log partitioned by month (old months DROPped); preparing for sharding —
shard key workspaceId, a plan to isolate the big enterprise customer, ids generated outside the database
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion, Leader-Follower Replication,
Replication Lag, Read-Your-Writes Consistency, Synchronous Replication,
Failover, RPO/RTO, Multi-Leader Replication, Partitioning, Sharding,
Shard Key, Partition Pruning, Hot Partition, Scatter-Gather, Resharding
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.9 — CAP Theorem, ACID vs BASE, Quorum (R+W>N)
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your decisions for the three tables in #5. When you are ready, write `next` — Lesson 5.9, the last lesson of Module 5: **CAP Theorem, ACID vs BASE, and Quorums** — with replicas and shards, TaskFlow's data now lives on several machines. When the network breaks (and it will), the system has to choose: give everyone the correct answer, or give everyone an answer? What CAP really says (and what it doesn't — there are many misconceptions), how `R + W > N` brings consistency to leaderless databases, and which parts of TaskFlow go which way.
