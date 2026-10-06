# TaskFlow BullMQ Lab — Redis এ টেকসই Job Queue, আর কে মরলে কী হয়

> Lesson 7.3 — BullMQ hands-on · **Tier 1 — Runnable Code** (Docker এ Redis, তিন ধরনের Node process)

## কী বানাচ্ছি

Lesson 7.1 এর assign email, এবার আসল জিনিস দিয়ে: API (producer) BullMQ queue তে job লেখে আর সাথে
সাথে `202` দেয়; আলাদা একটা **worker process** job তুলে নকল email provider এ পাঠায়। সব state থাকে
Redis এ। তারপর একটা একটা করে সবাইকে মারা — API, worker, Redis নিজে — আর দেখা কী হারায়, কী দুবার হয়।

| File              | কী করে                                                                                    | Lesson § |
| ----------------- | ----------------------------------------------------------------------------------------- | -------- |
| `src/config.ts`   | Redis connection, queue এর নাম, job data এর Zod schema, retry/backoff option, job ID      | ১.১, ১.৭ |
| `src/api.ts`      | Express: `POST /api/tasks/:id/assign` → `queue.add` → `202`; `GET /api/jobs/:id` → অবস্থা | ১.১      |
| `src/worker.ts`   | BullMQ `Worker`: concurrency 8, provider এ timeout সহ call, SIGTERM এ graceful shutdown   | ১.১, ১.৫ |
| `src/provider.ts` | নকল email provider: latency বদলানো যায়, `FAIL_RATE` অনুপাতে `503`, কোন email কয়বার গেল  | —        |
| `src/scenario.ts` | সব process চালায়, load দেয়, provider ধীর করে, দরকার হলে কাউকে মারে, তারপর হিসাব         | ১.৪–১.৮  |
| `src/inspect.ts`  | ছোট একটা queue তে প্রতিটা অবস্থার job বানিয়ে Redis এর key গুলো সরাসরি দেখায়             | ১.৩      |

Scenario এর load Lesson 7.1 এর মতোই: প্রতি সেকেন্ডে ২০টা assign, ৮ সেকেন্ড স্বাভাবিক (provider 150 ms)
→ ৮ সেকেন্ড ধীর (2 s) → ৮ সেকেন্ড আবার স্বাভাবিক, তারপর queue খালি হওয়ার অপেক্ষা।

**সৎ নোট:**

- Scenario তে worker এর `lockDuration` **10 s** আর `stalledInterval` **5 s** — BullMQ এর default দুটোই
  **30 s**। কমানো হয়েছে যাতে worker-crash এর run এক মিনিটের মধ্যে শেষ হয়। Default এ একই ঘটনা ঘটে,
  শুধু stalled job ফিরতে বেশি সময় লাগে। (`worker.ts` নিজে default এ 30 s।)
- Database নেই — assign এর database অংশ Lesson 7.1 এ দেখা হয়েছে; আজকের প্রশ্ন শুধু queue।
- Provider এর `FAIL_RATE` এর ব্যর্থতা `Math.random()` দিয়ে, আর সব process আসল timer এ চলে — তাই সংখ্যা
  প্রতিবার সামান্য আলাদা; **আকৃতি** একই থাকার কথা।
- যাচাই করা হয়েছে BullMQ **5.81.5** আর Redis 8 এ। BullMQ এর ভেতরের Redis key এর গঠন (`inspect`)
  version ভেদে বদলাতে পারে।

## Prerequisite

Node.js 22+, Docker (শুধু Redis এর জন্য)।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run scenario                                # nobody dies — baseline
CRASH=api npm run scenario                      # API SIGKILL in the middle of the slow phase
CRASH=worker-kill npm run scenario              # worker SIGKILL
CRASH=worker-term npm run scenario              # worker SIGTERM (graceful)
FAIL_RATE=0.3 npm run scenario                  # provider returns 503 30% of the time
DOUBLE_SUBMIT=1 npm run scenario                # every assign sent twice
npm run inspect                                 # BullMQ inside Redis
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. `npm run scenario`** (baseline):

```
   phase            API p50 / p99     API failed
   normal             22 ms / 53 ms            0
   provider slow      30 ms / 53 ms            0
   after recovery     29 ms / 35 ms            0

   API returned 202: 477 times, distinct jobs: 477
   most in the queue: waiting 127, delayed (waiting to retry) 0
   jobs: completed 477, failed 0   · attempts needed: 1 → 477
   provider: distinct emails delivered 477, returned 503 0 times
   email delivery (from job added): p50 194 ms, p99 6.8 s, max 6.8 s
   "got 202, the email never went": 0
   the same email delivered twice (or more): 0
```

মিলতে হবে: provider ধীর হলেও API এর p99 কয়েক দশ ms; waiting এর সর্বোচ্চ ~১২৫–১৩০; সব email পৌঁছায়।

**২. বাকি run গুলো** — এই মেশিনে পাওয়া মূল সংখ্যা:

| Run                 | API ব্যর্থ | "202 পেল, email যায়নি" | দুবার পৌঁছেছে | email দেরি max | বিশেষ                                          |
| ------------------- | ---------- | ----------------------- | ------------- | -------------- | ---------------------------------------------- |
| `CRASH=api`         | 3          | **0**                   | 0             | 6.8 s          | 7.1 এর in-memory queue এ এখানে ১০৩ হারিয়েছিল  |
| `CRASH=worker-kill` | 0          | 0                       | **8**         | 18.9 s         | মরার মুহূর্তে active ছিল ৮টা                   |
| `CRASH=worker-term` | 0          | 0                       | **0**         | 7.0 s          | চলমান ৮টা শেষ করে বন্ধ হয়েছে                  |
| `FAIL_RATE=0.3`     | 0          | 1 (failed এ আছে)        | 0             | 18.8 s         | চেষ্টা: 1→341, 2→86, 3→36, 4→11, 5→3; failed 1 |
| `DOUBLE_SUBMIT=1`   | 0          | 0                       | 0             | 6.8 s          | 954 বার 202, কিন্তু job আর email ৪৭৭টাই        |

**৩. `npm run inspect`** — এই আকৃতির output:

```
   job states (BullMQ API):
     demo-waiting       → waiting
     demo-delayed       → delayed
     demo-prioritized   → prioritized
     demo-completed     → completed
     demo-failed        → failed

   Redis keys (bull:inspect-demo:*):
     completed            zset    demo-completed
     delayed              zset    demo-delayed
     demo-completed       hash
     …
     events               stream  16 events
     failed               zset    demo-failed
     prioritized          zset    demo-prioritized
     wait                 list    demo-waiting
```

## কী দেখার জন্য এটা বানানো

- **API এর latency ~২০–৩০ ms, 7.1 এর in-memory queue এর ~১০ ms এর চেয়ে বেশি** — প্রতিটা `queue.add`
  এখন Redis এ একটা network round trip। এটাই টেকসই হওয়ার দাম, আর এটা সস্তা।
- **`CRASH=api` এর "202 পেল, email যায়নি: 0":** Lesson 7.1 এর ১০৩ এর উত্তর। Job API এর memory তে না,
  Redis এ — `queue.add` ফেরার আগেই। "API ব্যর্থ 3" হলো restart এর মুহূর্তে যে request গুলো মরা API তে
  গিয়েছিল — সেই user রা error দেখেছে, মিথ্যা "সফল" না।
- **`CRASH=worker-kill` এর "দুবার পৌঁছেছে: 8" আর দেরি ~১৯ সেকেন্ড:** মরার মুহূর্তে ৮টা job active ছিল,
  তাদের request provider এ পৌঁছে গিয়েছিল। Worker "শেষ" লেখার আগেই মরল; lock এর মেয়াদ (10 s) শেষ হলে
  stalled checker তাদের waiting এ ফেরাল, নতুন worker আবার পাঠাল। লক্ষ করুন: "চেষ্টা লেগেছে" তবু সবার
  **১ বার** — stalled হয়ে ফেরা BullMQ এর হিসাবে "চেষ্টা" না।
- **`CRASH=worker-term`:** একই মুহূর্তে SIGTERM দিলে `worker.close()` চলমান ৮টা শেষ করে তারপর বন্ধ হয় —
  duplicate ০। Deploy সবসময় এভাবে হওয়া উচিত।
- **`FAIL_RATE=0.3`:** চেষ্টার বণ্টন প্রায় জ্যামিতিক (প্রতিবার ~৭০% সফল)। ৫ বারই ব্যর্থ হওয়ার সম্ভাবনা
  0.3⁵ ≈ 0.24% — ৪৭৮ এর মধ্যে ~১টা, আর ঠিক ১টা `failed` এ। সেটা হারায়নি, **দৃশ্যমান** আছে।
- **`DOUBLE_SUBMIT=1`:** একই job ID এর দ্বিতীয় `queue.add` BullMQ নীরবে বাদ দেয়।

## নিজে ভেঙে দেখুন (Experiments)

1. **Redis নিজে মরলে:** একটা terminal এ `npm run scenario`, আর ~১২ সেকেন্ডে আরেকটায়
   `docker compose restart redis`। তারপর আবার, এবার `docker compose kill redis && sleep 2 && docker compose start redis`
   (SIGKILL — Redis শেষ মুহূর্তে কিছু save করার সুযোগ পায় না)। কিছু হারাল? API এর p99 কত হলো, কেন?
   (এই মেশিনে: দুবারই কিছু হারায়নি; API p99 restart এ ~১ s, kill এ ~৩ s — ioredis Redis ফেরা পর্যন্ত
   command গুলো ধরে রাখে।) এবার `docker-compose.yml` থেকে `--appendonly yes --appendfsync everysec` বাদ
   দিয়ে (`docker compose up -d --wait` আবার) kill এর পরীক্ষা করুন।
2. **Worker scale:** `WORKER_PROCS=2 npm run scenario`। Waiting এর সর্বোচ্চ কত? (এই মেশিনে ৯৫।) হাতে
   হিসাব করুন — ধীর phase এ কয়টা email/s বের হয়, কয়টা আসে।
3. **Retry বন্ধ:** `FAIL_RATE=0.3 ATTEMPTS=1 npm run scenario`। Failed কত? (এই মেশিনে দুবার চালিয়ে ১৪২ করে —
   ৪৭৮ এর ~৩০%।) Failed job গুলোর কী হবে — কে দেখবে, কীভাবে আবার চালাবেন?
4. **Lock এর মেয়াদ:** `CRASH=worker-kill LOCK_MS=30000 STALLED_MS=30000 npm run scenario` (production
   default)। Email দেরি max কত হলো? (এই মেশিনে ~৯৪ সেকেন্ড, duplicate তবু ৮।) Lock ছোট রাখলে এই দেরি কমে
   — তাহলে ছোট রাখছি না কেন? (ইঙ্গিত: একটা job যদি `LOCK_MS` এর চেয়ে বেশি সময় event loop আটকে রাখে?)
5. **Code এ হাত দিন:** `worker.ts` এর processor এ, `fetch` এর আগে একটা synchronous busy loop বসান যেটা
   ১২ সেকেন্ড event loop আটকায় (শুধু একটা নির্দিষ্ট job এর জন্য, যেমন `job.id === 'assign-100-1'`)।
   তারপর `npm run scenario` (lock 10 s)। Worker এর log এ `could not renew lock` দেখবেন। Duplicate কত, failed
   কত, আর failed এর কারণ কী? (এই মেশিনে: duplicate ৯, failed ২ — `job stalled more than allowable limit`।)
   শুধু একটা job থামালে **আটটা** job এর lock কেন গেল? এটা Lesson 6.1 এর কোন ঘটনা? শেষে code আগের মতো করুন।

## Project Structure

```
lesson-7.3-bullmq/
├── docker-compose.yml   # Redis 8: noeviction + AOF (appendfsync everysec), port 6381
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── config.ts        # connection, queue নাম, job schema (Zod), retry option, job ID
    ├── api.ts           # producer: Express → queue.add → 202
    ├── worker.ts        # consumer: BullMQ Worker, timeout, graceful shutdown
    ├── provider.ts      # নকল email provider
    ├── scenario.ts      # সব process + load + crash + হিসাব
    └── inspect.ts       # Redis এর ভেতরে BullMQ এর key
```

সব env (`scenario.ts` এর উপরে): `PHASE_MS` (8000), `SLOW_LATENCY_MS` (2000), `ASSIGN_RPS` (20), `CRASH`
(`none`), `CRASH_AT_MS` (12000), `FAIL_RATE` (0), `ATTEMPTS` (5), `WORKER_PROCS` (1), `CONCURRENCY` (8),
`LOCK_MS` (10000), `STALLED_MS` (5000), `DOUBLE_SUBMIT` (0)। Redis এর ঠিকানা `REDIS_HOST`/`REDIS_PORT`
(127.0.0.1:6381)।
