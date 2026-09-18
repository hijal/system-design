# TaskFlow Redis Caching Layer

> Lesson 4.4 — Redis Hands-on · **Tier 1 — Runnable Code**
>
> Lesson 4.6 (Cache Failure Patterns) এর stampede demo ও এখানেই — `npm run stampede`

## কী বানাচ্ছি

TaskFlow এর `GET /api/tasks` এ একটা সত্যিকারের **Cache-Aside** layer — Express + Sequelize +
PostgreSQL + Redis দিয়ে। সাথে `PATCH /api/tasks/:id` এ **invalidate-on-write**, আর একটা
bench script যেটা cache এর লাভটা দাবি না করে **মেপে দেখায়**।

Module 4 এর প্রথম তিন lesson এ যা যা কাগজে ঠিক করেছি, সবগুলো এখানে একসাথে বসানো:

| সিদ্ধান্ত                       | কোথায়                                         | Lesson |
| ------------------------------- | ---------------------------------------------- | ------ |
| Cache-Aside (read)              | `src/server.ts` — `GET /api/tasks`             | 4.2    |
| আগে DB, পরে invalidate          | `src/server.ts` — `PATCH /api/tasks/:id`       | 4.3    |
| Derived view ও মুছতে হবে        | `tasks:user:N` **আর** `tasks:user:N:completed` | 4.3    |
| TTL ৬০s safety net              | `src/server.ts` — `TTL_SECONDS`                | 4.3    |
| `allkeys-lru`                   | `docker-compose.yml` — redis command           | 4.3    |
| Cache fail করলেও request বাঁচবে | `src/cache.ts` — সব catch                      | 4.2    |

## Prerequisite

Node.js 22+ এবং Docker (শুধু PostgreSQL আর Redis চালানোর জন্য — app নিজে সাধারণ Node
process হিসেবে চলবে)।

Port হিসেবে **5433** (Postgres) আর **6380** (Redis) ব্যবহার করা হয়েছে, যাতে তোমার মেশিনে
আগে থেকে চলা কোনো instance এর সাথে সংঘাত না লাগে।

## Setup

```bash
docker compose up -d     # Postgres + Redis
npm install
npm run seed             # ৫০০০ task তৈরি করে user 7 এর জন্য
```

## Run

```bash
npm run build && npm start
```

Server চলবে http://localhost:3000 এ।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. প্রথম request — cache খালি, তাই DB তে যাবে**

```bash
curl -i "http://localhost:3000/api/tasks?userId=7" | head -20
```

Expected: header এ `X-Cache: MISS`, body তে `"source":"database"`

**২. দ্বিতীয় request — এখন cache থেকে**

```bash
curl -i "http://localhost:3000/api/tasks?userId=7" | head -20
```

Expected: `X-Cache: HIT`, `"source":"cache"`, আর `tookMs` স্পষ্টভাবে কম

**৩. মেপে দেখো**

```bash
npm run bench
```

Expected (আমার মেশিনে মাপা — তোমারটায় সংখ্যা ভিন্ন হবে, অনুপাতটা মিলবে):

```
  dataset        : 5000 tasks
  MISS (DB)  x20 : median 12.33 ms
  HIT (cache) x20 : median 3.69 ms
  cache hits     : 20/20
  speedup        : ~3.3x
```

**৪. Invalidation কাজ করছে?**

```bash
# cache গরম করো — দুইটা view ই
curl -s "http://localhost:3000/api/tasks?userId=7" > /dev/null
curl -s "http://localhost:3000/api/tasks?userId=7&completed=true" > /dev/null
redis-cli -p 6380 KEYS 'tasks:user:7*'
# Expected: tasks:user:7  এবং  tasks:user:7:completed

# একটা task বদলাও
curl -s -X PATCH http://localhost:3000/api/tasks/1 \
  -H 'Content-Type: application/json' \
  -d '{"title":"নতুন নাম"}'
# Expected: response এ "invalidated": ["tasks:user:7", "tasks:user:7:completed"]

redis-cli -p 6380 KEYS 'tasks:user:7*'
# Expected: খালি — দুইটাই মুছে গেছে
```

**৫. Cache stampede (Lesson 4.6)**

```bash
npm run stampede
```

একই মুহূর্তে ৫০টা request পাঠায় cache সদ্য খালি হওয়া অবস্থায় — একবার single-flight
ছাড়া, একবার সহ। Expected (আমার মেশিনে মাপা):

```
  single-flight ছাড়া : DB query  50 টা   (802 ms)
  single-flight সহ   : DB query   1 টা   (254 ms)
```

**script টা `?delay=200` দিয়ে একটা "দামি query" নকল করে — আর সেটা ইচ্ছাকৃত।** আসল
query (~১২ ms) এতই দ্রুত যে প্রথম request শেষ হয়ে cache ভরে ফেলে বাকিরা আসার আগেই,
ফলে stampede ঘটেই না (DB query ১-২টা)। Stampede তখনই বিপজ্জনক যখন origin এর কাজটা
ধীর — Lesson 4.6 §১.২ এ এটা বিস্তারিত আছে।

**৬. Redis মরে গেলে app বাঁচে?**

```bash
docker compose stop redis
curl -i "http://localhost:3000/api/tasks?userId=7" | head -20
docker compose start redis
```

Expected: **HTTP 200-ই আসবে**, `X-Cache: ERROR`, `"source":"database"` — request fail
করবে না। কিন্তু `tookMs` দেখো, চমকে যাবে (নিচের experiment ২ দ্রষ্টব্য)।

## কী দেখার জন্য এটা বানানো

একটা সংখ্যা নয়, **তিনটা আচরণ**:

1. **Hit আর miss এর পার্থক্য** — `tookMs` আর `X-Cache` header এ সরাসরি দেখা যায়
2. **Invalidation এ derived view** — `tasks:user:7:completed` টাও মুছতে হচ্ছে, শুধু মূল
   list না। এটাই বাস্তবে সবচেয়ে বেশি ভুলে যাওয়া জিনিস
3. **Cache মরলে কী হয়** — correctness ঠিক থাকে, কিন্তু performance ধসে পড়ে

## নিজে ভেঙে দেখো (Experiments)

1. **TTL কমিয়ে দাও।** `src/server.ts` এ `TTL_SECONDS` ৬০ থেকে ২ করে দাও, rebuild করে
   `npm run bench` চালাও। Cache hit ratio কী হয়? Lesson 4.3 এর প্রশ্ন ২ এর উত্তরটা
   এবার নিজের চোখে দেখো।

2. **Redis বন্ধ করে latency মাপো।** `docker compose stop redis` করে পরপর কয়েকটা request
   পাঠাও, `tookMs` লক্ষ্য করো। আমার মেশিনে প্রথমটা **১১৬৯ ms**, পরেরটা **২৬৯১ ms** —
   অথচ DB একদম সুস্থ। কেন বাড়ছে? (ইঙ্গিত: `src/cache.ts` এ `maxRetriesPerRequest` আর
   `connectTimeout`।) এবার `connectTimeout` ১০০ ms করে দিয়ে আবার দেখো — পার্থক্যটা
   বোঝা এই exercise এর সবচেয়ে গুরুত্বপূর্ণ শিক্ষা।

3. **Invalidation ইচ্ছা করে ভাঙো।** `PATCH` handler এ `affected` array থেকে
   `keys.completedByUser(...)` লাইনটা বাদ দাও। তারপর: completed list টা cache করো,
   একটা task এর `completed` বদলাও, আবার completed list পড়ো। কী ভুল দেখছ? কতক্ষণ পর
   নিজে থেকে ঠিক হয়ে যায়, আর কেন?

4. **Eviction চোখে দেখো।** `docker-compose.yml` এ `--maxmemory 256mb` কে `--maxmemory 1mb`
   করে দাও। `docker compose up -d redis` করে অনেকগুলো ভিন্ন `userId` দিয়ে request পাঠাও।
   `redis-cli -p 6380 INFO stats | grep evicted_keys` দেখো।

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-4.4-redis-cache/
├── docker-compose.yml   # Postgres + Redis (5433 / 6380)
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts            # Sequelize + Task model (InferAttributes সহ)
    ├── cache.ts         # Redis client, Zod validation, fail-safe helper
    ├── server.ts        # Express — cache-aside read, invalidate-on-write
    ├── seed.ts          # ৫০০০ task তৈরি করে
    └── bench.ts         # MISS বনাম HIT মেপে দেখায়
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, Postgres 17, Redis 8):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- উপরের **ছয়টা acceptance criteria-ই** চালিয়ে মিলিয়ে দেখা হয়েছে
- `npm run bench` এর সংখ্যাগুলো সত্যিকারের মাপা — অনুমান করা না
