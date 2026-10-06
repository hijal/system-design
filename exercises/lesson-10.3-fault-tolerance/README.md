# TaskFlow Fault Tolerance Lab — Dependency Matrix, Redundancy, Brownout, Static Stability, Chaos

> Lesson 10.3 — Fault Tolerance, Graceful Degradation, Chaos Engineering · **Tier 1 — Runnable Code** (পাঁচটা
> script, সবগুলো deterministic simulation; Docker লাগে না)

## কী বানাচ্ছি

TaskFlow এর পাঁচটা প্রশ্ন, প্রতিটা একটা script এ: কোন dependency মরলে কোন feature মরে, তিনটা copy রাখলে
availability আসলে কত বাড়ে, চাপের সময় optional অংশ বন্ধ করে core কাজ কীভাবে বাঁচানো যায়, control plane মরলে
data plane বাঁচে কিনা, আর production এ ইচ্ছা করে fault ঢোকালে bug কত তাড়াতাড়ি, কত কম ক্ষতিতে ধরা পড়ে।

| Script               | প্রশ্ন                                                                                                                       | Lesson §  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run matrix`     | ৯টা dependency এর প্রতিটা মরলে বা ধীর হলে ৭টা user journey এর কী হয় — আগের code বনাম নতুন code? আর ১০ বছরে availability কত? | ১.২ – ১.৪ |
| `npm run redundancy` | ৩টা instance এ সূত্র বলে বছরে ০.০১ সেকেন্ড বন্ধ — একই AZ, একসাথে deploy, খারাপ deploy সহ আসলে কত?                            | ১.৫       |
| `npm run brownout`   | Traffic আড়াই গুণ — কিছু না, deadline check, load shedding, brownout: কে কী পায়, আর চাপ শেষে কত তাড়াতাড়ি সারে?            | ১.৬       |
| `npm run static`     | Flags/config service ৪৫ মিনিট মরা, মাঝে crash আর autoscale — চারটা নকশায় কত request ব্যর্থ?                                 | ১.৭       |
| `npm run chaos`      | Billing এ দেরি ঢোকানো — blast radius ০.১% থেকে ১০০%: global alarm আর control group কত দ্রুত, কত ক্ষতিতে bug ধরে?             | ১.৮ – ১.৯ |

**সৎ নোট:**

- **কোনো script এ network, DB, Redis বা আসল সময় নেই।** Dependency মানে একটা নাম আর একটা latency সংখ্যা;
  "মরা" মানে সাথে সাথে error, "ধীর" মানে ৩ s। Journey গুলো (`src/journeys.ts`) সত্যিকারের TypeScript function —
  harness সেগুলো চালিয়ে matrix বের করে, হাতে লেখা টেবিল না। সব latency **হিসাব করা**, মাপা না।
- **সব ফল deterministic** — seed দেওয়া PRNG। যেকোনো machine এ হুবহু একই সংখ্যা।
- **সংখ্যাগুলো ধরে নেওয়া parameter থেকে আসে** — instance গড়ে ৩০ দিনে একবার মরে, AZ বছরে ০.৫ বার, ৩% deploy
  খারাপ, board এর অংশগুলোর worker সময়, আর এরকম। এগুলো বিশ্বাসযোগ্য আন্দাজ, কোনো আসল system এর মাপা সংখ্যা না।
  Script গুলো যা দেখায় তা হলো **সম্পর্ক** — কোন নকশায় কোন ধরনের ক্ষতি কোন দিকে যায় — আর প্রতিটা parameter
  environment variable দিয়ে বদলে দেখা যায়।
- **`matrix` এর availability শুধু এই ৯টা dependency ধরে।** Gateway, network, app নিজে, DNS — এগুলো বাদ। তাই
  "100.000%" মানে "এই ৯টার কোনো একক বা যৌথ outage এ এই journey ভাঙেনি", পুরো system এর availability না।
  Dependency গুলো স্বাধীনভাবে মরে ধরা হয়েছে — `redundancy` দেখায় কেন বাস্তবে সেটা সবসময় সত্যি না।
- **`brownout` একটা M/G/c FIFO queue** — ৪৮টা worker, Poisson arrival, প্রতিটা অংশের সময় গড়ের ০.৫–১.৫ গুণ।
  Brownout controller প্রতি সেকেন্ডে গড় queue এর অপেক্ষা দেখে এক ধাপ ওঠে, আর ১০ সেকেন্ড শান্ত থাকলে এক ধাপ
  নামে।
- **`chaos` এর "control group" পদ্ধতি** Netflix এর ChAP এর মতো ধারণা (একই আকারের না-ছোঁয়া দলের সাথে তুলনা) —
  সরলীকৃত: একপাক্ষিক two-proportion z-test, প্রতি ১০ সেকেন্ডে। বারবার দেখা (peeking) ভুল করে থামানোর হার
  বাড়ায়; অংশ গ সেটা মাপে।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit` আর ESLint clean; পাঁচটা script দুবার করে, প্রতিবার output
  হুবহু এক (byte ধরে মেলানো)।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run matrix
npm run redundancy
npm run brownout
npm run static
npm run chaos
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run matrix` — আগের code এ `flags` এর পুরো সারি ✗, আর `redis-cache` / `redis-queue` এ ✗! (লেখা হয়ে
গেছে কিন্তু user error দেখেছে); নতুন code এ `flags` এর সারি পুরো ✓:

```
── A. One dependency dead (connection refused) — old code ──
dead dependency          login       board  create-task     comment      search      upload  share-link
pg-replica                   ✓           ✗           ✓           ✓           ✗           ✓           ✓
redis-cache                  ✓           ✓          ✗!           ✓           ✓           ✓           ✓
redis-queue                  ✓           ✓           ✓          ✗!           ✓           ✓           ✓
billing                      ✓           ✗           ~           ✓           ✓           ✓           ✓
flags                        ✗           ✗           ✗           ✗           ✗           ✗           ✗
email                        ✓           ✓           ✓           ✓           ✓           ✓           ✓

── B. One dependency dead — code written with degradation in mind ──
pg-replica                   ✓           ~           ✓           ✓           ✗           ✓           ✓
billing                      ✓           ~           ~           ✓           ✓           ✓           ✓
flags                        ✓           ✓           ✓           ✓           ✓           ✓           ✓

journey        hard dep (old)   formula   old code  down/year   hard dep (new)    worked   in full  down/year
board                       3   99.301%    99.300%  3,680 min                0  100.000%   99.791%      0 min
```

`npm run redundancy` — সূত্র বলে ৩টা instance এ বছরে ০.০১১ সেকেন্ড; মাপা ১৬০ মিনিট, তার বেশিরভাগ AZ আর deploy:

```
design                          formula down/year   measured   failed min/year  instance      AZ   deploy  full outage
1 instance                                365 min    99.905%               497       343      82       72     461 min
3, same AZ, deployed together              0.011 s    99.970%               160         6      82       72     117 min
3, 3 AZs, deployed together               0.011 s    99.985%                78         6       0       72      35 min
3, 3 AZs, one at a time                   0.011 s    99.992%                43         6       0       37       0 min
```

`npm run brownout` — কিছু না করলে চাপের ৭ মিনিটে **কেউ** board পায় না, আর চাপ শেষেও সারে না; brownout এ
সবাই পায়:

```
policy                  got board  full page      503   timeout       p50       p99  wasted work  recovery after load
nothing                      0.0%       0.0%     0.0%    100.0%         —         —      100.0%  not even in 15 minutes
+ deadline check            34.1%      34.1%     0.0%     65.9%    2.99 s    3.00 s       59.1%          immediately
load shedding (7.4)         64.0%      64.0%    36.0%      0.0%    348 ms    373 ms        0.0%          immediately
brownout                   100.0%       2.9%     0.0%      0.0%     18 ms    360 ms        0.0%          immediately
```

`npm run static` — শুধু snapshot সহ last-known-good control plane এর outage এর মধ্যে restart আর autoscale টিকে
থাকে:

```
design                        failed requests        worst minute  short minutes  failed boots         config age (max)
ask on every request                   44.05%              100.0%            45             0                        —
cache, TTL 5 minutes                   40.82%              100.0%            40           463                5 minutes
last-known-good                        12.08%               50.0%            25           463               45 minutes
last-known-good + snapshot              0.24%               20.0%             1             0               45 minutes
```

`npm run chaos` — সূক্ষ্ম bug এ ০.১% blast radius global alarm কখনো ধরে না, control group ধরে ৯টা request এর
ক্ষতিতে; ১০০% এ সরাসরি চালালে ক্ষতি ২৫০:

```
── B. A subtle bug — 5% of injected requests fail (only on boards with 500+ tasks) ──
blast radius     global: caught      when     harm  control: caught      when     harm
0.1%                         0%         —       45             100%   6.2 min        9
1%                       2%      10 s      447         100%      40 s       11
5%                     100%      10 s       14         100%      10 s       14
100% (all)                 100%      10 s      250                —         —        —
```

সব সংখ্যা আপনার machine এও **হুবহু এক** হওয়ার কথা।

## কী দেখার জন্য এটা বানানো

- **একটা journey এর availability তার hard dependency গুলোর গুণফল।** Board এর আগের code এ তিনটা hard
  dependency (flags, replica, billing) — সূত্র 99.301%, simulation 99.300%। Hard dependency কমানোই availability
  বাড়ানোর সবচেয়ে সস্তা পথ, বড় machine কেনার চেয়ে।
- **সবচেয়ে বিপজ্জনক dependency সবচেয়ে "অগুরুত্বপূর্ণ" টা।** Flags service কোনো feature এর মূল কাজ করে না,
  তবু আগের code এ সেটা সাতটা journey এর প্রতিটার hard dependency।
- **ধীর dependency মরা dependency এর চেয়ে খারাপ।** মরা `redis-limiter` আগের code এ board কে ছোঁয় না
  (fail open), কিন্তু ধীর `redis-limiter` পাঁচটা journey কে ৩ সেকেন্ড ধরে রাখে — কারণ timeout নেই।
- **Redundancy এর সূত্র স্বাধীন failure ধরে।** একই AZ, একই deploy — এগুলো তিনটা copy কে একসাথে মারে, আর তখন
  সূত্রের ০.০১১ সেকেন্ড বাস্তবে ১৬০ মিনিট।
- **চাপের সময় কম কাজ করা, কাউকে ফিরিয়ে দেওয়ার চেয়ে ভালো।** Load shedding ৩৬% user কে কিছুই দেয় না;
  brownout সবাইকে task তালিকা দেয়। আর কিছু না করলে queue এমন জমে যে চাপ চলে যাওয়ার পরেও ১৫ মিনিট ধরে কেউ
  সময়মতো উত্তর পায় না।
- **Data plane যদি control plane ছাড়া চালু হতে না পারে, তাহলে outage এর মধ্যে প্রতিটা restart একটা স্থায়ী
  ক্ষতি।** Last-known-good চলমান instance বাঁচায়, কিন্তু নতুন instance কে বাঁচায় শুধু snapshot।
- **ছোট blast radius এ bug দেখতে হলে control group লাগে।** Global error rate এ ০.১% traffic এর ক্ষতি চোখেই
  পড়ে না।

## নিজে ভেঙে দেখুন (Experiments)

1. **TTL বাড়ালে কি static stability আসে?** `TTL=1800 npm run static`. ব্যর্থ request কত হলো? ৪৫ মিনিটের outage এ
   ৩০ মিনিটের TTL কী কেনে, আর কী কেনে না? কোন TTL এ এই নকশা সত্যিই নিরাপদ হতো — আর তখন সেটা last-known-good
   থেকে কীভাবে আলাদা?
2. **Brownout কোথায় ফুরায়:** `PEAK=12 npm run brownout`. শুধু task তালিকাতেও যখন ক্ষমতা কুলায় না, তখন brownout
   একা কী করে? Brownout + shedding? এই দুটো যন্ত্র কেন একে অপরের বিকল্প না, পরিপূরক?
3. **Controller এর সংবেদনশীলতা:** `BROWNOUT_WAIT=200 npm run brownout`. বেশি user পুরো page পেল, কিন্তু p99 এ কী
   হলো? Threshold কে ঠিক করবে — engineer, না product?
4. **শান্ত bug আর rolling deploy:** `QUIET_DETECT=60 npm run redundancy`, তারপর `BAKE=30`. একটা একটা করে deploy কি
   সবসময় একসাথে deploy এর চেয়ে নিরাপদ? কোন শর্তে না?
5. **বারবার দেখার দাম:** `Z=2 npm run chaos`. অংশ গ তে ভুল করে থামানো কত হলো? Experiment যদি প্রতি সপ্তাহে
   ৫০টা চলে, z = 2 এ কতগুলো অকারণে থামবে — আর তাতে দলের বিশ্বাসের কী হবে?
6. **Code বদলে matrix:** `src/journeys.ts` এ `designed.board` থেকে billing এর `150` timeout সরিয়ে দিন, তারপর
   `npm run matrix`। অংশ গ২ এ board এর ঘরে কী এলো? একটা soft dependency কে timeout ছাড়া রাখলে সে আসলে কী?

## Project Structure

```
src/
  random.ts       seed দেওয়া PRNG, exponential, percentile, grapheme-সচেতন টেবিল
  deps.ts         ৯টা dependency, তাদের latency, আর Ctx — call (timeout সহ), attempt, soft, parallel, commit
  journeys.ts     ৭টা journey দুইভাবে লেখা: asWritten (আগের code) আর designed (degradation মাথায় রেখে)
  matrix.ts       script ক — প্রতিটা dependency মরা/ধীর, matrix, আর ১০ বছরের availability simulation
  redundancy.ts   script খ — instance, AZ আর deploy এর failure, চারটা নকশা, সূত্র বনাম মাপা
  brownout.ts     script গ — M/G/c queue, পাঁচটা নীতি, মিনিট ধরে brownout এর ধাপ
  static.ts       script ঘ — control plane outage, crash, autoscale, চারটা config নকশা
  chaos.ts        script ঙ — blast radius, global alarm বনাম control group, ভুল করে থামানো
```

Environment variable: `YEARS`, `SEED`, `INSTANCE_MTBF_DAYS`, `INSTANCE_REPAIR`, `AZ_OUTAGES_PER_YEAR`, `AZ_OUTAGE`,
`DEPLOYS_PER_WEEK`, `BAD_DEPLOY`, `LOUD_DETECT`, `QUIET_DETECT`, `ROLLBACK`, `BAKE`, `WORKERS`, `BASE_RPS`, `PEAK`,
`CLIENT_TIMEOUT`, `SHED_WAIT`, `BROWNOUT_WAIT`, `INSTANCES`, `CAPACITY`, `PEAK_RPS`, `OUTAGE_FROM`, `OUTAGE_TO`, `TTL`,
`RESTARTS_PER_HOUR`, `RPS`, `BASE_ERROR`, `LOUD`, `SUBTLE`, `SLO_ALARM`, `Z`, `MAX_MINUTES`, `RUNS`।
