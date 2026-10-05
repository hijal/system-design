# Lesson 7.4 — Idempotency, Retry, Exponential Backoff, DLQ, Backpressure

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.5):** দুটো transaction একই সময়ে `SELECT … FROM sent_notifications WHERE key = 'X'` চালাল, দুজনেই কিছু পেল না, তারপর দুজনেই `INSERT` করল। `READ COMMITTED` এ কী হবে, `SERIALIZABLE` এ কী হবে — আর কোন একটা জিনিস থাকলে isolation level যাই হোক, দুজনের একজন আটকাবেই? আজ ঠিক এই race টা একটা email এর চেহারায় দেখবে।

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 5.5 (Transaction, unique constraint), Lesson 6.1 (Timeout মানে "জানি না", fencing), Lesson 7.1 (Backlog, Little's Law), Lesson 7.2 (Ack, at-least-once), Lesson 7.3 (BullMQ, stalled job, retry, job ID)

**তুমি এই lesson শেষে পারবে:**

1. একটা consumer কে idempotent বানাতে পারবে — আর যেকোনো কৌশলের জন্য বলতে পারবে ঠিক কোন crash point বা কোন race এ সেটা ভাঙে (হারায়, নাকি দুবার)
2. কোন error retry করবে আর কোনটা না, কতক্ষণ, কোন layer এ — আর exponential backoff এ jitter কেন লাগে, সেটা সংখ্যা দিয়ে দেখাতে পারবে
3. Poison message কে dead letter queue এ সরানো, আর consumer এর চেয়ে বেশি কাজ এলে backpressure বা load shedding — TaskFlow এর প্রতিটা job এর জন্য এই নীতিগুলো ঠিক করতে পারবে

**Tier:** 1 — Runnable Code (চারটা deterministic simulation — একটা সব crash point আর সব interleaving গুনে দেখে)

---

## ০. TaskFlow এখন কোথায়

Lesson 7.3 এ TaskFlow এর email BullMQ তে গেছে: আলাদা worker, Redis এ job, retry আর backoff, নিজের job ID। কিছু আর হারায় না। Production এ প্রথম দুই সপ্তাহে তিনটা ঘটনা ঘটল:

1. **Mention email দুবার।** 7.3 তেই দেখেছিলাম: worker মরলে তার চলমান job stalled হয়ে আবার চলে। একজন engineer একটা fix দিল — পাঠানোর আগে `sent_notifications` table দেখো, থাকলে বাদ। Duplicate কমল, কিন্তু থামল না। আরেকজন "পুরোপুরি থামাতে" ক্রমটা বদলাল — আগে table এ লেখো, তারপর পাঠাও। এক সপ্তাহ পরে ticket: _"আমাকে একটা comment এ mention করা হয়েছিল, কোনো email পাইনি।"_ Log এ: ঠিক সেই মুহূর্তে একটা worker এর deploy।
2. **বুধবার সকাল ৯টা।** প্রতিদিনের digest cron একসাথে ৪০ হাজার job ছাড়ে। Provider এর rate limit ছাড়াল, `429`। Retry ছিল "১ সেকেন্ড পরে আবার" — তাই ৯:০০:০১ এ আবার প্রায় ৪০ হাজার, ৯:০০:০২ এ আবার। Provider এর abuse detection TaskFlow এর account ১৫ মিনিটের জন্য আটকে দিল। আর সেই ১৫ মিনিটে যারা password reset চাইল — তাদের email ও গেল না।
3. **শুক্রবার বিকেল।** একটা project এর data তে একটা ভাঙা email address। সেই address এ প্রতিটা job ব্যর্থ — আর কেউ একজন ঠিক আগের সপ্তাহে "যাতে কিছু না হারায়" বলে `attempts` অসীম করে দিয়েছিল। সোমবার সকালে queue এ ৫০ হাজার job, worker রা বেশিরভাগ সময় সেই ভাঙা job গুলো নিয়েই ব্যস্ত, আর সাধারণ email ঘণ্টাখানেক দেরিতে। কোনো alert বাজেনি — কারণ কিছুই "ব্যর্থ" হয়নি, সবকিছু শুধু "retry হচ্ছে।"

তিনটা ঘটনার পেছনে একই বাক্য, যেটা Module 7 জুড়ে বারবার এসেছে: **ব্যর্থতা থাকবেই — প্রশ্ন হলো ব্যর্থতার পরে system কী করে।** আজ সেই "কী করে" এর পাঁচটা অংশ: idempotency (দুবার এলে), retry আর backoff (ব্যর্থ হলে), dead letter queue (কখনোই সফল না হলে), আর backpressure (সামলানোর চেয়ে বেশি এলে)।

---

## ১. Theory

### ১.১ কেন "অন্তত একবার" — আর "ঠিক একবার" কোথা থেকে আসে

এক অনুচ্ছেদে পেছনের তিনটা lesson: 7.2 তে দেখেছি ack আর কাজ দুটো আলাদা ঘটনা, মাঝখানে crash হতেই পারে — তাই broker এর সামনে বাছাই হারানো (at-most-once) আর দুবার (at-least-once) এর মধ্যে। 7.3 এ দেখেছি BullMQ at-least-once: worker মরলে ৮টা email দুবার, event loop আটকালে ৯টা। আর producer এর দিকেও duplicate আসে (double click) — সেটা job ID দিয়ে আটকেছি।

তাহলে একটা message একটা consumer এর কাছে দুইভাবে আবার আসে:

```
  (ক) পরপর:     worker A কাজ করল ──► ✗ crash (ack যায়নি) ──► broker আবার দিল ──► worker B কাজ করল
  (খ) একসাথে:   worker A কাজ করছে (আটকে, lock গেল) ─────────────────────────────►
                                     worker B একই job তুলে নিল ──────────────────►
```

দুটো ভিন্ন সমস্যা, আর আজ দেখবে একটা কৌশল প্রায়ই একটা সারায়, অন্যটা না।

"Exactly once" তাহলে কোথা থেকে আসে? Delivery থেকে না — **প্রক্রিয়া** থেকে:

```
   at-least-once delivery   +   idempotent processing   =   exactly-once effect
   (broker দেয়)                 (তোমার দায়িত্ব)              (user যা দেখে)
```

User দেখে না message কয়বার এসেছে; দেখে inbox এ কয়টা email। আজকের প্রথম অর্ধেক সেই সংখ্যা ১ রাখার উপায়।

### ১.২ Idempotent Consumer — ছয়টা কৌশল, সব crash point

Lesson 2.5 এ idempotency শিখেছি HTTP API এর দিক থেকে: client এর `Idempotency-Key`, server আগের উত্তর ফেরত দেয়। আজ অন্য দিক:

**Idempotent consumer** — এমন consumer যেটা একই message একাধিকবার পেলেও (পরপর বা একসাথে) তার বাইরের প্রভাব (email, database এর বদল, charge) একবারই ঘটায়।

প্রথম উপায়টা প্রায়ই ভুলে যাওয়া হয়: **কাজটাকেই স্বভাবত idempotent বানাও।** `UPDATE tasks SET status = 'done' WHERE id = 7` দশবার চালালেও ফল এক। `UPDATE usage SET count = count + 1` দশবার চালালে দশ গুণ। "সেট করো" idempotent, "বাড়াও" না। যেখানে সম্ভব, effect কে "সেট" এর ভাষায় লেখো — upsert, নির্দিষ্ট মান, key দিয়ে লেখা row। কিন্তু email পাঠানোকে "সেট" বানানো যায় না — পাঠানো মানেই একটা নতুন ঘটনা। সেখানে একটা **dedupe key** লাগে, কোথাও লিখে রাখতে হয় "এটা হয়ে গেছে।"

কোথায় লিখবে, কখন লিখবে — এখানেই সব ভুল। Exercise এর `npm run idempotency` ছয়টা কৌশলের প্রতিটায় **প্রতিটা ধাপের পরে crash** ধরে দেখে (তারপর message আবার আসে), আর দুটো worker একসাথে এলে তাদের ধাপগুলো যত রকম ক্রমে মিশতে পারে **সবগুলো** গোনে। কোনো random নেই — সব সম্ভাবনা গোনা:

```
   strategy                                     crash: lost / twice    concurrent: twice
   1. nothing: send → ack                           0 / 1 (1 point)                6 / 6
   2. check first: check → send → insert → ack      0 / 1 (3 points)             60 / 66
   3. claim first: insert (unique) → send → ack     1 / 0 (2 points)              0 / 12
   4. claim + state (no provider key)               0 / 1 (3 points)             60 / 66
   5. claim + state + provider key                  0 / 0 (3 points)              0 / 66
   6. one transaction (effect in the database)      0 / 0 (1 point)                0 / 6
```

(ডান কলাম হলো "কতগুলো সম্ভাব্য ক্রমে duplicate" — প্রতিটা ক্রম সমান সম্ভাব্য না, কিন্তু শূন্য বনাম অশূন্য টাই আসল কথা।)

**কৌশল ২ — "আগে দেখো"** — ঘটনা ১ এর প্রথম fix। দুটো ফাঁক:

- `send` এর পরে, `insert` এর আগে crash → table এ কিছু নেই → পরের delivery আবার পাঠায়। Crash এর ফাঁক।
- দুজন একসাথে: A দেখল (নেই), B দেখল (নেই), A পাঠাল, B পাঠাল। ৬৬ টা ক্রমের ৬০টায় duplicate। এটা spaced repetition এর race — **check-then-act**: দেখা আর করার মাঝে অন্য কেউ ঢুকে পড়ে। Lesson 5.5 এর ভাষায়, `SELECT` এর ফল এর উপর ভিত্তি করে `INSERT` করা, আর সাধারণ isolation level এ দুজনেই একই "নেই" দেখে।

**কৌশল ৩ — "আগে দাবি"** — ঘটনা ১ এর দ্বিতীয় fix। `INSERT … ON CONFLICT DO NOTHING` আগে, unique constraint এর উপর: race শেষ (৬৬ এর জায়গায় ১২টা ক্রম, একটাতেও duplicate না) — কারণ database নিজে দুটো একই key এর row কে একসাথে থাকতে দেয় না, isolation level যাই হোক। Spaced repetition এর উত্তর এটাই: **unique constraint**। কিন্তু: দাবির পরে, পাঠানোর আগে crash → পরের delivery দেখে "দাবি হয়ে গেছে" → বাদ দেয় → email **কখনো যায় না**। ঘটনা ১ এর দ্বিতীয় ticket, হুবহু। Duplicate কে হারানোয় বদলানো হলো — at-least-once কে at-most-once এ।

**কৌশল ৪ — দাবি + অবস্থা:** দাবির সময় `status = 'pending'`, পাঠানোর পরে `'sent'`। পরের delivery `sent` দেখলে বাদ, `pending` দেখলে বোঝে আগের জন মাঝপথে থেমেছিল — আবার পাঠায়। হারানো বন্ধ! কিন্তু "পাঠাল, তারপর `sent` লেখার আগে crash" → `pending` → আবার পাঠায় → দুবার। আর দুজন একসাথে দুজনেই `pending` দেখে পাঠায়। এটা Lesson 6.1 এর মূল কথা: **"পাঠানো" আর "লিখে রাখা যে পাঠিয়েছি" দুটো আলাদা machine এ দুটো আলাদা ঘটনা** — তাদের মাঝের ফাঁক কোনো ক্রম সাজিয়ে বন্ধ করা যায় না। শুধু ঠিক করা যায় ফাঁকে পড়লে কোন দিকে ভুল হবে: হারানো (কৌশল ৩) না দুবার (কৌশল ৪)।

**কৌশল ৫ — ফাঁকটা provider এর কাছে বন্ধ করা।** কৌশল ৪, কিন্তু পাঠানোর সময় একটা স্থির key provider কে দাও — আর provider নিজে সেই key দ্বিতীয়বার দেখলে পাঠায় না। এখন "পাঠাল কিন্তু লিখতে পারেনি" তে আবার পাঠালেও ক্ষতি নেই — provider জানে। সব crash point আর সব ৬৬ টা ক্রমে ঠিক একবার। 6.1 এর ভাষায়: fencing token কাজ করে যখন resource নিজে যাচাই করে; এখানে resource টা provider, আর যাচাই এর চিহ্ন idempotency key। Stripe এর `Idempotency-Key` header এর কাজ এটাই (Stripe এর documentation অনুযায়ী key গুলো অন্তত ২৪ ঘণ্টা মনে রাখা হয়)।

**কৌশল ৬ — effect টা নিজের database এ হলে, একই transaction।** Effect যদি email না হয়ে তোমার নিজের database এর একটা লেখা হয় (billing এর usage count বাড়ানো), তাহলে ফাঁকটাই নেই: dedupe row লেখা আর effect একই transaction এ — দুটো একসাথে হয়, নয়তো কোনোটাই না (Lesson 5.5 এর atomicity)। এটাই একমাত্র জায়গা যেখানে "ঠিক একবার" সত্যিকারের, কোনো শর্ত ছাড়া।

TaskFlow এ কৌশল ৫ আর ৬ এর চেহারা:

```typescript
// sent_notifications: key (PRIMARY KEY), status ('pending' | 'sent'), createdAt
async function sendMention(msg: MentionMessage): Promise<void> {
	// the dedupe key comes from the work's identity — not from the message ID (why, at the end of 1.2)
	const key = `mention:${msg.commentId}:${msg.userId}`;
	// claim: create it as pending if it isn't there; if it is, return what's there
	const [row] = await SentNotification.findOrCreate({
		where: { key },
		defaults: { key, status: 'pending' }
	});
	if (row.status === 'sent') return; // already done — ack
	// pending: new, or someone before stopped midway — sending again with the same key is safe, because the provider dedupes
	await mailer.send({ to: msg.email, template: 'mention', idempotencyKey: key });
	await row.update({ status: 'sent' });
}

async function countCompletedTask(msg: TaskCompletedMessage): Promise<void> {
	await sequelize.transaction(async (t) => {
		// unique constraint on processed_messages.key; if it's already there, do nothing
		const [, created] = await ProcessedMessage.findOrCreate({
			where: { key: `usage:${msg.taskId}:${msg.completedAt}` },
			transaction: t
		});
		if (!created) return;
		await Usage.increment('completedTasks', {
			where: { workspaceId: msg.workspaceId, month: msg.month },
			transaction: t
		});
	});
}
```

(`findOrCreate` নিজে ভেতরে unique constraint এর উপর নির্ভর করে race সামলায় — table এ constraint না থাকলে এটা আবার কৌশল ২ এর race। Constraint টাই আসল প্রতিরক্ষা, code না।)

**Provider idempotency key না দিলে?** অনেক email provider দেয় না। তখন সৎ উত্তর: কৌশল ৪ এর ছোট ফাঁকটা থাকবে — "পাঠাল, `sent` লেখার আগে মরল" — আর মাঝে মাঝে একটা duplicate হবে। বেশিরভাগ notification এর জন্য সেটা গ্রহণযোগ্য (হারানোর চেয়ে ভালো); ফাঁকটা ছোট রাখো (পাঠানোর পরেই লেখা), আর গোনো কতবার হচ্ছে। টাকার ক্ষেত্রে গ্রহণযোগ্য না — সেখানে এমন provider বাছো যে key নেয়।

**তিনটা বাস্তব সিদ্ধান্ত:**

- **Dedupe key কীসের?** Message এর ID না, **effect এর পরিচয়**: `mention:{commentId}:{userId}`। কারণ একই effect কখনো কখনো দুটো আলাদা message হয়ে আসে (producer এর retry, বা পরের lesson এর outbox relay এর duplicate) — তাদের message ID আলাদা, কিন্তু user কে একই email একবারই যাওয়া উচিত।
- **Key কতদিন রাখবে?** যতদিন একই message আবার আসতে পারে: queue এর retention, retry এর মোট সময়, DLQ থেকে redrive এর সময় (১.৪) — তার চেয়ে বেশি। TaskFlow এ ৩০ দিন, আর তারপর পুরনো row মোছা (তারিখ দিয়ে partition করা table এ পুরো partition drop — Lesson 5.8)।
- **Dedupe কোথায়?** সবচেয়ে ভালো: effect যেখানে ঘটে, তার সবচেয়ে কাছে — একই database হলে একই transaction (কৌশল ৬), বাইরের হলে তার নিজের key (কৌশল ৫)।

### ১.৩ Retry আর Backoff — কখন, কতবার, আর কেন jitter

Idempotency retry কে **নিরাপদ** করে। এবার প্রশ্ন retry কে **কার্যকর** করা — আর নিজের ক্ষতি না করা।

**কোন error retry করবে?** ব্যর্থতা দুই রকম:

- **Transient (সাময়িক):** timeout, connection বিচ্ছিন্ন, `503`, `429`, `500` এর বেশিরভাগ — আবার চেষ্টায় সফল হতে পারে।
- **Permanent (স্থায়ী):** `400` (অবৈধ address), `401`/`403`, `404`, validation error, তোমার code এর bug — হাজারবার চেষ্টাতেও একই ফল। (7.3 এর BullMQ এ `UnrecoverableError`।)

Permanent কে retry করা শুধু সময় নষ্ট না — ১.৪ এ দেখবে সেটা পুরো system কে টেনে নামায়।

আর `429` আর `503` এর সাথে প্রায়ই একটা `Retry-After` header আসে — provider নিজে বলে দিচ্ছে কখন আসবে। সেটা মানো; তোমার backoff এর হিসাবের চেয়ে সে তার অবস্থা ভালো জানে।

**কোন layer এ retry?** প্রায় উপেক্ষিত প্রশ্ন। ধরো TaskFlow এর worker email service কে ৩ বার চেষ্টা করে, email service provider এর SDK কে ৩ বার, SDK নিজে HTTP এ ৩ বার। Provider ধীর হলে একটা job থেকে provider এ যায় ৩ × ৩ × ৩ = **২৭টা** request — ঠিক যখন সে সবচেয়ে দুর্বল। নিয়ম: **retry এক জায়গায়**, সাধারণত সবচেয়ে উপরের layer এ (যে কাজটার মালিক — এখানে BullMQ job), নিচের layer গুলো দ্রুত ব্যর্থ হোক। বড় system এ এর উপরে একটা **retry budget** থাকে: মোট request এর একটা ছোট ভগ্নাংশের বেশি retry না (Google এর SRE বই এর "Handling Overload" অধ্যায়ে এর একটা রূপ আছে) — তাহলে সব ব্যর্থ হলেও load সর্বোচ্চ ১.১ গুণ হয়, ২৭ গুণ না।

**কীভাবে অপেক্ষা করবে — আর retry storm।**

**Retry storm** — অনেক client একসাথে ব্যর্থ হয়ে একসাথে আবার চেষ্টা করে, আর সেই একসাথে আসা ঢেউ নিজেই downstream কে আবার overload করে — ব্যর্থতা নিজেকে টিকিয়ে রাখে।

বুধবারের ঘটনা ঠিক এটা। Exercise এর `npm run storm`, পরিস্থিতি (ক) — ১০০০টা job ঠিক একই মুহূর্তে (৯টার cron), provider প্রতি ১০০ ms এ ১০টা নিতে পারে (১০০/s), প্রতি job সর্বোচ্চ ১০ চেষ্টা:

```
   policy                        attempts     max per 100ms     ok    gave up   last ok  delay p99
   retry immediately                 9750              1990     50        950    450 ms     450 ms
   fixed 1 s later                   9550              1000    100        900     9.5 s      9.5 s
   exponential (no jitter)           9550              1000    100        900    46.0 s     46.0 s
   exponential + full jitter         7152              1456   1000          0    20.3 s     16.6 s

   attempts reaching the provider per second:
   second                           0     1     2     3     4     5     6     7
   fixed 1 s later               1000   990   980   970   960   950   940   930
   exponential (no jitter)       3940   960     0   950     0     0   940     0
   exponential + full jitter     4547   964   521   302   256   139    89    91
```

- **সাথে সাথে আবার:** ০.৫ সেকেন্ডে ১০টা চেষ্টা শেষ, ৯৫০টা হাল ছাড়ে। সবচেয়ে বেশি চাপ, সবচেয়ে কম কাজ।
- **স্থির ১ সেকেন্ড:** প্রতি সেকেন্ডে পুরো দলটা একসাথে ফেরে — ১০০০, ৯৯০, ৯৮০… — আর প্রতিবার provider সেই মুহূর্তে ১০টাই নিতে পারে। ১০ চেষ্টায় ১০০টা সফল। বুধবার সকাল।
- **Exponential, jitter ছাড়া:** অপেক্ষা বাড়ে (১০০ ms, ২০০, ৪০০, ৮০০ …) — কিন্তু **সবার একসাথে বাড়ে**। দলটা এখনো একসাথে ফেরে, শুধু ক্রমশ দেরিতে: ০, ১, ৩, ৬ সেকেন্ডে দলা। সেই ১০০টাই সফল — আর শেষেরটা ৪৬ সেকেন্ডে।
- **Exponential + full jitter:** ১০০০ ই সফল, মোট চেষ্টা সবচেয়ে কম।

**Jitter** — retry এর অপেক্ষার সময়ে ইচ্ছাকৃত এলোমেলোতা, যাতে একসাথে ব্যর্থ হওয়া client রা আলাদা আলাদা মুহূর্তে ফেরে। "Full jitter" এ অপেক্ষা = `random(0, min(cap, base × 2^(n−1)))` — exponential সীমার **নিচে** যেকোনো জায়গায়।

(এই ফর্মুলা আর তুলনাটা AWS এর Marc Brooker এর "Exponential Backoff And Jitter" লেখা থেকে বিখ্যাত — AWS Builders' Library এর "Timeouts, retries, and backoff with jitter" এও আছে। পড়ার মতো।)

মূল কথাটা ধরো: exponential backoff **কত বার** চাপ দেওয়া হয় সেটা কমায়; jitter **একসাথে** চাপ দেওয়া ভাঙে। Retry storm এর আসল রোগ দ্বিতীয়টা। Experiment ২: চেষ্টা ১০ থেকে ২০ করলে স্থির আর jitter-ছাড়া exponential এর সফল ১০০ থেকে ২০০ — সমস্যার মূল ধরা হয়নি, শুধু আরও বেশি ঢেউ।

**সৎ অংশ — পরিস্থিতি (খ):** job যখন এমনিতেই ছড়িয়ে আসে (৫০/s), আর provider ৫ সেকেন্ড বন্ধ থেকে ফেরে:

```
   policy                        attempts     max per 100ms     ok    gave up   last ok  delay p99
   retry immediately                 3205                50    767        233    20.0 s     350 ms
   fixed 1 s later                   2192                30   1000          0    20.0 s      8.4 s
   exponential (no jitter)           2415                30   1000          0    20.0 s     13.1 s
   exponential + full jitter         2682                44   1000          0    28.0 s     13.3 s
```

এখানে jitter এর কোনো লাভ নেই — বরং সামান্য বেশি চেষ্টা। কারণ synchronization ছিলই না; job গুলো আসার সময়েই ছড়ানো। আর experiment ৩ এ (outage ১৫ সেকেন্ড) full jitter এর ৫৩টা job হাল ছাড়ে, jitter-ছাড়া exponential এর একটাও না — full jitter এর গড় অপেক্ষা সীমার অর্ধেক, তাই একই চেষ্টার সংখ্যায় মোট সময় কম। শিক্ষা: jitter synchronization এর ওষুধ, সর্বরোগহর না; আর সীমা ঠিক করো **সময়** দিয়ে ("১০ মিনিট ধরে চেষ্টা"), শুধু সংখ্যা দিয়ে না। Production এ synchronization প্রায় সবসময় আসে কোথাও থেকে — cron, deploy, outage শেষ হওয়া, cache এর একসাথে মেয়াদ শেষ — তাই jitter default হিসেবে রাখো। ("সাথে সাথে আবার" এর কোনো পরিস্থিতিতেই পক্ষে কিছু বলার নেই।)

### ১.৪ Poison Message আর Dead Letter Queue

শুক্রবারের ঘটনা।

**Poison message** — এমন message যেটা প্রতিবার প্রক্রিয়ায় ব্যর্থ হবে, কারণ দোষ message এর নিজের (ভাঙা data, কোডের bug যেটা এই নির্দিষ্ট data তে লাগে) — অপেক্ষা বা retry তে কখনো সারবে না।

**Dead letter queue (DLQ)** — একটা আলাদা জায়গা যেখানে নির্দিষ্ট সীমা পর্যন্ত চেষ্টার পরেও ব্যর্থ (বা স্থায়ীভাবে ব্যর্থ) message সরিয়ে রাখা হয় — মূল queue থেকে বের করে, কিন্তু না ফেলে — যাতে একজন মানুষ দেখে, কারণ বের করে, ঠিক করে, আবার চালাতে পারে (redrive)।

প্রতিটা broker এ এর রূপ আছে: BullMQ এ `failed` set (7.3); RabbitMQ এ dead-letter exchange (queue এর `x-dead-letter-exchange` — message reject হলে, মেয়াদ শেষ হলে, বা queue এর সীমা ছাড়ালে সেখানে যায়; quorum queue এ কতবার delivery হতে পারবে তার সীমাও বসানো যায়); AWS SQS এ redrive policy (`maxReceiveCount` বার পাওয়ার পরে DLQ তে)। Kafka তে broker এর নিজের কিছু নেই — 7.2 এর head-of-line blocking এর কারণে consumer নিজেই ব্যর্থ message একটা আলাদা topic এ লিখে এগিয়ে যায়।

`npm run dlq` — ৫ মিনিট, প্রতি সেকেন্ডে ২০টা email, ৪টা worker, ভালো job এ ১০০ ms। ২% poison (প্রতিবার ২ সেকেন্ড কাজ করে তারপর `400`)। ৬০–৯০ সেকেন্ডে provider এর outage (সব `503`)। ৪০০ সেকেন্ডে একজন মানুষ DLQ দেখে ঠিক করে redrive করে:

```
   policy                                  poison worker time     max waiting  good delay p99       to DLQ (good / poison) redriven → arrived   pending (good / poison)
   retry forever (no limit)                               74%            1489          93.8 s                        0 / 0              0 → 0                   0 / 131
   5 times, then DLQ                                      68%            1292          76.1 s                      0 / 135              0 → 0                     0 / 0
   5 times; permanent to DLQ at once                      28%             352         338.5 s                    159 / 135          159 → 159                     0 / 0
   permanent at once; transient 12 times                  28%             417          45.9 s                      0 / 135              0 → 0                     0 / 0
```

**প্রথম সারি — শুক্রবার:** ২% poison job worker এর সময়ের **৭৪%** খায়। প্রতিটা poison প্রতি ৩০ সেকেন্ডে (backoff এর সীমা) আবার আসে আর ২ সেকেন্ড নেয় — আর নতুন poison আসতেই থাকে, কেউ চলে যায় না। তাদের খরচ সময়ের সাথে রৈখিকভাবে বাড়ে, আর একসময় worker এর পুরো ক্ষমতা ছাড়ায়। লাইন ১৪৮৯, ভালো job এর p99 দেড় মিনিট, আর ৬০০ সেকেন্ডে ১৩১টা poison তখনো ঘুরছে। আর সবচেয়ে বিপজ্জনক অংশ: কোনো job "failed" না — কোনো alert নেই।

**দ্বিতীয় সারি — সীমা, কিন্তু সব error একরকম:** poison ৫ বার পরে DLQ তে যায়, কিন্তু তার আগে ৫ × ২ s খায় — তখনো ৬৮%। (এখানে একটা দুর্ঘটনা আছে যেটা ভুল পড়া সহজ: ভালো job একটাও DLQ তে যায়নি, কিন্তু নীতির গুণে না — poison এর জন্য লাইন এত লম্বা যে outage এ ব্যর্থ job এর পরের চেষ্টা লাইনের অপেক্ষাতেই outage পার হয়ে যায়। সুস্থ system এ এই নীতি তৃতীয় সারির মতো আচরণ করত।)

**তৃতীয় সারি — permanent আলাদা:** `400` পেলে সাথে সাথে DLQ — poison এর খরচ ২৮% (প্রতিটা একবারই ২ s)। কিন্তু নতুন সমস্যা: transient ও ৫ বারে থামে, আর ১ + ২ + ৪ + ৮ = ১৫ সেকেন্ডের retry ৩০ সেকেন্ডের outage ঢাকে না — **১৫৯টা ভালো job DLQ তে।** তারা হারায়নি (৪০০ s এ redrive এ ১৫৯ টাই পৌঁছায়) — কিন্তু মানুষ আসা পর্যন্ত বসে ছিল, তাই p99 **৩৩৮ সেকেন্ড**। DLQ একটা নিরাপত্তা জাল, কিন্তু জালে পড়া মানে একজন মানুষের কাজ আর দেরি।

**চতুর্থ সারি — দুটো সিদ্ধান্তই ঠিক:** permanent সাথে সাথে DLQ, transient কে লম্বা সময় (১২ চেষ্টা, ~৭ মিনিট — outage ঢাকার মতো)। DLQ তে শুধু poison, ভালো job এর p99 ৪৬ s।

এখান থেকে DLQ এর নিয়মগুলো:

1. **সীমা সবসময় থাকবে।** অসীম retry মানে poison এর খরচ অসীম — আর নীরব।
2. **Error এর ধরন আলাদা করো।** Permanent সাথে সাথে DLQ; transient এর সীমা **সময়ে** ভাবো ("একটা স্বাভাবিক outage এর চেয়ে বেশি"), চেষ্টার সংখ্যায় না।
3. **DLQ ডাস্টবিন না।** DLQ এর আকার > ০ হলেই alert। কেউ দেখবে, কারণ খুঁজবে (message এর সাথে শেষ error আর চেষ্টার সংখ্যা রাখো), data বা code ঠিক করবে, তারপর redrive।
4. **Redrive নিরাপদ হতে হবে** — মানে consumer idempotent (১.২)। DLQ এর একটা job হয়তো আসলে প্রথমবারেই কাজ করে ফেলেছিল, শুধু ack এর সময় ভেঙেছিল।
5. **DLQ এর retention > মানুষের সাড়া দেওয়ার সময়** — শুক্রবার বিকেলের DLQ সোমবার সকাল পর্যন্ত থাকতে হবে। (7.3 এ `removeOnFail` ৭ দিন ছিল এই কারণে।)

### ১.৫ Backpressure — সামলানোর চেয়ে বেশি এলে

বুধবারের ঘটনার দ্বিতীয় অর্ধেক: provider TaskFlow কে আটকাল, আর password reset ও গেল না। একটা বড়, কম জরুরি ঢেউ একটা ছোট, খুব জরুরি কাজকে ডুবিয়ে দিল।

Lesson 7.1 এ দেখেছি queue **capacity বানায় না** — আসার গতি গড়ে কাজের গতির চেয়ে বেশি হলে backlog সীমাহীন বাড়ে। Queue দুটো আলাদা জিনিস সামলায়, আর তাদের আলাদা করে দেখা জরুরি:

- **Burst (ঢেউ):** কিছুক্ষণ বেশি, তারপর কম — গড়ে সামলানো যায়। Queue এর আসল কাজ এটাই: ঢেউ শুষে নেওয়া।
- **Sustained overload:** সবসময় বেশি। Queue শুধু সময় কেনে; শেষে কাউকে থামতে হবে, বা কিছু বাদ দিতে হবে।

**Backpressure** — downstream (consumer) যখন কাজ নিতে পারছে না, তখন সেই খবর upstream (producer) এর দিকে পাঠানো, যাতে producer ধীর হয়, অপেক্ষা করে, বা নতুন কাজ নেওয়া বন্ধ করে — সীমাহীন জমতে না দিয়ে।

**Load shedding** — overload এ ইচ্ছা করে কিছু কাজ ফিরিয়ে দেওয়া বা ফেলে দেওয়া (সাধারণত কম জরুরি গুলো), যাতে বাকি কাজ সময়মতো হয় — সবকিছু ধীর হয়ে সবাই ব্যর্থ হওয়ার চেয়ে।

`npm run backpressure` — consumer ১০০/s, অর্ধেক job জরুরি (password reset, mention), অর্ধেক কম জরুরি (digest, analytics), চারটা নীতি:

```
── burst (300/s for 5 s, then 50/s)
   policy                               queue max     producer held    rejected (urgent / low)  wait p99 (all / urgent)
   unbounded queue                              1001                0                 0 / 0             9.8 s / 9.8 s
   limit 500, 503 when full                    500                0             250 / 251             5.0 s / 5.0 s
   limit 500, producer waits                  500              501                 0 / 0             9.8 s / 9.8 s
   priority: drop less urgent above 300     475                0               0 / 584             9.6 s / 2.4 s

── sustained (always 130/s)
   unbounded queue                              1801                0                 0 / 0           17.8 s / 17.8 s
   limit 500, 503 when full                    500                0             650 / 651             5.0 s / 5.0 s
   limit 500, producer waits                  500             1301                 0 / 0           17.8 s / 17.8 s
   priority: drop less urgent above 300     301                0              0 / 1501              8.6 s / 0 ms
```

চারটা নীতি, চারটা শিক্ষা:

1. **সীমাহীন queue** burst এ দারুণ — ১০০০ এর ঢেউ শুষে নেয়, কেউ ফেরে না, সবাই ১০ সেকেন্ডের মধ্যে। কিন্তু sustained এ লাইন ৬০ সেকেন্ডে ১৮০০, আর load না থামলে সীমাহীন — memory ফুরানো পর্যন্ত (7.3 এর `noeviction` এ তখন `queue.add` ব্যর্থ হতে শুরু করে — অনিয়ন্ত্রিত backpressure)।
2. **সীমা + `503`** অপেক্ষাকে বেঁধে রাখে: `৫০০ ÷ ১০০/s = ৫ s` — যা ঢোকে সেটা ৫ সেকেন্ডের মধ্যে হয়। কিন্তু burst এ এটা ৫০১টা কাজ ফেরায় যেগুলো queue সামলাতে পারত। **সীমা মানে অপেক্ষার সীমা** — Little's Law এর উল্টো: `সীমা = মেনে নেওয়ার মতো অপেক্ষা × কাজের গতি`। Experiment ৪: সীমা ১৫০০ এ burst এ কেউ ফেরে না, sustained এ ৩০১টা, অপেক্ষা ১৫ s পর্যন্ত।
3. **সীমা + producer অপেক্ষা করে** — queue ৫০০ তে থামে, কিন্তু অপেক্ষা সীমাহীনের সমান। লাইনটা শুধু **সরে গেছে**: producer এর কাছে ১৩০১টা request ঝুলে আছে। API এর ক্ষেত্রে মানে ১৩০১টা HTTP connection খোলা (7.1 এর cascading failure এর উপকরণ)। Backpressure মানে চাপ উপরে পাঠানো; উপরের কেউ (user, client, তাদের timeout) না থামলে চাপ শুধু জায়গা বদলায়। শেষ পর্যন্ত কোথাও একটা "না" বলতেই হয়।
4. **অগ্রাধিকার** — sustained এ জরুরি job এর p99 **০ ms**, কম জরুরি গুলোর ১৫০১টা বাদ। Overload এ কিছু কাজ বাদ যাবেই — **কোনটা** বাদ যাবে, সেটা বেছে নেওয়াই load shedding। বুধবার সকালে এটা থাকলে password reset যেত, digest দেরিতে।

**TaskFlow এ বাস্তবে কোথায় কোথায় "না" বলা যায়:**

- **Producer এর দিকে (API):** `queue.add` এর আগে queue এর দৈর্ঘ্য দেখো (`queue.getWaitingCount()`), সীমা ছাড়ালে কম জরুরি কাজে `503` + `Retry-After` (বা কাজটা পরে করার জন্য user কে জানানো)। Rate limit (Lesson 9.5) producer এর দিকের আরেকটা রূপ।
- **আলাদা queue:** জরুরি আর কম জরুরি একই queue তে না (7.1 এর প্রশ্ন ৩)। Password reset এর নিজের queue আর worker — digest এর ঢেউ তাকে ছোঁয় না।
- **Provider এর দিকে:** worker এর গতি provider এর সীমার নিচে বাঁধা (BullMQ এর `limiter: { max, duration }`) — ৪০ হাজার digest একসাথে না গিয়ে provider এর গতিতে যায়; তখন `429` আসেই না।
- **Cron কে ছড়ানো:** ৯টায় ৪০ হাজার job একসাথে না — প্রতিটায় একটা এলোমেলো `delay` (০–১৫ মিনিট)। Jitter, cron এর ভাষায়।

(একটা পরিচিত উদাহরণ যেটা তুমি হয়তো আগেই দেখেছ: Node এর stream। `writable.write()` `false` ফেরত দিলে লেখা থামাও, `'drain'` event এর অপেক্ষা করো — এটাই backpressure, একটা process এর ভেতরে। আর Kafka এর consumer নিজের গতিতে pull করে — 7.2 এর log এ backpressure স্বাভাবিকভাবেই আছে: ধীর consumer শুধু lag বাড়ায়, broker তাকে কিছু ঠেলে দেয় না।)

### ১.৬ TaskFlow এর নীতি — job ধরে

> **Trade-off Table — TaskFlow এর job গুলোর ব্যর্থতার নীতি**

| Job                | Dedupe key                       | Idempotency কৌশল                              | Retry (transient)                      | Permanent / DLQ                          | Queue / অগ্রাধিকার                                          |
| ------------------ | -------------------------------- | --------------------------------------------- | -------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Password reset     | `reset:{tokenId}`                | দাবি + অবস্থা + provider key (৫)              | exponential + jitter, ১৫ মিনিট পর্যন্ত | `400` সাথে সাথে DLQ; DLQ > ০ এ alert     | আলাদা, সবচেয়ে উঁচু; কখনো shed না                           |
| Mention email      | `mention:{commentId}:{userId}`   | ৫ (provider key না দিলে ৪, duplicate গোনা)    | ঐ, ১ ঘণ্টা পর্যন্ত                     | ঐ                                        | Notification queue, উঁচু                                    |
| Daily digest       | `digest:{userId}:{date}`         | ৫                                             | ঐ, ৬ ঘণ্টা পর্যন্ত; `Retry-After` মানো | ঐ                                        | আলাদা, নিচু; provider limiter; cron jitter; overload এ shed |
| Usage count        | `usage:{taskId}:{completedAt}`   | একই transaction (৬)                           | exponential + jitter                   | DB constraint error → DLQ                | Billing queue; shed কখনো না                                 |
| Webhook (customer) | `webhook:{eventId}:{endpointId}` | receiver এর দায়িত্ব — `eventId` header পাঠাও | ২৪ ঘণ্টা পর্যন্ত, বাড়তে থাকা ফাঁকে    | endpoint `410` → বন্ধ; customer কে দেখাও | Customer প্রতি সীমা — একজনের মরা server সবাইকে না আটকায়    |

---

## ২. Interview Angle

**"Message queue থেকে পড়া consumer কে exactly-once কীভাবে বানাবে?"** — উত্তরের প্রথম বাক্য: "delivery exactly-once না, at-least-once — আমি effect কে idempotent বানাব।" তারপর কৌশল: dedupe key (effect এর পরিচয় থেকে), unique constraint (check-then-act race কেন ভাঙে, এক বাক্যে), আর effect যেখানে: নিজের database হলে একই transaction, বাইরের হলে তার idempotency key। শেষে সৎ সীমা: বাইরের system key না নিলে একটা ছোট duplicate এর জানালা থাকে — কোথায়, কেন, আর কীভাবে মাপবে। এই শেষ অংশটাই সাধারণত senior আর mid-level উত্তর আলাদা করে।

**"Retry করবে কীভাবে?"** — পাঁচটা শব্দ বলো, কারণ সহ: **transient only** (৪xx না), **exponential backoff**, **jitter** (synchronization ভাঙতে — "retry storm" নামটা বলো), **সীমা** (সময়ে, আর layer এ একবার — retry amplification), **idempotent** (নইলে retry নিজেই bug)। বোনাস: `Retry-After` মানা, retry budget।

**"Consumer ধীর, queue বাড়ছে — কী করবে?"** — আগে প্রশ্ন: burst না sustained? Burst হলে queue এর কাজই এটা — lag দেখো, সীমার মধ্যে থাকলে কিছু না। Sustained হলে: consumer scale (যদি downstream নিতে পারে), না হলে backpressure (producer এ `503`/`429`), অগ্রাধিকার দিয়ে load shedding, কম জরুরি কাজ আলাদা queue তে। আর "queue বড় করে দাও" উত্তর না — সেটা শুধু লাইন লম্বা করে।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ভুলের তালিকা প্রায় নির্দিষ্ট — dedupe এর "আগে দেখো" (race), অসীম retry (poison), DLQ তে alert নেই (নীরব কবরস্থান), সব layer এ retry (২৭ গুণ), jitter ছাড়া backoff (cron এর ঢেউ), আর জরুরি আর কম জরুরি একই queue তে (বুধবার)। একটা নতুন queue চালুর আগে এই তালিকা ধরে একবার দেখে নেওয়া অনেক incident বাঁচায়।

---

## ৩. Key Takeaway

- Delivery **at-least-once**; "exactly once" আসে **idempotent processing** থেকে। একই message আবার আসে দুইভাবে — crash এর পরে পরপর, আর stalled এ একসাথে
- **"আগে দেখো"** crash এ দুবার আর race এ দুবার (৬৬ এর ৬০ ক্রম); **"আগে দাবি"** (unique constraint) race সারায় কিন্তু crash এ **হারায়**; কাজ আর "কাজ হয়েছে" লেখার মাঝের ফাঁক ক্রম সাজিয়ে বন্ধ হয় না — বন্ধ হয় effect এর নিজের **idempotency key** তে, বা effect নিজের database এ হলে **একই transaction** এ
- Dedupe key = effect এর পরিচয় (message ID না); key রাখো redrive এর সময়ের চেয়ে বেশি; constraint টাই প্রতিরক্ষা
- Retry শুধু transient error এ, এক layer এ, সময়ের সীমায়; exponential backoff **কতবার** কমায়, **jitter** **একসাথে** ভাঙে — synchronized ঢেউ এ jitter ছাড়া ১০০০ এর ১০০, jitter সহ ১০০০ ই সফল; ছড়ানো load এ jitter এর লাভ প্রায় নেই
- **Poison message** সীমাহীন retry তে worker এর ৭৪% খায়, নীরবে; সীমা + permanent error সাথে সাথে **DLQ** + transient কে outage ঢাকার মতো সময় = poison ২৮%, DLQ তে শুধু poison। DLQ > ০ এ alert, redrive নিরাপদ হতে হবে
- Queue **burst** শোষে, **sustained overload** সারায় না; **backpressure** চাপ উপরে পাঠায় (কিন্তু কোথাও "না" বলতে হয়), সীমা = অপেক্ষা × গতি; **load shedding** অগ্রাধিকার দিয়ে কোনটা বাদ যাবে বাছে — জরুরি এর p99 ০ ms

---

## ৪. নতুন Term (Glossary)

| Term                        | অর্থ                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Idempotent Consumer**     | একই message একাধিকবার (পরপর বা একসাথে) পেলেও বাইরের প্রভাব একবারই ঘটায় এমন consumer                                             |
| **Retry Storm**             | অনেক client একসাথে ব্যর্থ হয়ে একসাথে আবার চেষ্টা করে, আর সেই ঢেউ downstream কে আবার overload করে — ব্যর্থতা নিজেকে টিকিয়ে রাখে |
| **Jitter**                  | Retry এর অপেক্ষায় ইচ্ছাকৃত এলোমেলোতা (full jitter: `random(0, exponential সীমা)`), যাতে client রা আলাদা মুহূর্তে ফেরে           |
| **Poison Message**          | নিজের দোষে (ভাঙা data, নির্দিষ্ট bug) প্রতিবার ব্যর্থ হবে এমন message — অপেক্ষা বা retry তে সারে না                              |
| **Dead Letter Queue (DLQ)** | সীমা পর্যন্ত চেষ্টার পরে বা স্থায়ী ব্যর্থতায় message সরিয়ে রাখার আলাদা জায়গা — মানুষ দেখে, ঠিক করে, redrive করে              |
| **Backpressure**            | Downstream কাজ নিতে না পারলে সেই খবর upstream এ পাঠানো — producer ধীর হয়, অপেক্ষা করে, বা নতুন কাজ নেয় না                      |
| **Load Shedding**           | Overload এ ইচ্ছা করে কিছু কাজ (সাধারণত কম জরুরি) ফিরিয়ে দেওয়া, যাতে বাকিগুলো সময়মতো হয়                                       |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. TaskFlow এর billing: প্রতিটা `task.completed` message এ workspace এর মাসিক usage count ১ বাড়ে, মাস শেষে সেই count দিয়ে invoice। কিন্তু usage count এখন **Redis** এ রাখা (`INCR usage:{workspaceId}:{month}`), আর dedupe এর জন্য কেউ প্রস্তাব দিল Postgres এর একটা `processed_messages` table। এই design এ কোন crash point এ কী ভাঙে? ছয়টা কৌশলের কোনটার মতো? দুটো সমাধান দাও — একটা যেখানে count Redis এই থাকে, একটা যেখানে থাকে না — আর তুমি কোনটা বাছবে।
2. TaskFlow customer দের server এ webhook পাঠায় (`task.completed` হলে তাদের URL এ POST)। একজন বড় customer এর server ৬ ঘণ্টা বন্ধ। Retry, DLQ, backpressure আর idempotency — চারটার প্রতিটার জন্য বলো তুমি কী করবে, যাতে (ক) সেই customer এর event হারায় না, (খ) বাকি customer দের webhook দেরি না হয়, (গ) সেই customer এর server ফিরলে তাকে একসাথে ৬ ঘণ্টার ঢেউ দিয়ে আবার না ফেলা হয়, আর (ঘ) দুবার পাওয়া event তাদের দিকে ক্ষতি না করে।
3. বুধবারের ঘটনাটা আবার design করো। ৪০ হাজার digest, provider এর সীমা ১০০/s, password reset দিনে কয়েকশো কিন্তু প্রতিটা ১ মিনিটের মধ্যে যাওয়া দরকার। কোন কোন পরিবর্তন করবে (অন্তত চারটা, এই lesson এর চারটা ভিন্ন অংশ থেকে), আর প্রতিটা ঘটনার কোন অংশটা আটকায়? ৪০ হাজার digest শেষ হতে কত সময় লাগবে, আর সেটা কি গ্রহণযোগ্য?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Effect (Redis `INCR`) আর dedupe row (Postgres) দুটো আলাদা system এ — তাই কৌশল ৬ এর "একই transaction" আর নেই; এটা ২, ৩ বা ৪ এর কোনো একটা, আর ক্রম অনুযায়ী ভাঙে:

- আগে Postgres এ দাবি, তারপর `INCR` (কৌশল ৩): দাবির পরে crash → পরের delivery বাদ দেয় → count **কম** (task গোনা হলো না — customer কম bill পেল)।
- আগে `INCR`, তারপর দাবি: `INCR` এর পরে crash → আবার `INCR` → count **বেশি** (customer বেশি bill পেল — আরও খারাপ)।
- দেখে তারপর দুটো (কৌশল ২): race এ দুজনেই `INCR`।

সমাধান ক — count Redis এই, কিন্তু dedupe ও Redis এ, একই atomic operation এ: একটা Lua script (বা `MULTI`) যেটা `SET processed:{key} 1 NX` সফল হলে তবেই `INCR` করে — দুটো একই Redis এ, একই atomic ধাপে → কৌশল ৬ এর Redis-রূপ। শর্ত: Redis এর persistence আর failover এ লেখা হারানো (7.3 এর ১.৮) — billing এর জন্য ঝুঁকি।

সমাধান খ — count কে "বাড়ানো" থেকে "গোনা" তে বদলানো: Postgres এ `completed_tasks_usage (taskId PRIMARY KEY, workspaceId, month)` — প্রতিটা message একটা row insert করে (`ON CONFLICT DO NOTHING`)। Usage = `COUNT(*)`। এটা স্বভাবত idempotent (১.২ এর "সেট" এর ভাষা) — দশবার এলেও এক row। Dedupe আর effect একই জিনিস। Redis দরকার হলে শুধু দ্রুত দেখানোর cache হিসেবে, source of truth না।

বাছাই: খ। Billing এ টাকা — source of truth database এ, আর effect টাকেই idempotent বানানো সবচেয়ে শক্ত সমাধান।

**প্রশ্ন ২:**

- **Retry:** প্রতিটা webhook এর retry সময়ে বাঁধা — যেমন ২৪ ঘণ্টা পর্যন্ত, exponential + jitter, সর্বোচ্চ ফাঁক ঘণ্টাখানেক। ৬ ঘণ্টার outage এর পুরোটা ঢাকে। (Stripe এর মতো বড় provider এর webhook দিনের পর দিন ধরে retry করে।)
- **Backpressure / isolation (খ এর জন্য):** সব customer এর webhook একটা queue তে একই worker দিয়ে গেলে, মরা server এর timeout (ধরো ১০ s প্রতিটা) worker দের আটকায় — বাকিদের দেরি (7.1 এর cascading)। তাই: customer (endpoint) প্রতি একসাথে চলা request এর সীমা (১–২টা), timeout ছোট (৫ s), আর বারবার ব্যর্থ endpoint কে সাময়িক "বন্ধ" হিসেবে চিহ্নিত করে তার job গুলো পিছিয়ে রাখা — circuit breaker (Lesson 9.4)। বড় আকারে: customer প্রতি আলাদা queue বা partition।
- **ফিরে আসার ঢেউ (গ):** server ফিরলে ৬ ঘণ্টার event একসাথে না — endpoint প্রতি rate limit (যেমন প্রতি সেকেন্ডে ১০টা), আর retry এর jitter এর কারণে event গুলো এমনিতেই ছড়ানো থাকে।
- **DLQ:** ২৪ ঘণ্টা পরেও ব্যর্থ হলে DLQ — আর customer এর dashboard এ দেখানো ("এই event গুলো পৌঁছায়নি, আবার পাঠাও" বোতাম সহ)। Endpoint `410 Gone` দিলে (স্থায়ী) — আর চেষ্টা না, endpoint বন্ধ, customer কে জানানো।
- **Idempotency (ঘ):** at-least-once তাই customer দুবার পেতে পারে — প্রতিটা webhook এ একটা স্থির `eventId` header পাঠাও, আর documentation এ বলো "`eventId` দিয়ে dedupe করো।" Receiver এর দিকের idempotency তাদের দায়িত্ব; তোমার দায়িত্ব তাদের সেটা সম্ভব করে দেওয়া (স্থির ID, retry তে বদলায় না)।

**প্রশ্ন ৩:** পরিবর্তন, অংশ ধরে:

1. **Backpressure / isolation — আলাদা queue:** password reset এর নিজের queue আর worker। Digest এর যেকোনো ঢেউ তাকে ছোঁয় না। (ঘটনার সবচেয়ে খারাপ অংশ — password reset না যাওয়া — এটা একাই আটকায়।)
2. **Backpressure — provider এর গতিতে বাঁধা:** digest worker এ `limiter: { max: 80, duration: 1000 }` — provider এর সীমার একটু নিচে, password reset এর জন্য জায়গা রেখে। `429` আর আসেই না, তাই account আটকানোর কারণ নেই।
3. **Jitter — cron কে ছড়ানো:** প্রতিটা digest job এ `delay = random(0, 15 মিনিট)` — ৪০ হাজার একসাথে queue তে ঢোকে না। (Limiter থাকলে এটা বাড়তি নিরাপত্তা — Redis এ একসাথে ৪০ হাজার waiting ও থাকে না।)
4. **Retry — `429` এ `Retry-After` মানা, exponential + jitter:** যদি তবু `429` আসে, ঢেউ হয় না।
5. **Idempotency:** `digest:{userId}:{date}` key আর provider key — cron দুবার চললে (deploy এর মুহূর্তে, বা 6.1 এর দুই leader) কেউ দুটো digest পায় না।
6. **DLQ:** অবৈধ address এর digest সাথে সাথে DLQ, যাতে poison ঢেউ এর সময় জায়গা না খায়।

সময়: ৪০,০০০ ÷ ৮০/s = ৫০০ s ≈ **৮–৯ মিনিট** (jitter এর ১৫ মিনিটের মধ্যে ছড়ানো থাকলে সেই ১৫ মিনিটই)। Digest এর জন্য "৯টা থেকে ৯টা ১৫ এর মধ্যে" পুরোপুরি গ্রহণযোগ্য — কেউ ঠিক ৯:০০:০০ তে digest আশা করে না। আর password reset এর ১ মিনিটের লক্ষ্য digest এর উপর আর নির্ভর করে না।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (deterministic simulation)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-7.4-reliable-consumers/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.4-reliable-consumers) — `npm install`, তারপর `npm run idempotency`, `npm run storm`, `npm run dlq`, `npm run backpressure`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`idempotency.ts` ছয়টা consumer কৌশলকে ধাপের তালিকা হিসেবে লেখে, তারপর প্রতিটা ধাপের পরে crash আর দুটো worker এর সব interleaving গুনে দেখে — কোনো random নেই। `storm.ts`, `dlq.ts` আর `backpressure.ts` seed দেওয়া simulation — প্রতিবার হুবহু একই সংখ্যা।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; চারটা script দুবার করে চালিয়ে হুবহু একই output; README এর experiment ১–৫ চালানো হয়েছে (১ নম্বরটা `idempotency.ts` বদলে, তারপর ফিরিয়ে), সংখ্যা README তে। এগুলো model: প্রতিটা ধাপ atomic ধরা, provider এর idempotency key সবসময় আছে ধরা (বাস্তবে সব provider দেয় না), storm এর provider overload এ ধীর না হয়ে সাথে সাথে 503 দেয়, আর interleaving এর সংখ্যা "কতগুলো ক্রম সম্ভব" — সমান সম্ভাব্য না।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **ঘটনা ১ হাতে:** `idempotency` চালানোর **আগে** কৌশল ২, ৩ আর ৪ এর প্রতিটা crash point এর ফল (০, ১ না ২) অনুমান করে লেখো। তারপর চালিয়ে মেলাও। তারপর experiment ১: "দেখো → লেখো → send" — এটা কৌশল ২ আর ৩ এর কোন দোষ গুলো একসাথে নেয়?

2. **ঢেউ গোনো:** storm (ক) এর "স্থির 1 s পরে" নীতিতে ১০০টা সফল — হাতে ব্যাখ্যা করো (প্রতি ঢেউ এ কতজন, provider এর একটা ১০০ ms এর জানালায় কতজন সফল, কয়টা ঢেউ)। তারপর experiment ২ (`MAX_ATTEMPTS=20`) — কেন ২০০, আর কেন এটা সমাধান না?

3. **Poison এর খরচ:** dlq এর প্রথম সারির "৭৪%" মোটামুটি হিসাব করো — প্রতি সেকেন্ডে কয়টা poison আসে, প্রতিটা কতক্ষণ পর পর আবার আসে আর কত সময় নেয়, ৩০০ সেকেন্ডে জমে কয়টা। Worker এর ক্ষমতা ৪ worker-সেকেন্ড/সেকেন্ড — কোন মুহূর্তে poison একাই সব খেয়ে ফেলতে শুরু করে?

4. **সীমা হিসাব:** TaskFlow এর mention email এর জন্য user সর্বোচ্চ ২ মিনিট দেরি মেনে নেবে, worker এর গতি ৫০/s। Queue এর সীমা কত রাখবে? `LIMIT` বদলে backpressure চালিয়ে দেখো তোমার সংখ্যায় burst এ কতগুলো ফেরে (experiment ৪ এর মতো)।

5. **Design অংশ:** ১.৬ এর table টা TaskFlow এর আরও তিনটা job এর জন্য বাড়াও — CSV export (7.3 এর প্রশ্ন ১), attachment thumbnail, আর search index update (`comment.created` থেকে)। প্রতিটার জন্য: dedupe key, idempotency কৌশল (ছয়টার কোনটা, কেন), retry এর সময়সীমা, কোন error permanent, DLQ হলে কে দেখবে, আর overload এ shed হবে কিনা। Search index এর জন্য বিশেষ করে ভাবো: effect টা কি স্বভাবত idempotent বানানো যায় (১.২ এর "সেট" এর ভাষা)?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (সম্পূর্ণ, exit challenge সহ), 7.1, 7.2, 7.3
Current: 7.4 — Idempotency, retry, exponential backoff, DLQ, backpressure
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; BullMQ (আলাদা Redis, noeviction + AOF) — job প্রতি নীতি:
dedupe key = effect এর পরিচয়, sent_notifications (pending/sent) + provider idempotency key,
usage = একই transaction; retry শুধু transient, exponential + full jitter, সময়ে বাঁধা,
Retry-After মানা; permanent → সাথে সাথে DLQ (failed set), DLQ > ০ এ alert; আলাদা queue:
password reset (উঁচু) / notification / digest (নিচু, limiter, cron jitter, overload এ shed);
events → Redis Streams (7.2); বাকি: database ↔ queue এর dual write (7.5)
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF, Idempotent Consumer, Retry Storm, Jitter,
Poison Message, Dead Letter Queue, Backpressure, Load Shedding
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 7.5 — Event-Driven Architecture basics
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ৩ নম্বরের poison এর হিসাব আর ৫ নম্বরের table। রেডি হলে `next` লিখো — Lesson 7.5 এ যাব: **Event-Driven Architecture basics।** তিনটা lesson ধরে একটা প্রশ্ন বারবার পিছিয়ে রেখেছি: assign এর database commit হলো, তারপর `queue.add` এর আগে API মরল — assign আছে, email এর job নেই। উল্টো ক্রমে: job আছে, commit ব্যর্থ। দুটো আলাদা system এ একসাথে লেখার এই dual write সমস্যা আজকের কোনো কৌশলে সারে না — কারণ আজকের সব কৌশল শুরু হয় "message টা এসেছে" ধরে নিয়ে। 7.5 এ সেই message কীভাবে নিশ্চিতভাবে **তৈরি** হয় — transactional outbox — আর তার সাথে event আর command এর পার্থক্য, event-driven design কখন সাহায্য করে আর কখন একটা অদৃশ্য জট বানায়।
