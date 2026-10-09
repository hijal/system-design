# Lesson 9.3 - Distributed Transactions: Saga Pattern, 2PC

**Module 9 - Microservices & Service Architecture**

> **Spaced Repetition (Lesson 6.2):** Raft এ leader হঠাৎ মারা গেলে cluster কি থেমে থাকে? নতুন leader বাছতে কয়টা node এর সম্মতি লাগে - সবার, নাকি বেশিরভাগের? আজ একটা পুরনো protocol দেখব যেখানে এই দুটো প্রশ্নের উত্তর আলাদা - আর সেই পার্থক্যটাই তার সবচেয়ে বড় দুর্বলতা।

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 5.5 (Transaction, lock, isolation), Lesson 6.1 (Partial failure, timeout এর অনিশ্চয়তা), Lesson 6.2 (Raft, majority), Lesson 7.4 (Idempotent consumer, retry, DLQ), Lesson 7.5 (Outbox), Lesson 9.1 (Database per service, ৮৩টা অমিল), Lesson 9.2 (Synchronous বনাম event)

**আপনি এই lesson শেষে পারবেন:**

1. **Two-phase commit** কীভাবে কাজ করে আর কোথায় ভাঙে বলতে পারবেন - coordinator মরলে **in-doubt** transaction আর তার lock কীভাবে বাকি সবাইকে থামায়, মাপা সংখ্যা দিয়ে; আর কেন service গুলোর মাঝে প্রায় কেউ 2PC ব্যবহার করে না, অথচ Spanner এর মতো database এর ভেতরে করে
2. একটা **saga** design করতে পারবেন - ধাপের ক্রম, প্রতিটা ধাপের উল্টো কাজ, pivot, saga এর log আর recovery, idempotent ধাপ - আর orchestration বনাম choreography বাছতে পারবেন
3. Saga এ isolation না থাকার দাম (অন্যরা মাঝপথ দেখে) চিনতে পারবেন, আর **semantic lock** এর মতো উপায় দিয়ে ঠিক করতে পারবেন কোন ভুলটা সহ্য করবেন

**Tier:** 1 - Runnable Code (Docker এ Postgres - দুটো আলাদা database দুটো "service"; Postgres এর আসল `PREPARE TRANSACTION` দিয়ে 2PC, আর একটা saga এর orchestrator তার log আর recovery সহ)

---

## ০. TaskFlow এখন কোথায়

Lesson 9.1 এ সিদ্ধান্ত ছিল: billing এখন বের হবে না - কারণ "task তৈরি" আর usage বাড়ানো একই transaction এ। Lesson 9.2 এ সামনে gateway আর BFF বসল। এর মধ্যে TaskFlow Stripe দিয়ে card এ payment নেওয়া শুরু করল, আর প্রথম বড় customer চাইল একটা security audit এর রিপোর্ট। তিনটা ঘটনা:

1. **Audit।** Auditor এর শর্ত: billing এর data (card এর token, invoice, payment) আলাদা database এ, আলাদা access এ - web app এর database user যেন সেটা ছুঁতেই না পারে; billing এর code এর নিজের review আর নিজের deploy। Billing কে বের করতেই হচ্ছে। 9.1 এ যেটা আটকে দিয়েছিল - ভাগ করা transaction - তার উত্তর এখন লাগবে।
2. **Staging এর এক সপ্তাহ।** Billing আলাদা database এ, 9.1 এর মতো দুটো আলাদা লেখা দিয়ে। Finance এর report: free plan এর সীমা ১০০ task, অথচ কয়েকটা workspace এ ১০৩টা; আর কয়েকটায় বিলে task এর সংখ্যা আসল task এর চেয়ে বেশি। কারণ দুটো: deploy এর সময় মাঝপথে মরা request, আর "project archived" এ ব্যর্থ হওয়া task - যাদের usage আগেই বেড়ে গিয়েছিল।
3. **Plan upgrade।** একজন customer এর card থেকে টাকা কাটা হলো, কিন্তু workspace pro তে উঠল না - charge এর ঠিক পরে billing service restart হয়েছিল। Support ticket: "টাকা নিলেন, কিছুই পেলাম না।" একজন engineer হাতে refund করল।

Team এ দুটো প্রস্তাব। একজন, যার DBA এর অভিজ্ঞতা আছে: "Postgres এ two-phase commit আছে - `PREPARE TRANSACTION`। দুটো database কে এক transaction এ বাঁধি, সমস্যা শেষ।" আরেকজন: "Microservices এ এর উত্তর saga - প্রতিটা ধাপ আলাদা commit, ব্যর্থ হলে উল্টো কাজ।" CTO: "দুটোই মাপুন - 9.1 এর সেই একই ৩০০০টা operation, সেই একই ৮৩টা crash দিয়ে।"

---

## ১. Theory

### ১.১ কী চাই, আর কেন সেটা সহজ না

Lesson 9.1 এর ফল মনে করুন: ৩০০০টা "task তৈরি", ৮৩টায় প্রথম লেখার পরে crash। এক database এ একটা transaction - অমিল ০। দুটো database এ দুটো লেখা - ৮৩টা অমিল, আর কোন দিকে সেটা লেখার ক্রম ঠিক করে।

আমরা চাই Lesson 5.5 এর **atomicity** - দুটো লেখা হয় দুটোই হবে, নয়তো কোনোটাই না - কিন্তু এমন দুটো database এ, যাদের প্রতিটা শুধু **নিজের** অংশ commit করতে পারে। কঠিন কেন? Lesson 6.1 এর দুটো সত্য: যে কেউ যেকোনো মুহূর্তে মরতে পারে, আর network এর ওপারে কী ঘটল সেটা নিশ্চিত জানার উপায় নেই (timeout মানে "জানি না", "হয়নি" না)।

এর দুটো পুরনো উত্তর, দুটো উল্টো দর্শন:

- **2PC:** কেউ commit করার আগে সবাই "প্রস্তুত" হয়, তারপর একজন সিদ্ধান্ত দেয়। Atomic - কিন্তু সিদ্ধান্ত না আসা পর্যন্ত সবাই lock ধরে অপেক্ষা করে।
- **Saga:** প্রতিটা ধাপ সাথে সাথে commit, কিছু ভুল হলে আগের ধাপ গুলোর উল্টো কাজ। কেউ অপেক্ষা করে না - কিন্তু মাঝপথটা সবাই দেখতে পায়।

### ১.২ Two-Phase Commit - "সবাই রাজি? তাহলে commit"

**Two-Phase Commit (2PC)** - একটা protocol যেখানে একজন coordinator কয়েকটা participant (database) কে দুই ধাপে একটা সিদ্ধান্তে আনে: phase 1 (prepare) এ প্রতিটা participant নিজের অংশ disk এ পাকা করে বলে "হ্যাঁ, commit করতে পারব" (বা "না"); সবাই হ্যাঁ বললে coordinator commit এর সিদ্ধান্ত নিজের log এ লেখে, আর phase 2 তে সবাইকে জানায়। একজনও না বললে, সবাই rollback।

```
  coordinator (work service)          tasks_svc                  billing_svc
  ──────────────────────────          ─────────                  ───────────
  BEGIN, কাজ ─────────────────────►   INSERT task (lock ধরা)     UPDATE counter (lock ধরা)

  phase 1: "PREPARE?" ─────────────►  disk এ পাকা → "হ্যাঁ"       disk এ পাকা → "হ্যাঁ"
           ◄──────────── দুটো "হ্যাঁ" ────────────

  সিদ্ধান্ত: নিজের log এ "commit"    ◄── এই লেখাটাই পুরো transaction এর commit এর মুহূর্ত

  phase 2: "COMMIT" ───────────────►  commit, lock ছাড়ে          commit, lock ছাড়ে
```

মূল কথাটা "prepare" শব্দে। Participant প্রতিশ্রুতি দেয়: "আমি commit করতে পারব - এমনকি এখন মরে গিয়ে আবার চালু হলেও।" সেজন্য নিজের অংশ disk এ লেখে। আর এর বিনিময়ে সে নিজের স্বাধীনতা ছেড়ে দেয়: এখন থেকে সে নিজে থেকে rollback ও করতে পারে না, commit ও না - শুধু coordinator এর কথায়।

Postgres এ এটা আসলেই আছে - exercise এর coordinator এর মূল অংশ:

```typescript
// exercises/lesson-9.3-saga-2pc/src/twopc.ts - the coordinator (abridged)
await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
await a.query(insertTask, [op.workspaceId, op.title]); // tasks_svc - holds the locks, no commit
await b.query(bumpCounter, [op.workspaceId]); // billing_svc - holds the locks, no commit
// phase 1 - after this neither database can decide on its own anymore
await Promise.all([
	a.query(`PREPARE TRANSACTION '${gid}:tasks'`),
	b.query(`PREPARE TRANSACTION '${gid}:billing'`)
]);
// the decision - in the coordinator's own log
await a.query('INSERT INTO twopc_log (gid, decision) VALUES ($1, $2)', [gid, 'commit']);
// phase 2
await Promise.all([
	a.query(`COMMIT PREPARED '${gid}:tasks'`),
	b.query(`COMMIT PREPARED '${gid}:billing'`)
]);
```

(`PREPARE TRANSACTION` Postgres এ default এ বন্ধ - `max_prepared_transactions = 0`। Postgres এর documentation নিজেই বলে এটা application এর জন্য না, একটা বাইরের "transaction manager" এর জন্য। Java এর দুনিয়ায় এর standard এর নাম **XA**; MySQL এও XA আছে।)

Exercise এর `npm run twopc`, অংশ ক - 9.1 এর একই ৩০০০টা operation, একই ৮৩টা crash:

```
── A. 3000 "create task", 100 workspaces, crash after the first write in 83 (3%), 8 concurrent ──
   path                                     ok failed    tasks  counter   bad ws   result                  ops/s      p50
   monolith: one transaction (9.1)        2917     83     2917     2917        0   they match               2775   2.3 ms
   services: two separate writes (9.1)    2917     83     3000     2917       57   83 tasks with no bill    1594   4.4 ms
   services: 2PC                          2917     83     2917     2917        0   they match               1027   7.1 ms
```

- **2PC এ অমিল ০।** Coordinator PREPARE এর আগে মরলে তার connection কেটে যায়, আর দুটো database নিজে থেকেই তাদের অর্ধেক কাজ rollback করে - monolith এর মতোই। DBA ঠিক বলেছিল: 2PC সত্যিই atomic।
- **দাম:** monolith এর ২৭৭৫ এর জায়গায় ১০২৭ ops/s, p50 ২.৩ থেকে ৭.১ ms - দুটো আলাদা লেখার চেয়েও ধীর। কারণ গুনে দেখুন: coordinator এর দিক থেকে ৬–৭টা ধারাবাহিক round trip, আর **পাঁচটা** লেখা যেগুলো disk এ পাকা হওয়ার অপেক্ষা করে (দুটো PREPARE, log, দুটো COMMIT PREPARED) - monolith এ একটা। আর পুরো সময়টা দুটো database এর row এর lock ধরা থাকে - সবচেয়ে ধীর participant এর গতিতে। (সময়ের সংখ্যা run ভেদে ওঠানামা করে - monolith কয়েক run এ ১৯৭৩–৩৬৬৬ ops/s; 2PC সবসময় সবার নিচে।)

দাম দেওয়া যেত। আসল সমস্যা অন্য জায়গায়।

### ১.৩ 2PC এর দুর্বলতা - coordinator মরলে

Coordinator যদি মরে **PREPARE এর পরে, COMMIT এর আগে**?

**In-doubt Transaction** - যে transaction একটা participant এ prepare হয়ে গেছে কিন্তু coordinator এর সিদ্ধান্ত (commit নাকি rollback) এখনো পৌঁছায়নি। Participant নিজে সিদ্ধান্ত নিতে পারে না (সে প্রতিশ্রুতি দিয়েছে), তাই lock ধরে অপেক্ষা করে - যতক্ষণ না coordinator ফেরে। এই কারণে 2PC কে বলা হয় একটা **blocking** protocol।

অংশ খ: ৫টা workspace এর transaction in doubt (১০০টার মধ্যে), তারপর ৮ জন client ৩ সেকেন্ড ধরে নতুন task বানাচ্ছে:

```
── B. The coordinator died after PREPARE, before COMMIT - 5 workspaces' transactions "in doubt" ──
   left prepared: 5 in tasks_svc, 5 in billing_svc · "commit" in the coordinator's log: 2
   reading workspace 1's task_count (SELECT): 0 - 0.4 ms, not blocked (MVCC: the committed old value)
   then 8 clients creating new tasks for 3 s (2PC, random among 100 workspaces):
   billing's lock_timeout       ok   ops/s    lock fails       p99       stuck at end   all stuck at
   none (Postgres default)      90      30             0   23.9 ms              8 / 8   at 156.8 ms
   200 ms                     1348     449            57  317.8 ms              0 / 8   -
```

- **পড়া আটকায় না** - Lesson 5.3/5.5 এর MVCC: SELECT commit হওয়া পুরনো মান দেখে। আটকায় **লেখা**।
- **`lock_timeout` ছাড়া: ১৫৭ ms এর মধ্যে ৮ জনের ৮ জনই আটকে গেল।** প্রতিটা client random workspace এ কাজ করে; ৫% সম্ভাবনায় সে এমন একটা workspace পায় যার counter এর row একটা in-doubt transaction ধরে রেখেছে - আর সেখানে চিরকাল অপেক্ষা। তিন সেকেন্ডে মোট ৯০টা task, তারপর শূন্য। বাকি ৯৫টা workspace এর কোনো দোষ নেই, তবু তাদের কাজও থামল - কারণ সব client আটকে আছে। README এর experiment ১: মাত্র **একটা** in-doubt transaction (১০০ এর মধ্যে ১) - ৮০৬ ms এ সবাই আটকে। Lesson 7.1 এর cascading failure, এবার lock এর ভেতর দিয়ে।
- **`lock_timeout` 200 ms:** কেউ চিরকাল আটকায় না, কিন্তু ৫% request ব্যর্থ, আর p99 ৩১৮ ms - ২০০ না, কারণ `lock_timeout` প্রতিটা lock এর অপেক্ষায় আলাদা করে গোনা হয়: একই workspace এ দুজন লাইনে দাঁড়ালে দ্বিতীয়জন প্রায় দুবার অপেক্ষা করে। Timeout ক্ষতিটা সীমিত করে - in-doubt transaction গুলো কিন্তু তখনো পড়ে আছে।

তাহলে billing নিজে কেন সিদ্ধান্ত নেয় না? অংশ গ:

```
── C. What next: deciding the in-doubt transactions ──
   who decided                                  tasks_svc              billing_svc            bad ws   result
   coordinator, from its log (none → rollback)  commit 2 · rollback 3  commit 2 · rollback 3       0   they match
   billing rolled back alone, then coordinator  commit 2 · rollback 3  commit 0 · rollback 5       2   2 tasks with no bill
```

- **Coordinator ফিরে এসে log পড়ে:** যেগুলোর "commit" log এ আছে (২টা) - commit; যেগুলোর নেই (৩টা) - rollback, কারণ log এ না থাকা মানে commit এর সিদ্ধান্ত কখনো হয়নি (এই নিয়মের নাম "presumed abort")। অমিল ০।
- **Billing অপেক্ষা না করে নিজে rollback করল:** যে ২টার সিদ্ধান্ত ছিল commit, tasks সেগুলো commit করল - billing এ নেই। ২টা অমিল। Billing এর জানার উপায় ছিল না: coordinator হয়তো মরার আগে commit লিখে tasks কে জানিয়েও দিয়েছিল। (বাণিজ্যিক database এ এর নাম "heuristic decision" - আর এর ফল ঠিক করার দায়িত্ব মানুষের।)

**Spaced repetition এর উত্তর:** Raft এ leader মরলে বাকিরা নতুন leader বাছে - **বেশিরভাগের** (৫ এর মধ্যে ৩) সম্মতিতে, আর cluster চলতে থাকে। 2PC তে দুটোই উল্টো: commit এর জন্য **সবার** "হ্যাঁ" লাগে, আর সিদ্ধান্ত জানে শুধু **একজন** - coordinator; তার জায়গায় কেউ দাঁড়াতে পারে না। তাই সমাধানও এসেছে consensus থেকে: Jim Gray আর Leslie Lamport এর 2006 এর "Paxos Commit" - coordinator এর সিদ্ধান্তটা Paxos দিয়ে কয়েকটা node এ রাখা, যাতে একজন মরলেও সিদ্ধান্ত হারায় না। (3PC - three-phase commit - আরেকটা পুরনো চেষ্টা, কিন্তু সেটা ধরে নেয় network এর দেরির একটা সীমা আছে, যা বাস্তবে সত্য না - Lesson 6.1।)

**2PC মরেনি - database এর ভেতরে চলে গেছে।** Google Spanner, CockroachDB, YugabyteDB কয়েকটা shard জুড়ে transaction চালাতে 2PC (বা তার একটা রূপ) ব্যবহার করে - কিন্তু সেখানে প্রতিটা participant আর coordinator নিজেই একটা Raft/Paxos group। Coordinator "মরা" মানে একটা leader বদল - সিদ্ধান্ত হারায় না, blocking প্রায় থাকে না। Kafka এর transaction ও ভেতরে 2PC এর মতো - কিন্তু শুধু Kafka এর partition গুলোর মধ্যে।

**তাহলে TaskFlow এর service গুলোর মাঝে কেন না?**

- **Blocking** - এইমাত্র দেখলে। আর Postgres এর documentation এর সতর্কবাণী: prepared transaction দীর্ঘ সময় পড়ে থাকলে VACUUM পুরনো row পরিষ্কার করতে পারে না, আর চরম ক্ষেত্রে database নিজেকে বন্ধ করে দেয় (transaction ID wraparound থেকে বাঁচতে)।
- **সবাইকে একসাথে জীবিত থাকতে হয়** - Lesson 9.1 এর availability এর গুণ, এবার প্রতিটা লেখায়।
- **বাইরের system গুলো PREPARE বোঝে না।** ঘটনা ৩ এর Stripe এর charge, একটা email, অন্য কোম্পানির API - কোনোটাকে "প্রস্তুত হোন, পরে বলব" বলা যায় না। Redis, বেশিরভাগ message broker, অনেক managed database এও XA নেই।
- **Lock সীমানা পার হয়।** Work service এর coordinator billing এর row এর lock ধরে রাখে - 9.1 এ ঠিক যে জড়ানো থেকে বাঁচতে service আলাদা করা হচ্ছিল।

নিয়ম: 2PC যদি একটা database এর **ভেতরে** পান (নিজের replicated coordinator সহ) - ব্যবহার করুন, আপনি টেরও পাবেন না। নিজের service গুলোর মাঝে নিজে বানাবেন না।

### ১.৪ Saga - ছোট ছোট commit, আর উল্টো কাজ

**Saga** - একটা বড় ব্যবসায়িক transaction কে কয়েকটা ধাপে ভাগ করা, যেখানে প্রতিটা ধাপ একটা service এর নিজের database এ একটা সাধারণ local transaction (সাথে সাথে commit); কোনো ধাপ ব্যর্থ হলে আগের সফল ধাপ গুলোর উল্টো কাজ, উল্টো ক্রমে। (Hector Garcia-Molina আর Kenneth Salem, 1987 - মূলত একটা database এর ভেতরে লম্বা transaction এর lock এড়াতে; microservices এ ধারণাটা নতুন করে জনপ্রিয় হয়েছে।)

**Compensating Transaction** - একটা commit হয়ে যাওয়া ধাপের ব্যবসায়িক উল্টো কাজ। এটা rollback না (commit এর পরে সেটা আর সম্ভব না) - একটা **নতুন** লেখা যেটা প্রভাবটা বাতিল করে: সংরক্ষণ ফেরত, charge এর refund, "আগের email টা ভুল ছিল" এর email।

TaskFlow এর "task তৈরি" এর saga:

```
  ধাপ                  local transaction (কার database)              ব্যর্থ হলে উল্টো কাজ
  ───                  ───────────────────────────────              ───────────────────
  ১. usage সংরক্ষণ     billing: task_count + 1, যদি সীমার মধ্যে      billing: task_count − 1 (release)
                       (না হলে "সীমা শেষ" - saga শেষ, কিছু ফেরাতে হয় না)
  ২. task তৈরি         work: INSERT task                             - (শেষ ধাপ)

  সুখের পথ:           [১ ✓] ──► [২ ✓] ──► শেষ
  project archived:   [১ ✓] ──► [২ ✗] ──► [১ এর উল্টো] ──► শেষ ("ফেরানো")
```

**কোন ধাপ আগে?** যে ধাপ ব্যবসার কারণে "না" বলতে পারে (সীমা শেষ, card declined) আর যার উল্টো কাজ সস্তা - আগে। যার উল্টো করা যায় না - যত পরে সম্ভব। এখানে সংরক্ষণ আগে, কারণ "সীমা শেষ" সবচেয়ে সম্ভাব্য না; আর task আগে বানিয়ে পরে মুছলে user সেটা এক মুহূর্ত দেখে ফেলতে পারে, notification চলে যেতে পারে।

**Pivot Transaction** - saga এর সেই ধাপ যেটা সফল হলে আর ফেরার পথ নেই (উল্টো করা যায় না, বা খুব দামি)। তার আগের ধাপ গুলো compensate করা যায়; পরের গুলো শুধু সামনে এগোতে পারে - তাই পরের ধাপ গুলো এমন হতে হবে যেগুলো retry করলে শেষমেশ সফল হবেই।

ঘটনা ৩ এর plan upgrade, saga হিসেবে:

```
  ১. billing: subscription 'pending' তৈরি            উল্টো: 'cancelled'
  ২. Stripe: card charge (Idempotency-Key = saga id)  ◄── pivot: টাকা কাটা হলো - এখান থেকে শুধু সামনে
  ৩. billing: subscription 'active'                   retry - ব্যবসার কারণে ব্যর্থ হবে না, শুধু দেরি হতে পারে
  ৪. identity: workspace এর plan = pro, সীমা বাড়ানো    retry
  ৫. notifications: রসিদের email (event)              retry
```

ঘটনা ৩ এ আসলে কী হয়েছিল: pivot সফল, তারপর crash - আর ধাপ ৩–৪ কেউ আর চালায়নি। দরকার ছিল refund না (সেটা compensation - pivot এর পরে ভুল দিক); দরকার ছিল কেউ একজন যে জানে "এই saga ধাপ ২ পর্যন্ত গেছে" আর বাকিটা শেষ করে। সেটাই ১.৫। আর card declined হলে (ধাপ ২ ব্যর্থ) - শুধু ধাপ ১ এর উল্টো।

Compensation এর তিনটা সূক্ষ্মতা:

- **উল্টো কাজ ≠ undo।** Refund এ card এর fee ফেরত আসে না; পাঠানো email ফেরানো যায় না - তাই email সবসময় শেষে (pivot এর পরে)।
- **Compensation নিজেও ব্যর্থ হতে পারে** - billing তখন বন্ধ। তাই retry, idempotent, আর বারবার ব্যর্থ হলে শেষে মানুষের হাতে (Lesson 7.4 এর DLQ)।
- **Compensation ব্যবসার কারণে "না" বলতে পারবে না** - এমনভাবে design করুন। "Release" কখনো "না" বলে না; "refund" এর ও বলা উচিত না।

### ১.৫ Saga কে crash থেকে বাঁচানো - log, recovery, idempotency

Saga এর প্রতিটা ধাপ আলাদা commit - তাহলে orchestrator মাঝপথে মরলে? Exercise এর `npm run saga`, অংশ ক - একই ৮৩টা crash (এবার billing এ লেখার পরে, orchestrator এর log এ লেখার আগে - সবচেয়ে খারাপ মুহূর্ত), আর ৪৪টা operation যাদের project archived:

```
── A. 3000 "create task" - crash after writing to billing in 83 (3%), 44 with an archived project, 8 concurrent ──
   path                                       done  archived  crash   pending    tasks  counter   bad ws   result                  ops/s      p50
   two writes, no saga                        2873        44     83         -     2873     3000       58   127 bills with no task   1979   3.9 ms
   saga (idempotent steps)                    2873        44     83        83     2873     2956       57   83 bills with no task     966   7.9 ms
     … recovery from the log (234.1 ms)       2955        45      -         0     2955     2955        0   they match                  -        -
   saga, steps not idempotent                 2873        44     83        83     2873     2956       57   83 bills with no task     992   7.7 ms
     … recovery from the log (282.5 ms)       2955        45      -         0     2955     3038       57   83 bills with no task       -        -
```

- **Saga ছাড়া:** ১২৭টা বিল যার task নেই - ৮৩টা crash আর ৪৪টা archived। Archived গুলোর জন্য কোনো উল্টো কাজ নেই। ঘটনা ২।
- **Saga:** archived এর ৪৪টা ঠিকঠাক ফেরানো। কিন্তু crash এর **ঠিক পরে** saga ও সেই একই ৮৩টা অমিল দেখায় - saga নিজে crash থেকে বাঁচায় না। পার্থক্য একটাই কলামে: **অসমাপ্ত ৮৩** - orchestrator এর log জানে কোন ৮৩টা saga মাঝপথে।
- **Recovery:** orchestrator আবার চালু হয়ে log পড়ে, প্রতিটা অসমাপ্ত saga কে যেখানে ছিল সেখান থেকে এগিয়ে নেয় - ২৩৪ ms এ অমিল ০। (Archived ৪৪ থেকে ৪৫: ৮৩টা crash এর একটার project ও archived ছিল - recovery সেটাকে ফেরাল।) Saga মানে **শেষমেশ** মেলে - সবসময় মেলে না।
- **ধাপ idempotent না হলে:** recovery এর পরেও ৮৩টা বাড়তি বিল - recovery **নিজেই** সেগুলো বানাল। কেন: log এ saga টা 'started' - billing এ লেখা হয়েছিল কিনা orchestrator জানে না (Lesson 6.1: উত্তর আসার আগে মরলে "হয়েছে" আর "হয়নি" আলাদা করা যায় না)। তাই আবার ডাকতেই হয়। ধাপ idempotent হলে দ্বিতীয় ডাক আগের উত্তরটা ফেরত দেয়; না হলে দুবার গোনে।

Idempotent রূপটা billing এর নিজের খাতা দিয়ে - saga এর id ধরে (Lesson 2.5 এর idempotency key, 7.4 এর idempotent consumer - এবার saga এর প্রতিটা ধাপে আর প্রতিটা উল্টো কাজে):

```typescript
// billing service - step 1 (abridged, inside one local transaction)
const prev = await c.query('SELECT status FROM reservations WHERE saga_id = $1', [sagaId]);
if (prev.rows[0] !== undefined) return previousAnswer(prev.rows[0]); // already done - don't count it again
const r = await c.query(
	'UPDATE workspaces SET task_count = task_count + 1 WHERE id = $1 AND task_count < task_limit RETURNING id',
	[workspaceId]
);
const status = r.rowCount === 1 ? 'reserved' : 'rejected';
await c.query('INSERT INTO reservations (saga_id, workspace_id, status) VALUES ($1, $2, $3)', [
	sagaId,
	workspaceId,
	status
]);

// the reverse action - only from 'reserved' to 'released'; called twice, it decreases once
// WITH r AS (UPDATE reservations SET status = 'released' WHERE saga_id = $1 AND status = 'reserved' RETURNING workspace_id)
// UPDATE workspaces w SET task_count = task_count - 1 FROM r WHERE w.id = r.workspace_id
```

আর orchestrator - saga এর অবস্থা একটা ছোট state machine, work service এর নিজের database এর `sagas` table এ:

```
  started ──reserve ✓──► reserved ──task ✓──► done
     │                      │
     └─reserve "না"─► rejected    └─archived─► compensating ──release──► compensated
```

নিয়ম গুলো:

- **আগে log, তারপর কাজ।** Saga শুরুর আগে `started`; উল্টো কাজের আগে `compensating`। তাহলে যেকোনো মুহূর্তে মরলেও recovery জানে কোথা থেকে ধরতে হবে।
- **নিজের ধাপ আর log একই local transaction এ।** Work এর ধাপ (task তৈরি) আর `state = 'done'` এক transaction এ - কারণ দুটোই work এর database এ। অন্য service এর ধাপ আর নিজের log এক transaction এ হতে পারে না - সেজন্যই idempotency আর recovery।
- **Recovery = pivot এর আগে হলে এগোন বা ফেরান, পরে হলে শুধু এগোন।** Exercise এর `recover()` প্রতিটা অসমাপ্ত saga কে একই `advance()` দিয়ে চালায় - নতুন saga আর recovery একই code।
- **অন্য service কে বার্তা:** এখানে সরাসরি call। Event দিয়ে করলে Lesson 7.5 এর outbox - "billing কে সংরক্ষণ করতে বলুন" এর বার্তাটা saga এর log এর সাথে একই transaction এ, relay পরে পাঠায়, at-least-once - তাই গ্রাহকের দিকে আবার idempotency।

**দাম:** saga এর ops/s ৯৬৬, দুটো আলাদা লেখার ১৯৭৯ এর অর্ধেক - log এর লেখা, খাতার লেখা, আরও round trip। Idempotency ও বিনামূল্যে না: idempotent না রূপটা (৯৯২) সামান্য দ্রুত। আর `twopc` এর 2PC (১০২৭) এর চেয়েও দ্রুত না - যদিও দুটো আলাদা script, আলাদা কাজ (saga তে সীমা দেখা আর archived দেখা আছে), তাই সরাসরি তুলনা করা যায় না। Saga এর লাভ **গতি না**। লাভ হলো: কেউ কারো lock ধরে অপেক্ষা করে না। Billing এক ঘণ্টা বন্ধ থাকলে work এর কোনো row আটকে থাকে না - saga গুলো তাদের log এ জমে থাকে, billing ফিরলে এগোয়।

### ১.৬ কে চালায় - Orchestration বনাম Choreography

**Orchestration / Choreography** - Orchestration: একটা কেন্দ্রীয় orchestrator saga এর অবস্থা রাখে আর প্রতিটা service কে বলে কী করতে হবে (command), উত্তর নিয়ে পরের ধাপ ঠিক করে। Choreography: কোনো কেন্দ্র নেই - প্রতিটা service একটা event শুনে নিজের ধাপ করে, আর পরের event ছাড়ে (Lesson 7.5 এর event-driven)।

```
  orchestration                                  choreography
  ─────────────                                  ────────────
       ┌─ orchestrator (work) ─┐                 work ──task.requested──► billing
       │ sagas table: অবস্থা   │                   ▲                         │
       └──┬──────────────┬─────┘                   │               quota.reserved / quota.rejected
   "reserve" │      │ "release"                    │                         │
          ▼         ▼                              └─────────────────────────┘
       billing    work (নিজের ধাপ)               work ──task.failed──► billing (release)
   saga কোথায়? - একটা table এ দেখুন               saga কোথায়? - সব service এর log জোড়া দিয়ে বুঝুন
```

|                | Orchestration                                          | Choreography                                                           |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Flow কোথায়    | এক জায়গায়, code এ পড়া যায়                          | কোথাও লেখা নেই - প্রতিটা service এর listener এ ছড়ানো                  |
| "Saga কোথায়?" | একটা query                                             | সব service এর event জোড়া দিয়ে (Lesson 10.4 এর tracing)               |
| Timeout, retry | Orchestrator দেখে - "১০ মিনিট ধরে reserved"            | কে দেখবে? প্রায়ই কেউ না                                               |
| Coupling       | Orchestrator সব service কে চেনে                        | Service গুলো শুধু event চেনে - শুরুতে কম; ধাপ বাড়লে event এর জট, চক্র |
| ঝুঁকি          | Orchestrator এ ব্যবসার নিয়ম জমা ("smart pipe", 9.2)   | নতুন ধাপ যোগ করলে কেউ ভুলে যায় কোন event এ compensation লাগবে         |
| কখন            | ৩+ ধাপ, compensation, timeout, "কোথায় আটকে" এর প্রশ্ন | ২–৩ ধাপ, একমুখী, compensation প্রায় নেই                               |

বাস্তবে বড় orchestration এর জন্য তৈরি tool আছে - **durable workflow engine** (Temporal, AWS Step Functions, Camunda): আপনি saga টা সাধারণ code এর মতো লিখুন, আর engine প্রতিটা ধাপের log রাখে, crash এর পরে ঠিক সেখান থেকে চালায়, retry আর timeout সামলায়। Exercise এর `sagas` table আর `recover()` তার খুব ছোট একটা রূপ।

### ১.৭ Saga এর ফাঁক - isolation নেই

Lesson 5.5 এর ACID এর **I** - isolation: একটা transaction এর মাঝপথ অন্যরা দেখে না। Saga তে এটা নেই: ধাপ ১ commit হওয়ার সাথে সাথে বাকি সবাই সেটা দেখে - এমনকি যদি পরে সেটা ফেরানো হয়। কোথায় লাগে? সীমার কাছে। অংশ খ: ৫০টা workspace, প্রতিটার সীমা ১০, আগে থেকে ৮টা task (খালি ২টা জায়গা) - আর প্রতিটায় একসাথে ৪টা "task তৈরি", যাদের এক-চতুর্থাংশের project archived:

```
── B. Near the limit: 50 workspaces, limit 10, 8 tasks already - 4 concurrent "create task" in each, 41 with an archived project ──
   rule                                      made  undone     refused  ws over limit       extra  false refusals
   reserve → task → release (saga)             75      25         100              0           0              25
   check → task → count usage at end          159       -           0             42          61               0
```

- **আগে সংরক্ষণ (আমাদের saga):** সীমা কখনো পেরোয় না - প্রতিটা workspace এ ঠিক ২টা সংরক্ষণ, বাকি ১০০টা "সীমা শেষ"। কিন্তু ২৫টা সংরক্ষণ পরে ফেরত গেল (archived) - আর সেই জায়গা গুলোর জন্য যারা আগেই "না" শুনেছে, তারা **ভুল করে** না শুনেছে। মাঝপথের অবস্থা (সংরক্ষিত, কিন্তু task এখনো হয়নি) অন্যদের সিদ্ধান্ত বদলে দিল।
- **আগে দেখা, শেষে গোনা:** চারটা চেষ্টাই একসাথে দেখে "৮ < ১০, জায়গা আছে", চারটাই task বানায় - ৪২টা workspace সীমা পেরোল, ৬১টা বাড়তি task। Lesson 5.5 এর write skew - কিন্তু এবার দুটো database জুড়ে, যেখানে `SERIALIZABLE` বাঁচাতে পারে না। ঘটনা ২ এর "১০৩টা task"। (README এর experiment ৩: ইচ্ছাকৃত দেরি শূন্য করলেও একই ৪২টা - কয়েকটা round trip এর ফাঁকই যথেষ্ট।)

**Semantic Lock** - saga এর মাঝপথের অবস্থাটা data তে একটা স্পষ্ট চিহ্ন হিসেবে রাখা (`pending`, `reserved`), যাতে অন্য transaction জানে এটা এখনো পাকা না আর সেই অনুযায়ী আচরণ করে - অপেক্ষা করে, "একটু পরে" বলে, বা হিসাবে ধরে। Database এর lock না - ব্যবসার নিয়মের lock।

আমাদের `reservations` খাতা ঠিক এটাই। আরও ভালো রূপ (README এর experiment ৫): খাতায় `reserved` (pending) আর `confirmed` আলাদা - সীমা ভরা কিন্তু কোনোটা pending থাকলে "সীমা শেষ" না বলে "একটু পরে আবার চেষ্টা করুন"। Chris Richardson এর "Microservices Patterns" বইয়ে (1998 এর Lars Frank আর Torben Zahle এর একটা paper থেকে) আরও কয়েকটা উপায়ের তালিকা আছে - যেমন **commutative update** (+১ আর −১ যেকোনো ক্রমে একই ফল, তাই ক্রম নিয়ে চিন্তা নেই), আর **reread value** (শেষ ধাপের আগে আবার পড়ে দেখা কিছু বদলেছে কিনা - Lesson 5.5 এর optimistic lock)।

বাস্তবের সবচেয়ে পরিচিত semantic lock: **card এর authorization hold**। Hotel check-in এর সময় আপনার card এ টাকা "ধরে রাখে" (authorize) - কাটে না; check-out এ আসল অঙ্কটা কাটে (capture), বাকিটা ছেড়ে দেয় (void)। মাঝের সময়টা আপনার ব্যাংকের কাছে "pending" - আর সেটা অন্য খরচের সীমা কমিয়ে দেয়, ঠিক আমাদের সংরক্ষণের মতো। আর hold এর একটা মেয়াদ আছে - ধরে রাখা জিনিস চিরকাল ধরে রাখা যায় না।

কোন ভুলটা সহ্য করবেন - সেটা engineering এর না, **ব্যবসার** সিদ্ধান্ত। TaskFlow এর free plan এ সীমা ২টা পেরোনো হয়তো কেউ খেয়ালও করবে না (অনেক SaaS এর সীমা ইচ্ছা করেই "নরম"); ব্যাংকের account এ overdraft কখনো চলবে না।

### ১.৮ TaskFlow এর সিদ্ধান্ত

- **2PC না।** Service গুলোর মাঝে blocking, Stripe ঢোকানো যায় না, আর billing এর lock work এর হাতে। (TaskFlow কখনো distributed database এ গেলে, তার ভেতরের 2PC আমাদের চোখের আড়ালে কাজ করবে - সেটা আলাদা কথা।)
- **Billing বের হবে** - নিজের database, নিজের deploy (audit এর শর্ত)।
- **"Task তৈরি" = orchestrated saga**, orchestrator work service এ: billing এ সংরক্ষণ (saga id ধরে idempotent) → task তৈরি (সাথে `done`, একই transaction এ) → archived হলে release। `sagas` table work এর database এ; একটা recovery job প্রতি কয়েক সেকেন্ডে ৩০ s এর বেশি পুরনো অসমাপ্ত saga গুলো এগোয়; compensation বারবার ব্যর্থ হলে alert আর মানুষের queue। Billing এর call synchronous (user অপেক্ষা করছে - 9.2 এর নিয়ম), timeout সহ; timeout এ user কে error - আর user এর request এর Idempotency-Key ই saga এর id, তাই "আবার চেষ্টা" নতুন saga বানায় না, পুরনোটার ফল দেখায় (9.1 এর duplicate এর সমাধান)।
- **সীমা:** আগে সংরক্ষণ (semantic lock) - কখনো পেরোবে না; pending থাকলে "একটু পরে আবার চেষ্টা করুন", পুরো ভরা হলে "সীমা শেষ"।
- **Plan upgrade = saga with pivot:** pending subscription → Stripe charge (Idempotency-Key = saga id, তাই retry তে দুবার কাটে না) → active → plan বাড়ানো → রসিদ। Pivot এর পরের ধাপ গুলো শুধু retry। ঘটনা ৩ আর হবে না - recovery নিজেই শেষ করবে। ধাপ বাড়লে একটা durable workflow engine (যেমন Temporal) বিবেচনা।
- **মাসের বিলের জন্য usage গোনা** (কত task, কত storage) - saga লাগে না: এখানে কেউ "না" বলে না, তাই outbox → event (Lesson 7.5) যথেষ্ট, eventual।
- **রাতে একটা reconcile job** (9.1 এর experiment ৫): work এর task গোনা বনাম billing এর counter - অমিল হলে alert। কারণ saga ঠিক থাকলেও code এ bug থাকবে।

> **Trade-off Table - দুটো database জুড়ে একটা ব্যবসার কাজ**

| উপায়                       | Atomic?                                    | Isolation                     | কিছু মরলে                                               | দাম (মাপা)                                         | কখন                                                                            |
| --------------------------- | ------------------------------------------ | ----------------------------- | ------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| এক database, এক transaction | হ্যাঁ                                      | হ্যাঁ (5.5)                   | সব rollback                                             | সবচেয়ে সস্তা (২৭৭৫ ops/s)                         | যতদিন সম্ভব - modular monolith (9.1)                                           |
| 2PC (XA, `PREPARE`)         | হ্যাঁ                                      | হ্যাঁ - lock দিয়ে            | Coordinator মরলে in doubt - lock ধরা, সবাই আটকায়       | ১০২৭ ops/s; ৫টা in doubt এ ১৫৭ ms এ সব client আটকে | একটা database system এর ভেতরে (Spanner) - নিজের service এর মাঝে প্রায় কখনো না |
| Saga - orchestration        | শেষমেশ (compensation দিয়ে)                | না - semantic lock দিয়ে পূরণ | Log থেকে recovery; ধাপ idempotent না হলে দ্বিগুণ        | ৯৬৬ ops/s; recovery এর আগে অমিল দেখা যায়          | কয়েকটা ধাপ, "না" বলতে পারা ধাপ, বাইরের API - **TaskFlow**                     |
| Saga - choreography         | শেষমেশ                                     | না                            | প্রতিটা service এর নিজের retry; saga কোথায়, খোঁজা কঠিন | Orchestration এর কাছাকাছি, flow ছড়ানো             | ২–৩টা ধাপ, একমুখী, compensation প্রায় নেই                                     |
| শুধু outbox → event (7.5)   | শেষমেশ - কিন্তু পরের ধাপ "না" বলতে পারে না | না                            | Event জমে থাকে, পরে পৌঁছায়                             | এক local transaction + পরে event                   | পরের ধাপ কখনো প্রত্যাখ্যান করে না - usage গোনা, search index, notification     |

---

## ২. Interview Angle

**যেকোনো "টাকা আর জিনিস" এর design প্রশ্নে** (e-commerce checkout, hotel বা flight booking, Uber এর ride, payment system - Lesson 11.7) একটা মুহূর্ত আসে: order, inventory, payment আলাদা service - "কীভাবে নিশ্চিত করবেন সব একসাথে হয়?" দুর্বল উত্তর: "distributed transaction দিয়ে" বা "2PC"। ভালো উত্তর: একটা saga - ধাপ গুলোর ক্রম, প্রতিটার compensation, কোনটা pivot (প্রায় সবসময় payment), প্রতিটা ধাপ idempotency key সহ (Stripe এর মতো API এর নিজের idempotency key ও), orchestration কেন, আর isolation এর সমস্যা - শেষ জিনিসটা দুজন একসাথে কিনলে কী হয় (inventory reservation = semantic lock, মেয়াদ সহ)।

**"2PC কেন ব্যবহার করবেন না?"** - Blocking (coordinator PREPARE এর পরে মরলে participant lock ধরে অপেক্ষা করে - নিজে সিদ্ধান্ত নিলে অমিল), coordinator একা (Raft এর মতো majority না), সবাইকে একসাথে জীবিত থাকতে হয় (availability এর গুণ), আর বাইরের API গুলো এতে ঢোকে না। বোনাস: Spanner/CockroachDB 2PC ব্যবহার করে - কারণ তাদের coordinator নিজেই consensus দিয়ে replicated।

**"Compensation ব্যর্থ হলে?"** - Retry (idempotent বলে নিরাপদ), backoff, বারবার ব্যর্থ হলে DLQ আর মানুষ (7.4); আর আগে থেকেই compensation এমনভাবে design করা যাতে ব্যবসার কারণে "না" বলতে না পারে।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনা: saga মাঝপথে আটকে থাকে কারণ কোনো recovery job নেই ("pending" order মাসের পর মাস); retry তে একই card দুবার কাটা (idempotency key নেই - ঘটনা ৩ এর উল্টো রূপ); নতুন একটা ধাপ যোগ হলো কিন্তু তার compensation কেউ লিখল না; choreography তে দুটো service একে অপরের event এ অনন্ত চক্র; আর reservation এর মেয়াদ নেই - ব্যর্থ checkout এর inventory চিরকাল "সংরক্ষিত", দোকানে জিনিস আছে অথচ কেউ কিনতে পারে না।

---

## ৩. Key Takeaway

- Database per service মানে সীমানা পার হয়ে atomicity নেই - দুটো পুরনো উত্তর: **2PC** (সবাই প্রস্তুত হয়ে অপেক্ষা করে, একজন সিদ্ধান্ত দেয়) আর **saga** (প্রতিটা ধাপ সাথে সাথে commit, ভুল হলে উল্টো কাজ)
- **2PC সত্যিই atomic** - ৮৩টা crash এ অমিল ০; দাম: ১০২৭ বনাম ২৭৭৫ ops/s (পাঁচটা disk এর লেখা, পুরো সময় lock ধরা)
- 2PC এর আসল দুর্বলতা **blocking**: coordinator PREPARE এর পরে মরলে **in-doubt** transaction lock ধরে রাখে - ১০০টার মধ্যে ৫টা in doubt, `lock_timeout` ছাড়া ১৫৭ ms এ সব client আটকে। Participant নিজে সিদ্ধান্ত নিলে অমিল। Raft এর মতো majority নেই - তাই 2PC টিকে আছে শুধু consensus এর উপর বসানো database এর ভেতরে (Spanner)
- **Saga**: ধাপের ক্রম - "না" বলতে পারা আর সস্তায় ফেরানো যায় এমন ধাপ আগে, **pivot** এর পরে শুধু retry করা যায় এমন ধাপ; **compensation** নতুন একটা লেখা, undo না - আর নিজেও retry আর idempotency চায়
- Saga নিজে crash থেকে বাঁচায় না - **log** (আগে log, তারপর কাজ) আর **recovery** বাঁচায়: crash এর পরে ৮৩টা অমিল, recovery এর পরে ০। ধাপ **idempotent** না হলে recovery নিজেই ৮৩টা বাড়তি বিল বানায়
- **Orchestration** (flow এক জায়গায়, saga কোথায় একটা query) বনাম **choreography** (কেন্দ্র নেই, ছোট একমুখী flow এ চলে); বড় হলে durable workflow engine (Temporal, Step Functions)
- Saga এ **isolation নেই** - সীমার কাছে "আগে দেখা" তে ৪২টা workspace সীমা পেরোয়; **semantic lock** (আগে সংরক্ষণ) এ কখনো পেরোয় না কিন্তু ২৫টা ভুল "না"। কোন ভুল সহ্য করবেন - ব্যবসার সিদ্ধান্ত

---

## ৪. নতুন Term (Glossary)

| Term                             | অর্থ                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two-Phase Commit (2PC)**       | Coordinator কয়েকটা participant কে দুই ধাপে এক সিদ্ধান্তে আনে: prepare (প্রত্যেকে নিজের অংশ disk এ পাকা করে "হ্যাঁ/না" বলে), তারপর coordinator এর log এ সিদ্ধান্ত আর সবাইকে commit/rollback |
| **In-doubt Transaction**         | Participant এ prepare হয়ে গেছে কিন্তু coordinator এর সিদ্ধান্ত পৌঁছায়নি - participant নিজে ঠিক করতে পারে না, তাই lock ধরে অপেক্ষা করে; এই কারণে 2PC একটা blocking protocol                |
| **Saga**                         | বড় ব্যবসার কাজ কে কয়েকটা ধাপে ভাগ করা - প্রতিটা ধাপ একটা service এর নিজের local transaction (সাথে সাথে commit); ব্যর্থ হলে আগের ধাপ গুলোর উল্টো কাজ, উল্টো ক্রমে                          |
| **Compensating Transaction**     | Commit হয়ে যাওয়া ধাপের ব্যবসায়িক উল্টো কাজ - rollback না, একটা নতুন লেখা (release, refund); নিজেও idempotent আর retry যোগ্য হতে হয়                                                      |
| **Pivot Transaction**            | Saga এর যে ধাপ সফল হলে আর ফেরা যায় না - তার আগের ধাপ compensate করা যায়, পরের ধাপ শুধু retry করে সামনে এগোয়                                                                              |
| **Orchestration / Choreography** | Orchestration - কেন্দ্রীয় orchestrator saga এর অবস্থা রাখে আর প্রতিটা service কে command দেয়; Choreography - কেন্দ্র নেই, প্রতিটা service event শুনে নিজের ধাপ করে আর পরের event ছাড়ে    |
| **Semantic Lock**                | Saga এর মাঝপথের অবস্থা data তে স্পষ্ট চিহ্ন হিসেবে (`pending`, `reserved`) - যাতে অন্যরা জানে এটা এখনো পাকা না আর সেই অনুযায়ী আচরণ করে; database এর lock না, ব্যবসার নিয়মের lock          |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. একটা online দোকানের checkout: order service (order তৈরি), inventory service (জিনিস সংরক্ষণ), payment (Stripe এ charge), shipping service (courier এর label বানানো - বাইরের API), আর notification (confirmation email)। (ক) Saga এর ধাপ গুলো কোন ক্রমে সাজাবেন, আর কেন? কোনটা pivot? (খ) প্রতিটা ধাপের compensation কী - কোনগুলোর নেই, আর কেন তাতে সমস্যা নেই? (গ) দোকানে একটা জিনিসের শেষ পিসটা - দুজন একসাথে checkout করছে। কী ঘটে, আর inventory এর সংরক্ষণ কীভাবে design করবেন যাতে একটা ব্যর্থ checkout জিনিসটা চিরকাল আটকে না রাখে?
2. DBA এর নতুন প্রস্তাব: "2PC ই রাখি - `lock_timeout` 200 ms দিলে তো আর কেউ আটকায় না, exercise এই দেখিয়েছে।" Exercise এর সংখ্যা দিয়ে বলুন: `lock_timeout` কোন সমস্যাটা সারায় আর কোনটা সারায় না? In-doubt transaction গুলো নিজেরা কতক্ষণ পড়ে থাকে, আর সেই সময় Postgres এর ভেতরে আর কী ক্ষতি হয়? Coordinator এর process টা এমন একটা machine এ চলছিল যেটা আর কখনো ফিরবে না - তখন কী করবেন?
3. আরেকটা team "task তৈরি" এর saga টা choreography দিয়ে বানাল: work ছাড়ে `task.requested` → billing সংরক্ষণ করে `quota.reserved` বা `quota.rejected` ছাড়ে → work task বানিয়ে `task.created` ছাড়ে, বা archived হলে `task.failed` → billing `task.failed` শুনে release করে। (ক) Saga এর অবস্থা এখন কোথায় থাকে? একজন user জিজ্ঞেস করল "আমার task কেন দেখাচ্ছে না?" - উত্তর খুঁজতে কী কী দেখতে হবে? (খ) Billing এক ঘণ্টা বন্ধ - কী হয়, আর user কী দেখে? (গ) পরের মাসে একটা তৃতীয় ধাপ যোগ হলো: "search index এ task যোগ করুন" (search service, `task.created` শুনে)। এটা কি saga এর অংশ? এর compensation লাগবে কি? Orchestration এর সাথে তুলনা করুন।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) একটা যুক্তিসঙ্গত ক্রম:

1. **Order তৈরি** - `pending` অবস্থায় (নিজেই একটা semantic lock - "এই order এখনো পাকা না")। উল্টো: `cancelled`।
2. **Inventory সংরক্ষণ** - "না" বলতে পারে (stock নেই), উল্টো সস্তা (ছেড়ে দেওয়া)। তাই payment এর আগে: stock না থাকলে card ছোঁয়ারই দরকার নেই।
3. **Payment (Stripe charge)** - **pivot**: টাকা কাটা হলে ফেরানো মানে refund - দামি (fee), customer এর চোখে খারাপ, আর কয়েক দিন লাগে। Idempotency-Key = saga/order id, যাতে retry তে দুবার না কাটে। (অনেক দোকান এখানে authorize করে, আর ship হলে capture - pivot কে আরও পিছিয়ে দেওয়া।)
4. **Order `confirmed`**, 5. **Shipping label**, 6. **Email** - সব pivot এর পরে, শুধু retry।

(খ) Compensation: order → cancelled; inventory → release; payment → refund (শুধু যদি pivot এর পরে কিছু একদম অসম্ভব হয়ে যায় - যেমন জিনিসটা গুদামে ভাঙা পাওয়া গেল; তখন এটা আর saga এর স্বাভাবিক পথ না, একটা আলাদা ব্যবসার প্রক্রিয়া)। Shipping label আর email এর compensation নেই - এবং লাগে না, কারণ এরা pivot এর পরে: এরা কখনো "ফেরান" এর অবস্থায় পড়ে না, শুধু "শেষ করুন"। Label এর API ব্যর্থ হলে retry; এক দিন ধরে ব্যর্থ হলে মানুষ। এটাই ক্রম সাজানোর মূল যুক্তি - যেগুলো ফেরানো যায় না সেগুলো pivot এর পরে রাখুন, যাতে ফেরানোর প্রশ্নই না ওঠে।

(গ) দুজন একসাথে: দুজনের saga ই ধাপ ২ এ পৌঁছায়। Inventory এর সংরক্ষণ যদি atomic শর্তে হয় (`UPDATE stock SET reserved = reserved + 1 WHERE available - reserved >= 1` - exercise এর `task_count < task_limit` এর মতো), একজন পায়, আরেকজন "stock নেই" - payment এর আগেই। দ্বিতীয়জনের card ছোঁয়া হয়নি। কিন্তু প্রথমজনের card declined হলে? সংরক্ষণ ফেরত যায় - আর দ্বিতীয়জন ততক্ষণে চলে গেছে (exercise এর "ভুল সীমা শেষ")। সেটা সহ্য করা যায়; উল্টোটা (দুজনের টাকা কাটা, এক পিস জিনিস) করা যায় না।

চিরকাল আটকে না রাখা: সংরক্ষণের একটা **মেয়াদ** - `reserved_until = now() + 15 min`। একটা job মেয়াদ পেরোনো সংরক্ষণ ছেড়ে দেয়; আর saga এর orchestrator যদি পরে (মেয়াদের পরে) payment এ পৌঁছায়, আগে সংরক্ষণটা নবায়ন করে - না পারলে payment এর আগেই ফেরে। Hotel এর card hold এর মতো। Saga এর নিজের ও একটা timeout - ধাপ ২ এ ১৫ মিনিট আটকে থাকলে compensate।

**প্রশ্ন ২:** `lock_timeout` যা সারায়: **নতুন** request গুলো চিরকাল আটকে থাকে না - exercise এ ৮/৮ আটকে থেকে ০/৮, ops/s ৩০ থেকে ৪৪৯। যা সারায় না:

- **In-doubt transaction গুলো নিজেরা** - তারা তখনো পড়ে আছে, lock ধরে। ওই ৫টা workspace এ কেউ task বানাতে পারছে না (৫৭টা ব্যর্থ, আর প্রতিটা ২০০–৪০০ ms অপেক্ষার পরে)। Customer এর চোখে: "ওই workspace এ task বানানো যাচ্ছে না" - coordinator না ফেরা পর্যন্ত।
- **কতক্ষণ পড়ে থাকে:** যতক্ষণ না কেউ COMMIT/ROLLBACK PREPARED চালায় - সীমা নেই। Postgres restart হলেও থাকে (সেজন্যই তো disk এ লেখা)।
- **Postgres এর ভেতরের ক্ষতি:** prepared transaction একটা পুরনো snapshot ধরে রাখে - VACUUM তার পরের মরা row গুলো পরিষ্কার করতে পারে না, table ফুলতে থাকে (Lesson 5.3)। দিনের পর দিন থাকলে transaction ID wraparound এর বিপদ - Postgres শেষে নতুন লেখা বন্ধ করে দেয়। আর `max_prepared_transactions` এর জায়গাও খায়।
- **Coordinator এর machine আর ফিরবে না:** তার log (`twopc_log`) যদি একটা টিকে থাকা database এ থাকে (এখানে tasks_svc এ - machine এর disk এ না), নতুন একটা coordinator process সেই log পড়ে একই recovery চালাতে পারে। Log ও যদি হারায় - কেউ জানে না সিদ্ধান্ত কী ছিল। তখন একজন মানুষ দুই দিকের data দেখে প্রতিটা transaction হাতে ঠিক করে (heuristic), আর অমিল গুলো reconcile করে। এটাই 2PC এর coordinator কে replicated (Paxos Commit, Spanner) করার কারণ।

তাই উত্তর: `lock_timeout` ক্ষতির ব্যাসার্ধ ছোট করে - blocking সরায় না।

**প্রশ্ন ৩:**

(ক) Choreography তে saga এর অবস্থা কোথাও একসাথে নেই - work এর কাছে "requested" আর "created/failed", billing এর কাছে সংরক্ষণ আর release, আর মাঝের অবস্থা stream এর offset এ। "Task কেন দেখাচ্ছে না" এর উত্তর: work এর log এ `task.requested` আছে? Billing সেটা পড়েছে (consumer group এর lag, Lesson 7.2)? `quota.*` ছেড়েছে? Work সেটা পড়েছে? - চারটা জায়গা, দুটো team। Distributed tracing (Lesson 10.4) এর একটা trace id সব event এ থাকলে সহজ হয়; না থাকলে দীর্ঘ সময়। Orchestration এ: `SELECT state FROM sagas WHERE id = …` - এক query।

(খ) Billing বন্ধ: `task.requested` event গুলো stream এ জমে থাকে (7.2) - কিছু হারায় না, কিন্তু কিছু এগোয়ও না। User দেখে task "তৈরি হচ্ছে…" এক ঘণ্টা ধরে - অথবা, UI যদি synchronous উত্তর আশা করে, timeout। Billing ফিরলে জমে থাকা event গুলো একসাথে প্রক্রিয়া হয় (backpressure, 7.4) - আর সেই এক ঘণ্টায় সীমা হয়তো বদলে গেছে। Orchestration এ ও একই মৌলিক সমস্যা (billing ছাড়া সংরক্ষণ হয় না) - কিন্তু orchestrator জানে saga গুলো কতক্ষণ ধরে `started`, আর একটা নীতি প্রয়োগ করতে পারে ("৩০ s এর বেশি হলে user কে error, saga বাতিল")। Choreography তে এই timeout কে দেখবে - সেটা কারো কাজ না, যদি না কেউ আলাদা করে বানায়।

(গ) Search index সাধারণত saga এর অংশ **না** - এটা Lesson 7.5 এর event-carried state / derived কপি: task তৈরি হয়ে গেছে (saga শেষ), তারপর যার দরকার সে শোনে। Compensation লাগে না, কারণ এটা কাউকে "না" বলে না - ব্যর্থ হলে retry, বা পরের reconcile/reindex (8.3)। কিন্তু একটা সূক্ষ্মতা: `task.failed` এর পরে task তৈরি হয়নি - search এর কাছে কিছু যায়নি, ঠিক আছে; আর যদি কখনো task তৈরি হয়ে পরে ফেরানো হয় (অন্য কোনো flow এ), তখন `task.deleted` শুনে index থেকে সরাতে হবে। Choreography এর সুবিধা এখানে দেখা যায়: নতুন শ্রোতা যোগ করতে কাউকে বদলাতে হয়নি। দাম: কেউ একজন একদিন `task.created` এর অর্থ বদলাবে ("এখন draft task এর জন্যও ছাড়ি") - আর সব শ্রোতা নিঃশব্দে ভুল করবে। Orchestration এ এই ধাপ orchestrator এর code এ থাকত - স্পষ্ট, কিন্তু প্রতিটা নতুন ধাপে orchestrator বদলাতে হতো। নিয়ম: যে ধাপ saga এর ফলাফল বদলাতে পারে ("না" বলতে পারে) সেটা orchestration এ; যেটা শুধু ফলাফল জানতে চায় সেটা event এ শোনে।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (Docker এ Postgres 17 - দুটো আলাদা database দুটো "service")

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-9.3-saga-2pc/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.3-saga-2pc) - `npm install`, `docker compose up -d --wait`, তারপর `npm run twopc` আর `npm run saga`। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`twopc` Postgres এর আসল `PREPARE TRANSACTION` দিয়ে দুটো database জুড়ে 2PC চালায় - 9.1 এর একই ৩০০০টা operation আর ৮৩টা crash - তারপর coordinator কে PREPARE এর পরে মেরে in-doubt transaction বানায়, তাদের lock এর উপর ৮ জন client চালায় (`lock_timeout` সহ ও ছাড়া), আর দেখায় coordinator এর log থেকে recovery বনাম একটা participant এর নিজে সিদ্ধান্ত। `saga` একটা orchestrated saga চালায় - billing এ সংরক্ষণ, task তৈরি, archived project এ compensation - crash, log থেকে recovery, idempotent আর idempotent না ধাপ সহ; আর সীমার কাছে একসাথে অনেক saga চালিয়ে "আগে সংরক্ষণ" বনাম "আগে দেখা" এর ভুল গোনে।

**সৎ নোট:** Sandbox এ Node 26 আর Docker এর Postgres 17 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` আর ESLint clean; `twopc` আর `saga` পাঁচবার করে - গোনার কলাম (সফল, অমিল, অসমাপ্ত, আটকে থাকা client, সীমা পেরোনো) হুবহু একই; সময় অনেক ওঠানামা করে (monolith ১৯৭৩–৩৬৬৬ ops/s, 2PC ১০২৭–১১৬৫, "সবাই আটকে গেল" ১৪৭–১৬১ ms); `saga` এর অংশ খ এর saga এর সারিতে "তৈরি" ৭৪–৭৮, "ফেরানো" আর ভুল "সীমা শেষ" ২২–২৬ (কোন দুটো চেষ্টা আগে সংরক্ষণ পায়, সেটা timing)। README এর experiment ১–৩ চালানো হয়েছে, সংখ্যা README তে; ৪ আর ৫ code বদলানোর কাজ - আপনার। দুটো "service" একই Postgres container এর দুটো database - আলাদা machine না, একই disk, network এর দেরি নেই; service এর code একই Node process এ function, network call (9.1, 9.2) এখানে মাপা হয়নি। `twopc` আর `saga` এর ops/s সরাসরি তুলনীয় না - কাজ আলাদা। "Crash" একটা ভান - 2PC তে connection কেটে দেওয়া (Postgres তখন আসল crash এর মতোই rollback করে), saga তে operation থেমে যাওয়া; কিন্তু prepared transaction আর তাদের lock আসল। ১.২ এর coordinator আর ১.৫ এর billing এর code exercise থেকে সংক্ষেপ; ১.৪ এর plan upgrade এর saga আর ১.৮ এর সিদ্ধান্ত একটা নকশা, চালানো না। Spanner, CockroachDB, Paxos Commit আর Richardson এর বইয়ের কথা তাদের প্রকাশিত লেখা থেকে - সংক্ষেপ।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `twopc` চালানোর **আগে** লিখে ফেলুন - ১০০টা workspace এর ৫টা in doubt, ৮ জন client random workspace এ কাজ করছে, `lock_timeout` নেই। কতক্ষণে সবাই আটকাবে - এক সেকেন্ড? এক মিনিট? কখনো না? (ইঙ্গিত: একটা operation ~৫ ms, আর প্রতিটায় ৫% সম্ভাবনা।) তারপর মেলান, আর experiment ১ (একটা মাত্র in doubt) এর জন্য আবার অনুমান করুন।

2. **ধাপ গোনা:** `twopc.ts` এর `twoPhase()` পড়ে গুনে ফেলুন - coordinator এর দিক থেকে কয়টা ধারাবাহিক round trip, আর কয়টা লেখা disk এ পাকা হওয়ার অপেক্ষা করে। Monolith এর সাথে তুলনা করুন। তারপর experiment ২ (`CRASH_RATE=0`) চালিয়ে দেখুন আপনার গোনা ops/s এর অনুপাতের সাথে কতটা মেলে - কোথায় মেলে না, কেন?

3. **Compensation এর মাঝে crash:** experiment ৪ - `advance()` এ `compensating` log এর পরে আর `release()` এর আগে crash যোগ করুন। Recovery কী করে? তারপর `release()` কে idempotent না করে (শুধু `task_count - 1`) recovery দুবার চালান (যেমন দুটো recovery process একসাথে - বাস্তবে এটা ঘটে)। কী ভাঙে, আর exercise এর idempotent রূপটা কীভাবে এটা আটকায়?

4. **ভুল "না" কমানো:** experiment ৫ - `reserved` আর `confirmed` আলাদা করুন, pending থাকলে "একটু পরে", orchestrator ২০ ms পরে একবার আবার চেষ্টা করুক। ভুল "সীমা শেষ" কত হলো? p50 বা ops/s এ দাম কত? User এর চোখে "সীমা শেষ" আর "একটু পরে আবার চেষ্টা করুন" এর পার্থক্য কী - কোনটা support ticket বানায়?

5. **Design অংশ:** TaskFlow এর plan upgrade এর saga এর এক পাতার design: (ক) ধাপ গুলো, প্রতিটার service, local transaction, আর compensation (বা "শুধু retry"); pivot চিহ্নিত করুন; (খ) saga এর state machine (অবস্থা আর তীর), আর orchestrator এর `sagas` table এর column; (গ) প্রতিটা ধাপের idempotency key কী, আর Stripe এর call এ কোনটা; (ঘ) কোন অবস্থায় কত সময় আটকে থাকলে recovery কী করবে, আর কখন মানুষকে ডাকবে; (ঙ) দুজন admin একই workspace একসাথে upgrade করলে কী হয় - কোন semantic lock লাগবে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8 (সম্পূর্ণ, exit challenge সহ), 9.1, 9.2
Current: 9.3 - Distributed transactions: Saga pattern, 2PC
TaskFlow state: modular monolith (work, identity, files, search) + files processing service +
billing service (নিজের database - audit); সামনে API gateway + web/mobile BFF (9.2); "task তৈরি" =
orchestrated saga, orchestrator work এ: billing এ সংরক্ষণ (saga id ধরে idempotent, semantic lock -
pending এ "একটু পরে") → task তৈরি (+ saga এর state, একই local transaction) → archived হলে release;
sagas table + recovery job, compensation বারবার ব্যর্থ হলে alert; user এর Idempotency-Key = saga id;
plan upgrade = saga, Stripe charge pivot (Idempotency-Key = saga id), পরের ধাপ শুধু retry; মাসের
usage গোনা = outbox event (saga না); রাতের reconcile job; service গুলোর মাঝে 2PC না
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall,
Over-fetching, Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication,
Service Mesh (mTLS), Two-Phase Commit (2PC), In-doubt Transaction, Saga, Compensating Transaction,
Pivot Transaction, Orchestration / Choreography, Semantic Lock
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 9.4 - Service discovery, circuit breaker, bulkhead
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠান - বিশেষ করে ১ নম্বরের অনুমান আর ৫ নম্বরের design। রেডি হলে `next` লিখুন - Lesson 9.4 এ যাব: **Service discovery, circuit breaker, আর bulkhead।** আজকের saga তে work service billing কে synchronous ডাকে, timeout সহ। কিন্তু billing এর তিনটা instance - work জানবে কীভাবে কোনটা কোথায়, আর কোনটা জীবিত (service discovery)? Billing ধীর হলে প্রতিটা "task তৈরি" timeout পর্যন্ত অপেক্ষা করে - হাজার request, হাজার অপেক্ষা; মরতে থাকা একটা service কে বারবার ডাকা বন্ধ করবেন কীভাবে (circuit breaker)? আর billing এর ধীরতা যেন work এর সব connection আর সব worker খেয়ে না ফেলে - board খোলা যেন চলতে থাকে (bulkhead)? Lesson 9.1 এর "timeout + fallback" এর পরের ধাপ - মেপে।
