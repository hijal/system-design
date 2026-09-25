# Lesson 5.1 — SQL vs NoSQL: আসল Trade-off

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 2.3):** REST, GraphQL আর gRPC এর মধ্যে "সবচেয়ে ভালো" কোনটা — এই প্রশ্নের সঠিক উত্তর কী ছিল, আর কোন ধরনের প্রশ্ন দিয়ে আমরা সিদ্ধান্ত নিয়েছিলাম?

**Prerequisite:** Lesson 1.2 (Design Framework), Lesson 1.3 (Estimation), Lesson 1.6 (Horizontal Scaling), Lesson 4.4 (Redis Hands-on)

**তুমি এই lesson শেষে পারবে:**

1. "SQL vs NoSQL" নামের আড়ালে আসল পার্থক্যগুলো বলতে পারবে — data model, schema কোথায় enforce হয়, query কতটা flexible, আর কী guarantee পাওয়া যায়
2. NoSQL এর চারটা family (key-value, document, wide-column, graph) চিনবে — প্রতিটা কোন সমস্যার জন্য বানানো, আর কোথায় দুর্বল
3. একটা নতুন feature এর জন্য database বেছে নেওয়ার সময় "NoSQL কারণ scale করে" জাতীয় myth ধরতে পারবে, আর সংখ্যা ও access pattern দিয়ে সিদ্ধান্ত justify করবে

**Tier:** 3 — Design Exercise (hands-on Sequelize modeling Lesson 5.2 তে)

---

## ০. TaskFlow এখন কোথায়

Module 4 শেষে TaskFlow বেশ শক্তপোক্ত — Nginx এর পেছনে ৪টা Express instance, সামনে CDN, পাশে Redis cache (Cache-Aside + single-flight, মাপা লাভ সহ)। কিন্তু সবকিছুর নিচে এখনো **একটাই PostgreSQL**। পুরো Module 4 জুড়ে আমরা এই DB টাকে **বাঁচানোর** চেষ্টা করেছি — এবার সময় DB টার **ভেতরে** ঢোকার।

আজকের problem টা আসছে product team থেকে। দুইটা নতুন feature এর request:

1. **Custom fields:** প্রতিটা team নিজের মতো field চায়। Marketing team চায় `campaign` আর `budget`, engineering team চায় `storyPoints` আর `sprint`, agency চায় `clientName`। প্রতি project এ আলাদা field, আর সেগুলো দিয়ে filter করতে হবে।
2. **Activity log:** "রহিম task #42 কে Done এ সরিয়েছে" — প্রতিটা ঘটনার একটা record, project এর পাতায় সর্বশেষ ৫০টা দেখাতে হবে, এক বছর রাখতে হবে।

Team এর একজন নতুন engineer meeting এ বলল:

> "Postgres এর schema অনেক rigid — প্রতিটা নতুন field এর জন্য migration লাগবে। চলো MongoDB তে চলে যাই, ওটা schemaless। আর activity log এ অনেক data হবে — NoSQL ভালো scale করে, SQL করে না।"

শুনতে যুক্তিসঙ্গত লাগে, তাই না? এই এক বাক্যে আসলে **তিনটা আলাদা দাবি** আছে — "schemaless", "migration লাগবে না", আর "SQL scale করে না"। আজকের lesson শেষে তুমি প্রতিটা দাবি আলাদা করে যাচাই করতে পারবে — কোনটা সত্য, কোনটা অর্ধসত্য, আর কোনটা ভুল।

---

## ১. Theory

### ১.১ নামটাই বিভ্রান্তিকর

"SQL vs NoSQL" শুনলে মনে হয় পার্থক্যটা **query language** এ — একটায় SQL লেখো, আরেকটায় লেখো না। আসলে তা না:

- Cassandra এর query language এর নাম **CQL** — দেখতে প্রায় SQL এর মতো (`SELECT ... FROM ... WHERE ...`), কিন্তু Cassandra একটা NoSQL database
- PostgreSQL এর `JSONB` column এ তুমি পুরো JSON document রাখতে পারো, index করতে পারো, ভেতরের field দিয়ে query করতে পারো — মানে Postgres নিজেই অনেকখানি document store এর কাজ করে
- "NoSQL" শব্দটা ২০০৯ এর দিকে একটা meetup এর hashtag হিসেবে জনপ্রিয় হয়, পরে অনেকে এর মানে দাঁড় করায় "Not only SQL"

তাহলে আসল পার্থক্য কোথায়? চারটা অক্ষে (axis):

```
                    Relational (SQL)              NoSQL (সাধারণভাবে)
                    ─────────────────             ──────────────────
Data model      →   table, row, relation          key-value / document /
                                                  wide-column / graph
Schema কোথায়   →   database enforce করে          application code enforce করে
Query           →   আগে data, পরে যেকোনো প্রশ্ন   আগে প্রশ্ন, সেই মতো data সাজাও
Guarantee       →   multi-row ACID transaction    সাধারণত এক record/partition এ
                    (default)                     শক্ত, তার বাইরে সীমিত
```

প্রতিটা অক্ষ আলাদা করে দেখি। শেষে scale এর প্রশ্নে আসব, কারণ ওখানেই সবচেয়ে বেশি ভুল ধারণা।

### ১.২ Relational Model — তুমি যা আগে থেকেই জানো

**Relational model** — data কে table (row আর column) এ রাখা, আর table গুলোর মধ্যে সম্পর্ক foreign key দিয়ে প্রকাশ করা। তুমি Sequelize এ প্রতিদিন এটাই করো:

```
┌──────────────┐       ┌──────────────────┐       ┌───────────────────────┐
│    users     │       │     projects     │       │         tasks         │
├──────────────┤       ├──────────────────┤       ├───────────────────────┤
│ id        PK │◄──┐   │ id            PK │◄──┐   │ id                 PK │
│ name         │   └───│ ownerId       FK │   └───│ projectId          FK │
│ email        │       │ name             │   ┌───│ assigneeId         FK │
└──────────────┘       └──────────────────┘   │   │ title                 │
       ▲                                      │   │ status                │
       └──────────────────────────────────────┘   └───────────────────────┘
```

`Task.belongsTo(User, { as: 'assignee' })` লিখলে তুমি আসলে এই foreign key টাই declare করছ, আর `include: [{ model: User, as: 'assignee' }]` দিলে Sequelize পেছনে একটা `JOIN` বানায়।

Relational model এর সবচেয়ে বড় শক্তিটা প্রায়ই চোখ এড়িয়ে যায়: **ভবিষ্যতের প্রশ্ন আগে থেকে জানতে হয় না।** আজকে তুমি data টা normalize করে রাখলে, ছয় মাস পরে product manager যদি জিজ্ঞেস করে "গত মাসে কোন team এর সবচেয়ে বেশি overdue task ছিল?" — একটা নতুন `JOIN` + `GROUP BY` লিখলেই উত্তর। Data এর shape বদলাতে হয় না। (Normalization আর কখন ইচ্ছা করে সেটা ভাঙতে হয়, সেটাই Lesson 5.2)

দ্বিতীয় শক্তি — **একাধিক row বা table জুড়ে transaction।** "Task টা Done করো **এবং** project এর `completedCount` এক বাড়াও" — হয় দুটোই হবে, নয়তো কোনোটাই না। Sequelize এ `sequelize.transaction(async (t) => { ... })` দিয়ে যা করো। এটা কীভাবে কাজ করে আর এর দাম কী, সেটা Lesson 5.5 এ।

### ১.৩ প্রথম আসল অক্ষ — Schema কোথায় থাকে?

নতুন engineer এর প্রথম দাবি ছিল "MongoDB schemaless"। এখানেই সবচেয়ে বড় ভুল বোঝাবুঝি। **Schema ছাড়া data বলে কিছু নেই** — কারণ তোমার code কোনো না কোনো shape ধরে নিয়েই data পড়ে। `task.title.toUpperCase()` লিখলে তুমি ধরে নিচ্ছ `title` আছে এবং সেটা string। প্রশ্নটা শুধু — **schema টা কে enforce করে, আর কখন?**

- **Schema-on-write** — database লেখার সময়েই যাচাই করে। Postgres এ `title TEXT NOT NULL` থাকলে title ছাড়া row ঢুকবেই না। ভুল data **দরজাতেই আটকায়**।
- **Schema-on-read** — database যা দেবে তাই রেখে দেয়; পড়ার সময় application ঠিক করে data টা কী shape এর। ভুল data **ভেতরে ঢুকে যায়**, ধরা পড়ে পড়ার সময় — অথবা ধরা পড়েই না।

এই দুটো তুমি ইতিমধ্যেই দেখেছ, হয়তো খেয়াল করোনি। Lesson 4.4 এর exercise এ Redis থেকে data পড়ার পর আমরা কী করেছিলাম মনে আছে?

```typescript
const parsed: unknown = JSON.parse(raw);
const result = taskListSchema.safeParse(parsed);
if (!result.success) {
	// cache এ আবর্জনা — miss ধরে নাও, DB ই সত্যের উৎস
	return { status: 'miss' };
}
```

এটাই **schema-on-read**। Redis কোনো shape যাচাই করে না — যেকোনো string রেখে দেয়। তাই পড়ার সময় Zod দিয়ে আমাদের নিজেদেরই যাচাই করতে হয়েছে। Document database এ ঠিক এই কাজটা **প্রতিটা read path এ** করতে হয়।

এবার "migration লাগবে না" দাবিটা দেখো। ধরো TaskFlow MongoDB তে, আর তুমি `assignee: "rahim@x.com"` (string) থেকে `assignee: { id: 7, email: "..." }` (object) এ বদলালে। Database এ কোনো migration চালাতে হলো না — সত্যি। কিন্তু এখন database এ **দুই ধরনের document** আছে, পুরনো আর নতুন। তোমার code কে দুটোই সামলাতে হবে — চিরকাল, অথবা যতদিন না তুমি একটা background script দিয়ে পুরনোগুলো বদলে দাও (যেটা আসলে একটা migration ই, শুধু নাম আলাদা)।

**তাহলে সঠিক কথাটা:** Document database এ migration **উধাও হয় না, জায়গা বদলায়** — database থেকে application code এ। কখনো এটা সত্যিই সুবিধা (প্রতিটা record এর shape আলাদা হওয়াই যেখানে স্বাভাবিক), কখনো এটা একটা লুকানো ঋণ।

### ১.৪ দ্বিতীয় আসল অক্ষ — আগে Data, নাকি আগে প্রশ্ন?

**Access pattern** — application ঠিক কোন কোন ভাবে data পড়ে আর লেখে ("project X এর সর্বশেষ ৫০টা activity", "user Y এর সব task")।

দুই দুনিয়ার design প্রক্রিয়া উল্টো:

```
Relational:     Entity গুলো চিহ্নিত করো ──> normalize করো ──> যেকোনো query লেখো
                (data এর স্বাভাবিক গঠন)                      (পরে যা লাগে)

Access-pattern  প্রতিটা query আগে লিখে ফেলো ──> প্রতিটা query এর জন্য data সাজাও
first (NoSQL):  ("কী কী প্রশ্ন করব?")            (দরকারে একই data একাধিক জায়গায়)
```

এটাও তুমি দেখেছ। Lesson 4.4 এ আমাদের Redis key ছিল `tasks:user:{id}` আর `tasks:user:{id}:completed` — **দুটো আলাদা key, কারণ দুটো আলাদা প্রশ্ন।** Redis কে তুমি জিজ্ঞেস করতে পারো না "title এ 'bug' আছে এমন সব task দাও" — কারণ key টা ওই প্রশ্নের জন্য বানানো হয়নি। নতুন প্রশ্ন মানে নতুন key, নতুন data layout।

Cassandra বা DynamoDB র মতো database এ এই নীতিটাই পুরো design এর ভিত্তি। সেখানে একটা ভালো design এর মানে: **প্রতিটা গুরুত্বপূর্ণ query একটা partition থেকে এক চুমুকে উত্তর পায়**, কোনো join ছাড়া। দাম হলো — যে query তুমি আগে ভাবোনি, সেটা হয় খুব ধীর, নয়তো একেবারেই অসম্ভব, যতক্ষণ না data টা নতুন করে সাজাচ্ছ।

> **এক লাইনে:** Relational database **flexibility** দেয় ("পরে যা খুশি জিজ্ঞেস করো"), access-pattern-first database **predictability** দেয় ("যা জিজ্ঞেস করবে বলেছিলে, সেটা যেকোনো scale এ দ্রুত")। দুটো একসাথে পুরোপুরি পাওয়া কঠিন।

### ১.৫ NoSQL এর চারটা Family

"NoSQL" একটা database না — চারটা আলাদা পরিবার, প্রত্যেকে আলাদা সমস্যার জন্য বানানো:

```
KEY-VALUE                        DOCUMENT
─────────                        ────────
"session:abc" → "{...}"          { _id: 42, title: "Fix login",
"tasks:user:7" → "[...]"           assignee: { id: 7, name: "Rahim" },
                                   tags: ["bug", "urgent"],
key দাও, value নাও।               comments: [ {...}, {...} ] }
ভেতরে কী আছে DB জানে না।
                                 পুরো object এক জায়গায় — nested,
                                 ভেতরের field দিয়ে query করা যায়।

WIDE-COLUMN                      GRAPH
───────────                      ─────
partition: project_42            (Rahim)──COLLABORATES──>(Karim)
  ├─ 2026-09-25T10:01 | moved…      │                      │
  ├─ 2026-09-25T10:03 | assigned…   MEMBER_OF          MEMBER_OF
  └─ 2026-09-25T10:07 | commented…  ▼                      ▼
                                 (Team A)             (Team B)
একটা partition key এর নিচে
sorted row — বিশাল পরিমাণ        node আর edge — "বন্ধুর বন্ধু"
লেখার জন্য বানানো।                ধরনের সম্পর্ক খোঁজার জন্য।
```

| Family          | উদাহরণ                        | Best fit                                                           | দুর্বলতা                                                      |
| --------------- | ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Key-value**   | Redis, Memcached, DynamoDB\*  | Cache, session, rate-limit counter — key জানা থাকলে এক lookup      | Value এর ভেতর দিয়ে query প্রায় অসম্ভব                       |
| **Document**    | MongoDB, Couchbase, Firestore | Record ভেদে shape আলাদা, একসাথে পড়া nested data (product catalog) | Document এর বাইরে join দুর্বল; data duplicate হলে update কঠিন |
| **Wide-column** | Cassandra, ScyllaDB, HBase    | বিশাল write volume, time-ordered data (message, event, sensor)     | Ad-hoc query প্রায় নেই; access pattern আগে জানতে হয়         |
| **Graph**       | Neo4j, Amazon Neptune         | গভীর সম্পর্ক — recommendation, fraud ring, "কে কাকে চেনে"          | সাধারণ CRUD আর aggregate এ relational এর চেয়ে সুবিধা কম      |

\* **সৎ সতর্কতা:** এই category গুলোর সীমারেখা ঝাপসা। DynamoDB নিজেকে key-value **এবং** document দুটোই বলে। Redis এ list, sorted set, stream আছে — শুধু "key → string" না। তাই interview এ category মুখস্থ বলার চেয়ে **data model আর access pattern** দিয়ে কথা বলা অনেক বেশি কাজের।

**একটা বাস্তব উদাহরণ (Discord):** Discord তাদের engineering blog এ লিখেছে, ২০১৭ সালে তারা message storage MongoDB থেকে Cassandra তে সরিয়েছিল, আর ২০২৩ এ Cassandra থেকে ScyllaDB তে (Cassandra-compatible)। কারণটা লক্ষ করো — তাদের মূল access pattern প্রায় একটাই: **"channel X এর সর্বশেষ N টা message"**। বিশাল write volume, time-ordered, join লাগে না। এটা wide-column এর জন্য হুবহু বানানো সমস্যা। তারা "NoSQL ভালো" বলে সরেনি — **একটা নির্দিষ্ট access pattern আর একটা মাপা scale সমস্যা** দেখে সরেছে।

### ১.৬ সবচেয়ে বড় Myth — "SQL scale করে না"

এবার নতুন engineer এর তৃতীয় দাবি। এর পেছনে একটা সত্য আছে, কিন্তু সেটা যেভাবে বলা হয় সেভাবে না।

**যেটা সত্য:** Cassandra, DynamoDB র মতো অনেক NoSQL system **প্রথম দিন থেকেই** অনেকগুলো machine এ data ভাগ করে রাখার জন্য design করা। Node যোগ করো, data নিজে থেকে ছড়িয়ে যায়। (এই "ভাগ করা" টাই sharding — Lesson 5.8, আর কীভাবে ভাগ হয় সেটা consistent hashing — Lesson 10.1)

**যেটা লুকিয়ে থাকে:** এই সহজ horizontal scaling এর **দাম** — cross-partition join নেই, আর একাধিক partition জুড়ে transaction হয় নেই নয়তো সীমিত আর দামি। মানে তারা ১.২ এর দুটো শক্তি — flexible query আর multi-row transaction — **ছেড়ে দিয়ে** scale কিনেছে। এটা free lunch না, এটা একটা trade-off।

**যেটা ভুল:** "SQL scale করে না।" বাস্তবে:

- একটা ভালো hardware এ একটা PostgreSQL instance অনেক বড় workload সামলাতে পারে — ঠিক কত, সেটা query, index আর hardware ভেদে বিশাল পরিমাণে আলাদা, তাই কোনো একটা সংখ্যা বিশ্বাস কোরো না, **নিজের workload এ মাপো**
- Read বাড়লে → read replica (Lesson 5.7)
- Write বাড়লে → partitioning ও sharding (Lesson 5.8), Citus বা Vitess এর মতো tool
- একেবারে শুরু থেকে distributed SQL চাইলে → CockroachDB, YugabyteDB, Google Spanner (একে অনেকে "NewSQL" বলে)

আর উল্টো দিক থেকেও সীমারেখা মুছে যাচ্ছে — MongoDB ২০১৮ সালে (version 4.0) multi-document ACID transaction যোগ করেছে। মানে আজকের দিনে "SQL = transaction, NoSQL = scale" — এই সরল ভাগটা আর সত্য না।

**TaskFlow এর সংখ্যা দিয়ে যাচাই করি (Lesson 1.3 এর মতো):** ধরো TaskFlow এখন ১,০০,০০০ DAU, প্রতিজন দিনে গড়ে ২০টা write (task তৈরি, status বদল, comment)।

```
১,০০,০০০ × ২০ = ২০,০০,০০০ write/দিন
২০,০০,০০০ ÷ ৮৬,৪০০ সেকেন্ড ≈ ২৩ write/সেকেন্ড (গড়)
Peak (গড়ের ~৫ গুণ ধরলে)      ≈ ১২০ write/সেকেন্ড
```

সেকেন্ডে ১২০টা write — এটা একটা সাধারণ Postgres instance এর জন্য খুবই আরামদায়ক এলাকা। মানে **"scale" এর যুক্তিতে TaskFlow এর এখন database বদলানোর কোনো কারণ নেই।** এটাই সবচেয়ে গুরুত্বপূর্ণ শিক্ষা: scale এর দাবি সবসময় **সংখ্যা দিয়ে** যাচাই করো, অনুভূতি দিয়ে না।

### ১.৭ সিদ্ধান্ত নেওয়ার Framework — আর TaskFlow এর উত্তর

নতুন database বেছে নেওয়ার আগে পাঁচটা প্রশ্ন:

```
১. Data এর shape কেমন?        ── অনেক সম্পর্ক, অনেক join? নাকি self-contained record?
২. Access pattern কি জানা?     ── প্রশ্নগুলো স্থির? নাকি নতুন report প্রায়ই আসবে?
৩. Consistency কতটা দরকার?     ── একাধিক record একসাথে বদলাতে হয়? টাকা-পয়সা?
৪. Scale এর সংখ্যা কত?         ── estimation করো (১.৬ এর মতো), অনুমান না
৫. Team আর operations?         ── কে চালাবে, backup কীভাবে, কে on-call এ জাগবে?
```

শেষ প্রশ্নটা হালকা করে দেখো না। প্রতিটা নতুন database মানে নতুন backup strategy, নতুন monitoring, নতুন failure mode, আর রাত ৩টায় সেটা debug করতে পারে এমন কাউকে দরকার।

**Polyglot persistence** — একটা system এ একাধিক ধরনের database, প্রতিটা নিজের কাজের জন্য। মজার ব্যাপার — TaskFlow **ইতিমধ্যেই** polyglot: Postgres (সত্যের উৎস) + Redis (cache)। ভবিষ্যতে আরও আসবে — file এর জন্য object storage (Lesson 8.1), full-text search এর জন্য search engine (Lesson 8.3)। তাই প্রশ্নটা কখনো "SQL **নাকি** NoSQL" না — প্রশ্নটা "**এই নির্দিষ্ট data আর access pattern** এর জন্য কোনটা?"

এবার TaskFlow এর প্রথম feature — custom fields। এর জন্য কি পুরো app MongoDB তে নিতে হবে? না। Postgres এর `JSONB` column ঠিক এই কাজের জন্য — **structured core + flexible কিনারা**:

```typescript
import {
	DataTypes,
	Model,
	Op,
	Sequelize,
	type CreationOptional,
	type InferAttributes,
	type InferCreationAttributes
} from 'sequelize';

type CustomFieldValue = string | number | boolean;

export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare projectId: number;
	declare title: string; // core field — DB enforce করে (schema-on-write)
	declare customFields: CreationOptional<Record<string, CustomFieldValue>>; // flexible কিনারা
}

Task.init(
	{
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		projectId: { type: DataTypes.INTEGER, allowNull: false },
		title: { type: DataTypes.STRING, allowNull: false },
		customFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
	},
	{ sequelize, tableName: 'tasks', indexes: [{ fields: ['customFields'], using: 'gin' }] }
);

// "এই project এর যেসব task এ sprint = N" — JSONB containment (@>) query
export async function tasksInSprint(projectId: number, sprint: number): Promise<Task[]> {
	return Task.findAll({
		where: {
			[Op.and]: [
				{ projectId },
				Sequelize.where(
					Sequelize.col('customFields'),
					Op.contains,
					Sequelize.cast(JSON.stringify({ sprint }), 'jsonb')
				)
			]
		}
	});
}
// তৈরি হওয়া SQL: ... WHERE ("Task"."projectId" = 42
//                      AND "customFields" @> CAST('{"sprint":14}' AS JSONB))
```

এখানে দুটো non-obvious সিদ্ধান্ত আছে, দুটোই যাচাই করা:

- **কেন `@>` (containment)?** GIN index এই operator টা ব্যবহার করতে পারে। Sequelize এর সহজ nested syntax (`customFields: { sprint: 14 }`) দিলে SQL হয় `CAST(("customFields"#>>'{sprint}') AS DOUBLE PRECISION) = 14` — ওটা এই index ধরতে পারে না। ৩ লাখ row এর একটা Postgres 17 table এ `EXPLAIN` চালিয়ে দেখা গেছে: `@>` query তে **Bitmap Index Scan**, nested query তে **পুরো table এর Seq Scan**। কেন এমন হয়, সেটা Lesson 5.4 (Indexing) এ পরিষ্কার হবে।
- **কেন `Sequelize.where(...)`, সরাসরি `customFields: { [Op.contains]: {...} }` না?** Runtime এ দুটোই একই `@>` বানায়। কিন্তু Sequelize v6 এর type definition এ `Op.contains` শুধু array আর range এর জন্য টাইপ করা — JSONB object দিলে `tsc` error দেয়। `as` বা `any` দিয়ে চাপা দেওয়ার বদলে (main.md §৬) আমরা `Sequelize.where` ব্যবহার করেছি, যেটা টাইপ-সঠিক আর একই SQL বানায়। Library এর type আর runtime সবসময় মেলে না — এটা সৎভাবে জানা আর সামলানোও শেখার অংশ।

আর মনে রেখো — `customFields` এখন **schema-on-read** এলাকা। DB শুধু নিশ্চিত করে এটা valid JSON; ভেতরে `sprint` number নাকি string, সেটা API layer এ Zod দিয়ে যাচাই করতে হবে। দুই দুনিয়ার সেরাটা নিয়েছি, কিন্তু সাথে দুই দুনিয়ার দায়িত্বও।

দ্বিতীয় feature — activity log — কি wide-column database এর কাজ? এটা তোমার আজকের exercise এর অংশ। 😉

---

## ২. Interview Angle

**সবচেয়ে common ফাঁদ:** "Database কোনটা নেবে?" জিজ্ঞেস করলে সাথে সাথে "MongoDB, কারণ এটা scale করে" বা "Postgres, কারণ এটা reliable" বলা। দুটো উত্তরই দুর্বল — কারণ কোনোটাই **requirement এর সাথে যুক্ত না।**

**ভালো উত্তরের কাঠামো** (Lesson 1.2 এর framework এর সাথে মেলাও):

1. **Access pattern বলো:** "এই system এ মূল read হলো X, মূল write হলো Y"
2. **Consistency need বলো:** "Payment আছে, তাই multi-row transaction দরকার" অথবা "Like count কয়েক সেকেন্ড পিছিয়ে থাকলেও চলে"
3. **সংখ্যা বলো:** "Estimation অনুযায়ী peak এ ~N write/s" — তারপর সিদ্ধান্ত
4. **Trade-off স্বীকার করো:** "Cassandra নিলে write scale পাব, কিন্তু ad-hoc analytics query হারাব — সেজন্য data টা আলাদা analytics store এ পাঠাব"

**Common follow-up গুলো:**

- _"পরে যদি একটা নতুন field দিয়ে query করতে হয়?"_ — Relational এ index যোগ করো; access-pattern-first design এ হয়তো নতুন table বা secondary index, দরকারে data duplicate করা লাগবে
- _"Document database এ দুটো document একসাথে atomically update করবে কীভাবে?"_ — Multi-document transaction (যদি DB support করে, আর দামটা জানো), অথবা data model এমনভাবে সাজাও যাতে atomic update টা একটা document এর ভেতরেই থাকে
- _"SQL কি horizontally scale করে?"_ — ১.৬ এর উত্তর: হ্যাঁ, read replica আর sharding দিয়ে, অথবা distributed SQL দিয়ে — তবে কাজটা বেশি manual আর join/transaction এর দাম বাড়ে

**Production এ বাস্তবে:** বেশিরভাগ product company তে core business data (user, order, payment) relational database এ থাকে, আর নির্দিষ্ট কাজের জন্য পাশে বিশেষ store — cache এর জন্য Redis, search এর জন্য Elasticsearch/OpenSearch, event এর জন্য Kafka। "আমরা পুরোটা NoSQL এ" — এটা ব্যতিক্রম, নিয়ম না।

---

## ৩. Key Takeaway

- "SQL vs NoSQL" এর আসল পার্থক্য query language না — **data model, schema কোথায় enforce হয়, query flexibility, আর guarantee**
- "Schemaless" বলে কিছু নেই — schema হয় **DB তে (schema-on-write)**, নয়তো **তোমার code এ (schema-on-read)**; migration উধাও হয় না, জায়গা বদলায়
- Relational: আগে data, পরে যেকোনো প্রশ্ন। Access-pattern-first: আগে প্রশ্ন, সেই মতো data — **flexibility vs predictability**
- NoSQL চারটা family — key-value, document, wide-column, graph — প্রত্যেকে আলাদা সমস্যার জন্য; সীমারেখা ঝাপসা
- NoSQL এর সহজ horizontal scale এর দাম হলো join আর cross-partition transaction ছেড়ে দেওয়া; আর SQL **scale করে** — replica, sharding, distributed SQL দিয়ে
- Scale এর দাবি সবসময় **estimation এর সংখ্যা দিয়ে** যাচাই করো
- প্রশ্নটা "SQL নাকি NoSQL" না — "এই data আর এই access pattern এর জন্য কোনটা" (**polyglot persistence**); ভালো default: শুরু করো Postgres দিয়ে, বদলাও মাপা কারণ পেলে

---

## ৪. নতুন Term (Glossary)

| Term                     | অর্থ                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| **Relational Model**     | Data কে table/row এ রাখা, আর table গুলোর সম্পর্ক foreign key দিয়ে প্রকাশ করা             |
| **Schema-on-write**      | লেখার সময়েই database data এর shape যাচাই করে — ভুল data ঢুকতে পারে না                    |
| **Schema-on-read**       | Database যাচাই করে না; পড়ার সময় application data এর shape ঠিক করে ও যাচাই করে           |
| **Access Pattern**       | Application ঠিক কোন কোন ভাবে data পড়ে ও লেখে — NoSQL design এর শুরুর বিন্দু              |
| **Document Store**       | Nested, self-contained record (সাধারণত JSON-এর মতো) রাখার database — যেমন MongoDB         |
| **Wide-column Store**    | Partition key এর নিচে sorted row রাখে, বিশাল write volume এর জন্য বানানো — যেমন Cassandra |
| **Polyglot Persistence** | একই system এ একাধিক ধরনের database, প্রতিটা যে কাজে সবচেয়ে উপযুক্ত সেই কাজে              |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. নতুন engineer বলল "MongoDB তে গেলে আর কখনো migration লিখতে হবে না।" ছয় মাস পরে, যখন `assignee` field এর shape বদলাতে হবে, তখন ঠিক কী কী সমস্যা হবে? আর সেগুলো সামলানোর দুটো উপায় কী?
2. Discord এর message storage এর উদাহরণে — ঠিক কোন বৈশিষ্ট্যগুলো wide-column database কে উপযুক্ত বানিয়েছিল? যদি Discord কে হঠাৎ "গত মাসে সবচেয়ে বেশি emoji ব্যবহার করা ১০ জন user" বের করতে হয়, তাহলে ওই design এ কী সমস্যা হবে?
3. TaskFlow এ একটা report চাই: "প্রতিটা team এ গত ৩০ দিনে কে সবচেয়ে বেশি task শেষ করেছে।" Postgres এ এটা কতটা কঠিন? আর TaskFlow যদি পুরোপুরি access-pattern-first ধরনের database এ থাকত, যেখানে এই report আগে থেকে ভাবা হয়নি — তাহলে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Database এ তখন **দুই shape এর document** থাকবে — পুরনোগুলোতে `assignee` string, নতুনগুলোতে object। প্রতিটা read path কে দুটোই সামলাতে হবে; কোথাও একটা ভুলে গেলে production এ `Cannot read properties of undefined` জাতীয় error — আর সেটা শুধু **পুরনো** data তে, তাই test এ ধরা পড়া কঠিন। সামলানোর দুটো উপায়:

- **Lazy migration** — পড়ার সময় পুরনো shape দেখলে নতুন shape এ বদলে আবার লিখে দাও; code এ একটা version field (`schemaVersion: 2`) রাখা ভালো, আর Zod এর মতো কিছু দিয়ে দুটো version parse করো
- **Backfill** — একটা background script দিয়ে সব পুরনো document একবারে বদলে দাও — যেটা আসলে একটা migration ই

মানে migration উধাও হয়নি, শুধু database থেকে code এ সরে এসেছে।

**প্রশ্ন ২:** বৈশিষ্ট্যগুলো: (ক) access pattern প্রায় একটাই আর স্থির — "channel X এর সর্বশেষ N message"; (খ) data time-ordered, তাই একটা partition এর ভেতরে sorted রাখলে এক চুমুকে পড়া যায়; (গ) বিশাল write volume, আর message প্রায় কখনো update হয় না; (ঘ) join লাগে না। "সবচেয়ে বেশি emoji ব্যবহারকারী ১০ জন" একটা **ad-hoc, সব partition জুড়ে aggregate** — ঠিক সেই query যেটার জন্য design টা বানানো হয়নি। পুরো data scan করতে হবে, যা অসম্ভব রকম ধীর আর cluster এর উপর চাপ। বাস্তব সমাধান: এই ধরনের প্রশ্নের জন্য data আলাদা analytics system এ পাঠানো (Lesson 7.6 এর OLTP vs OLAP), অথবা আগে থেকে একটা counter আলাদা করে রাখা।

**প্রশ্ন ৩:** Postgres এ এটা একটা query — `tasks` কে `users` আর `team` এর সাথে join করে, `completedAt` দিয়ে filter, `GROUP BY` আর `ORDER BY` — হয়তো ১৫ মিনিটের কাজ (data বেশি হলে একটা index লাগতে পারে)। Access-pattern-first database এ, যেখানে data সাজানো আছে "user এর task" বা "project এর task" হিসেবে, "team জুড়ে ৩০ দিনের aggregate" এর জন্য কোনো partition বানানো নেই। বিকল্প: পুরো scan (ধীর, দামি), নতুন একটা table/counter বানিয়ে **এখন থেকে** সেটা আপডেট করা (কিন্তু পুরনো data এর জন্য backfill লাগবে), অথবা data একটা analytics store এ export করা। এটাই ১.৪ এর "flexibility vs predictability" trade-off এর বাস্তব চেহারা — আর TaskFlow এর মতো product এ, যেখানে নতুন report প্রায়ই চাওয়া হয়, flexibility অনেক দামি।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

আমি এখনই model answer দিচ্ছি না — তুমি চেষ্টা করার পর critique করব।

> TaskFlow এ চারটা নতুন feature আসছে। প্রতিটার জন্য ঠিক করো data কোথায় রাখবে — **বিদ্যমান Postgres এ** (দরকারে `JSONB` বা নতুন table সহ), **Redis এ**, নাকি **একটা নতুন database** যোগ করবে (কোন family)।
>
> 1. **Custom fields** — প্রতি project এ ২০টা পর্যন্ত নিজস্ব field, সেগুলো দিয়ে filter করা যাবে (আজকের lesson এ একটা উত্তর দেখেছ — এখন নিজে যাচাই করো, এর দুর্বলতা কী?)
> 2. **Activity log** — প্রতিটা ঘটনার record ("রহিম task #42 কে Done এ সরিয়েছে"); project এর পাতায় সর্বশেষ ৫০টা দেখাবে; ১ বছর রাখতে হবে। ধরো ১,০০,০০০ DAU, প্রতিজন দিনে গড়ে ৫০টা ঘটনা তৈরি করে, প্রতিটা record ~২০০ byte।
> 3. **"কার সাথে কাজ করতে পারো"** — একজন user এর collaborator দের collaborator, যাদের সাথে সে এখনো কোনো project এ নেই, তাদের suggestion
> 4. **Online presence** — এই মুহূর্তে project এ কে কে online আছে (সবুজ বিন্দু)
>
> প্রতিটার জন্য লেখো:
>
> - **(ক)** Data এর shape আর মূল access pattern
> - **(খ)** Consistency কতটা দরকার — কয়েক সেকেন্ড পিছিয়ে থাকলে কি চলবে?
> - **(গ)** তোমার পছন্দ, আর **কী ছেড়ে দিচ্ছ** (trade-off)
>
> Feature ২ এর জন্য আগে **estimation** করো (Lesson 1.3): দিনে কত write, সেকেন্ডে গড়ে আর peak এ কত, আর এক বছরে মোট storage কত — তারপর সিদ্ধান্ত নাও। সংখ্যাটাই তোমার যুক্তির ভিত্তি হওয়া উচিত, অনুভূতি না।

**Hint (শুধু আটকে গেলে পড়ো):** চারটার উত্তর এক না হওয়াটাই স্বাভাবিক। আর মনে রেখো — নতুন database যোগ করার দামও (১.৭ এর প্রশ্ন ৫) হিসাবের মধ্যে ধরতে হবে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (সম্পূর্ণ)
Current: 5.1 — SQL vs NoSQL: আসল Trade-off
TaskFlow state: Nginx reverse proxy + LB, ৪টা Express instance, CDN,
Redis caching layer (Cache-Aside + single-flight), একটা PostgreSQL primary;
নতুন feature request: custom fields (JSONB প্রস্তাবিত) আর activity log
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 5.2 — Schema & Data Modeling (normalization, denormalization, Sequelize model দিয়ে)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষ করে activity log এর estimation টা, কারণ ওই সংখ্যা থেকেই বোঝা যাবে সিদ্ধান্তটা যুক্তির উপর দাঁড়িয়ে আছে কিনা। রেডি হলে `next` লিখো — Lesson 5.2 এ যাব: **Schema & Data Modeling** — normalization কী আর কেন, কখন ইচ্ছা করে denormalize করতে হয় (আর তার দাম), সব কিছু TaskFlow এর Sequelize model দিয়ে, hands-on।
