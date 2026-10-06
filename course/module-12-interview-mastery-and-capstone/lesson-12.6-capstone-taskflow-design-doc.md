# Lesson 12.6 — Capstone: TaskFlow Complete Design Doc

**Module 12 — Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 5.5):** Lost update কী? আর Postgres এর default isolation level (READ COMMITTED) কি এটা আটকায়? যদি না আটকায়, কোন level ধরে, আর ধরলে application কে কী করতে হয়? আজকের core piece এর প্রথম পরীক্ষা ঠিক এই প্রশ্নের, ৫০ জন একসাথে।

**Prerequisite:** পুরো course। বিশেষ করে Lesson 1.2 (framework), 2.5 (Idempotency-Key), 5.5 (Lost update), 7.4 আর 7.5 (Retry, outbox), 9.1 (Modular monolith), 10.3 (Failure), 10.7 (খরচ), 10.8 (Multi-region), 12.2 (Estimation), 12.5 (Story bank)

**আপনি এই lesson শেষে পারবেন:**

1. একটা system এর পুরো design doc লিখতে পারবেন, যেভাবে একটা আসল team এর design review তে যায়: লক্ষ্য আর non-goal, estimation, architecture, schema, scaling plan এর trigger, failure mode এর টেবিল, খরচ, বাতিল করা বিকল্প, আর খোলা প্রশ্ন
2. Doc এর একটা core piece (TaskFlow এর task এর write path) আসল code এ বানিয়ে মেপে দেখাতে পারবেন যে doc এর দাবিগুলো সত্যি: concurrent edit এ কিছু চুপচাপ হারায় না, retry এ duplicate নেই, crash এ email হারায় না বা ভূতুড়ে email যায় না
3. এগারো module এর সিদ্ধান্তগুলোকে একটা সুসংগত গল্পে বাঁধতে পারবেন, যেটা 12.5 এর story bank এর সবচেয়ে শক্ত গল্প

**Tier:** 1 — Runnable Code (core piece: Docker এ Postgres + Redis, Express + Sequelize + Zod + BullMQ; পাঁচটা script, আসল HTTP)

---

## ০. TaskFlow এখন কোথায়

Module 1 এ TaskFlow ছিল একটা Express server আর একটা Postgres, ১০০ জন user। এগারো module পরে: CDN, gateway, দুটো BFF, একটা modular monolith আর আলাদা billing service, Postgres primary আর তিনটা replica, cache এর ring, outbox আর queue, observability, মুম্বাইয়ে DR, আর ফ্রাঙ্কফুর্টে একটা EU cell। প্রতিটা টুকরো এসেছিল একটা খারাপ সপ্তাহ থেকে: একটা outage, একটা হারানো edit, একটা বিল।

কিন্তু এই পুরো ছবিটা এখনও কোথাও **এক জায়গায় লেখা নেই।** নতুন একজন engineer যোগ দিলে তাকে এগারোটা postmortem পড়তে হবে। আর কেউ যদি জিজ্ঞেস করে "আগামী বছর তিন গুণ হলে কী ভাঙবে?", উত্তরটা কারো মাথায় আছে, কোনো পাতায় না।

আজ সেটা লিখব: TaskFlow এর একটা design doc, যেভাবে একটা team তার design review তে নিয়ে যায়। Curriculum বলেছিল scope আমরা একসাথে ঠিক করব। আপনি core piece হিসেবে বেছেছেন **task এর write path**: task তৈরি, move আর assign, আর assign হলে notification। TaskFlow এর সবচেয়ে কেন্দ্রীয় পথ, আর যেখানে course এর চারটা সবচেয়ে বড় শিক্ষা (lost update, idempotency, dual write, at-least-once) একসাথে আসে। Doc এর বাকিটা কাগজে। এই অংশটা আসল code এ, মাপা সংখ্যা সহ।

**Design Doc** — একটা প্রস্তাবিত (বা বর্তমান) নকশার লেখা রূপ, যা team এর review এর জন্য: কী সমস্যা, কী লক্ষ্য আর কী লক্ষ্য না, কী নকশা, কোন সংখ্যা থেকে, কী বিকল্প বাতিল হলো আর কেন, কী ভাঙতে পারে, কত খরচ, আর কী এখনও জানা নেই। এর কাজ code লেখার আগে ভুল ধরা, আর পরে "কেন এমন" এর উত্তর রেখে দেওয়া।

নিচের ১ নম্বর অংশটা নিজেই doc। আমি এটা সেভাবেই লিখছি যেভাবে একটা আসল review তে যেত।

---

## ১. Theory — TaskFlow Design Doc

```
শিরোনাম:   TaskFlow — system design, ২০২৬ সালের অবস্থা আর পরের ১২ মাসের পরিকল্পনা
অবস্থা:    Draft, review এর জন্য
তারিখ:     2026-10-06
পরিধি:     পুরো platform এর ছবি; core write path এর বিস্তারিত নকশা আর বাস্তবায়ন
```

### ১.১ প্রেক্ষাপট আর লক্ষ্য

TaskFlow একটা team task management app: workspace, board, column, task, comment, attachment, share link, notification, আর paid plan। Web (SvelteKit) আর mobile client।

**লক্ষ্য (পরের ১২ মাস):**

- আজকের ~৩ গুণ traffic সামলানো, নকশায় বড় বদল ছাড়া
- Board খোলার SLO: সফলতা 99.9%, আর ৩০ দিনে 99% board ৫০০ ms এর নিচে (10.4)
- কোনো লেখা চুপচাপ না হারানো: concurrent edit এ একজন জানবে যে সে হেরেছে, retry এ duplicate না, crash এ notification না হারানো বা ভূতুড়ে না
- DR: home region (সিঙ্গাপুর) হারালে RPO ~৫ s, RTO ~৪০ মিনিট; EU cell এ RTO ~২৭ মিনিট (10.8)
- EU customer এর সব ব্যক্তিগত data EU তে (10.8)

**Non-Goal** — যে জিনিসগুলো এই নকশা ইচ্ছা করে সমাধান **করছে না**, স্পষ্ট লেখা, যাতে review তে কেউ ধরে না নেয় যে এগুলো ঢাকা আছে, আর scope না বাড়ে। TaskFlow এর non-goal:

- Task এর description এ Google Docs এর মতো একসাথে লেখা (OT/CRDT)। একই task একই মুহূর্তে দুজনের বদল বিরল (১.৮ এ মাপা); conflict এ 409 যথেষ্ট।
- একাধিক region এ একসাথে লেখা (active-active)। 10.8 এর pilot এ দিনে ~২,০০০ edit চুপচাপ হারিয়েছিল; সব লেখা এক region এ।
- Microservices এ পুরো ভাঙা। Modular monolith থাকছে (9.1); বের হয়েছে শুধু billing আর files processing।

### ১.২ Estimation

আগের lesson গুলোর মাপা সংখ্যা থেকে, 12.2 এর chain এ। যেখানে সংখ্যাটা ধরে নেওয়া, সেটা লেখা আছে।

```
আজ:          গড়ে ~৩০০ req/s (10.4) → দিনে ~২.৬ কোটি request
             লেখা ~১০% (10.8) → গড়ে ~৩০ write/s; peak × ৩ → ~৯০ write/s, ~৯০০ req/s
১২ মাসে ×৩:  peak ~২,৭০০ req/s, ~২৭০ write/s, ~২,৪৩০ read/s
Outbox:      প্রতি লেখায় গড়ে ~১.৫টা event (ধরে নেওয়া) → আজ দিনে ~৩৯ লাখ, × ৫০০ B ≈ ২ GB/দিন; ৭ দিন রাখা → ~১৪ GB
Task এর row: লেখার ~২০% নতুন task (ধরে নেওয়া) → দিনে ~৫ লাখ × ~২ KB (index সহ) ≈ ১ GB/দিন → বছরে ~৩৮০ GB; ×৩ এ ~১.১ TB
Write path:  একটা laptop এ মাপা ~৭০০ move/s (১.৮, load), প্রতিটা: পড়া + conditional UPDATE + outbox INSERT, এক transaction এ
```

**"তাই":**

- **লেখার জন্য sharding এর প্রশ্ন নেই।** ১২ মাস পরের peak ~২৭০ write/s, আর একটা **laptop** এ Docker এর Postgres এই write path এ ~৭০০/s নেয়। Production এর database এর machine অনেক বড়, কিন্তু সেটা ধরে না নিয়েও laptop এ ~২.৬ গুণ headroom। (12.1 এর ভুল ৫ এর ওষুধ, এবার মাপা।)
- **Read এর চাপ replica আর cache এ:** ~২,৪৩০ read/s তিনটা replica আর board এর cache এ ভাগ, আর প্রতি AZ এ replica (10.7)।
- **Storage এর প্রশ্ন সময়ের, আকারের না:** task এর table বছরে ~১ TB এর দিকে যেতে পারে। সমস্যা query না (index আছে), সমস্যা **backup থেকে ফেরার সময়**: RTO ৪০ মিনিটের মধ্যে কত TB ফেরানো যায়? তাই activity আর outbox এর মতো বড়, পুরনো, কম পড়া data আলাদা রাখা (১.৫)।
- **Outbox ছোট থাকে** যদি নিয়মিত মোছা হয় (৭ দিন): ~১৪ GB। না মুছলে বছরে ~৭০০ GB, আর relay এর partial index বাঁচালেও vacuum আর backup কষ্ট পায়।

### ১.৩ Architecture

```
        [web (SvelteKit)]   [mobile]
               │                │
               ▼                ▼
          [CDN: static, image, share page, TLS এর শেষ (10.8)]
                         │
                         ▼
          [API gateway: JWT যাচাই, rate limit দুই স্তরে, request id (9.2, 9.5, 10.5)]
               │                          │
               ▼                          ▼
        [web BFF (SvelteKit server)]  [mobile BFF]
               │                          │
               └────────────┬─────────────┘
                            ▼
   [modular monolith: work · identity · files · search]  ──REST + breaker + bulkhead──►  [billing service (নিজের DB)]
        │            │              │
        │            │              └──► [Redis: cache ring (১৬০ vnode)]   [Redis: limiter]
        │            ▼
        │   [Postgres primary] ──async──► [replica × ৩, প্রতি AZ এ] ──async──► [মুম্বাই: DR replica]
        │   (Patroni + etcd)
        │            │
        │            └── outbox_events ──relay (SKIP LOCKED)──► [Redis Streams] ──► consumer ──► [BullMQ: email, webhook, …]
        │
        └──► [S3: attachment (presigned, multipart), lifecycle] ──► [CDN signed URL]
             [files processing service: thumbnail, scan]

   সবখানে: OpenTelemetry trace, structured log, burn rate alert (10.4)
   EU cell (ফ্রাঙ্কফুর্ট): একই stack, EU এর workspace এর সব data; global স্তর শুধু routing আর billing (10.8)
```

তিনটা নকশার নীতি যা পুরো ছবি জুড়ে চলে:

- **সত্যের এক জায়গা, প্রতিটা জিনিসের জন্য।** Task আর তার event: primary Postgres, একই transaction। Cache, replica, search, Streams: সব derived, হারালে আবার বানানো যায়।
- **User অপেক্ষা করছে → synchronous, বাকি সব → event।** Task এর লেখা synchronous; notification, analytics, webhook, search এর index, billing এর usage: outbox থেকে (7.5)।
- **প্রতিটা dependency হয় hard নয়তো soft, লেখা।** Board খোলার জন্য billing আর replica soft (10.3)। Soft dependency মরলে feature লুকায়, page না।

### ১.৪ Data model

মূল table, শুধু যা সিদ্ধান্তে কাজে লাগে:

```
workspaces(id, region, plan, created_at)                         -- region = home cell (10.8)
users(id, email_hash, …)                                         -- email এর hash দিয়ে cell এ routing
memberships(workspace_id, user_id, role, PK(workspace_id, user_id))
boards(id, workspace_id, name, share_slug UNIQUE NULL)
tasks(id, board_id, workspace_id, title, column, position, assignee_id NULL,
      version, created_at, updated_at)
      INDEX (board_id, column, position)                          -- board খোলা
      INDEX (assignee_id) WHERE assignee_id IS NOT NULL           -- "আমার task"
comments(id, task_id, author_id, body, created_at)
idempotency_keys(key PK, request_hash, status_code, response_body, created_at)   -- ২৪ ঘণ্টা পরে মোছা
outbox_events(id BIGSERIAL, event_id UUID UNIQUE, type, task_id, payload JSONB,
              created_at, published_at NULL)
      INDEX (id) WHERE published_at IS NULL                       -- relay শুধু এটা দেখে
notifications(event_id PK, task_id, recipient_id, status, created_at)           -- consumer এর dedupe
activity(…) PARTITION BY RANGE (created_at), মাসে একটা; ৯০ দিনের পরে Parquet এ S3 (10.7)
sagas(id, type, state, …)                                         -- task তৈরির billing saga (9.3)
```

চারটা সিদ্ধান্ত, প্রতিটা একটা আগের lesson থেকে:

- **`tasks.version`:** প্রতিটা update `WHERE id = ? AND version = ?`, আর বদলে `version + 1`। মিললে না, 409 আর বর্তমান অবস্থা (5.5 এর optimistic lock)।
- **`tasks.workspace_id` denormalized:** board থেকে বের করা যায়, কিন্তু প্রতিটা authorization check আর ভবিষ্যতের shard key এর জন্য সরাসরি রাখা (5.2, 10.5 এর BOLA)।
- **Sequential id বাইরে দেখানো হয় না** যেখানে enumeration ঝুঁকি (share link এ ৮ অক্ষরের slug, 10.2); ভেতরের id integer, কারণ index ছোট আর দ্রুত।
- **`idempotency_keys` এ পুরো response:** retry এ একই উত্তর, একই status (2.5)। Key এর সাথে request এর hash, যাতে একই key অন্য request এ ব্যবহার হলে 422।

### ১.৫ Scaling plan: trigger দিয়ে, তারিখ দিয়ে না

**Scaling Trigger** — একটা মাপা সংখ্যা যেটা একটা সীমা পার হলে একটা নির্দিষ্ট নকশার বদল শুরু হয়, আগে থেকে লেখা। "পরের বছর shard করব" না, "sustained write peak এ primary এর CPU ৬০% পার হলে, বা ... হলে"। এতে বদল আসে প্রয়োজনে, আগে না (খরচ, জটিলতা) আর দেরিতে না (outage)।

| ধাপ | Trigger (মাপা)                                                                                       | বদল                                                                                        | কেন এই ক্রমে                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| ০   | আজ                                                                                                   | Primary + ৩ replica, cache ring, autoscale (৬০%, min ৩, max ৪০)                            | ১.২: লেখা ~৯০/s, laptop এও ~৭০০/s                                   |
| ১   | Replica এর CPU peak এ ৬০% এর বেশি এক সপ্তাহ                                                          | আরেকটা replica (প্রতি AZ এ), board এর cache এর TTL পর্যালোচনা                              | সবচেয়ে সস্তা, কোনো code বদল নেই                                    |
| ২   | Primary এর write p99 SLO এর অর্ধেকের বেশি peak এ, বা database এর আকার এমন যে restore > RTO এর অর্ধেক | বড় machine (vertical); activity আর outbox আলাদা database এ                                | Vertical আগে (1.6): এক দিনের কাজ; আলাদা করা ছোট আর restore দ্রুত    |
| ৩   | একটা workspace একাই primary এর লেখার ১০% এর বেশি, বা অন্যদের p99 ধীর করে                             | সেই workspace কে নিজের cell এ (10.8 এর cell এর পথ, একই code)                               | Hash sharding এর আগে: cell ইতিমধ্যে আছে, আর বড় tenant ই সাধারণ চাপ |
| ৪   | ধাপ ২-৩ এর পরেও primary এর সীমা, বা একটা region এ cell এর সংখ্যা বেশি হয়ে যায়                      | Workspace ধরে cell এর ভেতরে আরও cell — মানে workspace_id ই shard key, routing global স্তরে | সব query workspace এর ভেতরে, তাই cross-shard query প্রায় নেই       |

লক্ষ্য করুন: TaskFlow এর sharding এর পথ hash sharding না, **cell।** 10.8 এ EU এর জন্য যে cell বানানো হয়েছে, সেটাই বড় tenant এর জন্য, আর পরে সবার জন্য। একটা প্রক্রিয়া, তিনটা কারণ (residency, বড় tenant, আকার)। আর প্রতিটা trigger এর সংখ্যা একটা বিচার, যা production এর load test এ যাচাই করতে হবে (১.১০ এর খোলা প্রশ্ন)।

### ১.৬ Failure modes

**Failure Mode Table** — system এর প্রতিটা গুরুত্বপূর্ণ অংশের জন্য: কীভাবে ভাঙে, কীভাবে জানব, user কী দেখে, আর নকশা কী করে। Review তে সবচেয়ে বেশি প্রশ্ন এখানেই আসে, আর এর প্রতিটা সারি একটা পরীক্ষা যা CI বা game day তে চালানো উচিত (10.3)।

| অংশ                  | ভাঙে কীভাবে                 | জানব কীভাবে                             | User কী দেখে                            | নকশা কী করে                                                                     |
| -------------------- | --------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| Primary Postgres     | মরে                         | Patroni, health check                   | কয়েক সেকেন্ড লেখা ব্যর্থ, তারপর চলে    | Patroni failover; client এর retry Idempotency-Key সহ, তাই duplicate নেই         |
| Replica              | পিছিয়ে পড়ে (লেজ, 6.3)     | `replay_lag` এর p99 alert               | কিছুই না                                | User ধরে version token; replica মরলে board primary থেকে (৮ connection bulkhead) |
| Cache node           | মরে, বা ring এ যোগ (10.1)   | Miss এর হার, DB এর query/s              | একটু ধীর                                | ১৬০ vnode, ধীরে যোগ, single-flight                                              |
| Billing service      | ধীর বা বন্ধ                 | Breaker খোলা                            | Plan এর badge লুকানো; task তৈরি চলে     | Breaker + fallback (quota_pending, রাতের reconcile) (9.4)                       |
| Outbox relay         | আটকে যায়                   | সবচেয়ে পুরনো unpublished event এর বয়স | Notification দেরিতে                     | কয়েকটা relay, SKIP LOCKED; event হারায় না, শুধু দেরি                          |
| Notification worker  | পাঠানোর পরে মরে             | Job এর retry, DLQ এর আকার               | কিছুই না (১.৮: ১৫টা crash, ০ duplicate) | Consumer এ event id dedupe + provider এর idempotency key                        |
| দুজন একই task বদলায় | একই মুহূর্তে                | 409 এর হার (metric)                     | হেরে যাওয়া জন দেখে "এটা বদলে গেছে"     | Optimistic lock (১.৮: ৫০ জনে ১টা 200, ৪৯টা 409, ০ চুপচাপ হারানো)                |
| Flags service        | মরে (10.3)                  | Snapshot এর বয়স                        | কিছুই না                                | Code এ default + memory তে শেষ snapshot                                         |
| Home region          | ঘণ্টার পর ঘণ্টা বন্ধ (10.8) | Probe, provider এর status               | ~৪০ মিনিট বন্ধ, তারপর মুম্বাই থেকে      | Pilot light DR, এক বোতামে মানুষের সিদ্ধান্তে failover; RPO ~৫ s                 |
| Deploy               | চলমান request মরে (10.6)    | 5xx এর ঝাঁপ, canary gate                | কিছুই না                                | Readiness 503 → drain → close; canary; expand/contract migration                |
| Credential stuffing  | লাখ লাখ login চেষ্টা (10.5) | Login এর ব্যর্থতার হার, IP এর বৈচিত্র্য | আসল user প্রায় কিছুই না                | IP + email এর সীমা, breached password check, MFA                                |

### ১.৭ খরচ

আগের lesson গুলোর সংখ্যা যোগ করে:

```
মূল platform (10.7 এর পরে)           ~$৮,২৭৬/মাস
DR, মুম্বাই (pilot light, 10.8)       ~$৮৩৩/মাস
EU cell, ফ্রাঙ্কফুর্ট (10.8)          ~$৪,৮৭০/মাস
মোট                                    ~$১৩,৯৭৯/মাস
```

**পরের ১২ মাসে ×৩ traffic এ কী বাড়ে:** app এর instance (autoscale, মোটামুটি traffic এর সাথে রৈখিক), egress আর CDN (রৈখিক), log আর trace (sampling না থাকলে রৈখিকের চেয়ে বেশি, 10.4), storage (জমে, তাই সময়ের সাথে বাড়ে, traffic এর সাথে না)। যা প্রায় বাড়ে না: database এর primary (১.২ এর headroom; ধাপ ২ পর্যন্ত একই machine), DR (pilot light), cell এর স্থির অংশ। তাই মোট বিল তিন গুণ হওয়ার কথা না; ঠিক কত, সেটা 10.7 এর মতো line ধরে বের করতে হবে, আর এই doc এর একটা খোলা প্রশ্ন। প্রতিটা design review তে "মাসিক দাম আর তার চালক" এর একটা লাইন বাধ্যতামূলক (10.7)।

### ১.৮ Core piece: task এর write path

Doc এর এই অংশটা কাগজে না, code এ। নকশা:

```
 client ──POST /boards/:id/tasks (Idempotency-Key)──►  ┌─ এক transaction ──────────────────────────────────┐
 client ──PATCH /tasks/:id { version, … }───────────►  │ idempotency_keys: INSERT … ON CONFLICT DO NOTHING │
                                                        │ tasks: INSERT, বা UPDATE … WHERE version = ?      │
                                                        │ outbox_events: task.created / moved / assigned     │
                                                        │ idempotency_keys: পুরো response                    │
                                                        └───────────────────────────────────────────────────┘
                                                                         │
             relay: SELECT … FOR UPDATE SKIP LOCKED → queue.add(jobId = event_id) → published_at
                                                                         │
             worker: notifications INSERT … ON CONFLICT DO NOTHING → sent? থামুন → provider.send(key = event_id) → sent
```

**Spaced repetition এর উত্তর:** lost update মানে দুটো transaction একই মান পড়ে, নিজের হিসাবে বদলে লেখে, আর একজনের লেখা অন্যজনের লেখায় চুপচাপ মুছে যায় (5.5)। Postgres এর READ COMMITTED এটা আটকায় না। REPEATABLE READ (আর SERIALIZABLE) ধরে, `40001` error দিয়ে, আর তখন application কে পুরো transaction টা retry করতে হয়। আমরা অন্য পথ নিয়েছি: READ COMMITTED এ থেকে application এর স্তরে optimistic lock (`version`), কারণ এখানে conflict এ **retry না, user কে জানানো** ঠিক আচরণ: দুজন একই task কে দুজন আলাদা মানুষকে assign করলে, system নিজে "আবার চেষ্টা" করে দ্বিতীয়জনকে জিতিয়ে দিলে সেটাও একটা চুপচাপ সিদ্ধান্ত।

`npm run concurrency` — ৫০ জন একই মুহূর্তে একই task assign করে, প্রত্যেকে আলাদা মানুষকে:

```
strategy                                   200   409  silently lost  emails  to the wrong person
read, then write (no version check)         50     0             49      50                   49
optimistic lock (WHERE version = ?)          1    49              0       1                    0
```

Read-then-write এ ৫০ জনই "সফল" দেখে, ৪৯ জনের পছন্দ টেকে না, আর ৪৯টা email যায় এমন মানুষের কাছে যাকে task টা আসলে দেওয়া হয়নি: প্রতিটা request নিজের পড়া পুরনো অবস্থা থেকে event বানিয়েছিল। এটা lost update এর দ্বিতীয় ক্ষতি, যা 5.5 এ দেখা যায়নি: **ভুল data থেকে বের হওয়া side effect।** Optimistic lock এ একজন জেতে আর ৪৯ জন জানে যে হেরেছে। আর সাধারণ দিনে এর দাম প্রায় শূন্য: `load` এ ২০টা client নিজের task বদলায়, ৭,৫৫২টা move এ ০টা conflict।

`npm run idempotency` — ১,০০০টা task তৈরি, ১০% response ফেরার পথে হারায় (timeout), client আবার পাঠায়:

```
client                                    requests   tasks  duplicates  replayed
retry without a key                          1,104   1,104         104         0
retry with the same Idempotency-Key          1,104   1,000           0       104

responses 201: 200/200 · replayed: 100 · tasks in the database: 100
```

দ্বিতীয় অংশটা সূক্ষ্ম: retry টা প্রথম request শেষ হওয়ার **আগেই** এসেছে, ১০০ জোড়া। কোনো "in progress" অবস্থা ছাড়াই শূন্য duplicate, কারণ দ্বিতীয় request এর `INSERT ... ON CONFLICT DO NOTHING` Postgres এর unique index এ প্রথমটার commit এর জন্য অপেক্ষা করে, তারপর তার commit করা উত্তরটা পড়ে ফেরত দেয়। Key আর task আর উত্তর এক transaction এ, তাই অর্ধেক অবস্থা কখনো দেখা যায় না।

`npm run crash` — ১,০০০টা assign, ঝুঁকির মুহূর্তের ২% এ crash:

```
write order                          tasks  emails  no email  email, no task  crashes
commit, then enqueue                 1,000     970        30               0       30
enqueue, then commit                   970   1,000         0              30       30
outbox in the same transaction       1,000   1,000         0               0       30
outbox, on top of the relay crashes: 15 worker crashes after sending the email; provider calls 1,015 for 1,000 emails
```

7.5 এর শিক্ষা, এবার TaskFlow এর আসল route এ: ক্রম বদলালে ক্ষতির ধরন বদলায়, ক্ষতি যায় না। আগে commit করলে ৩০ জন জানে না যে তাকে task দেওয়া হয়েছে; আগে queue করলে ৩০ জন এমন task এর email পায় যা নেই। Outbox এ দুটোই শূন্য। আর at-least-once এর দাম দেখা যায় শেষ লাইনে: relay আর worker দুটোই crash করে আবার চালিয়েছে, provider এ ১,০১৫টা call গেছে, কিন্তু email ঠিক ১,০০০টা, কারণ প্রতিটা স্তরে event এর id দিয়ে idempotency: consumer এ `notifications` এর primary key, provider এ idempotency key। Experiment এ crash ১০% করলে প্রথম দুই সারিতে ১০৮ করে, outbox এ এখনও শূন্য।

`npm run smoke` সবকিছু আসল HTTP এ একসাথে চালায়, ১১টা ধাপ: idempotent তৈরি, replay, একই key এ অন্য body তে 422, move, পুরনো version এ 409, assign, relay আর worker এর crash, আর শেষে ঠিক একটা email আর শূন্য unpublished event। আর `load` doc এর ১.২ এর সংখ্যাটা দেয়: এই laptop এ ~৭০০ move/s, p50 ~২৫ ms, p99 ~৫৭ ms।

**Doc আর code এর পার্থক্য, সৎভাবে:** production এর নকশায় outbox যায় Redis Streams এ, আর notification এর consumer সেখান থেকে BullMQ job বানায় (7.5)। Exercise এ relay সরাসরি BullMQ তে পাঠায়, একটা স্তর কম, কারণ প্রশ্নটা (লেখা আর পাঠানো একসাথে) দুটোতেই এক। Authorization, rate limit, saga আর trace exercise এ নেই।

### ১.৯ বাতিল করা বিকল্প

**Alternatives Considered** — doc এর যে অংশে প্রতিটা বড় সিদ্ধান্তের জন্য যে বিকল্পগুলো ভাবা হয়েছিল আর **কেন নেওয়া হয়নি** লেখা থাকে। এটা review তে "X কেন না?" এর আগাম উত্তর, আর দুই বছর পরে কেউ একই বিকল্প প্রস্তাব করলে, কোন শর্ত বদলালে সেটা আবার ভাবা উচিত তার রেকর্ড।

| বিকল্প                                   | কেন না, এখন                                                                     | কখন আবার ভাবব                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| পুরো microservices                       | Team এর আকার আর সীমানা এখনও স্থির না; distributed transaction এর দাম (9.1, 9.3) | একটা module এর deploy এর ছন্দ আর team বাকিদের থেকে আলাদা হলে     |
| Active-active লেখা, একাধিক region এ      | 10.8 এর pilot এ দিনে ~২,০০০ edit চুপচাপ হারানো                                  | Latency এর দাবি home region থেকে মেটানো না গেলে, CRDT এর মডেল সহ |
| Kafka                                    | ~৯০ event/s এ Redis Streams যথেষ্ট; আরেকটা cluster চালানোর খরচ (7.2)            | Replay এর দীর্ঘ ইতিহাস আর অনেক স্বাধীন consumer লাগলে            |
| আজই hash sharding                        | ১.২: লেখার headroom আছে; cross-shard query আর migration এর দাম                  | ১.৫ এর ধাপ ৪, cell এর পথে                                        |
| Pessimistic lock (`SELECT … FOR UPDATE`) | User এর ভাবার সময় জুড়ে lock ধরা যায় না; HTTP এর দুই request এ lock অর্থহীন   | একটা ছোট, server এর ভেতরের read-modify-write এ (যেমন counter)    |
| Description এ CRDT                       | Non-goal; একসাথে লেখা বিরল                                                      | User এর গবেষণায় একসাথে লেখার চাহিদা দেখা গেলে                   |

### ১.১০ ঝুঁকি আর খোলা প্রশ্ন

- **Trigger এর সংখ্যাগুলো মাপা না।** ১.৫ এর ৬০%, ১০%, "RTO এর অর্ধেক" বিচার থেকে। Production এর hardware এ একটা load test আর একটা restore এর মহড়া (backup থেকে পুরো database ফেরাতে কত মিনিট) দরকার।
- **১.২ এর দুটো ধরে নেওয়া সংখ্যা** (লেখা প্রতি ১.৫ event, লেখার ২০% নতুন task) production এর metric থেকে যাচাই করতে হবে। দুটোই storage আর outbox এর আকার বদলায়, নকশা না।
- **×৩ এ মোট বিল কত:** line ধরে মডেল দরকার (১.৭)।
- **Idempotency key এর মেয়াদ:** ২৪ ঘণ্টা ধরা হয়েছে। Mobile client offline থেকে এক দিনের বেশি পরে retry করলে duplicate সম্ভব। Mobile এর offline queue এর আচরণ জেনে ঠিক করতে হবে।
- **409 এর UI:** হেরে যাওয়া user কী দেখে, আর কী করতে পারে ("বর্তমান অবস্থা দেখুন, আবার চেষ্টা করুন")। Product এর সাথে সিদ্ধান্ত।

**Rollout:** core write path এর বদলগুলো (version column, idempotency, outbox) expand/contract এ (10.6): আগে column আর table যোগ, তারপর code দুটোই চালায় flag এর পেছনে, canary তে ১% workspace, 409 আর duplicate এর metric দেখে বাড়ানো, শেষে পুরনো পথ মোছা।

---

## ২. Interview Angle

এই doc টা interview এ তিনভাবে কাজে লাগে:

- **12.5 এর প্রশ্নে:** "একটা system এর কথা বলুন যেটা আপনি design করেছেন"। এখন আপনার কাছে একটা পুরো design doc আর একটা মাপা core piece আছে, learning project হিসেবে, সেই নামে বলা (12.5 এর ১.৬)। ৫ মিনিটের গল্প: write path, ৫০ জনের lost update আর ৪৯টা ভুল email, optimistic lock, আর crash এর তিনটা ক্রম।
- **Design round এ:** প্রায় যেকোনো CRUD-ভারী system ("design Trello", "design Jira", "design a todo app at scale") এর মূল এই doc। আর follow-up গুলো ঠিক ১.৬ আর ১.৯ এর সারি: "primary মরলে?", "দুজন একসাথে বদলালে?", "Kafka কেন না?"
- **Senior এর signal:** scaling plan কে **trigger** দিয়ে বলা, তারিখ দিয়ে না; sharding এর পথ হিসেবে আগে থেকে থাকা cell কে ব্যবহার করা; আর non-goal আর খোলা প্রশ্ন নিজে থেকে বলা। একজন mid-level candidate একটা নকশা দেয়; একজন senior বলে নকশাটা কোথায় শেষ, কী এখনও জানা নেই, আর কোন সংখ্যা দেখে পরের ধাপে যাবে।

**Production এ বাস্তবে:** design doc এর আসল মূল্য review এর দিন না, দুই বছর পরে। কেউ জিজ্ঞেস করবে "আমরা hash sharding কেন করিনি?", আর ১.৯ এর সারিতে উত্তর আর আবার ভাবার শর্ত লেখা আছে। আর সবচেয়ে প্রচলিত ব্যর্থতা হলো doc টা লেখার পরে আর কখনো না ছোঁয়া: system বদলায়, doc থাকে আগের মতো, আর নতুন engineer ভুল ছবি শেখে। তাই প্রতিটা বড় বদলের সাথে doc এর সংশ্লিষ্ট অংশ আপডেট, বা একটা ছোট নতুন doc যা এটাকে উল্লেখ করে।

---

## ৩. Key Takeaway

- **Design doc এর কাজ code এর আগে ভুল ধরা আর পরে "কেন" রেখে দেওয়া:** লক্ষ্য, non-goal, estimation, architecture, schema, scaling trigger, failure mode, খরচ, বাতিল বিকল্প, খোলা প্রশ্ন
- **Non-goal আর খোলা প্রশ্ন লেখা থাকলে review সৎ হয়:** কী ঢাকা নেই আর কী জানা নেই, সেটা স্পষ্ট
- **Scaling এর পরিকল্পনা trigger দিয়ে, তারিখ দিয়ে না:** আগে replica, তারপর vertical আর বড় data আলাদা, তারপর বড় tenant নিজের cell এ, শেষে workspace ধরে cell — TaskFlow এর sharding এর পথ cell
- **মাপা সংখ্যা doc কে শক্ত করে:** laptop এই write path এ ~৭০০ move/s, ১২ মাস পরের peak ~২৭০ — তাই লেখার জন্য sharding এর প্রশ্ন নেই
- **Lost update এর দ্বিতীয় ক্ষতি ভুল side effect:** ৫০ জনে ৪৯ জনের পছন্দ চুপচাপ হারায় **আর** ৪৯টা email ভুল মানুষের কাছে; optimistic lock এ ১টা 200, ৪৯টা 409, ০ ভুল email
- **Idempotency-Key এক transaction এ:** ১০% হারানো response এ ১০৪টা duplicate থেকে শূন্য, একসাথে চলা জোড়াতেও — unique index এর অপেক্ষাই "in progress" এর অবস্থা
- **লেখা আর পাঠানো এক transaction এ, আর প্রতিটা স্তরে dedupe:** dual write এ ৩০টা হারানো বা ৩০টা ভূতুড়ে email, outbox এ শূন্য; ১,০১৫টা provider call এ ঠিক ১,০০০টা email

---

## ৪. নতুন Term (Glossary)

| Term                        | অর্থ                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design Doc**              | একটা নকশার লেখা রূপ, team এর review এর জন্য: সমস্যা, লক্ষ্য, non-goal, সংখ্যা, নকশা, বাতিল বিকল্প, ঝুঁকি, খরচ, খোলা প্রশ্ন — code এর আগে ভুল ধরা, পরে "কেন" রেখে দেওয়া |
| **Non-Goal**                | যা নকশা ইচ্ছা করে সমাধান করছে না, স্পষ্ট লেখা — review তে ভুল ধারণা আর scope এর বিস্তার আটকায়                                                                          |
| **Scaling Trigger**         | একটা মাপা সংখ্যা যা একটা সীমা পার হলে একটা নির্দিষ্ট নকশার বদল শুরু করে, আগে থেকে লেখা — বদল আসে প্রয়োজনে, আগেও না, দেরিতেও না                                         |
| **Failure Mode Table**      | প্রতিটা গুরুত্বপূর্ণ অংশের জন্য: কীভাবে ভাঙে, কীভাবে জানব, user কী দেখে, নকশা কী করে — প্রতিটা সারি CI বা game day এর একটা পরীক্ষা                                      |
| **Alternatives Considered** | প্রতিটা বড় সিদ্ধান্তে ভাবা বিকল্প, কেন নেওয়া হয়নি, আর কোন শর্ত বদলালে আবার ভাবা উচিত — "X কেন না?" এর আগাম উত্তর আর ভবিষ্যতের রেকর্ড                                 |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. Review তে একজন senior engineer বলল: "Optimistic lock এ 409 মানে user কে আবার করতে হবে। Task এর column বদলানো (move) একটা drag-and-drop, user এটা বারবার করে। দুজন একই board এ কাজ করলে 409 কি বিরক্তিকর হবে না?" (ক) কোন ক্ষেত্রে 409 দরকার আর কোনটায় না — move আর assign কি একই রকম? (খ) Move এর জন্য একটা বিকল্প নকশা বলুন, যেটা conflict কমায় কিন্তু কিছু চুপচাপ হারায় না। (গ) এই সিদ্ধান্তটা doc এর কোন অংশে যাবে?

2. ১.৫ এর ধাপ ৩: "একটা workspace একাই primary এর লেখার ১০% এর বেশি হলে নিজের cell এ।" (ক) এই trigger মাপতে কী metric লাগবে, আর 10.4 এর label cardinality এর সমস্যা এখানে কীভাবে আসে? (খ) একটা চলমান workspace কে home cell থেকে নতুন cell এ সরানোর ধাপগুলো কী, downtime ছাড়া বা কম downtime এ? (গ) সরানোর মাঝে outbox এ থাকা unpublished event গুলোর কী হবে?

3. `npm run crash` এর outbox এর সারিতে provider এ ১,০১৫টা call গেছে ১,০০০টা email এর জন্য। (ক) Provider যদি idempotency key **না** দিত, কতজন দুটো email পেত, আর কোন অবস্থায়? (খ) Worker এর ভেতরে কোন ক্রম বদলালে ("পাঠান, তারপর sent লিখুন" বনাম "sent লিখুন, তারপর পাঠান") কী হারায়? (গ) Provider এর idempotency key না থাকলে আপনি কোনটা বাছবেন, আর কেন — এটা কোন lesson এর কোন সিদ্ধান্তের মতো?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) Assign এ 409 দরকার: দুজন আলাদা মানুষকে task দেওয়া দুটো সাংঘর্ষিক সিদ্ধান্ত, আর একটা চুপচাপ জিতলে অন্যজন ভুল ধারণায় থাকে (আর ভুল email যায়, ১.৮)। Move আলাদা: দুজন একই task কে দুই column এ নিলে সেটা সংঘাত, কিন্তু **একই board এ দুটো আলাদা task** move করা সংঘাত না, অথচ দুটোই `position` বদলাতে পারে। যদি position গুলো ঘন integer (১, ২, ৩ ...) হয় আর একটা move পাশের সবার position বদলায়, তাহলে আলাদা task এর move ও একে অপরের সাথে লাগে — সেখানেই বিরক্তিকর 409 আসে।

(খ) **Fractional position:** প্রতিটা task এর position দুটো প্রতিবেশীর মাঝের একটা সংখ্যা (বা string, lexicographic), তাই একটা move শুধু ওই task এর row বদলায়, অন্য কারো না। তখন আলাদা task এর move কখনো একে অপরের version ছোঁয় না, আর 409 আসে শুধু যখন সত্যিই একই task দুজন একসাথে বদলায়। দাম: মাঝে মাঝে দুটো প্রতিবেশীর মাঝে জায়গা ফুরায় (সংখ্যার নির্ভুলতা বা string এর দৈর্ঘ্য), তখন একটা column এর position গুলো আবার সাজানো (rebalance) — একটা বিরল, background কাজ। আরেকটা সূক্ষ্ম পথ: field ধরে version (column এর জন্য একটা, assignee এর জন্য আরেকটা), যাতে একজনের move আর আরেকজনের assign একে অপরকে আটকায় না।

(গ) দুই জায়গায়: ১.৪ এর data model (position এর ধরন আর `version` এর নিয়ম), আর ১.৯ এর বাতিল বিকল্প (ঘন integer position, কেন না)। আর ১.১০ এ একটা খোলা প্রশ্ন: rebalance কত ঘন ঘন লাগবে, মাপতে হবে।

**প্রশ্ন ২:**

(ক) প্রতি workspace এর লেখার হার। কিন্তু `workspace_id` কে Prometheus এর metric এর label বানালে হাজার হাজার workspace মানে হাজার হাজার series (10.4 এর cardinality এর বিস্ফোরণ)। পথ: metric এ label না, বরং (১) সবচেয়ে বড় N টা workspace এর জন্য আলাদা ভাবে গোনা (top-K, 10.2 এর count-min sketch এর মতো একটা কাঠামো দিয়ে), বা (২) log বা outbox এর event থেকে একটা ঘণ্টায় একবারের analytics query ("গত ঘণ্টায় workspace প্রতি লেখা, শীর্ষ ২০")। Trigger এর জন্য মিনিটের সূক্ষ্মতা লাগে না, ঘণ্টা যথেষ্ট।

(খ) একটা সম্ভাব্য ক্রম: (১) নতুন cell এ workspace এর data এর copy (snapshot, তারপর চলমান বদলের replication, logical replication বা outbox এর event দিয়ে); (২) পিছিয়ে থাকা কমতে কমতে কয়েক সেকেন্ডে নামলে workspace কে কিছুক্ষণের জন্য read-only (কয়েক সেকেন্ড থেকে এক মিনিট); (৩) শেষ বদলগুলো পৌঁছালে global স্তরের routing টেবিলে workspace → নতুন cell (10.8); (৪) read-only তোলা; (৫) পুরনো cell এ data কিছুদিন রেখে, তারপর মোছা। Downtime শূন্য না, কিন্তু শুধু লেখার জন্য আর ছোট — আর সেটা আগে থেকে customer কে জানানো।

(গ) সরানোর আগে পুরনো cell এ সেই workspace এর সব unpublished event পাঠানো শেষ হওয়া পর্যন্ত অপেক্ষা (read-only অবস্থায় নতুন event আসে না, তাই outbox খালি হবে)। তারপর নতুন cell এর relay দায়িত্ব নেয়। Consumer গুলো event id দিয়ে idempotent, তাই সীমানায় কোনো event দুবার গেলেও ক্ষতি নেই — ঠিক ১.৮ এর at-least-once এর নীতি।

**প্রশ্ন ৩:**

(ক) ১৫ জন, যাদের worker crash এর পরে retry হয়েছে: worker email পাঠিয়েছে, তারপর "sent" লেখার আগে crash, retry এ notification এর row `pending`, তাই আবার পাঠিয়েছে। Provider dedupe না করলে এই ১৫ জন দুটো email পেত। (Relay এর আবার পাঠানো job গুলো সাধারণত consumer এর dedupe এ থামে, কারণ ততক্ষণে row `sent`।)

(খ) "পাঠান, তারপর sent লিখুন" (আমাদের): মাঝে crash হলে retry এ আবার পাঠায় — **duplicate** সম্ভব, হারানো না। "Sent লিখুন, তারপর পাঠান": মাঝে crash হলে retry এ row `sent` দেখে থামে — email **হারায়**, duplicate না। প্রথমটা at-least-once, দ্বিতীয়টা at-most-once।

(গ) সাধারণত at-least-once (আমাদের ক্রম): একটা task এর assignment এর email দুবার পাওয়া বিরক্তিকর, না পাওয়া মানে কেউ কাজটা জানে না। কিন্তু এটা email এর ধরনের উপর নির্ভর করে: একটা OTP বা "আপনার card এ চার্জ হয়েছে" এর মতো email এর জন্য duplicate ও খারাপ, আর তখন provider এর idempotency key বা আগে থেকে একটা অনন্য message id প্রায় বাধ্যতামূলক। এটা 11.5 এর notification এর সিদ্ধান্তের মতো (failover এ duplicate বনাম হারানো), আর 11.7 এর payment এর "timeout মানে জানি না" এর একটা হালকা রূপ: বাইরের system এর সাথে exactly-once নেই, শুধু at-least-once আর dedupe।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (Docker এ Postgres + Redis; Express + Sequelize + Zod + BullMQ, আসল HTTP)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-12.6-capstone-taskflow/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-12.6-capstone-taskflow) — `docker compose up -d --wait`, `npm install`, তারপর `npm run smoke`, `npm run concurrency`, `npm run idempotency`, `npm run crash`, `npm run load`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`smoke` আসল HTTP এ write path এর ১১টা ধাপ চালায়। `concurrency` ৫০ জনের একসাথে assign এ read-then-write আর optimistic lock তুলনা করে। `idempotency` হারানো response আর retry মাপে, একসাথে চলা জোড়া সহ। `crash` তিনটা লেখার ক্রমে crash ঢোকায়। `load` এই write path এর throughput আর latency মাপে।

**সৎ নোট:** Sandbox এ Node 26 আর Docker (`postgres:17-alpine`, `redis:8-alpine`) এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; `smoke`, `concurrency`, `idempotency` আর `crash` দুবার করে, output byte ধরে হুবহু এক; `load` দুবার (৭১১ আর ৭৫৫ move/s — machine নির্ভর, laptop এ, Docker এর Postgres, ১০ connection এর pool)। README এর experiment ১ আর ২ চালানো হয়েছে, সংখ্যা উপরে। Crash হলো একটা simulated exception (relay এর transaction rollback, worker এর job retry), আসল `SIGKILL` না (7.5 এর exercise এ আসল crash ছিল); email provider fake। Design doc এর বাকি অংশ (১.১-১.৭, ১.৯-১.১০) কাগজে, আগের lesson গুলোর সংখ্যা থেকে; ১.২ এর দুটো সংখ্যা আর ১.৫ এর trigger এর সীমা ধরে নেওয়া, ১.১০ এ খোলা প্রশ্ন হিসেবে লেখা।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `crash` চালানোর **আগে** লিখে ফেলুন, ২% crash এ প্রথম দুটো সারির ক্ষতি কত হবে, আর outbox এ provider call কত হবে। তারপর চালিয়ে মেলান। Provider call এর সংখ্যা আপনার অনুমান থেকে আলাদা হলে, কেন?

2. **Code বদলানো — fractional position:** প্রশ্ন ১ এর (খ)। `position` কে দুটো প্রতিবেশীর মাঝের সংখ্যা বানান, আর `concurrency` এ একটা নতুন অংশ: ৫০ জন একই board এর ৫০টা **আলাদা** task একসাথে move করে। ঘন integer এ (যেখানে একটা move পাশেরগুলোর position বদলায়) কতগুলো 409, আর fractional এ কত?

3. **Code বদলানো — README এর experiment ৪ আর ৫:** 409 এ client এর retry, আর outbox এর পরিষ্কার এর job।

4. **নিজের doc:** এই lesson এর doc এর ছকে (১.১-১.১০) নিজের একটা system এর design doc লিখুন — 12.1 এর exercise এর প্রশ্ন, বা 12.5 এ বাছা project। অন্তত: দুটো non-goal, তিনটা "তাই" সহ estimation, তিন ধাপের scaling trigger, পাঁচ সারির failure mode এর টেবিল, তিনটা বাতিল বিকল্প, তিনটা খোলা প্রশ্ন।

5. **Doc টা বলুন:** এই lesson এর TaskFlow doc টা ১০ মিনিটে একজন কাল্পনিক reviewer কে বলুন, জোরে, recording সহ — 12.5 এর ২০ মিনিটের রূপের একটা অনুশীলন। তারপর ১.৬ আর ১.৯ থেকে তিনটা সারি বাছুন যেখানে আপনার মনে হয় reviewer সবচেয়ে বেশি চাপ দেবে, আর প্রতিটায় depth এর সিঁড়ি (12.5) চার স্তর লিখুন।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 11 (সম্পূর্ণ, exit challenge সহ), 12.1 – 12.5
Current: 12.6 — Capstone: TaskFlow Complete Design Doc (core piece: task এর write path, আপনার বাছাই)
TaskFlow state: পুরো ছবি একটা design doc এ — CDN, gateway, web/mobile BFF, modular monolith (work, identity, files,
search) + billing + files processing; Postgres primary + ৩ replica (Patroni), cache ring, limiter Redis; outbox → Redis
Streams → BullMQ; S3 + CDN; OpenTelemetry; মুম্বাইয়ে DR (RPO ~৫ s, RTO ~৪০ মি); ফ্রাঙ্কফুর্টে EU cell। আজ ~৩০০ req/s,
peak ~৯০ write/s; ১২ মাসে ×৩ → ~২৭০ write/s। বিল ~$১৩,৯৭৯/মাস (মূল + DR + EU cell)। Scaling trigger দিয়ে: replica →
vertical + বড় data আলাদা → বড় tenant নিজের cell এ → workspace ধরে cell। Core piece (মাপা): ৫০ জনের একসাথে assign এ
read-then-write ৪৯ চুপচাপ হারানো + ৪৯ ভুল email, optimistic lock ১টা 200 + ৪৯টা 409; Idempotency-Key এ ১০% হারানো
response এ ১০৪ duplicate → ০ (একসাথে চলা জোড়াতেও); ২% crash এ dual write ৩০ হারানো বা ৩০ ভূতুড়ে email, outbox ০;
১,০১৫ provider call এ ১,০০০ email; laptop এ ~৭০০ move/s।
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram, Content-Addressed Block, Content-Defined Chunking, Change Journal,
Namespace, Conflicted Copy, Dedupe Side Channel, Design Narrative, Impact Metric, Retrospective Insight, Depth Probe,
Ownership Signal, Story Bank, Design Doc, Non-Goal, Scaling Trigger, Failure Mode Table, Alternatives Considered
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: Module 12 Exit Challenge
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **এগারো module এর প্রতিটা সিদ্ধান্ত একটা খারাপ সপ্তাহ থেকে এসেছিল; design doc সেগুলোকে একটা ছবিতে বাঁধে, আর প্রতিটা ছবির পাশে তার কারণ, তার সংখ্যা, আর কোন শর্তে সে বদলাবে।** আর doc এর দাবি সবচেয়ে শক্ত হয় যখন তার একটা অংশ code এ মাপা: ৫০ জনে ৪৯টা ভুল email, ১০৪টা duplicate, ৩০টা হারানো notification — আর প্রতিটার পাশে শূন্য।

রেডি হলে `next` লিখুন — **Module 12 Exit Challenge,** পুরো course এর শেষ। সেখানে থাকবে একটা শেষ mock: একটা নতুন system, ৬০ মিনিট, কোনো script বা বন্ধ অংশের সাহায্য ছাড়া, যার follow-up গুলো এই module এর প্রতিটা lesson এর এক একটা দক্ষতা পরীক্ষা করে; পুরো course এর একটা self-check; আর এর পরে কী পড়বেন, কী বানাবেন, আর interview এর আগের সপ্তাহে কী করবেন।
