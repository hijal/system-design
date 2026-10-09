# TaskFlow Reliable Consumer Lab - Idempotency, Retry Storm, DLQ, Backpressure

> Lesson 7.4 - Idempotency, Retry, Exponential Backoff, DLQ, Backpressure · **Tier 1 - Runnable Code** (deterministic simulation)

## কী বানাচ্ছি

চারটা ছোট program, প্রতিটা lesson এর একটা অংশের প্রশ্নের উত্তর সংখ্যায়:

| Script                 | প্রশ্ন                                                                                                         | Lesson § |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run idempotency`  | একই message আবার এলে (crash এর পরে, বা দুজন worker একসাথে) - ছয়টা consumer কৌশলের কোনটা email একবারই পাঠায়?  | ১.২      |
| `npm run storm`        | অনেক job একসাথে ব্যর্থ হলে - চারটা retry নীতি provider এর উপর কী চাপ দেয়, কতগুলো শেষ পর্যন্ত সফল হয়?         | ১.৩      |
| `npm run dlq`          | কিছু job কখনো সফল হবে না (poison), আর মাঝে একটা outage - সীমাহীন retry, DLQ, আর error এর ধরন অনুযায়ী retry    | ১.৪      |
| `npm run backpressure` | Consumer এর চেয়ে বেশি কাজ এলে - সীমাহীন queue, সীমা + 503, সীমা + অপেক্ষা, আর অগ্রাধিকার অনুযায়ী ফেলে দেওয়া | ১.৫      |

**কেন simulation?** প্রশ্নগুলো "কোন মুহূর্তে crash হলে", "সবাই একসাথে ফিরলে", "৫ মিনিট ধরে poison জমলে" -
এগুলো আসল system এ ইচ্ছামতো, বারবার একইভাবে ঘটানো কঠিন। `idempotency` কোনো random ব্যবহার করে না - সব
crash point আর দুটো worker এর ধাপের সব সম্ভাব্য ক্রম **গুনে** দেখে। বাকি তিনটা seed দেওয়া - প্রতিবার
হুবহু একই সংখ্যা।

**কী নেই (সৎ নোট):** এগুলো model, আসল database বা provider না। `idempotency` তে প্রতিটা ধাপ (একটা
statement, একটা API call) atomic ধরা - বাস্তবে একটা API call নিজেও মাঝপথে ভাঙতে পারে (request গেল, উত্তর
এল না), যেটা "email পাঠাল এর পরে crash" এর সমান। Provider এর idempotency key যেকোনো provider সমর্থন করে
ধরে নেওয়া হয়েছে - বাস্তবে সব করে না, আর যারা করে তারা key নির্দিষ্ট সময় পর্যন্ত মনে রাখে। `storm` এর
provider "প্রতি 100 ms এ 10টা" - overload এ ধীর হয়ে যাওয়া নেই, সাথে সাথে 503। Interleaving এর সংখ্যা
"কতগুলো ক্রম সম্ভব" - প্রতিটা সমান সম্ভাব্য না।

## Prerequisite

Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run idempotency
npm run storm
npm run dlq
npm run backpressure
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

Deterministic - আপনার মেশিনেও হুবহু এই সংখ্যা আসবে।

**১. `npm run idempotency`** (শেষের সারাংশ):

```
   strategy                                     crash: lost / twice    concurrent: twice
   1. nothing: send → ack                           0 / 1 (1 point)                6 / 6
   2. check first: check → send → insert → ack      0 / 1 (3 points)             60 / 66
   3. claim first: insert (unique) → send → ack     1 / 0 (2 points)              0 / 12
   4. claim + state (no provider key)               0 / 1 (3 points)             60 / 66
   5. claim + state + provider key                  0 / 0 (3 points)              0 / 66
   6. one transaction (effect in the database)      0 / 0 (1 point)                0 / 6
```

**২. `npm run storm`**:

```
── (a) everyone at once: 1000 jobs at t = 0, provider up

   policy                        attempts     max per 100ms     ok    gave up   last ok  delay p99
   retry immediately                 9750              1990     50        950    450 ms     450 ms
   fixed 1 s later                   9550              1000    100        900     9.5 s      9.5 s
   exponential (no jitter)           9550              1000    100        900    46.0 s     46.0 s
   exponential + full jitter         7152              1456   1000          0    20.3 s     16.6 s

── (b) outage: 1000 jobs (50/s, for 20 s), provider down 0–5.0 s

   policy                        attempts     max per 100ms     ok    gave up   last ok  delay p99
   retry immediately                 3205                50    767        233    20.0 s     350 ms
   fixed 1 s later                   2192                30   1000          0    20.0 s      8.4 s
   exponential (no jitter)           2415                30   1000          0    20.0 s     13.1 s
   exponential + full jitter         2682                44   1000          0    28.0 s     13.3 s
```

**৩. `npm run dlq`**:

```
   policy                                  poison worker time     max waiting  good delay p99       to DLQ (good / poison) redriven → arrived   pending (good / poison)
   retry forever (no limit)                               74%            1489          93.8 s                        0 / 0              0 → 0                   0 / 131
   5 times, then DLQ                                      68%            1292          76.1 s                      0 / 135              0 → 0                     0 / 0
   5 times; permanent to DLQ at once                      28%             352         338.5 s                    159 / 135          159 → 159                     0 / 0
   permanent at once; transient 12 times                  28%             417          45.9 s                      0 / 135              0 → 0                     0 / 0
```

**৪. `npm run backpressure`**:

```
── burst (300/s for 5 s, then 50/s)

   policy                                     queue max    producer held   rejected (urgent / low)   wait p99 (all / urgent)  finished
   unbounded queue                                 1001                0                     0 / 0             9.8 s / 9.8 s    60.0 s
   limit 500, 503 when full                         500                0                 250 / 251             5.0 s / 5.0 s    60.0 s
   limit 500, producer waits                        500              501                     0 / 0             9.8 s / 9.8 s    60.0 s
   priority: drop less urgent above 300             475                0                   0 / 584             9.6 s / 2.4 s    60.0 s

── sustained (always 130/s)

   unbounded queue                                 1801                0                     0 / 0           17.8 s / 17.8 s    78.0 s
   limit 500, 503 when full                         500                0                 650 / 651             5.0 s / 5.0 s    65.0 s
   limit 500, producer waits                        500             1301                     0 / 0           17.8 s / 17.8 s    78.0 s
   priority: drop less urgent above 300             301                0                  0 / 1501              8.6 s / 0 ms    63.0 s
```

## কী দেখার জন্য এটা বানানো

- **idempotency এর কৌশল ২ আর ৩ - দুটো আলাদা ভুল।** "আগে দেখুন" crash এ duplicate দেয় আর দুজন একসাথে
  এলে ৬৬ টা ক্রমের ৬০টায় duplicate (দেখা আর লেখার মাঝে ফাঁক - race)। "আগে দাবি" race আটকায় (unique
  constraint), কিন্তু দাবির পরে crash হলে email **হারায়** - দ্বিতীয় delivery দেখে "দাবি হয়ে গেছে", বাদ দেয়।
  কৌশল ৪ দেখায় `pending`/`sent` অবস্থা একা যথেষ্ট না - "পাঠাল, তারপর crash" এ আবার পাঠায়। শুধু ৫ (provider
  এর idempotency key) আর ৬ (effect নিজেই database এ, একই transaction এ) সব সারিতে ১।
- **storm (ক) এর "সফল" কলাম:** স্থির আর jitter ছাড়া exponential - দুটোতেই ১০০০ এর মধ্যে ১০০। ব্যর্থ ৯৯০টা
  **একই মুহূর্তে** আবার আসে, provider সেই মুহূর্তে ১০টাই নিতে পারে। নিচের প্রতি সেকেন্ডের table এ দেখুন:
  jitter ছাড়া exponential এর চেষ্টা ০, ১, ৩, ৬ সেকেন্ডে দলা বেঁধে। Full jitter একই সীমার মধ্যে ছড়িয়ে দেয় -
  ১০০০ ই সফল, আর মোট চেষ্টা কম।
- **storm (খ) - সৎ অংশ:** job যখন এমনিতেই ছড়িয়ে আসে, jitter এর প্রায় কোনো লাভ নেই (এখানে বরং সামান্য বেশি
  চেষ্টা)। Jitter synchronization এর ওষুধ - synchronization না থাকলে সে কিছু সারায় না। কিন্তু "সাথে সাথে
  আবার" দুই জায়গাতেই খারাপ: outage এ ০.৫ সেকেন্ডে ১০ বার চেষ্টা শেষ করে ২৩৩টা job হাল ছাড়ে।
- **dlq এর প্রথম সারি:** poison এর ২% job worker এর সময়ের **৭৪%** খায় - প্রতিটা ৩০ সেকেন্ড পর পর ২ সেকেন্ড,
  আর তারা জমতেই থাকে (শেষে ১৩১টা তখনো চলছে)। ভালো job এর p99 প্রায় দেড় মিনিট।
- **dlq এর তৃতীয় সারি:** permanent error আলাদা করায় poison এর খরচ ২৮% এ নামে - কিন্তু ৫ বারের retry (১+২+৪+৮
  = ১৫ s) ৩০ সেকেন্ডের outage ঢাকে না, তাই **১৫৯টা ভালো job DLQ তে**; ৪০০ s এ redrive এর পরে পৌঁছায়, তাই
  p99 ৩৩৮ s। চতুর্থ সারি transient কে লম্বা সময় দেয় - DLQ তে শুধু poison, p99 ৪৬ s।
- **dlq এর দ্বিতীয় সারি - একটা দুর্ঘটনা:** এখানে DLQ তে ভালো job ০, কিন্তু সেটা নীতির গুণে না। Poison এর
  কারণে লাইন এত লম্বা (১২৯২) যে outage এ ব্যর্থ job এর পরের চেষ্টা লাইনের অপেক্ষাতেই outage পার হয়ে যায়।
  সুস্থ system এ (লাইন ছোট) একই নীতি তৃতীয় সারির মতো আচরণ করত।
- **backpressure এর burst:** সীমাহীন queue ১০০০ এর ঢেউ শুষে নেয়, সবাই ~১০ s এর মধ্যে। ৫০০ এর সীমা সেই ঢেউ
  থেকে ৫০১টা ফিরিয়ে দেয় - যেটা queue সামলাতে পারত। সীমা অপেক্ষার সীমা: `৫০০ ÷ ১০০/s = ৫ s`।
- **backpressure এর "producer অপেক্ষা করে":** queue এর দৈর্ঘ্য ৫০০ তে থামে, কিন্তু অপেক্ষা সীমাহীনের
  সমান - লাইনটা শুধু producer এর কাছে সরে গেছে (১৩০১টা HTTP request ঝুলে)। Backpressure মানে চাপটা
  **উপরে** পাঠানো; উপরের কেউ না থামলে (user, client) শুধু জায়গা বদলায়।
- **sustained এ অগ্রাধিকার:** জরুরি job এর p99 **০ ms** - কম জরুরি গুলোর ১৫০১টা বাদ। Overload এ কোনো কাজ তো
  বাদ যাবেই; প্রশ্ন শুধু কোনটা।

## নিজে ভেঙে দেখুন (Experiments)

1. **idempotency তে নতুন কৌশল:** `idempotency.ts` এ কৌশল ২ কে বদলে "check → insert → send → ack" করুন (দেখার
   পরে আগে লিখুন, তারপর পাঠান)। কোন crash point এ কী হয়? এটা কোন কৌশলের মতো হয়ে গেল, আর দুজন একসাথে এলে কী হয়?
   (এই মেশিনে: "table এ লিখল" এর পরে crash → হারাল; আর একসাথে ৫২ টা ক্রমের ৪০টায় দুবার - দুটো দোষ একসাথে।)
2. **বেশি চেষ্টা কি বাঁচায়?** `MAX_ATTEMPTS=20 npm run storm`। (ক) তে স্থির আর jitter ছাড়া exponential এর
   সফল কত হলো? (এই মেশিনে: ২০০ - ১০ বার থেকে ২০ বার করে ১০০ থেকে ২০০।) কেন চেষ্টা দ্বিগুণ করে সমস্যা যায় না?
3. **Outage লম্বা করুন:** `OUTAGE_MS=15000 npm run storm`। (খ) তে কোন নীতি কতগুলো হাল ছাড়ল? সর্বোচ্চ ১০ চেষ্টার
   exponential এর মোট অপেক্ষা হাতে হিসাব করুন (১০০ ms × (২⁹ − ১))। (এই মেশিনে: jitter ছাড়া exponential ০ জন হাল
   ছাড়ে, full jitter ৫৩ জন - কেন? Full jitter এর গড় অপেক্ষা সীমার অর্ধেক, তাই একই চেষ্টার সংখ্যায় মোট সময় কম।)
4. **সীমা কত রাখবেন?** `LIMIT=1500 npm run backpressure`। burst এ কেউ ফিরল? sustained এ কী হলো? TaskFlow এর
   email queue এর জন্য "user সর্বোচ্চ কত অপেক্ষা মেনে নেবে" থেকে সীমা হিসাব করুন।
5. **অন্য seed:** `SEED=11 npm run storm` আর `SEED=11 npm run dlq`। সংখ্যা বদলায়, আকৃতি একই থাকার কথা। (এই
   মেশিনে dlq এর তৃতীয় সারিতে DLQ তে ভালো job ১৯৬টা।)

## Project Structure

```
lesson-7.4-reliable-consumers/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── random.ts          # seed দেওয়া random (mulberry32), percentile
    ├── sim.ts             # ছোট discrete-event simulator
    ├── idempotency.ts     # ছয়টা consumer কৌশল × সব crash point × সব interleaving
    ├── storm.ts           # চারটা retry নীতি × দুটো পরিস্থিতি
    ├── dlq.ts             # poison, outage, DLQ, redrive - চারটা নীতি
    └── backpressure.ts    # burst আর sustained load × চারটা নীতি
```
