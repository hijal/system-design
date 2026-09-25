# TaskFlow Indexing Lab — EXPLAIN ANALYZE দিয়ে

> Lesson 5.4 — Indexing Deep Dive · **Tier 1 — Runnable Code**

## কী বানাচ্ছি

১০ লাখ task এর একটা TaskFlow table, আর একটা "lab" যেটা TaskFlow এর আসল query গুলো ভিন্ন
ভিন্ন index দিয়ে চালিয়ে `EXPLAIN (ANALYZE, BUFFERS)` এর ফল পাশাপাশি দেখায় — plan এর
আকার, সময়, আর কতগুলো page ছুঁয়েছে। সাথে একটা script যেটা index এর **লেখার দাম** মাপে।

| Script              | কী দেখায়                                                     | Lesson §  |
| ------------------- | ------------------------------------------------------------- | --------- |
| `npm run seed`      | ১০ লাখ task তৈরি (deterministic — প্রতিবার একই data)          | —         |
| `npm run lab`       | ৭টা ধাপ: FK index, composite ক্রম, leftmost prefix, function… | ১.২ – ১.৫ |
| `npm run lab -- 4`  | শুধু একটা ধাপ (এখানে ধাপ ৪)                                   |           |
| `npm run writecost` | ০, ৩, ৬টা index নিয়ে ২ লাখ row insert — সময়, WAL, আকার      | ১.৬       |

## Prerequisite

Node.js 22+ এবং Docker (শুধু PostgreSQL চালানোর জন্য)।

Port **5435** — তোমার মেশিনের Postgres (5432) বা আগের exercise গুলোর (5433, 5434) সাথে সংঘাত
এড়াতে।

## Setup

```bash
docker compose up -d --wait
npm install
npm run seed        # কয়েক সেকেন্ড
```

## Run

```bash
npm run lab
npm run writecost   # ~১ মিনিট
```

Lab এর প্রতিটা variant শুরু হয় primary key ছাড়া **সব index মুছে**, তারপর শুধু সেই variant এর
index বানিয়ে। শেষে আবার সব মুছে দেয় — তাই যতবার খুশি চালানো যায়।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**`npm run lab`** — আমার মেশিনে (Postgres 17, সব page buffer pool এ গরম অবস্থায়, ৫ বারের
median)। তোমার সময় ভিন্ন হবে; **plan এর আকার আর pages** প্রায় হুবহু মিলবে, কারণ data
deterministic:

```
১. "আমার খোলা task" — foreign key এ index
   index                                              সময়    pages  plan
   index নেই                                      25.76 ms    8,399  Gather → Seq Scan
   (assigneeId)                                    0.15 ms      203  Bitmap Heap Scan → Bitmap Index Scan [tasks_assignee]  (index: 6728 kB)
   (assigneeId) WHERE status <> done               0.07 ms       70  Bitmap Heap Scan → Bitmap Index Scan [tasks_assignee_open]  (index: 2072 kB)

২. Project feed — composite index এ column এর ক্রম
   index নেই                                      20.46 ms    8,473  Limit → Gather Merge → Sort → Seq Scan
   (projectId)                                     0.42 ms      504  Limit → Sort → Bitmap Heap Scan → Bitmap Index Scan [tasks_project]
   (createdAt, projectId) — উল্টো                  0.47 ms      188  Limit → Index Scan Backward [tasks_created_project]
   (projectId, createdAt)                          0.04 ms       23  Limit → Index Scan Backward [tasks_project_created]

৩. Leftmost prefix — composite index এর দ্বিতীয় column একা
   (projectId, createdAt)                         25.11 ms    8,399  Aggregate → Gather → Aggregate → Seq Scan
   (createdAt)                                     0.15 ms        8  Aggregate → Index Only Scan [tasks_created]

৪. Column এর উপর function — index থাকলেও কাজে লাগে না
   (createdAt) + createdAt::date = …              33.54 ms    8,399  Aggregate → Gather → Aggregate → Seq Scan
   (createdAt) + range                             0.16 ms        8  Aggregate → Index Only Scan [tasks_created]
   (title) + lower(title) = …                     67.23 ms    8,399  Gather → Seq Scan
   (lower(title)) — expression index               0.03 ms        4  Index Scan [tasks_title_lower]

৫. Selectivity — index আছে, তবু Postgres নেয় না
   (status) + status = 'done'                     89.11 ms    8,399  Seq Scan
   (status) + status = 'blocked'                   5.60 ms    5,810  Bitmap Heap Scan → Bitmap Index Scan [tasks_status]

৬. Covering index — table এ না গিয়েই উত্তর
   (projectId, createdAt)                          0.04 ms       23  Limit → Index Scan Backward [tasks_project_created]
   (projectId, createdAt) INCLUDE (id, title)      0.04 ms        4  Limit → Index Only Scan Backward [tasks_project_created_cover]

৭. LIKE — B-tree এর সীমা
   (title) + LIKE '%bug%'                         28.25 ms    8,399  Aggregate → Gather → Aggregate → Seq Scan
   (title) + LIKE 'Fix bug #1234%'                23.52 ms    8,399  Aggregate → Gather → Aggregate → Seq Scan
   (title text_pattern_ops) + একই LIKE             0.03 ms        5  Aggregate → Index Only Scan [tasks_title_pattern]
```

(পুরো table টা ৮,৩৯৯টা page — তাই যেখানে `pages` ৮,৩৯৯, সেখানে পুরো table পড়া হয়েছে।)

**`npm run writecost`** — আমার মেশিনে, দুবার চালিয়ে:

```
  index (primary key বাদে)      সময়        WAL       index এর মোট আকার
   0টা                           418 ms (1.0x)    31.7 MB      4.3 MB
   3টা                          1218 ms (2.9x)    77.9 MB     21.5 MB
   6টা                          1999 ms (4.8x)   126.9 MB     43.4 MB
```

WAL আর আকার প্রতিবার একই আসে; সময় রান ভেদে একটু বদলায় (দ্বিতীয়বার ৬টা index এ ৫.৪x)।

## কী দেখার জন্য এটা বানানো

1. **Index "আছে" আর "ব্যবহার হচ্ছে" এক জিনিস না।** ধাপ ৩, ৪, ৫, ৭ — প্রতিটায় একটা index আছে,
   তবু plan এ `Seq Scan`। Index যোগ করে থেমে যেও না — `EXPLAIN` দিয়ে দেখো।
2. **Composite index এ ক্রমই সব।** ধাপ ২ তে একই দুটো column, উল্টো ক্রমে ১০ গুণের বেশি ধীর,
   আর ধাপ ৩ এ দ্বিতীয় column একা কোনো কাজেই আসে না।
3. **`pages` কলামটা সময়ের চেয়েও সৎ।** এখানে সব page memory তে গরম, তাই ২৩ আর ৪ page এর
   পার্থক্য সময়ে দেখা যায় না (ধাপ ৬)। কিন্তু production এ, যেখানে সব page cache এ থাকে না,
   প্রতিটা page হয়তো একটা disk read।
4. **Index free না।** প্রতিটা index প্রতিটা insert কে ধীর করে আর বাড়তি WAL লেখায় (Lesson 5.3)।

## নিজে ভেঙে দেখো (Experiments)

1. **উল্টো composite index এর "ভাগ্য"।** ধাপ ২ এ `(createdAt, projectId)` খুব খারাপ দেখায় না
   (০.৪৭ ms)। কারণ project 7 এর task সময় জুড়ে সমানভাবে ছড়ানো — পেছন থেকে পড়তে শুরু করলে
   দ্রুতই ২০টা পাওয়া যায়। এবার `src/seed.ts` এ project 7 এর সব task কে এক বছর পুরনো বানাও
   (seed এর পরে একটা `UPDATE tasks SET "createdAt" = "createdAt" - interval '365 days' WHERE "projectId" = 7`
   চালিয়ে `ANALYZE tasks`), তারপর `npm run lab -- 2`। উল্টো index এর pages আর সময় কী হলো? কেন?

2. **Selectivity এর সীমারেখা খোঁজো।** ধাপ ৫ এ `'blocked'` (১%) এ Postgres index নেয়, `'done'`
   (৭০%) এ নেয় না। `'doing'` (৭%) আর `'todo'` (২২%) দিয়ে `src/lab.ts` এ দুটো variant যোগ করো।
   কোথায় গিয়ে planner মত বদলায়? আর `'blocked'` এর মাত্র ১% row এর জন্য কেন ৫,৮১০টা page
   (table এর ~৭০%) ছুঁতে হলো?

3. **Planner কে জোর করে ভুল পথে পাঠাও।** `psql` এ ঢুকে (`docker compose exec postgres psql -U taskflow`)
   `CREATE INDEX ON tasks (status);` তারপর `SET enable_seqscan = off;` দিয়ে
   `EXPLAIN ANALYZE SELECT id, title FROM tasks WHERE status = 'done';` চালাও। সময় Seq Scan এর
   চেয়ে ভালো হলো না খারাপ? Planner কেন ঠিক ছিল? (শেষে `RESET enable_seqscan;` আর index টা
   `DROP` করো।)

4. **Partial index এর শর্ত মেলাতে হয়।** ধাপ ১ এর partial index `WHERE status <> 'done'` দিয়ে বানানো।
   Query তে `status <> 'done'` বাদ দিয়ে শুধু `WHERE "assigneeId" = 42` দিলে planner কি এই index
   ব্যবহার করতে পারবে? আগে অনুমান করো, তারপর চালিয়ে দেখো।

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-5.4-indexing/
├── docker-compose.yml   # শুধু Postgres (5435)
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts            # Sequelize connection + সব secondary index মোছার helper
    ├── seed.ts          # ১০ লাখ task, setseed দিয়ে deterministic
    ├── explain.ts       # EXPLAIN JSON → Zod (recursive schema) → এক লাইনের সারাংশ
    ├── lab.ts           # ৭টা ধাপ; index তৈরি queryInterface.addIndex দিয়ে (migration এর মতো)
    └── writecost.ts     # ০ / ৩ / ৬টা index এ insert এর সময় আর WAL
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, Postgres 17, Sequelize 6.37):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- `npm run lab` কয়েকবার চালানো — plan এর আকার আর pages প্রতিবার একই, সময় কাছাকাছি
- `npm run writecost` দুবার চালানো — WAL আর index এর আকার হুবহু একই, সময় ±১০%
- Database এর collation `en_US.utf8` (Docker এর `postgres` image এর default) — ধাপ ৭ এর ফল এর উপর
  নির্ভর করে; `C` collation এর database এ সাধারণ `(title)` index দিয়েই `LIKE 'abc%'` চলত
