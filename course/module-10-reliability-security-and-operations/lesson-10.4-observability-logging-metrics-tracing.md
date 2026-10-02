# Lesson 10.4 — Observability: Logging, Metrics, Tracing

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 6.4):** দুটো আলাদা machine এর log এর লাইন timestamp ধরে সাজালে কী ভুল হতে পারে — আর কেন "আগের timestamp" মানে "আগে ঘটেছে" না? আজ চারটা service এর log একসাথে পড়তে হবে, আর তোমার হাতে থাকবে এমন একটা জিনিস যেটা ঘড়ির উপর নির্ভর না করেই বলে কোন কাজ কোন কাজের **ভেতরে** ঘটেছে।

**Prerequisite:** Lesson 1.5 (Percentile, SLO, error budget), Lesson 5.6 (N+1, connection pool), Lesson 6.4 (Clock skew), Lesson 7.3 (Background job), Lesson 9.2 (Gateway, request id), Lesson 10.2 (Cardinality), Lesson 10.3 (Steady state, brownout)

**তুমি এই lesson শেষে পারবে:**

1. Log, metric আর trace এর প্রতিটা **কোন প্রশ্নের** উত্তর দেয় আর কোনটার দেয় না সেটা বলতে পারবে — আর একটা latency metric এমনভাবে নকশা করতে পারবে (histogram, bucket, label) যাতে p99 সৎ থাকে আর metric system মরে না
2. একটা request কে চারটা service জুড়ে একটা trace এ বাঁধতে পারবে — `traceparent` header, context propagation, log এ trace id — আর বলতে পারবে কোন trace রাখবে (head বনাম tail sampling) আর তার দাম কী
3. SLO থেকে **burn rate** এর alert বানাতে পারবে, আর সংখ্যা দিয়ে বলতে পারবে কেন "error > ১%, ৫ মিনিট" ধরনের alert একই সাথে ধীর ক্ষয় মিস করে আর রোজ অকারণে মানুষকে জাগায়

**Tier:** 1 — Runnable Code (চারটা deterministic simulation — percentile, cardinality, sampling, burn rate; আর localhost এ চারটা আসল HTTP service দিয়ে distributed trace; Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

10.3 এর পরে TaskFlow এর প্রতিটা journey এর hard আর soft dependency লেখা আছে, flags এর snapshot আছে, board brownout জানে। আর 10.3 এর শেষে একটা প্রশ্ন ঝুলে ছিল: শনিবার রাতে on-call engineer ২৫ মিনিট `flags` কে খুঁজে পায়নি, কারণ কোনো graph তাকে সেদিকে দেখায়নি।

TaskFlow এর "দেখার" ব্যবস্থা এখন এরকম: প্রতিটা instance `console.log` এ text লাইন লেখে (`loading board 4821`), সেগুলো একটা log store এ যায়। একটা Prometheus আছে, তাতে কয়েকটা metric — প্রতিটা service এর গড় latency আর error rate। একটা dashboard, আর একটা alert: "error rate ৫ মিনিট ধরে ১% এর বেশি হলে page"। সেই alert টা প্রতিদিন দুপুর ২টায় deploy এর সময় বাজে — দুই মিনিটের ঝাঁকুনি — তাই on-call দের বেশিরভাগ সেটা phone এ mute করে রেখেছে।

**বুধবার।** Support এ ticket আসতে শুরু করল: "board খুলতে মাঝে মাঝে ৪–৫ সেকেন্ড লাগে।" Dashboard এ board এর গড় latency ১৭০ ms — alert এর সীমা ৩০০ ms, তাই সবুজ। Error rate স্বাভাবিক।

**বুধবার বিকেল।** On-call engineer log খুলল। ছয়টা instance, লাখ লাখ লাইন। `loading board`, `board loaded`, `query done` — কোনো লাইনে request এর কোনো id নেই। Gateway এর log এ একটা ৪.২ সেকেন্ডের request পাওয়া গেল, কিন্তু work service এর কোন লাইনগুলো ওই request এর, বলার উপায় নেই। Timestamp মিলিয়ে চেষ্টা করল — ছয়টা machine এর ঘড়ি কয়েক ms এদিক-ওদিক (6.4), আর ওই মুহূর্তে সেকেন্ডে ৩০০টা request।

**বুধবার রাত।** আরেকজন engineer একটা বুদ্ধি করল: latency metric এ `user_id` আর আসল `path` label যোগ করো, তাহলে দেখা যাবে কোন user আর কোন board ধীর। Deploy করল। চল্লিশ মিনিট পরে Prometheus এর memory শেষ, process মরল। Restart হলো, আবার ভরল, আবার মরল। সেই রাতে TaskFlow এর **কোনো metric আর কোনো alert ছিল না।**

**বৃহস্পতিবার।** কেউ সব instance এ `DEBUG` log চালু করল। Log এর আয়তন পঁচিশ গুণ, log store এর ingestion দুই ঘণ্টা পিছিয়ে — মানে এখনকার log দুই ঘণ্টা পরে দেখা যায়। মাসের শেষে log এর bill।

**শুক্রবার।** একজন DBA cloud console এ অন্য একটা কাজে গিয়ে কাকতালীয়ভাবে দেখল: তিনটা read replica এর একটা, `r3`, এর disk এর latency graph এ মাঝে মাঝে খাড়া স্পাইক। Cloud provider এর storage এ একটা "noisy neighbor"। দুই দিন।

Postmortem এ CTO এর এক লাইন: "আমাদের কাছে data ছিল — gigabyte gigabyte। উত্তর ছিল না। আর উত্তর খুঁজতে গিয়ে আমরা নিজেরাই দুটো জিনিস ভাঙলাম।"

---

## ১. Theory

### ১.১ Monitoring বনাম Observability — আর তিনটা সংকেত

TaskFlow এর যা ছিল সেটা **monitoring**: কয়েকটা আগে থেকে ঠিক করা প্রশ্ন ("গড় latency কত? error rate কত?"), আর তাদের উত্তরের graph। সমস্যা হলো বুধবারের প্রশ্নটা আগে থেকে ঠিক করা ছিল না: "**কোন** board request গুলো ধীর, আর তারা অন্যদের থেকে **কীসে** আলাদা?" এমন প্রশ্নের জন্য নতুন code deploy করতে হয়েছিল (label যোগ), আর সেটাই সব ভাঙল।

**Observability** — একটা system এর বাইরে থেকে পাওয়া সংকেত (log, metric, trace) দিয়ে তার ভেতরের অবস্থা সম্পর্কে **নতুন, আগে না ভাবা** প্রশ্নের উত্তর দিতে পারার ক্ষমতা — নতুন code deploy না করেই; monitoring যদি জানা প্রশ্নের উত্তর দেয়, observability অজানা প্রশ্নের উত্তর খোঁজার সুযোগ দেয়।

শব্দটা control theory থেকে এসেছে — একটা system কতটা "observable" মানে তার output দেখে ভেতরের অবস্থা কতটা বোঝা যায়। Software এ তিন রকম সংকেত সাধারণত ব্যবহার হয়, আর প্রতিটা আলাদা প্রশ্নের উত্তর দেয়:

| সংকেত      | কী                                                                      | যে প্রশ্নের উত্তর দেয়                                     | যে প্রশ্নের দেয় না                                       | দাম কীসে বাড়ে                               |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| **Metric** | সংখ্যার সময়-সারি, আগে থেকে যোগ করা (count, sum, histogram), label সহ   | "কতটা, কত ঘন ঘন, কখন থেকে?" — trend, alert, dashboard      | "**এই** request এ কী হলো?" — আলাদা ঘটনা হারিয়ে গেছে      | Label এর মানের **সমন্বয়** এর সংখ্যায় (১.৪) |
| **Log**    | প্রতিটা ঘটনার একটা রেকর্ড, যেকোনো field সহ                              | "এই ঘটনায় ঠিক কী হলো, কোন মান নিয়ে?"                     | "কতটা ঘন ঘন?" — গুনতে সব পড়তে হয়, ধীর আর দামি           | ঘটনার সংখ্যা × আকারে                         |
| **Trace**  | একটা request এর পুরো পথ — কোন service, কোন কাজ, কতক্ষণ, কার ভেতরে কোনটা | "এই request এর সময় **কোথায়** গেল, আর কোন কাজ কাকে ডাকল?" | "সব request মিলিয়ে কী অবস্থা?" — বেশিরভাগ trace ফেলা হয় | Request × span এ; তাই sampling (১.৬)         |

তিনটা আলাদা যন্ত্র না, একই ঘটনার তিনটা দৃষ্টিকোণ। বুধবারের সমস্যার সমাধানের পথ এরকম হওয়ার কথা ছিল: **metric** বলে "কিছু একটা খারাপ" (p99 বেড়েছে), **trace** বলে "কোথায়" (r3 এর query তে), **log** বলে "কেন, ঠিক কী মান নিয়ে" (কোন query, কোন board, কোন error)। আর তিনটাকে বাঁধে একটা জিনিস — একটা **id**, যেটা metric থেকে trace এ, trace থেকে log এ নিয়ে যায়। TaskFlow এর কাছে তিনটার কোনোটাই ঠিক অবস্থায় ছিল না, আর id ছিলই না।

### ১.২ গড় কী লুকায়

1.5 এ শিখেছিলে average বিভ্রান্তিকর, p99 দেখো। এবার সংখ্যাটা দেখি। Exercise এর `npm run percentiles` — এক ঘণ্টার board খোলা (১০.৮ লাখ request), ছয়টা instance, তিনটা replica; `r3` এর disk ঘণ্টায় তিনবার ৯০ সেকেন্ড করে আটকে যায়:

```
গড়               p50       p90       p99     p99.9       max     > 1 s
172 ms         79 ms    132 ms    3.79 s    4.50 s    4.77 s     2.50%
```

গড় ১৭২ ms — dashboard এর ৩০০ ms এর সীমার নিচে, সবুজ। p99 ৩.৭৯ সেকেন্ড। আর **২.৫% request এক সেকেন্ডের বেশি** — প্রতি ৪০টা board খোলায় একটা।

২.৫% শুনতে ছোট। কিন্তু user একটা board একবার খোলে না। একজন project manager দিনে ধরো ২০টা board খোলে। তার অন্তত একবার ধীর অভিজ্ঞতা হওয়ার সম্ভাবনা:

```
1 − (1 − 0.025)^20 = 1 − 0.975^20 ≈ 40%
```

**প্রতিদিন ৪০% user অন্তত একবার ৪ সেকেন্ড অপেক্ষা করছে**, আর dashboard বলছে সব ঠিক। এজন্যই support এ ticket আসছিল — তারা ব্যতিক্রম না, প্রায় অর্ধেক user। Percentile এর লেজটাই সেই জায়গা যেখানে user রা থাকে, কারণ প্রতিটা user অনেকগুলো request করে, আর তাদের যেকোনো একটা ধীর হলেই অভিজ্ঞতা ধীর।

আর গড় ১৭২ ms কোথা থেকে এলো খেয়াল করো: স্বাভাবিক request ~৮৪ ms, আর ২.৫% এর ~৩.৫ সেকেন্ড মিলে গড় দ্বিগুণ। গড় নড়েছিল — কিন্তু সীমা পেরোয়নি, আর "৮৪ থেকে ১৭২" কে কেউ একটা সংকেত ভাবেনি।

### ১.৩ Percentile যোগ করা যায় না — Histogram

এবার একটা সূক্ষ্ম ফাঁদ যেটায় প্রায় সব dashboard পড়ে। ধরো তুমি p99 ই দেখছ — প্রতি মিনিটে একটা p99 মাপছ। Dashboard এ "গত এক ঘণ্টার p99" দেখাতে হবে। ৬০টা মিনিটের p99 থেকে কীভাবে বানাবে? `npm run percentiles`, অংশ খ:

```
আসল p99 (সব request একসাথে)               3.79 s
৬০টা মিনিটের p99 এর গড়                      617 ms
৬০টা মিনিটের p99 এর median                  187 ms
৬০টা মিনিটের p99 এর max                     4.52 s

মিনিট             গড়       p99     > 1 s
11           84 ms    183 ms      0.0%
12          1.25 s    4.52 s     33.2%
13          675 ms    4.46 s     16.9%
14           84 ms    184 ms      0.0%
```

**মিনিটের p99 গুলোর গড় ৬১৭ ms — আসলের ছয় ভাগের এক ভাগ। Median ১৮৭ ms — প্রায় পুরো সমস্যা উধাও।** কারণ ৬০টা মিনিটের মধ্যে মাত্র ৬টায় আটকানো ছিল; বাকি ৫৪টার p99 ~১৮৫ ms, আর গড় করার সময় সেই ৫৪টা ৬টাকে ডুবিয়ে দেয়। অথচ ঘণ্টার request গুলো একসাথে রাখলে ২.৫% ধীর — p99 এর সীমার (১%) অনেক উপরে।

Percentile একটা **অবস্থান** — "সাজালে ৯৯ নম্বর শতাংশে কে"। দুটো দলের অবস্থান থেকে মিলিত দলের অবস্থান বের করা যায় না, ঠিক যেমন 10.2 এ দুটো দিনের আলাদা user সংখ্যা যোগ করে সপ্তাহের সংখ্যা পাওয়া যায়নি। আর ভুলটা কোন দিকে যাবে তাও নিশ্চিত না — exercise এর experiment ১ এ (`STALL_SECONDS=20`, আটকানো ছোট) আসল p99 ২০৮ ms, আর মিনিটের p99 এর গড় ৩৯৬ ms — এবার **বাড়িয়ে** দেখাচ্ছে। Percentile গড় করার ফল একটা অর্থহীন সংখ্যা, যে দিকেই যাক।

সমাধান হলো percentile না রেখে এমন কিছু রাখা যা **যোগ করা যায়**:

**Histogram** — একটা metric যা প্রতিটা মান রাখে না, শুধু গোনে কতগুলো মান কোন ঘরে (bucket — যেমন "৫০ ms এর নিচে", "১০০ ms এর নিচে", …) পড়েছে; bucket এর গণনা যোগ করা যায় — instance জুড়ে, মিনিট জুড়ে — আর যোগফল থেকে যেকোনো percentile অনুমান করা যায়, যার নির্ভুলতা bucket এর সীমা কোথায় তার উপর।

ছয়টা instance এর histogram যোগ করলে ঠিক একটা বড় histogram, ৬০টা মিনিটের যোগ করলে ঠিক ঘণ্টার histogram — কিছু হারায় না। Prometheus এ এটাই `histogram_quantile(0.99, sum by (le) (rate(...[1h])))` — আগে bucket যোগ, তারপর percentile। কিন্তু অনুমান কত ভালো, সেটা bucket এর উপর। অংশ গ:

```
percentile         আসল  default bucket       ভুল    নিজের bucket       ভুল
p50              79 ms           82 ms      +3%         80 ms      +1%
p90             132 ms          205 ms     +55%        141 ms      +7%
p99             3.79 s          4.00 s      +6%        3.78 s      -0%
p99.9           4.50 s          4.90 s      +9%        4.86 s      +8%
   default bucket (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000
   নিজের bucket   (ms): 50, 75, 100, 150, 200, 300, 500, 1000, 2000, 3000, 4000, 5000
```

Prometheus এর client library এর default bucket এ p90 এর অনুমান **৫৫% বেশি** — কারণ আসল p90 (১৩২ ms) ১০০ আর ২৫০ এর মাঝের একটা চওড়া ঘরে, আর ঘরের ভেতরে অনুমান সরলরেখায় করা হয়। Bucket হওয়া উচিত **যেখানে তোমার সিদ্ধান্ত হয়** — SLO এর সীমার আশেপাশে ঘন (ধরো ৩০০ ms এর SLO হলে ২০০, ২৫০, ৩০০, ৩৫০), আর দূরে পাতলা। Experiment ২: default এ শুধু ১৫০ আর ২০০ যোগ করলে p90 এর ভুল +৫৫% থেকে +৭%। কিন্তু প্রতিটা bucket একটা আলাদা time series — আর সেটা পরের অংশের দাম।

**এবার সঠিক মাত্রা।** p99 জানা গেল, কিন্তু "কেন?" এর উত্তর নেই। অংশ ঘ — একই request, দুইভাবে ভাগ করা:

```
মাত্রা               request        গড়       p50       p99     > 1 s
instance 1       180,000    170 ms     79 ms    3.77 s     2.47%
instance 2       180,000    173 ms     79 ms    3.79 s     2.53%
…
replica r1       359,847     84 ms     78 ms    185 ms     0.00%
replica r2       360,375     84 ms     78 ms    187 ms     0.00%
replica r3       359,778    346 ms     81 ms    4.31 s     7.49%
```

Instance ধরে ভাগ করলে ছয়টাই হুবহু এক — কোনো তথ্য নেই। Replica ধরে ভাগ করলে উত্তর এক নজরে: **r3**। বুধবার রাতের engineer এর অনুভূতি ঠিক ছিল — "একটা মাত্রা যোগ করো, ভাগ করে দেখো"। ভুল ছিল কোন মাত্রা, আর কোথায় যোগ করা।

### ১.৪ Cardinality — যে label metric system কে মারে

`replica` একটা ভালো label: তিনটা মান। `user_id` আর আসল `path` এর মান কয়টা? Metric system প্রতিটা **আলাদা label এর সমন্বয়ের** জন্য একটা আলাদা time series রাখে — memory তে, প্রতিটার নিজের সংখ্যার সারি সহ। `npm run cardinality` — একদিনের traffic (৮৬.৪ লাখ request, ১ লাখ user, ২ লাখ board), একটা latency metric, label এর সেট বদলে:

```
label                               counter series   histogram (×15)      আনুমানিক memory
method, route, status, instance              2,400            36,000            103 MB
+ plan (free/pro/business)                   7,114           106,710            305 MB
route এর বদলে আসল path                    2,529,996        37,949,940            106 GB
+ user_id                                2,534,244        38,013,660            106 GB
+ trace_id                               8,640,000       129,600,000            362 GB
```

**Label Cardinality** — একটা metric এর label গুলোর মানের সম্ভাব্য সমন্বয়ের সংখ্যা, অর্থাৎ সে কয়টা আলাদা time series তৈরি করে; এটা প্রতিটা label এর আলাদা মানের সংখ্যার **গুণফল** পর্যন্ত যেতে পারে, আর metric system এর memory, CPU আর খরচ এই সংখ্যায় বাড়ে — traffic এ না।

(10.2 এ cardinality মানে ছিল "কতগুলো আলাদা জিনিস" — HyperLogLog দিয়ে গোনা। এখানে একই শব্দ, একই অর্থ, শুধু জিনিসটা হলো label এর সমন্বয়। আর এখানেও সঠিক উত্তরের দাম হলো প্রত্যেকটাকে মনে রাখা।)

টেবিলটা থেকে তিনটা জিনিস:

1. **সমস্যা গুণফল।** ৪০টা route × ১০টা status × ৬টা instance = ২,৪০০। Plan (৩টা মান) যোগ করলে প্রায় তিন গুণ। প্রতিটা নতুন label আগেরগুলোকে **গুণ** করে, যোগ না।
2. **Histogram আরও ১৫ গুণ।** প্রতিটা সমন্বয়ে ১৩টা bucket (+Inf সহ) আর `_sum`, `_count`। তাই ১.৩ এর "আরও bucket যোগ করো" এর একটা দাম আছে।
3. **আসল path আর `user_id` — ২৫ লাখ series, ~১০৬ GB।** বুধবার রাতের OOM। আর খেয়াল করো, এটা একদিনের সংখ্যা — নতুন user, নতুন board প্রতিদিন নতুন series বানায়। Memory এর সংখ্যাটা একটা আন্দাজ (প্রতি series ~৩ KB ধরে); কিন্তু series এর **সংখ্যা** গোনা, আর ২,৪০০ থেকে ২৫ লাখ — হাজার গুণ — যেকোনো আন্দাজেই একটা মৃত্যুদণ্ড।

নিয়মটা তাই: **metric এর label এ শুধু ছোট, সীমিত মানের জিনিস** — route এর template (`/boards/:id`, আসল path না), status, method, instance, region, plan, replica। যার মান অসীম বা প্রতি user/request এ আলাদা — user id, board id, trace id, email, আসল URL — সেটা **log আর trace এ**, metric এ কখনো না।

তাহলে "কোন user ধীর" এর উত্তর কোথায়? Log আর trace এ — সেখানে প্রতিটা ঘটনা আলাদা রেকর্ড, আর একটা field এ লাখ রকম মান থাকলে কোনো সমস্যা নেই, কারণ দাম ঘটনার সংখ্যায়, মানের বৈচিত্র্যে না। Metric এর কাজ বলা "কিছু একটা খারাপ, আর কোন মোটা ভাগে"; বিস্তারিত খোঁজা trace আর log এর কাজ। (Prometheus আর OpenMetrics এ একটা সেতু আছে — **exemplar**: histogram এর একটা bucket এর সাথে একটা উদাহরণ trace id জুড়ে রাখা, যাতে graph এর একটা স্পাইক থেকে সরাসরি একটা trace এ যাওয়া যায়। এখানে মাপা না।)

**Log এর আয়তন।** অংশ খ — প্রতি request এর ঘটনা কোথায় রাখলে একদিনে কত:

```
কী রাখছি                                        প্রতি request       প্রতি দিন
log, প্রতি request এ একটা JSON লাইন                    350 B      2.8 GB
log, debug চালু (25টা লাইন)                          8.5 KB     70.4 GB
trace, সব request (20টা span)                     7.8 KB     64.4 GB
trace, ১% sample                                   80 B      659 MB
```

বৃহস্পতিবারের debug log — দিনে ২.৮ GB থেকে ৭০ GB। Log এর দাম ঘটনার সংখ্যায় সরাসরি বাড়ে, তাই log এর নীতি তিনটা: **প্রতি request এ একটা ভরা লাইন, দশটা খালি লাইনের চেয়ে ভালো** (শেষে একটা লাইন যাতে route, status, সময়, user, board, trace id সব আছে); debug log শুধু যেখানে লাগে (একটা instance, একটা user, কয়েক মিনিট — ধরো একটা flag দিয়ে), সবখানে না; আর সফল, সাধারণ request এর log কে sample করা যায় — error আর ধীর সবসময় রাখো।

**Structured Logging** — log লাইনকে মানুষের পড়ার বাক্য হিসেবে না, field আর মানের একটা রেকর্ড হিসেবে লেখা (সাধারণত এক লাইনে একটা JSON), যাতে প্রতিটা field দিয়ে খোঁজা, ছাঁকা আর গোনা যায়; সাথে সবসময় একটা **correlation id** (trace id), যা একই request এর সব service এর লাইনকে জোড়ে।

```
আগে:   loading board 4821
       query done in 3912ms

পরে:   {"ts":"2026-10-01T09:12:44.118Z","level":"warn","service":"work","trace_id":"4bf92f35…",
        "span_id":"00f067aa…","msg":"slow query","replica":"r3","board":4821,"ms":3912}
```

প্রথমটায় "r3 এর সব ধীর query" খুঁজতে regex লিখতে হয় আর প্রার্থনা করতে হয়; দ্বিতীয়টায় `replica = "r3" AND ms > 1000`। আর `trace_id` দিয়ে একই request এর gateway, bff, billing এর লাইন একসাথে — timestamp মেলানোর দরকারই নেই। একটা সতর্কতা যেটা 10.5 এ আবার আসবে: structured log এ সবকিছু ঢোকানো সহজ, তাই password, token, পুরো request body, ব্যক্তিগত তথ্য log এ চলে যায়। Log এর field এর একটা allowlist রাখো।

### ১.৫ Distributed Tracing — একটা request কে চারটা service জুড়ে দেখা

Log এ trace id রাখতে হলে প্রথমে trace id টা থাকতে হবে — আর সেটা প্রতিটা service এ **একই** হতে হবে। এটাই tracing এর পুরো কৌশল।

**Trace / Span** — একটা request এর পুরো যাত্রা একটা **trace**, যার একটা অনন্য trace id; যাত্রার প্রতিটা কাজ (একটা HTTP call, একটা database query, একটা cache lookup) একটা **span** — যার নিজের id, শুরু, শেষ, কিছু attribute, আর তার **parent** span এর id; parent-child সম্পর্ক থেকে গাছটা তৈরি হয়, যেটা দেখায় কোন কাজ কোন কাজের ভেতরে ঘটেছে।

আর trace id এক service থেকে আরেক service এ যায় একটা header এ — **context propagation**। আজকের standard হলো W3C এর Trace Context, header এর নাম `traceparent`:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  └──────────── trace id ──────────┘ └─ parent span ─┘ └ flags (01 = sampled)
             version
```

প্রতিটা service যা করে:

```
request আসে ──► traceparent পড়ো ──► নিজের span খোলো (trace id একই, parent = header এর span)
                                    │
                                    ├─ নিজের কাজ (DB, cache) → প্রতিটা একটা child span
                                    ├─ log লেখো → trace_id, span_id সহ
                                    └─ অন্য service কে ডাকো → header এ traceparent (নিজের span কে parent করে)
               ◄── span বন্ধ করো, collector এ পাঠাও
```

Node এ একটা প্রশ্ন আসে: Express handler এর ভেতরে, পাঁচটা `await` এর পরে, একটা গভীর function যখন log লেখে বা `fetch` করে, সে কীভাবে জানবে এখনকার trace id কী? প্রতিটা function এ parameter হিসেবে পাঠানো অসম্ভব। উত্তর **`AsyncLocalStorage`** (`node:async_hooks`) — Node এর একটা built-in, যা একটা মান কে একটা async কাজের পুরো শিকলের সাথে বেঁধে রাখে, `await` আর callback পেরিয়েও। Exercise এর `src/tracing.ts` এ পুরো tracing library টা ~১৪০ লাইন: request আসার সময় `storage.run(span, handler)`, আর যেকোনো জায়গায় `storage.getStore()` দিলে এখনকার span। Production এ এই কাজটা **OpenTelemetry** করে — একটা vendor-নিরপেক্ষ standard আর SDK, যা Express, `http`, `pg`, `ioredis` এর মতো library কে নিজে থেকে instrument করে (auto-instrumentation), আর span গুলো যেকোনো backend এ পাঠায়। নিজের হাতে লেখা library শেখার জন্য; production এ OpenTelemetry।

`npm run trace` — localhost এ চারটা **আসল** HTTP service: gateway → bff → (work, billing একসাথে); work একটা cache lookup আর একটা replica query করে (নকল, `setTimeout` দিয়ে), আর replica `r3` কয়েকটা request এ ১.২ সেকেন্ড আটকে যায়। ৩০টা request, সবচেয়ে ধীরটার trace:

```
gateway · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
  gateway · HTTP GET → bff                  1,203 ms   |████████████████████████████████████████|
    bff · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
      bff · HTTP GET → work                 1,203 ms   |████████████████████████████████████████|
        work · GET /api/boards/:id          1,202 ms   |████████████████████████████████████████|
          work · cache.get board                1 ms   |█                                       |
          work · db.query tasks r3          1,200 ms   |████████████████████████████████████████|
      bff · HTTP GET → billing                 16 ms   |█                                       |
        billing · GET /plan/:id                15 ms   |█                                       |
```

এক নজরে: ১.২ সেকেন্ডের প্রায় পুরোটা একটা span এ — `db.query tasks`, attribute এ `r3`। Billing সমান্তরালে চলেছে আর ১৬ ms এ শেষ; সে দোষী না। বুধবার বিকেলের দুই দিনের প্রশ্নের উত্তর একটা ছবিতে।

আর একই trace id দিয়ে log খুঁজলে (অংশ খ) চারটা service এর লাইন একসাথে, ৯২টা লাইনের মধ্যে ঠিক এই request এর ৪টা:

```
{"ms":1533,"level":"warn","service":"work","trace_id":"0af27ba0…","span_id":"d1a17a…","msg":"slow query","replica":"r3","board":118}
{"ms":1533,"level":"info","service":"work","trace_id":"0af27ba0…","span_id":"1a9cae…","msg":"board loaded","board":118,"tasks":46}
{"ms":1533,"level":"info","service":"bff","trace_id":"0af27ba0…","span_id":"8935ce…","msg":"page composed","board":118}
{"ms":1534,"level":"info","service":"gateway","trace_id":"0af27ba0…","span_id":"01ae15…","msg":"request done","path":"/boards/118","status":200}
```

আর সব trace এর `db.query` span কে replica ধরে ভাগ করলে (অংশ গ) — r1 আর r2 এর max ৮ ms, r3 এর ১,২০০ ms। ১.৩ এর মাত্রা ধরে ভাগ, এবার trace থেকে — আর এখানে replica কেন, যেকোনো attribute ধরে ভাগ করা যায়, কারণ trace এ cardinality এর দাম নেই।

**Spaced repetition এর উত্তর:** waterfall এর ঘরগুলো **একই machine এর ঘড়ি** দিয়ে মাপা (span এর শুরু আর শেষ — monotonic clock, 6.4)। আলাদা machine এর span এর অবস্থান (ধরো bff এর span কে gateway এর span এর ভেতরে কতটা ডানে বসাবে) ঘড়ির skew এ কয়েক ms সরে যেতে পারে — কিন্তু **কে কার ভেতরে** সেটা ঘড়ি থেকে আসে না, আসে parent span id থেকে। Trace এর গঠন causality, ঠিক Lamport এর "happens-before" এর মতো: gateway এর span bff এর span এর parent, তাই gateway এর কাজ আগে শুরু হয়েছে — যেকোনো ঘড়ি যা-ই বলুক।

**একটা hop ভুল হলে।** অংশ ঘ — একই ৩০টা request, কিন্তু bff নিচের service কে ডাকার সময় `traceparent` পাঠাতে ভুলে যায় (একটা নতুন HTTP client, যেটা কেউ instrument করেনি — বাস্তবে খুব সাধারণ):

```
                              span   trace
header পাঠালে                     270      30
bff header না পাঠালে               270      90

   সবচেয়ে ধীর request এর gateway trace
gateway · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
  gateway · HTTP GET → bff                  1,203 ms   |████████████████████████████████████████|
    bff · GET /boards/:id                   1,202 ms   |████████████████████████████████████████|
      bff · HTTP GET → work                 1,202 ms   |████████████████████████████████████████|
      bff · HTTP GET → billing                 16 ms   |█                                       |

   ধীর query টা আছে অন্য একটা trace এ
work · GET /api/boards/:id                  1,202 ms   |████████████████████████████████████████|
  work · cache.get board                        1 ms   |█                                       |
  work · db.query tasks r3                  1,200 ms   |████████████████████████████████████████|
```

Span এর সংখ্যা একই (২৭০), কিন্তু trace ৯০টা — প্রতিটা request তিন টুকরো। User এর trace এ দেখা যায় bff ১.২ সেকেন্ড work এর জন্য অপেক্ষা করেছে, কিন্তু work এর ভেতরে কী হয়েছে তা নেই। আর ধীর query টা একটা এতিম trace এ, যার শুরু work এ — কোন user, কোন page, জানার উপায় নেই। Tracing এর শিকল তার সবচেয়ে দুর্বল hop এর সমান শক্ত, আর প্রতিটা নতুন HTTP client, প্রতিটা queue, প্রতিটা নতুন service একটা সম্ভাব্য ভাঙা hop।

**Async পথ।** একই সমস্যা queue এ: 7.3 এর BullMQ job, 7.5 এর outbox event — এগুলো HTTP না, তাই header নেই। Trace চালু রাখতে job এর data তে বা event এর payload এ `traceparent` রাখতে হয়, আর worker সেটা পড়ে নিজের span খোলে। (একটা job অনেক পরে চলতে পারে — মিনিট বা ঘণ্টা — তাই অনেক সময় তাকে parent-child না করে একটা **link** দিয়ে জোড়া হয়: "এই span টা ওই span এর কারণে, কিন্তু তার ভেতরে না"। OpenTelemetry তে span link আছে।)

### ১.৬ Sampling — কোন trace রাখবে

সব trace রাখলে কত? `npm run sampling` — একদিনে ২.৫৯ কোটি trace (৩০০ req/s), প্রতিটায় ২০টা span; তার মধ্যে ১৩,০৮৮টা error, ১,৩০,২৩৬টা এক সেকেন্ডের বেশি ধীর, আর একটা বিরল bug (একটা workspace এর জন্য) দিনে ৪৫বার:

```
নীতি                            রাখা trace    পুরো trace     error        ধীর   বিরল bug      জমা/দিন   collector এ আসে
সব রাখো                       25,920,000    100.000%    13,088   130,236     45/45     193 GB           193 GB
head ১০%                     2,593,300    100.000%     1,322    12,876      2/45    19.3 GB          19.3 GB
head ১%                        259,702    100.000%       129     1,319      0/45     1.9 GB           1.9 GB
head ০.১%                       26,119    100.000%        18       128      0/45     199 MB           199 MB
tail: error + ধীর + ১%          401,513    100.000%    13,088   130,236     45/45     3.0 GB           193 GB
tail: error + ধীর + ০.১%        169,232    100.000%    13,088   130,236     45/45     1.3 GB           193 GB
প্রতি service নিজে ১০%           10,620,422      0.002%         0         2      0/45     1.9 MB          19.3 GB
```

**Head sampling:** request এর **শুরুতে** — gateway এ — এলোমেলো সিদ্ধান্ত, "এই trace রাখব কি না", আর সেটা `traceparent` এর flag এ (`01`/`00`) পরের সব service এ যায়। সস্তা আর সরল: না রাখা trace এর span কেউ পাঠায়ই না। কিন্তু সিদ্ধান্তটা নেওয়া হয় **অন্ধভাবে** — request শুরুর সময় কেউ জানে না সেটা error হবে না ধীর। তাই head ১% এ ঠিক ১% error থাকে (১২৯টা) — আর বিরল bug এর ৪৫টার **একটাও** না। অংশ খ থেকে, দিনে ৪০বার ঘটা একটা bug এর অন্তত একটা trace হাতে থাকার সম্ভাবনা:

```
head হার           ১ দিনে       ১ সপ্তাহে
10%              98.5%      100.0%
1%               33.1%       94.0%
0.1%              3.9%       24.4%
```

**Tail Sampling** — trace রাখার সিদ্ধান্ত request **শেষ হওয়ার পরে** নেওয়া, পুরো trace দেখে: error হলে রাখো, ধীর হলে রাখো, বিশেষ কিছু (একটা নির্দিষ্ট customer, নতুন version) হলে রাখো, আর বাকি সাধারণ trace এর একটা ছোট ভগ্নাংশ; দাম — সিদ্ধান্তের আগে প্রতিটা trace এর সব span একটা collector এ জমা রাখতে হয়।

ফল টেবিলের পঞ্চম সারি: **সব error, সব ধীর, সব বিরল bug — ৩.০ GB এ, সব রাখার ৬৪ ভাগের এক ভাগে।** এটাই আসলে চাওয়া: আকর্ষণীয় trace গুলো, আর তুলনার জন্য কিছু সাধারণ।

দামটা শেষ কলামে: **collector এ আসে ১৯৩ GB** — সব রাখার সমান। Tail sampling জমার খরচ বাঁচায়, network আর collector এর খরচ না; প্রতিটা span collector পর্যন্ত যেতে হয়, আর সিদ্ধান্তের আগে কয়েক সেকেন্ড memory তে থাকতে হয় (এখানে যেকোনো মুহূর্তে ~২৫ MB)। আর একটা trace এর সব span একই collector instance এ পৌঁছাতে হয় — যাতে সে পুরো trace দেখে সিদ্ধান্ত নিতে পারে — তাই collector এর সামনে trace id ধরে ভাগ করা লাগে (10.1 এর consistent hashing, আবার)।

**আর শেষ সারি — সবচেয়ে সাধারণ ভুল।** প্রতিটা service নিজে নিজে ১০% sample করে, flag না মেনে। একটা trace পুরো থাকে শুধু যদি পাঁচটা service এরই "রাখো" পড়ে: ০.১⁵ = ০.০০১%। ১ কোটি trace এর টুকরো রাখা হয়েছে, পুরো trace প্রায় শূন্য, error এর পুরো trace শূন্য। Sampling এর সিদ্ধান্ত **একবার** নেওয়া হয় আর সবাই সেটা মানে — head এ flag এর মাধ্যমে, tail এ collector এ।

### ১.৭ Alert — কখন কাউকে জাগাবে

বুধবারের আরেকটা অংশ: TaskFlow এর একমাত্র alert টা প্রতিদিন দুপুর ২টায় বাজত, তাই সবাই সেটা mute করেছিল। যে alert সবসময় বাজে, সে কখনো বাজে না। প্রশ্ন হলো একটা alert কে কীভাবে এমন বানাবে যা **সত্যিকারের** সমস্যায় বাজে, দ্রুত, আর অকারণে না।

1.5 থেকে মনে করো: SLO ৯৯.৯% মানে ৩০ দিনে ০.১% request ব্যর্থ হতে পারে — **error budget**। ৩০০ req/s এ সেটা ৩০ দিনে ৭,৭৭,৬০০টা ব্যর্থ request। Alert এর আসল প্রশ্ন তাহলে "error rate কত?" না — **"এই হারে চললে budget কত দ্রুত শেষ হবে?"**

**Burn Rate** — error budget কত দ্রুত খরচ হচ্ছে, SLO এর অনুমোদিত হারের তুলনায়: burn rate ১ মানে ঠিক ৩০ দিনে budget শেষ হবে, ১৪.৪ মানে ৩০ দিনের budget শেষ হবে ~২ দিনে (আর এক ঘণ্টায় ২% খাবে); `burn rate = দেখা error ratio ÷ (১ − SLO)`। Alert বানানো হয় burn rate এর সীমা দিয়ে, error rate দিয়ে না।

`npm run alerts` — ৭ দিন, স্বাভাবিক error ০.০২%, প্রতিদিন দুপুর ২টায় deploy এ দুই মিনিট ৩% error, আর দিন ৪ এর সকাল ৯টায় একটা ঘটনা। চারটা alert নীতি:

- **error > ১%, ৫ মি** — TaskFlow এর এখনকার alert
- **error > ০.১%, ৫ মি** — "SLO এর সীমাতেই alert দিই"
- **burn > ১৪.৪, ১ ঘ** — এক ঘণ্টায় budget এর ২% খেলে
- **multi-window** — page যদি (১ ঘণ্টা **আর** ৫ মিনিট দুটোতেই burn > ১৪.৪) বা (৬ ঘণ্টা **আর** ৩০ মিনিট দুটোতেই burn > ৬); ticket (রাতে জাগানো না, কাজের সময়ে দেখা) যদি ৩ দিন আর ৬ ঘণ্টা দুটোতেই burn > ১

```
ঘটনা                                  budget খেল     error > ১%, ৫ মি   error > 0.1%, ৫ মি    burn > 14.4, ১ ঘ        multi-window
বড় outage: ৩০ মিনিট, ২০%                   13.9%          1 মি (0.5%)          1 মি (0.5%)          5 মি (2.3%)          5 মি (2.3%)
মাঝারি: ২ ঘণ্টা, ১.৫%                           4.1%          4 মি (0.1%)          1 মি (0.0%)         58 মি (2.0%)         58 মি (2.0%)
ধীর ক্ষয়: ৩ দিন, ০.৪%                        38.4%                 ধরেনি          2 মি (0.0%)                 ধরেনি ticket 14.4 ঘ (7.7%)
ছোট ঝাঁকুনি: ৩ মিনিট, ৩০%                        2.1%          1 মি (0.7%)          1 মি (0.7%)          3 মি (2.1%)          3 মি (2.1%)

── ৭ দিনে মোট কতবার page ──
কিছু না (শুধু deploy এর ঝাঁকুনি)                              7                   7                   0                   0
```

(বন্ধনীতে: ধরার মুহূর্তে ঘটনাটা মাসের budget এর কত % খেয়েছিল।)

- **TaskFlow এর এখনকার alert (১%):** বড় ঘটনা দ্রুত ধরে — কিন্তু **ধীর ক্ষয় কখনো ধরে না।** ০.৪% error তিন দিন — সীমার নিচে, তাই নীরব — আর সেই তিন দিনে মাসের budget এর **৩৮.৪%** শেষ। আর কিছু না ঘটলেও সপ্তাহে ৭বার page — প্রতিটা deploy। এই alert একই সাথে অন্ধ আর বাচাল।
- **SLO এর সীমায় alert (০.১%):** সব ধরে, দ্রুত — আর সপ্তাহে ৭বার অকারণে জাগায়। দুই মিনিটের ঝাঁকুনি budget এর নগণ্য অংশ খায়, কিন্তু তার মুহূর্তের error rate সীমার ত্রিশ গুণ।
- **এক ঘণ্টার burn rate:** অকারণ page শূন্য — দুই মিনিটের ঝাঁকুনি এক ঘণ্টার গড়ে মিলিয়ে যায়। কিন্তু ধীর ক্ষয় (burn ৪) কখনো ১৪.৪ ছোঁয় না।
- **Multi-window:** অকারণ page শূন্য, বড় ঘটনা ৫ মিনিটে, আর ধীর ক্ষয় ধরে ১৪.৪ ঘণ্টায় একটা **ticket** হিসেবে — budget এর ৭.৭% এ, ৩৮.৪% এ না। দুটো window এর যুক্তি: লম্বা window (১ ঘণ্টা) বলে "যথেষ্ট budget গেছে যে কারো জাগা উচিত"; ছোট window (৫ মিনিট) বলে "আর এটা **এখনো** চলছে" — তাই ঘটনা থেমে গেলে alert নিজেই দ্রুত বন্ধ হয়।

আর দামটা সৎভাবে: **মাঝারি ঘটনা (১.৫% error, দুই ঘণ্টা) ধরতে burn rate এর alert ৫৮ মিনিট নেয়** — ১% এর alert নেয় ৪ মিনিট। এক ঘণ্টা ধরে প্রতি ৬৭টা request এর একটা ব্যর্থ, আর কেউ জাগেনি। এটা নকশার সচেতন সিদ্ধান্ত: বিনিময়ে সপ্তাহে সাতটা মিথ্যা page নেই, আর মানুষ alert কে বিশ্বাস করে। কোন দিকে ঝুঁকবে, সেটা আবার error budget এর হিসাব — দুই ঘণ্টায় ৪.১% খরচ মাসের budget এর মধ্যে সহ্য করা যায়; রোজ সাতবার জাগানো মানুষ সহ্য করে না।

এই সীমা আর window গুলো (১৪.৪ — ১ ঘ/৫ মি, ৬ — ৬ ঘ/৩০ মি, ১ — ৩ দিন/৬ ঘ) Google এর SRE Workbook এর "Alerting on SLOs" অধ্যায়ের প্রস্তাব (এখানে যাচাই করা না)। Exercise এর experiment ৪: SLO ৯৯.৯৯% করলে কোনো ঘটনা ছাড়াই multi-window একটা ticket তোলে — স্বাভাবিক ০.০২% error আর রোজকার deploy মিলেই সেই budget এর চেয়ে দ্রুত খায়। SLO টা নিজেই অসৎ; alert শুধু সেটা ধরিয়ে দিচ্ছে।

**কীসের উপর alert।** Burn rate এর alert দাঁড়িয়ে থাকে একটা জিনিসের উপর: user যা অনুভব করে (board খোলা সফল হলো কিনা, কত দ্রুত) — যাকে বলে SLI, service level indicator। CPU ৯০%, disk ৮০%, replica lag — এগুলো **কারণ**, user এর **লক্ষণ** না। কারণের উপর page করলে এমন অনেক রাত আসে যখন CPU ৯০% কিন্তু কোনো user কিছু টের পায়নি; আর এমন রাতও আসে যখন সব কারণ সবুজ, কিন্তু user রা ভুগছে (বুধবার)। নিয়ম: **লক্ষণে page, কারণ dashboard এ** — page আসার পরে মানুষ কারণ খুঁজবে। (Dashboard সাজানোর দুটো পরিচিত ছক: প্রতিটা service এর জন্য **RED** — Rate, Errors, Duration; প্রতিটা সম্পদ (CPU, disk, pool) এর জন্য **USE** — Utilization, Saturation, Errors।)

### ১.৮ TaskFlow এর সিদ্ধান্ত

> **Trade-off Table — তিনটা সংকেত, কোথায় কী**

| প্রশ্ন                                    | কোথায়                                 | কেন অন্য জায়গায় না                                                   |
| ----------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| "কিছু কি খারাপ? কখন থেকে?"                | Metric (histogram), burn rate এর alert | Log/trace থেকে প্রতিবার গুনতে হয় — ধীর, দামি, sampling এ অসম্পূর্ণ    |
| "কোন মোটা ভাগে? (route, region, replica)" | Metric এর label — শুধু সীমিত মান       | —                                                                      |
| "এই request এর সময় কোথায় গেল?"          | Trace                                  | Metric এ আলাদা request নেই; log এ সময়ের গঠন নেই                       |
| "কোন user / board / workspace?"           | Trace এর attribute, log এর field       | Metric এ দিলে cardinality (২,৪০০ → ২৫ লাখ series)                      |
| "ঠিক কী ঘটেছিল, কোন মান নিয়ে?"           | Structured log, trace id সহ            | Metric এ বিস্তারিত নেই; trace এ সাধারণত শুধু সময় আর কয়েকটা attribute |

**Instrumentation:** OpenTelemetry SDK প্রতিটা service এ (gateway, BFF, monolith, billing, files, worker), auto-instrumentation `http`, `express`, `pg`, `ioredis`, BullMQ এ। W3C `traceparent` সব HTTP call এ; outbox event আর BullMQ job এর payload এ `traceparent` (worker span link দিয়ে জোড়ে)। CI তে একটা test: একটা request চালিয়ে দেখো চারটা service এর span একই trace এ — ১.৫ এর ভাঙা hop যাতে merge এর আগে ধরা পড়ে (10.3 এর matrix এর মতোই)।

**Log:** সব service এ structured JSON, এক লাইনে একটা ঘটনা; প্রতিটা লাইনে `trace_id`, `span_id`, `service`, `version`। প্রতি request এ শেষে একটা "wide" লাইন (route, status, সময়, user, workspace, board, replica, cache hit)। Debug log শুধু একটা flag দিয়ে, একটা নির্দিষ্ট user বা workspace এর জন্য, ৩০ মিনিটে নিজে বন্ধ। Field এর allowlist (password, token, body কখনো না)। Retention: ১৪ দিন গরম, তারপর সস্তা storage এ।

**Metric:** প্রতিটা endpoint এ latency এর histogram — label শুধু `route` (template), `method`, `status_class` (2xx/4xx/5xx), `instance`, `region`; bucket SLO এর সীমার আশেপাশে ঘন। `user_id`, `board_id`, `workspace_id`, আসল path কখনো label এ না — CI তে একটা lint যা নতুন label এর মানের সংখ্যা দেখে। Prometheus এ প্রতি metric এ series এর একটা সীমা, আর মোট series এর একটা dashboard (cardinality নিজেই একটা metric)। Dependency গুলোর জন্য আলাদা metric — `db_query_seconds{replica}`, `cache_requests{node, result}`, `flags_config_age_seconds` (10.3) — যাতে শনিবারের মতো রাতে graph নিজেই `flags` এর দিকে দেখায়।

**Trace:** tail sampling — সব error, সব > ১ s, সব নতুন version এর প্রথম ঘণ্টা (10.6), আর বাকির ১%। Collector এর সামনে trace id ধরে ভাগ। Histogram এ exemplar, যাতে graph এর স্পাইক থেকে এক click এ একটা trace।

**Alert:** board খোলা, task তৈরি, login — তিনটা journey এর SLI (সফলতা আর latency), প্রতিটায় multi-window burn rate: page আর ticket। পুরনো "error > ১%" alert মুছে ফেলা। প্রতিটা page এর সাথে একটা runbook এর link, আর runbook এর প্রথম লাইন: "কোন dependency? → এই dashboard"। Brownout এর ধাপ (10.3) আর config এর বয়স — ticket, page না।

---

## ২. Interview Angle

Observability প্রায় কখনো আলাদা প্রশ্ন হয় না — আসে design এর শেষে, "how would you monitor this?" বা "এটা production এ ধীর হলে কীভাবে খুঁজবে?" হিসেবে। এখানে একটা দুর্বল উত্তর হলো "Prometheus আর Grafana বসাব, log ELK এ" — যন্ত্রের নাম, চিন্তা না। ভালো উত্তরের আকৃতি:

1. **SLI আর SLO দিয়ে শুরু করো** — "এই system এ user এর কাছে কী জরুরি? Feed লোড হওয়ার সফলতা আর p99 latency। SLO: ৯৯.৯% সফল, ৯৯% ৫০০ ms এর নিচে।" তারপর বলো alert হবে এই SLO এর burn rate এ।
2. **তিনটা সংকেত, তাদের কাজ সহ** — metric (কী খারাপ), trace (কোথায়), log (কেন); আর trace id যা তিনটাকে জোড়ে।
3. **Design এর বিশেষ জায়গাগুলো** — queue থাকলে queue এর বয়স (সবচেয়ে পুরনো message কতক্ষণ অপেক্ষা করছে), cache থাকলে hit rate, replica থাকলে lag; async পথে trace এর context।
4. **দামের কথা** — sampling, cardinality, log এর আয়তন। একটা বাক্যও যথেষ্ট: "user id metric এ না, trace এ।"

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"p99 কেন, average কেন না?"_ — লেজেই user রা থাকে, কারণ প্রতিটা user অনেক request করে: ২.৫% ধীর মানে ২০টা page এ ~৪০% user অন্তত একবার ধীর। আর বোনাস: percentile গড় করা যায় না, histogram এর bucket যোগ করা যায়।
- _"Microservice এ একটা ধীর request কীভাবে debug করবে?"_ — distributed tracing: trace id, span, context propagation (W3C traceparent), waterfall এ সময় কোথায় গেল। আর async hop এ context টেনে নেওয়া।
- _"সব trace রাখবে?"_ — না; head sampling সস্তা কিন্তু অন্ধ, tail sampling error আর ধীর রাখে কিন্তু collector এর খরচ। সিদ্ধান্ত একবার, সবাই মানে।
- _"Alert কীসের উপর?"_ — লক্ষণে (SLI এর burn rate), কারণে না (CPU); multi-window, page বনাম ticket; আর alert fatigue এর নাম নেওয়া।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ভুলগুলো — dashboard এ শুধু গড়; percentile এর গড় করে "ঘণ্টার p99" দেখানো; একটা নতুন label (user id, আসল URL, error message এর পুরো text) যা metric system কে নিঃশব্দে ফোলায় তারপর মারে; log এ request id নেই, বা আছে কিন্তু পরের service এ যায় না; প্রতিটা service নিজে নিজে sample করে, তাই কোনো trace পুরো না; queue পেরোনোর সময় trace ভেঙে যায়; সব কিছুতে alert, তাই কোনো কিছুতেই না; আর debug log চালু করে বন্ধ করতে ভুলে যাওয়া।

---

## ৩. Key Takeaway

- **Monitoring জানা প্রশ্নের উত্তর দেয়, observability অজানা প্রশ্নের** — metric বলে কিছু খারাপ, trace বলে কোথায়, log বলে কেন; আর একটা trace id তিনটাকে জোড়ে
- **গড় লেজ লুকায়** — গড় ১৭২ ms (সবুজ), p99 ৩.৭৯ s; ২.৫% ধীর মানে দিনে ২০টা board খোলা user দের ~৪০% অন্তত একবার ৪ সেকেন্ড অপেক্ষা করে
- **Percentile যোগ বা গড় করা যায় না** — মিনিটের p99 এর গড় ৬১৭ ms, median ১৮৭ ms, আসল ৩.৭৯ s; histogram এর bucket যোগ করা যায় — আর bucket যেখানে সিদ্ধান্ত হয় সেখানে ঘন রাখো (default এ p90 +৫৫%)
- **Metric এর দাম label এর মানের গুণফল** — ২,৪০০ series থেকে আসল path বা user id দিলে ২৫ লাখ; সীমিত মান metric এ, অসীম মান (user, board, trace id) log আর trace এ
- **Distributed trace = একটা trace id + প্রতিটা hop এ `traceparent` + AsyncLocalStorage** — ধীর request এর ১.২ সেকেন্ড এক span এ দেখা যায়; একটা hop header না পাঠালে ৩০টা request ৯০টা trace, আর ধীর query এতিম
- **Head sampling সস্তা কিন্তু অন্ধ** (১% এ বিরল bug এর ৪৫টার একটাও না), **tail sampling সব error আর ধীর রাখে** (৩ GB এ, কিন্তু collector এ ১৯৩ GB আসে); আর প্রতিটা service নিজে sample করলে পুরো trace ০.০০২%
- **Alert কর burn rate এ, লক্ষণে, multi-window এ** — "error > ১%" ধীর ক্ষয় মিস করে (budget এর ৩৮%) আর সপ্তাহে ৭বার অকারণে জাগায়; multi-window অকারণ page শূন্য, দাম মাঝারি ঘটনায় ৫৮ মিনিটের দেরি

---

## ৪. নতুন Term (Glossary)

| Term                   | অর্থ                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Observability**      | বাইরের সংকেত (log, metric, trace) দিয়ে system এর ভেতরের অবস্থা সম্পর্কে আগে না ভাবা প্রশ্নের উত্তর দিতে পারা, নতুন code deploy না করে; monitoring জানা প্রশ্নের উত্তর দেয়                    |
| **Histogram** (metric) | প্রতিটা মান না রেখে কতগুলো মান কোন bucket এ পড়েছে তা গোনা — bucket যোগ করা যায় (instance, সময় জুড়ে), যোগফল থেকে percentile অনুমান; নির্ভুলতা bucket এর সীমার উপর                           |
| **Label Cardinality**  | একটা metric এর label গুলোর মানের সমন্বয়ের সংখ্যা = তার time series এর সংখ্যা; প্রতিটা label এর মানের সংখ্যার গুণফল পর্যন্ত; অসীম মানের label (user id, path) metric system কে মারে            |
| **Structured Logging** | Log কে বাক্য না, field-মানের রেকর্ড হিসেবে (এক লাইনে একটা JSON) লেখা, সাথে correlation id (trace id) — যাতে field দিয়ে খোঁজা, ছাঁকা, গোনা আর service জুড়ে জোড়া যায়                         |
| **Trace / Span**       | Trace = একটা request এর পুরো যাত্রা (একটা trace id); span = তার একটা কাজ (id, শুরু, শেষ, attribute, parent span id); context propagation (W3C `traceparent`) id কে service থেকে service এ নেয় |
| **Tail Sampling**      | Trace রাখার সিদ্ধান্ত request শেষে, পুরো trace দেখে (error, ধীর, বিশেষ — সব; বাকির একটা ভগ্নাংশ); head sampling শুরুতে অন্ধভাবে সিদ্ধান্ত নেয় — সস্তা, কিন্তু বিরল ঘটনা হারায়                |
| **Burn Rate**          | Error budget খরচের গতি, SLO এর অনুমোদিত হারের তুলনায় (`error ratio ÷ (১ − SLO)`); ১ = ঠিক মেয়াদে শেষ, ১৪.৪ = এক ঘণ্টায় মাসের ২%; alert error rate এ না, burn rate এ, একাধিক window এ        |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এর "task তৈরি" endpoint এর জন্য একটা latency metric নকশা করো। SLO: ৩০ দিনে ৯৯% task তৈরি ৩০০ ms এর নিচে। (ক) কোন label রাখবে, আর তাতে কয়টা time series (histogram সহ) হবে — হিসাব দেখাও। (খ) Bucket কোথায় কোথায় রাখবে, আর কেন? (গ) Sales টিম চায় তাদের ২০টা সবচেয়ে বড় enterprise customer এর জন্য আলাদা latency graph। একজন বলল "`workspace_id` label দাও"। কেন না — আর তাদের চাওয়া কীভাবে পূরণ করবে?

2. একজন user লিখল: "আমাকে একটা task assign করা হয়েছিল, email এলো ২০ মিনিট পরে।" Assign থেকে email এর পথ: API (task আপডেট + outbox row, 7.5) → outbox relay → Redis Streams → BullMQ worker (7.3) → email provider। (ক) এই একটা ঘটনার পুরো পথ একটা trace এ দেখতে কী কী করতে হবে — কোন hop এ context কীভাবে যাবে? (খ) Trace টা ২০ মিনিট লম্বা হবে। এটা parent-child হবে না link — কেন? Tail sampling এ এর কী সমস্যা? (গ) এই ধরনের দেরি **আগেই** ধরতে কোন metric রাখবে, আর alert কীসের উপর?

3. Board খোলার জন্য দুটো SLO: সফলতা ৯৯.৯%, আর latency — ৩০ দিনে ৯৯% board ৫০০ ms এর নিচে। (ক) Latency SLO এর "খারাপ ঘটনা" কী, আর ৩০০ req/s এ মাসের budget কত? (খ) Burn rate ১৪.৪ এর page বাজলে এক ঘণ্টায় budget এর কত % গেছে, কয়টা ধীর request? (গ) 10.3 এর brownout চালু হলো — board এ "এরকম আরও board" আর activity panel বন্ধ, কিন্তু board দ্রুত আসছে। Latency SLO সবুজ, সফলতার SLO সবুজ। এটা কি সমস্যা? কী মাপবে, আর কীসে page করবে না?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) "Task তৈরি" একটাই route আর method, তাই সেগুলো স্থির। Label: `status_class` (2xx, 4xx, 5xx — ৩টা; পুরো status code না, কারণ ২০টা status code কোনো সিদ্ধান্তে কাজে লাগে না), `instance` (৬টা), `region` (ধরো ২টা), `plan` (৩টা — free/pro/business, কারণ plan ভেদে quota এর পথ আলাদা, 9.4)।

```
সমন্বয় = ৩ × ৬ × ২ × ৩ = ১০৮
bucket ধরো ১১টা → প্রতি সমন্বয়ে ১২টা bucket series (+Inf সহ) + _sum + _count = ১৪
মোট = ১০৮ × ১৪ = ১,৫১২টা series
```

চলে। `instance` রাখা নিয়ে তর্ক হতে পারে (autoscale এ নতুন instance নতুন series বানায়, পুরনোগুলো থাকে কিছুক্ষণ) — কিন্তু একটা খারাপ instance খোঁজার জন্য এটা দরকারি, আর সংখ্যাটা ছোট।

(খ) Bucket SLO এর সীমা (৩০০ ms) এর আশেপাশে ঘন, কারণ সেখানেই প্রশ্ন "৯৯% কি ৩০০ এর নিচে?": ২৫, ৫০, ১০০, ১৫০, ২০০, ২৫০, **৩০০**, ৪০০, ৬০০, ১,০০০, ৩,০০০ ms। ৩০০ একটা bucket এর সীমা হওয়া জরুরি — তাহলে "৩০০ এর নিচে কত %" এর উত্তর অনুমান না, সরাসরি গোনা (`le="300"` এর count ÷ মোট)। SLO এর হিসাবে percentile এর অনুমানের দরকারই নেই — শুধু সেই bucket। দূরের bucket পাতলা (৩ s এর পরে আর কিছু লাগে না — সেগুলো তো ব্যর্থ ধরা হবে)।

(গ) `workspace_id` এর মান ২ লাখ — ১০৮ × ২,০০,০০০ × ১৪ ≈ ৩০ কোটি series। Metric system মরবে (১.৪), আর ২০টা workspace এর জন্য বাকি ১,৯৯,৯৮০টার দাম দিতে হবে। পথ:

- **সীমিত তালিকা:** একটা `customer_tier` label যার মান `enterprise_top20` বা `other` — তাহলে ২০টার যোগফলের একটা graph, series দ্বিগুণ মাত্র। কিন্তু ২০টা আলাদা না।
- **আলাদা আলাদা দরকার হলে:** একটা allowlist — একটা ছোট metric যেখানে `workspace` label এর মান শুধু ওই ২০টার নাম, বাকি সব `other` — ২১টা মান, আর তালিকাটা config এ, code এ না। দামটা সীমিত, আর কেউ ভুলে তালিকা না বাড়ালে সীমিত থাকে।
- **বিস্তারিত বিশ্লেষণ:** trace এর attribute এ `workspace_id` সবসময় থাকে, আর tail sampling এ এই ২০টার সব trace রাখার নিয়ম ("বিশেষ customer — সব রাখো")। তাহলে যেকোনো প্রশ্ন ("এই customer এর ধীর request গুলোয় কী মিল?") trace থেকে।

**প্রশ্ন ২:**

(ক) প্রতিটা hop এ context বহন:

- **API → outbox:** task আপডেটের transaction এ outbox row লেখার সময় তার payload এ এখনকার `traceparent` রাখা।
- **Relay → Redis Streams:** relay row পড়ে event পাঠায় — event এর একটা field এ সেই `traceparent` (relay নিজের একটা span খোলে, link দিয়ে)।
- **Stream consumer → BullMQ:** job এর data তে `traceparent`।
- **Worker:** job শুরুতে `traceparent` পড়ে নিজের span খোলে; provider কে HTTP call এ স্বাভাবিক `traceparent` header।

প্রতিটা hop এ ভুল হলে ১.৫ এর অংশ ঘ — trace টুকরো, আর worker এর span এতিম।

(খ) **Link, parent-child না।** Parent-child মানে "এই কাজ ওই কাজের **ভেতরে**" — parent span শেষ হওয়ার আগে child শুরু হয়। কিন্তু API এর request ৫০ ms এ শেষ, user উত্তর পেয়ে গেছে; email এর কাজ ২০ মিনিট পরে। একে parent-child বানালে ২০ মিনিটের একটা "request" দেখায়, যা মিথ্যা — waterfall অর্থহীন। Link বলে "এই কাজ ওই কাজের কারণে" — দুটো আলাদা trace, জোড়া। **Tail sampling এর সমস্যা:** collector কয়েক সেকেন্ড অপেক্ষা করে সিদ্ধান্ত নেয় (এখানে ১০ s)। ২০ মিনিট পরের span এর জন্য সে অপেক্ষা করতে পারবে না — API এর trace এর সিদ্ধান্ত অনেক আগে হয়ে গেছে। তাই প্রতিটা অংশ আলাদা trace হিসেবে sample হয়; worker এর trace "ধীর" না (সে নিজে দ্রুত), তাই হয়তো ফেলা হবে। প্রতিকার: worker এর span এ "queue তে কতক্ষণ ছিল" একটা attribute (`queue.wait_ms`), আর tail sampling এর নিয়মে "queue এর অপেক্ষা > ৫ মিনিট হলে রাখো"।

(গ) এই দেরি একটা request এর latency না — **queue এর বয়স**। Metric:

- প্রতিটা queue/stream এর **সবচেয়ে পুরনো অপেক্ষমাণ message এর বয়স** (gauge) — সবচেয়ে গুরুত্বপূর্ণ; queue এর দৈর্ঘ্য না, কারণ ১,০০০টা message ১ সেকেন্ডে শেষ হলে সমস্যা নেই, ১০টা message ২০ মিনিট পড়ে থাকলে আছে।
- Outbox এর অপ্রেরিত row এর সবচেয়ে পুরনোটার বয়স (relay আটকে গেলে)।
- Assign থেকে email provider এ পৌঁছানো পর্যন্ত সময়ের histogram (event এ assign এর সময় রাখা, worker শেষে মাপে)।

Alert: একটা SLO — "৯৯% assign email ২ মিনিটের মধ্যে provider এ পৌঁছায়" — আর তার burn rate এ page/ticket। Queue এর বয়সের graph dashboard এ, কারণ হিসেবে।

**প্রশ্ন ৩:**

(ক) "খারাপ ঘটনা" = একটা board খোলা যা ৫০০ ms এর বেশি নিল (ব্যর্থগুলোও খারাপ ধরা হয়, বা আলাদা SLO তে থাকে — একটা ঠিক করে নিয়ম লেখো)। Budget: ১% —

```
৩০০ req/s × ৮৬,৪০০ s × ৩০ = ৭৭.৭৬ কোটি board খোলা
১% = ৭৭,৭৬,০০০টা ধীর board খোলা — মাসে
```

(এখানে histogram এর ৫০০ ms একটা bucket এর সীমা হওয়া বাধ্যতামূলক — প্রশ্ন ১ এর (খ)।)

(খ) Burn rate ১৪.৪ এক ঘণ্টা ধরে = এক ঘণ্টায় মাসের budget এর ১৪.৪ ÷ ৭২০ = **২%**। সংখ্যায়: ৭৭,৭৬,০০০ × ০.০২ ≈ **১,৫৫,৫২০টা** ধীর request, অর্থাৎ ওই ঘণ্টার ১০.৮ লাখ request এর ~১৪.৪% ৫০০ ms এর বেশি। (Burn rate এর সংজ্ঞা থেকে সরাসরি: ১৪.৪ × ১% = ১৪.৪% খারাপ।)

(গ) সমস্যা — দুটো SLO ই সবুজ, অথচ user রা কম পাচ্ছে। Brownout ঠিক এটাই করার জন্য নকশা করা (10.3): latency রক্ষা করো, অংশ ছাড়ো। তাই **এটা page এর ঘটনা না** — system ঠিক যা করার কথা তাই করছে, আর কেউ জেগে কিছু করার নেই। কিন্তু **অদৃশ্যও থাকা চলবে না**:

- Metric: `brownout_level` (gauge) আর "পুরো page পাওয়া board খোলার %" — একটা তৃতীয় SLI, ধরো "৯৫% board খোলা পুরো page"। তার উপর **ticket** (কাজের সময়ে দেখা): brownout ঘণ্টার পর ঘণ্টা চললে মানে ক্ষমতা কম — capacity বাড়ানোর সিদ্ধান্ত লাগবে।
- কেন page না: brownout স্বয়ংক্রিয়ভাবে নামে; রাত ৩টায় কাউকে জাগিয়ে "panel বন্ধ আছে" বলার মানে নেই, যদি না সে কিছু বদলাতে পারে।
- আর একটা সূক্ষ্মতা: brownout চলাকালীন latency SLO সবুজ দেখায় **কারণ** কাজ কম হচ্ছে। Brownout না থাকলে কী হতো সেটা এই সংখ্যা বলে না — তাই capacity এর পরিকল্পনায় brownout এর সময়টা "স্বাভাবিক" ধরা ভুল।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (চারটা script deterministic simulation; পঞ্চমটা localhost এ চারটা আসল HTTP service; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.4-observability/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.4-observability) — `npm install`, তারপর `npm run percentiles`, `npm run cardinality`, `npm run sampling`, `npm run alerts`, `npm run trace`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`percentiles` এক ঘণ্টার board খোলায় গড়, percentile, মিনিটের rollup, histogram এর bucket আর মাত্রা ধরে ভাগ মাপে। `cardinality` একদিনের traffic এ label এর সেট ধরে time series গোনে, আর log ও trace এর আয়তন। `sampling` একদিনের trace এ head, tail আর বিচ্ছিন্ন sampling মেলায়। `alerts` সাত দিনের error এ চারটা alert নীতি — কে কোন ঘটনা কখন ধরে, আর কতবার অকারণে জাগায়। `trace` localhost এ চারটা আসল `node:http` service চালায়, নিজের হাতে লেখা ছোট tracing library দিয়ে (`traceparent`, `AsyncLocalStorage`, JSON log) — waterfall, trace id দিয়ে log খোঁজা, আর একটা hop header না পাঠালে কী হয়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` আর ESLint clean; প্রথম চারটা script দুবার করে, output হুবহু এক (byte ধরে মেলানো); `trace` তিনবার — trace এর গঠন আর span ও trace এর সংখ্যা প্রতিবার একই; ms এর মান কয়েক ms আলাদা (আসল সময় মাপা), আর দুটো request প্রায় সমান ধীর বলে কোনটা "সবচেয়ে ধীর" হিসেবে দেখানো হয় — আর তাই দেখানো trace id — run ভেদে বদলাতে পারে। **প্রথম চারটা script এ কোনো network, Prometheus, log store বা আসল সময় নেই** — latency seed দেওয়া এলোমেলো মান, সব সংখ্যা গোনা আর হিসাব করা। `trace` এর service গুলো আসল HTTP, কিন্তু cache, replica আর billing এর কাজ `setTimeout` দিয়ে নকল; tracing library নিজের হাতে লেখা, OpenTelemetry না। ধরে নেওয়া সংখ্যা: series প্রতি ~৩ KB memory, log লাইন ~৩৫০ byte, span ~৪০০ byte, trace এ ২০টা span — এগুলো আন্দাজ; series এর **সংখ্যা** গোনা। **যা মাপা হয়নি:** আসল Prometheus এর memory, আসল OpenTelemetry collector আর tail sampling processor, exemplar, span link, queue পেরোনো trace, আসল log store এর খরচ। ১.৭ এর burn rate এর সীমা আর window Google এর SRE Workbook থেকে; ১.৩ এর default bucket Prometheus এর client library এর; RED আর USE পরিচিত ছক — এগুলো তাদের documentation আর প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। ১.৮ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** `percentiles` চালানোর **আগে** লিখে ফেলো — ঘণ্টায় তিনবার ৯০ সেকেন্ড, তিনটা replica এর একটা, ~৩.৫ সেকেন্ড বাড়তি: গড় কত হবে, কত % request এক সেকেন্ডের বেশি, আর p99 কোথায়? তারপর চালিয়ে মেলাও। এবার `STALL_SECONDS=20` — এবার মিনিটের p99 এর গড় আসলের চেয়ে বড় কেন?

2. **নিজের metric এর হিসাব:** প্রশ্ন ১ এর metric `cardinality.ts` এ একটা নতুন variant হিসেবে যোগ করো (task তৈরির route, `status_class`, `instance`, `plan`)। তোমার হাতের হিসাব আর গোনা series মেলে? না মিললে কেন (কোন সমন্বয় একদিনে ঘটেইনি)?

3. **Trace এ একটা নতুন hop:** `trace.ts` এ work service থেকে একটা পঞ্চম service ("flags") কে ডাকো, `call` দিয়ে। তারপর ইচ্ছা করে `propagate = false` দিয়ে ডাকো। অংশ ঘ এর মতো trace এর সংখ্যা কত হলো? Waterfall এ কী হারাল? এবার flags কে ৫০০ ms ধীর করো — 10.3 এর শনিবার রাতে এই waterfall থাকলে on-call কত দ্রুত `flags` কে খুঁজে পেত?

4. **Alert এর সীমা:** `SLO=0.9999 npm run alerts`, তারপর `DEPLOY_BLIP=0.2 npm run alerts`। প্রথমটায় কোনো ঘটনা ছাড়া কী বাজল, আর কেন সেটা SLO এর সমস্যা, alert এর না? দ্বিতীয়টায় deploy এর ঝাঁকুনি বড় হলে multi-window কী করল — আর সেটা কি ঠিক আচরণ?

5. **Design অংশ:** TaskFlow এর mobile app এর জন্য observability এর এক পাতার plan। (ক) Mobile এর SLI কী — server এর latency, নাকি user এর phone এ board দেখা পর্যন্ত সময়? দুটোর পার্থক্য কোথা থেকে আসে? (খ) Phone থেকে trace শুরু করবে? Sampling এর সিদ্ধান্ত কোথায়, আর network না থাকলে span কী হবে? (গ) Phone এর log আর crash report এ কী রাখবে না (10.5 এর দিকে তাকিয়ে)? (ঘ) পুরনো app version গুলো বছর ধরে চলে — একটা নতুন label (`app_version`) এর cardinality কীভাবে সীমিত রাখবে? (ঙ) কোন একটা জিনিসে page করবে, আর কোনটায় শুধু ticket?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ), 10.1, 10.2, 10.3
Current: 10.4 — Observability: logging, metrics, tracing
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limit
দুই স্তরে; cache ring; share link এ Bloom filter, active user HLL এ; journey ধরে hard/soft dependency
+ CI তে fault injection; flags এর snapshot; board এ brownout; chaos program। বুধবার: replica r3 এর disk
মাঝে মাঝে আটকায় → board এর ২.৫% ৪ s, গড় ১৭০ ms (সবুজ), কেউ দেখেনি; log এ id নেই; metric এ user_id আর
path label দিয়ে Prometheus OOM (রাতভর কোনো metric/alert নেই); debug log এ আয়তন ২৫ গুণ; দুই দিনে কাকতালীয়ভাবে
পাওয়া। এখন: OpenTelemetry সব service এ (auto-instrumentation http/express/pg/ioredis/BullMQ), W3C traceparent
সব HTTP তে, outbox event আর job এর payload এ (span link); CI তে "চারটা service একই trace এ" test;
structured JSON log, প্রতি লাইনে trace_id/span_id/service/version, প্রতি request এ একটা wide লাইন, field
allowlist, debug শুধু flag দিয়ে একজন user/workspace এর জন্য ৩০ মিনিট; latency histogram, label শুধু
route template/method/status_class/instance/region, bucket SLO এর আশেপাশে ঘন, অসীম মানের label নিষেধ
(CI lint, প্রতি metric এ series এর সীমা, cardinality এর dashboard); dependency metric (db_query_seconds
{replica}, cache, flags_config_age); tail sampling (সব error, > 1 s, নতুন version এর প্রথম ঘণ্টা, বাকির ১%),
collector এর সামনে trace id ধরে ভাগ, exemplar; alert: board/task/login এর SLI তে multi-window burn rate
(page + ticket), পুরনো "error > ১%" মোছা, প্রতিটা page এ runbook; brownout আর config এর বয়স ticket
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 10.5 — Security at scale: authN vs authZ, OAuth/JWT, secret management, DDoS
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **data থাকা আর উত্তর থাকা এক জিনিস না।** গড় লেজ লুকায়, percentile গড় করলে মিথ্যা বলে, আর ভুল জায়গায় একটা label পুরো metric system কে মারে। Metric বলে কিছু খারাপ, trace বলে কোথায়, log বলে কেন — আর তিনটাকে বাঁধে একটা id, যা প্রতিটা hop এ নিজে থেকে যায় না, পাঠাতে হয়। আর alert এর প্রশ্ন "কত % error" না, "budget কত দ্রুত পুড়ছে" — কারণ যে alert রোজ বাজে, সে আসলে কখনো বাজে না।

আজ বেশ কয়েকবার একটা কথা পাশ কাটিয়ে গেছি: log এ password বা token যেন না যায়; gateway JWT যাচাই করে আর একটা internal token বসায় (9.2); trace এ `user_id` আছে — তাহলে কে trace দেখতে পারে? এগুলো সব একটা বড় প্রশ্নের টুকরো। রেডি হলে `next` লিখো — **Lesson 10.5: Security at Scale — authN vs authZ, OAuth/JWT, Secret Management, DDoS** এ যাব। সেখানে প্রশ্নটা: যখন একটা request ছয়টা service পেরোয়, তখন "এই user কে?" আর "সে কি এটা করতে পারে?" কে কোথায় উত্তর দেয় — আর একটা ফাঁস হওয়া token, একটা commit এ ভুলে যাওয়া secret, বা সেকেন্ডে লাখ request এর সামনে TaskFlow কী করে।
