# Lesson 2.4 — WebSocket, SSE, Long Polling (Real-time Communication)

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 2.2):** TLS 1.3 কেন TLS 1.2 এর চেয়ে কম round trip এ handshake সম্পন্ন করতে পারে? আর 0-RTT কোন ধরনের operation এ ব্যবহার করা উচিত না, কেন?

**Prerequisite:** Lesson 1.4 (Connection Lifecycle), 2.2 (TCP/UDP, TLS), 2.3 (API paradigm)

**তুমি এই lesson শেষে পারবে:**

1. Long Polling, SSE, আর WebSocket — এই তিনটা real-time communication পদ্ধতির কাজের ধরন এবং পার্থক্য ব্যাখ্যা করতে পারবে
2. কোন scenario তে কোনটা উপযুক্ত সেটা bidirectional-ity এবং complexity এর ভিত্তিতে সিদ্ধান্ত নিতে পারবে
3. Lesson 1.1 এর "TaskFlow Real-time Notification" exercise এ ফিরে গিয়ে, এখন সেই সমাধান actually বেছে নিতে পারবে, reasoning সহ

**Tier:** 3 — Design Exercise (Module 3-4 এর hands-on এ WebSocket/SSE actual implementation আসবে, আজকে conceptual foundation)

---

## ০. TaskFlow এখন কোথায়

তোমার মনে আছে কি — Lesson 1.1 তে, একদম কোর্সের শুরুতে, আমরা "TaskFlow এ real-time notification" নিয়ে একটা exercise করেছিলাম? তখন তুমি নিজেই লিখেছিলে non-functional requirement হিসেবে — "socket naki push notification" — আর আমি বলেছিলাম এটা এখনই ঠিক করার বিষয় না, এটা "Solution", পরে আসবে।

**এখন সেই "পরে" এসে গেছে।** আজকে আমরা exactly সেই প্রশ্নের উত্তর দেব — client কে server থেকে "push" করে notification পাঠানোর জন্য ঠিক কোন mechanism ব্যবহার করব, আর কেন।

একটা মৌলিক সমস্যা দিয়ে শুরু করি — HTTP এর design ই হলো **client প্রথমে request করবে, তারপর server response দেবে**। Server নিজে থেকে client কে কিছু পাঠাতে পারে না, যতক্ষণ না client কিছু জিজ্ঞেস করছে। কিন্তু "task assign হলে সাথে সাথে notification" — এখানে server কেই তো proactively কিছু বলতে হবে, client জিজ্ঞেস না করেও! এই মৌলিক দ্বন্দ্ব থেকেই আজকের তিনটা সমাধান এসেছে।

---

## ১. Theory

### ১.১ Long Polling — HTTP দিয়ে "push" এর ভান করা

সবচেয়ে সহজ (এবং সবচেয়ে পুরনো) সমাধান — **Long Polling**। ধারণাটা সহজ: client একটা request পাঠায়, কিন্তু server **সাথে সাথে response দেয় না** — বরং request টা "ধরে রাখে" (hold), যতক্ষণ না নতুন কোনো data আসে (বা একটা timeout হয়ে যায়)। যখনই নতুন data আসে, server তখনই response পাঠিয়ে দেয় — client সাথে সাথে আরেকটা নতুন request পাঠায়, আর চক্রটা আবার শুরু হয়।

```
Client                                    Server
  │──"নতুন notification আছে?"────────────>│
  │                                        │ [request ধরে রাখা হলো...
  │                                        │  ...কোনো নতুন data নেই এখনো...]
  │                                        │
  │                          [৩০ সেকেন্ড পর একটা নতুন task assign হলো!]
  │<──"হ্যাঁ, এই notification"──────────────│
  │──"নতুন notification আছে?"────────────>│ (সাথে সাথেই আরেকটা request)
  │                                        │ [আবার ধরে রাখা...]
```

**সুবিধা:** সাধারণ HTTP ব্যবহার করে, তাই কোনো special protocol/library লাগে না, প্রতিটা server/proxy/firewall এটা বোঝে।

**সমস্যা:** প্রতিটা "round" এ একটা নতুন HTTP request/connection লাগে (Lesson 1.4 এর handshake cost মনে আছে?), যেটা resource-inefficient। আর যদি অনেকগুলো client একসাথে "held" connection রাখে, server এর অনেক resource (thread/connection slot) আটকে থাকে।

### ১.২ SSE (Server-Sent Events) — এক-দিকের Push, HTTP এর ওপরেই

**SSE** একটা elegant সমাধান — এটা একটা **single, persistent HTTP connection** খোলে, আর সেই connection দিয়ে server যতবার ইচ্ছা data পাঠাতে থাকতে পারে, connection বন্ধ না করে। Browser এ এর জন্য একটা built-in API আছে — `EventSource`।

```
Client                                    Server
  │──"EventSource connection খোলো"───────>│
  │<──[connection open থেকে যায়]───────────│
  │<──"notification 1"─────────────────────│
  │<──"notification 2"─────────────────────│
  │<──"notification 3"─────────────────────│
  │  (connection বন্ধ হয় না, server যতবার ইচ্ছা push করতে পারে)
```

**সুবিধা:**

- Long Polling এর মতো বারবার নতুন connection লাগে না — একটাই connection, তার ওপর দিয়ে multiple event
- Browser এ built-in **automatic reconnection** আছে (connection কোনো কারণে ভেঙে গেলে, `EventSource` নিজে থেকেই আবার connect করার চেষ্টা করে)
- সাধারণ HTTP/1.1 বা HTTP/2 এর ওপর কাজ করে, তাই firewall/proxy friendly

**সীমাবদ্ধতা:**

- **One-directional শুধু** — Server থেকে Client এ data যেতে পারে, কিন্তু Client থেকে Server এ SSE দিয়ে কিছু পাঠানো যায় না (দরকার হলে আলাদা normal HTTP request পাঠাতে হয়)
- Text-based (UTF-8) — binary data সরাসরি পাঠানো যায় না সহজে

### ১.৩ WebSocket — সম্পূর্ণ Bidirectional, দুই দিকেই সমান দ্রুত

**WebSocket** সবচেয়ে শক্তিশালী সমাধান — এটা একটা **সত্যিকারের full-duplex connection** স্থাপন করে, মানে Client এবং Server, দুই পক্ষই যেকোনো সময় একে অপরকে data পাঠাতে পারে, স্বাধীনভাবে।

WebSocket শুরু হয় একটা সাধারণ HTTP request দিয়ে, যেটা "Upgrade" header ব্যবহার করে বলে — "আমরা এই connection টাকে HTTP থেকে WebSocket protocol এ পরিবর্তন করতে চাই":

```
Client                                    Server
  │──HTTP GET + "Upgrade: websocket"──────>│
  │<──"101 Switching Protocols"────────────│
  │ [এখন থেকে এটা আর HTTP connection না, এটা WebSocket connection]
  │
  │──"আমি একটা message পাঠাচ্ছি"──────────>│
  │<──"notification 1"──────────────────────│
  │──"আমিও একটা message পাঠাচ্ছি"─────────>│
  │<──"notification 2"──────────────────────│
  (দুই দিকেই, স্বাধীনভাবে, যেকোনো সময়ে data যেতে পারে)
```

**সুবিধা:**

- সত্যিকারের bidirectional — chat application, collaborative editing (একসাথে অনেকে একটা document edit করা), multiplayer game — এসবের জন্য আদর্শ
- সবচেয়ে কম latency, কারণ একবার connection উঠলে প্রতিটা message এ কোনো নতুন HTTP overhead নেই
- Binary এবং text, দুই ধরনের data ই পাঠানো যায়

**সীমাবদ্ধতা:**

- সবচেয়ে বেশি জটিলতা — connection state manage করা, reconnection logic নিজে লিখতে হয় (SSE এর মতো built-in না — যদিও Socket.io এর মতো library এই সমস্যা সমাধান করে)
- WebSocket একটাই stream এর ওপর কাজ করে একটা connection এ, তাই TCP-level head-of-line blocking এর শিকার হতে পারে — একটা packet delay/loss হলে, তার পরের সব message ও আটকে যায় (Lesson 2.2 এর সেই concept, এখানে আবার প্রাসঙ্গিক)
- Load balancer এর পেছনে horizontal scaling করতে গেলে জটিলতা বাড়ে (Lesson 1.6 এর stateful/stateless মনে আছে? — WebSocket connection নিজেই একটা stateful জিনিস, একটা নির্দিষ্ট server এর সাথে বাঁধা থাকে, এই সমস্যা আমরা Module 3 তে বিস্তারিত দেখব)

> **Trade-off Table — Long Polling vs SSE vs WebSocket**

| দিক            | Long Polling                              | SSE                                           | WebSocket                           |
| -------------- | ----------------------------------------- | --------------------------------------------- | ----------------------------------- |
| Direction      | Client-initiated, server-delayed response | Server → Client (one-way)                     | দুই দিকেই (full-duplex)             |
| Connection     | বারবার নতুন request                       | একটাই persistent connection                   | একটাই persistent connection         |
| Browser API    | সাধারণ `fetch`/XHR                        | `EventSource` (built-in)                      | `WebSocket`                         |
| Auto-reconnect | নিজে লিখতে হয়                            | Built-in                                      | নিজে লিখতে হয় (বা library)         |
| Complexity     | কম                                        | কম-মাঝারি                                     | বেশি                                |
| Best fit       | Fallback option, সাধারণ notification      | One-way live feed (stock price, notification) | Chat, collaborative editing, gaming |

### ১.৪ ২০২৬-এর নতুন সদস্য — WebTransport (web search দিয়ে verify করা হয়েছে)

WebTransport হলো একটা নতুন browser API, HTTP/3 এবং QUIC (Lesson 1.4 এর সেই QUIC!) এর ওপর তৈরি, যেটা bidirectional communication দেয়, কিন্তু WebSocket এর মতো "Upgrade" এর দরকার নেই — এটা native ভাবেই HTTP/3 এর অংশ।

এর সবচেয়ে বড় সুবিধা — এটা reliable stream এবং "unreliable datagram" — দুই ধরনের data-ই একসাথে পাঠাতে পারে, একই connection এ, WebSocket এর head-of-line blocking সমস্যা ছাড়াই। মানে, একটা connection এর মধ্যেই তুমি বলে দিতে পারো "এই message টা নিশ্চিতভাবে পৌঁছাতে হবে" (reliable stream) বনাম "এই data টা miss হলেও সমস্যা নেই, পরেরটা এলেই চলবে" (unreliable datagram, যেমন — Lesson 2.2 এর সেই "live cursor position" উদাহরণ)।

**তবে বর্তমান বাস্তবতা:** ২০২৬ সালে, WebSocket এখনও real-time communication এর সবচেয়ে নিরাপদ default choice, কারণ এটা প্রায় সর্বজনীনভাবে সাপোর্টেড। WebTransport শক্তিশালী যেখানে multiple independent stream বা unreliable datagram এর সুবিধা দরকার, কিন্তু সাধারণ reliable messaging এর জন্য WebSocket এখনও সহজ এবং যথেষ্ট ভালো পছন্দ। বেশিরভাগ team এর জন্য সঠিক approach হলো WebTransport কে একটা enhancement হিসেবে যোগ করা, WebSocket কে fallback রেখে — সম্পূর্ণ replace করে ফেলা না।

**তোমার জন্য practical takeaway:** TaskFlow এর মতো একটা project এর জন্য, আজকে (২০২৬ এ) WebSocket ই সঠিক এবং safe পছন্দ। WebTransport সম্পর্কে জানাটা ভালো (এটা ভবিষ্যতের দিকনির্দেশনা বোঝায়), কিন্তু এখনই এটা ব্যবহার করার কোনো practical কারণ নেই একটা internal team tool এর জন্য।

---

## ২. Interview Angle

এই টপিকের classic interview প্রশ্ন — "তুমি একটা real-time chat feature ডিজাইন করছ, WebSocket, SSE, নাকি Long Polling ব্যবহার করবে?" ভালো উত্তরের মূল কাঠামো — **"এটা কি bidirectional communication দরকার?"** এই প্রশ্ন দিয়ে শুরু করা:

- Chat — bidirectional (দুই পক্ষই message পাঠায়) → **WebSocket**
- Stock price ticker, live score update — one-way (শুধু server push করছে) → **SSE** (WebSocket দিয়েও করা যায়, কিন্তু SSE সহজ এবং এই কাজের জন্য যথেষ্ট, over-engineering এড়ানো যায়)
- Notification badge (আমাদের TaskFlow example) — মূলত one-way, তাই SSE একটা ভালো fit, যদিও অনেক production system WebSocket ব্যবহার করে কারণ একটা connection দিয়ে অনেক ধরনের feature (chat + notification + presence) একসাথে সামলানো সহজ

**একটা গুরুত্বপূর্ণ follow-up যেটা interviewer জিজ্ঞেস করতে পারে:** "WebSocket horizontal scale করবে কীভাবে?" — এটা একটা advanced প্রশ্ন যেটার উত্তর এখনই সম্পূর্ণ দেওয়া কঠিন (Module 3-4 লাগবে), কিন্তু এখন এইটুকু বলতে পারলেই যথেষ্ট: "যেহেতু WebSocket connection stateful (একটা নির্দিষ্ট server এর সাথে বাঁধা), multiple server এর মধ্যে message broadcast করতে একটা shared pub/sub layer (যেমন Redis Pub/Sub) লাগে, যাতে Server A তে connected client, Server B তে ঘটা একটা event সম্পর্কে জানতে পারে।" — এই উত্তরটা দেখায় তুমি সমস্যাটা বোঝো, যদিও পুরো সমাধান এখনও শেখোনি।

---

## ৩. Key Takeaway

- HTTP এর মৌলিক সীমাবদ্ধতা — client initiate করে, server নিজে থেকে push করতে পারে না — এই তিনটা সমাধানের মূল কারণ
- **Long Polling** — বারবার request "hold" করে রাখা, সহজ কিন্তু resource-inefficient
- **SSE** — একটা persistent connection, one-directional (server→client), built-in reconnection, simple use case এর জন্য যথেষ্ট
- **WebSocket** — সত্যিকারের bidirectional, সবচেয়ে শক্তিশালী কিন্তু সবচেয়ে জটিল, chat/gaming/collaborative editing এর জন্য আদর্শ
- WebSocket, TCP-based হওয়ায় head-of-line blocking এর শিকার হতে পারে; WebTransport (HTTP/3/QUIC ভিত্তিক) এটা সমাধান করে, কিন্তু ২০২৬ এ এখনও WebSocket ই practical default
- সিদ্ধান্তের মূল প্রশ্ন: bidirectional দরকার কিনা? — উত্তর অনুযায়ী WebSocket বা SSE বেছে নাও

---

## ৪. নতুন Term (Glossary)

| Term                         | অর্থ                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Long Polling**             | client এর request server "hold" করে রাখে যতক্ষণ না নতুন data আসে                                           |
| **SSE (Server-Sent Events)** | একটা persistent, one-directional (server→client) HTTP connection                                           |
| **WebSocket**                | একটা persistent, bidirectional (full-duplex) connection, HTTP "Upgrade" দিয়ে শুরু হয়                     |
| **Full-Duplex**              | যোগাযোগের একটা মাধ্যম যেখানে দুই পক্ষই একই সময়ে, স্বাধীনভাবে data পাঠাতে পারে                             |
| **WebTransport**             | HTTP/3/QUIC ভিত্তিক একটা নতুন bidirectional API, reliable stream এবং unreliable datagram উভয়ই সাপোর্ট করে |

---

## ৫. Reflection Questions

1. Lesson 1.1 এর TaskFlow "real-time notification" exercise এ ফিরে যাও। এখন এই lesson শেখার পর, তুমি কোনটা বেছে নেবে — Long Polling, SSE, নাকি WebSocket? তোমার সিদ্ধান্তের কারণ দাও (TaskFlow এ শুধু notification push করা লাগে, নাকি bidirectional কিছু দরকার — এটা ভাবো)।
2. WebSocket "stateful" (Lesson 1.6 এর term) কেন — এটা horizontal scaling এ কী challenge তৈরি করে, নিজের ভাষায় সংক্ষেপে বলো।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** TaskFlow এর "task assign হলে notification" এই ব্যবহারের ক্ষেত্রে, মূল প্রয়োজন হলো server থেকে client এ push করা — client কে server এ কিছু "পাঠাতে" হচ্ছে না এই flow তে (client শুধু receive করছে)। তাই strictly এই ব্যবহারের জন্য **SSE** যথেষ্ট এবং যুক্তিসঙ্গত — এটা simpler, built-in reconnection আছে, এবং over-engineering এড়ায়। তবে বাস্তবে, যদি TaskFlow ভবিষ্যতে chat বা live collaboration ফিচারও যোগ করার পরিকল্পনা করে, তাহলে শুরু থেকেই **WebSocket** বেছে নেওয়া (এমনকি যদি এখনই bidirectional দরকার না হয়) একটা reasonable forward-looking decision হতে পারে, যাতে ভবিষ্যতে আলাদা mechanism আবার বানাতে না হয়। এই দুটো উত্তরই defensible — গুরুত্বপূর্ণ হলো reasoning স্পষ্টভাবে বলা।

**প্রশ্ন ২:** WebSocket connection একটা নির্দিষ্ট client, একটা নির্দিষ্ট server এর সাথে persistent ভাবে বাঁধা থাকে — এই connection টা server এর memory তে "state" হিসেবে বসে থাকে (কোন client কোন server এ connected, সেই তথ্য)। Horizontal scaling এ, যদি একাধিক server থাকে, আর Client A, Server 1 এ connected থাকে, কিন্তু একটা event Server 2 তে trigger হয় (হয়তো অন্য একটা request সেই server এ গিয়েছিল), তাহলে Server 2 নিজে থেকে Client A কে কিছু বলতে পারবে না — কারণ Client A এর সাথে connection টা তো Server 1 এর কাছে। এই সমস্যা সমাধানের জন্য একটা shared coordination mechanism (যেমন Redis Pub/Sub) লাগে, যাতে সব server একে অপরের সাথে "কে কোন client ধরে আছে" এই তথ্য শেয়ার করতে পারে।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow এ তিনটা নতুন feature প্রস্তাবিত হয়েছে। প্রতিটার জন্য বলো — Long Polling, SSE, নাকি WebSocket, আর কেন (bidirectional প্রয়োজনীয়তা এবং complexity trade-off বিবেচনা করে):
>
> 1. **"Team Presence Indicator"** — কে এখন online আছে, TaskFlow এ active আছে, সেটা একটা green dot দিয়ে সবাইকে দেখানো
> 2. **"Live Comment Thread"** — একটা task এর নিচে সবাই comment করতে পারে, এবং নতুন comment এলে সাথে সাথে সবার screen এ update হয়ে যায় (কেউ যদি typing করছে সেটাও দেখানো হয় — "Hijikesh is typing...")
> 3. **"Simple Server Status Page"** — একটা internal page যেখানে TaskFlow এর server এর CPU/memory usage প্রতি ৫ সেকেন্ডে update হয়, শুধু কয়েকজন admin দেখে

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, 2.1, 2.2, 2.3
Current: 2.4 — WebSocket, SSE, Long Polling
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): [System Design, Trade-off, Requirements, Scope, Estimation,
HLD/Deep Dive, DAU/QPS, TCP Handshake, TLS, Latency/Throughput, Availability/
Reliability, SLA/SLO/Error Budget, Scaling, Stateless/Stateful]
Terms learned (Module 2 so far): DNS, TTL, Recursive/Iterative Query, DoH/DoT,
TCP vs UDP, Cipher Suite, 0-RTT, REST, GraphQL, N+1 Problem, gRPC, Protobuf,
Long Polling, SSE, WebSocket, Full-Duplex, WebTransport
Weak spots: Multi-part প্রশ্নের সব sub-part কভার করা; trade-off বলার সময় শুধু সুবিধা না,
cost/ছাড় (কী হারাচ্ছি) স্পষ্টভাবে বলা (2.3 এর GraphQL answer এ এই gap ছিল) — এটাই এখন
মূল focus area, বাকি সব দিক ভালো উন্নতি দেখাচ্ছে
Next: 2.5 — API Design at Scale (Versioning, Pagination, Idempotency Key, Error Contract)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 2.5 এ যাব, Module 2 এর শেষ lesson: API Design at Scale — versioning, pagination, idempotency key, error contract। এটা একটা বিশেষভাবে গুরুত্বপূর্ণ lesson তোমার জন্য, কারণ idempotency তোমার fintech কাজের সাথে সরাসরি সম্পর্কিত একটা concept।
