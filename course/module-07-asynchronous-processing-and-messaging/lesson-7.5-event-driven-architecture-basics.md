# Lesson 7.5 - Event-Driven Architecture Basics

**Module 7 - Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.3 + 5.7):** Postgres এর WAL কী - একটা commit এর আগে কোথায় কী লেখা হয়? আর async replication এ replica কীভাবে primary এর **প্রতিটা** পরিবর্তন, ঠিক ক্রমে পায়? আজ এই একই stream কে অন্য কাজে লাগাব - database এর পরিবর্তন থেকে event বানাতে।

**Prerequisite:** Lesson 5.3 (WAL), Lesson 5.5 (Transaction), Lesson 5.7 (Replication), Lesson 7.2 (Log, consumer group, partition key), Lesson 7.3 (BullMQ, dual write এর প্রশ্ন), Lesson 7.4 (Idempotent consumer)

**আপনি এই lesson শেষে পারবেন:**

1. Event আর command আলাদা করতে পারবেন, আর একটা flow কে event দিয়ে সাজানো (choreography) কখন সাহায্য করে আর কখন একটা অদৃশ্য জট বানায় - বলতে পারবেন
2. Dual write কেন কোনো ক্রম সাজিয়ে সারে না, সেটা exercise এর সংখ্যা দিয়ে দেখাতে পারবেন - আর transactional outbox দিয়ে সেটা বন্ধ করতে পারবেন (polling relay বা CDC)
3. একটা event এর চুক্তি design করতে পারবেন - নাম, ID, version, কতটা data - যাতে producer আর consumer আলাদাভাবে বদলাতে পারে

**Tier:** 1 - Runnable Code (Docker এ Postgres + Redis; writer আর relay আসলেই মাঝপথে `SIGKILL` হয়)

---

## ০. TaskFlow এখন কোথায়

Lesson 7.2 এর সিদ্ধান্ত মতো TaskFlow এর "খবর" একটা Redis Stream এ যায়। Comment তৈরির route এখন:

```typescript
await sequelize.transaction(async (t) => {
	await Comment.create({ taskId, authorId, body }, { transaction: t });
});
await redis.xadd('events:comments', '*', 'data', JSON.stringify(event)); // after the commit
res.status(201).json(comment);
```

আর সেই stream এর consumer group চারটা: notification (mention email - 7.3, 7.4), search index, analytics, Slack integration। তিন সপ্তাহে তিনটা ঘটনা:

1. **একটা deploy এর পরে:** কয়েকজন user বলল তাদের নতুন comment search এ আসছে না, আর mention করা মানুষ email পায়নি। Comment গুলো database এ আছে। Stream এ তাদের কোনো event নেই।
2. **Redis এর একটা failover এর ৩ সেকেন্ড:** সেই ৩ সেকেন্ডে লেখা সব comment - একই অবস্থা। কোনো error নেই, কারণ `xadd` এর ব্যর্থতা `catch` করে log করা হয়েছিল (user কে 201 দিতে হবে তো - comment তো সেভ হয়েছে)।
3. **একজন engineer ক্রমটা উল্টাল** - "আগে event, তারপর commit, তাহলে event হারাবে না।" এক সপ্তাহ পরে: কেউ একটা email পেল "Rahim আপনাকে একটা comment এ mention করেছে", link এ click করে - 404। আর পরের Redis maintenance এর সময় পাঁচ মিনিট **কেউ comment ই করতে পারল না।**

একই সময়ে product meeting এ অন্য একটা তর্ক। Task complete হলে এখন ছয়টা জিনিস হওয়ার কথা: assignee আর watcher দের notification, analytics, billing এর usage (7.4), customer দের webhook, parent task auto-close, আর sprint এর progress update। Task service এর `complete()` function এ ছয়টা call জমছে। একজন বলল: "সবাইকে call না করে শুধু একটা `task.completed` event ছাড়ুন - যার দরকার সে শুনুক।" আরেকজন সাবধান করল: "তাহলে ছয় মাস পরে কেউ বলতে পারবে না task complete হলে ঠিক কী কী হয়।"

দুজনেই ঠিক। আজ দুটো প্রশ্ন: event-driven design কখন ভালো, কখন ক্ষতিকর - আর event টা **নির্ভরযোগ্যভাবে তৈরি** কীভাবে হয়, যেটা 7.3 থেকে পিছিয়ে রাখা প্রশ্ন।

---

## ১. Theory

### ১.১ Event আর Command - "ঘটেছে" বনাম "করুন"

Lesson 7.2 এ message কে দুই ভাগ করেছিলাম - "কাজ" আর "খবর"। আজ তাদের আনুষ্ঠানিক নাম।

**Command** - কাউকে একটা নির্দিষ্ট কাজ করতে বলা ("এই email পাঠান", "এই card charge করুন"); একজন নির্দিষ্ট প্রাপক আছে, সে কাজটা করতে পারে বা প্রত্যাখ্যান করতে পারে, আর পাঠানোর সময় পাঠক জানে কী হওয়া উচিত।

**Event** - এমন একটা ঘটনার খবর যেটা ইতিমধ্যে ঘটে গেছে ("comment তৈরি হলো", "task complete হলো"); এটা একটা তথ্য, প্রত্যাখ্যান করার কিছু নেই, আর প্রকাশক জানে না (জানার দরকারও নেই) কে কে শুনছে বা শুনে কী করবে।

নামেই পার্থক্য ধরা পড়ে: command আদেশসূচক (`SendMentionEmail`, `ChargeCard`), event অতীত কাল (`comment.created`, `task.completed`)। আর দায়িত্বের দিক উল্টো:

```
   command:  task service ──"notification পাঠান"──► notification service
             (task service জানে notification আছে, আর তার কী করা উচিত)

   event:    task service ──"task complete হলো"──► [ stream ] ──► notification
                                                             ──► analytics
                                                             ──► billing …
             (task service শুধু জানে কী ঘটেছে; কে কী করবে, সেটা তাদের সিদ্ধান্ত)
```

একটা সাধারণ ভুল: event এর নামে command পাঠানো - `task.completed.sendEmailToAssignee`। এখানে প্রকাশক আসলে প্রাপক আর কাজ দুটোই ঠিক করে দিচ্ছে, শুধু নামটা event এর মতো। দুটোর দোষ একসাথে পাওয়া যায়: command এর coupling, event এর অদৃশ্যতা।

### ১.২ Event-Driven Architecture - কী পান, কী দেন

Event-driven architecture মানে service গুলো একে অপরকে সরাসরি call না করে event এ **সাড়া দেয়**। Task complete এর ছয়টা কাজ দুইভাবে সাজানো যায়:

```
  ক) সরাসরি call (একজন সব জানে)                খ) event (কেউ সব জানে না)

  complete() {                                    complete() {
    notify(assignee, watchers)                      db: status = done
    analytics.track(...)                            publish('task.completed')
    billing.countUsage(...)                       }
    webhooks.send(...)                                 │
    if (parent.autoClose) parent.complete()            ├──► notification (নিজে ঠিক করে কাকে)
    sprint.updateProgress(...)                         ├──► analytics
  }                                                    ├──► billing
                                                       ├──► webhooks
                                                       ├──► parent auto-close
                                                       └──► sprint progress
```

(খ) কে বলে **choreography** - নাচের দলের মতো, প্রত্যেকে নিজের অংশ জানে আর সংকেত শুনে নিজে চলে, কোনো পরিচালক নেই। (ক) এর মতো একজন কেন্দ্রীয় সমন্বয়কারী যেখানে বলে দেয় কে কখন কী করবে, সেটা **orchestration** - Lesson 9.3 এর saga তে দুটো আবার ফিরবে।

**Choreography** - একটা বড় কাজ কয়েকটা service এ ভাগ, যেখানে কেউ কাউকে নির্দেশ দেয় না; প্রত্যেকে event শুনে নিজের অংশ করে, আর দরকার হলে নিজের event ছাড়ে।

**কী পান:**

- **Producer এর coupling কমে।** নতুন একটা কাজ (ধরুন "task complete হলে Jira তে sync") মানে নতুন একটা consumer - task service এর code এ হাতও দিতে হয় না।
- **Temporal decoupling (7.1)।** Analytics এক ঘণ্টা বন্ধ থাকলে task complete হওয়া থামে না; analytics ফিরে এসে পিছিয়ে পড়া অংশ পড়ে নেয় (7.2 এর log)।
- **আলাদা scale, আলাদা ব্যর্থতা।** Webhook এর ধীর customer billing কে ধীর করে না।

**কী দেন:**

- **Flow অদৃশ্য হয়ে যায়।** (ক) তে "task complete হলে কী হয়" এর উত্তর একটা function পড়লেই। (খ) তে উত্তর ছয়টা repo তে ছড়ানো, আর কোন service কোন event শোনে সেটা কোনো এক জায়গায় লেখা নেই। Meeting এর দ্বিতীয় জন এটাই বলছিল।
- **Event এর চেইন।** Parent auto-close একটা নতুন `task.completed` ছাড়ে, যেটা আবার parent auto-close কে জাগায়… Event গুলো একে অপরকে ট্রিগার করে এমন একটা জাল বানাতে পারে যেটা কেউ design করেনি - আর লুপও।
- **Eventual consistency।** Task complete, কিন্তু sprint এর progress এক সেকেন্ড পরে বদলায়। (খ) তে "সব একসাথে" বলে কিছু নেই।
- **Debug কঠিন।** একটা ভুলের কারণ খুঁজতে পাঁচটা service এর log জুড়তে হয় - প্রতিটা event এ একটা correlation ID লাগে (Lesson 10.4 এর tracing)।
- **Event এর আকৃতি একটা public চুক্তি।** Producer একটা field এর নাম বদলালে অজানা সংখ্যক consumer ভাঙে (১.৬)।

তাহলে নিয়মটা কী? মোটামুটি: **যে কাজ মূল কাজের একটা পার্শ্ব-প্রতিক্রিয়া, যার ফল মূল কাজের caller এর লাগে না, আর যেটা স্বাধীনভাবে ব্যর্থ হতে পারে - সেটা event এ।** যে কাজ মূল কাজের অংশ (ব্যর্থ হলে মূল কাজও ব্যর্থ হওয়া উচিত), বা যার ক্রম আর সমন্বয় জটিল ও ব্যবসার জন্য গুরুত্বপূর্ণ - সেটা সরাসরি, বা orchestration এ। Task complete এর ছয়টার মধ্যে notification, analytics, webhook, sprint progress পরিষ্কার event। Billing এর usage ও (7.4 এর idempotent consumer)। Parent auto-close নিয়ে ভাবার দরকার: এটা ব্যবসার নিয়ম, আর চেইন বানায় - অনেক team এটা task service এর ভেতরেই রাখে।

### ১.৩ Event এ কতটা data?

Martin Fowler এর 2017 এর লেখা "What do you mean by 'Event-Driven'?" দেখায় যে "event-driven" বলে মানুষ কয়েকটা আলাদা জিনিস বোঝায়। আজকের জন্য তিনটা:

**Event notification - শুধু খবর আর ID:** `{ type: 'task.completed', taskId: 42 }`। Consumer এর আর কিছু লাগলে task service কে জিজ্ঞেস করে। Event ছোট, কিন্তু প্রতিটা consumer ফিরে call করে (task service এ load, আর তার availability আবার consumer এর পথে - 7.1 এর temporal coupling ফেরত এলো), আর ফিরে পড়ার সময় data হয়তো ইতিমধ্যে আবার বদলে গেছে।

**Event-carried state transfer** - event এর সাথেই সেই data যা consumer দের লাগবে (`taskId`, `title`, `assigneeId`, `completedBy`, `completedAt`, `projectId`), যাতে consumer কে ফিরে producer কে জিজ্ঞেস করতে না হয়; consumer চাইলে নিজের কাছে একটা কপি রাখে।

Consumer স্বাধীন হয় - task service বন্ধ থাকলেও notification এর যা দরকার সব event এ আছে। দাম: event বড়, data এর কপি অনেক জায়গায় (আর সব কপি কিছুক্ষণ পুরনো - eventual), আর event এ যা রাখবেন সেটা সবাই দেখবে (ব্যক্তিগত তথ্য, secret - কখনো না)।

**Event sourcing** - event কেই source of truth বানানো: task এর বর্তমান অবস্থা database এর row না, বরং তার সব event (`created`, `assigned`, `renamed`, `completed`) শুরু থেকে চালিয়ে পাওয়া ফল। শক্তিশালী (পুরো ইতিহাস, যেকোনো সময়ের অবস্থা আবার বানানো যায়), কিন্তু এটা পুরো system এর design বদলায় - 7.2 এর ১.৪ এর সতর্কতা এখানেও। আজকের বিষয় না; TaskFlow এ database ই source of truth থাকবে, আর event তার **পরিবর্তনের খবর**।

TaskFlow এর জন্য মাঝামাঝি: event এ ID গুলো আর সেই কয়েকটা field যা প্রায় সব consumer এর লাগে - বাকিটা দরকার হলে consumer ফিরে জিজ্ঞেস করবে।

### ১.৪ Dual Write - কোনো ক্রম সাজিয়ে সারে না

এবার ঘটনা ১–৩। সমস্যার নাম:

**Dual write** - একটা কাজের জন্য দুটো আলাদা system এ লেখা (এখানে Postgres আর Redis), যাদের মধ্যে কোনো ভাগ করা transaction নেই - তাই মাঝখানে কিছু ভাঙলে একটায় লেখা হয়, অন্যটায় না।

এটা Lesson 7.4 এর ১.২ এর ফাঁকের যমজ ভাই। সেখানে "email পাঠানো" আর "লিখে রাখা যে পাঠিয়েছি" - দুটো system, মাঝে ফাঁক। এখানে "comment লেখা" আর "event পাঠানো" - একই ফাঁক। আর একই শিক্ষা: ক্রম বদলালে শুধু দোষের দিক বদলায়।

Exercise এর `npm run scenario` - ২০০০টা comment, প্রতি ৫০টায় মোটামুটি একটায় writer ঠিক দুই লেখার মাঝখানে নিজেকে `SIGKILL` করে (কোন comment এ সেটা id থেকে ঠিক - তাই প্রতিটা mode এ একই ৪১টা)। শেষে Postgres আর Redis Stream মেলানো:

```
   mode            comments    lost  phantom    extra (same eventId)
   commit-first        2000      41        0        0
   publish-first       1959       0       41        0
```

- **`commit-first`** (ঘটনা ১): ৪১টা comment আছে, event নেই। Search, notification, analytics - কেউ কখনো জানবে না।
- **`publish-first`** (ঘটনা ৩): event আগে বেরিয়ে গেল, তারপর process মরল - খোলা transaction টা connection ছিঁড়ে যাওয়ায় Postgres নিজেই rollback করল। ৪১টা **ভুতুড়ে** event: এমন comment এর খবর যেটা নেই। 404 এর mention email।

আর crash না, শুধু Redis ৩ সেকেন্ড বন্ধ (experiment ১, ঘটনা ২) - দুটো ক্রমের দুটো ভিন্ন দুর্ভোগ:

```
   mode             comments   lost   user saw an error
   commit-first        2000     449                  0      ← 449 events silently missing
   publish-first       1466       0                534      ← 534 people couldn't comment at all
```

`publish-first` "consistent" - কোনো comment event ছাড়া নেই - কিন্তু দাম দিল availability তে: Redis এর প্রতিটা খারাপ সেকেন্ড এখন comment feature এর খারাপ সেকেন্ড। 7.1 এর critical path এর গুণফল আবার - Redis এখন comment তৈরির পথে।

**"দুটো system কে একটা transaction এ বাঁধা যায় না?"** - Two-phase commit (2PC/XA) ঠিক এটা করার চেষ্টা (Lesson 9.3 এ বিস্তারিত)। কিন্তু Redis Stream, Kafka বা বেশিরভাগ broker এতে অংশ নেয় না, আর যেখানে নেয় সেখানে এটা ধীর আর একটা সমন্বয়কারীর ব্যর্থতায় আটকে যায়। বাস্তবে উত্তর অন্য দিকে: দুটো system এ লেখা না - **একটা** তে লেখা।

### ১.৫ Transactional Outbox - একটা system এ লিখুন, পরে পাঠান

**Transactional outbox** - event টা broker এ সরাসরি না পাঠিয়ে, ব্যবসার data এর সাথে **একই database transaction এ** একটা `outbox` table এ লেখা; আলাদা একটা relay process পরে outbox থেকে পড়ে broker এ পাঠায় আর "পাঠানো হয়েছে" চিহ্ন দেয়।

```
   API (writer)                         Postgres                        relay               Redis Stream
   ────────────                         ────────                        ─────               ────────────
   BEGIN
     INSERT comments (…)          ──►   comments      ┐
     INSERT outbox_events (…)     ──►   outbox_events ┘ একই transaction
   COMMIT                               দুটোই আছে, নয়তো কোনোটাই না
                                                                        SELECT … FOR UPDATE
                                                                        SKIP LOCKED (batch)
                                                                        XADD প্রতিটা ──────► event
                                                                        UPDATE publishedAt
                                                                        COMMIT
```

Dual write এর দুটো লেখা এখন একটা database এর একটা transaction - Lesson 5.5 এর atomicity। কৌশলটা 7.4 এর কৌশল ৬ এর মতোই: ফাঁকটা বন্ধ হয় কারণ দুটো লেখা এখন একই system এ।

Exercise এর তৃতীয় সারি:

```
   mode            comments    lost  phantom    extra (same eventId)
   outbox              1959       0        0      160
   relay crashes: 11 · from commit to reaching the stream p50 118 ms, p99 457 ms
```

(বাড়তি আর relay crash এর সংখ্যা run ভেদে একটু বদলায় - relay এর crash কোন batch এ পড়ে সেটা timing এর উপর নির্ভর করে।)

- **হারাল ০, ভুতুড়ে ০।** Writer এর crash এ comment আর outbox row একসাথে rollback - user error দেখল, আর কোথাও কিছু নেই। Consistent।
- **Redis বন্ধ থাকলে (experiment ১):** হারাল ০, user error ০ - comment তৈরিতে এখন শুধু Postgres লাগে। Event গুলো outbox এ অপেক্ষা করে, Redis ফিরলে relay পাঠায় (দেরি p99 ৪.১ s)। Redis comment এর critical path থেকে বেরিয়ে গেছে।
- **বাড়তি ১৬০টা।** Relay পাঠাল, `publishedAt` লেখার আগে মরল - পরের relay আবার পাঠায়। Outbox **at-least-once**, exactly-once না। কিন্তু দেখুন "আলাদা eventId" = ১৯৫৯ = comment এর সংখ্যা: বাড়তিগুলো সব হুবহু কপি, **একই eventId** সহ - তাই 7.4 এর idempotent consumer (eventId বা effect এর key দিয়ে dedupe) এগুলো নিরাপদে বাদ দেয়। Outbox আর idempotent consumer একসাথে একটা জোড়া - একটা ছাড়া আরেকটা অর্ধেক।
- **দেরি।** Event আর commit এর মুহূর্তে যায় না - relay এর পরের খোঁজে (p50 ~১০০ ms, `POLL_MS=1000` এ ~৮৪০ ms)।

**Relay বানানোর খুঁটিনাটি** (exercise এর `relay.ts`):

- `FOR UPDATE SKIP LOCKED` - একাধিক relay চালালে (বা পুরনোটা আটকে থাকতে নতুনটা চালু হলে) একই row দুজন নেয় না; অন্যের লক করা row বাদ দিয়ে পরেরগুলো নেয়।
- `WHERE "publishedAt" IS NULL` এর উপর partial index - outbox এ লাখ লাখ পুরনো row থাকলেও খোঁজা দ্রুত।
- **Batch এর আকার একটা trade-off।** বড় batch = কম round trip; কিন্তু batch একটা transaction, আর মাঝপথে ব্যর্থ হলে পুরোটা আবার। Experiment ৩: প্রতি event এ ৫% crash হলে ৫০ এর batch কোনো crash ছাড়া শেষ হওয়ার সম্ভাবনা ০.৯৫⁵⁰ ≈ ৮% - relay প্রায় থেমে যায় (৬০ সেকেন্ড পরেও ১০৫০টা বাকি)। Batch ৫ এ সব পৌঁছায়। 7.4 এর poison message এর আত্মীয়: একটা খারাপ জিনিস তার সাথের সবাইকে আটকায়।
- **Outbox পরিষ্কার রাখুন।** পাঠানো row জমতেই থাকে (exercise শেষে ২০০০ টা)। কয়েক দিন পরে মুছে ফেলুন - বড় আকারে তারিখ দিয়ে partition করে পুরো partition drop (Lesson 5.8)।

**ক্রম - একটা সূক্ষ্ম ফাঁদ (experiment ৪)।** Outbox এর `id` insert এর সময় বরাদ্দ হয়, commit এর সময় না। দুটো transaction একসাথে: T1 id ১০ পেল, T2 id ১১ পেল, T2 আগে commit করল। Relay এই মুহূর্তে খুঁজলে ১১ দেখে (১০ এখনো দৃশ্যমান না), পাঠায়; পরে ১০ পাঠায় - উল্টো ক্রমে। `publishedAt IS NULL` দিয়ে খুঁজলে ১০ হারায় না, শুধু দেরিতে যায়। কিন্তু কেউ যদি "`WHERE id > শেষ পাঠানো id`" দিয়ে relay লেখে (দেখতে বেশি দক্ষ), তাহলে ১১ পাঠানোর পরে cursor ১১ এ - আর ১০ **কখনো** পাঠানো হয় না। নিয়ম: outbox এ cursor না, flag (বা CDC, নিচে)। আর একই task এর event এর ক্রম যদি জরুরি হয় (7.2), সেই task এর লেখাগুলো নিজেরাই ক্রমে commit হয় (একই row এ lock), তাই সাধারণত ঠিক থাকে - কিন্তু একাধিক relay চালালে প্রতি task এর ক্রম রক্ষা নিশ্চিত করতে হয় (যেমন একটা relay, বা key দিয়ে ভাগ করা relay)।

**Polling না করে - Change Data Capture।** Relay প্রতি ২০০ ms এ database কে জিজ্ঞেস করছে - বেশিরভাগ বার "কিছু নেই"। দুটো উন্নতি:

- **`LISTEN`/`NOTIFY`** - writer এর transaction এ একটা `NOTIFY outbox` (Postgres এটা commit এর সময়ই পাঠায়), relay `LISTEN` করে জেগে ওঠে। দেরি কমে, খালি query কমে। (Notification হারাতে পারে - তাই মাঝে মাঝে polling তবু রাখুন।)
- **CDC:**

**Change Data Capture (CDC)** - database এর নিজের পরিবর্তনের খাতা (Postgres এর WAL, logical decoding দিয়ে) পড়ে প্রতিটা পরিবর্তনকে event হিসেবে বের করা - application code কোনো আলাদা query বা call করে না।

Spaced repetition এর উত্তর এখানে ব্যবহার হয়: replica যেভাবে WAL থেকে primary এর প্রতিটা পরিবর্তন ঠিক **commit এর ক্রমে** পায়, একটা CDC tool (সবচেয়ে পরিচিত Debezium, Kafka Connect এর উপর) ঠিক সেভাবেই পায় - আর সেগুলো broker এ লেখে। Outbox এর সাথে মিলিয়ে: CDC শুধু `outbox_events` table এর insert গুলো পড়ে event বানায় (Debezium এর একটা "outbox event router" আছে ঠিক এই কাজের জন্য)। লাভ: polling নেই, দেরি কম, আর commit এর ক্রম (উপরের ফাঁদটা নেই)। দাম: আরেকটা চালানোর মতো system (Debezium, Kafka Connect), database এ logical replication চালু করা, আর replication slot ঠিকমতো না পড়লে WAL জমে database এর disk ভরে যাওয়ার ঝুঁকি। TaskFlow এর আকারে polling relay যথেষ্ট; যেদিন event অনেক আর দেরি জরুরি, সেদিন CDC।

(Consumer এর দিকের যমজ pattern এর নামও জেনে রাখুন: **inbox** - consumer যে message প্রক্রিয়া করেছে তার ID একটা table এ, effect এর সাথে একই transaction এ। এটা আসলে 7.4 এর কৌশল ৬, নতুন নামে।)

### ১.৬ Event এর চুক্তি - যাতে দুই দিক আলাদাভাবে বদলাতে পারে

Event একবার বেরোলে কে পড়ছে জানা থাকে না - তাই তার আকৃতি একটা public API এর মতো। Exercise এর `events.ts` এর event:

```typescript
export const commentCreatedSchema = z.object({
	eventId: z.string().uuid(), // fixed - doesn't change on retries or relay duplicates; the consumer's dedupe key
	type: z.literal('comment.created'), // past tense
	version: z.literal(1), // for when the shape changes
	occurredAt: z.string(), // when it happened - not when it was sent (in an outbox those two differ)
	taskId: z.number().int().positive(), // the key for order and partitioning (7.2)
	commentId: z.number().int().positive()
});
```

নিয়মগুলো:

- **প্রতিটা event এ একটা স্থির `eventId`** - outbox row তৈরির সময় বানানো, relay এর প্রতিটা পুনঃপ্রেরণে একই। এটা ছাড়া consumer duplicate চিনতে পারে না।
- **`occurredAt` আর পাঠানোর সময় আলাদা।** Outbox এ event ৪ সেকেন্ড পরেও যেতে পারে (Redis outage) - consumer এর যুক্তি ঘটনার সময় দিয়ে চলুক।
- **আকৃতি বদলান শুধু যোগ করে।** নতুন field optional হিসেবে যোগ করা নিরাপদ (পুরনো consumer উপেক্ষা করে - "tolerant reader")। Field এর নাম বদলানো, মুছে ফেলা, অর্থ বদলানো - নতুন version (`version: 2`, বা নতুন event type), কিছুদিন দুটোই পাঠানো, সব consumer সরলে পুরনো বন্ধ।
- **Consumer Zod দিয়ে parse করে** (exercise এর relay ও করে - outbox এর JSONB এ পুরনো version এর row থাকতে পারে)। অজানা version এ crash না করে DLQ তে (7.4)।
- **Secret বা অপ্রয়োজনীয় ব্যক্তিগত তথ্য কখনো না।** Event log এ থাকে, অনেক consumer পড়ে, retention পর্যন্ত থাকে।

> **Trade-off Table - "data লিখুন আর event পাঠান" এর পাঁচটা উপায়**

| উপায়                   | Crash এ                            | Broker বন্ধ থাকলে             | Duplicate          | দেরি            | দাম                                                             |
| ----------------------- | ---------------------------------- | ----------------------------- | ------------------ | --------------- | --------------------------------------------------------------- |
| Commit, তারপর publish   | Event **হারায়** (exercise এ ৪১)   | Event নীরবে হারায় (৪৪৯)      | না                 | নেই             | সবচেয়ে সহজ; ভুল সবচেয়ে নীরব                                   |
| Publish, তারপর commit   | **ভুতুড়ে** event (৪১)             | Feature বন্ধ (৫৩৪ জন error)   | না                 | নেই             | Broker critical path এ; ভুতুড়ে event consumer এর মাথাব্যথা     |
| 2PC / XA                | Consistent (সমন্বয়কারী ঠিক থাকলে) | Feature বন্ধ                  | না                 | বেশি            | বেশিরভাগ broker সমর্থন করে না; ধীর, জটিল (9.3)                  |
| Outbox + polling relay  | Consistent                         | কেউ টের পায় না, event দেরিতে | হ্যাঁ, একই eventId | poll এর ব্যবধান | Outbox table, relay, পরিষ্কার; ক্রমের ফাঁদ; idempotent consumer |
| Outbox + CDC (Debezium) | Consistent                         | কেউ টের পায় না               | হ্যাঁ, একই eventId | কম              | CDC চালানো, logical replication, WAL জমার ঝুঁকি                 |

### ১.৭ TaskFlow এর সিদ্ধান্ত

- **Comment, task, assignment এর সব event outbox দিয়ে।** প্রতিটা write route এর transaction এ `outbox_events` এ একটা row। একটা polling relay (`SKIP LOCKED`, partial index, batch ~২০), পরে দরকার হলে `NOTIFY` দিয়ে জাগানো। পাঠানো row ৭ দিন পরে মোছা।
- **Consumer সব idempotent** - `eventId` বা effect এর key দিয়ে (7.4)।
- **Task complete এর ছয়টা কাজ:** notification, analytics, billing usage, webhook, sprint progress - `task.completed` এর consumer (choreography)। Parent auto-close - task service এর ভেতরে, একই transaction এ (ব্যবসার নিয়ম, আর event এর চেইন এড়াতে)।
- **কে কী শোনে তার একটা তালিকা** - একটা document বা একটা `events/` folder এ প্রতিটা event এর schema আর তার consumer দের নাম। Choreography এর অদৃশ্যতার সবচেয়ে সস্তা ওষুধ।
- **7.3 এর BullMQ job গুলো?** Email পাঠানোর job ও একটা "command" - আর সেটাও dual write (commit + `queue.add`)। একই সমাধান: notification consumer event পড়ে job যোগ করে (consumer এর দিকে idempotent, job ID দিয়ে), অথবা job কেও outbox থেকে তোলা। মূল নিয়ম: **database এর বাইরে যা যায়, সেটা database এর commit থেকে জন্মায়।**

---

## ২. Interview Angle

**"Order তৈরি হলে একটা event পাঠাতে হবে - কীভাবে?"** - এটা প্রায় সবসময় dual write এর পরীক্ষা। দুর্বল উত্তর: "save করে Kafka তে publish করব।" ভালো উত্তর নিজে থেকে প্রশ্নটা তোলে: "save আর publish এর মাঝে crash হলে? উল্টো ক্রমে? - তাই transactional outbox: একই transaction এ outbox row, relay বা CDC পাঠায়, at-least-once, তাই consumer idempotent।" বোনাস: polling বনাম CDC এর trade-off, আর outbox এর id-ক্রম বনাম commit-ক্রমের ফাঁদ।

**"Microservice গুলো কীভাবে কথা বলবে - synchronous call নাকি event?"** - "নির্ভর করে" এর পরে একটা নিয়ম দিন: caller এর উত্তরের জন্য দরকার আর মূল কাজের অংশ → synchronous (বা orchestration); পার্শ্ব-প্রতিক্রিয়া, অনেক শ্রোতা, স্বাধীনভাবে ব্যর্থ হতে পারে → event। তারপর event এর দাম বলুন, নিজে থেকে: অদৃশ্য flow, eventual consistency, schema চুক্তি, debug। যে candidate শুধু সুবিধা বলে, interviewer তাকে পরের প্রশ্নে দাম জিজ্ঞেস করে।

**"Event এ কী রাখবেন?"** - notification বনাম event-carried state, কেন মাঝামাঝি; স্থির event ID, occurredAt, version, key; additive বদল।

**Production এ বাস্তবে:** Outbox এর সবচেয়ে পরিচিত ব্যর্থতাগুলো: relay মরে আছে আর কেউ জানে না (outbox এর না-পাঠানো row এর সংখ্যা আর সবচেয়ে পুরনোটার বয়সে alert - 7.1 এর queue এর metric এর মতোই); outbox কখনো পরিষ্কার হয় না আর table বিশাল; CDC এর replication slot আটকে গিয়ে primary এর disk ভরে যাওয়া; আর সবচেয়ে সূক্ষ্ম - কেউ একটা "ছোট" route এ outbox ভুলে সরাসরি publish করে, আর dual write চুপচাপ ফিরে আসে। (কিছু team এর জন্য lint rule বা code review checklist এ "broker এ সরাসরি publish নিষেধ"।)

---

## ৩. Key Takeaway

- **Command** = "করুন" (একজন প্রাপক, প্রত্যাখ্যান করা যায়); **event** = "ঘটেছে" (তথ্য, প্রকাশক শ্রোতা জানে না) - নাম অতীত কালে, আর event এর ছদ্মবেশে command না
- **Choreography** producer এর coupling কমায়, নতুন consumer সস্তা, temporal decoupling দেয় - দাম অদৃশ্য flow, event এর চেইন, eventual consistency, কঠিন debug। পার্শ্ব-প্রতিক্রিয়া event এ, মূল কাজ আর জটিল সমন্বয় সরাসরি/orchestration এ
- Event এ কতটা data: **notification** (ছোট, কিন্তু ফিরে call), **event-carried state transfer** (consumer স্বাধীন, কিন্তু কপি আর বড় event), **event sourcing** (event ই source of truth - আলাদা বড় সিদ্ধান্ত)
- **Dual write** কোনো ক্রমে সারে না: commit-first এ ৪১টা event হারাল, publish-first এ ৪১টা ভুতুড়ে; Redis outage এ একটায় ৪৪৯ নীরবে হারাল, অন্যটায় ৫৩৪ জন comment ই করতে পারল না
- **Transactional outbox**: event row একই transaction এ, relay পরে পাঠায় - হারাল ০, ভুতুড়ে ০, broker বন্ধ থাকলেও feature চলে; দাম at-least-once (একই eventId এর duplicate - idempotent consumer লাগে) আর একটু দেরি
- Relay: `SKIP LOCKED`, partial index, ছোট batch, পরিষ্কার; **cursor না, flag** (id-ক্রম ≠ commit-ক্রম); polling এর বদলে **CDC** WAL থেকে commit-ক্রমে পড়ে, কিন্তু নতুন system চালাতে হয়
- Event এর চুক্তি: স্থির eventId, occurredAt, version, key; শুধু যোগ করে বদলান; consumer parse করে, অজানা হলে DLQ; secret কখনো না

---

## ৪. নতুন Term (Glossary)

| Term                             | অর্থ                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Command**                      | একজন নির্দিষ্ট প্রাপককে একটা কাজ করতে বলা - প্রাপক করতে বা প্রত্যাখ্যান করতে পারে; নাম আদেশসূচক                        |
| **Event**                        | ইতিমধ্যে ঘটে যাওয়া ঘটনার খবর - একটা তথ্য; প্রকাশক জানে না কে শুনছে; নাম অতীত কালে                                     |
| **Choreography**                 | কেন্দ্রীয় নির্দেশদাতা ছাড়া, প্রতিটা service event শুনে নিজের অংশ করে - orchestration এর বিপরীত                       |
| **Event-carried State Transfer** | Event এর সাথেই consumer দের দরকারি data পাঠানো, যাতে তারা producer কে ফিরে জিজ্ঞেস না করে                              |
| **Dual Write**                   | একটা কাজে দুটো আলাদা system এ লেখা, ভাগ করা transaction ছাড়া - মাঝে ভাঙলে একটায় লেখা হয়, অন্যটায় না                |
| **Transactional Outbox**         | Event কে ব্যবসার data এর সাথে একই transaction এ একটা outbox table এ লেখা; relay পরে broker এ পাঠায়                    |
| **Change Data Capture (CDC)**    | Database এর নিজের পরিবর্তনের খাতা (WAL) পড়ে প্রতিটা পরিবর্তনকে event বানানো - commit এর ক্রমে, application code ছাড়া |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর `task.completed` event design করুন। Consumer: notification (assignee আর watcher দের email - তাদের নাম আর task এর title লাগে), analytics (project, সময়), billing (workspace, মাস), customer webhook (customer কে যা দেখানো যায়)। Event এ ঠিক কোন কোন field রাখবেন, কোনগুলো রাখবেন না - কেন? তিন মাস পরে product চাইল "কে complete করল" (`completedBy`) যোগ করতে, আর `projectId` এর নাম বদলে `boardId` - প্রতিটা বদল কীভাবে করবেন যাতে কোনো consumer না ভাঙে?
2. একজন teammate outbox বানিয়েছে, কিন্তু একটু আলাদাভাবে: relay শেষ পাঠানো outbox `id` একটা Redis key তে রাখে, আর প্রতিবার `SELECT … WHERE id > :last ORDER BY id LIMIT 100` দিয়ে পড়ে; পাঠানো row সাথে সাথে মুছে না, ৭ দিন পরে। আর throughput বাড়াতে relay চালায় তিনটা। অন্তত তিনটা আলাদা ভুল খুঁজে বের করুন - প্রতিটায় কী হারায় বা কী দুবার হয় - আর ঠিক করুন।
3. Choreography এর চেইন: TaskFlow এ তিনটা consumer আছে - (ক) "parent auto-close": সব subtask complete হলে parent কে complete করে (যেটা আবার `task.completed` ছাড়ে); (খ) "sprint auto-advance": sprint এর সব task complete হলে sprint বন্ধ করে পরের sprint খোলে, আর অসমাপ্ত task গুলো সরায় (`task.moved`); (গ) "recurring task": একটা recurring task complete হলে পরের সপ্তাহের কপি তৈরি করে (`task.created`)। একটা recurring subtask এর parent এর সব subtask complete হলে কী কী ঘটে, ক্রমে লিখুন। কোথায় বিপদ (লুপ, ক্রম, আংশিক ব্যর্থতা)? এই flow কি choreography তেই থাকবে, নাকি অন্য কিছু?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

```typescript
{
	eventId: 'uuid',                 // fixed, dedupe
	type: 'task.completed',
	version: 1,
	occurredAt: '2026-…',            // the moment of completion
	workspaceId: 12,                 // billing, and partition/tenancy
	projectId: 7,                    // analytics
	taskId: 42,                      // key (7.2)
	title: 'Release 2.1 notes',      // notification and webhooks - so they don't call back
	assigneeId: 9,
	watcherIds: [3, 5]               // notification - but if it's large, only IDs, not emails
}
```

রাখব না: user দের email address (notification service নিজের কাছে বা user service থেকে নেবে - email ব্যক্তিগত তথ্য, event log এ ছড়ানো উচিত না), task এর পুরো description (বড়, আর webhook এ সব customer এর দেখার মতো না - webhook এর জন্য আলাদা একটা বাইরের payload বানানো ভালো, অভ্যন্তরীণ event সরাসরি customer কে না), permission বা internal flag।

বদল: `completedBy` - optional field হিসেবে যোগ (`completedBy?: number`), `version` একই থাকতে পারে (additive বদল); পুরনো consumer উপেক্ষা করে, নতুন consumer না থাকলে সামলায়। `projectId` → `boardId` - নাম বদল ভাঙার মতো বদল। উপায়: কিছুদিন **দুটোই** পাঠান (`projectId` আর `boardId`, একই মান), consumer দের এক এক করে `boardId` তে সরান, সবাই সরলে (consumer তালিকা - ১.৭ - এখানে কাজে লাগে) `version: 2` এ `projectId` বাদ। কখনো এক deploy এ নাম বদলানো না।

**প্রশ্ন ২:**

1. **Cursor আর commit-ক্রম:** id ১০ এর transaction ধীর, id ১১ আগে commit; relay ১১ পাঠিয়ে cursor ১১ এ - ১০ কখনো পাঠানো হয় না। **Event হারায়**, নীরবে। ঠিক করা: cursor না, `publishedAt IS NULL` flag (exercise এর মতো) - অথবা CDC, যেটা commit-ক্রমে পড়ে।
2. **Cursor Redis এ, publish ও Redis এ, কিন্তু row Postgres এ:** relay publish করল, cursor update এর আগে মরল → আবার পাঠায় (duplicate - এটা at-least-once, মেনে নেওয়া যায়)। কিন্তু Redis এর data হারালে (7.3 এর ১.৮ - failover এ async replication) cursor পিছিয়ে যায় → পুরনো event আবার (বড় duplicate এর ঢেউ), বা cursor হারালে শূন্য থেকে - ৭ দিনের সব আবার। আর cursor আর publish দুটো আলাদা লেখা - আবার dual write, relay এর ভেতরে। ঠিক করা: "কী পাঠানো হয়েছে" এর চিহ্ন outbox row এর নিজের উপর, একই database এ।
3. **তিনটা relay, lock ছাড়া:** তিনজনই একই `WHERE id > :last` পড়ে একই row পাঠায় → প্রতিটা event তিনবার; আর তিনজনের cursor একে অপরকে overwrite করে। ঠিক করা: `FOR UPDATE SKIP LOCKED` (প্রতিটা row একজনের), অথবা একটাই relay (active-passive, lock দিয়ে leader - 6.1)। আর তিনটা relay এ প্রতি task এর ক্রম রক্ষা হয় না - একই task এর দুটো event দুটো relay তে পড়ে উল্টো ক্রমে যেতে পারে। Throughput আসলে দরকার হলে key দিয়ে ভাগ (`taskId % 3`)।
4. (বোনাস) ৭ দিন ধরে না মোছা হলে `id > :last` এর খোঁজ ঠিক আছে (index), কিন্তু flag পদ্ধতিতে গেলে partial index লাগবে (`WHERE publishedAt IS NULL`) - নইলে লাখ row এর উপর খোঁজ।

**প্রশ্ন ৩:** ক্রম (একটা সম্ভাব্য):

1. শেষ subtask S (recurring) complete → `task.completed(S)`
2. (গ) recurring: S এর পরের সপ্তাহের কপি S' তৈরি → `task.created(S')` - **একই parent এর নিচে?** তাহলে parent এর এখন একটা অসমাপ্ত subtask আছে
3. (ক) parent auto-close: `task.completed(S)` শুনে দেখে "সব subtask complete?" - ২ এর আগে দেখলে হ্যাঁ, পরে দেখলে না। **Race** - দুটো consumer একই event এ, কে আগে চলে তার উপর ফল নির্ভর করে
4. Parent complete হলে → `task.completed(parent)` → আবার (ক) (তার parent এর জন্য), (খ) sprint, (গ) যদি parent ও recurring…
5. (খ) sprint এর সব task complete → sprint বন্ধ, পরের sprint খোলে, অসমাপ্ত task সরায় → `task.moved(S')` - S' কি নতুন sprint এ যাবে? আর sprint বন্ধ হওয়ার পরে ২ এর `task.created` এলে (দেরিতে) S' কোন sprint এ?

বিপদ: **race** (একই event এ দুই consumer এর ফলাফল ক্রমের উপর নির্ভর), **চেইন/লুপ** (completed → created → … কেউ design করেনি এমন ক্রম; recurring parent হলে সপ্তাহে সপ্তাহে চেইন), **আংশিক ব্যর্থতা** (sprint বন্ধ হলো, task সরানো অর্ধেক হয়ে consumer মরল - কেউ পুরো flow এর মালিক না, তাই কেউ আবার শুরু বা ফিরিয়ে নেয় না), আর **অদৃশ্যতা** (কেউ একজায়গায় পড়ে বলতে পারে না কী হবে)।

সিদ্ধান্ত: এই flow ব্যবসার নিয়ম, ক্রম গুরুত্বপূর্ণ, আর এর একটা মালিক দরকার - choreography এর জায়গা না। Parent auto-close task service এর ভেতরে একই transaction এ (১.৭), sprint advance একটা স্পষ্ট **orchestrated** process (একটা "sprint close" command, একজন সমন্বয়কারী যে ধাপগুলো ক্রমে চালায়, ব্যর্থ হলে জানে কোথায় আছে - Lesson 9.3 এর saga)। Recurring কপি তৈরির নিয়ম পরিষ্কার করা (নতুন কপি parent এর বাইরে, বা parent এর "সব subtask" এর হিসাবে গোনা হয় না)। আর notification, analytics - এরা event এই থাকে; তারা কিছু বদলায় না, শুধু শোনে।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (Docker এ Postgres + Redis; writer আর relay আসলেই মাঝপথে `SIGKILL` হয়)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-7.5-outbox/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.5-outbox) - `docker compose up -d --wait && npm install`, তারপর `npm run scenario` (তিনটা mode পরপর, ~৪০ সেকেন্ড)। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`writer.ts` তিনটা mode এ comment তৈরি করে আর ঠিক দুই লেখার মাঝে নিজেকে `SIGKILL` করে; `relay.ts` outbox থেকে Redis Stream এ পাঠায় (`FOR UPDATE SKIP LOCKED`), আর সেও মাঝে মাঝে পাঠানো আর commit এর মাঝে মরে; `scenario.ts` মরা writer/relay এর জায়গায় নতুন চালায়, চাইলে Redis বন্ধ করে, আর শেষে Postgres এর comment আর stream এর event comment id ধরে মেলায়।

**সৎ নোট:** Sandbox এ Docker এর Postgres 17 আর Redis 8 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `npm run scenario` কয়েকবার - writer এর ৪১টা crash, `commit-first` এর ৪১ হারানো আর `publish-first` এর ৪১ ভুতুড়ে প্রতিবার হুবহু একই (crash comment এর id থেকে ঠিক হয়); outbox এর বাড়তি event আর relay crash এর সংখ্যা run ভেদে বদলায় (এই মেশিনে বাড়তি ১০১–১৬০), কিন্তু হারাল ০, ভুতুড়ে ০, আর "আলাদা eventId = comment সংখ্যা" প্রতিবার। README এর experiment ১, ২, ৩ আর ৫ চালানো হয়েছে; ৪ হাতে আঁকার কাজ। CDC (Debezium) এখানে নেই - polling relay।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **ঘটনা ১–৩ মেলান:** `npm run scenario` চালান। TaskFlow এর তিনটা ঘটনার প্রতিটা তুলনা table এর কোন ঘরে? তারপর experiment ১ (Redis outage) - `commit-first` এর ৪৪৯ আর `publish-first` এর ৫৩৪ - এক লাইনে প্রতিটার ক্ষতি user এর চোখে কেমন দেখায়।

2. **বাড়তি event কোথা থেকে:** outbox এর "বাড়তি" সংখ্যাটা relay crash এর সংখ্যা আর batch এর আকার দিয়ে মোটামুটি ব্যাখ্যা করুন (একটা crash এ গড়ে কতগুলো event আবার যায়?)। তারপর একটা ছোট consumer লিখুন (Redis `XREADGROUP`) যেটা `eventId` দিয়ে dedupe করে একটা `search_index` table এ লেখে - 7.4 এর কৌশল ৬ দিয়ে - আর দেখান table এ ঠিক ১৯৫৯টা row।

3. **ক্রমের ফাঁদ** (experiment ৪): একটা সময়ের রেখা আঁকুন - দুটো writer, id ১০ আর ১১, ১১ আগে commit - আর দেখান `publishedAt` flag পদ্ধতিতে কী হয় আর `id > cursor` পদ্ধতিতে কী হয়। তারপর: একই task এর দুটো comment (দুটো আলাদা transaction) কি উল্টো ক্রমে stream এ যেতে পারে? কখন?

4. **Batch আর relay** (experiment ৩): `RELAY_CRASH_RATE=0.05` দিয়ে batch ৫০ আর ৫ চালান, আর ০.৯৫^batch হিসাব করুন। TaskFlow এর relay এর batch কত রাখবেন, আর relay "আটকে আছে" সেটা কোন metric দেখে টের পাবেন?

5. **Design অংশ:** TaskFlow এর event এর তালিকা - অন্তত ছয়টা (`comment.created`, `task.created`, `task.assigned`, `task.completed`, `task.moved`, `member.invited` …)। প্রতিটার জন্য: schema (field সহ), key, কোন কোন consumer আর তারা কী করে, আর কোন route এর কোন transaction এ outbox row লেখা হয়। তারপর প্রশ্ন ৩ এর মতো একটা চেইন খুঁজুন আপনার তালিকায় - আছে কি? থাকলে সেটা কীভাবে সামলাবেন?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (সম্পূর্ণ, exit challenge সহ), 7.1, 7.2, 7.3, 7.4
Current: 7.5 - Event-Driven Architecture basics
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; সব write route এর transaction এ outbox_events row → polling
relay (SKIP LOCKED, partial index, ছোট batch, publishedAt flag, ৭ দিন পরে মোছা) → Redis
Streams; consumer সব idempotent (eventId/effect key); task.completed এর পার্শ্ব-প্রতিক্রিয়া
choreography তে (notification, analytics, billing, webhook, sprint progress), parent
auto-close task service এর ভেতরে; event schema: eventId, type (অতীত কাল), version,
occurredAt, key - additive বদল; BullMQ job (7.3/7.4) event এর consumer থেকে জন্মায়
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking, Job State, Delayed Job, Job Lock, Stalled Job,
Exponential Backoff, Job ID Deduplication, AOF, Idempotent Consumer, Retry Storm, Jitter,
Poison Message, Dead Letter Queue, Backpressure, Load Shedding, Command, Event,
Choreography, Event-carried State Transfer, Dual Write, Transactional Outbox, Change Data
Capture
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 7.6 - Batch vs Stream, OLTP vs OLAP
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠান - বিশেষ করে ২ নম্বরের dedupe করা consumer আর ৫ নম্বরের event এর তালিকা। রেডি হলে `next` লিখুন - Lesson 7.6 এ যাব: **Batch vs Stream, OLTP vs OLAP - কখন কোন পথ।** আজ TaskFlow এর প্রতিটা পরিবর্তন একটা event হয়ে stream এ যাচ্ছে। Analytics team এখন সেই stream থেকে "কোন project এ এই সপ্তাহে কত task complete হলো" এর dashboard চায় - আর finance চায় গত বছরের প্রতিটা workspace এর মাসিক ব্যবহার। প্রথমটা কি প্রতিটা event আসার সাথে সাথে হিসাব করবে (stream), নাকি রাতে একবার পুরো দিনের (batch)? আর দ্বিতীয় প্রশ্নটা TaskFlow এর production Postgres এ চালালে কী হয় - কেন "সব data আছে" এমন database টাই এই প্রশ্নের জন্য ভুল জায়গা? Module 7 এর শেষ lesson।
