# TaskFlow Split Brain Lab — Timeout, Process Pause আর Fencing Token

> Lesson 6.1 — Distributed System এ কী কী ভাঙে · **Tier 1 — Runnable Code** (simulation + আসল multi-process demo)

## কী বানাচ্ছি

দুটো জিনিস, database বা Docker ছাড়া:

| Script                | কী দেখায়                                                                                                                                                                   | Lesson § |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run detector`    | Heartbeat + timeout দিয়ে "primary মৃত কিনা" ঠিক করা — জীবিত primary কে দিনে কতবার ভুল করে মৃত ঘোষণা করা হয়, বনাম আসল crash টের পেতে কত সময় লাগে (seed দেওয়া simulation) | ১.৩      |
| `npm run split-brain` | দুটো **আসল** Node process (A, B) lease নিয়ে reminder job এর leader হতে লড়ে। A থেমে যায়, lease হারায়, B leader হয় — তারপর A জেগে উঠে নিজেকে এখনো leader ভাবে            | ১.৫      |
| `npm run fenced`      | একই গল্প, কিন্তু storage প্রতিটা লেখার **fencing token** যাচাই করে                                                                                                          | ১.৬      |

A এর "থেমে যাওয়া" হলো একটা synchronous busy loop — stop-the-world GC যেভাবে পুরো thread আটকায়,
ঠিক সেভাবে: কোনো timer চলে না, lease renew হয় না, আর থামা process জানেও না যে সে থেমে ছিল।

তিনটা service (lock, storage, email provider) সরলতার জন্য একটাই Express process এ চলে। A আর B
আলাদা process (`child_process.fork`) — তাই A থামলে B আর service গুলো চলতে থাকে, বাস্তবের মতোই।

## Prerequisite

Node.js 22+। Docker লাগবে না। Linux, macOS, Windows — সবখানে চলে।

## Setup

```bash
npm install
```

## Run

```bash
npm run detector
npm run split-brain
npm run fenced
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. `npm run detector`** — deterministic, তোমার মেশিনেও হুবহু এই সংখ্যা আসবে:

```
   Primary 24 ঘণ্টা জীবিত, heartbeat প্রতি 100 ms
   heartbeat পৌঁছেছে 852,617 টা; দুটোর মধ্যে সবচেয়ে লম্বা নীরবতা 7.75 s

   timeout     ভুল "মৃত" ঘোষণা / দিন     আসল crash টের পেতে (p50 / p99)
     150 ms           8751                101 ms /   151 ms
     300 ms            241                251 ms /   301 ms
     500 ms            102                451 ms /   501 ms
     1.00 s             53                951 ms /   1.00 s
     2.00 s             42                1.95 s /   2.00 s
     5.00 s             22                4.95 s /   5.00 s
    10.00 s              0                9.95 s /  10.00 s
```

**২. `npm run split-brain`** — আসল process আর আসল timer, তাই ms গুলো প্রতিবার সামান্য আলাদা হবে;
কিন্তু ঘটনার ক্রম আর শেষের ফল একই থাকার কথা (এই মেশিনে পরপর কয়েকবার চালিয়ে একই ফল এসেছে):

```
     703 ms  A      cursor = 3 পড়লাম … তারপর process থেমে গেল (2500 ms, stop-the-world)
    1793 ms  lock   lease → B (token 2)
    1796 ms  email  batch 3 পাঠাল B
    ...
    3025 ms  store  cursor 9 → 10  (B, token 2)
    3203 ms  A      আবার চলছি — আমার কাছে মনে হচ্ছে কিছুই হয়নি, batch 3 পাঠাচ্ছি
    3204 ms  email  batch 3 পাঠাল A   ← আবার! duplicate
    3206 ms  store  cursor 10 → 4  (A, token 1)   ← পিছনে গেল!
    3228 ms  email  batch 4 পাঠাল B   ← আবার! duplicate
    ...
   ── ফল ──
   reminder batch পাঠানো হয়েছে: 16 বার, আলাদা batch 10 টা
   একাধিকবার গেছে: 6 টা batch  (3: B+A, 4: B+B, 5: B+B, 6: B+B, 7: B+B, 8: B+B)
   storage এ প্রত্যাখ্যাত লেখা: 0
```

**৩. `npm run fenced`**:

```
    3201 ms  A      আবার চলছি — আমার কাছে মনে হচ্ছে কিছুই হয়নি, batch 3 পাঠাচ্ছি
    3202 ms  email  batch 3 পাঠাল A   ← আবার! duplicate
    3203 ms  store  ✗ A এর লেখা প্রত্যাখ্যাত: token 1 < 2
    3204 ms  A      storage লেখা ফিরিয়ে দিল: আমার token 1 < 2 — আমি আর leader না, থামলাম
    ...
   ── ফল ──
   reminder batch পাঠানো হয়েছে: 16 বার, আলাদা batch 15 টা
   একাধিকবার গেছে: 1 টা batch  (3: B+A)
   storage এ প্রত্যাখ্যাত লেখা: 1
```

## কী দেখার জন্য এটা বানানো

- **`detector`:** প্রতিটা সারিতে বাম কলাম ছোট করলে ডান কলাম ভালো হয়, আর উল্টোটা। "সবচেয়ে লম্বা
  নীরবতা 7.75 s" — primary পুরো সময় জীবিত ছিল, তবু ৭ সেকেন্ডের বেশি চুপ ছিল একবার।
- **`split-brain`:** সময়ের দিকে তাকাও। A থামে 703 ms এ, lease এর মেয়াদ শেষ হয় ~1790 ms এ, B leader
  হয়। 3203 ms এ A জাগে — আর **তার code এর কোনো লাইন ভুল না**: সে lease যাচাই করেছিল, lease তখন
  valid ছিল। ফাঁকটা যাচাই আর ব্যবহারের মাঝখানে। তারপর তার একটা পুরনো লেখা cursor কে 10 থেকে 4 এ
  ফিরিয়ে দেয় — আর B বিশ্বস্তভাবে 4…8 আবার পাঠায়। **একটা** stale লেখা, **ছয়টা** duplicate batch।
- **`fenced`:** storage A এর লেখা ফিরিয়ে দেয় (token 1 < 2), cursor অক্ষত, A নিজেই বুঝে থেমে যায়।
  কিন্তু batch 3 তবু দুবার গেছে — কারণ email provider token দেখে না। Fencing শুধু সেই resource কে
  রক্ষা করে যে token যাচাই করে।

## নিজে ভেঙে দেখো (Experiments)

1. **Pause lease এর চেয়ে ছোট:** `PAUSE_MS=600 npm run split-brain`। Duplicate কয়টা? কেন — lease এর
   কতটা বাকি ছিল যখন A থামল?
2. **Lease লম্বা করো:** `LEASE_MS=5000 npm run split-brain`। Duplicate শূন্য — কিন্তু মোট কয়টা batch
   গেছে (default এ 16)? A থেমে থাকার সময় কে reminder পাঠাচ্ছিল? এবার `detector` এর table এর সাথে
   মেলাও: lease এর মেয়াদ আসলে একটা failure detector এর timeout।
3. **Email কেও রক্ষা করো:** `src/services.ts` এর `/email` কে idempotent বানাও — একই batch দ্বিতীয়বার
   এলে পাঠানো ছাড়াই `ok` ফেরত দাও (Lesson 2.5 এর idempotency key, এখানে key = batch number)।
   তারপর `npm run fenced` — duplicate শূন্য হওয়ার কথা। কেন এটা fencing এর চেয়ে সহজ ছিল এখানে?
4. **"আবার যাচাই করলেই তো হয়":** `src/worker.ts` এ pause এর পরে, email পাঠানোর ঠিক আগে lease টা
   আবার নিজের ঘড়িতে যাচাই করো (মেয়াদ শেষ হলে থামো)। এই নির্দিষ্ট ক্ষেত্রে কাজ করবে। এবার
   `stopTheWorld` কে নতুন যাচাইয়ের **পরে** সরাও। কী হয়? এই পরীক্ষাটা থেকে কী শিখলে?

## Project Structure

```
lesson-6.1-split-brain/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
└── src/
    ├── random.ts          # seed দেওয়া PRNG, latency, percentile (Lesson 5.9 থেকে)
    ├── detector.ts        # heartbeat/timeout simulation — ভুল ঘোষণা বনাম টের পাওয়ার সময়
    ├── services.ts        # Express: lock service (lease + token), storage (cursor, fencing), email provider
    ├── worker.ts          # reminder worker process — lease নেয়, cursor পড়ে, email পাঠায়, cursor লেখে
    └── scenario.ts        # runner: service চালায়, A আর B fork করে, সব event সময় অনুযায়ী মিলিয়ে ছাপে
```

**যাচাই:** এই মেশিনে (Node 26) `tsc --noEmit` clean; `detector` কয়েকবার চালিয়ে হুবহু একই output;
`split-brain` আর `fenced` প্রতিটা তিনবার করে চালিয়ে একই ঘটনার ক্রম আর একই শেষ ফল; experiment ১ আর ২
চালিয়ে দেখা হয়েছে (০ duplicate; lease 5000 এ মোট 8 batch)। Experiment ৩ আর ৪ তোমার code বদলানোর
কাজ — সেগুলোর ফল চালিয়ে দেখা হয়নি।
