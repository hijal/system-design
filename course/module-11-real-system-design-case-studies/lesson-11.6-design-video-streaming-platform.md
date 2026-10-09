# Lesson 11.6 - Case Study: Design a Video Streaming Platform

**Module 11 - Real System Design Case Studies**

> **Spaced Repetition (Lesson 4.5):** একটা file এর নাম না বদলে তার ভেতরের content বদলালে CDN এ কী সমস্যা হয়? আর `Cache-Control: immutable` আর নামের মধ্যে version (hash) রাখা কীভাবে সেটা সমাধান করে? আজ একটা video কয়েক হাজার টুকরোয় ভাঙবে, যাদের নাম কখনো বদলায় না, আর একটা ছোট playlist, যেটা বদলায়। কোনটা কতক্ষণ cache হবে, সেটা এই প্রশ্নের উত্তর থেকে আসে।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 4.5 (CDN, Cache-Control), Lesson 7.3 (Background job), Lesson 7.4 (Retry, idempotency), Lesson 8.1 (Object storage), Lesson 8.2 (Presigned, multipart upload), Lesson 10.7 (Cost, spot, storage tier), Lesson 11.1 (Zipf, cache), Lesson 11.4 (Power law)

**আপনি এই lesson শেষে পারবেন:**

1. একটা video platform এর খরচের আকৃতি সংখ্যা দিয়ে বলতে পারবেন: egress বিলের প্রায় সবটা, transcoding প্রায় কিছুই না, আর তাই কেন প্রতিটা bit বাঁচানো (codec, bitrate ladder, ABR) সরাসরি টাকা
2. একটা transcoding pipeline নকশা করতে পারবেন: video কে টুকরো করে parallel এ, spot worker এর বাধা সহ্য করে, আগে কম quality তে "দেখা যায়" করে, idempotent কাজ দিয়ে; আর HLS/DASH এর manifest কী, আর কোন অংশ কতক্ষণ cache হয়
3. Player এর দিকের adaptive bitrate এর trade-off (rebuffer বনাম quality বনাম বারবার বদল) মাপতে পারবেন, আর জনপ্রিয়তার তীক্ষ্ণ বণ্টন থেকে সিদ্ধান্ত নিতে পারবেন: কোন video edge এ, কোনটা দামি codec এ, আর লম্বা লেজের জন্য কোন সস্তা পথ

**Tier:** 1 - Runnable Code (চারটা deterministic model আর একটা আসল Express + Zod VOD service, HLS এর playlist সহ; Docker বা ffmpeg লাগে না)

---

## ০. আজকের System

Interviewer:

> "YouTube এর মতো একটা video platform design করুন। Creator upload করে, দর্শক দেখে। ফোনে, TV তে, খারাপ network এ।"

এর আগের case study গুলোতে data ছোট ছিল: একটা URL, একটা message, একটা post এর id। এবার একটা জিনিস কয়েক GB, আর একই জিনিস লাখ মানুষ দেখে। 8.1 এর object storage, 8.2 এর upload, 4.5 এর CDN, আর 10.7 এর data transfer এর খরচ এক জায়গায় আসে। প্রথম চাল প্রায়ই: "Upload S3 তে, CDN দিয়ে file টা serve করুন।" এখান থেকে প্রশ্ন:

- "একটা 4K এর ১ ঘণ্টার file ১৫ GB। ফোনের 3G তে দর্শক কী দেখবে?"
- "Upload এর পরে video কখন দেখা যাবে? এক ঘণ্টা?"
- "মাসের বিলে সবচেয়ে বড় লাইন কোনটা হবে?"
- "দশ কোটি video এর মধ্যে কোনগুলো CDN এ রাখবেন?"
- "Live streaming?" (আজ না, শেষে এক লাইন)

---

## ১. Theory

### ১.১ Step 1 - Requirement

```
প্রশ্ন                                       ধরে নিলাম
কত দর্শক?                                    ২০ কোটি DAU, দিনে গড়ে ১ ঘণ্টা
কত upload?                                   প্রতি মিনিটে ৩০০ ঘণ্টার video
কোন device আর network?                       ফোন থেকে TV, 3G থেকে fiber - একই video কয়েকটা quality তে
কত দ্রুত দেখা যাবে upload এর পরে?            কয়েক মিনিটে, অন্তত কম quality তে
Video শুরু হতে কতক্ষণ?                        ~১-২ s; দেখার মাঝে আটকানো (rebuffer) যত কম সম্ভব
বাদ দিলাম                                   live streaming, recommendation, comment, monetization, copyright এর scan
```

**Non-functional:** দেখার অভিজ্ঞতা প্রথম (শুরুর দেরি আর rebuffer দর্শক হারানোর সবচেয়ে বড় কারণ), upload কখনো হারাবে না (creator এর কাজ), আর খরচ - কারণ এই system এ খরচ সবচেয়ে বড় constraint, পরের অংশ দেখুন।

### ১.২ Step 2 - Estimation: বিলটা কার

`npm run estimate`:

```
── Part A - watching: 200 million DAU, 60 minutes a day on average, 3 Mbps on average ──
data out per day (egress)                                       270 PB
average bandwidth                                              25 Tbps
peak bandwidth (2.5×)                                          63 Tbps   beyond any single data center
watching at once (peak)                                   20.8 million

── Part B - uploads: 300 hours of video every minute ──
uploaded per day                                         432,000 hours
stored (original 20 + all resolutions 10.4 Mbps)            5.9 PB/day   2157 PB a year
transcoding (4 CPU-hours per hour)                        72,000 cores   running all the time

── Part C - monthly cost (approximate prices) ──
CDN egress ($0.01/GB)                                $81,000,000     78.2%
storage, one year's accumulation ($0.01/GB-month)          $21,570,624     20.8%
transcoding ($0.02/CPU-hour)                                $1,036,800      1.0%

the cost of watching one hour: $0.0135 egress - for every viewer, every time.
the cost of transcoding one hour: $0.08 - once. 6 hours watched = one hour transcoded.
```

1. **Egress বিলের ৭৮%।** **Egress** - data center বা CDN থেকে বাইরে (দর্শকের কাছে) যাওয়া data, যার প্রতি GB এর দাম দিতে হয়; video তে প্রতিটা দর্শক প্রতিবার দেখায় পুরো দাম। দিনে ২৭০ PB, peak এ ৬৩ Tbps, যা কোনো একটা data center এর network থেকে বের করা অসম্ভব। তাই CDN এখানে optimization না, বাধ্যতামূলক, আর অনেক বড় platform নিজেদের cache server ISP এর ভেতরে বসায় (Netflix এর Open Connect এর কথা তাদের প্রকাশিত লেখায় আছে)।
2. **Transcoding বিলের ১%।** ৭২,০০০ core শুনতে বিশাল, কিন্তু টাকায় ছোট। এর মানে: **encode এ বেশি খরচ করে যদি bit বাঁচে, প্রায় সবসময় লাভ।** এক ঘণ্টা transcode এর দাম ৬ ঘণ্টা দেখার egress এর সমান। একটা জনপ্রিয় video লাখ ঘণ্টা দেখা হয়। ১.৬ এ এই হিসাব।
3. **Storage প্রতিদিন বাড়ে।** দিনে ৬ PB, কখনো মোছা হয় না, তাই বছরে বছরে বিলের এই লাইন বাড়তেই থাকে। পুরনো আর অজনপ্রিয় video এর জন্য সস্তা storage tier (10.7) আর কম resolution।
4. **২ কোটি মানুষ একসাথে দেখছে।** কিন্তু এদের বেশিরভাগ একই অল্প কিছু video দেখছে (১.৬), যেটা CDN কে সম্ভব করে।

### ১.৩ Step 3 - High-level design

```
 creator ──presigned multipart upload (8.2)──► [object storage: মূল file]
                                                     │ event
                                                     ▼
                                    [transcoding pipeline]
                     split ──► [টুকরো × resolution এর কাজ, queue এ] ──► package (HLS/DASH)
                                     │  spot worker × শত শত
                                     ▼
                       [object storage: টুকরো + playlist]   [metadata DB: video, অবস্থা]
                                     │
                       [origin shield (4.5)] ──► [CDN edge / ISP এর ভেতরের cache] ──► দর্শকের player
                                                                                           │
                                                          ABR: প্রতি টুকরোয় quality বাছে ◄─┘
```

দুটো term, যা বাকি সবকিছুর ভিত্তি:

**Bitrate Ladder** - একই video এর কয়েকটা সংস্করণ, আলাদা resolution আর bitrate এ (এখানে 240p ০.৪ Mbps থেকে 1080p ৫ Mbps, পাঁচ ধাপ)। Player তার network অনুযায়ী একটা বাছে। Ladder এর ধাপ যত বেশি, তত মসৃণ, কিন্তু encode আর storage তত বেশি। আর কোনো কোনো platform প্রতিটা video এর জন্য আলাদা ladder বানায় (একটা cartoon কম bit এ একই quality দেয়, একটা খেলার video বেশি চায়) - "per-title encoding"।

**Manifest (HLS / DASH)** - video টা কীভাবে ভাগ করা আর কোথায় পাওয়া যাবে তার একটা ছোট text file। HLS এ একটা **master playlist** (কোন কোন quality আছে, প্রতিটার bandwidth আর resolution) আর প্রতিটা quality র একটা **media playlist** (টুকরো গুলোর তালিকা, প্রতিটা কয়েক সেকেন্ডের)। Player আগে master পড়ে, একটা quality বাছে, তার media playlist পড়ে, তারপর টুকরো গুলো একটা একটা করে আনে, প্রতিটা আলাদা HTTP request হিসেবে। এর সবচেয়ে বড় সুবিধা: **প্রতিটা টুকরো একটা সাধারণ static file**, তাই যেকোনো CDN কোনো বিশেষ server ছাড়াই serve করতে পারে।

### ১.৪ Deep dive ১ - Transcoding pipeline

Upload এর মূল file (প্রায়ই ১৫-২০ Mbps এর বড় file) থেকে ladder এর পাঁচটা সংস্করণ বানানো, এক ঘণ্টার video তে ৪ CPU-ঘণ্টা। `npm run transcode`: ৪০টা এক ঘণ্টার upload, **spot worker** (10.7: অনেক সস্তা, কিন্তু cloud যেকোনো সময় কেড়ে নিতে পারে; এখানে CPU-ঘণ্টায় গড়ে ০.২ বার), আর কেড়ে নিলে worker আবার চালু হতে ২০ s:

```
plan                                                        publish p50        p99  360p watchable  wasted CPU
one worker, the whole video, one resolution after another          4.0 h     10.6 h        27.3 min      13.72%
one worker per resolution (5)                                     2.1 h      3.0 h        18.1 min      13.72%
4 s pieces, 100 workers                                         2.9 min    3.0 min            38 s       0.02%
the same, but 360p pieces first                                 2.9 min    3.0 min            32 s       0.02%
```

- **পুরো video একটা কাজ:** চার ঘণ্টা, আর spot এর একটা বাধায় সেই resolution এর পুরো কাজ নষ্ট। p99 **১০.৬ ঘণ্টা**, CPU এর ১৪% আবর্জনা। Experiment ২: বাধা ঘণ্টায় ১ বার হলে p99 ২৫ ঘণ্টা, নষ্ট ৬০%।
- **Resolution প্রতি worker:** দ্রুততম হয় সবচেয়ে ধীর resolution (1080p, ২ ঘণ্টা)। একই নষ্ট।
- **Segment-Parallel Transcoding** - video কে ছোট টুকরোয় (এখানে ৪ s, keyframe এর সীমায়) ভাগ করে প্রতিটা টুকরো × resolution কে একটা আলাদা কাজ বানানো; শত শত worker একসাথে চালায়, আর শেষে টুকরো গুলো playlist এ জোড়া হয়। এক ঘণ্টার video **৩ মিনিটে**, আর spot এর বাধায় শুধু সেই ৪ সেকেন্ডের টুকরো আবার: নষ্ট ০.০২%। এই একটা সিদ্ধান্ত spot worker কে সস্তা আর নিরাপদ দুটোই বানায়। Netflix এর মতো platform এর প্রকাশিত encoding এর pipeline এই আকারের।
- **কম quality আগে:** video টা "দেখা যায়" (360p আর 240p তৈরি) ৩২-৩৮ সেকেন্ডে। Creator প্রায় সাথে সাথে link share করতে পারে, আর 1080p কয়েক মিনিট পরে আসে। ১০০ worker এ ক্রম প্রায় কিছু বদলায় না (সব কিছু এমনিতেই দ্রুত), কিন্তু experiment ১ এ ২০টা worker এ এটা ১.৭ থেকে ১.৩ মিনিট: worker কম বা queue ব্যস্ত হলে এই অগ্রাধিকার কাজে লাগে।

দাম: টুকরো ভাগ করা আর জোড়া লাগানোর জটিলতা (প্রতিটা টুকরো keyframe দিয়ে শুরু হতে হয়, নইলে জোড়ায় ঝাঁকুনি), আর অনেক ছোট কাজের ব্যবস্থাপনা। প্রতিটা কাজ **idempotent**: output এর নাম `video/resolution/টুকরো` দিয়ে ঠিক, তাই queue একই কাজ দুবার দিলে (7.4 এর at-least-once) দ্বিতীয়বার কিছু লেখা হয় না (smoke এর ধাপ ১২)।

### ১.৫ Deep dive ২ - Adaptive bitrate: player এর সিদ্ধান্ত

Ladder আর টুকরো থাকলে, কোন quality দেখাবে সেটা প্রতি টুকরোয় player ঠিক করে। **Adaptive Bitrate (ABR)** - player প্রতিটা টুকরো আনার আগে তার network এর মাপা গতি আর buffer এ কতটা জমা আছে দেখে ladder থেকে একটা quality বাছে; network খারাপ হলে নামে, ভালো হলে ওঠে। আর তার মূল ব্যর্থতা: **Rebuffer Ratio** - দেখার সময়ের কত ভাগ buffer খালি হয়ে video থেমে ছিল (চাকা ঘুরছে)। দর্শক কম quality তে খুশি থাকে, থেমে যাওয়ায় চলে যায়।

`npm run abr`: ৩০০টা session, ১০ মিনিটের video, ৪ s এর টুকরো, একটা mobile network যা ০.৪ থেকে ১২ Mbps এর মধ্যে ওঠানামা করে:

```
policy                                                                start-up delay    stalled  avg bitrate  quality switches
always 1080p                                                                   5.4 s     32.63%   5.00 Mbps               0.0
always 240p                                                                    0.4 s      0.00%   0.40 Mbps               0.0
throughput: the highest under 80% of the last 3 rates                          0.8 s      0.22%   2.35 Mbps              32.9
buffer: lowest below 8 s, highest at 24 s                                      0.4 s      0.40%   3.06 Mbps              46.9
mixed: throughput, drop when the buffer is low, climb step by step             0.4 s      0.08%   2.32 Mbps              34.5
```

- **সবসময় সর্বোচ্চ:** দেখার সময়ের **এক-তৃতীয়াংশ** থেমে থাকে। ১৫ GB এর file সরাসরি দেওয়ার ফল এটাই।
- **সবসময় সর্বনিম্ন:** কখনো থামে না, কিন্তু 240p তে সবাই।
- **Throughput ভিত্তিক:** শেষ কয়েকটা টুকরোর গতি মেপে তার ৮০% এর নিচে সবচেয়ে ভালোটা। ০.২২% আটকে, গড় ২.৩৫ Mbps। ২০% এর ফাঁক কেন: experiment ৩ এ ১০০% নিলে rebuffer তিন গুণ (০.৬০%), কারণ মাপা গতি সবসময় একটু পুরনো আর network ঠিক তখনই খারাপ হতে পারে।
- **Buffer ভিত্তিক:** গতি না মেপে buffer দেখে: buffer কম তো কম quality, বেশি তো বেশি। গড় bitrate সবচেয়ে বেশি (৩.০৬), কিন্তু বেশি বদল (৪৭ বার), আর বারবার quality লাফানো চোখে পড়ে।
- **মিশ্র:** throughput এর হিসাব, কিন্তু buffer খুব কম হলে সাথে সাথে নামুন, আর উঠুন এক ধাপ করে। Rebuffer **০.০৮%**, সবচেয়ে কম। প্রকাশিত player গুলোর algorithm এর আকৃতি এরকম মিশ্রণই।

আর একটা নকশাগত দিক: টুকরোর দৈর্ঘ্য। ছোট টুকরো (২ s) মানে quality দ্রুত বদলানো আর দ্রুত শুরু, কিন্তু বেশি request আর encode এর দক্ষতা কম (প্রতিটা টুকরো একটা keyframe দিয়ে শুরু, keyframe দামি)। বড় টুকরো (১০ s) উল্টো। ২-৬ s সাধারণ।

### ১.৬ Deep dive ৩ - জনপ্রিয়তা: কী কোথায় রাখব, আর কাকে দামি codec

11.1 আর 11.4 এর মতো, জনপ্রিয়তা তীক্ষ্ণ। `npm run cdn`: ১০ কোটি video (গড়ে ১০ মিনিট), মাসে ৬০০ কোটি ঘণ্টা দেখা, Zipf (s = ১.২):

```
most popular                           video  share of watching  space at the edge (all resolutions)
0.1%                                 103,359       92.4%                     80.6 TB
1%                                 1,023,965       96.1%                      799 TB
10%                             10.1 million              98.5%                               7.9 PB

videos not watched even once a month (approx.): 4.0%
videos whose monthly watching egress costs less than their transcode: 62.1%
```

- **০.১% video তে ৯২% দেখা,** আর তাদের সব resolution মিলে মাত্র ৮১ TB। এটা প্রতিটা বড় edge location এ ধরে। তাই CDN এর hit rate video তে খুব উঁচু হয়, আর origin এর চাপ ছোট। (এটা "সবচেয়ে জনপ্রিয় গুলো রাখলে" এর আদর্শ হিসাব; আসল LRU একটু কম পায়, আর নতুন জনপ্রিয় video এর প্রথম কয়েক মিনিট origin থেকে আসে, 4.5 এর origin shield সেই ঢেউ শোষে।)
- **লম্বা লেজ:** ৬২% video এর এক মাসের পুরো দেখার egress তাদের একবারের transcode এর খরচের চেয়ে কম। সব video কে সব resolution এ আগে থেকে বানানো তাদের জন্য অপচয়। সস্তা পথ: অজনপ্রিয় video এর জন্য কম ধাপের ladder, আর বাকি ধাপ প্রথম চাহিদায় বানানো (just-in-time), বা জনপ্রিয় হলে পরে যোগ করা।

**Popularity-Tiered Encoding** - video এর জনপ্রিয়তা অনুযায়ী encode এর খরচ বাছা: সবাই একটা সস্তা, দ্রুত codec (H.264) পায়; জনপ্রিয় হয়ে উঠলে সেটাকে দামি কিন্তু দক্ষ codec এ (যেমন AV1, একই quality তে প্রায় ৩০% কম bit, কিন্তু encode অনেক গুণ দামি) আবার encode করা। কারণ ১.২: encode একবার, egress প্রতিবার। অংশ খ:

```
extra encode for a 10-minute video: $0.120; saved per hour watched $0.00405
break-even: at ~30 hours watched a month (assuming it pays back within a month)

policy                                     video  extra encode/month  egress saved/month           net
all videos                           100 million         $12,000,000         $24,300,000   $12,300,000
over 30 hours a month                  2,235,202            $268,224         $23,589,440   $23,321,215
over 296 hours a month                   333,367             $40,004         $22,971,363   $22,931,359
```

সব video কে AV1 এ নিলেও লাভ (নিট $১.২৩ কোটি)। কিন্তু শুধু মাসে ৩০ ঘণ্টার বেশি দেখা ২২ লাখ video (২.২%) কে নিলে **প্রায় দ্বিগুণ লাভ** ($২.৩৩ কোটি), কারণ তারা প্রায় সব সাশ্রয় দেয় আর বাড়তি encode এর মাত্র ২%। Experiment ৪: encode ৩০ গুণ দামি হলে সব video তে AV1 **ক্ষতি** (−$১.৪৪ কোটি), কিন্তু জনপ্রিয়তে এখনও +$২.৩ কোটি। আর বাস্তবে আরেকটা দিক: AV1 সব device decode করতে পারে না, তাই H.264 এর কপি সবসময় থাকে, আর AV1 একটা বাড়তি কপি শুধু যাদের device পারে।

### ১.৭ একটা আসল VOD service

`npm run smoke` একটা Express service চালায়: upload এর পরে টুকরো × resolution এর কাজ queue তে, worker হাতে চালানো, অবস্থা (`uploaded → processing → playable → ready`), আর আসল HLS এর master আর media playlist:

```
#   step                                            result
1   upload done, jobs in the pipeline          id 1; 75 jobs in the queue (15 pieces × 5)
2   master playlist, nothing built yet                    404
3   30 jobs (360p and 240p first)                         playable (30/75)
4   the master playlist now                               240p/index.m3u8, 360p/index.m3u8; Cache-Control: public, max-age=2
5   the remaining jobs; the worker on 720p piece 3 died   ready; failed 1, ran 76
6   master playlist (ready)                           Cache-Control: public, max-age=86400
                                                      #EXTM3U
                                                      #EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=427x240
                                                      240p/index.m3u8
                                                      …
                                                      #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
                                                      1080p/index.m3u8
7   480p's playlist (first 5 lines)                       #EXTM3U | #EXT-X-TARGETDURATION:4 | #EXT-X-PLAYLIST-TYPE:VOD | #EXTINF:4.0, | 0.ts
8   player, network 1 Mbps (80% rule)                     360p; first piece 400 B
9   player, network 3 Mbps (80% rule)                     480p; first piece 700 B
10  player, network 8 Mbps (80% rule)                     1080p; first piece 2500 B
11  a piece's Cache-Control                               public, max-age=31536000, immutable
12  the queue handed out the same job again (at-least-once)  75 new writes in total, 1 skipped
```

**Spaced repetition এর উত্তর:** নাম না বদলে content বদলালে CDN এর edge গুলো পুরনোটা দিতে থাকে TTL শেষ না হওয়া পর্যন্ত, আর purge (4.5) ধীর আর অনিশ্চিত। সমাধান: content বদলালে নামও বদলান (version বা hash), আর সেই নামের জিনিস `immutable`, চিরকাল cache। এখানে প্রতিটা টুকরো তৈরির পরে কখনো বদলায় না, তাই এক বছর আর `immutable` (ধাপ ১১)। কিন্তু master playlist processing এর সময় বদলায় (প্রথমে দুটো quality, পরে পাঁচটা), তাই তখন `max-age=2` (ধাপ ৪), আর `ready` হলে এক দিন (ধাপ ৬)। ভুলটা হতো processing এর সময়ের master কে এক দিন cache করা: দর্শকেরা এক দিন 360p এর বেশি পেত না।

ধাপ ৫: একটা worker মরল, শুধু সেই একটা টুকরো আবার (৭৬টা কাজ, ৭৫টা দরকারি)। ধাপ ৮-১০: একই master থেকে তিনটা network এ তিনটা quality, ১.৫ এর ৮০% নিয়মে।

### ১.৮ Step 5 - Trade-off আর wrap-up

**চূড়ান্ত নকশা:**

- **Upload:** presigned multipart (8.2), মূল file টেকসই storage এ; তারপর একটা event।
- **Pipeline:** ৪ s এর টুকরো × ladder, spot worker এ, idempotent output; 360p আর 240p আগে (কয়েক সেকেন্ডে playable), বাকিটা কয়েক মিনিটে। অজনপ্রিয়দের জন্য ছোট ladder, জনপ্রিয় হলে বাকি ধাপ আর AV1।
- **Delivery:** HLS/DASH; টুকরো `immutable`, playlist ছোট TTL যতক্ষণ বদলাতে পারে; origin shield, CDN, আর বড় মাপে ISP এর ভেতরের cache।
- **Player:** মিশ্র ABR (throughput + buffer এর নিরাপত্তা + ধাপে ধাপে ওঠা), ২-৬ s এর টুকরো।
- **Storage:** মূল file আর জনপ্রিয়দের সব ধাপ; পুরনো আর অজনপ্রিয়দের সস্তা tier এ, কম ধাপে।

> **Trade-off Table - video এর বড় সিদ্ধান্ত**

| সিদ্ধান্ত | বেছে নিলাম                        | বিকল্প                     | কী দিলাম                                | কী পেলাম                                                |
| --------- | --------------------------------- | -------------------------- | --------------------------------------- | ------------------------------------------------------- |
| Pipeline  | ৪ s এর টুকরো, শত worker, spot     | পুরো video একটা কাজ        | টুকরো ভাগ আর জোড়ার জটিলতা              | ৪ ঘণ্টা → ৩ মিনিট; spot এ নষ্ট ১৪% → ০.০২%              |
| প্রথমে কী | 240p/360p আগে                     | সব একসাথে                  | প্রথম কয়েক মিনিট HD নেই                | ~৩০ s এ দেখা যায়                                       |
| Player    | মিশ্র ABR                         | সর্বোচ্চ বা throughput একা | কিছুটা কম গড় bitrate                   | Rebuffer ৩৩% (সর্বোচ্চ) → ০.০৮%                         |
| Codec     | সবাই H.264, জনপ্রিয় ২% AV1 তেও   | সবাই AV1 / কেউ না          | দুটো কপি, দুটো pipeline                 | সব video তে AV1 এর প্রায় দ্বিগুণ নিট লাভ               |
| Ladder    | জনপ্রিয়তা অনুযায়ী               | সবার জন্য পুরো ladder      | প্রথম দর্শকের কম quality (just-in-time) | ৬২% video এর অপ্রয়োজনীয় transcode আর storage বাঁচে    |
| Cache     | টুকরো immutable, playlist ছোট TTL | সব একই TTL                 | দুই ধরনের header এর নিয়ম               | CDN এ চিরকালের hit, কিন্তু নতুন quality দ্রুত দেখা যায় |

**Live streaming এক লাইনে:** একই কাঠামো (টুকরো, playlist, ABR), কিন্তু playlist প্রতি কয়েক সেকেন্ডে বদলায়, transcoding real-time এ (টুকরো আসার সাথে সাথে), আর দেরি (glass-to-glass latency) নতুন constraint, তাই ছোট টুকরো বা low-latency এর বিশেষ রূপ।

**কী আগে ভাঙবে:** একটা হঠাৎ viral video (প্রথম কয়েক মিনিট সব edge এ miss, origin এর উপর ঢেউ - 4.5 এর origin shield আর request coalescing); transcoding এর queue তে একটা বড় creator এর একসাথে হাজার video (11.4 এর মতো, queue ভাগ করুন); আর egress এর বিল, যা প্রতিটা নতুন feature (autoplay, preview) নীরবে বাড়ায়।

---

## ২. Interview Angle

"Design YouTube/Netflix" এর মূল জায়গা প্রায় সবসময় তিনটা: upload আর transcoding, delivery আর CDN, আর player এর adaptive bitrate। ভালো উত্তরের আকৃতি:

1. **সংখ্যা আর খরচ আগে।** Egress এর PB আর Tbps, আর বিলের ৭৮%। এটা বললে interviewer জানে আপনি বোঝেন কেন বাকি সিদ্ধান্ত গুলো এমন।
2. **Ladder আর manifest।** কেন একটা file না, কয়েকটা quality আর ছোট টুকরো, আর player কীভাবে বাছে।
3. **Pipeline।** টুকরো করে parallel, idempotent, spot, কম quality আগে।
4. **জনপ্রিয়তা।** CDN এর hit rate কেন উঁচু, লম্বা লেজের জন্য সস্তা পথ, আর জনপ্রিয়দের জন্য দামি codec।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Video শুরু হতে দেরি কমাবেন কীভাবে?"_ - প্রথম টুকরো কম quality তে (দ্রুত আসে), ছোট টুকরো, CDN এ cache, আর playlist এর সাথে প্রথম টুকরো আগে থেকে আনা (prefetch)।
- _"Transcoding দ্রুত করবেন কীভাবে?"_ - টুকরো করে parallel; ৪ ঘণ্টা থেকে ৩ মিনিট। আর কম quality আগে।
- _"Network খারাপ হলে?"_ - ABR; সংখ্যা: সবসময় সর্বোচ্চ এ ৩৩% সময় থেমে থাকে, মিশ্র নীতিতে ০.০৮%।
- _"খরচ কমাবেন কীভাবে?"_ - Egress এ: ভালো codec জনপ্রিয়দের জন্য, per-title ladder, ISP এর ভেতরে cache। Storage এ: অজনপ্রিয়দের কম ধাপ আর সস্তা tier।
- _"CDN এ সব video রাখবেন?"_ - না; ০.১% এ ৯২% দেখা, ৮১ TB। লেজ origin থেকে, shield এর মধ্য দিয়ে।
- _"View count?"_ - 11.1 এর click এর মতো: event এ, আলাদা pipeline এ, পড়ার পথে লেখা না।

**Production এ বাস্তবে:** সবচেয়ে প্রচলিত সমস্যা: একটা বড় খেলা বা premiere এ একসাথে লাখ মানুষ একই মুহূর্তে শুরু করে (origin এর ঢেউ আর CDN এর ক্ষমতা); একটা encoder এর bug যা কিছু টুকরোয় ঝাঁকুনি বা শব্দের অমিল আনে, আর হাজার video তে আবার encode এর দরকার; player এর ABR এর ভুল সেটিং যা বিশেষ network এ (একটা দেশে, একটা carrier এ) rebuffer লাফিয়ে তোলে, আর সেটা শুধু দেশ ধরে metric দেখলে ধরা পড়ে; আর egress এর বিলে হঠাৎ লাফ, কারণ কোনো একটা app এর version ভুল quality default করেছে।

---

## ৩. Key Takeaway

- **Video এর বিল egress এর:** দিনে ২৭০ PB, বিলের ৭৮%; transcoding ১%। Encode একবার, egress প্রতিবার - তাই bit বাঁচানো সরাসরি টাকা, আর encode এ বেশি খরচ প্রায়ই লাভ
- **একটা file না, একটা ladder আর ছোট টুকরো:** player প্রতিটা টুকরোয় quality বাছে; manifest বলে কী কোথায়; প্রতিটা টুকরো একটা static file, যেকোনো CDN serve করে
- **Pipeline টুকরো করে parallel:** এক ঘণ্টার video ৪ ঘণ্টা থেকে ৩ মিনিট, আর spot এর বাধায় নষ্ট ১৪% থেকে ০.০২%। কম quality আগে, idempotent output
- **ABR এর কাজ rebuffer আর quality এর মাঝে:** সবসময় সর্বোচ্চ এ ৩৩% সময় থেমে; মিশ্র নীতিতে (throughput + buffer এর নিরাপত্তা + ধাপে ওঠা) ০.০৮%; মাপা গতির ২০% ফাঁক রাখুন
- **জনপ্রিয়তা তীক্ষ্ণ:** ০.১% video তে ৯২% দেখা (৮১ TB, edge এ ধরে); ৬২% video এর মাসের egress তাদের transcode এর চেয়ে কম
- **জনপ্রিয়তা অনুযায়ী encode:** AV1 শুধু জনপ্রিয় ২% এ সব video তে দেওয়ার প্রায় দ্বিগুণ নিট লাভ; encode আরও দামি হলে সবার জন্য ক্ষতি
- **টুকরো immutable, playlist ছোট TTL যতক্ষণ বদলায়** - 4.5 এর নিয়ম, এবার দুই ধরনের জিনিসে আলাদা

---

## ৪. নতুন Term (Glossary)

| Term                             | অর্থ                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Egress**                       | Data center বা CDN থেকে বাইরে যাওয়া data, প্রতি GB এর দাম - video তে প্রতিটা দর্শক প্রতিবার পুরো দাম দেয়, তাই বিলের বেশিরভাগ                                        |
| **Bitrate Ladder**               | একই video এর কয়েকটা resolution/bitrate এর সংস্করণ (এখানে ২৪০p ০.৪ Mbps থেকে ১০৮০p ৫ Mbps); player একটা বাছে; per-title encoding এ প্রতিটা video এর নিজের ladder      |
| **Manifest (HLS / DASH)**        | Video কীভাবে ভাগ করা আর কোথায় পাওয়া যায় তার text file - master (কোন quality আছে) আর media (টুকরো গুলোর তালিকা); টুকরো static file, তাই যেকোনো CDN serve করে        |
| **Segment-Parallel Transcoding** | Video কে keyframe এর সীমায় ছোট টুকরোয় ভাগ করে টুকরো × resolution কে আলাদা কাজ বানানো - শত worker একসাথে, ব্যর্থতায় শুধু একটা টুকরো আবার; spot worker কে নিরাপদ করে |
| **Adaptive Bitrate (ABR)**       | Player প্রতিটা টুকরোর আগে মাপা গতি আর buffer দেখে quality বাছে; throughput ভিত্তিক, buffer ভিত্তিক, বা মিশ্র - trade-off rebuffer, quality আর বারবার বদলের মাঝে       |
| **Rebuffer Ratio**               | দেখার সময়ের কত ভাগ buffer খালি হয়ে video থেমে ছিল - দর্শক হারানোর সবচেয়ে বড় কারণ; কম quality থামার চেয়ে অনেক ভালো                                                |
| **Popularity-Tiered Encoding**   | জনপ্রিয়তা অনুযায়ী encode এর খরচ বাছা - সবাই সস্তা codec আর ছোট ladder, জনপ্রিয় হলে দামি দক্ষ codec (AV1) আর পুরো ladder; কারণ encode একবার, egress প্রতিবার        |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. একটা দেশের একটা mobile carrier এ এক সপ্তাহ ধরে rebuffer ০.১% থেকে ২%, বাকি সব জায়গায় স্বাভাবিক। (ক) কোন কোন কারণ হতে পারে (অন্তত তিনটা, এই lesson থেকে)? (খ) কোন metric গুলো দেশ আর carrier ধরে ভাগ না করা থাকলে এটা কখনো ধরা পড়ত না? (গ) Player এর দিক থেকে আর CDN এর দিক থেকে একটা করে সমাধান।

2. একটা নতুন feature: home page এ প্রতিটা video এর thumbnail এর উপর mouse রাখলে (বা ফোনে scroll করার সময়) ৫ সেকেন্ডের preview চলে। Product বলছে "ছোট জিনিস"। (ক) ১.২ এর সংখ্যা দিয়ে, এটা egress এ কী করতে পারে? (খ) Preview এর জন্য কোন নকশা (ladder, কোথায় cache, কখন চালু) খরচ সীমায় রাখে? (গ) এই feature এর launch এর আগে কোন একটা metric আপনি বাধ্যতামূলক বলবেন?

3. একজন বড় creator এর channel এ ১০ বছরের ২০,০০০ পুরনো video, আর সে আজ সব একসাথে re-upload করছে (ভালো quality র মূল file)। (ক) ১.৪ এর pipeline এ কী হবে, আর বাকি সব creator এর upload এর কী হবে? (খ) কোন নকশা এটাকে বাকিদের থেকে আলাদা রাখে (11.4 আর 11.5 এর মতো)? (গ) এই ২০,০০০ video এর কোনগুলো কে পুরো ladder আর AV1 দেবেন, আর কীভাবে ঠিক করবেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) (১) **সেই carrier এর network এর আচরণ বদলেছে** (নতুন traffic shaping, বা video কে ধীর করে দেওয়া, যা কিছু carrier করে) আর player এর ABR এর ২০% ফাঁক সেখানে যথেষ্ট না; (২) **CDN এর সেই অঞ্চলের PoP বা ISP এর ভেতরের cache এর সমস্যা** (ভরে গেছে, একটা node খারাপ, বা routing বদলে দূরের PoP এ যাচ্ছে), তাই টুকরো আসতে দেরি আর miss বেশি; (৩) **একটা app এর নতুন version** যা সেই দেশে বেশি ব্যবহৃত, আর তার ABR এর setting বা শুরুর quality বদলেছে; (৪) সেই দেশে একটা জনপ্রিয় নতুন video যা edge এ এখনও গরম না (প্রথম কয়েক মিনিট origin থেকে, দূর থেকে)।

(খ) Rebuffer ratio, শুরুর দেরি, আর গড় bitrate - **দেশ × carrier (ASN) × app version × CDN এর PoP** ধরে। মোট সংখ্যায় একটা দেশের একটা carrier এর ২% সমুদ্রে এক ফোঁটা: পুরো system এর গড় প্রায় নড়ে না (10.4 এর "গড় লুকায়")। এর সাথে CDN এর দিকের metric: PoP ধরে hit rate আর টুকরো দেওয়ার latency।

(গ) **Player:** সেই carrier এর জন্য (ASN দেখে, বা মাপা আচরণ থেকে) ABR এর ফাঁক বড় করা আর buffer এর reservoir বাড়ানো, যাতে আরও আগে নামে; শুরুর quality কম। **CDN:** সেই অঞ্চলে PoP এর ক্ষমতা বা routing ঠিক করা, ISP এর সাথে peering, বা জনপ্রিয় টুকরো আগে থেকে সেখানে গরম করা (prefetch/pre-warm)।

**প্রশ্ন ২:**

(ক) Home page এ একজন দর্শক মিনিটে হয়তো ১০-২০টা thumbnail এর উপর দিয়ে যায়। প্রতিটা preview ৫ s × ধরুন ১.৫ Mbps ≈ ১ MB। ২০ কোটি DAU × দিনে ধরুন ৫০টা preview = দিনে ১,০০০ কোটি MB ≈ ১০ PB, ১.২ এর ২৭০ PB এর প্রায় ৪%, মাসে ~$৩০ লাখ, শুধু এই "ছোট জিনিস" এ। আর যদি autoplay (scroll করলেই চলে) হয়, সংখ্যা কয়েক গুণ।

(খ) Preview এর জন্য: (১) **আলাদা, খুব ছোট ladder** - 240p বা 360p, কম bitrate, শব্দ ছাড়া, ৫ s এর একটা টুকরো, আর video তৈরির সময় একবারই বানানো; (২) শুধু **জনপ্রিয় video** গুলোর জন্য (১.৬: সেগুলো edge এ এমনিতেই গরম), বাকিদের জন্য শুধু ছবি; (৩) চালু হয় একটা দেরির পরে (৫০০ ms mouse এর উপর থাকলে), scroll এর মাঝে না; (৪) cellular network এ বন্ধ বা user এর setting এ।

(গ) **Preview থেকে আসল দেখায় রূপান্তর (conversion) বনাম preview এর egress এর খরচ** - একটা view এর দাম ডলারে। যদি preview দেখার পরে আসল view বাড়ে না, feature টা শুধু খরচ। এটা 10.7 এর unit economics এর প্রশ্ন, launch এর আগে A/B test দিয়ে।

**প্রশ্ন ৩:**

(ক) ২০,০০০ video × গড় ১০ মিনিট × ৪ CPU-ঘণ্টা/ঘণ্টা ≈ ১৩,০০০ CPU-ঘণ্টা, আর লাখ লাখ টুকরোর কাজ একসাথে queue তে। একটা FIFO queue তে বাকি সব creator এর নতুন upload তাদের পেছনে: ১১.৪ এর celebrity এর fan-out এর সমস্যা। প্রতিদিনের upload এর ঘণ্টায় "playable" এর লক্ষ্য (কয়েক মিনিট) ভেঙে যায়।

(খ) **অগ্রাধিকারের স্তর** (11.5): নতুন upload উপরের স্তরে, পুরনো catalog এর আবার-encode নিচের স্তরে; আর **creator প্রতি সীমা** (একসাথে কতগুলো কাজ, 11.2 এর মতো), যাতে একজন সব worker নিতে না পারে। Batch এর কাজ spot এর সবচেয়ে সস্তা সময়ে (রাতে) চালানো যায়, কারণ এর তাড়া নেই।

(গ) ১.৬ এর নিয়ম: আগে সবাই সস্তা ladder (240p-720p, H.264) পায়, যাতে channel টা কাজ করে। তারপর **ইতিহাস থেকে জনপ্রিয়তা** জানা আছে (পুরনো video এর দেখার data): গত মাসে ৩০ ঘণ্টার বেশি দেখা হয়েছে এমন video গুলো পুরো ladder আর AV1 পায়, জনপ্রিয়তার ক্রমে। বাকিরা শুধু দরকার হলে (কেউ দেখতে চাইলে 1080p just-in-time)। এখানে একটা সুবিধা: নতুন upload এর মতো জনপ্রিয়তা অনুমান করতে হয় না, data আছে।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (চারটা deterministic model আর একটা আসল Express + Zod VOD service, HLS এর playlist সহ; Docker বা ffmpeg লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.6-video-streaming/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.6-video-streaming) - `npm install`, তারপর `npm run estimate`, `npm run transcode`, `npm run abr`, `npm run cdn`, `npm run smoke`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` egress, bandwidth, upload, storage, transcoding আর মাসিক খরচ হিসাব করে। `transcode` চারটা pipeline এর নকশা spot worker এর বাধা সহ চালায়। `abr` ওঠানামা করা network এ পাঁচটা bitrate নীতি মাপে। `cdn` জনপ্রিয়তার বণ্টন থেকে edge এর জায়গা, লম্বা লেজ আর AV1 এর অর্থনীতি হিসাব করে। `smoke` একটা আসল VOD service চালিয়ে upload থেকে player পর্যন্ত ১২টা ধাপ দেখায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, আপনার। **Estimation আর দামের input ধরে নেওয়া** (দিনে ১ ঘণ্টা, ৩ Mbps, প্রতি মিনিটে ৩০০ ঘণ্টা upload, CDN $০.০১/GB, ঘণ্টায় ৪ CPU-ঘণ্টা), মাপা না। `transcode` এ আসল encoding নেই, spot এর বাধা Poisson। `abr` এর network synthetic আর নীতিগুলো আসল player এর সরল রূপ। `cdn` এর জনপ্রিয়তা Zipf (s = ১.২) এর model, edge এর হিসাব আদর্শ; AV1 এর সংখ্যা প্রকাশিত তুলনার মোটামুটি আন্দাজ। `smoke` এর টুকরো নকল byte, store in-memory। Netflix এর Open Connect আর encoding এর pipeline এর কথা তাদের প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। **যা মাপা হয়নি:** আসল encoding এর সময় আর quality, আসল player, আসল CDN এর hit rate, DRM, live।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `estimate` চালানোর **আগে** লিখে ফেলুন: egress, storage আর transcoding এর মধ্যে বিলের কত ভাগ কার? তারপর চালিয়ে মেলান। তারপর `AVG_MBPS=2` (ভালো codec বা ABR) দিয়ে মাসে কত বাঁচে।

2. **টুকরোর দৈর্ঘ্য:** `transcode` এ `SEGMENT_S=2` আর `SEGMENT_S=10`, আর `abr` এ একই। Publish, নষ্ট CPU, rebuffer আর quality বদল কীভাবে নড়ে? Encode এর দক্ষতার দিকটা (keyframe) model এ নেই - সেটা কোন দিকে টানত?

3. **Network আরও অস্থির:** `STATE_S=2 npm run abr`। কোন নীতির rebuffer সবচেয়ে বাড়ল, আর কেন buffer ভিত্তিক নীতি এখানে তুলনায় ভালো থাকে?

4. **Code বদলানো:** README এর experiment ৫ (জনপ্রিয়তা অনুযায়ী ladder)। তারপর `src/vod.ts` এ view count যোগ করুন যা প্রতিটা প্রথম টুকরো (`0.ts`) এর request এ বাড়ে - কিন্তু CDN এর পেছনে থাকলে origin এ প্রায় কোনো request আসবে না। তাহলে view গুনবেন কোথায়?

5. **Design অংশ:** এই platform এর "এক পাতার design doc", Lesson 1.2 এর পাঁচ ধাপে: (ক) requirement আর বাদ দেওয়া; (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত (খরচ সহ); (গ) upload থেকে দর্শক পর্যন্ত ছবি; (ঘ) pipeline আর ABR এর নীতি, সংখ্যা সহ; (ঙ) একটা খরচের পরিকল্পনা: কোন তিনটা সিদ্ধান্ত egress কমায়, আর কোন metric দিয়ে প্রতিটা মাপবেন।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ), 11.1 – 11.5
Current: 11.6 - Case Study: Design a Video Streaming Platform
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ - URL shortener; ২ - rate limiter
service; ৩ - chat; ৪ - news feed; ৫ - notification। Case study ৬ - video: ২০ কোটি DAU, দিনে ২৭০ PB egress (peak
৬৩ Tbps), বিলের ৭৮% egress, transcoding ১% → encode একবার, egress প্রতিবার। Bitrate ladder (240p–1080p, ৫ ধাপ),
HLS manifest (master + media), টুকরো static file। Pipeline: ৪ s এর টুকরো × resolution, শত spot worker, idempotent
(৪ ঘণ্টা → ৩ মিনিট, spot এ নষ্ট ১৪% → ০.০২%), 360p/240p আগে (~৩০ s এ playable)। ABR মিশ্র (throughput + buffer +
ধাপে ওঠা): rebuffer ৩৩% (সবসময় সর্বোচ্চ) → ০.০৮%। জনপ্রিয়তা: ০.১% video তে ৯২% দেখা (৮১ TB edge এ); ৬২% video
এর egress < transcode → ছোট ladder, just-in-time; AV1 শুধু জনপ্রিয় ২% (সবার চেয়ে দ্বিগুণ নিট লাভ)। টুকরো immutable,
processing এর master ছোট TTL।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (বনাম Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation, Priority Tier,
Provider Throughput Limit, Pacing, Provider Failover, Aggregation Window (Collapse Key), Quiet Hours,
Device Token Lifecycle, Egress, Bitrate Ladder, Manifest (HLS / DASH), Segment-Parallel Transcoding,
Adaptive Bitrate (ABR), Rebuffer Ratio, Popularity-Tiered Encoding
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 11.7 - Case Study: Design a Payment System
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **যখন একটা জিনিস প্রতিবার দেখায় দাম দেয় আর একবার বানাতে, তখন বানানোয় বেশি খরচ করে দেখার খরচ কমান - কিন্তু শুধু যেখানে দেখা সত্যিই হয়।** Ladder আর টুকরো দর্শককে খারাপ network এ বাঁচায়, টুকরো করে parallel pipeline কে দ্রুত আর spot কে নিরাপদ করে, আর জনপ্রিয়তার তীক্ষ্ণ বণ্টন বলে দামি encode আর edge এর জায়গা কাকে দেবেন।

রেডি হলে `next` লিখুন - **Lesson 11.7: Design a Payment System** এ যাব, Module 11 এর শেষ case study। এখানে সব নিয়ম উল্টে যায়: আন্দাজ চলে না, eventual consistency টাকায় বিপজ্জনক, আর "দুবার" মানে কারো টাকা দুবার কাটা। 2.5 এর idempotency key, 5.5 এর transaction, 7.5 এর outbox, 9.3 এর saga, আর 11.5 এর "timeout মানে জানি না" - সব এক জায়গায়, সর্বোচ্চ চাপে। প্রশ্নগুলো: বাইরের payment provider timeout দিলে টাকা কাটা হয়েছে কিনা কীভাবে জানবেন, double-entry ledger কেন, আর দিন শেষে নিজের হিসাব আর bank এর হিসাব মেলানো (reconciliation) কেন সবচেয়ে গুরুত্বপূর্ণ কাজ।
