# Lesson 5.8 — Sharding & Partitioning: Data কে ভাগ করা, আর ভাগের দাম

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 1.3):** প্রতিদিন ২০ লাখ নতুন row, প্রতিটা ~৫০০ byte — এক বছরে মোটামুটি কত storage লাগবে? মাথায় মাথায় হিসাব করো, তারপর ধাপগুলো লেখো।

**Prerequisite:** Lesson 1.6 (Vertical vs Horizontal), Lesson 5.4 (Index), Lesson 5.5 (Transaction), Lesson 5.7 (Replication)

**তুমি এই lesson শেষে পারবে:**

1. Partitioning আর sharding এর পার্থক্য বলতে পারবে, আর Postgres partitioning কখন সত্যিই কাজে আসে (আর কখন আসে না) — মাপা সংখ্যা দিয়ে
2. একটা system এর জন্য shard key বেছে নিতে পারবে, আর hot partition কীভাবে জন্মায় আর কীভাবে এড়াতে হয় বলতে পারবে
3. Sharding এর পরে কী কী ভাঙে — cross-shard query, transaction, unique ID, resharding — বুঝবে, আর "এখনই কি shard করা দরকার?" প্রশ্নের উত্তর সংখ্যা দিয়ে দিতে পারবে

**Tier:** 1 — Runnable Code (Docker এ ৩টা Postgres)

---

## ০. TaskFlow এখন কোথায়

TaskFlow আর ছোট নেই। এক বছরে ২০ লাখ daily active user, আর বেশ কয়েকটা বড় কোম্পানি customer। Lesson 5.7 এ read replica যোগ হয়েছিল — read এর চাপ মিটেছে। কিন্তু Monday সকালের metric এ নতুন দুশ্চিন্তা:

- **Write:** peak এ primary তে সেকেন্ডে ~৩,০০০ write, আর প্রতি quarter এ বাড়ছে। Replica এখানে কোনো সাহায্য করে না — **সব write এখনো একটাই primary তে যায়**।
- **আকার:** সবচেয়ে বড় table `activity_log` — প্রতিদিন কয়েক কোটি event। Disk ভরে আসছে, আর এক বছরের বেশি পুরনো event মুছে ফেলার রাতের job এখন কয়েক ঘণ্টা চলে আর database কে ধীর করে দেয়।
- **সবচেয়ে বড় customer:** একটা enterprise company একাই TaskFlow এর সব task এর ৪০% তৈরি করে।

Lesson 1.6 এ শিখেছিলে: একটা machine কে বড় করার (vertical scaling) একটা সীমা আছে। Replica read ভাগ করে; write আর storage ভাগ করতে হলে **data টাকেই ভাগ করতে হবে**। আজকের lesson সেটা নিয়ে — আর ভাগ করলে কী কী সুবিধা হারায়, সেটা নিয়েও। কারণ sharding হলো system design এর সবচেয়ে দামি সিদ্ধান্তগুলোর একটা, আর একবার করলে ফেরা খুব কঠিন।

---

## ১. Theory

### ১.১ দুটো শব্দ, একটা ধারণা — Partitioning আর Sharding

দুটোরই মূল ধারণা একই: একটা বড় data সেটকে ছোট ছোট টুকরোয় ভাগ করা, যাতে প্রতিটা টুকরো আলাদাভাবে সামলানো যায়।

- **Partitioning** — একটা বড় table কে কয়েকটা ছোট টুকরোয় (partition) ভাগ করা, একটা নিয়ম অনুযায়ী (যেমন মাস)। টুকরোগুলো **একই database server এ** থাকতে পারে। App এর কাছে এটা এখনো একটাই table।
- **Sharding** — data কে টুকরো করে **আলাদা আলাদা database server এ** রাখা। প্রতিটা server (shard) শুধু তার ভাগের data রাখে, আর নিজের ভাগের read আর write সামলায়।

মানে sharding হলো machine জুড়ে partitioning। একটা একই machine এর সীমার ভেতরে থাকে (storage সামলানো সহজ হয়, কিন্তু CPU আর disk একটাই); আরেকটা সীমা ভাঙে (write আর storage সত্যিই কয়েক machine এ ভাগ হয়) — কিন্তু বিশাল দাম দিয়ে।

**আগে জিজ্ঞেস করো — shard কি এখনই লাগবে?** Sharding এর জটিলতা এত বেশি যে এর আগে সাধারণত এগুলো চেষ্টা করা হয়:

1. **Vertical scaling** — বড় machine। আজকের cloud এ একটা database server এ শতাধিক core আর কয়েক TB memory পাওয়া যায়।
2. **Read replica আর cache** (Lesson 5.7, Module 4) — read এর চাপ সরাতে
3. **Query আর index ঠিক করা** (Lesson 5.4, 5.6)
4. **Partitioning** — একই database এর ভেতরে, বড় table এর জন্য (১.২)
5. **Archiving** — পুরনো data অন্য সস্তা জায়গায় (object storage — Lesson 8.1)
6. **একটা বড় table কে আলাদা database এ সরানো** — যেমন `activity_log` কে নিজের একটা database এ। এটাও এক ধরনের ভাগ (functional partitioning), কিন্তু sharding এর চেয়ে অনেক সরল — কোনো একটা table কয়েক জায়গায় ছড়িয়ে যাচ্ছে না।

এই সব করার পরেও যখন write বা storage একটা machine এ আঁটে না — তখন sharding।

### ১.২ Postgres Partitioning — কোথায় লাভ, কোথায় না

TaskFlow এর `activity_log` partitioning এর আদর্শ উদাহরণ: data সময় অনুযায়ী আসে, বেশিরভাগ query সাম্প্রতিক data চায়, আর পুরনো data নিয়মিত মুছতে হয়। Postgres এ (declarative partitioning):

```sql
CREATE TABLE activity (
  id bigserial,
  "projectId" integer NOT NULL,
  action text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  PRIMARY KEY (id, "createdAt")          -- partition key primary key এ থাকতেই হবে
) PARTITION BY RANGE ("createdAt");

CREATE TABLE activity_2026_09 PARTITION OF activity
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
-- প্রতি মাসের জন্য একটা করে
```

App এর কাছে এটা এখনো একটাই `activity` table — `INSERT` করলে Postgres নিজে সঠিক partition এ বসায়। (Sequelize এই DDL বানাতে পারে না — migration এ raw SQL লিখতে হয়।)

**Partition pruning** — query এর শর্ত দেখে planner শুধু দরকারি partition গুলো পড়ে, বাকিগুলো ছুঁয়েও দেখে না।

Exercise এর `npm run partition` — ১২ মাস × ১ লাখ = ১২ লাখ event, একই data একটা সাধারণ table এ আর একটা partitioned table এ:

```
query                                  সাধারণ table     partitioned
project 42, শেষ ৭ দিন                  0.03 ms          0.04 ms — activity_2026_09
project 42, সব সময় (সময়ের শর্ত নেই)  0.22 ms          0.62 ms — 12টা partition
পুরো মাসের সব event (আগস্ট)            22.41 ms         9.14 ms — activity_2026_08
```

এখানে একটা সৎ কথা আছে যেটা অনেক article বলে না: **partitioning index এর বিকল্প না।** প্রথম লাইন — index আছে এমন query তে partition কোনো লাভ দেয়নি। দ্বিতীয় লাইন — query তে partition key (`createdAt`) না থাকলে partitioned table **প্রায় তিনগুণ ধীর**, কারণ ১২টা partition এর ১২টা index ঘুরতে হয়। শুধু তৃতীয় লাইনে — যেখানে একটা পুরো partition পড়তে হয় — লাভ স্পষ্ট।

আসল লাভ অন্য জায়গায় — **পুরনো data মোছা**:

```
সাধারণ table: DELETE (103,334 row)       99 ms   WAL   11.5 MB   table এর আকার 142.2 MB → 142.2 MB
partitioned:  DETACH + DROP partition        8 ms   WAL    0.1 MB   (পুরো file টাই মুছে গেল)
```

`DELETE` প্রতিটা row আলাদা করে "মৃত" চিহ্নিত করে, প্রতিটার জন্য WAL লেখে (Lesson 5.3), আর — লক্ষ করো — table এর আকার **এক byte ও কমেনি**। মৃত row এর জায়গা VACUUM পরে আবার ব্যবহারযোগ্য করে, কিন্তু disk এর জায়গা operating system কে ফেরত দেয় না। অন্যদিকে একটা partition `DROP` করা মানে তার file টাই মুছে ফেলা — প্রায় কোনো WAL নেই, সাথে সাথে disk খালি। TaskFlow এর রাতের কয়েক ঘণ্টার cleanup job এর উত্তর এটাই।

**Partitioning কখন:** time-series data (log, event, metric) যেটা সময় দিয়ে query আর সময় দিয়ে মোছা হয়। **কখন না:** শুধু "table বড়" বলে — index ঠিক থাকলে বড় table ও দ্রুত, আর partition key ছাড়া query গুলো ধীর হয়ে যাবে।

### ১.৩ Sharding — Routing

Sharding এ প্রতিটা shard একটা সম্পূর্ণ আলাদা database। তাই প্রতিটা query এর আগে প্রশ্ন: **এই data কোন shard এ?** যে মান দিয়ে এটা ঠিক হয় সেটাই —

**Shard key** — যে column (বা column গুলোর মান) দেখে ঠিক হয় একটা row কোন shard এ থাকবে। TaskFlow এর জন্য: `workspaceId`।

```
                        ┌─────────────────────────────┐
  Express app ────────► │  routing: shard = f(key)    │
  (workspaceId = 42)    └──────┬──────────┬───────────┘
                               │          │           │
                        ┌──────▼───┐ ┌────▼─────┐ ┌───▼──────┐
                        │ shard0   │ │ shard1   │ │ shard2   │
                        │ ws 3,8,… │ │ ws 1,42,…│ │ ws 5,9,… │
                        └──────────┘ └──────────┘ └──────────┘
                   প্রতিটা নিজেই একটা পূর্ণ Postgres (নিজের replica সহ)
```

`f(key)` তিনভাবে হতে পারে:

- **Hash** — `hash(key) % shard এর সংখ্যা`। ভাগ সমান হয় (যদি hash ভালো হয়), কিন্তু পাশাপাশি key গুলো ছড়িয়ে যায় — range query সব shard এ যায়।
- **Range** — key এর সীমা অনুযায়ী (workspace ১–১০০০ → shard0, …)। Range query সহজ; কিন্তু নতুন key সবসময় শেষ shard এ গেলে সেটা গরম হয় (১.৪)।
- **Directory (lookup table)** — একটা আলাদা table যেখানে লেখা আছে কোন key কোন shard এ। সবচেয়ে নমনীয় — একটা নির্দিষ্ট customer কে ইচ্ছামতো সরানো যায় — কিন্তু সেই table টা নিজেই একটা নির্ভরতা আর প্রতিটা query এর আগে একটা lookup (সাধারণত cache করা)।

Exercise এর routing সবচেয়ে সরল hash:

```typescript
export function hash32(key: string): number {
	return fmix32(fnv1a(key));
}

// সবচেয়ে সরল routing: hash % shard এর সংখ্যা
export function moduloShard(key: string, shardCount: number): number {
	return hash32(key) % shardCount;
}
```

দুটো জিনিস এখানে জরুরি। প্রথমত, hash টা **stable** হতে হবে — একই key সবসময় একই shard, যেকোনো app instance এ, যেকোনো দিন। দ্বিতীয়ত — আর এটা exercise বানাতে গিয়েই ধরা পড়েছে — hash টা **ভালোভাবে মেশানো** হতে হবে। প্রথমে শুধু FNV-1a ব্যবহার করেছিলাম; প্রায়-একই রকম key গুলোতে সেটা এত অসমভাবে ভাগ করছিল যে একটা shard ৪৭% key পাচ্ছিল, আরেকটা ১২%। শেষে একটা mixing ধাপ (`fmix32`, MurmurHash3 থেকে) যোগ করতে হয়েছে। Production এ নিজে hash বানিও না — MurmurHash3, xxHash এর মতো পরীক্ষিত কিছু ব্যবহার করো।

Exercise এর `npm run shard` — ৩০০টা workspace, ৩ লাখ task, ৩টা shard। একটা workspace এর ভেতরের query শুধু তার shard এ যায়:

```
"workspace 42 এ কয়টা খোলা task?"  → শুধু shard0 এ যায়: 201টা, 0.27 ms
```

### ১.৪ Shard Key বাছা — সবচেয়ে গুরুত্বপূর্ণ সিদ্ধান্ত

Shard key পরে বদলানো প্রায় নতুন করে পুরো system বানানোর মতো কঠিন। একটা ভালো shard key:

1. **অনেক আলাদা মান** — শুধু ৫টা মান থাকলে ৫টার বেশি shard কখনো কাজে আসবে না
2. **Data আর load সমানভাবে ভাগ করে** — কোনো একটা মান অস্বাভাবিক বড় না
3. **সবচেয়ে ঘন ঘন চলা query গুলো এক shard এ শেষ হয়** — Lesson 5.1 এর access pattern আবার
4. **যা একসাথে transaction এ বদলায়, তা একসাথে থাকে** — কারণ shard পেরোলে transaction নেই (১.৫)

Exercise এর `npm run keys` একই দিনের ১০ লাখ write চারটা ভিন্ন key দিয়ে ৪টা shard এ ভাগ করে দেখায় (৪০% write একটা বিশাল workspace থেকে):

```
shard key                      প্রতিটা shard এ write এর ভাগ     সবচেয়ে ব্যস্ত   workspace 7 এর data কয়টা shard এ
hash(workspaceId)               14%  16%  15%  55%                   55%        1টা
hash(taskId)                    25%  25%  25%  25%                   25%        4টা
range(createdAt) — ত্রৈমাসিক     0%   0%   0% 100%                  100%        1টা
hash(workspaceId, projectId)    17%  33%  25%  25%                   33%        4টা
```

প্রতিটা লাইন একটা আলাদা শিক্ষা:

- **`hash(workspaceId)`** — workspace এর সব query আর transaction এক shard এ (নিয়ম ৩ আর ৪ ✓)। কিন্তু বড় customer এর shard ৫৫% write খায় (নিয়ম ২ ✗)।
- **`hash(taskId)`** — নিখুঁত সমান ভাগ। কিন্তু একটা workspace এর task গুলো ৪টা shard এই ছড়ানো — "এই workspace এর সব খোলা task" এর মতো প্রতিটা সাধারণ query এখন সব shard এ যায় (নিয়ম ৩ ✗)।
- **`range(createdAt)`** — সবচেয়ে খারাপ: আজকের **সব** write শেষ shard এ; বাকি তিনটা বসে থাকে। Time-based range key এর ক্লাসিক ফাঁদ — auto-increment id দিয়ে range sharding এও ঠিক একই হয়।
- **`hash(workspaceId, projectId)`** — একটা মাঝামাঝি: বড় workspace ৪টা shard এ ছড়াল, project এর ভেতরের query এখনো এক shard এ। কিন্তু লক্ষ করো ভাগটা পুরো সমান হয়নি (৩৩%) — বড় workspace এ মাত্র ২০টা project, ২০টা টুকরো ৪টা shard এ সমানভাবে পড়ে না। Key এর মান যত বেশি, ভাগ তত মসৃণ (নিয়ম ১)।

**নিখুঁত key নেই।** TaskFlow এর জন্য `workspaceId` ভালো শুরু — কারণ প্রায় সব কাজ একটা workspace এর ভেতরে, আর একটা workspace এর data একসাথে থাকলে JOIN আর transaction আগের মতো চলে। SaaS product এ এটাকে বলে **tenant দিয়ে sharding** — সবচেয়ে প্রচলিত pattern। সমস্যা শুধু বড় customer (পরের section)।

### ১.৫ Hot Partition

**Hot partition** — একটা partition বা shard এ অন্যদের তুলনায় অনেক বেশি data বা traffic জমা হওয়া, যাতে সেটাই পুরো system এর bottleneck হয়ে যায়।

Exercise এর `npm run shard` এ `hash(workspaceId)` দিয়ে ৩টা shard:

```
shard0:  94টা workspace   175,986টা task  ███████████████████████  ← workspace 7 (৪০%) এখানে
shard1: 106টা workspace    63,812টা task  █████████
shard2: 100টা workspace    60,200টা task  ████████
```

Workspace এর সংখ্যা প্রায় সমান (৯৪, ১০৬, ১০০) — hash তার কাজ ঠিকই করেছে। কিন্তু **data** সমান না, কারণ একটা workspace বাকি ২৯৯টার মিলিত প্রায় সমান। Hash **key** গুলো সমানভাবে ভাগ করে; প্রতিটা key এর **ওজন** সে জানে না। Lesson 4.6 এর hot key মনে আছে? একই সমস্যা, database এ।

প্রতিকার:

- **বড় tenant কে আলাদা করা** — directory routing দিয়ে বড় customer কে নিজের একটা shard এ (বা তার জন্য বেশি শক্তিশালী machine), বাকিরা hash এ। বাস্তবে সবচেয়ে প্রচলিত।
- **Key কে আরও সূক্ষ্ম করা** — `hash(workspaceId, projectId)` (১.৪) — দাম: workspace-জুড়ে query এখন কয়েক shard এ।
- **Salting** — একটা গরম key এর সাথে একটা ছোট random সংখ্যা জুড়ে দেওয়া (`key#0` … `key#9`), যাতে সেটা ১০টা জায়গায় ছড়ায়; পড়ার সময় ১০টা থেকেই পড়ে মেলাতে হয়। Twitter এর মতো system এ "celebrity" account এর জন্য এই ধরনের কৌশল।

### ১.৬ Shard পেরোলে কী কী ভাঙে

Sharding এর আসল দাম এখানে। Lesson 5.1 এ relational database এর দুটো বড় শক্তি ছিল: যেকোনো query (JOIN সহ), আর multi-row transaction। **দুটোই shard এর সীমায় এসে থেমে যায়।**

**১. Shard key ছাড়া query — scatter-gather।** "সবচেয়ে বেশি খোলা task কোন ১০টা workspace এ?" — এর উত্তর তিনটা shard এই ছড়ানো।

**Scatter-gather** — একটা query সব shard এ একসাথে পাঠানো (scatter), আর ফলাফলগুলো app এ মিলিয়ে সাজানো (gather)।

```
→ 3টা shard এ একসাথে (scatter), app এ মিলিয়ে সাজানো (gather): মোট 11.0 ms
  shard0: 11.0 ms, shard1: 4.8 ms, shard2: 4.6 ms — মোট সময় সবচেয়ে ধীরটার সমান
```

মোট সময় সবচেয়ে ধীর shard এর সমান — আর সবচেয়ে ধীর টা হলো সেই hot shard0। Shard যত বেশি, কোনো একটা ধীর হওয়ার সম্ভাবনা তত বেশি (Lesson 1.5 এর tail latency এর কথা মনে করো)। আর প্রতিটা এমন query সব shard কে কাজ করায় — ১০টা shard মানে ১০ গুণ database এর কাজ। তাই "সব workspace জুড়ে" ধরনের report সাধারণত sharded database এ চালানো হয় না — data একটা আলাদা analytics store এ পাঠানো হয় (Lesson 7.6 এর OLAP)।

**২. Shard পেরোনো JOIN** — database করতে পারে না; app কে প্রতিটা shard থেকে এনে নিজে জোড়া লাগাতে হয় (Lesson 5.6 এর batching, এবার কয়েক database জুড়ে)।

**৩. Shard পেরোনো transaction।** একটা project কে এক workspace থেকে আরেকটায় সরানো, যখন দুটো আলাদা shard এ। Exercise এর ধাপ ৪:

```
project 8: workspace 8 (shard0) → workspace 5 (shard2)
ধাপ ১: shard2 তে project লেখা হলো — COMMIT ✓
ধাপ ২: shard0 থেকে মুছে ফেলার আগেই app crash করল ✗
→ project 8 এখন shard0 এ 1টা, shard2 এ 1টা — দুই জায়গাতেই! কোনো একক transaction এটা আটকাতে পারেনি
```

দুটো আলাদা database, দুটো আলাদা COMMIT — Lesson 5.5 এর atomicity এখানে নেই। এর সমাধান (Saga pattern, two-phase commit) Lesson 9.3 এর পুরো বিষয়। আপাতত নিয়মটা: **shard key এমনভাবে বাছো যাতে এমন কাজ বিরল হয়।**

**৪. Unique ID।** প্রতিটা shard এর নিজের `serial`/auto-increment থাকলে দুটো shard এ একই id তৈরি হবে — "task 1001" দুটো আলাদা task। তাই sharded system এ id সাধারণত database এর বাইরে তৈরি হয় — UUID, অথবা সময় + machine + ক্রম মিলিয়ে বানানো id (Twitter এর Snowflake এই ধারণার বিখ্যাত উদাহরণ), যেটা shard জুড়ে unique আর মোটামুটি সময়ের ক্রমে সাজানো।

**৫. Unique constraint** — "প্রতিটা email একবারই" — email যদি shard key না হয়, তাহলে একটা shard জানে না অন্য shard এ একই email আছে কিনা। একটা আলাদা, email দিয়ে sharded lookup table লাগে।

**৬. Operations** — ১০টা shard মানে ১০টা database এ migration, ১০টা backup, ১০টা monitoring, আর প্রতিটার নিজের replica (Lesson 5.7)।

### ১.৭ Resharding — Shard বাড়ানো

TaskFlow ৩টা shard দিয়ে শুরু করল; এক বছর পরে ৪টা লাগবে। `hash % N` এ N বদলালে কী হয়? Exercise এর `npm run keys`:

```
Shard ৩ থেকে ৪ করা — 100,000টা workspace এর কতগুলো অন্য shard এ সরাতে হবে?
hash % N               74.9%   (74,874টা)
consistent hashing     26.3%   (26,274টা)
আদর্শ (শুধু নতুন shard এর ভাগটুকু = ১/৪)    25.0%
```

**Resharding** — shard এর সংখ্যা বা তাদের মধ্যে data এর ভাগ বদলানো, আর সেই অনুযায়ী data এক shard থেকে আরেকটায় সরানো।

`hash % N` এ একটা shard যোগ করলে প্রায় **তিন-চতুর্থাংশ** data কে জায়গা বদলাতে হয় — কারণ প্রায় প্রতিটা key এর ভাগশেষ বদলে যায়। আদর্শভাবে শুধু নতুন shard এর ভাগটুকু (২৫%) সরা উচিত। **Consistent hashing** ঠিক এটাই করে — key আর shard দুটোকেই একটা বৃত্তের উপর বসিয়ে, যাতে নতুন shard শুধু তার পাশের অংশটুকু নেয়। এটা কীভাবে কাজ করে, virtual node কেন লাগে — সেটা Lesson 10.1 এর পুরো deep dive; আজকের জন্য শুধু সংখ্যাটা মনে রাখো: ৭৫% বনাম ~২৫%।

আর একটা বিকল্প যেটা বাস্তবে খুব প্রচলিত: **শুরু থেকেই অনেক বেশি logical shard** (যেমন ১০২৪টা), যেগুলো অল্প কয়েকটা physical server এ রাখা। Machine বাড়ালে কয়েকটা logical shard পুরোটা নতুন machine এ সরে যায় — কোনো key এর shard বদলায় না।

Data সরানোর কাজটা নিজেও কঠিন — চালু system এ, কোনো downtime ছাড়া: নতুন জায়গায় কপি করা, সরানোর সময় দুই জায়গাতেই লেখা, মিলিয়ে দেখা, তারপর read সরানো। এই কারণেই অনেক team নিজে sharding বানায় না — Postgres এর জন্য Citus, MySQL এর জন্য Vitess এর মতো tool, অথবা শুরু থেকেই distributed database (Lesson 5.1 এর CockroachDB, YugabyteDB, DynamoDB) — যারা ভাগ আর সরানো নিজেরাই সামলায়। তবে shard key বাছার দায়িত্ব তখনো তোমার।

> **Trade-off Table — Routing এর ধরন**

| ধরন                | ভাগ কেমন                 | Range query        | Shard যোগ করা              | বিশেষ ফাঁদ                                |
| ------------------ | ------------------------ | ------------------ | -------------------------- | ----------------------------------------- |
| Hash % N           | সমান (ভালো hash হলে)     | সব shard এ         | ~(N−1)/N data সরে          | Key এর ওজন জানে না — বড় tenant গরম       |
| Consistent hashing | সমান (virtual node সহ)   | সব shard এ         | শুধু নতুন shard এর ভাগ সরে | বোঝা আর ঠিকমতো বানানো জটিল (10.1)         |
| Range              | Data এর ধরনের উপর নির্ভর | এক বা অল্প shard এ | একটা range ভাগ করা         | নতুন data শেষ shard এ — hot               |
| Directory          | যেমন ঠিক করো             | নির্ভর করে         | Lookup বদলাও, data সরাও    | Lookup table নিজেই নির্ভরতা আর bottleneck |

---

## ২. Interview Angle

**"এই system টা কীভাবে scale করবে?"** — sharding প্রায়ই আসে, কিন্তু দুর্বল উত্তর হলো সাথে সাথে "database shard করব"। ভালো উত্তর আগে সংখ্যা দেয় (Lesson 1.3): "peak এ কত write/s, কত TB data — একটা machine এ আঁটে কি?" প্রায়ই উত্তর "হ্যাঁ, অনেক দিন পর্যন্ত", আর এটা বলতে পারাটাই senior লক্ষণ।

**Shard করতেই হলে, interviewer এর follow-up গুলো প্রায় নিশ্চিত:**

- _"Shard key কী হবে, কেন?"_ — access pattern দিয়ে যুক্তি: "chat app এ `conversationId`, কারণ সব message পড়া আর লেখা একটা conversation এর ভেতরে"
- _"একজন celebrity / একটা বড় customer এর কী হবে?"_ — hot partition, আর প্রতিকার (আলাদা shard, salting)
- _"আরও shard লাগলে?"_ — `hash % N` এর সমস্যা, consistent hashing বা অনেক logical shard
- _"সব user জুড়ে একটা report চাই?"_ — scatter-gather এর দাম, আর analytics এর জন্য আলাদা store
- _"দুই shard জুড়ে transaction?"_ — এড়াও (key দিয়ে), না পারলে Saga (Lesson 9.3)
- _"ID কীভাবে বানাবে?"_ — UUID বা Snowflake-ধরনের id; auto-increment না

**Production এ বাস্তবে:** বড় বড় কোম্পানির engineering blog এ sharding migration এর গল্প প্রায়ই মাসের পর মাসের project হিসেবে লেখা হয় — এটা একটা দামি, ঝুঁকিপূর্ণ কাজ। তাই সিদ্ধান্তটা যত দেরিতে সম্ভব নেওয়া হয়, আর নেওয়া হলে shard key নিয়ে সবচেয়ে বেশি সময় দেওয়া হয়।

---

## ৩. Key Takeaway

- **Partitioning** = একটা table কে টুকরো করা (একই server এ হতে পারে); **sharding** = টুকরো গুলো আলাদা server এ — write আর storage সত্যিই ভাগ হয়
- Shard করার আগে: বড় machine, replica, cache, query/index, partitioning, archiving, বড় table কে আলাদা database এ
- Postgres partitioning **index এর বিকল্প না** — partition key ছাড়া query ধীর হয় (০.২২ → ০.৬২ ms); আসল লাভ time-series এ পুরনো data মোছা (DELETE: ৯৯ ms, ১১.৫ MB WAL, আকার অপরিবর্তিত; DROP: ৮ ms)
- **Shard key**: অনেক আলাদা মান, সমান ভাগ, ঘন ঘন query এক shard এ, একসাথে বদলানো data একসাথে; time/auto-increment দিয়ে range → শেষ shard ১০০% গরম
- **Hot partition** — hash key সমান ভাগ করে, key এর ওজন না; বড় tenant কে আলাদা করা বা key সূক্ষ্ম করা
- Shard পেরোলে হারায়: shard key ছাড়া query (**scatter-gather**, সবচেয়ে ধীর shard এর সমান সময়), JOIN, **transaction**, auto-increment id, unique constraint
- **Resharding**: `hash % N` এ ৩→৪ তে ~৭৫% data সরে, consistent hashing এ ~২৫%; আর hash function নিজেই ভালো মেশানো হতে হবে

---

## ৪. নতুন Term (Glossary)

| Term                  | অর্থ                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| **Partitioning**      | একটা বড় table কে একটা নিয়ম অনুযায়ী (যেমন মাস) ছোট টুকরোয় ভাগ করা — একই server এ থাকতে পারে       |
| **Sharding**          | Data কে টুকরো করে আলাদা আলাদা database server এ রাখা — প্রতিটা server নিজের ভাগের read/write সামলায় |
| **Shard Key**         | যে column এর মান দেখে ঠিক হয় একটা row কোন shard এ থাকবে                                             |
| **Partition Pruning** | Query এর শর্ত দেখে planner শুধু দরকারি partition গুলো পড়ে, বাকিগুলো বাদ দেয়                        |
| **Hot Partition**     | একটা partition বা shard এ অন্যদের চেয়ে অনেক বেশি data বা traffic — পুরো system এর bottleneck        |
| **Scatter-Gather**    | একটা query সব shard এ একসাথে পাঠিয়ে (scatter) ফলাফল app এ মিলিয়ে সাজানো (gather)                   |
| **Resharding**        | Shard এর সংখ্যা বা ভাগ বদলানো, আর সেই অনুযায়ী data এক shard থেকে আরেকটায় সরানো                     |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. একটা chat app (WhatsApp ধরনের) এর message table shard করতে হবে। দুটো প্রস্তাব: `userId` (যে পাঠিয়েছে) অথবা `conversationId`। প্রতিটায় "একটা conversation এর সর্বশেষ ৫০টা message দেখাও" query কেমন চলবে? কোনটা বাছবে, আর একটা ১০ লাখ member এর group এর কী হবে?
2. TaskFlow ৪টা shard এ, প্রতিটার নিজের Postgres `serial` id। একজন developer বলল, "id এর সংঘাত এড়াতে shard0 odd id, shard1 even id দিক — সহজ সমাধান।" এতে সমস্যা কী? তুমি কী প্রস্তাব করবে?
3. TaskFlow এর CTO বললেন: "আমরা এখন ৩০০ write/s এ, database ২০০ GB। Scale এর জন্য প্রস্তুত থাকতে এখনই ১৬টা shard এ ভাগ করে ফেলি।" তুমি কী বলবে? সংখ্যা দিয়ে যুক্তি দাও, আর বলো কোন অবস্থায় তুমি sharding এর পরিকল্পনা শুরু করতে বলবে।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** `userId` দিয়ে: একটা conversation এর message বিভিন্ন sender এর — তারা বিভিন্ন shard এ। "সর্বশেষ ৫০টা" এখন scatter-gather, আর সময় অনুযায়ী মেলাতে হবে — সবচেয়ে ঘন ঘন চলা query টাই সবচেয়ে দামি। `conversationId` দিয়ে: একটা conversation এর সব message এক shard এ, sorted — query এক shard, এক index scan। তাই `conversationId` — নিয়ম ৩ (ঘন ঘন query এক shard এ)। (বাড়তি: message এর ভেতরে `(conversationId, createdAt)` এর উপর index বা partition — Lesson 5.4, আর এটা ঠিক সেই access pattern যেটার জন্য Discord wide-column database বেছেছিল, Lesson 5.1।) বিশাল group: একটা conversation এ যদি অস্বাভাবিক বেশি message আসে, সেই shard গরম — hot partition। প্রতিকার: সেই conversation এর message কে সময়ের bucket দিয়ে আরও ভাগ করা — key হয় `(conversationId, সপ্তাহ)` — যাতে একটা conversation এর বিভিন্ন সময়ের message বিভিন্ন জায়গায় যায়, অথচ "সর্বশেষ ৫০টা" এখনো সাধারণত একটা bucket এ।

**প্রশ্ন ২:** Odd/even শুধু ২টা shard এর জন্য কাজ করে। ৪টা shard এ? `id % 4` দিয়ে offset — সম্ভব, কিন্তু shard সংখ্যা বদলালে (১.৭) পুরো নিয়ম ভেঙে যায়, আর পুরনো id গুলোর অর্থ বদলে যায়। আর id দেখে shard বোঝা গেলেও, id এর সাথে shard key (workspace) এর কোনো সম্পর্ক নেই — বিভ্রান্তিকর। ভালো সমাধান: database এর বাইরে id তৈরি — UUID (সরল, কোনো সমন্বয় লাগে না; দাম: বড়, আর random UUID B-tree index এ এলোমেলো জায়গায় বসে — Lesson 5.3 — তাই সময়-ক্রমের UUIDv7 ভালো), অথবা Snowflake-ধরনের ৬৪-bit id (সময় + machine id + ক্রম — ছোট, মোটামুটি সময়ের ক্রমে)।

**প্রশ্ন ৩:** সংখ্যা: ৩০০ write/s আর ২০০ GB — একটা সাধারণ Postgres server এর জন্য আরামদায়ক এলাকা (Lesson 5.1 এর estimation এর মতো)। এখন ১৬টা shard মানে: প্রতিটা feature এ shard key এর কথা ভাবা, কোনো cross-workspace report এ scatter-gather, cross-shard transaction নিষেধ, ১৬টা database এর migration, backup, monitoring — আর সবচেয়ে বড় কথা, আজকের অনুমানে বাছা shard key হয়তো দুই বছর পরের access pattern এর সাথে মিলবে না, আর তখন বদলানো আরও কঠিন। কী বলবে: এখন সরল রাখো, কিন্তু **প্রস্তুত** থাকো — সব table এ `workspaceId` রাখো, workspace পেরোনো JOIN আর transaction এড়াও, id database এর বাইরে বানাও (যাতে পরে shard করা সহজ হয়)। পরিকল্পনা শুরু করার সংকেত: write এর হার বড় machine এর মাপা সীমার একটা বড় অংশে পৌঁছানো (ধরো ৫০–৬০%, আর বৃদ্ধির হার দিয়ে হিসাব করে সীমা কবে ছোঁবে), storage এর বৃদ্ধি একটা machine এর disk ছাড়ানোর পথে, অথবা একটা নির্দিষ্ট table (activity log) বাকি সবার চেয়ে অনেক দ্রুত বাড়ছে — তখন প্রথমে সেটাকে আলাদা করো।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (Docker এ ৩টা Postgres)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.8-sharding/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.8-sharding) — `docker compose up -d --wait && npm install`, তারপর `npm run partition`, `npm run shard`, `npm run keys`। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

তিনটা আলাদা Postgres, প্রতিটা একটা shard। `partition` একটা database এর ভেতরে মাস অনুযায়ী partitioning মাপে; `shard` `workspaceId` দিয়ে আসল routing, scatter-gather আর shard পেরোনো কাজ দেখায়; `keys` database ছাড়া (deterministic) shard key আর resharding এর হিসাব করে। Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `partition` দুবার, `shard` আর `keys` তিনবার — shard এর ভাগ আর `keys` এর সংখ্যা প্রতিবার হুবহু এক।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. তিনটা script চালাও। `partition` এ তোমার মেশিনে কোন query তে partitioned table **ধীর** হলো, আর কেন? এক লাইনে লেখো partitioning কখন ব্যবহার করবে।

2. **বড় customer কে আলাদা করো** (README experiment ২): workspace 7 কে shard0 তে, বাকিদের shard1 আর shard2 তে। Task এর ভাগ কেমন হলো? এই routing বজায় রাখতে কী কী নতুন দায়িত্ব যোগ হলো?

3. **Composite key এর সূক্ষ্মতা** (experiment ৩): project সংখ্যা ২০ থেকে ২০০। "সবচেয়ে ব্যস্ত" কলাম কী হলো? Shard key এর "অনেক আলাদা মান" নিয়মটা এর সাথে মিলিয়ে ব্যাখ্যা করো।

4. **Virtual node কমাও** (experiment ৪): ২০০ থেকে ১। কত % সরল, আর প্রতিটা shard এর ভাগ কেমন? Lesson 10.1 এর জন্য একটা প্রশ্ন লিখে রাখো যেটা তুমি জানতে চাও।

5. **Design অংশ:** TaskFlow এর তিনটা বড় table — `tasks`, `activity_log`, `notifications` (প্রতিটা user এর জন্য, ৩০ দিন রাখা হয়)। প্রতিটার জন্য বলো: partition, shard, দুটোই, নাকি কিছুই না — আর partition বা shard key কী, কারণ সহ। Workspace পেরোনো কোন কোন feature তোমার সিদ্ধান্তে কঠিন হয়ে যাবে, আর সেগুলো কীভাবে সামলাবে?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
Current: 5.8 — Sharding & Partitioning
TaskFlow state: Nginx + Express instance গুলো, CDN, Redis cache; PostgreSQL primary + read
replica; activity_log মাস অনুযায়ী partitioned (পুরনো মাস DROP); sharding এর প্রস্তুতি —
shard key workspaceId, বড় enterprise customer আলাদা করার পরিকল্পনা, id database এর বাইরে
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion, Leader-Follower Replication,
Replication Lag, Read-Your-Writes Consistency, Synchronous Replication,
Failover, RPO/RTO, Multi-Leader Replication, Partitioning, Sharding,
Shard Key, Partition Pruning, Hot Partition, Scatter-Gather, Resharding
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.9 — CAP Theorem, ACID vs BASE, Quorum (R+W>N)
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ৫ নম্বরের তিনটা table এর সিদ্ধান্ত। রেডি হলে `next` লিখো — Lesson 5.9 এ যাব, Module 5 এর শেষ lesson: **CAP Theorem, ACID vs BASE, আর Quorum** — replica আর shard মিলে এখন TaskFlow এর data কয়েকটা machine এ। Network ভাঙলে (আর ভাঙবেই) system কে একটা বেছে নিতে হয়: সবাইকে সঠিক উত্তর দেবে, নাকি সবাইকে উত্তর দেবে? CAP আসলে কী বলে (আর কী বলে না — এটা নিয়ে ভুল ধারণা প্রচুর), leaderless database এ `R + W > N` কীভাবে consistency আনে, আর TaskFlow এর কোন অংশ কোন দিকে যাবে।
