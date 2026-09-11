# Lesson 2.3 — REST vs GraphQL vs gRPC

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 2.1):** Server migration করার সময় DNS TTL নিয়ে কী পদক্ষেপ নেওয়া উচিত, এবং কেন (migration এর আগে, এবং পরে)?

**Prerequisite:** Lesson 1.4, 2.2 (HTTP, TCP/UDP, TLS)

**তুমি এই lesson শেষে পারবে:**

1. REST, GraphQL, আর gRPC — এই তিনটা API paradigm এর মূল দর্শন এবং কাজের ধরন ব্যাখ্যা করতে পারবে
2. "Over-fetching" এবং "Under-fetching" সমস্যা কী, এবং GraphQL কীভাবে এটা সমাধান করে — বুঝবে
3. একটা নির্দিষ্ট scenario দেখে বলতে পারবে কোন API style যুক্তিসঙ্গত, শুধু "GraphQL modern তাই ভালো" এই ধরনের ভুল hype-based সিদ্ধান্ত না নিয়ে

**Tier:** 3 — Design Exercise (Hands-on gRPC/GraphQL code Module 9 এর কাছাকাছি আসতে পারে, আজকে conceptual)

---

## ০. TaskFlow এখন কোথায়

TaskFlow এর Express API এতদিন আমরা ধরে নিয়েছি এটা একটা "সাধারণ API" — কিন্তু আসলে এটা implicitly একটা নির্দিষ্ট style অনুসরণ করছে: **REST**। `GET /api/tasks`, `POST /api/tasks`, `PUT /api/tasks/:id` — এই pattern তোমার কাছে এতটাই স্বাভাবিক মনে হয় যে হয়তো কখনো ভাবোনি এটা "একটা choice", আরও option থাকতে পারে।

কিন্তু ধরো, client বলল — "আমরা এখন একটা mobile app বানাচ্ছি, আর সেই app এর জন্য প্রতিটা screen এ ভিন্ন ভিন্ন data দরকার — কোনো screen এ শুধু task title আর status লাগবে, কোনো screen এ পুরো task detail সহ comment, attachment সব লাগবে। আর সাথে সাথে, আমাদের internal notification service আর task service এর মধ্যে communication টাও অনেক দ্রুত হওয়া দরকার, milliseconds এ।" — এই দুটো চাহিদা, তোমার আজকের REST API দিয়ে ভালোভাবে satisfy হবে কি? আজকের lesson এই প্রশ্নের উত্তর দেবে।

---

## ১. Theory

### ১.১ REST — যেটা তুমি এতদিন ব্যবহার করছ

**REST (Representational State Transfer)** একটা architectural style, যেখানে প্রতিটা API endpoint একটা **resource** (যেমন `task`, `user`) represent করে, আর HTTP verb (GET, POST, PUT, DELETE) দিয়ে সেই resource এর ওপর operation করা হয়।

```
GET    /api/tasks          →  সব task এর list
GET    /api/tasks/123      →  একটা নির্দিষ্ট task
POST   /api/tasks          →  নতুন task তৈরি
PUT    /api/tasks/123      →  task update
DELETE /api/tasks/123      →  task delete
```

**সুবিধা:**

- সহজ, বহুল পরিচিত — যেকোনো developer সাথে সাথে বুঝতে পারে
- **HTTP caching এর সাথে natural fit** — CDN, browser cache, সব HTTP semantics বোঝে (GET request cache করা সহজ, কারণ URL নিজেই resource identify করে)
- Tooling mature — Postman, OpenAPI/Swagger documentation, সব REST এর জন্য প্রথম দিন থেকে design করা

**সমস্যা — Over-fetching এবং Under-fetching:**

ধরো, তোমার mobile app এর একটা screen এ শুধু task এর `title` আর `status` দেখাতে হবে। কিন্তু `GET /api/tasks` call করলে server পুরো task object পাঠায় — `title`, `status`, `description`, `assignee`, `comments`, `attachments`, সবকিছু। তুমি যা দরকার তার চেয়ে **বেশি data পেয়ে গেলে** — এটাই **Over-fetching**।

উল্টো সমস্যাও হতে পারে — ধরো তোমার আরেকটা screen এ task এর সাথে সাথে তার assignee এর পুরো profile (নাম, avatar, email) ও দরকার। REST এ এটা পেতে হলে সাধারণত **দুটো আলাদা API call** লাগে — একটা `GET /api/tasks/123`, আরেকটা `GET /api/users/456`। তুমি যা দরকার তার জন্য **একটা call এ যথেষ্ট data না পাওয়া**, একাধিক round trip লাগা — এটাই **Under-fetching**।

### ১.২ GraphQL — Client নিজেই ঠিক করে কী data দরকার

**GraphQL** এই over/under-fetching সমস্যা সমাধান করে একটা ভিন্ন approach দিয়ে — একটা **মাত্র endpoint** (সাধারণত `/graphql`), আর client নিজেই একটা query লিখে বলে দেয় ঠিক কোন কোন field তার দরকার:

```
Client এর query:
{
  task(id: 123) {
    title
    status
    assignee {
      name
      avatar
    }
  }
}

Server এর response (ঠিক এই field গুলোই, আর কিছু না):
{
  "task": {
    "title": "Fix login bug",
    "status": "in-progress",
    "assignee": { "name": "Hijikesh", "avatar": "..." }
  }
}
```

লক্ষ্য করো — একটা মাত্র request এ, ঠিক যে field দরকার (task এর কিছু field + assignee এর কিছু field), সেটাই এসেছে — না বেশি, না কম, আর একটা মাত্র round trip এ। এটাই GraphQL এর মূল প্রতিশ্রুতি।

**সমস্যা — GraphQL এর নিজস্ব cost:**

- **Caching কঠিন** — REST এ URL দিয়ে cache করা যায় (`GET /api/tasks/123` সবসময় একই resource বোঝায়), কিন্তু GraphQL এ সব query একটা মাত্র endpoint এ যায় (`POST /graphql`), তাই traditional HTTP/CDN caching কাজ করে না সহজে — আলাদা caching layer বানাতে হয়
- **N+1 Problem** — এটা তোমার Sequelize অভিজ্ঞতা থেকে পরিচিত শব্দ (Module 5.6 তে formally আসবে) হতে পারে। GraphQL server-side এ, যদি একটা query তে ১০০টা task চাওয়া হয়, আর প্রতিটা task এর assignee ও চাওয়া হয়, তাহলে naive implementation এ প্রতিটা task এর জন্য আলাদা assignee-fetch query চলে যেতে পারে — মানে ১০০টা task fetch + ১০০টা assignee fetch = ১০১টা database query! এটা resolver design ভালোভাবে না করলে সহজেই ঘটে যায় (DataLoader এর মতো batching pattern দিয়ে এটা সমাধান করা হয়, কিন্তু এই জটিলতাটা backend এ যোগ হয়)
- **Backend complexity বেশি** — schema define করা, resolver লেখা, authorization প্রতিটা field-level এ চিন্তা করা — REST এর তুলনায় অনেক বেশি setup effort

### ১.৩ gRPC — Service-to-Service Communication এর জন্য তৈরি

REST আর GraphQL দুটোই মূলত **client (browser/mobile) থেকে server** communication এর জন্য ডিজাইন করা। কিন্তু TaskFlow যখন বড় হয়ে অনেকগুলো internal service এ ভাগ হবে (Module 9 তে আমরা এটা দেখব — Notification Service, Task Service, আলাদা আলাদা), তখন সেই **service-to-service** communication এর জন্য একটা ভিন্ন প্রয়োজন দাঁড়ায় — সর্বোচ্চ speed, strict type safety, কম bandwidth।

**gRPC** এখানে আসে। এটার কয়েকটা মূল বৈশিষ্ট্য:

- **Protocol Buffers (Protobuf)** ব্যবহার করে — এটা একটা binary data format (JSON এর মতো text-based না), যেটা অনেক ছোট আকারে data পাঠায় এবং parse করতে দ্রুত
- **strict schema (IDL — Interface Definition Language)** — client আর server, দুই পক্ষই আগে থেকে জানে ঠিক কী shape এর data যাবে-আসবে, compile-time এ type check হয়
- **HTTP/2 এর ওপর ভিত্তি করে তৈরি** (Lesson 1.4 এর multiplexing মনে আছে?), তাই একই connection এ multiple concurrent request efficient ভাবে চলতে পারে
- **Bidirectional streaming সাপোর্ট করে** — শুধু request-response না, দুই দিক থেকেই continuous data flow করতে পারে (যেমন, real-time metrics streaming)

```
task.proto (schema definition):

service TaskService {
  rpc GetTask (TaskRequest) returns (TaskResponse);
}

message TaskRequest {
  int32 id = 1;
}

message TaskResponse {
  string title = 1;
  string status = 2;
}
```

**সমস্যা — Browser-friendliness কম:**

gRPC মূলত browser এ সরাসরি ব্যবহার করার জন্য ডিজাইন করা না (browser এর HTTP/2 support এর কিছু সীমাবদ্ধতার কারণে) — তাই web frontend থেকে gRPC ব্যবহার করতে হলে "gRPC-Web" এর মতো একটা proxy layer লাগে। এই কারণে **gRPC মূলত internal, service-to-service communication এ ব্যবহৃত হয়**, public-facing browser API তে না।

> **Trade-off Table — REST vs GraphQL vs gRPC**

| দিক                | REST                                    | GraphQL                                                          | gRPC                                                               |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Data format        | JSON (text)                             | JSON (text)                                                      | Protobuf (binary)                                                  |
| Fetching precision | Over/under-fetching সমস্যা              | Client-driven, precise                                           | Schema-driven, precise                                             |
| Caching            | সহজ (HTTP caching)                      | কঠিন                                                             | কঠিন (তবে দরকার কম, কারণ internal)                                 |
| Browser support    | Native                                  | Native                                                           | Proxy লাগে (gRPC-Web)                                              |
| Best for           | Public API, simple CRUD, browser-facing | বিভিন্ন client এর বিভিন্ন data চাহিদা (mobile + web + dashboard) | Internal microservice communication, high performance দরকার যেখানে |
| Setup complexity   | কম                                      | মাঝারি-বেশি                                                      | মাঝারি (schema + codegen)                                          |

### ১.৪ ২০২৬-এ বাস্তবে কী হচ্ছে (web search দিয়ে verify করা হয়েছে)

এই টপিকটা hype-heavy, তাই current data check করে নেওয়া জরুরি ছিল — ২০২৬ সালের data নিয়ে বিভিন্ন source এ সংখ্যায় কিছুটা ভিন্নতা আছে (যেমন GraphQL adoption কোথাও ২৫-২৮%, কোথাও ৬০%+ বলা হয়েছে — সংজ্ঞা আর sample size ভেদে পার্থক্য), কিন্তু একটা consistent pattern স্পষ্ট:

- Postman-এর 2025 State of the API report অনুযায়ী, REST এখনও সবচেয়ে বেশি ব্যবহৃত API style — প্রায় ৯৩% team এটা ব্যবহার করে, আর GraphQL প্রায় এক-তৃতীয়াংশ team এ ব্যবহৃত হয় (ক্রমবর্ধমান)। যেহেতু developer রা একাধিক style বেছে নিতে পারে এই survey তে, এই সংখ্যা দেখায় GraphQL মূলত **REST কে replace করছে না, বরং তার পাশাপাশি ব্যবহৃত হচ্ছে**
- ২০২৬ সালের সবচেয়ে গুরুত্বপূর্ণ পর্যবেক্ষণ হলো — "GraphQL, REST কে replace করে ফেলেছে" এই কথাটা সত্যি না, বরং "Backend-for-Frontend" pattern (GraphQL একটা aggregation layer হিসেবে REST বা gRPC microservice এর ওপরে বসে) হয়ে উঠেছে সবচেয়ে প্রচলিত enterprise model — Netflix, GitHub, Shopify, Airbnb এই pattern ব্যবহার করে
- Internal microservice communication এ, Netflix, Square, Google এর মতো কোম্পানি প্রকাশ্যেই তাদের internal (east-west) communication REST/JSON থেকে gRPC/HTTP-2 তে সরিয়ে নিয়েছে। যদি কোনো organization ২০+ microservice চালায়, বিভিন্ন ভাষায় লেখা, ২০২৬ সালে gRPC সেখানে ডিফল্ট পছন্দ

**তোমার জন্য practical takeaway:** এই মুহূর্তে TaskFlow এর REST API সম্পূর্ণ সঠিক choice — কারণ এটা এখনো একটা single monolith, browser-facing। যখন (Module 9 তে) microservice এ ভাগ হবে, তখন internal communication এর জন্য gRPC বিবেচনা করা যুক্তিসঙ্গত হবে। আর যদি ভবিষ্যতে একাধিক client type (mobile app, web dashboard, partner API) একই data কে ভিন্নভাবে ব্যবহার করতে চায়, তখন GraphQL একটা aggregation layer হিসেবে যোগ করার কথা ভাবা যেতে পারে — কিন্তু "শুরু থেকেই GraphQL" করাটা একটা classic over-engineering (Lesson 1.1) হবে।

---

## ২. Interview Angle

এই টপিকে একটা খুবই common প্রশ্ন — "তুমি একটা নতুন API বানাচ্ছ, REST নাকি GraphQL বেছে নেবে?" ভালো উত্তরের কাঠামো তিনটা প্রশ্নে ভাগ করা যায় (আজকের theory থেকেই):

1. **কে call করছে এই API?** যদি browser, third-party developer, বা partner হয় — REST এর সহজলভ্যতা আর caching সুবিধা বেশি গুরুত্বপূর্ণ
2. **বিভিন্ন client কি ভিন্ন ভিন্ন field চায়?** যদি এক screen এ ৩টা field লাগে, আরেকটায় ৩০টা, আর multiple round trip লাগছে সেটা পূরণ করতে — তাহলে GraphQL এর জটিলতা justify হয়
3. **এটা কি internal, service-to-service communication, যেখানে দুই পক্ষই তোমার নিয়ন্ত্রণে?** তাহলে gRPC এর performance এবং type-safety এর সুবিধা কাজে লাগবে

এই কাঠামো দিয়ে উত্তর দিলে interviewer বুঝবে তুমি "hype" দিয়ে না, বরং **constraint দিয়ে** সিদ্ধান্ত নিচ্ছ — ঠিক Lesson 1.1 এর মূল দর্শন।

---

## ৩. Key Takeaway

- REST — resource-based, HTTP verb ব্যবহার করে, caching সহজ, কিন্তু over/under-fetching সমস্যা থাকতে পারে
- GraphQL — client নিজেই field নির্বাচন করে, over/under-fetching সমাধান করে, কিন্তু caching কঠিন এবং backend এ N+1 problem এর ঝুঁকি থাকে
- gRPC — Protobuf (binary) + strict schema + HTTP/2, extremely fast, কিন্তু browser-friendly না, মূলত internal service communication এ ব্যবহৃত
- ২০২৬ এ বাস্তব pattern: REST public/browser-facing API তে dominant, GraphQL client-aggregation layer হিসেবে growing, gRPC internal microservice communication এ dominant
- সিদ্ধান্ত নেওয়ার তিনটা প্রশ্ন: কে call করছে? বিভিন্ন client ভিন্ন data চায় কিনা? এটা internal নাকি external?

---

## ৪. নতুন Term (Glossary)

| Term                                       | অর্থ                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| **REST (Representational State Transfer)** | resource-ভিত্তিক API architectural style, HTTP verb ব্যবহার করে                         |
| **Over-fetching**                          | client যা দরকার তার চেয়ে বেশি data পাওয়া                                              |
| **Under-fetching**                         | একটা call এ যথেষ্ট data না পাওয়া, একাধিক round trip লাগা                               |
| **GraphQL**                                | client-driven query language, একটা মাত্র endpoint দিয়ে precise data fetch করা যায়     |
| **Resolver**                               | GraphQL এ, প্রতিটা field এর জন্য কীভাবে data fetch হবে সেটা নির্ধারণকারী function       |
| **N+1 Problem**                            | একটা list এর প্রতিটা item এর জন্য আলাদা আলাদা query চলে যাওয়ার সমস্যা (batching ছাড়া) |
| **gRPC**                                   | Google এর তৈরি high-performance RPC framework, Protobuf + HTTP/2 ভিত্তিক                |
| **Protocol Buffers (Protobuf)**            | একটা binary serialization format, JSON এর চেয়ে ছোট ও দ্রুত                             |
| **IDL (Interface Definition Language)**    | schema define করার ভাষা, যেটা দিয়ে client-server contract ঠিক করা হয়                  |

---

## ৫. Reflection Questions

1. TaskFlow এর mobile app এ একটা "Task List" screen আছে (শুধু title + status + due date দরকার) আর একটা "Task Detail" screen আছে (সবকিছু — description, comments, attachments, activity log সহ)। এই দুটো screen এর জন্য কি GraphQL justify হয়, নাকি এটা REST দিয়েই যথেষ্টভাবে handle করা সম্ভব (দুটো আলাদা REST endpoint বানিয়ে)? তোমার মত দাও, কারণসহ।
2. gRPC কেন browser থেকে সরাসরি ব্যবহার করা কঠিন, আর এই সীমাবদ্ধতা কীভাবে gRPC এর "internal-only" ব্যবহারের সাথে সম্পর্কিত?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** এই নির্দিষ্ট case টা আসলে GraphQL এর জন্য একটা "textbook justification" না — কারণ মাত্র দুইটা fixed screen, দুইটা ভিন্ন data shape। এটা সহজেই দুটো আলাদা REST endpoint দিয়ে সমাধান করা যায় — `GET /api/tasks` (summary fields) আর `GET /api/tasks/:id` (full detail)। GraphQL তখনই বেশি justify হতো যদি — client সংখ্যা অনেক বেশি হতো (web, iOS, Android, partner API — প্রতিটার আলাদা data চাহিদা), অথবা data shape খুবই dynamic/nested হতো (deeply related data, বিভিন্ন combination এ)। দুইটা fixed screen এর জন্য REST-ই সহজ এবং যথেষ্ট — এখানে GraphQL যোগ করা over-engineering হবে।

**প্রশ্ন ২:** gRPC মূলত HTTP/2 এর নিচু-স্তরের feature (যেমন trailers, নির্দিষ্ট framing) এর ওপর নির্ভর করে, যেগুলো browser এর standard `fetch`/XHR API দিয়ে সরাসরি access করা যায় না (browser নিজে HTTP/2 handle করে, কিন্তু JavaScript কে সেই নিচু-স্তরের control দেয় না)। তাই browser থেকে gRPC ব্যবহার করতে "gRPC-Web" নামের একটা translation layer লাগে, যেটা একটা proxy এর মাধ্যমে gRPC কে browser-compatible ফরম্যাটে রূপান্তর করে। এই বাড়তি জটিলতার কারণে, এবং যেহেতু gRPC এর মূল সুবিধা (speed, strict typing) সবচেয়ে বেশি কাজে লাগে যখন দুই পক্ষই (client + server) তোমার নিয়ন্ত্রণে — তাই এটা স্বাভাবিকভাবেই internal, service-to-service ব্যবহারের দিকে ঝুঁকে গেছে, যেখানে browser এর সীমাবদ্ধতা প্রাসঙ্গিক না।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow বড় হচ্ছে। এখন তিনটা নতুন প্রয়োজন এসেছে:
>
> **(A)** Third-party integration partners (যেমন, Slack, Zapier) TaskFlow এর সাথে integrate করতে চায় — task তৈরি, update, read করার জন্য একটা public API দরকার।
>
> **(B)** TaskFlow একটা নতুন "Analytics Dashboard" বানাচ্ছে, যেখানে বিভিন্ন widget (chart, summary card, table) প্রতিটা ভিন্ন ভিন্ন combination এ task data দেখাবে — একেকটা dashboard configuration এ একেক রকম field দরকার হতে পারে।
>
> **(C)** TaskFlow এর ভেতরেই এখন দুটো আলাদা internal service আছে — "Task Service" এবং "Notification Service" (Module 9 এর আগাম প্রস্তুতি হিসেবে ধরে নাও)। যখন একটা task create হয়, Task Service কে Notification Service কে জানাতে হয়, দ্রুত এবং reliably।
>
> প্রতিটা scenario এর জন্য REST, GraphQL, নাকি gRPC — কোনটা প্রস্তাব করবে, আর এক-দুই লাইনে কেন (Lesson এর "৩টা প্রশ্ন" framework ব্যবহার করে)?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, 2.1, 2.2
Current: 2.3 — REST vs GraphQL vs gRPC
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): [আগের মতোই — System Design, Trade-off, Requirements, Scope,
Estimation, HLD/Deep Dive, DAU/QPS, TCP Handshake, TLS, Latency/Throughput,
Availability/Reliability, SLA/SLO/Error Budget, Scaling, Stateless/Stateful]
Terms learned (Module 2 so far): DNS, TTL, Recursive/Iterative Query, DoH/DoT,
TCP vs UDP, Cipher Suite, 0-RTT, Replay Attack, REST, Over/Under-fetching, GraphQL,
Resolver, N+1 Problem, gRPC, Protobuf, IDL
Weak spots: Multi-part প্রশ্নের সব sub-part কভার করা; terminology নির্ভুলভাবে ব্যবহার;
একটা core term কে ভুল অন্য concept এর সাথে না গুলানো (2.1 এর DNS TTL vs data-retention
TTL confusion থেকে শেখা) — তবে TCP/UDP আর idempotency/0-RTT বিশ্লেষণ (2.2) এ ভালো
concrete reasoning দেখানো হয়েছে, এই habit টা এখন শক্ত হচ্ছে
Next: 2.4 — WebSocket, SSE, Long Polling (Real-time Communication)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 2.4 এ যাব: WebSocket, SSE (Server-Sent Events), আর Long Polling — real-time communication এর তিনটা প্রধান approach, এবং এটা সরাসরি সেই Lesson 1.1 এর "Real-time Notification" exercise এর সাথে যুক্ত হবে যেটা আমরা একদম শুরুতে করেছিলাম।
