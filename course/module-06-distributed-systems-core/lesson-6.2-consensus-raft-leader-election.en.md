# Lesson 6.2 — Consensus: Leader Election and Raft Basics

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 1.3):** Roughly how long does one round trip take between two servers inside the same data center? And from Dhaka to a data center in Europe? (In today's lesson these two numbers will settle a design decision.)

**Prerequisite:** Lesson 5.3 (WAL), Lesson 5.7 (Replication, failover), Lesson 5.9 (Quorums), Lesson 6.1 (Failure detectors, split brain, fencing tokens)

**By the end of this lesson you will be able to:**

1. Explain what consensus is, which problems are consensus in disguise (leader election, locks, unique names), and why it cannot guarantee "there will always be an answer"
2. Draw on a whiteboard, step by step, how Raft chooses a leader (terms, votes, random timeouts) and how it commits writes (the log, majority)
3. Explain why Raft doesn't fall into split brain during a partition and what the election restriction protects — and use the costs of consensus (node count, latency) to decide where to use it and where not

**Tier:** 1 — Runnable Code (a small implementation of Raft's core, on top of a seeded network simulator)

---

## 0. Where TaskFlow Is Right Now

After Lesson 6.1, TaskFlow's team made two decisions:

1. The reminder job's leader will be chosen with **etcd** — etcd's lease, and etcd's revision number as the fencing token.
2. Postgres failover will run on **Patroni**, which also decides who is primary by holding a lease in etcd.

In the design review the CTO asked one question, and the room went quiet:

> "etcd itself runs on three machines. The network between them can be cut too, one machine can get stuck in a GC too. So why doesn't etcd get split brain itself? Have we just moved the problem from our code into etcd?"

Along with two practical questions: how many etcd nodes — 3, 4 or 5? And TaskFlow has two availability zones (AZs) — where do the nodes go?

The question is exactly right. The answer: etcd runs a **consensus algorithm** — Raft — built with exactly 6.1's problems in mind (lost messages, partitions, pauses, old leaders), and mathematically proven so that even with these, two leaders can never commit writes at the same time. Today we go inside Raft — and in the exercise we'll run a small Raft with our own hands and watch what it does during a partition.

---

## 1. Theory

### 1.1 Consensus — agreeing on something that will never change

**Consensus** — several nodes agreeing on a value, such that once decided it never changes — even if some nodes die or messages are lost.

It sounds abstract, but many backend problems are consensus in disguise:

- **Leader election** — everyone agrees on the answer to "who is term 7's leader?"
- **Lock / lease** — "who holds the lock right now?" (6.1's reminder job)
- **Unique names** — two users ask for the same username at the same moment; who gets it?
- **Ordering** — "which of these two writes came first?" — everyone sees the same order

A good consensus algorithm makes two kinds of guarantee:

- **Safety** (nothing bad ever happens) — two nodes never agree on different values; once decided, it never changes.
- **Liveness** (something good eventually happens) — a decision is eventually reached.

And here there's some famous bad news. In 1985 Fischer, Lynch and Paterson proved (**FLP impossibility**): in 6.1's asynchronous network — where message delay has no bound — if even one node can crash, there is no deterministic algorithm that guarantees a decision is **always** reached. The reason is 6.1's core point: a slow node and a dead node can't be told apart, so whether to wait or move on can never be decided with certainty.

The answer of real-world algorithms (Raft, Paxos) is a clever compromise:

- **Never give up safety** — don't depend on any timeout, any clock, or the length of any pause.
- **Use timeouts for liveness** — if the network behaves reasonably, decide quickly; if it's very bad, maybe no decision for a while (writes stall) — but a **wrong** decision never happens.

Remember 6.1's lesson: "the failure detector will be wrong, so don't let correctness depend on it." Raft is built on exactly this principle.

### 1.2 Replicated State Machine — agreeing on a log

Agreeing on one value isn't enough — etcd has to agree on every write. The elegant solution:

**Replicated state machine** — every node has a log of the same commands in the same order, and every node applies the commands of that log in order. Same start + same commands + same order = same state.

```
   client: "x=3"
       │
       ▼
  ┌──────────┐  AppendEntries   ┌──────────┐   ┌──────────┐
  │  LEADER  │ ───────────────► │ follower │   │ follower │
  │ log:     │ ───────────────────────────────►│          │
  │ x=1  x=3 │                  │ x=1  x=3 │   │ x=1  x=3 │
  └────┬─────┘                  └────┬─────┘   └────┬─────┘
       │  got a majority (2 of 3) → commit "x=3"    │
       ▼                             ▼              ▼
   state machine:  x = 3         x = 3          x = 3
```

Compare with Lessons 5.3 and 5.7: Postgres's WAL and streaming replication are also copies of a log. The difference — in Postgres the decision of **who is primary** is made outside the log (by Patroni, a human, or a script), and that's where 6.1's split brain gets in. In Raft, leader election and log replication are parts of the same algorithm, bound by the same rules.

So the consensus question becomes: **everyone agrees on which command sits at each position (index) of the log.**

### 1.3 Raft — three roles, and the term

Raft (Diego Ongaro and John Ousterhout, 2014) was built to be **understandable** — the main algorithm before it, Paxos, was correct but notoriously hard to understand. In Raft, every node at any moment is in one of three roles:

```
                timeout, start an election             got a majority of votes
   ┌──────────┐ ───────────────────────► ┌───────────┐ ─────────────► ┌──────────┐
   │ FOLLOWER │                          │ CANDIDATE │                │  LEADER  │
   └──────────┘ ◄─────────────────────── └───────────┘                └──────────┘
        ▲        found a valid leader, or a bigger term │ timeout: split vote,   │
        │                                       └── try again in a new term  │
        └───────────────────────── saw a bigger term ──────────────────────────┘
```

- **Follower** — quiet; listens to the leader, votes.
- **Candidate** — wants to become leader, asking for votes.
- **Leader** — takes all client writes, sends the log to followers, and sends regular heartbeats ("I'm here").

And Raft's most important idea:

**Term** — Raft's logical time: a number that goes up 1, 2, 3…; each term starts with an election, and each term has at most **one** leader.

Two rules make the term powerful:

1. **Every message carries the sender's term.**
2. **Any node that sees a term bigger than its own immediately adopts it and becomes a follower** — even if it was the leader. And it rejects messages with a smaller term.

Remember 6.1's **fencing token**? The term is exactly that — a number that goes up with every new leader, and nobody listens to an old number. In Raft you don't have to add fencing separately; it's built into the algorithm. (That's also why TaskFlow can use etcd's revision as a fencing token.)

### 1.4 Leader Election — one vote per term

If a follower gets no heartbeat from the leader for a set time (the **election timeout**), it assumes there's no leader, and:

1. increments its own term
2. becomes a candidate and votes for itself
3. sends `RequestVote` to everyone

Every node gives **one** vote per term — to whoever asked first (with one condition, in 1.7). A candidate that gets a majority of votes is leader, and immediately sends everyone a heartbeat so the others don't start an election.

**Why are two leaders in one term impossible?** Lesson 5.9's reasoning: both need a majority; two majorities of 5 (3 + 3) overlap in at least one node; and that one node can't vote for two candidates in one term. No timeouts or clocks here — just counting.

**Split votes and random timeouts.** But what if everyone becomes a candidate at the same moment? Each votes for itself, nobody gets a majority, everyone waits for the timeout again… and again together. Raft's solution is surprisingly simple:

**Randomized election timeout** — each node picks a random election timeout from a range every time (the paper's example: 150–300 ms), so that usually one wakes up before the others and wins.

The exercise's `npm run election` — 5 nodes start together, no leader, 1000 times for each range:

```
   election timeout     leader found         time p50 / p99         avg terms (1 = on the first try)
   150 ms (fixed)        837/1000           4204 /  9761 ms         30.61
   150–155 ms           1000/1000            315 /  1526 ms         2.94
   150–175 ms           1000/1000            161 /   331 ms         1.08
   150–300 ms           1000/1000            176 /   252 ms         1.00
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

With a fixed timeout, an average of 30 failed elections, and in 16% of cases no leader even within 10 seconds — meaning the cluster couldn't take a single write the whole time. (The ones that do win are only lucky, thanks to the ±0.5 ms jitter of the timers and the random delays of the network.) Just 25 ms of randomness almost erases the problem; with 150–300, every one of 1000 runs succeeded on the first try.

Notice one more thing: the p50 of 150–300 (176 ms) is slightly **higher** than 150–175's — because on average the first timeout comes later. But the p99 is better (252 vs 331 ms). A bigger range = fewer split votes, a slightly slower first attempt.

**The timing rule.** A yardstick from the Raft paper:

```
   message round trip   ≪   election timeout   ≪   average time between two node crashes
      (~1 ms, same DC)      (150 ms – a few s)              (months)
```

The election timeout must be much larger than a round trip (otherwise 6.1's false declarations and needless elections), and much smaller than the rate at which nodes die (otherwise when the leader dies, writes stop for a long time). etcd's defaults: heartbeat 100 ms, election timeout 1000 ms. And here the spaced-repetition question comes in — if the nodes are on other continents the round trip is 150+ ms, and these numbers have to go up (1.8).

### 1.5 Log Replication and Commit

The leader appends a client write to the end of its log, and sends it to the followers with `AppendEntries`. (A heartbeat is really an empty `AppendEntries`.)

**Committed entry** — a log entry that the leader has replicated to a majority of nodes; Raft guarantees it will never be erased, and only then is the client told "success".

With every `AppendEntries` the leader also sends the index and term of the entry just before — "you do have a term-3 entry at index 5, right?" If the follower's doesn't match, it rejects, and the leader steps back one and sends again — until they match. After the match point the follower deletes everything and puts the leader's entries in its place. Result: **if two logs have an entry with the same term at some index, the logs are identical up to that index.** The leader's log is the truth; the follower's mismatched part is erased.

Now the real test in the exercise. `npm run partition` — 5 nodes, n1 is leader, `x=1` has already been written. Then the network is cut into three: the old leader n1 alone, n2 alone, the other three (n3 n4 n5) together:

```
   ═══ 1200 ms: network cut — [n1] | [n2] | [n3 n4 n5] ═══

    1250 ms  A       "x=2" → n1 (log index 2, term 1)
    1329 ms  n3      ★ became leader (term 2)
    2000 ms  B       "x=3" → n3 (log index 2, term 2)
    2008 ms  n3      commit: index 2 "x=3"
    2008 ms  B       ✓ "x=3" confirmed (8 ms)
    2250 ms  A       ✗ "x=2" — no confirmation in 1000 ms (timeout)

   ── partition in progress — two "leaders"? ──
   n1  LEADER    term  1   log: x=1(t1) x=2(t1)                commit 1   x = 1
   n2  candidate term  5   log: x=1(t1)                        commit 1   x = 1
   n3  LEADER    term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
   n4  follower  term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
   n5  follower  term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
```

This snapshot is the centre of this lesson. **Two nodes call themselves LEADER** — exactly 6.1's fear. But look at the difference:

- n1 (term 1) accepted `x=2`, but couldn't commit it — nobody is with it, a majority is impossible. Client A was never told "success".
- n3 (term 2) got a majority, and committed `x=3` in 8 ms.

This isn't 6.1's split brain. Two nodes **think** they're leader, but the **work** — committing writes — only one can do, because a commit needs a majority, and there is only one majority. The old leader's illusion is harmless, because it has no power.

**But one trap remains:** in the snapshot, n1 has `x = 1`. If someone **reads** from n1 — "you're the leader, just give me your value" — they'll get the old value, even though x=3 was committed long ago. Raft keeps writes safe; keeping reads safe needs a separate mechanism: before answering, the leader confirms a heartbeat response from a majority ("am I still leader?") — in Raft's terms, ReadIndex. etcd does exactly this by default (linearizable reads); if you ask for a weaker "serializable" read, it gives the local value — fast, but possibly old. (Exercise experiment 3.)

### 1.6 When the partition heals

```
   ═══ 3500 ms: network healed ═══

    3512 ms  n1      saw term 10 → no longer leader (was term 1)
    3540 ms  n3      saw term 10 → no longer leader (was term 2)
    3628 ms  n3      didn't vote for n2 — its log is older than mine (term 11)
      …     (n1, n4, n5 say the same)
    3716 ms  n5      ★ became leader (term 12)
      …
   ── final state ──
   n1  follower  term 12   log: x=1(t1) x=3(t2) x=4(t12)       commit 3   x = 4
   (the other four have exactly the same log)
```

Three things happened:

1. **The old leader stepped aside on its own.** n1 saw a bigger term (rule 2) and immediately became a follower. Nobody had to "kill" it — no need for 6.1's STONITH.
2. **`x=2` was erased.** At index 2 in n1's log was `x=2 (t1)`, in the new leader's log `x=3 (t2)` — a mismatch, so it was erased and replaced with the leader's. No promise was broken, because `x=2` was never committed, and client A was never told "success".
3. **n2's term had climbed to 10.** Alone and cut off, n2 kept starting elections and kept losing, raising its term every time. When it came back, the healthy leader n3 saw its bigger term and stepped down too (rule 2) — about 200 ms with no leader, for no reason. The fix for this is **PreVote**: before becoming a candidate, ask "could I win?" without raising the term — etcd and many other implementations have it (exercise experiment 4).

**What should client A do?** Its timeout means 6.1's "I don't know" — in this case the write was discarded, but in another case (the leader replicated it to a majority and died before telling the client) the write may **still get committed later**. So the client retries on the new leader — with an idempotency key (2.5), so it isn't applied twice.

### 1.7 Election Restriction — why committed writes are never lost

In 1.6, n2 didn't get votes: "its log is older than mine." This is the last piece of Raft's safety:

**Election restriction** — a node votes only for a candidate whose log is at least as up to date as its own (a bigger term on the last entry, or the same term and a log at least as long).

Why this protects committed writes — step by step:

1. An entry being committed means it's on a **majority**.
2. To become leader you need the votes of a **majority**.
3. Two majorities overlap in at least one node — and that node has the entry.
4. That node won't vote for a candidate whose log lacks it.
5. So whoever becomes leader has every committed entry in its log — and the leader's log is the truth (1.5).

What happens if you lift the restriction? `npm run unsafe` — the same story, only this voting condition is turned off:

```
    3631 ms  n2      ★ became leader (term 11)
    4500 ms  C       "x=4" → n2 (log index 2, term 11)
   ── final state ──
   n1  follower  term 11   log: x=1(t1) x=4(t11)               commit 2   x = 4
   n2  LEADER    term 11   log: x=1(t1) x=4(t11)               commit 2   x = 4
   n3  follower  term 11   log: x=1(t1) x=4(t11)               commit 2   x = 3
   …
   nodes whose log still has "x=3": 0/5   ← a confirmed write has been lost!
   is x the same on every node? no — n1=4 n2=4 n3=3 n4=3 n5=3   ← the replicas have diverged!
```

n2, returning with the biggest term, won, and treated its old log as "the truth", erasing everyone else's `x=3` — a write client B had been told was "confirmed" in 8 ms. And even worse: n3, n4 and n5 had already applied `x=3`, so their state machine has x = 3 while the others have x = 4 — **the replicas are no longer the same.** Removing one condition broke both of the algorithm's core promises.

(There's also a subtle rule, commented in the exercise's `raft.ts`: a leader commits by counting a majority only for entries **of its own term**; entries from older terms are committed along with them. Why — the paper's Figure 8 has a lovely example. Not for a first read, but know that such subtleties exist — yet another reason why writing consensus yourself is dangerous.)

### 1.8 The cost — and where to use it

**Node count:**

| Nodes (N) | Majority | How many can die | Comment                                                             |
| --------- | -------- | ---------------- | ------------------------------------------------------------------- |
| 1         | 1        | 0                | not consensus — just one server                                     |
| 3         | 2        | 1                | the most common                                                     |
| 4         | 3        | **1**            | no better than 3 — an extra machine, same tolerance, slower commits |
| 5         | 3        | 2                | tolerates one more failure even with one in maintenance             |
| 7         | 4        | 3                | rare; every write waits on more nodes                               |

An even number almost never helps — with 4 nodes the majority is 3, so like 3 it tolerates one failure; and in a 2|2 partition neither side gets a majority.

**Where to place them:** with 3 nodes across TaskFlow's two AZs (2 + 1), if the AZ with 2 goes down entirely, the remaining 1 has no majority — the whole cluster stops. So consensus clusters usually put one node in each of **three** AZs. (If there really are only two AZs, a lightweight node somewhere third — 6.1's "witness" idea.)

**Latency:** committing every write needs a majority round trip. Inside one data center that's ~1 ms — excellent. But with nodes in Dhaka, Singapore and Europe, every write is 100+ ms, and the election timeout has to go up too. The cost of consensus grows directly with distance.

**Throughput:** every write goes through one leader. The leader's CPU, disk and network — that's the limit.

**So consensus is usually not for the whole database — it's for small but critical data:** who is leader, who holds a lock, configuration, service-discovery lists. etcd is built for exactly this — the entire state of a Kubernetes cluster lives in etcd — and its default storage limit is only 2 GB. Even thinking of putting TaskFlow's task table in etcd is wrong.

The exception: databases like CockroachDB, TiKV and Google Spanner split the data into thousands of small pieces (ranges), and run a **separate** Raft (or Paxos) group for each piece — Lesson 5.8's sharding and today's consensus together. That way throughput isn't capped at one leader.

**Where you'll see it:** Raft — etcd, Consul, CockroachDB, TiKV, Kafka's KRaft (replacing ZooKeeper), and MongoDB's replica set protocol is inspired by Raft. Paxos (Leslie Lamport) — Google's Chubby and Spanner. ZooKeeper runs its own ZAB. Different names, the same core idea: majority, a number that keeps going up (term/ballot/epoch), and safety never depending on timeouts.

> **Trade-off Table — When to use consensus**

| Need                                                    | Consensus (etcd/Raft)?        | Why                                                                |
| ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| Who is leader / who holds the lock (6.1's reminder job) | Yes                           | Built exactly for this; term/revision = fencing token              |
| The database failover decision (Patroni)                | Yes — for the decision        | The data lives in Postgres; only "who is primary" is in consensus  |
| App config, feature flags, service lists                | Yes                           | Small, few writes, everyone seeing the same value matters          |
| TaskFlow's tasks, comments                              | No (not directly)             | Huge data, many writes — Postgres + replicas (5.7)                 |
| Activity feed, presence, view counts                    | No                            | 5.9's AP data — a slightly old value is fine, latency matters more |
| Globally strongly consistent huge data                  | Yes, but sharded (Multi-Raft) | CockroachDB/Spanner — cost: a majority round trip on every write   |

---

## 2. Interview Angle

**"Explain how Raft chooses a leader."** — In order: three roles → the term (on every message; see a bigger term, become a follower) → on election timeout become a candidate, term++, vote for yourself, RequestVote → one vote per term, a majority makes a leader → why random timeouts (split votes). Then say on your own: "two leaders in one term are impossible because two majorities overlap" — that's what the interviewer wants to hear.

**"What happens in a Raft cluster during a partition?"** — The majority side elects a new leader and keeps writing; the old leader on the minority side may think it's leader but can't commit; when the partition heals it sees the bigger term and steps aside, and its uncommitted entries are erased. Bonus: a local read from the old leader can be stale — hence ReadIndex or lease-based reads.

**"Four nodes are safer than three, right?"** — No: the majority is 3, it tolerates only one failure, and in a 2|2 partition nobody gets a majority. 3 or 5.

**"Should we replicate all our data with Raft?"** — State the cost: a majority round trip on every write, the throughput limit of one leader. Yes for coordination data (leader, lock, config); for huge data, either ordinary replication or sharded consensus (CockroachDB).

**"What's the difference between Paxos and Raft?"** — The core safety idea is the same (majority, a number that keeps going up). Raft is split into a strong leader and clear phases for understandability; Paxos is essentially a protocol for agreeing on one value, Multi-Paxos for a log, and many details of real implementations aren't in the paper.

**In real production:** nobody writes Raft themselves — it's etcd, Consul, ZooKeeper, or the database's own. Your job: the node count and placement (three AZs), the timeouts (etcd's `--heartbeat-interval`, `--election-timeout` — based on the network's round trip), the disk (etcd `fsync`s every write to disk — a slow disk means a slow cluster), and monitoring (how often the leader changes — frequent changes mean a timeout or network problem).

---

## 3. Key Takeaway

- **Consensus** = a decision among several nodes that never changes; leader election, locks, unique names — all consensus in disguise
- **FLP:** in an asynchronous network a guarantee that "a decision will always be reached" is impossible — so Raft **never gives up safety**, and uses timeouts for liveness
- **Replicated state machine:** same log, same order, same state — consensus is really agreeing on each position of the log
- **Term** = Raft's logical time and built-in fencing token: at most one leader per term, and seeing a bigger term makes everyone a follower
- Election: one vote per term, a majority makes a leader; **random timeouts** make split votes almost zero (in the exercise, a fixed timeout averaged 30 failed elections; 150–300 ms succeeded on the first try)
- **Commit** = reaching a majority; during a partition the old leader on the minority side may think it's leader but can't commit anything — but **reads** from it can be stale
- The **election restriction** protects committed writes; turning it off in the exercise lost a "confirmed" write and made the replicas diverge. Nodes: 3 or 5 (not even), across three AZs; consensus for small, critical data

---

## 4. New Terms (Glossary)

| Term                            | Meaning                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Consensus**                   | Several nodes agreeing on a value such that the decision never changes — even if some nodes die or messages are lost               |
| **FLP Impossibility**           | In an asynchronous network, if even one node can crash, no deterministic algorithm can guarantee that a decision is always reached |
| **Replicated State Machine**    | Every node applies the same commands in the same order and reaches the same state — using a log agreed on through consensus        |
| **Term**                        | Raft's logical time — an increasing number; at most one leader per term; seeing a bigger term forces a node to become a follower   |
| **Randomized Election Timeout** | Each node picks a random timeout from a range every time, so that usually one wakes up first and wins the election                 |
| **Committed Entry**             | A log entry the leader has replicated to a majority — never erased; only then is the client told "success"                         |
| **Election Restriction**        | Vote only for a candidate whose log is at least as up to date as your own — so the new leader has every committed entry            |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. The CTO's second question: TaskFlow has two AZs (AZ-a, AZ-b). An engineer proposed: "4 etcd nodes, 2 in each AZ — an even split, and safer than 3." What's wrong with this proposal? What happens if AZ-a goes down entirely? What's your proposal?
2. TaskFlow's reminder worker got a timeout while writing a key to etcd. In which situations has the write happened, and in which hasn't it? (At least one example of each, using the events of 1.5–1.6.) What should the worker do now?
3. A colleague says: "Reads from etcd feel slow. The leader always has the latest data — so just let the leader answer straight from its own memory; why ask a majority?" Answer using the exercise's partition snapshot. In which cases is their proposal (a serializable read) actually fine?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** With 4 nodes the majority is 3, so like 3 nodes it tolerates only one failure — not "safer", just more machines and one more node to wait for on every write. And the real problem: if AZ-a goes down entirely (or the link between the two AZs is cut), each side has 2 nodes — nobody gets a majority (3) → **the whole cluster stops taking writes**; Patroni can't choose a new primary, and the reminder job has no leader. The "even split" is exactly the worst split. Splitting 3 nodes as 2 + 1 has the same problem, just on one side: if the AZ with 2 goes, the cluster stops. Proposal: **three** failure domains — 3 nodes, each in a different AZ. If there's no third AZ, put the third node somewhere else independent (another region, another provider) — a small machine is enough, because it mostly just votes. Then losing any one place still leaves the other two as a majority. (Extra: if the third node is far away, it's better that it usually isn't leader — the majority round trip for each commit will still happen through the two nearby nodes.)

**Question 2:** A timeout means "I don't know" (6.1).

- **Didn't happen:** the request went to an old leader stuck in the minority (the exercise's client A and `x=2`) — it appended to its log but couldn't commit, and after healing the entry was erased. Or the request was lost on the way.
- **Did happen:** the leader replicated the entry to a majority (committed), then crashed just before telling the client, or the reply was lost. The entry is in the new leader's log (the election restriction guarantees it), yet the worker never heard "success".
- **May happen later:** the entry reached a majority but the leader hadn't reported it yet — the new leader will commit it along with an entry of its own term.

What the worker should do: retry — but in a way where applying twice does no harm. In etcd the good way is a **conditional write** (a transaction/compare-and-swap): "write only if the key's revision is still X" — if the first attempt succeeded, the second will fail the condition, and the worker can read to check. Or make the written value itself idempotent (writing the same value again is harmless). And when reading to verify, use a linearizable read (question 3).

**Question 3:** "The leader always has the latest data" — that idea is exactly the mistake, because a node **doesn't know that it's no longer leader.** In the exercise's snapshot, n1 calls itself LEADER, but it has `x = 1`, while `x=3` was committed long ago. If n1 answers from its own memory, that's a stale read — and if the client had just written `x=3` on n3 itself, it wouldn't even see its own write (5.7's read-your-writes, this time inside consensus). Asking a majority (ReadIndex) means confirming "I'm still leader" — n1, stuck in the minority, can't, so instead of a wrong answer it gives no answer. (There's another way — the leader holds a lease, and within the lease answers without a majority — but that depends on 6.1's assumptions about clocks and pauses.) **When a serializable read is fine:** when a slightly old value does no harm — showing config on a dashboard, monitoring, or a cache that corrects itself later. But never before making a lock/leader decision ("is the lock still mine?").

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (a deterministic simulation)

> **Ready to run in the repo:** [`exercises/lesson-6.2-raft/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.2-raft) — `npm install`, then `npm run election`, `npm run partition`, `npm run unsafe`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`src/raft.ts` holds Raft's core (~300 lines) — following the paper's Figure 2, with a comment beside each rule. `src/sim.ts` is a discrete-event simulator: message delays are seeded-random, and any link can be cut. Membership changes, snapshots, persisting to disk and PreVote are left out — this is for reading and breaking, not for production.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; several runs of all three scripts gave identical output (checksums matched). The README's experiments involve changing the code — they haven't been run. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Read `raft.ts`** — just four functions: `startElection`, `onRequestVote`, `onAppendEntries`, `advanceCommit`. For each, write one line: which of Raft's rules it is (which of 1.3–1.7).

2. Run all three scripts. In `partition`'s snapshot there are two LEADERs — write one line on why this is **not** 6.1's split brain. Then another line: what single action could have made it genuinely harmful?

3. **An even number** (experiment 2): 6 nodes, a 3|3 partition. Did either side get a leader? Was any write committed? Compare with your answer to question 1.

4. **Fix the stale read** (experiment 3): write a `read()` that doesn't answer without a majority's response. Run it on n1 and n3 during the partition — which one answers, which doesn't?

5. **Design part:** write a one-page answer for the CTO: (a) why etcd doesn't get split brain itself — in 5–6 lines, with term, majority and the election restriction; (b) the node count and placement (TaskFlow has two AZs — where does the third go?); (c) what `--heartbeat-interval` and `--election-timeout` should be — reasoned from the round trip between the nodes; (d) which kind of read the reminder worker should use when reading the lock's state from etcd, and why.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (complete, including exit challenges), 6.1
Current: 6.2 — Consensus: Leader Election, Raft Basics
TaskFlow state: Nginx + Express instances, CDN, Redis cache; PostgreSQL primary +
read replica, failover via Patroni; etcd (3 nodes, three separate failure domains) — Patroni's
leader lock and the reminder job's lease; etcd revision = fencing token; lock state read linearizably
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility,
Replicated State Machine, Term, Randomized Election Timeout, Committed Entry,
Election Restriction
Weak spots: [where you got stuck — fill this in yourself]
Next: 6.3 — Quorum in practice: replication lag, read-your-writes, monotonic read
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your two lines in #2 and your answer to the CTO in #5. When you are ready, write `next` — Lesson 6.3: **Quorum in practice — replication lag, read-your-writes, monotonic reads.** Today you saw that reading from an old leader returns an old value. Consensus avoids that — by getting a majority's response for every read, which is expensive. Most systems don't pay that price on every read; they read from replicas, and in exchange give some **specific** guarantees: "you'll see your own writes", "time won't go backwards". The problem we only named in 5.7 — a task that vanishes on refresh — gets solved there.
