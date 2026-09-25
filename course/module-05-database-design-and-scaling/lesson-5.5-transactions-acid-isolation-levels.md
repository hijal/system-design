# Lesson 5.5 — Transactions, ACID, Isolation Levels: একসাথে চলা কাজ কীভাবে একে অপরকে নষ্ট করে

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 4.6):** Hot key কী, আর কেন একটা Redis node এ বেশি server যোগ করলেও hot key এর সমস্যা মেটে না?

**Prerequisite:** Lesson 5.2 (Counter আর lost update), Lesson 5.3 (WAL, MVCC এর ঝলক)

**তুমি এই lesson শেষে পারবে:**

1. ACID এর চারটা অক্ষর আসলে কী guarantee দেয় (আর কী দেয় না) — বলতে পারবে, আর Postgres এর MVCC কীভাবে "snapshot" দেখায় সেটা বুঝবে
2. পাঁচটা anomaly — dirty read, non-repeatable read, phantom, lost update, write skew — চিনবে, আর Postgres এর প্রতিটা isolation level কোনটা আটকায় সেটা বলতে পারবে (নিজের চোখে দেখা ফল দিয়ে)
3. একটা race condition এর জন্য সঠিক সমাধান বাছবে — `FOR UPDATE`, atomic update, optimistic locking, নাকি `SERIALIZABLE` + retry — আর প্রতিটার দাম জানবে

**Tier:** 1 — Runnable Code

---

## ০. TaskFlow এখন কোথায়

Lesson 5.2 এ একটা প্রশ্ন খোলা রেখে এসেছিলাম। Counter বাড়ানোর naive code টা — "পড়ো, JS এ +1 করো, লিখো" — **transaction এর ভেতরে** রেখেও update হারাচ্ছিল। "Transaction তো সব নিরাপদ করে দেয়" — তাহলে?

আর এই সপ্তাহে support এ আরেকটা অদ্ভুত ticket এসেছে:

> "আমাদের project এ এখন **কোনো admin নেই**। কেউ settings বদলাতে পারছে না, কাউকে যোগও করতে পারছে না।"

অথচ TaskFlow এর code এ নিয়মটা পরিষ্কার লেখা আছে: কেউ নিজেকে admin থেকে সরাতে চাইলে আগে দেখা হয় অন্তত আরেকজন admin আছে কিনা। না থাকলে অনুমতি নেই। Log ঘেঁটে দেখা গেল — project এর দুজন admin, রহিম আর করিম, **একই সেকেন্ডে** নিজেদের সরিয়েছে। দুজনের request ই নিয়ম যাচাই করেছিল, দুজনেই "২ জন admin আছে" দেখেছিল, দুজনেই পাস করেছিল।

দুটো bug এর গোড়া একই: **একসাথে চলা transaction একে অপরকে কী দেখে, আর কী দেখে না।** এর নাম isolation — আজকের বিষয়। আর এটা এমন একটা জায়গা যেখানে অনেক অভিজ্ঞ developer ও ভুল ধারণা নিয়ে বছরের পর বছর code লেখে, কারণ এই bug গুলো local এ একা test করলে **কখনো দেখা যায় না**।

---

## ১. Theory

### ১.১ Transaction আর ACID — চারটা প্রতিশ্রুতি

**Transaction** তুমি Sequelize এ চেনো — কয়েকটা query কে একটা একক হিসেবে চালানো। Database এর বই এ এর প্রতিশ্রুতিগুলোকে একসাথে বলা হয় **ACID**:

- **A — Atomicity:** হয় সব, নয়তো কিছুই না। Transaction এর মাঝখানে error বা crash হলে আগের সব বদল বাতিল। (এটা আসলে "abortability" — পুরোটা ফেলে দেওয়ার ক্ষমতা। Lesson 5.3 এর WAL এর কারণে crash এর পরেও এটা টিকে থাকে।)
- **C — Consistency:** Transaction শেষে data সবসময় বৈধ অবস্থায় থাকবে। কিন্তু এখানে একটা সূক্ষ্ম কথা আছে — database শুধু সেই নিয়মগুলো রক্ষা করতে পারে যেগুলো তুমি তাকে **বলেছ**: foreign key, `UNIQUE`, `CHECK`, `NOT NULL`। "অন্তত একজন admin থাকবে" এর মতো নিয়ম database জানে না — সেটা তোমার code এর দায়িত্ব। আর ঠিক এই জায়গাতেই আজকের দ্বিতীয় bug।
- **I — Isolation:** একসাথে চলা transaction গুলো একে অপরের কাজে নাক গলাবে না — **কতটা** গলাবে না, সেটা isolation level ঠিক করে। আজকের মূল বিষয়।
- **D — Durability:** Commit হলে data হারাবে না, crash হলেও। Lesson 5.3 এর WAL + fsync।

> একটা সতর্কতা: ACID এর "C" আর Lesson 5.9 এ আসা CAP theorem এর "C" — নাম একই, অর্থ সম্পূর্ণ আলাদা। Interview এ গুলিয়ে ফেলা খুব সাধারণ ভুল।

**Sequelize এ transaction** — দুই ধরনের:

```typescript
// Managed — callback শেষ হলে commit, throw করলে নিজে থেকে rollback
await sequelize.transaction(async (transaction) => {
	await Task.create({ title, projectId }, { transaction });
	await Project.increment('openTaskCount', { by: 1, where: { id: projectId }, transaction });
});
```

Unmanaged (`const t = await sequelize.transaction()` তারপর নিজে `t.commit()`/`t.rollback()`) — exercise এর `anomalies.ts` এ দুটো transaction এর ধাপ হাতে সাজাতে এটাই ব্যবহার হয়েছে।

**সবচেয়ে সাধারণ Sequelize bug:** প্রতিটা query তে `{ transaction }` pass করতে ভুলে যাওয়া। ভুলে গেলে সেই query **transaction এর বাইরে, pool এর অন্য একটা connection এ** চলে — transaction এর কোনো guarantee তার উপর খাটে না। আর যদি সেই row টা transaction এর lock এ থাকে, query টা transaction শেষ হওয়ার অপেক্ষা করে, আর transaction অপেক্ষা করে query এর — app চিরকাল আটকে থাকে। (Exercise এর experiment ৪ এ নিজে দেখবে।)

### ১.২ কেন সব Transaction লাইন ধরে চালানো হয় না?

সবচেয়ে সহজ isolation হতো: একবারে একটাই transaction চলবে, বাকিরা লাইনে। কোনো race থাকত না। কিন্তু তাহলে TaskFlow এর ১০০ জন user এর ১০০টা request একটা একটা করে চলত — throughput ধসে পড়ত।

তাই database transaction গুলোকে **একসাথে** চলতে দেয়, আর বিনিময়ে কিছু অদ্ভুত ঘটনা (anomaly) ঘটার সুযোগ রাখে। **Isolation level** — একটা database কোন কোন anomaly ঘটতে দেবে আর কোনগুলো আটকাবে, তার একটা ঘোষিত স্তর। যত কড়া level, তত কম anomaly — কিন্তু তত বেশি অপেক্ষা বা ব্যর্থ transaction।

### ১.৩ MVCC — প্রতিটা Transaction একটা "Snapshot" দেখে

Postgres কীভাবে একসাথে চলা transaction আলাদা রাখে, সেটা না বুঝলে isolation level গুলো মুখস্থের জিনিস হয়ে থাকে। Lesson 5.3 এ একটা ঝলক দেখেছিলে — `UPDATE` এর পর row এর `ctid` বদলে গিয়েছিল, কারণ Postgres পুরনো row টা মুছে না দিয়ে **নতুন version** লেখে।

**MVCC (Multi-Version Concurrency Control)** — একটা row এর একাধিক version একসাথে রাখা, যাতে প্রতিটা transaction একটা নির্দিষ্ট মুহূর্তের "snapshot" দেখতে পারে — অন্য কেউ সেই row বদলাচ্ছে কিনা তাতে কিছু যায় আসে না।

```
সময় ──────────────────────────────────────────────────────────────►

projects row (id=1):   [v1: name="Website"] ─────────┐
                                                      │  B UPDATE + COMMIT
                                                      └─► [v2: name="Website v2"]

Transaction A (REPEATABLE READ):  |──── snapshot নিল ────── পড়ল ─────── আবার পড়ল ──|
                                        (v1 দৃশ্যমান)      "Website"     "Website"
                                                                          (তখনো v1!)
Transaction A (READ COMMITTED):   |── পড়ল ────────────────── আবার পড়ল ──|
                                      "Website"                "Website v2"
                                      (প্রতিটা statement নতুন snapshot)
```

এর সবচেয়ে বড় সুবিধা: **পড়া কখনো লেখাকে আটকায় না, লেখা কখনো পড়াকে আটকায় না।** একজন report এর জন্য বড় query চালাচ্ছে বলে বাকিদের task তৈরি থেমে থাকে না। শুধু **দুটো লেখা একই row তে** হলে একজনকে অপেক্ষা করতে হয়।

আর Postgres এর দুটো মূল level এর পার্থক্য এক লাইনে:

- **READ COMMITTED (Postgres এর default):** **প্রতিটা statement** শুরুর মুহূর্তে একটা নতুন snapshot নেয়
- **REPEATABLE READ:** transaction এর **প্রথম statement** এর মুহূর্তে একটা snapshot নেয়, আর পুরো transaction সেটাই দেখে

পুরনো version গুলো পরে VACUUM পরিষ্কার করে (Lesson 5.3)।

### ১.৪ পাঁচটা Anomaly — চোখে দেখা

Exercise এর `npm run anomalies` দুটো transaction (A আর B) এর প্রতিটা ধাপ হাতে সাজানো ক্রমে চালায় — race এর উপর ভরসা না, তাই প্রতিবার একই ফল। নিচের সব output সেখান থেকে।

**১. Dirty read — commit হয়নি এমন data পড়া।** A একটা নাম বদলাল কিন্তু commit করেনি; B সেটা দেখে ফেলল; তারপর A rollback করল — B এমন একটা জিনিস দেখেছে যেটা **কখনো সত্যি ছিল না**।

```
[B = READ UNCOMMITTED]
  A: নাম বদলে "Draft name" — এখনো COMMIT করেনি
  B: পড়ল: "Website"
```

Postgres এ এটা **কখনো** ঘটে না — এমনকি `READ UNCOMMITTED` চাইলেও। Postgres সেটাকে চুপচাপ `READ COMMITTED` হিসেবে চালায়। MVCC তে uncommitted version অন্য কারো snapshot এ দৃশ্যমানই হয় না।

**২. Non-repeatable read — একই row দুবার পড়ে ভিন্ন মান।**

```
[READ COMMITTED]    A: প্রথমবার "Website"  → B বদলে commit → A: দ্বিতীয়বার "Website v2"
[REPEATABLE READ]   A: প্রথমবার "Website"  → B বদলে commit → A: দ্বিতীয়বার "Website"
```

TaskFlow এ কোথায় সমস্যা? একটা report transaction প্রথমে project গুলোর নাম পড়ল, তারপর তাদের task গুনল — মাঝখানে কেউ কিছু বদলালে report এর দুই অংশ দুটো আলাদা মুহূর্তের সত্য দেখায়।

**৩. Phantom read — একই শর্তে দুবার খুঁজে ভিন্ন সংখ্যক row।**

```
[READ COMMITTED]    A: 3টা task  → B নতুন task যোগ করে commit → A: 4টা task
[REPEATABLE READ]   A: 3টা task  → B নতুন task যোগ করে commit → A: 3টা task
```

**৪. Lost update — দুজনের লেখার একটা নীরবে হারিয়ে যায়।** এটাই Lesson 5.2 এর রহস্য:

```
[READ COMMITTED]
  A: পড়ল 5
  B: পড়ল 5
  A: লিখল 6, COMMIT
  B: লিখল 6, COMMIT
    → শেষ মান 6 (হওয়া উচিত 7) — একটা update নীরবে হারিয়ে গেছে, কেউ কোনো error পায়নি
```

দেখো — দুজনেই transaction এ, দুজনেই সফল, কোনো error নেই। READ COMMITTED শুধু নিশ্চিত করে তুমি **commit হওয়া** data পড়বে; সে নিশ্চিত করে না যে তুমি যা পড়েছ সেটা তুমি লেখার সময় পর্যন্ত **সত্য থাকবে**। B এর পড়া "5" তার লেখার সময় আর সত্য ছিল না।

একই জিনিস REPEATABLE READ এ:

```
[REPEATABLE READ]
  A: পড়ল 5 · B: পড়ল 5 · A: লিখল 6, COMMIT
  B: লিখতে গেল → ERROR 40001 — could not serialize access (serialization failure), ROLLBACK
    → শেষ মান 6 — B এর কাজ হয়নি, কিন্তু B সেটা জানে; retry করলে 7 হবে। নীরবে হারায়নি
```

এখানে Postgres ধরে ফেলেছে: B এর snapshot এ row টা এক রকম, অথচ B লিখতে যাওয়ার আগে অন্য কেউ সেটা বদলে commit করেছে। সে B কে লিখতে দেয় না — **serialization failure** (SQLSTATE `40001`) ছুড়ে দেয়। এর অর্থ: "তোমার পড়া data পুরনো; পুরো transaction টা আবার শুরু থেকে চালাও।" Update এখনো হয়নি — কিন্তু **নীরবে হারায়নি**, আর এই পার্থক্যটাই সব।

**৫. Write skew — দুজনেই নিয়ম মেনেছে, তবু নিয়ম ভেঙেছে।** এটাই admin bug:

```
[REPEATABLE READ]  নিয়ম: অন্তত ১ জন admin থাকবেই
  A: Rahim যাচাই করল: admin 2 জন → "আমি সরলেও একজন থাকবে" ✓
  B: Karim যাচাই করল: admin 2 জন → "আমি সরলেও একজন থাকবে" ✓
  A: Rahim নিজেকে member করল
  B: Karim নিজেকে member করল
  A: COMMIT ✓
  B: COMMIT ✓
    → এখন admin: 0 জন — নিয়ম ভেঙে গেছে, অথচ দুজনেই নিয়ম যাচাই করেছিল!
```

REPEATABLE READ কেন ধরতে পারল না, যখন lost update ধরেছিল? কারণ এখানে দুজন **আলাদা row** বদলেছে — রহিম নিজের row, করিম নিজের row। কোনো row এ দুজনের লেখা নেই, তাই কোনো সংঘাত দেখা যায় না। সমস্যাটা row এ না — সমস্যাটা **যে শর্ত দুজনেই পড়ে সিদ্ধান্ত নিয়েছে** ("admin ২ জন"), সেটা অন্যের লেখায় মিথ্যা হয়ে গেছে।

**Write skew** — দুটো transaction একই data পড়ে একটা শর্ত যাচাই করে, তারপর **আলাদা আলাদা** row এ লেখে, আর তাদের মিলিত ফলাফল সেই শর্ত ভেঙে দেয়। Pattern টা সবসময় একই: **পড়ো → শর্ত যাচাই করো → সেই শর্তের উপর ভিত্তি করে অন্য কোথাও লেখো।** বাস্তব উদাহরণ: দুজন একই meeting room একই সময়ে book করা, দুজন শেষ ticket কেনা, দুজন doctor একই রাতে on-call থেকে ছুটি নেওয়া।

SERIALIZABLE এ একই ঘটনা:

```
[SERIALIZABLE]
  … (একই চারটা ধাপ) …
  A: COMMIT ✓
  B: COMMIT → ERROR 40001 — could not serialize access (serialization failure)
    → এখন admin: 1 জন — নিয়ম টিকে আছে
```

Postgres এর SERIALIZABLE (যেটার ভেতরের পদ্ধতির নাম Serializable Snapshot Isolation, SSI) শুধু লেখার সংঘাত না, **কে কী পড়েছিল** সেটাও নজরে রাখে। সে দেখে: A যা পড়েছিল B সেটা বদলেছে, আর B যা পড়েছিল A সেটা বদলেছে — এমন কোনো ক্রম নেই যেখানে দুটো একটার পর একটা চললে এই ফল হতো। তাই একজনকে বাতিল করে।

> **Postgres এ কোন level কী আটকায়** (exercise এ মাপা, Postgres 17):

| Anomaly             | READ COMMITTED (default) | REPEATABLE READ          | SERIALIZABLE  |
| ------------------- | ------------------------ | ------------------------ | ------------- |
| Dirty read          | আটকায়                   | আটকায়                   | আটকায়        |
| Non-repeatable read | **ঘটে**                  | আটকায়                   | আটকায়        |
| Phantom read        | **ঘটে**                  | আটকায়                   | আটকায়        |
| Lost update         | **নীরবে ঘটে**            | ধরে — error `40001` দেয় | ধরে — `40001` |
| Write skew          | **ঘটে**                  | **ঘটে**                  | ধরে — `40001` |

**সৎ সতর্কতা:** এই table টা **Postgres** এর। SQL standard এ REPEATABLE READ phantom আটকানোর দায় নেয় না — Postgres বেশি দেয়। আর MySQL (InnoDB) এর default ও "REPEATABLE READ", কিন্তু তার ভেতরের পদ্ধতি আলাদা, তাই guarantee ও পুরোপুরি এক না। **একই নামের level, ভিন্ন database এ ভিন্ন আচরণ** — database বদলালে নিজের database এর documentation পড়ো, নাম দেখে ধরে নিও না।

### ১.৫ Write Skew কীভাবে ঠিক করবে

তিনটা উপায়:

1. **SERIALIZABLE + retry।** সবচেয়ে সাধারণ সমাধান — Postgres নিজে খুঁজে বের করে। দাম: ব্যর্থ transaction আর retry, আর database কে পড়ার হিসাব রাখতে বাড়তি কাজ।
2. **যা পড়ছ সেটা lock করো।** Admin row গুলো `SELECT ... FOR UPDATE` দিয়ে পড়লে, দ্বিতীয় transaction কে প্রথমটার শেষ হওয়া পর্যন্ত অপেক্ষা করতে হয় — তারপর সে নতুন অবস্থা (১ জন admin) দেখে। (Exercise এর experiment ২।)
3. **সংঘাতকে একটা row এ নিয়ে আসো।** কখনো কখনো পড়া row গুলো lock করা যায় না — যেমন meeting room booking এ "এই সময়ে কোনো booking **নেই**" যাচাই করা; যে row নেই তাকে lock করবে কীভাবে? তখন একটা নির্দিষ্ট row কে "তালা" হিসেবে ব্যবহার করা হয় — যেমন ওই project এর row টা `FOR UPDATE` করা — যাতে ওই project এর সব membership বদল একটা একটা করে হয়।

আর যদি নিয়মটা database constraint হিসেবে প্রকাশ করা যায় (`UNIQUE`, `CHECK`, exclusion constraint), সেটাই সবচেয়ে ভালো — database নিজে রক্ষা করবে, কোনো level যাই হোক।

### ১.৬ Lost Update — সাতটা কৌশল, মাপা

এবার Lesson 5.2 এর counter। Exercise এর `npm run lostupdate` একটা counter এ **১০০টা `+1` একসাথে** চালায়, সাতটা কৌশলে (pool এ ১০টা connection):

```
কৌশল                                      শেষ মান      retry      সময়
১. read-modify-write, transaction ছাড়া   ✗   1/100        0     145 ms
২. একই, READ COMMITTED transaction এ      ✗  10/100        0     113 ms
৩. SELECT ... FOR UPDATE                  ✓ 100/100        0     141 ms
৪. atomic UPDATE … SET x = x + 1          ✓ 100/100        0     106 ms
৫. REPEATABLE READ + retry                ✓ 100/100      348     371 ms
৬. optimistic locking (version) + retry   ✓ 100/100     1206     801 ms
৭. SERIALIZABLE + retry                   ✓ 100/100      339     347 ms
```

প্রথম দুটো লাইন Lesson 5.2 এর রহস্যের উত্তর: **transaction একা কিছুই সমাধান করেনি** (১০০ এর মধ্যে ৯০টা হারাল)। বাকি পাঁচটা সঠিক — কিন্তু তারা তিনটা একেবারে ভিন্ন দর্শন থেকে আসে:

**ক. আগে তালা নাও — pessimistic locking।** "সংঘাত হবেই ধরে নাও; পড়ার মুহূর্তেই row টা নিজের করে নাও।" **Pessimistic locking** — পড়ার সময়েই row lock করা (`SELECT ... FOR UPDATE`), যাতে অন্য কেউ সেই row বদলাতে বা lock করতে চাইলে অপেক্ষা করে। Sequelize এ:

```typescript
sequelize.transaction({ isolationLevel: READ_COMMITTED }, async (transaction) => {
	const p = await Project.findByPk(projectId, { transaction, lock: transaction.LOCK.UPDATE });
	if (!p) throw new Error('missing');
	await Project.update(
		{ openTaskCount: p.openTaskCount + 1 },
		{ where: { id: projectId }, transaction }
	);
});
```

`anomalies` এর timeline এ দেখা গেছে কী হয়: B একই row `FOR UPDATE` পড়তে চাইলে ৩০০ ms পরেও অপেক্ষায়, A commit করতেই B **নতুন মান (6)** পড়ে, আর 7 লেখে। কোনো retry নেই, কোনো error নেই — শুধু লাইন।

**খ. হিসাবটা database কে দাও — atomic update।** `UPDATE projects SET "openTaskCount" = "openTaskCount" + 1` — পড়া আর লেখা একটাই statement। READ COMMITTED এও নিরাপদ: দুজন একসাথে এলে দ্বিতীয়জন row lock এর জন্য অপেক্ষা করে, আর lock পেলে Postgres row এর **সর্বশেষ commit হওয়া version** এর উপর হিসাবটা আবার করে। সাতটার মধ্যে সবচেয়ে দ্রুত আর সবচেয়ে সরল। যখন পারো, এটাই প্রথম পছন্দ।

এর একটা শক্তিশালী রূপ — **শর্তসহ atomic update**, শেষ জিনিস বিক্রির মতো সমস্যার জন্য:

```sql
UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0
```

তারপর দেখো কয়টা row বদলেছে — ০ হলে stock শেষ। যাচাই আর লেখা এক statement এ, তাই দুজন শেষ জিনিসটা কিনতে পারে না।

**গ. সংঘাত ধরো, আবার চেষ্টা করো — optimistic।** "সংঘাত কদাচিৎ হয় ধরে নাও; কোনো lock নিও না; লেখার সময় যাচাই করো কেউ মাঝখানে বদলেছে কিনা; বদলালে আবার চেষ্টা করো।" তিনটা কৌশল এই গোত্রে:

- **REPEATABLE READ / SERIALIZABLE (৫, ৭)** — Postgres নিজে সংঘাত ধরে `40001` দেয়
- **Optimistic locking (৬)** — application নিজে ধরে। **Optimistic locking** — row এ একটা `version` column রাখা; লেখার সময় `WHERE version = <যা পড়েছিলাম>` দিয়ে লেখা, আর ০টা row বদলালে বোঝা যায় কেউ আগে বদলে দিয়েছে। Sequelize এ model এ `version: true` দিলে `save()` নিজেই এটা করে আর `OptimisticLockError` ছোড়ে:

```typescript
withRetry(async () => {
	const p = await Project.findByPk(projectId);
	if (!p) throw new Error('missing');
	p.openTaskCount = p.openTaskCount + 1;
	await p.save();
}, stats);
```

এই গোত্রে **retry ছাড়া কিছুই কাজ করে না** — retry না থাকলে এরা শুধু error ছুড়ত। Exercise এর retry helper:

```typescript
export async function withRetry<T>(
	fn: () => Promise<T>,
	stats: RetryStats,
	maxAttempts = 50
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error: unknown) {
			if (!isRetryable(error) || attempt >= maxAttempts) throw error;
			stats.retries++;
			const backoff = Math.min(100, 2 ** Math.min(attempt, 6));
			await sleep(Math.random() * backoff);
		}
	}
}
```

তিনটা জিনিস লক্ষ করো: (১) শুধু **retry করার মতো** error এ আবার চেষ্টা — `40001`, deadlock (`40P01`), `OptimisticLockError`; বাকি সব error সাথে সাথে উপরে যায়। (২) **পুরো transaction** আবার চলে, শুধু ব্যর্থ query না — কারণ transaction এ যা পড়া হয়েছিল সেটাই এখন পুরনো। (৩) **Backoff + jitter** — সবাই একসাথে আবার চেষ্টা করলে আবার একসাথে ধাক্কা খাবে; Lesson 4.6 এর TTL jitter এর মতোই যুক্তি, আর Lesson 7.4 এ এটা পুরো গভীরে আসবে।

**Table টার সবচেয়ে শিক্ষণীয় সংখ্যা:** optimistic locking এ **১২০৬টা retry** — প্রতিটা সফল লেখার জন্য গড়ে ১২টা ব্যর্থ চেষ্টা, আর সবচেয়ে ধীর। কারণ ১০০ জন **একই row** এ লিখছে — এটা optimistic এর জন্য সবচেয়ে খারাপ পরিস্থিতি। Optimistic এর জায়গা হলো যেখানে সংঘাত **কদাচিৎ**: দুজন একই task এর description একই মুহূর্তে edit করছে — বিরল ঘটনা, আর তখন lock না নেওয়ার সুবিধাটাই বড়। একটা গরম counter এ pessimistic বা atomic অনেক ভালো।

> **Trade-off Table — কোন কৌশল কখন**

| কৌশল                    | কখন                                                         | দাম                                                             |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Atomic update           | হিসাবটা এক statement এ লেখা যায় (`x = x + 1`, `stock > 0`) | সবচেয়ে কম; জটিল business logic এক statement এ ধরে না           |
| `SELECT ... FOR UPDATE` | পড়ো → JS এ সিদ্ধান্ত → লেখো, একটা নির্দিষ্ট row এ          | অপেক্ষা; transaction লম্বা হলে সবাই লাইনে; deadlock এর সম্ভাবনা |
| Optimistic (`version`)  | সংঘাত বিরল; user অনেকক্ষণ ধরে edit করে (form খোলা রেখে)     | সংঘাত বেশি হলে retry এর ঝড়; retry logic লাগবেই                 |
| REPEATABLE READ + retry | Transaction জুড়ে সামঞ্জস্যপূর্ণ snapshot দরকার (report)    | Lost update ধরে, কিন্তু **write skew ধরে না**; retry লাগবে      |
| SERIALIZABLE + retry    | জটিল নিয়ম যেটা অনেক row পড়ে যাচাই হয় (admin, booking)    | ব্যর্থ transaction বেশি; retry বাধ্যতামূলক; বাড়তি overhead     |

### ১.৭ বাস্তব নিয়ম

- **Default READ COMMITTED বেশিরভাগ কাজের জন্য যথেষ্ট** — যদি তুমি জানো এটা কী দেয় না। "পড়ো → সিদ্ধান্ত নাও → লেখো" pattern দেখলেই থামো আর ভাবো: আমি যা পড়েছি, লেখার আগে সেটা বদলে যেতে পারে কি?
- **সম্ভব হলে atomic update।** তারপর row-নির্দিষ্ট কাজে `FOR UPDATE`। জটিল নিয়মে SERIALIZABLE।
- **Retry করলে side effect সাবধানে।** Transaction এর ভেতরে email পাঠালে, আর transaction টা তিনবার retry হলে — user তিনটা email পাবে, অথচ data তে একবারই বদল হয়েছে। Email, payment API call, message — এগুলো **commit এর পরে** করো (নিরাপদ উপায় "outbox pattern", Module 7 এ)।
- **Transaction ছোট রাখো।** Transaction যতক্ষণ খোলা, ততক্ষণ lock ধরা থাকে (Lesson 5.2 এর hot row), আর একটা connection আটকে থাকে (Lesson 5.6)। Transaction এর ভেতরে কখনো network call না।

---

## ২. Interview Angle

**এই topic interview এ তিনভাবে আসে:**

1. **সরাসরি:** "Isolation level গুলো ব্যাখ্যা করো।" — চারটা level এর নাম বলা যথেষ্ট না। প্রতিটা anomaly এর একটা **ঠিক উদাহরণ** দাও, আর বলো তোমার database (Postgres) এর default কী আর সেটা কী আটকায় না। "Postgres এর default READ COMMITTED lost update আটকায় না" — এটা বললেই বোঝা যায় তুমি বাস্তবে এটা দেখেছ।

2. **Design প্রশ্নের ভেতরে লুকানো:** "Ticket booking system design করো" / "Inventory কমাবে কীভাবে যাতে oversell না হয়?" — এখানে interviewer দেখতে চায় তুমি race condition টা নিজে থেকে ধরতে পারো কিনা। ভালো উত্তর: "দুজন একসাথে শেষ seat কিনতে পারে — `UPDATE seats SET status = 'booked' WHERE id = ? AND status = 'free'`, তারপর affected row গুনব; ০ হলে seat চলে গেছে।"

3. **Payment/টাকা:** "দুটো account এর মধ্যে টাকা পাঠানো" — atomicity (দুটো balance একসাথে বদলাবে), আর দুটো একসাথে চলা transfer যাতে একই account থেকে বেশি টাকা তুলে না নেয় (lock, বা শর্তসহ atomic update `WHERE balance >= amount`)। আর deadlock: দুটো transfer উল্টো ক্রমে দুটো account lock করলে — সমাধান সবসময় একই ক্রমে lock নেওয়া (যেমন ছোট id আগে)।

**Common follow-up গুলো:**

- _"তাহলে সবসময় SERIALIZABLE দিলেই তো হয়?"_ — ব্যর্থ transaction বাড়ে, সব জায়গায় retry লাগে, overhead আছে; আর retry এর সাথে side effect সামলাতে হয়। যেখানে দরকার সেখানে
- _"Optimistic নাকি pessimistic?"_ — সংঘাতের হার দিয়ে সিদ্ধান্ত: কম হলে optimistic (lock এর খরচ নেই), বেশি হলে pessimistic (retry ঝড় এড়াতে)। Exercise এ একই row এ ১০০ জনে optimistic ১২০০+ retry নিয়েছে

---

## ৩. Key Takeaway

- ACID এর "C" এর বড় অংশ তোমার দায়িত্ব — database শুধু সেই নিয়ম রক্ষা করে যেটা constraint হিসেবে তাকে বলা হয়েছে
- **Transaction একা race আটকায় না** — READ COMMITTED এ transaction এর ভেতরেও ১০০ এর মধ্যে ৯০টা update হারাল
- Postgres এর MVCC: প্রতিটা transaction একটা snapshot দেখে; READ COMMITTED প্রতি statement এ নতুন, REPEATABLE READ পুরো transaction এ একটা; পড়া-লেখা একে অপরকে আটকায় না
- Postgres এ dirty read কখনো না; READ COMMITTED এ non-repeatable, phantom, **lost update নীরবে**, write skew; REPEATABLE READ lost update ধরে কিন্তু **write skew ধরে না**; SERIALIZABLE সব ধরে
- **Write skew** — পড়ো → শর্ত যাচাই → অন্য row এ লেখো; আলাদা row বলে সংঘাত চোখে পড়ে না; SERIALIZABLE, পড়া row এ `FOR UPDATE`, বা একটা row কে তালা বানাও
- সমাধানের ক্রম: **atomic update** (শর্তসহ ও) → **`FOR UPDATE`** → **SERIALIZABLE + retry**; optimistic শুধু যেখানে সংঘাত বিরল
- Retry মানে **পুরো transaction**, শুধু retryable error এ, backoff + jitter সহ; side effect commit এর পরে; transaction ছোট আর network call মুক্ত

---

## ৪. নতুন Term (Glossary)

| Term                    | অর্থ                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **ACID**                | Transaction এর চারটা প্রতিশ্রুতি — Atomicity (সব বা কিছুই না), Consistency, Isolation, Durability                             |
| **Isolation Level**     | একসাথে চলা transaction গুলোর মধ্যে database কোন কোন anomaly ঘটতে দেবে, তার ঘোষিত স্তর                                         |
| **MVCC**                | Row এর একাধিক version রেখে প্রতিটা transaction কে একটা নির্দিষ্ট মুহূর্তের snapshot দেখানো — পড়া আর লেখা একে অপরকে আটকায় না |
| **Lost Update**         | দুটো transaction একই মান পড়ে বদলে লেখে, আর একজনের লেখা অন্যজনের লেখায় নীরবে মুছে যায়                                       |
| **Write Skew**          | দুটো transaction একই data পড়ে শর্ত যাচাই করে আলাদা row এ লেখে, আর মিলিত ফল সেই শর্ত ভেঙে দেয়                                |
| **Pessimistic Locking** | পড়ার সময়েই row lock করা (`SELECT ... FOR UPDATE`), যাতে অন্যরা অপেক্ষা করে                                                  |
| **Optimistic Locking**  | Lock না নিয়ে একটা `version` রাখা; লেখার সময় মিলিয়ে দেখা, না মিললে আবার চেষ্টা                                              |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. একটা online shop এর code: `const p = await Product.findByPk(id, { transaction }); if (p.stock > 0) await p.update({ stock: p.stock - 1 }, { transaction });` — READ COMMITTED transaction এর ভেতরে। Stock ১, আর দুজন একই মুহূর্তে "কিনুন" চাপল। কী হবে? এটা কোন anomaly? আর **একটা** SQL statement দিয়ে কীভাবে ঠিক করবে?
2. TaskFlow এর "user কে project এ যোগ করো" transaction টা SERIALIZABLE, retry সহ, আর transaction এর ভেতরে নতুন member কে একটা welcome email পাঠায়। ব্যস্ত সময়ে কিছু user দুটো-তিনটা welcome email পাচ্ছে। কেন? কীভাবে ঠিক করবে?
3. Postgres এর REPEATABLE READ phantom আটকায়, lost update ও ধরে। তাহলে এটাকে পুরোপুরি "serializable" বলা যায় না কেন? Exercise এর কোন ফলটা এর প্রমাণ?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** দুজনেই `stock = 1` পড়বে (READ COMMITTED এ অন্যজন তখনো commit করেনি), দুজনেই শর্ত পাস করবে, দুজনেই `stock: 0` লিখবে — **দুটো জিনিস বিক্রি হলো, stock এ ছিল একটা**, আর শেষে stock ০ দেখায়, তাই কেউ টেরও পাবে না। এটা **lost update** (দুজনেই একই row পড়ে বদলে লিখেছে; দ্বিতীয় লেখা প্রথমটাকে ঢেকে দিয়েছে — এখানে দুটো "−১" মিলে একটা "−১" হয়ে গেছে)। এক statement এ সমাধান — শর্তসহ atomic update:

```sql
UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0
```

তারপর affected row গোনো: ১ হলে বিক্রি সফল, ০ হলে stock শেষ। দ্বিতীয়জনের UPDATE প্রথমজনের lock এর অপেক্ষা করে, তারপর row এর নতুন অবস্থায় (`stock = 0`) শর্ত আবার যাচাই হয় — শর্ত মেলে না, ০ row বদলায়। Sequelize এ:

```typescript
const [affected] = await Product.update(
	{ stock: sequelize.literal('stock - 1') },
	{ where: { id, stock: { [Op.gt]: 0 } } }
);
const sold = affected === 1;
```

(যাচাই করা: stock ১, ২০ জন একসাথে — পাঁচবার চালিয়ে প্রতিবার ঠিক ১ জন সফল, stock কখনো negative হয়নি।) একটা ফাঁদ: `Product.decrement(...)` ও একই SQL বানায়, কিন্তু Postgres এ তার return value টা তার type definition এর সাথে মেলে না (একটা nested array আসে) — affected row গুনতে `update` টাই নির্ভরযোগ্য।

**প্রশ্ন ২:** Serialization failure হলে পুরো transaction আবার চলে — email পাঠানোর code ও আবার চলে। কিন্তু email একটা **side effect** — database এর rollback তাকে ফেরত আনতে পারে না। প্রথম চেষ্টায় email চলে গেছে, তারপর transaction ব্যর্থ, দ্বিতীয় চেষ্টায় আবার email। ঠিক করার উপায়: email পাঠাও **commit সফল হওয়ার পরে**, transaction এর বাইরে। আরও নিরাপদ: transaction এর ভেতরে একটা `outbox` table এ "এই email পাঠাতে হবে" লিখে রাখো (এটা rollback হলে সাথে মুছে যায়), আর একটা আলাদা worker সেখান থেকে পড়ে email পাঠায় — এটাই outbox pattern, Module 7 এ বিস্তারিত। আর email service এ idempotency key (Lesson 2.5) দিলে ভুলক্রমে দুবার পাঠানোও আটকানো যায়।

**প্রশ্ন ৩:** কারণ REPEATABLE READ (Postgres এ যেটা আসলে snapshot isolation) শুধু **একই row এ দুটো লেখার** সংঘাত ধরে। যখন দুটো transaction একই data **পড়ে** কিন্তু **আলাদা row** এ লেখে, তখন কোনো লেখা-লেখা সংঘাত নেই — অথচ ফলাফল এমন যেটা কোনো ক্রমিক (serial) চালানোয় সম্ভব না। এটাই write skew। প্রমাণ: exercise এর `anomalies` ধাপ ৪ — REPEATABLE READ এ রহিম আর করিম দুজনেই সফলভাবে commit করল, আর admin শূন্য হয়ে গেল; SERIALIZABLE এ দ্বিতীয়জন `40001` পেল। "Serializable" মানে: ফলাফল এমন হবে যেন transaction গুলো কোনো একটা ক্রমে একটার পর একটা চলেছে — write skew এর ফল সেই সংজ্ঞা ভাঙে।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.5-transactions/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.5-transactions) — `docker compose up -d --wait && npm install`, তারপর `npm run anomalies` আর `npm run lostupdate`। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

দুটো script: `anomalies` দুটো transaction এর ধাপ হাতে সাজানো ক্রমে চালিয়ে পাঁচটা anomaly দেখায় — প্রতিবার হুবহু একই output; `lostupdate` ১০০টা একসাথে `+1` সাতটা কৌশলে মাপে। Retry helper Postgres এর error code Zod দিয়ে চেনে (`as` দিয়ে না)। Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean, `anomalies` দুবার চালিয়ে output হুবহু এক, `lostupdate` তিনবার চালিয়ে ৩–৭ প্রতিবার ১০০/১০০।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. দুটো script চালাও। `anomalies` কি README এর সাথে হুবহু মেলে? `lostupdate` এ কৌশল ২ তে কতগুলো টিকল, আর optimistic (৬) এ কত retry?

2. **Retry তুলে দাও** (README experiment ১): কৌশল ৭ থেকে `withRetry` সরিয়ে চালাও। কী হলো? এক লাইনে লেখো — SERIALIZABLE বেছে নিলে retry কেন "optional" না।

3. **Write skew ঠিক করো SERIALIZABLE ছাড়া** (experiment ২): admin row গুলো `FOR UPDATE` দিয়ে lock করে REPEATABLE READ এ চালাও। B কি অপেক্ষা করল, error পেল, নাকি দুটোই? ফলাফল দেখে ব্যাখ্যা করো কেন।

4. **Contention কমাও** (experiment ৩): ১০০টা increment ১০টা project এ ভাগ করো। Optimistic এর retry কত কমল? এই সংখ্যা থেকে "optimistic কখন ভালো" এর নিয়মটা নিজের ভাষায় লেখো।

5. **Design অংশ:** TaskFlow এ তিনটা নতুন feature। প্রতিটার race condition টা কী, কোন anomaly, আর কোন কৌশলে (১.৬ এর table থেকে) সমাধান করবে — কারণ সহ:
   - (ক) একটা task একজনকেই assign করা যাবে — দুজন manager একই মুহূর্তে একই task দুজন আলাদা মানুষকে assign করছে
   - (খ) Free plan এ একটা workspace এ সর্বোচ্চ ৫টা project — দুটো tab থেকে একসাথে ষষ্ঠ project তৈরি
   - (গ) Task এর description — দুজন একই task এর form খুলে ১০ মিনিট ধরে লিখছে, তারপর দুজনেই save

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2, 5.3, 5.4
Current: 5.5 — Transactions, ACID, Isolation Levels
TaskFlow state: Nginx + ৪টা Express instance, CDN, Redis cache, একটা PostgreSQL primary;
normalized schema + query ভিত্তিক index; counter এ atomic increment;
admin সরানোর নিয়ম SERIALIZABLE + retry (write skew bug ঠিক)
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.6 — Connection Pooling, N+1 Problem, Query Optimization
=======================
```

---

## ৮. পরের Lesson

Exercise টা চালিয়ে পাঠাও — বিশেষ করে ৩ নম্বরের ফল আর ৫ নম্বরের তিনটা design। রেডি হলে `next` লিখো — Lesson 5.6 এ যাব: **Connection Pooling, N+1 Problem, Query Optimization** — আজ বারবার যে "pool এ ১০টা connection" কথাটা এসেছে, সেটা আসলে কী, pool size কীভাবে ঠিক করতে হয় (বেশি দিলেই ভালো না), Sequelize এর `include` কখন একটা query আর কখন শত শত query বানায়, আর ৪টা Express instance মিলে Postgres এর connection limit কীভাবে ছাড়িয়ে যায় — hands-on, মেপে।
