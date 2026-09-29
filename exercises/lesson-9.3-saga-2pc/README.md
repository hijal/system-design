# TaskFlow Saga vs 2PC Lab — দুটো database, একটা "task তৈরি"

> Lesson 9.3 — Distributed Transactions: Saga, 2PC · **Tier 1 — Runnable Code** (Docker এ Postgres 17; দুটো আলাদা database দুটো "service")

## কী বানাচ্ছি

Lesson 9.1 এর সমস্যা: "task তৈরি" মানে tasks_svc এ task এর row আর billing_svc এ workspace এর `task_count + 1` —
দুটো আলাদা database, কোনো ভাগ করা transaction নেই, crash এ ৮৩টা অমিল। এখানে সেই একই operation (একই seed, একই ৮৩টা
crash) দুটো পুরনো উত্তর দিয়ে:

| Script          | প্রশ্ন                                                                                                                                                                                     | Lesson §  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run twopc` | Postgres এর আসল `PREPARE TRANSACTION` দিয়ে two-phase commit: crash এ অমিল হয় কি, দাম কত; coordinator PREPARE এর পরে মরলে বাকিদের কী হয়; তারপর কে সিদ্ধান্ত নেয়                         | ১.২ – ১.৩ |
| `npm run saga`  | Saga — billing এ সংরক্ষণ, তারপর task, archived project এ compensation; crash, saga এর log থেকে recovery, idempotent না হলে কী হয়; আর সীমার কাছে একসাথে অনেক saga — isolation না থাকার দাম | ১.৪ – ১.৭ |

**সৎ নোট:**

- দুটো "service" আসলে একই Postgres container এর দুটো database — আলাদা machine না। দুটোর fsync একই disk এ, network এর
  দেরি নেই। Service এর code একই Node process এ function; network call (Lesson 9.1, 9.2) এখানে মাপা হচ্ছে না — শুধু
  database এর round trip আর commit।
- "Crash" মানে process মারা যাওয়ার ভান: 2PC এ connection কেটে দেওয়া (Postgres তখন নিজেই prepare না হওয়া transaction
  ROLLBACK করে — আসল crash এর মতো), saga তে operation টা থেমে যাওয়া। কোন operation crash করবে সেটা seed দেওয়া — Lesson 9.1
  এর একই ৮৩টা।
- "Coordinator মারা গেল" মানে: PREPARE এর পরে COMMIT PREPARED পাঠানো হলো না। Prepared transaction গুলো **আসল** — Postgres
  এ থেকে যায়, lock ধরে রাখে (Postgres restart হলেও থাকে), `pg_prepared_xacts` এ দেখা যায়।
- `saga` এর "archived project" ব্যবসার কারণে ব্যর্থ হওয়ার একটা ভান — কোন project archived সেটা seed দেওয়া।
- সময়ের কলাম (ops/s, p50, p99) machine আর run ভেদে অনেক ওঠানামা করে (এই machine এ monolith ১৯০০–৩৭০০ ops/s); গোনার
  কলাম (সফল, অমিল, আটকে থাকা, সীমা পেরোনো) প্রতিবার একই। ব্যতিক্রম: `saga` এর অংশ খ এর saga এর সারি — ৪টা চেষ্টার কোন
  দুটো আগে সংরক্ষণ পায় সেটা timing এর ব্যাপার, তাই "তৈরি" (পাঁচ run এ ৭৪–৭৮) আর "ফেরানো" ওঠানামা করে।
- যাচাই করা হয়েছে Node 26 আর Postgres 17 এ।

## Prerequisite

Node.js 22+, Docker।

## Setup

```bash
npm install
docker compose up -d --wait
```

`docker-compose.yml` এ Postgres চালানো হয় `max_prepared_transactions=100` দিয়ে — এটা ছাড়া (default 0) Postgres এ
`PREPARE TRANSACTION` চলে না। অন্য কোনো Postgres এ চালালে script থেমে বলে দেবে।

## Run

```bash
npm run twopc   # ~১৫ সেকেন্ড
npm run saga    # ~১০ সেকেন্ড
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run twopc` (এই machine এ):

```
── ক. 3000 টা "task তৈরি", 100 টা workspace, 83 টায় প্রথম লেখার পরে crash (3%), 8 টা একসাথে ──
   পথ                                    সফল   ব্যর্থ  task row  counter  অমিল ws   ফল                    ops/s      p50
   monolith: একটা transaction (9.1)       2917     83     2917     2917        0   মেলে                   2775   2.3 ms
   services: দুটো আলাদা লেখা (9.1)        2917     83     3000     2917       57   83 টা task বিনা বিলে   1594   4.4 ms
   services: 2PC                          2917     83     2917     2917        0   মেলে                   1027   7.1 ms

── খ. Coordinator মারা গেল PREPARE এর পরে, COMMIT এর আগে — 5 টা workspace এর transaction "in doubt" ──
   prepared হয়ে পড়ে আছে: tasks_svc এ 5 টা, billing_svc এ 5 টা · coordinator এর log এ "commit": 2 টা
   workspace 1 এর task_count পড়া (SELECT): 0 — 0.4 ms, আটকায়নি (MVCC: commit হওয়া পুরনো মান)
   তারপর 3 s ধরে 8 জন client নতুন task বানাচ্ছে (2PC, 100 টা workspace এ random):
   billing এর lock_timeout    সফল   ops/s   lock এ ব্যর্থ       p99   শেষে আটকে থাকা client   সবাই আটকে গেল
   নেই (Postgres default)       90      30             0   23.9 ms              8 / 8   156.8 ms এ
   200 ms                     1348     449            57  317.8 ms              0 / 8   —

── গ. তারপর: in-doubt transaction গুলোর সিদ্ধান্ত ──
   কে সিদ্ধান্ত নিল                             tasks_svc              billing_svc            অমিল ws   ফল
   coordinator ফিরে এসে, log ধরে (নেই → rollback) commit 2 · rollback 3  commit 2 · rollback 3       0   মেলে
   billing অপেক্ষা না করে নিজে ROLLBACK, তারপর coordinator commit 2 · rollback 3  commit 0 · rollback 5       2   2 টা task বিনা বিলে
```

মিলতে হবে: অংশ ক তে 2PC এর অমিল ০, আর ops/s monolith এর চেয়ে অনেক কম (এই machine এ পাঁচ run এ ১০২৭–১১৬৫, monolith
১৯৭৩–৩৬৬৬)। অংশ খ তে `lock_timeout` ছাড়া শেষে ৮ জনের ৮ জনই আটকে, আর "সফল" ৯০ এর কাছাকাছি; ২০০ ms দিয়ে কেউ আটকে থাকে না,
কিন্তু কিছু request ব্যর্থ। অংশ গ তে প্রথম সারিতে অমিল ০, দ্বিতীয়তে ২।

`npm run saga`:

```
── ক. 3000 টা "task তৈরি" — 83 টায় billing এ লেখার পরে crash (3%), 44 টার project archived, 8 টা একসাথে ──
   পথ                                        সম্পন্ন  archived  crash  অসমাপ্ত  task row  counter  অমিল ws   ফল                    ops/s      p50
   দুটো লেখা, saga ছাড়া                      2873        44     83         —     2873     3000       58   127 টা বিল, task নেই   1979   3.9 ms
   saga (idempotent ধাপ)                      2873        44     83        83     2873     2956       57   83 টা বিল, task নেই     966   7.9 ms
     … recovery: log পড়ে এগোনো (234.1 ms)    2955        45      —         0     2955     2955        0   মেলে                      —        —
   saga, ধাপ idempotent না                    2873        44     83        83     2873     2956       57   83 টা বিল, task নেই     992   7.7 ms
     … recovery: log পড়ে এগোনো (282.5 ms)    2955        45      —         0     2955     3038       57   83 টা বিল, task নেই       —        —

── খ. সীমার কাছে: 50 টা workspace, সীমা 10, আগে থেকে 8 টা task — প্রতিটায় 4 টা "task তৈরি" একসাথে, 41 টার project archived ──
   নিয়ম                                     তৈরি  ফেরানো  "সীমা শেষ"  সীমা পেরোনো ws  বাড়তি task  ভুল "সীমা শেষ"
   আগে সংরক্ষণ → task → দরকারে ফেরত (saga)     75      25         100              0           0              25
   আগে দেখা → task → শেষে usage বাড়ানো       159       —           0             42          61               0
```

মিলতে হবে: idempotent saga তে recovery এর পরে অসমাপ্ত ০ আর অমিল ০; idempotent না হলে recovery এর পরেও ঠিক ৮৩টা বাড়তি বিল।
অংশ খ তে saga এর সারিতে সীমা পেরোনো ০ আর "সীমা শেষ" ১০০ এর কাছে, ভুল "সীমা শেষ" ২০–৩০ এর মধ্যে; "আগে দেখা" তে ৪২টা workspace
সীমা পেরোয়। (Archived ৪৪ থেকে ৪৫: ৮৩টা crash এর একটার project ও archived ছিল — recovery তে সেটা ফেরানো হয়।)

## কী দেখার জন্য এটা বানানো

- **2PC সত্যিই atomic:** একই ৮৩টা crash, অমিল ০ — কারণ prepare এর আগে মরলে দুই দিকই নিজে থেকে rollback। কিন্তু প্রতিটা
  operation এ দুটো PREPARE (disk এ), coordinator এর log এ একটা লেখা, দুটো COMMIT PREPARED — throughput monolith এর অর্ধেক
  থেকে তিন ভাগের এক ভাগ, দুটো আলাদা লেখার চেয়েও কম।
- **2PC blocking:** PREPARE এর পরে participant আর নিজে সিদ্ধান্ত নিতে পারে না — row এর lock ধরে বসে থাকে। ১০০টা workspace
  এর মধ্যে মাত্র ৫টা in doubt, অথচ `lock_timeout` ছাড়া ~১৫০ ms এর মধ্যে **সব** client সেই ৫টার কোনো একটায় আটকে গেল — বাকি
  ৯৫টা workspace এর কাজও থামল। পড়া (SELECT) আটকায় না — MVCC।
- **সিদ্ধান্ত শুধু coordinator এর:** সে ফিরে এসে log পড়লে সব মেলে। কোনো participant অপেক্ষা না করে নিজে সিদ্ধান্ত নিলে
  (এখানে billing এর ROLLBACK) — যেখানে coordinator commit ঠিক করেছিল, সেখানে অমিল। অপেক্ষা ছাড়া নিরাপদ পথ নেই।
- **Saga তে lock নেই, কিন্তু মাঝপথ দেখা যায়:** crash এর ঠিক পরে saga ও ৯.১ এর মতোই ৮৩টা অমিল দেখায়। পার্থক্য: log জানে
  কোন ৮৩টা মাঝপথে — recovery সেগুলো শেষ করে, অমিল ০। Saga মানে "শেষমেশ মেলে", "সবসময় মেলে" না।
- **Idempotency ছাড়া recovery বিপদ:** log এ 'started' মানে billing এ লেখা হয়েছে কিনা জানা নেই — আবার ডাকতেই হয়। ধাপ
  idempotent না হলে দ্বিতীয়বার গোনা — recovery নিজেই ৮৩টা বাড়তি বিল বানায়।
- **Saga এ isolation নেই:** অন্য saga গুলো মাঝপথের অবস্থা দেখে। আগে সংরক্ষণ করলে সীমা কখনো পেরোয় না, কিন্তু যে সংরক্ষণ
  পরে ফেরত যায় সেটা অন্যকে ভুল "না" বলায়; আগে শুধু দেখে পরে গুনলে ৪২টা workspace সীমা পেরোয়। কোন ভুলটা সহ্য করা যায়,
  সেটা ব্যবসার সিদ্ধান্ত।

## নিজে ভেঙে দেখো (Experiments)

1. **একটা মাত্র in-doubt transaction:** `IN_DOUBT=1 LOGGED=0 npm run twopc` — ১০০টা workspace এর একটা। `lock_timeout` ছাড়া
   কতক্ষণে সবাই আটকায়? আগে অনুমান করো (প্রতিটা client এর প্রতিটা operation এ ১% সম্ভাবনা)। (এই machine এ: ৮০৬ ms এ ৮/৮
   আটকে; `DURATION_MS=10000` দিয়েও ৮৩২ ms — তারপর বাকি ৯ সেকেন্ড শূন্য।)
2. **Crash ছাড়া দাম:** `CRASH_RATE=0 npm run twopc` — সব মেলে। ops/s? (এই machine এ: monolith ২৮৯৯, দুটো লেখা ১৪৩১,
   2PC ৮৮৮।) কোন কাজ গুলো 2PC কে ধীর করে — `twoPhase()` এ গুনে দেখো কয়টা ধারাবাহিক round trip আর কয়টা disk এ লেখা।
3. **Network এর দেরি ছাড়াও:** `STEP_MS=0 npm run saga` — অংশ খ তে saga এর ধাপের মাঝে কোনো ইচ্ছাকৃত দেরি নেই। "আগে দেখা"
   এখনো সীমা পেরোয়? (এই machine এ: হ্যাঁ, একই ৪২টা workspace — ৪টা চেষ্টা একসাথে এলে কয়েকটা round trip এর ফাঁকই যথেষ্ট।)
4. **Compensation এর মাঝে crash** (code বদলানো): `saga.ts` এর `advance()` এ `'compensating'` log এর পরে আর `release()`
   এর আগে একটা crash যোগ করো (যেমন archived হওয়া প্রতি তৃতীয় saga তে)। Recovery কী করে? তারপর `release()` এর idempotent
   অংশ সরিয়ে দাও (শুধু `task_count - 1`) আর recovery দুবার চালাও — কী ভাঙে?
5. **"সীমা শেষ" নাকি "একটু পরে"** (code বদলানো): billing এর খাতায় সংরক্ষণের দুটো অবস্থা রাখো — `reserved` (pending) আর
   `confirmed` (task হয়ে গেছে, saga এর তৃতীয় ধাপ)। সীমা ভরা কিন্তু কোনোটা pending থাকলে "সীমা শেষ" না বলে "busy, আবার
   চেষ্টা করো" ফেরত দাও, আর orchestrator ২০ ms পরে একবার আবার চেষ্টা করুক। ভুল "সীমা শেষ" কত হয়? দাম কী?

## Project Structure

```
lesson-9.3-saga-2pc/
├── docker-compose.yml   # Postgres 17 (5448), max_prepared_transactions=100 — taskflow, tasks_svc, billing_svc
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── db.ts            # pool, Crash, database তৈরি, পড়ে থাকা prepared transaction পরিষ্কার, task বনাম counter এর হিসাব
    ├── twopc.ts         # 2PC: coordinator (twoPhase), in-doubt, lock এর উপর load, recovery, participant এর নিজের সিদ্ধান্ত
    ├── saga.ts          # saga: billing (reserve/release), work (createTask), orchestrator (log, advance, recover), সীমার কাছে দুই নিয়ম
    └── random.ts        # seed দেওয়া PRNG, percentile, format, sleep
```

সব env — `twopc`: `OPS` (3000), `WORKSPACES` (100), `CRASH_RATE` (0.03), `CONCURRENCY` (8), `SEED` (7), `IN_DOUBT` (5),
`LOGGED` (2), `DURATION_MS` (3000), `LOCK_TIMEOUT_MS` (200)। `saga`: `OPS`, `WORKSPACES`, `CRASH_RATE`, `CONCURRENCY`,
`SEED` একই, আর `PROJECTS` (200), `ARCHIVED_RATE` (0.02), `NEAR_WORKSPACES` (50), `LIMIT` (10), `USED` (8), `ATTEMPTS` (4),
`NEAR_ARCHIVED_RATE` (0.25), `STEP_MS` (20)। দুটোতেই `DATABASE_URL`।
