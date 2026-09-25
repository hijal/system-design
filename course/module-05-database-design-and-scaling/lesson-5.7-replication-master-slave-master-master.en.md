# Lesson 5.7 — Replication: Primary-Replica, Read Scaling, and Failover

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 3.4):** How do health checks and failover work together in a load balancer? When a backend server suddenly dies, how long can it take the load balancer to notice and move traffic away — and what does that depend on?

**Prerequisite:** Lesson 1.6 (SPOF), Lesson 5.3 (WAL), Lesson 5.5 (Transactions), Lesson 5.6 (Pools)

**By the end of this lesson you will be able to:**

1. Explain how data travels from a Postgres primary to a replica (WAL streaming), and scale reads with a read replica in Sequelize
2. Recognise the "read-your-writes" bug born of replication lag, and know — measured — where each of the three fixes puts its cost
3. Explain the trade-off between async and sync replication, the steps of failover, and what data a failover can lose (RPO); and why and when to use multi-leader replication

**Tier:** 2 — Infra Setup (a primary + replica in Docker, with TypeScript scripts)

---

## 0. Where TaskFlow Is Right Now

In Module 5 we've made TaskFlow's database much better — schema, indexes, transactions, pools. But it is still a single PostgreSQL server. Two problems are raising their heads:

1. **Read pressure.** Metrics say about 90% of TaskFlow's database queries are reads — dashboards, task lists, search. The primary's CPU hits 80% at peak. The cache (Module 4) helped, but not every read can be cached.
2. **Lesson 1.6's SPOF.** There are 8 app servers and a load balancer — but one database. Last month that server's disk failed. Restoring from backup took 40 minutes, and 6 hours of data since the last backup was lost.

The fix seems simple: keep a **copy** of the database. Read from the copy, and if the original dies, make the copy the original.

The team did it — a read replica was added, and Sequelize was told to send reads there. The primary's CPU dropped. Everyone was happy. Then the first support ticket:

> "I created a new task, it said 'Saved!' — but the task isn't in the list. It shows up when I refresh."

Today's lesson is the science of keeping copies — and the new kinds of problems that appear as soon as copies exist. In the exercise, all of this is measured on a real Postgres primary + replica running in Docker.

---

## 1. Theory

### 1.1 Why replicate — three reasons, and one misconception

**Replication** — keeping the same data on several database servers, and keeping them in step. Three reasons:

1. **Read scaling** — spreading reads across several copies (TaskFlow's problem 1)
2. **High availability** — the copy takes over when the original dies (problem 2)
3. **Latency** — keeping a copy close to the users (in another region — Lesson 10.8)

**The misconception: "we have a replica, so we don't need backups."** If a developer accidentally runs `DELETE FROM tasks`, the replica **faithfully copies it** — within milliseconds every task is gone from the replica too. Replication protects against hardware failure, not human mistakes. Backups (and the ability to go back to a specific moment — point-in-time recovery) are a separate thing, and you need both.

### 1.2 Leader-follower — how Postgres copies

The most common kind:

**Leader-follower replication** — one server (the leader, or primary) takes every write; the others (followers, or replicas) only copy the leader's changes, and only serve reads. (Older books and the curriculum call it "master-slave"; today it is usually called primary-replica or leader-follower.)

How does Postgres do it? Remember Lesson 5.3's **WAL** — every change is written to the WAL before it reaches the data files. The replica takes exactly that WAL stream and replays it locally — just as the primary does itself after a crash:

```
              write (INSERT/UPDATE)                    read (SELECT)
                     │                                       │
                     ▼                                       ▼
            ┌─────────────────┐   WAL stream    ┌──────────────────────┐
            │     PRIMARY     │ ──────────────► │       REPLICA        │
            │  read + write   │  (every change, │  reads only          │
            │                 │   almost        │  gets WAL → replays  │
            │  WAL ─► data    │   immediately)  │  WAL ─► data          │
            └─────────────────┘                 └──────────────────────┘
```

If you try to write to the replica, Postgres returns an error — it is read-only (the exercise's experiment 2). In the exercise's `docker-compose.yml`, the replica takes a full copy of the primary with `pg_basebackup -R` on first start, then begins streaming:

```
 application_name |   state   | sync_state
------------------+-----------+------------
 walreceiver      | streaming | sync
```

**Read replicas in Sequelize** — it's built in. The exercise's connection:

```typescript
export const app = new Sequelize({
	dialect: 'postgres',
	logging: false,
	replication: {
		read: [{ host: HOST, port: REPLICA_PORT, ...credentials }],
		write: { host: HOST, port: PRIMARY_PORT, ...credentials }
	},
	pool: { max: 10, min: 0, idle: 10_000 }
});
```

Sequelize now does this by itself: every `SELECT` **outside** a transaction → the replica (taking turns if `read` lists several); everything else (`INSERT`, `UPDATE`, everything inside a transaction) → the primary. Nothing in the code needs to change — and that's exactly why the next section's bug slips in so easily.

### 1.3 Replication lag — the copy is always a little behind

There is a gap between a commit on the primary and it becoming visible on the replica — sending the WAL, receiving it, replaying it. **Replication lag** — the time from a change being committed on the primary to it becoming visible on the replica.

Postgres's default replication is **asynchronous** — the primary commits and immediately tells the client "success", without waiting for the replica. The replica catches up afterwards.

Now TaskFlow's bug. The exercise's `npm run lag` does exactly what TaskFlow's code does: `Task.create(...)` (goes to the primary), then immediately `Task.findByPk(id)` (Sequelize sends it to the replica):

```
situation                               not found   time until visible on the replica
normal (same machine, no load)          199/200     p50    1.8 ms   p99    2.3 ms
replica 200 ms behind (simulated lag)    50/50      p50  200.1 ms   p99  200.9 ms
```

The first line holds the most important number in this lesson. The primary and replica are **on the same machine**, there's no load, the lag is only **~2 ms** — yet 199 times out of 200 the newly created task couldn't be found. Because the next read arrives faster than 2 ms. The question is never "how small is the lag" — it is **"is the lag zero"**, and with async replication it never is.

In real life the lag gets bigger: a replica busy with heavy reads, a wave of WAL from a big migration, network trouble. Then lag can reach seconds, even minutes. The exercise simulates this in the second line — deliberately keeping the replica 200 ms behind (`recovery_min_apply_delay`, a real Postgres setting).

### 1.4 Read-your-writes — three fixes, three places to pay

**Read-your-writes consistency** — whatever a user wrote themselves, they will definitely see on their next read (seeing other people's writes a little late is acceptable). TaskFlow's bug broke exactly this.

The exercise's `npm run ryw` — the replica 200 ms behind, "write → read immediately" 30 times per strategy:

```
strategy                                    found   write (median)   read (median)
a. nothing (read from the replica)           0/30        2.1 ms         0.4 ms
b. useMaster: true (from the primary)       30/30        2.1 ms         0.4 ms
c. LSN token — wait until replica catches up 30/30       1.8 ms       200.7 ms
d. synchronous_commit = remote_apply        30/30      202.2 ms         0.7 ms
```

All three fixes are correct (30/30). But look at the numbers — each one **moves the cost somewhere different**:

**b. Read your own writes from the primary.** In Sequelize, `Task.findByPk(id, { useMaster: true })`. The simplest, no waiting. The cost: those reads land on the primary again — the very load the replica was added to remove. A refined form in practice: "all reads of a user who wrote something in the last 10 seconds go to the primary" (keeping the last write time in the session). Most users mostly just read, so the extra load on the primary is small.

**c. The LSN token.** In Lesson 5.3 you saw that every position in the WAL has an address — the LSN. After writing, remember the primary's current LSN; before reading, check whether the replica has got that far (`pg_last_wal_replay_lsn()`), and wait if it hasn't. The read stays on the replica, and it's correct. The cost: the **read** is slower — you wait as long as the replica is behind (~200 ms here). In production this LSN can be handed to the client as a token (a cookie or a header), so its next request honours it too — even if it lands on a different app instance.

**d. Synchronous replication.** The commit itself waits until the replica has applied the change. Then a finished commit means it is on the replica too. The exercise's code:

```typescript
app.transaction(async (transaction) => {
	await app.query('SET LOCAL synchronous_commit = remote_apply', { transaction });
	return Task.create({ title: 'remote-apply' }, { transaction });
});
```

The cost: the **write** is slower — every write is as slow as the replica (2 ms → 202 ms here). Because of `SET LOCAL`, it applies only to this transaction — every other write stays async as before.

**Which when?** For most web apps, (b) — "let users who just wrote read from the primary" — is the most practical. (c) when the read load truly can't go to the primary. (d) only for the few writes where the next read absolutely must see them, and the write latency is acceptable.

And one more problem I'll just name here: with several replicas, one user's two consecutive reads can go to two different replicas — one further behind. The user sees a task, refreshes, and the task **vanishes** — as if time ran backwards. The fix (monotonic reads) is in Lesson 6.3.

### 1.5 Synchronous replication — the cost isn't only speed

**Synchronous replication** — the primary waits for at least one replica to confirm a change before calling the commit successful. (Its opposite, the default, is **asynchronous** — the primary doesn't wait.)

It sounds like the answer to everything — every commit in two places, no lag bugs, nothing lost in failover. But there are two costs, and most people don't know the second.

**Cost 1 — every write is as slow as the slowest sync replica.** You saw it in 1.4's (d): 2 ms → 202 ms. With the replica in another data center, every write adds a network round trip.

**Cost 2 — without the replica, writes stop.** Step 4 of the exercise's `npm run failover`: the replica cut off from the network, then a sync write:

```
after 3 seconds: is the commit still stuck waiting for the replica? yes
→ the app's timeout ran out of patience; the query was cancelled
COMMIT came back after 3.0s, with a warning from Postgres:
  WARNING: canceling wait for synchronous replication due to user request — The transaction
  has already committed locally, but might not have been replicated to the standby.
```

Notice two things. First, the commit would have waited **forever** — no replica means no sync writes. That's the cost in availability. Second — and this is subtle — even after the app cancelled, the transaction **was committed on the primary**. "Timeout = rollback" is false. The app thinks the write failed, yet the data is on the primary. (Tie it to 5.5's retries: if the app now retries, the same task may be created twice — unless the write is idempotent, Lesson 2.5.)

That's why in practice two middle paths are usually taken:

- **Any one of several replicas:** in Postgres, `synchronous_standby_names = 'ANY 1 (r1, r2)'` — confirmation from either of two replicas is enough. If one dies, writes continue through the other.
- **Sync only for important writes** — like the exercise, `SET LOCAL synchronous_commit = remote_apply` only in payment-like transactions; everything else async.

### 1.6 Failover — and the data it loses

Making a replica the new primary when the primary dies — **failover**. The steps:

```
1. Detect           — is the primary really dead? Or is the network just slow? (getting it wrong is dangerous, see below)
2. Choose a replica — if there are several, the most up-to-date one (it loses the least data)
3. Promote          — tell the replica "you are the primary now, take writes" (pg_promote() in Postgres)
4. Move the app     — change the connection address (DNS, a proxy, or config)
5. Stop the old one — so that if the old primary comes back, it no longer thinks it's the primary
```

The exercise's `npm run failover` plays out the whole story: replica cut off → more events written to the primary → primary dies → replica promoted. At the end, a count on the new primary:

```
before            10/10  ✓
async              0/20  ✗ lost — even though the user was told "saved"
sync               0/1  ✗ lost — the app got a timeout, but it had been committed on the old primary
after-failover     1/1  ✓
```

**This is the real cost of async replication.** Whatever the replica hadn't received no longer exists anywhere after the promotion. The user saw "Saved!" for 20 tasks — and they are gone for good. In practice the lag is usually small, so what's lost is the last few milliseconds or seconds of writes — but not zero.

Two numbers are used for this in both interviews and production:

- **RPO (Recovery Point Objective)** — the maximum **amount of time's worth of data** it's acceptable to lose in a disaster. With async replication RPO ≈ the replication lag; with sync ≈ zero. In TaskFlow's earlier backup-only state, the RPO was 6 hours.
- **RTO (Recovery Time Objective)** — **how quickly** the system must be running again after a disaster. Restoring from backup took TaskFlow 40 minutes; promoting a replica takes seconds to a few minutes (depending on how long detection takes).

(Tie it to Lesson 1.5's SLA/SLO — RPO and RTO are exactly that kind of promise, about data and downtime.)

**Manual or automated failover?** Someone staying up at 3 a.m. to run `pg_promote()` by hand isn't realistic. Tools like Patroni for Postgres, or managed cloud databases (e.g. AWS RDS Multi-AZ), automate the whole process. But automated failover has its own danger — step 1's question. The primary is actually alive, just cut off by a network problem — and the system promotes a replica. Now there are **two** primaries, both taking writes, and the data is splitting in two directions. This is called **split brain** (you'll see its seed yourself in the exercise's experiment 4), and it is the heart of Lesson 6.1 — why knowing "is the other one dead?" is so hard in a distributed system.

### 1.7 Multi-leader — when writes are needed in several places

So far, a single leader. But sometimes you need to accept writes in several places:

- **Multiple regions:** TaskFlow's users are in Dhaka, London and New York. With one leader in Singapore, every write from London pays 200+ ms of network. One leader per region makes writes locally fast.
- **Offline clients:** a mobile app that lets you create tasks without internet — every phone is effectively its own "leader" that syncs later.
- **Collaborative editing:** Google Docs-like — everyone writes in their own copy, merged later.

**Multi-leader replication** — several servers (or devices) accept writes and copy each other's changes. (The old name is "master-master".)

There's one problem, and it's a big one: **write conflicts**. On the Dhaka leader Rahim changes task #42's title to "Fix login"; at the same moment on the London leader Karim changes it to "Fix signup". Both succeeded, both were shown "Saved!". Now the two leaders receive each other's changes — which one stays?

The common approaches:

- **Last write wins (LWW)** — keep the later one by time and discard the earlier. Simple — but one person's write is silently lost (Lesson 5.5's lost update, this time across two continents). And deciding "later" requires the two servers' clocks to agree — which they don't (Lesson 6.4).
- **Merge** — keep both values and ask the user to choose, or use a data type that merges by itself (a CRDT — e.g. a counter that adds up the increments from both sides).
- **Avoid the conflict** — always write a given piece of data on the same leader (e.g. all of a workspace's writes in its "home region"). The most common in practice.

So the general rule: **avoid multi-leader until you truly need it.** For an app like TaskFlow, single-leader + read replicas (read replicas in other regions if needed) is almost always enough.

And there's a third kind — **leaderless**, where there is no leader and the client itself writes to several nodes at once and reads from several (the Cassandra and DynamoDB idea). How it stays consistent — quorums, `R + W > N` — is Lesson 5.9's topic.

> **Trade-off Table — kinds of replication**

| Kind                             | Where writes go       | Data lost in failover           | Write latency                | When                                 |
| -------------------------------- | --------------------- | ------------------------------- | ---------------------------- | ------------------------------------ |
| Single-leader, async (default)   | One primary           | The last few ms–s (the lag)     | Fast                         | Most apps                            |
| Single-leader, sync (at least 1) | One primary           | Nearly zero                     | Equal to the slowest replica | Money; with `ANY 1 (...)`            |
| Multi-leader                     | Several leaders       | Writes can be lost in conflicts | Local, fast                  | Multi-region writes, offline clients |
| Leaderless (quorum)              | Several nodes at once | Depends on the quorum           | The slowest in the quorum    | Huge writes, high availability (5.9) |

---

## 2. Interview Angle

**"The database has heavy read load — how do you scale it?"** — the order of a good answer: first caching (Module 4), then read replicas. But as soon as you say "replica", add on your own: "replication is async, so there'll be lag — users won't see their own writes, so I'll send the reads of users who just wrote to the primary." That's exactly the follow-up the interviewer wanted to ask — you said it first.

**"What happens when the primary database dies?"** — the failover steps, with RPO and RTO numbers. "With async replication the last few seconds of writes can be lost; if that's unacceptable (payments), sync replication for those writes, with `ANY 1` so writes continue even if one replica dies." Bonus: mentioning the risk of split brain.

**"With master-master we'd get writes in both places — isn't that good?"** — give a conflict example (two people, the same task, the same moment, two regions), the cost of LWW (silently lost writes), and say when it's truly needed (multi-region write latency, offline).

**In real production:** most teams don't run replication themselves — managed databases (RDS, Cloud SQL, etc.) provide replicas and failover. But lag bugs, data lost in failover, and changing connection addresses remain the app's responsibility — no managed service solves those for you.

---

## 3. Key Takeaway

- Replication serves three purposes — read scaling, high availability, latency; but **a replica isn't a backup** — a mistaken `DELETE` gets copied too
- In Postgres a replica replays the primary's **WAL stream**; replicas are read-only; Sequelize's `replication` config sends reads outside transactions to the replica automatically
- With async replication the lag is never zero — in the exercise, even with ~2 ms of lag, 199 times out of 200 the user didn't see their own write
- Three fixes for **read-your-writes**, three places to pay: `useMaster` (load on the primary), an LSN token (slower reads), `remote_apply` (slower writes)
- The cost of sync replication: writes as slow as the slowest replica, writes stop without the replica, and **a cancel isn't a rollback** — use `ANY 1 (...)` and sync only for important writes
- Failover: detect → choose → promote → move the app → stop the old one; async loses the latest writes (**RPO**), how fast you recover (**RTO**); a wrong detection means split brain
- Multi-leader only when truly needed (multi-region writes, offline) — paying for write conflicts and LWW's silent data loss

---

## 4. New Terms (Glossary)

| Term                             | Meaning                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Leader-Follower Replication**  | One server (the primary) takes every write; the others (replicas) copy its changes and serve only reads — formerly master-slave         |
| **Replication Lag**              | The time from a commit on the primary to it becoming visible on the replica                                                             |
| **Read-Your-Writes Consistency** | The guarantee that whatever a user wrote, they will definitely see on their next read                                                   |
| **Synchronous Replication**      | The primary waits for at least one replica to confirm a change before calling the commit successful (the opposite is asynchronous)      |
| **Failover**                     | Making a replica the new primary when the primary dies, and moving the app to it                                                        |
| **RPO / RTO**                    | The maximum amount of time's worth of data that can be lost in a disaster (RPO), and how quickly the system must be running again (RTO) |
| **Multi-Leader Replication**     | Several servers (or devices) accept writes and copy each other's changes — formerly master-master                                       |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. A TaskFlow user changes their name and is immediately redirected to their profile page — which shows the old name. A developer says, "Easy — let's read everything from the primary." What's wrong with this fix? How would you fix it without losing most of the benefit of having a replica?
2. TaskFlow's payments team says: "not a single subscription payment record may be lost." The rest of the team says: "making every write sync will slow down the whole app, and if the replica dies nobody can create tasks." Write a plan that keeps both sides happy.
3. At 2 a.m. monitoring showed the primary database hadn't responded for 30 seconds. Automated failover promoted a replica. 45 seconds later it turned out the primary had been alive all along — a network switch had a problem — and now it's responding again. What dangers can arise? What would have prevented this?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Sending every read to the primary throws away the whole benefit of the replica — the primary's CPU is back at 80%, and the replica just sits there. The better fix is to narrow the problem: it exists only when reading **your own recent writes**; for every other read, data a few ms or seconds old is fine. So: keep `lastWriteAt` in the session of the user who wrote; for the next few seconds (more than the real lag, say 10 seconds) send their reads to the primary with `useMaster: true`, and everyone else's reads to the replica. Most users mostly just read, so the extra load on the primary is small. For extra precision, use an LSN token instead of time (1.4's c) — "read from the replica once it has reached this LSN." And in this particular case there's an even simpler way: return the new name in the update's response and let the frontend show it — no need to read from the database again at all.

**Question 2:** Not every write needs to be sync — only where RPO = zero is essential:

- `SET LOCAL synchronous_commit = remote_apply` in payment transactions (or at least `on`/`remote_write`, to ensure it reached the replica's disk); tasks, comments and everything else stay on the default async — their write latency doesn't change.
- `synchronous_standby_names = 'ANY 1 (r1, r2)'` — two replicas, confirmation from either is enough. Payments continue even if one replica dies.
- Idempotent payment writes (Lesson 2.5's idempotency key) — because a timeout on a sync commit isn't a rollback (1.5); if the app thinks it failed and retries, the same payment mustn't happen twice.
- And regular backups + point-in-time recovery — because a replica doesn't protect against human error.

**Question 3:** **Split brain.** The old primary comes back still believing it's the primary, while the new primary is also taking writes. Some app instances (with connections to the old address, or stale DNS caches) write to the old one, the rest to the new one — the data splits in two, and merging it later is nearly impossible (the same id meaning different tasks on each side, and so on). On top of that, the old primary's writes that the replica never received (async lag) aren't on the new primary. How to prevent it: **fencing** — definitively stopping the old primary during failover (cutting its power or network, or detaching it from storage) so it can't take writes even if it comes back; and making the failover decision from a single trusted place (tools like Patroni use a consensus store — the idea behind Lesson 6.2's Raft). The 30-second timeout is worth questioning too — too short and a momentary network blip causes an unnecessary failover; too long and the RTO grows in a real disaster.

</details>

---

## 6. Practical Exercise

**Tier 2 — Infra Setup** (with TypeScript scripts)

> **Ready to run in the repo:** [`exercises/lesson-5.7-replication/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.7-replication) — `docker compose up -d --wait && npm install`, then `npm run lag`, `npm run ryw`, `npm run failover` (after the last one, `docker compose down -v && docker compose up -d --wait`). The full setup, acceptance criteria and experiments are in that folder's `README.md`.

A real Postgres streaming-replication cluster in Docker — a primary and a replica (built with `pg_basebackup -R`). The app connects through Sequelize's built-in `replication` config, so the bug arises exactly as in TaskFlow's real code. The `failover` script itself uses Docker to cut off the replica, kill the primary, and promote the replica. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**An honest note:** per `main.md`, a Tier 2 exercise isn't supposed to claim it was run and verified, because the sandbox usually has no Docker. This machine did have Docker, so it was run: `tsc --noEmit` is clean; the three scripts run in order from a fresh cluster; `lag` and `ryw` twice each; `failover` twice (with a reset each time) — the same results. Still, run it on your machine and compare with the README's output.

**Once the setup is verified, do these five:**

1. Run the three scripts. How many "not found" do you get in `lag`'s first line on your machine? Write one line on why the bug happens almost every time even with such a small lag.

2. **Read the lag from the database** (README experiment 3): while `npm run ryw` is running, look at `write_lag`, `flush_lag` and `replay_lag` in `pg_stat_replication`. Why are the three different, and which one is close to 200 ms?

3. **The availability cost of sync replication** (experiment 1): stop the replica and run a `remote_apply` write. What happens? Then think — if every TaskFlow write were sync, what would happen to the whole app when a replica's disk filled up?

4. **The seed of split brain** (experiment 4): after `failover`, start the old primary again and compare the `events` in both databases. Which events are where? If half the app's instances kept writing to the old one, what would things look like an hour later?

5. **Design part:** write a replication plan for TaskFlow: how many replicas, sync or async (which for which writes), how you'll handle read-your-writes, the RPO and RTO targets (with numbers), manual or automated failover, and how you'll avoid split brain. Keep Lesson 5.6's pool arithmetic in mind — how does the connection math change when replicas are added?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
Current: 5.7 — Replication
TaskFlow state: Nginx + 4–8 Express instances, CDN, Redis cache; PostgreSQL primary +
read replica (async streaming); Sequelize read replication; reads of users who just wrote
go to the primary (read-your-writes); sync commit for payments; a failover plan (RPO/RTO)
Terms learned (Module 5 so far): Relational Model, Schema-on-write,
Schema-on-read, Access Pattern, Document Store, Wide-column Store,
Polyglot Persistence, Cardinality, Junction Table, Data Anomaly,
Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion, Leader-Follower Replication,
Replication Lag, Read-Your-Writes Consistency, Synchronous Replication,
Failover, RPO/RTO, Multi-Leader Replication
Weak spots: [where you got stuck — fill this in yourself]
Next: 5.8 — Sharding & Partitioning
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your explanation of the three lags in #2 and your replication plan in #5. When you are ready, write `next` — Lesson 5.8: **Sharding & Partitioning** — replicas scale reads, but every write still goes to one primary. When writes no longer fit on one machine, or the data no longer fits on one disk, the data itself has to be split. How to split it (range, hash), by which key, why hot partitions happen, and what happens to JOINs and transactions after the split — hands-on with Postgres partitioning.
