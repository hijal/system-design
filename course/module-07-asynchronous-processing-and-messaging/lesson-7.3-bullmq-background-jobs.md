# Lesson 7.3 — BullMQ Hands-on: Express এ Background Job Processing

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 4.3):** TaskFlow এর cache Redis এ `maxmemory-policy allkeys-lru` কেন বেছেছিলাম — memory ভরলে কী হয়, আর সেটা cache এর জন্য কেন ঠিক আছে? আজ একই Redis এ job রাখতে চাইব, আর দেখবেন এই এক লাইনের config ঠিক উল্টো হতে হয়।

**Prerequisite:** Lesson 3.4 (Graceful shutdown), Lesson 4.3–4.4 (Redis, eviction policy), Lesson 6.1 (Lease, process pause), Lesson 7.1 (Job queue, backlog, in-memory queue এর দুর্বলতা), Lesson 7.2 (Ack, at-least-once, competing consumers)

**আপনি এই lesson শেষে পারবেন:**

1. Express API (producer) আর আলাদা worker process (consumer) দিয়ে BullMQ এর উপর একটা টেকসই background job বানাতে পারবেন — Zod দিয়ে typed job data, retry, backoff আর নিজের বানানো job ID সহ
2. একটা job এর পুরো জীবন (waiting → active → completed/failed, delayed, stalled) আঁকতে পারবেন, আর বলতে পারবেন API, worker বা Redis — কে মরলে job এর কী হয়, সংখ্যা সহ
3. TaskFlow এর job system production এ চালানোর সিদ্ধান্তগুলো নিতে পারবেন: Redis এর config, lock এর মেয়াদ, concurrency, graceful shutdown, আর কী কী মাপতে হবে

**Tier:** 1 — Runnable Code (Docker এ Redis; API, worker আর নকল email provider আলাদা Node process)

---

## ০. TaskFlow এখন কোথায়

Lesson 7.2 এর সিদ্ধান্ত: TaskFlow এর message দুই ধরনের। "খবর" (comment তৈরি হলো, task complete হলো) যাবে একটা log এ। আর "কাজ" (এই email পাঠান, এই export বানান) যাবে queue তে — per-message ack, retry, delay সহ। TaskFlow এর stack Node আর Redis আগে থেকেই আছে, তাই কাজের জন্য বাছা হলো **BullMQ**: Redis এর উপর বানানো একটা Node/TypeScript job queue library।

আজ সেটা বানাব। আর বানানোর পরে একটা পরীক্ষা, যেটার জন্য দুই lesson ধরে অপেক্ষা করছি। Lesson 7.1 এর শেষ experiment টা মনে করুন: in-memory queue, ধীর provider, আর ঠিক মাঝখানে API process এ `SIGKILL`। ফল ছিল:

```
   told "ok", email never sent: 103
```

১০৩ জন user "assign হয়েছে" দেখেছিল; তাদের assignee রা কোনো email পায়নি; কেউ জানেও না। আজ একই পরীক্ষা, BullMQ দিয়ে।

সাথে team এর আরও চারটা প্রশ্ন, যেগুলো code review তে উঠেছে:

1. "API না, **worker** যদি মাঝপথে মরে — email টা পাঠানোর সময়?"
2. "Provider যদি মাঝে মাঝে `503` দেয়?"
3. "User দুবার click করলে, বা timeout এর পরে browser আবার পাঠালে — দুটো email?"
4. "আর Redis **নিজে** মরলে? তখন তো সব job ই ওখানে।"

প্রতিটার উত্তর আজ exercise এ মেপে দেখব।

---

## ১. Theory

### ১.১ তিনটা অংশ: Queue, Worker, আর Redis

BullMQ এ তিনজন খেলোয়াড়:

```
   ┌──────────────── API process (×৬) ────────────────┐
   │  Express route → queue.add('assign-email', data) │   producer
   └──────────────────────────┬───────────────────────┘
                              │  job লেখা (Redis এ)
                              ▼
   ┌─────────────────────── Redis ───────────────────────┐
   │  wait: [job, job, job …]   delayed   active   …     │   সব state এখানে
   └──────────────────────────┬──────────────────────────┘
                              │  job তোলা (lock সহ)
                              ▼
   ┌──────────────── worker process (×N) ─────────────┐
   │  new Worker('emails', processor, { concurrency })│   consumer
   └──────────────────────────────────────────────────┘
```

- **`Queue`** — producer এর দিক। `queue.add(name, data, options)` job টা Redis এ লেখে, আর ফেরে যখন লেখা হয়ে গেছে।
- **`Worker`** — consumer এর দিক। Redis থেকে job তোলে, আপনার processor function চালায়, ফল অনুযায়ী job কে পরের অবস্থায় সরায়। `concurrency: 8` মানে এক process একসাথে ৮টা job চালায় (Node এ অপেক্ষার কাজের জন্য যথেষ্ট — Lesson 7.1 এর মতো)।
- **Redis** — একমাত্র জায়গা যেখানে job এর অবস্থা থাকে। API বা worker, কারো memory তে না। আজকের সব উত্তর এই একটা বাক্য থেকে আসে।

Producer এর দিক, exercise এর `api.ts` থেকে (মূল অংশ):

```typescript
const queue = new Queue<AssignEmail>(QUEUE_NAME, { connection });

app.post('/api/tasks/:id/assign', async (req: Request, res: Response): Promise<void> => {
	// … taskId and body validated with Zod …
	try {
		// queue.add returns once the job is written to Redis — after this the job survives even if the API dies
		const job = await queue.add(JOB_ASSIGN_EMAIL, data, {
			...assignJobOptions(env.ATTEMPTS), // attempts, backoff, removeOnComplete …
			jobId: assignJobId(data) // `assign-${taskId}-${assigneeId}` — in 1.7
		});
		res.status(202).json({ taskId: data.taskId, jobId: job.id });
	} catch (error: unknown) {
		// Redis can't be reached — the job wasn't written. Quietly returning 202 would be 7.1's fire-and-forget.
		res.status(503).json({ error: 'QUEUE_UNAVAILABLE' });
	}
});
```

দুটো জিনিস লক্ষ করুন। `202 Accepted` — "নিয়েছি, পরে হবে" (Lesson 7.1 এর ১.৬)। আর `catch` এ `503` — job লেখা না গেলে user কে সৎভাবে ব্যর্থতা জানানো। 7.1 এর fire-and-forget এর সবচেয়ে বড় পাপ ছিল ঠিক উল্টোটা: কাজ না নিয়েও "সফল" বলা।

Consumer এর দিক, `worker.ts`:

```typescript
async function processAssignEmail(job: Job): Promise<void> {
	// data coming from Redis — another process wrote it, so parse it instead of trusting it
	const data = assignEmailSchema.parse(job.data);
	const res = await fetch(`${env.PROVIDER_URL}/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ key: job.id, to: data.to }),
		signal: AbortSignal.timeout(env.SEND_TIMEOUT_MS) // no external call without a timeout (7.1)
	});
	if (!res.ok) throw new Error(`provider responded ${res.status}`);
}

const worker = new Worker(QUEUE_NAME, processAssignEmail, {
	connection,
	concurrency: env.CONCURRENCY,
	lockDuration: env.LOCK_MS, // in 1.5
	stalledInterval: env.STALLED_MS
});
```

**Job data কেন Zod দিয়ে parse?** Main.md এর নিয়ম — runtime input কে `as` দিয়ে বিশ্বাস করা না — এখানে বিশেষভাবে জরুরি। Job data লিখেছে **অন্য process**, হয়তো **অন্য version** এর code। বুধবার deploy হলো, job এর আকৃতিতে একটা নতুন field যোগ হলো — কিন্তু মঙ্গলবারের পুরনো আকৃতির ৫০০টা job তখনো queue তে অপেক্ষা করছে। নতুন worker তাদের পড়বে। `Queue<AssignEmail>` এর generic শুধু compile time এর প্রতিশ্রুতি; Redis এ যা আছে সেটা JSON, আর তার আকৃতি runtime এ যাচাই করতে হয়। (তাই job এর আকৃতি বদলানো একটা ছোট migration এর মতো ভাবুন — নতুন field optional রাখুন, বা job এর নামে version রাখুন।)

**Worker কেন আলাদা process?** তিনটা কারণ, সবই আগের lesson থেকে। (ক) আলাদা scale: backlog বাড়লে worker বাড়ান, API না। (খ) আলাদা deploy আর crash: worker এর bug API কে ফেলে না। (গ) CPU এর কাজ (PDF, ছবি) worker এর event loop আটকাক, API এর না — ১.৫ এ দেখবেন এটা কেন আরও গুরুত্বপূর্ণ। আর একটা ছোট নিয়ম: worker এর Redis connection এ `maxRetriesPerRequest: null` লাগে (worker একটা "blocking" command এ অপেক্ষা করে; Redis সাময়িক না থাকলে ioredis যাতে command ব্যর্থ না করে দেয়) — BullMQ নিজেও না থাকলে সতর্ক করে।

### ১.২ একটা Job এর জীবন

**Job state** — BullMQ এ প্রতিটা job যেকোনো মুহূর্তে ঠিক একটা অবস্থায় থাকে, আর এক অবস্থা থেকে আরেকটায় সরে শুধু নির্দিষ্ট নিয়মে।

```
                      queue.add()
                          │
            ┌─────────────┼───────────────────┐
            │ delay দিলে  │ সাধারণ            │ priority দিলে
            ▼             ▼                   ▼
        [delayed] ──► [waiting] ◄──────── [prioritized]
            ▲             │
            │             │ worker তুলে নিল (lock সহ)
            │             ▼
            │         [active] ────────────────────────┐
            │          │    │                           │ lock হারাল
            │  সফল     │    │ throw                     │ (worker মরা/আটকে)
            │          ▼    ▼                           ▼
            │   [completed] চেষ্টা বাকি? ── না ──► [failed]      stalled → [waiting]
            │                │                                  (বারবার হলে → failed)
            └── হ্যাঁ: backoff ┘
```

**Delayed job** — এমন job যেটা এখনই চালানোর জন্য না, একটা নির্দিষ্ট সময় পরে; ততক্ষণ `delayed` অবস্থায় অপেক্ষা করে, সময় হলে `waiting` এ যায়।

দুটো জায়গা থেকে delayed আসে: আপনি নিজে চাইলে (`queue.add(…, { delay: 24 * 3600_000 })` — "কাল সকালে deadline এর reminder পাঠান"), আর retry থেকে — একটা চেষ্টা ব্যর্থ হলে job backoff এর সময়টুকু delayed এ বসে থাকে।

Lesson 7.2 এর ভাষায় এই ছবিটা পড়ুন: `active → completed` হলো **ack**। Processor function সফলভাবে ফিরলে BullMQ job কে completed এ সরায় — তার আগে না। তাই BullMQ স্বভাবতই **at-least-once**: কাজ হলো, "completed" লেখার আগে কিছু ভাঙল — job আবার আসবে। ১.৫ এ এটা সংখ্যায় দেখবেন।

### ১.৩ ভেতরে কী আছে — আর Redis এর config কেন উল্টো

Exercise এর `npm run inspect` একটা ছোট queue তে প্রতিটা অবস্থার একটা করে job বানিয়ে Redis এর key গুলো সরাসরি দেখায় (BullMQ 5.81 এ; version ভেদে খুঁটিনাটি বদলাতে পারে):

```
   Redis keys (bull:inspect-demo:*):
     completed            zset    demo-completed
     delayed              zset    demo-delayed
     demo-completed       hash
     demo-delayed         hash
     …
     events               stream  16 events
     failed               zset    demo-failed
     prioritized          zset    demo-prioritized
     wait                 list    demo-waiting
```

প্রতিটা job একটা Redis **hash** (name, data, opts, failedReason, timestamp …)। আর অবস্থা গুলো আলাদা আলাদা collection: `wait` একটা list (FIFO), `delayed` একটা sorted set (score = কখন চালু হবে — তাই "পরের কোনটা সময় হলো" দ্রুত খোঁজা যায়), `completed`/`failed` sorted set (score = শেষ হওয়ার সময়)। `events` একটা Redis Stream — Lesson 7.2 এর log! — যেখানে প্রতিটা অবস্থা বদলের খবর থাকে, যাতে অন্য process (dashboard, `QueueEvents`) শুনতে পারে।

এক অবস্থা থেকে আরেকটায় সরানো মানে কয়েকটা key একসাথে বদলানো (list থেকে বের করুন, hash এ lock লিখুন, active এ যোগ করুন)। মাঝপথে crash হলে job অর্ধেক এখানে, অর্ধেক ওখানে থাকত। BullMQ এটা করে **Lua script** দিয়ে — Redis একটা script কে atomically চালায়, অন্য কোনো command মাঝে ঢুকতে পারে না। (Lesson 5.5 এর transaction এর ধারণা, Redis এর ভাষায়।) এই কারণেই নিয়ম: **Redis এর key সরাসরি ছোঁবেন না, সবসময় BullMQ এর API দিয়ে।**

**এবার spaced repetition এর উত্তর — আর আজকের সবচেয়ে সহজে ভুল হওয়া config।** Lesson 4.3 এ cache Redis এ `allkeys-lru` বেছেছিলাম: memory ভরলে Redis সবচেয়ে কম ব্যবহৃত key ফেলে দেয়। Cache এর জন্য এটা নিখুঁত — ফেলে দেওয়া key database থেকে আবার আসবে।

Queue এর Redis এ একই config মানে: memory ভরলে Redis **job ফেলে দেবে** — নীরবে। কোন job? যেটা সবচেয়ে কম ছোঁয়া হয়েছে — মানে লাইনের সবচেয়ে পুরনো, সবচেয়ে বেশি অপেক্ষা করা job গুলো। Backlog যখন সবচেয়ে বড় (ঠিক যখন queue এর দরকার সবচেয়ে বেশি), ঠিক তখন। তাই queue এর Redis এ:

```yaml
command: redis-server --maxmemory 256mb --maxmemory-policy noeviction --appendonly yes --appendfsync everysec
```

- **`noeviction`** — memory ভরলে কিছু ফেলবে না; নতুন লেখা ব্যর্থ হবে (`OOM` error)। তখন `queue.add` throw করবে, API `503` দেবে — চিৎকার করে ব্যর্থ হওয়া, নীরবে হারানোর চেয়ে ভালো। BullMQ নিজেও start এর সময় policy দেখে, `noeviction` না হলে সতর্ক করে (`IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"`)।
- **`appendonly yes`** — AOF, ১.৮ এ।

আর এর সরাসরি ফল: **cache আর queue একই Redis instance এ রাখা উচিত না।** দুজনের memory নীতি উল্টো, আর একটা বড় cache এর ঢেউ queue এর জায়গা খেয়ে ফেলতে পারে। আলাদা instance (বা managed service এ আলাদা database/cluster)।

### ১.৪ API মরলে — ১০৩ এর উত্তর

এবার পরীক্ষা। Load Lesson 7.1 এর মতোই: প্রতি সেকেন্ডে ২০টা assign, ৮ সেকেন্ড স্বাভাবিক → ৮ সেকেন্ড ধীর (provider প্রতি email এ ২ সেকেন্ড) → ৮ সেকেন্ড আবার স্বাভাবিক। একটা worker process, concurrency ৮। প্রথমে কেউ মরে না — `npm run scenario`:

```
   phase            API p50 / p99     API failed
   normal             22 ms / 53 ms            0
   provider slow      30 ms / 53 ms            0
   after recovery     29 ms / 35 ms            0

   most in the queue: waiting 127, delayed (waiting to retry) 0
   email delivery (from job added): p50 194 ms, p99 6.8 s, max 6.8 s
   "got 202, the email never went": 0
```

7.1 এর queue এর মতোই আকৃতি: provider ধীর হলেও API কয়েক দশ ms, ক্ষতিটা backlog আর দেরিতে। Backlog হাতে মেলান: ধীর phase এ ৮ worker ÷ ২ s = ৪ email/s বের হয়, আসে ২০ → +১৬/s × ৮ s = **১২৮** (মাপা ১২৭)। একটা পার্থক্য: API এর p50 এখন ~২০–৩০ ms, 7.1 এর in-memory queue এর ~১০ ms না — প্রতিটা `queue.add` Redis এ একটা network round trip। টেকসই হওয়ার দাম, আর সস্তা দাম।

এবার আসল পরীক্ষা — `CRASH=api`, ধীর phase এর মাঝখানে (১২ সেকেন্ডে) API process `SIGKILL`, সাথে সাথে নতুন API:

```
    12.0 s  API process SIGKILL — a new API is starting

   phase            API p50 / p99     API failed
   provider slow      32 ms / 53 ms            3

   "got 202, the email never went": 0
```

**শূন্য।** ১০৩ থেকে ০। কারণ ১.১ এর সেই বাক্য: job API এর memory তে কখনো ছিলই না। `queue.add` ফেরার মুহূর্তে job Redis এ; তার পরে API মরুক, বাঁচুক — worker job টা পাবে।

আর "API ব্যর্থ ৩" টা দেখুন — এটাও সঠিক আচরণ। মরা API এর কাছে যে ৩টা request গিয়েছিল, তাদের user রা error দেখেছে; তারা আবার চেষ্টা করবে। মিথ্যা "সফল" একটাও না। Durable queue এর আসল অর্জন এই দুটো সংখ্যার জোড়া: **যাকে "হয়েছে" বলা হয়েছে, তার কাজ হবেই; যার কাজ নেওয়া যায়নি, সে জানে।**

(একটা ফাঁক এখনো আছে, আর সেটা ইচ্ছা করে exercise এর বাইরে রাখা: আসল route এ আগে database এ assign commit হয়, তারপর `queue.add`। Commit হলো, `queue.add` এর আগে API মরল — assign আছে, job নেই। Lesson 7.1 এর ১.৬ এ এর নাম দিয়েছিলাম dual write; সমাধান — transactional outbox — Lesson 7.5 এ।)

### ১.৫ Worker মরলে — Lock, Stalled, আর দুবার

এবার team এর প্রথম প্রশ্ন: worker job তুলে নিল, provider এ request পাঠাল — তারপর মরল। Job টা এখন Redis এ `active` অবস্থায়। কেউ কি জানে যে তার worker আর নেই?

Lesson 6.1 এর প্রশ্নটাই, নতুন জায়গায়: "অন্যটা মৃত, নাকি শুধু ধীর?" আর উত্তরও একই — **lease**।

**Job lock** — worker একটা job তুলে নেওয়ার সময় Redis এ একটা মেয়াদী lock নেয় (`lockDuration`, default ৩০ সেকেন্ড), আর কাজ চলাকালীন নিয়মিত সেটা renew করে (default এ মেয়াদের অর্ধেক পর পর); renew না হলে মেয়াদ শেষে lock চলে যায়।

**Stalled job** — `active` অবস্থার এমন job যার lock এর মেয়াদ শেষ, মানে তার worker আর renew করছে না (মরেছে বা আটকে আছে); BullMQ এর stalled checker (প্রতি `stalledInterval`, default ৩০ সেকেন্ড) এমন job কে `waiting` এ ফিরিয়ে দেয়, অন্য worker এর জন্য।

`CRASH=worker-kill` — ১২ সেকেন্ডে worker `SIGKILL`, সাথে সাথে নতুন worker (exercise এ `lockDuration` ১০ s আর `stalledInterval` ৫ s — run ছোট রাখতে; default দুটোই ৩০ s):

```
    12.0 s  worker SIGKILL (active in the queue at the time: 8) — a new worker is starting

   jobs: completed 478, failed 0   · attempts needed: 1 → 478
   email delivery (from job added): p50 194 ms, p99 18.7 s, max 18.9 s
   "got 202, the email never went": 0
   the same email delivered twice (or more): 8
```

পড়ুন:

1. **কিছু হারায়নি** — মরা worker এর ৮টা active job lock এর মেয়াদ শেষে stalled হলো, নতুন worker তাদের তুলে নিল।
2. **৮টা email দুবার গেছে** — ঠিক সেই ৮টা। Worker মরার আগে তাদের request provider এ পৌঁছে গিয়েছিল; provider পাঠিয়ে দিয়েছিল; worker "completed" লেখার আগেই মরল। Lesson 7.2 এর ১.৩ এর ছবি, হুবহু: কাজের পরে ack, আর মাঝে crash → **at-least-once**।
3. **দেরি max ~১৯ সেকেন্ড** — lock এর মেয়াদ (১০ s) শেষ হওয়া আর stalled checker এর পালা আসা পর্যন্ত ওই ৮টা job কেউ ছোঁয়নি। Production default এ (৩০ s / ৩০ s) এটা exercise এর experiment ৪ এ **~৯৪ সেকেন্ড** — Lesson 6.1 এর timeout এর trade-off: ছোট lock = মরা worker দ্রুত ধরা পড়ে, কিন্তু…
4. **"চেষ্টা লেগেছে: 1 বার" সবার** — stalled হয়ে ফেরা BullMQ এর হিসাবে "চেষ্টা" (attempt) না। তবে একটা সীমা আছে: একটা job বারবার stalled হলে (`maxStalledCount`, default ১ — মানে একবার ফেরানো চলে, দ্বিতীয়বার না) সে `failed` হয়, কারণ `job stalled more than allowable limit`।

**…কিন্তু ছোট lock এর বিপদ — Lesson 6.1 আবার।** Lock একটা lease, আর 6.1 এ দেখেছি lease কীভাবে ভাঙে: **process pause**। Worker এর event loop কোনো কারণে আটকে গেলে (বড় `JSON.parse`, synchronous PDF বানানো, GC) lock renew এর timer চলে না — worker জীবিত, কাজ করছে, কিন্তু Redis এর চোখে মৃত। Exercise এর experiment ৫ ঠিক এটা: একটা job এর processor এ ১২ সেকেন্ডের synchronous loop (lock ১০ s):

```
   worker error: could not renew lock for job assign-100-1
   …
   jobs: completed 476, failed 2
   reason for failed: "job stalled more than allowable limit" × 2
   the same email delivered twice (or more): 9
```

একটা job আটকেছিল, কিন্তু lock হারাল **সবগুলো** — কারণ event loop একটা; পুরো process থেমে ছিল, তাই তার ৮টা চলমান job এর কারো lock ই renew হয়নি। সবাই stalled, সবাই আবার চলল, ৯টা duplicate। আর আটকানো job টা নিজে? আবার চালানোর সময় আবার ১২ সেকেন্ড আটকাল, আবার stalled — দ্বিতীয়বার, তাই `failed`। নিয়মিত ভেঙে পড়া job এর একটা আদিরূপ, 7.2 এর "poison message" এর মতো।

শিক্ষা, 6.1 এর মতোই: **lock এর নিরাপত্তা নির্ভর করে pause এর দৈর্ঘ্য lock এর মেয়াদের চেয়ে অনেক ছোট হওয়ার উপর।** তিনটা প্রতিকার:

- Worker এর event loop আটকাবেন না। CPU এর ভারী কাজ BullMQ এর **sandboxed processor** এ — processor টা একটা আলাদা file এ, যেটা BullMQ একটা আলাদা child process (বা worker thread) এ চালায়; তখন lock renew করে মূল process, যার event loop মুক্ত।
- `lockDuration` কে কাজের সবচেয়ে খারাপ pause এর চেয়ে বড় রাখুন — আর মেনে নিন যে মরা worker ধরা পড়তে তত দেরি।
- আর যেহেতু duplicate তবু হবে: **job কে idempotent বানান** (provider এর idempotency key, বা `sent_notifications` এ unique constraint — Lesson 6.1 আর 7.4)। Exercise এ worker ইচ্ছা করে `job.id` কে provider এর কাছে `key` হিসেবে পাঠায় — আসল provider এ সেটাই idempotency key এর জায়গা, আর তখন এই ৮টা আর ৯টা duplicate provider নিজেই বাদ দিত।

**আর graceful shutdown — deploy যেমন হওয়া উচিত।** `CRASH=worker-term` — একই মুহূর্তে, কিন্তু `SIGKILL` এর বদলে `SIGTERM`:

```
    12.0 s  worker SIGTERM (active in the queue at the time: 8) — a new worker is starting
   email delivery (from job added): p50 199 ms, p99 6.7 s, max 7.0 s
   the same email delivered twice (or more): 0
```

Duplicate **০**, দেরিতে কোনো লাফ নেই। Worker এর SIGTERM handler (Lesson 3.4 এর graceful shutdown) `worker.close()` ডাকে: নতুন job নেওয়া বন্ধ, চলমান ৮টা শেষ করা, তারপর exit। Kubernetes বা যেকোনো deploy system আগে SIGTERM দেয়, তারপর একটা grace period (Kubernetes এ default ৩০ সেকেন্ড) পরে SIGKILL। তাই নিয়ম: **grace period আপনার সবচেয়ে লম্বা job এর চেয়ে বড় হতে হবে** — নইলে প্রতিটা deploy এক একটা `worker-kill`।

### ১.৬ Provider ব্যর্থ হলে — Retry আর Backoff

Team এর দ্বিতীয় প্রশ্ন। Processor throw করলে কী হয়, সেটা job এর option ঠিক করে (`config.ts`):

```typescript
{
	attempts: 5,
	// 1 s, 2 s, 4 s, 8 s … — and ±50% jitter
	backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
	removeOnComplete: { age: 3600, count: 10_000 },
	removeOnFail: { age: 7 * 24 * 3600 }
}
```

**Exponential backoff** — প্রতিটা ব্যর্থ চেষ্টার পরে অপেক্ষার সময় গুণে বাড়ে (BullMQ এ `2^(চেষ্টা−1) × delay`: ১, ২, ৪, ৮ সেকেন্ড); সাথে jitter — প্রতিটা অপেক্ষায় একটু এলোমেলোতা — যাতে একসাথে ব্যর্থ হওয়া শত শত job একই মুহূর্তে আবার ঝাঁপিয়ে না পড়ে।

কেন গুণে বাড়ে? Provider যদি সাময়িক চাপে থাকে, সাথে সাথে আবার চেষ্টা তার চাপ আরও বাড়ায়; অপেক্ষা বাড়ালে তাকে সেরে ওঠার সময় দেওয়া হয়। (এর বিস্তারিত — কখন retry করবেন না, কত পর্যন্ত, jitter এর গণিত — Lesson 7.4 এর পুরোটা।)

`FAIL_RATE=0.3` — provider ৩০% সময় `503`:

```
   most in the queue: waiting 143, delayed (waiting to retry) 21
   jobs: completed 477, failed 1   · attempts needed: 1 → 341, 2 → 86, 3 → 36, 4 → 11, 5 → 3
   provider: distinct emails delivered 477, returned 503 208 times
   email delivery (from job added): p50 2.2 s, p99 14.5 s, max 18.8 s
   "got 202, the email never went": 1
```

চেষ্টার বণ্টনটা দেখুন — প্রায় জ্যামিতিক: প্রতিবার ~৭০% সফল, তাই প্রতিটা ধাপে আগেরটার ~৩০%। ৫ বারই ব্যর্থ হওয়ার সম্ভাবনা 0.3⁵ ≈ 0.24%, ৪৭৮ এর মধ্যে ~১.২ — আর ঠিক **১টা** job `failed`। Retry ছাড়া (experiment ৩, `ATTEMPTS=1`) failed হয় ১৪২টা, ~৩০%।

আর সেই ১টা? "202 পেল, email যায়নি: 1" — কিন্তু 7.1 এর fire-and-forget এর ৬০ এর সাথে এর একটা মৌলিক পার্থক্য: এটা **দৃশ্যমান**। `failed` set এ আছে, কারণ সহ (`provider responded 503`), ৭ দিন থাকবে (`removeOnFail`)। কেউ দেখতে পারে, alert দিতে পারে, ঠিক করে আবার চালাতে পারে (`job.retry()`)। ব্যর্থতা থাকবেই; প্রশ্ন শুধু ব্যর্থতা কোথায় যায় — নীরবতায়, নাকি একটা তালিকায়। (এই তালিকার আনুষ্ঠানিক নাম dead letter queue — 7.4।)

দুটো সূক্ষ্মতা:

- **সব ব্যর্থতা retry এর যোগ্য না।** `503` সাময়িক — আবার চেষ্টায় লাভ আছে। কিন্তু "email address টা অবৈধ" (provider এর `400`) চিরস্থায়ী — ৫ বার চেষ্টা করে শুধু সময় নষ্ট। BullMQ এ এর জন্য `UnrecoverableError` throw করলে বাকি চেষ্টা বাদ দিয়ে সরাসরি failed।
- **`removeOnComplete` দরকার।** Default এ BullMQ শেষ হওয়া প্রতিটা job চিরকাল রাখে। দিনে ১০ লাখ email মানে দিনে ১০ লাখ hash — আর `noeviction` এ Redis ভরে গেলে (১.৩) queue নিজেই থেমে যায়।

### ১.৭ একই কাজ দুবার যোগ হলে — নিজের Job ID

Team এর তৃতীয় প্রশ্ন: user দুবার click করল, বা browser timeout এর পরে আবার পাঠাল (Lesson 6.1 — timeout মানে "জানি না", তাই client আবার পাঠায়)। BullMQ এর default job ID একটা বাড়তে থাকা সংখ্যা — দুটো request, দুটো job, দুটো email।

**Job ID deduplication** — job এর ID নিজে বানানো, কাজটার data থেকে (যেমন `assign-{taskId}-{assigneeId}`), যাতে একই কাজ দুবার যোগ হলে দুটো একই ID পায়; BullMQ ইতিমধ্যে থাকা ID এর দ্বিতীয় job যোগ করে না।

`DOUBLE_SUBMIT=1` — প্রতিটা assign দুবার পাঠানো:

```
   API returned 202: 954 times, distinct jobs: 477
   provider: distinct emails delivered 477
   the same email delivered twice (or more): 0
```

৯৫৪টা request, ৪৭৭টা job, ৪৭৭টা email। Lesson 2.5 এর idempotency key এর queue-রূপ — আর এবার key টা client দেয়নি, কাজের **পরিচয়** থেকে এসেছে।

তিনটা সীমা, প্রতিটা জরুরি:

1. **ID বাছাই একটা design সিদ্ধান্ত।** `assign-{taskId}-{assigneeId}` মানে: একই মানুষকে একই task এ আবার assign করলে (সরিয়ে, তারপর আবার) দ্বিতীয় email যাবে না — যদি প্রথম job এখনো Redis এ থাকে। সেটা কি চান? নইলে ID তে assignment এর নিজের id বা version যোগ করুন। (আর BullMQ এর custom ID তে `:` চলে না, শুধু সংখ্যাও না — তাই `-`।)
2. **Dedupe শুধু যতক্ষণ job Redis এ আছে।** `removeOnComplete` এক ঘণ্টা পরে job মুছে দেয়; তারপর একই ID আবার যোগ করা যায়। দীর্ঘমেয়াদী "একবারই" এর জন্য database এর unique constraint (7.4)। (BullMQ এর আলাদা একটা `deduplication` option ও আছে, নির্দিষ্ট TTL এর জন্য — debounce/throttle ধরনের কাজে।)
3. **এটা যোগ করার duplicate আটকায়, প্রক্রিয়ার না।** ১.৫ এর stalled job এর duplicate একই ID এর একই job, দুবার **চালানো** — ID সেটা আটকায় না। দুটো আলাদা সমস্যা, দুটো আলাদা সমাধান।

### ১.৮ Redis নিজে মরলে

শেষ প্রশ্ন, আর সবচেয়ে সৎ উত্তর দরকার যেটার: "সব job তো Redis এ — Redis মরলে?"

প্রথম অংশ: Redis এর data memory তে। Restart মানে memory খালি — **যদি না** Redis disk এ কিছু লিখে রাখে। দুটো উপায়: RDB (নির্দিষ্ট সময় পর পর পুরো snapshot — দুটো snapshot এর মাঝের লেখা ঝুঁকিতে) আর AOF।

**AOF (Append-only File)** — Redis প্রতিটা লেখার command একটা file এর শেষে যোগ করে; restart এ file টা আবার চালিয়ে data ফেরত আনে। `appendfsync everysec` মানে file টা প্রতি সেকেন্ডে disk এ পাকা হয় — তাই হঠাৎ মৃত্যুতে সর্বোচ্চ ~১ সেকেন্ডের লেখা হারাতে পারে; `always` এ প্রতিটা লেখায় (নিরাপদ, কিন্তু অনেক ধীর)।

(Lesson 5.3 এর WAL এর কথা মনে পড়ছে? একই ধারণা — আগে খাতায় লিখুন, তারপর মনে রাখুন।)

Exercise এর experiment ১ — scenario চলার সময় আরেক terminal থেকে Redis কে থামানো:

- `docker compose restart redis` (SIGTERM — Redis গুছিয়ে বন্ধ হয়, ~১ সেকেন্ড): কিছু হারায়নি; API এর p99 ১ সেকেন্ডে উঠেছিল, একটাও ব্যর্থ না।
- `docker compose kill redis`, ২ সেকেন্ড পরে start (SIGKILL — Redis কিছু গোছানোর সুযোগ পায় না): এই run এও কিছু হারায়নি, duplicate ০; API এর p99 ৩ সেকেন্ড, একটাও ব্যর্থ না।

API ব্যর্থ হলো না কেন? কারণ ioredis (BullMQ এর Redis client) connection হারালে command গুলো নিজের কাছে ধরে রাখে আর reconnect এর পরে পাঠায় — তাই API এর `queue.add` ৩ সেকেন্ড অপেক্ষা করল, ব্যর্থ হলো না। সুবিধাজনক — কিন্তু Redis ৩০ সেকেন্ড না ফিরলে? তখন API এর প্রতিটা request ঝুলবে (7.1 এর cascading failure এর চেনা আকৃতি)। তাই API এর দিকের connection এ একটা সীমা রাখা ভালো (ioredis এর `enableOfflineQueue`/`commandTimeout` — Lesson 4.4 এর experiment ৪ এর মতো), যাতে Redis না থাকলে `queue.add` দ্রুত ব্যর্থ হয়ে `503` যায়।

এবার সৎ অংশ:

- **"এই run এ কিছু হারায়নি" মানে "কখনো হারাবে না" না।** `everysec` এ SIGKILL এর মুহূর্তের শেষ ~১ সেকেন্ডের লেখা ঝুঁকিতে — এই run এ ভাগ্য ভালো ছিল। `202` দেওয়া একটা job সেই সেকেন্ডে থাকলে সেটা যাবে।
- **Production এ Redis সাধারণত replica সহ চলে, আর replication async।** Primary মরল, replica promote হলো — primary তে লেখা হয়েছিল কিন্তু replica তে পৌঁছায়নি এমন job হারায়। Lesson 5.7 এর RPO, হুবহু।
- তাই BullMQ এর নিশ্চয়তা Redis এর নিশ্চয়তার চেয়ে বেশি হতে পারে না। Email এর জন্য এটা যথেষ্টর চেয়ে বেশি। কিন্তু যে কাজ **কিছুতেই** হারানো চলবে না (payment এর পরের ধাপ, billing), সেখানে job এর উৎস হওয়া উচিত database — database এর transaction এর ভেতরে "এই কাজ করতে হবে" লেখা, তারপর সেখান থেকে queue তে তোলা। সেটাই transactional outbox, Lesson 7.5।

### ১.৯ TaskFlow এর production checklist

সব একসাথে — TaskFlow এর job system চালু করার আগে যা যা ঠিক করতে হবে:

| সিদ্ধান্ত                 | TaskFlow এর জন্য                                                         | কেন                                                                |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Redis                     | আলাদা instance, `noeviction`, AOF `everysec`, replica                    | Job ফেলে দেওয়া চলবে না (১.৩); restart এ টিকবে (১.৮)               |
| Worker                    | আলাদা deploy, CPU এর কাজ sandboxed processor এ                           | আলাদা scale/crash; event loop আটকালে lock যায় (১.৫)               |
| Concurrency               | Little's Law: `আসার হার × কাজের সময়`, আর provider এর rate limit এর নিচে | কম হলে backlog, বেশি হলে provider `429` (7.1); BullMQ এর `limiter` |
| `lockDuration`            | Default ৩০ s রাখুন, কাজ ছোট রাখুন                                        | ছোট = দ্রুত ধরা, কিন্তু pause এ মিথ্যা stalled (১.৫)               |
| Graceful shutdown         | SIGTERM → `worker.close()`; grace period > সবচেয়ে লম্বা job             | নইলে প্রতিটা deploy এ duplicate (১.৫)                              |
| Retry                     | ৫ বার, exponential + jitter; চিরস্থায়ী error এ `UnrecoverableError`     | সাময়িক ব্যর্থতা সারে, চিরস্থায়ী তে সময় নষ্ট হয় না (১.৬)        |
| Job ID                    | কাজের পরিচয় থেকে (`assign-{taskId}-{assigneeId}`)                       | Double submit এ একটাই job (১.৭)                                    |
| Idempotency               | Provider এ idempotency key / `sent_notifications` unique constraint      | Stalled আর crash থেকে duplicate হবেই (১.৫) — 7.4                   |
| Job data                  | ছোট — ID গুলো, পুরো object না; Zod দিয়ে parse                           | পুরনো version এর job; আর worker নতুন data database থেকে পড়ুক      |
| `removeOnComplete`/`Fail` | শেষ হওয়া ১ ঘণ্টা, ব্যর্থ ৭ দিন                                          | Redis ভরে না; ব্যর্থ গুলো দেখার সময় থাকে                          |
| মাপা                      | waiting সংখ্যা, **সবচেয়ে পুরনো waiting job এর বয়স**, failed এর হার     | Backlog আর মরা worker ধরা (7.1); একটা dashboard (যেমন Bull Board)  |

"Job data ছোট রাখুন" নিয়ে এক লাইন: assign email এর job এ পুরো task object রাখলে, job চলার সময় (হয়তো ৩০ সেকেন্ড পরে, backlog এ) task এর title বদলে গিয়ে থাকতে পারে — email পুরনো title দেখাবে। Job এ শুধু `taskId` রাখুন, worker database থেকে তাজা data পড়ুক। (ব্যতিক্রম: যখন আপনি ইচ্ছা করেই সেই মুহূর্তের data চান — যেমন "assign করার সময় কে assign করেছিল"।)

---

## ২. Interview Angle

**"Background job system design করুন" বা "notification system এ email কীভাবে পাঠাবেন?"** — এখানে BullMQ এর নাম লাগে না; লাগে ধারণাগুলো, আর interviewer এর follow-up এর তালিকা প্রায় নির্দিষ্ট: worker মরলে কী হয় (lock/visibility timeout → আবার আসে → at-least-once → idempotent consumer); retry কীভাবে (exponential backoff + jitter, সাময়িক বনাম চিরস্থায়ী error); বারবার ব্যর্থ হলে (dead letter — failed set); একই কাজ দুবার যোগ হলে (deterministic job ID); queue এর store মরলে (persistence, replication এর lag, আর গুরুত্বপূর্ণ কাজের জন্য outbox)। এই পাঁচটা উত্তর তৈরি থাকলে যেকোনো queue tool এর নামে কাজ চলে — AWS SQS এর "visibility timeout" আর BullMQ এর "lock" একই ধারণা।

**"Delayed job কীভাবে বানাবেন — যেমন deadline এর ১ দিন আগে reminder?"** — দুটো পথ, আর trade-off বলা জরুরি: (ক) task তৈরির সময় একটা delayed job (`delay` = deadline − ১ দিন − এখন) — সহজ, কিন্তু deadline বদলালে পুরনো job বাতিল করতে হবে (নিজের job ID থাকলে সহজ: `reminder-{taskId}` মুছে নতুন যোগ), আর মাসখানেক পরের job মাসখানেক Redis এ বসে থাকে; (খ) একটা repeatable/cron job প্রতি কয়েক মিনিটে database থেকে "কাল deadline এমন task" খোঁজে — database ই source of truth, deadline বদলানো কিছু না, কিন্তু একটা query বারবার। বড় সংখ্যা আর বদলাতে থাকা সময়ের জন্য (খ) প্রায়ই নিরাপদ — আর Lesson 6.1 এর মতো তখন নিশ্চিত করতে হয় যে cron টা একজনই চালায় (BullMQ এর repeatable job এর নিজস্ব ব্যবস্থা আছে)।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ incident গুলো প্রায় সবসময় এই lesson এর একটা লাইন: cache আর queue একই Redis এ, `allkeys-lru` — backlog এর দিন job হারাল; `removeOnComplete` নেই — Redis এর memory ধীরে ধীরে ভরে একদিন `OOM`; worker এ একটা synchronous ভারী কাজ — "কেন একই invoice দুবার গেল?"; deploy এর grace period job এর চেয়ে ছোট — প্রতিটা deploy এ কয়েকটা duplicate; আর কেউ `failed` set দেখে না — মাসে কয়েকশো কাজ নীরবে পড়ে থাকে।

---

## ৩. Key Takeaway

- BullMQ: API এ `Queue` (producer), আলাদা process এ `Worker` (consumer), আর **সব state Redis এ** — কারো memory তে না। Job data অন্য process/version এর লেখা, তাই Zod দিয়ে parse
- Job এর জীবন: waiting/delayed/prioritized → active (lock সহ) → completed (= ack) বা retry (backoff → delayed) বা failed; lock হারালে stalled → আবার waiting
- Queue এর Redis এ **`noeviction` + AOF**, cache এর উল্টো; cache আর queue আলাদা instance এ
- API মরলে: 7.1 এর **১০৩ → ০** — `queue.add` ফেরার আগেই job Redis এ; আর যার job নেওয়া যায়নি সে `503` পায়, মিথ্যা "সফল" না
- Worker মরলে: **job lock** এর মেয়াদ শেষে **stalled** → আবার চলে — কিছু হারায় না, কিন্তু চলমান গুলো **দুবার** (exercise এ ৮টা)। Event loop আটকালেও একই (৬.১ এর pause); graceful shutdown (SIGTERM → `worker.close()`) এ duplicate ০
- **Exponential backoff** + jitter সাময়িক ব্যর্থতা সারায় (৩০% ব্যর্থতায় ৪৭৮ এর ৪৭৭ পৌঁছায়), আর বাকিটা **দৃশ্যমান** `failed` এ থাকে — নীরবে না
- নিজের **job ID** যোগ করার duplicate আটকায় (৯৫৪ request → ৪৭৭ email), প্রক্রিয়ার duplicate না; Redis এর persistence আর async replication এর সীমাই queue এর সীমা — গুরুত্বপূর্ণ কাজে outbox (7.5)

---

## ৪. নতুন Term (Glossary)

| Term                       | অর্থ                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Job State**              | BullMQ এ job এর অবস্থা (waiting, delayed, prioritized, active, completed, failed) — প্রতি মুহূর্তে একটা, নির্দিষ্ট নিয়মে বদলায় |
| **Delayed Job**            | নির্দিষ্ট সময় পরে চালানোর job — ততক্ষণ `delayed` এ থাকে; নিজে চাইলে বা retry এর backoff থেকে                                    |
| **Job Lock**               | Worker job তোলার সময় Redis এ নেওয়া মেয়াদী lock (`lockDuration`), কাজ চলাকালীন renew হয় — একটা lease                          |
| **Stalled Job**            | Lock এর মেয়াদ শেষ হওয়া active job (worker মরা বা আটকে); stalled checker তাকে আবার waiting এ ফেরায়                             |
| **Exponential Backoff**    | প্রতিটা ব্যর্থ চেষ্টার পরে অপেক্ষা গুণে বাড়ে (১, ২, ৪, ৮ s …), jitter সহ যাতে সবাই একসাথে আবার না আসে                           |
| **Job ID Deduplication**   | কাজের data থেকে বানানো job ID — একই কাজ দুবার যোগ হলে একই ID, আর দ্বিতীয়টা যোগ হয় না                                           |
| **AOF (Append-only File)** | Redis প্রতিটা লেখা একটা file এ যোগ করে, restart এ আবার চালিয়ে data ফেরায়; `everysec` এ সর্বোচ্চ ~১ s ঝুঁকি                     |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর CSV export: user "export" চাপলে একটা job — ৫০ হাজার task পড়া, CSV বানানো (CPU এর কাজ, ~৪০ সেকেন্ড), S3 এ upload, তারপর user কে email এ link। Worker এর option (`lockDuration`, concurrency, attempts), processor কোথায় চলবে, job এ কী data রাখবেন, আর user কীভাবে জানবে export তৈরি কিনা — সব ঠিক করুন। Default `lockDuration` (৩০ s) রেখে দিলে কী হতো, exercise এর কোন experiment এর মতো?
2. একজন engineer বলল: "আমাদের cache Redis তো আছে, ১৬ GB, অর্ধেক খালি। আরেকটা Redis চালানোর খরচ কেন? Queue ওখানেই রাখি।" আপনি কী উত্তর দেবেন — কী কী ভুল হতে পারে, কোন ঘটনার ক্রমে? যদি budget সত্যিই না থাকে, সবচেয়ে কম খারাপ বিকল্প কী?
3. Deadline reminder: "task এর deadline এর ২৪ ঘণ্টা আগে assignee কে email।" (ক) Task তৈরির সময় একটা delayed job, (খ) প্রতি ৫ মিনিটে একটা repeatable job যেটা database খোঁজে — দুটো design এর জন্য বলুন: deadline বদলালে কী করতে হয়, task delete হলে, Redis এর data হারালে, আর একই reminder দুবার যাওয়া কীভাবে আটকাবেন। কোনটা বাছবেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

- **Processor কোথায়:** CSV বানানো CPU এর কাজ, ৪০ সেকেন্ড event loop আটকাবে — তাই **sandboxed processor** (আলাদা child process/worker thread)। নইলে ১.৫ এর experiment ৫ এর মতো: ৪০ সেকেন্ড lock renew হবে না, default ৩০ s এর lock হারাবে, job stalled হয়ে আবার চলবে — আর সেই worker এর **অন্য সব** চলমান job ও (event loop একটা)। দ্বিতীয়বারও ৪০ সেকেন্ড, আবার stalled → `job stalled more than allowable limit` → failed। Export কখনো শেষ হবে না।
- **আলাদা queue:** export কে email এর queue তে না — `exports` নামে আলাদা queue, আলাদা worker। নইলে ৪০ সেকেন্ডের কাজ email এর worker এর জায়গা আটকায় (7.1 এর প্রশ্ন ৩ এর মতো)।
- **Option:** concurrency কম (১–২ প্রতি worker, CPU এর কাজ — core এর সংখ্যা ধরে); `lockDuration` sandboxed হলে default ঠিক আছে (মূল process renew করে), না হলে কাজের সবচেয়ে খারাপ সময়ের বেশি; attempts ৩, backoff exponential — S3 বা database এর সাময়িক সমস্যার জন্য।
- **Job data:** `{ exportId, userId, filters }` — task গুলো না। Worker database থেকে পড়বে। আর `exports` table এ একটা row (`status: 'pending' | 'running' | 'done' | 'failed'`, `url`) — source of truth।
- **User জানবে কীভাবে:** API `202` আর `exportId` দেয়; UI `GET /api/exports/:id` দিয়ে polling করে (বা SSE, Lesson 2.4); শেষে email এ link। Job ID = `export-{exportId}` — double click এ দুটো export না।
- **Idempotency:** job দুবার চললে (stalled) S3 এ একই key তে দুবার upload — ক্ষতি নেই (একই ফাইল ওভাররাইট); কিন্তু email দুবার যেতে পারে → `exports.emailSentAt` দেখে পাঠানো।

**প্রশ্ন ২:** ঘটনার ক্রম: cache Redis এ `allkeys-lru` (cache এর জন্য সঠিক)। একদিন provider ধীর, email এর backlog ২ লাখ job। একই সময়ে traffic এর চাপে cache ও বড় হচ্ছে। Memory সীমায় পৌঁছায় — Redis LRU অনুযায়ী key ফেলে: সবচেয়ে কম ছোঁয়া key, মানে **সবচেয়ে পুরনো waiting job** গুলো (আর তাদের hash)। কোনো error নেই, কোনো log নেই (BullMQ শুধু start এ একটা সতর্কবাণী দিয়েছিল)। Job এর অর্ধেক অংশ (list এ ID আছে, hash নেই) হলে worker অদ্ভুত error দেখবে। উল্টো দিকে `noeviction` করলে — cache এর লেখা `OOM` এ ব্যর্থ হবে, মানে cache ভরা মাত্রই পুরো app এর cache layer error দিতে শুরু করবে (৪.৪ এর fail-safe না থাকলে app ই)। দুটো নীতি একসাথে সম্ভব না।

আরও: একটা cache এর ঢেউ (বড় key, অনেক miss) queue এর latency বাড়ায়; cache এর জন্য persistence বন্ধ রাখা ঠিক (দ্রুত), queue এর জন্য AOF লাগে — আবার উল্টো।

সবচেয়ে কম খারাপ বিকল্প (budget না থাকলে): একই machine এ **দুটো Redis process** (আলাদা port, আলাদা `maxmemory`, আলাদা policy, queue এর টায় AOF) — খরচ প্রায় একই, নীতি আলাদা। অথবা, managed service এ ছোট একটা আলাদা instance — queue এর memory সাধারণত ছোট (যদি `removeOnComplete` ঠিক থাকে)। যা করা চলবে না: একই process এ দুই নীতি ধরে নেওয়া।

**প্রশ্ন ৩:**

| ঘটনা                | (ক) Task তৈরির সময় delayed job                                                        | (খ) প্রতি ৫ মিনিটে repeatable job, database খোঁজে                                      |
| ------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Deadline বদলাল      | পুরনো job মুছে নতুন যোগ (`reminder-{taskId}` ID থাকলে সহজ) — ভুলে গেলে ভুল সময়ে email | কিছু না — পরের খোঁজে নতুন deadline দেখবে                                               |
| Task delete         | Job মুছতে হবে, নইলে worker কে "task আছে কিনা" দেখতে হবে                                | কিছু না                                                                                |
| Redis এর data হারাল | ভবিষ্যতের সব reminder গেল — আর কেউ জানে না                                             | কিছু হারায় না — database ই source of truth; পরের খোঁজে আবার                           |
| দুবার যাওয়া আটকানো | Job ID dedupe + stalled এর জন্য idempotent পাঠানো                                      | খোঁজা আর পাঠানোর মাঝে দুবার না — `reminder_sent_at` column, শর্তসহ update (6.1 এর মতো) |
| খরচ                 | মাসের পরের reminder মাসভর Redis এ বসে                                                  | প্রতি ৫ মিনিটে একটা query (index লাগবে: `deadline`, `reminder_sent_at`)                |

বাছাই: TaskFlow এর জন্য (খ) — deadline প্রায়ই বদলায়, আর "Redis এর data হারালে ভবিষ্যতের reminder নীরবে যায়" এর ঝুঁকি নেওয়ার কারণ নেই। খোঁজা job নিজে একজনই চালাবে (BullMQ এর repeatable job একটা নির্দিষ্ট job ID দিয়ে সেটা নিশ্চিত করে), আর প্রতিটা reminder আলাদা একটা email job হিসেবে (`reminder-{taskId}-{deadline}`) queue তে — তাতে email এর retry আর ব্যর্থতা আলাদা হিসাবে থাকে। (ক) ঠিক জায়গা: এক-দুবারের, না-বদলানো সময়ের কাজ — "sign up এর ৩ দিন পরে একটা tip email"।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (Docker এ Redis; API, worker আর নকল email provider আলাদা Node process)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-7.3-bullmq/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.3-bullmq) — `docker compose up -d --wait && npm install`, তারপর `npm run scenario` (সাথে `CRASH=api`, `CRASH=worker-kill`, `CRASH=worker-term`, `FAIL_RATE=0.3`, `DOUBLE_SUBMIT=1`) আর `npm run inspect`। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`api.ts` producer, `worker.ts` consumer (graceful shutdown সহ), `provider.ts` নকল email provider যেটা গোনে কোন email কয়বার পৌঁছাল, আর `scenario.ts` সবাইকে চালায়, load দেয়, দরকার হলে কাউকে মারে, আর শেষে হিসাব মেলায় — কাকে `202` দেওয়া হয়েছিল বনাম provider এ আসলে কী পৌঁছেছে।

**সৎ নোট:** Sandbox এ Docker এর Redis 8 আর BullMQ 5.81.5 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; baseline আর পাঁচটা run (`CRASH=api`, `worker-kill`, `worker-term`, `FAIL_RATE=0.3`, `DOUBLE_SUBMIT=1`), `WORKER_PROCS=2`, `ATTEMPTS=1` (দুবার), production default lock, event loop আটকানো (experiment ৫, `worker.ts` বদলে তারপর ফিরিয়ে), আর Redis এর restart ও kill — সব চালানো হয়েছে, সংখ্যা README তে। আসল process আর আসল timer, আর `FAIL_RATE` এর ব্যর্থতা এলোমেলো — তাই সংখ্যা প্রতিবার সামান্য আলাদা হবে। Scenario তে `lockDuration` ১০ s আর `stalledInterval` ৫ s (default ৩০/৩০) — run ছোট রাখতে। Redis kill এর পরে "কিছু হারায়নি" একটা run এর ফল — `everysec` এ ~১ সেকেন্ডের ঝুঁকি আছেই। Experiment ১ এর AOF বন্ধ করার অংশটা চালানো হয়নি — ওটা আপনার।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **১০৩ এর বদলা:** `CRASH=api npm run scenario` চালান, আর পাশে Lesson 7.1 এর `CRASH_AT_MS=14000 npm run scenario -- queue` এর ফল রাখুন। দুটো সংখ্যার পার্থক্যের কারণ এক বাক্যে লিখুন। তারপর: এই exercise এ database নেই — আসল route এ database commit আর `queue.add` এর মাঝে API মরলে কী হবে? (Lesson 7.5 এর জন্য প্রশ্নটা লিখে রাখুন।)

2. **Kill বনাম Term:** `CRASH=worker-kill` আর `CRASH=worker-term` চালান। "দুবার পৌঁছেছে" আর "দেরি max" এর পার্থক্য ব্যাখ্যা করুন — lock, stalled checker, আর `worker.close()` দিয়ে। তারপর experiment ৪ (production default lock) — দেরি কত হলো, আর TaskFlow এর deploy এর grace period কত রাখবেন?

3. **Event loop আটকান** (experiment ৫): নির্দেশ মতো `worker.ts` বদলান, চালান, আর worker এর log আর ফল পড়ুন। একটা job আটকালে আটটার lock কেন গেল? Failed এর কারণ কী, আর কেন ঠিক ২টা? তারপর processor টাকে BullMQ এর sandboxed processor বানান (আলাদা file, `new Worker(QUEUE_NAME, path.join(__dirname, 'processor.js'), …)`) আর আবার চালান — কী বদলাল? (শেষে code আগের মতো করুন।)

4. **Retry এর হিসাব:** `FAIL_RATE=0.3` আর `FAIL_RATE=0.3 ATTEMPTS=1` চালান। চেষ্টার বণ্টন হাতে হিসাব করুন (প্রতিবার ৭০% সফল হলে ৪৭৮ এর কতগুলো ১ বারে, ২ বারে …), আর মেলান। তারপর provider কে এমনভাবে বদলান যাতে `to` তে একটা নির্দিষ্ট address এর জন্য সবসময় `400` দেয়, আর worker এ `400` পেলে `UnrecoverableError` throw করুন — সেই job কয়বার চেষ্টা হলো?

5. **Design অংশ:** TaskFlow এর সব background job এর একটা তালিকা (অন্তত ৬টা: assign email, mention email, password reset, CSV export, attachment thumbnail, deadline reminder)। প্রতিটার জন্য: কোন queue (একটা, নাকি আলাদা — কেন), job ID কীভাবে বানাবেন, attempts আর backoff, concurrency (Little's Law দিয়ে, নিজের ধরে নেওয়া সংখ্যায়), CPU এর কাজ হলে sandboxed কিনা, আর duplicate হলে ক্ষতি কী আর কীভাবে আটকাবেন। শেষে TaskFlow এর queue Redis এর config (policy, persistence, memory) — এক লাইনে প্রতিটার কারণ।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (সম্পূর্ণ, exit challenge সহ), 7.1, 7.2
Current: 7.3 — BullMQ hands-on: Express এ background job processing
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; background job: BullMQ, আলাদা queue Redis (noeviction + AOF
everysec, cache থেকে আলাদা), আলাদা worker process (graceful shutdown), assign email এর job
ID = assign-{taskId}-{assigneeId}, attempts 5 + exponential backoff/jitter, failed ৭ দিন;
events (comment.created, task.completed) → Redis Streams (7.2); বাকি: idempotent consumer
(7.4), database ↔ queue এর dual write (7.5)
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: 7.4 — Idempotency, retry, exponential backoff, DLQ, backpressure
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠান — বিশেষ করে ৩ নম্বরের event loop এর ব্যাখ্যা আর ৫ নম্বরের job এর তালিকা। রেডি হলে `next` লিখুন — Lesson 7.4 এ যাব: **Idempotency, Retry, Exponential Backoff, DLQ, আর Backpressure।** আজ তিনবার একই দেয়ালে ধাক্কা খেয়েছি: worker kill এ ৮টা duplicate, event loop আটকানোয় ৯টা, আর প্রতিবার উত্তর ছিল "consumer কে idempotent বানান — 7.4 এ।" এবার সেটা বানানো: একটা consumer যেটা একই job দশবার পেলেও email একবারই পাঠায় — আর ঠিক কোন জায়গায় সেটাও ভাঙতে পারে। সাথে retry এর বাকি প্রশ্ন: কখন retry করবেন না, কত পর্যন্ত, আর সবাই একসাথে retry করলে কীভাবে আপনি নিজেই নিজের provider কে ফেলে দিন (retry storm); failed job এর তালিকা — dead letter queue — দিয়ে কী করবেন; আর backlog যখন সত্যিই সীমাহীন বাড়ছে, তখন producer কে "থামুন" বলার উপায় — backpressure।
