# TaskFlow Resilience Lab - কে কোথায়, কখন থামবে, আর কতটুকু ডুববে

> Lesson 9.4 - Service Discovery, Circuit Breaker, Bulkhead · **Tier 1 - Runnable Code** (আলাদা port এ আসল HTTP server; Docker লাগে না)

## কী বানাচ্ছি

TaskFlow এর work service billing কে synchronous ডাকে (Lesson 9.3 এর saga এর প্রথম ধাপ)। Billing এর কয়েকটা
instance আছে, আর তারা মরে বা ধীর হয়। তিনটা script তিনটা আলাদা প্রশ্নের উত্তর মেপে দেখায়:

| Script              | প্রশ্ন                                                                                          | Lesson §  |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------- |
| `npm run discovery` | Work জানবে কীভাবে billing এর কোন instance কোথায়, আর কোনটা জীবিত? Heartbeat কেন যথেষ্ট না?      | ১.২ – ১.৩ |
| `npm run circuit`   | Billing ধীর হলে প্রতিটা call timeout পর্যন্ত অপেক্ষা করে - সেই দাম কত, আর fail-fast এ কী বাঁচে? | ১.৪ – ১.৫ |
| `npm run isolation` | Billing এর ধীরতা work এর সব worker খেয়ে ফেলে - "board খোলা" কি তখনো কাজ করে?                   | ১.৬ – ১.৭ |

**সৎ নোট:**

- **Billing instance গুলো আসল HTTP server** (`node:http`, আলাদা port, keep-alive সহ) - call গুলো সত্যিই loopback
  দিয়ে যায়। কিন্তু সব এক machine এ, এক Node process এ: network এর দেরি নেই, packet হারায় না, DNS নেই।
  আসল data center এ discovery এর দেরি আর ব্যর্থতার ধরন আরও বৈচিত্র্যময়।
- **"ধীর" আর "মরা" দুটোই ভান** - ধীর মানে server ইচ্ছে করে `SLOW_MS` অপেক্ষা করে, মরা মানে `server.close()` +
  খোলা connection বন্ধ (তাই connection refused)। আসল crash এ TCP এর আচরণ এর কাছাকাছি, কিন্তু হুবহু না।
  বিশেষ করে: একটা **hung** machine (process বেঁচে, উত্তর দেয় না) এ connection refused আসে না - timeout আসে;
  এখানে সেটা `slow` mode দিয়ে দেখানো হয়েছে।
- **Registry টা in-process একটা `Map`** - Consul, etcd, Eureka বা Kubernetes এর Endpoints এর মতো replicated,
  consensus সহ store না (Lesson 6.2)। Heartbeat আর TTL এর যুক্তিটা একই, কিন্তু registry নিজে মরলে কী হয় -
  সেটা এখানে দেখানো হয়নি।
- **`fetch` না, `node:http`।** Lesson 9.2 এর exercise এ মাপা হয়েছিল: Node 26 এর built-in `fetch` এ অল্প বিরতির
  পরে পরের request প্রায়ই ~৫০০ ms দেরি করে, localhost এও। এখানে সেই একই কারণে `node:http` + keep-alive agent।
- **Breaker টা গোনার ভিত্তিতে** (পরপর N টা ব্যর্থতা)। Production এর breaker সাধারণত একটা সময়-জানালায় ব্যর্থতার
  **হার** দেখে (rolling window), আর অনেকগুলো আরও জিনিস করে - slow call কেও ব্যর্থতা গোনা, half-open এ একাধিক
  probe, per-endpoint আলাদা breaker। মূল অবস্থা তিনটা (closed / open / half-open) একই।
- **Bulkhead এখানে একটা semaphore** - এক process এর ভেতরে slot গোনা। আসল system এ একই ধারণা আরও কয়েক জায়গায়:
  আলাদা connection pool (Lesson 5.6), আলাদা thread pool, আলাদা deployment, এমনকি আলাদা machine।
- **যাচাই করা হয়েছে** Node 26 এ, এই machine এ, প্রতিটা script তিনবার করে: **গোনার সব কলাম প্রতি run এ হুবহু এক**
  (নিচের acceptance criteria দেখুন); সময়ের সংখ্যা ২% এর কম ওঠানামা করেছে। আপনার machine এ সময় আলাদা হবে,
  গোনা হবে না।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না। Port 4101–4103, 4201, 4301 খালি থাকতে হবে।

## Setup

```bash
npm install
```

## Run

```bash
npm run discovery
npm run circuit
npm run isolation
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run discovery` - এই তিনটা সারি ঠিক এই গোনা নিয়ে আসবে:

```
   strategy                             before     on death    after TTL
   static list                         0 ( 0%)    100 (33%)    100 (33%)
   registry + heartbeat/TTL            0 ( 0%)    100 (33%)      0 ( 0%)
```

আর অসুস্থ instance এর অংশে `150 (50%)` - heartbeat পাঠানো সত্ত্বেও।

`npm run circuit` - `no breaker` এ ৪০০টা call ই billing এ পৌঁছায় আর ব্যর্থ হয়; `breaker` এ পৌঁছায় মাত্র **12**টা,
`fast-fail` **388**টা, ops/s ২৭ থেকে ~৬৬০ এ ওঠে, p50 ~৩০১ ms থেকে **0.0 ms**:

```
   path                                ok      failed   fast-fail     reached       ops/s         p50         p99
   no breaker                           0         400           0         400          27    301.0 ms    307.9 ms
   breaker                              0         400         388          12         663      0.0 ms    302.0 ms
```

`npm run isolation` - "board খোলা" এর p99 shared pool এ ~৫৯৫ ms, আলাদা bulkhead এ **~৭ ms**; দুটোতেই ok ১৭১:

```
   pool                              ok      failed        shed         p50         p99
   shared (16)                      171           0           0    305.0 ms    595.9 ms
   bulkhead (4 board)               171           0           0      2.1 ms      7.4 ms
```

সময়ের সংখ্যা আপনার machine এ আলাদা হবে; **গোনা (100, 150, 400, 388, 12, 171, 429) হুবহু এক হওয়ার কথা**।

## কী দেখার জন্য এটা বানানো

- **Discovery:** static list এ মরা instance চিরকাল তালিকায় থাকে - ব্যর্থতা ৩৩% এ আটকে যায়, নিজে থেকে সারে না।
  Registry তে সারে, কিন্তু **সাথে সাথে না** - TTL এর একটা জানালা আছে যেখানে ব্যর্থতা চলতেই থাকে। ওই জানালাটাই
  discovery এর আসল সংখ্যা।
- **Heartbeat এর সীমা:** অসুস্থ instance (500 ফেরত দিচ্ছে, অথচ heartbeat পাঠাচ্ছে) registry থেকে সরে না।
  "বেঁচে আছি" আর "কাজ করছি" এক জিনিস না - এই ফাঁকটাই circuit breaker এর জন্য জায়গা বানায়।
- **Breaker:** সবচেয়ে বড় সংখ্যাটা ops/s না, **reached** - ৪০০ থেকে ১২। মরতে থাকা service এর উপর চাপ ৯৭% কমে।
  Breaker প্রথমত নিজেকে বাঁচায় (timeout এ আটকে থাকা বন্ধ), দ্বিতীয়ত **অন্যকে** বাঁচায় (তাকে উঠে দাঁড়ানোর সুযোগ)।
- **Half-open:** breaker নিজে থেকে বুঝতে পারে না billing সেরেছে কিনা - একটা probe পাঠিয়েই জানতে হয়। তাই
  recovery এর সময় = open এর বাকি মেয়াদ + একটা probe।
- **Bulkhead:** board এর p99 ৫৯৫ → ৭ ms, অথচ billing সমান ধীর। কিন্তু **create এর p99 বেড়েছে** (৮৯৮ ms → ১.২১ s) -
  bulkhead অসুস্থ পথটাকে ভালো করে না, শুধু সুস্থ পথটাকে ডুবতে দেয় না। এই trade-off টাই মূল শিক্ষা।

## নিজে ভেঙে দেখুন (Experiments)

1. **TTL কমান, heartbeat বাড়ান:** `TTL_MS=100 HEARTBEAT_MS=30 npm run discovery`. মরার পরপর ব্যর্থতা কত কমল?
   এবার উল্টোটা - `TTL_MS=2000`. Registry এর TTL ছোট করার দাম কী (instance গুলো কত ঘন ঘন heartbeat পাঠাবে,
   আর একটা সাময়িক GC pause এ কী হবে)?
2. **Threshold বদলান:** `THRESHOLD=50 npm run circuit`. কতগুলো call billing এ পৌঁছাল, ops/s কত হলো? এবার
   `THRESHOLD=2` - breaker কি কখনো ভুল করে খুলতে পারে (একটা সাময়িক hiccup এ)? কোনটা আপনার কাছে নিরাপদ?
3. **Open এর মেয়াদ:** `OPEN_MS=5000 npm run circuit`. Recovery কত দেরি হলো? খুব বড় `OPEN_MS` এর দাম কী,
   আর খুব ছোট হলে মরতে থাকা service এর উপর কী হয়?
4. **Bulkhead এর ভাগ:** `isolation.ts` এ `WORKERS - 4` আর `4` বদলে দেখুন - board কে ৮, create কে ৮ দিলে দুটোর
   p99 কী হয়? কোন ভাগটা আপনি production এ বাছবেন, আর কোন সংখ্যা দেখে?
5. **Breaker + bulkhead একসাথে (code বদলাতে হবে):** `isolation.ts` এর create path এ `CircuitBreaker` যোগ করুন।
   Create এর p99 কী হয়, board এর p99 কী হয়, আর shed/fail-fast এর গোনা কেমন দাঁড়ায়? তিনটা যন্ত্র একসাথে
   কাজ করলে কোনটা কোন সমস্যাটা সারায় - এক প্যারায় লিখে ফেলুন।

## Project Structure

```
src/
  billing.ts      billing instance - আসল HTTP server, mode বদলানো যায় (healthy / slow / error)
  http.ts         keep-alive GET client, timeout সহ; ফল একটা discriminated union
  registry.ts     Registry (heartbeat + TTL), RoundRobin, Heartbeats
  breaker.ts      CircuitBreaker - closed / open / half-open, probe গোনা সহ
  bulkhead.ts     Bulkhead - slot গোনা semaphore, queue limit আর shed সহ
  random.ts       seeded PRNG, percentile, grapheme-সচেতন padding
  discovery.ts    script ক - static list বনাম registry, আর অসুস্থ instance
  circuit.ts      script খ - breaker নেই / আছে / fallback সহ, আর recovery
  isolation.ts    script গ - shared pool বনাম bulkhead
```

Environment variable দিয়ে সব সংখ্যা বদলানো যায়: `PHASE_REQUESTS`, `CONCURRENCY`, `TIMEOUT_MS`,
`HEARTBEAT_MS`, `TTL_MS`, `REQUESTS`, `SLOW_MS`, `THRESHOLD`, `OPEN_MS`, `WORKERS`, `CLIENTS`, `BOARD_SHARE`।

## Teardown

আলাদা কিছু লাগে না - প্রতিটা script শেষে নিজের server গুলো বন্ধ করে দেয়। Port আটকে থাকলে process টা বন্ধ করুন।
