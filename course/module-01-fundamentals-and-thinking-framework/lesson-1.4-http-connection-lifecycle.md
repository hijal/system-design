# Lesson 1.4 — Client-Server, HTTP/HTTPS, Connection Lifecycle, Keep-Alive, HTTP/2 vs HTTP/3

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.3):** Memory (RAM) read আর Disk (SSD) read এর মধ্যে speed পার্থক্য মোটামুটি কতগুণ, আর এই পার্থক্যটাই কোন গুরুত্বপূর্ণ system design concept এর ভিত্তি তৈরি করে?

---

**Prerequisite:** Lesson 1.1, 1.2, 1.3

**তুমি এই lesson শেষে পারবে:**

1. একটা URL browser এ লেখা থেকে শুরু করে response আসা পর্যন্ত পুরো journey টা ধাপে ধাপে বলতে পারবে।
2. TCP connection, TLS handshake, আর keep-alive — এগুলো আসলে কী কাজ করে এবং কেন প্রতিটা request এ নতুন connection বানানো ব্যয়বহুল — বুঝবে।
3. HTTP/1.1, HTTP/2, আর HTTP/3 এর মধ্যে মূল পার্থক্য এবং প্রতিটা কোন সমস্যার সমাধান করতে এসেছে — ব্যাখ্যা করতে পারবে।

**Tier:** 3 — Design Exercise (আজকে conceptual, কোনো code লাগবে না; connection-level জিনিস hands-on করতে হলে packet-capture টাইপ tooling লাগে যেটা এই course এর scope এর বাইরে)

---

## ০. TaskFlow এখন কোথায়

এতদিন আমরা TaskFlow কে একটা box হিসেবে দেখেছি — "Client" আর "Server" এর মাঝে একটা তীর, ব্যস। কিন্তু এই lesson 1.2 এর High-Level Design এ যে তীরটা তুমি এঁকেছিলে (`[Client] <---> [Express Server]`), তার ভেতরে আসলে **অনেকগুলো ধাপ** লুকিয়ে আছে — যেগুলো এতদিন আমরা "black box" হিসেবে রেখে দিয়েছিলাম।

আজকে সেই তীরটার ভেতরে ঢুকব। কারণ যখন তুমি বলবে "notification ৩০০ms এর মধ্যে পৌঁছাতে হবে" (Lesson 1.3 এর non-functional requirement), তখন সেই ৩০০ms এর একটা অংশ চলে যায় শুধু connection তৈরি করতেই — request এর actual data পাঠানোর আগেই। এই "hidden cost" টা না বুঝলে, তুমি latency budget হিসাব করতে গিয়ে ভুল করবে।

---

## ১. Theory

### ১.১ URL থেকে Response — পুরো Journey

তুমি browser এ লিখলে `https://taskflow.app/api/tasks`। এন্টার চাপার পর কী কী ঘটে, ধাপে ধাপে:

```
১. DNS Lookup        →  "taskflow.app" নামটা একটা IP address এ রূপান্তর হয়
                          (এটা আমরা পুরোপুরি Lesson 2.1 এ শিখব, আজকে শুধু mention)
২. TCP Connection    →  Client আর Server এর মধ্যে একটা "connection" স্থাপন হয়
   (3-way handshake)
৩. TLS Handshake     →  (শুধু HTTPS হলে) connection টা encrypt করার জন্য key exchange হয়
৪. HTTP Request পাঠানো →  Client, request পাঠায় (method, headers, body)
৫. Server Processing →  Server request process করে (DB query ইত্যাদি)
৬. HTTP Response     →  Server response পাঠায়
৭. Connection বন্ধ/reuse →  Connection বন্ধ হয়ে যায়, অথবা পরের request এর জন্য রাখা হয়
```

আজকের lesson মূলত ধাপ ২, ৩, আর ৭ নিয়ে — কারণ এই ধাপগুলোই সবচেয়ে বেশি ভুল বোঝা হয়, আর এগুলোই latency তে সবচেয়ে বেশি অবদান রাখে যেটা চোখে দেখা যায় না।

### ১.২ TCP Connection — 3-Way Handshake

Client আর Server এর মধ্যে data পাঠানোর আগে, তাদের একটা "connection" স্থাপন করতে হয় — অনেকটা ফোন কল করার মতো, কথা বলার আগে "হ্যালো, শুনতে পাচ্ছেন?" confirm করে নেওয়া।

এটা হয় ৩টা ধাপে (তাই নাম "3-way handshake"):

```
Client                              Server
  │                                    │
  │ ────────── SYN ──────────────────>│   "আমি connect করতে চাই"
  │                                    │
  │ <───────── SYN-ACK ────────────────│   "ঠিক আছে, আমিও রাজি"
  │                                    │
  │ ────────── ACK ──────────────────>│   "কনফার্ম, শুরু করি"
  │                                    │
  │ [এখন connection তৈরি, data পাঠানো শুরু] │
```

লক্ষ্য করো — **actual data (তোমার HTTP request) পাঠানোর আগেই ৩টা network round trip লেগে গেছে।** যদি Client আর Server এর মাঝে network round trip time (RTT) হয় ৫০ms (Lesson 1.3 এর latency table মনে আছে?), তাহলে শুধু connection তৈরি করতেই লেগে যাচ্ছে দেড়টা round trip এর সমান সময় (SYN আর SYN-ACK একটা round trip, তারপর ACK আরেকটা অর্ধেক)।

### ১.৩ TLS Handshake — যখন HTTPS ব্যবহার হয়

TCP connection তৈরি হওয়ার পর, যদি সেটা HTTPS হয় (আজকাল প্রায় সব production system HTTPS ব্যবহার করে), তাহলে আরেকটা ধাপ লাগে — **TLS handshake**। এর কাজ হলো — Client আর Server একটা সিক্রেট "encryption key" নিয়ে সম্মত হওয়া, যাতে তাদের মধ্যেকার সব data কেউ মাঝপথে পড়তে না পারে।

```
Client                              Server
  │ ─────── "Hello, আমি এই encryption গুলো সাপোর্ট করি" ──>│
  │ <────── "ঠিক আছে, এইটা ব্যবহার করি + আমার certificate" ──│
  │ ─────── Key exchange সম্পন্ন ─────────────────────────>│
  │ [এখন connection encrypted, HTTP request পাঠানো শুরু]     │
```

এটা আরও ১-২টা round trip যোগ করে (TLS version অনুযায়ী ভিন্ন — TLS 1.3 এ এটা optimize করে ১ round trip এ নামানো হয়েছে, TLS 1.2 এ ২ round trip লাগত)।

**মূল কথা:** TCP handshake + TLS handshake মিলিয়ে, তোমার actual data পাঠানোর _আগেই_ ২-৩টা network round trip খরচ হয়ে যায়। যদি Client, Server থেকে অনেক দূরে থাকে (ভিন্ন মহাদেশে, RTT ~150ms — Lesson 1.3 এর table), তাহলে শুধু connection স্থাপন করতেই লেগে যেতে পারে **৩০০-৪৫০ms** — তোমার actual request-response এর আগেই!

এই কারণেই CDN (Module 4.5) এবং multi-region deployment (Module 10.8) এর মতো জিনিস গুরুত্বপূর্ণ হয়ে ওঠে — Client এর কাছাকাছি একটা server রাখলে এই handshake cost ও কমে যায়।

### ১.৪ Keep-Alive — বারবার Handshake না করার সমাধান

এখন প্রশ্ন — যদি প্রতিটা HTTP request এর জন্য নতুন TCP + TLS handshake করতে হয়, তাহলে তো একটা মাত্র webpage load করতেই (যেখানে ৫০টা resource — CSS, JS, images — লাগে) অসহ্য রকম ধীর হয়ে যাবে।

এই সমস্যার সমাধান হলো **Keep-Alive** (একে **persistent connection**-ও বলা হয়)। এর মানে — একবার TCP+TLS connection তৈরি হলে, সেটা বন্ধ না করে **একাধিক request-response এর জন্য পুনরায় ব্যবহার করা**।

```
[একটা connection তৈরি হলো — TCP + TLS handshake একবার]
        │
        ├──> Request 1 (GET /api/tasks)  → Response 1
        ├──> Request 2 (GET /api/user)   → Response 2
        ├──> Request 3 (POST /api/task)  → Response 3
        │
[Connection idle timeout এর পর বন্ধ হয় (সাধারণত কয়েক সেকেন্ড থেকে কয়েক মিনিট)]
```

তোমার Express server এ ব্যাপারটা এভাবে ভাবতে পারো — Node.js এর `http` module default ভাবেই HTTP keep-alive সাপোর্ট করে। এই কারণেই তুমি Sequelize এ যে `pool` option ব্যবহার করো database connection এর জন্য — সেটাও আসলে একই মূল সমস্যার সমাধান, শুধু database connection এর জন্য। **প্রতিবার নতুন connection তৈরি করা ব্যয়বহুল — তাই সেটা reuse করা** — এই একই নীতি TCP connection, database connection, এমনকি Redis connection (Module 4.4 তে দেখবে) — সবজায়গায় প্রযোজ্য। এটা system design এর একটা repeating pattern, শুধু HTTP এর নিজস্ব জিনিস না।

> **Interview এ common question:** "কেন keep-alive গুরুত্বপূর্ণ?" — উত্তর শুধু "faster" বললে অসম্পূর্ণ। ভালো উত্তর: "প্রতিটা নতুন connection এ TCP handshake (+ TLS হলে সেটাও) এর জন্য অতিরিক্ত round trip লাগে, যেটা RTT অনুযায়ী উল্লেখযোগ্য latency যোগ করে। Keep-alive এই cost টা একবারই দিয়ে, একাধিক request এ amortize (ভাগ) করে দেয়।"

### ১.৫ HTTP/1.1 → HTTP/2 → HTTP/3 — কেন Evolution হলো

**HTTP/1.1 এর সমস্যা — Head-of-Line Blocking:**

HTTP/1.1 এ, একটা connection এ একসাথে একটাই request "in flight" থাকতে পারে (keep-alive থাকলেও, sequentially request পাঠাতে হয় সাধারণত — browser এই সীমাবদ্ধতা কাটাতে একই domain এ ৬টা পর্যন্ত parallel connection খোলে, কিন্তু সেটাও একটা limit, আর প্রতিটা connection এর নিজস্ব handshake cost আছে)।

```
HTTP/1.1 — একই connection এ:
Request 1 ──> [wait for response 1] ──> Request 2 ──> [wait] ──> Request 3
     (একটা request আটকে থাকলে, তার পেছনের সব request ও আটকে থাকে)
```

**HTTP/2 এর সমাধান — Multiplexing:**

HTTP/2 একটা মাত্র TCP connection এর ভেতর দিয়ে **একইসাথে একাধিক request-response পাঠাতে পারে**, একটা অন্যটার জন্য অপেক্ষা না করে।

```
HTTP/2 — একই connection এ:
Request 1 ─┐
Request 2 ─┼──> [সব একসাথে "in flight", response যেটা আগে রেডি সেটা আগে আসে]
Request 3 ─┘
```

এটা webpage load time নাটকীয়ভাবে কমায়, কারণ ৫০টা resource আর ৬টা connection এ ভাগ করে sequentially লোড করতে হয় না।

**HTTP/2 এর নিজস্ব সমস্যা — TCP-level Head-of-Line Blocking:**

HTTP/2, application layer এ multiplexing দিলেও, এটা এখনো TCP এর উপর দাঁড়িয়ে আছে। আর TCP নিজে guarantee দেয় যে data **ঠিক ক্রম অনুযায়ী** পৌঁছাবে। তাই যদি একটা মাত্র TCP packet হারিয়ে যায় (network এ packet loss একটা স্বাভাবিক ঘটনা, বিশেষ করে mobile network এ), তাহলে TCP সেই একটা packet এর জন্য **অপেক্ষা করে** — এমনকি যদি পরের সব packet ইতিমধ্যে পৌঁছে গিয়ে থাকে। ফলে HTTP/2 এর সব multiplexed stream **একসাথে আটকে যায়**, শুধু একটা packet এর জন্য।

**HTTP/3 এর সমাধান — QUIC (UDP-ভিত্তিক):**

HTTP/3 সম্পূর্ণ ভিন্ন approach নেয় — এটা TCP ব্যবহারই করে না, বরং একটা নতুন protocol **QUIC** ব্যবহার করে, যেটা UDP এর উপর তৈরি। QUIC নিজের ভেতরেই multiple independent stream handle করে, তাই একটা stream এ packet loss হলে **শুধু সেই stream টাই** অপেক্ষা করে, বাকিগুলো চলতে থাকে।

QUIC এর আরেকটা বড় সুবিধা — এটা TCP handshake + TLS handshake কে **একসাথে combine** করে ফেলে (কারণ TLS 1.3, encryption QUIC এর মধ্যেই built-in), ফলে connection স্থাপন করতে round trip সংখ্যা আরও কমে যায়।

> **Trade-off Table — HTTP Version গুলোর তুলনা**

|                       | HTTP/1.1                                            | HTTP/2                  | HTTP/3                                            |
| --------------------- | --------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| Transport             | TCP                                                 | TCP                     | QUIC (UDP-ভিত্তিক)                                |
| Multiplexing          | না (browser এ parallel connection দিয়ে workaround) | হ্যাঁ, একই connection এ | হ্যাঁ, stream-level isolation সহ                  |
| Head-of-line blocking | Application-level এ ভয়াবহ                          | TCP-level এ থেকে যায়   | মূলত সমাধান হয়েছে                                |
| Connection setup cost | বেশি (একাধিক connection দরকার)                      | কম                      | সবচেয়ে কম (handshake combine)                    |
| Adoption              | সবজায়গায় সাপোর্টেড                                | বহুল ব্যবহৃত            | ক্রমবর্ধমান, কিন্তু সব infra তে এখনো universal না |
| Complexity            | সহজ                                                 | মাঝারি                  | জটিল (নতুন protocol stack)                        |

**তোমার stack এর প্রেক্ষিতে:** Cloudflare এর মতো CDN/proxy automatically HTTP/2 এবং HTTP/3 উভয়ই সাপোর্ট করে যখন এটা তোমার traffic proxy করে — তাই এটা এমন একটা জিনিস যেটা "নিচের লেয়ারে" ঘটে, তোমার Express code কে এটা নিয়ে সচেতন থাকতে হয় না। কিন্তু interview এ এটা জানাটা গুরুত্বপূর্ণ, কারণ এটা বোঝায় তুমি জানো performance শুধু application code এ না, network layer এও নির্ধারিত হয়।

---

## ২. Interview Angle

এই টপিকটা প্রায়ই "system design" round এর চেয়ে বেশি "networking fundamentals" বা "performance" নিয়ে আলোচনায় আসে, কিন্তু system design interview এও একটা common follow-up প্রশ্ন হলো:

> "তোমার API latency বেশি — কোথায় কোথায় সময় যেতে পারে, ধাপে ধাপে বলো।"

এই প্রশ্নের ভালো উত্তরে DNS lookup, TCP handshake, TLS handshake, server processing, এবং response transfer — প্রতিটা ধাপকে আলাদা করে চিহ্নিত করতে পারা উচিত। যারা শুধু "database query slow হতে পারে" বলে থেমে যায়, তারা অর্ধেক ছবি দেখছে — connection-level latency ও সমানভাবে গুরুত্বপূর্ণ, বিশেষ করে যদি ক্লায়েন্ট Server থেকে ভৌগোলিকভাবে দূরে থাকে।

আরেকটা common question: "কেন keep-alive গুরুত্বপূর্ণ, বা কেন connection pooling গুরুত্বপূর্ণ?" — এখানে তোমার Sequelize `pool` অভিজ্ঞতার সাথে সরাসরি সংযোগ আছে। ঠিক যেভাবে database connection বারবার তৈরি করা ব্যয়বহুল (তাই pool রাখা হয়), ঠিক একই কারণে HTTP connection ও reuse করা হয় — **এই একই নীতিটা (connection reuse) system design জুড়ে বারবার ফিরে আসবে**, তাই এই lesson টাকে শুধু "networking trivia" না ভেবে একটা repeating pattern এর প্রথম উদাহরণ হিসেবে মনে রাখাটা বেশি কাজে দেবে।

---

## ৩. Key Takeaway

- URL থেকে response পাওয়া পর্যন্ত আসলে ৭টা ধাপ ঘটে: DNS → TCP handshake → TLS handshake → request → processing → response → connection close/reuse
- TCP 3-way handshake (SYN, SYN-ACK, ACK) actual data পাঠানোর _আগেই_ network round trip খরচ করে
- TLS handshake (HTTPS এর জন্য) আরও round trip যোগ করে — TLS 1.3 এ এটা optimize করা হয়েছে
- Keep-alive/persistent connection — একবার connection তৈরি করে বারবার reuse করা, বারবার handshake এড়ানোর জন্য
- এই "connection reuse" নীতি শুধু HTTP এ না — database connection pool, Redis connection — সবজায়গায় একই যুক্তি প্রযোজ্য
- HTTP/1.1 এর সমস্যা: head-of-line blocking, limited parallelism
- HTTP/2 সমাধান করে: multiplexing (একই connection এ একাধিক request একসাথে), কিন্তু TCP-level blocking থেকে যায়
- HTTP/3 (QUIC) সমাধান করে: UDP-ভিত্তিক, per-stream isolation, দ্রুততম connection setup

---

## ৪. নতুন Term (Glossary)

| Term                                   | অর্থ                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **TCP 3-Way Handshake**                | Client আর Server এর মধ্যে connection স্থাপনের ৩-ধাপের প্রক্রিয়া (SYN, SYN-ACK, ACK)                        |
| **TLS Handshake**                      | HTTPS connection কে encrypt করার জন্য key exchange করার প্রক্রিয়া                                          |
| **RTT (Round Trip Time)**              | একটা packet Client থেকে Server এ গিয়ে আবার ফিরে আসতে যে সময় লাগে                                          |
| **Keep-Alive (Persistent Connection)** | একটা connection বন্ধ না করে একাধিক request-response এর জন্য পুনরায় ব্যবহার করা                             |
| **Head-of-Line Blocking**              | একটা request/packet আটকে থাকলে তার পেছনের সব request/packet ও আটকে থাকা                                     |
| **Multiplexing**                       | একই connection এর মধ্য দিয়ে একাধিক independent request-response একসাথে পাঠানোর ক্ষমতা                      |
| **QUIC**                               | HTTP/3 এর ভিত্তি, UDP-ভিত্তিক একটা নতুন transport protocol যেটা per-stream head-of-line blocking সমাধান করে |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর নিচের Answer Key দেখো।

1. ধরো TaskFlow এর একটা user মধ্যপ্রাচ্যে বসে আছে, আর তোমার server সিঙ্গাপুরে। RTT ধরো ~১০০ms। যদি HTTPS ব্যবহার হয় (TLS 1.2, যেটায় ২ round trip লাগে TLS এর জন্য) — শুধু connection স্থাপন করতে (TCP + TLS, actual request পাঠানোর আগে) মোটামুটি কত সময় লাগবে?
2. তুমি যদি Keep-Alive ছাড়া (প্রতিটা request এ নতুন connection) একটা page লোড করো যেখানে ১০টা আলাদা resource (images, CSS, JS) দরকার — Keep-Alive থাকলে এর তুলনায় কী পার্থক্য হবে, নিজের ভাষায় ব্যাখ্যা করো।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** TCP handshake নেয় ১ RTT (SYN+SYN-ACK একসাথে ১ RTT ধরা হয়, তারপর ACK দিয়ে data flow শুরু হয় — কনভেনশনালি এটাকে ১ RTT হিসেবে গণনা করা হয়)। TLS 1.2 নেয় আরও ২ RTT। মোট = ৩ RTT × ১০০ms = **~৩০০ms**, শুধু connection স্থাপন করতেই, actual request-response এর আগে। এটাই কারণ কেন geographic distance latency তে এত বড় প্রভাব ফেলে, এবং কেন CDN/multi-region (পরের modules এ আসবে) গুরুত্বপূর্ণ।

**প্রশ্ন ২:** Keep-Alive ছাড়া, প্রতিটা resource এর জন্য আলাদা TCP (+ TLS) handshake লাগবে — মানে ১০টা resource এ ১০ বার connection overhead। Keep-Alive থাকলে, একবার connection তৈরি হয়ে সেটাই ১০টা request এর জন্য reuse হয় — শুধু একবার handshake cost দিতে হয়। এটা page load time উল্লেখযোগ্যভাবে কমিয়ে দেয়, বিশেষ করে high-RTT network এ (mobile, দূরবর্তী user)।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

এবার একটা ছোট reasoning exercise — connection lifecycle এর ধারণাটা একটা বাস্তব পরিস্থিতিতে প্রয়োগ করে দেখার জন্য:

> **Scenario:** TaskFlow এ একটা "Live Dashboard" ফিচার আসছে, যেখানে user এর browser প্রতি ২ সেকেন্ডে server কে poll করে নতুন task status আছে কিনা জানতে চায় (এটা এখনো WebSocket না, শুধু repeated HTTP request — polling)।
>
> চিন্তা করো এবং লেখো:
>
> 1. যদি Keep-Alive **সক্রিয়** থাকে, প্রতি ২ সেকেন্ডে যে নতুন request যাচ্ছে, তার জন্য কি নতুন TCP+TLS handshake লাগবে? কেন/কেন না?
> 2. যদি server side এ Keep-Alive timeout খুব **কম** সেট করা থাকে (ধরো ১ সেকেন্ড), আর client প্রতি ২ সেকেন্ডে request পাঠায় — তাহলে কী সমস্যা হতে পারে?
> 3. এই scenario থেকে, Keep-Alive timeout সেট করার ক্ষেত্রে কী trade-off আছে বলে তোমার মনে হয় (খুব কম timeout vs খুব বেশি timeout — প্রতিটার cost কী)?

এখানে "সঠিক ইঞ্জিনিয়ারিং সংখ্যা" আশা করছি না — তোমার reasoning process দেখতে চাইছি, connection lifecycle এর concept টা তুমি বাস্তব scenario তে apply করতে পারছ কিনা।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2, 1.3
Current: 1.4 — Client-Server, HTTP/HTTPS, Connection Lifecycle, Keep-Alive, HTTP/2 vs HTTP/3
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth,
TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC
Weak spots: Functional/Non-functional এ solution/constraint গুলিয়ে ফেলা (উন্নতি হচ্ছে);
HLD তে UI-state কে component ভাবা; Requirement মনোযোগ দিয়ে না পড়ে assumption নেওয়া
(1.3 তে read/log ভুল) — এখন প্রতিটা lesson এই ধরনের ছোট inattention ভুল কমছে
Next: 1.5 — Latency, Throughput, Availability, Reliability + SLA/SLO/Error Budget
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — connection lifecycle এর reasoning টা কীভাবে apply করছ সেটা দেখব। রেডি হলে `next` লিখো — Lesson 1.5 এ যাব, যেখানে Latency, Throughput, Availability, Reliability এর concrete সংজ্ঞা, আর সেই সাথে SLA/SLO/Error Budget — যেগুলো ইতিমধ্যে তুমি টুকরো টুকরো ভাবে ছুঁয়ে গেছ, এবার সেগুলোকে formal ভাবে একসাথে বাঁধব।
