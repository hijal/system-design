# TaskFlow Deployment Lab — Rollout, Canary, Feature Flag, Graceful Shutdown, Zero-Downtime Migration

> Lesson 10.6 — Deployment: Blue-Green, Canary, Feature Flag, Zero-Downtime Migration · **Tier 1 — Runnable Code**
> (তিনটা deterministic simulation, localhost এ একটা আসল HTTP rolling restart, আর আসল PostgreSQL এ দুটো migration lab)

## কী বানাচ্ছি

একটা পরিবর্তন production এ আনার প্রতিটা ধাপ পাঁচটা script এ। একটা খারাপ version কতজনকে ছোঁয়, কে ধরে আর কখন। একটা
instance বদলানোর সময় কয়টা request মরে। একটা flag কীভাবে ভাগ করলে user লাফায় না। আর database এর কোন পরিবর্তন চলমান
app কে আটকায়, কোনটা আটকায় না।

| Script            | প্রশ্ন                                                                                                                         | Lesson §  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run rollout` | তিন রকম bug × ছয়টা কৌশল (big-bang, rolling, blue-green, তিন রকম canary) — কত খারাপ request, কতজন user, কে ধরে? Canary কত বড়? | ১.৩ – ১.৪ |
| `npm run flags`   | Percentage এর ভাগ (এলোমেলো, hash), kill switch কত দ্রুত, আর দুই service একই flag আলাদা ভাবে দেখলে কী হয়                       | ১.৫       |
| `npm run drain`   | চারটা আসল `node:http` instance আর একটা LB — rolling restart এ হঠাৎ kill, শুধু `close()`, আর graceful shutdown                  | ১.২       |
| `npm run locks`   | আসল Postgres এ ১০ লাখ row — কোন `ALTER`, index, backfill আর `NOT NULL` চলমান app কে আটকায়; lock queue আর `lock_timeout`       | ১.৭       |
| `npm run rename`  | আসল Postgres + Sequelize — `title → name` rename, পুরনো আর নতুন code একসাথে চলার সময়: এক ধাপে বনাম expand/contract            | ১.৮       |

**সৎ নোট:**

- **`rollout` আর `flags` deterministic simulation।** কোনো আসল server, LB বা flag service নেই — seed দেওয়া PRNG, প্রতি
  সেকেন্ডে ৩০০টা নকল request। দুবার চালালে output byte ধরে হুবহু এক।
- **`drain` আসল HTTP**, localhost এ — একটা ছোট round-robin LB (নিজের হাতে লেখা, health check আর ঐচ্ছিক retry সহ) আর
  চারটা instance, একই process এ। Request এর কাজ `setTimeout` দিয়ে নকল (~৪০ ms, warm-up এর সময় +৪০০ ms)। সংখ্যা run ভেদে
  কয়েক শতাংশ বদলায়, কিন্তু ক্রম বদলায় না।
- **`locks` আর `rename` আসল PostgreSQL 17** (Docker)। Lock, rewrite, error message — সব Postgres এর নিজের। সময় তোমার
  machine এর উপর নির্ভর করে; ১০ লাখ row এ যা ৭০০ ms, ১০ কোটিতে তা মিনিট।
- **ধরে নেওয়া সংখ্যা** (model এর input, মাপা না): alert বাজার পরে মানুষের সিদ্ধান্তে ১০ মিনিট; big-bang এর rollback deploy ৫
  মিনিট; rolling এ প্রতি ২ মিনিটে একটা instance; canary এর ধাপ ১০ মিনিট; segment = traffic এর ১%; baseline error ০.১%।
  প্রতিটা environment variable দিয়ে বদলানো যায়।
- **যাচাই করা হয়েছে** Node 26 আর Postgres 17.11 এ: `tsc --noEmit`, ESLint আর Prettier clean; `rollout` আর `flags` দুবার করে
  (হুবহু এক); `drain`, `locks` আর `rename` দুবার করে (সংখ্যা কাছাকাছি, ক্রম আর শূন্য গুলো একই)।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। `locks` আর `rename` এর জন্য Docker। Port **5449** (আগের exercise গুলো 5433–5448);
`drain` localhost এর 7610–7614 port ব্যবহার করে।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run rollout
npm run flags
npm run drain
npm run locks
npm run rename
```

`drain` ~১ মিনিট ৪০ সেকেন্ড, `locks` ~১ মিনিট, `rename` ~১ মিনিট ১৫ সেকেন্ড। `locks` আর `rename` প্রতিবার table নতুন করে
বানায়।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run rollout` — একটা bug যা মাত্র ১% traffic কে ছোঁয়, সেটা কোনো alert বাজায় না; শুধু canary ধরে:

```
20% errors on big business boards (1% of traffic)
big-bang (all at once)                             4,164        582 (1%)    missed                 —           —
canary, gate: error, sticky per user                   5          5 (0%)    11 min       gate, at 5%      12 min

10% of requests slow (> 1 s), no errors
canary, gate: error, sticky per user              28,010    21,751 (36%)    32 min     alert → human      42 min
canary, gate: error + latency + segment               24         23 (0%)   1.0 min       gate, at 1%     1.5 min

canary       time  canary request    +0.2% hit     +1% hit   false pos.  checked per minute
1%          30 min         5,400         80%        100%        1.0%                5.5%

random per request                  35,663 (59%)                35,663 (59%)
sticky per user                       2,963 (5%)                      0 (0%)
```

`npm run flags` — hash এ flag এর নাম না মেশালে একই ১০% user সব experiment এ; দুই service আলাদা key দিয়ে দেখলে এক
তৃতীয়াংশ request অমিল:

```
hash(user)                     5,869 (10%)                   0             5,869
hash(flag + user)              6,041 (10%)                   0               616

flag, streaming push                             3 s             3 s                  40
no flag: rollback deploy                      11 min          11 min               9,900

BFF hash(user), API hash(session)                    180,000   61,331 (34.07%)
BFF decides once, sends it in a header               180,000         0 (0.00%)
```

`npm run drain` — graceful সারিতে ব্যর্থ শূন্য; বাকিগুলোতে কয়েক শতাংশ:

```
no health check, abrupt kill                   3,090         130          35     165 (5.34%)       289    485 ms
health check, abrupt kill, LB GET retry        3,132           0          20      20 (0.64%)       254    482 ms
health check, only close() on SIGTERM          3,146         111          36     147 (4.67%)       264    484 ms
graceful: readiness → wait → close             4,252           0           0       0 (0.00%)         3    157 ms
```

`npm run locks` — `ADD COLUMN` নিজে মুহূর্তের, কিন্তু একটা লম্বা query এর পেছনে দাঁড়ালে পুরো app তার পেছনে লাইনে:

```
ADD COLUMN archived boolean DEFAULT false          10 ms       15          2 ms          3 ms          0      0
ADD COLUMN score float DEFAULT random()           669 ms       38        646 ms        646 ms          8      0
ADD COLUMN priority int, behind a 6 s query       6.05 s      476        5.70 s        5.70 s          8      0
the same, lock_timeout 200 ms + retry             6.38 s    7,421        200 ms        202 ms          0      0
all in one UPDATE                                 4.92 s      483          0 ms        4.83 s          8      0
in batches (10,000 each, 20 ms apart)             6.16 s    8,271          0 ms         36 ms          0      0
```

`npm run rename` — এক ধাপে rename এ হাজার error; expand/contract এর প্রতিটা ধাপে শূন্য; আর চারটা ভুল:

```
migration first, then deploy                       v1 → v2   9,544   4,223         0
then rollback (migration not reverted)             v2 → v1   8,306   4,219         0
2. deploy: write to both                         v1 → v1.5   9,883       0         0
   backfill (name IS DISTINCT FROM title): 11 batches, 18,287 rows changed; name ≠ title now: 0
6. contract: drop title                                 v2   4,959       0         0
no dual-write: expand + backfill → v2              v1 → v2   9,942       0       278
   rows where name and title now differ: 3,711
   backfill (name IS NULL): 11 batches, 18,276 rows changed; name ≠ title now: 6
```

## কী দেখার জন্য এটা বানানো

- **ধরা পড়ার গতি আর ক্ষতির আকার আলাদা জিনিস।** Big-bang আর blue-green বড় bug ১ মিনিটে ধরে, কিন্তু ততক্ষণে সবাই নতুন
  version এ — ক্ষতি নির্ভর করে মানুষ কত দ্রুত rollback করে। Canary ধরে যখন মাত্র ১% এ, তাই ক্ষতি শ'এর ঘরে না, এককের ঘরে।
- **Alert শুধু গড় দেখে।** ১% traffic এর ২০% error সারা দিনের গড়ে ০.৩% — কোনো alert বাজে না, আর সব business user
  ভোগে। Canary এর gate ও শুধু error দেখলে latency এর bug মিস করে।
- **ছোট canary মানে কম ক্ষতি, কিন্তু কম প্রমাণ।** ১% এ ৫ মিনিটে ছোট regression (+০.২%) ধরার সম্ভাবনা ২৫%; আর প্রতি
  মিনিটে "দেখে নিই" করলে ভুল alarm বাড়ে।
- **Sticky না হলে canary সবার।** ৫% canary তে request এলোমেলো ভাগ হলে এক ঘণ্টায় ৫৯% user নতুন version ছোঁয়, আর তারা
  দুই version এর মাঝে লাফায়।
- **Flag এর ভাগ hash(flag + user)** — এলোমেলো হলে user লাফায়, flag এর নাম না মেশালে একই user সব experiment এ। আর
  সিদ্ধান্ত একবার নিয়ে পাঠাতে হয়, প্রতিটা service আলাদা নিলে অমিল।
- **Graceful shutdown এর ক্রম:** আগে readiness 503 (LB সরিয়ে নেয়), তারপর অপেক্ষা, তারপর `close()`, তারপর চলমান request
  শেষ। আর নতুন instance traffic পায় warm-up এর পরে। LB এর retry GET কে বাঁচায়, POST কে না।
- **DDL এর আসল বিপদ lock এর লাইন।** `ALTER` নিজে ১০ ms, কিন্তু একটা লম্বা query এর পেছনে অপেক্ষা করলে তার পেছনে সব
  query। `lock_timeout` + retry সেই লাইনকে ২০০ ms এ বাঁধে।
- **Expand/contract এর প্রতিটা ধাপ পুরনো আর নতুন দুটো code এর সাথে চলে**, আর rollback এর পথ খোলা রাখে। আর backfill এর
  শর্ত `IS NULL` হলে কিছু row নীরবে ভুল থাকে — কোনো error ছাড়া।

## নিজে ভেঙে দেখো (Experiments)

1. **ছোট ধাপ:** `STEP_MINUTES=3 npm run rollout`। Segment এর bug এ শুধু-error gate এর sticky canary কী করল (মাপা: ধরেনি,
   ৩,৮৫৭টা খারাপ request, ৫৮২ জন)? Segment-aware gate কখন ধরল (মাপা: ৪ মিনিট, ৫% এ)? কেন?
2. **মানুষ দ্রুত হলে:** `HUMAN_MINUTES=2 npm run rollout`। Big-bang আর blue-green এর খারাপ request কতটা কমল? Segment এর
   bug এ কি কিছু বদলাল?
3. **ধীর poll:** `POLL_SECONDS=300 npm run flags`। দুই service নিজে নিজে poll করলে অমিল কত হলো (মাপা: ৬.৫৩%)?
4. **আরও লম্বা query:** `LONG_QUERY_MS=20000 npm run locks`। Lock queue এর সারিতে app এর সর্বোচ্চ latency কত? `lock_timeout`
   এর সারিতে কতবার চেষ্টা?
5. **Health check ধীর:** `CHECK_MS=2000 npm run drain`। কোন সারি সবচেয়ে বেশি খারাপ হলো? Graceful এর `DRAIN_MS` কেন
   health check এর সাথে বাঁধা?
6. **Rollback এর শেষ বিন্দু:** `src/rename.ts` এর অংশ খ এ ধাপ ৫ (`v2r → v2`) এর পরে একটা `v2 → v1.5` rollback ধাপ যোগ করো।
   কী ভাঙল — error, নাকি ভুল পড়া? কেন ধাপ ৫ এর আগে rollback নিরাপদ ছিল, পরে না?

## Project Structure

```
docker-compose.yml   শুধু Postgres 17 (port 5449)
src/
  util.ts      seed দেওয়া PRNG, hash, binomial, z-test, টেবিল আর সময়ের format, env parse
  rollout.ts   script ক — তিন রকম bug × ছয়টা কৌশল, ভালো version, canary এর পরিসংখ্যান, sticky বনাম এলোমেলো
  flags.ts     script খ — percentage এর ভাগ, kill switch, দুই service এর অমিল
  drain.ts     script গ — আসল LB (round-robin, health check, retry) + চারটা instance, পাঁচ রকম rolling restart
  locks.ts     script ঘ — আসল Postgres, চলমান app load এর পাশে ALTER / index / backfill / NOT NULL
  rename.ts    script ঙ — আসল Postgres + Sequelize, চার রকম app version একই table এ, rename এর তিনটা পথ
```

Environment variable: `RPS`, `USERS`, `HORIZON_MINUTES`, `SEGMENT_SHARE`, `HUMAN_MINUTES`, `STEP_MINUTES`, `TRIALS`,
`VIEWS_PER_DAY`, `FEATURE_SHARE`, `FEATURE_ERROR`, `POLL_SECONDS`, `PORT_BASE`, `INSTANCES`, `RATE`, `RESTART_MS`,
`WARMUP_MS`, `CHECK_MS`, `ROWS`, `WORKERS`, `LONG_QUERY_MS`, `LOCK_TIMEOUT_MS`, `BATCH`, `BOARDS`, `STEP_SECONDS`, `SEED`,
`DATABASE_URL`।

Teardown:

```bash
docker compose down -v
```
