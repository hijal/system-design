# TaskFlow Analytics Lab — OLTP বনাম OLAP, Batch বনাম Stream

> Lesson 7.6 — Batch vs Stream, OLTP vs OLAP · **Tier 1 — Runnable Code** (Docker এ Postgres, DuckDB library হিসেবে, আর একটা deterministic stream simulation)

## কী বানাচ্ছি

দুটো আলাদা প্রশ্ন, দুটো অংশ:

| Script           | প্রশ্ন                                                                                                                               | Lesson §  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run seed`   | TaskFlow এর এক বছরের ৩০ লাখ `task_events` — Postgres (row store) আর DuckDB (column store) এ হুবহু একই data                           | —         |
| `npm run olap`   | Production Postgres এ analytics query চালালে সাধারণ user এর query এর কী হয়? আর একই প্রশ্ন column store এ কত দ্রুত?                  | ১.২ – ১.৩ |
| `npm run stream` | "প্রতি ঘণ্টায় কয়টা task complete" — রাতের batch, processing time এর stream, আর event time + watermark এর stream: কখন ফল, কতটা ঠিক? | ১.৪ – ১.৫ |

`seed` দুটো engine এ একই সূত্রে data বানায়, আর analytics এর প্রশ্নের ফল মিলিয়ে দেখে (checksum)।

**সৎ নোট:**

- `olap` আসল database আর আসল সময় — সংখ্যা মেশিন ভেদে বদলাবে। Postgres container এ `cpus: 2`, আর DuckDB কেও
  `SET threads = 2` — যাতে তুলনাটা দুই দিকে একই CPU তে। DuckDB এখানে একটা library, একই Node process এ; আসল
  analytics store (ClickHouse, BigQuery, Snowflake, Redshift) আলাদা system, আর বড় data তে পার্থক্য আরও বড় বা ছোট
  হতে পারে।
- Data একটা সূত্রে বানানো, তাই খুব নিয়মিত — DuckDB এর compression (২৮ MB বনাম Postgres এর ২৪২ MB) আসল data তে
  এতটা ভালো হবে না। Row বনাম column এর **আকৃতিটা** আসল, অনুপাত না।
- `stream` একটা simulation: কোনো stream processing engine (Flink, Kafka Streams) না, তাদের watermark এর
  নিয়মের একটা ছোট নকল। Seed দেওয়া — প্রতিবার হুবহু একই সংখ্যা।
- যাচাই করা হয়েছে Postgres 17 আর DuckDB 1.5.5 (`@duckdb/node-api` `1.5.5-r.5`) এ।

## Prerequisite

Node.js 22+, Docker (Postgres এর জন্য)। DuckDB একটা npm package — আলাদা install লাগে না।

## Setup

```bash
docker compose up -d --wait
npm install
npm run seed        # ~২০ সেকেন্ড
```

## Run

```bash
npm run olap        # ~২৫ সেকেন্ড
npm run stream      # এক পলকে
```

Teardown:

```bash
docker compose down -v
rm -rf data
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. `npm run seed`**

```
   3,000,000 টা task event তৈরি হচ্ছে…
   Postgres: 18.5 s · table 242 MB (index সহ 396 MB)
   DuckDB:   0.8 s · file 28 MB
   checksum: Postgres 750000 / 37499250000 · DuckDB 750000 / 37499250000 → মিলেছে ✓
```

Checksum এর সংখ্যা তোমার মেশিনেও হুবহু এই হবে; সময় আলাদা হবে।

**২. `npm run olap`** (এই মেশিনে):

```
   ধাপ                          OLTP query/s   OLTP p50    OLTP p99    OLTP max   analytics শেষ হলো (গড়)
   শুধু OLTP                          15222     0.6 ms      1.1 ms    20.2 ms                       —
   OLTP + 4টা analytics                4330     0.6 ms     68.5 ms    77.1 ms       47 বার (868.8 ms)

   একই analytics প্রশ্ন (মাসিক usage, workspace ধরে), কেউ আর চলছে না, তিনবার করে:
     Postgres (row store, ২ CPU):       255.9 ms, 257.6 ms, 258.7 ms
     DuckDB   (column store, ২ thread):  28.6 ms, 21.1 ms, 21.4 ms
     ফল মিলেছে: হ্যাঁ ✓

   Postgres এর plan থেকে:
     ->  Seq Scan on task_events  (… rows=750000 loops=1)
     Buffers: shared hit=11011 read=19917
```

মিলতে হবে: analytics চলার সময় OLTP এর p99 কয়েক গুণ থেকে কয়েক দশ গুণ বাড়ে আর throughput নামে; একা চললে
DuckDB Postgres এর চেয়ে এক অঙ্কের (১০x) কাছাকাছি দ্রুত; ফল মেলে।

**৩. `npm run stream`** (deterministic):

```
   এক দিনের 49,560 টা task.completed · 90% প্রায় সাথে সাথে, 8% ১–১০ মিনিট দেরিতে, 2% ১–৬ ঘণ্টা দেরিতে · 13:00–14:00 pipeline outage

   পদ্ধতি                                   প্রথম ফল পেতে (p50 / সর্বোচ্চ)   প্রথম ফলে ভুল   খারাপতম ঘণ্টা   শেষে ভুল   বাদ পড়ল   সংশোধন
   batch (রাত ২টায়, আগের দিন)                    14.0 h / 25.0 h            0.10%          2.01%      0.10%        51        0
   stream, processing time                          0.0 s / 0.0 s           15.22%        100.86%     15.22%         0        0
   stream, event time, lateness 0                   2.7 s / 1.0 h            9.82%         99.78%      9.82%      4869        0
   stream, event time, lateness 1 min             1.0 min / 1.0 h            9.03%         90.43%      9.03%      4474        0
   stream, event time, lateness 10 min           10.0 min / 1.0 h            2.12%          2.88%      2.12%      1050        0
   stream, event time, lateness 1 h                 1.0 h / 2.0 h            1.87%          2.70%      1.87%       925        0
   stream 10 min + দেরির সংশোধন                  10.0 min / 1.0 h            2.12%          2.88%      0.00%         0     1050
   stream 10 min + রাতের batch                   10.0 min / 1.0 h            2.12%          2.88%      0.10%        51        0
```

## কী দেখার জন্য এটা বানানো

- **`olap` এর প্রথম table:** analytics এর চারটা query production এর p99 কে ১.১ ms থেকে ~৭০ ms এ নিল, আর
  প্রতি সেকেন্ডের query ১৫ হাজার থেকে ৪ হাজারে। সাধারণ user এর query নিজে বদলায়নি — CPU আর disk এর জন্য লাইনে
  দাঁড়িয়েছে।
- **Plan এর `Buffers`:** ১১০১১ + ১৯৯১৭ page × 8 KB ≈ পুরো table (২৪২ MB) — প্রশ্নটার দরকার আটটার মধ্যে তিনটা
  column, কিন্তু row store এ column আলাদা করে পড়া যায় না।
- **DuckDB ~১০ গুণ দ্রুত, একই CPU তে:** শুধু দরকারি column পড়ে, সেগুলো compressed, আর একসাথে অনেক মান নিয়ে
  কাজ করে (vectorized)।
- **`stream` এর processing time সারি:** দেরি ০ — কিন্তু খারাপতম ঘণ্টায় ১০০% ভুল। Outage এর ঘণ্টা (১৩টা) প্রায়
  শূন্য দেখায় আর ১৪টা প্রায় দ্বিগুণ — খবর যখন পৌঁছেছে সেই ঘণ্টায় গোনা হয়েছে, ঘটনা যখন ঘটেছে তখন না। আর
  কখনো ঠিক হয় না।
- **Event time, lateness 0 আর 1 min:** outage এর পরে ১৪টার সাধারণ খবর আসতেই watermark ১৪টা পেরোয় — ১৩টার
  ঘণ্টা বন্ধ, আর জমে থাকা খবর এসে পৌঁছায় বন্ধ দরজায় (হাজারের বেশি বাদ)। Lateness ১০ মিনিটে জমে থাকা খবর
  ঢোকার সময় পায়।
- **"প্রথম ফল পেতে সর্বোচ্চ ১.০ h":** outage এর সময় কোনো খবর আসে না, তাই watermark এগোয় না — ১২টার ঘণ্টার ফল
  ১৪টা পর্যন্ত আটকে থাকে। Watermark ঘটনা দেখেই এগোয়; উৎস চুপ থাকলে ঘড়িও থামে।
- **শেষ দুই সারি:** দ্রুত আর শেষে ঠিক — দুটোই পাওয়া যায়, কিন্তু দাম হলো ফল একবার বলে পরে বদলানো (downstream
  কে সংশোধন সামলাতে হবে), বা দুটো pipeline।

## নিজে ভেঙে দেখো (Experiments)

1. **একটা analytics query:** `ANALYTICS_LOOPS=1 npm run olap`। OLTP এর p99 কত হলো? (এই মেশিনে ১.২ ms — প্রায়
   অপরিবর্তিত, কিন্তু throughput ১৫৪৩৪ থেকে ৯৯০৭।) একটা report "ক্ষতি করে না" বলা কি নিরাপদ? চারটা একসাথে
   চললে?
2. **Index দিয়ে বাঁচানো যায়?** Postgres এ `CREATE INDEX task_events_analytics ON task_events (type, workspace_id, occurred_at) INCLUDE
(duration_ms);` দাও (`docker compose exec postgres psql -U taskflow`), তারপর `npm run olap`। Plan বদলাল?
   Analytics কত দ্রুত হলো, আর table এর আকার আর প্রতিটা insert এর দাম কী হলো (Lesson 5.4)? (এই মেশিনে: index-only
   scan, ২৫৭ ms থেকে ১৪৩ ms; table + index ৩৯৬ MB থেকে ৫৬৫ MB; আর analytics চলার সময় OLTP এর p99 তবু ~৬৯ ms।)
   শেষে index টা `DROP INDEX task_events_analytics;` দিয়ে মুছে দিও।
3. **Outage ছাড়া:** `OUTAGE_HOUR=-1 npm run stream`। Processing time এর খারাপতম ঘণ্টা কত? (এই মেশিনে ৬.৪৬% —
   কাজের সময় শুরু আর শেষের ঢালে।) এখন processing time কি "যথেষ্ট ভালো"? কোন dashboard এর জন্য হ্যাঁ, কোনটার
   জন্য না?
4. **দেরিতে আসা বেশি:** `LATE_SHARE=0.1 npm run stream` (১০% ঘটনা ঘণ্টাখানেক দেরিতে)। Lateness ১০ মিনিটের stream
   এর ভুল কত? (এই মেশিনে ~১০%।) সংশোধন ছাড়া এই সংখ্যা দিয়ে billing করা যায়?
5. **Lateness এর দাম:** `stream.ts` এ একটা নতুন সারি যোগ করো — lateness ৩০ মিনিট, সংশোধন সহ। তোমার dashboard এর
   জন্য কোন lateness বাছবে — কোন দুটো সংখ্যা পাশাপাশি রেখে সিদ্ধান্ত নিলে?

## Project Structure

```
lesson-7.6-batch-stream-olap/
├── docker-compose.yml   # Postgres 17, cpus: 2, port 5444
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
├── .gitignore           # data/ commit হয় না
├── data/                # (seed বানায়) analytics.duckdb
└── src/
    ├── data.ts          # দুই engine এর জন্য একই সূত্রের seed SQL, OLTP আর analytics এর query
    ├── seed.ts          # দুই জায়গায় data, আকার, checksum
    ├── olap.ts          # OLTP একা, OLTP + analytics, তারপর Postgres বনাম DuckDB
    ├── stream.ts        # batch, processing time, event time + watermark (lateness, সংশোধন)
    └── random.ts        # seed দেওয়া random, percentile
```

সব env: `olap` — `PHASE_MS` (10000), `CLIENTS` (8), `ANALYTICS_LOOPS` (4); `seed` — `ROWS` (3000000); `stream` —
`SEED` (7), `EVENTS_PER_HOUR` (2000), `LATE_SHARE` (0.02), `OUTAGE_HOUR` (13, `-1` = নেই); Postgres এর ঠিকানা
`DATABASE_URL`।
