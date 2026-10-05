# Lesson 7.6 — Batch vs Stream, OLTP vs OLAP: Which Path When

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.4):** Which queries does a composite index `(project_id, occurred_at)` help and which doesn't it — and who pays the price of every extra index on a table, and when? Today you'll see where the attempt to speed up an analytics question with an index gets stuck.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 5.4 (Indexing), Lesson 5.7 (Read replica), Lesson 7.1 (Backlog), Lesson 7.2 (Log, replay), Lesson 7.5 (Event, CDC)

**By the end of this lesson you will be able to:**

1. Recognise whether a question is OLTP or OLAP, and say with measured numbers why analytics shouldn't run on the production database; and explain where the difference between a row store and a column store comes from
2. Decide whether a calculation happens in batch or in a stream with two questions — how fast the result is needed, and how correct it has to be
3. Design handling of late-arriving data with event time, processing time, windows and watermarks — and know which mistake is never fixed by which approach

**Tier:** 1 — Runnable Code (Postgres vs DuckDB in Docker, and a deterministic stream simulation)

---

## 0. Where TaskFlow Is Right Now

Over Module 7's five lessons, every change in TaskFlow has become an event — from the outbox to a Redis Stream, reliably, with idempotent consumers. The flow of data is in place. And along with it, the number of people who want data has grown. Two requests in one week, two incidents:

1. **Finance, Tuesday 11 a.m.** To reconcile billing, an analyst from finance asked for: "how many tasks were completed per month in each workspace over the last 12 months." To help, an engineer wrote a `GROUP BY` and ran it on the production database — for four months, in four tabs, at once. Five minutes later, the on-call phone: the task board is slow to open, a p99 alert. No deploy, traffic normal. Half an hour to find the cause.
2. **Product, Thursday.** A new live dashboard: "how many tasks your team completed per hour." The first version is simple — every `task.completed` arriving in the stream adds +1 to that hour's counter. On Friday the mobile event pipeline was stuck for an hour (1–2 p.m.), and at 2 all the piled-up news arrived at once. On the dashboard the 1 o'clock hour is nearly zero, the 2 o'clock hour doubled. A customer's manager asked: "did my team do nothing from 1 to 2?" And the billing team wanted to know whether usage can be calculated with this number.

Behind both incidents is Module 7's last question: data **questions** come in two kinds — "give me this one thing now" and "what does it all add up to" — and their place, their timing and their rules are different.

---

## 1. Theory

### 1.1 Two kinds of question — OLTP and OLAP

The query that runs when TaskFlow's board opens and finance's query — both look like SQL, but their shapes are opposites.

**OLTP (Online Transaction Processing)** — the application's everyday work: reading or writing a few rows, found by key or index, very fast (ms), with many users at once.

**OLAP (Online Analytical Processing)** — analysis questions: reading a huge number of rows to sum, average and count (aggregate), usually over a few columns; they can run for seconds or minutes, and a few people run them.

| Property              | OLTP (the task board)                     | OLAP (finance's report)                                                   |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| Shape of the question | "the 20 most recent events in project 42" | "the total per month for every workspace"                                 |
| Rows touched          | A few to a few hundred — via an index     | Hundreds of thousands to tens of millions — the whole table or a big part |
| Columns               | Often the whole row                       | A few (3 out of 8)                                                        |
| Time expected         | Milliseconds, measured at p99             | Runs for seconds to minutes                                               |
| How many at once      | Thousands of requests                     | A few analysts, a few dashboards                                          |
| Writes                | Many small inserts/updates                | Loaded in big batches, few updates                                        |
| How fresh the data is | This very moment                          | A few minutes or a day old is often fine                                  |

### 1.2 Both in one database — Tuesday, 11 a.m.

The exercise's `npm run olap` — a Postgres with 3 million `task_events` (limited to 2 CPUs, like a production database — whose cores are limited too). For the first 10 seconds 8 clients run only the board's query; for the next 10 seconds, four of finance's queries at the same time:

```
   phase                           OLTP q/s   OLTP p50    OLTP p99   OLTP max    analytics done (avg)
   OLTP only                          15222     0.6 ms      1.1 ms    20.2 ms                       —
   OLTP + 4 analytics                  4330     0.6 ms     68.5 ms    77.1 ms     47 times (868.8 ms)
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

The board's query itself didn't change at all — the same index, the same plan. Yet p99 went **from 1.1 ms to 68.5 ms**, and queries per second from 15 thousand to 4 thousand. The reason is a softer form of Lesson 7.1's cascading failure: a shared resource. The analytics queries occupy both CPUs, pull the whole table from disk, and push the board's hot pages out of the memory cache (shared buffers). The board's small queries stand in line. (Experiment 1: with one analytics query, p99 stays about the same, but throughput drops ~35%. "One report doesn't hurt" — until someone opens four tabs.)

**"Then let's run analytics on a read replica"** (Lesson 5.7)? That's much better — the primary's CPU and cache are spared. But two problems remain. First, the replica is a row store too — the question is slow there as well (1.3). Second, a tug-of-war between long queries and replication: when the replica wants to apply the primary's changes while a long query is reading those old rows, Postgres has to choose — cancel the query (`canceling statement due to conflict with recovery`), or hold replication back. Turning on `hot_standby_feedback` saves the query, but then the primary can't clean up old rows (bloat). At a small scale a replica is a good first step; at a larger one, analytics needs its own place.

### 1.3 Row store vs column store

Finance's question on Postgres alone (nothing else running), and the same data in a column store — on the same two CPUs:

```
   the same analytics question (monthly usage, per workspace), nothing else running, three times each:
     Postgres (row store, 2 CPUs):       255.9 ms, 257.6 ms, 258.7 ms
     DuckDB   (column store, 2 threads):  28.6 ms, 21.1 ms, 21.4 ms
     results match: yes ✓

   from Postgres's plan:
     ->  Seq Scan on task_events  (… rows=750000 loops=1)
     Buffers: shared hit=11011 read=19917
```

~12 times, on the same CPUs, with the same result. Where from?

Look at the plan's last line: 11011 + 19917 = 30928 pages, each 8 KB — about 242 MB, **the whole table**. Yet the question needs three of the eight columns (`type`, `workspace_id`, `occurred_at`, and `duration_ms` to sum). Postgres can't read them separately, because its very layout on disk is by row:

```
   row store (Postgres):  each page holds a few whole rows side by side

     page 1: [id|ws|proj|task|user|type|time|dur] [id|ws|proj|task|user|type|time|dur] …
     page 2: [id|ws|proj|task|user|type|time|dur] …
             → to read "the type of every row" you read every page, so every column

   column store (DuckDB, ClickHouse, BigQuery …):  each column separate, contiguous

     type: [completed, created, assigned, completed, completed, …]    ← only this
     ws:   [12, 12, 12, 40, 40, 40, 40, …]                             ← and this
     time: [2025-01-01 00:00:07, …]                                    ← and this
     proj, task, user, id: never touched
```

**Column store** — storing data not by row but by column, each separately; a question reads only the columns it needs.

Three reasons this is fast for analytics:

1. **Less reading** — only the columns needed.
2. **Compression** — a column's values are of one kind and often repeated (`type` has four values in all, `workspace_id` 200) — so they compress very well. In the exercise, Postgres's table is 242 MB, DuckDB's file 28 MB. (Honest note: the exercise's data is generated from a formula and unusually regular — on real data the ratio won't be this good, though being several times smaller is common.)
3. **Vectorized execution** — not one row at a time, but the same operation on a chunk of a thousand values at once — making good use of both the CPU's cache and its instructions.

So why not keep everything in a column store? Because OLTP wants exactly the opposite. The board's query wants a task's **whole row** — in a column store that has to be stitched together from eight separate places. Inserting a new comment means adding one value to each of eight columns — and column stores are built for writing in big batches, not one row at a time. Updates and deletes are even more painful. So the world has split: **row stores for OLTP, column stores for OLAP.**

**"Can't Postgres be made fast with an index?"** — Experiment 2: an index on `(type, workspace_id, occurred_at) INCLUDE (duration_ms)` — Postgres now answers from the index alone (an index-only scan), from 257 ms to 143 ms. But the table + index size goes from 396 MB to 565 MB, every insert writes another index (the spaced repetition answer — the price is paid by **every write**, always), and while analytics runs the board's p99 is still ~69 ms. And finance's next question ("per project", "per user") won't use this index. One index per analysis question — that doesn't hold up in an OLTP database.

(A few names: **DuckDB** — runs as a library, on a file or Parquet files; excellent for small teams and medium data. **ClickHouse** — a self-run column store server, fast and popular. **BigQuery, Snowflake, Redshift** — managed data warehouses in the cloud. Their general name is **data warehouse** — a separate, column-based database for analytics.)

### 1.4 How data gets there — batch and stream

Analytics has its own place now. The next question: how, and how often, production's data gets there — and when the calculations on it happen. Two basic ways:

**Batch processing** — taking a fixed, bounded amount of data (e.g. "all of yesterday's events") and processing it at once, usually at set intervals (once a night, once an hour).

**Stream processing** — processing data continuously as it arrives, one at a time (or in small chunks); the data has no "end", and the calculation is always running.

| Property            | Batch                                                   | Stream                                                                  |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| When the result     | On the next run — hours or a day later                  | Seconds or minutes later                                                |
| How correct         | Easily correct — all the data is there at run time      | Late-arriving data is hard (1.5)                                        |
| Running it again    | Easy — fix the bug and rerun the whole day              | Hard — there's state; needs replay from the log (7.2)                   |
| Operating it        | Easy — a script or SQL, on a cron                       | Hard — an always-running process, state, checkpoints, rules about time  |
| On failure          | Again on the next run                                   | When it stops it falls behind (lag), and has to catch up                |
| Example in TaskFlow | Monthly usage, invoices, finance's reports, data for ML | The live dashboard, "how many are online right now", fraud/abuse alerts |

The two deciding questions: **how quickly is the result needed?** And **how correct does the result have to be, and by when?** Finance's monthly report isn't needed this afternoon, but every number must be right — batch. A live dashboard is useless if it's a minute old, and being a little approximate is fine — stream.

(In practice "batch" often looks ordinary: at night a job pulls the previous day's changes from a production replica (or from data accumulated from 7.5's CDC), writes them to Parquet files or the warehouse, and then the SQL reports run. Extracting the data, transforming it, and loading it — the old name for this is ETL; these days it's often load first, then transform inside the warehouse — ELT.)

### 1.5 Two kinds of time — event time, processing time, and the watermark

Thursday's dashboard mistake comes from the most basic question of stream processing: "hour" means the hour by which clock?

**Event time vs processing time** — every event has two times: event time is when the event **actually happened** (when the task was completed), and processing time is when the news **reached** the system or was processed. The gap between them ranges from a few ms to a few hours.

Why the gap? A mobile app's network drops; a laptop works offline and syncs later; and all through Module 7 we've seen it — during an outage a backlog piles up, then arrives all at once. That's exactly why 7.5's event keeps `occurredAt` separately.

In a stream, calculations happen in **windows** — slices of time (here one hour, side by side, not overlapping — a "tumbling window"). The question: which event goes into which hour's window, and when do we consider a window "finished" and emit its result? Two basic answers:

- **By processing time:** count it in the hour the news arrives; emit the result when the clock's hour ends. Simple, immediate — and counts in the wrong hour.
- **By event time:** count it in the hour the event happened. But then when do you emit the 1 o'clock hour's result? The moment it's 2? The news of an event at 1:59 might arrive at 2:10. You can't wait forever.

**Watermark** — a stream processor's estimate: "events with an event time earlier than this will (almost) no longer arrive." Usually = the largest event time seen − an allowed delay (allowed lateness). When the watermark passes the end of a window, that window's result is emitted.

A watermark is an estimate — and we know from Lesson 6.1 that estimates are wrong. When an event for a window arrives after its watermark, that's **late data** — whether to drop it, correct the result, or set it aside is a design decision.

The exercise's `npm run stream` — ~50 thousand `task.completed` in one day (three times as many during working hours); 90% of the news arrives almost immediately, 8% 1–10 minutes late (mobile), 2% 1–6 hours late (offline laptops) — and, like Friday, a pipeline outage from 1 to 2, with that hour's news all arriving between 2 and 2:10:

```
   approach                                  first result p50/max      first error     worst hour  end error   dropped  updates
   batch (2 a.m., previous day)                   14.0 h / 25.0 h            0.10%          2.01%      0.10%        51        0
   stream, processing time                          0.0 s / 0.0 s           15.22%        100.86%     15.22%         0        0
   stream, event time, lateness 0                   2.7 s / 1.0 h            9.82%         99.78%      9.82%      4869        0
   stream, event time, lateness 1 min             1.0 min / 1.0 h            9.03%         90.43%      9.03%      4474        0
   stream, event time, lateness 10 min           10.0 min / 1.0 h            2.12%          2.88%      2.12%      1050        0
   stream, event time, lateness 1 h                 1.0 h / 2.0 h            1.87%          2.70%      1.87%       925        0
   stream 10 min + late corrections              10.0 min / 1.0 h            2.12%          2.88%      0.00%         0     1050
   stream 10 min + nightly batch                 10.0 min / 1.0 h            2.12%          2.88%      0.10%        51        0
```

("Error" = the sum of the differences between each hour's count and the true number, as a proportion of the day's total events; "worst hour" = by what percentage of its true number the most wrong hour is off.)

Read it row by row:

- **Batch:** 14 to 25 hours to get the result — but almost perfect. The 51 events that arrived after 2 a.m. are dropped (the laptops 6 hours late, from the day's last hours). This is exactly what finance wants.
- **Processing time:** immediate — and **100% wrong** in the worst hour. The outage hour is nearly zero, the next one nearly doubled. Thursday's dashboard, exactly. And look at the "error at end" column — the same: this error **is never fixed**, because it was put in the wrong hour at the moment of counting. (Without the outage — experiment 3 — the worst hour is 6.46%: on the slope at the start of working hours, events slip into the next hour.)
- **Event time, lateness 0 or 1 minute:** after the outage, as soon as 2 o'clock's ordinary news arrives, the watermark passes 2 — the 1 o'clock window closes, with a result near zero. Then the piled-up news arrives at a closed door: thousands dropped. Event time is the right idea, but if the watermark is too aggressive it's just as wrong as processing time.
- **Lateness 10 minutes:** the piled-up news arrives by 2:10, and the watermark hasn't closed the 1 o'clock window yet — the worst hour is 2.88%. The price: every hour's result is 10 minutes late. With 1 hour of lateness the error drops slightly (1.87%) but the delay is 1 hour — you have to stop somewhere.
- **"Max 1.0 h" — a subtle thing.** During the outage no news arrives at all, so the watermark doesn't advance — the 12 o'clock hour's result (finished before the outage) is stuck until 2. A watermark advances only by seeing events; when the source is silent, its clock stops too. (Real engines have an "idle source" rule for this — if nothing arrives for a while, advance by processing time — another estimate.)
- **The last two rows — both fast and correct in the end.** The first gives a result at 10 minutes, then sends a corrected result for each late event (1050 times) — error at the end 0%. The price: whoever reads this result (a dashboard, another service) has to handle "the result can change" — 7.4's idempotency and language of "set" are useful here (upsert per hour, not "add"). The second shows the fast stream's result, and the nightly batch replaces it with the correct number — two separate pipelines, the same calculation written twice.

This two-pipeline shape has an old name — the **Lambda architecture** (a batch layer and a speed layer, side by side). From criticism of it comes the **Kappa architecture**: stream only, and to fix something, replay the old events from the log (7.2's replay). Which is better depends on how well the team can run a stream engine — this debate hasn't been settled.

(A few tool names: for streams, Apache Flink, Kafka Streams, Spark Structured Streaming — these handle event time, watermarks and windows themselves. For batch, often SQL inside the warehouse, run on a schedule — anything from cron to a scheduler like Airflow.)

> **Trade-off Table — which path for a calculation**

| Path                                           | When the result        | How correct                                 | Operational effort                                | When                                                              |
| ---------------------------------------------- | ---------------------- | ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Directly on the production database            | Now                    | Correct                                     | Easy — but at production's cost (1.2)             | Small data, occasionally, at low-load times — and never regularly |
| On a read replica                              | Now (replica lag)      | Correct                                     | Easy; tug-of-war with replication on long queries | Medium, a first step                                              |
| Batch → column store (nightly/hourly)          | Hours to a day         | Correct (with whatever arrived by run time) | Low — scripts, SQL, a scheduler                   | Reports, billing, finance, most analytics                         |
| Stream, processing time                        | Seconds                | Wrong for late arrivals, never fixed        | Medium                                            | Only the system's own metrics (how many events were processed)    |
| Stream, event time + watermark (+ corrections) | Minutes (lateness)     | Nearly correct; correct with corrections    | High — state, watermarks, late data, an engine    | Live dashboards, alerts, fast decisions                           |
| Stream + nightly batch (Lambda)                | Minutes, correct later | Fast and approximate, correct at night      | Highest — two pipelines                           | Where both are needed and the team can handle it                  |

### 1.6 TaskFlow's decision

- **No regular analytics on the production Postgres.** For ad-hoc questions, one read replica, with a `statement_timeout`, so a mistaken query doesn't run for hours.
- **The analytics store: simple to start with.** Every night the previous day's data from the replica into Parquet files (split by day), and finance's reports with DuckDB. At TaskFlow's size (a few hundred thousand events a day) this is enough for years — one server, no new cluster. When the data grows or many people query at once, ClickHouse or a managed warehouse — filled in near real time via 7.5's CDC.
- **Billing and finance: batch, by event time, only.** The nightly run, by `occurredAt`, and at the end of the month "closed" after waiting a few days (for late laptops). Never bill from the stream's numbers.
- **The live dashboard: stream, event time, lateness 10 minutes, with corrections.** The dashboard's store upserts per hour (the number changes when a correction arrives). In the UI, a "still updating" mark on the current hour and the last 10 minutes' numbers — be honest that the number may still move.
- **Processing time only for the system's own health** — "how many events were processed per minute", consumer lag (7.2). Not in business numbers.

---

## 2. Interview Angle

**The "analytics" part of a design interview:** in almost any design question ("design a URL shortener", "design a news feed"), it comes towards the end — "we want to show the number of clicks / trending." A weak answer: "`COUNT(*)` in the database." A good answer: every event is an event (in a log), then two paths — live numbers in a stream (windows, approximate is fine — or an approximate data structure like Lesson 10.2's HyperLogLog), and correct reports in batch, in a column store. And why not analytics on the production database — in one sentence (shared resources, row store).

**"Batch or stream?"** — Start the answer with a question: "how quickly is the result needed, and how much error from late-arriving data is acceptable?" Then two examples — one where it's batch (billing), one where it's stream (a fraud alert) — and the one in between (a dashboard). Don't fall into the trap of "stream is always better because it's faster"; running a stream is much harder.

**"What's the difference between event time and processing time, and how will you handle late data?"** — A senior-level question. The definitions, a real reason (mobile offline), the watermark, and the three options (drop, correct, set aside and fix in batch). Bonus: a watermark stops when the source is silent.

**In real production:** the best-known incident is exactly Tuesday's — someone runs "just one query" on production. Prevention is more organisational than technical: a separate place for analysts that they actually want to use, a separate user and a `statement_timeout` on production, and a list of where the dashboards' queries go. And on the stream side, the most common mistake: processing-time numbers reaching the business — nobody notices until a hole shows up in the graph after an outage.

---

## 3. Key Takeaway

- **OLTP** (few rows, indexes, ms, many users) and **OLAP** (aggregates over hundreds of thousands of rows, a few columns, seconds, few people) — the same SQL, opposite shapes
- Both in one database means shared CPU, disk and cache: with four analytics queries the board's p99 went 1.1 ms → 68.5 ms, throughput 15 thousand → 4 thousand. A read replica is a good first step, but it's a row store too, and long queries tug against replication
- A **column store** reads only the columns needed, compresses well, and is vectorized — ~12 times faster on the same CPUs (257 ms → 21 ms); but it's bad at writing by row and reading whole rows — so OLTP in a row store, OLAP in a column store. An index speeds up one question, not every question, and every write pays for it
- **Batch**: late, but easily correct and easily rerun; **stream**: fast, but the pain of state, time and late data. Two questions: how fast, and how correct, by when
- **Event time** (when it happened) vs **processing time** (when it arrived) — counting by processing time is 100% wrong in the worst hour after an outage, and is never fixed
- A **watermark** is an estimate: too aggressive and late data gets dropped (nearly 5 thousand at lateness 0), too loose and results are late; when the source is silent the watermark stops too. Late data: drop, correct (downstream upsert), or fix in the nightly batch — wanting both fast and correct costs two results or two pipelines

---

## 4. New Terms (Glossary)

| Term                             | Meaning                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OLTP**                         | The application's everyday work — few rows, via indexes, in ms, many users at once                                                                      |
| **OLAP**                         | Analysis questions — aggregates over a huge number of rows, a few columns, running seconds to minutes                                                   |
| **Column Store**                 | Storing data separately by column — a question reads only the columns it needs; good compression, fast for analytics, bad for OLTP                      |
| **Batch Processing**             | Processing a fixed, bounded set of data (e.g. all of yesterday's) at once — at set intervals                                                            |
| **Stream Processing**            | Processing data continuously as it arrives — no end, the result is always in progress                                                                   |
| **Event Time / Processing Time** | When the event actually happened vs when it reached the system — the gap between them ranges from ms to hours                                           |
| **Watermark**                    | An estimate that "events earlier than this event time will no longer arrive" (largest event time seen − allowed lateness); the signal to close a window |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. Where will finance's monthly usage report run from now on? Three options — (a) a production read replica, (b) nightly Parquet + DuckDB, (c) CDC → ClickHouse — for each, say: how stale the data is, the impact on production, what new things have to be run, and what can break. Which would you choose at TaskFlow's size — and which number would make you move to the next one?
2. Four of TaskFlow's numbers: (a) "how many users are online right now" (shown in the header), (b) a workspace's monthly completed tasks (billing), (c) an alert to the security team when more than 500 tasks are deleted from one workspace in one minute, (d) a graph of "how many tasks were completed this week" for each project. For each: batch or stream, event time or processing time, how much lateness, and what happens with late data.
3. The live dashboard's stream behaves strangely for one small project: only one person works on that project at night, and their hour's number shows up at 9 a.m. the next day. Why? (Which column of which row in the exercise does it match?) Give two solutions and the price of each.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

| Option                       | How stale the data    | Impact on production                                             | New things to run                            | What can break                                                                                         |
| ---------------------------- | --------------------- | ---------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| (a) Read replica             | Seconds (replica lag) | The primary is spared; tug-of-war with the replica's replication | Nothing (the replica exists)                 | Long queries cancelled, or bloat on the primary with `hot_standby_feedback`; still slow on a row store |
| (b) Nightly Parquet + DuckDB | One day               | Reading from the replica once a night — almost nothing           | One nightly job; space for the files         | If the job fails there's no data for yesterday (needs an alert); a schema change breaks the export     |
| (c) CDC → ClickHouse         | Seconds to minutes    | Reading the WAL — little, but the replication slot risk (7.5)    | Debezium/Kafka Connect, a ClickHouse cluster | A stuck slot fills the primary's disk; operations for two new systems                                  |

The choice: at TaskFlow's size, **(b)**. Finance's question is monthly — data one day old is perfectly fine; almost no impact on production; no new cluster. The signals to move to the next one: someone regularly wants "today's" numbers (freshness), or DuckDB's file is so big that queries are slow on one machine, or many people query at once (DuckDB is a library inside one process — not a server for many users).

**Question 2:**

- **(a) Online users:** stream, **processing time** is fine — the question itself is "right now", and an answer a few seconds old is fine; approximate (HyperLogLog, Lesson 10.2) is fine. Late data is irrelevant — an old heartbeat means they aren't online now.
- **(b) Billing:** batch, **event time**, and at the end of the month closed after waiting a few days; late data arriving after that is handled as a correction in the next month (written down as policy). Never the stream's numbers.
- **(c) The delete alert:** stream — delay means the damage keeps going. Event time, but small lateness (30 seconds–1 minute) — there's no sense in waiting 10 minutes to alert. Late data: alert even if it's late (a correction) — an alert late is better than no alert. And accept some false alerts (false positives).
- **(d) The weekly graph:** an hour or a day old is fine — **batch** (once an hour, event time), or the stream with 10 minutes of lateness + corrections. Both work; for simplicity, the hourly batch.

**Question 3:** A watermark advances only by seeing new events. If the watermark is separate for each project (or no more events arrive in that project's partition at night), then after the lone night worker's last event nothing more arrives — the "next" event that would close that hour's window arrives at 9 a.m., when the others start work. The exercise's "time to first result max 1.0 h" — the source silent during the outage, the watermark stopped — is exactly the same cause, on a small scale.

Solutions:

- **An idle-source rule** — if a source (partition) is silent for a while (say 5 minutes), drop it from the watermark calculation, or advance its watermark by processing time. The price: if it was actually just late (offline), its next event becomes late data — the correct-or-drop question again.
- **A watermark across the whole stream, not per partition** (advancing with all projects' events together) — other projects' events move the clock forward. The price: events from a slow or lagging partition become late more often.
- (An alternative: a processing-time timer — "emit the result 15 minutes after the window ends, whatever the watermark" — a maximum wait alongside the lateness.)

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (Postgres in Docker; DuckDB as an npm library; and a deterministic stream simulation)

> **Ready to run in the repo:** [`exercises/lesson-7.6-batch-stream-olap/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.6-batch-stream-olap) — `docker compose up -d --wait && npm install && npm run seed`, then `npm run olap` and `npm run stream`. The full setup, acceptance criteria, experiments and teardown are in that folder's `README.md`.

`seed` builds 3 million `task_events` from the same formula in two places — Postgres (limited to 2 CPUs) and a DuckDB file — and checks that the analytics question's results match. `olap` measures the board's query alone and together with finance's query, then the same question on the two engines. `stream` generates a day's events with delays and an outage, and counts the hourly numbers with eight approaches.

**Honest note:** verified by running it in the sandbox with Postgres 17 and DuckDB 1.5.5: `tsc --noEmit` is clean; `seed`'s checksums matched on both engines; `olap` several times — every time the OLTP p99 rose more than tenfold while analytics ran, and running alone DuckDB was ~10–12 times faster (the numbers will vary by machine); `stream` run twice with identical output. The README's experiments 1–4 were run (number 2 with the index, then dropping it); 5 is a code-changing task for you. DuckDB was tied to 2 threads (by default it takes all of the machine's cores) — to keep the comparison honest. The compression (28 MB vs 242 MB) is for formula-generated data — not this good on real data. `stream` isn't a real stream engine, just a small imitation of the watermark's rules. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Tuesday again:** run `npm run olap`. By how many times did the OLTP p99 rise on your machine? Then with `ANALYTICS_LOOPS=1` and `ANALYTICS_LOOPS=8` — make a small table (number of analytics queries → OLTP p99, throughput). From which number would you say "analytics is banned on production"?

2. **Why it's fast:** run the analytics query on Postgres with `EXPLAIN (ANALYZE, BUFFERS)` (`docker compose exec postgres psql -U taskflow`), and on DuckDB with `EXPLAIN ANALYZE` (a small script, or open `data/analytics.duckdb` with the `duckdb` CLI if you have it). Put the two plans side by side and write one paragraph — who read how much data, and why.

3. **The limit of indexes** (experiment 2): the index made analytics faster — now write finance's second question ("average `duration_ms` per project per week") and run it on both engines, with the index in place. What happened on Postgres? On DuckDB? Then drop the index.

4. **Choose the dashboard's lateness:** run `npm run stream` and `OUTAGE_HOUR=-1 npm run stream`, then add a row with 30 minutes of lateness in `stream.ts` (experiment 5). Decide which lateness TaskFlow's live dashboard will use, and whether with corrections — with two numbers side by side — and what you'll show the user in the UI.

5. **Design part:** a one-page design doc for TaskFlow's analytics: (a) which question runs where (production, replica, analytics store) — with at least five questions; (b) how data gets to the analytics store — batch or CDC, how often, who notices a failure; (c) for each number, event time or processing time, and the late-data policy; (d) which number would make you move from DuckDB to ClickHouse/a warehouse.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (complete, including exit challenges), 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
Current: 7.6 — Batch vs Stream, OLTP vs OLAP (the last lesson of Module 7)
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; outbox → relay → Redis Streams, idempotent consumers, BullMQ
jobs (retry, DLQ, separate queues, backpressure); analytics: no regular analytics on production
(ad-hoc on a replica with statement_timeout), nightly replica → Parquet + DuckDB (finance, billing —
batch, event time, closed a few days after month end), live dashboard on the stream (event time,
lateness 10 minutes, upsert with corrections), processing time only in system metrics; when it
grows, CDC → ClickHouse
Terms learned (Module 7): Synchronous/Asynchronous Processing, Critical Path, Temporal
Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog, Message
Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log / Offset,
Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF, Idempotent Consumer, Retry Storm, Jitter,
Poison Message, Dead Letter Queue, Backpressure, Load Shedding, Command, Event,
Choreography, Event-carried State Transfer, Dual Write, Transactional Outbox, Change Data
Capture, OLTP, OLAP, Column Store, Batch Processing, Stream Processing, Event Time /
Processing Time, Watermark
Weak spots: [where you got stuck — fill this in yourself]
Next: Module 7 Exit Challenge
=======================
```

---

## 8. Next Step

Run the exercise and send it over — especially your table in #1 and your design doc in #5. This is the last lesson of Module 7. When you are ready, write `next` — we'll go to the **Module 7 Exit Challenge**: a mini design challenge (Tier 3) where the whole module is needed together — synchronous vs async, queue vs log, BullMQ jobs, idempotency and retry, the outbox, and the path for analytics — in a realistic scenario; a "you should be able to do these" checklist; and recommendations for books, videos and projects. Then Module 8 — Storage Systems: so far data has meant database rows and queue messages; now files — the attachments, images and videos users upload — where to keep them, how big files get uploaded, and how to search inside them.
