# Lesson 4.1 — Cache Hierarchy: Browser → CDN → App → DB

**Module 4 — Caching**

> **Spaced Repetition (Lesson 3.1):** L4 আর L7 Load Balancer এর মূল পার্থক্য কী, আর কোনটা URL path বা header দেখে routing decision নিতে পারে?

**Prerequisite:** Lesson 1.3 (Latency numbers), Lesson 3.3 (Nginx/Reverse Proxy)

**তুমি এই lesson শেষে পারবে:**

1. একটা request এর পুরো path জুড়ে (browser থেকে database পর্যন্ত) কোথায় কোথায় caching সম্ভব — সেই সম্পূর্ণ hierarchy বলতে পারবে
2. প্রতিটা layer এর cache কী সমস্যা সমাধান করে, এবং কেন "যত কাছে, তত দ্রুত" এই নীতিতে কাজ করে — বুঝবে
3. TaskFlow এর নিজের stack (Cloudflare) এ এই hierarchy কীভাবে বাস্তবে map হয় — জানবে

**Tier:** 3 — Design Exercise (hands-on Redis caching Lesson 4.4 তে)

---

## ০. TaskFlow এখন কোথায়

Module 3 জুড়ে আমরা শিখেছি কীভাবে **একাধিক server এর মধ্যে load ভাগ করতে হয়**। কিন্তু একটা সম্পূর্ণ ভিন্ন approach আছে performance বাড়ানোর জন্য — **request টাকে backend পর্যন্ত পৌঁছাতেই না দেওয়া**, যদি সেই একই উত্তর আগে থেকেই কোথাও "মনে রাখা" (cached) থাকে।

Lesson 1.3 এর সেই latency table মনে আছে? Memory read ~100 nanosecond, disk read ~0.1 millisecond — প্রায় **১০০০ গুণ পার্থক্য**। এই পুরো Module 4 আসলে এই একটা সত্যের ওপর দাঁড়িয়ে আছে — **যদি একটা answer আগে থেকেই কাছাকাছি কোথাও (এবং দ্রুত মাধ্যমে) রাখা যায়, database পর্যন্ত না গিয়েই কাজ শেষ করা যায়।** আজকে আমরা পুরো hierarchy টা দেখব — ঠিক কোথায় কোথায় এই "caching" ঘটতে পারে, client থেকে database পর্যন্ত।

---

## ১. Theory

### ১.১ পুরো Cache Hierarchy — একটা Request এর সম্পূর্ণ যাত্রা

```
[Browser Cache] ──> [CDN / Edge Cache] ──> [Reverse Proxy Cache] ──> [App Cache
                                                                       (Redis)] ──> [DB Cache
                                                                                    (internal buffer)] ──> [Disk]

     ~0ms              ~10-50ms                 ~1-5ms                ~0.5-1ms            ~0.1ms          ~1-10ms+
  (network ই লাগে না)  (কাছের data center)    (একই data center)    (in-memory)        (RAM এ, কিন্তু      (actual
                                                                                        DB engine এর       storage read)
                                                                                        নিজস্ব cache)
```

প্রতিটা layer এর একটা সাধারণ নীতি — **request যত কম দূরত্ব পাড়ি দেয়, তত দ্রুত উত্তর পাওয়া যায়।** চলো প্রতিটা layer আলাদাভাবে দেখি।

### ১.২ Layer 1 — Browser Cache

এটা সবচেয়ে কাছের এবং দ্রুততম layer — request **network এই যায় না**, কারণ browser নিজের local storage থেকেই উত্তর দিয়ে দেয়। এটা নিয়ন্ত্রিত হয় HTTP response এর `Cache-Control` header দিয়ে:

```
Cache-Control: max-age=3600
```

এর মানে — "এই resource টা ১ ঘণ্টা পর্যন্ত browser নিজের কাছে রেখে দাও, আবার server কে জিজ্ঞেস কোরো না"। এটা মূলত static asset এ ব্যবহৃত হয় (CSS, JS, images) — TaskFlow এর logo বারবার fetch করার দরকার নেই যদি সেটা browser এ আগে থেকেই আছে।

### ১.৩ Layer 2 — CDN / Edge Cache

Browser cache miss হলে (প্রথমবার visit, বা cache expired), পরের নিকটতম layer হলো **CDN (Content Delivery Network)** — এটা তোমার নিজের stack এ Cloudflare। ২০২৬ সালে, Cloudflare এর মতো বড় CDN provider রা ৩০০+ PoP (Points of Presence, মানে data center) দিয়ে বিশ্বজুড়ে ছড়িয়ে আছে, তাই একজন user যেখানেই থাকুক না কেন, তার কাছাকাছি একটা edge location থেকেই response আসতে পারে, মূল (origin) server পর্যন্ত না গিয়েই।

Cloudflare এ দুই ধরনের TTL কাজ করে — "Edge Cache TTL" (Cloudflare এর নিজস্ব global network এ কতক্ষণ রাখা হবে) এবং "Browser Cache TTL" (visitor এর browser এ কতক্ষণ রাখা হবে)। লক্ষ্য করো — এখানেও সেই **TTL** ধারণাটাই ফিরে এসেছে, যেটা আমরা Lesson 2.1 (DNS) এবং Lesson 2.5 (Idempotency Key) এ দেখেছিলাম — একই "কতক্ষণ মনে রাখব" ধারণা, প্রতিবার ভিন্ন প্রসঙ্গে প্রয়োগ হচ্ছে।

**একটা গুরুত্বপূর্ণ সতর্কতা:** Logged-in user এর personal/sensitive data (যেমন, TaskFlow এর dashboard, যেটা প্রতিটা user এর জন্য আলাদা) কখনো CDN এ cache করা উচিত না — session cookie বা auth token দেখে সেটা bypass করানো উচিত। এটা গুরুত্বপূর্ণ কারণ ভুলবশত একজনের personal task list অন্যজনের browser এ cache হয়ে গেলে সেটা একটা মারাত্মক security bug হয়ে দাঁড়াবে।

### ১.৪ Layer 3 — Reverse Proxy Cache

Lesson 3.3 তে আমরা Nginx কে শুধু load balancer হিসেবে ব্যবহার করেছি, কিন্তু Nginx নিজেও একটা caching layer হতে পারে — backend থেকে একবার response এনে, কিছুক্ষণের জন্য নিজের কাছে রেখে দেওয়া, যাতে একই request বারবার এলে backend পর্যন্ত না যেতে হয়। এটা CDN এর মতোই কাজ করে, কিন্তু geographically distributed না — এটা তোমার নিজের infrastructure এর ভেতরেই, backend এর ঠিক সামনে।

### ১.৫ Layer 4 — Application Cache (Redis)

এতক্ষণ যা দেখলাম, সবই **static বা semi-static content** এর জন্য ভালো কাজ করে। কিন্তু TaskFlow এর `/api/tasks` এর মতো dynamic, personalized data এর জন্য browser/CDN cache করা কঠিন (প্রতিটা user এর জন্য আলাদা result)। এখানে দরকার হয় **application-level cache** — Redis এর মতো একটা দ্রুত, in-memory data store, যেটা তোমার Express server এর ঠিক পাশে বসে।

এখানে logic টা application কোড এর ভেতরেই থাকে: "task list এর জন্য database এ query করার আগে, একবার Redis এ check করো — যদি সেখানে থাকে, database এ না গিয়েই ফেরত দাও।" এটাই Module 4 এর মূল hands-on বিষয়, Lesson 4.4 এ আমরা এটা সরাসরি implement করব।

### ১.৬ Layer 5 — Database এর নিজস্ব Cache

এমনকি যদি Redis এও data না থাকে, request DB পর্যন্ত পৌঁছালেও, সেটা সরাসরি disk এ যায় না। PostgreSQL এর নিজস্ব একটা internal memory cache আছে — **buffer pool** (`shared_buffers` configuration দিয়ে নিয়ন্ত্রিত) — যেখানে সম্প্রতি ব্যবহৃত data page গুলো memory তে রাখা থাকে। যদি একই row বারবার query হয়, PostgreSQL নিজে থেকেই সেটা memory থেকে দিয়ে দেয়, disk পর্যন্ত না গিয়ে।

**তোমার Sequelize experience এর সাথে সংযোগ:** এই layer টা তুমি সরাসরি নিয়ন্ত্রণ করো না (এটা PostgreSQL নিজে manage করে), কিন্তু এটা জানাটা গুরুত্বপূর্ণ — এটাই ব্যাখ্যা করে কেন **একই query বারবার চালালে দ্বিতীয়বার থেকে দ্রুত হয়** (প্রথমবার disk থেকে load হয়, পরে buffer pool থেকে)।

> **Trade-off Table — Cache Hierarchy এর প্রতিটা Layer**

| Layer                | কী cache করে                      | কার নিয়ন্ত্রণে                                                  | Best fit                                  |
| -------------------- | --------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Browser              | Static asset                      | `Cache-Control` header (তোমার backend সেট করে, browser মেনে চলে) | CSS, JS, images                           |
| CDN                  | Static + semi-static content      | CDN configuration (Cloudflare Dashboard/Cache Rules)             | Public, non-personalized content          |
| Reverse Proxy        | Backend response                  | Nginx config                                                     | Semi-dynamic, shared content              |
| Application (Redis)  | Personalized/dynamic query result | তোমার application code                                           | User-specific data, expensive computation |
| Database Buffer Pool | Data page                         | Database engine নিজে                                             | সব query (automatic, transparent)         |

---

## ২. Interview Angle

একটা প্রায়-guaranteed প্রশ্ন — "একটা request এর জন্য caching কোথায় কোথায় হতে পারে, ব্যাখ্যা করো।" ভালো উত্তরে ঠিক আজকের এই hierarchy টা top-to-bottom বলা উচিত, প্রতিটা layer এ **কেন** সেই layer দরকার এবং **কোন ধরনের data** এর জন্য উপযুক্ত সেটা সহ। একটা common follow-up: "personalized data (যেমন, ইউজারের নিজস্ব dashboard) কীভাবে cache করবে, যখন CDN এ এটা করা যায় না?" — এখানেই application-level cache (Redis) এর কথা বলা উচিত, key তে user ID অন্তর্ভুক্ত করে (যেমন `tasks:user:123`), যাতে প্রতিটা user এর data আলাদাভাবে cache হয়।

---

## ৩. Key Takeaway

- Cache hierarchy: Browser → CDN → Reverse Proxy → Application (Redis) → Database Buffer Pool → Disk
- প্রতিটা layer "কাছের" এবং "দ্রুততর", কিন্তু "personalization" handle করার ক্ষমতা কমে যায় যত ওপরে (browser/CDN) যাওয়া হয়
- Static/shared content → browser/CDN এ ভালো fit; Personalized/dynamic content → application-level cache (Redis) দরকার
- Sensitive/personal data কখনো CDN এ cache করা উচিত না — এটা একটা গুরুতর security ঝুঁকি
- Database এর নিজস্ব buffer pool automatically কাজ করে, কোনো explicit configuration ছাড়াই (কিছুটা tuning সম্ভব)
- একই "TTL" ধারণা (Lesson 2.1, 2.5) এখানেও প্রযোজ্য — প্রতিটা cache layer এর নিজস্ব "কতক্ষণ মনে রাখব" সিদ্ধান্ত থাকে

---

## ৪. নতুন Term (Glossary)

| Term                               | অর্থ                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| **Cache Hierarchy**                | client থেকে database পর্যন্ত caching এর বিভিন্ন স্তর                                |
| **CDN (Content Delivery Network)** | geographically distributed server network, content কে user এর কাছাকাছি রাখে         |
| **PoP (Point of Presence)**        | CDN এর একটা নির্দিষ্ট geographic data center                                        |
| **Edge Cache TTL**                 | CDN এর নিজের global network এ content কতক্ষণ রাখা হবে                               |
| **Buffer Pool**                    | Database engine এর নিজস্ব internal memory cache, recently-used data page রাখার জন্য |

---

## ৫. Reflection Questions

1. TaskFlow এর landing page (marketing content, সবার জন্য একই) আর `/api/tasks` (প্রতিটা user এর জন্য আলাদা) — এই দুটোর জন্য cache hierarchy এর কোন কোন layer প্রযোজ্য, এবং কোনগুলো প্রযোজ্য না?
2. যদি একজন user তার profile picture আপডেট করে, কিন্তু CDN এ পুরনো ছবিটা এখনও কয়েক ঘণ্টার জন্য cache করা আছে (Edge Cache TTL), তাহলে user কী দেখবে? এটা কী ধরনের সমস্যা তৈরি করে (পরের lesson গুলোর একটা preview)?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Landing page এর জন্য **সবগুলো layer** প্রযোজ্য — browser cache, CDN, এমনকি reverse proxy cache — কারণ এটা সবার জন্য একই content, personalization নেই। `/api/tasks` এর জন্য browser cache এবং CDN **প্রযোজ্য না** (বা অত্যন্ত সীমিত, শুধু short-TTL সহ) কারণ এটা প্রতিটা user এর জন্য আলাদা এবং প্রায়ই changing data — এখানে শুধু application-level cache (Redis, user-specific key সহ) এবং database buffer pool প্রযোজ্য।

**প্রশ্ন ২:** User পুরনো ছবিটাই দেখতে থাকবে, যতক্ষণ না Edge Cache TTL expire হয় (বা manually purge করা হয়)। এটাই **Cache Invalidation** সমস্যা — "cache কে জানানো যে underlying data বদলে গেছে, তাই পুরনো cached version আর ব্যবহারযোগ্য না" — এটা Computer Science এর একটা বিখ্যাত কঠিন সমস্যা ("There are only two hard things in Computer Science: cache invalidation and naming things"), এবং এটাই Lesson 4.3 এর মূল বিষয়।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

> TaskFlow এর নিচের চারটা resource এর জন্য, cache hierarchy এর **কোন কোন layer** প্রযোজ্য বলে মনে করো (একাধিক হতে পারে), আর কেন:
>
> 1. TaskFlow এর লোগো (SVG file, কখনো বদলায় না)
> 2. `GET /api/tasks` (প্রতিটা user এর নিজস্ব task list)
> 3. একটা public "TaskFlow দিয়ে কী কী করা যায়" marketing blog post (সবার জন্য একই, মাসে একবার update হয়)
> 4. `POST /api/tasks` (নতুন task তৈরি করা)

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (সম্পূর্ণ)
Current: 4.1 — Cache Hierarchy
TaskFlow state: Nginx reverse proxy + LB সামনে, horizontal-scale-ready backend,
এখন caching layer যোগ হওয়ার প্রস্তুতি শুরু
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 4.2 — Caching Strategies (Cache-Aside, Write-Through, Write-Behind, Read-Through)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — Lesson 4.2 এ যাব: Caching Strategies — Cache-Aside, Write-Through, Write-Behind, Read-Through — কীভাবে application কোড আর cache একসাথে কাজ করে, বিভিন্ন pattern এর trade-off সহ।
