# Lesson 8.2 - File Upload at Scale: Presigned URL, Multipart, CDN Delivery

**Module 8 - Storage Systems**

> **Spaced Repetition (Lesson 3.3):** Nginx এর `client_max_body_size` কী, আর তার default কত? আর reverse proxy হিসেবে Nginx একটা request এর body নিয়ে কী করে - backend এ পাঠানোর আগে? আজ একটা ২ GB এর upload এই দুটো প্রশ্নের সাথেই প্রথম ধাক্কা খাবে।

**Prerequisite:** Lesson 2.5 (Idempotency), Lesson 3.3 (Nginx reverse proxy), Lesson 4.5 (CDN), Lesson 7.1 (Little's Law, খোলা request কী ধরে রাখে), Lesson 7.4 (Retry), Lesson 7.5 (Outbox), Lesson 8.1 (Object storage, key, dual write এর ক্রম)

**আপনি এই lesson শেষে পারবেন:**

1. কেন বড় file app server এর ভেতর দিয়ে upload হওয়া উচিত না - memory, connection আর সময় ধরে সংখ্যা দিয়ে বলতে পারবেন; আর presigned URL দিয়ে browser কে সরাসরি object storage এ পাঠানোর flow design করতে পারবেন - কী sign করবেন, কতক্ষণের জন্য, আর upload এর পরে কী যাচাই করবেন
2. Multipart upload দিয়ে বড় file কে ভাঙা network এও নির্ভরযোগ্যভাবে পাঠাতে পারবেন - part এর আকার বাছা, একটা part আবার পাঠানো, tab বন্ধের পরে যেখানে থেমেছিল সেখান থেকে শুরু, আর অসমাপ্ত upload পরিষ্কার
3. Private file CDN দিয়ে দেওয়ার design করতে পারবেন - কেন প্রত্যেকের presigned URL CDN এর cache ভেঙে দেয়, CDN এর নিজের signed URL/cookie কীভাবে সেটা সারায়, আর user এর upload করা file কোন domain থেকে কীভাবে দেবেন

**Tier:** 1 - Runnable Code (Docker এ SeaweedFS - S3-compatible, authentication চালু; আসল presigned URL, মাঝপথে আসলেই কাটা connection, আর একটা ছোট CDN)

---

## ০. TaskFlow এখন কোথায়

Lesson 8.1 এ attachment এর bytes database থেকে বেরিয়ে object storage এ গেছে। Database এ শুধু metadata, download app এর ভেতর দিয়ে যায় না। কিন্তু **upload** এখনো সেই পুরনো পথে: browser file টা Express এ পাঠায়, Express সেটা memory তে নেয়, তারপর object storage এ `PUT` - 8.1 এর `saveAttachment(input, body: Buffer)`।

তারপর TaskFlow এর সবচেয়ে বড় customer - একটা design agency - screen recording attach করা শুরু করল। এক সপ্তাহে তিনটা ঘটনা:

1. **সোমবার:** প্রথম ২ GB এর video - user দেখল `413 Request Entity Too Large`। Nginx এর `client_max_body_size` ১০০ MB রাখা ছিল। কেউ সেটা ৫ GB করে দিল। বুধবার দুপুরে একসাথে চারজন বড় file upload করল - একটা Express instance এর memory ফুরাল, container OOM-kill হলো, আর সেই instance এ থাকা বাকি সবার request `502`।
2. **বৃহস্পতিবার:** একজন designer train এ বসে ৮০০ MB এর file upload করছিল। ৯০% এ network চলে গেল - upload শুরু থেকে আবার। তিনবার। Support ticket: _"আপনাদের upload কাজই করে না।"_
3. **শুক্রবার:** agency টা তাদের customer দের নিয়ে একটা webinar করল, আর chat এ দিল একটা release notes এর PDF এর link। ৩০০ জন একসাথে খুলল। Object storage এর বিল এর egress এর লাইন এক দিনে পুরো মাসের সমান। আর Singapore এর viewer রা বলল PDF খুলতে ৮ সেকেন্ড।

তিনটা ঘটনা, তিনটা আলাদা প্রশ্ন: file app এর ভেতর দিয়ে যাবে কেন (১.১–১.২), বড় file ভাঙা network এ কীভাবে পৌঁছাবে (১.৩), আর একই file হাজার জন কীভাবে দ্রুত আর সস্তায় পাবে (১.৫)।

---

## ১. Theory

### ১.১ Upload app এর ভেতর দিয়ে - কী কী ধরে রাখে

প্রথমে spaced repetition এর উত্তর, কারণ সোমবারের প্রথম ধাক্কা সেখানেই। Nginx এর `client_max_body_size` এর default **১ MB** - তার বেশি হলে `413`। আর reverse proxy হিসেবে Nginx default এ (`proxy_request_buffering on`) পুরো request body আগে নিজে নেয় - ছোট হলে memory তে, বড় হলে disk এর temp file এ - তারপর backend এ পাঠায়। মানে ২ GB এর upload এ Nginx এর disk এ ২ GB, তারপর Express এর কাছে আরেকবার ২ GB। সীমা বাড়ানো এক লাইনের কাজ; আসল প্রশ্ন হলো সীমার পেছনে কী আছে।

Exercise এর `npm run through-app`: TaskFlow এর API একটা আলাদা process এ, আর ৮ জন user একসাথে ২টা করে ৬৪ MB এর file upload করে - প্রত্যেকে প্রতি সেকেন্ডে ১৬ MB গতিতে (ভালো broadband)। তিনটা পথ:

```
   path                                      app memory start→peak     uploads open at once    through the app   ping p50 / p99          event loop p99 / max   uploads done
   ping only                                            81 → 99 MB                        0             0.0 MB   0.5 ms / 2.1 ms              1.5 ms / 6.2 ms              -
   buffer (whole file in memory)                      79 → 1159 MB                        8          1024.0 MB   0.4 ms / 2.2 ms            1.8 ms / 434.6 ms        13.71 s
   stream (flows through the app)                      80 → 111 MB                        8          1024.0 MB   0.5 ms / 1.3 ms             1.6 ms / 19.5 ms         8.19 s
   presigned (straight to object storage)               79 → 99 MB                        0             0.0 MB   0.5 ms / 1.2 ms             1.6 ms / 16.7 ms         8.19 s
```

- **Buffer (8.1 এর পথ):** ৮টা ৬৪ MB এর file একসাথে = app এর memory ৭৯ MB থেকে **১১৫৯ MB**। প্রতিটা upload এ file এর প্রায় দ্বিগুণ (Buffer জোড়া, SDK এর copy)। আর event loop একবার ৪৩৫ ms আটকানো। Experiment ১: ৪ জনে ৬২৪ MB - রৈখিক। ৫০ জন একসাথে ২ GB এর video মানে প্রায় ২০০ GB memory - সোমবারের OOM-kill এর হিসাব।
- **Stream:** memory সমস্যা সারে - ১১১ MB, কারণ body টুকরো টুকরো আসে আর সাথে সাথে object storage এর দিকে চলে যায়; পুরোটা কখনো একসাথে memory তে থাকে না। Node এ `req` নিজেই একটা stream - সেটাই `Body` হিসেবে দেওয়া যায় (Lesson 7.4 এর backpressure এর ধারণা এখানে কাজ করে: object storage ধীর হলে stream থামে, memory ভরে না)। কিন্তু দুটো জিনিস বদলায় না: **১ GB এখনো app এর network দিয়ে যায়** (ঢোকা আর বেরোনো দুটোই), আর **প্রতিটা upload তার পুরো সময় একটা connection ধরে রাখে**।
- **Presigned:** app শুধু একটা URL দেয় - কয়েক ms এর একটা request। File app কে ছোঁয়ই না।

দ্বিতীয় বিষয়টা Lesson 7.1 এর Little's Law এ বড় দেখায়। একসাথে চলা upload = প্রতি সেকেন্ডে শুরু হওয়া upload × প্রতিটার সময়। Exercise এ প্রতিটা ৪ সেকেন্ড, কারণ user দের গতি ভালো। কিন্তু সেই train এর designer:

```
  ৮০০ MB, mobile এ ~২০ Mbps (≈ ২.৫ MB/s)   →   ~৫ মিনিট ১টা request খোলা
  ২ GB,  একই গতিতে                          →   ~১৪ মিনিট
```

এই পুরো সময় Nginx এর একটা connection, Express এর একটা socket, আর (stream এ) object storage এর দিকে একটা খোলা request - আর Nginx এর `proxy_read_timeout`, load balancer এর idle timeout, deploy এর graceful shutdown এর grace period (Lesson 3.4, 7.3) - সবকিছুর সাথে লড়াই। একটা deploy মানে চলমান প্রতিটা ১৪ মিনিটের upload হয় আটকে রাখতে হবে, নয়তো কেটে দিতে হবে। App server এর কাজ ছোট, দ্রুত request এর জন্য বানানো; ঘণ্টার চতুর্থাংশ ধরে byte বওয়া তার কাজ না।

তাহলে উপায়: file টা app এর ভেতর দিয়ে না - browser থেকে **সরাসরি** object storage এ। কিন্তু object storage private (8.1), আর তার credential browser কে দেওয়া যায় না।

### ১.২ Presigned URL - সীমিত, সময়বাঁধা অনুমতি

**Presigned URL** - এমন একটা URL যার ভেতরে একটা নির্দিষ্ট কাজের (যেমন "এই bucket এর এই key তে PUT") অনুমতি, একটা মেয়াদ, আর server এর গোপন key দিয়ে বানানো একটা signature আছে; যার হাতে URL, সে মেয়াদের মধ্যে ঠিক সেই কাজটা করতে পারে - credential ছাড়াই।

```
  browser                          TaskFlow API                          object storage
  ───────                          ────────────                          ──────────────
  POST /api/attachments/uploads ─►  permission আছে? (task এ attach করতে পারে?)
  { fileName, size, contentType }   key বানায়: ws/12/att/{uuid}
                                    pending row লেখে (১.৪)
                                    URL sign করে (৫ মিনিট, এই key, এই আকার, এই ধরন)
                               ◄─  { attachmentId, url }
  PUT url  (২ GB, সরাসরি) ──────────────────────────────────────────►  signature যাচাই → লেখে
                               ◄──────────────────────────────────────  200 + ETag
  POST /api/attachments/:id/complete ─►  HEAD দিয়ে যাচাই (আকার, ধরন) → ready
```

Signature টা কীভাবে কাজ করে, এক প্যারাগ্রাফে: API server আর object storage দুজনেই একটা secret key জানে (browser না)। API request এর মূল অংশগুলো - method, bucket, key, মেয়াদ, আর যে header গুলো "sign করা" - একটা নির্দিষ্ট নিয়মে একটা string এ সাজায়, আর secret key দিয়ে তার HMAC বানায় (AWS এর Signature Version 4)। Object storage request পেয়ে ঠিক একই string নিজে বানায়, নিজের কাছে থাকা secret দিয়ে HMAC গোনে, আর মেলায়। একটা অক্ষর বদলালেও মেলে না। কোনো database lookup নেই, কোনো session নেই - অনুমতিটা URL এর ভেতরেই।

তাহলে এই URL হাতে পেলে কেউ কী পারে? Exercise এর `npm run presign`, আসল request দিয়ে:

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
```

তিনটা শিক্ষা:

- **যা sign করা, শুধু সেটাই আটকায়।** ৩ আর ৫ এ `403` কারণ content-type আর content-length কে আমরা স্পষ্টভাবে sign এর তালিকায় রেখেছি। ৭ এ আকার sign করা ছিল না - কেউ ৫০ গুণ বড় file দিল, আর সেটা চলে গেল। Default এ presigned PUT আকার বাঁধে না। তাই হয় আকার sign করুন (browser নিজেই সঠিক `Content-Length` পাঠায়), নয়তো upload এর পরে যাচাই করুন - ভালো হলো দুটোই (১.৪)। (S3 এর আরেকটা রূপ আছে - presigned POST, একটা policy সহ, যেখানে `content-length-range` দিয়ে "১ থেকে ১০০ MB" এর মতো সীমা দেওয়া যায়।)
- **Presigned URL একটা bearer অনুমতি** (২): মেয়াদের মধ্যে যার হাতে, যতবার খুশি। কারো browser এর history, একটা log, বা একটা ভুল করে share করা link - সবই অনুমতি। তাই মেয়াদ ছোট (upload এ কয়েক মিনিট - শুধু **শুরু** করার জন্য; চলমান upload মেয়াদ পেরোলেও শেষ হয়), key প্রতিবার নতুন (server বানায়, client কখনো না - ৪ এর মতো অন্যের object এ লেখা আটকাতে), আর দরকার হলে replay আটকানো: experiment ৫ এ `If-None-Match: *` sign করলে একই URL দ্বিতীয়বার `412`।
- **একটা বাস্তব ফাঁদ** (৮): AWS SDK for JavaScript v3 এর নতুন version default এ presigned PUT এর URL এ body এর একটা checksum বসায় - কিন্তু sign করার সময় body নেই, তাই খালি body এর checksum। আসল file এলে server বলে `BadDigest`। Client এ `requestChecksumCalculation: 'WHEN_REQUIRED'`। এই ধরনের জিনিস documentation এর এক কোণে থাকে, আর production এ প্রথম দিন ধরা পড়ে - তাই upload এর পথের একটা end-to-end test রাখুন।

**CORS।** Browser এর page `app.taskflow.test` থেকে, আর PUT যাচ্ছে object storage এর domain এ - অন্য origin। Browser নিজের নিরাপত্তার নিয়মে আগে জিজ্ঞেস করে।

**CORS (Cross-Origin Resource Sharing) আর preflight** - browser এক origin (domain + port) এর page থেকে অন্য origin এ এমন request পাঠানোর আগে (যেমন custom header সহ PUT) একটা `OPTIONS` request - preflight - পাঠিয়ে জিজ্ঞেস করে "এই origin থেকে এই method চলবে?"; server এর উত্তরে অনুমতি না থাকলে browser আসল request পাঠায়ই না।

```
── CORS … (preflight) ──
       https://app.taskflow.test                → 200 · allow-origin: https://app.taskflow.test
       https://evil.example                     → 403 · allow-origin: (none)
```

তাই bucket এ একটা CORS নিয়ম লাগে: শুধু TaskFlow এর origin, শুধু `PUT` আর `GET`, আর `ETag` header কে "expose" করা - multipart এ browser কে প্রতিটা part এর ETag পড়তে হয় (১.৩)। (সতর্কতা: CORS শুধু browser এর নিয়ম। `curl` দিয়ে যে কেউ presigned URL ব্যবহার করতে পারে - নিরাপত্তা আসে signature থেকে, CORS থেকে না।)

### ১.৩ Multipart Upload - বড় file, ভাঙা network

বৃহস্পতিবারের সমস্যা: একটা PUT মানে একটা লম্বা TCP connection। মাঝপথে ছিঁড়লে - ৯০% এ হলেও - object storage অর্ধেক body ফেলে দেয় (8.1: object হয় পুরোটা, নয়তো কিছুই না), আর upload শুরু থেকে।

**Multipart upload** - একটা বড় object কে কয়েকটা part এ ভাগ করে আলাদা আলাদা request এ পাঠানো: প্রথমে upload শুরু করে একটা `UploadId` নেওয়া, তারপর প্রতিটা part (নম্বর সহ) আলাদা PUT এ - যেকোনো ক্রমে, সমান্তরালে, আর ব্যর্থ হলে শুধু সেই part আবার - আর শেষে সব part এর নম্বর আর ETag দিয়ে "complete" বললে object storage সেগুলো জুড়ে একটা object বানায়।

```
  1. CreateMultipartUpload(key)                         → UploadId           (app, server থেকে)
  2. UploadPart(UploadId, PartNumber=1, bytes 0–16 MB)  → ETag₁              (browser, presigned URL)
     UploadPart(UploadId, PartNumber=2, bytes 16–32 MB) → ✗ ছিঁড়ল → আবার → ETag₂
     …                                                                        (সমান্তরালে চলতে পারে)
     UploadPart(UploadId, PartNumber=13, শেষ টুকরো)     → ETag₁₃
  3. CompleteMultipartUpload(UploadId, [(1,ETag₁) … (13,ETag₁₃)])  → object তৈরি   (app)
     বা AbortMultipartUpload(UploadId) → সব part মুছে যায়
```

S3 এর নিয়ম (documentation থেকে): শেষেরটা ছাড়া প্রতিটা part অন্তত ৫ MB, সর্বোচ্চ ১০,০০০টা part, আর একটা সাধারণ PUT এ সর্বোচ্চ ৫ GB - তার বেশি হলে multipart বাধ্যতামূলক। Multipart এ তৈরি object এর ETag আর content এর MD5 না - part গুলোর MD5 থেকে বানানো, শেষে `-13` এর মতো part এর সংখ্যা (8.1 এ বলেছিলাম "multipart এ না")।

**Resumable upload** - এমন upload যেটা মাঝপথে থামলে (network, tab বন্ধ, laptop ঘুম) শুরু থেকে না, যেখানে থেমেছিল সেখান থেকে চলে; multipart এ সেটা আসে `ListParts` থেকে - object storage বলে দেয় কোন part গুলো ইতিমধ্যে পৌঁছেছে।

Exercise এর `npm run resume`: ২০০ MB এর file, এমন network এ যেটা গড়ে প্রতি ৬০ MB পাঠানোর পরে ছিঁড়ে যায়। Upload গুলো আসল - presigned URL, আর connection আসলেই মাঝপথে কাটা; "সময়" একটা হিসাব: ২.৫ MB/s (≈২০ Mbps) আর প্রতি request এ ১৫০ ms:

```
   method                                  done?        sent    × file size  requests      torn      est. time   MD5 match   ETag
   one PUT, network fine                     yes    200.0 MB           1.00         1         0        1.3 min         yes   "…"
   one PUT, broken network                    no    819.3 MB           4.10        15        15        5.5 min           -
   multipart, 5 MB part                      yes    208.0 MB           1.04        44         4        1.5 min         yes   "…-40"
   multipart, 16 MB part                     yes    238.0 MB           1.19        17         4        1.6 min         yes   "…-13"
   multipart, 64 MB part                     yes    758.7 MB           3.79        18        14        5.1 min         yes   "…-4"
   multipart, 16 MB, tab closed midway       yes    238.0 MB           1.19        17         4        1.6 min         yes   "…-13"
                                        13 parts, 4 resent · after closing the tab 6 were already there
```

একটা run একটা ভাগ্য - তাই script শেষে একই network এর একটা model চালায়, ১০০০টা আলাদা seed এ:

```
── Model: the same network, 1000 different seeds (no IO, just byte accounting) ──
   method                       done    sent (avg, × file size)     time avg     time p95     requests
   one PUT                       43%                       2.61      3.5 min      6.5 min            7
   multipart, 5 MB part         100%                       1.04      1.5 min      1.6 min           43
   multipart, 16 MB part        100%                       1.14      1.6 min      1.8 min           17
   multipart, 64 MB part        100%                       1.76      2.4 min      3.7 min           10
```

- **একটা PUT:** ২০০ MB একবারে পার হওয়ার সম্ভাবনা e^(−২০০/৬০) ≈ ৩.৬%। প্রতিটা চেষ্টা গড়ে কিছুদূর গিয়ে ছেঁড়ে, আর সেই byte গুলো নষ্ট। আসল run এ ১৫ বার চেষ্টা, ৮১৯ MB পাঠানো (file এর চার গুণ) - আর তবু শেষ হয়নি। Model এ ১৫ বারের মধ্যে শেষ হয় মাত্র ৪৩% ক্ষেত্রে। বৃহস্পতিবারের designer।
- **Multipart:** প্রতিবার ছিঁড়লে নষ্ট হয় শুধু একটা part এর অংশ - ১০০% শেষ, ১৬ MB part এ মাত্র ১৪% বাড়তি byte।
- **Part এর আকার একটা trade-off** - Lesson 7.4 এর batch এর মতোই। বড় part মানে প্রতিটা ছেঁড়ায় বেশি নষ্ট: ৬৪ MB এ ১.৭৬ গুণ, আর আসল run এ ৩.৭৯ - একটা part বারবার ছিঁড়েছে। ছোট part মানে বেশি request, প্রতিটায় একটা round trip - ৫ MB এ ৪৩টা। Experiment ২: round trip ৬০০ ms হলে (খারাপ mobile) ৫ MB আর সবচেয়ে ভালো না (১.৮ মিনিট বনাম ১৬ MB এর ১.৭)। বাস্তবে একটা মাঝামাঝি আকার (৮–১৬ MB), আর file খুব বড় হলে বাড়ানো, যাতে ১০,০০০ part এর সীমা না ছাড়ায়।
- **Tab বন্ধ:** browser এর memory তে কোন part শেষ তার তালিকা ছিল, সেটা গেল। ফিরে এসে app `ListParts` জিজ্ঞেস করে - ৬টা আগে থেকেই আছে - আর বাকি ৭টা পাঠায়। একটা byte ও আবার যায়নি। (তাই `UploadId` টা database এর pending row এ রাখুন, browser এর memory তে শুধু না।)

আর multipart এর আরেকটা সুবিধা, ভাঙা network ছাড়াও: part গুলো **সমান্তরালে** যেতে পারে। দূরের region এ, বেশি latency র link এ, একটা TCP connection প্রায়ই পুরো bandwidth ব্যবহার করতে পারে না; ৪টা part একসাথে পাঠালে পারে। (Experiment ৩ এর প্রশ্ন।)

**অসমাপ্ত upload এর দাম:**

```
── Unfinished upload (3 parts sent, then the user left) ──
   visible in LIST objects: 0 · unfinished multipart uploads: 1, space used by parts 24.0 MB
   unfinished uploads after AbortMultipartUpload: 0
```

User চলে গেলে তার পাঠানো part গুলো object storage এ থেকে যায় - কোনো object হিসেবে দেখা যায় না (`LIST` এ ০টা), কিন্তু জায়গা নেয় আর বিল হয়। হাজার হাজার ব্যর্থ বড় upload মানে নীরবে জমা হওয়া terabyte। সমাধান: bucket এর lifecycle এ "অসমাপ্ত multipart upload ৭ দিন পরে abort" (S3 এর `AbortIncompleteMultipartUpload` rule) - প্রায় প্রতিটা bucket এ রাখার মতো একটা নিয়ম।

(বাস্তবে এই পুরো ব্যাপারটা হাতে লিখতে হয় না - browser এর জন্য Uppy এর মতো library, আর AWS SDK এর `@aws-sdk/lib-storage` এর `Upload` - part এ ভাগ, সমান্তরালে পাঠানো, retry সব নিজে করে। কিন্তু কোন সংখ্যা বাছবেন আর কী ভাঙতে পারে, সেটা জানতে হয়।)

### ১.৪ Upload এর জীবন - pending থেকে ready

Presigned URL এ file এখন app এর ভেতর দিয়ে যায় না - তাহলে app জানে কীভাবে যে upload শেষ হলো, আর ঠিকঠাক হলো? আবার 8.1 এর dual write, এবার তিন ধাপে: row, object, আর "শেষ" এর খবর।

Attachment এর অবস্থা একটা discriminated union - optional field এর জঙ্গল না (main.md এর নিয়ম, আর এখানে কারণটা স্পষ্ট: `ready` না হলে `etag` নেই, `rejected` না হলে `reason` নেই):

```typescript
type Attachment =
	| {
			status: 'pending';
			id: number;
			storageKey: string;
			declaredSize: number;
			contentType: string;
			uploadId: string | null;
			createdAt: Date;
	  }
	| { status: 'ready'; id: number; storageKey: string; size: number; etag: string }
	| { status: 'rejected'; id: number; storageKey: string; reason: string };
```

Confirm ধাপে app browser কে বিশ্বাস করে না - object storage কে জিজ্ঞেস করে:

```
── Confirm: the browser said "done", the app verifies ──
       correct upload                           → ready (ETag "…")
       took the URL, never uploaded             → rejected: no object - not uploaded
       size not signed, a bigger file arrived   → rejected: size 1500 (declared 30) - object deleted
```

পুরো flow, ব্যর্থতার জায়গা সহ:

```
  ১. POST /uploads     → pending row (database)            crash → row আছে, object নেই → রাতের job: ২৪ ঘণ্টার পুরনো pending → মুছে ফেলুন
  ২. browser PUT       → object (object storage)          ছিঁড়ল → multipart এ শুধু part আবার; user চলে গেল → lifecycle abort
  ৩. POST /complete    → HEAD, যাচাই, ready + outbox event   browser কখনো ডাকল না (tab বন্ধ ঠিক শেষ byte এর পরে) → ↓
  ৪. (বিকল্প) object storage এর event notification ("ObjectCreated") → একই complete, idempotent
```

তৃতীয় ধাপের সূক্ষ্মতা: browser শেষ byte পাঠিয়ে complete ডাকার আগেই বন্ধ হতে পারে। তখন object আছে, row pending - user এর চোখে "upload হচ্ছে…" চিরকাল। দুটো উত্তর, সাধারণত দুটোই: object storage এর নিজের event notification (S3 নতুন object হলে একটা queue তে খবর দিতে পারে - Lesson 7.2), আর একটা job যেটা পুরনো pending row এর জন্য `HEAD` করে দেখে। তিনটা পথই একই `complete` function ডাকে - তাই সেটা idempotent হতে হবে (Lesson 7.4): ইতিমধ্যে `ready` হলে কিছু না।

আর `ready` হওয়ার transaction এ একটা outbox row (Lesson 7.5) - `attachment.uploaded` event। সেখান থেকে বাকি সব: thumbnail বানানো (BullMQ job, 7.3), virus scan (scan শেষ না হওয়া পর্যন্ত অন্যদের কাছে download বন্ধ রাখা - তাহলে union এ একটা `scanning` অবস্থা), আর search index (8.3)।

TaskFlow এর SvelteKit এর দিকে এর চেহারা (উদাহরণ - exercise এ browser নেই, তাই এই অংশ চালানো হয়নি; একই HTTP ধাপ গুলো exercise এ Node থেকে যাচাই করা):

```typescript
// src/routes/api/attachments/uploads/+server.ts - a SvelteKit server route (BFF, Lesson 9.2)
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { startUpload } from '$lib/server/attachments';

const bodySchema = z.object({
	taskId: z.number().int().positive(),
	fileName: z.string().min(1).max(255),
	contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
	size: z
		.number()
		.int()
		.positive()
		.max(20 * 1024 ** 3) // 20 GB - the business limit, right here
});

export const POST: RequestHandler = async ({ request, locals }) => {
	// locals.user - set from the session in hooks.server.ts, typed via App.Locals augmentation in app.d.ts
	if (!locals.user) error(401, 'login required');
	const input = bodySchema.parse(await request.json());
	// startUpload: checks permission on the task, builds the key, the pending row, and
	// for a small file one presigned PUT, for a big file starts multipart + a presigned URL per part
	return json(await startUpload(locals.user.id, input), { status: 201 });
};
```

```svelte
<!-- src/lib/components/AttachmentUpload.svelte - Svelte 5 -->
<script lang="ts">
	import type { UploadPlan } from '$lib/attachments';

	let { taskId, onDone }: { taskId: number; onDone: (id: number) => void } = $props();

	type Phase =
		| { state: 'idle' }
		| { state: 'uploading'; sent: number; total: number }
		| { state: 'failed'; message: string };
	let phase = $state<Phase>({ state: 'idle' });

	// fetch has no upload progress events (not in every browser yet) - hence XMLHttpRequest
	function put(
		url: string,
		body: Blob,
		contentType: string | null,
		onProgress: (n: number) => void
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', url);
			if (contentType) xhr.setRequestHeader('content-type', contentType); // must send exactly the signed type
			xhr.upload.onprogress = (e) => onProgress(e.loaded);
			xhr.onload = () =>
				xhr.status === 200
					? resolve(xhr.getResponseHeader('ETag') ?? '')
					: reject(new Error(`PUT ${xhr.status}`));
			xhr.onerror = () => reject(new Error('network'));
			xhr.send(body); // the browser sets Content-Length itself - the Blob's size, which was signed
		});
	}

	async function retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
		for (let i = 1; ; i++) {
			try {
				return await fn();
			} catch (e: unknown) {
				if (i >= attempts) throw e;
				await new Promise((r) => setTimeout(r, Math.random() * 1000 * 2 ** i)); // full jitter, 7.4
			}
		}
	}

	async function upload(file: File): Promise<void> {
		const res = await fetch('/api/attachments/uploads', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				taskId,
				fileName: file.name,
				contentType: file.type || 'application/octet-stream',
				size: file.size
			})
		});
		if (!res.ok) {
			phase = { state: 'failed', message: `Could not start (${res.status})` };
			return;
		}
		const plan: UploadPlan = await res.json(); // our own server's type - so trusted here; anything external would get Zod
		const done = new Array<number>(plan.kind === 'multipart' ? plan.partUrls.length : 1).fill(0);
		const progress = (i: number) => (n: number) => {
			done[i] = n;
			phase = { state: 'uploading', sent: done.reduce((a, b) => a + b, 0), total: file.size };
		};
		try {
			if (plan.kind === 'single') {
				await retry(() =>
					put(plan.url, file, file.type || 'application/octet-stream', progress(0))
				);
			} else {
				// one at a time only to keep the example simple; in practice 3–4 at once
				for (const [i, url] of plan.partUrls.entries()) {
					const part = file.slice(i * plan.partSize, (i + 1) * plan.partSize);
					await retry(() => put(url, part, null, progress(i)));
				}
			}
			// the server verifies with ListParts/HEAD itself - it doesn't trust ETags sent by the browser
			const ok = await fetch(`/api/attachments/${plan.attachmentId}/complete`, { method: 'POST' });
			if (!ok.ok) throw new Error(`complete ${ok.status}`);
			onDone(plan.attachmentId);
		} catch (e: unknown) {
			phase = { state: 'failed', message: e instanceof Error ? e.message : 'Unknown error' };
		}
	}
</script>

<input
	type="file"
	onchange={(e) => {
		const f = e.currentTarget.files?.[0];
		if (f) void upload(f);
	}}
/>
{#if phase.state === 'uploading'}
	<progress max={phase.total} value={phase.sent}></progress>
{:else if phase.state === 'failed'}
	<p role="alert">{phase.message}</p>
{/if}
```

(`UploadPlan` হলো server এর নিজের discriminated union - `{ kind: 'single'; attachmentId; url } | { kind: 'multipart'; attachmentId; partSize; partUrls }`। আর `res.json()` এর ফল server এর নিজের code এর - তাই type টা বিশ্বাস করা হয়েছে; কোনো বাইরের API এর উত্তর হলে এখানে Zod দিয়ে parse করতাম।)

### ১.৫ Download আর CDN - একই file, হাজার জন

শুক্রবারের webinar: ৩০০ জন একই PDF খুলছে। File টা private - তাই প্রত্যেকে app থেকে নিজের presigned GET পায়। "সামনে একটা CDN বসাই" (Lesson 4.5) - সহজ মনে হয়। Exercise এর `npm run cdn`: ৩০০ জন viewer, প্রত্যেকে জনপ্রিয় ৫ MB এর PDF আর ৪টা অন্য file:

```
   path                                          downloads   cache hit   requests to object storage   out of object storage
   no CDN - presigned GET directly                 1500          0%                       1500                  1851.6 MB
   CDN + each person's own presigned URL            1500          0%                       1500                  1851.6 MB
   CDN + the CDN's signed token (cached by path)    1500         87%                        200                    63.3 MB

   token for one file, asking for another workspace's file: 403 · expired token: 403
```

মাঝের সারিটা এই lesson এর সবচেয়ে সহজে ভুল হওয়া জিনিস: CDN বসানো হলো, আর **একটাও** cache hit না।

**Cache key** - একটা cache (browser, CDN) কোন অংশ দেখে ঠিক করে যে দুটো request "একই জিনিস" চাইছে; সাধারণত URL এর path আর query string, কখনো কিছু header।

প্রত্যেক viewer এর presigned URL আলাদা - আলাদা সময়ে sign করা, তাই আলাদা `X-Amz-Date` আর `X-Amz-Signature`। CDN এর চোখে ৩০০টা আলাদা URL, ৩০০টা আলাদা জিনিস। সবগুলো miss, সবগুলো object storage এ - CDN না থাকার সমান (আর CDN এর নিজের খরচ সহ)।

"তাহলে cache key থেকে query বাদ দিই?" - experiment ৪। Hit rate বাড়ে, কিন্তু এখন CDN কিছুই যাচাই করছে না: একবার কেউ file টা আনলেই, **যে কেউ** শুধু path জানলে cache থেকে পায় - মেয়াদ পেরোনো বা কখনো না পাওয়া URL দিয়েও। Private file আর private থাকল না।

তৃতীয় সারির উত্তর: যাচাইয়ের দায়িত্ব CDN কে দিন।

**CDN signed URL / signed cookie** - CDN এর নিজের একটা key দিয়ে sign করা অনুমতি (একটা URL এর জন্য, বা cookie হিসেবে অনেক file এর জন্য); CDN প্রতিটা request এ আগে signature আর মেয়াদ যাচাই করে, তারপর signature বাদ দিয়ে শুধু path কে cache key ধরে - আর miss হলে নিজের অনুমতি দিয়ে private bucket থেকে আনে।

তাই ৩০০ জনের জন্য জনপ্রিয় PDF object storage থেকে একবার আসে; বাকি ২৯৯ বার CDN এর কাছ থেকে - কাছের edge থেকে (Singapore এর ৮ সেকেন্ড), আর object storage থেকে বেরোয় ১৮৫২ MB এর বদলে ৬৩ MB। Bucket private থাকে - শুধু CDN পড়তে পারে (AWS এ CloudFront এর "Origin Access Control")। অনেক file এর page এ (board এর সব thumbnail) প্রতিটার আলাদা URL এর বদলে একটা **signed cookie** - একবার sign, path এর একটা prefix এর সব file এর জন্য।

দুটো বাড়তি নিয়ম, দুটোই 8.1 এর key এর নিয়ম থেকে আসে:

- **Key কখনো বদলায় না** (`ws/12/att/{uuid}` এ নতুন file মানে নতুন key) - তাই CDN আর browser লম্বা সময় cache করতে পারে (`Cache-Control: max-age=31536000, immutable`)। Invalidation এর প্রশ্নই নেই (Lesson 4.3)। Private file এ browser এর cache এর জন্য `private`, আর CDN এর জন্য আলাদা নিয়ম - CDN এর configuration এ।
- **User এর upload করা file নিজের app এর domain থেকে দেবেন না।** কেউ একটা HTML file upload করল, আর সেটা `app.taskflow.test` থেকে `text/html` হিসেবে খুলল - সেই HTML এর script TaskFlow এর domain এ চলে, user এর session নিয়ে (stored XSS)। তাই: user content আলাদা domain থেকে (যেমন `taskflow-usercontent.test` - Google এর `googleusercontent.com` এর মতো), download এ `Content-Disposition: attachment`, সঠিক `Content-Type`, আর `X-Content-Type-Options: nosniff`।

### ১.৬ TaskFlow এর সিদ্ধান্ত

- **সব upload সরাসরি object storage এ, presigned URL দিয়ে।** App শুধু অনুমতি দেয় (permission, key, pending row, sign) আর শেষে যাচাই করে। Express এর upload route বন্ধ; Nginx এর `client_max_body_size` আবার ছোট।
- **কী sign হবে:** key (server এর বানানো), method, content-type, content-length; মেয়াদ ৫ মিনিট (শুধু শুরু করার জন্য)। Size এর সীমা API তে (Zod), আর confirm এ `HEAD` দিয়ে আবার যাচাই।
- **১০০ MB এর বেশি হলে multipart,** ১৬ MB part (খুব বড় file এ বড়, ১০,০০০ এর নিচে রাখতে), browser এ ৩টা একসাথে, প্রতিটা part retry (exponential + jitter)। `UploadId` pending row এ - tab বন্ধের পরে `ListParts` দিয়ে আবার শুরু।
- **Complete তিন পথে, একটাই idempotent function:** browser এর `POST /complete`, object storage এর event notification, আর পুরনো pending এর জন্য একটা job। Ready হলে outbox এ `attachment.uploaded` → thumbnail, virus scan, search index।
- **পরিষ্কার:** lifecycle এ অসমাপ্ত multipart ৭ দিনে abort; ২৪ ঘণ্টার পুরনো pending row → rejected, আর তার object (যদি থাকে) মোছা।
- **Download:** CDN, CDN এর signed URL (একটা file) বা signed cookie (board এর thumbnail); bucket শুধু CDN পড়তে পারে; আলাদা user-content domain, `Content-Disposition: attachment`, `nosniff`; key অপরিবর্তনীয় তাই লম্বা cache।

> **Trade-off Table - upload এর পথ**

| পথ                        | App এর memory            | App এর connection/সময়          | ভাঙা network এ            | নিরাপত্তা/নিয়ন্ত্রণ                              | জটিলতা                                             | কখন                                      |
| ------------------------- | ------------------------ | ------------------------------- | ------------------------- | ------------------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| App এর ভেতর দিয়ে, buffer | File × ~২ প্রতিটা upload | পুরো upload এর সময়             | শুরু থেকে                 | সবচেয়ে সহজ - app সব byte দেখে                    | সবচেয়ে কম                                         | ছোট file (কয়েক MB), কম user             |
| App এর ভেতর দিয়ে, stream | প্রায় স্থির             | পুরো upload এর সময় + bandwidth | শুরু থেকে                 | App দেখে, কিন্তু যাচাই শেষে                       | কম                                                 | App কে byte দেখতেই হবে (যেমন চলমান scan) |
| Presigned PUT (একটা)      | কিছু না                  | কয়েক ms                        | শুরু থেকে                 | যা sign করা শুধু সেটা; bearer; CORS; confirm লাগে | মাঝারি - pending/confirm, CORS                     | ~১০০ MB পর্যন্ত                          |
| Presigned multipart       | কিছু না                  | প্রতি part এ কয়েক ms           | **শুধু সেই part; resume** | Presigned এর মতো; part এর URL অনেক                | বেশি - UploadId, part, ListParts, abort, lifecycle | বড় file, mobile, অস্থির network         |

---

## ২. Interview Angle

**"YouTube/Dropbox এ upload design করুন।"** - প্রায় প্রতিটা "file" এর design প্রশ্নের কেন্দ্র। ভালো উত্তরের ক্রম: client সরাসরি object storage এ (presigned URL - app শুধু অনুমতি দেয়, কেন: memory, connection, bandwidth); বড় file এ multipart (resume, সমান্তরাল, ছেঁড়া network - একটা সংখ্যা: "২০ Mbps এ ২ GB = ১৪ মিনিট, ভাঙবেই"); metadata এর অবস্থা (pending → ready) আর confirm; upload শেষে একটা event → processing pipeline (transcode, thumbnail, scan - Lesson 7.x)। Interviewer প্রায়ই follow-up করে: "user মাঝপথে চলে গেলে?" (অসমাপ্ত upload, lifecycle abort, pending cleanup) আর "কেউ ১০০ GB পাঠালে?" (size sign করা, API তে সীমা, confirm এ HEAD)।

**"Presigned URL কি নিরাপদ?"** - হ্যাঁ, শর্তে: ছোট মেয়াদ, server এর বানানো key, যা আটকাতে চান সেটা sign করা (content-type, size), আর মনে রাখা যে এটা bearer - যার হাতে সেই পারে, মেয়াদের মধ্যে যতবার খুশি। বোনাস: CORS নিরাপত্তা না, browser এর নিয়ম।

**"Private file CDN দিয়ে দেবেন কীভাবে?"** - এখানে cache key এর ফাঁদটা নিজে থেকে বলা senior এর চিহ্ন: প্রত্যেকের presigned URL আলাদা, তাই CDN এর hit rate শূন্য; সমাধান CDN এর signed URL/cookie, CDN যাচাই করে আর path এ cache করে, bucket শুধু CDN পড়ে।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনা: lifecycle ছাড়া অসমাপ্ত multipart - মাসের পর মাস বিলে জমা; presigned URL log এ লেখা (log পড়তে পারে এমন সবাই অনুমতি পায়); CORS এ `*` আর তারপর অবাক; confirm না থাকা - database বলে "ready", object নেই; SDK এর version বদলে presigned PUT হঠাৎ ভাঙা (১.২ এর checksum); আর user এর HTML একই domain থেকে দেওয়া - XSS।

---

## ৩. Key Takeaway

- Upload **app এর ভেতর দিয়ে** মানে: buffer এ memory file এর ~২ গুণ প্রতিটা upload (৮ জনে ১১৫৯ MB), stream এ memory ঠিক কিন্তু প্রতিটা byte আর পুরো upload এর সময় জুড়ে একটা connection (২০ Mbps এ ২ GB = ~১৪ মিনিট) - Nginx এর body buffering, timeout, deploy সবকিছুর সাথে লড়াই
- **Presigned URL**: server এর secret দিয়ে sign করা, সময়বাঁধা, একটা কাজের অনুমতি - browser সরাসরি object storage এ, app শুধু কয়েক ms। **যা sign করা শুধু সেটাই আটকায়** (content-type, size); এটা bearer, মেয়াদের মধ্যে বারবার চলে; key server বানায়; **CORS** browser এর নিয়ম, নিরাপত্তা না
- Confirm এ app নিজে `HEAD` করে যাচাই করে; অবস্থা একটা union (pending → ready/rejected); complete idempotent, তিন পথে ডাকা যায়; ready এর সাথে outbox event
- **Multipart**: ছিঁড়লে শুধু একটা part - ভাঙা network এ একটা PUT ৪৩% শেষ, multipart ১০০%; part এর আকার trade-off (বড় = বেশি নষ্ট, ছোট = বেশি round trip); `ListParts` দিয়ে **resumable**; অসমাপ্ত upload অদৃশ্য কিন্তু বিল হয় - lifecycle abort
- **Cache key**: প্রত্যেকের presigned URL আলাদা, তাই CDN এর hit ০% - **CDN signed URL/cookie** যাচাই করে path এ cache করে: ৮৭% hit, object storage থেকে ১৮৫২ MB → ৬৩ MB
- অপরিবর্তনীয় key মানে লম্বা cache; user এর file আলাদা domain থেকে, `attachment` আর `nosniff` সহ

---

## ৪. নতুন Term (Glossary)

| Term                               | অর্থ                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Presigned URL**                  | একটা নির্দিষ্ট কাজের অনুমতি, মেয়াদ আর server এর secret দিয়ে বানানো signature সহ URL - যার হাতে, সে মেয়াদের মধ্যে credential ছাড়াই সেই কাজ করতে পারে        |
| **CORS / Preflight**               | Browser অন্য origin এ request পাঠানোর আগে `OPTIONS` দিয়ে অনুমতি জিজ্ঞেস করে; server অনুমতি না দিলে browser request পাঠায় না - নিরাপত্তা না, browser এর নিয়ম |
| **Multipart Upload**               | বড় object কে নম্বর দেওয়া part এ ভাগ করে আলাদা request এ পাঠানো (যেকোনো ক্রমে, সমান্তরালে, ব্যর্থ part আবার), শেষে complete এ জোড়া                           |
| **Resumable Upload**               | মাঝপথে থামলে যেখানে থেমেছিল সেখান থেকে চলা upload - multipart এ `ListParts` দিয়ে কোন part আগেই পৌঁছেছে জেনে                                                   |
| **Cache Key**                      | Cache যে অংশ দেখে ঠিক করে দুটো request একই জিনিস চাইছে কিনা - সাধারণত path আর query; প্রতিটা আলাদা হলে cache কখনো hit করে না                                   |
| **CDN Signed URL / Signed Cookie** | CDN এর নিজের key দিয়ে sign করা অনুমতি - CDN যাচাই করে, signature বাদ দিয়ে path এ cache করে, miss হলে নিজে private bucket থেকে আনে                            |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর avatar upload (৮.১ এর প্রশ্ন ১): একটা ছবি, সর্বোচ্চ ৫ MB, upload এর পরে ২৫৬×২৫৬ এ resize হবে। একজন engineer বলল: "এত ছোট file - presigned URL এর ঝামেলা কেন? Express এ `multer` দিয়ে নিয়ে নিই, সেখানেই `sharp` দিয়ে resize করে object storage এ রাখি।" তার যুক্তির কোন অংশ ঠিক? কী কী ভুল হতে পারে (Lesson 7.1 এর event loop, এই lesson এর ১.১)? আপনি কোন design বাছবেন - আর যে user একটা ৫ MB এর PNG এর নাম দিয়ে আসলে একটা HTML file পাঠায়, তার কী হবে?
2. একজন user এর ৩ GB এর upload শুরু হলো ১০টা ৫ মিনিটে, multipart, ১৬ MB part। ১০টা ১২ তে তার laptop ঘুমিয়ে গেল, ১১টা ৪০ এ খুলল। Presigned part এর URL গুলোর মেয়াদ ছিল ১৫ মিনিট। কী কী ঘটবে, ধাপে ধাপে - কোন URL কাজ করবে না, কোন তথ্য কোথায় আছে, আর upload কীভাবে শেষ হবে? কোন design এ এটা সবচেয়ে মসৃণ হয় - সব part এর URL শুরুতে একবারে, নাকি প্রতিটা part এর আগে আলাদা করে চাওয়া?
3. TaskFlow এর board এ একটা task খুললে তার ২০টা attachment এর thumbnail দেখায়। প্রতিটার জন্য একটা presigned GET - প্রতি page এ ২০টা sign, আর CDN এ কোনো cache না। তিনটা বিকল্প তুলনা করুন: (ক) প্রতি thumbnail এ presigned GET, (খ) প্রতি thumbnail এ CDN signed URL, (গ) workspace এর prefix এর জন্য একটা CDN signed cookie। CDN এর hit rate, app এর কাজ, আর নিরাপত্তা (একজন workspace থেকে বাদ পড়লে কতক্ষণ দেখতে পায়?) - প্রতিটার জন্য।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** ঠিক অংশ: ৫ MB এর ছবি ১.১ এর বড় সমস্যা গুলো (১৪ মিনিটের connection, GB এর memory) আনে না - upload কয়েক সেকেন্ডের, memory কয়েক MB। একটা ছোট app এ এটা চলতেই পারে। কিন্তু দুটো জিনিস ভুল হতে পারে:

- **Resize CPU এর কাজ।** `sharp` নিজে native thread এ চলে, তাই event loop পুরোটা আটকায় না - কিন্তু একসাথে অনেক resize মানে API এর CPU আর memory ভরা, আর সেটা board এর request এর সাথে ভাগ করা (Lesson 7.1 এর পার্শ্ব নোট, 8.1 এর "app এর ভেতর দিয়ে")। সোমবার সকালে একটা বড় team একসাথে profile ঠিক করলে API ধীর।
- **Resize request এর পথে।** ব্যর্থ হলে (একটা ভাঙা ছবি, বিশাল resolution এর "decompression bomb") user এর upload ও ব্যর্থ, আর একটা ক্ষতিকর ছবি API process কে ফেলতে পারে।

Design: presigned PUT (content-type `image/*` আর size ≤ ৫ MB sign করা), confirm এ HEAD, তারপর outbox event → একটা BullMQ worker (আলাদা process, sandboxed - Lesson 7.3) resize করে `avatars/{userId}/{version}.webp` লেখে। Original ছবি worker এর কাছে "অবিশ্বস্ত input" - decode এর সীমা (pixel এর সংখ্যা), timeout।

HTML এর user: content-type এর নাম দিয়ে কিছু প্রমাণ হয় না - browser যা বলে তাই। Worker ছবি decode করতে গিয়ে ব্যর্থ হয় → upload rejected, object মোছা। আর যা দেখানো হয় সেটা **worker এর বানানো** webp - user এর পাঠানো bytes কখনো সরাসরি দেখানো হয় না। সাথে ১.৫ এর নিয়ম: user content আলাদা domain থেকে, `nosniff` - যাতে কোনো ফাঁক থাকলেও browser HTML হিসেবে না চালায়।

**প্রশ্ন ২:** ধাপে ধাপে:

1. ১০:০৫ - upload শুরু: `CreateMultipartUpload`, pending row এ `UploadId`। সব part এর URL যদি শুরুতে একবারে দেওয়া হয়ে থাকে (১৯২টা, ৩ GB ÷ ১৬ MB), সবগুলোর মেয়াদ ১০:২০ এ শেষ।
2. ১০:১২ - laptop ঘুম। ধরুন ৮০টা part পৌঁছেছে, ৩টা চলমান ছিল (সেগুলো ছিঁড়েছে - object storage এ নেই)।
3. ১১:৪০ - laptop খুলল। Browser এর memory তে হয়তো part এর তালিকা আছে (tab খোলা ছিল), কিন্তু বাকি ১১২টা URL এর মেয়াদ শেষ - প্রতিটা `403`।
4. যা এখনো ঠিক আছে: object storage এ `UploadId` আর ৮০টা part (অসমাপ্ত upload এর lifecycle ৭ দিনের - তাই আছে)। Pending row এ `UploadId`।
5. পুনরুদ্ধার: browser app কে বলে "আবার শুরু করুন" → app pending row থেকে `UploadId` নেয়, `ListParts` করে (৮০টা আছে), আর **বাকি** part গুলোর জন্য নতুন presigned URL দেয় → browser শুধু সেগুলো পাঠায় → complete।

মসৃণ design: প্রতিটা part (বা ছোট একটা ব্যাচ) এর URL দরকারের ঠিক আগে চাওয়া - তাহলে মেয়াদ ছোট রাখা যায় (৫–১৫ মিনিট), আর ঘুমের পরে স্বাভাবিকভাবেই নতুন URL আসে; বাড়তি দাম প্রতি part এ app এ একটা ছোট request। শুরুতে সব একবারে দিলে হয় মেয়াদ লম্বা করতে হয় (bearer অনুমতি ঘণ্টার পর ঘণ্টা - ১.২ এর ঝুঁকি), নয়তো ঠিক এই "মেয়াদ শেষ" এর পথটা আলাদা করে সামলাতে হয়। দুই ক্ষেত্রেই আসল নির্ভরতা একই: `UploadId` server এ, আর `ListParts` সত্যের উৎস - browser এর memory না।

**প্রশ্ন ৩:**

| বিকল্প                                | CDN hit rate                                               | App এর কাজ                             | বাদ পড়া member কতক্ষণ দেখে                                                               |
| ------------------------------------- | ---------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| (ক) presigned GET প্রতি thumbnail     | ০% (প্রতিটা URL আলাদা - ১.৫), বা CDN নেই                   | প্রতি page এ ২০টা sign (সস্তা, কিন্তু) | URL এর মেয়াদ পর্যন্ত (যেমন ৫ মিনিট)                                                      |
| (খ) CDN signed URL প্রতি thumbnail    | উঁচু (path এ cache)                                        | প্রতি page এ ২০টা sign                 | URL এর মেয়াদ পর্যন্ত                                                                     |
| (গ) workspace prefix এর signed cookie | উঁচু, আর HTML এ সাধারণ স্থির URL - browser cache ও কাজ করে | Session এ একবার (আর মেয়াদ শেষে নতুন)  | Cookie এর মেয়াদ পর্যন্ত - ছোট রাখুন (যেমন ১৫ মিনিট), আর বাদ পড়লে পরের নবায়নে দেওয়া না |

বাছাই: board এর thumbnail এর জন্য (গ) - অনেক ছোট file, একই প্রশ্ন ("এই workspace এর member কি?") সবগুলোর জন্য, আর HTML এ স্থির URL মানে browser এর নিজের cache ও (key অপরিবর্তনীয়)। দাম: prefix এর সীমা design এ ঠিক রাখতে হয় (`ws/{workspaceId}/` - 8.1 এর key এর নিয়ম এখানে কাজে লাগল), আর বাদ পড়ার পরে cookie এর মেয়াদ পর্যন্ত দেখার জানালা। একক বড় file download এ (একটা ২ GB এর video) (খ) - একটা file এর নির্দিষ্ট অনুমতি।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (Docker এ SeaweedFS, authentication চালু)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-8.2-file-upload/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-8.2-file-upload) - `docker compose up -d --wait && npm install`, তারপর `npm run through-app`, `npm run presign`, `npm run resume`, `npm run cdn`। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`through-app` TaskFlow এর API কে আলাদা process এ চালিয়ে তিনটা upload এর পথ তুলনা করে - app এর memory, খোলা upload, event loop। `presign` presigned PUT/GET এর নিয়ম আসল request দিয়ে যাচাই করে, সাথে confirm ধাপ আর CORS। `resume` ভাঙা network এ একটা PUT আর multipart পাঠায় - connection আসলেই মাঝপথে কাটা - আর শেষে ১০০০ seed এর একটা model। `cdn` একটা ছোট CDN চালিয়ে presigned URL আর CDN token এর cache hit মাপে।

**সৎ নোট:** Sandbox এ Docker এর SeaweedFS 4.47 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; চারটা script ই চালানো - `presign` দুবার (ETag ছাড়া হুবহু একই), `cdn` তিনবার (হুবহু একই); `resume` দুটো seed এ (৭ আর ১১); `through-app` default এ একবার আর experiment ১ এ একবার - buffer এ memory upload এর সংখ্যার সাথে রৈখিক, বাকি দুটোয় প্রায় স্থির। README এর experiment ১, ২ আর ৫ চালানো হয়েছে; ৩ আর ৪ code বদলানোর কাজ - আপনার। Object store টা SeaweedFS, AWS S3 না; S3 এর সীমা (৫ MB, ১০,০০০ part, ৫ GB) documentation থেকে। `resume` এর default seed (১১) বাছা হয়েছে কারণ তার ছেঁড়ার দূরত্ব গড়ের কাছে - seed ৭ এ দুটো ছেঁড়া প্রথম ২ MB এর মধ্যে, তারপর আর না, আর তখন সব পদ্ধতি প্রায় সমান দেখায়; তাই গড় আর p95 model এর table থেকে পড়ুন। `resume` এর সময় একটা হিসাব, মাপা না। `cdn` একটা ছোট Express proxy, কোনো আসল CDN না; token টা CDN এর signed URL এর ধারণা, কোনো নির্দিষ্ট CDN এর format না। SvelteKit এর code (১.৪) browser এ চালানো হয়নি।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **হিসাব আগে:** `through-app` চালানোর আগে লিখে ফেলুন - buffer এ ৮টা ৬৪ MB এর upload এ app এর memory কত হবে, আর stream এ কত। তারপর চালিয়ে মেলান। তারপর TaskFlow এর একটা খারাপ দিনের হিসাব: ৫০ জন একসাথে ২ GB এর video, ২০ Mbps এ - buffer এ memory কত, stream এ কতগুলো connection কতক্ষণ খোলা?

2. **Sign এর তালিকা:** `presign` এর ৭ নম্বর কেন `200`? `presign.ts` এ `signableHeaders` থেকে `content-type` সরিয়ে ৩ নম্বর আবার চালান - কী হলো, আর কেন? তারপর experiment ৫ (replay) - TaskFlow এর কোন upload এ এটা বসাবেন?

3. **Part এর আকার:** `resume` এর model table থেকে ৫, ১৬, ৬৪ MB এর গড় আর p95 তুলনা করুন, তারপর `RTT_MS=600` (experiment ২) আর `DROP_EVERY_MB=20` দিয়ে আবার। একটা ছোট নিয়ম লিখুন: "network এমন হলে part এর আকার এত" - আর TaskFlow এর default কত রাখবেন।

4. **Cache key এর ফাঁদ** (experiment ৪): `cdn.ts` এ presigned mode এর cache key থেকে query বাদ দিন। Hit rate কত হলো? এখন একজন user এর presigned URL এর মেয়াদ শেষ হলে, বা সে কখনো অনুমতিই না পেলে - শুধু path জেনে file টা পায় কি? এক প্যারাগ্রাফে লিখুন কেন "hit rate বাড়ল" এখানে সাফল্য না।

5. **Design অংশ:** TaskFlow এর upload এর এক পাতার design: (ক) API এর তিনটা route (`POST /uploads`, `POST /:id/complete`, আর tab বন্ধের পরে `POST /:id/resume`) - প্রতিটার input, কী যাচাই করে, কী ফেরত দেয়; (খ) attachment এর অবস্থার union আর প্রতিটা transition কে ঘটায় (browser, event notification, job); (গ) কোন আকার থেকে multipart, part এর আকার, একসাথে কয়টা; (ঘ) পরিষ্কারের নিয়ম (lifecycle, pending job) আর কোন metric এ alert (যেমন "২৪ ঘণ্টার বেশি pending"); (ঙ) download এর পথ - কোন file কোন ধরনের signed URL/cookie এ।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7 (সম্পূর্ণ, exit challenge সহ), 8.1
Current: 8.2 - File upload at scale: presigned URL, multipart, CDN delivery
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; outbox → Redis Streams, BullMQ; attachment: metadata database এ,
bytes object storage এ (private bucket, key = ws/{workspaceId}/att/{uuid}); upload সরাসরি
browser → object storage, presigned URL (key, content-type, size sign করা, ৫ মিনিট); ১০০ MB এর
বেশি হলে multipart (১৬ MB part, ৩টা একসাথে, UploadId pending row এ, ListParts দিয়ে resume);
অবস্থা pending → ready/rejected, complete idempotent (browser, event notification, job), ready এ
outbox event → thumbnail/scan/index; lifecycle: অসমাপ্ত multipart ৭ দিনে abort; download CDN
দিয়ে, CDN signed URL/cookie, bucket শুধু CDN পড়ে, আলাদা user-content domain
Terms learned (Module 8 so far): Object Storage, Bucket / Key (Prefix), Object Metadata,
Durability, Erasure Coding, Failure Domain, Storage Class / Lifecycle, Presigned URL, CORS /
Preflight, Multipart Upload, Resumable Upload, Cache Key, CDN Signed URL / Signed Cookie
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 8.3 - Search & inverted index: কেন LIKE %x% scale করে না
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠান - বিশেষ করে ৩ নম্বরের part এর আকারের নিয়ম আর ৫ নম্বরের design। রেডি হলে `next` লিখুন - Lesson 8.3 এ যাব: **Search & inverted index - কেন `LIKE '%x%'` scale করে না।** TaskFlow এ এখন লাখ লাখ task, comment, আর attachment এর নাম - আর user রা খোঁজে: "deploy checklist", "invoice", ভুল বানানে "recieve"। আজ upload শেষে একটা `attachment.uploaded` event বেরোল; তার একটা consumer এর কাজ হবে search index এ তোলা। কিন্তু সেই index টা আসলে কী? Postgres এর `ILIKE '%deploy%'` দশ লাখ row এ কেন প্রতিবার পুরো table পড়ে (Lesson 5.4 এর index কেন এখানে কাজে আসে না), একটা inverted index কীভাবে "কোন শব্দ কোন document এ" উল্টে রাখে, কীভাবে ফলাফল সাজানো হয় (relevance), আর Postgres এর নিজের full-text search কখন যথেষ্ট আর কখন Elasticsearch/OpenSearch - মাপা সংখ্যা সহ।
