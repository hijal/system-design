# Lesson 6.1 — Distributed System এ কী কী ভাঙে: Failure Model, Network Partition, Split Brain

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 2.5):** TaskFlow এর client একটা `POST /api/tasks` পাঠাল, আর ৫ সেকেন্ড পরে timeout পেল। Server এ task টা তৈরি হয়েছে কি হয়নি — client কি সেটা জানে? Idempotency key এখানে ঠিক কোন সমস্যাটা সমাধান করে?

**Prerequisite:** Lesson 1.6 (SPOF), Lesson 2.5 (Idempotency), Lesson 3.4 (Health check, failover), Lesson 5.7 (Failover, RPO/RTO), Lesson 5.9 (Network partition, quorum)

**তুমি এই lesson শেষে পারবে:**

1. Distributed system এর ভাঙনগুলোকে একটা **failure model** এ সাজাতে পারবে — node কীভাবে ভাঙে, network কীভাবে ভাঙে — আর বলতে পারবে কেন "অন্যটা মৃত" আর "অন্যটা ধীর" আলাদা করে জানা অসম্ভব
2. Failure detection এর timeout বাছাইয়ের trade-off সংখ্যা দিয়ে বলতে পারবে, আর দেখাতে পারবে কীভাবে একটা **process pause** একদম সঠিক code লেখা leader কে একটা "zombie" বানিয়ে ফেলে
3. **Split brain** কেন হয় ব্যাখ্যা করতে পারবে, আর চারটা প্রতিরক্ষা — majority, lease, fencing token, idempotency — কোনটা কী আটকায় আর কী আটকায় **না**, সেটা জানবে

**Tier:** 1 — Runnable Code (একটা seed দেওয়া simulation, আর দুটো আসল Node process যারা leader হওয়ার জন্য লড়ে)

---

## ০. TaskFlow এখন কোথায়

Module 5 শেষে TaskFlow এর চেহারা: Nginx এর পেছনে কয়েকটা Express instance, Redis cache, আর PostgreSQL primary + read replica — সাথে একটা স্বয়ংক্রিয় failover (Lesson 5.7 এর পরিকল্পনা মতো: primary ১০ সেকেন্ড সাড়া না দিলে replica promote হয়)।

আর একটা নতুন জিনিস: **due-date reminder**। প্রতি কয়েক সেকেন্ডে একটা job চলে, যেসব task এর deadline কাল, তাদের assignee কে email পাঠায়। Express instance ৬টা, কিন্তু job টা চালাতে হবে **একজনকেই** — নইলে প্রতিটা email ছয়বার যাবে। Team একটা সহজ সমাধান নিল: Redis এ একটা lock, ৩০ সেকেন্ডের মেয়াদে। যে instance lock পায়, সে "leader" — সে-ই reminder পাঠায়, আর মেয়াদ শেষ হওয়ার আগে lock renew করে।

একই সপ্তাহে দুটো incident:

1. **মঙ্গলবার রাত ২:১৪।** Data center এর একটা network switch ৪০ সেকেন্ডের জন্য গোলমাল করল। Monitor primary এর সাথে কথা বলতে পারল না, ১০ সেকেন্ড পরে replica promote হলো। কিন্তু primary মরেনি — তিনটা app instance তখনো তার সাথে কথা বলতে পারছিল, আর তারা ৪০ সেকেন্ড ধরে **পুরনো** primary তে লিখে গেল। সকালে দেখা গেল ২১২টা task শুধু পুরনো primary তে আছে, নতুনটায় নেই।
2. **বৃহস্পতিবার।** Support এ ticket: "কালকের deadline এর reminder আমি চারবার পেয়েছি।" Log ঘেঁটে দেখা গেল, leader instance টা একটা বিশাল export এর JSON parse করতে গিয়ে কয়েক সেকেন্ড আটকে ছিল। তার lock এর মেয়াদ শেষ হয়েছিল, আরেকটা instance leader হয়েছিল — আর আগের leader জেগে উঠে তার অর্ধেক-করা কাজ শেষ করেছিল।

Post-mortem meeting এ একজন engineer বলল, "আমি reminder এর code লাইন ধরে পড়েছি — প্রতিটা ধাপের আগে lock যাচাই করা হয়। কোনো bug নেই।"

সে ঠিক বলছে। আর এটাই আজকের lesson এর বিষয়: distributed system এ **প্রতিটা লাইন সঠিক হয়েও পুরো system ভুল হতে পারে** — কারণ ভাঙনগুলো code এর লাইনে না, লাইনগুলোর **মাঝখানে**। Exercise এ বৃহস্পতিবারের incident টা হুবহু বানাব, দুটো আসল process দিয়ে।

---

## ১. Theory

### ১.১ Partial Failure — এক machine আর অনেক machine এর মূল পার্থক্য

তোমার laptop এ একটা program হয় চলে, নয় crash করে। মাঝামাঝি অবস্থা প্রায় নেই — RAM এর একটা অংশ কাজ করছে আর বাকিটা করছে না, এমন হয় না; হলে পুরো machine ই পড়ে যায়। এটা ইচ্ছাকৃত design: hardware এ কিছু ভুল হলে পুরোটা থামিয়ে দেওয়া ভালো, ভুল উত্তর দেওয়ার চেয়ে।

Distributed system এ এই আরাম নেই।

**Partial failure** — system এর কিছু অংশ ভেঙেছে আর বাকিটা চলছে, আর প্রায়ই কোন অংশ ভেঙেছে সেটা নিশ্চিত করে জানা যায় না।

সবচেয়ে সাধারণ মুহূর্তটা দেখো: app server database কে একটা request পাঠাল, আর উত্তর এলো না। কী হয়েছে হতে পারে?

```
  app server                    network                    database
  ──────────                    ───────                    ────────
  request পাঠাল ──────► ① পথে হারিয়ে গেছে
                ──────► ② পথে আটকে আছে (queue তে), পরে পৌঁছাবে
                ─────────────────────────────────► ③ পৌঁছানোর আগেই database মরেছে
                ─────────────────────────────────► ④ কাজ করেছে, তারপর মরেছে
                ◄────── ⑤ উত্তর পথে হারিয়ে গেছে ◄──── কাজ করে উত্তর দিয়েছে
                ◄────── ⑥ উত্তর আসছে, শুধু দেরিতে ◄──── ধীর ছিল / থেমে ছিল (GC)

  app server এর চোখে ছয়টাই দেখতে একরকম:  … নীরবতা।
```

এর মধ্যে ④ আর ⑤ তে কাজটা **হয়ে গেছে**; ①, ③ তে হয়নি; ② আর ⑥ তে হয়তো এখনো হবে। App server জানে না কোনটা। এটাই Lesson 2.5 এর idempotency key এর আসল কারণ — timeout মানে "ব্যর্থ" না, timeout মানে **"জানি না"**। (আজকের spaced repetition প্রশ্নের উত্তরও এটাই।)

আর লক্ষ করো: অন্য machine টা ভেতরে কী অবস্থায় আছে, সেটা জানার **একমাত্র** উপায় network এ message। Message না এলে তুমি কিছুই জানো না — শুধু অনুমান করতে পারো।

### ১.২ Failure Model — কী কী ভাঙতে পারে, সেটা আগে ঠিক করা

কোনো algorithm "সব ধরনের ভাঙনে" সঠিক থাকে না। তাই distributed system এর প্রতিটা design একটা চুক্তি দিয়ে শুরু হয়: আমি ধরে নিচ্ছি এই এই জিনিস ভাঙতে পারে, আর এগুলো পারে না।

**Failure model** — একটা system কোন কোন ধরনের ভাঙন সামলানোর জন্য design করা, তার স্পষ্ট তালিকা।

**Node (machine/process) কীভাবে ভাঙে:**

| ধরন                | কী হয়                                                                 | বাস্তব উদাহরণ                                                   |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Crash-stop**     | Node মরে, আর কখনো ফেরে না                                              | Hardware পুরো নষ্ট; সহজ-করা model, বই এর উদাহরণে বেশি           |
| **Crash-recovery** | Node মরে, পরে আবার ফেরে — disk এ যা ছিল তা নিয়ে, memory এর সব হারিয়ে | Process restart, machine reboot — Postgres WAL দিয়ে ফেরে (5.3) |
| **Byzantine**      | Node ভুল বা মিথ্যা উত্তর দেয় — bug, corrupted data, বা ইচ্ছাকৃত       | Blockchain, বিমানের control system; সাধারণ backend এ ধরা হয় না |

সাধারণ backend system (Postgres, Kafka, etcd, আর TaskFlow) ধরে নেয় **crash-recovery** — node মরতে পারে, ফিরতে পারে, কিন্তু মিথ্যা বলে না। Byzantine সামলানো অনেক বেশি ব্যয়বহুল, আর নিজেদের data center এ নিজেদের server এর জন্য সাধারণত দরকার পড়ে না।

**Network কীভাবে ভাঙে:** message হারাতে পারে, দেরিতে পৌঁছাতে পারে, ক্রম বদলে যেতে পারে, দুবার পৌঁছাতে পারে (retry থেকে)। আর সবচেয়ে গুরুত্বপূর্ণ কথা: **দেরির কোনো ঊর্ধ্বসীমা নেই।** একটা message ১ ms এ পৌঁছায়, আরেকটা ৩০ সেকেন্ডে — আর দুটোই "স্বাভাবিক"। এই ধরনের network কে বলা হয় asynchronous — আর internet, data center এর network, সব এই ধরনের।

**ঘড়ি কীভাবে ভাঙে:** প্রতিটা machine এর ঘড়ি একটু আলাদা গতিতে চলে, আর NTP সেটা ঠিক করতে গিয়ে ঘড়ি হঠাৎ সামনে বা পিছনে লাফ দিতে পারে। এটা এত বড় বিষয় যে পুরো একটা lesson (6.4) এর জন্য রেখে দিচ্ছি — আজ শুধু মনে রাখো: **অন্য machine এর ঘড়ি বিশ্বাস করা যায় না, আর নিজেরটাও পুরোপুরি না।**

এই model টা মুখস্থ করার জিনিস না — এটা একটা প্রশ্ন যেটা প্রতিটা design এ জিজ্ঞেস করতে হয়: "এটা কোন ভাঙনে টিকে থাকে, আর কোনটায় থাকে না?" Lesson 6.2 এর Raft ঠিক এই model ধরে: crash-recovery node, asynchronous network, byzantine না।

### ১.৩ "মৃত, নাকি শুধু চুপ?" — Failure Detector আর Timeout

Failover (5.7), load balancer এর health check (3.4), lock এর মেয়াদ — সবকিছুর শুরুতে একটা প্রশ্ন: **অন্য node টা কি মৃত?**

**Failure detector** — যে mechanism ঠিক করে একটা node মৃত কিনা; প্রায় সবসময় heartbeat (নিয়মিত "আমি বেঁচে আছি" message) আর timeout (এতক্ষণ কিছু না এলে মৃত ধরা হবে) দিয়ে।

১.১ থেকে আমরা জানি এটা আসলে কী করছে: **নীরবতা থেকে অনুমান।** আর অনুমান ভুল হয়। প্রশ্ন শুধু — কোন দিকে ভুল হবে, আর কতবার।

Exercise এর `npm run detector` একটা primary কে ২৪ ঘণ্টা চালায়। Primary পুরো সময় **জীবিত** — একবারও crash করে না। শুধু মাঝে মাঝে চুপ থাকে: ১% heartbeat network এ হারায়, আর গড়ে প্রতি ~২০০ সেকেন্ডে একবার process থেমে যায় (বেশিরভাগ বার ছোট, GC এর মতো; কখনো কখনো ১–৮ সেকেন্ড, VM বা disk এর সমস্যার মতো):

```
   heartbeat পৌঁছেছে 852,617 টা; দুটোর মধ্যে সবচেয়ে লম্বা নীরবতা 7.75 s

   timeout     ভুল "মৃত" ঘোষণা / দিন     আসল crash টের পেতে (p50 / p99)
     150 ms           8751                101 ms /   151 ms
     300 ms            241                251 ms /   301 ms
     500 ms            102                451 ms /   501 ms
     1.00 s             53                951 ms /   1.00 s
     2.00 s             42                1.95 s /   2.00 s
     5.00 s             22                4.95 s /   5.00 s
    10.00 s              0                9.95 s /  10.00 s
```

(সৎ নোট: pause আর loss এর হার আমার ধরে নেওয়া একটা model, কোনো নির্দিষ্ট system থেকে মাপা না। সংখ্যাগুলো না, **আকৃতিটা** আসল — আর সেটা যেকোনো বাস্তব system এ একই।)

Table টা দুই দিক থেকে পড়ো:

- **বাম দিক:** timeout ১ সেকেন্ড হলে একটা সম্পূর্ণ সুস্থ primary কে দিনে ৫৩ বার "মৃত" ঘোষণা করা হয়। প্রতিটা ঘোষণা মানে একটা failover — আর মঙ্গলবারের incident দেখিয়েছে, অকারণ failover নিজেই একটা দুর্ঘটনা।
- **ডান দিক:** timeout ১০ সেকেন্ড হলে ভুল ঘোষণা শূন্য — কিন্তু primary সত্যিই মরলে ১০ সেকেন্ড কেউ টেরই পায় না। সেই ১০ সেকেন্ড TaskFlow এর কোনো write হয় না (5.7 এর RTO)।
- আর ১০ সেকেন্ডের সারির "০" টাও একটা ফাঁদ। এই ২৪ ঘণ্টায় সবচেয়ে লম্বা নীরবতা ছিল ৭.৭৫ সেকেন্ড। পরের সপ্তাহে যদি একটা ১২ সেকেন্ডের pause আসে? **কোনো timeout ই নিরাপদ না** — শুধু কম বা বেশি ঝুঁকিপূর্ণ।

**তাহলে timeout কীভাবে বাছবে?** ভুল ঘোষণার **দাম** দেখে:

- Load balancer এর health check (3.4): ভুল করে একটা server কে rotation থেকে সরালে কী হয়? কয়েক সেকেন্ড বাকিরা বাড়তি traffic নেয়, তারপর server ফিরে আসে। সস্তা, ফেরানো যায় → **ছোট timeout** চলে।
- Database failover: ভুল ঘোষণা মানে দুটো primary, হারানো write, ঘণ্টার পর ঘণ্টা মেলানো। ব্যয়বহুল, ফেরানো কঠিন → **সাবধানী timeout**, আর একাধিক পর্যবেক্ষকের একমত হওয়া।

বাস্তবের default গুলো এই যুক্তিই মানে (version ভেদে বদলায়): Redis Sentinel এর `down-after-milliseconds` এর উদাহরণ মান ৩০ সেকেন্ড, আর একাধিক Sentinel একমত না হলে failover হয় না; Patroni এর leader lock এর default `ttl` ৩০ সেকেন্ড; Kubernetes এর liveness probe default এ ১০ সেকেন্ড পর পর, টানা ৩ বার ব্যর্থ হলে restart। কিছু system নির্দিষ্ট timeout এর বদলে heartbeat আসার ইতিহাস দেখে সন্দেহের মাত্রা হিসাব করে (Cassandra এর "phi accrual" failure detector) — কিন্তু সেটাও অনুমানই, শুধু বুদ্ধিমান অনুমান।

সবচেয়ে গুরুত্বপূর্ণ শিক্ষা এখান থেকেই: **failure detector ভুল হবেই। তাই system এর সঠিকতা (correctness) এর উপর নির্ভর করতে পারে না।** Detector শুধু ঠিক করুক "কখন failover চেষ্টা করব"; failover নিজে এমনভাবে design করো যাতে detector ভুল হলেও data নষ্ট না হয়। বাকি lesson এটাই।

### ১.৪ Process Pause — Node মরেনি, শুধু সময় হারিয়েছে

১.৩ এর table এর বেশিরভাগ ভুল ঘোষণার কারণ network না — **process নিজে থেমে যাওয়া**।

**Process pause** — একটা চালু process যেকোনো মুহূর্তে কিছু সময়ের জন্য পুরো থেমে যেতে পারে, আর ফিরে এসে সে জানেও না যে সে থেমে ছিল।

কেন থামে:

- **Garbage collection** — অনেক runtime এ memory পরিষ্কারের সময় পুরো program থামানো হয় ("stop-the-world")। বড় heap এ এটা সেকেন্ডও হতে পারে।
- **Event loop আটকানো** — Node.js এ এটা আরও সহজ: একটা বিশাল `JSON.parse`, একটা synchronous `crypto` call, একটা ভারী loop — পুরো সময় আর কোনো callback চলে না, কোনো timer fire হয় না। বৃহস্পতিবারের incident ঠিক এটা।
- **VM আর container** — hypervisor অন্য VM কে CPU দিচ্ছে (steal time), VM কে অন্য host এ সরানো হচ্ছে (live migration), container এর CPU quota শেষ (throttling)।
- **Memory swap, ধীর disk** — memory এর একটা page disk থেকে আনতে হচ্ছে, বা log লিখতে গিয়ে disk আটকে আছে।
- Laptop এর lid বন্ধ করা, `SIGSTOP`, debugger এর breakpoint।

থামা process এর চোখে সময় থেমে ছিল না — সময় **লাফিয়েছে**। সে একটা লাইন execute করল, তারপর পরের লাইন — মাঝখানে ৩ সেকেন্ড গেছে, কিন্তু তার কাছে সেটা শূন্য। আর সেই ৩ সেকেন্ডে বাকি পৃথিবী তাকে মৃত ধরে নিয়ে এগিয়ে গেছে।

Exercise এ এটাই বানানো হয়েছে। দুটো আসল Node process, A আর B, reminder job এর leader হওয়ার জন্য একটা lock service থেকে **lease** নেয় (১.৬ এ বিস্তারিত; আপাতত: মেয়াদী lock, মেয়াদ ১ সেকেন্ড, অর্ধেক পেরোলে renew)। Leader প্রতি tick এ চারটা কাজ করে: lease যাচাই → storage থেকে cursor পড়ে (পরের কোন batch) → সেই batch এর reminder email পাঠায় → cursor + 1 লেখে।

A leader হয়, batch 3 এ cursor পড়ার ঠিক পরে ২.৫ সেকেন্ডের জন্য থেমে যায় (একটা synchronous busy loop — event loop আটকানোর হুবহু নকল)। `npm run split-brain`:

```
     703 ms  A      cursor = 3 পড়লাম … তারপর process থেমে গেল (2500 ms, stop-the-world)
    1793 ms  lock   lease → B (token 2)
    1796 ms  email  batch 3 পাঠাল B
    1798 ms  store  cursor 3 → 4  (B, token 2)
      …              (B batch 4 থেকে 9 পাঠায়)
    3025 ms  store  cursor 9 → 10  (B, token 2)
    3203 ms  A      আবার চলছি — আমার কাছে মনে হচ্ছে কিছুই হয়নি, batch 3 পাঠাচ্ছি
    3204 ms  email  batch 3 পাঠাল A   ← আবার! duplicate
    3206 ms  store  cursor 10 → 4  (A, token 1)   ← পিছনে গেল!
    3228 ms  email  batch 4 পাঠাল B   ← আবার! duplicate
      …              (B বিশ্বস্তভাবে 5, 6, 7, 8 আবার পাঠায়)
    3408 ms  A      lease renew হলো না — অন্য কেউ leader, আমি follower

   reminder batch পাঠানো হয়েছে: 16 বার, আলাদা batch 10 টা
   একাধিকবার গেছে: 6 টা batch  (3: B+A, 4: B+B, 5: B+B, 6: B+B, 7: B+B, 8: B+B)
```

ধীরে পড়ো, কারণ এখানে পুরো lesson টা আছে:

1. **A এর code ভুল না।** সে lease যাচাই করেছিল, আর যাচাইয়ের মুহূর্তে lease সত্যিই valid ছিল। ভুলটা যাচাই আর ব্যবহারের **মাঝখানে** — ঠিক সেখানে pause এসেছে।
2. **Lock service ও ভুল না।** A এর মেয়াদ শেষ, B চাইল, B পেল — নিয়ম মতোই।
3. ৩.২ সেকেন্ডের মুহূর্তে দুটো process নিজেকে leader ভাবছে, দুটোই কাজ করছে। এটাই split brain (১.৬)।
4. আর ক্ষতির আকারটা দেখো: A এর **একটা** মাত্র পুরনো লেখা (cursor 10 → 4) — আর তার ফলে **ছয়টা** batch দুবার গেছে। Stale write এর ক্ষতি প্রায়ই শুধু সেই এক লেখায় থামে না, পরের সবকিছুতে ছড়ায়।

"তাহলে email পাঠানোর ঠিক আগে lease আবার যাচাই করি?" — এই ক্ষেত্রে সেটা বাঁচাত। কিন্তু pause **যেকোনো** দুটো লাইনের মাঝে আসতে পারে — নতুন যাচাইয়ের ঠিক পরেও। যতবারই যাচাই করো, যাচাই আর কাজের মাঝে একটা ফাঁক থাকবেই। (Exercise এর experiment ৪ এ নিজে দেখবে।)

### ১.৫ Network Partition — আবার, এবার ভেতর থেকে

Lesson 5.9 এ network partition এর সংজ্ঞা আর CAP এর বাছাই দেখেছ: link কাটলে দুই দিক জানে না অন্য দিক মৃত নাকি বিচ্ছিন্ন। আজ তার সাথে দুটো জিনিস যোগ করো।

**প্রথমত, partition সবসময় পরিষ্কার দুই ভাগ না।** মঙ্গলবারের incident এর আকৃতি:

```
                   ┌──────────────┐
                   │   Monitor    │
                   └──────┬───────┘
                          ╳  ← এই link কাটা
     ┌─────────────┐      │       ┌──────────────┐
     │ app 1, 2, 3 │──────┼──────►│   PRIMARY    │   app 1–3 এর চোখে: primary ঠিক আছে
     └─────────────┘      │       └──────────────┘
                          ▼
     ┌─────────────┐  ┌──────────────┐
     │ app 4, 5, 6 │─►│   REPLICA    │   monitor এর চোখে: primary মৃত → replica promote
     └─────────────┘  └──────────────┘
```

Monitor primary কে দেখে না, কিন্তু কিছু app দেখে। এটাকে বলে **partial** (বা asymmetric) partition — কে কাকে দেখে সেটা নির্ভর করে তুমি কোথায় দাঁড়িয়ে। Monitor এর সিদ্ধান্ত monitor এর চোখে একদম সঠিক ছিল। সমস্যা হলো, তার চোখটা পুরো ছবি না।

আরও একটা আকৃতি আছে, যেটা হয়তো সবচেয়ে কঠিন: **gray failure** — node মরেনি, partition ও না, শুধু অসম্ভব ধীর বা মাঝে মাঝে ব্যর্থ (disk মরতে বসেছে, network card অর্ধেক packet ফেলছে)। Health check pass করে, কিন্তু আসল request timeout হয়।

**দ্বিতীয়ত, এগুলো বিরল না।** Peter Bailis আর Kyle Kingsbury এর "The Network is Reliable" (ACM Queue, 2014) বড় বড় কোম্পানির অনেকগুলো আসল partition এর ঘটনা এক জায়গায় করেছে — শিরোনামটা ব্যঙ্গ। আর একটা বিখ্যাত উদাহরণ: **GitHub, অক্টোবর 2018।** US East Coast এর একটা network hub আর primary data center এর মধ্যে ৪৩ সেকেন্ডের জন্য যোগাযোগ কেটে গেল। তাদের স্বয়ংক্রিয় failover tool MySQL এর primary গুলোকে West Coast এ সরিয়ে দিল। যোগাযোগ ফেরার পর দেখা গেল — দুই দিকেই এমন write আছে যা অন্য দিকে নেই। ৪৩ সেকেন্ডের partition এর ফল ছিল প্রায় ২৪ ঘণ্টার degraded service, data মেলাতে মেলাতে। (তাদের post-incident report পড়ার মতো — ঠিক মঙ্গলবারের গল্প, বিশাল আকারে।)

### ১.৬ Split Brain — আর চারটা প্রতিরক্ষা

**Split brain** — একই সময়ে একাধিক node নিজেকে leader (বা primary) ভাবছে, আর দুজনেই এমন কাজ করছে যেটা শুধু একজনের করার কথা।

দুটো incident দুটো ভিন্ন পথে এখানে পৌঁছেছে:

- **মঙ্গলবার:** failure detector ভুল করল (partial partition) → নতুন primary বানানো হলো → পুরনোটা জীবিত, আর জানে না যে তাকে সরানো হয়েছে।
- **বৃহস্পতিবার:** leader থেমে গেল → lease এর মেয়াদ শেষ → নতুন leader → পুরনোটা জেগে উঠে জানে না যে সে আর leader না।

দুটোর মূলে একই জিনিস: **পুরনো leader জানে না যে সে পুরনো।** কেউ তাকে জানাতে পারে না — কারণ সে হয় বিচ্ছিন্ন, নয় থেমে আছে। তাই প্রতিরক্ষাগুলো সবই এই প্রশ্নের উত্তর: "পুরনো leader যখন ভুল করে কাজ করতে যাবে, কে তাকে থামাবে?"

**প্রতিরক্ষা ১ — Majority দিয়ে সিদ্ধান্ত।** নতুন leader বানানোর সিদ্ধান্ত একা একজন monitor নেবে না — node গুলোর **majority** (অর্ধেকের বেশি) একমত হলে তবেই। Lesson 5.9 এর যুক্তিই: দুটো majority সবসময় অন্তত একটা node এ মেলে, তাই partition এর দুই দিকে একসাথে দুটো majority হতে পারে না — **দুই দিকে দুটো নতুন leader নির্বাচিত হওয়া** অসম্ভব।

এই কারণে cluster এ node সাধারণত **বিজোড়** — ৩ বা ৫। দুই node এর cluster এ partition হলে প্রতিটা দিকে ১টা node, কারো majority নেই — হয় দুজনেই থামবে (availability শেষ), নয়তো দুজনেই এগোবে (split brain)। তাই দুই-server এর setup এ স্বয়ংক্রিয় failover নিরাপদ না; একটা তৃতীয় "witness" node লাগে, যেটা শুধু ভোট দেয়। (মঙ্গলবারের সমস্যার মূলে ছিল এটাই: একটা monitor, একা, সিদ্ধান্ত নিচ্ছিল।)

কিন্তু লক্ষ করো majority কী আটকায় **না**: বৃহস্পতিবারের পুরনো leader এর কাজ। Majority নতুন leader বাছাই সঠিক করে; কিন্তু পুরনো leader থেমে ছিল, সে ভোটের খবর পায়নি — জেগে উঠে সে তার আগের বিশ্বাস নিয়েই কাজ করে।

**প্রতিরক্ষা ২ — Lease।**

**Lease** — একটা মেয়াদী lock: holder নির্দিষ্ট সময়ের জন্য অধিকার পায়, নিয়মিত renew না করলে অধিকার আপনা আপনি শেষ হয়ে যায়।

Lease crash সামলায় সুন্দরভাবে — holder মরলে কাউকে কিছু করতে হয় না, মেয়াদ শেষ হলেই অন্য কেউ নিতে পারে (সাধারণ lock এ holder মরলে lock চিরকাল আটকে থাকত)। আর holder এর দিক থেকে নিয়ম: "আমার ঘড়িতে মেয়াদ শেষ হলে কাজ থামাও।"

কিন্তু exercise ঠিক এটাই ভেঙেছে। Lease এর নিয়ম মানতে holder কে নিজের মেয়াদ **টের পেতে** হয় — আর থামা process কিছুই টের পায় না। Lease এর নিরাপত্তা নির্ভর করে একটা অনুমানের উপর: pause আর ঘড়ির ভুল, lease এর মেয়াদের চেয়ে অনেক ছোট। ১.৪ দেখিয়েছে এই অনুমান ভাঙে।

(Lease লম্বা করলে? Exercise এর experiment ২ — `LEASE_MS=5000`: duplicate শূন্য, কিন্তু A থেমে থাকার পুরো সময় **কেউ** reminder পাঠায়নি, মোট batch ১৬ থেকে ৮ এ নেমেছে। Lease এর মেয়াদ আসলে ১.৩ এর timeout ই — একই trade-off, অন্য নামে।)

**প্রতিরক্ষা ৩ — Fencing Token।** এটাই আসল সমাধান, আর ধারণাটা সরল: পুরনো leader কে থামানোর দায়িত্ব **যে resource এ সে লিখছে**, তাকে দাও।

**Fencing token** — প্রতিবার নতুন কাউকে lease দেওয়ার সময় একটা সংখ্যা, যেটা সবসময় বাড়ে; resource প্রতিটা লেখার সাথে token যাচাই করে, আর এ পর্যন্ত দেখা সবচেয়ে বড় token এর চেয়ে ছোট token এর লেখা প্রত্যাখ্যান করে।

```
  lock service      A (token 1)               B (token 2)          storage (সর্বোচ্চ দেখা token)
  ────────────      ───────────               ───────────          ─────────────────────────────
  lease → A, 1
                    লেখো (token 1) ─────────────────────────────►  1 ≥ 1 ✓  সর্বোচ্চ = 1
                    ░░ থেমে আছে ░░
  মেয়াদ শেষ
  lease → B, 2                                লেখো (token 2) ───►  2 ≥ 1 ✓  সর্বোচ্চ = 2
                    ░░ জাগল ░░
                    লেখো (token 1) ─────────────────────────────►  1 < 2 ✗  প্রত্যাখ্যান!
```

`npm run fenced` — একই গল্প, storage এবার token যাচাই করে:

```
    3201 ms  A      আবার চলছি — আমার কাছে মনে হচ্ছে কিছুই হয়নি, batch 3 পাঠাচ্ছি
    3202 ms  email  batch 3 পাঠাল A   ← আবার! duplicate
    3203 ms  store  ✗ A এর লেখা প্রত্যাখ্যাত: token 1 < 2
    3204 ms  A      storage লেখা ফিরিয়ে দিল: আমার token 1 < 2 — আমি আর leader না, থামলাম

   একাধিকবার গেছে: 1 টা batch  (3: B+A)
   storage এ প্রত্যাখ্যাত লেখা: 1
```

Cursor অক্ষত, B এর কাজ নিরাপদ, আর একটা বোনাস: প্রত্যাখ্যান থেকেই A **জানতে পারল** যে সে পুরনো, আর নিজে থামল। Fencing কোনো timeout, কোনো ঘড়ি, কোনো pause এর দৈর্ঘ্যের উপর নির্ভর করে না — শুধু সংখ্যার তুলনা।

TaskFlow এ Postgres দিয়ে এটা বানানো সহজ — Lesson 5.5 এর শর্তসহ atomic update ই:

```typescript
// token না কমলে তবেই লেখো — এক statement এ, তাই দুজন একসাথে এলেও race নেই
const [affected] = await ReminderCursor.update(
	{ value: cursor + 1, fenceToken: token },
	{ where: { id: 1, fenceToken: { [Op.lte]: token } } }
);
if (affected === 0) {
	// নতুন কেউ বড় token নিয়ে লিখেছে — আমি আর leader না
	throw new Error(`stale leader: token ${token} rejected`);
}
```

শর্ত একটাই: token এর উৎস নির্ভরযোগ্য হতে হবে — যে service lease দেয়, সে-ই token দেয়, আর তার নিজের split brain হলে চলবে না। এজন্য বাস্তবে এই কাজে etcd, ZooKeeper বা Consul এর মতো consensus-ভিত্তিক store ব্যবহার হয় (etcd এর revision বা ZooKeeper এর zxid আসলে ঠিক এই ধরনের সবসময়-বাড়া সংখ্যা)। কেন সেগুলোর নিজের split brain হয় না — সেটা পরের lesson এর Raft।

**প্রতিরক্ষা ৪ — Idempotency, যেখানে fencing পৌঁছায় না।** Fenced run এর output এ আবার তাকাও: batch 3 **তবু** দুবার গেছে। কারণ email provider token দেখে না — আর বাস্তবেও দেখবে না; SendGrid কে তোমার fencing token শেখানো যায় না।

Fencing শুধু সেই resource কে রক্ষা করে যে token যাচাই করে। বাকি সব side effect — email, payment, অন্য কোম্পানির API — এর জন্য Lesson 2.5 এর idempotency: প্রতিটা কাজের একটা স্থির key (এখানে batch number), আর receiver একই key দ্বিতীয়বার এলে কাজটা আর করে না। Stripe এর `Idempotency-Key` header ঠিক এটা। নিজের email পাঠানোর জন্য: একটা `sent_reminders` table এ `(taskId, dueDate)` এর উপর unique constraint, আর insert সফল হলে তবেই পাঠানো।

**আর শেষ উপায় — পুরনোকে জোর করে মারা।** কিছু system (বিশেষ করে database failover) পুরনো primary কে নিশ্চিতভাবে থামায়: তার power কেটে দেয় বা storage থেকে বিচ্ছিন্ন করে। এর পুরনো নাম STONITH ("shoot the other node in the head")। Patroni এর মতো tool একটা watchdog ব্যবহার করে — primary যদি consensus store এর সাথে কথা বলতে না পারে, সে নিজেই নিজেকে demote করে বা machine reset হয়। কার্যকর, কিন্তু নির্ভর করে "মারার" হুকুম পৌঁছানোর উপর — যেটা partition এ পৌঁছায় না।

**একটা বিখ্যাত বিতর্ক:** 2016 সালে Martin Kleppmann ("Designing Data-Intensive Applications" এর লেখক) Redis এর distributed lock algorithm (Redlock) নিয়ে লিখেছিলেন যে এটা ঠিক এই exercise এর কারণে — process pause আর ঘড়ির উপর নির্ভরতা — নিরাপদ না, যদি না fencing token থাকে। Redis এর স্রষ্টা Salvatore Sanfilippo (antirez) উত্তরে দ্বিমত করেন। দুটো লেখাই পড়ার মতো, আর বিতর্কটা পুরোপুরি মেটেনি। কিন্তু Kleppmann এর একটা পার্থক্য সবাই মেনে নেয়, আর সেটা মনে রাখার মতো:

- **Efficiency lock** — lock ভাঙলে কাজ একটু বেশি হয় (একই report দুবার বানানো)। বিরক্তিকর, ক্ষতিকর না। Redis `SET NX PX` যথেষ্ট।
- **Correctness lock** — lock ভাঙলে data নষ্ট হয় বা টাকা দুবার কাটে। এখানে lock যথেষ্ট না — fencing token আর idempotency লাগবে।

TaskFlow এর reminder কোন ধরনের? এক-আধবার duplicate email বিরক্তিকর, কিন্তু cursor পিছিয়ে ছয়টা batch আবার পাঠানো — আর invoice job হলে দুবার charge — সেটা correctness।

> **Trade-off Table — Split brain এর প্রতিরক্ষা**

| প্রতিরক্ষা                 | কী আটকায়                                            | কী আটকায় না                                       | দাম                                           |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| Majority (৩/৫ node এর ভোট) | দুই দিকে একসাথে দুটো নতুন leader নির্বাচিত হওয়া     | পুরনো leader এর নিজের কাজ (সে ভোটের খবর জানে না)   | বিজোড় সংখ্যক node; minority দিক থেমে যায়    |
| Lease (মেয়াদী lock)       | Crash করা holder এর lock চিরকাল আটকে থাকা            | Pause বা ঘড়ির ভুলে মেয়াদ পেরোনো holder এর কাজ    | মেয়াদ = timeout; ছোট → অকারণ বদল, বড় → ধীর  |
| Fencing token              | Token যাচাই করা resource এ পুরনো leader এর লেখা      | Token না দেখা side effect (email, বাইরের API)      | Resource এ শর্তসহ লেখা; নির্ভরযোগ্য token উৎস |
| Idempotency key            | একই কাজ দুবার হওয়ার **ফল** (duplicate email/charge) | ভিন্ন কাজ (cursor পিছিয়ে যাওয়া) — key একই না হলে | প্রতিটা receiver এ dedupe (table, header)     |
| পুরনোকে জোর করে থামানো     | পুরনো primary এর আর কোনো লেখা                        | যখন থামানোর হুকুম নিজেই partition এ আটকে যায়      | Hardware/infra এর সাপোর্ট; ভুল হলে দুজনই মৃত  |

বাস্তবে এগুলো একসাথে ব্যবহার হয়: majority দিয়ে leader বাছা, lease দিয়ে crash সামলানো, fencing দিয়ে storage রক্ষা, idempotency দিয়ে বাকি side effect।

---

## ২. Interview Angle

**"তোমার service এর ১০টা instance, কিন্তু একটা cron job শুধু একবার চলতে হবে — কীভাবে?"** — খুব common প্রশ্ন, আর সাধারণ উত্তর "Redis lock, TTL দিয়ে" এর পরেই আসল প্রশ্ন আসে: "lock holder যদি GC pause এ আটকে যায়?" ভালো উত্তরের ক্রম: lease (TTL) → process pause এ lease কেন যথেষ্ট না → fencing token (storage এ শর্তসহ লেখা) → বাইরের side effect এর জন্য idempotency key। বোনাস: efficiency বনাম correctness lock এর পার্থক্য, আর "leader election নিজে বানাব না — etcd/ZooKeeper/Kubernetes Lease ব্যবহার করব।"

**"Database primary এর health check এর timeout কত রাখবে?"** — একটা সংখ্যা বলার আগে trade-off বলো: ছোট timeout = অকারণ failover (আর প্রতিটা failover এ split brain এর ঝুঁকি), বড় timeout = বেশি RTO। তারপর: "ভুল ঘোষণার দাম দেখে বাছব — LB health check আক্রমণাত্মক, DB failover সাবধানী আর majority এর একমত হওয়া দরকার। আর failover এমনভাবে design করব যাতে detector ভুল হলেও data নষ্ট না হয়।" এই শেষ বাক্যটাই senior উত্তরকে আলাদা করে।

**"Network partition হলে তোমার system কী করবে?"** — 5.9 এর CAP এর সাথে এখন split brain যোগ করো: "Minority দিকের পুরনো primary কে কীভাবে থামাব" — majority ছাড়া সে write নেবে না (Patroni এর মতো: consensus store এর সাথে যোগাযোগ হারালে নিজেকে demote করে), আর fencing।

**Production এ বাস্তবে:** leader election বা distributed lock কেউ নিজে লেখে না — etcd, ZooKeeper, Consul, Kubernetes এর Lease object, বা database এর নিজের failover tool (Patroni, managed database)। কিন্তু সেগুলো ব্যবহার করলেও **fencing আর idempotency তোমার app এর দায়িত্ব** — কোনো lock service তোমার storage এ token যাচাই করে দেবে না, বা তোমার email provider কে dedupe শেখাবে না।

---

## ৩. Key Takeaway

- Distributed system এর মূল কঠিনতা **partial failure**: কিছু অংশ ভাঙে, বাকিটা চলে, আর উত্তর না এলে জানা যায় না কী হয়েছে — timeout মানে "ব্যর্থ" না, "জানি না"
- **Failure model** আগে ঠিক করো: সাধারণ backend ধরে নেয় crash-recovery node (মিথ্যা বলে না), asynchronous network (দেরির সীমা নেই), আর অবিশ্বস্ত ঘড়ি
- **Failure detector** (heartbeat + timeout) একটা অনুমান — ছোট timeout এ অকারণ failover, বড় timeout এ ধীর recovery; exercise এ ১ s timeout এ সুস্থ primary দিনে ৫৩ বার "মৃত"। Timeout বাছো ভুল ঘোষণার দাম দেখে, আর correctness কে detector এর উপর নির্ভর করতে দিও না
- **Process pause** (GC, আটকানো event loop, VM) এ node মরে না, শুধু সময় হারায় — আর যাচাই আর ব্যবহারের মাঝের ফাঁকে পুরনো leader সঠিক code দিয়েই ভুল কাজ করে
- **Split brain** এর মূল: পুরনো leader জানে না যে সে পুরনো; partial partition আর pause — দুটো পথেই আসে
- Majority নতুন leader বাছাই সঠিক রাখে (তাই ৩/৫ node), lease crash সামলায় — কিন্তু দুটোর কেউই থেমে থাকা পুরনো leader কে থামায় না
- **Fencing token** — resource নিজে পুরনো token এর লেখা প্রত্যাখ্যান করে; আর যেখানে token পৌঁছায় না (email, payment), সেখানে **idempotency key**

---

## ৪. নতুন Term (Glossary)

| Term                 | অর্থ                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Partial Failure**  | System এর কিছু অংশ ভেঙেছে আর বাকিটা চলছে, আর প্রায়ই কোন অংশ ভেঙেছে সেটা নিশ্চিত জানা যায় না                               |
| **Failure Model**    | একটা system কোন কোন ধরনের ভাঙন (crash-stop, crash-recovery, byzantine; network, ঘড়ি) সামলানোর জন্য design করা — তার তালিকা |
| **Failure Detector** | যে mechanism ঠিক করে একটা node মৃত কিনা — সাধারণত heartbeat আর timeout দিয়ে; সবসময় একটা অনুমান                            |
| **Process Pause**    | চালু process এর হঠাৎ কিছু সময় পুরো থেমে থাকা (GC, আটকানো event loop, VM) — ফিরে এসে সে জানে না যে থেমে ছিল                 |
| **Split Brain**      | একই সময়ে একাধিক node নিজেকে leader/primary ভাবছে আর শুধু একজনের করার কথা এমন কাজ করছে                                      |
| **Lease**            | মেয়াদী lock — নির্দিষ্ট সময়ের অধিকার, renew না করলে আপনা আপনি শেষ হয়ে যায়                                               |
| **Fencing Token**    | প্রতিবার নতুন lease এর সাথে বাড়তে থাকা সংখ্যা; resource পুরনো (ছোট) token এর লেখা প্রত্যাখ্যান করে                         |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. একটা ছোট কোম্পানির দুটো Postgres server: primary আর replica। Replica তে একটা script চলে: "primary ১০ সেকেন্ড ping এর উত্তর না দিলে নিজেকে promote করো।" এই setup এ কী কী ভুল হতে পারে — অন্তত দুটো আলাদা পরিস্থিতি বলো। তুমি কী বদলাবে?
2. TaskFlow এর billing job প্রতি মাসের ১ তারিখে চলে: invoice এর পরের নম্বর নেয়, database এ invoice লেখে, তারপর Stripe এ card charge করে। একটাই instance চালাতে Redis lock, TTL ৩০ সেকেন্ড। একদিন leader instance একটা ৪০ সেকেন্ডের pause এ আটকাল। কী কী ভুল হতে পারে? প্রতিটা side effect (invoice নম্বর, invoice row, Stripe charge) এর জন্য কোন প্রতিরক্ষা লাগবে?
3. ১.৩ এর table দেখে manager বলল, "১ সেকেন্ডে ৫৩টা ভুল failover? তাহলে সব timeout ৩০ সেকেন্ড করে দাও, সমস্যা শেষ।" তুমি কীভাবে উত্তর দেবে? কোন timeout গুলো ছোটই থাকা উচিত, আর কোন গুলো বড় — আর বড় timeout এর পাশাপাশি আর কী লাগবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** সমস্যা একাধিক:

- **Partition:** primary জীবিত, শুধু replica আর primary এর মধ্যের link কাটা। Replica নিজেকে promote করল, অথচ app গুলো তখনো primary তে লিখছে → split brain (মঙ্গলবারের incident)। দুই node এর setup এ এর কোনো নিরাপদ সমাধান নেই — একটা দিক আরেকটা দিককে "মৃত" না "বিচ্ছিন্ন" আলাদা করতে পারে না, আর majority বানানোর মতো তৃতীয় কেউ নেই।
- **Process pause:** primary ১২ সেকেন্ডের একটা pause এ (বা ভারী load এ) → replica promote → primary জেগে উঠে এখনো primary হিসেবে write নিচ্ছে।
- **Async lag:** promote এর মুহূর্তে যা replica পায়নি, সেটা হারায় (5.7 এর RPO)।
- **পুরনোকে কেউ থামাচ্ছে না:** script এ শুধু "নিজেকে promote করো" আছে; "পুরনোকে থামাও" নেই, আর app কে নতুন ঠিকানায় সরানোও নেই।

কী বদলাবে: তৃতীয় একটা node (witness) যোগ করে majority তে সিদ্ধান্ত — বাস্তবে Patroni + etcd (৩ node), যেখানে leader হতে হলে consensus store এ lease ধরে রাখতে হয়, আর যে primary lease হারায় সে নিজেকে demote করে (watchdog সহ)। App connection একটা জায়গা দিয়ে (proxy বা DNS যেটা Patroni update করে)। Timeout ১০ সেকেন্ডের সংখ্যাটাও যাচাই করা দরকার — ১.৩ এর table মাথায় রেখে।

**প্রশ্ন ২:** ৪০ সেকেন্ডের pause, TTL ৩০ — pause এর মাঝেই lock এর মেয়াদ শেষ, আরেকটা instance leader হয়ে billing শুরু করে। পুরনো leader জেগে উঠে তার অর্ধেক-করা কাজ শেষ করে। ফলাফল: একই invoice নম্বর দুবার (বা নম্বর এর ধারায় ফাঁক/উল্টো), একই customer এর দুটো invoice row, আর সবচেয়ে খারাপ — **card দুবার charge**। প্রতিরক্ষা, side effect অনুযায়ী:

- **Invoice নম্বর:** নম্বর lock এর holder কে দিয়ে না — database নিজে দিক (sequence), অথবা নম্বর লেখার সময় fencing token এর শর্ত (`WHERE fence_token <= $token`)।
- **Invoice row:** `(customerId, billingMonth)` এর উপর unique constraint — একই মাসের দ্বিতীয় invoice database নিজেই প্রত্যাখ্যান করে। এটা আসলে idempotency, database এর ভাষায়।
- **Stripe charge:** Stripe token দেখে না — তাই `Idempotency-Key: invoice-{customerId}-{month}`। দুজন leader একই key দিয়ে charge চাইলেও Stripe একবারই কাটবে।

শিক্ষা: এখানে lock টা "efficiency lock" হিসেবে ঠিক আছে (দুজন একসাথে কাজ না করাটা ভালো), কিন্তু correctness আসছে unique constraint, fencing আর idempotency key থেকে — lock থেকে না।

**প্রশ্ন ৩:** সব timeout ৩০ সেকেন্ড করলে ভুল failover কমে, কিন্তু প্রতিটা আসল failure এ ৩০+ সেকেন্ড কেউ টের পায় না — load balancer মৃত server এ ৩০ সেকেন্ড ধরে traffic পাঠাবে (হাজার হাজার failed request), database মরলে ৩০ সেকেন্ড কোনো write নেই। উত্তর: **timeout বাছো ভুল ঘোষণার দাম দেখে।**

- **ছোট থাকুক:** load balancer এর health check (3.4) — ভুল করে সরানো সস্তা আর ফেরানো যায়; client এর request timeout + retry (idempotent হলে)।
- **বড়/সাবধানী হোক:** database failover, leader election — ভুল ঘোষণা ব্যয়বহুল আর ফেরানো কঠিন।
- **বড় timeout এর পাশাপাশি:** একাধিক পর্যবেক্ষকের majority একমত হলে তবেই failover (একটা monitor একা না); আর failover নিজে নিরাপদ — fencing, পুরনো primary এর self-demote — যাতে detector ভুল হলেও data নষ্ট না হয়। তখন timeout টা আর "নিরাপত্তার" সংখ্যা থাকে না, শুধু "কত দ্রুত চেষ্টা করব" এর সংখ্যা — আর সেটা তুলনামূলক ছোট রাখা যায়।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (seed দেওয়া simulation + দুটো আসল Node process)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-6.1-split-brain/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.1-split-brain) — `npm install`, তারপর `npm run detector`, `npm run split-brain`, `npm run fenced`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`detector` একটা seed দেওয়া simulation — প্রতিবার হুবহু একই সংখ্যা। `split-brain` আর `fenced` এ তিনটা ছোট service (lock, storage, email provider) একটা Express process এ চলে, আর A ও B আলাদা Node process — তাই A এর pause সত্যিকারের: তার event loop আটকে থাকে, বাকিরা চলে।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `detector` কয়েকবার চালিয়ে হুবহু একই output; `split-brain` আর `fenced` প্রতিটা তিনবার চালিয়ে একই ঘটনার ক্রম আর একই শেষ ফল (ms গুলো প্রতিবার সামান্য আলাদা — আসল timer)। README এর experiment ১ আর ২ ও চালিয়ে দেখা হয়েছে; ৩ আর ৪ তোমার code বদলানোর কাজ।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. তিনটা script চালাও। `split-brain` এর output থেকে এক লাইনে লেখো: A এর code এর কোন লাইনটা "ভুল"? (উত্তরটা একটা প্রশ্নের মতো শোনাবে — সেটাই ঠিক।)

2. **Timeout বাছাই:** `detector` এর table দেখে দুটো timeout বাছো — (ক) Nginx এর health check এর জন্য, (খ) TaskFlow এর Postgres failover এর জন্য। প্রতিটার জন্য এক লাইনে যুক্তি: ভুল ঘোষণার দাম কী, আর দেরিতে টের পাওয়ার দাম কী।

3. **Lease এর মেয়াদ = timeout** (experiment ২): `LEASE_MS=5000 npm run split-brain` আর default এর মোট batch সংখ্যা তুলনা করো। Duplicate শূন্য কেন, আর কী হারালে? এবার ভাবো — A সত্যিই crash করলে ৫ সেকেন্ডের lease এ reminder কতক্ষণ বন্ধ থাকত?

4. **Fencing যেখানে পৌঁছায় না** (experiment ৩): `/email` কে batch number দিয়ে idempotent বানাও, তারপর `npm run fenced`। Duplicate শূন্য হলো? এবার `split-brain` (fencing ছাড়া) এও চালাও — idempotent email একা কি যথেষ্ট ছিল? Cursor এর কী হলো?

5. **Design অংশ:** TaskFlow এর জন্য একটা পরিকল্পনা লেখো, দুটো অংশে। (ক) Reminder job: leader কীভাবে বাছা হবে (কোন tool), lease এর মেয়াদ কত, cursor কীভাবে fence করবে (কোন table, কোন শর্ত), email এর duplicate কীভাবে আটকাবে। (খ) Postgres failover: কয়টা node এর ভোটে সিদ্ধান্ত, timeout কত (সংখ্যা সহ), পুরনো primary কে কীভাবে থামাবে, আর app কীভাবে নতুন primary খুঁজে পাবে। মঙ্গলবার আর বৃহস্পতিবারের দুটো incident — তোমার পরিকল্পনায় প্রতিটা ঠিক কোথায় আটকায়, দেখাও।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (সম্পূর্ণ, exit challenge সহ)
Current: 6.1 — Failure Model, Network Partition, Split Brain
TaskFlow state: Nginx + Express instance গুলো, CDN, Redis cache; PostgreSQL primary +
read replica, স্বয়ংক্রিয় failover (এখন: majority ভোট + পুরনো primary এর self-demote এর পরিকল্পনা);
reminder job একটা leader এ — lease + fenced cursor (শর্তসহ update) + email এ idempotency key
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 6.2 — Consensus: leader election, Raft basics
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের দুটো timeout এর যুক্তি আর ৫ নম্বরের পরিকল্পনা। রেডি হলে `next` লিখো — Lesson 6.2 এ যাব: **Consensus — Leader Election আর Raft basics।** আজ আমরা বারবার বলেছি "majority দিয়ে বাছো", "token দেবে একটা নির্ভরযোগ্য store" — কিন্তু সেই store নিজে কয়েকটা node এ চলে, আর তারও partition হয়, তারও pause হয়। তাহলে সে কীভাবে split brain এড়ায়? কয়েকটা node কীভাবে এমন একটা সিদ্ধান্তে একমত হয় যেটা আর কখনো বদলাবে না — এমনকি message হারালেও, node মরলেও? Raft এর term, vote, আর log দিয়ে সেই উত্তর।
