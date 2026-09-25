# Module 5 — Exit Challenge (Database Design & Scaling)

**Module 5 — Database Design & Scaling**

Module 5 এর ৯টা lesson শেষ — SQL বনাম NoSQL এর আসল trade-off, schema আর normalization, storage engine এর ভেতর, index, transaction আর isolation, connection pool আর N+1, replication, sharding, আর CAP/quorum। প্রতিটা lesson এ একটা করে সমস্যা আলাদাভাবে দেখেছি। বাস্তবে সমস্যাগুলো একা আসে না — একই দিনে, একে অপরের সাথে জড়িয়ে আসে। এই Exit Challenge ঠিক সেরকম একটা দিন।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow এর বছরের সবচেয়ে বড় launch এর সপ্তাহ। ২০ লাখ daily active user, peak এ primary database এ সেকেন্ডে ~২,৮০০ write। এই মুহূর্তে TaskFlow এর অবস্থা:
>
> - Express instance ৪টা থেকে autoscale হয়ে launch এর দিন ১২টা, প্রতিটায় Sequelize `pool: { max: 20 }`; Postgres এ `max_connections = 200`
> - একটা PostgreSQL primary আর একটা async read replica; গত মাসে Sequelize এর `replication` config চালু করা হয়েছে, তাই transaction এর বাইরের সব read replica তে যায়
> - `activity_log` table ২.৩ TB, partition করা না; প্রতি রাতে একটা job `DELETE FROM activity_log WHERE "createdAt" < now() - interval '1 year'` চালায়
> - Task assign করার code: `const task = await Task.findByPk(id, { transaction }); if (task.assigneeId === null) await task.update({ assigneeId }, { transaction });` — default isolation (READ COMMITTED)
> - `tasks` table এ index আছে `("projectId", status)` আর `("assigneeId")`
> - একটা enterprise customer একাই সব write এর ৪৫%
>
> **যা ঘটছে:**
>
> 1. Launch এর সকালে instance ১২টা হতেই error log ভরে গেল: `sorry, too many clients already`। যেসব request সফল হচ্ছে, সেগুলোও ধীর।
> 2. Workspace dashboard production এ ৪–৬ সেকেন্ড নিচ্ছে। Developer এর মেশিনে একই page ২০০ ms। Tracing দেখাচ্ছে একটা request এ ~১,৪০০টা SQL query।
> 3. Support এ দুই ধরনের ticket: (ক) "নতুন task তৈরি করলাম, 'Saved' দেখাল, কিন্তু list এ নেই"; (খ) "একই task এ আমাদের দুজনকে একসাথে assign করা দেখাচ্ছিল, তারপর একজনের নাম উধাও"।
> 4. "Overdue tasks" report — `WHERE date("dueAt") < current_date AND status <> 'done'` — প্রতিবার ৩০+ সেকেন্ড, আর চলার সময় বাকি query গুলোও ধীর হয়ে যায়।
> 5. রাতের cleanup job এখন ৫ ঘণ্টা চলে। সেই সময় replica এর lag ৪০ মিনিটে পৌঁছায়, আর table এর আকার কমছে না।
> 6. Team এর একজন প্রস্তাব দিল: "Write বাড়ছে, চলো এখনই `hash(taskId)` দিয়ে ৮টা shard এ ভাগ করি — ভাগ একদম সমান হবে।" আরেকজন বলল: "এসব ঝামেলা বাদ, পুরোটা MongoDB তে নিয়ে যাই — schemaless, আর NoSQL তো scale করে।"
> 7. Board সিঙ্গাপুরে দ্বিতীয় region অনুমোদন করেছে। CTO জানতে চান: দুই region এর link কাটলে কী হবে?

তোমার কাজ — নিচের প্রতিটা প্রশ্নে Module 5 (এবং প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নাও, reasoning সহ। যেখানে সম্ভব, **সংখ্যা** দিয়ে বলো।

**১. `too many clients` (Lesson 5.6)**
হিসাবটা দেখাও — কেন ১২টা instance এ এটা ঘটল? আর "সফল request ও ধীর" — এটা কি একই কারণে, নাকি আলাদা? তোমার সমাধানে প্রতি instance এর pool max কত, আর কেন সংখ্যাটা বাড়ানো না কমানো — database এর core সংখ্যার সাথে মিলিয়ে বলো। কোন অবস্থায় PgBouncer লাগবে, আর তার কোন সীমাবদ্ধতা মাথায় রাখবে?

**২. ১,৪০০ query এর dashboard (Lesson 5.6)**
কী ধরনের সমস্যা, আর কেন developer এর মেশিনে এটা লুকিয়ে ছিল — সংখ্যা দিয়ে ব্যাখ্যা করো (প্রতি round trip ১ ms ধরে)। ঠিক করার সময় কোন ফাঁদে পড়তে পারো যদি সব কিছু একটা বড় `include` এ ঢুকিয়ে দাও? আর ভবিষ্যতে এটা যেন আবার না ঢোকে — কী প্রক্রিয়া বসাবে?

**৩. দুই ধরনের ticket (Lesson 5.7 + 5.5)**
(ক) আর (খ) — দুটো আলাদা bug, আলাদা কারণ। প্রতিটার নাম বলো (কোন anomaly বা consistency guarantee ভাঙছে), ঠিক কীভাবে ঘটছে, আর সমাধান। (খ) এর জন্য অন্তত দুটো সমাধান দাও, আর বলো কোনটা বাছবে। মনে রাখো: task assign এর code **transaction এর ভেতরেই** আছে — তবু কেন কাজ করছে না?

**৪. ৩০ সেকেন্ডের report (Lesson 5.4 + 5.7)**
Index থাকা সত্ত্বেও কেন এত ধীর — অন্তত দুটো কারণ খোঁজো (query টা আর index টা দুটোই ভালো করে দেখো)। Query কীভাবে আবার লিখবে, আর কোন index দেবে? আর "চলার সময় বাকিরাও ধীর" — এই report আদৌ primary তে চলা উচিত কিনা?

**৫. রাতের cleanup আর replica lag (Lesson 5.8 + 5.3 + 5.7)**
তিনটা লক্ষণ — ৫ ঘণ্টা, ৪০ মিনিটের lag, আকার না কমা — প্রতিটা কেন হচ্ছে, WAL আর MVCC দিয়ে ব্যাখ্যা করো। তোমার সমাধান কী, আর ২.৩ TB এর একটা **চালু** table কে সেই সমাধানে নিয়ে যাওয়ার পথ কী? আর replica এর ৪০ মিনিটের lag এর সময় সমস্যা ৩ (ক) এর কী হয়?

**৬. Sharding আর MongoDB এর প্রস্তাব (Lesson 5.8 + 5.1)**
দুটো প্রস্তাবের জবাব দাও, সংখ্যা দিয়ে। `hash(taskId)` এর সমস্যা কী — কোন কোন query আর transaction ভাঙবে? যদি সত্যিই shard করতে হয়, কোন key দেবে, আর ৪৫% এর customer কে কীভাবে সামলাবে? আর shard করার আগে কী কী করবে? MongoDB এর প্রস্তাবের তিনটা দাবি ("schemaless", "migration লাগবে না", "scale করে") আলাদা করে যাচাই করো।

**৭. সিঙ্গাপুর আর CAP (Lesson 5.9)**
TaskFlow এর কমপক্ষে পাঁচ ধরনের data এর জন্য বলো: link কাটলে CP নাকি AP, আর স্বাভাবিক দিনে latency নাকি consistency (PACELC)। তারপর CTO কে তিন লাইনে উত্তর দাও। আর multi-leader করলে (দুই region এই task লেখা যায়) কোন conflict হবে, আর কেন last-write-wins এর উপর ভরসা করবে না?

**৮. পুরো পরিকল্পনা এক পাতায় (Lesson 5.1–5.9)**
উপরের সব মিলিয়ে একটা **অগ্রাধিকার তালিকা** বানাও: launch এর দিন আজই কী করবে (ঘণ্টার মধ্যে), এই সপ্তাহে কী, আর এই quarter এ কী। প্রতিটার পাশে এক লাইনে: কোন lesson, আর সাফল্য কীভাবে মাপবে (কোন metric)।

**মনে রাখার কথা:** এই module এর তিনটা জায়গায় সবচেয়ে সহজে ভুল হয় — (ক) "transaction দিলেই নিরাপদ" ভাবা, (খ) "বড় pool = দ্রুত" ভাবা, (গ) সংখ্যা ছাড়া sharding বা database বদলের সিদ্ধান্ত নেওয়া। আজকের scenario তে তিনটাই লুকিয়ে আছে। আর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস, Module 4 থেকে বয়ে আনা: **প্রতিকার বসানোর আগে রোগনির্ণয়** — প্রতিটা লক্ষণের জন্য আগে বলো কীভাবে নিশ্চিত হবে কারণটা আসলে কী (কোন metric, কোন `EXPLAIN`, কোন log)।

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

- [ ] "SQL vs NoSQL" এর আসল চারটা অক্ষ (data model, schema কোথায়, query flexibility, guarantee) বলতে পারি, আর "NoSQL scale করে" দাবিটা সংখ্যা দিয়ে যাচাই করতে পারি
- [ ] Schema-on-write আর schema-on-read এর পার্থক্য জানি — আর কেন "schemaless" মানে migration উধাও না, জায়গা বদল
- [ ] Update, insert, delete anomaly চিনি, আর 1NF/2NF/3NF দিয়ে ঠিক করতে পারি; snapshot (কেনার মুহূর্তের দাম) আর denormalization এর পার্থক্য জানি
- [ ] Denormalize করার **আগে** query ঠিক করি (LATERAL এর উদাহরণ), আর denormalized counter কে atomic update + reconciliation job দিয়ে ঠিক রাখতে পারি
- [ ] Page, B-tree আর WAL কীভাবে কাজ করে বলতে পারি — কেন ৪ লাখ row এ ৪টা page পড়লেই চলে, আর crash এর পর committed data কীভাবে ফেরে
- [ ] B-tree আর LSM-tree এর trade-off (write, read, space amplification) বলতে পারি, আর "B-tree read এর, LSM write এর" যে একটা সাধারণ নিয়ম, আইন না — জানি
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` পড়তে পারি — Seq Scan, Index Scan, Bitmap, Index Only Scan, Sort, আর `pages` কেন প্রায়ই সময়ের চেয়ে সৎ
- [ ] Composite index এ column এর ক্রম (= আগে, range/ORDER BY পরে), leftmost prefix, function/cast এর ফাঁদ, selectivity, আর partial/expression/covering index — উদাহরণসহ বলতে পারি
- [ ] প্রতিটা index এর লেখার দাম (সময় আর WAL) জানি, আর index বানাই **query থেকে**, column থেকে না
- [ ] পাঁচটা anomaly (dirty read, non-repeatable, phantom, lost update, write skew) চিনি, আর Postgres এর কোন isolation level কোনটা আটকায় — নিজের চোখে দেখেছি
- [ ] "Transaction একা race আটকায় না" — কেন, বুঝি; আর atomic update, `FOR UPDATE`, optimistic locking, SERIALIZABLE + retry এর মধ্যে সঠিকটা বেছে নিতে পারি
- [ ] Retry মানে পুরো transaction, শুধু retryable error এ, backoff + jitter সহ; আর retry এর সাথে side effect (email) কেন বিপজ্জনক — জানি
- [ ] Pool size কেন "যত বড় তত ভালো" না — core সংখ্যা আর Little's Law দিয়ে ব্যাখ্যা করতে পারি; `instances × pool max ≤ max_connections` হিসাব করতে পারি
- [ ] N+1 চিনি আর ঠিক করতে পারি (`include`, batching), আর দুটো hasMany একসাথে join করলে cartesian explosion কেন হয় — জানি
- [ ] Replication lag থেকে read-your-writes bug কীভাবে হয়, আর তিনটা সমাধানের (useMaster, LSN token, sync commit) দাম কোথায় পড়ে — মেপে দেখেছি
- [ ] Async বনাম sync replication, failover এর ধাপ, RPO/RTO, আর sync commit এ timeout মানে rollback না — বলতে পারি
- [ ] Partitioning আর sharding এর পার্থক্য জানি; partitioning কখন কাজে আসে (retention) আর কখন না (index এর বিকল্প হিসেবে)
- [ ] Shard key বাছার চারটা নিয়ম জানি, hot partition চিনি, আর shard পেরোলে কী ভাঙে (scatter-gather, transaction, unique ID) — বলতে পারি; আর shard করার আগে কী কী চেষ্টা করতে হয়
- [ ] CAP সঠিকভাবে বলতে পারি ("তিনটার দুটো" না), CAP এর C = linearizability, আর PACELC দিয়ে প্রতিদিনের latency বনাম consistency এর বাছাই ব্যাখ্যা করতে পারি
- [ ] `R + W > N` কেন stale read আটকায় — যুক্তি আর মাপা ফল দুটো দিয়ে; আর একটা system এর **প্রতিটা data** এর জন্য আলাদা CAP বাছাই করতে পারি

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Martin Kleppmann — _Designing Data-Intensive Applications_ (O'Reilly)।** এই module এর সবচেয়ে কাছের বই — প্রায় প্রতিটা lesson এর গভীর রূপ এখানে আছে। শুরু করো chapter 3 (storage আর retrieval — Lesson 5.3), chapter 5 (replication — 5.7), chapter 6 (partitioning — 5.8) আর chapter 7 (transactions — 5.5) দিয়ে। Chapter 9 (consistency আর consensus) Module 6 এর আগে পড়লে সবচেয়ে কাজে লাগবে।
- **Markus Winand — _Use The Index, Luke!_ (use-the-index-luke.com, বিনামূল্যে)।** Lesson 5.4 এর পূর্ণ রূপ — composite index, function এর ফাঁদ, pagination — database নিরপেক্ষভাবে, খুব পরিষ্কার উদাহরণ সহ।
- **PostgreSQL এর official documentation** — চারটা পাতা: "Transaction Isolation" (5.5 এর table এর উৎস), "Explicit Locking", "Using EXPLAIN" (5.4), আর "Table Partitioning" (5.8)। Postgres এর documentation অস্বাভাবিক রকম ভালো লেখা — নিজের database এর আচরণ নিয়ে কোনো সন্দেহ হলে প্রথম জায়গা এটাই।

**দেখার জন্য:**

- **Carnegie Mellon University Database Group এর lecture (YouTube)** — Andy Pavlo এর "Intro to Database Systems" course। Storage, index, concurrency control, আর recovery — আজকের lesson গুলোর ভেতরের যন্ত্রপাতি, একজন database researcher এর চোখে।
- **Jepsen (jepsen.io) এর analysis গুলো** — বিভিন্ন distributed database এর consistency দাবি আসলে সত্যি কিনা, হাতে-কলমে পরীক্ষা। Lesson 5.9 এর পরে পড়লে দেখবে "CA", "strongly consistent" জাতীয় দাবি বাস্তবে কতবার ভাঙে — আর কীভাবে ধরা পড়ে।

**Project এর জন্য:**

- Lesson 5.5 এর exercise এ ফিরে গিয়ে TaskFlow এর **task assign** এর race টা নিজে বানাও: `assigneeId IS NULL` যাচাই করে assign করা, ২০ জন একসাথে। প্রথমে naive (দেখো কয়জন "সফল" হয়), তারপর শর্তসহ atomic update দিয়ে ঠিক করো (`UPDATE ... WHERE id = ? AND "assigneeId" IS NULL`, affected row গুনে) — ঠিক ১ জন সফল হওয়া পর্যন্ত।
- Lesson 5.7 এর cluster এ Sequelize এর replication config রেখেই একটা ছোট Express middleware লেখো: যে user গত ১০ সেকেন্ডে কিছু লিখেছে (একটা cookie তে সময় রেখে), তার read গুলো `useMaster: true` দিয়ে যাক। তারপর `npm run lag` এর মতো মেপে দেখাও — stale read শূন্য, অথচ বেশিরভাগ read এখনো replica তে।
- আরও এক ধাপ এগোতে চাইলে: Lesson 5.8 এর `activity` partitioned table এ একটা **চালু** table কে partitioned এ নিয়ে যাওয়ার পথ চেষ্টা করো — নতুন partitioned table বানিয়ে, পুরনো table কে একটা partition হিসেবে `ATTACH` করে। এটা challenge এর প্রশ্ন ৫ এর সরাসরি অনুশীলন।

---

Exit challenge টা করে পাঠাও। রেডি হলে `next` লিখলে আমরা **Module 6: Distributed Systems Core** এ যাব — Lesson 6.1 দিয়ে শুরু: distributed system এ কী কী ভাঙে, network partition আর split brain।

Module 5 জুড়ে আমরা database কে কয়েকটা machine এ ছড়িয়ে দিয়েছি — replica, shard, দ্বিতীয় region। আর প্রতিবার একটা প্রশ্ন সামনে এসে থেমে গেছে: "অন্য machine টা মৃত, নাকি শুধু ধীর?", "কে leader হবে?", "দুটো ঘটনার কোনটা আগে?"। Module 6 এ ঠিক সেই প্রশ্নগুলোর মুখোমুখি হব — কেন এগুলো এত কঠিন, আর distributed system গুলো তবু কীভাবে কাজ করে।
