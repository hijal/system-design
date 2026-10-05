# Payment System Lab — ভুলের দাম, PSP এর Timeout, Double-Entry Ledger, Reconciliation, আর একটা আসল Payment Service

> Lesson 11.7 — Case Study: Design a Payment System · **Tier 1 — Runnable Code**
> (চারটা deterministic model আর একটা আসল Express + Zod payment service, fake PSP আর HMAC দেওয়া webhook সহ; Docker লাগে না)

## কী বানাচ্ছি

একটা checkout এর payment system এর পাঁচটা প্রশ্ন। চাপ ছোট হলে ভুল কেন বড়? বাইরের payment provider (PSP) timeout দিলে কী
করব — কতজনের টাকা দুবার কাটা যায়, আর কতজনের টাকা কাটা হয় কিন্তু আমরা ভাবি ব্যর্থ? একটা `balance` column আর একটা
double-entry ledger এর মধ্যে আসল পার্থক্য কী, আর float এ টাকা রাখলে কী হয়? দিনশেষে নিজের হিসাব আর PSP এর হিসাব কীভাবে মেলাব?
আর এই সব একসাথে একটা service এ।

| Script              | প্রশ্ন                                                                                           | Lesson § |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| `npm run estimate`  | দিনে ১ কোটি payment — চাপ, টাকার পরিমাণ, ভুলের দাম, ledger এর আকার, একটা payment এর টাকার পথ     | ১.২      |
| `npm run timeout`   | PSP timeout এ চারটা নীতি; process crash এ "আগে PSP" বনাম "আগে intent"                            | ১.৪      |
| `npm run ledger`    | একটা গরম merchant সহ ২ লাখ transfer — balance column বনাম double-entry; float বনাম পয়সা         | ১.৫      |
| `npm run reconcile` | এক দিনের ১০ লাখ payment, UTC+6 বনাম UTC — তিনটা মেলানোর নিয়ম                                    | ১.৬      |
| `npm run smoke`     | আসল HTTP: idempotency, decline, unknown → webhook, জাল webhook, recovery, refund, reconciliation | ১.৭      |

**সৎ নোট:**

- **হার আর দাম ধরে নেওয়া** — ৪% decline, ১% timeout (তার ৬০% আসলে কাটা), fee ২.৯% + ৩০ সেন্ট (একটা প্রচলিত তালিকার দামের মতো,
  দেশ আর চুক্তি ভেদে আলাদা), ledger এ payment প্রতি ৬টা entry, ৭ বছর রাখা (আইন দেশ ভেদে আলাদা, এখানে যাচাই করা না)।
- **`ledger` এর race একটা model** — virtual time এ পড়া আর লেখার মাঝে DB এর round trip; আসল Postgres এ isolation level আর lock
  এর আচরণ (5.5) ফল বদলাতে পারে। "শুধু debit এর lock" মানে credit একটা append-only insert, lock ছাড়া — balance পরে গোনা হয়।
- **`reconcile` এর ডেটা synthetic** — অমিলের চার ধরন বিরল হারে ঢোকানো; PSP এর দিনের সীমা UTC তে, আমাদের UTC+6 এ।
- **`smoke` আসল HTTP চালায়**, কিন্তু PSP একটা in-memory fake, store in-memory, ঘড়ি নকল। Webhook এর signature আসল HMAC-SHA256,
  constant-time তুলনা সহ। Card এর data নেই (আসল নকশায় PSP এর tokenization, তাই card number আমাদের system এ ঢোকেই না)।
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
npm run timeout
npm run ledger
npm run reconcile
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` — চাপ ছোট, টাকা বড়:

```
payments / s (on a sale day, 10×)                              1,157   small for a Postgres
money per day                                           $300 million
mistakes on 0.01% of payments                                $30,000     $10.9 million
```

`npm run timeout` — timeout কে ব্যর্থ ধরলে দুবার কাটা আর হারানো টাকা; key বা "unknown" এ শূন্য; আগে intent লিখলে crash এ কিছু
হারায় না:

```
timeout = failed, let the user try again                      4,060              1,819            —
resend it ourselves, a new request                            5,821                  0            —
resend it ourselves, the same idempotency key                     0                  0            —
keep "unknown": webhook, else ask for the status                  0                  0         52 s
charge at the PSP → then write the payment to the DB                                 970                   0
intent in the DB (created) → PSP → the result in the DB                                0                 955
```

`npm run ledger` — balance column এ টাকা উধাও; double-entry এ শূন্য, কিন্তু গরম account এ lock এর লাইন:

```
balance column: read, compute, write                             -5,139,292                 0           158              no        0.00 ms
double-entry: one transaction, locks on both accounts                     0                 0             0      yes, Σ = 0        37.40 s
double-entry: lock only the account paying out                            0                 0             0      yes, Σ = 0        7.39 ms
0.1 + 0.2 = 0.30000000000000004; 0.029 * 100 = 2.9000000000000004
```

`npm run reconcile` — amount দিয়ে মেলালে আসল সমস্যা লুকায়; id দিয়ে একই তারিখে পাঁচ লাখ মিথ্যা alert; id + ±১ দিনে নিখুঁত:

```
same date, matching amounts only                          56,020         1        56,019        371 (100%)
our payment id (in the PSP's reference), same date       500,514       318       500,196          54 (15%)
payment id, a ±1 day window                                  372       372             0            0 (0%)
```

`npm run smoke` — ১৩টা ধাপ:

```
1   a $30.00 payment                                            201 succeeded; psp_receivable $30.00, merchant:m_shop −$28.83, revenue:fees −$1.17
2   the same idempotency key again (the client's retry)         200 pay_1 (earlier pay_1); PSP calls 1
4   $55.00, PSP timeout (actually charged)                      202 unknown
6   a fake webhook (wrong secret)                               401; pay_1 still succeeded
7   $77.00 timeout, webhook lost; recovery job 5 minutes later  1 fixed → succeeded
10  refund another $25.00 (over the total captured)             409 exceeds
11  matching the PSP's report at the end of the day             pay_3: 2 times at the PSP
13  the sum of all entries                                      0 cents (12 entries)
```

## কী দেখার জন্য এটা বানানো

- **Payment এ চাপ ছোট, ভুল বড়।** সেকেন্ডে ১,০০০ একটা database এর জন্য কিছু না; কিন্তু ০.০১% ভুল বছরে $১.১ কোটি।
- **Timeout মানে "জানি না"।** ব্যর্থ ধরলে দুবার কাটা আর "কাটা কিন্তু order নেই"; একটা তৃতীয় অবস্থা লাগে, `unknown`।
- **আগে intent, তারপর PSP।** উল্টো ক্রমে crash হলে টাকা কাটা হয় আর কোনো রেকর্ড থাকে না (7.5 এর dual write)।
- **Ledger এ টাকা শুধু সরে, তৈরি বা ধ্বংস হয় না;** তাই Σ = 0 একটা প্রমাণযোগ্য নিয়ম। Balance column এ race আর crash নিঃশব্দে
  টাকা হারায়।
- **গরম account কে lock করা ভুল জায়গা:** credit এ overdraft এর check লাগে না।
- **টাকা integer পয়সায়,** আর rounding এর নিয়ম লিখে রাখা।
- **Reconciliation শেষ রক্ষাকবচ,** আর তার সবচেয়ে বড় শত্রু মিথ্যা alert (দিনের সীমা)।

## নিজে ভেঙে দেখো (Experiments)

1. **কম user retry করে:** `USER_RETRY=0.3 npm run timeout`। "timeout = ব্যর্থ" নীতিতে দুবার কাটা কমল (মাপা: ১,৭৪৬), কিন্তু "কাটা,
   order নেই" কত হলো (৪,২৪৮)? কোনটা খারাপ, আর কে টের পায়?
2. **প্রায় সব timeout আসলে কাটা:** `CHARGED_ON_TIMEOUT=0.95 npm run timeout`। নতুন request এ দুবার কাটা কত (মাপা: ৯,২০৬)?
3. **কম গরম merchant:** `HOT_SHARE=0.1 npm run ledger`। দুই account lock এ অপেক্ষা কত (মাপা: ২০ ms)? কোন হারে লাইনটা বিস্ফোরিত
   হয়, আর কেন (ক্ষমতা বনাম চাহিদা)?
4. **একই time zone:** `OFFSET_H=0 npm run reconcile`। id এর একই তারিখের নিয়ম এখন কেমন (মাপা: ৩৭২ alert, সব আসল)? Amount এর নিয়ম
   এখনও কেন ৯৮% আসল সমস্যা লুকায়?
5. **Code বদলানোর কাজ:** `src/payments.ts` এ merchant এর payout যোগ করো: সপ্তাহে একবার `merchant:*` এর balance থেকে bank এ
   পাঠানো, ledger এ একটা জোড়া entry (`merchant` → `bank_payable`)। Refund যদি payout এর পরে আসে আর merchant এর balance শূন্য,
   তখন কী হবে?

## Project Structure

```
src/
  util.ts       seed দেওয়া PRNG, lognormal, percentile, টেবিলের format, env parse
  scheduler.ts  virtual time এর event scheduler (min-heap), 11.2 থেকে
  estimate.ts   script ক — চাপ, টাকা, ভুলের দাম, ledger, একটা payment এর টাকার পথ
  timeout.ts    script খ — PSP timeout এর চারটা নীতি; crash এ লেখার ক্রম
  ledger.ts     script গ — balance column বনাম double-entry (race, crash, lock); float বনাম পয়সা, rounding
  reconcile.ts  script ঘ — অমিলের চার ধরন, UTC এর দিনের সীমা, তিনটা মেলানোর নিয়ম
  payments.ts   PaymentService (intent, unknown, webhook HMAC, recovery, refund, ledger Σ = 0, reconcile) আর Express app
  smoke.ts      script ঙ — fake PSP সহ ১৩টা ধাপ
```

Environment variable: `PAYMENTS_PER_DAY`, `AVG_USD`, `PEAK`, `ENTRIES_PER_PAYMENT`, `ENTRY_BYTES`, `YEARS`, `FEE_SHARE`,
`FEE_FIXED`, `PAYMENTS`, `DECLINE`, `TIMEOUT`, `CHARGED_ON_TIMEOUT`, `USER_RETRY`, `WEBHOOK_MEDIAN_S`, `WEBHOOK_LOST`,
`POLL_AFTER_S`, `CRASH`, `ACCOUNTS`, `START`, `TRANSFERS`, `RATE`, `DB_MS`, `PRICES`, `HOT_SHARE`, `OFFSET_H`,
`MISSED_WEBHOOK`, `NEVER_CAPTURED`, `AMOUNT_DIFF`, `DUPLICATE`, `SEED`।
