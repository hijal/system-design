# Module 4 — Exit Challenge

**Module 4 — Caching**

Module 4 এর ৬টা lesson শেষ — cache hierarchy, চারটা caching strategy, invalidation/TTL/eviction, একটা সত্যিকারের Redis layer (হাতে বানানো ও মাপা), CDN এর ভেতরকার কাজ, আর cache থাকার কারণে জন্ম নেওয়া ব্যর্থতাগুলো। এই Exit Challenge এ সবগুলো **একটা চাপের মুখে থাকা, বাস্তব scenario তে** একসাথে প্রয়োগ করতে হবে।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow এর একটা feature হঠাৎ viral হয়ে গেছে — **public shared task list** (Lesson 4.5 এর সেই `taskflow.app/share/{token}`)। একজন জনপ্রিয় productivity YouTuber তার template list share করেছেন, আর সেটা এখন **সেকেন্ডে ৪০,০০০ hit** খাচ্ছে। এই মুহূর্তে TaskFlow এর অবস্থা:
>
> - ৪টা Express instance, Nginx এর পেছনে (Module 3)
> - একটা Redis instance — cache **এবং** session দুটোই এখানে, `maxmemory-policy` কখনো সেট করা হয়নি
> - PostgreSQL এ `pool: { max: 10 }` per instance
> - `/share/{token}` এ `Cache-Control: public, max-age=300` দেওয়া আছে
> - Shared list এর data আসে `tasks:project:{id}` cache key থেকে, TTL ৩০০s, সব key এর TTL ঠিক ৩০০
> - Page এর উপরে একটা ছোট banner: _"তুমি login করা আছো — নিজের list দেখো"_ (login না থাকলে দেখায় না)
>
> **যা ঘটছে:** DB এর CPU প্রতি ৫ মিনিটে একবার ১০০% এ উঠছে, তারপর নেমে যাচ্ছে। Redis এর একটা মাত্র process এর CPU ৯৫%। Support এ দুইজন user অভিযোগ করেছেন যে তাঁরা **অন্য কারো নাম** banner এ দেখেছেন। আর গত রাতে হঠাৎ কিছু user হঠাৎ logout হয়ে গিয়েছিলেন।

তোমার কাজ — নিচের প্রতিটা প্রশ্নে Module 4 (এবং প্রাসঙ্গিক জায়গায় Module 1-3) এর concept প্রয়োগ করে সিদ্ধান্ত নাও, reasoning সহ:

**১. প্রতি ৫ মিনিটের DB spike (Lesson 4.6)**
CPU ঠিক ৫ মিনিট পরপর ১০০% এ উঠছে — এই ছন্দটাই সবচেয়ে বড় সূত্র। কোন ব্যর্থতা ঘটছে, আর তুমি কীভাবে নিশ্চিত হবে? প্রতিকার হিসেবে ঠিক কী কী করবে, আর কোনটা আগে (সবচেয়ে কম খরচে সবচেয়ে বেশি লাভ)?

**২. Banner এ অন্য কারো নাম (Lesson 4.5)**
এটা performance bug না — এটা কী, আর ঠিক কীভাবে ঘটল? `Cache-Control: public, max-age=300` আর ওই banner টা একসাথে থাকলে কেন এটা ঘটতেই হবে? দুটো আলাদা সমাধান দাও — একটা যেখানে banner থাকে, আরেকটা যেখানে থাকে না — আর বলো কোনটা তুমি বেছে নেবে, কেন।

**৩. Redis এর একটা process ৯৫% CPU (Lesson 4.6)**
Redis এ node যোগ করলে কি এটা সমাধান হবে? কেন, বা কেন না? তোমার প্রস্তাবিত সমাধানে staleness এর কোন নতুন স্তর যোগ হচ্ছে, আর সেটা এই use case এ গ্রহণযোগ্য কিনা — বলো।

**৪. রাতের হঠাৎ logout (Lesson 4.3)**
Cache আর session একই Redis এ, আর `maxmemory-policy` সেট করা নেই। রাতে ঠিক কী ঘটেছিল বলে মনে করো? Default policy কী, আর সেটা থাকলে এই লক্ষণটা ব্যাখ্যা করা যায়, নাকি অন্য কিছু ঘটেছে? তোমার সমাধানে **শুধু policy বদলানো যথেষ্ট কিনা** সেটাও বলো।

**৫. Connection pool (Lesson 4.6 + 1.6)**
৪টা instance × `pool: { max: 10 }` = সর্বোচ্চ ৪০টা concurrent DB connection। Stampede এর মুহূর্তে সেকেন্ডে ৪০,০০০ request এর কতগুলো DB পর্যন্ত পৌঁছাতে চাইবে, আর pool শেষ হয়ে গেলে বাকিদের কী হবে? Pool size বাড়ানো কি সঠিক প্রতিকার?

**৬. পুরো নকশাটা আবার সাজাও (Lesson 4.1-4.6)**
সব জেনে, `/share/{token}` এর জন্য একটা সম্পূর্ণ caching নকশা লেখো — browser থেকে DB পর্যন্ত প্রতিটা স্তরে কী থাকবে, TTL কত, key কী, invalidation কীভাবে, আর কোন ব্যর্থতার বিরুদ্ধে কোন রক্ষাকবচ। এক পাতায় ধরাতে হবে।

**মনে রাখার কথা:** এই module এ তোমার দুটো নজরের জায়গা তৈরি হয়েছে — (ক) cache down হলে latency ধসে পড়া, (খ) `public` বনাম `private` এর নিরাপত্তা তাৎপর্য। আজকের scenario তে দুটোই লুকিয়ে আছে। আর সবচেয়ে গুরুত্বপূর্ণ অভ্যাসটা: **প্রতিকার বসানোর আগে রোগনির্ণয়** — "DB load বেশি" যথেষ্ট না, "spike নাকি একটানা, আর কোন ছন্দে" — সেটাই আসল প্রশ্ন।

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

- [ ] একটা request এর পুরো path জুড়ে caching এর স্তরগুলো (browser → CDN → proxy → app → DB buffer pool) বলতে পারি, আর কোন স্তর কোন ধরনের data এর জন্য উপযুক্ত — জানি
- [ ] Cache-Aside, Read-Through, Write-Through, Write-Behind, Write-Around — পাঁচটার কাজ আর trade-off আলাদা করে বলতে পারি
- [ ] Read path আর write path যে আলাদা করে ভাবতে হয়, আর কেন — বুঝি
- [ ] একই application এর ভেতরে আলাদা data এর জন্য আলাদা strategy লাগে (task title বনাম view counter) — এটা উদাহরণসহ বোঝাতে পারি
- [ ] TTL, invalidation আর eviction — তিনটা আলাদা প্রক্রিয়া, আর কোনটা কে নিয়ন্ত্রণ করে — গুলিয়ে ফেলি না
- [ ] Write এ cache **delete** করা কেন update করার চেয়ে ভালো, আর ক্রম কেন **আগে DB পরে cache** — ব্যাখ্যা করতে পারি
- [ ] একটা write এ derived/filtered view গুলোও (`:completed`, `:page:2`) invalidate করতে হয় — এটা মনে থাকে
- [ ] LRU আর LFU এর পার্থক্য, আর কোন traffic pattern এ কোনটা — বলতে পারি
- [ ] Express + Sequelize + Redis দিয়ে একটা কাজ করা Cache-Aside layer **নিজে বানিয়েছি**, আর cache এর লাভটা মেপে দেখিয়েছি (Lesson 4.4)
- [ ] Cache থেকে আসা data ও runtime input — Zod দিয়ে validate করতে হয়, `as` দিয়ে না — এটা কেন, বুঝি
- [ ] Cache এর ব্যর্থতা কখনো request ব্যর্থ করা উচিত না, আর client timeout ঠিক না থাকলে "cache down" কীভাবে "site down" হয়ে যায় — হাতে-কলমে দেখেছি
- [ ] `max-age` / `s-maxage` / `private` / `no-cache` / `no-store` — কোনটা কাকে উদ্দেশ্য করে বলা, আর `no-cache` যে "cache কোরো না" মানে না — জানি
- [ ] Personalized response CDN এ cache হলে সেটা bug না, **breach** — এই ঝুঁকিটা চিনি
- [ ] Content hashing কেন purge এর চেয়ে ভালো — বলতে পারি
- [ ] Stampede, avalanche, hot key, penetration — চারটার **লক্ষণ আলাদা করে** চিনতে পারি এবং উপযুক্ত প্রতিকার বেছে নিতে পারি
- [ ] Single-flight নিজে চালিয়ে দেখেছি, আর জানি কেন in-process lock একাধিক instance এ সমস্যাটা _কমায়_, _মেটায় না_

---

## ৩. Recommendation

**পড়ার জন্য:**

- Redis এর official documentation এর "Key eviction" পাতা — `maxmemory-policy` এর প্রতিটা option, আর LRU টা যে আসলে **আনুমানিক** LRU (পুরো keyspace scan না করে নমুনা নেয়) সেটা এখানে পরিষ্কার হবে। আজকের ৪ নম্বর প্রশ্নের সাথে সরাসরি যুক্ত।
- MDN এর `Cache-Control` পাতা — Lesson 4.5 এর directive গুলোর সম্পূর্ণ, নির্ভরযোগ্য তালিকা। `no-cache` বনাম `no-store` এর ব্যাখ্যাটা এখানে সবচেয়ে স্পষ্ট।

**দেখার জন্য:**

- Cloudflare এর "Cache Rules" আর "Tiered Cache" documentation — Lesson 4.5 এর cache key, `Vary`, আর origin shield এর ধারণাগুলো একটা বাস্তব CDN এ ঠিক কীভাবে configure হয়, সেটা দেখতে পাবে। TaskFlow যেহেতু Cloudflare এ, এটা সরাসরি কাজে লাগবে।

**Project এর জন্য:**

- Lesson 4.4 এর exercise টায় ফিরে গিয়ে (নিজের সময়ে) **negative caching** আর **TTL jitter** দুটোই যোগ করো — Lesson 4.6 এর exercise ৩ আর ৪। তারপর `npm run stampede` আর `npm run bench` আবার চালিয়ে সংখ্যাগুলো আগের সাথে মিলিয়ে দেখো।
- আরও এক ধাপ এগোতে চাইলে: `src/singleflight.ts` এর in-process Map টা Redis-ভিত্তিক distributed lock দিয়ে বদলে দেখো (`SET key val NX PX 5000`)। ৪টা instance চালিয়ে (Lesson 3.3 এর docker-compose এর মতো) stampede মেপে দেখো — ৪ থেকে ১ এ নামে কিনা। এটা Lesson 6.4 এর একটা চমৎকার প্রস্তুতি।

---

Exit challenge টা করে পাঠাও। রেডি হলে `next` লিখলে আমরা **Module 5: Database Design & Scaling** এ যাব — Lesson 5.1 দিয়ে শুরু, SQL vs NoSQL এর আসল trade-off।

Module 4 জুড়ে আমরা DB কে বাঁচানোর চেষ্টা করেছি — cache দিয়ে তার কাজ কমিয়েছি, তার সামনে ঢাল ধরেছি। Module 5 এ সেই DB টার **ভেতরে** ঢুকব: সে data টা আসলে কীভাবে রাখে, index কেন query দ্রুত করে, transaction এর দাম কী, আর যখন একটা machine আর যথেষ্ট না — তখন কী।
