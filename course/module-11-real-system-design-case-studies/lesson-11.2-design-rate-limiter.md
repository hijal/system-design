# Lesson 11.2 — Case Study: Design a Rate Limiter Service

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 5.5):** "Lost update" কী? দুটো transaction একই row পড়ে, নিজের হিসাব করে, তারপর লেখে, তখন কী হারায়? আর read-modify-write কে নিরাপদ করার দুটো উপায় কী ছিল? আজ ঠিক এই ভুলটা একটা rate limiter এ বসবে, আর মাপা হবে আক্রমণের সময় এটা সীমাকে কত গুণ ফাঁস করে।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.5 (Latency budget), Lesson 5.5 (Lost update), Lesson 6.1 (Timeout, partial failure), Lesson 9.2 (API gateway), Lesson 9.4 (Circuit breaker), Lesson 9.5 (Rate limiting algorithms), Lesson 10.1 (Hash slot), Lesson 10.3 (Hard/soft dependency, static stability), Lesson 10.7 (Cross-AZ cost), Lesson 11.1 (Case study এর কাঠামো)

**আপনি এই lesson শেষে পারবেন:**

1. একটা rate limiter কে library বা middleware হিসেবে না, একটা **service** হিসেবে নকশা করতে পারবেন: requirement এ rate limit আর quota আলাদা করা, estimation থেকে Redis এর shard, network আর cross-AZ খরচ বের করা, আর limiter কোথায় বসবে (library, sidecar, আলাদা service) তার trade-off বলা
2. কেন্দ্রে গোনার চারটা পথ (প্রতি request এ atomic, সীমা ভাগ করা, token lease, async sync) সংখ্যা দিয়ে তুলনা করতে পারবেন: কতটা ঠিক, কত দ্রুত, কেন্দ্রে কত চাপ, আর **কোন অবস্থায় কোনটা ভাঙে** (atomic না হলে race, skewed traffic, আক্রমণ, lease এর আটকে থাকা token)। Hot tenant কে কীভাবে সামলাবেন সেটাও
3. Limiter ধীর বা মরলে API কে বাঁচাতে পারবেন: timeout এর বাজেট, breaker, নিয়ম ধরে fail mode, আর local fallback এর উদারতার দাম (বৈধ user আটকানো বনাম abuser এর বাড়তি)

**Tier:** 1 — Runnable Code (চারটা deterministic model আর একটা আসল limiter service + client library + API server; Docker বা Redis লাগে না)

---

## ০. আজকের System

Interview এর ঘর, দ্বিতীয় round। Interviewer:

> "আমরা একটা public API platform চালাই। Peak এ সেকেন্ডে ৫ লাখ request, ৪০০টা API server, কয়েক লাখ customer, প্রতিটার plan এ আলাদা সীমা। একটা rate limiter **service** design করুন।"

9.5 পড়া থাকলে প্রথম উত্তর তৈরি: "Token bucket, Redis এ, একটা Lua script এ atomic, Redis মরলে fail open। শেষ।" ঠিক উত্তর, একটা process এর জন্য। কিন্তু interviewer এর follow-up গুলো এবার আকারের:

- "প্রতি request এ Redis এ যাবেন? ৫ লাখ op/s, একটা Redis এ ধরে? কতগুলো shard? মাসে কত খরচ?"
- "Limiter API এর প্রতিটা request এর latency তে যোগ হয়। আপনার বাজেট কত, আর Redis ধীর হলে কী?"
- "একজন customer একাই সব traffic এর ৮%। তার key কোন shard এ, আর সেই shard এর কী হবে?"
- "প্রতিটা server কে সীমার একটা ভাগ দিয়ে দিলে কেন্দ্রেই যেতে হয় না। সমস্যা কী?"
- "Customer এর মাসিক quota (মাসে ১ কোটি call, তার বেশি হলে বিল) — এটাও একই Redis এ?"

9.5 এর প্রশ্ন ছিল "কোন algorithm"। আজকের প্রশ্ন "**কোথায় আর কতবার গুনব**", কারণ এই মাপে algorithm প্রায় সমান, আর পার্থক্য আসে গোনার জায়গা, দূরত্ব আর ব্যর্থতা থেকে।

---

## ১. Theory

### ১.১ Step 1 — Requirement: rate limit আর quota এক জিনিস না

প্রশ্নগুলো, আর যা ধরে নিলাম:

```
প্রশ্ন                                      ধরে নিলাম
কী ধরে সীমা?                                API key (customer), সাথে IP (login আর বেনামি endpoint)
কয়টা নিয়ম একটা request এ?                   গড়ে ২টা: key এর প্রতি সেকেন্ডের সীমা + endpoint এর নিজের সীমা
সীমা কত ঘন ঘন বদলায়?                        plan বদলালে, বা incident এ হাতে — কয়েক সেকেন্ডে কার্যকর হতে হবে
কতটা ঠিক হতে হবে?                           সুরক্ষার সীমায় ±১০% চলে; কিন্তু সীমার নিচের কাউকে আটকানো চলবে না
Limiter কত latency যোগ করতে পারে?            API এর p99 ৫০ ms; limiter পায় ১ ms
Limiter মরলে?                               API চলবে; কোন নিয়ম খোলা আর কোনটা বন্ধ, নিয়ম ধরে ঠিক করা
একাধিক region?                              আজ এক region, শেষে আলোচনা
```

আর একটা প্রশ্ন যা candidate রা প্রায়ই করে না: **সীমাটা কিসের জন্য?** দুটো খুব আলাদা জিনিস একই নামে আসে।

**Quota (বনাম Rate Limit)** — Rate limit একটা **সুরক্ষা**: "সেকেন্ডে ১,০০০ এর বেশি না", যাতে একজনের চাপ অন্যদের ক্ষতি না করে। একটু বেশি বা কম হলে কেউ টের পায় না, আর অবস্থা হারালে (Redis restart) ক্ষতি কয়েক সেকেন্ডের। Quota একটা **চুক্তি**: "মাসে ১ কোটি call, তার পরে প্রতি হাজারে এত টাকা"। এখানে প্রতিটা গোনা টাকা, তাই হারানো চলবে না, আন্দাজ চলবে না, আর একটা বিতর্কে আপনাকে প্রমাণ দেখাতে হবে।

তাই নকশায় দুটো আলাদা পথ। Rate limit এর অবস্থা দ্রুত, memory তে, হারালে ক্ষতি নেই (Redis, persistence ছাড়াই চলে)। Quota গোনা হয় **usage event** থেকে, 11.1 এর click এর মতো: প্রতিটা request এর পরে একটা event log এ, একটা job গোনে, টেকসই database এ জমা রাখে, আর মিনিটে একবার "এই customer এর quota শেষ" এর একটা flag rate limiter এর নিয়মে পাঠায়। Quota শেষ হওয়ার পরে কয়েক সেকেন্ডের বাড়তি request গ্রহণ হবে, আর সেটা চুক্তিতে লেখা থাকে ("quota এর হিসাব কয়েক মিনিট দেরিতে")। উল্টো ভুলটা, quota কে rate limiter এর Redis এ রাখা, মানে Redis এর একটা failover এ customer এর মাসের হিসাব শূন্য। 9.5 এর eviction এর সমস্যা এখানে টাকার সমস্যা।

### ১.২ Step 2 — Estimation

`npm run estimate`:

```
── Part A — load: 500,000 API requests/s at peak, 400 API servers, 2 rules per request ──
                                                          Redis op/s  shards needed       network  cross-AZ / month
a separate Redis call per rule                             1,000,000             20      300 MB/s           $10,368
all rules in one Lua script (on the same shard)              500,000             10      150 MB/s            $5,184

── Part B — memory ──
token bucket, 300,000 active keys (150 B/state)                      600,000     90.0 MB
sliding log, limit 1,000 an hour, the same keys (16 B/entry)  300,000      4.8 GB

── Part C — the latency budget: the API's p99 is 50 ms, the limiter gets 1 ms ──
1,250 requests/s on one API server — if the limiter holds each for 1 ms, ~1 are waiting at a time; slow at 50 ms, ~63.
```

চারটা জিনিস:

1. **চাপটা op/s এ, memory তে না।** তিন লাখ সক্রিয় key এর পুরো অবস্থা ৯০ MB, একটা Redis এর একটা ছোট কোণ। কিন্তু প্রতি request এ একটা op মানে সেকেন্ডে ৫ লাখ op, আর একটা Redis shard এর আরামদায়ক ক্ষমতা (Lua script সহ, ধরে নেওয়া ~১ লাখ, অর্ধেক ফাঁকা রেখে) দিয়ে ১০টা shard। তাই প্রশ্ন "কত data" না, "**কতবার কেন্দ্রে যাই**"। পরের সব deep dive এই প্রশ্নের উত্তর।
2. **দুটো নিয়ম এক call এ।** প্রতিটা নিয়মের জন্য আলাদা call মানে দ্বিগুণ op, দ্বিগুণ shard, দ্বিগুণ network। একটা Lua script এ সব নিয়ম দেখা আর একসাথে সিদ্ধান্ত নেওয়া অর্ধেক খরচ, আর সঠিকও বেশি: একটা নিয়ম পাশ করে আরেকটায় আটকালে প্রথমটার token খরচ হওয়ার কথা না, যেটা আলাদা call এ সামলানো কঠিন। শর্ত: সব key একই shard এ থাকতে হবে (১.৩ এর hash tag)।
3. **খরচের একটা লুকানো লাইন।** Redis এর shard গুলো তিনটা AZ এ ছড়ানো থাকলে API server এর call এর দুই-তৃতীয়াংশ অন্য AZ এ যায়, আর 10.7 এর cross-AZ এর দাম মাসে ~$৫,০০০ থেকে $১০,০০০, শুধু "অনুমতি আছে কি" জিজ্ঞেস করতে। পরের অংশের lease এটাও কমায়।
4. **Sliding log এই মাপে দামি।** 9.5 এর নির্ভুল algorithm ঘণ্টায় ১,০০০ এর সীমায় ৪.৮ GB, token bucket এর ৫০ গুণ। তাই log শুধু ছোট আর দামি নিয়মে (login, password reset), বাকি সব token bucket।

আর latency এর বাজেট: API এর p99 ৫০ ms এর ১ ms (২%) limiter এর। একটা network round trip, একটা script, আর **কোনো retry না**। শেষ লাইনটা Little's law (একসাথে অপেক্ষায় থাকা = হার × অপেক্ষার সময়): limiter ধীর হয়ে ৫০ ms নিলে প্রতিটা API server এ একসাথে ৬৩টা request শুধু limiter এর উত্তরের অপেক্ষায় বসে থাকে। ১.৭ এ এটা আরও খারাপ হবে।

### ১.৩ API, নিয়ম আর data model

**Limiter এর API** (ভেতরের, API server আর gateway এর জন্য):

```
POST /v1/check   { key, cost = 1 }        → { allowed, limit, remaining, retryAfterMs }
POST /v1/lease   { key, want }            → { granted, retryAfterMs, ttlMs }    (১.৫ এর token lease)
```

**নিয়ম (config, data না):**

```
{ prefix: "api:",    rate: 1000/s, burst: 200, failMode: "local"  }    ← plan অনুযায়ী
{ prefix: "login:",  rate: 5/s,    burst: 5,   failMode: "closed" }
{ prefix: "search:", rate: 50/s,   burst: 50,  failMode: "open"   }
```

নিয়মগুলো একটা ছোট config service এ, version সহ, আর প্রতিটা API server এ cache করা, কয়েক সেকেন্ডে push বা poll করে। নিয়মের service মরলে server গুলো শেষ জানা নিয়ম দিয়ে চলে (10.3 এর static stability)। একটা incident এ "এই customer কে এখনই ১০/s এ নামান" এর পথ এটাই, তাই এর deploy এর দরকার নেই।

**Redis এর key:** `rl:{acme}:api` আর `rl:{acme}:search`। বাঁকা বন্ধনীর ভেতরের অংশটাই আসল কৌশল। **Hash Tag** — Redis Cluster এ key এর যে অংশ `{` আর `}` এর ভেতরে, শুধু সেটা দিয়ে hash slot (10.1) হিসাব হয়। তাই একই customer এর সব নিয়মের key একই slot এ, একই shard এ, আর একটা Lua script সবগুলো একসাথে পড়তে আর লিখতে পারে। দাম: একজন customer এর সব চাপ একটা shard এ (১.৬)। প্রতিটা key একটা ছোট hash (`tokens`, `ts`) আর TTL = খালি bucket পূর্ণ হতে যত সময়: যে key কিছুক্ষণ ব্যবহার হয়নি সেটা নিজেই মুছে যায়, কারণ পূর্ণ bucket আর না থাকা key একই অর্থ।

### ১.৪ Step 3 — High-level design: limiter কোথায় বসবে

তিনটা জায়গা, আর তিনটাই production এ দেখা যায়:

```
(ক) library, API server/gateway এর ভেতরে            (খ) sidecar, প্রতিটা server এর পাশে          (গ) আলাদা limiter service

 client ─► [gateway + limiter lib] ─► service       client ─► [proxy ─► sidecar] ─► service       client ─► [gateway] ─► service
                  │                                                 │                                        │ gRPC
                  ▼                                                 ▼                                        ▼
            [Redis cluster]                                   [Redis cluster]                     [limiter service] ─► [Redis cluster]
```

| জায়গা            | Latency               | ভাষা আর নিয়মের মিল                           | কেন্দ্রের দৃশ্য                  | ব্যর্থতা                                 |
| ----------------- | --------------------- | --------------------------------------------- | -------------------------------- | ---------------------------------------- |
| (ক) library       | এক hop (সরাসরি Redis) | প্রতিটা ভাষায় আলাদা library, version এর অমিল | নেই, Redis ই সত্য                | প্রতিটা server নিজের timeout আর fallback |
| (খ) sidecar       | localhost + এক hop    | একটাই implementation                          | নেই                              | sidecar একটা নতুন জিনিস যা মরতে পারে     |
| (গ) আলাদা service | দুই hop               | একটাই, নিয়ম আর metric এক জায়গায়            | আছে: lease, hot key, নিয়মের বদল | আলাদা fleet, নিজের scale আর SLO          |

Envoy এর মতো proxy তে দুটোই আছে: প্রতিটা proxy এর ভেতরে একটা local limit, আর একটা বাইরের global rate limit service (gRPC তে জিজ্ঞেস করে)। এই নকশায়: **gateway এর ভেতরে library (ক)**, সরাসরি Redis cluster এ, কারণ ১ ms এর বাজেটে বাড়তি hop এর জায়গা নেই আর gateway একটাই ভাষায় লেখা। "Service" টা যুক্তির স্তরে: Redis cluster + নিয়মের config service + client library + dashboard, একটা team এর মালিকানায়। Lease এর জন্য (১.৫) কেন্দ্রে logic লাগে, সেটা Redis এর Lua script এই থাকে।

### ১.৫ Deep dive ১ — কতবার কেন্দ্রে যাব: accuracy, latency আর চাপ

`npm run accuracy`: একটা API key, সীমা ১,০০০/s (burst ২০০), ৫০টা API server, ১০ সেকেন্ড, কেন্দ্রের RTT median ০.৫ ms। ছয়টা কৌশল, চারটা অবস্থা। প্রথমে আসল প্রশ্নটা পরিষ্কার করা যাক: **কোনো কৌশল সব অবস্থায় জেতে না।** তাই প্রতিটাকে চারটা অবস্থায় দেখব।

**অবস্থা ১ — চাহিদা সীমার ২ গুণ, সব server এ সমান ভাগে:**

```
strategy                                          accepted/s  of limit    highest in 1 s  blocked   centre op/s  extra p50  extra p99
each server its own bucket (full limit)                2,010     2.01x             2.10x     0.0%             0    0.00 ms    0.00 ms
split the limit (limit / N on each server)             1,010     1.01x             1.11x    49.7%             0    0.00 ms    0.00 ms
central, every request, atomic (Lua)                   1,020     1.02x             1.20x    49.3%         2,010    0.50 ms    1.25 ms
central, GET then SET (not atomic)                     1,355     1.35x             1.63x    32.6%         4,020    1.04 ms    2.03 ms
token lease (4 at a time, wait if not granted)         1,016     1.02x             1.16x    49.5%         1,166    0.33 ms    1.15 ms
local + sync every 100 ms (async)                        998     1.00x             1.22x    50.4%           495    0.00 ms    0.00 ms
```

প্রথম সারি 9.5 এর পুরনো ভুল (সীমা × server, এখানে চাহিদা যতটা ততটাই)। বাকিগুলো সবাই ~১.০x। এই অবস্থায় সবাই ভালো দেখায়, তাই এখানে থেমে গেলে ভুল সিদ্ধান্ত হবে।

**Spaced repetition এর উত্তর, আর চতুর্থ সারি:** lost update মানে দুজন একই পুরনো মান পড়ে, দুজনেই নিজের হিসাব লেখে, আর একজনের কাজ হারায়। উপায় দুটো ছিল: পড়া আর লেখা একটা atomic ধাপে (`UPDATE ... SET x = x - 1`), বা lock/version দিয়ে। Rate limiter এ "GET করে token দেখুন, তারপর SET করে একটা কমান" ঠিক সেই ভুল: দুটো server এর GET এর মাঝে অন্যটার SET পৌঁছায় না, দুজনেই একই token খরচ করে। ২ গুণ চাহিদায় ১.৩৫x, আর ২০ গুণ চাহিদায় (নিচে) **৫.৮x**: concurrent request যত বেশি, race এর জানালায় তত বেশি জন। মানে সীমা সবচেয়ে বেশি ফাঁস হয় **ঠিক আক্রমণের সময়।** তাই Redis এ পুরো সিদ্ধান্ত (refill, তুলনা, কমানো) একটা Lua script এ, যা Redis একবারে চালায়, মাঝে অন্য কোনো command ঢোকে না।

**অবস্থা ২ — একই চাহিদা, কিন্তু ৯০% traffic ৫টা server এ** (বাস্তবে সাধারণ: একজন customer এর connection pool কয়েকটা keep-alive connection এ কয়েকটা server এ আটকে থাকে, 3.2):

```
split the limit (limit / N on each server)               287     0.29x             0.32x    85.8%             0    0.00 ms    0.00 ms
token lease (4 at a time, wait if not granted)         1,007     1.01x             1.16x    50.1%           835    0.00 ms    1.09 ms
local + sync every 100 ms (async)                        966     0.97x             1.16x    52.1%           495    0.00 ms    0.00 ms
```

**সীমা ভাগ করা ভেঙে পড়ে।** প্রতিটা server এর ভাগ ২০/s। Traffic যে পাঁচটা server এ জমেছে তারা নিজের ভাগ শেষ করে আটকায়, আর বাকি ৪৫টা server এর ভাগ অব্যবহৃত পড়ে থাকে। Customer সীমার ২৯% পায়। আর অবস্থা ৪ এ আরও খারাপ।

**অবস্থা ৩ — আক্রমণ: চাহিদা সীমার ২০ গুণ:**

```
central, every request, atomic (Lua)                   1,020     1.02x             1.20x    94.9%        20,033    0.50 ms    1.27 ms
central, GET then SET (not atomic)                     5,799     5.80x             7.33x    71.1%        40,065    1.04 ms    2.04 ms
token lease (4 at a time, wait if not granted)         1,019     1.02x             1.19x    94.9%         9,360    0.25 ms    1.14 ms
local + sync every 100 ms (async)                      2,016     2.02x             2.08x    89.9%           495    0.00 ms    0.00 ms
```

**Approximate Sync (local গোনা + পর্যায়ক্রমিক sync)** — প্রতিটা server নিজে গোনে আর প্রতি T ms এ কেন্দ্রে নিজের সংখ্যা পাঠায় আর সবার মোট ফেরত পায়; মাঝের সময়ে সিদ্ধান্ত নেয় শেষ জানা মোট + নিজের গোনা দিয়ে। Request এর পথে কোনো network নেই (বাড়তি latency শূন্য), আর কেন্দ্রের চাপ request সংখ্যা না, server × sync এর হার (এখানে ৪৯৫/s)। দাম: sync এর জানালায় প্রতিটা server অন্যদের দেখে না। শান্ত অবস্থায় এটা চোখে পড়ে না। কিন্তু আক্রমণে, sync এর পরে প্রথম মুহূর্তে সব ৫০টা server একসাথে "জায়গা আছে" ভেবে নেয়: **২.০২x**। Experiment ১: sync ৫০০ ms হলে **৭.০২x**। ভুলটা T × server সংখ্যার সাথে বাড়ে, আর সবচেয়ে খারাপ হয় যখন চাহিদা সবচেয়ে বেশি। তাই এই কৌশল ঠিক সেখানে, যেখানে সীমা একটা মোটা সুরক্ষা আর ২ গুণ ভুল সহ্য করা যায় (CDN এর edge এ অনেক PoP জুড়ে গোনা এই পরিবারের), আর ভুল জায়গায় যেখানে সীমার পেছনে একটা ভঙ্গুর downstream।

**অবস্থা ৪ — চাহিদা সীমার ৮০%, ৯০% traffic ৫টা server এ.** এখানে কাউকে আটকানো ভুল:

```
split the limit (limit / N on each server)               176     0.18x             0.20x    78.3%             0    0.00 ms    0.00 ms
central, every request, atomic (Lua)                     813     0.81x             0.88x     0.0%           813    0.50 ms    1.26 ms
token lease (4 at a time, wait if not granted)           813     0.81x             0.88x     0.0%           215    0.00 ms    0.99 ms
local + sync every 100 ms (async)                        813     0.81x             0.88x     0.0%           495    0.00 ms    0.00 ms
```

সীমার নিচের একজন customer এর **৭৮%** request আটকানো, শুধু কারণ তার traffic সমান ভাবে ছড়ায়নি। এটা সবচেয়ে খারাপ ধরনের ভুল: customer support এ এসে বলে "আমার সীমা ১,০০০, আমি ৮০০ পাঠাচ্ছি, ৪২৯ পাচ্ছি", আর dashboard এ তার মোট হার সীমার নিচে দেখায়। Experiment ২: ২০০টা server এ সে পায় সীমার ১০%। Server বাড়ানো (autoscale) customer এর সীমা কমায়।

**Token Lease** — প্রতিটা server কেন্দ্র থেকে একবারে কয়েকটা token "ধার" নেয় (ধরুন ৪টা, একটা মেয়াদ সহ), তারপর সেগুলো নিজের memory থেকে খরচ করে, শেষ হলে আবার। কেন্দ্র তখনও একমাত্র সত্য (token এর হিসাব সেখানে), তাই সীমা ফাঁস হয় না। কিন্তু প্রতি request এ না, প্রতি কয়েকটা request এ একবার যেতে হয়। 11.1 এর range allocation এর ধারণা, token এর জন্য। Lease পুরো না পেলে (কেন্দ্রে কম token) server কিছুই নেয় না আর token জমার সময়টুকু নিজেই "না" বলে, যাতে প্রতিটা আটকানো request কেন্দ্রে না যায়।

ফল: অবস্থা ৪ এ কেন্দ্রের চাপ ৮১৩ থেকে **২১৫ op/s**, কোনো ভুল আটকানো ছাড়া, সীমা ঠিক। কিন্তু lease এর আকার একটা ফাঁদ:

```
── lease size: 50 servers, burst 200 — when lease × servers passes the burst ──
lease     lease × server  2x, 5 servers: accepted   centre op/s  80%: wrongly blocked   centre op/s
1                     50                   1.02x         1,791              0.0%           813
4                    200                   1.01x           835              0.0%           215
10                   500                   0.93x           494              0.8%           106
20                 1,000                   0.89x           341             11.6%           108
50                 2,500                   0.83x           237             21.7%            94
```

Lease ২০ এ সীমার নিচের customer এর ১১.৬% আটকায়। কারণ: ৫০টা server এর প্রতিটা ২০টা করে token ধার নিয়ে বসে আছে (১,০০০টা), যার বেশিরভাগ শান্ত server এ, ব্যবহার না হয়ে মেয়াদ শেষের অপেক্ষায়। Bucket এ মোট আছে মাত্র ২০০ (burst)। ব্যস্ত server গুলো কেন্দ্রে গিয়ে খালি পায়। নিয়মটা: **lease × server সংখ্যা ≤ burst।** তার মানে lease এর আকার স্থির না, প্রতিটা key আর প্রতিটা server এর জন্য তার নিজের হার থেকে আসা উচিত (সেই server এ এই key এর শেষ কয়েক শো ms এর request)। ব্যস্ত server বড় lease নেয়, শান্ত server ছোট বা শূন্য (experiment ৫)।

আর সৎ সতর্কতা: আক্রমণে (অবস্থা ৩) lease কেন্দ্রের চাপ অর্ধেক করে (২০,০৩৩ থেকে ৯,৩৬০), শূন্য না, কারণ খালি bucket এ প্রতিটা server বারবার জিজ্ঞেস করে। আক্রমণের চাপ কেন্দ্রে না আনার আসল উত্তর আরও আগে, gateway এর সামনে (10.5 এর DDoS এর স্তর) আর "এই key আগামী ১ সেকেন্ড আটকানো" এর local cache।

> **Trade-off Table — কোথায় গুনব**

| কৌশল                          | সঠিকতা                         | ভুল করে আটকানো (skewed) | বাড়তি latency | কেন্দ্রের চাপ              | কোথায় মানায়                            |
| ----------------------------- | ------------------------------ | ----------------------- | -------------- | -------------------------- | ---------------------------------------- |
| প্রতি server নিজের, পুরো সীমা | ✗ সীমা × server                | না                      | ০              | ০                          | কখনো না (শুধু server এর নিজের সুরক্ষায়) |
| সীমা / N                      | সমান traffic এ ✓               | **৭৮%**                 | ০              | ০                          | Fallback হিসেবে, উদার করে (১.৭)          |
| কেন্দ্রে, atomic              | ✓ (১.০২x)                      | না                      | p99 ~১.৩ ms    | প্রতি request এ ১          | Default, ছোট আর মাঝারি key               |
| কেন্দ্রে, GET + SET           | ✗ আক্রমণে ৫.৮x                 | না                      | দুই round trip | প্রতি request এ ২          | কখনো না                                  |
| Token lease                   | ✓ (lease × server ≤ burst হলে) | lease বড় হলে           | বেশিরভাগ ০     | প্রতি lease এ ১ (৪ গুণ কম) | বড় আর ব্যস্ত key, hot tenant            |
| Async sync                    | শান্তে ✓, আক্রমণে ২–৭x         | না                      | ০              | server × sync এর হার       | মোটা সুরক্ষা, অনেক জায়গা জুড়ে (edge)   |

### ১.৬ Deep dive ২ — Hot tenant

Customer এর traffic সমান না। `npm run hotkey`: ৫ লাখ request/s, তিন লাখ সক্রিয় key, Zipf (s = ১):

```
biggest tenant: 37,911 req/s (7.6%); tenants above 1,000/s: 37

plan                                          total op/s  avg shard  busiest shard  of capacity  busiest / avg
one op per request, 16 shards                    500,000     31,250         63,494          63%          2.03x
the same, 32 shards                              500,000     15,625         52,306          52%          3.35x
leases on big tenants (> 1,000/s)                413,256     25,828         33,521          34%          1.30x
big tenants' keys split 8 ways (rl:k#0..7)       500,000     31,250         36,431          36%          1.17x
```

- **একজন customer একটা shard এর অর্ধেকের বেশি।** ১.৩ এর hash tag এর দাম: একটা customer এর সব key একটা shard এ। গড় shard ৩১k, ব্যস্ততম ৬৩k।
- **Shard দ্বিগুণ করলে প্রায় কিছুই বদলায় না** (৬৩k থেকে ৫২k), কারণ একটা key ভাগ হয় না। 10.1 আর 4.6 এর hot key, এবার limiter এ। গড় অর্ধেক হলো, ব্যস্ততম প্রায় একই, অনুপাত খারাপ হলো (৩.৩৫x)। Experiment ৪ (s = ১.২): ব্যস্ততম shard ক্ষমতার ১১৪%, আর ৩২টা shard এও ১০৭%। তখন আর ঐচ্ছিক না।
- **Lease শুধু ৩৭টা বড় tenant এ** মোট op ১৭% আর ব্যস্ততম shard অর্ধেক করে। Lease এর আকার ১.৫ এর নিয়মে: সীমার ০.২ s এর burst ÷ ৪০০ server, সবচেয়ে বড় customer এ ১৮টা token।

**Key Splitting** — একটা বড় key এর সীমাকে K টা ভাগে ভাগ করা (`rl:{acme#0}` ... `rl:{acme#7}`, প্রতিটা আলাদা shard এ, প্রতিটায় সীমা / K), আর প্রতিটা request একটা ভাগ **এলোমেলো** বাছে। ১.৫ এর "সীমা / N" এর মতো শোনায়, কিন্তু পার্থক্যটা মূল: সেখানে ভাগ ঠিক হতো কোন server এ request এলো তা দিয়ে, যেটা skewed; এখানে ভাগ ঠিক হয় একটা এলোমেলো সংখ্যা দিয়ে, তাই ভাগগুলোয় traffic নিজেই সমান। দাম: কয়েকটা ভাগের এলোমেলো ওঠানামা (ছোট সীমায় বেশি), আর একটা Lua script এ সব নিয়ম একসাথে দেখার সুবিধা হারানো (ভাগগুলো আলাদা shard এ)। তাই key ভাগ শুধু সত্যিকারের বড় key এ, যাদের সীমা এত বড় যে ভাগের ওঠানামা নগণ্য।

### ১.৭ Deep dive ৩ — Limiter ধীর বা মরলে

Rate limiter একটা সুরক্ষা। কিন্তু প্রতিটা request এর পথে বসে থাকে বলে, তার নিজের ব্যর্থতা পুরো API কে ফেলে দিতে পারে। 9.5 বলেছিল "fail open না closed, endpoint ধরে"। আজ প্রশ্নটা কঠিন রূপে: Redis **মরে না, ধীর হয়**, বা network এ blackhole (উত্তর আসেই না)। `npm run failure`: একটা shard এর key গুলো, ২০০টা সাধারণ key (সীমার নিচে) আর একটা abuser (সীমার ১০ গুণ), ৫০টা API server:

```
── store slow (median 40 ms) ──
policy                                                  extra p50  extra p99  hanging per server  ordinary blocked   abuser got
no timeout, wait for the answer                             40 ms     128 ms                  57              0.0%   1.1x limit
timeout 5 ms → fail open                                  5.00 ms    5.00 ms                   6              0.0%  10.1x limit
timeout 5 ms → fail closed (503)                          5.00 ms    5.00 ms                   6            100.0%   0.0x limit
timeout 5 ms → local bucket (limit / N)                   5.00 ms    5.00 ms                   6             16.4%   1.0x limit
+ breaker → local bucket, generous (3 × limit / N)        0.00 ms    0.00 ms                   0              0.0%   3.1x limit

── blackhole on the store's network (no answer; TCP gives up after 30 s) ──
no timeout, wait for the answer                           30.00 s    30.00 s              37,500              0.0%   1.0x limit
timeout 5 ms → fail open                                  5.00 ms    5.00 ms                   6              0.0%  10.0x limit
timeout 5 ms → fail closed (503)                          5.00 ms    5.00 ms                   6            100.0%   0.0x limit
timeout 5 ms → local bucket (limit / N)                   5.00 ms    5.00 ms                   6             16.2%   1.0x limit
+ breaker → local bucket, generous (3 × limit / N)        0.00 ms    0.00 ms                   0              0.0%   3.1x limit
```

- **Timeout ছাড়া limiter পুরো API কে নামায়।** ধীর অবস্থায় প্রতিটা request এ ৪০ ms (p99 ১২৮), আর blackhole এ ৩০ সেকেন্ড, প্রতিটা server এ একসাথে ৩৭,৫০০টা request ঝুলে থাকে: memory, socket, thread শেষ। একটা "soft" সুরক্ষা তখন সবচেয়ে hard dependency (10.3)। তাই limiter এর call এর timeout তার latency এর বাজেটের কাছাকাছি (এখানে ৫ ms), আর কোনো retry না।
- **Timeout এর পরে কী?** Fail open (abuser পুরো ১০ গুণ পায়), fail closed (সবাই আটকায়, ১০০%)। মাঝের পথ: **local bucket (সীমা / N)**, প্রতিটা server নিজে আন্দাজে গোনে। Abuser কে সীমায় রাখে (১.০x), কিন্তু সাধারণ user দের **১৬%** আটকায়, ১.৫ এর অবস্থা ৪ এর কারণেই: সীমা / N ছোট আর traffic এলোমেলো।
- **Breaker + উদার fallback।** Breaker (9.4) কয়েকটা ব্যর্থতার পরে কিছুক্ষণ limiter কে জিজ্ঞেসই করে না, তাই প্রতিটা request এ ৫ ms এর timeout ও আর দিতে হয় না (বাড়তি latency শূন্য)। আর fallback এর সীমা উদার, ৩ × সীমা / N: সাধারণ user দের ০% আটকায়, আর abuser পায় সীমার ৩.১ গুণ। Experiment ৩: timeout ৫০ ms হলে ধীর অবস্থায় প্রতিটা request এ ৪০-৫০ ms, আর ৪৮টা request ঝুলে থাকে।

**Degraded Mode (local fallback limit)** — কেন্দ্র না পেলে প্রতিটা server নিজের memory তে একটা আন্দাজের সীমা চালায়; সীমার একটা ভাগ, উদারতার একটা গুণক সহ। গুণকটা একটা সচেতন সিদ্ধান্ত: কম হলে limiter এর বিভ্রাটে বৈধ customer আটকায় (আপনার outage তাদের outage হয়), বেশি হলে abuser কিছুক্ষণ বেশি পায়। বেশিরভাগ API এর জন্য সঠিক দিক উদার, কারণ abuser এর ৩ গুণ কয়েক মিনিটের জন্য downstream এর bulkhead আর breaker (9.4) সামলায়, কিন্তু সব customer এর ১৬% ব্যর্থতা সরাসরি SLO ভাঙে।

আর তাই নিয়মের `failMode` আছে। Login: `closed` (সীমা ছাড়া brute force চলবে না, ৫০৩ আর `Retry-After`); সাধারণ API: `local` উদার; একটা সস্তা, শুধু পড়ার endpoint: `open`।

### ১.৮ একটা আসল limiter: service, client, আর দুটো API server

`npm run smoke` সব সিদ্ধান্ত একসাথে চালায়: একটা Express limiter service (`/v1/check`, `/v1/lease`, Zod দিয়ে নিয়ম), একটা client library (timeout `AbortSignal.timeout` দিয়ে, breaker, lease, নিয়ম ধরে fail mode, local fallback), আর API server যারা client কে middleware থেকে ডাকে:

```
#   step                                                      result
1   key acme: 15 on A, 15 on B, alternating                   A: 200 × 5, 429 × 10 | B: 200 × 5, 429 × 10
2   the last 429's headers                                    Retry-After: 1, source: limiter
3   clock forward 1 s, 12 more                                200 × 10, 429 × 2
4   key big-plain (1,000/s): 100 on A, check on every request  200 × 100; 100 calls to the limiter
5   key big-co: 100 to the API with leases (5)                200 × 100; 20 lease calls to the limiter
6   limiter 200 ms slow, timeout 20 ms: GET /data (local)     200, source: fallback, under 100 ms
7   at the same time POST /login (fail closed)                503, Retry-After: 1, under 100 ms
8   limiter down: 8 GET /data on A                            200 × 5, 429 × 3; source: fallback
9   network calls toward the limiter during that              3 (the breaker opens after 3 failures)
10  limiter down: POST /login                                 503, Retry-After: 1
11  limiter back, 300 ms after the breaker                    200, source: limiter, 1 network call(s)
```

- ধাপ ১: দুটো API server মিলে ঠিক ১০টা, কারণ গোনা কেন্দ্রে। 9.5 এর ৩x এর সমস্যা নেই।
- ধাপ ৫: lease এ একই ১০০টা request এ কেন্দ্রে ১০০ এর বদলে ২০টা call।
- ধাপ ৬-৭: limiter ধীর, কিন্তু API ১০০ ms এর আগেই উত্তর দেয়। `/data` fallback এ চলে, login ৫০৩ দেয়। একই বিভ্রাট, নিয়ম ধরে দুই আচরণ।
- ধাপ ৮: limiter বন্ধ থাকলেও fallback সীমা মানে (৫টা পাশ, তারপর ৪২৯, এখানে ২টা server, তাই সীমা / ২)। ধাপ ৯: প্রথম তিনটা ব্যর্থতার পরে breaker খোলে, আর বাকি request গুলো network এ যায়ই না।
- ধাপ ১১: limiter ফিরলে breaker এর সময় শেষে একটা call, আর আবার কেন্দ্রের হিসাব।

### ১.৯ একাধিক region (মাপা না, চিন্তার জন্য)

Customer এর সীমা যদি "সারা পৃথিবী মিলিয়ে ১০,০০০/s" হয়, আর API তিনটা region এ: প্রতি request এ অন্য region এর কেন্দ্রে যাওয়া অসম্ভব (১০০+ ms, 10.8)। পথ দুটো: (১) প্রতিটা region এর নিজের কেন্দ্র আর নিজের **বাজেট** (সীমার একটা ভাগ), আর বাজেট গুলো কয়েক সেকেন্ড পরপর region গুলোর আসল ব্যবহার দেখে নতুন করে ভাগ করা: ১.৫ এর async sync, region এর মাপে, আর তার দাম (sync এর জানালায় ভুল) মেনে নিয়ে। (২) Customer এর একটা home region (10.8 এর cell), আর তার সব traffic সেখানে। বেশিরভাগ API এর জন্য (১) যথেষ্ট, কারণ সুরক্ষার সীমায় কয়েক সেকেন্ডের ভুল চলে। Quota এই প্রশ্ন থেকে মুক্ত, কারণ সেটা usage event থেকে গোনা হয় (১.১), যেটা region জুড়ে দেরিতে এক জায়গায় আসে।

### ১.১০ Step 5 — Trade-off আর wrap-up

**চূড়ান্ত নকশা:**

- **কোথায়:** gateway এর ভেতরে client library, সরাসরি Redis cluster এ (১০টা shard, AZ জুড়ে replica সহ)। নিয়ম একটা config service এ, প্রতিটা gateway তে cache।
- **কীভাবে গোনা:** সাধারণ key এ প্রতি request এ একটা Lua script (সব নিয়ম একসাথে, hash tag এ একই shard)। বড় key (> ১,০০০/s) এ token lease, আকার হার থেকে (lease × server ≤ burst)। সবচেয়ে বড় কয়েকটা key এ key splitting।
- **ব্যর্থতা:** ৫ ms timeout, retry নেই, breaker, তারপর নিয়মের `failMode`: সাধারণ API তে উদার local fallback (৩ × সীমা / N), login এ closed, সস্তা পড়ায় open।
- **Quota:** rate limiter এ না। Usage event → log → গোনা → টেকসই database; শেষ হলে flag নিয়মে।
- **যা ইচ্ছা করে নেই:** GET + SET (race), সীমা / N কে মূল কৌশল হিসেবে (skewed traffic এ ৭৮% ভুল), async sync মূল সুরক্ষায় (আক্রমণে ২-৭x), sliding log সাধারণ নিয়মে (৪.৮ GB)।

**কী আগে ভাঙবে:** hot tenant (Zipf আরও তীক্ষ্ণ হলে একটা shard এর ১০০% ছাড়ায়, তাই lease আর splitting প্রথম দিন থেকে বড় key এর জন্য তৈরি রাখা); limiter এর নিজের metric না থাকা (৪২৯ এর হার, fallback এ চলা request এর হার, breaker খোলার ঘটনা), কারণ fallback এ চলা limiter বাইরে থেকে সুস্থ দেখায়; আর নিয়মের ভুল বদল (একটা শূন্য বেশি বা কম), যা deploy ছাড়াই সব customer কে আটকাতে পারে। তাই নিয়মের বদলও 10.6 এর মতো ধাপে ধাপে, আগে "শুধু গুনুন, আটকাবেন না" (shadow mode) এ।

---

## ২. Interview Angle

"Design a rate limiter" সবচেয়ে প্রচলিত প্রশ্নগুলোর একটা, আর প্রায়ই দুই স্তরে আসে: প্রথমে algorithm (9.5), তারপর "এখন এটা ৫০০ server এ"। দ্বিতীয় স্তরটাই senior কে আলাদা করে। ভালো উত্তরের আকৃতি:

1. **সীমা কিসের জন্য, আগে।** সুরক্ষা (rate limit) আর চুক্তি (quota) আলাদা, আলাদা store, আলাদা সঠিকতা। কী ধরে (key, IP, endpoint), কয়টা নিয়ম।
2. **সংখ্যা।** Op/s থেকে shard, memory যে সমস্যা না সেটা বলা, latency এর বাজেট (API এর p99 এর ২%), আর cross-AZ এর মতো লুকানো খরচ।
3. **কোথায় গুনব, চারটা অবস্থায়।** কেন্দ্রে atomic default; GET + SET কেন ভুল (lost update, আক্রমণে বাড়ে); সীমা / N কেন skewed traffic এ ভাঙে; lease আর তার আকারের নিয়ম; async sync কোথায় চলে।
4. **ব্যর্থতা।** Timeout বাজেটের ভেতরে, breaker, নিয়ম ধরে fail mode, fallback এর উদারতা আর তার দাম।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Redis কেন? প্রতিটা server নিজে গুনলেই তো দ্রুত।"_ — নিজে গুনলে সীমা × server (9.5)। সীমা / N দিলে সমান traffic এ ঠিক, কিন্তু traffic কয়েকটা server এ জমলে সীমার নিচের customer এর ৭৮% আটকায়, আর autoscale এ সীমা কমে।
- _"প্রতি request এ Redis এ যাওয়া কি latency এ খুব দামি না?"_ — Same-AZ এ p99 ~১ ms, বাজেটের ভেতরে। বড় key এ lease (৪ গুণ কম call)। আর কখনো retry না, timeout বাজেটের কাছে।
- _"Hot customer?"_ — Hash tag এ তার সব key এক shard এ। Shard বাড়ানো কাজ করে না। Lease বা key splitting (এলোমেলো ভাগ, সমান traffic)।
- _"Redis মরলে?"_ — "Fail open" বললে থামবেন না। ধীর হওয়া মরার চেয়ে খারাপ (timeout না থাকলে প্রতিটা server এ হাজার হাজার request ঝুলে)। নিয়ম ধরে আচরণ, আর local fallback এর উদারতার দাম সংখ্যায়।
- _"দুটো region এ একটা global সীমা?"_ — প্রতি request এ region পার হওয়া চলবে না। Region প্রতি বাজেট আর কয়েক সেকেন্ড পরপর ভাগ বদলানো, sync এর জানালার ভুল মেনে।
- _"Customer এর মাসিক quota এই একই system এ?"_ — না: quota টাকা, তাই টেকসই আর নির্ভুল, usage event থেকে গোনা। Rate limiter শুধু একটা "শেষ" flag পায়।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ঘটনা: limiter এর timeout না থাকা বা লম্বা থাকা, আর Redis এর একটা ধীর মুহূর্তে পুরো API এর latency লাফানো (সুরক্ষা নিজেই outage); নিয়মের একটা ভুল বদল যা সবাইকে আটকায়; একজন বড় customer এর key একটা Redis shard কে গরম করা; limiter এর metric না থাকায় fallback এ চলা দিনের পর দিন কেউ না জানা; আর quota কে rate limiter এর store এ রাখা, তারপর একটা failover এ মাসের হিসাব হারানো।

---

## ৩. Key Takeaway

- **Rate limit সুরক্ষা, quota চুক্তি।** প্রথমটা দ্রুত আর আন্দাজে চলে, হারালে ক্ষতি নেই; দ্বিতীয়টা টাকা, usage event থেকে টেকসই ভাবে গোনা। একই store এ রাখলে eviction বা failover টাকা হারায়
- **Limiter এর চাপ op/s এ, memory তে না।** তিন লাখ key ৯০ MB, কিন্তু ৫ লাখ op/s মানে ১০টা shard আর মাসে হাজার ডলারের cross-AZ। সব নিয়ম একটা Lua script এ (hash tag এ একই shard) অর্ধেক খরচ
- **Atomic না হলে সীমা ফাঁস হয় আক্রমণের সময়:** GET + SET স্বাভাবিকে ১.৩৫x, ২০ গুণ চাহিদায় ৫.৮x — 5.5 এর lost update
- **সীমা / N skewed traffic এ ভাঙে:** সীমার নিচের customer এর ৭৮% আটকায়, আর server বাড়লে আরও। **Async sync** শান্ত অবস্থায় নিখুঁত, আক্রমণে ২x (sync ৫০০ ms এ ৭x)
- **Token lease কেন্দ্রের চাপ কমায় সীমা না ভেঙে, যদি lease × server ≤ burst।** নইলে token শান্ত server এ আটকে থাকে (lease ২০ এ ১১.৬% ভুল আটকানো)। আকার হার থেকে আসা উচিত
- **Hot tenant কে বেশি shard বাঁচায় না** (৬৩k → ৫২k)। Lease বা এলোমেলো key splitting
- **Limiter মরলে API মরা উচিত না।** Timeout ছাড়া blackhole এ প্রতি server এ ৩৭,৫০০টা ঝুলে থাকা request। ৫ ms timeout, retry নেই, breaker, নিয়ম ধরে fail mode; আর fallback এর উদারতা একটা দাম: কৃপণ (সীমা / N) এ বৈধ user এর ১৬% আটকায়, উদার (৩×) এ abuser ৩ গুণ পায়

---

## ৪. নতুন Term (Glossary)

| Term                                     | অর্থ                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quota (বনাম Rate Limit)**              | Rate limit একটা সুরক্ষা (সেকেন্ডে কত), আন্দাজ চলে, অবস্থা হারালে ক্ষতি নেই; quota একটা চুক্তি (মাসে কত, তার পরে বিল), নির্ভুল আর টেকসই হতে হয় — usage event থেকে গোনা, rate limiter এর store এ না |
| **Hash Tag**                             | Redis Cluster এ key এর `{...}` এর ভেতরের অংশ দিয়েই hash slot হিসাব — একটা customer এর সব নিয়মের key একই shard এ, তাই একটা Lua script সবগুলো একসাথে দেখতে পারে; দাম, তার সব চাপ এক shard এ        |
| **Approximate Sync**                     | প্রতিটা server নিজে গোনে আর প্রতি T ms এ কেন্দ্রে মোট মেলায়; request এর পথে network নেই, কিন্তু sync এর জানালায় সবাই অন্ধ — আক্রমণে সীমার কয়েক গুণ, T আর server সংখ্যার সাথে বাড়ে              |
| **Token Lease**                          | Server কেন্দ্র থেকে একবারে কয়েকটা token মেয়াদ সহ ধার নেয় আর local এ খরচ করে; কেন্দ্র সত্য থাকে, call কমে — শর্ত lease × server ≤ burst, নইলে token আটকে থেকে বৈধ request আটকায়                 |
| **Key Splitting**                        | একটা বড় key এর সীমা K ভাগে, আলাদা shard এ; প্রতিটা request একটা ভাগ এলোমেলো বাছে, তাই ভাগে traffic সমান — hot tenant এর চাপ ছড়ায়, দাম ছোট সীমায় ওঠানামা আর এক script এ সব নিয়ম না             |
| **Degraded Mode (Local Fallback Limit)** | কেন্দ্র না পেলে প্রতিটা server নিজে সীমার একটা ভাগ × উদারতার গুণক চালায় — কৃপণ হলে বৈধ user আটকায়, উদার হলে abuser বেশি পায়; নিয়ম ধরে fail open/closed এর মাঝের পথ                             |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. একজন enterprise customer support ticket খুলল: "আমাদের plan এ ১,০০০/s, আমাদের dashboard বলছে আমরা ৬০০/s পাঠাচ্ছি, অথচ ৪২৯ পাচ্ছি, বিশেষ করে সকালে।" এই lesson এর কোন কোন কারণে এটা হতে পারে (অন্তত চারটা)? প্রতিটার জন্য কোন metric বা log দেখে নিশ্চিত হবে? আর কোনটা customer এর দোষ, কোনটা আপনার?

2. API এ একটা নতুন endpoint: `POST /exports`, যা একটা বড় report বানায়, ৫ থেকে ৬০ সেকেন্ড লাগে, আর database এ ভারী query চালায়। সাধারণ request এর সীমা (১,০০০/s) এখানে কেন অর্থহীন? (ক) "প্রতি সেকেন্ডে কতগুলো" এর বদলে কী সীমা দরকার, আর Little's law এর সাথে এর সম্পর্ক কী? (খ) একটা request কে কম বা বেশি "দামি" ধরা (cost) এর নকশা কেমন হবে? (গ) এই সীমা মরলে fail mode কী?

3. TaskFlow এর মতো একটা SaaS এর নিজের service গুলোর মধ্যেও (9.x) সীমা চায়: billing service সেকেন্ডে ২,০০০ এর বেশি call নিতে পারে না, আর তাকে ডাকে ছয়টা আলাদা service। একজন বলল "billing এর সামনে একই rate limiter বসাই।" (ক) বাইরের customer এর সীমা আর ভেতরের service এর সুরক্ষার মধ্যে মূল পার্থক্য কী? (খ) কেন এখানে ৪২৯ ফেরত দেওয়ার চেয়ে অন্য কিছু ভালো হতে পারে (9.4, 7.4)? (গ) ছয়টা caller এর মধ্যে ২,০০০ কে কীভাবে ভাগ করবেন, আর একটা caller চুপ থাকলে তার ভাগ কী হবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

সম্ভাব্য কারণ, প্রতিটার প্রমাণ সহ:

1. **Degraded mode.** Limiter এর একটা shard সকালে ধীর (সকালের peak), breaker খোলে, আর server গুলো local fallback এ চলে। Fallback কৃপণ হলে (সীমা / N), traffic এর ছড়ানো ঠিক না থাকলে সীমার নিচেই আটকায় (১.৭ এর ১৬%)। প্রমাণ: ৪২৯ এর response এ উৎসের header (`X-RateLimit-Source: fallback`, exercise এর মতো), আর limiter এর metric এ fallback এ চলা request এর হার, shard ধরে। **আপনার দোষ।**
2. **Lease এর আটকে থাকা token.** Customer এর traffic কয়েকটা server এ জমে আছে, আর lease এর আকার স্থির আর বড়: বাকি server গুলোর হাতে token আটকে (১.৫ এর ১১.৬%)। প্রমাণ: server ধরে এই key এর lease আর ব্যবহারের অনুপাত, মেয়াদ শেষে না খরচ হওয়া token এর metric। **আপনার দোষ।**
3. **Burst, গড় না.** Dashboard এ ৬০০/s মানে মিনিটের গড়। Customer এর job হয়তো প্রতি মিনিটের শুরুতে ২ সেকেন্ডে ১৮,০০০ পাঠায় (সকালে cron)। Burst ২০০ হলে সেই মুহূর্তে সত্যিই সীমার উপরে। প্রমাণ: সেকেন্ড ধরে (বা ১০০ ms ধরে) histogram, গড় না (10.4)। **Customer এর আচরণ**, তবে আপনার dashboard তাকে ভুল ছবি দেখাচ্ছে, সেটা আপনার।
4. **একাধিক নিয়ম.** Key এর সীমা ১,০০০ কিন্তু একটা endpoint এর নিজের সীমা (search ৫০/s), আর সকালে customer search বেশি করে। প্রমাণ: ৪২৯ এর response এ কোন নিয়মে আটকাল (নিয়মের নাম header এ বা log এ)। **কারো দোষ না, contract অস্পষ্ট**: সব নিয়ম customer এর documentation এ।
5. **Retry গোনা.** Customer এর client ৪২৯ পেয়ে সাথে সাথে retry করে, `Retry-After` না মেনে; প্রতিটা retry ও গোনা হয়, তাই আসল চাহিদার চেয়ে বেশি দেখায়। প্রমাণ: একই request id বা একই payload এর পুনরাবৃত্তি। **Customer এর**, কিন্তু তাকে দেখানো উচিত।

শিক্ষা: প্রতিটা ৪২৯ এ তিনটা জিনিস log এ: কোন নিয়ম, কোন উৎস (কেন্দ্র, lease, fallback), আর তখন কেন্দ্রের হিসাবে বাকি কত। এগুলো ছাড়া এই ticket এর উত্তর অনুমান।

**প্রশ্ন ২:**

(ক) Export এর ক্ষতি আসে **একসাথে কতগুলো চলছে** তা থেকে, সেকেন্ডে কতগুলো শুরু হলো তা থেকে না। সেকেন্ডে ১টা export, প্রতিটা ৬০ সেকেন্ড, মানে একসাথে ৬০টা ভারী query (Little's law: একসাথে = হার × সময়)। তাই **concurrency limit**: প্রতি customer এ একসাথে সর্বোচ্চ ২টা export, আর পুরো system এ ২০টা। নকশা: শুরুতে Redis এ একটা counter বাড়ানো (`INCR`, সীমা পার হলে কমিয়ে ৪২৯), শেষে কমানো। আর যেহেতু server মরে গেলে "শেষ" ডাকা হয় না, প্রতিটা slot একটা lease (মেয়াদ সহ, কাজ চলাকালীন নবায়ন), নইলে মরা server এর slot চিরকাল আটকে থাকে। (Stripe এর প্রকাশিত লেখায় "concurrent requests limiter" ঠিক এই কাজের জন্য আলাদা করে বলা আছে।) আরও ভালো: export কে sync request না রেখে job বানানো (7.3): `POST /exports` → 202 আর একটা job id, আর worker এর সংখ্যাই concurrency এর সীমা।

(খ) **Cost:** check এ `cost` (exercise এর API তে আছে) — সাধারণ request ১ token, search ৫, export ১০০। একই bucket, কিন্তু দামি কাজ বেশি খরচ করে। Cost আগে থেকে জানা না থাকলে (export এর আকার), একটা আনুমানিক cost আগে কাটুন, শেষে আসল দাম মিলিয়ে বাড়তি বা ফেরত (credit), কিন্তু শুধু হিসাবে, request কে আটকে না।

(গ) Export দামি আর ভারী: limiter না পেলে **fail closed** (৫০৩ আর `Retry-After`), বা একটা খুব কৃপণ local fallback (প্রতি server এ ১টা)। কারণ export এর জন্য অপেক্ষা করা চলে, কিন্তু সীমা ছাড়া export database কে ফেলে দিতে পারে, যা সব customer এর ক্ষতি।

**প্রশ্ন ৩:**

(ক) বাইরের সীমা **ন্যায্যতা আর চুক্তি**: প্রতিটা customer তার plan পায়, আর বেশি চাইলে প্রত্যাখ্যান। ভেতরের সুরক্ষা **ক্ষমতা**: billing এর মোট ২,০০০, আর সবাই একই কোম্পানির। কেউ "শত্রু" না, আর প্রত্যাখ্যান করা request টা প্রায়ই একটা user এর কাজ যা কোনো না কোনো সময়ে হতেই হবে।

(খ) ৪২৯ পেয়ে caller কী করবে? Retry (7.4) — আর যদি backoff আর jitter ঠিক না থাকে, retry storm। ভালো পথ: (১) caller এর দিকে **leaky bucket / client-side throttle** (9.5 এর TaskFlow এর migration script এর শিক্ষা): caller নিজেই সমান গতিতে পাঠায়, আর অতিরিক্ত কাজ queue তে অপেক্ষা করে। (২) Billing এর সামনে একটা queue (7.2): ঢেউ শোষণ করে, billing নিজের গতিতে নেয়। (৩) Billing নিজে **load shedding**: নিজের ক্ষমতা মেপে (latency বা concurrency), অগ্রাধিকার কম এমন call আগে ফেলে দেয় (10.3 এর brownout)। ভেতরে "প্রত্যাখ্যান" এর চেয়ে "অপেক্ষা করানো" প্রায়ই ভালো, কারণ কাজটা হারানো চলবে না।

(গ) ভাগ: প্রতিটা caller এর একটা নিশ্চিত ভাগ (ধরুন অগ্রাধিকার অনুযায়ী: checkout ৮০০, invoice ৪০০, বাকি চারটা ১০০ করে = ১,৬০০) আর বাকি ৪০০ একটা ভাগ করা pool, যে আগে আসে। আর চুপ থাকা caller এর নিশ্চিত ভাগ অন্যরা **ধার** নিতে পারে (work-conserving), কিন্তু সে ফিরলে তার ভাগ তাকে ফেরত দিতে হয়। এটা ঠিক token lease আর async sync এর চিন্তা: কয়েক সেকেন্ড পরপর আসল ব্যবহার দেখে ভাগ বদলানো। আর সবচেয়ে জরুরি: checkout এর ভাগ কখনো ধার দেওয়া যাবে না এমন একটা নিচের সীমা, কারণ সেটা টাকা।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (চারটা deterministic model আর একটা আসল limiter service + client library + API server; Docker বা Redis লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.2-rate-limiter-service/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.2-rate-limiter-service) — `npm install`, তারপর `npm run estimate`, `npm run accuracy`, `npm run hotkey`, `npm run failure`, `npm run smoke`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` op/s, shard, network, cross-AZ খরচ, memory আর latency এর বাজেট হিসাব করে। `accuracy` virtual time এ ছয়টা কৌশল (নিজের bucket, সীমা / N, atomic, GET + SET, token lease, async sync) চারটা অবস্থায় চালায়, আর lease এর আকারের sweep। `hotkey` Zipf tenant কে hash slot ধরে shard এ বসিয়ে ব্যস্ততম shard মাপে। `failure` store এর সুস্থ, ধীর আর blackhole অবস্থায় পাঁচটা নীতি তুলনা করে। `smoke` একটা আসল Express limiter, client library আর API server চালিয়ে ১১টা ধাপ যাচাই করে।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে (smoke তিনবার), output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, আপনার। **Estimation এর input ধরে নেওয়া** (৫ লাখ request/s, ৪০০ server, ২টা নিয়ম), আর Redis shard প্রতি "~১ লাখ op/s Lua সহ" একটা মোটামুটি আন্দাজ, মাপা না; cross-AZ এর দাম 10.7 এর মতো আনুমানিক। `accuracy`, `hotkey`, `failure` virtual time এর model: store এর RTT lognormal (median ০.৫ ms), GET + SET এর race model এ, আসল Redis এ না; async sync সরল (সব server একসাথে sync); breaker সরল। `smoke` আসল HTTP চালায় কিন্তু limiter এর store in-memory, Redis না, আর limiter এর ঘড়ি নকল। Envoy এর global rate limit service আর Stripe এর concurrent request limiter এর কথা প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। **যা মাপা হয়নি:** আসল Redis Cluster এর throughput আর latency, Lua script এর খরচ, hash tag এর আচরণ, একাধিক region।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `accuracy` চালানোর **আগে** লিখে ফেলুন: GET + SET এর race ২০ গুণ চাহিদায় সীমার কত গুণ ঢুকতে দেবে? ১.১x? ২x? ১০x? তারপর চালিয়ে মেলান, আর `RTT_MS=2` দিয়ে আবার: RTT বাড়লে race কেন বাড়ে?

2. **নিজের fallback:** `SLACK=1.5 npm run failure` আর `SLACK=5 npm run failure`। সাধারণ user এর আটকানো আর abuser এর পাওয়া কীভাবে বদলায়? আপনার API এর SLO ৯৯.৯% হলে, কোন গুণকে একটা ঘণ্টার limiter বিভ্রাট SLO ভাঙে না?

3. **Sync বনাম lease:** `SERVERS=200` দিয়ে `accuracy` চালান। Async sync এর কেন্দ্রের চাপ কেন request এর চেয়েও বেশি হয়ে গেল, আর lease এর কী হলো? কোন অবস্থায় async sync সত্যিই সস্তা?

4. **Code বদলানো:** README এর experiment ৫ (হার থেকে lease এর আকার)। তারপর `src/client.ts` এ "এই key আগামী `retryAfterMs` পর্যন্ত আটকানো" এর একটা local cache যোগ করুন, শুধু কেন্দ্রের `deny` এর জন্য। আক্রমণের মতো একটা ধাপ `smoke` এ যোগ করে দেখান কেন্দ্রের call কতটা কমে।

5. **Design অংশ:** এই limiter এর একটা "এক পাতার design doc", Lesson 1.2 এর পাঁচ ধাপে: (ক) rate limit আর quota এর আলাদা requirement, (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত, (গ) limiter কোথায় বসে আর কেন, (ঘ) গোনার কৌশল, চারটা অবস্থার সংখ্যা সহ, (ঙ) ব্যর্থতার runbook: কোন নিয়মের কোন fail mode, fallback এর গুণক, আর কোন তিনটা metric দেখে জানবেন limiter fallback এ চলছে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ), 11.1
Current: 11.2 — Case Study: Design a Rate Limiter Service
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ — URL shortener (11.1)।
Case study ২ — rate limiter service: ৫ লাখ request/s, ৪০০ API server, ৩ লাখ সক্রিয় key। Rate limit (সুরক্ষা,
Redis) আর quota (চুক্তি, usage event → টেকসই গোনা) আলাদা। Gateway এর ভেতরে client library → Redis cluster
(১০ shard; memory মাত্র ৯০ MB, চাপ op/s এ); সব নিয়ম একটা Lua script এ, hash tag এ একই shard (op আর cross-AZ
অর্ধেক, ~$৫k/মাস)। গোনা: সাধারণ key এ প্রতি request এ atomic; বড় key এ token lease (lease × server ≤ burst,
আকার হার থেকে); সবচেয়ে বড় key এ এলোমেলো key splitting। বাদ: GET + SET (আক্রমণে ৫.৮x), সীমা / N মূল কৌশলে
(skewed এ ৭৮% ভুল আটকানো), async sync মূল সুরক্ষায় (আক্রমণে ২–৭x)। ব্যর্থতা: ৫ ms timeout, retry নেই, breaker,
নিয়ম ধরে fail mode (API উদার local fallback ৩×, login closed); timeout ছাড়া blackhole এ প্রতি server এ ৩৭,৫০০
ঝুলে থাকা request। Multi-region: region প্রতি বাজেট, কয়েক সেকেন্ডে ভাগ বদল।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (বনাম Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit)
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: 11.3 — Case Study: Design a Chat System (WhatsApp-style)
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **এই মাপে প্রশ্নটা algorithm না, "কোথায় আর কতবার গুনব"।** প্রতিটা কৌশল একটা অবস্থায় নিখুঁত দেখায়, আর অন্য একটা অবস্থায় ভাঙে: GET + SET আক্রমণে, সীমা / N skewed traffic এ, async sync burst এ, lease বড় হলে। তাই চারটা অবস্থাতেই মাপুন, শুধু সুন্দর অবস্থায় না। আর একটা সুরক্ষা যা প্রতিটা request এর পথে বসে, তার নিজের ব্যর্থতাই সবচেয়ে বড় ঝুঁকি: timeout, breaker, আর আগে থেকে ঠিক করা fail mode ছাড়া সেটা আপনার outage এর কারণ হয়।

রেডি হলে `next` লিখুন — **Lesson 11.3: Design a Chat System (WhatsApp-style)** এ যাব। প্রথমবার এমন একটা system যেখানে server কে নিজে থেকে client এর কাছে কথা পৌঁছাতে হয়, লাখ লাখ খোলা connection এর উপর দিয়ে (2.4 এর WebSocket, এবার মাপে)। প্রশ্নগুলো নতুন: একটা message কোন server এ পৌঁছাবে যখন প্রাপক অন্য server এ connected? Offline user এর message কোথায় অপেক্ষা করে? দুটো message এর ক্রম কে ঠিক করে (6.4 এর ঘড়ি ফিরে আসবে)? আর "delivered" আর "read" এর দুটো টিক আসলে কতগুলো লেখা?
