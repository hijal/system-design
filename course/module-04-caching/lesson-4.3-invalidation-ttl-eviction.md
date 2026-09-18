# Lesson 4.3 — Invalidation, TTL & Eviction: কখন মুছব, কাকে বের করে দেব

**Module 4 — Caching**

> **Spaced Repetition (Lesson 1.3):** Back-of-the-envelope estimation এ ১ million user, প্রতি user এর ১ KB data — মোটামুটি কত memory লাগবে? (হিসাবটা মাথায় করে বলো)

**Prerequisite:** Lesson 4.2 (Caching Strategies), Lesson 1.3 (Estimation)

**তুমি এই lesson শেষে পারবে:**

1. TTL, explicit invalidation আর eviction — এই তিনটা আলাদা জিনিস কেন আলাদা, আর কোনটা কোন সমস্যার উত্তর, সেটা বুঝবে
2. একটা write হলে ঠিক কোন কোন cache key মুছতে হবে — সেটা key design দেখে বের করতে পারবে
3. LRU আর LFU eviction policy এর পার্থক্য, আর TaskFlow এর জন্য Redis এ কোনটা বেছে নেবে — বলতে পারবে

**Tier:** 3 — Design Exercise (hands-on Redis implementation পরের lesson, 4.4 তে)

---

## ০. TaskFlow এখন কোথায়

গত lesson এ TaskFlow এর caching strategy ঠিক হয়েছে — read এ **Cache-Aside**, write এ **DB তে লিখে cache key invalidate**। কাগজে-কলমে সিদ্ধান্তটা পরিষ্কার।

কিন্তু গত lesson এর শেষে একটা বাড়তি প্রশ্ন রেখে এসেছিলাম: _user যখন একটা task update করবে, ঠিক **কোন কোন** key মুছতে হবে? শুধু ওই task এর key টাই কি যথেষ্ট?_

প্রশ্নটা নিরীহ দেখালেও, এর ভেতরেই লুকিয়ে আছে caching এর সবচেয়ে কুখ্যাত সমস্যা। Phil Karlton এর সেই বিখ্যাত উক্তিটা আছে না —

> "There are only two hard things in Computer Science: cache invalidation and naming things."

আজকের lesson সেই "দুটো কঠিন জিনিস" এর প্রথমটা নিয়ে। আর শেষে দেখব, প্রথমটা আসলে দ্বিতীয়টার সাথে জড়িয়ে আছে — **key এর নাম ঠিকভাবে না দিলে invalidation কখনোই সহজ হবে না।**

---

## ১. Theory

### ১.১ আসলে তিনটা আলাদা প্রশ্ন

লোকে প্রায়ই "cache expire হওয়া" বলে সব গুলিয়ে ফেলে। কিন্তু এখানে তিনটা সম্পূর্ণ আলাদা প্রশ্ন আছে, আর তিনটার উত্তরও আলাদা:

```
১. TTL          → "কতক্ষণ পর নিজে থেকে মুছে যাবে?"     (সময় ঠিক করে)
২. Invalidation → "data বদলে গেছে, এখনই মুছে দাও"      (তুমি ঠিক করো)
৩. Eviction     → "memory ভরে গেছে, কাকে বের করব?"    (Redis ঠিক করে)
```

পার্থক্যটা খেয়াল করো — **কে সিদ্ধান্ত নিচ্ছে**, সেটাই মূল কথা। TTL এ ঘড়ি সিদ্ধান্ত নেয়, invalidation এ তোমার code সিদ্ধান্ত নেয়, আর eviction এ Redis নিজে বাধ্য হয়ে সিদ্ধান্ত নেয় — কারণ তার আর জায়গা নেই।

### ১.২ TTL — সবচেয়ে সহজ, আর সবচেয়ে কম নির্ভরযোগ্য

TTL (Time To Live) মানে — "এই key টা N সেকেন্ড পর নিজে থেকেই মরে যাবে।"

```typescript
await redis.set(cacheKey, JSON.stringify(tasks), 'EX', 300); // ৫ মিনিট
```

এর সৌন্দর্য হলো এটা **স্বয়ংক্রিয়**। তুমি invalidate করতে ভুলে গেলেও, সর্বোচ্চ ৫ মিনিট পর পুরনো data নিজে থেকে চলে যাবে। এটা একটা safety net — শেষ ভরসা।

কিন্তু TTL এর দাম হলো একটা জানালা:

```
t=0s    user task টা update করল  →  DB তে নতুন value
                                     Cache এ এখনো পুরনো value
t=0-300s  এই পুরো সময় জুড়ে user পুরনো data দেখবে  ← Staleness Window
t=300s  TTL শেষ  →  পরের read এ DB থেকে নতুন value আসবে
```

এই মাঝের সময়টাকে বলে **staleness window** — যতক্ষণ cache আর DB একমত না।

এখান থেকেই TTL এর মূল trade-off:

| TTL       | Cache hit ratio | Staleness | DB load |
| --------- | --------------- | --------- | ------- |
| ছোট (১০s) | কম              | কম        | বেশি    |
| বড় (১ঘ)  | বেশি            | বেশি      | কম      |

**তাহলে ঠিক মানটা কত?** এটা নির্ভর করে data টা বাসি হলে কতটা ক্ষতি, তার উপর:

- TaskFlow এর task list → ৫ মিনিট পুরনো দেখালে কেউ মরে যাবে না, কিন্তু বিরক্ত হবে → **৩০-৬০ সেকেন্ড**
- User এর profile picture → ঘণ্টাখানেক পুরনো দেখালেও চলে → **১ ঘণ্টা**
- Account balance বা payment status → **এক সেকেন্ডও বাসি চলবে না** → cache-ই করা উচিত না, বা খুব ছোট TTL সহ invalidation বাধ্যতামূলক

### ১.৩ Explicit Invalidation — delete করো, update কোরো না

TTL শুধু safety net। আসল কাজটা হলো — data বদলানোর **সাথে সাথে** cache কে জানানো। এখানে দুটো পথ আছে, আর একটা স্পষ্টভাবে ভালো:

```
পথ ১ (update):  DB তে লেখো  →  cache এ নতুন value লিখে দাও
পথ ২ (delete):  DB তে লেখো  →  cache key টা মুছে দাও   ← এটাই সাধারণত ভালো
```

**কেন delete ভালো?** তিনটা কারণে:

1. **Update করতে গেলে তোমাকে নতুন value টা বানাতে হবে** — মানে আবার DB query, আবার serialize। Delete এ সেই খরচ নেই, আর data টা আসলে কেউ পড়তে চাইলে তখন এমনিতেই load হয়ে যাবে।
2. **Race condition কম।** দুইজন একসাথে update করলে, "update" পদ্ধতিতে কার value শেষে cache এ বসবে সেটা অনিশ্চিত — এমনকি পুরনো value নতুনটার উপরে বসে যেতে পারে। Delete এ এই ঝামেলা নেই; cache খালি থাকলে পরের read DB এর সত্যটাই আনবে।
3. **কেউ হয়তো ওই data আর পড়বেই না।** তাহলে cache এ নতুন value বসিয়ে memory নষ্ট করার মানে কী?

তোমার stack এ:

```typescript
async function updateTask(
	redis: Redis,
	userId: number,
	taskId: number,
	title: string
): Promise<void> {
	// ধাপ ১ — সত্যের উৎস (DB) আগে
	await Task.update({ title }, { where: { id: taskId, userId } });

	// ধাপ ২ — তারপর cache মুছে দাও
	await redis.del(`task:${taskId}`, `tasks:user:${userId}`);
}
```

**ক্রমটা গুরুত্বপূর্ণ — আগে DB, পরে cache।** উল্টো করলে একটা সূক্ষ্ম bug আছে: cache মুছে দিলে, কিন্তু DB write টা fail করল — এর মাঝখানে যদি কেউ read করে, সে DB থেকে **পুরনো** value এনে আবার cache এ ভরে দেবে। ফলে cache এ পুরনো data ফিরে আসবে, আর TTL শেষ না হওয়া পর্যন্ত থেকে যাবে।

### ১.৪ কোন key গুলো মুছতে হবে — গত lesson এর প্রশ্নের উত্তর

উপরের code এ লক্ষ্য করেছ, আমি **দুইটা** key মুছেছি? এটাই ছিল গত lesson এর বাড়তি প্রশ্নের উত্তর।

একটা task update হলে যেসব cache entry বাসি হয়ে যায়:

```
task:42                  ← ওই task এর নিজের copy
tasks:user:7             ← ওই user এর পুরো list (task টা এই list এ আছে)
tasks:user:7:completed   ← "completed" filter করা list
tasks:user:7:page:1      ← paginated view
tasks:project:3          ← task টা যদি কোনো project এ থাকে
```

**একটা write, পাঁচটা বাসি key।** এটাই invalidation কে কঠিন বানায় — data একটা, কিন্তু সেটা কতগুলো আলাদা "view" এ ঢুকে আছে সেটা মনে রাখা কঠিন। নতুন একটা endpoint যোগ করার সময় invalidation এর জায়গায় সেটা যোগ করতে ভুলে গেলে — সেটাই সেই bug যেটা মাসখানেক পরে "মাঝে মাঝে পুরনো data দেখায়" হিসেবে ফিরে আসে।

**এখানেই "naming things" আর "cache invalidation" এক হয়ে যায়।** Key গুলো যদি একটা নিয়ম মেনে namespace করা থাকে, তাহলে একসাথে মোছা সহজ:

```
tasks:user:7:*     ← এই prefix এর সব key একসাথে মুছে ফেলা
```

তবে সাবধান — Redis এ `KEYS tasks:user:7:*` চালানো **production এ বিপজ্জনক**, কারণ এটা পুরো keyspace scan করে আর ততক্ষণ Redis কে আটকে রাখে (Redis single-threaded)। বিকল্প: `SCAN` (ধীরে ধীরে, block না করে), অথবা আরও ভালো — প্রতিটা user এর key গুলোর একটা তালিকা আলাদা করে রাখা (Redis Set এ), যাতে ঠিক কোনগুলো মুছতে হবে তা জানা থাকে।

আরেকটা পরিষ্কার কৌশল — **version/generation key**:

```
tasks:user:7:v12    ← v হলো version number
```

User এর কিছু বদলালে version টা এক বাড়িয়ে দাও (`INCR tasks:user:7:version`)। পুরনো `v12` key গুলো আর কেউ খুঁজবেই না — সবাই এখন `v13` চাইবে। পুরনোগুলো TTL শেষে নিজে থেকেই মরে যাবে। মোছার দরকারই নেই।

### ১.৫ Eviction — memory ভরে গেলে কে যাবে

TTL আর invalidation, দুটোই "data টা আর ঠিক নেই" নিয়ে। Eviction সম্পূর্ণ আলাদা প্রশ্ন — **data হয়তো একদম ঠিক আছে, কিন্তু জায়গা নেই।**

Redis এ তুমি একটা memory সীমা ঠিক করে দাও, আর বলে দাও সীমা ছাড়ালে সে কী করবে:

```bash
maxmemory 2gb
maxmemory-policy allkeys-lru
```

Policy গুলো (গুরুত্বপূর্ণ কয়েকটা):

| Policy           | কী করে                                                   |
| ---------------- | -------------------------------------------------------- |
| `noeviction`     | কিছু মুছবে না; নতুন write **error দেবে** (default)       |
| `allkeys-lru`    | সব key এর মধ্যে, **সবচেয়ে অনেকক্ষণ আগে ব্যবহৃত** টা বাদ |
| `allkeys-lfu`    | সব key এর মধ্যে, **সবচেয়ে কম বার ব্যবহৃত** টা বাদ       |
| `volatile-lru`   | শুধু যেগুলোর TTL সেট করা আছে, তাদের মধ্যে LRU            |
| `allkeys-random` | যাকে-তাকে random বাদ                                     |

**`noeviction` default — আর এটা প্রায়ই অপ্রত্যাশিত।** অনেকে Redis বসিয়ে maxmemory-policy সেট করতে ভুলে যায়, তারপর memory ভরে গেলে হঠাৎ `OOM command not allowed` error দেখে অবাক হয়। **যদি Redis টা pure cache হিসেবে ব্যবহার করো** (অর্থাৎ data হারালেও DB তে আসলটা আছে), তাহলে `allkeys-lru` প্রায় সবসময়ই সঠিক পছন্দ।

### ১.৬ LRU vs LFU — কোনটা কখন

দুটোর যুক্তি আলাদা:

- **LRU (Least Recently Used)** — "সবচেয়ে অনেকক্ষণ ধরে কেউ ছোঁয়নি" সেটা বাদ। প্রশ্ন: **কখন** শেষ ব্যবহার হয়েছে?
- **LFU (Least Frequently Used)** — "সবচেয়ে কম বার ব্যবহৃত হয়েছে" সেটা বাদ। প্রশ্ন: **কত বার** ব্যবহার হয়েছে?

একটা উদাহরণে পার্থক্যটা পরিষ্কার হয়। ধরো TaskFlow এ:

```
key A : গত ৩ মাসে ১০,০০০ বার পড়া হয়েছে, কিন্তু শেষ ২ ঘণ্টায় একবারও না
key B : গত ৩ মাসে মাত্র ৩ বার পড়া হয়েছে, কিন্তু ৫ মিনিট আগে পড়া হয়েছে
```

**LRU** বলবে: B সম্প্রতি ব্যবহৃত, তাই **A কে বাদ দাও**।
**LFU** বলবে: A অনেক জনপ্রিয়, তাই **B কে বাদ দাও**।

কে ঠিক? নির্ভর করে তোমার traffic এর চরিত্রের উপর:

- **LRU ভালো** যখন ব্যবহারে একটা "সাম্প্রতিকতা" থাকে — কেউ আজ কাজ করছে মানে সে আরও কিছুক্ষণ করবে। TaskFlow এর সাধারণ ব্যবহারে এটাই স্বাভাবিক।
- **LFU ভালো** যখন কিছু জিনিস চিরস্থায়ীভাবে জনপ্রিয় — যেমন একটা news site এর homepage। LRU এখানে একটা বিপদে পড়ে: হঠাৎ কোনো scan বা bot এসে একগাদা অচেনা key পড়ে ফেললে, সেগুলো "recent" হয়ে যায় আর সত্যিকারের জনপ্রিয় data গুলোকে বের করে দেয় — একে বলে **cache pollution**।

> **Trade-off Table — তিনটা প্রক্রিয়া এক নজরে**

|                   | **TTL**            | **Invalidation**     | **Eviction**            |
| ----------------- | ------------------ | -------------------- | ----------------------- |
| কে সিদ্ধান্ত নেয় | ঘড়ি               | তোমার code           | Redis (বাধ্য হয়ে)      |
| কেন ঘটে           | সময় শেষ           | data বদলেছে          | memory শেষ              |
| কতটা নির্ভুল      | আনুমানিক           | নির্ভুল              | data এর সাথে সম্পর্কহীন |
| ভুল হলে           | staleness window   | পুরনো data দেখা যায় | hit ratio পড়ে যায়     |
| TaskFlow এ        | ৩০-৬০s task list এ | write এ `del`        | `allkeys-lru`           |

**তিনটাই একসাথে লাগে।** Invalidation হলো নির্ভুল অস্ত্র, TTL হলো ভুলে যাওয়ার বিরুদ্ধে safety net, আর eviction হলো memory শেষ হয়ে গেলে শেষ রক্ষা। একটা দিয়ে বাকি দুটোর কাজ চালানো যায় না।

---

## ২. Interview Angle

Cache invalidation প্রায় প্রতিটা system design interview এ আসে, কিন্তু সরাসরি না — ঘুরিয়ে। সবচেয়ে common রূপ: **"তোমার design এ user একটা জিনিস update করল, কিন্তু অন্য একজন পুরনোটা দেখছে — কেন, আর কীভাবে ঠিক করবে?"** এখানে TTL আর explicit invalidation দুটোরই কথা বলতে হবে, আর বলতে হবে কেন শুধু TTL যথেষ্ট না (staleness window) এবং কেন শুধু invalidation-ও যথেষ্ট না (কোনো একটা জায়গায় মুছতে ভুলে যাবেই)।

একটা ভালো follow-up যেটা অনেকে আটকে যায়: **"invalidate করার সময় DB আগে না cache আগে?"** — উত্তর: **DB আগে, cache পরে**, আর কারণটা বলতে পারতে হবে (মাঝখানে একটা read এসে পুরনো value আবার cache এ ভরে দিতে পারে)।

আর eviction নিয়ে প্রশ্নটা প্রায় সবসময় একই: **"LRU না LFU?"** — এখানে "LRU ভালো" বলে থেমে যেয়ো না। Traffic pattern এর কথা তোলো: recency-driven access এ LRU, চিরস্থায়ী জনপ্রিয়তা থাকলে LFU, আর LFU যে scan/bot এর কারণে হওয়া cache pollution থেকে বাঁচায় — সেটা বলতে পারলে তুমি স্পষ্টভাবে এগিয়ে।

---

## ৩. Key Takeaway

- **তিনটা আলাদা প্রক্রিয়া**, গুলিয়ে ফেলা যাবে না: TTL (ঘড়ি সিদ্ধান্ত নেয়), invalidation (তুমি নাও), eviction (Redis বাধ্য হয়ে নেয়)
- TTL হলো safety net, নির্ভুল সমাধান না — এর দাম হলো **staleness window**
- Write এ cache **update না করে delete করা** সাধারণত ভালো — কম খরচ, কম race condition
- ক্রম সবসময় **আগে DB, পরে cache** — উল্টো করলে পুরনো value cache এ ফিরে আসতে পারে
- একটা write সাধারণত **একাধিক key** বাসি করে (item, list, filtered list, paginated view) — সবগুলো ভাবতে হবে
- ভালো key naming (namespace, বা version key) ছাড়া invalidation কখনোই সহজ হবে না
- Production এ `KEYS pattern*` চালিয়ো না — Redis single-threaded, এটা সবাইকে আটকে দেবে; `SCAN` বা version key ব্যবহার করো
- Redis এ `maxmemory-policy` default `noeviction` — pure cache হলে `allkeys-lru` সেট করা প্রায় সবসময় সঠিক

---

## ৪. নতুন Term (Glossary)

| Term                   | অর্থ                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **TTL (Time To Live)** | একটা cache entry কতক্ষণ বাঁচবে, তার পর নিজে থেকেই মুছে যাবে                               |
| **Staleness Window**   | data বদলানো আর cache সেটা জানার মাঝের সময় — যতক্ষণ পুরনো উত্তর দেখানো হয়                |
| **Cache Invalidation** | data বদলেছে বলে সংশ্লিষ্ট cache entry গুলো ইচ্ছাকৃতভাবে মুছে দেওয়া                       |
| **Eviction Policy**    | memory ভরে গেলে Redis কোন নিয়মে key বাছাই করে বের করে দেবে                               |
| **LRU**                | Least Recently Used — সবচেয়ে অনেকক্ষণ আগে ব্যবহৃত key টা বাদ দেওয়া হয়                  |
| **LFU**                | Least Frequently Used — সবচেয়ে কম বার ব্যবহৃত key টা বাদ দেওয়া হয়                      |
| **Cache Pollution**    | অপ্রয়োজনীয় (যেমন scan/bot এর আনা) data cache ভরে সত্যিকারের জনপ্রিয় data সরিয়ে দেওয়া |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর Answer Key খুলো।

1. TaskFlow এ একজন user একটা task কে "completed" চিহ্নিত করল। তোমার cache এ নিচের key গুলো আছে। কোনগুলো invalidate করতে হবে, আর কোনগুলো ছোঁয়ার দরকার নেই — কেন?
   `task:99` · `tasks:user:7` · `tasks:user:7:completed` · `tasks:user:12` · `user:7:profile`

2. একজন developer বলছে: "আমি সব key তে ১০ সেকেন্ড TTL দিয়ে দেব, তাহলে invalidation এর ঝামেলাই থাকবে না — সর্বোচ্চ ১০ সেকেন্ড পুরনো data দেখাবে, ব্যস।" যুক্তিটা শুনতে ঠিক লাগছে। এতে সমস্যা কী?

3. TaskFlow এর Redis এ `maxmemory-policy` সেট করা হয়নি (default `noeviction`)। একদিন memory ভরে গেল। Application এ ঠিক কী ঘটবে — read গুলো fail করবে, নাকি write গুলো, নাকি দুটোই? আর user এর চোখে ব্যাপারটা কেমন দেখাবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

- `task:99` — **হ্যাঁ**, এটাই সেই task, এর `completed` field বদলেছে
- `tasks:user:7` — **হ্যাঁ**, এই list এ task 99 আছে, আর তার status বদলেছে
- `tasks:user:7:completed` — **হ্যাঁ**, আর এটা সবচেয়ে সহজে ভুলে যাওয়া জায়গা। Task টা এখন এই filtered list এ **ঢুকবে**, অথচ cached version এ সে নেই
- `tasks:user:12` — **না**, ভিন্ন user, তার list এ এই task নেই
- `user:7:profile` — **না**, profile data (নাম, ছবি, timezone) task update এ বদলায় না

মূল শিক্ষা: **filtered/derived view গুলোই সবচেয়ে বেশি miss হয়**। মূল object আর তার list মনে থাকে, কিন্তু "completed only", "page 2", "project অনুযায়ী" — এগুলো ভুলে যাওয়া সহজ।

**প্রশ্ন ২:** যুক্তিটা correctness এর দিক থেকে খারাপ না, কিন্তু **performance এর দিক থেকে এটা cache টাকে প্রায় অকেজো করে দেয়**।

ভেবে দেখো — যদি একটা key তে গড়ে প্রতি ১০ সেকেন্ডে ৩টা request আসে, তাহলে প্রথমটা miss (DB তে যাবে), পরের দুটো hit। Hit ratio ~৬৭%। কিন্তু কম জনপ্রিয় key তে, যেখানে প্রতি ৩০ সেকেন্ডে একটা request — **প্রতিটা request ই miss**, কারণ আগেরটা ততক্ষণে মরে গেছে। Hit ratio প্রায় ০%।

মানে তুমি Redis এর খরচ, জটিলতা আর একটা বাড়তি network hop সবই নিচ্ছ, অথচ DB load প্রায় কমছেই না। তার উপর এখন **প্রতি ১০ সেকেন্ডে** সব জনপ্রিয় key একসাথে expire হবে — এতে DB তে হঠাৎ হঠাৎ load এর ঢেউ আসবে (Lesson 4.6 এর **cache stampede**)।

সঠিক পথ: **যুক্তিসঙ্গত TTL (৩০-৬০s) + explicit invalidation**। TTL টা safety net, invalidation টা আসল কাজ।

**প্রশ্ন ৩:** `noeviction` এ **read গুলো ঠিকঠাক চলতে থাকবে**, কিন্তু **write গুলো fail করবে** — Redis `OOM command not allowed when used memory > 'maxmemory'` error দেবে।

Application এর চোখে এটা একটা অদ্ভুত অবস্থা: cache এ যা আছে তা পড়া যাচ্ছে, কিন্তু নতুন কিছু cache এ ঢোকানো যাচ্ছে না। Cache-Aside এ ধাপ ৩ (cache এ লিখে রাখা) প্রতিবার fail করবে, মানে **প্রতিটা cache miss চিরকাল miss-ই থেকে যাবে** — সেই data আর কখনো cache এ ঢুকতে পারবে না।

User এর চোখে: site ধীরে ধীরে slow হতে থাকবে (যত নতুন data চাওয়া হয়, তত সব DB তে যায়), কিন্তু কিছু "ভাঙবে" না। এই নীরব অবনতিটাই এটাকে বিপজ্জনক বানায় — কোনো loud alarm বাজে না, শুধু latency বাড়তে থাকে।

আর যদি তোমার code এ Redis error টা properly handle করা না থাকে (try/catch ছাড়া `redis.set`), তাহলে ওই error টা request handler এ গিয়ে **user কে 500 দেখাবে** — অথচ DB একদম সুস্থ আছে। এজন্যই cache এর write গুলো সবসময় fail-safe রাখতে হয়: cache এ লিখতে না পারা কখনোই request fail করার কারণ হওয়া উচিত না।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

TaskFlow এ একটা নতুন feature আসছে — **shared project**। একটা project এ একাধিক user থাকতে পারে, আর একটা task একটা project এর অধীনে থাকে। এখন cache এ এই key গুলো আছে:

```
task:{taskId}
tasks:user:{userId}
tasks:user:{userId}:completed
tasks:project:{projectId}
project:{projectId}:members
```

**যা করতে হবে:**

1. User 7, project 3 এর একটা task (id 99) এর title বদলালো। কোন কোন key invalidate হবে? Project 3 এ যদি আরও ৪ জন member থাকে, তাদের cached list গুলোর কী হবে — আর এটা কী নতুন সমস্যা তৈরি করে?

2. উপরের সমস্যাটা এড়াতে **version key** পদ্ধতি কীভাবে সাহায্য করতে পারে? `tasks:project:3` এর জন্য একটা version-ভিত্তিক key design লিখে দেখাও।

3. TaskFlow এর জন্য Redis এ কোন `maxmemory-policy` বেছে নেবে, আর কেন? তোমার উত্তরে এটাও বলো — যদি একই Redis instance এ cache **এবং** session data (যেগুলো হারালে user logout হয়ে যাবে) দুটোই রাখা হয়, তাহলে তোমার পছন্দ কি বদলাবে?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (সম্পূর্ণ), 4.1, 4.2
Current: 4.3 — Invalidation, TTL & Eviction
TaskFlow state: Nginx reverse proxy + LB সামনে, horizontal-scale-ready backend,
caching design সম্পূর্ণ কাগজে (Cache-Aside + invalidate-on-write, TTL ৩০-৬০s,
allkeys-lru) — এখনো একটাও line code লেখা হয়নি, পরের lesson এ Redis বসবে
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution
Weak spots: [আজকের exercise এ দেখার বিষয় — derived/filtered view এর key গুলো
(যেমন :completed, :page:2) invalidation এর সময় মনে থাকছে কিনা; এগুলোই
বাস্তবে সবচেয়ে বেশি miss হয়]
Next: 4.4 — Redis Hands-on: Express + Sequelize এ caching layer (Tier 1, প্রথম
runnable code এই module এ)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষ করে ৩ নম্বরের শেষ অংশটা (cache আর session একসাথে), ওখানে একটা ফাঁদ আছে।

রেডি হলে `next` লিখো — Lesson 4.4 এ অবশেষে **code**। গত তিনটা lesson এ যা যা ঠিক করেছি — Cache-Aside, invalidate-on-write, TTL, LRU — সবগুলো একসাথে বসিয়ে TaskFlow এ একটা সত্যিকারের Redis caching layer বানাব, Express + Sequelize + Redis দিয়ে। আর মেপে দেখব cache আসলে কতটা পার্থক্য করল।
