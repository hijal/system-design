# Lesson 6.3 — Quorum in Practice: Replication Lag, Read-Your-Writes, Monotonic Read

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 4.3):** Cache-aside এ একটা task এর title update হলো, কিন্তু cache invalidate করা হলো না, আর TTL ১০ মিনিট। User কী দেখবে, কতক্ষণ? আর invalidate করলেও কোন একটা race এ cache এ আবার পুরনো মান ঢুকে যেতে পারে?

**Prerequisite:** Lesson 5.7 (Replication lag, read-your-writes, LSN), Lesson 5.8 (Partition, shard key), Lesson 5.9 (Quorum, `R + W > N`), Lesson 6.2 (Linearizable read)

**তুমি এই lesson শেষে পারবে:**

1. Replica থেকে পড়ার সময় user এর চোখে কী কী অদ্ভুত জিনিস ঘটে — নিজের লেখা না দেখা, সময় পেছনে যাওয়া, উত্তর আগে প্রশ্ন পরে — তিনটা আলাদা **session guarantee** হিসেবে চিনতে পারবে, আর কোনটা কোন সমাধান ঠিক করে আর কোনটা করে না, মেপে জানবে
2. Version token দিয়ে read-your-writes আর monotonic read একসাথে দিতে পারবে — আর token টা কোথায় রাখলে একাধিক device এও কাজ করে, সেটা জানবে
3. `R + W > N` বাস্তবে কেন যথেষ্ট না (ব্যর্থ লেখা, sloppy quorum) ব্যাখ্যা করতে পারবে, আর read repair, hinted handoff, anti-entropy কী মেরামত করে জানবে

**Tier:** 1 — Runnable Code (তিনটা seed দেওয়া simulation)

---

## ০. TaskFlow এখন কোথায়

Lesson 5.7 এর পরে TaskFlow এর read এর চাপ আরও বেড়েছে। এখন primary এর সাথে **তিনটা** read replica, আর Sequelize read গুলো পালা করে তিনটায় পাঠায়। 5.7 এর read-your-writes সমাধানটাও আছে: যে device গত ৫ সেকেন্ডে কিছু লিখেছে, তার read primary তে যায় (একটা cookie তে শেষ লেখার সময় রেখে)।

তবু support এ তিন ধরনের নতুন ticket:

1. **"Task টা দেখলাম, refresh করলাম, উধাও! আবার refresh করলে ফিরে আসে।"** — 5.7 এ যেটার শুধু নাম নিয়ে রেখেছিলাম।
2. **"Phone এ task বানালাম, laptop খুলে দেখি নেই।"** — cookie টা phone এর, laptop তার কথা জানে না।
3. **"Thread এ করিমের উত্তর 'আজ রাত ৯টায়' দেখাচ্ছে, কিন্তু রহিমের প্রশ্নটা নেই — মনে হচ্ছে করিম পাগলের মতো একা কথা বলছে।"** — comment table এখন দুটো partition এ ভাগ (5.8), shard key `commentId`।

আর আরেক জায়গায় একটা অদ্ভুত bug: notification এর unread count (5.9 এ এটাকে AP ধরে একটা leaderless quorum store এ রাখা হয়েছিল, `N = 3, W = 2, R = 2`) — একজন user বলছে count ৫ দেখাচ্ছে, তারপর ৪, তারপর আবার ৫। অথচ `R + W > N`!

6.2 তে দেখেছ, সবকিছু consensus দিয়ে পড়লে (linearizable read) এসব সমস্যা থাকে না — কিন্তু প্রতিটা read এ majority এর round trip, যেটা TaskFlow এর লাখ লাখ read এ দেওয়া যায় না। আজকের প্রশ্ন: replica থেকে পড়ব, সস্তায় — কিন্তু user কে **ঠিক কোন নিশ্চয়তা** দেব, আর সেটার দাম কত?

---

## ১. Theory

### ১.১ "Eventually" — কিন্তু তার আগে কী?

Replica থেকে পড়া মানে **eventual consistency** (5.9): নতুন লেখা বন্ধ হলে একসময় সব replica এক হবে। কিন্তু "একসময়" এর কোনো সীমা নেই, আর তার আগে পর্যন্ত যেকোনো কিছু দেখা যেতে পারে। User এর চোখে সেটা তিন রকম ভাঙন হিসেবে ধরা পড়ে — আর তিনটা আলাদা, আলাদা সমাধান।

1994 সালে Xerox PARC এর Bayou project এর গবেষকরা (Douglas Terry ও সহকর্মীরা) এই "মাঝামাঝি" নিশ্চয়তাগুলোর নাম দেন:

**Session guarantee** — পুরো system strongly consistent না হলেও, **একজন user এর নিজের** পড়া-লেখার ক্রম নিয়ে একটা সীমিত নিশ্চয়তা — "অন্তত তোমার নিজের চোখে জিনিসগুলো যুক্তিসঙ্গত দেখাবে।"

মূল কৌশল: বিশ্বকে সামঞ্জস্যপূর্ণ করার বদলে **একজন user এর দেখা** সামঞ্জস্যপূর্ণ রাখা। এটা অনেক সস্তা, কারণ একজন user এর ইতিহাস ছোট।

আজ তিনটা:

| নিশ্চয়তা              | ভাঙলে user দেখে                                | TaskFlow ticket |
| ---------------------- | ---------------------------------------------- | --------------- |
| Read-your-writes (5.7) | নিজের সদ্য লেখা নেই                            | ২ (অন্য device) |
| Monotonic reads        | একবার দেখা জিনিস পরের পড়ায় উধাও — সময় পেছনে | ১               |
| Consistent prefix      | ফল আছে, কারণ নেই — উত্তর আছে, প্রশ্ন নেই       | ৩               |

(বাকি দুটো — monotonic writes আর writes-follow-reads — লেখার ক্রম নিয়ে; single-leader database এ primary এগুলো নিজেই দেয়, তাই আজ বাদ।)

### ১.২ Replication Lag বাস্তবে — গড় না, লেজ

5.7 এ দেখেছ: একই machine এ, load ছাড়া lag ~২ ms। তাহলে তিনটা replica তে সমস্যা এত বেশি কেন?

কারণ সমস্যা তৈরি করে **গড় lag না — লেজ।** Replica বেশিরভাগ সময় কয়েক ms পিছিয়ে, কিন্তু মাঝে মাঝে কয়েক **সেকেন্ড** আটকে যায়। আর replica লেখা ক্রমানুসারে প্রয়োগ করে — একটা আটকালে তার পেছনের সব লেখা আটকায়।

Postgres এর replica কেন আটকায়, তার একটা কম পরিচিত কিন্তু খুব সাধারণ কারণ: **replica তে চলা একটা লম্বা query।** ধরো analytics এর একটা report replica তে ৪০ সেকেন্ড ধরে চলছে, আর primary থেকে আসা WAL এ এমন একটা পরিবর্তন আছে (যেমন vacuum এর মুছে ফেলা row) যেটা প্রয়োগ করলে ওই query এর দেখা data নষ্ট হবে। Postgres তখন একটা বাছাই করে: query টা cancel করবে, নাকি WAL প্রয়োগ **থামিয়ে** অপেক্ষা করবে? এর সীমা ঠিক করে `max_standby_streaming_delay` — default **৩০ সেকেন্ড**। মানে default setting এ, একটা লম্বা report এর জন্য replica পুরো ৩০ সেকেন্ড পিছিয়ে থাকতে পারে, আর সেই সময়ে ওই replica থেকে পড়া প্রতিটা user ৩০ সেকেন্ড পুরনো জগৎ দেখে।

(বাকি কারণগুলো চেনা: বড় migration এর WAL এর ঢেউ, replica এর ধীর disk, network। আর নজর রাখার জায়গা: primary তে `pg_stat_replication` এর `replay_lag`, replica তে `now() - pg_last_xact_replay_timestamp()` — 5.7 এর exercise এ দেখেছ।)

Exercise এর simulation এ তিনটা replica এর মডেল ঠিক এমন: r1 সবসময় দ্রুত (গড় ~৩ ms), r2 একটু ধীর আর কদাচিৎ ১.৫ s আটকায়, r3 ধীর (গড় ~২৫ ms) আর মাঝে মাঝে ৩ s আটকায়। (সংখ্যাগুলো ধরে নেওয়া — আকৃতিটা আসল।)

### ১.৩ Monotonic Reads — সময় যেন পেছনে না যায়

**Monotonic reads** — একজন user একবার কোনো অবস্থা দেখলে, পরের কোনো পড়ায় তার চেয়ে **পুরনো** অবস্থা দেখবে না। (নতুন না দেখলেও চলে — শুধু পেছনে যাওয়া নিষেধ।)

Ticket ১ কীভাবে হয়:

```
   সময় →        t1: refresh                       t2: refresh
   user ───────► r1 (দ্রুত, LSN 500)  ✓ task আছে
                                           ──────► r3 (আটকে আছে, LSN 420)  ✗ task নেই!
   Load balancer পালা করে পাঠাচ্ছে — দুটো পড়া দুটো ভিন্ন replica তে, একটা অন্যটার চেয়ে পিছিয়ে
```

সবচেয়ে সহজ সমাধান: **একজন user এর সব পড়া সবসময় একই replica তে** (userId বা session এর hash দিয়ে replica বাছা)। একটা replica নিজে কখনো পেছনে যায় না — তাই তার থেকে পরপর পড়া monotonic।

Exercise এর `npm run session` — ২০০০ বার "একটা task বানাও, তারপর পাঁচবার পড়ো" (redirect এ +5 ms, তারপর +30 ms, +300 ms, +1 s, +3 s; প্রথম দুটো একই device এ, বাকিগুলোর অর্ধেক অন্য device এ):

```
                                              নিজের লেখা দেখেনি              সময় পেছনে    read primary তে
   কৌশল                                       একই device    অন্য device      গেছে
   ক. যেকোনো replica (random)                 29.1%         0.9%         4.0%         0.0%
   খ. device প্রতি একটা নির্দিষ্ট replica     29.6%         1.0%         0.6%         0.0%
```

Sticky replica "সময় পেছনে" ৪% থেকে ০.৬% এ নামিয়েছে — কিন্তু শূন্যে না। বাকি ০.৬% কোথা থেকে? একই **user** এর দুটো **device** দুটো ভিন্ন replica তে sticky — phone r1 এ, laptop r3 এ। User এর চোখে সময় তবু পেছনে যায়। আর sticky এর আরও দুটো দুর্বলতা:

- **"নিজের লেখা দেখেনি" কলাম একটুও বদলায়নি (২৯%)** — sticky replica ও তো পিছিয়ে; monotonic মানে শুধু পেছনে না যাওয়া, নতুন দেখা না।
- **Replica বদলালেই নিশ্চয়তা যায়।** Replica মরলে বা নতুন replica যোগ হলে (hash বদলায়) user অন্য replica তে যায় — যেটা হয়তো পেছনে। আর hash দিয়ে ভাগ করায় একটা "ভারী" user এর সব read এক replica তে পড়ে (5.8 এর hot partition এর ছোট রূপ)।

### ১.৪ Read-Your-Writes, এবার একাধিক Device এ — Version Token

5.7 এ read-your-writes এর তিনটা সমাধান দেখেছিলে। TaskFlow বেছেছিল সবচেয়ে ব্যবহারিকটা: সদ্য লিখেছে এমন device এর read primary তে। এর দাম আর সীমা মাপো:

```
   গ. cookie: ৫ s এর মধ্যে লিখলে primary       0.0%         0.9%         0.3%        73.4%
```

নিজের device এ নিখুঁত — কিন্তু দুটো সমস্যা। প্রথমত, **অন্য device এর কলাম (০.৯%) random এর মতোই** — laptop phone এর cookie দেখে না (ticket ২)। দ্বিতীয়ত, **৭৩% read primary তে।** এই workload এ প্রতিটা লেখার পরে ৫টা পড়া ৫ সেকেন্ডের মধ্যে — তাই প্রায় সব পড়াই "সদ্য লেখার পরে"। Cookie জানে না replica **আসলে** পিছিয়ে কিনা; সে শুধু সময় দেখে, আর সাবধান থাকতে প্রায় সব primary তে পাঠায়। Replica রাখার লাভ প্রায় পুরোটাই শেষ।

ভালো সমাধানটা 5.7 এর LSN এর ধারণা থেকে আসে, একটু বাড়িয়ে:

**Version token** — client যে সবচেয়ে নতুন version (Postgres এ LSN) লিখেছে বা দেখেছে, তার একটা চিহ্ন; প্রতিটা পড়ার সাথে পাঠানো হয়, আর শুধু সেই replica উত্তর দেয় যে অন্তত ততদূর পৌঁছেছে।

```
   লেখা      → primary বলে "তোমার লেখা LSN 812 এ"          → token = 812
   পড়া      → r3: "আমি 790 পর্যন্ত"  ✗ যথেষ্ট না
             → r1: "আমি 815 পর্যন্ত"  ✓ উত্তর দাও            → token = max(812, 815) = 815
   পরের পড়া → token 815 — এর চেয়ে পুরনো replica কখনো উত্তর দেবে না
```

একটা token দুটো নিশ্চয়তা দেয়: token এ নিজের লেখার LSN থাকে → **read-your-writes**; token এ দেখা সবচেয়ে নতুন LSN থাকে → **monotonic reads**। আর primary তে যায় শুধু তখন, যখন **আসলেই** কোনো replica এগিয়ে নেই।

এখন শুধু প্রশ্ন: token কোথায় থাকবে?

```
   ঘ. version token — device এ (cookie)        0.0%         0.8%         0.4%         3.4%
   ঙ. version token — user এর (server এ)       0.0%         0.0%         0.0%         3.4%
```

দুটোর code প্রায় হুবহু এক, primary এর চাপ ও এক (৩.৪% — cookie এর ৭৩.৪% এর তুলনায়)। একমাত্র পার্থক্য: (ঘ) token রাখে device এর cookie তে, তাই laptop phone এর token জানে না। (ঙ) রাখে **server এ, user এর নামে** — যেমন Redis এ `rw-token:{userId}` — তাই যেকোনো device এর যেকোনো পড়া সেই token দেখে। তিনটা কলামই শূন্য।

বাস্তবে: Postgres এ token হলো `pg_current_wal_lsn()` (লেখার পরে primary তে) আর যাচাই `pg_last_wal_replay_lsn()` (replica তে)। MongoDB এর "causal consistency" session ঠিক এই কাজ করে — driver প্রতিটা উত্তরের `operationTime` মনে রাখে আর পরের পড়ায় `afterClusterTime` হিসেবে পাঠায়। DynamoDB সরাসরি এটা দেয় না; সেখানে প্রতিটা read এ বাছতে হয় — eventually consistent (সস্তা) নাকি `ConsistentRead` (দ্বিগুণ দাম, leader থেকে)।

### ১.৫ Consistent Prefix — উত্তর আগে, প্রশ্ন পরে

Ticket ৩ একটু আলাদা, কারণ এখানে কোনো user নিজের কিছু পড়ছে না — সে **অন্য দুজনের** কথোপকথন দেখছে।

**Consistent prefix read** — লেখাগুলো যে ক্রমে ঘটেছে, পাঠক সেগুলো সেই ক্রমের একটা **শুরুর অংশ** হিসেবে দেখবে: পরেরটা দেখলে আগেরটাও দেখবে। (সব না দেখলেও চলে — কিন্তু ফাঁক দিয়ে না।)

একটা replica থেকে পড়লে এটা আপনা আপনি পাওয়া যায় — replica লেখা ক্রমানুসারে প্রয়োগ করে। সমস্যা হয় যখন data **কয়েকটা partition এ** ভাগ, আর প্রতিটার নিজের replica, নিজের lag:

```
   partition 1 (replica আটকে আছে)          partition 2 (replica দ্রুত)
   রহিম: "deploy কখন?"   ← এখনো পৌঁছায়নি   করিম: "আজ রাত ৯টায়"   ← পৌঁছে গেছে
                              ╲                  ╱
                               পাঠক দুটো থেকে একসাথে পড়ে
                               → উত্তর আছে, প্রশ্ন নেই
```

Exercise এর `npm run prefix` — ৫০০০টা প্রশ্ন-উত্তর, প্রতিটা thread ২০ বার পড়া:

```
   shard key       উত্তর দেখা গেছে     উত্তর আছে কিন্তু প্রশ্ন নেই
   commentId            65426             250
   taskId               66059               0
```

২৫০ বার অদ্ভুত thread — ০.৪%, কিন্তু প্রতিটা একটা ticket। আর `taskId` এ **শূন্য**, আর এটা ভাগ্য না: একই task এর সব comment একই partition এ, মানে একটা replica, মানে ক্রমানুসারে। Lesson 5.8 এর shard key এর নিয়মের নতুন একটা কারণ: **যে data গুলোর মধ্যে কার্যকারণ সম্পর্ক আছে (প্রশ্ন → উত্তর, task → তার comment), সেগুলো একই partition এ রাখো।** TaskFlow এর `workspaceId` shard key (5.8) এই কারণেও ভালো।

যেখানে সেটা সম্ভব না (যেমন একটা activity feed যেটা অনেক partition থেকে আসে), সেখানে লেখার সাথে তার "নির্ভরতা" রাখতে হয় — "এই উত্তর ওই প্রশ্নের পরে" — আর পাঠক নির্ভরতা না দেখা পর্যন্ত উত্তর লুকিয়ে রাখে। এটাই **causal consistency** এর ধারণা, আর নির্ভরতা কীভাবে track করতে হয় (ঘড়ি দিয়ে না) — সেটা Lesson 6.4 এর vector clock।

### ১.৬ Quorum বাস্তবে — `R + W > N` কেন যথেষ্ট না

এবার unread count এর bug। Lesson 5.9 এর যুক্তি: `R + W > N` হলে পড়ার quorum আর লেখার quorum অন্তত একটা replica তে মেলে, তাই পড়া সর্বশেষ লেখা দেখে। যুক্তিটা ঠিক — **যদি লেখা সফল হয়**। কিন্তু লেখা ব্যর্থ হলে?

Leaderless store এ একটা লেখা ব্যর্থ হওয়ার মানে: `W` টা replica নিশ্চিত করেনি। কিন্তু যে কয়টা লেখাটা পেয়েছে, তাদের থেকে লেখাটা **মুছে ফেলা হয় না** — কোনো rollback নেই। (5.7 এর sync commit এর timeout মনে করো: "timeout মানে rollback না"। একই শিক্ষা, অন্য জায়গায়।)

Exercise এর `npm run quorum`: `N = 3, W = 2, R = 2`। লেখা v1 শুধু A তে পৌঁছেছে, B আর C timeout — client কে বলা হয়েছে "ব্যর্থ"। তারপর ১০০ জন user × ৫ বার পড়া, প্রতিটা পড়া random দুটো replica থেকে:

```
   read repair    "ব্যর্থ" v1 দেখেছে      v1 দেখার পরে আবার v0     মান ওঠানামা করেছে এমন user    শেষ অবস্থা
   বন্ধ             325/500                 84                      58                A=v1 B=v0 C=v0
   চালু             500/500                  0                       0                A=v1 B=v1 C=v1
```

প্রথম সারিটা unread count এর bug হুবহু। যে পড়া A কে জিজ্ঞেস করে, সে v1 দেখে; যে B আর C কে জিজ্ঞেস করে, সে v0। ৫৮ জন user মান ওঠানামা করতে দেখেছে — ৫, ৪, ৫। `R + W > N` আছে, তবু **monotonic read নেই**।

**Read repair** — পড়ার সময় কয়েকটা replica থেকে উত্তর এলে, যে replica পুরনো মান দিল তাকে নতুনটা লিখে দেওয়া।

দ্বিতীয় সারিতে read repair চালু: ওঠানামা শূন্য। কিন্তু **শেষ অবস্থাটা দেখো**: A=v1 B=v1 C=v1। Client কে যে লেখাকে "ব্যর্থ" বলা হয়েছিল, read repair সেটাকেই সব replica তে ছড়িয়ে স্থায়ী করে দিয়েছে। সিস্টেম এখন সামঞ্জস্যপূর্ণ — কিন্তু client এর বিশ্বাসের সাথে না। তাই leaderless store এ "লেখা ব্যর্থ" এর আসল মানে: **"জানি না — হয়তো হয়েছে।"** ঠিক উত্তর আবার সেই পুরনো দুটো: retry করো (একই মান লেখা idempotent), অথবা পড়ে দেখো।

`R + W > N` এর আরও কয়েকটা বাস্তব ফাঁক:

- **একসাথে লেখা আর পড়া:** লেখা এখনো কিছু replica তে পৌঁছাচ্ছে, এর মধ্যে একটা পড়া নতুনটা দেখল, আরেকটা পুরনোটা — কোনটা "সঠিক", ঠিক করা নেই।
- **Last-write-wins আর ঘড়ি:** দুটো লেখার কোনটা "নতুন", প্রায়ই timestamp দিয়ে ঠিক হয় — আর 6.1 এ বলেছি ঘড়ি বিশ্বাস করা যায় না। (5.9 এর partition exercise এ n4 এর ৩০০ ms পিছিয়ে থাকা ঘড়ি একটা লেখা হারিয়েছিল — পুরো গল্প 6.4 এ।)
- **Sloppy quorum:** নিচে।

**Hinted handoff আর sloppy quorum।** Amazon এর Dynamo (2007 সালের paper, আজকের Cassandra আর DynamoDB এর পূর্বপুরুষ) একটা availability এর কৌশল নিয়েছিল: একটা key এর তিনটা "নিজের" replica এর একটা মৃত হলে, লেখাটা অন্য কোনো জীবিত node নিয়ে রাখে, একটা "hint" সহ — "এটা আসলে C এর; C ফিরলে দিয়ে দিও।"

**Hinted handoff** — কোনো replica সাময়িকভাবে না থাকলে তার ভাগের লেখা অন্য node এ রাখা, আর সে ফিরলে পৌঁছে দেওয়া।

এতে লেখা সফল হয় (W টা node পেয়েছে) — কিন্তু সেই W টা node হয়তো key এর "নিজের" N টার মধ্যে না। তখন পড়ার quorum (নিজের N টা থেকে R টা) আর লেখার quorum না-ও মিলতে পারে। একে বলে **sloppy quorum** — `R + W > N` কাগজে আছে, কিন্তু মেলার নিশ্চয়তা নেই। Availability এর বদলে consistency ছাড়া — 5.9 এর AP বাছাই, এবার একটা নির্দিষ্ট mechanism এর ভেতরে।

**Anti-entropy।** Read repair শুধু সেই key ঠিক করে যেটা কেউ পড়ে। কদাচিৎ পড়া data বছরের পর বছর অমিল থাকতে পারে। তাই পেছনে একটা process চলে:

**Anti-entropy** — replica গুলোর পুরো data নিয়মিত তুলনা করে অমিল খুঁজে ঠিক করার পেছনের process; সাধারণত Merkle tree দিয়ে (data এর অংশগুলোর hash এর গাছ — শুধু যে অংশের hash মেলে না, সেটাই পাঠাতে হয়)। Cassandra তে এটা `nodetool repair`।

**Tunable consistency।** Cassandra প্রতিটা query তে বাছতে দেয় কত replica লাগবে: `ONE` (দ্রুত, কম নিশ্চয়তা), `QUORUM` (majority), `LOCAL_QUORUM` (শুধু নিজের data center এর majority — অন্য region এর round trip ছাড়া), `ALL`। মানে 5.9 এর PACELC বাছাই, প্রতিটা query তে আলাদা করে।

> **Trade-off Table — Replica থেকে পড়ার নিশ্চয়তা**

| কৌশল                                    | Read-your-writes | Monotonic reads  | Consistent prefix    | দাম                                                 |
| --------------------------------------- | ---------------- | ---------------- | -------------------- | --------------------------------------------------- |
| যেকোনো replica                          | না               | না               | এক partition এ হ্যাঁ | শূন্য                                               |
| User/device প্রতি sticky replica        | না               | device এ হ্যাঁ\* | এক partition এ হ্যাঁ | load অসমান; replica বদলালে নিশ্চয়তা যায়           |
| সদ্য লিখেছে → primary (cookie)          | device এ হ্যাঁ   | না               | —                    | primary এর উপর বড় চাপ (exercise এ ৭৩%)             |
| Version token, device এ                 | device এ হ্যাঁ   | device এ হ্যাঁ   | —                    | token বহন, মাঝে মাঝে primary (৩.৪%)                 |
| Version token, user এর (server এ)       | হ্যাঁ            | হ্যাঁ            | —                    | + একটা shared store (Redis) এ token                 |
| কার্যকারণ-সম্পর্কিত data এক partition এ | —                | —                | হ্যাঁ                | shard key বাছাইয়ে সীমাবদ্ধতা (5.8)                 |
| Quorum + read repair                    | সফল লেখায়       | মোটামুটি         | —                    | পড়ায় বাড়তি লেখা; "ব্যর্থ" লেখাও স্থায়ী হতে পারে |
| Linearizable read (6.2)                 | হ্যাঁ            | হ্যাঁ            | হ্যাঁ                | প্রতিটা read এ majority/leader এর round trip        |

\* replica মরা বা বদলানো পর্যন্ত

---

## ২. Interview Angle

**"Read replica যোগ করলে কী সমস্যা হয়?"** — 5.7 এ শিখেছ "read-your-writes" বলতে। এখন পুরো পরিবার বলো: "তিনটা session guarantee ভাঙে — নিজের লেখা না দেখা, refresh এ সময় পেছনে যাওয়া, আর partition করা data এ কারণের আগে ফল দেখা।" তারপর সমাধান: version token (user এর নামে, server এ) — "LSN token দিয়ে read-your-writes আর monotonic read দুটোই পাই, আর primary তে যায় শুধু যখন সত্যিই কোনো replica এগিয়ে নেই।" এই বাক্যটা senior উত্তর।

**"Timeline/feed এ কেউ কেউ উত্তর আগে দেখছে — কেন?"** — consistent prefix; data কয়েকটা partition এ, প্রতিটার আলাদা lag। সমাধান: সম্পর্কিত data এক partition এ (thread/task/conversation দিয়ে shard); না পারলে causal dependency track করা।

**"Cassandra তে QUORUM দিয়ে পড়ি আর লিখি — তাহলে তো strongly consistent?"** — না, আর কারণ বলো: ব্যর্থ লেখা কিছু replica তে থেকে যায় আর read repair এ ছড়ায়; sloppy quorum এ quorum না-ও মিলতে পারে; আর concurrent লেখায় LWW ঘড়ির উপর নির্ভর করে। "Strong" লাগলে consensus-ভিত্তিক store (6.2), বা Cassandra এর lightweight transaction (যেটা ভেতরে Paxos চালায় — আর দামি)।

**Production এ বাস্তবে:** বেশিরভাগ team "সদ্য লিখেছে → primary" দিয়ে শুরু করে আর সেখানেই থাকে — আর সেটা প্রায়ই যথেষ্ট। Traffic বাড়লে বা mobile + web দুই client হলে version token এ যায়। দুটোর আগে যা করতে হয়: **replica lag এ alert** (`replay_lag` বা replica তে `now() - pg_last_xact_replay_timestamp()`), আর replica তে লম্বা analytics query আলাদা replica তে পাঠানো — যাতে `max_standby_streaming_delay` এর ৩০ সেকেন্ড user এর replica তে না পড়ে।

---

## ৩. Key Takeaway

- Replica থেকে পড়া মানে eventual consistency — আর "eventually" এর আগে user তিন রকম ভাঙন দেখে; তিনটা আলাদা **session guarantee**, আলাদা সমাধান
- সমস্যা আসে lag এর **লেজ** থেকে, গড় থেকে না — Postgres replica একটা লম্বা query এর জন্য default এ ৩০ সেকেন্ড পর্যন্ত WAL replay থামিয়ে রাখতে পারে (`max_standby_streaming_delay`)
- **Monotonic reads:** sticky replica "সময় পেছনে" কমায় (৪% → ০.৬%), কিন্তু একাধিক device, replica বদল, আর নিজের লেখা দেখানো — কোনোটাই ঠিক করে না
- "সদ্য লিখেছে → primary" (cookie) নিজের device এ কাজ করে, কিন্তু অন্য device এ না, আর exercise এ ৭৩% read primary তে ঠেলে দিয়েছে
- **Version token** (LSN) দুটো নিশ্চয়তা একসাথে দেয়, primary তে যায় শুধু সত্যিকারের দরকারে (৩.৪%); token **user এর নামে server এ** রাখলে সব device এ কাজ করে
- **Consistent prefix:** কার্যকারণ-সম্পর্কিত data এক partition এ রাখো (`taskId` দিয়ে shard এ শূন্য অদ্ভুত thread); না পারলে নির্ভরতা track করো (6.4)
- `R + W > N` ব্যর্থ লেখায় ভাঙে — "ব্যর্থ" লেখা কিছু replica তে থাকে, পাঠকেরা মান ওঠানামা করতে দেখে; **read repair** সেটা থামায় কিন্তু লেখাটাকে স্থায়ী করে। Hinted handoff/sloppy quorum availability এর জন্য নিশ্চয়তা ছাড়ে; anti-entropy ভুলে যাওয়া অমিল ঠিক করে

---

## ৪. নতুন Term (Glossary)

| Term                       | অর্থ                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Session Guarantee**      | পুরো system strongly consistent না হলেও একজন user এর নিজের পড়া-লেখার ক্রম নিয়ে সীমিত নিশ্চয়তা (Bayou, 1994)     |
| **Monotonic Reads**        | একবার কোনো অবস্থা দেখলে পরের পড়ায় তার চেয়ে পুরনো অবস্থা দেখা যাবে না — সময় পেছনে যাবে না                       |
| **Consistent Prefix Read** | লেখাগুলো যে ক্রমে ঘটেছে, পাঠক সেই ক্রমের একটা শুরুর অংশ দেখবে — পরেরটা দেখলে আগেরটাও                               |
| **Version Token**          | Client এর লেখা বা দেখা সবচেয়ে নতুন version এর চিহ্ন (যেমন LSN); শুধু অন্তত ততদূর পৌঁছানো replica পড়ার উত্তর দেয় |
| **Read Repair**            | পড়ার সময় যে replica পুরনো মান দিল, তাকে নতুন মান লিখে দেওয়া                                                     |
| **Hinted Handoff**         | কোনো replica সাময়িক না থাকলে তার ভাগের লেখা অন্য node এ রাখা, সে ফিরলে পৌঁছে দেওয়া — এতে quorum "sloppy" হয়     |
| **Anti-Entropy**           | Replica গুলোর data নিয়মিত তুলনা করে (সাধারণত Merkle tree দিয়ে) অমিল খুঁজে ঠিক করার পেছনের process                |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এর একজন engineer বলল: "Version token এর ঝামেলা কেন? সব user কে একটা নির্দিষ্ট replica তে sticky করে দিই (userId এর hash), তাতেই তো monotonic read হয়ে যায়, আর read-your-writes এর জন্য cookie তো আছেই।" Exercise এর table দিয়ে এই প্রস্তাবের তিনটা দুর্বলতা বলো।
2. Version token (user এর নামে) Redis এ রাখা হলো: `rw-token:{userId}`। Redis এর সেই key হারিয়ে গেলে (Redis restart, eviction) কী হয়? Data নষ্ট হয়, নাকি শুধু নিশ্চয়তা কমে? Token এর TTL কত রাখবে, আর কেন?
3. TaskFlow এর notification count এর bug (৫, ৪, ৫) এর জন্য তিনটা প্রস্তাব এসেছে: (ক) read repair চালু করা, (খ) `W = 3` করা, (গ) count টাকে Postgres এ সরিয়ে নেওয়া। প্রতিটার দাম আর কী ঠিক করে, কী করে না — বলো। তুমি কোনটা নেবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

- **নিজের লেখা দেখা ঠিক হয় না** — sticky replica ও পিছিয়ে থাকে; table এ (খ) এর "একই device" কলাম ২৯.৬%, random এর চেয়ে ভালো না। Cookie যোগ করলে সেটা ঠিক হয় — কিন্তু তখন (গ) এর দাম: ৭৩% read primary তে।
- **একাধিক device** — userId দিয়ে sticky করলে phone আর laptop একই replica তে যায় (device দিয়ে করলে যেত না), তাই monotonic এর এই ফাঁক বন্ধ হয়। কিন্তু cookie এর read-your-writes তখনো শুধু এক device এ — ticket ২ রয়ে যায়।
- **Replica বদল** — replica মরলে বা নতুন replica যোগ হলে (hash এর ভাগ বদলায়) user অন্য replica তে যায়, যেটা হয়তো পিছিয়ে — ঠিক সেই মুহূর্তে সময় পেছনে যায়, যখন system এমনিতেই চাপে। আর hash দিয়ে ভাগ করলে load অসমান: একটা বড় team এর সবাই একই replica তে পড়লে সেটা ভারী।

Version token এই তিনটাই একসাথে ঠিক করে, আর কোনো user কে কোনো replica তে বাঁধে না — যেকোনো replica যথেষ্ট এগিয়ে থাকলেই চলে।

**প্রশ্ন ২:** Token হারালে **data নষ্ট হয় না** — token শুধু ঠিক করে কোন replica থেকে পড়া চলে। Token না থাকলে (০ ধরে নিলে) পড়া যেকোনো replica তে যায় — মানে সেই মুহূর্তের জন্য আমরা (ক) random এ ফিরে যাই: user হয়তো একবার নিজের লেখা দেখবে না, বা একবার সময় পেছনে যাবে। অর্থাৎ নিশ্চয়তা সাময়িকভাবে দুর্বল হয়, সঠিকতা না। এটা ভালো design এর লক্ষণ: token একটা optimization এর সহায়ক, সত্যের উৎস না। TTL: token এর কাজ শুধু replica lag এর জানালায় — replica গুলো সাধারণত কয়েক সেকেন্ডে, খারাপ হলে (`max_standby_streaming_delay`) ~৩০ সেকেন্ডে ধরে ফেলে। তাই TTL তার চেয়ে কিছু বেশি, যেমন ৫ মিনিট — তারপর যেকোনো replica নিশ্চিতভাবেই এগিয়ে থাকার কথা, token এর আর দরকার নেই, আর Redis এ লাখ লাখ পুরনো key জমে না। (বিকল্প: token Redis এ না রেখে session এর সাথে — যেমন SvelteKit এর server-side session — যদি session নিজেই সব device এ shared হয়।)

**প্রশ্ন ৩:**

- **(ক) Read repair:** ওঠানামা থামায় (exercise এ ৮৪ → ০), খরচ কম (পড়ায় মাঝে মাঝে একটা বাড়তি লেখা)। কিন্তু "ব্যর্থ" লেখা স্থায়ী হয়ে যায় — count টা হয়তো client এর বিশ্বাসের চেয়ে এক বেশি। Unread count এর জন্য এটা গ্রহণযোগ্য (ভুলটা ছোট আর user নিজেই পড়ে ঠিক করবে)।
- **(খ) `W = 3`:** প্রতিটা লেখা তিনটা replica কে নিশ্চিত করতে হবে — একটা replica ধীর বা মৃত হলেই **সব** লেখা ব্যর্থ (5.9 এর availability table)। আর মূল সমস্যা যায় না: `W = 3` এও লেখা A তে পৌঁছে বাকিদের timeout হতে পারে, আর A থেকে সেটা মুছে না — ব্যর্থ লেখার ভূত আবার ফেরে, শুধু আরও ঘন ঘন (কারণ ব্যর্থ হওয়া এখন সহজ)।
- **(গ) Postgres এ সরানো:** একটা primary, atomic `UPDATE ... SET count = count + 1`, ওঠানামা নেই (পড়া primary থেকে বা version token সহ)। দাম: 5.9 এ count কে AP রাখার কারণ ছিল partition এ availability আর লেখার ভারী চাপ — সেটা যায়; আর count এর প্রতিটা লেখা primary এর উপর।

বাছাই: unread count এর জন্য (ক) — ভুলটা নিরীহ, খরচ কম, আর AP বাছাইয়ের কারণগুলো থাকে। কিন্তু একই সমস্যা যদি টাকা বা permission এ হতো, তাহলে (গ), বা consensus। আর প্রশ্নটা নিজেই একটা শিক্ষা: "count ৫, ৪, ৫" এর মতো bug এর উত্তর প্রায়ই "quorum এর সংখ্যা বাড়াও" না — কোন ধরনের নিশ্চয়তা এই data এর **আসলে** দরকার, সেটা ঠিক করা।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (তিনটা deterministic simulation)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-6.3-session-guarantees/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.3-session-guarantees) — `npm install`, তারপর `npm run session`, `npm run prefix`, `npm run quorum`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`src/replica.ts` এ async replica এর একটা মডেল — lag, মাঝে মাঝে আটকে যাওয়া, ক্রমানুসারে প্রয়োগ, আর `replayedAt()` (Postgres এর `pg_last_wal_replay_lsn()` এর মতো)। বাকি তিনটা file সেই মডেলের উপর তিনটা প্রশ্ন।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; তিনটা script দুবার করে চালিয়ে হুবহু একই output। Replica এর lag এর সংখ্যা ধরে নেওয়া মডেল — শতাংশগুলো না, কোন কৌশল কী ঠিক করে সেটা আসল। README এর experiment গুলো তোমার code বদলানোর কাজ।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. তিনটা script চালাও। `session` এর table এর প্রতিটা **শূন্য না** এমন ঘর এর জন্য এক লাইনে লেখো কেন শূন্য না — বিশেষ করে (খ) এর "সময় পেছনে" ০.৬% আর (ঘ) এর "অন্য device" ০.৮%।

2. **লেজ বনাম গড়** (experiment ১): সব `stallPerWrite` ০ করে আবার চালাও। কোন কলাম প্রায় শূন্যে নামে? এর থেকে TaskFlow এর replica monitoring এর জন্য কী শিক্ষা — কোন সংখ্যায় alert দেবে, গড় lag নাকি অন্য কিছু?

3. **Token এর অপেক্ষা** (experiment ২): replica এগিয়ে না থাকলে primary তে যাওয়ার বদলে ৫০ ms অপেক্ষা। Primary এর শতাংশ কত নামে? TaskFlow এর কোন page এ এই অপেক্ষা ঠিক আছে, আর কোথায় না?

4. **Quorum এ W = 3** (experiment ৪): আগে code না চালিয়ে উত্তর লেখো, তারপর চালিয়ে মেলাও।

5. **Design অংশ:** TaskFlow এর read path এর জন্য একটা পরিকল্পনা লেখো: (ক) version token কোথায় তৈরি হবে (কোন Express middleware, লেখার পরে কোন query), কোথায় থাকবে (Redis key, TTL), আর Sequelize এর read কীভাবে replica বাছবে (5.7 এর `useMaster` এর সাথে মিলিয়ে); (খ) comment table এর shard key কী হবে, আর activity feed (যেটা অনেক task জুড়ে) এ consistent prefix কীভাবে সামলাবে; (গ) replica lag এর কোন সংখ্যায় alert, আর analytics query কোথায় চলবে। ০ নম্বর section এর চারটা ticket — প্রতিটা তোমার পরিকল্পনায় কোথায় বন্ধ হয়, দেখাও।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (সম্পূর্ণ, exit challenge সহ), 6.1, 6.2
Current: 6.3 — Quorum in Practice: Replication Lag, Read-Your-Writes, Monotonic Read
TaskFlow state: Nginx + Express instance গুলো, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; read path এ version token (LSN, user এর নামে Redis এ);
comment/activity এর shard key task/workspace দিয়ে (consistent prefix); notification count
leaderless quorum store এ read repair সহ; replica lag এ alert, analytics আলাদা replica তে
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility,
Replicated State Machine, Term, Randomized Election Timeout, Committed Entry,
Election Restriction, Session Guarantee, Monotonic Reads, Consistent Prefix Read,
Version Token, Read Repair, Hinted Handoff, Anti-Entropy
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 6.4 — Distributed lock, logical clock: Lamport, vector clock
=======================
```

---

## ৮. পরের Lesson

তিনটা lesson হয়ে গেল Module 6 এর — তাই `main.md` এর নিয়ম মেনে এক প্যারায় একটা ছোট recap: **6.1** দেখিয়েছে distributed system এ "অন্যটা মৃত কিনা" জানা যায় না, আর পুরনো leader জানে না যে সে পুরনো — তাই fencing token। **6.2** দেখিয়েছে consensus কীভাবে এর মধ্যেও নিরাপদ সিদ্ধান্ত নেয় — majority, term, election restriction — আর তার দাম। **6.3** দেখিয়েছে বেশিরভাগ read সেই দাম দেয় না, replica থেকে পড়ে, আর তখন user কে সীমিত কিন্তু নির্দিষ্ট নিশ্চয়তা (session guarantee) কীভাবে দেওয়া যায়। তিনটার মধ্যে একটা সুতো বারবার এসেছে কিন্তু খোলা হয়নি: **সময়।** "কোন লেখা নতুন?", "কোনটা আগে ঘটেছে?", "lease এর মেয়াদ কি শেষ?" — প্রতিবার আমরা বলেছি "ঘড়ি বিশ্বাস করা যায় না, 6.4 এ।"

Exercise চালিয়ে পাঠাও — বিশেষ করে ১ নম্বরের ব্যাখ্যা আর ৫ নম্বরের পরিকল্পনা। রেডি হলে `next` লিখো — Lesson 6.4 এ যাব: **Distributed lock আর logical clock — Lamport আর vector clock।** কেন দুটো machine এর ঘড়ি কখনো মেলে না, NTP কেন সময়কে পেছনে ঠেলতে পারে, last-write-wins কীভাবে নীরবে লেখা হারায় — আর ঘড়ি ছাড়া "কোনটা আগে ঘটেছে" জানার উপায়: Lamport clock আর vector clock।
