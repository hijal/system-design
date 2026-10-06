# Lesson 7.6 — Batch vs Stream, OLTP vs OLAP: কখন কোন পথ

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.4):** একটা composite index `(project_id, occurred_at)` কোন query তে কাজে লাগে আর কোনটায় লাগে না — আর table এ প্রতিটা বাড়তি index এর দাম কে দেয়, কখন? আজ দেখবেন একটা analytics প্রশ্নকে index দিয়ে দ্রুত করার চেষ্টা কোথায় গিয়ে আটকায়।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 5.4 (Indexing), Lesson 5.7 (Read replica), Lesson 7.1 (Backlog), Lesson 7.2 (Log, replay), Lesson 7.5 (Event, CDC)

**আপনি এই lesson শেষে পারবেন:**

1. একটা প্রশ্ন OLTP নাকি OLAP — চিনতে পারবেন, আর কেন analytics production database এ চালানো উচিত না, সেটা মাপা সংখ্যা দিয়ে বলতে পারবেন; row store আর column store এর পার্থক্য কোথায় থেকে আসে, ব্যাখ্যা করতে পারবেন
2. একটা হিসাব batch এ হবে নাকি stream এ — ফল কত দ্রুত লাগবে আর কতটা ঠিক হতে হবে, এই দুই প্রশ্ন দিয়ে ঠিক করতে পারবেন
3. Event time, processing time, window আর watermark দিয়ে দেরিতে আসা data সামলানোর design করতে পারবেন — আর জানবেন কোন ভুল কোন পদ্ধতিতে কখনো ঠিক হয় না

**Tier:** 1 — Runnable Code (Docker এ Postgres বনাম DuckDB, আর একটা deterministic stream simulation)

---

## ০. TaskFlow এখন কোথায়

Module 7 এর পাঁচটা lesson এ TaskFlow এর প্রতিটা পরিবর্তন এখন একটা event — outbox থেকে Redis Stream এ, নির্ভরযোগ্যভাবে, idempotent consumer সহ। Data এর প্রবাহ তৈরি। আর তার সাথে সাথে data চাওয়ার মানুষ বেড়েছে। এক সপ্তাহে দুটো চাওয়া, দুটো ঘটনা:

1. **Finance, মঙ্গলবার সকাল ১১টা।** Billing মেলাতে finance এর একজন analyst চাইল: "গত ১২ মাসে প্রতিটা workspace এ প্রতি মাসে কয়টা task complete হয়েছে।" একজন engineer সাহায্য করতে একটা `GROUP BY` লিখে production database এ চালাল — চারটা মাসের জন্য চারটা tab এ, একসাথে। পাঁচ মিনিট পরে on-call এর phone: task board খুলতে সময় লাগছে, p99 alert। কোনো deploy নেই, traffic স্বাভাবিক। কারণ খুঁজে পেতে আধা ঘণ্টা।
2. **Product, বৃহস্পতিবার।** নতুন live dashboard: "প্রতি ঘণ্টায় আপনার team কয়টা task complete করল।" প্রথম version টা সহজ — stream এর প্রতিটা `task.completed` এলে সেই ঘণ্টার counter এ +১। শুক্রবার mobile এর event pipeline এক ঘণ্টা (১টা–২টা) আটকে ছিল, ২টায় জমে থাকা সব খবর একসাথে এলো। Dashboard এ ১টার ঘণ্টা প্রায় শূন্য, ২টার ঘণ্টা দ্বিগুণ। একজন customer এর manager জিজ্ঞেস করল: "১টা থেকে ২টা আমার team কি কিছুই করেনি?" আর billing team জানতে চাইল এই সংখ্যা দিয়ে কি usage হিসাব করা যায়।

দুটো ঘটনার পেছনে Module 7 এর শেষ প্রশ্ন: data এর **প্রশ্ন** দুই রকম — "এই একটা জিনিস এখন দিন" আর "সব কিছু মিলিয়ে কী দাঁড়াল" — আর তাদের জায়গা, সময় আর নিয়ম আলাদা।

---

## ১. Theory

### ১.১ দুই ধরনের প্রশ্ন — OLTP আর OLAP

TaskFlow এর board খুললে যে query চলে আর finance এর query — দেখতে দুটোই SQL, কিন্তু আকৃতিতে উল্টো।

**OLTP (Online Transaction Processing)** — application এর প্রতিদিনের কাজ: অল্প কয়েকটা row পড়া বা লেখা, key বা index দিয়ে খুঁজে, খুব দ্রুত (ms), অনেক user একসাথে।

**OLAP (Online Analytical Processing)** — বিশ্লেষণের প্রশ্ন: বিশাল সংখ্যক row পড়ে যোগ, গড়, গোনা (aggregate), সাধারণত কয়েকটা column এর উপর; সেকেন্ড বা মিনিট চলতে পারে, অল্প কয়েকজন মানুষ চালায়।

| বৈশিষ্ট্য        | OLTP (task board)                    | OLAP (finance এর report)                       |
| ---------------- | ------------------------------------ | ---------------------------------------------- |
| প্রশ্নের আকৃতি   | "project 42 এর সাম্প্রতিক ২০টা ঘটনা" | "প্রতিটা workspace এর প্রতি মাসের মোট"         |
| কয়টা row ছোঁয়  | কয়েকটা থেকে কয়েকশো — index দিয়ে   | লাখ থেকে কোটি — পুরো table বা তার বড় অংশ      |
| কয়টা column     | প্রায়ই পুরো row                     | অল্প কয়েকটা (৮টার মধ্যে ৩টা)                  |
| সময়ের প্রত্যাশা | মিলিসেকেন্ড, p99 ধরে                 | সেকেন্ড থেকে মিনিট চলে                         |
| একসাথে কতজন      | হাজার হাজার request                  | কয়েকজন analyst, কয়েকটা dashboard             |
| লেখা             | অনেক ছোট ছোট insert/update           | বড় বড় batch এ load, আপডেট কম                 |
| Data কতটা নতুন   | এই মুহূর্তের                         | কয়েক মিনিট বা এক দিন পুরনো হলেও চলে (প্রায়ই) |

### ১.২ এক database এ দুটো — মঙ্গলবার সকাল ১১টা

Exercise এর `npm run olap` — ৩০ লাখ `task_events` এর একটা Postgres (২টা CPU তে সীমিত, production database এর মতো — তার core ও সীমিত)। প্রথম ১০ সেকেন্ড ৮টা client শুধু board এর query চালায়; পরের ১০ সেকেন্ড একই সাথে চারটা finance এর query:

```
   phase                           OLTP q/s   OLTP p50    OLTP p99   OLTP max    analytics done (avg)
   OLTP only                          15222     0.6 ms      1.1 ms    20.2 ms                       —
   OLTP + 4 analytics                  4330     0.6 ms     68.5 ms    77.1 ms     47 times (868.8 ms)
```

Board এর query নিজে একটুও বদলায়নি — একই index, একই plan। তবু p99 **১.১ ms থেকে ৬৮.৫ ms**, আর প্রতি সেকেন্ডে query ১৫ হাজার থেকে ৪ হাজারে। কারণ Lesson 7.1 এর cascading failure এর একটা নরম রূপ: ভাগ করা resource। Analytics query গুলো দুটো CPU দখল করে রাখে, disk থেকে পুরো table টানে আর memory এর cache (shared buffers) থেকে board এর গরম page গুলো সরিয়ে দেয়। Board এর ছোট query গুলো লাইনে দাঁড়ায়। (Experiment ১: একটা analytics query তে p99 প্রায় একই থাকে, কিন্তু throughput ~৩৫% কমে। "একটা report তো ক্ষতি করে না" — যতক্ষণ না কেউ চারটা tab খোলে।)

**"তাহলে analytics read replica তে চালাই"** (Lesson 5.7)? এটা অনেক ভালো — primary এর CPU আর cache বাঁচে। কিন্তু দুটো সমস্যা থাকে। প্রথমত, replica ও row store — প্রশ্নটা সেখানেও ধীর (১.৩)। দ্বিতীয়ত, লম্বা query আর replication এর মধ্যে টানাপোড়েন: replica যখন primary এর পরিবর্তন প্রয়োগ করতে চায় আর একটা লম্বা query সেই পুরনো row গুলো পড়ছে, Postgres কে বাছতে হয় — query বাতিল করবে (`canceling statement due to conflict with recovery`), নাকি replication পিছিয়ে রাখবে। `hot_standby_feedback` চালু করলে query বাঁচে, কিন্তু primary পুরনো row পরিষ্কার করতে পারে না (bloat)। ছোট আকারে replica একটা ভালো প্রথম ধাপ; বড় হলে analytics এর নিজের জায়গা লাগে।

### ১.৩ Row Store বনাম Column Store

Finance এর প্রশ্নটা Postgres এ একা চললে (কেউ আর চলছে না), আর একই data একটা column store এ — একই দুটো CPU তে:

```
   the same analytics question (monthly usage, per workspace), nothing else running, three times each:
     Postgres (row store, 2 CPUs):       255.9 ms, 257.6 ms, 258.7 ms
     DuckDB   (column store, 2 threads):  28.6 ms, 21.1 ms, 21.4 ms
     results match: yes ✓

   from Postgres's plan:
     ->  Seq Scan on task_events  (… rows=750000 loops=1)
     Buffers: shared hit=11011 read=19917
```

~১২ গুণ, একই CPU তে, একই ফল। কোথা থেকে?

Plan এর শেষ লাইনটা দেখুন: ১১০১১ + ১৯৯১৭ = ৩০৯২৮ টা page, প্রতিটা 8 KB — প্রায় ২৪২ MB, **পুরো table**। অথচ প্রশ্নটার লাগে আটটা column এর মধ্যে তিনটা (`type`, `workspace_id`, `occurred_at`, আর যোগ করতে `duration_ms`)। Postgres সেগুলো আলাদা করে পড়তে পারে না, কারণ তার disk এর গঠনই row ধরে:

```
   row store (Postgres):  প্রতিটা page এ কয়েকটা পুরো row পাশাপাশি

     page 1: [id|ws|proj|task|user|type|time|dur] [id|ws|proj|task|user|type|time|dur] …
     page 2: [id|ws|proj|task|user|type|time|dur] …
             → "সব row এর type" পড়তে হলে সব page, তাই সব column

   column store (DuckDB, ClickHouse, BigQuery …):  প্রতিটা column আলাদা, একটানা

     type: [completed, created, assigned, completed, completed, …]    ← শুধু এটা
     ws:   [12, 12, 12, 40, 40, 40, 40, …]                             ← আর এটা
     time: [2025-01-01 00:00:07, …]                                    ← আর এটা
     proj, task, user, id: ছোঁয়াই হয় না
```

**Column store** — data কে row ধরে না, column ধরে আলাদা আলাদা করে জমা রাখা; একটা প্রশ্ন শুধু যে column গুলো লাগে সেগুলোই পড়ে।

তিনটা কারণে এটা analytics এ দ্রুত:

1. **কম পড়া** — শুধু দরকারি column।
2. **Compression** — একটা column এর মানগুলো একই ধরনের আর প্রায়ই পুনরাবৃত্ত (`type` এ চারটাই মান, `workspace_id` এ ২০০টা) — তাই খুব ভালো চাপা যায়। Exercise এ Postgres এর table ২৪২ MB, DuckDB এর file ২৮ MB। (সৎ নোট: exercise এর data একটা সূত্রে বানানো, অস্বাভাবিক নিয়মিত — আসল data তে অনুপাত এতটা ভালো হবে না, তবে কয়েক গুণ ছোট হওয়া সাধারণ।)
3. **Vectorized execution** — একটা একটা row না, একসাথে হাজারটা মানের একটা টুকরো নিয়ে একই কাজ — CPU এর cache আর নির্দেশ দুটোই ভালো ব্যবহার হয়।

তাহলে সবকিছু column store এ রাখি না কেন? কারণ OLTP ঠিক উল্টোটা চায়। Board এর query একটা task এর **পুরো row** চায় — column store এ সেটা আটটা আলাদা জায়গা থেকে জোড়া লাগাতে হয়। একটা নতুন comment insert করা মানে আটটা column এ একটা করে মান যোগ — আর column store গুলো বড় batch এ লেখার জন্য বানানো, এক এক row এর জন্য না। Update আর delete আরও কষ্টের। তাই পৃথিবী ভাগ হয়েছে: **OLTP এর জন্য row store, OLAP এর জন্য column store।**

**"Index দিয়ে Postgres কে দ্রুত করা যায় না?"** — Experiment ২: `(type, workspace_id, occurred_at) INCLUDE (duration_ms)` index — Postgres এখন index থেকেই উত্তর দেয় (index-only scan), ২৫৭ ms থেকে ১৪৩ ms। কিন্তু table + index এর আকার ৩৯৬ MB থেকে ৫৬৫ MB, প্রতিটা insert এ আরেকটা index এর লেখা (spaced repetition এর উত্তর — দামটা দেয় **প্রতিটা লেখা**, সবসময়), আর analytics চলার সময় board এর p99 তবু ~৬৯ ms। আর finance এর পরের প্রশ্নটা ("project ধরে", "user ধরে") এই index এ চলবে না। প্রতিটা বিশ্লেষণের প্রশ্নের জন্য একটা index — OLTP database এ সেটা টেকে না।

(কয়েকটা নাম: **DuckDB** — একটা library হিসেবে চলে, একটা file বা Parquet file এর উপর; ছোট team আর মাঝারি data এর জন্য অসাধারণ। **ClickHouse** — নিজে চালানো column store server, দ্রুত আর জনপ্রিয়। **BigQuery, Snowflake, Redshift** — cloud এর managed data warehouse। এদের সাধারণ নাম **data warehouse** — analytics এর জন্য আলাদা, column-ভিত্তিক database।)

### ১.৪ Data সেখানে যাবে কীভাবে — Batch আর Stream

Analytics এর আলাদা জায়গা হলো। এখন প্রশ্ন: production এর data সেখানে কীভাবে, কত ঘনঘন যাবে — আর তার উপর হিসাব কখন হবে। দুটো মৌলিক উপায়:

**Batch processing** — একটা নির্দিষ্ট, সীমাবদ্ধ পরিমাণ data (যেমন "গতকালের সব ঘটনা") একসাথে নিয়ে একবারে প্রক্রিয়া করা, সাধারণত নির্দিষ্ট সময় পর পর (রাতে একবার, ঘণ্টায় একবার)।

**Stream processing** — data যেমন যেমন আসে, একটা একটা করে (বা ছোট টুকরোয়) একটানা প্রক্রিয়া করা; data এর কোনো "শেষ" নেই, হিসাব সবসময় চলছে।

| বৈশিষ্ট্য         | Batch                                                    | Stream                                                         |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| ফল কখন            | পরের run এ — ঘণ্টা বা দিন পরে                            | সেকেন্ড বা মিনিট পরে                                           |
| কতটা ঠিক          | সহজে ঠিক — run এর সময় সব data আছে                       | দেরিতে আসা data কঠিন (১.৫)                                     |
| আবার চালানো       | সহজ — bug ঠিক করে পুরো দিন আবার                          | কঠিন — state আছে; log থেকে replay লাগে (7.2)                   |
| চালানো            | সহজ — একটা script বা SQL, cron এ                         | কঠিন — সবসময় চলা process, state, checkpoint, time এর নিয়ম    |
| ব্যর্থ হলে        | পরের run এ আবার                                          | থামলে পিছিয়ে পড়ে (lag), ফিরে ধরতে হয়                        |
| TaskFlow এ উদাহরণ | মাসিক usage, invoice, finance এর report, ML এর জন্য data | live dashboard, "এই মুহূর্তে কতজন online", fraud/abuse সতর্কতা |

সিদ্ধান্তের প্রশ্ন দুটো: **ফলটা কত দ্রুত লাগবে?** আর **ফলটা কতটা ঠিক হতে হবে, আর কখন?** Finance এর মাসিক report আজ বিকেলে লাগে না, কিন্তু প্রতিটা সংখ্যা ঠিক হতে হবে — batch। Live dashboard এক মিনিট পুরনো হলেই অকেজো, আর একটু আনুমানিক হলেও চলে — stream।

(বাস্তবে "batch" এর চেহারা প্রায়ই সাধারণ: রাতে একটা job production এর replica থেকে (বা 7.5 এর CDC থেকে জমা হওয়া data থেকে) আগের দিনের পরিবর্তন তুলে Parquet file বা warehouse এ লেখে, তারপর SQL এর report গুলো চলে। Data তোলা, রূপ বদলানো, আর লোড করা — এর পুরনো নাম ETL; আজকাল প্রায়ই আগে লোড তারপর warehouse এর ভেতরে রূপ বদলানো — ELT।)

### ১.৫ সময় দুই রকম — Event Time, Processing Time, আর Watermark

বৃহস্পতিবারের dashboard এর ভুলটা stream processing এর সবচেয়ে মৌলিক প্রশ্ন থেকে আসে: "ঘণ্টা" মানে কোন ঘড়ির ঘণ্টা?

**Event time বনাম processing time** — প্রতিটা ঘটনার দুটো সময়: event time হলো ঘটনাটা **আসলে কখন ঘটেছে** (task কখন complete হলো), আর processing time হলো system এর কাছে খবরটা **কখন পৌঁছাল** বা প্রক্রিয়া হলো। দুটোর মাঝের ফাঁক কয়েক ms থেকে কয়েক ঘণ্টা।

কেন ফাঁক? Mobile app এর network চলে যায়; laptop offline এ কাজ করে পরে sync করে; আর Module 7 জুড়ে দেখেছি — outage এর সময় backlog জমে, তারপর একসাথে আসে। 7.5 এর event এ `occurredAt` আলাদা করে রাখার কারণ ঠিক এটা।

Stream এ হিসাব হয় **window** এ — সময়ের টুকরো (এখানে এক ঘণ্টা, পাশাপাশি, না-ছোঁয়া — "tumbling window")। প্রশ্ন হলো: কোন ঘণ্টার window এ কোন ঘটনা, আর window টা কখন "শেষ" ধরে ফল বের করব? দুটো মৌলিক উত্তর:

- **Processing time এ:** খবর যে ঘণ্টায় পৌঁছায়, সেই ঘণ্টায় গুনুন; ঘড়ির ঘণ্টা শেষ হলেই ফল। সহজ, তাৎক্ষণিক — আর ভুল ঘণ্টায় গোনে।
- **Event time এ:** ঘটনা যে ঘণ্টায় ঘটেছে, সেই ঘণ্টায় গুনুন। কিন্তু তাহলে ১টার ঘণ্টার ফল কখন বের করবেন? ২টা বাজলেই? ১টা ৫৯ এর একটা ঘটনার খবর তো ২টা ১০ এ আসতে পারে। অনন্তকাল অপেক্ষা করা যায় না।

**Watermark** — stream processor এর একটা অনুমান: "এই সময়ের আগের event time এর ঘটনা আর (প্রায়) আসবে না।" সাধারণত = দেখা সবচেয়ে বড় event time − একটা অনুমোদিত দেরি (allowed lateness)। Watermark একটা window এর শেষ পার হলে সেই window এর ফল বের হয়।

Watermark একটা অনুমান — আর Lesson 6.1 থেকে জানি অনুমান ভুল হয়। Watermark এর পরে সেই window এর ঘটনা এলে সেটা **late data** — ফেলে দেবেন, নাকি ফল সংশোধন করবেন, নাকি আলাদা করে রাখবেন — একটা design সিদ্ধান্ত।

Exercise এর `npm run stream` — এক দিনে ~৫০ হাজার `task.completed` (কাজের সময়ে তিন গুণ বেশি); ৯০% খবর প্রায় সাথে সাথে, ৮% ১–১০ মিনিট দেরিতে (mobile), ২% ১–৬ ঘণ্টা দেরিতে (offline laptop) — আর শুক্রবারের মতো ১টা–২টা একটা pipeline outage, সেই ঘণ্টার খবর ২টা থেকে ২টা ১০ এর মধ্যে একসাথে:

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

("ভুল" = প্রতিটা ঘণ্টার গোনা আর আসল সংখ্যার পার্থক্যের যোগফল, দিনের মোট ঘটনার অনুপাতে; "খারাপতম ঘণ্টা" = সবচেয়ে ভুল ঘণ্টাটা তার আসল সংখ্যার কত শতাংশ ভুল।)

সারি ধরে পড়ুন:

- **Batch:** ফল পেতে ১৪ থেকে ২৫ ঘণ্টা — কিন্তু প্রায় নিখুঁত। রাত ২টার পরে আসা ৫১টা ঘটনা বাদ (৬ ঘণ্টা দেরির laptop গুলো, দিনের শেষ ঘণ্টার)। Finance এর জন্য ঠিক এটাই চাই।
- **Processing time:** তাৎক্ষণিক — আর খারাপতম ঘণ্টায় **১০০% ভুল**। Outage এর ঘণ্টাটা প্রায় শূন্য, পরেরটা প্রায় দ্বিগুণ। বৃহস্পতিবারের dashboard, হুবহু। আর শেষ কলাম দেখুন — "শেষে ভুল" একই: এই ভুল **কখনো ঠিক হয় না**, কারণ গোনার সময়েই ভুল ঘণ্টায় বসানো হয়েছে। (Outage ছাড়া — experiment ৩ — খারাপতম ঘণ্টা ৬.৪৬%: কাজের সময় শুরুর ঢালে ঘটনা পরের ঘণ্টায় পিছলে যায়।)
- **Event time, lateness ০ বা ১ মিনিট:** outage শেষে ২টার সাধারণ খবর আসতেই watermark ২টা পার হয়ে যায় — ১টার window বন্ধ, ফল প্রায় শূন্য। তারপর জমে থাকা খবর এসে পৌঁছায় বন্ধ দরজায়: হাজার হাজার বাদ। Event time সঠিক ধারণা, কিন্তু watermark খুব আগ্রাসী হলে processing time এর মতোই ভুল।
- **Lateness ১০ মিনিট:** জমে থাকা খবর ২টা ১০ এর মধ্যে এসে যায়, watermark তখনো ১টার window বন্ধ করেনি — খারাপতম ঘণ্টা ২.৮৮%। দাম: প্রতিটা ঘণ্টার ফল ১০ মিনিট দেরিতে। ১ ঘণ্টা lateness এ ভুল সামান্য কমে (১.৮৭%) কিন্তু দেরি ১ ঘণ্টা — কোথাও একটা থামতে হয়।
- **"সর্বোচ্চ ১.০ h" — একটা সূক্ষ্ম জিনিস।** Outage এর সময় কোনো খবরই আসে না, তাই watermark এগোয় না — ১২টার ঘণ্টার ফল (যেটা outage এর আগেই শেষ) ২টা পর্যন্ত আটকে থাকে। Watermark ঘটনা দেখেই এগোয়; উৎস চুপ থাকলে তার ঘড়িও থামে। (বাস্তব engine গুলোতে এর জন্য "idle source" এর নিয়ম আছে — কিছুক্ষণ কিছু না এলে processing time দিয়ে এগোনো — আবার একটা অনুমান।)
- **শেষ দুই সারি — দ্রুত আর শেষে ঠিক, দুটোই।** প্রথমটা ১০ মিনিটে ফল দেয়, তারপর দেরিতে আসা প্রতিটা ঘটনায় সংশোধিত ফল পাঠায় (১০৫০ বার) — শেষে ভুল ০%। দাম: যে এই ফল পড়ে (dashboard, আরেকটা service) তাকে "ফল বদলাতে পারে" সামলাতে হবে — 7.4 এর idempotent আর "সেট" এর ভাষা এখানে কাজে লাগে (ঘণ্টা ধরে upsert, "যোগ" না)। দ্বিতীয়টা দ্রুত stream এর ফল দেখায়, আর রাতের batch সেটা ঠিক সংখ্যা দিয়ে প্রতিস্থাপন করে — দুটো আলাদা pipeline, একই হিসাব দুবার লেখা।

দুই pipeline এর এই আকৃতির একটা পুরনো নাম আছে — **Lambda architecture** (batch layer আর speed layer, পাশাপাশি)। এর সমালোচনা থেকে আসে **Kappa architecture**: শুধু stream, আর ঠিক করতে হলে log থেকে পুরনো ঘটনা আবার চালান (7.2 এর replay)। কোনটা ভালো, সেটা নির্ভর করে team একটা stream engine কতটা ভালোভাবে চালাতে পারে তার উপর — এই আলোচনা মেটেনি।

(Tool এর কয়েকটা নাম: stream এর জন্য Apache Flink, Kafka Streams, Spark Structured Streaming — এরা event time, watermark আর window নিজেরা সামলায়। Batch এর জন্য প্রায়ই warehouse এর ভেতরের SQL, সময় ধরে চালানো — cron থেকে শুরু করে Airflow এর মতো scheduler।)

> **Trade-off Table — হিসাব কোন পথে**

| পথ                                        | ফল কখন             | কতটা ঠিক                           | চালানোর কষ্ট                                  | কখন                                                     |
| ----------------------------------------- | ------------------ | ---------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Production database এ সরাসরি              | এখনই               | ঠিক                                | সহজ — কিন্তু production এর দাম (১.২)          | ছোট data, মাঝে মাঝে, কম চাপের সময় — আর কখনো নিয়মিত না |
| Read replica এ                            | এখনই (replica lag) | ঠিক                                | সহজ; লম্বা query তে replication এর টানাপোড়েন | মাঝারি, প্রথম ধাপ                                       |
| Batch → column store (রাতে/ঘণ্টায়)       | ঘণ্টা থেকে দিন     | ঠিক (run এর সময় পর্যন্ত যা এসেছে) | কম — script, SQL, scheduler                   | Report, billing, finance, বেশিরভাগ analytics            |
| Stream, processing time                   | সেকেন্ড            | দেরিতে আসলে ভুল, কখনো ঠিক হয় না   | মাঝারি                                        | শুধু system এর নিজের metric (কত ঘটনা প্রক্রিয়া হলো)    |
| Stream, event time + watermark (+ সংশোধন) | মিনিট (lateness)   | প্রায় ঠিক; সংশোধন সহ ঠিক          | বেশি — state, watermark, late data, engine    | Live dashboard, সতর্কতা, দ্রুত সিদ্ধান্ত                |
| Stream + রাতের batch (Lambda)             | মিনিট, পরে ঠিক     | দ্রুত আনুমানিক, রাতে ঠিক           | সবচেয়ে বেশি — দুটো pipeline                  | যেখানে দুটোই লাগে আর team সামলাতে পারে                  |

### ১.৬ TaskFlow এর সিদ্ধান্ত

- **Production Postgres এ কোনো নিয়মিত analytics না।** Ad-hoc প্রশ্নের জন্য একটা read replica, একটা `statement_timeout` সহ, যাতে ভুল query ঘণ্টার পর ঘণ্টা না চলে।
- **Analytics store: শুরুতে সরল।** প্রতি রাতে replica থেকে আগের দিনের data Parquet file এ (দিন ধরে ভাগ করা), আর DuckDB দিয়ে finance এর report। TaskFlow এর আকারে (দিনে কয়েক লাখ ঘটনা) এটা বছরের পর বছর যথেষ্ট — একটা server, কোনো নতুন cluster না। Data বাড়লে বা অনেক মানুষ একসাথে query করলে ClickHouse বা একটা managed warehouse — 7.5 এর CDC দিয়ে প্রায় real-time এ ভরা।
- **Billing আর finance: batch, event time এ, শুধু।** রাতের run, `occurredAt` ধরে, আর মাসের শেষে কয়েক দিন অপেক্ষা করে "বন্ধ" (দেরিতে আসা laptop এর জন্য)। Stream এর সংখ্যা দিয়ে কখনো bill না।
- **Live dashboard: stream, event time, lateness ১০ মিনিট, সংশোধন সহ।** Dashboard এর store ঘণ্টা ধরে upsert করে (সংশোধন এলে সংখ্যা বদলায়)। UI তে চলতি ঘণ্টা আর শেষ ১০ মিনিটের সংখ্যায় একটা "হালনাগাদ হচ্ছে" চিহ্ন — সৎ থাকুন যে সংখ্যা এখনো নড়বে।
- **Processing time শুধু system এর নিজের স্বাস্থ্যের জন্য** — "প্রতি মিনিটে কতগুলো event প্রক্রিয়া হলো", consumer lag (7.2)। Business এর সংখ্যায় না।

---

## ২. Interview Angle

**Design interview এর "analytics" অংশ:** প্রায় যেকোনো design প্রশ্নে ("design a URL shortener", "design a news feed") শেষের দিকে আসে — "click এর সংখ্যা / trending দেখাতে চাই।" দুর্বল উত্তর: "database এ `COUNT(*)`।" ভালো উত্তর: প্রতিটা ঘটনা একটা event (log এ), তারপর দুই পথ — live সংখ্যা stream এ (window, আনুমানিক হলেও চলে — বা Lesson 10.2 এর HyperLogLog এর মতো আনুমানিক data structure), আর সঠিক report batch এ, column store এ। আর production database এ analytics কেন না — এক বাক্যে (ভাগ করা resource, row store)।

**"Batch নাকি stream?"** — উত্তর একটা প্রশ্ন দিয়ে শুরু করুন: "ফলটা কত দ্রুত লাগে, আর দেরিতে আসা data সামলাতে ভুল কতটা মেনে নেওয়া যায়?" তারপর দুটো উদাহরণ — একটা যেখানে batch (billing), একটা যেখানে stream (fraud alert) — আর মাঝেরটা (dashboard)। "Stream সবসময় ভালো কারণ দ্রুত" — এই ফাঁদে পড়বেন না; stream চালানো অনেক বেশি কঠিন।

**"Event time আর processing time এর পার্থক্য কী, আর late data কীভাবে সামলাবেন?"** — senior level এর প্রশ্ন। সংজ্ঞা, একটা বাস্তব কারণ (mobile offline), watermark, আর তিনটা বিকল্প (বাদ, সংশোধন, আলাদা করে রেখে batch এ ঠিক)। বোনাস: watermark উৎস চুপ থাকলে থামে।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনা মঙ্গলবারেরটাই — কেউ একজন "শুধু একটা query" production এ চালায়। প্রতিরোধ প্রযুক্তিগতের চেয়ে বেশি সাংগঠনিক: analyst দের জন্য আলাদা জায়গা যেটা তারা সত্যিই ব্যবহার করতে চায়, production এ আলাদা user আর `statement_timeout`, আর dashboard এর query কোথায় যায় তার একটা তালিকা। আর stream এর দিকে সবচেয়ে সাধারণ ভুল: processing time এর সংখ্যা business এর কাছে পৌঁছে যাওয়া — কেউ টের পায় না যতক্ষণ না একটা outage এর পরের graph এ গর্ত দেখা যায়।

---

## ৩. Key Takeaway

- **OLTP** (অল্প row, index, ms, অনেক user) আর **OLAP** (লাখ row এর aggregate, কয়েকটা column, সেকেন্ড, অল্প মানুষ) — একই SQL, উল্টো আকৃতি
- এক database এ দুটো মানে ভাগ করা CPU, disk আর cache: চারটা analytics query তে board এর p99 ১.১ ms → ৬৮.৫ ms, throughput ১৫ হাজার → ৪ হাজার। Read replica ভালো প্রথম ধাপ, কিন্তু সেটাও row store, আর লম্বা query তে replication এর সাথে টানাপোড়েন
- **Column store** শুধু দরকারি column পড়ে, ভালো চাপে, আর vectorized — একই CPU তে ~১২ গুণ দ্রুত (২৫৭ ms → ২১ ms); কিন্তু row ধরে লেখা আর পুরো row পড়ায় খারাপ — তাই OLTP row store এ, OLAP column store এ। Index দিয়ে এক প্রশ্ন দ্রুত হয়, সব প্রশ্ন না, আর দাম দেয় প্রতিটা লেখা
- **Batch**: দেরিতে, কিন্তু সহজে ঠিক আর সহজে আবার চালানো যায়; **stream**: দ্রুত, কিন্তু state, সময় আর দেরির data এর কষ্ট। প্রশ্ন দুটো: কত দ্রুত, আর কতটা ঠিক, কখন
- **Event time** (কখন ঘটল) বনাম **processing time** (কখন পৌঁছাল) — processing time এ গোনা outage এর পরে খারাপতম ঘণ্টায় ১০০% ভুল, আর কখনো ঠিক হয় না
- **Watermark** একটা অনুমান: খুব আগ্রাসী হলে late data বাদ পড়ে (lateness ০ তে প্রায় ৫ হাজার), ঢিলা হলে ফল দেরিতে; উৎস চুপ থাকলে watermark ও থামে। Late data: বাদ, সংশোধন (downstream upsert), বা রাতের batch এ ঠিক — দ্রুত আর ঠিক দুটোই চাইলে দাম দুটো ফল বা দুটো pipeline

---

## ৪. নতুন Term (Glossary)

| Term                             | অর্থ                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **OLTP**                         | Application এর প্রতিদিনের কাজ — অল্প row, index দিয়ে, ms এ, অনেক user একসাথে                                                |
| **OLAP**                         | বিশ্লেষণের প্রশ্ন — বিশাল সংখ্যক row এর aggregate, অল্প কয়েকটা column, সেকেন্ড-মিনিট চলে                                    |
| **Column Store**                 | Data কে column ধরে আলাদা জমা রাখা — প্রশ্ন শুধু দরকারি column পড়ে; ভালো compression, analytics এ দ্রুত, OLTP এ খারাপ        |
| **Batch Processing**             | নির্দিষ্ট, সীমাবদ্ধ data (যেমন গতকালের সব) একসাথে একবারে প্রক্রিয়া — নির্দিষ্ট সময় পর পর                                   |
| **Stream Processing**            | Data যেমন আসে একটানা প্রক্রিয়া — শেষ নেই, ফল সবসময় চলতি                                                                    |
| **Event Time / Processing Time** | ঘটনা আসলে কখন ঘটেছে বনাম system এর কাছে কখন পৌঁছাল — দুটোর ফাঁক ms থেকে ঘণ্টা                                                |
| **Watermark**                    | "এই event time এর আগের ঘটনা আর আসবে না" — এমন একটা অনুমান (সবচেয়ে বড় দেখা event time − অনুমোদিত দেরি); window বন্ধের সংকেত |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. Finance এর মাসিক usage report এখন থেকে কোথায় চলবে? তিনটা বিকল্প — (ক) production এর read replica, (খ) রাতে Parquet + DuckDB, (গ) CDC → ClickHouse — প্রতিটার জন্য বলুন: data কতটা পুরনো, production এর উপর কী প্রভাব, কী নতুন জিনিস চালাতে হবে, আর কী ভাঙতে পারে। TaskFlow এর আকারে কোনটা বাছবেন — আর কোন সংখ্যাটা দেখলে পরেরটায় যাবেন?
2. TaskFlow এর চারটা সংখ্যা: (ক) "এই মুহূর্তে কতজন user online" (header এ দেখায়), (খ) workspace এর মাসিক completed task (billing), (গ) একটা workspace থেকে এক মিনিটে ৫০০ এর বেশি task delete হলে security team কে সতর্কতা, (ঘ) প্রতিটা project এর "এই সপ্তাহে কত task complete" এর graph। প্রতিটার জন্য: batch নাকি stream, event time নাকি processing time, lateness কত, আর late data হলে কী।
3. Live dashboard এর stream একটা ছোট project এর জন্য অদ্ভুত আচরণ করছে: সেই project এ রাতে একজনই কাজ করে, আর তার ঘণ্টার সংখ্যা পরের দিন সকাল ৯টায় দেখা যায়। কেন? (Exercise এর কোন সারির কোন কলামের সাথে মেলে?) দুটো সমাধান দিন আর প্রতিটার দাম বলুন।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

| বিকল্প                    | Data কতটা পুরনো       | Production এর উপর                                     | নতুন কী চালাতে হবে                         | কী ভাঙতে পারে                                                                        |
| ------------------------- | --------------------- | ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| (ক) Read replica          | সেকেন্ড (replica lag) | Primary বাঁচে; replica এর replication এ টানাপোড়েন    | কিছু না (replica আছে)                      | লম্বা query বাতিল, বা `hot_standby_feedback` এ primary তে bloat; তবু row store এ ধীর |
| (খ) রাতে Parquet + DuckDB | এক দিন                | রাতে একবার replica থেকে পড়া — প্রায় শূন্য           | একটা রাতের job; file এর জায়গা             | Job ব্যর্থ হলে গতকালের data নেই (alert লাগে); schema বদলালে export ভাঙে              |
| (গ) CDC → ClickHouse      | সেকেন্ড থেকে মিনিট    | WAL পড়া — কম, কিন্তু replication slot এর ঝুঁকি (7.5) | Debezium/Kafka Connect, ClickHouse cluster | Slot আটকে primary এর disk ভরা; দুটো নতুন system এর operations                        |

বাছাই: TaskFlow এর আকারে **(খ)**। Finance এর প্রশ্ন মাসিক — এক দিন পুরনো data পুরোপুরি ঠিক; production এর উপর প্রভাব প্রায় নেই; নতুন cluster নেই। পরেরটায় যাওয়ার সংকেত: কেউ "আজকের" সংখ্যা নিয়মিত চায় (freshness), বা DuckDB এর file এত বড় যে একটা machine এ query গুলো ধীর, বা অনেক মানুষ একসাথে query করে (DuckDB একটা process এর ভেতরের library — অনেক user এর server না)।

**প্রশ্ন ২:**

- **(ক) online user:** stream, **processing time** ঠিক আছে — প্রশ্নটাই "এই মুহূর্তে", আর উত্তর কয়েক সেকেন্ড পুরনো হলেও চলে; আনুমানিক (HyperLogLog, Lesson 10.2) চলে। Late data প্রাসঙ্গিক না — পুরনো heartbeat মানে সে এখন online না।
- **(খ) billing:** batch, **event time**, আর মাস শেষে কয়েক দিন অপেক্ষা করে বন্ধ; late data যা তারপরে আসে সেটা পরের মাসে সংশোধন হিসেবে (নীতি হিসেবে লেখা থাকে)। Stream এর সংখ্যা কখনো না।
- **(গ) delete এর সতর্কতা:** stream — দেরি মানে ক্ষতি চলতে থাকে। Event time, কিন্তু lateness ছোট (৩০ সেকেন্ড–১ মিনিট) — ১০ মিনিট অপেক্ষা করে সতর্ক করার কোনো মানে নেই। Late data: সতর্কতা দেরিতে হলেও দিন (সংশোধন) — একটা সতর্কতা না দেওয়ার চেয়ে দেরিতে দেওয়া ভালো। আর ভুল সতর্কতা (false positive) কিছুটা মেনে নিন।
- **(ঘ) সাপ্তাহিক graph:** এক ঘণ্টা বা এক দিন পুরনো হলেও চলে — **batch** (ঘণ্টায় একবার, event time), অথবা stream এর lateness ১০ মিনিট + সংশোধন। দুটোই চলে; সরলতার জন্য ঘণ্টার batch।

**প্রশ্ন ৩:** Watermark এগোয় শুধু নতুন ঘটনা দেখে। যদি watermark প্রতিটা project এর জন্য আলাদা হয় (বা ওই project এর partition এ রাতে আর কোনো ঘটনা না আসে), তাহলে রাতের একমাত্র কর্মীর শেষ ঘটনার পরে আর কিছু আসে না — সেই ঘণ্টার window বন্ধ করার মতো "পরের" ঘটনা আসে সকাল ৯টায়, যখন অন্যরা কাজ শুরু করে। Exercise এর "প্রথম ফল পেতে সর্বোচ্চ ১.০ h" — outage এর সময় উৎস চুপ, watermark থেমে ছিল — হুবহু একই কারণ, ছোট আকারে।

সমাধান:

- **Idle source এর নিয়ম** — একটা উৎস (partition) কিছুক্ষণ (ধরুন ৫ মিনিট) চুপ থাকলে তাকে watermark এর হিসাব থেকে বাদ দিন, বা processing time দিয়ে তার watermark এগিয়ে নিন। দাম: সে যদি আসলে শুধু দেরিতে ছিল (offline), তার পরের ঘটনা late data হয়ে যায় — আবার সংশোধন বা বাদের প্রশ্ন।
- **Watermark partition ধরে না, পুরো stream জুড়ে** (সব project এর ঘটনা মিলে এগোয়) — অন্য project এর ঘটনাই ঘড়ি এগিয়ে নেয়। দাম: একটা ধীর বা পিছিয়ে থাকা partition এর ঘটনা বেশি late হয়ে যায়।
- (বিকল্প: processing time এর timer — "window শেষ হওয়ার ১৫ মিনিট পরে, watermark যাই হোক, ফল বের করুন" — lateness এর সাথে একটা সর্বোচ্চ অপেক্ষা।)

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (Docker এ Postgres; DuckDB একটা npm library; আর একটা deterministic stream simulation)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-7.6-batch-stream-olap/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.6-batch-stream-olap) — `docker compose up -d --wait && npm install && npm run seed`, তারপর `npm run olap` আর `npm run stream`। পুরো setup, acceptance criteria, experiment আর teardown ওখানকার `README.md` এ আছে।

`seed` ৩০ লাখ `task_events` একই সূত্রে দুই জায়গায় বানায় — Postgres (২টা CPU তে সীমিত) আর একটা DuckDB file — আর analytics এর প্রশ্নের ফল মিলিয়ে দেখে। `olap` board এর query একা আর finance এর query সহ মাপে, তারপর একই প্রশ্ন দুই engine এ। `stream` এক দিনের ঘটনা দেরি আর একটা outage সহ বানিয়ে আটটা পদ্ধতিতে ঘণ্টার সংখ্যা গোনে।

**সৎ নোট:** Sandbox এ Postgres 17 আর DuckDB 1.5.5 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `seed` এর checksum দুই engine এ মিলেছে; `olap` কয়েকবার — প্রতিবার analytics চলার সময় OLTP এর p99 দশ গুণের বেশি বেড়েছে আর একা চললে DuckDB ~১০–১২ গুণ দ্রুত (সংখ্যা মেশিন ভেদে বদলাবে); `stream` দুবার চালিয়ে হুবহু একই output। README এর experiment ১–৪ চালানো হয়েছে (২ নম্বরে index দিয়ে, তারপর মুছে); ৫ আপনার code বদলানোর কাজ। DuckDB কে ২টা thread এ বাঁধা হয়েছে (default এ সে মেশিনের সব core নেয়) — তুলনা সৎ রাখতে। Data এর compression (২৮ MB বনাম ২৪২ MB) একটা সূত্রে বানানো data এর — আসল data তে এতটা ভালো না। `stream` কোনো আসল stream engine না, watermark এর নিয়মের একটা ছোট নকল।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **মঙ্গলবার আবার:** `npm run olap` চালান। আপনার মেশিনে OLTP এর p99 কত গুণ বাড়ল? তারপর `ANALYTICS_LOOPS=1` আর `ANALYTICS_LOOPS=8` দিয়ে — একটা ছোট table বানান (analytics query এর সংখ্যা → OLTP p99, throughput)। কোন সংখ্যা থেকে আপনি বলবেন "production এ analytics নিষেধ"?

2. **কেন দ্রুত:** Postgres এ `EXPLAIN (ANALYZE, BUFFERS)` দিয়ে analytics query চালান (`docker compose exec postgres psql -U taskflow`), আর DuckDB তে `EXPLAIN ANALYZE` (একটা ছোট script, বা `duckdb` CLI থাকলে `data/analytics.duckdb` খুলে)। দুটো plan পাশাপাশি রেখে এক প্যারাগ্রাফে লিখুন — কে কত data পড়ল, কেন।

3. **Index এর সীমা** (experiment ২): index দিয়ে analytics দ্রুত হলো — এবার finance এর দ্বিতীয় প্রশ্ন লিখুন ("প্রতিটা project এর প্রতি সপ্তাহে গড় `duration_ms`") আর দুই engine এ চালান, index থাকা অবস্থায়। Postgres এ কী হলো? DuckDB তে? তারপর index মুছে দিন।

4. **Dashboard এর lateness বাছুন:** `npm run stream` আর `OUTAGE_HOUR=-1 npm run stream` চালান, তারপর `stream.ts` এ lateness ৩০ মিনিটের একটা সারি যোগ করুন (experiment ৫)। TaskFlow এর live dashboard এর জন্য কোন lateness বাছবেন, সংশোধন সহ কিনা — দুটো সংখ্যা পাশাপাশি রেখে সিদ্ধান্ত নিন, আর UI তে user কে কী দেখাবেন।

5. **Design অংশ:** TaskFlow এর analytics এর এক পাতার design doc: (ক) কোন প্রশ্ন কোথায় চলবে (production, replica, analytics store) — অন্তত পাঁচটা প্রশ্ন সহ; (খ) data analytics store এ কীভাবে যায় — batch নাকি CDC, কত ঘনঘন, কে ব্যর্থতা টের পায়; (গ) প্রতিটা সংখ্যার জন্য event time নাকি processing time, আর late data এর নীতি; (ঘ) কোন সংখ্যা দেখলে আপনি DuckDB থেকে ClickHouse/warehouse এ যাবেন।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (সম্পূর্ণ, exit challenge সহ), 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
Current: 7.6 — Batch vs Stream, OLTP vs OLAP (Module 7 এর শেষ lesson)
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; outbox → relay → Redis Streams, idempotent consumer, BullMQ
job (retry, DLQ, আলাদা queue, backpressure); analytics: production এ নিয়মিত analytics নিষেধ
(ad-hoc replica এ statement_timeout সহ), রাতে replica → Parquet + DuckDB (finance, billing —
batch, event time, মাস শেষে কয়েক দিন পরে বন্ধ), live dashboard stream এ (event time,
lateness ১০ মিনিট, সংশোধন সহ upsert), processing time শুধু system এর metric এ; বড় হলে
CDC → ClickHouse
Terms learned (Module 7): Synchronous/Asynchronous Processing, Critical Path, Temporal
Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog, Message
Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log / Offset,
Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF, Idempotent Consumer, Retry Storm, Jitter,
Poison Message, Dead Letter Queue, Backpressure, Load Shedding, Command, Event,
Choreography, Event-carried State Transfer, Dual Write, Transactional Outbox, Change Data
Capture, OLTP, OLAP, Column Store, Batch Processing, Stream Processing, Event Time /
Processing Time, Watermark
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: Module 7 Exit Challenge
=======================
```

---

## ৮. পরের ধাপ

Exercise চালিয়ে পাঠান — বিশেষ করে ১ নম্বরের table আর ৫ নম্বরের design doc। এটা Module 7 এর শেষ lesson। রেডি হলে `next` লিখুন — **Module 7 Exit Challenge** এ যাব: একটা mini design challenge (Tier 3) যেখানে পুরো module একসাথে লাগবে — synchronous বনাম async, queue বনাম log, BullMQ এর job, idempotency আর retry, outbox, আর analytics এর পথ — একটা বাস্তব scenario তে; একটা "আপনি এগুলো পারার কথা" checklist; আর বই, ভিডিও, project এর recommendation। তারপর Module 8 — Storage Systems: এতক্ষণ data মানে ছিল database এর row আর queue এর message; এবার file — user এর upload করা attachment, ছবি, video — কোথায় রাখবেন, কীভাবে বড় file upload হবে, আর সেগুলোর ভেতরে খোঁজা যায় কীভাবে।
