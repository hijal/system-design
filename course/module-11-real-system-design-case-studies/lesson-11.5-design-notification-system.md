# Lesson 11.5 - Case Study: Design a Notification System

**Module 11 - Real System Design Case Studies**

> **Spaced Repetition (Lesson 2.5):** একটা client payment এর request পাঠাল, timeout পেল, আবার পাঠাল। Server কীভাবে নিশ্চিত করে যে টাকা দুবার কাটা হয়নি? আর timeout পাওয়া client কি জানে প্রথম request টা কাজ করেছিল কিনা? আজ ভূমিকা উল্টো: **আমরা** client, আর email বা SMS এর provider হলো server। Timeout এর পরে আবার পাঠালে কত email দুবার যায়, সেটা মাপব।

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 7.2 (Queue), Lesson 7.4 (Retry, backoff, DLQ), Lesson 9.4 (Circuit breaker, bulkhead), Lesson 9.5 (Rate limiting), Lesson 10.7 (Cost), Lesson 11.2 (Limiter), Lesson 11.3 (Push, offline), Lesson 11.4 (Fan-out, queue isolation)

**আপনি এই lesson শেষে পারবেন:**

1. একটা notification system এর আসল সীমাগুলো চিনতে পারবেন: খরচ আসে channel থেকে (SMS), গতির সীমা আসে বাইরের provider থেকে, আর সবচেয়ে দুর্লভ সম্পদ user এর মনোযোগ। আর এগুলো থেকে নকশা দাঁড় করাতে পারবেন: অগ্রাধিকারের স্তর, channel এর পরিকল্পনা, পছন্দ আর নীরবতা
2. বাইরের provider এর সাথে নির্ভরযোগ্য ভাবে কথা বলতে পারবেন: timeout মানে ব্যর্থতা না, retry আর idempotency key, failover এ কেন key হারায়, outage এ backoff বনাম breaker, আর provider এর সীমার নিচে একটা campaign কে pacing
3. User কে না জ্বালিয়ে notification পাঠাতে পারবেন: aggregation আর collapse key, cap এর দাম, quiet hours আর তার সকালের ঢেউ, আর মরা device token পরিষ্কার রাখা

**Tier:** 1 - Runnable Code (চারটা deterministic model আর একটা আসল Express + Zod notification service, fake provider সহ; Docker লাগে না)

---

## ০. আজকের System

আগের চারটা case study তে বারবার একটা বাক্স পাশে রেখেছিলাম: "notification (11.5)"। 11.3 এ offline user কে জাগানো, 11.4 এ নতুন post এর খবর, 10.5 এ password reset এর email। আজ সেই বাক্স খুলব। Interviewer:

> "আমাদের company র সব notification এর জন্য একটা কেন্দ্রীয় system design করুন। কয়েকশো service এটা ডাকবে: login এর OTP, অর্ডারের খবর, social এর like আর comment, আর marketing team এর campaign। Push, email, SMS।"

প্রথম ছবি প্রায় সবসময় একটা queue আর একটা worker: "service গুলো queue তে message দেয়, worker পাঠায়।" এটা ঠিক, আর এখানেই প্রশ্নগুলো শুরু:

- "Marketing team ১০ কোটি জনকে একটা campaign পাঠাল। সেই এক ঘণ্টায় কেউ login করলে তার OTP কখন আসবে?"
- "SMS provider সেকেন্ডে ১০০টার বেশি নেয় না। এটা কার সমস্যা?"
- "Email provider timeout দিল। আবার পাঠাবেন? যদি প্রথমটা আসলে চলে গিয়ে থাকে?"
- "একজনের post viral, ১০ মিনিটে ৫০০ like। তার ফোন ৫০০ বার বাজবে?"
- "মাসের বিল এলো। এত টাকা কোথায় গেল?"

এই system এর আসল চরিত্র: এটা নিজে প্রায় কিছুই করে না, বাইরের কয়েকটা provider (APNs, FCM, email আর SMS এর service) কে দিয়ে করায়। তাদের গতি, দাম আর ব্যর্থতা আমাদের হাতে না। নকশাটা তাই মূলত **অন্যের সীমার চারপাশে নিজের নিয়ম**।

---

## ১. Theory

### ১.১ Step 1 - Requirement

```
প্রশ্ন                                     ধরে নিলাম
কারা পাঠায়?                                কয়েকশো ভেতরের service, একটা API দিয়ে: { userId, type, data, idempotencyKey }
কী ধরনের?                                   OTP আর নিরাপত্তা (জরুরি), অর্ডার আর social (স্বাভাবিক), marketing (bulk)
কোন channel?                               push (iOS/Android), email, SMS, in-app
User এর নিয়ন্ত্রণ?                           ধরন অনুযায়ী বন্ধ করা (marketing না), রাতের নীরবতা, unsubscribe
কত দ্রুত?                                   OTP সেকেন্ডে (মেয়াদ ৫ মিনিট), social এ কয়েক সেকেন্ড-মিনিট চলে, marketing ঘণ্টায়
নিশ্চয়তা?                                   হারানো চলবে না (OTP, অর্ডার), দুবার যাওয়া যত কম সম্ভব
বাদ দিলাম                                  template এর editor, A/B test, campaign এর UI
```

**Non-functional** এ দুটো জিনিস যা অন্য system এ কম দেখা যায়: **user এর মনোযোগ একটা সম্পদ** (বেশি notification মানে user notification বন্ধ করে, আর তখন জরুরিটাও পৌঁছায় না), আর **আইনি বাধ্যবাধকতা** (marketing এ unsubscribe এর লিংক আর তা মানা, কিছু দেশে SMS এর সময়ের সীমা; কোনটা কোথায় প্রযোজ্য সেটা আইনজীবীর প্রশ্ন, এখানে যাচাই করা না)।

### ১.২ Step 2 - Estimation: খরচ কোথায়

`npm run estimate`:

```
── Part A - load: 300 million DAU, 10 notifications a day per user ──
all notifications                                     34,722         104,167
one campaign: 100 million people, in 1 h              27,778    0.8× the average

── Part B - channels and monthly cost (approximate prices) ──
channel              share         per day        each       monthly  share of cost
push (APNs/FCM)        80%     2.4 billion          $0            $0           0.0%
email                  17%     510 million     $0.0001    $1,530,000          17.5%
SMS                     1%      30 million      $0.008    $7,200,000          82.5%
in-app                  2%      60 million          $0            $0           0.0%

── Part C - device tokens: 900 million tokens, 30% dead ──
sending to every token of every user is 7.2 billion pushes a day, 2.16 billion of them to dead tokens

── Part D - the history of every notification (500 B, 90 days) ──
1.5 TB a day, 135 TB over 90 days
```

1. **চাপ মাঝারি, কিন্তু ঢেউ বড়।** গড়ে সেকেন্ডে ৩৫,০০০, peak এ ১ লাখ। একটা campaign এক ঘণ্টায় আরও প্রায় ২৮,০০০/s যোগ করে, হঠাৎ। 11.4 এর celebrity এর মতো, কিন্তু এবার আমরা নিজেরাই বানাই।
2. **খরচ পরিমাণে না, channel এ।** SMS মাত্র ১% notification, কিন্তু মাসের বিলের **৮২%**। Push এর নিজের কোনো দাম নেই (APNs আর FCM এ পাঠানো বিনা মূল্যে), email প্রায় বিনা মূল্যে। 10.7 এর unit economics এর ভাষায়: সবচেয়ে বড় সাশ্রয় একটা নিয়মে, "SMS শুধু fallback": OTP প্রথমে push এ (app এর ভেতরে), push না গেলে তবেই SMS। SMS এর দাম দেশভেদে অনেক বদলায়, তাই কোন দেশের user কে SMS এ পাঠানো হচ্ছে সেটাও একটা cost এর metric।
3. **মরা token একটা লুকানো অপচয়।** একজন user এর গড়ে তিনটা token (পুরনো ফোন, ট্যাবলেট, app আবার install), যার ৩০% মরা (app মুছে ফেলা, ফোন বদলানো)। দিনে ২১৬ কোটি push কোথাও যায় না। দাম টাকায় না (push বিনা মূল্যে), কিন্তু worker এর সময়, provider এর throughput এর সীমা, আর "delivered" এর মিথ্যা হিসাবে।
4. **ইতিহাস রাখতেই হয়।** "আমি OTP পাইনি" এর ticket এর উত্তর ("১২:০৩:০৫ এ SMS provider কে দেওয়া হয়েছিল, provider বলেছে পৌঁছেছে") আর dedupe এর জন্য। ৯০ দিনে ১৩৫ TB, তাই সাম্প্রতিকটা দ্রুত store এ, পুরনোটা সস্তা storage এ (10.7 এর tiering)।

### ১.৩ Step 3 - High-level design

```
 service গুলো ──► POST /notify { userId, type, data, idempotencyKey }
                       │
                 [notification API] ── dedupe (userId + key) ──► 202
                       │
                 [preference + নিয়ম] ── opt-out? quiet hours? দৈনিক সীমা? aggregation এর জানালা?
                       │
         ┌─────────────┼───────────────┐
   [critical queue] [normal queue] [bulk queue]          ← অগ্রাধিকারের স্তর
         │             │               │
   [channel worker: push]  [email]  [SMS]                ← channel ধরে, provider এর সীমা মেনে
         │             │               │
   APNs / FCM     email provider ×2   SMS provider ×2     ← প্রধান + বিকল্প
         │
   ফলাফল (sent / unregistered / failed) ──► ইতিহাস, token মোছা, metric
```

তিনটা মূল ধারণা, আর প্রতিটার একটা নতুন term:

**Priority Tier (Transactional বনাম Bulk)** - Notification কে জরুরিতা ধরে আলাদা স্তরে ভাগ করা (OTP আর নিরাপত্তা; অর্ডার আর social; marketing), প্রতিটার নিজের queue, worker আর provider এর ভাগ, যাতে একটা স্তরের ঢেউ অন্যটাকে আটকায় না। Type থেকে স্তর ঠিক হয় system এ, ডাকা service এর হাতে না (নইলে সবাই নিজেকে "জরুরি" বলে)।

**Channel Plan:** প্রতিটা type এর জন্য channel এর একটা ক্রম। OTP: push, না হলে SMS। Social: শুধু push (আর in-app)। অর্ডার: email (একটা রসিদ, পরে খুঁজে পাওয়া যায়)। Marketing: email। এটা config, code না।

**Preference আর নিয়ম পাঠানোর ঠিক আগে দেখা হয়,** গ্রহণের সময় না। কারণ: notification queue তে থাকতে থাকতে user marketing বন্ধ করতে পারে, বা quiet hours শুরু হতে পারে।

### ১.৪ Deep dive ১ - Provider এর সীমা: campaign বনাম OTP

**Provider Throughput Limit** - বাইরের provider একটা account থেকে সেকেন্ডে কতগুলো নেবে তার সীমা (SMS এ প্রায়ই সেকেন্ডে কয়েকশো, sender এর ধরন আর দেশ ভেদে), যার বেশি পাঠালে সে প্রত্যাখ্যান (429) করে বা নিঃশব্দে দেরি করে। এটা আমাদের সিদ্ধান্ত না, কিন্তু আমাদের নকশা এর চারপাশে।

`npm run queue`: SMS provider এর সীমা ১০০/s, OTP আসে ২০/s, আর এক মিনিটে ৩ লাখ marketing SMS এর একটা campaign queue তে ঢোকে। OTP এর মেয়াদ ৫ মিনিট:

```
policy                                                       OTP p50   OTP p99        worst    expired  campaign done
one FIFO queue, one provider account                        120.00 s  2942.40 s    3000.00 s     67,500        50 min
FIFO, but the campaign enters slowly (50% of the limit)       100 ms    100 ms       100 ms          0       100 min
priority: OTP first, the campaign gets the rest               100 ms    100 ms       100 ms          0        63 min
separate accounts: separate limits for OTP and campaign       100 ms    100 ms       100 ms          0        50 min
```

- **এক FIFO:** ৩ লাখ SMS ১০০/s এ ৫০ মিনিট। তার পেছনে প্রতিটা OTP। p50 দুই মিনিট, p99 ৪৯ মিনিট, আর **৬৭,৫০০টা OTP মেয়াদ পার হয়ে পৌঁছায়।** প্রতিটা একজন মানুষ যে login করতে পারল না, আর সম্ভবত আবার "কোড পাঠান" চাপল, queue তে আরেকটা যোগ করে। 11.4 এর fan-out queue এর শিক্ষা, এবার সীমাটা আরও কঠিন, কারণ সেটা আমাদের না: বেশি worker দিয়ে provider এর সীমা বাড়ে না।
- **Pacing** - একটা বড় কাজ queue তে একবারে না ঢেলে একটা নির্দিষ্ট হারে (11.2 এর token bucket দিয়ে) ছাড়া, যাতে provider এর ক্ষমতার একটা অংশ সবসময় বাকিদের জন্য খালি থাকে। সীমার ৫০% এ ছাড়লে OTP আর আটকায় না, কিন্তু campaign দ্বিগুণ সময় নেয় (১০০ মিনিট)। আর headroom এর হিসাব জরুরি: experiment ১ এ ৯০% এ ছাড়লে ৯০ + OTP এর ২০ = ১১০%, queue আবার জমে, **৭,৫০৩টা OTP মেয়াদ পার।** Pacing এর হার = সীমা − জরুরি চাপের peak − নিরাপত্তার ফাঁক।
- **অগ্রাধিকারের queue:** OTP সবসময় আগে, campaign বাকি জায়গা। OTP এ শূন্য সমস্যা, campaign ৬৩ মিনিট। দাম campaign দেয়, আর experiment ২ এ OTP ৯০/s হলে campaign দুই ঘণ্টায়ও শেষ হয় না (starvation)। কিন্তু এখানে সেটাই ঠিক দাম।
- **আলাদা provider account** (বা আলাদা sender, transactional আর marketing এর জন্য): দুটোর নিজের সীমা। সবচেয়ে পরিষ্কার, campaign ও পুরো গতিতে। দাম: দ্বিতীয় account এর খরচ আর ব্যবস্থাপনা। আর আরেকটা লাভ: marketing এর জন্য spam এর অভিযোগ এলে provider বা email এর receiver সেই sender এর সুনাম কমায়; transactional এর sender আলাদা থাকলে OTP সেই শাস্তি পায় না। Email এ এটা প্রায় বাধ্যতামূলক অভ্যাস।

নকশায়: অগ্রাধিকারের তিনটা queue, transactional আর marketing এর আলাদা provider account (বা sender), আর campaign সবসময় paced।

### ১.৫ Deep dive ২ - Provider এর ব্যর্থতা: timeout, duplicate, failover

**Spaced repetition এর উত্তর:** server এ idempotency key: client প্রতিটা আলাদা কাজের জন্য একটা key পাঠায়, retry তে একই key; server key দেখে আগের ফল ফেরত দেয়, কাজ আবার করে না। আর timeout পাওয়া client **জানে না** প্রথমটা হয়েছিল কিনা; সেজন্যই key।

আজ আমরা client। `npm run retry` অংশ ক: ১০ লাখ email, ১% স্পষ্ট ব্যর্থ (provider বলল পাঠায়নি), ২% timeout, আর timeout এর অর্ধেক আসলে পাঠানো হয়েছিল:

```
policy                                                      not delivered  delivered twice  provider call
once, no retry                                                      2.03%            0.00%          1.000
again on failure or timeout                                         0.00%            1.01%          1.031
again, with an idempotency key at the provider                      0.00%            0.00%          1.031
on timeout to a second provider (the key is not shared)             0.00%            0.99%          1.031
```

- **Retry না করলে ২% হারায়,** যার মধ্যে অর্ধেক আসলে timeout (আমরা ভেবেছি গেছে কিনা জানি না)।
- **Retry করলে কিছু হারায় না, কিন্তু ১% দুবার যায়:** timeout হওয়া কিন্তু আসলে পাঠানো গুলো। ১০ লাখে ১০,০০০ মানুষ দুটো "আপনার অর্ডার পাঠানো হয়েছে" পায়। একটা OTP দুবার এলে সমস্যা কম; একটা "৫,০০০ টাকা কাটা হয়েছে" দুবার এলে সমস্যা বড়।
- **Provider idempotency key মানলে শূন্য আর শূন্য।** একই key এর দ্বিতীয় অনুরোধে provider নতুন করে পাঠায় না। কিন্তু সব provider এটা দেয় না। না দিলে উপায়: নিজের দিকে "পাঠানো হয়েছে" এর একটা টেকসই রেকর্ড, আর timeout এর পরে provider এর status API দিয়ে জিজ্ঞেস করা (যদি থাকে), বা ঝুঁকিটা type অনুযায়ী মেনে নেওয়া (OTP: আবার পাঠান; টাকার খবর: জিজ্ঞেস না করে না)।
- **Provider Failover** - প্রধান provider ব্যর্থ বা বন্ধ হলে একই notification বিকল্প provider দিয়ে পাঠানো। কিন্তু টেবিলের শেষ সারি দেখুন: timeout এর পরে দ্বিতীয় provider এ পাঠালে আবার **১% দুবার**, কারণ দ্বিতীয় provider প্রথমটার key জানে না। Failover আর idempotency একসাথে কঠিন। তাই failover এর শর্ত হওয়া উচিত "প্রধান **নিশ্চিত** ব্যর্থ" (স্পষ্ট error, বা breaker খোলা), "একটা timeout" না।

অংশ খ, প্রধান email provider দশ মিনিট বন্ধ, সেকেন্ডে ১,০০০ email:

```
policy                                                      delay p50  delay p99  attempts on primary
exponential backoff on the same provider (max 5 minutes)     402.63 s   786.52 s            5,860,100
breaker: second provider after 30 s of failures                500 ms    39.98 s              167,550
```

Backoff (7.4) মরা provider কে চাপ থেকে বাঁচায়, কিন্তু email গুলো বাঁচায় না: p50 **৬.৭ মিনিট**, p99 ১৩ মিনিট। আর একটা সূক্ষ্ম জিনিস: provider দশ মিনিটে ফিরে এলেও অনেক email তখন ৪-৫ মিনিটের backoff এর মাঝখানে, তাই তারা ফেরার পরেও মিনিট খানেক অপেক্ষা করে। Breaker (9.4) ৩০ সেকেন্ড ব্যর্থতা দেখে সব traffic দ্বিতীয় provider এ সরায়: p99 ৪০ s, আর প্রধানের উপর চাপ ৩৫ গুণ কম। Experiment ৪: breaker ১২০ s এ খুললে p99 ২০৪ s। Breaker এর সময় একটা trade-off: ছোট হলে একটা সাময়িক ঝাঁকুনিতেই failover (আর তার duplicate), বড় হলে outage এ দেরি।

আর যেগুলো সব চেষ্টার পরেও যায় না, সেগুলো DLQ তে (7.4), একটা alert সহ, কারণ "অর্ডারের email যায়নি" কারো জানা দরকার।

### ১.৬ Deep dive ৩ - User এর মনোযোগ: aggregation, cap, quiet hours

একজনের post viral, দশ মিনিটে ৫০০ like। `npm run aggregate`:

```
policy                                                            push  first one at          last like reported
one push per like                                                  500       115 ms                 immediately
at most one per 5 minutes, drop the rest                             4       115 ms  no (last 112.64 s dropped)
batch in a 30 s window, "X and N others" (collapse key)             26      30.12 s               30.00 s later
first one at once, then the window doubles (30 s, 1, 2… min)         6       115 ms              847.36 s later
```

- **প্রতিটায় একটা:** ৫০০ বার ফোন বাজে। User এর প্রতিক্রিয়া প্রায় নিশ্চিত: notification বন্ধ, আর তখন পরের OTP ও push এ আসে না।
- **Cap (সর্বোচ্চ একটা প্রতি ৫ মিনিটে, বাকি ফেলে দিন):** ৪টা push, কিন্তু তথ্য হারায়: শেষ দুই মিনিটের like কখনো জানানো হয় না, আর প্রতিটা push শুধু "X like করেছে" বলে, বাকি ১২৪ জনের কথা না। Cap একটা নিরাপত্তার জাল, নকশা না।
- **Aggregation Window (Collapse Key)** - একই user, একই ধরন, একই বিষয়ের notification একটা জানালায় জমিয়ে একটায় মেশানো ("X আর আরও ৪৯ জন like করেছে"), আর device কে একটা **collapse key** দিয়ে পাঠানো, যাতে নতুনটা পুরনোটাকে বদলে দেয়, স্তূপ না হয় (APNs আর FCM দুটোই এই ধারণা দেয়, ভিন্ন নামে)। ৩০ s এর জানালায় ২৬টা push, কিছুই হারায় না, কিন্তু প্রথমটাও ৩০ s দেরিতে।
- **জানালা যা বাড়ে:** প্রথমটা সাথে সাথে (user জানল "আপনার post এ সাড়া আসছে"), তারপর জানালা ৩০ s, ১ মিনিট, ২ মিনিট… দ্বিগুণ হয়। মাত্র ৬টা push, প্রথমটা সাথে সাথে, কিছু হারায় না। দাম: শেষ like টা ১৪ মিনিট পরে জানানো, যা একটা like এর জন্য কেউ টের পায় না। Exponential backoff এর ধারণা, এবার user এর মনোযোগের জন্য।

Smoke এর ধাপ ৩-৪ এটা চালায়: bob এর ৫০টা like, জানালা বন্ধের আগে ০টা push, তারপর একটা: "fan0 আর আরও 49 জন like করেছে"।

**Quiet Hours** - user এর নিজের সময়ের রাতে (ধরুন ১০টা থেকে ৭টা) জরুরি না এমন notification ধরে রাখা আর সকালে পাঠানো। অংশ খ: ১০ লাখ user এর দিনের notification এর প্রায় ৩৭% রাতে তৈরি, তার ৯৫% (জরুরি বাদে) সকাল পর্যন্ত অপেক্ষা করে। আর একটা ফাঁদ: সবাই ঠিক ৭:০০ এ ছাড়া পেলে প্রতিটা time zone এ সকাল ৭টায় এক ঢেউ, এখানে ৩৫ লাখ, যা নিজেই একটা অপরিকল্পিত campaign (আর ১.৪ এর OTP এর সমস্যা আবার)। উপায়: ৭:০০ থেকে ৭:৩০ এর মধ্যে এলোমেলো ছড়ানো (11.3 এর jitter), আর bulk queue তে। জরুরি (OTP, নিরাপত্তার সতর্কতা) কখনো ধরে রাখা হয় না।

**Device token এর জীবন:** push এর token একটা ফোনের একটা app install এর ঠিকানা। App মুছলে বা ফোন বদলালে সেটা মরে, আর APNs বা FCM পরের পাঠানোয় "unregistered" (বা অনুরূপ) বলে। নিয়ম: সেই উত্তর পেলেই token মুছে ফেলা। Smoke এর ধাপ ৭: erin এর দুটো token, একটা মরা; প্রথম OTP তে দুটো call আর মরাটা মুছে ফেলা, দ্বিতীয় OTP তে একটা call। এটা না করলে ১.২ এর ২১৬ কোটি অপচয় প্রতিদিন বাড়তেই থাকে।

### ১.৭ একটা আসল notification service

`npm run smoke` উপরের সব নিয়ম একটা Express service এ চালায়: অগ্রাধিকারের তিনটা queue, type থেকে channel এর পরিকল্পনা, idempotency, aggregation এর জানালা, opt-out, quiet hours, মরা token মোছা, আর একই key তে retry। Provider একটা fake, যা মরা token আর "timeout কিন্তু আসলে পাঠানো" নকল করে:

```
#   step                                                        result
1   1,000 marketing in the queue, then alice's OTP; 1 sent      push:a-phone ← code: 482913
2   OTP again with the same idempotency key                     id 1001 (earlier 1001), duplicate: true
3   50 likes on bob's post; before the window closes            0 pushes
4   window closes 30 s later                                    push:b-phone ← fan0 and 49 others liked this; merged 49
5   carol has turned marketing off                              suppressed
6   dave: marketing at 11 pm, quiet 22–7                        at night: deferred; at 7 am: sent
7   erin has two tokens, one dead; two OTPs                     provider calls: 2, then 1; tokens deleted 1
8   frank has no device, OTP                                    sms:phone:frank ← code: 999999
9   gina's order email: first call timed out (actually sent)    email: timeout → email: sent
10  in gina's inbox                                             1 email
```

- ধাপ ১: ১,০০০টা marketing আগে queue তে, কিন্তু প্রথম যেটা যায় সেটা OTP।
- ধাপ ২: ডাকা service timeout পেয়ে একই key তে আবার ডাকল; একই id, নতুন কিছু না। 2.5 এর key, এবার আমাদের API তে।
- ধাপ ৫-৬: পছন্দ পাঠানোর ঠিক আগে দেখা: carol এর marketing বাদ, dave এর marketing সকাল ৭টা পর্যন্ত।
- ধাপ ৮: frank এর push নেই, তাই OTP এর channel plan এর পরের ধাপ, SMS।
- ধাপ ৯-১০: provider প্রথম call এ timeout দিল কিন্তু email পাঠিয়েছিল; service একই key তে আবার পাঠাল, provider key চিনে নতুন করে পাঠাল না। gina একটাই email পেল।

### ১.৮ Step 5 - Trade-off আর wrap-up

**চূড়ান্ত নকশা:**

- **API:** `POST /notify` এ `userId + idempotencyKey` দিয়ে dedupe; type থেকে স্তর আর channel plan system ঠিক করে।
- **নিয়ম পাঠানোর ঠিক আগে:** opt-out, quiet hours (জরুরি বাদে, সকালে ছড়িয়ে), দৈনিক সীমা, aggregation এর জানালা (প্রথমটা সাথে সাথে, তারপর বাড়ে) আর collapse key।
- **Queue:** তিন স্তর; campaign সবসময় paced, headroom রেখে; transactional আর marketing এর আলাদা provider account/sender।
- **Provider:** idempotency key প্রতিটা call এ (`notification id`); timeout এ একই provider এ retry; breaker খুললে তবেই বিকল্প provider; সব চেষ্টার পরে DLQ আর alert।
- **Token:** "unregistered" এ সাথে সাথে মোছা; নিয়মিত পুরনো token এর পরিষ্কার।
- **খরচ:** SMS শুধু fallback; দেশ ধরে SMS এর খরচের metric।
- **ইতিহাস:** প্রতিটা notification এর timeline, ৯০ দিন, "কেন পেলাম না" এর উত্তরের জন্য।

> **Trade-off Table - notification এর বড় সিদ্ধান্ত**

| সিদ্ধান্ত    | বেছে নিলাম                        | বিকল্প                | কী দিলাম                                  | কী পেলাম                                                 |
| ------------ | --------------------------------- | --------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Queue        | তিন স্তর + আলাদা provider account | একটা FIFO             | বাড়তি account, campaign ধীর              | OTP কখনো আটকায় না (FIFO এ ৬৭,৫০০ মেয়াদ পার)            |
| Campaign     | Paced, headroom সহ                | একবারে ঢালা           | Campaign দ্বিগুণ সময়                     | Provider এর সীমা বাকিদের জন্য খালি                       |
| Timeout      | একই provider এ retry, key সহ      | Retry নেই / key ছাড়া | Provider এর key এর সমর্থন বা নিজের রেকর্ড | শূন্য হারানো, শূন্য দুবার (না হলে ২% হারায় বা ১% দুবার) |
| Failover     | Breaker খুললে তবেই                | প্রতিটা timeout এ     | Outage এর প্রথম ৩০ s দেরি                 | Duplicate কম; outage এ p99 ১৩ মিনিট থেকে ৪০ s            |
| Social burst | জানালা যা বাড়ে + collapse key    | প্রতিটায় একটা / cap  | শেষ খবর কয়েক মিনিট দেরিতে                | ৫০০ থেকে ৬, কিছু না হারিয়ে                              |
| SMS          | শুধু fallback                     | OTP সরাসরি SMS এ      | Push না থাকলে কয়েক সেকেন্ড দেরি          | বিলের সবচেয়ে বড় লাইন কমে                               |

**কী আগে ভাঙবে:** একটা নতুন service যে নিজের type "জরুরি" হিসেবে register করে সব কিছু পাঠায় (স্তর এর অপব্যবহার, তাই type এর মালিকানা আর সীমা); একটা provider এর নিঃশব্দ ব্যর্থতা (সে "sent" বলে কিন্তু পৌঁছায় না; এর জন্য delivery এর receipt আর নিজের পরীক্ষার account এ নিয়মিত পাঠিয়ে দেখা, 10.4 এর synthetic probe); আর marketing এর spam এর অভিযোগে email এর domain এর সুনাম নষ্ট হওয়া, যা ঠিক করতে সপ্তাহ লাগে।

---

## ২. Interview Angle

"Design a notification system" প্রায়ই আসে, আর এর মজা হলো এটা একটা "pipeline" প্রশ্ন যেখানে সবচেয়ে কঠিন অংশ আমাদের নিয়ন্ত্রণের বাইরে। ভালো উত্তরের আকৃতি:

1. **ধরন আর জরুরিতা আগে।** OTP, transactional, social, marketing - আলাদা SLO, আলাদা স্তর। "সব একই queue তে" বললেই interviewer campaign এর প্রশ্ন করবে।
2. **সংখ্যা আর খরচ।** চাপ, campaign এর ঢেউ, আর channel ধরে খরচ (SMS)।
3. **Provider এর সাথে সম্পর্ক।** সীমা (pacing, আলাদা account), timeout (retry + idempotency key), outage (breaker + failover, আর তার duplicate এর দাম)।
4. **User এর অভিজ্ঞতা।** Preference, quiet hours, aggregation, collapse key, unsubscribe।
5. **পর্যবেক্ষণ।** প্রতিটা notification এর ইতিহাস, channel ধরে delivery এর হার, মরা token।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Campaign চলার সময় OTP?"_ - আলাদা স্তর, আর সীমাটা provider এর, তাই worker বাড়িয়ে লাভ নেই। Pacing (headroom সহ), অগ্রাধিকার, আলাদা account। সংখ্যা: এক FIFO তে ৬৭,৫০০ OTP মেয়াদ পার।
- _"Exactly once?"_ - সম্ভব না; timeout এ জানি না। At-least-once + key, provider মানলে; না মানলে type অনুযায়ী ঝুঁকি।
- _"Provider বন্ধ হলে?"_ - Breaker, বিকল্প provider; আর failover এ key হারায় বলে duplicate এর হিসাব।
- _"User কে spam না করে?"_ - Aggregation (জানালা যা বাড়ে), collapse key, দৈনিক সীমা, quiet hours (সকালের ঢেউ ছড়িয়ে)।
- _"Notification পৌঁছাল কিনা কীভাবে জানেন?"_ - Provider এর "accepted" মানে পৌঁছানো না। Push এ delivery এর receipt সীমিত; email এ bounce আর complaint এর webhook; SMS এ delivery receipt (DLR)। আর app এর ভেতরে "খোলা হয়েছে" এর event।
- _"Template আর ভাষা?"_ - Template এর version, user এর ভাষা, আর template তৈরি পাঠানোর সময়, যাতে নাম বদলালে পুরনো queue এর notification ও ঠিক নাম দেখায়।

**Production এ বাস্তবে:** সবচেয়ে প্রচলিত ঘটনা: একটা বড় campaign এর সময় OTP আর password reset আটকে যাওয়া, আর "login করতে পারছি না" এর ঢেউ; একটা bug এ একই notification হাজার বার (একটা retry loop key ছাড়া), যা user রা screenshot করে social media তে দেয়; SMS এর বিল এক মাসে দশ গুণ (SMS pumping এর আক্রমণ: কেউ নকল নম্বরে OTP চেয়ে চেয়ে দামি দেশের SMS পাঠায়, 11.2 এর মতো সীমা আর দেশ ধরে সতর্কতা লাগে); আর মরা token এর কারণে push এর delivery এর হার ধীরে ধীরে পড়ে যাওয়া, যা কেউ খেয়াল করে না।

---

## ৩. Key Takeaway

- **Notification system এর সীমা বাইরে:** provider এর গতির সীমা, তার দাম, তার ব্যর্থতা। নকশা মানে অন্যের সীমার চারপাশে নিজের নিয়ম
- **খরচ channel এ:** SMS ১% notification কিন্তু বিলের ৮২%। SMS শুধু fallback, আর দেশ ধরে খরচ দেখুন
- **জরুরি আর bulk এক queue তে মরে:** campaign এর পেছনে ৬৭,৫০০ OTP মেয়াদ পার। অগ্রাধিকারের স্তর, আলাদা provider account, আর campaign paced - headroom সহ (৯০% এ ছাড়লে আবার ৭,৫০৩ মেয়াদ পার)
- **Timeout মানে "জানি না":** retry না করলে ২% হারায়, key ছাড়া retry তে ১% দুবার, provider এ key সহ শূন্য। Failover এ key হারায়, তাই failover শুধু নিশ্চিত ব্যর্থতায় (breaker)
- **Outage এ backoff একা বাঁচায় না** (p99 ১৩ মিনিট); breaker + বিকল্প provider (p99 ৪০ s)
- **User এর মনোযোগ একটা সীমিত সম্পদ:** ৫০০ like থেকে ৬টা push, প্রথমটা সাথে সাথে আর কিছু না হারিয়ে (জানালা যা বাড়ে + collapse key)। Cap তথ্য হারায়; quiet hours সকালের ঢেউ বানায়, তাই ছড়ান
- **মরা token সাথে সাথে মুছুন,** নইলে push এর এক-তৃতীয়াংশ অপচয়, আর delivery এর হিসাব মিথ্যা

---

## ৪. নতুন Term (Glossary)

| Term                                        | অর্থ                                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Priority Tier (Transactional বনাম Bulk)** | Notification কে জরুরিতা ধরে আলাদা স্তরে (OTP/নিরাপত্তা, transactional/social, marketing), প্রতিটার নিজের queue আর provider এর ভাগ; স্তর type থেকে system ঠিক করে, ডাকা service না   |
| **Provider Throughput Limit**               | বাইরের provider একটা account থেকে সেকেন্ডে কত নেবে তার সীমা - worker বাড়িয়ে বাড়ে না; তার চারপাশে pacing, অগ্রাধিকার আর আলাদা account                                             |
| **Pacing**                                  | বড় কাজ (campaign) একবারে না ঢেলে নির্দিষ্ট হারে ছাড়া (token bucket), যাতে সীমার একটা অংশ সবসময় জরুরির জন্য খালি - হার = সীমা − জরুরির peak − ফাঁক                                |
| **Provider Failover**                       | প্রধান provider ব্যর্থ হলে বিকল্প provider দিয়ে পাঠানো - outage এ দেরি কমায়, কিন্তু idempotency key এক provider থেকে আরেকটায় যায় না, তাই timeout এ failover মানে duplicate      |
| **Aggregation Window (Collapse Key)**       | একই user আর বিষয়ের notification একটা জানালায় মিশিয়ে একটা ("X আর আরও N জন"), আর device এ collapse key দিয়ে পুরনোটা বদলে দেওয়া; জানালা বাড়তে দিলে প্রথমটা সাথে সাথে আর মোট অল্প |
| **Quiet Hours**                             | User এর রাতে জরুরি না এমন notification ধরে রাখা আর সকালে পাঠানো - সকালে সবাই একসাথে ছাড়া পেলে একটা অপরিকল্পিত campaign, তাই ছড়িয়ে                                                |
| **Device Token Lifecycle**                  | Push এর token একটা app install এর ঠিকানা; app মুছলে বা ফোন বদলালে মরে, আর provider "unregistered" বলে - সেই উত্তরে সাথে সাথে মোছা, নইলে অপচয় আর মিথ্যা delivery এর হার             |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. এক মাসে SMS এর বিল $৭২ লাখ থেকে $৪ কোটি। Dashboard বলছে OTP এর সংখ্যা ছয় গুণ, আর বেশিরভাগ এমন দেশের নম্বরে যেখানে আপনার প্রায় কোনো user নেই, আর সেই OTP গুলোর প্রায় কোনোটাই ব্যবহার হয়নি। (ক) কী ঘটছে? (খ) আজই কী করবেন, আর কী করবেন না? (গ) এই lesson আর 11.2 এর কোন যন্ত্র দিয়ে এটা স্থায়ী ভাবে আটকাবেন, আর তাদের false positive এর দাম কী?

2. একটা bank এর app: "আপনার account থেকে ৫০,০০০ টাকা তোলা হয়েছে" এর notification। (ক) এর জন্য কোন channel plan, কোন স্তর, আর quiet hours এর নিয়ম? (খ) এখানে "দুবার পাঠানো" আর "না পাঠানো" এর মধ্যে কোনটা খারাপ, আর সেটা retry আর failover এর নীতি কীভাবে বদলায়? (গ) Provider "sent" বলল, কিন্তু user বলছে পায়নি। কীভাবে জানবেন কে ঠিক?

3. Marketing team চায় "সবাইকে, একসাথে, ঠিক রাত ৮টায়" একটা flash sale এর push, ১০ কোটি জনকে। (ক) এই lesson এর সংখ্যা দিয়ে, এর কোন অংশগুলো সমস্যা: push এর provider, আপনার নিজের worker, আর notification খুলে app এ আসা মানুষের ঢেউ (11.3 এর reconnect storm এর মতো)? (খ) একটা নকশা দিন যা marketing এর লক্ষ্য (বেশিরভাগ মানুষ ৮টার কাছাকাছি জানবে) আর system এর সীমা দুটোই মানে।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) **SMS pumping (বা "toll fraud"):** কেউ আপনার OTP এর endpoint কে দিয়ে দামি দেশের নম্বরে SMS পাঠাচ্ছে, যেখানে সে নিজে বা তার সহযোগী carrier প্রতি SMS এ টাকার ভাগ পায়। OTP গুলো কেউ ব্যবহার করে না কারণ উদ্দেশ্যটাই SMS পাঠানো, login না। আপনার OTP এর API একটা খোলা "আমার টাকায় SMS পাঠান" এর বোতাম হয়ে গেছে।

(খ) **আজই:** যেসব দেশে আপনার আসল user প্রায় নেই, সেখানে SMS OTP বন্ধ (বা কঠিন করা: আগে captcha, তারপর SMS); OTP এর endpoint এ IP, device আর নম্বরের prefix ধরে কড়া সীমা; একটা provider এর মাসিক খরচের সীমা আর alert। **করবেন না:** সব SMS বন্ধ (আসল user login করতে পারবে না), বা শুধু IP ধরে আটকানো (আক্রমণকারী হাজার IP থেকে আসে, 10.5 এর credential stuffing এর মতো)।

(গ) স্থায়ী: (১) **দেশ আর prefix ধরে rate limit আর বাজেট** (11.2): প্রতিটা দেশের SMS এর একটা দৈনিক সীমা, তার স্বাভাবিক ব্যবহারের কয়েক গুণ; ছাড়ালে সেই দেশে fallback বন্ধ আর alert। False positive: সেই দেশে হঠাৎ বৈধ বৃদ্ধি (একটা marketing অভিযান) আটকায়, তাই সীমা বাড়ানোর একটা দ্রুত পথ। (২) **OTP এর conversion এর metric:** পাঠানো OTP এর কত % ব্যবহার হয়, দেশ ধরে; স্বাভাবিক ৬০-৮০%, আক্রমণে প্রায় শূন্য - এটাই সবচেয়ে ভালো সংকেত। (৩) **SMS শুধু fallback** (১.২): push বা app এর ভেতরের যাচাই আগে; SMS কেবল যার push নেই। (৪) নম্বর এর ধরন যাচাই (অনেক provider একটা lookup দেয়: নম্বরটা mobile কিনা, কোন carrier)। প্রতিটার দাম: আসল user এর জন্য একটা বাড়তি ধাপ।

**প্রশ্ন ২:**

(ক) **স্তর:** critical (নিরাপত্তা)। **Channel plan:** push আর SMS **দুটোই** (fallback না, একসাথে), কারণ ফোন চুরি বা app মোছা থাকলে push যায় না, আর এটাই সেই মুহূর্ত যখন জানানো সবচেয়ে জরুরি; সাথে app এর ভেতরে একটা স্থায়ী রেকর্ড আর email। **Quiet hours:** কখনো না - রাত ৩টায় টাকা তোলা হলে ঠিক তখনই জানা দরকার।

(খ) এখানে **না পাঠানো অনেক খারাপ** (জালিয়াতি ধরা পড়ে না), দুবার পাঠানো বিরক্তিকর আর বিভ্রান্তিকর ("দুবার তোলা হয়েছে?")। তাই: retry আক্রমণাত্মক, failover দ্রুত (breaker এর সময় ছোট), আর duplicate কমাতে text এ লেনদেনের নির্দিষ্ট id আর সময় ("লেনদেন #A93F, ১৪:০২"), যাতে দুটো একই খবর পেলে user বোঝে এটা একটাই ঘটনা। মানে duplicate এর ক্ষতি কমান, পাঠানোর নিশ্চয়তা বাড়ান।

(গ) "sent" মানে provider নিয়েছে, পৌঁছানো না। প্রমাণের সিঁড়ি: (১) আমাদের ইতিহাস: কখন, কোন provider, কোন উত্তর; (২) SMS এর delivery receipt (DLR) carrier থেকে, যদি provider দেয় - "delivered to handset" বনাম "accepted"; (৩) push এর জন্য app এর ভেতর থেকে "পেয়েছি" এর একটা ack (app খোলা থাকলে বা background এ পৌঁছালে, প্ল্যাটফর্মের সীমার মধ্যে); (৪) নিজের পরীক্ষার নম্বর আর device এ নিয়মিত synthetic notification (10.4), যাতে provider বা carrier এর নিঃশব্দ ব্যর্থতা আমরা user এর আগে জানি। শেষ পর্যন্ত carrier এর ভেতরে কী হয়েছে সেটা পুরো দেখা যায় না, আর সেটা সৎভাবে মেনে নিয়ে একাধিক channel এ পাঠানোই উত্তর।

**প্রশ্ন ৩:**

(ক) ১০ কোটি push "ঠিক ৮টায়":

- **Provider:** APNs/FCM অনেক বড় হার নেয়, কিন্তু অসীম না, আর হঠাৎ বিশাল ঢেউ এ throttling হতে পারে (সীমা প্রকাশিত না, provider এর নীতি)। এক মিনিটে পাঠাতে চাইলে সেকেন্ডে ১৬ লাখ+।
- **নিজের worker:** ১.২ এর peak (১ লাখ/s) এর ষোল গুণ। এক মিনিটে করতে গেলে বাকি সব notification (OTP সহ) আটকায়, ১.৪ এর সমস্যা।
- **ফেরার ঢেউ:** notification পেয়ে কয়েক শতাংশ মানুষ একসাথে app খোলে: ধরুন ৫% = ৫০ লাখ মানুষ এক-দুই মিনিটে। Login, feed, product এর page - এটা 11.3 এর reconnect storm, এবার পুরো backend এ। আর flash sale এর inventory এর database এ (11.7 এর আগাম ঝলক)।

(খ) নকশা: "৮টার কাছাকাছি" কে একটা জানালা বানান, যেমন ৭:৪৫ থেকে ৮:১৫, আর পাঠানো ছড়ান (pacing), headroom রেখে: সেকেন্ডে ~৫৫,০০০, bulk স্তরে। Push এর text এ "৮টা থেকে শুরু" (সময়টা লেখায়, পাঠানোর মুহূর্তে না), যাতে আগে পাওয়া মানুষও ৮টায় আসে বা ঘড়ি দেখে। ফেরার ঢেউ এর জন্য: sale এর page আগে থেকে cache আর CDN এ (4.5), app এর ভেতরে একটা অপেক্ষার ঘর (virtual queue) যা ঢোকার হার নিয়ন্ত্রণ করে, আর ৮টার আগে capacity বাড়ানো (10.7 এর autoscale, কিন্তু পূর্বপরিকল্পিত, কারণ autoscale এর দেরি এই ঢেউ ধরতে পারে না)। আর marketing এর সাথে একটা চুক্তি: এই মাপের campaign সবসময় এই ছকে, আর "সবাই একসাথে" এর অনুরোধের উত্তর সংখ্যা দিয়ে।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (চারটা deterministic model আর একটা আসল Express + Zod notification service, fake provider সহ; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.5-notification-system/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.5-notification-system) - `npm install`, তারপর `npm run estimate`, `npm run queue`, `npm run retry`, `npm run aggregate`, `npm run smoke`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` চাপ, campaign, channel ধরে খরচ, মরা token আর ইতিহাস হিসাব করে। `queue` provider এর সীমার নিচে campaign আর OTP কে চারটা নীতিতে চালায়। `retry` timeout আর ব্যর্থতায় retry, idempotency key আর failover, আর provider এর outage এ backoff বনাম breaker মাপে। `aggregate` viral like এর চারটা নীতি আর রাতের নীরবতা দেখায়। `smoke` একটা আসল notification service কে fake provider সহ ১০টা ধাপে চালায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, আপনার। **দাম আনুমানিক** (email $০.০০০১, SMS $০.০০৮; SMS এর দাম দেশভেদে অনেক বদলায়), push এ পাঠানোর নিজের দাম নেই বলে ধরা। Provider এর সীমা (১০০ SMS/s), ব্যর্থতা আর timeout এর হার, like এর সময় synthetic। কোন provider idempotency key মানে সেটা provider ভেদে আলাদা। APNs/FCM এর "unregistered" আর collapse key এর ধারণা তাদের documentation থেকে, নাম আর খুঁটিনাটি platform ভেদে আলাদা, এখানে যাচাই করা না। SMS pumping এর ঘটনা প্রকাশিত লেখা থেকে। আইনি বাধ্যবাধকতা (unsubscribe, SMS এর সময়) সাধারণ কথা, আইনি পরামর্শ না। `smoke` এর provider আর store in-memory, ঘড়ি নকল। **যা মাপা হয়নি:** আসল provider এর গতি আর আচরণ, delivery receipt, email এর deliverability, template।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `queue` চালানোর **আগে** লিখে ফেলুন: এক FIFO তে OTP এর p50 কত হবে, আর কতগুলো মেয়াদ পার? Campaign কত মিনিট? তারপর চালিয়ে মেলান।

2. **নিজের খরচ:** `SMS_SHARE=0.002 npm run estimate` (OTP push এ সরানোর পরে)। মাসে কত বাঁচল? তারপর `SMS_COST=0.05` (দামি দেশ) দিয়ে আগের অবস্থা। কোন metric আপনাকে এই পার্থক্য আগে দেখাত?

3. **Duplicate এর দাম:** `retry` এ `TIMEOUT=0.1` (একটা খারাপ দিন)। Key ছাড়া retry আর failover এ কত দুবার যায়? কোন type এর notification এ আপনি key ছাড়া retry মেনে নেবেন, কোনটায় না?

4. **Code বদলানো:** README এর experiment ৫ (দৈনিক marketing এর সীমা)। তারপর `src/notify.ts` এ quiet hours এর শেষে ছাড়া পাওয়া notification গুলো ৩০ মিনিটে ছড়ান (একটা এলোমেলো দেরি, seed সহ, যাতে smoke deterministic থাকে)।

5. **Design অংশ:** এই notification system এর "এক পাতার design doc", Lesson 1.2 এর পাঁচ ধাপে: (ক) type, স্তর আর channel plan এর একটা টেবিল; (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত (খরচ সহ); (গ) ছবি, preference আর নিয়ম কোথায় দেখা হয় সহ; (ঘ) provider এর সাথে চুক্তি: সীমা, pacing, retry, key, breaker, failover; (ঙ) একটা campaign এর runbook আর SMS এর খরচের alert।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ), 11.1 – 11.4
Current: 11.5 - Case Study: Design a Notification System
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ - URL shortener; ২ - rate limiter
service; ৩ - chat; ৪ - news feed। Case study ৫ - notification: ৩০ কোটি DAU, ৩৫,০০০/s গড় (peak ১ লাখ), campaign
এক ঘণ্টায় +২৮,০০০/s। খরচ: SMS ১% notification কিন্তু বিলের ৮২% → SMS শুধু fallback। তিন স্তর (critical/normal/bulk),
type থেকে স্তর আর channel plan; আলাদা provider account (transactional/marketing); campaign paced, headroom সহ (FIFO এ
৬৭,৫০০ OTP মেয়াদ পার; ৯০% pacing এ ৭,৫০৩)। Provider: একই provider এ retry + idempotency key (না হলে ২% হারায় বা ১%
দুবার); failover শুধু breaker খুললে (key হারায়); outage এ backoff p99 ১৩ মি বনাম breaker ৪০ s; DLQ। User: aggregation
জানালা যা বাড়ে + collapse key (৫০০ like → ৬ push), cap তথ্য হারায়, quiet hours সকালে ছড়িয়ে; মরা token সাথে সাথে
মোছা (৩০%)। ইতিহাস ৯০ দিন (১৩৫ TB)।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (বনাম Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation, Priority Tier,
Provider Throughput Limit, Pacing, Provider Failover, Aggregation Window (Collapse Key), Quiet Hours,
Device Token Lifecycle
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 11.6 - Case Study: Design a Video Streaming Platform
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **যে system এর আসল কাজ অন্যরা করে, তার নকশা মানে অন্যের সীমার চারপাশে নিজের নিয়ম।** Provider এর গতির সীমা worker বাড়িয়ে বাড়ে না, তাই জরুরি আর bulk আলাদা, আর বড় কাজ paced। Provider এর timeout মানে "জানি না", তাই retry একটা key সহ, আর failover শুধু নিশ্চিত ব্যর্থতায়। আর সবচেয়ে দুর্লভ সম্পদ user এর মনোযোগ: তাকে ৫০০ বার জ্বালালে সে সব বন্ধ করে দেয়, জরুরিটাও।

রেডি হলে `next` লিখুন - **Lesson 11.6: Design a Video Streaming Platform** এ যাব। এবার data এর আকার সব কিছু ঠিক করে: একটা ঘণ্টার video এর কয়েক GB, কয়েকটা resolution এ, আর লাখ মানুষ একসাথে দেখছে। 8.1 আর 8.2 এর object storage আর upload, 4.5 এর CDN, আর 10.7 এর data transfer এর খরচ এক জায়গায় আসবে। প্রশ্নগুলো: upload এর পরে video কে কীভাবে টুকরো আর ভিন্ন quality তে বানাব (transcoding এর pipeline), দর্শকের network খারাপ হলে quality কীভাবে নিজে নামে (adaptive bitrate), আর মাসের বিলের সবচেয়ে বড় লাইন কেন প্রায় সবসময় CDN এর egress।
