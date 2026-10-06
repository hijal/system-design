# TaskFlow Observability Lab — Percentile, Cardinality, Sampling, Burn Rate, Distributed Trace

> Lesson 10.4 — Observability: Logging, Metrics, Tracing · **Tier 1 — Runnable Code** (চারটা script deterministic
> simulation; পঞ্চমটা localhost এ চারটা আসল HTTP service; Docker লাগে না)

## কী বানাচ্ছি

TaskFlow এর বৃহস্পতিবারের রহস্য — "board মাঝে মাঝে ৪–৫ সেকেন্ড, অথচ dashboard সবুজ" — আর সেটা খুঁজতে গিয়ে যা যা
ভাঙে, পাঁচটা script এ: গড় আর percentile কী লুকায়, একটা label কীভাবে metric system কে মারে, কোন trace রাখবেন আর
কোনটা ফেলবেন, কখন কাউকে রাতে জাগাবেন, আর একটা request চারটা service পেরোলে তাকে কীভাবে একসাথে দেখবেন।

| Script                | প্রশ্ন                                                                                                                         | Lesson §  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run percentiles` | একটা replica এর disk মাঝে মাঝে আটকায় — গড়, p99, মিনিটের p99 এর গড়, histogram এর bucket, আর কোন মাত্রায় ভাগ করলে দেখা যায়? | ১.২ – ১.৩ |
| `npm run cardinality` | একই metric এ `user_id` বা আসল path label দিলে কয়টা time series? Log আর trace এ একই জিনিস রাখলে কত?                            | ১.৪       |
| `npm run sampling`    | একদিনে ২.৬ কোটি trace — head ১%, tail sampling, আর প্রতিটা service নিজে sample করলে কী থাকে?                                   | ১.৬       |
| `npm run alerts`      | SLO ৯৯.৯% — স্থির threshold, burn rate, multi-window: কে কোন ঘটনা কখন ধরে, আর সপ্তাহে কতবার অকারণে জাগায়?                     | ১.৭       |
| `npm run trace`       | Gateway → BFF → work/billing, আসল HTTP — W3C `traceparent` আর `AsyncLocalStorage` দিয়ে trace, log এ trace_id; header না গেলে? | ১.৫       |

**সৎ নোট:**

- **প্রথম চারটা script এ কোনো network, Prometheus, log store বা আসল সময় নেই।** Request মানে একটা সংখ্যা,
  latency একটা seed দেওয়া এলোমেলো মান (lognormal), সব ফল **গোনা আর হিসাব করা**। যেকোনো machine এ হুবহু একই সংখ্যা।
- **`npm run trace` আসল** — চারটা `node:http` server, `127.0.0.1` এ এলোমেলো port এ, আসল `fetch`, আসল
  `AsyncLocalStorage`। Dependency (cache, replica, billing এর কাজ) `setTimeout` দিয়ে নকল করা। সময় আসল মাপা, তাই প্রতি
  run এ কয়েক ms আলাদা হয়; trace এর গঠন আর span ও trace এর সংখ্যা একই থাকে। দুটো request প্রায় সমান ধীর, তাই কোনটা
  "সবচেয়ে ধীর" হিসেবে দেখানো হয় — আর দেখানো trace id — run ভেদে বদলাতে পারে।
  Tracing library টা নিজের হাতে লেখা (`src/tracing.ts`) — OpenTelemetry না; production এ OpenTelemetry ব্যবহার করুন।
- **ধরে নেওয়া সংখ্যা:** প্রতি time series ~৩,০০০ byte memory, log লাইন ~৩৫০ byte, span ~৪০০ byte, প্রতি trace এ ২০টা
  span। এগুলো আন্দাজ — আসল সংখ্যা Prometheus এর version, log এর format আর tracing backend ভেদে আলাদা। Series এর
  **সংখ্যা** আন্দাজ না, গোনা।
- **Histogram এর percentile** Prometheus এর `histogram_quantile` এর মতো — bucket এর ভেতরে সরলরেখায় অনুমান।
- **Burn rate এর সীমা (14.4, 6, 1) আর window (৫ মি/১ ঘ, ৩০ মি/৬ ঘ, ৬ ঘ/৩ দিন)** Google এর SRE Workbook এর
  "Alerting on SLOs" অধ্যায় থেকে নেওয়া — সেখানকার প্রস্তাবিত মান, এখানে যাচাই করা না।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit` আর ESLint clean; প্রথম চারটা script দুবার করে, output হুবহু এক (byte
  ধরে মেলানো); `trace` তিনবার — গঠন আর সংখ্যা একই, ms আর দেখানো trace id আলাদা হতে পারে।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা — `fetch`, `AsyncLocalStorage`, `server.closeAllConnections` লাগে)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run percentiles
npm run cardinality
npm run sampling
npm run alerts
npm run trace
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run percentiles` — গড় ১৭২ ms (সবুজ), p99 ৩.৭৯ s; মিনিটের p99 এর গড় ৬১৭ ms (মিথ্যা); replica ধরে ভাগ করলে শুধু r3:

```
average          p50       p90       p99     p99.9       max     > 1 s
172 ms         79 ms    132 ms    3.79 s    4.50 s    4.77 s     2.50%

true p99 (all requests together)            3.79 s
average of the 60 minutes' p99              617 ms
median of the 60 minutes' p99               187 ms

replica r1       359,847     84 ms     78 ms    185 ms     0.00%
replica r2       360,375     84 ms     78 ms    187 ms     0.00%
replica r3       359,778    346 ms     81 ms    4.31 s     7.49%
```

`npm run cardinality` — চারটা সাধারণ label এ ২,৪০০টা series; আসল path বা `user_id` দিলে ২৫ লাখ:

```
label                                   counter series   histogram (×15)    approx. memory
method, route, status, instance              2,400            36,000            103 MB
+ plan (free/pro/business)                   7,114           106,710            305 MB
the real path instead of the route           2,529,996        37,949,940            106 GB
+ user_id                                2,534,244        38,013,660            106 GB
+ trace_id                               8,640,000       129,600,000            362 GB
```

`npm run sampling` — head ১% এ বিরল bug এর একটাও trace নেই; tail sampling সব error আর ধীর trace রাখে ৩ GB এ; প্রতিটা
service নিজে sample করলে প্রায় কোনো trace পুরো না:

```
policy                      traces kept  full trace     error      slow  rare bug  stored/day   into collector
keep all                    25,920,000    100.000%    13,088   130,236     45/45     193 GB           193 GB
head 1%                        259,702    100.000%       129     1,319      0/45     1.9 GB           1.9 GB
tail: error + slow + 1%        401,513    100.000%    13,088   130,236     45/45     3.0 GB           193 GB
each service its own 10%    10,620,422      0.002%         0         2      0/45     1.9 MB          19.3 GB
```

`npm run alerts` — স্থির ১% এর নিয়ম ধীর ক্ষয় কখনো ধরে না আর সপ্তাহে ৭বার deploy এর জন্য জাগায়; multi-window কাউকে
অকারণে জাগায় না আর ধীর ক্ষয় ধরে ticket হিসেবে:

```
event                               budget used   error > 1%, 5 min  error > 0.1%, 5 min    burn > 14.4, 1 h        multi-window
big outage: 30 minutes, 20%              13.9%        1 min (0.5%)        1 min (0.5%)        5 min (2.3%)        5 min (2.3%)
medium: 2 hours, 1.5%                     4.1%        4 min (0.1%)        1 min (0.0%)       58 min (2.0%)       58 min (2.0%)
slow burn: 3 days, 0.4%                  38.4%              missed        2 min (0.0%)              missed  ticket 14.4 h (7.7%)

nothing (only the deploy blip)                       7                   7                   0                   0
```

`npm run trace` — সবচেয়ে ধীর request এর ১.২ সেকেন্ডের পুরোটা একটা span এ (`db.query tasks r3`); header না পাঠালে ৩০টা
request ৯০টা trace হয়ে যায় (ms এর মান আপনার machine এ সামান্য আলাদা হবে):

```
gateway · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
  gateway · HTTP GET → bff                  1,203 ms   |████████████████████████████████████████|
    bff · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
      bff · HTTP GET → work                 1,203 ms   |████████████████████████████████████████|
        work · GET /api/boards/:id          1,202 ms   |████████████████████████████████████████|
          work · cache.get board                1 ms   |█                                       |
          work · db.query tasks r3          1,200 ms   |████████████████████████████████████████|
      bff · HTTP GET → billing                 16 ms   |█                                       |
        billing · GET /plan/:id                15 ms   |█                                       |

                              span   trace
with the header                270      30
bff without the header         270      90
```

## কী দেখার জন্য এটা বানানো

- **গড় লেজ লুকায়, আর percentile যোগ বা গড় করা যায় না।** ঘণ্টার আসল p99 ৩.৭৯ s, কিন্তু মিনিটের p99 গুলোর গড় ৬১৭ ms
  আর median ১৮৭ ms — dashboard এ rollup এর পদ্ধতিই বলে দেয় আপনি সমস্যা দেখবেন কিনা। Histogram এর bucket যোগ করা যায়,
  percentile না।
- **সমস্যাটা দেখা যায় শুধু সঠিক মাত্রায় ভাগ করলে।** ছয়টা instance হুবহু এক রকম; তিনটা replica এর একটা আলাদা।
- **Metric এর দাম series এর সংখ্যা, আর series = প্রতিটা label এর মানের গুণফল।** User বা আসল path এর মতো হাজার হাজার
  মানের জিনিস metric এর label এ না — log আর trace এ।
- **বিরল জিনিস ধরতে sampling এর সিদ্ধান্ত request শেষ হওয়ার পরে নিতে হয়** (tail) — আর তার দাম collector এ সব
  span আনা। আর head sampling এর সিদ্ধান্ত পরের service এ পৌঁছাতে হয়, নাহলে trace ভাঙে।
- **Alert এর প্রশ্ন "কত % error" না, "budget কত দ্রুত পুড়ছে"** — আর দ্রুত ধরা বনাম অকারণে জাগানোর মধ্যে বেছে নিতে
  হয়।
- **একটা request কে চারটা service জুড়ে দেখতে একটা id আর একটা header ই সব** — তার একটা hop এ ভুল হলে trace দুই টুকরো,
  আর ধীর query টা এমন trace এ যেখানে কোনো user এর request নেই।

## নিজে ভেঙে দেখুন (Experiments)

1. **Rollup উল্টো দিকেও ভুল করে:** `STALL_SECONDS=20 npm run percentiles`. আসল p99 আর মিনিটের p99 এর গড় — এবার কোনটা
   বড়? কেন? তাহলে "মিনিটের p99 এর গড়" কি একটা নিরাপদ, রক্ষণশীল অনুমান?
2. **Bucket বাছাই:** `src/percentiles.ts` এ `DEFAULT_BUCKETS` এ `150` আর `200` যোগ করুন। p90 এর ভুল কত হলো? Bucket কোথায়
   রাখবেন, সেটা কীসের উপর নির্ভর করে — আর একটা bucket যোগ করার দাম কী (`npm run cardinality` এর ×15 মনে করুন)?
3. **কত user এ মরবে:** `USERS=1000000 npm run cardinality`. `user_id` এর সারি কত হলো? প্রথম সারি কি বদলেছে? কেন না?
4. **কঠিন SLO:** `SLO=0.9999 npm run alerts`. কোনো ঘটনা ছাড়া (শেষ সারি) multi-window কী করল? স্বাভাবিক ০.০২% error
   আর deploy এর ঝাঁকুনি ৯৯.৯৯% এর budget এর কত খায়? এই SLO কি TaskFlow এর জন্য সৎ?
5. **ধীর query কতটা ধীর হলে দেখা যায়:** `STALL_MS=60 npm run trace`. Waterfall এ কী দেখা গেল? `percentiles` এর কোন
   সারিতে এই আকারের সমস্যা হারিয়ে যেত?

## Project Structure

```
src/
  random.ts         seed দেওয়া PRNG, lognormal, Zipf, percentile, grapheme-সচেতন টেবিল
  percentiles.ts    script ক — এক ঘণ্টার latency, rollup, histogram bucket, মাত্রা ধরে ভাগ
  cardinality.ts    script খ — একদিনের traffic, label এর সেট ধরে series গোনা, log/trace এর আয়তন
  sampling.ts       script গ — একদিনের trace, head/tail/বিচ্ছিন্ন sampling
  alerts.ts         script ঘ — ৭ দিনের error, চারটা alert নীতি, detection আর অকারণ page
  tracing.ts        নিজের হাতে লেখা ছোট tracing library — W3C traceparent, AsyncLocalStorage, span, JSON log
  trace.ts          script ঙ — চারটা আসল HTTP service, waterfall, trace_id দিয়ে log, header ভুলে গেলে
```

Environment variable: `RPS`, `MINUTES`, `STALL_SECONDS`, `SEED`, `HOURS`, `USERS`, `BOARDS`, `BUCKETS`, `BYTES_PER_SERIES`,
`ERROR`, `SLOW`, `RARE_PER_DAY`, `SERVICES`, `SPANS`, `SPAN_BYTES`, `DECISION_WAIT`, `SLO`, `BASE_ERROR`, `DEPLOY_BLIP`,
`REQUESTS`, `STALL_FROM`, `STALL_TO`, `STALL_MS`।
