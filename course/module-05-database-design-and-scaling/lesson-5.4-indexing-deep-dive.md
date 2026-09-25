# Lesson 5.4 — Indexing Deep Dive: কেন Query দ্রুত বা ধীর হয়

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 2.5):** Offset pagination (`LIMIT 20 OFFSET 100000`) বড় offset এ কেন ধীর হয়ে যায়, আর cursor pagination সেটা কীভাবে এড়ায়?

**Prerequisite:** Lesson 5.2 (Schema), Lesson 5.3 (Page, B-tree)

**তুমি এই lesson শেষে পারবে:**

1. `EXPLAIN ANALYZE` এর output পড়ে বলতে পারবে query টা কোন পথে চলছে (Seq Scan, Index Scan, Bitmap, Index Only Scan), কতগুলো page ছুঁয়েছে, আর কোথায় সময় যাচ্ছে
2. একটা query দেখে সঠিক index design করবে — composite index এ column এর ক্রম, partial, expression আর covering index সহ
3. বুঝবে কখন index থাকলেও Postgres সেটা নেয় না, আর প্রতিটা index লেখার সময় কত দাম নেয় — মেপে

**Tier:** 1 — Runnable Code

---

## ০. TaskFlow এখন কোথায়

TaskFlow এ এখন ১০ লাখ task। Express এর response time log এ তিনটা endpoint বারবার উপরে উঠে আসছে:

1. `GET /me/tasks` — "আমার খোলা task" — প্রতিটা page load এ ডাকা হয়
2. `GET /projects/:id/feed` — project এর সর্বশেষ ২০টা task
3. `GET /reports/daily` — "আজ কতগুলো task তৈরি হয়েছে", আর title দিয়ে একটা search

Team এর একজন একটা সহজ সমাধান দিল: "প্রতিটা column এ একটা index দিয়ে দাও, সব দ্রুত হয়ে যাবে।" একজন senior সাথে সাথে বলল — না।

কেন না? Lesson 5.3 এ তুমি দেখেছ B-tree কীভাবে ৪টা page পড়ে একটা row খুঁজে পায়। কিন্তু সেটা ছিল সবচেয়ে সহজ case — primary key দিয়ে একটা row। বাস্তব query তে থাকে একাধিক শর্ত, sort, function, range। আজ আমরা দেখব index **কখন** কাজ করে, **কখন করে না**, আর কেন "সব column এ index" একটা খারাপ ধারণা।

এবং আজ কোনো দাবি অনুমান থেকে না। Exercise এর lab ১০ লাখ row এর উপর প্রতিটা ধাপ চালিয়ে মাপে — নিচের সব সংখ্যা সেখান থেকে।

---

## ১. Theory

### ১.১ `EXPLAIN ANALYZE` পড়তে শেখা

Query ধীর কেন — অনুমান না করে database কেই জিজ্ঞেস করা যায়। `EXPLAIN` বলে Postgres query টা **কীভাবে চালানোর পরিকল্পনা করছে**; `EXPLAIN ANALYZE` আসলেই query টা চালিয়ে বলে **আসলে কী হলো**; আর `BUFFERS` যোগ করলে বলে কতগুলো page ছুঁয়েছে।

**Query planner** — database এর যে অংশ একটা query চালানোর সম্ভাব্য সব পথের খরচ অনুমান করে সবচেয়ে সস্তাটা বেছে নেয়। অনুমান করে table এর statistics দিয়ে (কত row, কোন মান কত ঘন ঘন), যেটা `ANALYZE` command (বা autovacuum) আপডেট করে।

TaskFlow এর feed query, শুধু `(projectId)` এ index থাকা অবস্থায় — আসল output:

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

(পরিষ্কার রাখতে `cost=...` অংশ বাদ দেওয়া হয়েছে — ওটা planner এর অনুমান।)

**পড়ার নিয়ম: ভেতর থেকে বাইরে, নিচ থেকে উপরে।** সবচেয়ে ভেতরের node আগে চলে, তার output উপরের node এ যায়:

1. **Bitmap Index Scan** — index থেকে project 7 এর ৫০০টা row এর ঠিকানা বের করল
2. **Bitmap Heap Scan** — সেই ঠিকানাগুলো page অনুযায়ী সাজিয়ে table থেকে ৫০০টা row আনল (`Heap Blocks: exact=500` — ৫০০টা আলাদা page!)
3. **Sort** — ৫০০টা row কে `createdAt` দিয়ে সাজাল
4. **Limit** — প্রথম ২০টা রাখল, বাকি ৪৮০টা ফেলে দিল

সমস্যাটা এখন চোখে পড়ছে: **২০টা row এর জন্য ৫০০টা আনা, সাজানো, আর ফেলে দেওয়া।** ১.৩ এ এটা ঠিক করব।

সবচেয়ে সাধারণ node গুলো:

| Node                                     | মানে                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Seq Scan**                             | পুরো table শুরু থেকে শেষ পর্যন্ত পড়া                                                             |
| **Index Scan**                           | Index এ খুঁজে, প্রতিটা match এর জন্য table এ গিয়ে row আনা                                        |
| **Index Only Scan**                      | উত্তরের সব column index এই আছে — table এ যেতেই হয় না                                             |
| **Bitmap Index Scan → Bitmap Heap Scan** | আগে index থেকে সব ঠিকানা জড়ো করা, তারপর page এর ক্রমে table পড়া — অনেক match এর জন্য            |
| **Sort**                                 | Memory তে (বা disk এ) সাজানো — বড় হলে দামি                                                       |
| **Gather**                               | কয়েকটা worker process এ ভাগ করে চালানো (parallel query) — সাধারণত বড় Seq Scan এর উপরে দেখা যায় |

যে তিনটা জিনিস সবার আগে খুঁজবে:

- **বড় table এ Seq Scan** — প্রায়ই একটা index অনুপস্থিত
- **`rows` এর অনুমান আর আসলের বিশাল পার্থক্য** — planner এর statistics পুরনো বা ভুল; সে ভুল তথ্য দিয়ে সিদ্ধান্ত নিচ্ছে
- **Sort এর নিচে অনেক row, উপরে Limit এ অল্প** — ঠিক উপরের মতো; সাধারণত একটা ভালো composite index এর সুযোগ

**Sequelize এর সাথে:** Sequelize কী SQL বানাচ্ছে দেখতে connection এ `logging: console.log` দাও, সেই SQL টা `psql` এ `EXPLAIN (ANALYZE, BUFFERS)` এর পরে বসাও। আর একটা সতর্কতা: `EXPLAIN ANALYZE` query টা **সত্যিই চালায়**। `DELETE` বা `UPDATE` এ চালালে data সত্যিই বদলাবে — তাই এমন query তে `BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;` এর ভেতরে রাখো।

### ১.২ প্রথম ধাপ — Foreign Key এ Index, আর Partial Index

Lesson 5.2 এ বলেছিলাম Postgres foreign key column এ নিজে index বানায় না। `/me/tasks` এর query:

```sql
SELECT id, title, status FROM tasks WHERE "assigneeId" = 42 AND status <> 'done'
```

Lab এর ধাপ ১ (আমার মেশিনে, সব page memory তে গরম, ৫ বারের median):

```
index                                সময়      pages   plan
index নেই                        25.76 ms    8,399   Gather → Seq Scan
(assigneeId)                      0.15 ms      203   Bitmap Heap Scan → Bitmap Index Scan   (index: 6728 kB)
(assigneeId) WHERE status <> done 0.07 ms       70   Bitmap Heap Scan → Bitmap Index Scan   (index: 2072 kB)
```

Index ছাড়া পুরো table (৮,৩৯৯টা page) পড়া। একটা সাধারণ index দিলে ~১৭০ গুণ দ্রুত।

তৃতীয় লাইনটা দেখো। TaskFlow এ ৭০% task "done", আর এই query কখনো done task চায় না। তাহলে done task গুলো index এ রাখার মানে কী?

**Partial index** — শুধু একটা শর্ত মানা row গুলোর জন্য index। এখানে `WHERE status <> 'done'` — তাই index এর আকার **৬.৭ MB থেকে ২.১ MB**, আর query আরও কম page ছোঁয়। ছোট index মানে buffer pool এ কম জায়গা, আর প্রতিটা "done" task insert বা update এ এই index বদলাতেই হয় না।

Sequelize migration এ (lab এর code থেকে):

```typescript
setup: () =>
	qi.addIndex('tasks', {
		fields: ['assigneeId'],
		name: 'tasks_assignee_open',
		where: { status: { [Op.ne]: 'done' } }
	}),
```

একটা শর্ত: planner partial index তখনই নেয় যখন query এর `WHERE` থেকে প্রমাণ করা যায় যে দরকারি সব row index এ আছে। Query থেকে `status <> 'done'` বাদ দিলে? সেটা exercise এর experiment ৪ — আগে অনুমান করো।

### ১.৩ Composite Index — Column এর ক্রমই সব

এবার feed query:

```sql
SELECT id, title, "createdAt" FROM tasks
WHERE "projectId" = 7 ORDER BY "createdAt" DESC LIMIT 20
```

**Composite index** — একাধিক column মিলিয়ে একটা index। B-tree টা প্রথমে প্রথম column দিয়ে sorted, প্রথম column সমান হলে দ্বিতীয় দিয়ে, এভাবে।

সবচেয়ে ভালো উপমা হলো পুরনো দিনের **টেলিফোন ডিরেক্টরি**: আগে পদবি অনুযায়ী সাজানো, একই পদবির ভেতরে নাম অনুযায়ী। "আহমেদ, করিম" খোঁজা খুব সহজ। "সব আহমেদ" খোঁজাও সহজ। কিন্তু "সব করিম, যেকোনো পদবি" খুঁজতে হলে পুরো বই পড়তে হবে।

Lab এর ধাপ ২ — একই দুটো column, ভিন্ন ক্রম:

```
index                           সময়      pages   plan
index নেই                    20.46 ms    8,473   Limit → Gather Merge → Sort → Seq Scan
(projectId)                   0.42 ms      504   Limit → Sort → Bitmap Heap Scan → Bitmap Index Scan
(createdAt, projectId) উল্টো   0.47 ms      188   Limit → Index Scan Backward
(projectId, createdAt)        0.04 ms       23   Limit → Index Scan Backward
```

`(projectId, createdAt)` এ index এর ভেতরে project 7 এর সব entry পাশাপাশি, আর **ইতিমধ্যেই `createdAt` অনুযায়ী সাজানো**। Postgres শুধু project 7 এর অংশের শেষ মাথায় গিয়ে পেছনের দিকে (`Backward`) ২০টা পড়ে থেমে যায়। কোনো Sort node নেই, ৫০০টা row আনা নেই — ২৩টা page। শুধু `(projectId)` এর চেয়ে ১০ গুণ দ্রুত।

আসল output এও দেখো কী সহজ:

```
Limit  (actual time=0.024..0.040 rows=20 loops=1)
  ->  Index Scan Backward using tasks_project_created on tasks  (actual ... rows=20 loops=1)
        Index Cond: ("projectId" = 7)
Execution Time: 0.053 ms
```

`rows=20` — ঠিক যতগুলো দরকার ততগুলোই পড়া হয়েছে।

উল্টো ক্রম `(createdAt, projectId)` খুব খারাপ দেখাচ্ছে না — কিন্তু সেটা **ভাগ্যের জোরে**। এখানে project 7 এর task সময় জুড়ে সমানভাবে ছড়ানো, তাই সবচেয়ে নতুন থেকে পেছনে পড়তে থাকলে দ্রুতই ২০টা পাওয়া যায়। যে project এর সর্বশেষ task এক বছর আগের, তার জন্য এই index কে এক বছরের সব project এর সব task পার হতে হবে। (Exercise এর experiment ১ এ নিজে দেখবে।)

**Composite index design এর নিয়ম:**

```
১. = (সমান) দিয়ে filter হওয়া column গুলো আগে        ── "projectId" = 7
২. তারপর range (<, >, BETWEEN) বা ORDER BY এর column  ── "createdAt"
```

**Spaced repetition এর সাথে যোগ:** Lesson 2.5 এর cursor pagination মনে করো — পরের page এর জন্য `WHERE "projectId" = 7 AND "createdAt" < :cursor ORDER BY "createdAt" DESC LIMIT 20`। ঠিক এই `(projectId, createdAt)` index দিয়ে এটা প্রতিটা page এ একই রকম দ্রুত — সে সরাসরি cursor এর জায়গায় গিয়ে ২০টা পড়ে। `OFFSET 100000` দিলে Postgres কে প্রথম ১ লাখ entry পার হয়ে ফেলে দিতে হয় — index থাকলেও। এই কারণেই cursor pagination scale করে।

### ১.৪ Leftmost Prefix — দ্বিতীয় Column একা কাজে আসে না

`/reports/daily` এর query — শুধু সময় দিয়ে filter, কোনো project ছাড়া:

```sql
SELECT count(*) FROM tasks WHERE "createdAt" >= '2026-09-24'
```

Lab এর ধাপ ৩:

```
index                     সময়      pages   plan
(projectId, createdAt) 25.11 ms    8,399   Aggregate → Gather → Aggregate → Seq Scan
(createdAt)             0.15 ms        8   Aggregate → Index Only Scan
```

`(projectId, createdAt)` index এ `createdAt` আছে — তবু Postgres পুরো table পড়ল। টেলিফোন ডিরেক্টরি দিয়ে "সব করিম" খোঁজার মতো: `createdAt` এর মান index এ ২০০০টা আলাদা জায়গায় ছড়ানো (প্রতিটা project এর ভেতরে একটা করে)।

**Leftmost prefix rule** — একটা composite index `(a, b, c)` কার্যকরভাবে ব্যবহার হয় শুধু বাম দিক থেকে টানা column গুলোর শর্ত দিয়ে: `a`, `a + b`, অথবা `a + b + c`। শুধু `b` বা শুধু `c` দিয়ে না।

**সৎ সতর্কতা — version বদলালে গল্প একটু বদলায়:** উপরের ফল Postgres 17 (lab এর version) এর। Postgres 18 এ B-tree **skip scan** যোগ হয়েছে: প্রথম column এর প্রতিটা আলাদা মানের জন্য index এ আলাদা করে "লাফ" দিয়ে খোঁজা। একই data আর একই `(projectId, createdAt)` index দিয়ে Postgres 18.6 এ চালিয়ে দেখা হয়েছে — Seq Scan এর বদলে সে skip scan নিল (`Index Searches: 1996`, প্রায় প্রতিটা project এর জন্য একবার), সময় **~১৫ ms**, প্রায় ৬,০০০ page। Seq Scan (২৫ ms) এর চেয়ে ভালো — কিন্তু আলাদা `(createdAt)` index (০.১৫ ms, ৮ page) এর চেয়ে প্রায় **১০০ গুণ ধীর**। প্রথম column এ আলাদা মান যত কম (যেমন ৪টা status), skip scan তত ভালো কাজ করে। তাই নিয়মটার আধুনিক রূপ: **leftmost prefix ছাড়া composite index হয় কাজে আসে না, নয়তো আসে অনেক কম দক্ষতায়** — গরম query এর জন্য তার নিজের উপযুক্ত index লাগবে। আর নিজের version এ সবসময় `EXPLAIN` দিয়ে দেখো।

### ১.৫ Index যেভাবে ভাঙে — Function, আর LIKE

**Column এর উপর function।** "১ সেপ্টেম্বরে তৈরি task" — স্বাভাবিকভাবে লেখা:

```sql
WHERE "createdAt"::date = '2026-09-01'          -- ৩৩.৫৪ ms, ৮,৩৯৯ pages, Seq Scan
WHERE "createdAt" >= '2026-09-01'
  AND "createdAt" <  '2026-09-02'               --  ০.১৬ ms,     ৮ pages, Index Only Scan
```

একই প্রশ্ন, একই `(createdAt)` index — ২০০ গুণ পার্থক্য। কারণ index টা `createdAt` এর মান দিয়ে sorted, `createdAt::date` এর মান দিয়ে না। Column এর উপর কোনো function বা cast বসালে Postgres কে **প্রতিটা row এ** সেটা হিসাব করে দেখতে হয় — index এর sorted ক্রম আর কাজে আসে না। সমাধান সাধারণত query টা এমনভাবে লেখা যাতে column একা থাকে, আর হিসাবটা অন্য দিকে যায় (এখানে range)।

যখন query বদলানো যায় না — যেমন case-insensitive search `lower(title) = 'fix bug #23'`:

```
(title) + lower(title) = …          67.23 ms   8,399 pages   Seq Scan
(lower(title)) — expression index    0.03 ms       4 pages   Index Scan
```

**Expression index** — একটা column এর মানের বদলে একটা expression এর ফলাফল দিয়ে বানানো index: `CREATE INDEX ON tasks (lower(title))`। Query তে হুবহু একই expression থাকলে planner এটা ব্যবহার করে।

**LIKE।** Lab এর ধাপ ৭, `(title)` এ index থাকা অবস্থায়:

```
(title) + LIKE '%bug%'                28.25 ms   8,399 pages   Seq Scan
(title) + LIKE 'Fix bug #1234%'       23.52 ms   8,399 pages   Seq Scan
(title text_pattern_ops) + একই LIKE    0.03 ms       5 pages   Index Only Scan
```

- `'%bug%'` — শুরুতে `%` মানে "মাঝখানে যেকোনো জায়গায়"। Sorted ক্রম দিয়ে এটা খোঁজা অসম্ভব — B-tree এখানে কখনোই কাজে আসবে না। এর জন্য আলাদা ধরনের index লাগে (Lesson 8.3 এর inverted index, বা Postgres এর `pg_trgm`)।
- `'Fix bug #1234%'` — শুরুর অংশ নির্দিষ্ট, তাই তত্ত্বে B-tree পারার কথা। কিন্তু পারল না! কারণ database এর collation `en_US.utf8` — সেখানে string এর sort ক্রম ভাষার নিয়মে, byte এর ক্রমে না, আর তাতে prefix search নিরাপদ না। `text_pattern_ops` দিয়ে index বানালে byte ক্রমে sorted হয়, আর prefix search কাজ করে। এটা একটা বাস্তব ফাঁদ — Docker এর default Postgres image এ ঠিক এই collation।

### ১.৬ Selectivity — Index আছে, তবু Postgres নেয় না

**Selectivity** — একটা শর্ত table এর কত ভাগ row বাছাই করে। "blocked" (১%) উঁচু selectivity, "done" (৭০%) খুবই নিচু।

Lab এর ধাপ ৫, একই `(status)` index, `SELECT id, title ... WHERE status = ...`:

```
(status) + status = 'done'       89.11 ms   8,399 pages   Seq Scan
(status) + status = 'blocked'     5.60 ms   5,810 pages   Bitmap Heap Scan → Bitmap Index Scan
```

"done" এর জন্য Postgres index টা ছুঁয়েও দেখেনি। এটা ভুল না — এটা planner এর **সঠিক** সিদ্ধান্ত। ৭ লাখ row এর জন্য index দিয়ে গেলে ৭ লাখ বার index থেকে table এ লাফাতে হবে, এলোমেলো ক্রমে। পুরো table একবারে, ক্রমানুসারে পড়া তার চেয়ে সস্তা। (Planner কে জোর করে index নিতে বাধ্য করলে কী হয় — exercise এর experiment ৩।)

দ্বিতীয় লাইনে একটা বড় শিক্ষা লুকিয়ে আছে: **মাত্র ১% row, কিন্তু ৫,৮১০টা page — table এর প্রায় ৭০%!** কেন? কারণ ১০,০০০টা "blocked" task পুরো table জুড়ে ছড়ানো; প্রায় প্রতিটা page এ একটা-দুটো করে। প্রতিটা row আনতে তার পুরো page পড়তে হয় (Lesson 5.3)। তাই selectivity মাপতে হয় **কতগুলো page ছোঁয়া লাগবে** দিয়ে, শুধু কতগুলো row দিয়ে না। Planner এটা হিসাব করে — এর জন্য সে row এর physical ক্রম আর column এর মানের মধ্যে সম্পর্কের একটা statistic রাখে।

**TaskFlow এর জন্য মানে:** `status` এ একা একটা index প্রায় অর্থহীন — যে মানগুলো বেশিরভাগ query চায় (done/todo), সেগুলোতে planner এটা নেবে না। Status এর আসল জায়গা হলো composite index এর ভেতরে (`(projectId, status)` — Lesson 5.2), অথবা partial index এর শর্তে (১.২)।

### ১.৭ Covering Index — Table এ না গিয়েই উত্তর

Feed query এর `(projectId, createdAt)` index এ ২৩টা page লাগছিল: কয়েকটা index page, আর প্রতিটা row এর `id` আর `title` আনতে table এর ~২০টা page। যদি সেই column গুলোও index এ থাকত?

**Covering index** — এমন index যেটায় query এর দরকারি **সব** column আছে, তাই table এ না গিয়েই উত্তর দেওয়া যায় (plan এ **Index Only Scan**)। Postgres এ `INCLUDE` দিয়ে বাড়তি column যোগ করা যায় — সেগুলো sort এর অংশ না, শুধু leaf এ সাথে রাখা:

```sql
CREATE INDEX tasks_project_created_cover ON tasks ("projectId", "createdAt") INCLUDE (id, title)
```

```
(projectId, createdAt)                       0.04 ms   23 pages   Limit → Index Scan Backward
(projectId, createdAt) INCLUDE (id, title)   0.04 ms    4 pages   Limit → Index Only Scan Backward
```

সময় একই দেখাচ্ছে — কারণ lab এ সব page memory তে গরম। কিন্তু pages ২৩ থেকে ৪। Production এ যেখানে সব page buffer pool এ থাকে না, প্রতিটা বাদ যাওয়া page হয়তো একটা disk read বাঁচানো। **এই কারণেই `pages` কলামটা প্রায়ই সময়ের চেয়ে সৎ মাপ।**

দুটো সতর্কতা:

- Index বড় হয় — `title` এর মতো লম্বা column INCLUDE করলে বেশি। প্রতিটা covering index একটা নির্দিষ্ট, গরম query এর জন্য; সবখানে না।
- Postgres এ Index Only Scan এর জন্য table এর **visibility map** আপডেট থাকতে হয় — যেটা VACUUM করে। Lesson 5.3 এর MVCC মনে আছে? একটা row এর version সব transaction এর কাছে দৃশ্যমান কিনা, সেটা নিশ্চিত না হলে Postgres কে table এ গিয়ে দেখতে হয়। তাই exercise এর seed শেষে `VACUUM ANALYZE` চালায়।

### ১.৮ দাম — প্রতিটা Index লেখাকে ধীর করে

এখন সেই senior এর "না" এর উত্তর। Index হলো **আরেকটা sorted কপি** — Lesson 5.2 এর denormalization এর মতোই, আর তার দাম লেখার সময় দিতে হয়। প্রতিটা `INSERT` কে প্রতিটা index এর B-tree তে সঠিক জায়গায় entry বসাতে হয় (Lesson 5.3), আর সেটার জন্যও WAL লিখতে হয়।

Exercise এর `npm run writecost` — ২ লাখ row insert, primary key এর বাইরে ০, ৩ আর ৬টা index:

```
index (primary key বাদে)   সময়               WAL        index এর মোট আকার
 0টা                        418 ms (1.0x)     31.7 MB      4.3 MB
 3টা                       1218 ms (2.9x)     77.9 MB     21.5 MB
 6টা                       1999 ms (4.8x)    126.9 MB     43.4 MB
```

ছয়টা index মানে insert প্রায় **৫ গুণ ধীর**, আর WAL **৪ গুণ** — Lesson 5.3 এর write amplification, সরাসরি মাপা। আর মনে রাখো, WAL বেশি মানে replica তে পাঠানোর data ও বেশি (Lesson 5.7)।

**তাহলে কোন index রাখবে?** নিয়মটা Lesson 5.1 থেকেই আসে: **index বানাও query থেকে, column থেকে না।** প্রতিটা index এর পেছনে একটা নির্দিষ্ট, গুরুত্বপূর্ণ access pattern থাকা উচিত। আর যেগুলো কেউ ব্যবহার করে না, সেগুলো খুঁজে বের করার উপায় আছে — Postgres এর `pg_stat_user_indexes` view এর `idx_scan` column বলে প্রতিটা index কতবার ব্যবহার হয়েছে। মাসের পর মাস `0` মানে সেই index শুধু লেখাকে ধীর করছে।

**Production এ index যোগ করার একটা নিয়ম:** সাধারণ `CREATE INDEX` চলার পুরো সময় table এ লেখা আটকে রাখে — ১০ লাখ row এ কয়েক সেকেন্ড, ১০ কোটিতে অনেক মিনিট। চালু system এ `CREATE INDEX CONCURRENTLY` ব্যবহার করো (Sequelize এর `addIndex` এ `concurrently: true`)। এটা ধীর, কিন্তু লেখা আটকায় না। একটা ফাঁদ: এটা transaction এর ভেতরে চলে না, তাই migration টা সেভাবে লিখতে হয়। Zero-downtime migration এর পুরো গল্প Lesson 10.6 এ।

> **Trade-off Table — Index এর ধরন**

| ধরন                  | কখন                                                   | দাম / সতর্কতা                                        |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Single-column        | একটা column দিয়ে filter, যথেষ্ট selective            | নিচু selectivity তে planner নেবে না                  |
| Composite            | একাধিক শর্ত, বা filter + ORDER BY                     | Column এর ক্রম ভুল হলে প্রায় অকেজো; leftmost prefix |
| Partial              | Query সবসময় একটা নির্দিষ্ট অংশ চায় (খোলা task)      | Query তে একই শর্ত থাকতে হবে                          |
| Expression           | Query তে function বা expression (`lower(title)`) থাকে | Query তে হুবহু একই expression লাগবে                  |
| Covering (`INCLUDE`) | খুব গরম query, table এ যাওয়া এড়াতে                  | Index বড় হয়; VACUUM লাগে                           |
| যেকোনো index         | —                                                     | প্রতিটা write ধীর, বেশি WAL, বেশি disk ও memory      |

---

## ২. Interview Angle

**"একটা query ধীর। তুমি কী করবে?"** — backend interview এর সবচেয়ে সাধারণ প্রশ্নগুলোর একটা। ভালো উত্তর একটা **প্রক্রিয়া**, একটা অনুমান না:

1. **মাপো** — কোন query, কত ধীর, কত ঘন ঘন চলে (একটা ৫০০ ms query দিনে একবার চলা আর ৫০ ms query সেকেন্ডে ১০০০ বার চলা — দ্বিতীয়টাই বড় সমস্যা)
2. **`EXPLAIN (ANALYZE, BUFFERS)`** — বড় table এ Seq Scan? Sort এর নিচে অনেক row? `rows` এর অনুমান আর আসলের বড় পার্থক্য?
3. **কারণ খোঁজো** — index নেই, নাকি আছে কিন্তু ব্যবহার হচ্ছে না (function, leftmost prefix, selectivity, পুরনো statistics)?
4. **ঠিক করো** — query আবার লেখা (range, cursor) অথবা সঠিক index
5. **আবার মাপো** — `EXPLAIN` এ নতুন plan, আর write এর উপর প্রভাব

**Common follow-up গুলো:**

- _"`(a, b)` index আছে। `WHERE b = 5` কি এটা ব্যবহার করবে?"_ — leftmost prefix এর কারণে কার্যকরভাবে না; Postgres 18 এর skip scan `a` এর প্রতিটা মানে আলাদা লাফ দিয়ে ব্যবহার করতে পারে, কিন্তু `a` তে আলাদা মান বেশি হলে সেটা `(b)` index এর চেয়ে অনেক ধীর — এটা বলতে পারলে বোনাস
- _"সব column এ index দাও না কেন?"_ — প্রতিটা write প্রতিটা index আপডেট করে; lab এ ৬টা index এ insert ~৫ গুণ ধীর, WAL ৪ গুণ; আর নিচু selectivity এর index planner নেয়ই না
- _"Index আছে, তবু Seq Scan কেন?"_ — selectivity (অনেক row), column এ function/cast, অথবা পুরনো statistics (`ANALYZE` চালাও)

**Production এ বাস্তবে:** সবচেয়ে সাধারণ performance bug গুলো হলো foreign key এ index না থাকা, composite index এ ভুল ক্রম, আর `WHERE date(created_at) = ...` এর মতো query। আর সবচেয়ে সাধারণ উল্টো bug: বছরের পর বছর জমে থাকা অব্যবহৃত index, যেগুলো নীরবে প্রতিটা write কে ধীর করছে।

---

## ৩. Key Takeaway

- `EXPLAIN (ANALYZE, BUFFERS)` পড়ো ভেতর থেকে বাইরে; খোঁজো বড় Seq Scan, Sort এর নিচে অনেক row, আর অনুমান-বনাম-আসল `rows` এর পার্থক্য
- Postgres foreign key এ index বানায় না — নিজে দাও; সবসময় একটা অংশ চাইলে **partial index** (lab এ ৬.৭ MB → ২.১ MB)
- Composite index: **= এর column আগে, তারপর range/ORDER BY**; ভুল ক্রমে ১০ গুণ ধীর, আর **leftmost prefix** ছাড়া দ্বিতীয় column একা কাজে আসে না (Postgres 18 এর skip scan এ আসে, কিন্তু অনেক কম দক্ষতায়)
- Column এর উপর function/cast index ভেঙে দেয় — query range এ লেখো, নয়তো **expression index**; `LIKE '%x%'` B-tree দিয়ে কখনো না
- নিচু **selectivity** তে planner ঠিকভাবেই index উপেক্ষা করে; selectivity মাপো page দিয়ে — ১% row ও table এর ৭০% page ছুঁতে পারে
- **Covering index** table এ যাওয়া বাঁচায় (২৩ → ৪ page); cache ঠান্ডা থাকলে এটাই বড় পার্থক্য
- Index free না — ৬টা index এ insert ~৫ গুণ ধীর, WAL ~৪ গুণ; index বানাও **query থেকে**, অব্যবহৃতগুলো সরাও, production এ `CONCURRENTLY`

---

## ৪. নতুন Term (Glossary)

| Term                     | অর্থ                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| **Query Planner**        | Database এর যে অংশ statistics দিয়ে সম্ভাব্য সব পথের খরচ অনুমান করে সবচেয়ে সস্তা plan বেছে নেয় |
| **Selectivity**          | একটা শর্ত table এর কত ভাগ row বাছাই করে — কম ভাগ মানে উঁচু selectivity, index তখন বেশি কাজের     |
| **Composite Index**      | একাধিক column মিলিয়ে বানানো index — প্রথম column দিয়ে sorted, তারপর দ্বিতীয় দিয়ে, এভাবে      |
| **Leftmost Prefix Rule** | Composite index `(a, b, c)` কার্যকর শুধু বাম দিক থেকে টানা column এর শর্তে: `a`, `a+b`, `a+b+c`  |
| **Partial Index**        | শুধু একটা শর্ত মানা row গুলোর উপর বানানো index (`WHERE status <> 'done'`) — ছোট, সস্তা           |
| **Expression Index**     | Column এর বদলে একটা expression এর ফলাফল দিয়ে বানানো index (`lower(title)`)                      |
| **Covering Index**       | Query এর দরকারি সব column যে index এ আছে, তাই table এ না গিয়েই উত্তর (Index Only Scan)          |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এ নতুন একটা query: `WHERE "projectId" = 7 AND status = 'todo' ORDER BY "createdAt" DESC LIMIT 20`। এর জন্য index design করো — কোন column, কোন ক্রমে, আর কেন? অন্তত দুটো ভিন্ন সমাধান দাও, আর কখন কোনটা ভালো।
2. একটা `EXPLAIN ANALYZE` এ দেখা গেল: `Nested Loop (rows=1) (actual rows=48000)`। Planner ভেবেছিল ১টা row আসবে, এসেছে ৪৮,০০০। এটা কী সমস্যার ইঙ্গিত, আর এর ফল কী হতে পারে? প্রথমে কী চেষ্টা করবে?
3. একজন developer production এ একটা ধীর `DELETE` এর কারণ খুঁজতে সরাসরি `EXPLAIN ANALYZE DELETE FROM tasks WHERE ...` চালাল। কী ঘটল? কীভাবে নিরাপদে করা উচিত ছিল — আর production এ একটা নতুন index যোগ করার সময় আরেকটা কোন ফাঁদ এড়াতে হবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** নিয়ম — `=` এর column আগে, তারপর ORDER BY এর column।

- **সমাধান ক:** `(projectId, status, createdAt)` — `projectId` আর `status` দুটোই `=`, তাই সামনে; `createdAt` শেষে, যাতে index থেকেই sorted ক্রমে পড়ে Limit এ থামা যায় (ধাপ ২ এর মতো, Sort ছাড়া)। সুবিধা: যেকোনো status এর জন্য কাজ করে (`'doing'`, `'blocked'` ও)।
- **সমাধান খ:** Partial index `(projectId, createdAt) WHERE status = 'todo'` — শুধু todo task, তাই অনেক ছোট; কিন্তু শুধু ঠিক এই শর্তের query তে কাজে আসে।

যদি app এ বিভিন্ন status দিয়ে এই query আসে → ক। যদি শুধু "todo" এর view টাই গরম → খ ছোট আর দ্রুত। `projectId` আর `status` এর নিজেদের মধ্যে ক্রম এখানে কম গুরুত্বপূর্ণ (দুটোই `=`), কিন্তু যদি অন্য query তে শুধু `projectId` দিয়ে filter হয়, তাহলে `projectId` আগে রাখলে leftmost prefix এর কারণে একই index সেটাও সামলাবে।

**প্রশ্ন ২:** Planner এর **statistics ভুল বা পুরনো** — সে ভুল অনুমানের উপর plan বেছেছে। Nested Loop অল্প row এর জন্য দারুণ (প্রতিটা বাইরের row এর জন্য ভেতরে একবার খোঁজা), কিন্তু ৪৮,০০০ row এ সেটা ৪৮,০০০ বার ভেতরে খোঁজা — যেখানে Hash Join অনেক দ্রুত হতো। ফল: query হঠাৎ অনেক গুণ ধীর, প্রায়ই কোনো code না বদলেই (data বেড়েছে, statistics বাড়েনি)। প্রথম চেষ্টা: `ANALYZE tasks` চালিয়ে আবার `EXPLAIN`। না ঠিক হলে: দুটো column একে অপরের সাথে সম্পর্কিত কিনা দেখো (যেমন `city` আর `country` — planner ধরে নেয় তারা স্বাধীন, আর দুটো শর্ত গুণ করে খুব ছোট সংখ্যা পায়); Postgres এ এর জন্য `CREATE STATISTICS` দিয়ে extended statistics দেওয়া যায়।

**প্রশ্ন ৩:** `EXPLAIN ANALYZE` query টা **সত্যিই চালায়** — row গুলো production থেকে সত্যিই মুছে গেছে। নিরাপদ উপায়: `BEGIN; EXPLAIN ANALYZE DELETE ...; ROLLBACK;` — plan আর সময় দেখা যায়, data বদলায় না (তবে মনে রেখো, transaction চলার সময় row গুলোতে lock থাকে — production এ ব্যস্ত সময়ে এটাও সাবধানে)। অথবা শুধু `EXPLAIN` (ANALYZE ছাড়া), যেটা চালায় না, শুধু পরিকল্পনা দেখায়। দ্বিতীয় ফাঁদ: কারণ খুঁজে পাওয়ার পর সাধারণ `CREATE INDEX` দিলে index তৈরি হওয়ার পুরো সময় table এ লেখা আটকে থাকবে — বড় table এ মিনিটের পর মিনিট TaskFlow এ কেউ task তৈরি করতে পারবে না। `CREATE INDEX CONCURRENTLY` ব্যবহার করতে হবে (transaction এর বাইরে)।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.4-indexing/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.4-indexing) — `docker compose up -d --wait && npm install && npm run seed`, তারপর `npm run lab` আর `npm run writecost`। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

১০ লাখ task এর একটা lab — ৭টা ধাপে TaskFlow এর আসল query, প্রতিটা ভিন্ন index দিয়ে, `EXPLAIN (ANALYZE, BUFFERS)` এর ফল পাশাপাশি। Index তৈরি হয় `queryInterface.addIndex` দিয়ে, ঠিক যেভাবে Sequelize migration এ লেখা হয়। Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean, lab কয়েকবার চালিয়ে plan আর pages প্রতিবার একই, `writecost` দুবার চালিয়ে WAL হুবহু একই।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. `npm run lab` চালাও। তোমার মেশিনে **plan এর আকার আর pages** কি README এর সাথে মেলে? (সময় ভিন্ন হওয়া স্বাভাবিক।) কোনো ধাপে plan আলাদা হলে সেটা লিখে পাঠাও — কেন হতে পারে, আমরা একসাথে দেখব।

2. **উল্টো index এর ভাগ্য ভাঙো** (README experiment ১): project 7 এর সব task এক বছর পুরনো করে `npm run lab -- 2`। `(createdAt, projectId)` এর pages কত হলো? `(projectId, createdAt)` এর? এই পার্থক্য থেকে "ভাগ্যের জোরে দ্রুত" index কে production এ কেন বিশ্বাস করা যায় না — এক অনুচ্ছেদে লেখো।

3. **Selectivity এর সীমারেখা** (experiment ২): `'doing'` (৭%) আর `'todo'` (২২%) যোগ করে planner কোথায় মত বদলায় খুঁজে বের করো।

4. **Planner কে জোর করো** (experiment ৩): `enable_seqscan = off` দিয়ে `'done'` query চালাও। জোর করা index plan কি Seq Scan এর চেয়ে দ্রুত হলো? সংখ্যা সহ লেখো।

5. **Design অংশ:** TaskFlow এর এই পাঁচটা query এর জন্য **সবচেয়ে কম সংখ্যক index** এর একটা সেট প্রস্তাব করো, প্রতিটা কোন query সামলাচ্ছে সহ:

   - (ক) `WHERE "assigneeId" = ? AND status <> 'done'`
   - (খ) `WHERE "projectId" = ? ORDER BY "createdAt" DESC LIMIT 20` (cursor pagination সহ)
   - (গ) `WHERE "projectId" = ? AND status <> 'done'` এর count (Lesson 5.2 এর dashboard)
   - (ঘ) `WHERE "createdAt" >= ? AND "createdAt" < ?` এর count (daily report)
   - (ঙ) `WHERE lower(title) = ?`

   তারপর `writecost` এর সংখ্যা দেখে বলো — তোমার সেটে insert মোটামুটি কত গুণ ধীর হবে? কোনো একটা index বাদ দেওয়ার মতো কিনা, কোন query এর দাম দিয়ে?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2, 5.3
Current: 5.4 — Indexing Deep Dive
TaskFlow state: Nginx + ৪টা Express instance, CDN, Redis cache, একটা PostgreSQL primary
(১০ লাখ task); normalized schema + openTaskCount; query ভিত্তিক index —
FK তে partial index, feed এ (projectId, createdAt) composite, EXPLAIN ANALYZE দিয়ে মাপা
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.5 — Transactions, ACID, Isolation Levels
=======================
```

---

## ৮. পরের Lesson

Lab চালিয়ে তোমার সংখ্যাগুলো পাঠাও — বিশেষ করে ২ নম্বরের pages আর ৫ নম্বরের index সেট। রেডি হলে `next` লিখো — Lesson 5.5 এ যাব: **Transactions, ACID, Isolation Levels** — Lesson 5.2 এর সেই রহস্য শেষমেশ খুলব: transaction এর ভেতরে read-modify-write লিখলেও কেন update হারায়, read committed থেকে serializable পর্যন্ত প্রতিটা level কোন anomaly আটকায় আর কোনটা আটকায় না, আর Postgres এর MVCC আসলে কীভাবে কাজ করে — hands-on, TaskFlow এর আসল race condition দিয়ে।
