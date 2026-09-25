# Lesson 5.9 — The CAP Theorem, ACID vs BASE, and Quorums (R + W > N)

**Module 5 — Database Design & Scaling**

> **Spaced Repetition (Lesson 4.2):** Where exactly is the risk of losing data in write-behind caching? And for what kind of data is that risk acceptable?

**Prerequisite:** Lesson 5.5 (ACID), Lesson 5.7 (Replication, RPO), Lesson 5.8 (Sharding)

**By the end of this lesson you will be able to:**

1. State correctly what the CAP theorem says (and what it doesn't), and explain why claims like "a CA database" are meaningless
2. Use PACELC to show that a trade-off runs every day even without partitions — latency vs consistency
3. Show with a measured simulation why `R + W > N` prevents stale reads in a leaderless system; and use the difference between ACID and BASE to decide which parts of TaskFlow go which way

**Tier:** 1 — Runnable Code (a single-process simulation, no Docker needed)

---

## 0. Where TaskFlow Is Right Now

At the start of Module 5, TaskFlow's data lived on one machine. Now: a primary and a read replica (Lesson 5.7), a sharding plan (Lesson 5.8), and a new proposal — a second data center in Singapore for customers in Asia.

Last month the network link between Dhaka and Singapore was cut for three minutes. The CTO now brings a question whose answer should be decided in advance:

> "Next time the link goes down, what will users in Singapore see? Will they keep working — in which case their data may disagree with Dhaka's? Or do we show them an error until the link is back?"

The same week, a database vendor's sales pitch: "Our database is **CA** — consistent **and** available, at the same time!"

Today's lesson answers both. The CAP theorem is the most famous — and most misunderstood — idea in distributed systems. It comes up in interviews almost for certain, and the wrong answer is the most common one.

---

## 1. Theory

### 1.1 CAP — what it really says

The popular version: "Consistency, Availability, Partition tolerance — pick any two of the three." That version is misleading. The correct version:

**CAP theorem** — when a **network partition** happens in a distributed system, the system must choose: either keep every answer consistent (consistency), or answer every request (availability) — both at once are impossible.

The three words, in their precise meaning:

- **Network partition** — network communication between some nodes stops, even though the nodes themselves are alive and running. Neither side knows whether the other side is dead or merely cut off.
- **Consistency (in the CAP sense)** — here it means **linearizability**: the system behaves as if there were only one copy of the data — once a write succeeds, anyone reading from any node sees that write (or something later). (It has nothing to do with the "C" of ACID from Lesson 5.5 — same name, different meaning.)
- **Availability (in the CAP sense)** — every request that reaches a live node gets a normal (non-error) response.

Why both at once are impossible can be shown with just two nodes:

```
   Client 1                                        Client 2
      │ write: title = "Fix signup"                    │ read: title?
      ▼                                                ▼
  ┌────────┐        ✂ network cut ✂             ┌────────┐
  │ Node A │  ──────────── ✗ ────────────────  │ Node B │
  │new value│                                   │old value│
  └────────┘                                    └────────┘

  What does Node B tell Client 2 now?
    (a) return the old value  → available, but not consistent (A has the new value)
    (b) return an error / wait → consistent, but not available
    There is no third way — B has no means of learning the new value.
```

**This is where the answer to the "CA" claim comes from:** partition tolerance isn't an option you can "not pick". Several machines means a network, and networks break. A system that claims to be CA either (1) runs on a single machine — then it isn't distributed at all, and CAP doesn't apply; or (2) isn't saying what it does during a partition — and when a partition comes, it will have to give up either C or A. So the right question is always: **"what do you give up during a partition?"** — CP or AP.

### 1.2 What a partition looks like — and why it isn't rare

A partition doesn't only mean someone cutting a cable:

- A problem with the link between two data centers (TaskFlow's three minutes)
- An overloaded network switch
- A long GC pause on a node — for a few seconds it talks to nobody; to the others it is "cut off"
- A problem inside the cloud provider's network

And the most important point: **from a node's point of view, "the other one is dead" and "the network to the other one is cut" are indistinguishable.** In both cases, the answers simply stop coming. This uncertainty is the core difficulty of distributed systems — the source of Lesson 5.7's split brain, and the whole subject of Lesson 6.1.

### 1.3 CP vs AP — seen with your own eyes

The exercise's `npm run partition` — 5 nodes, 3 in Dhaka (n1 n2 n3), 2 in Singapore (n4 n5), the link between them cut. Two people change the same task's title: Rahim (Dhaka, real time 100 ms) to "Fix login", Karim (Singapore, real time 200 ms — **later**) to "Fix signup".

**CP — a strict quorum:** a write or read needs at least 3 of the 5 nodes (a majority) to succeed.

```
Rahim (Dhaka, 3 nodes)        wrote "Fix login"   → success ✓
Karim (Singapore, 2 nodes)    wrote "Fix signup"  → failed ✗ — saw an error, must try again
reads during the partition: Dhaka → "Fix login",  Singapore → ✗ no answer (no quorum)
after the network heals, everyone reads: "Fix login"
```

Everyone always saw the same truth — but users in Singapore couldn't do anything for three minutes. The side with the majority keeps going, the other stops — and because of this rule, the two sides can never write different things at the same time.

**AP — any node accepts writes, merged later with last-write-wins (LWW).** And as in real life, Singapore's n4 has a clock 300 ms behind:

```
reads during the partition: Dhaka → "Fix login",  Singapore → "Fix signup"  ← two truths on two sides
the network healed — two versions found:
  "Fix login" (Rahim), timestamp 100 ms
  "Fix signup" (Karim), timestamp -100 ms
LWW winner: "Fix login" (Rahim)
```

Both kept working, both saw "saved". But once the network came back, Karim's write — which actually happened **later** — **was silently lost**, because "later" was decided by n4's wrong clock. No error, no log. (Tie it to Lesson 5.7's multi-leader conflicts — and why wall clocks can't be trusted is Lesson 6.4.)

**And you've already seen this choice** — in Lesson 5.7's Postgres exercise:

- **Sync replication, replica cut off:** the commit waited forever — the primary stopped accepting writes. That's the **CP** choice: better no answer than a wrong one.
- **Async replication, then failover:** writes kept going — but 20 "saved" tasks weren't on the promoted replica, and were lost. That's an **AP**-style choice: always accept writes, at the risk of losing some.

So the same database (Postgres) can go either way depending on configuration. The answer to "is Postgres CP or AP?" is: **it depends on how you run it.**

### 1.4 PACELC — a choice even without a partition

A big limitation of CAP: it only talks about the moment of a partition, and partitions are rare. But a trade-off runs during the other 99.99% of the time too, and CAP doesn't mention it.

**PACELC** — an extended form of CAP: if there's a **P**artition, choose between **A**vailability and **C**onsistency; **E**lse (no partition), choose between **L**atency and **C**onsistency.

You've already measured the "Else" part twice:

- **Lesson 5.7:** `remote_apply` (consistent read-your-writes) → each write went from 2 ms to 202 ms. You paid latency to buy consistency.
- **Today's quorum simulation (1.5):** `W = 3` → each write p50 ~40 ms, waiting for the replica in another data center; `W = 1` → 2.3 ms, but up to 10% stale reads.

No network broke — yet a choice still had to be made. In practice, this "EL/EC" choice matters more in everyday design decisions.

### 1.5 Quorums — `R + W > N`

In Lesson 5.7 you saw leader-follower replication: every write goes to one leader. In systems like Cassandra, Riak and DynamoDB, which come from the ideas of (Amazon's) Dynamo, there is no leader — the client (or a coordinator) writes directly to several replicas and reads from several. It's controlled by three numbers:

- **N** — how many copies of each piece of data
- **W** — how many replicas must confirm a write before it is called successful
- **R** — how many replicas a read takes answers from (the newest version among them is used)

**Quorum** — the minimum number of replicas that must agree for an operation to succeed; with `R + W > N`, the read group and the write group always overlap on at least one replica.

Why do they overlap? N = 3, W = 2, R = 2:

```
replica:      A      B      C
write (W=2):  ✓      ✓      ·      ← A and B got the new value
read (R=2):   ·      ✓      ✓      ← read from any 2...
                     ▲
                     └── 2 + 2 = 4 > 3 — the two groups must share at least one replica.
                         So at least one member of the read group has the new value.
```

It's just a counting argument — put four balls in three boxes and some box gets two. Now let's measure it. The exercise's `npm run quorum` — N = 3, two replicas in the same data center, one in another (slow); and as in real life, any replica occasionally (on 5% of writes) falls 50 ms behind (a GC pause, a disk stall). For each pair, 100,000 rounds of "write, then read immediately after success":

```
W  R  W+R>N?   stale reads             write p50 / p99      read p50 / p99
1  1  no       10827/100000 (10.83%)     2.3 /   7.0 ms     2.3 /   5.6 ms
1  2  no         227/100000 ( 0.23%)     2.3 /   7.0 ms     4.1 /  11.1 ms
2  1  no        3707/100000 ( 3.71%)     4.4 /  53.1 ms     2.3 /   5.6 ms
2  2  yes          0/100000 ( 0.00%)     4.4 /  53.1 ms     4.1 /  11.1 ms
3  1  yes          0/100000 ( 0.00%)    39.6 / 103.1 ms     2.3 /   5.6 ms
1  3  yes          0/100000 ( 0.00%)     2.3 /   7.0 ms    36.8 /  86.4 ms
```

Three lessons:

1. **With `R + W > N`, not a single stale read** — 0 in 100,000, for all three pairs. With `≤ N`, 0.2% to 10.8%. "Almost always right" means wrong thousands of times a day across hundreds of thousands of requests.
2. **The cost of consistency is latency (PACELC's EL/EC).** `W = 3` means every write waits for the replica in the other data center (p50 ~40 ms); `W = R = 2` avoids that slow replica — the two fast replicas are enough for the quorum.
3. **An honest confession:** I first built this simulation without the "occasionally falls behind" part. Then `(1, 2)` and `(2, 1)` also showed 0 stale reads — making it look as if `R + W ≤ N` were safe too. That was just luck: the two fast replicas were almost always ahead together. `R + W ≤ N` doesn't mean "it will be wrong" — it means **"there's no guarantee it'll be right"**, and on a bad day (when a replica falls behind) it is wrong. Only `R + W > N` gives the guarantee.

**The availability side** — from the same exercise:

```
W  R   │ 0 dead         │ 1 dead         │ 2 dead
1  1   │ write ✓ read ✓ │ write ✓ read ✓ │ write ✓ read ✓
2  2   │ write ✓ read ✓ │ write ✓ read ✓ │ write ✗ read ✗
3  1   │ write ✓ read ✓ │ write ✗ read ✓ │ write ✗ read ✓
1  3   │ write ✓ read ✓ │ write ✓ read ✗ │ write ✓ read ✗
```

`W = R = 2` (N = 3) — everything keeps working even if one replica dies, and consistency holds too. That's why it's the most common choice. The general rule: with N replicas, `W = R = ⌊N/2⌋ + 1` (a majority) — for `N = 5` that's 3, and then it survives 2 dead replicas.

One strength of these systems: W and R can be set **per query**. In Cassandra one query can run at `ONE` consistency (fast, weak) and another at `QUORUM` (slower, strong) — on the same data. This is called tunable consistency.

**An honest caveat — quorums aren't magic:**

- If two people write the same key **at the same time**, both writes may reach W replicas — then which one stays? LWW again (1.3's problem) or siblings (below).
- Many systems have "sloppy quorums" — if the designated replicas can't be reached, the write is kept on some other node (to raise availability). Then the `R + W > N` guarantee no longer holds.
- Reading **in the middle** of an ongoing write, one read can see the new value and the very next read the old one — so `R + W > N` alone doesn't give full linearizability. Perfect consistency needs more (making read repair synchronous, or consensus — Lesson 6.2).
- The exercise's simulation has none of these complications — it only demonstrates the core overlap argument.

### 1.6 ACID vs BASE

You saw ACID in Lesson 5.5. The philosophy of AP-side systems is often given an opposite name:

**BASE** — **B**asically **A**vailable (answers almost always, even during partitions or failures), **S**oft state (replicas' states may temporarily differ), **E**ventually consistent (once new writes stop, everyone converges eventually).

**Eventual consistency** — if no new writes arrive, all replicas will eventually reach the same value. Notice its weakness: how long "eventually" is — no bound is given. And during that time any read may return an old value. Lesson 5.7's async replica is eventually consistent; so is 1.3's AP side — and there, "converging" happened by throwing one person's write away.

| Aspect             | ACID                                               | BASE                                             |
| ------------------ | -------------------------------------------------- | ------------------------------------------------ |
| Priority           | Correctness                                        | Availability and scale                           |
| Reads              | Always the latest commit (per the isolation level) | May be stale; new eventually                     |
| During a partition | Usually wait or error (CP)                         | Answer, reconcile later (AP)                     |
| Conflicts          | Prevented with transactions and locks (5.5)        | Resolved later — LWW, siblings, CRDTs            |
| Typical examples   | Postgres, MySQL (single leader)                    | Cassandra, DynamoDB (default), DNS (Lesson 2.1!) |

It isn't a strict two-way split — it's a spectrum. DynamoDB has strongly consistent reads and transactions; MongoDB has multi-document transactions (Lesson 5.1); read from Postgres's async replica and you're in the BASE world. The question isn't the database's name — it's **what guarantee you want for each piece of data.**

And one different philosophy of handling conflicts is worth remembering: the shopping-cart example in Amazon's Dynamo paper (2007) — the cart is always writable (AP), and on a conflict both versions are kept (siblings) and merged (the items of both carts added together). The paper itself admits the cost: sometimes deleted items reappear in the cart. For a cart that's acceptable; for a bank balance it isn't.

### 1.7 TaskFlow — which part goes which way

This is where CAP and ACID/BASE are really used — not one choice for the whole system, but **a separate choice for each piece of data**:

| TaskFlow data                          | Choice                                                                      | Why                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Billing, subscriptions, payments       | CP, ACID, sync commit (5.7)                                                 | A double charge or a lost payment — the most expensive mistake        |
| Permissions (who's admin, who can see) | CP, SERIALIZABLE (5.5)                                                      | Wrong permissions are a security bug — better to wait                 |
| Tasks, comments (the core work)        | Single leader per shard (5.8); reads from replicas + read-your-writes (5.7) | Writes correct; reads a few ms stale are fine, except your own writes |
| Activity feed, notification counts     | AP / eventual                                                               | Nobody notices a few seconds of lag                                   |
| Online presence (who's online now)     | AP, TTL (Module 4)                                                          | No harm if wrong; a fast answer is what matters                       |
| "How many times viewed"-style counters | AP, merged later (CRDT-style)                                               | A little lag is fine, but writes must be accepted in every region     |

Now the CTO's question can be answered: when the link goes down, users in Singapore can see tasks (from the older copy), and notifications and activity keep flowing (AP) — but billing and permission changes are temporarily disabled (CP), with a clear message. That's real system design: **not one choice, but many, each by the cost of its data.**

---

## 2. Interview Angle

**"Explain the CAP theorem"** — an almost certain question, and the weak answer is the most common one: "pick two of the three." A strong answer:

1. "During a partition you must choose between consistency and availability — partition tolerance isn't optional, because networks will break."
2. Why, using the two-node example (1.1's diagram)
3. "CAP's consistency means linearizability — not ACID's C"
4. "And even without partitions there's a latency-vs-consistency choice — PACELC"

**The quorum arithmetic question:** "N = 5; choose W and R so there are no stale reads and both writes and reads keep working with 2 nodes dead." — The answer: `W = R = 3` (3 + 3 = 6 > 5; 5 − 2 = 3 alive, enough for both). Follow-up: "what if it's read-heavy?" — lower `R`, raise `W` (e.g. `W = 4, R = 2`, but then writes stop with 2 dead — state the trade-off).

**"Which database for this system?"** — think with PACELC and say: "what can this data give up during a partition, and how much latency can it afford every day" — then the database. And as in 1.7, different data in the same system gets different choices.

**In real production:** partitions really do happen — read cloud providers' incident reports and you'll see them regularly. Teams that decided in advance which data goes which way stay calm that day. The rest discover that their system made a choice on its own — often the worst one.

---

## 3. Key Takeaway

- CAP: **during a partition** you must give up either consistency or availability; partition tolerance isn't optional — so "a CA distributed database" is a meaningless claim
- CAP's C = **linearizability** (as if there were one copy), not ACID's C; A = every live node answers every request without an error
- The same database goes either way by configuration — in Lesson 5.7, sync replication got stuck (CP), async failover lost writes (AP)
- **PACELC**: even without partitions, latency vs consistency — with `W = 3` writes went from p50 2.3 ms to ~40 ms
- Quorums: **`R + W > N`** — 0 stale reads in 100,000; with `≤ N`, 0.2–10.8%; and measured without stalls, `≤ N` **looks** safe — luck, not a guarantee
- Quorums aren't magic — concurrent writes, sloppy quorums and mid-write reads are still problems; a majority (`⌊N/2⌋ + 1`) is the most common choice
- ACID vs BASE is a spectrum; **a separate choice for each piece of data** — billing/permissions CP, feed/presence/counters AP

---

## 4. New Terms (Glossary)

| Term                     | Meaning                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **CAP Theorem**          | During a network partition, a distributed system can't provide both consistency and availability at once                              |
| **Network Partition**    | Communication between some nodes stops though the nodes are alive — nobody knows if the other side is dead or cut off                 |
| **Linearizability**      | The system behaves as if there were one copy of the data — once a write succeeds, every later read sees it (CAP's C)                  |
| **PACELC**               | With a Partition, A vs C; Else, Latency vs Consistency — an extended form of CAP                                                      |
| **BASE**                 | Basically Available, Soft state, Eventually consistent — an availability-first philosophy, the opposite of ACID                       |
| **Eventual Consistency** | If no new writes arrive, all replicas eventually reach the same value — with no bound on when                                         |
| **Quorum**               | The minimum number of replicas that must agree for an operation to succeed; with `R + W > N` the read and write groups always overlap |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. A database vendor says its product is "CA — consistent and available." What single question would you ask in the meeting to draw out what that claim really means? And what might the possible answers be?
2. TaskFlow will keep users' notification preferences in a leaderless store — N = 5. It is very read-heavy (read before sending every notification) and rarely written. The rules: no stale reads, and **reads** must keep working with any 2 nodes dead. What W and R would you choose? What cost are you accepting?
3. Amazon's shopping cart chose AP — and accepted that deleted items would sometimes come back. For which TaskFlow feature is this kind of choice (AP + merging siblings) reasonable, and for which is it absolutely not? Give one example of each.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** "**What exactly happens during a network partition?** — for example, if the link between our two data centers goes down, can clients on both sides write? Will reads return the latest value?" The possible answers and what they mean: (a) "our database runs on one machine" → CAP doesn't even apply, and if that machine dies availability is zero — the "A" claim itself is weak. (b) "the minority side rejects writes" → that's actually **CP**. (c) "both sides accept writes and we reconcile later" → that's actually **AP**, and the next question is: "how do you reconcile — with LWW, which write gets lost?" (d) "partitions don't happen to us" → the most dangerous answer — they haven't thought about it, and on the day it happens the system will make an unplanned choice. That is CAP's real use — turning a claim into the right question.

**Question 2:** The conditions: `R + W > 5` (no stale reads), and reads must work with 2 dead → reads must be possible from the 3 survivors → `R ≤ 3`. It's read-heavy, so the smaller R the faster reads are. With `R = 1`, `W = 5` (1 + 5 > 5) — the fastest reads, and reads survive even 4 dead nodes; the cost: every write waits for all 5 replicas (as slow as the slowest), and writes stop as soon as **one** node dies. `R = 2, W = 4` — reads almost as fast, and writes survive one dead node. Preferences rarely change, so occasionally slow or temporarily blocked writes are acceptable — `R = 2, W = 4` is a good middle ground; and `R = 1, W = 5` is reasonable if blocked writes truly aren't a problem (showing the user "try again shortly"). The key lesson: the "consistency budget" can be divided between W and R — for read-heavy data, put most of the burden on writes.

**Question 3:** **Reasonable:** a task's label/tag set — two people in two regions add different tags to the same task; when merging, take the union of both sets (both tags stay). Occasionally a deleted tag may come back — annoying, but harmless, and the user can delete it again. The same reasoning applies to the "who viewed this task" list, or reaction/emoji counts. **Absolutely not:** billing/subscriptions (two versions may mean a double charge, or a plan downgraded and then upgraded again), and permissions — someone is removed from a project, and after the partition the merge brings them back — that's a security bug, not "annoying". The rule: **what is the worst result of a wrong merge** — if that's acceptable, AP; if not, CP.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (a single-process simulation)

> **Ready to run in the repo:** [`exercises/lesson-5.9-quorum/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-5.9-quorum) — `npm install`, then `npm run quorum` and `npm run partition`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

A small, seeded simulation — the time of every network trip is controlled, so the result is exactly the same every time. `quorum` measures six (W, R) pairs; `partition` plays out the CP and AP story in a 3|2 partition. Verified by running it in the sandbox: `tsc --noEmit` is clean, and several runs gave byte-identical output. Remember it's a simulation — it doesn't include every behaviour of a real leaderless database (hinted handoff, read repair). (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run both scripts and compare with the README (they should match exactly).

2. **The luck trap** (README experiment 1): set `STALL_PROBABILITY` to `0`. If someone looks at the `(1, 2)` and `(2, 1)` results and says "so `R + W ≤ N` is safe too" — what would you tell them, in one paragraph?

3. **N = 5** (experiment 2): add two replicas and measure `(3, 3)`, `(2, 3)`, `(3, 2)`. Which pair keeps stale reads at zero with the lowest latency, and why?

4. **Fix the clock** (experiment 3): set n4's skew to zero. Whom does LWW pick now? So is LWW safe as long as clocks are right? Give two reasons why not.

5. **Design part:** TaskFlow is opening a second data center in Singapore. Build your own version of 1.7's table — at least six kinds of data, and for each: CP or AP during a partition, latency or consistency in normal times (PACELC), and which technology (Postgres sync/async, a quorum store, a cache). Then answer the CTO's question in three lines: "what will Singapore's users see when the link goes down?"

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4 (complete), 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9
Current: 5.9 — CAP Theorem, ACID vs BASE, Quorum (the last lesson of Module 5)
TaskFlow state: Express instances, CDN, Redis cache; PostgreSQL primary + read replica,
sharding preparation (workspaceId); a second-region plan — CAP choices per data type:
billing/permissions CP (sync, SERIALIZABLE), tasks single-leader + replica, feed/presence/counters AP
Terms learned (Module 5): Relational Model, Schema-on-write, Schema-on-read, Access Pattern,
Document Store, Wide-column Store, Polyglot Persistence, Cardinality, Junction Table,
Data Anomaly, Normalization, Normal Form, Denormalization, Reconciliation Job,
Page, B-tree, WAL, Memtable, SSTable, Compaction, Write Amplification,
Query Planner, Selectivity, Composite Index, Leftmost Prefix Rule,
Partial Index, Expression Index, Covering Index, ACID, Isolation Level,
MVCC, Lost Update, Write Skew, Pessimistic Locking, Optimistic Locking,
Connection Pool, Pool Exhaustion, Little's Law, Connection Proxy,
N+1 Query, Eager Loading, Cartesian Explosion, Leader-Follower Replication,
Replication Lag, Read-Your-Writes Consistency, Synchronous Replication,
Failover, RPO/RTO, Multi-Leader Replication, Partitioning, Sharding,
Shard Key, Partition Pruning, Hot Partition, Scatter-Gather, Resharding,
CAP Theorem, Network Partition, Linearizability, PACELC, BASE,
Eventual Consistency, Quorum
Weak spots: [where you got stuck — fill this in yourself]
Next: Module 5 Exit Challenge
=======================
```

---

## 8. Next Step

Run the exercise and send it over — especially your answer to #2 and your table in #5. This is the last lesson of Module 5. When you are ready, write `next` — the **Module 5 Exit Challenge**: a mini design challenge (Tier 3) where the whole module — data modelling, indexes, transactions, pools, replication, sharding, CAP — is applied together in a realistic scenario, a "you should be able to do these" checklist, and recommendations for books, videos and projects. Then Module 6 — Distributed Systems Core, where many of today's "in Lesson 6.x" promises are kept: why knowing "is the other one dead?" is so hard, consensus, and why clocks can't be trusted.
