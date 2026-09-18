# Lesson 4.2 — Caching Strategies: Cache-Aside, Read-Through, Write-Through, Write-Behind

**Module 4 — Caching**

> **Spaced Repetition (Lesson 1.6):** Stateless server বলতে কী বোঝায়, আর কেন stateless হলে horizontal scaling সহজ হয়ে যায়? (এক-দুই লাইনে বলো)

**Prerequisite:** Lesson 4.1 (Cache Hierarchy), Lesson 1.6 (Stateless vs Stateful)

**তুমি এই lesson শেষে পারবে:**

1. Read path আর write path — এই দুটোর জন্য আলাদা আলাদা caching strategy আছে কেন, সেটা বুঝবে
2. Cache-Aside, Read-Through, Write-Through, Write-Behind — চারটা pattern এর কাজ করার ধরন আর trade-off বলতে পারবে
3. TaskFlow এর একটা নির্দিষ্ট endpoint দেখে কোন strategy উপযুক্ত, সেটা যুক্তি দিয়ে বেছে নিতে পারবে

**Tier:** 3 — Design Exercise (hands-on Redis implementation Lesson 4.4 তে)

---

## ০. TaskFlow এখন কোথায়

গত lesson এ আমরা পুরো cache hierarchy দেখেছি — browser থেকে database পর্যন্ত কোথায় কোথায় cache বসতে পারে। TaskFlow এর জন্য সিদ্ধান্ত হয়েছে: `/api/tasks` এর মতো personalized data এর জন্য **application-level cache** (Redis) দরকার, কারণ browser বা CDN এ এটা রাখা যায় না।

কিন্তু "Redis বসাব" বলে দিলেই কাজ শেষ হয় না। সাথে সাথেই একগাদা প্রশ্ন চলে আসে:

- Data টা Redis এ **কে** রাখবে — তোমার Express code, নাকি cache নিজে?
- Cache এ না পেলে (miss) **কে** database এ যাবে?
- আর সবচেয়ে কঠিন প্রশ্ন — user যখন একটা task **update** করবে, তখন Redis এ পড়ে থাকা পুরনো copy টার কী হবে?

লক্ষ্য করো, শেষ প্রশ্নটা আগের দুটোর চেয়ে আলাদা জাতের। প্রথম দুটো **read** নিয়ে, শেষেরটা **write** নিয়ে। এই পার্থক্যটাই আজকের পুরো lesson এর ভিত্তি — caching strategy আসলে দুই ভাগে ভাগ করা: read কীভাবে হবে, আর write কীভাবে হবে।

---

## ১. Theory

### ১.১ কেন read আর write আলাদা করে ভাবতে হয়

একটা cache মূলত দুইটা আলাদা প্রশ্নের উত্তর দেয়:

```
READ path :  data চাই → cache এ আছে? → না থাকলে কোথা থেকে আনব, আর কে আনবে?
WRITE path:  data বদলাচ্ছে → DB তে লিখব কখন, cache এ লিখব কখন, কোনটা আগে?
```

Read path এর strategy ঠিক করে তোমার **latency আর DB load** কেমন হবে। Write path এর strategy ঠিক করে তোমার **consistency আর durability** কেমন হবে — অর্থাৎ cache আর DB এর মধ্যে কতক্ষণ অমিল থাকতে পারে, আর হঠাৎ crash হলে data হারানোর ঝুঁকি কতটা।

এই দুটো আলাদা করে না ভাবলে interview এ গুলিয়ে ফেলবে, আর production এ এমন bug পাবে যেটা reproduce করাই কঠিন।

### ১.২ Cache-Aside (Lazy Loading) — সবচেয়ে বেশি ব্যবহৃত

এখানে **application নিজে** cache আর database দুটোকেই সরাসরি manage করে। Cache নিজে database এর অস্তিত্বই জানে না — সে শুধু একটা key-value box।

```
READ:
  App ──1── "tasks:user:42 আছে?" ──> [Redis]
                                       │
              HIT: value ফেরত <────────┘  → শেষ, DB পর্যন্ত যাওয়াই লাগল না
              MISS: null <──────────────┘
   │
   2── DB থেকে query করো ──> [PostgreSQL]
   3── result টা Redis এ লিখে রাখো (TTL সহ)
   4── client কে result দাও
```

তোমার stack এ এটা দেখতে এরকম:

```typescript
import type { Redis } from 'ioredis';

interface TaskDTO {
	id: number;
	title: string;
	completed: boolean;
}

const TASKS_TTL_SECONDS = 300;

async function getTasksForUser(redis: Redis, userId: number): Promise<TaskDTO[]> {
	const cacheKey = `tasks:user:${userId}`;

	// ধাপ ১ — আগে cache এ দেখো
	const cached = await redis.get(cacheKey);
	if (cached !== null) {
		// Redis থেকে আসা string টা runtime input — সরাসরি বিশ্বাস করা যায় না,
		// তাই JSON.parse এর ফল unknown ধরে নেওয়া হচ্ছে।
		const parsed: unknown = JSON.parse(cached);
		if (Array.isArray(parsed)) {
			// `as` এখানে ব্যবহার করতে হচ্ছে কারণ Array.isArray শুধু unknown[] পর্যন্ত
			// narrow করে — ভেতরের element গুলো সত্যিই TaskDTO কিনা সেটা যাচাই করে না।
			// অর্থাৎ এটা একটা অসম্পূর্ণ, সাময়িক সমাধান। Lesson 4.4 এ আমরা এটাকে Zod
			// schema দিয়ে সরিয়ে দেব, তখন `as` এর আর দরকারই থাকবে না।
			return parsed as TaskDTO[];
		}
	}

	// ধাপ ২ — cache miss, তাই DB তে যাও
	const rows = await Task.findAll({ where: { userId } });
	const tasks: TaskDTO[] = rows.map((row) => ({
		id: row.id,
		title: row.title,
		completed: row.completed
	}));

	// ধাপ ৩ — পরেরবারের জন্য cache এ রেখে দাও
	await redis.set(cacheKey, JSON.stringify(tasks), 'EX', TASKS_TTL_SECONDS);

	return tasks;
}
```

**"Lazy" কেন?** কারণ data টা cache এ ঢোকে **শুধু তখনই, যখন কেউ প্রথমবার সেটা চায়**। আগে থেকে কিছু ভরে রাখা হয় না। ফলে cache এ শুধু সেই data-ই জমে যেটা আসলে কেউ পড়ছে — memory নষ্ট হয় না।

**সুবিধা:** সহজ, সরাসরি, আর **cache down হয়ে গেলেও app বাঁচে** — Redis উত্তর না দিলে প্রতিটা request DB তে চলে যাবে (ধীর হবে, কিন্তু ভাঙবে না)। এই "cache optional" ব্যাপারটাই এর সবচেয়ে বড় শক্তি।

**অসুবিধা:** প্রতিটা cache miss এ **তিনটা round trip** (Redis → DB → Redis)। আর প্রথম request সবসময় ধীর — এটাকে বলে **cold start**।

### ১.৩ Read-Through — cache নিজেই DB থেকে আনে

Cache-Aside এর সাথে পার্থক্য একটাই, কিন্তু গুরুত্বপূর্ণ: এখানে **application সরাসরি DB এর সাথে কথা বলে না**। App শুধু cache কে জিজ্ঞেস করে; miss হলে **cache নিজে** DB থেকে এনে, নিজের কাছে রেখে, তারপর app কে দেয়।

```
Cache-Aside :  App ──> Cache
               App ──> DB          (miss হলে App নিজে DB তে যায়)

Read-Through:  App ──> Cache ──> DB   (App শুধু Cache কে চেনে)
```

এতে application code পরিষ্কার থাকে — caching logic টা একটা library বা cache layer এর ভেতরে লুকানো থাকে। কিন্তু দাম হলো, তোমার একটা এমন cache layer লাগবে যে DB থেকে load করতে জানে (একটা "loader function" সহ)। Redis নিজে থেকে এটা করে না — তোমাকে একটা wrapper লিখতে হয়, বা এমন library ব্যবহার করতে হয় যেটা এই pattern দেয়।

**বাস্তবে:** Node.js ecosystem এ বিশুদ্ধ Read-Through তুলনামূলক কম দেখা যায়; বেশিরভাগ team Cache-Aside লেখে, তারপর সেটাকে একটা helper function এ মুড়ে ফেলে — যেটা কার্যত Read-Through এর কাছাকাছি চলে আসে।

### ১.৪ Write-Through — cache আর DB, দুটোতেই একসাথে লেখো

এবার write path। Write-Through এ প্রতিটা write **cache আর DB দুটোতেই** যায়, এবং দুটো শেষ হওয়ার পরেই client কে success বলা হয়।

```
WRITE:
  App ──> [Cache এ লেখো] ──> [DB তে লেখো] ──> তারপর client কে 200 দাও
          └──────────── দুটোই শেষ হলে তবেই success ────────────┘
```

**সুবিধা:** Cache কখনো "বাসি" (stale) হয় না — write শেষ হওয়ার সাথে সাথেই cache এ নতুন value আছে। পরের read সবসময় cache hit, আর সেটা সঠিক।

**অসুবিধা:** প্রতিটা write এখন **ধীর**, কারণ দুই জায়গায় লিখতে হচ্ছে। আর একটা লুকানো অপচয় আছে — এমন data ও cache এ ঢুকে যায় যেটা হয়তো কেউ কখনো পড়বেই না। TaskFlow এ কেউ যদি bulk এ ৫০০টা task import করে, Write-Through সবগুলোকেই cache এ ভরে দেবে, যদিও হয়তো user শুধু প্রথম পাতার ২০টা দেখবে।

এই সমস্যার একটা সরাসরি উত্তর আছে — **Write-Around**: write শুধু DB তে যায়, cache কে ছোঁয়াই হয় না (বা শুধু পুরনো key টা মুছে দেওয়া হয়)। data টা cache এ ঢুকবে তখনই, যখন কেউ সেটা আসলে পড়তে চাইবে। Write-heavy কিন্তু read-কম এমন data এর জন্য এটাই স্বাভাবিক পছন্দ — যেমন audit log।

### ১.৫ Write-Behind (Write-Back) — আগে cache, DB পরে

সবচেয়ে দ্রুত, আর সবচেয়ে ঝুঁকিপূর্ণ। এখানে write শুধু **cache এ** যায়, আর সাথে সাথেই client কে success বলে দেওয়া হয়। DB তে লেখাটা হয় পরে, background এ — সাধারণত কয়েকটা write জমিয়ে একসাথে (batch)।

```
WRITE:
  App ──> [Cache এ লেখো] ──> সাথে সাথে client কে 200 দাও
                │
                └── (background) কিছুক্ষণ পর, জমানো write গুলো একসাথে ──> [DB]
```

**সুবিধা:** Write latency প্রায় in-memory এর সমান — অসাধারণ দ্রুত। আর DB তে write এর চাপ অনেক কমে যায়, কারণ ১০০টা আলাদা write একটা batch এ পরিণত হয়।

**অসুবিধা, আর এটা গুরুতর:** DB তে লেখার **আগেই** যদি cache node টা crash করে, তাহলে ওই write গুলো **চিরতরে হারিয়ে যায়** — অথচ client কে আগেই "success" বলে দেওয়া হয়েছে। মানে তুমি durability এর বিনিময়ে speed কিনছ।

**তাহলে কখন ব্যবহার করব?** যখন data হারানোটা সহনীয়, আর write এর পরিমাণ বিশাল। ক্লাসিক উদাহরণ — view counter, "কতবার দেখা হয়েছে" জাতীয় metric। TaskFlow এ কোন task কতবার খোলা হয়েছে সেই counter টা Write-Behind এ রাখা যুক্তিসঙ্গত; কিন্তু task টা নিজে **কখনোই না** — কেউ task তৈরি করে "saved" দেখার পর সেটা উধাও হয়ে গেলে সেটা ক্ষমার অযোগ্য।

### ১.৬ চারটা একসাথে

> **Trade-off Table — কোন Strategy কখন**

| Strategy          | Read কে করে | Write কোথায় যায়       | মূল সুবিধা                     | মূল ঝুঁকি                              | TaskFlow এ উপযুক্ত                   |
| ----------------- | ----------- | ----------------------- | ------------------------------ | -------------------------------------- | ------------------------------------ |
| **Cache-Aside**   | App নিজে    | (write path আলাদা)      | সহজ; cache down হলেও app চলে   | প্রতি miss এ ৩ round trip; cold start  | `GET /api/tasks` — **default পছন্দ** |
| **Read-Through**  | Cache নিজে  | (write path আলাদা)      | App code পরিষ্কার থাকে         | আলাদা cache layer/library লাগে         | অনেক endpoint এ একই pattern লাগলে    |
| **Write-Through** | —           | Cache + DB, দুটোই sync  | Cache কখনো stale হয় না        | Write ধীর; অপ্রয়োজনীয় data ও cache এ | User profile — কম লেখা, বেশি পড়া    |
| **Write-Behind**  | —           | আগে Cache, DB পরে async | Write অসম্ভব দ্রুত; DB load কম | **Crash হলে data loss**                | View counter — হারালেও চলে           |
| **Write-Around**  | —           | শুধু DB                 | Cache এ আবর্জনা জমে না         | পরের read টা নিশ্চিত miss              | Bulk import, audit log               |

**বাস্তবে সবচেয়ে common জোড়া:** **Cache-Aside (read) + Write-Around/invalidate (write)**। মানে — পড়ার সময় lazy load করো, আর লেখার সময় DB তে লিখে সংশ্লিষ্ট cache key টা **মুছে দাও**। পরের কেউ যখন পড়তে আসবে, তখন সে নতুন data দিয়ে cache টা আবার ভরে দেবে।

কিন্তু "key টা মুছে দাও" শুনতে যত সহজ, বাস্তবে তত না — কোন কোন key মুছতে হবে, কখন মুছতে হবে, আর মোছার ঠিক আগমুহূর্তে যদি কেউ পড়ে ফেলে? এই পুরো জট নিয়েই পরের lesson (4.3)।

---

## ২. Interview Angle

এই topic এ প্রশ্ন প্রায় সবসময় একই জায়গা থেকে শুরু হয় — **"তোমার system এ caching কীভাবে করবে?"** দুর্বল উত্তর হলো "Redis ব্যবহার করব"। ভালো উত্তর হলো read path আর write path আলাদা করে বলা: _"Read এ Cache-Aside — key হবে `tasks:user:{id}`, TTL ৫ মিনিট। Write এ DB তে লিখে ওই key টা invalidate করব।"_ এইটুকু বললেই তুমি বাকিদের থেকে আলাদা হয়ে যাবে, কারণ তুমি দেখাচ্ছ যে caching মানে শুধু পড়া না।

সবচেয়ে common follow-up: **"Write-Behind এ data loss হতে পারে জেনেও কেউ কেন সেটা ব্যবহার করবে?"** — এখানে interviewer দেখতে চায় তুমি trade-off ভাষায় চিন্তা করতে পারো কিনা। উত্তরে data এর **প্রকৃতি** ধরে বলো: view counter হারালে কেউ টেরই পাবে না, কিন্তু payment বা task creation হারানো যাবে না। "এই design টা সেরা" বলার বদলে "এই data এর জন্য এই দামটা দেওয়া যায়" বলাটাই পরিণত উত্তর।

আরেকটা প্রশ্ন আসে: **"Cache-Aside এ cache down হলে কী হয়?"** — উত্তর: app চলতে থাকে, শুধু ধীর হয়ে যায়, কারণ সব request DB তে যায়। কিন্তু সাথে এটাও যোগ করো যে হঠাৎ পুরো load DB তে পড়লে সেটা DB কে ধসিয়ে দিতে পারে — এটাই **thundering herd**, Lesson 4.6 এর বিষয়।

---

## ৩. Key Takeaway

- Caching strategy দুই ভাগে ভাবতে হয় — **read path** (latency, DB load) আর **write path** (consistency, durability)
- **Cache-Aside**: app নিজে cache আর DB manage করে; সবচেয়ে common, আর cache down হলেও app বাঁচে
- **Read-Through**: cache নিজে DB থেকে load করে; app code পরিষ্কার, কিন্তু আলাদা cache layer লাগে
- **Write-Through**: cache + DB দুটোতেই sync লেখা; cache কখনো stale হয় না, কিন্তু write ধীর
- **Write-Behind**: আগে cache, DB তে পরে; দ্রুততম, কিন্তু crash এ data loss — শুধু "হারালেও চলে" এমন data তে
- **Write-Around**: শুধু DB তে লেখা; bulk/write-heavy data এ cache কে আবর্জনা থেকে বাঁচায়
- বাস্তবে সবচেয়ে বেশি ব্যবহৃত জোড়া — **Cache-Aside + write এ invalidate**
- কোনো strategy "সেরা" না; data টা কতটা গুরুত্বপূর্ণ আর কত ঘন ঘন পড়া/লেখা হয়, সেটাই ঠিক করে দেয়

---

## ৪. নতুন Term (Glossary)

| Term                           | অর্থ                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| **Cache-Aside (Lazy Loading)** | App নিজে cache check করে, miss হলে নিজেই DB থেকে এনে cache এ ভরে               |
| **Read-Through**               | Cache নিজে DB থেকে data load করে; app শুধু cache এর সাথে কথা বলে               |
| **Write-Through**              | প্রতিটা write cache আর DB — দুটোতেই sync ভাবে যায়, তারপর success              |
| **Write-Behind (Write-Back)**  | Write আগে শুধু cache এ, DB তে পরে background/batch এ — দ্রুত কিন্তু ঝুঁকিপূর্ণ |
| **Write-Around**               | Write শুধু DB তে যায়, cache bypass করে; data cache এ ঢোকে প্রথম read এর সময়  |
| **Cold Start**                 | Cache খালি থাকায় শুরুর দিকের request গুলো সবই miss হয়ে DB তে যাওয়ার অবস্থা  |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর Answer Key খুলো।

1. TaskFlow এ একটা নতুন feature আসছে — প্রতিটা task এ একটা "কতবার দেখা হয়েছে" counter, যেটা task খোলার প্রতিবার ১ করে বাড়বে। জনপ্রিয় একটা task দিনে ১০,০০০ বার খোলা হতে পারে। এই counter এর জন্য কোন write strategy বেছে নেবে, আর কেন? Task এর title/description এর জন্য কি একই strategy ব্যবহার করবে?

2. একজন junior developer TaskFlow এ Write-Through বসিয়েছে `POST /api/tasks` এ — নতুন task তৈরি হলে সেটা সাথে সাথে Redis এও লিখে দেয়। কিন্তু সে লক্ষ্য করেছে, Redis এর memory ব্যবহার দ্রুত বাড়ছে, অথচ cache hit ratio বাড়েনি। কী ভুল হচ্ছে, আর কী করা উচিত?

3. Cache-Aside এ cache down হয়ে গেলে application চলতে থাকে — এটাকে সুবিধা বলা হয়েছে। কিন্তু এর একটা লুকানো বিপদ আছে। সেটা কী?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Counter এর জন্য **Write-Behind** উপযুক্ত। কারণ (ক) write এর পরিমাণ বিশাল — প্রতিটা view এ একটা করে DB write দিলে DB বসে যাবে, (খ) data টা হারালে ক্ষতি সামান্য — counter ২ কম দেখালে কেউ টেরও পাবে না। Cache এ increment করে, প্রতি ৩০ সেকেন্ডে একবার জমা মানটা DB তে লিখে দিলেই যথেষ্ট।

Title/description এ **কখনোই না**। ওটা user এর আসল data — user "Saved" দেখার পর crash হলে সেটা হারিয়ে যাওয়া মানে বিশ্বাসভঙ্গ। ওখানে DB তে sync write, তারপর cache invalidate। এটাই মূল শিক্ষা: **একই application এর ভেতরেও আলাদা আলাদা data এর জন্য আলাদা strategy লাগে** — পুরো app এ একটা নিয়ম চাপানো ভুল।

**প্রশ্ন ২:** সমস্যাটা Write-Through এর ক্লাসিক দুর্বলতা — **তৈরি হওয়া প্রতিটা task cache এ ঢুকছে, কিন্তু সেগুলোর বেশিরভাগ কেউ পড়ছে না**। মানে memory ভরছে এমন data দিয়ে যার কোনো read চাহিদা নেই, তাই hit ratio বাড়ছে না। বরং উল্টো ক্ষতি — এই অপ্রয়োজনীয় data জায়গা দখল করে সত্যিই জনপ্রিয় data গুলোকে cache থেকে বের করে দিচ্ছে (eviction, Lesson 4.3)।

সমাধান: **Write-Around** এ যাও — `POST` এ শুধু DB তে লেখো, আর ওই user এর `tasks:user:{id}` key টা delete করো। Task টা cache এ ঢুকবে তখন, যখন কেউ আসলে সেটা পড়তে চাইবে।

**প্রশ্ন ৩:** বিপদটা হলো — cache down হওয়ার মুহূর্তে **পুরো traffic এক সাথে DB তে গিয়ে পড়ে**। স্বাভাবিক অবস্থায় হয়তো ৯৫% request cache থেকেই মিটে যাচ্ছিল, DB শুধু ৫% সামলাচ্ছিল। Cache গেলে DB কে হঠাৎ **২০ গুণ** load নিতে হবে — যেটার জন্য সে তৈরিই না। ফলে DB ধীর হয়, timeout শুরু হয়, আর পুরো system ধসে পড়তে পারে।

মানে "cache optional" কথাটা performance এর দিক থেকে সত্যি, কিন্তু **capacity এর দিক থেকে না** — cache চলে গেলে DB সেই load নিতে পারবে কিনা, সেটা আলাদা করে ভাবতে হয়। এটাই Lesson 4.6 এর **thundering herd** সমস্যা।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

TaskFlow এ নিচের চারটা operation আছে। প্রতিটার জন্য বলো — **কোন read strategy, কোন write strategy**, TTL কত রাখবে, আর cache key টা কী হবে। সিদ্ধান্তের পেছনে এক-দুই লাইনের যুক্তি দাও।

1. `GET /api/tasks` — logged-in user এর নিজের task list (দিনে গড়ে ৫০ বার পড়া হয়, সপ্তাহে ৫ বার বদলায়)
2. `PATCH /api/tasks/:id` — একটা task এর title বা completed status বদলানো
3. `GET /api/users/:id/profile` — user এর নাম, ছবি, timezone (খুব ঘন ঘন পড়া হয়, মাসে একবার বদলায়)
4. `POST /api/tasks/:id/view` — task view counter ১ বাড়ানো (জনপ্রিয় task এ দিনে ১০,০০০+ বার)

**একটা বাড়তি প্রশ্ন, একটু কঠিন:** ২ নম্বরে যখন তুমি task update করবে, ঠিক কোন কোন cache key invalidate করতে হবে? শুধু ওই task এর key টাই কি যথেষ্ট?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (সম্পূর্ণ), 4.1
Current: 4.2 — Caching Strategies
TaskFlow state: Nginx reverse proxy + LB সামনে, horizontal-scale-ready backend,
caching strategy ঠিক হয়েছে (Cache-Aside read + invalidate-on-write), কিন্তু
Redis এখনো বসানো হয়নি
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start
Weak spots: [Module 3 এর pattern — সঠিক সিদ্ধান্তে পৌঁছেও alternative approach
miss করা। আজকের exercise এ দেখার বিষয় — পুরো app এ একটাই strategy চাপিয়ে
দিচ্ছ, নাকি প্রতিটা endpoint এর চরিত্র আলাদা করে ভাবছ]
Next: 4.3 — Invalidation, TTL, Eviction (LRU, LFU)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষ করে শেষের বাড়তি প্রশ্নটা, ওটাই পরের lesson এর দরজা। রেডি হলে `next` লিখো — Lesson 4.3 এ যাব: Invalidation, TTL আর Eviction। "কখন cache মুছব" আর "জায়গা ফুরিয়ে গেলে কাকে বের করে দেব" — Computer Science এর সবচেয়ে কুখ্যাত কঠিন সমস্যা দুটোর একটা এখানেই।
