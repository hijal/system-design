# TaskFlow Upload Lab — Presigned URL, Multipart, আর CDN

> Lesson 8.2 — File upload at scale · **Tier 1 — Runnable Code** (Docker এ SeaweedFS — S3-compatible object store, এবার authentication চালু)

## কী বানাচ্ছি

বড় file এর upload আর download — চারটা script, চারটা প্রশ্ন:

| Script                | প্রশ্ন                                                                                                                                                 | Lesson § |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `npm run through-app` | Upload app এর ভেতর দিয়ে গেলে app এর কী হয় — পুরো file memory তে (buffer), বয়ে যাওয়া (stream), আর presigned (app শুধু URL দেয়)                     | ১.১      |
| `npm run presign`     | একটা presigned URL হাতে পেলে কেউ কী পারে আর কী পারে না — content-type, key, আকার, মেয়াদ, SDK এর checksum এর ফাঁদ; confirm ধাপ; GET; CORS              | ১.২, ১.৪ |
| `npm run resume`      | ২০০ MB এর file, এমন network এ যেটা গড়ে প্রতি ৬০ MB এ ছিঁড়ে যায় — একটা PUT বনাম multipart (৫/১৬/৬৪ MB part), tab বন্ধ হয়ে আবার শুরু, অসমাপ্ত upload | ১.৩      |
| `npm run cdn`         | Private file CDN এর পেছনে — প্রত্যেকের নিজের presigned URL বনাম CDN এর নিজের signed token; cache hit আর object storage থেকে কত byte বেরোল              | ১.৫      |

**সৎ নোট:**

- Object store টা **SeaweedFS 4.47**, AWS S3 না — `s3.json` এ একটা identity দেওয়া, তাই signature আসলেই যাচাই হয় (8.1 এ
  authentication বন্ধ ছিল)। Presigned URL, multipart, CORS এখানে S3 এর নিয়মেই আচরণ করেছে; অন্য S3-compatible system এ
  যাচাই করে নেবেন। AWS S3 এর সীমাগুলো (part এর ন্যূনতম ৫ MB, সর্বোচ্চ ১০,০০০ part, একটা PUT এ সর্বোচ্চ ৫ GB) documentation
  থেকে; এখানে ন্যূনতম part এর নিয়মটা (`EntityTooSmall`) SeaweedFS ও মানে।
- `through-app` এর "ধীর user" মানে client নিজে গতি বেঁধে রাখে (প্রতি সেকেন্ডে ১৬ MB); app আলাদা process, তার memory আর
  event loop মাপা হয়। আসল process, আসল সময় — সংখ্যা সামান্য বদলাবে।
- `resume` এর upload গুলো আসল (presigned URL, মাঝপথে connection আসলেই কাটা), কিন্তু **সময়** একটা হিসাব — local network
  এ আসল সময় অর্থহীন দ্রুত। কোন byte এ ছিঁড়বে সেটা seed দেওয়া। Default seed ১১ বাছা হয়েছে কারণ তার ছেঁড়ার দূরত্ব গুলো
  (৪৩, ৪৫, ৫৬, ৫৪ MB …) গড় ৬০ MB এর কাছে — অন্য seed এ ভাগ্য অন্য (seed ৭ এ প্রথম দুটো ছেঁড়া ২ MB এর মধ্যে, তারপর আর
  না — তখন সব পদ্ধতি প্রায় সমান)। তাই script এর শেষে একই network এর একটা model, ১০০০টা seed এ — গড় আর p95 সেখান থেকে পড়ুন।
- `cdn` এর "CDN" একটা ছোট Express proxy, এই process এ — CloudFront/Cloudflare না; token টা CDN এর signed URL এর **ধারণা**
  (path + মেয়াদ এর HMAC), কোনো নির্দিষ্ট CDN এর format না।
- Lesson এর SvelteKit এর code এই exercise এ চালানো হয়নি (browser লাগে); একই HTTP ধাপ গুলো এখানে Node থেকে আসল request
  দিয়ে যাচাই করা।

## Prerequisite

Node.js 22+, Docker।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run through-app   # ~30 seconds
npm run presign       # ~5 seconds (including waiting for one expiry)
npm run resume        # ~1 minute
npm run cdn           # ~15 seconds
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run through-app` (এই মেশিনে):

```
   path                                      app memory start→peak     uploads open at once    through the app   ping p50 / p99          event loop p99 / max   uploads done
   ping only                                            81 → 99 MB                        0             0.0 MB   0.5 ms / 2.1 ms              1.5 ms / 6.2 ms              —
   buffer (whole file in memory)                      79 → 1159 MB                        8          1024.0 MB   0.4 ms / 2.2 ms            1.8 ms / 434.6 ms        13.71 s
   stream (flows through the app)                      80 → 111 MB                        8          1024.0 MB   0.5 ms / 1.3 ms             1.6 ms / 19.5 ms         8.19 s
   presigned (straight to object storage)               79 → 99 MB                        0             0.0 MB   0.5 ms / 1.2 ms             1.6 ms / 16.7 ms         8.19 s
```

মিলতে হবে: buffer এ memory কয়েকশো MB থেকে GB এর ঘরে; stream এ memory প্রায় সমান কিন্তু ৮টা upload খোলা আর ১ GB app এর ভেতর
দিয়ে; presigned এ দুটোই শূন্য।

`npm run presign`:

```
── Presigned URL for upload (PUT) ──
    1. correct file, correct content-type                             → 200
    2. the same URL again (before expiry)                             → 200
    3. the same URL, content-type changed (text/html)                 → 403
    4. changing the URL's key to write to another object              → 403
    5. a bigger file, the same URL (size signed)                      → 403
    6. expiry 2 s, used after 3.5 s                                   → 403
    7. a file 50 times bigger on a URL without the size signed        → 200
    8. URL signed with the SDK's default checksum                     → 400 BadDigest

── Confirm: the browser said "done", the app verifies ──
       correct upload                           → ready (ETag "…")
       took the URL, never uploaded             → rejected: no object — not uploaded
       size not signed, a bigger file arrived   → rejected: size 1500 (declared 30) — object deleted

── Presigned URL for download (GET) ──
    9. presigned GET                                                  → 200 · attachment; filename*=UTF-8''Release%20notes%20%E2%80%94%20v2.1.pdf
   10. the same object, without a signature                           → 403

── CORS … (preflight) ──
       https://app.taskflow.test                → 200 · allow-origin: https://app.taskflow.test
       https://evil.example                     → 403 · allow-origin: (none)
```

`npm run resume` (seed ১১):

```
   method                                  done?        sent    × file size  requests      torn      est. time   MD5 match   ETag
   one PUT, network fine                     yes    200.0 MB           1.00         1         0        1.3 min         yes   "…"
   one PUT, broken network                    no    819.3 MB           4.10        15        15        5.5 min           —
   multipart, 5 MB part                      yes    208.0 MB           1.04        44         4        1.5 min         yes   "…-40"
   multipart, 16 MB part                     yes    238.0 MB           1.19        17         4        1.6 min         yes   "…-13"
   multipart, 64 MB part                     yes    758.7 MB           3.79        18        14        5.1 min         yes   "…-4"
   multipart, 16 MB, tab closed midway       yes    238.0 MB           1.19        17         4        1.6 min         yes   "…-13"
                                        13 parts, 4 resent · after closing the tab 6 were already there

── Model: the same network, 1000 different seeds (no IO, just byte accounting) ──
   method                       done    sent (avg, × file size)     time avg     time p95     requests
   one PUT                       43%                       2.61      3.5 min      6.5 min            7
   multipart, 5 MB part         100%                       1.04      1.5 min      1.6 min           43
   multipart, 16 MB part        100%                       1.14      1.6 min      1.8 min           17
   multipart, 64 MB part        100%                       1.76      2.4 min      3.7 min           10

── Unfinished upload (3 parts sent, then the user left) ──
   visible in LIST objects: 0 · unfinished multipart uploads: 1, space used by parts 24.0 MB
   unfinished uploads after AbortMultipartUpload: 0
```

`npm run cdn`:

```
   300 viewers · each opens the popular 5 MB file + 4 other files (among 200 files of 300 KB) = 1500 downloads

   path                                        download   cache hit    object storage requests      object storage egress
   no CDN — presigned GET directly                 1500          0%                       1500                  1851.6 MB
   CDN + each viewer's own presigned URL           1500          0%                       1500                  1851.6 MB
   CDN + the CDN's signed token (path cached)      1500         87%                        200                    63.3 MB

   token for one file, a file from another workspace requested: 403 · expired token: 403
```

## কী দেখার জন্য এটা বানানো

- **`through-app` এর buffer সারি:** ৮টা ৬৪ MB এর upload একসাথে = app এর memory ১ GB এর বেশি, আর event loop একবার ৪৩৫ ms
  আটকানো (বড় Buffer জোড়া আর copy)। এটাই 8.1 এর `saveAttachment(input, body: Buffer)`। Stream memory সারায়, কিন্তু
  app কে এখনো প্রতিটা byte বইতে হয়, আর প্রতিটা upload তার পুরো সময় একটা connection ধরে রাখে — ধীর user এ মিনিটের পর মিনিট।
- **`presign` এর ২ আর ৭:** presigned URL একটা **bearer** অনুমতি — মেয়াদের মধ্যে যে কেউ, যতবার খুশি। আর যা sign করা হয়নি
  (এখানে আকার), সেটা কেউ আটকায় না — তাই confirm ধাপে app নিজে `HEAD` করে যাচাই করে।
- **`resume` এর একটা PUT বনাম multipart:** ৬০ MB এ গড়ে একবার ছেঁড়ে এমন network এ ২০০ MB একবারে পার হওয়ার সম্ভাবনা কম
  (e^(−২০০/৬০) ≈ ৩.৬%) — তাই একটা PUT বারবার শুরু থেকে, আর ১৫ বারেও প্রায়ই শেষ হয় না। Multipart এ ছিঁড়লে শুধু একটা টুকরো।
- **Part এর আকার একটা trade-off:** বড় part = প্রতিবার ছিঁড়লে বেশি byte আবার (৬৪ MB এ ১.৭৬ গুণ); ছোট part = বেশি request
  (প্রতিটায় একটা round trip)। Experiment ২ তে round trip ধীর করলে ছোট part এর দাম দেখা যায়।
- **`cdn` এর মাঝের সারি:** CDN থাকলেও প্রত্যেকের presigned URL আলাদা (signature, সময়) — CDN এর cache key আলাদা, তাই একটাও
  hit না। CDN এর নিজের token path আর মেয়াদ যাচাই করে, তারপর token বাদ দিয়ে path এ cache করে — ১৮৫২ MB থেকে ৬৩ MB।

## নিজে ভেঙে দেখুন (Experiments)

1. **কম user, কম memory?** `UPLOADERS=4 ROUNDS=1 npm run through-app`। (এই মেশিনে: buffer এ ৭৯ → ৬২৪ MB — ৮ জনে ১১৫৯ MB;
   প্রতিটা ৬৪ MB এর upload এ ~১৩৫ MB, মানে file এর প্রায় দ্বিগুণ।) ৫০ জন user একসাথে ২ GB এর video upload করলে? (চালাবেন না —
   হিসাব করুন।)
2. **ধীর round trip:** `RTT_MS=600 npm run resume` — খারাপ mobile network। (এই মেশিনে model এ: ৫ MB part ১.৮ মিনিট, ১৬ MB
   part ১.৭ — এবার ছোট part আর সবচেয়ে ভালো না।) TaskFlow এর part এর আকার কত রাখবেন, আর সেটা কি file এর আকার দেখে বদলাবেন?
3. **ভালো network:** `DROP_EVERY_MB=5000 npm run resume` — প্রায় কখনো ছেঁড়ে না। তখন multipart এর লাভ কী থাকে (ইঙ্গিত: একসাথে
   কয়েকটা part — `resume.ts` এ part গুলো সমান্তরালে পাঠানোর একটা সংস্করণ লিখুন)?
4. **Token ছাড়া cache:** `cdn.ts` এ `cdn-presigned` mode এর cache key থেকে query বাদ দিন (`cacheKey = path`)। Hit rate কী হলো?
   আর কী ভাঙল? (ইঙ্গিত: CDN এখন কী যাচাই করছে — কিছু? একজনের presigned URL এর মেয়াদ শেষ হলেও cache থেকে পাবে কি?)
5. **Replay আটকানো:** `presign.ts` এর ২ নম্বরে একই URL দুবার কাজ করল। `If-None-Match: *` header টা sign এর তালিকায় যোগ করে
   (Lesson 8.1 এর conditional write) আবার চালান — দ্বিতীয়বার কী হয়? (যাচাই করা: প্রথমবার 200, একই URL এ দ্বিতীয়বার
   412, আর header বাদ দিয়ে পাঠালে 403 — signature মেলে না।) কোন ধরনের upload এ এটা লাগবে, কোনটায় না?

## Project Structure

```
lesson-8.2-file-upload/
├── docker-compose.yml   # SeaweedFS 4.47 S3 (8336), s3.json দিয়ে authentication চালু, cpus: 2
├── s3.json              # একটা identity — শুধু API server এর credential
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── common.ts        # env, S3 client (checksum এর নিয়ম সহ), bucket + CORS, ধীর/ছিঁড়ে যাওয়া PUT
    ├── app.ts           # TaskFlow API (আলাদা process): buffer / stream / presigned upload, ping, memory মাপা
    ├── through-app.ts   # load দেয়, app এর memory, খোলা upload, event loop তুলনা করে
    ├── presign.ts       # presigned PUT/GET এর নিয়ম, confirm ধাপ, CORS
    ├── resume.ts        # ভাঙা network এ একটা PUT বনাম multipart, tab বন্ধ, অসমাপ্ত upload, model
    └── cdn.ts           # ছোট CDN: presigned URL বনাম CDN token, cache key
```

সব env: `through-app` — `UPLOADERS` (8), `ROUNDS` (2), `FILE_MB` (64), `CLIENT_MBPS` (16), `PINGERS` (4); `resume` —
`FILE_MB` (200), `DROP_EVERY_MB` (60), `NET_MBPS` (2.5), `RTT_MS` (150), `MAX_ATTEMPTS` (15), `MODEL_RUNS` (1000), `SEED`
(11); `cdn` — `VIEWERS` (300), `LONG_TAIL_FILES` (200), `LONG_TAIL_VIEWS` (4), `SEED` (7); সবগুলোতে `S3_ENDPOINT`,
`BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`।
