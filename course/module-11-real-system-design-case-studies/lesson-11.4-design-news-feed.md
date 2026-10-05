# Lesson 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style)

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 2.5):** Offset pagination বড় table এ কেন ধীর, আর cursor pagination সেটা কীভাবে এড়ায়? সেখানে প্রশ্নটা ছিল **গতির**। আজ একটা feed এ দেখবে offset এর আরেকটা সমস্যা, যেটা ছোট table এও হয়: user যখন পড়ছে তখন উপরে নতুন post জমে, আর দ্বিতীয় page এ ৪১% session এ আগে দেখা post আবার আসে।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 2.5 (Pagination), Lesson 4.2 (Cache-aside), Lesson 4.6 (Hot key), Lesson 5.8 (Sharding, scatter-gather), Lesson 7.2 (Queue), Lesson 7.6 (Batch vs stream), Lesson 9.4 (Bulkhead), Lesson 10.4 (Tail latency, percentile), Lesson 11.3 (Fan-out, sequence)

**তুমি এই lesson শেষে পারবে:**

1. একটা feed এর মূল প্রশ্নটা, **কখন জোড়া লাগাব** (লেখার সময় সব follower এর timeline এ, নাকি পড়ার সময় সবার post থেকে), সংখ্যা দিয়ে উত্তর দিতে পারবে, follower সংখ্যার power law বণ্টন ধরে, গড় দিয়ে না
2. Hybrid fan-out নকশা করতে পারবে, আর বলতে পারবে তার আসল লাভ কোথায় (গড় লেখা প্রায় একই, কিন্তু celebrity এর spike নেই), fan-out এর queue কে কীভাবে ভাগ করবে যাতে একজন celebrity বাকিদের আটকে না দেয়, আর তার দাম পড়ার দিকে কোথায়
3. পড়ার পথের দুটো সূক্ষ্ম সমস্যা ধরতে পারবে: অনেক জায়গা থেকে একসাথে আনলে p99 এর বিস্ফোরণ (আর hedged request), আর চলমান feed এ offset pagination এর ভুল; সাথে ranking কোথায় বসে

**Tier:** 1 — Runnable Code (তিনটা deterministic model আর একটা আসল Express + Zod hybrid feed service; Docker লাগে না)

---

## ০. আজকের System

Interviewer:

> "Twitter এর home timeline design করো। User কিছু মানুষকে follow করে, home page এ তাদের নতুন post দেখে। ৩০ কোটি daily user।"

11.3 এর প্রশ্ন ৩ মনে আছে? ১০,০০০ সদস্যের group এ প্রতিটা message প্রতিটা সদস্যের inbox এ লেখা অসম্ভব হয়ে উঠছিল। News feed হলো সেই প্রশ্নটা পুরো system হিসেবে: প্রতিটা "follow" একটা একমুখী সম্পর্ক, আর একজন মানুষের follower দশ জন থেকে পনেরো কোটি পর্যন্ত। প্রথম চাল প্রায় সবসময় দুটোর একটা:

- "প্রতিটা user এর জন্য একটা timeline list রাখি। কেউ post করলে তার সব follower এর list এ বসিয়ে দিই। পড়া তখন একটা list পড়া।"
- "পড়ার সময় user যাদের follow করে তাদের সবার শেষ post এনে সময় ধরে সাজাই।"

দুটোই ঠিক উত্তর, ভিন্ন ভিন্ন মানুষের জন্য। Interviewer এর follow-up:

- "একজনের ১৫ কোটি follower। সে post করল। প্রথম উপায়ে কতগুলো লেখা? কতক্ষণে শেষ? ততক্ষণ বাকিদের post এর কী হয়?"
- "দ্বিতীয় উপায়ে একটা feed পড়তে কতগুলো জায়গায় যাও? তার p99 কত?"
- "User scroll করছে, উপরে নতুন post আসছে। দ্বিতীয় page এ কী দেখবে?"
- "Unfollow করলে, বা একটা post মুছলে, সব timeline থেকে মুছবে?"

---

## ১. Theory

### ১.১ Step 1 — Requirement

```
প্রশ্ন                                       ধরে নিলাম
কত user?                                     ৫০ কোটি account, ৩০ কোটি DAU, দিনে ১০ বার feed খোলে
কত post?                                     account প্রতি দিনে গড়ে ০.১টা (বেশিরভাগ শুধু পড়ে)
কতজনকে follow?                               গড়ে ২০০; follower এর সংখ্যা power law এ (নিচে)
Feed এর ক্রম?                                 আজ সময়ের ক্রম; ranking শেষে আলোচনা
নতুন post কতক্ষণে দেখাবে?                     কয়েক সেকেন্ড চলে (chat এর মতো real-time না)
কত পুরনো পর্যন্ত scroll?                      কয়েকশো post; তার বেশি কেউ যায় না
বাদ দিলাম                                    post তৈরি আর media (8.2), search (8.3), like/comment এর গণনা, notification (11.5)
```

Non-functional: feed খোলা দ্রুত (p99 ~১০০ ms server এ), feed পড়া প্রায় সবসময় চলে (একটা অংশ ধীর হলে বাকিটা দেখাও, 10.3), নতুন post কয়েক সেকেন্ডে, আর **eventual consistency চলে**: আমার post আমার follower রা কয়েক সেকেন্ড পরে দেখলে কেউ টের পায় না। কিন্তু **আমি নিজে** আমার post সাথে সাথে দেখব (6.3 এর read-your-writes)।

### ১.২ Step 2 — Estimation, আর গড় কেন মিথ্যা বলে

**Fan-out on Write (Push)** — একটা post তৈরির সময়ই সেটা লেখকের প্রতিটা follower এর তৈরি করা timeline এ বসানো; পড়া মানে নিজের timeline এর একটা list পড়া। **Fan-out on Read (Pull)** — post শুধু লেখকের নিজের list এ; পড়ার সময় যাদের follow করি তাদের সবার সাম্প্রতিক post এনে জোড়া লাগানো।

দুটোর খরচ নির্ভর করে একটা সংখ্যার উপর: একটা post এ কতজন follower। আর সেই সংখ্যা সমান না। Social network এ follower এর সংখ্যা মোটামুটি power law মানে: বেশিরভাগ মানুষের অল্প, অল্প কয়েকজনের বিশাল। `npm run estimate` একটা power law (α = ১.২) কে গড় ২০০ তে মিলিয়ে নেয়:

```
── Part A — the follower distribution: 500 million accounts, following 200 on average, power law (α = 1.2), max 150 million ──
median account (p50)                                      62
p99                                                    1,613
p99.99                                                74,850
biggest account                                  150,000,000
the top 0.01% of accounts (50,000) hold 18.2% of all follows
the top 1% of accounts (5,000,000) hold 44.3% of all follows

── Part B — traffic ──
                                                 average/s        peak/s
feed reads                                          34,722       104,167
new posts                                              579         1,736
```

গড় ২০০, কিন্তু মাঝের account এর ৬২। আর ৫০,০০০টা account (০.০১%) এর কাছে সব follow এর ১৮%। "একটা post এ গড়ে ২০০টা লেখা" বললে তুমি ঠিক সেই post গুলো ভুলে যাচ্ছ যেগুলো system কে ফেলে দেয়। তাই estimation এ সবসময় জিজ্ঞেস করো: **বণ্টনটা কেমন, আর লেজে কী আছে?**

আর পড়া লেখার ৬০ গুণ (১,০৪,০০০ বনাম ১,৭০০ peak এ)। এই অনুপাত push এর পক্ষে: যে কাজ বারবার হয় (পড়া), সেটা সস্তা করো, যে কাজ কম হয় (লেখা) সেখানে খরচ দাও। প্রশ্ন শুধু লেজের celebrity।

### ১.৩ API আর data model

```
POST   /users/:id/posts                → 201 { id }
POST   /users/:id/follow/:target       → 204       DELETE একই → 204
DELETE /posts/:id                      → 204
GET    /users/:id/feed?limit=20&cursor=<শেষ দেখা id>  → { items[], nextCursor }
```

```
post(id, author_id, body, created_at, deleted_at)           ← টেকসই, author ধরে shard
follow(follower_id, followee_id, created_at)                ← দুই দিকে index: "আমি কাকে" আর "আমাকে কে"
author_posts: author → [post id, …] (সাম্প্রতিক কয়েকশো)    ← cache, pull এর জন্য
home_timeline: user → [post id, …] (সর্বোচ্চ ৮০০)           ← cache, push এর জন্য, শুধু id
```

তিনটা খুঁটিনাটি:

- **Timeline এ শুধু id।** Post এর লেখা, ছবি, লেখকের নাম আলাদা cache থেকে (hydration)। একটা জনপ্রিয় post এর লেখা একবার cache এ, ১৫ কোটি timeline এ না। আর post edit হলে একটা জায়গায় বদল।
- **Post id নিজেই সময়ের ক্রম।** Snowflake এর মতো id (সময় + machine + ক্রমিক সংখ্যা) যা মোটামুটি সময়ের সাথে বাড়ে। তাহলে "id ধরে উল্টো সাজাও" মানে "নতুন আগে", আর cursor মানে "এই id এর চেয়ে ছোট"। 11.1 এর range allocation এর আত্মীয়, কিন্তু এখানে ইচ্ছা করেই সময়ের ক্রম রাখা, কারণ এটা গোপন কিছু না।
- **Timeline Cache** — প্রতিটা সক্রিয় user এর home timeline এর একটা সীমিত list (এখানে ৮০০ id), memory তে (Redis এর list বা sorted set)। সীমা কারণ কেউ ৮০০ এর বেশি নিচে যায় না, আর যে যায় তার জন্য pull এ ফেরা যায়। নিষ্ক্রিয় user এর timeline রাখা হয় না; সে ফিরলে একবার pull করে বানানো হয়। Twitter এর প্রকাশিত timeline এর নকশা (২০১২-১৩ এর আলোচনা) প্রায় এরকম: Redis এ ~৮০০টা id এর list, fan-out service, আর বড় account এর post পড়ার সময় মেশানো।

### ১.৪ Step 3 — Push, pull, hybrid: সংখ্যায়

```
── Part C — three paths (40% of followers active; 800 ids × 16 B in a timeline) ──
path                                      timeline writes/s    biggest post  fetch per read  fetch/s (peak)     cache
fan-out on write (push to everyone)                 115,741     150,000,000             1.0         104,167    3.8 TB
push, active followers only                          46,296      60,000,000             1.0         104,167    3.8 TB
fan-out on read (pull from everyone)                      0               0           200.0      20,833,333         —
hybrid: over 1,000,000 → pull                        42,091         400,000            19.2       1,996,773    3.8 TB
hybrid: over 100,000 → pull                          38,446          40,000            34.9       3,636,764    3.8 TB
hybrid: over 10,000 → pull                           32,660           4,000            59.9       6,240,577    3.8 TB
over 1,000,000 followers: 2,178 accounts, 9.1% of all follows
```

- **Push:** পড়া একটা fetch, কিন্তু লেখা সেকেন্ডে ১.১৬ লাখ, আর একটা post এ ১৫ কোটি। শুধু সক্রিয় follower দের (গত মাসে এসেছে এমন, ৪০%) push করলে আড়াই গুণ কম; বাকিরা ফিরলে একবার pull। এটা প্রায় বিনা মূল্যের প্রথম উন্নতি।
- **Pull:** লেখা শূন্য, কিন্তু প্রতিটা feed পড়ায় ২০০টা জায়গা: peak এ সেকেন্ডে ২ কোটি fetch। আর তার latency (১.৬)।
- **Hybrid Fan-out** — সাধারণ account এর post push হয়, আর একটা সীমার বেশি follower এর account (celebrity) এর post শুধু তার নিজের list এ থাকে; পড়ার সময় user এর তৈরি timeline আর সে যে কয়জন celebrity কে follow করে তাদের সাম্প্রতিক post মেশানো হয়।

Hybrid এর সারি গুলোয় একটা অপ্রত্যাশিত জিনিস: **গড় লেখা প্রায় কমে না** (৪৬k থেকে ৪২k, ১০ লাখের সীমায়)। কারণ ১০ লাখের বেশি follower এর account মাত্র ২,১৭৮টা, আর তারা সব follow এর ৯%। Hybrid এর লাভ গড়ে না, **লাভ spike এ:** সবচেয়ে বড় একটা post এর লেখা ৬ কোটি থেকে ৪ লাখ। সেটা কেন এত জরুরি, পরের অংশে।

আর দাম: পড়ায় fetch ১ থেকে ১৯ (গড় user ১০ লাখের বেশি follower এর ১৮ জনকে follow করে)। কিন্তু এই fetch গুলো একই ২,১৭৮টা account এর সাম্প্রতিক post, যা প্রতিটা feed server এর local memory তে রাখা যায় (কয়েক MB), তাই আসলে network এর fetch না, memory পড়া। সীমা যত নামাবে (১০,০০০ এ), celebrity তত বেশি (৫.৭ লাখ), তাদের post আর local memory তে ধরে না, আর পড়ার খরচ সত্যিকারের fetch হয়ে যায়। তাই সীমাটা বসে যেখানে celebrity দের post একটা গরম, ছোট cache এ ধরে।

### ১.৫ Fan-out এর queue: একজন celebrity কীভাবে সবাইকে আটকায়

Push এ post তৈরি দ্রুত (একটা লেখা), তারপর fan-out একটা queue তে (7.2), worker রা follower দের timeline এ বসায়। ধরো fan-out এর মোট ক্ষমতা সেকেন্ডে ২০ লাখ লেখা, আর স্বাভাবিক চাপ তার ~৭%। `npm run fanout`: peak এ ১,৭৩৬ post/s, এক মিনিটে সবচেয়ে বড় account post করে, ২০০ সেকেন্ডে পরের পাঁচটা একসাথে (একটা খেলার শেষে, ধরো):

```
policy                                                        ordinary post p50       p99        worst  > 5 s late  big post done
one FIFO queue, push to everyone                                         100 ms  142.10 s     147.70 s     311,955       147.80 s
two queues: big jobs (> 100,000) separate, 25% of capacity               100 ms    100 ms     156.60 s           8       157.40 s
hybrid: over 1,000,000 followers are not pushed                          100 ms    100 ms       300 ms           0        by pull
```

- **একটা FIFO queue:** celebrity এর ৬ কোটি লেখা queue এর মাথায় বসে, আর তার পেছনে প্রতিটা সাধারণ post অপেক্ষা করে। **৩ লাখের বেশি** সাধারণ post ৫ সেকেন্ডের বেশি দেরিতে পৌঁছায়, p99 ১৪২ সেকেন্ড। কেউ একজন একটা বড় খেলার পরে tweet করল, আর বাকি দুনিয়ার feed আড়াই মিনিট থেমে থাকল। এটা 9.4 এর bulkhead এর সমস্যা, queue এর ভেতরে: **বড় আর ছোট কাজ এক লাইনে রাখলে ছোটরা বড়র পেছনে মরে।**
- **দুটো queue:** বড় job আলাদা queue তে, নিজের ভাগের ক্ষমতা নিয়ে। সাধারণ post আর আটকায় না (p99 ১০০ ms)। কিন্তু ৮টা post এখনও আটকাল: এরা মাঝারি account (১ থেকে ১০ লাখ follower), যাদের job "বড়" এর সীমা পার হয়ে celebrity দের সাথে একই লাইনে পড়ল। Experiment ২: বড় এর সীমা ১০ লাখ করলে তারা ছোট queue তে ফেরে, সবচেয়ে খারাপ ৪০০ ms। আর বড় queue এর ভাগ ২৫% থেকে ৫০% করলে **কিছুই বদলায় না,** কারণ ছোট queue এর চাপ এমনিতেই কম আর বাকি ক্ষমতা বড় queue পায়। ভাগের সংখ্যাটা কাজে লাগে শুধু যখন দুটো queue ই ব্যস্ত।
- **Hybrid:** celebrity এর post কখনো queue তে ঢোকে না। সাধারণ post এর সবচেয়ে খারাপ ৩০০ ms, আর celebrity এর post "পৌঁছায়" সাথে সাথে, কারণ follower রা পড়ার সময় টানে।

তাই hybrid এর আসল যুক্তি: **একটা post এর সবচেয়ে খারাপ খরচকে সীমায় বাঁধা।** গড় প্রায় একই থাকে, কিন্তু system এর আচরণ আর একজন মানুষের একটা tweet এর উপর নির্ভর করে না।

### ১.৬ পড়ার পথ: অনেক জায়গা থেকে আনলে p99 কার?

Pull এর খরচ শুধু fetch এর সংখ্যা না। একটা feed পড়া শেষ হয় **সবচেয়ে ধীর fetch টা** এলে। 10.4 এ দেখেছিলাম গড় লেজ লুকায়; এখানে লেজ গুণ হয়। `npm run read` অংশ ক: প্রতিটা fetch median ২ ms, কিন্তু ১% সময় ৫০ ms (GC, একটা ব্যস্ত shard, network):

```
path                                                     K       p50       p99  at least one slow
push: your own timeline only                             1   2.01 ms   6.69 ms               0.9%
hybrid: timeline + ~19 celebrities                      20   4.40 ms     53 ms              18.2%
hybrid, slow ones hedged (second try at 10 ms)          20   4.40 ms     14 ms              18.1%
pull: posts from all 200                               200     52 ms     54 ms              86.7%
pull, with hedging                                     200     12 ms     52 ms              86.8%
```

**Tail Amplification** — একটা request যদি K টা অংশের উপর নির্ভর করে আর প্রতিটার ধীর হওয়ার সম্ভাবনা p, তাহলে অন্তত একটা ধীর হওয়ার সম্ভাবনা 1 − (1 − p)^K। K = ২০০ আর p = ১% এ **৮৭%**: pull এর **মাঝের** feed পড়াই (p50) ৫২ ms, কারণ প্রায় প্রতিটা পড়ায় কোনো একটা অংশ ধীর। একটা অংশের "বিরল" লেজ পুরো system এর "সাধারণ" অবস্থা হয়ে যায়। (Google এর "The Tail at Scale" লেখার মূল কথা এটাই।) Experiment ৩: ধীর মাত্র ০.১% হলেও pull এ ১৮% পড়ায় একটা ধীর, p99 তখনও ৫৩ ms।

**Hedged Request** — একটা অংশ একটা নির্দিষ্ট সময়ের মধ্যে (এখানে ১০ ms, স্বাভাবিকের p95 এর কাছে) উত্তর না দিলে একই অনুরোধ আরেকটা replica তে পাঠানো, আর যেটা আগে আসে সেটা নেওয়া। ধীর হওয়া প্রায়ই সাময়িক আর একটা machine এর, তাই দ্বিতীয় চেষ্টা প্রায়ই দ্রুত। Hybrid এ p99 ৫৩ থেকে **১৪ ms**। দাম: ১০ ms এর বেশি নেওয়া অংশ গুলোর জন্য বাড়তি একটা request (এখানে কয়েক %)। কিন্তু pull এ hedge p50 বাঁচায় (৫২ থেকে ১২) অথচ p99 না (৫২): ২০০টা অংশে hedge এর দ্বিতীয় চেষ্টাও কোথাও না কোথাও ধীর। K ছোট রাখা hedge এর চেয়ে শক্তিশালী উপায়।

এখানে push এর পড়ার পক্ষে আসল যুক্তি: একটা fetch, একটা লেজ। আর hybrid এর celebrity অংশ local memory তে হলে সেটা আসলে K এ যোগই হয় না।

### ১.৭ Pagination: চলমান feed এ offset

**Spaced repetition এর উত্তর:** offset ধীর কারণ database কে আগের সব row পড়ে ফেলে দিতে হয়; cursor "এর পরের" থেকে শুরু করে, index দিয়ে সোজা সেখানে যায়। এটা গতির কথা ছিল। Feed এ আরেকটা সমস্যা: user প্রথম page পড়তে পড়তে উপরে নতুন post জমে। অংশ খ, মিনিটে ২টা নতুন post, page পড়তে গড়ে ৩০ s, প্রথম page এর ২% মুছে যায়:

```
how the page works                        already seen on page 2     one skipped
?offset=20 (skip the first 20)                                  40.6%           18.4%
?cursor=<last seen id> (id < cursor)                        0.0%            0.0%
```

Offset ২০ মানে "এখনকার তালিকার প্রথম ২০টা বাদ দাও"। কিন্তু এখনকার তালিকার উপরে দুটো নতুন post এসেছে, তাই প্রথম page এর শেষ দুটো আবার দ্বিতীয় page এ: **৪১%** session এ পুনরাবৃত্তি। আর প্রথম page থেকে একটা post মুছলে সব এক ঘর উপরে ওঠে, আর একটা post কেউ দেখে না: **১৮%** এ। Experiment ৪: মিনিটে ১০টা নতুন post এ পুনরাবৃত্তি ৭৮%। Cursor ("যে id দেখেছি তার চেয়ে পুরনো দাও") এ দুটোই শূন্য, কারণ সেটা একটা নির্দিষ্ট post কে নোঙর ধরে, তালিকার অবস্থান না। আর উপরের নতুন post গুলো? সেগুলো আলাদা প্রশ্ন: "এই id এর চেয়ে নতুন কী আছে" (pull-to-refresh, বা "১২টা নতুন post" এর বোতাম)।

### ১.৮ Ranking (মাপা না, কাঠামো)

আজকের feed সময়ের ক্রমে। Facebook বা Instagram এর feed ranked: সবচেয়ে "প্রাসঙ্গিক" আগে। কাঠামোটা আজকের নকশার উপরেই বসে, তিন ধাপে:

1. **Candidate Generation** — হাজারো সম্ভাব্য post থেকে কয়েকশো প্রার্থী বাছা, সস্তায়: user এর timeline cache (push), celebrity দের সাম্প্রতিক post (pull), আর follow এর বাইরের কিছু উৎস (জনপ্রিয় post, "তোমার বন্ধুরা যা পছন্দ করেছে")। আজকের পুরো নকশা আসলে এই ধাপ।
2. **Scoring:** প্রতিটা প্রার্থীর জন্য feature (লেখকের সাথে কত interaction, post এর বয়স, ধরন, কতজন like করেছে) এনে একটা model দিয়ে score। এখানে latency এর বাজেট সবচেয়ে টাইট: কয়েকশো প্রার্থী × feature এর lookup, তাই feature গুলো আগে থেকে হিসাব করে একটা দ্রুত store এ (7.6 এর stream বা batch থেকে)।
3. **মিশ্রণ আর নিয়ম:** একই লেখকের পরপর তিনটা না, বিজ্ঞাপনের জায়গা, আগে দেখানো বাদ।

Ranking এর একটা নকশাগত প্রভাব: cursor আর "id এর চেয়ে ছোট" দিয়ে চলে না, কারণ ক্রম সময়ের না। তখন প্রথম page এর সময় পুরো ranked তালিকা (কয়েকশো) একবার বানিয়ে একটা ছোট session cache এ রাখা হয়, আর পরের page গুলো সেই তালিকা থেকে, যাতে scroll এর মাঝে ক্রম বদলে পুনরাবৃত্তি না হয়।

### ১.৯ একটা আসল hybrid feed

`npm run smoke` একটা Express feed service চালায়: celebrity এর সীমা ৩ জন follower (ছোট করে, দেখানোর জন্য), star এর ৪ জন follower (pull), alice এর ২ জন (push), আর fan-out এর queue যা হাতে `drain()` করা হয়:

```
#   step                                                        result
1   alice posted a1; the fan-out queue hasn't run yet           bob: (empty); 2 in the queue
2   the fan-out worker ran                                      bob: a1[push]; 2 timeline writes
3   star posted s1 (4 followers → not pushed)                   0 in the queue; amy: s1[pull]
4   bob's feed: push and pull merged, in id order               s1[pull] a1[push]
5   cat, first page (limit 3)                                   a7[push] a6[push] a5[push]
6   meanwhile a8, a9 arrived; second page ?offset=3             a6[push] a5[push] a4[push]
7   second page ?cursor=6                                       a4[push] a3[push] a2[push]
8   bob unfollows alice (the ids remain in his timeline)        bob: s1[pull]
9   s1 deleted                                                  amy: (empty)
10  the counts                                                  18 timeline writes (22 if everyone were pushed), 9 pull reads
```

- ধাপ ১-২: push এ eventual consistency চোখে দেখা যায়: post তৈরি হয়েছে, কিন্তু bob এর timeline এ আসে fan-out worker চলার পরে। এই exercise এ লেখক নিজেও fan-out এর পরেই দেখে। Read-your-writes এর জন্য পড়ার সময় নিজের author list থেকেও মেশানো দরকার, আর সেটা practical exercise এর ৪ নম্বর কাজ।
- ধাপ ৩-৪: star এর post কোনো queue এ যায় না, আর পড়ার সময় push এর timeline এর সাথে id এর ক্রমে মেশে।
- ধাপ ৬-৭: ১.৭ এর সংখ্যা, চোখে: offset এ a6, a5 আবার, cursor এ ঠিক পরের গুলো।
- ধাপ ৮-৯: **Unfollow আর delete পড়ার সময় ছাঁকা হয়।** Bob এর timeline cache এ alice এর id গুলো এখনও আছে, কিন্তু পড়ার সময় "আমি কি এখনও এই লেখককে follow করি" আর "post কি মুছে গেছে" দেখে বাদ। ১৫ কোটি timeline থেকে একটা post মুছে ফেলার fan-out (আরেকটা celebrity spike) এর চেয়ে এটা অনেক সস্তা। Cache এ পড়ে থাকা মরা id গুলো ধীরে ধীরে ৮০০ এর সীমায় নিজে থেকে বেরিয়ে যায়।

### ১.১০ Step 5 — Trade-off আর wrap-up

**চূড়ান্ত নকশা:**

- **লেখা:** post টেকসই store এ (author ধরে shard), author list এ, তারপর লেখকের follower ১০ লাখের নিচে হলে fan-out queue তে, শুধু সক্রিয় follower দের। Fan-out এর queue দুই ভাগে (ছোট আর বড় job), যাতে মাঝারি account ও সাধারণদের না আটকায়।
- **পড়া:** timeline cache (৮০০ id) + যাদের follow করি তাদের মধ্যে celebrity দের সাম্প্রতিক post (local memory এর cache), id ধরে মেশানো, তারপর ছাঁকা (unfollow, delete, block), তারপর hydration (post এর লেখা, লেখক আলাদা cache থেকে)। নিষ্ক্রিয় user ফিরলে একবার pull করে timeline বানানো।
- **Pagination:** cursor (শেষ দেখা id), নতুনের জন্য "এর চেয়ে নতুন"।
- **Tail:** K ছোট রাখা (hybrid এ celebrity অংশ local), বাকি fetch এ hedge।

> **Trade-off Table — কখন জোড়া লাগাব**

| পথ                      | লেখার খরচ                                         | পড়ার খরচ                             | নতুন post দেখাতে দেরি                 | কোথায় ভালো                                      |
| ----------------------- | ------------------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Push (সব follower)      | গড় ১.১৬ লাখ/s, একটা post এ ১৫ কোটি পর্যন্ত       | ১ fetch, ছোট লেজ                      | Fan-out শেষ হলে (FIFO এ মিনিট)        | পড়া বেশি, follower কম আর সমান                   |
| Push (শুধু সক্রিয়)     | আড়াই গুণ কম                                      | ১ fetch; ফেরা user এর জন্য একবার pull | একই                                   | প্রায় সবসময় push এর চেয়ে ভালো                 |
| Pull                    | শূন্য                                             | ২০০ fetch, p50 ই লেজে (৫২ ms)         | সাথে সাথে                             | লেখা বেশি, পড়া কম; বা খুব ছোট system            |
| Hybrid (১০ লাখ+ → pull) | গড় প্রায় একই, কিন্তু spike নেই (৪ লাখ সর্বোচ্চ) | ১ + local memory এর celebrity         | সাধারণ: সেকেন্ড; celebrity: সাথে সাথে | বড় social network — power law এর লেজ আছে যেখানে |

**কী আগে ভাঙবে:** সীমার কাছের account (follower ১০ লাখের কাছে ওঠানামা করলে push আর pull এর মাঝে দোলে; সীমায় একটা hysteresis রাখো, যেমন ১০ লাখে উঠলে pull, ৮ লাখে নামলে push); একটা viral post এর hydration (একটা post id সবার feed এ, তার লেখা আর like এর সংখ্যার cache এ hot key, 4.6); আর ranking যোগ হলে feature store এর latency।

---

## ২. Interview Angle

"Design Twitter/news feed" সবচেয়ে প্রচলিত প্রশ্নগুলোর একটা, আর interviewer প্রায় নিশ্চিত ভাবে push বনাম pull আর celebrity তে যাবেন। ভালো উত্তরের আকৃতি:

1. **Requirement এ পড়া আর লেখার অনুপাত, আর বণ্টন।** "পড়া লেখার ৬০ গুণ, তাই push এর দিকে ঝোঁক। কিন্তু follower এর সংখ্যা power law, তাই লেজটা দেখি।"
2. **দুটো পথ, সংখ্যা দিয়ে।** Push এর লেখা (গড় আর সবচেয়ে খারাপ), pull এর পড়া (fetch আর tail)।
3. **Hybrid, আর তার আসল কারণ।** গড় না, spike: একটা post এর সবচেয়ে খারাপ খরচকে বাঁধা, আর fan-out এর queue কে আটকে না দেওয়া।
4. **খুঁটিনাটি যা senior আলাদা করে:** শুধু সক্রিয় follower কে push, timeline এ শুধু id, unfollow আর delete পড়ার সময় ছাঁকা, cursor pagination, hedged request, আর নিজের post সাথে সাথে দেখা।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Celebrity কে কীভাবে সামলাবে?"_ — Hybrid: সীমার উপরে pull, তাদের post একটা ছোট গরম cache এ (কয়েক হাজার account)। সংখ্যা: ১০ লাখের উপরে ২,১৭৮টা account, সব follow এর ৯%।
- _"Fan-out চলতে কতক্ষণ? ততক্ষণ কী হয়?"_ — একটা FIFO তে celebrity এর পেছনে সবাই আটকায় (p99 ১৪২ s)। Hybrid, বা অন্তত বড় আর ছোট job এর আলাদা queue।
- _"Unfollow করলে timeline থেকে মুছবে?"_ — না, পড়ার সময় ছাঁকো; cache এর সীমায় নিজে থেকে বেরিয়ে যায়। Delete একই।
- _"নিষ্ক্রিয় user এর timeline?"_ — রাখো না। ফিরলে একবার pull করে বানাও।
- _"Pagination?"_ — Cursor (id < শেষ দেখা)। Offset চলমান feed এ পুনরাবৃত্তি আর বাদ দেয় (৪১%, ১৮%)। Ranked feed এ session এর তালিকা একবার বানিয়ে রাখো।
- _"Feed server এর latency?"_ — Push এ একটা fetch। Pull এ K বাড়লে p99 সবচেয়ে ধীরটার, এমনকি p50 ও। K ছোট রাখো, hedge করো।

**Production এ বাস্তবে:** সবচেয়ে প্রচলিত ঘটনা: একটা বড় ঘটনার পরে (খেলা, নির্বাচন) celebrity দের post এ fan-out এর backlog আর সবার feed কয়েক মিনিট পুরনো; timeline cache হারানো (Redis এর failover) আর একসাথে লাখ লাখ timeline আবার বানানোর চাপ (11.3 এর reconnect storm এর মতো, database এর উপর); offset pagination এ "একই post দুবার" এর অভিযোগ; আর ranking এর feature store ধীর হলে পুরো feed ধীর, যেখানে একটা সময়ের ক্রমের fallback (10.3 এর degradation) বাঁচাতে পারত।

---

## ৩. Key Takeaway

- **Feed এর মূল প্রশ্ন: কখন জোড়া লাগাব — লেখায় (push) না পড়ায় (pull)।** পড়া লেখার ৬০ গুণ, তাই push এর দিকে ঝোঁক, কিন্তু উত্তর আসে বণ্টনের লেজ থেকে
- **Follower এর সংখ্যা power law, গড় মিথ্যা বলে:** গড় ২০০, মাঝের ৬২, সবচেয়ে বড় ১৫ কোটি; ০.০১% account এর কাছে সব follow এর ১৮%
- **Hybrid এর লাভ গড়ে না, spike এ:** গড় লেখা ৪৬k থেকে ৪২k, কিন্তু সবচেয়ে বড় post ৬ কোটি থেকে ৪ লাখ। Celebrity দের post একটা ছোট, গরম, local cache এ, তাই পড়ার দাম প্রায় নেই
- **এক queue তে বড় আর ছোট কাজ মেশালে ছোটরা মরে:** FIFO তে celebrity এর পেছনে ৩ লাখ post ৫ s এর বেশি আটকায় (p99 ১৪২ s)। আলাদা queue বা hybrid
- **অনেক জায়গা থেকে একসাথে আনলে লেজ গুণ হয়:** K = ২০০ আর ১% ধীরে ৮৭% পড়ায় একটা ধীর, pull এর p50 ই ৫২ ms। K ছোট রাখো; hedge (hybrid এ p99 ৫৩ → ১৪ ms)
- **চলমান feed এ offset ভুল দেখায়:** ৪১% session এ আগে দেখা post আবার, ১৮% এ একটা বাদ। Cursor এ শূন্য
- **শুধু সক্রিয়দের push, timeline এ শুধু id, unfollow আর delete পড়ার সময় ছাঁকা** — প্রতিটা একটা fan-out বাঁচায়

---

## ৪. নতুন Term (Glossary)

| Term                        | অর্থ                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fan-out on Write (Push)** | Post তৈরির সময় সেটা লেখকের প্রতিটা (সক্রিয়) follower এর timeline এ বসানো; পড়া সস্তা (একটা list), লেখা follower সংখ্যার সমান — celebrity তে একটা post এ কোটি লেখা         |
| **Fan-out on Read (Pull)**  | Post শুধু লেখকের list এ; পড়ার সময় সবার সাম্প্রতিক post এনে মেশানো — লেখা সস্তা, পড়া follow সংখ্যার সমান fetch, আর তার লেজ                                                |
| **Hybrid Fan-out**          | সীমার নিচের account push, উপরের (celebrity) pull, পড়ার সময় মেশানো — গড় খরচ প্রায় একই, কিন্তু একটা post এর সবচেয়ে খারাপ খরচ বাঁধা আর fan-out queue আটকায় না            |
| **Timeline Cache**          | প্রতিটা সক্রিয় user এর home timeline এর সীমিত (যেমন ৮০০) post id এর list, memory তে; শুধু id, লেখা আলাদা cache এ; নিষ্ক্রিয় user এর নেই, ফিরলে একবার pull করে বানানো      |
| **Tail Amplification**      | K টা অংশের উপর নির্ভর করা request এ অন্তত একটা ধীর হওয়ার সম্ভাবনা 1 − (1 − p)^K — একটা অংশের বিরল লেজ পুরো request এর সাধারণ অবস্থা হয়ে যায়                              |
| **Hedged Request**          | একটা অংশ নির্দিষ্ট সময়ে (স্বাভাবিকের p95 এর কাছে) উত্তর না দিলে একই অনুরোধ আরেকটা replica তে, যেটা আগে আসে সেটা — অল্প বাড়তি request এ p99 অনেক কমে, যদি K ছোট হয়        |
| **Candidate Generation**    | Ranked feed এর প্রথম ধাপ: হাজারো সম্ভাব্য post থেকে সস্তায় কয়েকশো প্রার্থী বাছা (timeline, celebrity, অন্য উৎস); তারপর feature আর model দিয়ে score, তারপর মিশ্রণের নিয়ম |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. একটা নতুন product: LinkedIn এর মতো professional network, যেখানে follow এর বদলে দুই দিকের "connection" (সর্বোচ্চ ৩০,০০০), আর কিছু "influencer" কে follow করা যায় (কয়েক কোটি follower পর্যন্ত)। Feed ranked, আর প্রতিটা post এ like আর comment দেখায়। (ক) এই lesson এর কোন সিদ্ধান্ত গুলো বদলায়, কোনগুলো একই থাকে? (খ) সীমা (push বনাম pull) কোথায় বসাবে, আর কেন সেটা Twitter এর থেকে আলাদা হতে পারে? (গ) একটা post এর like এর সংখ্যা সবার feed এ দেখানোর খরচ কোথায় লুকিয়ে আছে?

2. Timeline cache এর Redis cluster এর একটা shard হারাল (data সহ), আর তার উপর ছিল ৩ কোটি সক্রিয় user এর timeline। (ক) তাদের পরের feed পড়ায় কী হবে, আর database এর (post আর follow) উপর চাপ কত, ১.২ আর ১.৪ এর সংখ্যা দিয়ে? (খ) এটা 11.3 এর reconnect storm এর সাথে কোথায় মেলে? (গ) তিনটা উপায় যা এই ঘটনাকে নরম করবে।

3. একজন user অভিযোগ করল: "আমি post করলাম, আমার বন্ধু ৫ মিনিট ধরে দেখল না, অথচ অন্য একজনের post সাথে সাথে দেখল।" (ক) এই lesson এর কোন তিনটা কারণে এটা হতে পারে? (খ) প্রতিটার জন্য কোন metric দেখবে? (গ) এর মধ্যে কোনটা "ঠিক আচরণ" আর কোনটা bug?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) **একই থাকে:** hybrid এর মূল কাঠামো (influencer দের কয়েক কোটি follower, তাই তাদের post pull), timeline এ শুধু id, শুধু সক্রিয়দের push, cursor, ছাঁকা। **বদলায়:** (১) connection দুই দিকের আর সর্বোচ্চ ৩০,০০০, তাই সাধারণ সম্পর্কের লেজ ছোট আর বাঁধা — push এর সবচেয়ে খারাপ খরচ জানা; (২) feed ranked, তাই ১.৮ এর তিন ধাপ বাধ্যতামূলক, আর pagination session এর তালিকা দিয়ে; (৩) ranking এর জন্য প্রার্থী আরও বড় জায়গা থেকে (connection এর like আর comment করা post — "তোমার connection X এটা পছন্দ করেছে"), মানে আরেকটা fan-out: একটা like ও এখন একটা ঘটনা যা connection দের feed এ যেতে পারে।

(খ) Push এর সীমা দুটো আলাদা সম্পর্কে: connection (সর্বোচ্চ ৩০,০০০) সবসময় push করা যায় কারণ সবচেয়ে খারাপ খরচ বাঁধা; follow (influencer) এ Twitter এর মতো সীমা। আর ranked feed এ "নতুন post সাথে সাথে" কম জরুরি, তাই সীমা নিচে নামানো যায় (বেশি pull), কারণ ranking এর জন্য প্রার্থী এমনিতেই পড়ার সময় জোগাড় হয়, আর কয়েক সেকেন্ডের বাড়তি কাজ ranking এর কাজের তুলনায় ছোট।

(গ) Like এর সংখ্যা: প্রতিটা feed পড়ায় প্রতিটা post এর সংখ্যা দেখাতে হয়। একটা viral post কোটি feed এ, তাই তার counter একটা hot key (4.6) — পড়ায় আর লেখায় দুটোতেই। লেখায়: প্রতিটা like এ `UPDATE … SET likes = likes + 1` একটা row lock এর লড়াই (11.1 এর click counter এর মতো); তাই counter ভাগ করা (কয়েকটা sub-counter, যোগফল পড়ায়, 11.2 এর key splitting) বা event থেকে জমিয়ে গোনা। পড়ায়: সংখ্যাটা কয়েক সেকেন্ডের পুরনো হলে কেউ টের পায় না, তাই ছোট TTL এর cache আর local cache।

**প্রশ্ন ২:**

(ক) ৩ কোটি user এর timeline নেই। তারা পরের বার feed খুললে সিস্টেম "নিষ্ক্রিয় user ফিরল" এর পথ নেয়: pull করে বানানো, মানে প্রতিজনের জন্য ২০০ জনের সাম্প্রতিক post। ১.২ এ peak এ সেকেন্ডে ১,০৪,০০০ feed পড়া, তার ১০% এই shard এর (৩ কোটি / ৩০ কোটি) = ~১০,০০০ পড়া/s, প্রতিটা ২০০ fetch = **২০ লাখ fetch/s**, ঠিক ১.৪ এর pull এর সারির মতো, কিন্তু হঠাৎ, আগে থেকে প্রস্তুতি ছাড়া। আর বেশিরভাগ fetch author list এর cache এ গেলেও, miss গুলো post এর database এ।

(খ) একই আকার: একটা stateful অংশ হারাল, আর তার সব client একসাথে "আবার বানাও" চায়। 11.3 এ handshake, এখানে timeline rebuild। আর একই ঝুঁকি: rebuild এর চাপে database ধীর, ধীর database এ rebuild ব্যর্থ, ব্যর্থ rebuild আবার চেষ্টা — congestion collapse এর দিকে।

(গ) (১) **Rebuild এর হারে সীমা আর আংশিক উত্তর:** timeline না থাকলে প্রথম feed এ শুধু celebrity আর সবচেয়ে কাছের কয়েকজনের post দেখাও (সস্তা, ১০.৩ এর degradation), আর পুরো rebuild একটা queue তে, নিয়ন্ত্রিত হারে। (২) **Replica:** timeline cache এর shard এর একটা replica (Redis এর replication), যাতে একটা node হারালে data না হারায় — memory দ্বিগুণ, কিন্তু এই ঘটনা ঘণ্টার বদলে সেকেন্ডের। (৩) **Request coalescing আর author list এর cache গরম রাখা:** অনেক user একই author দের post চায়, তাই author list এর cache এর hit rate উঁচু রাখা আর একই author এর একসাথে আসা অনুরোধ একটায় মেশানো (4.6 এর stampede প্রতিরোধ)।

**প্রশ্ন ৩:**

(ক) (১) **Fan-out এর backlog:** লেখকের post push হচ্ছে, আর queue একটা celebrity এর job এর পেছনে আটকে আছে (১.৫, FIFO এ মিনিট)। অন্য যে post সাথে সাথে দেখা গেল সেটা হয়তো একজন celebrity এর (pull), যা queue তে যায়ই না। (২) **বন্ধু নিষ্ক্রিয় ছিল:** শুধু সক্রিয় follower দের push হয়; বন্ধু "নিষ্ক্রিয়" তালিকায় থাকলে তার timeline তৈরি হয়নি, আর প্রথম feed এ rebuild এর একটা অংশ পুরনো author list এর cache থেকে এসেছে। (৩) **Cache এর পুরনো অবস্থা:** feed এর পুরো page একটা ছোট session cache থেকে (ranked feed এ), বা বন্ধুর app pull-to-refresh না করে পুরনো page দেখাচ্ছে।

(খ) (১) Fan-out queue এর দৈর্ঘ্য আর সবচেয়ে পুরনো job এর বয়স (lag), queue ধরে; post থেকে শেষ timeline এ পৌঁছানোর p99। (২) "নিষ্ক্রিয়" হিসেবে বাদ পড়া follower এর হার, আর rebuild এর সংখ্যা। (৩) Feed এর response এ "কখন বানানো" এর timestamp, আর client এর refresh এর ঘটনা।

(গ) পাঁচ মিনিট এই নকশার প্রতিশ্রুতির (কয়েক সেকেন্ড) বাইরে, তাই (১) হলে এটা একটা **bug বা capacity এর সমস্যা** (queue ভাগ না করা)। (২) আংশিক ঠিক আচরণ, কিন্তু নিষ্ক্রিয় এর সংজ্ঞা যদি এত কড়া হয় যে প্রতিদিনের user বাদ পড়ে, তাহলে bug। (৩) client এর আচরণ, প্রায়ই product এর সিদ্ধান্ত (নতুন post এর বোতাম দেখানো উচিত ছিল)। আর "অন্যের post সাথে সাথে" এর অংশটা ঠিক আচরণ: hybrid এ celebrity এর post সবসময় সাথে সাথে, কারণ পড়ার সময় আনা হয়। এই অসমতা নকশার অংশ, আর product কে জানানো উচিত।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (তিনটা deterministic model আর একটা আসল Express + Zod hybrid feed service; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.4-news-feed/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.4-news-feed) — `npm install`, তারপর `npm run estimate`, `npm run fanout`, `npm run read`, `npm run smoke`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` follower এর power law বণ্টন (গড় ২০০ তে মেলানো) থেকে traffic আর push, pull আর hybrid এর লেখা, পড়া আর cache হিসাব করে। `fanout` ১০ মিনিটের fan-out queue চালায়, celebrity দের post সহ, তিনটা নীতিতে। `read` একটা feed পড়ায় K টা fetch এর tail (hedge সহ) আর চলমান feed এ offset বনাম cursor মাপে। `smoke` একটা আসল hybrid feed service চালিয়ে ১০টা ধাপ দেখায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, তোমার। **Follower এর বণ্টন একটা model** (α = ১.২, গড় ২০০, সর্বোচ্চ ১৫ কোটি), মাপা না; প্রতিটা account সমান হারে post করে বলে ধরা। Fan-out এর ক্ষমতা (২০ লাখ/s) আর fetch এর latency (median ২ ms, ১% এ ৫০ ms) ধরে নেওয়া। `smoke` এর store in-memory, ranking নেই। Twitter এর timeline এর নকশা (Redis এ ~৮০০ id, হাইব্রিড) আর Google এর "The Tail at Scale" এর কথা প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। **যা মাপা হয়নি:** আসল social graph, আসল Redis, ranking আর feature store, hydration এর খরচ, like/comment এর counter।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** `estimate` চালানোর **আগে** লিখে ফেলো: গড়ে ২০০ জন follow করলে মাঝের account এর কতজন follower? আর ১০ লাখের বেশি follower এর account কতগুলো? তারপর চালিয়ে মেলাও।

2. **সীমা খোঁজো:** `THRESHOLD` (fanout এ) আর hybrid এর সারি (estimate এ) দেখে এমন একটা সীমা বাছো যেখানে (ক) সবচেয়ে বড় push job fan-out এর ক্ষমতার এক সেকেন্ডের কম, আর (খ) celebrity দের সংখ্যা এত কম যে তাদের শেষ ১০০টা post (প্রতিটা ~১ KB) একটা feed server এর ১ GB memory তে ধরে। দুটো শর্ত কি একসাথে মেলে?

3. **Hedge এর দাম:** `read` এ `HEDGE_AFTER_MS=5` আর `HEDGE_AFTER_MS=20`। p99 কীভাবে বদলায়? প্রতিটায় মোটামুটি কত % fetch দ্বিগুণ হয় (fetch এর latency এর বণ্টন থেকে আন্দাজ করো)?

4. **Code বদলানো:** README এর experiment ৫ (সীমা পার হওয়া)। তারপর `src/feed.ts` এ "নিজের post সাথে সাথে দেখা" নিশ্চিত করো: লেখক নিজের feed পড়লে fan-out এর অপেক্ষা ছাড়াই তার নতুন post দেখাক। `smoke` এ একটা ধাপ যোগ করে দেখাও।

5. **Design অংশ:** এই feed এর "এক পাতার design doc", Lesson 1.2 এর পাঁচ ধাপে: (ক) requirement, পড়া:লেখা আর বণ্টন সহ; (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত; (গ) লেখা আর পড়ার পথের ছবি, hydration সহ; (ঘ) hybrid এর সীমা আর fan-out queue এর ভাগ, সংখ্যা সহ; (ঙ) timeline cache হারানোর runbook (reflection ২)।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ), 11.1 – 11.3
Current: 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style)
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ — URL shortener (11.1);
২ — rate limiter service (11.2); ৩ — chat (11.3)। Case study ৪ — news feed: ৫০ কোটি account, ৩০ কোটি DAU,
পড়া ১,০৪,০০০/s বনাম post ১,৭০০/s (peak)। Follower power law (গড় ২০০, মাঝের ৬২, সর্বোচ্চ ১৫ কোটি; ০.০১%
account এ সব follow এর ১৮%)। Hybrid: ১০ লাখের বেশি follower → pull (২,১৭৮টা account, তাদের post local
cache এ), বাকি push শুধু সক্রিয় follower কে; গড় লেখা প্রায় একই (৪৬k → ৪২k), কিন্তু সবচেয়ে বড় post ৬ কোটি → ৪ লাখ।
Fan-out queue দুই ভাগে (এক FIFO এ celebrity এর পেছনে ৩ লাখ post ৫ s+ আটকায়, p99 ১৪২ s)। Timeline cache: ৮০০ id,
শুধু id, সক্রিয় user, ৩.৮ TB। Unfollow/delete পড়ায় ছাঁকা। Pull এ tail amplification (K = ২০০, ১% ধীরে ৮৭% পড়ায়
একটা ধীর); hedge (hybrid p99 ৫৩ → ১৪ ms)। Cursor pagination (offset এ ৪১% পুনরাবৃত্তি, ১৮% বাদ)। Ranking: candidate
generation → scoring → মিশ্রণ, session এর তালিকা।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (বনাম Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 11.5 — Case Study: Design a Notification System
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **জোড়া লাগানোর কাজটা লেখায় করবে না পড়ায়, সেটা ঠিক করে বণ্টনের লেজ, গড় না।** পড়া বেশি বলে push স্বাভাবিক, কিন্তু power law এর লেজের কয়েক হাজার account একটা post এ কোটি লেখা চায় আর বাকি সবার queue আটকায়। Hybrid সেই লেজ কেটে দেয়, গড় না বদলে। আর পড়ার পথে একটা নিয়ম যা আরও অনেক জায়গায় ফিরবে: যত বেশি জায়গা থেকে একসাথে আনবে, তত বেশি তোমার p99 সবচেয়ে ধীর জায়গাটার।

রেডি হলে `next` লিখো — **Lesson 11.5: Design a Notification System** এ যাব। আজ বারবার "notification (11.5)" বলে পাশে রেখেছি: offline user কে জাগানো (11.3), নতুন post এর খবর, password reset এর email। প্রশ্নগুলো নতুন: একটা ঘটনা কোন channel এ যাবে (push, email, SMS), user এর পছন্দ আর রাতের নীরবতা কোথায় দেখা হয়, বাইরের provider (APNs, FCM, email এর service) ধীর বা বন্ধ হলে কী, একই notification দুবার না যায় কীভাবে, আর একটা "সবাইকে জানাও" campaign কীভাবে বাকি সব notification কে আটকে না দেয়।
