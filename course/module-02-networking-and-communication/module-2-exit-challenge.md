# Module 2 — Exit Challenge

**Module 2 — Networking & Communication**

Module 2 এর ৫টা lesson শেষ — DNS, TCP/UDP/TLS, REST/GraphQL/gRPC, WebSocket/SSE/Long Polling, আর API Design at Scale। এই Exit Challenge এ এই সবগুলো concept **একসাথে**, একটা বাস্তবসম্মত scenario তে প্রয়োগ করতে হবে।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow এখন সফল, এবং একটা বড় সিদ্ধান্ত নিয়েছে — **তৃতীয় পক্ষের (third-party) developer দের জন্য একটা Public Integration API** চালু করবে। এর মাধ্যমে partner রা (যেমন Slack, Zapier, বা কোনো company নিজেদের internal tool থেকে) TaskFlow এর task তৈরি, তালিকা দেখা এবং update করতে পারবে।
>
> এর পাশাপাশি, একটা নতুন internal admin feature ও আসছে — **"Live Partner Activity Monitor"**, যেখানে TaskFlow এর নিজের team দেখতে পারবে কোন partner API কতগুলো request পাঠাচ্ছে, real-time এ, একটা dashboard এ।

তোমার কাজ — নিচের প্রতিটা প্রশ্নে Module 2 এর concept প্রয়োগ করে সিদ্ধান্ত নাও এবং reasoning দাও:

**১. API Paradigm (Lesson 2.3)**
Partner-facing API এর জন্য REST, GraphQL, নাকি gRPC বেছে নেবে? তোমার lesson এর "৩টা প্রশ্ন" framework ব্যবহার করে যুক্তি দাও।

**২. Versioning + Pagination (Lesson 2.5)**
Partner রা `GET /tasks` call করে সব task এর তালিকা পাবে। এই endpoint এর জন্য:

- কোন versioning strategy ব্যবহার করবে?
- Offset নাকি cursor-based pagination? কেন (নির্দিষ্টভাবে এই partner-API context এ চিন্তা করো — partner রা কীভাবে এই endpoint ব্যবহার করবে সেটা ভাবো)?

**৩. Idempotency (Lesson 2.5)**
Partner রা `POST /tasks` দিয়ে নতুন task তৈরি করতে পারবে। এখানে Idempotency Key pattern কীভাবে প্রযোজ্য? এই ক্ষেত্রে **যদি একই key তে ভিন্ন body আসে**, সেটা কীভাবে handle করা উচিত (তোমার নিজের হাতে-কলমে করা exercise থেকেই উত্তর দাও)?

**৪. Real-time Mechanism (Lesson 2.4)**
"Live Partner Activity Monitor" এর জন্য — WebSocket, SSE, নাকি Long Polling? Bidirectional প্রয়োজনীয়তা বিবেচনা করে সিদ্ধান্ত নাও এবং কারণ দাও।

**৫. Transport এবং Security (Lesson 2.1, 2.2)**
Partner রা `api.taskflow.app` নামে একটা নতুন subdomain ব্যবহার করবে।

- এই নতুন subdomain এর DNS TTL নিয়ে (launch এর সময়) কী চিন্তা করবে?
- TLS এর ক্ষেত্রে কোন version(গুলো) সাপোর্ট করবে (Lesson 2.2 এর ২০২৬ standard মনে করে)?

**৬. Error Contract (Lesson 2.5)**
Partner যদি একটা invalid task ID দিয়ে `GET /tasks/:id` call করে (task টা exist করে না), তাহলে error response এর একটা concrete JSON example লেখো, তোমার lesson এর error contract format অনুসরণ করে।

**মনে রাখার একটা কথা:** প্রতিটা উত্তরে শুধু "কী বেছে নিলাম" না, **"কী ছাড় দিচ্ছি"** সেটাও এক লাইনে বলার চেষ্টা করো — এটাই তোমার Module 2 জুড়ে মূল improvement area ছিল (2.3 এর GraphQL answer থেকে শুরু করে)।

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

- [ ] URL থেকে response আসা পর্যন্ত DNS lookup এর পুরো chain (Recursive/Iterative, TTL) ব্যাখ্যা করতে পারি
- [ ] TCP vs UDP কখন কোনটা উপযুক্ত, উদাহরণসহ বলতে পারি
- [ ] TLS handshake এর ধাপ, এবং TLS 1.2 vs 1.3 এর round-trip পার্থক্য বুঝি
- [ ] REST, GraphQL, gRPC — এই তিনটার মধ্যে সঠিক পছন্দ, constraint অনুযায়ী (hype না) করতে পারি
- [ ] Over-fetching/Under-fetching, N+1 Problem এই টার্মগুলো সঠিক প্রসঙ্গে ব্যবহার করতে পারি
- [ ] WebSocket, SSE, Long Polling এর মধ্যে bidirectional-ity এবং frequency এর ভিত্তিতে সিদ্ধান্ত নিতে পারি
- [ ] Offset vs Cursor pagination এর trade-off এবং কখন কোনটা বলতে পারি
- [ ] Idempotency Key pattern **নিজে হাতে implement** করতে পারি (legitimate retry vs payload mismatch এর পার্থক্য সহ) — এটা তুমি আজকে verified code দিয়ে প্রমাণ করেছ
- [ ] একটা সামঞ্জস্যপূর্ণ Error Contract ডিজাইন করতে পারি

তোমার Idempotency Key hands-on exercise টা দেখে বলা যায় — শেষ বক্সটা নিয়ে তোমার কোনো সন্দেহ থাকার কথা না, ওটা তুমি বাস্তবে verify করে দেখিয়েছ।

---

## ৩. Recommendation

**পড়ার জন্য:**

- Stripe এর নিজস্ব [Idempotency Keys documentation](https://docs.stripe.com/api/idempotent_requests) — তোমার আজকের exercise এর সাথে সরাসরি তুলনা করে দেখতে পারবে, বাস্তব production system এ ঠিক কী কী edge case handle করা হয় (যেমন, concurrent request একই key দিয়ে একসাথে এলে কী হয় — এটা তোমার current in-memory implementation এ handle হয় না, কারণ সেটার জন্য locking/atomic operation লাগে, যেটা আমরা পরে database transaction context এ শিখব)

**দেখার জন্য:**

- gRPC এর official "Basics tutorial" (grpc.io তে) — Node.js/TypeScript দিয়ে একটা ছোট service বানানোর হাতে-কলমে গাইড, Module 9 এর আগে familiarity তৈরি করতে সাহায্য করবে

**Project এর জন্য:**

- তোমার topup-backend এ (course এর বাইরে, নিজের সময়ে) — যদি কোনো payment-related endpoint এ এখনও idempotency key implement করা না থাকে, আজকের pattern টা (হ্যাশ-ভিত্তিক payload comparison + TTL) সেখানে সরাসরি প্রয়োগযোগ্য, শুধু in-memory Map এর জায়গায় Redis ব্যবহার করতে হবে (persistence এবং multi-instance এর জন্য, Lesson 1.6 এর stateless নীতি মনে করে)

---

Exit challenge টা করে পাঠাও। রেডি হলে `next` লিখলে আমরা **Module 3: Load Balancing & Proxies** এ যাব — Lesson 3.1 দিয়ে শুরু, যেখানে TaskFlow প্রথমবারের মতো সত্যিকারের multi-server architecture তে যাবে, এবং তোমার Lesson 1.6 এর "Stateless" জ্ঞান এখানে সরাসরি কাজে লাগবে।
