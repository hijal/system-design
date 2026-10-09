# Rate Limiter Service Lab - Estimation, Accuracy বনাম Latency, Hot Tenant, Failure, আর একটা আসল Limiter

> Lesson 11.2 - Case Study: Design a Rate Limiter Service · **Tier 1 - Runnable Code**
> (চারটা deterministic model আর একটা আসল limiter service + client + দুটো API server; Docker বা Redis লাগে না)

## কী বানাচ্ছি

9.5 এ rate limiting এর algorithm ছিল একটা process এর ভেতরে। এখানে প্রশ্নটা একটা **service** এর: শত শত API server, লাখ লাখ
request/s, একটা ভাগ করা store। কত shard আর কত খরচ? প্রতি request এ কেন্দ্রে যাওয়া, সীমা ভাগ করা, token lease, আর async sync -
কোনটা কতটা ঠিক, কত দ্রুত, আর কেন্দ্রে কত চাপ দেয়? একজন বড় customer একটা shard কে কতটা চাপে? আর store ধীর বা বন্ধ হলে API
এর কী হয়?

| Script             | প্রশ্ন                                                                                         | Lesson § |
| ------------------ | ---------------------------------------------------------------------------------------------- | -------- |
| `npm run estimate` | ৫ লাখ request/s এ Redis op, shard, network, cross-AZ খরচ, memory, latency এর বাজেট             | ১.২      |
| `npm run accuracy` | ৬টা কৌশল × ৪টা অবস্থা - গৃহীত হার, ভুল করে আটকানো, কেন্দ্রের op, বাড়তি latency; lease এর আকার | ১.৫      |
| `npm run hotkey`   | Zipf tenant এ ব্যস্ততম shard - বেশি shard, lease, key ভাগ করা                                  | ১.৬      |
| `npm run failure`  | Store সুস্থ, ধীর, blackhole - timeout, fail open/closed, local fallback, breaker               | ১.৭      |
| `npm run smoke`    | আসল HTTP: limiter service, client library (timeout, breaker, lease, fallback), দুটো API server | ১.৮      |

**সৎ নোট:**

- **Estimation এর input ধরে নেওয়া** - ৫ লাখ request/s, ৪০০ API server, প্রতি request এ ২টা নিয়ম। Redis shard প্রতি "~১ লাখ
  op/s Lua সহ" একটা মোটামুটি আন্দাজ (script এর আকার, hardware, pipelining এর উপর অনেক নির্ভর করে), এখানে মাপা না। Cross-AZ এর
  দাম $0.01/GB প্রতি দিকে (10.7 এর মতো), আনুমানিক।
- **`accuracy`, `hotkey`, `failure` virtual time এর model**, আসল Redis বা network না। Store এর RTT lognormal (median ০.৫ ms)।
  "GET তারপর SET" এর race model এ দেখানো, Redis এ চালানো না। Async sync এর model সরল: সব server একসাথে sync করে।
- **`failure` এর breaker সরল** - ১ s এ ২০টা ব্যর্থতায় ৫ s খোলা, সব server একই জিনিস দেখে বলে ধরা।
- **`smoke` আসল HTTP চালায়** (একটা limiter, চারটা API app, এক process এ), কিন্তু limiter এর store in-memory `Map`, Redis না।
  Limiter এর ঘড়ি নকল (deterministic); client এর breaker আসল ঘড়ি ব্যবহার করে। Latency এর সংখ্যা ছাপা হয় না, শুধু "১০০ ms এর
  কম" কিনা।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে (smoke তিনবার), output
  byte ধরে হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run estimate
npm run accuracy
npm run hotkey
npm run failure
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` - সব নিয়ম একটা Lua script এ রাখলে op আর খরচ অর্ধেক:

```
a separate Redis call per rule                    1,000,000          20      300 MB/s         $10,368
all rules in one Lua script (on the same shard)    500,000          10      150 MB/s          $5,184
```

`npm run accuracy` - atomic না হলে race এ সীমা ফাঁস; async sync আক্রমণে ২ গুণ; সীমা ভাগ করা skewed traffic এ ভুল আটকায়;
lease × server burst ছাড়ালে ভুল আটকানো লাফায়:

```
── attack: demand 20× the limit, spread evenly over 50 servers ──
central, every request, atomic (Lua)                   1,020     1.02x             1.20x    94.9%        20,033    0.50 ms    1.27 ms
central, GET then SET (not atomic)                     5,799     5.80x             7.33x    71.1%        40,065    1.04 ms    2.04 ms
local + sync every 100 ms (async)                      2,016     2.02x             2.08x    89.9%           495    0.00 ms    0.00 ms
── demand at 80% of the limit (nobody should be blocked), 90% of traffic on 5 servers ──
split the limit (limit / N on each server)               176     0.18x             0.20x    78.3%             0    0.00 ms    0.00 ms
token lease (4 at a time, wait if not granted)           813     0.81x             0.88x     0.0%           215    0.00 ms    0.99 ms
20                 1,000                   0.89x           341             11.6%           108
```

`npm run hotkey` - shard দ্বিগুণ করলে ব্যস্ততম shard প্রায় একই; lease বা key ভাগ করলে নামে:

```
one op per request, 16 shards                    500,000     31,250         63,494          63%          2.03x
the same, 32 shards                              500,000     15,625         52,306          52%          3.35x
leases on big tenants (> 1,000/s)                413,256     25,828         33,521          34%          1.30x
```

`npm run failure` - timeout ছাড়া blackhole এ প্রতি server এ হাজার হাজার ঝুলে থাকা request; breaker + উদার fallback এ বাড়তি
latency শূন্য, দাম abuser এর ৩ গুণ:

```
no timeout, wait for the answer                           30.00 s    30.00 s              37,500              0.0%   1.0x limit
timeout 5 ms → local bucket (limit / N)                   5.00 ms    5.00 ms                   6             16.2%   1.0x limit
+ breaker → local bucket, generous (3 × limit / N)        0.00 ms    0.00 ms                   0              0.0%   3.1x limit
```

`npm run smoke` - দুটো API server মিলে ঠিক ১০টা; lease এ ১০০ request এ ২০টা call; limiter ধীর বা বন্ধ হলেও API দ্রুত উত্তর
দেয়, login fail closed:

```
1   key acme: 15 on A, 15 on B, alternating                   A: 200 × 5, 429 × 10 | B: 200 × 5, 429 × 10
5   key big-co: 100 to the API with leases (5)                200 × 100; 20 lease calls to the limiter
6   limiter 200 ms slow, timeout 20 ms: GET /data (local)     200, source: fallback, under 100 ms
7   at the same time POST /login (fail closed)                503, Retry-After: 1, under 100 ms
9   network calls toward the limiter during that              3 (the breaker opens after 3 failures)
11  limiter back, 300 ms after the breaker                    200, source: limiter, 1 network call(s)
```

## কী দেখার জন্য এটা বানানো

- **Limiter এর চাপ op/s এ, memory তে না।** ৩ লাখ সক্রিয় key এর অবস্থা ৯০ MB; কিন্তু প্রতি request এ এক op মানে ৫ লাখ op/s আর
  ১০টা shard। নিয়মগুলো একটা Lua script এ মেলানো সবচেয়ে সস্তা জয়।
- **Atomic না হলে সীমা ফাঁস হয় ঠিক আক্রমণের সময়।** স্বাভাবিক চাপে ১.৩৫x, ২০ গুণ চাহিদায় ৫.৮x। 5.5 এর lost update।
- **সীমা ভাগ করা (সীমা / N) এর ভুল নির্ভর করে traffic কীভাবে ছড়ায় তার উপর।** সমান ভাগে প্রায় নিখুঁত, ৫টা server এ জমলে সীমার
  নিচের customer এর ৭৮% আটকায়।
- **Async sync দ্রুত আর সস্তা, কিন্তু sync এর জানালায় সবাই অন্ধ।** আক্রমণে ২ গুণ, sync ৫০০ ms হলে ৭ গুণ।
- **Token lease কেন্দ্রের চাপ কমায়, কিন্তু lease × server ≤ burst না হলে token আটকে থাকে** আর সীমার নিচের customer আটকায়।
- **Hot tenant কে বেশি shard বাঁচায় না।** একটা key একটা shard এ যায়। Lease বা key ভাগ করা লাগে।
- **Limiter মরলে API মরা উচিত না।** Timeout, breaker, আর নিয়ম ধরে fail mode। Fallback কৃপণ হলে বৈধ user আটকায়, উদার হলে abuser
  বেশি পায় - একটা সচেতন সিদ্ধান্ত।

## নিজে ভেঙে দেখুন (Experiments)

1. **ধীর sync:** `SYNC_MS=500 npm run accuracy`। আক্রমণে async sync কত গুণ ঢুকতে দেয় (মাপা: ৭.০২x, এক সেকেন্ডে ১০.০৯x)? Sync
   এর জানালা আর server সংখ্যার সাথে overshoot এর সম্পর্কটা নিজের ভাষায় লিখুন।
2. **বেশি server:** `SERVERS=200 npm run accuracy`। সীমার নিচের customer এর জন্য "সীমা ভাগ করে" কত গৃহীত (মাপা: ০.১০x)? Async
   sync এর কেন্দ্রের op কী হলো (১,৯৮০/s), আর কেন?
3. **লম্বা timeout:** `TIMEOUT_MS=50 npm run failure`। Store ধীর হলে fail open এ abuser কত পায় (মাপা: ৪.৪x), আর server এ কতগুলো
   request ঝুলে থাকে (৪৮)? ৫ ms এর তুলনায় কোনটা ভালো, কোনটা খারাপ?
4. **আরও তীক্ষ্ণ tenant:** `ZIPF_S=1.2 npm run hotkey`। ব্যস্ততম shard এর ক্ষমতার কত (মাপা: ১১৪%), আর ৩২টা shard এ (১০৭%)? এখন
   কোন পরিকল্পনা বাধ্যতামূলক?
5. **Code বদলানোর কাজ:** `src/client.ts` এ lease এর আকার স্থির (`leaseSize`) না রেখে key এর সাম্প্রতিক হার থেকে হিসাব করুন
   (ধরুন শেষ ১ s এ এই server এ যতগুলো request, তার ২০০ ms এর সমান)। `smoke` এর ধাপ ৫ এ lease call কত হয়, আর একটা নতুন, শান্ত
   key এ কী হয়?

## Project Structure

```
src/
  util.ts             seed দেওয়া PRNG, lognormal, percentile, টেবিলের format, env parse, fmix32
  sim.ts              token bucket আর virtual time এর event scheduler (min-heap)
  estimate.ts         script ক - op/s, shard, network, cross-AZ খরচ, memory, latency বাজেট
  accuracy.ts         script খ - ৬টা কৌশল × ৪টা অবস্থা, lease এর আকারের sweep
  hotkey.ts           script গ - Zipf tenant, hash slot → shard, lease আর key ভাগ
  failure.ts          script ঘ - store সুস্থ/ধীর/blackhole × ৫টা নীতি
  limiter-service.ts  Express limiter: POST /v1/check, POST /v1/lease, নিয়ম (Zod), নকল ঘড়ি, ধীর করার admin endpoint
  client.ts           client library: timeout (AbortSignal), breaker, lease, নিয়ম ধরে fail mode, local fallback
  api.ts              API app: middleware যা client কে ডাকে, 429/503 আর Retry-After
  smoke.ts            script ঙ - limiter + চারটা API app চালিয়ে ১১টা ধাপ
```

Environment variable: `API_RPS`, `API_SERVERS`, `ACTIVE_KEYS`, `RULES`, `SHARD_OPS`, `HEADROOM`, `STATE_BYTES`,
`MESSAGE_BYTES`, `CROSS_AZ_SHARE`, `CROSS_AZ_PER_GB`, `API_P99_MS`, `LIMITER_P99_MS`, `SERVERS`, `LIMIT`, `BURST`,
`SECONDS`, `RTT_MS`, `RTT_SIGMA`, `LEASE`, `LEASE_TTL_MS`, `SYNC_MS`, `HOT_SERVERS`, `HOT_SHARE`, `ZIPF_S`, `SHARDS`,
`BIG_TENANT_RPS`, `BURST_SECONDS`, `SPLIT`, `NORMAL_KEYS`, `NORMAL_DEMAND`, `NORMAL_LIMIT`, `ABUSER_DEMAND`,
`ABUSER_LIMIT`, `HEALTHY_MS`, `SLOW_MS`, `HANG_MS`, `TIMEOUT_MS`, `BREAKER_WINDOW_MS`, `BREAKER_OPEN_MS`, `PHASE_S`,
`PER_SERVER_RPS`, `SLACK`, `SEED`।
