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
  যাচাই করে নিও। AWS S3 এর সীমাগুলো (part এর ন্যূনতম ৫ MB, সর্বোচ্চ ১০,০০০ part, একটা PUT এ সর্বোচ্চ ৫ GB) documentation
  থেকে; এখানে ন্যূনতম part এর নিয়মটা (`EntityTooSmall`) SeaweedFS ও মানে।
- `through-app` এর "ধীর user" মানে client নিজে গতি বেঁধে রাখে (প্রতি সেকেন্ডে ১৬ MB); app আলাদা process, তার memory আর
  event loop মাপা হয়। আসল process, আসল সময় — সংখ্যা সামান্য বদলাবে।
- `resume` এর upload গুলো আসল (presigned URL, মাঝপথে connection আসলেই কাটা), কিন্তু **সময়** একটা হিসাব — local network
  এ আসল সময় অর্থহীন দ্রুত। কোন byte এ ছিঁড়বে সেটা seed দেওয়া। Default seed ১১ বাছা হয়েছে কারণ তার ছেঁড়ার দূরত্ব গুলো
  (৪৩, ৪৫, ৫৬, ৫৪ MB …) গড় ৬০ MB এর কাছে — অন্য seed এ ভাগ্য অন্য (seed ৭ এ প্রথম দুটো ছেঁড়া ২ MB এর মধ্যে, তারপর আর
  না — তখন সব পদ্ধতি প্রায় সমান)। তাই script এর শেষে একই network এর একটা model, ১০০০টা seed এ — গড় আর p95 সেখান থেকে পড়ো।
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
npm run through-app   # ~৩০ সেকেন্ড
npm run presign       # ~৫ সেকেন্ড (একটা মেয়াদ শেষ হওয়ার অপেক্ষা সহ)
npm run resume        # ~১ মিনিট
npm run cdn           # ~১৫ সেকেন্ড
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run through-app` (এই মেশিনে):

```
   পথ                                       app এর memory (শুরু → সর্বোচ্চ)   app এ একসাথে খোলা upload   app এর ভেতর দিয়ে   ping p50 / p99      event loop দেরি p99 / max   সব upload শেষ
   শুধু ping                                            81 → 99 MB                        0             0.0 MB   0.5 ms / 2.1 ms              1.5 ms / 6.2 ms              —
   buffer (পুরো file memory তে)                       79 → 1159 MB                        8          1024.0 MB   0.4 ms / 2.2 ms            1.8 ms / 434.6 ms        13.71 s
   stream (app এর ভেতর দিয়ে বয়ে যায়)                80 → 111 MB                        8          1024.0 MB   0.5 ms / 1.3 ms             1.6 ms / 19.5 ms         8.19 s
   presigned (সরাসরি object storage এ)                  79 → 99 MB                        0             0.0 MB   0.5 ms / 1.2 ms             1.6 ms / 16.7 ms         8.19 s
```

মিলতে হবে: buffer এ memory কয়েকশো MB থেকে GB এর ঘরে; stream এ memory প্রায় সমান কিন্তু ৮টা upload খোলা আর ১ GB app এর ভেতর
দিয়ে; presigned এ দুটোই শূন্য।

`npm run presign`:

```
── Upload এর presigned URL (PUT) ──
    1. ঠিক file, ঠিক content-type                                     → 200
    2. একই URL দিয়ে আবার (মেয়াদের মধ্যে)                            → 200
    3. একই URL, content-type বদলে (text/html)                         → 403
    4. URL এর key বদলে অন্য object এ লেখার চেষ্টা                     → 403
    5. বড় file, একই URL (আকার sign করা)                              → 403
    6. মেয়াদ ২ s, ৩.৫ s পরে ব্যবহার                                  → 403
    7. আকার sign না করা URL এ ৫০ গুণ বড় file                         → 200
    8. SDK এর default checksum সহ sign করা URL                        → 400 BadDigest

── Confirm: browser বলল "শেষ", app যাচাই করে ──
       ঠিকঠাক upload                            → ready (ETag "…")
       URL নিয়েছে, upload করেনি                → rejected: object নেই — upload হয়নি
       আকার sign ছিল না, বড় file এসেছে         → rejected: আকার 1500 (বলা ছিল 30) — object মুছে ফেলা হলো

── Download এর presigned URL (GET) ──
    9. presigned GET                                                  → 200 · attachment; filename*=UTF-8''…
   10. একই object, signature ছাড়া                                    → 403

── CORS … (preflight) ──
       https://app.taskflow.test                → 200 · allow-origin: https://app.taskflow.test
       https://evil.example                     → 403 · allow-origin: (নেই)
```

`npm run resume` (seed ১১):

```
   পদ্ধতি                               শেষ হলো?   পাঠানো      file এর কত গুণ   request   ছিঁড়েছে   আনুমানিক সময়   MD5 মিলেছে   ETag
   একটা PUT, network ঠিক থাকলে             হ্যাঁ    200.0 MB           1.00         1         0      1.3 মিনিট       হ্যাঁ   "…"
   একটা PUT, ভাঙা network                     না    819.3 MB           4.10        15        15      5.5 মিনিট           —
   multipart, 5 MB part                    হ্যাঁ    208.0 MB           1.04        44         4      1.5 মিনিট       হ্যাঁ   "…-40"
   multipart, 16 MB part                   হ্যাঁ    238.0 MB           1.19        17         4      1.6 মিনিট       হ্যাঁ   "…-13"
   multipart, 64 MB part                   হ্যাঁ    758.7 MB           3.79        18        14      5.1 মিনিট       হ্যাঁ   "…-4"
   multipart, 16 MB, মাঝপথে tab বন্ধ       হ্যাঁ    238.0 MB           1.19        17         4      1.6 মিনিট       হ্যাঁ   "…-13"
                                        13 টা part, 4 টা আবার · tab বন্ধের পরে 6 টা আগে থেকেই ছিল

── Model: একই network, 1000 টা আলাদা seed (IO ছাড়া, শুধু byte এর হিসাব) ──
   পদ্ধতি                    শেষ হলো    পাঠানো (গড়, file এর গুণ)   সময় গড়      সময় p95      request গড়
   একটা PUT                      43%                       2.61    3.5 মিনিট    6.5 মিনিট            7
   multipart, 5 MB part         100%                       1.04    1.5 মিনিট    1.6 মিনিট           43
   multipart, 16 MB part        100%                       1.14    1.6 মিনিট    1.8 মিনিট           17
   multipart, 64 MB part        100%                       1.76    2.4 মিনিট    3.7 মিনিট           10

── অসমাপ্ত upload (৩টা part পাঠিয়ে user চলে গেল) ──
   LIST objects এ দেখা যায়: 0 টা · অসমাপ্ত multipart upload: 1 টা, part গুলোর জায়গা 24.0 MB
   AbortMultipartUpload এর পরে অসমাপ্ত upload: 0 টা
```

`npm run cdn`:

```
   300 জন viewer · প্রত্যেকে জনপ্রিয় 5 MB file + 4 টা অন্য file (200 টা 300 KB এর মধ্যে) = 1500 টা download

   পথ                                          download   cache hit   object storage এ request   object storage থেকে বেরোল
   CDN নেই — সরাসরি presigned GET                  1500          0%                       1500                  1851.6 MB
   CDN + প্রত্যেকের নিজের presigned URL            1500          0%                       1500                  1851.6 MB
   CDN + CDN এর signed token (path এ cache)        1500         87%                        200                    63.3 MB

   token এক file এর, চাওয়া অন্য workspace এর file: 403 · মেয়াদ পেরোনো token: 403
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

## নিজে ভেঙে দেখো (Experiments)

1. **কম user, কম memory?** `UPLOADERS=4 ROUNDS=1 npm run through-app`। (এই মেশিনে: buffer এ ৭৯ → ৬২৪ MB — ৮ জনে ১১৫৯ MB;
   প্রতিটা ৬৪ MB এর upload এ ~১৩৫ MB, মানে file এর প্রায় দ্বিগুণ।) ৫০ জন user একসাথে ২ GB এর video upload করলে? (চালিয়ো না —
   হিসাব করো।)
2. **ধীর round trip:** `RTT_MS=600 npm run resume` — খারাপ mobile network। (এই মেশিনে model এ: ৫ MB part ১.৮ মিনিট, ১৬ MB
   part ১.৭ — এবার ছোট part আর সবচেয়ে ভালো না।) TaskFlow এর part এর আকার কত রাখবে, আর সেটা কি file এর আকার দেখে বদলাবে?
3. **ভালো network:** `DROP_EVERY_MB=5000 npm run resume` — প্রায় কখনো ছেঁড়ে না। তখন multipart এর লাভ কী থাকে (ইঙ্গিত: একসাথে
   কয়েকটা part — `resume.ts` এ part গুলো সমান্তরালে পাঠানোর একটা সংস্করণ লেখো)?
4. **Token ছাড়া cache:** `cdn.ts` এ `cdn-presigned` mode এর cache key থেকে query বাদ দাও (`cacheKey = path`)। Hit rate কী হলো?
   আর কী ভাঙল? (ইঙ্গিত: CDN এখন কী যাচাই করছে — কিছু? একজনের presigned URL এর মেয়াদ শেষ হলেও cache থেকে পাবে কি?)
5. **Replay আটকানো:** `presign.ts` এর ২ নম্বরে একই URL দুবার কাজ করল। `If-None-Match: *` header টা sign এর তালিকায় যোগ করে
   (Lesson 8.1 এর conditional write) আবার চালাও — দ্বিতীয়বার কী হয়? (যাচাই করা: প্রথমবার 200, একই URL এ দ্বিতীয়বার
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
