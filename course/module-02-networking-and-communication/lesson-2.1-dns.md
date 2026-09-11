# Lesson 2.1 — DNS কীভাবে কাজ করে: URL লেখা থেকে Response আসা পর্যন্ত পুরো Journey

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 1.6):** একটা server আসলেই "stateless" কিনা সেটা যাচাই করার সহজ practical test/shortcut টা কী ছিল?

**Prerequisite:** Lesson 1.4 (Client-Server, Connection Lifecycle)

**তুমি এই lesson শেষে পারবে:**

1. একটা domain name (যেমন `taskflow.app`) কীভাবে একটা IP address এ রূপান্তরিত হয় — পুরো ধাপগুলো বলতে পারবে
2. Recursive vs Authoritative DNS server, আর DNS caching/TTL কীভাবে কাজ করে — বুঝবে এবং ব্যাখ্যা করতে পারবে
3. DNS lookup latency কীভাবে কমানো যায় (caching, TTL tuning), এবং এটা কেন system design এ একটা গুরুত্বপূর্ণ optimization point — জানবে

**Tier:** 3 — Design Exercise (মূলত conceptual; শেষে একটা optional terminal command দিয়ে বাস্তবে DNS lookup দেখার সুযোগ দেব, কিন্তু সেটা formal Tier 1 exercise না)

---

## ০. TaskFlow এখন কোথায়

Lesson 1.4 তে আমরা client-server journey এর ৭টা ধাপ দেখেছিলাম, আর প্রথম ধাপ ছিল "DNS Lookup" — যেটাকে তখন আমরা শুধু mention করে রেখে দিয়েছিলাম, বলেছিলাম "এটা Lesson 2.1 এ পুরোপুরি খুলব"। আজকে সেই প্রতিশ্রুতি রাখার দিন।

ভাবো — তুমি browser এ লিখলে `https://taskflow.app`। তোমার কম্পিউটার তো জানে না TaskFlow এর server টা ঠিক কোথায় আছে (কোন IP address এ) — এটা যেন তুমি একজন মানুষের নাম জানো, কিন্তু তার ঠিকানা জানো না। DNS হলো ঠিক সেই "ফোন বই" বা "ঠিকানা বই" যেটা নাম দিয়ে ঠিকানা খুঁজে দেয়। এই lookup process টা কতটা efficient, সেটা তোমার app এর প্রথম response আসতে কতক্ষণ লাগবে তার ওপর সরাসরি প্রভাব ফেলে।

---

## ১. Theory

### ১.১ কেন DNS দরকার

Computer network এ প্রতিটা machine একটা সংখ্যা দিয়ে identify হয় — **IP address** (যেমন `104.21.45.67`)। কিন্তু মানুষের জন্য সংখ্যা মনে রাখা কঠিন, নাম মনে রাখা সহজ। তাই **DNS (Domain Name System)** — এটা একটা distributed, hierarchical system যেটা মানুষ-পঠনযোগ্য domain name (যেমন `taskflow.app`) কে machine-পঠনযোগ্য IP address এ রূপান্তর করে।

### ১.২ পুরো Lookup Journey — ধাপে ধাপে

তুমি browser এ `taskflow.app` লিখলে, নিচের ধাপগুলো ঘটে:

```
Browser                Local DNS         Root          TLD           Authoritative
(তোমার device)          Resolver         Server        Server        Name Server
   │                   (ISP/8.8.8.8)    (.)            (.app)        (taskflow.app এর নিজস্ব)
   │                       │              │              │                  │
   │──"taskflow.app        │              │              │                  │
   │   এর IP কী?"────────>│              │              │                  │
   │                       │──".app domain │              │                  │
   │                       │  কে সামলায়   │              │                  │
   │                       │  কে?"───────>│              │                  │
   │                       │<──".app এর    │              │                  │
   │                       │   TLD server  │              │                  │
   │                       │   এর ঠিকানা"──│              │                  │
   │                       │                              │                  │
   │                       │──"taskflow.app এর             │                  │
   │                       │  authoritative server কে?"──>│                  │
   │                       │<──"এই ঠিকানায়              │                  │
   │                       │   জিজ্ঞেস করো"──────────────│                  │
   │                       │                                                 │
   │                       │──"taskflow.app এর IP কত?"────────────────────>│
   │                       │<──"104.21.45.67"──────────────────────────────│
   │<──"104.21.45.67"──────│                                                 │
   │                       │
   │ [এখন browser জানে IP address, TCP connection শুরু করতে পারে —
   │  এখান থেকেই Lesson 1.4 এর journey শুরু হয়]
```

চারটা মূল অংশ চেনা দরকার:

- **Local DNS Resolver** — সাধারণত তোমার ISP, বা তুমি নিজে ঠিক করা কোনো public resolver (Google এর `8.8.8.8`, Cloudflare এর `1.1.1.1`)। এটাই তোমার প্রথম প্রশ্ন receive করে এবং বাকি সব query "তোমার হয়ে" করে দেয়
- **Root Server** — DNS hierarchy এর সবচেয়ে উপরে, শুধু বলে দেয় "`.app` TLD কে কোন server সামলায়"
- **TLD (Top-Level Domain) Server** — `.app`, `.com`, `.org` — প্রতিটার নিজস্ব TLD server আছে, যেটা বলে দেয় নির্দিষ্ট domain এর authoritative server কোনটা
- **Authoritative Name Server** — যেটা আসলে `taskflow.app` এর সঠিক IP address জানে (এটা সাধারণত তোমার DNS provider, যেমন Cloudflare DNS, Route 53)

লক্ষ্য করো — Local Resolver যে queries গুলো Root, TLD, আর Authoritative server এর কাছে পাঠাচ্ছে, প্রতিটাই একটা করে **network round trip** (Lesson 1.4 এর RTT মনে আছে?)। এই পুরো chain টা যদি প্রতিবার নতুন করে করতে হতো, তাহলে প্রতিটা website visit এই DNS lookup এ অনেক সময় নষ্ট হতো।

### ১.৩ Caching এবং TTL — বারবার এই chain এড়ানোর উপায়

এই "বারবার একই কাজ করা ব্যয়বহুল" — এই pattern টা তোমার এতদিনে চেনা হয়ে যাওয়ার কথা (Keep-Alive এ connection reuse, Sequelize এ connection pool)। DNS এও একই সমাধান — **caching**।

প্রতিটা DNS record এর সাথে একটা **TTL (Time To Live)** সংখ্যা থাকে (সেকেন্ডে), যেটা বলে দেয় — "এই তথ্যটা কতক্ষণ পর্যন্ত cache করে রাখা নিরাপদ, তারপর আবার fresh query করতে হবে।"

```
প্রথম visit:
Browser -> Local Resolver -> [পুরো Root->TLD->Authoritative chain] -> IP পাওয়া গেল
                                    │
                                    ▼
                          Local Resolver এই IP টা cache করে রাখল,
                          সাথে TTL (ধরো ৩৬০০ সেকেন্ড = ১ ঘণ্টা)

পরের visit (৩০ মিনিট পরে, একই resolver থেকে):
Browser -> Local Resolver -> [cache এ আছে, TTL এখনো শেষ হয়নি] -> সরাসরি IP রিটার্ন
                              (Root/TLD/Authoritative কে কষ্ট করে জিজ্ঞেস করতে হলো না!)
```

**TTL এর trade-off:**

| TTL                                   | সুবিধা                                                           | অসুবিধা                                                                     |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **কম** (যেমন ৬০ সেকেন্ড)              | IP পরিবর্তন করলে দ্রুত propagate হয় (যেমন, server migrate করলে) | বারবার fresh lookup লাগে, latency বাড়ে, DNS infra তে বেশি load             |
| **বেশি** (যেমন ৮৬৪০০ সেকেন্ড = ১ দিন) | বেশিরভাগ request cache থেকেই সার্ভ হয়, দ্রুত এবং কম load        | IP পরিবর্তন করলে পুরনো cache থাকা users রা অনেকক্ষণ পুরনো IP তেই যেতে থাকবে |

**Interview এবং বাস্তব ক্ষেত্রে common scenario:** যদি তুমি একটা server migration করতে যাচ্ছ (পুরনো IP থেকে নতুন IP তে), তাহলে migration এর **আগেই** TTL কমিয়ে দিতে হয় (যেমন ২৪ ঘণ্টা থেকে ৫ মিনিটে), যাতে migration এর সময় বেশিরভাগ user দ্রুত নতুন IP তে switch করতে পারে, পুরনো cache এর জন্য আটকে না থাকে। এটা একটা practical পদক্ষেপ যেটা experienced ইঞ্জিনিয়াররা করে, কিন্তু junior রা ভুলে যায় — ফলে migration এর পরও অনেক ইউজার ঘণ্টার পর ঘণ্টা পুরনো, হয়তো বন্ধ হয়ে যাওয়া server এ request পাঠাতে থাকে।

### ১.৪ Recursive vs Iterative Query

তোমার browser আর Local Resolver এর মধ্যে যে query হয়, সেটা **Recursive** — মানে browser শুধু একটা প্রশ্ন করে ("IP কত?"), আর পুরো কষ্টের কাজ (Root, TLD, Authoritative এর কাছে ঘুরে ঘুরে জিজ্ঞেস করা) Local Resolver নিজে করে, browser কে জড়ায় না।

কিন্তু Local Resolver আর Root/TLD/Authoritative server দের মধ্যে যে query হয়, সেটা **Iterative** — প্রতিটা server শুধু "পরের কোথায় জিজ্ঞেস করতে হবে" সেটা বলে দেয়, নিজে পুরো কাজ করে দেয় না। Root server "IP" বলে না, বলে "TLD server এর ঠিকানা এই" — এভাবে ধাপে ধাপে।

এই পার্থক্যটা মূলত **কে দায়িত্ব নিচ্ছে** সেটা নিয়ে — Recursive এ একটা মধ্যস্থতাকারী (Local Resolver) সব কাজ নিজে করে দেয়, Iterative এ প্রতিটা পক্ষ শুধু "পরের দিকনির্দেশনা" দেয়।

### ১.৫ Encrypted DNS — একটা current trend (web search দিয়ে verify করা হয়েছে)

একটা জিনিস যেটা এখন গুরুত্বপূর্ণ হয়ে উঠেছে — traditional DNS query **plaintext** এ যায়, মানে কেউ মাঝপথে (ISP, network observer) দেখতে পারে তুমি কোন domain visit করছ। এই privacy সমস্যা সমাধানের জন্য **DNS over HTTPS (DoH)** এবং **DNS over TLS (DoT)** এসেছে — এগুলো DNS query কে encrypt করে পাঠায়। আজকে (২০২৬ সালে) এই trend টা বেশ পরিণত হয়ে গেছে — Chrome, Firefox, Edge, Windows, এবং iOS এখন by default DoH সাপোর্ট করে, আর একটা নতুন variant DoH3, HTTP/3 এর ওপর ভিত্তি করে আরও গতি যোগ করে। Mozilla এর রিপোর্ট অনুযায়ী, US Firefox ইউজারদের মধ্যে DoH adoption ৮৫%-এর বেশি — মানে, encrypted DNS এখন আর niche জিনিস না, এটা mainstream হয়ে গেছে।

**এটা system design এর জন্য কেন গুরুত্বপূর্ণ:** DoH/DoT, DNS query কে HTTPS বা TLS এর ভেতরে wrap করে পাঠায়, তাই এটা সাধারণ traditional (plain UDP port 53) DNS lookup এর চেয়ে সামান্য বেশি overhead যোগ করতে পারে (কারণ এখন এটা নিজেই একটা TLS/HTTPS connection দাবি করে — Lesson 1.4 এর TLS handshake concept মনে আছে?)। কিন্তু privacy এর সুবিধা এতটাই গুরুত্বপূর্ণ যে এটাই এখন default হয়ে দাঁড়িয়েছে বেশিরভাগ modern browser এ। এটা জানাটা তোমার জন্য practical, কারণ latency debug করার সময় ("কেন request slow?") DNS layer এর এই সূক্ষ্ম পরিবর্তনও একটা factor হতে পারে, যদিও বেশিরভাগ ক্ষেত্রে এর প্রভাব খুবই সামান্য।

---

## ২. Interview Angle

DNS নিয়ে সবচেয়ে common interview প্রশ্ন হলো — "URL লেখা থেকে response আসা পর্যন্ত কী কী ঘটে, ব্যাখ্যা করো" (একে বলা হয় "What happens when you type a URL" — এটা একটা classic, প্রায় প্রতিটা company তে জিজ্ঞেস করা হয়)। ভালো উত্তরে DNS lookup (Root→TLD→Authoritative), TCP handshake, TLS handshake, HTTP request-response, browser rendering — সবগুলো ধাপ ধারাবাহিকভাবে বলতে পারা উচিত। আজকের আর গত lesson (1.4) মিলিয়ে তুমি এখন এই পুরো উত্তরটা দিতে পারবে।

আরেকটা follow-up যেটা প্রায়ই আসে: "কীভাবে DNS lookup latency কমাবে?" — উত্তরে caching/TTL, এবং **Anycast** (একটা advanced concept, যেখানে একই IP address world এর একাধিক জায়গা থেকে serve করা হয়, ব্যবহারকারীর কাছাকাছি location থেকে response আসে — এটা আমরা বিস্তারিত না গেলেও, নাম জানা ভালো, কারণ Cloudflare/Google এর মতো বড় DNS provider রা এটাই ব্যবহার করে) mention করা ভালো।

---

## ৩. Key Takeaway

- DNS হলো domain name কে IP address এ রূপান্তরের distributed hierarchical system
- Lookup chain: Local Resolver → Root Server → TLD Server → Authoritative Name Server
- Browser-Resolver query **Recursive** (resolver পুরো কাজ করে দেয়), Resolver-এর বাকি server গুলোর সাথে query **Iterative** (প্রতিটা শুধু পরের ঠিকানা বলে দেয়)
- **TTL** ঠিক করে কতক্ষণ একটা DNS record cache এ থাকবে — কম TTL দ্রুত propagation দেয় কিন্তু বেশি lookup লাগে, বেশি TTL কম lookup কিন্তু ধীর propagation
- Server migration এর আগে TTL কমিয়ে রাখাটা একটা practical, experienced-engineer এর habit
- DoH/DoT এখন mainstream (২০২৬ এ ৮৫%+ Firefox ইউজার DoH ব্যবহার করছে) — DNS query encrypt করে privacy বাড়ায়, সামান্য overhead যোগ করতে পারে

---

## ৪. নতুন Term (Glossary)

| Term                                 | অর্থ                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| **DNS (Domain Name System)**         | Domain name কে IP address এ রূপান্তরের distributed system                               |
| **Recursive Query**                  | যেখানে একটা server (Local Resolver) পুরো lookup কাজ নিজে করে দেয়, caller কে জড়ায় না  |
| **Iterative Query**                  | যেখানে প্রতিটা server শুধু "পরে কোথায় জিজ্ঞেস করতে হবে" বলে দেয়, নিজে পুরো কাজ করে না |
| **TTL (Time To Live)**               | একটা DNS record কতক্ষণ cache এ রাখা নিরাপদ, সেকেন্ডে প্রকাশিত                           |
| **Authoritative Name Server**        | একটা domain এর সঠিক, চূড়ান্ত DNS record রাখা server                                    |
| **DoH / DoT (DNS over HTTPS / TLS)** | encrypted DNS query পাঠানোর protocol, privacy বাড়ানোর জন্য                             |

---

## ৫. Reflection Questions

1. তুমি যদি TaskFlow এর server IP migrate করতে যাচ্ছ (পুরনো hosting থেকে নতুন hosting এ), migration এর ঠিক আগে TTL নিয়ে কী পদক্ষেপ নেবে, এবং কেন?
2. Recursive আর Iterative query এর পার্থক্যটা নিজের ভাষায়, একটা ছোট analogy দিয়ে ব্যাখ্যা করো (lesson এর ডিজিটাল উদাহরণ ছাড়া, নিজের মতো করে)।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Migration এর কিছুদিন (বা ঘণ্টা) আগে TTL কে খুব কম (যেমন ৫ মিনিট) এ নামিয়ে রাখা উচিত। কারণ, যদি TTL আগে থেকেই বেশি থাকে (যেমন ১ দিন), তাহলে migration করার পরও অনেক Local Resolver এ পুরনো IP অনেকক্ষণ ধরে cache হয়ে থাকবে, ফলে অনেক user পুরনো (হয়তো বন্ধ হয়ে যাওয়া) server এ request পাঠাতে থাকবে। TTL আগে থেকে কমিয়ে রাখলে, migration এর সময় বেশিরভাগ resolver দ্রুত fresh lookup করবে এবং নতুন IP পাবে।

**প্রশ্ন ২:** একটা সম্ভাব্য analogy: ধরো তুমি একটা office এ গিয়ে receptionist কে জিজ্ঞেস করলে "অমুক ম্যানেজার এর রুম কোনটা?" — যদি receptionist নিজে গিয়ে খুঁজে এনে বলে "উনি এখন এই রুমে আছেন", সেটা **recursive** (receptionist পুরো কাজ করে দিলো)। কিন্তু যদি receptionist বলে "৩য় তলায় যাও, সেখানে আরেকজনকে জিজ্ঞেস করো" — আর সেই তৃতীয় তলার লোকটা আবার বলে "৩০৫ নম্বর রুমে যাও" — এটা **iterative** (প্রতিটা ধাপ শুধু দিকনির্দেশনা দিচ্ছে, তোমাকে নিজে গিয়ে খুঁজতে হচ্ছে)।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow এর domain `taskflow.app`। তোমার DevOps টিম ঠিক করেছে তারা প্রতি ৩ মাসে server infrastructure পরিবর্তন করবে (নতুন provider এ migrate, cost optimization এর জন্য)। তারা তোমাকে জিজ্ঞেস করছে — **TaskFlow এর DNS record এর জন্য TTL কত রাখা উচিত?**
>
> চিন্তা করো এবং লেখো:
>
> 1. তুমি কী TTL প্রস্তাব করবে "normal" সময়ে (যখন কোনো migration হচ্ছে না)? কেন?
> 2. Migration এর ঠিক আগে-পরে TTL নিয়ে কী পরিবর্তন করবে?
> 3. যদি TaskFlow প্রতিদিন migrate করত (hypothetically, খুবই ঘন ঘন), TTL strategy কীভাবে বদলাতো?

এখানে "সঠিক সংখ্যা" নেই — যুক্তি আর trade-off বোঝাটাই আসল লক্ষ্য।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge
Current: 2.1 — DNS
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): System Design, Scale, Trade-off, Functional/Non-functional
Requirement, Scope, Estimation, HLD, Deep Dive, Black Box, DAU, QPS, Peak QPS,
Order of Magnitude, TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive,
Head-of-Line Blocking, Multiplexing, QUIC, Latency, Throughput, Availability,
Reliability, SLA, SLO, Error Budget, Vertical/Horizontal Scaling, SPOF,
Stateful/Stateless
Terms learned (Module 2 so far): DNS, Recursive Query, Iterative Query, TTL,
Authoritative Name Server, DoH/DoT
Weak spots: Multi-part প্রশ্নের সব sub-part কভার করা; নিজের terminology (যেমন
"consistency" vs "isolation") নির্ভুলভাবে ব্যবহার করা; একটা সংখ্যা হিসাব করে অন্যটা
ব্যবহার করলে সেটার justification স্পষ্টভাবে লেখা
New capability note: এখন থেকে version-dependent/current fact গুলো web search দিয়ে
verify করে বলা হবে (user এর অনুরোধে যোগ করা হয়েছে)
Next: 2.2 — TCP vs UDP, TLS Handshake (গভীরে)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 2.2 এ যাব: TCP vs UDP এর মূল পার্থক্য, আর TLS handshake টা আরেকটু গভীরে (Lesson 1.4 তে আমরা শুধু উপর থেকে ছুঁয়ে গিয়েছিলাম, এবার ভেতরের mechanism দেখব)।
