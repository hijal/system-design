# TaskFlow Consistency Checker — একটা ছোট Jepsen

> Lesson 6.5 — Consistency Models: Strong → Eventual · **Tier 1 — Runnable Code** (deterministic)

## কী বানাচ্ছি

একটা ছোট **consistency checker** — Jepsen এর Knossos এর ধারণায়, অনেক সরল করে। একটা **history** দাও
(কোন client কখন কী লিখল/পড়ল, শুরু আর শেষের সময় সহ), checker বলে দেবে সেটা কোন consistency model
মানে আর কোনটা ভাঙে:

| Model                | কীভাবে যাচাই                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| linearizable         | এমন একটা সারি আছে কিনা যেটা **আসল সময়** মানে (একটা শেষ হওয়ার পরে আরেকটা শুরু হলে, সারিতেও পরে) |
| sequential           | এমন একটা সারি আছে কিনা যেটা শুধু **প্রতিটা client এর নিজের ক্রম** মানে                           |
| causal               | প্রতিটা client এর জন্য: সব write + তার read গুলো **happens-before** মেনে সাজানো যায় কিনা (6.4)  |
| read-your-writes     | নিজের write এর পরে নিজের read কখনো তার আগের মান পায় না (6.3)                                    |
| monotonic reads      | নিজের পরপর দুটো read এ দ্বিতীয়টা প্রথমটার চেয়ে পুরনো না (6.3)                                  |
| eventual (সীমিত রূপ) | সব write থামার পরে (২০০ ms পরে) শুরু হওয়া read গুলো সব একই মান পায় কিনা                        |

"সারি আছে কিনা" এর উত্তর backtracking search দিয়ে (সব সম্ভাব্য ক্রম, মুখস্থ রাখা অবস্থা সহ) — ছোট
history এর জন্য (৩০টা operation পর্যন্ত) যথেষ্ট দ্রুত।

| Script           | কী দেখায়                                                                                                                                  | Lesson §  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run models` | Module 5–6 এর সাতটা ঘটনা (পুরনো leader, replica lag, refresh এ উধাও, উত্তর-আগে-প্রশ্ন, ঘড়ির LWW…) — প্রতিটা কোন model মানে                | ১.২ – ১.৬ |
| `npm run jepsen` | চারটা simulated system (এক primary, যেকোনো replica, sticky replica, version token) থেকে ৩০০টা করে random history — কত শতাংশ কোন model মানে | ১.৭       |

## Prerequisite

শুধু Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run models
npm run jepsen
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

দুটোই deterministic — তোমার মেশিনেও **হুবহু** এই output আসবে।

**১. `npm run models`**

```
   ঘটনা                                   lesson   linear.  sequential  causal  RYW  mono.read  eventual
   এক primary, সব স্বাভাবিক               5.x      ✓        ✓           ✓       ✓    ✓          ✓
   লেখা চলার মাঝে পড়া নতুন মান পেল       6.2      ✓        ✓           ✓       ✓    ✓          ✓
   পুরনো leader থেকে পড়া                 6.2      ✗        ✓           ✓       ✓    ✓          ✓
   Replica lag: নিজের লেখা নেই            5.7      ✗        ✗           ✗       ✗    ✓          ✓
   Refresh এ task উধাও                    6.3      ✗        ✗           ✗       ✓    ✗          ✓
   উত্তর আছে, প্রশ্ন নেই                  6.3      ✗        ✗           ✗       ✓    ✓          ✓
   LWW: ঘড়ির ভুলে bot এর edit হারাল      6.4      ✗        ✗           ✗       ✗    ✓          ✓
```

**২. `npm run jepsen`**

```
   system                        linear.  sequential  causal    RYW   mono.read  eventual
   এক primary                    100%     100%      100%    100%     100%      100%
   যেকোনো replica                 32%      58%       61%     70%      85%      100%
   client প্রতি একটা replica      29%      57%       63%     67%     100%      100%
   version token                  48%     100%      100%    100%     100%      100%
```

## কী দেখার জন্য এটা বানানো

- **`models`, "পুরনো leader থেকে পড়া":** শুধু linearizable ভাঙে। P2 এর পুরনো পড়া সারিতে P1 এর লেখার
  **আগে** বসানো যায় — P2 এর নিজের ক্রম তাতে ভাঙে না — কিন্তু আসল সময়ে P2 পড়েছে লেখা শেষ হওয়ার ৯০ ms পরে।
  Linearizable আর sequential এর পুরো পার্থক্য এই এক সারিতে।
- **"উত্তর আছে, প্রশ্ন নেই":** দুটো session guarantee ই ✓ — কিন্তু causal ✗। P3 এর নিজের দেখা কোনো নিয়ম
  ভাঙেনি; ভেঙেছে **অন্য দুজনের** মধ্যের কার্যকারণ। Session guarantee সব মিলিয়েও causal এর সমান না।
- **"LWW":** eventual ✓, বাকি প্রায় সব ✗। Eventual একা প্রায় কিছুই প্রতিশ্রুতি দেয় না।
- **`jepsen`, "এক primary" ১০০% সব:** এটা checker এর নিজের একটা পরীক্ষাও — সঠিক system এর কোনো history
  কে সে ভুল করে "ভাঙা" বলেনি।
- **"version token":** ৪৮% linearizable, কিন্তু sequential আর causal ১০০%। Token প্রতিটা client এর দেখা
  একমুখী রাখে; কিন্তু অন্য client এর সদ্য লেখা না দেখা (আসল সময় না মানা) থেকেই যায়। (সাবধান: এখানে একটাই
  key — একাধিক key তে "উত্তর আছে, প্রশ্ন নেই" এর মতো ঘটনা token দিয়ে আটকায় না।)
- **নিচের লাইন:** ১০০% মানে "৩০০টা history তে ভাঙেনি" — প্রমাণ না। কম মানে নিশ্চিতভাবে ভাঙে। Jepsen এর
  কাজও এরকম: bug খোঁজা, সঠিকতা প্রমাণ না।

## নিজে ভেঙে দেখো (Experiments)

1. **নিজের history:** `src/models.ts` এ এটা যোগ করো, আর চালানোর **আগে** প্রতিটা কলাম অনুমান করো:
   `w('P1','x',1,0,100), r('P2','x',1,10,20), r('P3','x',0,30,40)` — লেখা চলার মাঝে P2 নতুন মান দেখল, তারপর
   P3 পুরনো। Linearizable? Sequential?
2. **দুটো key:** `src/jepsen.ts` এ দ্বিতীয় একটা key যোগ করো (কিছু write `y` তে), token টা key-নিরপেক্ষ রেখে।
   Version token এর causal কি এখনো ১০০% থাকে? না থাকলে, কোন ধরনের history তে ভাঙে?
3. **Lag বাড়াও:** replica এর বড় lag এর সম্ভাবনা ৫% থেকে ৩০% করো। কোন সারির কোন কলাম সবচেয়ে বেশি নামে?
   Version token এর কোন কলাম বদলায় না — কেন?
4. **Checker ভাঙো:** `linearizable()` এ `a.end < b.start` কে `a.start < b.start` বানাও (ভুল নিয়ম)। কোন
   history গুলোর উত্তর বদলায়? এই ভুল নিয়মটা আসলে কী মাপছে?

## Project Structure

```
lesson-6.5-consistency-models/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
└── src/
    ├── random.ts          # seed দেওয়া PRNG, latency (Lesson 5.9 থেকে)
    ├── checker.ts         # history, happens-before, আর ছয়টা model এর checker
    ├── models.ts          # Module 5–6 এর সাতটা ঘটনা, মই এ
    └── jepsen.ts          # চারটা simulated system থেকে random history, আর শতাংশ
```

**যাচাই:** এই মেশিনে (Node 26) `tsc --noEmit` clean; দুটো script দুবার করে চালিয়ে হুবহু একই output
(checksum মিলিয়ে)। Experiment গুলো তোমার কাজ — চালিয়ে দেখা হয়নি।
