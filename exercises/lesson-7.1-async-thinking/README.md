# TaskFlow Async Lab — একটা ধীর Email Provider কীভাবে পুরো App ফেলে দেয়

> Lesson 7.1 — কেন সবকিছু synchronous হলে system মরে যায় · **Tier 1 — Runnable Code** (তিনটা আসল Node process)

## কী বানাচ্ছি

TaskFlow এর "task assign করলে assignee কে email" feature এর **চারটা সংস্করণ**, আর একটা load
generator যেটা মাঝপথে email provider কে ধীর করে দেয়। দেখার প্রশ্ন একটাই: email এর কাজটা request
এর পথে থাকলে আর না থাকলে, ধীর provider এর ক্ষতি **কোথায়** গিয়ে পড়ে।

| Mode                | Assign route কী করে                                                      | Lesson § |
| ------------------- | ------------------------------------------------------------------------ | -------- |
| `sync-in-tx`        | Transaction খোলে → update → email পাঠিয়ে অপেক্ষা → commit               | ০, ১.৩   |
| `sync-after-commit` | Commit করে connection ফেরত দেয় → তারপর email এর জন্য অপেক্ষা → উত্তর    | ১.৪      |
| `fire-and-forget`   | Commit → `void sendEmail()` → অপেক্ষা না করেই উত্তর                      | ১.৪      |
| `queue`             | Commit → in-memory job queue তে job → উত্তর; ৮টা worker পরে email পাঠায় | ১.৫      |

তিনটা process (`child_process.fork`):

- **provider** — নকল email provider। প্রতিটা email এ `latencyMs` অপেক্ষা করে। একসাথে ৫০টার বেশি
  এলে বাড়তিগুলো সাথে সাথে `429` (বাস্তবের provider এর rate limit এর মতো)।
- **api** — TaskFlow এর Express API। `POST /api/tasks/:id/assign` (email সহ) আর `GET /api/tasks`
  (email এর সাথে কোনো সম্পর্ক নেই, শুধু একটা ছোট query)। দুটো route **একই connection pool** ব্যবহার করে।
- **scenario** — load generator: প্রতি সেকেন্ডে ২০টা assign আর ৫০টা list, client timeout ৫ সেকেন্ড।
  ৮ সেকেন্ড স্বাভাবিক (provider 150 ms) → ৮ সেকেন্ড ধীর (4 s) → ৮ সেকেন্ড আবার স্বাভাবিক।

**সৎ নোট:** Database আসল না — `pool.ts` Sequelize এর pool এর আচরণের একটা ছোট নকল (max ১০, সব
ব্যস্ত হলে লাইন, `acquire` সীমা ৩ সেকেন্ড পরে error), আর "query" মানে কয়েক ms অপেক্ষা। Lesson 5.6
এর exercise এ আসল Postgres দিয়ে একই pool exhaustion মাপা হয়েছিল; এখানে প্রশ্নটা pool এর না, pool
**কে ধরে রাখে** তার। Provider এর সীমা "একসাথে ৫০টা" একটা ধরে নেওয়া সংখ্যা — আসল provider এর সীমা
সাধারণত "প্রতি সেকেন্ডে কয়টা", আর account ভেদে আলাদা।

## Prerequisite

Node.js 22+। Docker লাগবে না। Linux, macOS, Windows — সবখানে চলে।

## Setup

```bash
npm install
```

## Run

```bash
npm run compare                     # all four modes in turn, a comparison at the end (~1 minute 40 seconds)
npm run scenario -- sync-in-tx      # just one mode
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

আসল process আর আসল timer, তাই সংখ্যাগুলো প্রতিবার সামান্য আলাদা হবে — কিন্তু **আকৃতি** একই থাকার
কথা (এই মেশিনে কয়েকবার চালিয়ে একই আকৃতি এসেছে)। `npm run compare` এর শেষে:

```
── comparison ──────────────────────────────────────────────
   mode              assign failed  list failed   email p99     said ok, no email
   sync-in-tx                   91          207       7.0 s                     0
   sync-after-commit            61            0       4.0 s                     0
   fire-and-forget               0            0       4.0 s                    60
   queue                         0            0       7.6 s                     0
```

যা মিলতে হবে:

1. `sync-in-tx` এ **list** route ও ব্যর্থ হয় (কয়েকশো) — অথচ list email ছোঁয়ই না। "provider ধীর" phase
   এ list এর p99 ২৭ ms থেকে ~৩ সেকেন্ডে লাফায়, আর `pool এ সর্বোচ্চ লাইন` ২০০ এর উপরে।
2. `sync-after-commit` এ list অক্ষত (০ ব্যর্থ), কিন্তু assign এর p50 ধীর phase এ ~৪ সেকেন্ড, আর কিছু
   assign ব্যর্থ — provider এর `429` এর কারণে।
3. `fire-and-forget` এ assign সবসময় ~১০ ms, কেউ ব্যর্থ দেখে না — কিন্তু `সফল-কিন্তু-email-নেই` শূন্য না।
4. `queue` এ assign ~১০ ms, list অক্ষত, কোনো email হারায় না, `provider এ একসাথে সর্বোচ্চ: 8` —
   কিন্তু `email বাকি (সর্বোচ্চ)` দেড়শোর কাছে আর email p99 সবচেয়ে বেশি।

## কী দেখার জন্য এটা বানানো

- **`sync-in-tx` এর phase table:** ধীর phase এ `list ব্যর্থ` এর কলাম। একটা route এর dependency ধীর
  হলো, আর অন্য route মরল — কারণ দুজনের মাঝে একটা ভাগ করা resource (pool)। এটাই cascading failure।
- **`"ব্যর্থ" বলা হলো, অথচ email গেছে`** (`sync-in-tx`): client ৫ সেকেন্ডে হাল ছেড়েছে, কিন্তু server
  কাজ চালিয়ে গেছে। User "ব্যর্থ" দেখল, assignee email পেল। Lesson 6.1: timeout মানে "জানি না"।
- **`sync-after-commit` এর ব্যর্থ assign গুলো:** database এ assign **হয়ে গেছে** (commit আগেই), শুধু
  email এর `429` এর জন্য user error দেখল। সে আবার চেষ্টা করলে?
- **`fire-and-forget` এর `provider 429` আর `সফল-কিন্তু-email-নেই`:** সংখ্যা দুটো প্রায় সমান। কেউ
  অপেক্ষা করছে না, তাই কেউ জানেও না। `provider এ একসাথে সর্বোচ্চ: 50` — সীমাহীন, provider এর সীমায়
  গিয়ে ঠেকেছে।
- **`queue` এর `email বাকি` আর `email p99`:** ক্ষতিটা হারিয়ে যায়নি — user এর latency থেকে সরে
  **backlog** আর **দেরি** তে গেছে। এটা ইচ্ছাকৃত বিনিময়।

## নিজে ভেঙে দেখো (Experiments)

1. **Worker সংখ্যা আর Little's Law:** `WORKERS=2 npm run scenario -- queue`। Backlog কত হলো, email p99
   কত? (এই মেশিনে: বাকি ২৬৫, p99 ~২০ সেকেন্ড।) ধীর phase এ ২টা worker প্রতি সেকেন্ডে কয়টা email
   পাঠাতে পারে, আর আসছে কয়টা — হাতে হিসাব করে মেলাও।
2. **In-memory queue এর দুর্বলতা:** `CRASH_AT_MS=14000 npm run scenario -- queue`। ধীর phase এর
   মাঝখানে API process `SIGKILL` হয় আর নতুন করে চালু হয় (deploy এর মতো)। `সফল-কিন্তু-email-নেই`
   কত? (এই মেশিনে: ~১০৩।) User রা সবাই "সফল" দেখেছিল। এই সমস্যা Lesson 7.3 এর BullMQ (Redis এ রাখা
   queue) সমাধান করে। একই জিনিস `fire-and-forget` এ চালাও (এই মেশিনে: ~৫৯ — crash ছাড়ার সমানই) — কেন
   crash এখানে প্রায় কিছু যোগ করল না?
3. **Timeout এর সীমা:** `SLOW_LATENCY_MS=6000 npm run scenario -- sync-after-commit`। Provider এর
   latency এবার client timeout (৫ s) এর বেশি। ধীর phase এ assign কতটা ব্যর্থ, আর `"ব্যর্থ" বলা হলো,
অথচ email গেছে` কত? (এই মেশিনে: ১০০% ব্যর্থ, আর ১৫৯ জনের email গেছে।)
4. **"Pool বড় করে দাও":** `POOL_MAX=100 npm run scenario -- sync-in-tx`। List বাঁচল? (বাঁচে।) এবার
   Lesson 5.6 মনে করো: TaskFlow এর ৬টা instance × ১০০ = কত connection, আর Postgres এর `max_connections`
   কত? আর প্রতিটা connection ৪ সেকেন্ড ধরে একটা খোলা transaction — row lock সহ।
5. **Code এ হাত দাও:** `api.ts` এর `sendEmail` এ `signal: AbortSignal.timeout(1000)` যোগ করো, তারপর
   `npm run scenario -- sync-in-tx`। List বাঁচল? Assign এর কী হলো? Timeout কি সমাধান, নাকি ক্ষতি ছোট
   করা? (এই মেশিনে: list ব্যর্থ ২০৭ থেকে ৭৩; আর `"ব্যর্থ" বলা হলো, অথচ email গেছে` ১০ থেকে ৮০ — কেন
   বাড়ল?) শেষে code আগের মতো করে দিও।

## Project Structure

```
lesson-7.1-async-thinking/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── modes.ts           # চারটা mode এর নাম (api আর scenario দুজনেই ব্যবহার করে)
    ├── pool.ts            # Sequelize pool এর ছোট নকল: max, লাইন, acquire timeout
    ├── queue.ts           # সবচেয়ে ছোট job queue: array + নির্দিষ্ট সংখ্যক worker
    ├── provider.ts        # নকল email provider (latency বদলানো যায়, সীমা ছাড়ালে 429)
    ├── api.ts             # TaskFlow API: assign (চারটা mode) + list + /internal/stats
    └── scenario.ts        # process চালু, load, provider ধীর/স্বাভাবিক, phase অনুযায়ী report
```

সব env (`scenario.ts` এর উপরে): `PHASE_MS` (8000), `SLOW_LATENCY_MS` (4000), `ASSIGN_RPS` (20),
`LIST_RPS` (50), `POOL_MAX` (10), `CLIENT_TIMEOUT_MS` (5000), `CRASH_AT_MS` (নেই), আর api এর
`WORKERS` (8), `ACQUIRE_TIMEOUT_MS` (3000)।
