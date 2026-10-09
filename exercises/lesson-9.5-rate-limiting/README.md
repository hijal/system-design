# TaskFlow Rate Limiting Lab - কে কতটা চাইতে পারে

> Lesson 9.5 - Rate Limiting Algorithms · **Tier 1 - Runnable Code** (Express middleware + আসল HTTP; Docker লাগে না)

## কী বানাচ্ছি

পাঁচটা rate limiting algorithm - fixed window counter, sliding window log, sliding window counter,
token bucket, leaky bucket - একই interface এ, আর তিনটা script যা তাদের পার্থক্যটা **সংখ্যায়** দেখায়।
শেষ script টা তিনটা আসল Express instance চালায়, কারণ সবচেয়ে দামি ভুলটা algorithm এ না - গোনাটা
কোথায় রাখা হলো তাতে।

| Script                | প্রশ্ন                                                                            | Lesson §  |
| --------------------- | --------------------------------------------------------------------------------- | --------- |
| `npm run window`      | Window এর সীমানায় কে কত বেশি ঢুকতে দেয়? আর প্রতি user এ কত memory?              | ১.২ – ১.৪ |
| `npm run bucket`      | Burst সহ্য করা বনাম downstream কে সমান গতিতে খাওয়ানো - token বনাম leaky          | ১.৫       |
| `npm run distributed` | তিনটা instance, সীমা ১০ - user আসলে কতটা পায়? আর 429 এর উত্তরটা কেমন হওয়া উচিত? | ১.৬ – ১.৭ |

**সৎ নোট:**

- **প্রথম দুটো script এ সময়টা virtual** - `check(key, now)` কে হাতে গোনা `now` দেওয়া হয়, কোনো
  `setTimeout` নেই। তাই ফল **সম্পূর্ণ deterministic**: প্রতি run এ হুবহু একই সংখ্যা, machine ভেদেও।
  এটা ইচ্ছাকৃত - algorithm এর পার্থক্য মাপতে গিয়ে scheduler এর noise ঢুকতে দিতে চাইনি।
- **তৃতীয় script এ সব আসল** - তিনটা Express app আলাদা port এ, আসল HTTP, আসল middleware, আসল
  429 আর header। ওখানে সময়ের সংখ্যা ওঠানামা করে (নিচে দেখুন)।
- **"ভাগ করা store" Redis না** - একই process এর একটা object, সামনে `await sleep(1)` দিয়ে RTT এর একটা
  ভান। তাই ওই RTT এর latency এর দাম এখানে **মাপা যায়নি** (p99 এর পার্থক্য noise এর সমান)। আসল Redis এ,
  বিশেষত অন্য AZ তে, এটা প্রতিটা request এ যোগ হয়। Redis এর atomicity (`INCR`, Lua script) ও এখানে
  নকল করা হয়নি - এক process, তাই race নেই; আসল distributed limiter এ সেটাই সবচেয়ে সূক্ষ্ম অংশ।
- **Memory এর সংখ্যা `process.memoryUsage().heapUsed` এর পার্থক্য**, `--expose-gc` দিয়ে আগে-পরে GC
  চালিয়ে। এটা একটা অনুমান, hand-counted byte না - V8 এর Map আর array এর overhead সহ। তুলনাটাই আসল,
  পরম সংখ্যাটা না।
- **Leaky bucket এখানে queue হিসেবে** (request অপেক্ষা করে, তারপর সমান গতিতে বেরোয়)। "Leaky bucket as a
  meter" নামে আরেকটা রূপ আছে যা token bucket এর প্রায় সমান আচরণ করে - সেটা আলাদা করে দেখানো হয়নি।
- **যা মাপা হয়নি:** limiter নিজে মরলে কী হয় (fail open বনাম fail closed), একই user এর একসাথে অনেক
  request এ race, key এর মেয়াদ শেষ হওয়া (TTL) আর evict হয়ে যাওয়া, IP বনাম user বনাম API key ধরে
  সীমা, আর সীমার বিভিন্ন স্তর (per second + per day)।
- **যাচাই করা হয়েছে** Node 26 এ, প্রতিটা script তিনবার করে: **সব গোনা প্রতি run এ হুবহু এক**;
  memory তে fixed window ১০৮–১০৯ bytes/user (বাকি দুটো অপরিবর্তিত), আর `distributed` এর p99
  ০.৭–২.১ ms এ দোলে।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না। Port 4401–4403 খালি থাকতে হবে।

## Setup

```bash
npm install
```

## Run

```bash
npm run window
npm run bucket
npm run distributed
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run window` - সীমা ১০/সেকেন্ড। দুটো টেবিলেই fixed window **২ গুণ** ঢুকতে দেয়, আর sliding counter
সাধারণ পরীক্ষায় ভালো দেখালেও সব phase ধরে প্রায় fixed window এর মতোই খারাপ:

```
── a. A burst at the window boundary - 10 just before, 10 just after ──
   fixed window                    20         24 ms              2.0x
   sliding log                     10          9 ms              1.0x
   sliding counter                 11         16 ms              1.1x

── b. The most one user can send - the worst over every start time ──
   fixed window                        20              2.0x            100 ms
   sliding log                         10              1.0x              0 ms
   sliding counter                     19              1.9x            820 ms
```

Memory তে `sliding log` এর দাম সবচেয়ে বেশি (~২৫৩ bytes/user, বাকিদের ~২ গুণ)।

`npm run bucket` - একই আগমন, দুই রকম বেরোনো। `250 ms` এ downstream এ সর্বোচ্চ চাপ **token bucket 11**,
**leaky bucket 3**; আর capacity বাড়ালে burst এ পাশ করা সংখ্যা ঠিক capacity এর সমান (1 → 1, 5 → 5, 10 → 10):

```
   capacity                     passed  passed in burst       load/250ms
   1                                16                1                2
   10                               25               10               11
   50                               45               30               31
```

`npm run distributed` - সবচেয়ে জরুরি সংখ্যা: **৩ টা instance মানে সীমার ৩ গুণ**।

```
   where counted                   200      429     real limit  store call
   each instance counts its own    30       30         3.0x             0
   shared store (RTT 1 ms)            10       50         1.0x            60
```

আর 429 এর উত্তরে `x-ratelimit-remaining: 0` আর `retry-after: 1s` থাকবে।

সময়ের সংখ্যা আপনার machine এ আলাদা হবে; **গোনা (20, 10, 19, 11, 3, 30, 10, 60) হুবহু এক হওয়ার কথা**।

## কী দেখার জন্য এটা বানানো

- **Fixed window এর সীমানা:** limit ১০ মানে "যেকোনো ১ সেকেন্ডে ১০" না - "প্রতিটা ঘড়ি-ধরা সেকেন্ডে ১০"।
  দুটো সেকেন্ডের সংযোগস্থলে ২০টা ঢুকে যায়, ২৪ ms এর ভেতরে। যে downstream কে আপনি বাঁচাতে চেয়েছিলেন,
  সে ওই মুহূর্তে দ্বিগুণ চাপ পায়।
- **Sliding counter এর আসল চরিত্র:** অংশ ক বলে ১.১x, অংশ খ বলে ১.৯x - একই algorithm। পার্থক্যটা মাপার
  পদ্ধতিতে: একটা নির্দিষ্ট burst দেখলে সে ভালো, কিন্তু **সব সম্ভাব্য সময়** ধরে সবচেয়ে খারাপটা খুঁজলে
  approximation এর ফাঁক বেরিয়ে আসে (বিশেষত নতুন key তে, যখন previous window শূন্য)। একটা মাপ দিয়ে
  algorithm বিচার করার বিপদ এটাই।
- **Sliding log এর দাম:** একদম নির্ভুল (১.০x, সব পরীক্ষায়) - কিন্তু প্রতি user এ limit সংখ্যক timestamp
  রাখতে হয়। ~২৫৩ bytes/user মানে ১০ লাখ user এ ~২৫৩ MB, শুধু rate limit এর জন্য। আর limit ১০ না হয়ে
  ১০০০ হলে এটা ১০০ গুণ।
- **Token vs leaky:** দুটোরই হার সমান, কিন্তু downstream এ চাপের **আকার** আলাদা - ১১ বনাম ৩। প্রশ্নটা
  "কত" না, "কত একসাথে"।
- **Capacity মানে ঠিক কী:** token bucket এর capacity = আপনি যত বড় burst downstream এ যেতে দিতে রাজি।
  সংখ্যাটা আক্ষরিক - capacity ১০ মানে ঠিক ১০টা একসাথে।
- **৩ গুণ ফাঁস:** এটাই সেই ভুল যেটা production এ সবচেয়ে বেশি হয় - প্রতিটা instance নিজের মতো গুনছে,
  তাই আসল সীমা = (আপনার লেখা সীমা) × (instance সংখ্যা)। Autoscaling এ instance বাড়লে সীমাও নিজে থেকে
  বেড়ে যায়, আর কেউ টের পায় না।

## নিজে ভেঙে দেখুন (Experiments)

1. **সীমা আর window বদলান:** `LIMIT=100 WINDOW_MS=60000 npm run window`. Fixed window এর boundary burst
   এখন কত (সংখ্যায় আর "কত গুণ" এ)? Window বড় করলে burst এর **পরিমাণ** কী হয়, আর সেটা downstream এর
   জন্য বেশি না কম বিপদ? মিনিটে ১০০ বনাম সেকেন্ডে ২ - দুটোর গড় সমান, কোনটা আপনি বাছবেন আর কেন?
2. **Log এর memory:** `LIMIT=1000 USERS=20000 npm run window`. `sliding log` এর bytes/user কত হলো, আর
   বাকি দুটোর? ১০ লাখ user এ প্রতিটার জন্য কত RAM - হিসাব করে লিখুন। কোন সীমায় log আর ব্যবহারযোগ্য না?
3. **Capacity এর প্রভাব:** `CAPACITY=1 npm run bucket`, তারপর `CAPACITY=100`. "চাপ/250ms" কলামটা দেখুন।
   এবার ভাবুন: TaskFlow এর board খোলার সময় browser একসাথে ৮টা API call করে - capacity ১ হলে user এর
   অভিজ্ঞতা কী হবে? সঠিক capacity কীভাবে ঠিক করবেন?
4. **৩ গুণ থেকে ৫ গুণ:** `distributed.ts` এর `PORTS` এ দুটো port যোগ করে ৫টা instance করুন। "আসল সীমা"
   কলামটা কী হলো? এবার ভাবুন: autoscaling instance ২ থেকে ২০ করলে আপনার সীমার কী হয়, আর সেটা কোন
   dashboard এ দেখে আপনি ধরতে পারবেন?
5. **Store মরে গেলে (code বদলাতে হবে):** `sharedStore` এর `check` কে মাঝে মাঝে throw করান (যেমন ৩০%
   সম্ভাবনায়)। এখন middleware কী করবে - **fail open** (ঢুকতে দিন, সীমা নেই) নাকি **fail closed**
   (সবাইকে 429)? দুটোই লিখে চালান, আর প্রতিটার জন্য বলুন: কোন পরিস্থিতিতে কোনটা কম খারাপ? TaskFlow এর
   login endpoint আর board পড়ার endpoint - দুটোর উত্তর কি একই?

## Project Structure

```
src/
  limiters.ts     পাঁচটা algorithm, একই RateLimiter interface এ (check(key, now) → Decision)
  server.ts       Express instance - rate limit middleware, 429 + retry-after + x-ratelimit-* header
  random.ts       percentile, grapheme-সচেতন padding, sleep
  window.ts       script ক - fixed / sliding log / sliding counter: boundary burst, সব phase, memory
  bucket.ts       script খ - token bucket বনাম leaky bucket queue: বেরোনোর আকার, capacity এর প্রভাব
  distributed.ts  script গ - ৩ টা Express instance: নিজের গোনা বনাম ভাগ করা store, আর 429 এর আকার
```

Environment variable: `LIMIT`, `WINDOW_MS`, `SWEEP_MS`, `STEP_MS`, `USERS`, `CAPACITY`, `RATE_PER_SEC`,
`BURST`, `TAIL_MS`, `TAIL_RATE`, `SLOT_MS`, `ATTEMPTS`, `STORE_RTT_MS`।

## Teardown

আলাদা কিছু লাগে না - প্রতিটা script শেষে নিজের server বন্ধ করে দেয়।
