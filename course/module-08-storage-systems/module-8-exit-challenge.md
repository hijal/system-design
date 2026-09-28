# Module 8 — Exit Challenge (Storage Systems)

**Module 8 — Storage Systems**

Module 8 এর ৩টা lesson শেষ — bytes কোথায় রাখবে আর object storage ভেতরে কীভাবে টিকে থাকে, বড় file কীভাবে upload আর download হয় (presigned URL, multipart, CDN), আর কীভাবে খোঁজা যায় (inverted index)। প্রতিটা lesson এ একটা করে প্রশ্ন আলাদা করে মেপেছি। বাস্তবে একটা নতুন feature এর প্রথম মাসে সব একসাথে আসে — আর প্রায়ই Module 5–7 এর পুরনো প্রশ্ন গুলো (dual write, eventual consistency, idempotency) নতুন চেহারায় ফিরে আসে। এই Exit Challenge এমন একটা মাস।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow গত মাসে "Recordings & Docs" চালু করেছে — task এ screen recording, design file, PDF জোড়া, আর সবকিছুর ভেতরে খোঁজা। Incident review এর জন্য তোমাকে পুরো মাসের ঘটনা দেওয়া হলো। এই মুহূর্তে এর অবস্থা (কিছু সিদ্ধান্ত এই module এর lesson মেনে, কিছু না):
>
> - **Bucket:** একটাই bucket `taskflow-files`, versioning চালু, কোনো lifecycle rule নেই। Key: `uploads/{userId}/{originalFileName}`।
> - **Upload:** browser presigned PUT দিয়ে সরাসরি bucket এ; URL এর মেয়াদ **৭ দিন** ("যাতে বড় upload মাঝপথে মেয়াদ না পেরোয়")। শুধু key sign করা — content-type বা আকার না। ১ GB এর বেশি হলে multipart, ৬৪ MB part। Upload শেষে browser `POST /complete` পাঠায় `{ key, size, etag }` সহ; API সেগুলো দিয়ে সরাসরি row কে `ready` বানায়।
> - **Download:** প্রতিটা file এর জন্য user কে একটা presigned GET (মেয়াদ ১ ঘণ্টা), সামনে CDN — CDN এর cache key পুরো URL। File গুলো `app.taskflow.test/files/…` দিয়ে দেওয়া হয় (Nginx থেকে bucket এ proxy)।
> - **পরিষ্কার:** রাতের একটা job bucket এর LIST আর database এর `attachments` মেলায়; row নেই এমন object মুছে দেয়। Job টা পড়ে একটা **read replica** থেকে।
> - **Search:** প্রথম দুই সপ্তাহ `Comment.findAll({ where: { body: { [Op.iLike]: '%…%' } } })`, প্রতিটা অক্ষরে (search-as-you-type)। তারপর OpenSearch এ সরানো: API comment লেখার পরে সরাসরি OpenSearch এ `index` করে (`await` ছাড়া, `.catch(() => {})`)। Query তে workspace এর filter আসে client এর পাঠানো `workspaceId` থেকে।
> - **প্রস্তাব:** একজন infra engineer বলছে, "S3 এর বিল বেশি — নিজেদের ৪টা rack এ একটা object store চালাই, erasure coding 6+3, fragment যেকোনো disk এ।"
>
> **মাসের ঘটনাগুলো:**
>
> 1. **Object storage এর বিল** প্রত্যাশার ৪ গুণ। ভেঙে দেখা গেল: বড় একটা অংশ "noncurrent version", আরেকটা অংশ এমন জায়গা যেটা কোনো object এর LIST এ দেখা যায় না, আর egress এর লাইন আলাদা করে অনেক উঁচু।
> 2. **৯ তারিখ:** একটা design agency এর ১২০টা file উধাও — database এ row আছে, bucket এ object নেই। সেই রাতে replica ৪০ মিনিট পিছিয়ে ছিল (একটা বড় migration)। পরিষ্কারের job এর log এ ওই ১২০টার key "orphan" হিসেবে মোছা।
> 3. **১৪ তারিখ:** একজন customer এর confidential PDF এর link একটা public Slack channel এ ঘুরছে — presigned **PUT** এর URL, customer এর Nginx access log থেকে কেউ কপি করেছিল। আর সেই URL দিয়ে কেউ file টাকে অন্য একটা file দিয়ে overwrite করেছে।
> 4. **Support ticket:** "file এর তালিকায় আছে, খুললে 404" (৩৭টা) — আর "upload ১০০% দেখাল, কিন্তু file টা 'processing…' এ আটকে" (৫২টা)। একটা file এর নাম বদলে দুজন user একই নামের file upload করার পরে একজনের file অন্যজনেরটা দিয়ে বদলে গেছে।
> 5. **Webinar এর দিন:** ৪০০ জন একটা ২০০ MB এর recording খুলল। CDN এর hit rate ০%, object storage থেকে ৮০ GB বেরোল, আর Singapore এর viewer রা বলল video চালু হতে ১৫ সেকেন্ড।
> 6. **Security report:** একজন researcher দেখাল, একটা `.html` file upload করে তার link কাউকে পাঠালে সেই file `app.taskflow.test` থেকে খোলে, আর তার ভেতরের script user এর session দিয়ে TaskFlow এর API ডাকতে পারে।
> 7. **Search, প্রথম দুই সপ্তাহ:** সকাল ১০টায় database এর CPU ৯০%, search এর p99 ৬০০ ms — সবচেয়ে ধীর query গুলোর বেশিরভাগ কোনো ফল দেয়নি। আর "art" খুঁজলে প্রথম পাতা "start" আর "party"।
> 8. **Search, OpenSearch এর পরে:** (ক) মোছা comment ঘণ্টার পর ঘণ্টা search এ আসছে, আর কিছু নতুন comment কখনোই আসেনি — একটা deploy এর সময় OpenSearch ২ মিনিট বন্ধ ছিল; (খ) একজন customer আরেক customer এর comment এর অংশ দেখেছে — নতুন "similar comments" API তে; (গ) user রা বলছে "comment লিখে সাথে সাথে খুঁজলে পাই না।"
> 9. **Manager এর প্রশ্ন:** "S3 এর durability ১১ nines — তাহলে ৯ তারিখে file হারাল কীভাবে? আর নিজেদের rack এ গেলে কি আরও ভালো হবে?"

তোমার কাজ — নিচের প্রতিটা প্রশ্নে Module 8 (আর প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নাও, reasoning সহ। যেখানে সম্ভব, **সংখ্যা** দিয়ে বলো।

**১. বিলের তিনটা অংশ (Lesson 8.1 + 8.2)**
"Noncurrent version", "LIST এ দেখা যায় না এমন জায়গা", আর egress — প্রতিটা কোথা থেকে আসছে, এই setup এর কোন সিদ্ধান্ত থেকে? প্রতিটার জন্য একটা lifecycle rule বা design এর বদল দাও (কত দিন, কোন শ্রেণি)। TaskFlow এর আকার ধরে (মাসে ১.৫ TB নতুন, প্রতিটা file গড়ে ৫ বার খোলা) egress এর মাসিক হিসাব করো — CDN থাকলে আর না থাকলে।

**২. ১২০টা file উধাও (Lesson 8.1 + 5.7 + 7.4)**
সময়ের রেখায় দেখাও কীভাবে পিছিয়ে থাকা replica সত্যিকারের file কে "orphan" বানাল। এখানে dual write এর কোন দিকে ভুল হওয়ার কথা ছিল (8.1 এর "object আগে, row পরে"), আর পরিষ্কারের job সেই নিয়মকে কীভাবে উল্টে দিল? File গুলো কি ফেরানো যায় — কোন বৈশিষ্ট্যের কারণে, কতদিন পর্যন্ত? পরিষ্কারের job এর অন্তত চারটা নিরাপত্তা দাও (কোথা থেকে পড়বে, কত পুরনো, কী আগে log করবে, কীভাবে মুছবে)।

**৩. ফাঁস হওয়া presigned URL (Lesson 8.2)**
এই URL দিয়ে কেউ কী কী পারল, আর কেন — কোন তিনটা সিদ্ধান্ত (মেয়াদ, কী sign করা, key এর নিয়ম) ক্ষতিটা বড় করল? প্রতিটার জন্য সঠিক মান দাও। মেয়াদ ছোট করলে "বড় upload মাঝপথে মেয়াদ পেরোয়" এর ভয়টা কীভাবে সামলাবে (multipart এর part প্রতি URL)? আর overwrite আটকানোর উপায় কী?

**৪. "আছে কিন্তু 404", "আটকে আছে", আর একই নাম (Lesson 8.2 + 8.1 + 7.5)**
তিনটা ticket এর কারণ আলাদা করে বলো। Complete এর ধাপ browser এর পাঠানো `size`/`etag` বিশ্বাস করলে কী ভুল হয়? Attachment এর অবস্থার union লেখো (discriminated union), প্রতিটা transition কে ঘটায় (browser, object storage এর event notification, job), আর complete কে idempotent করো। Key এর নিয়ম কী হওয়া উচিত, আর কেন user এর দেওয়া নাম key এ থাকবে না?

**৫. Webinar (Lesson 8.2 + 4.5)**
CDN থাকা সত্ত্বেও hit rate ০% কেন — এক বাক্যে cache key দিয়ে। ঠিক করা design দাও: কোন ধরনের signed অনুমতি, কে যাচাই করে, cache key কী, bucket কে কে পড়তে পারে। ৪০০ জন × ২০০ MB — ঠিক করার পরে object storage থেকে মোটামুটি কত বেরোবে? Singapore এর ১৫ সেকেন্ডের জন্য আর কী (video এর range request — 8.1)?

**৬. `.html` আর XSS (Lesson 8.2)**
Researcher এর আক্রমণটা ধাপে ধাপে লেখো। তিনটা প্রতিরক্ষা দাও (domain, header, content-type এর যাচাই) — আর প্রতিটা একা কেন যথেষ্ট না।

**৭. প্রথম দুই সপ্তাহের search (Lesson 8.3 + 5.4)**
সকাল ১০টার ৯০% CPU এর হিসাব: ধরো ২০০০ জন একসাথে সক্রিয়, প্রতি মিনিটে একবার খোঁজে, প্রতিটায় গড়ে ৬ অক্ষর, আর প্রতিটা "কিছু না পাওয়া" query ~৪০০ ms এর পুরো scan — কত query/সেকেন্ড, কত CPU-সেকেন্ড/সেকেন্ড? "ফল না থাকা query সবচেয়ে ধীর" কেন? আর "art → start" কেন? OpenSearch এ না গিয়ে, শুধু Postgres দিয়ে তুমি কী করতে (অন্তত চারটা ধাপ)?

**৮. OpenSearch এর তিনটা সমস্যা (Lesson 8.3 + 7.5 + 7.4 + 6.3)**
(ক) মোছা comment থাকা আর নতুন comment না আসা — এই sync এর নাম কী, আর কোন pattern দিয়ে ঠিক করবে? পুরনো event নতুনটাকে overwrite করা কীভাবে আটকাবে? ইতিমধ্যে জমে থাকা ফাঁক কীভাবে ধরবে আর সারাবে? (খ) Permission এর ফাঁস — দুটো আলাদা ভুল (filter নেই, filter এর মান client থেকে) — প্রতিটার প্রতিরোধ। (গ) "লিখে সাথে সাথে পাই না" — দেরির উৎস গুলো (sync এর পথ, refresh) আর তুমি কোন সমাধান বাছবে।

**৯. নিজেদের rack আর "১১ nines" (Lesson 8.1 + 5.9)**
(ক) Manager কে উত্তর: ১১ nines কী থেকে রক্ষা করে, কী থেকে না — ৯ তারিখের ঘটনা কোন শ্রেণির? আর কোন তিনটা জিনিস সেই শ্রেণির ঘটনা থেকে রক্ষা করে? (খ) ৪টা rack এ EC 6+3, fragment যেকোনো disk এ — একটা rack বন্ধ হলে কী হয়, আর কেন (8.1 এর exercise এর `RACKS=4` মনে করো)? এই rack সংখ্যায় কোন পদ্ধতি অর্থবহ? (গ) খরচের বাইরে আর কী হিসাব করবে (মেরামতের সময়, মানুষ, on-call) — এক প্যারাগ্রাফে তোমার সুপারিশ।

**১০. Design doc আর অগ্রাধিকার (Lesson 8.1–8.3)**
(ক) "Recordings & Docs" এর এক পাতার design doc: bucket আর key এর নিয়ম; upload এর পথ (কী sign, কত মেয়াদ, কখন multipart, part এর আকার); attachment এর অবস্থা আর complete; download আর CDN; lifecycle; পরিষ্কার; search (Postgres নাকি OpenSearch, sync, permission)।
(খ) একটা **অগ্রাধিকার তালিকা**: এই সপ্তাহে কী (আবার ঘটার আগে), এই মাসে কী, এই quarter এ কী — প্রতিটার পাশে কোন lesson, আর সাফল্য কীভাবে মাপবে (কোন metric, কোন সংখ্যা)।

**মনে রাখার কথা:** এই module এর তিনটা জায়গায় সবচেয়ে সহজে ভুল হয় — (ক) **object storage কে file system ভাবা** — rename নেই, folder নেই, আংশিক লেখা নেই, আর LIST এ যা দেখা যায় না তারও বিল হয়; (খ) **"টেকসই" কে "নিরাপদ" ভাবা** — durability hardware থেকে বাঁচায়, তোমার নিজের job, bug, আর ফাঁস হওয়া অনুমতি থেকে না; (গ) **একটা কপিকে সত্যের উৎস ভাবা** — CDN, search index, replica — প্রতিটা কপি পিছিয়ে থাকতে পারে, তাই তার উপর ভর করে কিছু **মোছা** বা কাউকে **অনুমতি দেওয়া** বিপজ্জনক। আজকের scenario তে তিনটাই আছে, কয়েকবার করে। আর Module 8 এর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস: প্রতিটা file এর জন্য জিজ্ঞেস করো — **"এই bytes এর মালিক কে, কোন সত্যের উৎস বলে এটা থাকা উচিত, আর কে কতক্ষণ এটা পড়তে বা বদলাতে পারে?"**

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

- [ ] Block, file আর object storage এর পার্থক্য বলতে পারি; object storage কেন পুরো object ধরে লেখে, আর কেন "folder" শুধু prefix
- [ ] File database এ রাখার তিনটা দাম (WAL আর replica, backup/restore, app এর ভেতর দিয়ে দেওয়া) সংখ্যা দিয়ে বলতে পারি — আর কখন সেটা তবু ঠিক আছে
- [ ] App server এর disk এ file কেন stateless ভাঙে, আর sticky session কেন teammate কে বাঁচায় না
- [ ] Object store এর ভেতরের গঠন (metadata index আর bytes আলাদা, Haystack এর ধারণা) আঁকতে পারি
- [ ] Durability আর availability এর পার্থক্য; replication বনাম erasure coding এর জায়গা আর durability এর হিসাব; failure domain জুড়ে ছড়ানো কেন শর্ত — আর "১১ nines" কী থেকে রক্ষা করে না
- [ ] S3 API এর নিয়ম: strong read-after-write (আর অন্য system এ যাচাই করা), last writer wins আর conditional write, range read, ETag, versioning, storage class আর lifecycle
- [ ] Key এর নিয়ম (অপরিবর্তনীয়, user এর নাম ছাড়া, tenant এর prefix) আর দুই জায়গায় লেখার ক্রম (object আগে, row পরে, orphan পরিষ্কার — নিরাপদভাবে)
- [ ] Upload app এর ভেতর দিয়ে কেন না — memory, connection, সময় (Little's Law দিয়ে)
- [ ] Presigned URL কীভাবে কাজ করে; কী sign করতে হয় আর কেন; bearer অনুমতির ঝুঁকি আর মেয়াদ; CORS কী আর কী না
- [ ] Multipart upload: কেন, part এর আকারের trade-off, `ListParts` দিয়ে resume, অসমাপ্ত upload আর তার lifecycle
- [ ] Upload এর জীবন (pending → ready/rejected), browser কে বিশ্বাস না করে confirm, idempotent complete, আর upload শেষে event → processing
- [ ] Private file এর CDN: কেন প্রত্যেকের presigned URL cache ভাঙে, CDN signed URL/cookie, আর user content আলাদা domain থেকে
- [ ] `LIKE '%x%'` কেন scale করে না (আর `LIMIT` এর ফাঁদ); B-tree কোথায় কাজে আসে; trigram কী সারায় আর কী না
- [ ] Analyzer, inverted index, posting list — বানানো আর খোঁজা (intersection এর ক্রম) whiteboard এ আঁকতে পারি; BM25 এর তিনটা সংকেত
- [ ] Postgres full-text বনাম Elasticsearch/OpenSearch কীভাবে বাছব; আলাদা engine হলে sync (outbox, version), near real-time, permission, shard আর pagination এর নিয়ম

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Doug Beaver ও সহকর্মীরা — "Finding a needle in Haystack: Facebook's photo storage" (OSDI 2010)।** 8.1 এর "metadata আর bytes আলাদা" এর উৎস; ছোট, পরিষ্কার, আর কেন file system এর metadata কোটি file এ ভেঙে পড়ে সেটার সবচেয়ে ভালো ব্যাখ্যা। তার পরের paper — **"f4: Facebook's Warm BLOB Storage System" (OSDI 2014)** — erasure coding আর failure domain এর বাস্তব হিসাব।
- **AWS S3 এর documentation — "Amazon S3 data consistency model", "Uploading and copying objects using multipart upload", "Sharing objects with presigned URLs", আর conditional request এর অংশ।** 8.1 আর 8.2 এর প্রায় প্রতিটা নিয়মের আসল উৎস — তারিখ দেখে পড়ো, নিয়মগুলো সময়ের সাথে বদলেছে।
- **Christopher Manning, Prabhakar Raghavan, Hinrich Schütze — _Introduction to Information Retrieval_।** Inverted index, posting list এর intersection, tf-idf, compression — 8.3 এর পুরো তত্ত্ব। বইটা লেখকদের website এ বিনামূল্যে পড়া যায়; প্রথম ছয়টা chapter যথেষ্ট।
- **PostgreSQL এর documentation — Chapter "Full Text Search" আর `pg_trgm` এর অংশ।** 8.3 এর Postgres এর দিক — analyzer (text search configuration), ranking, index এর ধরন।
- **Martin Kleppmann — _Designing Data-Intensive Applications_ এর chapter 3 এর "Full-text search and fuzzy indexes" অংশ, আর chapter 11 এর "Keeping Systems in Sync"।** Search index কে database এর একটা derived কপি হিসেবে দেখা — 8.3 এর ১.৬।
- **Backblaze এর "Drive Stats" blog (প্রতি quarter)।** আসল disk কত হারে মরে, model আর manufacturer ধরে — 8.1 এর durability এর হিসাবের অনুমানগুলো বাস্তবের সাথে মেলাতে।

**দেখার জন্য:**

- **AWS re:Invent এর S3 এর deep dive talk গুলো** (বিভিন্ন বছরের — "Deep dive on Amazon S3" বা S3 এর ভেতরের design নিয়ে)। কীভাবে একটা বিশাল object store মেরামত, durability আর consistency সামলায় — ভেতরের মানুষের মুখে। বছর দেখে দেখো, ভেতরের অনেক কিছু বদলেছে।
- **Elasticsearch/OpenSearch এর নিজস্ব "how search works" এর পরিচিতিমূলক talk আর documentation এর "Near real-time search" আর "Scalability and resilience" অংশ** — segment, refresh, shard, replica — 8.3 এর ১.৬ এর বিস্তারিত।

**Project এর জন্য:**

- **নিজের একটা ছোট object store:** metadata Postgres এ (key → কোন file এর কোন offset), bytes কয়েকটা বড় append-only file এ (Haystack এর মতো); PUT, GET, Range GET, DELETE (tombstone আর পরে compaction — Lesson 5.3)। তারপর একটা Reed–Solomon library দিয়ে তিনটা "disk" (folder) এ 2+1 erasure coding — একটা folder মুছে file ফেরাও।
- **TaskFlow এর resumable uploader, শুরু থেকে শেষ:** SvelteKit এর page, presigned multipart (part প্রতি URL, দরকারের ঠিক আগে), browser এ progress আর retry, tab বন্ধের পরে `ListParts` দিয়ে resume, আর server এ pending → ready এর union, event notification + job + browser — তিনটা পথে একই idempotent complete। Chrome এর DevTools এ network কে "Slow 3G" বা offline করে ভেঙে দেখো।
- **Search service, database এর কপি হিসেবে:** outbox (7.5) → consumer → OpenSearch (version সহ upsert, workspace ধরে routing); আর একটা রাতের "reconcile" job যেটা database আর index এর গোনা আর নমুনা মেলায়, ফাঁক পেলে আবার index করে। তারপর consumer কে এক ঘণ্টা বন্ধ রেখে দেখো — job কী ধরে?

---

Exit challenge টা করে পাঠাও। রেডি হলে `next` লিখলে আমরা **Module 9: Microservices & Service Architecture** এ যাব — Lesson 9.1 দিয়ে শুরু: Monolith vs Microservices — কখন ভাঙবে, কখন ভাঙবে **না**।

Module 8 জুড়ে TaskFlow এর চারপাশে নতুন নতুন system জুড়েছে — object storage, CDN, search index — প্রতিটা database এর বাইরে, প্রতিটা নিজের নিয়মে, আর প্রতিটার সাথে sync এর প্রশ্ন। অথচ TaskFlow এর code এখনো একটা Express app: task, comment, attachment, search, billing, notification — সব একটা repo তে, একটা deploy এ। Team বড় হচ্ছে, আর প্রতিটা deploy এ কেউ না কেউ অন্য কারো কাজ ভাঙছে। Module 9 এর প্রশ্ন: এই একটা app কে কি আলাদা আলাদা service এ ভাঙা উচিত — আর ভাঙলে Module 5–8 এর যা শিখেছি (dual write, eventual consistency, idempotency, এক জায়গার transaction) সেগুলো কতগুণ কঠিন হয়ে যায়?
