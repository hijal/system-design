# TaskFlow Replication - Primary + Replica, Lag, Read-your-writes, Failover

> Lesson 5.7 - Replication · **Tier 2 - Infra Setup** (সাথে TypeScript script)

## কী বানাচ্ছি

Docker এ একটা আসল PostgreSQL **streaming replication** cluster - একটা primary, একটা replica -
আর তিনটা script যেগুলো replication এর তিনটা বাস্তব সমস্যা চোখে দেখায়:

| Script             | কী দেখায়                                                                                            | Lesson §  |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------- |
| `npm run lag`      | Sequelize এর `replication` config এ "এইমাত্র save করলাম, দেখাচ্ছে না" bug - আর replication lag মাপা  | ১.২ – ১.৩ |
| `npm run ryw`      | Read-your-writes এর তিনটা সমাধান (`useMaster`, LSN token, `remote_apply`) - প্রতিটার দাম কোথায় পড়ে | ১.৪       |
| `npm run failover` | Replica বিচ্ছিন্ন → primary মৃত → replica promote → async replication এ ঠিক কোন data হারাল           | ১.৫       |

## Prerequisite

Node.js 22+ এবং Docker (Docker Compose v2 সহ)। Port **5438** (primary) আর **5439** (replica) খালি থাকতে হবে।

`failover` script নিজে `docker` command চালায় (`network disconnect`, `compose kill`) - তাই এই folder
থেকেই চালাতে হবে, আর আপনার user এর Docker চালানোর অনুমতি থাকতে হবে।

## Setup

```bash
docker compose up -d --wait   # the primary starts, then the replica copies itself from the primary (pg_basebackup)
npm install
```

Replication চলছে কিনা দেখুন:

```bash
docker compose exec primary psql -U taskflow -c "SELECT application_name, state, sync_state FROM pg_stat_replication"
#  application_name |   state   | sync_state
# ------------------+-----------+------------
#  walreceiver      | streaming | sync

docker compose exec replica psql -U taskflow -tAc "SELECT pg_is_in_recovery()"
# t        ← the replica is running as a read-only standby
```

(`sync_state` এ `sync` দেখালেও সাধারণ commit async - কেন, সেটা `docker-compose.yml` এর comment এ।)

## Run

```bash
npm run lag
npm run ryw
npm run failover     # ⚠️ leaves the cluster broken at the end - run the reset command below
docker compose down -v && docker compose up -d --wait
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

সব output আমার মেশিনে, একই মেশিনে primary আর replica (Node 26, Postgres 17)।

**১. `npm run lag`**

```
   create (primary) → findByPk right away (replica)
   situation                               not found   time until visible on the replica
   normal (same machine, no load)          199/200   p50    1.8 ms   p99    2.3 ms
   replica 200 ms behind (simulated lag)    50/50   p50  200.1 ms   p99  200.9 ms
```

প্রথম লাইনের "খুঁজে পায়নি" সংখ্যা রান ভেদে ১৯৮–১৯৯ - কিন্তু **প্রায় সবসময়** পায় না।

**২. `npm run ryw`**

```
   replica 200 ms behind; 30 times "write → read immediately" for each strategy
   strategy                                      found  write median   read median
   a. nothing (read from the replica)            0/30        2.1 ms        0.4 ms
   b. useMaster: true (from the primary)        30/30        2.1 ms        0.4 ms
   c. LSN token - wait for the replica          30/30        1.8 ms      200.7 ms
   d. synchronous_commit = remote_apply         30/30      202.2 ms        0.7 ms
```

**৩. `npm run failover`** (মূল অংশ)

```
   4. one event with synchronous_commit = remote_apply
      after 3 seconds: is the commit still stuck waiting for the replica? yes
      → the app's timeout ran out of patience; the query was cancelled
      COMMIT came back after 3.0s, with a warning from Postgres:
        WARNING: canceling wait for synchronous replication due to user request - The transaction has already committed locally, but might not have been replicated to the standby.

   5. The primary died (docker kill)
      a new write from the app: ✗ Connection terminated unexpectedly

   6. Failover - promoting the replica (pg_promote)
      is the replica still a read-only standby? no - it is the new primary now, it takes writes

   7. What is on the new primary?
      before            10/10  ✓
      async              0/20  ✗ lost - even though the user was told "saved"
      sync               0/1  ✗ lost - the app got a timeout, but it had been committed on the old primary
      after-failover     1/1  ✓
```

এটা deterministic - প্রতিবার একই।

## কী দেখার জন্য এটা বানানো

1. **Lag ছোট হলেও bug হয়।** একই মেশিনে, কোনো load ছাড়া lag মাত্র ~২ ms - তবু ২০০ বারের মধ্যে
   ১৯৯ বার নিজের লেখা পাওয়া যায়নি, কারণ পরের read টা lag এর চেয়েও দ্রুত আসে। প্রশ্নটা "lag কত ছোট"
   না - "lag শূন্য কিনা"। আর async replication এ সেটা কখনো শূন্য না।
2. **Read-your-writes এর দাম কোথাও না কোথাও দিতে হয়।** `useMaster` → primary এর load বাড়ে;
   LSN token → পড়া ধীর; `remote_apply` → লেখা ধীর (replica যত ধীর, লেখা তত ধীর)।
3. **Async replication এর failover মানে data loss এর একটা জানালা।** Replica যা পায়নি, promote
   হলে সেটা আর কোথাও নেই - user এর দেখা "saved" মিথ্যা হয়ে গেল।
4. **Synchronous replication ও জাদু না।** Replica না থাকলে commit **চিরকাল আটকে থাকে**, আর app
   cancel করলেও transaction টা primary তে commit থেকে যায় - "timeout = rollback" না।

## নিজে ভেঙে দেখুন (Experiments)

1. **Replica কে থামান, sync write চালান।** `docker compose stop replica`, তারপর:
   `docker compose exec primary psql -U taskflow -c "BEGIN; SET LOCAL synchronous_commit = remote_apply; CREATE TABLE IF NOT EXISTS x (id int); COMMIT;"`
   কী হয়? (`Ctrl+C` দিয়ে থামান, তারপর `docker compose start replica`।) এটাই synchronous replication এর
   availability এর দাম - একটা replica নেই মানে কোনো sync write নেই।

2. **Replica থেকে লেখার চেষ্টা করুন।** `docker compose exec replica psql -U taskflow -c "INSERT INTO tasks (title) VALUES ('x')"`
   - কী error আসে? কেন replica read-only?

3. **Lag এর সংখ্যা database থেকে পড়ুন।** `npm run ryw` চলার সময় আরেকটা terminal এ:
   `docker compose exec primary psql -U taskflow -c "SELECT write_lag, flush_lag, replay_lag FROM pg_stat_replication"`
   তিনটা সংখ্যা আলাদা কেন? কোনটা ২০০ ms এর কাছাকাছি, আর কেন?

4. **Split brain এর বীজ।** `npm run failover` এর পরে (reset করার **আগে**) পুরনো primary কে আবার চালু করুন:
   `docker compose start primary`। এখন দুটো database ই write নেয়। দুটোতে `SELECT kind, count(*) FROM events GROUP BY kind`
   চালিয়ে তুলনা করুন। App যদি ভুল করে পুরনোটায় লেখে, কী হবে? (এটাই Lesson 6.1 এর split brain।)
   তারপর reset করুন।

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

- `tsc --noEmit` - clean pass, কোনো type error নেই, কোথাও `any` নেই
- নতুন cluster থেকে (`down -v` → `up`) তিনটা script ক্রমানুসারে চালানো - উপরের output
- `lag` আর `ryw` দুবার করে; `failover` দুবার (প্রতিবার reset এর পরে) - একই ফল
- Reset command (`down -v && up -d --wait`) এর পরে replication আবার `streaming` অবস্থায় - যাচাই করা
- Experiment ১–৪ এর নির্দিষ্ট output চালিয়ে দেখা **হয়নি**; ১ নম্বরের আচরণ (commit আটকে থাকা) `failover` এর ধাপ ৪ এ দেখা গেছে
