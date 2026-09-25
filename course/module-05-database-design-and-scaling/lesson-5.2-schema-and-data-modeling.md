# Lesson 5.2 — Schema & Data Modeling: Normalization আর ইচ্ছাকৃত Denormalization

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 4.3):** Cache invalidation কেন কঠিন বলা হয়? আর invalidation এর code যদি কোথাও ভুলে যাওয়া হয়, তখন TTL কী ভূমিকা রাখে?

**Prerequisite:** Lesson 5.1 (SQL vs NoSQL), Lesson 4.3 (Invalidation, TTL)

**তুমি এই lesson শেষে পারবে:**

1. একটা খারাপ schema দেখে তার update, insert আর delete anomaly ধরতে পারবে, আর 1NF, 2NF, 3NF এর নিয়ম দিয়ে সেটা ঠিক করতে পারবে
2. Sequelize এ 1:N আর M:N সম্পর্ক (junction table সহ) typed ভাবে model করতে পারবে
3. কখন ইচ্ছা করে denormalize করা উচিত সেটা **মেপে** ঠিক করবে, আর denormalized data কে ঠিক রাখার দাম (atomic update, reconciliation) বুঝবে

**Tier:** 1 — Runnable Code

---

## ০. TaskFlow এখন কোথায়

Lesson 5.1 এর সিদ্ধান্ত: TaskFlow Postgres এই থাকছে। কিন্তু Postgres এ থাকা মানেই data **ভালো ভাবে সাজানো** — এমন না।

TaskFlow এর একেবারে প্রথম version একটা hackathon এ দুই দিনে বানানো হয়েছিল। তখন সব কিছু একটা table এ রাখা হয়েছিল — "পরে ঠিক করব"। সেই "পরে" এখন এসে গেছে, support এ তিনটা অদ্ভুত অভিযোগ নিয়ে:

1. রহিম profile এ নিজের নাম "Rahim" থেকে "Rahim Uddin" করেছে। কিন্তু কিছু task এ নতুন নাম দেখায়, কিছুতে এখনো পুরনোটা।
2. "bug" tag দিয়ে filter করলে এমন task ও আসছে যেটার tag আসলে "debug"।
3. Marketing team তাদের project এর শেষ task টা মুছে দিয়েছে — আর পুরো project টাই list থেকে উধাও।

আর একই সময়ে product team এর একটা নতুন চাওয়া: dashboard এ **"সবচেয়ে ব্যস্ত ১০টা project"** (সবচেয়ে বেশি খোলা task যাদের)। TaskFlow এ এখন প্রায় ৪ লাখ task, আর query টা প্রতিবার সব task গুনছে।

আজকের lesson দুই ভাগে: প্রথমে **normalization** দিয়ে প্রথম তিনটা সমস্যা ঠিক করব। তারপর dashboard এর জন্য **ইচ্ছা করে normalization ভাঙব** — আর দেখব সেই ভাঙার দাম কত।

---

## ১. Theory

### ১.১ Data Modeling এর ভাষা — Entity, Relationship, Cardinality

Data modeling মানে ঠিক করা: system এ কোন কোন "জিনিস" (entity) আছে, প্রতিটার কী কী তথ্য, আর তারা একে অপরের সাথে কীভাবে যুক্ত।

**Cardinality** — দুটো entity এর মধ্যে সম্পর্কে একদিকের কতগুলো অন্যদিকের কতগুলোর সাথে যুক্ত হতে পারে। তিন ধরনের:

```
1 : 1     User ──────── Profile        একজন user এর একটাই profile
1 : N     Project ────< Task           একটা project এ অনেক task, প্রতিটা task একটাই project এ
M : N     Task >──────< Tag            একটা task এ অনেক tag, একটা tag অনেক task এ
```

তুমি Sequelize এ প্রতিদিন এগুলো লেখো, হয়তো এই নামে ভাবোনি:

| Cardinality | Sequelize                                 | Database এ আসলে কী থাকে                           |
| ----------- | ----------------------------------------- | ------------------------------------------------- |
| 1 : 1       | `hasOne` + `belongsTo`                    | একদিকে একটা foreign key (unique)                  |
| 1 : N       | `hasMany` + `belongsTo`                   | "N" দিকের table এ foreign key (`tasks.projectId`) |
| M : N       | `belongsToMany` (দুই দিক থেকে, `through`) | একটা তৃতীয় table — **junction table**            |

**Junction table** — M:N সম্পর্ক রাখার জন্য আলাদা একটা table, যার প্রতিটা row একটা জোড়া (`taskId`, `tagId`)। Relational database এ M:N সরাসরি রাখার আর কোনো ভালো উপায় নেই — কেন, সেটা ১.৩ এ পরিষ্কার হবে।

**একটা সাধারণ ফাঁদ:** Postgres foreign key column এ **নিজে থেকে index বানায় না**। `tasks.projectId` এ index না থাকলে "এই project এর সব task" বা JOIN — দুটোই পুরো table scan করতে পারে। তাই exercise এর model এ আমরা হাতে index দিয়েছি। বিস্তারিত Lesson 5.4 এ।

### ১.২ খারাপ Schema এর তিনটা রোগ — Anomaly

TaskFlow এর hackathon version এর table টা এমন ছিল:

```
bad_tasks
┌────┬───────────────────┬─────────────┬────────────────────┬──────────────┬────────────┐
│ id │ title             │ projectName │ assigneeEmail      │ assigneeName │ tags       │
├────┼───────────────────┼─────────────┼────────────────────┼──────────────┼────────────┤
│ 1  │ Login bug ঠিক করো │ Website     │ rahim@taskflow.app │ Rahim        │ bug,urgent │
│ 2  │ Logging যোগ করো   │ Website     │ rahim@taskflow.app │ Rahim        │ debug      │
│ 3  │ Q3 campaign plan  │ Marketing   │ karim@taskflow.app │ Karim        │ planning   │
└────┴───────────────────┴─────────────┴────────────────────┴──────────────┴────────────┘
```

প্রথম দিনে এটা দারুণ সহজ — একটা query তে সব পাওয়া যায়, কোনো JOIN নেই। সমস্যা হলো **একই তথ্য একাধিক জায়গায়** আছে (রহিমের নাম দুই row এ, "Website" দুই row এ), আর **একটা তথ্য অন্য তথ্যের উপর ভর করে বেঁচে আছে** (Marketing project এর অস্তিত্ব একটা task এর উপর)।

**Data anomaly** — schema এর গঠনের কারণে data insert, update বা delete করতে গিয়ে ভুল বা অসামঞ্জস্যপূর্ণ data তৈরি হওয়া। তিন ধরনের:

- **Update anomaly:** একটা তথ্য বদলাতে গিয়ে সব কপি বদলানো হলো না। রহিমের নাম বদলানোর code শুধু যে task এ edit হচ্ছিল সেটা update করেছে — এখন একই email এর **দুটো নাম**।
- **Delete anomaly:** একটা জিনিস মুছতে গিয়ে অন্য একটা জিনিসের তথ্য হারিয়ে গেল। Marketing এর শেষ task মুছলে Marketing project টাই হারিয়ে যায়, কারণ project এর আলাদা কোনো row নেই।
- **Insert anomaly:** একটা জিনিস রাখতে গেলে অন্য একটা জিনিস লাগে যেটা এখনো নেই। নতুন project বানাতে চাও, কিন্তু task ছাড়া project রাখার জায়গাই নেই — একটা নকল task বানাতে হবে।

আর `tags` column এর "bug,urgent" — এটা একটা আলাদা রোগ, পরের section এ।

Exercise এর `npm run anomalies` ঠিক এই তিনটা কাজ করে দেখায়, দুই schema তে পাশাপাশি:

```
━━ Denormalized (bad_tasks) — সব এক table এ
১. rahim@taskflow.app এর নাম কয়টা?    2 টা → "Rahim", "Rahim Uddin"
২. "bug" tag এর task কয়টা?           2 টা → "Logging যোগ করো", "Login bug ঠিক করো"
৩. Task মোছার পর project কয়টা?       1 টা → Website  (Marketing উধাও!)

━━ Normalized (users / projects / tasks / tags)
১. rahim@taskflow.app এর নাম কয়টা?    1 টা → "Rahim Uddin"
২. "bug" tag এর task কয়টা?           1 টা → "Login bug ঠিক করো"
৩. Task মোছার পর project কয়টা?       2 টা → Marketing, Website
```

সবচেয়ে ভয়ের কথা: প্রথম তিনটা লাইনের **কোনোটাতেই কোনো error আসেনি।** Database খুশি মনে ভুল data রেখে দিয়েছে। Anomaly production এ crash করে না — চুপচাপ data নষ্ট করে, আর ধরা পড়ে মাসখানেক পরে, একজন বিরক্ত user এর support ticket এ।

### ১.৩ Normalization — 1NF, 2NF, 3NF

**Normalization** — table গুলোকে এমনভাবে ভাগ করা যাতে প্রতিটা তথ্য **ঠিক এক জায়গায়** থাকে, আর anomaly এর সুযোগ না থাকে।

**Normal form** — normalization এর ধাপ। প্রতিটা ধাপ একটা নির্দিষ্ট ধরনের redundancy সরায়। বাস্তবে তিনটা জানলেই যথেষ্ট:

**1NF — প্রতিটা cell এ একটা মান।** `tags = "bug,urgent"` 1NF ভাঙে। একটা cell এ list রাখলে database সেটার ভেতরে দেখতে পারে না — তাই খুঁজতে হয় `LIKE '%bug%'` দিয়ে, যেটা "debug" ও ধরে ফেলে। Index ও কাজে লাগে না, আর একটা tag এর নাম বদলাতে হলে প্রতিটা string খুঁজে খুঁজে বদলাতে হয়।

সমাধান: tag আলাদা table এ, আর task-tag এর জোড়া একটা junction table এ। এটাই সেই M:N:

```
tasks                task_tags               tags
┌────┬───────┐       ┌────────┬───────┐      ┌────┬──────────┐
│ id │ title │       │ taskId │ tagId │      │ id │ name     │
├────┼───────┤       ├────────┼───────┤      ├────┼──────────┤
│ 1  │ Login │◄──────│ 1      │ 1     │─────►│ 1  │ bug      │
│ 2  │ Log…  │◄──┐   │ 1      │ 2     │─┐    │ 2  │ urgent   │
└────┴───────┘   └───│ 2      │ 3     │ └───►│ 3  │ debug    │
                     └────────┴───────┘      └────┴──────────┘
                     primary key = (taskId, tagId)
```

**2NF — composite key এর পুরোটার উপর নির্ভর করো, অংশের উপর না।** ধরো কেউ `task_tags` এ সুবিধার জন্য `tagName` column যোগ করল: `(taskId, tagId, tagName)`। এখন `tagName` নির্ভর করে শুধু `tagId` এর উপর — key এর **অর্ধেকের** উপর। ফল? "urgent" tag ১০০০টা task এ থাকলে নামটা ১০০০ বার কপি — সেই পুরনো update anomaly ফিরে এলো।

**3NF — key ছাড়া অন্য কিছুর উপর নির্ভর কোরো না।** `tasks` এ `assigneeId` আর `assigneeEmail` দুটোই রাখলে, `assigneeEmail` আসলে task এর তথ্য না — এটা **user** এর তথ্য, যেটা `assigneeId` এর মাধ্যমে task এর সাথে যুক্ত। একে বলে transitive dependency (task → user → email)। সমাধান: email থাকবে শুধু `users` table এ।

মনে রাখার একটা পুরনো লাইন আছে — প্রতিটা column নির্ভর করবে:

> "**the key** (1NF), **the whole key** (2NF), and **nothing but the key** (3NF)"

**সৎ সতর্কতা:** 3NF এর পরেও normal form আছে — BCNF, 4NF, 5NF। Database theory তে এগুলো গুরুত্বপূর্ণ, কিন্তু সাধারণ product schema তে 3NF এ পৌঁছালে বাকিগুলোর সমস্যা প্রায় কখনো আসে না। Interview এ 3NF পর্যন্ত পরিষ্কার বলতে পারাই যথেষ্ট।

TaskFlow এর normalized schema Sequelize এ (exercise এর `src/models/good.ts` থেকে, association অংশ):

```typescript
Project.hasMany(Task, { foreignKey: { name: 'projectId', allowNull: false }, onDelete: 'CASCADE' });
Task.belongsTo(Project, { foreignKey: { name: 'projectId', allowNull: false } });

User.hasMany(Task, { foreignKey: 'assigneeId', onDelete: 'SET NULL' });
Task.belongsTo(User, { as: 'assignee', foreignKey: 'assigneeId' });

Task.belongsToMany(Tag, { through: TaskTag, foreignKey: 'taskId', otherKey: 'tagId' });
Tag.belongsToMany(Task, { through: TaskTag, foreignKey: 'tagId', otherKey: 'taskId' });
```

`onDelete` দুটো আলাদা কেন, এক লাইনে: project মুছলে তার task গুলোর থাকার কোনো মানে নেই (`CASCADE`), কিন্তু user চলে গেলে task গুলো থাকবে, শুধু unassigned হয়ে (`SET NULL`)। এটা **business সিদ্ধান্ত**, database সিদ্ধান্ত না।

**কিন্তু প্রতিটা কপি কি ভুল?** না — এই জায়গায় অনেকে গুলিয়ে ফেলে। একটা e-commerce order এ product এর দাম কপি করে রাখা normalization ভাঙা না। Order এর দাম হলো **কেনার মুহূর্তের দাম** — একটা ঐতিহাসিক সত্য। পরে product এর দাম বদলালে পুরনো order এর দাম বদলানো উচিতই না। এটাকে বলা হয় **snapshot**। প্রশ্নটা সবসময়: "এই কপি টা কি মূল তথ্যের সাথে **তাল মিলিয়ে বদলানোর কথা**?" হ্যাঁ হলে সেটা denormalization (আর sync রাখার দায়িত্ব তোমার)। না হলে সেটা snapshot, আর কপি করাটাই সঠিক।

### ১.৪ Denormalization — ইচ্ছা করে নিয়ম ভাঙা

Normalized schema তে প্রতিটা তথ্য এক জায়গায় — লেখা সহজ আর নিরাপদ। কিন্তু **পড়া** দামি হতে পারে, কারণ উত্তর বানাতে JOIN আর গোনা লাগে।

**Denormalization** — পড়া দ্রুত করার জন্য ইচ্ছা করে data কপি করা বা আগে থেকে হিসাব করে রাখা, জেনেশুনে যে সেটা sync রাখার দায়িত্ব এখন তোমার।

তিনটা সাধারণ রূপ:

- **Column কপি** — `tasks` এ `projectName` রাখা, যাতে task list এ JOIN না লাগে
- **আগে থেকে হিসাব করা মান (derived data)** — `projects.openTaskCount`, যাতে প্রতিবার `COUNT(*)` না লাগে
- **আগে থেকে বানানো view** — পুরো একটা report আগে থেকে হিসাব করে রাখা (Postgres এ materialized view, যেটা নির্দিষ্ট সময় পরপর refresh করতে হয়)

এবার TaskFlow এর dashboard। Exercise এর `npm run dashboard` ৫০০টা project আর ৪ লাখ task বানিয়ে একই প্রশ্ন কয়েকভাবে মাপে (আমার মেশিনে, ৩০ বারের median):

```
প্রশ্ন                          গুনে (সরল)   গুনে (LATERAL)   counter পড়ে
২০টা project এর পাতা             39.18 ms        1.78 ms         0.42 ms
সবচেয়ে ব্যস্ত ১০টা project        39.34 ms          —             0.31 ms
```

প্রথম লাইনটা মনোযোগ দিয়ে দেখো — এখানে এই lesson এর সবচেয়ে গুরুত্বপূর্ণ শিক্ষাটা লুকিয়ে আছে।

সরল query টা (`LEFT JOIN ... GROUP BY p.id ORDER BY p.name LIMIT 20`) ৩৯ ms নেয়। কারণ `EXPLAIN ANALYZE` দেখায়: `LIMIT 20` থাকলেও Postgres আগে **সব ৫০০ project** এর count বানায় (৪ লাখ task এর উপর Seq Scan + HashAggregate), তারপর ২০টা রাখে। Query টা একটু অন্যভাবে লিখলে — আগে ২০টা project বাছো, তারপর **শুধু তাদের** task গোনো (`LATERAL`) — সময় নেমে আসে **১.৭৮ ms এ, কোনো schema না বদলে**।

```sql
SELECT p.id, p.name, c.open
FROM (SELECT id, name FROM projects ORDER BY name LIMIT 20) p
CROSS JOIN LATERAL (
  SELECT count(*) AS open FROM tasks t
  WHERE t."projectId" = p.id AND t.status <> 'done'
) c
ORDER BY p.name;
```

(`LATERAL` মানে "বাম দিকের প্রতিটা row এর জন্য ডান দিকের subquery টা চালাও"। `(projectId, status)` index থাকায় প্রতিটা count শুধু index পড়েই হয়ে যায়।)

কিন্তু দ্বিতীয় লাইনে — "সবচেয়ে ব্যস্ত ১০টা" — এই কৌশল কাজ করে না। **কোন ১০টা সবচেয়ে ব্যস্ত, সেটা জানতে হলে আগে সবগুলো গুনতেই হবে।** কোনো query কৌশল দিয়ে এটা এড়ানো যায় না। এখানে `openTaskCount` column (তাতে index দিলে আরও ভালো) প্রায় ১০০ গুণ পার্থক্য আনে।

> **নিয়মটা:** Denormalize করার আগে query ঠিক করো। Denormalization এর আসল জায়গা তখন, যখন তুমি একটা **derived মান দিয়ে sort বা filter** করতে চাও, অথবা একটা মাপা, গরম read path এ query ঠিক করার পরেও সময় বেশি লাগছে।

**এটা আসলে কী, চিনতে পারছ?** `openTaskCount` হলো database এর **ভেতরে একটা cache** — source of truth (`tasks` table) এর একটা হিসাব করা কপি। আর Module 4 থেকে তুমি জানো cache এর সবচেয়ে কঠিন সমস্যা কী: **invalidation**। Denormalization এ ঠিক একই সমস্যা, শুধু নাম আলাদা।

### ১.৫ দাম — Counter কে ঠিক রাখা

Counter যোগ করার পর প্রতিটা write path কে তার কথা মনে রাখতে হবে। Exercise এর `npm run counter` একটা project এ **২০০টা task একসাথে** তৈরি করে, তিনভাবে:

```
ক. read-modify-write               counter =   1   আসল = 200   ✗ 199 টা হারিয়েছে
খ. transaction + increment         counter = 200   আসল = 200   ✓ ঠিক আছে
গ. খ এর পরে ৫০টা bulk import       counter = 200   আসল = 250   ✗ 50 টা হারিয়েছে
```

**(ক) এর code টা দেখতে একদম নিরীহ:**

```typescript
async function naive(projectId: number): Promise<void> {
	await Task.create({ title: 'naive', projectId, assigneeId: null });
	const project = await Project.findByPk(projectId);
	if (!project) throw new Error('project missing');
	project.openTaskCount = project.openTaskCount + 1;
	await project.save();
}
```

সমস্যা: "পড়ো → JS এ +1 করো → লেখো" তিনটা আলাদা ধাপ। দুটো request একই সময়ে counter ৪১ পড়লে দুজনেই ৪২ লেখে — একটা বৃদ্ধি হারিয়ে গেল। একে বলে **lost update**। Exercise এ ১৯৯টা হারানো চরম শোনায় — কারণ pool এর লাইনে ২০০টা `INSERT` আগে বসে, তাই সব `SELECT` চলে যখন counter তখনো ০। বাস্তব traffic এ এত বেশি হারাবে না, কিন্তু দুটো request এর মধ্যে কয়েক millisecond এর ফাঁকই যথেষ্ট। আর local এ একা test করলে এই bug **কখনো ধরা পড়ে না**।

**(খ) — ঠিক করা version:**

```typescript
async function atomic(projectId: number): Promise<void> {
	await sequelize.transaction(async (transaction) => {
		await Task.create({ title: 'atomic', projectId, assigneeId: null }, { transaction });
		await Project.increment('openTaskCount', { by: 1, where: { id: projectId }, transaction });
	});
}
```

দুটো আলাদা জিনিস এখানে কাজ করছে:

- `Project.increment` বানায় `UPDATE projects SET "openTaskCount" = "openTaskCount" + 1 WHERE id = ...` — হিসাবটা **database নিজে** করে, row টা lock রেখে। কেউ কারো লেখা মুছে দিতে পারে না।
- `transaction` নিশ্চিত করে task তৈরি আর counter বাড়ানো — **হয় দুটোই হবে, নয়তো কোনোটাই না**। Task তৈরি হয়ে counter বাড়ার আগে server crash করলে দুটোই বাতিল।

মনে রাখো — শুধু transaction দিলেই lost update আটকায় না। Transaction এর ভেতরে (ক) এর মতো read-modify-write লিখলে কী হয়, আর কেন — সেটা exercise এর experiment ৩, আর তার পূর্ণ ব্যাখ্যা Lesson 5.5 (isolation level) এ।

**(গ) — সবচেয়ে সাধারণ বাস্তব ব্যর্থতা race না, ভুলে যাওয়া।** ছয় মাস পরে কেউ CSV import feature বানাল, `Task.bulkCreate` দিয়ে — counter এর কথা তার মাথাতেই আসেনি। কোনো error নেই, counter চুপচাপ ৫০ পিছিয়ে গেল।

এর প্রতিকার Module 4 এর TTL এর মতোই একটা **safety net** — **reconciliation job**: নির্দিষ্ট সময় পরপর (যেমন প্রতি রাতে) derived data কে source of truth থেকে নতুন করে হিসাব করে, আর গরমিল পেলে ঠিক করে দেয় (এবং গরমিলের সংখ্যাটা log/alert করে — ওটাই তোমাকে বলবে কোথাও একটা write path counter ভুলে গেছে)। Exercise এ:

```
reconcile() চালানো হলো — 2 টা project এর counter ভুল ছিল, ঠিক করা হয়েছে
```

**Counter sync রাখার তিনটা উপায়, trade-off সহ:**

| উপায়                                     | ভালো দিক                                      | দাম                                                                                               |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| App code এ, একই transaction এ (খ)         | স্পষ্ট, code পড়লেই বোঝা যায়                 | প্রতিটা write path কে মনে রাখতে হয় (গ)                                                           |
| Database trigger                          | কোনো path ভুলে যাওয়া অসম্ভব, bulk import ও   | Logic লুকানো থাকে DB তে — app code পড়ে বোঝা যায় না; debug আর test কঠিন                          |
| Async — queue দিয়ে পরে update (Module 7) | Write দ্রুত, counter এর চাপ মূল request এ নেই | Counter কিছুক্ষণ পিছিয়ে থাকে (eventual) — dashboard এর জন্য প্রায়ই চলে, টাকা-পয়সার জন্য চলে না |

আর যেটাই বাছো — **reconciliation job রাখো**।

একটা লুকানো দামও আছে: প্রতিটা increment ওই project এর **একটাই row** lock করে। একটা বিশাল project এ ৩০ জন একসাথে task তৈরি করলে, সবাই ওই এক row এর জন্য লাইনে দাঁড়ায়। একে বলে hot row — Lesson 4.6 এর hot key এর database version। এর সমাধান (counter কে কয়েক টুকরোয় ভাগ করা, বা Redis এ গুনে পরে DB তে লেখা) পরের lesson গুলোর বিষয়।

> **Trade-off Table — Normalized vs Denormalized**

| দিক                       | Normalized                             | Denormalized                                        |
| ------------------------- | -------------------------------------- | --------------------------------------------------- |
| লেখা                      | সহজ, এক জায়গায়                       | প্রতিটা কপি/counter ও update করতে হয়               |
| পড়া                      | JOIN/COUNT লাগে — সাধারণত যথেষ্ট দ্রুত | খুব দ্রুত, বিশেষ করে derived মান দিয়ে sort/filter  |
| Correctness               | Schema নিজেই রক্ষা করে                 | তোমার code আর reconciliation job রক্ষা করে          |
| নতুন প্রশ্ন (flexibility) | যেকোনো JOIN লেখা যায়                  | নতুন প্রশ্নের জন্য হয়তো নতুন কপি লাগবে             |
| ভুল হলে                   | Anomaly — schema ঠিক করলে বন্ধ         | Drift — চুপচাপ, reconciliation না থাকলে ধরা পড়ে না |

### ১.৬ সিদ্ধান্তের নিয়ম

```
১. শুরু করো normalized (3NF) দিয়ে           ── এটাই default
২. একটা read path ধীর?  → আগে মাপো          ── EXPLAIN ANALYZE, অনুমান না
৩. Query/index ঠিক করা যায়?  → সেটা আগে     ── LATERAL, index (Lesson 5.4)
৪. তারপরও ধীর, বা derived মান দিয়ে sort?   ── এবার denormalize — একটা নির্দিষ্ট জিনিস
৫. Denormalize করলে সাথে লিখে রাখো:        ── কোন কোন write path এটা বদলায়,
                                               কীভাবে sync থাকবে, reconciliation কোথায়
```

আর বিকল্পটাও মাথায় রেখো: কখনো কখনো denormalization database এ না করে **cache এ** (Module 4) করাই ভালো — Redis এ counter বা হিসাব করা result, TTL সহ। তখন source of truth থাকে পরিষ্কার normalized, আর "গতি" থাকে cache layer এ, যেটা মুছে ফেললেও কিছু হারায় না।

---

## ২. Interview Angle

**"X এর জন্য একটা database schema design করো"** — system design interview এর খুব সাধারণ একটা অংশ। ভালো উত্তরের ধাপ:

1. **Entity আর সম্পর্ক আগে বলো:** "User, Project, Task, Tag — Project আর Task 1:N, Task আর Tag M:N, তাই একটা junction table"
2. **Normalized দিয়ে শুরু করো** — table আর key এঁকে
3. **তারপর গরম read path খোঁজো:** "Feed এ প্রতিবার like count দেখাতে হয়, read:write অনুপাত অনেক বেশি — তাই `likeCount` denormalize করব"
4. **দামটা নিজে থেকে বলো:** "Like হলে atomic increment, একই transaction এ; আর একটা reconciliation job" — interviewer এটা জিজ্ঞেস করার আগেই বললে বোঝা যায় তুমি production এ এটা দেখেছ

**Common follow-up গুলো:**

- _"একটা post এ হঠাৎ লাখ লাখ like আসলে `likeCount` row এর কী হবে?"_ — Hot row: সব increment একটা row এর lock এর জন্য লাইনে। সমাধান: counter কে কয়েক টুকরোয় ভাগ করে রাখা (পড়ার সময় যোগ), অথবা Redis এ `INCR` করে কয়েক সেকেন্ড পরপর DB তে লেখা — দুটোতেই counter একটু পিছিয়ে থাকতে পারে
- _"Order table এ product এর দাম কপি করা কি denormalization?"_ — না, ওটা snapshot (১.৩)
- _"3NF কী?"_ — "the key, the whole key, and nothing but the key", প্রতিটার একটা করে উদাহরণ সহ

**Production এ বাস্তবে:** বেশিরভাগ schema শুরু হয় normalized, আর সময়ের সাথে হাতে গোনা কয়েকটা counter বা কপি column যোগ হয় — প্রতিটা একটা মাপা সমস্যার কারণে। উল্টোটা — "প্রথম দিন থেকে সব denormalized, পরে দেখা যাবে" — প্রায় সবসময় anomaly এর জঙ্গলে শেষ হয়, ঠিক TaskFlow এর hackathon version এর মতো।

---

## ৩. Key Takeaway

- Cardinality তিন ধরনের — 1:1, 1:N, M:N; M:N রাখতে junction table লাগে; Postgres foreign key এ নিজে index বানায় না
- একই তথ্য একাধিক জায়গায় থাকলে update, insert আর delete anomaly জন্মায় — আর এগুলো কোনো error দেয় না, চুপচাপ data নষ্ট করে
- 1NF (এক cell এ এক মান), 2NF (পুরো key), 3NF (key ছাড়া কিছু না) — "the key, the whole key, and nothing but the key"
- প্রতিটা কপি denormalization না — কেনার মুহূর্তের দাম একটা **snapshot**, সেটা কপি করাই সঠিক
- **Denormalize করার আগে query ঠিক করো** — exercise এ শুধু LATERAL দিয়ে ৩৯ ms থেকে ১.৭৮ ms; denormalization এর আসল জায়গা derived মান দিয়ে sort/filter
- Denormalized data আসলে database এর ভেতরে একটা cache — তাই একই invalidation সমস্যা
- Counter ঠিক রাখতে: atomic update একই transaction এ, আর সবসময় একটা **reconciliation job** — কারণ কেউ না কেউ একদিন একটা write path এ counter ভুলবেই

---

## ৪. নতুন Term (Glossary)

| Term                   | অর্থ                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| **Cardinality**        | দুটো entity এর সম্পর্কে একদিকের কতগুলো অন্যদিকের কতগুলোর সাথে যুক্ত হয় — 1:1, 1:N, M:N         |
| **Junction Table**     | M:N সম্পর্ক রাখার আলাদা table, যার প্রতিটা row দুই দিকের একটা জোড়া (যেমন `taskId`, `tagId`)    |
| **Data Anomaly**       | Schema এর গঠনের কারণে insert, update বা delete এ ভুল/অসামঞ্জস্যপূর্ণ data তৈরি হওয়া            |
| **Normalization**      | Table ভাগ করে প্রতিটা তথ্য ঠিক এক জায়গায় রাখা, যাতে anomaly এর সুযোগ না থাকে                  |
| **Normal Form**        | Normalization এর ধাপ (1NF, 2NF, 3NF…) — প্রতিটা একটা নির্দিষ্ট ধরনের redundancy সরায়           |
| **Denormalization**    | পড়া দ্রুত করতে ইচ্ছা করে data কপি বা আগে থেকে হিসাব করে রাখা — sync রাখার দায়িত্ব তোমার       |
| **Reconciliation Job** | নির্দিষ্ট সময় পরপর derived data কে source of truth থেকে নতুন করে হিসাব করে গরমিল ধরা ও ঠিক করা |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এ একটা activity log আছে: "রহিম task #42 কে Done এ সরিয়েছে"। প্রতিটা log row এ কি `actorId` (user এর id) রাখবে, নাকি `actorName` (নামটা কপি করে)? রহিম পরে নাম বদলালে দুই ক্ষেত্রে কী দেখাবে? কোনটা "সঠিক" — আর এটা কি technical প্রশ্ন, নাকি অন্য কিছু?
2. `openTaskCount` sync রাখতে একজন senior বলল: "App code এ না, database trigger দিয়ে করো — তাহলে কেউ কখনো ভুলতে পারবে না।" এই যুক্তির শক্তি কী, আর এতে কী হারাচ্ছ? Trigger থাকলেও কি reconciliation job লাগবে?
3. ধরো একটা বিশাল enterprise project এ ৫০,০০০ task, আর সকাল ৯টায় ৪০ জন একসাথে task তৈরি করছে। (খ) এর atomic increment ঠিকঠাক কাজ করছে, counter ভুল হচ্ছে না — তবু একটা নতুন সমস্যা দেখা দিতে পারে। সেটা কী, আর কেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** দুটোই বৈধ, কারণ প্রশ্নটা আসলে **product এর**: log এ কি "তখন কে ছিল" দেখাতে চাই, নাকি "এখন সে কে"?

- `actorId` রাখলে: log দেখানোর সময় JOIN করে **বর্তমান** নাম — "Rahim Uddin task #42 কে Done এ সরিয়েছে"। Normalized, কিন্তু ইতিহাস বদলে যায়।
- `actorName` কপি করলে: **ঘটনার মুহূর্তের** নাম — "Rahim task #42 কে Done এ সরিয়েছে"। এটা snapshot, update anomaly না — কারণ ইচ্ছাকৃতভাবেই এটা বদলানোর কথা না।

বাস্তবে অনেক system দুটোই রাখে: `actorId` (সম্পর্ক আর filter এর জন্য) + `actorName` snapshot (audit এর জন্য)। Audit/compliance log এ সাধারণত snapshot জরুরি — ইতিহাস পরে বদলে যাওয়া উচিত না। মূল শিক্ষা: "কপি করা ভুল কিনা" এর উত্তর আসে **তথ্যটা বদলানোর কথা কিনা** থেকে।

**প্রশ্ন ২:** শক্তি: trigger database এর ভেতরে, তাই যেকোনো পথে task ঢুকুক — app code, bulk import, এমনকি কেউ হাতে `psql` এ `INSERT` চালালেও — counter বদলাবে। (গ) এর ধরনের ব্যর্থতা প্রায় অসম্ভব। হারাচ্ছ: logic টা app code পড়ে দেখা যায় না — নতুন developer বুঝবে না কেন একটা `INSERT` ধীর বা কেন একটা row lock হচ্ছে; test আর debug কঠিন; migration এ trigger এর code version করতে হয়। আর hot row সমস্যা (প্রশ্ন ৩) trigger এও একই থাকে। Reconciliation job তবু রাখা উচিত — কেউ trigger সাময়িক বন্ধ করে bulk load করতে পারে, trigger এর নিজের logic এ bug থাকতে পারে (যেমন `status` বদলানোর case ভুলে যাওয়া), বা restore এর পরে data গরমিল হতে পারে। Safety net সস্তা, তার অভাব দামি।

**প্রশ্ন ৩:** **Hot row lock contention।** প্রতিটা atomic increment ওই project এর row টা transaction শেষ হওয়া পর্যন্ত lock রাখে। ৪০ জন একসাথে লিখলে তারা ওই একটা row এর জন্য লাইনে দাঁড়ায় — প্রতিটা task তৈরি এখন আগের জনের transaction শেষ হওয়ার অপেক্ষা করে। Counter সঠিক, কিন্তু write latency বাড়ে, আর transaction লম্বা হলে (যেমন ভেতরে ধীর কোনো কাজ থাকলে) সমস্যা আরও বড় হয়। এটা Lesson 4.6 এর hot key এর database version। প্রতিকার: transaction ছোট রাখা (increment একদম শেষে), counter কে কয়েক টুকরোয় ভাগ করা (পড়ার সময় যোগফল), অথবা counter টা async করে দেওয়া (Module 7) — যেটায় counter কয়েক সেকেন্ড পিছিয়ে থাকবে, যেটা dashboard এর জন্য সাধারণত গ্রহণযোগ্য।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.2-data-modeling/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.2-data-modeling) — `docker compose up -d --wait && npm install`, তারপর `npm run anomalies`, `npm run dashboard`, `npm run counter`। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

এই exercise এ একই TaskFlow data দুটো schema তে — hackathon এর "সব এক table এ" version, আর normalized (3NF) version, `openTaskCount` counter সহ। Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean, তিনটা script এর output README তে যা আছে তাই, আর query plan `EXPLAIN ANALYZE` দিয়ে মিলিয়ে দেখা।

**সেটআপ যাচাই হলে, এই চারটা করো:**

1. `npm run dashboard` চালাও। তোমার মেশিনে তিনটা কলামের সংখ্যা কত? সরল query আর LATERAL এর অনুপাত আমার পাওয়া ~২২ গুণ এর কাছাকাছি? তারপর `src/models/good.ts` থেকে `{ fields: ['projectId', 'status'] }` index টা সরিয়ে আবার চালাও — **কোন কলামটা** সবচেয়ে বেশি বদলাল, আর কেন?

2. `src/counter.ts` এর `naive()` এর শুরুতে একটা random delay যোগ করো:

   ```typescript
   await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));
   ```

   কয়েকবার চালাও — এখন কতগুলো হারায়? Delay ৫০০ ms করলে? সংখ্যাটা কি কখনো নিশ্চিতভাবে শূন্য হয়? "কম হারায়" আর "হারায় না" এর পার্থক্যটা এক অনুচ্ছেদে লেখো।

3. `atomic()` এর ভেতরে `Project.increment` এর বদলে `naive()` এর মতো `findByPk` → `+1` → `save()` লেখো, কিন্তু সবকিছু transaction এর ভেতরে রেখে (`{ transaction }` দিয়ে)। এখন কি ২০০ আসে? ফলাফলটা লিখে রাখো — কেন এমন হলো, সেটা Lesson 5.5 এ আমরা খুলে দেখব।

4. **Design অংশ (Tier 3 ধরনের):** `openTaskCount` কে ঠিক রাখতে task এর জীবনে **আর কোন কোন ঘটনায়** এটা বদলানো দরকার? (Task তৈরি ছাড়াও — অন্তত চারটা খুঁজে বের করো।) প্রতিটার জন্য: +1, −1, নাকি দুটো project এ দুটো আলাদা বদল?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1
Current: 5.2 — Schema & Data Modeling
TaskFlow state: Nginx + ৪টা Express instance, CDN, Redis cache, একটা PostgreSQL primary;
schema normalized (users / projects / tasks / tags + task_tags junction),
projects.openTaskCount denormalized counter (atomic increment + reconciliation job)
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.3 — Storage Engine Internals (B-tree vs LSM-tree, WAL)
=======================
```

---

## ৮. পরের Lesson

Exercise টা চালিয়ে তোমার সংখ্যাগুলো পাঠাও — বিশেষ করে ১ নম্বরে index সরানোর পরে কোন কলাম বদলাল, আর ৪ নম্বরের তালিকা। রেডি হলে `next` লিখো — Lesson 5.3 এ যাব: **Storage Engine Internals** — database আসলে disk এ data কীভাবে রাখে, B-tree আর LSM-tree এর পার্থক্য কী, WAL কেন crash এর পরেও data বাঁচায়, আর কেন Postgres আর Cassandra একই কাজ এত আলাদা ভাবে করে।
