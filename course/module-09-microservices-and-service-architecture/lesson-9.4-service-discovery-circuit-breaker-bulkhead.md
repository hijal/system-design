# Lesson 9.4 — Service Discovery, Circuit Breaker, Bulkhead

**Module 9 — Microservices & Service Architecture**

> **Spaced Repetition (Lesson 3.4):** Stock (open-source) Nginx এ default এ কোন ধরনের health check চলে — passive না active? আর তার দামটা কে দেয়: monitoring system, না আসল user? আজ ঠিক এই দামটা আবার ফিরবে — এবার load balancer এর ভেতরে না, আপনার নিজের service এর code এ।

**Prerequisite:** Lesson 1.5 (Availability, p99), Lesson 3.1 (L4 vs L7), Lesson 3.4 (Health check, liveness vs readiness, graceful shutdown), Lesson 4.6 (Thundering herd), Lesson 5.6 (Connection pool), Lesson 6.1 (Partial failure, timeout মানে "জানি না"), Lesson 7.1 (Cascading failure, event loop), Lesson 7.4 (Retry, backoff, backpressure), Lesson 9.1 (Timeout + fallback, ছড়ানো ব্যর্থতা), Lesson 9.2 (Synchronous call), Lesson 9.3 (Saga এর প্রথম ধাপ — billing কে ডাকা)

**আপনি এই lesson শেষে পারবেন:**

1. একটা service অন্য service এর **ঠিকানা** কোথা থেকে পায় বলতে পারবেন — হাতে লেখা তালিকা, registry + heartbeat/TTL, client-side বনাম server-side discovery — আর মাপা সংখ্যা দিয়ে দেখাতে পারবেন registry কোন সমস্যাটা সারায় আর কোন জানালাটা খোলা রাখে
2. একটা **circuit breaker** design করতে পারবেন — তিনটা অবস্থা, threshold, open এর মেয়াদ, half-open probe — আর বলতে পারবেন এটা প্রথমত কাকে বাঁচায়: নিজেকে, নাকি মরতে থাকা service টাকে
3. **Bulkhead** দিয়ে একটা ধীর নির্ভরতাকে পুরো service ডুবিয়ে দেওয়া থেকে আটকাতে পারবেন — আর এর দামটা (সুস্থ পথ বাঁচে, অসুস্থ পথ আরও ধীর হয়) সংখ্যা দিয়ে বলতে পারবেন

**Tier:** 1 — Runnable Code (আলাদা port এ আসল HTTP server — billing এর তিনটা instance; registry, breaker আর bulkhead নিজের হাতে লেখা; Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

Lesson 9.3 এর পর billing নিজের database সহ আলাদা service। "Task তৈরি" এখন একটা saga, আর তার **প্রথম ধাপ** work service থেকে billing এ একটা synchronous call — quota সংরক্ষণ। Billing এর তিনটা instance চলে, work এর config এ তাদের তিনটা ঠিকানা হাতে লেখা।

তিন সপ্তাহে তিনটা ঘটনা:

1. **হারিয়ে যাওয়া ঠিকানা।** Cloud provider একটা machine প্রতিস্থাপন করল (রুটিন রক্ষণাবেক্ষণ) — নতুন instance, নতুন IP। Config এ পুরনো ঠিকানাটা রয়ে গেল। পরের দুই দিন প্রতি তিনটা "task তৈরি" এর একটা ব্যর্থ — ঠিক ৩৩%, নিজে থেকে সারে না। Deploy করে config ঠিক করার আগ পর্যন্ত।
2. **বেঁচে আছি, কিন্তু কাজ করছি না।** Billing এর একটা খারাপ deploy — instance উঠল, port খুলল, কিন্তু তার database এর credential ভুল, তাই প্রতিটা call এ 500। Work এর কাছে সে তখনো "জীবিত"। আবার ব্যর্থতা, আবার নিজে থেকে সারে না।
3. **সবচেয়ে খারাপটা।** Billing এর database এ একটা index হারিয়ে গিয়েছিল; query গুলো ২ সেকেন্ড নিতে শুরু করল। Work এ প্রতিটা "task তৈরি" এখন ৩০০ ms timeout পর্যন্ত অপেক্ষা করে, তারপর ব্যর্থ। কিন্তু support এ যে ticket এলো সেটা task নিয়ে না — **"board ই খুলছে না।"** Board খোলা billing কে ছোঁয়ও না। তবু পুরো app মৃত দেখাল।

তিন নম্বরটাই সবচেয়ে বেশি ভাবাল। একজন engineer: "Billing ধীর — সেটা বুঝলাম। কিন্তু board তো billing এর সাথে কথাই বলে না। ওটা কেন মরল?" CTO: "তিনটাই আলাদা সমস্যা, আর আমার ধারণা তিনটার আলাদা উত্তর আছে। মাপুন — আগের মতোই।"

---

## ১. Theory

### ১.১ তিনটা প্রশ্ন, তিনটা যন্ত্র

উপরের তিনটা ঘটনা দেখতে এক রকম ("billing এর জন্য task তৈরি ব্যর্থ"), কিন্তু প্রশ্ন তিনটা আলাদা:

```
  1. "billing কোথায়?"            →  Service Discovery
     ঠিকানা ভুল বা পুরনো। কেউ মরেনি — আমরা জানি না কে বেঁচে আছে।

  2. "billing অসুস্থ, থামব কখন?"  →  Circuit Breaker
     ঠিকানা ঠিক, instance সাড়া দিচ্ছে — কিন্তু ভুল উত্তর বা দেরিতে।
     বারবার ডেকে আমরা নিজের সময় নষ্ট করছি, আর তাকেও উঠতে দিচ্ছি না।

  3. "billing ডুবছে, আমাকেও টানছে" →  Bulkhead
     আমার নিজের সম্পদ (worker, connection) একটা নির্ভরতার অপেক্ষায় আটকে।
     যে কাজগুলোর সাথে billing এর সম্পর্ক নেই, তারাও মরছে।
```

তিনটা আলাদা যন্ত্র, আর একটা অন্যটার বদলি না — এটাই মূল কথা। Discovery মরা instance সরায়, কিন্তু অসুস্থ instance ধরতে পারে না। Breaker অসুস্থ নির্ভরতা থেকে হাত সরায়, কিন্তু আপনার worker গুলো কে ভাগ করে না। Bulkhead ক্ষতির সীমানা আঁকে, কিন্তু কোনো ব্যর্থতা সারায় না।

### ১.২ Service Discovery — ঠিকানা কোথা থেকে আসে

**Service Discovery** — চলতে থাকা system এ একটা service এর instance গুলোর বর্তমান ঠিকানা (host + port) খুঁজে বের করার প্রক্রিয়া, যাতে instance যোগ হলে, সরে গেলে বা ঠিকানা বদলালে caller এর config হাতে বদলাতে না হয়।

Monolith এ এই সমস্যা ছিল না — billing একটা function ছিল (Lesson 9.1)। এখন billing কয়েকটা process, কয়েকটা machine এ, আর সেই সংখ্যাটা বদলায়: autoscaling, deploy, crash, রক্ষণাবেক্ষণ। হাতে লেখা তালিকা মানে **এক মুহূর্তের ছবি** কে চিরন্তন সত্য ধরে নেওয়া।

**Service Registry** — একটা কেন্দ্রীয় store যেখানে প্রতিটা instance চালু হয়ে নিজেকে নিবন্ধন করে আর নিয়মিত **heartbeat** পাঠায়; একটা নির্দিষ্ট সময় (TTL) heartbeat না এলে registry ধরে নেয় সে আর নেই আর তালিকা থেকে সরিয়ে দেয়।

```
   billing-1 ──register, তারপর প্রতি 100 ms heartbeat──►┐
   billing-2 ──────────────────────────────────────────►│  Registry
   billing-3 ──────────────────────────────────────────►┘  (TTL 300 ms)
                                                             │
   work service ──"billing এর জীবিত ঠিকানা গুলো দিন"────────►┘
                ◄──[billing-1, billing-3]── (billing-2 এর শেষ heartbeat 300 ms এর বেশি পুরনো)
```

Exercise এর `npm run discovery` — তিনটা instance, প্রতি phase এ ৩০০টা "task তৈরি", ৮ জন একসাথে; মাঝপথে একটা instance এর process মেরে ফেলা হয় (connection refused):

```
   strategy                             before     on death    after TTL
   static list                         0 ( 0%)    100 (33%)    100 (33%)
   registry + heartbeat/TTL            0 ( 0%)    100 (33%)      0 ( 0%)

   time for the dead instance to leave the registry: 230.2 ms (heartbeat 100 ms + TTL 300 ms)
```

দুটো জিনিস পড়ার আছে, আর দ্বিতীয়টাই বেশি জরুরি:

- **Static list নিজে থেকে সারে না।** ৩৩% ব্যর্থতা ঘটনার পরেও ৩৩% — ঘণ্টার পর ঘণ্টা, যতক্ষণ না মানুষ config বদলে deploy করে। TaskFlow এর ঘটনা ১ ঠিক এটাই, দুই দিন ধরে।
- **Registry সারে, কিন্তু সাথে সাথে না।** "মরার পরপর" কলামে registry ও ৩৩% — কারণ ওই মুহূর্তে registry এখনো জানে না। সে জানবে শেষ heartbeat এর TTL পরে। মাপা সময়: ~২৩০ ms (শেষ heartbeat আর মৃত্যুর মধ্যে যতটা ফাঁক ছিল, তত কম)। **এই জানালাটাই discovery এর আসল সংখ্যা** — এর ভেতরে call গুলো মরা ঠিকানায় যাবেই।

জানালাটা ছোট করতে TTL কমান — কিন্তু বিনামূল্যে না। TTL ১০০ ms মানে heartbeat আরও ঘন, registry তে আরও লেখা; আর একটা সুস্থ instance এর সাময়িক GC pause (Lesson 7.1) বা network hiccup তাকে ভুল করে "মৃত" বানিয়ে দেবে — সে তালিকা থেকে সরবে, বাকিদের উপর চাপ বাড়বে, তারাও ধীর হবে। Lesson 6.1 এর সেই পুরনো সত্যটা এখানেও: **"সাড়া দিচ্ছে না" আর "মরে গেছে" এক জিনিস না**, আর timeout দিয়ে দুটো আলাদা করা যায় না।

### ১.৩ Client-side বনাম Server-side Discovery

তালিকাটা কে ধরে রাখে আর কে বাছে — এই প্রশ্নে দুটো ধরন:

**Client-side Discovery** — caller নিজে registry থেকে জীবিত instance এর তালিকা নেয় এবং নিজেই একটা বাছে (round robin, least connections — Lesson 3.2); **Server-side Discovery** — caller একটাই স্থির ঠিকানায় (load balancer বা proxy) পাঠায়, আর সেই ঠিকানার পেছনে কে আছে সেটা load balancer registry থেকে জেনে ঠিক করে।

```
  client-side                              server-side
  ───────────                              ───────────
  work ──registry এ জিজ্ঞেস──► [1,3]       work ──► billing.internal (একটা স্থির নাম)
  work ──নিজে বেছে──► billing-3                        │
                                                       ▼
  caller এর code এ logic                        LB / proxy / mesh ──► billing-3
  ভাষা ভেদে আলাদা library                       caller কিছুই জানে না
  একটা hop কম                                  একটা hop বেশি (9.2 এর দাম)
```

বাস্তবে যা দেখবেন: **DNS** সবচেয়ে পুরনো server-side রূপ (একটা নাম → কয়েকটা IP) — কিন্তু DNS এর TTL cache হয় client এ, OS এ, library তে, তাই সরে যাওয়া instance অনেকক্ষণ cache এ থেকে যায়; দ্রুত বদলানো instance এর জন্য DNS একা যথেষ্ট না। **Kubernetes** এ Service একটা স্থির নাম আর ClusterIP দেয়, আর তার পেছনের Endpoints গুলো kubelet এর readiness probe (Lesson 3.4) অনুযায়ী যোগ-বিয়োগ হয় — কার্যত server-side discovery, registry টা Kubernetes নিজেই। **Consul, etcd, Eureka** আলাদা registry হিসেবে চলে, আর **service mesh** (9.2 এ দেখা) প্রতিটা pod এর পাশে একটা sidecar proxy বসিয়ে caller এর code থেকে পুরো ব্যাপারটা সরিয়ে নেয়।

TaskFlow এর জন্য এখানে একটা সহজ সত্য আছে: 9.2 এ ইতিমধ্যে একটা gateway বসেছে, আর service গুলো private network এ। একটা আলাদা registry চালানোর আগে প্রশ্ন করুন — আপনার platform (Kubernetes, ECS, Nomad) কি এটা ইতিমধ্যে দিচ্ছে? প্রায় সবসময় উত্তর হ্যাঁ, আর তখন নিজের registry লেখা একটা অপ্রয়োজনীয় চলমান অংশ।

### ১.৪ Heartbeat এর সীমা — "বেঁচে আছি" বনাম "কাজ করছি"

এখন TaskFlow এর দ্বিতীয় ঘটনা: instance উঠেছে, heartbeat পাঠাচ্ছে, কিন্তু প্রতিটা আসল call এ 500। Exercise এর অংশ খ — দুটো instance বাকি, তার একটা অসুস্থ:

```
   strategy                            healthy  sick (500)
   registry + heartbeat/TTL            0 ( 0%)    150 (50%)
```

ব্যর্থতা ৫০%, আর registry নির্বিকার — কারণ heartbeat ঠিকই আসছে। Heartbeat উত্তর দেয় "আমার process বেঁচে আছে" (**liveness**), কিন্তু প্রশ্নটা ছিল "আমি কাজ করতে পারব" (**readiness**) — Lesson 3.4 এর সেই পার্থক্যটাই, এবার registry এর প্রেক্ষাপটে। এর তিনটা উত্তর, আর তিনটাই বাস্তবে একসাথে ব্যবহার হয়:

1. **Readiness probe** — heartbeat/health endpoint টা শুধু "আমি চলছি" না বলে সত্যিকারের নির্ভরতা যাচাই করুক (database এ একটা `SELECT 1`)। ধরে ফেলবে সেই ব্যর্থতা যেগুলো instance নিজে জানে।
2. **Active health check** — registry বা load balancer নিজে probe পাঠাক (3.4), user এর request এর অপেক্ষা না করে।
3. **Passive detection** — caller আসল call গুলোর ফলাফল দেখে নিজেই সিদ্ধান্ত নিক। 3.4 এ এটা Nginx এর `max_fails` ছিল। Caller এর নিজের code এ এর নাম **circuit breaker** — আর সেটাই পরের অংশ।

তিন নম্বরটা কেন বাদ দেওয়া যায় না: probe যতই ভালো হোক, সে আপনার আসল query টা চালায় না। একটা instance ঠিক **আপনার** call এ ব্যর্থ হতে পারে (একটা নির্দিষ্ট shard মৃত, একটা নির্দিষ্ট code path এ bug)। যে ব্যর্থতা শুধু আসল traffic এ দেখা যায়, সেটা শুধু caller ই দেখতে পায়।

### ১.৫ Circuit Breaker — timeout এর দেয়াল

TaskFlow এর তৃতীয় ঘটনা: billing ধীর, ২ সেকেন্ড। Work এর timeout ৩০০ ms। কী হয়?

প্রতিটা call ৩০০ ms অপেক্ষা করে, তারপর ব্যর্থ হয়। Timeout আছে বলে আমরা নিজেদের বাঁচিয়েছি বলে ভাবছি — কিন্তু ৩০০ ms **প্রতিবার** দিচ্ছি, হাজার বার। Exercise এর `npm run circuit`, ৪০০টা call, ৮ জন একসাথে:

```
   path                                ok      failed   fast-fail     reached       ops/s         p50         p99
   no breaker                           0         400           0         400          27    301.0 ms    307.9 ms
   breaker                              0         400         388          12         663      0.0 ms    302.0 ms
```

**Circuit Breaker** — caller এর দিকে বসানো একটা ছোট state machine যা সাম্প্রতিক ব্যর্থতা গোনে; ব্যর্থতা একটা সীমা ছাড়ালে সে "open" হয়ে যায় আর পরের call গুলো **সত্যিই না পাঠিয়েই** সাথে সাথে ব্যর্থ করে দেয়, কিছুক্ষণ পর আবার একটা চেষ্টা করে দেখে নির্ভরতা সেরেছে কিনা।

```
                 পরপর N টা ব্যর্থতা
      ┌────────┐ ──────────────────► ┌──────┐
      │ closed │                     │ open │  call যায়ই না — সাথে সাথে ব্যর্থ
      │        │ ◄────────────────── │      │  (fail fast)
      └────────┘   probe সফল         └──────┘
           ▲                             │ মেয়াদ (এখানে 500 ms) শেষ
           │                             ▼
           │                      ┌───────────┐
           └──────────────────────│ half-open │  ঠিক একটা call যেতে দেয়
                probe সফল         └───────────┘
                                        │ probe ব্যর্থ → আবার open
                                        ▼
```

**Fail Fast** — যে call সফল হওয়ার সম্ভাবনা কম, তাকে অপেক্ষা না করিয়ে সাথে সাথে ব্যর্থ করা, যাতে caller এর সময় আর সম্পদ timeout এ আটকে না থাকে।

সংখ্যাগুলো পড়ুন, আর লক্ষ করুন কোনটা **বদলায়নি**:

- **ব্যর্থতা কমেনি।** দুটোতেই ৪০০টা call ব্যর্থ — breaker billing কে সারায় না। যা বদলেছে তা হলো **কত দ্রুত** ব্যর্থ হলো: p50 ৩০১ ms থেকে **0.0 ms**, ops/s ২৭ থেকে ৬৬৩ (২৪ গুণ)। User আগে ৩০০ ms অপেক্ষা করে error পেত, এখন সাথে সাথে পায়। "দ্রুত error" শুনতে খারাপ, কিন্তু ৩০০ ms ধরে একটা worker আর একটা connection আটকে রাখার চেয়ে ভালো — পরের অংশে দেখব কেন।
- **সবচেয়ে বড় সংখ্যাটা `reached`: ৪০০ → ১২।** মরতে থাকা billing এর উপর চাপ **৯৭% কম**। এটাই breaker এর কম-আলোচিত কিন্তু আসল কাজ: একটা ধুঁকতে থাকা service কে বারবার ডাকলে সে কখনো উঠে দাঁড়াতে পারে না (Lesson 4.6 এর thundering herd, এবার service এর দরজায়)। Breaker তাকে নিঃশ্বাস নেওয়ার জায়গা দেয়।

### ১.৬ Half-Open — সেরে ওঠা কীভাবে টের পাওয়া যায়

Breaker open হয়ে বসে থাকলে সে কখনো জানবে না billing সেরেছে কিনা — কারণ সে তো ডাকছেই না। তাই তৃতীয় অবস্থা।

**Half-Open Probe** — open এর মেয়াদ শেষ হলে breaker ঠিক **একটা** call যেতে দেয়; সেটা সফল হলে সে বন্ধ (closed) হয়ে স্বাভাবিক কাজে ফেরে, ব্যর্থ হলে আবার open হয়ে নতুন মেয়াদ গোনে।

"ঠিক একটা" অংশটা গুরুত্বপূর্ণ। যদি মেয়াদ শেষে সব আটকে থাকা call একসাথে ছেড়ে দেওয়া হতো, সবে উঠে দাঁড়ানো billing সাথে সাথে আবার পড়ে যেত — আবার সেই thundering herd। Exercise এ billing সুস্থ করার পর:

```
   time for the breaker to close again after billing recovered: 208.1 ms
   (the rest of the open period + one probe; in the worst case the full 500 ms)
   half-open probes sent during this time: 1
```

মানে breaker থাকার একটা দামও আছে: **billing সেরে যাওয়ার পরেও কিছুক্ষণ traffic ফেরে না** — সবচেয়ে খারাপ ক্ষেত্রে open এর পুরো মেয়াদ। মেয়াদ বড় করলে মরতে থাকা service বেশি বিশ্রাম পায় কিন্তু recovery দেরি হয়; ছোট করলে উল্টো। এখানে ৫০০ ms, production এ প্রায়ই কয়েক সেকেন্ড।

আর একটা সূক্ষ্মতা, যেটা exercise লিখতে গিয়ে ধরা পড়েছিল: breaker open হওয়ার **পরে** ফেরত আসা পুরনো call গুলোর ব্যর্থতা আবার গুনলে breaker অকারণে বারবার "নতুন করে" খুলতে থাকে। Open অবস্থায় ব্যর্থতা গোনা বন্ধ রাখতে হয় — নইলে `opened` এর সংখ্যা মিথ্যা বলে, আর মেয়াদের হিসাব ঘেঁটে যায়।

Breaker এর ভুল করার দুটো দিক আছে, দুটোই বাস্তব: threshold খুব ছোট (যেমন ২) হলে একটা সাময়িক hiccup এ breaker খুলে যাবে আর সুস্থ service কে অকারণে সরিয়ে দেবে; খুব বড় (যেমন ৫০) হলে খোলার আগেই অনেক user অপেক্ষা করে ফেলবে। Production এর breaker তাই সাধারণত পরপর গোনা না, একটা সময়-জানালায় ব্যর্থতার **হার** দেখে — আর slow call কেও ব্যর্থতা হিসেবে ধরে, কারণ ২ সেকেন্ডে আসা "সফল" উত্তরও আপনার p99 মেরে ফেলে।

### ১.৭ Bulkhead — board কেন মরল

এখন সবচেয়ে জরুরি প্রশ্নটা: board খোলা billing কে ছোঁয় না, তবু board কেন মরল?

কারণ **worker**। Work service এর একটা নির্দিষ্ট সংখ্যক concurrent request সামলানোর ক্ষমতা আছে — Node এ সেটা event loop আর connection pool (Lesson 5.6), Express এর সামনে যত socket, যত in-flight promise। ধরুন ১৬টা slot। Billing ২ সেকেন্ড ধীর, timeout ৩০০ ms। প্রতিটা "task তৈরি" একটা slot নিয়ে ৩০০ ms বসে থাকে। যথেষ্ট traffic এলে ১৬টা slot ই "task তৈরি" এর দখলে — আর "board খোলা" line এ দাঁড়িয়ে থাকে।

```
  shared pool (16 slot)                    bulkhead
  ─────────────────────                    ────────
  [c][c][c][c][c][c][c][c]                 create: [c][c][c][c][c][c][c][c][c][c][c][c]  (12)
  [c][c][c][c][c][c][c][c]   ← সব দখল       board:  [b][b][b][b]                          (4)
   board ──► line এ অপেক্ষা                  board ──► নিজের slot, খালি
```

**Bulkhead** — জাহাজের জলনিরোধী প্রকোষ্ঠের মতো, নিজের সম্পদ (worker, connection, thread) আলাদা ভাগে ভেঙে প্রতিটা নির্ভরতা বা কাজের ধরনকে নির্দিষ্ট ভাগ দেওয়া, যাতে একটা ভাগ পুরো ভরে গেলেও বাকিগুলো চলতে থাকে।

Exercise এর `npm run isolation` — ৬০০টা request, ৪০ জন client, ১৬টা slot, ৭০% "task তৈরি" আর ৩০% "board খোলা", billing ২ সেকেন্ড ধীর:

```
── a. "open board" — the work that has nothing to do with billing ──
   pool                              ok      failed        shed         p50         p99
   shared (16)                      171           0           0    305.0 ms    595.9 ms
   bulkhead (4 board)               171           0           0      2.1 ms      7.4 ms

── b. "create task" — the work that really depends on the slow billing ──
   pool                              ok      failed        shed         p50         p99
   shared (16)                        0         429           0    603.3 ms    901.1 ms
   bulkhead (12 create)               0         429           0    906.3 ms      1.21 s
```

- **Board এর p99: ৫৯৬ ms → ৭.৪ ms** (p50 ৩০৫ → ২.১)। একই ধীর billing, একই চাপ, একই মোট slot — শুধু ভাগ করা। Board এর নিজের কাজ ২ ms; shared pool এ সে ৩০০ গুণ বেশি সময় নিচ্ছিল, পুরোটাই অন্যের অপেক্ষায় দাঁড়িয়ে।
- **আর দামটা সৎভাবে:** create এর p99 ৯০১ ms থেকে বেড়ে **১.২১ s** — কারণ তার slot ১৬ থেকে ১২ হয়েছে। Bulkhead অসুস্থ পথটাকে **ভালো করে না, বরং একটু খারাপ করে**। সে শুধু নিশ্চিত করে অসুস্থ পথ সুস্থ পথটাকে টেনে নামাতে না পারে।

এটাই সিদ্ধান্তের আসল রূপ: আপনি ঠিক করছেন **কোন কাজটা ডুবতে দেবেন**। "সব কাজ সমান" বলার সুযোগ নেই — সম্পদ সীমিত, আর ভাগ না করা মানে নিজের অজান্তেই ঠিক করে ফেলা যে সবাই একসাথে ডুববে।

Bulkhead এর রূপ কয়েকটা, একই ধারণা: আলাদা connection pool (billing এর জন্য ১০টা, বাকিদের জন্য আলাদা — 5.6), আলাদা thread/worker pool, আলাদা queue (7.4 এর backpressure), আর সবচেয়ে মোটা দাগে — আলাদা deployment, যেখানে "task তৈরি" আর "board পড়া" আলাদা process এ চলে।

### ১.৮ TaskFlow এর সিদ্ধান্ত

তিনটা যন্ত্র, তিনটা আলাদা সিদ্ধান্ত:

**Discovery:** নিজের registry লেখা হচ্ছে না। TaskFlow ইতিমধ্যে Kubernetes এ — billing এর জন্য একটা Service (`billing.internal`), পেছনে readiness probe যা billing এর database এ `SELECT 1` চালায়। Server-side discovery, কারণ work এর code এ কোনো registry client রাখতে হয় না, আর 9.2 এর gateway এর মতোই একটা hop এর দাম এখানে গ্রহণযোগ্য।

**Breaker:** work → billing প্রতিটা call এ, একটা প্রতিষ্ঠিত library দিয়ে (নিজের হাতে লেখা breaker exercise এর জন্য — production এ না)। Threshold পরপর গোনা না, ১০ সেকেন্ডের জানালায় ৫০% ব্যর্থতা; slow call (>২৫০ ms) কেও ব্যর্থতা গোনা; open এর মেয়াদ ৫ s; half-open এ একটা probe। **Breaker per dependency, per endpoint** — billing এর `reserve` এর breaker আর `invoice` এর breaker আলাদা, যাতে একটা endpoint এর সমস্যা পুরো billing কে না সরায়।

**Breaker খুললে কী হবে** — এটাই আসল ব্যবসার সিদ্ধান্ত, আর এখানে দুই রকম:

- **Task তৈরি:** fallback — task তৈরি হয়ে যাবে, quota এর সংরক্ষণ বাদ, আর একটা `quota_pending` চিহ্ন বসবে যা রাতের reconcile job (9.3) মিলিয়ে নেবে। যুক্তি: quota এর সীমা কয়েক মিনিটের জন্য নরম হলে ক্ষতি সামান্য, কিন্তু "task বানানো যাচ্ছে না" মানে পুরো product অকেজো। Exercise এর অংশ গ এই পথটা মেপেছে — ৩৮৮টা call user এর কাছে সফল, ১২টা ব্যর্থ।
- **Plan upgrade (টাকার লেনদেন):** fallback নেই — সাথে সাথে স্পষ্ট error, "একটু পরে আবার চেষ্টা করুন"। টাকার কাজে অনুমান করা যায় না (9.3 এর pivot এর যুক্তি)।

**Bulkhead:** work এর ভেতরে দুটো ভাগ — billing কে ডাকে এমন কাজ একটা সীমিত pool এ (concurrency ১২), আর বাকি সব (board পড়া, task তালিকা, comment) আলাদা pool এ (৪ + বাকিটা)। সাথে billing এর জন্য আলাদা HTTP connection pool। লক্ষ্য একটাই, আর সেটা লেখা থাকবে runbook এ: **billing পুরো মরে গেলেও board খুলবে।**

আর যেটা এখন করা হচ্ছে **না**: retry। Billing ধীর হলে retry পরিস্থিতি খারাপ করে — একই কাজ দুবার, চাপ দ্বিগুণ (7.4 এর retry storm)। Breaker আর retry একসাথে ব্যবহার করলে নিয়ম হলো retry **breaker এর ভেতরে** থাকবে, আর retry এর ব্যর্থতাও breaker গুনবে।

---

## ২. Interview Angle

**যেকোনো microservices এর design এ** একটা মুহূর্ত আসে: "service A service B কে ডাকে — B ধীর হলে কী হয়?" দুর্বল উত্তর: "timeout দেব"। Timeout জরুরি কিন্তু একা যথেষ্ট না, আর এই সংখ্যাটা দিয়ে সেটা দেখানো যায়: timeout ৩০০ ms, billing ২ s ধীর — প্রতিটা call ৩০০ ms নষ্ট করে, ২৭ ops/s। ভালো উত্তর তিন স্তরে: timeout (সীমা), circuit breaker (বারবার ওই দেয়ালে মাথা না ঠোকা — ২৭ থেকে ৬৬৩ ops/s, আর মরতে থাকা service এর উপর ৯৭% কম চাপ), bulkhead (ক্ষতির সীমানা — board এর p99 ৫৯৬ থেকে ৭ ms)। তারপর fallback এর সিদ্ধান্ত: কোন কাজে degraded উত্তর চলে, কোনটায় না।

**"Service discovery কীভাবে করবেন?"** — প্রথমে প্রশ্ন ফিরিয়ে দিন: platform কী? Kubernetes এ Service + readiness probe ইতিমধ্যে আছে, আলাদা registry অপ্রয়োজনীয়। তারপর client-side বনাম server-side এর trade-off, DNS এর TTL cache এর সমস্যা, আর সবচেয়ে ভালো যেটা দেখাবে: **detection window** — registry TTL এর মধ্যে call গুলো মরা instance এ যাবেই, তাই discovery একা যথেষ্ট না, caller এর দিকেও passive detection লাগে।

**"Circuit breaker কাকে বাঁচায়?"** — বেশিরভাগ প্রার্থী বলে "caller কে"। সম্পূর্ণ উত্তর দুই দিকের: caller নিজের worker আর সময় বাঁচায়, **আর callee বিশ্রাম পায়** — বারবার ডাকলে ধুঁকতে থাকা service কখনো উঠতে পারে না। Half-open কেন ঠিক একটা probe, সেটাও এখান থেকেই বেরোয়।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনাগুলো — breaker সব dependency এর জন্য একটাই (একটা endpoint এর সমস্যায় পুরো service কেটে যায়); threshold এত বড় যে breaker কার্যত কখনো খোলে না; breaker আছে কিন্তু fallback এর সিদ্ধান্ত কেউ নেয়নি, তাই open হলে user একই error পায় শুধু দ্রুত; health endpoint শুধু `return 200` করে, তাই readiness এর কোনো মানে নেই; graceful shutdown নেই (3.4), তাই deploy এর সময় প্রতিবার registry এর TTL জানালায় ব্যর্থতা; আর সবচেয়ে দামি — connection pool ভাগ করা নেই, তাই একটা ধীর নির্ভরতা পুরো service এর সব connection খেয়ে ফেলে।

---

## ৩. Key Takeaway

- তিনটা আলাদা সমস্যা, তিনটা আলাদা যন্ত্র: **কোথায়** (discovery), **কখন থামব** (breaker), **কতটুকু ডুববে** (bulkhead) — একটা অন্যটার বদলি না
- **Static list নিজে থেকে সারে না** — মাপা: instance মরার পরে ৩৩% ব্যর্থতা চিরকাল; registry তে ~২৩০ ms পরে ০%
- **Registry এর TTL একটা খোলা জানালা** — ওই সময়টুকু call মরা ঠিকানায় যাবেই; TTL ছোট করার দাম হলো সুস্থ instance কে ভুল করে মৃত ঘোষণা করা
- **Heartbeat = liveness, readiness না** — heartbeat পাঠাতে থাকা অসুস্থ instance এ ৫০% ব্যর্থতা, registry নির্বিকার; তাই caller এর দিকে passive detection লাগে
- **Breaker ব্যর্থতা কমায় না, ব্যর্থতার দাম কমায়** — ৪০০টা call দুটোতেই ব্যর্থ, কিন্তু p50 ৩০১ ms → ০ ms, ops/s ২৭ → ৬৬৩
- **Breaker এর আসল উপকার callee র দিকে** — মরতে থাকা service এ পৌঁছানো call ৪০০ → ১২ (৯৭% কম), তাই সে উঠে দাঁড়াতে পারে
- **Half-open এর দাম** — নির্ভরতা সেরে গেলেও traffic ফিরতে open এর বাকি মেয়াদ লাগে (মাপা ২০৮ ms, সর্বোচ্চ ৫০০)
- **Bulkhead অসুস্থ পথ সারায় না** — board এর p99 ৫৯৬ → ৭ ms, কিন্তু create এর p99 ৯০১ ms → ১.২১ s; আপনি ঠিক করছেন কোনটা ডুববে
- Breaker open হলে কী হবে (error না fallback) — এটা **ব্যবসার সিদ্ধান্ত**, যন্ত্রের না; task তৈরিতে fallback চলে, টাকার লেনদেনে না

---

## ৪. নতুন Term (Glossary)

| Term                                    | অর্থ                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Service Discovery**                   | চলতে থাকা system এ একটা service এর instance গুলোর বর্তমান ঠিকানা খুঁজে বের করার প্রক্রিয়া, যাতে instance যোগ-বিয়োগ বা ঠিকানা বদলালে caller এর config হাতে বদলাতে না হয়               |
| **Service Registry**                    | কেন্দ্রীয় store যেখানে instance চালু হয়ে নিজেকে নিবন্ধন করে আর নিয়মিত heartbeat পাঠায়; TTL এর মধ্যে heartbeat না এলে registry তাকে তালিকা থেকে সরিয়ে দেয়                          |
| **Client-side / Server-side Discovery** | Client-side — caller নিজে registry থেকে তালিকা নিয়ে instance বাছে; Server-side — caller একটা স্থির নামে পাঠায়, আর পেছনে কে আছে সেটা load balancer বা proxy registry থেকে জেনে ঠিক করে |
| **Circuit Breaker**                     | Caller এর দিকে বসানো state machine যা সাম্প্রতিক ব্যর্থতা গোনে; সীমা ছাড়ালে open হয়ে পরের call গুলো না পাঠিয়েই ব্যর্থ করে, কিছুক্ষণ পর আবার চেষ্টা করে দেখে                          |
| **Half-Open Probe**                     | Open এর মেয়াদ শেষে breaker ঠিক একটা call যেতে দেয় — সফল হলে closed এ ফেরে, ব্যর্থ হলে আবার open; "ঠিক একটা" যাতে সবে ওঠা service আবার না পড়ে                                         |
| **Bulkhead**                            | নিজের সম্পদ (worker, connection, thread) আলাদা ভাগে ভেঙে প্রতিটা নির্ভরতা বা কাজের ধরনকে নির্দিষ্ট ভাগ দেওয়া, যাতে একটা ভাগ ভরে গেলেও বাকিগুলো চলতে থাকে                               |
| **Fail Fast**                           | যে call সফল হওয়ার সম্ভাবনা কম তাকে অপেক্ষা না করিয়ে সাথে সাথে ব্যর্থ করা, যাতে caller এর সময় আর সম্পদ timeout এ আটকে না থাকে                                                         |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর billing এর একটা instance deploy হচ্ছে। Registry এর TTL ৩০০ ms, heartbeat ১০০ ms। (ক) Instance টা `SIGTERM` পেয়ে সাথে সাথে বন্ধ হয়ে গেলে কতক্ষণ ধরে কত শতাংশ call ব্যর্থ হবে — exercise এর সংখ্যা দিয়ে বলুন। (খ) Lesson 3.4 এর graceful shutdown এর সাথে এটা কীভাবে জোড়া লাগে — deploy এর সময় ব্যর্থতা **শূন্যে** নামাতে instance টার ঠিক কী কী করা উচিত, কোন ক্রমে? (গ) এই পুরো ব্যাপারটা Kubernetes এ কে করে দেয়, আর তবু কেন কিছু ব্যর্থতা থেকে যায়?

2. একজন engineer বলল: "Breaker আর bulkhead দুটোই তো ক্ষতি সীমিত করে — একটা থাকলেই তো চলে, দুটো কেন?" (ক) শুধু breaker রেখে bulkhead বাদ দিলে exercise এর কোন সংখ্যাটা খারাপ থাকত, আর কেন? (খ) শুধু bulkhead রেখে breaker বাদ দিলে? (গ) এমন একটা ব্যর্থতা কল্পনা করুন যেখানে **দুটোর কোনোটাই** সাহায্য করে না — কী সেটা, আর তখন কী লাগবে?

3. Billing এর `reserve` endpoint ঠিক আছে, কিন্তু `invoice` endpoint (মাসের হিসাব — ভারী query) ধীর হয়ে গেল। (ক) Service এর জন্য একটাই breaker থাকলে কী ঘটবে, আর user এর চোখে সেটা কেমন দেখাবে? (খ) Breaker per endpoint করলে কী বদলায়, আর এর দাম কী? (গ) Billing এর ভেতরে এই দুই endpoint কে আলাদা রাখতে **billing নিজে** কী করতে পারে — আর সেটা কোন যন্ত্রের আরেকটা রূপ?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) Instance টা মরার সাথে সাথে registry এখনো জানে না — সে জানবে শেষ heartbeat এর ৩০০ ms পরে। Heartbeat ১০০ ms অন্তর, তাই মৃত্যু আর শেষ heartbeat এর ফাঁক গড়ে ৫০ ms; জানালাটা তাই মোটামুটি ২৫০ ms (exercise এ মাপা ~২৩০ ms)। তিনটা instance এর একটা মরেছে, client round robin করছে — ওই জানালায় প্রায় **৩৩% call ব্যর্থ** (exercise এর "মরার পরপর" কলাম: ১০০/৩০০)। জানালা শেষে ০%।

(খ) 3.4 এর graceful shutdown এর ক্রমটা এখানে উল্টো দিক থেকে ভাবতে হয় — **আগে তালিকা থেকে সরে যাওয়া, তারপর বন্ধ হওয়া**:

1. `SIGTERM` পেয়ে **প্রথমে** registry তে deregister করুন (বা readiness probe কে fail করান) — এখন থেকে নতুন call আসবে না। এই ধাপটাই TTL এর জানালা মুছে দেয়: registry কে অপেক্ষা করে আবিষ্কার করতে হচ্ছে না, instance নিজেই বলে দিচ্ছে।
2. একটু **অপেক্ষা করুন** (drain) — যারা ইতিমধ্যে আপনার ঠিকানা হাতে নিয়ে ফেলেছে (client-side discovery তে caller এর cache এ, বা LB এর in-flight routing এ) তাদের request আসতে দিন। সময়টা caller এর refresh interval এর চেয়ে বড় হতে হবে।
3. নতুন connection নেওয়া বন্ধ করুন, **চলমান request গুলো শেষ করুন**, তারপর process বন্ধ।

এই তিনটা করলে deploy এর ব্যর্থতা কার্যত শূন্য — কারণ কোনো call কখনো মরা ঠিকানায় যায়নি।

(গ) Kubernetes এ Service এর Endpoints থেকে pod সরানো, readiness probe, `preStop` hook আর `terminationGracePeriodSeconds` — এগুলো ধাপ ১-৩ কে দাঁড় করিয়ে দেয়। তবু ব্যর্থতা থাকে, কারণ **Endpoints এর পরিবর্তন সাথে সাথে সব জায়গায় পৌঁছায় না**: kube-proxy/iptables বা mesh এর sidecar গুলোতে ছড়াতে সময় লাগে, আর caller এর নিজের connection pool এ পুরনো socket খোলা থাকতে পারে। সেজন্যই ধাপ ২ এর অপেক্ষাটা বাদ দেওয়া যায় না — আর caller এর দিকেও একটা retry (idempotent হলে, 7.4) বা breaker লাগে। কোনো একটা স্তর একা "শূন্য ব্যর্থতা" দিতে পারে না।

**প্রশ্ন ২:**

(ক) শুধু breaker, bulkhead নেই: breaker খোলার **আগে** পর্যন্ত (threshold এ পৌঁছানোর সময়টুকু) প্রতিটা "task তৈরি" একটা worker slot ৩০০ ms ধরে আটকে রাখে — আর ঠিক তখনই board এর p99 বাড়ে। Breaker খুলে গেলে অবস্থা অনেক ভালো (call যায়ই না, slot দ্রুত ছাড়ে)। কিন্তু দুটো ফাঁক থেকে যায়: breaker খোলার আগের সময়টুকু, আর half-open probe এর সময় (মেয়াদ শেষে আবার কিছু call যাবে)। মোটা দাগে: breaker ক্ষতির **সময়** কমায়, কিন্তু ক্ষতির **সীমানা** আঁকে না — একটা নির্ভরতার সমস্যা তখনো আপনার ভাগ করা pool এর মধ্য দিয়ে ছড়াতে পারে।

(খ) শুধু bulkhead, breaker নেই: board বাঁচে (p99 ৭ ms — exercise এর ঠিক এই পরিস্থিতিই মাপা, ওখানে breaker নেই)। কিন্তু create এর pool এর ১২টা slot অনন্তকাল timeout এ বসে থাকে, প্রতিটা call ৩০০ ms নষ্ট করে (২৭ ops/s এর সেই অবস্থা), আর মরতে থাকা billing এ পুরো ৪০০টা call পৌঁছাতে থাকে — সে উঠে দাঁড়ানোর সুযোগ পায় না। মোটা দাগে: bulkhead সীমানা আঁকে, কিন্তু সীমানার ভেতরের অপচয় থামায় না, আর callee কে বাঁচায় না।

তাই দুটোই লাগে, এবং তারা আলাদা জিনিস করে — breaker সময়ের দিকে, bulkhead জায়গার দিকে।

(গ) যেখানে দুটোর কোনোটাই কাজ করে না: **ব্যর্থতা যখন ধীরতা না, ভুল উত্তর** — billing 200 OK দিচ্ছে, দ্রুত দিচ্ছে, কিন্তু উত্তরটা ভুল (ভুল quota, পুরনো data)। Breaker কিছু গুনবে না (সব সফল), bulkhead এর কিছু করার নেই (কেউ অপেক্ষা করছে না)। এর জন্য লাগে অন্য জিনিস: response এর validation (Zod দিয়ে schema যাচাই — অন্তত আকারটা), ব্যবসার invariant এর উপর alert (9.3 এর reconcile job — বিলে আর আসল task এ অমিল), আর observability (Lesson 10.4) — কারণ এই ব্যর্থতা নীরব। এটাই সবচেয়ে বিপজ্জনক শ্রেণী: যে ব্যর্থতা কোনো error বানায় না।

**প্রশ্ন ৩:**

(ক) একটাই breaker হলে `invoice` এর ব্যর্থতাগুলো গুনে breaker open হবে, আর তখন **`reserve` ও কাটা পড়বে** — যদিও সে দিব্যি কাজ করছিল। User এর চোখে: মাসের হিসাবের page ধীর, আর তার ফলে **task তৈরি করা বন্ধ** — সম্পর্কহীন দুটো জিনিস, অথচ একটা আরেকটাকে মেরে ফেলল। এটা ঠিক সেই cascading failure যা আমরা আটকাতে চেয়েছিলাম, শুধু এবার আমাদের নিজের যন্ত্রের মধ্য দিয়ে।

(খ) Breaker per endpoint (আরও ভালো: per dependency + per endpoint) করলে `invoice` এর breaker খুলবে, `reserve` এর না — ক্ষতি ওই endpoint এই আটকে থাকবে। দাম: আরও অনেকগুলো breaker, প্রতিটার নিজের state আর tuning; কম ব্যবহৃত endpoint এ ব্যর্থতার নমুনা কম বলে threshold এ পৌঁছাতে দেরি হতে পারে (তাই হার-ভিত্তিক breaker এ ন্যূনতম call সংখ্যার শর্ত থাকে); আর dashboard এ দেখার মতো জিনিস বেড়ে যায়। তবু প্রায় সব ক্ষেত্রে এটাই ঠিক পছন্দ — মূল নীতি: **breaker এর সীমানা ব্যর্থতার সীমানার সাথে মেলানো**।

(গ) Billing নিজে করতে পারে — ভারী `invoice` query গুলোকে আলাদা connection pool এ (5.6), আলাদা worker এ, বা একেবারে আলাদা process/deployment এ পাঠানো; এমনকি আলাদা read replica তে (5.7)। তাহলে `invoice` এর ভারী query গুলো `reserve` এর connection খেয়ে ফেলবে না। এটা **bulkhead এরই আরেকটা রূপ** — এবার caller এর দিকে না, callee এর ভেতরে। সাধারণ নিয়মটা এখান থেকেই বেরোয়: bulkhead শুধু একটা জায়গার জিনিস না, এটা একটা ধারণা যা stack এর প্রতিটা স্তরে প্রয়োগ করা যায় — thread, connection, queue, process, machine।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (আলাদা port এ আসল HTTP server; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-9.4-discovery-breaker-bulkhead/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.4-discovery-breaker-bulkhead) — `npm install`, তারপর `npm run discovery`, `npm run circuit`, `npm run isolation`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`discovery` তিনটা billing instance চালায়, একটাকে মেরে ফেলে, আর static list বনাম registry + heartbeat/TTL এর ব্যর্থতা গোনে — সাথে TTL এর জানালাটা মাপে; তারপর একটা instance কে "অসুস্থ" (heartbeat পাঠাচ্ছে, অথচ 500) বানিয়ে দেখায় registry কেন নির্বিকার। `circuit` billing কে ২ সেকেন্ড ধীর করে দিয়ে breaker ছাড়া আর breaker সহ ops/s, p50 আর মরতে থাকা service এ পৌঁছানো call গোনে, তারপর billing সুস্থ করে half-open দিয়ে recovery মাপে, আর শেষে fail-fast এর বদলে fallback চালায়। `isolation` ৭০% "task তৈরি" আর ৩০% "board খোলা" মিশিয়ে চালায় — একবার ভাগ করা pool এ, একবার আলাদা bulkhead এ — আর দুটো কাজের p50/p99 আলাদা করে দেখায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; তিনটা script **তিনবার করে** — গোনার সব কলাম (১০০, ১৫০, ৪০০, ৩৮৮, ১২, ১৭১, ৪২৯) হুবহু একই, সময়ের সংখ্যা ২% এর কম ওঠানামা (registry থেকে সরতে ২২৫.৫–২৩১.৭ ms; breaker এ ৬৬১–৬৬৩ ops/s; recovery ২০৮.১–২০৯.৭ ms; board এর p99 shared এ ৫৯৪.৭–৫৯৫.৯ ms, bulkhead এ ৭.১–৭.৭ ms)। আপনার machine এ সময় আলাদা হবে, গোনা হবে না। Billing instance গুলো আসল HTTP server (`node:http`, আলাদা port), কিন্তু সব এক machine এ এক process এ — network এর দেরি নেই, packet হারায় না, DNS নেই। "ধীর" মানে server ইচ্ছে করে অপেক্ষা করে, "মরা" মানে `server.close()` — আসল crash এর কাছাকাছি, হুবহু না; বিশেষ করে একটা **hung** machine এ connection refused আসে না, timeout আসে (সেটা `slow` mode দিয়ে দেখানো)। Registry টা in-process একটা `Map` — Consul/etcd/Kubernetes এর মতো replicated store না, আর **registry নিজে মরলে কী হয় সেটা এখানে মাপা হয়নি**। Breaker টা পরপর গোনার ভিত্তিতে; production এর breaker সাধারণত সময়-জানালায় ব্যর্থতার হার দেখে আর slow call কেও গোনে — ১.৬ এ সেটা বলা আছে, কিন্তু চালানো হয়নি। Bulkhead এখানে এক process এর semaphore; আলাদা connection pool, আলাদা deployment — এগুলো আলোচিত, মাপা না। ১.৮ এর TaskFlow এর সিদ্ধান্ত আর Kubernetes এর অংশ একটা নকশা, চালানো না। README এর experiment ১–৪ চালানোর মতো; ৫ code বদলানোর কাজ — আপনার।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `circuit` চালানোর **আগে** লিখে ফেলুন — billing ২ s ধীর, timeout ৩০০ ms, ৮ জন client। Breaker ছাড়া ops/s কত হবে? (ইঙ্গিত: প্রতিটা client ৩০০ ms এ একটা করে।) আর breaker সহ কতগুলো call billing এ পৌঁছাবে — ১০? ১০০? তারপর মেলান, আর যেটা ভুল হলো সেটার কারণ এক লাইনে লিখুন।

2. **জানালাটা মাপুন:** experiment ১ — `TTL_MS=100 HEARTBEAT_MS=30 npm run discovery`, তারপর `TTL_MS=2000`. "মরার পরপর" এর ব্যর্থতা কীভাবে বদলাল? এবার উল্টো প্রশ্ন: TTL ১০০ ms এ একটা সুস্থ instance এর ২০০ ms GC pause হলে কী ঘটবে, আর তার পরের ঘটনাগুলো কী (বাকিদের উপর চাপ → তারা ধীর → …)? এটার একটা নাম আছে — কোন lesson এ পেয়েছিলেন?

3. **Threshold এর দুই দিক:** experiment ২ — `THRESHOLD=50` আর `THRESHOLD=2` দুটোই চালান। প্রতিটায় `reached` আর ops/s লিখে রাখুন। এবার ভাবুন: `THRESHOLD=2` এ একটা সুস্থ billing এর দুটো সাময়িক hiccup হলে কী হবে, আর সেই ভুলের দাম কে দেবে? আপনার TaskFlow এর জন্য কোন সংখ্যাটা বাছবেন — আর কোন মাপ (measurement) দেখে?

4. **ভাগটা বদলান:** experiment ৪ — `isolation.ts` এ board কে ৮ আর create কে ৮ দিন। দুটোর p50/p99 কী হলো? এবার board কে ২ দিয়ে দেখুন। একটা লাইন আঁকুন: board এর slot বাড়ালে create এর কী হয়? Production এ এই সংখ্যাটা আপনি কীভাবে ঠিক করবেন — অনুমান করে, নাকি কোনো একটা মাপ থেকে?

5. **Design অংশ:** TaskFlow এর work service এর এক পাতার resilience design: (ক) work এর প্রতিটা বাইরের নির্ভরতার তালিকা (billing, files, search, gateway) — প্রতিটার জন্য timeout, breaker এর threshold/মেয়াদ, আর bulkhead এর ভাগ; (খ) প্রতিটা নির্ভরতার breaker খুললে কী হবে — error না fallback, আর fallback হলে ঠিক কী উত্তর যাবে আর পরে কে মিলিয়ে নেবে; (গ) কোন তিনটা সংখ্যা dashboard এ থাকবে যা দেখে আপনি বুঝবেন breaker বা bulkhead ভুল tune করা; (ঘ) billing পুরো এক ঘণ্টা মরে থাকলে TaskFlow এর কোন কোন feature কাজ করবে আর কোনগুলো করবে না — একটা তালিকা, যেটা runbook এ যাবে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8 (সম্পূর্ণ, exit challenge সহ), 9.1, 9.2, 9.3
Current: 9.4 — Service discovery, circuit breaker, bulkhead
TaskFlow state: modular monolith (work, identity, files, search) + files processing service +
billing service (নিজের database); সামনে API gateway + web/mobile BFF (9.2); "task তৈরি" =
orchestrated saga (9.3), তার প্রথম ধাপ work → billing synchronous call; billing এর 3 টা instance,
Kubernetes Service + readiness probe (database এ SELECT 1) — নিজের registry না, server-side
discovery; graceful shutdown: আগে deregister, তারপর drain, তারপর বন্ধ; work → billing প্রতিটা
call এ circuit breaker — per dependency + per endpoint, 10 s জানালায় 50% ব্যর্থতা, slow call
(>250 ms) ও ব্যর্থতা, open 5 s, half-open এ একটা probe; breaker খুললে: task তৈরি = fallback
(quota_pending, রাতের reconcile), plan upgrade = স্পষ্ট error; work এর ভেতরে bulkhead — billing কে
ডাকে এমন কাজ concurrency 12, বাকি সব আলাদা pool, billing এর আলাদা HTTP connection pool;
লক্ষ্য: billing মরে গেলেও board খুলবে; retry এখন না (retry storm)
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall,
Over-fetching, Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication,
Service Mesh (mTLS), Two-Phase Commit (2PC), In-doubt Transaction, Saga, Compensating Transaction,
Pivot Transaction, Orchestration / Choreography, Semantic Lock, Service Discovery, Service Registry,
Client-side / Server-side Discovery, Circuit Breaker, Half-Open Probe, Bulkhead, Fail Fast
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: 9.5 — Rate limiting algorithms hands-on (Token Bucket, Sliding Window — Express middleware)
=======================
```

---

## ৮. পরের Lesson

চারটা lesson হয়ে গেল Module 9 এর — তাই `main.md` এর নিয়ম মেনে এক প্যারায় একটা ছোট recap: **9.1** দেখিয়েছে monolith ভাঙার তিনটা দাম — function call থেকে network call, ব্যর্থতা এখন আপনার app এর ভেতরে, আর হারানো transaction — আর তাই সিদ্ধান্ত ছিল modular monolith, প্রয়োজন হলে একটা করে service বের করা। **9.2** দেখিয়েছে বের করা service গুলোর সামনে কী বসে — BFF (প্রতিটা frontend এর নিজের backend) আর API gateway (একটা দরজা, এক জায়গায় token যাচাই)। **9.3** দেখিয়েছে সীমানা পার হয়ে atomicity নেই — 2PC atomic কিন্তু blocking, তাই saga: প্রতিটা ধাপ সাথে সাথে commit, ব্যর্থ হলে উল্টো কাজ, আর pivot এর পরে শুধু সামনে। **9.4** ধরেছে সেই saga এর প্রথম ধাপটাকেই — billing কে ডাকা — আর দেখিয়েছে সেই একটা call এর চারপাশে কী কী লাগে: ঠিকানা (discovery), থামার নিয়ম (breaker), আর ক্ষতির সীমানা (bulkhead)। চারটার মধ্যে একটা সুতো বারবার এসেছে কিন্তু খোলা হয়নি: **কে কতটুকু চাইতে পারে।** 9.2 এ gateway এর দায়িত্বের তালিকায় "rate limit" লেখা ছিল, 9.4 এ bulkhead এ আমরা নিজেদের সম্পদ ভাগ করেছি কিন্তু বাইরে থেকে আসা চাপ সীমিত করিনি — আর ১.৭ এ "shed" কলামটা পুরোটা শূন্য ছিল।

Exercise চালিয়ে পাঠান — বিশেষ করে ১ নম্বরের অনুমান আর ৫ নম্বরের design। রেডি হলে `next` লিখুন — Lesson 9.5 এ যাব: **Rate limiting algorithms, hands-on।** Token Bucket, Leaky Bucket, Fixed Window, Sliding Window — কোনটা burst সহ্য করে, কোনটা window এর সীমানায় দ্বিগুণ traffic ঢুকতে দেয়, আর কোনটা কত memory খায়; Express middleware এ নিজের হাতে লিখে মেপে দেখব, আর কয়েকটা instance থাকলে গোনাটা কোথায় রাখতে হয় (Redis) — 9.2 এর gateway এর সেই অসমাপ্ত দায়িত্বটা এবার শেষ হবে।
