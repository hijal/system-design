# Lesson 5.9 — CAP Theorem, ACID vs BASE, আর Quorum (R + W > N)

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 4.2):** Write-behind caching এ data হারানোর ঝুঁকিটা ঠিক কোথায়? আর কোন ধরনের data এর জন্য এই ঝুঁকি মেনে নেওয়া যায়?

**Prerequisite:** Lesson 5.5 (ACID), Lesson 5.7 (Replication, RPO), Lesson 5.8 (Sharding)

**তুমি এই lesson শেষে পারবে:**

1. CAP theorem আসলে কী বলে (আর কী বলে না) — সঠিকভাবে বলতে পারবে, আর "CA database" জাতীয় দাবি কেন অর্থহীন সেটা ব্যাখ্যা করবে
2. PACELC দিয়ে দেখাবে যে partition ছাড়াও প্রতিদিন একটা trade-off চলে — latency বনাম consistency
3. Leaderless system এ `R + W > N` কেন stale read আটকায় — মাপা simulation দিয়ে দেখাবে; আর ACID বনাম BASE এর পার্থক্য দিয়ে TaskFlow এর কোন অংশ কোন দিকে যাবে ঠিক করবে

**Tier:** 1 — Runnable Code (single-process simulation, Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

Module 5 এর শুরুতে TaskFlow এর data ছিল একটা machine এ। এখন: primary আর read replica (Lesson 5.7), sharding এর পরিকল্পনা (Lesson 5.8), আর নতুন একটা প্রস্তাব — এশিয়ার customer দের জন্য সিঙ্গাপুরে দ্বিতীয় একটা data center।

গত মাসে ঢাকা আর সিঙ্গাপুর এর মধ্যের network link তিন মিনিটের জন্য কেটে গিয়েছিল। CTO এখন একটা প্রশ্ন নিয়ে এসেছেন, যেটার উত্তর আগে থেকে ঠিক করা থাকা দরকার:

> "পরের বার link কাটলে সিঙ্গাপুরের user রা কী দেখবে? তারা কি কাজ চালিয়ে যাবে — তাহলে ঢাকার data এর সাথে গরমিল হতে পারে? নাকি তাদের error দেখাব, যতক্ষণ না link ফেরে?"

একই সপ্তাহে একটা database vendor এর sales pitch: "আমাদের database **CA** — consistent **এবং** available, একসাথে!"

দুটো জিনিসের উত্তরই আজকের lesson এ। CAP theorem distributed system এর সবচেয়ে বিখ্যাত — আর সবচেয়ে বেশি ভুল বোঝা — ধারণা। Interview এ প্রায় নিশ্চিতভাবে আসে, আর ভুল উত্তরটাই সবচেয়ে প্রচলিত।

---

## ১. Theory

### ১.১ CAP — আসলে কী বলে

প্রচলিত রূপ: "Consistency, Availability, Partition tolerance — তিনটার মধ্যে যেকোনো দুটো বেছে নাও।" এই রূপটা বিভ্রান্তিকর। সঠিক রূপ:

**CAP theorem** — একটা distributed system এ যখন **network partition** ঘটে, তখন system কে বেছে নিতে হয়: হয় সব উত্তর সামঞ্জস্যপূর্ণ রাখবে (consistency), নয়তো প্রতিটা request এর উত্তর দেবে (availability) — দুটো একসাথে সম্ভব না।

তিনটা শব্দ সঠিক অর্থে:

- **Network partition** — কিছু node এর মধ্যে network যোগাযোগ বন্ধ হয়ে যাওয়া, যদিও node গুলো নিজেরা জীবিত আর চলছে। দুই দিকের কেউ জানে না অন্য দিক মৃত নাকি শুধু বিচ্ছিন্ন।
- **Consistency (CAP এর অর্থে)** — এখানে এর অর্থ **linearizability**: system এমনভাবে আচরণ করে যেন data এর একটাই কপি আছে — একটা লেখা সফল হওয়ার পর, যে কেউ যেকোনো node থেকে পড়ুক, সেই লেখা (বা তার পরের কিছু) দেখবে। (Lesson 5.5 এর ACID এর "C" এর সাথে এর কোনো সম্পর্ক নেই — নাম এক, অর্থ আলাদা।)
- **Availability (CAP এর অর্থে)** — প্রতিটা জীবিত node এ আসা প্রতিটা request একটা সাধারণ (error না এমন) উত্তর পায়।

কেন দুটো একসাথে অসম্ভব, দুটো node দিয়েই দেখা যায়:

```
   Client 1                                        Client 2
      │ লেখো: title = "Fix signup"                     │ পড়ো: title?
      ▼                                                ▼
  ┌────────┐        ✂ network কাটা ✂           ┌────────┐
  │ Node A │  ──────────── ✗ ────────────────  │ Node B │
  │ নতুন মান│                                    │ পুরনো মান│
  └────────┘                                    └────────┘

  Node B এখন Client 2 কে কী বলবে?
    (ক) পুরনো মান দাও  → available, কিন্তু consistent না (A তে নতুন মান আছে)
    (খ) error দাও / অপেক্ষা করো → consistent, কিন্তু available না
    তৃতীয় কোনো পথ নেই — B এর কাছে নতুন মান জানার কোনো উপায় নেই।
```

**এখান থেকেই "CA" দাবির উত্তর:** partition tolerance কোনো ঐচ্ছিক জিনিস না যেটা "বেছে না নেওয়া" যায়। একাধিক machine মানেই network, আর network ভাঙে। যে system দাবি করে সে CA, সে আসলে হয় (১) একটাই machine এ চলে — তাহলে সে distributed ই না, CAP প্রযোজ্যই না; নয়তো (২) partition এর সময় কী করে সেটা বলছে না — আর যখন partition আসবে, তখন তাকে C বা A এর যেকোনো একটা ছাড়তেই হবে। তাই সঠিক প্রশ্ন সবসময়: **"partition হলে তুমি কী ছাড়ো?"** — CP নাকি AP।

### ১.২ Partition কেমন দেখায় — আর কেন এটা বিরল না

Partition মানে শুধু কেউ cable কেটে দেওয়া না:

- দুই data center এর মধ্যের link এর সমস্যা (TaskFlow এর তিন মিনিট)
- একটা network switch overload
- একটা node এর দীর্ঘ GC pause — কয়েক সেকেন্ডের জন্য সে কারো সাথে কথা বলে না; বাকিদের কাছে সে "বিচ্ছিন্ন"
- Cloud provider এর ভেতরের network এর সমস্যা

আর সবচেয়ে গুরুত্বপূর্ণ কথা: **একটা node এর দিক থেকে "অন্যটা মৃত" আর "অন্যটার সাথে network কাটা" — এই দুটো আলাদা করে বোঝার কোনো উপায় নেই।** দুটোতেই শুধু উত্তর আসে না। এই অনিশ্চয়তাই distributed system এর মূল কঠিনতা — Lesson 5.7 এর split brain এর উৎস, আর Lesson 6.1 এর পুরো বিষয়।

### ১.৩ CP বনাম AP — চোখে দেখা

Exercise এর `npm run partition` — ৫টা node, ঢাকায় ৩টা (n1 n2 n3), সিঙ্গাপুরে ২টা (n4 n5), মাঝের link কাটা। দুজন একই task এর title বদলাচ্ছে: রহিম (ঢাকা, আসল সময় ১০০ ms) "Fix login", করিম (সিঙ্গাপুর, আসল সময় ২০০ ms — **পরে**) "Fix signup"।

**CP — strict quorum:** লেখা বা পড়া সফল হতে ৫টার মধ্যে অন্তত ৩টা node লাগবে (majority)।

```
রহিম (ঢাকা, ৩টা node)       লিখল "Fix login"   → সফল ✓
করিম (সিঙ্গাপুর, ২টা node)  লিখল "Fix signup"  → ব্যর্থ ✗ — error দেখল, আবার চেষ্টা করতে হবে
partition চলাকালীন পড়া: ঢাকা → "Fix login",  সিঙ্গাপুর → ✗ উত্তর নেই (quorum নেই)
network জোড়া লাগার পর সবাই পড়ে: "Fix login"
```

সবাই সবসময় একই সত্য দেখেছে — কিন্তু সিঙ্গাপুরের user রা তিন মিনিট কিছু করতে পারেনি। Majority থাকা দিক চলে, অন্য দিক থেমে যায় — এই নিয়ম থাকায় দুই দিক কখনো একসাথে ভিন্ন কিছু লিখতে পারে না।

**AP — যেকোনো node লেখা নেয়, পরে মেলানো হয় last-write-wins (LWW) দিয়ে।** আর বাস্তবের মতো, সিঙ্গাপুরের n4 এর ঘড়ি ৩০০ ms পিছিয়ে:

```
partition চলাকালীন পড়া: ঢাকা → "Fix login",  সিঙ্গাপুর → "Fix signup"  ← দুই দিকে দুই সত্য
network জোড়া লাগল — দুটো version পাওয়া গেল:
  "Fix login" (রহিম), timestamp 100 ms
  "Fix signup" (করিম), timestamp -100 ms
LWW বিজয়ী: "Fix login" (রহিম)
```

দুজনেই কাজ চালিয়ে গেছে, দুজনেই "saved" দেখেছে। কিন্তু network ফেরার পর করিমের লেখা — যেটা আসলে **পরে** হয়েছিল — **নীরবে হারিয়ে গেল**, কারণ "পরে" ঠিক হয়েছে n4 এর ভুল ঘড়ি দিয়ে। কোনো error নেই, কোনো log নেই। (Lesson 5.7 এর multi-leader conflict এর সাথে মেলাও — আর কেন wall clock বিশ্বাস করা যায় না, সেটা Lesson 6.4।)

**আর তুমি এর আগেই এই বাছাই চোখে দেখেছ** — Lesson 5.7 এর Postgres exercise এ:

- **Sync replication, replica বিচ্ছিন্ন:** commit চিরকাল অপেক্ষায় — primary লেখা নিচ্ছে না। এটা **CP** এর বাছাই: ভুল উত্তরের চেয়ে কোনো উত্তর না।
- **Async replication, তারপর failover:** লেখা চলতে থাকল — কিন্তু ২০টা "saved" task promote হওয়া replica তে ছিল না, হারিয়ে গেল। এটা **AP** ধরনের বাছাই: সবসময় লেখা নাও, দাম হিসেবে কিছু লেখা হারানোর ঝুঁকি।

মানে একই database (Postgres) configuration অনুযায়ী দুই দিকেই যেতে পারে। "Postgres CP নাকি AP?" প্রশ্নটার উত্তর: **কীভাবে চালাচ্ছ তার উপর নির্ভর করে।**

### ১.৪ PACELC — Partition না থাকলেও একটা বাছাই

CAP এর একটা বড় সীমাবদ্ধতা: এটা শুধু partition এর মুহূর্তের কথা বলে, আর partition বিরল। কিন্তু বাকি ৯৯.৯৯% সময়ও একটা trade-off চলে, যেটা CAP বলে না।

**PACELC** — CAP এর একটা বিস্তৃত রূপ: **P**artition হলে **A**vailability আর **C**onsistency এর মধ্যে বাছাই; **E**lse (partition না থাকলে) **L**atency আর **C**onsistency এর মধ্যে বাছাই।

"Else" অংশটা তুমি ইতিমধ্যে দুবার মেপেছ:

- **Lesson 5.7:** `remote_apply` (consistent read-your-writes) → প্রতিটা লেখা ২ ms থেকে ২০২ ms। Consistency কিনতে latency দিলে।
- **আজকের quorum simulation (১.৫):** `W = 3` → প্রতিটা লেখা p50 ~৪০ ms, কারণ অন্য data center এর replica এর অপেক্ষা; `W = 1` → ২.৩ ms, কিন্তু ১০% পর্যন্ত stale read।

কোনো network ভাঙেনি — তবু বাছাই করতে হয়েছে। বাস্তবে এই "EL/EC" বাছাইটাই প্রতিদিনের design সিদ্ধান্তে বেশি গুরুত্বপূর্ণ।

### ১.৫ Quorum — `R + W > N`

Lesson 5.7 এ দেখেছ leader-follower replication: সব লেখা একজন leader এ। Dynamo (Amazon এর) ধারণা থেকে আসা Cassandra, Riak, আর DynamoDB এর মতো system এ কোনো leader নেই — client (বা একটা coordinator) সরাসরি কয়েকটা replica তে লেখে আর কয়েকটা থেকে পড়ে। তিনটা সংখ্যা দিয়ে এটা নিয়ন্ত্রিত:

- **N** — প্রতিটা data এর কয়টা কপি
- **W** — একটা লেখা সফল বলার আগে কয়টা replica কে নিশ্চিত করতে হবে
- **R** — একটা পড়ায় কয়টা replica থেকে উত্তর নিতে হবে (তাদের মধ্যে সবচেয়ে নতুন version টা নেওয়া হয়)

**Quorum** — একটা কাজ সফল বলার জন্য ন্যূনতম কতগুলো replica এর সম্মতি লাগে; `R + W > N` হলে পড়া আর লেখার replica দল সবসময় অন্তত একটা replica তে মেলে।

কেন মেলে? N = ৩, W = ২, R = ২:

```
replica:      A      B      C
লেখা (W=2):   ✓      ✓      ·      ← A আর B নতুন মান পেয়েছে
পড়া (R=2):   ·      ✓      ✓      ← যেকোনো ২টা থেকে পড়ো...
                     ▲
                     └── ২ + ২ = ৪ > ৩ — দুটো দলের অন্তত একটা replica সাধারণ হতেই হবে।
                         তাই পড়ার দলে অন্তত একজনের কাছে নতুন মান আছে।
```

এটা শুধু একটা গণিতের যুক্তি — তিনটা বাক্সে চারটা বল রাখলে কোনো একটা বাক্সে দুটো পড়বেই। এবার মেপে দেখা যাক। Exercise এর `npm run quorum` — N = ৩, দুটো replica একই data center এ, একটা অন্য data center এ (ধীর); আর বাস্তবের মতো যেকোনো replica মাঝে মাঝে (৫% লেখায়) ৫০ ms পিছিয়ে পড়ে (GC pause, disk stall)। প্রতিটা জোড়ায় ১ লাখ বার "লেখো, সফল হলে সাথে সাথে পড়ো":

```
W  R  W+R>N?   stale read              লেখা p50 / p99       পড়া p50 / p99
1  1  না       10827/100000 (10.83%)     2.3 /   7.0 ms     2.3 /   5.6 ms
1  2  না         227/100000 ( 0.23%)     2.3 /   7.0 ms     4.1 /  11.1 ms
2  1  না        3707/100000 ( 3.71%)     4.4 /  53.1 ms     2.3 /   5.6 ms
2  2  হ্যাঁ         0/100000 ( 0.00%)     4.4 /  53.1 ms     4.1 /  11.1 ms
3  1  হ্যাঁ         0/100000 ( 0.00%)    39.6 / 103.1 ms     2.3 /   5.6 ms
1  3  হ্যাঁ         0/100000 ( 0.00%)     2.3 /   7.0 ms    36.8 /  86.4 ms
```

তিনটা শিক্ষা:

1. **`R + W > N` হলে একটাও stale read নেই** — ১ লাখে ০, তিনটা জোড়াতেই। `≤ N` এ ০.২% থেকে ১০.৮%। "প্রায় সবসময় ঠিক" মানে দিনে লাখো request এ হাজার বার ভুল।
2. **Consistency এর দাম latency তে (PACELC এর EL/EC)।** `W = 3` মানে প্রতিটা লেখা অন্য data center এর replica এর অপেক্ষায় (p50 ~৪০ ms); `W = R = 2` সেই ধীর replica কে এড়িয়ে যায় — quorum এর দুটো দ্রুত replica ই যথেষ্ট।
3. **একটা সৎ স্বীকারোক্তি:** এই simulation প্রথমে "মাঝে মাঝে পিছিয়ে পড়া" ছাড়া বানিয়েছিলাম। তখন `(1, 2)` আর `(2, 1)` এও ০টা stale read এসেছিল — দেখে মনে হতো `R + W ≤ N` ও নিরাপদ। সেটা ছিল শুধু ভাগ্য: দুটো দ্রুত replica প্রায় সবসময় একসাথে এগিয়ে থাকত। `R + W ≤ N` মানে "ভুল হবে" না — মানে **"ঠিক হওয়ার কোনো নিশ্চয়তা নেই"**, আর খারাপ দিনে (একটা replica পিছিয়ে পড়লে) সেটা ভুল হয়। নিশ্চয়তা শুধু `R + W > N` দেয়।

**Availability এর দিক** — একই exercise:

```
W  R   │ ০টা মৃত      │ ১টা মৃত      │ ২টা মৃত
1  1   │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✓
2  2   │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✓ │ লেখা ✗ পড়া ✗
3  1   │ লেখা ✓ পড়া ✓ │ লেখা ✗ পড়া ✓ │ লেখা ✗ পড়া ✓
1  3   │ লেখা ✓ পড়া ✓ │ লেখা ✓ পড়া ✗ │ লেখা ✓ পড়া ✗
```

`W = R = 2` (N = ৩) — একটা replica মরলেও সব চলে, consistency ও থাকে। এজন্যই এটা সবচেয়ে প্রচলিত বাছাই। সাধারণ নিয়ম: N টা replica তে `W = R = ⌊N/2⌋ + 1` (majority) — `N = 5` হলে ৩, আর তখন ২টা replica মরলেও চলে।

এই system গুলোর একটা শক্তি: W আর R **প্রতিটা query তে আলাদা** করে ঠিক করা যায়। Cassandra তে একটা query `ONE` consistency তে (দ্রুত, দুর্বল), আরেকটা `QUORUM` এ (ধীর, শক্ত) চালানো যায় — একই data তে। একে বলে tunable consistency।

**সৎ সতর্কতা — quorum জাদু না:**

- দুজন **একসাথে** একই key তে লিখলে দুটো লেখাই W টা replica তে পৌঁছাতে পারে — তখন কোনটা থাকবে? আবার LWW (১.৩ এর সমস্যা) বা sibling (নিচে)।
- অনেক system এ "sloppy quorum" থাকে — নির্ধারিত replica না পেলে অন্য কোনো node এ লিখে রাখে (availability বাড়াতে)। তখন `R + W > N` এর নিশ্চয়তা আর খাটে না।
- একটা লেখা চলার **মাঝখানে** পড়লে, একটা read নতুন মান দেখতে পারে আর তার ঠিক পরের read পুরনো মান — তাই `R + W > N` একাই পুরোপুরি linearizability দেয় না। নিখুঁত consistency এর জন্য আরও কিছু লাগে (read repair কে synchronous করা, বা consensus — Lesson 6.2)।
- এই exercise এর simulation এ এসব জটিলতা নেই — এটা শুধু মূল overlap এর যুক্তিটা দেখায়।

### ১.৬ ACID বনাম BASE

Lesson 5.5 এ ACID দেখেছ। AP দিকের system গুলোর দর্শন কে প্রায়ই একটা বিপরীত নামে ডাকা হয়:

**BASE** — **B**asically **A**vailable (partition বা failure এও প্রায় সবসময় উত্তর দেয়), **S**oft state (replica গুলোর অবস্থা সাময়িকভাবে ভিন্ন হতে পারে), **E**ventually consistent (নতুন লেখা বন্ধ হলে একসময় সবাই এক হবে)।

**Eventual consistency** — নতুন লেখা না এলে, একসময় সব replica একই মানে পৌঁছাবে। লক্ষ করো এর দুর্বলতা: "একসময়" কতক্ষণ — কোনো সীমা বলা নেই। আর সেই সময়ের মধ্যে যেকোনো পড়া পুরনো মান দিতে পারে। Lesson 5.7 এর async replica eventually consistent; ১.৩ এর AP দিকও — আর সেখানে "এক হওয়া" ঘটেছে একজনের লেখা ফেলে দিয়ে।

| দিক           | ACID                                       | BASE                                             |
| ------------- | ------------------------------------------ | ------------------------------------------------ |
| অগ্রাধিকার    | সঠিকতা (correctness)                       | availability আর scale                            |
| পড়া          | সবসময় সর্বশেষ commit (isolation অনুযায়ী) | পুরনো হতে পারে; একসময় নতুন                      |
| Partition এ   | সাধারণত অপেক্ষা বা error (CP)              | উত্তর দেয়, পরে মেলায় (AP)                      |
| Conflict      | Transaction আর lock দিয়ে আটকানো (5.5)     | পরে সমাধান — LWW, sibling, CRDT                  |
| সাধারণ উদাহরণ | Postgres, MySQL (single leader)            | Cassandra, DynamoDB (default), DNS (Lesson 2.1!) |

এটা কঠোর দুই ভাগ না — এটা একটা বর্ণালী। DynamoDB তে strongly consistent read আর transaction আছে; MongoDB তে multi-document transaction আছে (Lesson 5.1); Postgres এর async replica তে পড়লে তুমি BASE এর দুনিয়ায়। প্রশ্নটা database এর নাম না — **তুমি প্রতিটা data এর জন্য কোন guarantee চাও।**

আর conflict সামলানোর একটা ভিন্ন দর্শন মনে রাখার মতো: Amazon এর Dynamo paper (২০০৭) এ shopping cart এর উদাহরণ — cart সবসময় লেখার যোগ্য থাকবে (AP), আর conflict হলে দুটো version ই রেখে (sibling) মিলিয়ে ফেলা হবে (দুটো cart এর জিনিস যোগ)। Paper এ তারা নিজেরাই এর দাম স্বীকার করেছে: কখনো কখনো মুছে ফেলা জিনিস cart এ আবার ফিরে আসে। একটা cart এ সেটা মেনে নেওয়া যায়; একটা bank balance এ না।

### ১.৭ TaskFlow — কোন অংশ কোন দিকে

CAP আর ACID/BASE এর আসল ব্যবহার এখানে — পুরো system এর জন্য একটা বাছাই না, **প্রতিটা data এর জন্য আলাদা**:

| TaskFlow এর data                      | বাছাই                                                                          | কেন                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Billing, subscription, payment        | CP, ACID, sync commit (5.7)                                                    | দুবার charge বা হারানো payment — সবচেয়ে দামি ভুল       |
| Permission (কে admin, কে দেখতে পারে)  | CP, SERIALIZABLE (5.5)                                                         | ভুল permission মানে security bug — অপেক্ষা ভালো         |
| Task, comment (মূল কাজ)               | Single leader per shard (5.8); read replica থেকে পড়া + read-your-writes (5.7) | লেখা সঠিক; পড়ায় কয়েক ms পুরনো চলে, নিজের লেখা ছাড়া  |
| Activity feed, notification এর সংখ্যা | AP / eventual                                                                  | কয়েক সেকেন্ড পিছিয়ে থাকলে কেউ টের পায় না             |
| Online presence (কে এখন online)       | AP, TTL (Module 4)                                                             | ভুল হলে ক্ষতি নেই; সবসময় দ্রুত উত্তর জরুরি             |
| "কতবার দেখা হয়েছে" জাতীয় counter    | AP, পরে যোগ (CRDT-ধরনের)                                                       | একটু পিছিয়ে থাকা চলে, কিন্তু সব region এ লেখা নিতে হবে |

CTO এর প্রশ্নের উত্তরও এখন দেওয়া যায়: link কাটলে সিঙ্গাপুরের user রা task দেখতে পারবে (পুরনো কপি থেকে), notification আর activity চলতে থাকবে (AP) — কিন্তু billing আর permission বদলানো সাময়িকভাবে বন্ধ থাকবে (CP), একটা পরিষ্কার message সহ। এটাই বাস্তব system design: **একটা বাছাই না, অনেকগুলো, প্রতিটা তার data এর দাম অনুযায়ী।**

---

## ২. Interview Angle

**"CAP theorem ব্যাখ্যা করো"** — প্রায় নিশ্চিত প্রশ্ন, আর দুর্বল উত্তরটাই সবচেয়ে প্রচলিত: "তিনটার মধ্যে দুটো বেছে নাও।" শক্ত উত্তর:

1. "Partition এর সময় consistency আর availability এর মধ্যে একটা বাছতে হয় — partition tolerance ঐচ্ছিক না, কারণ network ভাঙবেই।"
2. দুই node এর উদাহরণ দিয়ে কেন (১.১ এর diagram)
3. "CAP এর consistency মানে linearizability — ACID এর C না"
4. "আর partition না থাকলেও latency বনাম consistency এর বাছাই আছে — PACELC"

**Quorum এর গণিত প্রশ্ন:** "N = ৫, এমন W আর R বাছো যাতে stale read না হয় আর ২টা node মরলেও লেখা ও পড়া দুটোই চলে।" — উত্তর: `W = R = 3` (৩ + ৩ = ৬ > ৫; ৫ − ২ = ৩ টা জীবিত, দুটোর জন্যই যথেষ্ট)। Follow-up: "read-heavy হলে?" — `R` কমাও, `W` বাড়াও (যেমন `W = 4, R = 2`, তবে তখন ২টা মরলে লেখা বন্ধ — trade-off টা বলো)।

**"এই system এর জন্য কোন database?"** — PACELC দিয়ে ভাবো আর বলো: "এই data এর জন্য partition এ কী ছাড়া চলে, আর প্রতিদিন কতটা latency দেওয়া চলে" — তারপর database। আর ১.৭ এর মতো, একই system এ ভিন্ন data এর ভিন্ন বাছাই।

**Production এ বাস্তবে:** partition সত্যিই হয় — cloud provider দের incident report পড়লে নিয়মিত দেখবে। যে team আগে থেকে ঠিক করে রেখেছে কোন data কোন দিকে, তারা সেই দিন শান্ত থাকে। বাকিরা আবিষ্কার করে যে তাদের system নিজে থেকেই একটা বাছাই করে ফেলেছে — প্রায়ই সবচেয়ে খারাপটা।

---

## ৩. Key Takeaway

- CAP: **partition হলে** consistency আর availability এর যেকোনো একটা ছাড়তে হয়; partition tolerance ঐচ্ছিক না — তাই "CA distributed database" অর্থহীন দাবি
- CAP এর C = **linearizability** (একটাই কপি যেন), ACID এর C না; A = প্রতিটা জীবিত node প্রতিটা request এর error-ছাড়া উত্তর দেয়
- একই database configuration অনুযায়ী দুই দিকে যায় — Lesson 5.7 এ sync replication আটকে ছিল (CP), async failover এ লেখা হারাল (AP)
- **PACELC**: partition না থাকলেও latency বনাম consistency — `W = 3` এ লেখা p50 ২.৩ থেকে ~৪০ ms
- Quorum: **`R + W > N`** — ১ লাখে ০ stale read; `≤ N` এ ০.২–১০.৮%; আর stall ছাড়া মাপলে `≤ N` ও নিরাপদ **দেখায়** — ভাগ্য, নিশ্চয়তা না
- Quorum জাদু না — একসাথে লেখা, sloppy quorum, আর মাঝপথের পড়া এখনো সমস্যা; majority (`⌊N/2⌋ + 1`) সবচেয়ে প্রচলিত বাছাই
- ACID বনাম BASE একটা বর্ণালী; **প্রতিটা data এর জন্য আলাদা বাছাই** — billing/permission CP, feed/presence/counter AP

---

## ৪. নতুন Term (Glossary)

| Term                     | অর্থ                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **CAP Theorem**          | Network partition এর সময় একটা distributed system consistency আর availability দুটো একসাথে দিতে পারে না     |
| **Network Partition**    | কিছু node এর মধ্যে যোগাযোগ বন্ধ, যদিও node গুলো নিজেরা জীবিত — কেউ জানে না অন্য দিক মৃত নাকি বিচ্ছিন্ন     |
| **Linearizability**      | System এমন আচরণ করে যেন data এর একটাই কপি — একটা লেখা সফল হলে তার পরের সব পড়া সেটা দেখে (CAP এর C)        |
| **PACELC**               | Partition হলে A বনাম C; না হলে (Else) Latency বনাম Consistency — CAP এর বিস্তৃত রূপ                        |
| **BASE**                 | Basically Available, Soft state, Eventually consistent — ACID এর বিপরীতে availability-প্রথম দর্শন          |
| **Eventual Consistency** | নতুন লেখা না এলে একসময় সব replica একই মানে পৌঁছাবে — কখন, তার কোনো সীমা নেই                               |
| **Quorum**               | একটা কাজ সফল হতে ন্যূনতম কতগুলো replica এর সম্মতি লাগে; `R + W > N` হলে পড়া আর লেখার দল অন্তত একটায় মেলে |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. Database vendor বলছে তাদের product "CA — consistent এবং available।" Meeting এ তুমি কোন একটা প্রশ্ন জিজ্ঞেস করবে যেটা এই দাবির আসল অর্থ বের করে আনবে? আর সম্ভাব্য উত্তরগুলো কী হতে পারে?
2. TaskFlow একটা leaderless store এ user এর notification preference রাখবে — N = ৫। এটা খুব read-heavy (প্রতিটা notification পাঠানোর আগে পড়া হয়), খুব কম লেখা হয়। নিয়ম: stale read চলবে না, আর যেকোনো ২টা node মরলেও **পড়া** চলতে হবে। W আর R কত নেবে? কোন দামটা মেনে নিচ্ছ?
3. Amazon এর shopping cart AP বেছে নিয়েছিল — আর মেনে নিয়েছিল যে মুছে ফেলা জিনিস কখনো কখনো ফিরে আসবে। TaskFlow এর কোন একটা feature এর জন্য এই ধরনের বাছাই (AP + sibling মেলানো) যুক্তিসঙ্গত, আর কোনটার জন্য একেবারেই না? প্রতিটার জন্য একটা করে উদাহরণ দাও।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** "**Network partition এর সময় ঠিক কী হয়?** — যেমন আমাদের দুটো data center এর মধ্যের link কাটলে, দুই দিকের client রা কি লিখতে পারবে? পড়লে কি সর্বশেষ মান পাবে?" সম্ভাব্য উত্তর আর তাদের অর্থ: (ক) "আমাদের database একটা machine এ চলে" → CAP প্রযোজ্যই না, আর তাহলে সেই machine মরলে availability শূন্য — "A" দাবিটাই দুর্বল। (খ) "Minority দিক লেখা প্রত্যাখ্যান করে" → এটা আসলে **CP**। (গ) "দুই দিকই লেখা নেয়, পরে মেলানো হয়" → এটা আসলে **AP**, আর পরের প্রশ্ন: "কীভাবে মেলান — LWW হলে কোন লেখা হারায়?" (ঘ) "Partition আমাদের সাথে হয় না" → এটা সবচেয়ে বিপজ্জনক উত্তর — তারা এর কথা ভাবেনি, আর যেদিন হবে সেদিন system একটা অপরিকল্পিত বাছাই করবে। CAP এর আসল ব্যবহার এটাই — একটা দাবিকে সঠিক প্রশ্নে পরিণত করা।

**প্রশ্ন ২:** শর্ত: `R + W > 5` (stale read নেই), আর ২টা মরলেও পড়া চলবে → জীবিত ৩টা থেকে পড়তে হবে → `R ≤ 3`। Read-heavy, তাই R যত ছোট তত দ্রুত পড়া। `R = 1` হলে `W = 5` (১ + ৫ > ৫) — পড়া সবচেয়ে দ্রুত, আর ৪টা মরলেও পড়া চলবে; দাম: প্রতিটা লেখা ৫টা replica এর অপেক্ষায় (সবচেয়ে ধীরটার সমান), আর **একটা** node মরলেই লেখা বন্ধ। `R = 2, W = 4` — পড়া প্রায় সমান দ্রুত, একটা node মরলেও লেখা চলে। Preference খুব কম বদলায়, তাই লেখা মাঝে মাঝে ধীর বা সাময়িক বন্ধ মেনে নেওয়া যায় — `R = 2, W = 4` একটা ভালো মাঝামাঝি; আর `R = 1, W = 5` যুক্তিসঙ্গত যদি লেখা বন্ধ হওয়া সত্যিই সমস্যা না হয় (user কে "একটু পরে চেষ্টা করো" দেখানো)। মূল শিক্ষা: W আর R এর মধ্যে "consistency এর বাজেট" ভাগ করা যায় — read-heavy এ বেশিরভাগ বোঝা লেখার উপর।

**প্রশ্ন ৩:** **যুক্তিসঙ্গত:** task এর label/tag set — দুই region এ দুজন একই task এ ভিন্ন tag যোগ করল; মেলানোর সময় দুটো set এর union নাও (দুটো tag ই থাকবে)। কখনো কখনো মুছে ফেলা tag ফিরে আসতে পারে — বিরক্তিকর, কিন্তু ক্ষতিকর না, আর user নিজেই আবার মুছতে পারে। একই যুক্তি "কে এই task দেখেছে" এর তালিকা, বা reaction/emoji count। **একেবারেই না:** billing/subscription (দুটো version মানে হয়তো দুবার charge, বা plan downgrade হয়ে আবার upgrade), আর permission — কাউকে project থেকে সরানো হলো, আর partition এর পর মেলানোয় সে আবার ফিরে এলো — এটা একটা security bug, "বিরক্তিকর" না। নিয়ম: **ভুল মেলানোর সবচেয়ে খারাপ ফলটা কী** — সেটা মেনে নেওয়া গেলে AP, না গেলে CP।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (single-process simulation)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.9-quorum/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.9-quorum) — `npm install`, তারপর `npm run quorum` আর `npm run partition`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

একটা ছোট, seed দেওয়া simulation — প্রতিটা network যাত্রার সময় নিয়ন্ত্রিত, তাই প্রতিবার হুবহু একই ফল। `quorum` ছয়টা (W, R) জোড়া মাপে; `partition` একটা ৩|২ partition এ CP আর AP এর গল্প চালায়। Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean, কয়েকবার চালিয়ে হুবহু একই output। মনে রেখো এটা simulation — আসল leaderless database এর সব আচরণ (hinted handoff, read repair) এতে নেই।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. দুটো script চালাও, README এর সাথে মিলিয়ে দেখো (হুবহু মেলার কথা)।

2. **ভাগ্যের ফাঁদ** (README experiment ১): `STALL_PROBABILITY` কে `0` করো। `(1, 2)` আর `(2, 1)` এর ফল দেখে কেউ যদি বলে "`R + W ≤ N` ও তো নিরাপদ" — তাকে এক অনুচ্ছেদে কী বলবে?

3. **N = ৫** (experiment ২): দুটো replica যোগ করে `(3, 3)`, `(2, 3)`, `(3, 2)` মাপো। কোন জোড়া সবচেয়ে কম latency তে stale read শূন্য রাখে, আর কেন?

4. **ঘড়ি ঠিক করো** (experiment ৩): n4 এর skew শূন্য করো। LWW এখন কাকে জেতায়? তাহলে কি ঘড়ি ঠিক থাকলেই LWW নিরাপদ? দুটো কারণ দাও কেন না।

5. **Design অংশ:** TaskFlow সিঙ্গাপুরে দ্বিতীয় data center খুলছে। ১.৭ এর table টা নিজের মতো করে বানাও — কমপক্ষে ছয় ধরনের data, প্রতিটার জন্য: partition এ CP নাকি AP, স্বাভাবিক সময়ে latency নাকি consistency (PACELC), আর কোন প্রযুক্তি (Postgres sync/async, quorum store, cache)। তারপর CTO এর প্রশ্নের উত্তর তিন লাইনে লেখো: "link কাটলে সিঙ্গাপুরের user কী দেখবে?"

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9
Current: 5.9 — CAP Theorem, ACID vs BASE, Quorum (Module 5 এর শেষ lesson)
TaskFlow state: Express instance গুলো, CDN, Redis cache; PostgreSQL primary + read replica,
sharding এর প্রস্তুতি (workspaceId); দ্বিতীয় region এর পরিকল্পনা — data অনুযায়ী CAP বাছাই:
billing/permission CP (sync, SERIALIZABLE), task single-leader + replica, feed/presence/counter AP
Terms learned (Module 5): Relational Model, Schema-on-write, Schema-on-read, Access Pattern,
Document Store, Wide-column Store, Polyglot Persistence, Cardinality, Junction Table,
Data Anomaly, Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion, Leader-Follower Replication,
Replication Lag, Read-Your-Writes Consistency, Synchronous Replication,
Failover, RPO/RTO, Multi-Leader Replication, Partitioning, Sharding,
Shard Key, Partition Pruning, Hot Partition, Scatter-Gather, Resharding,
CAP Theorem, Network Partition, Linearizability, PACELC, BASE,
Eventual Consistency, Quorum
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: Module 5 Exit Challenge
=======================
```

---

## ৮. পরের ধাপ

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের উত্তর আর ৫ নম্বরের table। এটা Module 5 এর শেষ lesson। রেডি হলে `next` লিখো — **Module 5 Exit Challenge** এ যাব: একটা mini design challenge (Tier 3) যেখানে পুরো module — data model, index, transaction, pool, replication, sharding, CAP — একটা বাস্তব scenario তে একসাথে প্রয়োগ করতে হবে, একটা "তুমি এগুলো পারার কথা" checklist, আর বই/ভিডিও/project এর recommendation। তারপর Module 6 — Distributed Systems Core, যেখানে আজকের অনেক "Lesson 6.x এ" প্রতিশ্রুতি পূরণ হবে: কেন "অন্যটা মৃত কিনা" জানা এত কঠিন, consensus, আর কেন ঘড়ি বিশ্বাস করা যায় না।
