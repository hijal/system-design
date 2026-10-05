# TaskFlow Consistent Hashing Lab — একটা node বদলালে কত key নড়ে

> Lesson 10.1 — Consistent Hashing Deep Dive · **Tier 1 — Runnable Code** (deterministic simulation; Docker লাগে না)

## কী বানাচ্ছি

একটা hash ring (virtual node, weight আর replica বাছাই সহ), আর তার পাশে `hash % N`, rendezvous hashing
আর jump hash — একই `Router` interface এ। চারটা script তাদের পার্থক্যটা **সংখ্যায়** দেখায়: node যোগ বা
বাদ দিলে কত key নড়ে আর কোথায় যায়, ভাগ কতটা সমান, TaskFlow এর cache এ hit rate এর কী হয়, আর hot key এ
কী হয়।

| Script              | প্রশ্ন                                                                                        | Lesson §  |
| ------------------- | --------------------------------------------------------------------------------------------- | --------- |
| `npm run rebalance` | ৪টা node থেকে ৫টা করলে কত key নড়ে, আর কোথায় যায়? একটা node মরলে তার key কে নেয়?           | ১.২ – ১.৩ |
| `npm run vnodes`    | Virtual node কয়টা হলে ভাগ সমান হয়? দ্বিগুণ বড় machine? আর ৩টা copy কোন ৩টা node এ?         | ১.৩ – ১.৫ |
| `npm run cache`     | TaskFlow এর cache ৩ থেকে ৪ node — প্রথম সেকেন্ডে DB এ কত query? আর একটা node ফিরে এলে কী হয়? | ১.৬       |
| `npm run compare`   | Ring বনাম rendezvous বনাম jump hash — আর hot key এ bounded load কী বাঁচায়, কী হারায়?        | ১.৭ – ১.৮ |

**সৎ নোট:**

- **কোনো আসল Redis নেই, কোনো network নেই।** Cache node গুলো একই process এর একেকটা `Map`, আর "request"
  মানে একটা function call। তাই সময়ের কোনো সংখ্যা নেই — সব সংখ্যা **গোনা**: কত key নড়ল, কত hit, কত miss,
  কত stale read।
- **সব ফল deterministic** — key এর নাম স্থির, hash স্থির (FNV-1a + MurmurHash3 এর `fmix32`), আর Zipf
  traffic একটা seed দেওয়া PRNG থেকে। প্রতি run এ, যেকোনো machine এ, হুবহু একই সংখ্যা।
- **"প্রথম ১ সেকেন্ড" মানে প্রথম ৫,০০০টা request** (`RPS=5000` ধরে) — ঘড়ির সময় না, গোনার একক।
- **Cache এ কোনো memory সীমা, TTL বা eviction নেই।** বদলের আগে সব key গরম ধরা হয়েছে, তাই প্রতিটা miss
  এর কারণ শুধু routing বদল। আসল cache এ আগে থেকেই কিছু miss থাকে; পার্থক্যটা তার উপরে যোগ হয়।
- **Bounded load এখানে একটা সরল রূপ** — ১০০০টা request এর একেকটা batch কে "একসাথে চলছে" ধরা, আর প্রতি node
  এর সীমা ওই batch এর ভেতরে। আসল implementation (যেমন HAProxy এর `hash-balance-factor`) চলমান connection
  গোনে।
- **Jump hash এর lookup এ `BigInt` ব্যবহার হয়েছে** (৬৪-bit গুণ এর জন্য) — তাই এখানে তার গতি মাপা অর্থহীন;
  "lookup এর কাজ" কলামে শুধু ধাপ গোনা হয়েছে।
- **যা মাপা হয়নি:** আসল network এ lookup এর latency, data সরানোর সময় (streaming, দুই জায়গায় লেখা),
  membership এর খবর সবার কাছে কখন পৌঁছায় (gossip, 10.1 এর ১.৯), আর Maglev hashing।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit` আর ESLint clean; চারটা script **তিনবার করে**, প্রতিবার
  output হুবহু এক (byte ধরে মেলানো)।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run rebalance
npm run vnodes
npm run cache
npm run compare
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run rebalance` — `hash % N` এ ৮০% key নড়ে, আর তার তিন-চতুর্থাংশ **পুরনো node গুলোর মধ্যেই** ঘোরে;
ring এ virtual node সহ ২০% নড়ে, আর **সবটা** নতুন node এ যায়:

```
routing                        moved  to the new node    among the old
hash % N                       79.9%         25.2%            74.8%
ring (vnode 1)                 30.7%        100.0%             0.0%
ring (vnode 160)               20.1%        100.0%             0.0%

routing                      cache-1   cache-2   cache-4   cache-5      heaviest
ring (vnode 1)                    0%      100%        0%        0%         1.45x
ring (vnode 160)                 29%       19%       25%       27%         1.04x
```

`npm run vnodes` — virtual node ১ এ সবচেয়ে ভারী node ন্যায্য ভাগের **৩ গুণ**, ১৬০ এ ১.১৩x; আর ring থেকে
"পরের ৩টা বিন্দু" নিলে **৪৫%** key এর দুটো copy একই node এ:

```
vnode / node          heaviest       lightest  points on ring   lookup steps
1                        3.06x          0.02x             10            3.4
160                      1.13x          0.90x          1,600           10.7
1000                     1.04x          0.97x         10,000           13.3

rule                            not 3 distinct nodes  not 3 distinct AZs  one AZ loss kills all copies
the next 3 points                              45.3%               76.8%                         11.2%
the next 3 distinct nodes                       0.0%               59.1%                          0.0%
the next 3 distinct AZs                         0.0%                0.0%                          0.0%
```

`npm run cache` — node যোগের প্রথম সেকেন্ডে `hash % N` এ DB তে **২,১৬২**টা query, ring এ **৭৩৭**; আর
একটা node flush ছাড়া ফিরলে ১০ সেকেন্ডে **৬,৪২৯**টা stale read:

```
routing                  first 1 s hit  DB in first 1 s   first 10 s hit  total DB queries
hash % N                         56.8%            2,162            75.4%         26,370
ring (vnode 160)                 85.3%              737            91.6%          9,066

on return                     stale read (10 s)  distinct stale keys  miss (10 s)
put back on the ring as is                6,429                 320          197
flush first, then put back                    0                   0        4,278
```

`npm run compare` — jump hash মাঝের একটা node বাদ দিলে **৪৮.৫%** key নড়ে; hot key এ সাধারণ ring এর সবচেয়ে
ভারী node ন্যায্য ভাগের ~২ গুণ, bounded load এ ঠিক ১.২৫x — বিনিময়ে ১১.৩% request নিজের node এর বাইরে:

```
method                   heaviest  node added  cache-6 removed             lookup work    extra memory
ring (vnode 160)            1.12x        8.8%        10.0%  1 hash + 10.7 comparisons    1,600 points
rendezvous (HRW)            1.02x        9.3%         9.9%                 10 hash            none
jump hash                   1.02x        9.0%        48.5%      1 hash + 2.9 jumps            none

method                          heavy (avg)         heavy (worst)      off its own node
ring (vnode 160)                     2.06x                 2.39x                  0.0%
bounded load, c = 1.25               1.25x                 1.25x                 11.3%
```

সব সংখ্যা তোমার machine এও **হুবহু এক** হওয়ার কথা — সময় কোথাও মাপা হয়নি।

## কী দেখার জন্য এটা বানানো

- **কত নড়ল, আর কোথায় গেল — দুটো আলাদা প্রশ্ন।** `hash % N` এ ৮০% নড়ে, কিন্তু আসল অপচয়টা "পুরনোদের
  মধ্যে" কলামে: ৭৪.৮% নড়া key এক পুরনো node থেকে আরেক পুরনো node এ গেছে — যে data টা ঠিক জায়গাতেই
  ছিল, সেটাও। Ring এ নড়া key এর ১০০% নতুন node এ যায়।
- **Virtual node ছাড়া ring প্রায় অর্থহীন।** ১টা বিন্দুতে সবচেয়ে ভারী node ৩.০৬x, সবচেয়ে হালকাটা প্রায়
  শূন্য। আর একটা node মরলে তার **সব** key একজন প্রতিবেশীর ঘাড়ে পড়ে (১০০%) — সবচেয়ে খারাপ জায়গায় cascade।
- **Virtual node এর দাম লগারিদমিক।** ১০ থেকে ১০০০ virtual node এ lookup এ তুলনা ৬.৭ থেকে ১৩.৩ — ১০০ গুণ
  বিন্দু, দ্বিগুণ কাজ। কিন্তু ring এর memory আর membership বদলের সময় ring বানানোর কাজ সরাসরি বাড়ে।
- **Replica বাছাই এ virtual node একটা ফাঁদ বানায়।** পরের ৩টা বিন্দু প্রায়ই একই node এর দুটো virtual node
  — ৪৫% key এর "৩টা copy" আসলে ২টা machine এ।
- **Consistent hashing consistency দেয় না।** একটা node কিছুক্ষণ নাগালের বাইরে থেকে পুরনো data নিয়ে ফিরলে,
  ring তার key গুলো তার কাছেই ফেরত পাঠায় — আর বাইরে থাকার সময়ের invalidation গুলো সে কখনো পায়নি।
- **Hot key কোনো hash সারাতে পারে না।** Hash key সমান ভাগ করে, request না। একটা key একাই ১৩% traffic হলে
  যে node এ সে পড়ে, সে ২ গুণ চাপ খায় — ring, rendezvous, jump, সবাই।

## নিজে ভেঙে দেখো (Experiments)

1. **Virtual node এর মাপ:** `VNODES=10 npm run rebalance`, তারপর `VNODES=1000`. "সরল" কলাম আদর্শ ২০% এর
   কত কাছে যায়? আর অংশ খ এ মরা node এর key কতজনের মধ্যে ভাগ হয়? তোমার ১০টা node এর cluster এ তুমি কত
   virtual node বাছবে, আর কেন?
2. **Traffic এর আকার:** `ZIPF=0.5 npm run cache`, তারপর `ZIPF=1.2`. প্রথম সেকেন্ডের hit rate কীভাবে বদলায়?
   কেন traffic যত বেশি skewed, `hash % N` এর ক্ষতি তত কম দেখায় — আর এটা কেন একটা বিপজ্জনক সান্ত্বনা?
3. **বেশি node:** `NODES=50 npm run compare`. Rendezvous এর "lookup এর কাজ" কী হলো? কত node এর উপরে তুমি
   rendezvous এর বদলে ring নেবে?
4. **Bounded load এর factor:** `FACTOR=1.1 npm run compare`, তারপর `FACTOR=2`. "নিজের node এর বাইরে" কলাম
   কীভাবে বদলায়? Cache এর জন্য ওই কলামের মানে কী (নিজের node এর বাইরে মানে ওই node এ data নেই)?
5. **Jump hash এর শর্ত (code বদলাতে হবে):** `compare.ts` এ `middle` এর বদলে **শেষ** node বাদ দাও। কত %
   নড়ল? (উত্তর ~৯.৯% হওয়ার কথা।) এবার বলো: jump hash কোন ধরনের system এ মানায়, আর কোথায় একেবারেই না?

## Project Structure

```
src/
  hash.ts        hash32 (FNV-1a + fmix32), hash64 (jump hash এর জন্য)
  ring.ts        HashRing (virtual node, weight, replica বাছাই), ModuloRouter, RendezvousRouter,
                 JumpRouter — সবাই Router interface এ; আর load/spread/movedKeys হিসাব
  random.ts      seed দেওয়া PRNG, Zipf sampler, grapheme-সচেতন টেবিল
  rebalance.ts   script ক — node যোগ আর বাদ: কত নড়ে, কোথায় যায়, কে ভার নেয়
  vnodes.ts      script খ — virtual node বনাম ভাগ, weight, replica এর তিন নিয়ম
  cache.ts       script গ — TaskFlow cache: node যোগে DB এর চাপ, node ফিরলে stale read
  compare.ts     script ঘ — ring, rendezvous, jump; hot key আর bounded load
```

Environment variable: `KEYS`, `NODES`, `VNODES`, `REQUESTS`, `RPS`, `ZIPF`, `BATCH`, `BATCHES`, `FACTOR`।

## Teardown

আলাদা কিছু লাগে না — কোনো server বা container চালানো হয় না।
