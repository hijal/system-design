# Estimation Drill — দশটা Timed প্রশ্ন, আর গোল করা বনাম ভুল ধাপের দাম

> Lesson 12.2 — Estimation Drill: ১০টা rapid-fire · **Tier 1 — Runnable Code**
> (একটা interactive drill, একটা সমাধানের তালিকা, আর একটা script যা গোল করা আর ভুল ধাপের প্রভাব মাপে; Docker লাগে না)

## কী বানাচ্ছি

Interview এ estimation এর জন্য পাঁচ মিনিটের মতো সময় থাকে, আর কোনো script থাকে না। এই exercise এর কাজ দুটো। প্রথমত, দশটা ছোট
হিসাব ঘড়ি ধরে, কাগজে করা, তারপর উত্তর মেলানো। দ্বিতীয়ত, একটা প্রশ্নের উত্তর মাপা: মাথায় গোল করে হিসাব (৮৬,৪০০ ≈ ১০⁵)
উত্তরকে কতটা সরায়, আর একটা ভুল ধাপ (bit আর byte গুলিয়ে ফেলা, peak ভুলে যাওয়া) কতটা।

| Script             | কী করে                                                                               | Lesson § |
| ------------------ | ------------------------------------------------------------------------------------ | -------- |
| `npm run drill`    | দশটা প্রশ্ন একটা একটা করে, প্রতিটায় সময় মাপে, তোমার উত্তর reference এর সাথে মেলায় | ১.৪, ৬   |
| `npm run answers`  | প্রতিটা drill এর পুরো হিসাবের chain, ধাপে ধাপে, আর শেষে "so" — সংখ্যা থেকে সিদ্ধান্ত | ১.৪      |
| `npm run rounding` | গোল করা বনাম ঠিক হিসাব, একটা ভুল ধাপ বনাম ঠিক হিসাব, আর কোন ধ্রুবক গোল করা নিরাপদ    | ১.৫      |

**`answers` আর `rounding` এর output এ উত্তর আছে।** Drill টা নিজে করার আগে এ দুটো চালিও না।

**সৎ নোট:**

- **প্রতিটা প্রশ্নের givens ধরে নেওয়া** — user, request, file এর আকার, একটা server এ কত connection, ইত্যাদি। এগুলো hardware
  বা কোনো আসল কোম্পানির মাপা সংখ্যা না; drill এর জন্য দেওয়া, যাতে সবার উত্তর তুলনা করা যায়। আসল interview এ এগুলো তুমি নিজে
  stated assumption হিসেবে বলবে (12.1)।
- **"মাথায় হিসাব" এর chain একটা সম্ভাব্য রূপ**, প্রতিটা drill এ আমি যেভাবে গোল করতাম। তোমার গোল করা আলাদা হলে তোমার ফলও একটু
  আলাদা হবে।
- **Grading মোটা দাগে:** ২ গুণের মধ্যে "close", ১০ গুণের মধ্যে "right order of magnitude", তার বাইরে "off"। সীমাগুলো
  বিচার থেকে নেওয়া, কোনো মান না।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; `answers` আর `rounding` দুবার করে, output byte
  ধরে হুবহু এক। `drill` piped input দিয়ে চালানো হয়েছে (unit সহ উত্তর, ভুল input, খালি লাইন, input আগে শেষ হওয়া)। Drill এর
  সময়ের column স্বাভাবিকভাবেই প্রতিবার আলাদা।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না। একটা কাগজ আর কলম।

## Setup

```bash
npm install
```

## Run

```bash
npm run drill
npm run answers
npm run rounding
```

`drill` এ প্রতিটা প্রশ্নের জন্য এক লাইনে একটা সংখ্যা লেখো। চলবে: `70000`, `70,000`, `70k`, `7e4`, `20 GB`, `130 min`।
`k`, `m`, `b`, `t` মানে হাজার, million, billion, trillion। **Unit এর লেখা বাদ দেওয়া হয়, রূপান্তর করা হয় না:** প্রশ্ন GB চাইলে
`1.2 tb` মানে 1.2 GB ধরা হবে। যে unit চাওয়া হয়েছে সেই unit এ উত্তর দেওয়াও drill এর অংশ। খালি লাইন দিলে drill টা skip হয়।

একটা drill আলাদা করে: `ONLY=6 npm run drill` (বা `ONLY=6 npm run answers`)। সময়ের সীমা বদলাতে: `LIMIT_S=90 npm run drill`।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run drill` — প্রতিটা উত্তরের পরে reference আর "so", শেষে একটা summary। উদাহরণ (উত্তর piped, তাই সময় ০):

```
── Summary ──
drill                                      yours     reference    off by  seconds
1. Photo app: peak reads                  70,000        69,444     1.01×        0
2. Photo app: storage per year              18.0          18.3     1.01×        0
6. Chat: peak message writes              46,000       138,889     3.02×        0
10. Logs: volume per day                     1.2         1,080      900×        0

within 2×: 8/10 · within 10×: 9/10 · over 120 s: 0 · total 0 s
```

`npm run answers` — প্রতিটা drill এর chain:

```
── Drill 1 — Photo app: peak reads ──
    views per day = 50M × 40                         2,000,000,000  views/day
    average = views / 86,400                                23,148  req/s
    peak = average × 3                                      69,444  req/s
  answer: 69,444 requests/s
```

`npm run rounding` — গোল করার সবচেয়ে বড় ভুল ১.২৭ গুণ; সবচেয়ে ছোট ভুল ধাপ ১.৬৭ গুণ, সবচেয়ে বড় ৮৬,৪০০ গুণ:

```
8. Fan-out: tail latency                    39.5          50.0     1.27×
worst rounding error: 1.27×
3. Live video: peak egress        mixed bits and bytes (3 MB/s per viewer)                          48.0     8.00×
6. Chat: peak message writes      forgot to divide by 86,400 (per day as per second)      12,000,000,000   86,400×
smallest slip: 1.67×
seconds in a day                          86,400          10^5     1.16×
```

## কী দেখার জন্য এটা বানানো

- **গতি আসে chain থেকে, মুখস্থ থেকে না।** প্রতিটা drill একই আকৃতির: কয়েকটা সংখ্যা গুণ, একটা ভাগ সময় দিয়ে, একটা গুণ peak বা
  headroom দিয়ে। `answers` এ chain গুলো পাশাপাশি দেখো।
- **গোল করা নিরাপদ।** দশটা drill এ মাথায় গোল করা হিসাব ঠিক হিসাব থেকে সর্বোচ্চ ১.২৭ গুণ দূরে। কোনো design এর সিদ্ধান্ত এতে বদলায় না।
- **ভুল ধাপ নিরাপদ না।** একটা ধাপ ভুল হলে উত্তর ১.৬৭ থেকে ৮৬,৪০০ গুণ সরে। তাই নজর রাখার জায়গা unit আর ধাপ, দশমিক না।
- **প্রতিটা সংখ্যার শেষে "so"।** Reference এর পরে প্রতিটা drill একটা সিদ্ধান্ত দেখায় — সংখ্যাটা কেন গোনা হলো।

## নিজে ভেঙে দেখো (Experiments)

1. **দুই মিনিটের সীমা কমাও:** `LIMIT_S=60 npm run drill`। কোন drill গুলো সীমা পার হয়? সেগুলোর chain এ কোন ধাপটা ধীর —
   গুণ, ভাগ, নাকি "কোন সংখ্যা দিয়ে শুরু করব" ঠিক করা?
2. **দ্বিতীয় রাউন্ড, এক সপ্তাহ পরে:** একই drill আবার, কাগজের আগের হিসাব না দেখে। Summary এর "within 2×" আর "total" আগের সাথে
   মেলাও। দ্রুত হয়েছ, কিন্তু নির্ভুলতা কমেছে কি?
3. **একটা নতুন slip যোগ করো:** `src/drills.ts` এ Drill 2 বা 7 এর জন্য একটা `slip` লেখো (যেমন "per month instead of per year",
   বা "forgot the headroom"), তারপর `npm run rounding`। কত গুণ সরে, আর সেটা গোল করার সবচেয়ে বড় ভুলের পাশে কেমন?
4. **নিজের drill:** `src/drills.ts` এ ১১ নম্বর drill যোগ করো — নিজের কোনো system এর একটা প্রশ্ন, givens, exact আর mental chain,
   আর একটা `so`। `tsc --noEmit` clean রাখো।

## Project Structure

```
src/
  util.ts      সংখ্যার format, টেবিলের column, env parse
  drills.ts    দশটা drill: givens, প্রশ্ন, exact chain, mental chain, so, আর একটা common slip
  drill.ts     script ক — interactive drill: সময় মাপা, Zod দিয়ে উত্তর parse, grading, summary
  answers.ts   script খ — প্রতিটা drill এর পুরো chain আর সিদ্ধান্ত
  rounding.ts  script গ — গোল করা বনাম ঠিক, ভুল ধাপ বনাম ঠিক, ধ্রুবক গোল করার ভুল
```

Environment variable: `ONLY`, `LIMIT_S`।
