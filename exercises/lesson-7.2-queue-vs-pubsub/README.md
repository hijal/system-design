# TaskFlow Messaging Lab — Queue, Pub/Sub আর Log: কে পায়, কতক্ষণ থাকে, কোন ক্রমে

> Lesson 7.2 — Message Queue vs Pub/Sub · **Tier 1 — Runnable Code** (deterministic simulation)

## কী বানাচ্ছি

তিন ধরনের message broker এর মূল আচরণ, একই TaskFlow ঘটনার ধারার উপর — আর পাঁচটা পরিস্থিতি যেখানে
তাদের পার্থক্য সংখ্যায় দেখা যায়:

| Broker (`brokers.ts`) | কার মতো               | মূল নিয়ম                                                                                      |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `runPubSub`           | Redis Pub/Sub         | এই মুহূর্তে যে connected, সে পায়; কিছু জমা থাকে না; ধীর subscriber এর buffer উপচালে কেটে দেয় |
| `runQueue`            | RabbitMQ এর queue     | Message জমা থাকে; প্রতিটা একজন consumer পায় (round-robin); ack এ মুছে যায়, ack না এলে ফেরে   |
| `runLog`              | Kafka / Redis Streams | Append-only log, partition, consumer group; পড়লে মোছে না — group নিজের offset রাখে            |

| Script             | পরিস্থিতি                                                   | Lesson § |
| ------------------ | ----------------------------------------------------------- | -------- |
| `npm run fanout`   | email, search, analytics — তিনজনেরই প্রতিটা ঘটনা দরকার      | ১.২      |
| `npm run crash`    | search service ১০ সেকেন্ড বন্ধ (deploy)                     | ১.৩      |
| `npm run slow`     | analytics ঘটনা আসার গতির চেয়ে ধীরে প্রক্রিয়া করে          | ১.৩      |
| `npm run replay`   | নতুন service এসে পুরনো সব ঘটনা চায় (index নতুন করে বানাতে) | ১.৪      |
| `npm run ordering` | একই task এর ঘটনা ক্রমে প্রক্রিয়া হতে হবে                   | ১.৫      |
| `npm run all`      | সবগুলো                                                      | —        |

**কেন simulation?** প্রশ্নগুলো "message কে পায়, কখন, কয়বার" — আর deploy, ধীর consumer, দেরিতে আসা
service সব নিয়ন্ত্রিতভাবে, হুবহু একই ভাবে বারবার ঘটাতে simulation সবচেয়ে সৎ উপায়। সময় "লাফায়"
(পরের event এ), তাই দুই মিনিটের TaskFlow এক সেকেন্ডের কম সময়ে চলে।

**কী নেই (সৎ নোট):** এগুলো আসল broker না, তাদের **নিয়মের** ছোট নকল। নেই: broker এর নিজের crash আর
replication (RabbitMQ এর quorum queue, Kafka এর replica), network এর দেরি, disk, message এর আকার,
exchange এর routing key/topic pattern, Kafka এর rebalance, Redis Streams এর pending entry claim। প্রতিটা
ঘটনার প্রক্রিয়ার সময় একটা seed দেওয়া সংখ্যা, সব broker এ একই (তুলনা সৎ রাখতে)। Pub/Sub এর buffer সীমা
এখানে "১০০টা message" — Redis এর আসল সীমা bytes এ (`client-output-buffer-limit pubsub`, default
`32mb 8mb 60`, version ভেদে বদলাতে পারে)।

## Prerequisite

Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run all
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

Deterministic — তোমার মেশিনেও হুবহু এই সংখ্যা আসবে (`SEED=7`, default)।

**১. `npm run fanout`**

```
   broker                           email got   search got   analytics got
   queue — one shared queue               40%          40%             20%
   queue — one queue per service         100%         100%            100%
   pub/sub                               100%         100%            100%
   log — one group per service           100%         100%            100%
```

**২. `npm run crash`**

```
   broker                           lost  processed twice  delay p99  delay max
   pub/sub                           193                0      36 ms      43 ms
   queue (ack per message)             0                0      9.6 s      9.8 s
   log (commit every 5.0 s)            0              110     10.6 s     11.0 s
   log (commit every 100 ms)           0                2      9.6 s      9.8 s
```

**৩. `npm run slow`**

```
   broker      analytics lost    backlog (max)  analytics delay max  email delay p99
   pubsub                 367              101                6.0 s           171 ms
   queue                    0              375               32.1 s           199 ms
   log                      0              334               27.7 s           271 ms
```

**৪. `npm run replay`**

```
   broker                  earlier events     later events
   pub/sub                       0 / 1069        551 / 551
   queue                         0 / 1069        551 / 551
   log (retention 7 days)     1069 / 1069        551 / 551
   log (retention 30 s)        566 / 1069        551 / 551
```

**৫. `npm run ordering`**

```
   broker                      tasks out of order  delay p50  delay p99  delay max   consumers with work
   queue, 4 worker                             11      76 ms      3.0 s      3.1 s   4
   log, key = task, 4 partition                 0      94 ms      4.8 s      7.0 s   4
   log, key = random, 4 partition              69      97 ms      4.2 s      4.7 s   4
   log, key = task, 8 consumer                  0      94 ms      4.8 s      7.0 s   4 (4 idle)
```

## কী দেখার জন্য এটা বানানো

- **fanout এর প্রথম সারি:** একটা queue তে তিনটা service এর worker মানে প্রতিটা message **একজন** পায় —
  ৫টা worker এর মধ্যে round-robin, তাই ৪০/৪০/২০। Queue এর নিয়ম "প্রতিটা কাজ একবার", আর এখানে সেটাই ভুল।
- **crash এর "হারাল" আর "দুবার" কলাম পাশাপাশি:** pub/sub এ দেরি নেই কারণ যা বন্ধ থাকার সময় এসেছিল
  সেটা আর নেই (১৯৩টা)। Queue আর log কিছু হারায় না — কিন্তু log ফিরে আসে **শেষ commit** থেকে, তাই তার
  পরে যা প্রক্রিয়া হয়েছিল তা আবার হয় (১১০টা)। কেউ "ঠিক একবার" দেয় না। (হিসাব মেলাতে: শেষ commit ছিল
  15 s এ, আর 15–20 s এর মধ্যে ঠিক ১১০টা ঘটনা এসেছিল; pub/sub এর ১৯৩ হলো 20–30 s এর ঘটনার সংখ্যা।)
- **slow এর "email দেরি p99":** তিনটাতেই email অক্ষত — ধীর analytics অন্যদের টেনে নামায় না। পার্থক্য
  ধীর জনের নিজের: pub/sub তাকে কেটে দিয়ে ফেলে দেয় (৩৬৭টা), queue broker এ জমা করে (৩৭৫), log শুধু একটা
  দূরত্ব রাখে (lag ৩৩৪, log এ তো সব এমনিতেই থাকে)।
- **replay:** শুধু log পেছনে যেতে পারে — আর সেটাও retention এর সীমা পর্যন্ত (৩০ সেকেন্ডে ৫৬৬টা)।
- **ordering:** key = task হলে ক্রম ভাঙা **০** — কিন্তু দেরি max ৭ সেকেন্ড, queue এর ৩.১ এর দ্বিগুণের
  বেশি। একটা ৩ সেকেন্ডের ধীর message তার partition এর পেছনের সবাইকে আটকে রাখে (head-of-line
  blocking)। Queue এ অন্য worker রা এগিয়ে যায় — তাই দ্রুত, কিন্তু ক্রম ভাঙে (১১টা task)। আর ৮টা
  consumer দিলেও ৪টা partition এ কাজ পায় ৪ জন।

**একটা ছোট জিনিস যেটা চোখে পড়তে পারে:** slow এ queue এর জমা (৩৭৫) log এর চেয়ে (৩৩৪) বেশি। কারণ queue
তে প্রতিটা worker একটা message শেষ করে ack পাঠায়, তারপর পরেরটা পায় (prefetch = 1) — ack এর যাওয়া-আসার
৫ ms প্রতিটা message এ যোগ হয়। বাস্তবেও RabbitMQ এ prefetch ১ রাখলে throughput কমে; সাধারণত বড় রাখা হয়।
আর log এ email এর p99 সামান্য বেশি (২৭১ ms) কারণ ২টা consumer এর প্রতিজন নিজের ২টা partition এ বাঁধা —
একজন ব্যস্ত থাকলে অন্যজন তার partition এর কাজ নিতে পারে না।

## নিজে ভেঙে দেখো (Experiments)

1. **Commit এর ব্যবধান:** `COMMIT_MS=1000 npm run crash`। দুবার প্রক্রিয়া কত হলো? (১৮।) Commit ঘনঘন
   করলে duplicate কমে — কিন্তু শূন্য হয় না, আর প্রতিটা commit broker এ একটা লেখা। Duplicate কে
   নিরাপদ বানানোর আসল উপায় Lesson 7.4 এ।
2. **Pub/Sub এর buffer অসীম করো:** `BUFFER_LIMIT=100000 npm run slow`। Pub/sub এর হারানো শূন্য হলো,
   জমা ৩৩৩। তাহলে কি pub/sub এখন queue এর মতো? কোথায় জমা হচ্ছে, আর Redis restart হলে বা analytics এর
   connection ছিঁড়ে গেলে সেগুলোর কী হবে?
3. **Partition বাড়াও:** `PARTITIONS=8 npm run ordering`। ৮ consumer এর সারিতে এবার ৮ জনই কাজ পায় — দেরি
   p99 ৪.৮ থেকে ৩.০ সেকেন্ডে নামে, ক্রম ভাঙা তবু ০। কেন?
4. **সব কিছুর একটাই ক্রম চাইলে:** `PARTITIONS=1 npm run ordering`। ক্রম ভাঙা ০ — আর দেরি p99 ~৫২
   সেকেন্ড। একটা partition মানে একজন consumer; তার গতি আসার গতির চেয়ে কম হলে কী হয়, সেটা Lesson 7.1
   এর backlog।
5. **অন্য seed:** `SEED=11 npm run all`। সংখ্যা বদলায়, আকৃতি একই থাকার কথা — মিলিয়ে দেখো।

## Project Structure

```
lesson-7.2-queue-vs-pubsub/
├── package.json
├── tsconfig.json       # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── random.ts       # seed দেওয়া random (mulberry32), percentile
    ├── sim.ts          # ছোট discrete-event simulator — সময় পরের event এ লাফায়
    ├── workload.ts     # TaskFlow এর ঘটনা: created → assigned → comment… → completed, task প্রতি ক্রম সহ
    ├── model.ts        # ServiceSpec, Outage, আর Recorder — কে কী পেল, কয়বার, কোন ক্রমে, কত দেরিতে
    ├── brokers.ts      # runPubSub, runQueue, runLog
    └── main.ts         # পাঁচটা পরিস্থিতি আর তাদের table
```
