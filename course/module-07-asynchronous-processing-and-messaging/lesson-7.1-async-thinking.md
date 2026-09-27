# Lesson 7.1 — কেন সবকিছু Synchronous হলে System মরে যায়: Async Thinking

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 1.5):** TaskFlow এর SLO 99.9%। ৩০ দিনের মাসে error budget কত মিনিট? আজ দেখবে, একটা request এর পথে যতগুলো বাইরের service থাকে, এই budget তাদের সবার মধ্যে ভাগ হয়ে যায় — তুমি চাও বা না চাও।

**Prerequisite:** Lesson 1.5 (Latency, availability), Lesson 2.5 (Idempotency), Lesson 5.5 (Transaction), Lesson 5.6 (Connection pool, pool exhaustion, Little's Law), Lesson 6.1 (Partial failure, timeout মানে "জানি না")

**তুমি এই lesson শেষে পারবে:**

1. একটা request এর **critical path** আঁকতে পারবে, আর হিসাব করে বলতে পারবে পথের প্রতিটা synchronous dependency কীভাবে latency যোগ করে আর availability গুণ করে কমায়
2. ব্যাখ্যা করতে পারবে কীভাবে একটা **ধীর** dependency (মৃত না, শুধু ধীর) একটা ভাগ করা resource (connection pool) দখল করে পুরো app ফেলে দেয় — Little's Law দিয়ে সংখ্যা সহ
3. একটা কাজ request এর ভেতরে থাকবে নাকি বাইরে যাবে — একটা প্রশ্নের তালিকা দিয়ে সিদ্ধান্ত নিতে পারবে; আর fire-and-forget, in-memory queue, টেকসই queue — কোনটা কী সমাধান করে আর কী করে **না**, বলতে পারবে

**Tier:** 1 — Runnable Code (তিনটা আসল Node process: নকল email provider, TaskFlow API এর চারটা সংস্করণ, আর একটা load generator)

---

## ০. TaskFlow এখন কোথায়

Module 6 শেষে TaskFlow এর চেহারা: Nginx এর পেছনে ৬টা Express instance, Redis cache, PostgreSQL primary + ৩টা read replica, Patroni + etcd দিয়ে failover। Consistency নিয়ে design doc লেখা হয়েছে, reminder job fencing token দিয়ে সুরক্ষিত।

Product team এর নতুন চাওয়া, সবচেয়ে সাধারণ চাওয়াগুলোর একটা: **"কাউকে task assign করলে তাকে একটা email যাক।"**

এক বিকেলে কাজ শেষ। Code টা পরিষ্কার, typed, আর review এ সবাই খুশি:

```typescript
router.post(
	'/tasks/:id/assign',
	async (req: Request<{ id: string }>, res: Response<AssignResponse>): Promise<void> => {
		const { assigneeId } = assignSchema.parse(req.body);
		const task = await sequelize.transaction(async (t) => {
			const task = await Task.findByPk(Number(req.params.id), {
				transaction: t,
				lock: t.LOCK.UPDATE
			});
			if (!task) throw new NotFoundError('task');
			const assignee = await User.findByPk(assigneeId, { transaction: t, rejectOnEmpty: true });
			await task.update({ assigneeId }, { transaction: t });
			await Activity.create({ taskId: task.id, kind: 'assigned' }, { transaction: t });
			// email ব্যর্থ হলে পুরো transaction rollback — "সব হবে, নয়তো কিছুই না"
			await mailer.send({
				to: assignee.email,
				template: 'task-assigned',
				data: { taskId: task.id }
			});
			return task;
		});
		res.json({ taskId: task.id, assigneeId });
	}
);
```

Email টা transaction এর ভেতরে কেন? যে লিখেছে তার যুক্তি শুনতে ভালো: "email না গেলে assign ও হবে না — atomic।" (যুক্তিটা আসলে ভুল — কেন, ১.৪ এ।)

তিন সপ্তাহ সব ঠিক। তারপর এক সোমবার, সকাল ১০:০২। Email provider এর status page এ হলুদ একটা লাইন: _"Degraded performance — elevated API latency."_ তাদের API মরেনি — শুধু যেখানে ১৫০ ms এ উত্তর দিত, এখন দিচ্ছে ৪ সেকেন্ডে।

১০:০৩ এ TaskFlow এর on-call engineer এর phone বাজছে। কিন্তু alert টা email নিয়ে না — alert বলছে: **dashboard লোড হচ্ছে না, task list আসছে না, login ব্যর্থ।** পুরো app পড়ে গেছে।

Monitoring খুলে যা দেখা গেল, সেটাই সবচেয়ে বিভ্রান্তিকর:

- Express instance গুলোর CPU: ১২%। Event loop আটকানো না।
- Postgres এর CPU: ৮%। কোনো ধীর query নেই।
- Log ভর্তি একটাই error, **সব** route থেকে: `ConnectionAcquireTimeoutError`।

আর support এ একটা ভিন্ন ধরনের ticket: _"Assign করলাম, error দেখাল। আবার করলাম। এখন assignee বলছে সে দুটো email পেয়েছে।"_

Post-mortem এ কেউ একজন বলল: "Email provider ধীর হলো, আর আমাদের পুরো app পড়ে গেল। আমরা তো **শুধু** email পাঠাচ্ছিলাম।"

এই lesson এর প্রশ্ন সেই "শুধু" শব্দটা। Exercise এ সোমবারটা হুবহু বানাব — তারপর একই feature এর আরও তিনটা সংস্করণ, আর দেখব প্রতিটায় ক্ষতিটা কোথায় গিয়ে পড়ে।

---

## ১. Theory

### ১.১ Synchronous মানে "অপেক্ষা করা" — আর অপেক্ষা ফ্রি না

প্রথমে দুটো শব্দ পরিষ্কার করি, কারণ JavaScript এ `async`/`await` লেখা মানুষের কাছে এরা বিভ্রান্তিকর।

**Synchronous processing** — যে কাজ চেয়েছে (caller), সে কাজটা শেষ হওয়ার ফল হাতে পাওয়া পর্যন্ত অপেক্ষা করে, তারপর এগোয়।

**Asynchronous processing** — caller কাজটা কোথাও জমা দেয় আর সাথে সাথে এগিয়ে যায়; কাজটা পরে, অন্য কেউ, অন্য সময় করে।

লক্ষ করো: `await mailer.send(...)` লেখা code টা Node.js এর ভাষায় "async" — event loop আটকায় না, অপেক্ষার মধ্যে অন্য request চলে। কিন্তু **system design এর ভাষায় এটা synchronous**, কারণ HTTP request টা email শেষ হওয়া পর্যন্ত খোলা থাকে, আর user তার উত্তরের জন্য বসে থাকে। এই lesson এ "synchronous" মানে সবসময় দ্বিতীয়টা: **request এর উত্তর কি এই কাজ শেষ হওয়ার জন্য অপেক্ষা করে?**

সোমবারের সবচেয়ে বড় বিভ্রান্তি এখান থেকেই: "event loop তো আটকায়নি, CPU ১২%, তাহলে app মরল কেন?" কারণ অপেক্ষা CPU খায় না, কিন্তু **অন্য জিনিস ধরে রাখে**। একটা request যতক্ষণ খোলা, ততক্ষণ সে দখল করে রাখে:

```
  একটা খোলা request যা যা ধরে রাখে
  ──────────────────────────────────
  • client এর সাথে TCP connection (আর Nginx এর দুই দিকের দুটো connection — 3.3)
  • memory: request, response, closure, buffer
  • database connection — যদি অপেক্ষাটা transaction এর ভেতরে হয়   ← সোমবার
  • row lock — `SELECT … FOR UPDATE` এর lock transaction শেষ হওয়া পর্যন্ত
  • user এর ধৈর্য — ৫–১০ সেকেন্ড পরে সে হাল ছাড়বে, বা refresh চাপবে
```

এর মধ্যে সবচেয়ে সীমিত জিনিসটা database connection — pool এ হাতে গোনা কয়েকটা (Lesson 5.6)। আর সেটাই সোমবার ফুরিয়েছে।

### ১.২ Critical Path — প্রতিটা ধাপ latency যোগ করে, availability গুণ করে

**Critical path** — একটা request এর উত্তর দেওয়ার আগে যে যে ধাপ **অবশ্যই** শেষ হতে হয়, তাদের ক্রম। উত্তরের latency এই পথের ধাপগুলোর যোগফল, আর উত্তর সফল হওয়ার সম্ভাবনা তাদের সবার সফল হওয়ার সম্ভাবনার গুণফল।

Assign route এর critical path:

```
  client ──► Nginx ──► Express ──► Postgres (lock + update + insert) ──► Email API ──► COMMIT ──► উত্তর
              ~1 ms      ~1 ms              ~5 ms                        150 ms         ~1 ms
                                                                         ▲
                                                             পুরো পথের ৯০%+ সময় এখানে
```

**Latency যোগ হয়।** Email provider স্বাভাবিক দিনে পথের সবচেয়ে ধীর ধাপ — assign এর ~১৬৫ ms এর মধ্যে ১৫০ ms। আর সোমবার সেটা ৪০০০ ms। যে ধাপ তোমার নিয়ন্ত্রণে নেই, সেটাই তোমার p99 ঠিক করে দিচ্ছে।

**Availability গুণ হয়।** আজকের spaced repetition প্রশ্নের উত্তর দিয়ে শুরু করি: 99.9% SLO মানে ৩০ দিনে ৪৩.২ মিনিট error budget। এবার ধরো (উদাহরণের সংখ্যা, কোনো নির্দিষ্ট vendor এর না) Postgres cluster 99.95% available, আর email provider 99.9%। দুটোই একই request এর পথে, synchronous — তাহলে assign সফল হবে শুধু যখন **দুটোই** একসাথে ঠিক আছে:

```
  0.9995 × 0.999 = 0.9985   →   99.85%   →   মাসে ~৬৫ মিনিট ব্যর্থ

  তোমার পুরো budget ৪৩.২ মিনিট। Email provider একাই গড়ে ৪৩ মিনিট খেয়ে নিতে পারে —
  তোমার নিজের code এর একটাও bug ছাড়াই।
```

পথে আরেকটা dependency যোগ করো (ধরো Slack webhook, 99.9%) — 99.75%, মাসে ~১০৮ মিনিট। প্রতিটা synchronous dependency তোমার availability কে তার নিজের availability দিয়ে গুণ করে, আর ১ এর চেয়ে ছোট সংখ্যা দিয়ে গুণ করলে কেবল কমে।

এর একটা নাম আছে:

**Temporal coupling** — দুটো অংশ এমনভাবে জোড়া যে একটার কাজ সফল হতে হলে অন্যটাকে **ঠিক একই সময়ে** জীবিত আর দ্রুত থাকতে হয়।

Assign route আর email provider temporally coupled: provider এর খারাপ ৫ মিনিট মানে TaskFlow এর assign এর খারাপ ৫ মিনিট। কিন্তু প্রশ্নটা করো — **assign করার মুহূর্তে email টা কি সত্যিই ঠিক তখনই যেতে হবে?** Assignee যদি ৩০ সেকেন্ড পরে email পায়, কেউ কি টের পাবে? না। তাহলে এই coupling টা প্রয়োজন থেকে আসেনি, code লেখার ধরন থেকে এসেছে।

### ১.৩ Cascading Failure — ধীর dependency কীভাবে অন্য route কে মারে

এবার সোমবারের আসল রহস্য: task list এর route email ছোঁয়ই না, তবু মরল কেন?

উত্তর Lesson 5.6 এর Little's Law এ — **গড়ে একসাথে চলা কাজ = প্রতি সেকেন্ডে আসা কাজ × প্রতিটা কাজের সময়।** এখানে "কাজ" মানে pool এর একটা connection ধরে থাকা assign request। Exercise এর load: প্রতি সেকেন্ডে ২০টা assign, pool এ ১০টা connection।

```
  স্বাভাবিক দিন:  20 assign/s × 0.17 s  =  ~3.4 টা connection সবসময় ব্যস্ত   (১০ এর মধ্যে — আরামে)
  সোমবার:        20 assign/s × 4.0 s   =   80 টা connection দরকার            (আছে ১০টা)
```

৮০ দরকার, আছে ১০। বাকি ৭০টা assign request লাইনে দাঁড়ায়। আর লাইনটা শুধু assign এর না — **pool একটাই**, তাই task list এর প্রতিটা request (যার দরকার মাত্র ৫ ms এর জন্য একটা connection) সেই একই লাইনে, assign গুলোর পেছনে দাঁড়ায়। Pool থেকে এখন প্রতি সেকেন্ডে বেরোচ্ছে মাত্র ১০ ÷ ৪ = ২.৫টা assign; আর ঢুকছে ২০টা assign + ৫০টা list। লাইন প্রতি সেকেন্ডে লম্বা হচ্ছে। ৩ সেকেন্ড লাইনে থাকার পরে (`acquire` সীমা) request error দিয়ে ফেরে — assign হোক বা list।

```
                      ┌──────────── connection pool (max 10) ────────────┐
   assign ──┐         │  [assign ⏳4s] [assign ⏳4s] [assign ⏳4s] …       │──► email API (ধীর)
   assign ──┤         │  ১০টাই assign এর হাতে, সবাই email এর অপেক্ষায়   │
   list   ──┼──► লাইন │                                                  │
   login  ──┤   (২০০+)└──────────────────────────────────────────────────┘
   list   ──┘     │
                  └──► ৩ s পরে: ConnectionAcquireTimeoutError — সব route এ
```

এটাই সোমবারের log: সব route থেকে একই error, অথচ CPU অলস। কেউ কাজ করছে না — সবাই অপেক্ষা করছে, আর অপেক্ষার জায়গা ফুরিয়ে গেছে।

**Cascading failure** — একটা অংশের সমস্যা (এখানে ধীর email provider) ভাগ করা কোনো resource এর মাধ্যমে এমন অংশে ছড়িয়ে পড়ে যাদের ওই অংশের সাথে সরাসরি কোনো সম্পর্ক নেই।

Exercise এর `npm run compare` এ `sync-in-tx` mode — ঠিক উপরের code:

```
── mode: sync-in-tx ────────────────────────────────────────
   phase            assign p50 / p99    assign ব্যর্থ    list p99    list ব্যর্থ
   স্বাভাবিক         168 ms / 195 ms           0%       27 ms          0%
   provider ধীর       3.0 s / 5.0 s           57%       3.0 s         52%
   সেরে ওঠার পর      168 ms / 1.4 s            0%       1.2 s          0%

   assign: সফল 386, ব্যর্থ 91  (pool ফুরিয়েছে 81, client timeout 10, অন্য 0)
   list:   ব্যর্থ 207 / 1188   ← এই route email ছোঁয়ই না
   pool এ সর্বোচ্চ লাইন: 209
   "ব্যর্থ" বলা হলো, অথচ email গেছে: 10
```

তিনটা জিনিস দেখো:

1. **List এর অর্ধেক request ব্যর্থ** — ২০৭টা — অথচ list এর code এ email এর নামও নেই। List এর p99 ২৭ ms থেকে ৩ সেকেন্ড, মানে ঠিক `acquire` এর সীমা: সে কাজ করে ধীর হয়নি, লাইনে দাঁড়িয়ে ধীর হয়েছে।
2. **সেরে ওঠার পরেও দাগ থাকে** — provider ঠিক হওয়ার পরের phase এও list এর p99 ১.২ সেকেন্ড। লাইনে জমে থাকা request গুলো আগে বের হতে হয়। Cascading failure এর একটা স্বভাব: কারণ চলে গেলেও ফল কিছুক্ষণ থাকে।
3. **"ব্যর্থ বলা হলো, অথচ email গেছে: 10"** — সোমবারের সেই ticket। Client ৫ সেকেন্ডে হাল ছেড়েছে, কিন্তু server জানে না যে client চলে গেছে; সে connection ধরে রেখে email পাঠিয়েছে, তারপর commit করেছে। User দেখল error, আবার চাপল — দুটো email। Lesson 6.1 এর কথাটাই: **timeout মানে "ব্যর্থ" না, timeout মানে "জানি না"।**

**"Pool বড় করে দাও না?"** — Exercise এর experiment ৪: `POOL_MAX=100` এ list বাঁচে। কিন্তু Lesson 5.6 এর হিসাব মনে করো: ৬টা instance × ১০০ = ৬০০ connection, Postgres এর `max_connections` ১০০। আর প্রতিটা connection এখন ৪ সেকেন্ড ধরে একটা **খোলা transaction** — `FOR UPDATE` এর row lock সহ। সেই task এ অন্য কেউ হাত দিতে চাইলে সেও ৪ সেকেন্ড আটকে থাকে। Pool বড় করা সমস্যাকে pool থেকে database এ ঠেলে দেয়; আর provider ৪ এর বদলে ৪০ সেকেন্ড ধীর হলে ১০০ ও ফুরোবে। Little's Law এ "সময়" টা অসীম হতে পারলে কোনো সীমিত pool যথেষ্ট না।

(একটা পার্শ্ব নোট: Node.js এ "অপেক্ষা" ছাড়া আরেক ধরনের ধীর কাজ আছে — **CPU এর কাজ**: বড় PDF বানানো, ছবি resize, বিশাল `JSON.parse`। এগুলো অপেক্ষা করে না, event loop আটকে দেয় — আর তখন সত্যিই process এর সব request থামে, Lesson 6.1 এর process pause এর মতো। সমাধানের দিক একই: কাজটা request এর পথ থেকে সরাও, আলাদা worker process এ।)

### ১.৪ প্রথম তিনটা চেষ্টা — আর প্রতিটা কোথায় আটকায়

Post-mortem এ তিনটা প্রস্তাব এলো। প্রতিটা আংশিক সঠিক — আর exercise এ প্রতিটা মাপা হয়েছে।

**চেষ্টা ১ — Email এ timeout বসাও।** `fetch` এ ১ সেকেন্ডের timeout দিলে connection সর্বোচ্চ ১ সেকেন্ড আটকায়, cascading কমে। কিন্তু তাহলে provider ধীর হলে **assign ব্যর্থ** — user একটা task assign করতে পারল না কারণ অন্য কোম্পানির email server ধীর। আর timeout এর পরে email গেছে কিনা, সেটা আবার "জানি না"। Exercise এর experiment ৫ এ ঠিক এটা বসানো হয়েছে (১ সেকেন্ড): list এর ব্যর্থতা ৫২% থেকে ১৮% এ নামে — কমে, শূন্য হয় না, কারণ Little's Law এ এখনো ২০/s × ১ s = ২০টা connection দরকার, আছে ১০টা। আর ৮০ জন user assign এ error দেখল অথচ তাদের email ঠিকই পৌঁছাল — আমাদের timeout আমাদের অপেক্ষা থামায়, provider এর কাজ থামায় না। Timeout দরকার (বাইরের কোনো call এ timeout ছাড়া থাকা উচিত না — আর `fetch`, axios, বেশিরভাগ SDK এর default এ কোনো timeout **নেই**) — কিন্তু এটা ক্ষতি ছোট করে, দূর করে না।

**চেষ্টা ২ — আগে commit, তারপর email।** এটা একটা সত্যিকারের উন্নতি, আর "email transaction এর ভেতরে" এর আসল ভুলটা এখানে দেখা যায়। ভেতরে রাখার যুক্তি ছিল "atomic"। কিন্তু ভাবো: email **চলে গেল**, তারপর `COMMIT` ব্যর্থ হলো (deadlock, failover, যেকোনো কিছু)। Transaction rollback হলো — assign হয়নি — কিন্তু email তো আর ফেরানো যায় না। Database এর transaction শুধু database এর জিনিস ফেরাতে পারে; বাইরের পৃথিবীতে পাঠানো কিছু না। তাই "atomic" টা আসলে কখনো ছিল না, শুধু connection টা বেশিক্ষণ আটকে রাখা হচ্ছিল।

Commit এর পরে email পাঠালে connection ৫ ms এ ফেরত যায় — `sync-after-commit`:

```
── mode: sync-after-commit ─────────────────────────────────
   phase            assign p50 / p99    assign ব্যর্থ    list p99    list ব্যর্থ
   স্বাভাবিক         168 ms / 186 ms           0%       26 ms          0%
   provider ধীর       4.0 s / 4.0 s           37%       27 ms          0%
   সেরে ওঠার পর      166 ms / 185 ms           1%       27 ms          0%

   assign: সফল 417, ব্যর্থ 61  (pool ফুরিয়েছে 0, client timeout 0, অন্য 61)
   list:   ব্যর্থ 0 / 1187
   provider 429 (rate limited) ফেরত দিয়েছে: 61
```

List **পুরোপুরি বাঁচল** — ০ ব্যর্থ, p99 ২৭ ms। Cascading failure শেষ, কারণ ধীর dependency আর ভাগ করা resource ধরে রাখে না। কিন্তু assign এর নিজের অবস্থা দেখো: ধীর phase এ প্রতিটা assign ৪ সেকেন্ড, আর ৩৭% ব্যর্থ। ব্যর্থ কেন? প্রতি সেকেন্ডে ২০টা assign × ৪ সেকেন্ড = ৮০টা email একসাথে provider এ — আর provider একসাথে ৫০টার বেশি নেয় না (বাস্তবের provider এর rate limit এর মতো; exercise এ এই সীমা একটা ধরে নেওয়া সংখ্যা)। বাড়তিগুলো `429` পায়।

আর সবচেয়ে খারাপ অংশ: ওই ৬১টা "ব্যর্থ" assign আসলে **হয়ে গেছে** — commit আগেই হয়েছে। User error দেখল, কিন্তু task এখন assigned। Temporal coupling এখনো আছে, শুধু database থেকে সরে user এর অভিজ্ঞতায়। (Experiment ৩: provider ৬ সেকেন্ড ধীর হলে — client এর ৫ সেকেন্ডের timeout এর চেয়ে বেশি — ধীর phase এ assign **১০০%** ব্যর্থ দেখায়, অথচ ১৫৯ জনের email ঠিকই গেছে।)

**চেষ্টা ৩ — অপেক্ষাই কোরো না: fire-and-forget।**

**Fire-and-forget** — একটা কাজ শুরু করে তার ফলের জন্য কেউ অপেক্ষা করে না, আর কাজটা ব্যর্থ হলে কেউ জানেও না।

```typescript
await task.update({ assigneeId });            // commit
void mailer.send({ to: assignee.email, … });  // শুরু করলাম — ফল দেখব না
res.json({ taskId: task.id, assigneeId });    // সাথে সাথে উত্তর
```

`fire-and-forget`:

```
── mode: fire-and-forget ───────────────────────────────────
   phase            assign p50 / p99    assign ব্যর্থ    list p99    list ব্যর্থ
   স্বাভাবিক          10 ms / 27 ms            0%       26 ms          0%
   provider ধীর       10 ms / 27 ms            0%       27 ms          0%
   সেরে ওঠার পর       10 ms / 26 ms            0%       27 ms          0%

   provider এ একসাথে সর্বোচ্চ: 50
   provider 429 (rate limited) ফেরত দিয়েছে: 60
   "সফল" বলা হলো, email যায়নি: 60
```

দেখতে নিখুঁত: assign সবসময় ১০ ms, কেউ কোনো error দেখেনি। কিন্তু শেষ লাইনটা পড়ো — **৬০ জন user কে "সফল" বলা হয়েছে, আর তাদের assignee কখনো email পায়নি।** আর কেউ জানে না। কোনো error page নেই, কোনো alert নেই, শুধু একটা `.catch(() => {})` যেটা নীরবে গিলে ফেলেছে।

সমস্যা দুটো, আর দুটোই কাঠামোগত:

- **কোনো সীমা নেই।** প্রতিটা request একটা নতুন email শুরু করে, যত দ্রুত request আসে তত দ্রুত। Provider ধীর হলে একসাথে চলা email এর সংখ্যা Little's Law মেনে বাড়তেই থাকে (২০ × ৪ = ৮০) — আর ৫০ এ provider এর দেয়ালে ধাক্কা খায়। Provider না থামালে তোমার process এর memory থামাত।
- **কোনো স্মৃতি নেই।** যে email ব্যর্থ হলো, সেটা আবার চেষ্টা করার জন্য কোথাও লেখা নেই। Process মরলে (deploy, crash) যা শুরু হয়নি সেটা মিলিয়ে যায়।

Fire-and-forget একটা ঠিক জিনিস করেছে: user কে অপেক্ষা থেকে মুক্তি দিয়েছে। কিন্তু সে কাজটার **দায়িত্ব** কাউকে দেয়নি।

### ১.৫ Job Queue — কাজটা লিখে রাখো, পরে কেউ করবে

চতুর্থ সংস্করণ fire-and-forget এর ঠিক দুটো সমস্যার উত্তর: সীমা আর স্মৃতি।

**Job queue** — একটা তালিকা যেখানে "যে কাজ করতে হবে" লিখে রাখা হয়। যে লেখে তাকে বলে **producer** (এখানে API), আর যে তালিকা থেকে নিয়ে কাজটা আসলে করে তাকে বলে **worker** (বা consumer)। Producer আর worker আলাদা গতিতে চলে।

```
                   request এর পথ (critical path)                    │   request এর পথের বাইরে
                                                                     │
  client ──► Express ──► Postgres (update + commit) ──► queue.add() ──► উত্তর (10 ms)
                                                          │          │
                                                          ▼          │
                                               ┌─────────────────┐   │
                                               │ job │ job │ job │ … │  ← backlog
                                               └────────┬────────┘   │
                                                        ▼            │
                                           worker × 8 (একসাথে সর্বোচ্চ ৮টা) ──► email API
```

Assign route এখন একটা "কাজের ইচ্ছা" লিখে দিয়েই উত্তর দেয়। Email পাঠানো worker এর দায়িত্ব, আর worker একসাথে **নির্দিষ্ট সংখ্যক** কাজ করে — এখানে ৮টা, provider যত ধীরই হোক। `queue`:

```
── mode: queue ─────────────────────────────────────────────
   phase            assign p50 / p99    assign ব্যর্থ    list p99    list ব্যর্থ
   স্বাভাবিক          11 ms / 27 ms            0%       27 ms          0%
   provider ধীর       10 ms / 26 ms            0%       27 ms          0%
   সেরে ওঠার পর        9 ms / 26 ms            0%       27 ms          0%

   email বাকি (সর্বোচ্চ): 152   provider এ একসাথে সর্বোচ্চ: 8
   provider 429 (rate limited) ফেরত দিয়েছে: 0   email পৌঁছাতে (assign থেকে) p99: 7.6 s
   "সফল" বলা হলো, email যায়নি: 0
```

Assign ১০ ms, list অক্ষত, provider কখনো ৮টার বেশি একসাথে দেখেনি, তাই একটাও `429` নেই, আর **একটাও email হারায়নি**। তাহলে ক্ষতিটা গেল কোথায়? কারণ provider তো সত্যিই ৪ সেকেন্ড ধীর ছিল — সেই সময়টা কোথাও না কোথাও দিতে হবে।

উত্তর: দুটো সংখ্যায় — `email বাকি (সর্বোচ্চ): 152` আর `email p99: 7.6 s`।

**Backlog** — queue তে জমে থাকা, এখনো শুরু না হওয়া কাজের পরিমাণ। Worker যত দ্রুত কাজ শেষ করে, তার চেয়ে দ্রুত কাজ এলে backlog বাড়ে; উল্টোটা হলে কমে।

হাতে হিসাব করো, Little's Law উল্টো করে — worker রা প্রতি সেকেন্ডে কতগুলো শেষ করতে পারে:

```
  ধীর phase:   8 worker ÷ 4 s     =   2 email/s বের হয়,  20 আসে  →  backlog +18/s × 8 s  ≈  144
  সেরে উঠলে:   8 worker ÷ 0.15 s  ≈  53 email/s বের হয়,  20 আসে  →  backlog −33/s  →  ~৫ সেকেন্ডে খালি
```

মাপা ১৫২ হিসাবের ১৪৪ এর কাছে (বাকিটা phase এর কিনারার সময়)। ক্ষতিটা হারায়নি — **user এর latency থেকে সরে backlog আর দেরিতে গেছে**। ধীর phase এর শেষে assign করা কারো assignee email পেয়েছে ~৭ সেকেন্ড পরে, ১৫০ ms এর বদলে। আর এটাই পুরো lesson এর মূল বিনিময়: **user কে অপেক্ষা করানোর বদলে কাজকে অপেক্ষা করাও।** Email এর জন্য এটা স্পষ্টতই ভালো বিনিময় — ৭ সেকেন্ড দেরির email কেউ টেরও পায় না, কিন্তু ৪ সেকেন্ডের assign button সবাই টের পায়।

Queue দুটো জিনিস আলাদা করে দিল যেগুলো synchronous code এ এক ছিল:

- **কাজ নেওয়ার গতি** (API, request এর গতিতে) আর **কাজ করার গতি** (worker, downstream এর গতিতে)। মাঝখানে queue একটা বাফার — load এর ঢেউ শোষণ করে।
- **User এর কাছে সাফল্য** ("assign হয়েছে") আর **কাজের সাফল্য** ("email পৌঁছেছে")। প্রথমটা এখনই, দ্বিতীয়টা "পরে, কিন্তু নিশ্চিতভাবে"।

**কিন্তু "queue" জাদু না — দুটো সতর্কতা, দুটোই exercise এ মাপা।**

**প্রথম: queue capacity বানায় না।** Experiment ১: `WORKERS=2`। এখন স্বাভাবিক দিনেও ২ ÷ ০.১৫ ≈ ১৩ email/s বের হয়, আর আসে ২০। Backlog **প্রথম সেকেন্ড থেকেই** বাড়তে থাকে — ধীর phase ছাড়াও। মাপা: backlog ২৬৫, email p99 ~২০ সেকেন্ড, আর load চলতে থাকলে সীমাহীন। Queue শুধু সময়ের ব্যবধান মেটায় (এখন বেশি, পরে কম); গড়ে worker এর গতি আসার গতির চেয়ে কম হলে queue একটা ধীর মৃত্যু, শুধু user এর চোখের আড়ালে। তাই production এ queue এর সবচেয়ে গুরুত্বপূর্ণ metric: **backlog এর আকার, আর সবচেয়ে পুরনো job এর বয়স।** (সীমাহীন backlog আটকানোর কৌশল — backpressure — Lesson 7.4 এ।)

**দ্বিতীয়: এই queue টা memory তে।** Experiment ২: `CRASH_AT_MS=14000` — ধীর phase এর মাঝখানে API process কে `SIGKILL` করা হয় (যেকোনো deploy বা crash এর মতো), আর নতুন process চালু হয়:

```
    14.0 s  API process SIGKILL — deploy/crash; নতুন process চালু হচ্ছে
   …
   "সফল" বলা হলো, email যায়নি: 103
```

১০৩ জন user "সফল" দেখেছিল; তাদের job গুলো process এর memory তে লাইনে ছিল; process এর সাথে মিলিয়ে গেল। Fire-and-forget এর "স্মৃতি নেই" সমস্যা, শুধু বড় আকারে — কারণ queue এখন ইচ্ছা করে কাজ জমিয়ে রাখে। Lesson 3.4 এর graceful shutdown কিছুটা বাঁচাত (বন্ধ হওয়ার আগে queue খালি করা) — কিন্তু crash এ, OOM kill এ, machine মরলে না।

সমাধান: queue টা process এর **বাইরে**, এমন জায়গায় রাখা যেটা টেকসই — Redis, RabbitMQ, Kafka, বা database এর একটা table। তখন API process মরলেও job থাকে, আর যেকোনো worker (যেকোনো machine এ) সেটা তুলে নেয়। Node এর জগতে এর সবচেয়ে পরিচিত রূপ BullMQ (Redis এর উপর) — Lesson 7.3 এর পুরোটা। কোন ধরনের queue কোন কাজে, সেটা Lesson 7.2।

### ১.৬ কোন কাজ request এর পথে থাকবে, আর কোনটা বাইরে যাবে

সব কাজ async করা যায় না, করা উচিতও না। একটা কাজ request এর পথে রাখার **একমাত্র ভালো কারণ**: user এর পরের পদক্ষেপ এই কাজের ফলের উপর নির্ভর করে। প্রতিটা কাজের জন্য চারটা প্রশ্ন:

1. **User কি উত্তরে এই কাজের ফল দেখতে চায়?** Task তৈরি হলো কিনা, তার id কী — হ্যাঁ। Email গেল কিনা — না, সে জানেও না কখন যায়।
2. **কাজটা ব্যর্থ হলে user কে কি এখনই জানাতে হবে, যাতে সে কিছু বদলাতে পারে?** Validation error, permission নেই, card declined — হ্যাঁ। Search index update ব্যর্থ — না, আমরা নিজেরা আবার চেষ্টা করব।
3. **কাজটা কতক্ষণ নেয়, আর কতটা অনিশ্চিত?** ৫ ms এর indexed query — পথে থাকলে ক্ষতি নেই। ৩০ সেকেন্ডের export, বা বাইরের API যার latency তোমার নিয়ন্ত্রণে নেই — পথ থেকে সরাও।
4. **কাজটা কি বাইরের কারো উপর নির্ভর করে?** প্রতিটা বাইরের dependency ১.২ এর গুণফলে একটা নতুন সংখ্যা। পথে রাখলে তার খারাপ দিন তোমার খারাপ দিন।

TaskFlow এ প্রয়োগ করলে:

| কাজ                                      | পথে / বাইরে | কেন                                                                                           |
| ---------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| Task তৈরি/assign এর database write       | পথে         | User এর ফল এটাই; ব্যর্থ হলে তাকে জানাতে হবে                                                   |
| Permission check, input validation       | পথে         | ব্যর্থ হলে user কিছু বদলাবে; আর দ্রুত, নিজস্ব                                                 |
| Assign এর email, push notification       | বাইরে       | User দেখে না কখন যায়; বাইরের provider                                                        |
| Slack/webhook integration                | বাইরে       | অন্য কোম্পানির server — তার latency আর availability তোমার গুণফলে ঢুকতে দিও না                 |
| Search index update (8.3), activity feed | বাইরে       | কয়েক সেকেন্ড পরে দেখা গেলে চলে — তবে user নিজের লেখা খুঁজে না পেলে বিভ্রান্ত হয় (নিচে দেখো) |
| ৫০ হাজার task এর CSV export              | বাইরে       | ৩০+ সেকেন্ড — HTTP request এ রাখলে Nginx/browser এর timeout; job + "তৈরি হলে link পাঠাব"      |
| Attachment এর thumbnail বানানো           | বাইরে       | CPU এর কাজ — Node এর event loop আটকায় (১.৩ এর নোট); আলাদা worker process                     |
| Pro plan এ upgrade এর card charge        | পথে\*       | User কে এখনই জানাতে হবে card কাজ করল কিনা — কিন্তু timeout আর idempotency key সহ (2.5, 6.1)   |

\*Payment একটা ভালো উদাহরণ যে উত্তরটা সবসময় পরিষ্কার না। Charge টা পথে থাকে কারণ user এর ফল দরকার; কিন্তু তার আশেপাশের সবকিছু — receipt email, invoice PDF, accounting system এ entry, provider এর পরের webhook — বাইরে। একটা feature প্রায় কখনো পুরোটা sync বা পুরোটা async হয় না; প্রতিটা **ধাপ** আলাদা করে প্রশ্ন করো।

**Async এর দাম — যেটা interview এ সবাই ভুলে যায়।** কাজ পথ থেকে সরালে কিছু জিনিস বিনামূল্যে পাও না:

- **"হয়েছে" মানে এখন "হবে"।** Search index async হলে user task তৈরি করে সাথে সাথে খুঁজলে না-ও পেতে পারে। এটা Module 6 এর eventual consistency, নতুন জায়গায় — আর 6.3 এর read-your-writes এর প্রশ্ন আবার আসে। UI তে সমাধান প্রায়ই সহজ: নিজের তৈরি জিনিস client এ সাথে সাথে দেখানো, বা "processing…" অবস্থা।
- **ফলের খবর কীভাবে দেবে?** লম্বা কাজের (export) জন্য সাধারণ ধরন: request এর উত্তরে `202 Accepted` আর একটা job id; client সেই id দিয়ে status জিজ্ঞেস করে (polling), বা server খবর পাঠায় — Lesson 2.4 এর SSE/WebSocket।
- **Job হারাতে পারে, বা দুবার চলতে পারে।** Worker email পাঠাল, তারপর "শেষ" লেখার আগে মরল — আরেকজন আবার পাঠাবে। টেকসই queue গুলো সাধারণত "অন্তত একবার" দেয়, "ঠিক একবার" না। তাই প্রতিটা job idempotent হতে হবে (Lesson 2.5, 6.1) — বিস্তারিত 7.4।
- **Database আর queue — দুই জায়গায় লেখা।** Assign commit হলো, তারপর queue তে job লেখার আগে process মরল — assign আছে, email এর job নেই। উল্টো ক্রমে: job লেখা হলো, commit ব্যর্থ — email যাবে এমন assign এর জন্য যেটা হয়নি। দুটো আলাদা system এ একসাথে লেখার এই সমস্যার নাম **dual write**, আর এর পরিচিত সমাধান (transactional outbox) Lesson 7.5 এ।
- **Debug কঠিন।** Synchronous code এ একটা error এর stack trace পুরো গল্প বলে। Async এ "email কেন যায়নি" এর উত্তর তিনটা process আর একটা queue জুড়ে ছড়ানো — job id, log, আর Lesson 10.4 এর tracing লাগে।

> **Trade-off Table — Assign এর email পাঠানোর পাঁচটা উপায়**

| উপায়                       | Assign এর latency (provider ধীর হলে) | অন্য route রক্ষা পায়? | Provider এর উপর চাপ সীমিত? | Email হারায় (provider ব্যর্থ হলে)    | Email হারায় (process মরলে) | দাম                                                        |
| --------------------------- | ------------------------------------ | ---------------------- | -------------------------- | ------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| Transaction এর ভেতরে sync   | provider এর সমান, pool এর লাইন সহ    | না — cascading         | হ্যাঁ, কিন্তু pool খরচ করে | না, assign ও ব্যর্থ (বা "জানি না")    | না — request ব্যর্থ দেখায়  | পুরো app এর availability provider এর হাতে                  |
| Commit এর পরে sync          | provider এর সমান                     | হ্যাঁ                  | না                         | না — কিন্তু assign হয়েও error দেখায় | না — request ব্যর্থ দেখায়  | Assign এর UX provider এর হাতে                              |
| Fire-and-forget             | ~১০ ms                               | হ্যাঁ                  | না — সীমাহীন               | **হ্যাঁ, নীরবে**                      | হ্যাঁ, যা শুরু হয়নি        | ব্যর্থতা অদৃশ্য; কোনো retry নেই                            |
| In-memory queue + worker    | ~১০ ms                               | হ্যাঁ                  | হ্যাঁ — worker সংখ্যায়    | না (retry যোগ করলে)                   | **হ্যাঁ, পুরো backlog**     | Backlog দেখতে হয়; deploy এ হারায়                         |
| টেকসই queue (Redis/BullMQ…) | ~১০ ms (+ queue তে লেখা)             | হ্যাঁ                  | হ্যাঁ                      | না — retry, DLQ (7.4)                 | না — job queue তে থাকে      | নতুন infrastructure; at-least-once, dual write, monitoring |

বাস্তবে উত্তর প্রায় সবসময় শেষ সারি — আর বাকি module টা সেই সারির খুঁটিনাটি: কোন queue (7.2), কীভাবে বানাবে (7.3), ব্যর্থতায় কী করবে (7.4), আর queue যখন শুধু "কাজের তালিকা" না থেকে "কী ঘটেছে তার খবর" হয়ে যায় (7.5)।

---

## ২. Interview Angle

**"User sign up করলে একটা welcome email যাবে — design করো।"** — ছোট প্রশ্ন, কিন্তু interviewer দেখতে চায় তুমি নিজে থেকে email কে request এর পথ থেকে সরাও কিনা। ভালো উত্তরের ক্রম: sign-up এর database write sync → email async, queue দিয়ে → কেন (provider এর latency আর availability sign-up এর গুণফলে না ঢোকানো; ১.২ এর হিসাব এক লাইনে) → queue টেকসই কেন (deploy এ হারানো না) → job idempotent কেন (worker retry করলে দুটো welcome email না)। বোনাস: "sign-up commit আর job লেখার মাঝে crash হলে কী হবে?" — dual write এর নাম বলা আর outbox এর কথা তোলা।

**"এই service টা ধীর হয়ে গেছে, আর তার সাথে পুরো system — কেন হতে পারে?"** — Cascading failure এর প্রশ্ন, ছদ্মবেশে। ভালো উত্তর ভাগ করা resource খোঁজে: connection pool, thread pool, worker, memory। তারপর Little's Law দিয়ে একটা সংখ্যা: "প্রতি সেকেন্ডে ২০টা request × ৪ সেকেন্ড = ৮০টা একসাথে; pool ১০।" সমাধান তিন স্তরে: ধীর কাজ পথ থেকে সরাও (async), বাইরের call এ timeout, আর ভাগ করা resource আলাদা করো (ধীর কাজের জন্য আলাদা pool — Lesson 9.4 এর bulkhead)।

**"তাহলে সব কিছু async করে দিই না কেন?"** — Trap প্রশ্ন। উত্তর: কারণ async এর দাম আছে — eventual result, at-least-once তাই idempotency, dual write, debug কঠিন, backlog monitoring। আর queue capacity বানায় না: worker এর গতি গড়ে আসার গতির কম হলে backlog সীমাহীন বাড়ে। একটা কাজ sync থাকবে যদি user এর পরের পদক্ষেপ তার ফলের উপর নির্ভর করে — ১.৬ এর চারটা প্রশ্ন।

**Production এ বাস্তবে:** প্রায় প্রতিটা বড় web app এর পেছনে একটা background job system আছে — Ruby এর জগতে Sidekiq (আর তার আগে GitHub এর বানানো Resque), Python এ Celery, Node এ BullMQ, Java তে বিভিন্ন queue client। আর queue এর **দুটো** metric এ alert থাকে: backlog এর আকার, আর সবচেয়ে পুরনো অপেক্ষমাণ job এর বয়স। দ্বিতীয়টা বেশি কাজের — ১০ হাজার job এর backlog ঠিক থাকতে পারে যদি সবচেয়ে পুরনোটা ২ সেকেন্ডের হয়; ১০টা job এর backlog বিপদ যদি সবচেয়ে পুরনোটা ১ ঘণ্টা ধরে পড়ে থাকে (worker মরেছে)।

---

## ৩. Key Takeaway

- System design এর "synchronous" মানে **request এর উত্তর কাজটা শেষ হওয়ার অপেক্ষা করে** — `await` লেখা Node code ও এই অর্থে synchronous। অপেক্ষা CPU খায় না, কিন্তু connection, lock, memory আর user এর ধৈর্য ধরে রাখে
- **Critical path** এর প্রতিটা ধাপ latency **যোগ** করে আর availability **গুণ** করে কমায় — 99.95% database আর 99.9% provider একসাথে পথে থাকলে 99.85%, মাসে ~৬৫ মিনিট
- **Temporal coupling**: একটার সাফল্যের জন্য অন্যটাকে একই মুহূর্তে জীবিত থাকতে হয়। প্রশ্ন করো — এই কাজ কি **ঠিক এখনই** হতে হবে?
- ধীর dependency (মৃত না, ধীর) ভাগ করা resource দখল করে **cascading failure** ঘটায় — Little's Law: ২০/s × ৪ s = ৮০ connection দরকার, আছে ১০; exercise এ email না ছোঁয়া list route এর অর্ধেক ব্যর্থ
- Timeout ক্ষতি ছোট করে, দূর করে না; commit এর পরে পাঠানো pool বাঁচায় কিন্তু user এখনো অপেক্ষা করে; **fire-and-forget** অপেক্ষা সরায় কিন্তু সীমা আর স্মৃতি সরিয়ে দেয় — নীরবে email হারায়
- **Job queue** কাজ নেওয়া আর কাজ করাকে আলাদা করে: user ১০ ms এ উত্তর পায়, worker নির্দিষ্ট গতিতে কাজ করে, আর ক্ষতি সরে যায় **backlog** আর দেরিতে। কিন্তু queue capacity বানায় না, আর in-memory queue deploy এ পুরো backlog হারায় — টেকসই queue লাগে
- কাজ পথে রাখো শুধু যদি user এর পরের পদক্ষেপ তার ফলের উপর নির্ভর করে; বাইরে নিলে দাম — eventual result, at-least-once তাই idempotency, dual write, কঠিন debug

---

## ৪. নতুন Term (Glossary)

| Term                                      | অর্থ                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Synchronous / Asynchronous Processing** | Sync: caller কাজ শেষ হওয়ার ফল পাওয়া পর্যন্ত অপেক্ষা করে; Async: caller কাজ জমা দিয়ে এগিয়ে যায়, কাজ পরে অন্য কেউ করে |
| **Critical Path**                         | Request এর উত্তরের আগে যে ধাপগুলো অবশ্যই শেষ হতে হয় — latency তাদের যোগফল, availability তাদের গুণফল                     |
| **Temporal Coupling**                     | দুটো অংশের এমন জোড়া যে একটার সফল হতে অন্যটাকে ঠিক একই সময়ে জীবিত আর দ্রুত থাকতে হয়                                    |
| **Cascading Failure**                     | একটা অংশের সমস্যা ভাগ করা resource (pool, thread, memory) এর মাধ্যমে এমন অংশে ছড়ায় যাদের সাথে তার সরাসরি সম্পর্ক নেই   |
| **Fire-and-Forget**                       | কাজ শুরু করে ফলের জন্য কেউ অপেক্ষা করে না — ব্যর্থ হলে কেউ জানে না, আর কাজের কোনো লিখিত স্মৃতি থাকে না                   |
| **Job Queue (Producer / Worker)**         | "যে কাজ করতে হবে" এর তালিকা; producer লেখে, worker তুলে নিয়ে নিজের গতিতে (নির্দিষ্ট সংখ্যায় একসাথে) করে                |
| **Backlog**                               | Queue তে জমে থাকা, এখনো শুরু না হওয়া কাজ — আসার গতি worker এর গতির বেশি হলে বাড়ে, কম হলে কমে                           |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এর "task এ comment" route এ এখন চারটা কাজ হয়, সবগুলো `await` করে, একটার পর একটা: (ক) comment টা Postgres এ লেখা, ~৫ ms; (খ) comment এ `@mention` করা প্রত্যেককে email, provider এ গড়ে ~১৫০ ms প্রতিটা; (গ) task এর Slack channel এ webhook, ~৩০০ ms, availability ধরো 99.5%; (ঘ) search index update, ~৪০ ms। Comment route এর latency আর availability (database 99.95%, email provider 99.9%, search 99.9% ধরে) হিসাব করো — ৩ জনকে mention করা একটা comment এর জন্য। তারপর কোন কাজগুলো পথে রাখবে আর কোনগুলো সরাবে, আর সরানোর পরে latency আর availability কত হয়?
2. একজন engineer বলল: "Queue লাগবে না। `setImmediate(() => sendEmail())` দিয়ে দিলেই request সাথে সাথে ফিরবে, আর Node তো single process — email ঠিকই যাবে।" তার কথার কোন অংশ সঠিক, আর কোন অংশ ভুল? অন্তত তিনটা পরিস্থিতি বলো যেখানে email যাবে না — আর প্রতিটায় কেউ জানবে কিনা।
3. Black Friday তে TaskFlow এর একটা enterprise customer ২ লাখ task একসাথে import করল; প্রতিটা task এর জন্য একটা "assigned" email এর job queue তে গেল। Worker ৮টা, প্রতিটা email ~১৫০ ms। (ক) শেষ email টা কতক্ষণ পরে যাবে? (খ) এর মধ্যে অন্য সব customer এর assign email এর কী হবে — কেন? (গ) কী বদলাবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** এখন সবকিছু পরপর, তাই latency যোগ: ৫ + (৩ × ১৫০) + ৩০০ + ৪০ = **~৭৯৫ ms** — আর এটা স্বাভাবিক দিনের গড়; p99 আরও খারাপ, কারণ চারটা ধাপের যেকোনো একটার খারাপ মুহূর্ত পুরো request এর খারাপ মুহূর্ত। Availability গুণ (email এর তিনটা call একই provider এ, তাই provider কে একবার ধরা যুক্তিসঙ্গত — যদিও প্রতিটা call আলাদা করে ব্যর্থ হতে পারে, তাতে সংখ্যা আরও কমে): 0.9995 × 0.999 × 0.995 × 0.999 ≈ **0.9925 → 99.25%** — মাসে প্রায় সাড়ে ৫ ঘণ্টা ব্যর্থ, যেখানে database একা থাকলে ~২২ মিনিট। Slack একাই সবচেয়ে বড় অংশ খাচ্ছে — অন্য কোম্পানির একটা webhook।

পথে থাকবে শুধু (ক) — comment টা লেখা হলো কিনা, user এর ফল এটাই। (খ), (গ), (ঘ) তিনটাই বাইরে, queue তে তিনটা আলাদা job (বা একটা "comment তৈরি হলো" job যেটা তিনটা কাজ ছড়িয়ে দেয় — 7.5 এর event এর ধারণা)। সরানোর পরে: latency ~৫ ms + queue তে লেখা (টেকসই queue তে একটা network round trip, ধরো ~১–২ ms) ≈ **~৭ ms**; availability ≈ database × queue এর availability — বাইরের তিনটা dependency আর গুণফলে নেই। দাম: search index এ নিজের comment কয়েক সেকেন্ড পরে দেখা যাবে — আর "comment লেখা হলো, job লেখা হলো না" এর dual write প্রশ্ন।

**প্রশ্ন ২:** সঠিক অংশ: request সাথে সাথে ফিরবে, আর event loop আটকাবে না — user এর latency ঠিক হয়ে যাবে। ভুল অংশ: "email ঠিকই যাবে"। এটা আসলে fire-and-forget, আর যেখানে email যাবে না:

- **Deploy বা crash:** নতুন version deploy হলো, পুরনো process বন্ধ — `setImmediate` এ বসে থাকা বা শুরু হয়ে উত্তরের অপেক্ষায় থাকা email গুলো শেষ। OOM kill বা machine মরলে graceful shutdown ও নেই। কেউ জানবে না।
- **Provider ব্যর্থ বা rate limit:** email ৫০০ বা `429` পেল — কোনো retry নেই, কারণ কাজটা কোথাও লেখা নেই। Exercise এ ঠিক ৬০টা। `.catch` এ log থাকলে হয়তো কেউ পরে log এ দেখবে; user বা assignee জানবে না।
- **Provider ধীর আর load বেশি:** একসাথে চলা email সীমাহীন বাড়ে (Little's Law), process এর memory আর outbound connection বাড়ে, provider এর সীমায় ধাক্কা খায় — আর বাড়তি email গুলো ব্যর্থ (উপরের কারণে নীরবে)।
- বোনাস: "Node single process" কথাটাই ভুল ধারণা — TaskFlow এ ৬টা instance, আর প্রতিটা আলাদাভাবে মরতে পারে।

মূল কথা: `setImmediate` **কখন** কাজ হবে সেটা বদলায়, কিন্তু কাজটার **দায়িত্ব** (লিখে রাখা, ব্যর্থ হলে আবার চেষ্টা, কতটা একসাথে) কাউকে দেয় না।

**প্রশ্ন ৩:** (ক) ৮ worker ÷ ০.১৫ s ≈ ৫৩ email/s। ২,০০,০০০ ÷ ৫৩ ≈ ৩,৭৫০ সেকেন্ড ≈ **~১ ঘণ্টা ২ মিনিট** — ধরে নিয়ে যে provider এই গতি নেবে (আসলে সম্ভবত rate limit এ আরও ধীর)। (খ) Queue একটা, FIFO — তাই import এর পরে অন্য যেকোনো customer এর assign email ২ লাখ job এর **পেছনে**। একজন customer এর বিশাল কাজ সবার email এক ঘণ্টা দেরি করাল। এটা আবার cascading failure এর আকৃতি — এবার ভাগ করা resource টা queue আর worker। (গ) কয়েকটা উপায়, একসাথে:

- **আলাদা queue বা priority:** মানুষের হাতে করা assign এর email একটা high-priority queue তে, bulk import এর email আলাদা low-priority queue তে, আলাদা worker সহ — একটা আরেকটাকে আটকায় না (9.4 এর bulkhead এর ধারণা)।
- **Customer প্রতি সীমা (fairness):** একজন customer এর job একসাথে সর্বোচ্চ কয়টা চলবে তার সীমা, যাতে সবাই পালা পায়।
- **কাজটাই বদলানো:** ২ লাখ আলাদা email কেউ চায় না। Bulk import এ প্রতি assignee কে একটা summary email ("তোমাকে ৪৩০টা task assign হয়েছে") — ২ লাখ job এর বদলে কয়েকশো।
- **Monitoring:** সবচেয়ে পুরনো job এর বয়সে alert — ১ ঘণ্টা না, কয়েক মিনিটে টের পাওয়া।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (তিনটা আসল Node process)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-7.1-async-thinking/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.1-async-thinking) — `npm install`, তারপর `npm run compare` (চারটা mode পরপর, ~১ মিনিট ৪০ সেকেন্ড) বা `npm run scenario -- <mode>`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`provider` একটা নকল email provider (latency বদলানো যায়; একসাথে ৫০টার বেশি এলে `429`), `api` হলো TaskFlow এর Express API — assign route এর চারটা সংস্করণ, আর একটা list route যেটা email ছোঁয় না — আর `scenario` load দেয়, মাঝপথে provider কে ধীর করে, তারপর phase অনুযায়ী মাপে। Connection pool টা Sequelize এর pool এর একটা ছোট নকল (max, লাইন, `acquire` সীমা) — database আসল না, কারণ আজকের প্রশ্ন pool **কে ধরে রাখে** তার, query এর না।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `npm run compare` দুবার চালিয়ে একই আকৃতি (সংখ্যা সামান্য আলাদা — আসল process, আসল timer; যেমন `sync-in-tx` এর list ব্যর্থ একবার ২১৫, একবার ২০৭)। README এর পাঁচটা experiment ই চালিয়ে দেখা হয়েছে (৫ নম্বরটা `api.ts` বদলে, তারপর ফিরিয়ে), সংখ্যাগুলো README তে আছে। Provider এর "একসাথে ৫০টা" সীমা একটা ধরে নেওয়া সংখ্যা — আসল provider এর সীমা account আর plan ভেদে আলাদা, আর সাধারণত "প্রতি সেকেন্ডে কয়টা" হিসেবে।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান, তারপর চালাও:** `npm run compare` চালানোর **আগে** তুলনার table এর চারটা সারির প্রতিটা ঘর অনুমান করে লিখে ফেলো (কোনটা শূন্য, কোনটা বড়)। তারপর চালিয়ে মেলাও। কোন ঘরটা তোমাকে সবচেয়ে অবাক করল, আর কেন?

2. **Little's Law দিয়ে ব্যাখ্যা:** `sync-in-tx` এর ধীর phase এ list এর p99 প্রায় ঠিক ৩.০ সেকেন্ড কেন — ২.৫ বা ৪ না? আর `queue` mode এ `email বাকি (সর্বোচ্চ)` এর সংখ্যা হাতে হিসাব করো (১.৫ এর মতো), তারপর `WORKERS=2` দিয়ে (experiment ১) আবার — backlog কেন **স্বাভাবিক phase এও** বাড়ছে?

3. **Timeout বসাও** (experiment ৫): `api.ts` এর `sendEmail` এ `signal: AbortSignal.timeout(1000)` যোগ করো, তারপর `npm run scenario -- sync-in-tx`। List বাঁচল? Assign এর ব্যর্থতা কত? আর `"ব্যর্থ" বলা হলো, অথচ email গেছে` — এই সংখ্যাটা এখন কী বলছে? এক লাইনে: timeout কী ঠিক করল আর কী করল না।

4. **In-memory queue এর দুর্বলতা** (experiment ২): `CRASH_AT_MS=14000 npm run scenario -- queue` আর `CRASH_AT_MS=14000 npm run scenario -- fire-and-forget` — দুটো চালাও। কোনটায় বেশি email হারাল, আর কেন? (ইঙ্গিত: কোনটা কাজ **জমিয়ে** রাখে, আর কোনটা সব কাজ সাথে সাথে provider এর দিকে ঠেলে দেয় — তার দামটা কী ছিল?)

5. **Design অংশ:** TaskFlow এর সব route এর একটা তালিকা বানাও (অন্তত ৮টা: task তৈরি, assign, comment, status বদল, attachment upload, CSV export, sign-up, pro plan upgrade)। প্রতিটার জন্য: route এর ভেতরের প্রতিটা **ধাপ** লেখো, আর প্রতিটা ধাপকে "পথে" বা "বাইরে" চিহ্ন দাও ১.৬ এর চারটা প্রশ্ন দিয়ে। তারপর প্রতিটা route এর critical path এর availability হিসাব করো (নিজের ধরে নেওয়া সংখ্যায়, কিন্তু লিখে রাখো)। শেষে দুই লাইন: TaskFlow এর queue তে কয়টা আলাদা **ধরনের** job আসবে, আর তাদের কি একটা queue তে রাখবে না আলাদা (প্রশ্ন ৩ মাথায় রেখে)?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (সম্পূর্ণ, exit challenge সহ)
Current: 7.1 — Async Thinking: কেন সবকিছু synchronous হলে system মরে যায়
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; assign/comment এর email, Slack webhook, search index আর
export — request এর পথ থেকে সরানোর সিদ্ধান্ত; এখন একটা in-memory job queue + ৮টা worker
(prototype) — টেকসই queue বাকি (7.3); বাইরের সব call এ timeout
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 7.2 — Message Queue vs Pub/Sub: RabbitMQ, Kafka, Redis Streams তুলনা
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ২ নম্বরের Little's Law এর হিসাব আর ৫ নম্বরের route এর তালিকা। রেডি হলে `next` লিখো — Lesson 7.2 এ যাব: **Message Queue vs Pub/Sub — RabbitMQ, Kafka, Redis Streams এর তুলনা।** আজ আমরা একটা array কে queue বলেছি, আর দেখেছি সেটা deploy এ মরে। টেকসই queue বাছতে গেলে প্রশ্নগুলো বদলে যায়: একটা job কি একজন worker ই পাবে, নাকি email service, search service আর analytics — তিনজনই একই "comment তৈরি হলো" খবর চাইবে? পড়ার পরে message মুছে যাবে, নাকি রয়ে যাবে যাতে কাল নতুন একটা service এসে পুরনো সব খবর আবার পড়তে পারে? আর ক্রম — একই task এর দুটো ঘটনা কি সবসময় একই ক্রমে পৌঁছাবে? এই তিনটা প্রশ্নের উত্তর দিয়েই তিনটা tool এর পার্থক্য।
