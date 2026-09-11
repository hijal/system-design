# Lesson 1.2 — The Design Framework

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.1):** System Design প্রশ্নের উত্তর আর Coding প্রশ্নের উত্তরের মধ্যে মূল পার্থক্যটা কী ছিল? (এক লাইনে বলো)

---

**Prerequisite:** Lesson 1.1

**তুমি এই lesson শেষে পারবে:**

1. যেকোনো system design প্রশ্ন এলে, একটা নির্দিষ্ট ৫-ধাপের কাঠামো অনুসরণ করে এগোতে পারবে, এলোমেলোভাবে architecture আঁকা শুরু করবে না।
2. "Scope" ঠিক করা কেন সবচেয়ে গুরুত্বপূর্ণ প্রথম পদক্ষেপ, এবং scope না ঠিক করলে কী ভুল হয় — বুঝবে।
3. একটা design কে "শেষ" ঘোষণা করার আগে trade-off আলোচনা কেন বাধ্যতামূলক — ব্যাখ্যা করতে পারবে।

**Tier:** 3 — Design Exercise (আজকেও কোনো code নেই; এই framework টাই আগে হাড়ে-মজ্জায় বসতে হবে, তারপর Module 1.4 থেকে code-সংশ্লিষ্ট বিষয় শুরু হবে)

---

## ০. TaskFlow এখন কোথায়

গত দুই lesson এ আমরা TaskFlow এর দুইটা আলাদা feature request নিয়ে খেলেছি — real-time notification, আর file attachment। প্রতিবারই আমরা প্রথমে functional আর non-functional requirement আলাদা করেছি। কিন্তু লক্ষ্য করেছ কি — প্রতিবার এটা কেমন একটু **এলোমেলোভাবে** হয়েছে? কখনো আমি সরাসরি স্ক্যানারিও চাইনি, তুমি নিজে থেকেই list বানিয়েছ। বাস্তব ইন্টারভিউতে বা বাস্তব কাজেও এইভাবে "মনে যা আসে লিখে ফেলা" চলে না — কারণ তখন কিছু জিনিস বাদ পড়ে যায়, কিছু জিনিস অপ্রয়োজনীয়ভাবে বেশি detail এ চলে যায়।

আজকে আমরা সেই এলোমেলো process টাকে একটা **নির্দিষ্ট, পুনরাবৃত্তিযোগ্য কাঠামোয়** (framework) বেঁধে ফেলব। এই কাঠামোটাই এই পুরো course এর মেরুদণ্ড — Module 11 এর প্রতিটা case study (URL shortener, Chat system, ইত্যাদি), এবং Module 12 এর mock interview — সবকিছু এই একই ৫-ধাপের কাঠামো দিয়েই এগোবে। আজকে এটা একবার ভালোভাবে বুঝে নিলে, বাকি পুরো course জুড়ে তুমি জানবে "আমি এখন কোন ধাপে আছি"।

---

## ১. Theory

### ১.১ কেন একটা Framework দরকার

চিন্তা করো — একজন doctor যখন একজন patient কে দেখে, সে কি সরাসরি "তোমার এই ওষুধ লাগবে" বলে দেয়? না। সে প্রথমে symptom জিজ্ঞেস করে, history নেয়, পরীক্ষা করে, তারপর diagnosis করে, তারপর treatment বলে। এই ধাপগুলো এলোমেলো করলে ভুল treatment হওয়ার সম্ভাবনা বহুগুণ বেড়ে যায়।

System design ঠিক একই রকম। একটা architecture সরাসরি আঁকা শুরু করা মানে "symptom না শুনেই ওষুধ লেখা"। এই কারণেই একটা framework দরকার — যাতে প্রতিবার, প্রতিটা system এর জন্য, তুমি একই disciplined process অনুসরণ করো, আর কোনো গুরুত্বপূর্ণ ধাপ বাদ না পড়ে।

### ১.২ The 5-Step Framework

```
┌─────────────────────┐
│ 1. Requirements     │  কী বানাবো, কেমন বানাবো — স্কোপ ঠিক করা
│    Gathering        │
└──────────┬──────────┘
           │
┌──────────▼───────────┐
│ 2. Capacity          │  সংখ্যায় হিসাব — কত ইউজার, কত ডেটা, কত ট্রাফিক
│    Estimation        │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ 3. High-Level Design │  বড় বড় বক্স আর তীর — client, server, DB, cache...
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ 4. Deep Dive         │  ১-২টা critical অংশ নিয়ে গভীরে যাওয়া
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ 5. Trade-off &       │  কী ছাড় দিলাম, ভবিষ্যতে কী ভাঙতে পারে
│    Wrap-up           │
└──────────────────────┘
```

চলো প্রতিটা ধাপ এক এক করে বুঝি।

### Step 1 — Requirements Gathering

এটাই সেই কাজ যেটা আমরা গত দুই lesson এ করেছি — functional আর non-functional requirement বের করা। কিন্তু এখানে একটা নতুন জিনিস যোগ হবে: **Scope ঠিক করা**।

বাস্তব system (এমনকি TaskFlow এর মতো কাল্পনিক ছোট app ও) এ কোটি কোটি feature থাকতে পারে। ৪৫ মিনিটের interview এ (বা বাস্তব sprint planning এ) তুমি সবকিছু design করতে পারবে না। তাই প্রথম কাজ হলো — **কোনটা আজকে design করব, কোনটা বাদ দেব**, সেটা স্পষ্টভাবে বলে দেওয়া।

যেমন, TaskFlow notification feature এর জন্য তুমি বলতে পারো:

> "আজকে আমরা শুধু 'task assign হলে notification' এই flow টা design করব। Email digest, notification preference settings — এগুলো আজকের scope এর বাইরে।"

এই এক লাইন বলাটাই তোমাকে বাকি ৪৪ মিনিট **focused** রাখবে। Scope না বলে শুরু করলে, মাঝপথে গিয়ে বুঝবে সময় শেষ কিন্তু মূল সমস্যাই স্পর্শ করোনি।

> **Interview এ common trap:** Interviewer প্রায়ই ইচ্ছাকৃতভাবে একটা vague প্রশ্ন দেয় ("Design Twitter")। যারা খারাপ করে, তারা সাথে সাথে design শুরু করে দেয়। যারা ভালো করে, তারা প্রথমে scope narrow করে নেয় — "Twitter অনেক বড় জিনিস, আমরা কি শুধু 'tweet post করা আর timeline দেখা' এই core flow টা নিয়ে ফোকাস করব?" — এটা বলা মানে ইন্টারভিউয়ারকে বলা "আমি জানি scope এর গুরুত্ব"।

### Step 2 — Capacity Estimation (Back-of-the-envelope)

Requirement ঠিক হওয়ার পর প্রশ্ন আসে — **সংখ্যাটা আসলে কত বড়?** ১০০ ইউজার আর ১ কোটি ইউজারের জন্য architecture সম্পূর্ণ ভিন্ন হবে। তাই মোটামুটি হিসাব করে নিতে হয়:

- কতজন ইউজার (daily active)?
- সেকেন্ডে কতগুলো request?
- কত ডেটা store হবে, দিনে/বছরে?

এই ধাপটার নিজস্ব একটা পুরো lesson আছে (1.3, একদম পরের lesson) — কারণ এটা একটা skill যেটা practice করতে হয়। আজকে শুধু এইটুকু জেনে রাখো — **Step 1 এর পরে, architecture আঁকার আগে, একবার সংখ্যাগুলো মোটামুটি আন্দাজ করে নেওয়া হয়।** এই সংখ্যাগুলোই পরের ধাপে তোমার সিদ্ধান্তকে (একটা সার্ভার লাগবে না দশটা, cache লাগবে কিনা) নিয়ন্ত্রণ করবে।

### Step 3 — High-Level Design

এখন আসে সেই ছবি আঁকার পালা — client, server, database, এবং তাদের মধ্যেকার তীর। এই ধাপে **detail এ যাওয়া নিষেধ**। উদ্দেশ্য হলো — পুরো system এর একটা "bird's eye view" দাঁড় করানো, যেটা Step 1 এর requirement গুলোকে satisfy করে।

TaskFlow notification এর জন্য একটা খুবই basic high-level design এমন দেখতে হতে পারে:

```
[Client (SvelteKit)] <---> [Express API Server] <---> [PostgreSQL]
                                    │
                                    ▼
                          [Notification Service]
                                    │
                                    ▼
                          [Client-এ কীভাবে পৌঁছাবে?]
```

লক্ষ্য করো — শেষ বক্সটা এখনো একটা প্রশ্নবোধক চিহ্ন হয়ে আছে। এটাই ঠিক আছে এই ধাপে — এখনো আমরা জানি না WebSocket ব্যবহার করব নাকি polling, সেটা পরের ধাপে ঠিক হবে।

### Step 4 — Deep Dive

High-level design এ পুরো system এর একটা কাঠামো তৈরি হলো, কিন্তু এখনো বেশিরভাগ বক্স "black box"। এই ধাপে তুমি (বা interviewer) বেছে নেয় **১-২টা সবচেয়ে গুরুত্বপূর্ণ/জটিল অংশ**, আর সেটার ভেতরে ঢুকে বিস্তারিত design করে।

TaskFlow এর ক্ষেত্রে, Deep Dive হতে পারে ঠিক সেই প্রশ্নবোধক বক্সটা — "Client কীভাবে real-time notification পাবে?" এখানে এসে তুমি WebSocket vs Server-Sent Events vs Polling নিয়ে আলোচনা করবে, প্রতিটার trade-off বলবে, একটা বেছে নেবে।

**গুরুত্বপূর্ণ:** সবকিছুতে সমান গভীরতায় যাওয়া সম্ভব না, দরকারও না। তুমি বেছে নাও — কোন অংশটা সবচেয়ে বেশি "risky" বা "interesting" বা "যেখানে সবচেয়ে বেশি trade-off আছে"। বাকি অংশ high-level এই থেকে যাবে, আর সেটাই ঠিক আছে।

### Step 5 — Trade-off & Wrap-up

শেষ ধাপে তুমি ফিরে আসো এবং সততার সাথে বলো:

- এই design এর দুর্বলতা কোথায়?
- কোন জায়গায় ভবিষ্যতে সমস্যা হতে পারে (যেমন, ইউজার আরও বাড়লে)?
- কোন বিকল্প ছিল যেটা বেছে নাওনি, আর কেন নাওনি?

এই ধাপটা প্রায়ই বাদ পড়ে যায় সময়ের অভাবে, কিন্তু এটা **সবচেয়ে বেশি senior thinking দেখায়**। কারণ, একজন junior engineer একটা design দেয় আর ভাবে "কাজ শেষ"। একজন senior engineer জানে — **কোনো design perfect না**, আর সেটা explicitly বলতে পারাটাই দক্ষতার লক্ষণ।

> **Trade-off Table — এই ৫ ধাপের প্রতিটা বাদ দিলে কী হারাও**

| ধাপ বাদ দিলে      | কী সমস্যা হয়                                                                      |
| ----------------- | ---------------------------------------------------------------------------------- |
| Requirements      | ভুল জিনিস design করে ফেলার ঝুঁকি — সময় নষ্ট                                       |
| Estimation        | Architecture ইউজার সংখ্যার সাথে না মেলা (over/under-engineered)                    |
| High-Level Design | সরাসরি detail এ ঢুকে বড় ছবি হারিয়ে ফেলা                                          |
| Deep Dive         | Design "shallow" থেকে যায়, আসল challenge address হয় না                           |
| Trade-off         | Design কে "perfect" দাবি করা — senior interviewer এখানেই সবচেয়ে বেশি সন্দিহান হয় |

---

## ২. Interview Angle

এই framework টা আসলে ইন্টারভিউয়ের **সময় ব্যবস্থাপনার টুলও**। একটা ৪৫ মিনিটের round কে মোটামুটি এভাবে ভাগ করা যায়:

- Requirements + Scope: ~৫-৭ মিনিট
- Estimation: ~৫ মিনিট
- High-Level Design: ~১০-১৫ মিনিট
- Deep Dive: ~১৫-২০ মিনিট
- Trade-off/Wrap-up: ~৫ মিনিট

সবচেয়ে common ভুল — candidate রা High-Level Design এ ২৫-৩০ মিনিট কাটিয়ে ফেলে (কারণ এটা করতে "মজা" লাগে, বক্স আঁকা সহজ), আর Deep Dive এর জন্য সময়ই বাঁচে না। অথচ **Deep Dive টাই আসল জায়গা যেখানে তোমার technical depth যাচাই হয়**। High-level design যেকেউ ইউটিউব দেখে মুখস্থ করতে পারে; deep dive এ গিয়ে trade-off আলোচনা করাটা মুখস্থ করা যায় না, ওখানেই আসল বোঝাপড়া ধরা পড়ে।

এই কারণেই আমরা curriculum এ Module 12.1 এ "common ১০টা ভুল" নিয়ে আলাদা lesson রেখেছি — কিন্তু এখনই একটা মনে রাখো: **এই ৫ ধাপ শুধু জানলেই হবে না, সময়ের হিসাবটাও practice করতে হবে।** Module 12 এর mock interview এ আমরা এটা সরাসরি practice করব timer সহ।

---

## ৩. Key Takeaway

- System Design এর যেকোনো প্রশ্নে একই ৫-ধাপ framework অনুসরণ করো: Requirements → Estimation → High-Level Design → Deep Dive → Trade-off
- Requirements ধাপে শুধু functional/non-functional আলাদা করাই না, **Scope** ঠিক করাও বাধ্যতামূলক — সবকিছু design করার চেষ্টা করলে সময় শেষ হয়ে যাবে, কিছুই ঠিকমতো হবে না
- Estimation তোমাকে বলে দেয় architecture কতটা "ভারী" হওয়া দরকার — সংখ্যা না জেনে architecture ঠিক করা অন্ধভাবে সিদ্ধান্ত নেওয়ার মতো
- High-Level Design এ detail এ যাওয়া নিষেধ — এটা শুধু বড় ছবি
- Deep Dive এ সবকিছুতে সমান গভীরতায় না গিয়ে, ১-২টা সবচেয়ে গুরুত্বপূর্ণ অংশ বেছে নিতে হয়
- Trade-off আলোচনা বাদ দেওয়া মানে design কে ভুলভাবে "perfect" দাবি করা — এটাই সবচেয়ে বেশি senior-level thinking দেখায়
- ইন্টারভিউতে সময় ভাগ করে রাখা জরুরি — সবচেয়ে বেশি সময় Deep Dive এ যাওয়া উচিত, শুধু High-Level Design এ না

---

## ৪. নতুন Term (Glossary)

| Term                                | অর্থ                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Scope**                           | কোন কোন feature/behavior আজকের design এর আওতায় থাকবে, আর কোনগুলো ইচ্ছাকৃতভাবে বাদ দেওয়া হচ্ছে |
| **Back-of-the-envelope Estimation** | খুব নিখুঁত না হয়েও, দ্রুত মোটামুটি সংখ্যায় হিসাব করা (ইউজার সংখ্যা, ডেটা সাইজ, ট্রাফিক)       |
| **High-Level Design**               | system এর প্রধান component গুলোর একটা সরলীকৃত, detail-বিহীন ছবি                                 |
| **Deep Dive**                       | high-level design এর একটা নির্দিষ্ট অংশ নিয়ে বিস্তারিত, গভীর আলোচনা                            |
| **Black Box**                       | একটা component যার ভেতরের কাজ এখনো নির্ধারিত না, শুধু input/output জানা আছে                     |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর নিচের Answer Key দেখো।

1. তুমি যদি Module 11 এ "Design a URL Shortener" করতে বসো, Step 1 (Requirements + Scope) এ তুমি কী কী জিনিস আজকের scope থেকে বাদ দিতে পারো বলে মনে করো (কমপক্ষে ২টা example দাও)?
2. Deep Dive ধাপে "কোন অংশটা বেছে নেব" — এই সিদ্ধান্ত কীভাবে নেওয়া উচিত বলে তোমার মনে হয়? কী দেখে বুঝবে কোনটা "deep dive করার যোগ্য"?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** URL Shortener এর scope থেকে বাদ দেওয়া যেতে পারে এমন কিছু জিনিস: custom alias (ইউজার নিজের পছন্দের short URL বেছে নেওয়া), analytics/click tracking, link expiration, user authentication/account system। মূল core flow টা হলো শুধু — "একটা লম্বা URL দিলে একটা ছোট URL পাওয়া, আর সেই ছোট URL এ ক্লিক করলে redirect হওয়া"। বাকিসব "nice to have" যেগুলো সময় থাকলে পরে যোগ করা যায়।

**প্রশ্ন ২:** সাধারণত যেটা বেছে নেওয়া উচিত তা হলো — যেখানে **সবচেয়ে বেশি trade-off/complexity/uncertainty** আছে, বা যেটা এই নির্দিষ্ট system কে "সহজ CRUD app" থেকে আলাদা করে তোলে। যেমন URL shortener এ, "unique short code কীভাবে generate করব যাতে collision না হয় আর scale করে" — এটাই deep dive এর যোগ্য জায়গা, কারণ এখানেই আসল ইঞ্জিনিয়ারিং challenge। "ডাটাবেসে save করব কীভাবে" — এটা deep dive এর যোগ্য না, কারণ সেটা trivial।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

এবার তোমাকে পুরো ৫-ধাপের framework টা একসাথে **প্রয়োগ** করতে হবে — শুধু Step 1 না, বরং সবগুলো ধাপের জন্য এক লাইন করে চিন্তা লিখতে হবে।

> **Task:** TaskFlow এর জন্য নতুন একটা feature — "**Search**: ইউজার সব task এর মধ্যে title/description দিয়ে সার্চ করতে পারবে"।
>
> এই feature টার জন্য ৫টা ধাপের প্রতিটায় ১-২ লাইন করে লেখো:
>
> 1. **Requirements + Scope** — কী কী functional/non-functional চাই, আর কী আজকের scope এর বাইরে রাখবে
> 2. **Estimation** — মোটামুটি কী কী সংখ্যা জানতে চাইবে (নিখুঁত হিসাব করতে হবে না, শুধু "কী কী প্রশ্ন করব" লিখো)
> 3. **High-Level Design** — খুব simple একটা ASCII ছবি বা এক লাইনে বর্ণনা
> 4. **Deep Dive** — কোন একটা অংশ deep dive করার যোগ্য মনে হয়, আর কেন
> 5. **Trade-off** — এই design এর দুর্বলতা কী হতে পারে বলে তোমার মনে হয়

মনে রাখো — এখানে "সঠিক উত্তর" আশা করছি না, তোমার **চিন্তার প্রক্রিয়াটা** framework অনুসরণ করছে কিনা সেটাই দেখব।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1
Current: 1.2 — The Design Framework
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation,
High-Level Design, Deep Dive, Black Box
Weak spots: Functional vs Non-functional এর মধ্যে "constraint/solution" গুলিয়ে ফেলার
প্রবণতা ছিল (1.1 exercise এ) — এখন উন্নতি হচ্ছে, তবে consistency তে নজর রাখতে হবে
Next: 1.3 — Back-of-the-envelope Estimation (numbers every engineer should know)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও, আমি প্রতিটা ধাপ ধরে ধরে দেখব framework টা ঠিকমতো অনুসরণ হচ্ছে কিনা। রেডি হলে `next` লিখো — Lesson 1.3 এ যাব, যেখানে Estimation ধাপটা নিয়ে গভীরে ঢুকব: কোন কোন সংখ্যা মুখস্থ রাখা উচিত (QPS, storage math, latency numbers), আর কীভাবে দ্রুত মাথায় মাথায় হিসাব করতে হয়।
