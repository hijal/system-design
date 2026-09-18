# Lesson 4.6 — Cache Failure Patterns: Stampede, Hot Key, Penetration

**Module 4 — Caching**

> **Spaced Repetition (Lesson 3.4):** Graceful shutdown এর ধাপগুলো কী, আর কেন এটা planned maintenance এ কাজ করে কিন্তু হঠাৎ crash এ করে না?

**Prerequisite:** Lesson 4.4 (Redis Hands-on), Lesson 4.3 (TTL, Eviction)

**তুমি এই lesson শেষে পারবে:**

1. Cache stampede, hot key, penetration আর avalanche — চারটা ব্যর্থতার ধরন আলাদা করে চিনতে পারবে
2. প্রতিটার জন্য উপযুক্ত প্রতিকার (single-flight, TTL jitter, local cache, negative caching) বেছে নিতে পারবে
3. Stampede টা নিজের মেশিনে ঘটিয়ে, তারপর সারিয়ে — **সংখ্যায়** পার্থক্যটা দেখাতে পারবে

**Tier:** 1 — Runnable Code

---

## ০. TaskFlow এখন কোথায়

Module 4 জুড়ে আমরা TaskFlow এ caching বসিয়েছি, আর সেটা কাজ করছে — মাপা হয়েছে, DB path ~১২ ms, cache path ~৩.৭ ms, hit ratio ২০/২০।

তাহলে সব ঠিক? না।

আজকের lesson এর মূল কথাটা একটু অদ্ভুত শোনাবে, কিন্তু এটাই সত্য:

> **Cache এর সবচেয়ে ভয়ংকর ব্যর্থতাগুলো ঘটে তখন, যখন cache ঠিকঠাক কাজ করছিল।**

Cache না থাকলে তোমার DB প্রতিদিন ১০০% load নিত — ধীর, কিন্তু স্থিতিশীল। Cache বসানোর পর DB এখন ৫% নেয়। কিন্তু এর মানে দাঁড়ালো, তোমার DB এখন এমন একটা load এর জন্য আকারে ছোট, যেটা যেকোনো মুহূর্তে ফিরে আসতে পারে। **Cache একটা নির্ভরতা তৈরি করেছে, আর সেই নির্ভরতা ভাঙার নিজস্ব কিছু ধরন আছে।**

আজকে সেই ধরনগুলো — আর প্রথমটা আমরা শুধু পড়ব না, নিজের মেশিনে **ঘটাবো**।

---

## ১. Theory

### ১.১ Cache Stampede — একসাথে সবাই miss করা

দৃশ্যটা ভাবো। TaskFlow এর একটা জনপ্রিয় list, `tasks:user:7`, TTL ৬০ সেকেন্ড। সেকেন্ডে ৫০টা request আসছে।

```
t = 59.9s   cache এ আছে   →  ৫০টা request-ই HIT, DB শান্ত
t = 60.0s   TTL শেষ        →  key মুছে গেল
t = 60.1s   ৫০টা request   →  ৫০টাই MISS
                            →  ৫০টাই একই মুহূর্তে DB তে একই query পাঠায়
```

৫০টা request, **একই উত্তর** চাইছে, আর ৫০ বার আলাদা করে DB কে জিজ্ঞেস করছে। ৪৯টা query সম্পূর্ণ অপচয় — প্রথমটার উত্তর এলেই বাকি সবার কাজ হয়ে যেত।

একে বলে **cache stampede** (বা **thundering herd** — একদল মহিষ একসাথে ছুটে আসার মতো)। ৫০ এ সমস্যা হয়তো টিকে যাবে, কিন্তু ৫০০০ এ DB এর connection pool শেষ হয়ে যাবে, query queue জমবে, latency বাড়বে — আর latency বাড়লে আরও বেশি request একসাথে জমা হবে। এটা নিজেকে নিজে খাওয়ানো একটা চক্র।

**এটা শুধু তত্ত্ব না — exercise এ তুমি এটা ঘটিয়ে দেখবে।** আমার মেশিনে মাপা:

```
৫০টা request একসাথে, cache সদ্য খালি, DB query ~200ms:

  single-flight ছাড়া : DB query  50 টা   (802 ms)
  single-flight সহ   : DB query   1 টা   (254 ms)
```

**৫০ থেকে ১।**

### ১.২ একটা জরুরি শর্ত — stampede এর "জানালা"

উপরের মাপে `DB query ~200ms` লেখাটা খেয়াল করেছ? ওটা আলংকারিক না, **ওটাই পুরো ব্যাপারটার শর্ত**।

এই exercise টা বানানোর সময় প্রথমে আসল query (~১২ ms) দিয়েই চেষ্টা করেছিলাম, আর stampede **ঘটেইনি** — ৫০টা request পাঠিয়ে DB query হয়েছিল মাত্র ১-২টা। কারণ:

```
t=0ms    req1 miss করল, DB তে গেল
t=12ms   req1 এর উত্তর এলো, cache এ লেখা হলো
t=13ms   req2..req50 এলো  →  cache এ পেয়ে গেল  →  HIT
```

প্রথম request এতই দ্রুত শেষ হয়েছে যে বাকিরা আসার আগেই cache ভরে গেছে। **যে সময়টুকুতে cache খালি আর প্রথম load চলছে — সেটাই stampede এর জানালা।** জানালা সরু হলে সমস্যাটা কার্যত নেই।

এখান থেকে যা শেখার:

> **Stampede তখনই বিপজ্জনক, যখন origin এর কাজটা ধীর** — একটা ভারী aggregation, একটা external API call, একটা জটিল join। সস্তা query তে stampede নিয়ে দুশ্চিন্তা করা সময়ের অপচয়।

তাই exercise এ `?delay=200` দিয়ে একটা "দামি query" নকল করা হয়েছে — নাহলে সমস্যাটা চোখেই পড়ত না। তোমার production এ প্রশ্নটা তাই দুই ধাপে: _কোন endpoint গুলো ধীর?_ আর _তাদের মধ্যে কোনগুলো জনপ্রিয়?_ — এই দুইয়ের ছেদেই stampede বাস করে।

### ১.৩ Single-flight — একই key, একটাই load

সমাধানের ধারণাটা সহজ: **একই key এর জন্য একসাথে একটাই DB query চলবে**, বাকিরা তার ফলাফলের জন্য অপেক্ষা করবে।

```
ছাড়া :  req1 ──> DB        req2 ──> DB       req3 ──> DB     (৩টা query)

সহ   :  req1 ──> DB ──┐
        req2 ─────────┤ একই promise এর জন্য অপেক্ষা           (১টা query)
        req3 ─────────┘
```

Node এ এটা লিখতে অবাক করার মতো কম code লাগে, কারণ **promise নিজেই একটা ভাগ করে নেওয়ার যোগ্য জিনিস**:

```typescript
const inFlight = new Map<string, Promise<unknown>>();

export async function single<T>(key: string, load: () => Promise<T>): Promise<T> {
	const running = inFlight.get(key);
	if (running !== undefined) {
		// অন্য কেউ ইতিমধ্যে এই key টা load করছে — নতুন query না করে
		// তার ফলাফলের জন্যই অপেক্ষা করো
		return (await running) as T;
	}

	const promise = load().finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
}
```

**একটা সূক্ষ্ম ফাঁদ — কী মুড়ছ সেটা গুরুত্বপূর্ণ।** এই exercise বানানোর সময় আমি প্রথমে শুধু DB load টাকে `single()` দিয়ে মুড়েছিলাম, আর cache এ লেখাটা বাইরে রেখেছিলাম। ফল: ৫০টার বদলে **২টা** DB query — ১টা না। কারণ একটা সরু ফাঁক থেকে যাচ্ছিল:

```
load শেষ  →  finally চলল, in-flight entry মুছে গেল
             ↑ এই মুহূর্তে cache এ এখনো কিছু লেখা হয়নি
             ↑ ঠিক এখন আসা request টা miss করবে, আর in-flight ও পাবে না
             ↑ ফলে সে আরেকটা load শুরু করে দেবে
cache এ লেখা হলো
```

সমাধান: **load আর cache write — দুটোকেই একসাথে মুড়তে হবে**, যাতে in-flight entry টা cache ভরা পর্যন্ত টিকে থাকে:

```typescript
const loadAndCache = async (): Promise<TaskDTO[]> => {
	const rows = await loadFromDatabase(userId, completedOnly);
	await writeList(key, rows, TTL_SECONDS);
	return rows;
};
const tasks = await single(key, loadAndCache);
```

এটা ঠিক করার পরেই সংখ্যাটা ২ থেকে ১ এ নামে। শিক্ষাটা সাধারণ: **concurrency এর সমস্যায় "কোন কাজটা রক্ষা করছি" সীমাটা এক পদক্ষেপ ভুল হলেই bug থেকে যায়** — আর এমন bug load কম থাকলে কখনো চোখে পড়ে না।

**একটা গুরুত্বপূর্ণ সীমাবদ্ধতা:** এই Map টা **একটা process এর ভেতরে**। TaskFlow এ ৪টা server instance চললে (Module 3 মনে আছে?), প্রতিটা instance এর নিজের Map — মানে ৫০টা query ১টায় নামবে না, নামবে **৪টায়**। ৫০ থেকে ৪ ও বিশাল উন্নতি, কিন্তু ১ পেতে হলে **distributed lock** লাগবে (Redis এ `SET key value NX PX 5000`), যেটা Lesson 6.4 এর বিষয়।

**বিকল্প কৌশল, code ছাড়াই:** Lesson 4.5 এর `stale-while-revalidate` মনে আছে? একই যুক্তি Redis এও খাটানো যায় — TTL শেষ হওয়ার পরেও কিছুক্ষণ বাসি value টা রেখে দাও, আর কেউ চাইলে **বাসিটা সাথে সাথে দিয়ে দাও**, পেছনে একজনকে দিয়ে নতুনটা আনাও। কেউ অপেক্ষাই করে না, DB ও একবারই hit খায়।

### ১.৪ TTL Jitter — সবাই একসাথে মরে না যায়

Stampede এর একটা বড় ভাই আছে। ভাবো, তোমার server restart হলো (deploy, বা Lesson 3.4 এর graceful shutdown এর পর)। Cache খালি। প্রথম মিনিটে ১০০০টা আলাদা key cache এ ঢুকল — **সবগুলোর TTL ঠিক ৩০০ সেকেন্ড**।

```
t = 0s     ১০০০টা key cache এ ঢুকল, সবার TTL ৩০০s
t = 300s   ১০০০টা key একসাথে মরল  →  একসাথে ১০০০টা stampede
```

প্রতি ৫ মিনিট পর পর তোমার DB একটা করে ঢেউ খাবে। একে বলে **cache avalanche** — অনেকগুলো key একসাথে expire হওয়া।

প্রতিকার হাস্যকর রকম সহজ — TTL এ একটু **এলোমেলো** মেশাও:

```typescript
const BASE_TTL = 300;
const ttl = BASE_TTL + Math.floor(Math.random() * 60); // ৩০০–৩৬০s
```

এখন ওই ১০০০টা key ৬০ সেকেন্ড জুড়ে ছড়িয়ে মরবে, একসাথে না। একে বলে **TTL jitter**। এক লাইনের পরিবর্তন, কিন্তু এটা না থাকলে তোমার DB তে periodic spike আসতেই থাকবে — আর সেই spike এর কারণ খুঁজে বের করা ভয়ানক কঠিন, কারণ graph এ সেটা দেখতে "রহস্যময় প্রতি ৫ মিনিটের চূড়া" এর মতো।

### ১.৫ Hot Key — একটা key এতই জনপ্রিয় যে সে নিজেই সমস্যা

এবার সম্পূর্ণ আলাদা ধরনের ব্যর্থতা। ধরো TaskFlow এ একটা shared project এর task list, যেটা **পুরো কোম্পানি** দেখে — সেকেন্ডে ৫০,০০০ request, সবই একই key তে।

Cache hit ratio ১০০%। TTL নিয়ে কোনো সমস্যা নেই। তবু system ধুঁকছে। কেন?

কারণ **একটা key সবসময় একটা নির্দিষ্ট Redis node এ থাকে**। Redis cluster এ key গুলো hash করে shard এ ভাগ হয় — মানে তুমি ১০টা node যোগ করলেও, ওই একটা key এর সব traffic **একটা node ই** নেবে। আর Redis single-threaded, তাই ওই একটা node এর CPU ১০০% হয়ে বসে থাকবে, বাকি ৯টা অলস।

একে বলে **hot key** সমস্যা। সমাধান দুটো:

**(ক) Local (in-process) cache — একটা L1 স্তর।** সবচেয়ে জনপ্রিয় key গুলো প্রতিটা app server এর **নিজের memory তেই** কয়েক সেকেন্ডের জন্য রেখে দাও:

```
request ──> [process memory, TTL 5s] ──> [Redis] ──> [DB]
                  ~0.001 ms              ~0.5 ms
```

৫ সেকেন্ডের local cache দিয়ে ৫০,০০০ req/s কে Redis এর দিক থেকে নামিয়ে আনা যায় প্রায় **server সংখ্যা ÷ ৫** এ। দাম: এখন staleness এর আরেকটা স্তর যোগ হলো, আর প্রতিটা server এ সামান্য আলাদা data থাকতে পারে।

**(খ) Key splitting.** একই value কে কয়েকটা আলাদা key তে রাখো (`hot:project:3:0` … `hot:project:3:9`), আর প্রতিটা request এলোমেলোভাবে একটা বাছুক। ভিন্ন key মানে ভিন্ন hash, মানে ভিন্ন node — load ছড়িয়ে গেল। দাম: invalidate করতে হলে ১০টাই মুছতে হবে।

### ১.৬ Cache Penetration — যা নেই, তা বারবার খোঁজা

এই ধরনটা সবচেয়ে চতুর, কারণ এখানে cache "কাজ করছে" বলেই মনে হয়।

কেউ (একটা ভুল script, বা একজন আক্রমণকারী) বারবার এমন id চাইছে যা **অস্তিত্বেই নেই**:

```
GET /api/tasks/999999   →  cache এ নেই (স্বাভাবিক, জিনিসটাই নেই)
                        →  DB তে গেল  →  DB ও বলল "নেই"
                        →  cache এ কিছুই লেখা হলো না  ← এটাই ফাঁদ
                        →  পরের বার আবার একই ঘটনা
```

প্রতিটা request DB পর্যন্ত যাচ্ছে, অথচ cache hit ratio এর হিসাবে এটা ধরাই পড়ছে না। **Cache টা কার্যত bypass হয়ে গেছে।**

প্রতিকার:

**(ক) Negative caching** — "নেই" উত্তরটাও cache করো, শুধু অল্প সময়ের জন্য:

```typescript
if (task === null) {
	await redis.set(key, 'NOT_FOUND', 'EX', 30); // ছোট TTL
}
```

TTL ছোট রাখা জরুরি, নাহলে জিনিসটা সত্যিই তৈরি হলেও ৩০ সেকেন্ড "নেই" বলতে থাকবে।

**(খ) Bloom filter** — একটা ছোট্ট probabilistic structure যেটা বলতে পারে "এই id টা **নিশ্চিতভাবে নেই**" বা "হয়তো আছে"। "নিশ্চিতভাবে নেই" হলে DB তে যাওয়ারই দরকার নেই। এটা Lesson 10.2 এর বিষয়।

### ১.৭ চারটা একসাথে

> **Trade-off Table — কোন ব্যর্থতা, কোন প্রতিকার**

| ব্যর্থতা        | কখন ঘটে                                | লক্ষণ                              | প্রতিকার                              |
| --------------- | -------------------------------------- | ---------------------------------- | ------------------------------------- |
| **Stampede**    | একটা জনপ্রিয় key expire               | TTL এর ছন্দে DB spike              | single-flight, stale-while-revalidate |
| **Avalanche**   | অনেক key একসাথে expire (বা cache down) | নিয়মিত বিরতিতে DB spike           | **TTL jitter**, origin shield         |
| **Hot Key**     | একটা key তে অস্বাভাবিক traffic         | এক Redis node ১০০% CPU, বাকিরা অলস | local (L1) cache, key splitting       |
| **Penetration** | অনুপস্থিত id বারবার চাওয়া             | hit ratio ভালো, তবু DB ব্যস্ত      | negative caching, bloom filter        |

লক্ষ্য করো — **চারটার লক্ষণ আলাদা, তাই রোগনির্ণয়টাই আসল কাজ**। "DB তে load বেশি" দেখে যেকোনো একটা প্রতিকার বসিয়ে দিলে কাজ হবে না। DB spike টা কি TTL এর ছন্দে আসছে (stampede/avalanche), নাকি একটানা (penetration), নাকি Redis এর একটা node গরম (hot key) — এটাই তোমার প্রথম প্রশ্ন।

---

## ২. Interview Angle

এই lesson টা interview এ সেই জায়গা যেখানে তুমি "caching জানি" থেকে "caching চালিয়েছি" তে উন্নীত হও। প্রায় সব candidate Cache-Aside বলতে পারে; **খুব কম জন বলতে পারে cache থাকার কারণে কী কী নতুন সমস্যা তৈরি হয়**।

সবচেয়ে common প্রশ্ন: **"তোমার একটা জনপ্রিয় cache entry expire হলো, আর ঠিক সেই মুহূর্তে ১০০০টা request এলো — কী হবে?"** এটা সরাসরি stampede এর প্রশ্ন। উত্তরে সমস্যাটার নাম বলো, তারপর প্রতিকার — single-flight/lock, আর stale-while-revalidate। যদি যোগ করতে পারো যে in-process lock একাধিক instance এ শুধু _কমায়_, _মেটায় না_ (distributed lock লাগে), তাহলে তুমি স্পষ্টভাবে আলাদা।

দ্বিতীয়টা প্রায়ই follow-up হিসেবে আসে: **"cache hit ratio ৯৮%, তবু DB এর load বেশি — কেন হতে পারে?"** এখানে দুটো উত্তরই ভালো: (ক) penetration — যেসব key কখনো cache হয় না সেগুলোই DB তে যাচ্ছে, hit ratio তে ধরাই পড়ছে না; (খ) ওই ২% ই হয়তো সবচেয়ে ভারী query।

আর একটা প্রশ্ন যেটা দিয়ে seniority মাপা হয়: **"Redis cluster এ node যোগ করলাম, তবু একটা node এর CPU ১০০% — কেন?"** — hot key। Key hash করে shard এ যায়, তাই একটা key এর traffic কখনো ভাগ হয় না। এটা জানা মানে তুমি Redis কে কালো বাক্স হিসেবে দেখছ না।

---

## ৩. Key Takeaway

- **Cache এর ব্যর্থতাগুলো cache থাকার কারণেই তৈরি হয়** — DB এখন এমন load এর জন্য ছোট, যা যেকোনো সময় ফিরে আসতে পারে
- **Stampede** — একটা জনপ্রিয় key expire হলে N টা concurrent miss, N টা একই DB query (মাপা: ৫০ request → ৫০ query)
- **Single-flight** সেটা ১ এ নামায় (মাপা: ৫০ → ১), কিন্তু in-process lock একাধিক instance এ instance-সংখ্যা পর্যন্তই নামাবে
- Single-flight এ **load আর cache write দুটোই** একসাথে মুড়তে হয় — নাহলে একটা সরু ফাঁক থেকে যায়
- **Stampede তখনই বিপজ্জনক যখন origin এর কাজটা ধীর** — সস্তা query তে জানালাটাই সরু, সমস্যা কার্যত নেই
- **Avalanche** — অনেক key একসাথে expire; প্রতিকার **TTL jitter**, এক লাইনের পরিবর্তন
- **Hot Key** — একটা key সবসময় একটা node এ; node যোগ করে এটা সমাধান হয় না। প্রতিকার: local (L1) cache বা key splitting
- **Penetration** — অনুপস্থিত id বারবার চাওয়া; hit ratio ভালো দেখায়, তবু DB ব্যস্ত। প্রতিকার: negative caching (ছোট TTL), bloom filter
- চারটার **লক্ষণ আলাদা** — DB spike টা TTL এর ছন্দে না একটানা, সেটাই প্রথম প্রশ্ন
- `stale-while-revalidate` (Lesson 4.5) শুধু CDN এর জিনিস না — একই যুক্তি Redis এও খাটে

---

## ৪. নতুন Term (Glossary)

| Term                 | অর্থ                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| **Cache Stampede**   | একটা key expire হওয়ার মুহূর্তে অনেকগুলো request একসাথে miss করে DB তে ঝাঁপানো |
| **Thundering Herd**  | একই ঘটনার আরেক নাম — একদল request একসাথে একই resource এর দিকে ছোটা             |
| **Single-flight**    | একই key এর concurrent load গুলোকে একটাই আসল query তে মিলিয়ে দেওয়া            |
| **TTL Jitter**       | TTL এ সামান্য এলোমেলো যোগ করা, যাতে key গুলো একসাথে expire না করে              |
| **Cache Avalanche**  | অনেক key একসাথে expire করা (বা পুরো cache down), ফলে origin এ ঢেউ              |
| **Hot Key**          | এমন একটা key যার traffic এত বেশি যে সে একা একটা node কে সম্পৃক্ত করে ফেলে      |
| **Negative Caching** | "এই জিনিসটা নেই" — এই উত্তরটাও অল্প সময়ের জন্য cache করা                      |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর Answer Key খুলো।

1. Exercise এ single-flight ৫০টা DB query কে ১ এ নামিয়েছে। কিন্তু TaskFlow production এ ৪টা server instance চলে। তখন সংখ্যাটা কত হবে, আর কেন? ১ এ নামাতে চাইলে কী লাগবে?

2. একজন developer stampede ঠেকাতে TTL ৬০ সেকেন্ড থেকে বাড়িয়ে **১ ঘণ্টা** করে দিল — যুক্তি: "কম expire হলে কম stampede"। এতে stampede কি আসলেই কমবে? আর এই সিদ্ধান্তে কী কী নতুন সমস্যা তৈরি হলো?

3. TaskFlow এর monitoring দেখাচ্ছে: cache hit ratio **৯৭%**, Redis এর CPU স্বাভাবিক, কোনো node গরম না, DB তে load **একটানা বেশি** — কোনো spike নেই, কোনো ছন্দ নেই, শুধু সবসময় বেশি। কোন ব্যর্থতাটা সন্দেহ করবে, আর সেটা নিশ্চিত করতে কী দেখবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** সংখ্যাটা হবে **৪** — প্রতিটা instance এ একটা করে।

কারণ `inFlight` Map টা একটা **process এর নিজের memory তে**। Instance A জানেই না যে instance B ইতিমধ্যে ওই key টা load করছে। তাই প্রতিটা instance নিজে নিজে একবার করে DB তে যাবে।

৫০ → ৪ ও কিন্তু বিশাল (৯২% কমল), আর এটা কার্যত বিনামূল্যে — কোনো বাড়তি infrastructure লাগেনি। বাস্তবে বেশিরভাগ system এর জন্য এটুকুই যথেষ্ট।

১ এ নামাতে চাইলে **distributed lock** লাগবে — Redis এ `SET lock:tasks:user:7 <id> NX PX 5000`। যে instance lock টা পায় সে DB তে যায়, বাকিরা একটু অপেক্ষা করে cache থেকে পড়ে নেয়। কিন্তু এতে নতুন জটিলতা আসে: lock holder crash করলে? (তাই PX/expiry বাধ্যতামূলক), আর lock এর জন্য অপেক্ষা করা request গুলোর latency? এই পুরো আলোচনা Lesson 6.4 এ।

**মূল শিক্ষা:** "একটা প্রতিকার সমস্যাটা ৯২% কমিয়ে দিল, বাকি ৮% এর জন্য ১০ গুণ জটিলতা নেব কিনা" — এই প্রশ্নটাই engineering।

**প্রশ্ন ২:** Stampede এর **ঘটনা কমবে**, কিন্তু **প্রতিটা ঘটনা আরও খারাপ হবে**, আর সাথে অন্য সমস্যা আসবে।

- ঘটনা কমবে: ঘণ্টায় একবার expire, তাই দিনে ২৪ বার stampede (আগে ১৪৪০ বার)
- প্রতিটা খারাপ হবে: ১ ঘণ্টা ধরে data জমেছে, তাই expire হওয়ার মুহূর্তে আরও বেশি request অপেক্ষা করছে
- **Staleness ১ ঘণ্টা** (Lesson 4.3) — user একটা task বদলে ১ ঘণ্টা পুরনোটা দেখবে। এটাই সবচেয়ে বড় ক্ষতি
- Memory তে বেশি সময় বসে থাকা key = বেশি eviction চাপ (Lesson 4.3)

মূল কথা: **TTL দিয়ে stampede সারানোর চেষ্টাটাই ভুল ওষুধ**। TTL এর কাজ freshness ঠিক করা; stampede এর ওষুধ single-flight বা stale-while-revalidate। একটা সমস্যার জন্য ভুল knob ঘোরালে অন্য জায়গায় দাম দিতে হয়।

**প্রশ্ন ৩:** **Cache penetration** সন্দেহ করবে।

যুক্তিটা বাদ দেওয়ার প্রক্রিয়ায়:

- Spike নেই, ছন্দ নেই → stampede বা avalanche না (দুটোই TTL এর ছন্দে spike বানায়)
- কোনো node গরম না → hot key না
- Hit ratio ৯৭% অথচ DB ব্যস্ত → মানে যে request গুলো DB তে যাচ্ছে, সেগুলো **hit ratio এর হিসাবেই ঢুকছে না**

এটাই penetration এর স্বাক্ষর — অনুপস্থিত key এর জন্য cache এ কিছু লেখাই হয় না, তাই সেগুলো hit/miss এর পরিসংখ্যানে ঠিকমতো প্রতিফলিত হয় না, অথচ প্রতিটা DB পর্যন্ত যায়।

**নিশ্চিত করতে কী দেখবে:** DB এর query log এ কত ভাগ query **শূন্য row** ফেরত দিচ্ছে। যদি সেটা অস্বাভাবিক বেশি হয় (ধরো ৪০%), তাহলে ধরা পড়ে গেল। সাথে application log এ 404 response এর হার দেখো — একই গল্প বলবে।

প্রতিকার: negative caching (ছোট TTL সহ), আর যদি id গুলো একটা জানা সীমার হয় তাহলে সীমার বাইরের request গুলো DB তে যাওয়ার আগেই ফিরিয়ে দাও।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-4.4-redis-cache/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-4.4-redis-cache) — Lesson 4.4 এর সেই setup টাই, সাথে এই lesson এর জন্য `npm run stampede` যোগ করা হয়েছে।

```bash
docker compose up -d && npm install && npm run seed
npm run build && npm start     # আলাদা terminal এ
npm run stampede
```

**যা করতে হবে:**

1. `npm run stampede` চালাও। তোমার মেশিনে single-flight ছাড়া আর সহ — DB query সংখ্যা কত? আমার পাওয়া ৫০ → ১ এর সাথে মেলে?

2. `src/stampede.ts` এ `CONCURRENCY` ৫০ থেকে **২০০** করে দাও। Single-flight ছাড়া সময়টা কীভাবে বাড়ে — রৈখিকভাবে, নাকি তার চেয়ে দ্রুত? কেন বলে মনে করো? (ইঙ্গিত: `src/db.ts` এ `pool: { max: 10 }`।)

3. **TTL jitter যোগ করো।** `src/server.ts` এ `TTL_SECONDS` এর বদলে এমন একটা TTL ব্যবহার করো যাতে ±১০% এলোমেলো মেশানো থাকে। তারপর ব্যাখ্যা করো — এই পরিবর্তনটা §১.১ এর stampede এ সাহায্য করে, নাকি §১.৪ এর avalanche এ? দুটো সমস্যা আলাদা কেন?

4. **Negative caching বানাও।** একটা নতুন endpoint `GET /api/tasks/:id` যোগ করো যেটা Cache-Aside ব্যবহার করে। এবার এমন একটা id চাও যা নেই (যেমন `999999`), বারবার — `/api/_stats` দেখে বুঝবে প্রতিবার DB তে যাচ্ছে। এবার "নেই" উত্তরটাও ৩০ সেকেন্ডের TTL সহ cache করো, আর আবার মেপে দেখাও পার্থক্যটা।

5. **চিন্তার প্রশ্ন (code লাগবে না):** single-flight এর `inFlight` Map টা যদি কখনো `finally` তে delete না করত, তাহলে কী হতো? এটা কী ধরনের bug — আর production এ কত দিন পর ধরা পড়ত?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (সম্পূর্ণ), 4.1, 4.2, 4.3, 4.4, 4.5
Current: 4.6 — Cache Failure Patterns
TaskFlow state: Nginx reverse proxy + LB, horizontal-scale-ready backend,
Redis caching layer (Cache-Aside + invalidate, মাপা 12ms → 3.7ms),
CDN নকশা ঠিক, আর এখন stampede-প্রতিরোধী single-flight বসানো
(মাপা: ৫০ concurrent miss এ DB query ৫০ → ১)
Terms learned (Module 4 সম্পূর্ণ): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution, Cache Hit Ratio,
Discriminated Union, Fail-safe, Connection Timeout, Anycast, Cache Key,
s-maxage, stale-while-revalidate, ETag, Purge, Origin Shield,
Cache Stampede, Thundering Herd, Single-flight, TTL Jitter,
Cache Avalanche, Hot Key, Negative Caching
Weak spots: [cache down হলে latency ধসে পড়া (4.4 ex.৪); public vs private এর
নিরাপত্তা তাৎপর্য (4.5 ex.৪)। আজকের নজর — রোগনির্ণয়: DB load বেশি দেখলেই
প্রতিকার না বসিয়ে আগে "spike নাকি একটানা" জিজ্ঞেস করা]
Next: Module 4 Exit Challenge
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষ করে ২ আর ৪ নম্বর, ওদুটোয় হাতে-কলমে যা দেখবে সেটা পড়ে বোঝা যায় না।

রেডি হলে `next` লিখো — **Module 4 Exit Challenge**। ছয়টা lesson এর সবকিছু একসাথে, একটা বাস্তব চাপের scenario তে। তারপর Module 5: Database Design & Scaling — যেখানে আমরা সেই DB টার ভেতরে ঢুকব, যাকে আমরা এতক্ষণ ধরে বাঁচানোর চেষ্টা করছিলাম।
