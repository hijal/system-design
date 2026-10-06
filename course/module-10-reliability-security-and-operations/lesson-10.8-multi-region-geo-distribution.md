# Lesson 10.8 — Multi-Region & Geo-Distribution

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 2.1):** Server এর IP বদলানোর (migration) আগে DNS এর TTL কমিয়ে রাখা হয় কেন? আর TTL কমালেই কি সব user সাথে সাথে নতুন IP তে যায়? আজ একটা region মরার পরে DNS বদলানো হবে, আর দেখবেন TTL ৬০ সেকেন্ড হলেও পাঁচ মিনিট পরে ৯% traffic এখনও মরা region এ যাচ্ছে।

**Prerequisite:** Lesson 1.5 (SLO, error budget), Lesson 2.1 (DNS, TTL), Lesson 4.5 (CDN, anycast), Lesson 5.7 (Replication, multi-leader), Lesson 5.9 (CAP, quorum), Lesson 6.1 (Split brain, fencing), Lesson 6.2 (Raft), Lesson 6.3 (Read-your-writes), Lesson 6.4 (LWW, HLC), Lesson 10.3 (Blast radius, static stability), Lesson 10.7 (Data transfer, cost)

**আপনি এই lesson শেষে পারবেন:**

1. Multi-region এর তিনটা আলাদা কারণ (latency, disaster recovery, data residency) আলাদা করতে পারবেন, আর প্রতিটা যে আলাদা নকশা চায় সেটা বলতে পারবেন। সংখ্যা দিয়ে দেখাতে পারবেন কেন দূরত্ব round trip এ গুণ হয়, কেন app কে user এর কাছে নিয়ে DB কে না নিলে লেখা **ধীর** হয়, আর region জুড়ে consensus এর দাম কোথা থেকে আসে
2. RPO আর RTO দিয়ে একটা DR কৌশল বাছতে পারবেন (backup, pilot light, warm standby, active-active), প্রতিটার মাসিক দাম সহ। DNS এর failover এর লেজ বুঝবেন, আর বলতে পারবেন কেন স্বয়ংক্রিয় failover এর আসল বিপদ region এর মৃত্যু না, partition, আর witness কী করে
3. একাধিক region এ লেখা নিলে কত লেখা নীরবে হারায় আর কখন, সেটা বলতে পারবেন। আর home region, cell আর data residency দিয়ে একটা নকশা দাঁড় করাতে পারবেন, যেখানে একজন customer এর data কোন পথে কোথায় যায় আপনি জানেন

**Tier:** 1 — Runnable Code (চারটা deterministic model; cloud account বা Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

5.7 থেকে TaskFlow এর সবকিছু সিঙ্গাপুরের একটা region এ: তিনটা AZ, primary আর replica, cache, সব service। সামনে একটা CDN (4.5, 10.5)। 10.7 এর পরে বিল নিয়ন্ত্রণে। আর 6.4 এর একটা pilot এখনও চলছে: তিনটা region এ task এর title আর description এর লেখা নেওয়া, LWW দিয়ে মেলানো।

এক মাসে তিনটা চাপ একসাথে এলো।

**প্রথম চাপ: দূরত্ব।** Sales team এর একটা spreadsheet: লন্ডন আর নিউ ইয়র্কের তিনটা বড় trial customer কিনল না। তিনজনের feedback এ একই কথা, "ধীর।" লন্ডন থেকে board খুলতে প্রায় এক সেকেন্ড, নিউ ইয়র্ক থেকে সোয়া এক সেকেন্ড। ঢাকায় সাড়ে তিনশো ms।

**দ্বিতীয় চাপ: একটা region এর বিভ্রাট।** এক মঙ্গলবার cloud provider এর সিঙ্গাপুর region এ চার ঘণ্টা গোলমাল হলো: network এর একটা অংশ, তারপর কিছু storage। TaskFlow চার ঘণ্টা প্রায় পুরো বন্ধ, সব customer এর জন্য, সব দেশে। 10.3 এর AZ এর redundancy কোনো কাজে লাগেনি, কারণ ভেঙেছিল region এর একটা ভাগ করা অংশ। Status page এ সারাদিন "আমরা provider এর অপেক্ষায় আছি।"

**তৃতীয় চাপ: একটা চুক্তি।** জার্মানির একটা বড় কোম্পানি, ৬,০০০ seat, এক বছরের চুক্তির খসড়া পাঠাল। দুটো শর্ত: "সব ব্যক্তিগত data EU এর ভেতরে থাকবে" আর "DR পরিকল্পনা: RPO ≤ ১ মিনিট, RTO ≤ ৩০ মিনিট, বছরে একবার পরীক্ষা করে দেখাতে হবে।"

আর support এর একটা পুরনো ticket এর স্তূপ, 6.4 এর pilot থেকে: "আমি title বদলেছিলাম, পরে দেখি আগেরটা।" কেউ গুনে দেখেনি এগুলো কতগুলো।

Engineering meeting এ প্রথম প্রস্তাব এলো: "সব region এ সব কিছু চালাই, active-active, সব জায়গায় লেখা। তিনটা সমস্যা এক সাথে শেষ।" CTO এর উত্তর: "তিনটা সমস্যা তিন রকম। একটা উত্তর তিনটার জন্য ঠিক হবে, এমন সম্ভাবনা কম। আর 'সব region এ সব কিছু' এর বিলটা আমি আগে দেখতে চাই। প্রতিটার জন্য সংখ্যা আনুন।"

---

## ১. Theory

### ১.১ তিনটা কারণ, তিনটা নকশা

একাধিক region এ যাওয়ার কারণ সাধারণত তিনটা, আর তারা আলাদা জিনিস চায়:

```
কারণ                  চায়                                        মাপা হয়
দূরের user এর latency  user এর কাছে compute আর data (অন্তত পড়ার)   p50/p95, শহর ধরে
Disaster recovery     অন্য region এ data এর কপি আর চালু হওয়ার ক্ষমতা  RPO, RTO
Data residency        নির্দিষ্ট data নির্দিষ্ট সীমানার ভেতরে, সব পথে  কোন পথ বাইরে যায়
```

এগুলো এক না, আর একটা আরেকটার বিপরীতও হতে পারে। DR চায় data **অন্য জায়গায়** কপি হোক। Residency চায় data **একটা জায়গার বাইরে** না যাক। EU এর data এর DR কপি সিঙ্গাপুরে রাখলে residency ভাঙে। Latency এর জন্য প্রতিটা region এ read replica রাখলে residency এর data সব region এ ছড়ায়। তাই প্রথম প্রশ্ন সবসময়: **কোন কারণে?** আর তার আগের প্রশ্ন: সস্তা কোনো পথে কি সেটা মেটে? দূরত্বের সমস্যার অনেকটা CDN আর edge এ মেটে (১.২)। Region এর বিভ্রাটের কিছুটা backup এ মেটে (১.৪)। দ্বিতীয় region মানে মোটামুটি দ্বিতীয় একটা production: দ্বিগুণ খরচ (10.7), দ্বিগুণ deploy (10.6), আর consistency এর সব কঠিন প্রশ্ন (Module 6) নতুন করে, এবার ১০০ ms দূরত্বে।

### ১.২ Latency — দূরত্ব round trip এ গুণ হয়

আলো optical fiber এ সেকেন্ডে প্রায় দুই লাখ কিলোমিটার যায়। সিঙ্গাপুর থেকে লন্ডন ১০,০০০ কিলোমিটারের বেশি, আর তার যাওয়া-আসা internet এর পথ ঘুরে প্রায় ১৭০ ms। এর নিচে নামার কোনো engineering নেই। যা করা যায় তা হলো **round trip এর সংখ্যা কমানো**, আর যেগুলো বাকি থাকে সেগুলোকে **কাছের** কিছুর সাথে করা।

`npm run latency` পাঁচটা শহরের user নিয়ে চলে (ঢাকা ৩৫%, দিল্লি ১০%, সিঙ্গাপুর ১৫%, লন্ডন ২৫%, নিউ ইয়র্ক ১৫%), আনুমানিক RTT আর তাতে ±১৫% এর ওঠানামা সহ। একটা board খোলা মানে একটা নতুন connection (TCP + TLS 1.3, দুটো round trip, 2.2), তারপর তিনটা API call একটার পরে একটা, প্রতিটায় database এ তিনটা query। ২০% workspace অন্য region এর মানুষের সাথে ভাগ করা। চারটা topology:

```
all in Singapore
city              user   board p50   board p95  create task p50  stale read after write
Dhaka              35%      346 ms      386 ms            77 ms                    0.0%
Delhi              10%      422 ms      472 ms            92 ms                    0.0%
Singapore          15%       94 ms       98 ms            27 ms                    0.0%
London             25%      925 ms      1.05 s           192 ms                    0.0%
New York           15%      1.23 s      1.39 s           252 ms                    0.0%
all (weighted)                390 ms      1.27 s

+ TLS at the CDN edge
city              user   board p50   board p95  create task p50  stale read after write
Dhaka              35%      266 ms      292 ms            77 ms                    0.0%
Delhi              10%      301 ms      334 ms            92 ms                    0.0%
Singapore          15%       94 ms       98 ms            27 ms                    0.0%
London             25%      599 ms      678 ms           192 ms                    0.0%
New York           15%      780 ms      887 ms           252 ms                    0.0%
all (weighted)                289 ms      807 ms

+ app + read replica in every region
city              user   board p50   board p95  create task p50  stale read after write
Dhaka              35%      236 ms      258 ms           185 ms                    0.2%
Delhi              10%      180 ms      195 ms           170 ms                    9.6%
Singapore          15%       94 ms       98 ms            27 ms                    0.0%
London             25%      131 ms      139 ms           355 ms                   61.1%
New York           15%      116 ms      122 ms           470 ms                   66.8%
all (weighted)                135 ms      250 ms

the workspace's home region (cell)
city              user   board p50   board p95  create task p50  stale read after write
Dhaka              35%      239 ms      758 ms            69 ms                    0.0%
Delhi              10%      183 ms      717 ms            54 ms                    0.0%
Singapore          15%       95 ms      706 ms            27 ms                    0.0%
London             25%      132 ms      567 ms            38 ms                    0.0%
New York           15%      117 ms      755 ms            32 ms                    0.0%
all (weighted)                186 ms      698 ms
```

চারটা শিক্ষা, একটা একটা করে:

1. **দূরত্ব গুণ হয়।** লন্ডনের RTT ১৭০ ms, কিন্তু board খুলতে ৯২৫ ms: পাঁচটা round trip (handshake এর দুটো, তিনটা call) আর অল্প server এর সময়। তাই প্রথম কাজ round trip কমানো: 9.2 এর BFF তিনটা call কে একটা বানায়, HTTP/2 আর keep-alive (1.4) handshake বাঁচায়। `API_CALLS=1` দিয়ে (BFF এর একটা call) edge এর topology চালালে লন্ডন **২০৯ ms**, নিউ ইয়র্ক ২৬৯ ms, সবার overall p50 ১১৭ ms। কোনো দ্বিতীয় region ছাড়া, প্রতি region এ replica এর ১৩১ ms এর কাছাকাছি।
2. **Edge এ TLS: শুধু handshake এর দাম কমে।** CDN এর PoP user এর কাছে, তাই দুটো handshake এর round trip লন্ডন থেকে ৮ ms দূরে হয়। লন্ডনে ৯২৫ থেকে ৫৯৯ ms, কোনো দ্বিতীয় region ছাড়াই, প্রায় বিনা মূল্যে। কিন্তু প্রতিটা API call তখনও সিঙ্গাপুরে যায়। এটা সস্তা প্রথম ধাপ, শেষ ধাপ না।
3. **App আর read replica কাছে আনলে পড়া দ্রুত (লন্ডনে ১৩১ ms), কিন্তু লেখা আরও ধীর।** লন্ডনের task তৈরি ১৯২ ms থেকে **৩৫৫ ms**। কারণ আগে user সিঙ্গাপুরের app এর সাথে একবার কথা বলত, আর app তার নিজের AZ এর database এর সাথে কয়েকবার (প্রতিবার ১ ms)। এখন user ফ্রাঙ্কফুর্টের app এর সাথে কথা বলে (১৫ ms), কিন্তু app একটা transaction এর জন্য সিঙ্গাপুরের database এর সাথে কয়েকবার কথা বলে, প্রতিবার ১৬০ ms। **"Chatty" app কে database থেকে দূরে সরানো সবচেয়ে খারাপ জায়গা।** লেখার পথ হয় পুরোটা primary এর কাছে (লেখা সিঙ্গাপুরের app এ পাঠানো), নয়তো একটা round trip এ (একটা stored procedure বা একটা ভারী call)।
4. **আর read-your-writes ভাঙে।** লন্ডনের user task তৈরি করল (লেখা সিঙ্গাপুরে), পরের পড়া ফ্রাঙ্কফুর্টের replica তে। Replica তখনও সেই লেখা পায়নি **৬১% সময়**। 6.3 এর সমস্যা, এবার region এর দূরত্বে। সেখানকার সমাধানগুলো (লেখার পরে কিছুক্ষণ primary থেকে পড়া, version token, client এ optimistic UI) এখানে বাধ্যতামূলক।

শেষ topology, **cell**: প্রতিটা workspace এর একটা home region, আর সেই workspace এর সব data আর সব লেখা সেখানে। নিজের region এর workspace এ সব কিছু দ্রুত। লন্ডনে লেখা ৩৮ ms, কারণ লেখাও স্থানীয়। কিন্তু p95 ৭০০ ms এর কাছে: যে ২০% সময় user অন্য region এর workspace খোলে, পুরো board যায় দূরের home region এ। Experiment ১ এ অর্ধেক workspace অন্য region এর হলে overall p50 ২৫৩ ms। Cell ভালো যখন **বেশিরভাগ সহযোগিতা একটা region এর ভেতরে** (একটা কোম্পানি, একটা দেশ)। আর খারাপ যখন একটা workspace এর মানুষ সারা পৃথিবী জুড়ে।

### ১.৩ লেখা আর consensus — পদার্থবিদ্যার দাম

পড়া কাছে আনা যায় (replica)। লেখা আনা কঠিন, কারণ লেখার একটা মালিক লাগে (5.7)। আর যদি লেখাকে একাধিক region এ টেকসই (durable) করতে চান, যাতে একটা region মরলেও লেখা না হারায়, তাহলে লেখার commit কে অন্য region এর ack এর জন্য অপেক্ষা করতে হয়। `npm run latency` অংশ খ, Raft এর মতো majority এর commit (6.2):

```
where                             node   majority   commit  regions it can lose
Singapore's 3 AZs                  3          2     2 ms  0 (lose the region, lose everything)
Singapore + Mumbai + Frankfurt    3          2    60 ms   1
the same, leader in Mumbai            3          2    60 ms   1
four regions, leader in Singapore    4          3   160 ms   1
four regions, leader in Frankfurt      4          3   110 ms   1
```

Majority এর commit লাগে **দ্বিতীয় নিকটতম** node এর ack পর্যন্ত। তিনটা AZ এ ২ ms, কিন্তু region হারালে সব যায়। তিনটা region এ ৬০ ms: প্রতিটা লেখায় ৩০ গুণ বেশি, বিনিময়ে একটা পুরো region হারানো সহ্য করা যায়, **শূন্য data হারিয়ে** (RPO = ০)। চার region এ সহ্য করার ক্ষমতা বাড়ে না (চারটার majority তিনটা, তাই একটাই হারানো যায়), কিন্তু commit ১৬০ ms। নিয়ম: **বিজোড় সংখ্যা, আর leader লেখকদের কাছে।** Google Spanner বা CockroachDB এর মতো system এই দামটাই দেয়, আর তাদের নকশার অনেকটা হলো এই দাম লুকানো বা কমানো (leader কে লেখকের কাছে সরানো, পড়ার জন্য lease)। এটা 5.9 এর PACELC এর "else" অংশ: partition না থাকলেও, consistency এর দাম latency।

User এর মুখোমুখি বেশিরভাগ লেখা এই দাম দিতে চায় না। তাই সাধারণ পথ হলো: লেখা এক region এর ভেতরে (AZ জুড়ে) synchronous, আর অন্য region এ **asynchronous**, কয়েক সেকেন্ডের lag সহ। দাম হলো region হারালে সেই কয়েক সেকেন্ডের লেখা। পরের অংশের RPO।

### ১.৪ Disaster recovery — RPO, RTO আর তাদের দাম

**RPO / RTO** — Recovery Point Objective: একটা দুর্যোগের পরে **কতটা পুরনো** অবস্থায় ফিরতে রাজি, মানে সর্বোচ্চ কত সময়ের লেখা হারানো সহ্য (RPO ৫ সেকেন্ড = শেষ ৫ সেকেন্ডের লেখা হারাতে পারে)। Recovery Time Objective: দুর্যোগের পরে **কতক্ষণে** আবার চালু হতে হবে। দুটো আলাদা হাতল, আর দুটোরই দাম আছে। ছোট RPO কেনা হয় replication দিয়ে, ছোট RTO কেনা হয় অন্য জায়গায় আগে থেকে চালু থাকা capacity দিয়ে।

`npm run failover` অংশ ক: সিঙ্গাপুর region ৪ ঘণ্টা বন্ধ, ৩০০ req/s, তার ১০% লেখা। পাঁচটা কৌশল। প্রতিটার RTO হলো ধাপগুলোর যোগফল (ধরে নেওয়া সময়), আর মাসিক বাড়তি খরচ 10.7 এর $৮,২৭৬ এর উপরে:

```
strategy                                                   RTO       RPO  lost writes  failed requests  extra / month
one region, wait for it to return                        4.0 h         0            0        4,320,000             $0
backup & restore (daily snapshot to another region)      2.2 h    12.0 h    1,296,000        2,340,000           $359
pilot light (DB replica running, app off)               42 min       5 s          150          756,000           $833
warm standby (small app running)                        27 min       5 s          150          486,000         $1,259
active-active (running in every region)                  4 min       5 s          150           72,000         $3,836

backup:      detect 5 → decide 15 → infra via IaC 30 → DB restore (900 GB) 60 → verify 15 → DNS 5
pilot light: detect 5 → decide 15 → start app from zero 15 → replica promote 2 → DNS 5
warm:        detect 5 → decide 10 → scale out 5 → replica promote 2 → DNS 5
active:      detect 2 → automatic promote (with witness) 1 → global LB / anycast 1
```

**Active-Passive / Active-Active** — Active-passive এ একটা region traffic নেয়, আরেকটা অপেক্ষা করে। কতটা প্রস্তুত হয়ে অপেক্ষা করে তার তিনটা পরিচিত ধাপ: **backup & restore** (শুধু data এর কপি), **pilot light** (data চলমান replica তে, compute বন্ধ), **warm standby** (ছোট মাপে সব চালু)। Active-active এ সব region traffic নেয়, তাই একটা মরলে বাকিরা শুধু তার ভাগ নেয়। প্রস্তুতি যত বেশি, RTO তত কম, মাসিক দাম তত বেশি।

টেবিল থেকে চারটা জিনিস:

1. **RPO আর RTO এর দাম উল্টো দিকে।** মাসে $৩৫৯ এ (backup) ২.২ ঘণ্টা বন্ধ আর গড়ে **১২ ঘণ্টার লেখা হারানো** (দিনের snapshot, দুর্যোগ যেকোনো মুহূর্তে)। মাসে $৮৩৩ এ (pilot light) RPO ৫ সেকেন্ড। লেখা হারানোর সবচেয়ে বড় লাফটা সবচেয়ে সস্তায়: একটা async replica। তারপর প্রতিটা মিনিটের RTO এর দাম বাড়ে।
2. **RTO এর বেশিরভাগ মানুষের।** Pilot light এর ৪২ মিনিটের ১৫ মিনিট "সিদ্ধান্ত": কেউ জাগল, বুঝল, কাউকে জিজ্ঞেস করল, "failover করব?" এর দায় নিল। Restore বা boot এর চেয়ে বড়। তাই runbook (কে সিদ্ধান্ত নেয়, কোন সংকেতে) আর **অনুশীলন** (10.3 এর game day) RTO এর সবচেয়ে সস্তা উন্নতি।
3. **ছোট outage এ ধীর কৌশল কিছুই কেনে না।** Experiment ২: outage ৩০ মিনিট হলে backup আর pilot light এর failover শেষ হওয়ার আগেই region ফিরে আসে। শুধু warm standby (২৭ মিনিট) আর active-active কাজে লাগে। আর মাঝপথে failover শুরু করে ফেললে আরেকটা সমস্যা: region ফিরল, এখন দুটো জায়গায় data, কোনটা সত্য? **Failback** (পুরনো region এ ফেরা) প্রায়ই failover এর চেয়ে কঠিন, কারণ এবার তাড়া নেই কিন্তু data দুই দিকে চলেছে।
4. **জার্মান customer এর চুক্তি (RPO ≤ ১ মিনিট, RTO ≤ ৩০ মিনিট):** backup বাদ, pilot light বাদ (৪২ মিনিট), warm standby কোনো রকমে মেলে (২৭ মিনিট), আর সেটাও শুধু যদি "সিদ্ধান্ত" ১০ মিনিটে হয়, যার মানে আগে থেকে লেখা নিয়ম আর অনুশীলন। Active-active আরামে মেলে, মাসে $৩,৮৩৬ এ। এটা একটা ব্যবসার প্রশ্ন: চুক্তির আয় (১.৭) এই দাম বহন করে কিনা।

### ১.৫ Traffic কে সরানো — DNS এর লেজ আর split brain

RTO এর শেষ ধাপ: user দের traffic নতুন region এ পাঠানো।

**Geo-Routing** — user এর request কে তার অবস্থান বা মাপা latency ধরে কোনো একটা region এ পাঠানো, আর একটা region মরলে বাকিগুলোতে সরানো। দুটো প্রধান যন্ত্র আছে। **GeoDNS / latency-based DNS** একই নামের জন্য আলাদা জায়গায় আলাদা IP দেয়, failover মানে DNS এর উত্তর বদলানো। **Anycast / global load balancer** একই IP পৃথিবীর অনেক জায়গা থেকে ঘোষণা করে (4.5), আর provider এর network নিজেই সুস্থ region এ পাঠায়, DNS না বদলে।

**Spaced repetition এর উত্তর:** migration এর আগে TTL কমানো হয় যাতে resolver গুলো পুরনো উত্তর বেশিক্ষণ cache না করে। কিন্তু সবাই TTL মানে না। `npm run failover` অংশ খ, ধরে নেওয়া client এর মিশ্রণ: ৭০% TTL মানে, ২০% এর resolver TTL কে অন্তত ৫ মিনিট ধরে, ১০% পুরনো IP ধরে থাকে এক ঘণ্টা পর্যন্ত (খোলা connection, app এর নিজের DNS cache)। DNS বদলানোর পরে কত % traffic এখনও মরা region এ:

```
routing                              +1 min  +5 min  +15 min  +30 min  +60 min  failed in hour 1
DNS, TTL 60 s                          26%      9%       8%       5%       0%               69,450
DNS, TTL 300 s                         82%      9%       8%       5%       0%               94,650
DNS, TTL 3,600 s                       98%     92%      75%      50%       0%              540,150
anycast / global LB (DNS doesn't change)  0%      0%       0%       0%       0%                9,150
```

TTL ৬০ আর ৩০০ এর পার্থক্য শুধু প্রথম কয়েক মিনিটে। তারপর দুটোই একই লেজে আটকায়: সেই ১০% যারা TTL মানেই না। এটা TTL দিয়ে থামানো যায় না। আর TTL এক ঘণ্টা হলে failover এর প্রথম আধা ঘণ্টা প্রায় অর্থহীন। তাই DR এর পরিকল্পনায় DNS এর TTL সবসময় ছোট রাখা হয় (২.১ এর migration এর পরামর্শ, এবার স্থায়ী)। আর ছোট RTO এর জন্য anycast বা global load balancer, যেখানে client এর কিছুই বদলাতে হয় না। (Mobile app এ আরেকটা পথ: app নিজেই দুটো endpoint জানে আর ব্যর্থ হলে অন্যটায় যায়।)

**কে বলবে region মরেছে?** এখন সবচেয়ে বিপজ্জনক প্রশ্ন। Active-active বা স্বয়ংক্রিয় failover এ একটা যন্ত্র ঠিক করে "সিঙ্গাপুর মৃত, মুম্বাইকে primary বানান।" কিন্তু 6.1 মনে করুন: অন্য machine থেকে "মৃত" আর "পৌঁছানো যাচ্ছে না" দেখতে হুবহু এক। `npm run failover` অংশ গ: সিঙ্গাপুর মরেনি, শুধু ১০ মিনিট বাকিদের থেকে বিচ্ছিন্ন (partition), আর সিঙ্গাপুরের user রা তখনও তাকে পায় (লেখার ১৫%):

```
policy                                   failed writes  divergent writes  who could write
no automatic failover                      15,300                   0  Singapore only; everyone else's writes fail
Mumbai promotes itself after 2 minutes    3,060               2,160  both sides — two primaries (split brain)
with a witness (majority + lease, fencing)       5,625                   0  the Mumbai side; Singapore stops itself after 30 s
```

- **Failover নেই:** কিছু হারায় না, কিন্তু ১০ মিনিট সিঙ্গাপুরের বাইরের সবার লেখা ব্যর্থ। CAP এর C।
- **মুম্বাই নিজের চোখে দেখে সিদ্ধান্ত নেয়:** লেখা ব্যর্থ কম, কিন্তু ৮ মিনিট **দুটো primary**। সিঙ্গাপুর জানে না সে "মৃত", তার user দের ২,১৬০টা লেখা নেয়। Partition সারলে এই লেখাগুলো মুম্বাইয়ের ইতিহাসের সাথে মেলে না। হাতে মেলাতে হয়, নয়তো হারায়। 6.1 এর split brain, region এর মাপে।
- **Witness:** একটা তৃতীয় region (ধরুন ফ্রাঙ্কফুর্ট, একটা ছোট node) ভোট দেয়। Primary হতে লাগে majority, আর primary নিজের lease নবায়ন করতে পারে শুধু majority এর সাথে কথা বলে। সিঙ্গাপুর বিচ্ছিন্ন, তাই ৩০ সেকেন্ডে lease শেষ হলে **নিজেকে থামায়** (fencing)। দুটো primary কখনো একসাথে থাকে না। দাম: সিঙ্গাপুরের user দের লেখা ৯.৫ মিনিট ব্যর্থ (৫,৬২৫টা মোট ব্যর্থ, failover না করার চেয়ে কম)। এটা 6.2 এর Raft এর যুক্তি, region এর মাপে। স্বয়ংক্রিয় failover নিরাপদ হয় শুধু quorum আর fencing দিয়ে। নইলে সবচেয়ে নিরাপদ স্বয়ংক্রিয় failover হলো মানুষের হাতে একটা বোতাম।

### ১.৬ একাধিক region এ লেখা — 6.4 এর pilot এর আসল দাম

এবার support এর ticket এর স্তূপ। 6.4 এর pilot প্রতিটা region এ লেখা নেয় আর LWW দিয়ে মেলায়। কতগুলো লেখা হারাচ্ছে?

`npm run conflicts` একটা দিন: ১০ লাখ edit, তার প্রায় ২ লাখ edit ২০,০০০টা যৌথ session এ (২–৪ জন একই task এ কয়েক মিনিট কাজ করছে, ৩০% session এ অন্য region এর মানুষ)। Region এর মধ্যে replication সাধারণত দূরত্বের অর্ধেক + ৫০ ms। কিন্তু দুপুর ২টা থেকে ৪টা link খারাপ, median ২০ সেকেন্ড। আর ফ্রাঙ্কফুর্টের ঘড়ি ২৫০ ms পিছিয়ে (6.4)। দুটো edit concurrent যদি একটা অন্যটার region এ পৌঁছানোর আগেই অন্যটা লেখা হয়:

```
rule                         silently lost edits  % of total  concurrent          reversed by clock  in the 2 h incident
LWW, whole row, wall clock             2,068    0.207%                2,025               43                1,858
LWW, per field, wall clock                642    0.064%                  633                9                  599
LWW, per field, HLC                       633    0.063%                  633                0                  599
writes to the workspace's home region      0        0%                    0                0                    0
```

- **দিনে ২,০৬৮টা edit নীরবে হারায়**, পুরো row এর LWW এ। ০.২% ছোট শোনায়, কিন্তু প্রতিটা একজন মানুষ যে কিছু লিখেছিল আর পরে দেখল নেই, কোনো error ছাড়া। Support এর স্তূপটা আসল।
- **৯০% হারায় দুই ঘণ্টায়।** ১,৮৫৮টা link খারাপ থাকার সময়। Replication ধীর মানে concurrent এর জানালা চওড়া, আর conflict বাড়ে। মানে conflict আসে **ঠিক যখন system আগে থেকেই চাপে**। Experiment ৩: link এর lag ২০ s থেকে ২ s করলে ২,০৬৮ থেকে ৫১৮।
- **Field ধরে মেলানো হারানো edit তিন ভাগের এক ভাগ করে।** একজন status বদলাল, আরেকজন title: দুটোই টেকে। এটাই সবচেয়ে সস্তা উন্নতি।
- **HLC ঘড়ির ভুল সরায়, concurrent না।** "ঘড়ির জন্য উল্টো" (একটা edit আরেকটা দেখার পরে লেখা হয়েছিল, কিন্তু পিছিয়ে থাকা ঘড়ির জন্য পুরনোটা জিতল) HLC এ শূন্য। Experiment ৪: ফ্রাঙ্কফুর্টের ঘড়ি ২ সেকেন্ড পিছিয়ে থাকলে wall clock এ ৬৮৫টা, HLC এ ০। কিন্তু সত্যিকারের concurrent ৬৩৩টা HLC এও হারায়। 6.4 এর কথা: HLC কার্যকারণ রাখে, concurrent চেনে না।

**Home Region** — প্রতিটা data এর (এখানে workspace এর) একটা মালিক region, আর তার সব লেখা সেখানে যায়, user যেখানেই থাকুক। এক জায়গায় লেখা মানে single-leader (5.7), তাই কোনো write conflict নেই। অন্য region এর user এর লেখা home এ যেতে একটা দূরের round trip দেয়। 5.7 এর "conflict এড়ানো, বাস্তবে সবচেয়ে প্রচলিত।"

দাম, অংশ খ: যৌথ session এর edit এর ১৪.৩% অন্য region থেকে আসে, তাদের বাড়তি latency p50 ১১৯ ms, p95 ২৩৫ ms। সব edit এর মধ্যে মাত্র ২.৮৬% এই দাম দেয়। আর এর বিনিময়ে দিনে ২,০৬৮টা নীরব ক্ষতি থেকে **শূন্য**। বেশিরভাগ product এর জন্য এটা সহজ সিদ্ধান্ত: optimistic UI (client নিজের লেখা সাথে সাথে দেখায়) ১১৯ ms লুকায়, আর কোনো UI হারানো লেখা লুকাতে পারে না।

যেখানে সত্যিই অনেকে একসাথে একই লেখা লেখে (description এর rich text, Google Docs এর মতো), সেখানে LWW এর বদলে **CRDT** বা operational transform: এমন data structure যার concurrent পরিবর্তন সবসময় নিজে থেকে মেলে, কিছু না হারিয়ে (6.4 এর sibling এর ধারণার স্বয়ংক্রিয় রূপ)। দাম জটিলতা আর metadata। আর তখনও প্রায়ই একটা home region sequencer হিসেবে কাজ করে।

### ১.৭ Data residency আর cell — data কোথায় কোথায় যায়

জার্মান চুক্তি: "সব ব্যক্তিগত data EU এর ভেতরে।" প্রথম পরিকল্পনা ছিল ফ্রাঙ্কফুর্টে একটা database আর app। কিন্তু data শুধু database এ থাকে না।

**Data Residency** — নির্দিষ্ট data (প্রায়ই ব্যক্তিগত data) একটা নির্দিষ্ট ভৌগোলিক সীমানার ভেতরে store আর process করার বাধ্যবাধকতা। আসে চুক্তি থেকে, বা দেশের আইন থেকে (data localization)। একটা সতর্কতা: EU এর GDPR নিজে সবসময় EU তে **রাখা** বাধ্য করে না; সে বাইরে **পাঠানোর** জন্য আইনি ভিত্তি আর সুরক্ষা চায়। অনেক চুক্তি আর কিছু দেশের আইন এর চেয়ে কড়া। কোনটা প্রযোজ্য, সেটা আইনজীবীর প্রশ্ন, engineer এর না (এখানে যাচাই করা না)। Engineer এর প্রশ্ন হলো: **data আসলে কোন কোন পথে যায়?**

`npm run residency` এই customer এর (৩০০ workspace, ৬,০০০ user) data এর পথগুলো গোনে, তিনটা নকশায়:

```
path                                          GB/month                           personal data    all in Singapore  DB + app + S3 in the EU      a full EU cell
Postgres (primary + replica)                        80                      name, email, tasks           outside ✗           in the EU           in the EU
attachment (S3)                                  3,000                                    file           outside ✗           in the EU           in the EU
DR copy: backups and replicas                    3,100                              everything           outside ✗           outside ✗           in the EU
CDN edge cache                                     600                                    file           outside ✗           outside ✗           in the EU
logs (central log store)                            45                             user id, IP           outside ✗           outside ✗           in the EU
trace                                               15                      user id, workspace           outside ✗           outside ✗           in the EU
metric                                               2                     none (clean labels)           outside ✗           outside ✗           outside ✗
search index (8.3)                                  40                               task text           outside ✗           outside ✗           in the EU
analytics warehouse (7.6)                           60                          event, user id           outside ✗           outside ✗           in the EU
analytics: aggregates only (no user id)              1    none (counts by day × plan × feature)           outside ✗           outside ✗           outside ✗
identity: user email and profile                     1                             email, name           outside ✗           outside ✗           in the EU
email provider                                       5                email, name, task titles           outside ✗           outside ✗           in the EU
error tracker (with request bodies)                  3                 whatever is in the body           outside ✗           outside ✗           in the EU
paths taking personal data outside                                                                        11 / 11              9 / 11              0 / 11
personal data going outside / month                                                                        6.9 TB              3.9 TB                0 GB
```

**Database আর S3 ফ্রাঙ্কফুর্টে সরালে ১১টা পথের মাত্র ২টা ঠিক হয়।** বাকি ৯টা এই course এর প্রায় প্রতিটা module এর একটা করে সিদ্ধান্ত। 10.3 এর DR কপি (সিঙ্গাপুরে, কারণ "অন্য region"), 4.5 এর CDN (private file সারা পৃথিবীর PoP এ cache), 10.4 এর কেন্দ্রীয় log আর trace (user id, IP — IP ও ব্যক্তিগত data), 8.3 এর search cluster, 7.6 এর analytics, 9.2 এর identity, আর বাইরের service (email, error tracker, যাদের request body তে কী আছে কেউ জানে না)। Residency একটা database এর setting না। এটা system এর প্রতিটা পথের একটা গুণ।

**Cell-Based Architecture** — system কে কয়েকটা স্বাধীন, সম্পূর্ণ কপিতে (cell) ভাগ করা। প্রতিটা cell এ নিজের app, database, cache, queue, log, search, প্রতিটা customer (বা workspace) ঠিক একটা cell এ। আর উপরে একটা পাতলা global স্তর (routing, identity এর directory, billing), যে জানে কোন customer কোন cell এ। Region ধরে cell হলে residency আর latency মেটে। আর একই region এ কয়েকটা cell হলে blast radius (10.3) ছোট হয়: একটা cell এর ভুল deploy বা খারাপ data শুধু সেই cell এর customer দের ছোঁয়।

পুরো EU cell এ ব্যক্তিগত data এর কোনো পথ বাইরে যায় না। যা বাইরে যায় (metric, aggregate analytics) তাতে কোনো ব্যক্তিগত data নেই, আর সেটা নকশা দিয়ে নিশ্চিত করা (10.4 এর label এর নিয়ম, analytics এ user id ছাড়া গণনা)। DR কপি দ্বিতীয় একটা EU region এ (১.১ এর বিরোধের সমাধান: DR এর "অন্য জায়গা" মানে সীমানার ভেতরে অন্য জায়গা)। Identity তে user এর profile EU তে, আর global directory তে শুধু email এর একটা hash থেকে "এই user এর home cell কোনটা।" Login এর প্রথম ধাপ শুধু এতটুকু জানে।

**দাম**, অংশ খ:

```
app (min 3, commit)                                $273
Postgres Multi-AZ + 1 replica                    $1,444
Redis (cache + queue)                              $190
NAT ×3 + LB + endpoint                             $221
log/trace/metric stack (the cell's own)            $450
DR: pilot light in a second EU region               $512
search (the cell's own)                            $280
average people time (on-call, upgrades × 2 cells)  $1,500
cell total / month                               $4,870
this customer's revenue (4,200 paid seats × $9)  $37,800
the cell's cost as % of revenue                     13%
```

একটা cell এর একটা **স্থির ভিত্তি খরচ** আছে, customer যত ছোটই হোক: database এর Multi-AZ, NAT, observability এর stack, আর সবচেয়ে বড় লাইন, মানুষ। দুটো cell মানে প্রতিটা deploy, প্রতিটা migration (10.6 এর expand/contract), প্রতিটা on-call এর ঘটনা দুই জায়গায়। এই customer এর আয়ের ১৩%, TaskFlow এর সাধারণ ৩% (10.7) এর চার গুণ। প্রথম EU customer এর জন্য cell একটা বিনিয়োগ। দ্বিতীয় আর তৃতীয় EU customer একই cell এ, আর ভিত্তি খরচ ভাগ হয়। তাই এটা একটা ব্যবসার সিদ্ধান্ত: "EU বাজারে আমরা কি আরও customer আশা করি?" আর সেটা cell এর নকশার আগে আসে।

### ১.৮ TaskFlow এর সিদ্ধান্ত

> **Trade-off Table — চারটা topology, তিনটা কারণ**

| Topology                          | Latency (দূরের user)                            | DR (region হারালে)                     | Residency                      | দাম আর জটিলতা                                         |
| --------------------------------- | ----------------------------------------------- | -------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| এক region + CDN edge              | Handshake ছোট; প্রতিটা call দূরে (লন্ডন ৫৯৯ ms) | কিছুই না, বা backup (RPO ঘণ্টা)        | একটা জায়গা — হয় মেলে, নয় না | সবচেয়ে কম                                            |
| + read replica সব region এ        | পড়া দ্রুত (১৩১ ms); লেখা ধীর (৩৫৫), RYW ভাঙে   | Replica promote — pilot light এর মতো   | Data সব region এ ছড়ায় ✗      | প্রতি region এ app + replica; RYW এর নকশা             |
| Active-passive (warm standby)     | কোনো লাভ নেই                                    | RTO ২৭ মি, RPO ৫ s                     | Standby সীমানার ভেতরে হলে ✓    | +$১,২৫৯; failover এর অনুশীলন                          |
| Active-active, home region (cell) | নিজের region এ সব দ্রুত; অন্যের workspace এ ধীর | একটা region এর cell হারায়, বাকিরা চলে | ✓ region ধরে cell              | প্রতি cell এর ভিত্তি খরচ; global স্তর; সব কিছু N বার  |
| Active-active, সব জায়গায় লেখা   | সব দ্রুত                                        | RTO মিনিট                              | ✗                              | Write conflict (দিনে হাজার হারানো লেখা), সবচেয়ে জটিল |

**এখনই:** CDN edge এ TLS আর BFF এ একটা call (লন্ডনের board ৯২৫ থেকে ~২০৯ ms, model এ মাপা, কোনো দ্বিতীয় region ছাড়া)। DNS এর TTL ৬০ s। 6.4 এর multi-region লেখার pilot **বন্ধ**: সব লেখা আবার এক জায়গায়, আর আগে field ধরে LWW + HLC এ সরানো যতদিন বন্ধ করা যায়।

**DR (সবার জন্য):** সিঙ্গাপুরের database এর async replica মুম্বাইয়ে, S3 এর replication, IaC দিয়ে পুরো stack মুম্বাইয়ে চালানোর ক্ষমতা: pilot light, RPO ~৫ s, RTO ~৪০ মিনিট, মাসে ~$৮৩৩। একটা লেখা runbook: কোন সংকেতে, কে সিদ্ধান্ত নেয়, প্রতিটা ধাপ। Failover মানুষের হাতে, একটা বোতাম দিয়ে, witness ছাড়া স্বয়ংক্রিয় না। প্রতি ছয় মাসে একটা game day (10.3), যেখানে আসলেই মুম্বাইয়ে traffic সরানো হয় আর ফেরানো হয়। Failback এর অংশটাও অনুশীলন।

**EU cell (জার্মান চুক্তির সাথে):** ফ্রাঙ্কফুর্টে একটা পূর্ণ cell, সব ব্যক্তিগত data এর পথ সহ (log, trace, search, error tracker, email provider এর EU processing, private file এর CDN cache বন্ধ বা EU edge এ)। DR আরেকটা EU region এ, warm standby, যাতে RTO ≤ ৩০ মিনিট মেলে। বাইরে যায় শুধু metric আর aggregate analytics, কোনো user স্তরের data ছাড়া। Global স্তর: routing (workspace → cell), identity এর directory (email এর hash → cell), billing। এই স্তর ছোট, প্রায় শুধু পড়ে, আর প্রতিটা cell এ cache থাকে (10.3 এর static stability: global স্তর মরলেও cell চলে)। নতুন workspace তৈরির সময় customer নিজে region বাছে, আর সেটা পরে বদলানো একটা migration, ক্লিক না।

**পরে, যদি দরকার হয়:** লন্ডন আর নিউ ইয়র্কে আরও customer এলে ফ্রাঙ্কফুর্ট আর ভার্জিনিয়ার cell সাধারণ customer এর জন্যও খোলা (home region)। Read replica সব region এ, **না**: সেটা residency ভাঙে আর লেখা ধীর করে।

---

## ২. Interview Angle

Multi-region প্রায় সব বড় design প্রশ্নের শেষে আসে: "এখন এটা global করুন", "একটা region মরলে কী হবে?" আর এখানে junior আর senior এর পার্থক্য সবচেয়ে স্পষ্ট। দুর্বল উত্তর হলো "প্রতিটা region এ একটা copy, active-active, global database।" ভালো উত্তরের আকৃতি:

1. **কারণ জিজ্ঞেস করুন।** "Multi-region কেন? Latency, DR, নাকি residency?" প্রতিটার উত্তর আলাদা। আর বলুন প্রথমে সস্তা পথ: CDN, edge, round trip কমানো।
2. **লেখা কোথায় যায়, আগে সেটা ঠিক করুন।** Single-leader আর read replica, home region (cell), নাকি multi-leader। প্রতিটার consistency এর দাম: RYW, conflict, cross-region commit এর latency।
3. **DR কে সংখ্যায় বলুন।** RPO আর RTO, কৌশল, আর মাসিক দাম। Failover কে ঠিক করে (witness, fencing), আর traffic কীভাবে সরে (DNS এর লেজ, anycast)।
4. **দামের কথা।** প্রতিটা region প্রায় একটা নতুন production। Inter-region data transfer (10.7), প্রতিটা deploy N বার। আর data residency এর জন্য সব পথ, শুধু database না।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Global database ব্যবহার করব না কেন (Spanner, CockroachDB, DynamoDB global tables)?"_ — তারা সমস্যা সরায় না, দাম স্পষ্ট করে। Synchronous হলে প্রতিটা লেখার commit region জুড়ে majority এর ack (তিন region এ ৬০ ms+)। Multi-leader async হলে conflict আর LWW। প্রশ্ন হলো আপনি কোন দামটা বাছছেন।
- _"Active-active এ একই row দুই region এ লেখা হলে?"_ — LWW (নীরব ক্ষতি; field ধরে কমে, HLC ঘড়ির ভুল সরায়), CRDT (নিজে মেলে, জটিল), বা home region (conflict নেই, দূরের লেখায় একটা round trip)। সংখ্যা দিন: link খারাপ হলে conflict লাফায়।
- _"Failover কীভাবে স্বয়ংক্রিয় করবেন?"_ — Partition আর মৃত্যু আলাদা করা যায় না। তাই quorum (তৃতীয় region এ witness) আর lease দিয়ে fencing। নইলে split brain। অনেক জায়গায় database এর failover ইচ্ছা করে মানুষের হাতে রাখা হয়।
- _"RPO শূন্য চাই।"_ — তাহলে প্রতিটা লেখার commit অন্য region এর ack এর জন্য অপেক্ষা করবে। দাম প্রতিটা লেখায় দ্বিতীয় নিকটতম region এর RTT। কোন data এর জন্য সত্যিই শূন্য লাগে (টাকা), কোনটার জন্য ৫ সেকেন্ড ঠিক আছে (task এর title)?

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ঘটনাগুলো: DR region যা কখনো পরীক্ষা হয়নি, আর দুর্যোগের দিনে দেখা গেল config, secret বা quota নেই। দীর্ঘ DNS TTL। স্বয়ংক্রিয় failover একটা network এর ঝাঁকুনিতে আর তার পরে split brain। Read replica দূরে আর read-your-writes এর অভিযোগ। Multi-leader এর LWW যার ক্ষতি কেউ গোনে না। "EU তে data" এর দাবি, যখন log, backup আর search সিঙ্গাপুরে। আর global স্তর (identity, routing) যা নিজেই একটা single point of failure, সব cell কে একসাথে নামিয়ে দেয়।

---

## ৩. Key Takeaway

- **Multi-region এর তিনটা কারণ (latency, DR, residency) তিনটা আলাদা নকশা চায়, আর কখনো একে অপরের বিরুদ্ধে যায়।** প্রথমে সস্তা পথ: CDN edge এ TLS লন্ডনের board ৯২৫ থেকে ৫৯৯ ms, আর BFF এ একটা call সহ ২০৯ ms — কোনো দ্বিতীয় region ছাড়া
- **দূরত্ব round trip এ গুণ হয়, আর app কে DB থেকে দূরে নেওয়া সবচেয়ে খারাপ।** দূরে read replica পড়া দ্রুত করে (১৩১ ms), কিন্তু লন্ডনের লেখা ১৯২ থেকে ৩৫৫ ms, আর লেখার পরের পড়া ৬১% সময় পুরনো
- **Region জুড়ে টেকসই লেখার দাম দ্বিতীয় নিকটতম region এর RTT।** তিন AZ এ ২ ms, তিন region এ ৬০ ms। বিজোড় সংখ্যা, leader লেখকদের কাছে। তাই বেশিরভাগ লেখা region এর ভেতরে sync, বাইরে async
- **RPO আর RTO কেনা যায়, দাম স্পষ্ট।** Async replica (pilot light, $৮৩৩) RPO কে ১২ ঘণ্টা থেকে ৫ সেকেন্ডে আনে। প্রতিটা মিনিটের RTO এর দাম তারপর বাড়ে (active-active $৩,৮৩৬, ৪ মিনিট)। RTO এর সবচেয়ে বড় অংশ মানুষের সিদ্ধান্ত, তাই runbook আর অনুশীলন। ছোট outage এ ধীর কৌশল কিছুই কেনে না
- **DNS failover এর একটা লেজ আছে যা TTL ছোঁয় না** (TTL ৬০ বা ৩০০, ৫ মিনিট পরে ৯%)। আর স্বয়ংক্রিয় failover এর বিপদ partition: witness ছাড়া দুটো primary (২,১৬০টা আলাদা লেখা), witness আর lease এ শূন্য
- **একাধিক region এ লেখা মানে নীরব ক্ষতি, আর ক্ষতি আসে খারাপ সময়ে।** দিনে ২,০৬৮টা (row LWW), তার ৯০% link খারাপ থাকা দুই ঘণ্টায়। Field ধরে তিন ভাগের এক ভাগ, HLC ঘড়ির ভুল সরায় কিন্তু concurrent না। Home region এ শূন্য, দাম ২.৮৬% edit এ ~১১৯ ms
- **Residency system এর প্রতিটা পথের গুণ।** DB আর S3 সরালে ১১টার ৯টা পথ বাইরে থাকে (DR, CDN, log, trace, search, analytics, identity, email, error tracker)। Cell সব সীমানায় রাখে, কিন্তু একটা স্থির ভিত্তি খরচ আছে (প্রথম customer এর আয়ের ১৩%)

---

## ৪. নতুন Term (Glossary)

| Term                               | অর্থ                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO / RTO**                      | RPO = দুর্যোগে সর্বোচ্চ কত সময়ের লেখা হারানো সহ্য (replication কেনে); RTO = কতক্ষণে আবার চালু (আগে থেকে চালু capacity আর অনুশীলন কেনে)। দুটো আলাদা হাতল, প্রতিটার মাসিক দাম আছে                                            |
| **Active-Passive / Active-Active** | Active-passive: একটা region traffic নেয়, আরেকটা অপেক্ষা করে — backup & restore, pilot light (data চালু, compute বন্ধ), warm standby (ছোট মাপে সব চালু)। Active-active: সব region traffic নেয়                              |
| **Geo-Routing**                    | User কে অবস্থান বা latency ধরে region এ পাঠানো আর region মরলে সরানো — GeoDNS (failover এ DNS এর লেজ থাকে) বা anycast / global load balancer (DNS বদলায় না)                                                                 |
| **Witness (quorum এর তৃতীয় ভোট)** | একটা তৃতীয় region এর ছোট node যে failover এর ভোটে majority বানায়; primary শুধু majority এর সাথে lease নবায়ন করতে পারে, বিচ্ছিন্ন হলে নিজেকে থামায় — region এর মাপে split brain ঠেকানো (6.1, 6.2)                        |
| **Home Region**                    | প্রতিটা data এর (যেমন workspace এর) একটা মালিক region, সব লেখা সেখানে — multi-region এ single-leader, write conflict নেই; দাম অন্য region এর user এর লেখায় একটা দূরের round trip                                           |
| **Cell-Based Architecture**        | System কে স্বাধীন, সম্পূর্ণ কপিতে (cell) ভাগ করা, প্রতিটা customer একটা cell এ, উপরে পাতলা global স্তর (routing, identity এর directory, billing); residency, latency আর ছোট blast radius দেয়, দাম প্রতি cell এর ভিত্তি খরচ |
| **Data Residency**                 | নির্দিষ্ট data নির্দিষ্ট সীমানার ভেতরে store আর process করার বাধ্যবাধকতা (চুক্তি বা আইন থেকে); database এর setting না, প্রতিটা পথের গুণ — backup, CDN, log, trace, search, analytics, বাইরের service                        |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. জার্মান customer এর চুক্তি: RPO ≤ ১ মিনিট, RTO ≤ ৩০ মিনিট, সব ব্যক্তিগত data EU তে, আর বছরে একবার DR এর প্রমাণ। EU cell ফ্রাঙ্কফুর্টে। (ক) DR এর জন্য কোন কৌশল আর কোন দ্বিতীয় region, আর `npm run failover` এর ধাপ ধরে আপনার RTO এর হিসাব দেখান। কোন ধাপ সবচেয়ে অনিশ্চিত? (খ) Failover এর runbook এর প্রথম পাঁচটা লাইন লিখুন। কে, কোন সংকেতে, কোন বোতাম। (গ) Global স্তরের (identity এর directory, routing) কী হবে যদি **সিঙ্গাপুর** মরে, যেখানে এই স্তর চলে? EU cell কি তখনও কাজ করবে?

2. TaskFlow একটা নতুন feature চায়: task এর description এ কয়েকজন একসাথে লিখবে, Google Docs এর মতো, আর একই workspace এর মানুষ ঢাকা আর লন্ডনে। Workspace এর home region মুম্বাই। (ক) প্রতিটা keystroke home region এ পাঠালে লন্ডনের user এর অভিজ্ঞতা কেমন হবে, `npm run conflicts` আর `latency` এর সংখ্যা দিয়ে? (খ) LWW কেন এখানে একদমই চলে না? (গ) একটা নকশা দিন: client এ কী, server এ কী, home region এর কী ভূমিকা, আর task এর status বা assignee এর মতো field এর জন্য কি একই নকশা লাগবে?

3. একজন user দুটো workspace এর member: একটা EU cell এ (তার কোম্পানি), একটা সিঙ্গাপুর cell এ (একটা open-source project)। TaskFlow এর তিনটা feature: login, "আমার সব কাজ" (সব workspace এ তাকে assign করা task এর তালিকা), আর সব workspace জুড়ে search। (ক) প্রতিটার জন্য data কোথায় থাকে আর request কোন পথে যায়, যাতে EU এর data EU এর বাইরে না যায়? (খ) "আমার সব কাজ" এর page একটা cell মরলে কী দেখাবে (10.3)? (গ) User এর নিজের profile (নাম, email, ছবি) কোন cell এ থাকবে, আর কেন এটা কঠিন প্রশ্ন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) RPO ≤ ১ মিনিট মানে async replica (pilot light বা তার উপরে)। RTO ≤ ৩০ মিনিট মানে warm standby বা active-active। দ্বিতীয় region অবশ্যই EU এর ভেতরে, ফ্রাঙ্কফুর্টের থেকে আলাদা failure domain (ধরুন আয়ারল্যান্ড বা প্যারিস)। Warm standby এর ধাপ:

```
ধরা            5 মি   (10.4 এর burn rate এর page — ফ্রাঙ্কফুর্টের SLI, বাইরে থেকে মাপা)
সিদ্ধান্ত       10 মি   (runbook এ আগে থেকে লেখা শর্ত; কে সিদ্ধান্ত নেয় নাম ধরে)
scale out      5 মি   (standby এর app ২ → পূর্ণ মাপ; autoscale এর max আগে থেকে উঁচু)
promote        2 মি   (replica → primary, ফ্রাঙ্কফুর্টকে fencing — পুরনো primary যেন না লেখে)
traffic        5 মি   (DNS TTL ৬০ s, বা global LB এ এক ক্লিক)
মোট           27 মি   — সীমা ৩০ এর নিচে, কিন্তু মাত্র ৩ মিনিটের margin
```

সবচেয়ে অনিশ্চিত **সিদ্ধান্ত**। একটা partial outage (কিছু service ধীর, কিছু ঠিক) এ "এটা কি failover এর মতো খারাপ?" এর তর্ক সহজে ২০ মিনিট নেয়। প্রতিকার: runbook এ সংখ্যায় শর্ত ("ফ্রাঙ্কফুর্টের সফলতার SLI ১০ মিনিট ধরে ৯০% এর নিচে, আর provider এর status এ region এর ঘটনা — failover করুন, জিজ্ঞেস না করে")। আর বছরে একবারের প্রমাণ শুধু চুক্তির জন্য না, এই ২৭ মিনিট আসলে ২৭ কিনা, সেটা জানার একমাত্র উপায়। দ্বিতীয় অনিশ্চিত: standby এ এমন কিছু নেই যা prod এ আছে (একটা secret, একটা নতুন queue, একটা quota)। তাই standby এর config prod এর সাথে একই IaC থেকে, আর CI তে একটা diff।

(খ) Runbook এর শুরু:

1. **শর্ত:** ফ্রাঙ্কফুর্টের board/login এর SLI ১০ মিনিট ধরে < ৯০% (বাইরের synthetic probe থেকে), **অথবা** provider ফ্রাঙ্কফুর্টে region স্তরের ঘটনা ঘোষণা করেছে। On-call engineer incident খোলে, EU cell এর মালিক (নাম, বিকল্প নাম) কে ডাকে।
2. **সিদ্ধান্ত:** EU cell এর মালিক অথবা on-call lead, ৫ মিনিটের মধ্যে, এই runbook এর শর্ত দেখে। "অপেক্ষা করি আরেকটু" এর জন্য সর্বোচ্চ ১০ মিনিট।
3. **Fencing আগে:** ফ্রাঙ্কফুর্টের database এ লেখা বন্ধ (security group এ app এর connection বন্ধ, বা DB কে read-only) — যদি পৌঁছানো যায়। না গেলে witness এর lease এর উপর ভরসা (সে নিজেকে থামাবে)।
4. **Standby promote আর scale:** একটা script (`dr-failover eu`), যেটা game day তে বারবার চালানো হয়েছে। Replica promote, app এর min ক্ষমতা পূর্ণ মাপে।
5. **Traffic:** global LB এ EU cell এর target বদল। Status page আর customer এর contact কে জানানো (চুক্তিতে নোটিশের সময় থাকে)।

(গ) এটাই cell এর নকশার সবচেয়ে সূক্ষ্ম প্রশ্ন। Global স্তর সিঙ্গাপুরে, সিঙ্গাপুর মরলে নতুন login এর প্রথম ধাপ (email → কোন cell) উত্তর দিতে পারে না। নকশা: (১) **directory প্রতিটা cell এ cache করা** (10.3 এর static stability) — EU cell জানে তার নিজের user দের, তাই EU user এর login EU cell এই শেষ হয়, global স্তর ছাড়া। (২) routing এর তালিকা (workspace → cell) global LB এর config এ, প্রতিটা cell এর কাছেও কপি। (৩) Global স্তর নিজেই কয়েকটা region এ (ছোট, প্রায় শুধু পড়ে, তাই replicate করা সস্তা), আর তার data তে কোনো ব্যক্তিগত তথ্য নেই, শুধু hash আর cell এর id। পরীক্ষা: game day তে global স্তর বন্ধ করে দেখুন EU এর user login করে কাজ করতে পারে কিনা। না পারলে, আপনার "স্বাধীন" cell আসলে স্বাধীন না।

**প্রশ্ন ২:**

(ক) প্রতিটা keystroke মুম্বাইয়ে (লন্ডন → মুম্বাই ~১২০ ms RTT): প্রতিটা অক্ষর server এ পৌঁছে ফিরে আসতে ~১২০ ms+। যদি UI server এর উত্তরের অপেক্ষা করে, লেখা কাঁপবে, অসহনীয়। `conflicts` এর অংশ খ এর p50 ১১৯ ms একটা **save** এর জন্য গ্রহণযোগ্য ছিল, প্রতিটা অক্ষরের জন্য না। আর `conflicts` এর মডেলে concurrent edit হয় যখন দুটো লেখা replication এর জানালার মধ্যে পড়ে। Rich text এ দুজন একসাথে টাইপ করলে প্রায় **প্রতিটা** keystroke concurrent।

(খ) LWW পুরো description কে একটা মান ধরে। ঢাকার user একটা অনুচ্ছেদ লিখল, লন্ডনের user আরেকটা, একই সময়ে। LWW একজনের পুরো লেখা ফেলে দেয়। Field ধরে LWW সাহায্য করে না, কারণ field একটাই। HLC সাহায্য করে না, কারণ তারা সত্যিই concurrent। ১.৬ এর হারানো edit এর হার এখানে প্রায় ১০০% হবে।

(গ) নকশা:

- **Client:** নিজের লেখা সাথে সাথে দেখায় (optimistic, local-first), পরিবর্তনগুলো একটা CRDT (যেমন Yjs বা Automerge এর মতো library) বা OT এর operation হিসেবে পাঠায়: "অবস্থান X এর পরে 'abc' ঢোকান", পুরো লেখা না।
- **Server (home region মুম্বাই):** sequencer আর relay। Operation গুলো গ্রহণ করে, ক্রম দেয় (OT এ জরুরি; CRDT এ ক্রম ছাড়াও মেলে, কিন্তু একটা জায়গায় জমা রাখা আর অন্যদের পাঠানো সহজ), টেকসই করে, আর অন্য client দের WebSocket এ (2.4) পাঠায়। লন্ডনের user তার নিজের লেখা সাথে সাথে দেখে, ঢাকার user এর লেখা দেখে ~১২০ ms পরে। গ্রহণযোগ্য, কারণ অন্যের লেখার জন্য কেউ অপেক্ষা করে না।
- **Home region এর ভূমিকা:** document এর একমাত্র টেকসই জায়গা আর relay। লন্ডনের কাছে একটা edge relay (ফ্রাঙ্কফুর্টে) রাখা যায় যা শুধু WebSocket ধরে রাখে, কিন্তু সত্যের উৎস একটাই।
- **Status, assignee:** না, একই নকশা লাগবে না। এগুলো ছোট, একক মান, আর কম ঘন ঘন বদলায়। Home region এ লেখা (একটা round trip, optimistic UI) আর conflict হলে শেষ লেখা জেতে, কারণ "দুজন একই মুহূর্তে status বদলাল" এর জন্য LWW আসলে সঠিক আচরণ (field ধরে, HLC সহ)। জটিলতা দিন শুধু সেখানে যেখানে মেলানোর অর্থ আছে।

**প্রশ্ন ৩:**

(ক)

- **Login:** browser global স্তরে email দেয়। Global directory তে শুধু `hash(email) → [EU cell, SG cell]`। Login (password বা SSO) হয় user এর **home cell** এ, যেখানে তার credential থাকে (নিচে গ)। Login এর পরে একটা token, যা দুটো cell ই যাচাই করতে পারে (10.5 এর JWT, প্রতিটা cell এর কাছে public key)। Token এ শুধু user id, কোনো ব্যক্তিগত data না।
- **"আমার সব কাজ":** browser (বা BFF) প্রতিটা cell কে আলাদা করে জিজ্ঞেস করে, user এর token দিয়ে, আর ফলগুলো **browser এ** বা user এর নিজের region এর BFF এ জোড়া হয়। EU এর task এর তালিকা EU cell থেকে সরাসরি user এর কাছে যায়, অন্য কোনো cell এ জমা হয় না। একটা global "সব কাজ" এর table (সব cell এর task এর কপি) সবচেয়ে সহজ নকশা, আর ঠিক সেটাই residency ভাঙে।
- **Search:** একই ছক — প্রতিটা cell এর নিজের index, query fan-out (5.8 এর scatter-gather), ফল জোড়া হয় user এর দিকে। কোনো global index না।

(খ) একটা cell মরলে (10.3): fan-out এর সেই অংশ timeout এ ব্যর্থ। Page পুরোটা ভাঙবে না। দেখাবে অন্য cell এর কাজ, আর একটা স্পষ্ট বার্তা: "EU workspace এর কাজ এখন দেখানো যাচ্ছে না।" এটা একটা soft dependency। Timeout ছোট (একটা cell এর ধীরতা পুরো page কে ধীর না করুক), আর সেই cell এর জন্য breaker (9.4)।

(গ) User এর profile কোথায়, সেটা কঠিন কারণ user একজন, কিন্তু তার সম্পর্ক দুটো সীমানায়। পথগুলো: (১) user এর একটা **home cell** (তার নিজের দেশ, বা প্রথম workspace এর cell), profile সেখানে, আর অন্য cell এ শুধু user id আর display name এর একটা ছোট কপি। কিন্তু display name নিজেই ব্যক্তিগত data, তাই একজন EU user এর নাম SG cell এ যায় যখন সে SG workspace এ কাজ করে। (২) Profile এর কোন অংশ কোথায় যাবে সেটা user এর নিজের পছন্দ বা চুক্তি দিয়ে ঠিক করা: "আপনি এই workspace এ join করছেন, যা সিঙ্গাপুরে, আপনার নাম আর ছবি সেখানে দেখা যাবে।" এটা আসলে একটা product আর আইনি প্রশ্ন, যার engineering উত্তর হলো: প্রতিটা ব্যক্তিগত data এর একটা জানা home, আর প্রতিটা কপি একটা জানা, সচেতন সিদ্ধান্ত। ১.৭ এর টেবিল এর জন্যই।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (চারটা deterministic model; cloud account বা Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.8-multi-region/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.8-multi-region) — `npm install`, তারপর `npm run latency`, `npm run failover`, `npm run conflicts`, `npm run residency`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`latency` পাঁচটা শহরের user কে চারটা topology তে চালায়: board খোলা, task তৈরি, লেখার পরে পুরনো পড়া। সাথে region জুড়ে majority এর commit। `failover` এ সিঙ্গাপুরের চার ঘণ্টার বিভ্রাটে পাঁচটা DR কৌশল (RTO, RPO, খরচ), DNS বদলানোর পরের লেজ, আর partition এ তিনটা failover এর নীতি। `conflicts` এক দিনের ১০ লাখ edit এ LWW এর তিনটা নিয়ম আর home region তুলনা করে। `residency` একজন EU customer এর data এর ১২টা পথ তিনটা নকশায় গোনে, আর একটা cell এর দাম তার আয়ের সাথে মেলায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, আপনার। **সব RTT আনুমানিক** (`src/geo.ts`), সাধারণ public internet এর round trip এর আন্দাজ, এখানে মাপা না। **Failover এর ধাপের সময়, DNS এর client এর আচরণ, replication এর lag, ঘড়ির skew আর session এর গঠন সব ধরে নেওয়া** সংখ্যা, env দিয়ে বদলানো যায়। খরচ 10.7 এর আনুমানিক দামের সাথে মেলানো। `conflicts` LWW এর নিয়ম একটা সরল replication এর মডেলে চালায়, আসল database না। `residency` একটা নকশার checklist, আইনি পরামর্শ না, আর GDPR আর data localization সম্পর্কে দাবিগুলো সাধারণ, এখানে যাচাই করা না। আলোর গতি আর Spanner/CockroachDB এর নকশার কথা প্রকাশিত লেখা থেকে। **যা মাপা হয়নি:** আসল cloud region এর latency, আসল DNS resolver এর আচরণ, আসল replication এর lag, CRDT, global database এর commit। ১.৮ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `latency` চালানোর **আগে** লিখে ফেলুন: প্রতি region এ app আর read replica দিলে লন্ডনের task তৈরি দ্রুত হবে না ধীর, আর কতটা? তারপর চালিয়ে মেলান। এবার `DB_READS=1` আর `API_CALLS=1` (BFF এর এক call) দিয়ে "সব সিঙ্গাপুরে + edge" এর লন্ডন কত হয়। দ্বিতীয় region এর আগে কতটা পাওয়া যায়?

2. **নিজের DR:** `DECIDE_MINUTES=3 npm run failover` আর `DECIDE_MINUTES=30 npm run failover`। কোন কৌশলের RTO কতটা নড়ে? তারপর `OUTAGE_MINUTES=30` এর সাথে মিলিয়ে বলুন: TaskFlow এর বেশিরভাগ region এর বিভ্রাট যদি ১ ঘণ্টার কম হয়, তাহলে কোন কৌশল আসলে কিছু কেনে?

3. **Conflict এর জানালা:** `CROSS_REGION=0.6 npm run conflicts`, তারপর `INCIDENT_LAG_S=60`। হারানো edit কীভাবে বাড়ে? এই দুটো সংখ্যা TaskFlow এ বাস্তবে কে নিয়ন্ত্রণ করে — product, না infrastructure?

4. **পঞ্চম region:** `src/geo.ts` এ `tokyo` যোগ করুন (RTT আপনার আন্দাজে), আর `latency.ts` এর consensus এর টেবিলে পাঁচ region এর একটা সারি। Commit কত, আর কয়টা region হারানো সহ্য করে? চার region এর চেয়ে ভালো কেন?

5. **Design অংশ:** TaskFlow এর "multi-region নীতি" এর এক পাতা। (ক) তিনটা কারণের প্রতিটার জন্য TaskFlow এর উত্তর, সংখ্যা সহ। (খ) প্রতিটা data এর ধরন (task, comment, attachment, user profile, billing, log, analytics) কোথায় থাকে আর কোথায় কপি হয়। (গ) DR এর RPO/RTO, কৌশল, আর অনুশীলনের সময়সূচি। (ঘ) Failover কে ঠিক করে আর কীভাবে, split brain ঠেকানোর ব্যবস্থা সহ। (ঙ) কোন শর্তে একটা নতুন cell খোলা হবে (customer এর সংখ্যা, আয়, চুক্তি), আর কোন শর্তে **না**।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ), 10.1 – 10.7
Current: 10.8 — Multi-region & geo-distribution
TaskFlow state: modular monolith + billing; gateway + BFF; saga; breaker + bulkhead; rate limit; cache ring;
Bloom/HLL; brownout; OpenTelemetry, burn rate; AuthN/AuthZ, OAuth PKCE, secret manager, DDoS এর স্তর;
graceful shutdown, canary + gate, flag, expand/contract; বিল $৮,২৭৬ (autoscale, commit, endpoint, lifecycle,
anomaly)। এক মাসে তিন চাপ: লন্ডন/নিউ ইয়র্কে board ~১ s (trial হারানো); সিঙ্গাপুর region এর ৪ ঘণ্টার বিভ্রাটে
পুরো TaskFlow বন্ধ; জার্মান customer (৬,০০০ seat) চায় EU তে সব ব্যক্তিগত data, RPO ≤ ১ মি, RTO ≤ ৩০ মি;
6.4 এর multi-region লেখার pilot এ দিনে ~২,০০০ edit নীরবে হারায় (৯০% link খারাপের সময়)। এখন: CDN edge এ TLS
+ BFF এ এক call (দ্বিতীয় region ছাড়া লন্ডন ৯২৫ → ~২০৯ ms); DNS TTL ৬০ s; multi-region লেখার pilot বন্ধ,
সব লেখা এক জায়গায় (field ধরে LWW + HLC এর পরে বন্ধ)। DR সবার জন্য: মুম্বাইয়ে async replica + S3
replication + IaC (pilot light, RPO ~৫ s, RTO ~৪০ মি, ~$৮৩৩/মাস), runbook, failover মানুষের হাতে এক বোতামে
(witness ছাড়া স্বয়ংক্রিয় না), ছয় মাসে game day (failback সহ)। EU cell ফ্রাঙ্কফুর্টে: সব ব্যক্তিগত data এর পথ
(log, trace, search, error tracker, email এর EU processing, CDN cache), DR আরেক EU region এ warm standby (RTO
~২৭ মি), বাইরে শুধু metric আর aggregate analytics; global স্তর (routing, hash(email) → cell, billing) ছোট,
প্রতি cell এ cache (static stability); workspace তৈরির সময় region বাছা। Cell এর খরচ ~$৪,৮৭০/মাস (প্রথম EU
customer এর আয়ের ১৩%)। সব region এ read replica — না (residency আর লেখা দুটোই ভাঙে)।
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7), Deploy / Release, Blue-Green Deployment, Canary Release, Feature Flag,
Version Skew, Lock Queue, Expand / Contract, Unit Economics, Cost Allocation, Commitment Discount, Spot
Instance, Data Transfer Cost, Storage Tiering, Cost Anomaly Detection, RPO / RTO, Active-Passive /
Active-Active, Geo-Routing, Witness, Home Region, Cell-Based Architecture, Data Residency
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: Module 10 Exit Challenge
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **multi-region তিনটা আলাদা সমস্যার তিনটা আলাদা উত্তর, আর প্রতিটার একটা স্পষ্ট দাম।** দূরত্ব round trip এ গুণ হয়, তাই প্রথমে round trip কমান, তারপর পড়াকে কাছে আনুন। লেখাকে কাছে আনলে দিতে হয় consistency, আর লেখার data কে টেকসই করলে দিতে হয় latency। RPO আর RTO কেনা যায়, আর তাদের বড় অংশ মানুষের অনুশীলন। Failover এর আসল বিপদ partition, আর তার উত্তর quorum। আর data residency একটা database এর setting না, system এর প্রতিটা পথের একটা গুণ।

Module 10 এখানে শেষ। আট lesson এ TaskFlow এর গায়ে আটটা স্তর বসেছে: consistent hashing আর probabilistic structure, fault tolerance আর chaos, observability, security, নিরাপদ deploy, cost, আর multi-region। প্রতিটা lesson এ একটা প্রশ্ন আলাদা করে মেপেছি। বাস্তবে একটা খারাপ রাতে সব একসাথে আসে: একটা region এর বিভ্রাট, তার মধ্যে একটা canary, একটা DDoS, আর মাসের শেষে একটা বিল। রেডি হলে `next` লিখুন — **Module 10 Exit Challenge** এ যাব। সেখানে একটা ঘটনার timeline দেব, যেখানে এই module এর প্রতিটা lesson এর একটা টুকরো আছে। আপনি সেটা পড়ে বলবেন কী ভাঙল, কেন, আর কোন সিদ্ধান্ত তাকে থামাতে পারত। তারপর একটা checklist আর পড়ার তালিকা।
