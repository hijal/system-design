# Lesson 1.5 — Latency, Throughput, Availability, Reliability + SLA / SLO / Error Budget

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.2):** High-Level Design (HLD) এ একটা "box" আসলে কী represent করে, আর কোন ধরনের জিনিস HLD এ box হিসেবে দেখানো উচিত **না**? (Lesson 1.2 এর exercise এ এই জায়গাতেই একটা ভুল হয়েছিল, মনে আছে কি?)

> **Module Recap (Lesson 1.1-1.4):** System Design মানে trade-off বেছে নেওয়া (1.1) → সবকিছুর জন্য একটা 5-step framework আছে: Requirements → Estimation → HLD → Deep Dive → Trade-off (1.2) → সংখ্যায় হিসাব করার পদ্ধতি, DAU/QPS/storage (1.3) → একটা request client থেকে server এ পৌঁছাতে কী কী ধাপ লাগে, connection reuse কেন জরুরি (1.4)। আজকে আমরা এই সবকিছুর ওপর ভিত্তি করে সেই **ভাষাটা** শিখব যেটা দিয়ে তুমি একটা system কে "কতটা ভালো" সেটা বর্ণনা করবে — সংখ্যায়, ঠিক ঠিক করে।

---

**Prerequisite:** Lesson 1.1, 1.2, 1.3, 1.4

**তুমি এই lesson শেষে পারবে:**

1. Latency আর Throughput এর পার্থক্য বলতে পারবে, এবং কেন p99 latency জানাটা average latency জানার চেয়ে বেশি গুরুত্বপূর্ণ — বুঝবে।
2. Availability আর Reliability এর পার্থক্য করতে পারবে (একটা system "up" থাকা মানেই "নির্ভরযোগ্য" না) এবং "নাইনস" (99.9%, 99.99%) মানে বাস্তবে কত downtime — হিসাব করতে পারবে।
3. SLA, SLO, আর Error Budget — এই তিনটা টার্ম কীভাবে একে অপরের সাথে সম্পর্কিত এবং engineering decision এ কীভাবে ব্যবহার হয় — ব্যাখ্যা করতে পারবে।

**Tier:** 3 — Design Exercise

---

## ০. TaskFlow এখন কোথায়

ধরো, TaskFlow এখন কিছুটা বড় হয়েছে, আর client একদিন এসে বলল — "App টা মাঝেমধ্যে স্লো লাগে, আর গতকাল ৫ মিনিট পুরো ডাউন ছিল। এটা ঠিক করতে হবে।"

তুমি জিজ্ঞেস করলে — "স্লো মানে ঠিক কত স্লো? আর ডাউন থাকাটা কি acceptable কোনো limit এর মধ্যে ছিল, নাকি এটা contract ভঙ্গ করেছে?"

client একটু থমকে গেল, কারণ তার কাছে এর কোনো নির্দিষ্ট উত্তর নেই। এখানেই সমস্যা — "স্লো" আর "ডাউন" শব্দ দুটো ব্যবহার করে তোমরা দুজনেই কথা বলছ, কিন্তু কেউই এর একটা **measurable সংজ্ঞা** দিতে পারছ না। ইঞ্জিনিয়ারিং এ "মনে হয় স্লো" দিয়ে কোনো decision নেওয়া যায় না — এর জন্য দরকার নির্দিষ্ট সংখ্যা, নির্দিষ্ট শব্দ। আজকের lesson ঠিক সেই ভাষাটা তৈরি করবে।

---

## ১. Theory

### ১.১ Latency — একটা single request কত সময় নেয়

**Latency** হলো একটা request পাঠানো থেকে response পাওয়া পর্যন্ত যে সময় লাগে। Lesson 1.4 তে আমরা এর ভেতরের ধাপগুলো দেখেছি (DNS, TCP handshake, TLS handshake, processing, response) — latency আসলে এই সবগুলো ধাপের যোগফল।

কিন্তু এখানে একটা গুরুত্বপূর্ণ ফাঁদ আছে — **average (গড়) latency প্রায়ই মিথ্যা ছবি দেখায়।**

ধরো, ১০০টা request এর মধ্যে ৯৯টা নেয় ৫০ms, কিন্তু ১টা নেয় ৫ সেকেন্ড (হয়তো সেই request টার সময় database লক হয়ে গিয়েছিল)। Average হিসাব করলে দাঁড়ায় প্রায় ৯৯.৫ms — যেটা দেখতে "মোটামুটি ভালো" লাগে। কিন্তু বাস্তবে, **যে ইউজারটা সেই ৫ সেকেন্ডের request পেয়েছে, তার experience ভয়াবহ খারাপ ছিল** — আর average সেই খারাপ experience টা লুকিয়ে ফেলেছে।

এই কারণে ইঞ্জিনিয়াররা average এর বদলে **percentile** ব্যবহার করে:

- **p50 (median)** — ৫০% request এই সময়ের মধ্যে বা তার কম সময়ে শেষ হয়
- **p95** — ৯৫% request এই সময়ের মধ্যে শেষ হয় (মানে সবচেয়ে খারাপ ৫% বাদ)
- **p99** — ৯৯% request এই সময়ের মধ্যে শেষ হয় (সবচেয়ে খারাপ ১% বাদ)

```
Request latency গুলো ছোট থেকে বড় করে সাজালে:

[■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■]────►
50ms                                    p50                p95         p99            5000ms
                                        (~55ms)           (~150ms)   (~800ms)      (worst outlier)
```

**Interview এবং production, দুই জায়গাতেই p99 latency নিয়ে কথা বলাটা standard**, কারণ এটাই বলে দেয় তোমার **সবচেয়ে খারাপ অভিজ্ঞতা পাওয়া ইউজারদের** কী অবস্থা — আর একটা বড় product এ, ১% ইউজার মানেও হাজার হাজার মানুষ।

### ১.২ Throughput — System কতটা কাজ করতে পারে

**Throughput** হলো একটা system প্রতি একক সময়ে কতগুলো request process করতে পারে (সাধারণত requests/second এ মাপা হয় — এটাই Lesson 1.3 এর QPS)।

লক্ষ্য করার বিষয় — **Latency আর Throughput একই জিনিস না**, যদিও দুটোই "speed" এর সাথে সম্পর্কিত। একটা analogy দিয়ে বুঝি:

> একটা টোল প্লাজায় যদি একটা মাত্র বুথ থাকে, প্রতিটা গাড়ির টোল দিতে ৫ সেকেন্ড লাগে (এটা latency)। এক মিনিটে সেই বুথ দিয়ে ১২টা গাড়ি পার হতে পারবে (এটা throughput)। এখন যদি আরও ৩টা বুথ যোগ করো, প্রতিটা গাড়ির latency তবুও ৫ সেকেন্ডই থাকবে (একটা গাড়ির টোল দিতে সময় কমেনি), কিন্তু throughput বেড়ে হয়ে যাবে ৪৮ গাড়ি/মিনিট — কারণ এখন একসাথে ৪টা গাড়ি process হচ্ছে।

এই উদাহরণ থেকে গুরুত্বপূর্ণ শিক্ষা — **latency কমানো আর throughput বাড়ানো, দুটো আলাদা ধরনের সমাধান দাবি করে।** Latency কমাতে হলে প্রতিটা individual request কে দ্রুত করতে হয় (caching, faster query, কম network hop)। Throughput বাড়াতে হলে parallelism বাড়াতে হয় (আরও server, আরও worker) — এমনকি এটা করতে গিয়ে কখনো কখনো individual latency সামান্য বেড়েও যেতে পারে (batching এর কারণে, যেটা আমরা Module 7 এ দেখব)।

> **Trade-off insight:** Batching একটা ভালো উদাহরণ যেখানে throughput বাড়াতে গিয়ে latency এর সাথে আপোষ করা হয়। একটা করে request সাথে সাথে process না করে, ১০০টা জমিয়ে একসাথে process করলে throughput (মোট কাজ/সেকেন্ড) বাড়ে, কিন্তু প্রথম request টাকে বাকি ৯৯টার জন্য অপেক্ষা করতে হয় বলে তার নিজের latency বাড়ে। এটাই classic latency vs throughput trade-off — সবসময় একদিকে গেলে অন্যদিকে কিছু ছাড় দিতে হয়।

### ১.৩ Availability — কতটা সময় System "Up" থাকে

**Availability** মাপা হয় এই সূত্রে:

```
Availability = Uptime / (Uptime + Downtime)
```

এটা সাধারণত শতাংশে প্রকাশ করা হয়, এবং industry তে এটাকে "কয়টা নাইন (9)" আছে সেভাবে বলা হয় — কারণ প্রতিটা অতিরিক্ত ৯, allowed downtime কে প্রায় ১০ গুণ কমিয়ে দেয়।

> **The Nines Table — বছরে কত downtime allowed**

| Availability | নাম (common usage) | বছরে Downtime | মাসে Downtime |
| ------------ | ------------------ | ------------- | ------------- |
| 99%          | "two nines"        | ~৩.৬৫ দিন     | ~৭.৩ ঘণ্টা    |
| 99.9%        | "three nines"      | ~৮.৭৬ ঘণ্টা   | ~৪৩.২ মিনিট   |
| 99.99%       | "four nines"       | ~৫২.৬ মিনিট   | ~৪.৩ মিনিট    |
| 99.999%      | "five nines"       | ~৫.২৬ মিনিট   | ~২৬ সেকেন্ড   |

এই টেবিলটা মুখস্থ রাখার মতো — কারণ interview এ প্রায়ই জিজ্ঞেস করা হয় "তোমার design এর জন্য কী availability target যুক্তিসঙ্গত?", আর উত্তরের সাথে সাথে সংখ্যাটার বাস্তব অর্থও বলতে পারা (যেমন, "99.99% মানে বছরে মাত্র ৫২ মিনিট ডাউন থাকতে পারবে") একটা strong signal।

**গুরুত্বপূর্ণ বাস্তবতা:** প্রতিটা অতিরিক্ত নাইন যোগ করা exponentially বেশি ব্যয়বহুল আর জটিল। 99% থেকে 99.9% এ যাওয়া তুলনামূলক সহজ (single server কে redundant করা), কিন্তু 99.99% থেকে 99.999% এ যাওয়ার জন্য multi-region deployment, automated failover, extensive monitoring — অনেক কিছু লাগে (এগুলো আমরা Module 10 এ দেখব)। তাই **সব system কে "5 nines" টার্গেট করা ভুল** — TaskFlow এর মতো একটা internal team tool হয়তো 99.9% এই যথেষ্ট, কিন্তু একটা payment gateway এর জন্য সেটা অপর্যাপ্ত হতে পারে। এটা আবার সেই lesson 1.1 এর কথা ফিরিয়ে আনে — over-engineering ও একটা ভুল, শুধু under-engineering না।

### ১.৪ Reliability — Available থাকা মানেই Correct থাকা না

এখানেই একটা সূক্ষ্ম কিন্তু গুরুত্বপূর্ণ পার্থক্য আসে। **Reliability** মানে হলো — system টা তার প্রত্যাশিত কাজ **সঠিকভাবে** করছে কিনা, শুধু "সাড়া দিচ্ছে" তাই না।

চিন্তা করো — TaskFlow এর server টা চালু আছে, request নিচ্ছে, response দিচ্ছে HTTP 200 status code দিয়ে — সব দিক থেকে "available"। কিন্তু ধরো, response এ ভুল data আছে (হয়তো একটা bug এর কারণে user এর task list এর বদলে অন্য user এর task list দেখাচ্ছে)। এই system টা **available কিন্তু reliable না**।

```
Available + Reliable    →  System up আছে, সঠিক উত্তর দিচ্ছে  (আদর্শ অবস্থা)
Available + Unreliable  →  System up আছে, কিন্তু ভুল/corrupted data দিচ্ছে  (বিপজ্জনক — চোখে পড়ে না সহজে)
Unavailable              →  System সাড়াই দিচ্ছে না  (চোখে সহজে পড়ে, তাই দ্রুত ধরা পড়ে)
```

এই পার্থক্যটা গুরুত্বপূর্ণ কারণ — **Unreliable কিন্তু Available system প্রায়ই বেশি বিপজ্জনক**, কারণ এটা monitoring এ ধরা পড়ে না সহজে (server তো "up" দেখাচ্ছে!)। এই কারণেই শুধু "server চালু আছে কিনা" চেক করা যথেষ্ট না — Module 10.4 (Observability) তে আমরা দেখব কীভাবে সঠিকতা পর্যবেক্ষণ করতে হয়, শুধু uptime না।

### ১.৫ SLA, SLO, এবং Error Budget — এগুলো কীভাবে একসাথে কাজ করে

এবার আমরা সেই formal ভাষায় পৌঁছাই যেটা দিয়ে company গুলো আসলে এই commitment গুলো লিখিতভাবে define করে।

**SLA (Service Level Agreement)** — এটা একটা **বাহ্যিক, চুক্তিভিত্তিক প্রতিশ্রুতি**, সাধারণত company আর তার customer এর মধ্যে। যেমন, একটা cloud provider বলতে পারে "আমরা 99.9% uptime guarantee করি, এর কম হলে তোমাকে bill এ credit দেব।" এখানে টাকা-পয়সা জড়িত থাকতে পারে (penalty clause) — এটা একটা legal/business document, শুধু engineering target না।

**SLO (Service Level Objective)** — এটা একটা **অভ্যন্তরীণ ইঞ্জিনিয়ারিং টার্গেট**, যেটা টিম নিজেদের জন্য ঠিক করে। গুরুত্বপূর্ণ বিষয় — **SLO সাধারণত SLA এর চেয়ে কড়া (stricter) হয়**। কেন? কারণ তুমি চাও তোমার নিজের internal target ব্যর্থ হওয়া মানে "সতর্কতা", কিন্তু SLA ব্যর্থ হওয়া মানে "customer কে টাকা ফেরত দেওয়া" — এই দুটোর মধ্যে একটা buffer/margin রাখা বুদ্ধিমানের কাজ, যাতে SLO তে সমস্যা ধরা পড়লে ঠিক করার সময় পাওয়া যায় SLA ভাঙার আগেই।

```
                     SLA (customer-facing promise) — যেমন 99.9%
                              ▲
                              │  (safety margin)
                              │
                     SLO (internal target) — যেমন 99.95%
                              ▲
                              │  (এই gap টা monitor করা হয় SLI দিয়ে)
                              │
                     SLI — বাস্তবে যা measure হচ্ছে (actual measured metric)
```

_(ছোট নোট: এই SLI মানে "Service Level Indicator" — এটা মূলত সেই actual measured number যেটা দিয়ে বোঝা হয় SLO পূরণ হচ্ছে কিনা। যেমন, "গত ৩০ দিনে actual availability ছিল 99.97%" — এই সংখ্যাটাই SLI। এটাকে আলাদা glossary term হিসেবে ধরছি না, কিন্তু SLO বুঝতে এই context টা লাগবে।)_

**Error Budget** — এটাই সবচেয়ে practical এবং interesting concept। যদি তোমার SLO হয় 99.9% (মানে ৯৯.৯% সময় ঠিকভাবে কাজ করা প্রয়োজন), তাহলে বাকি **0.1%** সময়টা হলো তোমার "Error Budget" — এটাই তোমার **অনুমোদিত ব্যর্থতার পরিমাণ**।

এই ধারণাটা (মূলত Google এর SRE practice থেকে জনপ্রিয় হয়েছে) engineering team কে একটা practical সিদ্ধান্ত নেওয়ার টুল দেয়:

- যদি error budget **এখনো বাকি আছে** (মানে এই মাসে তেমন downtime হয়নি) → team নতুন feature দ্রুত ship করতে পারে, একটু risk নেওয়া যায়
- যদি error budget **শেষ হয়ে গেছে** (এই মাসে অনেক downtime/error হয়ে গেছে) → team feature release থামিয়ে stability/reliability এ ফোকাস করে, নতুন risky deployment বন্ধ রাখে

```
Error Budget = 100% - SLO target
যদি SLO = 99.9%, তাহলে Error Budget = 0.1%

মাসে ৩০ দিন হলে, 0.1% error budget = ~৪৩ মিনিট "allowed failure" প্রতি মাসে
```

এটা গুরুত্বপূর্ণ কারণ এটা reliability কে একটা **binary "perfect vs broken"** ধারণা থেকে সরিয়ে একটা **measurable, budgetable resource** এ পরিণত করে — ঠিক যেমন টাকার budget থাকে, তেমনি "কতটা ব্যর্থ হওয়া allowed" তারও একটা budget থাকে, আর সেটা দিয়ে business decision (feature velocity vs stability) নেওয়া যায়।

> **Trade-off Table — SLA vs SLO vs Error Budget**

|                   | SLA                               | SLO                                | Error Budget                                 |
| ----------------- | --------------------------------- | ---------------------------------- | -------------------------------------------- |
| কার জন্য          | External customer/contract        | Internal engineering team          | Internal decision-making টুল                 |
| ব্যর্থ হলে কী হয় | আর্থিক penalty, reputation damage | Internal alert, team ব্যাখ্যা দেয় | Feature release থামিয়ে reliability তে ফোকাস |
| কড়াকড়ি          | তুলনামূলক শিথিল                   | SLA এর চেয়ে কড়া                  | SLO থেকে derived                             |

---

## ২. Interview Angle

এই lesson এর concept গুলো interview এ প্রায়ই আসে এই ফর্মে:

> "তুমি এই system এর জন্য কী latency আর availability target ঠিক করবে, এবং কেন?"

ভালো উত্তরের কাঠামো: প্রথমে বলো system এর ধরন কী (real-time chat? batch reporting tool?), তারপর সেই অনুযায়ী একটা যুক্তিসঙ্গত target প্রস্তাব করো, এবং **p99 latency** (average না) এবং **"কয়টা নাইন" availability** — দুটোই specific সংখ্যায় বলো। যেমন: "যেহেতু এটা একটা real-time chat, আমি p99 latency টার্গেট করব ২০০ms এর নিচে, আর availability 99.9% — কারণ এটা একটা internal tool, payment system না, তাই 5-nines এর মতো ব্যয়বহুল infrastructure এখানে justify হয় না।"

আরেকটা common follow-up: "Error Budget concept টা কীভাবে decision-making এ সাহায্য করে?" — এখানে তোমার উত্তরে বলা উচিত এটা কীভাবে একটা **objective, data-driven** উপায় দেয় "কখন ঝুঁকি নেওয়া safe, কখন না" এই প্রশ্নের উত্তর দেওয়ার — শুধু gut feeling দিয়ে না।

---

## ৩. Key Takeaway

- **Latency** = একটা single request এর সময়। Average বিভ্রান্তিকর — **p99** ব্যবহার করো, কারণ সেটাই সবচেয়ে খারাপ অভিজ্ঞতা পাওয়া ইউজারদের অবস্থা দেখায়
- **Throughput** = system কতটা কাজ করতে পারে একক সময়ে (QPS)। Latency আর Throughput আলাদা জিনিস — parallelism দিয়ে throughput বাড়ানো যায় latency না কমিয়েও
- **Availability** = কতটা সময় system "up" থাকে। প্রতিটা অতিরিক্ত "নাইন" allowed downtime কে ~১০ গুণ কমায়, এবং exponentially বেশি costly
- **Reliability** = system সঠিকভাবে কাজ করছে কিনা, শুধু "up" থাকা যথেষ্ট না — Available কিন্তু Unreliable system প্রায়ই সবচেয়ে বিপজ্জনক কারণ এটা সহজে ধরা পড়ে না
- **SLA** = বাহ্যিক, চুক্তিভিত্তিক প্রতিশ্রুতি (penalty জড়িত থাকতে পারে)
- **SLO** = অভ্যন্তরীণ target, সাধারণত SLA এর চেয়ে কড়া (buffer রাখার জন্য)
- **Error Budget** = 100% - SLO target; এটা একটা measurable "অনুমোদিত ব্যর্থতার পরিমাণ" যেটা দিয়ে feature velocity বনাম stability এই সিদ্ধান্ত নেওয়া হয়

---

## ৪. নতুন Term (Glossary)

| Term                              | অর্থ                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| **Latency**                       | একটা single request সম্পন্ন হতে যে সময় লাগে                     |
| **Throughput**                    | একটা system একক সময়ে কতগুলো request process করতে পারে           |
| **Availability**                  | কতটা সময় system কার্যকরভাবে সাড়া দেয় (uptime / total time)    |
| **Reliability**                   | system তার কাজ কতটা সঠিকভাবে করছে, শুধু সাড়া দেওয়া না          |
| **SLA (Service Level Agreement)** | customer এর সাথে বাহ্যিক, চুক্তিভিত্তিক প্রতিশ্রুতি              |
| **SLO (Service Level Objective)** | টিমের অভ্যন্তরীণ target, সাধারণত SLA এর চেয়ে কড়া               |
| **Error Budget**                  | SLO থেকে derived, "কতটা ব্যর্থতা অনুমোদিত" তার measurable পরিমাণ |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর নিচের Answer Key দেখো।

1. তোমার একটা API এর average latency ৮০ms, কিন্তু p99 latency ৩ সেকেন্ড। এই পার্থক্য দেখে তুমি কী সন্দেহ করবে সমস্যাটা কোথায় হতে পারে?
2. একটা company দাবি করছে তাদের system "available" — server সবসময় সাড়া দেয়, HTTP 200 আসে। কিন্তু তুমি কীভাবে যাচাই করবে এটা আসলেই "reliable" কিনা, শুধু "available" না?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Average আর p99 এর মধ্যে এত বড় ফারাক (৮০ms vs ৩০০০ms) বলে দেয় যে **বেশিরভাগ request দ্রুত, কিন্তু একটা ছোট অংশ (~১%) কোনো কারণে খুবই ধীর**। এটা প্রায়ই ইঙ্গিত দেয় কোনো নির্দিষ্ট edge case বা resource contention আছে — যেমন, নির্দিষ্ট কিছু query database lock এ আটকে যাচ্ছে, বা কোনো নির্দিষ্ট user এর data set অস্বাভাবিক বড় (N+1 query problem, যেটা আমরা Module 5.6 তে দেখব), অথবা periodic garbage collection pause। মূল কথা — এই gap টা দেখেই বোঝা যায় সমস্যাটা "সবখানে সমানভাবে ছড়ানো" না, বরং নির্দিষ্ট কোনো condition এ ঘটছে, যেটা খুঁজে বের করা দরকার।

**প্রশ্ন ২:** Reliability যাচাই করতে হলে শুধু "response এসেছে কিনা" চেক করলে চলবে না — **response এর ভেতরের content সঠিক কিনা** সেটা যাচাই করতে হবে। এর জন্য দরকার হয় synthetic monitoring (নির্দিষ্ট known input দিয়ে test request পাঠিয়ে, expected output এর সাথে মিলিয়ে দেখা), error rate tracking (HTTP 200 আসলেও response body তে error message থাকতে পারে), এবং data correctness এর ওপর alert (যেমন, "task count হঠাৎ ০ হয়ে গেছে" — এটা সন্দেহজনক, যদিও server "up")। এই deeper monitoring টাই Module 10.4 তে বিস্তারিত আসবে।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow এর জন্য তোমাকে তিনটা ভিন্ন ধরনের feature-এর জন্য availability এবং latency target প্রস্তাব করতে হবে। প্রতিটার জন্য (a) কী availability target (কয়টা নাইন) দেবে, (b) p99 latency target কত দেবে, এবং (c) **এক লাইনে reasoning** — কেন এই feature এর জন্য এই target যুক্তিসঙ্গত (over-engineering বা under-engineering যেন না হয়):
>
> 1. **Login/Authentication** — ইউজার app এ ঢুকতে পারছে কিনা
> 2. **Task creation** — নতুন task তৈরি করা
> 3. **"Export to PDF" report** — মাসিক রিপোর্ট PDF আকারে ডাউনলোড করা, যেটা ইউজার সপ্তাহে হয়তো একবার ব্যবহার করে
>
> এরপর, ধরো তুমি Task creation feature এর জন্য SLO ঠিক করেছ 99.95%। এই মাসে (৩০ দিন ধরে হিসাব করো) তোমার **error budget কত মিনিট** দাঁড়ায়? (Lesson 1.5 এর নাইনস টেবিল আর সূত্র ব্যবহার করে হিসাব করো)

লক্ষ্য করো — এই তিনটা feature এর target একদম আলাদা হওয়ার কথা, কারণ প্রতিটার ব্যর্থ হওয়ার cost আলাদা। এটাই দেখাবে তুমি বুঝেছ কেন "সবকিছুতে 5 nines" একটা ভুল approach।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2, 1.3, 1.4
Current: 1.5 — Latency, Throughput, Availability, Reliability + SLA/SLO/Error Budget
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth,
TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC, Latency, Throughput, Availability, Reliability, SLA, SLO, Error Budget
Weak spots: Functional/Non-functional এ solution/constraint গুলিয়ে ফেলা (উন্নতি হচ্ছে);
HLD তে UI-state কে component ভাবা; Requirement মনোযোগ দিয়ে না পড়ে assumption নেওয়া;
Reasoning এ vague শব্দ ("ulta palta hote pare", "break hote pare") ব্যবহার করার প্রবণতা —
concrete mechanism বলার habit গড়ে তোলা দরকার
Next: 1.6 — Vertical vs Horizontal Scaling, Stateless vs Stateful
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষভাবে দেখব প্রতিটা feature এর target এর পেছনের reasoning যুক্তিসঙ্গত কিনা, আর error budget এর হিসাবটা সঠিক হয় কিনা। রেডি হলে `next` লিখো — Lesson 1.6 এ যাব, Module 1 এর শেষ lesson: Vertical vs Horizontal Scaling, আর Stateless vs Stateful — এই দুটো concept, যেগুলো পরের সব module (Load Balancing, Caching, Database Scaling) এর ভিত্তি তৈরি করবে।
