# Lesson 5.6 — Connection Pooling, N+1 Problem আর Query Optimization

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 3.2):** Least Connections algorithm কখন Round Robin এর চেয়ে ভালো কাজ করে? কোন ধরনের request এর ক্ষেত্রে পার্থক্যটা সবচেয়ে বেশি?

**Prerequisite:** Lesson 1.4 (Keep-alive), Lesson 1.6 (Horizontal scaling), Lesson 5.4 (EXPLAIN), Lesson 5.5 (Transaction)

**তুমি এই lesson শেষে পারবে:**

1. Connection pool কেন লাগে আর Sequelize এর `pool` option গুলো আসলে কী করে — বলতে পারবে, আর মেপে দেখবে কেন **বড় pool মানেই দ্রুত না**
2. কয়েকটা app instance মিলে database এর connection limit ছাড়িয়ে যাওয়ার হিসাব করতে পারবে, আর সেটা এড়ানোর উপায় জানবে
3. Sequelize code এ N+1 query চিনবে আর ঠিক করবে (`include`, batching, `separate`), আর `raw`/`attributes` দিয়ে বাড়তি খরচ কমাবে

**Tier:** 1 — Runnable Code

---

## ০. TaskFlow এখন কোথায়

TaskFlow এর marketing team একটা campaign চালাল, আর সেদিন সকালে traffic তিনগুণ হলো। Lesson 3 এর মতো ops team Express instance ৪টা থেকে বাড়িয়ে ৮টা করল। আর একজন developer ভাবল, database এর দিকটাও দ্রুত করা যাক — Sequelize এর `pool.max` ১০ থেকে বাড়িয়ে ২০ করে দিল। "বেশি connection মানে বেশি কাজ একসাথে, তাই না?"

দশ মিনিট পরে error log ভরে গেল:

```
SequelizeConnectionError: sorry, too many clients already
```

আর যেসব request সফল হচ্ছিল, সেগুলোও আগের চেয়ে **ধীর**।

একই দিনে আরেকটা অভিযোগ: workspace dashboard টা load হতে কয়েক সেকেন্ড লাগছে। Local এ developer এর মেশিনে সেটা দিব্যি দ্রুত। Production এর log এ দেখা গেল — **একটা dashboard request এ এক হাজারের বেশি SQL query**।

দুটো সমস্যাই database এর **সামনে** — query কতটা ভালো সেটা না (সেটা Lesson 5.4), বরং app কীভাবে database এর সাথে কথা বলে: কতগুলো connection দিয়ে, আর কতবার। আজ দুটোই মেপে দেখব।

---

## ১. Theory

### ১.১ একটা Connection আসলে কী, আর কেন দামি

`sequelize.query(...)` চালালে আসলে একটা **connection** এর উপর দিয়ে query যায় — app আর database এর মধ্যে একটা খোলা, authenticated কথোপকথন। নতুন একটা connection খুলতে যা যা হয়:

```
App                                           PostgreSQL
 │ ── TCP handshake (Lesson 2.2) ───────────────► │
 │ ── (TLS handshake, network পেরোলে) ───────────► │
 │ ── username + password (SCRAM auth) ─────────► │
 │                                                │ ── নতুন একটা OS process তৈরি
 │ ◄──────────────────────────── ready ────────── │    (প্রতিটা connection এর জন্য একটা)
 │ ── SELECT 1 ─────────────────────────────────► │
```

শেষ লাইনটা Postgres এর একটা বিশেষত্ব: প্রতিটা connection এর জন্য সে একটা **আলাদা OS process** চালায়। Exercise এর container এ ৫টা connection খুলে দেখা গেছে — ৫টা আলাদা `postgres: taskflow ... SELECT` process। প্রতিটা process এর নিজের memory লাগে, তাই connection "ফ্রি" না — database server এর জন্যও না।

Exercise এর `npm run pool` এর ধাপ ১ — একটা একটা করে ২০০টা `SELECT 1`:

```
প্রতিবার নতুন connection      5.78 ms / query
pool থেকে                      0.13 ms / query   (~44x দ্রুত)
```

আর এটা **একই মেশিনে**, TLS ছাড়া। App আর database আলাদা machine এ থাকলে প্রতিটা নতুন connection এ network round trip আর TLS handshake যোগ হয়।

Lesson 1.4 এর keep-alive মনে আছে? একই যুক্তি: একটা দামি জিনিস (connection) একবার বানাও, বারবার ব্যবহার করো।

### ১.২ Connection Pool — Sequelize এর `pool` option আসলে কী

**Connection pool** — আগে থেকে খোলা কয়েকটা database connection এর একটা সংগ্রহ, যেখান থেকে প্রতিটা query একটা connection ধার নেয় আর কাজ শেষে ফেরত দেয়।

```
Express request গুলো          Pool (max: 10)                PostgreSQL
─────────────────             ──────────────                ──────────
req 1 ──┐                     ┌─ conn 1 (ব্যস্ত) ─────────────► process
req 2 ──┤                     ├─ conn 2 (ব্যস্ত) ─────────────► process
req 3 ──┼── ধার চাই ──────►   ├─ conn 3 (খালি)                 …
  …     │                     │   …
req 25 ─┘                     └─ conn 10
          ▲
          └── সব connection ব্যস্ত হলে এখানে লাইন (acquire এর অপেক্ষা)
```

তুমি Sequelize এ এই option গুলো লেখো, এখন প্রতিটার মানে:

| Option    | মানে                                                                                    | Sequelize default |
| --------- | --------------------------------------------------------------------------------------- | ----------------- |
| `max`     | একসাথে সর্বোচ্চ কতগুলো connection খোলা থাকতে পারে                                       | 5                 |
| `min`     | সবসময় অন্তত কতগুলো খোলা রাখা হবে                                                       | 0                 |
| `idle`    | একটা connection কতক্ষণ অব্যবহৃত থাকলে বন্ধ করা হবে (ms)                                 | 10000             |
| `acquire` | Pool এর সব connection ব্যস্ত হলে একটা query কতক্ষণ লাইনে অপেক্ষা করবে, তারপর error (ms) | 60000             |

(Default গুলো Sequelize v6 এর — version বদলালে একবার documentation মিলিয়ে নিও।)

একটা গুরুত্বপূর্ণ জিনিস লক্ষ করো: **pool এ লাইনে দাঁড়ানোর সময়টা query এর সময়ের অংশ হিসেবে দেখায়।** Database এ query টা হয়তো ২ ms নিয়েছে, কিন্তু user দেখছে ৩০০ ms — কারণ ২৯৮ ms সে pool এর লাইনে ছিল। `EXPLAIN ANALYZE` (Lesson 5.4) এটা কখনো দেখাবে না।

### ১.৩ Pool Size — বড় মানেই দ্রুত না

এবার সেই developer এর যুক্তি: "pool বড় করলে বেশি query একসাথে চলবে, তাই দ্রুত।" Exercise এর ধাপ ২ এটা সরাসরি মাপে: ৬৪টা request একসাথে, মোট ৩২০টা query, আর pool এর আকার ১ থেকে ৬৪। Database container কে ইচ্ছা করে **২টা CPU core** এ সীমিত রাখা হয়েছে। দুই ধরনের query:

- **CPU** — database কে সত্যিই হিসাব করতে হয় (বড় aggregate, sort)
- **WAIT** — database শুধু অপেক্ষা করে (`pg_sleep`) — lock এর অপেক্ষা বা ধীর disk এর মতো

```
pool max │   CPU query: q/s    p50 ms    p99 ms │  WAIT query: q/s    p50 ms    p99 ms
       1 │       26      2492      2518        │       48      1329      1334
       2 │       50      1269      1298        │       97       662       665
       4 │       50      1286      1302        │      194       328       333
       8 │       45      1402      1502        │      386       166       167
      16 │       26      2487      2696        │      773        82        84
      32 │       26      2460      3561        │     1535        41        45
      64 │       26      2397      5500        │     1914        20        85
```

**CPU কলাম** — এই lesson এর সবচেয়ে গুরুত্বপূর্ণ সংখ্যা। Throughput এর চূড়া **pool = ২** এ — ঠিক database এর core সংখ্যায়। তার পরে বাড়ানোয় কোনো লাভ নেই, আর ১৬ বা তার বেশিতে throughput **অর্ধেকে নেমে যায়** (৫০ → ২৬ q/s), আর p99 লাফিয়ে বাড়ে (১.৩ s → ৫.৫ s)। কারণ ২টা core এ একসাথে ৬৪টা query চালালে কেউই দ্রুত হয় না — CPU তাদের মধ্যে বারবার অদলবদল করে (context switch), cache নষ্ট হয়, আর সব query একসাথে ধীরে চলে। বাস্তবে এর সাথে যোগ হয় lock এর জন্য প্রতিযোগিতা আর disk এর প্রতিযোগিতা।

**WAIT কলাম** — উল্টো ছবি। Query গুলো CPU ব্যবহার করে না, শুধু অপেক্ষা করে — তাই যত বেশি connection, তত বেশি অপেক্ষা একসাথে, আর throughput প্রায় সমানুপাতে বাড়ে।

তাহলে সঠিক pool size কত? উত্তর: **connection গুলো কী করছে তার উপর নির্ভর করে।** বাস্তব TaskFlow এর query দুটোর মিশ্রণ — কিছু CPU (aggregate, sort), কিছু অপেক্ষা (disk থেকে page পড়া, lock)। একটা পরিচিত সূচনা-বিন্দু (HikariCP নামের Java pool এর documentation থেকে জনপ্রিয় হওয়া): `connections ≈ (database এর core × 2) + disk এর সংখ্যা`। এটা একটা **শুরু করার অনুমান**, আইন না — তারপর নিজের workload এ মাপো।

আর একটা হিসাব কাজে লাগে — **Little's Law**: কোনো system এ গড়ে একসাথে কতগুলো কাজ চলছে = প্রতি সেকেন্ডে কতগুলো কাজ আসে × প্রতিটা কাজ কত সময় থাকে। TaskFlow এর উদাহরণ:

```
প্রতি সেকেন্ডে ৫০০টা query × প্রতিটা গড়ে ৫ ms (০.০০৫ s) = গড়ে ২.৫টা connection ব্যস্ত
```

মানে গড় load এ মাত্র ২-৩টা connection সবসময় কাজ করছে। Peak এ এর কয়েকগুণ। "Pool max ১০০" এর দরকার প্রায় কখনো আসে না — আর যদি আসে, সেটা সাধারণত ধীর query বা লম্বা transaction এর লক্ষণ (একটা query ৫ ms এর বদলে ৫০০ ms নিলে একই traffic এ ২৫০টা connection লাগবে)।

### ১.৪ Connection Limit — Horizontal Scaling এর লুকানো গুণ

এবার `sorry, too many clients already`। Postgres এর একটা সীমা আছে — `max_connections` (default **১০০**) — একসাথে সর্বোচ্চ কতগুলো connection সে নেবে। হিসাবটা সরল গুণ:

```
app instance এর সংখ্যা × প্রতি instance এর pool max  ≤  max_connections − (admin, migration, cron এর জন্য কিছু)

TaskFlow সকালে:   ৪ × ১০ = ৪০    ✓
campaign এর পরে:  ৮ × ২০ = ১৬০   ✗  ১০০ এর বেশি
```

Lesson 1.6 এ শিখেছিলে horizontal scaling এর জন্য app কে stateless রাখতে হয় — কিন্তু প্রতিটা instance এর **নিজের pool** আছে। Instance দ্বিগুণ করলে database এর দিকে connection ও দ্বিগুণ, আর database এর সংখ্যা সীমিত। Autoscaling থাকলে আরও বিপজ্জনক — load বাড়লে instance বাড়ে, আর ঠিক সবচেয়ে খারাপ মুহূর্তে connection limit ভাঙে।

Exercise এর ধাপ ৩: ৫টা instance × pool max ২৫ = ১২৫টা connection চাওয়া:

```
সফল: 75টা
ব্যর্থ: 50টা → "sorry, too many clients already"
```

(কতগুলো ব্যর্থ হয় সেটা প্রতিবার বদলায় — তিনবার চালিয়ে ৪৬, ৬৬, ৫০ — কারণ কে কখন slot পায় সেটা timing এর উপর নির্ভর করে। কিন্তু ব্যর্থতা প্রতিবার আসে।)

আর একটা ভিন্ন ব্যর্থতাও আছে — database এর limit না, **নিজের pool ফুরিয়ে যাওয়া**। **Pool exhaustion** — pool এর সব connection ব্যস্ত, আর নতুন query গুলো `acquire` সময়সীমা পর্যন্ত অপেক্ষা করে ব্যর্থ হয়। Exercise এ max ২, acquire সীমা ১ সেকেন্ড, আর ১০টা ০.৮ সেকেন্ডের query:

```
সফল: 4টা, ConnectionAcquireTimeoutError: 6টা
```

Pool exhaustion এর সবচেয়ে সাধারণ কারণ ধীর query না — **লম্বা transaction**। Lesson 5.5 এ বলেছিলাম transaction এর ভেতরে network call কোরো না। কারণ: transaction যতক্ষণ খোলা, ততক্ষণ একটা connection আটকে থাকে। একটা transaction এর ভেতরে ২ সেকেন্ডের payment API call মানে ওই ২ সেকেন্ড একটা connection কেউ ব্যবহার করতে পারবে না। এমন ১০টা একসাথে হলে ১০ connection এর pool শেষ।

**সমাধানগুলো:**

1. **হিসাব করে pool size ঠিক করো** — `instances × max` যেন limit এর নিচে থাকে, autoscaling এর সর্বোচ্চ সংখ্যা ধরে। প্রায়ই সমাধান pool **ছোট** করা।
2. **Connection proxy** — app আর database এর মাঝখানে একটা আলাদা pooler, যেমন **PgBouncer**। **Connection proxy** — অনেকগুলো app connection গ্রহণ করে অল্প কয়েকটা আসল database connection এ ভাগ করে দেয়। হাজারটা app connection → ৫০টা database connection। দাম: "transaction pooling" mode এ (সবচেয়ে কার্যকর mode) একটা app connection প্রতিটা transaction এ ভিন্ন database connection পেতে পারে, তাই session-এর উপর নির্ভরশীল জিনিস (`SET` দিয়ে session setting, session-level advisory lock, `LISTEN`) ঠিকমতো কাজ নাও করতে পারে। আর prepared statement এর সমর্থন PgBouncer এর version এর উপর নির্ভর করে — ব্যবহারের আগে নিজের version এর documentation দেখো।
3. **`max_connections` বাড়ানো** — সম্ভব, কিন্তু প্রতিটা connection একটা process আর memory; আর ১.৩ এর মতো, বেশি একসাথে চলা query CPU তে ভিড় বাড়ায়। সাধারণত শেষ উপায়।
4. **Fail fast** — `acquire` এর সীমা কম রাখো (যেমন কয়েক সেকেন্ড)। ৬০ সেকেন্ড (default) অপেক্ষা করা request user এর কাছে ঝুলে থাকা page; তার চেয়ে দ্রুত একটা পরিষ্কার error (আর retry বা "একটু পরে চেষ্টা করো") ভালো। Lesson 10.3 এ এটা graceful degradation এর অংশ হিসেবে ফিরে আসবে।

### ১.৫ N+1 Problem

এবার dashboard এর হাজার query। TaskFlow এর code টা দেখতে একদম স্বাভাবিক (exercise এর `nplusone.ts` থেকে):

```typescript
async function nPlusOne(): Promise<Row[]> {
	const rows: Row[] = [];
	const projects = await Project.findAll({ order: [['id', 'ASC']] }); // ১টা query
	for (const project of projects) {
		const tasks = await Task.findAll({ where: { projectId: project.id }, order: [['id', 'ASC']] }); // N টা
		for (const task of tasks) {
			const assignee = await User.findByPk(task.assigneeId); // আরও N×M টা
			rows.push({ project: project.name, task: task.title, assignee: assignee?.name ?? '?' });
		}
	}
	return rows;
}
```

**N+1 query** — একটা query দিয়ে N টা জিনিস আনা, তারপর প্রতিটার জন্য আলাদা করে আরেকটা query চালানো — মোট N+1 টা (বা এখানে যেমন, এক স্তর আরও গভীরে গেলে তার চেয়েও বেশি)। Code এ প্রতিটা লাইন নির্দোষ; সমস্যাটা শুধু দেখা যায় যখন গুনে দেখো কতবার database এ যাওয়া হচ্ছে।

Exercise এর `npm run nplusone` একই dashboard (৫০টা project, ১০০০টা task, প্রতিটার assignee) তিনভাবে আনে, আর প্রতিটা SQL গোনে:

```
পদ্ধতি                          query     rows   মাপা সময়   +1ms RTT হলে*
ক. N+1 (loop এ findByPk)         1051    2,050     210.0 ms      1261 ms
খ. include (একটা JOIN)              1    1,000       7.2 ms         8 ms
গ. batching (IN দিয়ে ৩টা)          3    1,250       3.7 ms         7 ms
```

\* শেষ কলামটা **হিসাব, মাপা না**: `মাপা সময় + query সংখ্যা × ১ ms`।

এখানে একটা ফাঁদ বোঝার মতো: exercise এ app আর database **একই মেশিনে**, তাই প্রতিটা query এর network round trip প্রায় শূন্য, আর N+1 "মাত্র" ২১০ ms। এই কারণেই N+1 developer এর মেশিনে লুকিয়ে থাকে। Production এ app আর database আলাদা machine এ — প্রতিটা query তে অন্তত একটা network round trip। প্রতি round trip ১ ms ধরলেও ১০৫১টা query তে এক সেকেন্ডের বেশি শুধু যাওয়া-আসায়। TaskFlow এর "কয়েক সেকেন্ডের dashboard" এর রহস্য এটাই।

**সমাধান ১ — Eager loading (`include`)।** **Eager loading** — মূল data এর সাথে সম্পর্কিত data একই সময়ে আনা (সাধারণত JOIN দিয়ে), পরে একটা একটা করে না:

```typescript
async function eager(): Promise<Row[]> {
	const projects = await Project.findAll({
		include: [{ model: Task, as: 'tasks', include: [{ model: User, as: 'assignee' }] }],
		order: [
			['id', 'ASC'],
			[{ model: Task, as: 'tasks' }, 'id', 'ASC']
		]
	});
	return projects.flatMap((p) =>
		(p.tasks ?? []).map((t) => ({
			project: p.name,
			task: t.title,
			assignee: t.assignee?.name ?? '?'
		}))
	);
}
```

১০৫১টা query থেকে ১টা।

**সমাধান ২ — Batching।** প্রতিটা স্তরে একটা query, `WHERE id IN (...)` দিয়ে: প্রথমে project গুলো, তারপর তাদের সব task একবারে, তারপর সেই task গুলোর সব assignee একবারে — মোট ৩টা query, আর JS এ `Map` দিয়ে জোড়া লাগানো। এটাই GraphQL এর জগতে **DataLoader** এর ধারণা (Lesson 2.3 এ GraphQL এর N+1 সমস্যার কথা মনে করো)। এখানে এটা include এর চেয়েও একটু দ্রুত — কারণ JOIN এ প্রতিটা task row এর সাথে project এর data বারবার আসে, batching এ প্রতিটা জিনিস একবার।

**কোনটা কখন?** সাধারণ ক্ষেত্রে `include` সবচেয়ে সহজ। কিন্তু একটা ব্যতিক্রম আছে, আর সেটা বাস্তবে খুব সাধারণ।

**Cartesian explosion।** Project এর সাথে **দুটো** hasMany একসাথে include করলে — tasks (প্রতি project এ ২০টা) আর members (প্রতি project এ ১০টা):

```
পদ্ধতি                          query     rows   মাপা সময়
include, একটা JOIN                  1   10,000      28.2 ms
include, separate: true             3    1,550       8.7 ms
```

**Cartesian explosion** — একটা JOIN এ দুটো আলাদা one-to-many সম্পর্ক একসাথে আনলে প্রতিটা "এক" এর জন্য দুই দিকের **গুণফল** সংখ্যক row তৈরি হওয়া। প্রতিটা project এর জন্য ২০ × ১০ = ২০০টা row (প্রতিটা task প্রতিটা member এর সাথে জোড়া), ৫০টা project এ ১০,০০০ — অথচ আসল data মাত্র ১,০০০ task + ৫০০ member। Sequelize সেগুলো আবার ভেঙে সাজায়, কিন্তু database আর network এর কাজটা ইতিমধ্যে হয়ে গেছে। সংখ্যা আরও বড় হলে (১০০ task × ৫০ member) এটা খুব দ্রুত ভয়ংকর হয়।

সমাধান Sequelize এই আছে — `separate: true`, যেটা ওই hasMany এর জন্য আলাদা একটা `WHERE projectId IN (...)` query চালায়:

```typescript
async function twoHasManySeparate(): Promise<number> {
	const projects = await Project.findAll({
		include: [
			{ model: Task, as: 'tasks', separate: true }, // আলাদা query: WHERE projectId IN (...)
			{ model: Member, as: 'members', separate: true }
		]
	});
	return projects.length;
}
```

১০,০০০ row থেকে ১,৫৫০, আর ৩ গুণ দ্রুত। শিক্ষাটা: **"সবসময় একটা query" নিজেই লক্ষ্য না** — লক্ষ্য হলো কম round trip **আর** কম অপ্রয়োজনীয় data।

**N+1 কীভাবে খুঁজে পাবে?** Code দেখে প্রায়ই না — একটা `for` loop এর ভেতরে `await Model.findX(...)`, বা একটা `.map` এর ভেতরে `instance.getTasks()` — review এ চোখ এড়িয়ে যায়। নির্ভরযোগ্য উপায় হলো **প্রতি request এ query গোনা**: development এ Sequelize এর `logging` দিয়ে (exercise এ ঠিক এভাবে গোনা হয়েছে), আর production এ tracing tool দিয়ে (Lesson 10.4) — যেটা প্রতিটা request এর নিচে কতগুলো database call হলো সেটা দেখায়।

### ১.৬ Query Optimization — Database এর বাইরের খরচ

Query database এ দ্রুত চললেও খরচ শেষ হয় না — data আসার পর Sequelize প্রতিটা row কে একটা পূর্ণ Model instance এ রূপ দেয় (getter, setter, কী বদলেছে তার হিসাব রাখা)। একে বলে hydration। অল্প row এ চোখে পড়ে না; অনেক row এ পড়ে। Exercise এর `npm run hydration` — একই ১ লাখ task:

```
Model instance (default)              200 ms   (100,000 row, 1.0x)
raw: true                              96 ms   (100,000 row, 2.1x)
raw: true + শুধু দরকারি column         68 ms   (100,000 row, 2.9x)
```

- **`raw: true`** — Model instance না বানিয়ে সাধারণ JS object ফেরত দেয়। পরে `.save()` বা association method দরকার না থাকলে (যেমন একটা report বা export), এটাই যথেষ্ট — আর দ্বিগুণ দ্রুত।
- **`attributes: [...]`** — শুধু দরকারি column। কম data database থেকে, network দিয়ে, আর memory তে। আর বোনাস: Lesson 5.4 এর covering index তখনই কাজে আসে যখন query শুধু index এর column চায় — `SELECT *` দিলে সেটা কখনো হবে না।

বাকি নিয়মগুলো আগের lesson গুলো থেকে আসে, এখানে একসাথে:

- বড় list এ সবসময় pagination — cursor দিয়ে (Lesson 2.5, 5.4)
- ধীর query এ আগে `EXPLAIN ANALYZE` (Lesson 5.4)
- Transaction ছোট — pool এর connection আটকে থাকে (১.৪, Lesson 5.5)
- Counter বা aggregate বারবার লাগলে denormalize বা cache (Lesson 5.2, Module 4)

> **Trade-off Table — Related data আনার উপায়**

| উপায়                       | Query        | কখন ভালো                                      | ফাঁদ                                                             |
| --------------------------- | ------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| Loop এ আলাদা query (N+1)    | N+1          | প্রায় কখনো না (হয়তো ৩-৪টা জিনিস হলে)        | Local এ দ্রুত, production এ round trip গুণ হয়                   |
| `include` (JOIN)            | 1            | belongsTo, আর একটা hasMany                    | দুটো বা বেশি hasMany একসাথে → cartesian explosion                |
| `include` + `separate`      | 1 + k        | একাধিক hasMany                                | প্রতিটা separate include এ একটা বাড়তি round trip                |
| Batching (`IN`, DataLoader) | স্তর প্রতি ১ | জটিল বা ভিন্ন উৎস থেকে data; GraphQL resolver | জোড়া লাগানোর code নিজে লিখতে হয়; খুব বড় `IN` list এর সীমা আছে |

---

## ২. Interview Angle

**তিনটা খুব সাধারণ প্রশ্ন:**

1. **"আমরা app server ৩ থেকে ১০টা করলাম, তারপর database connection error আসছে। কেন?"** — প্রতিটা instance এর নিজের pool; `instances × pool max` এখন `max_connections` ছাড়িয়েছে। সমাধান: pool ছোট করো, PgBouncer এর মতো connection proxy দাও, autoscaling এর সর্বোচ্চ সংখ্যা ধরে হিসাব করো। বোনাস: "pool বড় করা সাধারণত সমাধান না — database এর core সংখ্যার অনেক বেশি একসাথে চলা query throughput কমায়" (এর পেছনে মাপা সংখ্যা বলতে পারলে আরও ভালো)।

2. **"একটা page ধীর, database এর প্রতিটা query দ্রুত। কী হতে পারে?"** — প্রতি request এ query সংখ্যা দেখো — N+1। অথবা pool এ অপেক্ষা (query নিজে দ্রুত, কিন্তু connection পেতে দেরি)। অথবা অনেক row এর hydration। "প্রতিটা query দ্রুত" মানেই "request দ্রুত" না।

3. **"Pool size কত রাখবে?"** — একটা সংখ্যা না, একটা যুক্তি: database এর core সংখ্যা থেকে শুরু (core × 2 + disk একটা পরিচিত সূচনা), Little's Law দিয়ে প্রয়োজন হিসাব (query/s × গড় সময়), `instances × max` এর সীমা, তারপর load test এ মাপা।

**Production এ বাস্তবে:** Serverless (যেমন AWS Lambda) এ এই সমস্যা আরও তীব্র — প্রতিটা function instance নিজের connection খোলে, আর হঠাৎ হাজারটা instance চালু হতে পারে। এই কারণেই serverless এর সাথে প্রায় সবসময় একটা connection proxy (PgBouncer, বা cloud provider এর নিজের proxy) ব্যবহার করা হয়।

---

## ৩. Key Takeaway

- নতুন connection দামি — TCP, auth, আর Postgres এ প্রতিটার জন্য একটা আলাদা OS process; exercise এ pool ~৪৪ গুণ দ্রুত
- Pool এ লাইনে দাঁড়ানোর সময় user এর চোখে query এর সময় — `EXPLAIN` সেটা দেখায় না
- **বড় pool ≠ দ্রুত** — CPU এর কাজে throughput এর চূড়া database এর core সংখ্যায়, তার বেশিতে কমে আর p99 বাড়ে; অপেক্ষার কাজে বাড়ে। Little's Law দিয়ে হিসাব করো, তারপর মাপো
- `instances × pool max ≤ max_connections` — horizontal scaling আর autoscaling এই সংখ্যা গুণ করে; সমাধান ছোট pool আর connection proxy (PgBouncer, তার সীমাবদ্ধতা জেনে)
- Pool exhaustion এর সবচেয়ে বড় কারণ লম্বা transaction; `acquire` এর সীমা কম রেখে fail fast
- **N+1** local এ লুকিয়ে থাকে, production এ round trip গুণ হয়; `include`, batching, আর প্রতি request এ query গোনা
- দুটো hasMany একসাথে JOIN → **cartesian explosion** (১,০০০ এর জায়গায় ১০,০০০ row); `separate: true`; অনেক row এ `raw: true` আর `attributes`

---

## ৪. নতুন Term (Glossary)

| Term                    | অর্থ                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Connection Pool**     | আগে থেকে খোলা কয়েকটা database connection এর সংগ্রহ; প্রতিটা query একটা ধার নেয়, কাজ শেষে ফেরত দেয়                 |
| **Pool Exhaustion**     | Pool এর সব connection ব্যস্ত, আর নতুন query গুলো acquire সময়সীমা পর্যন্ত অপেক্ষা করে ব্যর্থ হয়                     |
| **Little's Law**        | গড়ে একসাথে চলা কাজের সংখ্যা = প্রতি সেকেন্ডে আসা কাজ × প্রতিটা কাজের গড় সময়                                       |
| **Connection Proxy**    | App আর database এর মাঝের pooler (যেমন PgBouncer) — অনেক app connection কে অল্প কয়েকটা database connection এ ভাগ করে |
| **N+1 Query**           | একটা query দিয়ে N টা জিনিস এনে, প্রতিটার জন্য আলাদা আরেকটা query চালানো                                             |
| **Eager Loading**       | মূল data এর সাথে সম্পর্কিত data একসাথে আনা (Sequelize এ `include`), পরে একটা একটা করে না                             |
| **Cartesian Explosion** | একটা JOIN এ দুটো one-to-many একসাথে আনলে প্রতিটা "এক" এর জন্য দুই দিকের গুণফল সংখ্যক row তৈরি হওয়া                  |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এর database এ ৮টা core আর `max_connections = 100`। ৪টা Express instance, peak এ ১২টা পর্যন্ত autoscale হয়। একটা background worker process ও আছে যেটা নিজের pool চালায়। প্রতি instance এর pool max কত রাখবে, আর কেন? হিসাবটা দেখাও।
2. একটা endpoint এর p99 latency হঠাৎ ৮ সেকেন্ড, অথচ database এর slow query log এ কিছু নেই, আর database এর CPU ৩০%। কী হতে পারে? কোথায় খুঁজবে?
3. একজন developer N+1 ঠিক করতে একটা বিশাল `include` লিখল — project এর সাথে tasks, members, comments, attachments, activity log — সব একটা query তে। Page আগের চেয়েও ধীর হয়ে গেল। কেন? তুমি কীভাবে সাজাতে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** আগে বাজেট: ১০০ থেকে কিছু রাখো admin, migration, monitoring, আর জরুরি অবস্থায় `psql` এর জন্য — ধরো ১০টা। বাকি ৯০। Background worker কে ধরো ১০টা দিলাম। থাকে ৮০টা, ১২টা instance এর মধ্যে ভাগ → প্রতি instance এ সর্বোচ্চ **৬**। এটা কি যথেষ্ট? ১.৩ এর যুক্তিতে: ৮ core এর database এ একসাথে সত্যিকারের কাজের জন্য কয়েক ডজন connection এর বেশি লাভজনক না (core × 2 + disk ≈ ২০-এর ঘরে); ১২ × ৬ = ৭২টা একসাথে চলা query ইতিমধ্যে তার অনেক বেশি। তাই ৬ যথেষ্ট, আর সম্ভবত কম হলেও চলত। যদি Little's Law দিয়ে দেখা যায় বেশি লাগছে (যেমন query গুলো ধীর), তাহলে আসল সমাধান query বা transaction দ্রুত করা, অথবা PgBouncer — `max_connections` বাড়ানো না। মূল শিক্ষা: হিসাবটা **সর্বোচ্চ** instance সংখ্যা দিয়ে, গড় দিয়ে না।

**প্রশ্ন ২:** Database এ query দ্রুত, CPU ফাঁকা — তাহলে সময়টা database এর **বাইরে** যাচ্ছে। সবচেয়ে সম্ভাব্য: **pool exhaustion** — request গুলো connection পেতে লাইনে দাঁড়িয়ে (৮ সেকেন্ড এর p99 মানে কেউ কেউ অনেকক্ষণ অপেক্ষা করছে)। কেন? কোনো endpoint লম্বা transaction খোলা রেখে ভেতরে ধীর external API call করছে, অথবা একটা N+1 এক request এ শত শত বার connection ধার নিচ্ছে। খুঁজবে: pool এর metric (কতগুলো connection ব্যস্ত, কতজন লাইনে — Sequelize এর pool বা tracing থেকে), প্রতি request এ query সংখ্যা, আর database এ `pg_stat_activity` — সেখানে `idle in transaction` অবস্থায় অনেক connection থাকলে বুঝবে transaction খোলা রেখে app অন্য কাজ করছে।

**প্রশ্ন ৩:** পাঁচটা hasMany একসাথে একটা JOIN এ — **cartesian explosion** এর চরম রূপ। প্রতিটা project এর জন্য tasks × members × comments × attachments × activity সংখ্যক row — ধরো ৫০ × ১০ × ২০০ × ৩০ × ৫০০ — কোটির ঘরে। Database আর network সেই বিশাল row সেট তৈরি আর পাঠাতে ব্যস্ত, আর Sequelize কে সেগুলো আবার ভেঙে সাজাতে হয়। সমাধান: belongsTo (যেমন project এর owner) JOIN এ রাখো, কিন্তু প্রতিটা hasMany তে `separate: true` — প্রতিটার জন্য একটা `IN` query, মোট ৬টা query, row সংখ্যা আসল data এর সমান। আর প্রশ্ন করো — একটা page এ কি সত্যিই সব comment আর পুরো activity log লাগে? সম্ভবত সর্বশেষ কয়েকটা, pagination সহ, আলাদা request এ।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-5.6-pooling-nplusone/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.6-pooling-nplusone) — `docker compose up -d --wait && npm install`, তারপর `npm run pool`, `npm run nplusone`, `npm run hydration`। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

তিনটা script: connection এর দাম আর pool size (database container ২টা core এ সীমিত, যাতে যেকোনো মেশিনে একই রকম ফল), N+1 আর cartesian explosion (প্রতিটা SQL গুনে), আর hydration। Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean, pool এর ধাপ ২ দুবার প্রায় হুবহু, `nplusone` এর query আর row সংখ্যা হুবহু এক, তিনটা পদ্ধতির data এক।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. তিনটা script চালাও। Pool এর CPU কলামে তোমার মেশিনে চূড়া কোথায়? README এর সাথে মেলে?

2. **Core বাড়াও** (README experiment ১): `cpus: '4'` করে `npm run pool -- 2`। চূড়া কোথায় সরল? ফলাফল দিয়ে pool size এর নিয়মটা এক অনুচ্ছেদে নিজের ভাষায় লেখো।

3. **Fail fast বনাম অপেক্ষা** (experiment ২): `acquire` ১ সেকেন্ড থেকে ৬০ সেকেন্ড করো। কতগুলো সফল হলো, আর শেষটা কতক্ষণ অপেক্ষা করল? একটা API এর জন্য কোনটা তুমি বাছবে, কেন?

4. **N+1 লুকাও** (experiment ৪): `eager()` এর ভেতরে assignee এর include সরিয়ে loop এ `findByPk` দাও। Query সংখ্যা কত হলো? তারপর ভাবো — TaskFlow এর code review এ এটা কীভাবে আটকানো যায়? (ইঙ্গিত: test এ প্রতি request এর query সংখ্যার একটা সীমা।)

5. **Design অংশ:** TaskFlow এ এখন ৪টা Express instance (peak এ ১০), একটা BullMQ worker (Module 7 এ আসবে, নিজের pool), database এ ৮ core আর `max_connections = 100`। একটা **pool পরিকল্পনা** লেখো: প্রতিটা process এর pool max, `acquire` সীমা, আর কোন অবস্থায় (কোন সংখ্যা দেখলে) তুমি PgBouncer যোগ করবে। হিসাব দেখাও।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ), 5.1, 5.2, 5.3, 5.4, 5.5
Current: 5.6 — Connection Pooling, N+1, Query Optimization
TaskFlow state: Nginx + ৪–৮টা Express instance, CDN, Redis cache, একটা PostgreSQL primary;
pool এর আকার instances × max ≤ max_connections হিসাব করে; dashboard এর N+1 ঠিক
(include + separate); report এ raw + attributes
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.7 — Replication (Master-Slave, Master-Master, Read Scaling)
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরে core বাড়ানোর পর চূড়া কোথায় গেল, আর ৫ নম্বরের pool পরিকল্পনা। রেডি হলে `next` লিখো — Lesson 5.7 এ যাব: **Replication** — একটা database এ আর read ধরছে না, তখন কী? Primary থেকে replica তে data কীভাবে যায় (Lesson 5.3 এর WAL মনে আছে?), read replica দিয়ে read scale করা, replication lag আর তার অদ্ভুত bug ("এইমাত্র save করলাম, কিন্তু দেখাচ্ছে না!"), আর failover — hands-on, Docker এ আসল Postgres primary + replica দিয়ে।
