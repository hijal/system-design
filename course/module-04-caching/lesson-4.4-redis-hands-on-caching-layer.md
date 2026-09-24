# Lesson 4.4 — Redis Hands-on: TaskFlow এ একটা সত্যিকারের Caching Layer

**Module 4 — Caching**

> **Spaced Repetition (Lesson 2.5):** Idempotency Key কী সমস্যার সমাধান করে, আর সেই exercise এ আমরা key গুলো কোথায় জমা রেখেছিলাম — সেই জায়গাটার সীমাবদ্ধতা কী ছিল?

**Prerequisite:** Lesson 4.2 (Caching Strategies), Lesson 4.3 (Invalidation, TTL, Eviction)

**তুমি এই lesson শেষে পারবে:**

1. Express + Sequelize + Redis দিয়ে একটা কাজ করা Cache-Aside layer নিজে লিখতে পারবে
2. Cache এ রাখা data কে runtime input হিসেবে Zod দিয়ে validate করবে, `as` দিয়ে বিশ্বাস করবে না
3. Cache এর লাভটা **মেপে** দেখাতে পারবে, আর Redis মরে গেলে ঠিক কী ঘটে সেটা চোখে দেখবে

**Tier:** 1 — Runnable Code

---

## ০. TaskFlow এখন কোথায়

গত তিনটা lesson এ আমরা অনেক সিদ্ধান্ত নিয়েছি, কিন্তু একটা লাইন code ও লিখিনি:

```
4.1 →  hierarchy বুঝলাম, ঠিক হলো: personalized data এর জন্য app-level cache
4.2 →  strategy ঠিক হলো: Cache-Aside (read) + invalidate (write)
4.3 →  TTL ৩০-৬০s, আগে DB পরে cache, derived view ও মুছতে হবে, allkeys-lru
```

আজকে এই পুরো কাগুজে design টা TaskFlow এ বসিয়ে দেব — আর তারপর **মেপে দেখব সত্যিই কিছু লাভ হলো কিনা**।

এটা গুরুত্বপূর্ণ, কারণ caching নিয়ে একটা সাধারণ ফাঁদ আছে: লোকে Redis বসিয়ে ধরে নেয় system এখন দ্রুত হয়ে গেছে। কিন্তু cache কতটা লাভ দিচ্ছে সেটা **না মাপলে** তুমি জানোই না তোমার TTL ঠিক আছে কিনা, key design কাজ করছে কিনা, এমনকি cache আদৌ hit হচ্ছে কিনা। আজকের exercise এ তাই একটা bench script ও আছে।

আর lesson এর শেষে আমরা একটা কাজ করব যেটা অনেকে কখনো করে দেখে না — **Redis টা মেরে ফেলব**, আর দেখব TaskFlow এর কী হয়। উত্তরটা তোমাকে চমকে দেবে।

---

## ১. Theory

আজকে theory কম, code বেশি। কিন্তু চারটা জিনিস আগে পরিষ্কার করে নিই, কারণ এগুলোই exercise এর মেরুদণ্ড।

### ১.১ Cache এ রাখা data ও runtime input

Lesson 2.5 এ আমরা একটা নিয়ম শিখেছিলাম — **runtime input কখনো type assertion দিয়ে বিশ্বাস করবে না**। তখন সেটা ছিল `req.body`। আজকে সেই একই নিয়ম আরেক জায়গায় খাটে, যেটা অনেকে খেয়াল করে না: **Redis থেকে ফেরত আসা data ও runtime input**।

কেন? Redis এ যা আছে তা তোমার পুরনো code এর লেখা হতে পারে, deploy এর সময় shape বদলে যেতে পারে, বা অন্য কোনো service সেখানে লিখে থাকতে পারে। `JSON.parse()` এর ফল হলো `unknown` — আর সেটাকে `as TaskDTO[]` বলে চালিয়ে দেওয়া মানে মিথ্যা বলা।

Lesson 4.2 এ আমি ইচ্ছা করে একটা `as` রেখে comment এ লিখেছিলাম "4.4 এ এটা Zod দিয়ে সরাব"। আজকে সেই কথা রাখছি:

```typescript
export const taskSchema = z.object({
	id: z.number().int(),
	userId: z.number().int(),
	title: z.string(),
	completed: z.boolean()
});
export const taskListSchema = z.array(taskSchema);
export type TaskDTO = z.infer<typeof taskSchema>;
```

লক্ষ্য করো — type টা আলাদা করে লেখা হয়নি, `z.infer` দিয়ে schema থেকেই বের করা হয়েছে। মানে schema আর type কখনো আলাদা হয়ে যাবে না।

### ১.২ Cache miss আর cache error — এক জিনিস না

বেশিরভাগ tutorial এ cache lookup এর ফল দুই রকম: পেলাম, বা পেলাম না। কিন্তু বাস্তবে **তিন** রকম:

```
hit    →  cache এ আছে, এই নাও
miss   →  cache এ নেই, DB তে যাও
error  →  Redis উত্তরই দিচ্ছে না (down, timeout, network)
```

শেষ দুটোতে তোমার code একই কাজ করবে (DB তে যাবে), তাই এগুলো গুলিয়ে ফেলার প্রলোভন আছে। কিন্তু **আলাদা রাখলে তুমি মাপতে পারো** — cache hit ratio কম কেন, সেটা কি TTL এর জন্য, নাকি Redis আসলে ধুঁকছে? এই দুটোর চিকিৎসা সম্পূর্ণ আলাদা।

এই course এর code এর একটা নিয়ম আছে — _"Discriminated union দিয়ে state model করবে, optional field এর জঙ্গল বানাবে না।"_ ঠিক এই জায়গার জন্যই:

```typescript
export type CacheLookup<T> =
	{ status: 'hit'; value: T } | { status: 'miss' } | { status: 'error'; reason: string };
```

`value` field টা শুধু `hit` এ আছে। মানে TypeScript তোমাকে `status` check না করে `value` পড়তেই দেবে না — bug টা compile time এই ধরা পড়বে।

### ১.৩ Cache এর ব্যর্থতা কখনো request ব্যর্থ করবে না

Lesson 4.3 এর প্রশ্ন ৩ এ আমরা দেখেছিলাম — Redis এ লিখতে না পারলে যদি সেই error টা উপরে উঠে যায়, user 500 দেখবে, অথচ DB একদম সুস্থ। এটা অযৌক্তিক: cache একটা **optimization**, সত্যের উৎস না। সে ব্যর্থ হলে system ধীর হবে, ভাঙবে না।

তাই exercise এ cache এর প্রতিটা operation নিজের ভেতরে error গিলে ফেলে:

```typescript
export async function writeList(key: string, value: TaskDTO[], ttlSeconds: number): Promise<void> {
	try {
		await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
	} catch {
		// cache এ লিখতে না পারা কখনোই request fail করার কারণ হওয়া উচিত না
	}
}
```

খেয়াল করো `catch (error: any)` নেই — খালি `catch`, কারণ error টা আমরা ব্যবহারই করছি না। আর যেখানে ব্যবহার করছি, সেখানে `catch (error: unknown)` ধরে narrow করা হয়েছে।

### ১.৪ Sequelize model টাইপ করা

Course এর code এর আরেকটা নিয়ম — Sequelize model কখনো untyped রাখা যাবে না:

```typescript
export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
	declare id: CreationOptional<number>;
	declare userId: number;
	declare title: string;
	declare completed: CreationOptional<boolean>;
}
```

`InferAttributes` model থেকে field গুলো নিজেই বের করে নেয়, তাই আলাদা interface লিখে দুই জায়গায় sync রাখার ঝামেলা নেই। `CreationOptional` বলে দেয় কোন field গুলো তৈরির সময় দিতে হয় না (`id` auto-increment, `completed` এর default আছে)।

---

## ২. Interview Angle

এই lesson টা hands-on, কিন্তু এখান থেকেই interview এর সবচেয়ে ধারালো প্রশ্নটা আসে: **"তোমার cache মরে গেলে কী হয়?"**

বেশিরভাগ candidate বলে _"কিছু হবে না, request গুলো DB তে চলে যাবে"_ — আর এটাই সেই উত্তর যেটা তোমাকে আটকে দেবে, কারণ এটা অর্ধসত্য। আজকের exercise এ তুমি নিজের চোখে দেখবে যে correctness ঠিক থাকে, কিন্তু **latency ১২ ms থেকে লাফিয়ে কয়েক সেকেন্ডে যায়, আর প্রতিটা request এ বাড়তেই থাকে** — DB load বাড়ার কারণে না, বরং client library টা প্রতিটা command কে একটা queue তে রেখে Redis ফিরে আসার অপেক্ষা করে, তারপর হাল ছাড়ে।

মানে **তোমার cache client এর setting (offline queue, command timeout) ই ঠিক করে দেয় cache down হওয়াটা "একটু ধীর" হবে নাকি "পুরো outage" হবে।** আর মজার ব্যাপার — যে setting টা দেখে সবাই প্রথমে সন্দেহ করে (`connectTimeout`), সেটা এখানে কোনো কাজেই আসে না। এই কথাটা বলতে পারলে তুমি এমন একজন হিসেবে দেখাবে যে সত্যিই একটা cache production এ চালিয়েছে।

দ্বিতীয় common প্রশ্ন: **"Cache hit ratio কত হলে ভালো?"** — সঠিক উত্তর হলো "নির্ভর করে"। ৯৫% hit ratio দারুণ শোনায়, কিন্তু যদি miss গুলোই সবচেয়ে দামি query হয় তাহলে লাভ কম। আর ৬০% hit ratio ও যথেষ্ট হতে পারে যদি সেই ৬০% ই তোমার সবচেয়ে ভারী endpoint হয়। **মাপো, তারপর বলো** — এটাই মূল কথা।

---

## ৩. Key Takeaway

- Cache থেকে আসা data ও **runtime input** — Zod দিয়ে parse করো, `as` দিয়ে বিশ্বাস কোরো না
- Cache lookup এর ফল **তিন রকম** (hit/miss/error), দুই রকম না — discriminated union দিয়ে model করো
- Cache এর কোনো ব্যর্থতা যেন কখনো request ব্যর্থ না করে — প্রতিটা cache call fail-safe
- ক্রম মনে রেখো: **আগে DB, পরে cache invalidate** (Lesson 4.3)
- একটা write এ **derived view ও** মুছতে হয় — `tasks:user:7` এর সাথে `tasks:user:7:completed`
- Sequelize এ `InferAttributes`/`InferCreationAttributes`, untyped model না
- Cache এর লাভ **দাবি কোরো না, মাপো** — `X-Cache` header আর একটা bench script ই যথেষ্ট
- **Cache down মানে শুধু "একটু ধীর" না** — client এর offline queue বন্ধ বা command timeout ছোট না থাকলে এটা পুরো outage হয়ে যেতে পারে

---

## ৪. নতুন Term (Glossary)

| Term                      | অর্থ                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Cache Hit Ratio**       | মোট request এর কত ভাগ cache থেকেই মিটে গেছে — cache কতটা কাজে লাগছে তার মাপ                 |
| **Discriminated Union**   | একটা `status`-জাতীয় field দিয়ে আলাদা করা type, যাতে ভুল field পড়া compile এই ধরা পড়ে    |
| **Fail-safe (cache)**     | cache ব্যর্থ হলে request ব্যর্থ না করে চুপচাপ DB তে চলে যাওয়ার নকশা                        |
| **Offline Queue**         | Redis এর সাথে connection না থাকলে client যেখানে command জমিয়ে রাখে, reconnect এর অপেক্ষায় |
| **Cold Path / Warm Path** | যথাক্রমে cache miss (DB পর্যন্ত যাওয়া) আর cache hit (cache থেকেই ফেরা) এর পথ               |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর Answer Key খুলো।

1. Exercise এ `GET /api/tasks` তে cache miss হলে তিনটা কাজ হয়: Redis এ খোঁজা, DB তে query, Redis এ লেখা। কিন্তু শেষ ধাপটার (`writeList`) ফলাফলের জন্য আমরা `await` করছি — client কে response দেওয়ার **আগেই**। এটা কি ঠিক? না করলে কী লাভ, আর কী ঝুঁকি?

2. Bench এ দেখা গেছে DB path ~১২ ms, cache path ~৩.৭ ms — মাত্র ~৩.৩ গুণ দ্রুত। অথচ Lesson 4.1 এ বলা হয়েছিল memory আর disk এর পার্থক্য ~১০০০ গুণ। এত কম কেন? পার্থক্যটা কোথায় খেয়ে গেল?

3. Redis বন্ধ করে পরপর ৫টা request পাঠানো হলো: ৬২৩ ms, ১৪৯২ ms, ২২৯৯ ms, ৩০৯৫ ms, ৩৮৯৫ ms — সময়টা **বাড়ছে**। যদি cache শুধু "কাজ করছে না" হতো, তাহলে প্রতিটা request সমান সময় নেওয়ার কথা ছিল। বাড়ছে কেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** কঠোরভাবে বললে, `await` না করলেই ভালো — data টা DB থেকে পাওয়া হয়ে গেছে, client কে সাথে সাথে পাঠিয়ে দিয়ে cache এ লেখাটা background এ করা যায়। এতে miss path থেকে একটা Redis round trip এর latency বাদ যায়।

কিন্তু ঝুঁকি দুটো: (ক) Node এ floating promise — যদি সেটা reject করে আর কেউ catch না করে, তাহলে unhandled rejection; (খ) test এ nondeterminism — response আসার পরও cache এ লেখা শেষ হয়নি এমন অবস্থা।

Exercise এ `await` রাখা হয়েছে সরলতার জন্য (আর `writeList` নিজে কখনো throw করে না, তাই ঝুঁকি (ক) নেই)। Production এ এটা সাধারণত fire-and-forget করা হয়, কিন্তু rejection handler সহ। **শেখার বিষয়:** miss path এ প্রতিটা অতিরিক্ত hop গোনার মতো — কারণ miss ই তোমার সবচেয়ে ধীর path।

**প্রশ্ন ২:** কারণ **১২ ms বা ৩.৭ ms এর বেশিরভাগটাই আসলে memory বা disk read না**। দুটো path ই এখানে একই কাজ করছে: ৫০০০টা task কে JSON এ পরিণত করা আর network দিয়ে পাঠানো। সেই খরচটা দুই path এ একই, তাই সেটা অনুপাতটাকে চেপে দেয়।

যা আলাদা, শুধু সেটুকু: DB path এ Postgres এ query + ৫০০০ row কে JS object এ রূপান্তর; cache path এ একটা Redis `GET` + `JSON.parse`।

এটা একটা গুরুত্বপূর্ণ বাস্তবতা — **Lesson 1.3 এর latency number গুলো উপাদান, পুরো recipe না।** একটা real endpoint এ serialization, network, framework overhead সবই যোগ হয়। তাই "Redis ১০০০ গুণ দ্রুত" বলে ১০০০ গুণ improvement আশা করাটা ভুল। আসল লাভ বরং অন্য জায়গায় বেশি: **DB এর উপর থেকে load সরে যাওয়া**, যাতে DB টা write আর জটিল query এর জন্য শ্বাস নিতে পারে।

(চাইলে নিজে দেখো: `TASK_COUNT` ৫০০০ থেকে ৫০ করে দিয়ে bench চালাও — payload ছোট হলে অনুপাতটা বদলে যায়।)

**প্রশ্ন ৩:** কারণ তুমি cache এর **অনুপস্থিতি** মাপছ না, মাপছ **cache এর জন্য অপেক্ষা**।

Redis বন্ধ থাকলে ioredis সাথে সাথে "নেই" বলে না। সে command টা ফেলে না দিয়ে একটা **offline queue** তে রেখে দেয় (`enableOfflineQueue`, default `true`) — Redis ফিরে এলে পাঠাবে বলে। তারপর reconnect এর চেষ্টা করে, আর প্রতিটা ব্যর্থ চেষ্টার পর পরের চেষ্টা আরও পিছিয়ে দেয় (default retry strategy: `min(times × 50, 2000)` ms)। Queue তে বসে থাকা command টা error হয়ে ফেরে শুধু তখন, যখন `maxRetriesPerRequest` এর সীমা পার হয়। ফলে যত সময় যায়, প্রতিটা request তত বেশি অপেক্ষা করে।

**`connectTimeout` এখানে কেন কাজে আসে না?** কারণ Redis এর container বন্ধ থাকলে connect এর চেষ্টা সাথে সাথেই refuse হয়ে যায় — timeout পর্যন্ত অপেক্ষাই করতে হয় না। আমি মেপে দেখেছি: `connectTimeout` ১০০০ থেকে ১০০ করলে কোনো উন্নতি হয় না (১৭৬৩ → ৫৪৯৬ ms, আগের মতোই বাড়ছে)।

**এটাই এই exercise এর সবচেয়ে বড় শিক্ষা।** "Cache optional" কথাটা correctness এর দিক থেকে সত্যি, কিন্তু **latency এর দিক থেকে সম্পূর্ণ মিথ্যা হতে পারে** — যদি তোমার cache client command আটকে রেখে অপেক্ষা করে। ৪ সেকেন্ডের response মানে বাস্তবে user এর কাছে outage, আর upstream এ load balancer timeout শুরু করে দেবে।

সমাধান — একই মেশিনে মাপা:

```
default (offline queue চালু)      : ৬২৩ → ৩৮৯৫ ms, বাড়তেই থাকে
connectTimeout: 100               : ১৭৬৩ → ৫৪৯৬ ms, কোনো উন্নতি নেই
commandTimeout: 100               : ~২১০ ms প্রতিবার, স্থির
enableOfflineQueue: false         : ~১২ ms প্রতিবার — Redis না থাকলে সাথে সাথে error, সরাসরি DB
```

মানে cache client এ **offline queue বন্ধ** রাখো (cache এর জন্য queue করে অপেক্ষা করার কোনো মানে নেই), অথবা অন্তত একটা **ছোট command timeout** দাও, আর আদর্শভাবে একটা **circuit breaker** — টানা কয়েকবার fail করলে কিছুক্ষণের জন্য Redis এ যাওয়াই বন্ধ করে দাও, সরাসরি DB তে যাও। Circuit breaker নিয়ে বিস্তারিত Lesson 9.4 এ।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-4.4-redis-cache/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-4.4-redis-cache) — `docker compose up -d && npm install && npm run seed` তারপর `npm run build && npm start`। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

এই exercise এ Module 4 এর সব সিদ্ধান্ত একসাথে বসানো — Cache-Aside read, invalidate-on-write (derived view সহ), TTL ৬০s, `allkeys-lru`, আর fail-safe cache layer।

**সেটআপ যাচাই হলে, এই চারটা করো:**

1. `npm run bench` চালাও। তোমার মেশিনে MISS আর HIT এর median কত? অনুপাতটা আমার পাওয়া ~৩.৩x এর কাছাকাছি, নাকি আলাদা? আলাদা হলে কেন বলে মনে হয়?

2. `src/server.ts` এ `TTL_SECONDS` ৬০ থেকে **২** করে দাও, rebuild করো। প্রথমে `npm run bench` চালাও — দেখবে hit ratio **এখনো ২০/২০**! কেন? (ইঙ্গিত: bench এর ২০টা HIT request মোট কত সময় নেয়?) এবার হাতে পরীক্ষা করো: একটা request পাঠাও, **৩ সেকেন্ড অপেক্ষা করো**, আবার পাঠাও — `X-Cache` header কী বলে?

   ```bash
   curl -s -D - -o /dev/null "http://localhost:3000/api/tasks?userId=7" | grep X-Cache
   sleep 3
   curl -s -D - -o /dev/null "http://localhost:3000/api/tasks?userId=7" | grep X-Cache
   ```

   দুটো ফল মিলিয়ে বলো — hit ratio আসলে কীসের উপর নির্ভর করে: TTL এর উপর একা, নাকি **TTL আর একই key তে request আসার হারের** সম্পর্কের উপর? Lesson 4.3 এর প্রশ্ন ২ এর যুক্তির সাথে মেলাও। (আর এখান থেকে একটা বাড়তি শিক্ষা: একটা benchmark যে pattern এ request পাঠায়, সেটা বাস্তব traffic এর মতো না হলে সংখ্যাটা ভুল গল্প বলে।)

3. `PATCH` handler এ `affected` array থেকে `keys.completedByUser(...)` লাইনটা বাদ দাও। এবার: completed list টা cache করো → একটা task এর `completed` বদলাও → আবার completed list পড়ো। **কী ভুল দেখছ?** কতক্ষণ পর নিজে থেকে ঠিক হয়ে যায়, আর কেন?

4. **সবচেয়ে গুরুত্বপূর্ণটা:** `docker compose stop redis` করে পরপর ৫টা request পাঠাও, প্রতিটার `tookMs` লিখে রাখো। তারপর `src/cache.ts` এ Redis client এর option বদলে তিনবার একই পরীক্ষা করো (প্রতিবার rebuild, আর পরীক্ষার আগে `docker compose start redis` করে server চালু করে তারপর আবার stop):

   - (ক) `connectTimeout` ১০০০ থেকে **১০০**
   - (খ) `connectTimeout` আগের মতো, সাথে `commandTimeout: 100` যোগ
   - (গ) `commandTimeout` বাদ, সাথে `enableOfflineQueue: false` যোগ

   চার সেটের সংখ্যা পাশাপাশি রাখো। কোনটায় কোনো উন্নতিই হলো না, আর কেন? এক অনুচ্ছেদে লেখো — **একটা client setting কীভাবে "cache down" কে "site down" এ পরিণত করতে পারে, আর যে setting টা সবাই প্রথমে সন্দেহ করে সেটা কেন ভুল জায়গা।**

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (সম্পূর্ণ), 4.1, 4.2, 4.3
Current: 4.4 — Redis Hands-on
TaskFlow state: Nginx reverse proxy + LB, horizontal-scale-ready backend,
আর এখন একটা সত্যিকারের Redis caching layer — Cache-Aside read (TTL 60s),
invalidate-on-write (derived view সহ), fail-safe cache client, allkeys-lru।
মাপা: DB path ~12ms, cache path ~3.7ms (5000 task), hit ratio 20/20
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution, Cache Hit Ratio,
Discriminated Union, Fail-safe, Offline Queue
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 4.5 — CDN কীভাবে কাজ করে
=======================
```

---

## ৮. পরের Lesson

Exercise এর চার নম্বরটা অবশ্যই করো — ওটা না করলে এই lesson এর আসল শিক্ষাটাই হাতছাড়া হবে। সংখ্যাগুলো পাঠিয়ো।

রেডি হলে `next` লিখো — Lesson 4.5 এ যাব CDN এ। 4.1 এ hierarchy তে CDN কে এক নজরে দেখেছিলাম; এবার ভেতরে ঢুকব — edge server আসলে কীভাবে সিদ্ধান্ত নেয়, cache key কী দিয়ে তৈরি হয়, `Cache-Control` এর নির্দেশগুলো কী বোঝায়, আর purge করলে ৩০০+ PoP এর সবগুলোতে খবরটা কীভাবে পৌঁছায়।
