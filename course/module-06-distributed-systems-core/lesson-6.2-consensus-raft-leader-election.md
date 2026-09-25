# Lesson 6.2 — Consensus: Leader Election আর Raft Basics

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 1.3):** একই data center এর ভেতরে দুটো server এর মধ্যে একটা round trip মোটামুটি কত সময় নেয়? আর ঢাকা থেকে ইউরোপের একটা data center এ? (আজকের lesson এ এই দুটো সংখ্যা একটা design সিদ্ধান্ত ঠিক করে দেবে।)

**Prerequisite:** Lesson 5.3 (WAL), Lesson 5.7 (Replication, failover), Lesson 5.9 (Quorum), Lesson 6.1 (Failure detector, split brain, fencing token)

**তুমি এই lesson শেষে পারবে:**

1. Consensus কী, কোন কোন সমস্যা আসলে ছদ্মবেশী consensus (leader election, lock, unique নাম), আর কেন এটা "সবসময় উত্তর দেবে" এমন নিশ্চয়তা দিতে পারে না — সেটা ব্যাখ্যা করতে পারবে
2. Raft কীভাবে leader বাছে (term, ভোট, random timeout) আর কীভাবে লেখা commit করে (log, majority) — ধাপে ধাপে, whiteboard এ আঁকতে পারবে
3. একটা partition এ Raft কেন split brain এ পড়ে না, election restriction কী রক্ষা করে, আর consensus এর দাম (node সংখ্যা, latency) দিয়ে ঠিক করতে পারবে কোথায় এটা ব্যবহার করবে আর কোথায় না

**Tier:** 1 — Runnable Code (Raft এর মূল অংশের একটা ছোট implementation, seed দেওয়া network simulator এর উপর)

---

## ০. TaskFlow এখন কোথায়

Lesson 6.1 এর পরে TaskFlow এর team দুটো সিদ্ধান্ত নিয়েছে:

1. Reminder job এর leader বাছা হবে **etcd** দিয়ে — etcd এর lease, আর etcd এর revision নম্বর fencing token হিসেবে।
2. Postgres failover চলবে **Patroni** দিয়ে, যেটাও etcd তে একটা lease ধরে রেখে ঠিক করে কে primary।

Design review তে CTO একটা প্রশ্ন করলেন, আর ঘরটা চুপ হয়ে গেল:

> "etcd নিজেও তো তিনটা machine এ চলে। ওদের মধ্যেও তো network কাটতে পারে, একটা machine GC তে আটকাতে পারে। তাহলে etcd এর নিজের split brain হয় না কেন? আমরা কি সমস্যাটা শুধু আমাদের code থেকে etcd তে সরিয়ে দিলাম?"

সাথে আরও দুটো ব্যবহারিক প্রশ্ন: etcd এর node কয়টা হবে — ৩, ৪, নাকি ৫? আর TaskFlow এর দুটো availability zone (AZ) আছে — node গুলো কোথায় বসবে?

প্রশ্নটা একদম ঠিক। উত্তর হলো: etcd একটা **consensus algorithm** চালায় — Raft — যেটা ঠিক 6.1 এর সমস্যাগুলো (message হারানো, partition, pause, পুরনো leader) মাথায় রেখে বানানো, আর গাণিতিকভাবে প্রমাণ করা যে এগুলোর মধ্যেও দুজন leader একই সাথে লেখা commit করতে পারে না। আজ আমরা Raft এর ভেতরে ঢুকব — আর exercise এ নিজের হাতে একটা ছোট Raft চালিয়ে দেখব, একটা partition এ সে কী করে।

---

## ১. Theory

### ১.১ Consensus — একমত হওয়া, যেটা আর কখনো বদলাবে না

**Consensus** — কয়েকটা node এর একটা মানের উপর একমত হওয়া, এমনভাবে যে একবার সিদ্ধান্ত হলে সেটা আর কখনো বদলায় না — এমনকি কিছু node মরলে বা message হারালেও।

শুনতে বিমূর্ত, কিন্তু backend এর অনেক সমস্যা আসলে ছদ্মবেশী consensus:

- **Leader election** — "term 7 এর leader কে?" এর উত্তরে সবাই একমত
- **Lock / lease** — "এই মুহূর্তে lock কার কাছে?" (6.1 এর reminder job)
- **Unique নাম** — দুজন user একই মুহূর্তে একই username চাইল; কে পাবে?
- **ক্রম** — "এই দুটো লেখার কোনটা আগে?" — সবাই একই ক্রম দেখবে

একটা ভালো consensus algorithm এর দুই ধরনের নিশ্চয়তা:

- **Safety** (কখনো খারাপ কিছু ঘটবে না) — দুজন ভিন্ন মানে একমত হবে না; একবার সিদ্ধান্ত হলে বদলাবে না।
- **Liveness** (একসময় ভালো কিছু ঘটবে) — শেষ পর্যন্ত একটা সিদ্ধান্ত হবেই।

আর এখানে একটা বিখ্যাত খারাপ খবর আছে। 1985 সালে Fischer, Lynch আর Paterson প্রমাণ করেন (**FLP impossibility**): 6.1 এর asynchronous network এ — যেখানে message এর দেরির কোনো সীমা নেই — একটা node ও crash করতে পারলে, এমন কোনো deterministic algorithm নেই যেটা **সবসময়** সিদ্ধান্তে পৌঁছানোর নিশ্চয়তা দেয়। কারণটা 6.1 এর মূল কথাই: ধীর node আর মৃত node আলাদা করা যায় না, তাই অপেক্ষা করবে নাকি এগোবে — সেটা কখনো নিশ্চিতভাবে ঠিক করা যায় না।

বাস্তবের algorithm গুলো (Raft, Paxos) এর উত্তর একটা চালাক আপস:

- **Safety কখনো ছাড় দেয় না** — কোনো timeout, কোনো ঘড়ি, কোনো pause এর দৈর্ঘ্যের উপর নির্ভর করে না।
- **Liveness এর জন্য timeout ব্যবহার করে** — network মোটামুটি স্বাভাবিক থাকলে দ্রুত সিদ্ধান্ত; খুব খারাপ হলে হয়তো কিছুক্ষণ সিদ্ধান্তই হয় না (লেখা থেমে থাকে) — কিন্তু **ভুল** সিদ্ধান্ত কখনো হয় না।

6.1 এর শিক্ষাটা মনে করো: "failure detector ভুল হবেই, তাই correctness কে তার উপর নির্ভর করতে দিও না।" Raft ঠিক এই নীতিতে বানানো।

### ১.২ Replicated State Machine — একমত হওয়া একটা log এ

একটা মানে একমত হওয়া যথেষ্ট না — etcd এর প্রতিটা লেখার জন্য একমত হতে হয়। এর সুন্দর সমাধান:

**Replicated state machine** — প্রতিটা node এর কাছে একই command এর একই ক্রমের একটা log, আর প্রতিটা node সেই log এর command গুলো ক্রমানুসারে প্রয়োগ করে। একই শুরু + একই command + একই ক্রম = একই অবস্থা।

```
   client: "x=3"
       │
       ▼
  ┌──────────┐  AppendEntries   ┌──────────┐   ┌──────────┐
  │  LEADER  │ ───────────────► │ follower │   │ follower │
  │ log:     │ ───────────────────────────────►│          │
  │ x=1  x=3 │                  │ x=1  x=3 │   │ x=1  x=3 │
  └────┬─────┘                  └────┬─────┘   └────┬─────┘
       │  majority (৩ এর ২) পেল → "x=3" commit      │
       ▼                             ▼              ▼
   state machine:  x = 3         x = 3          x = 3
```

Lesson 5.3 আর 5.7 এর সাথে মেলাও: Postgres এর WAL আর streaming replication ও একটা log এর কপি। পার্থক্যটা হলো — Postgres এ **কে primary**, সেই সিদ্ধান্ত log এর বাইরে (Patroni, মানুষ, বা script) নেওয়া হয়, আর সেখানেই 6.1 এর split brain ঢোকে। Raft এ leader বাছাই আর log replication একই algorithm এর অংশ, একই নিয়মে বাঁধা।

তাই consensus এর প্রশ্নটা হয়ে দাঁড়ায়: **log এর প্রতিটা স্থানে (index) কোন command থাকবে — সবাই একমত।**

### ১.৩ Raft — তিনটা ভূমিকা, আর Term

Raft (Diego Ongaro আর John Ousterhout, 2014) বানানোই হয়েছিল **বোঝার মতো** করে — তার আগের প্রধান algorithm, Paxos, সঠিক কিন্তু কুখ্যাতভাবে দুর্বোধ্য। Raft এ প্রতিটা node যেকোনো মুহূর্তে তিনটা ভূমিকার একটায়:

```
                 timeout, election শুরু             majority ভোট পেল
   ┌──────────┐ ───────────────────────► ┌───────────┐ ─────────────► ┌──────────┐
   │ FOLLOWER │                          │ CANDIDATE │                │  LEADER  │
   └──────────┘ ◄─────────────────────── └───────────┘                └──────────┘
        ▲        বৈধ leader পেল, বা বড় term     │ timeout: split vote,        │
        │                                       └── নতুন term এ আবার চেষ্টা   │
        └────────────────────── বড় term দেখল ──────────────────────────────────┘
```

- **Follower** — চুপচাপ; leader এর কথা শোনে, ভোট দেয়।
- **Candidate** — leader হতে চাইছে, ভোট চাইছে।
- **Leader** — সব client লেখা নেয়, follower দের কাছে log পাঠায়, আর নিয়মিত heartbeat পাঠায় ("আমি আছি")।

আর Raft এর সবচেয়ে গুরুত্বপূর্ণ ধারণা:

**Term** — Raft এর logical সময়: 1, 2, 3… করে বাড়তে থাকা একটা সংখ্যা; প্রতিটা term শুরু হয় একটা election দিয়ে, আর প্রতিটা term এ সর্বোচ্চ **একজন** leader।

দুটো নিয়ম term কে শক্তিশালী করে:

1. **প্রতিটা message এ পাঠানো node এর term থাকে।**
2. **যেকোনো node নিজের চেয়ে বড় term দেখলে সাথে সাথে সেটা নেয় আর follower হয়ে যায়** — সে leader হলেও। আর ছোট term এর message প্রত্যাখ্যান করে।

6.1 এর **fencing token** মনে পড়ছে? Term হুবহু সেটাই — প্রতিটা নতুন leader এর সাথে বাড়া একটা সংখ্যা, আর পুরনো সংখ্যার কথা কেউ শোনে না। Raft এ fencing আলাদা করে যোগ করতে হয় না; algorithm এর ভেতরেই আছে। (etcd এর revision যে TaskFlow fencing token হিসেবে নিতে পারে, তার কারণও এটা।)

### ১.৪ Leader Election — এক term এ এক ভোট

Follower একটা নির্দিষ্ট সময় (**election timeout**) leader এর কোনো heartbeat না পেলে ধরে নেয় leader নেই, আর:

1. নিজের term এক বাড়ায়
2. candidate হয়, নিজেকে ভোট দেয়
3. সবাইকে `RequestVote` পাঠায়

প্রতিটা node প্রতি term এ **একটাই** ভোট দেয় — যে আগে চাইল, তাকে (একটা শর্ত সহ, ১.৭ এ)। Candidate majority ভোট পেলে leader, আর সাথে সাথে সবাইকে heartbeat পাঠায় যাতে বাকিরা election শুরু না করে।

**কেন এক term এ দুজন leader অসম্ভব?** Lesson 5.9 এর যুক্তিই: দুজনকেই majority পেতে হবে; ৫ জনের দুটো majority (৩ + ৩) কমপক্ষে একজনে মেলে; আর সেই একজন এক term এ দুজনকে ভোট দিতে পারে না। কোনো timeout বা ঘড়ির কথা এখানে নেই — শুধু গণনা।

**Split vote আর random timeout।** কিন্তু সবাই একই মুহূর্তে candidate হলে? প্রত্যেকে নিজেকে ভোট দেয়, কেউ majority পায় না, সবাই আবার timeout এর অপেক্ষা… আর আবার একসাথে। Raft এর সমাধান অবাক করার মতো সরল:

**Randomized election timeout** — প্রতিটা node প্রতিবার একটা range থেকে random election timeout বাছে (paper এর উদাহরণ: 150–300 ms), যাতে সাধারণত একজন বাকিদের আগে জেগে উঠে জিতে যায়।

Exercise এর `npm run election` — ৫টা node একসাথে চালু, কেউ leader না, প্রতিটা range এ ১০০০ বার:

```
   election timeout     leader পাওয়া গেছে    সময় p50 / p99          গড় term (১ = প্রথম চেষ্টাতেই)
   150 ms (স্থির)        837/1000           4204 /  9761 ms         30.61
   150–155 ms           1000/1000            315 /  1526 ms         2.94
   150–175 ms           1000/1000            161 /   331 ms         1.08
   150–300 ms           1000/1000            176 /   252 ms         1.00
```

স্থির timeout এ গড়ে ৩০টা ব্যর্থ election, আর ১৬% ক্ষেত্রে ১০ সেকেন্ডেও কোনো leader নেই — মানে cluster পুরো সময় একটা লেখাও নিতে পারেনি। (যেটুকু জেতে, সেটা শুধু timer এর ±0.5 ms jitter আর network এর এলোমেলো দেরির ভাগ্যে।) মাত্র ২৫ ms এর randomness এই সমস্যা প্রায় মুছে দেয়; 150–300 এ ১০০০ বারের প্রতিবার প্রথম চেষ্টাতেই।

লক্ষ করো আরেকটা জিনিস: 150–300 এর p50 (176 ms) 150–175 এর চেয়ে সামান্য **বেশি** — কারণ গড়ে প্রথম timeout দেরিতে আসে। কিন্তু p99 ভালো (252 বনাম 331 ms)। বড় range = কম split vote, একটু ধীর প্রথম চেষ্টা।

**সময়ের নিয়ম।** Raft paper এর একটা মাপকাঠি:

```
   message এর round trip   ≪   election timeout   ≪   দুটো node crash এর মাঝের গড় সময়
      (~1 ms, একই DC)          (150 ms – কয়েক s)            (মাস)
```

Election timeout round trip এর চেয়ে অনেক বড় হতে হবে (নইলে 6.1 এর ভুল ঘোষণা আর অকারণ election), আর node এর মরার হারের চেয়ে অনেক ছোট (নইলে leader মরলে অনেকক্ষণ লেখা বন্ধ)। etcd এর default: heartbeat 100 ms, election timeout 1000 ms। আর এখানেই spaced repetition এর প্রশ্নটা কাজে লাগে — node গুলো অন্য continent এ থাকলে round trip ১৫০+ ms, তখন এই সংখ্যাগুলো বাড়াতে হয় (১.৮)।

### ১.৫ Log Replication আর Commit

Leader client এর লেখা নিজের log এর শেষে যোগ করে, আর `AppendEntries` দিয়ে follower দের পাঠায়। (Heartbeat আসলে খালি `AppendEntries`।)

**Committed entry** — যে log entry leader majority node এ পৌঁছে দিয়েছে; Raft নিশ্চয়তা দেয় এটা আর কখনো মুছবে না, আর একমাত্র তখনই client কে "সফল" বলা হয়।

প্রতিটা `AppendEntries` এ leader তার ঠিক আগের entry এর index আর term ও পাঠায় — "তোমার log এ index ৫ এ term ৩ এর entry আছে তো?" Follower এর না মিললে প্রত্যাখ্যান করে, আর leader এক ধাপ পিছিয়ে আবার পাঠায় — মেলা পর্যন্ত। মেলার পরের সব অংশ follower মুছে leader এর টা বসায়। ফলাফল: **দুটো log এ কোনো index এ একই term এর entry থাকলে, সেই index পর্যন্ত পুরো log হুবহু এক।** Leader এর log ই সত্য; follower এর অমিল অংশ মুছে যায়।

এখন exercise এর আসল পরীক্ষা। `npm run partition` — ৫টা node, n1 leader, `x=1` লেখা হয়ে গেছে। তারপর network তিন ভাগে কাটা: পুরনো leader n1 একা, n2 একা, বাকি তিনজন (n3 n4 n5) একসাথে:

```
   ═══ 1200 ms: network কাটা — [n1] | [n2] | [n3 n4 n5] ═══

    1250 ms  A       "x=2" → n1 (log index 2, term 1)
    1329 ms  n3      ★ leader হলো (term 2)
    2000 ms  B       "x=3" → n3 (log index 2, term 2)
    2008 ms  n3      commit: index 2 "x=3"
    2008 ms  B       ✓ "x=3" নিশ্চিত (8 ms)
    2250 ms  A       ✗ "x=2" — 1000 ms এ কোনো নিশ্চয়তা আসেনি (timeout)

   ── partition চলছে — দুজন "leader"? ──
   n1  LEADER    term  1   log: x=1(t1) x=2(t1)                commit 1   x = 1
   n2  candidate term  5   log: x=1(t1)                        commit 1   x = 1
   n3  LEADER    term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
   n4  follower  term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
   n5  follower  term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
```

এই snapshot টা এই lesson এর কেন্দ্র। **দুটো node নিজেকে LEADER বলছে** — ঠিক 6.1 এর ভয়। কিন্তু তফাতটা দেখো:

- n1 (term 1) `x=2` নিয়েছে, কিন্তু commit করতে পারেনি — তার সাথে কেউ নেই, majority অসম্ভব। Client A কে কোনো "সফল" বলা হয়নি।
- n3 (term 2) majority পেয়েছে, `x=3` commit করেছে ৮ ms এ।

এটা 6.1 এর split brain না। দুজন নিজেকে leader **ভাবছে**, কিন্তু **কাজ** — লেখা commit করা — শুধু একজন করতে পারছে, কারণ commit এর জন্য majority লাগে, আর majority একটাই। পুরনো leader এর বিভ্রম ক্ষতিকর না, কারণ তার কোনো ক্ষমতা নেই।

**কিন্তু একটা ফাঁদ বাকি:** snapshot এ n1 এর `x = 1`। কেউ যদি n1 থেকে **পড়ে** — "তুমি তো leader, তোমার কাছের মানটাই দাও" — সে পুরনো মান পাবে, যদিও x=3 অনেক আগেই commit হয়ে গেছে। Raft লেখাকে নিরাপদ রাখে; পড়াকে নিরাপদ রাখতে আলাদা ব্যবস্থা লাগে: leader উত্তর দেওয়ার আগে majority থেকে একটা heartbeat এর সাড়া নিশ্চিত করে ("আমি কি এখনো leader?") — Raft এর ভাষায় ReadIndex। etcd default এ ঠিক এটা করে (linearizable read); কম নিশ্চয়তার "serializable" read চাইলে local মান দেয়, দ্রুত কিন্তু পুরনো হতে পারে। (Exercise এর experiment ৩।)

### ১.৬ Partition জোড়া লাগলে

```
   ═══ 3500 ms: network জোড়া লাগল ═══

    3512 ms  n1      term 10 দেখল → আর leader না (ছিল term 1)
    3540 ms  n3      term 10 দেখল → আর leader না (ছিল term 2)
    3628 ms  n3      n2 কে ভোট দিল না — ওর log আমার চেয়ে পুরনো (term 11)
      …     (n1, n4, n5 ও একই কথা বলে)
    3716 ms  n5      ★ leader হলো (term 12)
      …
   ── শেষ অবস্থা ──
   n1  follower  term 12   log: x=1(t1) x=3(t2) x=4(t12)       commit 3   x = 4
   (বাকি চারজনের log হুবহু একই)
```

তিনটা জিনিস ঘটেছে:

1. **পুরনো leader নিজেই সরে গেছে।** n1 বড় term দেখেছে (নিয়ম ২), আর সাথে সাথে follower। কাউকে তাকে "মারতে" হয়নি — 6.1 এর STONITH এর দরকার নেই।
2. **`x=2` মুছে গেছে।** n1 এর log এর index 2 এ ছিল `x=2 (t1)`, নতুন leader এর log এ `x=3 (t2)` — অমিল, তাই মুছে leader এর টা বসেছে। কোনো প্রতিশ্রুতি ভাঙেনি, কারণ `x=2` কখনো commit হয়নি, client A কে কখনো "সফল" বলা হয়নি।
3. **n2 এর term 10 এ উঠেছিল।** একা বিচ্ছিন্ন n2 বারবার election শুরু করে বারবার হেরেছে, প্রতিবার term বাড়িয়ে। ফিরে এসে তার বড় term দেখে সুস্থ leader n3 ও পদ ছেড়েছে (নিয়ম ২) — প্রায় ২০০ ms কোনো leader নেই, অকারণে। এই সমস্যার সমাধান **PreVote**: candidate হওয়ার আগে term না বাড়িয়ে জিজ্ঞেস করা "আমি জিততে পারব?" — etcd সহ অনেক implementation এ আছে (exercise এর experiment ৪)।

**Client A এর কী করা উচিত?** তার timeout মানে 6.1 এর "জানি না" — এই ক্ষেত্রে লেখাটা বাতিল হয়েছে, কিন্তু অন্য ক্ষেত্রে (leader majority তে পৌঁছে দিয়ে client কে জানানোর আগে মরে গেল) লেখাটা পরে commit **হয়ে যেতে পারে**। তাই client নতুন leader এর কাছে retry করবে — idempotency key সহ (2.5), যাতে দুবার প্রয়োগ না হয়।

### ১.৭ Election Restriction — Commit হওয়া লেখা কেন হারায় না

১.৬ এ n2 ভোট পায়নি: "ওর log আমার চেয়ে পুরনো।" এটাই Raft এর নিরাপত্তার শেষ টুকরো:

**Election restriction** — একজন node শুধু সেই candidate কে ভোট দেয় যার log অন্তত তার নিজের মতো নতুন (শেষ entry এর term বড়, অথবা term সমান আর log অন্তত সমান লম্বা)।

কেন এটা committed লেখা রক্ষা করে — ধাপে ধাপে:

1. একটা entry committed মানে সেটা **majority** তে আছে।
2. Leader হতে হলে **majority** এর ভোট লাগে।
3. দুটো majority অন্তত একজনে মেলে — আর সেই একজনের কাছে entry টা আছে।
4. সেই একজন এমন candidate কে ভোট দেবে না যার log এ এটা নেই।
5. তাই যে কেউ leader হয়, তার log এ সব committed entry আছে — আর leader এর log ই সত্য (১.৫)।

Restriction তুলে দিলে কী হয়? `npm run unsafe` — একই গল্প, শুধু ভোটের এই শর্ত বন্ধ:

```
    3631 ms  n2      ★ leader হলো (term 11)
    4500 ms  C       "x=4" → n2 (log index 2, term 11)
   ── শেষ অবস্থা ──
   n1  follower  term 11   log: x=1(t1) x=4(t11)               commit 2   x = 4
   n2  LEADER    term 11   log: x=1(t1) x=4(t11)               commit 2   x = 4
   n3  follower  term 11   log: x=1(t1) x=4(t11)               commit 2   x = 3
   …
   "x=3" এখন কয়টা node এর log এ আছে: 0/5   ← নিশ্চিত করা লেখা হারিয়ে গেছে!
   সব node এ x এর মান এক? না — n1=4 n2=4 n3=3 n4=3 n5=3   ← replica গুলো আলাদা হয়ে গেছে!
```

সবচেয়ে বড় term নিয়ে ফিরে আসা n2 জিতে গেল, আর তার পুরনো log কে "সত্য" ধরে বাকিদের `x=3` মুছে দিল — যে লেখা client B কে ৮ ms এ "নিশ্চিত" বলা হয়েছিল। আর তার চেয়েও খারাপ: n3, n4, n5 আগেই `x=3` প্রয়োগ করে ফেলেছিল, তাই তাদের state machine এ x = 3, বাকিদের x = 4 — **replica গুলো আর এক না।** একটা শর্ত সরানোয় পুরো algorithm এর দুটো মূল প্রতিশ্রুতিই ভাঙল।

(একটা সূক্ষ্ম নিয়মও আছে, exercise এর `raft.ts` এ comment সহ: leader শুধু **নিজের term এর** entry কে majority গুনে commit করে; পুরনো term এর entry গুলো তার সাথে commit হয়। কেন — paper এর Figure 8 এ একটা চমৎকার উদাহরণ আছে। প্রথমবার পড়ার জন্য না, কিন্তু জেনে রাখো যে এমন সূক্ষ্মতা আছে — আর নিজে consensus লেখা কেন বিপজ্জনক, তার আরেকটা কারণ।)

### ১.৮ দাম — আর কোথায় ব্যবহার করবে

**Node সংখ্যা:**

| Node (N) | Majority | কয়টা মরলেও চলে | মন্তব্য                                                       |
| -------- | -------- | --------------- | ------------------------------------------------------------- |
| 1        | 1        | 0               | consensus না — শুধু একটা server                               |
| 3        | 2        | 1               | সবচেয়ে প্রচলিত                                               |
| 4        | 3        | **1**           | ৩ এর চেয়ে ভালো না — বাড়তি machine, একই সহনশীলতা, ধীর commit |
| 5        | 3        | 2               | একটা maintenance এ থাকলেও আরেকটা মরা সহ্য করে                 |
| 7        | 4        | 3               | বিরল; প্রতিটা লেখায় বেশি node এর অপেক্ষা                     |

জোড় সংখ্যা প্রায় কখনো লাভ দেয় না — ৪ node এ majority ৩, তাই ৩ এর মতোই একটা মরা সহ্য করে; আর ২|২ partition এ কোনো দিক majority পায় না।

**কোথায় বসাবে:** TaskFlow এর দুটো AZ তে ৩টা node (২ + ১) বসালে, যে AZ তে ২টা, সেটা পুরো গেলে বাকি ১টা majority পায় না — পুরো cluster বন্ধ। তাই consensus cluster সাধারণত **তিনটা** AZ তে একটা করে। (দুটো AZ ই থাকলে তৃতীয় কোথাও একটা হালকা node — 6.1 এর "witness" এর ধারণা।)

**Latency:** প্রতিটা লেখা commit এর জন্য majority এর একটা round trip লাগে। একই data center এ সেটা ~1 ms — চমৎকার। কিন্তু node গুলো ঢাকা, সিঙ্গাপুর আর ইউরোপে হলে প্রতিটা লেখা ১০০+ ms, আর election timeout ও বাড়াতে হবে। Consensus এর দাম দূরত্বের সাথে সরাসরি বাড়ে।

**Throughput:** সব লেখা একজন leader দিয়ে যায়। Leader এর CPU, disk, network — সেটাই সীমা।

**তাই consensus সাধারণত পুরো database এর জন্য না — ছোট কিন্তু গুরুত্বপূর্ণ data এর জন্য:** কে leader, কার কাছে lock, configuration, service discovery এর তালিকা। etcd ঠিক এই কাজের জন্য — Kubernetes এর পুরো cluster এর অবস্থা etcd তে থাকে — আর তার default storage সীমা মাত্র ২ GB। TaskFlow এর task table etcd তে রাখার কথা ভাবাও ভুল।

ব্যতিক্রম: CockroachDB, TiKV, Google Spanner এর মতো database data কে হাজার হাজার ছোট ভাগে (range) ভাগ করে, আর **প্রতিটা ভাগের নিজের** Raft (বা Paxos) group চালায় — Lesson 5.8 এর sharding আর আজকের consensus এক সাথে। তাতে throughput এর সীমা একজন leader এ আটকে থাকে না।

**কোথায় দেখবে:** Raft — etcd, Consul, CockroachDB, TiKV, Kafka এর KRaft (ZooKeeper এর বদলে), আর MongoDB এর replica set এর protocol Raft থেকে অনুপ্রাণিত। Paxos (Leslie Lamport) — Google এর Chubby আর Spanner। ZooKeeper চালায় তার নিজের ZAB। নাম আলাদা, মূল ধারণা একই: majority, একটা বাড়তে থাকা সংখ্যা (term/ballot/epoch), আর নিরাপত্তা কখনো timeout এর উপর নির্ভর না।

> **Trade-off Table — Consensus কখন**

| প্রয়োজন                                        | Consensus (etcd/Raft)?             | কেন                                                           |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| কে leader / কার কাছে lock (6.1 এর reminder job) | হ্যাঁ                              | ঠিক এর জন্যই বানানো; term/revision = fencing token            |
| Database failover এর সিদ্ধান্ত (Patroni)        | হ্যাঁ — সিদ্ধান্তটার জন্য          | Data থাকে Postgres এ; শুধু "কে primary" consensus এ           |
| App config, feature flag, service এর তালিকা     | হ্যাঁ                              | ছোট, কম লেখা, সবাই একই মান দেখা জরুরি                         |
| TaskFlow এর task, comment                       | না (সরাসরি)                        | বিশাল data, অনেক লেখা — Postgres + replica (5.7)              |
| Activity feed, presence, view count             | না                                 | 5.9 এর AP data — একটু পুরনো মান চলে, latency বেশি জরুরি       |
| Global, strongly consistent বিশাল data          | হ্যাঁ, কিন্তু sharded (Multi-Raft) | CockroachDB/Spanner — দাম: প্রতিটা লেখায় majority round trip |

---

## ২. Interview Angle

**"Raft কীভাবে leader বাছে, ব্যাখ্যা করো।"** — ক্রম: তিনটা ভূমিকা → term (প্রতিটা message এ, বড় term দেখলে follower) → election timeout এ candidate, term++, নিজেকে ভোট, RequestVote → প্রতি term এ এক ভোট, majority এ leader → random timeout কেন (split vote)। তারপর নিজে থেকে বলো: "এক term এ দুজন leader অসম্ভব কারণ দুটো majority মেলে" — এটাই interviewer শুনতে চায়।

**"Partition হলে Raft cluster এ কী হয়?"** — Majority দিক নতুন leader বাছে আর লিখতে থাকে; minority দিকের পুরনো leader নিজেকে leader ভাবলেও commit করতে পারে না; জোড়া লাগলে বড় term দেখে সরে যায়, তার uncommitted entry মুছে যায়। বোনাস: পুরনো leader থেকে local read stale হতে পারে — তাই ReadIndex বা lease-based read।

**"৪টা node দিলে তো ৩ এর চেয়ে বেশি নিরাপদ, তাই না?"** — না: majority ৩, একটাই মরা সহ্য করে, আর ২|২ partition এ কেউ majority পায় না। ৩ বা ৫।

**"আমাদের সব data কি Raft দিয়ে replicate করব?"** — দাম বলো: প্রতিটা লেখায় majority round trip, একজন leader এর throughput সীমা। Coordination data (leader, lock, config) এর জন্য হ্যাঁ; বিশাল data এর জন্য হয় সাধারণ replication, নয়তো sharded consensus (CockroachDB)।

**"Paxos আর Raft এর পার্থক্য?"** — নিরাপত্তার মূল ধারণা একই (majority, বাড়তে থাকা সংখ্যা)। Raft বোঝার সুবিধার জন্য শক্ত leader আর পরিষ্কার ধাপে ভাগ করা; Paxos মূলত একটা মানের উপর একমত হওয়ার protocol, log এর জন্য Multi-Paxos, আর বাস্তব implementation এর অনেক খুঁটিনাটি paper এ নেই।

**Production এ বাস্তবে:** কেউ নিজে Raft লেখে না — etcd, Consul, ZooKeeper, বা database এর নিজের। তোমার কাজ: node সংখ্যা আর বসানোর জায়গা (৩টা AZ), timeout (etcd এর `--heartbeat-interval`, `--election-timeout` — network এর round trip দেখে), disk (etcd প্রতিটা লেখা disk এ `fsync` করে — ধীর disk মানে ধীর cluster), আর monitoring (leader কতবার বদলাচ্ছে — ঘন ঘন বদল মানে timeout বা network এর সমস্যা)।

---

## ৩. Key Takeaway

- **Consensus** = কয়েকটা node এর এমন সিদ্ধান্ত যেটা আর বদলায় না; leader election, lock, unique নাম — সব ছদ্মবেশী consensus
- **FLP:** asynchronous network এ "সবসময় সিদ্ধান্ত হবে" এর নিশ্চয়তা অসম্ভব — তাই Raft **safety কখনো ছাড়ে না**, আর liveness এর জন্য timeout ব্যবহার করে
- **Replicated state machine:** একই log, একই ক্রম, একই অবস্থা — consensus আসলে log এর প্রতিটা স্থানে একমত হওয়া
- **Term** = Raft এর logical সময় আর built-in fencing token: প্রতি term এ সর্বোচ্চ একজন leader, বড় term দেখলে সবাই follower
- Election: প্রতি term এ এক ভোট, majority এ leader; **random timeout** split vote প্রায় শূন্য করে (exercise এ স্থির timeout এ গড়ে ৩০টা ব্যর্থ election, 150–300 ms এ প্রথম চেষ্টাতেই)
- **Commit** = majority তে পৌঁছানো; partition এ minority এর পুরনো leader নিজেকে leader ভাবলেও কিছু commit করতে পারে না — কিন্তু তার থেকে **পড়া** stale হতে পারে
- **Election restriction** committed লেখা রক্ষা করে; exercise এ এটা বন্ধ করলে "নিশ্চিত" লেখা হারাল আর replica গুলো আলাদা হয়ে গেল। Node ৩ বা ৫ (জোড় না), তিনটা AZ এ; consensus ছোট, গুরুত্বপূর্ণ data এর জন্য

---

## ৪. নতুন Term (Glossary)

| Term                            | অর্থ                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Consensus**                   | কয়েকটা node এর একটা মানে একমত হওয়া, এমনভাবে যে সিদ্ধান্ত আর কখনো বদলায় না — কিছু node মরলে বা message হারালেও             |
| **FLP Impossibility**           | Asynchronous network এ একটা node ও crash করতে পারলে, সবসময় সিদ্ধান্তে পৌঁছানোর নিশ্চয়তা দেওয়া deterministic algorithm নেই |
| **Replicated State Machine**    | প্রতিটা node একই command একই ক্রমে প্রয়োগ করে একই অবস্থায় পৌঁছায় — consensus এর মাধ্যমে একমত হওয়া log দিয়ে              |
| **Term**                        | Raft এর logical সময় — বাড়তে থাকা সংখ্যা; প্রতি term এ সর্বোচ্চ একজন leader; বড় term দেখলে follower হতে হয়                |
| **Randomized Election Timeout** | প্রতিটা node প্রতিবার একটা range থেকে random timeout বাছে, যাতে সাধারণত একজন আগে জেগে election জেতে                          |
| **Committed Entry**             | Leader যে log entry majority তে পৌঁছে দিয়েছে — আর কখনো মুছবে না; শুধু তখনই client কে "সফল" বলা হয়                          |
| **Election Restriction**        | শুধু সেই candidate কে ভোট, যার log অন্তত নিজের মতো নতুন — যাতে নতুন leader এর কাছে সব committed entry থাকে                   |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. CTO এর দ্বিতীয় প্রশ্ন: TaskFlow এর দুটো AZ আছে (AZ-a, AZ-b)। একজন engineer প্রস্তাব দিল: "etcd এর ৪টা node, প্রতি AZ এ ২টা — সমান ভাগ, আর ৩ এর চেয়ে বেশি নিরাপদ।" এই প্রস্তাবের সমস্যা কী? AZ-a পুরো গেলে কী হবে? তোমার প্রস্তাব কী?
2. TaskFlow এর reminder worker etcd তে একটা key লিখতে গিয়ে timeout পেল। কোন কোন অবস্থায় লেখাটা হয়ে গেছে, আর কোন অবস্থায় হয়নি? (১.৫–১.৬ এর ঘটনা দিয়ে অন্তত একটা করে উদাহরণ।) Worker এর এখন কী করা উচিত?
3. একজন সহকর্মী বলল: "etcd থেকে পড়া ধীর লাগছে। Leader এর কাছে তো সবসময় সর্বশেষ data থাকে — তাহলে leader সরাসরি নিজের memory থেকে উত্তর দিলেই হয়, majority কে জিজ্ঞেস করার দরকার কী?" Exercise এর partition snapshot দিয়ে উত্তর দাও। কোন ক্ষেত্রে তার প্রস্তাবটা (serializable read) আসলে ঠিক আছে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** ৪ node এ majority ৩, তাই ৩ node এর মতোই মাত্র একটা মরা সহ্য করে — "বেশি নিরাপদ" না, শুধু বেশি machine আর প্রতিটা লেখায় একজন বেশির অপেক্ষা। আর আসল সমস্যা: AZ-a পুরো গেলে (বা দুই AZ এর মাঝের link কাটলে) প্রতিটা দিকে ২টা node — কেউ majority (৩) পায় না → **পুরো cluster লেখা বন্ধ**; Patroni নতুন primary বাছতে পারে না, reminder job এর leader নেই। "সমান ভাগ" ঠিক সবচেয়ে খারাপ ভাগ। ৩ node কে ২ + ১ করলেও একই সমস্যা, শুধু একদিকে: ২ এর AZ গেলে cluster বন্ধ। প্রস্তাব: **তিনটা** failure domain — ৩ node, প্রতিটা ভিন্ন AZ এ। তৃতীয় AZ না থাকলে তৃতীয় node টা অন্য কোনো স্বাধীন জায়গায় (অন্য region, অন্য provider) — একটা ছোট machine যথেষ্ট, কারণ সে মূলত ভোট দেয়। তখন যেকোনো একটা জায়গা গেলেও বাকি দুটো majority। (বাড়তি: তৃতীয় node দূরে হলে সে সাধারণত leader না হওয়াই ভালো — প্রতিটা commit এর জন্য majority এর round trip তখনো কাছের দুটো node দিয়েই হবে।)

**প্রশ্ন ২:** Timeout মানে "জানি না" (6.1)।

- **হয়নি:** request পুরনো leader এর কাছে গেছে যে minority তে আটকা (exercise এর client A আর `x=2`) — সে log এ যোগ করেছে কিন্তু commit করতে পারেনি, আর জোড়া লাগার পর entry মুছে গেছে। অথবা request পথেই হারিয়েছে।
- **হয়ে গেছে:** leader entry টা majority তে পৌঁছে দিয়েছে (committed), তারপর client কে জানানোর ঠিক আগে crash করেছে, বা উত্তর পথে হারিয়েছে। নতুন leader এর log এ entry আছে (election restriction নিশ্চিত করে), অথচ worker "সফল" শোনেনি।
- **পরে হতে পারে:** entry majority তে পৌঁছেছে কিন্তু leader তখনো জানায়নি — নতুন leader তার term এর একটা entry এর সাথে এটাকেও commit করবে।

Worker যা করবে: retry — কিন্তু এমনভাবে যে দুবার প্রয়োগে ক্ষতি নেই। etcd এ এর ভালো উপায় **শর্তসহ লেখা** (transaction/compare-and-swap): "key এর revision এখনো X হলে তবেই লেখো" — প্রথম চেষ্টা সফল হয়ে থাকলে দ্বিতীয়টা শর্তে আটকে যাবে, আর worker পড়ে দেখে নিতে পারবে। অথবা লেখার মান নিজেই idempotent (একই মান আবার লেখা নিরীহ)। আর পড়ে যাচাই করার সময় linearizable read (প্রশ্ন ৩)।

**প্রশ্ন ৩:** "Leader এর কাছে সবসময় সর্বশেষ data" — এই ধারণাটাই ভুল, কারণ একজন node **জানে না যে সে আর leader না।** Exercise এর snapshot এ n1 নিজেকে LEADER বলছে, কিন্তু তার `x = 1`, অথচ `x=3` অনেক আগে commit হয়ে গেছে। n1 নিজের memory থেকে উত্তর দিলে stale read — আর client যদি একটু আগে নিজেই n3 এ `x=3` লিখে থাকে, সে নিজের লেখা ও দেখবে না (5.7 এর read-your-writes, এবার consensus এর মধ্যে)। Majority কে জিজ্ঞেস করা (ReadIndex) মানে "আমি এখনো leader" নিশ্চিত করা — minority তে আটকা n1 সেটা পারবে না, তাই ভুল উত্তরের বদলে উত্তরই দেবে না। (আরেকটা পথ আছে — leader একটা lease ধরে রাখে, আর lease এর ভেতরে majority ছাড়াই উত্তর দেয় — কিন্তু সেটা 6.1 এর মতো ঘড়ি আর pause এর অনুমানের উপর নির্ভর করে।) **কখন serializable read ঠিক আছে:** যখন একটু পুরনো মান ক্ষতিকর না — dashboard এ config দেখানো, monitoring, বা এমন cache যেটা নিজেই পরে ঠিক হয়। কিন্তু lock/leader এর সিদ্ধান্ত নেওয়ার আগে ("lock কি এখনো আমার?") কখনো না।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (deterministic simulation)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-6.2-raft/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.2-raft) — `npm install`, তারপর `npm run election`, `npm run partition`, `npm run unsafe`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`src/raft.ts` এ Raft এর মূল অংশ (~300 লাইন) — paper এর Figure 2 এর নিয়ম মেনে, প্রতিটা নিয়মের পাশে comment। `src/sim.ts` একটা discrete-event simulator: message এর দেরি seed দেওয়া random, আর যেকোনো link কাটা যায়। Membership change, snapshot, disk এ persist, PreVote বাদ — এটা পড়ার আর ভাঙার জন্য, production এর জন্য না।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; তিনটা script কয়েকবার চালিয়ে হুবহু একই output (checksum মিলিয়ে)। README এর experiment গুলো তোমার code বদলানোর কাজ — সেগুলো চালিয়ে দেখা হয়নি।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **`raft.ts` পড়ো** — শুধু চারটা function: `startElection`, `onRequestVote`, `onAppendEntries`, `advanceCommit`। প্রতিটার জন্য এক লাইনে লেখো, এটা Raft এর কোন নিয়ম (১.৩–১.৭ এর কোনটা)।

2. তিনটা script চালাও। `partition` এর snapshot এ দুজন LEADER — এক লাইনে লেখো কেন এটা 6.1 এর split brain **না**। তারপর আরেক লাইনে: কোন একটা কাজ করলে এটা আসলেই ক্ষতিকর হতে পারত?

3. **জোড় সংখ্যা** (experiment ২): ৬টা node, ৩|৩ partition। কোনো দিক leader পেল? কোনো লেখা commit হলো? প্রশ্ন ১ এর উত্তরের সাথে মেলাও।

4. **Stale read ঠিক করো** (experiment ৩): majority এর সাড়া ছাড়া উত্তর না দেওয়া একটা `read()` লেখো। Partition এর সময় n1 আর n3 কে দিয়ে চালাও — কে উত্তর দেয়, কে দেয় না?

5. **Design অংশ:** CTO কে এক পাতার একটা উত্তর লেখো: (ক) etcd এর নিজের split brain কেন হয় না — term, majority, election restriction দিয়ে, ৫–৬ লাইনে; (খ) node সংখ্যা আর কোথায় বসবে (TaskFlow এর দুটো AZ আছে — তৃতীয়টা কোথায়?); (গ) `--heartbeat-interval` আর `--election-timeout` কত — node গুলোর মধ্যে round trip দেখে যুক্তি সহ; (ঘ) reminder worker etcd থেকে lock এর অবস্থা পড়ার সময় কোন ধরনের read ব্যবহার করবে, আর কেন।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (সম্পূর্ণ, exit challenge সহ), 6.1
Current: 6.2 — Consensus: Leader Election, Raft Basics
TaskFlow state: Nginx + Express instance গুলো, CDN, Redis cache; PostgreSQL primary +
read replica, Patroni দিয়ে failover; etcd (৩ node, তিনটা আলাদা failure domain) — Patroni এর
leader lock আর reminder job এর lease; etcd revision = fencing token; lock এর অবস্থা linearizable read এ
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility,
Replicated State Machine, Term, Randomized Election Timeout, Committed Entry,
Election Restriction
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 6.3 — Quorum in practice: replication lag, read-your-writes, monotonic read
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের দুটো লাইন আর ৫ নম্বরের CTO কে উত্তর। রেডি হলে `next` লিখো — Lesson 6.3 এ যাব: **Quorum in practice — replication lag, read-your-writes, monotonic read।** আজ দেখলে, পুরনো leader থেকে পড়লে পুরনো মান আসে। Consensus সেটা এড়ায় — প্রতিটা read এর জন্য majority এর সাড়া নিয়ে, যেটা দামি। বেশিরভাগ system এই দাম সব read এ দেয় না; তারা replica থেকে পড়ে, আর এর বদলে কিছু **নির্দিষ্ট** নিশ্চয়তা দেয়: "নিজের লেখা দেখবে", "সময় পেছনে যাবে না"। 5.7 এ যে সমস্যার শুধু নাম নিয়ে রেখেছিলাম — refresh করলে task উধাও — সেটা সেখানে সমাধান হবে।
