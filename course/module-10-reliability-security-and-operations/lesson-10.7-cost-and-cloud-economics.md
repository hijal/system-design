# Lesson 10.7 — Cost & Cloud Economics

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 1.3):** একটা system এর দিনের মোট request থেকে গড় QPS কীভাবে বের করো, আর peak QPS এর আন্দাজ কীভাবে করো? Server এর সংখ্যা কোনটা দিয়ে ঠিক হয় — গড় না peak? আজ দেখবে, এই প্রশ্নের "peak" উত্তরটা সত্যি, কিন্তু সেটা ২৪ ঘণ্টা ধরে কিনে রাখলে একটা দাম আছে। TaskFlow এর ক্ষেত্রে সেই দামে কেনা capacity এর ৮০% পড়ে থাকে।

**Prerequisite:** Lesson 1.3 (Estimation, peak বনাম গড়), Lesson 4.5 (CDN), Lesson 7.4 (Idempotent job), Lesson 7.6 (OLTP বনাম OLAP), Lesson 8.1 (Object storage এর দাম), Lesson 8.2 (Preview, CDN), Lesson 9.1 (Monolith বনাম service), Lesson 10.3 (AZ, static stability), Lesson 10.4 (Log আর metric এর আয়তন), Lesson 10.5 (DDoS), Lesson 10.6 (Blue-green, canary)

**তুমি এই lesson শেষে পারবে:**

1. একটা cloud বিলকে লাইন ধরে design এর সিদ্ধান্তে ফেরাতে পারবে: কোন লাইন সময়ে বাড়ে (instance-ঘণ্টা), কোনটা জমায় (GB-মাস), কোনটা নড়াচড়ায় (GB transfer), কোনটা ঘটনায় (request)। আর খরচকে একক ধরে ভাগ করতে পারবে (unit economics: প্রতি workspace, প্রতি plan, প্রতি endpoint), যাতে বোঝা যায় কোন সিদ্ধান্ত টাকা বানায় আর কোনটা খায়
2. Compute এর তিনটা হাতল আলাদা করে ব্যবহার করতে পারবে: autoscale (ওঠানামার অংশ), commitment (সবসময় চলা অংশ, আর কতটা commit করবে তার অঙ্ক), আর spot (বাধা সহ্য করতে পারা অংশ)। সাথে বলতে পারবে একটা DDoS এর বিল কোথায় থামালে কত
3. Data কোথায় থাকে আর কোথায় নড়ে, সেটা দিয়ে খরচ নকশা করতে পারবে: storage tier আর lifecycle (ছোট object এর ফাঁদ সহ), log এর দাম কোথায়, NAT বনাম VPC endpoint, AZ জুড়ে traffic। আর cost কে একটা নজরদারির জিনিস বানাতে পারবে, যাতে একটা ভুল মাসের শেষে না, পরের দিন ধরা পড়ে

**Tier:** 1 — Runnable Code (চারটা deterministic cost model; cloud account বা Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

10.6 এর পরে TaskFlow নিরাপদে deploy করে, ছোট ছোট ধাপে, দিনে কয়েকবার। Module 10 এর শুরু থেকে system টা অনেক বড় হয়েছে: gateway আর BFF, cache ring, tracing আর collector, তিনটা AZ জুড়ে replica, CDN, secret manager, canary এর pool।

**সোমবার সকাল।** CFO এর একটা email, পুরো engineering team কে:

> "ছয় মাস আগে আমাদের cloud বিল ছিল মাসে ~$১১,০০০। গত মাসে $২৬,২৯০। একই সময়ে user বেড়েছে ৩০%। আমাদের আয় মাসে $২৬০,০০০, তাই এটা এখনই বিপদ না, কিন্তু রেখাটা ভুল দিকে যাচ্ছে। কেউ কি বলতে পারবেন টাকাটা কোথায় যাচ্ছে? আর কোন জিনিসটা আমরা আসলে কিনছি?"

কেউ পারল না। Engineer রা জানত কোন service কয়টা instance চালায়। কিন্তু বিলের ৩০% যে network এ যায়, সেটা কেউ জানত না। আর network এর কোনো লাইন কেউ কখনো design করেনি। Team এর একটা budget alert ছিল: "মাসের বিল $৩০,০০০ ছাড়ালে email।" সেটা একবারও বাজেনি।

এক সপ্তাহ ধরে দুজন engineer বিলের প্রতিটা লাইনকে তার উৎসে ফেরাল। প্রায় প্রতিটা লাইন এই course এর কোনো একটা lesson এর একটা সিদ্ধান্ত, আর তার বেশিরভাগই সঠিক সিদ্ধান্ত। শুধু কেউ তার মাসিক দাম লেখেনি।

- **Staging** prod এর মাপে, ২৪ ঘণ্টা, সাত দিন। "যাতে load test বাস্তবের মতো হয়।" Load test হয় মাসে দুবার।
- **NAT gateway** এর একটা লাইন, যার নামও অনেকে জানত না। 8.2 এর thumbnail আর export এর worker private subnet থেকে S3 পড়ে, আর প্রতিটা byte NAT দিয়ে যায়।
- **AZ জুড়ে traffic।** 9.x এর service গুলো একে অপরকে ডাকে, আর load balancer অর্ধেকের বেশি call অন্য AZ এ পাঠায়।
- **App এর ২০টা instance**, peak এর হিসাবে, সারাক্ষণ।
- **Blue-green** এর পুরনো pool যা কিছু deploy এর পরে মোছা হয়নি (10.6), আর একটা debug log যা 10.4 এর পরে কেউ বন্ধ করেনি।

Postmortem এ CTO এর এক লাইন: "আমরা latency এর budget রাখি, error এর budget রাখি। টাকার budget রাখি শুধু মাসের শেষে, একটা সংখ্যা হিসেবে, কোনো মালিক ছাড়া। Cost একটা requirement। আমরা এটাকে একটা বিস্ময় হিসেবে ব্যবহার করছিলাম।"

---

## ১. Theory

### ১.১ বিলটা পড়া — cost এর চারটা চালক

Cloud এর প্রায় প্রতিটা দাম চারটা জিনিসের একটায় বাড়ে:

```
সময়          instance-ঘণ্টা, NAT/LB/endpoint এর ঘণ্টা     — চালু থাকলেই, ব্যবহার হোক বা না হোক
জমা          GB-মাস (disk, object, backup, log)          — যতদিন রাখো
নড়াচড়া      GB transfer (internet, AZ জুড়ে, NAT দিয়ে)   — যত bytes, যত বার, যে পথে
ঘটনা         request (S3 GET/PUT, CDN, lifecycle)        — যত বার
```

Design এর প্রতিটা সিদ্ধান্ত এই চারটার কোনো একটা বা একাধিক সংখ্যা বদলায়। Exercise এর `npm run bill` TaskFlow এর পরিমাণ (৩০০ req/s, ৬০,০০০ MAU, ১৮ TB attachment, আগের lesson গুলোর সংখ্যা) আর একটা বড় public cloud এর আনুমানিক তালিকা মূল্য দিয়ে মাসিক বিল বানায়। দাম গুলো 8.1 এর সংখ্যার সাথে মেলানো, আর env দিয়ে বদলানো যায়। দাম বদলায়, তাই ডলারের চেয়ে লাইনগুলোর **অনুপাত** দেখো:

```
line                                             now   now %     after     saved                                      what changed
staging + dev (prod-sized, 24/7)              $4,701   17.9%      $420    $4,281                        ¼ size, working hours only
NAT gateway (hourly + per GB)                 $3,001   11.4%      $139    $2,862               S3 gateway endpoint, image endpoint
app instances (sized for peak, 20 24/7)       $2,803   10.7%      $869    $1,934                  autoscale (avg 7.6), 5 committed
cross-AZ: service → service                   $1,866    7.1%      $280    $1,586                                  AZ-aware routing
metric series                                 $1,800    6.8%      $900      $900                          labels cleaned up (10.4)
internet egress: API JSON                     $1,750    6.7%      $350    $1,400                             gzip/br (~5× smaller)
Postgres primary (Multi-AZ)                   $1,460    5.6%      $949      $511                                            commit
Postgres read replica ×2                      $1,460    5.6%      $949      $511                                            commit
Postgres storage (2 TB × 4 copies)              $920    3.5%      $414      $506                 activity older than 90 days in S3
log ingest + keep 90 days                       $846    3.2%    $23.13      $823    debug off, sample successful requests, 14 days
gateway + BFF + billing + files                 $771    2.9%      $501      $270                           commit (always running)
S3: attachments + old versions                  $736    2.8%      $314      $422                   lifecycle: versions 30 days, IA
Redis (cache 3 + queue 2)                       $730    2.8%      $475      $256                                            commit
undeleted blue-green pool                       $691    2.6%    $17.28      $674              teardown fixed; canary +3, 1 h a day
internet egress: attachment                     $675    2.6%      $660    $15.00                        CDN (about the same price)
backup snapshot                                 $570    2.2%      $285      $285                                 keep 30 → 14 days
background worker                               $561    2.1%      $196      $364                        spot (job idempotent, 7.4)
cross-AZ: app → database                        $415    1.6%    $82.94      $332                        a read replica in every AZ
trace collector                                 $280    1.1%      $140      $140                                       right-sized
load balancer                                   $200    0.8%      $200        $0                                                 —
S3 request                                    $45.00    0.2%    $45.00        $0                                                 —
trace storage (tail sampling)                  $9.00    0.0%     $9.00        $0                                                 —
VPC interface endpoint (image pull)               $0    0.0%    $57.90   −$57.90                                    instead of NAT
total                                        $26,290    100%    $8,276   $18,014                                          69% less

by category:  compute 18% · database 20% · network 30% · storage 3% · observability 11% · other (staging) 18%
per unit:  per workspace $13.15 → $4.14 · per MAU $0.438 → $0.138 · per 1 million requests $33.81 → $10.64
```

তিনটা জিনিস চোখে পড়ার মতো:

1. **সবচেয়ে বড় লাইন production এরই না।** Staging, ১৮%। কেউ একদিন prod এর terraform কপি করেছিল, আর সেটাই রয়ে গেছে।
2. **Network বিলের ৩০%, compute এর চেয়ে বেশি।** NAT, AZ জুড়ে call, compress না করা JSON। এই লাইনগুলো কেউ design করেনি। এগুলো আসে default থেকে (private subnet এ সব কিছু NAT দিয়ে বের হয়, load balancer যেকোনো AZ এ পাঠায়) আর অভ্যাস থেকে।
3. **২৩টা লাইনের বেশিরভাগ ঠিক করতে কোনো architecture বদলাতে হয়নি।** একটা endpoint, একটা config, একটা lifecycle rule, একটা commitment। ৬৯% কম। এর মধ্যে শুধু তিনটা লাইনে আসল design এর পরিবর্তন লেগেছে (AZ-aware routing, প্রতি AZ এ replica, activity এর offload)। এটা সাধারণ ছবি: cost এর প্রথম অর্ধেক প্রায় বিনা মূল্যে কাটা যায়, পরের অর্ধেকে design লাগে।

আর "পরে" কলামের প্রতিটা সংখ্যার পেছনে একটা trade-off আছে। সেটা ১.৭ এ।

### ১.২ Unit economics — কে কত খরচ করে

$২৬,২৯০ একটা সংখ্যা। সিদ্ধান্ত নেওয়ার জন্য সেটাকে ভাগ করতে হয়।

**Unit Economics** — মোট খরচকে ব্যবসার একটা একক দিয়ে ভাগ করা: প্রতি customer, প্রতি workspace, প্রতি seat, প্রতি request, প্রতি GB। তারপর সেই এককের আয়ের সাথে তুলনা। মোট বিল বলে "কত", unit cost বলে "এটা কি টেকসই, আর বাড়লে কী হবে"। বিল দ্বিগুণ হলো কিন্তু প্রতি workspace এর খরচ একই থাকল মানে ব্যবসা বেড়েছে। প্রতি workspace এর খরচ দ্বিগুণ হলো মানে কিছু একটা ভেঙেছে।

TaskFlow এর প্রতি workspace মাসে $১৩.১৫। কিন্তু workspace গুলো এক না। `npm run bill` অংশ খ এ বিলটা plan ধরে ভাগ করা হয়েছে। কোনো খরচ সরাসরি plan এ লেখা থাকে না, তাই প্রতিটা লাইন ভাগ হয় তার **চালক** ধরে: compute, DB আর cache request এর অনুপাতে; storage আর backup GB এর অনুপাতে; attachment এর egress GB এ; staging আর load balancer seat এ।

**Cost Allocation** — যে খরচ ভাগ করা (shared) আর কোনো একজনের নামে লেখা না, তাকে চালক ধরে দল, product, plan বা customer এর মধ্যে ভাগ করা। Cloud এ resource এর tag (`team=billing`, `env=staging`) এর ভিত্তি। ভাগ দেখানো হলে **showback**, আসলে টাকা কাটা হলে **chargeback**।

```
plan                          workspace    seat   revenue      cost    margin  cost / seat  cost / workspace
free                             1,399  25,000        $0    $8,161         —      $0.326             $5.83
free: one school district            1   3,000        $0    $1,528         —      $0.509            $1,528
pro                                500  15,000   $90,000    $7,695       91%      $0.513            $15.39
business                           100  17,000  $170,000    $8,907       95%      $0.524            $89.07
```

Pro আর business এর margin ৯০% এর উপরে। SaaS এর পক্ষে এটা স্বাস্থ্যকর, আর বিল আয়ের ১০%। আসল প্রশ্নগুলো অন্য জায়গায়:

- **Free plan মাসে $৮,১৬১**, বিলের প্রায় এক তৃতীয়াংশ, কোনো আয় ছাড়া। এটা একটা ব্যবসার সিদ্ধান্ত (free থেকে paid এ রূপান্তর), কিন্তু এখন সিদ্ধান্তটা একটা সংখ্যা নিয়ে নেওয়া যায়: প্রতি free seat মাসে $০.৩৩।
- **একটা workspace মাসে $১,৫২৮।** একটা school district, free plan এ, ৩,০০০ ছাত্র, ২ TB attachment, মাসে ১.২ TB download। বাকি free workspace গুলোর গড় $৫.৮৩, এর ২৬০ গুণ। এই একজনকে একটা পরিসংখ্যান না দেখালে খুঁজে পাওয়া যেত না। আর এর উত্তর engineering এর না, product এর: free plan এ storage আর seat এর সীমা (9.5 এর quota), বা তাদের সাথে কথা বলা।
- শেষ কলামটা দেখো: **seat প্রতি খরচ সব plan এ প্রায় সমান** ($০.৩৩–০.৫২)। খরচ seat এ বাড়ে। তাই seat ধরে দাম রাখাটা খরচের আকৃতির সাথে মেলে। Workspace প্রতি স্থির দাম হলে বড় customer লোকসানের হতো।

**Endpoint ধরে।** একই প্রশ্ন আরও সূক্ষ্মভাবে। অংশ গ তে প্রতিটা endpoint এর একটা call এর পরিবর্তনশীল খরচ: CPU এর ms, DB এর ms, বাইরে যাওয়া bytes, ভেতরের call এর bytes, NAT দিয়ে S3:

```
endpoint                    calls / month    per call   per million   monthly  % of calls  % of cost
GET /boards/:id              400,000,000  $0.0000047         $4.74    $1,895    85.096%       71%
POST /tasks                   50,000,000  $0.0000012         $1.16    $58.21    10.637%        2%
GET /search                   20,000,000  $0.0000025         $2.55    $50.96     4.255%        2%
POST /boards/:id/export           60,000      $0.011       $10,920      $655     0.013%       25%
```

Export: call এর ০.০১৩%, পরিবর্তনশীল খরচের ২৫%। একটা export এর খরচ একটা board খোলার **২,৩০০ গুণ**, কারণ সে ২০০টা file S3 থেকে NAT দিয়ে আনে, zip করে, আর ৮০ MB বাইরে পাঠায়। এর মানে এই না যে export খারাপ। এর মানে export এর জন্য আলাদা নিয়ম লাগে: rate limit (9.5 এ export ছিল দিনে ৩টা), background job (7.3), আর NAT এর বদলে endpoint (১.৫)। আর interview এ "এই feature এর দাম কত হবে" প্রশ্নের উত্তর এভাবেই শুরু হয়: একটা call এর resource, গুণ call এর সংখ্যা।

### ১.৩ Compute — peak, গড়, আর তিনটা হাতল

**Spaced repetition এর উত্তর:** গড় QPS = দিনের request ÷ ৮৬,৪০০। Peak সাধারণত গড়ের ২–৩ গুণ ধরে নেওয়া হয় (1.3), আর server এর সংখ্যা ঠিক হয় **peak** দিয়ে, কারণ peak এ capacity না থাকলে user রা ভোগে। কথাটা ঠিক। কিন্তু peak থাকে দিনের কয়েক ঘণ্টা, আর সপ্তাহের পাঁচ দিন। বাকি সময় সেই capacity এর দাম দিয়ে যাচ্ছ।

`npm run capacity` এক সপ্তাহের traffic এক মিনিট করে চালায়। দিনে দুপুর ২টায় চূড়া, রাতে আর সপ্তাহান্তে নিচু, বুধবার সকাল ১০টায় একটা marketing email (+৭০০ req/s), আর কিছু এলোমেলো ওঠানামা। গড় ৩০০ req/s, peak ১,১৫০। প্রতিটা instance ৭৫ req/s পর্যন্ত সামলায়, আর নতুন instance চালু হয়ে traffic নিতে ৫ মিনিট লাগে (10.6 এর readiness):

```
policy                                    avg instances  cost / month     avg use  strained min  overflowing req  overflow in spike  spot lost
fixed: peak + 25%, 24/7                            20.0        $2,803         20%             0       0 (0.00%)                  0          0
reactive autoscale (target 60%)                     7.6        $1,072         53%             4  15,252 (0.01%)             15,252          0
scheduled (known pattern) + reactive                8.0        $1,121         50%             3   8,713 (0.00%)              8,713          0
reactive, 70% spot                                  7.6          $942         53%             4  15,252 (0.01%)             15,252          2
```

- **স্থির fleet এর গড় ব্যবহার ২০%।** কেনা capacity এর ৮০% অলস। আর এর বিনিময়ে একটাও request উপচায়নি। এটাই এর দাম: নিশ্চয়তা।
- **Reactive autoscale:** গড়ে ৭.৬টা instance, দাম ৬২% কম। সপ্তাহে ৪ মিনিট চাপ, সব বুধবারের spike এর শুরুতে। Traffic ১০ মিনিটে ৭০০ req/s লাফায়, আর নতুন instance আসতে ৫ মিনিট লাগে। ১৫,২৫২টা request (সপ্তাহের ০.০১%) ধীর বা 503। লক্ষ্য ৬০% (১০০% না) রাখার কারণ এটাই: বাকি ৪০% হলো নতুন instance আসা পর্যন্ত টিকে থাকার headroom।
- **Scheduled + reactive:** জানা ছক (দুপুরের চূড়া) আগে থেকে ৫ মিনিট এগিয়ে চালু করা। চাপ প্রায় অর্ধেক (৮,৭১৩ বনাম ১৫,২৫২টা উপচানো request), খরচ ৫% বেশি। Marketing email টা জানা ছিল (marketing team জানত!)। Calendar এ রাখলে সেটাও scheduled হতো। Cost আর reliability এর মাঝে একটা সস্তা সেতু: team গুলোর মধ্যে কথা।
- **Spot:** একই autoscale, কিন্তু ৭০% instance spot।

**Spot Instance** — cloud provider এর অব্যবহৃত capacity, অনেক কম দামে (প্রায়ই on-demand এর ২০–৪০%), এই শর্তে যে provider সেটা অল্প নোটিশে (AWS এ ২ মিনিট) ফেরত নিতে পারে। ফেরত নেওয়া সহ্য করতে পারে এমন কাজের জন্য: stateless, idempotent, ছোট কাজ (7.4 এর worker, batch, CI)। একটা দাম বা একটা AZ এর উপর পুরো নির্ভর করা চলে না, তাই কয়েক ধরনের instance আর কয়েকটা AZ এ ছড়ানো হয়।

Spot এ খরচ আরও ১২% কম। Experiment ২ এ interruption এর হার ১৫ গুণ করলে (ঘণ্টায় প্রতি instance ৩০%) সপ্তাহে ৮৩বার instance হারায়, কিন্তু চাপের মিনিট একই, ৪। আবার সেই ৪০% headroom, আর ৩টা on-demand এর ভিত। Spot নিরাপদ হয় headroom আর stateless নকশা থেকে, ভাগ্য থেকে না।

**Commitment।** Autoscale এর পরেও একটা অংশ সবসময় চলে: রাত ৩টাতেও কয়েকটা instance। এই অংশে দ্বিতীয় হাতল:

**Commitment Discount** — এক বা তিন বছরের জন্য একটা নির্দিষ্ট পরিমাণ ব্যবহারের (ঘণ্টায় এত instance, বা ঘণ্টায় এত ডলার) প্রতিশ্রুতি দিয়ে ছাড় পাওয়া। AWS এ Reserved Instance আর Savings Plan, অন্য cloud এ committed use discount, সাধারণত ৩০–৬০%। ব্যবহার হোক বা না হোক, দাম দিতে হয়। তাই প্রশ্ন হলো **কতটা** commit করবে।

অংশ খ তে reactive এর ঘণ্টা ধরে ব্যবহার, ছাড় ৩৫% (এক বছরের আন্দাজ):

```
commit (instance)   cost / month  vs on-demand        % of hours with use ≥ commit  unused commit
0                      $1,072                  0.0%                          100%                $0
3                        $925                 13.7%                          100%                $0
4                        $894                 16.6%                           85%            $11.86
5  ← lowest            $869                 18.9%                           79%            $27.97
6                        $875                 18.3%                           54%            $63.56
8                        $943                 12.0%                           34%              $171
12                     $1,164                 −8.6%                           20%              $443
```

অঙ্কটা সুন্দর। একটা বাড়তি instance commit করলে সে প্রতি ঘণ্টায় দাম নেয় `(১ − ছাড়) × দাম`, ব্যবহার হোক বা না হোক। আর বাঁচায় পুরো দাম, শুধু যে ঘণ্টায় ব্যবহার তার উপরে। তাই সেটা লাভজনক যতক্ষণ **ব্যবহার তার উপরে থাকে ঘণ্টার `(১ − ছাড়)` এর বেশি সময়**। ৩৫% ছাড়ে সীমা ৬৫%। ৫টায় ব্যবহার ৭৯% সময় তার উপরে, তাই লাভজনক। ৬টায় ৫৪%, তাই না। Experiment ১: তিন বছরের ছাড় (৬০%) এ সীমা ৪০%, সেরা commit ৭। বেশি ছাড় মানে বেশি commit। কিন্তু তিন বছরে TaskFlow এর instance এর ধরন, region, এমনকি architecture বদলাতে পারে, আর commit থেকে যায়। এই ঝুঁকির জন্য সাধারণত নমনীয় ধরন (ডলারে commit, instance এর ধরনে না) আর একটু কম commit বেছে নেওয়া হয়।

তিনটা হাতল তাই তিনটা আলাদা অংশের জন্য:

```
instance
  ▲         ╭╮ spike
  │        ╭╯╰╮              ← on-demand (autoscale এর ওঠানামা)
  │   ╭───╯   ╰───╮          ← spot (worker, batch — বাধা সহ্য করে)
  │──╯────────────╰────── ← commitment (সবসময় চলা ভিত, "ব্যবহার ≥ c সময়ের > ১ − ছাড়")
  └──────────────────────► সময়
```

### ১.৪ Storage — tier, lifecycle, আর "সস্তা" এর ফাঁদ

8.1 এ দেখেছিলে, object storage database এর disk এর চেয়ে অনেক সস্তা। এবার object storage এর ভেতরেও tier আছে।

**Storage Tiering** — data কে তার বয়স আর ব্যবহার ধরে আলাদা দামের class এ রাখা। ঘন ঘন পড়া data দামি-দ্রুত class এ (S3 Standard), কম পড়া data সস্তা class এ (Infrequent Access, Glacier)। আর সরানোটা **lifecycle rule** দিয়ে স্বয়ংক্রিয়। সস্তা class এর প্রতি GB-মাস কম, কিন্তু তারা পড়ার জন্য (retrieval), সরানোর জন্য (transition request), আর ছোট বা স্বল্পায়ু object এর জন্য (ন্যূনতম আকার আর মেয়াদ) আলাদা দাম নেয়।

`npm run storage` অংশ ক, ২৪ মাস: শুরুতে ১৮ TB attachment আর ১৪ TB পুরনো version (8.1 এর versioning, lifecycle ছাড়া), মাসে ১.২ TB নতুন (+৩%/মাস)। File গুলো প্রথম মাসে অনেক পড়া হয়, তারপর প্রায় না। গুনতিতে ৬০% ছোট object (thumbnail, avatar, ~৪০ KB), কিন্তু bytes এ মাত্র ২.৯%:

```

```

- **পুরনো version এর lifecycle একাই এক তৃতীয়াংশ।** Versioning (8.1 এ ভুল মোছা থেকে বাঁচতে) চালু, কিন্তু পুরনো version কখনো মোছা হয় না। ২৪ মাসে ৩০.৫ TB পুরনো version, যা কেউ কখনো পড়বে না। একটা rule: "পুরনো version ৩০ দিন পরে মোছো।"
- **বয়স ধরে tier: আরও দুই-তৃতীয়াংশ।** ৩০ দিনের পরে IA, ১৮০ দিনের পরে Glacier Instant Retrieval। ২৪ মাসে $৩২,৪২৪ থেকে $৭,৪৪৫।
- **Retrieval এর ভয়টা এখানে ছোট।** মাস ১৮ এ একজন customer তার ৩ TB পুরনো file export করল, Glacier IR থেকে: $৮৮ বাড়তি। ভয়টা আসল হয় Glacier এর গভীর class এ (Deep Archive), যেখানে পড়তে ঘণ্টা লাগে আর প্রতি GB এর দাম আলাদা। সেখানে "পুরনো" কে "কখনো পড়া হবে না" ভাবা একটা বাজি।

কিন্তু তৃতীয় আর চতুর্থ সারির পার্থক্যটা দেখো: একটায় সব object IA তে যায়, আরেকটায় শুধু বড়গুলো। কেন? অংশ খ:

```
1 TB of only 40 KB objects, one year
class                                 object   billed size  in one year
Standard                          25,000,000        1.0 TB        $276
IA (with transition)              25,000,000        3.2 TB        $730
Glacier IR (with transition)      25,000,000        3.2 TB        $654
```

**"সস্তা" class এ ছোট object বেশি দামি।** IA আর Glacier IR প্রতিটা object কে অন্তত ১২৮ KB ধরে বিল করে, তাই ৪০ KB এর file ৩.২ গুণ বড় হিসাবে গোনা হয়। আর প্রতিটা object সরানো একটা request: ২.৫ কোটি transition × $০.০১/হাজার = $২৫০, একবারে। দুটো মিলিয়ে, সস্তা class এ ছোট file রাখা Standard এর চেয়ে ২.৬ গুণ দামি। Experiment ৩: object ২০০ KB হলে ফাঁদ উধাও (IA $২০০, Glacier IR $১৪৮, Standard $২৭৬)। Lifecycle rule এ তাই একটা আকারের ফিল্টার লাগে (`ObjectSizeGreaterThan`)। এই ধরনের নিয়ম শুধু "দাম প্রতি GB" দেখলে চোখে পড়ে না। এজন্য একটা model চালাতে হয়।

**Log: দাম কোথায়?** অংশ গ, 10.4 এর log:

```
per day                               GB/day  ingest / month         keep: 14 days         keep: 90 days        keep: 365 days  keep: 14 days + 1 year in S3
one line per request (10.4)              2.8          $42.00                 $1.18                 $7.56                $30.66                 $2.77
+ debug in three services               47.8            $717                $20.08                  $129                  $523                $47.34
10% sample of successful requests        1.5          $22.50                $0.630                 $4.05                $16.43                 $1.49
```

Log এর দাম **ঢোকানোয়**, রাখায় না। প্রতিটা GB index করা, parse করা আর খোঁজার যোগ্য বানানোর দাম ($০.৫০) সেই GB এক মাস রাখার দামের ($০.০৩) ১৬ গুণ। ১৪ দিন থেকে ৯০ দিনে retention বাড়ালে মাসে $৬। একটা debug log ভুলে চালু রাখলে মাসে $৬৭৫। তাই 10.4 এর নিয়মগুলো (প্রতি request এ একটা ভরা লাইন, debug শুধু flag দিয়ে আর সময় বেঁধে, সফল request এর sample) cost এর নিয়মও। আর লম্বা রাখা দরকার হলে (audit, আইন) সস্তা পথ হলো ১৪ দিন খোঁজার জায়গায়, বাকি সংকুচিত করে S3 এ।

**Database এর disk।** অংশ ঘ, 5.8 এর activity table: মাসে ৬০ GB বাড়ে, আর Postgres এ প্রতিটা GB থাকে চার জায়গায় (primary, standby, দুটো replica) আর backup এ:

```
design                                           month 1  month 24  total, 24 months  in DB, month 24
all in Postgres (4 copies + backup)                 $644    $1,410           $24,642           2.5 TB
90 days in Postgres, the rest in S3 Parquet         $102      $105            $2,481           180 GB
```

৫.৮ এর partition আর ৭.৬ এর OLAP এর যুক্তি, এবার টাকায়: ৯০ দিনের পুরনো partition `DETACH` করে Parquet এ (৬ গুণ সংকুচিত) S3 এ, আর DuckDB বা Athena এর মতো কিছু দিয়ে পড়া। দাম দশ ভাগের এক ভাগ, আর database ছোট থাকে। ছোট database মানে দ্রুত backup, দ্রুত restore, দ্রুত replica তৈরি (10.3)। Cost আর reliability এখানে একই দিকে।

### ১.৫ Data Transfer — bytes কোথায় নড়ে

**Data Transfer Cost** — bytes এক জায়গা থেকে আরেক জায়গায় যাওয়ার দাম, পথ ধরে আলাদা। Internet এ যাওয়া (egress) সবচেয়ে দামি। একই region এ AZ পেরোনো (প্রতি GB দুই দিকেই), NAT gateway দিয়ে যাওয়া (প্রতি GB processing), region পেরোনো (10.8) — প্রতিটার আলাদা দাম। Region এর ভেতরে আসা (ingress) আর একই AZ এর ভেতরে সাধারণত বিনা মূল্যে। বিলে এগুলো প্রায়ই বিভিন্ন নামে ছড়িয়ে থাকে, তাই চোখে পড়ে না।

`npm run traffic` অংশ ক, egress:

```
design                                        GB / month  cost / month  note
API JSON, no compression                        19.4 TB     $1,750  25 KB on average
API JSON, gzip/br (~5×)                           3.9 TB       $350  the CPU cost is tiny
attachments straight from S3                   7.5 TB       $687    S3 egress + GET
attachments through a CDN (hit 90%)              7.5 TB       $661  S3 → CDN assumed free within one provider
CDN + small previews on the board (40% bytes)     3.0 TB       $279   resize once, at upload time (8.2)
```

- **Compression: এক লাইনের config এ $১,৪০০।** JSON অনেক পুনরাবৃত্তিময় (একই key বারবার), তাই gzip বা brotli এ ৪–১০ গুণ ছোট হয়। Express এ `compression` middleware, বা gateway/CDN এ। CPU এর দাম আছে, কিন্তু সাধারণত সেটা bytes এর দামের চেয়ে অনেক কম।
- **CDN সবসময় সস্তা না।** একই provider এর CDN এর প্রতি GB এর দাম S3 এর egress এর প্রায় সমান, আর request এর fee যোগ হয়। CDN এর আসল লাভ ছিল latency আর origin এর চাপ (4.5, 8.2), আর DDoS (10.5)। টাকা বাঁচে বড় আয়তনে দাম কমার স্তরে, বা অন্য provider এ। "CDN দিলে খরচ কমবে" দাবিটা যাচাই না করে করবে না।
- **Byte না পাঠানোই সবচেয়ে সস্তা।** Board এ ৩ MB এর আসল ছবির বদলে ২০০ KB এর preview। 8.2 এর resize, upload এর সময় একবার। Bytes ৬০% কম, আর page দ্রুত।

**NAT gateway, অংশ খ।** Private subnet এর instance (যাদের সরাসরি internet এ যাওয়ার পথ নেই, যেটা নিরাপত্তার জন্য সঠিক) বাইরে যায় NAT gateway দিয়ে। আর NAT প্রতি GB process করার দাম নেয়, গন্তব্য যা-ই হোক। **এমনকি একই region এর S3 এর জন্যও।**

```
design                                      GB / month  cost / month  note
everything through NAT, one NAT per AZ    64.5 TB     $3,001  today's TaskFlow
+ S3 gateway endpoint                           4.5 TB       $301  the gateway endpoint is free
+ an interface endpoint for images               900 GB       $197  hourly + per GB, less than NAT
+ smaller images (500 → 150 MB)                 900 GB       $172  multi-stage build, runtime only
everything through NAT, but one NAT for three AZs  64.5 TB     $3,795  fewer NAT hours, more cross-AZ, a SPOF in one AZ
with endpoints, one NAT for three AZs           900 GB       $143  cheap — but if that AZ dies, nothing gets out
```

S3 এর জন্য একটা **gateway endpoint** (VPC এর route table এ একটা লাইন, বিনা মূল্যে) মাসে ~$২,৭০০ বাঁচায়। TaskFlow এর বিলের সবচেয়ে সস্তা জয়। আর শেষ দুটো সারি একটা ফাঁদ দেখায়। "তিনটা NAT এর বদলে একটা" শুনতে সাশ্রয়ী, কিন্তু অন্য দুই AZ এর traffic কে NAT এর AZ এ যেতে হয় (cross-AZ এর দাম), তাই বেশি traffic এ সেটা **বেশি** দামি ($৩,৭৯৫)। Endpoint এর পরে traffic কম, তখন একটা NAT সত্যিই সস্তা ($১৪৩ বনাম $১৯৭)। কিন্তু 10.3 এর ভাষায়, সেই AZ মরলে বাকি দুই AZ এর বাইরে যাওয়ার পথ বন্ধ: Stripe, email provider, সব। মাসে $৫৪ বাঁচাতে একটা AZ এর outage কে পুরো system এর outage বানানো। এটা cost আর reliability এর একটা খাঁটি বিনিময়, আর উত্তর নির্ভর করে বাইরের call গুলো hard না soft dependency কিনা তার উপর।

**AZ জুড়ে, অংশ গ।** প্রতিটা request এ ৬টা ভেতরের call (৩০ KB করে) আর DB তে ৪০ KB, তিনটা AZ:

```
design                                 GB / month  cost / month  note
monolith: internal calls are function calls  20.7 TB       $415  only app → primary
services, sent to any AZ           114.0 TB     $2,281  67% of internal calls to another AZ
services, same AZ first (AZ-aware)       34.7 TB       $695  10% to another AZ (fallback)
+ a read replica in every AZ           18.1 TB       $363  reads in their own AZ, writes to the primary
```

9.1 এর "network call function call না" এর আরেকটা মাত্রা: সে টাকাও নেয়। Load balancer যদি AZ না দেখে পাঠায়, তিনটা AZ এ দুই-তৃতীয়াংশ call অন্য AZ এ যায়, আর প্রতি GB দুই দিকেই দাম। Experiment ৪: প্রতি request এ ২০টা call হলে $৬,৬৩৬, monolith এর ১৬ গুণ। **AZ-aware routing** (একই AZ এর instance আগে, না থাকলে অন্য AZ) এটা দুই-তৃতীয়াংশ কাটে। Kubernetes এ topology-aware routing, service mesh এ locality-weighted load balancing। আর এর একটা reliability এর দামও আছে: এক AZ এ traffic বেশি এলে সেই AZ এর instance গুলো চাপে পড়ে, যদিও অন্য AZ খালি। তাই এই routing এর সাথে প্রতিটা AZ এর আলাদা autoscale আর একটা সীমা লাগে ("নিজের AZ এর instance ৮০% এর বেশি ব্যস্ত হলে অন্য AZ এ পাঠাও")। (Latency ও কমে, কারণ একই AZ এর ভেতরে round trip সাধারণত কম। এখানে মাপা না।)

### ১.৬ নিরাপত্তা আর দৃশ্যমানতার দাম — আর একটা DDoS এর বিল

10.4 আর 10.5 এ বেশ কয়েকবার বলেছিলাম "এর দাম আছে"। এবার সংখ্যায়।

**Observability:** বিলের ১১%। Metric series ($১,৮০০, 10.4 এর cardinality: প্রতিটা series এর মাসিক দাম আছে, আর অপ্রয়োজনীয় label এর পুরনো experiment এখনও চলছে), log ($৮৪৬, ভুলে যাওয়া debug), trace collector ($২৮০)। লক্ষ করো, tail sampling এর পরে **trace জমার দাম মাসে $৯**। 10.4 এর tail sampling এর দাম জমায় না, collector এর compute এ ($২৮০)। Observability এর খরচের একটা সাধারণ নিয়ম আছে, আর সেটা সাধারণত বিলের ৫–১৫% এর মধ্যে দেখা যায়। TaskFlow এর ১১% ঠিক আছে, কিন্তু তার অর্ধেক ছিল অপচয়।

**DDoS এর বিল।** 10.5 এর L7 flood: ৬০,০০০ req/s, ৪ ঘণ্টা, প্রতি উত্তর ৩০ KB। `npm run capacity` অংশ গ:

```
where it stopped                                extra instances   compute  data transfer   request fees     total
autoscale at the origin, no limit                         1,334    $1,025        $2,333             $0    $3,357
autoscale at the origin, limit 40                            40    $30.72          $117             $0      $147
answered from CDN cache (cache key fixed)                     0        $0        $2,203           $648    $2,851
block / challenge at the edge (1 KB answer)                   0        $0        $73.44           $648      $721
```

একটা চার ঘণ্টার আক্রমণ, বিল $৭২১ থেকে $৩,৩৫৭, নির্ভর করে কোথায় থামালে। Autoscale এর সীমা ছাড়া system টা আক্রমণকে **খুশি মনে সেবা দেয়**, আর বিল পাঠায়। (বাস্তবে database অনেক আগেই ভেঙে পড়ত, 10.3।) সীমা ৪০ এ বিল $১৪৭, কিন্তু origin আক্রমণে ভরা, তাই বৈধ user দের বেশিরভাগ request ও ব্যর্থ (10.5 এর অংশ গ)। CDN cache থেকে উত্তর দিলে origin বাঁচে, কিন্তু CDN এর egress আর request এর fee দিতে হয়। সবচেয়ে সস্তা হলো আক্রমণকে **ছোট** উত্তর দেওয়া, edge এ। আর একটা জিনিস এখানে তালিকা মূল্যে ধরা নেই: অনেক CDN আর DDoS সুরক্ষার service আক্রমণের traffic এর বিল মাফ করে বা আলাদা চুক্তিতে রাখে। তাদের শর্ত দেখো (এখানে যাচাই করা না)। শিক্ষা: **autoscaling এর একটা উপরের সীমা একটা cost এর নিয়ন্ত্রণ**, যেমন 10.3 এর bulkhead একটা reliability এর নিয়ন্ত্রণ।

### ১.৭ Cost কে নজরে রাখা — anomaly, মালিক, আর trade-off

TaskFlow এর budget alert ছিল: মাসের বিল $৩০,০০০ ছাড়ালে email। সেটা ছয় মাসে একবারও বাজেনি। অথচ বিল আড়াই গুণ হয়েছে। কেন?

`npm run bill` অংশ ঘ তে ৬০ দিনের দৈনিক বিল, ভাগ ধরে (compute, database, network, storage, log, …)। প্রতিটার নিজের দৈনিক ওঠানামা আর ধীর বৃদ্ধি আছে, আর "পরে" এর পরিষ্কার অবস্থা থেকে শুরু (দিনে ~$২৮৭)। দিন ৪২ এ কেউ তিনটা service এ debug log চালু করে ভুলে যায় (+$২২.৫০/দিন, মোটের ৭.৮%)। দিন ৫১ এ একটা bug এ export একটা loop এ পড়ে (+$২৭০/দিন, NAT আর egress এ)। চারটা detector:

```
detector                                       caught debug logs  caught export loop  false alarms (days 1–40)
over the monthly budget (last month +10%)    missed      6 days later                   0
end-of-month forecast > budget                 9 days later    1 day later                    0
total daily > 7-day average × 1.2               missed      1 day later                    0
each category daily > its own 7-day average × 1.5  1 day later     1 day later                    0
```

**Cost Anomaly Detection** — বিলকে মাসের শেষে একটা সংখ্যা হিসেবে না দেখে, দৈনিক (বা ঘণ্টায়) একটা সময়-সারি হিসেবে দেখা, ভাগ ধরে (service, team, লাইন), আর প্রতিটাকে তার নিজের ইতিহাসের সাথে তুলনা করা। মোট বিলে ছোট একটা লাফ হারিয়ে যায়; তার নিজের ভাগে সেটা দশ গুণ।

চেনা লাগছে? 10.4 এ গড় latency p99 লুকিয়েছিল। 10.6 এ মোট error rate segment এর bug লুকিয়েছিল। এখানে মোট বিল একটা লাইনের দশ গুণ বৃদ্ধি লুকায়। Debug log মোট বিলে ৮%, মাসের budget এ কখনো ধরা পড়ে না। কিন্তু log এর নিজের লাইনে সে **৩০ গুণ** (দিনে $০.৭৭ থেকে $২৩), আর ভাগ ধরে দেখা detector পরের দিনই ধরে। আর বড় ঘটনাটাও (export loop) মাসিক budget এ ধরা পড়ে **৬ দিন** পরে, মানে $১,৬০০ পরে। যে alert মাসে একবার একটা সংখ্যা দেখে, সে আসলে একটা হিসাব, নজরদারি না।

এর পেছনের অভ্যাস গুলোর একটা নাম আছে, **FinOps**: cost কে engineering এর একটা দৈনিক কাজ বানানো। প্রতিটা resource এ tag (team, service, env), যাতে বিল ভাগ করা যায় (১.২)। প্রতিটা team এর নিজের খরচের dashboard আর মালিক। Unit cost কে একটা metric হিসেবে track করা। আর design review তে একটা প্রশ্ন: "এর মাসিক দাম কত, আর সেটা কীসে বাড়ে?"

**Trade-off।** "পরে" কলামের প্রায় প্রতিটা সংখ্যার একটা দাম আছে, আর সেই দাম প্রায়ই reliability বা গতিতে:

| সাশ্রয়                         | কত (মাসে)    | কী হারায়                                                       | কখন মূল্যবান                                         |
| ------------------------------- | ------------ | --------------------------------------------------------------- | ---------------------------------------------------- |
| Staging ¼ মাপে, শুধু কাজের সময় | $৪,২৮১       | Load test আর বাস্তবের মিল; রাতের job এর পরীক্ষা                 | প্রায় সবসময়; load test এর জন্য আলাদা, অস্থায়ী env |
| S3 gateway endpoint             | ~$২,৭০০      | প্রায় কিছুই না                                                 | সবসময়                                               |
| Autoscale (স্থিরের বদলে)        | $১,৯৩৪       | Spike এর শুরুতে কয়েক মিনিট চাপ; নতুন instance এর boot এর ঝুঁকি | যখন traffic ওঠানামা করে আর boot দ্রুত                |
| Commitment                      | ~১৯% compute | নমনীয়তা — ১–৩ বছর বাঁধা                                        | সবসময় চলা ভিতে, একটু কম commit                      |
| Spot (worker)                   | $৩৬৪         | Interruption — idempotent, ছোট job না হলে ক্ষতি                 | 7.4 এর worker, batch, CI                             |
| AZ-aware routing                | $১,৫৮৬       | AZ এর মধ্যে ভারসাম্য; একটা AZ এ চাপ জমতে পারে                   | যখন ভেতরের call বেশি                                 |
| একটাই NAT                       | $৫৪          | এক AZ মরলে সবার বাইরে যাওয়া বন্ধ                               | প্রায় কখনো না, production এ                         |
| Log sample, ১৪ দিন              | $৮২৩         | পুরনো আর বিরল ঘটনার log                                         | error আর ধীর সবসময় রাখলে                            |
| Storage tier                    | ~$৪২২        | পুরনো file পড়তে retrieval এর দাম আর (গভীর class এ) সময়        | file এর আকারের ফিল্টার সহ                            |

একটা নীতি এই টেবিল থেকে বেরিয়ে আসে: **যে সাশ্রয় শুধু অপচয় কাটে (staging, endpoint, debug log, না-মোছা pool, compression), সেটা আগে।** যে সাশ্রয় reliability বিক্রি করে (একটা NAT, replica কমানো, Multi-AZ বাদ), সেটা শুধু error budget (1.5) এর হিসাব দিয়ে, আর সংখ্যা দিয়ে: "মাসে $৫৪ বাঁচাতে বছরে কত ঘণ্টা outage এর ঝুঁকি নিচ্ছি, আর তার দাম কত?"

### ১.৮ TaskFlow এর সিদ্ধান্ত

> **Trade-off Table — cost এর তিনটা প্রশ্ন, প্রতিটা নকশায়**

| প্রশ্ন                     | কোথায় দেখবে                         | TaskFlow এ কী বদলাল                                    |
| -------------------------- | ------------------------------------ | ------------------------------------------------------ |
| "এটা কোন চালকে বাড়ে?"     | সময় / জমা / নড়াচড়া / ঘটনা         | প্রতিটা design doc এ এক লাইনের cost এর অনুমান          |
| "প্রতি একক কত?"            | Unit cost: workspace, seat, endpoint | Plan ধরে showback, export এর সীমা, free plan এর quota  |
| "কে জানবে যখন এটা বদলায়?" | Tag, ভাগ ধরে দৈনিক anomaly, মালিক    | প্রতিটা team এর dashboard, ভাগ ধরে alert, মাসিক review |

**Compute:** App এ autoscale (লক্ষ্য ৬০%, min ৩, max ৪০), জানা চূড়া আর marketing এর ঘটনা scheduled। সবসময় চলা ভিতে এক বছরের নমনীয় commitment, ঘণ্টার ব্যবহারের ৭৫–৮০% percentile এর কাছে (মাপা নিয়মের চেয়ে একটু কম)। Worker আর CI spot এ, কয়েক ধরনের instance আর তিনটা AZ এ। Staging ¼ মাপে, রাত আর সপ্তাহান্তে বন্ধ, load test এর জন্য দরকারমতো পুরো মাপের একটা অস্থায়ী env। Blue-green এর pool deploy এর শেষে স্বয়ংক্রিয়ভাবে মোছে (10.6 এর pipeline এর ধাপ)।

**Network:** S3 এর gateway endpoint, container image এর interface endpoint, image ছোট করা। প্রতি AZ এ একটা NAT (থাকছে, reliability এর জন্য)। API এ compression। Service এর মধ্যে AZ-aware routing, প্রতিটা AZ এর নিজের autoscale আর ৮০% এর সীমা। প্রতি AZ এ একটা read replica। Board এ preview, আসল ছবি না।

**Storage:** S3 lifecycle: পুরনো version ৩০ দিনে মোছা, ≥১২৮ KB এর object ৩০ দিনে IA আর ১৮০ দিনে Glacier IR। ছোট object Standard এ থাকে। Activity এর ৯০ দিনের পুরনো partition Parquet এ S3 তে। Backup ১৪ দিন, আর মাসিক একটা দীর্ঘমেয়াদি copy সস্তা storage এ।

**Observability:** Debug log শুধু flag দিয়ে, ৩০ মিনিটে বন্ধ (10.4 এর নিয়ম, এবার CI তে test সহ)। সফল request এর log এর ১০% sample, error আর ধীর সব। ১৪ দিন খোঁজার জায়গায়, তারপর S3 এ। Metric এর label পরিষ্কার, প্রতি metric এ series এর সীমা।

**নজরদারি:** প্রতিটা resource এ `team`, `service`, `env` tag। CI তে tag ছাড়া resource আটকায়। দৈনিক cost, ভাগ ধরে, প্রতিটার নিজের ৭ দিনের গড়ের সাথে তুলনা, ১.৫ গুণ হলে সেই team এর কাছে ticket। মাসের budget এর forecast এর alert। প্রতি মাসে ৩০ মিনিটের একটা review: unit cost এর রেখা, সবচেয়ে বড় পাঁচটা পরিবর্তন। Autoscale এর সর্বোচ্চ সীমা প্রতিটা service এ, DDoS আর runaway loop এর জন্য। আর design review এর template এ একটা নতুন অংশ: "মাসিক দাম আর তার চালক।"

---

## ২. Interview Angle

Cost প্রায় কখনো আলাদা প্রশ্ন হয় না। আসে দুইভাবে। প্রথমত estimation এর ভেতরে: "এটা চালাতে কত খরচ হবে?" দ্বিতীয়ত trade-off এর সময়: "তুমি তিনটা replica রাখছ, কেন দুটো না?", "এটা কি serverless এ সস্তা হবে?" Senior level এ প্রায়ই সরাসরি: "এই system এর খরচ অর্ধেক করতে বলা হলো, কোথা থেকে শুরু করবে?" দুর্বল উত্তর হলো "reserved instance কিনব, spot ব্যবহার করব।" ভালো উত্তরের আকৃতি:

1. **আগে মাপো, তারপর কাটো।** "বিলটা চালক ধরে ভাগ করব: compute, storage, network, observability। সাধারণত সবচেয়ে বড় বিস্ময় network আর non-production এ।" Unit cost দিয়ে বলো: প্রতি user বা প্রতি request।
2. **অপচয় আগে, reliability পরে।** অলস resource, পুরনো data, default network এর পথ (NAT, cross-AZ), compression। তারপর autoscale, commitment, spot, প্রতিটা নিজের অংশে।
3. **প্রতিটা কাটার দাম বলো।** "একটা NAT এ $৫৪ বাঁচে, কিন্তু একটা AZ এর outage সবার outage হয়।" Cost আর reliability এর বিনিময়, error budget এর ভাষায়।
4. **নজরদারি।** Tag, ভাগ ধরে দৈনিক anomaly, team এর মালিকানা। এক বারের কাটা আবার বেড়ে যায়, যদি কেউ না দেখে।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Reserved/savings plan কতটা কিনবে?"_ — সবসময় চলা ভিতের জন্য। নিয়ম: যেখানে ব্যবহার `(১ − ছাড়)` এর বেশি সময় থাকে। TaskFlow এ ৩৫% ছাড়ে ৫টা, যেখানে গড় ৭.৬। আর নমনীয় ধরন বাছো।
- _"Spot কোথায়?"_ — Stateless, idempotent, বাধা সহ্য করে এমন কাজে: worker, batch, CI। Headroom আর কয়েক ধরনের instance এর সাথে। Database বা একমাত্র instance এ না।
- _"Microservices কি দামি?"_ — প্রতিটা ভেতরের call এর network এর দাম আছে, AZ পেরোলে আরও। AZ-aware routing, কম আর মোটা call। আর প্রতিটা service এর ন্যূনতম capacity, monitoring আর মানুষের দাম।
- _"Data কোথায় রাখবে?"_ — বয়স আর ব্যবহার ধরে tier, lifecycle দিয়ে। আর তিনটা লুকানো দাম জানো: ন্যূনতম object আকার, transition request, retrieval।
- _"Serverless কি সস্তা?"_ — কম বা অনিয়মিত traffic এ হ্যাঁ, কারণ অলস সময়ের দাম নেই। স্থির, বেশি traffic এ প্রায়ই না, কারণ প্রতি request এর দাম instance এর চেয়ে বেশি। দুটো রেখা আঁকো আর কোথায় কাটে বলো। (এখানে মাপা না।)

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ঘটনাগুলো: prod এর মাপের staging, ২৪/৭। NAT দিয়ে S3 বা container image এর traffic। Cross-AZ এর call যা কেউ জানে না। Lifecycle ছাড়া versioning। Debug log আর অপ্রয়োজনীয় metric label। মোছা হয়নি এমন snapshot, volume, load balancer, IP (মোছা instance এর উচ্ছিষ্ট)। Autoscale এর সর্বোচ্চ সীমা ছাড়া একটা loop। আর মাসিক budget alert, যা একমাত্র নজরদারি।

---

## ৩. Key Takeaway

- **Cost একটা requirement, latency আর availability এর মতো।** প্রতিটা design এর সিদ্ধান্ত চারটা চালকের একটা বদলায়: সময়, জমা, নড়াচড়া, ঘটনা। TaskFlow এর বিলের সবচেয়ে বড় লাইনগুলো (staging ১৮%, NAT ১১%, cross-AZ ৭%) কেউ design করেনি, আর ৬৯% এর বেশিরভাগ কাটতে কোনো architecture বদলাতে হয়নি
- **Unit economics সিদ্ধান্ত নেওয়ায়।** প্রতি workspace $১৩.১৫ গড়, কিন্তু একটা free workspace $১,৫২৮। Export call এর ০.০১৩%, পরিবর্তনশীল খরচের ২৫%। Seat প্রতি খরচ সব plan এ প্রায় সমান, তাই seat ধরে দাম খরচের আকৃতির সাথে মেলে
- **Peak এর জন্য কেনা capacity এর ৮০% অলস।** Autoscale ওঠানামার অংশে (৬২% কম, সপ্তাহে ৪ মিনিট চাপ)। Commitment সবসময় চলা ভিতে (ব্যবহার ≥ c থাকে `(১ − ছাড়)` এর বেশি সময়, TaskFlow এ ৫টা)। Spot বাধা সহ্য করে এমন অংশে, headroom সহ
- **Storage class এর দাম শুধু GB-মাস না।** পুরনো version এর lifecycle আর বয়স ধরে tier ২৪ মাসে $৩২,৪২৪ কে $৭,৪৪৫ করে। কিন্তু ছোট object এ "সস্তা" class ২.৬ গুণ দামি (১২৮ KB এর ন্যূনতম + transition)। আর log এর দাম ঢোকানোয়, রাখায় না
- **Bytes কোথায় নড়ে, সেটাই প্রায়ই সবচেয়ে বড় লুকানো খরচ।** Compression এ $১,৪০০, S3 gateway endpoint এ ~$২,৭০০, AZ-aware routing আর প্রতি AZ এ replica এ ~$১,৯০০। CDN সবসময় সস্তা না। আর একটা NAT মাসে $৫৪ বাঁচায়, একটা AZ এর outage কে সবার বানিয়ে
- **একটা DDoS এর বিল ঠিক হয় কোথায় থামালে।** সীমাহীন autoscale এ $৩,৩৫৭, edge এ ছোট উত্তরে $৭২১। Autoscale এর সর্বোচ্চ সীমা একটা cost এর নিয়ন্ত্রণ
- **মোট বিল একটা লাইনের লাফ লুকায়।** মাসিক budget alert debug log কখনো ধরে না, export এর loop ধরে ৬ দিনে। ভাগ ধরে, নিজের ইতিহাসের সাথে তুলনা পরের দিন ধরে। Tag, মালিক আর দৈনিক নজরদারি (FinOps)

---

## ৪. নতুন Term (Glossary)

| Term                       | অর্থ                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit Economics**         | মোট খরচকে ব্যবসার একটা একক (customer, workspace, seat, request) দিয়ে ভাগ করে সেই এককের আয়ের সাথে তুলনা; মোট বিল বলে "কত", unit cost বলে "টেকসই কিনা, আর বাড়লে কী হবে"                  |
| **Cost Allocation**        | ভাগ করা খরচকে চালক (request, GB, seat) ধরে team, product, plan বা customer এর মধ্যে ভাগ করা; resource এর tag এর উপর দাঁড়ানো। দেখানো হলে showback, টাকা কাটা হলে chargeback               |
| **Commitment Discount**    | ১–৩ বছরের নির্দিষ্ট ব্যবহারের প্রতিশ্রুতিতে ছাড় (Reserved Instance, Savings Plan); ব্যবহার না হলেও দাম। একটা বাড়তি commit লাভজনক যতক্ষণ ব্যবহার তার উপরে থাকে `(১ − ছাড়)` এর বেশি সময় |
| **Spot Instance**          | Provider এর অব্যবহৃত capacity, অনেক কম দামে, অল্প নোটিশে ফেরত নেওয়া যায়; stateless, idempotent, বাধা সহ্য করে এমন কাজে (worker, batch, CI), headroom আর কয়েক ধরনের instance সহ         |
| **Data Transfer Cost**     | Bytes এর পথ ধরে দাম: internet এ egress সবচেয়ে দামি, AZ পেরোনো দুই দিকেই, NAT দিয়ে প্রতি GB processing, region পেরোনো আলাদা; ingress আর একই AZ সাধারণত বিনা মূল্যে                       |
| **Storage Tiering**        | Data কে বয়স আর ব্যবহার ধরে দামি-দ্রুত থেকে সস্তা-ধীর class এ সরানো, lifecycle rule দিয়ে; সস্তা class এর লুকানো দাম: ন্যূনতম object আকার আর মেয়াদ, transition request, retrieval        |
| **Cost Anomaly Detection** | বিলকে দৈনিক সময়-সারি হিসেবে, ভাগ ধরে (service, team, লাইন) দেখা, প্রতিটাকে নিজের ইতিহাসের সাথে তুলনা; মোট বিলে হারানো ছোট লাফ নিজের ভাগে বড় — মাসিক budget alert নজরদারি না, হিসাব      |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. Product team একটা নতুন feature চায়: প্রতিদিন সকালে প্রত্যেক user কে একটা "আজকের board" digest email। ৬০,০০০ MAU। প্রতিটা digest এর জন্য replica তে ৫০ ms এর query, ২০ ms render, email ২০ KB। Email provider এর দাম প্রতি ১,০০০ email এ $০.১০ (ধরে নেওয়া)। (ক) মাসিক খরচের একটা হিসাব করো, চালক ধরে। কোন চালক সবচেয়ে বড়? (খ) Free plan এর ২৮,০০০ user এর জন্য এটা কি দেওয়া উচিত, আর কোন নকশায় খরচ অর্ধেক হয় feature না মেরে? (গ) এই feature এর জন্য একটা cost এর alert কী হবে, আর কোন একটা bug তাকে রাতারাতি দশ গুণ করতে পারে?

2. TaskFlow এর traffic মাসে ৫% করে বাড়ছে। CFO জিজ্ঞেস করলেন: "তিন বছরের commitment এ ৬০% ছাড়, এক বছরের এ ৩৫%। আমরা কেন তিন বছরের পুরোটা কিনছি না, আজকের peak এর সমান?" (ক) "আজকের peak এর সমান" এর সমস্যা কী, `npm run capacity` এর অংশ খ এর সংখ্যা দিয়ে? (খ) বৃদ্ধি থাকলে কতটা আর কবে commit করবে? (গ) তিন বছরে কী কী বদলাতে পারে যা commit কে অকেজো করে, আর কোন ধরনের commit সেই ঝুঁকি কমায়?

3. CFO আরও ৩০% কমাতে বললেন। চারটা প্রস্তাব এলো: (১) app এর সব instance spot এ, (২) Multi-AZ standby বাদ দেওয়া, (৩) দুটো read replica এর একটা বাদ, (৪) metric এর retention ১৩ মাস থেকে ১ মাস। প্রতিটার জন্য: কত বাঁচে (বিলের সংখ্যা দিয়ে), কী হারায় (10.3 আর 1.5 এর ভাষায়), আর তোমার সিদ্ধান্ত। শেষে CFO কে এক অনুচ্ছেদে উত্তর লেখো।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) প্রতিদিন ৬০,০০০ digest, মাসে ১৮ লাখ:

```
email provider:   1.8M ÷ 1,000 × $0.10                          = $180
DB (replica):     1.8M × 50 ms = 90,000 s CPU-ish ≈ 25 ঘণ্টা — replica তে আগে থেকেই খালি ক্ষমতা থাকলে ~$0;
                  না থাকলে সকালে একটা চূড়া: 60,000 query কে ১ ঘণ্টায় ছড়ালে ~17 query/s, সহজ
render (worker):  1.8M × 20 ms = 10 ঘণ্টা worker → spot এ ~$1
egress:           email provider এ পাঠানো 1.8M × 20 KB = 36 GB × $0.09 (NAT দিয়ে গেলে +$0.045) ≈ $5
log:              প্রতি email এ একটা লাইন, 1.8M × 350 B = 0.6 GB × $0.5 ≈ $0.3
মোট ≈ $190 / মাস — প্রায় পুরোটা email provider
```

সবচেয়ে বড় চালক **ঘটনা** (email এর সংখ্যা), compute না। এটা একটা সাধারণ ছবি: বাইরের API (email, SMS, push, LLM) প্রতি call এর দাম নেয়, আর সেটাই খরচের আকৃতি ঠিক করে।

(খ) Free plan এর ২৮,০০০ user এ ~$৯০/মাস। ছোট, কিন্তু প্রশ্নটা অনুপাতের: free user এর **সক্রিয়** অংশই digest পড়বে। নকশা যা খরচ কমায়, feature না মেরে:

- শুধু গত ৭ দিনে সক্রিয় user কে পাঠাও, আর যার board এ গতকাল কিছু বদলায়নি তাকে না ("আজ কিছু নেই" email কেউ চায় না)। সাধারণত সংখ্যা অর্ধেকের নিচে নামে।
- Free plan এ সাপ্তাহিক digest, paid এ দৈনিক। খরচ free এ ৭ ভাগের এক ভাগ, আর upgrade এর একটা কারণ।
- User নিজে বন্ধ করতে পারে (আর না খোলা email ৩০ দিন পরে নিজে বন্ধ)।

(গ) Alert: digest এর দৈনিক সংখ্যা, আর email provider এর দৈনিক খরচ, নিজের ৭ দিনের গড়ের সাথে (১.৭ এর detector)। একটা ভালো alert হলো "পাঠানো email ÷ MAU > ১.১" — প্রতি user এ একটার বেশি মানে কিছু ভুল। রাতারাতি দশ গুণ করার bug: **retry এ duplicate** — job টা ব্যর্থ হয়ে আবার চলে, আর idempotency ছাড়া (7.4) প্রতিটা retry আবার সবাইকে পাঠায়। বা একটা loop যা প্রতি workspace এর প্রতি member কে প্রতি board এর জন্য আলাদা email পাঠায়। Idempotency key (`digest:{userId}:{date}`) আর একটা দৈনিক উপরের সীমা ("আজ ১,০০,০০০ এর বেশি না") দুটোই লাগে।

**প্রশ্ন ২:**

(ক) "আজকের peak এর সমান" মানে ২০টা (অংশ ক এর স্থির fleet এর মাপ)। অংশ খ এর টেবিলে ছাড় ৩৫% এ ১২টা commit ইতিমধ্যে on-demand এর চেয়ে **৮.৬% বেশি দামি**। ২১টা এ ৭৮.৫% বেশি। ছাড় ৬০% হলেও (experiment ১) ২১টা এ ৯.৯% বেশি। Peak থাকে সপ্তাহের ২০% এর কম সময়, তাই সেই capacity এর commitment বছরের বেশিরভাগ সময় অব্যবহৃত। Commit করতে হয় ভিত, চূড়া না।

(খ) বৃদ্ধি থাকলে ভিত বাড়ে, তাই commit একবারে না, **সিঁড়ির মতো**: আজ নিয়ম অনুযায়ী মাপা পরিমাণ (৩৫% এ ৫টা, বা একটু কম), তারপর প্রতি ৩–৬ মাসে নতুন ব্যবহার দেখে আরেকটা ছোট commitment যোগ, নিজের মেয়াদে। এতে প্রতিটা ধাপ তখনকার ভিতের সাথে মেলে, আর মেয়াদ গুলো আলাদা সময়ে শেষ হয় (একবারে সব নবায়নের চাপ নেই)। তিন বছরের ছাড় নেবে শুধু ভিতের সেই অংশে যা তুমি প্রায় নিশ্চিত তিন বছর থাকবে (ধরো database, বা app এর ন্যূনতম ৩টা)। বাকিটা এক বছরে।

(গ) তিন বছরে যা বদলাতে পারে: instance এর নতুন প্রজন্ম বা ধরন (ARM এ গেলে দাম ২০% কম, আর পুরনো ধরনের reservation অকেজো), region (10.8 এ দ্বিতীয় region), architecture (কিছু অংশ serverless বা container platform এ), ব্যবসা (traffic না বাড়া, বা একটা বড় customer চলে যাওয়া), আর দাম নিজেই (cloud এর তালিকা মূল্য সময়ের সাথে প্রায়ই কমে)। ঝুঁকি কমায় **নমনীয় commitment**: নির্দিষ্ট instance এর ধরনে না, ঘণ্টায় এত **ডলারের** compute এর প্রতিশ্রুতি (AWS এর Compute Savings Plan এর মতো), যা ধরন, আকার, region, এমনকি কিছু serverless এও খাটে। ছাড় একটু কম, কিন্তু ভবিষ্যতের ভুলের দাম অনেক কম।

**প্রশ্ন ৩:**

(১) **সব app instance spot এ:** app এর লাইন $৮৬৯ (commit সহ) থেকে আরও ~$৪০০ কম হতে পারে। কিন্তু commitment আর spot একসাথে চলে না, তাই আসল সাশ্রয় কম, আর ৩টা on-demand এর ভিত হারায়। Spot এর অনেক instance একসাথে ফেরত নেওয়া হতে পারে (একই ধরনের instance, একই AZ এ চাহিদা বাড়লে)। তখন app এর capacity হঠাৎ অর্ধেক, ৫ মিনিটের boot এর মধ্যে user রা ভোগে। Experiment ২ এ ৮৩টা interruption সহ্য হয়েছিল, কারণ ৩টা on-demand এর ভিত আর ৪০% headroom ছিল। সব spot হলে এই নিশ্চয়তা যায়। **সিদ্ধান্ত:** না। ভিত on-demand + commitment, উপরের ওঠানামার একটা অংশ spot এ (কয়েক ধরনের instance, তিন AZ এ), worker সব spot এ।

(২) **Multi-AZ standby বাদ:** primary এর লাইন $১,৪৬০ এর অর্ধেক, commit সহ ~$৪৭৫/মাস বাঁচে। হারায়: primary এর AZ বা machine মরলে স্বয়ংক্রিয় failover (১–২ মিনিট) এর বদলে replica কে হাতে promote করা, বা backup থেকে restore। ঘণ্টার outage, আর async replica থেকে promote করলে শেষ কয়েক সেকেন্ডের লেখা হারানোর সম্ভাবনা (5.7, 6.1)। 99.9% এর SLO এ মাসের error budget ৪৩ মিনিট। একটা failover এর ঘটনাই তা শেষ করে। **সিদ্ধান্ত:** না। Production এর primary database হলো সেই জায়গা যেখানে redundancy কেনা হয়। Staging এ হ্যাঁ।

(৩) **একটা read replica বাদ:** commit সহ ~$৪৭৫ বাঁচে। হারায়: পড়ার ক্ষমতা অর্ধেক (একটা replica এ সব read), একটা replica এর রক্ষণাবেক্ষণ বা মৃত্যুর সময় সব read primary তে (5.7)। আর ১.৫ এর "প্রতি AZ এ replica" এর cross-AZ এর সাশ্রয় কমে। **সিদ্ধান্ত:** মেপে দেখো। Replica গুলোর CPU কত? যদি দুটোই ৩০% এর নিচে, তাহলে replica গুলো ছোট করা (কম vCPU) একটা বাদ দেওয়ার চেয়ে ভালো: খরচ কাছাকাছি কমে, redundancy থাকে।

(৪) **Metric এর retention ১৩ মাস → ১ মাস:** metric এর দাম সাধারণত series এর সংখ্যায়, retention এ কম (১.৪ এর log এর যুক্তি)। তাই সাশ্রয় সম্ভবত ছোট, provider এর দামের কাঠামো দেখে বলতে হবে। হারায়: বছর-থেকে-বছর তুলনা, capacity planning (গত বছরের নভেম্বরের চূড়া), ধীর regression খোঁজা। **সিদ্ধান্ত:** না, তার বদলে পুরনো data কে downsample করো (১৩ মাস রাখো, কিন্তু ৩০ দিনের পরে ১ ঘণ্টার resolution এ)। জায়গা আর দাম অনেক কম, দীর্ঘমেয়াদি তুলনা থাকে।

**CFO কে উত্তর:** "আমরা ইতিমধ্যে বিল ৬৯% কমিয়েছি ($২৬,২৯০ → $৮,২৭৬, আয়ের ১০% থেকে ৩%)। প্রায় সবটাই অপচয় কেটে, reliability এ কোনো ছাড় ছাড়া। চারটা নতুন প্রস্তাবের তিনটা (সব spot, Multi-AZ বাদ, replica বাদ) একসাথে মাসে ~$১,৩০০ বাঁচায়, কিন্তু প্রতিটা একটা নির্দিষ্ট ব্যর্থতাকে ঘণ্টার outage বানায়। আমাদের ৯৯.৯% এর প্রতিশ্রুতিতে তার একটাই মাসের পুরো error budget খেয়ে ফেলে, আর business plan এর customer দের SLA এর ক্ষতিপূরণ এক ঘটনায় এর চেয়ে বেশি। চতুর্থটার (metric) বদলে আমরা downsample করব। বাকি সুযোগ আছে replica এর মাপ ঠিক করা আর free plan এর storage এর সীমায় (school district একাই মাসে $১,৫২৮)। সেটা product এর সিদ্ধান্ত, আর আমরা সংখ্যা দিতে পারি। আর এখন থেকে প্রতিটা team এর নিজের খরচের dashboard আর দৈনিক alert আছে, যাতে এই কথোপকথন ছয় মাস পরে না, ছয় দিনে হয়।"

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (চারটা deterministic cost model; cloud account বা Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.7-cost/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.7-cost) — `npm install`, তারপর `npm run bill`, `npm run capacity`, `npm run storage`, `npm run traffic`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`bill` TaskFlow এর মাসিক বিল ২৩টা লাইনে বানায় (আগে আর পরে), plan আর endpoint ধরে ভাগ করে, আর ৬০ দিনের দৈনিক বিলে চারটা anomaly detector চালায়। `capacity` এক সপ্তাহের traffic এক মিনিট করে চালায় চারটা নীতিতে, commitment এর পরিমাণ খোঁজে, আর একটা DDoS এর বিল চার জায়গায় থামিয়ে মাপে। `storage` ২৪ মাসে attachment এর lifecycle, ছোট object এর ফাঁদ, log এর ঢোকানো বনাম রাখা, আর activity এর offload মাপে। `traffic` egress, NAT বনাম endpoint আর AZ জুড়ে traffic এর নকশা তুলনা করে। `bill` এর app এর লাইন `capacity` এর একই model থেকে আসে (`src/fleet.ts`)।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ তোমার। **সব দাম আনুমানিক**। একটা বড় public cloud এর তালিকা মূল্যের আন্দাজ, 8.1 এর সংখ্যার সাথে মেলানো, `src/prices.ts` এ এক জায়গায়, আর এখানে যাচাই করা না। আসল দাম region, provider, আয়তনের স্তর আর চুক্তি ভেদে বদলায়। **TaskFlow এর পরিমাণ গুলোও ধরে নেওয়া** (৩০০ req/s, প্রতি request এ ৬টা ভেতরের call আর ৩০ KB, ৬০ TB S3 এর traffic NAT দিয়ে, free plan এর ভাগ, endpoint এর CPU আর DB এর ms, email এর দাম), আগের lesson গুলোর সংখ্যা থেকে। CFO এর email এর "ছয় মাস আগে $১১,০০০" গল্পের অংশ, মাপা না। Plan ধরে খরচের ভাগ একটা নির্দিষ্ট চালকের নিয়মে (request, GB, seat)। অন্য নিয়মে অন্য সংখ্যা আসবে। `capacity` একটা simulation: spot এর interruption ঘণ্টা প্রতি একটা সম্ভাবনা, instance এর boot ৫ মিনিট, আসল autoscaler এর আচরণ আলাদা হতে পারে। **যা মাপা হয়নি:** আসল cloud বিল, serverless এর দাম, latency এর উপর AZ-aware routing এর প্রভাব, DDoS এর সুরক্ষায় বিল মাফের শর্ত, CDN এর আয়তনের ছাড়। ১.৮ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** `bill` চালানোর **আগে** লিখে ফেলো: TaskFlow এর বিলের সবচেয়ে বড় তিনটা লাইন কী হবে, আর network এর ভাগ কত %? তারপর চালিয়ে মেলাও। কোন লাইন তোমাকে সবচেয়ে অবাক করল, আর কেন সেটা কেউ design করেনি?

2. **নিজের commitment:** `COMMIT_DISCOUNT=0.6 npm run capacity` আর `COMMIT_DISCOUNT=0.2 npm run capacity`। সেরা commit কীভাবে বদলায়? "ব্যবহার ≥ c সময়ের কত %" এর কলাম আর `(১ − ছাড়)` এর নিয়ম মিলিয়ে দেখো।

3. **নিজের lifecycle rule:** `src/storage.ts` এ একটা নতুন নীতি যোগ করো: ৯০ দিনে IA, ৩৬৫ দিনে Glacier IR, আর ছোট object কখনো না। ২৪ মাসের মোট কত? তারপর `EXPORT_GB=20000` দিয়ে দেখো: retrieval কোন বিন্দু থেকে tier এর সাশ্রয় খেয়ে ফেলে?

4. **একটা feature এর দাম:** `src/bill.ts` এর `ENDPOINTS` এ reflection question ১ এর digest যোগ করো (`callsPerMonth: 1_800_000`, DB আর CPU এর ms, ২০ KB বাইরে) আর একটা email provider এর খরচের লাইন। তোমার হাতের হিসাব আর model মেলে?

5. **Design অংশ:** TaskFlow এর জন্য এক পাতার "cost নীতি"। (ক) প্রতিটা resource এর tag এর তালিকা আর CI তে কীভাবে বাধ্য করবে। (খ) তিনটা unit cost এর metric, আর প্রতিটার জন্য কোন পরিবর্তনে কে জাগবে (ticket, page না)। (গ) Design review এর template এ cost এর অংশে কোন তিনটা প্রশ্ন থাকবে। (ঘ) কোন সাশ্রয় কখনো করা হবে না (reliability এর রেখা), আর কেন। (ঙ) Free plan এর জন্য দুটো সীমা, unit economics এর সংখ্যা দিয়ে যুক্তি সহ।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ), 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
Current: 10.7 — Cost & cloud economics
TaskFlow state: modular monolith + billing; gateway + BFF; saga; breaker + bulkhead; rate limit; cache ring;
Bloom/HLL; hard/soft dependency + brownout; OpenTelemetry, burn rate alert; AuthN/AuthZ, OAuth PKCE, secret
manager, DDoS এর স্তর; graceful shutdown, canary + gate, flag, expand/contract। বিল ছয় মাসে ~$১১k → $২৬,২৯০
(user +৩০%), কেউ জানত না কোথায়; budget alert কখনো বাজেনি। লাইন ধরে: staging prod এর মাপে ২৪/৭ (১৮%), NAT
দিয়ে S3 আর image (১১%), peak ধরে ২০টা app instance (গড় ব্যবহার ২০%), cross-AZ call, metric label, compress
না করা JSON, version এর lifecycle নেই, না-মোছা blue-green pool, ভুলে যাওয়া debug log। এখন ($৮,২৭৬, ৬৯% কম):
app autoscale (৬০%, min ৩, max ৪০) + scheduled + ৫টা নমনীয় commit; worker আর CI spot এ; staging ¼, রাতে বন্ধ;
S3 gateway endpoint + image endpoint, প্রতি AZ এ NAT রাখা; compression; AZ-aware routing (AZ ধরে autoscale,
৮০% সীমা) + প্রতি AZ এ read replica; preview; S3 lifecycle (version ৩০ দিন, ≥১২৮ KB IA ৩০ দিন, Glacier IR
১৮০ দিন); activity ৯০ দিনের পরে Parquet এ S3; backup ১৪ দিন; log sample + ১৪ দিন; metric label পরিষ্কার।
নজরদারি: team/service/env tag (CI তে বাধ্য), plan আর endpoint ধরে unit cost, ভাগ ধরে দৈনিক anomaly (নিজের
৭ দিনের গড় × ১.৫), budget forecast, autoscale এর সর্বোচ্চ সীমা, design review এ "মাসিক দাম আর চালক"।
Free plan: school district একাই $১,৫২৮/মাস — storage আর seat এর সীমা product এর সিদ্ধান্ত।
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7), Deploy / Release, Blue-Green Deployment, Canary Release, Feature Flag,
Version Skew, Lock Queue, Expand / Contract, Unit Economics, Cost Allocation, Commitment Discount, Spot
Instance, Data Transfer Cost, Storage Tiering, Cost Anomaly Detection
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 10.8 — Multi-region & geo-distribution
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **cost একটা requirement, আর বিলের প্রতিটা লাইন একটা design এর সিদ্ধান্ত যার দাম কেউ লেখেনি।** সবচেয়ে বড় লাইনগুলো আসে default আর অভ্যাস থেকে: staging, NAT, AZ জুড়ে call। খরচকে একক ধরে ভাগ করলে সিদ্ধান্ত নেওয়া যায়। Compute এর তিনটা হাতল তিনটা আলাদা অংশের জন্য। "সস্তা" class এর লুকানো দাম আছে। Bytes কোথায় নড়ে সেটাই প্রায়ই সবচেয়ে বড় বিস্ময়। আর মাসের শেষের একটা সংখ্যা নজরদারি না।

আজ একটা দাম বারবার এসেছে কিন্তু আমরা তার পুরোটা দেখিনি: AZ পেরোনোর দাম। এক region এর তিনটা AZ এর মধ্যে, কয়েক মাইল দূরে, এক মিলিসেকেন্ডের round trip। এবার ভাবো দুটো region, Dhaka আর Frankfurt, হাজার কিলোমিটার দূরে, প্রতি round trip এ ১৫০ ms। TaskFlow এর ইউরোপের একজন বড় customer বলেছে তাদের data ইউরোপের বাইরে যেতে পারবে না। আর Singapore এর user রা অভিযোগ করছে board খুলতে ৮০০ ms। রেডি হলে `next` লিখো — **Lesson 10.8: Multi-Region & Geo-Distribution** এ যাব। সেখানে প্রশ্নটা: একটা system কে একাধিক region এ চালালে কী কী আবার কঠিন হয়ে যায় (consistency, লেখা কোথায় যাবে, failover, data কোথায় থাকবে), আর কখন সেটা দাম আর জটিলতার যোগ্য। আর কখন না।
