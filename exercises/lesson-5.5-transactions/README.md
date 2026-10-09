# TaskFlow Transactions - Isolation Level আর Race Condition চোখে দেখা

> Lesson 5.5 - Transactions, ACID, Isolation Levels · **Tier 1 - Runnable Code**

## কী বানাচ্ছি

দুটো script, দুটোই আসল PostgreSQL এ, একাধিক আলাদা connection দিয়ে:

| Script               | কী দেখায়                                                                                                                                           | Lesson §  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run anomalies`  | দুটো transaction এর ধাপ **হাতে সাজানো ক্রমে** - lost update, non-repeatable read, phantom, write skew, dirty read - প্রতিটা ভিন্ন isolation level এ | ১.৩ – ১.৫ |
| `npm run lostupdate` | Lesson 5.2 এর counter race - ১০০টা একসাথে `+1`, সাতটা ভিন্ন কৌশলে: কোনটা সঠিক, কত retry, কত সময়                                                    | ১.৬       |

`anomalies` race এর উপর ভরসা করে না - A আর B এর প্রতিটা ধাপ নির্দিষ্ট ক্রমে চালানো হয়, তাই
**প্রতিবার হুবহু একই output**। `lostupdate` সত্যিকারের একসাথে চলা, তাই সংখ্যা রান ভেদে একটু বদলায়।

## Prerequisite

Node.js 22+ এবং Docker (শুধু PostgreSQL চালানোর জন্য)।

Port **5436** - আপনার মেশিনের Postgres (5432) বা আগের exercise গুলোর (5433–5435) সাথে সংঘাত এড়াতে।

## Setup

```bash
docker compose up -d --wait
npm install
```

## Run

```bash
npm run anomalies
npm run lostupdate
```

দুটোই শুরুতে table নতুন করে বানায়, তাই যতবার খুশি চালানো যায়।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. `npm run anomalies`** - deterministic, আপনার মেশিনেও হুবহু এটাই আসবে:

```
━━ 1. Lost update - read-modify-write
   [READ COMMITTED]  openTaskCount starts at 5; both are adding one task
     A: read 5
     B: read 5
     A: wrote 6, COMMIT
     B: wrote 6, COMMIT
       → final value 6 (should be 7) - one update silently lost, nobody got an error

   [REPEATABLE READ]  …
     B: tried to write → ERROR 40001 - could not serialize access (serialization failure), ROLLBACK
       → final value 6 (should be 7) - B's work didn't happen, but B knows it; a retry gives 7. Not silently lost

   [READ COMMITTED + SELECT ... FOR UPDATE]
     A: read 5 (took the row lock)
     B: wanted to read the same row FOR UPDATE… still waiting after 300 ms? yes
     A: wrote 6, COMMIT → released the lock
     B: could read now: 6 (the value A committed)
     B: wrote 7, COMMIT
       → final value 7 (should be 7)

━━ 2. Non-repeatable read
   [READ COMMITTED]   A: first read: "Website" … second read: "Website v2"
   [REPEATABLE READ]  A: first read: "Website" … second read: "Website"

━━ 3. Phantom read
   [READ COMMITTED]   A: first count: 3 tasks … second count: 4 tasks
   [REPEATABLE READ]  A: first count: 3 tasks … second count: 3 tasks

━━ 4. Write skew
   [REPEATABLE READ]  … A: COMMIT ✓   B: COMMIT ✓
       → admins now: 0 - the rule is broken, even though both checked it!
   [SERIALIZABLE]     … A: COMMIT ✓   B: COMMIT → ERROR 40001
       → admins now: 1 - the rule holds

━━ 5. Dirty read
   [B = READ UNCOMMITTED]  A wrote "Draft name", did not commit → B read: "Website"
```

(উপরে ২–৫ সংক্ষেপে দেখানো; আসল output এ প্রতিটা ধাপ আলাদা লাইনে।)

ধাপ ৪ এর SERIALIZABLE অংশে Sequelize নিজে একটা লাইন print করে -
`Committing transaction … failed with error "could not serialize access due to read/write dependencies among transactions". We are killing its connection…` -
এটা প্রত্যাশিত: COMMIT নিজেই ব্যর্থ হলে Sequelize নিরাপত্তার জন্য সেই connection বন্ধ করে দেয়।

**২. `npm run lostupdate`** - আমার মেশিনে, দুবার চালিয়ে (দ্বিতীয়টা):

```
  strategy                                final value  retries      time
  1. read-modify-write, no transaction      ✗   1/100        0     145 ms
  2. same, in a READ COMMITTED transaction  ✗  10/100        0     113 ms
  3. SELECT ... FOR UPDATE                  ✓ 100/100        0     141 ms
  4. atomic UPDATE … SET x = x + 1          ✓ 100/100        0     106 ms
  5. REPEATABLE READ + retry                ✓ 100/100      348     371 ms
  6. optimistic locking (version) + retry   ✓ 100/100     1206     801 ms
  7. SERIALIZABLE + retry                   ✓ 100/100      339     347 ms
```

১ আর ২ এ কতগুলো টিকে থাকে সেটা বদলায় (প্রথমবার ২ এ ছিল ১৪), কিন্তু **কখনো ১০০ হয় না**।
৩–৭ **সবসময় ১০০** হতে হবে।

## কী দেখার জন্য এটা বানানো

1. **Transaction একা race আটকায় না।** কৌশল ২ তে সব কাজ transaction এর ভেতরে - তবু ১০০ এর মধ্যে
   ৯০টা হারায়। Postgres এর default (READ COMMITTED) এ দুটো transaction একই পুরনো মান পড়তে পারে।
2. **একই সমস্যার তিন ধরনের সমাধান:** আগে lock নিন (৩), হিসাবটা database কে দিন (৪), অথবা
   সংঘাত ঘটলে ধরা পড়ুক আর আবার চেষ্টা করুন (৫, ৬, ৭)। শেষেরগুলোতে **retry বাধ্যতামূলক** -
   retry ছাড়া এরা শুধু error ছুড়ত।
3. **Optimistic locking তীব্র প্রতিযোগিতায় খারাপ।** ১০০ জন একই row এ - প্রতিটা সফল লেখার জন্য
   গড়ে ১২টা ব্যর্থ চেষ্টা। Optimistic এর জায়গা হলো যেখানে সংঘাত **কদাচিৎ** (দুজন একই task একই
   মুহূর্তে edit করছে - বিরল)।
4. **Write skew (anomalies ধাপ ৪) সবচেয়ে বিপজ্জনক।** দুজনেই নিয়ম যাচাই করেছে, দুজনেই আলাদা row
   বদলেছে - কোনো row এ সংঘাত নেই, তাই REPEATABLE READ কিছু ধরতে পারে না। শুধু SERIALIZABLE
   (অথবা হাতে lock) এটা আটকায়।

## নিজে ভেঙে দেখুন (Experiments)

1. **Retry তুলে দিন।** `src/lostupdate.ts` এ কৌশল ৭ থেকে `withRetry(...)` মোড়ক সরিয়ে শুধু
   `sequelize.transaction(...)` রাখুন। কী হয়? Error টা কোথায় উঠল, আর কতগুলো increment সফল হলো?
   SERIALIZABLE ব্যবহার করলে retry কেন "optional" না - এক লাইনে লিখুন।

2. **Write skew ঠিক করুন, SERIALIZABLE ছাড়া।** `src/anomalies.ts` এর `writeSkew()` এ admin গোনার
   query টা `SELECT ... FOR UPDATE` করে দিন (count এর সাথে FOR UPDATE চলে না - আগে admin row গুলো
   `SELECT id FROM members WHERE ... AND role = 'admin' FOR UPDATE` দিয়ে lock করুন, তারপর গুনুন)।
   REPEATABLE READ এ চালান। এখন কী হয়? B কি অপেক্ষা করে, নাকি error পায়?

3. **Contention কমান।** `lostupdate.ts` এ `CONCURRENT` ১০০ রেখেই প্রতিটা increment কে ১০টা আলাদা
   project এর মধ্যে ভাগ করে দিন (`project.id` এর বদলে ১০টা project এর একটা)। Optimistic (৬) এর
   retry সংখ্যা কত কমে? কেন?

4. **Transaction pass করতে ভুলে যান।** কৌশল ৩ এ `Project.update(...)` এর option থেকে `transaction`
   সরিয়ে দিন (lock নেওয়া `findByPk` এ রেখে)। চালান - কী হয়? (ইঙ্গিত: update টা এখন অন্য একটা
   connection এ, আর row টা lock করা আছে এই transaction এর হাতে। Pool এ মাত্র ১০টা connection।)
   সাবধান: script আটকে যেতে পারে - `Ctrl+C` দিয়ে থামান। এটা Sequelize এর সবচেয়ে সাধারণ
   production bug গুলোর একটা।

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-5.5-transactions/
├── docker-compose.yml   # শুধু Postgres (5436)
├── package.json
├── tsconfig.json
└── src/
    ├── db.ts            # Sequelize + Project (version: true), Task, Member model
    ├── retry.ts         # 40001 / 40P01 / OptimisticLockError চেনা (Zod দিয়ে), backoff + jitter সহ retry
    ├── anomalies.ts     # দুটো transaction এর হাতে সাজানো interleaving - ৫টা anomaly
    └── lostupdate.ts    # ১০০টা একসাথে +1, সাতটা কৌশল
```

## Verification status

এই মেশিনে চালিয়ে যাচাই করা হয়েছে (Node 26, Postgres 17, Sequelize 6.37):

- `tsc --noEmit` - clean pass, কোনো type error নেই, কোথাও `any` নেই
- `npm run anomalies` কয়েকবার চালানো - প্রতিবার হুবহু একই output
- `npm run lostupdate` তিনবার চালানো - ৩–৭ প্রতিবার ১০০/১০০; ১ আর ২ প্রতিবার ১০০ এর অনেক নিচে
