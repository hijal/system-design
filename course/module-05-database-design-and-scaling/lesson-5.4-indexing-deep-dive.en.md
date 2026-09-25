# Lesson 5.4 — Indexing Deep Dive: Why Queries Are Fast or Slow

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 2.5):** Why does offset pagination (`LIMIT 20 OFFSET 100000`) get slow at large offsets, and how does cursor pagination avoid that?

**Prerequisite:** Lesson 5.2 (Schema), Lesson 5.3 (Pages, B-tree)

**By the end of this lesson you will be able to:**

1. Read `EXPLAIN ANALYZE` output and say which path a query takes (Seq Scan, Index Scan, Bitmap, Index Only Scan), how many pages it touched, and where the time goes
2. Design the right index for a query — including column order in a composite index, and partial, expression and covering indexes
3. Understand when Postgres ignores an index that exists, and how much every index costs at write time — measured

**Tier:** 1 — Runnable Code

---

## 0. Where TaskFlow Is Right Now

TaskFlow now has 1,000,000 tasks. Three endpoints keep rising to the top of Express's response-time log:

1. `GET /me/tasks` — "my open tasks" — called on every page load
2. `GET /projects/:id/feed` — a project's latest 20 tasks
3. `GET /reports/daily` — "how many tasks were created today", plus a search by title

Someone on the team offered a simple fix: "put an index on every column, everything will get fast." A senior engineer immediately said — no.

Why not? In Lesson 5.3 you saw how a B-tree finds a row by reading 4 pages. But that was the simplest case — one row by primary key. Real queries have several conditions, sorts, functions, ranges. Today we'll see **when** an index works, **when it doesn't**, and why "an index on every column" is a bad idea.

And today no claim comes from guesswork. The exercise's lab runs every step against 1,000,000 rows and measures it — every number below comes from there.

---

## 1. Theory

### 1.1 Learning to read `EXPLAIN ANALYZE`

Why is a query slow? Instead of guessing, you can ask the database. `EXPLAIN` tells you **how Postgres plans to run** the query; `EXPLAIN ANALYZE` actually runs it and tells you **what really happened**; add `BUFFERS` and it tells you how many pages it touched.

**Query planner** — the part of the database that estimates the cost of every possible way to run a query and picks the cheapest. It estimates using the table's statistics (how many rows, how often each value appears), which the `ANALYZE` command (or autovacuum) keeps up to date.

TaskFlow's feed query, with an index only on `(projectId)` — the real output:

```
Limit  (actual time=0.574..0.576 rows=20 loops=1)
  Buffers: shared hit=500 read=4
  ->  Sort  (actual time=0.573..0.574 rows=20 loops=1)
        Sort Key: "createdAt" DESC
        Sort Method: top-N heapsort  Memory: 26kB
        ->  Bitmap Heap Scan on tasks  (actual time=0.137..0.512 rows=500 loops=1)
              Recheck Cond: ("projectId" = 7)
              Heap Blocks: exact=500
              ->  Bitmap Index Scan on tasks_project  (actual ... rows=500 loops=1)
                    Index Cond: ("projectId" = 7)
Execution Time: 0.618 ms
```

(The `cost=...` parts are removed for clarity — those are the planner's estimates.)

**The reading rule: inside out, bottom up.** The innermost node runs first, and its output feeds the node above:

1. **Bitmap Index Scan** — pulled the addresses of project 7's 500 rows out of the index
2. **Bitmap Heap Scan** — sorted those addresses by page and fetched the 500 rows from the table (`Heap Blocks: exact=500` — 500 different pages!)
3. **Sort** — sorted the 500 rows by `createdAt`
4. **Limit** — kept the first 20 and threw away the other 480

Now the problem is visible: **fetching, sorting and discarding 500 rows to get 20.** We'll fix that in 1.3.

The most common nodes:

| Node                                     | Meaning                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Seq Scan**                             | Reading the whole table from start to end                                                               |
| **Index Scan**                           | Searching the index, then going to the table to fetch each matching row                                 |
| **Index Only Scan**                      | Every column of the answer is in the index — no need to visit the table                                 |
| **Bitmap Index Scan → Bitmap Heap Scan** | First collect all addresses from the index, then read the table in page order — for many matches        |
| **Sort**                                 | Sorting in memory (or on disk) — expensive when large                                                   |
| **Gather**                               | Splitting the work across several worker processes (parallel query) — usually seen above a big Seq Scan |

The three things to look for first:

- **A Seq Scan on a big table** — often a missing index
- **A big gap between the estimated and actual `rows`** — the planner's statistics are old or wrong; it is deciding on bad information
- **Many rows under a Sort, few above it at a Limit** — exactly like the example above; usually a chance for a good composite index

**With Sequelize:** to see what SQL Sequelize generates, set `logging: console.log` on the connection, then paste that SQL after `EXPLAIN (ANALYZE, BUFFERS)` in `psql`. And a warning: `EXPLAIN ANALYZE` **really runs** the query. On a `DELETE` or `UPDATE` it really changes data — so wrap such queries in `BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;`.

### 1.2 The first step — an index on the foreign key, and a partial index

In Lesson 5.2 we said Postgres doesn't create indexes on foreign key columns by itself. The `/me/tasks` query:

```sql
SELECT id, title, status FROM tasks WHERE "assigneeId" = 42 AND status <> 'done'
```

Step 1 of the lab (on my machine, all pages warm in memory, median of 5 runs):

```
index                                time       pages   plan
no index                         25.76 ms     8,399   Gather → Seq Scan
(assigneeId)                      0.15 ms       203   Bitmap Heap Scan → Bitmap Index Scan   (index: 6728 kB)
(assigneeId) WHERE status <> done 0.07 ms        70   Bitmap Heap Scan → Bitmap Index Scan   (index: 2072 kB)
```

Without an index, the whole table (8,399 pages) is read. A plain index makes it ~170× faster.

Look at the third line. In TaskFlow 70% of tasks are "done", and this query never wants done tasks. So what's the point of keeping done tasks in the index?

**Partial index** — an index over only the rows that satisfy a condition. Here `WHERE status <> 'done'` — so the index shrinks **from 6.7 MB to 2.1 MB**, and the query touches even fewer pages. A smaller index takes less space in the buffer pool, and inserting or updating a "done" task doesn't have to touch this index at all.

In a Sequelize migration (from the lab's code):

```typescript
setup: () =>
	qi.addIndex('tasks', {
		fields: ['assigneeId'],
		name: 'tasks_assignee_open',
		where: { status: { [Op.ne]: 'done' } }
	}),
```

One condition: the planner uses a partial index only when it can prove from the query's `WHERE` that every row it needs is in the index. What if you drop `status <> 'done'` from the query? That is the exercise's experiment 4 — guess first.

### 1.3 Composite indexes — column order is everything

Now the feed query:

```sql
SELECT id, title, "createdAt" FROM tasks
WHERE "projectId" = 7 ORDER BY "createdAt" DESC LIMIT 20
```

**Composite index** — one index over several columns. The B-tree is sorted by the first column, then by the second where the first is equal, and so on.

The best analogy is an old-fashioned **telephone directory**: sorted by surname first, and by first name within the same surname. Finding "Ahmed, Karim" is easy. Finding "all the Ahmeds" is easy too. But finding "every Karim, any surname" means reading the whole book.

Step 2 of the lab — the same two columns, in different orders:

```
index                           time       pages   plan
no index                     20.46 ms     8,473   Limit → Gather Merge → Sort → Seq Scan
(projectId)                   0.42 ms       504   Limit → Sort → Bitmap Heap Scan → Bitmap Index Scan
(createdAt, projectId) reversed 0.47 ms     188   Limit → Index Scan Backward
(projectId, createdAt)        0.04 ms        23   Limit → Index Scan Backward
```

In `(projectId, createdAt)`, all of project 7's entries sit next to each other inside the index, **already sorted by `createdAt`**. Postgres just goes to the end of project 7's section, reads 20 going backward (`Backward`), and stops. No Sort node, no fetching 500 rows — 23 pages. Ten times faster than `(projectId)` alone.

See how simple the real output is:

```
Limit  (actual time=0.024..0.040 rows=20 loops=1)
  ->  Index Scan Backward using tasks_project_created on tasks  (actual ... rows=20 loops=1)
        Index Cond: ("projectId" = 7)
Execution Time: 0.053 ms
```

`rows=20` — it read exactly as many as it needed.

The reversed order `(createdAt, projectId)` doesn't look too bad — but that's **luck**. Here project 7's tasks are spread evenly over time, so reading backward from the newest finds 20 quickly. For a project whose latest task is a year old, this index would have to walk past every task of every project for a whole year. (You'll see it yourself in the exercise's experiment 1.)

**The rule for composite index design:**

```
1. Columns filtered by = (equality) first            ── "projectId" = 7
2. Then the range (<, >, BETWEEN) or ORDER BY column ── "createdAt"
```

**The link to the spaced-repetition question:** remember Lesson 2.5's cursor pagination — for the next page, `WHERE "projectId" = 7 AND "createdAt" < :cursor ORDER BY "createdAt" DESC LIMIT 20`. With exactly this `(projectId, createdAt)` index, every page is equally fast — it jumps straight to the cursor and reads 20. With `OFFSET 100000`, Postgres has to walk past and discard the first 100,000 entries — even with an index. That's why cursor pagination scales.

### 1.4 The leftmost prefix — the second column alone doesn't help

The `/reports/daily` query — filtering only by time, with no project:

```sql
SELECT count(*) FROM tasks WHERE "createdAt" >= '2026-09-24'
```

Step 3 of the lab:

```
index                     time       pages   plan
(projectId, createdAt) 25.11 ms     8,399   Aggregate → Gather → Aggregate → Seq Scan
(createdAt)             0.15 ms         8   Aggregate → Index Only Scan
```

The `(projectId, createdAt)` index contains `createdAt` — yet Postgres read the whole table. Like looking up "every Karim" in the telephone directory: the `createdAt` values are scattered across 2,000 separate places in the index (one run inside each project).

**Leftmost prefix rule** — a composite index `(a, b, c)` can be used effectively only with conditions on columns taken contiguously from the left: `a`, `a + b`, or `a + b + c`. Not `b` alone or `c` alone.

**An honest caveat — the story shifts a little between versions:** the result above is from Postgres 17 (the lab's version). Postgres 18 added B-tree **skip scan**: a separate "jump" into the index for each distinct value of the first column. Running the same data and the same `(projectId, createdAt)` index on Postgres 18.6: instead of a Seq Scan it chose a skip scan (`Index Searches: 1996`, roughly once per project), taking **~15 ms** and about 6,000 pages. Better than the Seq Scan (25 ms) — but nearly **100× slower** than a dedicated `(createdAt)` index (0.15 ms, 8 pages). The fewer distinct values in the first column (say 4 statuses), the better skip scan works. So the modern form of the rule: **without the leftmost prefix, a composite index either doesn't help or helps far less efficiently** — a hot query needs its own suitable index. And always check with `EXPLAIN` on your own version.

### 1.5 How indexes break — functions, and LIKE

**A function on the column.** "Tasks created on 1 September" — written the natural way:

```sql
WHERE "createdAt"::date = '2026-09-01'          -- 33.54 ms, 8,399 pages, Seq Scan
WHERE "createdAt" >= '2026-09-01'
  AND "createdAt" <  '2026-09-02'               --  0.16 ms,     8 pages, Index Only Scan
```

The same question, the same `(createdAt)` index — a 200× difference. Because the index is sorted by the value of `createdAt`, not by the value of `createdAt::date`. Put any function or cast on the column and Postgres has to compute it **for every row** — the index's sorted order no longer helps. The fix is usually to write the query so the column stands alone and the computation moves to the other side (here, a range).

When the query can't be changed — for example a case-insensitive search `lower(title) = 'fix bug #23'`:

```
(title) + lower(title) = …          67.23 ms   8,399 pages   Seq Scan
(lower(title)) — expression index    0.03 ms       4 pages   Index Scan
```

**Expression index** — an index built on the result of an expression instead of a column's value: `CREATE INDEX ON tasks (lower(title))`. The planner uses it when the query contains exactly the same expression.

**LIKE.** Step 7 of the lab, with an index on `(title)`:

```
(title) + LIKE '%bug%'                  28.25 ms   8,399 pages   Seq Scan
(title) + LIKE 'Fix bug #1234%'         23.52 ms   8,399 pages   Seq Scan
(title text_pattern_ops) + same LIKE     0.03 ms       5 pages   Index Only Scan
```

- `'%bug%'` — a leading `%` means "anywhere in the middle". That can't be found using a sorted order — a B-tree will never help here. It needs a different kind of index (Lesson 8.3's inverted index, or Postgres's `pg_trgm`).
- `'Fix bug #1234%'` — the start is fixed, so in theory a B-tree should manage. But it didn't! Because the database's collation is `en_US.utf8` — string sort order there follows language rules, not byte order, and prefix search isn't safe under it. Build the index with `text_pattern_ops` and it is sorted in byte order, and prefix search works. This is a real trap — the default Postgres Docker image uses exactly this collation.

### 1.6 Selectivity — the index exists, but Postgres doesn't use it

**Selectivity** — what fraction of the table's rows a condition picks out. "blocked" (1%) is high selectivity; "done" (70%) is very low.

Step 5 of the lab, the same `(status)` index, `SELECT id, title ... WHERE status = ...`:

```
(status) + status = 'done'       89.11 ms   8,399 pages   Seq Scan
(status) + status = 'blocked'     5.60 ms   5,810 pages   Bitmap Heap Scan → Bitmap Index Scan
```

For "done", Postgres didn't even touch the index. That's not a mistake — it's the planner's **correct** decision. Going through the index for 700,000 rows would mean jumping from index to table 700,000 times, in random order. Reading the whole table once, in order, is cheaper. (What happens if you force the planner to use the index — the exercise's experiment 3.)

The second line hides a big lesson: **only 1% of rows, but 5,810 pages — about 70% of the table!** Why? Because the 10,000 "blocked" tasks are spread across the whole table; almost every page has one or two. Fetching each row means reading its whole page (Lesson 5.3). So selectivity has to be measured by **how many pages must be touched**, not just how many rows. The planner accounts for this — it keeps a statistic on the correlation between rows' physical order and the column's values.

**What this means for TaskFlow:** an index on `status` alone is nearly pointless — for the values most queries want (done/todo), the planner won't use it. `status` belongs inside a composite index (`(projectId, status)` — Lesson 5.2), or in a partial index's condition (1.2).

### 1.7 Covering indexes — answering without visiting the table

The feed query's `(projectId, createdAt)` index needed 23 pages: a few index pages, plus ~20 table pages to fetch each row's `id` and `title`. What if those columns were in the index too?

**Covering index** — an index that contains **every** column the query needs, so the answer comes without visiting the table (an **Index Only Scan** in the plan). In Postgres, `INCLUDE` adds extra columns — not part of the sort, just stored alongside in the leaves:

```sql
CREATE INDEX tasks_project_created_cover ON tasks ("projectId", "createdAt") INCLUDE (id, title)
```

```
(projectId, createdAt)                       0.04 ms   23 pages   Limit → Index Scan Backward
(projectId, createdAt) INCLUDE (id, title)   0.04 ms    4 pages   Limit → Index Only Scan Backward
```

The time looks identical — because every page is warm in memory in the lab. But the pages go from 23 to 4. In production, where not every page is in the buffer pool, each skipped page may be a disk read saved. **That's why the `pages` column is often a more honest measure than time.**

Two caveats:

- The index gets bigger — more so if you INCLUDE a long column like `title`. Each covering index is for one specific, hot query; not everywhere.
- In Postgres, an Index Only Scan needs the table's **visibility map** to be up to date — which VACUUM does. Remember MVCC from Lesson 5.3? If Postgres isn't sure a row version is visible to every transaction, it has to go check the table. That's why the exercise's seed ends with `VACUUM ANALYZE`.

### 1.8 The cost — every index slows down writes

Now the answer to the senior's "no". An index is **another sorted copy** — just like Lesson 5.2's denormalisation, and its price is paid at write time. Every `INSERT` has to put an entry in the right place in every index's B-tree (Lesson 5.3), and write WAL for that too.

The exercise's `npm run writecost` — inserting 200,000 rows with 0, 3 and 6 indexes beyond the primary key:

```
indexes (besides the PK)   time               WAL        total index size
 0                          418 ms (1.0x)     31.7 MB      4.3 MB
 3                         1218 ms (2.9x)     77.9 MB     21.5 MB
 6                         1999 ms (4.8x)    126.9 MB     43.4 MB
```

Six indexes make inserts almost **5× slower**, and WAL **4×** — Lesson 5.3's write amplification, measured directly. And remember, more WAL also means more data to ship to replicas (Lesson 5.7).

**So which indexes should you keep?** The rule comes from Lesson 5.1: **build indexes from queries, not from columns.** Every index should have a specific, important access pattern behind it. And there's a way to find the ones nobody uses — the `idx_scan` column of Postgres's `pg_stat_user_indexes` view tells you how many times each index has been used. `0` for months means that index is only slowing down writes.

**A rule for adding indexes in production:** a plain `CREATE INDEX` blocks writes to the table for as long as it runs — a few seconds at a million rows, many minutes at a hundred million. On a live system use `CREATE INDEX CONCURRENTLY` (`concurrently: true` in Sequelize's `addIndex`). It is slower, but it doesn't block writes. One trap: it can't run inside a transaction, so the migration has to be written accordingly. The full story of zero-downtime migrations is in Lesson 10.6.

> **Trade-off Table — Kinds of index**

| Kind                 | When                                                    | Cost / caveat                                             |
| -------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Single-column        | Filtering by one column, selective enough               | The planner won't use it at low selectivity               |
| Composite            | Several conditions, or a filter + ORDER BY              | Nearly useless in the wrong column order; leftmost prefix |
| Partial              | Queries always want one specific slice (open tasks)     | The query must contain the same condition                 |
| Expression           | The query has a function or expression (`lower(title)`) | The query needs exactly the same expression               |
| Covering (`INCLUDE`) | A very hot query, to avoid visiting the table           | Bigger index; needs VACUUM                                |
| Any index            | —                                                       | Every write slower, more WAL, more disk and memory        |

---

## 2. Interview Angle

**"A query is slow. What do you do?"** — one of the most common backend interview questions. A good answer is a **process**, not a guess:

1. **Measure** — which query, how slow, how often it runs (a 500 ms query run once a day vs a 50 ms query run 1,000 times a second — the second is the bigger problem)
2. **`EXPLAIN (ANALYZE, BUFFERS)`** — a Seq Scan on a big table? Many rows under a Sort? A big gap between estimated and actual `rows`?
3. **Find the cause** — no index, or an index that isn't used (function, leftmost prefix, selectivity, stale statistics)?
4. **Fix it** — rewrite the query (range, cursor) or add the right index
5. **Measure again** — the new plan in `EXPLAIN`, and the effect on writes

**Common follow-ups:**

- _"There's an `(a, b)` index. Will `WHERE b = 5` use it?"_ — not effectively, because of the leftmost prefix; Postgres 18's skip scan can use it by jumping once per value of `a`, but with many distinct values in `a` that's far slower than a `(b)` index — bonus points for saying this
- _"Why not index every column?"_ — every write updates every index; in the lab, 6 indexes made inserts ~5× slower and WAL 4×; and the planner won't even use a low-selectivity index
- _"There's an index, so why a Seq Scan?"_ — selectivity (too many rows), a function/cast on the column, or stale statistics (run `ANALYZE`)

**In real production:** the most common performance bugs are missing indexes on foreign keys, the wrong column order in composite indexes, and queries like `WHERE date(created_at) = ...`. And the most common opposite bug: unused indexes piling up for years, quietly slowing down every write.

---

## 3. Key Takeaway

- Read `EXPLAIN (ANALYZE, BUFFERS)` inside out; look for big Seq Scans, many rows under a Sort, and gaps between estimated and actual `rows`
- Postgres doesn't index foreign keys — add them yourself; if queries always want one slice, use a **partial index** (6.7 MB → 2.1 MB in the lab)
- Composite indexes: **equality columns first, then range/ORDER BY**; the wrong order is 10× slower, and without the **leftmost prefix** the second column alone doesn't help (Postgres 18's skip scan helps, but far less efficiently)
- A function/cast on the column breaks the index — write the query as a range, or use an **expression index**; `LIKE '%x%'` never works with a B-tree
- At low **selectivity** the planner rightly ignores the index; measure selectivity in pages — 1% of rows can touch 70% of pages
- A **covering index** saves the trip to the table (23 → 4 pages); with a cold cache, that's the big difference
- Indexes aren't free — 6 indexes make inserts ~5× slower and WAL ~4×; build indexes **from queries**, remove the unused ones, and use `CONCURRENTLY` in production

---

## 4. New Terms (Glossary)

| Term                     | Meaning                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Query Planner**        | The part of the database that uses statistics to estimate the cost of every possible plan and pick the cheapest              |
| **Selectivity**          | What fraction of the table's rows a condition picks — a smaller fraction means higher selectivity, where an index helps more |
| **Composite Index**      | An index over several columns — sorted by the first, then the second, and so on                                              |
| **Leftmost Prefix Rule** | A composite index `(a, b, c)` is effective only for conditions on columns contiguous from the left: `a`, `a+b`, `a+b+c`      |
| **Partial Index**        | An index over only the rows that satisfy a condition (`WHERE status <> 'done'`) — smaller, cheaper                           |
| **Expression Index**     | An index built on the result of an expression instead of a column (`lower(title)`)                                           |
| **Covering Index**       | An index holding every column the query needs, so it is answered without visiting the table (Index Only Scan)                |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. A new query in TaskFlow: `WHERE "projectId" = 7 AND status = 'todo' ORDER BY "createdAt" DESC LIMIT 20`. Design an index for it — which columns, in what order, and why? Give at least two different solutions, and when each is better.
2. An `EXPLAIN ANALYZE` shows: `Nested Loop (rows=1) (actual rows=48000)`. The planner expected 1 row and got 48,000. What problem does this point to, and what could its effect be? What would you try first?
3. To find out why a `DELETE` is slow, a developer ran `EXPLAIN ANALYZE DELETE FROM tasks WHERE ...` directly in production. What happened? How should it have been done safely — and when adding a new index in production, what other trap must be avoided?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The rule — equality columns first, then the ORDER BY column.

- **Solution A:** `(projectId, status, createdAt)` — `projectId` and `status` are both `=`, so they go first; `createdAt` last, so it reads straight from the index in sorted order and stops at the Limit (like step 2, no Sort). Advantage: it works for any status (`'doing'` and `'blocked'` too).
- **Solution B:** a partial index `(projectId, createdAt) WHERE status = 'todo'` — only todo tasks, so much smaller; but useful only for queries with exactly that condition.

If the app runs this query with various statuses → A. If only the "todo" view is hot → B is smaller and faster. The order of `projectId` and `status` relative to each other matters less here (both `=`), but if another query filters by `projectId` alone, putting `projectId` first lets the same index serve that one too, thanks to the leftmost prefix.

**Question 2:** The planner's **statistics are wrong or stale** — it chose its plan on a bad estimate. A Nested Loop is great for few rows (one inner lookup per outer row), but at 48,000 rows that's 48,000 inner lookups — where a Hash Join would have been far faster. The result: the query suddenly gets many times slower, often without any code change (the data grew, the statistics didn't). First try: run `ANALYZE tasks` and `EXPLAIN` again. If that doesn't fix it: check whether two columns are correlated (like `city` and `country` — the planner assumes they're independent and multiplies the two conditions into a tiny number); Postgres lets you add extended statistics for this with `CREATE STATISTICS`.

**Question 3:** `EXPLAIN ANALYZE` **really runs** the query — the rows were really deleted from production. The safe way: `BEGIN; EXPLAIN ANALYZE DELETE ...; ROLLBACK;` — you see the plan and timing, the data doesn't change (though remember the rows are locked while the transaction runs — be careful with that at busy times in production too). Or plain `EXPLAIN` (without ANALYZE), which doesn't run it, only shows the plan. The second trap: once the cause is found, a plain `CREATE INDEX` blocks writes to the table for the whole time the index is being built — on a big table, nobody in TaskFlow could create a task for minutes on end. Use `CREATE INDEX CONCURRENTLY` (outside a transaction).

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **Ready to run in the repo:** [`exercises/lesson-5.4-indexing/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.4-indexing) — `docker compose up -d --wait && npm install && npm run seed`, then `npm run lab` and `npm run writecost`. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

A lab over 1,000,000 tasks — TaskFlow's real queries in 7 steps, each with different indexes, `EXPLAIN (ANALYZE, BUFFERS)` results side by side. Indexes are created with `queryInterface.addIndex`, exactly as you'd write them in a Sequelize migration. Verified by running it in the sandbox: `tsc --noEmit` is clean, the lab was run several times with identical plans and pages each time, and `writecost` was run twice with identical WAL. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run `npm run lab`. Do the **plan shapes and pages** on your machine match the README? (Different times are normal.) If a plan differs at any step, send it over — we'll look at why together.

2. **Break the reversed index's luck** (README experiment 1): make all of project 7's tasks a year old and run `npm run lab -- 2`. How many pages for `(createdAt, projectId)`? For `(projectId, createdAt)`? From this difference, write one paragraph on why an index that is "fast by luck" can't be trusted in production.

3. **The selectivity threshold** (experiment 2): add `'doing'` (7%) and `'todo'` (22%) and find where the planner changes its mind.

4. **Force the planner** (experiment 3): run the `'done'` query with `enable_seqscan = off`. Was the forced index plan faster than the Seq Scan? Write it down with numbers.

5. **Design part:** propose a set of **as few indexes as possible** for these five TaskFlow queries, noting which query each one serves:

   - (a) `WHERE "assigneeId" = ? AND status <> 'done'`
   - (b) `WHERE "projectId" = ? ORDER BY "createdAt" DESC LIMIT 20` (with cursor pagination)
   - (c) a count of `WHERE "projectId" = ? AND status <> 'done'` (Lesson 5.2's dashboard)
   - (d) a count of `WHERE "createdAt" >= ? AND "createdAt" < ?` (the daily report)
   - (e) `WHERE lower(title) = ?`

   Then, looking at the `writecost` numbers — roughly how many times slower will inserts be with your set? Is any index worth dropping, at the cost of which query?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2, 5.3
Current: 5.4 — Indexing Deep Dive
TaskFlow state: Nginx + 4 Express instances, CDN, Redis cache, one PostgreSQL primary
(1,000,000 tasks); normalized schema + openTaskCount; query-driven indexes —
a partial index on the FK, (projectId, createdAt) composite for the feed, measured with EXPLAIN ANALYZE
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.5 — Transactions, ACID, Isolation Levels
=======================
```

---

## 8. Next Lesson

Run the lab and send your numbers — especially the pages from #2 and your index set from #5. When you are ready, write `next` — Lesson 5.5: **Transactions, ACID, Isolation Levels** — where we finally open up Lesson 5.2's mystery: why updates get lost even with read-modify-write inside a transaction, which anomalies each level from read committed to serializable does and doesn't prevent, and how Postgres's MVCC really works — hands-on, with TaskFlow's real race conditions.
