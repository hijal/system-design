# Lesson 8.1 — Object / Blob Storage (S3-style): কীভাবে কাজ করে, কখন লাগে

**Module 8 — Storage Systems**

> **Spaced Repetition (Lesson 1.6):** একটা Express instance কে "stateless" বলি কখন — আর কেন horizontal scaling এর জন্য সেটা শর্ত? এখন ধরো user এর upload করা file সেই instance এর নিজের `/uploads` folder এ রাখছ। সেটা কি এখনো stateless? আজ মেপে দেখবে।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.6 (Stateless), Lesson 3.4 (Sticky session), Lesson 5.3 (WAL), Lesson 5.5 (Lost update), Lesson 5.7 (Replication), Lesson 7.1 (Cascading failure), Lesson 7.5 (Dual write)

**তুমি এই lesson শেষে পারবে:**

1. File কোথায় রাখবে — database, app server এর disk, নাকি object storage — মাপা সংখ্যা দিয়ে বলতে পারবে, আর প্রতিটার দাম কোথায় গিয়ে পড়ে (WAL, backup, replica, stateless, app এর event loop) দেখাতে পারবে
2. একটা object store ভেতরে কীভাবে কাজ করে — metadata আর bytes আলাদা, replication বনাম erasure coding, failure domain — whiteboard এ আঁকতে আর "১১ nines" দাবির মানে আর সীমা ব্যাখ্যা করতে পারবে
3. Object storage এর API এর নিয়মগুলো (পুরো object লেখা, flat namespace, consistency, conditional write, versioning, storage class) মেনে TaskFlow এর attachment এর design করতে পারবে — key, metadata table, দুই জায়গায় লেখার ক্রম আর খরচ সহ

**Tier:** 1 — Runnable Code (Docker এ Postgres আর SeaweedFS — একটা S3-compatible object store; আর একটা seed দেওয়া durability simulation)

---

## ০. TaskFlow এখন কোথায়

Module 7 শেষে TaskFlow এর data মানে ছোট ছোট জিনিস: row, event, job — কয়েকশো byte করে। কিন্তু ছয় মাস আগে একটা hackathon এ attachment feature এসেছিল: task এ file জোড়া — screenshot, spec এর PDF, design এর file। বানানো হয়েছিল সবচেয়ে সরল পথে, একটা Sequelize model এ:

```typescript
class Attachment extends Model<InferAttributes<Attachment>, InferCreationAttributes<Attachment>> {
	declare id: CreationOptional<number>;
	declare taskId: number;
	declare fileName: string;
	declare contentType: string;
	declare data: Buffer; // DataTypes.BLOB → bytea in Postgres — the file itself lives inside the row
}
```

যুক্তিটা শুনতে ভালো ছিল: "সব এক জায়গায়, একই transaction, একই backup।" ছয় মাস পরে তিনটা ঘটনা:

1. **রাতের backup** ৬ মিনিট থেকে আড়াই ঘণ্টায় উঠেছে। Quarter এর restore drill এ database ফেরাতে লাগল ৫ ঘণ্টা — অথচ TaskFlow এর RTO এক ঘণ্টা (Lesson 1.5)। Database এর আসল data — task, comment, user — এর আকার এই ছয় মাসে প্রায় বদলায়নি।
2. **Replica lag এর alert**, প্রতিবার যখন একটা design agency একসাথে কয়েকশো MB এর file upload করে। Lesson 5.7 এর replica গুলো পিছিয়ে পড়ে, আর Lesson 6.3 এর version token এর কারণে সেই মুহূর্তে অনেক read primary তে চলে যায়।
3. **Review meeting এর সকাল:** একটা team একসাথে তাদের সপ্তাহের সব attachment খুলছে — আর সেই দশ মিনিট সবার task board ধীর। Database এর CPU স্বাভাবিক।

একজন team lead প্রস্তাব দিল: "file database থেকে বের করে প্রতিটা instance এর disk এ রাখি, `/var/taskflow/uploads` এ।" Staging এ চেষ্টা করা হলো। প্রথম দিনেই bug report: "upload করলাম, খুললে অর্ধেক সময় 'file not found'।" আর রাতে staging এর autoscaling একটা instance সরাল — সকালে সেই instance এর সব file নেই।

CTO এর উত্তর এক লাইনের: "S3 এ রাখো।" কিন্তু S3 আসলে কী জিনিস, file system থেকে কীভাবে আলাদা, কী প্রতিশ্রুতি দেয় আর কী দেয় **না** — আজ সেটা, সংখ্যা সহ।

---

## ১. Theory

### ১.১ তিন রকম storage — block, file, object

"Storage" বললে তিনটা খুব আলাদা জিনিস বোঝায়:

- **Block storage** — একটা কাঁচা disk: নির্দিষ্ট আকারের block, যেকোনো জায়গায় পড়া-লেখা। একটা machine এ attach হয়, উপরে একটা file system বা database বসে। (AWS EBS, একটা server এর SSD।) Postgres এর data এখানে থাকে।
- **File storage** — folder, file, path, permission; যেকোনো file এর মাঝখানে লেখা, append, rename। একটা machine এর নিজের, বা network এ কয়েকটা machine এর ভাগ করা (NFS, AWS EFS)।
- **Object storage** — আজকের বিষয়।

**Object storage** — data কে **object** হিসেবে রাখা: প্রতিটা object হলো কিছু byte, তার সাথে কিছু metadata, আর একটা key; object গুলো থাকে **bucket** এ, আর তাদের পড়া-লেখা হয় HTTP API দিয়ে (PUT, GET, DELETE, LIST) — সবসময় পুরো object ধরে, মাঝখানে বদলানো যায় না।

```
   block storage                  file storage                     object storage
   ─────────────                  ────────────                     ──────────────
   [blk 0][blk 1][blk 2] …        /uploads/                         bucket: taskflow-attachments
   যেকোনো block পড়ো/লেখো          ├── ws-12/                          key: ws/12/att/7f3a…   → bytes + metadata
   এক machine এ attach            │   └── spec.pdf  (মাঝখানে লেখা ✓)  key: ws/12/att/91bc…   → bytes + metadata
   উপরে file system/database      └── ws-40/ …      (rename ✓)       HTTP: PUT / GET / DELETE / LIST
                                                                    পুরো object, কোনো rename নেই
```

প্রশ্ন হলো, এত সীমা নিয়ে object storage কেন? কারণ ঠিক এই সীমাগুলোর বদলে সে এমন তিনটা জিনিস দেয় যা বাকি দুটো সহজে দেয় না: প্রায় সীমাহীন আকার (একটা bucket এ কোটি কোটি object), খুব উঁচু durability (১.৫), আর এমন দাম যেটা database এর disk এর চেয়ে কয়েক গুণ কম (১.৭)। আর HTTP API মানে যেকোনো machine, যেকোনো instance, এমনকি সরাসরি browser — সবাই একই জায়গায় পৌঁছায়।

### ১.২ Database এ file — দামটা কোথায় পড়ে

প্রথম প্রশ্ন: TaskFlow এর hackathon এর পথটা আসলে কতটা খারাপ? Exercise এর `npm run where` একই ২০০টা file (মোট ৩১৫ MB; বেশিরভাগ ছোট, কয়েকটা ১০ MB পর্যন্ত) দুই জায়গায় রাখে — Postgres এর `bytea` column এ, আর object storage এ (database এ শুধু একটা metadata row):

```
── 1. Storing (4 uploads at a time) ─────────────────────────────
   where                               time         WAL         DB growth    object storage
   Postgres (bytea)                  1.14 s    336.9 MB          327.2 MB                 —
   object storage + metadata row     1.69 s       49 KB             80 KB          314.5 MB
   (for comparison: the whole tasks table of 200k tasks + indexes = 23.3 MB)

── 2. Backup (pg_dump -Fc, inside the container) ─────────────────
   database with files                   361.1 MB    21.56 s
   without files (metadata only)           2.4 MB   399.8 ms
```

রাখার সময় প্রায় সমান — এখানে database কে দোষ দেওয়ার কিছু নেই। দামটা অন্য তিন জায়গায়:

- **WAL।** Lesson 5.3: Postgres প্রতিটা লেখা আগে WAL এ লেখে, তারপর table এ। ৩১৫ MB এর file মানে ৩৩৭ MB WAL (table এর নিজের overhead সহ) — আর Lesson 5.7 এর প্রতিটা replica ঠিক ততটা WAL পায় আর প্রয়োগ করে। TaskFlow এর ৩টা replica মানে একটা বড় upload এর জন্য network এ ১ GB, আর replica গুলো পিছিয়ে পড়ে — ঘটনা ২। Object storage এর পথে WAL ৪৯ KB: শুধু metadata row এর।
- **Database এর আকার।** ২ লাখ task এর পুরো table ২৩ MB; ২০০টা file ৩২৭ MB। বাস্তবে এই অনুপাত আরও বাজে হয় — file জমতেই থাকে, task এর row প্রায় একই থাকে। আর database এর disk সবচেয়ে দামি disk (দ্রুত SSD, আর primary + প্রতিটা replica তে একটা করে কপি)।
- **Backup আর restore।** File সহ backup ৩৬১ MB আর ২১ সেকেন্ড; file ছাড়া ২.৪ MB আর আধা সেকেন্ড — ৫০ গুণের বেশি। Restore ও একই অনুপাতে ধীর — ঘটনা ১ এর RTO। আর backup এর প্রায় সবটা এমন data যেটা কখনো বদলায় না (একটা upload করা PDF কেউ edit করে না) — অথচ প্রতি রাতে আবার পুরোটা।

**এবার ঘটনা ৩ — file দেওয়ার সময়।** Board এর query (৮ জন client) চলছে, আর তার সাথে ৮ জন file নামাচ্ছে:

```
── 3. Board queries while files are served (8 OLTP clients, pool max 10; 8 downloading files) ──
   step                                        OLTP q/s   OLTP p50   OLTP p99   file/s     MB/s   file p50 / p99
   OLTP only                                      14437     0.4 ms     0.8 ms        0        0   —
   + files, Postgres → through the app              350    20.9 ms    66.1 ms      192      289   27.9 ms / 170.8 ms
   + files, Postgres → separate process           14687     0.4 ms     0.8 ms      194      290   23.3 ms / 218.0 ms
   + files, object storage → direct               14968     0.4 ms     0.7 ms      348      516   17.5 ms / 91.6 ms
```

তৃতীয় সারিটা প্রথমে দেখো, কারণ এটা একটা সৎ অবাক করা ফল: Postgres নিজে file ভালোই দেয়। আলাদা একটা process থেকে প্রতি সেকেন্ডে ২৯০ MB নামালেও board এর p99 একই — ০.৮ ms। তাহলে দ্বিতীয় সারিতে board প্রতি সেকেন্ডে ১৪ হাজার থেকে **৩৫০** এ নামল কেন?

কারণ database HTTP বলে না। File database এ থাকলে user এর কাছে পৌঁছানোর একমাত্র পথ **app এর ভেতর দিয়ে**: app database থেকে পড়ে, তারপর user কে পাঠায়। আর তখন:

- প্রতিটা file এর পুরো সময় app এর pool এর একটা connection ধরা থাকে — ১০টার মধ্যে ৮টা file এর কাছে, board এর query লাইনে দাঁড়ায়। Lesson 7.1 এর cascading failure, হুবহু।
- প্রতিটা byte app এর event loop পার হয়। Postgres `bytea` পাঠায় hex text হিসেবে — প্রতি byte দুটো অক্ষর, দ্বিগুণ আকার — আর Node কে সেটা parse করে Buffer বানাতে হয়। CPU এর কাজ, event loop আটকায় (7.1 এর পার্শ্ব নোট)।

কোনটা বড়? Experiment ১: pool ২০ করলে (file এর জন্য যথেষ্ট জায়গা) board তবু ৩৭৪ q/s, p50 ২০ ms — তাই এখানে বড় অংশটা app এর event loop। আর experiment ২ ঠিক প্রমাণটা দেয়: object storage এর file ও যদি app নিজে নামিয়ে user কে দেয় (proxy), board ৪৮৬ q/s — database থেকে দেওয়ার প্রায় সমান। **শিক্ষাটা "database বনাম object storage" না — "app এর ভেতর দিয়ে বনাম সরাসরি"।** File database এ থাকলে সরাসরি দেওয়ার উপায়ই নেই; object storage এ আছে — browser বা CDN সরাসরি object storage থেকে নামায়, app কে ছোঁয় না (শেষ সারি; কীভাবে, সেটা Lesson 8.2 এর presigned URL)।

**TaskFlow এর stack এ একটা লুকানো ফাঁদ:** Sequelize default এ model এর **সব** attribute পড়ে। `Attachment.findAll({ where: { taskId } })` — task এর attachment এর তালিকা দেখাতে — প্রতিটা file এর পুরো bytes টেনে আনে। দশটা ৫ MB এর file মানে শুধু তালিকার জন্য ৫০ MB (hex এ ১০০ MB)। `attributes: { exclude: ['data'] }` ভুলে গেলেই — Lesson 5.6 এর hydration এর দাম, বড় আকারে।

**তাহলে database এ file কখনোই না?** সৎ উত্তর: ছোট আর কম হলে চলে। Postgres এর নিজের documentation ও `bytea` সমর্থন করে, আর একটা ছোট app এ কয়েক KB এর কিছু জিনিস (একটা ছোট icon, একটা signature এর ছবি) database এ রাখলে transaction আর backup একসাথে পাওয়ার সুবিধা বাস্তব। সমস্যা শুরু হয় যখন file বড়, অনেক, আর বাড়তেই থাকে — মানে প্রায় যেকোনো user-upload feature এ।

### ১.৩ App server এর disk এ — stateless ভেঙে যায়

Team lead এর প্রস্তাব: file প্রতিটা Express instance এর নিজের disk এ। Database এর সব সমস্যা যায় — কিন্তু spaced repetition এর প্রশ্নটা এখানে কামড় দেয়। Exercise এর `npm run stateless`: দুটো Express instance একটা load balancer এর পেছনে, ২০ জন user প্রত্যেকে ১০টা file upload করে; তারপর uploader নিজে আবার খোলে, একজন teammate খোলে, আর শেষে instance A বদলানো হয় (deploy, crash, autoscaling এর scale-in — নতুন container, খালি disk):

```
   where files live · load balancer   own reopen 404    teammate open 404     lost after replacing A
   local disk, round robin                       50%                  47%                  148 / 200
   local disk, sticky (per user)                  0%                  47%                  100 / 200
   object storage, round robin                    0%                   0%                    0 / 200
```

- **Round robin:** অর্ধেক সময় request অন্য instance এ যায়, যার disk এ file টা নেই — staging এর "অর্ধেক সময় file not found"।
- **Sticky session (Lesson 3.4):** একই user সবসময় একই instance এ — uploader আর 404 পায় না। কিন্তু teammate এর কলাম দেখো: **৪৭%**। Sticky session একজন **user** কে একটা instance এ বাঁধে, কিন্তু attachment একজনের না — একটা team এর। Teammate এর নিজের sticky instance আলাদা হতেই পারে।
- **Instance বদলানোর পরে:** local disk এ instance এর সাথে তার disk ও গেছে — ১০০টা file চিরকালের জন্য নেই, আর round robin এ বাকি ১০০টাও অর্ধেক সময় ভুল instance এ পৌঁছায় (তাই ১৪৮)। Sticky তে ঠিক সেই ১০০টা, যাদের uploader এর instance ছিল A।

Lesson 1.6 এর ভাষায়: file রাখা মাত্রই instance টা **stateful** হয়ে গেল — আর তার সাথে horizontal scaling এর প্রতিটা সুবিধা (যেকোনো instance যেকোনো request নেয়, instance আসে-যায়) ভাঙল। Object storage এর সারিতে দুটো instance একই bucket এ কথা বলে; instance গুলো আবার stateless, আর file এর জীবন instance এর জীবন থেকে আলাদা।

(মাঝামাঝি একটা পথ আছে: সব instance এ একটা ভাগ করা network file system — NFS, AWS EFS। Stateless ফেরে, আর code বদলাতে হয় না — এখনো `fs.writeFile`। দাম: দামি, file system এর প্রতিশ্রুতি network এ রাখা কঠিন (lock, rename, অনেক ছোট file এ ধীর), আর browser সরাসরি পৌঁছাতে পারে না — file তবু app এর ভেতর দিয়ে যায়, ১.২ এর সমস্যা।)

### ১.৪ Object store এর ভেতরে — metadata আর bytes আলাদা

একটা object store বাইরে থেকে সরল: key দাও, bytes পাও। ভেতরে কী আছে যাতে কোটি কোটি object আর পেটাবাইট data সামলানো যায়?

মূল নকশা প্রায় সবখানে একই: **কোথায় আছে** (metadata) আর **আসল bytes** আলাদা system এ।

```
                         ┌─────────────── API layer (stateless, অনেকগুলো) ──────────────┐
   client ── HTTP ──────►│  PUT /bucket/key  ·  GET  ·  LIST  ·  auth, checksum           │
                         └──────────┬───────────────────────────────────┬────────────────┘
                                    │ "এই key কোথায়?"                  │ bytes
                                    ▼                                   ▼
                  ┌───────── metadata index ─────────┐     ┌──────── storage nodes (হাজার হাজার disk) ───────┐
                  │ bucket + key → size, ETag,       │     │  [fragment][fragment][fragment] …                │
                  │   version, কোন node এ কোন        │     │  বড় বড় file এ অনেক object পাশাপাশি জুড়ে       │
                  │   fragment                       │     │  (একটা object = একটা file না)                   │
                  │ key এর range ধরে shard (5.8),     │     │  replication বা erasure coding (১.৫)             │
                  │ প্রতিটা shard replicated (6.2)    │     │  rack/AZ জুড়ে ছড়ানো                           │
                  └──────────────────────────────────┘     └─────────────────────────────────────────────────┘
```

এর পেছনের একটা বিখ্যাত কারণ আছে। Facebook এর 2010 এর paper "Finding a needle in Haystack: Facebook's photo storage" দেখায়: প্রতিটা ছবি একটা আলাদা file হলে, একটা ছবি পড়তে file system কে আগে তার metadata (directory, inode) খুঁজতে কয়েকবার disk এ যেতে হতো — আর কোটি কোটি ছোট file এ সেই metadata আর memory তে ধরে না। সমাধান: অনেক ছবি একটা বিশাল file এ পাশাপাশি জুড়ে দাও, আর "কোন ছবি কোন file এর কোন offset এ" এর ছোট একটা index memory তে রাখো — তাহলে একটা ছবি = একবার disk এ যাওয়া। Exercise এর SeaweedFS ঠিক এই ধারণা থেকে বানানো: তার **master** জানে কোন volume কোথায়, **volume server** গুলো বড় বড় volume file এ অনেক object এর bytes রাখে।

এই ভাগ থেকে তিনটা জিনিস বোঝা যায় যেগুলো API তে দেখা যায়:

- **Metadata index টা একটা বিশাল key-value database** — key এর range ধরে shard করা (Lesson 5.8), প্রতিটা shard replicated আর consensus দিয়ে সমন্বিত (Lesson 6.2)। "LIST এই prefix এর সব object" হলো এই index এ একটা range scan — তাই LIST সস্তা, কিন্তু "সব object এর মোট আকার" এর মতো প্রশ্ন আসলে সব গুনে দেখা।
- **"Folder" বলে কিছু নেই।** Index এ শুধু পূর্ণ key: `ws/12/att/7f3a…`। `/` একটা সাধারণ অক্ষর। (১.৬)
- **Bytes বদলানো যায় না, শুধু নতুন করে লেখা যায়।** Object এর bytes একটা বড় file এর মাঝখানে বা কয়েকটা disk এ ভাগ হয়ে বসানো — "এই offset এ ৩ byte লেখো" মানে সবকিছু আবার বানানো। তাই নিয়মটাই: PUT মানে পুরো object, নতুন করে। (১.৬)

**Bucket আর key** — bucket হলো object রাখার একটা নামযুক্ত পাত্র (যার উপর permission, versioning, lifecycle এর নিয়ম বসে); তার ভেতরে প্রতিটা object এর একটা অনন্য **key** — একটা string, যেটা path এর মতো দেখতে হলেও আসলে শুধু একটা নাম; key এর শুরুর অংশকে **prefix** বলে।

**Object metadata** — object এর bytes এর সাথে রাখা ছোট তথ্য: আকার, `Content-Type`, `Content-Disposition` (download এ কী নাম দেখাবে), **ETag** (object এর content এর একটা fingerprint — সাধারণ একবারের PUT এ সাধারণত content এর MD5, কিন্তু multipart upload বা কিছু encryption এ না), আর নিজের দেওয়া key-value (`x-amz-meta-task-id: 42`)। Metadata পাওয়া যায় `HEAD` দিয়ে, bytes না নামিয়েই।

### ১.৫ Durability — কপি, erasure coding, আর failure domain

Lesson 1.5 এ availability শিখেছিলাম: এই মুহূর্তে উত্তর পাওয়া যায় কিনা। Object storage এর সবচেয়ে বড় দাবি অন্য একটা জিনিস নিয়ে।

**Durability** — একবার সফলভাবে লেখা data একটা নির্দিষ্ট সময়ে (সাধারণত এক বছরে) **হারিয়ে না যাওয়ার** সম্ভাবনা; availability থেকে আলাদা — একটা object কিছুক্ষণ পড়া না গেলেও (unavailable) হারায়নি।

AWS বলে S3 Standard এর durability এর design লক্ষ্য **99.999999999%** — "১১ nines"। মানে ১০০০ কোটি object রাখলে গড়ে বছরে একটা হারানোর আশা। তুলনায় তার availability এর লক্ষ্য 99.99% (আর SLA 99.9%) — অনেক কম nines। দুটো আলাদা প্রশ্ন, আলাদা উত্তর।

এত nines কোথা থেকে? একটা disk বছরে কয়েক শতাংশ সম্ভাবনায় মরে (Backblaze এর মতো কোম্পানির প্রকাশ করা disk এর পরিসংখ্যানে বছরে ১–২% এর আশেপাশে সাধারণ)। প্রথম উত্তর — কপি রাখো। দ্বিতীয় উত্তর, আরও চতুর:

**Erasure coding** — একটা object কে k টা data fragment এ ভাগ করে তা থেকে m টা বাড়তি parity fragment গণনা করা, আর k + m টা fragment আলাদা আলাদা disk এ রাখা; যেকোনো k টা fragment থেকে পুরো object আবার বানানো যায় — তাই m টা disk মরা সহ্য করে, মাত্র (k + m) ÷ k গুণ জায়গায়।

(গণিতটা Reed–Solomon code — CD আর QR code এর ভুল সারানো যেটা দিয়ে হয়। RAID 6 এর ধারণাও একই। আমাদের জানা দরকার শুধু ফলাফল: "যেকোনো k টা যথেষ্ট"।)

Exercise এর `npm run durability`, অংশ ক — একটা সরল model: disk গুলো স্বাধীনভাবে বছরে ২% হারে মরে, আর মরা disk এর data অন্য disk এ আবার বানাতে ২৪ ঘণ্টা লাগে। একটা object হারায় যদি তার কোনো disk মরার পরে মেরামত শেষের আগে আরও m টা মরে:

```
── A. Calculation (AFR 2%, 24 hours to repair, disks die independently) ──
   scheme          disk for 1 TB   survives     annual loss chance   durability        lost/yr of 1B objects
   1 copy                1.00 TB    0 disks                 2.0e-2    1.7 nines                     20000000
   2 copies              2.00 TB     1 disk                 2.2e-6    5.7 nines                         2192
   3 copies              3.00 TB    2 disks                1.8e-10    9.7 nines                          0.2
   EC 4+2                1.50 TB    2 disks                 3.6e-9    8.4 nines                            4
   EC 6+3                1.50 TB    3 disks                1.7e-12   11.8 nines                        0.002
   EC 10+4               1.40 TB    4 disks                1.8e-15   14.7 nines                     0.000002
```

- **৩ কপি বনাম EC 6+3:** EC অর্ধেক disk এ (১.৫ TB বনাম ৩ TB) বেশি durability দেয় — কারণ এক কপি না, তিনটা disk মরা সহ্য করে। Petabyte এর আকারে "অর্ধেক disk" মানে কোটি টাকা। তাই বড় object store গুলো প্রায় সবাই erasure coding ব্যবহার করে (যেমন Facebook এর f4 system, 2014 এর paper এ, Reed–Solomon 10+4)।
- **EC 4+2 বনাম ৩ কপি:** দুটোই দুটো disk সহ্য করে, কিন্তু EC 4+2 এর nines কম — কারণ তার ৬টা disk, আর যত বেশি disk তত বেশি সম্ভাবনা যে কোনোটা মরবে। "কয়টা সহ্য করে" একা যথেষ্ট না; মোট কয়টা disk এর উপর নির্ভর করে, সেটাও।
- **দাম কোথায়?** Erasure coding এর দাম CPU আর network: লেখায় parity গণনা, আর একটা disk মরলে তার fragment আবার বানাতে k টা অন্য disk থেকে পড়া। আর পড়া প্রায়ই কয়েকটা disk থেকে জুড়ে — ছোট object এ কপি সহজ। তাই অনেক system ছোট বা খুব ঘনঘন পড়া data কপিতে রাখে, বড় আর ঠান্ডা data erasure coding এ।

**মেরামতের গতিও nines এর অংশ।** Experiment ৩: মেরামতে এক সপ্তাহ লাগলে (বড় disk, ধীর rebuild) ৩ কপি ৯.৭ থেকে ৮.১ nines, EC 6+3 ১১.৮ থেকে ৯.২। দুর্বলতার জানালা যত লম্বা, দ্বিতীয় মৃত্যুর সম্ভাবনা তত বেশি। তাই বড় object store এ মেরামত নিজেই একটা বড় distributed কাজ — হাজার disk একসাথে একটা মরা disk এর data আবার বানায়।

এবার সবচেয়ে গুরুত্বপূর্ণ অংশ। উপরের model ধরে নিয়েছে disk গুলো **স্বাধীনভাবে** মরে। বাস্তবে একসাথে মরে: একটা rack এর power যায়, একটা switch বন্ধ হয়, একটা data center এ আগুন।

**Failure domain** — এমন একটা একক (disk, server, rack, power এর লাইন, availability zone, region) যার ভেতরের সবকিছু একটা ঘটনাতেই একসাথে ব্যর্থ হতে পারে।

অংশ খ — ১০টা rack × ১২টা disk, ১ লাখ object; fragment গুলো rack না ভেবে এলোমেলো disk এ বসানো, বনাম প্রতিটা fragment আলাদা rack এ; তারপর পুরো rack বন্ধ:

```
── B. Failure domain (10 racks × 12 disks, 100,000 objects) ──
   scheme · where the fragments are     unreadable when down:   1 rack  2 racks  3 racks
   3 copies · random disks                                        89      718    2,541
   3 copies · each on a different rack                             0        0      860
   EC 6+3 · random disks                                         611    8,021   26,556
   EC 6+3 · each on a different rack                               0        0        0
```

- **EC 6+3, এলোমেলো:** একটা rack বন্ধ হলেই ৬১১টা object পড়া যায় না — ৩ কপির চেয়েও **বেশি**। ৯টা fragment এলোমেলো বসালে একই rack এ চারটা পড়ার সম্ভাবনা কম না। অংশ ক এর ১১.৮ nines এখানে অর্থহীন — সংখ্যাটা ধরে নিয়েছিল disk স্বাধীন।
- **EC 6+3, আলাদা rack এ:** তিনটা rack একসাথে বন্ধ হলেও একটাও না। Erasure coding এর শক্তি আসে **failure domain জুড়ে ছড়ানো** থেকে।
- আর তাই EC এর দরকার অনেক failure domain: ৯টা fragment আলাদা রাখতে অন্তত ৯টা rack (experiment ৩ এর `RACKS=4` এ এই সারিটা সম্ভবই না)। বড় আকারে একই যুক্তি availability zone এ: S3 Standard তার data একটা region এর কয়েকটা AZ জুড়ে রাখে — একটা পুরো data center গেলেও data থাকে।

**"১১ nines" দাবির সৎ পাঠ:**

1. এটা একটা **design লক্ষ্য**, মাপা নিশ্চয়তা না — এত ছোট সম্ভাবনা মাপার মতো ঘটনা ঘটেই না। Model এর অনুমানগুলো (স্বাধীন ব্যর্থতা, মেরামতের সময়) যত বাস্তব, সংখ্যা তত অর্থপূর্ণ।
2. এটা **hardware** থেকে রক্ষা করে — তোমার নিজের ভুল থেকে না। তোমার code এর একটা bug বা একজন engineer এর একটা ভুল command যদি `DELETE` পাঠায়, object store খুব durably সেটা মুছে দেবে। বাস্তবে data হারানোর সবচেয়ে বড় কারণ এটাই — আর তার উত্তর versioning (১.৬), object lock, আর আলাদা account বা region এ কপি।

### ১.৬ API এর নিয়ম — এটা file system না

Exercise এর `npm run inspect` সাতটা ছোট পরীক্ষা চালায়, SeaweedFS এর উপর, S3 API দিয়ে। প্রতিটা একটা নিয়ম, যেটা file system এর অভ্যাস থেকে এলে ভুল করায়।

**১. লেখার পরেই পড়া।** একই key তে ২০০ বার overwrite, প্রতিবার সাথে সাথে GET:

```
   old value returned: 0 / 200
```

AWS S3 ডিসেম্বর 2020 থেকে সব PUT, DELETE আর LIST এ **strong read-after-write consistency** দেয় — সফল PUT এর পরে যেকোনো GET নতুনটাই পায় (Lesson 6.5 এর ভাষায় একটা object এর জন্য linearizable এর কাছাকাছি)। এর আগে overwrite আর delete এ eventual ছিল — আর পুরনো অনেক blog আর Stack Overflow উত্তর এখনো সেটাই বলে। অন্য S3-compatible system এ (বা cross-region replication এর কপিতে) নিয়ম আলাদা হতে পারে — "S3-compatible" মানে API এক, প্রতিশ্রুতি এক না। দাবি না, documentation আর পরীক্ষা (6.5 এর Jepsen এর শিক্ষা)।

**২. "Folder" আসলে prefix।**

```
   LIST Prefix='workspaces/12/' Delimiter='/':
     object  workspaces/12/avatar.png
     "folder" workspaces/12/tasks/   ← not a real thing, just keys that match
   workspaces/12/ → workspaces/99/ "rename": 9 requests (1 LIST + COPY + DELETE per object)
```

`Delimiter` দিয়ে LIST করলে API নিজেই key গুলো `/` এ ভাগ করে "folder" এর মতো দেখায় (`CommonPrefixes`) — কিন্তু index এ কোনো folder নেই। তাই "folder এর নাম বদলাও" একটা operation না — প্রতিটা object আলাদা করে copy আর delete: এখানে ৪টা object এ ৯টা request, দশ লাখ object এ বিশ লাখ। Design এর শিক্ষা: **এমন কিছু key এ রেখো না যেটা বদলাতে পারে** (user এর দেওয়া file এর নাম, task এর title) — ১.৮ এ।

**৩. লেখা পুরো object, পড়া আংশিক হতে পারে।**

```
   to change 1 byte, had to send: 8,388,608 bytes (the whole 8 MB)
   reading 1 KB from the middle returned: 1024 bytes · bytes 4194304-4195327/8388608 · matches: yes
```

Append নেই, "এই offset এ লেখো" নেই — ১.৪ এর ভেতরের গঠনের সরাসরি ফল। তাই object storage log file বা database এর data file রাখার জায়গা না (বারবার শেষে যোগ হয় এমন কিছু)। কিন্তু `Range` দিয়ে পড়া আংশিক হতে পারে — video এর মাঝখান থেকে চালানো, বড় file এর একটা অংশ, একটা download মাঝপথে থেমে গেলে বাকিটা। (বড় file লেখাকে টুকরো করার উপায় — multipart upload — Lesson 8.2।)

**৪ আর ৫. Metadata আর ETag।** `HEAD` দিয়ে আকার, `Content-Type`, `Content-Disposition` আর নিজের metadata — bytes ছাড়া। আর একবারে PUT করা object এ ETag = content এর MD5 — upload এর পরে client নিজের হিসাবের সাথে মিলিয়ে দেখতে পারে যে পুরোটা ঠিকঠাক পৌঁছেছে।

**৬. দুজন একসাথে লিখলে।** Task এর checklist একটা JSON object; Rahim আর Karim দুজনেই পড়ল, নিজের item যোগ করল, লিখল:

```
   unconditional:         ["draft","Karim: deploy"]   ← Rahim's item silently lost (last writer wins)
   If-Match (ETag):       Rahim wrote · Karim rejected (412 PreconditionFailed) · after re-reading, Karim wrote
                          ["draft","Rahim: review","Karim: deploy"]
   If-None-Match: * (on a key that already exists): rejected (412 PreconditionFailed)
```

Lesson 5.5 এর lost update, object storage এ। কোনো lock নেই — শেষ PUT জেতে। সমাধানও 5.5 এর optimistic concurrency এর মতো: **conditional write**। `If-Match: <পড়ার সময়ের ETag>` — "যা পড়েছিলাম সেটাই যদি এখনো থাকে, তবেই লেখো" (compare-and-swap); না মিললে `412`, আবার পড়ে চেষ্টা। `If-None-Match: *` — "শুধু না থাকলে তৈরি করো" — একই key তে দুটো upload এর দ্বিতীয়টা আটকায়। (AWS S3 এ এ দুটো এসেছে 2024 এ — তার আগে এই ধরনের সমন্বয়ের জন্য বাইরে একটা database বা lock লাগত। আবারও: তোমার system এ আছে কিনা যাচাই করো।)

তবে বাস্তবে এর সবচেয়ে ভালো উত্তর প্রায়ই অন্য: যে data একসাথে বদলায় (checklist), সেটা object storage এ না — database এ রাখো। Object storage ভালো **একবার লেখা, অনেকবার পড়া** জিনিসের জন্য।

**৭. Versioning।**

```
   PUT "version one" → PUT "version two" → DELETE
   versions present: 2 · delete markers: 1 · plain GET: 404
   the first version by VersionId: "version one" · GET after copying it back: "version one"
```

Bucket এ versioning চালু থাকলে overwrite পুরনো version মোছে না, আর DELETE আসলে একটা "delete marker" বসায় — সাধারণ GET এ 404, কিন্তু পুরনো version গুলো আছে, আর ফিরিয়ে আনা যায়। এটাই ১.৫ এর "নিজের ভুল থেকে রক্ষা" এর প্রথম স্তর। দাম: প্রতিটা version জায়গা নেয় আর বিল হয় — তাই সাথে একটা lifecycle rule লাগে (১.৭)।

### ১.৭ দাম, storage class আর lifecycle

Object storage এর বিল কয়েকটা আলাদা অংশে আসে, আর design এ প্রতিটার আলাদা প্রভাব। (নিচের সংখ্যা AWS us-east-1 এর লেখার সময়ের আনুমানিক তালিকা মূল্য — region আর সময় ভেদে বদলায়; হিসাবের আগে pricing page দেখো। আকৃতিটা আসল, দশমিক না।)

- **জায়গা:** S3 Standard ~$0.023 প্রতি GB-মাস। তুলনায় database এর SSD (EBS gp3) ~$0.08 প্রতি GB-মাস — আর সেটা primary আর প্রতিটা replica তে আলাদা করে।
- **Request:** PUT ~$0.005 আর GET ~$0.0004, প্রতি হাজারে। ছোট ছোট অনেক object এ এটাই বড় অংশ হতে পারে।
- **বাইরে পাঠানো (egress):** internet এ ~$0.09 প্রতি GB — প্রায়ই সবচেয়ে বড় আর সবচেয়ে অপ্রত্যাশিত অংশ। (CDN এর মাধ্যমে দেওয়া — Lesson 4.5, 8.2 — আর Lesson 10.7 এর cost এর প্রশ্ন।)

**Storage class আর lifecycle** — একই bucket এ object গুলো বিভিন্ন "শ্রেণি" তে রাখা যায়: ঘনঘন পড়া (Standard), কম পড়া (Infrequent Access — জায়গা সস্তা, কিন্তু পড়ার জন্য আলাদা ফি আর ন্যূনতম সময়), আর archive (Glacier-ধরনের — খুব সস্তা, কিন্তু ফেরত পেতে মিনিট থেকে ঘণ্টা); আর lifecycle rule দিয়ে বয়স ধরে object নিজে থেকেই এক শ্রেণি থেকে আরেকটায় সরে, বা মুছে যায়।

TaskFlow এর জন্য Lesson 1.3 এর মতো একটা হিসাব: ৫০ হাজার active user, প্রত্যেকে মাসে গড়ে ২০টা attachment, গড়ে ১.৫ MB:

```
  প্রতি মাসে নতুন:  50,000 × 20 × 1.5 MB  =  1.5 TB
  এক বছর পরে:      ~18 TB

  object storage (Standard):   18,000 GB × $0.023             ≈  $414 / মাস
  Postgres এ (primary + ৩ replica, SSD):
                               18,000 GB × 4 কপি × $0.08       ≈  $5,760 / মাস   (backup আলাদা)

  বাইরে পাঠানো: প্রতিটা file গড়ে ৫ বার খোলা হলে মাসে 7.5 TB × $0.09 ≈ $675 / মাস
                → CDN আর cache (8.2) — যে file বারবার খোলা হয়, সেটা object storage থেকে বারবার না
```

আর বেশিরভাগ attachment এর একটা পরিচিত জীবন: প্রথম সপ্তাহে অনেকবার খোলা, তারপর প্রায় কখনো না। Lifecycle rule এখানেই কাজের: ৯০ দিন পরে Infrequent Access এ; মুছে ফেলা workspace এর file ৩০ দিন পরে পুরোপুরি; versioning এর পুরনো version ৩০ দিন পরে মোছা।

### ১.৮ TaskFlow এর সিদ্ধান্ত

**Database এ শুধু metadata, bytes object storage এ।**

```typescript
class Attachment extends Model<InferAttributes<Attachment>, InferCreationAttributes<Attachment>> {
	declare id: CreationOptional<number>;
	declare taskId: number;
	declare workspaceId: number;
	declare fileName: string; // the user-given name — only for display, never in the key
	declare contentType: string;
	declare size: number;
	declare storageKey: string; // ws/{workspaceId}/att/{uuid} — once set, never changes
	declare etag: string;
	declare createdAt: CreationOptional<Date>;
}
```

**Key এর নিয়ম:** `ws/{workspaceId}/att/{uuid}`। User এর দেওয়া file এর নাম key এ না — দুটো `spec.pdf` এর সংঘাত, UI তে নাম বদলালে object সরানো (১.৬ এর copy + delete), আর user এর লেখা key এ বসানো মানে অদ্ভুত অক্ষর আর path এর কৌশল। আসল নাম থাকে database এ আর `Content-Disposition` এ। Workspace এর prefix আছে যাতে একটা workspace মুছে ফেলা (বা তার সব file export) একটা prefix এর LIST দিয়ে শুরু করা যায়। (অনেক পুরনো লেখায় S3 এর key এর শুরুতে এলোমেলো hash বসানোর পরামর্শ পাবে — load ভাগ করতে। AWS 2018 এ জানিয়েছে যে S3 এখন prefix প্রতি অনেক বেশি request নিজে থেকেই সামলায় — প্রতি prefix এ সেকেন্ডে অন্তত ৩,৫০০ লেখা আর ৫,৫০০ পড়া — তাই সেই পরামর্শ আর দরকার নেই।)

**আবার dual write — এবার কোন দিকে ভুল হবে, বেছে নাও।** একটা attachment মানে দুটো লেখা: object storage এ object, database এ row — Lesson 7.5 এর dual write, আর কোনো ভাগ করা transaction নেই। দুটো ক্রম:

```
  row আগে, তারপর object:   মাঝে crash → row আছে, object নেই → user তালিকায় file দেখে, খুললে 404   ✗ user এর চোখে
  object আগে, তারপর row:   মাঝে crash → object আছে, row নেই → কেউ দেখে না, শুধু জায়গার খরচ     ✓ চুপচাপ, সারানো যায়
```

দ্বিতীয়টা বাছো, আর "orphan" object এর জন্য একটা রাতের job: bucket এর LIST আর database এর row মেলাও, ২৪ ঘণ্টার বেশি পুরনো row-ছাড়া object মুছে দাও। (Lesson 7.4 এর মতোই — ফাঁক বন্ধ করা যায় না, শুধু ঠিক করা যায় কোন দিকে পড়বে আর কে সেটা পরিষ্কার করবে।)

```typescript
type NewAttachment = Pick<
	InferCreationAttributes<Attachment>,
	'taskId' | 'workspaceId' | 'fileName' | 'contentType'
>;

async function saveAttachment(input: NewAttachment, body: Buffer): Promise<Attachment> {
	const storageKey = `ws/${input.workspaceId}/att/${randomUUID()}`;
	// 1. The object first — stopping here leaves only an orphan object (the nightly job removes it)
	const put = await s3.send(
		new PutObjectCommand({
			Bucket: env.ATTACHMENTS_BUCKET,
			Key: storageKey,
			Body: body,
			ContentType: input.contentType,
			// RFC 5987 — non-ASCII names (Bangla file names) survive too
			ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`
		})
	);
	// 2. Then the row — if this fails the user sees an error and retries; nothing else breaks
	return Attachment.create({ ...input, storageKey, size: body.length, etag: put.ETag ?? '' });
}
```

(এখানে file এখনো app এর ভেতর দিয়ে **upload** হচ্ছে — `body: Buffer`। ১ GB এর file এ সেটা কী করে, আর কীভাবে browser সরাসরি object storage এ পাঠায় — Lesson 8.2।)

**বাকি সিদ্ধান্ত:**

- **Bucket private** — কোনো public access না। File দেখানো হবে সীমিত সময়ের link দিয়ে (8.2)। (Public bucket থেকে data ফাঁস হওয়া বছরের পর বছর ধরে সবচেয়ে পরিচিত cloud incident গুলোর একটা; AWS 2023 থেকে নতুন bucket এ public access default এ বন্ধ রাখে।)
- **Versioning চালু**, পুরনো version ৩০ দিন পরে lifecycle এ মোছা। মুছে ফেলা workspace এর file ৩০ দিন রাখা (ভুল করে মুছলে ফেরানো), তারপর পুরোপুরি।
- **৯০ দিনের পুরনো attachment Infrequent Access এ।**
- **Task এর checklist, comment এর মতো যা একসাথে বদলায় — database এ।** Object storage শুধু একবার লেখা, অনেকবার পড়া bytes এর জন্য।

> **Trade-off Table — TaskFlow এর attachment কোথায়**

| কোথায়                        | App stateless?   | Database এর উপর                    | দেওয়া (download)                  | Durability                            | দাম (প্রতি GB)              | আংশিক বদল          | কখন                                                   |
| ----------------------------- | ---------------- | ---------------------------------- | ---------------------------------- | ------------------------------------- | --------------------------- | ------------------ | ----------------------------------------------------- |
| Database (`bytea`)            | হ্যাঁ            | WAL, replica, backup সব ভারী (১.২) | শুধু app এর ভেতর দিয়ে — board ধীর | Database এর মতোই (replica + backup)   | সবচেয়ে বেশি (SSD × কপি)    | না (পুরো value)    | কয়েক KB এর অল্প কিছু, transaction এ একসাথে লাগলে     |
| App server এর disk            | **না** — ৫০% 404 | কিছু না                            | Instance এর ভেতর দিয়ে             | Instance মরলে শেষ                     | কম                          | হ্যাঁ              | কখনো না (temp file ছাড়া)                             |
| ভাগ করা file system (NFS/EFS) | হ্যাঁ            | কিছু না                            | App এর ভেতর দিয়ে                  | ভালো (managed হলে)                    | বেশি                        | হ্যাঁ              | পুরনো code যেটা `fs` চায়, অল্প সময়ের জন্য           |
| Object storage (S3-style)     | হ্যাঁ            | শুধু metadata row                  | **সরাসরি** browser/CDN (8.2)       | খুব উঁচু (EC + AZ জুড়ে); ভুল থেকে না | কম; egress আর request আলাদা | না — শুধু পুরো PUT | প্রায় সব user-upload, backup, export, log এর archive |

---

## ২. Interview Angle

**"Instagram/Dropbox design করো — ছবি/file কোথায় রাখবে?"** — প্রায় প্রতিটা design প্রশ্নে এই মুহূর্তটা আসে। দুর্বল উত্তর: "database এ" বা শুধু "S3 এ" (কেন না বলে)। ভালো উত্তর ভাগ করে বলে: **metadata** (কে, কবে, কোন album, file এর key) database এ, **bytes** object storage এ; download সরাসরি object storage/CDN থেকে, app এর ভেতর দিয়ে না; key এর নিয়ম (অপরিবর্তনীয়, user এর নাম না); আর দুই লেখার ক্রম (object আগে, orphan পরিষ্কার)। বোনাস: estimation — প্রতিদিন কত TB, বছরে কত, দাম কত (১.৭ এর মতো এক লাইনে)।

**"File database এ রাখলে সমস্যা কী?"** — তিনটা নির্দিষ্ট দাম বলো, সাধারণ "ধীর" না: WAL আর replica (প্রতিটা byte প্রতিটা replica তে), backup/restore এর আকার আর সময় (RTO), আর দেওয়ার সময় app এর ভেতর দিয়ে যাওয়া (pool, event loop)। আর সৎ ব্যতিক্রম: ছোট আর অল্প হলে চলে।

**"S3 এত durable কীভাবে?"** — Erasure coding (k + m, যেকোনো k যথেষ্ট, কম জায়গায় বেশি সহ্য), failure domain জুড়ে ছড়ানো (AZ), দ্রুত মেরামত, আর checksum দিয়ে নিয়মিত যাচাই। তারপর নিজে থেকে সীমাটা: durability hardware থেকে বাঁচায়, ভুল করে মোছা থেকে না — versioning, object lock, আলাদা account এ কপি।

**"S3 এর consistency কেমন?"** — 2020 থেকে strong read-after-write (PUT, DELETE, LIST); তার আগে overwrite/delete এ eventual — পুরনো উৎস এখনো সেটা বলে, তাই তারিখ সহ উত্তর দাও। Concurrent write এ last writer wins, আর তার উত্তর conditional write (`If-Match`)।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনাগুলো: ভুল করে public bucket (data ফাঁস); lifecycle rule ছাড়া versioning (বিল নীরবে বাড়ে); egress এর বিল যেটা কেউ হিসাব করেনি (CDN ছাড়া বড় file দেওয়া); লাখ লাখ খুব ছোট object (জায়গার চেয়ে request এর বিল বেশি — ছোট জিনিস জুড়ে বড় object বানানো, Haystack এর ধারণা); আর একটা script যেটা ভুল prefix এ `DeleteObjects` চালায় — versioning না থাকলে ফেরানোর উপায় নেই।

---

## ৩. Key Takeaway

- **Object storage** = bytes + metadata + key, bucket এ, HTTP API দিয়ে, সবসময় পুরো object — এই সীমার বদলে প্রায় সীমাহীন আকার, খুব উঁচু durability, কম দাম, আর যেকোনো জায়গা থেকে পৌঁছানো
- File **database এ**: দাম পড়ে WAL (৩১৫ MB file → ৩৩৭ MB WAL, প্রতিটা replica তে), backup (৩৬১ MB/২১ s বনাম ২.৪ MB/০.৪ s), আর দেওয়ায় — file কে app এর ভেতর দিয়ে যেতে হয়, board ১৪ হাজার → ৩৫০ q/s। Postgres নিজে ধীর না; দোষ "app এর ভেতর দিয়ে" এর (object storage কে proxy করলেও একই)
- File **app server এর disk এ**: stateless ভাঙে — round robin এ ৫০% 404, sticky session এ uploader বাঁচে কিন্তু teammate এর ৪৭% 404, আর instance বদলালে file শেষ
- ভেতরে **metadata index** (key → কোথায়, sharded + replicated) আর **bytes** (অনেক object বড় file এ জোড়া — Haystack) আলাদা; তাই "folder" নেই, rename মানে copy + delete, আর bytes শুধু পুরো নতুন করে লেখা যায়
- **Durability** ≠ availability। **Erasure coding** (EC 6+3: ১.৫ গুণ জায়গায় ১১.৮ nines, ৩ কপির ৩ গুণে ৯.৭) — কিন্তু শুধু **failure domain** জুড়ে ছড়ালে: এলোমেলো বসালে একটা rack এ ৬১১টা পড়া যায় না, আলাদা rack এ ০
- API এর নিয়ম: strong read-after-write (S3, 2020 থেকে — অন্য system এ যাচাই করো), last writer wins → **conditional write** (`If-Match`, `If-None-Match`), range read, ETag, **versioning** (ভুল করে মোছা থেকে রক্ষা)
- Database এ metadata, object storage এ bytes; key অপরিবর্তনীয় আর user এর নাম ছাড়া; **object আগে, row পরে**, orphan এর জন্য পরিষ্কারের job; private bucket, versioning + **lifecycle**; আর বিলে egress আর request কে ভুলো না

---

## ৪. নতুন Term (Glossary)

| Term                          | অর্থ                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Object Storage**            | Data কে object (bytes + metadata + key) হিসেবে bucket এ রাখা, HTTP API দিয়ে পুরো object ধরে পড়া-লেখা — মাঝখানে বদলানো যায় না                              |
| **Bucket / Key (Prefix)**     | Bucket — object এর নামযুক্ত পাত্র (permission, versioning, lifecycle এর নিয়ম এখানে); key — object এর অনন্য নাম; prefix — key এর শুরুর অংশ, "folder" এর ভ্রম |
| **Object Metadata**           | Bytes এর সাথে রাখা ছোট তথ্য — আকার, Content-Type, ETag (content এর fingerprint), নিজের key-value; HEAD দিয়ে bytes ছাড়াই পাওয়া যায়                        |
| **Durability**                | একবার লেখা data একটা সময়ে (সাধারণত বছরে) না হারানোর সম্ভাবনা — availability (এখন পড়া যায় কিনা) থেকে আলাদা                                                 |
| **Erasure Coding**            | Object কে k টা data আর m টা parity fragment এ ভাগ করা, যেকোনো k টা থেকে পুরোটা ফেরানো যায় — m টা মরা সহ্য করে (k+m)/k গুণ জায়গায়                          |
| **Failure Domain**            | যার ভেতরের সবকিছু একটা ঘটনায় একসাথে ব্যর্থ হতে পারে — disk, server, rack, AZ, region; কপি বা fragment এগুলো জুড়ে ছড়াতে হয়                                |
| **Storage Class / Lifecycle** | দাম আর পড়ার গতি অনুযায়ী object এর শ্রেণি (Standard, Infrequent Access, archive); lifecycle rule বয়স ধরে object সরায় বা মোছে                              |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এ আরও দুটো জিনিস আসছে: (ক) user এর avatar — প্রতি user এর একটা, ~৩০ KB, প্রায় প্রতিটা page এ দেখায় (comment, board, member list); (খ) প্রতি মাসে প্রতিটা workspace এর একটা invoice PDF, ~১০০ KB, যেটা billing এর transaction এর সাথে একসাথে তৈরি হয় আর আইনত ৭ বছর রাখতে হয়। প্রতিটা কোথায় রাখবে — database নাকি object storage — আর কেন? ৫০ হাজার user আর ৫ হাজার workspace ধরে প্রতিটার মোট আকার হিসাব করো। কোনটার জন্য storage class বা lifecycle এর কথা ভাববে?
2. TaskFlow এর attachment এর key এর জন্য দুটো প্রস্তাব: (ক) `ws/{workspaceId}/att/{uuid}`, (খ) `att/{uuid}` (workspace শুধু database এর row এ)। তিনটা ঘটনার জন্য তুলনা করো: একটা task এক workspace থেকে আরেকটায় সরানো; একটা customer চলে গেলে তার workspace এর সব file মুছে ফেলা (আইনি বাধ্যবাধকতা, ৩০ দিনের মধ্যে); আর রাতের orphan পরিষ্কারের job। কোনটা বাছবে?
3. একজন manager বলল: "S3 এর durability ১১ nines — তাহলে attachment এর আলাদা backup এর কোনো দরকার নেই।" কোন অংশ ঠিক, কোন অংশ ভুল? অন্তত তিনটা পরিস্থিতি বলো যেখানে ১১ nines থাকা সত্ত্বেও TaskFlow এর file হারাবে — আর প্রতিটার বিরুদ্ধে কী বসাবে।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

- **(ক) Avatar → object storage, আর সামনে CDN।** আকার: ৫০,০০০ × ৩০ KB ≈ ১.৫ GB — ছোট, database এও ধরত। কিন্তু প্রশ্নটা আকার না, **দেওয়া**: প্রায় প্রতিটা page এ কয়েকটা avatar, মানে দিনে লাখ লাখ read। Database এ থাকলে প্রতিটা app এর ভেতর দিয়ে (১.২ এর board এর ক্ষতি), আর cache করা কঠিন। Object storage এ রাখলে একটা স্থির URL, CDN এ cache (Lesson 4.5), browser এ cache — app আর database কেউ ছোঁয় না। একটা সূক্ষ্মতা: avatar বদলালে key বদলাও (`avatars/{userId}/{version}.webp`) — পুরনো URL CDN এ cache থাকে, নতুন key মানে invalidation এর ঝামেলা নেই (Lesson 4.3)।
- **(খ) Invoice PDF → object storage, কিন্তু সাবধানে।** আকার: ৫,০০০ × ১২ মাস × ১০০ KB ≈ ৬ GB প্রতি বছর, ৭ বছরে ~৪২ GB — database এ রাখলেও বিশাল না, আর "billing এর transaction এর সাথে একসাথে" শুনে database এ রাখার লোভ হয়। তবু object storage ভালো: কখনো বদলায় না, খুব কম পড়া হয়, আর ৭ বছর ধরে প্রতি রাতের backup এ বয়ে বেড়ানোর কোনো মানে নেই। Transaction এর প্রশ্নটা ১.৮ এর মতো সামলাও — invoice এর row database এ (টাকার সংখ্যা, status), PDF টা পরে তৈরি হয়ে object storage এ (একটা BullMQ job, 7.3 — idempotent, key = `invoices/{workspaceId}/{yyyy-mm}.pdf`)। এখানে storage class আর lifecycle স্পষ্ট: ৯০ দিন পরে Infrequent Access, এক বছর পরে archive, ৭ বছর পরে মোছা। আর আইনি রাখার জন্য object lock (নির্দিষ্ট সময় পর্যন্ত কেউ মুছতে পারবে না) — ভুল বা ক্ষতিকর delete এর বিরুদ্ধে।

**প্রশ্ন ২:**

| ঘটনা                        | (ক) `ws/{workspaceId}/att/{uuid}`                                              | (খ) `att/{uuid}`                                                         |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Task অন্য workspace এ সরানো | প্রতিটা attachment এর object copy + delete (১.৬) — নয়তো key আর workspace অমিল | শুধু database এর row বদলায় — object ছোঁয়া হয় না                       |
| Workspace এর সব file মোছা   | Prefix `ws/{id}/` এর LIST, তারপর ১০০০ করে delete — database না দেখেও সম্পূর্ণ  | Database থেকে সব key এর তালিকা লাগে — database এ ভুল থাকলে কিছু বাদ পড়ে |
| Orphan পরিষ্কার             | Workspace ধরে ভাগ করে চালানো যায় (prefix প্রতি একটা job)                      | পুরো bucket এর LIST একবারে                                               |

বাছাই: TaskFlow এ task এক workspace থেকে আরেকটায় সরানো খুবই কম ঘটে, কিন্তু workspace মুছে ফেলা একটা আইনি বাধ্যবাধকতা যেটা **সম্পূর্ণ** হতে হবে — (ক)। আর lifecycle rule ও prefix ধরে বসানো যায় ("মুছে ফেলা workspace এর prefix এ ৩০ দিন পরে expire")। সরানোর ঘটনা এলে সেটা একটা BullMQ job (copy, row বদল, তারপর পুরনোটা delete — আবার ১.৮ এর ক্রম: নতুন object আগে, row তারপর, পুরনো শেষে)। (খ) ঠিক উত্তর হতো যদি সরানো ঘনঘন হতো — key এ যা আছে সেটা যেন কখনো বদলাতে না হয়, এটাই মূল নিয়ম।

**প্রশ্ন ৩:** ঠিক অংশ: hardware এর ব্যর্থতায় (disk, server, এমনকি একটা data center) file হারানোর জন্য আলাদা backup এর দরকার প্রায় নেই — সেটাই ১১ nines এর মানে। ভুল অংশ: durability শুধু hardware থেকে রক্ষা করে। File হারানোর পরিস্থিতি:

- **Code এর bug বা ভুল script:** orphan পরিষ্কারের job এ ভুল শর্ত (ধরো database এর replica থেকে পড়ল, যেটা পিছিয়ে ছিল — Lesson 5.7 — তাই নতুন file গুলোকে orphan ভাবল) আর সত্যিকারের file মুছে দিল। Object store খুব durably মুছে দেবে। → **Versioning** (delete মানে delete marker, ৩০ দিন ফেরানো যায়), আর পরিষ্কারের job এ নিরাপত্তা: শুধু ২৪ ঘণ্টার পুরনো, primary থেকে পড়া, আর প্রথমে "মুছব" এর তালিকা log করা।
- **Credential চুরি বা ক্ষতিকর মানুষ (ransomware):** কেউ access key পেয়ে সব মুছে দিল, versioning সহ (যার permission আছে সে পুরনো version ও মুছতে পারে)। → **Object lock** (নির্দিষ্ট সময় পর্যন্ত কেউ মুছতে পারবে না), আর একটা **আলাদা account** এ কপি (replication), যেখানে production এর credential পৌঁছায় না।
- **Region এর বড় ঘটনা বা ভুল configuration:** পুরো region কিছুক্ষণের জন্য unavailable (durability ঠিক, availability না), বা কেউ bucket এর lifecycle rule ভুল লিখল ("১ দিন পরে expire")। → গুরুত্বপূর্ণ data এর জন্য অন্য region এ replication (Lesson 10.8), আর lifecycle rule কে code এর মতো review আর test করা।

শেষ কথা: প্রশ্নটা "backup লাগবে কিনা" না, "কোন ব্যর্থতা থেকে রক্ষা চাই, আর তার RPO/RTO কত" (Lesson 5.7, 1.5)। Hardware এর জন্য ১১ nines; মানুষ আর bug এর জন্য versioning, lock আর আলাদা কপি।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (Docker এ Postgres + SeaweedFS; `durability` এ Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-8.1-object-storage/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-8.1-object-storage) — `docker compose up -d --wait && npm install`, তারপর `npm run where`, `npm run stateless`, `npm run durability`, `npm run inspect`। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`where` একই file গুলো Postgres এর `bytea` আর object storage এ রাখে — WAL, আকার, `pg_dump` মাপে — তারপর board এর query চলার সময় file দেয় তিনভাবে (app এর ভেতর দিয়ে, আলাদা process থেকে database, আর সরাসরি object storage)। `stateless` দুটো Express instance চালায়, local disk বনাম bucket, round robin আর sticky। `durability` একটা হিসাব আর একটা seed দেওয়া rack এর simulation। `inspect` S3 API এর সাতটা নিয়ম সরাসরি দেখায়।

**সৎ নোট:** Sandbox এ Docker এর Postgres 17 আর SeaweedFS 4.47 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `where` কয়েকবার — প্রতিবার `bytea` এর WAL ≈ ৩৩৭ MB, backup ৩৬১ MB, আর "app এর ভেতর দিয়ে" সারিতে board ২৬৯–৩৬৯ q/s (বাকি দুই সারিতে প্রায় অপরিবর্তিত); `stateless` আর `durability` দুবার করে চালিয়ে হুবহু একই output; `inspect` এর সাতটা অংশই প্রত্যাশিত ফল দিয়েছে। README এর experiment ১–৩ চালানো হয়েছে, সংখ্যা README তে; ৪ আর ৫ code বদলানোর কাজ — তোমার। Object store টা SeaweedFS, AWS S3 না — S3 এর consistency, conditional write আর versioning এর কথা AWS এর documentation থেকে, আর এখানে SeaweedFS একই আচরণ করেছে; অন্য S3-compatible system এ যাচাই করে নিও। (MinIO এর community Docker image আর Docker Hub এ পাওয়া যায় না — তাই SeaweedFS।) Durability এর অংশ ক একটা সরল model — সংখ্যা design এর লক্ষ্যের আকৃতি দেখায়, কোনো আসল system এর মাপা হার না। ১.৭ এর দাম লেখার সময়ের আনুমানিক, যাচাই করা বিল না।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** `npm run where` চালানোর **আগে** লিখে ফেলো — `bytea` তে WAL কত হবে (file এর আকারের চেয়ে কম, সমান, না বেশি — কেন?), আর ধাপ ৩ এর চারটা সারির কোনটায় board সবচেয়ে ধীর হবে। তারপর চালিয়ে মেলাও। তোমার ৩টা replica থাকলে এই upload এ network এ মোট কত byte যেত?

2. **দোষটা কার?** Experiment ১ (`POOL_MAX=20`) আর ২ (`PROXY_S3=1`) চালাও। দুটো সংখ্যা পাশাপাশি রেখে এক প্যারাগ্রাফে লেখো — board এর ক্ষতি কতটা pool থেকে, কতটা app এর event loop থেকে, আর কতটা database থেকে। এই ফল থেকে TaskFlow এর download route এর জন্য একটা নিয়ম লেখো।

3. **১৪৮ এর হিসাব:** `stateless` এর "local disk, round robin" সারিতে instance বদলানোর পরে ১৪৮ কেন — ১০০ না, ২০০ না? হাতে ব্যাখ্যা করো। তারপর experiment ৪ (sticky by workspace) — teammate এর কলাম সারায়, কিন্তু কোন কলাম কখনো সারায় না, আর কেন?

4. **Nines হাতে:** ৩ কপির "৯.৭ nines" হাতে হিসাব করো — q = AFR × মেরামতের সময় ÷ এক বছর, তারপর ৩ × AFR × q²। তারপর `REPAIR_HOURS=168` আর `RACKS=4` (experiment ৩)। TaskFlow যদি নিজের data center এ object store চালাত (ধরো ৪টা rack), কোন পদ্ধতি বাছত আর কেন?

5. **Design অংশ:** TaskFlow এর attachment এর এক পাতার design: (ক) `attachments` table এর schema (Sequelize model সহ); (খ) key এর নিয়ম আর কারণ (প্রশ্ন ২ মাথায় রেখে); (গ) upload এর ধাপ আর crash হলে কী হয়, orphan পরিষ্কারের job এর শর্ত (কোথা থেকে পড়বে, কত পুরনো, কীভাবে নিরাপদ); (ঘ) bucket এর নিয়ম — private, versioning, lifecycle (কত দিনে কী), object lock কোথায়; (ঙ) ১.৭ এর মতো একটা হিসাব — তোমার নিজের ধরে নেওয়া সংখ্যায়, এক বছর পরে জায়গা, request আর egress এর মাসিক বিল।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7 (সম্পূর্ণ, exit challenge সহ)
Current: 8.1 — Object / Blob Storage (S3-style): কীভাবে কাজ করে, কখন লাগে
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; outbox → Redis Streams, BullMQ; analytics রাতে Parquet + DuckDB;
attachment: database এ শুধু metadata (attachments table: storageKey, etag, size, fileName),
bytes object storage এ — private bucket, key = ws/{workspaceId}/att/{uuid}, object আগে তারপর
row, রাতে orphan পরিষ্কার, versioning + lifecycle (৩০ দিনে পুরনো version মোছা, ৯০ দিনে
Infrequent Access); upload এখনো app এর ভেতর দিয়ে (8.2 এ বদলাবে)
Terms learned (Module 8 so far): Object Storage, Bucket / Key (Prefix), Object Metadata,
Durability, Erasure Coding, Failure Domain, Storage Class / Lifecycle
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 8.2 — File upload at scale: presigned URL, multipart, CDN delivery (SvelteKit frontend সহ)
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের "দোষটা কার" এর প্যারাগ্রাফ আর ৫ নম্বরের design। রেডি হলে `next` লিখো — Lesson 8.2 এ যাব: **File upload at scale — presigned URL, multipart, CDN delivery (SvelteKit frontend সহ)।** আজ দেখেছি file **download** app এর ভেতর দিয়ে গেলে board কীভাবে ধীর হয়। কিন্তু আমাদের **upload** এখনো app এর ভেতর দিয়েই যাচ্ছে — `saveAttachment(input, body: Buffer)`। একজন user ২ GB এর একটা screen recording upload করলে কী হয়: Express এর memory, Nginx এর body size আর timeout, আর ৯০% এ গিয়ে network কাটলে পুরোটা আবার শুরু থেকে। 8.2 এ browser সরাসরি object storage এ পাঠাবে — app শুধু একটা সীমিত সময়ের অনুমতি দেবে — বড় file টুকরো টুকরো, থেমে গেলে যেখানে থেমেছিল সেখান থেকে, আর তারপর সেই file সারা পৃথিবীতে দ্রুত পৌঁছাবে CDN দিয়ে।
