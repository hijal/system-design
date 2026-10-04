# Notification System Lab — Channel এর খরচ, Campaign বনাম OTP, Timeout আর Duplicate, Aggregation, আর একটা আসল Notification Service

> Lesson 11.5 — Case Study: Design a Notification System · **Tier 1 — Runnable Code**
> (চারটা deterministic model আর একটা আসল Express + Zod notification service, fake provider সহ; Docker লাগে না)

## কী বানাচ্ছি

একটা notification system এর পাঁচটা প্রশ্ন। কোন channel এ কত যায় আর খরচ কোথায়? একটা marketing campaign চলার সময় একটা OTP
কতক্ষণ অপেক্ষা করে, যখন provider এর একটা সেকেন্ডের সীমা আছে? Provider timeout দিলে আবার পাঠালে কত হারায় আর কত দুবার যায়, আর
provider বন্ধ হলে কী? একটা viral post এ ৫০০ like এর জন্য কয়টা push? আর এই সব নিয়ম একসাথে একটা service এ কেমন দেখায়?

| Script              | প্রশ্ন                                                                                     | Lesson § |
| ------------------- | ------------------------------------------------------------------------------------------ | -------- |
| `npm run estimate`  | ৩০ কোটি DAU — চাপ, campaign, channel ধরে মাসিক খরচ, মরা device token, ইতিহাসের storage     | ১.২      |
| `npm run queue`     | SMS provider এর সীমা ১০০/s, ৩ লাখ SMS এর campaign — চারটা queue এর নীতিতে OTP এর দেরি      | ১.৪      |
| `npm run retry`     | Timeout মানে ব্যর্থতা না: হারানো বনাম দুবার, idempotency key, failover; provider এর outage | ১.৫      |
| `npm run aggregate` | Viral post এ ৫০০ like → কয়টা push; রাতের নীরবতা আর সকালের ঢেউ                             | ১.৬      |
| `npm run smoke`     | আসল HTTP: অগ্রাধিকারের queue, idempotency, aggregation, opt-out, quiet hours, token, retry | ১.৭      |

**সৎ নোট:**

- **দাম আনুমানিক** — email প্রতি $০.০০০১, SMS প্রতি $০.০০৮ (দেশ আর provider ভেদে অনেক বদলায়; কিছু দেশে দশ গুণ), APNs আর FCM
  এ পাঠানোর নিজের কোনো দাম নেই। Channel এর ভাগ আর মরা token এর ৩০% ধরে নেওয়া।
- **`queue` এর provider এর সীমা ধরে নেওয়া** (১০০ SMS/s, এক account); আসল সীমা provider, দেশ আর sender ধরন ভেদে আলাদা।
- **`retry` এর ব্যর্থতার হার synthetic** — ১% স্পষ্ট ব্যর্থ, ২% timeout, তার অর্ধেক আসলে পাঠানো। Provider idempotency key মানে
  কিনা সেটা provider এর উপর নির্ভর করে; অনেক email আর SMS provider মানে না, তখন dedupe নিজের দিকে করতে হয়।
- **`aggregate` এর like এর সময় synthetic** (গড়ে ৩ মিনিটে কমে আসা)।
- **`smoke` আসল HTTP চালায়**, কিন্তু provider একটা in-memory fake (মরা token আর "timeout কিন্তু পাঠানো" নকল করে), store
  in-memory, ঘড়ি নকল, আর worker এর `tick()` হাতে ডাকা হয়।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে, output byte ধরে হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run estimate
npm run queue
npm run retry
npm run aggregate
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` — SMS অল্প কিন্তু খরচের বেশিরভাগ; মরা token এ দিনে কোটি কোটি push:

```
email                  17%         51.0 কোটি     $0.0001    $1,530,000       17.5%
SMS                     1%            3 কোটি      $0.008    $7,200,000       82.5%
প্রতি user এর সব token এ পাঠালে দিনে 720 কোটি push, তার 216 কোটি মরা token এ
```

`npm run queue` — এক FIFO তে ৬৭,৫০০ OTP মেয়াদ পার; অগ্রাধিকার বা আলাদা account এ শূন্য:

```
একটা FIFO queue, একটা provider account                120.00 s 2942.40 s    3000.00 s     67,500          50 মি
অগ্রাধিকার: OTP আগে, campaign বাকিটা                           100 ms    100 ms       100 ms          0          63 মি
আলাদা account: OTP আর campaign এর আলাদা সীমা                100 ms    100 ms       100 ms          0          50 মি
```

`npm run retry` — retry ছাড়া হারায়, key ছাড়া দুবার যায়, failover এ key কাজ করে না; outage এ breaker:

```
একবার, retry নেই                                            2.03%         0.00%          1.000
ব্যর্থ বা timeout হলে আবার                                       0.00%         1.01%          1.031
আবার, provider এ idempotency key সহ                        0.00%         0.00%          1.031
timeout হলে দ্বিতীয় provider এ (key শেয়ার হয় না)                  0.00%         0.99%          1.031
একই provider এ exponential backoff (সর্বোচ্চ 5 মিনিট)         402.63 s   786.52 s      5,860,100
breaker: 30 s ব্যর্থতার পরে দ্বিতীয় provider                       500 ms    39.98 s        167,550
```

`npm run aggregate` — ৫০০ like এ ৫০০ push থেকে ৬টা, কিছু না হারিয়ে:

```
প্রতিটা like এ একটা push                                        500       115 ms                 সাথে সাথে
প্রতি 5 মিনিটে সর্বোচ্চ একটা, বাকি ফেলে দাও                                   4       115 ms    না (শেষ 112.64 s বাদ)
30 s এর জানালায় জমিয়ে "X আর আরও N জন" (collapse key)             26      30.12 s            30.00 s পরে
প্রথমটা সাথে সাথে, তারপর জানালা দ্বিগুণ হয় (৩০ s, ১, ২… মি)                  6       115 ms           847.36 s পরে
```

`npm run smoke` — ১০টা ধাপ:

```
1   ১,০০০টা marketing queue তে, তারপর alice এর OTP; ১টা পাঠানো   push:a-phone ← কোড: 482913
4   ৩০ s পরে জানালা বন্ধ                                        push:b-phone ← fan0 আর আরও 49 জন like করেছে; মেশানো 49
6   dave: রাত ১১টায় marketing, নীরবতা ২২–৭                    রাতে: deferred; সকাল ৭টায়: sent
7   erin এর দুটো token, একটা মৃত; দুটো OTP                      provider call: 2, তারপর 1; মুছে ফেলা token 1
9   gina এর অর্ডার email: প্রথম call timeout (আসলে গিয়েছিল)        email: timeout → email: sent
10  gina এর inbox এ                                       1টা email
```

## কী দেখার জন্য এটা বানানো

- **খরচ পরিমাণে না, channel এ।** ১% SMS খরচের ৮২%। OTP কে push এ নেওয়া বা SMS শুধু fallback রাখা সবচেয়ে বড় সাশ্রয়।
- **একটা queue তে জরুরি আর bulk মেশালে জরুরিটা মরে**, বিশেষ করে যখন সীমা আমাদের না, provider এর।
- **Pacing এ headroom লাগে।** Campaign কে সীমার ৯০% এ চালালে OTP এর জায়গা থাকে না (experiment ১)।
- **Timeout মানে "জানি না", ব্যর্থতা না।** Retry করো, কিন্তু একটা key দিয়ে যা provider মানে; failover এ সেই key হারায়।
- **Backoff একা outage সারায় না;** provider ফিরে আসার পরেও অনেকে মিনিট খানেক অপেক্ষা করে। Breaker + দ্বিতীয় provider।
- **User এর মনোযোগ একটা সীমিত সম্পদ।** Aggregation আর collapse key ৫০০ কে ৬ বানায়, কিছু না হারিয়ে; cap কিছু হারায়।
- **মরা token পরিষ্কার না করলে push এর এক-তৃতীয়াংশ অপচয়।**

## নিজে ভেঙে দেখো (Experiments)

1. **লোভী pacing:** `PACE_SHARE=0.9 npm run queue`। OTP এর কত মেয়াদ পার হলো (মাপা: ৭,৫০৩), আর কেন — ৯০% + OTP এর ২০% = ?
2. **OTP বাড়লে:** `OTP_PER_S=90 npm run queue`। অগ্রাধিকারে campaign কবে শেষ হয় (মাপা: ২ ঘণ্টায়ও না), আর আলাদা account এ (৫০
   মিনিট)? অগ্রাধিকারের দাম কে দেয়?
3. **বেশিরভাগ timeout আসলে পাঠানো:** `SENT_ON_TIMEOUT=0.9 npm run retry`। Key ছাড়া retry তে দুবার কত (মাপা: ১.৮৩%), retry ছাড়া
   হারানো কত (১.২১%)? কোন notification এ কোনটা খারাপ?
4. **ধীর breaker:** `BREAKER_S=120 npm run retry`। Outage এ p99 কত হলো (মাপা: ২০৩.৭৯ s)? Breaker এর সময় কে ঠিক করে?
5. **Code বদলানোর কাজ:** `src/notify.ts` এ user প্রতি দিনে সর্বোচ্চ ৩টা marketing এর একটা সীমা যোগ করো (critical আর normal এ না)।
   সীমা কোথায় দেখবে — গ্রহণের সময় নাকি পাঠানোর সময় — আর quiet hours এ পিছিয়ে যাওয়া notification কোন দিনের গোনায় পড়বে?

## Project Structure

```
src/
  util.ts       seed দেওয়া PRNG, lognormal, percentile, টেবিলের format, env parse
  estimate.ts   script ক — চাপ, campaign, channel এর খরচ, মরা token, ইতিহাস
  queue.ts      script খ — provider এর সীমার নিচে চারটা queue নীতি, OTP এর দেরি আর মেয়াদ
  retry.ts      script গ — timeout/ব্যর্থতায় retry, idempotency key, failover; outage এ backoff বনাম breaker
  aggregate.ts  script ঘ — viral like এর চারটা নীতি; রাতের নীরবতা
  notify.ts     NotificationService (idempotency, type → priority আর channel plan, aggregation window, opt-out,
                quiet hours, মরা token মোছা, retry একই key তে) আর Express app
  smoke.ts      script ঙ — fake provider সহ ১০টা ধাপ
```

Environment variable: `DAU`, `PER_USER`, `PEAK`, `PUSH_SHARE`, `EMAIL_SHARE`, `SMS_SHARE`, `INAPP_SHARE`, `PUSH_COST`,
`EMAIL_COST`, `SMS_COST`, `CAMPAIGN`, `CAMPAIGN_HOURS`, `TOKENS`, `STALE_SHARE`, `EVENT_BYTES`, `RETENTION_DAYS`,
`OTP_PER_S`, `PROVIDER_PER_S`, `CAMPAIGN_AT_S`, `PACE_SHARE`, `OTP_VALID_S`, `SECONDS`, `TICK_MS`, `MESSAGES`, `FAIL`,
`TIMEOUT`, `SENT_ON_TIMEOUT`, `RATE`, `OUTAGE_S`, `BREAKER_S`, `CAP_S`, `LIKES`, `DECAY_S`, `CAP_WINDOW_S`, `BATCH_S`,
`USERS`, `PER_USER_DAY`, `NIGHT_SHARE`, `CRITICAL_SHARE`, `SEED`।
