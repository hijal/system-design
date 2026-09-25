# TaskFlow Replication — Primary + Replica, Lag, Read-your-writes, Failover

> Lesson 5.7 — Replication · **Tier 2 — Infra Setup** (সাথে TypeScript script)

## কী বানাচ্ছি

Docker এ একটা আসল PostgreSQL **streaming replication** cluster — একটা primary, একটা replica —
আর তিনটা script যেগুলো replication এর তিনটা বাস্তব সমস্যা চোখে দেখায়:

| Script             | কী দেখায়                                                                                            | Lesson §  |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------- |
| `npm run lag`      | Sequelize এর `replication` config এ "এইমাত্র save করলাম, দেখাচ্ছে না" bug — আর replication lag মাপা  | ১.২ – ১.৩ |
| `npm run ryw`      | Read-your-writes এর তিনটা সমাধান (`useMaster`, LSN token, `remote_apply`) — প্রতিটার দাম কোথায় পড়ে | ১.৪       |
| `npm run failover` | Replica বিচ্ছিন্ন → primary মৃত → replica promote → async replication এ ঠিক কোন data হারাল           | ১.৫       |

## Prerequisite

Node.js 22+ এবং Docker (Docker Compose v2 সহ)। Port **5438** (primary) আর **5439** (replica) খালি থাকতে হবে।

`failover` script নিজে `docker` command চালায় (`network disconnect`, `compose kill`) — তাই এই folder
থেকেই চালাতে হবে, আর তোমার user এর Docker চালানোর অনুমতি থাকতে হবে।

## Setup

```bash
docker compose up -d --wait   # primary চালু, তারপর replica নিজেকে primary থেকে কপি করে (pg_basebackup)
npm install
```

Replication চলছে কিনা দেখো:

```bash
docker compose exec primary psql -U taskflow -c "SELECT application_name, state, sync_state FROM pg_stat_replication"
#  application_name |   state   | sync_state
# ------------------+-----------+------------
#  walreceiver      | streaming | sync

docker compose exec replica psql -U taskflow -tAc "SELECT pg_is_in_recovery()"
# t        ← replica read-only standby হিসেবে চলছে
```

(`sync_state` এ `sync` দেখালেও সাধারণ commit async — কেন, সেটা `docker-compose.yml` এর comment এ।)

## Run

```bash
npm run lag
npm run ryw
npm run failover     # ⚠️ শেষে cluster ভাঙা থাকে — নিচের reset command চালাও
docker compose down -v && docker compose up -d --wait
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

সব output আমার মেশিনে, একই মেশিনে primary আর replica (Node 26, Postgres 17)।

**১. `npm run lag`**

```
   create (primary) → সাথে সাথে findByPk (replica)
   অবস্থা                              খুঁজে পায়নি   replica তে দেখা যেতে কত সময় লাগল
   স্বাভাবিক (একই মেশিন, load নেই)     199/200   p50    1.8 ms   p99    2.3 ms
   replica ২০০ ms পিছিয়ে (নকল lag)     50/50   p50  200.1 ms   p99  200.9 ms
```

প্রথম লাইনের "খুঁজে পায়নি" সংখ্যা রান ভেদে ১৯৮–১৯৯ — কিন্তু **প্রায় সবসময়** পায় না।

**২. `npm run ryw`**

```
   replica 200 ms পিছিয়ে; প্রতিটা কৌশলে 30 বার "লেখো → সাথে সাথে পড়ো"
   কৌশল                                       পাওয়া গেছে   লেখা (median)   পড়া (median)
   ক. কিছু না (replica থেকে পড়া)                0/30        2.1 ms        0.4 ms
   খ. useMaster: true (primary থেকে)            30/30        2.1 ms        0.4 ms
   গ. LSN token — replica ধরা পর্যন্ত অপেক্ষা   30/30        1.8 ms      200.7 ms
   ঘ. synchronous_commit = remote_apply         30/30      202.2 ms        0.7 ms
```

**৩. `npm run failover`** (মূল অংশ)

```
   ৪. একটা event synchronous_commit = remote_apply দিয়ে
      ৩ সেকেন্ড পরে: commit এখনো replica এর অপেক্ষায় আটকে আছে? হ্যাঁ
      → app এর timeout এ ধৈর্য শেষ; query টা cancel করা হলো
      COMMIT ফেরত এলো 3.0s পরে, সাথে Postgres এর সতর্কবার্তা:
        WARNING: canceling wait for synchronous replication due to user request — The transaction has already committed locally, but might not have been replicated to the standby.

   ৫. Primary মারা গেল (docker kill)
      app এর নতুন write: ✗ Connection terminated unexpectedly

   ৬. Failover — replica কে promote করা (pg_promote)
      replica এখনো read-only standby? না — এখন সে নতুন primary, write নেয়

   ৭. নতুন primary তে কী আছে?
      before            10/10  ✓
      async              0/20  ✗ হারিয়ে গেছে — অথচ user কে "saved" বলা হয়েছিল
      sync               0/1  ✗ হারিয়ে গেছে — app timeout পেয়েছিল, কিন্তু পুরনো primary তে এটা commit হয়ে ছিল
      after-failover     1/1  ✓
```

এটা deterministic — প্রতিবার একই।

## কী দেখার জন্য এটা বানানো

1. **Lag ছোট হলেও bug হয়।** একই মেশিনে, কোনো load ছাড়া lag মাত্র ~২ ms — তবু ২০০ বারের মধ্যে
   ১৯৯ বার নিজের লেখা পাওয়া যায়নি, কারণ পরের read টা lag এর চেয়েও দ্রুত আসে। প্রশ্নটা "lag কত ছোট"
   না — "lag শূন্য কিনা"। আর async replication এ সেটা কখনো শূন্য না।
2. **Read-your-writes এর দাম কোথাও না কোথাও দিতে হয়।** `useMaster` → primary এর load বাড়ে;
   LSN token → পড়া ধীর; `remote_apply` → লেখা ধীর (replica যত ধীর, লেখা তত ধীর)।
3. **Async replication এর failover মানে data loss এর একটা জানালা।** Replica যা পায়নি, promote
   হলে সেটা আর কোথাও নেই — user এর দেখা "saved" মিথ্যা হয়ে গেল।
4. **Synchronous replication ও জাদু না।** Replica না থাকলে commit **চিরকাল আটকে থাকে**, আর app
   cancel করলেও transaction টা primary তে commit থেকে যায় — "timeout = rollback" না।

## নিজে ভেঙে দেখো (Experiments)

1. **Replica কে থামাও, sync write চালাও।** `docker compose stop replica`, তারপর:
   `docker compose exec primary psql -U taskflow -c "BEGIN; SET LOCAL synchronous_commit = remote_apply; CREATE TABLE IF NOT EXISTS x (id int); COMMIT;"`
   কী হয়? (`Ctrl+C` দিয়ে থামাও, তারপর `docker compose start replica`।) এটাই synchronous replication এর
   availability এর দাম — একটা replica নেই মানে কোনো sync write নেই।

2. **Replica থেকে লেখার চেষ্টা করো।** `docker compose exec replica psql -U taskflow -c "INSERT INTO tasks (title) VALUES ('x')"`
   — কী error আসে? কেন replica read-only?

3. **Lag এর সংখ্যা database থেকে পড়ো।** `npm run ryw` চলার সময় আরেকটা terminal এ:
   `docker compose exec primary psql -U taskflow -c "SELECT write_lag, flush_lag, replay_lag FROM pg_stat_replication"`
   তিনটা সংখ্যা আলাদা কেন? কোনটা ২০০ ms এর কাছাকাছি, আর কেন?

4. **Split brain এর বীজ।** `npm run failover` এর পরে (reset করার **আগে**) পুরনো primary কে আবার চালু করো:
   `docker compose start primary`। এখন দুটো database ই write নেয়। দুটোতে `SELECT kind, count(*) FROM events GROUP BY kind`
   চালিয়ে তুলনা করো। App যদি ভুল করে পুরনোটায় লেখে, কী হবে? (এটাই Lesson 6.1 এর split brain।)
   তারপর reset করো।

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-5.7-replication/
├── docker-compose.yml          # primary (5438) + replica (5439)
├── docker/
│   ├── primary-init.sh         # replication user + pg_hba অনুমতি (প্রথম চালুতে একবার)
│   └── replica-entrypoint.sh   # pg_basebackup -R দিয়ে primary থেকে কপি, তারপর standby
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts                   # Sequelize read replication config, সরাসরি connection, LSN helper
    ├── lag.ts                  # read-your-writes bug + lag মাপা
    ├── ryw.ts                  # তিনটা সমাধান, দাম সহ
    └── failover.ts             # disconnect → kill → promote → কী হারাল
```

## Verification status

`main.md` এ Tier 2 exercise চালিয়ে যাচাই করার কথা বলা নেই, কারণ ধরে নেওয়া হয় sandbox এ Docker
থাকবে না। এই মেশিনে Docker ছিল, তাই **চালিয়ে যাচাই করা হয়েছে** (Node 26, Postgres 17, Sequelize 6.37,
Docker Compose v2):

- `tsc --noEmit` — clean pass, কোনো type error নেই, কোথাও `any` নেই
- নতুন cluster থেকে (`down -v` → `up`) তিনটা script ক্রমানুসারে চালানো — উপরের output
- `lag` আর `ryw` দুবার করে; `failover` দুবার (প্রতিবার reset এর পরে) — একই ফল
- Reset command (`down -v && up -d --wait`) এর পরে replication আবার `streaming` অবস্থায় — যাচাই করা
- Experiment ১–৪ এর নির্দিষ্ট output চালিয়ে দেখা **হয়নি**; ১ নম্বরের আচরণ (commit আটকে থাকা) `failover` এর ধাপ ৪ এ দেখা গেছে
