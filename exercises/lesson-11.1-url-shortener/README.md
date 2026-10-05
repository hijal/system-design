# URL Shortener Lab — Estimation, Code Generation, Redirect Path, আর একটা আসল Shortener

> Lesson 11.1 — Case Study: Design a URL Shortener · **Tier 1 — Runnable Code**
> (তিনটা deterministic model আর একটা আসল Express + Zod server; Docker বা database লাগে না)

## কী বানাচ্ছি

একটা URL shortener এর চারটা প্রশ্ন, চারটা script এ। সংখ্যাগুলো কত বড়, আর কোন যন্ত্র আসলে লাগে? Short code কীভাবে বানাব
যাতে collision না হয় আর কেউ অনুমান করে অন্যের link খুঁজে না পায়? Redirect এর পথে cache কত দেয়, 301 আর 302 এর পার্থক্য
কোথায় লাগে, আর প্রতি link এ unique visitor গুনতে কত memory লাগে? আর শেষে, সব সিদ্ধান্ত মিলিয়ে একটা ছোট কিন্তু আসল
shortener যেটা চালানো যায়।

| Script             | প্রশ্ন                                                                                                | Lesson §  |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------- |
| `npm run estimate` | Traffic, storage, keyspace (৫–৮ অক্ষর), আর Bloom filter, HLL, sharding এর দাম এই মাপে                 | ১.২       |
| `npm run keygen`   | Random, hash, counter, range allocation, গোপন permutation — collision, চেষ্টা, অনুমান করে খোঁজা       | ১.৫       |
| `npm run redirect` | Zipf traffic এ LRU cache এর hit rate, hot key, 301 বনাম 302 (analytics আর link বন্ধ করা), unique গোনা | ১.৬ – ১.৭ |
| `npm run smoke`    | আসল Express server: তৈরি, redirect, validation, alias, মেয়াদ, বন্ধ করা, click এর buffer              | ১.৮       |
| `npm run serve`    | একই server চালু রাখে, নিজে `curl` দিয়ে খেলার জন্য                                                    | —         |

**সৎ নোট:**

- **Estimation এর input ধরে নেওয়া** — মাসে ১০ কোটি নতুন link, পড়া:লেখা ১০০:১, peak গড়ের ৩ গুণ, row প্রতি ৫০০ B। একটা
  Postgres primary এর "৫,০০০ insert/s" একটা মোটামুটি আন্দাজ, hardware আর schema এর উপর অনেক নির্ভর করে, এখানে মাপা না।
- **`keygen` keyspace ছোট করে চালায়** (৪ অক্ষর = ১.৪৮ কোটি ঘর), কারণ ৭ অক্ষরের ৩.৫২ লাখ কোটি ঘর memory তে ধরে না। Retry আর
  collision এর হার নির্ভর করে শুধু **কতটা ভরা** তার উপর, তাই "০.৩৪১% ভরা" সারিটা ৭ অক্ষরে ১০ বছরের সমান। Hash এর অংশে MD5
  ব্যবহার করা হয়েছে শুধু ভাগ করার জন্য, নিরাপত্তার জন্য না।
- **`redirect` এর traffic synthetic** — ২০ লাখ link, ৬০ লাখ redirect, জনপ্রিয়তা Zipf (s = 1)। আসল shortener এ নতুন link এর
  জনপ্রিয়তা সময়ের সাথে দ্রুত কমে (প্রথম কয়েক দিনেই বেশিরভাগ click), যেটা এই model এ নেই, তাই আসল hit rate সম্ভবত বেশি।
  Memory এর কলাম entry প্রতি ~২৫০ B ধরে, ১০০ কোটি link এ রৈখিক বাড়িয়ে। **301 এর অংশে browser এর আচরণ ধরে নেওয়া** (৮৫% browser
  cache রাখে, 301 মাস জুড়ে মনে থাকে)। আসল browser এর আচরণ version আর `Cache-Control` header এর উপর নির্ভর করে।
- **Unique visitor এর অংশ হিসাব, simulation না** — Zipf এর বণ্টন ধরে প্রতিটা link এর গড় click, তার ৬০% unique, exact set এ
  visitor প্রতি ১৬ B। Redis এর HLL এর dense রূপ ১২ KB (Redis এর documentation থেকে)। "ছোট হলে set, বড় হলে HLL" সারিটা Redis
  এর sparse representation এর ধারণা, তার আসল byte এর হিসাব না।
- **`smoke` একটা আসল HTTP server চালায়**, কিন্তু store in-memory (`MemoryLinkStore`), database না। Postgres এর schema lesson
  এ আছে, এখানে চালানো না। Sequence এর call গোনা হয় `CountingSequence` দিয়ে, যা Postgres এর `nextval` এর জায়গায় বসে।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক।
  `npm run serve` এ `curl` দিয়ে তৈরি → 302 → stats চালিয়ে দেখা হয়েছে।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run estimate
npm run keygen
npm run redirect
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড (`keygen` আর `redirect` ~৫–৮ s)।

নিজে খেলতে:

```bash
npm run serve
curl -s -X POST localhost:3000/api/links -H 'content-type: application/json' -d '{"url":"https://example.com/hello"}'
curl -si localhost:3000/<code>
curl -s localhost:3000/api/links/<code>/stats
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` — লেখা সামান্য, পড়া আসল চাপ; ৭ অক্ষরে ১০ বছরে keyspace এর মাত্র ০.৩৪% ভরে; Bloom filter আর per-link HLL
এই মাপে দামি:

```
new links (writes) / s                      38.6           116
redirects (reads) / s                      3,858        11,574
6             56.8 billion              47           21.1%               21.1%         21.1%
7            3.52 trillion           2,935          0.341%              0.341%        0.341%
Bloom filter, all 12 billion codes, 1% error               14.4 GB
HyperLogLog (dense, 12 KB) per link                          147 TB
```

`npm run keygen` — random এ retry = যতটা ভরা; hash এ collision birthday এর আন্দাজে মেলে; counter অনুমানযোগ্য, permutation না;
permutation এক-এক:

```
0.341%          1.0035        0.35%              2     1.9 months     10.0 years
21.1%        3,117,807        329,366   10.564%          328,929      1.1234
counter → base62                                  0d6C 0d6D 0d6E 0d6F 0d6G          100.00%          0.34%
counter → secret permutation → base62             f6sF 5OVy JR1Y iGCX HIx8            0.43%          0.27%
1,000                   3,354          10,161                0.00011%             47.5%
whole 3-char domain (238,328 ids): 238,328 distinct outputs — no collisions
```

`npm run redirect` — ছোট cache অনেক দেয়, তারপর ধীরে; 301 analytics আর link বন্ধ করা দুটোই ভাঙে; per-link HLL exact এর চেয়েও
দামি:

```
shared cache (Redis), 1% of links             20,000      60.4%                     4,578                  2.5 GB
shared cache (Redis), 20% of links           400,000      84.8%                     1,757                 50.0 GB
301 (permanent, browser remembers)       300,664        43.2%            56.8%          189,422             62.6%
302 + Cache-Control: private, no-store      300,664       100.0%             0.0%          189,422              0.0%
exact set per link (visitor hash, 16 B)                   96.0 GB
dense HLL (12 KB) per clicked link                         8.1 TB
```

`npm run smoke` — ১৮টা ধাপ, প্রতিটার status ঠিক; ১০,০০০ link এ ১০,০০০টা আলাদা code আর sequence এ মাত্র ১০ বার:

```
3   GET /cOoEtMq                                          302     Location: https://example.com/blog/system-design?ref=newsletter
5   POST /api/links  url: javascript:alert(1)             400     unsupported_scheme
10  POST /api/links  alias: abcDEF1 (7-char base62)       400     alias_reserved
14  GET /yhc3OjR  (2 hours later)                         410     expired
16  GET /cOoEtMq                                          410     disabled
18  GET /api/links/BnqHDLC/stats  (after flush)           200     clicks 5, unique 3
distinct codes: 10,000 / 10,000
trips to the sequence (database): 10
```

## কী দেখার জন্য এটা বানানো

- **Estimation নকশা বদলায়।** লেখা peak এ ১১৬/s — একটা Postgres এর সামান্য অংশ। তাই "লেখা scale করতে sharding" এর প্রশ্নই
  ওঠে না। আসল চাপ redirect এ (১১,৫৭৪/s), আর সেটা cache এর কাজ।
- **Keyspace এর দৈর্ঘ্য একটা সিদ্ধান্ত।** ৬ অক্ষরে ১০ বছরে ২১% ভরা — random এ প্রতি পাঁচটায় একটা retry, আর অনুমান করা code
  এর প্রতি পাঁচটায় একটা আসল link। ৭ অক্ষরে দুটোই ০.৩৪%।
- **Hash এর "একই URL → একই code" সুবিধা collision এ ভাঙে।** ১০ বছরে ~২ কোটি link এ salt যোগ করতে হয়, আর তখন একই URL এর
  code আর নির্ধারিত থাকে না।
- **Counter এ collision নেই, কিন্তু অনুমানযোগ্য।** নিজের code থেকে পিছনে গুনলে ১০০% আসল link। গোপন permutation (Feistel)
  counter এর সুবিধা রাখে আর ক্রমটা লুকায়।
- **Range allocation এ counter এর জন্য database এ যাওয়া ১,০০০ গুণ কমে**, দাম কিছু নষ্ট id (keyspace এর নগণ্য অংশ) আর সময়ের ক্রম
  হারানো।
- **301 সস্তা, কিন্তু server এর হাত থেকে link কেড়ে নেয়।** Analytics এ অর্ধেকের বেশি click নেই, আর malware এর link বন্ধ করার
  পরেও ৬৩% click পুরনো গন্তব্যে যায়।
- **প্রতি link এ HLL এখানে ভুল যন্ত্র।** বেশিরভাগ link এ কয়েকটা click, আর ১২ KB এর HLL তাদের জন্য exact set এর চেয়ে বড়।

## নিজে ভেঙে দেখো (Experiments)

1. **আরও তীক্ষ্ণ জনপ্রিয়তা:** `ZIPF_S=1.2 npm run redirect`। ১% cache এর hit rate কত হলো (মাপা: ৬০.৪% → ৮৯.২%)? তোমার
   আসল traffic এর s কত, সেটা না মেপে cache এর মাপ ঠিক করা যায় কেন না?
2. **বেশি ফিরে আসা user:** `HONOR_CACHE=1 REPEAT_MEAN=5 npm run redirect`। 301 এ server কত দেখে (মাপা: ১৬.৬%), আর বন্ধের পরে
   কত click পুরনো গন্তব্যে যায় (৮৮.৮%)? একটা link-in-bio বা QR code এর জন্য এর মানে কী?
3. **Block ছাড়া counter:** `BLOCK_SIZE=1 npm run smoke`। Sequence এ কতবার যেতে হলো (মাপা: ১০,০০০)? Peak এ ১১৬ link/s এ সেটা
   কি আসলেই সমস্যা? কখন হবে?
4. **দশ গুণ বড়:** `NEW_PER_MONTH=1000000000 npm run estimate`। এখন ৬ অক্ষর কবে ভরে (৫ বছরে), ৭ অক্ষরে ১০ বছরে কত ভরা (৩.৪%),
   আর peak লেখা Postgres এর কত (২৩%)? কোন সিদ্ধান্ত বদলাতে হবে, কোনটা না?
5. **Code বদলানোর কাজ:** `src/app.ts` এ একই URL আবার দিলে (একই owner এর জন্য) পুরনো code ফেরত দেওয়ার ব্যবস্থা করো। কোন
   index লাগবে, আর দুজন আলাদা user একই URL দিলে কী হওয়া উচিত — একই code না আলাদা? কেন?

## Project Structure

```
src/
  util.ts      seed দেওয়া PRNG, টেবিল আর সংখ্যার format, env parse
  base62.ts    base62 encode/decode, keyspace
  scramble.ts  গোপন permutation: Feistel network + cycle walking, [0, 62^7) এর ভেতরে এক-এক
  estimate.ts  script ক — traffic, storage, keyspace, যন্ত্রের দাম
  keygen.ts    script খ — random, hash, counter, range allocation, permutation
  redirect.ts  script গ — LRU cache এর hit rate, hot key, 301 বনাম 302, unique visitor এর memory
  store.ts     Link এর type, in-memory store, sequence, range allocator, code generator, click buffer
  app.ts       Express app: POST /api/links, GET /:code, stats, disable — Zod দিয়ে validation
  smoke.ts     script ঘ — app কে port 0 তে চালিয়ে ১৮টা ধাপ আর ১০,০০০ link
  serve.ts     app চালু রাখে, প্রতি সেকেন্ডে click flush, SIGTERM এ graceful shutdown
```

Environment variable: `NEW_PER_MONTH`, `READ_RATIO`, `PEAK`, `YEARS`, `ROW_BYTES`, `RESPONSE_BYTES`, `EVENT_BYTES`,
`RESTORE_MB_S`, `PG_INSERTS_PER_S`, `SCALED_LENGTH`, `PROBES`, `PER_YEAR`, `SERVERS`, `RESTARTS_PER_DAY`,
`CREATES_PER_DAY`, `REAL_FILL`, `LINKS`, `REQUESTS`, `ZIPF_S`, `PEAK_RPS`, `ENTRY_BYTES`, `ACTIVE_LINKS`, `APP_SERVERS`,
`VIRAL_RPS`, `USERS`, `REPEAT_MEAN`, `GAP_HOURS`, `HONOR_CACHE`, `TAKEDOWN_DAY`, `MONTHLY_CLICKS`, `UNIQUE_SHARE`,
`SET_BYTES`, `BULK`, `BLOCK_SIZE`, `SECRET`, `SEED`; `serve` এর জন্য `PORT`, `SHORT_ORIGIN`।
