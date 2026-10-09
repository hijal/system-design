# Module 12 - Exit Challenge (Interview Mastery & Capstone)

**Module 12 - Interview Mastery & Capstone**

Module 12 শেষ: দশটা ভুল আর rubric (12.1), estimation এর গতি (12.2), দুটো mock (12.3, 12.4), নিজের system এর গল্প (12.5), আর TaskFlow এর পুরো design doc আর একটা মাপা core piece (12.6)। আর এর সাথে পুরো course শেষ।

দুটো mock এ আপনার সাথে একটা script ছিল: interviewer এর উত্তর একটা বন্ধ অংশে, follow-up তার মিনিটে, push-back আপনার উত্তরের পরে। আসল interview এ কোনো script থাকে না। এই challenge এ একটা নতুন system, ৫০ মিনিট, কোনো বন্ধ অংশ ছাড়া। Follow-up গুলো আসবে mock **শেষ হওয়ার পরে,** লেখা হিসেবে, যাতে আপনি দেখতে পারেন কোনগুলো আপনি নিজে থেকে তুলেছিলেন আর কোনগুলো আপনাকে জিজ্ঞেস করতে হতো। আর system এর একটা অংশ ইচ্ছা করে এই course এর বাইরে: ঠিক যেমন আসল interview এ হয়।

---

## ১. Mini Design Challenge (Tier 3)

### পর্ব ১ - Mock, ৫০ মিনিট, কোনো সাহায্য ছাড়া

12.3 আর 12.4 এর নিয়ম: recording চালু, timer চালু, পুরোটা জোরে, board এর কোণে time box (`Req 5 · Est 5 · HLD 10 · Deep 25 · Wrap 5`) আর 12.4 এর score এর সবচেয়ে কম দুটো মাত্রা।

**প্রশ্ন (00:00):**

> "একটা শহরের জন্য food delivery এর order আর rider dispatch design করুন।"

**নিচের scenario পড়ার আগে:** দুই মিনিটে নিজের clarifying question গুলো কাগজে লিখুন, যেন interviewer কে জিজ্ঞেস করছেন। তারপর scenario পড়ুন, আর প্রতিটা প্রশ্নের পাশে টিক দিন যার উত্তর এখানে আছে। যে প্রশ্নের উত্তর নেই, সেটা আপনার stated assumption। আর scenario তে যে গুরুত্বপূর্ণ তথ্য আছে কিন্তু আপনি জিজ্ঞেস করোনি, সেটা আলাদা করে দাগান: ওগুলো আসল interview এ আপনি জানতে না।

> **Scenario:** একটা বড় শহর, প্রায় ২ কোটি মানুষ। Customer app এ order করে, restaurant accept করে আর রান্না করে, একজন rider (মোটরসাইকেল বা সাইকেল) তুলে নিয়ে পৌঁছে দেয়। কিছু তথ্য:
>
> - **মাপ:** দিনে ~৮ লাখ order। দুপুর ১২-২টা আর রাত ৮-১০টা মিলে দিনের ৬০% order। রমজানে ইফতারের আগের আধা ঘণ্টায় দিনের ~২৫% order। ~১৫,০০০ restaurant। Peak এ ~৩০,০০০ rider online।
> - **Rider:** online থাকা অবস্থায় rider এর app প্রতি ৪ সেকেন্ডে নিজের অবস্থান (GPS) পাঠায়। শহরের অনেক জায়গায় mobile network দুর্বল, rider এর connection প্রায়ই কাটে।
> - **Customer:** checkout এ আনুমানিক পৌঁছানোর সময় (ETA) দেখে। Rider খাবার তোলার পরে map এ rider কে চলতে দেখে। গড় delivery ~৩০ মিনিট।
> - **Payment:** ~৬৫% digital (card আর mobile wallet, একটা PSP দিয়ে, 11.7), ~৩৫% cash on delivery।
> - **সময়ের দাবি:** restaurant ৩ মিনিটের মধ্যে accept করবে, না হলে order বাতিল আর customer কে জানানো। Accept এর ২ মিনিটের মধ্যে একজন rider assign হবে।
> - **এখনকার system:** একটা monolith, একটা Postgres। Rider এর অবস্থান `rider_locations(rider_id PK, lat, lng, updated_at)` table এ, প্রতি ৪ সেকেন্ডে `UPDATE`। Dispatch একটা job, প্রতি ১০ সেকেন্ডে সব pending order এর উপর loop করে, প্রতিটার জন্য SQL এ সব খালি rider এর দূরত্ব (haversine) হিসাব করে `ORDER BY distance LIMIT 1`, তারপর `UPDATE orders SET rider_id = …`। Notification একটা FIFO queue। Customer এর tracking screen প্রতি ৫ সেকেন্ডে rider এর অবস্থান poll করে।
> - **গত রমজানের postmortem এর সারাংশ:** ৫:৪০ এ database এর CPU ১০০%। Dispatch এর একটা পাক ১০ সেকেন্ডের বদলে ১৫ মিনিট নিল; ~২,০০০ order বাতিল, অনেক খাবার ঠান্ডা। কিছু rider একই মুহূর্তে দুটো আলাদা order এর assignment পেল, দুটো restaurant এ দৌড়াল। কিছু restaurant এমন order রান্না করল যার payment তখনও নিশ্চিত হয়নি, আর পরে সেগুলো ব্যর্থ হলো। Customer এর map এ rider "লাফাচ্ছিল" - এক জায়গা থেকে আরেক জায়গায়, মাঝে মাঝে পেছনে।
>
> Product এর লক্ষ্য: (১) ইফতারের ঢেউয়েও accept এর পরে ২ মিনিটে rider; (২) একজন rider কখনো একসাথে দুটো order এর assignment পাবে না (আপাতত); (৩) payment নিশ্চিত না হলে restaurant রান্না শুরু করবে না, কিন্তু customer এর অপেক্ষা যেন অসহ্য না হয়; (৪) customer এর map এ rider মসৃণ চলে; (৫) ETA এর ভুল গড়ে ৫ মিনিটের কম।

এবার ৫০ মিনিট। পুরো নকশা: requirement, estimation (প্রতিটা সংখ্যার পরে "তাই"), high-level, data model আর API, দুটো deep dive, wrap-up। কোনো follow-up নেই। নিজের interviewer নিজে হোন: ধাপ শেষে check-in করুন ("এখন আমি dispatch এর deep dive এ যেতে চাই"), আর failure, trade-off নিজে থেকে তুলুন।

**৫০ মিনিটে থামুন।** Recording বন্ধ। নিচের পর্ব ২ পড়ার আগে recording না শুনে তিনটা লাইন লিখুন: কোন deep dive দুটো বেছেছিলেন আর কেন, কোথায় সবচেয়ে বেশি অনিশ্চিত ছিলেন, আর কোন follow-up আসবে বলে আপনার মনে হয়।

### পর্ব ২ - Follow-up, লিখে, mock এর পরে

নিচের দশটা প্রশ্ন একজন interviewer এর খাতা থেকে। প্রতিটার জন্য দুটো কাজ: (ক) recording এ খুঁজুন এর বিষয়টা আপনি **নিজে থেকে** তুলেছিলেন কিনা - তুললে `mm:ss` লিখুন, আর সেটা একটা শক্ত signal; (খ) না তুলে থাকলে, এখন উত্তর লিখুন, প্রতিটায় ৩-৫ মিনিট, যেন interviewer এখন জিজ্ঞেস করল। প্রতিটা প্রশ্নের পাশে Module 12 এর কোন দক্ষতা পরীক্ষা হচ্ছে, সেটা লেখা।

**১. ইফতারের সংখ্যা (Lesson 12.2 - estimation chain, active window)**
৮ লাখের ২৫% আধা ঘণ্টায়: সেকেন্ডে কতগুলো order? ৩০,০০০ rider × প্রতি ৪ সেকেন্ডে: সেকেন্ডে কতগুলো অবস্থানের লেখা? আর tracking: একসাথে কতজন customer map খোলা রাখে (কোন active order, কত মিনিট), আর প্রতি ৫ সেকেন্ডের poll এ সেকেন্ডে কত read? তিনটা সংখ্যা পাশাপাশি রেখে বলুন: এই system এর সবচেয়ে বড় চাপ কোথায় - order এ, না অবস্থানে? প্রতিটার শেষে একটা "তাই", আর একটা sanity check ("প্রতি rider এ কত?")। ইফতারের সংখ্যা সারাদিনের গড় থেকে কত গুণ? সাধারণ "peak × ৩" এখানে কেন ভুল?

**২. ঘড়ি আর deep dive এর বাছাই (Lesson 12.1 - framework, time box, ভুলের তালিকা)**
প্রতিটা ধাপ আসলে কত মিনিট নিল? যে দুটো deep dive বেছেছিলেন, সেগুলো কি এই system এর সবচেয়ে কঠিন দুটো জায়গা ছিল - postmortem এর চারটা ব্যর্থতার কোনগুলো তারা ঢেকেছে? দশটা ভুলের checklist, `mm:ss` সহ।

**৩. সবচেয়ে কাছের খালি rider (Lesson 12.5 - "না জানা", depth এর সিঁড়ি; 12.3 - data structure থেকে চিন্তা)**
এখনকার dispatch প্রতিটা order এর জন্য সব rider এর দূরত্ব হিসাব করে। ৩০,০০০ rider × ইফতারের order এর হার: সেকেন্ডে কত দূরত্বের হিসাব? এই course এ geospatial index পড়ানো হয়নি - **এটা ইচ্ছা করে।** নাম না জানলে প্রথম নীতি থেকে ভাবুন: শহরটাকে একটা grid এর ঘরে ভাগ করলে, "কাছের rider" খোঁজা কেমন দাঁড়ায়? ঘরের আকার কত, আর ঘরের সীমানায় থাকা order এর কী হয়? অবস্থান বদলালে rider কোন ঘরে, সেটা কোথায় রাখবেন? তারপর লিখুন, interview এ আপনি ঠিক কোন বাক্য দিয়ে শুরু করতে, যখন জানেন না এর একটা প্রচলিত নাম আছে কিনা।

**৪. একজন rider, দুটো order (Lesson 12.6 - optimistic lock, core write path; 5.5)**
গত রমজানে একজন rider একই মুহূর্তে দুটো assignment পেয়েছিল। 12.6 এর ৫০ জনের পরীক্ষার কোন সারির মতো এটা? Rider এর assignment এর জন্য একটা SQL statement লিখুন যা দুটো dispatch একসাথে একই rider কে চাইলেও শুধু একটাকে দেয়, আর অন্যটা কী করে (আরেকজন rider খোঁজে, না অপেক্ষা)। আর dispatch এর কয়েকটা instance একসাথে চললে, একই **order** দুজন rider পায় না কীভাবে?

**৫. Requirement বদল (Lesson 12.4 - খাপ খাওয়ানো)**
Interviewer: "Product এর নতুন সিদ্ধান্ত: একজন rider একসাথে সর্বোচ্চ দুটো order নিতে পারবে, যদি দুটো restaurant কাছাকাছি আর দুটো customer একই দিকে।" আপনার নকশার কোন সিদ্ধান্ত বা অনুমান এতে ভাঙে (নাম ধরে)? প্রশ্ন ৪ এর নিয়মের কী হয়? পুরোটা না ফেলে শুধু কী বদলাবেন? আর এই বদলে dispatch এর প্রশ্নটা কীভাবে আকৃতি বদলায় ("একটা order এর জন্য সবচেয়ে কাছের rider" থেকে কী)?

**৬. Push-back: payment আর রান্না (Lesson 12.4 - push-back; 11.7 - unknown)**
আপনি বলেছেন (বা বলা উচিত ছিল): payment `unknown` থাকা অবস্থায় restaurant রান্না শুরু করবে না। Interviewer: "PSP এর webhook মাঝে মাঝে এক মিনিট দেরি করে। মানে কিছু customer এর খাবার এক মিনিট দেরিতে শুরু। Product বলছে customer রা এটা ঘৃণা করবে। আর যদি রান্না আগে শুরু করেন, ব্যর্থ payment এর খাবার কে খাবে?" একটা বাছুন, দাম মেনে নিন, আর দামটা কমানোর দুটো উপায় বলুন। Cash on delivery এর order এ এই প্রশ্নটা কি আদৌ আছে?

**৭. অবস্থানের পথ (Lesson 12.3 - derived store, সত্যের উৎস; 11.3 - connection; 6.4 - ক্রম)**
সেকেন্ডে হাজার হাজার অবস্থানের `UPDATE` একটা Postgres এ - postmortem এর ৫:৪০ এর CPU এর একটা কারণ। অবস্থান কোথায় রাখবেন? কোনটা সত্যের উৎস, আর অবস্থানের ইতিহাস কি আদৌ রাখতে হবে (কোন কাজে, কতদিন)? Customer এর map এ rider "লাফায়" আর "পেছনে যায়" - এর দুটো সম্ভাব্য কারণ বলুন (একটা network এর, একটা ক্রমের), আর প্রতিটার প্রতিকার। Poll না push (2.4): সংখ্যা দিয়ে।

**৮. Failure mode এর তিনটা সারি (Lesson 12.6 - failure mode table; 10.3)**
12.6 এর টেবিলের ছকে তিনটা সারি: (ক) অবস্থানের service দশ মিনিট বন্ধ, (খ) PSP ধীর, ৩০% request timeout, (গ) একজন rider এর app delivery এর মাঝে দশ মিনিট offline। প্রতিটায়: কীভাবে জানবেন, customer/restaurant/rider কী দেখে, আর নকশা কী করে।

**৯. Scaling trigger আর খরচ (Lesson 12.6 - scaling trigger; 10.7)**
তিনটা scaling trigger লিখুন, প্রতিটা একটা মাপা সংখ্যা আর একটা নির্দিষ্ট বদল সহ। এই system এর খরচের সবচেয়ে বড় লাইন কোনটা হবে বলে আপনার ধারণা (compute, database, অবস্থানের লেখা, map এর API, SMS/push)? আর ইফতারের আধা ঘণ্টার জন্য capacity: autoscale, না আগে থেকে (প্রতি দিন একই সময়ে - এটা কোন ধরনের peak)?

**১০. গল্পটা (Lesson 12.5 - design narrative, retrospective)**
এই নকশার ৩০ সেকেন্ডের রূপ লিখুন, 12.5 এর কাঠামোয়। তারপর: এই নকশার কোন সিদ্ধান্তে আপনি সবচেয়ে কম নিশ্চিত, আর কোন একটা সংখ্যা মাপলে সেই অনিশ্চয়তা সবচেয়ে বেশি কমবে? আর mock এর শুরুতে নেওয়া কোন সিদ্ধান্ত এখন আলাদাভাবে নিতে?

### পর্ব ৩ - Score, আর তিনটা mock পাশাপাশি

12.3 এর rubric ধরে নিজেকে score দিন, প্রতিটা নম্বরের পাশে `mm:ss`। তারপর তিনটা mock পাশাপাশি:

```
মাত্রা                   12.3     12.4     Exit     পার্থক্যের প্রমাণ (mm:ss)
অস্পষ্টতা সামলানো        _        _        _
কাজের নকশা               _        _        _
Technical গভীরতা         _        _        _
বিচার আর trade-off       _        _        _
যোগাযোগ                  _        _        _
পর্ব ২ এ নিজে তোলা follow-up:    _ / ১০
```

শেষ লাইনটা এই challenge এর সবচেয়ে গুরুত্বপূর্ণ সংখ্যা। দশটার মধ্যে কয়টা আপনি কেউ জিজ্ঞেস করার আগে নিজে তুলেছিলেন? 12.1 এর senior এর সংজ্ঞা মনে করুন: interviewer প্রশ্ন করার **আগে** প্রশ্নগুলো তোলা। চার-পাঁচটা হলে ভালো; সাত-আটটা হলে আপনি এমনভাবে interview চালাচ্ছেন যেটা বেশিরভাগ interviewer মনে রাখবে।

**মনে রাখার কথা:** এই challenge এ চারটা জায়গায় সবচেয়ে সহজে ভুল হয়। (ক) **ভুল জায়গায় চাপ খোঁজা।** "Food delivery" শুনে মনে হয় চাপ order এ; সংখ্যা বলে চাপ অবস্থানে (প্রশ্ন ১)। Order এর হার ইফতারেও একটা database এর জন্য সহজ। (খ) **ভুল peak।** ইফতার একটা দৈনিক ঘটনা নিজের ঘড়ি সহ, "গড়ের ৩ গুণ" না (12.2 এর active window আর ঘটনার peak)। আর সেটা আগে থেকে জানা, তাই autoscale এর চেয়ে নির্ধারিত capacity (10.7)। (গ) **না জানা জিনিসে বানানো নাম।** Geospatial index এর প্রচলিত নাম না জানলে, grid এর ঘর দিয়ে প্রথম নীতি থেকে ভাবাটা একটা ভুল নামের চেয়ে অনেক শক্ত signal (12.5)। (ঘ) **বাইরের system এর timeout কে সিদ্ধান্ত ভাবা।** PSP এর timeout মানে "জানি না" (11.7), আর rider এর app এর নীরবতাও "জানি না" - rider হয়তো tunnel এ, হয়তো app crash, হয়তো খাবার নিয়ে পালিয়েছে। প্রতিটার জন্য একটা `unknown` এর অবস্থা আর একটা সময়সীমা।

পর্ব ১ এর recording এর সারাংশ, পর্ব ২ এর দশটা উত্তর (আর কোনগুলো নিজে তুলেছিলেন), আর পর্ব ৩ এর টেবিল পাঠান। আমি প্রতিটা follow-up ধরে critique করব, আর তিনটা mock এর পার্থক্য প্রমাণের সাথে মেলাব।

---

## ২. Self-Check - এই Module শেষে আপনি এগুলো পারার কথা

**Module 12:**

- [ ] একটা ৪৫ বা ৬০ মিনিটের interview ঘড়ি ধরে চালাতে পারি: time box board এ, প্রতি ধাপের শেষে check-in, আর deep dive এ সময়ের সবচেয়ে বড় ভাগ
- [ ] Interviewer এর rubric এর পাঁচটা মাত্রা জানি, আর আমার প্রতিটা কথা কোন signal দেয় সেটা বুঝি; দশটা common ভুল নিজের recording এ চিনতে পারি
- [ ] যেকোনো estimation দুই মিনিটে একটা chain হিসেবে করতে পারি, প্রতিটা ধাপে unit সহ; গোল করা নিরাপদ জানি, ভুল ধাপ ধরতে sanity check করি, আর প্রতিটা সংখ্যার শেষে একটা "তাই" বলি
- [ ] Requirement মাঝপথে বদলালে বলতে পারি ঠিক কোন সিদ্ধান্ত ভাঙল, আর শুধু সেটা বদলাই; push-back এ একটা বিকল্প বেছে দাম মেনে নিই আর কমাই
- [ ] নিজের একটা system এর গল্প তিন দৈর্ঘ্যে বলতে পারি, সংখ্যা, বিকল্প, আর একটা সৎ ভুল সহ; depth এর সিঁড়িতে তলায় পৌঁছালে বানাই না
- [ ] একটা পুরো design doc লিখতে পারি: non-goal, estimation, schema, trigger দিয়ে scaling plan, failure mode এর টেবিল, খরচ, বাতিল বিকল্প, খোলা প্রশ্ন
- [ ] একটা core write path এর তিনটা বিপদ (lost update, retry এর duplicate, dual write) code এ সমাধান করে মেপে দেখাতে পারি

**পুরো course, এক লাইনে প্রতিটা module:**

- [ ] **১ - Framework:** যেকোনো প্রশ্নে পাঁচ ধাপ; latency, throughput, availability আর SLO/error budget এর সংখ্যা; stateless বনাম stateful
- [ ] **২ - Networking:** DNS থেকে response পর্যন্ত পথ; TCP/TLS এর দাম; REST/GraphQL/gRPC আর WebSocket/SSE/polling এর trade-off; idempotency key আর cursor pagination
- [ ] **৩ - Load balancing:** L4 বনাম L7, algorithm, health check আর graceful shutdown
- [ ] **৪ - Caching:** কোন স্তরে, কোন strategy, invalidation আর TTL, আর stampede, hot key এর মতো ব্যর্থতা
- [ ] **৫ - Database:** schema, storage engine, index, isolation আর anomaly, pooling আর N+1, replication, sharding, CAP আর quorum
- [ ] **৬ - Distributed systems:** failure model আর split brain, consensus, read-your-writes, logical clock, consistency model
- [ ] **৭ - Async:** কেন async, queue বনাম pub/sub, retry/backoff/DLQ/backpressure, outbox, batch বনাম stream
- [ ] **৮ - Storage:** object storage, presigned/multipart upload, inverted index
- [ ] **৯ - Service architecture:** কখন ভাঙবেন আর কখন না, gateway আর BFF, saga, breaker আর bulkhead, rate limiting
- [ ] **১০ - Reliability আর operations:** consistent hashing, probabilistic structure, graceful degradation, observability, security, deployment, খরচ, multi-region
- [ ] **১১ - Case study:** সাতটা system শূন্য থেকে, প্রতিটায় আগে সংখ্যা তারপর যন্ত্র

কোনো লাইনে টিক দিতে না পারলে, সেই module এর exit challenge টা আবার করুন, lesson আবার পড়ার আগে। পড়া চেনা লাগে; challenge দেখায় আসলে কতটা পারেন।

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Martin Kleppmann - _Designing Data-Intensive Applications_।** এই course এর প্রায় প্রতিটা module এর পটভূমি। Course শেষে আবার পুরোটা পড়ুন: প্রথমবার যা বিমূর্ত লেগেছিল (replication, consistency, stream), এখন প্রতিটা অধ্যায়ের পাশে আপনার নিজের একটা exercise এর সংখ্যা আছে।
- **Alex Xu - _System Design Interview_ (খণ্ড ১ আর ২)।** Interview এর প্রশ্নের ব্যাপ্তি দেখার জন্য: এখানে যা করোনি এমন প্রশ্ন (web crawler, key-value store, proximity service, Google Maps), প্রতিটা একটা নতুন mock এর কাঁচামাল। খণ্ড ২ এর "proximity service" অধ্যায় পর্ব ২ এর প্রশ্ন ৩ এর একটা উত্তর - **পর্ব ২ শেষ করার পরে** পড়ুন।
- **Roberto Vitillo - _Understanding Distributed Systems_।** ছোট, আর Module 5-10 এর একটা পরিষ্কার পুনরাবৃত্তি। Interview এর আগের সপ্তাহে দ্রুত চোখ বুলানোর জন্য ভালো।
- **Google - _Site Reliability Engineering_ আর _The Site Reliability Workbook_।** দুটোই অনলাইনে বিনামূল্যে প্রকাশিত। Module 10 এর SLO, error budget, alert, incident আর postmortem এর মূল উৎস; 12.6 এর failure mode এর টেবিলের ভাবনার পরের ধাপ।
- **Alex Petrov - _Database Internals_।** Module 5.3 আর 6.2 এর গভীরে যেতে চাইলে: B-tree আর LSM এর ভেতর, আর consensus এর algorithm গুলো।

**দেখার জন্য:**

- **Martin Kleppmann এর Cambridge এর distributed systems এর lecture series** (YouTube এ, আট পর্ব)। Module 6 এর logical clock, quorum আর consensus এর সবচেয়ে পরিষ্কার ব্যাখ্যাগুলোর একটা।
- **MIT এর distributed systems course (6.5840, আগে 6.824) এর lecture আর lab।** Raft এর lab টা নিজে করলে 6.2 এর exercise এর পরের ধাপ। কঠিন, সময় লাগে, কিন্তু interview এ "consensus বুঝি" কথাটা তখন আর মুখস্থ না।
- **বড় কোম্পানির engineering blog:** Uber এর H3 (hexagonal grid এর geospatial index) নিয়ে প্রকাশিত লেখা, আর food delivery কোম্পানিগুলোর dispatch নিয়ে লেখা। দুটোই পর্ব ২ এর প্রশ্ন ৩ আর ৫ এর আসল রূপ - **নিজের উত্তর লেখার পরে** পড়ুন। কোম্পানির নিজের লেখা, তাই তাদের দৃষ্টিভঙ্গি থেকে।

**Project এর জন্য:**

- **Capstone এর পরের ধাপ:** 12.6 এর exercise এ fractional position, client এর retry, আর outbox এর পরিষ্কার যোগ করুন (12.6 এর experiment), তারপর একটা web BFF আর একটা ছোট SvelteKit board, যাতে 409 এর UI টা আসল হয়। এটা আপনার story bank এর একটা সম্পূর্ণ, দেখানো যায় এমন project।
- **এই challenge এর dispatch:** একটা TypeScript simulation: শহর একটা grid, ৩০,০০০ rider random walk এ, ইফতারের order এর ঢেউ। তিনটা dispatch তুলনা করুন (সবার দূরত্ব, grid এর ঘর, ঘর আর পাশের ঘর), আর মাপুন: dispatch এর সময়, rider এর খালি বসে থাকা, customer এর অপেক্ষা। এই course এর exercise গুলোর মতো deterministic, seeded। পর্ব ২ এর প্রশ্ন ১ আর ৩ এর উত্তর মাপা সংখ্যায়।
- **একটা আসল ছোট production:** নিজের বা বন্ধুর একটা ছোট app, আসল user সহ, যত ছোটই হোক। Observability (10.4), একটা SLO, একটা deploy এর পথ (10.6), আর প্রথম incident এর একটা লেখা postmortem। 12.5 এর "learning project" এর গল্প থেকে "production project" এর গল্পে যাওয়ার সবচেয়ে ছোট পথ।

**Interview এর আগের সপ্তাহে:**

```
দিন ১   Story bank (12.5): দুটো গল্পের ৫ মিনিটের রূপ আবার recording, depth এর সিঁড়ি আবার পড়া
দিন ২   Estimation (12.2): `npm run drill` দুবার, তারপর নিজের বানানো পাঁচটা drill
দিন ৩   একটা নতুন mock, ৪৫ মিনিট, recording সহ; score আর ভুলের log
দিন ৪   Progress ledger এর weak spot গুলো: প্রতিটার জন্য একটা পুরনো exercise আবার চালানো আর জোরে ব্যাখ্যা
দিন ৫   বন্ধুর সাথে একটা ৬০ মিনিটের mock, এলোমেলো "কেন?" আর push-back সহ
দিন ৬   যে কোম্পানিতে interview: তাদের product কী, কোন system তাদের কাছে কঠিন হতে পারে, তাদের engineering
        blog; interviewer কে জিজ্ঞেস করার তিনটা প্রশ্ন
দিন ৭   বিশ্রাম। 12.1 এর বাক্যের টেবিল একবার পড়া, আগে ঘুমানো। নতুন কিছু শেখা না।
```

শেষ দিনটা গুরুত্বপূর্ণ। Interview এর আগের রাতে নতুন একটা distributed system এর paper পড়ে যতটা লাভ হয়, ঘুম কম হওয়ায় তার চেয়ে বেশি ক্ষতি হয়: চাপের মধ্যে সংখ্যা মাথায় রাখা আর জোরে ভাবা দুটোই ক্লান্ত মস্তিষ্কে প্রথমে যায়।

---

Exit challenge টা করে পাঠান। আর এটা course এর শেষ challenge: এর পরে কোনো `next` নেই।

শুরুতে লক্ষ্য ছিল দুটো, সমান জরুরি: interview এ ভালো করা, আর আসলেই বোঝা, যাতে চাকরি পাওয়ার পরে কাজে লাগে। প্রথমটার জন্য Module 12, আর এর প্রতিটা অভ্যাস (সংখ্যা থেকে "তাই", ঘড়ি, নিজে থেকে failure তোলা, সৎ থাকা) আসলে দ্বিতীয়টার কাছ থেকে ধার করা। এগারো module এ TaskFlow একটা Express server থেকে একটা পুরো platform হয়েছে, আর প্রতিটা ধাপে একটা জিনিস বারবার ফিরে এসেছে: আগে সমস্যা, তারপর সংখ্যা, তারপর যন্ত্র, আর প্রতিটা যন্ত্রের পাশে তার দাম। Interview এর ঘর থেকে বের হয়ে প্রথম design review তে, প্রথম incident এ, প্রথম "এটা কি scale করবে?" এর প্রশ্নে এই একই ক্রম কাজ করে।

কোনো module এ ফিরে যেতে চাইলে, বা course এর বাইরের কোনো system নিয়ে কাজ করতে চাইলে, `design X`, `interview me`, `critique` বা `war story` লিখুন - commands গুলো course শেষ হলেও চলে।
