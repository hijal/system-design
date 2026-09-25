# Lesson 5.3 — Storage Engine Internals: B-tree vs LSM-tree, আর WAL

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 1.5):** Availability আর Reliability এর পার্থক্য কী? এমন একটা উদাহরণ দাও যেখানে একটা system **available** কিন্তু **reliable** না।

**Prerequisite:** Lesson 1.3 (Latency numbers), Lesson 4.1 (Buffer Pool), Lesson 5.1 (SQL vs NoSQL), Lesson 5.2 (Schema)

**তুমি এই lesson শেষে পারবে:**

1. Database disk এ data কীভাবে রাখে (page), আর B-tree কেন ৪ লাখ row এর মধ্যে একটা row মাত্র কয়েকটা page পড়ে খুঁজে পায় — ব্যাখ্যা করতে পারবে
2. WAL কীভাবে crash এর পরেও committed data বাঁচায় — নিজের ভাষায় বলতে পারবে
3. B-tree আর LSM-tree এর trade-off (write, read, space) বলে, একটা workload এর জন্য কোন ধরনের storage engine মানায় সেটা যুক্তি দিয়ে বলতে পারবে

**Tier:** 3 — Design Exercise (সাথে একটা optional "নিজের চোখে দেখো" অংশ, Docker এ চালানো যায়)

---

## ০. TaskFlow এখন কোথায়

গত সপ্তাহে রাত ২টায় cloud provider TaskFlow এর database VM টা হঠাৎ restart করেছে — কোনো নোটিশ ছাড়া, যেন কেউ plug টেনে দিয়েছে। On-call engineer ঘুম ভেঙে দেখল Postgres এর log এ লেখা:

```
LOG:  database system was not properly shut down; automatic recovery in progress
LOG:  redo starts at 0/14F4028
LOG:  redo done at 0/1BE6E78
LOG:  database system is ready to accept connections
```

কয়েক সেকেন্ড পরে সব চালু। আর সবচেয়ে অবাক করা ব্যাপার — crash এর ঠিক আগের মুহূর্তে যে task গুলো তৈরি হয়ে "saved" দেখিয়েছিল, তার **একটাও হারায়নি**।

কীভাবে? Database তো data কে memory তে (buffer pool, Lesson 4.1) রাখে — memory তো power গেলে মুছে যায়। তাহলে "redo" জিনিসটা কী, আর কোথা থেকে সে data ফিরিয়ে আনল?

একই সপ্তাহে আরেকটা আলোচনা: Lesson 5.1 এ আমরা activity log নিয়ে ভেবেছিলাম। একজন বলল, "Cassandra write-heavy কাজের জন্য বানানো, কারণ ও LSM-tree ব্যবহার করে।" LSM-tree কী? আর Postgres এর B-tree কি write এ খারাপ?

দুটো প্রশ্নের উত্তরই একই জায়গায় — database এর সবচেয়ে নিচের স্তরে, যাকে বলে **storage engine**: যে অংশটা ঠিক করে data disk এ কীভাবে সাজানো থাকবে, কীভাবে লেখা হবে, আর কীভাবে খুঁজে পাওয়া যাবে। আজ আমরা সেখানে নামব।

---

## ১. Theory

### ১.১ Disk এর একক — Page

Lesson 1.3 এর latency table মনে করো: memory থেকে পড়া disk থেকে পড়ার চেয়ে হাজার গুণের বেশি দ্রুত। আর disk থেকে পড়ার খরচের বড় অংশটা হলো "যাওয়া" — একবার গেলে ১ byte পড়ো বা কয়েক হাজার byte, খরচ প্রায় একই।

তাই database কখনো একটা একটা row করে disk এ পড়ে-লেখে না। সে কাজ করে নির্দিষ্ট আকারের block এ, যাকে বলে **page**।

**Page** — database এর disk আর memory এর মধ্যে data আনা-নেওয়ার সবচেয়ে ছোট একক। Postgres এ default ৮ KB, MySQL এর InnoDB তে ১৬ KB।

```
PostgreSQL এর "tasks" table (disk এ)
┌──────────────┬──────────────┬──────────────┬─────────┬──────────────┐
│   page 0     │   page 1     │   page 2     │   ...   │  page 2842   │
│  (৮ KB)      │  (৮ KB)      │  (৮ KB)      │         │  (৮ KB)      │
│ row, row,    │ row, row,    │ row, row,    │         │ row, row     │
│ row, ...     │ row, ...     │ row, ...     │         │              │
└──────────────┴──────────────┴──────────────┴─────────┴──────────────┘
```

এই সংখ্যাগুলো বানানো না — Lesson 5.2 এর মতো ৪ লাখ row এর একটা `tasks` table বানিয়ে Postgres 17 এ মাপা: table টা **২২ MB, মানে ২৮৪৩টা page**। প্রতিটা row এর একটা ঠিকানা আছে, যেটাকে Postgres বলে `ctid` — (page নম্বর, page এর ভেতরে কত নম্বর)। যেমন `id = 123456` এর row টা থাকে `(809, 57)` এ: page ৮০৯, ৫৭ নম্বর জায়গা।

Lesson 4.1 এর **buffer pool** এখন আরও পরিষ্কার: সেটা আসলে এই page গুলোরই memory তে রাখা কপি। Query এর সময় database আগে দেখে page টা buffer pool এ আছে কিনা; না থাকলে disk থেকে পুরো ৮ KB page টা আনে।

এখন প্রশ্ন: ২৮৪৩টা page এর মধ্যে `id = 123456` কোন page এ আছে, সেটা database জানবে কীভাবে — সব page পড়ে?

### ১.২ B-tree — কয়েকটা page পড়েই খুঁজে পাওয়া

সব page পড়া (যাকে বলে sequential scan) মানে ২৮৪৩ বার page পড়া। এটা এড়াতে database একটা আলাদা, **sorted** গঠন রাখে — index। আর প্রায় সব relational database এর default index হলো B-tree।

**B-tree** — একটা sorted, অনেক-শাখার গাছ, যার প্রতিটা node একটা page। উপরের node গুলো "পথনির্দেশক" (কোন key কোন দিকে), আর সবচেয়ে নিচের **leaf** node গুলোতে থাকে আসল key আর row এর ঠিকানা। (Database এ যেটা ব্যবহার হয় সেটা আসলে B+tree নামের একটা রূপ, কিন্তু সবাই B-tree ই বলে।)

```
                           ┌────────────────────────────┐
  level 2 (root)           │  < 110k │ < 220k │ < 330k │ …│     ← ১টা page
                           └────┬─────────┬─────────┬───┘
                    ┌───────────┘         │         └──────────┐
                    ▼                     ▼                    ▼
  level 1   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
            │ <367│<734│ …  │    │ …  │<123.5k│…│    │      …        │  ← কয়েকটা page
            └───┬───────────┘    └───────┬───────┘    └───────────────┘
                ▼                        ▼
  level 0 ┌──────────────┐       ┌──────────────────────────┐
  (leaf)  │ 1→(0,1) …    │  …    │ … 123456→(809,57) …      │  ← ১০৯৯টা page,
          │ 367→(2,14)   │       │                          │     প্রতিটায় ~৩৬৭টা key
          └──────────────┘       └────────────┬─────────────┘
                                              │ ctid ধরে সরাসরি
                                              ▼
                                   table এর page 809, row 57
```

মাপা সংখ্যা (৪ লাখ row, primary key index): index টা **১০৯৯টা page**, প্রতিটা leaf page এ **৩৬৭টা key**, আর পুরো গাছটা মাত্র **৩ স্তর গভীর**। তাই `WHERE id = 123456` এর জন্য Postgres পড়ে:

```
root page (১) → level 1 page (১) → leaf page (১) → table page (১) = ৪টা page
```

`EXPLAIN (ANALYZE, BUFFERS)` ঠিক এটাই দেখায়: `Buffers: shared hit=4`। ২৮৪৩ এর জায়গায় ৪।

রহস্যটা **fan-out** এ — একটা node এর নিচে কতগুলো শাখা। প্রতিটা node একটা পুরো ৮ KB page, তাই তাতে কয়েকশো key ধরে। প্রতি স্তরে কয়েকশো গুণ বাড়ে, তাই ৪-৫ স্তরের গাছেই কোটি কোটি row ধরে যায়। Row সংখ্যা হাজার গুণ বাড়লে গাছ বাড়ে মাত্র এক-দুই স্তর। এই কারণেই index থাকলে একটা বিশাল table এও একটা row খোঁজা প্রায় সমান দ্রুত।

**B-tree তে লেখা:** নতুন key আসলে সঠিক leaf page খুঁজে সেখানেই (in-place) বসানো হয়। Page ভরে গেলে সেটা দুই ভাগ হয় (page split), আর উপরের node এ একটা নতুন পথনির্দেশক যোগ হয়। মূল কথা — লেখা হয় **গাছের নির্দিষ্ট জায়গায়**, যেটা disk এর যেকোনো জায়গায় হতে পারে। মানে অনেক **random write**।

Index কীভাবে query তে কাজে লাগে, composite index, কেন কখনো কখনো index থাকলেও ব্যবহার হয় না — এগুলো পরের lesson (5.4) এর পুরো বিষয়। আজকের জন্য এটুকুই: B-tree = sorted গাছ, কয়েকটা page পড়ে খোঁজা, জায়গামতো লেখা।

### ১.৩ WAL — Crash এর পরেও data বাঁচানো

এবার রাত ২টার রহস্য।

একটা task তৈরি করলে Postgres কে table এর একটা page আর index এর এক বা একাধিক page বদলাতে হয়। প্রতিটা commit এ সেই সব ৮ KB page সাথে সাথে disk এ লেখা দুটো কারণে খারাপ:

1. **ধীর** — page গুলো disk এর আলাদা আলাদা জায়গায় (random write), আর একটা ছোট row এর জন্য পুরো ৮ KB লেখা
2. **বিপজ্জনক** — তিনটা page লেখার মাঝখানে power গেলে? একটা লেখা হয়েছে, দুটো হয়নি — table আর index এখন একে অপরের সাথে মেলে না

সমাধানটার নাম **WAL (Write-Ahead Log)** — data page বদলানোর **আগে** "কী বদলাতে যাচ্ছি" সেটা একটা আলাদা, শুধু-শেষে-যোগ-হয় (append-only) file এ লিখে রাখা। নিয়ম একটাই: **log আগে, data পরে।**

```
একটা commit এর যাত্রা:

১. Buffer pool (memory) এ page বদলাও        ┌──────────────────────┐
   — disk এ এখনো কিছু লেখা হয়নি             │ memory: page 809 ✎   │
                                              └──────────────────────┘
২. পরিবর্তনের বর্ণনা WAL এর শেষে যোগ করো     ┌──────────────────────────────────┐
   — sequential, ছোট (একটা insert ≈ ৪৪০ byte) │ WAL: …│insert│update│insert ← নতুন │
                                              └──────────────────────────────────┘
৩. WAL টা disk এ নিশ্চিতভাবে লেখো (fsync)
   — এরপরেই client কে "COMMIT সফল" বলা হয়    ✓ এখন data নিরাপদ

৪. বদলানো data page গুলো disk এ লেখা হয়     (পরে, ধীরে সুস্থে, একসাথে অনেকগুলো)
   পরে — background এ, checkpoint এর সময়
```

**Checkpoint** — নির্দিষ্ট সময় পরপর buffer pool এর সব বদলানো page disk এ লিখে দেওয়া, যাতে বলা যায় "এই বিন্দু পর্যন্ত সব data file এ আছে"।

এখন crash এর পর কী হয়: Postgres চালু হয়ে দেখে শেষ checkpoint কোথায়, তারপর সেখান থেকে WAL পড়ে প্রতিটা পরিবর্তন আবার প্রয়োগ করে — এটাই log এর **"redo"**। যে পরিবর্তন WAL এ আছে (মানে commit হয়েছিল) কিন্তু data page এ পৌঁছায়নি, সেগুলো এখন পৌঁছে যায়।

এটা শুধু তত্ত্ব না — Docker এ চালিয়ে দেখা হয়েছে: ৫০,০০০ row insert করে commit, তারপর **সাথে সাথে** `SIGKILL` (plug টানার সমান)। Restart এ Postgres ~৭ MB WAL replay করল, আর **৪৬৩টা page লিখল যেগুলো crash এর সময় তখনো disk এ পৌঁছায়নি** — তারপর গুনে দেখা গেল ৫০,০০০টাই আছে।

কেন WAL দ্রুত? কারণ এটা **sequential** — সবসময় file এর শেষে যোগ হয়, disk কে এদিক-ওদিক যেতে হয় না। আর ছোট — পুরো page না, শুধু পরিবর্তনটুকু। Random, বড় কাজটা (data page লেখা) পরে একসাথে হয়।

**একটা নিয়ন্ত্রণযোগ্য trade-off:** Postgres এ `synchronous_commit = off` দিলে ধাপ ৩ এর অপেক্ষা বাদ যায় — commit আরও দ্রুত, কিন্তু crash হলে **শেষ মুহূর্তের কিছু commit হারাতে পারে** (Postgres এর documentation অনুযায়ী data corrupt হয় না, শুধু সাম্প্রতিক কিছু transaction হারায়)। TaskFlow এর analytics event এর জন্য হয়তো চলে; payment এর জন্য কখনো না। এটা পুরো database এর জন্য না, **প্রতি transaction এ** আলাদা করে ঠিক করা যায়।

আর একটা preview: এই WAL ই Postgres এর **replication** এর ভিত্তি। Replica server আসলে primary এর WAL stream পেয়ে নিজের কাছে replay করে। Lesson 5.7 এ এটা ফিরে আসবে।

### ১.৪ LSM-tree — কখনো জায়গামতো লিখব না

B-tree তে লেখা মানে গাছের সঠিক জায়গা খুঁজে সেখানে বসানো — random write। এখন ধরো তোমার workload এমন: **সেকেন্ডে লাখো write**, বেশিরভাগ নতুন data (message, sensor reading, event), update প্রায় নেই। তখন প্রশ্ন আসে: WAL এর মতো **সব কিছুই** যদি শুধু শেষে যোগ করে লিখি?

এটাই **LSM-tree (Log-Structured Merge-tree)** এর মূল ধারণা। Cassandra, ScyllaDB, RocksDB, LevelDB — সবাই এটা ব্যবহার করে।

```
WRITE                                              READ (key = "task:42")
─────                                              ────
  │                                                  │
  ├──> commit log (WAL, sequential) — crash safety   │
  │                                                  ▼
  ▼                                            ১. memtable এ আছে? ──── হ্যাঁ → ফেরত
┌──────────────────────────┐                        │ না
│ MEMTABLE (memory, sorted)│                        ▼
│ task:17, task:42, task:99│                  ২. SSTable-3 (সবচেয়ে নতুন)? ── না
└────────────┬─────────────┘                        ▼
             │ ভরে গেলে পুরোটা একবারে           ৩. SSTable-2? ── হ্যাঁ → ফেরত
             │ disk এ লেখা (sequential)             (SSTable-1 পর্যন্ত যেতেই হলো না)
             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ SSTable-3    │ │ SSTable-2    │ │ SSTable-1    │   ← disk এ, immutable, প্রতিটা sorted
│ (নতুন)       │ │              │ │ (পুরনো)      │
└──────────────┘ └──────────────┘ └──────────────┘
        └──────────── COMPACTION ───────────┘
          background এ কয়েকটা মিশিয়ে একটা বানায়,
          পুরনো version আর মোছা data ফেলে দিয়ে
```

তিনটা নতুন অংশ:

- **Memtable** — memory তে রাখা একটা sorted গঠন, যেখানে নতুন write প্রথমে যায়। (Crash এ memtable হারালে commit log থেকে ফিরিয়ে আনা হয় — ঠিক WAL এর মতো।)
- **SSTable (Sorted String Table)** — memtable ভরে গেলে সেটা পুরোটা একবারে disk এ লেখা হয় একটা sorted, **immutable** (আর কখনো বদলাবে না) file হিসেবে। লেখাটা sequential — তাই দ্রুত।
- **Compaction** — সময়ের সাথে অনেক SSTable জমে যায়, আর একই key এর পুরনো version গুলো বিভিন্ন file এ ছড়িয়ে থাকে। Background এ কয়েকটা SSTable মিলিয়ে একটা নতুন বানানো হয় — প্রতিটা key এর শুধু সর্বশেষ version রেখে।

**Update আর delete কীভাবে?** কিছুই জায়গামতো বদলায় না। Update মানে নতুন version লেখা — পড়ার সময় সবচেয়ে নতুনটা জেতে। Delete মানে একটা বিশেষ চিহ্ন লেখা — "এই key মোছা হয়েছে" (একে বলে tombstone) — আর আসল data টা সত্যিই মোছে compaction। এর একটা বাস্তব ফাঁদ আছে: অনেক delete হলে প্রচুর tombstone জমে, আর read কে সেগুলো পার হয়ে যেতে হয় — Cassandra ব্যবহারকারীদের মধ্যে এটা পরিচিত একটা performance সমস্যা।

**Read এর দাম:** একটা key খুঁজতে হয়তো memtable আর কয়েকটা SSTable দেখতে হয়। এটা কমাতে প্রতিটা SSTable এর সাথে একটা ছোট **bloom filter** রাখা হয় — যেটা দ্রুত বলে দিতে পারে "এই key এই file এ **নিশ্চিতভাবে নেই**", তাই অনেক file না খুলেই বাদ দেওয়া যায়। (Bloom filter কীভাবে কাজ করে, সেটা Lesson 10.2 এর বিষয়।)

### ১.৫ তিনটা Amplification — আসল Trade-off

**Write amplification** — application একটা ছোট জিনিস লিখতে চাইল, কিন্তু disk এ আসলে তার চেয়ে অনেক গুণ বেশি byte লেখা হলো। দুই engine ই এটা করে, ভিন্ন কারণে:

- B-tree: একটা ছোট row বদলালেও পুরো ৮ KB page লেখা হয় (সাথে WAL)
- LSM: একই data compaction এর সময় বারবার নতুন SSTable এ লেখা হয় — প্রতিটা স্তর পার হওয়ার সময় একবার করে

এর সাথে আরও দুটো:

- **Read amplification** — একটা জিনিস পড়তে কতগুলো জায়গা দেখতে হয়
- **Space amplification** — আসল data এর তুলনায় disk এ কত বেশি জায়গা লাগে (পুরনো version, মোছা data যেটা এখনো সরানো হয়নি)

| দিক                       | B-tree (Postgres, MySQL InnoDB)                  | LSM-tree (Cassandra, RocksDB)                              |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| লেখা                      | জায়গামতো, random write                          | সবসময় শেষে যোগ, sequential — উঁচু write throughput        |
| পড়া (একটা key)           | অনুমানযোগ্য — গাছের উচ্চতা অনুযায়ী কয়েকটা page | memtable + কয়েকটা SSTable (bloom filter সাহায্য করে)      |
| Range scan ("৪২ থেকে ৯৯") | খুব ভালো — leaf গুলো sorted, পাশাপাশি            | ভালো, কিন্তু কয়েকটা SSTable মিলিয়ে পড়তে হয়             |
| Update/Delete             | জায়গামতো                                        | নতুন version / tombstone, আসল পরিষ্কার compaction এ        |
| Background কাজ            | Checkpoint (Postgres এ VACUUM ও — নিচে দেখো)     | Compaction — CPU আর disk I/O খায়, latency spike আনতে পারে |
| কীসের জন্য বানানো         | সাধারণ কাজ — মিশ্র read/write, transaction       | বিশাল write volume, time-series, append-heavy              |

**সৎ সতর্কতা:** "B-tree = read এর জন্য, LSM = write এর জন্য" — এটা একটা কাজের **সাধারণ নিয়ম**, আইন না। বাস্তব performance নির্ভর করে workload, hardware (SSD তে random write এর দাম HDD এর চেয়ে অনেক কম), আর configuration (যেমন কোন compaction strategy) এর উপর। একই workload এ কে জিতবে — সেটা **মেপে** দেখতে হয়।

**Postgres এর নিজস্ব একটা মোড়:** Postgres এর table (index না) আসলে পুরোপুরি "জায়গামতো" update করে না। UPDATE করলে সে row এর একটা **নতুন version** লেখে, আর পুরনোটা কিছুক্ষণ রেখে দেয় — যাতে সেই মুহূর্তে চলা অন্য transaction গুলো পুরনো version টা দেখতে পারে। মাপা উদাহরণ: `id = 7` এর row ছিল `ctid (0,7)` এ; `UPDATE` এর পর সেটা হয়ে গেল `(0,158)` — নতুন জায়গায় নতুন version। পুরনো version গুলো পরে পরিষ্কার করে **VACUUM** নামের background process। এর নাম MVCC — আর এটা কেন আছে, সেটা Lesson 5.5 (transaction ও isolation) এর মূল বিষয়।

### ১.৬ কেন Postgres আর Cassandra এত আলাদা

এখন Lesson 5.1 এর প্রশ্নটার গভীর উত্তর দেওয়া যায়। Storage engine আলাদা কারণ **লক্ষ্য** আলাদা:

- **Postgres** বানানো হয়েছে একটা general-purpose database হিসেবে: যেকোনো query, JOIN, multi-row transaction, মিশ্র read/write। তাই B-tree — অনুমানযোগ্য read, ভালো range scan, সব কিছুর জন্য "যথেষ্ট ভালো"।
- **Cassandra** বানানো হয়েছে অনেকগুলো machine জুড়ে বিশাল write volume সামলাতে, যেখানে data বেশিরভাগ append (message, event)। তাই LSM — write সবসময় sequential, আর compaction এর দাম পরে, background এ।

কে কী ব্যবহার করে (শেখার জন্য জানা ভালো, মুখস্থ করার দরকার নেই):

| B-tree ভিত্তিক                        | LSM ভিত্তিক                                     |
| ------------------------------------- | ----------------------------------------------- |
| PostgreSQL (index; table heap + MVCC) | Cassandra, ScyllaDB                             |
| MySQL (InnoDB)                        | RocksDB, LevelDB (অনেক system এর নিচে embedded) |
| SQLite                                | CockroachDB (Pebble — RocksDB-অনুপ্রাণিত)       |

**TaskFlow এর জন্য এর মানে কী?** Storage engine database বেছে নেওয়ার **একটা** কারণ, একমাত্র না। Lesson 5.1 এর পাঁচটা প্রশ্ন (data shape, access pattern, consistency, সংখ্যা, operations) এখনো প্রথমে আসে। Storage engine এর জ্ঞান তোমাকে শুধু আরেকটা প্রশ্ন করতে শেখায়: "এই workload এ write কত, আর সেটা কি append-heavy?" — আর উত্তরটা **সংখ্যা দিয়ে** দিতে হবে, "write-heavy" শব্দটা দিয়ে না। সেকেন্ডে কয়েকশো write একটা B-tree database এর জন্য খুবই সাধারণ; LSM এর সুবিধা স্পষ্ট হয় যখন সংখ্যাটা অনেক, অনেক বড় আর একটা machine এ আর ধরে না।

---

## ২. Interview Angle

Storage engine নিয়ে সরাসরি প্রশ্ন senior interview এ বেশি আসে, কিন্তু যেকোনো level এ এটা **"কেন এই database?"** প্রশ্নের উত্তরকে শক্ত করে।

**সাধারণ প্রশ্ন গুলো:**

- _"Database crash করলে committed data হারায় না কেন?"_ — WAL: log আগে, data পরে; commit মানে WAL disk এ নিশ্চিত; restart এ শেষ checkpoint থেকে redo। বোনাস: `synchronous_commit` এর trade-off বলা
- _"Index কেন query দ্রুত করে?"_ — B-tree, page-sized node, বিশাল fan-out, তাই কয়েকটা page পড়েই খোঁজা। বোনাস: "৪ লাখ row এ ৩ স্তর" এর মতো একটা সংখ্যা বলতে পারা
- _"Cassandra কেন write এ দ্রুত?"_ — LSM: memtable + commit log, disk এ শুধু sequential write, update/delete ও নতুন write; দাম হলো read এ একাধিক SSTable আর background compaction

**যেটা ভালো উত্তরকে আলাদা করে:** trade-off টা নিজে থেকে বলা। "LSM write এ দ্রুত" বলার পরে যোগ করো — "কিন্তু compaction CPU আর disk খায়, মাঝে মাঝে latency spike আনে, আর অনেক delete থাকলে tombstone read কে ধীর করে।" এটা দেখায় তুমি শুধু slide মুখস্থ করোনি।

**Production এ বাস্তবে:** বেশিরভাগ engineer কখনো নিজে storage engine বদলায় না — কিন্তু এর জ্ঞান প্রতিদিন কাজে লাগে: কেন একটা বিশাল `UPDATE` এর পর table ফুলে যায় (MVCC + VACUUM), কেন WAL এর disk ভরে গেলে database থেমে যায়, কেন Cassandra এ অনেক delete করা table হঠাৎ ধীর — এগুলো সবই আজকের lesson এর সরাসরি ফল।

---

## ৩. Key Takeaway

- Database disk এ কাজ করে **page** এ (Postgres এ ৮ KB) — row এ না; buffer pool সেই page গুলোরই memory কপি
- **B-tree** = sorted, অনেক-শাখার গাছ, প্রতিটা node একটা page; বিশাল fan-out এর কারণে ৪ লাখ row এ মাত্র ৩ স্তর — একটা row খুঁজতে ৪টা page
- **WAL**: log আগে, data পরে — commit মানে ছোট, sequential log disk এ নিশ্চিত; data page পরে checkpoint এ; crash এর পর redo
- **LSM-tree**: কখনো জায়গামতো লেখা না — memtable → immutable SSTable → compaction; update মানে নতুন version, delete মানে tombstone
- আসল trade-off তিনটা amplification এ — write, read, space; "B-tree read এর জন্য, LSM write এর জন্য" একটা সাধারণ নিয়ম, আইন না
- Storage engine database এর **লক্ষ্য** থেকে আসে — Postgres general-purpose (B-tree), Cassandra বিশাল append-heavy write (LSM)
- "Write-heavy" একটা অনুভূতি; সিদ্ধান্ত নাও **সংখ্যা** দিয়ে

---

## ৪. নতুন Term (Glossary)

| Term                      | অর্থ                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Page**                  | Database এর disk আর memory এর মধ্যে data আনা-নেওয়ার সবচেয়ে ছোট একক (Postgres এ ৮ KB)            |
| **B-tree**                | Sorted, অনেক-শাখার গাছ যার প্রতিটা node একটা page — কয়েকটা page পড়েই key খোঁজা যায়             |
| **WAL (Write-Ahead Log)** | Data page বদলানোর আগে পরিবর্তনটা একটা append-only log এ লিখে রাখা, যাতে crash এর পর redo করা যায় |
| **Memtable**              | LSM-tree এ নতুন write প্রথমে যায় এমন memory তে রাখা sorted গঠন                                   |
| **SSTable**               | Memtable ভরে গেলে disk এ লেখা sorted, immutable file                                              |
| **Compaction**            | কয়েকটা SSTable মিলিয়ে একটা বানানো, পুরনো version আর মোছা data ফেলে দিয়ে                        |
| **Write Amplification**   | Application যা লিখতে চেয়েছে তার তুলনায় disk এ আসলে কত গুণ বেশি byte লেখা হলো                    |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. WAL ছাড়াও তো database প্রতিটা commit এ বদলানো data page গুলো সাথে সাথে disk এ লিখে দিতে পারত — তাহলেও তো data হারাত না। WAL এর বাড়তি জটিলতা কেন? অন্তত দুটো কারণ বলো।
2. একটা LSM database এ একটা user এর profile (একই key) দিনে ১০০ বার update হয়। দুই সপ্তাহ পরে disk এ কী অবস্থা, আর compaction না চললে সেই key পড়তে কী হবে? B-tree database এ একই কাজ করলে পার্থক্য কী?
3. TaskFlow এর একজন engineer performance বাড়াতে পুরো database এ `synchronous_commit = off` করে দিতে চাইছে। তুমি কী বলবে? পুরোপুরি "না" বলার বদলে কোনো মাঝামাঝি পথ আছে কি?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** (ক) **গতি** — একটা commit এ কয়েকটা page বদলাতে পারে, সেগুলো disk এর ভিন্ন ভিন্ন জায়গায় (random write), আর প্রতিটা পুরো ৮ KB, যদিও বদল হয়তো কয়েকশো byte। WAL এ শুধু পরিবর্তনটুকু (একটা insert ≈ ৪৪০ byte), আর সেটা একটা file এর শেষে — sequential। (খ) **Atomicity** — কয়েকটা page লেখার মাঝখানে crash হলে কিছু page নতুন, কিছু পুরনো — table আর index মেলে না, আর কোনটা শেষ হয়েছিল বোঝার উপায় নেই। WAL এ পুরো পরিবর্তনের বর্ণনা একটা জায়গায়, তাই redo দিয়ে ঠিক করা যায়। (গ) বোনাস: অনেকগুলো commit এর page একসাথে checkpoint এ লেখা যায় — একটা page দশবার বদলালেও disk এ হয়তো একবার লেখা হয়। আর একই WAL দিয়ে replication ও চলে (Lesson 5.7)।

**প্রশ্ন ২:** LSM এ প্রতিটা update একটা **নতুন version** — জায়গামতো কিছু বদলায় না। দুই সপ্তাহে ১৪০০টা version বিভিন্ন SSTable এ ছড়িয়ে আছে (space amplification)। পড়ার সময় সবচেয়ে নতুনটা খুঁজতে memtable থেকে শুরু করে নতুন→পুরনো SSTable দেখা হয় — সর্বশেষ version টা সাধারণত নতুন file এ থাকে বলে দ্রুতই পাওয়া যায়, কিন্তু compaction না চললে SSTable এর সংখ্যা বাড়তেই থাকে, disk ভরে, আর যে key গুলো পুরনো file এ আছে সেগুলোর read ধীর হয় (read amplification)। Compaction ১৪০০টা version থেকে একটা রাখে। B-tree এ (index এর দিক থেকে) key একটাই জায়গায়, প্রতিবার সেখানেই বদলায় — space প্রায় বাড়ে না। (Postgres এর table এ MVCC এর কারণে পুরনো row version কিছুক্ষণ থাকে, সেটা VACUUM পরিষ্কার করে — এক অর্থে এটাও একটা "compaction" এর মতো কাজ।)

**প্রশ্ন ৩:** পুরো database এ বন্ধ করা মানে crash এ যেকোনো **সাম্প্রতিক** commit হারাতে পারে — task, comment, এমনকি ভবিষ্যতের payment। User "saved" দেখেছে কিন্তু data নেই — এটা reliability ভাঙা (spaced repetition প্রশ্নের সাথে মেলাও: system available থাকবে, কিন্তু reliable না)। মাঝামাঝি পথ: `synchronous_commit` **প্রতি transaction এ** ঠিক করা যায় (`SET LOCAL synchronous_commit = off`)। তাই শুধু যেখানে সাম্প্রতিক কিছু data হারানো গ্রহণযোগ্য — যেমন analytics event, "last seen" timestamp — সেখানে বন্ধ করো; task, comment, billing এ default (on) রাখো। আর আগে মেপে দেখো commit latency আসলেই সমস্যা কিনা — প্রায়ই bottleneck অন্য কোথাও।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

আমি এখনই model answer দিচ্ছি না — তুমি চেষ্টা করার পর critique করব।

> নিচের চারটা workload এর জন্য বলো — B-tree ভিত্তিক (যেমন Postgres) নাকি LSM ভিত্তিক (যেমন Cassandra) storage engine বেশি মানায়, আর কেন:
>
> 1. **Smart meter:** ১০ লাখ বিদ্যুৎ মিটার, প্রতিটা প্রতি ১০ সেকেন্ডে একটা reading পাঠায়; মূল read হলো "মিটার X এর গত ২৪ ঘণ্টার reading"; পুরনো reading কখনো বদলায় না, ২ বছর পর মুছে ফেলা হয়
> 2. **ব্যাংকের ledger:** প্রতিটা লেনদেনে দুটো account এর balance একসাথে বদলাতে হয়; auditor যেকোনো সময় যেকোনো ধরনের report চাইতে পারে
> 3. **E-commerce product catalog:** ৫০ লাখ product, দিনে কয়েক হাজার update, কিন্তু সেকেন্ডে হাজার হাজার read — নাম, category, দামের range দিয়ে filter
> 4. **TaskFlow এর activity log** — Lesson 5.1 এর exercise এ তুমি এর estimation করেছ। সেই সংখ্যা নিয়ে আবার ভাবো: storage engine এর দৃষ্টিকোণ থেকে কি তোমার সিদ্ধান্ত বদলায়?
>
> প্রতিটার জন্য লেখো:
>
> - **(ক)** সেকেন্ডে write কত (যেখানে সংখ্যা দেওয়া আছে, হিসাব করো), আর write গুলো append নাকি update
> - **(খ)** মূল read pattern — একটা key, range, নাকি ad-hoc
> - **(গ)** তোমার পছন্দ, আর **কোন amplification** টা তুমি মেনে নিচ্ছ
>
> **বোনাস প্রশ্ন:** Workload ১ এ ২ বছর পুরনো reading মুছতে হবে। LSM এ delete কীভাবে কাজ করে মনে রেখে বলো — প্রতিটা reading আলাদা করে delete করলে কী সমস্যা হতে পারে, আর এর চেয়ে ভালো উপায় কী হতে পারে?

### নিজের চোখে দেখো (optional, Docker লাগবে)

আজকের lesson এর সংখ্যাগুলো তুমি নিজের মেশিনে বের করতে পারো। এটা exercise এর অংশ না — শুধু কৌতূহলের জন্য। (এই machine এ Postgres 17 দিয়ে চালিয়ে দেখা হয়েছে।)

```bash
docker run -d --name pg53 -v pg53_data:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=p postgres:17-alpine
sleep 5
docker exec -it pg53 psql -U postgres
```

`psql` এর ভেতরে:

```sql
SHOW block_size;                                   -- 8192

CREATE EXTENSION pageinspect;
CREATE TABLE tasks (id serial PRIMARY KEY, title text NOT NULL, status text NOT NULL DEFAULT 'todo');
INSERT INTO tasks (title) SELECT 'Task ' || g FROM generate_series(1, 400000) g;

SELECT pg_relation_size('tasks') / 8192 AS table_pages,
       pg_relation_size('tasks_pkey') / 8192 AS index_pages;
SELECT level FROM bt_metap('tasks_pkey');          -- 2 মানে root, মাঝের স্তর, leaf — মোট ৩ স্তর

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM tasks WHERE id = 123456;   -- Buffers: shared hit=4

SELECT ctid FROM tasks WHERE id = 7;               -- (0,7)
UPDATE tasks SET status = 'done' WHERE id = 7;
SELECT ctid FROM tasks WHERE id = 7;               -- নতুন জায়গা — MVCC
```

তারপর crash টা নিজে ঘটাও — `psql` থেকে বেরিয়ে:

```bash
docker exec pg53 psql -U postgres -c \
  "INSERT INTO tasks (title) SELECT 'late ' || g FROM generate_series(1, 50000) g;"
docker kill --signal=KILL pg53        # plug টানা
docker start pg53 && sleep 3
docker logs pg53 2>&1 | grep -E 'not properly|redo'
docker exec pg53 psql -U postgres -c "SELECT count(*) FROM tasks WHERE title LIKE 'late %';"   -- 50000
```

শেষে পরিষ্কার: `docker rm -f pg53 && docker volume rm pg53_data`

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2
Current: 5.3 — Storage Engine Internals
TaskFlow state: Nginx + ৪টা Express instance, CDN, Redis cache, একটা PostgreSQL primary;
normalized schema + openTaskCount counter; একটা অপ্রত্যাশিত VM restart এ
WAL redo দিয়ে কোনো committed data হারায়নি
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.4 — Indexing Deep Dive (EXPLAIN ANALYZE সহ)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষ করে workload ১ এর write সংখ্যাটা, আর বোনাস প্রশ্ন। রেডি হলে `next` লিখো — Lesson 5.4 এ যাব: **Indexing Deep Dive** — আজকের B-tree টা query তে ঠিক কীভাবে কাজে লাগে, composite index এ column এর ক্রম কেন গুরুত্বপূর্ণ, কেন index থাকলেও Postgres কখনো কখনো সেটা ব্যবহার করে না, আর `EXPLAIN ANALYZE` কীভাবে পড়তে হয় — সব TaskFlow এর আসল query দিয়ে, hands-on।
