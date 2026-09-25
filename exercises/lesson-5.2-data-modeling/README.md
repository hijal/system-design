# TaskFlow Data Modeling — Normalization vs Denormalization

> Lesson 5.2 — Schema & Data Modeling · **Tier 1 — Runnable Code**

## কী বানাচ্ছি

একই TaskFlow data দুটো schema তে — একটা "সব এক table এ" (denormalized), আরেকটা normalized
(3NF) — আর তিনটা script যেগুলো **দাবি না করে মেপে দেখায়**:

| Script              | কী দেখায়                                                                  | Lesson § |
| ------------------- | -------------------------------------------------------------------------- | -------- |
| `npm run anomalies` | খারাপ schema তে update / delete anomaly আর 1NF ভাঙার ফল                    | ১.২–১.৩  |
| `npm run dashboard` | ৪ লাখ task এ "গুনে বের করা" vs "counter পড়া" — আর query ঠিক করার প্রভাব   | ১.৪      |
| `npm run counter`   | Denormalized counter কীভাবে ভুল হয় (race, ভুলে যাওয়া) আর কীভাবে ধরা যায় | ১.৫      |

## Prerequisite

Node.js 22+ এবং Docker (শুধু PostgreSQL চালানোর জন্য — script গুলো সাধারণ Node process
হিসেবে চলবে)।

Port **5434** ব্যবহার করা হয়েছে, যাতে তোমার মেশিনের Postgres (5432) বা Lesson 4.4 এর
exercise (5433) এর সাথে সংঘাত না লাগে।

## Setup

```bash
docker compose up -d --wait   # Postgres, healthy হওয়া পর্যন্ত অপেক্ষা করে
npm install
```

## Run

প্রতিটা script শুরুতে table গুলো নতুন করে বানায় (`sync({ force: true })`), তাই যেকোনো
ক্রমে, যতবার খুশি চালানো যায়:

```bash
npm run anomalies
npm run dashboard   # ৪ লাখ row seed করে — ১৫-২০ সেকেন্ড লাগতে পারে
npm run counter
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. `npm run anomalies`**

```
━━ Denormalized (bad_tasks) — সব এক table এ ━━━━━━━━━━━━━━━━━━━━
১. rahim@taskflow.app এর নাম কয়টা?    2 টা → "Rahim", "Rahim Uddin"
২. "bug" tag এর task কয়টা?           2 টা → "Logging যোগ করো", "Login bug ঠিক করো"
৩. Task মোছার পর project কয়টা?       1 টা → Website  (Marketing উধাও!)

━━ Normalized (users / projects / tasks / tags) ━━━━━━━━━━━━━━━━
১. rahim@taskflow.app এর নাম কয়টা?    1 টা → "Rahim Uddin"
২. "bug" tag এর task কয়টা?           1 টা → "Login bug ঠিক করো"
৩. Task মোছার পর project কয়টা?       2 টা → Marketing, Website
```

এই output টা deterministic — তোমার মেশিনেও হুবহু এটাই আসবে।

**২. `npm run dashboard`**

Expected (আমার মেশিনে মাপা — তোমারটায় সংখ্যা ভিন্ন হবে, অনুপাতটা মিলবে):

```
  seeded         : 500 projects × 800 tasks = 400,000 tasks (14.1s)
  results match  : page=true, busiest=true

  প্রশ্ন                          গুনে (সরল)   গুনে (LATERAL)   counter পড়ে
  ২০টা project এর পাতা             39.18 ms        1.78 ms         0.42 ms
  সবচেয়ে ব্যস্ত ১০টা project        39.34 ms          —             0.31 ms
```

`results match` দুটোই অবশ্যই `true` হতে হবে — দ্রুত কিন্তু ভুল উত্তরের কোনো দাম নেই।

**৩. `npm run counter`**

```
  200টা "task তৈরি + counter +1" একসাথে:

  ক. read-modify-write               counter =   1   আসল = 200   ✗ 199 টা হারিয়েছে
  খ. transaction + increment         counter = 200   আসল = 200   ✓ ঠিক আছে
  গ. খ এর পরে ৫০টা bulk import       counter = 200   আসল = 250   ✗ 50 টা হারিয়েছে

  reconcile() চালানো হলো — 2 টা project এর counter ভুল ছিল, ঠিক করা হয়েছে:

  ক. (reconcile এর পরে)              counter = 200   আসল = 200   ✓ ঠিক আছে
  খ+গ. (reconcile এর পরে)            counter = 250   আসল = 250   ✓ ঠিক আছে
```

(ক) তে কতগুলো হারায় সেটা মেশিনভেদে বদলাতে পারে — কিন্তু **শূন্য হবে না**। (খ) সবসময়
২০০ হতে হবে।

## কী দেখার জন্য এটা বানানো

1. **Anomaly গুলো "তত্ত্ব" না।** একটা ছোট schema ভুল থেকে তিনটা আলাদা ধরনের ভুল data —
   আর তিনটার কোনোটাতেই কোনো error আসে না। Database খুশি মনে ভুল data রেখে দেয়।
2. **Denormalize করার আগে query ঠিক করো।** `dashboard` এ পাতার query টা শুধু ভালো করে লিখেই
   (LATERAL) ~২২ গুণ দ্রুত হয়, কোনো schema না বদলে। কিন্তু "সবচেয়ে ব্যস্ত" প্রশ্নে সবগুলো
   গুনতেই হয় — সেখানে কোনো query কৌশল কাজ করে না। **Derived মান দিয়ে sort বা filter** —
   এটাই denormalization এর আসল জায়গা।
3. **Counter এর দাম লেখার সময় দিতে হয়।** প্রতিটা write path কে counter এর কথা মনে রাখতে
   হয়, atomic ভাবে বাড়াতে হয়, আর তারপরও একটা reconciliation job লাগে — কারণ কেউ না কেউ
   একদিন ভুলবেই (গ)।

**(ক) কেন এত চরম (১৯৯ টা হারায়)?** Sequelize এর pool এ ১০টা connection, আর ২০০টা কাজ
একসাথে শুরু হয়। Pool এর লাইনে আগে ২০০টা `INSERT` বসে, তাই সবগুলো `SELECT` চলে যখন
counter তখনো ০ — সবাই ০ পড়ে, সবাই ১ লেখে। বাস্তব traffic সময়ে ছড়ানো থাকে, তাই এত বেশি
হারাবে না — কিন্তু দুটো request এর মধ্যে কয়েক millisecond এর ফাঁকও যথেষ্ট। আর এই ধরনের
bug local এ একজন user দিয়ে test করলে **কখনো ধরা পড়ে না**।

## নিজে ভেঙে দেখো (Experiments)

1. **Index সরিয়ে দাও।** `src/models/good.ts` এ `tasks` এর `indexes` থেকে
   `{ fields: ['projectId', 'status'] }` বাদ দিয়ে `npm run dashboard` চালাও। LATERAL query এর
   সময় কী হয়? কেন? (ইঙ্গিত: প্রতিটা project এর count এখন কীভাবে বের হবে? Lesson 5.4 এর
   preview।)

2. **Race টা বাস্তবের কাছাকাছি আনো।** `src/counter.ts` এর `naive()` এর শুরুতে একটা ছোট
   random delay যোগ করো:

   ```typescript
   await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));
   ```

   এখন কতগুলো হারায়? কয়েকবার চালাও। Delay ৫০০ ms করলে? সংখ্যাটা কমে, কিন্তু কি শূন্য হয়?
   "কম হারায়" আর "হারায় না" এর মধ্যে পার্থক্যটা নিজের ভাষায় লেখো।

3. **Transaction আছে কিন্তু atomic না।** `atomic()` এর ভেতরে `Project.increment` এর বদলে
   `naive()` এর মতো `findByPk` → `+1` → `save()` লেখো, কিন্তু সবকিছু `transaction` এর ভেতরে
   রেখে (`{ transaction }` দিয়ে)। এবার কি ২০০ আসে? না আসলে — transaction থাকা সত্ত্বেও
   কেন? (এটাই Lesson 5.5 এর isolation level এর গল্পের শুরু।)

4. **Status বদলানোর path ভুলে যাও।** একটা ছোট function লেখো যেটা ২০টা task এর `status`
   `'done'` করে দেয় কিন্তু counter কমায় না। তারপর `reconcile()` চালিয়ে দেখো সে ধরতে পারে
   কিনা। Task তৈরি ছাড়া আর কোন কোন কাজে `openTaskCount` বদলানো দরকার — একটা তালিকা বানাও।

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-5.2-data-modeling/
├── docker-compose.yml   # শুধু Postgres (5434)
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts            # Sequelize connection
    ├── models/
    │   ├── bad.ts       # BadTask — সব এক table এ, ইচ্ছা করে খারাপ
    │   └── good.ts      # User, Project, Task, Tag, TaskTag — 3NF + openTaskCount
    ├── reconcile.ts     # counter কে tasks table থেকে নতুন করে হিসাব করে
    ├── anomalies.ts     # তিনটা anomaly, দুই schema তে পাশাপাশি
    ├── dashboard.ts     # ৪ লাখ task seed + তিন ধরনের query মাপা
    └── counter.ts       # race, bulk import drift, reconciliation
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, Postgres 17, Sequelize 6.37):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- তিনটা script ই চালিয়ে উপরের output মিলিয়ে দেখা হয়েছে; `counter` তিনবার চালানো হয়েছে,
  প্রতিবার একই ফল
- `dashboard` এর সংখ্যাগুলো সত্যিকারের মাপা — অনুমান করা না। Query plan `EXPLAIN ANALYZE`
  দিয়েও যাচাই করা: সরল query তে পুরো `tasks` table এর Seq Scan + HashAggregate, LATERAL এ
  শুধু ২০টা project এর Index Only Scan
