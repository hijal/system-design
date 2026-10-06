# TaskFlow Outbox Lab — Dual Write বনাম Transactional Outbox

> Lesson 7.5 — Event-Driven Architecture basics · **Tier 1 — Runnable Code** (Docker এ Postgres + Redis, Node process গুলো আসলে crash করে)

## কী বানাচ্ছি

"Comment তৈরি করুন, আর `comment.created` event পাঠান" — তিনভাবে, আর প্রতিটায় ঠিক সবচেয়ে খারাপ মুহূর্তে
process কে `SIGKILL` করা:

| Mode            | Writer কী করে                                                                    | কোথায় মরে                    |
| --------------- | -------------------------------------------------------------------------------- | ----------------------------- |
| `commit-first`  | comment commit → তারপর Redis Stream এ event                                      | commit এর পরে, event এর আগে   |
| `publish-first` | transaction খোলে, comment লেখে → event পাঠায় → তারপর commit                     | event এর পরে, commit এর আগে   |
| `outbox`        | comment আর একটা `outbox_events` row **একই transaction এ** → commit; পাঠায় relay | দুটো লেখার পরে, commit এর আগে |

`outbox` mode এ আলাদা একটা **relay** process চলে: `FOR UPDATE SKIP LOCKED` দিয়ে না-পাঠানো row এর batch
নেয়, Redis Stream এ `XADD` করে, `publishedAt` বসিয়ে commit। Relay ও মাঝে মাঝে পাঠানো আর commit এর মাঝে
মরে।

শেষে scenario Postgres এর `comments` আর Redis এর `events:comments` stream মেলায়, comment id ধরে:

- **হারাল** — comment আছে, event নেই (consumer রা কখনো জানবে না)
- **ভুতুড়ে** — event আছে, comment নেই (consumer রা এমন কিছুর খবর পেল যেটা ঘটেইনি)
- **বাড়তি** — একই comment এর একাধিক event (একই `eventId` — consumer dedupe করতে পারে, Lesson 7.4)

**সৎ নোট:**

- Writer এর crash কোন comment এ হবে সেটা comment এর id থেকে ঠিক হয় — তাই writer এর crash সংখ্যা (৪১)
  প্রতিবার একই। Relay এর crash কোন batch এ পড়বে সেটা timing এর উপর নির্ভর করে, তাই outbox এর "বাড়তি"
  আর relay crash এর সংখ্যা run ভেদে একটু বদলায় (এই মেশিনে ১০১ থেকে ১৬০)।
- Writer crash করলে সেই request এর user error দেখে (connection ছিঁড়ে গেছে) — `commit-first` এ তবু
  comment টা database এ থাকে। "user error দেখল" কলামে শুধু যেগুলো code নিজে ফিরিয়েছে।
- এখানে CDC (Debezium এর মতো WAL পড়া) নেই — polling relay। দুটোর তুলনা lesson এ।

## Prerequisite

Node.js 22+, Docker (Postgres আর Redis এর জন্য)।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run scenario                        # all three modes in turn (~40 seconds)
MODE=outbox npm run scenario            # just one
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run scenario` এর শেষে (writer CRASH_RATE 0.02, relay 0.005 প্রতি event):

```
── mode: outbox ──────────────────────────────────────────────────
   comment attempts: 2000 · writer crashes: 41 · user saw an error: 0
   comments in the database: 1959 · events in the stream: 2119 (distinct eventIds 1959)
   events lost (comment exists, no event):     0
   phantom events (event exists, no comment):  0
   extra events for the same comment:          160
   relay crashes: 11 · from commit to reaching the stream p50 118 ms, p99 457 ms · unpublished at the end: 0

── comparison ────────────────────────────────────────────────────
   mode            comments    lost  phantom    extra (same eventId)
   commit-first        2000      41        0        0
   publish-first       1959       0       41        0
   outbox              1959       0        0      160
```

মিলতে হবে: `commit-first` এ হারাল ৪১, `publish-first` এ ভুতুড়ে ৪১ (writer এর crash সংখ্যা), `outbox` এ
দুটোই ০, আর বাড়তি event এর সংখ্যা যাই হোক, "distinct eventIds" = comment এর সংখ্যা।

## কী দেখার জন্য এটা বানানো

- **`commit-first` এর ৪১ আর `publish-first` এর ৪১ — একই crash, উল্টো দোষ।** প্রথমটায় comment আছে কিন্তু
  search index, notification কেউ জানে না। দ্বিতীয়টায় Postgres transaction টা connection ছিঁড়ে যাওয়ায়
  নিজেই rollback করেছে — কিন্তু event আগেই বেরিয়ে গেছে; notification service এমন comment এর email
  পাঠাবে যেটা নেই।
- **`outbox` এর "আলাদা eventId 1959":** বাড়তি ১৬০টা event সবই আগের কোনো event এর হুবহু কপি, একই `eventId`
  সহ — relay পাঠিয়েছিল, `publishedAt` লেখার আগে মরেছিল। Outbox at-least-once; consumer idempotent হলে
  (7.4) এটা নিরাপদ।
- **Outbox এর দেরি:** commit থেকে stream এ পৌঁছাতে p50 ~১০০ ms — relay এর polling এর দাম। Event এখন আর
  commit এর মুহূর্তে যায় না, একটু পরে যায়।

## নিজে ভেঙে দেখুন (Experiments)

1. **Redis বন্ধ হলে:** `REDIS_OUTAGE_MS=3000 WRITE_DELAY_MS=5 CRASH_RATE=0 RELAY_CRASH_RATE=0 npm run scenario`
   — চলার মাঝে scenario নিজে `docker compose stop redis` করে, ৩ সেকেন্ড পরে `start`। (এই মেশিনে:
   `commit-first` এ ৪৪৯টা event নীরবে হারাল; `publish-first` এ ৫৩৪ জন user comment ই করতে পারল না;
   `outbox` এ কেউ কিছু টের পেল না — হারাল ০, error ০, শুধু event এর দেরি p99 ৪.১ s।) কোনটার availability
   Redis এর উপর নির্ভর করে, কোনটার করে না?
2. **Polling এর দাম:** `MODE=outbox POLL_MS=1000 npm run scenario`। দেরি কত হলো? (এই মেশিনে p50 ~৮৪০ ms,
   p99 ১.৫ s।) Relay যত ঘনঘন খোঁজে, database এ তত বেশি query — কীভাবে দুটোই কমানো যায়? (Lesson এ LISTEN/NOTIFY
   আর CDC দেখুন।)
3. **Batch আর crash:** `MODE=outbox CRASH_RATE=0 RELAY_CRASH_RATE=0.05 npm run scenario` (batch ৫০), তারপর
   একই সাথে `BATCH=5`। (এই মেশিনে: batch ৫০ এ ৬০ সেকেন্ড পরেও ১০৫০টা event পাঠানো বাকি; batch ৫ এ সব পৌঁছায়,
   ৩৪১টা বাড়তি।) ৫০ টা event এর একটা batch কোনো crash ছাড়া শেষ হওয়ার সম্ভাবনা কত (০.৯৫⁵⁰)? এটা Lesson 7.4
   এর কোন ধারণার মতো?
4. **ক্রম:** `relay.ts` এ `ORDER BY id` আছে। দুটো writer একসাথে চললে id ১০ এর transaction id ১১ এর পরে commit
   হতে পারে। Relay যদি "`WHERE id > শেষ পাঠানো id`" দিয়ে খুঁজত (`publishedAt` এর বদলে), id ১০ এর কী হতো?
   (Code বদলানোর দরকার নেই — হাতে একটা সময়ের রেখা আঁকুন।)
5. **Outbox পরিষ্কার:** সব run এর পরে `outbox_events` এ কয়টা row আছে (`docker compose exec postgres psql -U
taskflow -c 'select count(*) from outbox_events'`)? দিনে লাখ comment এ এটা কত বড় হবে, আর কীভাবে ছোট রাখবেন?

## Project Structure

```
lesson-7.5-outbox/
├── docker-compose.yml   # Postgres 17 (5443) + Redis 8 (6382, noeviction + AOF)
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── db.ts            # Sequelize: comments, outbox_events (publishedAt এর উপর partial index)
    ├── events.ts        # comment.created এর Zod schema, Redis Stream এ publish
    ├── writer.ts        # তিনটা mode, আর ঠিক খারাপ মুহূর্তে SIGKILL
    ├── relay.ts         # outbox → stream: FOR UPDATE SKIP LOCKED, batch, publishedAt
    └── scenario.ts      # writer (crash এর পরে নতুন), relay, Redis outage, আর শেষে মেলানো
```

সব env (`scenario.ts` এর উপরে): `MODE` (`all`), `N` (2000), `CRASH_RATE` (0.02), `RELAY_CRASH_RATE` (0.005),
`POLL_MS` (200), `BATCH` (50), `REDIS_OUTAGE_MS` (0), `WRITE_DELAY_MS` (0), `SEED` (7)।
