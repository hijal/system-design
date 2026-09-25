# Lesson 5.3 — Storage Engine Internals: B-tree vs LSM-tree, and the WAL

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 1.5):** What is the difference between availability and reliability? Give an example of a system that is **available** but not **reliable**.

**Prerequisite:** Lesson 1.3 (Latency numbers), Lesson 4.1 (Buffer Pool), Lesson 5.1 (SQL vs NoSQL), Lesson 5.2 (Schema)

**By the end of this lesson you will be able to:**

1. Explain how a database keeps data on disk (pages), and why a B-tree finds one row among 400,000 by reading only a handful of pages
2. Explain in your own words how the WAL keeps committed data safe even after a crash
3. State the trade-offs between B-trees and LSM-trees (write, read, space), and argue which kind of storage engine suits a given workload

**Tier:** 3 — Design Exercise (plus an optional "see it for yourself" section you can run in Docker)

---

## 0. Where TaskFlow Is Right Now

Last week at 2 a.m. the cloud provider suddenly restarted TaskFlow's database VM — no notice, as if someone had pulled the plug. The on-call engineer woke up to this in the Postgres log:

```
LOG:  database system was not properly shut down; automatic recovery in progress
LOG:  redo starts at 0/14F4028
LOG:  redo done at 0/1BE6E78
LOG:  database system is ready to accept connections
```

A few seconds later everything was running. And the most surprising part — of the tasks created and shown as "saved" in the moments right before the crash, **not a single one was lost**.

How? The database keeps data in memory (the buffer pool, Lesson 4.1) — and memory is wiped when the power goes. So what is this "redo", and where did it bring the data back from?

The same week, another discussion: in Lesson 5.1 we thought about the activity log. Someone said, "Cassandra is built for write-heavy work, because it uses an LSM-tree." What is an LSM-tree? And is Postgres's B-tree bad at writes?

Both questions are answered in the same place — the lowest layer of the database, called the **storage engine**: the part that decides how data is laid out on disk, how it is written, and how it is found. Today we go down there.

---

## 1. Theory

### 1.1 The unit of disk — the page

Remember the latency table from Lesson 1.3: reading from memory is more than a thousand times faster than reading from disk. And a big part of the cost of reading from disk is "getting there" — once you are there, reading 1 byte or a few thousand costs roughly the same.

So a database never reads and writes one row at a time. It works in fixed-size blocks called **pages**.

**Page** — the smallest unit a database moves between disk and memory. 8 KB by default in Postgres, 16 KB in MySQL's InnoDB.

```
PostgreSQL's "tasks" table (on disk)
┌──────────────┬──────────────┬──────────────┬─────────┬──────────────┐
│   page 0     │   page 1     │   page 2     │   ...   │  page 2842   │
│  (8 KB)      │  (8 KB)      │  (8 KB)      │         │  (8 KB)      │
│ row, row,    │ row, row,    │ row, row,    │         │ row, row     │
│ row, ...     │ row, ...     │ row, ...     │         │              │
└──────────────┴──────────────┴──────────────┴─────────┴──────────────┘
```

These numbers aren't made up — they were measured on Postgres 17 with a 400,000-row `tasks` table like Lesson 5.2's: the table is **22 MB, that is 2,843 pages**. Every row has an address, which Postgres calls the `ctid` — (page number, position within the page). For example, the row with `id = 123456` lives at `(809, 57)`: page 809, slot 57.

Lesson 4.1's **buffer pool** is now clearer: it is simply copies of these pages kept in memory. During a query the database first checks whether the page is in the buffer pool; if not, it brings the whole 8 KB page in from disk.

Now the question: out of 2,843 pages, how does the database know which page holds `id = 123456` — by reading all of them?

### 1.2 The B-tree — finding it by reading a few pages

Reading every page (a sequential scan) means reading 2,843 pages. To avoid that, the database keeps a separate, **sorted** structure — an index. And the default index in almost every relational database is the B-tree.

**B-tree** — a sorted, many-branched tree in which every node is a page. The upper nodes are "signposts" (which keys go which way), and the bottom **leaf** nodes hold the actual keys and the rows' addresses. (What databases use is really a variant called a B+tree, but everyone calls it a B-tree.)

```
                           ┌────────────────────────────┐
  level 2 (root)           │  < 110k │ < 220k │ < 330k │ …│     ← 1 page
                           └────┬─────────┬─────────┬───┘
                    ┌───────────┘         │         └──────────┐
                    ▼                     ▼                    ▼
  level 1   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
            │ <367│<734│ …  │    │ …  │<123.5k│…│    │      …        │  ← a few pages
            └───┬───────────┘    └───────┬───────┘    └───────────────┘
                ▼                        ▼
  level 0 ┌──────────────┐       ┌──────────────────────────┐
  (leaf)  │ 1→(0,1) …    │  …    │ … 123456→(809,57) …      │  ← 1,099 pages,
          │ 367→(2,14)   │       │                          │     ~367 keys each
          └──────────────┘       └────────────┬─────────────┘
                                              │ straight to the ctid
                                              ▼
                                   table page 809, row 57
```

Measured numbers (400,000 rows, primary key index): the index is **1,099 pages**, each leaf page holds **367 keys**, and the whole tree is only **3 levels deep**. So for `WHERE id = 123456`, Postgres reads:

```
root page (1) → level-1 page (1) → leaf page (1) → table page (1) = 4 pages
```

`EXPLAIN (ANALYZE, BUFFERS)` shows exactly this: `Buffers: shared hit=4`. Four instead of 2,843.

The secret is **fan-out** — how many branches hang below one node. Every node is a whole 8 KB page, so it holds hundreds of keys. Each level multiplies by hundreds, so a tree of 4–5 levels holds billions of rows. Multiply the rows by a thousand and the tree grows by only one or two levels. That is why, with an index, finding one row in a huge table is nearly as fast as in a small one.

**Writing to a B-tree:** a new key is placed right where it belongs (in place), in the correct leaf page. When a page fills up, it splits in two (a page split), and a new signpost is added to the node above. The key point — writes go to **a specific place in the tree**, which can be anywhere on disk. That means lots of **random writes**.

How indexes help queries, composite indexes, why an index sometimes isn't used even though it exists — that is the whole subject of the next lesson (5.4). For today, just this: B-tree = a sorted tree, found by reading a few pages, written in place.

### 1.3 The WAL — keeping data safe through a crash

Now the 2 a.m. mystery.

Creating a task means Postgres has to change one table page and one or more index pages. Writing all those 8 KB pages to disk immediately on every commit would be bad for two reasons:

1. **Slow** — the pages are in different places on disk (random writes), and it writes a full 8 KB for one small row
2. **Dangerous** — what if the power goes halfway through writing three pages? One is written, two aren't — now the table and the index no longer agree with each other

The solution is called the **WAL (Write-Ahead Log)** — **before** changing the data pages, write down "what I am about to change" in a separate, append-only file. There is one rule: **log first, data later.**

```
The journey of a commit:

1. Change the page in the buffer pool (memory)   ┌──────────────────────┐
   — nothing written to disk yet                  │ memory: page 809 ✎   │
                                                  └──────────────────────┘
2. Append a description of the change to the     ┌──────────────────────────────────┐
   WAL — sequential, small (one insert ≈ 440 B)  │ WAL: …│insert│update│insert ← new  │
                                                  └──────────────────────────────────┘
3. Make sure the WAL is on disk (fsync)
   — only then is the client told "COMMIT ok"     ✓ the data is now safe

4. The changed data pages are written to disk     (later, at leisure, many at once)
   later — in the background, at a checkpoint
```

**Checkpoint** — periodically writing all the changed pages in the buffer pool to disk, so you can say "everything up to this point is in the data files".

Now what happens after a crash: Postgres starts, finds where the last checkpoint was, then reads the WAL from there and re-applies every change — that is the **"redo"** in the log. Changes that are in the WAL (that is, they were committed) but hadn't reached the data pages now get there.

This isn't just theory — it was run in Docker: insert 50,000 rows and commit, then **immediately** `SIGKILL` (the same as pulling the plug). On restart, Postgres replayed ~7 MB of WAL and **wrote 463 pages that hadn't reached the disk at the moment of the crash** — then a count showed all 50,000 were there.

Why is the WAL fast? Because it is **sequential** — always appended to the end of the file, so the disk doesn't have to jump around. And it is small — only the change, not the whole page. The random, big job (writing data pages) happens later, in bulk.

**A trade-off you control:** setting `synchronous_commit = off` in Postgres skips the wait in step 3 — commits get faster, but on a crash **the last few commits may be lost** (according to the Postgres documentation, data isn't corrupted; only some recent transactions are lost). That might be fine for TaskFlow's analytics events; never for payments. It can be set **per transaction**, not just for the whole database.

And a preview: this same WAL is the basis of Postgres **replication**. A replica server actually receives the primary's WAL stream and replays it locally. This comes back in Lesson 5.7.

### 1.4 The LSM-tree — never write in place

Writing to a B-tree means finding the right place in the tree and putting it there — random writes. Now suppose your workload is: **hundreds of thousands of writes a second**, mostly new data (messages, sensor readings, events), almost no updates. Then the question arises: what if, like the WAL, **everything** were written by just appending to the end?

That is the core idea of the **LSM-tree (Log-Structured Merge-tree)**. Cassandra, ScyllaDB, RocksDB and LevelDB all use it.

```
WRITE                                              READ (key = "task:42")
─────                                              ────
  │                                                  │
  ├──> commit log (WAL, sequential) — crash safety   │
  │                                                  ▼
  ▼                                            1. in the memtable? ──── yes → return
┌──────────────────────────┐                        │ no
│ MEMTABLE (memory, sorted)│                        ▼
│ task:17, task:42, task:99│                  2. SSTable-3 (newest)? ── no
└────────────┬─────────────┘                        ▼
             │ when full, written to disk      3. SSTable-2? ── yes → return
             │ in one go (sequential)             (never had to reach SSTable-1)
             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ SSTable-3    │ │ SSTable-2    │ │ SSTable-1    │   ← on disk, immutable, each sorted
│ (newest)     │ │              │ │ (oldest)     │
└──────────────┘ └──────────────┘ └──────────────┘
        └──────────── COMPACTION ───────────┘
          in the background, merges several into one,
          dropping old versions and deleted data
```

Three new pieces:

- **Memtable** — a sorted structure kept in memory, where new writes go first. (If the memtable is lost in a crash, it is recovered from the commit log — exactly like the WAL.)
- **SSTable (Sorted String Table)** — when the memtable fills, it is written to disk in one go as a sorted, **immutable** (never changed again) file. The write is sequential — so it is fast.
- **Compaction** — over time many SSTables pile up, and old versions of the same key are scattered across files. In the background, several SSTables are merged into a new one — keeping only the latest version of each key.

**What about updates and deletes?** Nothing changes in place. An update means writing a new version — the newest wins when reading. A delete means writing a special marker — "this key was deleted" (called a tombstone) — and compaction is what really removes the data. There is a real-world trap here: with many deletes, lots of tombstones pile up and reads have to step over them — a well-known performance problem among Cassandra users.

**The cost of reads:** finding one key may mean checking the memtable and several SSTables. To reduce that, each SSTable keeps a small **bloom filter** — which can quickly say "this key is **definitely not** in this file", so many files can be skipped without opening them. (How a bloom filter works is Lesson 10.2's topic.)

### 1.5 The three amplifications — the real trade-off

**Write amplification** — the application wanted to write something small, but many times more bytes actually got written to disk. Both engines do this, for different reasons:

- B-tree: changing one small row still writes a whole 8 KB page (plus the WAL)
- LSM: the same data is rewritten into new SSTables again and again during compaction — once each time it moves down a level

And two more:

- **Read amplification** — how many places you have to check to read one thing
- **Space amplification** — how much more disk space you use compared to the actual data (old versions, deleted data not yet removed)

| Aspect                  | B-tree (Postgres, MySQL InnoDB)                  | LSM-tree (Cassandra, RocksDB)                                |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| Writes                  | In place, random writes                          | Always appended, sequential — high write throughput          |
| Reads (one key)         | Predictable — a few pages, by tree height        | memtable + a few SSTables (bloom filters help)               |
| Range scan ("42 to 99") | Very good — leaves are sorted and adjacent       | Good, but several SSTables must be merged while reading      |
| Update/Delete           | In place                                         | New version / tombstone, real cleanup at compaction          |
| Background work         | Checkpoints (and VACUUM in Postgres — see below) | Compaction — eats CPU and disk I/O, can cause latency spikes |
| Built for               | General work — mixed reads/writes, transactions  | Huge write volumes, time series, append-heavy                |

**An honest caveat:** "B-tree = for reads, LSM = for writes" is a useful **rule of thumb**, not a law. Real performance depends on the workload, the hardware (random writes cost far less on SSDs than on HDDs), and the configuration (e.g. which compaction strategy). Which one wins for a given workload has to be **measured**.

**A twist of Postgres's own:** Postgres tables (not indexes) don't actually update fully "in place". An UPDATE writes a **new version** of the row and keeps the old one for a while — so that other transactions running at that moment can still see the old version. A measured example: the row with `id = 7` was at `ctid (0,7)`; after an `UPDATE` it became `(0,158)` — a new version in a new place. The old versions are cleaned up later by a background process called **VACUUM**. This is called MVCC — and why it exists is the heart of Lesson 5.5 (transactions and isolation).

### 1.6 Why Postgres and Cassandra are so different

Now we can give a deeper answer to Lesson 5.1's question. The storage engines differ because the **goals** differ:

- **Postgres** was built as a general-purpose database: any query, JOINs, multi-row transactions, mixed reads and writes. Hence the B-tree — predictable reads, good range scans, "good enough" for everything.
- **Cassandra** was built to handle huge write volumes across many machines, where data is mostly appended (messages, events). Hence the LSM — writes are always sequential, and the cost of compaction is paid later, in the background.

Who uses what (good to know for learning, no need to memorise):

| B-tree based                            | LSM based                                      |
| --------------------------------------- | ---------------------------------------------- |
| PostgreSQL (indexes; table heap + MVCC) | Cassandra, ScyllaDB                            |
| MySQL (InnoDB)                          | RocksDB, LevelDB (embedded under many systems) |
| SQLite                                  | CockroachDB (Pebble — RocksDB-inspired)        |

**What does this mean for TaskFlow?** The storage engine is **one** reason for choosing a database, not the only one. Lesson 5.1's five questions (data shape, access patterns, consistency, numbers, operations) still come first. Knowing storage engines just teaches you to ask one more question: "how many writes does this workload have, and is it append-heavy?" — and the answer has to be given **in numbers**, not with the word "write-heavy". A few hundred writes a second is completely ordinary for a B-tree database; the LSM advantage becomes clear when the number is much, much bigger and no longer fits on one machine.

---

## 2. Interview Angle

Direct questions about storage engines come up more in senior interviews, but at any level they strengthen your answer to **"why this database?"**

**Common questions:**

- _"Why isn't committed data lost when a database crashes?"_ — WAL: log first, data later; a commit means the WAL is safely on disk; on restart, redo from the last checkpoint. Bonus: mention the `synchronous_commit` trade-off
- _"Why does an index make a query faster?"_ — B-tree, page-sized nodes, huge fan-out, so you find it by reading a few pages. Bonus: being able to quote a number like "3 levels for 400,000 rows"
- _"Why is Cassandra fast at writes?"_ — LSM: memtable + commit log, only sequential writes to disk, updates/deletes are also new writes; the cost is multiple SSTables on reads and background compaction

**What sets a good answer apart:** naming the trade-off yourself. After saying "LSM is fast at writes", add — "but compaction eats CPU and disk, sometimes causes latency spikes, and lots of deletes leave tombstones that slow reads down." That shows you haven't just memorised a slide.

**In real production:** most engineers never switch storage engines themselves — but the knowledge helps every day: why a table bloats after a huge `UPDATE` (MVCC + VACUUM), why the database stops when the WAL disk fills up, why a Cassandra table with many deletes suddenly gets slow — all direct consequences of today's lesson.

---

## 3. Key Takeaway

- A database works on disk in **pages** (8 KB in Postgres) — not rows; the buffer pool is in-memory copies of those pages
- **B-tree** = a sorted, many-branched tree whose every node is a page; thanks to huge fan-out, only 3 levels for 400,000 rows — 4 pages to find a row
- **WAL**: log first, data later — a commit means a small, sequential log is safely on disk; data pages follow later at a checkpoint; redo after a crash
- **LSM-tree**: never write in place — memtable → immutable SSTable → compaction; an update is a new version, a delete is a tombstone
- The real trade-off is in three amplifications — write, read, space; "B-tree for reads, LSM for writes" is a rule of thumb, not a law
- A storage engine follows from the database's **goal** — Postgres general-purpose (B-tree), Cassandra huge append-heavy writes (LSM)
- "Write-heavy" is a feeling; decide **with numbers**

---

## 4. New Terms (Glossary)

| Term                      | Meaning                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Page**                  | The smallest unit a database moves between disk and memory (8 KB in Postgres)                            |
| **B-tree**                | A sorted, many-branched tree whose every node is a page — a key is found by reading a few pages          |
| **WAL (Write-Ahead Log)** | Writing a change to an append-only log before changing the data pages, so it can be redone after a crash |
| **Memtable**              | In an LSM-tree, the sorted in-memory structure that new writes go to first                               |
| **SSTable**               | The sorted, immutable file written to disk when a memtable fills up                                      |
| **Compaction**            | Merging several SSTables into one, dropping old versions and deleted data                                |
| **Write Amplification**   | How many times more bytes are actually written to disk than the application meant to write               |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. Even without a WAL, the database could write the changed data pages to disk immediately on every commit — no data would be lost that way either. Why the extra complexity of the WAL? Give at least two reasons.
2. In an LSM database, one user's profile (the same key) is updated 100 times a day. What does the disk look like after two weeks, and what happens when reading that key if compaction isn't running? How is it different doing the same in a B-tree database?
3. A TaskFlow engineer wants to set `synchronous_commit = off` for the whole database to improve performance. What would you say? Instead of a flat "no", is there a middle path?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** (a) **Speed** — one commit may change several pages, in different places on disk (random writes), each a full 8 KB even though the change might be a few hundred bytes. The WAL holds only the change (one insert ≈ 440 bytes), appended to the end of one file — sequential. (b) **Atomicity** — if the crash comes halfway through writing several pages, some are new and some old — the table and index disagree, and there's no way to tell which finished. The WAL holds the description of the whole change in one place, so redo can fix it. (c) Bonus: pages from many commits can be written together at a checkpoint — a page changed ten times may be written to disk once. And the same WAL drives replication (Lesson 5.7).

**Question 2:** In an LSM every update is a **new version** — nothing changes in place. After two weeks, 1,400 versions are scattered across SSTables (space amplification). To read, it searches for the newest starting from the memtable and going newest→oldest through the SSTables — the latest version is usually in a new file so it's found quickly, but without compaction the number of SSTables keeps growing, the disk fills, and reads of keys living in older files get slower (read amplification). Compaction keeps one version out of 1,400. In a B-tree (from the index's point of view) the key lives in one place and is changed there each time — space barely grows. (In Postgres tables, MVCC keeps old row versions for a while, which VACUUM cleans up — in a sense that is a kind of "compaction" too.)

**Question 3:** Turning it off for the whole database means a crash can lose any **recent** commit — tasks, comments, even future payments. The user saw "saved" but the data is gone — that breaks reliability (tie it to the spaced-repetition question: the system stays available, but not reliable). The middle path: `synchronous_commit` can be set **per transaction** (`SET LOCAL synchronous_commit = off`). So turn it off only where losing a little recent data is acceptable — analytics events, a "last seen" timestamp — and keep the default (on) for tasks, comments and billing. And first measure whether commit latency is really the problem — the bottleneck is often somewhere else.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

I'm not giving a model answer yet — I'll critique yours after you try.

> For each of the four workloads below, say whether a B-tree based (e.g. Postgres) or an LSM based (e.g. Cassandra) storage engine fits better, and why:
>
> 1. **Smart meters:** 1,000,000 electricity meters, each sending a reading every 10 seconds; the main read is "meter X's readings for the last 24 hours"; old readings never change and are deleted after 2 years
> 2. **A bank ledger:** every transaction must change two account balances together; auditors may ask for any kind of report at any time
> 3. **An e-commerce product catalog:** 5,000,000 products, a few thousand updates a day, but thousands of reads a second — filtering by name, category and price range
> 4. **TaskFlow's activity log** — you estimated this in the Lesson 5.1 exercise. Think about those numbers again: does your decision change from the storage-engine point of view?
>
> For each, write:
>
> - **(a)** how many writes per second (calculate where numbers are given), and whether the writes are appends or updates
> - **(b)** the main read pattern — a single key, a range, or ad-hoc
> - **(c)** your choice, and **which amplification** you are accepting
>
> **Bonus question:** in workload 1, readings older than 2 years must be deleted. Keeping in mind how deletes work in an LSM — what problem could deleting each reading individually cause, and what might be a better way?

### See it for yourself (optional, needs Docker)

You can reproduce today's numbers on your own machine. This isn't part of the exercise — just for curiosity. (Run and checked on this machine with Postgres 17.)

```bash
docker run -d --name pg53 -v pg53_data:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=p postgres:17-alpine
sleep 5
docker exec -it pg53 psql -U postgres
```

Inside `psql`:

```sql
SHOW block_size;                                   -- 8192

CREATE EXTENSION pageinspect;
CREATE TABLE tasks (id serial PRIMARY KEY, title text NOT NULL, status text NOT NULL DEFAULT 'todo');
INSERT INTO tasks (title) SELECT 'Task ' || g FROM generate_series(1, 400000) g;

SELECT pg_relation_size('tasks') / 8192 AS table_pages,
       pg_relation_size('tasks_pkey') / 8192 AS index_pages;
SELECT level FROM bt_metap('tasks_pkey');          -- 2 means root, middle level, leaf — 3 levels in all

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM tasks WHERE id = 123456;   -- Buffers: shared hit=4

SELECT ctid FROM tasks WHERE id = 7;               -- (0,7)
UPDATE tasks SET status = 'done' WHERE id = 7;
SELECT ctid FROM tasks WHERE id = 7;               -- a new place — MVCC
```

Then cause the crash yourself — after leaving `psql`:

```bash
docker exec pg53 psql -U postgres -c \
  "INSERT INTO tasks (title) SELECT 'late ' || g FROM generate_series(1, 50000) g;"
docker kill --signal=KILL pg53        # pulling the plug
docker start pg53 && sleep 3
docker logs pg53 2>&1 | grep -E 'not properly|redo'
docker exec pg53 psql -U postgres -c "SELECT count(*) FROM tasks WHERE title LIKE 'late %';"   -- 50000
```

Clean up at the end: `docker rm -f pg53 && docker volume rm pg53_data`

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2
Current: 5.3 — Storage Engine Internals
TaskFlow state: Nginx + 4 Express instances, CDN, Redis cache, one PostgreSQL primary;
normalized schema + openTaskCount counter; an unexpected VM restart lost no committed
data thanks to WAL redo
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.4 — Indexing Deep Dive (with EXPLAIN ANALYZE)
=======================
```

---

## 8. Next Lesson

Send the exercise over — especially the write number for workload 1, and the bonus question. When you are ready, write `next` — Lesson 5.4: **Indexing Deep Dive** — exactly how today's B-tree helps a query, why column order matters in a composite index, why Postgres sometimes ignores an index that exists, and how to read `EXPLAIN ANALYZE` — all with TaskFlow's real queries, hands-on.
