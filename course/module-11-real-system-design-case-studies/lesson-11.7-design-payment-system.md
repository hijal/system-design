# Lesson 11.7 — Case Study: Design a Payment System

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 7.5):** Dual write কী? একটা request এ database এ লেখা আর queue তে event পাঠানো, দুটো আলাদা system এ — কেন কোনো ক্রম (আগে DB, পরে queue, বা উল্টো) এটাকে নিরাপদ করে না? আর transactional outbox কীভাবে করে? আজ দ্বিতীয় system টা একটা queue না, একটা bank এর দিকের payment provider, আর "মাঝপথে crash" মানে কারো টাকা কাটা হলো আর আমাদের কাছে তার কোনো রেকর্ড নেই।

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 5.5 (Transaction, lost update), Lesson 6.4 (ঘড়ি), Lesson 7.4 (Retry), Lesson 7.5 (Dual write, outbox), Lesson 9.3 (Saga), Lesson 10.5 (Webhook এর signature, secret), Lesson 11.2 (Key splitting), Lesson 11.5 (Timeout মানে "জানি না")

**আপনি এই lesson শেষে পারবেন:**

1. Payment কে একটা state machine হিসেবে নকশা করতে পারবেন, যেখানে "জানি না" (unknown) একটা পূর্ণ অবস্থা; PSP এর timeout এ কেন "ব্যর্থ" ধরা দুবার কাটা আর হারানো টাকা দুটোই আনে, আর কেন intent আগে লেখা, idempotency key, webhook আর recovery job মিলে প্রতিটা payment এর একটা নিশ্চিত শেষ দেয়
2. Double-entry ledger বানাতে পারবেন আর বলতে পারবেন কেন এটা একটা `balance` column এর চেয়ে নিরাপদ: টাকা শুধু সরে, Σ = 0 একটা প্রমাণযোগ্য নিয়ম, আর ইতিহাস কখনো বদলায় না; সাথে টাকা integer পয়সায়, rounding এর নিয়ম, আর গরম account এর lock এর ফাঁদ
3. Reconciliation নকশা করতে পারবেন: দিনশেষে নিজের হিসাব আর PSP এর হিসাব মেলানো, কোন key দিয়ে, কোন জানালায়, যাতে আসল সমস্যা ধরা পড়ে আর মিথ্যা alert এর বন্যা না হয়

**Tier:** 1 — Runnable Code (চারটা deterministic model আর একটা আসল Express + Zod payment service, fake PSP আর HMAC দেওয়া webhook সহ; Docker লাগে না)

---

## ০. আজকের System

Interviewer:

> "একটা e-commerce এর checkout এর payment system design করুন। Customer card দিয়ে pay করে, আমরা একটা payment provider ব্যবহার করি, আর বিক্রেতারা (merchant) সপ্তাহে একবার টাকা পায়। Refund ও আছে।"

Module 11 এর আগের ছয়টা system এ প্রায় সবখানে একটা কথা চলত: "কয়েক সেকেন্ডের পুরনো data চলে", "একটা হারালে ক্ষতি ছোট", "আন্দাজে গুনলেই হয়"। এখানে কোনোটাই চলে না। Payment এর প্রথম চাল প্রায়ই: "Checkout এ PSP কে call করি, success হলে order এর `status = 'paid'` আর merchant এর `balance += amount`।" আর প্রশ্নগুলো:

- "PSP 30 সেকেন্ডে উত্তর দিল না। Customer কে কী দেখাবেন? আবার charge করবেন?"
- "PSP কে call করার পরে, DB তে লেখার আগে আপনার server মরে গেল। এখন?"
- "দুটো order একসাথে একই merchant এর balance বাড়াল। দুটোই কি টিকেছে?"
- "$19.99 + $5.01 কে float এ যোগ করলে?"
- "মাসের শেষে finance বলছে PSP থেকে আসা টাকা আর আপনার হিসাবে $৩,২১০ পার্থক্য। কোথায়?"

এখানে system design এর প্রায় প্রতিটা module এর একটা টুকরো আসে, সর্বোচ্চ চাপে: 2.5 এর idempotency, 5.5 এর transaction, 7.5 এর outbox, 9.3 এর saga, 10.5 এর signature, 11.5 এর "timeout মানে জানি না"।

---

## ১. Theory

### ১.১ Step 1 — Requirement

```
প্রশ্ন                                     ধরে নিলাম
কী কী কাজ?                                 card এ payment, পুরো বা আংশিক refund, merchant এর সাপ্তাহিক payout
কার মাধ্যমে?                               একটা PSP (প্রধান), পরে দ্বিতীয়টা
কত?                                        দিনে ১ কোটি payment, গড় $৩০; sale এর দিনে ১০ গুণ
Card এর data?                              আমাদের system এ ঢুকবে না — PSP এর tokenization (নিচে)
কোন currency?                              আজ USD; বহু currency এক লাইনে শেষে
বাদ দিলাম                                  fraud detection এর model, subscription, বহু currency এর রূপান্তর, কর
```

**Non-functional, আর এখানে অগ্রাধিকার বদলায়:** সঠিকতা availability এর আগে। একজনের টাকা দুবার কাটার চেয়ে কয়েক সেকেন্ড "processing…" দেখানো অনেক ভালো। প্রতিটা payment এর একটা নিশ্চিত শেষ থাকতে হবে (সফল বা ব্যর্থ, কখনো চিরকাল "অজানা" না)। প্রতিটা টাকার নড়াচড়ার একটা অপরিবর্তনীয় রেকর্ড (audit), বছরের পর বছর। আর **PCI DSS** (card এর data নিরাপত্তার মান): card number যত কম জায়গায়, তত ভালো। তাই প্রচলিত নকশায় card number সরাসরি browser থেকে PSP তে যায় (PSP এর নিজের form বা SDK), আর আমরা পাই শুধু একটা token। আমাদের database এ কখনো card number থাকে না, আর compliance এর বোঝা অনেক ছোট।

**Payment Service Provider (PSP)** — যে বাইরের কোম্পানি card network আর bank এর সাথে কথা বলে আমাদের হয়ে টাকা কাটে (Stripe, Adyen, বা কোনো দেশের স্থানীয় gateway এর মতো); আমাদের দিক থেকে একটা API, নিজের ধীরতা, ব্যর্থতা, আর নিজের হিসাব সহ।

### ১.২ Step 2 — Estimation: চাপ ছোট, ভুল বড়

`npm run estimate`:

```
── Part A — load: 10 million payments a day, $30 on average ──
payments / s (average)                                           116
payments / s (on a sale day, 10×)                              1,157   small for a Postgres
money per day                                           $300 million

── Part B — the price of mistakes ──
mistakes on 0.1% of payments                                $300,000      $110 million
mistakes on 0.01% of payments                                $30,000     $10.9 million
mistakes on 0.001% of payments                                $3,000        $1,095,000

── Part C — ledger: 6 entries per payment ──
entries per day                                           60 million
kept 7 years (legal)                                     153 billion   30.7 TB

── Part D — where the money of one $30 payment goes (fee 2.9% + $0.3, approximate) ──
the customer paid                                             $30.00
processing fee                                                 $1.17   3.9%
the merchant gets                                             $28.83   a few days later, in the payout
```

এই lesson এর বাকিটা এই এক টেবিলের ব্যাখ্যা। **চাপ ছোট:** sale এর দিনেও সেকেন্ডে ~১,২০০, একটা ভালো Postgres এর জন্য সহজ; sharding এর প্রশ্নই নেই (11.1 এর মতো)। **ভুল বড়:** দশ হাজারে একটা ভুল বছরে $১.১ কোটি। আর ভুলগুলো সাধারণত ক্লান্তিকর জায়গা থেকে আসে, যেমন একটা timeout, একটা crash, একটা race, একটা rounding, একটা time zone। নকশার কাজ তাই throughput না, **প্রতিটা কিনারার ঘটনায় নির্ভুলতা।**

(একটা সৎ স্বীকারোক্তি: এই script লেখার সময় প্রথমবার fee এর শিরোনামে ছাপা হয়েছিল `2.9000000000000004%`, কারণ `0.029 * 100` একটা float। ১.৫ এ ঠিক এই সমস্যা।)

### ১.৩ Step 3 — High-level design আর payment এর state machine

```
 browser ──card──► [PSP এর form/SDK] ──token──► browser ──► [checkout API]
                                                                 │
                         ① POST /payments { amount, idempotencyKey }
                                                                 ▼
                                       [payment service] ── ② DB: payment(created) + ledger
                                                │ ③ PSP.charge(ref = payment id)
                                                ▼
                                             [PSP] ──── ④ webhook (signed) ────► [payment service]
                                                │                                     │
                                                └── ⑤ দিনশেষে settlement report ──► [reconciliation]
                                                                                      │
                                         [recovery job] — "created"/"unknown" কে PSP তে জিজ্ঞেস করে
                                         [payout job] — সপ্তাহে merchant এর balance → bank
```

**Payment Intent** — একটা payment এর রেকর্ড যা **PSP কে ডাকার আগেই** তৈরি হয়, একটা অনন্য id (যেটা PSP এর কাছে reference আর idempotency key হিসেবে যায়) আর একটা অবস্থা সহ। অবস্থাগুলো:

```
                 ┌───────────── declined ─────────────► failed
created ──PSP──► ├───────────── charged ──────────────► succeeded ──► (refund, আংশিক, বারবার)
                 └── timeout / 5xx / crash ──► unknown ─┬─ webhook: charged ──► succeeded
                                                         ├─ webhook: failed ───► failed
                                                         └─ recovery: PSP কে জিজ্ঞেস ──► succeeded / failed
```

**Unknown State** — PSP এর কাছ থেকে নিশ্চিত উত্তর না আসা পর্যন্ত payment এর অবস্থা: সফলও না, ব্যর্থও না। Customer কে "processing" দেখায়, আর তিনটা পথের একটায় শেষ হয় (webhook, recovery এর জিজ্ঞাসা, বা reconciliation)। এটা ১১.৫ এর "timeout মানে জানি না" কে একটা পূর্ণ, দৃশ্যমান অবস্থা বানানো।

### ১.৪ Deep dive ১ — Timeout আর crash: কখন টাকা কাটা হয়েছে?

`npm run timeout` অংশ ক: ১০ লাখ payment, ১% timeout, যার ৬০% আসলে কাটা হয়েছিল:

```
policy                                                charged twice  charged, no order     wait p99
timeout = failed, let the user try again                      4,060              1,819            —
resend it ourselves, a new request                            5,821                  0            —
resend it ourselves, the same idempotency key                     0                  0            —
keep "unknown": webhook, else ask for the status                  0                  0         52 s
```

- **"ব্যর্থ" ধরা:** customer কে "payment failed, আবার চেষ্টা করুন" দেখানো। যারা আবার চেষ্টা করে আর প্রথমটা আসলে কেটেছিল, তাদের **দুবার কাটা** (৪,০৬০)। আর যারা চেষ্টা করে না, তাদের টাকা কাটা কিন্তু order নেই (১,৮১৯): তারা জানে না, আমরাও জানি না যতক্ষণ না reconciliation ধরে। দ্বিতীয়টা চুপচাপ, আর তাই খারাপ। Experiment ১: কম মানুষ আবার চেষ্টা করলে দুবার কাটা কমে, কিন্তু "কাটা, order নেই" বেড়ে ৪,২৪৮।
- **নিজে আবার পাঠানো, নতুন request:** কিছু হারায় না, কিন্তু প্রথমটা কেটে থাকলে দ্বিতীয়টাও কাটে: ৫,৮২১। Experiment ২: প্রায় সব timeout আসলে কাটা হলে (৯৫%) ৯,২০৬।
- **একই idempotency key:** PSP একই key এ দ্বিতীয়বার কাটে না, আগের ফল ফেরত দেয় (বড় PSP গুলো এটা দেয়)। শূন্য আর শূন্য। শর্ত: PSP সাড়া দিচ্ছে।
- **Unknown রাখুন:** PSP এর webhook (সাধারণত সেকেন্ডে আসে) বা, না এলে, এক মিনিট পরে PSP কে নিজে জিজ্ঞেস করা। শূন্য আর শূন্য, দাম: কিছু customer সর্বোচ্চ ~এক মিনিট "processing" দেখে (p99 ৫২ s)। Key দিয়ে retry আর unknown একসাথে চলে: retry আগে, তারপরও উত্তর না এলে unknown।

**Spaced repetition এর উত্তর, আর অংশ খ:** dual write এ দুটো system এর মাঝে একটা crash যেকোনো ক্রমে একটাকে অন্যটা ছাড়া রেখে দিতে পারে; outbox একটা system এ (DB) একটা transaction এ দুটোই লেখে, আর পরে অন্যটায় পাঠায়। এখানে দ্বিতীয় system টা PSP, যাকে আমাদের transaction এ আনা যায় না। তাই একমাত্র নিরাপদ ক্রম: **আগে নিজের কাছে টেকসই রেকর্ড, তারপর বাইরের কাজ।** প্রতি ধাপে ০.১% crash:

```
order                                                         charged, we have no record      recovery finds
charge at the PSP → then write the payment to the DB                                 970                   0
intent in the DB (created) → PSP → the result in the DB                                0                 955
```

আগে PSP তে charge করলে, crash এর পরে ৯৭০ জনের টাকা কাটা আর আমাদের কোথাও কিছু নেই — খোঁজার মতো কোনো সূত্রও না। আগে intent লিখলে, সেই crash এ payment টা `created` অবস্থায় পড়ে থাকে, আর **recovery job** (কয়েক মিনিট পরপর, "created বা unknown, X মিনিটের বেশি পুরনো" খোঁজে) PSP কে payment id দিয়ে জিজ্ঞেস করে আর ঠিক করে: ৯৫৫টা খুঁজে পায়, শূন্য হারায়। এটা ঠিক outbox এর ধারণা: নিজের DB তে "আমি এটা করতে যাচ্ছি" লিখে রাখুন, যাতে crash এর পরে কেউ শেষ করতে পারে।

**Webhook** এর একটা নিরাপত্তার দিক (10.5): webhook একটা public endpoint, যেখানে যে কেউ লিখতে পারে "pay_1 সফল"। তাই PSP প্রতিটা webhook এ body এর একটা HMAC signature দেয় (একটা ভাগ করা secret দিয়ে), আর আমরা **কাঁচা body** এর উপর সেটা যাচাই করি (parse করার আগে; JSON আবার serialize করলে byte বদলায়), constant-time তুলনায়। Smoke এর ধাপ ৬: জাল webhook ৪০১। আর webhook ও at-least-once আসে, দুবার আসতে পারে, ক্রম ছাড়া: তাই এর processing idempotent (একটা ইতিমধ্যে সফল payment আবার সফল হলে কিছু হয় না)।

### ১.৫ Deep dive ২ — Double-entry ledger

প্রথম চালের `merchant.balance += amount` এর দুটো সমস্যা। `npm run ledger`: ১,০০০টা wallet, ২ লাখ transfer, তার ৩০% একটা বড় merchant এর দিকে (একটা sale এর দিনের মতো), DB এর round trip ~২ ms, ০.১% মাঝপথে crash:

```
design                                                         total change  negative wallets   lost midway       provable?  wait on locks
balance column: read, compute, write                             -5,139,292                 0           158              no        0.00 ms
balance column: each row atomic, two separate statements            -35,998                 0           157              no        0.00 ms
double-entry: one transaction, locks on both accounts                     0                 0             0      yes, Σ = 0        37.40 s
double-entry: lock only the account paying out                            0                 0             0      yes, Σ = 0        7.39 ms
```

- **পড়ুন, হিসাব করুন, লিখুন:** 5.5 এর lost update, এবার টাকায়। গরম merchant এর balance এ দুটো transfer একই পুরনো মান পড়ে, একটার যোগ হারায়। ১০০ সেকেন্ডে **৫১ লাখ পয়সা** ($৫১,০০০) নিঃশব্দে উধাও। Experiment এ DB ধীর (১০ ms) হলে ৮৪ লাখ: race এর জানালা বড়।
- **প্রতিটা row atomic, কিন্তু দুটো আলাদা statement:** race নেই, কিন্তু debit এর পরে credit এর আগে crash হলে টাকা এক জায়গা থেকে গেল, আরেক জায়গায় পৌঁছাল না: ৩৬,০০০ পয়সা। আর দুই ক্ষেত্রেই কেউ টের পায় না, কারণ balance একটা সংখ্যা, তার ইতিহাস নেই।
- **Double-Entry Ledger** — প্রতিটা টাকার নড়াচড়া একটা transaction, যেখানে অন্তত দুটো entry (একটা account এ debit, আরেকটায় credit), আর একটা transaction এর সব entry এর যোগফল **শূন্য**। Entry কখনো বদলায় বা মোছে না (ভুল ঠিক করতে আরেকটা উল্টো transaction)। Balance একটা derived মান: সেই account এর সব entry এর যোগফল। পাঁচশো বছরের পুরনো হিসাবরক্ষণের নিয়ম, আর কারণটা এখানেই দেখা যায়: **Σ সব entry = 0** সবসময় সত্য হতে হবে, তাই কোনো bug, race বা crash টাকা তৈরি বা ধ্বংস করলে সেটা গণিত দিয়ে ধরা পড়ে। এক database transaction এ entry গুলো লেখা হয়, তাই crash এ সব বা কিছুই না।

Smoke এর ধাপ ১: $৩০ এর payment মানে তিনটা entry: `psp_receivable +$30.00`(PSP আমাদের দেবে),`merchant:m_shop −$28.83` (আমরা merchant কে দেব), `revenue:fees −$1.17` (আমাদের আয়)। যোগফল শূন্য। (চিহ্নের নিয়ম: debit ধনাত্মক, credit ঋণাত্মক; দায় বা আয় এর account স্বাভাবিকভাবে ঋণাত্মক।) শেষ ধাপে ১২টা entry এর যোগফল **০ পয়সা**।

**গরম account এর ফাঁদ:** প্রথম ledger এর নকশা দুটো account ই lock করে (overdraft এর check এর জন্য)। কিন্তু গরম merchant এর account এ সেকেন্ডে ৬০০টা transfer, প্রতিটা ~২ ms ধরে রাখে: চাহিদা ক্ষমতার বেশি, আর লাইন বাড়তেই থাকে, সবচেয়ে খারাপ অপেক্ষা **৩৭ সেকেন্ড।** Experiment ৩: গরম ভাগ ১০% হলে ২০ ms। লক্ষ্য করুন: overdraft এর check শুধু টাকা **যে দেয়** তার দরকার; টাকা পাওয়া account এর balance কমে না, তাই তাকে lock করার দরকার নেই। Credit একটা lock ছাড়া insert (append-only), আর balance পরে গোনা হয়: ৭ ms। আরও বড় মাপে: গরম account কে কয়েকটা sub-account এ ভাগ (11.2 এর key splitting), যোগফল payout এর সময়।

**Minor Units** — টাকা সবসময় তার সবচেয়ে ছোট এককের integer এ রাখা (cent, পয়সা), কখনো float এ না। অংশ খ:

```
sum in float (dollars)                              504892524.099961
sum in integers (cents) ÷ 100                       504892524.100000
0.1 + 0.2 = 0.30000000000000004; 0.029 * 100 = 2.9000000000000004

fee 2.9%: rounding each then summing 1,464,194,395 cents, rounding once on the total 1,464,188,320 cents — difference 6,075 cents
```

এক কোটি দামের যোগে float এর ভুল মাত্র ০.০০৪ পয়সা — ছোট, কিন্তু শূন্য না, আর `===` দিয়ে তুলনা ভাঙে, আর দুটো system এর হিসাব "প্রায়" মেলে, কখনো পুরো না। দ্বিতীয় লাইনটা আরও সূক্ষ্ম: integer এও rounding এর **নিয়ম** লাগে। প্রতিটা payment এর fee আলাদা round করে যোগ বনাম মোটের উপর একবার round: ৬,০৭৫ পয়সা পার্থক্য। দুটোই যুক্তিসঙ্গত। কিন্তু আপনি একটা, PSP আরেকটা ব্যবহার করলে হিসাব কখনো মিলবে না। তাই rounding (কোথায়, কোন দিকে, half-up না banker's) একটা লেখা নিয়ম, PSP এর নিয়মের সাথে মিলিয়ে। আর বহু currency তে: প্রতিটা currency এর minor unit আলাদা (JPY এর কোনো পয়সা নেই, কিছু currency তে তিন দশমিক), তাই amount সবসময় currency এর সাথে জোড়া।

### ১.৬ Deep dive ৩ — Reconciliation

Unknown, recovery, ledger — সব থাকার পরেও কিছু ফসকায়: একটা webhook হারায় আর recovery এর একটা bug, PSP এর দিকে capture যায়নি, PSP একটা charge দুবার নিল, একটা amount এক পয়সা আলাদা। এদের ধরার শেষ রক্ষাকবচ:

**Reconciliation** — নিয়মিত (সাধারণত প্রতিদিন) নিজের হিসাব আর বাইরের হিসাব (PSP এর settlement report, bank এর statement) এক এক করে মেলানো, আর প্রতিটা অমিল একটা মানুষের বা স্বয়ংক্রিয় তদন্তে পাঠানো। **Settlement** — PSP যে টাকা কাটল সেটা আমাদের bank account এ আসে কয়েক দিন পরে, fee কেটে, একটা report সহ; ledger এর `psp_receivable` এই আসার সাথে কমে, আর তাও মেলাতে হয়।

`npm run reconcile`: একটা দিনে ১০ লাখ payment, ৩৭২টা আসল সমস্যা (চার ধরনের), আর একটা বাস্তব খুঁটিনাটি: PSP এর দিন UTC তে, আমাদের UTC+6 এ (বাংলাদেশ):

```
matching rule                                              alert      real  false alerts  real, not caught
same date, matching amounts only                          56,020         1        56,019        371 (100%)
our payment id (in the PSP's reference), same date       500,514       318       500,196          54 (15%)
payment id, a ±1 day window                                  372       372             0            0 (0%)
```

- **Amount দিয়ে মেলানো:** একই amount এর অনেক payment, তাই এলোমেলো জোড়া, আর একটা আসল সমস্যা প্রায় সবসময় একটা ভুল জোড়ার আড়ালে লুকায়: **৩৭২ এর ৩৭১টাই ধরা পড়ে না,** আর তার উপর ৫৬,০০০ মিথ্যা alert। Experiment ৪: একই time zone এও ৯৮% লুকায়। মেলানোর key হতে হবে অনন্য, আর সেজন্যই PSP কে আমাদের payment id reference হিসেবে দেওয়া।
- **Id দিয়ে, কিন্তু একই তারিখে:** আমাদের দিনের প্রথম ৬ ঘণ্টা PSP এর আগের দিনে, আর PSP এর দিনের শেষ ৬ ঘণ্টা আমাদের পরের দিনে। প্রতিদিন **পাঁচ লাখ মিথ্যা alert।** কোনো মানুষ এটা পড়ে না, আর তার ভেতরে ৫৪টা আসল সমস্যাও হারায়। মিথ্যা alert শুধু বিরক্তি না, এটা reconciliation কে অকেজো করে দেয়।
- **Id, ±১ দিনের জানালা:** একটা দিনের অমিল কে পরের দিনের run পর্যন্ত "অপেক্ষায়" রাখা, তারপর আবার দেখা। ঠিক ৩৭২টা alert, সব আসল, শূন্য মিথ্যা। (6.4 এর মনে করুন: দুটো system এর "আজ" কখনো এক না; সীমানায় সহনশীলতা রাখুন।)

Smoke এর ধাপ ১১: PSP এর report এ `pay_3` দুবার (PSP এর দিকে একটা duplicate charge), reconciliation সেটা ধরে। তার ঠিক করা একটা refund আর customer কে জানানো।

### ১.৭ একটা আসল payment service

`npm run smoke` উপরের সব নিয়ম চালায়: integer পয়সা, intent আগে, idempotency key, unknown, HMAC webhook, recovery job, refund এর সীমা, double-entry ledger, reconciliation:

```
#   step                                                        result
1   a $30.00 payment                                            201 succeeded; psp_receivable $30.00, merchant:m_shop −$28.83, revenue:fees −$1.17
2   the same idempotency key again (the client's retry)         200 pay_1 (earlier pay_1); PSP calls 1
3   $42.00, card decline                                        402 failed; 3 entries in the ledger
4   $55.00, PSP timeout (actually charged)                      202 unknown
5   the PSP's webhook arrived (correct signature)               200 → succeeded
6   a fake webhook (wrong secret)                               401; pay_1 still succeeded
7   $77.00 timeout, webhook lost; recovery job 5 minutes later  1 fixed → succeeded
8   refund $10.00 of the $30.00                                 201 ok
9   the same refund key again                                   200 duplicate
10  refund another $25.00 (over the total captured)             409 exceeds
11  matching the PSP's report at the end of the day             pay_3: 2 times at the PSP
12  the ledger's final state                                    psp_receivable $152.00, merchant:m_shop −$146.79, revenue:fees −$5.21
13  the sum of all entries                                      0 cents (12 entries)
```

- ধাপ ২: client (browser বা checkout service) timeout পেয়ে একই key তে আবার ডাকল: একই payment, PSP তে একটাই call। দুই স্তরে idempotency: client → আমরা (key), আমরা → PSP (payment id)।
- ধাপ ৩: decline এ ledger এ কিছু লেখা হয় না — ledger শুধু টাকার আসল নড়াচড়া।
- ধাপ ৪-৫: 202 (accepted, এখনও অজানা), তারপর webhook এ succeeded। ধাপ ৭: webhook হারালে recovery।
- ধাপ ৮-১০: refund একটা নতুন ledger transaction (উল্টো দিকে, fee এর আনুপাতিক অংশ সহ), নিজের idempotency key সহ, আর captured এর বেশি refund অসম্ভব।

### ১.৮ Step 5 — Trade-off আর wrap-up

**চূড়ান্ত নকশা:**

- **Card এর data:** PSP এর tokenization; আমাদের কাছে শুধু token। PCI এর scope ছোট।
- **Payment:** intent আগে (DB), id = PSP এর reference আর idempotency key; client থেকে আমাদের দিকেও idempotency key। State machine এ `unknown` পূর্ণ অবস্থা। Retry একই key তে; webhook (HMAC, কাঁচা body, idempotent processing); recovery job কয়েক মিনিট পরপর।
- **Ledger:** double-entry, append-only, এক DB transaction এ; Σ = 0 এর একটা নিয়মিত check আর alert; balance derived (বা ledger থেকে আপডেট করা cache, কিন্তু সত্য ledger); গরম account এ credit lock ছাড়া, প্রয়োজনে sub-account। টাকা integer minor unit এ, currency সহ; rounding এর লেখা নিয়ম।
- **Reconciliation:** প্রতিদিন, payment id দিয়ে, ±১ দিনের জানালা, অমিল এর ধরন অনুযায়ী queue আর মালিক। Settlement আর bank এর statement এর সাথে দ্বিতীয় স্তর।
- **Payout:** সাপ্তাহিক job, ledger এ `merchant → bank_payable`, bank এর দিকে আবার idempotency আর reconciliation।
- **Scale:** একটা Postgres primary + synchronous replica (RPO শূন্য, 10.8) — throughput এর প্রয়োজন নেই, টেকসইতার আছে। Database এর isolation কড়া (5.5) যেখানে balance এর check।

> **Trade-off Table — payment এর বড় সিদ্ধান্ত**

| সিদ্ধান্ত      | বেছে নিলাম                                   | বিকল্প                       | কী দিলাম                                 | কী পেলাম                                                    |
| -------------- | -------------------------------------------- | ---------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Timeout        | `unknown` + key এ retry + webhook + recovery | "ব্যর্থ" দেখানো / নতুন retry | কিছু customer ~১ মিনিট "processing" দেখে | দুবার কাটা আর হারানো টাকা শূন্য (না হলে হাজারে)             |
| লেখার ক্রম     | Intent আগে, তারপর PSP                        | PSP আগে                      | প্রতিটা payment এ একটা বাড়তি লেখা       | Crash এ হারানো রেকর্ড শূন্য (না হলে ০.১% crash এ ৯৭০)       |
| টাকার হিসাব    | Double-entry, append-only                    | `balance` column             | বেশি row, balance গোনার খরচ              | Race আর crash এ টাকা উধাও হয় না; Σ = 0 দিয়ে প্রমাণ; audit |
| Lock           | শুধু debit এর account                        | দুই account                  | Credit এর balance পরে গোনা               | গরম merchant এ ৩৭ s থেকে ৭ ms                               |
| Amount         | Integer minor unit + rounding এর নিয়ম       | Float                        | প্রতিটা হিসাবে একক রূপান্তর              | Exact যোগ আর তুলনা; PSP এর সাথে মেলে                        |
| Reconciliation | Payment id, ±১ দিন                           | Amount / একই তারিখ           | অমিল এক দিন দেরিতে চূড়ান্ত              | আসল সব ধরা পড়ে, মিথ্যা alert শূন্য (না হলে দিনে ৫ লাখ)     |

**কী আগে ভাঙবে:** PSP এর দীর্ঘ outage (unknown এর স্তূপ, আর "দ্বিতীয় PSP তে পাঠাব?" এর প্রশ্ন — 11.5 এর মতো, failover এ key হারায়, তাই unknown গুলো কখনো দ্বিতীয় PSP তে না); একটা migration যা ledger এর entry কে "ঠিক" করতে UPDATE চালায় (append-only ভাঙে, audit হারায়); আর reconciliation এর অমিল যা কেউ পড়ে না, কারণ মিথ্যা alert এর অভ্যাস তৈরি হয়ে গেছে।

**বহু currency এক লাইনে:** প্রতিটা amount তার currency সহ, ledger এর account currency প্রতি আলাদা, রূপান্তর একটা আলাদা ledger transaction তার নিজের হার সহ, আর কখনো দুটো currency এর amount সরাসরি যোগ না।

---

## ২. Interview Angle

"Design a payment system" এ interviewer প্রায় সবসময় তিনটা জায়গায় যায়: idempotency আর timeout, ledger, আর reconciliation। Throughput নিয়ে প্রায় কিছু না — আর সেটা নিজে থেকে বলা (সংখ্যা দিয়ে) একটা ভালো লক্ষণ। ভালো উত্তরের আকৃতি:

1. **সঠিকতা আগে, আর কেন।** চাপ ছোট (সেকেন্ডে হাজার), ভুল বড় (০.০১% = বছরে কোটি টাকা)। Card এর data PSP তে (PCI)।
2. **State machine আর unknown।** Intent আগে, id = PSP এর idempotency key, timeout এ unknown, webhook (signed) আর recovery।
3. **Double-entry ledger।** কেন balance column না, Σ = 0, append-only, এক transaction। Integer minor unit।
4. **Reconciliation।** কী দিয়ে মেলাবেন, কোন জানালায়, অমিল কার কাছে যায়।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Double charge কীভাবে এড়াবেন?"_ — দুই স্তরে idempotency (client → আমরা, আমরা → PSP), timeout কে ব্যর্থ না ধরা। সংখ্যা: "ব্যর্থ" ধরলে ১০ লাখে ৪,০৬০ দুবার কাটা আর ১,৮১৯ হারানো।
- _"PSP call এর পরে server মরলে?"_ — Intent আগে লেখা ছিল, তাই `created` অবস্থায় আছে; recovery job PSP কে id দিয়ে জিজ্ঞেস করে। উল্টো ক্রমে চিরকাল হারায়।
- _"Exactly-once?"_ — বাইরের system এর সাথে না। At-least-once + idempotency + reconciliation।
- _"Ledger কেন? একটা balance column তো সহজ।"_ — Race (৫১ লাখ পয়সা উধাও), crash (debit আছে credit নেই), আর কোনো ইতিহাস নেই। Ledger এ Σ = 0 একটা গাণিতিক check।
- _"Saga কোথায়?"_ — Checkout এ: inventory reserve → payment → order confirm; payment ব্যর্থ হলে inventory ফেরত (9.3)। কিন্তু payment এর নিজের ভেতরে compensation মানে refund, যা নিজেই একটা payment, আর ব্যর্থ হতে পারে — তাই ledger আর reconciliation।
- _"Database কী?"_ — সম্পর্কের, ACID, কড়া isolation, synchronous replica। এখানে eventual consistency এর জায়গা নেই (balance), বা আছে শুধু read এর দিকে (dashboard)।

**Production এ বাস্তবে:** সবচেয়ে প্রচলিত ঘটনা: একটা timeout এর ঢেউ এ (PSP এর ধীর মুহূর্তে) হাজার হাজার দুবার কাটা, কারণ checkout এর frontend "আবার চেষ্টা করুন" এর বোতাম দেখিয়েছিল; webhook এর signature যাচাই parse করা JSON এ (byte বদলায়, সব webhook ব্যর্থ) বা একদমই না; একটা "সামান্য" migration যা ledger এর entry UPDATE করল; time zone এর জন্য reconciliation এর প্রতিদিনের হাজার মিথ্যা alert, যার মধ্যে আসল একটা হারাল; আর float এ টাকা, যা মাসের শেষে finance এর spreadsheet এ কয়েক পয়সার একটা অমিল হিসেবে দেখা দেয় আর কেউ খুঁজে পায় না।

---

## ৩. Key Takeaway

- **Payment এ চাপ ছোট, ভুল বড়:** সেকেন্ডে ~১,২০০ একটা Postgres এর জন্য কিছু না, কিন্তু ০.০১% ভুল বছরে $১.১ কোটি। নকশার কাজ প্রতিটা কিনারায় নির্ভুলতা
- **Timeout মানে "জানি না" — তাই `unknown` একটা পূর্ণ অবস্থা:** "ব্যর্থ" ধরলে ১০ লাখে ৪,০৬০ দুবার কাটা আর ১,৮১৯ হারানো টাকা; key এ retry আর webhook/recovery এ শূন্য
- **আগে নিজের রেকর্ড, তারপর বাইরের কাজ:** PSP আগে করলে ০.১% crash এ ৯৭০টা কাটা টাকার কোনো চিহ্ন নেই; intent আগে লিখলে recovery সব খুঁজে পায় (7.5 এর outbox এর ধারণা)
- **Double-entry ledger এ টাকা শুধু সরে:** Σ = 0 প্রমাণযোগ্য; balance column এ race এ ৫১ লাখ পয়সা আর crash এ ৩৬,০০০ নিঃশব্দে উধাও। Append-only, এক transaction
- **গরম account এ শুধু যে দেয় তার lock:** দুই account lock এ ৩৭ s এর লাইন, debit lock এ ৭ ms
- **টাকা integer minor unit এ, rounding এর লেখা নিয়ম সহ:** float এ `0.1 + 0.2 ≠ 0.3`; আর rounding এর জায়গা বদলালে ১ কোটি payment এ ৬,০৭৫ পয়সা পার্থক্য
- **Reconciliation শেষ রক্ষাকবচ, অনন্য key আর সীমানায় সহনশীলতা দিয়ে:** amount দিয়ে মেলালে আসল সমস্যার ১০০% লুকায়; একই তারিখে দিনে ৫ লাখ মিথ্যা alert; id + ±১ দিনে ঠিক আসলগুলো

---

## ৪. নতুন Term (Glossary)

| Term                               | অর্থ                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payment Service Provider (PSP)** | যে বাইরের কোম্পানি card network আর bank এর সাথে কথা বলে টাকা কাটে; আমাদের দিক থেকে একটা API, নিজের ধীরতা, ব্যর্থতা আর হিসাব সহ; card এর data tokenize করে PCI এর বোঝা নেয়          |
| **Payment Intent**                 | PSP কে ডাকার **আগে** তৈরি করা payment এর রেকর্ড, একটা অনন্য id (PSP এর reference আর idempotency key) আর একটা অবস্থা সহ — crash এর পরে কেউ শেষ করতে পারে                             |
| **Unknown State**                  | PSP এর নিশ্চিত উত্তরের আগের অবস্থা — সফলও না, ব্যর্থও না; webhook, PSP কে জিজ্ঞাসা (recovery), বা reconciliation এ শেষ হয়; timeout কে "ব্যর্থ" ধরা দুবার কাটা আর হারানো টাকা আনে   |
| **Double-Entry Ledger**            | প্রতিটা টাকার নড়াচড়া একটা transaction, অন্তত দুটো entry, যোগফল শূন্য; entry কখনো বদলায় না; balance derived — Σ = 0 দিয়ে race, crash আর bug গাণিতিকভাবে ধরা পড়ে                 |
| **Minor Units**                    | টাকা তার সবচেয়ে ছোট এককের integer এ (cent, পয়সা), currency সহ — float এর ভুল নেই; সাথে rounding এর একটা লেখা নিয়ম, যাতে নিজের আর PSP এর হিসাব মেলে                               |
| **Reconciliation**                 | নিয়মিত নিজের হিসাব আর বাইরের হিসাব (PSP এর report, bank) অনন্য key দিয়ে এক এক করে মেলানো আর প্রতিটা অমিলের তদন্ত — সীমানায় (দিন, time zone) সহনশীলতা, নইলে মিথ্যা alert এর বন্যা |
| **Settlement**                     | PSP এর কাটা টাকা কয়েক দিন পরে fee কেটে আমাদের bank এ আসা, একটা report সহ — ledger এর receivable কমায়, আর নিজেই আরেক স্তরের reconciliation চায়                                    |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. PSP এক ঘণ্টার জন্য প্রায় বন্ধ: অর্ধেক request timeout, বাকি ধীর। Sale চলছে, সেকেন্ডে ১,০০০ checkout। (ক) এই lesson এর নকশায় এই এক ঘণ্টায় কী জমে, কতগুলো, আর customer কী দেখে? (খ) একজন বলল "দ্বিতীয় PSP তে পাঠান।" কোন payment গুলো দ্বিতীয় PSP তে পাঠানো নিরাপদ আর কোনগুলো না, আর কেন? (গ) PSP ফিরে আসার পরে recovery job এর কী ঝুঁকি (11.3 এর মতো)?

2. TaskFlow (Module 1-10 এর app) একটা paid plan চালু করছে: মাসিক subscription, team এর আকার অনুযায়ী দাম, মাসের মাঝে seat যোগ করলে আনুপাতিক দাম (proration)। (ক) Ledger এ কোন কোন account লাগবে? (খ) মাসের মাঝে ৩ জন seat যোগ করা হলো, দিনের হিসাবে আনুপাতিক দাম: rounding এর নিয়ম কোথায় ঠিক করবেন, আর কেন সেটা invoice আর PSP এর charge এর মধ্যে মিলতে হবে? (গ) Card এর মেয়াদ শেষ হয়ে মাসিক charge ব্যর্থ হলে কী হবে (retry, grace period, অবস্থা)?

3. Finance বলছে: "গত মাসে ledger এ PSP থেকে পাওনা (`psp_receivable`) আর bank এ আসা settlement এর মধ্যে $৩,২১০ পার্থক্য।" (ক) এই lesson এর কোন কোন কারণে এটা হতে পারে (অন্তত চারটা)? (খ) প্রতিটার জন্য কোন report বা query দিয়ে খুঁজবেন? (গ) এই পার্থক্য খুঁজে পাওয়ার পরে ledger এ কীভাবে ঠিক করবেন, আর কী **করবেন না**?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) এক ঘণ্টায় ৩৬ লাখ checkout এর অর্ধেক (~১৮ লাখ) timeout হয়ে `unknown` এ জমে, key দিয়ে কয়েকবার retry এর পরে। Customer দেখে "processing", তারপর একটা নির্দিষ্ট সময় পরে (ধরুন ২ মিনিট) "আমরা আপনার payment নিশ্চিত করছি, নিশ্চিত হলে email পাবেন; আবার চেষ্টা করবেন না" — আর order টা "payment pending" অবস্থায়, inventory reserve করা (9.3 এর saga এর প্রথম ধাপ)। সবচেয়ে জরুরি: frontend এ "আবার চেষ্টা করুন" এর বোতাম **না**, কারণ সেটাই দুবার কাটার উৎস (১.৪ এর ৪,০৬০)।

(খ) **নিরাপদ:** যেসব payment এখনও প্রধান PSP তে একবারও পাঠানো হয়নি (নতুন checkout, প্রধানের breaker খোলা থাকলে), আর যেসব প্রধান PSP **স্পষ্টভাবে** ব্যর্থ বলেছে (declined না, কিন্তু "service unavailable" এর মতো নিশ্চিত না-কাটা)। **নিরাপদ না:** যেকোনো `unknown` — প্রধান PSP হয়তো কেটেছে, আর দ্বিতীয় PSP প্রথমটার key জানে না (11.5 এর failover এর duplicate, এবার টাকায়)। এগুলো প্রধান PSP ফিরলে তার কাছেই নিশ্চিত হবে। আর failover এর জন্য customer এর card এর token দ্বিতীয় PSP তে কাজ করে কিনা, সেটাও একটা প্রশ্ন (token সাধারণত এক PSP এর)।

(গ) PSP ফেরার সাথে সাথে recovery job ১৮ লাখ `unknown` এর জন্য একসাথে status জিজ্ঞেস করলে, সদ্য সুস্থ PSP আবার ডুবতে পারে, আর তার সাথে নতুন checkout ও (11.3 এর reconnect storm, এবার আমরা ঢেউ টা পাঠাচ্ছি)। তাই recovery paced (11.5 এর মতো, PSP এর সীমার একটা ভাগে), পুরনোগুলো আগে, আর নতুন checkout এর জন্য ক্ষমতা রেখে। অনেক PSP একটা দিনের report বা bulk status API দেয়, যা হাজারটা আলাদা call এর চেয়ে ভালো।

**প্রশ্ন ২:**

(ক) Account: `customer:<team>:receivable` বা সরাসরি `psp_receivable` (card charge এর জন্য), `revenue:subscriptions` (আয়), প্রয়োজনে `deferred_revenue` (আগাম নেওয়া টাকা যা এখনও আয় হয়নি — মাসের শুরুতে পুরো মাসের টাকা নিলে, হিসাবের নিয়মে দিনে দিনে আয় হয়), `revenue:fees` বা `expense:psp_fees` (PSP এর fee), আর `credits:<team>` (downgrade এ ফেরত না দিয়ে পরের invoice এ বাদ দেওয়ার জন্য)। প্রতিটা ঘটনা (invoice, charge, proration, credit) একটা জোড়া entry।

(খ) Proration এর হিসাব **invoice তৈরির সময় একবার**, integer পয়সায়, একটা লেখা নিয়মে (যেমন: দিন প্রতি দাম পয়সায় floor, মোট half-up)। তারপর invoice এর মোট টাকাটাই PSP তে charge হয়, PSP কোনো হিসাব করে না। কারণ: customer invoice এ যা দেখে, card এ ঠিক তাই কাটা উচিত, আর ledger এ ঠিক তাই — তিনটা জায়গায় আলাদা rounding মানে ১.৫ এর ৬,০৭৫ পয়সার মতো একটা চিরকালের অমিল, আর customer এর "আমার invoice $২৯.৯৭ কিন্তু কাটা হয়েছে $২৯.৯৮" এর ticket।

(গ) Charge ব্যর্থ (declined, card এর মেয়াদ শেষ): subscription "past_due" অবস্থায়, কয়েক দিনে কয়েকবার retry (dunning), প্রতিটায় একই invoice এর জন্য নতুন attempt কিন্তু **invoice এর id দিয়ে idempotency**, যাতে দুটো attempt সফল হলেও একবারই কাটে। Customer কে email (11.5) card আপডেট করার লিংক সহ। একটা grace period (ধরুন ৭ দিন) পরে plan নামানো, data মোছা না। Ledger এ invoice এর receivable থাকে যতক্ষণ না টাকা আসে বা লিখে দেওয়া হয় (write-off, আরেকটা transaction)।

**প্রশ্ন ৩:**

(ক) সম্ভাব্য কারণ: (১) **Settlement এর সময়ের ফারাক** — মাসের শেষ কয়েক দিনের charge পরের মাসে settle হয় (১.৬ এর দিনের সীমা, এবার মাসের); (২) **Fee এর অমিল** — PSP এর আসল fee (আন্তর্জাতিক card, currency রূপান্তর এর বাড়তি fee) আমাদের ধরে নেওয়া fee এর থেকে আলাদা, বা rounding এর জায়গা আলাদা (১.৫); (৩) **Refund আর chargeback** — PSP chargeback (customer এর bank এর মাধ্যমে বিতর্ক) এর টাকা কেটে নিয়েছে, আমাদের ledger এ সেটা এখনও আসেনি (chargeback এর webhook হারিয়েছে বা প্রক্রিয়াকরণ হয়নি); (৪) **হারানো বা দুবার charge** — reconciliation এর অমিল যা কেউ সমাধান করেনি (১.৬ এর চার ধরন); (৫) PSP এর একটা reserve (ঝুঁকির জন্য টাকার একটা অংশ আটকে রাখা) যা আমাদের ledger এ নেই।

(খ) (১) Charge এর তারিখ বনাম settlement এর তারিখ ধরে একটা ভাগ — "এই মাসে charge, পরের মাসে settle" এর যোগফল; (২) PSP এর settlement report এর প্রতিটা লাইনের fee বনাম আমাদের হিসাবের fee, payment id দিয়ে join, পার্থক্য currency আর card এর ধরন ধরে group; (৩) PSP এর report এ chargeback আর refund এর লাইন বনাম আমাদের ledger এর একই ধরনের transaction; (৪) দৈনিক reconciliation এর খোলা অমিলের তালিকা, বয়স ধরে; (৫) PSP এর balance বা reserve এর report।

(গ) **করবেন:** প্রতিটা খুঁজে পাওয়া কারণের জন্য একটা নতুন, ব্যাখ্যা সহ ledger transaction (যেমন `expense:psp_fees` এ বাড়তি fee, `chargeback_losses` এ chargeback), সঠিক তারিখে, একটা reference সহ (কোন report এর কোন লাইন)। যোগফল শূন্য থাকে, আর ইতিহাসে দেখা যায় কখন কেন। আর মূল কারণ (যেমন chargeback এর webhook এর processing) ঠিক করা, যাতে পরের মাসে না হয়। **করবেন না:** পুরনো entry UPDATE বা DELETE করে সংখ্যা মিলিয়ে দেওয়া, বা একটা "adjustment $৩,২১০" এর একক entry দিয়ে পার্থক্য চাপা দেওয়া যার কোনো ব্যাখ্যা নেই। দুটোই audit ভাঙে, আর পরের বার কেউ জানবে না কোন অংশটা আসলে কী ছিল।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (চারটা deterministic model আর একটা আসল Express + Zod payment service, fake PSP আর HMAC দেওয়া webhook সহ; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.7-payment-system/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.7-payment-system) — `npm install`, তারপর `npm run estimate`, `npm run timeout`, `npm run ledger`, `npm run reconcile`, `npm run smoke`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` চাপ, টাকা, ভুলের দাম, ledger এর আকার আর একটা payment এর টাকার পথ হিসাব করে। `timeout` PSP timeout এর চারটা নীতি আর crash এ লেখার দুটো ক্রম মাপে। `ledger` একটা গরম merchant সহ balance column আর double-entry এর চারটা নকশা virtual time এ চালায়, আর float বনাম পয়সা আর rounding দেখায়। `reconcile` একটা দিনের data তে তিনটা মেলানোর নিয়ম তুলনা করে। `smoke` একটা আসল payment service কে fake PSP সহ ১৩টা ধাপে চালায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, আপনার। **হার আর দাম ধরে নেওয়া** (decline, timeout, fee, crash), মাপা না; ledger এর ৭ বছর রাখা একটা সাধারণ সংখ্যা, আইন দেশ ভেদে আলাদা। `ledger` এর race virtual time এর model, আসল Postgres এর isolation আর lock এর আচরণ ফল বদলাতে পারে। `reconcile` এর data synthetic। `smoke` এর PSP আর store in-memory, ঘড়ি নকল; webhook এর HMAC আসল। PCI DSS, tokenization আর বড় PSP গুলোর idempotency key এর সমর্থন সম্পর্কে কথাগুলো সাধারণ আর প্রকাশিত লেখা থেকে, আইনি বা compliance এর পরামর্শ না। **যা মাপা হয়নি:** আসল PSP, আসল database এর transaction, chargeback, বহু currency, fraud।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `timeout` চালানোর **আগে** লিখে ফেলুন: "timeout = ব্যর্থ" নীতিতে ১০ লাখে কতগুলো দুবার কাটা হবে? হাতে হিসাব করুন (timeout × আসলে কাটা × user এর retry × দ্বিতীয়টা সফল), তারপর চালিয়ে মেলান।

2. **Race এর জানালা:** `ledger` এ `DB_MS=0.5` আর `DB_MS=10`। Balance column এ টাকা উধাও কীভাবে বদলায়? কেন "atomic row" এর নকশা DB এর গতিতে প্রায় নড়ে না, অথচ "পড়ুন-লিখুন" নড়ে?

3. **দিনের সীমা:** `OFFSET_H=1` আর `OFFSET_H=12` দিয়ে `reconcile`। "একই তারিখ" এর নিয়মের মিথ্যা alert কীভাবে বদলায়, আর কেন ±১ দিনের জানালা দুটোতেই কাজ করে? কোন অবস্থায় ±১ দিনও যথেষ্ট না?

4. **Code বদলানো:** README এর experiment ৫ (payout)। তারপর `src/payments.ts` এ একটা `checkInvariant()` যোগ করুন যা Σ = 0 আর প্রতিটা transaction এর যোগফল শূন্য যাচাই করে, আর `smoke` এর শেষে চালান। একটা bug ইচ্ছা করে ঢোকান (refund এ fee এর অংশ ভুল চিহ্নে) আর দেখান check টা কী বলে।

5. **Design অংশ:** এই payment system এর "এক পাতার design doc", Lesson 1.2 এর পাঁচ ধাপে: (ক) requirement, PCI এর সিদ্ধান্ত সহ; (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত; (গ) state machine এর ছবি, প্রতিটা অবস্থা থেকে বেরোনোর পথ সহ; (ঘ) ledger এর account আর একটা payment, একটা refund আর একটা payout এর entry; (ঙ) reconciliation এর নকশা: কোন report, কোন key, কোন জানালা, অমিলের ধরন আর প্রতিটার মালিক।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ), 11.1 – 11.6
Current: 11.7 — Case Study: Design a Payment System
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ — URL shortener; ২ — rate limiter
service; ৩ — chat; ৪ — news feed; ৫ — notification; ৬ — video streaming। Case study ৭ — payment: দিনে ১ কোটি payment
($৩০ কোটি), sale এ সেকেন্ডে ~১,২০০ (চাপ ছোট), ০.০১% ভুল = বছরে $১.১ কোটি (ভুল বড়)। Card এর data PSP এর tokenization এ।
Payment intent আগে (id = PSP এর reference + idempotency key), state machine এ `unknown`; timeout = ব্যর্থ ধরলে ১০ লাখে
৪,০৬০ দুবার কাটা + ১,৮১৯ হারানো; key এ retry + HMAC webhook (কাঁচা body) + recovery job এ শূন্য; PSP আগে লিখলে ০.১% crash
এ ৯৭০টা চিহ্নহীন। Double-entry ledger (append-only, Σ = 0): balance column এ race এ ৫১ লাখ পয়সা আর crash এ ৩৬,০০০ উধাও;
গরম merchant এ শুধু debit এর lock (৩৭ s → ৭ ms)। Integer minor unit + rounding এর লেখা নিয়ম (১ কোটি তে ৬,০৭৫ পয়সা
পার্থক্য)। Reconciliation: payment id + ±১ দিন (amount এ ১০০% লুকায়; UTC+6 এ একই তারিখে দিনে ৫ লাখ মিথ্যা alert)।
Postgres primary + synchronous replica।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (বনাম Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation, Priority Tier,
Provider Throughput Limit, Pacing, Provider Failover, Aggregation Window (Collapse Key), Quiet Hours,
Device Token Lifecycle, Egress, Bitrate Ladder, Manifest (HLS / DASH), Segment-Parallel Transcoding,
Adaptive Bitrate (ABR), Rebuffer Ratio, Popularity-Tiered Encoding, Payment Service Provider (PSP),
Payment Intent, Unknown State, Double-Entry Ledger, Minor Units, Reconciliation, Settlement
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: Module 11 Exit Challenge
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **যেখানে প্রতিটা ভুল টাকা, সেখানে নকশার কাজ throughput না, প্রতিটা কিনারায় নিশ্চয়তা।** Timeout কে ব্যর্থ ধরবেন না, তার নাম দিন (`unknown`) আর শেষ করার তিনটা পথ রাখুন। বাইরের কাজের আগে নিজের রেকর্ড লিখুন। টাকাকে সংখ্যা হিসেবে না, নড়াচড়ার ইতিহাস হিসেবে রাখুন, যাতে Σ = 0 প্রতিটা ভুল ধরে। আর সব কিছুর পরেও দিনশেষে বাইরের হিসাবের সাথে মেলান, কারণ কিছু না কিছু সবসময় ফসকায়।

Module 11 এখানে শেষ। সাতটা system, প্রতিটা শূন্য থেকে, Lesson 1.2 এর পাঁচ ধাপে। আর প্রতিটায় একটা অভ্যাস ফিরে এসেছে: আগে সংখ্যা, তারপর যন্ত্র; আর সংখ্যা প্রায়ই বলে কোন যন্ত্র **লাগে না** (11.1 এর sharding আর Bloom filter, 11.4 এর গড়, 11.6 এর transcoding এর খরচ, আজকের throughput)। রেডি হলে `next` লিখুন — **Module 11 Exit Challenge** এ যাব। সেখানে একটা নতুন system দেব যা এই module এর কয়েকটা case study এর টুকরো একসাথে চায়, আর এবার কোনো script বা সংখ্যা আগে থেকে দেওয়া থাকবে না: requirement থেকে estimation, নকশা, আর trade-off, সব আপনার, ঠিক interview এর মতো।
