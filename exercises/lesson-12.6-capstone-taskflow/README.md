# TaskFlow Capstone - Task এর Write Path: Optimistic Lock, Idempotency-Key, Outbox, Idempotent Notification

> Lesson 12.6 - Capstone: TaskFlow Complete Design Doc · **Tier 1 - Runnable Code** (Docker এ Postgres + Redis; Express + Sequelize + Zod + BullMQ, আসল HTTP)

## কী বানাচ্ছি

Capstone এর design doc এর একটা core piece, আসল code এ: TaskFlow এর **task এর write path** - task তৈরি, move আর assign,
আর assign হলে একটা email। চারটা প্রশ্ন, প্রতিটার উত্তর মাপা:

- দুজন একই সময়ে একই task বদলালে কী হয়? (Optimistic lock, `WHERE version = ?`)
- Client এর response হারিয়ে গেলে আর সে আবার পাঠালে কী হয়? (`Idempotency-Key`)
- Database এ লেখা আর queue তে পাঠানোর মাঝে process মরলে কী হয়? (Transactional outbox)
- Worker email পাঠানোর পরে, "পাঠানো হয়েছে" লেখার আগে মরলে কী হয়? (Idempotent consumer + provider এর idempotency key)

| Script                | প্রশ্ন                                                                                                      | Lesson § |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| `npm run smoke`       | আসল HTTP এ ১১টা ধাপ: idempotent তৈরি, replay, 422, move, stale version এ 409, assign, relay আর worker crash | ১.৮      |
| `npm run concurrency` | ৫০ জন একই মুহূর্তে একই task assign করে: read-then-write বনাম optimistic lock                                | ১.৮      |
| `npm run idempotency` | ১,০০০টা তৈরি, ১০% response হারায়, client আবার পাঠায়: key ছাড়া বনাম key সহ; একসাথে চলা জোড়া              | ১.৮      |
| `npm run crash`       | ১,০০০টা assign, ২% ঝুঁকির মুহূর্তে crash: commit → queue, queue → commit, outbox                            | ১.৮      |
| `npm run load`        | ২০টা client ১০ সেকেন্ড ধরে move: এই write path এর throughput আর latency, আপনার machine এ                    | ১.৫      |

**সৎ নোট:**

- **Crash simulated, `SIGKILL` না।** ঝুঁকির মুহূর্তে একটা `SimulatedCrash` ছোঁড়া হয়: relay এর transaction rollback হয়, worker এর
  job ব্যর্থ হয়ে BullMQ এ retry হয়, আর dual write এর পথে পরের ধাপটা বাদ যায়। আসল process মরা (7.5 এর exercise) এর সাথে ফল এক
  হওয়ার কথা, কারণ নিয়ম দুটোই এক: commit না হলে কিছু নেই, আর commit এর পরের কাজ হারাতে পারে। কিন্তু এটা আসল crash না।
- **Crash এর জায়গা seeded:** task এর id থেকে একটা hash, তাই প্রতিবার একই task গুলোতে crash। `smoke`, `concurrency`,
  `idempotency`, `crash` দুবার চালালে output হুবহু এক।
- **Email provider fake,** memory তে, provider এর দিকের idempotency key সহ (অনেক আসল provider এটা দেয়, 11.5)। Email আসলে কোথাও যায় না।
- **`load` machine নির্ভর।** একটা laptop, Docker এ Postgres, client আর server একই Node process এ, Sequelize এর pool ১০টা connection।
  সংখ্যাটা আপনার machine এ আলাদা হবে।
- **যাচাই করা হয়েছে** Node 26 আর Docker এ (`postgres:17-alpine`, `redis:8-alpine`): `tsc --noEmit`, ESLint আর Prettier clean;
  চারটা deterministic script দুবার করে, output byte ধরে হুবহু এক; `load` দুবার (৭১১ আর ৭৫৫ move/s)।

## Prerequisite

Node.js 22+, Docker (Postgres আর Redis এর জন্য)। Port ৫৪৫০ আর ৬৩৮৪, আগের exercise গুলোর সাথে মেলে না।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run smoke
npm run concurrency
npm run idempotency
npm run crash
npm run load
```

প্রতিটা script database আর queue শুরুতে পরিষ্কার করে, তাই যেকোনো ক্রমে চালানো যায়। `crash` আর `idempotency` ১০-১৫ সেকেন্ড, `load` ১০ সেকেন্ড।

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run smoke`:

```
#   step                                          result
1   create a task with an Idempotency-Key         201 task 1, version 1
2   the same key again (a client retry)           201 task 1, replayed=true; tasks 1
3   the same key, a different body                422
4   move to doing with version 1                  200 version 2
5   move again with the stale version 1           409 current is version 2 in doing
6   assign to u_rina with version 2               200 version 3
7   relay: crash after enqueue, then retry        1 crash, the batch rolled back and was sent again
8   worker: crash after the email, then retry     provider calls 2, duplicates absorbed 1
9   emails delivered to u_rina                    1
10  the outbox at the end                         3 events, 0 unpublished
11  notifications marked sent                     1
```

`npm run concurrency`:

```
strategy                                   200   409  silently lost  emails  to the wrong person
read, then write (no version check)         50     0             49      50                   49
optimistic lock (WHERE version = ?)          1    49              0       1                    0
```

`npm run idempotency`:

```
client                                    requests   tasks  duplicates  replayed
retry without a key                          1,104   1,104         104         0
retry with the same Idempotency-Key          1,104   1,000           0       104

responses 201: 200/200 · replayed: 100 · tasks in the database: 100
status 422 - a key belongs to one request; reusing it for another is a client bug
```

`npm run crash`:

```
write order                          tasks  emails  no email  email, no task  crashes
commit, then enqueue                 1,000     970        30               0       30
enqueue, then commit                   970   1,000         0              30       30
outbox in the same transaction       1,000   1,000         0               0       30
outbox, on top of the relay crashes: 15 worker crashes after sending the email; provider calls 1,015 for 1,000 emails - the provider's idempotency key absorbed the repeats
```

`npm run load` (আপনার machine এ সংখ্যা আলাদা হবে; আকৃতিটা দেখুন):

```
moves                 7,552  (0 conflicts)
throughput            755 moves/s
latency               p50 24.6 ms · p99 56.7 ms
outbox rows written   7,572
against the design doc's estimated peak of ~90 writes/s: 8× headroom on this machine
```

## কী দেখার জন্য এটা বানানো

- **Read-then-write চুপচাপ হারায়।** ৫০ জনই 200 পায়, ৪৯ জনের পছন্দ টেকে না, আর ৪৯টা email ভুল মানুষের কাছে যায় - কারণ প্রতিটা
  request নিজের পড়া পুরনো অবস্থা থেকে event বানিয়েছে। Optimistic lock এ একজন জেতে, বাকি ৪৯ জন **জানে** যে হারিয়েছে (409)।
- **Retry নিরাপদ শুধু key দিয়ে।** ১০% response হারালে key ছাড়া ১০৪টা duplicate task। Key সহ শূন্য, আর একসাথে চলা জোড়াতেও শূন্য:
  দ্বিতীয় request এর `INSERT ... ON CONFLICT` প্রথমটার commit এর জন্য অপেক্ষা করে, তারপর তার উত্তরটাই ফেরত দেয়।
- **লেখার ক্রম কোনো সমাধান না।** আগে commit করলে ৩০টা email হারায়; আগে queue করলে ৩০টা email যায় এমন task এর জন্য যা নেই।
  Outbox এ দুটোই শূন্য, কারণ task আর "পাঠাতে হবে" একই transaction এ।
- **At-least-once এর দাম dedupe:** relay আবার পাঠায়, worker আবার চালায়, provider এ ১,০১৫টা call যায় - কিন্তু email ঠিক ১,০০০টা,
  কারণ প্রতিটা স্তরে event এর id দিয়ে idempotency।
- **সংখ্যা থেকে সিদ্ধান্ত:** একটা laptop এই write path এ সেকেন্ডে ~৭০০ move নেয়; TaskFlow এর আজকের peak ~৯০। তাই write এর জন্য
  sharding এর প্রশ্ন নেই (design doc এর ১.৫)।

## নিজে ভেঙে দেখুন (Experiments)

1. **Crash এর হার:** `CRASH=0.1 npm run crash`। প্রথম দুটো সারির ক্ষতি কীভাবে বাড়ে (মাপা: ১০৮টা email হারায়, আর অন্য ক্রমে ১০৮টা
   task ছাড়া email), আর outbox এর সারি কেন শূন্যেই থাকে? Provider call কত হলো (মাপা: ১,০৭৫)?
2. **কম client, কম জট:** `CLIENTS=2 npm run concurrency`। Optimistic lock এ 409 কয়টা (মাপা: ১; naive এ একজনের পছন্দ চুপচাপ হারায়)? এটা থেকে কী বোঝা যায় - সাধারণ অবস্থায়
   (একই task এ একই মুহূর্তে দুজন বিরল) optimistic lock এর দাম কত?
3. **Pool এর সীমা:** `src/db.ts` এ pool এর `max` ১০ থেকে ২ আর ২০ করে `npm run load`। Throughput আর p99 কীভাবে বদলায়? কোথায়
   গিয়ে বাড়ানো আর কাজে দেয় না (5.6)?
4. **Code বদলানোর কাজ - client এর retry:** `src/concurrency.ts` এ একটা তৃতীয় সারি যোগ করুন: optimistic lock, কিন্তু 409 পেলে client
   task আবার পড়ে আর নিজের assign আবার চেষ্টা করে (সর্বোচ্চ ৫ বার)। কয়টা শেষ পর্যন্ত সফল হয়, আর email কয়টা যায়? এই ক্ষেত্রে এটা কি
   ঠিক আচরণ - নাকি user কে জিজ্ঞেস করা উচিত?
5. **Code বদলানোর কাজ - outbox এর পরিষ্কার:** published হওয়া outbox এর row ৭ দিন পরে মোছার একটা job লিখুন (7.5), ছোট batch এ,
   যাতে বড় `DELETE` এর lock না ধরে। `load` এর পরে কতগুলো row মুছলে?

## Project Structure

```
docker-compose.yml   Postgres 17 (5450) আর Redis 8 (6384, noeviction, AOF)
src/
  config.ts          DATABASE_URL আর REDIS_URL, Zod দিয়ে
  db.ts              Sequelize model: Task (version), IdempotencyKey, OutboxEvent, Notification
  events.ts          task.created / task.moved / task.assigned - Zod এর discriminated union
  tasks.ts           write path: idempotent create, optimistic update, naive update (তুলনার জন্য), outbox এ event
  app.ts             Express route: POST /boards/:boardId/tasks, GET /tasks/:id, PATCH /tasks/:id (আর তুলনার /naive/tasks/:id)
  pipeline.ts        relay (SKIP LOCKED, jobId = eventId), BullMQ worker (idempotent notification), crash hook
  provider.ts        fake email provider, idempotency key সহ
  util.ts            টেবিল, seeded crash, percentile, HTTP helper
  smoke.ts           script ক - ১১টা ধাপ
  concurrency.ts     script খ - ৫০ জন একসাথে
  idempotency.ts     script গ - হারানো response আর retry
  crash.ts           script ঘ - তিনটা লেখার ক্রম
  load.ts            script ঙ - throughput আর latency
```

Environment variable: `DATABASE_URL`, `REDIS_URL`, `CLIENTS`, `REQUESTS`, `LOST`, `PAIRS`, `TASKS`, `CRASH`, `SEED`, `DURATION_S`,
`ESTIMATED_PEAK`।
