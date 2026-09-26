# Lesson 6.5 — Consistency Models: Strong থেকে Eventual, বাস্তবে কেমন লাগে

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 5.5):** Postgres এর `REPEATABLE READ` আর `SERIALIZABLE` এর মধ্যে কোন anomaly টা পার্থক্য গড়ে? (উদাহরণ সহ এক লাইনে।) আজ দেখবে "serializable" আর "linearizable" — নাম কাছাকাছি, কিন্তু একদম আলাদা প্রশ্নের উত্তর।

**Prerequisite:** Lesson 5.5 (Isolation level), Lesson 5.9 (CAP, linearizability), Lesson 6.2 (Linearizable read), Lesson 6.3 (Session guarantee), Lesson 6.4 (Happens-before)

**তুমি এই lesson শেষে পারবে:**

1. Module 5–6 এ আসা সব নিশ্চয়তা — linearizable, sequential, causal, session guarantee, eventual — একটা মই এ সাজাতে পারবে, আর প্রতিটা ধাপে কী হারাও আর কী পাও বলতে পারবে
2. একটা ছোট operation history দেখে হাতে বলতে পারবে সেটা কোন model মানে আর কোনটা ভাঙে — আর একটা checker দিয়ে যাচাই করতে পারবে
3. Serializability আর linearizability এর পার্থক্য বলতে পারবে, আর TaskFlow এর প্রতিটা data এর জন্য একটা model বেছে design doc এ এক লাইনে লিখতে পারবে

**Tier:** 1 — Runnable Code (একটা ছোট consistency checker, আর simulated system থেকে random history)

---

## ০. TaskFlow এখন কোথায়

Module 6 জুড়ে TaskFlow এর অনেকগুলো অংশ বদলেছে — etcd, version token, conflict এর নিয়ম। এখন দুটো ঘটনা একসাথে:

1. TaskFlow একটা managed database কেনার কথা ভাবছে। Vendor এর website এ বড় করে লেখা: **"Strongly consistent. Globally distributed. Always available."** CTO জানতে চাইলেন, "এটা কি সত্যি হতে পারে? আর 'strongly consistent' বলতে ঠিক কী বোঝায়?"
2. Architecture review এর নিয়ম বদলেছে: প্রতিটা design doc এ প্রতিটা data store এর জন্য একটা লাইন লাগবে — **"consistency model: \____"** — আর সেটা review এ যাচাই করা হবে।

প্রথম design doc টা লিখতে বসে team এর তিনজন তিন রকম লিখল: একজন "strong", একজন "serializable", একজন "eventually consistent but fast"। আর review তে কেউ বলতে পারল না এই তিনটার কোনটা আসলে কী প্রতিশ্রুতি দেয়।

আজকের lesson Module 6 এর শেষ, আর এর কাজ হলো **ভাষা ঠিক করা**: প্রতিটা নিশ্চয়তার একটা স্পষ্ট সংজ্ঞা, একটা মই, আর একটা উপায় — history দেখে যাচাই করা, একটা ছোট checker দিয়ে।

---

## ১. Theory

### ১.১ Consistency Model — একটা চুক্তি

**Consistency model** — একটা system আর তার ব্যবহারকারীর মধ্যে চুক্তি: একাধিক client একসাথে পড়লে-লিখলে, একটা read **কী কী মান ফেরত দিতে পারে** — আর কোনটা কখনো পারে না।

এটা বর্ণনা করার সবচেয়ে সৎ উপায় হলো **history** দিয়ে:

**Operation history** — কোন client কখন কোন operation শুরু করল, কখন শেষ হলো, আর কী ফল পেল — তার পুরো রেকর্ড; একটা consistency model আসলে বলে কোন history গুলো "বৈধ"।

```
   P1   |──── write x=1 ────|
   P2          |── read x → 1 ──|
   P3                                  |── read x → 0 ──|
   ────────────────────────────────────────────────────────► আসল সময়
```

প্রতিটা operation একটা **সময়ের ব্যাপ্তি** — শুরু থেকে শেষ। Client জানে কখন request পাঠাল আর কখন উত্তর এলো; মাঝে কোন মুহূর্তে database আসলে কাজটা করল, জানে না।

মূল প্রশ্ন সব model এ একই: **এমন কোনো একটা সারি (একটার পর একটা) কল্পনা করা যায় কি, যেখানে প্রতিটা read ঠিক তার আগের write এর মান পায়?** Model গুলোর পার্থক্য শুধু একটা জায়গায় — **সারিটাকে কোন কোন নিয়ম মানতে হবে।**

Exercise এর `checker.ts` ঠিক এই প্রশ্নের উত্তর খোঁজে — সম্ভাব্য সব সারি খুঁজে দেখে (একটা ছোট Jepsen, ১.৭ এ)।

### ১.২ Linearizability — যেন একটাই কপি, আর সময় মানে

Lesson 5.9 এ প্রথম শুনেছিলে — CAP এর "C"। এবার পুরো সংজ্ঞা:

**Linearizability** — প্রতিটা operation তার শুরু আর শেষের মাঝে কোনো **এক মুহূর্তে** একবারে ঘটেছে বলে ধরা যায়; আর সারিটা আসল সময় মানে — একটা operation শেষ হওয়ার পরে আরেকটা শুরু হলে (যেকোনো client এর), সারিতেও সেটা পরে।

**Linearization point** — operation এর ব্যাপ্তির ভেতরে সেই কাল্পনিক মুহূর্ত যখন এটা "আসলে ঘটল"।

Client এর চোখে: system টা যেন **একটাই কপি**, আর প্রতিটা লেখা শেষ হওয়ার মুহূর্ত থেকে **সবাই** সেটা দেখে। Exercise এর `npm run models` এর প্রথম তিনটা ঘটনা:

```
   ঘটনা                                   lesson   linear.  sequential  causal  RYW  mono.read  eventual
   এক primary, সব স্বাভাবিক               5.x      ✓        ✓           ✓       ✓    ✓          ✓
   লেখা চলার মাঝে পড়া নতুন মান পেল       6.2      ✓        ✓           ✓       ✓    ✓          ✓
   পুরনো leader থেকে পড়া                 6.2      ✗        ✓           ✓       ✓    ✓          ✓
```

- **"লেখা চলার মাঝে পড়া নতুন মান পেল" — linearizable।** লেখা এখনো শেষ হয়নি, কিন্তু পড়া নতুন মান পেয়েছে। কোনো সমস্যা নেই: লেখার linearization point পড়ার আগে বসানো যায়। Linearizability মানে "সবকিছু ধীরে, একটার পর একটা" না — concurrent operation চলে, শুধু ফলগুলো একটা যুক্তিসঙ্গত সারিতে বসাতে হবে।
- **"পুরনো leader থেকে পড়া" — linearizable না।** P1 এর লেখা ১০ ms এ শেষ; P2 পড়া **শুরু** করেছে ১০০ ms এ, আর পুরনো মান পেয়েছে। আসল সময় বলছে P2 এর পড়া লেখার পরে — তাই নতুন মান পাওয়ার কথা। 6.2 এর minority তে আটকা leader এর local read ঠিক এটাই।

কোথায় লাগে: যেখানে **সবার একই সত্যে** একমত হওয়া জরুরি — lock এর মালিক কে (6.1), leader কে (6.2), username টা নেওয়া হয়ে গেছে কিনা, account এ যথেষ্ট টাকা আছে কিনা। দাম: 6.2 এর majority round trip, আর 5.9 এর CAP — partition এ minority দিক উত্তর দিতে পারে না।

### ১.৩ Sequential Consistency — নিজের ক্রম মানো, আসল সময় না

"পুরনো leader থেকে পড়া" এর sequential কলামে ✓। কেন?

**Sequential consistency** — এমন একটা সারি আছে যেটা প্রতিটা client এর **নিজের** operation এর ক্রম মানে; কিন্তু ভিন্ন client এর মধ্যে আসল সময় মানার দরকার নেই।

P2 এর পুরনো পড়াটা সারিতে P1 এর লেখার **আগে** বসিয়ে দাও — P2 এর নিজের ক্রম তাতে ভাঙে না (তার আর কোনো operation আগে নেই), P1 এর ও না। আসল সময়ে P2 পরে পড়েছে, কিন্তু sequential consistency সেটা দেখে না।

মনে হতে পারে পার্থক্যটা তুচ্ছ। কিন্তু ভাবো: রহিম phone এ call করে করিমকে বলল "task টা বন্ধ করে দিয়েছি, দেখো।" করিম দেখল — খোলা। Sequential consistency এটা অনুমতি দেয়, কারণ system phone call এর কথা জানে না (system এর বাইরের একটা "message")। Linearizability দেয় না, কারণ আসল সময়ে রহিমের লেখা শেষ, তারপর করিম পড়েছে।

Database এর জগতে sequential consistency কদাচিৎ আলাদা করে বিক্রি হয় — কিন্তু এটা শেখা দরকার, কারণ এটাই বোঝায় linearizability তে "আসল সময়" অংশটা কত দামি আর কেন। (CPU আর programming language এর memory model এ এটা খুব গুরুত্বপূর্ণ ধারণা।)

### ১.৪ Causal Consistency — কার্যকারণ মানো, বাকি সব স্বাধীন

**Causal consistency** — happens-before (6.4) দিয়ে সম্পর্কিত operation গুলো সবাই একই ক্রমে দেখে; কিন্তু concurrent operation গুলো ভিন্ন client ভিন্ন ক্রমে দেখতে পারে।

মানে: করিম রহিমের প্রশ্ন **দেখে** উত্তর দিলে, উত্তর দেখা যে কেউ প্রশ্নটাও দেখবে। কিন্তু দুজন একে অপরের কথা না জেনে দুটো আলাদা comment করলে, কেউ রহিমেরটা আগে দেখবে, কেউ করিমেরটা — দুটোই বৈধ।

```
   উত্তর আছে, প্রশ্ন নেই                  6.3      ✗        ✗           ✗       ✓    ✓          ✓
```

এই সারিটা এই lesson এর সবচেয়ে গুরুত্বপূর্ণ সারির একটা। P3 এর **নিজের** দেখায় কোনো নিয়ম ভাঙেনি — সে নিজে কিছু লেখেনি (read-your-writes ✓), তার দেখা কখনো পেছনে যায়নি (monotonic ✓)। ভেঙেছে **অন্য দুজনের** মধ্যের কার্যকারণ: প্রশ্ন → করিম পড়ল → উত্তর। Session guarantee গুলো (6.3) একজন client এর নিজের ইতিহাস দেখে; causal দেখে পুরো কার্যকারণের জাল।

Causal এর একটা বিশেষ গুরুত্ব আছে: গবেষণায় দেখানো হয়েছে যে **partition এর সময়ও সব দিক থেকে উত্তর দিতে পারে** (5.9 এর AP), এমন model গুলোর মধ্যে causal consistency (একটু বাড়ানো রূপে) প্রায় সবচেয়ে শক্ত যেটা পাওয়া সম্ভব। মানে AP system এর জন্য এটা একটা স্বাভাবিক লক্ষ্য। বাস্তবে: MongoDB এর causal consistency session (6.3 এর `afterClusterTime`), আর 6.3 এর "সম্পর্কিত data এক partition এ" নিয়মটা আসলে সস্তায় causal পাওয়ার কৌশল।

### ১.৫ Session Guarantee আর Eventual — মই এর নিচের ধাপ

6.3 এর session guarantee গুলো আসলে একজন client এর চোখে causal এর টুকরো:

```
   Replica lag: নিজের লেখা নেই            5.7      ✗        ✗           ✗       ✗    ✓          ✓
   Refresh এ task উধাও                    6.3      ✗        ✗           ✗       ✓    ✗          ✓
```

প্রতিটা আলাদা, স্বাধীন: প্রথমটায় read-your-writes ভাঙে কিন্তু monotonic ঠিক; দ্বিতীয়টায় উল্টো। তাই design doc এ "session consistency" লেখা যথেষ্ট না — **কোন** guarantee গুলো, নাম ধরে।

আর মই এর একদম নিচে:

**Eventual consistency** (5.9) — নতুন লেখা থামলে একসময় সব replica একই মানে পৌঁছাবে। ব্যস।

```
   LWW: ঘড়ির ভুলে bot এর edit হারাল      6.4      ✗        ✗           ✗       ✗    ✓          ✓
```

শেষ কলামে ✓ — সব replica শেষে একই মানে পৌঁছেছে (bot এর edit হারিয়ে)। আর বাকি প্রায় সব ✗। Eventual consistency বলে না **কবে** মিলবে, বলে না মাঝের সময়ে কী দেখা যাবে, আর বলে না **কোন** মানে মিলবে — এমনকি একটা "saved" বলা লেখা হারিয়েও মিলতে পারে। Vendor যখন শুধু "eventually consistent" বলে, প্রশ্ন করো: "আর তার সাথে কী?"

### ১.৬ মইটা

```
                     শক্ত — কম অবাক করা, বেশি দাম
                          │
   Strict serializable    │  transaction + আসল সময় (Spanner) ─────────── ১.৮
          │
   Linearizable           │  একটাই কপি, আসল সময় মানে       lock, leader, unique নাম
   Sequential             │  এক সারি, শুধু নিজের ক্রম
          │                    ── partition এ সব দিক থেকে উত্তর দেওয়া অসম্ভব (CAP) ──
          │
   Causal                 │  কার্যকারণ সবাই একই ক্রমে দেখে    ← partition এও সম্ভব
          │
   Session guarantees     │  read-your-writes, monotonic reads, …  (নাম ধরে, আলাদা করে)
          │
   Eventual               │  শেষে মিলবে — কবে, কীসে, জানা নেই
                          │
                     দুর্বল — বেশি অবাক করা, সস্তা, সবসময় উত্তর দেয়
```

উপরের ধাপ নিচের সব নিশ্চয়তা দেয় (linearizable হলে causal ও, read-your-writes ও)। নিচে নামলে দুটো জিনিস পাও: কম latency (কাছের replica থেকে উত্তর), আর partition এ availability। আর একটা জিনিস হারাও: প্রতিটা ধাপে user কে একটা নতুন ধরনের অদ্ভুত জিনিস দেখানোর অনুমতি দাও — `models` এর table এর প্রতিটা ✗ একটা support ticket।

### ১.৭ Jepsen — দাবি নয়, history

মই জানলেই হয় না — একটা system **আসলে** কোন ধাপে আছে, সেটা কীভাবে জানবে? Vendor এর দাবি দিয়ে না।

Kyle Kingsbury (6.1 এর "The Network is Reliable" এর সহ-লেখক) এর **Jepsen** project এই প্রশ্নের উত্তর দেয়: একটা database এর cluster চালাও, অনেক client দিয়ে একসাথে পড়ো-লেখো, network কাটো, process মারো, ঘড়ি সরাও — আর **প্রতিটা operation এর history রেকর্ড করো।** তারপর একটা checker দিয়ে যাচাই করো: এই history কি দাবি করা model এর সাথে মেলে? বছরের পর বছর Jepsen অনেক পরিচিত database এর consistency দাবিতে ভুল খুঁজে পেয়েছে — কখনো bug, কখনো documentation এর অতিরঞ্জন। (Module 5 এর exit challenge এর recommendation এ এর কথা বলেছিলাম।)

Exercise এর `npm run jepsen` একই কাজ, ছোট করে: চারটা simulated system, প্রতিটায় ৩০০টা random history (৩ জন client, একটা key), checker দিয়ে যাচাই:

```
   system                        linear.  sequential  causal    RYW   mono.read  eventual
   এক primary                    100%     100%      100%    100%     100%      100%
   যেকোনো replica                 32%      58%       61%     70%      85%      100%
   client প্রতি একটা replica      29%      57%       63%     67%     100%      100%
   version token                  48%     100%      100%    100%     100%      100%
```

- **এক primary:** সব কলাম ১০০%। এটা checker এর নিজের একটা পরীক্ষাও — সঠিক system এর কোনো history কে ভুল করে "ভাঙা" বলেনি।
- **যেকোনো replica:** শুধু eventual পুরো নিশ্চিত। বাকি সব কমবেশি ভাঙে — 6.3 এর table এর আরেকটা রূপ।
- **Sticky replica:** monotonic reads ১০০% (6.3 এ যা দেখেছিলে) — কিন্তু বাকি কিছু ঠিক করে না।
- **Version token:** sequential আর causal **১০০%**, কিন্তু linearizable মাত্র ৪৮%। Token প্রতিটা client এর দেখা একমুখী আর নিজের লেখা সহ রাখে — কিন্তু **অন্য** client এর সদ্য লেখা দেখা নিশ্চিত করে না। মই এ ঠিক একটা ধাপ নিচে। (সাবধান: এখানে একটাই key। একাধিক key তে "উত্তর আছে, প্রশ্ন নেই" token দিয়ে আটকায় না — exercise এর experiment ২।)

আর table এর নিচের লাইনটা মনে রাখার মতো: **১০০% মানে "এই ৩০০টা history তে ভাঙেনি" — প্রমাণ না।** ১০০% এর কম মানে নিশ্চিতভাবে ভাঙে। Testing এর চিরকালের নিয়ম — Jepsen bug খোঁজে, সঠিকতা প্রমাণ করে না।

### ১.৮ Serializable বনাম Linearizable — দুটো আলাদা প্রশ্ন

নাম কাছাকাছি, তাই interview আর design doc এ সবচেয়ে বেশি গুলিয়ে যায়:

|                   | **Serializability** (5.5)                                      | **Linearizability** (5.9, আজ)                                      |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| কী নিয়ে          | **Transaction** — একসাথে কয়েকটা object (row)                  | একটা **object** এর একটা operation                                  |
| কী বলে            | Transaction গুলো যেন একটার পর একটা চলেছে — **কোনো একটা** ক্রমে | একটা operation যেন এক মুহূর্তে ঘটেছে — আর ক্রমটা **আসল সময়** মানে |
| আসল সময়          | মানে না — "কোনো একটা" ক্রম হলেই চলে                            | মানে                                                               |
| কোন সমস্যা আটকায় | Write skew, lost update, phantom (5.5)                         | Stale read, পুরনো leader (6.2)                                     |

দুটো একসাথে: **strict serializability** — transaction গুলো একটার পর একটা চলেছে, আর সেই ক্রম আসল সময় মানে।

**Strict serializability** — serializable + linearizable: transaction গুলোর একটা ক্রম আছে, আর একটা transaction commit হওয়ার পরে শুরু হওয়া transaction সেই ক্রমে পরে আসে। Google Spanner একে বলে "external consistency" — আর 6.4 এর TrueTime আর commit wait ঠিক এটার জন্য।

TaskFlow এর জন্য ব্যবহারিক ফল: Postgres primary তে `SERIALIZABLE` transaction — কিন্তু পড়া যদি **replica** থেকে হয়, সেই পড়া পুরনো হতে পারে (6.3)। Transaction এর isolation ঠিক আছে, কিন্তু system টা আর linearizable না। "আমরা SERIALIZABLE ব্যবহার করি" আর "আমাদের read সবসময় সর্বশেষ" — দুটো আলাদা দাবি।

### ১.৯ Data অনুযায়ী Model — TaskFlow এর design doc

5.9 এ CAP এর বাছাই করেছিলে data ধরে। একই কাজ, এবার মই এর ভাষায়:

| TaskFlow এর data                         | Model                                     | কীভাবে (কোন lesson)                               | কেন এর চেয়ে দুর্বল না / শক্ত না                        |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Reminder job এর leader, Postgres primary | Linearizable                              | etcd (6.2), linearizable read                     | দুজন leader মানে duplicate email / split brain          |
| Billing, subscription, permission        | Strict serializable (এক primary এর ভেতরে) | Postgres primary, SERIALIZABLE, primary থেকে পড়া | দুবার charge বা ভুল permission ফেরানো যায় না           |
| User এর নিজের task list, task edit       | Read-your-writes + monotonic reads        | Version token, user এর নামে (6.3)                 | লাখ লাখ read replica তে; অন্যের edit কয়েক ms দেরি চলে  |
| Task এর comment thread                   | Causal (thread এর ভেতরে)                  | task/workspace দিয়ে shard (5.8, 6.3)             | প্রশ্ন ছাড়া উত্তর অদ্ভুত; পুরো linearizable অকারণ দামি |
| Notification count, presence, view count | Eventual (+ read repair)                  | Leaderless quorum store (5.9, 6.3)                | ভুল ছোট আর নিজে থেকে ঠিক হয়; availability বেশি জরুরি   |

আর design doc এর লাইনটা এমন দেখায়: **"Task list: read-your-writes + monotonic reads (version token, Redis এ user এর নামে, TTL ৫ মিনিট); অন্য user এর edit সাধারণত < ১০০ ms, replica আটকালে ৩০ s পর্যন্ত দেরি হতে পারে।"** — model এর নাম, কীভাবে পাওয়া, আর user এর চোখে সবচেয়ে খারাপ কী দেখা যায়।

---

## ২. Interview Angle

**"তোমার system এর consistency model কী?"** — একটা শব্দে উত্তর দিও না ("strong", "eventual")। Data ধরে উত্তর দাও (১.৯ এর table এর মতো), আর প্রতিটার সাথে "কেন এটা যথেষ্ট"। Interviewer এর আসল প্রশ্ন: তুমি জানো কোন data তে কী ভুল চলে, আর কোথায় চলে না।

**"Linearizable আর serializable এর পার্থক্য?"** — ১.৮ এর table এর দুই লাইন: "Serializable transaction নিয়ে, আসল সময় মানে না; linearizable একটা object নিয়ে, আসল সময় মানে। দুটো একসাথে strict serializable — Spanner।" বোনাস: "Postgres primary তে SERIALIZABLE কিন্তু replica থেকে পড়লে linearizable না।"

**"একটা database বলছে 'strongly consistent, globally distributed, always available' — বিশ্বাস করবে?"** — CAP (5.9): partition এ linearizable আর সব দিক থেকে উত্তর একসাথে অসম্ভব। তাই চারটা প্রশ্ন: (১) "strong" মানে কোন model — linearizable, নাকি শুধু read-your-writes? (২) Partition এ কোন দিক উত্তর দেওয়া বন্ধ করে? (৩) Read কি সবসময় leader/quorum থেকে, নাকি default এ replica থেকে? (৪) Jepsen বা এরকম স্বাধীন পরীক্ষা হয়েছে?

**"Causal consistency কেন দরকার, session guarantee তো আছে?"** — "উত্তর আছে প্রশ্ন নেই" এর উদাহরণ: session guarantee একজন client এর ইতিহাস দেখে; causal দেখে client দের মধ্যের কার্যকারণ।

**Production এ বাস্তবে:** প্রায় কোনো system পুরোটা এক model এ চলে না — TaskFlow এর মতোই, data অনুযায়ী মিশ্র। আর model টা শুধু database এর setting না — replica থেকে পড়া, cache (Module 4 — cache ও একটা replica!), CDN সব মিলিয়ে user যা দেখে সেটাই আসল model। একটা linearizable database এর সামনে ১০ মিনিটের TTL এর cache বসালে user এর চোখে system টা eventual।

---

## ৩. Key Takeaway

- **Consistency model** = চুক্তি: একাধিক client একসাথে চললে read কী কী ফেরত দিতে পারে; সংজ্ঞা দেওয়ার সৎ উপায় **history** — "এমন একটা সারি আছে কি, আর সেটা কোন নিয়ম মানে?"
- **Linearizable:** একটাই কপি আর আসল সময় মানে — "পুরনো leader থেকে পড়া" ভাঙে; lock/leader/unique এর জন্য; দাম majority round trip আর partition এ unavailability
- **Sequential:** শুধু নিজের ক্রম, আসল সময় না — পুরনো leader এর পড়া এখানে বৈধ; linearizable এর "আসল সময়" অংশটার দাম বোঝায়
- **Causal:** কার্যকারণ সবাই একই ক্রমে দেখে, concurrent গুলো স্বাধীন; partition এও সম্ভব; "উত্তর আছে প্রশ্ন নেই" ভাঙে — যেখানে session guarantee সব ✓
- Session guarantee গুলো আলাদা আলাদা — design doc এ নাম ধরে লেখো; **eventual** একা প্রায় কিছুই বলে না (ঘড়ির LWW এও ✓)
- **Jepsen:** দাবি না, history যাচাই — exercise এ version token ১০০% sequential/causal কিন্তু ৪৮% linearizable; ১০০% মানে "ভাঙেনি", প্রমাণ না
- **Serializable ≠ linearizable** (transaction বনাম object, আসল সময় মানে না বনাম মানে); দুটো একসাথে strict serializable; model বাছো data ধরে, আর মনে রাখো cache/replica মিলিয়ে user যা দেখে সেটাই আসল model

---

## ৪. নতুন Term (Glossary)

| Term                       | অর্থ                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Consistency Model**      | System আর ব্যবহারকারীর চুক্তি: একাধিক client একসাথে চললে একটা read কী কী মান ফেরত দিতে পারে                       |
| **Operation History**      | কোন client কখন কোন operation শুরু করল, কখন শেষ হলো, কী ফল পেল — তার রেকর্ড; model বলে কোন history বৈধ             |
| **Linearization Point**    | একটা operation এর শুরু আর শেষের মাঝের সেই কাল্পনিক মুহূর্ত যখন এটা "একবারে ঘটেছে" ধরা হয়                         |
| **Sequential Consistency** | এমন একটা সারি আছে যেটা প্রতিটা client এর নিজের ক্রম মানে — কিন্তু client পেরিয়ে আসল সময় মানে না                 |
| **Causal Consistency**     | Happens-before দিয়ে সম্পর্কিত operation সবাই একই ক্রমে দেখে; concurrent গুলো ভিন্ন client ভিন্ন ক্রমে দেখতে পারে |
| **Strict Serializability** | Serializable + linearizable: transaction গুলোর একটা ক্রম, যেটা আসল সময়ও মানে (Spanner এর "external consistency") |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. এই history টা কোন কোন model মানে? (সময় ms এ, `x` এর শুরুর মান 0)

   ```
   P1: write x=1   [0, 100]
   P2: read x → 1  [10, 20]
   P3: read x → 0  [30, 40]
   ```

   Linearizable? Sequential? আর এটা বাস্তবে কোন ধরনের system এ ঘটতে পারে?

2. Vendor এর দাবি: "Strongly consistent. Globally distributed. Always available." CTO কে চার লাইনে উত্তর লেখো — কোন অংশ একসাথে অসম্ভব, আর vendor কে কোন চারটা প্রশ্ন করবে।
3. TaskFlow এর task list এর জন্য একজন engineer বলল: "আমরা Postgres এ `SERIALIZABLE` ব্যবহার করি, তাই আমাদের task list strongly consistent।" কিন্তু task list এর read version token দিয়ে replica থেকে আসে, আর সামনে একটা ৩০ সেকেন্ডের Redis cache আছে (Module 4)। User এর চোখে task list এর আসল consistency model কী? কোন model এ কোন উপাদানটা নামিয়ে দিচ্ছে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** **Linearizable না।** P2 এর পড়া ২০ ms এ শেষ, আর নতুন মান (1) পেয়েছে — মানে লেখার linearization point ২০ এর আগে। P3 পড়া **শুরু** করেছে ৩০ এ — P2 এর পড়া শেষ হওয়ার পরে — আর পুরনো মান (0) পেয়েছে। আসল সময়ে সারি: লেখা → P2 → P3, কিন্তু তাহলে P3 এর 0 পাওয়ার কথা না। (লেখা নিজে ১০০ পর্যন্ত চলছে — কিন্তু তাতে বাঁচে না, কারণ একবার কেউ নতুন মান দেখে ফেললে, তার পরে শুরু হওয়া সবাইকে দেখতে হবে।) **Sequential — হ্যাঁ:** P3 এর পড়া লেখার আগে বসাও (P3 এর আর কোনো operation নেই), তারপর লেখা, তারপর P2 — প্রতিটা client এর নিজের ক্রম ঠিক। Causal, read-your-writes, monotonic — সবই ✓ (কারো নিজের ইতিহাসে কিছু ভাঙেনি, আর P3 কোনো কার্যকারণের শিকলে নেই)। বাস্তবে: লেখা primary তে হয়ে একটা replica তে পৌঁছেছে কিন্তু অন্যটায় এখনো না; P2 দ্রুত replica থেকে পড়েছে, P3 ধীরটা থেকে। অথবা leaderless quorum এ লেখা চলার মাঝে দুটো read দুটো ভিন্ন replica জোড়া পেয়েছে (6.3)। এটাকে কখনো কখনো "new-old inversion" বলে। Exercise এর experiment ১ এ checker দিয়ে যাচাই করা যায় (উত্তর: linearizable ✗, বাকি সব ✓)।

**প্রশ্ন ২:** "Strongly consistent" যদি linearizable মানে, তাহলে CAP (5.9) বলে: network partition এ linearizable থাকতে হলে কোনো একটা দিককে উত্তর দেওয়া বন্ধ করতে হবে — তাই "always available" একসাথে অসম্ভব। (Partition না থাকলেও "globally distributed" + linearizable মানে প্রতিটা লেখায় মহাদেশ পেরোনো round trip — PACELC এর দাম।) তাই দাবিটার কোনো একটা শব্দ আসলে দুর্বল। চারটা প্রশ্ন: (১) "strongly consistent" বলতে ঠিক কোন model — linearizable, serializable, নাকি শুধু read-your-writes? (২) দুই region এর মধ্যে link কাটলে কোন দিক লেখা নেওয়া বন্ধ করে, আর কোন দিক পড়া? (৩) Read এর default কী — leader/quorum থেকে, নাকি কাছের replica থেকে (তাহলে default এ strong না)? (৪) স্বাধীন কোনো পরীক্ষা (Jepsen বা এরকম) হয়েছে, আর কী পাওয়া গেছে? বাস্তবে এমন বেশিরভাগ দাবির মানে "স্বাভাবিক সময়ে strong, partition এ minority দিক বন্ধ" — যেটা সম্পূর্ণ যুক্তিসঙ্গত, শুধু "always available" অংশটা marketing।

**প্রশ্ন ৩:** User এর চোখে model হলো তিনটা স্তরের মধ্যে **সবচেয়ে দুর্বলটা**:

- Postgres primary তে `SERIALIZABLE` — transaction এর isolation ঠিক, কিন্তু এটা শুধু primary তে লেখা/পড়া transaction এর কথা বলে।
- Version token দিয়ে replica থেকে read — এক key তে sequential/causal পর্যন্ত (exercise এর মতো), কিন্তু linearizable না: অন্য user এর সদ্য edit দেখা নিশ্চিত না।
- সামনে ৩০ সেকেন্ডের cache — এটা সবচেয়ে নিচে নামায়। Cache এ token নেই, তাই user নিজের সদ্য লেখা task ও ৩০ সেকেন্ড না দেখতে পারে (read-your-writes ভাঙে), আর cache এর ভিন্ন key ভিন্ন সময়ে ভরা হলে refresh এ পুরনো মান ফিরে আসতে পারে (monotonic ভাঙে)। User এর চোখে: **eventual, ৩০ সেকেন্ডের জানালায়**।

তাই "strongly consistent" দাবিটা ভুল — `SERIALIZABLE` একটা স্তরের কথা, user এর দেখা পুরো পথের না। ঠিক করার উপায় (Module 4 + 6.3 মিলিয়ে): লেখার পরে cache invalidate (4.3), আর cache key এ version token এর ধারণা যোগ — যেমন user এর token এর চেয়ে পুরনো cache entry ব্যবহার না করা, বা সদ্য লিখেছে এমন user এর জন্য cache এড়ানো।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (deterministic)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-6.5-consistency-models/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.5-consistency-models) — `npm install`, তারপর `npm run models` আর `npm run jepsen`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`checker.ts` এ ছয়টা model এর checker — linearizable আর sequential এর জন্য সম্ভাব্য সারি খোঁজা (backtracking + memo), causal এর জন্য happens-before (6.4), আর session guarantee গুলোর সরাসরি যাচাই। `models.ts` Module 5–6 এর সাতটা ঘটনা, `jepsen.ts` চারটা simulated system।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; দুটো script দুবার করে চালিয়ে হুবহু একই output; "এক primary" system এর ৩০০টা history তে সব model ১০০% — checker এর একটা sanity check। প্রশ্ন ১ এর history ও checker দিয়ে যাচাই করা হয়েছে। এটা একটা শেখার checker — ছোট history, একটা বা দুটো key; আসল Jepsen (Knossos, Elle) অনেক বড় history আর transaction সামলায়।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে হাতে:** `models.ts` এর সাতটা history কাগজে আঁকো (সময়ের রেখায়), আর চালানোর **আগে** table এর প্রতিটা ঘর অনুমান করো। তারপর চালিয়ে মেলাও। কোন ঘরে ভুল করেছিলে, আর কোন নিয়মটা বুঝতে ভুল হয়েছিল?

2. **নিজের history** (experiment ১): প্রশ্ন ১ এর history যোগ করো। তারপর এমন একটা history নিজে বানাও যেটা **causal কিন্তু sequential না** — দুজন client দুটো concurrent write কে ভিন্ন ক্রমে দেখে। (ইঙ্গিত: দুটো write, দুজন পাঠক, প্রত্যেকে দুবার পড়ে।)

3. **দুটো key** (experiment ২): version token system এ দ্বিতীয় key যোগ করো। Causal এর শতাংশ কমে কি? কোন ধরনের history তে ভাঙে — ১.৪ এর কোন উদাহরণের মতো?

4. **Checker ভাঙো** (experiment ৪): `linearizable()` এর নিয়ম ভুল করো (`a.end < b.start` → `a.start < b.start`)। কোন history গুলোর উত্তর বদলায়, আর এই ভুল নিয়মটা আসলে কী মাপছে? (একটা checker এর bug কত সহজে একটা system কে "সঠিক" বা "ভাঙা" দেখায় — এটাই শিক্ষা।)

5. **Design অংশ:** TaskFlow এর design doc এর "consistency" section টা লেখো — ১.৯ এর table কে নিজের মতো করে, কমপক্ষে সাতটা data (cache আর CDN সহ!) এর জন্য: model এর নাম, কীভাবে পাওয়া (কোন lesson এর কৌশল), আর "user এর চোখে সবচেয়ে খারাপ কী দেখা যায়, কতক্ষণের জন্য"। তারপর vendor এর দাবির উত্তরে CTO কে চার লাইন (প্রশ্ন ২)।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (সম্পূর্ণ, exit challenge সহ), 6.1, 6.2, 6.3, 6.4, 6.5
Current: 6.5 — Consistency Models (Module 6 এর শেষ lesson)
TaskFlow state: Nginx + Express instance গুলো, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; design doc এ data ধরে consistency model: leader/lock →
linearizable (etcd), billing/permission → strict serializable (primary, SERIALIZABLE), task
list → RYW + monotonic (version token), comment → causal (task দিয়ে shard), count/presence →
eventual (quorum + read repair); cache/CDN এর প্রভাব হিসাবে ধরা
Terms learned (Module 6): Partial Failure, Failure Model, Failure Detector, Process Pause,
Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility, Replicated State Machine,
Term, Randomized Election Timeout, Committed Entry, Election Restriction, Session Guarantee,
Monotonic Reads, Consistent Prefix Read, Version Token, Read Repair, Hinted Handoff,
Anti-Entropy, Monotonic Clock, Clock Skew/Drift, Happens-Before, Lamport Clock, Vector Clock,
Sibling, Hybrid Logical Clock, Consistency Model, Operation History, Linearization Point,
Sequential Consistency, Causal Consistency, Strict Serializability
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: Module 6 Exit Challenge
=======================
```

---

## ৮. পরের ধাপ

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের "causal কিন্তু sequential না" history আর ৫ নম্বরের design doc এর section। এটা Module 6 এর শেষ lesson। রেডি হলে `next` লিখো — **Module 6 Exit Challenge** এ যাব: একটা mini design challenge (Tier 3) যেখানে পুরো module — failure model, split brain আর fencing, consensus, session guarantee, logical clock, consistency model — একটা বাস্তব scenario তে একসাথে লাগবে; একটা "তুমি এগুলো পারার কথা" checklist; আর বই, ভিডিও, project এর recommendation। তারপর Module 7 — Asynchronous Processing & Messaging: এতক্ষণ সব কথা ছিল "একটা request, একটা উত্তর" নিয়ে; এবার কাজ পরে করা, queue, আর retry এর জগৎ — যেখানে আজকের "exactly once" এর প্রশ্নগুলো নতুন রূপে ফিরবে।
