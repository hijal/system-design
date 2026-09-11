# Lesson 1.3 — Back-of-the-envelope Estimation

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.2):** System Design Framework এর ৫টা ধাপের মধ্যে **Deep Dive** ধাপে কোন অংশটা বেছে নেওয়া উচিত — কী criteria দিয়ে ঠিক করবে?

---

**Prerequisite:** Lesson 1.1, 1.2

**তুমি এই lesson শেষে পারবে:**

1. Interview বা design এর সময় মাথায় মাথায় (বা কাগজে) দ্রুত storage, traffic, আর bandwidth এর মোটামুটি হিসাব করতে পারবে।
2. কিছু common "reference number" (latency numbers, storage unit) মুখস্থ রাখতে পারবে, যেগুলো বারবার কাজে লাগবে।
3. একটা সংখ্যা calculate করার সময় কীভাবে reasonable simplifying assumption নিতে হয় — এবং সেই assumption গুলো জোরে বলে দেওয়ার habit গড়ে তুলবে।

**Tier:** 3 — Design Exercise (আজকের exercise pure calculation, কোনো code লাগবে না)

---

## ০. TaskFlow এখন কোথায়

গত lesson এ আমরা 5-step framework শিখেছি, আর তুমি লক্ষ্য করেছ — Step 2 (Estimation) আর Step 1 (Requirements) এর মধ্যে লাইনটা টানতে একটু সমস্যা হয়েছিল। আজকে ঠিক সেই Step 2 নিয়ে গভীরে যাব।

কল্পনা করো — তুমি TaskFlow এর "Search" feature এর জন্য architecture ঠিক করতে বসেছ (গত lesson এর exercise)। তোমার হাতে দুটো option:

1. সরাসরি PostgreSQL এ `LIKE` query চালানো
2. একটা আলাদা Elasticsearch cluster বসানো

কোনটা ঠিক? উত্তরটা নির্ভর করে — **কত task আছে, কত ঘন ঘন search হয়**। যদি TaskFlow এ মোট ১০,০০০ task থাকে আর দিনে ৫০ বার search হয় — option ১ ঠিকভাবে চলবে, Elasticsearch বসানো ওভারকিল। কিন্তু যদি ১ কোটি task থাকে, সেকেন্ডে ৫০০ বার search হয় — option ১ ভেঙে পড়বে।

**এই সংখ্যাটাই তোমাকে সিদ্ধান্ত নিতে সাহায্য করে — অনুমান দিয়ে না, হিসাব দিয়ে।** আজকে আমরা শিখব কীভাবে এই হিসাবটা দ্রুত, মোটামুটি নির্ভুলভাবে, মাথায় মাথায় করতে হয়।

---

## ১. Theory

### ১.১ কেন "মোটামুটি" যথেষ্ট — নিখুঁত হিসাবের দরকার নেই

Back-of-the-envelope মানেই হলো — একটা খামের পেছনে (বা napkin এ) দ্রুত লেখা একটা rough হিসাব, calculator ছাড়া, ৯৫% নিখুঁত হওয়ার দরকার নেই। উদ্দেশ্য হলো — **সঠিক মাত্রা (order of magnitude)** বোঝা। তুমি জানতে চাও system টা "হাজার" scale এ, নাকি "লাখ" scale এ, নাকি "কোটি" scale এ — কারণ সেটার ওপর নির্ভর করেই architecture এর ধরন সম্পূর্ণ বদলে যায়।

উদাহরণ — তুমি যদি হিসাব করে পাও storage লাগবে "৫০০ GB এর আশেপাশে", সেটা ৪৫০ হোক বা ৫৫০ হোক — কোনো পার্থক্য করে না architecture এর জন্য। কিন্তু "৫০০ GB" আর "৫০০ TB" এর পার্থক্য architecture সম্পূর্ণ বদলে দেয়। তাই এই ধাপে আমরা কখনো calculator খুঁজব না — round number নিয়ে কাজ করব (যেমন, ১০০০ ইউজার না বলে "প্রায় ১ হাজার", ৩৬৫ দিন না বলে "প্রায় ৩৬০")।

### ১.২ মুখস্থ রাখার মতো কিছু Base Number

**Power of 2 আর তাদের approximate value (storage এর জন্য):**

| Power | নাম             | মান                 |
| ----- | --------------- | ------------------- |
| 2^10  | 1 Kilobyte (KB) | ~১ হাজার bytes      |
| 2^20  | 1 Megabyte (MB) | ~১০ লাখ bytes       |
| 2^30  | 1 Gigabyte (GB) | ~১০০ কোটি bytes     |
| 2^40  | 1 Terabyte (TB) | ~১ লাখ কোটি bytes   |
| 2^50  | 1 Petabyte (PB) | ~১০ কোটি কোটি bytes |

মনে রাখার সহজ trick: প্রতি ১০ power বাড়লে, মান প্রায় **১০২৪ গুণ** বাড়ে (যেটাকে rough হিসাবে ১০০০ গুণ ধরে নিলেই চলে)।

**Time-related সংখ্যা যেগুলো বারবার লাগবে:**

| একক   | সেকেন্ডে                                               |
| ----- | ------------------------------------------------------ |
| ১ দিন | ~৮৬,৪০০ সেকেন্ড (রাউন্ড করে **~১,০০,০০০**)             |
| ১ মাস | ~২৬ লাখ সেকেন্ড                                        |
| ১ বছর | ~৩ কোটি ১৫ লাখ সেকেন্ড (রাউন্ড করে **~৩ কোটি ২০ লাখ**) |

"১ দিন = ~১,০০,০০০ সেকেন্ড" — এই একটা approximation তোমাকে অনেক হিসাব সহজ করে দেবে। (আসল সংখ্যা ৮৬,৪০০ — কিন্তু ১,০০,০০০ ধরে নিলে মাথায় মাথায় ভাগ করা অনেক সহজ, আর error মাত্র ~১৫%, যেটা এই ধরনের rough estimation এ acceptable।)

**Latency Numbers (কোন operation কত সময় নেয়, মোটামুটি):**

এই টেবিলটা তোমার জন্য বিশেষভাবে গুরুত্বপূর্ণ, কারণ পরের modules (Caching, Database) এ এই numbers বারবার প্রসঙ্গ আসবে।

| Operation                                   | মোটামুটি সময়      |
| ------------------------------------------- | ------------------ |
| Memory (RAM) থেকে read                      | ~১০০ nanosecond    |
| Redis/in-memory cache থেকে read             | ~০.৫-১ millisecond |
| SSD থেকে random read                        | ~০.১ millisecond   |
| একই data center এর ভেতরে network round trip | ~০.৫ millisecond   |
| PostgreSQL এ একটা indexed query             | ~১-১০ millisecond  |
| ভিন্ন মহাদেশে network round trip            | ~১৫০ millisecond   |

**এই টেবিল থেকে সবচেয়ে গুরুত্বপূর্ণ takeaway:** Memory read আর Disk read এর মধ্যে পার্থক্য প্রায় **হাজার গুণ**। এটাই মূল কারণ কেন caching (Module 4) এত গুরুত্বপূর্ণ একটা concept — একই data বারবার disk থেকে না পড়ে memory থেকে পড়লে, হাজার গুণ দ্রুত হয়।

### ১.৩ Estimation এর সাধারণ Process

একটা সংখ্যা বের করতে গেলে, সাধারণত এই ধাপগুলো অনুসরণ করা হয়:

```
১. মোট ইউজার (Total Users)
        │
        ▼
২. Daily Active User (DAU) — সবাই তো রোজ ব্যবহার করে না
        │
        ▼
৩. প্রতি ইউজার কত বার নির্দিষ্ট action করে (per day)
        │
        ▼
৪. মোট action/day  →  সেকেন্ডে কত request (QPS)
        │
        ▼
৫. প্রতি action এ কত data — মোট storage/bandwidth
```

চলো TaskFlow দিয়ে একটা concrete উদাহরণ দেখি।

**উদাহরণ: TaskFlow এর Notification feature এর জন্য QPS বের করা**

ধরো, client বলেছে — "১০ লাখ (১ মিলিয়ন) registered user টার্গেট।"

**ধাপ ১ — DAU বের করা:** সব registered user রোজ app খোলে না। Industry rough assumption — DAU সাধারণত total user এর ১০-২০% হয় (এটা product-ভেদে অনেক আলাদা হতে পারে, কিন্তু interview এ এই assumption বলে দিলেই যথেষ্ট)। ধরি ২০%।

→ DAU = ১০ লাখ × ২০% = **২ লাখ**

**ধাপ ২ — প্রতি ইউজার কতবার action করে:** ধরি, একজন active ইউজার গড়ে দিনে ৫টা task assign করে (মানে ৫টা notification generate করে)।

→ মোট notification/day = ২ লাখ × ৫ = **১০ লাখ notification/day**

**ধাপ ৩ — এটাকে QPS এ রূপান্তর:** এখানেই সেই "১ দিন ≈ ১,০০,০০০ সেকেন্ড" approximation কাজে লাগে:

→ QPS = ১০ লাখ ÷ ১,০০,০০০ = **~১০ notification/সেকেন্ড (average)**

**ধাপ ৪ — Peak QPS:** এটা average। কিন্তু traffic সারাদিন সমান থাকে না — office hour এ বেশি, রাতে কম। একটা common rule of thumb: **Peak QPS ≈ Average QPS এর ২-৩ গুণ**।

→ Peak QPS = ~১০ × ৩ = **~৩০ notification/সেকেন্ড**

এই "~৩০ notification/সেকেন্ড" সংখ্যাটাই এখন তোমাকে বলে দেয় — এটা কি এতটাই ছোট যে একটা single Express server handle করতে পারবে (হ্যাঁ, পারবে — এটা খুবই ছোট সংখ্যা), নাকি এর জন্য আলাদা queue/scaling দরকার (এই সংখ্যায় না, কিন্তু যদি এটা ৩০,০০০ হতো, তখন দরকার হতো)।

**Storage হিসাবের উদাহরণ:**

ধরো প্রতিটা notification record এ থাকে — id, message text, timestamp, user_id, read/unread flag। মোটামুটি ধরা যায় প্রতিটা record ~২০০ bytes (এই সংখ্যাটাও rough guess, নিখুঁত হওয়ার দরকার নেই)।

→ দৈনিক storage = ১০ লাখ notification × ২০০ bytes = ২০ কোটি bytes = **~২০০ MB/day**

→ বছরে storage = ২০০ MB × ৩৬৫ ≈ **~৭৩ GB/year**

এই সংখ্যাটা দেখে তুমি বুঝতে পারো — এটা এমন কোনো বিশাল storage সমস্যা না যে আজকেই sharding নিয়ে ভাবতে হবে (Module 5.8 তে আমরা দেখব কখন sharding সত্যিই দরকার হয়)। কিন্তু যদি হিসাব করে পেতে "৭৩ PB/year", তখন Day 1 থেকেই storage strategy আলাদাভাবে ভাবতে হতো।

> **Trade-off/Insight Table — Estimation না করলে কী ভুল হয়**

| পরিস্থিতি                                  | Estimation ছাড়া                           | Estimation সহ                                                        |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| ছোট scale কে বড় architecture দিয়ে বানানো | সম্ভাবনা বেশি (ভয় থেকে over-engineer করা) | Number দেখে বোঝা যায় simple architecture যথেষ্ট                     |
| বড় scale কে ছোট architecture দিয়ে বানানো | সম্ভাবনা বেশি (guess ভুল হলে)              | আগে থেকেই বোঝা যায় sharding/queue লাগবে                             |
| Interview এ                                | "মনে হয় স্কেল করবে" — vague, unconvincing | "সেকেন্ডে ৩০টা request, single server যথেষ্ট" — concrete, convincing |

---

## ২. Interview Angle

Estimation ধাপ interview এ প্রায়ই সবচেয়ে বেশি ভয়ের কারণ হয়, কারণ candidate রা ভাবে "নিখুঁত সংখ্যা বলতে হবে, নাহলে ভুল হয়ে যাবে"। কিন্তু বাস্তবে interviewer **নিখুঁত সংখ্যা দেখে না** — সে দেখে:

1. তুমি কি reasonable assumption নিতে পারছ (আর সেটা জোরে বলছ)?
2. তুমি কি সংখ্যাটা দিয়ে **পরের সিদ্ধান্তে** ব্যবহার করতে পারছ (শুধু হিসাব করেই থেমে না গিয়ে)?
3. তুমি কি দ্রুত, confidently কাজ করছ, নাকি প্রতিটা ধাপে আটকে যাচ্ছ?

একটা common pattern যেটা confident দেখায়: প্রতিটা assumption নেওয়ার সময় জোরে বলে দাও — _"আমি ধরে নিচ্ছি DAU টোটাল ইউজারের ২০%, এটা একটা industry-common ballpark, তোমাদের actual product এ ভিন্ন হতে পারে।"_ এতে interviewer বোঝে তুমি জানো এটা একটা **assumption**, fact না — এবং প্রয়োজনে তারা তোমাকে correct করতে পারবে ("আসলে আমাদের DAU ৫০%")।

আরেকটা জিনিস — estimation থেকে বের হওয়া সংখ্যাটা **অবশ্যই পরের ধাপে ব্যবহার করতে হবে**। শুধু "QPS = ৩০" বলে থেমে গেলে চলবে না — বলতে হবে "যেহেতু QPS মাত্র ৩০, তাই single server-ই যথেষ্ট, load balancer এখনই লাগবে না" — এটাই estimation কে _actionable_ করে তোলে, শুধু একটা exercise না রেখে।

---

## ৩. Key Takeaway

- Back-of-the-envelope estimation এর লক্ষ্য নিখুঁততা না, **সঠিক মাত্রা (order of magnitude)** বোঝা
- Round number ব্যবহার করো — ১ দিন ≈ ১,০০,০০০ সেকেন্ড, এটা মাথায় মাথায় হিসাব সহজ করে
- Memory vs Disk read এর মধ্যে পার্থক্য প্রায় ১০০০ গুণ — এটাই caching এর গুরুত্বের মূল কারণ
- সাধারণ estimation flow: Total Users → DAU → per-user action → total action/day → QPS (average) → Peak QPS (২-৩ গুণ average)
- প্রতিটা assumption জোরে বলে দাও — এটা interview তে "guess" কে "reasoned estimate" এ রূপান্তর করে
- Estimation থেকে বের হওয়া সংখ্যা অবশ্যই architecture decision এ ব্যবহার করতে হবে — শুধু হিসাব করে থেমে গেলে চলবে না

---

## ৪. নতুন Term (Glossary)

| Term                         | অর্থ                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| **DAU (Daily Active User)**  | মোট registered user এর মধ্যে যারা একটা নির্দিষ্ট দিনে সত্যিই app ব্যবহার করে         |
| **QPS (Queries Per Second)** | সেকেন্ডে system এ কতগুলো request/query আসে                                           |
| **Peak QPS**                 | দিনের সবচেয়ে ব্যস্ত সময়ে QPS, যেটা সাধারণত average QPS এর কয়েকগুণ বেশি হয়        |
| **Order of Magnitude**       | একটা সংখ্যা মোটামুটি কোন range এ পড়ে (হাজার, লাখ, কোটি) — নিখুঁত মান না             |
| **Bandwidth**                | একটা নির্দিষ্ট সময়ে কত পরিমাণ ডেটা transfer হচ্ছে (সাধারণত bytes/second এ মাপা হয়) |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর নিচের Answer Key দেখো।

1. যদি Memory read নেয় ~১০০ nanosecond, আর SSD read নেয় ~০.১ millisecond — তাহলে SSD, memory এর চেয়ে **কতগুণ ধীর**? (হিসাব করে দেখাও)
2. TaskFlow এর file attachment feature এ (Lesson 1.1 এর exercise থেকে মনে আছে?) — যদি DAU হয় ৫০,০০০, আর প্রতি active user দিনে গড়ে ২টা file upload করে, প্রতিটা ফাইল গড়ে ৫ MB — তাহলে দৈনিক storage বৃদ্ধি কত হবে (মোটামুটি, GB এ)?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** ১০০ nanosecond = ০.০০০১ millisecond। SSD নেয় ০.১ millisecond। তাহলে SSD, memory এর চেয়ে ০.১ ÷ ০.০০০১ = **১০০০ গুণ ধীর**। এটাই সেই "memory vs disk = ~1000x" rule যেটা lesson এ বলা হয়েছে।

**প্রশ্ন ২:** দৈনিক upload সংখ্যা = ৫০,০০০ × ২ = ১ লাখ ফাইল। প্রতিটা ৫ MB হলে, মোট = ১ লাখ × ৫ MB = ৫ লাখ MB = **৫০০ GB/day** (যেহেতু ১০০০ MB ≈ ১ GB)। এই সংখ্যা দেখে বোঝা যায়, বছরে এটা প্রায় ~১৮০ TB এ পৌঁছাবে, যেটা নিশ্চিতভাবে single-server local storage তে রাখার মতো না — এখানে S3-এর মতো object storage (Module 8.1) দরকার হবে, এবং এই estimation-ই সেই সিদ্ধান্তকে justify করে।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

এবার তোমার পালা। নিচের scenario এর জন্য পুরো estimation chain টা করো — প্রতিটা ধাপ দেখিয়ে (assumption সহ)।

> **Scenario:** TaskFlow এ একটা নতুন feature আসছে — "**Activity Log**": প্রতিবার কোনো task তৈরি, update, বা delete হলে, একটা log entry তৈরি হবে (কে করল, কখন করল, কী করল)।
>
> ধরে নাও:
>
> - Total registered user: ৫ লাখ
> - DAU assumption তুমি নিজে ঠিক করো (আর কেন সেটা বলো)
> - প্রতি active user গড়ে দিনে কতগুলো task action (create/update/delete মিলিয়ে) করে, সেটাও তুমি একটা reasonable সংখ্যা ধরে নাও
>
> হিসাব করো:
>
> 1. দৈনিক মোট log entry কত হবে?
> 2. Average QPS কত (log write এর জন্য)?
> 3. Peak QPS কত (২-৩ গুণ rule ব্যবহার করে)?
> 4. প্রতিটা log entry যদি গড়ে ৩০০ bytes হয়, দৈনিক storage বৃদ্ধি কত (MB/GB এ)?
> 5. এই সংখ্যাগুলো দেখে তোমার কী মনে হয় — এই write load একটা single PostgreSQL instance handle করতে পারবে, নাকি আলাদা কিছু (queue, batch write) দরকার হতে পারে? এক লাইনে reasoning দাও।

প্রতিটা ধাপে তোমার assumption স্পষ্টভাবে লেখো — এটাই সবচেয়ে গুরুত্বপূর্ণ অংশ, শুধু চূড়ান্ত সংখ্যা না।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2
Current: 1.3 — Back-of-the-envelope Estimation
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth
Weak spots: Functional/Non-functional এ solution/constraint গুলিয়ে ফেলা (উন্নতি হচ্ছে);
HLD তে UI-state কে component হিসেবে দেখানো (Lesson 1.2 এর exercise এ হয়েছিল) — নজরে রাখতে হবে
Next: 1.4 — Client-Server, HTTP/HTTPS, connection lifecycle, keep-alive, HTTP/2 vs HTTP/3
=======================
```

---

## ৮. পরের Lesson

Exercise করে পাঠাও — বিশেষভাবে দেখব তুমি assumption গুলো স্পষ্টভাবে বলছ কিনা, আর শেষ প্রশ্নে (#৫) সংখ্যা থেকে সিদ্ধান্তে পৌঁছাতে পারছ কিনা। রেডি হলে `next` লিখো — Lesson 1.4 তে যাব, যেখানে আমরা client-server communication এর একদম ভেতরে ঢুকব: HTTP কীভাবে কাজ করে, connection lifecycle কী, আর কেন HTTP/2 বা HTTP/3 এর মতো নতুন version এসেছে।
