# Lesson 12.3 — Mock Interview #1: আমি Interviewer, আপনি Candidate

**Module 12 — Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 5.8):** Hot partition কী? এক লাইনে বলুন। তারপর একটা প্রশ্ন মাথায় রেখে mock এ ঢুকুন: একটা leaderboard এর data কে যদি score এর range ধরে shard করা হয় (০-১,০০০ এক shard এ, ১,০০০-২,০০০ আরেকটায়, ...), তাহলে hot partition কোথায় জন্মাবে? উত্তর mock এর পরে, ১.৪ এ।

**Prerequisite:** Lesson 12.1 (framework, দশটা ভুল, rubric), Lesson 12.2 (estimation chain), Lesson 4.4 (Redis), Lesson 5.8 (Sharding), Lesson 11.4 (Fan-out)

**আপনি এই lesson শেষে পারবেন:**

1. একটা পুরো ৪৫ মিনিটের system design interview ঘড়ি ধরে, জোরে, নিজে চালাতে পারবেন: requirement এর প্রশ্ন, estimation, high-level, data model, deep dive, আর interviewer এর মাঝপথের follow-up
2. একটা real-time leaderboard এর মূল সিদ্ধান্তগুলো সংখ্যা দিয়ে বলতে পারবেন: কেন sorted set, কখন একটা Redis যথেষ্ট আর কখন না, সমান score এর ক্রম, সাপ্তাহিক reset, আর বন্ধুদের leaderboard এ কেন fan-out on read
3. নিজের recording কে 12.1 এর rubric ধরে প্রমাণসহ score দিতে পারবেন, আর একজন interviewer এর মতো লেখা feedback লিখতে পারবেন

**Tier:** 3 — Design Exercise (এটা একটা mock interview; deliverable হলো আপনার recording, rubric এর score, আর নিজের লেখা feedback। Module 12 এর মূল কথা মেনে কোনো script নেই: সংখ্যা মাথায়, সময় ঘড়িতে)

---

## ০. TaskFlow এখন কোথায়

TaskFlow আজ পাশে থাকছে। 12.1 এর transcript এ দেখেছেন জানা system এও interview কীভাবে খারাপ যায়, আর 12.2 তে estimation এর গতি তৈরি করেছেন। আজ সেগুলো একসাথে, প্রথমবার পুরো এক ঘণ্টা।

Curriculum এর ভাষায় এই lesson এ "আমি interviewer, আপনি candidate"। একটা লেখা lesson তো প্রশ্নের উত্তরে কথা বলতে পারে না, তাই interviewer এর ভূমিকা এখানে একটা **script**: প্রশ্নটা, আপনার clarifying question এর উত্তরগুলো একটা বন্ধ অংশে, আর interviewer এর প্রতিটা follow-up আলাদা আলাদা বন্ধ অংশে, মিনিট ধরে। আপনি জোরে উত্তর দিন, তারপর পরেরটা খুলুন। যেটা খোলোনি, সেটা interviewer এখনও জিজ্ঞেস করেনি।

পুরো mock শেষ হওয়ার পরে (আর শুধু তখন) ১.৪ থেকে পড়া চালান: সেখানে rubric ধরে নিজেকে score দেওয়ার কাঠামো, একটা ভালো ঘণ্টা কেমন দেখায় তার একটা model answer, আর এই প্রশ্নে candidate রা সাধারণত কোথায় পড়ে যায়।

একটা কথা আগে থেকে বলে রাখি: প্রথম mock এ ভালো না হওয়াটাই স্বাভাবিক। লক্ষ্য একটা ভালো score না, লক্ষ্য একটা **সৎ recording**, যেটা থেকে 12.4 এর আগে আপনি জানবেন কোন দুটো জিনিস বদলাতে হবে।

---

## ১. Theory

### ১.১ প্রস্তুতি আর নিয়ম

**লাগবে:** একটা timer (৪৫ মিনিট), কাগজ বা whiteboard, phone এ audio বা video recording, আর একটা শান্ত ঘর। কোনো note, বই, search বা AI না।

**নিয়ম:**

- **শুরুর আগে** recording চালু করুন, timer চালু করুন, আর board এর কোণে time box লিখুন: `Req 5 · Est 5 · HLD 10 · Deep 15 · Wrap 5` (12.1)।
- **পুরোটা জোরে।** সামনে কেউ নেই বলে চুপ করে ভাবা চলবে না। নীরবতা recording এ শূন্য signal।
- **Clarifying question গুলো জোরে করুন,** কাগজে লিখে রাখুন, তারপর ১.২ এর "Interviewer এর উত্তর" খুলুন। যে প্রশ্নের উত্তর সেখানে নেই, তার উত্তর "আপনিই ঠিক করুন" — তখন stated assumption।
- **Follow-up গুলো খুলুন তার মিনিটে,** বা তার আগে যদি আপনি যে কাজ করছিলেন সেটা শেষ হয়। একটা খুলে জোরে ২-৪ মিনিট উত্তর দিন, তারপর নিজের নকশায় ফিরুন।
- **যে follow-up এর বিষয় আপনি আগেই নিজে থেকে বলে ফেলেছেন,** সেটা খুলে শুধু এক লাইনে "এটা আগেই বলেছি, মিনিট mm:ss এ" বলুন আর পরেরটায় যান। নিজে থেকে বলা এখানে একটা বড় signal (12.1 এর senior এর সংজ্ঞা), আর score এর সময় সেটা গোনা হবে।
- **৪৫ মিনিটে থামুন,** কাজ যেখানেই থাকুক। বাস্তবে interviewer থামাবে।

### ১.২ প্রশ্ন (00:00)

Interviewer:

> "আমাদের একটা জনপ্রিয় mobile game আছে। আমরা একটা leaderboard চাই। Design it."

এটুকুই। এখন timer চালু করুন আর শুরু করুন।

<details>
<summary><strong>Interviewer এর উত্তর — নিজের clarifying question গুলো জোরে করার পরে খুলুন</strong></summary>

আপনি যে প্রশ্ন করেছেন শুধু তার উত্তর নিন। এখানে যা আছে কিন্তু আপনি জিজ্ঞেস করোনি, সেটা interviewer বলত না — সেটা জানেন না ধরে নিন, আর mock এর পরে লিখে রাখুন যে প্রশ্নটা বাদ পড়েছিল।

| প্রশ্ন                       | Interviewer এর উত্তর                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| কতজন player?                 | রোজ ~৫ কোটি active; এক সপ্তাহে ~১০ কোটি আলাদা player কোনো না কোনো score পায়                            |
| Score কীভাবে আসে?            | প্রতিটা match এর শেষে ০ থেকে ১০০ point; একজন active player দিনে গড়ে ~১০টা match খেলে                   |
| কোন leaderboard?             | সাপ্তাহিক, global: সপ্তাহের মোট point। সোমবার 00:00 UTC তে নতুন সপ্তাহ                                  |
| কী দেখাবে?                   | সবার উপরের ১০০ জন; আমার rank আর score; আমার উপরে-নিচে ৫ জন করে                                          |
| কতবার দেখে?                  | একজন active player দিনে গড়ে ~২০ বার leaderboard খোলে, বেশিরভাগ match এর পরে                            |
| কত দ্রুত update?             | নিজের নতুন score সাথে সাথে দেখা চাই; rank কয়েক সেকেন্ড পুরনো হলে চলে                                   |
| সমান score?                  | যে আগে ওই score এ পৌঁছেছে সে উপরে                                                                       |
| Prize আছে?                   | হ্যাঁ: প্রতি সপ্তাহে উপরের ১,০০০ জন game এর ভেতরে পুরস্কার পায়। তাই উপরের দিকটা ঠিক আর ন্যায্য হতে হবে |
| Cheating?                    | হ্যাঁ, একটা বাস্তব সমস্যা। Match চালায় আমাদের game server; client কে বিশ্বাস করা যায় না               |
| Peak?                        | সন্ধ্যায়, গড়ের মোটামুটি ৩ গুণ                                                                         |
| বন্ধুদের, দেশের leaderboard? | "পরে আসতে পারে, আগে global টা।"                                                                         |
| অন্য যেকোনো প্রশ্ন           | "আপনিই ঠিক করুন।"                                                                                       |

</details>

### ১.৩ Interviewer এর follow-up

প্রতিটা তার মিনিটে, বা তার আগে যদি হাতের কাজ শেষ। একটা একটা করে খুলুন।

<details>
<summary><strong>Follow-up ১ — মিনিট ~১৫</strong></summary>

> "একজন player 'আমার rank' এ চাপ দিল। ঠিক কী ঘটে? কোন data structure, আর কত খরচ?"

</details>

<details>
<summary><strong>Follow-up ২ — মিনিট ~২০</strong></summary>

> "Match শেষ হলো। Score টা leaderboard পর্যন্ত কোন পথে যায়, দেখান। আর game server যদি একই match এর result দুবার পাঠায়? আর কেউ modded client দিয়ে নিজেই ৯,৯৯৯ point পাঠালে?"

</details>

<details>
<summary><strong>Follow-up ৩ — মিনিট ~২৫</strong></summary>

> "দুজনের score ৪,২০০। একজন মঙ্গলবার পৌঁছেছে, আরেকজন বৃহস্পতিবার। কে উপরে, আর আপনার data structure এ সেটা কীভাবে রাখবেন?"

</details>

<details>
<summary><strong>Follow-up ৪ — মিনিট ~২৯</strong></summary>

> "সোমবার 00:00 UTC তে সপ্তাহ শেষ। ঠিক কী করবেন? আর রবিবার 23:59:58 এ শেষ হওয়া একটা match এর result যদি 00:00:03 এ এসে পৌঁছায়?"

</details>

<details>
<summary><strong>Follow-up ৫ — মিনিট ~৩৩</strong></summary>

> "এখন product চায় বন্ধুদের মধ্যে leaderboard: আমার বন্ধুদের মধ্যে আমি কোথায়।"

</details>

<details>
<summary><strong>Follow-up ৬ — মিনিট ~৩৭</strong></summary>

> "Game টা দশ গুণ বড় হলো: সপ্তাহে ১০০ কোটি player। প্রথমে কী ভাঙে, আর কী বদলাবেন?"

</details>

<details>
<summary><strong>Follow-up ৭ — মিনিট ~৪১</strong></summary>

> "Leaderboard এর data যে machine এ, সেটা পুরো হারিয়ে গেল, replica সহ। কী হবে, আর কতক্ষণে ফিরবে?"

</details>

<details>
<summary><strong>Follow-up ৮ — মিনিট ~৪৪</strong></summary>

> "সময় প্রায় শেষ। এই design এ আপনি সবচেয়ে কম নিশ্চিত কোথায়?"

</details>

**৪৫ মিনিট। Timer থামান, recording বন্ধ করুন।** এখানে একটা বিরতি নিন। বাকিটা পড়ার আগে, recording না শুনে, তিনটা জিনিস কাগজে লিখুন: কোন মুহূর্তটা সবচেয়ে ভালো গেছে, কোনটা সবচেয়ে খারাপ, আর কোন follow-up এ আপনি সবচেয়ে বেশি অপ্রস্তুত ছিলেন। পরে recording এর সাথে মেলাবেন।

### ১.৪ Score: rubric ধরে, প্রমাণ সহ

**Spaced repetition এর উত্তর:** hot partition মানে একটা shard এ বাকিদের চেয়ে অনেক বেশি data বা traffic, যা পুরো system এর bottleneck হয় (5.8)। Score এর range ধরে shard করলে সমস্যা দুটো। প্রথমত, score এর বিন্যাস সমান না, power law এর মতো (11.4): বেশিরভাগ player নিচের দিকে, তাই নিচের range এর shard গুলো বিশাল। দ্বিতীয়ত, প্রায় সবার score বাড়তে থাকে, তাই player রা প্রতিনিয়ত এক shard থেকে আরেকটায় সরে, আর প্রতিটা সরানো দুটো shard এ লেখা। আর সবার নজর উপরের ১০০ জনের দিকে, তাই সবচেয়ে বেশি পড়া হয় উপরের shard টা। ফলে data এর ভার এক জায়গায়, পড়ার ভার আরেক জায়গায়, আর লেখার ভার সীমানাগুলোয়। Follow-up ৬ এ এটা আবার আসবে।

এখন recording টা শুনুন (12.1 এর মতো, সম্ভব হলে পরের দিন)। প্রতিটা মাত্রায় ১ থেকে ৪, আর প্রতিটা নম্বরের পাশে recording এর একটা `mm:ss` প্রমাণ হিসেবে। প্রমাণ ছাড়া নম্বর না। নিচের টেবিলের নোঙরগুলো (anchor) **এই প্রশ্নের জন্য** লেখা:

| মাত্রা             | ১ — দুর্বল                        | ২                                                     | ৩                                                                            | ৪ — শক্ত                                                                             |
| ------------------ | --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| অস্পষ্টতা সামলানো  | সরাসরি আঁকা শুরু                  | কয়েকটা প্রশ্ন, কিন্তু scope বা "কী দেখাবে" ঠিক হয়নি | কোন leaderboard, কী দেখাবে, freshness, peak জিজ্ঞেস করেছে; scope জোরে বলেছে  | সাথে prize আর cheating জিজ্ঞেস করেছে — যে দুটো উত্তর নকশার সঠিকতার দাবি বদলায়       |
| কাজের নকশা         | বক্স আছে, data model বা API নেই   | Data model বা API এর একটা                             | Score এর পথ আর পড়ার পথ দুটোই end-to-end, data model আর API সহ               | সাথে কোনটা সত্যের উৎস (DB/log) আর কোনটা derived (leaderboard এর store) স্পষ্ট        |
| Technical গভীরতা   | "Redis এ রাখব" এর বেশি না         | Sorted set বলেছে, কিন্তু rank এর খরচ বা সংখ্যা না     | O(log N), memory আর op/s এর সংখ্যা; সমান score আর reset এর সঠিক উত্তর        | সাথে duplicate result আর retry এর idempotency, আর ১০ গুণে কী ভাঙে তার সংখ্যাসহ উত্তর |
| বিচার আর trade-off | একটাই সমাধান, কোনো দাম নেই        | বিকল্প বলেছে, কিন্তু বাছাইয়ের কারণ না                | বড় সিদ্ধান্তে দুটো বিকল্প আর দাম (যেমন বন্ধুদের: write বনাম read এ fan-out) | কোন যন্ত্র **লাগে না** সেটা সংখ্যা দিয়ে বলেছে (যেমন আজকের মাপে sharding না)         |
| যোগাযোগ            | দীর্ঘ নীরবতা, follow-up এ এলোমেলো | জোরে ভেবেছে, কিন্তু ঘড়ি বা check-in নেই              | Time box মেনেছে, ধাপ বদলের সময় check-in                                     | কয়েকটা follow-up এর বিষয় আগেই নিজে তুলেছে; একটা ভুল নিজে ধরে শুধরেছে               |

পাঁচটা নম্বর যোগ করে একটা সংখ্যা বানানোর লোভ সামলান। আসল hiring এর সিদ্ধান্ত যোগফল দিয়ে হয় না: একটা মাত্রায় ১ (যেমন technical গভীরতা) প্রায়ই বাকি সবকিছুকে ছাপিয়ে যায়, আর level ভেদে প্রত্যাশা আলাদা (12.1)। মোটা দাগে: senior এর জন্য গভীরতা আর বিচারে ৩ এর নিচে কিছু থাকলে, আর mid-level এর জন্য কোনো মাত্রায় ১ থাকলে, ফল সম্ভবত "no hire"। এটা আমার সাধারণ পর্যবেক্ষণ, কোনো কোম্পানির নিয়ম না।

তারপর 12.1 এর দশটা ভুলের checklist, প্রতিটার পাশে হ্যাঁ/না আর `mm:ss`:

```
[ ] ১  requirement/scope ছাড়া শুরু           [ ] ৬  data model / API বাদ
[ ] ২  সংখ্যা আছে, "তাই" নেই                 [ ] ৭  high-level এ ঘড়ি ভুলে যাওয়া
[ ] ৩  গড় দিয়ে নকশা                         [ ] ৮  শুধু happy path
[ ] ৪  যন্ত্রের নাম আগে                       [ ] ৯  trade-off ছাড়া "সেরা"
[ ] ৫  প্রথম দিনেই বড় scale                  [ ] ১০ নীরবতা / hint প্রতিরোধ
```

### ১.৫ একটা ভালো ঘণ্টা কেমন দেখায়

নিচের model answer টা **নিজের score দেওয়ার পরে** খুলুন। এটা একমাত্র সঠিক উত্তর না: এই প্রশ্নের কয়েকটা যুক্তিসঙ্গত নকশা আছে, আর আপনারটা আলাদা হলেও ভালো হতে পারে, যদি প্রতিটা সিদ্ধান্তের পেছনে একটা সংখ্যা বা কারণ থাকে। এটা দেখার জিনিস আকৃতি: কোন মিনিটে কী, আর প্রতিটা সংখ্যার পরে কোন "তাই"।

<details>
<summary><strong>Model answer — নিজের score দেওয়ার পরে খুলুন</strong></summary>

**00:00–05:00 — Requirement।** উপরের টেবিলের প্রায় সব প্রশ্ন, কিন্তু একটা ক্রমে: প্রথমে "কী দেখাবে" (উপরের ১০০, আমার rank, আশেপাশে), তারপর মাপ, তারপর সঠিকতা (prize, cheating, সমান score)। শেষে scope জোরে: "সাপ্তাহিক global leaderboard, score লেখার পথ আর পড়ার পথ। বন্ধু আর দেশের leaderboard পরে, সময় থাকলে।"

**05:00–10:00 — Estimation**, 12.2 এর chain এ:

```
Score write: ৫ কোটি × ১০ match = ৫ × ১০⁸/দিন; ÷ ১০⁵ ≈ ৫,০০০/s (ঠিক হিসাবে ~৫,৮০০), × ৩ → ~১৭,০০০/s peak
Read:        ৫ কোটি × ২০ বার = ১০⁹/দিন;      ÷ ১০⁵ ≈ ১০,০০০/s (ঠিক ~১১,৬০০),  × ৩ → ~৩৫,০০০/s peak
প্রতি read এ op: আমার rank + আশেপাশের ১০ জন = ~২ op (উপরের ১০০ সবার জন্য এক, তাই ১ সেকেন্ডের জন্য cache)
             → ~৭০,০০০ read op/s + ~১৭,০০০ write op/s ≈ ৯০,০০০ op/s peak
Memory:      সপ্তাহে ১০ কোটি player × ~১০০ byte প্রতি entry (ধরে নেওয়া, মেপে দেখতে হবে) ≈ ১০ GB;
             চলতি আর আগের সপ্তাহ মিলে ~২০ GB
Match এর রেকর্ড: ৫ × ১০⁸/দিন × ~৫০ byte ≈ ২৫ GB/দিন, সপ্তাহে ~১৭৫ GB
```

"তাই": **Memory তে পুরোটা একটা machine এ আঁটে** — ১০ GB একটা Redis এর জন্য ছোট, তাই sharding এর প্রয়োজন memory থেকে আসে না। **চাপটা op/s এ:** ~৯০,০০০ op/s, আর একটা Redis node কে আমি পরিকল্পনায় ~৫০,০০০ op/s এ রাখব (11.2 এর মতো ধরে নেওয়া: আরামদায়ক ~১ লাখ, অর্ধেক headroom)। লেখা ১৭,০০০/s একটা primary তে সহজ; পড়াটা বেশি। তাই **একটা primary আর ২-৩টা read replica,** sharding না। Rank কয়েক সেকেন্ড পুরনো চলে, তাই replica এর lag সমস্যা না। Match এর রেকর্ড দিনে ২৫ GB: সাপ্তাহিক partition, পুরনো partition মুছে ফেলা (5.8 এর retention)।

**10:00–20:00 — High-level, data model, API।**

```
 [game server] ──match result (signed)──► [score service] ──► [log, user_id এ partition] ──► [aggregator]
                                                                                              │
                                     ┌────────────────── batch এ ─────────────────────────────┤
                                     ▼                                                         ▼
                        Postgres: match_results, weekly_totals                    Redis: lb:2026-W41 (sorted set)
                        (সত্যের উৎস)                                               (derived, আবার বানানো যায়)
                                                                                              ▲
 [mobile app] ──► [leaderboard API] ── উপরের ১০০ (in-process cache, ১ s) ─────── read replica ┘
```

```
match_results(match_id PK, user_id, week, points, ended_at)       -- week ধরে partition
weekly_totals(week, user_id, points, reached_at, PK(week, user_id))

GET  /leaderboard/:week/top?limit=100
GET  /leaderboard/:week/me            → { rank, score, around: [...] }
POST /internal/match-results          (শুধু game server, signed)
```

**Sorted Set** — Redis এর একটা data structure যেখানে প্রতিটা member এর একটা score থাকে আর set টা score ধরে সাজানো থাকে; ভেতরে একটা skip list আর একটা hash table। Member যোগ বা বদল (`ZADD`), আর কারো rank বের করা (`ZREVRANK`), দুটোই O(log N)। ১০ কোটিতে log₂ ≈ ২৭ ধাপ। একটা range আনা (`ZREVRANGE`) O(log N + ফেরত দেওয়া সংখ্যা)। Leaderboard এর তিনটা প্রশ্নের প্রতিটা এক command।

**Follow-up ১ (আমার rank):** `ZREVRANK lb:2026-W41 user:123` → rank, O(log N); তারপর `ZREVRANGE` দিয়ে rank − ৫ থেকে rank + ৫। দুটো op, replica থেকে। উপরের ১০০ জন সবার জন্য একই, তাই leaderboard API এর process এ ১ সেকেন্ডের cache: হাজার হাজার request এ একটা Redis op। তুলনা হিসেবে একটা বাক্য: "Postgres এ `COUNT(*) WHERE points > mine` index এ O(rank) — নিচের দিকের একজন player এর জন্য কোটি row গোনা।"

**Follow-up ২ (লেখার পথ, duplicate, cheating):**

- **Server-Authoritative Score** — score আসে শুধু আমাদের game server থেকে, যে match টা চালিয়েছে; client কখনো নিজের score পাঠায় না। Modded client এর ৯,৯৯৯ এর পথই নেই। Game server এর request signed (10.5), আর score service এ সাধারণ সীমা: এক match এ ১০০ এর বেশি না, এক ঘণ্টায় যতগুলো match সম্ভব তার বেশি না (9.5)। সন্দেহজনক ধারা async এ একটা anti-cheat job দেখে।
- **Duplicate:** `match_id` primary key। Aggregator batch এ insert করে `ON CONFLICT DO NOTHING`, আর **শুধু নতুন ঢোকা row গুলোর** point `weekly_totals` এ যোগ করে, একই transaction এ। একই result দুবার এলে দ্বিতীয়বার কিছু যোগ হয় না (7.4)।
- **কেন batch:** ১৭,০০০/s আলাদা transaction একটা Postgres primary এর জন্য ভারী; ধরুন ২০০ টা করে batch এ, সেকেন্ডে ~৮৫টা transaction। এটা লেখার পথে একটা log রাখার কারণ: game server log এ লিখেই খালাস, আর aggregator নিজের গতিতে batch করে।
- **Redis এ লেখা:** `ZINCRBY` না, কারণ সেটা idempotent না — retry এ দুবার যোগ হয়। বরং DB এর মোট টা সরাসরি: `ZADD lb:2026-W41 GT <total> user:123`। `GT` (Redis 6.2+) মানে শুধু তখনই বদলান যখন নতুন মান বড়; সাপ্তাহিক মোট শুধু বাড়ে, তাই পুরনো বা দুবার আসা update চুপচাপ উপেক্ষা হয়। একই user এর সব event একই log partition এ, তাই তার ক্রম ঠিক থাকে।
- **নিজের score সাথে সাথে:** match এর শেষে game server এর উত্তরেই নতুন মোট থাকে, app সেটাই দেখায় (6.3 এর read-your-writes)। Rank কয়েক সেকেন্ড পরে replica থেকে।

**Follow-up ৩ (সমান score):**

**Composite Score** — একাধিক জিনিসকে একটা সংখ্যায় গেঁথে রাখা, যাতে একটা সাধারণ সাজানোই দুটো নিয়ম মানে। এখানে: `points × 2²⁰ + (604,800 − সপ্তাহ শুরু থেকে সেকেন্ড)`। এক সপ্তাহ ৬,০৪,৮০০ সেকেন্ড, যা ২²⁰ (~১০ লাখ) এর কম, তাই সময়ের অংশ কখনো point এর অংশে উপচে পড়ে না। আগে পৌঁছালে বাকি সময় বেশি, তাই সংখ্যা বড়, তাই উপরে। একজন গড় player সপ্তাহে কয়েক হাজার point পায়, কিন্তু সীমাটা গড় দিয়ে না, সম্ভাব্য সর্বোচ্চ দিয়ে হিসাব করতে হয়: একটা match কয়েক মিনিট, তাই সারা সপ্তাহ না থেমে খেললেও ধরুন ~২ লাখ point। ২ লাখ × ২²⁰ ≈ ২.১ × ১০¹¹, যা Redis এর score (একটা double, ২⁵³ ≈ ৯ × ১০¹⁵ পর্যন্ত integer নিখুঁত) এর অনেক নিচে। আর point বাড়লে composite সবসময় বাড়ে, তাই `GT` এখনও ঠিক কাজ করে। `reached_at` আসে match এর শেষের সময় থেকে, game server এর ঘড়িতে (6.4: client এর ঘড়ি না)।

**Follow-up ৪ (সাপ্তাহিক reset):**

**Time-Bucketed Key** — সময়ের প্রতিটা জানালার জন্য আলাদা key (`lb:2026-W41`, `lb:2026-W42`), যাতে "reset" মানে কিছু মোছা না, শুধু নতুন key তে লেখা শুরু। 00:00 এ কিছুই চালাতে হয় না: যে match এর `ended_at` নতুন সপ্তাহে, সেটা নতুন key তে যায়। ১০ কোটি member এর একটা key একবারে `DEL` করলে Redis কয়েক সেকেন্ড আটকে যেতে পারে; পুরনো key এর উপর শুধু একটা `EXPIRE` (দুই সপ্তাহ), বা `UNLINK` যা background এ মোছে।

দেরিতে আসা result: সপ্তাহ ঠিক হয় match শেষ হওয়ার সময় দিয়ে, পৌঁছানোর সময় দিয়ে না। 23:59:58 এর match আগের সপ্তাহের key তে যায়, 00:00:03 এ পৌঁছালেও। তাই prize এর তালিকা 00:00 এ চূড়ান্ত না: একটা grace window (ধরুন ১৫ মিনিট, log এর lag এর চেয়ে বেশি), তারপর উপরের ১,০০০ এর একটা snapshot DB তে, আর prize দেওয়া প্রতিটা `(week, user_id)` ধরে idempotent (11.7)। এর পরে আসা result আর prize বদলায় না, শুধু রেকর্ডে থাকে। (11.7 এর reconciliation এর ±১ দিনের মতো: সীমানায় সহনশীলতা।)

**Follow-up ৫ (বন্ধুদের leaderboard):** দুটো পথ। **Fan-out on write:** প্রতিটা user এর জন্য বন্ধুদের একটা আলাদা sorted set, আর কারো score বদলালে তার সব বন্ধুর set এ লেখা। গড়ে ৫০ জন বন্ধু ধরলে ১৭,০০০ × ৫০ = সেকেন্ডে **৮.৫ লাখ** লেখা, আর memory তে ১০ কোটি × ৫০ entry। **Fan-out on read:** বন্ধুদের list (গড়ে ৫০, সীমা ধরুন ৫,০০০) নিয়ে একটা `ZMSCORE` (Redis 6.2+) এ সবার score, তারপর app এ সাজানো। এক command, ৫০টা lookup। এখানে read জেতে (11.4 এর উল্টো ফল, একই কারণে: খরচ কোন দিকে বেশি)। বন্ধুদের list ছোট আর সীমিত, আর একটা score update হাজার বার পড়ার চেয়ে অনেক বেশি ঘন ঘন। ৫,০০০ এর কাছের বড় list এর জন্য cache করা ফল কয়েক সেকেন্ড।

**Follow-up ৬ (দশ গুণ: ১০০ কোটি player):**

```
Write: ~১,৭০,০০০/s peak;  Read op: ~৭ লাখ/s;  Memory: ~১০০ GB প্রতি সপ্তাহের key
```

প্রথমে ভাঙে **একটা primary তে লেখা** আর **একটা key এর memory**: দুটোই একটা node এর সীমার বাইরে। এবার sharding। দুটো পথ:

- **Score এর range ধরে:** spaced repetition এর উত্তর — বেশিরভাগ player নিচের shard এ, উপরের ১০০ জনের সব read এক shard এ, আর score বাড়লে player shard বদলায়। বাদ।
- **User ধরে (hash):** N টা shard, প্রতিটায় সেই shard এর user দের sorted set। আমার rank = সব shard এ `ZCOUNT(আমার score এর বেশি)` এর যোগফল: N টা parallel O(log n) call (5.8 এর scatter-gather; N ≈ ২০ হলে সহজ)। উপরের ১০০ = প্রতিটা shard এর উপরের ১০০ মিলিয়ে সাজানো, ১ সেকেন্ডের cache।

আর একটা senior এর পর্যবেক্ষণ, যেটা পুরো প্রশ্নটা ছোট করে দেয়:

**Rank Histogram** — score এর প্রতিটা সম্ভাব্য মানের (বা মানের একটা ছোট পাল্লার) জন্য কতজন player সেই score এ আছে তার একটা গণনা; কারো rank = তার score এর উপরের সব ঘরের যোগফল। এখানে score এর domain ছোট: point integer, আর সপ্তাহে সম্ভাব্য সর্বোচ্চ ~২ লাখ (follow-up ৩ এর হিসাব), মানে ~২ লাখ ঘরের একটা array, ~১.৬ MB। ১০০ কোটি player এর rank, সমান score এর ভেতরের ক্রম বাদে, এই ছোট array থেকেই নিখুঁতভাবে বের হয়, আর সেটা যেকোনো machine এর memory তে আঁটে। তাই sorted set লাগে শুধু উপরের দিকের জন্য (prize এর ১,০০০, উপরের ১০০, সমান score এর ক্রম যেখানে গুরুত্বপূর্ণ), আর নিচের কোটি কোটি player এর জন্য "#১৪,৩২,০৯৮" এর বদলে histogram থেকে rank, বা "উপরের ১৫%"। (Score এর domain বড় বা দশমিক হলে বালতি (bucket) বানাতে হয়, তখন rank আনুমানিক।)

**Follow-up ৭ (Redis পুরো হারানো):** Redis সত্যের উৎস না, derived। `weekly_totals` থেকে আবার বানানো: ১০ কোটি row পড়ে pipeline এ `ZADD`, কয়েক মিনিট (ঠিক সময়টা মাপতে হবে)। এর মধ্যে: game চলতে থাকে আর score log এ জমতে থাকে, কারণ লেখার পথ Redis এর উপর নির্ভর করে না; leaderboard এর পাতা দেখায় "শীঘ্রই আসছে" বা শেষ cache করা উপরের ১০০ (10.3 এর degraded mode)। Rebuild শেষে aggregator log এর যেখানে ছিল সেখান থেকে চালায়, আর `ZADD GT` এর কারণে দুবার চালানো update নিরাপদ। সাধারণ ক্ষেত্রে (শুধু primary মরা) replica কে primary বানানো, আর শেষ এক সেকেন্ডের হারানো update log থেকে আবার।

**Follow-up ৮ (সবচেয়ে কম নিশ্চিত):** "দুটো সংখ্যা যেগুলো আমি ধরে নিয়েছি কিন্তু মাপিনি: Redis এ প্রতি entry এর ~১০০ byte, আর একটা node এ sorted set এর op এর ক্ষমতা। প্রথমটা ভুল হলে memory এর হিসাব বদলায়, দ্বিতীয়টা হলে কয়টা replica লাগবে। দুটোই একদিনের একটা load test এ মাপা যায়: ১০ কোটি synthetic member, `MEMORY USAGE`, আর peak এর মিশ্রণে op/s। আর ব্যবসার দিকে: cheating। Server-authoritative score অনেক কিছু থামায়, কিন্তু একজন সত্যিকারের খেলোয়াড় bot দিয়ে খেলালে game server এর চোখে সেটা বৈধ match। ওটা leaderboard এর নকশার প্রশ্ন না, কিন্তু prize এর ন্যায্যতা ওখানেই ঝুলে আছে।"

**Wrap-up এর তিনটা বাক্য:** "আজকের মাপে একটা Redis primary আর কয়েকটা replica, sharding না, কারণ memory ১০ GB আর চাপ ~৯০,০০০ op/s। সত্যের উৎস Postgres আর log, Redis derived, তাই হারালে আবার বানানো যায়। প্রথমে ভাঙবে দশ গুণে লেখা আর memory; তখন user ধরে shard, আর নিচের দিকের rank এর জন্য histogram।"

</details>

### ১.৬ এই প্রশ্নে candidate রা সাধারণত কোথায় পড়ে

নিচের লাইনগুলো এই প্রশ্নের জন্য লেখা feedback এর নমুনা। প্রতিটার পাশে 12.1 এর ভুলের নম্বর। নিজের recording এ এর কোনোটা আছে কিনা খুঁজুন:

- _"প্রথম মিনিটেই 'Redis sorted set' বলেছে, কিন্তু কী দেখাতে হবে (উপরের ১০০, নাকি আমার rank, নাকি দুটোই) জিজ্ঞেস করেনি।"_ — ভুল ১ আর ৪। Sorted set এখানে প্রায় নিশ্চিতভাবে ঠিক উত্তর, কিন্তু interviewer জানে না আপনি সেটা কেন বেছেছেন, নাকি মুখস্থ।
- _"Leaderboard sharding এ ১০ মিনিট দিয়েছে, অথচ নিজের হিসাবেই পুরোটা ১০ GB।"_ — ভুল ৫ আর ২। এই প্রশ্নের সবচেয়ে প্রচলিত ফাঁদ, কারণ "leaderboard at scale" এর লেখাগুলো sharding দিয়ে শুরু হয়।
- _"Score কোথা থেকে আসে, জিজ্ঞেস করিনি; client এর পাঠানো score সরাসরি `ZINCRBY`।"_ — ভুল ৮। একসাথে cheating আর idempotency দুটোই খোলা।
- _"Redis ই একমাত্র store; সেটা হারালে কী, প্রশ্ন আসার পরে প্রথমবার ভেবেছে।"_ — ভুল ৮ আর ৬ (data model এ সত্যের উৎস নেই)।
- _"সমান score এর প্রশ্নে 'Redis নিজেই সামলায়' বলেছে।"_ — Redis সমান score এ member এর নাম ধরে সাজায়, যা "যে আগে পৌঁছেছে" এর নিয়ম না। ভুল ৯: একটা দাবি, যাচাই ছাড়া। ঠিক উত্তর না জানলে 12.1 এর "না জানা" এর বাক্যটা।
- _"বন্ধুদের leaderboard এ প্রতি user এর জন্য আলাদা sorted set, লেখার খরচ গোনেনি।"_ — ভুল ২ আর ৯। ৮.৫ লাখ write/s একটা সংখ্যায় ধরা পড়ত।

**নিজের feedback লিখুন,** একজন interviewer এর মতো, তৃতীয় পুরুষে (নিজেকে "candidate" বলে): তিনটা শক্তি আর তিনটা উন্নতির জায়গা, প্রতিটা একটা `mm:ss` সহ, আর শেষে একটা সিদ্ধান্ত (strong hire / hire / lean no hire / no hire) আর তার এক লাইনের কারণ। তৃতীয় পুরুষে লেখার কারণ: নিজের সম্পর্কে "আমি নার্ভাস ছিলাম" লেখা সহজ, "candidate ১৮ মিনিটে চার মিনিট চুপ ছিল" লেখা সৎ।

> **Trade-off Table — leaderboard এর বড় সিদ্ধান্ত**

| সিদ্ধান্ত            | বেছে নিলাম                                 | বিকল্প                                 | কী দিলাম                                     | কী পেলাম                                                             |
| -------------------- | ------------------------------------------ | -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Rank এর store        | Redis sorted set, derived                  | Postgres এ `COUNT` / প্রতি মিনিটে rank | আরেকটা store চালানো, আর rebuild এর পথ        | O(log N) rank আর range; নিচের player এর জন্যও এক op                  |
| আজকের মাপে           | একটা primary + replica                     | User ধরে sharding                      | ১০ গুণে একটা migration                       | কোনো scatter-gather নেই, সরল operation (memory ১০ GB, ~৯০,০০০ op/s)  |
| সত্যের উৎস           | Log + Postgres এর `weekly_totals`          | শুধু Redis                             | লেখার পথে বাড়তি ধাপ, batch এর কয়েক সেকেন্ড | Redis হারালে মিনিটে rebuild; prize এর audit                          |
| Redis এ লেখা         | DB এর মোট দিয়ে `ZADD GT`                  | `ZINCRBY`                              | DB থেকে মোট পড়া                             | Retry আর দুবার আসা update নিরাপদ                                     |
| সমান score           | Composite score (point, তারপর আগে পৌঁছানো) | Redis এর নিজের ক্রম (নাম ধরে)          | একটা encode/decode এর নিয়ম                  | "যে আগে পৌঁছেছে" নিয়ম, এক command এ                                 |
| Reset                | সপ্তাহ প্রতি key, `EXPIRE`                 | 00:00 এ `DEL`                          | দুই সপ্তাহের memory                          | Reset এ কোনো কাজ নেই, Redis আটকায় না; দেরিতে আসা result ঠিক সপ্তাহে |
| বন্ধুদের leaderboard | Fan-out on read (`ZMSCORE`)                | প্রতি user এর sorted set               | প্রতি read এ ~৫০ lookup                      | ৮.৫ লাখ write/s আর বিশাল memory বাঁচল                                |

---

## ২. Interview Angle

Leaderboard এর প্রশ্নটা কয়েকটা রূপে আসে, আর প্রতিটার deep dive আলাদা জায়গায়:

- **"Top K" (trending hashtag, সবচেয়ে বেশি দেখা video):** এখানে প্রতিটা আইটেমের score একটা গণনা, আর item এর সংখ্যা বিশাল ও অনিশ্চিত। Deep dive যায় stream processing (7.6), sliding window, আর আনুমানিক গণনায় (count-min sketch এর মতো, 10.2 এর আত্মীয়)। Sorted set একা যথেষ্ট না।
- **"Real-time ranking for a contest" (coding contest, live quiz):** কয়েক ঘণ্টা, কম player, কিন্তু শেষ মুহূর্তের ঢেউ আর ন্যায্যতা (সময়ের tie-break) মূল।
- **Mid-level বনাম senior:** mid-level এ sorted set, একটা ঠিকঠাক লেখার পথ, আর সমান score এর উত্তর যথেষ্ট। Senior এ interviewer খোঁজে: সত্যের উৎস কোনটা, idempotency, reset এর সীমানা, আর সংখ্যা দিয়ে "এখন sharding না" বলার সাহস।
- **"Redis ছাড়া করুন":** একটা প্রচলিত চাপ, দেখতে যে আপনি data structure টা বোঝেন নাকি শুধু নাম জানেন। উত্তর: rank মানে "আমার উপরে কতজন", আর সেটা কোন structure দ্রুত দেয় (balanced tree এ subtree এর আকার, বা ছোট domain এ histogram)।

**Production এ বাস্তবে:** game এর leaderboard এর সবচেয়ে প্রচলিত ঘটনা প্রযুক্তির না, ন্যায্যতার: cheating এর ঢেউ এর পরে উপরের তালিকা পরিষ্কার করা (সন্দেহজনক player কে তালিকা থেকে সরানো কিন্তু রেকর্ড রাখা, যাতে আপিল এ ফেরানো যায়), আর reset এর মুহূর্তে time zone বা দেরিতে আসা result নিয়ে player দের অভিযোগ। দুটোরই ওষুধ এই নকশায় আছে: সত্যের উৎস আলাদা, আর সীমানায় একটা লেখা নিয়ম।

---

## ৩. Key Takeaway

- **Mock এর লক্ষ্য একটা সৎ recording:** জোরে, ঘড়ি ধরে, follow-up তার মিনিটে; আর score প্রতিটা `mm:ss` প্রমাণ সহ
- **"কী দেখাবে" আগে, যন্ত্র পরে:** উপরের ১০০, আমার rank, আশেপাশে — তিনটা প্রশ্নই একটা sorted set এর এক একটা O(log N) command, আর সেটাই sorted set বাছার কারণ
- **সংখ্যা বলে sharding লাগবে না:** ১০ কোটি player এ ~১০ GB আর ~৯০,০০০ op/s — একটা primary আর replica। "Leaderboard at scale" এর লেখাগুলো sharding দিয়ে শুরু হয়, আপনার হিসাব না
- **Redis derived, সত্য অন্য জায়গায়:** log আর `weekly_totals` থেকে মিনিটে আবার বানানো যায়; লেখায় `ZADD GT` দিয়ে retry নিরাপদ, `ZINCRBY` না
- **সঠিকতার কিনারা গুলোই deep dive:** score শুধু game server থেকে, `match_id` দিয়ে dedupe, composite score এ সমান score এর ক্রম, সপ্তাহ প্রতি key আর match এর শেষের সময় দিয়ে সপ্তাহ, prize এর আগে grace window
- **একই প্রশ্ন, উল্টো উত্তর:** বন্ধুদের leaderboard এ fan-out on read জেতে (৮.৫ লাখ write/s বাঁচে), news feed এ (11.4) বড় অংশে write — কারণ দুটোতেই খরচ কোন দিকে বেশি
- **Domain ছোট হলে histogram:** ~২ লাখ সম্ভাব্য score (~১.৬ MB এর array) মানে ১০০ কোটি player এর rank একটা ছোট array থেকে; sorted set শুধু উপরের দিকের জন্য

---

## ৪. নতুন Term (Glossary)

| Term                           | অর্থ                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sorted Set**                 | Redis এর score ধরে সাজানো set (skip list + hash table): যোগ/বদল আর rank দুটোই O(log N), range O(log N + k) — leaderboard এর তিনটা প্রশ্নের প্রতিটা এক command        |
| **Server-Authoritative Score** | Score আসে শুধু match চালানো আমাদের server থেকে, signed; client কখনো নিজের score পাঠায় না — cheating এর সবচেয়ে বড় পথ বন্ধ, বাকিটা সীমা আর async এর অনুসন্ধানে      |
| **Composite Score**            | কয়েকটা নিয়ম একটা সংখ্যায় গাঁথা (যেমন `points × 2²⁰ + বাকি সময়`), যাতে একটা সাধারণ সাজানোই সমান score এর ক্রমও মানে; অংশগুলো যেন একে অপরে উপচে না পড়ে, হিসাব করে |
| **Time-Bucketed Key**          | সময়ের প্রতিটা জানালার আলাদা key (`lb:2026-W41`) — reset মানে নতুন key তে লেখা, কিছু মোছা না; event যায় তার ঘটার সময়ের key তে, পৌঁছানোর সময়ের না                  |
| **Rank Histogram**             | প্রতিটা score এর মানে কতজন আছে তার গণনা; rank = উপরের সব ঘরের যোগফল — score এর domain ছোট হলে কোটি player এর নিখুঁত rank একটা ছোট array থেকে, বড় হলে আনুমানিক       |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. একই game এ একটা নতুন mode: "speedrun" — একটা level সবচেয়ে কম সময়ে শেষ করা, সময় millisecond এ, আর leaderboard এ প্রতি player এর **সবচেয়ে ভালো** সময়। (ক) এই lesson এর নকশার কোন কোন অংশ বদলায় (score এর দিক, `GT`, composite)? (খ) Rank histogram কি এখনও কাজ করে? কেন বা কেন না, আর না করলে কী করবেন?

2. Interviewer বলল: "Redis ছাড়া, শুধু Postgres দিয়ে করুন।" (ক) `SELECT COUNT(*) FROM weekly_totals WHERE week = $1 AND points > $2` এর খরচ index থাকা অবস্থায় কেন একজন নিচের দিকের player এর জন্য খারাপ (5.4)? (খ) Postgres এ থেকেই "আমার rank" দ্রুত করার দুটো উপায় বলুন, প্রতিটার দাম সহ।

3. এক candidate এর follow-up ৬ এর উত্তর: _"দশ গুণ হলে Redis Cluster ব্যবহার করব, ও নিজেই data ভাগ করে নেয়, তাই কিছু বদলাতে হবে না।"_ (ক) Technical গভীরতার মাত্রায় এটাকে ১-৪ এর কত দেবেন, আর কেন? (খ) এই উত্তরের কোন অনুমানটা ভুল? (Hint: একটা sorted set একটা key।) (গ) এক বাক্যে কীভাবে এটাকে ৩ বা ৪ এর উত্তর বানানো যায়?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) **দিক:** কম সময় ভালো, তাই হয় score কে উল্টে রাখুন (`ZRANK` দিয়ে ছোট থেকে বড়), নয়তো `−time` রাখুন; দুটোই চলে, শুধু একটা নিয়ম বেছে লিখে রাখুন। **`GT` এর জায়গায় `LT`:** "সবচেয়ে ভালো" মানে শুধু তখনই বদলান যখন নতুন সময় **কম** (Redis এ `ZADD ... LT`), আর এটাও idempotent, কারণ একই সময় দুবার এলে কিছু বদলায় না। **মোট না, সর্বোচ্চ/সর্বনিম্ন:** `weekly_totals` এর জায়গায় `best_times`, আর update এর নিয়ম `LEAST(old, new)`; একই result দুবার আসা এখন নিজে থেকেই নিরাপদ (min idempotent), যদিও `match_id` এর dedupe audit এর জন্য রাখুন। **Composite:** সমান সময় millisecond এ বিরল কিন্তু সম্ভব; আগে পৌঁছানোর নিয়মটা একই কৌশলে, কিন্তু এখন সময়ের অংশ এর দিক উল্টো (ছোট score ভালো, তাই আগে পৌঁছানো মানে ছোট যোগ), আর range এর হিসাব আবার করতে হবে যাতে ২⁵³ এর নিচে থাকে।

(খ) Domain এখন বড়: millisecond এ সময়, ধরুন ১০ সেকেন্ড থেকে ১০ মিনিট, মানে লাখ লাখ সম্ভাব্য মান, আর বেশিরভাগ ঘর খালি। নিখুঁত histogram এর array বড় হয় (লাখ খানেক integer — আসলে তবুও memory তে ছোট, তাই বড় সমস্যা না), কিন্তু আরেকটা সমস্যা: সময় একটা ধারাবাহিক মান, তাই "সমান score" প্রায় নেই, আর histogram এর একটা ঘর মানে একটা নির্দিষ্ট millisecond। ব্যবহারিক উত্তর: বালতি (যেমন ১০ ms এর), উপরের দিকের (prize, উপরের ১০০০) জন্য sorted set এ নিখুঁত rank, আর নিচে বালতি থেকে আনুমানিক rank বা "উপরের X%"। আর জোরে বলা যে নিচের দিকের rank এখন আনুমানিক, আর কেন সেটা চলে (কেউ #৩৪,১২,০৯৮ আর #৩৪,১২,৩১০ এর পার্থক্য খোঁজে না)।

**প্রশ্ন ২:**

(ক) `(week, points)` এর একটা B-tree index থাকলেও `COUNT(*) WHERE points > $2` কে index এর ওই অংশের প্রতিটা entry হেঁটে গুনতে হয়, কারণ সাধারণ B-tree এর node নিজের নিচে কতগুলো entry আছে সেটা রাখে না (5.4)। খরচ O(rank): উপরের ১০০ এর একজনের জন্য দ্রুত, কিন্তু ১০ কোটির মধ্যে মাঝের একজনের জন্য ৫ কোটি entry, প্রতিবার, সেকেন্ডে হাজার হাজার বার। সাথে প্রতিটা match এর পরে index এর update।

(খ) (১) **নিয়মিত হিসাব করা rank:** প্রতি মিনিটে একটা job সবার rank হিসাব করে একটা table এ লেখে (`ROW_NUMBER() OVER (ORDER BY points DESC, reached_at)`), আর "আমার rank" একটা primary key lookup। দাম: rank এক মিনিট পুরনো, আর প্রতি মিনিটে ১০ কোটি row এর একটা ভারী sort আর লেখা। (২) **Histogram table:** `score_counts(week, points, count)`, প্রতিটা update এ পুরনো score এর ঘর −১ আর নতুনটায় +১, একই transaction এ; rank = `SUM(count) WHERE points > mine` — শুধু যেসব score এ অন্তত একজন আছে তাদের row, কয়েক হাজার থেকে বড়জোর ~২ লাখ, দ্রুত। দাম: প্রতিটা update এ দুটো বাড়তি লেখা, আর জনপ্রিয় score এর ঘরগুলো hot row (5.5 এর lock এর লাইন; 11.7 এর গরম account এর মতো) — সেগুলো ভাগ করতে হতে পারে (11.2 এর key splitting)। আর সমান score এর ভেতরের ক্রম এখানে নেই।

**প্রশ্ন ৩:**

(ক) **১, বড়জোর ২।** একটা যন্ত্রের নাম আছে, কোনো সংখ্যা নেই, কোনো mechanism নেই, আর "কিছু বদলাতে হবে না" একটা দাবি যা যাচাই করা হয়নি (12.1 এর ভুল ৪ আর ৯)।

(খ) Redis Cluster data ভাগ করে **key** ধরে: প্রতিটা key একটা hash slot এ, আর একটা slot একটা node এ। একটা sorted set একটা key, তাই `lb:2026-W41` এর পুরো ১০০ কোটি member — ~১০০ GB আর সব write আর read — একটা node এ থাকে। Cluster এখানে কিছুই ভাগ করে না। ভাগ করতে হলে key টাকেই ভাগ করতে হয় (`lb:2026-W41:shard-07`), আর তখন rank এর scatter-gather আর উপরের ১০০ এর merge নিজেকে লিখতে হয়।

(গ) _"Redis Cluster key ধরে ভাগ করে, আর একটা leaderboard একটা key, তাই আমি user ধরে key টা ২০ ভাগে ভাঙব; আমার rank হবে ২০টা shard এ `ZCOUNT` এর যোগ, উপরের ১০০ হবে ২০টা তালিকার merge, ১ সেকেন্ডের cache সহ।"_ — একটা mechanism, একটা সংখ্যা, আর ভুল অনুমানটা নিজেই ধরা।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise** (mock interview; code নেই। Deliverable হলো recording, rubric এর score, ভুলের checklist, আর নিজের লেখা feedback)

> **Task:**
>
> 1. **Mock টা করুন,** ১.১ এর নিয়মে, ৪৫ মিনিট, জোরে, recording সহ। ১.৪ বা ১.৫ পড়ার আগে।
> 2. **Score করুন,** পরের দিন recording শুনে: পাঁচটা মাত্রায় ১-৪, প্রতিটার পাশে `mm:ss`; দশটা ভুলের checklist, প্রতিটায় হ্যাঁ/না আর `mm:ss`।
> 3. **ঘড়ির হিসাব:** প্রতিটা ধাপ আসলে কত মিনিট, time box এর পাশে। কোন follow-up এর বিষয় আপনি আগেই নিজে তুলেছিলেন? সেগুলো আলাদা করে লিখুন।
> 4. **Feedback লিখুন,** ১.৬ এর নিয়মে, তৃতীয় পুরুষে: তিনটা শক্তি, তিনটা উন্নতি, একটা সিদ্ধান্ত।
> 5. **Model answer এর সাথে মেলান:** আপনার নকশা কোথায় আলাদা? প্রতিটা পার্থক্যের জন্য: এটা কি একটা ভিন্ন কিন্তু যুক্তিসঙ্গত পথ (তাহলে কারণটা লিখুন), নাকি একটা ফাঁক?
> 6. **সবচেয়ে দুর্বল deep dive টা আবার:** যে follow-up এ সবচেয়ে খারাপ করেছেন, শুধু সেটা আবার, ৫ মিনিট, recording সহ। আগের আর নতুন উত্তরের পার্থক্য এক লাইনে।
>
> **যদি একজন বন্ধু পান:** এই lesson এর ১.২ আর ১.৩ বন্ধুকে দিন, সে interviewer হবে: আপনার প্রশ্নের উত্তর টেবিল থেকে দেবে, follow-up তার মিনিটে জিজ্ঞেস করবে, আর মাঝে মাঝে "কেন?" বলবে। একা করার চেয়ে এটা অনেক কাছাকাছি, কারণ একজন মানুষের সামনে নীরবতা অনেক বেশি অস্বস্তিকর — আর বাস্তবেও তাই।

পুরো score, checklist, ঘড়ির হিসাব আর feedback পাঠান। আমি দেখব আপনার নম্বর গুলো প্রমাণের সাথে মেলে কিনা (নিজেকে score দেওয়ার সময় মানুষ সাধারণত যোগাযোগে নরম আর গভীরতায় কড়া হয়, বা উল্টো), আর 12.4 এর আগে কোন দুটো জিনিস বদলাতে হবে।

**সৎ নোট:** Interviewer এর উত্তরের টেবিল, follow-up এর ক্রম আর মিনিট, আর rubric এর নোঙর আমার বানানো, এই প্রশ্নের জন্য; আসল interview এ প্রশ্ন আর follow-up interviewer ভেদে আলাদা। Model answer এর সংখ্যাগুলো interview এর মতো মাথায় করা আন্দাজ, মাপা না: Redis এ প্রতি entry ~১০০ byte আর একটা node এ পরিকল্পনার ~৫০,০০০ op/s ধরে নেওয়া (11.2 এর একই ধরে নেওয়া), আর rebuild এর "কয়েক মিনিট" যাচাই করা না। `ZADD GT/LT` আর `ZMSCORE` Redis 6.2 থেকে আছে; পুরনো version এ একটা Lua script লাগবে। Hiring এর সিদ্ধান্ত নিয়ে কথাগুলো সাধারণ পর্যবেক্ষণ, কোনো কোম্পানির নিয়ম না।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 11 (সম্পূর্ণ, exit challenge সহ), 12.1, 12.2
Current: 12.3 — Mock Interview #1 (game leaderboard)
TaskFlow state: Module 10 এর শেষ অবস্থায় (আজ পাশে)।
Mock #1 — সাপ্তাহিক global leaderboard: ৫ কোটি DAU, সপ্তাহে ১০ কোটি player; peak ~১৭,০০০ score write/s, ~৩৫,০০০
view/s (~৭০,০০০ read op/s); Redis sorted set ~১০ GB → একটা primary + ২-৩ replica, sharding না। সত্যের উৎস log +
Postgres (match_results এ match_id dedupe, weekly_totals, batch এ লেখা); Redis এ `ZADD GT` (ZINCRBY না)। Score শুধু
game server থেকে, signed। সমান score: composite (points × 2²⁰ + বাকি সময়)। Reset: সপ্তাহ প্রতি key, match শেষের সময়
দিয়ে সপ্তাহ, prize এর আগে grace window। বন্ধু: fan-out on read (ZMSCORE) — write এ হলে ৮.৫ লাখ/s। ১০ গুণে user ধরে
shard + ZCOUNT scatter-gather (score range এ hot partition); score এর domain ছোট (সর্বোচ্চ ~২ লাখ integer) তাই rank histogram।
Redis হারালে weekly_totals থেকে rebuild, degraded mode।
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন; mock এর score এর সবচেয়ে কম দুটো মাত্রা আর checklist এর ভুল]
Next: 12.4 — Mock interview #2 (harder, follow-up সহ)
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **interview এ ঠিক উত্তরটা যথেষ্ট না; ঠিক উত্তরটা কেন, কোন সংখ্যায়, আর কোথায় সেটা ভেঙে যায় — এই তিনটাই board এ উঠতে হয়।** Sorted set প্রায় সবাই বলে। পার্থক্য তৈরি হয় তারপরে: ১০ GB আর ৯০,০০০ op/s থেকে "sharding না", Redis কে সত্যের উৎস না বানানো, `ZINCRBY` এর বদলে `ZADD GT`, আর ছোট domain দেখে histogram।

রেডি হলে `next` লিখুন — **Lesson 12.4: Mock interview #2।** একই কাঠামো, কিন্তু কঠিন: ৬০ মিনিট, একটা বড় system (একাধিক device এ file sync, Dropbox এর মতো), আর interviewer এবার মাঝপথে requirement বদলাবে। একটা follow-up আপনার আগের একটা সিদ্ধান্তকে ভুল প্রমাণ করবে, আর দেখা হবে আপনি সেটা মেনে নিয়ে নকশা বদলাতে পারেন কিনা, পুরোটা নতুন করে শুরু না করে। আজকের score এর সবচেয়ে কম দুটো মাত্রা সাথে নিয়ে আসুন: 12.4 এর শেষে দেখব সেগুলো নড়েছে কিনা।
