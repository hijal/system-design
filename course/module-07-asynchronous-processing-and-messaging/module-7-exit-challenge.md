# Module 7 - Exit Challenge (Asynchronous Processing & Messaging)

**Module 7 - Asynchronous Processing & Messaging**

Module 7 এর ৬টা lesson শেষ - কেন synchronous কাজ system কে টেনে নামায়, queue বনাম pub/sub বনাম log, BullMQ এর job আর তার জীবন, idempotency আর retry আর DLQ আর backpressure, event আর outbox, আর শেষে batch বনাম stream আর OLTP বনাম OLAP। প্রতিটা lesson এ একটা করে প্রশ্ন আলাদা করে মেপেছি। বাস্তবে একটা খারাপ মাসে সব একসাথে আসে - আর প্রায়ই একটা ভুল আরেকটাকে ঢেকে রাখে। এই Exit Challenge এমন একটা মাস।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow এর গত মাসটা খারাপ গেছে। Incident review এর জন্য আপনাকে পুরো মাসের ঘটনা দেওয়া হলো। এই মুহূর্তে TaskFlow এর async অংশের অবস্থা (কিছু সিদ্ধান্ত এই module এর lesson মেনে, কিছু না):
>
> - **Webhook:** enterprise customer দের জন্য `task.completed` এর webhook - এক engineer "যাতে customer সাথে সাথে পায়" বলে task complete এর **HTTP route এর ভেতরেই** পাঠায়, `await`, timeout ১০ সেকেন্ড, database transaction শেষ হওয়ার আগে।
> - **BullMQ:** একটাই queue, `notifications` - mention email, password reset, daily digest, আর মাস শেষের **invoice PDF** (PDF বানানো ~৪০ সেকেন্ড, synchronous library)। একটা worker process, `concurrency: 50`, `lockDuration` default (৩০ s)। Retry: সব error এ `attempts: 10`, `backoff: { type: 'fixed', delay: 2000 }`। Job ID default (BullMQ এর বাড়তে থাকা সংখ্যা)।
> - **CSV import:** একজন customer ১ লাখ task import করলে প্রতিটা task এর জন্য একটা "assigned" email job - সেই `notifications` queue তেই।
> - **Events:** সব write route outbox এ লেখে (7.5 এর মতো)। Relay: high availability এর জন্য **দুটো** relay, দুটোই `SELECT … WHERE id > :last ORDER BY id LIMIT 100` দিয়ে পড়ে, `last` রাখে Redis এ। Consumer: notification, search, analytics, Slack - Redis Streams এর consumer group।
> - **Notification consumer এর dedupe:** Redis Stream এর entry ID (`1735689600000-0` এর মতো) একটা `processed` set এ রাখে; আগে থাকলে বাদ।
> - **Analytics:** finance এর Metabase dashboard সরাসরি **primary** Postgres এ। Product এর live "প্রতি ঘণ্টায় completed task" dashboard stream এ, **processing time** এ গোনে।
>
> **মাসের ঘটনাগুলো:**
>
> 1. **৩ তারিখ:** একজন enterprise customer এর webhook server ধীর (প্রতিটা call ~৮ সেকেন্ড)। সেই সকালে শুধু সেই customer এর না - **সব** customer এর task complete করা ধীর, আর board খোলা, login এ `503`। Database এর CPU ১০%।
> 2. **১ তারিখ (মাস শেষের invoice):** ৩৭ জন customer দুটো করে invoice email পেয়েছে, আর ১২টা invoice job `failed` - কারণ `job stalled more than allowable limit`। একই সময়ে mention email গুলো মিনিট খানেক করে দেরিতে।
> 3. **১১ তারিখ:** একজন customer ১ লাখ task import করল। পরের ৪৫ মিনিট কেউ password reset email পায়নি; support এ ticket এর বন্যা।
> 4. **প্রতিদিন সকাল ৯টা:** digest এর সময় provider `429`, আর ১৫ তারিখে provider TaskFlow এর account ২০ মিনিটের জন্য আটকে দিল।
> 5. **Search team এর রিপোর্ট:** মোটামুটি ০.৩% comment কখনো search এ আসে না। Database এ comment আছে, outbox এ তার row আছে, `published` চিহ্ন নেই কিন্তু relay এর `last` অনেক আগেই তার id পেরিয়ে গেছে।
> 6. **২০ তারিখ, একটা relay deploy এর পরে:** কয়েকশো user একই mention email দুবার পেল - অথচ notification consumer এর dedupe আছে, আর log এ দেখা যাচ্ছে dedupe ঠিকমতো চলছে।
> 7. **২৪ তারিখ:** event pipeline ৪০ মিনিট আটকে ছিল। Live dashboard এ সেই সময়টা প্রায় শূন্য, তারপর একটা লাফ। Billing team জিজ্ঞেস করল এই dashboard এর সংখ্যা দিয়ে কি এই মাসের usage এর আন্দাজ দেওয়া যায়।
> 8. **প্রতি সোমবার সকাল ১০টা:** finance এর Metabase খোলার সাথে সাথে board এর p99 দশ গুণ।
> 9. **নতুন architect এর প্রস্তাব:** "সব কিছু Kafka তে নিন - BullMQ, Redis Streams সব বাদ। Kafka তে exactly-once semantics আছে, তাই duplicate এর সমস্যা একেবারে শেষ, আর retry এর ঝামেলাও থাকবে না।"

আপনার কাজ - নিচের প্রতিটা প্রশ্নে Module 7 (আর প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নিন, reasoning সহ। যেখানে সম্ভব, **সংখ্যা** দিয়ে বলুন।

**১. ধীর webhook, আর সবার `503` (Lesson 7.1)**
একজন customer এর ধীর server কীভাবে সবার login ফেলে দিল - critical path, ভাগ করা resource (কোনটা?), আর Little's Law দিয়ে একটা সংখ্যা (ধরুন প্রতি সেকেন্ডে ১০টা task complete, pool এ ১০টা connection, আর transaction এর ভেতরে ৮ সেকেন্ড)। "Timeout ১০ থেকে ২ সেকেন্ড করুন" - কেন যথেষ্ট না? আপনার সমাধান: webhook কোথায় যাবে, কোন queue, আর একজন customer এর মরা server যাতে অন্য customer দের webhook আটকে না রাখে তার জন্য কী?

**২. দুটো invoice আর stalled job (Lesson 7.3 + 6.1)**
৪০ সেকেন্ডের synchronous PDF আর ৩০ সেকেন্ডের lock - সময়ের রেখায় আঁকুন কী হলো। কেন শুধু invoice না, **একই worker এর বাকি ৪৯টা চলমান job** ও প্রভাবিত হলো, আর mention email কেন দেরিতে? `maxStalledCount` এর কারণে ১২টা `failed` কেন? তিনটা পরিবর্তন দিন - worker/processor এর গঠনে, queue এর ভাগে, আর invoice email এর idempotency তে (কোন key, কোথায়)।

**৩. ১ লাখ import আর ৪৫ মিনিটের password reset (Lesson 7.4 + 7.1)**
Backlog এর হিসাব করুন: ১ লাখ job, `concurrency: 50`, প্রতিটা email ~২০০ ms - queue খালি হতে কত সময়, আর তার মধ্যে একটা password reset কোথায় দাঁড়ায়? আপনার হিসাব ৪৫ মিনিটের সাথে মেলে না - মাসের আর কোন ঘটনা এই দেরিকে আরও লম্বা করতে পারে? এটা কোন সমস্যা (burst নাকি sustained)? অন্তত তিনটা সমাধান - একটা queue এর গঠনে, একটা import এর নিজের design এ (১ লাখ আলাদা email কি সত্যিই দরকার?), আর একটা backpressure/অগ্রাধিকার।

**৪. সকাল ৯টার `429` (Lesson 7.4)**
"সব error এ ১০ বার, স্থির ২ সেকেন্ড" - এই নীতির তিনটা আলাদা ভুল খুঁজে বের করুন (কোন error, কীভাবে অপেক্ষা, কোথায় সীমা)। Retry storm টা ঘটার ক্রম লিখুন। Provider কে আর কখনো ৩০০ এর বেশি না পাঠাতে (ধরুন তার সীমা ১০০/s) কী কী বসাবেন - BullMQ এর কোন option, cron এর কোন বদল, আর `429` এর কোন header?

**৫. ০.৩% comment কখনো search এ আসে না (Lesson 7.5)**
Relay এর `id > :last` এর সাথে দুটো relay - ঠিক কোন সময়ের রেখায় একটা outbox row চিরকালের জন্য বাদ পড়ে? (id বরাদ্দ বনাম commit এর ক্রম।) দুটো relay এর মধ্যে `last` ভাগ হলে আর কী কী ভুল হয় (দুবার পাঠানো, ক্রম)? ঠিক করা relay কেমন হবে? আর যে ০.৩% ইতিমধ্যে বাদ পড়েছে, সেগুলো এখন কীভাবে উদ্ধার করবেন - নিরাপদে, duplicate এর ভয় ছাড়া?

**৬. dedupe থাকা সত্ত্বেও duplicate (Lesson 7.4 + 7.5)**
Relay deploy এর মুহূর্তে কী হয়েছিল (relay কোন ধাপে মরলে একই event আবার যায়)? Stream entry ID দিয়ে dedupe কেন সেটা ধরতে পারল না? কোন key দিয়ে dedupe করা উচিত ছিল - event এর `eventId`, নাকি effect এর পরিচয় (`mention:{commentId}:{userId}`)? দুটোর পার্থক্য কোন পরিস্থিতিতে গুরুত্বপূর্ণ হয়? আর `processed` set টা কোথায় থাকা উচিত, email পাঠানোর তুলনায় কোন ক্রমে লেখা হবে (7.4 এর ছয়টা কৌশলের কোনটা)?

**৭. ৪০ মিনিটের গর্ত আর billing এর প্রশ্ন (Lesson 7.6)**
Dashboard এর গর্ত আর লাফ - কারণ এক বাক্যে। Event time এ গুনলে কী বদলাত - আর watermark এর lateness কত হলে এই ৪০ মিনিটের backlog ধরা পড়ত (আর তার দাম)? Billing এর প্রশ্নের উত্তর দিন: এই সংখ্যা দিয়ে usage এর আন্দাজ কি চলে? না চললে usage কোথা থেকে, কীভাবে, কখন হিসাব হবে?

**৮. সোমবার সকাল ১০টা (Lesson 7.6 + 5.7)**
Finance এর Metabase কে কোথায় সরাবেন - replica, রাতের export + DuckDB/Parquet, নাকি CDC → column store? প্রতিটার data কতটা পুরনো, production এর উপর কী প্রভাব, আর কী নতুন চালাতে হবে। TaskFlow এর আকারে কোনটা, আর finance কে কী বলবেন যে তাদের সংখ্যা এখন "গতকাল পর্যন্ত"?

**৯. "সব কিছু Kafka তে" (Lesson 7.2 + 7.4 + 7.3)**
প্রস্তাবটার কোন অংশ ঠিক, কোন অংশ ভুল? (ক) Kafka এর "exactly-once semantics" আসলে কোন পরিধিতে কাজ করে - আর TaskFlow এর mention email (বাইরের provider) এর duplicate কি এতে যায়? (খ) BullMQ এর কাজগুলো (per-job retry, delay, DLQ, আলাদা অগ্রাধিকার) Kafka এর log এ বসালে কী হয় - head-of-line blocking, poison message। (গ) TaskFlow এর আকার (দিনে কয়েক লাখ event) আর team এর আকার ধরে এক প্যারাগ্রাফে আপনার সুপারিশ - কী Kafka তে যাবে (যদি কিছু), কী থাকবে, আর কোন সংখ্যা দেখলে সিদ্ধান্ত বদলাবে।

**১০. Design doc আর অগ্রাধিকার (Lesson 7.1–7.6)**
(ক) TaskFlow এর async architecture এর এক পাতার design doc: প্রতিটা message এর তালিকা (অন্তত আটটা) - "কাজ" নাকি "খবর", কোন তারে যায় (BullMQ এর কোন queue, নাকি stream), key, retry নীতি, idempotency এর কৌশল, DLQ এ কে দেখে, আর overload এ shed হয় কিনা।
(খ) একটা **অগ্রাধিকার তালিকা**: এই সপ্তাহে কী (আবার ঘটার আগে), এই মাসে কী, এই quarter এ কী - প্রতিটার পাশে কোন lesson, আর সাফল্য কীভাবে মাপবেন (কোন metric, কোন সংখ্যা)।

**মনে রাখার কথা:** এই module এর তিনটা জায়গায় সবচেয়ে সহজে ভুল হয় - (ক) **async মানেই নিরাপদ ভাবা** - কাজ queue তে সরালেই হলো না; ভাগ করা queue, ভাগ করা worker, একটা event loop - cascading failure নতুন জায়গায় ফিরে আসে; (খ) **"ঠিক একবার" বিশ্বাস করা** - broker, library বা tool এর নামে; সব at-least-once, আর ঠিক একবার আসে শুধু idempotent effect থেকে; (গ) **দুটো system এ একসাথে লেখা** - database আর broker, broker আর cursor, email আর "পাঠিয়েছি" - প্রতিটা ফাঁক কোনো না কোনো দিকে ভুল করবে। আজকের scenario তে তিনটাই আছে, কয়েকবার করে। আর Module 7 এর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস: প্রতিটা async flow এর জন্য জিজ্ঞেস করুন - **"এই ধাপের ঠিক পরে process মরলে কী হারায়, আর কী দুবার হয়?"** উত্তর "জানি না" হলে, সেটাই পরের কাজ।

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check - এই Module শেষে আপনি এগুলো পারার কথা

- [ ] System design এর "synchronous" (উত্তর কাজ শেষের অপেক্ষা করে) আর JavaScript এর `await` এর পার্থক্য বলতে পারি; একটা request এর critical path এঁকে latency (যোগ) আর availability (গুণ) হিসাব করতে পারি
- [ ] একটা ধীর dependency কীভাবে ভাগ করা resource (pool, worker, queue) দিয়ে cascading failure ঘটায় - Little's Law দিয়ে সংখ্যা সহ দেখাতে পারি
- [ ] কোন কাজ request এর পথে থাকবে আর কোনটা বাইরে যাবে - চারটা প্রশ্ন দিয়ে ঠিক করতে পারি; fire-and-forget, in-memory queue আর টেকসই queue এর পার্থক্য জানি; queue capacity বানায় না - জানি
- [ ] যেকোনো messaging system কে তিনটা প্রশ্নে চিনি (কে পায়, থাকে কিনা, কোন ক্রমে); queue, pub/sub আর log এর উত্তর আলাদা করে বলতে পারি; RabbitMQ, Kafka, Redis Pub/Sub আর Redis Streams এর মধ্যে message ধরে বাছতে পারি
- [ ] Consumer group, partition key আর ক্রম; hot partition; head-of-line blocking - whiteboard এ আঁকতে পারি
- [ ] BullMQ এর job এর জীবন (waiting, delayed, prioritized, active, completed, failed, stalled) আঁকতে পারি; API, worker আর Redis - কে মরলে কী হয় বলতে পারি; queue এর Redis কেন `noeviction` + AOF আর cache থেকে আলাদা
- [ ] Job lock একটা lease - event loop আটকালে কী হয় (6.1 এর pause), আর তার তিনটা প্রতিকার; graceful shutdown আর grace period
- [ ] Idempotent consumer: ছয়টা কৌশলের প্রতিটা কোন crash point বা race এ ভাঙে বলতে পারি; dedupe key কেন effect এর পরিচয় থেকে; কোথায় ফাঁক বন্ধ হয় (provider এর key, একই transaction)
- [ ] Retry: transient বনাম permanent, এক layer এ, সময়ে সীমা; exponential backoff আর jitter এর পার্থক্য - retry storm কোথা থেকে আসে, সংখ্যা সহ
- [ ] Poison message, DLQ আর redrive এর নিয়ম; backpressure বনাম load shedding; queue burst শোষে, sustained overload সারায় না - সীমা = অপেক্ষা × গতি
- [ ] Event বনাম command; choreography এর লাভ আর দাম (অদৃশ্য flow, চেইন); event এ কতটা data (notification, state transfer, sourcing)
- [ ] Dual write কেন কোনো ক্রমে সারে না; transactional outbox বানাতে পারি (`SKIP LOCKED`, flag না cursor, ছোট batch, পরিষ্কার); polling বনাম CDC; event এর চুক্তি (eventId, occurredAt, version, additive বদল)
- [ ] OLTP বনাম OLAP; কেন analytics production এ না; row store বনাম column store কেন এত আলাদা
- [ ] Batch বনাম stream কীভাবে বাছব; event time বনাম processing time; window, watermark, late data এর তিনটা নীতি - আর কোন ভুল কখনো ঠিক হয় না

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Martin Kleppmann - _Designing Data-Intensive Applications_।** এবার শেষ তিনটা অংশ: প্রথম edition এর chapter 11 ("Stream Processing" - 7.2 এর log, 7.5 এর CDC আর event sourcing, 7.6 এর event time আর window - সব এক জায়গায়), chapter 10 ("Batch Processing"), আর chapter 3 এর "Column-Oriented Storage" অংশ (7.6)। নতুন edition এ chapter এর নম্বর বদলে থাকতে পারে - নাম দিয়ে খুঁজুন।
- **Jay Kreps - "The Log: What every software engineer should know about real-time data's unifying abstraction" (2013)।** Kafka এর স্রষ্টাদের একজনের লেখা; 7.2 এর log কেন একটা মৌলিক ধারণা - database এর WAL থেকে stream processing পর্যন্ত। লম্বা, কিন্তু module এর পুরো গল্পটা এক জায়গায়।
- **Gregor Hohpe আর Bobby Woolf - _Enterprise Integration Patterns_।** পুরনো (2003), কিন্তু messaging এর নামগুলো এখান থেকেই: competing consumers, dead letter channel, idempotent receiver, message router। এর website এ pattern গুলোর ছোট বর্ণনা আছে - reference হিসেবে রাখার মতো।
- **AWS Builders' Library - "Timeouts, retries, and backoff with jitter" আর "Avoiding insurmountable queue backlogs"।** 7.4 এর retry storm আর 7.1/7.4 এর backlog - বড় আকারে চালানোর অভিজ্ঞতা থেকে লেখা। Marc Brooker এর "Exponential Backoff And Jitter" (AWS Architecture Blog) ও।
- **Martin Fowler - "What do you mean by 'Event-Driven'?" (2017)** আর **Chris Richardson এর microservices.io এর "Transactional outbox" pattern।** 7.5 এর দুটো উৎস, ছোট আর পরিষ্কার।
- **Tyler Akidau - "Streaming 101" আর "Streaming 102" (O'Reilly এর লেখা), আর বই _Streaming Systems_।** Event time, processing time, watermark, window - 7.6 এর ধারণাগুলো যিনি জনপ্রিয় করেছেন, তাঁর নিজের ব্যাখ্যা।

**দেখার জন্য:**

- **Martin Kleppmann - "Turning the database inside-out" (conference talk)।** Database এর ভেতরের replication log কে বাইরে এনে event stream বানালে architecture কেমন হয় - 7.5 এর CDC এর দার্শনিক দিক।
- **BullMQ এর documentation এর "Guide" অংশ** - 7.3 আর 7.4 এর প্রতিটা option (retry, backoff, rate limit, sandboxed processor, stalled job) এর নিজস্ব ব্যাখ্যা আর উদাহরণ। Version অনুযায়ী পড়ুন - option গুলো বদলায়।

**Project এর জন্য:**

- **TaskFlow এর notification pipeline, শুরু থেকে শেষ:** Express route → outbox (একই transaction) → relay (`SKIP LOCKED`) → Redis Stream → notification consumer (eventId দিয়ে idempotent, `sent_notifications` এ দাবি + অবস্থা) → BullMQ job (effect এর key থেকে job ID, exponential + jitter, permanent এ DLQ) → নকল provider (idempotency key সমর্থন সহ)। তারপর **chaos test**: একটা script যেটা যেকোনো process কে এলোমেলো মুহূর্তে `SIGKILL` করে, আর শেষে মেলায় - প্রতিটা comment এর mention email ঠিক একবার গেছে কিনা। 7.3–7.5 এর সব exercise এক জায়গায়।
- **নিজের ছোট stream processor:** Redis Stream এর `task.completed` পড়ে event time এর ঘণ্টার window এ গোনা, watermark আর lateness সহ, ফল একটা Postgres table এ upsert (সংশোধন সহ)। তারপর 7.6 এর exercise এর মতো একটা outage বানান (consumer থামিয়ে) - graph এ গর্ত আসে কি?
- **রাতের analytics export:** replica থেকে আগের দিনের `task_events` Parquet file এ (দিন ধরে folder), আর DuckDB দিয়ে finance এর মাসিক report। Job ব্যর্থ হলে কে জানবে - একটা ছোট alert সহ।

---

Exit challenge টা করে পাঠান। রেডি হলে `next` লিখলে আমরা **Module 8: Storage Systems** এ যাব - Lesson 8.1 দিয়ে শুরু: Object / Blob storage (S3-style) কীভাবে কাজ করে, কখন লাগে।

Module 7 জুড়ে data মানে ছিল ছোট ছোট জিনিস - একটা row, একটা message, একটা event, কয়েকশো byte। TaskFlow এর user রা কিন্তু file ও দেয়: task এর attachment, screenshot, design এর PDF, মাঝে মাঝে কয়েক GB এর video। এগুলো database এ রাখা যায় না (কেন, সেটাই প্রথম প্রশ্ন), queue তে পাঠানো যায় না - তাহলে কোথায়? আর ১ GB এর একটা file upload মাঝপথে network কাটলে কী হয়? Module 8 এ সেই উত্তর - আর এই module এর অনেক কিছু (async processing, idempotency, event) সেখানে নতুন করে কাজে লাগবে: একটা file upload হলে thumbnail বানানো, virus scan, search index - সবই event আর background job।
