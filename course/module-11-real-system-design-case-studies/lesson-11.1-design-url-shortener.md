# Lesson 11.1 — Case Study: Design a URL Shortener

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 1.3):** এক দিনে মোটামুটি কত সেকেন্ড, আর হিসাব সহজ করতে কত ধরি? মাসে ১০ কোটি নতুন জিনিস তৈরি হলে সেকেন্ডে গড়ে কতটা? আজ এই একটা ভাগ থেকেই ঠিক হবে নকশার অর্ধেক: কোন অংশে sharding লাগবে, আর কোন অংশে লাগবেই না।

**Prerequisite:** Lesson 1.2 (Design framework), Lesson 1.3 (Estimation), Lesson 2.5 (API design, error contract), Lesson 4.2 (Cache-aside), Lesson 4.3 (LRU, TTL), Lesson 4.6 (Hot key), Lesson 5.4 (Index), Lesson 5.8 (Sharding), Lesson 7.6 (Batch vs stream), Lesson 9.5 (Rate limiting), Lesson 10.1 (Consistent hashing), Lesson 10.2 (Bloom filter, HyperLogLog), Lesson 10.5 (Security)

**আপনি এই lesson শেষে পারবেন:**

1. একটা অস্পষ্ট প্রশ্ন ("একটা URL shortener বানান") থেকে Lesson 1.2 এর পাঁচ ধাপ ধরে একটা নকশা দাঁড় করাতে পারবেন: requirement এর প্রশ্ন, সংখ্যা, API আর data model, high-level ছবি, আর দুটো deep dive। আর estimation দিয়ে দেখাতে পারবেন কোন যন্ত্র **লাগে না**: লেখার জন্য sharding, "code নেওয়া কিনা" এর জন্য Bloom filter, প্রতি link এ HyperLogLog
2. Short code বানানোর চারটা পথ (random, hash, counter, counter + গোপন permutation) সংখ্যা দিয়ে তুলনা করতে পারবেন: collision, database এ কতবার যেতে হয়, আর কেউ অনুমান করে অন্যের link খুঁজে পায় কিনা। Keyspace এর দৈর্ঘ্য কেন একটা সিদ্ধান্ত, আর birthday bound কেন hash এর পথ ভাঙে, সেটা বলতে পারবেন
3. Redirect এর পথটা নকশা করতে পারবেন: cache কত দেয় আর কোথায় থামে, hot key, আর কেন 301 সস্তা কিন্তু analytics আর link বন্ধ করা দুটোই ভাঙে। আর click এর analytics কে redirect এর পথ থেকে আলাদা রাখতে পারবেন

**Tier:** 1 — Runnable Code (তিনটা deterministic model আর একটা আসল Express + Zod shortener; Docker বা database লাগে না)

---

## ০. আজকের System

Module 10 পর্যন্ত প্রতিটা lesson এ TaskFlow এর একটা সমস্যা ছিল, আর lesson এর নাম বলে দিত কোন যন্ত্র লাগবে। Module 11 এ TaskFlow কে পাশে রাখছি। এখন থেকে প্রতিটা lesson একটা নতুন system, শূন্য থেকে, interview এর ঘরের মতো করে।

ধরুন আপনি একটা interview এর ঘরে। ৪৫ মিনিট। Interviewer বললেন:

> "একটা URL shortener design করুন। bit.ly এর মতো কিছু।"

আর কিছু না। এটাই প্রশ্ন।

সবচেয়ে পরিচিত প্রথম চাল হলো সাথে সাথে বোর্ডে লেখা: "লম্বা URL এর MD5 নেব, প্রথম ৭টা অক্ষর রাখব, database এ save করব।" দুই মিনিটে একটা নকশা। তারপর interviewer এর প্রশ্নগুলো আসতে শুরু করে, আর প্রতিটা আগের উত্তরের একটা ফাটল খোলে:

- "দুটো আলাদা URL এর hash এর প্রথম ৭ অক্ষর এক হলে?"
- "দিনে কতগুলো link? কত বছর রাখবেন? ৭ অক্ষর কত দিন চলবে?"
- "301 দেবেন না 302? কেন?"
- "কেউ `abc1234`, `abc1235`, `abc1236` চেষ্টা করে অন্যদের link পড়তে পারবে?"
- "একটা link এ হঠাৎ সেকেন্ডে ৫০,০০০ click এলে?"
- "একটা phishing link এর report এলো। বন্ধ করলে কি সত্যিই বন্ধ হবে?"

URL shortener interview এর সবচেয়ে প্রচলিত প্রশ্নগুলোর একটা, কারণ দেখতে খুব সহজ। দুটো endpoint, একটা table। কিন্তু প্রায় প্রতিটা সিদ্ধান্তের পেছনে একটা সংখ্যা আছে, আর বেশিরভাগ candidate সেই সংখ্যাটা না দেখে সিদ্ধান্ত নেয়। আজ আমরা উল্টো দিক থেকে যাব: আগে সংখ্যা, তারপর সিদ্ধান্ত। আর একটা জিনিস লক্ষ্য রাখব যা Module 10 এর exit challenge এ বলা হয়েছিল: আগের module গুলোর অনেক যন্ত্রের নাম এখানে মনে আসবে (Bloom filter, HyperLogLog, consistent hashing, sharding)। কোনটা সত্যিই বসবে, আর কোনটা আসলে লাগবেই না, সেটা সংখ্যা ঠিক করবে।

---

## ১. Theory

### ১.১ Step 1 — Requirement: প্রশ্ন দিয়ে শুরু

1.2 এর প্রথম ধাপ: scope ঠিক করা। Interviewer কে এই প্রশ্নগুলো করুন, আর উত্তর না পেলে নিজে একটা যুক্তিসঙ্গত ধারণা বলে লিখে ফেলুন:

```
প্রশ্ন                                      ধরে নিলাম (এই lesson এ)
কত নতুন link?                               মাসে ১০ কোটি
পড়া আর লেখার অনুপাত?                        ১০০ : ১ (একটা link গড়ে ১০০ বার click)
কত দিন রাখব?                                ১০ বছর (মেয়াদ না দিলে "চিরকাল")
Custom alias (sho.rt/launch-2026)?          হ্যাঁ, ঐচ্ছিক
মেয়াদ (expiry)?                              হ্যাঁ, ঐচ্ছিক
Analytics?                                  link এর মালিক click আর unique visitor দেখবে; real-time না, কয়েক মিনিট দেরি চলবে
Link পরে বদলানো বা বন্ধ করা?                বন্ধ করা হ্যাঁ (abuse); গন্তব্য বদলানো আজ না
User account?                               আছে বলে ধরি, কিন্তু login আজকের scope এর বাইরে
```

**Functional requirement:** (১) লম্বা URL দিলে একটা ছোট URL পাওয়া, (২) ছোট URL এ গেলে আসল URL এ redirect, (৩) ঐচ্ছিক alias আর মেয়াদ, (৪) link বন্ধ করা, (৫) মালিকের জন্য click এর হিসাব।

**Non-functional requirement:** এখানেই আসল নকশা লুকিয়ে থাকে।

- **Redirect দ্রুত।** User একটা link এ click করেছে, তার আর আমাদের মাঝে যত ms, সব বাড়তি। Server এর ভেতরে p99 কয়েক ms এর লক্ষ্য।
- **Redirect প্রায় কখনো বন্ধ না।** একটা shortener বন্ধ মানে কোটি কোটি link একসাথে ভাঙা, যেগুলো বই, পোস্টার, QR code এ ছাপা। তুলনায় link **তৈরি** কয়েক মিনিট বন্ধ থাকলে ক্ষতি কম। তাই দুটো পথের SLO আলাদা (1.5)।
- **Link কখনো হারায় না।** একবার দেওয়া code দশ বছর পরেও একই জায়গায় যাবে।
- **Code অনুমান করা যাবে না।** মানুষ shortener এ private জিনিসের link রাখে (Google Doc, invoice, meeting)। কেউ code গুনে গুনে সেগুলো খুঁজে পেলে সেটা data এর ফাঁস।
- **Code ছোট।** নামটাই shortener।

**বাদ দিলাম:** login, billing, QR code, link এর preview page, গন্তব্য বদলানো। এক লাইনে বলে দেওয়া, যাতে বাকি সময় মূল জিনিসে যায়।

### ১.২ Step 2 — Estimation: সংখ্যা কী বলে

**Spaced repetition এর উত্তর:** এক দিন ৮৬,৪০০ সেকেন্ড, হিসাবের সুবিধায় ~১ লাখ। এক মাস ~২৬ লাখ সেকেন্ড। মাসে ১০ কোটি মানে সেকেন্ডে ~৩৯টা।

`npm run estimate`:

```
── Part A — traffic: 100 million new links a month, read:write = 100:1, peak 3× the average ──
                                              average     peak
new links (writes) / s                      38.6           116
redirects (reads) / s                      3,858        11,574
redirect bandwidth                      1.9 MB/s      5.8 MB/s
click events / month                    10 billion      1.0 TB

── Part B — storage: 10 years, 500 B per row ──
one year                               1.2 billion      600 GB
10 years                                12 billion      6.0 TB
```

এই কয়েকটা সংখ্যা থেকে চারটা সিদ্ধান্ত আসে, আর তার কয়েকটা "না":

1. **লেখা সামান্য।** Peak এ সেকেন্ডে ১১৬টা insert। একটা সাধারণ Postgres primary এর আনুমানিক ক্ষমতার (ধরুন সেকেন্ডে কয়েক হাজার ছোট insert) ২-৩%। তাই **লেখা scale করার জন্য sharding লাগে না।** এটা প্রথম "না"।
2. **পড়া আসল চাপ, আর সেটা একই কয়েকটা জিনিস বারবার পড়া।** Peak এ সেকেন্ডে ~১১,৬০০ redirect। Database কে প্রতিটা দেওয়া যায়, কিন্তু দরকার নেই: একই জনপ্রিয় link বারবার আসে। এটা cache এর কাজ (১.৬)।
3. **Storage দশ বছরে ~৬ TB।** একটা node এ রাখা যায়, কিন্তু আরাম করে না: backup থেকে ৬ TB restore করতে ~৬.৭ ঘণ্টা (10.8 এর RTO মনে করুন)। তাই পরে partition বা shard আসতে পারে, **কিন্তু কারণ storage আর recovery, লেখা না।** আর সেটা প্রথম দিনে না, বছর তিনেক পরে।
4. **Click এর data link এর data এর চেয়ে অনেক বড়।** মাসে ১,০০০ কোটি event, ~১ TB। ছয় মাসেই link এর পুরো ১০ বছরের table (~৬ TB) কে ছাড়িয়ে যায়। এটা একটা আলাদা system (১.৭), redirect এর database এর ভেতরে না।

এবার keyspace। **Keyspace** — code এর জন্য সম্ভাব্য সব মানের সংখ্যা; ৬২টা অক্ষর আর L দৈর্ঘ্য হলে ৬২^L। আর **Base62 Encoding** — একটা সংখ্যাকে ৬২টা অক্ষরে (`0-9`, `a-z`, `A-Z`) লেখা, ঠিক যেমন দশমিকে ১০টা অক্ষরে লিখি। URL এ বিশেষ অর্থ আছে এমন কোনো অক্ষর (`/`, `+`, `=`) নেই, তাই base64 এর চেয়ে নিরাপদ।

```
── Part C — keyspace: base62, 1.2 billion new codes a year ──
length         total codes   years to fill  full in 10 yrs       random: retry    guess hits
5              916 million        9 months          100.0%                full          100%
6             56.8 billion              47           21.1%               21.1%         21.1%
7            3.52 trillion           2,935          0.341%              0.341%        0.341%
8             218 trillion         181,950          0.005%              0.005%        0.005%
```

৫ অক্ষর নয় মাসে শেষ। ৬ অক্ষর ৪৭ বছর চলে, তাই অনেকে বলে "৬ যথেষ্ট"। কিন্তু শেষ দুটো কলাম দেখুন। দশ বছরে ২১% ভরা মানে: (ক) random code বানালে প্রতি পাঁচটায় একটা আগে থেকে নেওয়া, আর (খ) কেউ একটা random ৬ অক্ষরের code বানিয়ে চেষ্টা করলে **প্রতি পাঁচটায় একটা কারো আসল link**। ৭ অক্ষরে দুটোই ০.৩৪%। একটা বাড়তি অক্ষর ৬২ গুণ জায়গা কেনে। কোথায় কাজে লাগে, সেটা ১.৫ এ।

আর একটা তালিকা, যন্ত্রগুলোর দাম এই মাপে:

```
── Part D — the tools that come to mind, and their price at this size ──
Bloom filter, all 12 billion codes, 1% error               14.4 GB
HyperLogLog (dense, 12 KB) per link                          147 TB
Sharding: peak writes / one primary                           2.3%
```

এই তিনটা সারি পরের অংশগুলোতে ফিরে আসবে।

### ১.৩ API আর data model

**API** (2.5 এর error contract সহ):

```
POST /api/links          { url, alias?, expiresAt? }
                         → 201 { code, shortUrl, url, expiresAt }
                         → 400 invalid_body | unsupported_scheme | self_redirect | alias_reserved | expiry_in_past
                         → 409 alias_taken
GET  /:code              → 302 Location: <url>      (Cache-Control: private, no-store)
                         → 404 not_found  |  410 expired | disabled
GET  /api/links/:code/stats         → 200 { clicks, uniqueVisitors }
POST /api/links/:code/disable       → 204
```

দুটো জিনিস লক্ষ্য করুন। মেয়াদ শেষ আর বন্ধ করা link এ **410 Gone**, 404 না: "এটা ছিল, এখন নেই" আর "এটা কখনো ছিল না" আলাদা কথা, আর search engine আর client দুটোকে আলাদা ভাবে ব্যবহার করে। আর redirect এ 302, 301 না। কেন, সেটা ১.৬ এ, সংখ্যা দিয়ে।

**Data model** (Postgres):

```sql
CREATE TABLE links (
  code        varchar(32) PRIMARY KEY,
  long_url    text        NOT NULL,
  owner_id    bigint,
  custom      boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  disabled_at timestamptz,
  disabled_reason text
);
CREATE INDEX links_owner_created ON links (owner_id, created_at DESC);
CREATE SEQUENCE link_ids;
```

Redirect এর পথে একটাই query: `code` দিয়ে primary key lookup (5.4 এর index, একটা B-tree এর কয়েকটা page)। মালিকের "আমার link গুলো" page এর জন্য `owner_id` এর index। Click গুলো এই table এ **নেই**। `UPDATE links SET clicks = clicks + 1` প্রতিটা redirect এ মানে প্রতিটা পড়া একটা লেখা হয়ে যাওয়া: জনপ্রিয় link এর row এ lock এর লড়াই (5.5), আর ১১৬ লেখা/s এর database এ হঠাৎ ১১,৬০০ লেখা/s। পড়ার পথকে লেখার পথ বানানো এই নকশার সবচেয়ে সাধারণ ভুল।

### ১.৪ Step 3 — High-level design

```
                      ┌─────────────────────────── redirect এর পথ (৯৯%, SLO কড়া) ───────────────────────────┐
  browser ── GET /aB3xY9k ──► [LB] ──► [redirect service × N] ──► [Redis cache] ──miss──► [Postgres replica]
                                              │  stateless, local LRU                          ▲
                                              │                                                 │ replication
                                              └── click event (fire-and-forget) ──► [queue / log] ──► [analytics: batch বা stream]
                                                                                                │
  app/API ── POST /api/links ──► [LB] ──► [API service × M] ──► [range allocator] ──► [Postgres primary]
                      └──────────────────────────── লেখার পথ (১%, SLO নরম) ────────────────────────────┘
```

- **দুটো পথ, দুটো deployment।** একই codebase হতে পারে (9.1 এর modular monolith), কিন্তু redirect আর API আলাদা চলে: আলাদা scale, আলাদা SLO, আর API এর একটা খারাপ deploy redirect কে ছোঁয় না (10.3 এর blast radius)।
- **Redirect service stateless** (1.6)। প্রতিটা instance এর একটা ছোট local cache, পেছনে শেয়ার করা Redis, পেছনে Postgres এর read replica।
- **Click এর event redirect এর জন্য অপেক্ষা করে না।** Redirect উত্তর দেয়, event একটা buffer বা queue তে যায় (7.1)। Analytics ধীর বা বন্ধ হলে redirect চলতে থাকে, কারণ analytics এখানে একটা soft dependency (10.3)।
- **লেখার পথে range allocator** code বানায় (১.৫)।

এই ছবিতে consistent hashing কোথায়? শুধু Redis cluster এর ভেতরে (10.1 এর hash slot), যেটা আমরা নিজে লিখি না। Database এর জন্য না, কারণ database একটা।

### ১.৫ Deep dive ১ — Short code কীভাবে বানাব

এটাই এই system এর আসল engineering প্রশ্ন, আর 1.2 এর reflection এ ঠিক এটাকেই deep dive এর জায়গা বলা হয়েছিল। চারটা পথ, `npm run keygen` দিয়ে মাপা। Keyspace ছোট করে চালানো হয়েছে (৪ অক্ষর, ১.৪৮ কোটি ঘর), কারণ retry আর collision নির্ভর করে শুধু **কতটা ভরা** তার উপর, আর "০.৩৪১% ভরা" ঠিক ৭ অক্ষরে দশ বছরের সমান।

**পথ ১ — Random code, তারপর "নেওয়া কিনা" দেখা।** ৭টা random অক্ষর, `INSERT ... ON CONFLICT DO NOTHING`, নেওয়া হলে আবার।

```
full        avg attempts  needed retry   max attempts  when at 6 chars  when at 7 chars
0.341%          1.0035        0.35%              2     1.9 months     10.0 years
21.1%           1.2693       21.28%              8     10.0 years      619 years
50.0%           2.0032       50.15%             18     23.7 years    1,467 years
90.0%          10.0904       90.13%            120     42.6 years    2,641 years
```

Retry এর হার ঠিক যতটা ভরা, তত। ৭ অক্ষরে দশ বছরে ০.৩৫%: প্রতি ২৮৫টা link এ একটা বাড়তি round trip। নগণ্য। ৬ অক্ষরে দশ বছরে প্রতি পাঁচটায় একটা, আর সময়ের সাথে বাড়তেই থাকে। ৯০% এ গড়ে ১০টা চেষ্টা, সবচেয়ে খারাপ ১২০টা। Random এর পথে কোনো coordination নেই (প্রতিটা server নিজে বানায়), আর code অনুমান করা যায় না। দাম: প্রতিটা তৈরিতে "নেওয়া কিনা" এর একটা প্রশ্ন, যেটা database এর unique constraint নিজেই সামলায়।

এখানে প্রথম Bloom filter এর চিন্তা আসে: "database এ যাওয়ার আগে Bloom filter এ দেখি code নেওয়া কিনা।" কিন্তু ১,২০০ কোটি code এর জন্য ১% ভুলে **১৪.৪ GB**, সব server এ, সবসময় নতুন code দিয়ে update রাখা। বাঁচায় কী? ৯৯.৬৫% insert প্রথমবারেই সফল, তাই Bloom filter শুধু ০.৩৫% এর একটা round trip বাঁচাত। আর "নেই" বললেও আমাদের insert করতেই হবে, তাই database এর কাজ কমে না। **দ্বিতীয় "না"।**

**পথ ২ — URL এর hash, প্রথম ৭ অক্ষর।** আকর্ষণীয়, কারণ একই URL সবসময় একই code পায়, আর কোনো lookup ছাড়া dedupe হয়। কিন্তু আলাদা URL এর hash এর প্রথম ৭ অক্ষর মিলতে পারে:

```
full              link     collisions  % insert  birthday estimate  avg attempts
0.341%          50,388             97    0.193%               86      1.0019
10.0%        1,477,634         73,894    5.001%           73,882      1.0536
21.1%        3,117,807        329,366   10.564%          328,929      1.1234
At 7 chars in 10 years (12,008,705,807 links): an estimated 20,474,843 links will hit a collision.
```

**Birthday Bound** — N টা জিনিস এলোমেলো ভাবে K টা ঘরে ফেললে মোটামুটি N²/2K জোড়া একই ঘরে পড়ে। নামটা আসে "২৩ জনের একটা ঘরে দুজনের জন্মদিন এক হওয়ার সম্ভাবনা ৫০% এর বেশি" থেকে। ভাবনার চেয়ে অনেক আগে collision শুরু হয়। মাপা সংখ্যা আন্দাজের সাথে প্রায় হুবহু মেলে (৩,২৯,৩৬৬ বনাম ৩,২৮,৯২৯)। ৭ অক্ষরে দশ বছরে **~২ কোটি** link এ collision।

তাহলে collision সামলাতে কী করবেন? URL এর সাথে একটা salt যোগ করে আবার hash। এখন hash এর পথের একমাত্র সুবিধা, "একই URL → একই code", ভেঙে গেল: কোন URL এর code salt সহ, সেটা database এ না দেখে জানা যায় না। আর প্রতিটা insert এর আগে "এই code কি অন্য URL এর?" দেখতে হয়, ঠিক random এর মতো। আরও দুটো সমস্যা: যে কেউ একটা URL এর hash হিসাব করে জানতে পারে কেউ সেটা ছোট করেছে কিনা (একটা private document এর URL জানলে)। আর দুজন আলাদা user একই URL দিলে একই code পায়, তাই আলাদা analytics বা আলাদা মেয়াদ দেওয়া যায় না। **Hash এর পথ random এর সব দাম দেয়, আর তার সুবিধাটা দিতে পারে না।**

**পথ ৩ — Counter + base62।** একটা বাড়তে থাকা সংখ্যা (Postgres এর `SEQUENCE`), base62 এ লেখা। কোনো collision নেই, প্রতিটা তৈরিতে একবারই, আর code সবচেয়ে ছোট (১,২০০ কোটিতে মাত্র ৬ অক্ষর)। কিন্তু:

```
── Part C — finding by guessing: 0.341% full, the 10,000 codes before your own and 10,000 random attempts ──
strategy                                                      last 5 codes      hits before    hits random
counter → base62                                  0d6C 0d6D 0d6E 0d6F 0d6G          100.00%          0.34%
random                                            DB0u rO8O ypzM aKdZ fKLX            0.32%          0.44%
counter → secret permutation → base62             f6sF 5OVy JR1Y iGCX HIx8            0.43%          0.27%
```

**Link Enumeration** — code গুনে গুনে বা অনুমান করে অন্যদের link খুঁজে বের করা। Counter এ নিজের একটা link বানান, পেছনে গুনুন: **১০০%** আসল link, অন্যদের সদ্য বানানো private document সহ। এটা তাত্ত্বিক না: ২০১৬ এর একটা গবেষণা ("Gone in Six Characters: Short URLs Considered Harmful for Cloud Services") জনপ্রিয় shortener এর ছোট code এর জায়গা scan করে cloud storage এর share link আর map এর ঠিকানা সহ ব্যক্তিগত তথ্য খুঁজে পেয়েছিল, কারণ তখনকার code ছিল মাত্র ৫-৬ অক্ষরের। Counter আরেকটা জিনিসও ফাঁস করে: আপনার ব্যবসার আকার। দুটো code এর পার্থক্য দেখে যে কেউ বলতে পারে আপনি দিনে কতগুলো link বানান।

**পথ ৪ — Counter + গোপন permutation + base62।** Counter এর সব সুবিধা রেখে ক্রমটা লুকানো। Counter এর সংখ্যাকে একটা **গোপন, এক-এক (bijective) permutation** এর ভেতর দিয়ে পাঠান, যা [০, ৬২^৭) এর প্রতিটা সংখ্যাকে ওই একই পরিসরের একটা আলাদা সংখ্যায় নেয়। এক-এক, তাই collision অসম্ভব। গোপন key ছাড়া উল্টানো যায় না, তাই পরপর id এর code এলোমেলো দেখায়।

**Format-Preserving Permutation** — একটা নির্দিষ্ট পরিসরের ভেতরে এক-এক, key দেওয়া রূপান্তর, যাতে output ইনপুটের মতোই একই পরিসরে থাকে (এখানে ৭ অক্ষরের base62)। Exercise এ এটা একটা ছোট **Feistel network** দিয়ে বানানো: সংখ্যাকে দুই ভাগ করে কয়েকটা round এ একটা ভাগকে অন্য ভাগের keyed hash দিয়ে XOR করা। Feistel এর গঠনই এটাকে এক-এক রাখে, hash function যাই হোক। ৬২^৭ দুইয়ের ঘাত না, তাই ফল পরিসরের বাইরে গেলে আবার চালানো হয় (**cycle walking**), যতক্ষণ না ভেতরে আসে:

```
whole 3-char domain (238,328 ids): 238,328 distinct outputs — no collisions; extra rounds: 23,816 (10.0%)
7 chars, ids 1–5:  0000001 → cOoEtMq   0000002 → BnqHDLC   0000003 → yhc3OjR   0000004 → NJcTAiA   0000005 → l3tBYTa
```

ছোট domain এ প্রতিটা id চালিয়ে যাচাই করা: ২,৩৮,৩২৮টা id, ২,৩৮,৩২৮টা আলাদা code। আর অনুমানের পরীক্ষায় random এর মতো (০.৪৩%, ভরার হারের কাছে)। একটা সৎ সতর্কতা: এটা **গোপনতা না, শুধু অনুমান কঠিন করা।** ৪ round এর এই Feistel একটা প্রমাণিত cipher না, আর key ফাঁস হলে পুরো ক্রম উল্টানো যায়। সত্যিকারের private link এর উত্তর authentication (10.5), code এর আড়াল না। Production এ এই কাজের জন্য প্রমাণিত format-preserving encryption (যেমন NIST এর FF1) বা অন্তত একটা ভালো block cipher এর উপর cycle walking ব্যবহার করা উচিত।

**Counter কে ভাগ করা।** একটা counter মানে প্রতিটা তৈরিতে counter এর কাছে যাওয়া, আর counter একটা single point। **Range Allocation (Ticket Server)** — প্রতিটা app server counter থেকে একবারে একটা block নেয় (ধরুন ১,০০০টা id), তারপর সেগুলো নিজের memory থেকে দেয়; শেষ হলে আরেকটা block। "Ticket server" নামটা Flickr এর একটা প্রকাশিত নকশা থেকে, যেখানে একটা আলাদা ছোট database এর একমাত্র কাজ ছিল id দেওয়া। একবারে একটা block নেওয়া তার উপরে একটা পুরনো, প্রচলিত উন্নতি (ORM এর জগতে এর নাম hi/lo)।

```
── Part D — sharing out the counter: 20 app servers, 3,333,333 links a day, each server restarts 1× a day ──
block     sequence calls / day  wasted ids / day  wasted / year, 7 chars  out of time order
1                   3,333,333               0                0.00000%              0.0%
1,000                   3,354          10,161                0.00011%             47.5%
10,000                    353          99,804                0.00103%             47.5%
```

Block ১,০০০ এ counter এর কাছে যাওয়া হাজার গুণ কম। দাম দুটো। (১) Server restart হলে তার block এর বাকি id হারায়: দিনে ~১০,০০০, বছরে keyspace এর ০.০০০১১%। নগণ্য, আর হারানো id কখনো ব্যবহার হয় না, তাই নিরাপদ। (২) id আর সময়ের ক্রমে থাকে না (৪৭.৫% ক্ষেত্রে পরের link এর id ছোট), তাই "নতুন link আগে" সাজাতে `created_at` লাগবে, code না। Permutation এর পরে ক্রম এমনিতেই নেই।

সৎ কথা: peak এ ১১৬ link/s এ Postgres এর `nextval()` সরাসরি ডাকলেও কোনো সমস্যা নেই। Range allocation দরকার হয় যখন counter একটা আলাদা service, বা একাধিক region (10.8) এ link বানাতে হয় (প্রতিটা region কে একটা বড় range দিন, তারা কখনো ধাক্কা খায় না)। Interview এ এটা বলা, আর বলা যে আজকের সংখ্যায় এটা ঐচ্ছিক, দুটোই senior এর লক্ষণ।

> **Trade-off Table — short code এর চার পথ**

| পথ                         | Collision                          | তৈরিতে database এ   | একই URL → একই code | অনুমান করা যায়?               | Coordination                 |
| -------------------------- | ---------------------------------- | ------------------- | ------------------ | ------------------------------ | ---------------------------- |
| Random + check             | ভরার হারে (৭ অক্ষরে ১০ বছরে ০.৩৫%) | ~১.০০৩৫ চেষ্টা      | না                 | না (ভরার হার)                  | নেই                          |
| Hash (MD5) এর প্রথম ৭      | Birthday (১০ বছরে ~২ কোটি)         | check + salt এ আবার | Collision পর্যন্ত  | না, কিন্তু URL থেকে হিসাবযোগ্য | নেই                          |
| Counter + base62           | কখনো না                            | ১ (block এ ১/১০০০)  | না                 | **হ্যাঁ, ১০০%**                | Counter (block দিয়ে সস্তা)  |
| Counter + গোপন permutation | কখনো না (এক-এক)                    | ১ (block এ ১/১০০০)  | না                 | না (ভরার হার), key গোপন থাকলে  | Counter + key এর ব্যবস্থাপনা |

**এই নকশার পছন্দ: counter (range allocation) + গোপন permutation, ৭ অক্ষর।** Random + check ও সম্পূর্ণ ঠিক উত্তর, আর অনেক জায়গায় সরলতার জন্য সেটাই ভালো: ৭ অক্ষরে retry নগণ্য, আর কোনো key রাখতে হয় না। Hash এর পথ শুধু তখন, যখন dedupe নিজেই requirement আর collision সামলানোর জটিলতা গ্রহণযোগ্য।

**Custom alias আর generated code এর ধাক্কা।** একটা সূক্ষ্ম ফাঁদ: কেউ alias হিসেবে `abcDEF1` চাইল, যেটা ৭ অক্ষরের base62। আজ সেটা খালি। কিন্তু কোনো একদিন permutation ঠিক ওই code টা বানাবে, আর insert ব্যর্থ হবে। Exercise এর app এ তাই ৭ অক্ষরের base62 alias নিষিদ্ধ (`alias_reserved`), আর alias এ `-` বা `_` রাখা যায়, যা generated code এ কখনো থাকে না। দুটো namespace আলাদা, ধাক্কা অসম্ভব। (Generator এর loop এ `taken` হলে পরের id নেওয়ার ব্যবস্থাও রাখা, শুধু নিরাপত্তার জাল হিসেবে।)

### ১.৬ Deep dive ২ — Redirect এর পথ

Redirect প্রতি সেকেন্ডে ~১১,৬০০ বার, আর প্রায় সব একটা primary key lookup। প্রশ্ন দুটো: কতটা cache, আর browser কে কী বলব।

**Cache কতটা দেয়।** `npm run redirect` অংশ ক: ২০ লাখ link, ৬০ লাখ redirect, জনপ্রিয়তা Zipf (s = ১, কয়েকটা link খুব জনপ্রিয়, বেশিরভাগ প্রায় কেউ খোলে না), LRU (4.3):

```
cache                                          entry   hit rate  DB reads/s (peak 11,574)  memory, at 1 billion links
shared cache (Redis), 0.1% of links            2,000      43.1%                     6,591                  250 MB
shared cache (Redis), 1% of links             20,000      60.4%                     4,578                  2.5 GB
shared cache (Redis), 5% of links            100,000      73.2%                     3,100                 12.5 GB
shared cache (Redis), 20% of links           400,000      84.8%                     1,757                 50.0 GB
local 0.1% on each app server (10)             2,000      43.1%                     6,590             250 MB × 10
```

- **প্রথম ০.১% link এ ৪৩% traffic।** তারপর প্রতিটা বাড়তি GB কম কেনে: ১% থেকে ২০% এ, ২০ গুণ memory, hit rate ৬০ থেকে ৮৫%। এটা জনপ্রিয়তার লম্বা লেজ: বেশিরভাগ link মাসে একবারও খোলে না, আর তাদের cache এ রাখা মানে memory তে রাখা যা কেউ পড়বে না।
- **৮৫% hit এও database এ ~১,৮০০ পড়া/s।** একটা primary key lookup এর জন্য একটা বা দুটো read replica যথেষ্ট (5.7)। মানে cache এর কাজ database কে বাঁচানো না, latency কমানো আর spike শোষণ করা। লক্ষ্য hit rate তাই "সবচেয়ে বেশি" না, "database আরামে থাকে আর p99 মেলে"।
- **Zipf এর s আসল সংখ্যা ঠিক করে।** Experiment ১: s = ১.২ হলে ১% cache এ ৮৯%। আর আসল shortener এ একটা নতুন link এর বেশিরভাগ click প্রথম কয়েক দিনে আসে, যা এই model এ নেই, তাই আসল hit rate সম্ভবত বেশি। Cache এর মাপ নিজের traffic মেপে ঠিক করুন, অনুমানে না।
- **Local cache একই memory তে বেশি দেয় না** (দশটা server এ ১০ গুণ memory, একই ৪৩%)। কিন্তু অন্য একটা জিনিস দেয়, নিচে।

**Hot key।** সবচেয়ে জনপ্রিয় link সব redirect এর ৬.৬%, peak এ ~৭৭০/s। সব একটা Redis node এ, কারণ key একটাই (10.1: consistent hashing একটা key কে একটা জায়গায় পাঠায়, ভাগ করে না)। এখনো ঠিক আছে। কিন্তু একটা link viral হলে, ধরুন সেকেন্ডে ৫০,০০০, সব একটা node এ, আর সেই node এর বাকি key গুলোও ধীর হয় (4.6)। উত্তর: redirect service এর **local cache**, কয়েক সেকেন্ডের TTL সহ। দশটা server এ প্রতিটায় ৫,০০০/s, Redis এ প্রায় শূন্য। Link এর গন্তব্য বদলায় না (আজকের scope এ), তাই local cache এর পুরনো data এর ঝুঁকি শুধু "বন্ধ করা link কয়েক সেকেন্ড বেশি চলে"। গ্রহণযোগ্য। দুই স্তর: local LRU (ছোট, hot key এর জন্য) → Redis (বড়, লেজের জন্য) → replica।

**না থাকা code।** কেউ code scan করলে (link enumeration) প্রায় সব request এর উত্তর "নেই", আর cache এ কিছু থাকে না, তাই সব database এ যায়: 10.2 এর cache penetration। এখানে আবার Bloom filter এর কথা মনে আসে, ১৪.৪ GB। সস্তা স্তরগুলো আগে: (১) negative cache (৪০৪ এর উত্তর ছোট TTL এ cache), (২) IP আর ASN ধরে ৪০৪ এর হারের উপর rate limit (9.5), কারণ সাধারণ user প্রায় কখনো ৪০৪ পায় না, আর একটা scanner এর প্রায় সব ৪০৪। আর permutation এর জন্য scan এর ফলও তেমন কিছু দেয় না। Bloom filter তখনই যখন এগুলো যথেষ্ট না প্রমাণিত হয়।

**301 না 302।** **301 / 302 Redirect** — দুটোই browser কে `Location` header এর ঠিকানায় পাঠায়। 301 মানে "স্থায়ীভাবে সরে গেছে": browser এটা cache করতে পারে আর পরের বার server কে জিজ্ঞেস না করেই সরাসরি গন্তব্যে যায়। 302 মানে "আপাতত": প্রতিবার server কে জিজ্ঞেস করে (যদি না `Cache-Control` অন্য কিছু বলে)। 301 এর লোভ: server এর load কমে। অংশ খ: ১ লাখ মানুষ একটা link এ click করে, গড়ে আরও দুবার ফেরে, ৮৫% browser cache রাখে, আর সপ্তম দিনে link টা phishing বলে বন্ধ করা হলো:

```
policy                                   click   server saw  not in analytics  clicks after off  still reached dest
301 (permanent, browser remembers)       300,664        43.2%            56.8%          189,422             62.6%
302 + Cache-Control: max-age=3600      300,664        97.7%             2.3%          189,422              2.3%
302 + Cache-Control: private, no-store      300,664       100.0%             0.0%          189,422              0.0%
```

301 server এর load অর্ধেকের বেশি কমায়। কিন্তু তার দাম দুটো, আর দুটোই এই product এর মূলে:

1. **Analytics অর্ধেক অন্ধ।** ৫৭% click কখনো server এ আসে না। Product এর একটা প্রধান feature ("আমার link এ কতজন click করল") মিথ্যা সংখ্যা দেখায়, আর কম দেখায় ঠিক যাদের link বেশি ফিরে আসা মানুষ খোলে।
2. **Link বন্ধ করা যায় না।** বন্ধ করার পরে **৬৩%** click তবুও phishing site এ গেল, browser এর memory থেকে। Server জানেও না। আর সেটা ফেরানোর কোনো উপায় নেই: browser এর cache আপনার হাতে না। Experiment ২ এ (সবাই cache রাখে, গড়ে পাঁচবার ফেরে, link-in-bio বা QR code এর মতো) ৮৯%।

তাই **302 + `Cache-Control: private, no-store`।** Server এর load এর দাম আমরা cache এ দিয়েছি (উপরে), browser এ না। মাঝের পথ (`max-age=3600`): ২% কম load, আর বন্ধের পরে এক ঘণ্টা পর্যন্ত চলা। কিছু product এটা বাছে। কিন্তু abuse এর link বন্ধ করা যে system এর দায়িত্ব, সেখানে "এক ঘণ্টা phishing চলতে দেওয়া" একটা সচেতন সিদ্ধান্ত হতে হবে।

### ১.৭ Analytics — redirect এর পথ থেকে আলাদা

Requirement: মালিক click আর unique visitor দেখবে, কয়েক মিনিট দেরিতে। Redirect এর পথে কাজ একটাই: একটা ছোট event (code, সময়, visitor এর একটা hash, referrer, দেশ) একটা buffer এ দেওয়া, অপেক্ষা না করে। বাকিটা আলাদা pipeline এ (7.2 এর log, 7.6 এর batch বা stream)।

Unique visitor গোনার প্রথম চিন্তা: "প্রতি link এ একটা HyperLogLog, 10.2 তে শিখেছি।" অংশ গ, মাসে ১,০০০ কোটি click, ১০০ কোটি link এ Zipf:

```
method                                                    memory   note
exact set per link (visitor hash, 16 B)                  96.0 GB   exact; big on popular links
dense HLL (12 KB) per clicked link                        8.1 TB   656 million links clicked — most of them small
set when small, HLL when big (Redis sparse → dense)       40.2 GB   only 369,858 links have more than 768 unique
collect click events, count in a nightly batch (7.6)         0 RAM   ~1.0 TB/month of raw events on disk; hours of delay
```

**প্রতি link এ dense HLL exact set এর চেয়ে ৮৫ গুণ বড়।** কারণ HLL এর দাম স্থির (১২ KB), গোনা যতই ছোট হোক, আর মাঝের link এ মাসে একটা click ও হয় না। HLL তখনই জেতে যখন একটা জিনিস অনেক বড় আর মাপের দাম স্থির রাখতে চান: এখানে মাত্র ~৩.৭ লাখ link এ ৭৬৮ এর বেশি unique visitor। (Redis নিজেই ছোট HLL কে একটা sparse রূপে রাখে, ঠিক এই কারণে। কিন্তু "প্রতি link এ একটা HLL" এর চিন্তায় সেই হিসাবটা প্রায়ই বাদ পড়ে।) **তৃতীয় "না"**, অন্তত সব link এর জন্য না।

এই নকশায়: event গুলো একটা log এ (Kafka বা Redis Streams, 7.2), একটা stream job কয়েক মিনিট পরপর প্রতি link এর click যোগ করে একটা ছোট table এ (`link_daily_stats`)। Unique visitor একটা columnar store এ (7.6) raw event থেকে, query এর সময় বা রাতে। আর যদি dashboard এ "এখনকার" unique দেখাতে হয়, শুধু জনপ্রিয় link গুলোর জন্য (ধরুন যাদের আজ ১,০০০ এর বেশি click) HLL। যন্ত্রটা ভুল না, ভুল ছিল তাকে সব জায়গায় বসানো।

Exercise এর app এ এটা ছোট করে আছে: redirect `ClickBuffer.record()` ডেকে সাথে সাথে 302 দেয়, আর একটা timer প্রতি সেকেন্ডে buffer flush করে। Smoke এর ধাপ ১৭ আর ১৮: পাঁচটা click এর পরে flush এর আগে stats এ ০, buffer এ ৫; flush এর পরে ৫টা click, ৩ জন unique। "কয়েক মিনিট দেরি" এর requirement টাই এই নকশা সম্ভব করে।

### ১.৮ Abuse, মেয়াদ, আর validation

একটা খোলা shortener phishing আর malware এর প্রিয় যন্ত্র: আসল ঠিকানা লুকায়, আর বিশ্বস্ত domain এর পেছনে বসে। তাই লেখার পথের validation নকশার অংশ, পরে যোগ করার জিনিস না। `npm run smoke` একটা আসল Express server চালায়:

```
#   request                                               status  result
1   POST /api/links  https://example.com/blog/syste…      201     https://sho.rt/cOoEtMq
2   POST /api/links  (the same URL again)                 201     https://sho.rt/BnqHDLC
3   GET /cOoEtMq                                          302     Location: https://example.com/blog/system-design?ref=newsletter
5   POST /api/links  url: javascript:alert(1)             400     unsupported_scheme
6   POST /api/links  url: https://sho.rt/abc (own domain)  400     self_redirect
9   POST /api/links  alias: launch-2026 (again)           409     alias_taken
10  POST /api/links  alias: abcDEF1 (7-char base62)       400     alias_reserved
14  GET /yhc3OjR  (2 hours later)                         410     expired
16  GET /cOoEtMq                                          410     disabled
```

- **শুধু `http` আর `https`।** Zod এর `url()` `javascript:alert(1)` কে বৈধ URL বলে, কারণ এটা বৈধ URL। Scheme আলাদা করে দেখতে হয়। এটা 10.5 এর কথা: "parse করা" আর "বিশ্বাস করা" আলাদা।
- **নিজের domain না।** `sho.rt/abc` কে ছোট করা একটা redirect loop বা chain বানায়, যা abuse এ ঠিকানা লুকাতে ব্যবহার হয়।
- **একই URL আবার দিলে নতুন code** (ধাপ ২)। এটা একটা সিদ্ধান্ত: আলাদা মালিক, আলাদা মেয়াদ, আলাদা analytics। একই মালিকের জন্য পুরনোটা ফেরানো চাইলে `(owner_id, long_url এর hash)` এর একটা index (experiment ৫)।
- **মেয়াদ পড়ার সময় দেখা।** Redirect এর query তে `expires_at` দেখা, তাই মেয়াদ শেষ হওয়ার মুহূর্তেই 410। Database থেকে মুছে ফেলা আলাদা, ধীরে, একটা background job এ, আর মুছে ফেলা code আবার ব্যবহার **না** করা: পুরনো পোস্টারে ছাপা code এ কারো নতুন link খুলে যাওয়া খারাপ চমক।
- **বন্ধ করা মানে সাথে সাথে বন্ধ** (ধাপ ১৫, ১৬)। 302 আর no-store এর জন্যই সম্ভব। Cache এর স্তরে বন্ধ করার সময় key টা মুছে দেওয়া (4.3 এর invalidation), আর local cache এর TTL কয়েক সেকেন্ড।
- **বাকি স্তরগুলো (exercise এ নেই):** তৈরির উপর account আর IP ধরে rate limit (9.5); গন্তব্যের URL কে জানা খারাপ URL এর তালিকার সাথে মেলানো, async ভাবে, আর পরে আবার (কারণ ভালো URL পরে খারাপ হয়); report করার একটা পথ।

### ১.৯ Step 5 — Trade-off আর wrap-up

চূড়ান্ত নকশা, এক পাতায়:

- **লেখা:** API service → range allocator (block ১,০০০, Postgres sequence থেকে) → গোপন permutation → ৭ অক্ষরের base62 → Postgres primary। Alias আলাদা namespace এ। Validation: scheme, নিজের domain, alias এর নিয়ম, rate limit।
- **পড়া:** redirect service (stateless, আলাদা deployment) → local LRU (কয়েক সেকেন্ড TTL, hot key এর জন্য) → Redis (link এর কয়েক %) → Postgres read replica। 302 + `private, no-store`। মেয়াদ আর বন্ধ পড়ার সময় দেখা, 410।
- **Analytics:** redirect থেকে fire-and-forget event → log → stream job (click এর গণনা, কয়েক মিনিট) + columnar store (unique, batch)। Redirect analytics এর উপর নির্ভর করে না।
- **যা ইচ্ছা করে নেই:** লেখার জন্য sharding (peak লেখা primary এর ~২%); "code নেওয়া কিনা" এর Bloom filter (১৪.৪ GB, counter এ প্রশ্নটাই নেই); প্রতি link এ HLL (৮.১ TB, exact এর চেয়ে বড়); database এর জন্য নিজের consistent hashing।

**কী আগে ভাঙবে, আর কখন:**

- **Storage আর recovery, তিন-চার বছরে।** ২-৩ TB এর পরে backup restore কয়েক ঘণ্টা। উত্তর: `created_at` ধরে partition (5.8 এর retention এর মতো, পুরনো partition আলাদা storage এ), বা `code` ধরে hash sharding। Code এলোমেলো, তাই hash sharding এ hot partition হবে না, আর redirect এর query সবসময় একটা shard এ যায় (code থেকেই shard জানা যায়)। এখানে consistent hashing এর জায়গা হতে পারে, তখন।
- **দশ গুণ বড় হলে** (experiment ৪): peak লেখা primary এর ~২৩%, এখনো একটা primary। ৬ অক্ষর পাঁচ বছরে শেষ হতো, ৭ অক্ষরে দশ বছরে ৩.৪%, তাই ৭ ঠিক থাকে। পড়া সেকেন্ডে ~১.১৬ লাখ: cache এর স্তর বড় হয়, আর CDN এর edge এ redirect রাখার কথা আসে (নিচে reflection ২)।
- **একাধিক region:** range allocation এখানে কাজে লাগে, প্রতিটা region এর নিজের range। পড়ার পথে replica এর lag মানে নতুন link দূরের region এ কিছুক্ষণ ৪০৪ (6.3)।

> **Trade-off Table — redirect এর পথের সিদ্ধান্ত**

| সিদ্ধান্ত       | বেছে নিলাম                               | বিকল্প               | কী দিলাম                                       | কী পেলাম                                                        |
| --------------- | ---------------------------------------- | -------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Redirect এর ধরন | 302 + `private, no-store`                | 301                  | সব click server এ (cache এর খরচ)               | সঠিক analytics, link সাথে সাথে বন্ধ (301 এ বন্ধের পরে ৬৩% যায়) |
| Cache           | Local LRU (সেকেন্ডের TTL) + Redis        | শুধু Redis / শুধু DB | দুই স্তরের জটিলতা, বন্ধে কয়েক সেকেন্ড দেরি    | hot key Redis এ পৌঁছায় না; ১% এ ৬০% hit                        |
| Click এর গণনা   | Event → log → stream/batch               | Row এ `clicks + 1`   | কয়েক মিনিটের দেরি, আলাদা pipeline             | পড়ার পথ পড়াই থাকে; analytics বন্ধেও redirect চলে              |
| Unique visitor  | Batch/columnar, শুধু জনপ্রিয় link এ HLL | প্রতি link এ HLL     | "এখনকার" unique শুধু বড় link এ                | ৮.১ TB এর বদলে প্রায় শূন্য RAM                                 |
| না থাকা code    | Negative cache + ৪০৪ এর rate limit       | Bloom filter         | একটা scanner কিছু query database এ পাঠাতে পারে | ১৪.৪ GB আর তার update এর ব্যবস্থা বাঁচল                         |

---

## ২. Interview Angle

URL shortener প্রায়ই প্রথম বা দ্বিতীয় system design interview এর প্রশ্ন, আর মাঝে মাঝে "warm-up" হিসেবে বড় প্রশ্নের আগে। সহজ দেখায় বলেই interviewer দেখে আপনি সহজ জিনিসে কতটা গভীরে যান। ভালো উত্তরের আকৃতি:

1. **প্রশ্ন দিয়ে শুরু, পাঁচ মিনিটের মধ্যে।** কত link, পড়া:লেখা, কত দিন, alias, মেয়াদ, analytics। আর non-functional এ দুটো জিনিস নিজে থেকে বলুন: redirect এর availability তৈরির চেয়ে বেশি জরুরি, আর code অনুমানযোগ্য হওয়া চলবে না।
2. **Estimation থেকে সিদ্ধান্ত।** "লেখা ১১৬/s, তাই একটা primary; পড়া ১১,৬০০/s আর skewed, তাই cache; ৭ অক্ষর কারণ ৬ অক্ষরে দশ বছরে ২১% ভরে।" সংখ্যা বলে থেমে যাবেন না, সংখ্যা থেকে কী বেরোয় সেটা বলুন।
3. **Deep dive: code generation।** অন্তত তিনটা পথ, প্রতিটার দাম। Hash এ birthday, counter এ enumeration, random এ retry। তারপর একটা বাছুন আর কেন।
4. **Redirect এর পথ।** 301 বনাম 302 এর কারণ (analytics, বন্ধ করা), cache, hot key, আর analytics কে পথ থেকে সরানো।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"MD5 নিয়ে প্রথম ৭ অক্ষর নিলে কী সমস্যা?"_ — Birthday bound: N²/2K, ৭ অক্ষরে দশ বছরে ~২ কোটি collision। সামলাতে salt আর check লাগে, তখন "একই URL → একই code" এর সুবিধাও যায়। আর URL থেকে code হিসাব করা যায়।
- _"Counter একটা single point of failure না?"_ — Range allocation: প্রতিটা server একটা block নেয়, counter মিনিটে কয়েকবার ডাকা হয়। Counter কয়েক মিনিট বন্ধ থাকলেও server গুলো তাদের block থেকে চালাতে পারে। আর redirect এর পথ counter ছোঁয়ই না।
- _"Sequential code কেন খারাপ?"_ — Enumeration (নিজের code থেকে পিছনে গুনলে ১০০% আসল link) আর ব্যবসার আকার ফাঁস। গোপন permutation বা random। আর সত্যিকারের private link এর জন্য authentication, অনুমান কঠিন করা না।
- _"Hot link এ কী হবে?"_ — একটা key একটা Redis node এ যায়। Redirect service এ local cache, ছোট TTL। গন্তব্য বদলায় না, তাই পুরনো data এর ঝুঁকি ছোট।
- _"Database কীভাবে scale করবেন?"_ — আগে সংখ্যা: লেখার জন্য দরকার নেই, পড়ার জন্য cache আর replica। Storage বড় হলে `code` এর hash ধরে shard (code এলোমেলো, তাই সমান ভাগ, আর প্রতিটা redirect এক shard এ)।
- _"Expired link মুছবেন কখন?"_ — পড়ার সময় মেয়াদ দেখা (সাথে সাথে 410), মুছে ফেলা আলাদা background job এ। আর code আবার ব্যবহার না করা।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ সমস্যাগুলো code generation না, বরং abuse (phishing আর spam এর ঢেউ, আর তার জন্য domain টা blocklist এ চলে যাওয়া), প্রতিটা redirect এ database এ লেখা করে বানানো click counter যা জনপ্রিয় link এ lock এর লড়াই বাঁধায়, 301 দিয়ে শুরু করে পরে analytics বা takedown এর জন্য আফসোস (আর ফেরার উপায় নেই, পুরনো browser এর cache থেকে যায়), আর shortener এর domain টাই হারানো বা মেয়াদ শেষ হওয়া, যার সাথে সব link একসাথে মরে।

---

## ৩. Key Takeaway

- **সংখ্যা আগে, যন্ত্র পরে।** লেখা peak এ ১১৬/s (একটা primary এর ~২%), পড়া ১১,৬০০/s, দশ বছরে ~৬ TB। তাই লেখার জন্য sharding নেই, পড়ার জন্য cache, আর storage এর জন্য partition পরে, recovery এর কারণে
- **Keyspace এর দৈর্ঘ্য একটা নিরাপত্তা আর খরচের সিদ্ধান্ত।** ৬ অক্ষরে দশ বছরে ২১% ভরা: প্রতি পাঁচটা অনুমানে একটা আসল link। ৭ অক্ষরে ০.৩৪%, একটা বাড়তি অক্ষরের দামে
- **Hash এর পথ birthday bound এ ভাঙে** (৭ অক্ষরে দশ বছরে ~২ কোটি collision), আর সামলাতে গেলে তার একমাত্র সুবিধা হারায়। **Counter এ collision নেই কিন্তু ১০০% অনুমানযোগ্য।** গোপন permutation দুটো একসাথে দেয়, এক-এক বলে collision অসম্ভব
- **Range allocation counter এর কাছে যাওয়া হাজার গুণ কমায়**, দাম নগণ্য নষ্ট id আর সময়ের ক্রম। আজকের সংখ্যায় ঐচ্ছিক, multi-region এ জরুরি
- **301 সস্তা, কিন্তু link এর নিয়ন্ত্রণ browser কে দিয়ে দেয়:** ৫৭% click analytics এ নেই, আর বন্ধ করার পরে ৬৩% click তবুও পুরনো গন্তব্যে। Load এর দাম cache এ দিন, browser এ না
- **Cache এর প্রথম ১% সবচেয়ে বেশি কেনে** (৬০% hit), তারপর লম্বা লেজ। Hot key এর জন্য local cache, লেজের জন্য Redis। আর পড়ার পথে কখনো লেখা না: click এর গণনা event হিসেবে আলাদা pipeline এ
- **"মনে আসা" যন্ত্রের দাম মাপুন।** Bloom filter ১৪.৪ GB (counter এ প্রশ্নটাই নেই), প্রতি link এ HLL ৮.১ TB (exact set এর চেয়ে ৮৫ গুণ বড়)। ভুল যন্ত্র না, ভুল জায়গা

---

## ৪. নতুন Term (Glossary)

| Term                                 | অর্থ                                                                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base62 Encoding**                  | সংখ্যাকে ৬২টা অক্ষরে (`0-9`, `a-z`, `A-Z`) লেখা; URL এ বিশেষ অর্থের কোনো অক্ষর নেই, তাই short code এর জন্য base64 এর চেয়ে নিরাপদ                                                         |
| **Keyspace**                         | সম্ভাব্য সব code এর সংখ্যা (৬২^L); কতটা ভরা সেটাই random এ retry এর হার আর অনুমানে আসল link পাওয়ার সম্ভাবনা ঠিক করে                                                                      |
| **Birthday Bound**                   | N টা জিনিস এলোমেলো ভাবে K টা ঘরে ফেললে ~N²/2K জোড়া একই ঘরে পড়ে — তাই hash কেটে ছোট করলে ভাবনার অনেক আগে collision শুরু হয়                                                              |
| **Range Allocation (Ticket Server)** | প্রতিটা server counter থেকে একবারে id এর একটা block নেয় আর memory থেকে দেয়; counter এর কাছে যাওয়া block এর আকারের ভাগে কমে, দাম restart এ নষ্ট id আর সময়ের ক্রম হারানো                |
| **Format-Preserving Permutation**    | একটা নির্দিষ্ট পরিসরের ভেতরে key দেওয়া, এক-এক রূপান্তর (যেমন Feistel + cycle walking) — counter কে collision ছাড়া এলোমেলো দেখানো code বানায়; গোপনতা না, key ফাঁস হলে ক্রম উল্টানো যায় |
| **301 / 302 Redirect**               | 301 "স্থায়ী" — browser cache করে আর server কে আর জিজ্ঞেস করে না; 302 "আপাতত" — প্রতিবার server এ আসে। Shortener এ 302 + no-store, যাতে analytics সঠিক আর link বন্ধ করা যায়              |
| **Link Enumeration**                 | Code গুনে বা অনুমান করে অন্যের link খুঁজে বের করা; sequential code এ ১০০%, এলোমেলো code এ keyspace কতটা ভরা তার সমান                                                                      |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. Product team দুটো নতুন feature চায়: (ক) link তৈরির পরে মালিক গন্তব্য বদলাতে পারবে (একটা QR code ছাপা হয়ে গেছে, ঠিকানা বদলাতে হবে), আর (খ) একটা enterprise plan, যেখানে link শুধু কোম্পানির কর্মীরা খুলতে পারবে। এই lesson এর কোন কোন সিদ্ধান্ত বদলায় বা আরও জরুরি হয় (redirect এর ধরন, cache, code এর গোপনতা)? প্রতিটার জন্য একটা নির্দিষ্ট পরিবর্তন বলুন।

2. Shortener এর user সারা পৃথিবীতে, আর নতুন requirement: redirect এর latency user থেকে দেখে p99 ৫০ ms, সব মহাদেশে। লেখা এখনো এক region এ (সিঙ্গাপুর)। (ক) 10.8 এর কোন topology? (খ) একজন user লন্ডন থেকে link বানাল আর সাথে সাথে Slack এ পাঠাল; লন্ডনের আরেকজন ২ সেকেন্ড পরে খুলল। কী দেখবে, আর কেন? (গ) এর সমাধান, আর negative cache এর সাথে এর কী সম্পর্ক?

3. এক সোমবার নতুন link এর ৩০% phishing, একটা campaign থেকে। কয়েকটা email provider আপনার domain কে সন্দেহজনক বলে চিহ্নিত করছে, আর তাতে সব user এর link এর ক্ষতি। (ক) এখনই কী করবেন, আর কী করবেন না? (খ) লেখার পথে কী কী স্তর যোগ করবেন, প্রতিটার false positive এর দাম সহ? (গ) 302 আর no-store এর সিদ্ধান্ত এখানে কীভাবে কাজে লাগে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) গন্তব্য বদলানো:

- **302 এখন বাধ্যতামূলক।** 301 এ যে browser একবার খুলেছে, সে পুরনো ঠিকানায় যেতেই থাকবে, আর ছাপা QR code এর মানুষ প্রায়ই ফিরে আসে (experiment ২ এর ৮৯%)। `max-age` থাকলে সেই সময় পর্যন্ত পুরনো ঠিকানা।
- **Cache এর invalidation।** আগে link কখনো বদলাত না, তাই local cache এর পুরনো data এর ঝুঁকি শুধু বন্ধ করায় ছিল। এখন বদলানো একটা সাধারণ ঘটনা: Redis এর key মুছে দেওয়া বা নতুন মান লেখা (4.3), আর local cache এর TTL ছোট রাখা, বা একটা invalidation এর broadcast (Redis pub/sub)। আর মালিককে বলা "কয়েক সেকেন্ডের মধ্যে সব জায়গায়"।
- **ইতিহাস।** কে কখন কোন ঠিকানায় বদলাল (`link_revisions` table)। এটা abuse এর জন্য জরুরি: একটা নিরীহ link তৈরি করে, review পার হয়ে, পরে phishing এ বদলানো একটা পরিচিত কৌশল। তাই প্রতিটা বদলের পরে গন্তব্য আবার যাচাই।
- Analytics এর event এ তখনকার গন্তব্যও রাখা, নইলে পুরনো আর নতুন ঠিকানার click মিশে যায়।

(খ) Enterprise এর private link:

- **গোপনতা code এর আড়াল দিয়ে না।** Permutation অনুমান কঠিন করে, কিন্তু link Slack এ, email এ, browser এর history তে ঘোরে। "শুধু কর্মীরা" মানে redirect এর আগে authentication আর authorization (10.5): redirect service দেখে link টা private, user কে কোম্পানির SSO তে পাঠায়, ফিরে এলে দেখে সে ওই organization এর সদস্য কিনা, তারপর 302।
- এখন redirect এর পথে একটা নতুন dependency (identity)। সেটা শুধু private link এর জন্য, যাতে সাধারণ link এর পথ আগের মতো দ্রুত আর স্বাধীন থাকে। Link এর row এ `visibility` আর `org_id`, cache এ সেটাও।
- এই link গুলোর জন্য 302 + no-store আরও জরুরি: cache থেকে redirect মানে authorization এর check এড়ানো।
- আর private link এর analytics এ visitor এর পরিচয় থাকে, যা ব্যক্তিগত data (10.8 এর residency এর প্রশ্ন ফিরে আসে)।

**প্রশ্ন ২:**

(ক) Redirect হলো প্রায় শুধু পড়া, ছোট data, আর গন্তব্য প্রায় কখনো বদলায় না। তাই 10.8 এর "প্রতি region এ read replica" এর মতো, বা আরও সস্তায় **edge এ একটা key-value store** (CDN এর edge compute + replicate করা KV): প্রতিটা PoP এর কাছে code → URL এর কপি। লেখা সিঙ্গাপুরে, তারপর async ভাবে সব জায়গায়। 10.8 এর যে সমস্যা ছিল (দূরে replica মানে লেখা ধীর) এখানে প্রায় নেই, কারণ redirect এর পথে কোনো লেখা নেই (click event local buffer এ, পরে পাঠানো)।

(খ) লন্ডনের দ্বিতীয় user সম্ভবত **৪০৪** দেখবে। Link সিঙ্গাপুরে লেখা হয়েছে, লন্ডনের edge এ তখনো পৌঁছায়নি (replication এর lag, আর edge KV এ এটা কয়েক সেকেন্ড থেকে মিনিট হতে পারে)। এটা 6.3 এর read-your-writes, কিন্তু আরও খারাপ: পড়ছে **অন্য** একজন, তাই session এর কোনো token কাজে লাগে না।

(গ) সমাধান: edge এ miss হলে **home region এ জিজ্ঞেস করা** ("না থাকা" কে চূড়ান্ত ধরবেন না), আর পেলে edge এ বসিয়ে দেওয়া। দাম: সত্যিকারের না থাকা code এ (scan) প্রতিটা request সিঙ্গাপুর পর্যন্ত যায়। আর এখানেই **negative cache** বিপজ্জনক: লন্ডনের edge যদি প্রথম ৪০৪ টা ৫ মিনিটের জন্য cache করে, তাহলে link তৈরির পরেও ৫ মিনিট ৪০৪, replication শেষ হওয়ার পরেও। উপায়: negative cache এর TTL খুব ছোট (কয়েক সেকেন্ড), বা code এর ভেতরে তৈরির সময়ের একটা ইঙ্গিত (যেমন counter এর range থেকে বোঝা যায় code টা "সদ্য" কিনা), আর সদ্য code এর ৪০৪ কখনো cache না করা। আরেকটা পথ: link তৈরির উত্তরে client কে বলা "সব জায়গায় পৌঁছাতে কয়েক সেকেন্ড লাগতে পারে", আর তৈরির সময় সবচেয়ে কাছের কয়েকটা edge এ সরাসরি লিখে দেওয়া।

**প্রশ্ন ৩:**

(ক) **এখনই:** campaign টা চেনা (একই account গুলো, একই IP এর পরিসর, গন্তব্যের একই domain গুলো) আর ওই link গুলো বন্ধ করা। 302 + no-store এর জন্য বন্ধ সাথে সাথে কাজ করে (সাথে Redis আর local cache এর key মোছা)। ওই account গুলো বন্ধ, আর তাদের তৈরির পথে কড়া rate limit। **যা না:** সব নতুন link বন্ধ করা বা পুরো তৈরি বন্ধ করা (৭০% বৈধ user এর ক্ষতি), বা হাতে হাতে সব পুরনো link মুছে ফেলা (বৈধ link ও যাবে, আর ফেরানো যাবে না; বন্ধ করা ফেরানো যায়, মোছা না)। আর email provider আর blocklist এর মালিকদের সাথে যোগাযোগ, কারণ domain এর সুনাম ফিরে পেতে সময় লাগে।

(খ) লেখার পথের স্তর, সস্তা থেকে দামি:

1. **Rate limit** (9.5): account আর IP ধরে, নতুন account এর জন্য কড়া। দাম: একজন বৈধ marketer যে একসাথে ৫০০ link বানায়, সে আটকায়। উত্তর: যাচাই করা account এর জন্য বড় সীমা।
2. **গন্তব্য যাচাই, async:** তৈরির সময় link টা "pending" অবস্থায়, কয়েক সেকেন্ডে জানা খারাপ URL এর তালিকা আর নিজের সংকেত (নতুন domain, একই গন্তব্যে অনেক account) দিয়ে যাচাই। দাম: এই কয়েক সেকেন্ড link কাজ করে না, বা একটা "সাবধান" page দেখায়। False positive এ একজন বৈধ user এর link আটকায়, তাই appeal এর পথ।
3. **পরে আবার যাচাই:** একটা নিরীহ domain পরে খারাপ হয়, তাই পুরনো link গুলো পর্যায়ক্রমে আবার। দাম: একটা background job আর বাইরের API এর খরচ।
4. **Interstitial (মাঝের সতর্কতা page):** সন্দেহজনক কিন্তু নিশ্চিত না এমন link এ "আপনি X এ যাচ্ছেন" page। দাম: বৈধ user এর একটা বাড়তি click, আর analytics এ কিছু হারানো।

(গ) 302 + no-store এর জন্যই প্রতিটা স্তরের সিদ্ধান্ত **সাথে সাথে** কার্যকর, এমনকি যে link আগে বহুবার খোলা হয়েছে সেগুলোতেও। 301 হলে প্রথম দিনের সব click এর browser গুলো চিরকাল phishing site এ যেত, যা কেউ ঠিক করতে পারত না। Abuse এর দিক থেকে 302 শুধু একটা analytics এর সিদ্ধান্ত না, "আমরা কি আমাদের নিজেদের link নিয়ন্ত্রণ করি?" এর উত্তর।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (তিনটা deterministic model আর একটা আসল Express + Zod shortener; Docker বা database লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.1-url-shortener/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.1-url-shortener) — `npm install`, তারপর `npm run estimate`, `npm run keygen`, `npm run redirect`, `npm run smoke` (আর নিজে খেলতে `npm run serve`)। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` traffic, storage, keyspace আর যন্ত্রগুলোর দাম হিসাব করে। `keygen` code বানানোর চারটা পথ আর range allocation চালায়: retry, collision (birthday এর আন্দাজের সাথে), অনুমান করে খোঁজা, আর permutation এক-এক কিনা তার পুরো যাচাই। `redirect` Zipf traffic এ LRU cache, hot key, 301 বনাম 302 (analytics আর link বন্ধ করা), আর unique visitor এর memory মাপে। `smoke` একটা আসল Express server চালায় (Zod দিয়ে validation, range allocator, Feistel permutation, click এর buffer) আর ১৮টা ধাপ আর ১০,০০০ link এর একটা যাচাই করে।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক; `npm run serve` এ `curl` দিয়ে তৈরি → 302 → stats। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, আপনার। **Estimation এর input ধরে নেওয়া** (মাসে ১০ কোটি link, ১০০:১, row প্রতি ৫০০ B), আর Postgres এর "সেকেন্ডে ৫,০০০ insert" একটা মোটামুটি আন্দাজ, মাপা না। `keygen` keyspace ছোট করে (৪ অক্ষর) চালায় আর ভরার হার মিলিয়ে ৭ অক্ষরে অনুবাদ করে। `redirect` এর traffic synthetic (Zipf, s = ১), সময়ের সাথে জনপ্রিয়তা কমা নেই; browser এর 301 এর আচরণ ধরে নেওয়া (৮৫% cache রাখে)। Unique visitor এর অংশ একটা হিসাব, simulation না, আর Redis এর HLL এর ১২ KB তার documentation থেকে। "Gone in Six Characters" এর গবেষণা আর Flickr এর ticket server এর কথা প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। Exercise এর Feistel ৪ round এর, শিক্ষার জন্য; production এ প্রমাণিত format-preserving encryption লাগবে। **যা মাপা হয়নি:** আসল Postgres (schema lesson এ, চালানো না), আসল Redis, আসল browser এর cache, redirect এর আসল latency, multi-region।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `keygen` চালানোর **আগে** লিখে ফেলুন: hash এর প্রথম ৭ অক্ষরে দশ বছরে কতগুলো collision হবে? এক হাজার? এক লাখ? তারপর N²/2K হাতে হিসাব করুন, আর চালিয়ে মেলান। কোথায় অনুমান ভুল ছিল?

2. **Cache এর মাপ:** `ZIPF_S=0.8 npm run redirect` আর `ZIPF_S=1.2 npm run redirect`। ১% cache এর hit rate কতটা নড়ে? আপনার database peak এ সেকেন্ডে ২,০০০ পড়া আরামে নেয় ধরে নিয়ে, তিনটা s এর জন্য cache কত বড় হতে হবে?

3. **301 এর লোভ:** একজন বলল "301 দিলে server এর বিল অর্ধেক।" `redirect` এর অংশ খ এর সংখ্যা আর অংশ ক এর cache এর সংখ্যা দিয়ে উত্তর দিন: 302 এর বাড়তি load আসলে কোথায় যায় (Redis, database, না app server), আর তার আনুমানিক দাম কত, 10.7 এর মতো করে?

4. **Code বদলানো:** `src/app.ts` এ একই owner এর জন্য একই URL আবার দিলে পুরনো code ফেরত দিন (README এর experiment ৫)। `MemoryLinkStore` এ কোন index লাগবে, আর Postgres এ সেটা কোন `CREATE INDEX`? দুজন আলাদা owner এর জন্য কী করলে, আর কেন?

5. **Design অংশ:** এই shortener এর একটা "এক পাতার design doc" লিখুন, Lesson 1.2 এর পাঁচ ধাপে: (ক) requirement আর বাদ দেওয়া জিনিস, (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত, (গ) ছবি, (ঘ) দুটো deep dive, প্রতিটায় বাদ দেওয়া বিকল্প আর কেন, (ঙ) কী আগে ভাঙবে আর কখন, আর কোন তিনটা যন্ত্র ইচ্ছা করে ব্যবহার করোনি।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ)
Current: 11.1 — Case Study: Design a URL Shortener
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ — URL shortener: মাসে ১০ কোটি
link, ১০০:১, ১০ বছর। লেখা peak ১১৬/s (একটা Postgres primary এর ~২%), পড়া ১১,৬০০/s, ১০ বছরে ~৬ TB। Code:
range allocation (block ১,০০০) + গোপন Feistel permutation + ৭ অক্ষরের base62 (১০ বছরে keyspace এর ০.৩৪%);
alias আলাদা namespace (৭ অক্ষরের base62 alias নিষিদ্ধ)। Redirect: আলাদা stateless service → local LRU
(hot key) → Redis (১% এ ~৬০% hit) → read replica; 302 + private, no-store (301 এ ৫৭% click analytics এ নেই, বন্ধের
পরে ৬৩% পুরনো গন্তব্যে); মেয়াদ আর বন্ধ পড়ার সময়, 410। Analytics: fire-and-forget event → log → stream/batch;
প্রতি link এ HLL না (৮.১ TB বনাম exact ৯৬ GB)। ইচ্ছা করে নেই: লেখার sharding, "নেওয়া কিনা" এর Bloom filter
(১৪.৪ GB), নিজের consistent hashing। পরে: storage এর জন্য code এর hash ধরে shard বা created_at ধরে partition।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: 11.2 — Case Study: Design a Rate Limiter service
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **সহজ দেখানো system এ প্রতিটা সিদ্ধান্তের পেছনে একটা সংখ্যা, আর সংখ্যাটা প্রায়ই বলে কী লাগবে না।** লেখা এত কম যে sharding এর প্রশ্নই নেই, পড়া এত skewed যে প্রথম ১% cache অর্ধেকের বেশি কাজ করে। Code এর প্রশ্নে চারটা পথ, আর প্রতিটা একটা আলাদা জিনিসে দাম দেয়: hash collision এ, counter গোপনতায়, random retry তে। আর 301 বনাম 302 এর মতো ছোট একটা header ঠিক করে link টা কার নিয়ন্ত্রণে।

রেডি হলে `next` লিখুন — **Lesson 11.2: Design a Rate Limiter service** এ যাব। 9.5 এ rate limiting এর algorithm গুলো শিখেছিলাম একটা Express middleware হিসেবে, একটা process এর ভেতরে। এবার প্রশ্নটা বড়: একটা **আলাদা service**, যা কয়েকশো API server এর সব request এর সিদ্ধান্ত দেয়, প্রতিটায় এক ms এর কম যোগ করে, আর নিজে মরলে সব API কে মেরে ফেলে না। সেখানে আজকের দুটো জিনিস ফিরে আসবে: hot key (একজন customer এর সব request একটা counter এ), আর সেই প্রশ্ন যা আজ 301 এ উঠেছিল: সিদ্ধান্ত কে নেয়, আর সে ভুল করলে কী হয়।
