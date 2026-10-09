# TaskFlow Partitioning আর Sharding - মেপে দেখা

> Lesson 5.8 - Sharding & Partitioning · **Tier 1 - Runnable Code** (Docker এ ৩টা Postgres)

## কী বানাচ্ছি

Docker এ তিনটা আলাদা PostgreSQL, প্রতিটা একটা "shard"। তিনটা script:

| Script              | কী দেখায়                                                                                                    | Lesson §  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| `npm run partition` | একটা database এর ভেতরে মাস অনুযায়ী partitioning - pruning কখন কাজ করে, আর পুরনো data মোছা: DELETE বনাম DROP | ১.২       |
| `npm run shard`     | ৩টা database এ `workspaceId` দিয়ে sharding - এক shard এর query, scatter-gather, hot shard, shard পেরোনো কাজ | ১.৩ – ১.৬ |
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
npm run partition   # 1.2 million rows in two tables - ~10 seconds
npm run shard
npm run keys
```

তিনটাই শুরুতে নিজের table নতুন করে বানায়, তাই যতবার খুশি চালানো যায়।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

সময় আমার মেশিনে মাপা (Node 26, Postgres 17); আপনার ভিন্ন হবে। Row সংখ্যা, partition সংখ্যা, shard এ ভাগ
আর `keys` এর সব সংখ্যা deterministic - হুবহু মিলবে।

**১. `npm run partition`**

```
  12 months × 100,000 = 1,200,000 activities, in two tables (7.9s)

1. Partition pruning - which partitions does a query touch?
   query                                    plain table                partitioned
   project 42, last 7 days                  0.03 ms                    0.04 ms - activity_2026_09
   project 42, all time (no time condition) 0.22 ms                    0.62 ms - 12 partitions
   every event of a whole month (August)    22.41 ms                   9.14 ms - activity_2026_08

2. Retention - deleting the oldest month (October 2025)
   plain table: DELETE (103,334 rows)         99 ms   WAL   11.5 MB   table size 142.2 MB → 142.2 MB
   partitioned: DETACH + DROP partition        8 ms   WAL    0.1 MB   (the whole file is gone)
```

DELETE এর সময় রান ভেদে বেশ বদলায় (আমার দুটো রানে ৯৯ আর ২০২ ms); WAL আর আকার প্রতিবার একই।

**২. `npm run shard`**

```
1. 300 workspaces, 300,000 tasks - shard key: hash(workspaceId) % 3
   shard0:  94 workspaces   175,986 tasks  ███████████████████████  ← workspace 7 (40%) is here
   shard1: 106 workspaces    63,812 tasks  █████████
   shard2: 100 workspaces    60,200 tasks  ████████

2. A query with the shard key - "how many open tasks in workspace 42?"
   → goes only to shard0: 201, 0.27 ms

3. A query without the shard key - "which 10 workspaces have the most open tasks?"
   → sent to all 3 shards at once (scatter), merged and sorted in the app (gather): 11.0 ms total
     shard0: 11.0 ms, shard1: 4.8 ms, shard2: 4.6 ms - the total equals the slowest one

4. Work across two shards - moving a project to another workspace (on a different shard)
   project 8: workspace 8 (shard0) → workspace 5 (shard2)
   step 1: project written to shard2 - COMMIT ✓
   step 2: the app crashed before deleting it from shard0 ✗
   → project 8 is now on shard0 (1) and on shard2 (1) - in both places! No single transaction could prevent it
```

**৩. `npm run keys`**

```
a. Today's 1,000,000 writes, 4 shards - where do writes pile up under each shard key?
   shard key                      share of writes per shard        busiest   shards holding workspace 7's data
   hash(workspaceId)               14%  16%  15%  55%                   55%        1
   hash(taskId)                    25%  25%  25%  25%                   25%        4
   range(createdAt) - quarterly     0%   0%   0% 100%                  100%        1
   hash(workspaceId, projectId)    17%  33%  25%  25%                   33%        4

b. Going from 3 to 4 shards - how many of 100,000 workspaces must move to another shard?
   hash % N               74.9%   (74,874)
   consistent hashing     26.3%   (26,274)
   ideal (only the new shard's share = 1/4)    25.0%
```

## কী দেখার জন্য এটা বানানো

1. **Partitioning index এর বিকল্প না।** Index থাকা query তে (project 42, শেষ ৭ দিন) partition এ কোনো লাভ
   নেই; partition key ছাড়া query বরং **ধীর** (১২টা partition ঘুরতে হয়)। আসল লাভ দুটো: পুরো একটা
   অংশ scan (২২ → ৯ ms), আর পুরনো data মোছা (DELETE ৯৯ ms + ১১.৫ MB WAL, আর table এক byte ও ছোট হয়নি;
   DROP ৮ ms + ০.১ MB)।
2. **Shard key ই সব।** একই data, চারটা key - একটায় একটা shard ১০০% write খায়, একটায় সমান ভাগ কিন্তু
   প্রতিটা workspace এর query ৪টা shard এ যায়। নিখুঁত key নেই; আছে আপনার access pattern (Lesson 5.1) এর
   সাথে মানানসই key।
3. **Scatter-gather এর সময় সবচেয়ে ধীর shard এর সমান** - আর সবচেয়ে ধীর shard টা সেই hot shard।
4. **Shard পেরোলে transaction হারায়।** দুটো আলাদা database - একটা COMMIT দিয়ে দুটো বাঁধা যায় না।
5. **Hash function এর মান গুরুত্বপূর্ণ।** এই exercise বানানোর সময় প্রথমে সাধারণ FNV-1a ব্যবহার করেছিলাম -
   consistent hashing ring এ একটা shard ৪৭% key পাচ্ছিল, আরেকটা ১২%। একটা mixing ধাপ (MurmurHash3 এর
   `fmix32`) যোগ করে ভাগ প্রায় সমান হলো (`src/hash.ts` এর comment দেখুন)।

## নিজে ভেঙে দেখুন (Experiments)

1. **Partition ছাড়া query এর দাম বাড়ান।** `src/partition.ts` এ `MONTHS` ১২ থেকে ৩৬ করুন (৩ বছর)। "project
   42, সব সময়" query এর partitioned সময় কীভাবে বদলায়? Partition বেশি হলে planning এর খরচও বাড়ে - কেন?

2. **বড় workspace কে আলাদা করুন।** `src/shard.ts` এর `shardIndexFor` এ একটা বিশেষ নিয়ম দিন:
   `BIG_WORKSPACE` সবসময় shard0 তে, আর বাকি সব workspace hash দিয়ে শুধু shard1 আর shard2 তে ভাগ। Task এর
   ভাগ কেমন হলো? এই "lookup table" ধরনের routing এর লাভ কী, আর নতুন কী দায়িত্ব যোগ হলো (কে ঠিক করবে
   কোন customer "বড়", আর সেটা বদলালে কী)?

3. **Composite key এর সূক্ষ্মতা।** `src/keys.ts` এ `PROJECTS_PER_WORKSPACE` ২০ থেকে ২০০ করুন। `hash(workspaceId,
projectId)` এর "সবচেয়ে ব্যস্ত" কলাম কী হয়? কেন ২০টা project এ ভাগ সমান হচ্ছিল না?

4. **Virtual node কমান।** `buildRing` এর `virtualNodes` ২০০ থেকে ১ করুন। Consistent hashing এ কত % সরে, আর
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

- `tsc --noEmit` - clean pass, কোনো type error নেই, কোথাও `any` নেই
- `partition` দুবার, `shard` তিনবার (hash বদলানোর আগে ও পরে; শেষ দুটো রানে shard এর ভাগ হুবহু এক), `keys`
  তিনবার - deterministic, প্রতিবার একই সংখ্যা
- Experiment ১–৪ চালিয়ে দেখা **হয়নি**
