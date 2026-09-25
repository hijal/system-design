# TaskFlow Quorum Simulator — CAP আর R + W > N চোখে দেখা

> Lesson 5.9 — CAP Theorem, ACID vs BASE, Quorum · **Tier 1 — Runnable Code** (single-process simulation)

## কী বানাচ্ছি

একটা ছোট, deterministic simulation — database বা Docker ছাড়া — যেটা leaderless replication এর
দুটো মূল প্রশ্নের উত্তর মেপে দেখায়:

| Script              | কী দেখায়                                                                                               | Lesson §  |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| `npm run quorum`    | N = ৩ replica, ছয়টা (W, R) জোড়া — stale read কতবার, লেখা আর পড়া কত ধীর, আর কয়টা replica মরলে কী চলে | ১.৫       |
| `npm run partition` | ৫টা node, network ৩ \| ২ ভাগে কাটা — CP (strict quorum) বনাম AP (যেকোনো node লেখে, last-write-wins)     | ১.২ – ১.৩ |

**কেন simulation, আসল database না?** `R + W > N` এর দাবিটা একটা যুক্তির দাবি — কোন replica কখন কী দেখে,
তার সময়ের হিসাব। একটা process এর ভেতরে প্রতিটা network যাত্রার সময় নিজে নিয়ন্ত্রণ করলে সেই হিসাবটা
স্পষ্ট দেখা যায়, আর seed দেওয়া থাকায় প্রতিবার হুবহু একই ফল। আসল leaderless database (Cassandra,
DynamoDB) এই ধারণাই ব্যবহার করে, কিন্তু সাথে আরও অনেক কিছু (hinted handoff, read repair, anti-entropy)
— এখানে সেগুলো নেই।

## Prerequisite

শুধু Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run quorum
npm run partition
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

দুটোই deterministic — তোমার মেশিনেও **হুবহু** এই সংখ্যা আসবে।

**১. `npm run quorum`**

```
   N = 3 replica: A, B একই data center এ; C অন্য data center এ (ধীর)
   যেকোনো replica প্রতিটা লেখায় 5% সম্ভাবনায় 50 ms পিছিয়ে পড়ে (GC pause, disk stall)

১. লেখা সফল হওয়ার ঠিক পরেই পড়া (একই user, read-your-writes)
   W  R  W+R>N?   stale read              লেখা p50 / p99       পড়া p50 / p99
   1  1  না       10827/100000 (10.83%)     2.3 /   7.0 ms     2.3 /   5.6 ms
   1  2  না         227/100000 ( 0.23%)     2.3 /   7.0 ms     4.1 /  11.1 ms
   2  1  না        3707/100000 ( 3.71%)     4.4 /  53.1 ms     2.3 /   5.6 ms
   2  2  হ্যাঁ         0/100000 ( 0.00%)     4.4 /  53.1 ms     4.1 /  11.1 ms
   3  1  হ্যাঁ         0/100000 ( 0.00%)    39.6 / 103.1 ms     2.3 /   5.6 ms
   1  3  হ্যাঁ         0/100000 ( 0.00%)     2.3 /   7.0 ms    36.8 /  86.4 ms

২. লেখা সফল হওয়ার ৫ ms পরে পড়া (অন্য একজন user)
   1  1  না        5149/100000 ( 5.15%)   …
   1  2  না         199/100000 ( 0.20%)   …
   2  1  না        3303/100000 ( 3.30%)   …
   (বাকি তিনটা হ্যাঁ — 0)

৩. কয়টা replica মরলে কী চলে? (N = 3)
   W  R   │ ০টা মৃত      │ ১টা মৃত      │ ২টা মৃত
   1  1   │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✓
   2  2   │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✓ │ লেখা ✗ পড়া ✗
   3  1   │ লেখা ✓ পড়া ✓ │ লেখা ✗ পড়া ✓ │ লেখা ✗ পড়া ✓
   1  3   │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✗ │ লেখা ✓ পড়া ✗
```

**২. `npm run partition`**

```
ক. CP — strict quorum (N=5, W=3, R=3)
   রহিম (ঢাকা, ৩টা node)       লিখল "Fix login"   → সফল ✓
   করিম (সিঙ্গাপুর, ২টা node)  লিখল "Fix signup"  → ব্যর্থ ✗ — error দেখল, আবার চেষ্টা করতে হবে
   partition চলাকালীন পড়া: ঢাকা → "Fix login",  সিঙ্গাপুর → ✗ উত্তর নেই (quorum নেই)
   network জোড়া লাগার পর সবাই পড়ে: "Fix login"

খ. AP — যেকোনো node লেখা নেয় (W=1, R=1), পরে last-write-wins; n4 এর ঘড়ি ৩০০ ms পিছিয়ে
   partition চলাকালীন পড়া: ঢাকা → "Fix login",  সিঙ্গাপুর → "Fix signup"  ← দুই দিকে দুই সত্য
   network জোড়া লাগল — দুটো version পাওয়া গেল:
     "Fix login" (রহিম), timestamp 100 ms
     "Fix signup" (করিম), timestamp -100 ms
   LWW বিজয়ী: "Fix login" (রহিম)
```

## কী দেখার জন্য এটা বানানো

1. **`R + W > N` একটা নিশ্চয়তা, `R + W ≤ N` একটা জুয়া।** ছয় লাখ চেষ্টায় (দুটো টেবিল মিলিয়ে) `R + W > N` এ একটাও
   stale read নেই। `≤ N` এ কখনো ০.২%, কখনো ১০% — "প্রায়ই ঠিক" মানে production এ প্রতিদিন হাজার বার ভুল।
2. **Consistency এর দাম latency তে।** `W = 3` মানে প্রতিটা লেখা সবচেয়ে ধীর replica (অন্য data center) এর
   অপেক্ষায় — p50 ~৪০ ms, `W = 2` এর ১০ গুণ। Quorum জিতে সেই replica টাকে এড়িয়ে যাওয়া যায়।
3. **Consistency এর দাম availability তেও।** `W = 3` এ একটা replica মরলেই লেখা বন্ধ। `W = R = 2` — দুটোর
   মাঝামাঝি, আর সবচেয়ে প্রচলিত বাছাই।
4. **Partition এ বাছাই অনিবার্য।** CP তে সিঙ্গাপুরের user কাজ করতে পারেনি; AP তে পেরেছে — কিন্তু করিমের লেখা
   নীরবে হারাল, কারণ LWW এর "পরে" ঠিক হয়েছে একটা ভুল ঘড়ি দিয়ে (Lesson 6.4 এর preview)।

## নিজে ভেঙে দেখো (Experiments)

1. **Stall বন্ধ করো।** `src/quorum.ts` এ `STALL_PROBABILITY` কে `0` করো। `(1, 2)` আর `(2, 1)` এর stale read
   কী হয়? এটা কি প্রমাণ করে যে `R + W ≤ N` ও নিরাপদ? (ইঙ্গিত: এই exercise বানানোর সময় প্রথমে stall ছাড়াই
   চালিয়েছিলাম — ঠিক এই ফাঁদে পড়তে যাচ্ছিলাম।)

2. **N বাড়াও।** `LINKS` এ আরও দুটো replica যোগ করে N = ৫ করো (`N` constant ও বদলাও), আর combo এ `(3, 3)`,
   `(2, 3)`, `(3, 2)` যোগ করো। `R + W > N` নিয়মটা এখনো খাটে? কোনটা সবচেয়ে কম latency তে নিরাপদ?

3. **ঘড়ি ঠিক করো।** `src/partition.ts` এ `CLOCK_SKEW_MS.n4` কে `0` করো। এখন LWW কাকে জেতায়? তাহলে কি LWW
   নিরাপদ? (দুজন যদি ঠিক একই millisecond এ লেখে? আর রহিমের লেখা যদি করিমের লেখার **উপর ভিত্তি করে** না হয়,
   দুটো স্বাধীন বদল হয় — তাহলে "পরেরটা জিতুক" কি আদৌ সঠিক নিয়ম?)

## Teardown

কিছু চালু থাকে না — কিছু বন্ধ করার দরকার নেই।

## Project Structure

```text
lesson-5.9-quorum/
├── package.json
├── tsconfig.json
└── src/
    ├── random.ts      # seeded PRNG, network latency এর মডেল, percentile
    ├── quorum.ts      # N=3, ছয়টা (W, R) জোড়া — stale read, latency, availability
    └── partition.ts   # ৫টা node, ৩|২ partition — CP বনাম AP + LWW
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, TypeScript 6):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- দুটো script কয়েকবার চালানো — প্রতিবার হুবহু একই output (seed দেওয়া)
- এটা একটা **simulation** — আসল database এর সব আচরণ এতে নেই (উপরে "কেন simulation" দেখো)
- Experiment ১–৩ চালিয়ে দেখা **হয়নি** (১ নম্বরের stall ছাড়া আচরণ বানানোর সময় দেখা গিয়েছিল: `(1,2)` আর `(2,1)` এ ০টা stale)
