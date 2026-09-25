# TaskFlow Clocks Lab — Last-Write-Wins, Lamport Clock আর Vector Clock

> Lesson 6.4 — Distributed Lock, Logical Clock · **Tier 1 — Runnable Code** (deterministic simulation)

## কী বানাচ্ছি

দুটো ছোট program, database বা Docker ছাড়া:

| Script           | কী দেখায়                                                                                                                                                               | Lesson §     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `npm run clocks` | তিনটা process এর ১০টা ঘটনা — প্রতিটার Lamport আর vector timestamp, নিয়ম মেনে হিসাব করা; তারপর পাঁচটা জোড়া: Lamport কী বলে, vector clock কী বলে                        | ১.৪ – ১.৬    |
| `npm run lww`    | তিনটা replica (একটার ঘড়ি ৪০০ ms পিছিয়ে), ৬ জন মানুষ আর ২টা bot একই task এর title edit করে — তিন রকম নিয়মে (ঘড়ির LWW, Lamport LWW, vector clock + sibling) কী হারায় | ১.৩, ১.৫–১.৬ |

`lww` এ প্রতিটা লেখা জানে সে কোন version গুলো দেখে লেখা হয়েছে — সত্যিকারের কার্যকারণ। কোনো নিয়ম সেটা
দেখে না; শুধু মাপার জন্য আমরা দেখি, আর প্রতিটা বাদ পড়া লেখাকে শ্রেণিভাগ করি:

- **পরে-করা edit আগেরটার কাছে হারল** — লেখাটা অন্যটা **দেখে** তারপর লেখা হয়েছিল, তবু অন্যটা জিতল
  (user এর চোখে: "save করলাম, পুরনোটা ফিরে এলো")
- **একসাথে-করা edit নীরবে বাদ** — কেউ কারোটা দেখেনি (concurrent), একটা কোনো সংকেত ছাড়াই হারাল

Vector clock এর version টা **dotted version vector** — প্রতিটা লেখার নিজের একটা "dot" (কোন replica র কত
নম্বর লেখা) আর আলাদা context। সাধারণ vector clock এ একই replica তে সদ্য আসা লেখাকে ভুল করে "পুরনো" ধরে
ফেলার একটা সূক্ষ্ম bug আছে; Riak এটা ঠিক করতে dotted version vector এ গিয়েছিল।

## Prerequisite

শুধু Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run clocks
npm run lww
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

দুটোই deterministic — তোমার মেশিনেও **হুবহু** এই output আসবে।

**১. `npm run clocks`** (আগে নিজে কাগজে হিসাব করো, তারপর মেলাও)

```
   ঘটনা  process  ধরন       Lamport   vector [A,B,C]   কী হলো
   a1    A        local        1      [1,0,0]          রহিম title লিখল
   c1    C        local        1      [0,0,1]          করিম offline এ একটা comment লিখল
   a2    A        send m1      2      [2,0,0]          title server এ পাঠাল
   b1    B        recv m1      3      [2,1,0]          server title পেল
   a3    A        local        3      [3,0,0]          রহিম description বদলাল
   b2    B        send m2      4      [2,2,0]          server করিমকে notify করল
   b3    B        local        5      [2,3,0]          server audit log লিখল
   c2    C        recv m2      5      [2,2,2]          করিম notification পেল
   c3    C        send m3      6      [2,2,3]          করিম উত্তর দিল রহিমকে
   a4    A        recv m3      7      [4,2,3]          রহিম উত্তর পেল

   জোড়া       Lamport বলে       Vector clock বলে
   a1, a4      a1 < a4           a1 → a4 (আগে ঘটেছে)
   a2, c2      a2 < c2           a2 → c2 (আগে ঘটেছে)
   c1, a2      c1 < a2           concurrent — কেউ কারো কথা জানত না
   a3, b3      a3 < b3           concurrent — কেউ কারো কথা জানত না
   a3, c3      a3 < c3           concurrent — কেউ কারো কথা জানত না
```

**২. `npm run lww`**

```
   নিয়ম                 মোট edit   পরে-করা edit আগেরটার    একসাথে-করা edit    app কে মেলাতে    শেষ title এর    replica
                                     কাছে হারল            নীরবে বাদ          বলা হলো         ইতিহাসে নেই       এক?
   LWW — ঘড়ির সময়          164               10                   43               0               100       হ্যাঁ
   LWW — Lamport clock       164                0                   45               0               101       হ্যাঁ
   Vector clock (sibling)    164                0                    0              48                 0       হ্যাঁ
```

## কী দেখার জন্য এটা বানানো

- **`clocks`:** শেষ তিনটা জোড়ায় Lamport একটা ক্রম দেয় (`c1 < a2`, `a3 < b3`) — কিন্তু সেগুলো আসলে
  concurrent। Lamport এর নিশ্চয়তা একমুখী: "আগে ঘটেছে" হলে সংখ্যা ছোট — কিন্তু সংখ্যা ছোট হলে আগে ঘটেছে,
  এমন না।
- **`lww`, প্রথম সারি:** ১০টা edit **পরে** আর আগেরটা **দেখে** লেখা, তবু হেরেছে। (মেপে দেখা হয়েছে: ১০টাই bot
  এর, আর ১০টাই n3 তে লেখা — bot একটা edit দেখে ২০০ ms এর মধ্যে নিজেরটা লেখে, আর n3 এর ঘড়ি ৪০০ ms
  পিছিয়ে, তাই তার timestamp আগের edit এর চেয়েও পুরনো।) সব replica একমত
  ("এক? হ্যাঁ") — ভুল উত্তরে, সুন্দরভাবে একমত।
- **দ্বিতীয় সারি:** Lamport এ প্রথম ধরনের ক্ষতি শূন্য — কার্যকারণ রক্ষা হয়। কিন্তু concurrent edit এখনো
  নীরবে হারায়; Lamport জানে না দুটো concurrent।
- **তৃতীয় সারি:** কিছুই হারায় না — কিন্তু ৪৮ বার app কে দুটো (বা বেশি) মান দিয়ে বলা হয়েছে "তুমি মেলাও"।
  দাম সরল জায়গায় সরে গেছে: database থেকে application এ।
- **শেষ কলাম:** LWW এ ১৬৪টা edit এর ১০০টা শেষ title এর ইতিহাসে নেই — একটা শাখা হারলে তার পেছনের পুরো
  শাখাই যায়।

## নিজে ভেঙে দেখো (Experiments)

1. **ঘড়ি ঠিক করো:** `src/lww.ts` এ `SKEW_MS` সব ০ করো। প্রথম সারির "পরে-করা edit হারল" কত হয়? বাকি
   কলাম? (এটা চালিয়ে দেখা হয়েছে: ১০ → ০, আর একসাথে-করা edit এর ক্ষতি প্রায় একই থাকে — ৪৩ → ৪৫। অর্থাৎ
   ঘড়ি ঠিক করলে একটা ক্ষতি যায়, অন্যটা যায় না।)
2. **ঘড়ি এগিয়ে:** n3 এর skew `+400` করো। এবার কার edit হারায়? (Bot এর? নাকি bot এর পরে n3 তে যে
   লেখে তাকে ছাড়া বাকি সবার?) কেন "এগিয়ে থাকা" ঘড়ি ভিন্ন ধরনের ক্ষতি করে?
3. **আরও bot:** `BOTS` ৬ করো। কোন কলাম সবচেয়ে বেশি বাড়ে, আর কেন?
4. **Merge লেখো:** `vector` নিয়মে client একাধিক sibling দেখলে এখন শুধু সবগুলোকে "দেখেছি" ধরে একটা নতুন
   মান লেখে। Title এর জন্য একটা সত্যিকারের merge কী হবে? আর title এর বদলে যদি task এর **label এর set**
   হতো?

## Project Structure

```
lesson-6.4-logical-clocks/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
└── src/
    ├── random.ts          # seed দেওয়া PRNG (Lesson 5.9 থেকে)
    ├── clocks.ts          # ১০টা ঘটনার Lamport আর vector timestamp, আর জোড়া তুলনা
    └── lww.ts             # তিনটা replica, তিন রকম conflict নিয়ম, সত্যিকারের কার্যকারণ দিয়ে মাপা
```

**যাচাই:** এই মেশিনে (Node 26) `tsc --noEmit` clean; দুটো script দুবার করে চালিয়ে হুবহু একই output
(checksum মিলিয়ে); experiment ১ চালিয়ে দেখা হয়েছে (উপরে ফল)। Experiment ২–৪ তোমার কাজ।
