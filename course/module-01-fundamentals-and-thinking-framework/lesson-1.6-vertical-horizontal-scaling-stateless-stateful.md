# Lesson 1.6 — Vertical vs Horizontal Scaling, Stateless vs Stateful

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.4):** Keep-Alive (persistent connection) আসলে কী সমস্যার সমাধান করে, আর এই একই "reuse" নীতি system design এর আর কোথায় কোথায় দেখা যায় (তোমার নিজের Sequelize অভিজ্ঞতা থেকে একটা উদাহরণ দাও)?

---

**Prerequisite:** Lesson 1.1 – 1.5

**তুমি এই lesson শেষে পারবে:**

1. Vertical আর Horizontal scaling এর মধ্যে পার্থক্য বলতে পারবে, এবং প্রতিটার সীমাবদ্ধতা ও trade-off ব্যাখ্যা করতে পারবে।
2. একটা server "Stateless" নাকি "Stateful" সেটা চিনতে পারবে, এবং কেন Horizontal scaling এর জন্য Stateless architecture প্রায় বাধ্যতামূলক পূর্বশর্ত — বুঝবে।
3. TaskFlow এর নিজের Express server টাকে "session" এর প্রেক্ষিতে বিশ্লেষণ করে বলতে পারবে সেটা এখন stateful আছে নাকি stateless, আর horizontal scale করতে হলে কী পরিবর্তন লাগবে।

**Tier:** 3 — Design Exercise (এটা Module 1 এর শেষ lesson; কোনো code আজকে না, কিন্তু এই lesson এর concept টাই Module 3 থেকে শুরু হওয়া সব hands-on exercise এর ভিত্তি)

---

## ০. TaskFlow এখন কোথায়

এতদিন আমরা TaskFlow কে "একটা Express server, একটা Postgres" হিসেবে ধরে এসেছি। Estimation (1.3) থেকে আমরা দেখেছি — user বাড়লে QPS বাড়ে। Connection lifecycle (1.4) থেকে জেনেছি — প্রতিটা connection এর একটা cost আছে। Latency/Availability (1.5) থেকে জেনেছি — কিছু feature এর জন্য কড়া target দরকার।

এখন স্বাভাবিক প্রশ্ন — **যখন একটা মাত্র Express server আর সেটার capacity যথেষ্ট হয় না, তখন কী করব?** উত্তরটা সহজ মনে হতে পারে — "আরেকটা server লাগাও" — কিন্তু এটা বলার মধ্যেই একটা গুরুত্বপূর্ণ প্রশ্ন লুকিয়ে আছে: **কীভাবে?** একটা _বড়_ server লাগাবে, নাকি _একাধিক_ server লাগাবে? আর যদি একাধিক server লাগাও, তোমার আজকের কোড কি আদৌ সেটার জন্য প্রস্তুত? আজকের lesson এই প্রশ্ন দুটোর উত্তর দেবে, আর Module 3 (Load Balancing) এর জন্য মাটি তৈরি করবে।

---

## ১. Theory

### ১.১ Vertical Scaling — একই Server কে বড় করা

**Vertical Scaling (Scale Up)** মানে — তোমার existing server এর **hardware resource বাড়ানো** — বেশি CPU, বেশি RAM, দ্রুত disk। তোমার architecture একই থাকে (এখনও একটা মাত্র server), শুধু সেটা আরও শক্তিশালী হয়।

```
আগে:  [Server: 2 CPU, 4GB RAM] ──> সব request handle করে

পরে:  [Server: 16 CPU, 64GB RAM] ──> একই server, কিন্তু বেশি resource
```

তোমার VPS-based topup-backend deployment এর প্রেক্ষিতে ভাবলে — vertical scaling মানে হলো VPS provider এর কাছে গিয়ে একটা বড় plan এ upgrade করা (২ vCPU থেকে ৮ vCPU তে যাওয়া, ইত্যাদি)।

**সুবিধা:**

- Implementation সবচেয়ে সহজ — কোনো code পরিবর্তন লাগে না, শুধু hardware/plan upgrade
- Data consistency নিয়ে ভাবার দরকার নেই (একটাই server, একটাই database instance)

**সীমাবদ্ধতা:**

- **একটা physical limit আছে** — একটা মেশিনে যত বড়ই হোক, CPU/RAM এর একটা সর্বোচ্চ সীমা থাকে (cloud provider এর সবচেয়ে বড় instance টাইপেও সীমা আছে)
- **Single Point of Failure (SPOF)** — এই একটা মাত্র server ডাউন হলে, পুরো system ডাউন। Redundancy নেই।
- প্রায়ই cost বাড়ে non-linearly — একটা "বড়" server, দুইটা "মাঝারি" server এর চেয়ে প্রতি-ইউনিট বেশি দামি হতে পারে

### ১.২ Horizontal Scaling — একাধিক Server যোগ করা

**Horizontal Scaling (Scale Out)** মানে — একটা বড় server এর বদলে, **একাধিক (সাধারণত ছোট/মাঝারি) server যোগ করা**, এবং তাদের মধ্যে ট্রাফিক ভাগ করে দেওয়া।

```
আগে:  [Server: 4 CPU, 8GB RAM] ──> সব request handle করে

পরে:  [Server 1: 4 CPU, 8GB]  ─┐
      [Server 2: 4 CPU, 8GB]  ─┼──> Load Balancer request গুলো ভাগ করে দেয়
      [Server 3: 4 CPU, 8GB]  ─┘
```

(এই "Load Balancer" বক্সটা এখন একটা black box — Module 3 তে আমরা এটার ভেতরে ঢুকব, কীভাবে এটা ঠিক করে কোন request কোন server এ যাবে।)

**সুবিধা:**

- **তাত্ত্বিকভাবে প্রায় unlimited scale** — দরকার হলে আরও server যোগ করা যায়, কোনো hard hardware ceiling নেই
- **Redundancy/fault tolerance** — একটা server ডাউন হলেও বাকিগুলো চলতে থাকে, পুরো system ডাউন হয় না
- সাধারণত cost-effective — অনেকগুলো ছোট/মাঝারি (commodity) server, একটা বিশাল server এর চেয়ে সস্তা হতে পারে

**সীমাবদ্ধতা:**

- **Implementation জটিল** — Load balancer লাগে, আর সবচেয়ে গুরুত্বপূর্ণ কথা — **তোমার application code কে এই মাল্টি-সার্ভার reality এর জন্য প্রস্তুত থাকতে হয়** (এটাই পরের section এর বিষয়)
- Data consistency এর নতুন challenge আসে — যদি একাধিক server থাকে, তাদের মধ্যে কীভাবে data sync থাকবে (এটা Module 5 এ replication/sharding এর সাথে গভীরে যাব)

> **Trade-off Table — Vertical vs Horizontal**

| দিক                       | Vertical Scaling                     | Horizontal Scaling                       |
| ------------------------- | ------------------------------------ | ---------------------------------------- |
| Implementation complexity | কম (hardware upgrade)                | বেশি (load balancer, code পরিবর্তন)      |
| Scale limit               | Hard ceiling আছে                     | তাত্ত্বিকভাবে প্রায় unlimited           |
| Fault tolerance           | নেই (SPOF)                           | আছে (একটা down হলেও বাকিগুলো চলে)        |
| Downtime during scale-up  | সাধারণত লাগে (server restart/resize) | নতুন server যোগ করা যায় zero-downtime এ |
| কখন উপযুক্ত               | ছোট/মাঝারি scale, দ্রুত সমাধান দরকার | বড় scale, দীর্ঘমেয়াদী পরিকল্পনা        |

**বাস্তবে কী হয়:** বেশিরভাগ production system প্রথমে vertical scaling দিয়ে শুরু করে (কারণ এটা সহজ, আর ছোট scale এ যথেষ্ট), এবং যখন vertical scaling এর সীমায় পৌঁছায় বা redundancy দরকার হয়, তখন horizontal scaling এ move করে। এটা আবার সেই lesson 1.1 এর কথা মনে করিয়ে দেয় — Day 1 থেকেই horizontal scaling এর জন্য অতিরিক্ত জটিলতা যোগ করা (যখন ১০০ ইউজার আছে) over-engineering হতে পারে।

### ১.৩ Stateless vs Stateful — Horizontal Scaling এর আসল পূর্বশর্ত

এখানেই আজকের lesson এর সবচেয়ে গুরুত্বপূর্ণ অংশ আসে, যেটা প্রায়ই ভুল বোঝা হয়।

একটা server **Stateful** — যদি সে কোনো request-specific তথ্য নিজের মেমোরিতে (বা local disk এ) **সংরক্ষণ করে রাখে**, যেটা পরের request এ দরকার হবে।

একটা server **Stateless** — যদি সে **কোনো request-specific তথ্য নিজের কাছে সংরক্ষণ না করে** — প্রতিটা request স্বয়ংসম্পূর্ণ (self-contained), request নিজেই তার দরকারি সব তথ্য বহন করে আনে (বা একটা shared/external জায়গা থেকে fetch করে)।

**একটা ক্লাসিক উদাহরণ — Session Management:**

ধরো, TaskFlow এ ইউজার login করলে, server তাকে একটা session তৈরি করে দেয়, আর সেই session data (কে login করেছে, কী permission আছে) server এর **নিজের memory তে** রেখে দেয়:

```
Stateful approach:

[User login] ──> [Server 1 তার নিজের memory তে session বানায়: {userId: 123, role: "admin"}]

পরের request ──> [Load Balancer সেটা কোন server এ পাঠাবে?]
                        │
                ┌───────┴────────┐
                ▼                ▼
         [Server 1]       [Server 2]
       (session আছে!)   (session নাই — user কে re-login করতে বলবে!)
```

এখানেই সমস্যা — যদি horizontal scaling এ পরের request টা **Server 2** তে চলে যায় (যেটা খুবই স্বাভাবিক, কারণ Load Balancer জানে না কোন server এ কার session আছে), তাহলে Server 2 এর কাছে সেই user এর কোনো information নেই — user কে আবার login করতে বলা হবে, যদিও সে একটু আগেই login করেছিল! এটা একটা ভয়াবহ user experience bug, আর এটা horizontal scaling চালু করলেই আচমকা দেখা দেয়।

**সমাধান — Stateless বানানো:**

Stateless architecture এ, session data server এর memory তে না রেখে, একটা **shared/external জায়গায়** রাখা হয় — যেটা যেকোনো server থেকে access করা যায়:

```
Stateless approach:

[User login] ──> [Server (যেকোনো একটা) session তৈরি করে, কিন্তু save করে External Store এ]
                                        │
                                        ▼
                              [Redis / Database — shared session store]

পরের request ──> [Load Balancer, যেকোনো server এ পাঠায়]
                        │
                ┌───────┴────────┐
                ▼                ▼
         [Server 1]       [Server 2]
              │                 │
              └────────┬────────┘
                        ▼
              [দুটো server ই একই External Store থেকে session data পড়তে পারে]
```

এখন যেকোনো request যেকোনো server এ গেলেও, session data সবসময় accessible — কারণ সেটা কোনো নির্দিষ্ট server এর memory তে না, একটা shared জায়গায় আছে। এটাই Module 4.4 এ আমরা hands-on করব (Redis দিয়ে session store)।

> **তোমার stack এর প্রেক্ষিতে:** যদি তোমার Express app এ `express-session` মিডলওয়্যার default memory store দিয়ে ব্যবহার করা হয় (যেটা প্রায়ই tutorial এ default থাকে), সেটা **stateful** — শুধুমাত্র single-server deployment এই কাজ করবে। Horizontal scale করার জন্য সেটাকে Redis store এ পরিবর্তন করতে হবে (`connect-redis` এর মতো একটা adapter দিয়ে) — এটাই stateless বানানোর practical পদক্ষেপ।

**Stateless শুধু session এর জন্য না — আরও উদাহরণ:**

- **File upload (Lesson 1.1 এর exercise মনে আছে?):** যদি uploaded file server এর local disk এ save হয়, সেটাও stateful (শুধু সেই server ই জানে ফাইলটা কোথায় আছে) — এই কারণেই আমরা 1.1 এর Deep Dive এ "S3-তে store হবে" কে "Solution" হিসেবে চিহ্নিত করেছিলাম, এটাই সেই কারণ যেটা তখন explain করিনি, আজকে করলাম।
- **In-memory rate limiting counter:** যদি "এই user কতবার request পাঠিয়েছে" এই count টা server এর memory তে রাখা হয়, প্রতিটা server এর নিজের আলাদা count থাকবে, যেটা ভুল রেজাল্ট দেবে (Module 9.5 তে এটা বিস্তারিত দেখব)।

> **Interview এ common question:** "তোমার API stateless কিনা কীভাবে বুঝবে?" — সহজ test: **যদি তুমি server টা যেকোনো মুহূর্তে বন্ধ করে নতুন একটা server দিয়ে replace করো (কোনো data loss ছাড়া), আর ইউজার কিছুই টের না পায় — তাহলে সেটা stateless।** যদি server বন্ধ করলে কিছু হারিয়ে যায় (session, uploaded file, in-progress data), সেটা stateful।

---

## ২. Interview Angle

Stateless vs Stateful এই concept টা প্রায় **প্রতিটা** system design interview এ কোনো না কোনো ভাবে ফিরে আসে, কারণ এটাই নির্ধারণ করে দেয় তুমি সহজে horizontal scale করতে পারবে কিনা। একটা খুবই common প্রশ্ন:

> "তোমার এই API server কে তুমি কীভাবে scale করবে, ইউজার বাড়লে?"

এখানে ভালো উত্তরের প্রথম ধাপই হওয়া উচিত — "প্রথমে দেখব আমার server stateless কিনা। যদি না হয়, প্রথমে সেটাকে stateless বানাব (session/file/local state সরিয়ে shared store এ নেব), তারপর horizontal scaling করব লোড ব্যালান্সারের পেছনে multiple instance দিয়ে।" এই উত্তরটা দেখায় তুমি জানো horizontal scaling "শুধু আরেকটা সার্ভার লাগানো" না — এর একটা **prerequisite** আছে।

একটা সাধারণ ভুল যেটা junior candidate রা করে — সরাসরি "Load Balancer লাগাবো, ৩টা সার্ভার রাখবো" বলে ফেলা, স্টেট এর প্রশ্নটা একদমই না তুলে। Senior-level উত্তর সবসময় আগে জিজ্ঞেস করে বা মেনশন করে — "সার্ভারটা কি কোনো local state রাখে?"

---

## ৩. Key Takeaway

- **Vertical Scaling** = existing server কে বড় করা (বেশি CPU/RAM)। সহজ, কিন্তু hard limit আছে, আর SPOF থেকে যায়
- **Horizontal Scaling** = একাধিক server যোগ করা এবং ট্রাফিক ভাগ করা। জটিল, কিন্তু প্রায় unlimited scale + fault tolerance দেয়
- বেশিরভাগ system ছোট scale এ vertical দিয়ে শুরু করে, প্রয়োজন হলে horizontal এ move করে
- **Stateful server** — request-specific data নিজের memory/disk এ রাখে (session, uploaded file, local counter)
- **Stateless server** — কোনো local state রাখে না, সব শেয়ার্ড external store (Redis, DB, S3) এ থাকে
- **Horizontal scaling এর আসল পূর্বশর্ত হলো Stateless architecture** — stateful server কে horizontally scale করলে data inconsistency/loss হয়
- Test: server বন্ধ করে replace করলে ইউজার কিছু টের পায় কিনা — পেলে stateful, না পেলে stateless

---

## ৪. নতুন Term (Glossary)

| Term                               | অর্থ                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Vertical Scaling (Scale Up)**    | একটা server এর hardware resource বাড়ানো                                                                           |
| **Horizontal Scaling (Scale Out)** | একাধিক server যোগ করে ট্রাফিক ভাগ করা                                                                              |
| **Single Point of Failure (SPOF)** | এমন একটা component, যেটা fail করলে পুরো system fail করে                                                            |
| **Stateful**                       | server request-specific data নিজের কাছে (memory/local disk) সংরক্ষণ করে                                            |
| **Stateless**                      | server কোনো request-specific data নিজের কাছে রাখে না; সব shared/external store এ থাকে বা request নিজেই বহন করে আনে |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর নিচের Answer Key দেখো।

1. TaskFlow এর আজকের অবস্থা মনে করো — "single Express server + 1 Postgres"। এই architecture এ, session/user data **কোথায়** থাকা উচিত বলে তোমার মনে হয়, যাতে ভবিষ্যতে horizontal scaling করা সহজ হয় — শুরু থেকেই?
2. একটা in-memory rate limiter (যেটা প্রতি user এর request count একটা plain JavaScript object এ রাখে, server এর memory তে) — এটা কি stateless না stateful? Horizontal scaling এ এটার সাথে কী সমস্যা হবে, নির্দিষ্ট করে বলো (Lesson 1.5 এর "vague না বলে concrete বলা" অভ্যাসটা এখানে প্রয়োগ করো)।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** যদিও আজকে TaskFlow এ একটাই server আছে (তাই এখনই এটা technically সমস্যা তৈরি করছে না), ভবিষ্যতের জন্য সবচেয়ে ভালো practice হলো শুরু থেকেই session data কে **database এ** (বা future এ Redis এ) রাখা, server এর নিজের memory তে না। এতে করে যখন horizontal scaling দরকার হবে, তখন কোনো বড় refactor লাগবে না — architecture টা আগে থেকেই "scale-ready" থাকবে। এটাই ভালো engineering practice — যদিও আজকে দরকার নেই, ভবিষ্যতের migration cost কমানোর জন্য শুরু থেকেই sensible decision নেওয়া (তবে এটা Module 1.1 এর "over-engineering" এর বিরুদ্ধে না যায় — এখানে extra infrastructure লাগছে না, শুধু "কোথায় data রাখব" এই সিদ্ধান্তটা ভালোভাবে নেওয়া হচ্ছে, যেটা প্রায় বিনামূল্যে পাওয়া যায়)।

**প্রশ্ন ২:** এটা **stateful**, কারণ rate limit count টা একটা নির্দিষ্ট server এর memory তে (plain object) রাখা হচ্ছে। Horizontal scaling এ সমস্যা: ধরো একটা user এর rate limit হলো "১ মিনিটে ১০টা request"। যদি ৩টা server এর মধ্যে Load Balancer request ভাগ করে দেয়, তাহলে প্রতিটা server আলাদাভাবে count করবে — Server 1 হয়তো দেখবে সেই user ৪টা request পাঠিয়েছে (তার limit এর মধ্যে), Server 2 আলাদাভাবে দেখবে ৪টা (তারও limit এর মধ্যে), Server 3 আরও ৪টা। বাস্তবে সেই user মোট ১২টা request পাঠিয়ে ফেলেছে (১০ এর বেশি!), কিন্তু কোনো একটা server এর কাছেই সম্পূর্ণ ছবি নেই, তাই limit ঠিকভাবে enforce হচ্ছে না। এই সমস্যার সমাধান Module 9.5 তে — rate limit counter কে Redis এর মতো একটা shared store এ রাখতে হয়, যাতে সব server একই count দেখে।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

এটা Module 1 এর শেষ lesson, তাই exercise টা আজকে একটু বেশি integrative — এখন পর্যন্ত শেখা সবকিছু একসাথে ব্যবহার করতে হবে।

> **Scenario:** TaskFlow এখন "single Express server + 1 Postgres" অবস্থায় আছে (~১০০ ইউজার)। ধরো, ৬ মাস পর ইউজার সংখ্যা ৫০,০০০ এ পৌঁছাবে বলে আশা করা হচ্ছে।
>
> নিচের প্রশ্নগুলোর উত্তর দাও:
>
> 1. তুমি কি প্রথমেই horizontal scaling এ যাবে, নাকি আগে vertical scaling try করবে? তোমার সিদ্ধান্তের এক লাইনে কারণ দাও (৫০,০০০ ইউজার — এটা কি সত্যিই "বিশাল" scale, নাকি এখনো মাঝারি? Lesson 1.3 এর estimation skill ব্যবহার করে একটা rough QPS হিসাব করে দেখাও কেন)
> 2. তুমি যদি ভবিষ্যতে horizontal scaling করার পরিকল্পনা করো, TaskFlow এর current architecture এ **কোন কোন জায়গা** তোমার সন্দেহ হয় stateful হতে পারে (এখনো explicitly বলা হয়নি, কিন্তু একটা typical Express+Sequelize app এ common জায়গা)? কমপক্ষে ২টা জায়গা identify করো এবং প্রতিটা কীভাবে stateless বানানো যায় এক লাইনে বলো।
> 3. একটা trade-off statement লেখো (Lesson 1.5 এর concrete-mechanism অভ্যাস প্রয়োগ করে) — horizontal scaling এ move করলে TaskFlow এর জন্য নতুন কোন খরচ/জটিলতা যোগ হবে যেটা আজকে নেই।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2, 1.3, 1.4, 1.5
Current: 1.6 — Vertical vs Horizontal Scaling, Stateless vs Stateful
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth,
TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC, Latency, Throughput, Availability, Reliability, SLA, SLO,
Error Budget, Vertical Scaling, Horizontal Scaling, SPOF, Stateful, Stateless
Weak spots: Functional/Non-functional এ solution/constraint গুলিয়ে ফেলা (উন্নতি হচ্ছে);
HLD তে UI-state কে component ভাবা; Requirement মনোযোগ দিয়ে না পড়ে assumption নেওয়া;
Multi-part exercise এ সবগুলো sub-part (a/b/c) সম্পূর্ণ কভার না করে থামা (Lesson 1.5 তে
তিনটা feature এর বদলে একটা উত্তর দেওয়া হয়েছিল) — exercise submit করার আগে সব অংশ
কভার হয়েছে কিনা check করার habit দরকার
Next: Module 1 Exit Challenge
=======================
```

---

## ৮. পরের ধাপ

Exercise টা করে পাঠাও (এবং এবার সবগুলো sub-question কভার করার কথা মাথায় রেখো) — এটাই Module 1 এর শেষ lesson-level exercise। এরপর `next` লিখলে আমরা **Module 1 Exit Challenge** এ যাব — একটা mini design challenge (Tier 3), একটা "তুমি এগুলো পারার কথা" checklist, আর কিছু বই/ভিডিও/প্রজেক্ট recommendation, তারপর আমরা Module 2 (Networking & Communication) এ move করব।
