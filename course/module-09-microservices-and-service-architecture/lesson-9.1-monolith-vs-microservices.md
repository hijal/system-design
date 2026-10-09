# Lesson 9.1 - Monolith vs Microservices: কখন ভাঙবেন, কখন না

**Module 9 - Microservices & Service Architecture**

> **Spaced Repetition (Lesson 1.5):** একটা request এর পথে দুটো component পরপর (serial) আছে - দুটোই লাগবে - আর প্রতিটা আলাদাভাবে 99.9% available। পুরো পথটা কত available? আর দুটো পাশাপাশি (parallel, যেকোনো একটা থাকলেই চলে) থাকলে? আজ প্রশ্নটা ফিরবে - এবার আপনার নিজের app এর ভেতরে, service গুনে গুনে।

**Prerequisite:** Lesson 1.5 (Availability), Lesson 1.6 (Scaling), Lesson 2.5 (API versioning), Lesson 3.4 (Deploy, graceful shutdown), Lesson 5.5 (Transaction), Lesson 5.6 (N+1), Lesson 6.1 (Partial failure), Lesson 7.1 (Cascading failure, event loop), Lesson 7.5 (Outbox, event), Lesson 8.3 (Search index - database এর কপি)

**আপনি এই lesson শেষে পারবেন:**

1. একটা monolith কে microservices এ ভাঙার তিনটা দাম - network call, ছড়ানো ব্যর্থতা, আর হারানো transaction - মাপা সংখ্যা দিয়ে বলতে পারবেন, আর প্রতিটার বিরুদ্ধে কী লাগে (batched API, timeout + fallback, saga/outbox) জানবেন
2. Microservices আসলে কোন সমস্যার সমাধান (অনেক team, আলাদা deploy, আলাদা scale) আর কোনটার না ("app ধীর") - Conway's Law দিয়ে ব্যাখ্যা করতে পারবেন
3. একটা সিদ্ধান্ত নিতে পারবেন: monolith, modular monolith, নাকি একটা নির্দিষ্ট service বের করা - boundary কোথায় (bounded context), আর distributed monolith এর লক্ষণ চিনে

**Tier:** 1 - Runnable Code (আলাদা Node process গুলো আলাদা service - function call বনাম network call, crash আর timeout; আর Docker এ Postgres, এক database বনাম database per service)

---

## ০. TaskFlow এখন কোথায়

Module 8 শেষে TaskFlow এর চারপাশে অনেক system: Postgres primary আর replica, Redis, BullMQ, object storage, CDN, search। কিন্তু TaskFlow এর **code** এখনো একটা: একটা Express app, একটা repo, একটা deploy pipeline, ৬টা একই রকম instance। Task, comment, user, workspace, billing, notification, attachment, search - সব এক জায়গায়।

এর মধ্যে engineering team ৬ জন থেকে ৩০ জন, পাঁচটা team এ ভাগ। আর এক মাসে তিনটা ঘটনা:

1. **Deploy এর লাইন।** দিনে ৪০টা PR, একটা pipeline, ৪৫ মিনিটের test। শুক্রবার billing team এর একটা change এ bug - পুরো deploy rollback, আর তার সাথে tasks team এর একটা জরুরি fix ও ফিরে গেল। Tasks team এর lead: "অন্যের bug এর জন্য আমাদের fix আটকায় কেন?"
2. **সোমবার সকাল।** Billing team নতুন feature ছাড়ল: finance এর জন্য "সব comment এর CSV export"। Export চলার সময় সবার task board ধীর - Lesson 7.1 এর event loop, আবার।
3. **Scale এর ঝগড়া।** Attachment এর thumbnail আর search এর consumer এর দরকার CPU আর memory; board এর দরকার অনেক ছোট instance। সব একই app, তাই সব একসাথে scale হয় - বড় machine, অনেকগুলো।

নতুন একজন staff engineer প্রস্তাব দিল: "Netflix আর Uber যা করেছে - TaskFlow কে ১২টা microservice এ ভাঙি: tasks, comments, users, workspaces, auth, billing, notifications, files, thumbnails, search, reports, gateway। প্রতিটা team নিজেরটা deploy করবে।"

CTO এর উত্তর: "ভাঙার আগে বলুন - ভাঙলে কী কী দাম দিতে হয়। মেপে।" আজ সেটাই।

---

## ১. Theory

### ১.১ দুটো শব্দ আসলে কী বোঝায়

দুটো শব্দ প্রায়ই ভুল অর্থে ব্যবহার হয় - "monolith" মানে পুরনো আর জট পাকানো code, "microservices" মানে আধুনিক। আসল পার্থক্য code এর মান না, **কীভাবে deploy হয় আর data কার**।

**Monolith আর Microservices** - Monolith হলো এমন একটা app যেটা একটা একক হিসেবে build আর deploy হয় (একটা process এর ধরন, সাধারণত একটা database) - ভেতরের অংশগুলো একে অপরকে function call দিয়ে ডাকে। Microservices হলো কয়েকটা ছোট service, প্রতিটা **আলাদাভাবে deploy** হয়, প্রতিটা **নিজের data এর মালিক**, আর তারা network এর উপর (HTTP, gRPC, message) কথা বলে।

```
  monolith                                    microservices
  ────────                                    ─────────────
  ┌──────────── একটা deploy ─────────────┐     ┌─ tasks ─┐   HTTP   ┌─ users ─┐
  │ tasks ─fn()─► users                  │     │ deploy  │ ───────► │ deploy  │
  │   │                                  │     │   │     │          │   │     │
  │   └──fn()──► comments   billing …    │     │  [DB]   │          │  [DB]   │
  │                                      │     └─────────┘          └─────────┘
  │           একটা Postgres              │          │ HTTP / event
  │   [tasks][users][comments][billing]  │          ▼
  └──────────────────────────────────────┘     ┌─ comments ┐   ┌─ billing ─┐
   এক transaction এ যেকোনো table              │ deploy [DB]│   │ deploy [DB]│
                                              └───────────┘   └───────────┘
```

দুটো জিনিস এই ছবিতে লক্ষ্য করুন, কারণ বাকি lesson এর তিনটা দাম এখান থেকেই আসে: বাঁ দিকে তীর গুলো **function call**, ডান দিকে **network call**; আর বাঁ দিকে একটা database যেখানে একটা transaction সব table ছুঁতে পারে, ডান দিকে প্রতিটা service এর নিজের।

### ১.২ দাম ১ - function call থেকে network call

একটা function call মানে একই memory তে একটা লাফ - nanosecond। একটা network call মানে: object কে JSON এ বদলানো, socket এ লেখা, অন্য process এ পৌঁছানো, parse, যাচাই, কাজ, আবার JSON, ফেরা, parse, যাচাই। Lesson 1.3 এর সংখ্যায়: একই data center এর মধ্যে round trip ~০.৫ ms - memory পড়ার চেয়ে লাখ গুণ বেশি।

Exercise এর `npm run latency`: TaskFlow এর board - একটা project এর ৫০টা task, প্রতিটার assignee আর comment এর সংখ্যা। একই code, তিনভাবে। Microservices এ tasks service বাকি দুটোকে ডাকে - হয় প্রতিটা task এর জন্য আলাদা (**chatty** - ORM এর lazy load এর মতো সরল code), নয়তো সব একবারে (**batched**):

```
── Opening the board - all processes on one machine ──
                                                    1 user alone  busy: 16 concurrent, 5 s
   path                                         calls        p50   boards/s        p99   CPU / board (all processes)
   monolith (function call)                         0     0.3 ms       6234     5.0 ms   0.1 ms
   microservices, chatty (call per task)          100    11.3 ms         86   203.6 ms   24.4 ms
   microservices, batched (2 calls)                 2     0.8 ms       2206    11.1 ms   0.8 ms
```

- **Chatty:** একটা board = ১০০টা HTTP call। একজন user এর চোখে ১১ ms (১০০টা call একসাথে পাঠানো, তাই মাত্র এটুকু) - কিন্তু system এর CPU তে board প্রতি **২৪ ms**, monolith এর দুশো গুণের বেশি। ১৬ জন একসাথে এলে প্রতি সেকেন্ডে মাত্র ৮৬টা board, p99 ২০০ ms। এটা Lesson 5.6 এর N+1 - এবার database এর query না, network call। আর monolith এ একই "lazy" code নির্দোষ ছিল, কারণ function call প্রায় বিনামূল্যে।
- **Batched:** ২টা call, একসাথে - CPU ০.৮ ms, একা ০.৮ ms। Monolith এর চেয়ে ৮ গুণ বেশি CPU, কিন্তু একই ঘরে। Microservices এ API কে **মোটা** করে বানাতে হয় - "অনেকগুলো একবারে দিন" - কারণ প্রতিটা call এর একটা স্থির দাম আছে।
- এই সংখ্যা **localhost** এ - সব process একই machine এ। Experiment ১ এ প্রতিটা internal call এ ১ ms দেরি যোগ করলে (আলাদা machine এর কাছাকাছি) batched ০.৮ → ২.০ ms। আর আসল deploy এ মাঝে load balancer, TLS, আর প্রায়ই একটা service mesh এর proxy - প্রতিটা আরও একটু।

(সৎ নোট: monolith এর ৬২৩৪ board/s এর সীমা load generator নিজে - সেটা ~১.৩ core খায়, monolith তখন একটা core এর ~৭৩% এ। তাই তুলনা করুন CPU এর কলাম দিয়ে। Microservices এ ৩টা process, মানে ৩টা core ব্যবহার করতে পারে - তবু কম দেয়।)

**আরেকটা লুকানো দাম - বদলানো।** Monolith এ একটা function এর signature বদলানো একটা PR: compiler সব caller দেখিয়ে দেয়, একসাথে deploy। দুটো service এর মাঝের API বদলানো মানে Lesson 2.5 এর versioning: পুরনো আর নতুন দুটো একসাথে চালানো, সব caller সরে যাওয়া পর্যন্ত অপেক্ষা, তারপর পুরনোটা মোছা - কারণ দুটো service আলাদা সময়ে deploy হয়। TypeScript এর type গুলো সীমানা পার হয় না; সেখানে Zod আর contract।

(১৯৯০ এর দশকে Sun Microsystems এর engineer রা - L. Peter Deutsch আর অন্যরা - একটা বিখ্যাত তালিকা বানিয়েছিলেন, "fallacies of distributed computing": network নির্ভরযোগ্য, latency শূন্য, bandwidth অসীম … - distributed system এ নতুন মানুষ যা ধরে নেয় আর যা সত্যি না। Monolith ভাঙা মানে এই ভুলগুলো আপনার নিজের app এর ভেতরে ঢোকানো।)

### ১.৩ দাম ২ - ব্যর্থতা এখন আপনার app এর ভেতরে

Lesson 6.1 এর partial failure - "কিছু অংশ কাজ করছে, কিছু না, আর আপনি নিশ্চিত না কোনটা" - এতদিন database বা Redis এর সাথে ছিল। Microservices এ সেটা আপনার নিজের app এর ভেতরে, প্রতিটা সীমানায়।

প্রথম প্রশ্ন: আলাদা process মানে কি আলাদা ব্যর্থতা? ঘটনা ২ কে মাপি। Exercise এর `npm run failure`: board খোলা হচ্ছে, আর একই সময়ে কেউ "সব comment এর export" চালাচ্ছে - প্রতিটা ~৩০০ ms এর CPU এর কাজ, পরপর:

```
── A. Heavy neighbour: opening the board (8 clients) while an export runs (~300 ms CPU each, back to back) ──
   path                                         boards/s ok        p50        p99     full  no comments   error
   monolith, no export (for comparison)                5979     1.3 ms     3.2 ms     100%           0%      0%
   monolith, export in the same process                  28   301.4 ms   302.8 ms     100%           0%      0%
   microservices, no timeout                             28   301.8 ms   306.5 ms     100%           0%      0%
   microservices, timeout 50 ms + fallback              154    51.7 ms    58.1 ms       1%          99%      0%
```

- **Monolith:** export আর board একই event loop এ - board ১.৩ ms থেকে ৩০১ ms। ঘটনা ২, হুবহু।
- **Microservices, timeout ছাড়া:** export এখন comments service এ, board tasks service এ - আলাদা process। তবু board **ঠিক একই রকম ধীর**: ৩০১ ms। কারণ board এর comment এর সংখ্যা লাগে, আর tasks service চুপচাপ comments এর উত্তরের অপেক্ষা করে। ধীরতা network পার হয়ে এসেছে - Lesson 7.1 এর cascading failure, এবার service থেকে service এ।
- **Timeout + fallback:** tasks service ৫০ ms এর বেশি অপেক্ষা করে না; না পেলে board দেখায় comment এর সংখ্যা ছাড়া। Board ৫২ ms, কিন্তু ৯৯% board "অসম্পূর্ণ"।

শিক্ষা: **আলাদা process নিজে থেকে কিছু আলাদা করে না।** আলাদা হওয়ার সুবিধা আসে শুধু যখন ডাকার দিকে timeout আছে, আর "এটা না পেলে কী দেখাব" এর একটা উত্তর আছে। (এটাই Lesson 9.4 এর circuit breaker আর bulkhead এর বিষয়।)

এবার crash - export এর একটা bug process মেরে ফেলল (OOM এর মতো):

```
── B. Crash: a bug in the export killed the process - then 5 s of opening boards ──
   path                                         boards/s ok        p50        p99     full  no comments   error
   monolith (the only process died)                       0     1.2 ms     3.9 ms       0%           0%    100%
   microservices, comments died, no timeout               0     3.6 ms     7.8 ms       0%           0%    100%
   microservices, comments died, + fallback            1759     4.2 ms     8.3 ms       0%         100%      0%
      … then users died (no fallback)                     0     3.1 ms     7.0 ms       0%           0%    100%
```

এখানে microservices এর আসল সুবিধা দেখা যায়: monolith এ export এর bug **পুরো** TaskFlow বন্ধ করে (বাস্তবে ৬টা instance, কিন্তু একই bug সবগুলোতে)। Microservices এ শুধু comments - আর fallback থাকলে board চলে। কিন্তু দেখুন শেষ দুটো সারি: fallback না থাকলে ১০০% error, আর fallback **প্রতিটা নির্ভরতার জন্য আলাদা করে** design করতে হয় - users এর ছিল না।

**আর availability এর গুণ।** Spaced repetition এর উত্তর: serial এ দুটো 99.9% মানে 0.999 × 0.999 = 99.8%। Board এর পথে যত service, তত গুণ:

```
── C. Arithmetic: k services on the board's path, each independently 99.9% available ──
   k        path availability   downtime per 30 days
   1                   99.90%       43 minutes
   3                   99.70%      129 minutes
   5                   99.50%      216 minutes
  10                   99.00%      430 minutes
```

প্রস্তাবের ১২টা service এর অর্ধেকও যদি board এর পথে থাকে, প্রতিটা ভালো হলেও (99.9%) board মাসে সাড়ে তিন ঘণ্টা বন্ধ - monolith এর ৪৩ মিনিটের জায়গায়। Fallback থাকলে সেই service পথ থেকে বাদ যায় (parallel এর মতো) - তাই fallback শুধু সুন্দর UX না, availability এর গণিত।

আর একটা দাম যা exercise মাপে না: **কী ভাঙল, খোঁজা।** Monolith এ একটা stack trace। Microservices এ একটা ধীর request ছয়টা service পার হয়েছে - কোনটায় সময় গেল? এর জন্য distributed tracing (Lesson 10.4) - না থাকলে on-call এর রাত লম্বা।

### ১.৪ দাম ৩ - transaction আর data ভাগ হয়ে যায়

Microservices এর নিয়ম: প্রতিটা service নিজের data এর মালিক।

**Database per Service** - প্রতিটা service এর নিজের database (বা অন্তত নিজের schema, যেটা আর কেউ সরাসরি পড়ে বা লেখে না); অন্য service এর data চাইলে তার API বা event দিয়ে - table এ সরাসরি না।

কেন এই নিয়ম? কারণ দুটো service একই table পড়লে, একজন column এর নাম বদলালে অন্যজন ভাঙে - আর তখন দুটো একসাথে deploy করতে হয়, আলাদা deploy এর পুরো সুবিধা শেষ (১.৬ এর distributed monolith)। কিন্তু নিয়মটার দাম: **Lesson 5.5 এর transaction আর সীমানা পার হয় না।**

TaskFlow এ "task তৈরি" মানে দুটো জিনিস: tasks table এ row, আর billing এর workspace এ `task_count + 1` (plan এর সীমা আর বিল এই সংখ্যা থেকে)। Exercise এর `npm run transaction`: ৩০০০টা task তৈরি, আর ৩% এ প্রথম লেখার পরে process মারা যায় (deploy, OOM, timeout):

```
── 3000 "create task", 100 workspaces, crash after the first write in 83 of them (3%), 8 concurrent ──
   path                                               ok failed    tasks  counter    bad ws   result                  ops/s      p50
   monolith: one transaction                        2917     83     2917     2917         0   they match               2917   2.6 ms
   services: task first, then billing               2917     83     3000     2917        57   83 tasks with no bill    1516   5.2 ms
   services: billing first, then task               2917     83     2917     3000        57   83 bills with no task    1513   5.2 ms
   services: task first + the user retried          3000      0     3083     3000        57   83 tasks with no bill    1477   5.2 ms
```

- **Monolith:** crash মানে পুরো transaction বাতিল। User error দেখে, কিন্তু কিছু অর্ধেক থাকে না - অমিল ০।
- **Services:** প্রথম লেখা নিজেই commit - ফেরানো যায় না। ঠিক ৮৩টা অমিল, আর **কোন দিকে**, সেটা ক্রম ঠিক করে: task আগে মানে বিনা বিলে task (plan এর সীমা পেরোনো যায়); billing আগে মানে task ছাড়া বিল (customer এর অভিযোগ)। Lesson 8.1 এর "object আগে, row পরে" এর মতো - ভুল বন্ধ করা যায় না, শুধু বাছা যায় কোন দিকে পড়বে।
- **আবার চেষ্টা:** user error দেখে আবার চাপল। প্রথম চেষ্টার task টা আছে, তাই এখন **৩০৮৩টা task** - ৮৩টা duplicate। Retry এই সমস্যা সারায় না; বরং Lesson 2.5 এর idempotency key লাগে।
- আর crash ছাড়াও (experiment ৩): প্রতিটা operation এ দুটো commit, দুটো round trip - ops/s ২৮১০ থেকে ~১৪৯০।

এর সমাধান আছে - Lesson 7.5 এর outbox (billing কে event পাঠানো, একই transaction এ), আর Lesson 9.3 এর saga (কয়েক ধাপের কাজ, প্রতিটা ধাপের উল্টো কাজ সহ)। কিন্তু প্রতিটা সমাধান মানে eventual consistency আর বাড়তি code - monolith এ এর জায়গায় ছিল একটা `BEGIN … COMMIT`।

**JOIN ও হারায়।** "Pro plan এর workspace গুলোর গত সপ্তাহের task" - monolith এ একটা SQL। Services এ billing থেকে workspace এর তালিকা, tasks থেকে task, আর app এ জোড়া - বা একটা আলাদা কপি যেখানে দুটোই আছে (Lesson 7.6 এর analytics, 8.3 এর search এর মতো - database এর derived কপি, sync আর দেরি সহ)।

### ১.৫ তাহলে ভাঙে কেন - কী পাওয়া যায়

তিনটা দাম দেখলাম। তবু বড় কোম্পানিগুলো ভাঙে - কারণ কিছু সমস্যা monolith এ সমাধান করা কঠিন, আর সেগুলো প্রায় সবই **মানুষ** এর সমস্যা, machine এর না:

- **আলাদা deploy।** ঘটনা ১: billing এর bug tasks এর fix আটকায়। আলাদা service মানে প্রতিটা team নিজের সময়ে deploy করে, নিজের rollback করে।
- **আলাদা scale।** ঘটনা ৩: thumbnail এর CPU আর board এর অনেক ছোট instance - আলাদা service মানে আলাদা machine এর ধরন, আলাদা সংখ্যা।
- **ব্যর্থতা আলাদা করা** - কিন্তু শুধু design করলে (১.৩ এর timeout আর fallback)।
- **আলাদা প্রযুক্তি** - একটা service এ Python এর ML library, বাকিটা TypeScript। বাস্তবে এটা প্রায়ই সবচেয়ে কম জরুরি কারণ।

এর পেছনে একটা পুরনো পর্যবেক্ষণ:

**Conway's Law** - "যেকোনো organization যে system design করে, তার গঠন সেই organization এর যোগাযোগের গঠনের নকল হয়" - Melvin Conway, 1968। মানে: পাঁচটা team একটা codebase এ কাজ করলে, code এর সীমানা শেষমেশ team এর সীমানায় গিয়ে দাঁড়ায় - ইচ্ছা করে হোক বা না হোক।

তাই microservices প্রধানত একটা **organization কে scale করার** হাতিয়ার: অনেক team যেন একে অপরের পায়ে না পড়ে। "App ধীর" এর সমাধান প্রায় কখনো না - ১.২ এর সংখ্যায় দেখেছেন, network call যোগ করলে app ধীরই হয়।

**বাস্তবের কয়েকটা গল্প** (প্রকাশিত লেখা থেকে; প্রতিটার পুরো প্রসঙ্গ মূল লেখায় পড়ুন):

- **Amazon:** Steve Yegge এর 2011 এর বিখ্যাত (আর ভুল করে public হওয়া) লেখা অনুযায়ী, ২০০০ এর দশকের শুরুতে Amazon এ একটা নির্দেশ এসেছিল - প্রতিটা team এর data আর কাজ শুধু service এর interface দিয়ে পাওয়া যাবে, আর কোনো পথে না। বড় কোম্পানিতে এটা "team এর স্বাধীনতা" এর গল্প হিসেবে বলা হয় - কিন্তু সেখানে হাজার হাজার engineer।
- **Segment (2018, "Goodbye Microservices"):** প্রতিটা destination এর জন্য আলাদা service - শতাধিক - আর তিনজন engineer এর বেশিরভাগ সময় যেত সেগুলো চালু রাখতে। তারা আবার একটা service এ ফিরে গেল, আর productivity বাড়ল।
- **Amazon Prime Video (2023):** একটা video এর মান পর্যবেক্ষণের tool, যেটা অনেক ছোট distributed অংশে (Step Functions, Lambda) বানানো ছিল - একটা process এ ফিরিয়ে আনায় সেই tool এর infrastructure এর খরচ ৯০% কমল। (এটা পুরো Prime Video না - একটা নির্দিষ্ট tool; কিন্তু শিক্ষাটা ১.২ এর: সীমানা পার হওয়ার দাম।)
- **Shopify:** খুব বড় Ruby on Rails app - microservices এ না ভেঙে "modular monolith" (১.৬) - একটা deploy, কিন্তু ভেতরে কঠোর সীমানা, আর সেই সীমানা পরীক্ষা করার tool।

আর Martin Fowler এর 2015 এর "MonolithFirst" লেখা: সফল microservices এর বেশিরভাগ গল্প একটা monolith দিয়ে শুরু যেটা বড় হয়ে ভেঙেছে; শুরু থেকে microservices এর গল্প গুলো প্রায়ই সমস্যায় পড়েছে - কারণ শুরুতে কেউ জানে না সঠিক সীমানা কোথায়।

### ১.৬ মাঝের পথ - modular monolith, আর যা এড়াতে হবে

প্রশ্নটা "এক বনাম বারো" না। একটা মাঝের পথ আছে, আর একটা ফাঁদ।

**Modular Monolith** - একটা deploy, একটা process এর ধরন, একটা database - কিন্তু ভেতরে module গুলোর স্পষ্ট সীমানা: প্রতিটা module নিজের table এর মালিক, অন্য module কে শুধু তার public interface (function) দিয়ে ডাকে, আর সেই নিয়ম tool দিয়ে জোর করে মানানো হয়।

সীমানা কোথায় টানবেন? Domain-Driven Design (Eric Evans, 2003) এর একটা ধারণা:

**Bounded Context** - একটা সীমানা যার ভেতরে একটা শব্দের একটাই অর্থ আর একটা model; সীমানার বাইরে একই শব্দের অন্য অর্থ হতে পারে। যেমন TaskFlow এ "task": board এ সেটা title, assignee, status, comment; billing এ সেটা শুধু একটা সংখ্যা - plan এর সীমার মধ্যে কয়টা। দুটো আলাদা context, দুটো আলাদা model।

ভালো সীমানার লক্ষণ: ভেতরের জিনিস একসাথে বদলায়, একসাথে transaction এ লেখা হয়, একটা team এর মালিকানায়; বাইরের সাথে কথা কম আর মোটা। খারাপ সীমানা: প্রতিটা feature এ দুটো module একসাথে বদলাতে হয়।

TypeScript এ modular monolith এর চেহারা:

```
src/modules/
├── work/            ← tasks, projects, comments - একটা bounded context
│   ├── index.ts     ← public interface: শুধু এটাই বাইরে থেকে import করা যায়
│   ├── models/      ← Sequelize model - Postgres এর `work` schema
│   └── internal/    ← বাইরে থেকে import নিষেধ (lint rule)
├── billing/
│   ├── index.ts     ← recordTaskCreated(tx, workspaceId), usage(workspaceId)
│   └── …            ← Postgres এর `billing` schema
├── identity/        ← users, workspaces membership, auth
├── files/           ← attachment (8.1, 8.2)
└── search/          ← search (8.3)
```

```typescript
// src/modules/work/index.ts - the work module's public interface
import type { Transaction } from 'sequelize';
import { billing } from '../billing';
import { Task } from './models/task';

export async function createTask(input: NewTask, tx: Transaction): Promise<TaskDto> {
	const task = await Task.create(input, { transaction: tx });
	// calling another module - through its public function, never its table directly.
	// But still the same process, the same database, the same transaction - 1.4's mismatch can't happen here.
	await billing.recordTaskCreated(tx, input.workspaceId);
	return toDto(task);
}
```

আর নিয়মটা কাগজে না, tool এ: ESLint এর `no-restricted-imports` (বা `dependency-cruiser`) - `modules/*/internal/**` বাইরে থেকে import হলে CI fail। Postgres এ প্রতিটা module এর আলাদা schema, আর code review এর নিয়ম: অন্য schema এর table এ সরাসরি query না। এতে আপনি পান microservices এর সবচেয়ে বড় সুবিধা - **সীমানা** - কোনো network, কোনো ছড়ানো ব্যর্থতা, কোনো হারানো transaction ছাড়া। আর পরে একটা module বের করতে হলে, সীমানা আগেই পরিষ্কার।

এবার ফাঁদ:

**Distributed Monolith** - এমন একটা system যেটা দেখতে microservices (আলাদা process, network call) কিন্তু আচরণে monolith: service গুলো একই database এর table ভাগ করে, একসাথে deploy করতে হয়, আর একটা request এ অনেক synchronous call এর শিকল। দুই দিকের দাম, কোনো দিকের সুবিধা না।

```
  distributed monolith এর লক্ষণ
  ──────────────────────────────
  ┌─ tasks ─┐ ──HTTP──► ┌─ users ─┐ ──HTTP──► ┌─ auth ─┐        ← synchronous শিকল (১.৩ এর গুণ)
  └────┬────┘           └────┬────┘           └───┬────┘
       └───────────┬─────────┴────────────────────┘
                   ▼
            [ একটা ভাগ করা Postgres ]                             ← সবাই সবার table পড়ে
  "users এর একটা column বদলাব" → tasks, auth, reports একসাথে deploy  ← আলাদা deploy নেই
```

নিজেকে জিজ্ঞেস করার প্রশ্ন: একটা service কি অন্যদের না ছুঁয়ে একা deploy করা যায়? একটা service এর database বদলালে কি অন্য কেউ ভাঙে? একটা service মরলে কয়টা বাকিটা মরে? উত্তর "না, হ্যাঁ, সবাই" হলে সেটা distributed monolith।

**বের করা ধীরে ধীরে।** যখন সত্যিই একটা অংশ বের করতে হয়, সবকিছু একবারে না:

**Strangler Fig** - পুরনো system এর পাশে নতুন service বানিয়ে, একটা একটা route বা feature করে traffic নতুনটায় সরানো (সামনে একটা proxy বা gateway যেটা ঠিক করে কোন request কোথায় যাবে), যতক্ষণ না পুরনো অংশটা খালি হয়ে সরানো যায় - Martin Fowler এর 2004 এর নাম, একটা গাছের নামে যেটা আরেকটা গাছকে ঘিরে ধীরে ধীরে বড় হয়।

প্রতিটা ধাপ ছোট, প্রতিটা ফেরানো যায়, আর পুরনো system সারাক্ষণ চলে। (সামনের সেই gateway - Lesson 9.2।)

### ১.৭ TaskFlow এর সিদ্ধান্ত

**বারোটা service না। Modular monolith, আর ঠিক একটা service বের করা - যেখানে শর্তগুলো মেলে।**

প্রথমে তিনটা ঘটনার আসল উত্তর:

- **Deploy এর লাইন (ঘটনা ১):** সমস্যাটা একটা pipeline, একসাথে সবার change। উত্তর: `CODEOWNERS` দিয়ে module এর মালিকানা, test module ধরে ভাগ করে সমান্তরালে (৪৫ থেকে ~১০ মিনিট), আর feature flag (Lesson 10.6) - অর্ধেক-বানানো feature deploy হয় কিন্তু বন্ধ থাকে, তাই একটা bug এ পুরো deploy rollback না করে flag বন্ধ।
- **Export (ঘটনা ২):** web process এ ভারী কাজ - এর উত্তর Module 7 এ আছে: BullMQ job, আলাদা worker process (Lesson 7.3)। নতুন service লাগে না।
- **Scale (ঘটনা ৩):** web আর worker আলাদা process type - একই code, আলাদা deploy এর আকার।

তারপর modular monolith: পাঁচটা module, পাঁচটা team এর সাথে মিলিয়ে (Conway এর নিয়ম কাজে লাগিয়ে) - `work` (task, project, comment), `identity`, `billing`, `files`, `search`। Postgres এ প্রতিটার নিজের schema, public `index.ts`, lint rule, আর module এর মধ্যে লেখা এখনো একই transaction এ।

**কোন অংশ বের করবেন - পাঁচটা প্রশ্ন:**

1. একটা team কি পুরোপুরি এর মালিক, আর বাকিদের থেকে আলাদা গতিতে বদলায়?
2. এর resource এর চাহিদা কি বাকি app থেকে খুব আলাদা (CPU, memory, GPU)?
3. বাকিদের সাথে কি কোনো **একই transaction** এ লেখা লাগে? (লাগলে বের করা মানে ১.৪ এর দাম)
4. বাকিরা কি এর সাথে async এ (event দিয়ে) কথা বলতে পারে - নাকি প্রতিটা user request এর পথে synchronous লাগবে? (লাগলে ১.২ আর ১.৩ এর দাম)
5. এর সীমানা কি স্থির - গত কয়েক মাসে কি এর interface খুব বদলেছে?

**Files processing** (thumbnail, video transcode, virus scan) সবগুলোতে মেলে: files team এর; CPU আর memory ভারী, কখনো GPU; কোনো transaction ভাগ করে না - Lesson 8.2 এর `attachment.uploaded` event থেকে শুরু, আর শেষে একটা event ফেরত; user এর request এর পথে নেই; আর interface ছোট আর স্থির ("এই object এর thumbnail বানান")। এটা বের হবে - নিজের deploy, নিজের machine, নিজের scale।

**Billing** লোভনীয় (আলাদা team, compliance), কিন্তু প্রশ্ন ৩ এ আটকায়: task তৈরি আর usage একই transaction এ (১.৪ এর exercise)। এখন না - আগে outbox দিয়ে usage কে event এ বদলানো, তারপর Lesson 9.3 এর saga, তারপর দেখা।

> **Trade-off Table - TaskFlow এর আকৃতি**

| আকৃতি                 | Deploy                                 | Team এর স্বাধীনতা                  | সীমানার দাম (latency/CPU)        | ব্যর্থতা                                     | Transaction / consistency           | চালানোর জটিলতা                                       | কখন                                              |
| --------------------- | -------------------------------------- | ---------------------------------- | -------------------------------- | -------------------------------------------- | ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Monolith (সীমানা নেই) | এক, সবাই একসাথে                        | কম - সবার code সবার সাথে জড়ানো    | নেই (function call)              | একটা bug সবাইকে ফেলে                         | এক transaction, JOIN                | সবচেয়ে কম                                           | শুরু, ছোট team, সীমানা এখনো অজানা                |
| Modular monolith      | এক, কিন্তু module ধরে মালিকানা আর test | মাঝারি - সীমানা tool দিয়ে জোর করা | নেই                              | একই process - একটা bug সবাইকে (worker আলাদা) | এক transaction, module এর API দিয়ে | কম                                                   | বেশিরভাগ app, কয়েকটা team - **TaskFlow এখন**    |
| Microservices         | প্রতিটা আলাদা                          | বেশি                               | প্রতিটা call এ (chatty হলে ২০০×) | আলাদা - **শুধু** timeout + fallback থাকলে    | নেই - outbox, saga, eventual        | অনেক - tracing, discovery, versioning, অনেক pipeline | অনেক team, খুব আলাদা scale, স্থির সীমানা         |
| Distributed monolith  | আলাদা নামে, আসলে একসাথে                | কম                                 | প্রতিটা call এ                   | শিকল - সবাই একসাথে পড়ে                      | ভাগ করা DB, কিন্তু transaction নেই  | অনেক                                                 | কখনো না - চিনলে জোড়া লাগান বা সত্যিই আলাদা করুন |

---

## ২. Interview Angle

**"Monolith না microservices?" (বা design প্রশ্নের মাঝে: "আপনি কি এটাকে service এ ভাগ করবেন?")** - দুর্বল উত্তর: "microservices, কারণ scalable"। ভালো উত্তর আগে প্রশ্ন করে: কয়টা team, কতজন engineer, কোন অংশের scale আলাদা? তারপর দাম আর লাভ দুটোই বলে - network call (একটা সংখ্যা: "chatty call এ board প্রতি ২০০ গুণ CPU"), availability এর গুণ, হারানো transaction - আর বলে modular monolith দিয়ে শুরু, সীমানা পরিষ্কার হলে যে অংশের resource বা team আলাদা, শুধু সেটা বের করা। System design interview এ (যেমন "design Uber") service গুলো আঁকা স্বাভাবিক - কিন্তু প্রতিটা সীমানার পাশে বলুন কোন call synchronous, কোনটা event, আর কোন data কার।

**"Microservices এর সবচেয়ে বড় অসুবিধা কী?"** - Distributed data: transaction নেই, JOIN নেই, eventual consistency; তারপর partial failure আর debugging (tracing)। বোনাস: distributed monolith এর নাম আর লক্ষণ।

**"একটা monolith কীভাবে ভাঙবেন?"** - Strangler fig: সামনে একটা gateway/proxy, একটা একটা route নতুন service এ, পুরনোটা চলতে থাকে; আগে data এর মালিকানা ভাগ (কে লেখে), তারপর code। কোনটা আগে - সবচেয়ে কম জড়ানো আর সবচেয়ে বেশি লাভের অংশ (TaskFlow এর files processing)।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনা: timeout ছাড়া synchronous call এর শিকল - একটা ধীর service সবাইকে থামায় (১.৩); service গুলো একই database ভাগ করে আর একটা migration সবাইকে ভাঙে; "আমরা ৪০টা service চালাই কিন্তু ৮ জন engineer" - চালানোর খরচ কাজের চেয়ে বেশি; আর ফিরে আসা - Segment এর মতো, অনেক কোম্পানি service গুলো আবার জোড়া লাগিয়েছে।

---

## ৩. Key Takeaway

- **Monolith** বনাম **microservices** এর পার্থক্য code এর মান না - **deploy এর একক আর data এর মালিকানা**: একটা deploy আর একটা database, বনাম প্রতিটা service আলাদা deploy আর নিজের data, network এ কথা
- **দাম ১ - network call:** একই board, chatty (১০০টা call) এ CPU board প্রতি ২৪ ms বনাম monolith এ ০.১ ms, ব্যস্ত সময়ে ৮৬ বনাম হাজার হাজার board/s; batched (২টা call) এ ০.৮ ms। সীমানার API মোটা হতে হয়, আর বদলাতে versioning লাগে
- **দাম ২ - ব্যর্থতা:** আলাদা process নিজে কিছু আলাদা করে না - timeout ছাড়া board monolith এর মতোই ৩০১ ms; timeout + fallback এ ৫২ ms (অসম্পূর্ণ)। Crash এ microservices জেতে - কিন্তু শুধু যে নির্ভরতার fallback আছে। পথে k টা service মানে availability এর k বার গুণ
- **দাম ৩ - transaction:** database per service মানে crash এ অর্ধেক কাজ - ৮৩টা অমিল, দিকটা লেখার ক্রম ঠিক করে; retry duplicate বানায়; crash ছাড়াও throughput প্রায় অর্ধেক। সমাধান outbox, saga (9.3) - eventual consistency সহ
- Microservices প্রধানত **organization** এর সমস্যার সমাধান (আলাদা deploy, আলাদা scale, team এর স্বাধীনতা - **Conway's Law**), "app ধীর" এর না
- **Modular monolith**: এক deploy, এক database, কিন্তু **bounded context** ধরে tool দিয়ে জোর করা সীমানা - বেশিরভাগ app এর জন্য সঠিক শুরু; **distributed monolith** (ভাগ করা DB, একসাথে deploy, synchronous শিকল) দুই দিকের খারাপ
- বের করা একটা একটা করে (**strangler fig**), পাঁচটা প্রশ্ন ধরে: মালিকানা, resource, ভাগ করা transaction, async সম্ভব কিনা, স্থির সীমানা - TaskFlow এ শুধু files processing

---

## ৪. নতুন Term (Glossary)

| Term                         | অর্থ                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Monolith / Microservices** | Monolith - একটা একক হিসেবে build আর deploy হওয়া app, ভেতরে function call, সাধারণত এক database; Microservices - আলাদা deploy হওয়া service, প্রতিটা নিজের data এর মালিক, network এ কথা |
| **Database per Service**     | প্রতিটা service এর নিজের database বা schema, যেটা আর কেউ সরাসরি ছোঁয় না - অন্যের data তার API বা event দিয়ে; দাম: সীমানা পার হয়ে transaction আর JOIN নেই                            |
| **Conway's Law**             | একটা organization যে system বানায়, তার গঠন সেই organization এর যোগাযোগের গঠনের নকল হয় (Melvin Conway, 1968)                                                                          |
| **Modular Monolith**         | এক deploy আর এক database, কিন্তু ভেতরে module এর স্পষ্ট সীমানা - প্রতিটা নিজের table এর মালিক, শুধু public interface দিয়ে ডাকা, tool দিয়ে জোর করা                                    |
| **Bounded Context**          | যে সীমানার ভেতরে একটা শব্দের একটাই অর্থ আর model (Domain-Driven Design) - service বা module এর সীমানা খোঁজার প্রধান উপায়                                                              |
| **Distributed Monolith**     | দেখতে microservices, আচরণে monolith - ভাগ করা database, একসাথে deploy, synchronous call এর শিকল; দুই দিকের দাম, কোনো দিকের লাভ না                                                      |
| **Strangler Fig**            | পুরনো system এর পাশে নতুন service বানিয়ে, সামনের proxy দিয়ে একটা একটা route সরানো, যতক্ষণ না পুরনো অংশ খালি হয়                                                                      |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. একটা নতুন startup - চারজন engineer, ছয় মাসে একটা MVP। CTO বলছে: "শুরু থেকেই microservices - user, order, payment, notification, catalog - যাতে পরে আবার লিখতে না হয়।" তার যুক্তির কোন অংশ ঠিক আর কোন অংশ ভুল? এই lesson এর তিনটা দাম এই team এর জন্য কতটা ভারী, আর লাভ গুলোর কোনটা তারা পাবে? আপনি কী প্রস্তাব দেবেন - আর "পরে আবার লিখতে হবে" এর ভয়টা কীভাবে সামলাবেন?
2. TaskFlow এর notifications (task assign হলে email, comment এ mention হলে push) - একজন বলছে এটা বের করা উচিত। ১.৭ এর পাঁচটা প্রশ্ন ধরে বিচার করুন। Notification service কে user এর email আর notification এর preference জানতে হয় - সেটা কীভাবে পাবে: প্রতিবার identity কে HTTP call, নাকি অন্য কিছু (Lesson 7.5)? Notification service এক ঘণ্টা বন্ধ থাকলে কী হওয়া উচিত?
3. TaskFlow এর আরেকটা team আগে একটা `reports` service বানিয়েছিল - আলাদা process, আলাদা deploy - কিন্তু সেটা সরাসরি monolith এর Postgres এর `tasks` আর `comments` table পড়ে। এখন tasks team `tasks.status` column কে একটা আলাদা table এ সরাতে চায়। কী হবে? এটা কোন anti-pattern? তিনটা বিকল্প দিন, প্রতিটার দাম সহ।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** ঠিক অংশ: পরে ভাঙা সত্যিই কঠিন হতে পারে - **যদি** code এ কোনো সীমানা না থাকে। ভুল অংশ: সমাধান হিসেবে microservices।

- **দাম গুলো:** চারজন engineer মানে প্রতিটা service এর deploy pipeline, monitoring, on-call - প্রায় একজন মানুষ প্রতি service। Order আর payment একই transaction এ থাকার কথা - ভাগ করলে প্রথম দিন থেকেই saga (9.3)। আর MVP এর প্রথম ছয় মাসে product বারবার বদলায় - সীমানা ভুল জায়গায় টানলে (প্রায় নিশ্চিত - কেউ এখনো জানে না কোনটা একসাথে বদলায়) প্রতিটা feature এ কয়েকটা service আর API version একসাথে বদলাতে হয়।
- **লাভ গুলো:** আলাদা deploy - চারজনের team এর দরকার নেই, তারা একে অপরের পায়ে পড়ে না। আলাদা scale - MVP এর traffic একটা machine এ ধরে। ব্যর্থতা আলাদা করা - timeout আর fallback ছাড়া পায়ও না।
- **প্রস্তাব:** modular monolith - `user`, `order`, `payment`, `catalog`, `notification` module, প্রতিটার নিজের schema আর public interface, lint দিয়ে জোর করা। "পরে আবার লিখতে হবে" এর ভয়ের উত্তর এটাই: সীমানা আজ থেকেই আছে, শুধু network নেই - পরে একটা module বের করা মানে তার `index.ts` এর function গুলোকে HTTP client এ বদলানো আর তার schema কে আলাদা database এ। আর যেটা প্রায় নিশ্চিতভাবে আলাদা লাগবে (যেমন ভারী কাজ) সেটা শুরু থেকে worker (Module 7)।

**প্রশ্ন ২:** পাঁচটা প্রশ্ন:

1. মালিকানা - ধরুন একটা team (collaboration) এর; email/push এর provider, template, retry এর নিয়ম - আলাদা গতিতে বদলায়। ✓
2. Resource - খুব আলাদা না (I/O, provider এর API), কিন্তু burst আলাদা (একটা বড় import এ হাজার email - Lesson 7.4)। আংশিক ✓
3. ভাগ করা transaction - না: notification task তৈরির transaction এর অংশ না; task তৈরি হলো, তারপর "জানান"। ✓
4. Async - পুরোপুরি: `task.assigned`, `comment.mentioned` event (outbox → stream, 7.5), user এর request এর পথে নেই। ✓
5. স্থির সীমানা - "এই event এ এই user কে জানান" - ছোট আর স্থির। ✓

তাই এটা একটা ভালো প্রার্থী - files processing এর পরে দ্বিতীয়।

Preference আর email: প্রতিটা notification এ identity কে HTTP call মানে identity এর availability notification এর পথে (১.৩ এর গুণ), আর হাজার email এর burst এ identity এর উপর হাজার call। ভালো: **event-carried state transfer** (Lesson 7.5) - identity `user.email_changed`, `user.preferences_changed` event ছাড়ে, notification service নিজের একটা ছোট কপি রাখে (নিজের database এ, শুধু যা লাগে)। দাম: কপিটা কয়েক সেকেন্ড পিছিয়ে থাকতে পারে - email বদলানোর ঠিক পরের notification পুরনো ঠিকানায় যেতে পারে; সাধারণত মেনে নেওয়া যায়।

এক ঘণ্টা বন্ধ: event গুলো stream এ জমে থাকে (consumer group এর offset, 7.2) - চালু হলে পিছিয়ে থাকা event গুলো পাঠায়। Task তৈরি বা board এর কিছুই থামে না। দুটো সিদ্ধান্ত লাগে: এক ঘণ্টা পুরনো notification কি এখনো পাঠানো উচিত ("আপনাকে একটা task দেওয়া হয়েছে" - হ্যাঁ; "X এখন typing করছে" - না, তাই event এ একটা মেয়াদ); আর জমে থাকা হাজার event একসাথে পাঠানোর সময় provider এর rate limit (backpressure, 7.4)।

**প্রশ্ন ৩:** `reports` এর query গুলো `tasks.status` পড়ে - column সরালে reports ভাঙে, deploy এর ঠিক পরে, আর tasks team এর test এ এটা ধরা পড়ে না (reports আলাদা repo)। উপায় একটাই থাকে: দুটো team একসাথে বদলায়, একসাথে deploy করে। এটা **distributed monolith** - আলাদা deploy এর নাম, কিন্তু ভাগ করা database একসাথে বাঁধে। আসলে database এর schema টাই দুই team এর মাঝের API হয়ে গেছে - কোনো version ছাড়া।

বিকল্প:

- **(ক) Tasks এর একটা reporting API** (বা একটা "view" যেটা tasks team বজায় রাখার প্রতিশ্রুতি দেয় - একটা database view কে public contract ধরা)। দাম: tasks team এখন একটা interface এর মালিক, version সহ (2.5); বড় report এ API দিয়ে লাখ row টানা ধীর।
- **(খ) Event থেকে reports এর নিজের কপি** - `task.*` event (outbox, 7.5) → reports এর নিজের database এ তার নিজের আকৃতির table (read model)। দাম: eventual (কয়েক সেকেন্ড পিছিয়ে - report এর জন্য সাধারণত ঠিক), শুরুর backfill, আর sync এর ফাঁক ধরার job (8.3 এর মতো)। এটাই সবচেয়ে পরিষ্কার আলাদা করা - আর Lesson 7.6 এর analytics এর পথের সাথে মেলে।
- **(গ) জোড়া লাগানো** - reports কে monolith এর একটা module বানানো, আর `work` module এর public function দিয়ে পড়া। দাম: আলাদা deploy শেষ; কিন্তু যদি আলাদা deploy এর দরকার আসলে কখনো ছিলই না (একই team, একই গতি), এটাই সবচেয়ে সস্তা।

বাছাই নির্ভর করে reports team আসলে কতটা আলাদা: আলাদা team, আলাদা গতি, বড় analytics → (খ); ছোট, একই মানুষ → (গ)। (ক) মাঝামাঝি, দ্রুত সমাধান।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (আলাদা Node process গুলো আলাদা service; `transaction` এ Docker এ Postgres)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-9.1-monolith-vs-microservices/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.1-monolith-vs-microservices) - `npm install`, তারপর `npm run latency` আর `npm run failure` (Docker ছাড়া); `docker compose up -d --wait`, তারপর `npm run transaction`। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`latency` একই board তিনভাবে দেয় - এক process এ, আর তিনটা process এ chatty বা batched call দিয়ে - আর মাপে একা একজন user এর সময়, ব্যস্ত সময়ের board/s, আর সব process মিলিয়ে board প্রতি CPU। `failure` একটা ভারী export আর crash এর সময় board এর কী হয় দেখায় - timeout আর fallback সহ ও ছাড়া - আর availability এর গুণ। `transaction` "task তৈরি" কে এক database এর transaction আর দুটো database এর দুটো লেখায় চালায়, মাঝে seed দেওয়া crash সহ।

**সৎ নোট:** Sandbox এ Node 26 আর Docker এর Postgres 17 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `latency` পাঁচবার - সময় কয়েক শতাংশ ওঠানামা করে (chatty একা ১০–১৪ ms, batched ব্যস্ত ~২২০০ board/s), CPU / board এর কলাম স্থির; `failure` তিনবার - % আর error এর কলাম হুবহু একই; `transaction` তিনবার - ops/s আর p50 ছাড়া সব হুবহু একই। README এর experiment ১–৩ চালানো হয়েছে, সংখ্যা README তে; experiment ১ এর `for … of` অংশ, আর ৪, ৫ code বদলানোর কাজ - আপনার। সব "service" একই machine এ localhost এ - আসল network এর চেয়ে দ্রুত; `NET_MS` দেরির একটা আনুমানিক ভান, আসল network এর ওঠানামা না। Monolith এর board/s এর সীমা load generator নিজে - তুলনা CPU এর কলামে। Export এর CPU এর কাজ আর crash (`SIGKILL`) বানানো, আসল bug না। ১.৫ এর কোম্পানির গল্প গুলো তাদের প্রকাশিত লেখা থেকে - সংক্ষেপ, পুরো প্রসঙ্গ মূল লেখায়। ১.৬ এর TypeScript এর অংশ (modular monolith এর `index.ts`) একটা নকশা, চালানো code না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `latency` চালানোর **আগে** লিখে ফেলুন - chatty পথে একটা board এ কয়টা HTTP call, আর board প্রতি CPU monolith এর কত গুণ হবে (দশ? একশো?)। তারপর মেলান। আপনার অনুমান কোথায় ভুল হলো, আর কেন "একা ১ জন" এর সময় CPU এর চেয়ে অনেক কম?

2. **Network এর দূরত্ব:** experiment ১ (`NET_MS=1`) চালান। Batched কত বাড়ল, chatty কত - আর কেন chatty প্রায় বাড়েনি? তারপর `service.ts` এ chatty এর `Promise.all` কে `for … of` + `await` এ বদলান (একটা একটা করে call - অনেক আসল code এভাবেই লেখা)। চালানোর আগে হিসাব করুন: `NET_MS=1` এ একা একজনের board কত ms হবে?

3. **Timeout এর মান:** experiment ২ (`TIMEOUT_MS=500`) চালান, তারপর `TIMEOUT_MS=10`। প্রতিটায় "comments ছাড়া" কত %? TaskFlow এর board এর SLO যদি "p99 < 200 ms" হয়, comments এর call এর timeout কীভাবে ঠিক করবেন - কোন দুটো সংখ্যা থেকে?

4. **অমিলের দিক:** `transaction` এর চারটা সারির প্রতিটার জন্য এক লাইনে লিখুন - customer এর চোখে কী ঘটে, আর billing team এর চোখে কী। TaskFlow এর জন্য কোন ক্রম বাছবেন? তারপর experiment ৫ (reconcile job) লিখুন, আর বলুন দুটো database একসাথে পড়তে না পারায় আপনার job কী ভুল করতে পারে।

5. **Design অংশ:** TaskFlow এর modular monolith এর এক পাতার design: (ক) পাঁচটা module এর নাম, প্রতিটার মালিক team আর Postgres schema; (খ) প্রতিটা module এর public interface এর ৩–৫টা function এর signature (TypeScript); (গ) কোন নিয়ম কোন tool এ জোর করবেন (lint, schema এর permission, CODEOWNERS, CI); (ঘ) files processing বের করার পরিকল্পনা - strangler fig এর ধাপ, কোন event ঢোকে আর বেরোয়, আর কোন metric দেখে বলবেন বের করাটা সফল; (ঙ) billing কে কখনো বের করার আগে কী কী বদলাতে হবে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8 (সম্পূর্ণ, exit challenge সহ)
Current: 9.1 - Monolith vs Microservices: কখন ভাঙবেন, কখন না
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; outbox → Redis Streams, BullMQ worker; object storage (presigned,
multipart, CDN signed URL); search Postgres full-text; code: modular monolith - পাঁচটা module
(work, identity, billing, files, search), প্রতিটার নিজের Postgres schema আর public index.ts,
lint দিয়ে সীমানা জোর করা, module এর মধ্যে লেখা একই transaction এ; web আর worker আলাদা process
type; CODEOWNERS, module ধরে test, feature flag; বের হচ্ছে শুধু files processing (thumbnail,
transcode, scan) - event এ কথা বলে; billing এখন না (task তৈরির সাথে একই transaction)
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 9.2 - Service communication, API Gateway, BFF pattern (SvelteKit server route)
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠান - বিশেষ করে ১ নম্বরের অনুমান আর ৫ নম্বরের design। রেডি হলে `next` লিখুন - Lesson 9.2 এ যাব: **Service communication, API Gateway, আর BFF pattern।** আজ files processing কে বের করার সিদ্ধান্ত নিলাম, আর strangler fig এর জন্য সামনে একটা "proxy বা gateway" এর কথা বললাম - কিন্তু সেটা আসলে কী? Browser যখন একটা page এর জন্য তিনটা service এর data চায়, সে কি তিনটাকে আলাদা ডাকবে - নাকি মাঝে কেউ জোড়া দেবে? Service গুলো একে অপরের সাথে REST, gRPC, নাকি event এ কথা বলবে? আর TaskFlow এর SvelteKit এর server route (`+page.server.ts`) আসলে ইতিমধ্যেই একটা BFF - Backend for Frontend - সেটা কী দায়িত্ব নেবে আর কী নেবে না।
