# Lesson 4.5 — CDN কীভাবে কাজ করে: Edge, Cache Key, আর Purge

**Module 4 — Caching**

> **Spaced Repetition (Lesson 1.4):** HTTP keep-alive জিনিসটা কী সমস্যার সমাধান করে? প্রতিটা request এ নতুন TCP connection খুললে ঠিক কী খরচ বাড়ত?

**Prerequisite:** Lesson 4.1 (Cache Hierarchy), Lesson 1.4 (HTTP & Connection Lifecycle)

**তুমি এই lesson শেষে পারবে:**

1. একজন user এর request কীভাবে নিকটতম edge server এ পৌঁছায়, আর সেখানে cache key কী দিয়ে তৈরি হয় — ব্যাখ্যা করতে পারবে
2. `Cache-Control` এর নির্দেশগুলো (`max-age`, `s-maxage`, `private`, `stale-while-revalidate`) আলাদা করে বুঝবে, আর কোনটা কাকে উদ্দেশ্য করে বলা — জানবে
3. TaskFlow এর কোন জিনিস CDN এ যাবে আর কোনটা কখনোই না — সেই সিদ্ধান্ত যুক্তি দিয়ে নিতে পারবে

**Tier:** 3 — Design Exercise

---

## ০. TaskFlow এখন কোথায়

গত lesson এ TaskFlow পেয়েছে একটা কাজ করা Redis caching layer — `/api/tasks` এখন বেশিরভাগ সময় DB পর্যন্ত যায়ই না। কিন্তু খেয়াল করো, আমরা এতক্ষণ যা করেছি সবই **origin এর ভেতরে** — request টা তোমার server পর্যন্ত এসেছে, তারপর আমরা তাকে DB তে যেতে দিইনি।

এবার একটা সম্পূর্ণ ভিন্ন প্রশ্ন: **request টাকে তোমার server পর্যন্ত আসতেই না দিলে কেমন হয়?**

TaskFlow এর ব্যবহারকারীরা ঢাকা, সিঙ্গাপুর, লন্ডন — সবখানে। তোমার origin server একটা জায়গায়। লন্ডনের একজন user এর প্রতিটা request কে যদি অর্ধেক পৃথিবী পাড়ি দিতে হয়, তাহলে Redis যত দ্রুতই হোক, **আলোর গতির সীমাটা** তুমি পার করতে পারবে না — ঢাকা থেকে লন্ডন round trip এই ~২০০ ms।

Lesson 4.1 এ CDN কে hierarchy তে এক নজরে দেখেছিলাম। আজকে ভেতরে ঢুকব।

---

## ১. Theory

### ১.১ Request টা আদৌ নিকটতম edge এ পৌঁছায় কীভাবে

সবার আগে একটা ধাঁধা: তুমি `taskflow.app` লিখলে, আর ঢাকার একজন ঢাকার edge এ পৌঁছায়, লন্ডনের একজন লন্ডনের edge এ — অথচ **domain নাম তো একটাই**। কীভাবে?

উত্তর **Anycast** — একই IP address পৃথিবীর শত শত জায়গা থেকে একসাথে ঘোষণা করা হয়। Internet এর routing (BGP) তখন প্রতিটা request কে **network হিসেবে সবচেয়ে কাছের** সেই IP এর দিকে পাঠায়।

```
        ঢাকার user  ──> 104.21.x.x ──> ঢাকা PoP
       লন্ডনের user ──> 104.21.x.x ──> লন্ডন PoP     ← একই IP, ভিন্ন গন্তব্য
     সিডনির user   ──> 104.21.x.x ──> সিডনি PoP
```

Lesson 2.1 এ DNS-ভিত্তিক routing দেখেছিলে (ভিন্ন user কে ভিন্ন IP দেওয়া)। Anycast তার চেয়ে ভালো, কারণ DNS cache এ পুরনো উত্তর আটকে থাকার সমস্যা নেই — routing decision টা প্রতিটা packet এ network নিজেই নেয়।

### ১.২ Cache Key — edge ঠিক কীসের ভিত্তিতে "একই জিনিস" বলে

Edge এ request এলে সে ভাবে: "এই জিনিসটা কি আমার কাছে আগে থেকেই আছে?" — কিন্তু "এই জিনিস" মানে কী, সেটা ঠিক করে **cache key**।

Default এ সেটা মোটামুটি:

```
cache key = scheme + host + path + query string
            https   taskflow.app  /logo.svg   (কোনো query নেই)
```

এখানেই প্রথম ফাঁদ। **Query string cache key এর অংশ** — মানে এই দুটো edge এর কাছে সম্পূর্ণ আলাদা জিনিস:

```
/logo.svg                      ← একটা entry
/logo.svg?utm_source=facebook  ← আরেকটা entry, আলাদা করে fetch হবে
```

Marketing campaign থেকে ১০ রকম `utm_*` parameter নিয়ে link এলে তোমার একই logo এর ১০টা আলাদা copy edge এ জমবে, আর প্রতিটার প্রথম hit origin পর্যন্ত যাবে। তাই CDN এ সাধারণত একটা নিয়ম দেওয়া হয় — "static asset এর ক্ষেত্রে query string উপেক্ষা করো"।

**দ্বিতীয় ফাঁদ, আর এটা বেশি বিপজ্জনক — `Vary` header।** `Vary` বলে দেয় "এই response টা কোন কোন request header এর উপর নির্ভর করে":

```
Vary: Accept-Encoding        ← যুক্তিসঙ্গত (gzip আর brotli এর আলাদা copy)
Vary: Accept-Language        ← যুক্তিসঙ্গত (ভাষা অনুযায়ী আলাদা)
Vary: Cookie                 ← কার্যত cache বন্ধ করে দেওয়া
```

শেষটা কেন সর্বনাশ? কারণ প্রতিটা user এর cookie আলাদা, মানে প্রতিটা user এর জন্য **আলাদা cache entry** — hit ratio প্রায় শূন্যে নেমে যায়, অথচ তুমি ভাবছ CDN কাজ করছে।

### ১.৩ Cache-Control — কে কাকে নির্দেশ দিচ্ছে

এই header টা নিয়ে সবচেয়ে বেশি বিভ্রান্তি হয়, কারণ **একই header এ দুইজন আলাদা শ্রোতা** — browser আর CDN।

| নির্দেশ                     | কে শোনে                     | মানে                                                    |
| --------------------------- | --------------------------- | ------------------------------------------------------- |
| `max-age=3600`              | browser **ও** CDN           | ১ ঘণ্টা তাজা ধরে নাও                                    |
| `s-maxage=86400`            | **শুধু** CDN (shared cache) | CDN এর জন্য ১ দিন — `max-age` কে override করে           |
| `public`                    | সবাই                        | shared cache ও রাখতে পারে                               |
| `private`                   | সবাই                        | **শুধু browser** রাখবে, CDN রাখবে না                    |
| `no-store`                  | সবাই                        | কেউ কোথাও রাখবে না                                      |
| `no-cache`                  | সবাই                        | রাখতে পারো, কিন্তু ব্যবহারের আগে origin এ যাচাই করে নিও |
| `stale-while-revalidate=60` | CDN                         | মেয়াদ শেষ হলেও বাসিটা দিয়ে দাও, পেছনে নতুনটা এনে নাও  |

**`no-cache` মানে "cache কোরো না" নয়** — এটা প্রায় সবাই ভুল বোঝে। ওটার মানে "cache করো, কিন্তু প্রতিবার ব্যবহারের আগে জিজ্ঞেস করে নাও"। "একদম রেখো না" বলতে চাইলে `no-store`।

এই জোড়াটা TaskFlow এ সবচেয়ে কাজের:

```
Cache-Control: public, max-age=60, s-maxage=600, stale-while-revalidate=300
```

মানে — browser ১ মিনিট, CDN ১০ মিনিট, আর CDN এর ১০ মিনিট শেষ হলেও পরের ৫ মিনিট সে **বাসি copy টা সাথে সাথে দিয়ে দেবে** আর পেছনে চুপচাপ নতুনটা এনে রাখবে।

`stale-while-revalidate` টা লক্ষ্য করো — এটাই সেই কৌশল যেটা TTL শেষ হওয়ার মুহূর্তে সবাই একসাথে origin এ ঝাঁপিয়ে পড়া আটকায়। পরের lesson (4.6) এ দেখব এই সমস্যাটার নাম **cache stampede**, আর Redis এও একই কৌশল খাটানো যায়।

### ১.৪ Conditional request — মেয়াদ শেষে পুরোটা আবার আনতে হয় না

TTL শেষ মানেই যে পুরো file আবার download করতে হবে, তা না। Edge origin কে জিজ্ঞেস করে "এটা কি বদলেছে?":

```
Edge ──> origin:  GET /logo.svg
                  If-None-Match: "abc123"
                          │
origin ──> Edge:  304 Not Modified      ← body নেই, শুধু header
                  (বা 200 + নতুন body, যদি সত্যিই বদলে থাকে)
```

`ETag` হলো content এর একটা আঙুলের ছাপ। না বদলালে origin শুধু `304` পাঠায় — **body ছাড়া**। মানে bandwidth প্রায় শূন্য, শুধু একটা round trip। ৫ MB এর একটা image এর জন্য এটা বিশাল সাশ্রয়।

### ১.৫ Purge — ৩০০+ PoP এ খবরটা পৌঁছায় কীভাবে

Lesson 4.1 এর প্রশ্ন ২ মনে আছে? User ছবি বদলালো, কিন্তু CDN এ পুরনোটা আরও কয়েক ঘণ্টা পড়ে আছে। সমাধান — **purge**, অর্থাৎ CDN কে বলা "এই জিনিসটা এখনই ভুলে যাও"।

তিন রকম:

```
১. URL purge      →  শুধু /logo.svg মুছে দাও          (নির্ভুল, দ্রুত)
২. Tag/prefix     →  "user-7" tag এর সব মুছে দাও      (একসাথে অনেক)
৩. Purge all      →  সব মুছে দাও                      (শেষ অস্ত্র — বিপজ্জনক)
```

**"Purge all" কেন বিপজ্জনক?** কারণ এক মুহূর্তে পৃথিবীর সব edge খালি হয়ে যায়, আর তারপরের প্রতিটা request **তোমার origin এ** গিয়ে পড়ে। যে origin স্বাভাবিক দিনে ৫% traffic সামলায়, সে হঠাৎ ১০০% পাচ্ছে। এটা Lesson 4.2 এর প্রশ্ন ৩ এ দেখা সেই একই বিপদ, শুধু CDN scale এ — আর এটাকেই বলে **cache avalanche**।

খবরটা ছড়ায় CDN এর নিজের internal network দিয়ে — তুমি একটা API call করো, CDN সেটা তার সব PoP এ broadcast করে। বড় provider দের ক্ষেত্রে এটা কয়েক সেকেন্ডের ব্যাপার, কিন্তু **তাৎক্ষণিক না** — তাই purge এর উপর ভরসা করে "এখনই সবাই নতুনটা দেখবে" ধরে নেওয়া ভুল।

**একটা কৌশল যেটা purge এর দরকারই মিটিয়ে দেয় — content hashing।** File এর নামেই content এর hash বসিয়ে দাও:

```
/app.js          ← বদলালে purge করতে হবে
/app.a1b2c3.js   ← বদলালে নতুন নাম, তাই purge এর প্রশ্নই নেই
```

নতুন build মানে নতুন নাম, মানে নতুন cache key। পুরনোটা TTL শেষে নিজে থেকেই মরে যাবে। এজন্যই এই file গুলোতে `max-age=31536000` (এক বছর) দেওয়া নিরাপদ। **তোমার SvelteKit build ঠিক এটাই করে** — `_app/immutable/` folder এর file গুলোর নামে hash থাকে।

### ১.৬ Origin Shield — edge আর origin এর মাঝে আরেকটা স্তর

৩০০টা PoP আছে মানে একটা জিনিসের প্রথম hit এ **৩০০ বার** origin এ যাওয়ার সম্ভাবনা — প্রতিটা PoP তো আলাদাভাবে miss করছে।

Origin Shield এই সমস্যাটা সমাধান করে একটা মধ্যবর্তী স্তর বসিয়ে:

```
[৩০০ PoP] ──> [১টা Shield PoP] ──> [তোমার origin]
                                     ← origin একবারই hit খায়
```

সব edge এর miss গুলো আগে shield এ যায়; shield নিজে একবার origin থেকে এনে বাকি সবাইকে দেয়। এটাকে **tiered caching** ও বলে।

> **Trade-off Table — TaskFlow এর কী কোথায়**

| Resource                       | CDN এ? | Cache-Control                                      | কেন                                                    |
| ------------------------------ | ------ | -------------------------------------------------- | ------------------------------------------------------ |
| `_app/immutable/*.js` (hashed) | হ্যাঁ  | `public, max-age=31536000, immutable`              | নাম বদলায়, তাই চিরকাল রাখা নিরাপদ                     |
| `/logo.svg`                    | হ্যাঁ  | `public, max-age=86400`                            | কদাচিৎ বদলায়, সবার জন্য এক                            |
| Marketing page                 | হ্যাঁ  | `public, s-maxage=600, stale-while-revalidate=300` | সবার জন্য এক, মাঝে মাঝে বদলায়                         |
| `GET /api/tasks`               | **না** | `private, no-store`                                | প্রতিটা user এর আলাদা — Lesson 4.1 এর security সতর্কতা |
| `POST /api/tasks`              | **না** | `no-store`                                         | Write কখনো cache হয় না                                |

শেষ দুটোর `no-store` টা ঐচ্ছিক ভদ্রতা না। একবার ভুল করে কারো personal task list edge এ cache হয়ে গেলে, সেটা **অন্য user কে পরিবেশন হতে পারে**। এটা performance bug না, এটা data breach।

---

## ২. Interview Angle

CDN নিয়ে প্রশ্ন প্রায় সবসময় ছদ্মবেশে আসে — **"তোমার user রা পৃথিবীজুড়ে, latency কমাবে কীভাবে?"** উত্তরে "CDN ব্যবহার করব" বলে থেমে যেয়ো না। বলো **কী কী** CDN এ যাবে (static asset, public page) আর **কী কখনোই না** (personalized API response), এবং কেন — দ্বিতীয় অংশটা বললেই তুমি দেখাচ্ছ যে তুমি ঝুঁকিটা জানো।

সবচেয়ে ধারালো follow-up: **"CDN এ একটা জিনিস cache হয়ে আছে, তুমি সেটা এখনই বদলাতে চাও — কী করবে?"** — purge এর কথা বলো, কিন্তু সাথে content hashing এর কথাও বলো, আর বলো কেন hashing টা ভালো (purge এর দরকারই থাকে না, propagation delay এর উপর নির্ভর করতে হয় না)। আর "purge all" যে origin এ avalanche ডেকে আনতে পারে, সেটা উল্লেখ করলে তুমি স্পষ্টভাবে এগিয়ে।

আরেকটা যেটা অনেককে ফেলে দেয়: **"`no-cache` আর `no-store` এর পার্থক্য কী?"** — `no-cache` মানে "রাখো, কিন্তু ব্যবহারের আগে যাচাই করো"; `no-store` মানে "কোথাও রেখো না"। নাম দুটো বিভ্রান্তিকর, আর interviewer রা জানে যে বেশিরভাগ লোক এটা গুলিয়ে ফেলে।

---

## ৩. Key Takeaway

- **Anycast** — একই IP পৃথিবীজুড়ে ঘোষণা করে, routing নিজেই নিকটতম PoP এ পাঠায়
- **Cache key** = scheme + host + path + query string; query string আলাদা entry বানায় (`utm_*` সাবধান)
- **`Vary: Cookie` কার্যত CDN caching বন্ধ করে দেয়** — প্রতিটা user এর আলাদা entry
- `max-age` browser+CDN দুজনকেই, `s-maxage` শুধু CDN কে, `private` মানে CDN রাখবে না
- **`no-cache` ≠ "cache কোরো না"** — ওটা "যাচাই করে নিও"; "রেখো না" মানে `no-store`
- `stale-while-revalidate` — মেয়াদ শেষেও বাসিটা সাথে সাথে দিয়ে পেছনে নতুনটা আনা (stampede এর ওষুধ)
- **ETag + 304** — মেয়াদ শেষে পুরো body আবার আনতে হয় না, শুধু যাচাই
- **Content hashing purge এর চেয়ে ভালো** — নাম বদলালে cache key বদলায়, purge লাগেই না
- "Purge all" পুরো পৃথিবীর edge খালি করে origin এ **avalanche** ডেকে আনতে পারে
- Personalized/sensitive response কখনো CDN এ না — এটা performance bug না, **data breach**

---

## ৪. নতুন Term (Glossary)

| Term                       | অর্থ                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| **Anycast**                | একই IP একাধিক জায়গা থেকে ঘোষণা করা, routing নিকটতমটায় পাঠায়   |
| **Cache Key**              | edge কীসের ভিত্তিতে দুটো request কে "একই জিনিস" বলে ধরে          |
| **`s-maxage`**             | শুধু shared cache (CDN) এর জন্য TTL, `max-age` কে override করে   |
| **stale-while-revalidate** | মেয়াদোত্তীর্ণ copy সাথে সাথে দিয়ে, পেছনে নতুনটা এনে রাখা       |
| **ETag**                   | content এর আঙুলের ছাপ, conditional request (304) এ ব্যবহৃত       |
| **Purge**                  | CDN কে বলা যে একটা cached জিনিস এখনই ভুলে যেতে হবে               |
| **Origin Shield**          | edge আর origin এর মাঝে একটা স্তর, যাতে origin বারবার hit না খায় |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর Answer Key খুলো।

1. TaskFlow এর marketing page এ `Cache-Control: public, max-age=3600` দেওয়া আছে। একজন developer লক্ষ্য করল যে page টা update করার পর **কিছু user ১ ঘণ্টা পরেও পুরনোটা দেখছে, আর কেউ কেউ ২ ঘণ্টা পরেও**। CDN purge করার পরেও কয়েকজনের ক্ষেত্রে সমস্যা থেকে গেল। কেন?

2. একজন developer TaskFlow এর `/api/tasks` এ performance বাড়াতে `Cache-Control: public, max-age=300` বসিয়ে দিল। Staging এ সব ঠিকঠাক কাজ করল (দ্রুত হলো!), কিন্তু production এ যাওয়ার পর support এ অভিযোগ এলো — **কিছু user অন্য কারো task দেখতে পাচ্ছে**। ঠিক কী ঘটেছে, আর staging এ কেন ধরা পড়েনি?

3. TaskFlow এর logo টা `/logo.svg` এ আছে, `max-age=86400` সহ। Design team চায় নতুন logo **এখনই** সব জায়গায় দেখা যাক। Purge করা ছাড়া আর কোন উপায়ে এটা করা যেত, আর সেটা কেন ভালো হতো?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** কারণ `max-age=3600` **browser কেও** বলা হয়েছে। CDN purge করলে edge এর copy মুছে যায় ঠিকই, কিন্তু যেসব user এর **browser** এ ইতিমধ্যে copy টা বসে গেছে, তাদের browser পরের ১ ঘণ্টা পর্যন্ত CDN কে জিজ্ঞেসই করবে না — সে নিজের কাছ থেকেই দিয়ে দেবে। **Purge শুধু CDN পর্যন্ত পৌঁছায়, browser পর্যন্ত না।**

"২ ঘণ্টা পরেও" কেন? কারণ প্রতিটা user এর ঘড়ি আলাদা সময়ে শুরু হয়েছে — কেউ page টা পেয়েছে update এর ৫৯ মিনিট আগে, কেউ ১ মিনিট আগে।

সঠিক নকশা: browser কে অল্প সময় দাও, CDN কে বেশি —
`Cache-Control: public, max-age=60, s-maxage=3600`। তাহলে purge করলে সর্বোচ্চ ১ মিনিটের মধ্যে সবাই নতুনটা পাবে।

**প্রশ্ন ২:** `public` মানে **shared cache ও এটা রাখতে পারে**। CDN তাই user A এর task list টা cache key `/api/tasks` এ রেখে দিয়েছে — আর তারপর user B যখন একই URL এ এলো, edge তাকে **user A এর data** দিয়ে দিল। Cache key তে user এর কোনো চিহ্নই নেই (auth টা Authorization header বা cookie তে, যা default cache key এর অংশ না)।

**Staging এ ধরা পড়েনি কেন?** সম্ভবত দুটো কারণে: (ক) staging এ হয়তো CDN টাই bypass করা ছিল, (খ) আর যদি থাকতও, testing করছিল হয়তো একজনই — একটা user এর data একজনকেই ফেরত দিলে কিছু ভুল চোখে পড়ে না। **একাধিক user দিয়ে একই endpoint না টেস্ট করলে এই bug অদৃশ্য।**

সঠিক: `Cache-Control: private, no-store`। আর গতি চাইলে সেটা Redis এ, user-specific key সহ (Lesson 4.4) — CDN এ না।

এটাই Lesson 4.1 এর সেই সতর্কতা, বাস্তবে রূপ নেওয়া: এটা performance bug না, **data breach**।

**প্রশ্ন ৩:** **Content hashing** — logo টা `/logo.a1b2c3.svg` নামে রেখে HTML এ সেই নামটা reference করা। নতুন logo মানে নতুন hash, মানে নতুন নাম, মানে **সম্পূর্ণ নতুন cache key** — কোথাও কোনো পুরনো copy এর সাথে সংঘাতই নেই।

কেন ভালো: (ক) purge এর propagation delay এর উপর নির্ভর করতে হয় না, (খ) browser cache ও সাথে সাথে bypass হয় (প্রশ্ন ১ এর সমস্যাটা এখানে নেই), (গ) `max-age` এক বছর দেওয়া যায়, তাই hit ratio সর্বোচ্চ, (ঘ) rollback সহজ — পুরনো নামটা এখনো কাজ করে।

এটাই SvelteKit এর `_app/immutable/` folder এর পেছনের যুক্তি।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

TaskFlow একটা নতুন **public sharing** feature চালু করছে: যেকোনো user তার একটা task list "public" করতে পারবে, আর সেটা `taskflow.app/share/{token}` এ যে কেউ (login ছাড়াই) দেখতে পারবে। এই page গুলো viral হতে পারে — একটা জনপ্রিয় list এ মিনিটে হাজার hit আসতে পারে।

**যা ঠিক করতে হবে:**

1. `/share/{token}` এর জন্য ঠিক কোন `Cache-Control` header দেবে? `max-age`, `s-maxage`, `stale-while-revalidate` — তিনটার মান আলাদা করে বলো, আর প্রতিটার পেছনে যুক্তি দাও।

2. User যদি তার shared list টা **private করে দেয়**, তাহলে edge এ পড়ে থাকা copy টার কী হবে? তোমার design এ ঠিক কী কী ঘটতে হবে যাতে ১ সেকেন্ডের মধ্যে ওটা আর কেউ দেখতে না পায়? এখানে কি content hashing কাজে লাগবে — কেন, বা কেন না?

3. Page টায় user এর নাম আর ছবি দেখানো হয়। User নাম বদলালে shared page এ পুরনো নাম কতক্ষণ থাকবে? এটা কি গ্রহণযোগ্য? না হলে কী বদলাবে?

4. **একটু কঠিন:** একজন developer প্রস্তাব দিল — "shared page টায় একটা ছোট 'তুমি login করা আছো' banner দেখাই, যাতে user নিজের list চিনতে পারে।" এই একটা ছোট feature পুরো caching নকশাটা কীভাবে ভেঙে দেয়? সমস্যাটা এড়িয়ে feature টা রাখার উপায় কী?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (সম্পূর্ণ), 4.1, 4.2, 4.3, 4.4
Current: 4.5 — CDN কীভাবে কাজ করে
TaskFlow state: Nginx reverse proxy + LB, horizontal-scale-ready backend,
Redis caching layer (মাপা: 12ms → 3.7ms), আর এখন CDN নকশা ঠিক হয়েছে —
static/public content edge এ (hashed asset এ max-age এক বছর),
personalized API কখনোই না (private, no-store)
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution, Cache Hit Ratio,
Discriminated Union, Fail-safe, Offline Queue, Anycast, Cache Key,
s-maxage, stale-while-revalidate, ETag, Purge, Origin Shield
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 4.6 — Cache Failure Patterns (stampede, thundering herd, hot key)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও — বিশেষ করে ৪ নম্বর, ওটা বাস্তবে অসংখ্য team কে ধরা খাইয়েছে।

রেডি হলে `next` লিখো — Lesson 4.6, Module 4 এর শেষ lesson। এতক্ষণ আমরা দেখেছি cache **কাজ করলে** কী হয়। এবার দেখব cache **ভাঙলে** কী হয় — এবং সবচেয়ে অদ্ভুত ব্যাপারটা হলো, cache এর সবচেয়ে ভয়ংকর ব্যর্থতাগুলো ঘটে তখনই, যখন সে ঠিকঠাক কাজ করছিল। Stampede, thundering herd, hot key — তিনটাই এমন সমস্যা যেগুলো cache **থাকার কারণেই** তৈরি হয়।
