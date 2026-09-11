# Lesson 3.1 — Load Balancer কী, কেন লাগে, L4 vs L7

**Module 3 — Load Balancing & Proxies**

> **Spaced Repetition (Lesson 2.3):** REST, GraphQL, নাকি gRPC — এই সিদ্ধান্ত নেওয়ার জন্য lesson এ যে "৩টা প্রশ্ন" framework দেওয়া হয়েছিল, সেগুলো কী কী ছিল?

**Prerequisite:** Lesson 1.6 (Vertical/Horizontal Scaling, Stateless/Stateful)

**তুমি এই lesson শেষে পারবে:**

1. Load Balancer কী কাজ করে এবং কেন horizontal scaling এর জন্য এটা অপরিহার্য — বুঝবে
2. L4 (Transport Layer) এবং L7 (Application Layer) load balancing এর পার্থক্য এবং প্রতিটার trade-off ব্যাখ্যা করতে পারবে
3. একটা নির্দিষ্ট scenario দেখে বলতে পারবে L4 নাকি L7 load balancer উপযুক্ত

**Tier:** 3 — Design Exercise (hands-on Nginx configuration Lesson 3.3 তে আসবে)

---

## ০. TaskFlow এখন কোথায়

Lesson 1.6 তে আমরা বলেছিলাম — horizontal scaling করতে হলে প্রথমে server কে **stateless** বানাতে হয়। ধরে নিই, TaskFlow টিম এখন সেই কাজ করে ফেলেছে — session data, uploaded file, সবকিছু external store এ সরিয়ে নেওয়া হয়েছে। এখন TaskFlow এর **৩টা identical Express server instance** চলছে, একই codebase, একই database এর সাথে connected।

কিন্তু এখানে একটা নতুন সমস্যা — একজন client (browser) যখন `taskflow.app` এ request পাঠায়, সেই request **কোন server এ যাবে**? Client তো জানে না ৩টা server আছে, সে শুধু একটা domain name জানে। কেউ একজনকে এই কাজটা করতে হবে — request গুলো এই ৩টা server এর মধ্যে **বুদ্ধিমত্তার সাথে ভাগ করে দেওয়া**। এই কাজটাই করে **Load Balancer** — এবং আজকের lesson থেকে Module 3 শুরু হচ্ছে ঠিক এই concept দিয়ে।

---

## ১. Theory

### ১.১ Load Balancer কী এবং কেন লাগে

**Load Balancer (LB)** একটা component যেটা client আর একাধিক server (backend) এর মাঝখানে বসে, এবং প্রতিটা আগত request কে কোন server এ পাঠানো হবে সেটা ঠিক করে।

```
                          ┌──> [Server 1]
[Client] ──> [Load Balancer] ──> [Server 2]
                          └──> [Server 3]
```

**Load Balancer এর মূল দায়িত্ব:**

1. **Traffic distribute করা** — যাতে একটা server এ চাপ বেশি না পড়ে, বাকিগুলো অলস না বসে থাকে
2. **Failover/Health check** — যদি Server 2 down হয়ে যায়, LB সেটা detect করে সেখানে আর request না পাঠিয়ে বাকি live server গুলোতে পাঠায় (এটা বিস্তারিত Lesson 3.4 তে)
3. **Single entry point দেওয়া** — Client কে শুধু একটা address (LB এর) জানলেই চলে, backend এ কয়টা/কোন server আছে সেটা জানার দরকার নেই

লক্ষ্য করো — Load Balancer ছাড়া horizontal scaling **অর্থহীন**। যদি ৩টা server থাকে কিন্তু সবকিছু manually একটা নির্দিষ্ট server এর IP তে যায়, তাহলে বাকি ২টা server এর কোনো লাভ নেই — এটাই সেই "মিসিং piece" যেটা Lesson 1.6 এ আমরা "black box" হিসেবে রেখে দিয়েছিলাম।

### ১.২ L4 (Transport Layer) Load Balancing

**L4 Load Balancer**, নাম অনুযায়ীই, OSI model এর **Layer 4 (Transport Layer)** এ কাজ করে — মানে এটা শুধু **IP address এবং port** দেখে, request এর **ভেতরে কী আছে সেটা দেখে না** (HTTP header, URL path, কিছুই বোঝে না, শুধু packet forward করে)।

```
Client ──[TCP packet: dest=LB_IP:443]──> L4 LB
                                            │
                          [শুধু IP/port দেখে, একটা backend বেছে নেয়]
                                            │
                                            ▼
                                     [Server IP:Port এ forward]
```

**সুবিধা:**

- **অত্যন্ত দ্রুত** — কারণ এটাকে packet এর ভেতরের content parse করতে হয় না, শুধু header দেখেই decision নেয়
- Low overhead, high throughput — সেকেন্ডে লাখ লাখ connection handle করতে পারে
- HTTP ছাড়াও যেকোনো TCP/UDP traffic এর জন্য কাজ করে (যেমন, database connection balancing)

**সীমাবদ্ধতা:**

- **Content-aware routing করতে পারে না** — যেমন, "`/api/*` একটা backend এ যাক, `/static/*` অন্য backend এ যাক" — এই ধরনের সিদ্ধান্ত L4 নিতে পারে না, কারণ এটা URL path দেখতেই পায় না
- Cookie-based বা header-based routing সম্ভব না

### ১.৩ L7 (Application Layer) Load Balancing

**L7 Load Balancer** কাজ করে OSI model এর **Layer 7 (Application Layer)** এ — মানে এটা পুরো HTTP request **পড়ে এবং বোঝে**: URL path, header, cookie, method (GET/POST) — সবকিছু।

```
Client ──[HTTP GET /api/tasks, Cookie: session=xyz]──> L7 LB
                                                          │
                          [URL path, header, cookie সব দেখে বুদ্ধিমান
                           routing decision নেয়]
                                                          │
                                                          ▼
                                          [নির্দিষ্ট backend এ forward,
                                           হয়তো header ও modify করে পাঠাতে পারে]
```

**সুবিধা:**

- **Content-based routing** — `/api/*` কে API server এ, `/images/*` কে static file server এ পাঠানো সম্ভব
- **Cookie-based sticky session** সম্ভব (একই user সবসময় একই server এ যাওয়া — যদিও Lesson 1.6 এর stateless নীতি অনুযায়ী এটা ideal সমাধান না, কিন্তু বাস্তবে ব্যবহৃত হয়, বিস্তারিত Lesson 3.4 তে)
- SSL/TLS termination করতে পারে (client-facing HTTPS, কিন্তু backend এর সাথে internal HTTP — encryption overhead backend থেকে সরিয়ে LB তে কেন্দ্রীভূত করা)

**সীমাবদ্ধতা:**

- **বেশি overhead** — প্রতিটা request এর পুরো HTTP content parse করতে হয়, তাই L4 এর চেয়ে ধীর এবং বেশি resource লাগে
- জটিলতা বেশি — configuration, routing rule, সবকিছু বেশি sophisticated

> **Trade-off Table — L4 vs L7 Load Balancer**

| দিক                   | L4                                                                 | L7                                                |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| কী দেখে               | IP address, Port                                                   | পুরো HTTP request (URL, header, cookie, body)     |
| Speed/Overhead        | অত্যন্ত দ্রুত, কম overhead                                         | তুলনামূলক ধীর, বেশি overhead                      |
| Content-based routing | না                                                                 | হ্যাঁ (`/api/*` vs `/static/*`)                   |
| SSL Termination       | সাধারণত না (pass-through)                                          | হ্যাঁ                                             |
| Protocol              | যেকোনো TCP/UDP                                                     | মূলত HTTP/HTTPS                                   |
| Best fit              | Raw performance-critical, non-HTTP traffic (database, generic TCP) | Web application, API — যেখানে smart routing দরকার |

### ১.৪ ২০২৬ এ বাস্তবে কী ব্যবহার হয় (web search দিয়ে verify করা হয়েছে)

তোমার stack এর (Express + SvelteKit + Cloudflare) প্রেক্ষিতে এটা প্রাসঙ্গিক — কোন tool কখন বেছে নেওয়া হয়:

- Nginx সবচেয়ে ভালো general-purpose L7 reverse proxy — বেশিরভাগ ক্ষেত্রে এটাই default পছন্দ হওয়া উচিত, যদি না কোনো নির্দিষ্ট কারণে অন্য কিছু দরকার হয়
- HAProxy সবচেয়ে ভালো তখন যখন routing logic সহজ এবং শুধুমাত্র raw performance/throughput সবচেয়ে গুরুত্বপূর্ণ — এটা কোনো web server না, শুধু balance করে, অন্য কিছু না (static file serve করে না, cache করে না)
- Envoy একটা high-performance proxy, microservices এবং gRPC এর জন্য বিশেষভাবে উপযুক্ত, এবং এটা service mesh এর মধ্যে data plane হিসেবেও ব্যবহৃত হয় — কিন্তু এটার cost হলো বেশি operational complexity, একটা সাধারণ ২-backend website এর জন্য এটা overkill
- HAProxy তে এখনও পর্যন্ত production-ready HTTP/3 সাপোর্ট নেই — ২০২৬ সালের প্রথম দিকেও এটা "experimental" হিসেবে চিহ্নিত হাই-ট্রাফিক deployment এর জন্য, তাই HTTP/3 দরকার হলে Nginx বা Envoy ব্যবহার করা হয়

**তোমার জন্য practical takeaway:** যেহেতু TaskFlow একটা HTTP-based web application (Express API + SvelteKit frontend), **Nginx-এর মতো একটা L7 load balancer** স্বাভাবিক পছন্দ হবে — এটা আমরা পরের lesson (3.3) এ hands-on করব। যদি TaskFlow ভবিষ্যতে microservice এ ভাগ হয় এবং gRPC ব্যবহার করে (Module 9), তখন Envoy বিবেচনা করার মতো একটা upgrade path হতে পারে।

---

## ২. Interview Angle

একটা common interview প্রশ্ন — "Load balancer বসানোর সময় L4 নাকি L7 বেছে নেবে?" ভালো উত্তরের মূল বিন্দু: **যদি routing decision এর জন্য request এর ভেতরের content (URL, header, cookie) জানার দরকার হয়, L7 লাগবেই — এটা optional না।** কিন্তু যদি শুধু raw traffic distribution দরকার (কোনো smart routing ছাড়া), এবং performance সবচেয়ে বেশি গুরুত্বপূর্ণ (যেমন, একটা database connection pool balance করা), L4 যথেষ্ট এবং বেশি efficient।

আরেকটা follow-up যেটা প্রায়ই আসে — "একটা LB এর সামনে আরেকটা LB থাকতে পারে কি?" — উত্তর হ্যাঁ, এবং এটা বাস্তবে common — একটা **L4 LB প্রথমে raw traffic নিয়ে বড় regional cluster গুলোর মধ্যে ভাগ করে (দ্রুততার জন্য), তারপর প্রতিটা cluster এর ভেতরে একটা L7 LB smart, content-based routing করে**। এই ধরনের layered architecture বড় company (Google, Netflix) এ common।

---

## ৩. Key Takeaway

- Load Balancer, client আর multiple backend server এর মাঝে বসে traffic distribute করে — horizontal scaling এর অপরিহার্য অংশ
- **L4** — শুধু IP/port দেখে, অত্যন্ত দ্রুত, কিন্তু content-based routing করতে পারে না
- **L7** — পুরো HTTP request বোঝে (URL, header, cookie), smart routing করতে পারে, কিন্তু বেশি overhead
- Web application/API এর জন্য সাধারণত L7 দরকার (path-based routing, SSL termination); pure raw traffic এর জন্য L4 যথেষ্ট এবং বেশি efficient
- ২০২৬ এ Nginx general-purpose L7 তে default, HAProxy pure L4/L7 performance এ, Envoy microservices/gRPC এ প্রাধান্য পায়

---

## ৪. নতুন Term (Glossary)

| Term                            | অর্থ                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Load Balancer (LB)**          | client আর একাধিক backend server এর মধ্যে traffic distribute করা component                      |
| **L4 (Layer 4) Load Balancing** | Transport layer এ কাজ করে, শুধু IP/port ভিত্তিক routing                                        |
| **L7 (Layer 7) Load Balancing** | Application layer এ কাজ করে, HTTP content ভিত্তিক routing                                      |
| **SSL/TLS Termination**         | client-facing HTTPS কে LB এ decrypt করে, backend এর সাথে internal plain HTTP এ communicate করা |
| **Content-based Routing**       | URL path, header, বা cookie দেখে ভিন্ন ভিন্ন backend এ request পাঠানো                          |

---

## ৫. Reflection Questions

1. TaskFlow এর একটা architecture তে, `/api/*` request গুলো Express backend এ যাবে, আর `/assets/*` (images, CSS, JS) request গুলো সরাসরি একটা static file server এ যাবে। এখানে L4 নাকি L7 load balancer লাগবে, কেন?
2. একটা internal database connection pooler (অনেকগুলো app server থেকে একটা database cluster এ connection distribute করা) — এখানে L4 নাকি L7 বেশি উপযুক্ত মনে হয়, কেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** এখানে **L7 লাগবে**, কারণ সিদ্ধান্তটা নির্ভর করছে URL path এর ওপর (`/api/*` vs `/assets/*`) — এটা exactly সেই content-based routing যেটা শুধুমাত্র L7 করতে পারে, কারণ L4 কে URL path দেখতেই দেওয়া হয় না (এটা শুধু IP/port স্তরে কাজ করে)।

**প্রশ্ন ২:** এখানে **L4 বেশি উপযুক্ত**, কারণ database connection এ কোনো "URL path" বা "HTTP header" নেই বিচার করার মতো (এটা raw TCP connection, HTTP প্রোটোকলই না) — শুধু কোন server এ connection পাঠানো হবে সেটা ঠিক করাই যথেষ্ট, আর এখানে performance (কম latency, বেশি throughput) সবচেয়ে গুরুত্বপূর্ণ, যেটা L4 এর মূল শক্তি।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow এখন horizontal scale করছে — ৩টা Express server instance। এই মুহূর্তে তিনটা আলাদা ধরনের traffic আছে:
>
> 1. `/api/tasks`, `/api/users` — মূল application API (JSON response)
> 2. `/health` — একটা lightweight endpoint যেটা শুধু "OK" রিটার্ন করে, প্রতি কয়েক সেকেন্ডে monitoring system থেকে call হয়
> 3. একটা আলাদা internal service — TaskFlow এর background job worker গুলো Redis এর সাথে connect করে (raw TCP, HTTP না)
>
> প্রশ্ন:
>
> 1. #১ এবং #২ এর জন্য L4 নাকি L7 লাগবে? একই LB দিয়ে দুটোই সামলানো যাবে কি?
> 2. #৩ এর জন্য কী ধরনের load balancing দরকার, এবং কেন এটা #১-২ থেকে fundamentally আলাদা?
> 3. যদি ভবিষ্যতে TaskFlow, `api.taskflow.app` (Module 2 Exit Challenge এর সেই partner API) কে আলাদা backend cluster এ route করতে চায়, main app থেকে — এটা কীভাবে সম্ভব, L4 নাকি L7 দিয়ে?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (সম্পূর্ণ) + Module 2 (সম্পূর্ণ)
Current: 3.1 — Load Balancer, L4 vs L7
TaskFlow state: multi-instance transition শুরু — ৩টা stateless Express server instance
(conceptually), single Postgres, ~100 users বেস কিন্তু architecture এখন horizontal-scale-ready
Terms learned (Module 1 & 2): [সব আগের term বজায় আছে]
Terms learned (Module 3 so far): Load Balancer, L4/L7 Load Balancing, SSL/TLS Termination,
Content-based Routing
Weak spots: Multi-part প্রশ্নের সব sub-part কভার করা; trade-off/cost স্পষ্টভাবে বলা (Module 2
জুড়ে অনেক উন্নতি হয়েছে); নিজের identify করা trade-off "এড়ানো যায় কিনা" সেটা পুনরায় যাচাই
করা (Module 2 Exit Challenge এর TLS প্রশ্নে এই gap ধরা পড়েছিল)
Next: 3.2 — LB Algorithms (Round Robin, Least Connections, Consistent Hashing — intro)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 3.2 এ যাব: Load Balancing Algorithms — Round Robin, Least Connections, আর Consistent Hashing এর একটা প্রাথমিক পরিচিতি (full depth পরে Module 10.1 এ)।
