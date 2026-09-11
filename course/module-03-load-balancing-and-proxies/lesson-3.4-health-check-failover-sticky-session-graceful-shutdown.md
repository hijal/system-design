# Lesson 3.4 — Health Check, Failover, Sticky Session, Graceful Shutdown

**Module 3 — Load Balancing & Proxies**

**Prerequisite:** Lesson 3.1–3.3

**তুমি এই lesson শেষে পারবে:**

1. Passive vs Active health check এর পার্থক্য বুঝবে, এবং Nginx open-source এ কোনটা default এ পাওয়া যায় জানবে
2. Failover কীভাবে কাজ করে (একটা backend fail করলে request কীভাবে অন্য backend এ যায়) — ব্যাখ্যা করতে পারবে
3. Sticky Session এর বাস্তব সমস্যা (IP-based এর সীমাবদ্ধতা) এবং Graceful Shutdown কেন deployment এ গুরুত্বপূর্ণ — বুঝবে

**Tier:** 3 — Design Exercise (Lesson 3.3 এর Docker setup extend করার একটা optional hands-on suggestion সহ)

---

## ০. TaskFlow এখন কোথায়

Lesson 3.3 এর Experiment #৩ তে আমি তোমাকে বলেছিলাম — একটা backend container বন্ধ করে দেখো কী হয়। তুমি হয়তো লক্ষ্য করেছ (বা করবে) — Nginx **সম্পূর্ণ ignore করে না** ব্যাপারটা, কিন্তু প্রথম কিছু request fail ও হতে পারে। আজকের lesson ঠিক এই আচরণের ভেতরের mechanism ব্যাখ্যা করবে, এবং একটা honesty-check ও করব — Lesson 3.3 এর README এ আমি যা লিখেছিলাম, সেটা এখন আরেকটু precise করা দরকার।

---

## ১. Theory

### ১.১ Passive Health Check — Nginx Open-Source এর Default আচরণ

Lesson 3.3 তে আমি বলেছিলাম "plain Nginx active health check করে না by default"। এটা সত্যি, কিন্তু এটা পুরো ছবি না — verify করার পর একটা গুরুত্বপূর্ণ সংশোধন করছি:

Passive health check এ, Nginx বাস্তব transaction গুলো monitor করে, এবং যদি একটা connection fail হয়ে যায় (resume করা না গেলে), Nginx সেই server টাকে "unavailable" হিসেবে চিহ্নিত করে এবং সাময়িকভাবে সেখানে request পাঠানো বন্ধ করে দেয়, যতক্ষণ না সেটা আবার "active" হিসেবে চিহ্নিত হয়। এই আচরণ নিয়ন্ত্রিত হয় দুটো parameter দিয়ে — `fail_timeout` (কতক্ষণের মধ্যে কতগুলো ব্যর্থ চেষ্টা হলে server কে unavailable ধরা হবে, এবং কতক্ষণ সেটা unavailable থাকবে — ডিফল্ট ১০ সেকেন্ড), আর `max_fails` (কতগুলো ব্যর্থ চেষ্টার পর server কে unavailable বলা হবে — ডিফল্ট মাত্র ১ বার)।

মানে — **stock Nginx এ default ভাবেই একটা basic protection আছে** (`max_fails=1`, `fail_timeout=10s`) — সম্পূর্ণ কিছুই নেই এমনটা না। কিন্তু এখানে একটা critical সীমাবদ্ধতা আছে:

```
Passive Health Check এর সমস্যা:

Backend 2 crash করল
      │
      ▼
[একজন REAL USER এর request Backend 2 তে যায়] ──> FAIL, user error দেখে!
      │
      ▼
এখন Nginx বুঝল Backend 2 unavailable, ১০ সেকেন্ডের জন্য বাদ দিল
```

Passive check এ সমস্যা হলো — সেই ব্যর্থতা গুলো real user রাই অনুভব করে। যদি `max_fails=3` হয়, তিনজন user error পাবে, তারপর Nginx সেই server এ traffic পাঠানো বন্ধ করবে।

**Active Health Check** এর সমাধান ভিন্ন — Nginx নিয়মিত interval এ, প্রকৃত client traffic থেকে সম্পূর্ণ স্বাধীনভাবে, backend server গুলোতে dedicated "probe" request পাঠায়। যদি একটা server probe এ সাড়া না দেয়, Nginx সেটাকে rotation থেকে সরিয়ে নেয় _আগেই_, কোনো real user request সেখানে পৌঁছানোর আগেই।

**একটা গুরুত্বপূর্ণ honesty note:** Active health check শুধু NGINX Plus এ পাওয়া যায় (paid product), stock/open-source Nginx এ না — যদিও `nginx_upstream_check_module` এর মতো third-party module দিয়ে open-source এ ও এটা achieve করা সম্ভব। তাই Lesson 3.3 তে আমার আসল বক্তব্য সঠিক ছিল (plain Nginx active check করে না), কিন্তু "কিছুই করে না" এই ধারণাটা ভুল ছিল — এটা passive ভাবে ঠিকই react করে, শুধু প্রথম কয়েকজন user কে একটা error সহ্য করতে হয়।

### ১.২ Failover — ব্যর্থ Request কে অন্য Server এ পাঠানো

শুধু "server কে unavailable মার্ক করা" যথেষ্ট না — যে request টা fail হয়েছিল, সেটার কী হবে? এখানে আসে **Failover** — Nginx কে বলা যায় (`proxy_next_upstream` directive দিয়ে) যে, যদি একটা backend থেকে error আসে, সেই একই request টা **স্বয়ংক্রিয়ভাবে আরেকটা backend এ retry করো**, client কে error দেখানোর আগে:

```
Client request ──> Nginx ──> Backend 2 (down) ──> ERROR
                      │
                      └──> Nginx নিজে থেকেই retry করে ──> Backend 3 ──> SUCCESS
                                                              │
Client শুধু SUCCESS response ই দেখে, কোনো error টের পায় না!
```

এটা user experience এর জন্য গুরুত্বপূর্ণ — Lesson 1.5 এর Availability মনে আছে? একটা backend down থাকা সত্ত্বেও, failover ঠিকভাবে configure করা থাকলে **client কখনো সেই downtime টের ই পায় না**, কারণ Nginx transparently retry করে দেয়।

### ১.৩ Sticky Session — IP Hash এর বাস্তব সমস্যা

Lesson 3.2 তে আমরা IP Hash সম্পর্কে শিখেছিলাম, কিন্তু একটা বাস্তব সমস্যা তখন উল্লেখ করা হয়নি — **একই IP থেকে অনেক ভিন্ন ভিন্ন user আসতে পারে**। ভাবো — একটা office, বা একটা university campus, বা একটা mobile network (carrier-grade NAT) — এখানে শত শত ভিন্ন user একই public IP address শেয়ার করে! IP Hash ব্যবহার করলে, তাদের **সবাইকে একই backend server এ পাঠানো হবে**, যেটা:

1. Load distribution কে অন্যায্য করে তোলে (একটা server এ অস্বাভাবিক বেশি চাপ)
2. যদি সেই একটা server down হয়, সেই পুরো office/campus এর সব user একসাথে প্রভাবিত হয়

**একটা বেশি নির্ভরযোগ্য বিকল্প — Cookie-based Sticky Session।** এখানে LB প্রথমবার request handle করার পর, response এ একটা cookie সেট করে দেয় (যেমন, `X-Backend-Server: backend-2`)। পরের request এ client সেই cookie ফেরত পাঠায়, আর LB সেটা দেখে সরাসরি সেই backend এ পাঠায় — IP নির্বিশেষে, প্রতিটা individual browser/user স্বাধীনভাবে ট্র্যাক হয়।

**কিন্তু মূল প্রশ্নটা থেকেই যায় — Lesson 1.6 এর পাঠ:** Sticky session (IP-based হোক বা cookie-based) — দুটোই আসলে **stateful architecture এর জন্য একটা workaround**, ideal সমাধান না। যদি TaskFlow এর server গুলো সত্যিকারের stateless হয় (session data Redis এ, file S3 এ), sticky session এর **কোনো প্রয়োজনই নেই** — এটা তোমার নিজের answer এ (Lesson 3.2 exercise) সঠিকভাবে বলেছিলে।

### ১.৪ Graceful Shutdown — একটা Server কে "নরমভাবে" বিদায় জানানো

এখন একটা নতুন সমস্যা — ধরো, তুমি TaskFlow এর একটা backend এ নতুন code deploy করতে চাও। সহজ উপায় হলো সেই server টা বন্ধ করে দেওয়া, নতুন code দিয়ে আবার চালু করা। কিন্তু যদি সেই মুহূর্তে সেই server **কিছু request process করছিল** (মাঝপথে), তাহলে হঠাৎ বন্ধ করলে সেই request গুলো **অসম্পূর্ণ অবস্থায় ব্যর্থ হয়ে যাবে** — user রা error পাবে।

**Graceful Shutdown** এই সমস্যার সমাধান — এটা একটা তিন-ধাপের প্রক্রিয়া:

```
১. Server কে "draining" mode এ রাখা — নতুন কোনো request গ্রহণ করবে না,
   কিন্তু চলমান (in-flight) request গুলো শেষ করতে দেওয়া হবে

২. LB কে জানানো — "এই server কে আর নতুন traffic পাঠিও না"
   (Nginx এ এর জন্য upstream থেকে সেই server এর line টা comment/remove
    করে reload করা, অথবা Nginx Plus এ dynamic API দিয়ে drain করা)

৩. যখন সব in-flight request শেষ হয়ে গেছে (অথবা একটা timeout পার হয়ে
   গেছে) — তখনই server টা সম্পূর্ণ বন্ধ করা
```

Node.js/Express এ practically এটা implement হয় SIGTERM signal handle করে — server নতুন connection নেওয়া বন্ধ করে, কিন্তু existing connection গুলো শেষ হতে দেয়, তারপর process exit করে। এটা এমন একটা pattern যেটা তোমার topup-backend এর মতো production system এ deployment এর সময় সরাসরি প্রাসঙ্গিক — এটা বিস্তারিত আমরা Module 10.6 (Deployment strategies — blue-green, canary) এ আরও গভীরে দেখব।

> **Trade-off Table — এই lesson এর concept গুলো**

| Concept                          | সমস্যা যেটা সমাধান করে                                   | সীমাবদ্ধতা                                                     |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Passive Health Check             | Downed server detect করা (delayed)                       | প্রথম কয়েকজন user error পায়                                  |
| Active Health Check              | Proactive detection, user কখনো error দেখে না             | NGINX Plus (paid) বা third-party module লাগে                   |
| Failover (`proxy_next_upstream`) | একটা backend fail করলেও client transparent response পায় | Retry এর কারণে সামান্য latency বাড়তে পারে                     |
| Cookie-based Sticky Session      | IP Hash এর "shared IP" সমস্যা এড়ানো                     | তবুও stateful architecture এর workaround, root cause সমাধান না |
| Graceful Shutdown                | Deployment এর সময় in-flight request harm না হওয়া       | Implementation এ extra care লাগে (SIGTERM handling)            |

---

## ২. Interview Angle

একটা common (Kubernetes-প্রভাবিত, কিন্তু general concept হিসেবেও গুরুত্বপূর্ণ) terminology distinction — **Liveness vs Readiness**। "Liveness check" জিজ্ঞেস করে "server টা কি বেঁচে আছে (crash করেনি)?", আর "Readiness check" জিজ্ঞেস করে "server টা কি **এই মুহূর্তে** নতুন traffic নেওয়ার জন্য প্রস্তুত?" (হয়তো এটা বেঁচে আছে, কিন্তু startup এ এখনও database connection সম্পূর্ণ হয়নি, বা graceful shutdown চলছে)। একটা ভালো `/health` endpoint এই দুটো প্রশ্নের আলাদা উত্তর দিতে পারা উচিত — শুধু "OK" বলে দেওয়া যথেষ্ট গভীর না production system এ।

আরেকটা প্রশ্ন যেটা প্রায়ই আসে — "Zero-downtime deployment কীভাবে করবে?" এখানে Graceful Shutdown + Load Balancer এর draining ক্ষমতা একসাথে mention করা উচিত — নতুন version এর server চালু করা, LB কে ধীরে ধীরে নতুন version এ traffic পাঠাতে বলা, পুরনো version কে drain করে তারপর বন্ধ করা — এই পুরো pattern টাকে বলে **Rolling Deployment** (Module 10.6 এ বিস্তারিত)।

---

## ৩. Key Takeaway

- Stock Nginx এ **default ভাবেই passive health check আছে** (`max_fails=1`, `fail_timeout=10s`) — সম্পূর্ণ unprotected না, কিন্তু প্রথম কিছু user error পেতে পারে
- Active health check (proactive, user-transparent) শুধু NGINX Plus বা third-party module এ পাওয়া যায়
- Failover (`proxy_next_upstream`) একটা failed request কে transparently আরেকটা backend এ পাঠায়
- IP Hash sticky session এ "shared IP" সমস্যা আছে (office/campus/carrier NAT) — cookie-based sticky session এটা এড়ায়, কিন্তু root সমাধান হলো stateless architecture
- Graceful Shutdown — draining, তারপর shutdown, in-flight request কে রক্ষা করার জন্য — deployment এর সময় অপরিহার্য

---

## ৪. নতুন Term (Glossary)

| Term                      | অর্থ                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Passive Health Check**  | real traffic এর ব্যর্থতা observe করে server কে unavailable মার্ক করা                              |
| **Active Health Check**   | নিয়মিত interval এ dedicated probe পাঠিয়ে proactively server এর অবস্থা যাচাই করা                 |
| **Failover**              | একটা backend fail করলে request কে অন্য backend এ transparently পাঠানো                             |
| **Draining**              | একটা server কে নতুন request নেওয়া বন্ধ করানো, কিন্তু চলমান request শেষ করতে দেওয়া               |
| **Graceful Shutdown**     | draining এর পর, সব in-flight request শেষ হলে server সম্পূর্ণ বন্ধ করা                             |
| **Liveness vs Readiness** | server "বেঁচে আছে" কিনা বনাম "এই মুহূর্তে traffic নেওয়ার জন্য প্রস্তুত" কিনা — দুটো ভিন্ন প্রশ্ন |

---

## ৫. Reflection Questions

1. তুমি যদি TaskFlow এ শুধু default (`max_fails=1`, `fail_timeout=10s`) passive health check রাখো, একটা backend crash করলে ঠিক কতজন user (roughly) সরাসরি error দেখতে পারে, এই default value গুলো অনুযায়ী?
2. Graceful Shutdown ছাড়া (সরাসরি `docker stop` করলে) একটা backend এ চলমান একটা "Create Task" request এর কী হতে পারে? (Lesson 2.5 এর Idempotency Key এর সাথে এটা কীভাবে সম্পর্কিত ভাবো)

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** `max_fails=1` মানে **মাত্র ১টা ব্যর্থ চেষ্টার পরই** Nginx সেই server কে unavailable মার্ক করবে — তাই তাত্ত্বিকভাবে শুধু ১জন user (যার request প্রথম সেই crashed backend এ গিয়েছিল) সরাসরি error দেখবে, তারপর `fail_timeout=10s` এর জন্য Nginx সেই server এড়িয়ে চলবে। তবে বাস্তবে, high-traffic এ, `fail_timeout` শেষ হওয়ার পর Nginx আবার সেই (এখনো crashed) server টা try করবে, ফলে আরও ১জন user error পেতে পারে, এই চক্র চলতেই থাকবে যতক্ষণ না server টা আসলে ঠিক হয় বা manually rotation থেকে সরানো হয়।

**প্রশ্ন ২:** Graceful shutdown ছাড়া হঠাৎ বন্ধ করলে, সেই "Create Task" request টা **মাঝপথে বিচ্ছিন্ন** হয়ে যাবে — client হয়তো কোনো response ই পাবে না (timeout), বা একটা connection error পাবে। এখানেই Idempotency Key এর গুরুত্ব সরাসরি প্রাসঙ্গিক — client, response না পেয়ে, নিরাপদে **retry** করতে পারবে (একই idempotency key দিয়ে), এবং যদি প্রথম request টা আসলে database এ save হয়ে গিয়েছিল (শুধু response client পর্যন্ত পৌঁছায়নি), retry সেই আগের result ই ফেরত পাবে, duplicate task তৈরি হবে না। এটা দেখায় কীভাবে Module 2 এর concept (Idempotency) আর Module 3 এর concept (Graceful Shutdown/failure) একসাথে মিলে একটা resilient system তৈরি করে — একটা ছাড়া আরেকটা অসম্পূর্ণ সুরক্ষা দেয়।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise** (Lesson 3.3 এর Docker setup থাকলে, নিচের অংশ হাতেকলমে extend করেও দেখতে পারো, কিন্তু বাধ্যতামূলক না)

> নিচের প্রশ্নগুলোর উত্তর দাও:
>
> 1. Lesson 3.3 এর `nginx.conf` এ `max_fails=2` এবং `fail_timeout=5s` যোগ করলে (each `server` line এ) — এই পরিবর্তন backend crash হলে user experience কীভাবে বদলাবে, আগের default এর (`max_fails=1`, `fail_timeout=10s`) তুলনায়?
> 2. TaskFlow এর "Create Task" এবং "Get Task List" — এই দুটো endpoint এর মধ্যে কোনটাতে `proxy_next_upstream` (failover) ব্যবহার করা তুলনামূলক বেশি নিরাপদ, আর কোনটাতে সাবধান হওয়া উচিত? (ইঙ্গিত: idempotency এবং GET vs POST এর পার্থক্য নিয়ে চিন্তা করো)
> 3. একটা "planned maintenance" (তুমি জেনেশুনে একটা backend বন্ধ করবে, deploy করার জন্য) বনাম একটা "unexpected crash" — এই দুই ক্ষেত্রে graceful shutdown এর ভূমিকা কি একই, নাকি ভিন্ন? ব্যাখ্যা করো।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 + Module 2 (সম্পূর্ণ), 3.1, 3.2, 3.3
Current: 3.4 — Health Check, Failover, Sticky Session, Graceful Shutdown
TaskFlow state: multi-instance Nginx reverse proxy + LB setup (Docker demo সহ),
এখন health check/failover concept যোগ হচ্ছে production-readiness এর দিকে
Terms learned (Module 3 so far): Load Balancer, L4/L7, SSL Termination,
Content-based Routing, Round Robin, Weighted Round Robin, Least Connections,
Session Affinity, IP Hash, Consistent Hashing (intro), Forward/Reverse Proxy,
Upstream, Passive/Active Health Check, Failover, Draining, Graceful Shutdown,
Liveness/Readiness
Weak spots: [আগের অবস্থা বজায়, নতুন কোনো significant গ্যাপ যোগ হয়নি এই lesson এ যেহেতু
এটা মূলত conceptual, নতুন exercise এখনও submit হয়নি]
Next: Module 3 Exit Challenge, তারপর Module 4 — Caching
=======================
```

---

## ৮. পরের ধাপ

Exercise টা করে পাঠাও। রেডি হলে `next` লিখো — **Module 3 Exit Challenge** এ যাব, যেখানে Load Balancer, L4/L7, algorithm, proxy, health check — এই পুরো module এর concept একসাথে একটা integrative challenge এ প্রয়োগ করব।
