# TaskFlow Session Guarantees Lab — Replica Routing, Consistent Prefix আর Read Repair

> Lesson 6.3 — Quorum in Practice · **Tier 1 — Runnable Code** (deterministic simulation)

## কী বানাচ্ছি

তিনটা ছোট, seed দেওয়া simulation — database বা Docker ছাড়া — যেগুলো replica থেকে পড়ার তিনটা বাস্তব
সমস্যা মেপে দেখায়:

| Script            | কী দেখায়                                                                                                                                                    | Lesson §  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run session` | Primary + ৩টা async replica, পাঁচ রকম read routing — কতবার user নিজের লেখা দেখেনি (একই device / অন্য device), কতবার সময় পেছনে গেছে, কত read primary তে গেছে | ১.৩ – ১.৪ |
| `npm run prefix`  | Comment দুটো partition এ — shard key `commentId` বনাম `taskId`: কতবার উত্তর দেখা গেছে কিন্তু প্রশ্ন না                                                       | ১.৫       |
| `npm run quorum`  | N = 3, W = 2, R = 2 তে একটা "ব্যর্থ" লেখা — read repair ছাড়া আর সহ, কতজন user মান ওঠানামা করতে দেখে                                                         | ১.৬       |

**কেন simulation?** প্রশ্নগুলো সময়ের হিসাব — কোন replica কোন মুহূর্তে কোন LSN পর্যন্ত পৌঁছেছে। Replica
এর lag নিজে নিয়ন্ত্রণ করলে (মাঝে মাঝে কয়েক সেকেন্ড আটকে যাওয়া সহ) হাজার হাজার পড়া এক পলকে মাপা যায়,
আর প্রতিবার হুবহু একই ফল। Lesson 5.7 এর exercise এ আসল Postgres replica দিয়ে এর একটা অংশ
(read-your-writes) দেখেছ; এখানে পুরো পরিবার।

**সৎ নোট:** replica এর lag এর সংখ্যা (গড় কয়েক ms, মাঝে মাঝে ১.৫–৩ s আটকে যাওয়া) একটা ধরে নেওয়া মডেল,
কোনো নির্দিষ্ট system থেকে মাপা না। শতাংশগুলো না — **কোন কৌশল কোন সমস্যা ঠিক করে আর কোনটা করে না**,
সেটাই আসল।

## Prerequisite

শুধু Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run session
npm run prefix
npm run quorum
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

তিনটাই deterministic — তোমার মেশিনেও **হুবহু** এই সংখ্যা আসবে।

**১. `npm run session`**

```
                                              নিজের লেখা দেখেনি              সময় পেছনে    read primary তে
   কৌশল                                       একই device    অন্য device      গেছে
   ক. যেকোনো replica (random)                 29.1%         0.9%         4.0%         0.0%
   খ. device প্রতি একটা নির্দিষ্ট replica     29.6%         1.0%         0.6%         0.0%
   গ. cookie: ৫ s এর মধ্যে লিখলে primary       0.0%         0.9%         0.3%        73.4%
   ঘ. version token — device এ (cookie)        0.0%         0.8%         0.4%         3.4%
   ঙ. version token — user এর (server এ)       0.0%         0.0%         0.0%         3.4%
```

**২. `npm run prefix`**

```
   shard key       উত্তর দেখা গেছে     উত্তর আছে কিন্তু প্রশ্ন নেই
   commentId            65426             250
   taskId               66059               0
```

**৩. `npm run quorum`**

```
   read repair    "ব্যর্থ" v1 দেখেছে      v1 দেখার পরে আবার v0     মান ওঠানামা করেছে এমন user    শেষ অবস্থা
   বন্ধ             325/500                 84                      58                A=v1 B=v0 C=v0
   চালু             500/500                  0                       0                A=v1 B=v1 C=v1
```

## কী দেখার জন্য এটা বানানো

- **`session`, প্রতিটা কলাম একটা আলাদা নিশ্চয়তা।** (খ) sticky replica "সময় পেছনে" অনেক কমায় কিন্তু
  নিজের লেখা দেখায় না। (গ) cookie নিজের device এ নিজের লেখা দেখায় — কিন্তু ৭৩% read primary তে ঠেলে দেয়,
  আর অন্য device এ কিছুই করে না। (ঘ) আর (ঙ) এর একমাত্র পার্থক্য token **কোথায় রাখা** — আর সেটাই অন্য
  device এর কলাম শূন্য করে। মাত্র ৩.৪% read primary তে: token বলে দেয় **ঠিক কখন** replica যথেষ্ট না।
- **`prefix`:** ২৫০টা পড়ায় thread এ "আজ রাত ৯টায়" আছে কিন্তু "deploy কখন?" নেই। `taskId` এ শূন্য — এটা
  ভাগ্য না, গ্যারান্টি: একই partition এর replica লেখা ক্রমানুসারে প্রয়োগ করে।
- **`quorum`:** R + W > N থাকা সত্ত্বেও ৮৪ বার একজন user নতুন মান দেখে তারপর পুরনো দেখেছে। আর দুটো সারি
  মিলিয়ে দেখো: client কে যে লেখাকে "ব্যর্থ" বলা হয়েছিল, read repair সেটাকেই **সব replica তে** ছড়িয়ে
  দিয়েছে। "ব্যর্থ" মানে "হয়নি" না।

## নিজে ভেঙে দেখো (Experiments)

1. **Stall বন্ধ করো:** `src/session.ts` এর `REPLICAS` এ `stallPerWrite` সব ০ করো। কোন কলামগুলো প্রায়
   শূন্যে নামে, আর কোনটা নামে না? এ থেকে কী বোঝা যায় — বাস্তবে সমস্যাগুলো "গড় lag" থেকে আসে, নাকি লেজ থেকে?
2. **Token + অপেক্ষা:** (ঙ) তে কোনো replica এগিয়ে না থাকলে সোজা primary তে যায়। বদলে একটা replica তে
   ৫০ ms পর্যন্ত অপেক্ষা করো (তারপর primary)। Primary এর শতাংশ কত কমে? কোন ধরনের read এর জন্য এই
   অপেক্ষা গ্রহণযোগ্য না?
3. **Sticky + failover:** (খ) তে r3 কে ৬০ সেকেন্ডের পর "মৃত" ধরো — তার device গুলো অন্য replica তে যায়।
   "সময় পেছনে" কলামের কী হয়? কেন?
4. **Quorum এ W = 3:** `src/quorum.ts` এ ভাবো — W = 3, R = 1 হলে এই "ব্যর্থ লেখা" এর গল্প কি বদলায়?
   লেখা A তে পৌঁছে বাকিদের timeout হলে কী হয়? (উত্তর code না চালিয়েও বের করা যায় — তারপর চালিয়ে মেলাও।)

## Project Structure

```
lesson-6.3-session-guarantees/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
└── src/
    ├── random.ts          # seed দেওয়া PRNG, latency (Lesson 5.9 থেকে)
    ├── replica.ts         # async replica এর মডেল: lag, আটকে যাওয়া, ক্রমানুসারে প্রয়োগ, replayedAt()
    ├── session.ts         # পাঁচ রকম read routing — read-your-writes, monotonic read, primary এর চাপ
    ├── prefix.ts          # দুটো partition এ প্রশ্ন-উত্তর — consistent prefix
    └── quorum.ts          # "ব্যর্থ" quorum লেখা, read repair সহ আর ছাড়া
```

**যাচাই:** এই মেশিনে (Node 26) `tsc --noEmit` clean; তিনটা script দুবার করে চালিয়ে হুবহু একই output
(checksum মিলিয়ে)। Experiment গুলো তোমার code বদলানোর কাজ — সেগুলোর ফল চালিয়ে দেখা হয়নি।
