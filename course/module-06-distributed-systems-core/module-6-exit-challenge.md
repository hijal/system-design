# Module 6 — Exit Challenge (Distributed Systems Core)

**Module 6 — Distributed Systems Core**

Module 6 এর ৫টা lesson শেষ — কী কী ভাঙে আর কেন "অন্যটা মৃত কিনা" জানা যায় না, consensus আর Raft, replica থেকে পড়ার session guarantee, ঘড়ি আর logical clock, আর consistency model এর মই। প্রতিটা lesson এ একটা করে সমস্যা আলাদা করে দেখেছি — আর exercise এ মেপেছি। বাস্তবে এগুলো আলাদা আসে না: একটা network এর গোলমাল একই সাথে failover, lock, আর user এর দেখা data — সবকিছুতে হাত দেয়। এই Exit Challenge এমন একটা মাস।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow এর গত মাসটা খারাপ গেছে। Incident review এর জন্য তোমাকে পুরো মাসের ঘটনা দেওয়া হলো। এই মুহূর্তে TaskFlow এর অবস্থা:
>
> - PostgreSQL primary + ৩টা async read replica, **Patroni** দিয়ে failover। Patroni এর leader lock **etcd** তে — etcd এর ৩টা node: ২টা AZ-a তে, ১টা AZ-b তে। Postgres এর primary এখন AZ-b তে।
> - App গুলো primary খুঁজে পায় একটা DNS নাম দিয়ে (`db-primary.internal`), TTL ৬০ সেকেন্ড; Patroni failover এর পরে DNS update করে।
> - মাসিক **invoice job**: প্রতি মাসের ১ তারিখে একটা instance চালায় — invoice নম্বর নেয়, `invoices` table এ লেখে, Stripe এ charge করে। একটাই instance চালাতে **Redis lock**: `SET invoice-lock <id> NX PX 30000`, আর প্রতি ১০ সেকেন্ডে renew। Lock চলে গেলে job থামে — "lock আছে কিনা" প্রতিটা customer এর আগে `GET` দিয়ে যাচাই করে।
> - Read path: 6.3 এর version token — কিন্তু token রাখা হয় **cookie** তে।
> - Multi-region pilot (ঢাকা, সিঙ্গাপুর, ফ্রাঙ্কফুর্ট): task এর title আর description তিন region এই লেখা যায়; conflict এ **last-write-wins**, region এর server এর ঘড়ির timestamp দিয়ে।
> - Notification unread count: leaderless quorum store, `N = 3, W = 2, R = 2`, read repair বন্ধ।
>
> **মাসের ঘটনাগুলো:**
>
> 1. **৩ তারিখ:** AZ-a পুরো ২০ মিনিটের জন্য বিচ্ছিন্ন (power এর সমস্যা)। Postgres primary AZ-b তে ছিল আর **সুস্থ** — তবু পুরো ২০ মিনিট TaskFlow এ কোনো লেখা হয়নি। Patroni এর log: `failed to update leader lock` তারপর `demoting self because DCS is not accessible`।
> 2. **১ তারিখ, invoice job:** ৩৭ জন customer এর card **দুবার** charge হয়েছে, আর তাদের দুটো করে invoice (ভিন্ন নম্বরে)। Leader instance এর log এ, ৩৭ জনের ঠিক আগে: একটা বড় PDF বানাতে গিয়ে ৪৫ সেকেন্ডের GC pause। দ্বিতীয় instance এর log: "lock acquired" — pause এর মাঝখানে।
> 3. **১২ তারিখ:** একটা network switch এর সমস্যায় Patroni primary কে সুস্থ ভাবতে পারল না, একটা replica promote করল। পুরনো primary তে ৪০ সেকেন্ড ধরে কিছু app instance লিখতে থাকল। পরে ১৮০টা task শুধু পুরনো primary তে পাওয়া গেল।
> 4. ১২ তারিখের পরে একজন engineer "RTO কমাতে" Patroni এর `ttl` ৩০ থেকে ৫ সেকেন্ড করেছে। গত সপ্তাহে ১১টা failover হয়েছে — একটাও hardware এর সমস্যা না।
> 5. **Support ticket:** "Phone এ task বানালাম, laptop খুলে দেখি নেই" — আর আরেক ধরনের: "Refresh করলাম, একটু আগে দেখা comment উধাও।" দ্বিতীয়টা শুরু হয়েছে ঠিক যেদিন চতুর্থ replica যোগ করার পরীক্ষা হয়েছিল।
> 6. **Multi-region pilot:** সিঙ্গাপুরের user রা বলছে description এর edit "save হয়, তারপর পুরনোটা ফিরে আসে।" সিঙ্গাপুরের server এর ঘড়ি ২ সেকেন্ড পিছিয়ে পাওয়া গেছে। ঘড়ি ঠিক করার পরেও মাঝে মাঝে দুজন একসাথে edit করলে একজনেরটা নীরবে হারায়। আর তিন region এর log timestamp দিয়ে সাজালে "notification পাঠানো হলো" আগে আসে, "comment তৈরি হলো" পরে।
> 7. Unread count: "৫, তারপর ৪, তারপর আবার ৫।"
> 8. এর মধ্যে একটা vendor এর sales team এসে বলল: "আমাদের database নিয়ে যান — strongly consistent, globally distributed, always available, আর সব region এ ১ ms read।" CTO জানতে চান এটা কি সব সমস্যার সমাধান।

তোমার কাজ — নিচের প্রতিটা প্রশ্নে Module 6 (আর প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নাও, reasoning সহ। যেখানে সম্ভব, **সংখ্যা** দিয়ে বলো।

**১. সুস্থ primary, তবু কোনো লেখা নেই (Lesson 6.2 + 6.1)**
Postgres primary সুস্থ ছিল — তবু Patroni কেন তাকে demote করল? এটা কি Patroni এর bug, নাকি ইচ্ছাকৃত? এটা না করলে কী বিপদ হতে পারত (6.1 এর কোন ঘটনা)? etcd এর ৩টা node এর বসানো জায়গায় ভুলটা কী — AZ-a গেলে কয়টা node থাকে, majority কত? তোমার সমাধান: কয়টা node, কোথায়, আর TaskFlow এর যদি সত্যিই দুটো AZ ই থাকে তাহলে?

**২. দুবার charge (Lesson 6.1 + 6.4 + 2.5)**
ঘটনাটা সময়ের রেখায় আঁকো — ৪৫ সেকেন্ডের pause, ৩০ সেকেন্ডের lock, দ্বিতীয় instance। "প্রতিটা customer এর আগে lock যাচাই" কেন বাঁচাল না? তিনটা side effect (invoice নম্বর, invoice row, Stripe charge) — প্রতিটার জন্য আলাদা প্রতিরক্ষা দাও (কোন fencing, কোন constraint, কোন idempotency key)। Redis lock কে etcd lease এ বদলালেই কি সমস্যা যায়? আর lock renew এর timer কোন ঘড়িতে চলা উচিত?

**৩. পুরনো primary তে ৪০ সেকেন্ড (Lesson 6.1 + 5.7)**
এটা কোন ধরনের partition, আর split brain টা ঠিক কীভাবে ঘটল — Patroni, DNS TTL, app এর connection pool মিলিয়ে ব্যাখ্যা করো। পুরনো primary কে কে থামাতে পারত, আর কেন থামাল না? অন্তত তিনটা পরিবর্তন দাও যাতে এটা আর না হয় (একটা Postgres/Patroni এর দিকে, একটা app এর connection এর দিকে, একটা data এর দিকে)। আর ১৮০টা task এখন কী করবে?

**৪. ১১টা অকারণ failover (Lesson 6.1 + 6.2)**
`ttl` ৫ সেকেন্ডে কেন এত failover — 6.1 এর detector এর table দিয়ে যুক্তি দাও। প্রতিটা অকারণ failover এর দাম কী (RPO, split brain এর ঝুঁকি, connection এর ঝড়)? RTO কমানোর **সঠিক** উপায় কী — timeout বাদে আর কোন কোন জায়গায় সময় যায় (সনাক্ত → promote → app কে সরানো)?

**৫. দুই ধরনের ticket (Lesson 6.3)**
প্রতিটার নাম দাও (কোন session guarantee), আর বলো কেন ঘটছে — প্রথমটায় cookie এর ভূমিকা, দ্বিতীয়টায় চতুর্থ replica এর ভূমিকা (read কীভাবে replica বাছে, অনুমান করে বলো কোন কৌশল চালু থাকলে এটা ঘটবে)। একটা সমাধান দাও যেটা দুটোই বন্ধ করে, আর primary এর উপর চাপ কত বাড়ায় সেটা আন্দাজ করো (6.3 এর exercise এর সংখ্যা দিয়ে)। Token কোথায় রাখবে, TTL কত?

**৬. Multi-region এর তিন সমস্যা (Lesson 6.4)**
তিনটা আলাদা সমস্যা: (ক) ঘড়ি পিছিয়ে থাকায় edit ফিরে যাওয়া, (খ) ঘড়ি ঠিকের পরেও concurrent edit হারানো, (গ) log এর ক্রম উল্টো। প্রতিটার কারণ আলাদা করে বলো, আর প্রতিটার সমাধান। কোনটা ঘড়ি ঠিক করলে যায়, কোনটা যায় না, কেন? Title আর description এর জন্য কি একই conflict নিয়ম হওয়া উচিত?

**৭. ৫, ৪, ৫ (Lesson 6.3)**
`R + W > N` থাকা সত্ত্বেও কেন? কোন ধরনের লেখা এই অবস্থা তৈরি করে? দুটো সমাধান তুলনা করো, আর বলো "ব্যর্থ" লেখার client এর কী করা উচিত।

**৮. Vendor এর দাবি (Lesson 6.5 + 5.9)**
দাবির চারটা অংশ — কোনগুলো একসাথে অসম্ভব, আর কেন (CAP আর PACELC দিয়ে, আর ঢাকা–ফ্রাঙ্কফুর্ট এর round trip এর আন্দাজি সংখ্যা দিয়ে)? Vendor কে কোন চারটা প্রশ্ন করবে? আর এই মাসের আটটা ঘটনার মধ্যে কোনগুলো নতুন database নিলেও থাকত — কারণ সেগুলো database এর বাইরে?

**৯. Design doc আর অগ্রাধিকার (Lesson 6.1–6.5)**
(ক) TaskFlow এর design doc এর "consistency" section — কমপক্ষে ছয়টা data (leader lock, invoice/billing, task list, comment, multi-region title/description, unread count) এর জন্য: model এর নাম, কীভাবে পাওয়া, আর user এর চোখে সবচেয়ে খারাপ কী দেখা যায়।
(খ) একটা **অগ্রাধিকার তালিকা**: এই সপ্তাহে কী (আবার ঘটার আগে), এই মাসে কী, এই quarter এ কী — প্রতিটার পাশে কোন lesson, আর সাফল্য কীভাবে মাপবে।

**মনে রাখার কথা:** এই module এর তিনটা জায়গায় সবচেয়ে সহজে ভুল হয় — (ক) **timeout কে সত্য ভাবা** ("৩০ সেকেন্ড সাড়া নেই মানে মৃত", "lock এর মেয়াদ আছে মানে আমি মালিক"); (খ) **ঘড়ি দিয়ে ক্রম ঠিক করা**; (গ) **এক শব্দে consistency বলা** ("strong", "eventual") — data ধরে না বলে। আজকের scenario তে তিনটাই লুকিয়ে আছে। আর Module 6 এর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস: প্রতিটা সমাধানের জন্য জিজ্ঞেস করো — **"failure detector ভুল হলে, বা process থেমে গেলে, তখনো কি এটা সঠিক থাকে?"** না থাকলে, সঠিকতা আসছে ভাগ্য থেকে।

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

- [ ] Partial failure কী, আর একটা request এর উত্তর না এলে কোন ছয়টা সম্ভাবনা থাকে — বলতে পারি; timeout মানে "ব্যর্থ" না, "জানি না"
- [ ] Failure model (crash-stop, crash-recovery, byzantine; asynchronous network; অবিশ্বস্ত ঘড়ি) দিয়ে একটা design এর অনুমান স্পষ্ট করতে পারি
- [ ] Failure detector এর timeout এর trade-off (ভুল ঘোষণা বনাম টের পাওয়ার সময়) সংখ্যা দিয়ে বলতে পারি, আর timeout বাছি ভুল ঘোষণার **দাম** দেখে
- [ ] Process pause কোথা থেকে আসে (GC, আটকানো event loop, VM) জানি, আর কেন "যাচাই করে তারপর কাজ" pause এ ভাঙে — নিজের চোখে দেখেছি
- [ ] Split brain এর দুটো পথ (ভুল failure detection, pause এ lease পেরোনো) চিনি; majority, lease, fencing token, idempotency — কোনটা কী আটকায় আর কী আটকায় না, বলতে পারি
- [ ] Efficiency lock আর correctness lock এর পার্থক্য জানি; correctness এর জন্য resource এ শর্তসহ লেখা (fencing) আর বাইরের side effect এ idempotency key দিতে পারি
- [ ] Consensus কী, কোন সমস্যা আসলে ছদ্মবেশী consensus, আর FLP কেন Raft কে "safety সবসময়, liveness timeout দিয়ে" বানায় — বলতে পারি
- [ ] Raft এর term, election (এক term এ এক ভোট, majority, random timeout), log replication আর commit, election restriction — whiteboard এ আঁকতে পারি
- [ ] Partition এ minority দিকের পুরনো leader কেন commit করতে পারে না, কিন্তু তার local read কেন stale হতে পারে — জানি; ReadIndex এর ধারণা বলতে পারি
- [ ] Consensus cluster এর node সংখ্যা (৩/৫, জোড় না) আর বসানোর জায়গা (তিনটা failure domain) ঠিক করতে পারি; consensus কোন data এর জন্য, কোনটার জন্য না — জানি
- [ ] তিনটা session guarantee (read-your-writes, monotonic reads, consistent prefix) চিনি, আর sticky replica, cookie, version token — কোনটা কী ঠিক করে, মেপে দেখেছি
- [ ] Version token কোথায় রাখলে একাধিক device এ কাজ করে জানি; consistent prefix এর জন্য কার্যকারণ-সম্পর্কিত data এক partition এ রাখি
- [ ] `R + W > N` কেন ব্যর্থ লেখায় ভাঙে জানি; read repair, hinted handoff/sloppy quorum, anti-entropy কী মেরামত করে বলতে পারি
- [ ] Wall clock আর monotonic clock এর পার্থক্য জানি — timeout/lease সবসময় monotonic দিয়ে; drift, skew, NTP এর লাফ, leap second এর উদাহরণ দিতে পারি
- [ ] LWW এর দুটো আলাদা ক্ষতি (ঘড়ির ভুলে পরের লেখা হারানো; concurrent লেখা নীরবে হারানো) আলাদা করে বলতে পারি, আর কোনটা ঘড়ি ঠিক করলে যায় না — জানি
- [ ] Happens-before দিয়ে ভাবতে পারি; Lamport আর vector clock হাতে হিসাব করতে পারি, আর কোনটা concurrent চেনে — জানি; sibling আর মেলানোর দাম বুঝি
- [ ] Consistency model এর মই (strict serializable → linearizable → sequential → causal → session → eventual) সাজাতে পারি, আর একটা ছোট history দেখে বলতে পারি কোনটা মানে
- [ ] Serializable আর linearizable এর পার্থক্য বলতে পারি; আর design doc এ data ধরে consistency model লিখতে পারি — cache/replica মিলিয়ে user যা দেখে সেটা সহ

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Martin Kleppmann — _Designing Data-Intensive Applications_।** Module 5 এর recommendation এ এই বই এর কথা বলেছিলাম; এবার বাকি দুটো সবচেয়ে গুরুত্বপূর্ণ অংশ: প্রথম edition এর chapter 8 ("The Trouble with Distributed Systems" — 6.1 আর 6.4 এর পূর্ণ রূপ: pause, ঘড়ি, fencing token এর উদাহরণ এখান থেকেই বিখ্যাত) আর chapter 9 ("Consistency and Consensus" — 6.2, 6.5)। নতুন edition এ chapter এর নম্বর বদলে থাকতে পারে — নাম দিয়ে খোঁজো।
- **Diego Ongaro আর John Ousterhout — "In Search of an Understandable Consensus Algorithm" (Raft paper, 2014)।** Paper হিসেবে অস্বাভাবিক রকম পড়ার মতো। Figure 2 এক পাতায় পুরো algorithm — 6.2 এর exercise এর `raft.ts` এর সাথে লাইন ধরে মেলাও। সাথে raft.github.io — যেখানে একটা interactive visualization আছে, node মেরে, message আটকে দেখা যায়।
- **Martin Kleppmann — "How to do distributed locking" (blog post, 2016), আর antirez এর উত্তর "Is Redlock safe?"।** 6.1 এর Redlock বিতর্ক, দুই পক্ষের মূল লেখা। এই exit challenge এর প্রশ্ন ২ এর পটভূমি।
- **Leslie Lamport — "Time, Clocks, and the Ordering of Events in a Distributed System" (1978)।** 6.4 এর উৎস। ছোট, আর বিস্ময়কর রকম পরিষ্কার — computer science এর সবচেয়ে বেশি উদ্ধৃত paper গুলোর একটা।
- **Jepsen এর "Consistency Models" পাতা (jepsen.io)।** 6.5 এর মই এর একটা বড়, পূর্ণ মানচিত্র — প্রতিটা model এর সংজ্ঞা আর কোনটা কোনটার চেয়ে শক্ত, সাথে বিভিন্ন database এর analysis।

**দেখার জন্য:**

- **Martin Kleppmann এর Cambridge University এর "Distributed Systems" lecture series (YouTube)।** ছোট ছোট ভিডিও, ঠিক এই module এর বিষয়গুলো — failure model, clock, logical time, replication, quorum, consensus — বই এর লেখকের নিজের মুখে।
- **MIT এর Distributed Systems course (6.824, এখন 6.5840) এর lecture (YouTube)।** Robert Morris এর lecture — Raft, ZooKeeper, Spanner এর paper ধরে ধরে। একটু বেশি গভীর, কিন্তু 6.2 এর পরে অনুসরণ করার মতো।

**Project এর জন্য:**

- **MIT 6.5840 এর Raft lab** (course এর website এ public) — Go তে পুরো Raft implement করা, একটা কঠোর test suite এর বিরুদ্ধে (network কাটা, message হারানো, restart)। 6.2 এর exercise যেখানে থেমেছে (persistence, অনেক খুঁটিনাটি), সেখান থেকে শুরু। কঠিন, কিন্তু distributed systems শেখার সবচেয়ে ভালো উপায়গুলোর একটা।
- **TaskFlow এর reminder job, আসল etcd দিয়ে:** Docker এ ৩ node এর etcd, Node এর etcd client দিয়ে lease-ভিত্তিক leader election, আর lease এর revision কে Postgres এর cursor table এ fencing token হিসেবে (6.1 এর শর্তসহ update)। তারপর 6.1 এর exercise এর মতো একটা process কে `SIGSTOP` দিয়ে থামিয়ে দেখো — fencing কি stale লেখা আটকায়?
- **নিজের Jepsen:** Lesson 5.7 এর Postgres primary + replica cluster এ কয়েকটা client দিয়ে পড়ো-লেখো (কিছু read replica থেকে), প্রতিটা operation এর শুরু, শেষ আর ফল রেকর্ড করো, আর 6.5 এর `checker.ts` দিয়ে যাচাই করো। তারপর 6.3 এর version token বসিয়ে আবার — কোন model এর শতাংশ বদলায়? মাঝপথে replica কে `recovery_min_apply_delay` দিয়ে পিছিয়ে দিলে?

---

Exit challenge টা করে পাঠাও। রেডি হলে `next` লিখলে আমরা **Module 7: Asynchronous Processing & Messaging** এ যাব — Lesson 7.1 দিয়ে শুরু: কেন সবকিছু synchronous হলে system মরে যায়।

Module 6 জুড়ে একটা প্রশ্ন বারবার ফিরে এসেছে: "timeout এর পরে কাজটা কি হয়েছে?" — Stripe charge, invoice, quorum এর "ব্যর্থ" লেখা, Raft এর uncommitted entry। প্রতিবার উত্তর একই: জানি না, তাই retry — আর retry নিরাপদ করতে idempotency। Module 7 এ এই প্রশ্নটাই কেন্দ্রে: কাজ যখন request এর বাইরে, একটা queue তে, পরে কোনো worker এর হাতে — তখন "ঠিক একবার" (exactly once) মানে কী, আর সেটা আসলে সম্ভব কিনা।
