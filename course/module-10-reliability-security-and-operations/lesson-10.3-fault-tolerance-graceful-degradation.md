# Lesson 10.3 - Fault Tolerance, Graceful Degradation, Chaos Engineering

**Module 10 - Reliability, Security & Operations**

> **Spaced Repetition (Lesson 2.5):** একটা `POST` এর সাথে `Idempotency-Key` header পাঠানো হয় কেন - client কখন একই key দিয়ে request টা আবার পাঠায়, আর server সেটা চিনে কী করে? আজকের matrix এ একটা চিহ্ন দেখবেন, `✗!` - "লেখা হয়ে গেছে, কিন্তু user error দেখেছে"। সেই মুহূর্তে user ঠিক কী করে, আর 2.5 এর key না থাকলে তার ফল কী, সেটা মাথায় রেখে পড়ুন।

**Prerequisite:** Lesson 1.5 (Availability, error budget), Lesson 1.6 (SPOF), Lesson 4.4 (Fail-safe cache), Lesson 7.4 (Retry storm, load shedding), Lesson 7.5 (Outbox), Lesson 8.1 (Failure domain), Lesson 9.4 (Circuit breaker, bulkhead, fail fast), Lesson 10.2 (Fail open)

**আপনি এই lesson শেষে পারবেন:**

1. একটা system এর প্রতিটা user journey এর **hard আর soft dependency** আলাদা করতে পারবেন, তাদের গুণফল থেকে journey এর availability হিসাব করতে পারবেন - আর বলতে পারবেন কেন redundancy এর সূত্র (`1 − (1 − a)^k`) বাস্তবে প্রায়ই হাজার গুণ ভুল
2. Failure এর আগেই degraded অবস্থা নকশা করতে পারবেন - কোন অংশ বাদ যাবে, কোনটা পুরনো data দেখাবে, কোনটা পরে হবে, কোনটা স্পষ্টভাবে "এখন না" বলবে; চাপের সময় **brownout** দিয়ে core কাজ বাঁচাতে পারবেন; আর control plane মরলেও data plane কীভাবে **statically stable** থাকে সেটা নকশা করতে পারবেন
3. একটা chaos experiment পরিকল্পনা করতে পারবেন - steady state, hypothesis, **blast radius**, abort এর শর্ত - আর সংখ্যা দিয়ে বলতে পারবেন কেন ছোট blast radius এ একটা control group ছাড়া bug চোখেই পড়ে না

**Tier:** 1 - Runnable Code (পাঁচটা deterministic simulation - dependency matrix, redundancy, brownout, static stability, chaos experiment; Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

10.2 এর পরে share link এর সামনে Bloom filter, active user গোনা হয় HyperLogLog এ। Module 9 থেকে TaskFlow এর ভেতরে একটা ছোট জিনিস নিঃশব্দে বড় হয়েছে: **feature flag** (9.1)। একটা ছোট internal service, `flags`, একটা instance - প্রতিটা app instance তার কাছ থেকে flag এর মান নেয় ("নতুন activity panel কি এই workspace এ চালু?"), ৫ মিনিট cache করে। কেউ কখনো একে on-call এর তালিকায় রাখেনি। কেন রাখবে - এটা তো কোনো feature এর মূল কাজ করে না।

**শনিবার, রাত ২টা ১০।** `flags` এর disk ভরে গেল তার নিজের log এ। Service টা মরল।

- **২:১০ – ২:১৫:** কিছুই হলো না। সব instance এর কাছে ৫ মিনিটের cache।
- **২:১৫:** সব instance এর cache **একই মুহূর্তে** মেয়াদোত্তীর্ণ - কারণ সবাই একই ছন্দে (প্রতি ৩০ সেকেন্ডে) refresh করত, আর শেষ সফল refresh সবার একই সময়ে। এরপর যে request ই একটা flag পড়ে, সে exception ছোড়ে। Board খোলা, login, search, task তৈরি - **সব** 500। অস্ট্রেলিয়া আর জাপানের customer দের কাছে তখন সোমবার সকাল।
- **২:৩০:** On-call engineer এর প্রথম সন্দেহ app নিজেই। সে instance গুলো restart করল। নতুন instance boot এর সময় flag টানে - না পেয়ে crash। Kubernetes আবার চালায়, আবার crash। এখন app এর instance ও নেই।
- **২:৫৫:** কেউ `flags` এর কথা মনে করল। Disk পরিষ্কার, service চালু, ৩:০০ টায় সব ঠিক। মোট ৫০ মিনিট - একটা service এর জন্য যেটা "কোনো feature এর মূল কাজ করে না"।

**সোমবার, সকাল ৯টা।** একজন বড় customer (২,০০০ seat) সেদিন TaskFlow এ এলো, আর সাথে সোমবার সকালের standup এর ভিড়। Board খোলার traffic আড়াই গুণ। গত সপ্তাহে একটা নতুন panel ছাড়া হয়েছে - **"এরকম আরও board"** - যেটা প্রতিটা board খোলায় কয়েকটা দামি query চালায়। দুই মিনিটের মধ্যে প্রতিটা board request timeout। ৯:০৮ এ ভিড় কমে এলো - কিন্তু site ঠিক হলো না, কারণ queue তে জমে থাকা কাজ শেষ হচ্ছিল না। ৯:১৪ এ একজন engineer হাতে করে নতুন panel এর flag বন্ধ করল - আর তিন মিনিটে সব স্বাভাবিক। সঠিক পদক্ষেপটা ছিল, কিন্তু সেটা নিতে লাগল একজন মানুষ, চোদ্দ মিনিট, আর ভাগ্য।

Postmortem এ CTO তিনটা প্রশ্ন লিখলেন:

1. "TaskFlow কয়টা জিনিসের উপর নির্ভর করে - আর কোনটা মরলে **কোন** feature মরে?" কেউ উত্তর দিতে পারল না। `flags` কোনো তালিকায় ছিলই না।
2. "কিছু ভাঙলে আমরা কী অবস্থায় থাকতে চাই - সেটা কি আগে থেকে ঠিক করা আছে, নাকি রাত ২টায় ঠিক করি?"
3. "আর আমরা যা নকশা করব, সেটা যে কাজ করে - জানব কীভাবে? পরের outage এর অপেক্ষায় থেকে?"

---

## ১. Theory

### ১.১ Fault আর Failure - শিকলটা কোথায় ভাঙবে

শনিবারের ঘটনাটা তিনটা ধাপে ঘটেছে, আর ধাপগুলোর আলাদা নাম আছে:

```
fault                     error                           failure
─────                     ─────                           ───────
flags এর disk ভরা   →    flag পড়তে গিয়ে exception   →    user দেখে 500
(একটা অংশের ত্রুটি)       (system এর ভেতরে ভুল অবস্থা)      (user যা পেল তা প্রতিশ্রুতির বাইরে)
```

**Fault Tolerance** - system এর একটা অংশে ত্রুটি (**fault**) ঘটলেও সেটাকে user এর দেখা ব্যর্থতায় (**failure**) পৌঁছাতে না দেওয়ার ক্ষমতা; fault ঠেকানো যায় না, কিন্তু fault থেকে failure এর শিকলটা কোথাও ভাঙা যায়।

শিকলটা ভাঙার জায়গা কয়েকটা, আর আপনি আগের lesson গুলোয় সেগুলোর কয়েকটা দেখেছেন:

- **Fault টাকেই লুকানো** - একটা copy মরলে আরেকটা কাজ করে (1.6 এর SPOF সরানো, 5.7 এর replica, 3.4 এর failover)। এটাই redundancy, আর ১.৫ এ দেখবেন তার সূত্র কতটা আশাবাদী।
- **Error টাকে আটকানো** - timeout, circuit breaker, bulkhead (9.4)। Error একটা জায়গায় থাকে, ছড়ায় না।
- **Failure টাকে ছোট করা** - পুরো page এর বদলে একটা অংশ বাদ, ভুল উত্তরের বদলে পুরনো উত্তর। এটাই **graceful degradation** (১.৪)।

এই পার্থক্যটা কেন জরুরি: 1.5 এর availability একটা **মাপ** - কত সময় user প্রতিশ্রুতি অনুযায়ী উত্তর পেল। Fault tolerance একটা **নকশার গুণ** - fault আসবেই, প্রশ্ন হলো তার কতগুলো failure হয়। শনিবার রাতে fault টা ছোট ছিল (একটা disk), failure ছিল পূর্ণ (পুরো site)। দূরত্বটা পুরোপুরি নকশার।

### ১.২ Dependency Matrix - কোনটা মরলে কোনটা মরে

CTO এর প্রথম প্রশ্নের উত্তর খোঁজার সরাসরি পথ: প্রতিটা dependency কে একটা একটা করে মেরে দেখা, আর প্রতিটা user journey চালিয়ে দেখা। Exercise এর `npm run matrix` ঠিক তাই করে - TaskFlow এর সাতটা journey (`src/journeys.ts`) আসল TypeScript function, আর একটা harness প্রতিটা dependency কে "মরা" (সাথে সাথে connection refused) বানিয়ে প্রতিটা journey চালায়। টেবিলটা হাতে লেখা না, code চালিয়ে **আবিষ্কার** করা:

```
── A. One dependency dead (connection refused) - old code ──
dead dependency          login       board  create-task     comment      search      upload  share-link
pg-primary                   ✗           ✓           ✗           ✗           ✓           ✗           ✓
pg-replica                   ✓           ✗           ✓           ✓           ✗           ✓           ✓
redis-cache                  ✓           ✓          ✗!           ✓           ✓           ✓           ✓
redis-limiter                ✗           ✓           ✓           ✓           ✓           ✓           ✓
redis-queue                  ✓           ✓           ✓          ✗!           ✓           ✓           ✓
billing                      ✓           ✗           ~           ✓           ✓           ✓           ✓
flags                        ✗           ✗           ✗           ✗           ✗           ✗           ✗
object-storage               ✓           ✓           ✓           ✓           ✓           ✗           ✓
email                        ✓           ✓           ✓           ✓           ✓           ✓           ✓
```

(`✓` = ঠিক, `~` = কিছু বাদ দিয়ে চলেছে, `✗` = ব্যর্থ, `✗!` = লেখা হয়ে গেছে কিন্তু user error দেখেছে)

**Hard Dependency / Soft Dependency** - একটা journey এর **hard** dependency সেটা যেটা না থাকলে journey ব্যর্থ হয়; **soft** dependency সেটা যেটা না থাকলে journey চলে, শুধু কিছু বাদ দিয়ে বা কিছুটা খারাপ ভাবে। একই dependency এক journey এর hard আর আরেকটার soft হতে পারে - আর সেটা ঠিক করে **code**, dependency নিজে না।

এই টেবিল থেকে পাঁচটা জিনিস পড়ার আছে:

1. **`flags` এর পুরো সারি ✗।** সবচেয়ে "অগুরুত্বপূর্ণ" service টা সাতটা journey এর প্রতিটার hard dependency। কারণ code টা এমন: `const enabled = await flags.get('activity-panel')` - কোনো default নেই, কোনো try নেই। Flag টা নিজে একটা soft জিনিস নিয়ন্ত্রণ করে (একটা panel দেখাবে কিনা), কিন্তু তাকে **পড়ার** পদ্ধতি পুরো page কে hard বানিয়েছে। শনিবার রাত।
2. **`billing` board এর hard dependency।** Board খোলা billing এর সাথে কথা বলে plan এর badge দেখাতে ("Pro")। 9.4 এ "billing মরলেও board খুলবে" লক্ষ্য লেখা হয়েছিল, bulkhead বসানো হয়েছিল - কিন্তু পরে কেউ এই badge যোগ করেছে, আর সে লক্ষ্যটা জানত না। একটা নিয়ম যেটা কেউ পরীক্ষা করে না, সেটা কয়েক মাসে ক্ষয়ে যায়।
3. **দুটো `✗!` - সবচেয়ে বিপজ্জনক ঘর।** Task তৈরির code: DB তে লিখুন, commit, তারপর cache invalidate (`redis-cache`)। Cache মরা থাকলে invalidate exception ছোড়ে - **commit এর পরে**। User দেখে "কিছু ভুল হয়েছে", আবার চাপে, আর এখন দুটো একই task। Comment এর code একই ভাবে commit এর পরে সরাসরি queue তে job দেয়। 2.5 এর idempotency key এখানে user কে বাঁচাত (দ্বিতীয় চাপ চেনা যেত), কিন্তু আসল রোগ হলো commit এর পরের একটা অদরকারি কাজকে hard বানানো। 7.5 এর dual write এর এটা আরেক চেহারা।
4. **`email` এর পুরো সারি ✓।** কোনো user-facing journey email এর জন্য অপেক্ষা করে না - 7.1 থেকে email একটা background job। Async মানে এখানে সরাসরি fault tolerance: provider মরলে email দেরিতে যায়, কেউ ব্যর্থ হয় না।
5. **`redis-limiter` login এর ✗ ইচ্ছাকৃত।** 9.5 এর সিদ্ধান্ত: limiter মরলে login এ fail closed - brute force এর দরজা খুলে দেওয়ার চেয়ে কয়েক মিনিট login বন্ধ ভালো। একটা `✗` সবসময় bug না। Matrix এর কাজ হলো প্রতিটা `✗` কে একটা **সিদ্ধান্ত** বানানো, দুর্ঘটনা না।

### ১.৩ গুণফলের অঙ্ক

এবার CTO এর প্রশ্নের সংখ্যার দিক। একটা journey চলে যদি তার **সব** hard dependency একসাথে বেঁচে থাকে। তারা স্বাধীনভাবে মরলে:

```
journey এর availability = a₁ × a₂ × a₃ × …        (শুধু hard dependency গুলোর)

board (আগের code):  flags × replica × billing = 0.995 × 0.999 × 0.999 = 99.301%
```

`npm run matrix`, অংশ ঘ - প্রতিটা dependency কে তার availability অনুযায়ী এলোমেলো সময়ে মেরে ১০ বছর simulate করা, আর প্রতি মিনিটে প্রতিটা journey চালানো:

```
journey        hard dep (old)   formula   old code  down/year   hard dep (new)    worked   in full  down/year
login                       3   99.351%    99.368%  3,320 min                2   99.861%   99.861%    731 min
board                       3   99.301%    99.300%  3,680 min                0  100.000%   99.791%      0 min
create-task                 3   99.351%    99.353%  3,399 min                1   99.948%   99.733%    274 min
comment                     3   99.351%    99.346%  3,440 min                1   99.948%   99.948%    274 min
search                      2   99.401%    99.412%  3,093 min                1   99.904%   99.904%    505 min
upload                      3   99.440%    99.438%  2,952 min                2   99.931%   99.931%    360 min
share-link                  1   99.500%    99.507%  2,592 min                0  100.000%  100.000%      0 min
```

- **সূত্র আর simulation প্রায় হুবহু মেলে** (board: ৯৯.৩০১% বনাম ৯৯.৩০০%)। গুণফলটা কোনো তাত্ত্বিক আন্দাজ না - স্বাধীন failure এ এটাই হয়।
- **আগের code এ board বছরে ৩,৬৮০ মিনিট বন্ধ - ৬১ ঘণ্টা।** অথচ এর কোনো dependency ই ৯৯.৫% এর নিচে না। প্রতিটা নতুন hard dependency availability কে **গুণ** করে কমায়, যোগ করে না। দশটা hard dependency, প্রতিটা ৯৯.৯% - journey ৯৯.০%, ভালো ভালো অংশ দিয়ে বানানো একটা দুই-nine এর জিনিস।
- **নতুন code এ board এর hard dependency শূন্য** - কখনো পুরো বন্ধ হয়নি, কিন্তু "পুরোটা" কলাম ৯৯.৭৯১%: বছরে ~১,১০০ মিনিট কিছু একটা বাদ পড়েছে (badge, comment সংখ্যা, panel)। Degradation failure কে মুছে ফেলে না, তাকে ছোট টুকরোয় ভাঙে।

এখান থেকে সবচেয়ে ব্যবহারিক নিয়ম: **availability বাড়ানোর সবচেয়ে সস্তা পথ প্রায়ই dependency গুলোকে আরও নির্ভরযোগ্য করা না, journey থেকে hard dependency সরানো।** `flags` কে ৯৯.৫% থেকে ৯৯.৯৯% এ নিতে লাগবে replication, on-call, monitoring। তাকে soft বানাতে লাগে একটা default আর একটা try।

(একটা সৎ সতর্কতা: এই simulation এ শুধু এই নয়টা dependency আছে। Gateway, network, DNS, app নিজে - বাদ। তাই "১০০.০০০%" মানে "এই নয়টার কোনো একক বা যৌথ outage এ board ভাঙেনি", পুরো TaskFlow এর availability না। আর dependency গুলো স্বাধীনভাবে মরছে ধরা হয়েছে - ১.৫ এ দেখবেন সেই ধারণাটা কোথায় ভাঙে।)

### ১.৪ Graceful Degradation - ভাঙার আগে ঠিক করা "খারাপ কিন্তু চলছে"

**Graceful Degradation** - একটা dependency মরলে বা ধীর হলে পুরো কাজ ব্যর্থ না করে একটা আগে থেকে ঠিক করা, কম-কিন্তু-কাজের অবস্থায় চলা; কী বাদ যাবে আর user কী দেখবে, সেটা ঘটনার আগে নকশা করা।

নতুন code এর matrix (`npm run matrix`, অংশ খ) এর বদলানো সারিগুলো:

```
── B. One dependency dead - code written with degradation in mind ──
dead dependency          login       board  create-task     comment      search      upload  share-link
pg-replica                   ✓           ~           ✓           ✓           ✗           ✓           ✓
redis-cache                  ✓           ✓           ~           ✓           ✓           ✓           ✓
redis-queue                  ✓           ✓           ✓           ✓           ✓           ✓           ✓
billing                      ✓           ~           ~           ✓           ✓           ✓           ✓
flags                        ✓           ✓           ✓           ✓           ✓           ✓           ✓
```

প্রতিটা `~` এর পেছনে একটা আলাদা ধরনের fallback, আর তাদের একটা তালিকা মাথায় রাখার মতো, কারণ প্রতিটার দাম আলাদা:

| Fallback                | TaskFlow এ                                                                                                 | দাম                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **বাদ দেওয়া**          | Billing মরা → plan badge লুকানো; replica মরা → comment সংখ্যা আর activity panel নেই                        | User কিছু কম দেখে; কেউ খেয়াল না করার সম্ভাবনাই বেশি                                |
| **পুরনো data**          | Flags মরা → শেষ জানা মান (১.৭); cache invalidate ব্যর্থ → পুরনো board ≤ ৫ মিনিট (10.1 এর TTL)              | ভুল হতে পারে - কতটা পুরনো চলে, সেটা data ধরে ঠিক করতে হয় (6.5 এর consistency)      |
| **বিকল্প পথ**           | Replica মরা → board আর share link primary থেকে পড়ে                                                        | বিকল্পটার উপর চাপ - primary কে বাঁচাতে এই পথে concurrency এর সীমা (9.4 এর bulkhead) |
| **পরে করা**             | Billing মরা → task তৈরি হয়, quota `quota_pending` (9.4); comment এর email outbox এ (7.5)                  | কিছুক্ষণ নিয়ম নরম, পরে মিলিয়ে নিতে হয় (reconcile job)                            |
| **স্পষ্টভাবে "এখন না"** | Replica মরা → search এ "search এখন পাওয়া যাচ্ছে না", বাকি app চলে; plan upgrade এ কোনো fallback নেই (9.4) | User একটা কাজ করতে পারে না - কিন্তু সে জানে কেন, আর বাকি সব চলে                     |

খেয়াল করুন search এর `✗` নতুন code এ ও আছে। Replica মরলে search কে primary তে পাঠানো যেত - কিন্তু full-text search দামি query (8.3), আর primary তখন task লেখা সামলাচ্ছে। একটা ঐচ্ছিক feature কে বাঁচাতে গিয়ে core লেখার পথ ডুবিয়ে দেওয়া হলো fault কে ছড়িয়ে দেওয়া। **কোনটা degrade করবেন, কোনটা স্পষ্টভাবে বন্ধ করবেন - এটা product আর engineering এর যৌথ সিদ্ধান্ত**, আর এর উত্তর আসে "user এর কাছে কোন কাজটা আসল" থেকে।

**ধীর, মরার চেয়ে খারাপ।** Matrix এর অংশ গ একই টেবিল, কিন্তু dependency মরা না, ৩ সেকেন্ডে উত্তর দেয়:

```
── C. One dependency slow (answers in 3 s) - old code ──
slow dependency          login       board  create-task     comment      search      upload  share-link
redis-cache                  ✓        3.0s        3.0s           ✓           ✓           ✓        3.0s
redis-limiter             3.0s        3.0s        3.0s        3.0s        3.0s           ✓           ✓
flags                     3.0s        3.0s        3.0s        3.0s        3.0s        3.1s        3.0s
```

`redis-limiter` মরা থাকলে board এর কিছু হয় না (fail open - 9.5)। কিন্তু **ধীর** হলে পাঁচটা journey ৩ সেকেন্ড ধরে আটকে থাকে, কারণ fail open এর code টা একটা `try/catch` - আর `catch` এ পৌঁছাতে আগে exception আসতে হয়। ধীর dependency কোনো exception ছোড়ে না; সে শুধু অপেক্ষা করায়। একই ভাবে ধীর `redis-cache` board কে ৩ সেকেন্ড আটকায়, যদিও cache এর পুরো উদ্দেশ্য ছিল board কে দ্রুত করা।

নতুন code এ প্রতিটা call এ একটা timeout (cache আর limiter ৫০ ms, replica ৩০০–৫০০ ms, billing ১৫০ ms), আর অংশ গ২ তে এই সারিগুলোর সব ঘর আবার ✓ বা ~ - শুধু ধীর limiter এ login এর ঘর `✗`, কিন্তু সেটা ৯.৫ এর ইচ্ছাকৃত fail closed, এখন ৩ সেকেন্ডের বদলে ৫০ ms এ। এখান থেকে নিয়মটা: **timeout ছাড়া একটা soft dependency আসলে latency এর দিক থেকে hard dependency।** Exercise এর experiment ৬: নতুন code থেকে শুধু billing এর `150` timeout সরিয়ে দিলে ধীর billing এ board আবার ৩.০ s। 9.4 এ timeout এসেছিল breaker এর অংশ হিসেবে; এখানে তার আরও মৌলিক কাজটা - **fallback এর দরজা খোলা।** Timeout না থাকলে কোনো fallback কখনো চলে না।

### ১.৫ Redundancy আর সূত্রের ফাঁকি

শিকল ভাঙার প্রথম পথ - fault লুকানো, copy রেখে। 1.6 থেকে জানা অঙ্ক: একটা instance এর availability `a` হলে, `k` টা copy এর যেকোনো একটা বাঁচলেই চলে, তাই:

```
availability = 1 − (1 − a)^k

a = 99.931% (গড়ে ৩০ দিনে একবার মরে, ৩০ মিনিটে ফেরে)
k = 1  →  বছরে ৩৬৫ মিনিট বন্ধ
k = 3  →  বছরে ০.০১১ সেকেন্ড বন্ধ
```

তিনটা copy, আর বছরে এক সেকেন্ডের শতভাগের এক ভাগ - প্রায় অবিনাশী। এবার `npm run redundancy` - billing service, ৪০ বছর simulate করা, তিন ধরনের fault নিয়ে: instance মরে (গড়ে ৩০ দিনে একবার), একটা পুরো AZ (availability zone - একটা data center এর দল, 8.1 এর failure domain) মরে বছরে আধাবার, দুই ঘণ্টা, আর deploy সপ্তাহে তিনটা, যার ৩% খারাপ:

```
design                          formula down/year   measured   failed min/year  instance      AZ   deploy  full outage
1 instance                                365 min    99.905%               497       343      82       72     461 min
3, same AZ, deployed together              0.011 s    99.970%               160         6      82       72     117 min
3, 3 AZs, deployed together               0.011 s    99.985%                78         6       0       72      35 min
3, 3 AZs, one at a time                   0.011 s    99.992%                43         6       0       37       0 min
```

- **সূত্র বলে ০.০১১ সেকেন্ড, মাপা ১৬০ মিনিট** - প্রায় ৯ লাখ গুণ বেশি। Instance এর আলাদা আলাদা মৃত্যু সূত্র ঠিকই সামলেছে (৩৪৩ → ৬ মিনিট)। কিন্তু বাকি দুটো কারণ তিনটা copy কে **একসাথে** মারে: AZ মরলে তিনটাই সেখানে, আর একটা খারাপ deploy তিনটাতেই একসাথে যায়।
- **সূত্রের লুকানো শর্ত: failure গুলো স্বাধীন।** Redundancy শুধু স্বাধীন failure এর বিরুদ্ধে কাজ করে। যা copy গুলোর মধ্যে **ভাগ করা** - একই rack, একই AZ, একই power, একই config, একই code version, একই dependency - সেটা একটা correlated failure এর উৎস, আর সেখানে k = ৩ মানে k = ১।
- **তিনটা AZ এ ছড়ালে AZ এর কলাম শূন্য** - 8.1 এর failure domain এর ধারণা, এখানে service এর জন্য।
- **সবচেয়ে বড় বাকি উৎস deploy।** একসাথে সব instance এ নতুন version মানে একটা bug একসাথে সবগুলোয়। একটা একটা করে (প্রতিটার মাঝে ১০ মিনিট দেখা) deploy করলে খারাপ version প্রথম instance এ থাকতেই ধরা পড়ার সুযোগ পায়: ৭২ → ৩৭।

Google এর SRE বই এর একটা প্রায়ই উদ্ধৃত পর্যবেক্ষণ: outage এর মোটামুটি ৭০% আসে চলমান system এ **পরিবর্তন** থেকে (এখানে যাচাই করা না)। Simulation এ ও সবচেয়ে বড় correlated fault টা হার্ডওয়্যার না, deploy। তাই 10.6 এর পুরো lesson টাই deploy নিয়ে।

আর একটা সতর্কতা, exercise এর experiment ৪ থেকে: একটা একটা করে deploy **সবসময়** নিরাপদ না। `QUIET_DETECT=60` - একটা "শান্ত" bug (crash করে না, শুধু কিছু ভুল উত্তর দেয়) ধরতে যদি ৬০ মিনিট লাগে, তাহলে deploy ধীরে ধীরে তিনটা instance এ ই পৌঁছে যায়, আর ক্ষতি বেড়ে **১৪৭** মিনিট - একসাথে deploy এর চেয়ে বেশি, কারণ সেখানে পুরো ভাঙন জোরে চিৎকার করে আর দ্রুত ধরা পড়ে। ধীরে ছড়ানোর লাভ পুরোটাই নির্ভর করে **ছড়ানোর আগে ধরতে পারার** উপর। ধরার উপায় না থাকলে ধীর deploy শুধু ক্ষতিটা ধীরে ছড়ায়।

### ১.৬ চাপের সময় - Brownout

এবার সোমবার সকাল। এখানে কোনো dependency মরেনি; সমস্যা হলো **নিজের ক্ষমতা**। `npm run brownout` - ৪৮টা worker, স্বাভাবিক ৬০০ req/s, সকাল ৯টায় আড়াই গুণ (১,৫০০ req/s) সাত মিনিট, আর client ৩ সেকেন্ড পরে চলে যায়। একটা পুরো board page এর worker সময়:

```
full page = task list 8 ms + comment counts 5 ms + activity panel 12 ms + "more boards like this" 25 ms = 50 ms
capacity: 960 req/s with the full page; at the brownout levels 25 ms → 1,920 req/s, 13 ms → 3,692 req/s, 8 ms → 6,000 req/s
```

পুরো page এ ক্ষমতা ৯৬০ req/s, আর এসেছে ১,৫০০। কিন্তু core কাজটা - task তালিকা - মোট খরচের মাত্র ১৬%। চাপের সাত মিনিটে আসা request গুলোর কী হলো:

```
policy                  got board  full page      503   timeout       p50       p99  wasted work  recovery after load
nothing                      0.0%       0.0%     0.0%    100.0%         -         -      100.0%  not even in 15 minutes
+ deadline check            34.1%      34.1%     0.0%     65.9%    2.99 s    3.00 s       59.1%          immediately
load shedding (7.4)         64.0%      64.0%    36.0%      0.0%    348 ms    373 ms        0.0%          immediately
brownout                   100.0%       2.9%     0.0%      0.0%     18 ms    360 ms        0.0%          immediately
brownout + shedding         99.7%       3.1%     0.3%      0.0%     18 ms    315 ms        0.0%          immediately
```

**কিছু না:** কেউ board পায়নি। শূন্য। আর চাপ চলে যাওয়ার পরেও সারে না - ১৫ মিনিটের run শেষ হওয়া পর্যন্ত কেউ সময়মতো উত্তর পায়নি। কেন: queue তে লাখখানেক request জমেছে, worker গুলো সেগুলো ক্রমানুসারে শেষ করছে - আর প্রতিটার client অনেক আগে চলে গেছে। **নষ্ট কাজ ১০০%**: প্রতিটা worker মুহূর্ত এমন request এর পেছনে যার উত্তর কেউ পড়বে না। এটাই সোমবারের "৯:০৮ এ ভিড় কমল, কিন্তু site ঠিক হলো না।"

**Deadline check:** কাজ শুরুর আগে দেখা - "এই request এর client কি এখনো অপেক্ষা করছে, আর বাকি সময়ে কাজটা শেষ হবে?" না হলে বাদ। এক লাইনের code, আর চাপ শেষে সাথে সাথে স্বাভাবিক - জমে থাকা মৃত কাজ আর কেউ করে না। (এর বড় রূপটাকে বলে **deadline propagation** - client এর সময়সীমা প্রতিটা ভেতরের call এর সাথে পাঠানো, যাতে চতুর্থ স্তরের service ও জানে কখন থামতে হবে; gRPC এ এটা built-in।) কিন্তু চাপের সময়ে এটা একা যথেষ্ট না: FIFO queue ঠিক সীমার কিনারায় বসে থাকে - যারা পায়, তারা p50 ২.৯৯ s এ পায়, আর যেগুলো কিনারায় শুরু হয়ে সীমা পেরিয়ে শেষ হয় সেগুলো এখনো নষ্ট (৫৯%)। (Facebook এর "Fail at Scale" লেখায় এর একটা উত্তর আছে - চাপের সময় queue কে LIFO বানানো আর queue এর অপেক্ষা ছোট রাখা; এখানে মাপা না।)

**Load shedding (7.4):** queue এর অপেক্ষা ৩০০ ms পেরোলে নতুন request কে সাথে সাথে 503। এখন যারা পায় তারা দ্রুত পায় (p99 ৩৭৩ ms), আর কোনো কাজ নষ্ট হয় না। কিন্তু **৩৬% user কিছুই পায় না।** Shedding ক্ষমতার সীমা মেনে নেয় আর ঠিক করে কে বাদ যাবে।

**Brownout - সবাই board পেয়েছে, ১০০%।** p50 ১৮ ms।

**Brownout** - চাপ বাড়লে প্রতিটা request এর **ঐচ্ছিক অংশ** স্বয়ংক্রিয়ভাবে বন্ধ করে প্রতি request এর খরচ কমানো, যাতে একই ক্ষমতায় সবাইকে core কাজটা দেওয়া যায়; চাপ কমলে অংশগুলো আবার ফেরে।

Load shedding আর brownout একই সমস্যার দুটো উত্তর, আর পার্থক্যটা কোন মাত্রা কমানো হচ্ছে তাতে:

```
ক্ষমতা = request এর সংখ্যা × প্রতি request এর খরচ

load shedding:  সংখ্যা কমান  →  কেউ কেউ কিছুই পায় না, বাকিরা সব পায়
brownout:       খরচ কমান    →  সবাই কিছু পায়, কেউ সব পায় না
```

Brownout এর ধাপগুলো মিনিট ধরে (`npm run brownout`, অংশ খ) - ০ মানে পুরো page, ৩ মানে শুধু task তালিকা:

```
minute     req/s  avg level  brownout p99  nothing: p99  nothing: on time
2            598      0.00         74 ms         74 ms           100.0%
3          1,048      0.84        187 ms        2.90 s            63.4%
4          1,495      1.49        350 ms             -             0.0%
7          1,500      1.47        348 ms             -             0.0%
11         1,052      0.97        235 ms             -             0.0%
12           603      0.00         74 ms             -             0.0%
```

Controller সরল: প্রতি সেকেন্ডে গড় queue এর অপেক্ষা ৫০ ms এর বেশি হলে এক ধাপ উঠুন, ১০ সেকেন্ড শান্ত থাকলে এক ধাপ নামুন। ভিড়ের সময় গড় ধাপ ~১.৪৫ - "এরকম আরও board" প্রায় সবসময় বন্ধ, activity panel মাঝে মাঝে। আর ভিড় চলে গেলে নিজে থেকেই ধাপ ০, পুরো page ফেরে। কেউ রাত জাগেনি, কেউ flag খোঁজেনি।

তিনটা সৎ সীমা:

- **"পুরো page" মাত্র ২.৯%।** ক্ষমতা ছিল ৬৪% user কে পুরো page দেওয়ার মতো, কিন্তু এই controller ধাপ সবার জন্য একসাথে বদলায় - সবাই কিছু কম পায়। আরও সূক্ষ্ম controller একটা **ভগ্নাংশ** request এর জন্য অংশ বন্ধ করত। আর ধাপ ওঠানামা করে (০ ↔ ১ ↔ ২) - p99 এর ৩৬০ ms সেই দোলাচলের দাম। Experiment ৩ এ threshold ২০০ ms করলে বেশি user পুরো page পায় (৫.২%), কিন্তু p99 ৭১৭ ms।
- **Brownout এর একটা তলা আছে।** শুধু task তালিকাতেও ক্ষমতা ৬,০০০ req/s। Experiment ২: `PEAK=12` (৭,২০০ req/s) - brownout একা ৪৯.৫% user কে সময়মতো দেয়, বাকিরা timeout; brownout + shedding ৮৩.৩%, বাকিরা দ্রুত 503। তাই দুটো যন্ত্র একে অপরের বিকল্প না - **brownout প্রথম স্তর, shedding শেষ জাল।**
- **কোন অংশ ঐচ্ছিক, সেটা আগে ঠিক করতে হয়।** "এরকম আরও board" বন্ধ করা যায়, কারণ কেউ জানে সেটা ঐচ্ছিক - সোমবার সকালে সেটাই একজন মানুষ হাতে করেছিল, চোদ্দ মিনিট দেরিতে। Brownout হলো সেই সিদ্ধান্তটাকে আগে থেকে code এ লিখে রাখা।

(Brownout শব্দটা একটা ২০১৪ সালের গবেষণা থেকে cloud application এ জনপ্রিয় - "Brownout: building more robust cloud applications", Klein ও সহকর্মীরা; বিদ্যুৎ এর "voltage কমিয়ে চালানো" থেকে নাম। এখানে যাচাই করা না।)

### ১.৭ Static Stability - control plane মরলে

এবার শনিবারের রাত, নকশার চোখে। `flags` কোনো user request সরাসরি সামলায় না; সে অন্যদের বলে **কীভাবে** চলতে হবে। এই দুই ধরনের অংশের নাম আছে:

```
control plane  -  বলে দেয় কী করতে হবে, মাঝে মাঝে বদলায়
                   flags, config, service registry (10.1), Kubernetes API, etcd (Patroni এর জন্য)
data plane     -  আসল request সামলায়, প্রতি মুহূর্তে
                   app instance, Postgres, Redis, gateway
```

শনিবারের মূল ভুল: **data plane এর প্রতিটা request control plane এর উপর নির্ভর করত।** অথচ control plane এর কাজ মাঝে মাঝে বদল আনা - flag টা শেষবার বদলেছিল তিন দিন আগে। সে না থাকলে নতুন বদল আসবে না, কিন্তু পুরনো মান তো ঠিকই ছিল।

**Static Stability** - একটা system এর এমন গুণ যে, তার control plane (config, flag, registry, orchestration) মরে গেলেও data plane শেষ জানা অবস্থায় একই ভাবে চলতে থাকে - নতুন কিছু **বদলাতে** না পারলেও, যা চলছিল তা **চালিয়ে যেতে** পারে, restart বা নতুন instance তোলা সহ।

`npm run static` - `flags` মিনিট ৩০ থেকে ৭৫ পর্যন্ত মরা; মিনিট ৫০ থেকে ৮০ এ traffic ৬০০ থেকে ১,০০০ req/s (autoscaler নতুন instance তোলে); আর instance মাঝে মাঝে crash করে restart নেয়। চারটা নকশা:

```
design                        failed requests        worst minute  short minutes  failed boots         config age (max)
ask on every request                   44.05%              100.0%            45             0                        -
cache, TTL 5 minutes                   40.82%              100.0%            40           463                5 minutes
last-known-good                        12.08%               50.0%            25           463               45 minutes
last-known-good + snapshot              0.24%               20.0%             1             0               45 minutes
   in this run: 9 crash/restarts, the autoscaler brought up 6 new instances; failed requests = % of the total over all 120 minutes
```

- **প্রতি request এ জিজ্ঞেস:** outage এর পুরো ৪৫ মিনিট সব ব্যর্থ।
- **TTL cache (TaskFlow এর আসল নকশা):** মাত্র ৫ মিনিট কেনে, তারপর সবাই একসাথে মরে - ঠিক শনিবার ২:১৫। Cache এর মেয়াদ শেষ হলে "নতুন মান না পেলে error" - এই নিয়মটাই সমস্যা, TTL এর দৈর্ঘ্য না। Experiment ১: TTL ৩০ মিনিট করলে ক্ষতি ২২.৯৬% - কম, কিন্তু ৪৫ মিনিটের outage এ শেষ ১৫ মিনিট একই খাদ।
- **Last-known-good:** মান না পেলে পুরনো মানই চালান, যত পুরনোই হোক। চলমান instance গুলো বেঁচে গেল - কিন্তু তবু ১২%। কারণ শেষ কলামের আগেরটা: **৪৬৩টা ব্যর্থ boot।** Crash করা instance আর autoscaler এর নতুন instance এর কাছে কোনো "শেষ জানা মান" নেই - তারা জন্মই নিচ্ছে outage এর মধ্যে। Boot এ flag লাগে, পায় না, crash, ৩০ সেকেন্ড পরে আবার - শনিবার ২:৩০ এর crash loop। আর ঠিক ভিড়ের সময় (মিনিট ৫০) ক্ষমতা লাগছিল, কিন্তু নতুন instance উঠতে পারছিল না।
- **Last-known-good + snapshot:** প্রতিটা সফল fetch এর পরে মানগুলো disk এ (বা deploy এর সময় image এর ভেতরে) লিখে রাখা; boot এ control plane না পেলে snapshot থেকে শুরু। ব্যর্থ boot শূন্য, ব্যর্থ request ০.২৪% - আর সেই ০.২৪% এসেছে autoscaler এর এক মিনিটের boot সময় থেকে, যেটা চারটা নকশাতেই আছে।

**দামটা সৎভাবে - শেষ কলাম:** last-known-good মানে outage এর পুরো সময় config **৪৫ মিনিট পুরনো**। সাধারণত এটা কোনো সমস্যা না - flag তিন দিনে একবার বদলায়। কিন্তু একটা জিনিস হারায়: **kill switch।** ধরুন outage এর মধ্যে একটা নতুন feature bug করছে, আর তাকে flag দিয়ে বন্ধ করতে চান - পারবেন না, কারণ flag বদলানোর যন্ত্রটাই মরা। Static stability মানে "বদলাতে না পারলেও চলতে পারা" - দুটোর মধ্যে প্রথমটাই ছাড়তে হয়। তাই গুরুত্বপূর্ণ kill switch গুলোর জন্য একটা আলাদা, সরল পথ রাখা ভালো (ধরুন একটা environment variable, যেটা deploy দিয়ে বদলানো যায়)।

এই ধারণাটা TaskFlow এর আরও কয়েক জায়গায় লুকিয়ে আছে, আর সবচেয়ে বিপজ্জনকটা Module 5 থেকে: **Patroni + etcd।** Patroni primary কে primary রাখে etcd তে একটা lease ধরে (6.1, 6.2)। Patroni এর documentation অনুযায়ী, etcd তে পৌঁছাতে না পারলে Patroni ধরে নেয় সে হয়তো partition এর ভুল দিকে, আর **primary কে নিজেই read-only করে দেয়** - split brain এড়াতে। অর্থাৎ etcd (control plane) এর একটা outage পুরো database এর লেখা (data plane) বন্ধ করে দেয়, যদিও Postgres নিজে পুরো সুস্থ। নতুন version এ এর জন্য একটা `failsafe_mode` আছে - primary যদি বাকি সব Patroni সদস্যের সাথে সরাসরি কথা বলতে পারে, তাহলে etcd ছাড়াই primary থাকে (এখানে যাচাই করা না; version আর setting দেখে নেবেন)। 6.1 এর split brain এর ভয় আর আজকের static stability এর চাহিদা এখানে সরাসরি মুখোমুখি - আর এটা ঠিক সেই ধরনের trade-off যেটা আগে জানা থাকা দরকার, রাত ২টায় না।

(Static stability শব্দটা Amazon এর Builders' Library এর একটা লেখা থেকে পরিচিত - "Static stability using Availability Zones"; সেখানে উদাহরণ EC2: control plane মরলে নতুন instance চালানো যায় না, কিন্তু চলমান instance চলতে থাকে। এখানে যাচাই করা না।)

### ১.৮ Chaos Engineering - কেন ইচ্ছা করে ভাঙা

এখন CTO এর তৃতীয় প্রশ্ন: নতুন নকশা যে কাজ করে, জানব কীভাবে?

Matrix টা exercise এ code চালিয়ে বের হয়েছে। কিন্তু production এর code exercise এর code না। Production এ আছে আসল timeout (যেটা হয়তো কেউ ORM এর default এ রেখে দিয়েছে), আসল retry (library এর ভেতরে লুকানো), আসল config, আর এমন dependency যেটা কেউ তালিকায় লেখেনি - ঠিক `flags` এর মতো, বা board এর plan badge এর মতো। Code review এ এগুলো ধরা পড়ে না, কারণ প্রতিটা আলাদাভাবে নিরীহ দেখায়। ধরা পড়ে যখন dependency টা সত্যিই মরে।

তাহলে দুটো পথ: অপেক্ষা করুন কবে সে নিজে মরবে (শনিবার রাত ২টা, কেউ প্রস্তুত না), নাকি **নিজে মারুন** - মঙ্গলবার দুপুর ২টায়, সবাই অফিসে, rollback প্রস্তুত, আর ছোট পরিসরে।

**Chaos Engineering** - production system এ ইচ্ছা করে, নিয়ন্ত্রিতভাবে fault ঢুকিয়ে (একটা dependency মারা, ধীর করা, network কাটা) পরীক্ষা করা যে system তার স্বাভাবিক আচরণ (**steady state**) ধরে রাখে কিনা; লক্ষ্য দুর্বলতা খুঁজে বের করা - user রা খোঁজার আগে।

এটা "এলোমেলো জিনিস ভেঙে দেখা" না। এটা একটা experiment, বিজ্ঞানের অর্থে:

1. **Steady state ঠিক করুন** - একটা মাপা যায় এমন সংখ্যা যা "system ঠিক আছে" বোঝায়, ব্যবসার ভাষায়: board খোলার সফলতা ৯৯.৯৫%, p99 ৩০০ ms। CPU বা memory না - user কী পাচ্ছে।
2. **Hypothesis লিখুন** - "billing ২ সেকেন্ড ধীর হলে board খোলার সফলতা ৯৯.৯% এর উপরে থাকবে, p99 ৪০০ ms এর নিচে, আর শুধু plan badge লুকাবে।" এটা matrix এর একটা ঘর, এখন production এর জন্য দাবি হিসেবে।
3. **Fault ঢোকান, ছোট পরিসরে** - সব traffic এ না, একটা ভগ্নাংশে (১.৯)।
4. **তুলনা করুন, আর থামার নিয়ম আগে লিখুন** - steady state ভাঙলে experiment সাথে সাথে বন্ধ, স্বয়ংক্রিয়ভাবে।
5. **যা পেলে সেটা ঠিক করুন, তারপর experiment টা নিয়মিত চালান** - একবার পাস করা নকশা পরের মাসে কেউ একটা badge যোগ করলেই ভাঙে (১.২ এর পাঠ)।

এই ধাপগুলো Netflix এর engineer দের লেখা "Principles of Chaos Engineering" (principlesofchaos.org) এর মূল কথা: steady state ঘিরে hypothesis, বাস্তব ঘটনার মতো fault, production এ চালানো, স্বয়ংক্রিয় ও নিয়মিত চালানো, আর **blast radius ছোট রাখা**। Netflix এর Chaos Monkey (২০১১ সালের দিকে তাদের blog এ প্রকাশ্যে আসে) production এ এলোমেলো instance মেরে দিত - যাতে প্রতিটা team এর code instance হারানো সহ্য করতে **বাধ্য** হয়। (Netflix এর নিজের প্রকাশিত লেখা থেকে; এখানে যাচাই করা না।)

কেন production এ, staging এ না? Staging এ traffic নকল, data ছোট, config আলাদা, আর dependency গুলোর আচরণ আলাদা - `flags` এর মতো দুর্বলতা সেখানে থাকতেও পারে, না ও পারে। Staging এ শুরু করা যুক্তিসঙ্গত (বড় ভুলগুলো সেখানে সস্তায় ধরা পড়ে), কিন্তু production এর সত্যটা শুধু production জানে। আর যেহেতু production এ সত্যিকারের user আছে, তাই পরের অংশটা - কতজন user কে ঝুঁকিতে ফেলছেন - পুরো পদ্ধতির কেন্দ্র।

একটা নিচু-প্রযুক্তির রূপ ও আছে: **game day** - একটা নির্ধারিত দিনে team মিলে একটা fault ঢোকায় (ধরুন "আজ ২টায় replica বন্ধ করব"), আর সবাই দেখে system আর **মানুষ** কী করে - alert আসে কিনা, runbook কাজ করে কিনা, on-call engineer ঠিক জায়গায় খোঁজে কিনা। শনিবারের ঘটনায় code এর পাশাপাশি মানুষ ও ব্যর্থ হয়েছিল (restart, ২৫ মিনিট `flags` কে কেউ খোঁজেনি) - game day সেটাও পরীক্ষা করে।

### ১.৯ Blast Radius - কতজনকে ঝুঁকিতে ফেলছেন

**Blast Radius** - একটা fault (ইচ্ছাকৃত হোক বা দুর্ঘটনা) সর্বোচ্চ কতটা জুড়ে প্রভাব ফেলতে পারে - কত % traffic, কতজন user, কয়টা service বা region; chaos experiment এ এটাকে ইচ্ছা করে ছোট রাখা হয়, আর নকশায় (cell, AZ, bulkhead) এটাকে ছোট রাখাই fault tolerance এর একটা লক্ষ্য।

ধরুন board এর code এ এখনো একটা লুকানো hard dependency আছে (১.২ এর plan badge)। Billing এ ২ সেকেন্ড দেরি ঢোকানো হচ্ছে। Traffic এর কত % এ ঢোকাবেন? `npm run chaos` - ৫০০ req/s, স্বাভাবিক ভুল ০.০৫%, দুটো উপায়ে থামানো: **global alarm** (শেষ ৬০ সেকেন্ডে পুরো site এর ভুল ০.২% পেরোলে থামান - সাধারণ SLO alert), আর **control group** (experiment এর সমান আকারের একটা না-ছোঁয়া দল রাখুন, দুই দলের ভুলের পার্থক্য পরিসংখ্যানগতভাবে স্পষ্ট হলে থামান)। প্রতিটা অবস্থা ২০০ বার, median:

```
── A. A loud bug - 60% of injected requests fail (plan badge on every paid board, no timeout) ──
blast radius     global: caught      when     harm  control: caught      when     harm
0.1%                     3%      10 s      540         100%      30 s        8
1%                     100%      10 s       29         100%      10 s       29
5%                     100%      10 s      149         100%      10 s      149
100% (all)                 100%      10 s    2,997                -         -        -

── B. A subtle bug - 5% of injected requests fail (only on boards with 500+ tasks) ──
blast radius     global: caught      when     harm  control: caught      when     harm
0.1%                         0%         -       45             100%   6.2 min        9
1%                       2%      10 s      447         100%      40 s       11
5%                     100%      10 s       14         100%      10 s       14
25%                    100%      10 s       61         100%      10 s       61
100% (all)                 100%      10 s      250                -         -        -
```

("ক্ষতি" = থামার আগে fault এর কারণে ব্যর্থ হওয়া user request; না ধরলে পুরো ৩০ মিনিটের।)

- **ক্ষতি blast radius এর সাথে সরাসরি বাড়ে।** জোরালো bug এ ১% → ২৯টা ব্যর্থ request, ১০০% → প্রায় ৩,০০০ - একই ১০ সেকেন্ডে ধরা পড়লেও। বড় blast radius এ bug দ্রুত ধরা পড়ে না (দুটোই প্রথম check এ ধরা পড়েছে), শুধু বেশি মানুষ দেখে।
- **কিন্তু ছোট blast radius এ global alarm অন্ধ।** সূক্ষ্ম bug, ০.১%: পুরো site এর ভুল ০.০৫% থেকে বেড়ে ~০.০৫৫% - কোনো alarm এর কাছে এটা শব্দ। ৩০ মিনিট চলল, কেউ জানল না, ৪৫ জন user ব্যর্থ। ১% এ ও ৯৮% run এ ধরা পড়েনি, ৪৪৭টা ব্যর্থতা।
- **Control group ছোট blast radius কে দেখার যোগ্য বানায়।** ০.১% এর দলকে ০.১% এর আরেকটা দলের সাথে তুলনা করলে পার্থক্যটা আর শব্দে ডোবে না - সূক্ষ্ম bug ৬.২ মিনিটে ধরা পড়ে, ৯টা ক্ষতিতে। একই bug ১০০% এ সরাসরি চালালে ২৫০।

তাই সিদ্ধান্তের আকৃতি: **ছোট শুরু করুন, কিন্তু ছোট শুরু করলে তুলনা করার মতো একটা control group রাখুন।** Netflix এর ChAP (Chaos Automation Platform) এর প্রকাশিত নকশা এই রকমই - experiment আর control, দুটো ছোট, সমান দল (এখানে যাচাই করা না)। আর traffic এর একটা নির্দিষ্ট অংশকে "experiment" এ পাঠানো মানে একটা routing এর যন্ত্র লাগে - 9.2 এর gateway এর canary routing ঠিক সেই জিনিস।

**আর উল্টো ভুলটা - অকারণে থামানো।** একই experiment, কিন্তু code ঠিক আছে (fault নিরীহ):

```
── C. The code is fine, the fault harmless - yet stopped by mistake, in what % of runs ──
blast radius    global: false stop  control: false stop
1%                          0.0%               0.0%
5%                          0.0%               0.5%
50%                         0.0%               1.5%
```

Control group পদ্ধতি মাঝে মাঝে (০.৫–১.৫%) ভুল করে থামায়, কারণ প্রতি ১০ সেকেন্ডে আবার দেখে - ৩০ মিনিটে ১৮০ বার - আর প্রতিবার দেখা একটা নতুন সুযোগ শব্দকে সংকেত ভাবার। Experiment ৫: z এর সীমা ৩ থেকে ২ করলে ভুল থামা ৮–২২%। প্রতি সপ্তাহে ৫০টা experiment চললে সেটা সপ্তাহে কয়েকটা মিথ্যা alarm - আর মিথ্যা alarm team এর বিশ্বাস খায়, যতক্ষণ না কেউ abort গুলো উপেক্ষা করতে শুরু করে। **সংবেদনশীলতা আর মিথ্যা alarm এর মধ্যে একটা টান আছে, আর সীমাটা ইচ্ছা করে বাছতে হয়।** (বারবার দেখার এই সমস্যার জন্য পরিসংখ্যানে "sequential testing" এর পদ্ধতি আছে - এখানে মাপা না।)

### ১.১০ TaskFlow এর সিদ্ধান্ত

> **Trade-off Table - fault tolerance এর যন্ত্র**

| যন্ত্র                  | কোন fault এর বিরুদ্ধে      | মাপা (exercise)                                     | দাম                                                           |
| ----------------------- | -------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Hard → soft dependency  | একটা অংশ মরা বা ধীর        | Board ৩,৬৮০ → ০ মিনিট পুরো বন্ধ/বছর                 | প্রতিটা fallback এর নকশা আর পরীক্ষা; timeout ছাড়া কাজ করে না |
| Redundancy (copy)       | স্বাধীন failure            | Instance এর কারণে ৩৪৩ → ৬ মিনিট/বছর                 | Correlated failure এ (AZ, deploy) প্রায় কিছুই না             |
| Failure domain এ ছড়ানো | AZ এর মতো ভাগ করা ঝুঁকি    | AZ এর কারণে ৮২ → ০                                  | AZ এর মধ্যে network এর দেরি আর খরচ (10.7, 10.8)               |
| ধীরে deploy             | খারাপ version              | Deploy এর কারণে ৭২ → ৩৭ (ধরা গেলে); না ধরা গেলে ১৪৭ | Deploy ধীর; লাভ পুরোটাই দ্রুত ধরার উপর                        |
| Brownout                | নিজের ক্ষমতার বেশি চাপ     | Board পেল ০% → ১০০%                                 | কেউ পুরো page পায় না; ঐচ্ছিক অংশ আগে চিহ্নিত করতে হয়        |
| Load shedding           | Brownout এর তলার নিচের চাপ | ৬৪% পায়, দ্রুত                                     | বাকিরা কিছুই পায় না                                          |
| Static stability        | Control plane মরা          | ৪৪% → ০.২৪% ব্যর্থ                                  | Outage এর সময় কিছু বদলানো যায় না (kill switch সহ)           |
| Chaos experiment        | যে দুর্বলতা কেউ জানে না    | ০.১% + control: সূক্ষ্ম bug ৬.২ মিনিটে, ৯টা ক্ষতিতে | Production এ সত্যিকারের ঝুঁকি; মিথ্যা abort; team এর সময়     |

**Dependency map:** প্রতিটা user journey এর hard আর soft dependency এর একটা তালিকা, code এর পাশে রাখা - আর exercise এর মতো একটা **fault injection test** CI তে: integration test এ প্রতিটা dependency কে একবার মেরে, একবার ধীর করে journey চালানো, আর matrix টা একটা প্রত্যাশিত matrix এর সাথে মেলানো। কেউ board এ নতুন hard dependency যোগ করলে test ভাঙবে - merge এর আগে, শনিবার রাতের আগে না।

**কোডের নিয়ম:**

- প্রতিটা বাইরের call এ timeout, আর journey এর মোট সময়সীমা ভেতরের call গুলোকে পাঠানো (deadline)। Timeout এর মান journey এর বাজেট থেকে আসে, library এর default থেকে না।
- **Commit এর পরে কোনো hard কাজ না।** Cache invalidate soft (ব্যর্থ হলে TTL ৫ মিনিটে ঠিক হয় - 10.1); comment এর email outbox এ (7.5)। `✗!` এর দুটো ঘর বন্ধ।
- Board আর share link: replica মরলে primary থেকে, কিন্তু সেই পথে আলাদা ৮টা connection এর সীমা (bulkhead - 9.4)। Search এ fallback নেই - "search এখন পাওয়া যাচ্ছে না" banner।
- Plan badge, comment সংখ্যা, activity panel - soft, ১৫০–৩০০ ms timeout, না পেলে লুকানো।

**Flags আর config (static stability):** প্রতিটা flag এর একটা default code এ। App নিজের memory তে last-known-good রাখে, প্রতি সফল fetch এর পরে disk এ snapshot, আর deploy এর সময় সেই মুহূর্তের snapshot image এ। Boot এ `flags` না পেলে snapshot, তাও না পেলে code এর default - **কখনো crash না।** Refresh background এ, jitter সহ (সবাই একসাথে না - 7.4)। Metric: config এর বয়স; ১০ মিনিটের বেশি পুরনো হলে alert (কারণ বয়স নিজে কোনো ক্ষতি করে না, কিন্তু সে বলে control plane মরা)। জরুরি kill switch - যেমন "নতুন panel বন্ধ" - একটা environment variable ও, যা deploy দিয়ে বদলানো যায়। Patroni তে `failsafe_mode` এর সিদ্ধান্ত database team এর সাথে, 6.1 এর split brain এর ঝুঁকি মেপে।

**Brownout:** board এর অংশগুলোর তিনটা ধাপ, product এর সাথে লেখা - ধাপ ১ "এরকম আরও board" বন্ধ, ধাপ ২ activity panel, ধাপ ৩ comment সংখ্যা। Controller স্বয়ংক্রিয় (queue এর অপেক্ষা ধরে), সাথে on-call এর জন্য হাতে ধাপ বসানোর একটা সুইচ। শেষ জাল হিসেবে gateway এ load shedding (7.4), আর প্রতিটা worker কাজ শুরুর আগে deadline দেখে।

**Deploy:** একটা একটা করে, প্রতিটার পরে ১০ মিনিট দেখা, error rate বাড়লে স্বয়ংক্রিয় rollback (বিস্তারিত 10.6)। App instance তিনটা AZ এ।

**Chaos program:** মাসে একবার game day - প্রথম চারটা: `flags` মরা, billing ধীর, একটা cache node মরা (10.1 এর ring), একটা replica মরা। তারপর সপ্তাহে স্বয়ংক্রিয় experiment: ১% traffic, সমান control group, z > ৩, steady state ভাঙলে abort, কাজের সময়ে, আর কোনো চলমান incident থাকলে না। প্রথম experiment এর hypothesis: "billing ২ s ধীর হলে board এর সফলতা ৯৯.৯% এর উপরে থাকবে, শুধু plan badge লুকাবে।" আজকের matrix অনুযায়ী আগের code এ এটা ব্যর্থ হতো - আর সেটাই experiment এর মূল্য।

---

## ২. Interview Angle

Fault tolerance প্রায় কখনো নিজে প্রশ্ন হয়ে আসে না - আসে প্রতিটা design এর শেষের দিকে, interviewer এর একটা ছোট প্রশ্নে: **"এখন যদি X মরে যায়?"** আপনার design এর প্রতিটা বাক্সের জন্য এই প্রশ্ন আসতে পারে, আর ভালো উত্তরের একটা আকৃতি আছে:

1. **কোন journey এর hard dependency এটা?** "Cache মরলে read DB তে যাবে - read এর soft dependency; কিন্তু DB এর ক্ষমতা কি cache ছাড়া পুরো traffic নিতে পারে? না পারলে cache আসলে hard।" (শেষ অংশটা 4.6 এর cache avalanche - অনেকে ভুলে যায়।)
2. **Degraded অবস্থায় user কী দেখে?** "Recommendation service মরলে feed দেখাবে, recommendation এর জায়গায় জনপ্রিয় post এর একটা static তালিকা।" কিছু না দেখানো, পুরনো দেখানো, পরে করা - কোনটা।
3. **ধীর হলে কী?** "প্রতিটা call এ timeout, আর মোট deadline" - এই বাক্যটা না বললে interviewer প্রায় নিশ্চিত follow-up করবে।
4. **Redundancy এর কথা বললে failure domain।** "তিনটা replica" এর পরে "তিনটা আলাদা AZ এ, আর deploy একটা একটা করে" - এটাই senior উত্তর।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"৯৯.৯৯% availability চাই - আপনার design এ কীভাবে আসবে?"_ - journey এর hard dependency গুলো গুনে গুণ করুন: পাঁচটা ৯৯.৯% এর dependency মানে ৯৯.৫% - লক্ষ্য থেকে বহু দূরে। উত্তর বেশি nine এর dependency না, কম hard dependency। এই অঙ্কটা মুখে করে দেখাতে পারা একটা শক্তিশালী সংকেত।
- _"Load shedding আর graceful degradation এর পার্থক্য?"_ - shedding request এর **সংখ্যা** কমায় (কেউ কিছু পায় না), degradation/brownout প্রতি request এর **খরচ** কমায় (সবাই কম পায়)। ভালো উত্তরে দুটো স্তর হিসেবে আসে।
- _"Config service মরলে?"_ - static stability: last-known-good, disk এ snapshot, boot এ crash না; আর দামটা - outage এর সময় config বদলানো যায় না।
- _"Chaos engineering কি production এ করা নিরাপদ?"_ - blast radius ছোট, control group, স্বয়ংক্রিয় abort, কাজের সময়ে; আর উল্টো প্রশ্ন: না করা কি নিরাপদ? দুর্বলতা তো আছেই - প্রশ্ন শুধু কে আগে খুঁজবে, আপনি না রাত ২টা।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ভুলগুলো - "অগুরুত্বপূর্ণ" internal service (config, flags, auth key, metrics agent) কে hard dependency বানিয়ে ফেলা, কারণ তাকে পড়ার code এ কোনো default নেই; timeout ছাড়া fallback লেখা (যেটা ধীর dependency তে কখনো চলে না); commit এর পরে একটা hard কাজ, যার ব্যর্থতায় user আবার চাপে আর duplicate হয়; তিনটা replica একই AZ এ, একসাথে deploy; cache এর TTL শেষে "নতুন না পেলে error", যাতে control plane এর outage কয়েক মিনিট পরে পুরো fleet একসাথে মারে; আর একবার পরীক্ষা করা degradation কখনো আবার পরীক্ষা না করা, যতক্ষণ না কেউ একটা নতুন hard dependency যোগ করে।

---

## ৩. Key Takeaway

- **Fault ঠেকানো যায় না; fault থেকে failure এর শিকল ভাঙা যায়** - copy দিয়ে fault লুকিয়ে, timeout/breaker দিয়ে error আটকে, আর degradation দিয়ে failure ছোট করে
- **একটা journey এর availability তার hard dependency গুলোর গুণফল** - board এর তিনটা (৯৯.৫, ৯৯.৯, ৯৯.৯) মানে ৯৯.৩০১%, বছরে ৬১ ঘণ্টা; hard dependency সরানো (board: ৩ → ০) dependency কে বেশি nine দেওয়ার চেয়ে প্রায়ই সস্তা আর বেশি কার্যকর
- **সবচেয়ে বিপজ্জনক dependency প্রায়ই সবচেয়ে "অগুরুত্বপূর্ণ" টা** - flags কে পড়ার একটা default-হীন line সাতটা journey এর প্রতিটাকে ভেঙেছে; আর commit এর পরের hard কাজ (`✗!`) user কে duplicate বানাতে ঠেলে দেয়
- **ধীর, মরার চেয়ে খারাপ - আর timeout ছাড়া soft dependency আসলে hard।** মরা limiter fail open হয়, ধীর limiter পাঁচটা journey কে ৩ s আটকায়
- **Redundancy এর সূত্র স্বাধীন failure ধরে** - ৩টা copy তে সূত্র বছরে ০.০১১ সেকেন্ড, মাপা ১৬০ মিনিট, কারণ AZ আর deploy তিনটাকে একসাথে মারে; failure domain এ ছড়ান, ধীরে deploy করুন - আর ধীর deploy তখনই লাভ যখন ছড়ানোর আগে ধরা যায় (না হলে ৭২ → ১৪৭)
- **চাপের সময় brownout সবাইকে core কাজ দেয় (০% → ১০০%), load shedding কাউকে কিছুই দেয় না (৩৬%), আর কিছু না করলে চাপ চলে যাওয়ার পরেও system মৃত** (১০০% নষ্ট কাজ); brownout প্রথম স্তর, shedding শেষ জাল, deadline check সবসময়
- **Static stability: control plane মরলে data plane শেষ জানা অবস্থায় চলে, restart আর নতুন instance সহ** - last-known-good + snapshot এ ৪৪% → ০.২৪% ব্যর্থ; দাম, outage এর সময় কিছু বদলানো যায় না
- **Chaos engineering = steady state ঘিরে hypothesis, ছোট blast radius, control group, স্বয়ংক্রিয় abort** - ০.১% এ global alarm সূক্ষ্ম bug কখনো দেখে না, control group দেখে ৯টা ক্ষতিতে; বড় blast radius দ্রুত ধরে না, শুধু বেশি মানুষকে আঘাত করে

---

## ৪. নতুন Term (Glossary)

| Term                                | অর্থ                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fault Tolerance** (fault/failure) | একটা অংশের ত্রুটি (fault) কে user এর দেখা ব্যর্থতায় (failure) পৌঁছাতে না দেওয়ার ক্ষমতা - copy দিয়ে fault লুকিয়ে, error আটকে, বা failure ছোট করে                              |
| **Hard / Soft Dependency**          | Hard: না থাকলে journey ব্যর্থ; soft: না থাকলে journey চলে, কিছু বাদ দিয়ে - ঠিক করে code, dependency না; journey এর availability ≈ hard dependency গুলোর availability এর গুণফল   |
| **Graceful Degradation**            | Dependency মরলে বা ধীর হলে আগে থেকে নকশা করা কম-কিন্তু-কাজের অবস্থায় চলা - বাদ দেওয়া, পুরনো data, বিকল্প পথ, পরে করা, বা স্পষ্ট "এখন না"; timeout ছাড়া কাজ করে না             |
| **Brownout**                        | চাপের সময় প্রতিটা request এর ঐচ্ছিক অংশ স্বয়ংক্রিয়ভাবে বন্ধ করে প্রতি request এর খরচ কমানো, যাতে সবাই core কাজ পায়; load shedding সংখ্যা কমায়, brownout খরচ                 |
| **Static Stability**                | Control plane (config, flag, registry, orchestration) মরলেও data plane শেষ জানা অবস্থায় চলতে থাকা - restart আর নতুন instance সহ; দাম: সেই সময়ে কিছু বদলানো যায় না             |
| **Chaos Engineering**               | Production এ ইচ্ছা করে, নিয়ন্ত্রিতভাবে fault ঢুকিয়ে steady state এর একটা hypothesis পরীক্ষা করা - ছোট blast radius, control group, স্বয়ংক্রিয় abort, নিয়মিত                 |
| **Blast Radius**                    | একটা fault সর্বোচ্চ কতটা জুড়ে প্রভাব ফেলে (কত % traffic, কতজন user, কয়টা service/region) - experiment এ ইচ্ছা করে ছোট রাখা হয়, আর নকশায় (AZ, bulkhead, cell) ছোট রাখা লক্ষ্য |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এ নতুন একটা journey আসছে: **"board PDF এ export"।** প্রথম নকশায় user বোতাম চাপে, আর একই request এ: gateway (৯৯.৯৫%) → replica থেকে board পড়া (৯৯.৯%) → একটা নতুন PDF rendering service (৯৯.৫%, একটা instance) → PDF object storage এ রাখা (৯৯.৯৯%) → email provider দিয়ে link পাঠানো (৯৯.৫%) → user কে "পাঠানো হয়েছে"। (ক) সবগুলো hard ধরে journey এর availability কত, বছরে কত ঘণ্টা বন্ধ? (খ) কোন dependency গুলোকে journey থেকে সরানো যায় - কীভাবে, আর user এর অভিজ্ঞতা কীভাবে বদলায়? (গ) নতুন নকশায় user-facing অংশের availability কত? কোন জিনিসটা এখন "ব্যর্থতা" থেকে "দেরি" হয়ে গেল, আর তার জন্য কী মাপবেন?

2. 9.2 থেকে gateway প্রতিটা request এ user এর JWT যাচাই করে, identity service এর public key দিয়ে - key গুলো gateway প্রতি ১০ মিনিটে identity থেকে টানে (JWKS)। (ক) Identity service দুই ঘণ্টা মরা থাকলে এখনকার নকশায় কী ঘটে, মিনিট ধরে? মাঝে gateway এর একটা instance restart নিলে? (খ) একটা statically stable নকশা দিন। Key rotation (পুরনো key বাদ দিয়ে নতুন key) এর সাথে এটা কীভাবে মেলাবেন, যাতে পুরনো key set ও কাজ করে? (গ) কোন একটা জিনিস আপনি এই নকশায় হারাচ্ছেন - আর সেটা কোন পরিস্থিতিতে সত্যিকারের নিরাপত্তা ঝুঁকি?

3. TaskFlow এর প্রথম production chaos experiment এর পরিকল্পনা লিখুন: **"cache ring এর একটা Redis node মরা"** (10.1)। (ক) Steady state কোন সংখ্যা দিয়ে মাপবেন - আর কোন সংখ্যা **না**? (খ) Hypothesis। (গ) Blast radius কীভাবে ছোট রাখবেন - একটা cache node মারা কি "১% traffic" এর মতো ভাগ করা যায়? (ঘ) Abort এর শর্ত, আর কে বা কী abort করবে। (ঙ) 10.1 থেকে আপনি জানেন এই experiment এ কী কী ভুল হতে পারে - অন্তত দুটো বলুন, আর কোনটা experiment টাকেই একটা outage বানিয়ে ফেলতে পারে।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) সবগুলো hard, স্বাধীন ধরে:

```
0.9995 × 0.999 × 0.995 × 0.9999 × 0.995
= 0.9985005 × 0.995 × 0.9999 × 0.995
≈ 0.98844  →  ৯৮.৮৪%
বছরে বন্ধ: (1 − 0.98844) × ৮,৭৬০ ঘণ্টা ≈ ১০১ ঘণ্টা
```

দুটো ৯৯.৫% এর dependency ই প্রায় পুরো ক্ষতি - বাকি তিনটা মিলে ০.১৬%। আর PDF rendering একটা instance - এক ঘণ্টার deploy বা crash মানে এক ঘণ্টা export বন্ধ।

(খ) User এর আসল চাওয়া "PDF টা পেতে চাই", "এখনই, এই request এর ভেতরেই" না। তাই:

- বোতাম চাপলে একটা `export` row (`pending`) আর একটা outbox event, একই transaction এ (7.5) - শুধু primary লাগে। User কে সাথে সাথে "তৈরি হচ্ছে - শেষ হলে email আর notification পাবে"।
- একটা worker (7.3) event নিয়ে replica থেকে পড়ে, PDF service কে ডাকে, object storage এ রাখে, row `ready` করে, email এর job দেয়। প্রতিটা ধাপ retry সহ (backoff + jitter, 7.4), idempotent (export id ধরে)।
- Page এ export এর তালিকা থাকে, যেখানে `ready` হলে download link - email না এলেও user পায়। Email এখন soft: শুধু একটা খবর পৌঁছানোর পথ।

(গ) User-facing অংশ: gateway × primary (row আর outbox লেখা) = ০.৯৯৯৫ × ০.৯৯৯৫ ≈ **৯৯.৯০%**, বছরে ~৯ ঘণ্টা (আগে ১০১)। PDF service, replica, object storage, email - কোনোটার মৃত্যু এখন আর **ব্যর্থতা** না, **দেরি**: PDF service এক ঘণ্টা মরা থাকলে export এক ঘণ্টা দেরিতে আসে, কিন্তু কেউ error দেখে না। দেরির জন্য নতুন metric লাগে: `pending` থেকে `ready` এর সময় (p50, p99), সবচেয়ে পুরনো `pending` export এর বয়স (একটা stuck job এর সংকেত), DLQ তে কতগুলো (7.4)। আর একটা সীমা: ধরুন ২৪ ঘণ্টায় `ready` না হলে `failed` আর user কে স্পষ্ট বার্তা - "দেরি" কে চিরকালের "দেরি" হতে না দেওয়া।

**প্রশ্ন ২:**

(ক) এখনকার নকশা আসলে exercise এর "TTL cache" সারি: key গুলো ১০ মিনিটের cache, শেষে নতুন না পেলে যাচাই করতে পারে না। মিনিট ০–১০: সব ঠিক। মিনিট ~১০: cache এর মেয়াদ শেষ - gateway কোনো token যাচাই করতে পারে না → প্রতিটা authenticated request 401। User দের চোখে: সবাই হঠাৎ "logged out", আবার login করতে চায় - কিন্তু login identity তেই, সেটাও মরা। কার্যত পুরো site দুই ঘণ্টা বন্ধ, যদিও শুধু identity মরেছে। মাঝে gateway restart নিলে: boot এ JWKS টানে, পায় না - ভালো ক্ষেত্রে key ছাড়া উঠে সব 401, খারাপ ক্ষেত্রে crash loop (exercise এর ৪৬৩টা ব্যর্থ boot)।

(খ) Statically stable নকশা:

- Gateway শেষ জানা key set মনে রাখে, **মেয়াদ শেষ হলেও** - নতুন না পেলে পুরনোটাই চালায়, আর একটা metric (key set এর বয়স) alert দেয়।
- প্রতিটা সফল fetch এর পরে key set disk এ snapshot, আর deploy এর সময় image এ; boot এ identity না পেলে snapshot।
- **Key rotation কে এর সাথে মেলানো:** নতুন key **আগে প্রকাশ** করা (ধরুন ব্যবহার শুরুর ২৪ ঘণ্টা আগে JWKS এ যোগ), আর পুরনো key বাদ দেওয়া **পরে** (শেষ token এর মেয়াদ শেষ হওয়ার পরে)। তাহলে যেকোনো মুহূর্তের key set এ সামনের আর পেছনের key দুটোই থাকে, আর কয়েক ঘণ্টা পুরনো snapshot ও নতুন token যাচাই করতে পারে। Rotation টা নিজেই একটা static stability এর নকশা।
- Outage এর সময় যা চলে: যাদের token আছে তারা কাজ চালিয়ে যায়। যা চলে না: নতুন login (identity তো লাগেই) - এটা স্পষ্টভাবে "এখন না", পুরো site না।

(গ) হারাচ্ছেন **জরুরি revoke।** ধরুন একটা signing key ফাঁস হয়েছে, আর ঠিক সেই সময়ে identity মরা - আপনি JWKS থেকে key টা সরাতে পারবেন না, কারণ gateway সেটা শুনবে না; সে শেষ জানা (ফাঁস হওয়া key সহ) set চালাবে। এই সময়ে আক্রমণকারী ফাঁস হওয়া key দিয়ে token বানাতে পারে। এর জন্য একটা আলাদা, সরল পথ রাখা উচিত - ধরুন gateway এর config এ একটা "নিষিদ্ধ key id" এর তালিকা, যা deploy দিয়ে বদলানো যায়, identity ছাড়াই। (১.৭ এর kill switch এর যুক্তি, নিরাপত্তায়।) আর এটা একটা বিরল ঘটনার যোগফল (key ফাঁস **এবং** identity outage একসাথে) - সেজন্য সবকিছু বিসর্জন দেওয়ার মানে নেই, কিন্তু runbook এ লেখা থাকা দরকার।

**প্রশ্ন ৩:**

(ক) **Steady state:** user যা পায় - board খোলার সফলতা (৯৯.৯৫%), board এর p99 (৩০০ ms), আর এই experiment এর জন্য বিশেষভাবে **primary আর replica এর query/s** (কারণ cache node মরার আসল ঝুঁকি DB তে যাওয়া চাপ - 10.1 এর পুরো গল্প)। **যা না:** cache এর hit rate নিজে steady state না - node মরলে সেটা কমবেই, সেটা প্রত্যাশিত; প্রশ্ন হলো user সেটা টের পায় কিনা। CPU, memory ও না।

(খ) **Hypothesis:** "Ring এর একটা node (১৬০ vnode এর একটা) মরলে ৩০ সেকেন্ডে সে ring থেকে বাদ যাবে (10.1 এর নিয়ম); তার key গুলো বাকি node এ ছড়াবে, single-flight এর কারণে DB এর query/s এর বৃদ্ধি স্বাভাবিকের দ্বিগুণের নিচে থাকবে, board এর সফলতা ৯৯.৯% এর উপরে, p99 ৫০০ ms এর নিচে - আর node ফেরার সময় FLUSHALL এর পরে ফিরবে, পুরনো data দেখাবে না।"

(গ) **Blast radius:** একটা cache node মারা traffic এর % দিয়ে ভাগ করা কঠিন - একটা node মরলে তার key গুলোর সব request প্রভাবিত, আর ring এ সব instance একই ring দেখে। ছোট রাখার পথ: (১) সবচেয়ে কম ব্যস্ত সময়ে; (২) সবচেয়ে ছোট weight এর node (যদি আছে), বা আগে একটা node কে weight কমিয়ে "নরম" বাদ দেওয়া - তারপর পুরো মারা; (৩) প্রথমে একটা মাত্র app instance এর জন্য ring থেকে node টা বাদ দেওয়া (সেই instance এর client এর ভেতরে fault ঢোকানো) - তাহলে blast radius = সেই instance এর traffic, ধরুন ১/৬, আর বাকি ৫টা control group। এটাই "১% traffic" এর cache এর রূপ: fault ঢোকান client এ, server এ না।

(ঘ) **Abort এর শর্ত:** board এর সফলতা ৯৯.৮% এর নিচে, বা p99 ৮০০ ms এর উপরে, বা primary এর CPU ৭০% এর উপরে, যেকোনো একটা ৩০ সেকেন্ড ধরে → **স্বয়ংক্রিয়ভাবে** node ফেরানো বা client এর fault সরানো। মানুষের হাতে ছাড়া হবে না - 10.1 এ দেখেছেন membership বদলের প্রথম সেকেন্ডেই DB এর চাপ বাড়ে; মানুষ এত দ্রুত না। আর experiment চলাকালীন অন্য কোনো deploy বা incident থাকলে শুরুই হবে না।

(ঙ) **কী ভুল হতে পারে (10.1 থেকে):**

- **Single-flight সব জায়গায় নেই।** কোনো একটা endpoint যদি single-flight ছাড়া cache miss এ DB তে যায়, তাহলে মরা node এর গরম key গুলোর জন্য একসাথে অনেক DB query (4.6 এর stampede) - DB এর চাপ লাফ দেয়। **এটাই experiment কে outage বানাতে পারে:** cache এর একটা node এর ক্ষতি DB তে পৌঁছায়, আর DB সবার hard dependency। Abort এর primary CPU শর্তটা এই জন্য।
- **Membership সবাই একই সময়ে দেখে না** - কিছু instance node কে বাদ দিয়েছে, কিছু দেয়নি (registry এর version, 10.1)। কিছুক্ষণ একই key দুই node এ, আর node ফেরার সময় FLUSHALL না হলে পুরনো data।
- **Hot key:** মরা node এ যদি একটা খুব গরম board এর key থাকে, সেটা যে নতুন node এ যায় সেখানে চাপ জমে (10.1 এর hot key) - সেই node ধীর হলে তার সব key এর latency বাড়ে।
- **ফেরার পথটাও experiment এর অংশ** - node ফেরার পরে key গুলো আবার সরে, আবার miss এর ঢেউ। অনেক experiment শুধু মারার অংশ দেখে, ফেরার অংশে outage হয়।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (পাঁচটা script, সবগুলো deterministic simulation; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.3-fault-tolerance/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.3-fault-tolerance) - `npm install`, তারপর `npm run matrix`, `npm run redundancy`, `npm run brownout`, `npm run static`, `npm run chaos`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`matrix` TaskFlow এর সাতটা journey কে দুইভাবে লেখা code এ চালায় - আগের code আর degradation মাথায় রেখে লেখা code - প্রতিটা dependency কে একবার মেরে, একবার ধীর করে; তারপর ১০ বছরের simulated outage এ availability মাপে। `redundancy` তিনটা copy এর সূত্রকে instance, AZ আর deploy এর failure এর সামনে রাখে। `brownout` সোমবার সকালের ভিড়ে পাঁচটা নীতি পাশাপাশি চালায়। `static` control plane এর ৪৫ মিনিটের outage এ চারটা config নকশা, crash আর autoscale সহ। `chaos` blast radius আর দুই রকম abort এর নিয়ম মাপে - জোরালো bug, সূক্ষ্ম bug, আর নিরীহ fault।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` আর ESLint clean; পাঁচটা script দুবার করে, প্রতিবার output হুবহু এক (byte ধরে মেলানো)। **কোনো script এ network, DB, Redis বা আসল সময় নেই** - dependency মানে একটা নাম আর একটা latency সংখ্যা, সব latency **হিসাব করা**, মাপা না। Journey গুলো আসল TypeScript function, আর matrix সেগুলো চালিয়ে বের হয় - কিন্তু সেগুলো TaskFlow এর **নকশার** প্রতিনিধি, কোনো আসল codebase না। সব সংখ্যা ধরে নেওয়া parameter থেকে (instance ৩০ দিনে একবার মরে, AZ বছরে আধাবার, ৩% deploy খারাপ, board এর অংশের worker সময়) - এগুলো বিশ্বাসযোগ্য আন্দাজ, কোনো আসল system এর মাপা না; script গুলো দেখায় **সম্পর্ক**, আর প্রতিটা parameter environment variable দিয়ে বদলানো যায়। `matrix` এর availability শুধু নয়টা dependency ধরে, স্বাধীন failure ধরে নিয়ে। `brownout` একটা M/G/c FIFO queue, controller সরল। `chaos` এর control group একটা সরলীকৃত z-test। **যা মাপা হয়নি:** কোনো আসল chaos tool (Chaos Monkey, Gremlin, Litmus বা অন্য), আসল Patroni এর `failsafe_mode`, gRPC এর deadline propagation, LIFO queue, sequential testing। ১.৫ এর Google SRE বই এর ৭০%, ১.৬ এর brownout এর গবেষণা আর Facebook এর লেখা, ১.৭ এর Amazon এর লেখা আর Patroni এর আচরণ, ১.৮–১.৯ এর Netflix এর Chaos Monkey আর ChAP - তাদের প্রকাশিত লেখা আর documentation থেকে, এখানে যাচাই করা না। ১.১০ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `matrix` চালানোর **আগে** `src/journeys.ts` এর `asWritten` পড়ুন, আর নিজে matrix এর অংশ ক আর গ ভরুন - প্রতিটা ঘরে ✓, ~, ✗ না ✗!। তারপর চালিয়ে মেলান। কোন ঘরগুলো ভুল হলো? সেগুলোই code review এ ধরা পড়ে না - আর সেজন্যই chaos experiment লাগে।

2. **নিজের journey:** `journeys.ts` এ একটা নতুন journey যোগ করুন - "board PDF export" (প্রশ্ন ১ এর প্রথম নকশা) - আর `deps.ts` এ একটা `pdf` dependency। `asWritten` এ সব synchronous, `designed` এ প্রশ্ন ১ এর async নকশা। `matrix` এ দুটোর availability মেলান উত্তরের অঙ্কের সাথে।

3. **Brownout এর সীমা:** `PEAK=12 npm run brownout`, তারপর `BROWNOUT_WAIT=200 npm run brownout`। প্রথমটায় কোন নীতি সবচেয়ে বেশি user কে board দেয়, আর কেন brownout একা যথেষ্ট না? দ্বিতীয়টায় "পুরো page" আর p99 এর মধ্যে কী বিনিময় হলো? TaskFlow এর জন্য কোন threshold বাছবেন, আর সেটা কার সিদ্ধান্ত?

4. **Static stability আর TTL:** `TTL=1800 npm run static`। TTL ৩০ মিনিট হলে কী বাঁচল, কী বাঁচল না? এবার `OUTAGE_TO=50 TTL=1800 npm run static` - ২০ মিনিটের outage এ ৩০ মিনিটের TTL ই কি যথেষ্ট? তাহলে last-known-good এর পক্ষে আসল যুক্তি কী - outage কতক্ষণ চলবে, সেটা কি আগে থেকে জানা যায়?

5. **Design অংশ:** TaskFlow এর মোবাইল app এ একটা "offline mode" এর প্রস্তাব এসেছে - network না থাকলে user শেষ দেখা board দেখবে, task তৈরি করতে পারবে, আর network ফিরলে sync হবে। এক পাতার plan: (ক) এটা কোন fallback এর ধরন (১.৪ এর টেবিল) - নাকি একাধিক? (খ) মোবাইল app এর কাছে "control plane" কী, আর static stability এর প্রশ্নটা এখানে কেমন দেখায়? (গ) Offline এ তৈরি task sync এর সময় কী কী conflict হতে পারে (6.4 এর vector clock, sibling মনে করুন), আর কোনগুলো আপনি স্বয়ংক্রিয়ভাবে মেলাবেন? (ঘ) কোন কাজ offline এ ইচ্ছা করে **বন্ধ** রাখবেন, আর কেন? (ঙ) এই feature এর জন্য একটা chaos experiment কেমন হবে?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ), 10.1, 10.2
Current: 10.3 - Fault tolerance, graceful degradation, chaos engineering
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limit
দুই স্তরে; cache ring (১৬০ vnode); share link এ Bloom filter, active user HLL এ। শনিবার রাতে flags
service (একটা instance, কারও তালিকায় নেই) মরে - TTL cache সবার একসাথে শেষ, পুরো site ৫০ মিনিট বন্ধ,
restart এ crash loop; সোমবার সকালে ২.৫ গুণ ভিড় + দামি "এরকম আরও board" panel → সব board timeout, ভিড়
শেষেও queue এ মৃত কাজ। এখন: প্রতিটা journey এর hard/soft dependency এর তালিকা + CI তে fault injection
test (matrix); প্রতিটা call এ timeout + deadline; commit এর পরে hard কাজ নেই (cache invalidate soft,
comment email outbox এ); billing/replica board এর soft (badge, সংখ্যা, panel লুকানো), replica মরলে
board/share primary থেকে (৮ connection এর bulkhead), search এ "এখন না"; flags: code এ default + memory তে
last-known-good + disk/image এ snapshot, boot এ কখনো crash না, refresh jitter সহ, config এর বয়স এর alert,
জরুরি kill switch env var এও; Patroni failsafe_mode এর সিদ্ধান্ত বাকি; brownout এর তিন ধাপ (recommendation
→ activity panel → comment সংখ্যা), স্বয়ংক্রিয় + হাতের সুইচ, gateway এ shedding শেষ জাল, worker এ deadline
check; deploy একটা একটা করে, ১০ মিনিট দেখা, স্বয়ংক্রিয় rollback, তিনটা AZ; chaos: মাসে game day, সপ্তাহে
১% + control group, z > 3, স্বয়ংক্রিয় abort, কাজের সময়ে
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 10.4 - Observability: logging, metrics, tracing
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **fault আসবেই - প্রশ্ন শুধু কোনটা failure হবে, আর সেটা কে ঠিক করে: নকশা, নাকি দুর্ঘটনা।** একটা journey এর availability তার hard dependency গুলোর গুণফল, তাই সবচেয়ে বড় লাভ আসে hard dependency কে soft বানিয়ে - একটা default, একটা timeout, একটা আগে থেকে ঠিক করা "খারাপ কিন্তু চলছে"। Copy রাখা শুধু স্বাধীন failure এর ওষুধ; চাপের সময় কম কাজ করা কাউকে ফিরিয়ে দেওয়ার চেয়ে ভালো; আর control plane এর উপর data plane এর নির্ভরতা এমন একটা ফাঁদ যেটা শুধু outage এর মধ্যে restart এর সময় দেখা যায়। আর এই সবকিছু যে কাজ করে, জানার একমাত্র উপায় ইচ্ছা করে ভাঙা - ছোট পরিসরে, তুলনা করে।

কিন্তু আজকের প্রতিটা অংশে একটা জিনিস চুপচাপ ধরে নেওয়া হয়েছে: যে আমরা **দেখতে পাই** কী ঘটছে। Brownout এর controller queue এর অপেক্ষা মাপে; chaos experiment এর abort error rate মাপে; static stability এর alert config এর বয়স মাপে; আর শনিবার রাতে on-call engineer ২৫ মিনিট `flags` কে খুঁজে পায়নি, কারণ কোনো graph তাকে সেদিকে দেখায়নি। রেডি হলে `next` লিখুন - **Lesson 10.4: Observability - Logging, Metrics, Tracing** এ যাব। সেখানে প্রশ্নটা: একটা request যখন gateway, BFF, monolith, billing, cache আর database ছুঁয়ে আসে, তখন "কেন ধীর" এর উত্তর কোথায় খুঁজবেন - আর log, metric আর trace এর প্রতিটা কোন প্রশ্নের উত্তর দেয়, কোনটার দেয় না।
