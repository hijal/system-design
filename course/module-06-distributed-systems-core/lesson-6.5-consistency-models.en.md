# Lesson 6.5 — Consistency Models: From Strong to Eventual, What It Feels Like in Practice

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 5.5):** Which anomaly makes the difference between Postgres's `REPEATABLE READ` and `SERIALIZABLE`? (One line, with an example.) Today you'll see "serializable" and "linearizable" — the names are close, but they answer completely different questions.

**Prerequisite:** Lesson 5.5 (Isolation levels), Lesson 5.9 (CAP, linearizability), Lesson 6.2 (Linearizable reads), Lesson 6.3 (Session guarantees), Lesson 6.4 (Happens-before)

**By the end of this lesson you will be able to:**

1. Arrange every guarantee that came up in Modules 5–6 — linearizable, sequential, causal, session guarantees, eventual — on one ladder, and say what you lose and gain at each step
2. Look at a small operation history and say by hand which models it satisfies and which it breaks — and check it with a checker
3. Explain the difference between serializability and linearizability, and choose a model for each piece of TaskFlow's data and write it in one line in a design doc

**Tier:** 1 — Runnable Code (a small consistency checker, and random histories from simulated systems)

---

## 0. Where TaskFlow Is Right Now

Over Module 6, many parts of TaskFlow have changed — etcd, version tokens, conflict rules. Now two things at once:

1. TaskFlow is considering buying a managed database. The vendor's website says in big letters: **"Strongly consistent. Globally distributed. Always available."** The CTO wanted to know, "Can this be true? And what exactly does 'strongly consistent' mean?"
2. The architecture review rules have changed: every design doc needs one line for every data store — **"consistency model: \____"** — and it will be checked in review.

Sitting down to write the first design doc, three people on the team wrote three different things: one "strong", one "serializable", one "eventually consistent but fast". And in the review nobody could say what any of the three actually promises.

Today's lesson is the last of Module 6, and its job is to **fix the language**: a clear definition of every guarantee, a ladder, and a way — checking against a history, with a small checker.

---

## 1. Theory

### 1.1 Consistency Model — a contract

**Consistency model** — a contract between a system and its user: when several clients read and write at once, **what values a read may return** — and which it never can.

The most honest way to describe one is with a **history**:

**Operation history** — the full record of which client started which operation when, when it finished, and what result it got; a consistency model really says which histories are "valid".

```
   P1   |──── write x=1 ────|
   P2          |── read x → 1 ──|
   P3                                  |── read x → 0 ──|
   ────────────────────────────────────────────────────────► real time
```

Every operation is a **span of time** — from start to finish. The client knows when it sent the request and when the answer came back; at which moment in between the database actually did the work, it doesn't know.

The core question is the same for every model: **can we imagine one line (one after another) in which every read gets exactly the value of the write before it?** The models differ in only one place — **which rules the line has to obey.**

The exercise's `checker.ts` searches for exactly this answer — looking through every possible line (a small Jepsen, in 1.7).

### 1.2 Linearizability — as if there were one copy, and it respects time

You first heard it in Lesson 5.9 — the "C" in CAP. Now the full definition:

**Linearizability** — every operation can be taken to happen at **one instant** somewhere between its start and finish; and the line respects real time — if one operation finishes before another starts (from any client), it's earlier in the line too.

**Linearization point** — that imagined instant within an operation's span when it "actually happened".

From the client's point of view: the system is like **a single copy**, and from the moment a write finishes, **everyone** sees it. The first three cases in the exercise's `npm run models`:

```
   case                                    lesson   linear.  sequential  causal  RYW  mono.read  eventual
   one primary, all normal                 5.x      ✓        ✓           ✓       ✓    ✓          ✓
   a read during a write got the new value 6.2      ✓        ✓           ✓       ✓    ✓          ✓
   reading from an old leader              6.2      ✗        ✓           ✓       ✓    ✓          ✓
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the results are identical.)

- **"A read during a write got the new value" — linearizable.** The write hasn't finished yet, but the read got the new value. No problem: the write's linearization point can be placed before the read. Linearizability doesn't mean "everything slowly, one at a time" — concurrent operations run, the results just have to fit into one reasonable line.
- **"Reading from an old leader" — not linearizable.** P1's write finished at 10 ms; P2 **started** reading at 100 ms, and got the old value. Real time says P2's read was after the write — so it should have got the new value. This is exactly the local read of 6.2's leader stuck in the minority.

Where it's needed: wherever it matters that **everyone agrees on the same truth** — who owns a lock (6.1), who the leader is (6.2), whether a username is already taken, whether there's enough money in an account. The cost: 6.2's majority round trip, and 5.9's CAP — during a partition the minority side can't answer.

### 1.3 Sequential Consistency — respect your own order, not real time

In "reading from an old leader", the sequential column is ✓. Why?

**Sequential consistency** — there is a line that respects each client's **own** order of operations; but it doesn't have to respect real time between different clients.

Put P2's old read **before** P1's write in the line — P2's own order isn't broken by that (it has no earlier operations), and neither is P1's. In real time P2 read later, but sequential consistency doesn't look at that.

The difference may seem trivial. But imagine: Rahim phones Karim and says, "I've closed the task, take a look." Karim looks — it's open. Sequential consistency allows this, because the system doesn't know about the phone call (a "message" outside the system). Linearizability doesn't, because in real time Rahim's write had finished, and then Karim read.

In the database world sequential consistency is rarely sold on its own — but it's worth learning, because it shows how valuable, and why, the "real time" part of linearizability is. (In CPU and programming-language memory models it's a very important idea.)

### 1.4 Causal Consistency — respect causality, everything else is free

**Causal consistency** — operations related by happens-before (6.4) are seen by everyone in the same order; but concurrent operations may be seen in different orders by different clients.

Meaning: if Karim answered after **seeing** Rahim's question, anyone who sees the answer also sees the question. But if two people post two separate comments without knowing about each other, some will see Rahim's first, some Karim's — both valid.

```
   the answer is there, the question isn't 6.3      ✗        ✗           ✗       ✓    ✓          ✓
```

This row is one of the most important rows in this lesson. Nothing in P3's **own** view broke a rule — it wrote nothing itself (read-your-writes ✓), its view never went backwards (monotonic ✓). What broke is the causality between **two other people**: the question → Karim read it → the answer. Session guarantees (6.3) look at one client's own history; causal looks at the whole web of causality.

Causal has a special importance: research has shown that among models that **can answer from every side even during a partition** (5.9's AP), causal consistency (in a slightly extended form) is about the strongest achievable. So it's a natural target for AP systems. In practice: MongoDB's causal consistency sessions (6.3's `afterClusterTime`), and 6.3's "related data in one partition" rule is really a trick for getting causal cheaply.

### 1.5 Session Guarantees and Eventual — the lower rungs

6.3's session guarantees are really pieces of causal, from one client's point of view:

```
   replica lag: own write missing          5.7      ✗        ✗           ✗       ✗    ✓          ✓
   task vanished on refresh                6.3      ✗        ✗           ✗       ✓    ✗          ✓
```

Each is separate and independent: in the first, read-your-writes breaks but monotonic is fine; in the second, the reverse. So writing "session consistency" in a design doc isn't enough — **which** guarantees, by name.

And at the very bottom of the ladder:

**Eventual consistency** (5.9) — once new writes stop, all replicas will eventually reach the same value. That's all.

```
   LWW: clock error lost the bot's edit    6.4      ✗        ✗           ✗       ✗    ✓          ✓
```

A ✓ in the last column — all replicas eventually reached the same value (having lost the bot's edit). And almost everything else ✗. Eventual consistency doesn't say **when** they'll agree, doesn't say what can be seen in between, and doesn't say **which** value they'll agree on — they can even agree after losing a write that was reported "saved". When a vendor only says "eventually consistent", ask: "and what else?"

### 1.6 The ladder

```
                     stronger — fewer surprises, higher cost
                          │
   Strict serializable    │  transactions + real time (Spanner) ─────────── 1.8
          │
   Linearizable           │  one copy, respects real time      locks, leaders, unique names
          │                    ── impossible to answer from every side during a partition (CAP) ──
   Sequential             │  one line, only your own order
          │
   Causal                 │  everyone sees causality in the same order    ← possible even under partition
          │
   Session guarantees     │  read-your-writes, monotonic reads, …  (by name, separately)
          │
   Eventual               │  will converge eventually — when, and on what, unknown
                          │
                     weaker — more surprises, cheaper, always answers
```

A higher rung gives every guarantee of the lower ones (if it's linearizable, it's causal too, and read-your-writes too). Going down gets you two things: lower latency (answers from a nearby replica), and availability during partitions. And loses two things: at each step you allow users to see a new kind of oddity — every ✗ in `models`' table is a support ticket.

### 1.7 Jepsen — histories, not claims

Knowing the ladder isn't enough — how do you know which rung a system is **actually** on? Not from the vendor's claims.

Kyle Kingsbury's (co-author of 6.1's "The Network is Reliable") **Jepsen** project answers this question: run a database cluster, read and write with many clients at once, cut the network, kill processes, shift clocks — and **record the history of every operation.** Then check with a checker: does this history match the claimed model? Over the years Jepsen has found errors in the consistency claims of many well-known databases — sometimes bugs, sometimes exaggerated documentation. (I mentioned it in the recommendations of Module 5's exit challenge.)

The exercise's `npm run jepsen` does the same thing, in miniature: four simulated systems, 300 random histories each (3 clients, one key), checked with the checker:

```
   system                        linear.  sequential  causal    RYW   mono.read  eventual
   one primary                   100%     100%      100%    100%     100%      100%
   any replica                    32%      58%       61%     70%      85%      100%
   one replica per client         29%      57%       63%     67%     100%      100%
   version token                  48%     100%      100%    100%     100%      100%
```

- **One primary:** every column 100%. This is also a test of the checker itself — it didn't wrongly call any history of a correct system "broken".
- **Any replica:** only eventual is fully guaranteed. Everything else breaks to some degree — another form of 6.3's table.
- **Sticky replica:** monotonic reads 100% (as you saw in 6.3) — but it fixes nothing else.
- **Version token:** sequential and causal **100%**, but linearizable only 48%. The token keeps each client's view one-directional and including its own writes — but doesn't guarantee seeing **another** client's fresh write. Exactly one rung down the ladder. (Careful: there's only one key here. With several keys, "the answer is there, the question isn't" isn't prevented by the token — the exercise's experiment 2.)

And the line under the table is worth remembering: **100% means "didn't break in these 300 histories" — not proof.** Less than 100% means it certainly breaks. Testing's eternal rule — Jepsen finds bugs, it doesn't prove correctness.

### 1.8 Serializable vs Linearizable — two different questions

The names are close, so in interviews and design docs they're the most often confused:

|                            | **Serializability** (5.5)                                                    | **Linearizability** (5.9, today)                                                             |
| -------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| About what                 | **Transactions** — several objects (rows) together                           | One operation on one **object**                                                              |
| What it says               | The transactions behave as if they ran one after another — in **some** order | An operation behaves as if it happened at one instant — and the order respects **real time** |
| Real time                  | Not respected — "some" order is enough                                       | Respected                                                                                    |
| Which problems it prevents | Write skew, lost updates, phantoms (5.5)                                     | Stale reads, old leaders (6.2)                                                               |

Both together: **strict serializability** — the transactions ran one after another, and that order respects real time.

**Strict serializability** — serializable + linearizable: there's an order of transactions, and a transaction that starts after another commits comes later in that order. Google Spanner calls it "external consistency" — and 6.4's TrueTime and commit wait are exactly for this.

The practical consequence for TaskFlow: a `SERIALIZABLE` transaction on the Postgres primary — but if the read comes from a **replica**, that read may be old (6.3). The transaction's isolation is fine, but the system is no longer linearizable. "We use SERIALIZABLE" and "our reads are always the latest" are two different claims.

### 1.9 A model per piece of data — TaskFlow's design doc

In 5.9 you made the CAP choice per piece of data. The same work, this time in the ladder's language:

| TaskFlow data                                   | Model                                    | How (which lesson)                                     | Why not weaker / not stronger                                                     |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| The reminder job's leader, the Postgres primary | Linearizable                             | etcd (6.2), linearizable reads                         | Two leaders mean duplicate emails / split brain                                   |
| Billing, subscriptions, permissions             | Strict serializable (within one primary) | Postgres primary, SERIALIZABLE, reads from the primary | A double charge or a wrong permission can't be undone                             |
| A user's own task list, task edits              | Read-your-writes + monotonic reads       | Version token, per user (6.3)                          | Millions of reads on replicas; a few ms of delay on others' edits is fine         |
| A task's comment thread                         | Causal (within a thread)                 | Shard by task/workspace (5.8, 6.3)                     | An answer without its question is odd; fully linearizable is needlessly expensive |
| Notification counts, presence, view counts      | Eventual (+ read repair)                 | Leaderless quorum store (5.9, 6.3)                     | The error is small and fixes itself; availability matters more                    |

And the design-doc line looks like this: **"Task list: read-your-writes + monotonic reads (version token, per user in Redis, TTL 5 minutes); other users' edits are usually < 100 ms late, up to 30 s if a replica stalls."** — the model's name, how it's achieved, and the worst a user can see.

---

## 2. Interview Angle

**"What is your system's consistency model?"** — Don't answer in one word ("strong", "eventual"). Answer per piece of data (like 1.9's table), and with each, "why this is enough". The interviewer's real question: do you know where an error is acceptable and where it isn't.

**"What's the difference between linearizable and serializable?"** — The two lines of 1.8's table: "Serializable is about transactions and doesn't respect real time; linearizable is about one object and respects real time. Both together are strict serializable — Spanner." Bonus: "SERIALIZABLE on the Postgres primary, but reading from a replica isn't linearizable."

**"A database says 'strongly consistent, globally distributed, always available' — would you believe it?"** — CAP (5.9): during a partition, linearizable plus answering from every side at once is impossible. So four questions: (1) does "strong" mean which model — linearizable, or just read-your-writes? (2) during a partition, which side stops answering? (3) are reads always from the leader/quorum, or from replicas by default? (4) has there been a Jepsen or similar independent test?

**"Why do we need causal consistency when we have session guarantees?"** — The "answer without the question" example: session guarantees look at one client's history; causal looks at causality between clients.

**In real production:** almost no system runs entirely on one model — like TaskFlow, it's mixed by data. And the model isn't just a database setting — reading from replicas, caches (Module 4 — a cache is a replica too!), CDNs, all together make up what users see, and that is the real model. Put a cache with a 10-minute TTL in front of a linearizable database, and to users the system is eventual.

---

## 3. Key Takeaway

- **Consistency model** = a contract: what a read may return when several clients run at once; the honest way to define it is the **history** — "is there a line, and which rules does it obey?"
- **Linearizable:** one copy, respects real time — "reading from an old leader" breaks it; for locks/leaders/uniqueness; costs a majority round trip and unavailability during partitions
- **Sequential:** only your own order, not real time — the old leader's read is valid here; it shows the cost of linearizability's "real time" part
- **Causal:** everyone sees causality in the same order, concurrent operations are free; possible even under partition; "the answer without the question" breaks it — where every session guarantee is ✓
- Session guarantees are separate — name them in the design doc; **eventual** alone says almost nothing (✓ even with clock-based LWW)
- **Jepsen:** check histories, not claims — in the exercise the version token was 100% sequential/causal but 48% linearizable; 100% means "didn't break", not proof
- **Serializable ≠ linearizable** (transactions vs objects, not respecting vs respecting real time); both together are strict serializable; choose the model per piece of data, and remember that what users see through caches/replicas combined is the real model

---

## 4. New Terms (Glossary)

| Term                       | Meaning                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consistency Model**      | A contract between a system and its user: what values a read may return when several clients run at once                                    |
| **Operation History**      | The record of which client started which operation when, when it finished, and what result it got; the model says which histories are valid |
| **Linearization Point**    | The imagined instant between an operation's start and finish when it's taken to have "happened at once"                                     |
| **Sequential Consistency** | There is a line that respects each client's own order — but doesn't respect real time across clients                                        |
| **Causal Consistency**     | Operations related by happens-before are seen by everyone in the same order; concurrent ones may be seen in different orders                |
| **Strict Serializability** | Serializable + linearizable: an order of transactions that also respects real time (Spanner's "external consistency")                       |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. Which models does this history satisfy? (Times in ms, `x` starts at 0)

   ```
   P1: write x=1   [0, 100]
   P2: read x → 1  [10, 20]
   P3: read x → 0  [30, 40]
   ```

   Linearizable? Sequential? And in what kind of real system could this happen?

2. The vendor's claim: "Strongly consistent. Globally distributed. Always available." Write the CTO a four-line answer — which parts are impossible together, and which four questions you'd ask the vendor.
3. For TaskFlow's task list, an engineer says: "We use `SERIALIZABLE` in Postgres, so our task list is strongly consistent." But the task list's reads come from replicas with a version token, and there's a 30-second Redis cache in front (Module 4). What is the task list's real consistency model from the user's point of view? Which component lowers it to which model?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** **Not linearizable.** P2's read finished at 20 ms and got the new value (1) — so the write's linearization point is before 20. P3 **started** reading at 30 — after P2's read finished — and got the old value (0). In real time the line is: write → P2 → P3, but then P3 shouldn't get 0. (The write itself runs until 100 — but that doesn't save it, because once anyone has seen the new value, everyone who starts after that must see it.) **Sequential — yes:** put P3's read before the write (P3 has no other operations), then the write, then P2 — every client's own order is intact. Causal, read-your-writes, monotonic — all ✓ (nobody's own history broke, and P3 isn't in any causal chain). In practice: the write went to the primary and reached one replica but not yet the other; P2 read from the fast replica, P3 from the slow one. Or in a leaderless quorum, during the write, two reads got two different pairs of replicas (6.3). This is sometimes called a "new-old inversion". It can be checked with the checker in the exercise's experiment 1 (the answer: linearizable ✗, everything else ✓).

**Question 2:** If "strongly consistent" means linearizable, CAP (5.9) says: to stay linearizable during a network partition, one side must stop answering — so "always available" together is impossible. (Even without a partition, "globally distributed" + linearizable means every write takes a round trip across continents — PACELC's cost.) So one of the claim's words is actually weaker. Four questions: (1) exactly which model does "strongly consistent" mean — linearizable, serializable, or just read-your-writes? (2) if the link between two regions is cut, which side stops taking writes, and which reads? (3) what's the default for reads — from the leader/quorum, or from the nearest replica (in which case it isn't strong by default)? (4) has there been any independent test (Jepsen or similar), and what was found? In practice most such claims mean "strong in normal times, the minority side stops during a partition" — which is completely reasonable; only the "always available" part is marketing.

**Question 3:** From the user's point of view, the model is **the weakest** of the three layers:

- `SERIALIZABLE` on the Postgres primary — the transaction's isolation is fine, but this only speaks about transactions that write/read on the primary.
- Reads from replicas with a version token — up to sequential/causal on one key (as in the exercise), but not linearizable: seeing another user's fresh edit isn't guaranteed.
- A 30-second cache in front — this lowers it the most. The cache has no token, so a user may not see even their own freshly written task for 30 seconds (read-your-writes breaks), and if the cache's different keys are filled at different times, an old value can come back on refresh (monotonic breaks). From the user's point of view: **eventual, within a 30-second window**.

So the "strongly consistent" claim is wrong — `SERIALIZABLE` speaks about one layer, not the whole path the user sees. The fix (Module 4 + 6.3 together): invalidate the cache after a write (4.3), and add the version-token idea to the cache — e.g. don't use a cache entry older than the user's token, or bypass the cache for a user who has just written.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (deterministic)

> **Ready to run in the repo:** [`exercises/lesson-6.5-consistency-models/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.5-consistency-models) — `npm install`, then `npm run models` and `npm run jepsen`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`checker.ts` has checkers for six models — searching for a possible line for linearizable and sequential (backtracking + memo), happens-before for causal (6.4), and direct checks for the session guarantees. `models.ts` holds seven incidents from Modules 5–6, `jepsen.ts` four simulated systems.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; both scripts were run twice with identical output; in the "one primary" system's 300 histories every model was 100% — a sanity check of the checker. Question 1's history was also checked with the checker. This is a learning checker — small histories, one or two keys; the real Jepsen (Knossos, Elle) handles much bigger histories and transactions. (The scripts print their labels in Bangla; the output shown in this edition is translated — the results are identical.)

**Once the setup is verified, do these five:**

1. **By hand first:** draw `models.ts`'s seven histories on paper (on a timeline), and guess every cell of the table **before** running. Then run and compare. Which cell did you get wrong, and which rule did you misunderstand?

2. **Your own history** (experiment 1): add question 1's history. Then build a history yourself that is **causal but not sequential** — two clients see two concurrent writes in different orders. (Hint: two writes, two readers, each reading twice.)

3. **Two keys** (experiment 2): add a second key to the version-token system. Does the causal percentage drop? In what kind of history does it break — like which example in 1.4?

4. **Break the checker** (experiment 4): make `linearizable()`'s rule wrong (`a.end < b.start` → `a.start < b.start`). Which histories' answers change, and what is this wrong rule really measuring? (How easily a bug in a checker makes a system look "correct" or "broken" — that's the lesson.)

5. **Design part:** write the "consistency" section of TaskFlow's design doc — 1.9's table in your own way, for at least seven pieces of data (including the cache and CDN!): the model's name, how it's achieved (which lesson's technique), and "the worst the user can see, for how long". Then four lines for the CTO answering the vendor's claim (question 2).

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (complete, including exit challenges), 6.1, 6.2, 6.3, 6.4, 6.5
Current: 6.5 — Consistency Models (the last lesson of Module 6)
TaskFlow state: Nginx + Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; consistency models per piece of data in the design doc: leader/lock →
linearizable (etcd), billing/permissions → strict serializable (primary, SERIALIZABLE), task
list → RYW + monotonic (version token), comments → causal (shard by task), counts/presence →
eventual (quorum + read repair); the effect of caches/CDN accounted for
Terms learned (Module 6): Partial Failure, Failure Model, Failure Detector, Process Pause,
Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility, Replicated State Machine,
Term, Randomized Election Timeout, Committed Entry, Election Restriction, Session Guarantee,
Monotonic Reads, Consistent Prefix Read, Version Token, Read Repair, Hinted Handoff,
Anti-Entropy, Monotonic Clock, Clock Skew/Drift, Happens-Before, Lamport Clock, Vector Clock,
Sibling, Hybrid Logical Clock, Consistency Model, Operation History, Linearization Point,
Sequential Consistency, Causal Consistency, Strict Serializability
Weak spots: [where you got stuck — fill this in yourself]
Next: Module 6 Exit Challenge
=======================
```

---

## 8. Next Step

Run the exercise and send it over — especially your "causal but not sequential" history in #2 and your design-doc section in #5. This is the last lesson of Module 6. When you are ready, write `next` — the **Module 6 Exit Challenge**: a mini design challenge (Tier 3) where the whole module — failure models, split brain and fencing, consensus, session guarantees, logical clocks, consistency models — is needed together in a realistic scenario; a "you should be able to do these" checklist; and recommendations for books, videos and projects. Then Module 7 — Asynchronous Processing & Messaging: so far everything has been about "one request, one answer"; now the world of doing work later, queues, and retries — where today's "exactly once" questions come back in a new form.
