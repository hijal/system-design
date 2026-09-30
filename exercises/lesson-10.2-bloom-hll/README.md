# TaskFlow Probabilistic Lab — Bloom Filter, HyperLogLog, Count-Min Sketch

> Lesson 10.2 — Bloom Filter, HyperLogLog · **Tier 1 — Runnable Code** (চারটা script deterministic
> simulation, Docker লাগে না; পঞ্চমটা আসল Redis 8 এ মাপে, তার জন্য Docker)

## কী বানাচ্ছি

তিনটা probabilistic data structure নিজের হাতে — Bloom filter (সাথে counting Bloom filter), HyperLogLog আর
Count-Min Sketch — আর তাদের দিয়ে TaskFlow এর তিনটা প্রশ্ন: "এই share link কি আছে?", "এই সপ্তাহে কতজন আলাদা
user?", আর "সবচেয়ে গরম board কোনগুলো?"। প্রতিটার ভুল **কত** আর **কোন দিকে**, সেটা সংখ্যায় দেখা। শেষে একই
জিনিস আসল Redis এ (`SADD`, `PFADD`, `BF.*`) — memory কত লাগে।

| Script                | প্রশ্ন                                                                                                                           | Lesson §      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `npm run bloom`       | কত bit/item এ কত false positive? কয়টা hash? Filter ভরে গেলে? আর নাম মুছতে চাইলে?                                                | ১.২ – ১.৪     |
| `npm run penetration` | Bot এলোমেলো share link আন্দাজ করছে — শুধু cache, negative cache, Bloom filter — DB তে কত query? আর filter যদি নতুন link না জানে? | ১.৫ – ১.৬     |
| `npm run hll`         | HyperLogLog কত ভুল করে, precision এর দাম কী, সপ্তাহের user দিনের যোগফল কেন না, আর intersection কেন ভাঙে?                         | ১.৮ – ১.১১    |
| `npm run heavy`       | Count-Min Sketch দিয়ে সবচেয়ে গরম board — কত memory তে ধরা যায়, আর ঠান্ডা board এর সংখ্যা কেন বিশ্বাস করা যায় না?             | ১.১২          |
| `npm run redis`       | আসল Redis 8 এ ১০ লাখ user: `SET` বনাম `HyperLogLog` বনাম `BF` — কত memory? `NONSCALING` filter ভরে গেলে কী হয়?                  | ১.৩, ১.৪, ১.৯ |

**সৎ নোট:**

- **প্রথম চারটা script এ কোনো network, DB বা Redis নেই।** "DB" মানে একটা `Set`, cache একটা `Map` দিয়ে বানানো
  LRU, "request" একটা function call। সময় কোথাও মাপা হয়নি — সব সংখ্যা **গোনা**। "DB query/s" মানে মোট DB query
  ÷ (request ÷ `RPS`)।
- **সব ফল deterministic** — hash স্থির (MurmurHash3 x86_32, দুটো আলাদা seed), এলোমেলো সংখ্যা seed দেওয়া PRNG
  থেকে। প্রথম চারটা script যেকোনো machine এ হুবহু একই সংখ্যা দেবে।
- **`npm run redis` এর সংখ্যা Redis এর version এর উপর নির্ভর করে।** `MEMORY USAGE` এ Redis এর নিজের overhead আর
  allocator এর হিসাব ঢোকে। এখানে `redis:8-alpine` (8.10.1) এ মাপা; অন্য version এ কিছুটা আলাদা হতে পারে।
- **HyperLogLog টা মূল ২০০৭ এর algorithm** (harmonic mean + ছোট সংখ্যায় linear counting) — Redis আর HLL++ এর
  bias correction এখানে নেই, তাই ৫০,০০০–১,০০,০০০ এর আশেপাশে ভুল একটু বেশি দেখাতে পারে। 64-bit hash (দুটো
  32-bit murmur জোড়া), তাই বড় সংখ্যায় hash collision এর সমস্যা নেই।
- **Penetration এর cache টা সরল** — capacity ধরে LRU, negative entry নিজের TTL এ মুছে যায়, আসল board এর entry
  ৩০০ s TTL (run এর চেয়ে লম্বা)। আসল Redis এর `allkeys-lru` আনুমানিক LRU, হুবহু না।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit` আর ESLint clean; পাঁচটা script **তিনবার করে**, প্রতিবার output
  হুবহু এক (byte ধরে মেলানো), `npm run redis` সহ।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। শুধু `npm run redis` এর জন্য Docker (Redis 8 — Bloom filter এর `BF.*` command
Redis 8 এ built-in; তার আগের Redis এ RedisBloom module লাগত)।

## Setup

```bash
npm install
docker compose up -d --wait
```

Redis চলে port **6382** এ, যাতে Lesson 4.4 (6380) আর 7.3 (6381) এর সাথে সংঘাত না লাগে। Persistence বন্ধ।

## Run

```bash
npm run bloom
npm run penetration
npm run hll
npm run heavy
npm run redis
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run bloom` — মাপা false positive তত্ত্বের সাথে মেলে; ১০ bit/নাম এ ~০.৮%; কখনো false negative না; আর bit মুছে
"delete" করলে থাকা নামও হারায়:

```
bit / নাম        k     মাপা false positive        তত্ত্ব      memory
8               6                2.163%    2.158%      977 KB
10              7                0.832%    0.819%    1,221 KB
16             11                0.047%    0.046%    1,953 KB
   ঢোকানো 1,000,000টা নামের কয়টাকে "নেই" বলল (false negative): 0

ঢোকানো                 ধারণক্ষমতার     মাপা false positive   bit এর কত % ১
1,000,000                1x                 0.99%           51.8%
2,000,000                2x                15.76%           76.8%

পদ্ধতি                                 memory       থাকা নাম কে "নেই"       মোছা নাম কে "আছে"   নতুন false positive
সাধারণ bloom, bit মুছে                1,170 KB            360,187               0.0%                0.36%
counting bloom (৪-bit counter)     4,680 KB                  0               0.6%                0.60%
```

`npm run penetration` — negative cache DB এর চাপ **বাড়ায়**, Bloom filter অর্ধেক করে; আর filter নতুন link না জানলে
সত্যিকারের link এ 404:

```
পদ্ধতি                         DB query/s       তার মধ্যে "নেই"  আসল user এর hit  cache এ "নেই" entry     evict
শুধু cache                         2,074            48.4%            73.2%                   0   164,145
+ negative cache 30 s            2,320            43.2%            67.0%              18,647   414,036
+ bloom filter 1%                1,081             0.9%            73.2%                   0   164,145

filter রাখার নিয়ম                       সত্যিকারের link এ 404  নতুন link এর request এর
শুরুতে একবার বানানো                                   49,773                   99.7%
প্রতি 60 s এ DB থেকে নতুন করে                         24,766                   49.6%
তৈরির সাথে সাথে filter এ add                              0                    0.0%
```

`npm run hll` — ১২ KB এ ১ কোটি পর্যন্ত ~১% এর মধ্যে; দিনের সংখ্যা যোগ করলে সপ্তাহ **+১৯৯%**, merge করলে −০.৮৪%;
ছোট intersection এ ভুল কয়েকশো %:

```
আলাদা user                অনুমান        ভুল     correction ছাড়া        ভুল      সঠিক গুনতে ≥
10                        10    +0.03%            11,822  +118117.81%           80 B
1,000,000            996,033    -0.40%           996,033       -0.40%       7,813 KB
10,000,000         9,932,247    -0.68%         9,932,247       -0.68%      78,125 KB

p       register     memory      তত্ত্ব (1.04/√m)       মাপা সাধারণ ভুল       সবচেয়ে খারাপ দিন
14        16,384   12,288 B             0.81%            0.78%             2.13%

আসল (সব ID এর একটা Set)                     472,981      +0.00%
৭টা দিনের সংখ্যা যোগ                             1,415,230    +199.21%
৭টা HLL merge (register ধরে max)             469,026      -0.84%

0.1%                   1,000         4,381    +338.10%
```

`npm run heavy` — ৬৪ KB এর sketch এ top 10 পুরো ধরা, বাড়তি গোনা ≤ ০.৩১%; কিন্তু ঠান্ডা board এর সংখ্যা ৪৮ গুণ
ফোলানো:

```
width × depth       memory   top 10 ধরা      top 10 এ বাড়তি গোনা      ঠান্ডা board এ (≤5 বার)
1024 × 4             16 KB        7/10              ≤ 2.53%             284.6x আসলের
4096 × 4             64 KB       10/10              ≤ 0.31%              48.3x আসলের
```

`npm run redis` — ১০ লাখ user: `SET` ৩৫.৫৫ MB, HyperLogLog ১৪ KB, Bloom ১.৩১ MB; আর `NONSCALING` filter ভরে
গেলে **exception ছাড়াই** প্রায় ৫ লাখ নাম ঢোকে না:

```
SET (SADD)                       35.55 MB               ঠিক 1,000,000, আর কারা
HyperLogLog (PFADD)               14.0 KB        ~999,674 (-0.03% ভুল), কারা না
Bloom (BF.RESERVE 0.01)           1.31 MB            "আছে কি?" — 0.51% ভুল "হ্যাঁ"

filter             MEMORY USAGE    ভেতরের filter     মাপা false positive        ঢোকানো নামে "নেই"
default                 1.07 MB              2                 0.74%                  0
NONSCALING             292.6 KB              1                 1.00%            494,508
```

প্রথম চারটা script এর সংখ্যা তোমার machine এও **হুবহু এক** হওয়ার কথা। `npm run redis` এর memory Redis এর
version ভেদে সামান্য আলাদা হতে পারে।

## কী দেখার জন্য এটা বানানো

- **ভুলের দিকটাই design।** Bloom filter "নেই" বললে সেটা নিশ্চিত, "আছে" বললে হয়তো — তাই সে বসে DB এর **সামনে**,
  "নেই" গুলো ছেঁটে ফেলতে। Count-Min Sketch কখনো কম গোনে না, শুধু বেশি — তাই সে ভারী জিনিস খোঁজায় ভালো,
  হালকা জিনিস গোনায় অকেজো।
- **Bloom এর false negative কখনো algorithm থেকে আসে না — আসে যে insert টা পৌঁছায়নি তার থেকে।** Filter টা
  শুরুতে একবার বানিয়ে রাখলে নতুন link এর ৯৯.৭% request 404 পায়। Bit মুছে delete করলে ৩,৬০,১৮৭টা থাকা নাম
  হারায়। আর Redis এর `NONSCALING` filter ভরে গেলে reply তে error আসে, exception না — কেউ না দেখলে নামগুলো
  নিঃশব্দে হারায়।
- **Negative cache এলোমেলো key এর বিরুদ্ধে কাজ করে না।** প্রতিটা bot slug একবারই আসে, তাই negative entry
  কখনো hit হয় না — শুধু cache এর জায়গা খায় আর আসল board গুলোকে evict করে।
- **HyperLogLog এর আসল শক্তি merge।** দিনের আলাদা user যোগ করলে একই মানুষ সাতবার গোনা হয় (+১৯৯%); HLL
  register ধরে max নিলে সপ্তাহের সঠিক অনুমান, একই ১২ KB এ।
- **HyperLogLog এর ভুল union এর আকারের অনুপাতে, intersection এর না।** তাই দুটো বড় সেটের ছোট overlap বের
  করা যায় না।

## নিজে ভেঙে দেখো (Experiments)

1. **Negative cache এর TTL:** `NEGATIVE_TTL=5 npm run penetration`, তারপর `NEGATIVE_TTL=1`. DB query/s কি
   কখনো "শুধু cache" এর চেয়ে **কম** হয়? কেন হতে পারে না? এবার ভাবো — কোন ধরনের traffic এ negative cache
   সত্যিই কাজে লাগে (Lesson 4.6 এর উদাহরণটা মনে করো)?
2. **Filter এর সঠিকতার দাম:** `RATE=0.001 npm run penetration`. Filter কত বড় হলো, আর DB query/s কত কমল? কোন
   মুহূর্তে আরও ছোট false positive আর লাভ দেয় না?
3. **Rebuild এর ব্যবধান:** `REBUILD=10 npm run penetration`. ভুল 404 কত কমল? ১০ সেকেন্ডে পুরো DB থেকে filter
   বানানোর দাম কী (২ লাখ link, আর ২ কোটি হলে)?
4. **Precision আর merge:** `PRECISION=10 npm run hll`. সপ্তাহের merge এর ভুল কত হলো? TaskFlow এর দুই লাখ
   workspace এর প্রতিটার জন্য প্রতিদিন একটা HLL রাখলে p = 14 আর p = 10 এ মোট memory কত?
5. **Sketch এর আকার আর traffic এর আকার:** `ZIPF=0.8 npm run heavy`. একই width এ top 10 এর বাড়তি গোনা কেন
   বাড়ল? (ইঙ্গিত: CMS এর ভুল মোট request এর অনুপাতে, একটা key এর না।)

## Project Structure

```
docker-compose.yml   Redis 8 (port 6382, persistence বন্ধ) — শুধু npm run redis এর জন্য
src/
  hash.ts            MurmurHash3 x86_32, আর দুটো seed এর জোড়া (double hashing আর 64-bit এর জন্য)
  bloom.ts           BloomFilter, CountingBloomFilter, আর bit/k/false positive এর সূত্র
  hll.ts             HyperLogLog (register, harmonic mean, linear counting, merge)
  cms.ts             CountMinSketch
  random.ts          seed দেওয়া PRNG, Zipf sampler, grapheme-সচেতন টেবিল
  bloom-lab.ts       script ক — bit/item, k, ভরে যাওয়া, delete
  penetration.ts     script খ — share link enumeration: cache, negative cache, Bloom; আর পুরনো filter
  hll-lab.ts         script গ — ভুল বনাম সংখ্যা, precision, সপ্তাহের merge, intersection
  heavy.ts           script ঘ — Count-Min Sketch দিয়ে গরম board
  redis-memory.ts    script ঙ — আসল Redis এ SET / PFADD / BF এর memory, NONSCALING ভরে যাওয়া
```

Environment variable: `ITEMS`, `PROBES`, `TARGET`, `LINKS`, `REQUESTS`, `RPS`, `BOT`, `CACHE`, `NEGATIVE_TTL`, `RATE`,
`ZIPF`, `NEW_PER_SECOND`, `REBUILD`, `RECENT`, `PRECISION`, `TRIALS`, `MAX`, `KEYS`, `DEPTH`, `USERS`, `REDIS_PORT`।

## Teardown

```bash
docker compose down -v
```
