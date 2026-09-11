# Lesson 3.2 — Load Balancing Algorithms: Round Robin, Least Connections, Consistent Hashing (Intro)

**Module 3 — Load Balancing & Proxies**

> **Spaced Repetition (Lesson 2.4):** SSE কেন one-directional (শুধু server→client)? আর TaskFlow এর মতো notification use case এ, এই সীমাবদ্ধতা থাকা সত্ত্বেও কেন SSE প্রায়ই WebSocket এর চেয়ে ভালো পছন্দ হতে পারে?

**Prerequisite:** Lesson 3.1 (Load Balancer, L4/L7)

**তুমি এই lesson শেষে পারবে:**

1. Round Robin, Weighted Round Robin, এবং Least Connections algorithm কীভাবে কাজ করে এবং কখন কোনটা উপযুক্ত — বুঝবে
2. IP Hash / Consistent Hashing এর মূল ধারণা (session affinity এর প্রেক্ষিতে) — প্রাথমিকভাবে বুঝবে (full depth Module 10.1 এ)
3. TaskFlow এর নির্দিষ্ট traffic pattern দেখে সঠিক algorithm বেছে নিতে পারবে

**Tier:** 3 — Design Exercise

---

## ০. TaskFlow এখন কোথায়

Lesson 3.1 তে আমরা শিখেছি Load Balancer **কোথায়** request পাঠাবে সেটা ঠিক করে (L4 vs L7, কোন backend pool)। কিন্তু একটা প্রশ্ন এখনও অনুত্তরিত — LB এর সামনে যদি ৩টা identical server থাকে, **এই মুহূর্তে নির্দিষ্ট এই request টা ঠিক কোন server এ যাবে**? এলোমেলোভাবে? পালাক্রমে? নাকি অন্য কোনো যুক্তিতে? এটাই আজকের বিষয় — LB এর ভেতরের **decision algorithm**।

---

## ১. Theory

### ১.১ Round Robin — সবচেয়ে সহজ, ঘুরিয়ে ঘুরিয়ে পাঠানো

**Round Robin** সবচেয়ে সহজ algorithm — request গুলো পালাক্রমে, ক্রম অনুযায়ী, প্রতিটা server এ পাঠানো হয়:

```
Request 1 -> Server A
Request 2 -> Server B
Request 3 -> Server C
Request 4 -> Server A   (আবার প্রথম থেকে শুরু)
Request 5 -> Server B
...
```

**সুবিধা:** implement করা সবচেয়ে সহজ, কোনো extra state track করার দরকার নেই (শুধু "পরেরটা কে" এই একটা counter যথেষ্ট)।

**সমস্যা:** এটা ধরে নেয় **প্রতিটা server এর ক্ষমতা সমান, এবং প্রতিটা request এর processing cost প্রায় সমান।** যদি এই দুটো assumption সত্যি না হয়, সমস্যা হয়। যেমন, ধরো Server A এর hardware Server B আর C এর চেয়ে দুর্বল — কিন্তু Round Robin সবাইকে সমান request দিচ্ছে, ফলে Server A দ্রুত overload হয়ে যাবে।

**Weighted Round Robin** এই সমস্যার একটা সমাধান — প্রতিটা server কে একটা "weight" দেওয়া হয় তার capacity অনুযায়ী:

```
Server A (weight 1) — দুর্বল hardware
Server B (weight 2) — শক্তিশালী hardware
Server C (weight 2) — শক্তিশালী hardware

Distribution: A, B, C, B, C, A, B, C, B, C ...
(B এবং C, A এর দ্বিগুণ request পায়)
```

### ১.২ Least Connections — কে সবচেয়ে কম ব্যস্ত সেটা দেখে পাঠানো

Round Robin এর একটা গভীরতর সমস্যা আছে — এটা শুধু "কে পরেরবার পাবে" সেটা জানে, কিন্তু **কোন server এই মুহূর্তে কতটা busy** সেটা জানে না। ধরো, TaskFlow এর "Export to PDF" feature (Module 1 Exit Challenge মনে আছে?) — এই request গুলো process হতে কয়েক সেকেন্ড লাগতে পারে, যেখানে সাধারণ `GET /api/tasks` মাত্র কয়েক millisecond এ শেষ হয়ে যায়। যদি Round Robin এ Server A বারবার এই "ভারী" PDF export request গুলো পেতে থাকে, সেটা কাজে ব্যস্ত থাকা সত্ত্বেও Round Robin তাকে আরও নতুন request পাঠাতেই থাকবে, কারণ তার "পালা" এসে গেছে — এটা fair না, বাস্তবে unequal load তৈরি করে।

**Least Connections** algorithm এই সমস্যা সমাধান করে — এটা প্রতিটা server এর **এই মুহূর্তে কতগুলো active connection/request চলছে** সেটা track করে, এবং নতুন request সবসময় **সবচেয়ে কম ব্যস্ত** server এ পাঠায়:

```
এই মুহূর্তে:
Server A — 12টা active connection (ভারী request প্রসেস করছে)
Server B — 3টা active connection
Server C — 5টা active connection

নতুন request আসলে -> Server B তে যাবে (সবচেয়ে কম busy)
```

**কখন এটা বেশি গুরুত্বপূর্ণ:** যখন request processing time **ব্যাপকভাবে ভিন্ন** হয় (কিছু দ্রুত, কিছু ধীর) — তখন শুধু request count সমান ভাগ করা (Round Robin) যথেষ্ট না, actual load (কে এখন কত ব্যস্ত) দেখাটাই বেশি accurate।

### ১.৩ IP Hash / Session Affinity — একই Client, একই Server (ভূমিকা)

কখনো কখনো তুমি চাও **একই client বারবার একই server এ যাক** (একে বলে **session affinity** বা **sticky session**)। এর একটা সহজ implementation হলো client এর IP address কে hash করে, সেই hash অনুযায়ী একটা নির্দিষ্ট server বেছে নেওয়া:

```
hash(client_IP) % সার্ভার_সংখ্যা = কোন সার্ভার
```

**এটা কেন দরকার হতে পারে:** মনে করো, Lesson 1.6 এর stateful vs stateless আলোচনা — ধরো TaskFlow তাড়াহুড়ো করে একটা feature বানিয়েছে যেখানে session data এখনও local server memory তে আছে (Redis এ migrate করা হয়নি, ideal না, কিন্তু বাস্তবে অনেক সময় এমন "technical debt" থেকে যায়)। এমন অবস্থায়, একই user কে প্রতিবার একই server এ পাঠানো (IP hash দিয়ে) একটা **সাময়িক সমাধান** হতে পারে, যতক্ষণ না properly stateless বানানো হচ্ছে।

**কিন্তু একটা বড় সমস্যা আছে — Server যোগ/বাদ দিলে সব হিসাব ওলটপালট হয়ে যায়:**

```
৩টা server থাকলে: hash(IP) % 3
Server যোগ করে ৪টা করলে: hash(IP) % 4

একই client IP, কিন্তু % 3 আর % 4 এর ফলাফল সম্পূর্ণ আলাদা হতে পারে —
মানে প্রায় সব client ই হঠাৎ ভিন্ন server এ চলে যাবে!
```

এটাই সেই সমস্যা যেটার সমাধান করে **Consistent Hashing** — একটা বেশি sophisticated hashing technique যেখানে server যোগ/বাদ দিলে শুধু **সামান্য অংশ** client re-map হয়, প্রায় সবাই না। এটা এতটাই গুরুত্বপূর্ণ এবং গভীর একটা topic (শুধু load balancing না, distributed database sharding, CDN routing — অনেক জায়গায় ব্যবহৃত হয়) যে আমরা এটার জন্য **সম্পূর্ণ আলাদা একটা lesson রেখেছি — Module 10.1**। আজকে শুধু এইটুকু জানো — এই সমস্যাটা (server সংখ্যা বদলালে সব hash ভেঙে পড়া) exists করে, এবং এর একটা elegant সমাধান আছে, যেটা আমরা পরে গভীরে যাব।

> **Trade-off Table — LB Algorithms**

| Algorithm            | কী বিবেচনা করে                  | Best fit                                       | সীমাবদ্ধতা                                                    |
| -------------------- | ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| Round Robin          | কিছুই না, শুধু ক্রম             | Uniform server capacity, uniform request cost  | Server capacity/request cost ভিন্ন হলে অন্যায্য               |
| Weighted Round Robin | Server capacity (manual weight) | ভিন্ন capacity এর server pool                  | Weight manually ঠিক করতে হয়, dynamic না                      |
| Least Connections    | বর্তমান active load             | ভিন্ন ভিন্ন request processing time            | সামান্য বেশি overhead (state track করতে হয়)                  |
| IP Hash              | Client identity                 | Session affinity প্রয়োজন হলে (সাময়িক সমাধান) | Server যোগ/বাদ দিলে বড় disruption (consistent hashing ছাড়া) |

---

## ২. Interview Angle

একটা common প্রশ্ন — "তোমার backend এর কিছু endpoint দ্রুত (কয়েক ms), কিছু ধীর (কয়েক সেকেন্ড) — কোন LB algorithm বেছে নেবে?" সঠিক উত্তর **Least Connections**, কারণ Round Robin এ ধীর request গুলো একটা server কে "আটকে" রাখতে পারে, অথচ তার পরের "turn" এ আরও নতুন request চলে আসবে, ন্যায্য load distribution ভেঙে যাবে।

আরেকটা প্রশ্ন যেটা Lesson 1.6 এর সাথে সরাসরি সংযুক্ত — "Session affinity (sticky session) কি ভালো practice?" এখানে ভালো উত্তরে বলা উচিত — **এটা একটা workaround, ideal সমাধান না।** সঠিক approach হলো application কে stateless বানানো (Lesson 1.6, external session store), যাতে **কোনো session affinity ছাড়াই যেকোনো request যেকোনো server এ যেতে পারে** — এটাই horizontal scaling কে সবচেয়ে flexible এবং resilient করে তোলে (একটা server down হলেও, session affinity না থাকায় কোনো user block হয় না)।

---

## ৩. Key Takeaway

- **Round Robin** — সহজ, ক্রমানুযায়ী, uniform capacity/cost assumption করে
- **Weighted Round Robin** — server capacity ভিন্ন হলে manual weight দিয়ে সমাধান
- **Least Connections** — বর্তমান active load দেখে routing, variable request cost এ বেশি ন্যায্য
- **IP Hash / Session Affinity** — client কে একই server এ পাঠানো, কিন্তু server সংখ্যা বদলালে বড় disruption হতে পারে
- **Consistent Hashing** এই disruption সমস্যার সমাধান — বিস্তারিত Module 10.1 এ
- Session affinity একটা workaround, stateless architecture (Lesson 1.6) হলো ideal, দীর্ঘমেয়াদী সমাধান

---

## ৪. নতুন Term (Glossary)

| Term                                  | অর্থ                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Round Robin**                       | ক্রমানুযায়ী প্রতিটা server এ পালাক্রমে request পাঠানোর algorithm                                      |
| **Weighted Round Robin**              | server এর capacity অনুযায়ী ভিন্ন অনুপাতে request ভাগ করা                                              |
| **Least Connections**                 | যে server এ সবচেয়ে কম active connection আছে, সেখানে নতুন request পাঠানো                               |
| **Session Affinity (Sticky Session)** | একই client কে বারবার একই backend server এ পাঠানো                                                       |
| **IP Hash**                           | client IP hash করে নির্দিষ্ট server বেছে নেওয়ার পদ্ধতি                                                |
| **Consistent Hashing**                | এমন একটা hashing technique যেখানে server সংখ্যা বদলালেও বেশিরভাগ mapping অক্ষুণ্ণ থাকে (বিস্তারিত পরে) |

---

## ৫. Reflection Questions

1. TaskFlow এর বেশিরভাগ endpoint (task CRUD) দ্রুত এবং প্রায় সমান cost এর, কিন্তু "Export to PDF" (Exit Challenge মনে আছে?) মাঝে মাঝে আসে এবং সময় নেয়। এই মিশ্র traffic pattern এর জন্য কোন algorithm প্রস্তাব করবে, কেন?
2. যদি TaskFlow এর সব server সঠিকভাবে stateless হয় (Lesson 1.6 অনুযায়ী), তাহলে IP Hash/Session Affinity ব্যবহার করার কোনো প্রয়োজন আছে কি? কেন বা কেন না?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** **Least Connections** এখানে সবচেয়ে যুক্তিসঙ্গত, কারণ request processing cost ব্যাপকভাবে ভিন্ন (দ্রুত CRUD vs ধীর PDF export)। Round Robin এ একটা server "PDF export" request পেয়ে busy থাকা অবস্থায়ও তার "পরের turn" এ নতুন request পাবে, যেটা তাকে আরও overload করবে। Least Connections স্বয়ংক্রিয়ভাবে busy server কে এড়িয়ে কম-ব্যস্ত server এ নতুন request পাঠাবে।

**প্রশ্ন ২:** যদি সব server সত্যিকারের stateless হয় (session, file, সবকিছু external store এ), তাহলে **IP Hash/Session Affinity এর কোনো প্রয়োজন নেই** — কারণ যেকোনো server, যেকোনো request handle করতে সক্ষম, তার আগের request কোথায় গিয়েছিল তার ওপর নির্ভর না করেই। এই ক্ষেত্রে Round Robin বা Least Connections ব্যবহার করাই ভালো, কারণ এগুলো traffic কে সবচেয়ে flexible এবং even ভাবে distribute করে, কোনো unnecessary constraint (session affinity) ছাড়াই।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow এর ৪টা server instance আছে। নিচের তিনটা পরিস্থিতির জন্য কোন LB algorithm প্রস্তাব করবে, আর কেন:
>
> 1. চারটা server ই একদম identical hardware এবং TaskFlow এর সব endpoint প্রায় সমান দ্রুত (সাধারণ CRUD app)
> 2. একটা server সম্প্রতি upgrade করা হয়েছে (ডাবল CPU/RAM), বাকি তিনটা পুরনো hardware এই আছে
> 3. TaskFlow এ একটা legacy feature আছে যেটা এখনও local server memory তে কিছু temporary state রাখে (stateless বানানো এখনও বাকি, technical debt হিসেবে চিহ্নিত করা আছে) — এই মুহূর্তে এই সীমাবদ্ধতা মেনে নিয়ে কাজ চালাতে হবে

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (সম্পূর্ণ) + Module 2 (সম্পূর্ণ), 3.1
Current: 3.2 — LB Algorithms
TaskFlow state: multi-instance transition — stateless Express server instances,
single Postgres, ~100 users বেস, horizontal-scale architecture এখন প্রতিষ্ঠিত
Terms learned (Module 3 so far): Load Balancer, L4/L7, SSL Termination,
Content-based Routing, Round Robin, Weighted Round Robin, Least Connections,
Session Affinity, IP Hash, Consistent Hashing (intro)
Weak spots: সঠিক উত্তরে পৌঁছেও ভুল/অপ্রাসঙ্গিক কারণ দিয়ে reasoning করা (3.1 এর
Idempotency-Key vs Host-header confusion) — যেকোনো decision এর পেছনে "ঠিক কোন
specific factor" কাজ করছে সেটা স্পষ্টভাবে identify করার habit দরকার
Next: 3.3 — Reverse Proxy vs Forward Proxy, Nginx Hands-on
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 3.3 এ যাব: Reverse Proxy vs Forward Proxy, এবং এখানে আমরা প্রথমবারের মতো **Nginx hands-on** করব (Tier 2 — Docker/config-based exercise)।
