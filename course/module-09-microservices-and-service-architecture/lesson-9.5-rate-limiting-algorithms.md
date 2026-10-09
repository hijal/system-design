# Lesson 9.5 - Rate Limiting Algorithms

**Module 9 - Microservices & Service Architecture**

> **Spaced Repetition (Lesson 4.3):** Redis এ `maxmemory-policy` এর default কী, আর pure cache হলে আপনি কোনটা সেট করতে বলেছিলাম? আর `allkeys-lru` আর `volatile-lru` এর পার্থক্যটা এক লাইনে? আজ এই সিদ্ধান্তটা অপ্রত্যাশিত জায়গায় ফিরবে - যখন আপনার rate limiter এর গোনাগুলো ওই একই Redis এ থাকবে।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.5 (p99), Lesson 2.5 (Error contract, 429, header), Lesson 4.3 (TTL, eviction policy), Lesson 4.6 (Thundering herd), Lesson 7.4 (Retry, backoff, backpressure), Lesson 9.2 (API gateway এর দায়িত্ব), Lesson 9.4 (Bulkhead, fail fast, breaker)

**আপনি এই lesson শেষে পারবেন:**

1. পাঁচটা rate limiting algorithm এর পার্থক্য **সংখ্যা দিয়ে** বলতে পারবেন - কে window এর সীমানায় দ্বিগুণ ঢুকতে দেয়, কে নির্ভুল কিন্তু কত memory খায়, আর কে burst সহ্য করে
2. Token bucket আর leaky bucket এর মধ্যে বাছতে পারবেন - কারণ প্রশ্নটা "কত" না, "কত একসাথে"; আর capacity এর মানে ঠিক কী সেটা বলতে পারবেন
3. কয়েকটা instance এ সীমা প্রয়োগ করার আসল সমস্যা ধরতে পারবেন (সীমা × instance সংখ্যা) আর তার সমাধানের দাম - ভাগ করা store, তার atomicity, আর সে মরলে fail open না fail closed

**Tier:** 1 - Runnable Code (পাঁচটা algorithm virtual clock এ deterministic ভাবে মাপা, আর তিনটা আসল Express instance এ middleware - Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

Lesson 9.2 এ gateway এর দায়িত্বের তালিকায় "rate limit" লেখা হয়েছিল, কিন্তু বসানো হয়নি। Lesson 9.4 এ আমরা নিজেদের worker ভাগ করেছি - কিন্তু বাইরে থেকে আসা চাপটা সীমিত করিনি। এই মাসে তার দাম এলো, তিনটা চেহারায়:

1. **একজন customer এর script।** একটা integration লেখা হয়েছে যা প্রতি ৫ সেকেন্ডে সব task fetch করে - কিন্তু bug এর কারণে retry loop এ ঢুকে গেছে, backoff ছাড়া (Lesson 7.4 এর ঠিক উল্টো)। একটা API key থেকে সেকেন্ডে ৯০০টা request। অন্য সব customer এর p99 তিন গুণ।
2. **Login এ brute force।** Security team এর report: একটা IP থেকে ৪০ মিনিটে ১২,০০০ বার login এর চেষ্টা, ২০০টা আলাদা email এ। কোনো সীমা নেই, তাই কেউ থামায়নি।
3. **নিজেদের পায়ে কুড়াল।** Billing service কে (9.3, 9.4) work থেকে ডাকা হয়। একটা migration script একবারে ৫০,০০০ workspace এর quota মিলাতে গিয়ে billing এ সেকেন্ডে ২,০০০ call পাঠাল। Billing এর p99 ২ সেকেন্ড - আর 9.4 এর breaker খুলে গেল। অর্থাৎ আমাদের নিজেদের একটা script আমাদের নিজেদের service কে ফেলে দিল।

Team এ একজন বলল: "`express-rate-limit` বসিয়ে দিই, ১০০ per minute, শেষ।" CTO: "কোন algorithm? আর আমাদের তো ছয়টা instance - সীমাটা তখন আসলে কত? মাপুন।"

---

## ১. Theory

### ১.১ Rate Limiting কী, আর কেন এটা bulkhead এর পরের ধাপ

**Rate Limiting** - একটা নির্দিষ্ট পরিচয়ের (user, API key, IP, tenant) জন্য একটা সময়ে কতগুলো request গ্রহণ করা হবে তার সীমা ঠিক করা, আর সীমা ছাড়ালে বাকিগুলো ফিরিয়ে দেওয়া (সাধারণত HTTP 429)।

9.4 এর bulkhead আর এটা একই সমস্যার দুই দিক। Bulkhead বলে: "আমার ১৬টা slot এর মধ্যে billing এর জন্য ১২টা" - অর্থাৎ **নিজের সম্পদ ভাগ করা**। Rate limiting বলে: "আপনি সেকেন্ডে ১০টার বেশি চাইতে পারবেন না" - অর্থাৎ **চাহিদাকে সীমিত করা**। দুটো ছাড়া তৃতীয় কোনো উপায় নেই, কারণ সম্পদ সীমিত আর চাহিদার কোনো স্বাভাবিক সীমা নেই।

কেন একটা যন্ত্র দিয়ে চলে না: bulkhead ন্যায্যতা (fairness) দেয় না। 9.4 এর exercise এ create pool এ ১২টা slot ছিল - ঘটনা ১ এর ওই একটা customer এর script ওই ১২টা slot এর প্রায় সবই নিয়ে নিতে পারে, আর বাকি সব customer line এ দাঁড়াবে। Bulkhead board কে বাঁচিয়েছে, কিন্তু task তৈরির ভেতরে কে কতটা পাবে সেটা ঠিক করেনি। সেটা ঠিক করার একমাত্র উপায় পরিচয় ধরে গোনা।

আর একটা কথা যেটা প্রায়ই ভুল বোঝা হয়: rate limit **নিরাপত্তার যন্ত্র না, ন্যায্যতার যন্ত্র**। ঘটনা ২ (brute force) এ rate limit সাহায্য করে, কিন্তু সেটা DDoS আটকাবে না - ১০ লাখ IP থেকে আসা আক্রমণে প্রতিটা IP এর সীমা ঠিকই মানা হবে। ওটার উত্তর অন্য স্তরে (Lesson 10.5)।

### ১.২ Fixed Window Counter - সবচেয়ে সহজ, আর সীমানায় দ্বিগুণ

**Fixed Window Counter** - সময়কে নির্দিষ্ট দৈর্ঘ্যের ঘড়ি-ধরা জানালায় ভাগ করা (যেমন প্রতি সেকেন্ড), প্রতিটা key এর জন্য চলতি জানালার একটা গোনা রাখা, আর জানালা বদলালে গোনা শূন্য থেকে শুরু করা।

Code এ এটা তিন লাইন - একটা `Map`, একটা `windowStart`, একটা `count`। Redis এ `INCR` + `EXPIRE`। এই সরলতার জন্যই এটা সবচেয়ে বেশি ব্যবহৃত, আর এর সমস্যাটাও সবচেয়ে বেশি অবহেলিত।

সমস্যাটা হলো "সেকেন্ডে ১০" মানে **"যেকোনো এক সেকেন্ডে ১০" না** - মানে "প্রতিটা ঘড়ি-ধরা সেকেন্ডে ১০"। দুটো জানালার সংযোগস্থলে দুটো পূর্ণ কোটা পাশাপাশি বসে:

```
   সীমা: 10 প্রতি 1000 ms

   জানালা 1 [0 .. 1000)          জানালা 2 [1000 .. 2000)
   ───────────────────────┬──────────────────────────
                    ●●●●●●●●●●│●●●●●●●●●●
                    ↑ 985 ms  │  ↑ 1009 ms
                              │
                   এই 24 ms এ 20 টা পাশ করল - সীমার 2 গুণ
```

Exercise এর `npm run window`, অংশ ক - ১০টা চেষ্টা জানালার শেষে, ১০টা ঠিক পরের জানালার শুরুতে:

```
   algorithm                  allowed          span   times the limit
   fixed window                    20         24 ms              2.0x
   sliding log                     10          9 ms              1.0x
   sliding counter                 11         16 ms              1.1x
```

**২৪ ms এ ২০টা।** যে downstream কে আপনি সেকেন্ডে ১০টার জন্য প্রস্তুত করেছিলেন, সে ওই মুহূর্তে দ্বিগুণ পায়। আর এটা বিরল ঘটনা না - উল্টোটা: একটা client যদি "সীমা শেষ, পরের জানালার জন্য অপেক্ষা করি" এই যুক্তিতে চলে (আর ভালো client ঠিক সেটাই করে, `Retry-After` মেনে), তাহলে সে **সবসময়** জানালার শুরুতে এসে পড়বে - burst টা তখন নিয়ম হয়ে যায়, ব্যতিক্রম না।

### ১.৩ Sliding Window Log - নির্ভুল, কিন্তু দাম আছে

**Sliding Window Log** - প্রতিটা key এর জন্য অনুমোদিত প্রতিটা request এর সময় (timestamp) জমা রাখা; নতুন request এলে জানালার বাইরের পুরনো সময়গুলো ফেলে দিয়ে বাকিগুলো গোনা - গোনা সীমার কম হলেই অনুমতি।

এটা সংজ্ঞা অনুযায়ী নির্ভুল: "শেষ ১০০০ ms এ কতগুলো?" প্রশ্নের সঠিক উত্তরই সে দেয়। উপরের টেবিলে **১.০x**, আর সব পরীক্ষায় ১.০x।

দাম দুটো, আর দ্বিতীয়টা বেশি গুরুত্বপূর্ণ:

```
── c. Memory - 50,000 users, 10 requests each ──
   algorithm                  entries    bytes/user
   fixed window                 50000           109
   sliding log                  50000           253
   sliding counter              50000           117
```

- **Memory প্রতি user এ limit এর সমান** - সীমা ১০ এ ~২৫৩ bytes/user (বাকিদের ~২.৩ গুণ)। ১০ লাখ user এ ~২৫৩ MB, শুধু rate limit রাখার জন্য। আর সীমা যদি ১০ না হয়ে ১০০০ হয় (মিনিটে ১০০০ - খুব স্বাভাবিক একটা API সীমা), এটা প্রায় ১০০ গুণ। Lesson 1.3 এর estimation এর অভ্যাসটা এখানে সরাসরি কাজে লাগে: সীমা × user সংখ্যা × ৮ bytes হলো আপনার মেঝে, আর V8 বা Redis এর overhead তার উপরে।
- **কাজের পরিমাণ** প্রতি request এ O(limit) হতে পারে (পুরনোগুলো ছাঁটা)। Redis এ এটা সাধারণত একটা sorted set (`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`) - তিনটা command, আর atomicity এর জন্য Lua script।

তাই sliding log এর জায়গা আছে, কিন্তু নির্দিষ্ট: **ছোট সীমা, দামি resource**। যেমন "প্রতি ঘণ্টায় ৫টা password reset email" - এখানে নির্ভুলতা জরুরি, আর ৫টা timestamp রাখা সস্তা।

### ১.৪ Sliding Window Counter - আর একটা মাপ কীভাবে বিভ্রান্ত করে

**Sliding Window Counter** - দুটো গোনা রাখা (চলতি জানালা আর ঠিক আগের জানালা), আর চলতি জানালায় কতটা এগিয়েছি সেই অনুপাতে আগের জানালার গোনার একটা অংশ ধরে নেওয়া: `অনুমান = আগের গোনা × (1 − যতটা এগিয়েছি) + চলতি গোনা`।

ধারণাটা সুন্দর - fixed window এর মতোই সস্তা (~১১৭ bytes/user, দুটো সংখ্যা), অথচ সীমানার burst টা মিলিয়ে দেয়। উপরের অংশ ক এ সে **১.১x** - প্রায় নিখুঁত।

কিন্তু এখানেই exercise টা লিখতে গিয়ে একটা জিনিস ধরা পড়ল, আর সেটা এই lesson এর সবচেয়ে দরকারি অংশ। অংশ ক একটা **নির্দিষ্ট** burst দেখে। আসল প্রশ্নটা অন্য: **একজন user সবচেয়ে বেশি কত পাঠাতে পারে?** সেটা জানতে সব সম্ভাব্য শুরুর সময় ধরে সবচেয়ে খারাপটা খুঁজতে হয়:

```
   ── b. The most one user can send - the worst over every start time ──
   algorithm              worst / 1000 ms   times the limit          at phase
   fixed window                        20              2.0x            100 ms
   sliding log                         10              1.0x              0 ms
   sliding counter                     19              1.9x            820 ms
```

**১.১x নয় - ১.৯x।** একই algorithm, একই code, দুটো আলাদা মাপ। পার্থক্যটা কোথা থেকে আসে: একটা **নতুন** key তে আগের জানালার গোনা শূন্য, তাই প্রথম জানালায় সে পুরো কোটা সাথে সাথে দিয়ে দেয়; তারপর পরের জানালায় অনুমানটা ধীরে ধীরে নামে আর ফোঁটা ফোঁটা করে আরও ঢোকায়। ঠিক সময়ে (এখানে ৮২০ ms phase এ) শুরু করলে ওই দুটো মিলে একটা ১০০০ ms এ ১৯টা হয়ে যায়।

দুটো শিক্ষা এখান থেকে, আর দ্বিতীয়টা algorithm এর চেয়েও বড়:

1. Sliding window counter একটা **approximation** - সে স্মৃতি বাঁচায়, নির্ভুলতা না। Cloudflare এর মতো জায়গায় এটা ব্যবহৃত হয় কারণ তাদের কাছে ১.৯x গ্রহণযোগ্য আর স্মৃতির সঞ্চয়টা বিশাল। আপনার ক্ষেত্রে গ্রহণযোগ্য কিনা - সেটা আপনার downstream ঠিক করবে, algorithm এর নাম না।
2. **একটা মাপ দিয়ে কোনো protection বিচার করবেন না।** অংশ ক দেখে আমি ভাবতে পারতাম counter টা প্রায় log এর মতোই ভালো - ভুল হতো। Protection এর প্রশ্ন সবসময় "সবচেয়ে খারাপ ক্ষেত্রে কী", "সাধারণত কী" না। এটা 9.4 এর breaker এর ক্ষেত্রেও সত্যি ছিল, আর Module 10 এর প্রায় পুরোটাতেই সত্যি হবে।

### ১.৫ Token Bucket আর Leaky Bucket - প্রশ্নটা "কত" না, "কত একসাথে"

উপরের তিনটা algorithm একটা প্রশ্নের উত্তর দেয়: "সীমা ছাড়িয়েছে কি?" Bucket দুটো আলাদা প্রশ্ন করে: "চাপটা কেমন আকারে downstream এ পৌঁছাবে?"

**Token Bucket** - প্রতিটা key এর জন্য একটা বালতি যেখানে নির্দিষ্ট হারে token জমা হয় আর সর্বোচ্চ capacity পর্যন্ত থাকে; প্রতিটা request একটা token খরচ করে, token না থাকলে সে প্রত্যাখ্যাত - অর্থাৎ জমানো token দিয়ে একটা burst পাশ করতে পারে, তারপর সে token জমার হারে বাঁধা।

**Leaky Bucket** - একটা নির্দিষ্ট আকারের সারি (queue) যেখানে request জমা হয় আর নির্দিষ্ট হারে বেরোয়; সারি ভরা থাকলে নতুন request প্রত্যাখ্যাত, আর গৃহীত request গুলো **অপেক্ষা করে** সমান গতিতে বেরোয়।

মূল পার্থক্যটা গৃহীত হওয়ার হারে না - **বেরোনোর আকারে**। Exercise এর `npm run bucket`, একই আগমন (t=0 এ ৩০টার burst, তারপর ৫/s), হার ১০/s, capacity ১০:

```
   token bucket - the burst goes out at once:
         0 ms   11  ███████████
       250 ms    1  █
       500 ms    1  █
       750 ms    1  █
   leaky bucket - the same arrivals, going out at an even pace:
         0 ms    3  ███
       250 ms    2  ██
       500 ms    3  ███
       750 ms    2  ██

   peak instantaneous load downstream (per 250 ms): token bucket 11 · leaky bucket 3
```

গড় হার দুটোরই ~১০/s। কিন্তু downstream যেটা অনুভব করে সেটা গড় না - **শীর্ষ**: ১১ বনাম ৩। আর leaky bucket এর দাম সেখানেই: গৃহীত request গুলোকে অপেক্ষা করতে হয় (মাপা সবচেয়ে বেশি অপেক্ষা ১.০০ s), মানে user এর latency বাড়ে। Token bucket কাউকে অপেক্ষা করায় না - হয় এখনই যান, নয় 429।

আর capacity এর মানেটা একেবারে আক্ষরিক:

```
   capacity                     passed  passed in burst       load/250ms
   1                                16                1                2
   5                                20                5                6
   10                               25               10               11
   50                               45               30               31
```

**Capacity = আপনি যত বড় burst downstream এ যেতে দিতে রাজি।** এটা tuning এর জাদু সংখ্যা না, একটা সরাসরি সিদ্ধান্ত। আর এখানে একটা বাস্তব টান আছে: capacity ১ করলে চাপ সবচেয়ে কম (২), কিন্তু TaskFlow এর board খুললে browser একসাথে ৮টা API call করে - capacity ১ মানে ৭টা 429, প্রতিবার। তাই সঠিক capacity আসে আপনার **স্বাভাবিক** client এর আচরণ থেকে: একটা page load এ কতগুলো call? সেটাই মেঝে।

মোটা দাগে বাছাই: **API এর সামনে token bucket** (client স্বভাবতই bursty, আর অপেক্ষা করানোর চেয়ে দ্রুত 429 ভালো - 9.4 এর fail fast এর একই যুক্তি); **একটা ভঙ্গুর downstream এর সামনে leaky bucket** (তাকে সমান গতিতে খাওয়াতে হবে, আর অপেক্ষা করানো চলে) - যেমন ঘটনা ৩ এর migration script, যেটা billing কে সমান গতিতে ডাকলে breaker কখনো খুলত না।

### ১.৬ ছয়টা instance, একটা সীমা - আসল ভুলটা এখানে

এখন সবচেয়ে দামি অংশ, আর এটা algorithm এর প্রশ্নই না।

`express-rate-limit` এর default store হলো **in-memory** - প্রতিটা process এর নিজের `Map`। TaskFlow এর ছয়টা instance মানে ছয়টা আলাদা গোনা। Gateway (9.2) round robin করে ভাগ করে দেয়, তাই একজন user এর request ছয় ভাগে ছড়িয়ে যায় - আর প্রতিটা instance স্বাধীনভাবে ভাবে সে সীমার নিচে আছে।

Exercise এর `npm run distributed` - তিনটা আসল Express instance, সীমা ১০, একজন user round robin এ ৬০টা request:

```
   where counted                   200      429     real limit  store call
   each instance counts its own    30       30         3.0x             0
   shared store (RTT 1 ms)            10       50         1.0x            60
```

**আসল সীমা = আপনার লেখা সীমা × instance সংখ্যা।** তিনটা instance এ ৩.০x, ছয়টায় ৬x। আর সবচেয়ে বিপজ্জনক দিক: autoscaling এ instance বাড়লে আপনার সীমা **নিজে থেকে** বেড়ে যায়, কোনো deploy ছাড়া, কোনো alert ছাড়া। Config এ তখনো লেখা "১০০ per minute", অথচ বাস্তবে ৬০০ - আর কেউ টের পায় না যতক্ষণ downstream না পড়ে।

**Distributed Rate Limiting** - গোনাটা প্রতিটা instance এর নিজের memory তে না রেখে সবার ভাগ করা একটা store এ (সাধারণত Redis) রাখা, যাতে সীমা instance সংখ্যার উপর নির্ভর না করে।

এর দাম তিনটা, আর আমি সৎভাবে বলছি কোনটা মেপেছি আর কোনটা না:

- **প্রতি request এ একটা extra network call** - exercise এ ৬০টা request এ ৬০টা store call, গোনা। কিন্তু তার latency এর দাম এখানে **মাপা যায়নি** (p99 ০.৭–২.১ ms এ দোলে, store টা একই process এ আর RTT মাত্র ১ ms এর ভান)। আসল Redis এ, বিশেষত অন্য AZ তে, এটা প্রতিটা request এ যোগ হয়।
- **Atomicity** - "পড়ুন, তারপর বাড়ান" দুটো আলাদা call হলে দুটো instance একই সময়ে একই পুরনো মান পড়ে দুজনেই অনুমতি দিতে পারে। Redis এ এর উত্তর `INCR` (নিজেই atomic) বা একটা Lua script (পুরো সিদ্ধান্তটা এক ধাপে)। Exercise এ এটা নকল করা হয়নি - এক process, তাই race নেই; আসল distributed limiter এ এটাই সবচেয়ে সূক্ষ্ম অংশ।
- **Store এখন একটা hard dependency** - Redis মরলে কী হবে? **Fail open** (ঢুকতে দিন, সীমা নেই) নাকি **fail closed** (সবাইকে 429)? দুটোই খারাপ, আর উত্তরটা endpoint ভেদে আলাদা: board পড়ার endpoint এ fail open (rate limit না থাকা একটা সাময়িক ঝুঁকি, কিন্তু site চালু থাকে), আর login এ fail closed (সীমা ছাড়া brute force চলবে, ওটা নেওয়া যায় না)। এটা 9.4 এর "breaker খুললে error না fallback" এর হুবহু একই আকারের সিদ্ধান্ত - এবং একই রকম ভাবে **ব্যবসার সিদ্ধান্ত, যন্ত্রের না**।

আর এখানেই আজকের spaced repetition ফিরে আসে: limiter এর key গুলো যদি cache এর সেই একই Redis এ থাকে যার `maxmemory-policy` `allkeys-lru` (Lesson 4.3), তাহলে memory চাপে **limiter এর গোনাগুলো evict হয়ে যেতে পারে** - আর evict হওয়া গোনা মানে সীমা নিঃশব্দে উঠে যাওয়া। প্রতিকার: limiter এর জন্য আলাদা Redis (বা আলাদা database/namespace), আর policy `volatile-lru` হলেও সতর্কতা - কারণ limiter এর key গুলোর TTL থাকে, তাই তারাই evict হওয়ার যোগ্য তালিকায় পড়ে।

### ১.৭ 429 এর উত্তরটা কেমন হওয়া উচিত

সীমা প্রয়োগ করা অর্ধেক কাজ; client কে সঠিকভাবে জানানো বাকি অর্ধেক। Lesson 2.5 এর error contract এর ধারাবাহিকতা:

```
   attempt 1: status 200 · x-ratelimit-remaining: 1
   attempt 2: status 200 · x-ratelimit-remaining: 0
   attempt 3: status 429 · x-ratelimit-remaining: 0 · retry-after: 1s
```

- **429, 503 না** - 429 বলে "আপনি বেশি চাইছেন", 503 বলে "আমি ভেঙে পড়েছি"। Client এর আচরণ আলাদা হওয়া উচিত।
- **`Retry-After`** - এটা না দিলে ভালো client ও অন্ধভাবে retry করবে, আর ঠিক সেটাই retry storm (7.4)। সংখ্যাটা limiter নিজেই জানে (exercise এর `retryAfterMs`), তাই না দেওয়ার কোনো কারণ নেই।
- **`X-RateLimit-Limit` / `-Remaining`** - client যেন সীমার কাছে পৌঁছানোর **আগেই** নিজেকে ধীর করতে পারে। এটা থাকলে ঘটনা ১ এর ওই integration হয়তো নিজেই থামত।
- **কোন key ধরে সীমা** - user id (logged in), API key (integration), IP (anonymous আর login)। ঘটনা ২ এর brute force এ IP + email দুটো ধরেই আলাদা সীমা লাগে, কারণ একটা IP অনেক email এ চেষ্টা করছিল।

একটা সূক্ষ্মতা যা প্রায়ই ভুল হয়: 429 এর উত্তর **সস্তা** হতে হবে। যদি limiter এর decision এর পরেও আপনি database ছুঁয়ে থাকেন (যেমন user টা বৈধ কিনা দেখতে), তাহলে আক্রমণকারী আপনাকে ঠিক সেই কাজটাই করাচ্ছে যেটা আপনি আটকাতে চেয়েছিলেন। Middleware সবার আগে বসবে - exercise এর `app.use(middleware)` route গুলোর আগে, আর আসল system এ আরও আগে, gateway তেই (9.2)।

### ১.৮ TaskFlow এর সিদ্ধান্ত

**কোথায়:** দুই স্তরে। Gateway এ (9.2) একটা মোটা সীমা প্রতি API key আর প্রতি IP - সস্তা, আর এটাই ঘটনা ১ আর ২ থামায় সব service এর আগেই। তারপর প্রতিটা service এ নিজের সূক্ষ্ম সীমা দামি endpoint গুলোর জন্য (search, export, invoice)।

**কোন algorithm:** সাধারণ API এর সীমায় **token bucket** - client bursty (board খুললে ৮টা call), আর অপেক্ষা করানোর চেয়ে দ্রুত 429 ভালো। Capacity একটা স্বাভাবিক page load এর দ্বিগুণ (২০), refill হার প্রতি user এ ১০/s। Fixed window ব্যবহার করছি **না** - ১.২ এর ২ গুণ এর কারণে; sliding log শুধু সেখানে যেখানে সীমা ছোট আর কাজটা দামি: password reset (ঘণ্টায় ৫), invite email (ঘণ্টায় ২০), export (দিনে ৩)।

**Login:** IP ধরে sliding log (ঘণ্টায় ২০ চেষ্টা) **আর** email ধরে আলাদা গোনা (ঘণ্টায় ১০) - দুটোর যেটা আগে শেষ হয়। এখানে নির্ভুলতা দরকার আর সংখ্যা ছোট, তাই log এর দাম নগণ্য।

**নিজেদের script (ঘটনা ৩):** এটা rate limit এর প্রশ্নই না - migration script কে **leaky bucket** দিয়ে নিজের গতি বাঁধতে হবে (client-side throttle), billing কে সমান গতিতে ডাকতে হবে। আসল নিয়মটা সাধারণ: **নিজেদের batch কাজ কখনো user এর পথে সীমা ছাড়া ঢুকবে না।**

**Store:** limiter এর জন্য **আলাদা Redis instance**, cache এর সাথে ভাগ করা না - ১.৬ এর eviction এর কারণে। সিদ্ধান্তটা এক ধাপে একটা Lua script এ (atomicity)। Redis মরলে: board আর task পড়ায় fail open, কিন্তু login, export আর invoice এ fail closed। প্রতিটা সিদ্ধান্ত runbook এ লেখা থাকবে, code এ না লুকিয়ে।

**Dashboard এ তিনটা সংখ্যা:** 429 এর হার (endpoint ধরে), সীমার কাছে পৌঁছানো user এর সংখ্যা (৮০% ছাড়িয়েছে যারা - সীমা খুব কম হলে এটা আগে দেখা যাবে), আর limiter এর store এর p99। প্রথম দুটো ছাড়া আপনি জানতে পারবেন না সীমাটা user দের কষ্ট দিচ্ছে নাকি রক্ষা করছে।

---

## ২. Interview Angle

**"Rate limiter design করুন"** - এটা এত পরিচিত প্রশ্ন যে Module 11 এ এর জন্য আলাদা একটা case study আছে (11.2)। কাঠামোটা: আগে **কী ধরে** সীমা (user / API key / IP - আর কেন একাধিক স্তর), তারপর **algorithm** (token bucket কেন default, fixed window এর ২ গুণ এর সমস্যা, sliding log কোথায়), তারপর **কোথায় গোনা** (এটাই আসল প্রশ্ন - in-memory মানে সীমা × instance সংখ্যা, তাই Redis; atomicity এর জন্য Lua), তারপর **ব্যর্থতা** (Redis মরলে fail open না closed, endpoint ভেদে আলাদা), আর শেষে **contract** (429, `Retry-After`, `X-RateLimit-*`)।

**"Fixed window এর সমস্যা কী?"** - সংখ্যা দিয়ে বলুন: সীমা ১০/সেকেন্ড, কিন্তু জানালার সংযোগস্থলে ২৪ ms এ ২০টা - ২ গুণ। আর ভালো client `Retry-After` মেনে অপেক্ষা করলে burst টা নিয়ম হয়ে যায়। বোনাস, যেটা প্রায় কেউ বলে না: sliding window **counter** ও approximation - মাপার পদ্ধতি বদলালে ১.৯x পর্যন্ত যায়।

**"Token bucket আর leaky bucket এর পার্থক্য?"** - দুর্বল উত্তর: "একটা token জমায়, আরেকটা leak করে"। ভালো উত্তর আকার দিয়ে: গড় হার সমান, কিন্তু downstream এ শীর্ষ চাপ ১১ বনাম ৩; token bucket কাউকে অপেক্ষা করায় না (429), leaky bucket অপেক্ষা করায় (latency)। তাই API এর সামনে token, ভঙ্গুর downstream এর সামনে leaky।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনাগুলো - `express-rate-limit` default in-memory store নিয়ে production এ যাওয়া, তারপর autoscaling এ সীমা নিজে থেকে বেড়ে যাওয়া; `Retry-After` না দেওয়ায় client দের সমবেত retry storm; limiter এর key cache এর Redis এ রেখে eviction এ সীমা উবে যাওয়া; proxy এর পেছনে `req.ip` ব্যবহার করায় সব user এর জন্য একই IP (load balancer এর IP) - ফলে পুরো traffic একটা bucket এ; সীমা IP ধরে হওয়ায় একটা office বা NAT এর পেছনের সব user একসাথে আটকে যাওয়া; আর নিজেদের batch job কে সীমার বাইরে রাখায় নিজের service নিজেরাই ফেলে দেওয়া।

---

## ৩. Key Takeaway

- Rate limiting আর bulkhead (9.4) একই সমস্যার দুই দিক - bulkhead **নিজের সম্পদ ভাগ করে**, rate limit **চাহিদা সীমিত করে**; bulkhead ন্যায্যতা দেয় না, সেটা পরিচয় ধরে গোনা ছাড়া হয় না
- **Fixed window সীমানায় ২ গুণ ঢুকতে দেয়** - মাপা: সীমা ১০/s, অথচ ২৪ ms এ ২০টা; আর ভালো client `Retry-After` মেনে চললে burst টা ব্যতিক্রম না, নিয়ম
- **Sliding log নির্ভুল (১.০x) কিন্তু memory প্রতি user এ limit এর সমান** - ~২৫৩ bytes/user, ১০ লাখ user এ ~২৫৩ MB; জায়গা: ছোট সীমা, দামি কাজ
- **Sliding counter একটা approximation** - এক মাপে ১.১x, সব phase ধরে **১.৯x**; আর বড় শিক্ষা: protection কে একটা মাপ দিয়ে বিচার করা যায় না, প্রশ্ন সবসময় "সবচেয়ে খারাপ ক্ষেত্রে কী"
- **Token বনাম leaky - প্রশ্নটা "কত" না, "কত একসাথে"** - গড় হার সমান, downstream এ শীর্ষ চাপ ১১ বনাম ৩; token 429 দেয়, leaky অপেক্ষা করায়
- **Capacity = আপনি যত বড় burst downstream এ যেতে দিতে রাজি** - আক্ষরিক (capacity ১০ → burst এ ঠিক ১০); মেঝেটা আসে স্বাভাবিক client এর আচরণ থেকে
- **আসল সীমা = লেখা সীমা × instance সংখ্যা** - মাপা ৩.০x; আর autoscaling এ এটা নিজে থেকে বাড়ে, deploy ছাড়া, alert ছাড়া
- ভাগ করা store এর দাম: প্রতি request এ একটা call, **atomicity** (Redis এ Lua), আর store মরলে **fail open না fail closed** - endpoint ভেদে আলাদা, আর এটা ব্যবসার সিদ্ধান্ত
- Limiter এর key cache এর Redis এ রাখলে `allkeys-lru` (4.3) সেগুলো **evict** করে দিতে পারে - সীমা নিঃশব্দে উঠে যায়
- 429 এর উত্তর সস্তা হতে হবে আর `Retry-After` + `X-RateLimit-*` থাকতে হবে - নইলে আপনি নিজেই retry storm বানাচ্ছেন

---

## ৪. নতুন Term (Glossary)

| Term                          | অর্থ                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rate Limiting**             | একটা নির্দিষ্ট পরিচয়ের (user, API key, IP, tenant) জন্য একটা সময়ে কতগুলো request গ্রহণ করা হবে তার সীমা ঠিক করা, আর সীমা ছাড়ালে বাকিগুলো ফিরিয়ে দেওয়া (সাধারণত HTTP 429)            |
| **Fixed Window Counter**      | সময়কে ঘড়ি-ধরা জানালায় ভাগ করে প্রতিটা key এর চলতি জানালার গোনা রাখা; সহজ আর সস্তা, কিন্তু দুই জানালার সংযোগস্থলে দুটো পূর্ণ কোটা পাশাপাশি বসায় (সীমার ২ গুণ)                         |
| **Sliding Window Log**        | প্রতিটা key এর অনুমোদিত প্রতিটা request এর timestamp জমা রাখা, জানালার বাইরেরগুলো ছেঁটে গোনা; সংজ্ঞা অনুযায়ী নির্ভুল, কিন্তু memory আর কাজ প্রতি user এ limit এর সমান                   |
| **Sliding Window Counter**    | চলতি আর ঠিক আগের জানালার গোনা দিয়ে একটা ভারিত অনুমান (`আগের × (1 − যতটা এগিয়েছি) + চলতি`); fixed window এর মতোই সস্তা, কিন্তু approximation - সবচেয়ে খারাপ ক্ষেত্রে ~২ গুণ পর্যন্ত    |
| **Token Bucket**              | নির্দিষ্ট হারে token জমে, capacity পর্যন্ত থাকে; প্রতি request এ একটা token খরচ, না থাকলে 429 - জমানো token দিয়ে ঠিক capacity সমান একটা burst পাশ করে, কেউ অপেক্ষা করে না               |
| **Leaky Bucket**              | নির্দিষ্ট আকারের সারিতে request জমে আর নির্দিষ্ট হারে বেরোয়; সারি ভরা থাকলে প্রত্যাখ্যান, আর গৃহীত request অপেক্ষা করে - downstream সমান গতিতে চাপ পায়, বিনিময়ে latency বাড়ে         |
| **Distributed Rate Limiting** | গোনাটা প্রতিটা instance এর নিজের memory তে না রেখে ভাগ করা store এ (সাধারণত Redis) রাখা, যাতে আসল সীমা instance সংখ্যার উপর নির্ভর না করে; দাম - extra call, atomicity, আর নতুন নির্ভরতা |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর public API তে সীমা "১০০০ request per hour per API key"। (ক) Fixed window এ একজন client সবচেয়ে বেশি কত request একটা ঘণ্টায় (যেকোনো ৬০ মিনিটের জানালায়) পাঠাতে পারবে, আর কত কম সময়ে? (খ) এই সীমার জন্য sliding log এর memory হিসাব করুন - ৫০,০০০ API key ধরে (exercise এর bytes/user থেকে অনুপাত ধরে)। এটা কি চলবে? (গ) আপনি কোন algorithm বাছবেন, আর "ঘণ্টায় ১০০০" কে কীভাবে ভাঙবেন যাতে একজন client পুরো কোটা এক মিনিটে শেষ করতে না পারে?

2. TaskFlow এর limiter এখন Redis এ, `INCR` + `EXPIRE` দিয়ে fixed window। (ক) `INCR` করার পরে `EXPIRE` করার আগে process টা মরে গেলে কী হয়, আর তার ফল কতদিন থাকবে? কীভাবে ঠিক করবেন? (খ) দুটো instance একই সময়ে একই key তে কাজ করলে "পড়ুন, তুলনা করুন, বাড়ান" কেন নিরাপদ না - আর `INCR` কীভাবে এটা এড়ায়? Token bucket এ (যেখানে ভাসমান সংখ্যা আর সময় লাগে) `INCR` যথেষ্ট না কেন? (গ) Redis টা ৩০ সেকেন্ড বন্ধ ছিল। আপনার fail open / fail closed এর সিদ্ধান্ত `/api/tasks` (পড়া), `/api/login`, আর `/api/export` - তিনটার জন্য আলাদা করে লিখুন, প্রতিটার কারণ সহ।

3. একটা নতুন enterprise customer এর ৮০০ জন employee একই office এর NAT এর পেছনে - সবার public IP একটাই। আর TaskFlow এর load balancer এর পেছনে app গুলো `req.ip` ব্যবহার করে। (ক) দুটো আলাদা bug এখানে আছে - আলাদা করে বলুন, আর প্রতিটার লক্ষণ user এর চোখে কেমন দেখাবে। (খ) প্রতিটার সমাধান কী? (গ) ঠিক করার পরেও ওই ৮০০ জন যদি একই IP তে থাকে, আপনি কীভাবে সীমা দেবেন - কোন key, আর anonymous (login এর আগের) request গুলোর জন্য কী করবেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) Fixed window এ জানালা এক ঘণ্টা। সবচেয়ে খারাপ ক্ষেত্রে client প্রথম ঘণ্টার শেষ মুহূর্তে ১০০০ আর পরের ঘণ্টার প্রথম মুহূর্তে ১০০০ - **২০০০ request**, আর সময়টা কয়েক সেকেন্ডের মধ্যেই সম্ভব (exercise এ সীমা ১০ এ ২৪ ms; এখানে ২০০০টা request পাঠাতে যতটা সময় লাগে, ততটাই)। অনুপাতটা একই - **২ গুণ** - কিন্তু পরিমাণটা ভয়ংকর বেশি, কারণ জানালা বড়। এটাই বড় জানালার বিপদ: অনুপাত বদলায় না, burst এর আকার বদলায়।

(খ) Exercise এ সীমা ১০ এ sliding log ~২৫৩ bytes/user, যার মধ্যে ~১০৯ bytes মোটামুটি স্থির অংশ (Map এর entry, key এর string) আর বাকি ~১৪৪ bytes ১০টা timestamp আর array এর overhead - মানে প্রতি timestamp এ ~১৪ bytes। সীমা ১০০০ এ তাই মোটামুটি `109 + 1000 × 14 ≈ 14 KB` per key। ৫০,০০০ key এ **~৭০০ MB**। চলবে না - অন্তত rate limiter এর জন্য এটা অসম্ভব রকম দামি, আর সংখ্যাটা client সংখ্যার সাথে সরাসরি বাড়ে। (হিসাবটা exercise এর মাপা অনুপাত থেকে অনুমান; experiment ২ এ `LIMIT=1000` দিয়ে সত্যিকারের সংখ্যাটা মেপে দেখুন।)

(গ) **Token bucket**, আর "ঘণ্টায় ১০০০" কে দুই স্তরে ভাঙা: refill হার `1000/3600 ≈ 0.28` token/s, আর capacity ছোট (যেমন ৫০)। তাহলে দীর্ঘমেয়াদে ঘণ্টায় ১০০০ ই থাকে, কিন্তু একসাথে সর্বোচ্চ ৫০টা যেতে পারে - পুরো কোটা এক মিনিটে শেষ করা অসম্ভব। এটাই token bucket এর সবচেয়ে সুন্দর দিক: **দীর্ঘমেয়াদি হার আর তাৎক্ষণিক burst দুটো আলাদা করে ঠিক করা যায়**, যেটা window-ভিত্তিক algorithm এ একটাই সংখ্যা দিয়ে করতে হয়। চাইলে আরও একটা স্তর (per-minute সীমা) যোগ করা যায়, কিন্তু capacity দিয়েই কাজটা হয়ে যায়।

**প্রশ্ন ২:**

(ক) `INCR` একটা নতুন key বানায় **TTL ছাড়া** (Redis এ নতুন key এর default কোনো মেয়াদ নেই)। `EXPIRE` এর আগে মরে গেলে সেই key **চিরকাল** থাকে - আর তার মান কখনো শূন্য হয় না, মানে ওই user চিরদিনের জন্য সীমাবদ্ধ (বা জানালা কখনো reset হয় না)। ঠিক করার উপায়: দুটো command কে একটা করা - `SET key 0 EX 60 NX` তারপর `INCR`, কিংবা সবচেয়ে ভালো, পুরো সিদ্ধান্তটা একটা **Lua script** এ (Redis এ Lua script atomically চলে)। আধুনিক Redis এ `INCR` এর পরে শুধু নতুন key হলে `EXPIRE` - সেটাও Lua তে একসাথে।

(খ) "পড়ুন, তুলনা করুন, বাড়ান" তিনটা আলাদা ধাপ - দুটো instance একই সময়ে পুরনো মান (ধরুন ৯) পড়ে, দুজনেই দেখে ৯ < ১০, দুজনেই অনুমতি দেয়, দুজনেই লেখে ১০। ফল: সীমা ১০ হলেও ১১টা পাশ করল। এটা Lesson 5.5 এর lost update এর হুবহু একই আকার, এবার Redis এ। `INCR` এই সমস্যাটা এড়ায় কারণ Redis single-threaded ভাবে একটা command পুরোটা চালায় - পড়া আর বাড়ানো অবিভাজ্য, আর সে বাড়ানোর পরের মানটা ফেরত দেয়, তাই সিদ্ধান্ত নিতে আলাদা পড়ার দরকার নেই।

Token bucket এ `INCR` যথেষ্ট না কারণ সেখানে state একটা সংখ্যা না - অন্তত দুটো (`tokens` আর `last`), আর হিসাবটা সময়-নির্ভর ভাসমান গণিত (`gained = (now − last) × rate`)। এটা একটা atomic integer operation এ বসে না। তাই token bucket distributed ভাবে করতে হলে একটা Lua script লাগে যা দুটো field পড়ে, সময় দিয়ে হিসাব করে, সিদ্ধান্ত নেয় আর লেখে - সব এক ধাপে। (এটাই কারণ যে অনেক library distributed mode এ fixed window বা sliding counter এ নেমে আসে - সেগুলো `INCR` এ বসে যায়।)

(গ) তিনটা আলাদা:

- `/api/tasks` (পড়া) - **fail open**। সীমা ছাড়া কিছু বাড়তি পড়া হবে, সেটা সহনীয় ঝুঁকি; কিন্তু fail closed মানে Redis এর ৩০ সেকেন্ডের সমস্যা পুরো product এর ৩০ সেকেন্ডের outage হয়ে যাওয়া। এখানে 9.4 এর যুক্তিটাই: একটা সহায়ক নির্ভরতা মূল কাজকে ফেলে দেবে না।
- `/api/login` - **fail closed** (বা অন্তত একটা কঠোর in-memory fallback সীমা)। সীমা ছাড়া login মানে brute force এর দরজা খোলা, আর সেটা ৩০ সেকেন্ডেও অনেক ক্ষতি করতে পারে। এখানে ৩০ সেকেন্ড login না থাকা, নিরাপত্তার ঝুঁকির চেয়ে কম খারাপ।
- `/api/export` - **fail closed**। Export দামি (CPU, memory, object storage - Module 8)। সীমা ছাড়া export মানে কয়েকজন মিলে পুরো service ফেলে দিতে পারে। আর export সাধারণত সাথে সাথে দরকার হয় না, তাই ৩০ সেকেন্ড না পাওয়া গ্রহণযোগ্য।

সাধারণ নিয়ম: **যে endpoint এ সীমা না থাকার ঝুঁকি সীমা থাকার অসুবিধার চেয়ে বেশি, সেখানে fail closed।**

**প্রশ্ন ৩:**

(ক) দুটো bug:

1. **`req.ip` load balancer এর IP দেখাচ্ছে।** App এর সামনে proxy থাকলে TCP connection টা proxy থেকে আসে, তাই `req.ip` সব user এর জন্য একই (LB এর IP)। ফলে **পুরো traffic একটা bucket এ** - সীমা কয়েক সেকেন্ডেই শেষ, আর তারপর সবাই 429। User এর চোখে: "কিছুই কাজ করছে না, সবাই মিলে", আর অদ্ভুতভাবে সকালের ব্যস্ত সময়ে বেশি।
2. **NAT এর পেছনে ৮০০ জন একই public IP তে।** এটা ঠিক করার পরেও থেকে যায়: এখন সীমাটা সত্যিকারের client IP ধরে হচ্ছে, কিন্তু ওই office এর ৮০০ জনের IP একটাই। User এর চোখে: "আমাদের office এ TaskFlow ধীর/429, বাসা থেকে ঠিক" - support এ সবচেয়ে কঠিন ticket, কারণ লক্ষণটা ভৌগোলিক দেখায়।

(খ) সমাধান:

1. Express এ `app.set('trust proxy', …)` ঠিকভাবে সেট করা (কতগুলো proxy hop বিশ্বাস করবেন - সংখ্যা দিয়ে, `true` দিয়ে না), যাতে `req.ip` `X-Forwarded-For` এর সঠিক অংশ পড়ে। গুরুত্বপূর্ণ: অন্ধভাবে `trust proxy = true` করলে client নিজেই `X-Forwarded-For` পাঠিয়ে যেকোনো IP দাবি করতে পারে - অর্থাৎ সীমা এড়ানোর সহজ পথ। তাই শুধু নিজের LB এর hop গুলো বিশ্বাস করবেন। আরও ভালো হলো LB এর নিজের নির্ভরযোগ্য header ব্যবহার করা (9.2 এর gateway এর signed header এর মতোই যুক্তি - client এর দাবি বিশ্বাস করা যায় না)।
2. NAT এর সমস্যাটা IP দিয়ে সমাধানযোগ্য না - **পরিচয় বদলাতে হবে**।

(গ) Key এর স্তর তিনটা, আর যতটা সম্ভব নির্দিষ্ট পরিচয় ব্যবহার করুন:

- **Logged-in request:** key = user id (বা enterprise এর ক্ষেত্রে user id, সাথে workspace/tenant ধরে একটা আলাদা বড় সীমা)। তাহলে ওই ৮০০ জনের প্রত্যেকে নিজের কোটা পায়, আর office এর NAT অপ্রাসঙ্গিক হয়ে যায়। Tenant ধরে সীমাটাও দরকার - নইলে একটা customer এর ৮০০ জন মিলে বাকি সবার সম্পদ খেয়ে ফেলতে পারে (এটাই ১.১ এর ন্যায্যতার প্রশ্ন, এবার tenant স্তরে)।
- **Integration:** key = API key। IP অপ্রাসঙ্গিক।
- **Anonymous (login এর আগে):** এখানে user id নেই, তাই IP ছাড়া উপায় কম - কিন্তু সীমাটা **উদার** রাখুন (NAT এর কথা ভেবে), আর login এর নিরাপত্তা শুধু IP এর সীমার উপর ছাড়বেন না: email ধরে আলাদা গোনা (প্রশ্ন ১.৮ এর মতো), ব্যর্থ চেষ্টার পরে ক্রমবর্ধমান দেরি, আর কয়েকবার ব্যর্থ হলে CAPTCHA বা দ্বিতীয় ধাপ। অর্থাৎ anonymous পথে rate limit একটা স্তর, একমাত্র প্রতিরক্ষা না - যেটা ১.১ এর "rate limit ন্যায্যতার যন্ত্র, নিরাপত্তার একমাত্র যন্ত্র না" এর ব্যবহারিক রূপ।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (Express middleware + আসল HTTP; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-9.5-rate-limiting/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.5-rate-limiting) - `npm install`, তারপর `npm run window`, `npm run bucket`, `npm run distributed`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`window` তিনটা window algorithm কে একই পরীক্ষায় ফেলে - জানালার সীমানায় সাজানো একটা burst, তারপর **সব সম্ভাব্য শুরুর সময়** ধরে সবচেয়ে খারাপ ক্ষেত্রে একজন user কত পাঠাতে পারে, আর শেষে ৫০,০০০ user এ প্রতি user এ কত memory (`--expose-gc` দিয়ে আগে-পরে heap মেপে)। `bucket` একই আগমন (t=0 এ ৩০টার burst, তারপর ৫/s) token bucket আর একটা queue-ভিত্তিক leaky bucket এ চালিয়ে **বেরোনোর আকার** পাশাপাশি আঁকে, আর capacity ১ / ৫ / ১০ / ৫০ এ burst সহনশীলতা বনাম downstream এর শীর্ষ চাপ দেখায়। `distributed` তিনটা আসল Express instance চালায় একই middleware নিয়ে - একবার প্রত্যেকের নিজের গোনা, একবার ভাগ করা store - আর শেষে 429 এর আসল উত্তরটা (`retry-after`, `x-ratelimit-*`) ছাপে।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` আর ESLint clean; তিনটা script **তিনবার করে** - **সব গোনা প্রতি run এ হুবহু এক** (২০, ১০, ১৯, ১১, ৩, ৩০, ১০, ৬০), memory তে fixed window ১০৮–১০৯ bytes/user (বাকি দুটো অপরিবর্তিত), আর `distributed` এর p99 ০.৭–২.১ ms এ দোলে। প্রথম দুটো script এ **সময়টা virtual** - `check(key, now)` কে হাতে গোনা `now` দেওয়া হয়, তাই ফল সম্পূর্ণ deterministic, machine ভেদেও একই; এটা ইচ্ছাকৃত, যাতে algorithm এর পার্থক্যে scheduler এর noise না ঢোকে। তৃতীয় script এ Express, HTTP, middleware, 429 আর header সব আসল। **"ভাগ করা store" Redis না** - একই process এর একটা object, সামনে `await sleep(1)` দিয়ে RTT এর ভান; তাই ওই RTT এর latency এর দাম এখানে **মাপা যায়নি** (p99 এর পার্থক্য noise এর সমান), আর Redis এর atomicity (`INCR`, Lua) ও নকল করা হয়নি - এক process, তাই race নেই; ১.৬ এ সেটা আলোচিত, চালানো না। Memory এর সংখ্যা `heapUsed` এর পার্থক্য - একটা অনুমান, hand-counted byte না; তুলনাটাই আসল, পরম সংখ্যাটা না। Leaky bucket এখানে queue হিসেবে; "meter" রূপটা দেখানো হয়নি। **যা মাপা হয়নি:** limiter মরলে fail open বনাম fail closed, একই user এর সমসাময়িক request এ race, key এর TTL আর eviction, IP বনাম user বনাম API key, আর সীমার একাধিক স্তর - ১.৬–১.৮ আর Answer Key তে এগুলো আলোচিত। ১.৮ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না। Cloudflare এর sliding counter ব্যবহারের কথাটা তাদের প্রকাশিত লেখা থেকে - সংক্ষেপ।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `window` চালানোর **আগে** লিখে ফেলুন - সীমা ১০/সেকেন্ড, fixed window। জানালার সীমানায় সবচেয়ে বেশি কত পাশ করতে পারে, আর কত সময়ে? তারপর একই প্রশ্ন sliding window **counter** এর জন্য - আপনার অনুমান ১.১x না ১.৯x? দুটো টেবিল মিলিয়ে দেখুন, আর যেটা অবাক করল সেটার কারণ এক লাইনে লিখুন।

2. **Memory এর দেয়াল:** experiment ২ - `LIMIT=1000 USERS=20000 npm run window`. তিনটার bytes/user কত হলো? Answer Key এর প্রশ্ন ১(খ) এ আমি অনুপাত থেকে ~১৪ KB/key অনুমান করেছিলাম - মাপা সংখ্যাটা কত, আর আমার অনুমান কতটা ভুল ছিল? ১০ লাখ client এ প্রতিটা algorithm এর জন্য কত RAM?

3. **Capacity আর user এর অভিজ্ঞতা:** experiment ৩ - `CAPACITY=1 npm run bucket`, তারপর `CAPACITY=100`. "চাপ/250ms" কলামটা লিখে রাখুন। এবার TaskFlow এর board খোলার কথা ভাবুন (browser একসাথে ৮টা call): capacity ১, ৫, ২০ - প্রতিটায় user কী দেখবে? আপনি কোনটা বাছবেন, আর সেই সংখ্যাটা কোথা থেকে পেলে?

4. **সীমা কীভাবে নিজে থেকে বাড়ে:** experiment ৪ - `distributed.ts` এর `PORTS` এ দুটো port যোগ করে ৫টা instance করুন। "আসল সীমা" কলামটা কী হলো? এবার হিসাব করুন: TaskFlow এর instance যদি রাতে ২ আর দিনে ২০ হয়, আপনার "১০০ per minute" আসলে কত থেকে কত হয়? কোন একটা metric dashboard এ থাকলে আপনি এটা ধরতে পারতে?

5. **Design অংশ:** TaskFlow এর rate limiting এর এক পাতার design: (ক) একটা টেবিল - endpoint শ্রেণি (পড়া, লেখা, login, export, invite, public API), প্রতিটার জন্য key (user / API key / IP / tenant), algorithm, সীমা আর capacity; (খ) কোথায় প্রয়োগ হবে (gateway না service) আর কেন; (গ) প্রতিটা শ্রেণির জন্য Redis মরলে fail open না closed, কারণ সহ; (ঘ) limiter এর Redis cache এর থেকে আলাদা রাখার যুক্তি, আর key এর নাম আর TTL এর নিয়ম; (ঙ) dashboard এর তিনটা সংখ্যা, আর প্রতিটার জন্য কোন মানে আপনি alert দেবেন; (চ) নিজেদের batch job গুলো (migration, reconcile, reindex) কীভাবে নিজের গতি বাঁধবে - কোন algorithm, আর কোন সংখ্যা।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8 (সম্পূর্ণ, exit challenge সহ), 9.1, 9.2, 9.3, 9.4
Current: 9.5 - Rate limiting algorithms (Token Bucket, Sliding Window - Express middleware)
TaskFlow state: modular monolith (work, identity, files, search) + files processing + billing service;
gateway + web/mobile BFF (9.2); "task তৈরি" = orchestrated saga (9.3); billing এর discovery =
Kubernetes Service + readiness probe, breaker per dependency+endpoint, bulkhead 12/4 (9.4);
rate limit দুই স্তরে - gateway এ মোটা সীমা (API key + IP), service এ সূক্ষ্ম সীমা দামি endpoint এ;
সাধারণ API = token bucket (capacity 20 = স্বাভাবিক page load এর দ্বিগুণ, refill 10/s per user),
fixed window ব্যবহার করা হচ্ছে না (সীমানায় 2 গুণ); sliding log শুধু ছোট-সীমা দামি কাজে (password
reset ঘণ্টায় 5, invite 20, export দিনে 3); login = IP ধরে ঘণ্টায় 20 + email ধরে 10, যেটা আগে শেষ;
limiter এর জন্য আলাদা Redis (cache এর allkeys-lru এ evict হয়ে যেত), সিদ্ধান্ত এক Lua script এ;
Redis মরলে: পড়ায় fail open, login/export/invoice এ fail closed - runbook এ লেখা; নিজেদের batch job
(migration, reconcile) client-side leaky bucket দিয়ে গতি বাঁধে; dashboard: 429 এর হার per endpoint,
সীমার 80% ছাড়ানো user, limiter store এর p99
Terms learned (Module 9): Monolith / Microservices, Database per Service, Conway's Law, Modular
Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall, Over-fetching,
Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication, Service Mesh (mTLS),
Two-Phase Commit (2PC), In-doubt Transaction, Saga, Compensating Transaction, Pivot Transaction,
Orchestration / Choreography, Semantic Lock, Service Discovery, Service Registry, Client-side /
Server-side Discovery, Circuit Breaker, Half-Open Probe, Bulkhead, Fail Fast, Rate Limiting, Fixed
Window Counter, Sliding Window Log, Sliding Window Counter, Token Bucket, Leaky Bucket, Distributed
Rate Limiting
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: Module 9 Exit Challenge
=======================
```

---

## ৮. পরের Lesson

Module 9 এর পাঁচটা lesson শেষ। একটা সুতো শুরু থেকে শেষ পর্যন্ত টানা ছিল: **9.1** এ আমরা একটা monolith ভাঙার তিনটা দাম মেপেছি আর সিদ্ধান্ত নিয়েছি সাবধানে ভাঙব; **9.2** এ ভাঙা service গুলোর সামনে gateway আর BFF বসিয়েছি; **9.3** এ সীমানা পার হওয়া transaction কে saga দিয়ে সামলেছি; **9.4** এ সেই saga এর একটা call এর চারপাশে discovery, breaker আর bulkhead বসিয়েছি; আর **9.5** এ ঠিক করেছি কে কতটা চাইতে পারে। প্রতিটা ধাপে একই প্যাটার্ন ফিরে এসেছে - **একটা সুবিধার জন্য একটা নতুন ব্যর্থতার পথ খুলেছে, আর সেটা সামলাতে একটা নতুন যন্ত্র লেগেছে**। Microservices এর আসল দাম এটাই: code এর গঠন না, এই যন্ত্রগুলোর সংখ্যা আর তাদের tuning।

রেডি হলে `next` লিখুন - **Module 9 Exit Challenge** এ যাব: একটা incident review, যেখানে এই পাঁচটা lesson এর সিদ্ধান্তগুলো একসাথে, আর কয়েকটা জায়গায় ইচ্ছে করে ভুলভাবে বসানো। Module 5–8 এর পুরনো প্রশ্নগুলোও (dual write, eventual consistency, idempotency, replica lag) নতুন চেহারায় ফিরবে - কারণ বাস্তবে সেগুলো কখনো চলে যায় না, শুধু service এর সীমানা পার হয়ে আরও কঠিন হয়।
