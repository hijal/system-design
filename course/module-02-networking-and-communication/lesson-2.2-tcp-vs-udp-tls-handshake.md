# Lesson 2.2 — TCP vs UDP, TLS Handshake Deep Dive

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 1.5):** SLO (Service Level Objective) সাধারণত SLA (Service Level Agreement) এর চেয়ে "কড়া" (stricter) রাখা হয় — কেন? এই ব্যবধানটার (gap) সুবিধা কী?

**Prerequisite:** Lesson 1.4 (Connection Lifecycle intro), 2.1 (DNS)

**তুমি এই lesson শেষে পারবে:**

1. TCP আর UDP এর মূল পার্থক্য (reliability, ordering, overhead) বলতে পারবে, এবং কখন কোনটা বেছে নেওয়া উচিত — বুঝবে
2. TLS handshake এর ভেতরের ধাপগুলো (certificate validation, key exchange) বিস্তারিতভাবে ব্যাখ্যা করতে পারবে
3. TLS 1.2 আর TLS 1.3 এর মধ্যে round-trip পার্থক্য কেন হয়, এবং "0-RTT" কী সুবিধা দেয় — জানবে

**Tier:** 3 — Design Exercise

---

## ০. TaskFlow এখন কোথায়

Lesson 1.4 তে আমরা TLS handshake কে একটা "black box" হিসেবে দেখেছিলাম — শুধু বলেছিলাম "কিছু একটা key exchange হয়, ১-২ round trip লাগে"। আজকে সেই black box টা খুলব। আর একই সাথে, এতদিন আমরা ধরে নিয়েছিলাম TaskFlow এর সব communication **TCP** এর ওপর হয় — আজকে দেখব কেন এটা সবসময় সঠিক পছন্দ না, এবং **UDP** কখন ভালো বিকল্প হতে পারে।

---

## ১. Theory

### ১.১ TCP vs UDP — মূল পার্থক্য

Lesson 1.4 তে আমরা TCP এর 3-way handshake দেখেছি। কিন্তু TCP আসলে একটা বড় পরিবারের একটা সদস্য মাত্র — **Transport Layer** এ দুটো প্রধান protocol আছে: TCP আর UDP। তাদের মূল দার্শনিক পার্থক্য:

**TCP (Transmission Control Protocol)** — এর মূলমন্ত্র হলো **"নিশ্চিত ডেলিভারি"**। এটা guarantee দেয়:

- **Reliability** — যদি কোনো packet হারিয়ে যায়, TCP সেটা আবার পাঠায় (retransmission)
- **Ordering** — packet গুলো যে ক্রমে পাঠানো হয়েছিল, ঠিক সেই ক্রমেই পৌঁছাবে (এমনকি যদি নেটওয়ার্কে সেগুলো আলাদা path এ গিয়ে উল্টাপাল্টা ক্রমে পৌঁছায়, TCP সেগুলো সঠিক ক্রমে সাজিয়ে দেয়)
- **Connection-oriented** — handshake করে connection স্থাপন করতে হয় (Lesson 1.4)

এই guarantee গুলোর একটা cost আছে — extra overhead (handshake, acknowledgment packet, retransmission logic)।

**UDP (User Datagram Protocol)** — এর মূলমন্ত্র হলো **"দ্রুত পাঠাও, guarantee নেই"**:

- **No reliability guarantee** — packet হারিয়ে গেলে UDP নিজে থেকে আবার পাঠায় না (application কে নিজে handle করতে হয়, যদি দরকার হয়)
- **No ordering guarantee** — packet গুলো ভিন্ন ক্রমে পৌঁছাতে পারে
- **Connectionless** — কোনো handshake লাগে না, সরাসরি data পাঠানো শুরু করা যায়

```
TCP:                                    UDP:
Client                Server            Client                Server
  │──SYN─────────────>│                  │──Data Packet 1───────>│
  │<──SYN-ACK──────────│                  │──Data Packet 2───────>│
  │──ACK─────────────>│                  │──Data Packet 3───────>│
  │──Data + wait ACK──>│                  (কোনো handshake নেই,
  │<──ACK──────────────│                   কোনো "পৌঁছেছে কিনা"
  │──Data + wait ACK──>│                   confirmation নেই)
  │<──ACK──────────────│
  (প্রতিটা ধাপে confirmation, ধীর কিন্তু নির্ভরযোগ্য)  (দ্রুত, কিন্তু কোনো guarantee নেই)
```

> **Trade-off Table — TCP vs UDP**

| দিক            | TCP                                          | UDP                                           |
| -------------- | -------------------------------------------- | --------------------------------------------- |
| Reliability    | Guaranteed delivery                          | কোনো guarantee নেই                            |
| Ordering       | Guaranteed                                   | Guaranteed না                                 |
| Speed/Overhead | ধীর (handshake + ack)                        | দ্রুত (handshake নেই)                         |
| Connection     | Connection-oriented                          | Connectionless                                |
| Use case       | Web (HTTP/1.1, HTTP/2), file transfer, email | Video call, gaming, DNS query, live streaming |

**কেন কিছু ক্ষেত্রে UDP বেছে নেওয়া হয়:** ভাবো একটা video call — যদি একটা video frame এর packet হারিয়ে যায়, TCP এর মতো সেটা retransmit করে আবার পাঠানোর কোনো মানে নেই, কারণ ততক্ষণে পরের frame গুলো এসে গেছে — পুরনো frame এর জন্য অপেক্ষা করাটাই বরং call কে আরও কাটাকাটা (choppy) করে দেবে। এখানে **একটা frame miss হয়ে যাওয়া, delay হওয়ার চেয়ে ভালো** — এই কারণে video/audio streaming, live gaming, DNS query — এসব ক্ষেত্রে UDP প্রাধান্য পায়।

**তোমার জন্য একটা গুরুত্বপূর্ণ connection — HTTP/3 এবং QUIC:** Lesson 1.4 তে আমরা QUIC নিয়ে কথা বলেছিলাম, বলেছিলাম এটা "UDP-based"। এখন সেই কথাটার পূর্ণ অর্থ বোঝা যাচ্ছে — QUIC, UDP এর ওপর তৈরি (TCP এর ওপর না), কিন্তু নিজের মধ্যেই reliability আর ordering যোগ করে দিয়েছে (per-stream ভিত্তিতে, TCP এর মতো পুরো connection ভিত্তিতে না) — এইজন্যই QUIC, TCP এর head-of-line blocking সমস্যা এড়াতে পেরেছে, অথচ তাও reliable।

### ১.২ TLS Handshake — ভেতরের ধাপগুলো

Lesson 1.4 তে আমরা TLS handshake কে সংক্ষেপে দেখিয়েছিলাম। এখন এর ভেতরে ঢুকি — এটা আসলে ৩টা মূল কাজ করে:

1. **Server কে চেনা (Authentication)** — Client নিশ্চিত হয় সে আসলেই `taskflow.app` এর সাথে কথা বলছে, কোনো imposter এর সাথে না
2. **একটা সিক্রেট key নিয়ে সম্মত হওয়া (Key Exchange)** — যেটা দিয়ে বাকি সব communication encrypt হবে
3. **Encryption algorithm নিয়ে সম্মত হওয়া (Cipher Negotiation)** — কোন encryption method ব্যবহার হবে

**TLS 1.2 এ (২ Round Trip):**

```
Client                                          Server
  │──"Hello, আমি এই cipher গুলো সাপোর্ট করি"────>│
  │<──"ঠিক আছে, এইটা ব্যবহার করি + আমার           │
  │    certificate (আমার পরিচয়ের প্রমাণ)"────────│
  │──[Certificate যাচাই করে] "Key exchange        │
  │   data পাঠাচ্ছি"────────────────────────────>│
  │<──"Key exchange সম্পন্ন, নিশ্চিত করছি"─────────│
  │ [এখন থেকে সব communication encrypted]         │
```

**TLS 1.3 এ (১ Round Trip — একটা বড় improvement):**

TLS 1.3, ২০১৮ সালে RFC 8446 হিসেবে standardize হয়েছিল, এবং এটা handshake কে drastically simplify করেছে — client প্রথম message এই তার key exchange data অনুমান করে পাঠিয়ে দেয় (সাধারণ common cipher option গুলো ধরে নিয়ে), ফলে পুরো handshake মাত্র ১ round trip এ শেষ হয়ে যায়।

```
Client                                          Server
  │──"Hello + আমার key exchange guess          │
  │   (common cipher ধরে নিয়ে)"───────────────>│
  │<──"ঠিক আছে + certificate + key exchange     │
  │    confirm + finished"─────────────────────│
  │──"Finished, encrypted data শুরু"────────────>│
  │ [মাত্র ১ round trip এ handshake সম্পন্ন]      │
```

TLS 1.3 এর ১-RTT handshake, প্রতিটা নতুন connection এ নেটওয়ার্ক latency অনুযায়ী মোটামুটি ৫০-১০০ millisecond বাঁচায় TLS 1.2 এর তুলনায়। যদি TaskFlow এর কোনো user দূরবর্তী কোনো region এ থাকে (উচ্চ RTT), এই সাশ্রয়টা লক্ষণীয় হয়ে ওঠে, বিশেষ করে যদি একাধিক নতুন connection দরকার হয়।

**0-RTT — আরও একধাপ এগিয়ে:** যদি Client আগে একবার সেই Server এর সাথে connect করে থাকে (session resumption), TLS 1.3 এমনকি সেই ১ round trip টাও বাদ দিতে পারে — Client তার প্রথম message এর সাথেই আগের session এর একটা "pre-shared key" ব্যবহার করে encrypted application data পাঠিয়ে দেয়, আর Server সাথে সাথে সেটা process করতে পারে। তবে এখানে একটা গুরুত্বপূর্ণ security trade-off আছে — 0-RTT data replay attack এর ঝুঁকিতে থাকে, কারণ এটা handshake সম্পূর্ণ হওয়ার আগেই পাঠানো হয় — একজন attacker সেই data capture করে আবার পাঠাতে (replay করতে) পারে। এই কারণে 0-RTT সাধারণত শুধু idempotent operation এ (যেমন একটা cached page load করা) ব্যবহার করা উচিত, payment বা login এর মতো sensitive transaction এ এটা বন্ধ রাখা হয়। (Idempotency শব্দটা তোমার কাছে familiar — Module 7.4 তে formally আসবে, কিন্তু concept টা তোমার fintech কাজেও নিশ্চয়ই পরিচিত।)

### ১.৩ TLS এর বর্তমান অবস্থা (২০২৬, web search দিয়ে verify করা হয়েছে)

যেহেতু এটা একটা version-dependent তথ্য, আমি এটা যাচাই করে নিয়েছি — ২০২৬ সালের current standard হলো — TLS 1.0 এবং 1.1 সম্পূর্ণ বন্ধ থাকা উচিত (এগুলো known vulnerability এর শিকার, এবং সব major compliance standard এখন এগুলো নিষিদ্ধ করেছে), আর TLS 1.2 এখনও acceptable — এটা এখনও PCI DSS compliant এবং NIST এর ন্যূনতম অনুমোদিত ভার্সন, সব major browser এখনও এটা সাপোর্ট করে। তবে industry best practice হলো TLS 1.2 এবং TLS 1.3 উভয়ই চালু রাখা (TLS 1.3 কে primary preference হিসেবে), কারণ TLS 1.3 দ্রুত (handshake ২ round trip থেকে ১ এ নেমে আসে) এবং বেশি নিরাপদ।

**তোমার জন্য practical takeaway:** যদি তুমি Nginx বা Cloudflare এর মাধ্যমে TaskFlow এর TLS configure করো, `ssl_protocols TLSv1.2 TLSv1.3;` — এই ধরনের setting ব্যবহার করাই এখনকার (২০২৬) স্ট্যান্ডার্ড প্র্যাকটিস, TLS 1.0/1.1 কখনোই enable রাখা উচিত না।

---

## ২. Interview Angle

TCP vs UDP নিয়ে একটা common interview প্রশ্ন — "তুমি একটা real-time chat feature বানাচ্ছ (TaskFlow এর মতো), কোন protocol ব্যবহার করবে?" এখানে ভালো উত্তর নির্ভর করে চিন্তার ওপর — chat message miss হওয়া গ্রহণযোগ্য না (একটা message হারিয়ে গেলে conversation এর মানে হারিয়ে যায়), তাই এখানে TCP-ভিত্তিক solution (WebSocket, যেটা TCP এর ওপর চলে) দরকার, UDP না — এটা video call এর থেকে আলাদা, যেখানে একটা frame miss হওয়া acceptable।

TLS handshake নিয়ে একটা follow-up প্রশ্ন প্রায়ই আসে: "কীভাবে connection latency কমাবে HTTPS এ?" — ভালো উত্তরে TLS 1.3 তে upgrade করা, session resumption/0-RTT enable করা (সাবধানে, শুধু idempotent operation এ), আর keep-alive দিয়ে connection reuse করা (Lesson 1.4) — এই তিনটাই একসাথে mention করা প্রত্যাশিত।

---

## ৩. Key Takeaway

- TCP = reliable + ordered কিন্তু ধীর (handshake + ack overhead); UDP = দ্রুত কিন্তু কোনো guarantee নেই
- Video/audio streaming, gaming, DNS query — এসবে UDP প্রাধান্য পায় কারণ delay এর চেয়ে packet loss ভালো
- QUIC (HTTP/3 এর ভিত্তি) UDP এর ওপর তৈরি, কিন্তু নিজের মধ্যে per-stream reliability যোগ করে দিয়েছে
- TLS handshake এর কাজ: server authenticate করা, secret key নিয়ে সম্মত হওয়া, cipher ঠিক করা
- TLS 1.2 এ handshake নেয় ২ round trip, TLS 1.3 এ ১ round trip (~৫০-১০০ms সাশ্রয়)
- 0-RTT session resumption handshake latency সম্পূর্ণ বাদ দেয়, কিন্তু replay attack এর ঝুঁকি থাকায় শুধু idempotent operation এ ব্যবহার করা উচিত
- ২০২৬-এর current best practice: TLS 1.0/1.1 বন্ধ, TLS 1.2+1.3 উভয়ই সাপোর্ট রাখা, TLS 1.3 কে priority দেওয়া

---

## ৪. নতুন Term (Glossary)

| Term                                    | অর্থ                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **TCP (Transmission Control Protocol)** | reliable, ordered, connection-oriented transport protocol                                          |
| **UDP (User Datagram Protocol)**        | দ্রুত কিন্তু unreliable, connectionless transport protocol                                         |
| **Cipher Suite**                        | encryption algorithm এর একটা সেট, যেটা TLS handshake এ negotiate হয়                               |
| **0-RTT (Zero Round Trip Time)**        | TLS 1.3 এর একটা feature, যেখানে returning client কোনো round trip ছাড়াই encrypted data পাঠাতে পারে |
| **Replay Attack**                       | একটা captured (আগে পাঠানো) data packet আবার পাঠিয়ে সিস্টেমকে বিভ্রান্ত করার আক্রমণ                |

---

## ৫. Reflection Questions

1. TaskFlow এ যদি তুমি একটা "live cursor" feature বানাও (Google Docs এর মতো, যেখানে দেখা যায় টিমের অন্য সদস্য কোন task এ এখন কাজ করছে, real-time এ) — TCP নাকি UDP-ভিত্তিক solution বেছে নেবে, আর কেন?
2. 0-RTT কেন শুধু "idempotent" operation এ নিরাপদ, কিন্তু payment বা login এ নিরাপদ না — নিজের ভাষায় ব্যাখ্যা করো।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** এটা একটা interesting borderline case — cursor position এর মতো data, প্রতি মুহূর্তে বদলাচ্ছে এবং পুরনো position জানার তেমন মূল্য নেই (একটা cursor update miss হয়ে গেলে, পরের update এমনিতেই সঠিক অবস্থান জানিয়ে দেবে)। তাই এখানে UDP-এর দর্শনের সাথে ভালো মেলে (packet loss গ্রহণযোগ্য, latency কম রাখাটাই priority)। বাস্তবে, বেশিরভাগ web application এ এটা এখনও WebSocket (TCP-ভিত্তিক) দিয়েই implement হয়, কারণ browser এ raw UDP access সহজলভ্য না, আর TCP এর overhead এই ছোট scale এ তেমন সমস্যা করে না। কিন্তু conceptually, যদি raw protocol choice এর প্রশ্ন হয়, UDP-এর যুক্তি এখানে প্রযোজ্য।

**প্রশ্ন ২:** Idempotent operation মানে — একই operation একাধিকবার চললেও ফলাফল একই থাকে (যেমন, "এই page load করো" — দুইবার load করলেও কোনো ক্ষতি নেই)। কিন্তু payment ("₹৫০০ টাকা পাঠাও") বা login attempt idempotent না — যদি একজন attacker সেই 0-RTT data capture করে replay করে, তাহলে payment দুইবার হয়ে যেতে পারে, বা login attempt দুইবার count হতে পারে (যেটা কোনো rate-limiting/security logic কে বিভ্রান্ত করতে পারে)। তাই non-idempotent, sensitive operation এ 0-RTT ব্যবহার করা বিপজ্জনক — full handshake এর নিশ্চয়তা দরকার।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** তুমি TaskFlow এর জন্য দুটো নতুন feature নিয়ে চিন্তা করছ:
>
> **Feature A:** "Live Notification Badge" — যখন কেউ তোমাকে task assign করে, একটা ছোট badge count update হয়ে যায় সাথে সাথে, page reload ছাড়া
>
> **Feature B:** "Bulk Task Import" — user একটা CSV file upload করবে, যেখানে ১০০০টা task একসাথে থাকবে, এবং system সেগুলো সব database এ ঢোকাবে
>
> প্রতিটার জন্য বলো:
>
> 1. এটার জন্য TCP নাকি UDP-ভিত্তিক approach যুক্তিসঙ্গত, আর কেন (Lesson এর trade-off table ব্যবহার করে reasoning দাও)
> 2. এই feature এর জন্য TLS 0-RTT ব্যবহার করা নিরাপদ হবে কিনা — idempotency এর প্রশ্নে বিচার করো

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, 2.1
Current: 2.2 — TCP vs UDP, TLS Handshake Deep Dive
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): System Design, Scale, Trade-off, Functional/Non-functional
Requirement, Scope, Estimation, HLD, Deep Dive, Black Box, DAU, QPS, Peak QPS,
TCP 3-Way Handshake, TLS Handshake (intro), RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC, Latency, Throughput, Availability, Reliability, SLA, SLO,
Error Budget, Vertical/Horizontal Scaling, SPOF, Stateful/Stateless
Terms learned (Module 2 so far): DNS, Recursive/Iterative Query, TTL, Authoritative
Name Server, DoH/DoT, TCP vs UDP, Cipher Suite, 0-RTT, Replay Attack
Weak spots: Multi-part প্রশ্নের সব sub-part কভার করা; terminology নির্ভুলভাবে ব্যবহার;
একটা core term কে ভুল অন্য concept এর সাথে গুলিয়ে ফেলার প্রবণতা (যেমন DNS TTL vs
data-retention TTL — 2.1 এর exercise এ হয়েছিল) — নতুন term শেখার সময় সেটা ঠিক কী
নিয়ন্ত্রণ করছে সেটা স্পষ্টভাবে ধরে নেওয়া দরকার
Next: 2.3 — REST vs GraphQL vs gRPC
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 2.3 এ যাব: REST vs GraphQL vs gRPC — এই তিনটা API design approach এর trade-off, তোমার Express API experience এর সাথে সরাসরি সম্পর্কিত একটা টপিক।
