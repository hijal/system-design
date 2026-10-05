# TaskFlow Connection Pool, N+1 আর Hydration — মেপে দেখা

> Lesson 5.6 — Connection Pooling, N+1, Query Optimization · **Tier 1 — Runnable Code**

## কী বানাচ্ছি

তিনটা script, TaskFlow এর database access এর তিনটা লুকানো খরচ মাপতে:

| Script              | কী দেখায়                                                                                         | Lesson §  |
| ------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `npm run pool`      | নতুন connection বনাম pool; pool size বাড়ালে throughput/latency; `max_connections` ছাড়ালে কী হয় | ১.১ – ১.৪ |
| `npm run nplusone`  | একই dashboard চারভাবে: N+1, `include`, batching; দুটো hasMany এর cartesian explosion              | ১.৫       |
| `npm run hydration` | ১ লাখ row — Sequelize model instance বনাম `raw: true` বনাম দরকারি column                          | ১.৬       |

`npm run pool -- 2` দিলে শুধু ধাপ ২ চলে (১, ২, ৩ যেকোনোটা)।

## Prerequisite

Node.js 22+ এবং Docker (শুধু PostgreSQL চালানোর জন্য)।

Port **5437** — তোমার মেশিনের Postgres (5432) বা আগের exercise গুলোর (5433–5436) সাথে সংঘাত এড়াতে।

**গুরুত্বপূর্ণ:** `docker-compose.yml` এ Postgres container কে ইচ্ছা করে **২টা CPU core** এ সীমিত রাখা
হয়েছে (`cpus: '2'`), যাতে pool size এর পরীক্ষা যেকোনো মেশিনে একই রকম ফল দেয়।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run pool        # ~1 minute
npm run nplusone
npm run hydration
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

সব সংখ্যা আমার মেশিনে মাপা (Node 26, Postgres 17, database container এ ২টা core)। তোমার
সংখ্যা ভিন্ন হবে; **আকার আর অনুপাত** মেলার কথা।

**১. `npm run pool`**

```
1. 200 "SELECT 1" one at a time
   new connection every time      5.78 ms / query
   from the pool                  0.13 ms / query   (~44x faster)

2. Pool size — 64 requests at once, 320 queries in total (database: 2 CPU cores)
   pool max │   CPU query: q/s    p50 ms    p99 ms │  WAIT query: q/s    p50 ms    p99 ms
          1 │       26      2492      2518        │       48      1329      1334
          2 │       50      1269      1298        │       97       662       665
          4 │       50      1286      1302        │      194       328       333
          8 │       45      1402      1502        │      386       166       167
         16 │       26      2487      2696        │      773        82        84
         32 │       26      2460      3561        │     1535        41        45
         64 │       26      2397      5500        │     1914        20        85

3. 5 app instances × pool max 25 = 125 connections wanted (Postgres max_connections = 100)
   succeeded: 75
   failed: 50 → "sorry, too many clients already"

   when one instance's own pool runs out (max 2, acquire timeout 1s, 10 queries of 0.8s):
   succeeded: 4, ConnectionAcquireTimeoutError: 6
```

ধাপ ২ কয়েকবার চালিয়ে প্রায় হুবহু একই সংখ্যা এসেছে। ধাপ ৩ এ কতগুলো ব্যর্থ হয় সেটা প্রতিবার
বদলায় (আমার তিনটা রানে ৪৬, ৬৬, ৫০) — ১০০টা slot কে কখন দখল করে সেটা timing এর উপর নির্ভর করে।
কিন্তু **ব্যর্থতা সবসময় আসে**। শেষ লাইনটা (৪ আর ৬) প্রতিবার একই।

**২. `npm run nplusone`**

```
1. Dashboard: 50 projects → 1000 tasks → assignee names   (same result for all three? true)
   approach                      queries     rows     measured   +1 ms RTT*
   a. N+1 (findByPk in a loop)      1051    2,050     210.0 ms      1261 ms
   b. include (one JOIN)               1    1,000       7.2 ms         8 ms
   c. batching (3 with IN)             3    1,250       3.7 ms         7 ms

2. Two hasMany at once: project → tasks (20) + members (10)
   approach                      queries     rows     measured   +1 ms RTT*
   include, one JOIN                   1   10,000      28.2 ms        29 ms
   include, separate: true             3    1,550       8.7 ms        12 ms
```

`query` আর `rows` কলাম deterministic — হুবহু মিলবে। শেষ কলামটা **হিসাব, মাপা না** (নিচে দেখো)।

**৩. `npm run hydration`**

```
Hydration: reading 100,000 tasks — the same query, returned in different shapes
   Model instance (default)              200 ms   (100,000 rows, 1.0x)
   raw: true                              96 ms   (100,000 rows, 2.1x)
   raw: true + only needed columns        68 ms   (100,000 rows, 2.9x)
```

## কী দেখার জন্য এটা বানানো

1. **Connection খোলা দামি, তাই pool।** প্রতি query তে নতুন connection ~৪৪ গুণ ধীর — আর এটা
   একই মেশিনে; network পেরোলে TCP আর TLS handshake (Lesson 2.2) যোগ হয়।
2. **বড় pool ≠ দ্রুত।** CPU এর কাজে throughput এর চূড়া pool = ২ এ — ঠিক database এর core সংখ্যায়।
   তার বেশিতে throughput **কমে** (৫০ → ২৬ q/s), আর p99 বাড়তে থাকে। অপেক্ষার কাজে (WAIT)
   pool বাড়ালে প্রায় সমানুপাতে বাড়ে। Pool size ঠিক হয় **connection গুলো কী করছে** তার উপর।
3. **N+1 local এ লুকিয়ে থাকে।** এখানে N+1 "মাত্র" ২১০ ms। কিন্তু ১০৫১টা query — app আর DB আলাদা
   machine এ থাকলে প্রতিটা round trip এর দাম যোগ হয়। Production এ এটাই ধীর page এর সবচেয়ে
   সাধারণ কারণ।
4. **একটা query সবসময় সেরা না।** দুটো hasMany একটা JOIN এ আনলে ১০,০০০ row — `separate: true`
   দিয়ে ৩টা query তে ১,৫৫০ row, আর দ্রুত।

**শেষ কলামের হিসাব (`+1ms RTT হলে`):** exercise এ app আর database একই মেশিনে, তাই round trip
প্রায় শূন্য। Production এ তারা আলাদা machine এ, আর প্রতিটা query তে অন্তত একটা network round trip
লাগে। কলামটা শুধু `মাপা সময় + query সংখ্যা × ১ ms` — একটা সরল অনুমান, মাপা ফল না। বাস্তব round
trip তোমার infrastructure অনুযায়ী কম-বেশি হবে; নিজে মাপতে experiment ৩ দেখো।

## নিজে ভেঙে দেখো (Experiments)

1. **Core বাড়াও।** `docker-compose.yml` এ `cpus: '2'` কে `'4'` করো, `docker compose up -d --wait`, তারপর
   `npm run pool -- 2`। CPU কলামের চূড়া এখন কোথায়? Pool size এর নিয়মটা নিজের ভাষায় লেখো।

2. **Pool exhaustion এর সময় বাড়াও।** `src/pool.ts` এর শেষ অংশে `acquire: 1_000` কে `60_000` (Sequelize
   এর default) করো। কতগুলো সফল হলো, আর শেষটা কতক্ষণ অপেক্ষা করল? একটা ব্যস্ত API তে ৬০ সেকেন্ড
   অপেক্ষা করা request user এর চোখে কেমন দেখায় — আর দ্রুত ব্যর্থ হওয়া কেন কখনো কখনো ভালো?

3. **Network latency নকল করো।** Linux এ: `docker compose exec postgres sh -c "apk add iproute2 && tc qdisc add dev eth0 root netem delay 1ms"`
   (container এ `NET_ADMIN` capability লাগতে পারে — না চললে এটা বাদ দাও)। তারপর `npm run nplusone` —
   শেষ কলামের হিসাব আর আসল মাপা সময় কতটা কাছাকাছি?

4. **N+1 নিজে খুঁজে বের করো।** `src/nplusone.ts` এর `eager()` থেকে ভেতরের `include: [{ model: User, as: 'assignee' }]`
   সরিয়ে দাও, আর `flatMap` এর ভেতরে `t.assignee?.name` এর বদলে `(await User.findByPk(t.assigneeId))?.name` লেখো
   (এর জন্য map টা async করতে হবে)। Query সংখ্যা কত হলো? Code review এ এটা ধরা কতটা সহজ?

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-5.6-pooling-nplusone/
├── docker-compose.yml   # শুধু Postgres (5437), ২টা CPU core এ সীমিত
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts            # প্রতিবার নতুন pool সহ Sequelize বানানোর helper, percentile
    ├── models.ts        # User, Project, Task, Member + association
    ├── pool.ts          # connection এর দাম, pool size sweep, max_connections, acquire timeout
    ├── nplusone.ts      # N+1 / include / batching, cartesian explosion; query ও row গোনা
    └── hydration.ts     # Model instance বনাম raw
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, Postgres 17, Sequelize 6.37):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- `npm run pool` — ধাপ ২ দুবার (সংখ্যা প্রায় হুবহু এক), ধাপ ৩ তিনবার (ব্যর্থতা ৪৬–৬৬, প্রতিবার আছে)
- `npm run nplusone` দুবার — query আর row সংখ্যা হুবহু এক, তিনটা পদ্ধতির ফল একই data
- `npm run hydration` দুবার — অনুপাত ২.১x আর ~৩x, দুবারই
- Experiment ৩ (`tc netem`) এই মেশিনে চালিয়ে দেখা **হয়নি** — Docker এর capability সেটিং এর উপর
  নির্ভর করে
