# Lesson 6.3 — Quorum in Practice: Replication Lag, Read-Your-Writes, Monotonic Reads

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 4.3):** In cache-aside, a task's title was updated but the cache wasn't invalidated, and the TTL is 10 minutes. What will the user see, and for how long? And even with invalidation, what race can put an old value back into the cache?

**Prerequisite:** Lesson 5.7 (Replication lag, read-your-writes, LSN), Lesson 5.8 (Partitions, shard keys), Lesson 5.9 (Quorums, `R + W > N`), Lesson 6.2 (Linearizable reads)

**By the end of this lesson you will be able to:**

1. Recognise the odd things users see when reading from replicas — not seeing their own write, time going backwards, the answer before the question — as three separate **session guarantees**, and know from measurements which fix repairs which and which it doesn't
2. Provide read-your-writes and monotonic reads together with a version token — and know where to keep the token so it works across multiple devices
3. Explain why `R + W > N` isn't enough in practice (failed writes, sloppy quorums), and know what read repair, hinted handoff and anti-entropy repair

**Tier:** 1 — Runnable Code (three seeded simulations)

---

## 0. Where TaskFlow Is Right Now

Since Lesson 5.7 the read pressure on TaskFlow has grown further. Now there are **three** read replicas alongside the primary, and Sequelize sends reads to the three in turn. 5.7's read-your-writes fix is also in place: a device that has written something in the last 5 seconds gets its reads from the primary (by keeping the time of the last write in a cookie).

Still, three new kinds of support ticket:

1. **"I saw the task, hit refresh, and it vanished! Refresh again and it comes back."** — the one we only named in 5.7.
2. **"I created a task on my phone, opened my laptop, and it isn't there."** — the cookie belongs to the phone; the laptop knows nothing about it.
3. **"The thread shows Karim's answer 'tonight at 9', but Rahim's question isn't there — it looks like Karim is talking to nobody."** — the comment table is now split across two partitions (5.8), with shard key `commentId`.

And an odd bug somewhere else: the notification unread count (in 5.9 it was treated as AP and kept in a leaderless quorum store, `N = 3, W = 2, R = 2`) — one user says the count shows 5, then 4, then 5 again. And yet `R + W > N`!

In 6.2 you saw that reading everything through consensus (linearizable reads) avoids all of these — but at the cost of a majority round trip on every read, which TaskFlow can't pay on millions of reads. Today's question: we'll read from replicas, cheaply — but **exactly what guarantee** do we give the user, and what does it cost?

---

## 1. Theory

### 1.1 "Eventually" — but what happens before then?

Reading from a replica means **eventual consistency** (5.9): once new writes stop, all replicas will eventually agree. But "eventually" has no bound, and until then anything may be visible. To the user that shows up as three kinds of breakage — three separate ones, with three separate fixes.

In 1994, researchers on Xerox PARC's Bayou project (Douglas Terry and colleagues) gave names to these "in-between" guarantees:

**Session guarantee** — even if the whole system isn't strongly consistent, a limited guarantee about **one user's own** sequence of reads and writes — "at least from your own point of view, things will look reasonable."

The core trick: instead of making the world consistent, keep **one user's view** consistent. That's much cheaper, because one user's history is small.

Three of them today:

| Guarantee              | When it breaks, the user sees                                       | TaskFlow ticket  |
| ---------------------- | ------------------------------------------------------------------- | ---------------- |
| Read-your-writes (5.7) | Their own fresh write is missing                                    | 2 (other device) |
| Monotonic reads        | Something seen once vanishes on the next read — time goes backwards | 1                |
| Consistent prefix      | The effect is there, the cause isn't — the answer, not the question | 3                |

(The other two — monotonic writes and writes-follow-reads — are about the order of writes; in a single-leader database the primary gives these on its own, so they're left out today.)

### 1.2 Replication Lag in Reality — the tail, not the average

In 5.7 you saw: on one machine, without load, the lag is ~2 ms. So why are there so many problems with three replicas?

Because problems are caused **not by the average lag — but by the tail.** Most of the time a replica is a few ms behind, but now and then it gets stuck for several **seconds**. And a replica applies writes in order — when one gets stuck, every write behind it is stuck too.

A lesser-known but very common reason a Postgres replica gets stuck: **a long query running on the replica.** Say an analytics report has been running on the replica for 40 seconds, and the WAL coming from the primary contains a change (say, rows removed by vacuum) that would damage the data that query is looking at. Postgres then has to choose: cancel the query, or **pause** applying the WAL and wait? The limit is set by `max_standby_streaming_delay` — **30 seconds** by default. That means with the default setting, a replica can fall a full 30 seconds behind for the sake of one long report, and during that time every user reading from that replica sees a world that's 30 seconds old.

(The other causes are familiar: a wave of WAL from a big migration, a slow disk on the replica, the network. And where to watch: `replay_lag` in `pg_stat_replication` on the primary, `now() - pg_last_xact_replay_timestamp()` on the replica — you saw these in 5.7's exercise.)

The exercise simulation models three replicas exactly like this: r1 always fast (~3 ms on average), r2 a bit slower and very occasionally stuck for 1.5 s, r3 slow (~25 ms on average) and now and then stuck for 3 s. (The numbers are assumed — the shape is real.)

### 1.3 Monotonic Reads — time must not go backwards

**Monotonic reads** — once a user has seen some state, no later read shows them a state **older** than that. (It's fine not to see anything newer — only going backwards is forbidden.)

How ticket 1 happens:

```
   time →        t1: refresh                         t2: refresh
   user ───────► r1 (fast, LSN 500)  ✓ task is there
                                           ──────► r3 (stuck, LSN 420)  ✗ task is gone!
   The load balancer takes turns — the two reads go to two different replicas, one behind the other
```

The simplest fix: **always send all of one user's reads to the same replica** (choose the replica by a hash of the userId or session). A replica itself never goes backwards — so consecutive reads from it are monotonic.

The exercise's `npm run session` — 2000 times "create a task, then read five times" (at the redirect +5 ms, then +30 ms, +300 ms, +1 s, +3 s; the first two on the same device, half of the rest on the other device):

```
                                              didn't see their own write     time went    reads on
   strategy                                   same device    other device    backwards    primary
   a. any replica (random)                    29.1%         0.9%         4.0%         0.0%
   b. a fixed replica per device              29.6%         1.0%         0.6%         0.0%
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

The sticky replica cut "time went backwards" from 4% to 0.6% — but not to zero. Where does the remaining 0.6% come from? The same **user**'s two **devices** are sticky to two different replicas — the phone to r1, the laptop to r3. To the user, time still goes backwards. And sticky has two more weaknesses:

- **The "didn't see their own write" column didn't change at all (29%)** — the sticky replica lags too; monotonic only means not going backwards, not seeing new things.
- **The guarantee is gone as soon as the replica changes.** If a replica dies or a new one is added (the hash changes), the user moves to another replica — which may be behind. And splitting by hash puts all of a "heavy" user's reads on one replica (a small version of 5.8's hot partition).

### 1.4 Read-Your-Writes, This Time Across Devices — Version Tokens

In 5.7 you saw three fixes for read-your-writes. TaskFlow picked the most practical: send reads to the primary for a device that has just written. Measure its cost and limits:

```
   c. cookie: primary if written within 5 s    0.0%         0.9%         0.3%        73.4%
```

Perfect on your own device — but two problems. First, **the other-device column (0.9%) is as bad as random** — the laptop doesn't see the phone's cookie (ticket 2). Second, **73% of reads go to the primary.** In this workload every write is followed by 5 reads within 5 seconds — so almost every read is "right after a write". The cookie doesn't know whether a replica is **actually** behind; it only looks at the time, and to be careful sends almost everything to the primary. Almost the whole benefit of having replicas is gone.

The better fix comes from 5.7's LSN idea, extended a little:

**Version token** — a marker of the newest version (the LSN, in Postgres) a client has written or seen; it's sent with every read, and only a replica that has reached at least that far answers.

```
   write      → the primary says "your write is at LSN 812"          → token = 812
   read       → r3: "I'm at 790"  ✗ not enough
              → r1: "I'm at 815"  ✓ answer                           → token = max(812, 815) = 815
   next read  → token 815 — a replica older than this will never answer
```

One token gives two guarantees: the token contains your own write's LSN → **read-your-writes**; the token contains the newest LSN you've seen → **monotonic reads**. And it goes to the primary only when **really** no replica is far enough ahead.

Now the only question: where does the token live?

```
   d. version token — on the device (cookie)   0.0%         0.8%         0.4%         3.4%
   e. version token — per user (on the server) 0.0%         0.0%         0.0%         3.4%
```

The code of the two is almost identical, and so is the primary load (3.4% — compared to the cookie's 73.4%). The only difference: (d) keeps the token in the device's cookie, so the laptop doesn't know the phone's token. (e) keeps it **on the server, under the user's name** — say `rw-token:{userId}` in Redis — so every read from any device sees that token. All three columns are zero.

In practice: in Postgres the token is `pg_current_wal_lsn()` (on the primary after writing) and the check is `pg_last_wal_replay_lsn()` (on the replica). MongoDB's "causal consistency" sessions do exactly this — the driver remembers each response's `operationTime` and sends it as `afterClusterTime` on the next read. DynamoDB doesn't offer it directly; there, you choose on every read — eventually consistent (cheap) or `ConsistentRead` (twice the price, from the leader).

### 1.5 Consistent Prefix — the answer first, the question later

Ticket 3 is a bit different, because here no user is reading anything of their own — they're watching a conversation between **two other people**.

**Consistent prefix read** — the reader sees the writes as a **prefix** of the order in which they happened: if they see a later one, they also see the earlier one. (They don't have to see everything — but no gaps.)

Reading from one replica gives you this automatically — a replica applies writes in order. The problem appears when the data is split across **several partitions**, each with its own replica and its own lag:

```
   partition 1 (replica stuck)                partition 2 (replica fast)
   Rahim: "when's the deploy?"  ← not yet     Karim: "tonight at 9"  ← already there
                              ╲                  ╱
                               the reader reads both at once
                               → the answer is there, the question isn't
```

The exercise's `npm run prefix` — 5000 question-answer pairs, each thread read 20 times:

```
   shard key       answer seen         answer present but question missing
   commentId            65426             250
   taskId               66059               0
```

250 odd threads — 0.4%, but every one is a ticket. And with `taskId`, **zero**, and that isn't luck: all of a task's comments are in the same partition, meaning one replica, meaning in order. A new reason for Lesson 5.8's shard-key rules: **keep data that is causally related (question → answer, a task → its comments) in the same partition.** TaskFlow's `workspaceId` shard key (5.8) is good for this reason too.

Where that isn't possible (say, an activity feed drawn from many partitions), each write has to carry its "dependency" — "this answer comes after that question" — and the reader hides the answer until it sees the dependency. That's the idea of **causal consistency**, and how to track dependencies (not with clocks) — that's Lesson 6.4's vector clocks.

### 1.6 Quorums in Practice — why `R + W > N` isn't enough

Now the unread-count bug. Lesson 5.9's reasoning: if `R + W > N`, the read quorum and the write quorum overlap in at least one replica, so a read sees the latest write. The reasoning is right — **if the write succeeds**. But what if the write fails?

In a leaderless store, a write failing means `W` replicas didn't confirm it. But on the replicas that did receive it, the write is **not removed** — there's no rollback. (Remember 5.7's sync commit timeout: "a timeout doesn't mean rollback". Same lesson, different place.)

The exercise's `npm run quorum`: `N = 3, W = 2, R = 2`. The write v1 reached only A; B and C timed out — the client was told "failed". Then 100 users × 5 reads, each read from two random replicas:

```
   read repair    saw the "failed" v1     v0 again after seeing v1     users who saw the value flip    final state
   off              325/500                 84                      58                A=v1 B=v0 C=v0
   on               500/500                  0                       0                A=v1 B=v1 C=v1
```

The first row is exactly the unread-count bug. A read that asks A sees v1; a read that asks B and C sees v0. 58 users saw the value flip — 5, 4, 5. `R + W > N` holds, and yet **there are no monotonic reads**.

**Read repair** — when a read gets answers from several replicas, write the newer value back to any replica that returned an old one.

In the second row read repair is on: zero flips. But **look at the final state**: A=v1 B=v1 C=v1. Read repair took the very write the client was told had "failed" and spread it to every replica, making it permanent. The system is now consistent — but not with the client's belief. So in a leaderless store, "write failed" really means: **"I don't know — maybe it happened."** The right answer is the same old two: retry (writing the same value is idempotent), or read to check.

A few more real-world gaps in `R + W > N`:

- **A write and a read at the same time:** the write is still reaching some replicas; meanwhile one read sees the new value and another the old — which is "correct" isn't defined.
- **Last-write-wins and clocks:** which of two writes is "newer" is often decided by timestamp — and 6.1 said clocks can't be trusted. (In 5.9's partition exercise, n4's clock running 300 ms behind lost a write — the full story in 6.4.)
- **Sloppy quorums:** below.

**Hinted handoff and sloppy quorums.** Amazon's Dynamo (the 2007 paper, ancestor of today's Cassandra and DynamoDB) adopted an availability trick: if one of a key's three "own" replicas is dead, some other live node takes the write, with a "hint" — "this actually belongs to C; hand it over when C comes back."

**Hinted handoff** — when a replica is temporarily unavailable, keep its share of the writes on another node and deliver them when it returns.

This makes the write succeed (W nodes got it) — but those W nodes may not be among the key's "own" N. Then the read quorum (R of the own N) and the write quorum may not overlap. This is called a **sloppy quorum** — `R + W > N` is on paper, but there's no guarantee of overlap. Giving up consistency for availability — 5.9's AP choice, this time inside a specific mechanism.

**Anti-entropy.** Read repair only fixes keys someone reads. Rarely read data can stay mismatched for years. So a process runs in the background:

**Anti-entropy** — a background process that regularly compares the replicas' full data to find and fix mismatches; usually with a Merkle tree (a tree of hashes of parts of the data — only the parts whose hashes don't match need to be sent). In Cassandra this is `nodetool repair`.

**Tunable consistency.** Cassandra lets you choose, on every query, how many replicas it needs: `ONE` (fast, weak guarantee), `QUORUM` (majority), `LOCAL_QUORUM` (majority in your own data center only — no cross-region round trip), `ALL`. That is, 5.9's PACELC choice, made separately for every query.

> **Trade-off Table — Guarantees when reading from replicas**

| Strategy                                | Read-your-writes      | Monotonic reads  | Consistent prefix        | Cost                                                         |
| --------------------------------------- | --------------------- | ---------------- | ------------------------ | ------------------------------------------------------------ |
| Any replica                             | No                    | No               | Yes within one partition | Zero                                                         |
| Sticky replica per user/device          | No                    | Yes per device\* | Yes within one partition | Uneven load; guarantee lost when replicas change             |
| Just wrote → primary (cookie)           | Yes per device        | No               | —                        | Heavy primary load (73% in the exercise)                     |
| Version token, on the device            | Yes per device        | Yes per device   | —                        | Carry the token, sometimes the primary (3.4%)                |
| Version token, per user (on the server) | Yes                   | Yes              | —                        | + a token in a shared store (Redis)                          |
| Causally related data in one partition  | —                     | —                | Yes                      | Constrains the shard-key choice (5.8)                        |
| Quorum + read repair                    | For successful writes | Mostly           | —                        | Extra writes on reads; a "failed" write may become permanent |
| Linearizable read (6.2)                 | Yes                   | Yes              | Yes                      | A majority/leader round trip on every read                   |

\* until the replica dies or changes

---

## 2. Interview Angle

**"What problems come with adding read replicas?"** — In 5.7 you learned to say "read-your-writes". Now name the whole family: "three session guarantees break — not seeing your own write, time going backwards on refresh, and in partitioned data seeing the effect before the cause." Then the fix: a version token (per user, on the server) — "with an LSN token I get read-your-writes and monotonic reads together, and I go to the primary only when truly no replica is far enough ahead." That sentence is a senior answer.

**"Some people see answers before questions in the timeline/feed — why?"** — Consistent prefix; the data is in several partitions, each with a different lag. Fix: related data in one partition (shard by thread/task/conversation); where that's impossible, track causal dependencies.

**"We read and write with QUORUM in Cassandra — so it's strongly consistent?"** — No, and give the reasons: a failed write stays on some replicas and spreads through read repair; with sloppy quorums the quorums may not overlap; and with concurrent writes, LWW depends on clocks. If you need "strong", use a consensus-based store (6.2), or Cassandra's lightweight transactions (which run Paxos inside — and are expensive).

**In real production:** most teams start with "just wrote → primary" and stay there — and that's often enough. As traffic grows, or with two clients (mobile + web), they move to a version token. Before either, two things: **alert on replica lag** (`replay_lag`, or `now() - pg_last_xact_replay_timestamp()` on the replica), and send long analytics queries to a separate replica — so that `max_standby_streaming_delay`'s 30 seconds don't land on the users' replica.

---

## 3. Key Takeaway

- Reading from replicas means eventual consistency — and before "eventually", users see three kinds of breakage; three separate **session guarantees**, three separate fixes
- The problems come from the **tail** of the lag, not the average — a Postgres replica can pause WAL replay for up to 30 seconds by default for one long query (`max_standby_streaming_delay`)
- **Monotonic reads:** a sticky replica reduces "time going backwards" (4% → 0.6%), but fixes none of multiple devices, replica changes, or showing your own write
- "Just wrote → primary" (cookie) works on your own device, but not on another device, and in the exercise pushed 73% of reads to the primary
- A **version token** (LSN) gives two guarantees together, going to the primary only when truly needed (3.4%); keep the token **per user, on the server** and it works on every device
- **Consistent prefix:** keep causally related data in one partition (sharding by `taskId` gave zero odd threads); otherwise track dependencies (6.4)
- `R + W > N` breaks on failed writes — a "failed" write stays on some replicas, and readers see the value flip; **read repair** stops that but makes the write permanent. Hinted handoff/sloppy quorums give up the guarantee for availability; anti-entropy fixes forgotten mismatches

---

## 4. New Terms (Glossary)

| Term                       | Meaning                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session Guarantee**      | A limited guarantee about one user's own sequence of reads and writes, even if the whole system isn't strongly consistent (Bayou, 1994)                   |
| **Monotonic Reads**        | Once you've seen some state, no later read shows an older one — time doesn't go backwards                                                                 |
| **Consistent Prefix Read** | The reader sees a prefix of the order in which writes happened — if the later one is visible, so is the earlier one                                       |
| **Version Token**          | A marker of the newest version a client has written or seen (e.g. an LSN); only replicas that have reached at least that far answer reads                 |
| **Read Repair**            | When a read finds a replica returning an old value, write the newer value back to it                                                                      |
| **Hinted Handoff**         | When a replica is temporarily unavailable, keep its share of the writes on another node and deliver them when it returns — this makes the quorum "sloppy" |
| **Anti-Entropy**           | A background process that regularly compares the replicas' data (usually with a Merkle tree) to find and fix mismatches                                   |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. A TaskFlow engineer says: "Why bother with version tokens? Just make every user sticky to one replica (a hash of the userId) — that gives monotonic reads, and the cookie already handles read-your-writes." Using the exercise's table, name three weaknesses of this proposal.
2. The per-user version token is kept in Redis: `rw-token:{userId}`. What happens if that Redis key is lost (a Redis restart, eviction)? Is data damaged, or does the guarantee just weaken? What TTL would you give the token, and why?
3. Three proposals have come in for TaskFlow's notification-count bug (5, 4, 5): (a) turn on read repair, (b) set `W = 3`, (c) move the count to Postgres. For each, say what it costs, what it fixes and what it doesn't. Which would you pick?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

- **Seeing your own writes isn't fixed** — a sticky replica lags too; in the table, (b)'s "same device" column is 29.6%, no better than random. Adding the cookie fixes that — but then comes (c)'s cost: 73% of reads on the primary.
- **Multiple devices** — sticky by userId sends the phone and laptop to the same replica (by device it wouldn't), so that monotonic gap is closed. But the cookie's read-your-writes still only works on one device — ticket 2 remains.
- **Replica changes** — if a replica dies or a new one is added (the hash split changes), the user moves to another replica, which may be behind — time goes backwards at exactly the moment the system is already under stress. And splitting by hash makes the load uneven: if everyone on one big team lands on the same replica, it's heavy.

A version token fixes all three together, and doesn't tie any user to any replica — any replica that's far enough ahead will do.

**Question 2:** If the token is lost, **data isn't damaged** — the token only decides which replicas it's OK to read from. Without a token (treated as 0), the read goes to any replica — meaning for that moment we fall back to (a) random: the user might once not see their own write, or once see time go backwards. The guarantee weakens temporarily, correctness doesn't. That's the sign of a good design: the token supports an optimisation, it isn't a source of truth. TTL: the token only matters within the replica-lag window — replicas usually catch up in a few seconds, in bad cases (`max_standby_streaming_delay`) in ~30 seconds. So the TTL should be somewhat more than that, say 5 minutes — after that every replica should certainly be ahead, the token is no longer needed, and millions of old keys don't pile up in Redis. (An alternative: keep the token with the session rather than in Redis — say in a SvelteKit server-side session — if the session itself is shared across all devices.)

**Question 3:**

- **(a) Read repair:** stops the flipping (84 → 0 in the exercise), low cost (occasionally one extra write on a read). But the "failed" write becomes permanent — the count may be one higher than the client believes. For an unread count that's acceptable (the error is small and the user fixes it by reading).
- **(b) `W = 3`:** every write must be confirmed by all three replicas — if one replica is slow or dead, **every** write fails (5.9's availability table). And the root problem doesn't go away: even with `W = 3`, a write can reach A while the others time out, and it isn't removed from A — the ghost of the failed write returns, only more often (since failing is now easier).
- **(c) Move to Postgres:** one primary, an atomic `UPDATE ... SET count = count + 1`, no flipping (reads from the primary or with a version token). Cost: the reasons 5.9 kept the count AP — availability during partitions and heavy write pressure — are gone; and every count write lands on the primary.

The choice: (a) for an unread count — the error is harmless, the cost is low, and the reasons for choosing AP remain. But if the same problem were in money or permissions, then (c), or consensus. And the question itself is a lesson: the answer to a bug like "count 5, 4, 5" is often not "raise the quorum numbers" — it's deciding what kind of guarantee this data **actually** needs.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (three deterministic simulations)

> **Ready to run in the repo:** [`exercises/lesson-6.3-session-guarantees/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.3-session-guarantees) — `npm install`, then `npm run session`, `npm run prefix`, `npm run quorum`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`src/replica.ts` holds a model of an async replica — lag, occasional stalls, in-order application, and `replayedAt()` (like Postgres's `pg_last_wal_replay_lsn()`). The other three files ask three questions of that model.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; each of the three scripts was run twice with identical output. The replica lag numbers are an assumed model — it's not the percentages but which strategy fixes what that's real. The README's experiments involve changing the code. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run all three scripts. For every **non-zero** cell of `session`'s table, write one line on why it isn't zero — especially (b)'s 0.6% "time went backwards" and (d)'s 0.8% "other device".

2. **Tail vs average** (experiment 1): set every `stallPerWrite` to 0 and run again. Which columns drop to almost zero? What does this teach you about monitoring TaskFlow's replicas — which number do you alert on, the average lag or something else?

3. **Waiting on the token** (experiment 2): instead of going to the primary when no replica is far enough ahead, wait up to 50 ms. How much does the primary percentage drop? On which TaskFlow pages is this wait acceptable, and where isn't it?

4. **`W = 3` in the quorum** (experiment 4): write your answer before running any code, then run it and compare.

5. **Design part:** write a plan for TaskFlow's read path: (a) where the version token is created (which Express middleware, which query after a write), where it lives (Redis key, TTL), and how Sequelize's reads choose a replica (tied in with 5.7's `useMaster`); (b) what the comment table's shard key is, and how you handle consistent prefix in the activity feed (which spans many tasks); (c) at what replica-lag number you alert, and where analytics queries run. Show where each of section 0's four tickets is closed by your plan.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (complete, including exit challenges), 6.1, 6.2
Current: 6.3 — Quorum in Practice: Replication Lag, Read-Your-Writes, Monotonic Reads
TaskFlow state: Nginx + Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; a version token on the read path (LSN, per user in Redis);
comment/activity shard key by task/workspace (consistent prefix); notification count
in a leaderless quorum store with read repair; alerts on replica lag, analytics on a separate replica
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility,
Replicated State Machine, Term, Randomized Election Timeout, Committed Entry,
Election Restriction, Session Guarantee, Monotonic Reads, Consistent Prefix Read,
Version Token, Read Repair, Hinted Handoff, Anti-Entropy
Weak spots: [where you got stuck — fill this in yourself]
Next: 6.4 — Distributed lock, logical clock: Lamport, vector clock
=======================
```

---

## 8. Next Lesson

Three lessons of Module 6 are done — so, following the rule in `main.md`, a short one-paragraph recap: **6.1** showed that in a distributed system you can't know whether "the other one is dead", and that an old leader doesn't know it's old — hence fencing tokens. **6.2** showed how consensus still makes safe decisions in the middle of all this — majority, terms, the election restriction — and what it costs. **6.3** showed that most reads don't pay that cost, reading from replicas instead, and how to give users limited but specific guarantees (session guarantees). One thread ran through all three without being untied: **time.** "Which write is newer?", "which happened first?", "has the lease expired?" — every time we said "clocks can't be trusted, in 6.4."

Run the exercise and send it over — especially your explanations in #1 and your plan in #5. When you are ready, write `next` — Lesson 6.4: **Distributed locks and logical clocks — Lamport and vector clocks.** Why two machines' clocks never agree, why NTP can push time backwards, how last-write-wins silently loses writes — and how to know "which happened first" without a clock: Lamport clocks and vector clocks.
