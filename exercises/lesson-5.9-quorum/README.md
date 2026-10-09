# TaskFlow Quorum Simulator - CAP আর R + W > N চোখে দেখা

> Lesson 5.9 - CAP Theorem, ACID vs BASE, Quorum · **Tier 1 - Runnable Code** (single-process simulation)

## কী বানাচ্ছি

একটা ছোট, deterministic simulation - database বা Docker ছাড়া - যেটা leaderless replication এর
দুটো মূল প্রশ্নের উত্তর মেপে দেখায়:

| Script              | কী দেখায়                                                                                               | Lesson §  |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| `npm run quorum`    | N = ৩ replica, ছয়টা (W, R) জোড়া - stale read কতবার, লেখা আর পড়া কত ধীর, আর কয়টা replica মরলে কী চলে | ১.৫       |
| `npm run partition` | ৫টা node, network ৩ \| ২ ভাগে কাটা - CP (strict quorum) বনাম AP (যেকোনো node লেখে, last-write-wins)     | ১.২ – ১.৩ |

**কেন simulation, আসল database না?** `R + W > N` এর দাবিটা একটা যুক্তির দাবি - কোন replica কখন কী দেখে,
তার সময়ের হিসাব। একটা process এর ভেতরে প্রতিটা network যাত্রার সময় নিজে নিয়ন্ত্রণ করলে সেই হিসাবটা
স্পষ্ট দেখা যায়, আর seed দেওয়া থাকায় প্রতিবার হুবহু একই ফল। আসল leaderless database (Cassandra,
DynamoDB) এই ধারণাই ব্যবহার করে, কিন্তু সাথে আরও অনেক কিছু (hinted handoff, read repair, anti-entropy)

- এখানে সেগুলো নেই।

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

দুটোই deterministic - আপনার মেশিনেও **হুবহু** এই সংখ্যা আসবে।

**১. `npm run quorum`**

```
   N = 3 replicas: A, B in the same data center; C in another data center (slow)
   any replica falls 50 ms behind on 5% of writes (GC pause, disk stall)

1. Read right after the write succeeds (same user, read-your-writes)
   W  R  W+R>N?   stale read              write p50 / p99      read p50 / p99
   1  1  no       10827/100000 (10.83%)     2.3 /   7.0 ms     2.3 /   5.6 ms
   1  2  no         227/100000 ( 0.23%)     2.3 /   7.0 ms     4.1 /  11.1 ms
   2  1  no        3707/100000 ( 3.71%)     4.4 /  53.1 ms     2.3 /   5.6 ms
   2  2  yes          0/100000 ( 0.00%)     4.4 /  53.1 ms     4.1 /  11.1 ms
   3  1  yes          0/100000 ( 0.00%)    39.6 / 103.1 ms     2.3 /   5.6 ms
   1  3  yes          0/100000 ( 0.00%)     2.3 /   7.0 ms    36.8 /  86.4 ms

2. Read 5 ms after the write succeeds (another user)
   1  1  no       5149/100000 ( 5.15%)   …
   1  2  no        199/100000 ( 0.20%)   …
   2  1  no       3303/100000 ( 3.30%)   …
   (the other three are yes - 0)

3. How many replicas can die and what still works? (N = 3)
   W  R   │ 0 dead         │ 1 dead         │ 2 dead
   1  1   │ write ✓ read ✓ │ write ✓ read ✓ │ write ✓ read ✓
   2  2   │ write ✓ read ✓ │ write ✓ read ✓ │ write ✗ read ✗
   3  1   │ write ✓ read ✓ │ write ✗ read ✓ │ write ✗ read ✓
   1  3   │ write ✓ read ✓ │ write ✓ read ✗ │ write ✓ read ✗
```

**২. `npm run partition`**

```
A. CP - strict quorum (N=5, W=3, R=3)
   Rahim (Dhaka, 3 nodes)         wrote "Fix login"   → success ✓
   Karim (Singapore, 2 nodes)     wrote "Fix signup"  → failed ✗ - saw an error, has to try again
   reads during the partition: Dhaka → "Fix login",  Singapore → ✗ no answer (no quorum)
   after the network heals, everyone reads: "Fix login"

B. AP - any node takes writes (W=1, R=1), last-write-wins afterwards; n4's clock is 300 ms behind
   reads during the partition: Dhaka → "Fix login",  Singapore → "Fix signup"  ← two truths on two sides
   the network healed - two versions found:
     "Fix login" (Rahim), timestamp 100 ms
     "Fix signup" (Karim), timestamp -100 ms
   LWW winner: "Fix login" (Rahim)
```

## কী দেখার জন্য এটা বানানো

1. **`R + W > N` একটা নিশ্চয়তা, `R + W ≤ N` একটা জুয়া।** ছয় লাখ চেষ্টায় (দুটো টেবিল মিলিয়ে) `R + W > N` এ একটাও
   stale read নেই। `≤ N` এ কখনো ০.২%, কখনো ১০% - "প্রায়ই ঠিক" মানে production এ প্রতিদিন হাজার বার ভুল।
2. **Consistency এর দাম latency তে।** `W = 3` মানে প্রতিটা লেখা সবচেয়ে ধীর replica (অন্য data center) এর
   অপেক্ষায় - p50 ~৪০ ms, `W = 2` এর ১০ গুণ। Quorum জিতে সেই replica টাকে এড়িয়ে যাওয়া যায়।
3. **Consistency এর দাম availability তেও।** `W = 3` এ একটা replica মরলেই লেখা বন্ধ। `W = R = 2` - দুটোর
   মাঝামাঝি, আর সবচেয়ে প্রচলিত বাছাই।
4. **Partition এ বাছাই অনিবার্য।** CP তে সিঙ্গাপুরের user কাজ করতে পারেনি; AP তে পেরেছে - কিন্তু করিমের লেখা
   নীরবে হারাল, কারণ LWW এর "পরে" ঠিক হয়েছে একটা ভুল ঘড়ি দিয়ে (Lesson 6.4 এর preview)।

## নিজে ভেঙে দেখুন (Experiments)

1. **Stall বন্ধ করুন।** `src/quorum.ts` এ `STALL_PROBABILITY` কে `0` করুন। `(1, 2)` আর `(2, 1)` এর stale read
   কী হয়? এটা কি প্রমাণ করে যে `R + W ≤ N` ও নিরাপদ? (ইঙ্গিত: এই exercise বানানোর সময় প্রথমে stall ছাড়াই
   চালিয়েছিলাম - ঠিক এই ফাঁদে পড়তে যাচ্ছিলাম।)

2. **N বাড়ান।** `LINKS` এ আরও দুটো replica যোগ করে N = ৫ করুন (`N` constant ও বদলান), আর combo এ `(3, 3)`,
   `(2, 3)`, `(3, 2)` যোগ করুন। `R + W > N` নিয়মটা এখনো খাটে? কোনটা সবচেয়ে কম latency তে নিরাপদ?

3. **ঘড়ি ঠিক করুন।** `src/partition.ts` এ `CLOCK_SKEW_MS.n4` কে `0` করুন। এখন LWW কাকে জেতায়? তাহলে কি LWW
   নিরাপদ? (দুজন যদি ঠিক একই millisecond এ লেখে? আর রহিমের লেখা যদি করিমের লেখার **উপর ভিত্তি করে** না হয়,
   দুটো স্বাধীন বদল হয় - তাহলে "পরেরটা জিতুক" কি আদৌ সঠিক নিয়ম?)

## Teardown

কিছু চালু থাকে না - কিছু বন্ধ করার দরকার নেই।

## Project Structure

```text
lesson-5.9-quorum/
├── package.json
├── tsconfig.json
└── src/
    ├── random.ts      # seeded PRNG, network latency এর মডেল, percentile
    ├── quorum.ts      # N=3, ছয়টা (W, R) জোড়া - stale read, latency, availability
    └── partition.ts   # ৫টা node, ৩|২ partition - CP বনাম AP + LWW
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, TypeScript 6):

- `tsc --noEmit` - clean pass, কোনো type error নেই, কোথাও `any` নেই
- দুটো script কয়েকবার চালানো - প্রতিবার হুবহু একই output (seed দেওয়া)
- এটা একটা **simulation** - আসল database এর সব আচরণ এতে নেই (উপরে "কেন simulation" দেখুন)
- Experiment ১–৩ চালিয়ে দেখা **হয়নি** (১ নম্বরের stall ছাড়া আচরণ বানানোর সময় দেখা গিয়েছিল: `(1,2)` আর `(2,1)` এ ০টা stale)
