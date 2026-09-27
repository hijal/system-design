# Lesson 7.2 — Message Queue vs Pub/Sub: RabbitMQ, Kafka, Redis Streams

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.8):** TaskFlow এর `tasks` table কে `projectId` দিয়ে shard করা হলো। একটা বিশাল enterprise customer এর একটা project এ সব task এর ৪০%। কী সমস্যা হবে, আর এর নাম কী? আজ ঠিক এই সমস্যা আবার দেখবে — database এ না, message এর লাইনে।

**Prerequisite:** Lesson 5.8 (Partition, shard key, hot partition), Lesson 6.1 (Timeout মানে "জানি না"), Lesson 6.3 (Session guarantee), Lesson 7.1 (Job queue, backlog, in-memory queue এর দুর্বলতা)

**তুমি এই lesson শেষে পারবে:**

1. তিনটা প্রশ্ন দিয়ে যেকোনো messaging system কে চিনতে পারবে — **একটা message কে পায়**, **পড়ার পরে সেটা থাকে কিনা**, আর **কোন ক্রমে আসে** — আর queue, pub/sub, log এর উত্তর আলাদা করে বলতে পারবে
2. Ack আর offset কীভাবে "হারানো" আর "দুবার" এর মধ্যে একটা বাছাই, সেটা সংখ্যা দিয়ে ব্যাখ্যা করতে পারবে — আর কেন বাস্তবে প্রায় সব system "অন্তত একবার" দেয়
3. RabbitMQ, Kafka, Redis Pub/Sub আর Redis Streams এর মধ্যে TaskFlow এর প্রতিটা message এর জন্য একটা বেছে নিতে পারবে — partition key আর retention সহ — আর বলতে পারবে কোনটা কেন **না**

**Tier:** 1 — Runnable Code (তিন ধরনের broker এর নিয়মের একটা deterministic simulation, পাঁচটা পরিস্থিতি)

---

## ০. TaskFlow এখন কোথায়

Lesson 7.1 এ TaskFlow এর assign email request এর পথ থেকে সরেছে — একটা in-memory queue আর ৮টা worker এ। আর সেখানে আমরা দেখেছি এর দাম: deploy এ ১০৩টা email হারাল। Queue টা process এর বাইরে, টেকসই কোথাও নিতে হবে।

কিন্তু এর মধ্যে চাহিদা বেড়েছে। একটা comment তৈরি হলে এখন চারজনের কাছে খবর যাওয়ার কথা:

- **notification** — mention করা মানুষদের email আর push
- **search** — comment টা search index এ তোলা (Lesson 8.3 এ বিস্তারিত)
- **analytics** — "কোন project এ কত আলোচনা হচ্ছে" এর dashboard
- **Slack integration** — task এর channel এ একটা লাইন

Team meeting এ তিনটা প্রস্তাব এলো, তিনজনের কাছ থেকে:

- Backend lead: _"Redis তো আছেই। Redis Pub/Sub — `PUBLISH comment.created`, যার দরকার সে subscribe করুক। নতুন কোনো infrastructure লাগবে না।"_
- Data engineer: _"Kafka। বড় কোম্পানি সবাই Kafka ব্যবহার করে, আর পরে analytics এর জন্য এটাই লাগবে।"_
- আরেকজন: _"RabbitMQ। Queue মানেই RabbitMQ, আমার আগের চাকরিতে ছিল।"_

Redis Pub/Sub সবচেয়ে সহজ ছিল, তাই এক সপ্তাহের জন্য সেটা দিয়ে prototype বানানো হলো। সপ্তাহ শেষে তিনটা খবর:

1. **মঙ্গলবার:** search service এর একটা deploy, ১০ সেকেন্ড বন্ধ। সেই ১০ সেকেন্ডে লেখা comment গুলো আর কখনো search এ আসেনি। কেউ error ও দেখেনি।
2. **বৃহস্পতিবার:** analytics এর একটা ধীর query এর পরে Redis এর log এ: `Client … scheduled to be closed ASAP for overcoming of output buffer limits` — Redis নিজেই analytics কে কেটে দিয়েছে। Dashboard এ কয়েক মিনিটের গর্ত।
3. **আর পরের মাসের plan:** search team index এর format বদলাবে — নতুন index টা বানাতে **এ পর্যন্ত লেখা সব comment** আবার লাগবে।

CTO চাইলেন এক পাতার একটা তুলনা: "কোনটা কেন।" তিনটা tool এর নাম মুখস্থ করে এই পাতা লেখা যায় না — কারণ তিনজন তিনটা **আলাদা প্রশ্নের** উত্তর দিয়েছে। আজ সেই তিনটা প্রশ্ন, আর প্রতিটার উত্তর exercise এ সংখ্যায়।

---

## ১. Theory

### ১.১ Message Broker — মাঝখানে কেউ কেন লাগে

Lesson 7.1 এর queue টা API process এর নিজের memory তে ছিল — producer আর queue একই জায়গায়, তাই process এর সাথে queue ও মরত। সমাধান: queue টা আলাদা একটা process এ, যেটা শুধু এই কাজ করে।

**Message broker** — একটা আলাদা server, যেটা producer দের কাছ থেকে message নেয়, জমা রাখে, আর consumer দের কাছে পৌঁছে দেয়; producer আর consumer একে অপরকে চেনে না, শুধু broker কে চেনে।

```
   producer গুলো                  broker                         consumer গুলো
   ─────────────                ──────────                      ──────────────
   API instance 1 ──┐                                      ┌──► notification worker
   API instance 2 ──┼──► "comment.created" ──► [ … ] ──────┼──► search worker
   API instance 6 ──┘                                      └──► analytics worker

   • API জানে না কে পড়বে, কয়জন পড়বে, তারা এখন জীবিত কিনা
   • worker জানে না কে লিখেছে
   • দুই দিক আলাদা গতিতে, আলাদা সময়ে চলে — আর আলাদাভাবে deploy হয়
```

এটা 7.1 এর temporal coupling এর পুরো সমাধান: API এর সফল হতে শুধু broker কে জীবিত থাকতে হয়, consumer দের না। (Broker নিজেও মরতে পারে — তাই আসল broker গুলো নিজেদের কয়েকটা node এ replicate করে; RabbitMQ এর quorum queue আর Kafka এর controller দুটোই Lesson 6.2 এর Raft এর আত্মীয়। আজকের বিষয় সেটা না — আজ ধরে নিচ্ছি broker টিকে থাকে।)

এবার তিনটা প্রশ্ন।

### ১.২ প্রশ্ন ১: একটা message কে পায় — একজন, নাকি সবাই?

দুটো মৌলিক উত্তর আছে, আর দুটোই সঠিক — আলাদা কাজের জন্য।

**Competing consumers** — অনেক consumer একই queue থেকে পড়ে, আর প্রতিটা message তাদের মধ্যে **শুধু একজন** পায়; consumer বাড়ালে কাজ ভাগ হয়, দ্রুত শেষ হয়।

এটাই 7.1 এর job queue: "এই email টা পাঠাও" একটা **কাজ**, আর কাজ একবারই করতে হয়। ৮টা worker মানে ৮ গুণ দ্রুত, একই email ৮ বার না।

**Publish/Subscribe (pub/sub)** — producer একটা **topic** এ message পাঠায়, আর সেই topic এর প্রতিটা **subscriber** message টার নিজের একটা কপি পায়।

এটা একটা **খবর**: "একটা comment তৈরি হলো।" খবর যে শুনতে চায় তার সবার কাছে যায় — notification, search, analytics, Slack — চারজনই।

Exercise এর `npm run fanout` দেখায় ভুল উত্তর বাছলে কী হয়। ১০৬৯টা ঘটনা; email, search আর analytics তিনজনেরই সবগুলো দরকার:

```
   broker                            email পেল   search পেল   analytics পেল
   queue — একটাই queue, সবাই মিলে         40%          40%             20%
   queue — service প্রতি queue           100%         100%            100%
   pub/sub                               100%         100%            100%
   log — service প্রতি group             100%         100%            100%
```

প্রথম সারিটা পড়ো: তিনটা service এর worker একটা queue তে (email এর ২টা, search এর ২টা, analytics এর ১টা) — broker তাদের মধ্যে round-robin এ ভাগ করে দেয়। প্রতিটা comment **একজনের** কাছে যায়, তাই search index এ ৬০% comment নেই, analytics এ ৮০% নেই। Queue ঠিক তার কাজ করছে — "প্রতিটা message একবার" — আর এখানে সেটাই ভুল।

**বাস্তবে দুটোই একসাথে লাগে।** Search service এর নিজেরও ২টা worker — তাদের মধ্যে comment গুলো **ভাগ** হওয়া উচিত (competing), কিন্তু search, analytics আর notification এর প্রত্যেকের **পুরো** কপি পাওয়া উচিত (pub/sub)। তাই নিয়মটা:

```
                       ┌──► [ queue: search ]        ──► search worker 1, 2      (নিজেদের মধ্যে ভাগ)
   comment.created ────┼──► [ queue: analytics ]     ──► analytics worker 1
       (একবার লেখা)    └──► [ queue: notification ]  ──► notification worker 1, 2, 3

   service গুলোর মধ্যে: pub/sub (প্রত্যেকে সব পায়)
   service এর ভেতরে:    competing consumers (worker রা ভাগ করে)
```

RabbitMQ এ ঠিক এটাই বানানো হয়: producer একটা **fanout exchange** এ পাঠায়, আর প্রতিটা service নিজের queue বানিয়ে exchange এর সাথে জোড়ে (binding)। Exchange প্রতিটা message এর একটা কপি প্রতিটা জোড়া queue তে রাখে। (Exchange এর আরও ধরন আছে — direct আর topic exchange routing key দেখে বাছে কোন queue তে যাবে, যেমন `comment.*` বা `task.completed`।) Table এর দ্বিতীয় সারি এটাই। AWS এ একই আকৃতির নাম SNS topic → কয়েকটা SQS queue।

Kafka তে এই দুই স্তর একটা ধারণাতেই আছে — consumer group, ১.৪ এ। আর নাম নিয়ে একটা সতর্কতা: "Pub/Sub" নামটা বিভ্রান্তিকর। Redis এর Pub/Sub সত্যিকারের সরল pub/sub (কিছু জমা রাখে না, ১.৩ এ দেখবে), কিন্তু Google Cloud এর "Pub/Sub" product আসলে fanout + প্রতিটা subscription এ একটা টেকসই queue — উপরের ছবির মতো। নাম দেখে না, তিনটা প্রশ্নের উত্তর দেখে চেনো।

### ১.৩ প্রশ্ন ২ (ক): Consumer না থাকলে, বা ধীর হলে — message এর কী হয়?

মঙ্গলবারের incident এর প্রশ্ন। `npm run crash` — search service ২০ থেকে ৩০ সেকেন্ড বন্ধ (deploy), বাকিরা চলছে:

```
   broker                          হারাল   দুবার প্রক্রিয়া   দেরি p99    দেরি max
   pub/sub                           193                0      36 ms      43 ms
   queue (ack প্রতি message)           0                0      9.6 s      9.8 s
   log (commit প্রতি 5.0 s)            0              110     10.6 s     11.0 s
   log (commit প্রতি 100 ms)           0                2      9.6 s      9.8 s
```

**Pub/Sub এর সারি:** ১৯৩টা comment search কখনো পায়নি — আর তার দেরি মাত্র ৩৬ ms! দুটো একই কারণে: Redis Pub/Sub message **জমা রাখে না**। Publish এর মুহূর্তে যে subscriber connected, সে পায়; যে নেই, তার জন্য message টা কোথাও নেই — কখনো না। দেরি কম কারণ যা দেরিতে আসতে পারত, সেগুলো আসেইনি। এটা ত্রুটি না, এটাই design: Redis Pub/Sub একটা "এখন যারা শুনছে তাদের বলে দাও" এর tool — **সর্বোচ্চ একবার (at-most-once)**।

এটা কোথায় ঠিক? যেখানে হারানো খবর নিজেই মূল্যহীন: "X টাইপ করছে…", কারো online/offline অবস্থা, একটা cache কে "এই key বাতিল করো" বলা (হারালে TTL তো আছেই — Lesson 4.3)। যেখানে ঠিক না: যেকোনো কাজ যেটা হতেই হবে।

**Queue এর সারি:** কিছু হারায়নি, কিছু দুবার হয়নি; শুধু বন্ধ থাকার সময়ের comment গুলো ~১০ সেকেন্ড দেরিতে। Message গুলো queue তে অপেক্ষা করেছে। কিন্তু একটা প্রশ্ন আছে যেটা এখানে লুকানো: search worker message টা পেল, তারপর crash করল — message এর কী হবে? Broker কীভাবে জানে কাজটা শেষ হয়েছে?

**Acknowledgement (ack)** — consumer broker কে জানায় "এই message এর কাজ শেষ, মুছে ফেলো"; ack আসার আগে consumer এর connection ছিঁড়ে গেলে broker message টা আবার queue তে ফেরত দেয়, অন্য কাউকে দেওয়ার জন্য।

আর এখানেই Lesson 6.1 এর পুরনো প্রশ্ন ফিরে আসে — কখন ack পাঠাবে?

```
  কাজের আগে ack:     ack ──► index এ লেখো ──► ✗ crash
                     broker ভাবে শেষ, মুছে ফেলল; index এ লেখা হয়নি   →  হারাল   (at-most-once)

  কাজের পরে ack:     index এ লেখো ──► ✗ crash ──► (ack যায়নি)
                     broker message ফেরত দিল; নতুন worker আবার লিখবে →  দুবার   (at-least-once)
```

দুটো অবস্থার মধ্যে একটা বাছতেই হবে, কারণ "কাজ করা" আর "broker কে জানানো" দুটো আলাদা machine এ দুটো আলাদা ঘটনা — মাঝখানে crash হতেই পারে। বাস্তবে প্রায় সবাই দ্বিতীয়টা বাছে (হারানোর চেয়ে দুবার ভালো, যদি দুবার নিরাপদ করা যায়)। Exercise এ ack এর যাওয়া-আসায় মাত্র ৫ ms, তাই এই crash এ duplicate ০ — কিন্তু ফাঁকটা আছে, আর বড় system এ প্রতিদিন কেউ না কেউ ঠিক সেখানে পড়ে। "Exactly once" delivery broker একা দিতে পারে না; "exactly once" **ফল** আসে at-least-once delivery + idempotent consumer থেকে — Lesson 7.4 এর পুরোটা।

**Log এর সারি:** কিছু হারায়নি — কিন্তু **১১০টা** comment দুবার index এ গেছে। কেন queue এর চেয়ে এত বেশি? কারণ log এ ack প্রতি message এ হয় না; consumer মাঝে মাঝে জানায় "আমি এই পর্যন্ত পড়েছি" (offset commit, ১.৪ এ)। Kafka এর client এর default এ এটা প্রতি **৫ সেকেন্ডে** (`auto.commit.interval.ms`)। Crash এর পরে consumer শেষ commit থেকে শুরু করে, তাই শেষ commit এর পরে যা প্রক্রিয়া হয়েছিল — এখানে ~৫ সেকেন্ডের কাজ — আবার হয়। Commit ১০০ ms এ করলে duplicate ২ তে নামে (experiment ১: ১ সেকেন্ডে ১৮) — কিন্তু প্রতিটা commit broker এ একটা লেখা, আর শূন্য কখনো হয় না।

**এবার ধীর consumer** — বৃহস্পতিবারের incident। `npm run slow` — analytics এর একটা worker প্রতি ঘটনায় ৬০–১০০ ms নেয় (≈১২.৫/s), আর ঘটনা আসে ≈১৭.৮/s। Lesson 7.1 এর ভাষায়: consumer এর গতি আসার গতির চেয়ে কম, backlog বাড়বেই। প্রশ্ন হলো backlog টা **কোথায়** থাকে:

```
   broker     analytics হারাল   জমা (সর্বোচ্চ)   analytics দেরি max   email দেরি p99
   pubsub                 367              101                6.0 s           171 ms
   queue                    0              375               32.1 s           199 ms
   log                      0              334               27.7 s           271 ms
```

প্রথমে শেষ কলাম দেখো: **তিনটাতেই email অক্ষত।** ধীর analytics অন্য কাউকে টেনে নামায় না — কারণ প্রতিটা service এর নিজের কপি, নিজের লাইন। 7.1 এর cascading failure এর ঠিক উল্টো; broker ধীর consumer কে আলাদা করে রাখে।

পার্থক্য শুধু ধীর জনের নিজের:

- **Pub/Sub:** Redis প্রতিটা subscriber এর জন্য একটা output buffer রাখে; সেটা একটা সীমা ছাড়ালে Redis subscriber কে **কেটে দেয়** আর buffer ফেলে দেয় — নিজের memory বাঁচাতে। (Redis এর default `client-output-buffer-limit pubsub 32mb 8mb 60`; exercise এ সরলতার জন্য "১০০টা message"।) Analytics আবার connect করে, আবার পিছিয়ে পড়ে, আবার কাটা যায় — ৩৬৭টা হারাল। বৃহস্পতিবারের log লাইন ঠিক এটাই।
- **Queue:** কিছু হারায় না — কিন্তু ৩৭৫টা message **broker এর** memory/disk এ জমা, আর শেষেরটা ৩২ সেকেন্ড দেরিতে। এই সংখ্যা সীমাহীন বাড়তে পারে। RabbitMQ এর জগতের একটা পরিচিত সতর্কবাণী: লম্বা queue broker এর জন্য ভারী (memory, disk, recovery এর সময়) — queue খালি থাকা অবস্থার জন্য সবচেয়ে ভালো। সীমা বসানো যায় (queue এর max length, message TTL) — কিন্তু তখন কী ফেলবে সেটা তোমার সিদ্ধান্ত (7.4 এর backpressure)।
- **Log:** কিছু হারায় না, আর ৩৩৪ টা **বাড়তি জমা না** — log এ সব message এমনিতেই থাকে (retention পর্যন্ত), analytics শুধু পেছনে পড়ে আছে। এই দূরত্বের নাম **consumer lag**, আর Kafka চালানো team এর সবচেয়ে গুরুত্বপূর্ণ metric এটাই। Broker এর কাছে ধীর consumer আর দ্রুত consumer এর দাম একই।

(Queue এর জমা log এর চেয়ে একটু বেশি কেন — ৩৭৫ বনাম ৩৩৪ — সেটা exercise এর README তে: prefetch ১ এ প্রতিটা message এ ack এর যাওয়া-আসার সময় যোগ হয়। বাস্তবেও RabbitMQ এ prefetch বড় রাখা হয় এই কারণে।)

### ১.৪ প্রশ্ন ২ (খ): পড়ার পরে message থাকে, নাকি মুছে যায়?

এবার পরের মাসের plan: নতুন search index বানাতে **সব পুরনো comment** লাগবে। Queue তে ack হওয়া message মুছে গেছে — broker এর কাছে ইতিহাস বলে কিছু নেই। এখানে তৃতীয় model টা আলাদা হয়ে দাঁড়ায়।

**Append-only log আর offset** — broker message গুলো একটা খাতার মতো শেষে যোগ করে যায় আর **পড়ার পরেও মোছে না** (নির্দিষ্ট সময় বা আকার পর্যন্ত — **retention**)। প্রতিটা message এর একটা ক্রমিক নম্বর — **offset**। কে কতদূর পড়েছে, সেটা broker এর message এ না, পাঠকের নিজের offset এ লেখা।

```
   partition 0:   [0] [1] [2] [3] [4] [5] [6] [7] [8] [9] …   ← নতুন message শেষে যোগ হয়
                                   ▲                   ▲
                    analytics এর offset = 3    search এর offset = 9
                    (পিছিয়ে আছে — lag 7)      (প্রায় শেষে)

   • পড়লে কিছু মোছে না — search পড়লেও analytics এর জন্য [3]…[9] রয়ে যায়
   • নতুন কেউ এলে offset 0 থেকে শুরু করতে পারে — পুরো ইতিহাস
   • bug fix এর পরে পুরনো offset এ ফিরে আবার পড়া যায় (replay)
```

Queue এর সাথে মূল পার্থক্য এক বাক্যে: **queue তে "কে কী পড়েছে" এর হিসাব message এর উপর (ack হলে মুছে যায়), log এ হিসাব পাঠকের উপর (একটা সংখ্যা)।** এই এক পার্থক্য থেকে বাকি সব আসে।

আর ১.২ এর "service এর মধ্যে ভাগ, service গুলোর মধ্যে সবাই" — log এ এর নাম:

**Consumer group** — একই কাজের জন্য কয়েকটা consumer এর একটা দল, যাদের একটা offset এর সেট থাকে; group এর ভেতরে message গুলো ভাগ হয় (প্রতিটা partition একজন সদস্যের কাছে), আর আলাদা group গুলো একে অপরের থেকে স্বাধীনভাবে পুরো log পড়ে।

Search একটা group, analytics একটা group — প্রত্যেকে নিজের গতিতে সব পড়ে। নতুন একটা service যোগ করা মানে একটা নতুন group; producer বা broker এর কনফিগারেশন বদলাতে হয় না।

`npm run replay` — নতুন `search-v2` service যোগ দিল ৬০ সেকেন্ডে, আর তার আগের সব ঘটনাও চায়:

```
   broker                   আগের ঘটনা পেল    পরের ঘটনা পেল
   pub/sub                       0 / 1069        551 / 551
   queue                         0 / 1069        551 / 551
   log (retention 7 দিন)      1069 / 1069        551 / 551
   log (retention 30 s)        566 / 1069        551 / 551
```

Queue আর pub/sub এর জন্য ইতিহাস বলে কিছু নেই — নতুন queue তৈরির আগের message সেখানে কখনো যায়নি। Log পুরো ইতিহাস দেয় — **retention এর সীমা পর্যন্ত**। Kafka এর default retention ৭ দিন (`log.retention.hours=168`, topic ধরে বদলানো যায়); retention ৩০ সেকেন্ড হলে শুধু শেষ ৩০ সেকেন্ডের ৫৬৬টা। (আরেকটা ধরন আছে — **log compaction**: সময় দিয়ে না মুছে, প্রতিটা key এর শুধু সর্বশেষ মানটা রাখে; "প্রতিটা task এর বর্তমান অবস্থা" এর মতো data এর জন্য।)

**একটা সৎ সতর্কতা:** "log এ সব আছে, তাই database লাগবে না" — এই ভাবনা বিপজ্জনক। Search-v2 এর মতো কাজের জন্য সাধারণত নিরাপদ পথ হলো **database থেকে** একবার পুরো index বানানো (source of truth ওটাই), তারপর log থেকে নতুন পরিবর্তন গুলো ধরা। Log কে সবকিছুর মূল উৎস বানানো (event sourcing) একটা বৈধ কিন্তু বড় design সিদ্ধান্ত — 7.5 এ এর কথা আসবে।

### ১.৫ প্রশ্ন ৩: কোন ক্রমে আসে?

একই task এর ঘটনা: `task.created` → `task.assigned` → `comment.created` → `task.completed`। Notification service যদি "completed" আগে প্রক্রিয়া করে আর "assigned" পরে, তাহলে assignee একটা ইতিমধ্যে শেষ হওয়া task এর "তোমাকে assign করা হয়েছে" email পায় — আর যদি service টা task এর অবস্থা রাখে, সেটা শেষে "assigned" এ আটকে থাকে, "completed" এ না।

Queue নিজে FIFO — broker message গুলো ক্রমেই দেয়। কিন্তু **competing consumers** এর সাথে ক্রম টেকে না: worker A পেল "assigned" (ধীর, ১২০ ms), worker B পেল "completed" (দ্রুত, ২০ ms) — B আগে শেষ করল। ক্রমে **দেওয়া** আর ক্রমে **শেষ হওয়া** এক জিনিস না। আর ack না পাওয়া message আবার queue তে ফিরলে (১.৩) সে তার পরের message গুলোর পরে প্রক্রিয়া হয়।

Log এর উত্তর: **partition** আর **key**। Lesson 5.8 এর shard এর মতোই — topic কে কয়েকটা partition এ ভাগ করা হয়, আর প্রতিটা message এর একটা key থেকে (সাধারণত key এর hash % partition সংখ্যা) ঠিক হয় কোন partition এ যাবে। দুটো নিয়ম:

1. একই key → সবসময় একই partition, আর একটা partition এর ভেতরে ক্রম কড়াভাবে রক্ষা হয়।
2. একটা group এ একটা partition একসাথে **একজন** consumer পড়ে — আর সে একটা একটা করে, ক্রমে।

তাই key = `taskId` দিলে একই task এর সব ঘটনা একজন consumer এর হাতে, ক্রমে। ভিন্ন task এর ঘটনা ভিন্ন partition এ, সমান্তরালে। Kafka কোনো **পুরো topic এর** ক্রম দেয় না — শুধু প্রতি partition এ; আর সেটাই সাধারণত যথেষ্ট, কারণ আসলে যা চাই তা হলো **প্রতি entity এর** ক্রম।

`npm run ordering` — notifier service, প্রতিটা ঘটনায় ২০–১২০ ms, কিন্তু ১% ঘটনায় ৩ সেকেন্ড (provider এর একটা ধীর মুহূর্ত):

```
   broker                           ক্রম ভাঙা task   দেরি p50   দেরি p99   দেরি max   কাজ পাওয়া consumer
   queue, 4 worker                             11      76 ms      3.0 s      3.1 s   4
   log, key = task, 4 partition                 0      94 ms      4.8 s      7.0 s   4
   log, key = random, 4 partition              69      97 ms      4.2 s      4.7 s   4
   log, key = task, 8 consumer                  0      94 ms      4.8 s      7.0 s   4 (4 জন বসে থাকে)
```

চারটা শিক্ষা, প্রতিটা সারিতে একটা:

1. **Queue, ৪ worker:** ২৫২টা task এর ১১টার ক্রম ভেঙেছে। দুর্লভ — আর ঠিক এই কারণে বিপজ্জনক: testing এ ধরা পড়ে না, production এ মাসে কয়েকবার।
2. **Log, key = task:** ক্রম ভাঙা **০**। কিন্তু দেরি max ৭ সেকেন্ড — queue এর দ্বিগুণের বেশি। কেন? ৩ সেকেন্ডের ধীর message টা তার partition এর পেছনের সবাইকে আটকে রাখে; ক্রম রক্ষা মানেই পরেরটা আগেরটার অপেক্ষা করবে। Queue এ অন্য worker রা এগিয়ে যায় — তাই দ্রুত, কিন্তু ক্রম হারায়।

   **Head-of-line blocking** — লাইনের সামনের একটা ধীর বা আটকে থাকা message তার পেছনের সবগুলোকে আটকে রাখে, যদিও পেছনের গুলো নিজেরা দ্রুত শেষ হতে পারত।

   আরও খারাপ রূপ: সামনের message টা **প্রতিবার** ব্যর্থ হয় (ভাঙা data — "poison message")। Log এ offset তার পরে যেতে পারে না, তাই পুরো partition থেমে থাকে। Queue তে per-message ack আছে — একটা message আলাদা করে সরিয়ে রাখা যায়। Log এ সমাধান consumer এর নিজের: ব্যর্থ message টা আলাদা একটা topic এ ফেলে এগিয়ে যাওয়া (7.4 এর dead letter)।

3. **Log, key = random:** partition আছে, কিন্তু key ভুল — একই task এর ঘটনা ভিন্ন partition এ ছড়িয়ে গেল, ৬৯টা task এর ক্রম ভাঙল, queue এর চেয়েও বেশি। Partition নিজে ক্রম দেয় না; **সঠিক key** দেয়।
4. **Log, ৮ consumer:** ৪টা partition, ৮ জন consumer — ৪ জন কোনো কাজ পায় না, ফল হুবহু ৪ জনের মতো। Group এর সমান্তরালতার সীমা = partition এর সংখ্যা। তাই partition সংখ্যা আগে থেকে ভেবে বাছতে হয় (পরে বাড়ানো যায়, কিন্তু তখন key → partition এর হিসাব বদলে যায়, আর চলমান ক্রমের নিশ্চয়তা ভাঙতে পারে)। Experiment ৩: `PARTITIONS=8` এ ৮ জনই কাজ পায়, p99 ৪.৮ থেকে ৩.০ সেকেন্ড।

আর spaced repetition এর প্রশ্ন ঠিক এখানে ফেরে: key = `projectId` দিলে সেই enterprise customer এর project এর সব ঘটনা **একটা** partition এ — **hot partition**, Lesson 5.8 এর মতোই। সেই partition এর consumer এর lag বাড়তে থাকে, আর বাকি consumer রা বসে থাকে। Key বাছার নিয়ম: যে entity র ক্রম **সত্যিই** লাগে, তার সবচেয়ে ছোট একক (এখানে task, project না)।

"তাহলে পুরো system এর একটাই ক্রম চাই" — experiment ৪: `PARTITIONS=1`। ক্রম ভাঙা ০, আর দেরি p99 ৫২ সেকেন্ড: একটা partition মানে একজন consumer, আর তার গতি আসার গতির চেয়ে কম (7.1 এর backlog)। **সম্পূর্ণ ক্রম আর সমান্তরালতা একসাথে পাওয়া যায় না** — Module 6 এর consistency এর মতোই, ক্রমের প্রতিটা নিশ্চয়তার একটা দাম আছে।

(Queue এর জগতেও per-key ক্রমের উপায় আছে: RabbitMQ এর "single active consumer" একটা queue তে একসাথে একজন consumer রাখে; consistent hash exchange key দিয়ে queue ভাগ করে; AWS SQS FIFO queue তে "message group ID" দিয়ে প্রতি group এ ক্রম। সবগুলো একই ধারণা — ক্রম চাইলে একটা key এর সব কিছু এক লাইনে।)

### ১.৬ তিনটা (আসলে চারটা) tool

এখন tool এর নামগুলো তিনটা প্রশ্নের উত্তর দিয়ে পড়া যায়।

**Redis Pub/Sub** — সরল pub/sub। কিছু জমা থাকে না, ack নেই, ধীর subscriber কাটা যায়। At-most-once। দ্রুত আর সহজ — যেখানে হারানো চলে। (Redis 7 এ cluster এর জন্য sharded pub/sub যোগ হয়েছে; নিয়ম একই।)

**RabbitMQ** — queue-কেন্দ্রিক broker (মূল protocol AMQP 0-9-1)। Producer exchange এ পাঠায়, exchange routing নিয়ম দিয়ে queue তে রাখে, consumer queue থেকে নেয় আর **প্রতিটা message আলাদা করে** ack করে। শক্তি: routing এর নমনীয়তা (direct, topic, fanout, headers exchange), per-message ack আর redelivery, priority, message TTL, dead-letter exchange। Ack হওয়া message মুছে যায় — ইতিহাস নেই। টেকসই আর replicated queue এর জন্য নতুন version এ quorum queue (Raft ভিত্তিক); আর log-ধরনের কাজের জন্য RabbitMQ Streams ও যোগ হয়েছে (3.9 থেকে) — "RabbitMQ মানে শুধু queue" কথাটা এখন আর পুরো সত্য না।

**Apache Kafka** — log-কেন্দ্রিক। Topic → partition → append-only log, retention পর্যন্ত রাখা, consumer group আর offset। শক্তি: বিশাল throughput (sequential disk লেখা — Lesson 5.3 এর LSM এর মতো ধারণা), অনেক group একই data স্বাধীনভাবে পড়তে পারে, replay, আর এর উপর stream processing (7.6)। দুর্বলতা: per-message ack নেই (offset একটা সীমা, তাই poison message আর head-of-line blocking), সমান্তরালতা partition এ বাঁধা, আর চালানো ভারী (cluster, partition, replication এর পরিকল্পনা — যদিও managed service অনেক আছে)। (সৎ নোট: Kafka 4.x এ "share group" — KIP-932 — নামে queue-এর মতো per-message consumption আসছে; লেখার সময় এটা early access/preview পর্যায়ে, তাই ব্যবহারের আগে version দেখে নিও। আর Kafka 4.0 থেকে ZooKeeper পুরোপুরি বাদ, metadata এখন Kafka এর নিজের Raft — KRaft — এ।)

**Redis Streams** (Redis 5.0 থেকে) — একটা মজার মিশ্রণ। Log এর মতো: `XADD` দিয়ে শেষে যোগ, প্রতিটা entry এর ID, পড়লে মোছে না (`MAXLEN`/`MINID` দিয়ে ছাঁটা), একাধিক consumer group, পুরনো ID থেকে আবার পড়া যায়। কিন্তু queue এর মতো: group এর ভেতরে প্রতিটা message **আলাদা করে** ack হয় (`XACK`), আর যা ack হয়নি তার তালিকা (pending entries list) থাকে, যাতে মরা consumer এর message অন্য কেউ তুলে নিতে পারে (`XAUTOCLAIM`, Redis 6.2+)। সীমা: data memory তে (persistence Redis এর AOF/RDB এর উপর নির্ভর), আর একটা stream একটা key — cluster এ একটা shard এ থাকে, Kafka এর মতো নিজে থেকে partition হয় না (লাগলে কয়েকটা stream নিজে বানাতে হয়)।

> **Trade-off Table — তিনটা প্রশ্নে চারটা tool**

| Tool              | কে পায়                                             | পড়ার পরে                      | ক্রম                                                  | ধীর/অনুপস্থিত consumer              | ভালো কাজ                                                |
| ----------------- | --------------------------------------------------- | ------------------------------ | ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| **Redis Pub/Sub** | প্রতিটা connected subscriber                        | কিছুই জমা থাকে না              | একজন subscriber এর কাছে ক্রমে                         | অনুপস্থিত → হারায়; ধীর → কেটে দেয় | Presence, typing, cache invalidation — হারালে ক্ষতি নেই |
| **RabbitMQ**      | Queue প্রতি একজন (fanout দিয়ে service প্রতি সব)    | Ack এ মুছে যায়                | Queue FIFO, কিন্তু competing consumer এ ভাঙে          | Broker এ জমা (লম্বা queue ভারী)     | Job/task, জটিল routing, per-message retry               |
| **Kafka**         | Group প্রতি সব; group এর ভেতরে partition প্রতি একজন | Retention পর্যন্ত থাকে; replay | Partition এর ভেতরে কড়া, key দিয়ে                    | শুধু lag; broker এর দাম একই         | Event stream, অনেক consumer, replay, বড় throughput     |
| **Redis Streams** | Group প্রতি সব; group এর ভেতরে একজন                 | ছাঁটা পর্যন্ত থাকে; replay     | Stream এ ক্রমে, কিন্তু group এর consumer রা সমান্তরাল | জমা থাকে (memory তে)                | মাঝারি আকারের event/job, Redis আগে থেকে থাকলে           |

(Cloud এ প্রতিটার আত্মীয় আছে: SQS ≈ queue, SNS ≈ pub/sub এর fanout, SNS→SQS ≈ RabbitMQ এর fanout exchange; Kinesis আর managed Kafka ≈ log। নাম আলাদা, তিনটা প্রশ্ন একই।)

### ১.৭ TaskFlow এর সিদ্ধান্ত — message প্রতি, tool প্রতি না

প্রথম ভুলটা ছিল "একটা tool বাছো" ধরে নেওয়া। আসলে TaskFlow এ দুই ধরনের message আছে, আর তারা আলাদা প্রশ্নের আলাদা উত্তর চায়:

- **কাজ (job / command):** "এই email পাঠাও", "এই thumbnail বানাও", "এই export তৈরি করো"। একজন করবে, একবার (বা idempotent ভাবে অন্তত একবার), ব্যর্থ হলে সেই একটা আলাদা করে আবার চেষ্টা, হয়তো দেরিতে (৫ মিনিট পরে reminder)। ইতিহাস লাগে না। → **queue semantics**: per-message ack, retry, delay। TaskFlow এর Node stack এ এর সবচেয়ে সহজ পথ BullMQ (Redis এর উপর) — Lesson 7.3।
- **খবর (event):** "comment তৈরি হলো", "task complete হলো"। যতজন শুনতে চায় সবাই, প্রত্যেকে নিজের গতিতে, প্রতি task এ ক্রমে, আর নতুন service এলে পুরনো খবরও পেলে ভালো। → **log semantics**: consumer group, partition key = `taskId`, retention।

দ্বিতীয়টার জন্য কি Kafka লাগবে? সৎ উত্তর: **TaskFlow এর আকারে সম্ভবত না।** ~২০টা ঘটনা প্রতি সেকেন্ডে — Kafka এর জন্য এটা শূন্যের কাছাকাছি, আর একটা Kafka cluster চালানোর দাম (বা managed service এর bill) এর চেয়ে বেশি। Redis আগে থেকেই আছে; Redis Streams এ consumer group, per-message ack আর সীমিত replay সবই আছে। যেদিন দরকার হবে — অনেক team, অনেক consumer, সপ্তাহের retention, stream processing — সেদিন Kafka। এটা Lesson 10.7 এর cost এর প্রশ্নও।

আর Redis Pub/Sub এর জায়গা আছে — শুধু অন্য কাজে: comment এর পাশে "Rahim টাইপ করছে…" দেখানো, যেখানে হারানো খবরের কোনো মূল্য নেই।

শেষ একটা সতর্কতা, যেটা interview আর production দুই জায়গাতেই কাজে লাগে: **tool কে তার বিপরীত কাজে লাগানো** একটা পরিচিত ব্যর্থতা। Kafka কে per-message retry সহ job queue বানানো (poison message এ partition আটকে যায়), বা RabbitMQ কে event এর ইতিহাস হিসেবে রাখা (লম্বা queue, ইতিহাস নেই) — দুটোই সম্ভব, দুটোই কষ্টের।

---

## ২. Interview Angle

**"Kafka আর RabbitMQ এর পার্থক্য কী?"** — সবচেয়ে common প্রশ্ন, আর সবচেয়ে সাধারণ দুর্বল উত্তর "Kafka দ্রুত"। ভালো উত্তর মূল পার্থক্য থেকে শুরু করে: "RabbitMQ একটা queue — message ack হলে মুছে যায়, হিসাব message এর উপর। Kafka একটা log — message থাকে, হিসাব পাঠকের offset এ।" তারপর এর ফল: replay আর অনেক consumer group (Kafka), per-message ack আর routing আর retry (RabbitMQ), ক্রম প্রতি partition আর সমান্তরালতা partition এ বাঁধা (Kafka)। শেষে: "job এর জন্য queue, event stream এর জন্য log" — আর একটা উদাহরণ।

**Design interview এ ("design a notification system", "design a news feed"):** diagram এ "Kafka" লেখা একটা বাক্স আঁকার পরে interviewer প্রায় সবসময় জিজ্ঞেস করে — partition key কী? কয়টা partition? consumer crash করলে কী হয়? উত্তর তৈরি রাখো: key = যে entity র ক্রম লাগে (user, task), partition সংখ্যা = প্রত্যাশিত সর্বোচ্চ consumer এর সমান্তরালতা (আর কিছু বাড়তি), crash → শেষ commit থেকে আবার, তাই duplicate, তাই idempotent consumer। বোনাস: hot partition এর কথা নিজে থেকে তোলা (celebrity user)।

**"Exactly once delivery কি সম্ভব?"** — Trap। উত্তর: broker থেকে consumer এর side effect পর্যন্ত পুরো পথে, সাধারণ ভাবে না — ack আর কাজ দুটো আলাদা ঘটনা (১.৩ এর ছবি)। বাস্তবে: at-least-once delivery + idempotent processing = exactly-once **ফল**। Kafka এর "exactly-once semantics" (transaction আর idempotent producer) Kafka এর **ভেতরে** পড়া-প্রক্রিয়া-লেখা এর জন্য; consumer যখন বাইরের কিছু (email, অন্য database) ছোঁয়, তখন আবার idempotency তোমার দায়িত্ব।

**Production এ বাস্তবে:** Queue এর জন্য মাপো queue এর দৈর্ঘ্য আর সবচেয়ে পুরনো message এর বয়স (7.1); log এর জন্য প্রতিটা consumer group এর lag — group আর partition ধরে। আর একটা বাস্তব ঘটনা যা প্রায় সব team এর হয়: Kafka consumer এর processing ধীর হলে সে সময়মতো poll করে না, broker ধরে নেয় সে মৃত, তার partition অন্যকে দেয় (rebalance), সে জেগে উঠে commit করতে গিয়ে ব্যর্থ — আর সেই batch আবার প্রক্রিয়া হয়। Lesson 6.1 এর process pause, নতুন পোশাকে।

---

## ৩. Key Takeaway

- যেকোনো messaging system কে তিনটা প্রশ্ন দিয়ে চেনো: **একটা message কে পায়**, **পড়ার পরে থাকে কিনা**, **কোন ক্রমে আসে** — নাম দিয়ে না ("Pub/Sub" নামের product ও আসলে queue হতে পারে)
- **Competing consumers** (একজন পায়) কাজের জন্য, **pub/sub** (সবাই পায়) খবরের জন্য; বাস্তবে দুটো একসাথে — service গুলোর মধ্যে সবাই, service এর ভেতরে ভাগ (fanout exchange + queue, বা consumer group)। Exercise এ একটা queue তে তিনটা service → ৪০/৪০/২০%
- **Redis Pub/Sub** কিছু জমা রাখে না: deploy এ ১৯৩টা হারাল, ধীর subscriber কাটা পড়ে। হারালে-চলে এমন খবরের জন্য
- **Ack** কাজের আগে → হারানো, পরে → দুবার; broker একা "exactly once" দিতে পারে না। Log এর offset commit এ duplicate এর জানালা আরও বড় (৫ s এ ১১০টা) — at-least-once + idempotent consumer (7.4)
- ধীর consumer broker এ অন্যদের টেনে নামায় না; ব্যাকলগ থাকে queue তে **জমা** হয়ে, log এ শুধু **lag** হিসেবে
- **Log** পড়ার পরে মোছে না — **consumer group** প্রতি offset, retention পর্যন্ত **replay**, নতুন service এর জন্য ইতিহাস
- ক্রম আসে **partition + সঠিক key** থেকে (key = task → ০ ভাঙা, random → ৬৯); দাম **head-of-line blocking** (দেরি max ৩.১ → ৭.০ s), সমান্তরালতা partition এ বাঁধা, আর ভুল key এ hot partition

---

## ৪. নতুন Term (Glossary)

| Term                         | অর্থ                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Message Broker**           | Producer দের message নিয়ে জমা রাখে আর consumer দের কাছে পৌঁছায় — এমন আলাদা server; দুই পক্ষ একে অপরকে চেনে না                 |
| **Competing Consumers**      | অনেক consumer একই queue থেকে পড়ে, প্রতিটা message শুধু একজন পায় — কাজ ভাগ হয়                                                 |
| **Publish/Subscribe**        | Producer একটা topic এ পাঠায়, প্রতিটা subscriber নিজের কপি পায়                                                                 |
| **Acknowledgement (Ack)**    | Consumer broker কে জানায় "এই message এর কাজ শেষ"; ack এর আগে consumer হারালে broker message আবার দেয়                          |
| **Append-only Log / Offset** | Message শেষে যোগ হয়, পড়ার পরে মোছে না (retention পর্যন্ত); offset হলো message এর ক্রমিক নম্বর, আর পাঠক কতদূর পড়েছে তার চিহ্ন |
| **Consumer Group**           | একই কাজের consumer দের দল, একটা offset এর সেট সহ — ভেতরে partition ভাগ হয়, আলাদা group স্বাধীনভাবে পুরো log পড়ে               |
| **Head-of-line Blocking**    | লাইনের সামনের একটা ধীর বা আটকানো message পেছনের সবগুলোকে আটকে রাখে — ক্রম রক্ষার দাম                                            |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এর চারটা message এর প্রতিটার জন্য বাছো — queue, সরল pub/sub, নাকি log — আর তিনটা প্রশ্নের (কে পায়, থাকে কিনা, ক্রম) উত্তর দিয়ে কারণ বলো: (ক) password reset email; (খ) `task.completed`, যেটা notification, analytics, billing (প্রতি completed task এ usage গোনা) আর একটা webhook integration শোনে; (গ) board এ অন্য কেউ একটা card টেনে সরালে সবার browser এ সেটা live সরে যাওয়া; (ঘ) audit team এর চাওয়া: "গত ৩০ দিনে কোন task এ কে কী বদলেছে, যেকোনো সময় আবার দেখতে চাই।"
2. TaskFlow এর `task-events` Kafka topic এ ৬টা partition, key = `projectId`, আর notification group এ ৬টা consumer। একটা enterprise customer এর একটা project থেকে এখন সব ঘটনার ৬০% আসে। Dashboard এ কী দেখবে (কোন metric, কোথায়)? আরও ৬টা consumer যোগ করলে কী হবে? আরও ৬টা partition যোগ করলে? আসল সমাধান কী — আর তার দাম কী?
3. একজন teammate বলল: "RabbitMQ এ message ack হওয়ার পরে মুছে যায়, আর ack না হলে আবার আসে — তাহলে প্রতিটা message ঠিক একবারই প্রক্রিয়া হয়।" কোথায় ভুল? একটা সময়ের রেখা এঁকে দেখাও কীভাবে একই message দুবার প্রক্রিয়া হয়, আর কীভাবে (অন্য ack নীতিতে) একবারও না। TaskFlow এর "comment এর mention email" এর জন্য কোন নীতি বাছবে, আর duplicate এর বিরুদ্ধে কী করবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

- **(ক) Password reset email → queue।** একজন worker পাঠাবে (competing), একবার; ব্যর্থ হলে সেই email টা আবার চেষ্টা; পাঠানোর পরে ইতিহাসের দরকার নেই (এমনকি রাখা উচিতও না — link এ token আছে); ক্রম অপ্রাসঙ্গিক। এটা একটা **কাজ**, খবর না। BullMQ/RabbitMQ/SQS।
- **(খ) `task.completed` → log (বা fanout + service প্রতি queue)।** চারজন শোনে — pub/sub এর "সবাই পায়"। আর billing এর জন্য হারানো চলবে না, তাই সরল Redis Pub/Sub না। প্রতি task এ ক্রম (completed এর পরে reopened আসতে পারে) → key = `taskId`। Billing এ কিছু ভুল হলে পুরনো ঘটনা আবার গুনতে পারা (replay) বড় সুবিধা → log এর দিকে ঝোঁক। Webhook টা আলাদা group, কারণ বাইরের server ধীর হতে পারে — আর log এ সে শুধু নিজের lag বাড়ায়, অন্যদের না (১.৩)।
- **(গ) Live card movement → সরল pub/sub (Redis Pub/Sub, তারপর WebSocket — Lesson 2.4)।** শুধু যারা এই মুহূর্তে board খুলে আছে তাদের দরকার; কেউ offline থাকলে পরে page খুললে database থেকে বর্তমান অবস্থা পড়বে — পুরনো "সরানো" খবর মূল্যহীন। হারানো চলে, দ্রুততা জরুরি। (একটা সূক্ষ্মতা: দুটো সরানোর খবর উল্টো ক্রমে এলে card ভুল জায়গায় দেখাতে পারে — version নম্বর পাঠিয়ে পুরনোটা ফেলে দেওয়া, 6.3 এর version token এর মতো।)
- **(ঘ) Audit → log দিয়ে আসতে পারে, কিন্তু রাখার জায়গা database।** Log (retention ৩০+ দিন) থেকে একটা audit consumer ঘটনা গুলো পড়ে একটা `audit_log` table এ লিখবে — কারণ audit এর প্রশ্ন হলো **খোঁজা** ("এই task এ কে কী"), আর log খোঁজার জন্য না, ক্রমে পড়ার জন্য। Broker কে দীর্ঘমেয়াদী record এর একমাত্র জায়গা বানানো ১.৪ এর সতর্কতা। (বিকল্প: API নিজেই transaction এর ভেতরে audit row লেখে — তাহলে broker এর দরকারই নেই। কোনটা বাছবে তা নির্ভর করে audit এ কতটা "হারানো চলবে না" লাগে — 7.5 এর outbox এর প্রশ্ন।)

**প্রশ্ন ২:** `hash(projectId) % 6` — ওই project এর সব ঘটনা একটা partition এ। Dashboard এ: ওই **একটা** partition এর consumer lag বাড়তেই থাকবে, বাকি ৫টার lag প্রায় শূন্য; ওই partition এর consumer এর CPU ১০০%, বাকিরা প্রায় অলস। ওই customer এর notification মিনিট — তারপর ঘণ্টা — দেরিতে।

- **আরও ৬টা consumer:** কোনো লাভ নেই। ৬টা partition, তাই group এ সর্বোচ্চ ৬ জন কাজ পায় (exercise এর "৪ জন বসে থাকে")। আর গরম partition একজনেরই।
- **আরও ৬টা partition:** গরম project তবু **একটা** partition এ যায় (একই key → একই partition) — তার সমস্যা যায় না। উল্টো, partition বাড়ালে `hash % n` বদলায়, তাই অন্য project গুলোর ঘটনা নতুন partition এ যেতে শুরু করে — বদলের মুহূর্তে একই project এর পুরনো আর নতুন ঘটনা দুই partition এ, ক্রম সাময়িক ভাঙতে পারে।
- **আসল সমাধান — key বদলানো:** ক্রম আসলে কোন একক এ লাগে? Notification এর জন্য "প্রতি task এ" ক্রম যথেষ্ট — project জুড়ে না। Key = `taskId` দিলে বড় project এর ঘটনা হাজার task এ ছড়ায়, সব partition এ। দাম: একই project এর দুটো ভিন্ন task এর ঘটনার মধ্যে আর কোনো ক্রম নেই — যদি কোনো consumer এর সেটা লাগে (যেমন "project এর মোট count" যেটা ক্রমে বাড়ে), তার জন্য আলাদা ব্যবস্থা। যদি সত্যিই project-স্তরের ক্রম লাগে, তাহলে ওই এক গরম key কে আলাদা করে সামলানো (নিজস্ব topic, বা key কে `projectId + bucket` এ ভাগ করা আর ক্রম ছেড়ে দেওয়া) — 5.8 এর celebrity সমস্যার একই সমাধানের তালিকা।

**প্রশ্ন ৩:** ভুলটা: "ack হলে মুছে যায়" আর "কাজ শেষ হয়েছে" এক জিনিস না — কাজ (email পাঠানো) আর ack (broker কে জানানো) দুটো আলাদা ঘটনা, আলাদা machine এ।

```
  কাজের পরে ack (at-least-once):
    t0  worker message পেল
    t1  email পাঠাল ✓                          ← side effect হয়ে গেছে
    t2  ✗ crash (বা network ছিঁড়ল), ack যায়নি
    t3  broker: connection গেল, ack নেই → message আবার queue তে
    t4  আরেক worker পেল → email আবার পাঠাল   ← দুবার

  কাজের আগে ack (at-most-once):
    t0  worker message পেল → সাথে সাথে ack → broker মুছে ফেলল
    t1  ✗ crash email পাঠানোর আগে
        message আর কোথাও নেই                   ← একবারও না
```

Mention email এর জন্য: **কাজের পরে ack** — কারণ mention এর email না যাওয়া (কেউ জানল না যে তাকে ডাকা হয়েছে) দুবার যাওয়ার চেয়ে খারাপ। Duplicate এর বিরুদ্ধে: প্রতিটা email এর একটা স্থির idempotency key (যেমন `mention:{commentId}:{userId}`), আর পাঠানোর আগে একটা `sent_notifications` table এ সেই key এর উপর unique constraint সহ insert — insert ব্যর্থ মানে আগে পাঠানো হয়েছে, এবার বাদ। (Lesson 6.1 এর reminder এর সমাধানের হুবহু মিল।) তবু একটা ছোট ফাঁক থাকে — insert সফল, email পাঠানোর আগে crash — তখন email যাবে না; সেটা বন্ধ করার উপায় (আর provider এর নিজের idempotency key) Lesson 7.4 এ।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (deterministic simulation)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-7.2-queue-vs-pubsub/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.2-queue-vs-pubsub) — `npm install`, তারপর `npm run all` (বা আলাদা করে `fanout`, `crash`, `slow`, `replay`, `ordering`)। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`brokers.ts` এ তিনটা broker এর নিয়ম — `runPubSub` (Redis Pub/Sub এর মতো), `runQueue` (RabbitMQ এর queue এর মতো, round-robin আর ack সহ), `runLog` (Kafka/Redis Streams এর মতো, partition, consumer group, offset commit, retention সহ)। `model.ts` এর `Recorder` প্রতিটা service এর চোখে মাপে: কী পেল, কয়বার, কোন ক্রমে, কত দেরিতে। প্রতিটা ঘটনার প্রক্রিয়ার সময় সব broker এ একই — তুলনাটা যাতে সৎ থাকে।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `npm run all` দুবার চালিয়ে হুবহু একই output; README এর পাঁচটা experiment ই চালানো হয়েছে, সংখ্যা README তে। এগুলো আসল broker না — তাদের মূল নিয়মের নকল। Broker এর নিজের crash আর replication, network, disk, Kafka এর rebalance, Redis Streams এর pending entry claim — এসব নেই; আর pub/sub এর buffer সীমা এখানে message সংখ্যায়, Redis এ bytes এ।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** চালানোর **আগে** `crash` আর `ordering` এর table এর প্রতিটা ঘর অনুমান করে লেখো (কোনটা শূন্য, কোনটা বড়)। তারপর চালিয়ে মেলাও। কোন ঘরটা ভুল হয়েছিল, আর কোন নিয়মটা ভুল বুঝেছিলে?

2. **Duplicate এর জানালা:** `crash` এ log এর duplicate ১১০ কেন — হাতে একটা মোটামুটি হিসাব করো (search service এ কত ঘটনা/সেকেন্ড আসে, commit কত পর পর)। তারপর `COMMIT_MS=1000` দিয়ে চালিয়ে (experiment ১) তোমার হিসাব মেলাও। Commit কে প্রতি message এ করলেও কেন শূন্য হবে না?

3. **Pub/Sub কে queue বানানোর চেষ্টা** (experiment ২): `BUFFER_LIMIT=100000 npm run slow`। হারানো শূন্য হলো — তাহলে কি এখন Redis Pub/Sub টেকসই? `crash` এর pub/sub সারিটা এখন বদলাবে কি? কেন না?

4. **Partition আর ক্রম** (experiment ৩ আর ৪): `PARTITIONS=8` আর `PARTITIONS=1` দিয়ে `ordering` চালাও। তিনটা সংখ্যা (ক্রম ভাঙা, দেরি p99, কাজ পাওয়া consumer) এর একটা ছোট table বানাও — partition ১, ৪, ৮ এর জন্য। এই table থেকে TaskFlow এর `task-events` topic এর partition সংখ্যা কত বাছবে, আর কেন?

5. **Design অংশ:** TaskFlow এর messaging এর এক পাতার design doc — CTO এর চাওয়া পাতাটা। (ক) TaskFlow এর সব message এর তালিকা (অন্তত ৮টা: assign email, mention email, password reset, export, thumbnail, `comment.created`, `task.completed`, typing indicator…) — প্রতিটাকে "কাজ" বা "খবর" চিহ্ন দাও। (খ) প্রতিটার জন্য: model (queue / pub/sub / log), tool, কে কে consumer, key (ক্রম লাগলে), retention (লাগলে), ack/commit নীতি। (গ) মঙ্গলবার আর বৃহস্পতিবারের দুটো incident আর পরের মাসের search-v2 — তোমার design এ প্রতিটা কোথায় আটকায়, দেখাও। (ঘ) Kafka নেবে কিনা — এক প্যারাগ্রাফে, TaskFlow এর আকার আর team এর কথা মাথায় রেখে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (সম্পূর্ণ, exit challenge সহ), 7.1
Current: 7.2 — Message Queue vs Pub/Sub: RabbitMQ, Kafka, Redis Streams
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; messaging design: "কাজ" (email, export, thumbnail) → queue
semantics, BullMQ on Redis (7.3 এ বানানো হবে); "খবর" (comment.created, task.completed) →
log semantics, Redis Streams, consumer group প্রতি service, key = taskId; typing/presence →
Redis Pub/Sub; সব consumer at-least-once (idempotency বাকি — 7.4)
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 7.3 — BullMQ hands-on: Express এ background job processing
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের duplicate এর হিসাব আর ৫ নম্বরের design doc। রেডি হলে `next` লিখো — Lesson 7.3 এ যাব: **BullMQ hands-on — Express এ background job processing।** আজ আমরা নিয়মগুলো simulation এ দেখেছি; এবার আসল জিনিস। 7.1 এর assign email কে Redis এর উপর BullMQ queue তে সরাব — আলাদা worker process, retry আর delay সহ — আর তারপর 7.1 এর সেই experiment আবার চালাব: ধীর phase এর মাঝখানে API process কে `SIGKILL`। এবার ১০৩টা email এর কী হয়? সাথে BullMQ এর ভেতরে একটা job কীভাবে "waiting" থেকে "active" থেকে "completed" বা "failed" হয় — আর worker মরলে "stalled" job এর কী হয় — আজকের ack এর প্রশ্নের একটা বাস্তব উত্তর।
