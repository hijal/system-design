# TaskFlow Object Storage Lab — Database, Local Disk, নাকি Object Storage

> Lesson 8.1 — Object / Blob Storage (S3-style) · **Tier 1 — Runnable Code** (Docker এ Postgres + SeaweedFS, একটা S3-compatible object store)

## কী বানাচ্ছি

TaskFlow এর task attachment কোথায় রাখব — চারটা script, চারটা প্রশ্ন:

| Script               | প্রশ্ন                                                                                                                                          | Lesson § |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run where`      | একই ২০০টা file (৩১৫ MB) Postgres এর `bytea` তে বনাম object storage এ — WAL, database এর আকার, backup, আর file দেওয়ার সময় board এর query       | ১.২      |
| `npm run stateless`  | দুটো Express instance, প্রত্যেকের নিজের disk এ file — বনাম দুজনেই একই bucket এ; round robin আর sticky session, তারপর একটা instance বদলানো       | ১.৩      |
| `npm run durability` | Replication বনাম erasure coding — কত disk লাগে, কত "nines"; আর fragment গুলো rack না ভেবে বসালে একটা rack বন্ধ হলে কী হয়                       | ১.৫      |
| `npm run inspect`    | Object storage এর API এর সাতটা নিয়ম — লেখার পরেই পড়া, "folder", পুরো object PUT বনাম range GET, metadata, ETag, conditional write, versioning | ১.৬      |

**সৎ নোট:**

- Object store টা **SeaweedFS** (S3 API বলে এমন একটা open-source system) — AWS S3 না। S3 API এর যে অংশ এখানে
  ব্যবহার হয়েছে (PUT, GET, Range, HEAD, LIST, Copy, If-Match/If-None-Match, versioning) সেটা এখানে S3 এর মতোই
  আচরণ করেছে; কিন্তু অন্য S3-compatible system (বা পুরনো version) সব feature সমর্থন নাও করতে পারে — ব্যবহারের আগে
  যাচাই করো। (MinIO এর community Docker image আর Docker Hub এ পাওয়া যায় না, তাই এটা।) যাচাই করা হয়েছে SeaweedFS
  4.47 আর Postgres 17 এ।
- `where` আসল database, আসল সময় — সংখ্যা মেশিন ভেদে বদলাবে, আকৃতি একই থাকার কথা। File এর content এলোমেলো byte —
  আসল PDF, ছবি, zip এর মতোই আর চাপা যায় না। Postgres আর SeaweedFS দুটোই `cpus: 2` এ।
- `where` এর ধাপ ৩ এ load দেয় তিন জায়গা থেকে: "app" এর process (board এর query, আর database থেকে file হলে সেটাও —
  file database এ থাকলে app কে এভাবেই দিতে হয়), আর আলাদা child process (browser বা CDN এর মতো সরাসরি object storage
  থেকে; আর database এর উপর চাপ একা মাপতে database থেকেও)। আলাদা process কারণ, একই Node process এ byte টানার CPU
  board এর latency তেও ঢুকত — সেটাই আবার একটা শিক্ষা (experiment ২)।
- `stateless`, `durability` seed দেওয়া — প্রতিবার হুবহু একই সংখ্যা। `durability` এর অংশ ক একটা সরল model (disk গুলো
  স্বাধীনভাবে মরে, মেরামতে নির্দিষ্ট সময়) — আসল system এ একসাথে মরা (একই batch এর disk, একই power) বড় ঝুঁকি, আর
  মানুষের ভুলে মোছা আরও বড়। Durability এর সংখ্যা design এর লক্ষ্য, মাপা নিশ্চয়তা না।

## Prerequisite

Node.js 22+, Docker (Postgres আর SeaweedFS এর জন্য; `durability` এ Docker লাগে না)।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run where        # ~১ মিনিট (backup আর চারটা ৮ সেকেন্ডের ধাপ)
npm run stateless    # ~৫ সেকেন্ড
npm run durability   # সাথে সাথে
npm run inspect      # ~১০ সেকেন্ড
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run where` (এই মেশিনে):

```
── ১. রাখা (একসাথে ৪টা upload) ─────────────────────────────────
   কোথায়                              সময়      WAL লেখা    database এ বাড়ল   object storage এ
   Postgres (bytea)                  1.14 s    336.9 MB          327.2 MB                 —
   object storage + metadata row     1.69 s       49 KB             80 KB          314.5 MB

── ২. Backup (pg_dump -Fc, container এর ভেতরে) ─────────────────
   file সহ database                      361.1 MB    21.56 s
   file ছাড়া (শুধু metadata)              2.4 MB   399.8 ms

── ৩. File দেওয়ার সময় board এর query (8 OLTP client, pool max 10; 8 জন file নামায়) ──
   ধাপ                                          OLTP q/s   OLTP p50   OLTP p99   file/s     MB/s   file p50 / p99
   শুধু OLTP                                      14437     0.4 ms     0.8 ms        0        0   —
   + file, Postgres → app এর ভেতর দিয়ে             350    20.9 ms    66.1 ms      192      289   27.9 ms / 170.8 ms
   + file, Postgres → আলাদা process               14687     0.4 ms     0.8 ms      194      290   23.3 ms / 218.0 ms
   + file, object storage → সরাসরি                14968     0.4 ms     0.7 ms      348      516   17.5 ms / 91.6 ms
```

মিলতে হবে: `bytea` তে WAL ≈ file এর মোট আকার (আর তার বেশি), object storage এ কয়েক KB; file সহ backup কয়েকশো MB আর
দশ সেকেন্ডের ঘরে, file ছাড়া কয়েক MB আর এক সেকেন্ডের কম; ধাপ ৩ এ "app এর ভেতর দিয়ে" সারিতে board এর q/s কয়েক গুণ
(এখানে ~৪০ গুণ) কম, বাকি দুই সারিতে প্রায় "শুধু OLTP" এর সমান।

`npm run stateless`:

```
   file কোথায় · load balancer          নিজে আবার খুলল: 404   teammate খুলল: 404   instance A বদলানোর পরে: নেই
   local disk, round robin                       50%                  47%                  148 / 200
   local disk, sticky (user ধরে)                  0%                  47%                  100 / 200
   object storage, round robin                    0%                   0%                    0 / 200
```

`npm run durability`:

```
── ক. হিসাব (AFR 2%, মেরামতে 24 ঘণ্টা, disk গুলো স্বাধীনভাবে মরে) ──
   পদ্ধতি       ১ TB রাখতে disk এ   সহ্য করে   বছরে হারানোর সম্ভাবনা   durability   ১০০ কোটি object এ বছরে হারায়
   ১ কপি                 1.00 TB  0 টা disk                 2.0e-2    1.7 nines                     20000000
   ২ কপি                 2.00 TB  1 টা disk                 2.2e-6    5.7 nines                         2192
   ৩ কপি                 3.00 TB  2 টা disk                1.8e-10    9.7 nines                          0.2
   EC 4+2                1.50 TB  2 টা disk                 3.6e-9    8.4 nines                            4
   EC 6+3                1.50 TB  3 টা disk                1.7e-12   11.8 nines                        0.002
   EC 10+4               1.40 TB  4 টা disk                1.8e-15   14.7 nines                     0.000002

── খ. Failure domain (10 টা rack × 12 টা disk, 100,000 টা object) ──
   পদ্ধতি · fragment কোথায়             পড়া যায় না যখন বন্ধ:    1 rack   2 rack   3 rack
   ৩ কপি · এলোমেলো disk                                           89      718    2,541
   ৩ কপি · প্রতিটা আলাদা rack                                      0        0      860
   EC 6+3 · এলোমেলো disk                                         611    8,021   26,556
   EC 6+3 · প্রতিটা আলাদা rack                                     0        0        0
```

`npm run inspect` — প্রতিটা অংশে দেখার কথা: (১) পুরনো মান ফেরত `0 / 200`; (২) `workspaces/12/tasks/` একটা "folder"
হিসেবে দেখায়, আর "rename" এ `9 টা request`; (৩) ১ byte বদলাতে `8,388,608 byte`, range এ `1024 byte`, `মিলেছে: হ্যাঁ`;
(৪) HEAD এ content type আর নিজের metadata; (৫) ETag = MD5; (৬) শর্ত ছাড়া Rahim এর item হারায়, `If-Match` এ Karim এর
প্রথম লেখা `412`, আবার পড়ে দুজনেরটাই থাকে, আর `If-None-Match: *` এ `412`; (৭) `version আছে: 2 · delete marker: 1 ·
সাধারণ GET: 404`, আর পুরনো version ফিরিয়ে আনা যায়।

## কী দেখার জন্য এটা বানানো

- **WAL আর backup এর সারি:** file database এ রাখলে প্রতিটা byte দুবার লেখা হয় (WAL, তারপর table) — আর প্রতিটা
  replica ঠিক ততটা WAL পায় (Lesson 5.7)। Backup ৫০ গুণের বেশি বড় আর ধীর — আর restore ও (RTO, Lesson 1.5)। অথচ
  database এর আসল data — task, comment, user — কয়েক MB।
- **ধাপ ৩ এর দ্বিতীয় আর তৃতীয় সারির পার্থক্য:** Postgres নিজে file ভালোই দেয় (আলাদা process থেকে নামালে board প্রায়
  টের পায় না)। কিন্তু file database এ থাকলে সেটা **app এর ভেতর দিয়ে** দিতেই হয় — database HTTP বলে না — আর তখন
  প্রতিটা byte app এর event loop পার হয় (`bytea` আসে hex text হয়ে, দ্বিগুণ আকারে, parse করতে হয়), pool এর connection
  ধরে রাখে, আর board এর query লাইনে দাঁড়ায়। Lesson 7.1 এর cascading failure এর চেনা আকৃতি।
- **`stateless` এর teammate কলাম:** sticky session (Lesson 3.4) uploader কে বাঁচায়, teammate কে না — file টা একজনের
  না, একটা team এর। আর instance বদলালে sticky ও কিছু বাঁচায় না।
- **`durability` এর EC 6+3:** ৩ কপির অর্ধেক disk এ বেশি durability — কিন্তু fragment গুলো rack না ভেবে বসালে একটা
  rack বন্ধ হলেই ৩ কপির চেয়েও বেশি object পড়া যায় না। Erasure coding এর শক্তি আসে failure domain জুড়ে ছড়ানো থেকে।

## নিজে ভেঙে দেখো (Experiments)

1. **Pool নাকি app?** `POOL_MAX=20 npm run where` — file এর জন্য pool এ যথেষ্ট জায়গা। (এই মেশিনে: "app এর ভেতর দিয়ে"
   সারিতে board তবু ৩৭৪ q/s, p50 ২০ ms।) তাহলে ক্ষতির বড় অংশ কোথা থেকে আসছে?
2. **Object storage ও app এর ভেতর দিয়ে দিলে:** `PROXY_S3=1 npm run where` — একটা বাড়তি সারি: object storage থেকে file,
   কিন্তু app নিজে নামিয়ে user কে দেয় (proxy)। (এই মেশিনে: board ৪৮৬ q/s, p50 ১৫ ms — database থেকে দেওয়ার প্রায়
   সমান।) শিক্ষাটা কী — "database বনাম object storage", নাকি "app এর ভেতর দিয়ে বনাম সরাসরি"? (Lesson 8.2 এর presigned
   URL এর ভূমিকা।)
3. **মেরামত ধীর হলে:** `REPAIR_HOURS=168 npm run durability` — বড় disk এর data আবার বানাতে এক সপ্তাহ লাগলে। (এই
   মেশিনে: ৩ কপি ৯.৭ থেকে ৮.১ nines, EC 6+3 ১১.৮ থেকে ৯.২।) কোন সারি সবচেয়ে বেশি পড়ল, কেন? তারপর `RACKS=4` — EC 6+3
   এর "প্রতিটা আলাদা rack" সারিটা কেন নেই?
4. **Sticky by workspace:** `stateless.ts` এ sticky এর hash `userId` এর বদলে workspace ধরে করো (ধরো ৪ জন user এর একটা
   workspace — `Math.floor(userId / 4)`), আর teammate কে একই workspace থেকে বাছো। Teammate কলাম কী হলো? আর instance
   বদলানোর কলাম? এই পথে কী কী নতুন সমস্যা আসে (একটা বড় workspace — hot instance, Lesson 5.8)?
5. **Versioning এর দাম:** `inspect.ts` এর versioning অংশে একই key তে ১০০ বার PUT করো, তারপর `ListObjectVersions` এ কয়টা
   version? প্রতিটা version কি জায়গা নেয়? Lesson এর §১.৭ এর lifecycle rule এর কথা মাথায় রেখে ঠিক করো TaskFlow এ পুরনো
   version কতদিন রাখবে।

## Project Structure

```
lesson-8.1-object-storage/
├── docker-compose.yml   # Postgres 17 (5445) + SeaweedFS 4.47 S3 (8335), দুটোই cpus: 2
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── storage.ts       # env (Zod), Postgres pool, S3 client, bucket তৈরি/খালি, put/get
    ├── where.ts         # bytea বনাম object storage: WAL, আকার, pg_dump, file দেওয়ার সময় OLTP
    ├── downloader.ts    # where এর child process — app এর বাইরে থেকে file নামানো
    ├── stateless.ts     # দুটো Express instance: local disk বনাম bucket, round robin/sticky, instance বদল
    ├── durability.ts    # replication বনাম erasure coding এর হিসাব, আর rack এর simulation
    ├── inspect.ts       # S3 API এর সাতটা নিয়ম, SeaweedFS এর উপর
    └── random.ts        # seed দেওয়া PRNG, percentile, format
```

সব env: `where` — `FILES` (200), `PHASE_MS` (8000), `CLIENTS` (8), `DOWNLOADERS` (8), `POOL_MAX` (10), `PROXY_S3` (0),
`SEED` (7); `stateless` — `USERS` (20), `FILES_PER_USER` (10), `SEED`; `durability` — `AFR` (0.02), `REPAIR_HOURS` (24),
`RACKS` (10), `DISKS_PER_RACK` (12), `OBJECTS` (100000), `SEED`; সবগুলোতে `DATABASE_URL`, `S3_ENDPOINT`, `BUCKET`।
