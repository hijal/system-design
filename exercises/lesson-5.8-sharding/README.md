# TaskFlow Partitioning আর Sharding — মেপে দেখা

> Lesson 5.8 — Sharding & Partitioning · **Tier 1 — Runnable Code** (Docker এ ৩টা Postgres)

## কী বানাচ্ছি

Docker এ তিনটা আলাদা PostgreSQL, প্রতিটা একটা "shard"। তিনটা script:

| Script              | কী দেখায়                                                                                                    | Lesson §  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run partition` | একটা database এর ভেতরে মাস অনুযায়ী partitioning — pruning কখন কাজ করে, আর পুরনো data মোছা: DELETE বনাম DROP | ১.২       |
| `npm run shard`     | ৩টা database এ `workspaceId` দিয়ে sharding — এক shard এর query, scatter-gather, hot shard, shard পেরোনো কাজ | ১.৩ – ১.৬ |
| `npm run keys`      | Database ছাড়া হিসাব: কোন shard key তে write কোথায় জমে, আর ৩→৪ shard এ `hash % N` বনাম consistent hashing   | ১.৪, ১.৭  |

## Prerequisite

Node.js 22+ এবং Docker। Port **5440–5442** খালি থাকতে হবে। `npm run keys` এর জন্য Docker লাগে না।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run partition   # ১২ লাখ row দুটো table এ — ~১০ সেকেন্ড
npm run shard
npm run keys
```

তিনটাই শুরুতে নিজের table নতুন করে বানায়, তাই যতবার খুশি চালানো যায়।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

সময় আমার মেশিনে মাপা (Node 26, Postgres 17); তোমার ভিন্ন হবে। Row সংখ্যা, partition সংখ্যা, shard এ ভাগ
আর `keys` এর সব সংখ্যা deterministic — হুবহু মিলবে।

**১. `npm run partition`**

```
  12 মাস × 100,000 = 1,200,000টা activity, দুটো table এ (7.9s)

১. Partition pruning — query কোন partition ছোঁয়?
   query                                  সাধারণ table               partitioned
   project 42, শেষ ৭ দিন                  0.03 ms                    0.04 ms — activity_2026_09
   project 42, সব সময় (সময়ের শর্ত নেই)  0.22 ms                    0.62 ms — 12টা partition
   পুরো মাসের সব event (আগস্ট)            22.41 ms                   9.14 ms — activity_2026_08

২. Retention — সবচেয়ে পুরনো মাস (অক্টোবর ২০২৫) মুছে ফেলা
   সাধারণ table: DELETE (103,334 row)       99 ms   WAL   11.5 MB   table এর আকার 142.2 MB → 142.2 MB
   partitioned:  DETACH + DROP partition        8 ms   WAL    0.1 MB   (পুরো file টাই মুছে গেল)
```

DELETE এর সময় রান ভেদে বেশ বদলায় (আমার দুটো রানে ৯৯ আর ২০২ ms); WAL আর আকার প্রতিবার একই।

**২. `npm run shard`**

```
১. 300টা workspace, 300,000টা task — shard key: hash(workspaceId) % 3
   shard0:  94টা workspace   175,986টা task  ███████████████████████  ← workspace 7 (৪০%) এখানে
   shard1: 106টা workspace    63,812টা task  █████████
   shard2: 100টা workspace    60,200টা task  ████████

২. Shard key সহ query — "workspace 42 এ কয়টা খোলা task?"
   → শুধু shard0 এ যায়: 201টা, 0.27 ms

৩. Shard key ছাড়া query — "সবচেয়ে বেশি খোলা task কোন ১০টা workspace এ?"
   → 3টা shard এ একসাথে (scatter), app এ মিলিয়ে সাজানো (gather): মোট 11.0 ms
     shard0: 11.0 ms, shard1: 4.8 ms, shard2: 4.6 ms — মোট সময় সবচেয়ে ধীরটার সমান

৪. দুই shard জুড়ে কাজ — project কে অন্য workspace এ সরানো (আলাদা shard এ)
   project 8: workspace 8 (shard0) → workspace 5 (shard2)
   ধাপ ১: shard2 তে project লেখা হলো — COMMIT ✓
   ধাপ ২: shard0 থেকে মুছে ফেলার আগেই app crash করল ✗
   → project 8 এখন shard0 এ 1টা, shard2 এ 1টা — দুই জায়গাতেই! কোনো একক transaction এটা আটকাতে পারেনি
```

**৩. `npm run keys`**

```
ক. আজকের 1,000,000টা write, 4টা shard — কোন shard key তে কোথায় জমে?
   shard key                      প্রতিটা shard এ write এর ভাগ     সবচেয়ে ব্যস্ত   workspace 7 এর data কয়টা shard এ
   hash(workspaceId)               14%  16%  15%  55%                   55%        1টা
   hash(taskId)                    25%  25%  25%  25%                   25%        4টা
   range(createdAt) — ত্রৈমাসিক     0%   0%   0% 100%                  100%        1টা
   hash(workspaceId, projectId)    17%  33%  25%  25%                   33%        4টা

খ. Shard ৩ থেকে ৪ করা — 100,000টা workspace এর কতগুলো অন্য shard এ সরাতে হবে?
   hash % N               74.9%   (74,874টা)
   consistent hashing     26.3%   (26,274টা)
   আদর্শ (শুধু নতুন shard এর ভাগটুকু = ১/৪)    25.0%
```

## কী দেখার জন্য এটা বানানো

1. **Partitioning index এর বিকল্প না।** Index থাকা query তে (project 42, শেষ ৭ দিন) partition এ কোনো লাভ
   নেই; partition key ছাড়া query বরং **ধীর** (১২টা partition ঘুরতে হয়)। আসল লাভ দুটো: পুরো একটা
   অংশ scan (২২ → ৯ ms), আর পুরনো data মোছা (DELETE ৯৯ ms + ১১.৫ MB WAL, আর table এক byte ও ছোট হয়নি;
   DROP ৮ ms + ০.১ MB)।
2. **Shard key ই সব।** একই data, চারটা key — একটায় একটা shard ১০০% write খায়, একটায় সমান ভাগ কিন্তু
   প্রতিটা workspace এর query ৪টা shard এ যায়। নিখুঁত key নেই; আছে তোমার access pattern (Lesson 5.1) এর
   সাথে মানানসই key।
3. **Scatter-gather এর সময় সবচেয়ে ধীর shard এর সমান** — আর সবচেয়ে ধীর shard টা সেই hot shard।
4. **Shard পেরোলে transaction হারায়।** দুটো আলাদা database — একটা COMMIT দিয়ে দুটো বাঁধা যায় না।
5. **Hash function এর মান গুরুত্বপূর্ণ।** এই exercise বানানোর সময় প্রথমে সাধারণ FNV-1a ব্যবহার করেছিলাম —
   consistent hashing ring এ একটা shard ৪৭% key পাচ্ছিল, আরেকটা ১২%। একটা mixing ধাপ (MurmurHash3 এর
   `fmix32`) যোগ করে ভাগ প্রায় সমান হলো (`src/hash.ts` এর comment দেখো)।

## নিজে ভেঙে দেখো (Experiments)

1. **Partition ছাড়া query এর দাম বাড়াও।** `src/partition.ts` এ `MONTHS` ১২ থেকে ৩৬ করো (৩ বছর)। "project
   42, সব সময়" query এর partitioned সময় কীভাবে বদলায়? Partition বেশি হলে planning এর খরচও বাড়ে — কেন?

2. **বড় workspace কে আলাদা করো।** `src/shard.ts` এর `shardIndexFor` এ একটা বিশেষ নিয়ম দাও:
   `BIG_WORKSPACE` সবসময় shard0 তে, আর বাকি সব workspace hash দিয়ে শুধু shard1 আর shard2 তে ভাগ। Task এর
   ভাগ কেমন হলো? এই "lookup table" ধরনের routing এর লাভ কী, আর নতুন কী দায়িত্ব যোগ হলো (কে ঠিক করবে
   কোন customer "বড়", আর সেটা বদলালে কী)?

3. **Composite key এর সূক্ষ্মতা।** `src/keys.ts` এ `PROJECTS_PER_WORKSPACE` ২০ থেকে ২০০ করো। `hash(workspaceId,
projectId)` এর "সবচেয়ে ব্যস্ত" কলাম কী হয়? কেন ২০টা project এ ভাগ সমান হচ্ছিল না?

4. **Virtual node কমাও।** `buildRing` এর `virtualNodes` ২০০ থেকে ১ করো। Consistent hashing এ কত % সরে, আর
   প্রতিটা shard এর ভাগ কেমন হয়? (Lesson 10.1 এর preview।)

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-5.8-sharding/
├── docker-compose.yml   # shard0 (5440), shard1 (5441), shard2 (5442)
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts            # তিনটা shard এর connection
    ├── hash.ts          # stable, ভালোভাবে মেশানো hash (FNV-1a + fmix32), hash % N
    ├── partition.ts     # মাস অনুযায়ী partition, pruning, DELETE বনাম DROP
    ├── shard.ts         # workspaceId দিয়ে routing, scatter-gather, hot shard, cross-shard move
    └── keys.ts          # shard key অনুযায়ী write এর ভাগ; hash % N বনাম consistent hashing
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, Postgres 17, Sequelize 6.37):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- `partition` দুবার, `shard` তিনবার (hash বদলানোর আগে ও পরে; শেষ দুটো রানে shard এর ভাগ হুবহু এক), `keys`
  তিনবার — deterministic, প্রতিবার একই সংখ্যা
- Experiment ১–৪ চালিয়ে দেখা **হয়নি**
