# Lesson 5.7 — Replication: Primary-Replica, Read Scaling আর Failover

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 3.4):** Load balancer এ health check আর failover কীভাবে একসাথে কাজ করে? একটা backend server হঠাৎ মারা গেলে, load balancer সেটা বুঝতে আর traffic সরাতে কতক্ষণ লাগতে পারে — কীসের উপর নির্ভর করে?

**Prerequisite:** Lesson 1.6 (SPOF), Lesson 5.3 (WAL), Lesson 5.5 (Transaction), Lesson 5.6 (Pool)

**তুমি এই lesson শেষে পারবে:**

1. Postgres এর primary থেকে replica তে data কীভাবে যায় (WAL streaming) বলতে পারবে, আর Sequelize এ read replica দিয়ে read scale করতে পারবে
2. Replication lag থেকে জন্মানো "read-your-writes" bug চিনবে, আর তিনটা সমাধানের কোনটার দাম কোথায় পড়ে — মেপে জানবে
3. Async আর sync replication এর trade-off, failover এর ধাপ, আর failover এ কোন data হারাতে পারে (RPO) — ব্যাখ্যা করতে পারবে; multi-leader কেন আর কখন, সেটাও

**Tier:** 2 — Infra Setup (Docker এ primary + replica, সাথে TypeScript script)

---

## ০. TaskFlow এখন কোথায়

Module 5 এ TaskFlow এর database কে আমরা অনেক ভালো করেছি — schema, index, transaction, pool। কিন্তু এখনো একটাই PostgreSQL server। দুটো সমস্যা মাথা তুলছে:

1. **Read এর চাপ।** Metric বলছে TaskFlow এর database query এর প্রায় ৯০% হলো read — dashboard, task list, search। Primary এর CPU peak এ ৮০%। Cache (Module 4) সাহায্য করেছে, কিন্তু সব read cache করা যায় না।
2. **Lesson 1.6 এর SPOF।** App server ৮টা, load balancer আছে — কিন্তু database একটা। গত মাসে সেই server এর disk নষ্ট হয়েছিল। Backup থেকে restore করতে ৪০ মিনিট লেগেছিল, আর শেষ backup এর পরের ৬ ঘণ্টার data হারিয়ে গিয়েছিল।

সমাধান মনে হয় সরল: database এর একটা **কপি** রাখো। Read গুলো কপি থেকে পড়ো, আর মূলটা মরলে কপিটাকে মূল বানিয়ে দাও।

Team সেটা করল — একটা read replica যোগ হলো, আর Sequelize কে বলা হলো read গুলো সেখানে পাঠাতে। Primary এর CPU নেমে গেল। সবাই খুশি। তারপর প্রথম support ticket:

> "নতুন task তৈরি করলাম, 'Saved!' দেখাল — কিন্তু list এ task টা নেই। Page refresh করলে আসে।"

আজকের lesson এই কপি রাখার বিজ্ঞান — আর কপি থাকলেই যে নতুন ধরনের সমস্যা জন্মায়, সেগুলো। Exercise এ এসব Docker এ আসল Postgres primary + replica চালিয়ে মাপা।

---

## ১. Theory

### ১.১ Replication কেন — তিনটা কারণ, আর একটা ভুল ধারণা

**Replication** — একই data একাধিক database server এ রাখা, আর সেগুলোকে সবসময় মিলিয়ে রাখা। কারণ তিনটা:

1. **Read scaling** — read গুলো কয়েকটা কপিতে ভাগ করা (TaskFlow এর সমস্যা ১)
2. **High availability** — মূলটা মরলে কপিটা দায়িত্ব নেয় (সমস্যা ২)
3. **Latency** — user এর কাছাকাছি একটা কপি রাখা (অন্য region এ — Lesson 10.8)

**ভুল ধারণা: "Replica আছে, তাই backup লাগবে না।"** একজন developer ভুল করে `DELETE FROM tasks` চালালে replica সেটা **বিশ্বস্তভাবে কপি করে** — কয়েক millisecond এর মধ্যে replica থেকেও সব task উধাও। Replication hardware নষ্ট হওয়া থেকে বাঁচায়, মানুষের ভুল থেকে না। Backup (আর নির্দিষ্ট মুহূর্তে ফিরে যাওয়ার ক্ষমতা — point-in-time recovery) আলাদা জিনিস, আর দুটোই লাগে।

### ১.২ Leader-Follower — Postgres কীভাবে কপি করে

সবচেয়ে প্রচলিত ধরন:

**Leader-follower replication** — একটা server (leader, বা primary) সব write নেয়; বাকিরা (follower, বা replica) শুধু leader এর পরিবর্তন কপি করে, আর শুধু read নেয়। (পুরনো বই আর curriculum এ এর নাম "master-slave"; এখন সাধারণত primary-replica বা leader-follower বলা হয়।)

Postgres এটা কীভাবে করে? Lesson 5.3 এর **WAL** মনে করো — প্রতিটা পরিবর্তন data file এ যাওয়ার আগে WAL এ লেখা হয়। Replica ঠিক সেই WAL এর stream টা নেয়, আর নিজের কাছে replay করে — যেমন crash এর পরে primary নিজে করে:

```
              write (INSERT/UPDATE)                    read (SELECT)
                     │                                       │
                     ▼                                       ▼
            ┌─────────────────┐   WAL stream    ┌──────────────────────┐
            │     PRIMARY     │ ──────────────► │       REPLICA        │
            │  read + write   │  (প্রতিটা বদল,  │  শুধু read           │
            │                 │   প্রায় সাথে    │  WAL পায় → replay করে │
            │  WAL ─► data    │   সাথে)          │  WAL ─► data          │
            └─────────────────┘                 └──────────────────────┘
```

Replica থেকে লেখার চেষ্টা করলে Postgres error দেয় — সে read-only (exercise এর experiment ২)। Exercise এর `docker-compose.yml` এ replica প্রথম চালুতে `pg_basebackup -R` দিয়ে primary এর পুরো কপি নেয়, তারপর streaming শুরু করে:

```
 application_name |   state   | sync_state
------------------+-----------+------------
 walreceiver      | streaming | sync
```

**Sequelize এ read replica** — এটা built-in। Exercise এর connection:

```typescript
export const app = new Sequelize({
	dialect: 'postgres',
	logging: false,
	replication: {
		read: [{ host: HOST, port: REPLICA_PORT, ...credentials }],
		write: { host: HOST, port: PRIMARY_PORT, ...credentials }
	},
	pool: { max: 10, min: 0, idle: 10_000 }
});
```

Sequelize এখন নিজে থেকে: transaction এর **বাইরের** সব `SELECT` → replica (`read` এ একাধিক থাকলে পালা করে); বাকি সব (`INSERT`, `UPDATE`, transaction এর ভেতরের সব) → primary। Code এ কিছুই বদলাতে হয় না — আর ঠিক এই কারণেই পরের section এর bug টা এত সহজে ঢুকে পড়ে।

### ১.৩ Replication Lag — কপি সবসময় একটু পিছিয়ে

Primary তে commit হওয়া আর replica তে সেটা দেখা যাওয়ার মধ্যে একটা ফাঁক থাকে — WAL পাঠানো, পৌঁছানো, replay করা। **Replication lag** — primary তে একটা পরিবর্তন commit হওয়া থেকে replica তে সেটা দেখা যাওয়া পর্যন্ত সময়।

Postgres এর default replication **asynchronous** — primary commit করে সাথে সাথে client কে "সফল" বলে দেয়, replica এর জন্য অপেক্ষা করে না। Replica পরে ধরে ফেলে।

এবার TaskFlow এর bug। Exercise এর `npm run lag` ঠিক TaskFlow এর code এর মতো করে: `Task.create(...)` (primary এ যায়), তারপর সাথে সাথে `Task.findByPk(id)` (Sequelize replica তে পাঠায়):

```
অবস্থা                              খুঁজে পায়নি   replica তে দেখা যেতে কত সময় লাগল
স্বাভাবিক (একই মেশিন, load নেই)     199/200   p50    1.8 ms   p99    2.3 ms
replica ২০০ ms পিছিয়ে (নকল lag)     50/50   p50  200.1 ms   p99  200.9 ms
```

প্রথম লাইনটা এই lesson এর সবচেয়ে গুরুত্বপূর্ণ সংখ্যা। Primary আর replica **একই মেশিনে**, কোনো load নেই, lag মাত্র **~২ ms** — তবু ২০০ বারের মধ্যে ১৯৯ বার নিজের সদ্য তৈরি task খুঁজে পাওয়া যায়নি। কারণ পরের read টা ২ ms এর চেয়েও দ্রুত আসে। প্রশ্নটা কখনো "lag কত ছোট" না — প্রশ্নটা **"lag শূন্য কিনা"**, আর async replication এ সেটা কখনো শূন্য না।

বাস্তবে lag আরও বড় হয়: replica ভারী read এ ব্যস্ত, বড় একটা migration এর WAL এর ঢেউ, network এর সমস্যা। তখন lag সেকেন্ড, এমনকি মিনিটে পৌঁছাতে পারে। দ্বিতীয় লাইনে exercise সেটা নকল করেছে — replica কে ইচ্ছা করে ২০০ ms পিছিয়ে রেখে (`recovery_min_apply_delay`, Postgres এর আসল একটা setting)।

### ১.৪ Read-your-writes — তিনটা সমাধান, তিন জায়গায় দাম

**Read-your-writes consistency** — একজন user নিজে যা লিখেছে, পরের পড়ায় সেটা সে অবশ্যই দেখবে (অন্যদের লেখা একটু দেরিতে দেখলে চলে)। TaskFlow এর bug ঠিক এটাই ভেঙেছে।

Exercise এর `npm run ryw` — replica ২০০ ms পিছিয়ে, প্রতিটা কৌশলে ৩০ বার "লেখো → সাথে সাথে পড়ো":

```
কৌশল                                       পাওয়া গেছে   লেখা (median)   পড়া (median)
ক. কিছু না (replica থেকে পড়া)                0/30        2.1 ms        0.4 ms
খ. useMaster: true (primary থেকে)            30/30        2.1 ms        0.4 ms
গ. LSN token — replica ধরা পর্যন্ত অপেক্ষা   30/30        1.8 ms      200.7 ms
ঘ. synchronous_commit = remote_apply         30/30      202.2 ms        0.7 ms
```

তিনটা সমাধানই সঠিক (৩০/৩০)। কিন্তু সংখ্যাগুলো দেখো — প্রতিটা **দামটা ভিন্ন জায়গায় সরায়**:

**খ. নিজের লেখার পরের পড়া primary থেকে।** Sequelize এ `Task.findByPk(id, { useMaster: true })`। সবচেয়ে সরল, কোনো অপেক্ষা নেই। দাম: ওই read গুলো আবার primary এর উপর — যে চাপ কমাতেই replica আনা হয়েছিল। বাস্তবে এর একটা পরিশীলিত রূপ: "যে user গত ১০ সেকেন্ডে কিছু লিখেছে, তার সব read primary থেকে" (session এ শেষ লেখার সময় রেখে)। বেশিরভাগ user বেশিরভাগ সময় শুধু পড়ে, তাই primary তে বাড়তি চাপ সামান্য।

**গ. LSN token।** Lesson 5.3 এ দেখেছিলে WAL এর প্রতিটা অবস্থানের একটা ঠিকানা আছে — LSN। লেখার পর primary এর বর্তমান LSN মনে রাখো; পড়ার আগে replica ততদূর পৌঁছেছে কিনা দেখো (`pg_last_wal_replay_lsn()`), না পৌঁছালে অপেক্ষা করো। Read replica তেই থাকে, আর সঠিক। দাম: **পড়া** ধীর — replica যতটা পিছিয়ে, ততটা অপেক্ষা (এখানে ~২০০ ms)। Production এ এই LSN টা client কে একটা token হিসেবে দেওয়া যায় (cookie বা header), যাতে তার পরের request ও এটা মানে — অন্য app instance এ গেলেও।

**ঘ. Synchronous replication।** Commit নিজেই অপেক্ষা করে যতক্ষণ না replica পরিবর্তনটা প্রয়োগ করে। তখন commit শেষ মানে replica তেও আছে। Exercise এর code:

```typescript
app.transaction(async (transaction) => {
	await app.query('SET LOCAL synchronous_commit = remote_apply', { transaction });
	return Task.create({ title: 'remote-apply' }, { transaction });
});
```

দাম: **লেখা** ধীর — replica যতটা ধীর, প্রতিটা write ততটা ধীর (এখানে ২ ms → ২০২ ms)। `SET LOCAL` থাকায় এটা শুধু এই transaction এর জন্য — বাকি সব write আগের মতো async।

**কোনটা কখন?** বেশিরভাগ web app এর জন্য (খ) — "সদ্য লিখেছে এমন user primary থেকে পড়ুক" — সবচেয়ে ব্যবহারিক। (গ) যখন read এর চাপ সত্যিই primary তে নেওয়া যাবে না। (ঘ) শুধু সেই অল্প কয়েকটা write এর জন্য যেখানে পরের read কে অবশ্যই এটা দেখতে হবে, আর write এর latency মেনে নেওয়া যায়।

আর একটা সমস্যা আছে যেটা এখানে শুধু নাম নিয়ে রাখছি: replica একাধিক হলে, একজন user এর পরপর দুটো read দুটো ভিন্ন replica তে যেতে পারে — একটা বেশি পিছিয়ে। তখন user একটা task দেখল, refresh করল, task টা **উধাও** — সময় যেন উল্টো দিকে গেল। এর সমাধান (monotonic read) Lesson 6.3 এ।

### ১.৫ Synchronous Replication — দাম শুধু গতি না

**Synchronous replication** — primary একটা commit কে সফল বলার আগে অন্তত একটা replica কে পরিবর্তনটা নিশ্চিত করতে দেয়। (উল্টোটা, যেটা default, **asynchronous** — primary অপেক্ষা করে না।)

শুনে মনে হয় সব সমস্যার সমাধান — প্রতিটা commit দুই জায়গায়, lag এর bug নেই, failover এ কিছু হারায় না। কিন্তু দুটো দাম আছে, আর দ্বিতীয়টা অনেকেই জানে না।

**দাম ১ — প্রতিটা write সবচেয়ে ধীর sync replica এর সমান ধীর।** ১.৪ এর (ঘ) তে দেখেছ: ২ ms → ২০২ ms। Replica অন্য data center এ হলে প্রতিটা write এ network round trip যোগ হয়।

**দাম ২ — replica না থাকলে write থেমে যায়।** Exercise এর `npm run failover` এর ধাপ ৪: replica কে network থেকে বিচ্ছিন্ন করে একটা sync write:

```
৩ সেকেন্ড পরে: commit এখনো replica এর অপেক্ষায় আটকে আছে? হ্যাঁ
→ app এর timeout এ ধৈর্য শেষ; query টা cancel করা হলো
COMMIT ফেরত এলো 3.0s পরে, সাথে Postgres এর সতর্কবার্তা:
  WARNING: canceling wait for synchronous replication due to user request — The transaction
  has already committed locally, but might not have been replicated to the standby.
```

দুটো জিনিস লক্ষ করো। প্রথমত, commit **চিরকাল** অপেক্ষা করত — একটা replica নেই মানে কোনো sync write নেই। Availability এর দাম। দ্বিতীয়ত — আর এটা সূক্ষ্ম — app cancel করার পরেও transaction টা **primary তে commit হয়ে গেছে**। "Timeout = rollback" না। App ভাবছে লেখা ব্যর্থ, অথচ data primary তে আছে। (৫.৫ এর retry এর সাথে মেলাও: app যদি এখন retry করে, একই task দুবার তৈরি হতে পারে — যদি না write টা idempotent হয়, Lesson 2.5।)

এই কারণে বাস্তবে সাধারণত দুটো মাঝামাঝি পথ নেওয়া হয়:

- **কয়েকটা replica এর যেকোনো একটা:** Postgres এ `synchronous_standby_names = 'ANY 1 (r1, r2)'` — দুটো replica এর যেকোনো একটা নিশ্চিত করলেই চলবে। একটা মরলে অন্যটা দিয়ে write চলতে থাকে।
- **শুধু গুরুত্বপূর্ণ write এ sync** — exercise এর মতো `SET LOCAL synchronous_commit = remote_apply` শুধু payment জাতীয় transaction এ; বাকি সব async।

### ১.৬ Failover — আর যে Data হারায়

Primary মরে গেলে একটা replica কে নতুন primary বানানো — **failover**। ধাপগুলো:

```
১. সনাক্ত করা      — primary সত্যিই মৃত? নাকি শুধু network ধীর? (ভুল হলে বিপদ, নিচে দেখো)
২. replica বাছা     — কয়েকটা থাকলে, যেটা সবচেয়ে বেশি এগিয়ে (সবচেয়ে কম data হারাবে)
৩. promote করা     — replica কে বলা "তুমি এখন primary, write নাও" (Postgres এ pg_promote())
৪. app কে সরানো    — connection এর ঠিকানা বদলানো (DNS, proxy, বা config)
৫. পুরনোটাকে থামানো — পুরনো primary ফিরে এলে সে যেন আর নিজেকে primary না ভাবে
```

Exercise এর `npm run failover` পুরো গল্পটা চালায়: replica বিচ্ছিন্ন → primary তে আরও event লেখা → primary মৃত → replica promote। শেষে নতুন primary তে গুনে দেখা:

```
before            10/10  ✓
async              0/20  ✗ হারিয়ে গেছে — অথচ user কে "saved" বলা হয়েছিল
sync               0/1  ✗ হারিয়ে গেছে — app timeout পেয়েছিল, কিন্তু পুরনো primary তে এটা commit হয়ে ছিল
after-failover     1/1  ✓
```

**এটাই async replication এর আসল দাম।** Replica যা পায়নি, promote হওয়ার পর সেটা আর কোথাও নেই। ২০টা task এর জন্য user "Saved!" দেখেছে — সেগুলো চিরতরে হারিয়ে গেছে। বাস্তবে সাধারণত lag ছোট, তাই হারায় শেষ কয়েক millisecond বা সেকেন্ডের write — কিন্তু শূন্য না।

এই হিসাবের জন্য দুটো সংখ্যা interview আর production দুই জায়গাতেই ব্যবহার হয়:

- **RPO (Recovery Point Objective)** — দুর্ঘটনায় সর্বোচ্চ **কতটা সময়ের data** হারানো গ্রহণযোগ্য। Async replication এ RPO ≈ replication lag; sync এ ≈ শূন্য। TaskFlow এর আগের backup-only অবস্থায় RPO ছিল ৬ ঘণ্টা।
- **RTO (Recovery Time Objective)** — দুর্ঘটনার পর **কতক্ষণের মধ্যে** আবার চালু হতে হবে। Backup থেকে restore এ TaskFlow এর লেগেছিল ৪০ মিনিট; replica promote এ সেকেন্ড থেকে কয়েক মিনিট (সনাক্ত করতে কত সময় লাগে তার উপর নির্ভর করে)।

(Lesson 1.5 এর SLA/SLO এর সাথে মেলাও — RPO আর RTO হলো data আর downtime নিয়ে ঠিক সেই ধরনের প্রতিশ্রুতি।)

**Failover হাতে করো নাকি স্বয়ংক্রিয়?** রাত ৩টায় কেউ হাতে `pg_promote()` চালানোর জন্য জেগে থাকবে — এটা বাস্তবসম্মত না। Postgres এর জন্য Patroni এর মতো tool, অথবা cloud এর managed database (যেমন AWS RDS এর Multi-AZ) এই পুরো প্রক্রিয়া স্বয়ংক্রিয় করে। কিন্তু স্বয়ংক্রিয় failover এর নিজের বিপদ আছে — ধাপ ১ এর প্রশ্নটা। Primary আসলে জীবিত, শুধু network এর সমস্যায় বিচ্ছিন্ন — আর system একটা replica কে promote করে ফেলল। এখন **দুটো** primary, দুটোই write নিচ্ছে, data দুই দিকে ভাগ হয়ে যাচ্ছে। এর নাম **split brain** (exercise এর experiment ৪ এ এর বীজ নিজে দেখবে), আর এটা Lesson 6.1 এর মূল বিষয় — কেন distributed system এ "অন্যজন মৃত কিনা" জানা এত কঠিন।

### ১.৭ Multi-Leader — যখন একাধিক জায়গায় Write দরকার

এতক্ষণ একটাই leader। কিন্তু কখনো কখনো একাধিক জায়গায় write নেওয়া দরকার হয়:

- **একাধিক region:** TaskFlow এর user ঢাকা, লন্ডন আর নিউ ইয়র্কে। একটা leader সিঙ্গাপুরে থাকলে লন্ডনের প্রতিটা write এ ২০০+ ms network। প্রতি region এ একটা leader হলে write স্থানীয়ভাবে দ্রুত।
- **Offline client:** একটা mobile app যেটা internet ছাড়াও task তৈরি করতে দেয় — প্রতিটা phone আসলে নিজেই একটা "leader", পরে sync করে।
- **Collaborative editing:** Google Docs জাতীয় — প্রত্যেকের নিজের কপিতে লেখা, পরে মেলানো।

**Multi-leader replication** — একাধিক server (বা device) write নেয়, আর একে অপরের পরিবর্তন কপি করে। (পুরনো নাম "master-master"।)

সমস্যা একটাই, আর সেটা বিশাল: **write conflict**। ঢাকার leader এ রহিম task #42 এর title বদলাল "Fix login", একই মুহূর্তে লন্ডনের leader এ করিম বদলাল "Fix signup"। দুটোই সফল হয়েছে, দুজনকেই "Saved!" দেখানো হয়েছে। এখন দুই leader একে অপরের পরিবর্তন পেল — কোনটা থাকবে?

সমাধানের সাধারণ উপায়:

- **Last write wins (LWW)** — সময় দেখে পরেরটা রাখো, আগেরটা ফেলে দাও। সরল — কিন্তু একজনের লেখা নীরবে হারায় (Lesson 5.5 এর lost update, এবার দুই মহাদেশ জুড়ে)। আর "পরে" ঠিক করতে দুই server এর ঘড়ি মেলাতে হয় — যেটা মেলে না (Lesson 6.4)।
- **মিলিয়ে ফেলা (merge)** — দুটো মান রেখে user কে বেছে নিতে বলা, অথবা এমন data type যেটা নিজে থেকেই মিলে যায় (CRDT — যেমন একটা counter যেটা দুই দিকের বৃদ্ধি যোগ করে)।
- **Conflict এড়ানো** — একটা নির্দিষ্ট data সবসময় একই leader এ লেখা (যেমন একটা workspace এর সব write তার "home region" এ)। বাস্তবে সবচেয়ে প্রচলিত।

তাই সাধারণ নিয়ম: **multi-leader এড়াও, যতক্ষণ না সত্যিই দরকার।** TaskFlow এর মতো একটা app এর জন্য single-leader + read replica (দরকারে অন্য region এ read replica) প্রায় সবসময় যথেষ্ট।

আর একটা তৃতীয় ধরনও আছে — **leaderless**, যেখানে কোনো leader নেই, client নিজেই কয়েকটা node এ একসাথে লেখে আর কয়েকটা থেকে পড়ে (Cassandra, DynamoDB এর ধারণা)। এটা কীভাবে সামঞ্জস্য রাখে — quorum, `R + W > N` — সেটা Lesson 5.9 এর বিষয়।

> **Trade-off Table — Replication এর ধরন**

| ধরন                             | Write কোথায়        | Failover এ data loss        | Write latency               | কখন                                  |
| ------------------------------- | ------------------- | --------------------------- | --------------------------- | ------------------------------------ |
| Single-leader, async (default)  | একটা primary        | শেষ কয়েক ms–s (lag)        | দ্রুত                       | বেশিরভাগ app                         |
| Single-leader, sync (অন্তত ১টা) | একটা primary        | প্রায় শূন্য                | সবচেয়ে ধীর replica এর সমান | টাকা-পয়সা; `ANY 1 (...)` দিয়ে      |
| Multi-leader                    | কয়েকটা leader      | conflict এ লেখা হারাতে পারে | স্থানীয়, দ্রুত             | multi-region write, offline client   |
| Leaderless (quorum)             | কয়েকটা node একসাথে | quorum এর উপর নির্ভর        | quorum এর সবচেয়ে ধীরটা     | বিশাল write, উঁচু availability (5.9) |

---

## ২. Interview Angle

**"Database এ read এর চাপ বেশি — কীভাবে scale করবে?"** — ভালো উত্তরের ক্রম: আগে cache (Module 4), তারপর read replica। কিন্তু replica বলার সাথে সাথেই নিজে থেকে বলো: "replication async, তাই lag থাকবে — user নিজের লেখা না দেখার সমস্যা হবে, সেজন্য সদ্য লিখেছে এমন user এর read primary তে পাঠাব।" Interviewer ঠিক এই follow-up টাই জিজ্ঞেস করতে চাইছিল — তুমি আগেই বলে দিলে।

**"Primary database মরে গেলে কী হবে?"** — failover এর ধাপ, RPO আর RTO এর সংখ্যা দিয়ে। "Async replication এ শেষ কয়েক সেকেন্ডের write হারাতে পারে; এটা যদি গ্রহণযোগ্য না হয় (payment), সেই write গুলোর জন্য sync replication, `ANY 1` দিয়ে যাতে একটা replica মরলেও write চলে।" বোনাস: split brain এর ঝুঁকি উল্লেখ করা।

**"Master-master দিলে তো দুই জায়গাতেই write, ভালো না?"** — conflict এর উদাহরণ দাও (দুজন একই task একই মুহূর্তে দুই region এ), LWW এর দাম (নীরবে হারানো লেখা), আর বলো কখন আসলেই দরকার (multi-region write latency, offline)।

**Production এ বাস্তবে:** বেশিরভাগ team নিজে replication চালায় না — managed database (RDS, Cloud SQL, ইত্যাদি) replica আর failover দেয়। কিন্তু lag এর bug, failover এর data loss, আর connection এর ঠিকানা বদলানো — এগুলো app এর দায়িত্বই থেকে যায়, কোনো managed service এগুলো তোমার হয়ে সমাধান করে না।

---

## ৩. Key Takeaway

- Replication তিনটা কাজে লাগে — read scaling, high availability, latency; কিন্তু **replica backup না** — ভুল `DELETE` ও কপি হয়
- Postgres এ replica primary এর **WAL stream** replay করে; replica read-only; Sequelize এর `replication` config নিজে থেকে transaction এর বাইরের read replica তে পাঠায়
- Async replication এ lag কখনো শূন্য না — exercise এ ~২ ms lag এও ২০০ বারের মধ্যে ১৯৯ বার user নিজের লেখা দেখেনি
- **Read-your-writes** এর তিনটা সমাধান, তিন জায়গায় দাম: `useMaster` (primary এর load), LSN token (পড়া ধীর), `remote_apply` (লেখা ধীর)
- Sync replication এর দাম: write সবচেয়ে ধীর replica এর সমান ধীর, replica না থাকলে write থেমে যায়, আর **cancel মানে rollback না** — `ANY 1 (...)` আর শুধু গুরুত্বপূর্ণ write এ sync
- Failover: সনাক্ত → বাছা → promote → app সরানো → পুরনোটা থামানো; async এ শেষের write হারায় (**RPO**), কত দ্রুত ফেরা (**RTO**); ভুল সনাক্তকরণে split brain
- Multi-leader শুধু সত্যিকারের দরকারে (multi-region write, offline) — write conflict আর LWW এর নীরব data loss এর দাম সহ

---

## ৪. নতুন Term (Glossary)

| Term                             | অর্থ                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Leader-Follower Replication**  | একটা server (primary) সব write নেয়, বাকিরা (replica) তার পরিবর্তন কপি করে আর শুধু read নেয় — পুরনো নাম master-slave |
| **Replication Lag**              | Primary তে commit হওয়া থেকে replica তে সেটা দেখা যাওয়া পর্যন্ত সময়                                                 |
| **Read-Your-Writes Consistency** | একজন user নিজে যা লিখেছে, পরের পড়ায় সেটা অবশ্যই দেখবে — এমন নিশ্চয়তা                                               |
| **Synchronous Replication**      | Primary commit কে সফল বলার আগে অন্তত একটা replica কে পরিবর্তনটা নিশ্চিত করতে দেয় (উল্টোটা asynchronous)              |
| **Failover**                     | Primary মরে গেলে একটা replica কে নতুন primary বানিয়ে app কে সেদিকে সরানো                                             |
| **RPO / RTO**                    | দুর্ঘটনায় সর্বোচ্চ কতটা সময়ের data হারানো চলে (RPO), আর কতক্ষণের মধ্যে আবার চালু হতে হবে (RTO)                      |
| **Multi-Leader Replication**     | একাধিক server (বা device) write নেয় আর একে অপরের পরিবর্তন কপি করে — পুরনো নাম master-master                          |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এ একজন user নিজের নাম বদলাল, আর সাথে সাথে তাকে profile page এ redirect করা হলো — সেখানে পুরনো নাম দেখাচ্ছে। একজন developer বলল, "সহজ — সব read primary থেকে করি।" এই সমাধানের সমস্যা কী? তুমি কীভাবে এমনভাবে ঠিক করবে যাতে replica রাখার লাভটা বেশিরভাগ হারাতে না হয়?
2. TaskFlow এর payment টিম বলছে, "subscription payment এর একটা record ও হারানো চলবে না।" বাকি team বলছে, "সব write sync করলে পুরো app ধীর হয়ে যাবে, আর replica মরলে কেউ task তৈরি করতে পারবে না।" দুই পক্ষকেই খুশি রাখার একটা পরিকল্পনা লেখো।
3. রাত ২টায় monitoring দেখাল primary database ৩০ সেকেন্ড ধরে সাড়া দিচ্ছে না। Automated failover একটা replica কে promote করল। ৪৫ সেকেন্ড পরে দেখা গেল — primary আসলে জীবিত ছিল, একটা network switch এর সমস্যা ছিল, আর এখন সে আবার সাড়া দিচ্ছে। কী কী বিপদ ঘটতে পারে? কী থাকলে এটা এড়ানো যেত?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** সব read primary তে পাঠালে replica রাখার পুরো লাভটা হারায় — primary এর CPU আবার ৮০%, আর replica শুধু বসে থাকে। ভালো সমাধান হলো সমস্যাটাকে সরু করা: সমস্যা শুধু **নিজের সদ্য লেখা** পড়ায়, বাকি সব read এ কয়েক ms বা সেকেন্ড পুরনো data চলে। তাই: যে user লিখল, তার session এ `lastWriteAt` রাখো; পরের কয়েক সেকেন্ড (বাস্তব lag এর চেয়ে বেশি, ধরো ১০ সেকেন্ড) তার read গুলো `useMaster: true` দিয়ে primary তে পাঠাও, বাকি সবার read replica তে। বেশিরভাগ user বেশিরভাগ সময় শুধু পড়ে, তাই primary এর উপর বাড়তি চাপ সামান্য। বাড়তি নির্ভুলতা চাইলে সময়ের বদলে LSN token (১.৪ এর গ) — "replica এই LSN পর্যন্ত পৌঁছালেই replica থেকে পড়ো।" আর এই নির্দিষ্ট ক্ষেত্রে আরও সহজ একটা উপায়: update এর response এ নতুন নামটাই ফেরত দাও, frontend সেটা দেখাক — database থেকে আবার পড়ারই দরকার নেই।

**প্রশ্ন ২:** সব write sync করার দরকার নেই — sync শুধু যেখানে RPO = শূন্য জরুরি:

- Payment এর transaction এ `SET LOCAL synchronous_commit = remote_apply` (বা অন্তত `on`/`remote_write`, replica এর disk এ পৌঁছানো নিশ্চিত করতে); task, comment, বাকি সব default async — তাদের write latency বদলায় না।
- `synchronous_standby_names = 'ANY 1 (r1, r2)'` — দুটো replica, যেকোনো একটা নিশ্চিত করলেই চলবে। একটা replica মরলেও payment চলে।
- Payment এর write idempotent (Lesson 2.5 এর idempotency key) — কারণ sync commit এ timeout মানে rollback না (১.৫); app ব্যর্থ ভেবে retry করলে একই payment দুবার যেন না হয়।
- আর নিয়মিত backup + point-in-time recovery — কারণ replica মানুষের ভুল থেকে বাঁচায় না।

**প্রশ্ন ৩:** **Split brain।** পুরনো primary ফিরে এসে এখনো নিজেকে primary ভাবছে, আর নতুন primary ও write নিচ্ছে। কিছু app instance (যাদের connection পুরনো ঠিকানায়, বা যাদের DNS cache পুরনো) পুরনোটায় লিখছে, বাকিরা নতুনটায় — data দুই দিকে ভাগ হচ্ছে, আর দুটোকে পরে মেলানো প্রায় অসম্ভব (একই id দুই দিকে ভিন্ন task, ইত্যাদি)। সাথে, পুরনো primary এর যে write গুলো replica পায়নি (async lag), সেগুলো নতুন primary তে নেই। এড়ানোর উপায়: **fencing** — failover এর সময় পুরনো primary কে নিশ্চিতভাবে থামানো (তার power বা network কেটে দেওয়া, বা storage থেকে বিচ্ছিন্ন করা), যাতে সে ফিরে এলেও write নিতে না পারে; আর failover এর সিদ্ধান্ত একটা একক নির্ভরযোগ্য জায়গা থেকে (Patroni এর মতো tool একটা consensus store ব্যবহার করে — Lesson 6.2 এর Raft এর ধারণা)। ৩০ সেকেন্ডের timeout টাও প্রশ্ন করার মতো — খুব কম হলে ক্ষণিকের network সমস্যায় অপ্রয়োজনীয় failover; খুব বেশি হলে আসল দুর্ঘটনায় RTO বাড়ে।

</details>

---

## ৬. Practical Exercise

**Tier 2 — Infra Setup** (সাথে TypeScript script)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.7-replication/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.7-replication) — `docker compose up -d --wait && npm install`, তারপর `npm run lag`, `npm run ryw`, `npm run failover` (শেষেরটার পরে `docker compose down -v && docker compose up -d --wait`)। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

Docker এ একটা আসল Postgres streaming replication cluster — primary আর replica (`pg_basebackup -R` দিয়ে তৈরি)। App connection Sequelize এর built-in `replication` config দিয়ে, তাই bug টা TaskFlow এর আসল code এর মতোই জন্মায়। `failover` script নিজে Docker দিয়ে replica বিচ্ছিন্ন করে, primary মারে, replica promote করে।

**সৎ নোট:** `main.md` অনুযায়ী Tier 2 exercise চালিয়ে যাচাই করেছি বলে দাবি করার কথা না, কারণ সাধারণত sandbox এ Docker থাকে না। এই মেশিনে Docker ছিল, তাই চালিয়ে দেখা হয়েছে: `tsc --noEmit` clean; নতুন cluster থেকে তিনটা script ক্রমানুসারে; `lag` আর `ryw` দুবার করে; `failover` দুবার (প্রতিবার reset এর পরে) — একই ফল। তবু তোমার মেশিনে চালিয়ে README এর output এর সাথে মিলিয়ে দেখো।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. তিনটা script চালাও। `lag` এর প্রথম লাইনে তোমার মেশিনে "খুঁজে পায়নি" কতবার? কেন এত ছোট lag এও bug টা প্রায় প্রতিবার ঘটে — এক লাইনে লেখো।

2. **Lag database থেকে পড়ো** (README experiment ৩): `npm run ryw` চলার সময় `pg_stat_replication` এর `write_lag`, `flush_lag`, `replay_lag` দেখো। তিনটা আলাদা কেন, আর কোনটা ২০০ ms এর কাছে?

3. **Sync replication এর availability এর দাম** (experiment ১): replica থামিয়ে একটা `remote_apply` write চালাও। কী হয়? তারপর ভাবো — TaskFlow এ সব write sync হলে, একটা replica এর disk ভরে গেলে পুরো app এর কী অবস্থা হতো?

4. **Split brain এর বীজ** (experiment ৪): `failover` এর পরে পুরনো primary আবার চালু করে দুটো database এর `events` তুলনা করো। কোন event কোথায় আছে? App এর অর্ধেক instance যদি পুরনোটায় লিখতে থাকে, এক ঘণ্টা পরে কী অবস্থা হবে?

5. **Design অংশ:** TaskFlow এর জন্য একটা replication পরিকল্পনা লেখো: কয়টা replica, sync নাকি async (কোন write এর জন্য কোনটা), read-your-writes কীভাবে সামলাবে, RPO আর RTO এর লক্ষ্য কত (সংখ্যা সহ), failover হাতে নাকি স্বয়ংক্রিয়, আর split brain কীভাবে এড়াবে। Lesson 5.6 এর pool হিসাবও মাথায় রাখো — replica যোগ হলে connection এর হিসাব কীভাবে বদলায়?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
Current: 5.7 — Replication
TaskFlow state: Nginx + ৪–৮টা Express instance, CDN, Redis cache; PostgreSQL primary +
read replica (async streaming); Sequelize read replication; সদ্য লিখেছে এমন user এর
read primary তে (read-your-writes); payment এ sync commit; failover এর পরিকল্পনা (RPO/RTO)
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
Failover, RPO/RTO, Multi-Leader Replication
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.8 — Sharding & Partitioning
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের তিনটা lag এর ব্যাখ্যা আর ৫ নম্বরের replication পরিকল্পনা। রেডি হলে `next` লিখো — Lesson 5.8 এ যাব: **Sharding & Partitioning** — replica read scale করে, কিন্তু সব write এখনো একটা primary তে। যখন write আর একটা machine এ ধরে না, বা data একটা disk এ আর আঁটে না, তখন data কে ভাগ করতে হয়। কীভাবে ভাগ করবে (range, hash), কোন key দিয়ে, hot partition কেন হয়, আর ভাগ করার পর JOIN আর transaction এর কী হয় — Postgres এর partitioning দিয়ে hands-on।
