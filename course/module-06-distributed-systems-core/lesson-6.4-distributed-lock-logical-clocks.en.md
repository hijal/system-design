# Lesson 6.4 — Distributed Locks and Logical Clocks: Why Clocks Can't Be Trusted, Lamport, Vector Clocks

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 2.2):** A server's clock is mistakenly two days behind. When this server calls another HTTPS API, what could happen in the TLS handshake — and why? (Which two dates are inside a certificate?)

**Prerequisite:** Lesson 5.7 (Multi-leader, LWW), Lesson 5.9 (The LWW story during a partition), Lesson 6.1 (Leases, fencing tokens), Lesson 6.2 (Terms), Lesson 6.3 (Consistent prefix)

**By the end of this lesson you will be able to:**

1. Tell the two kinds of clock (time-of-day and monotonic) apart, explain why two machines' clocks never agree — and know which to use where in code
2. Think about the order of events with the "happens-before" relation, and compute Lamport clocks and vector clocks by hand — knowing what each can and can't tell you
3. Measure the cost of last-write-wins, know the cost of keeping concurrent writes (siblings) — and know where clocks get into distributed locks/leases, and where not to let them in

**Tier:** 1 — Runnable Code (a hand-checkable example, and a deterministic simulation)

---

## 0. Where TaskFlow Is Right Now

TaskFlow has launched two big things: a mobile app that lets you edit tasks **offline** (synced later), and a pilot that takes writes in three regions — Dhaka, Singapore, Frankfurt — each with a replica that accepts writes to task titles and descriptions and sends them to the others (5.7's multi-leader). The conflict rule is simple, Cassandra-style: **the bigger timestamp wins** (last-write-wins).

Three tickets in one week:

1. **"I set the status to 'Done', but [DONE] didn't appear in the title."** TaskFlow has an automation: when a status becomes Done, it puts `[DONE]` in front of the title, within 200 ms. On some tasks the automation's write **was lost** — the old title stayed. Every case was on the Singapore replica.
2. **"My colleague and I edited the description at the same time — mine vanished without a trace."** No error, no conflict warning.
3. While debugging, an engineer sorted the logs of the three regions by timestamp — and saw that for one task the line "comment notification sent" came **before** "comment created".

The investigation found that the Singapore machine's NTP had been broken for several days — its clock was 400 ms behind. But even after the clock was fixed, ticket 2 didn't stop.

Four times — in Lessons 5.7, 5.9, 6.1 and 6.3 — we said "clocks can't be trusted, in 6.4." This is that lesson. First half: why. Second half: how to know "which happened first" without a clock.

---

## 1. Theory

### 1.1 Two kinds of clock

Every computer really has two clocks, with different jobs:

- **Time-of-day clock (wall clock)** — "what time is it": milliseconds since 1970. In Node, `Date.now()`, `new Date()`. NTP keeps it correct — and in correcting it, can make it **jump forwards or backwards**.
- **Monotonic clock** — how much time has passed since some point; it only moves forwards, never jumps, never goes back.

**Monotonic clock** — a clock only for measuring **durations**: it always moves forwards and isn't changed by NTP's jumps; but its value means nothing on another machine (in Node, `performance.now()`, `process.hrtime.bigint()`).

The most common bug:

```typescript
// ✗ wrong — if NTP pushes the clock back, elapsed is negative; forward, suddenly huge
const start = Date.now();
await doWork();
const elapsed = Date.now() - start;

// ✓ always monotonic for measuring durations
const t0 = performance.now();
await doWork();
const elapsedMs = performance.now() - t0;
```

This isn't theoretical. In the last minute of **31 December 2016** (UTC) a leap second was added — that minute had 61 seconds. One part of Cloudflare's DNS software computed a duration from the difference between two wall-clock readings — at that moment time "went backwards", the difference became negative, and the code crashed. Some customers' DNS resolution failed. (The language they used — Go — added a monotonic clock to its `time` package in the next version, largely because of this incident.)

The rule: **use monotonic time to measure durations (timeouts, leases, latency). Use the wall clock to show humans "when it happened".** And to decide the order of events across two machines — neither (the rest of this lesson).

### 1.2 Why two clocks never agree

Every machine's clock counts the vibrations of a quartz crystal. Crystals don't vibrate at exactly the same rate, and temperature changes the rate.

**Clock skew** — the difference between two machines' clocks at the same moment; and **drift** — how much faster or slower a clock runs than real time (usually in "parts per million", ppm).

Some numbers:

- Google's Spanner paper assumes that a server's clock drifts by **200 ppm** in the worst case — 200 microseconds every second, ~17 seconds a day. In practice it's usually better than that, but a machine without NTP drifts by seconds upon seconds in a few days.
- NTP keeps clocks right — within a millisecond or less with a good setup inside a data center, a few dozen ms over the internet. Some clouds now offer even more precise time (PTP, at the microsecond level).
- But NTP itself breaks: a firewall blocks NTP, the config is wrong, a VM is moved from one host to another, a container's clock depends on the host — and then the skew is seconds, minutes, days. The 400 ms on TaskFlow's Singapore machine is an ordinary day of that kind.
- **Leap seconds:** to keep in step with the Earth's rotation, a second is added now and then. The 2012 leap second triggered a Linux bug that sent many servers' CPUs to 100% (Reddit and Mozilla among many that suffered). Now the big clouds spread the leap second over a whole day ("leap smear") — but then their clocks deliberately differ from official time by a few hundred ms.

In short: **the difference between two machines' clocks is never zero, usually small, and on the worst day unknowably large.** And you won't know which day is the bad day.

### 1.3 Last-Write-Wins — judging by the clock

The machinery of ticket 1: each write carries the timestamp of the clock of the replica that wrote it; in a conflict between two writes the bigger timestamp wins and the smaller is **thrown away**. Cassandra does exactly this for every column value, and it's the default in many multi-leader systems.

The exercise's `npm run lww` — like TaskFlow's pilot: three replicas, n3 (Singapore) with its clock 400 ms behind, n2 30 ms ahead. 6 humans and 2 automation bots edit the same title for two minutes — read from a replica, think (humans 3 s on average, bots 50–300 ms), then write to some replica. The simulation knows the **real** causality of every write (which version it was written after seeing), and counts every discarded write in two groups:

```
   rule                  total edits  later edit lost to the    concurrent edit     app asked      not in the final   replicas
                                      earlier one               silently dropped    to merge       title's history    agree?
   LWW — wall clock          164               10                   43               0               100       yes
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**"Later edit lost to the earlier one" — 10.** Meaning: the bot **saw** the title, then wrote it with `[DONE]` — its write really was later, and made knowing the earlier one — and yet the earlier one won. Measured: all 10 are the bot's, all 10 on n3. The bot reacts in 200 ms, n3's clock is 400 ms behind, so the timestamp of the bot's write is **older even than the write it saw before writing**. Ticket 1 exactly.

(The exercise's experiment 1: fixing n3's clock drops this column from 10 to 0. So this damage is entirely the clock's.)

**"Concurrent edit silently dropped" — 43.** Two people saw the same version and wrote at almost the same time — neither knew about the other. LWW keeps one and throws the other away — with no error, telling nobody. Ticket 2. And in experiment 1, with the clock fixed, this number stays about the same (43 → 45): **this damage isn't the clock's, it's the rule's.** However precise the clock, LWW will throw away one of two concurrent writes — that's its definition.

And look at the last column: "replicas agree? yes." All the replicas agree on one answer — the wrong answer. LWW always **converges**; correctness is a separate question.

### 1.4 Happens-Before — order without time

In 1978 Leslie Lamport (yes, 6.2's Paxos) wrote a paper that is the foundation of this whole field: "Time, Clocks, and the Ordering of Events in a Distributed System". The core idea: in a distributed system we don't really want to know "what time did each thing happen" — we want to know **"what could have influenced what."**

**Happens-before (a → b)** — event a could have influenced event b; by three rules: (1) in the same process, a first, b after; (2) a is sending a message, b is receiving that message; (3) if a → b and b → c, then a → c. And if neither a → b nor b → a, then a and b are **concurrent**: neither knew about the other.

The events of the exercise's `npm run clocks` in a space-time diagram (time runs left to right):

```
   A (Rahim's laptop)  a1 ──── a2 ──────── a3 ──────────────────────────── a4
                              │ m1                                         ▲
                              ▼                                            │ m3
   B (server)                 b1 ──── b2 ──── b3                           │
                                      │ m2                                 │
                                      ▼                                    │
   C (Karim's phone)   c1 ──────────── c2 ──── c3 ─────────────────────────┘
```

- a1 → a4 (same process). a2 → c2 (a2 → b1 → b2 → c2, following the chain of messages).
- **c1 and a2 are concurrent** — Karim wrote a comment offline, Rahim didn't know about it, and Rahim's work didn't reach Karim either.
- **a3 and b3 are concurrent** — B doesn't know about a3 (A sent no message after a3); A doesn't know about b3.

"Concurrent" doesn't mean "at the same time" — a3 and b3 may be a second apart on the wall clock. It means **neither knew about the other.** And it's exactly these pairs that conflict — ticket 2's two description edits.

### 1.5 Lamport Clocks

The simplest way to capture happens-before in a number:

**Lamport clock** — a counter per process: it goes up by one on every event; it's sent along with every message; on receiving a message, own counter = max(own, received) + 1.

```
   event  process  kind      Lamport   what happened
   a1    A        local        1      Rahim wrote the title
   c1    C        local        1      Karim wrote a comment offline
   a2    A        send m1      2      sent the title to the server
   b1    B        recv m1      3      server got the title          ← max(0, 2) + 1
   a3    A        local        3      Rahim changed the description
   b2    B        send m2      4      server notified Karim
   b3    B        local        5      server wrote the audit log
   c2    C        recv m2      5      Karim got the notification    ← max(1, 4) + 1
   c3    C        send m3      6      Karim replied to Rahim
   a4    A        recv m3      7      Rahim got the reply           ← max(3, 6) + 1
```

The guarantee: **if a → b, then L(a) < L(b).** An event that could have influenced another always has a smaller number. And if equal numbers are broken by process name (a `(L, process)` pair), you get a **total order** of all events that never contradicts causality.

So doing LWW with a Lamport clock removes ticket 1's problem:

```
   LWW — Lamport clock       164                0                   45               0               101       yes
```

"Later edit lost" — **0.** The Lamport number of the version the bot read reaches the bot's replica (along with the read), so the number of the bot's write is always bigger — no clock needed.

But "concurrent edit silently dropped" — still **45.** Because Lamport's guarantee is **one-directional**: if a → b then L(a) < L(b) — but if L(a) < L(b), it does **not** follow that a → b. The last part of `clocks`:

```
   pair        Lamport says      vector clock says
   c1, a2      c1 < a2           concurrent — neither knew about the other
   a3, b3      a3 < b3           concurrent — neither knew about the other
```

Seeing 3 < 5, Lamport calls a3 "earlier", even though a3 and b3 didn't know about each other. A Lamport clock puts even concurrent events into an order — and LWW looks at that order and throws one away. Ticket 2 remains.

(Sound familiar? 6.2's Raft **term** is really a Lamport-style clock: it goes with every message, and seeing a bigger one raises your own. Logical clocks are everywhere in distributed systems.)

### 1.6 Vector Clocks — recognising concurrency

One number isn't enough to recognise concurrency — you need one per process.

**Vector clock** — every process keeps a list of counters, one for every process: on its own event it increments its own entry; it sends the whole list with a message; on receiving, it takes the max in every entry (then increments its own).

```
   event  vector [A,B,C]
   a3     [3,0,0]        knows A's 3 events, nothing of B or C
   b3     [2,3,0]        knows A's first 2 (via m1), and its own 3
   c3     [2,2,3]
   a4     [4,2,3]        ← max in every entry of [3,0,0] and [2,2,3], then A's entry +1
```

The comparison rule: **every** entry of V(a) is less than or equal to V(b)'s (and at least one is smaller) → a → b. a is bigger in some entry and b in another → **concurrent**. a3 = [3,0,0], b3 = [2,3,0]: a3 is bigger in A's entry, b3 in B's → concurrent. That's what Lamport couldn't tell.

Now in database terms: each version carries a vector (how many writes of which replicas this version "knows"). If a new write covers every entry of the old one's vector → throw the old one away with confidence (there's causality). If it doesn't cover it → the two are concurrent → **keep both**:

**Sibling** — two (or more) concurrent versions, neither of which covers the other; the database keeps both and hands both to the next reader, and merging is the application's job.

```
   Vector clock (sibling)    164                0                    0              48                 0       yes
```

Nothing was lost — both damage columns are zero, every edit is in the final title's history. But **48 times** the app was told "there are these two (or three) values — you merge them." The cost didn't disappear, it moved: from the database to the application. And merging isn't always easy: how do you merge two titles? (Show the user and ask — like a Git merge conflict.) For some data it's natural: a task's **set** of labels — take the union of the two siblings. The famous example from Amazon's Dynamo paper (2007) is exactly this — the union of shopping-cart siblings. (The cost: a removed item sometimes comes back — remember 5.9's label example. And data types that "merge themselves" like this are called CRDTs.)

**Two warnings from practice:**

- The vector's size — one entry per **replica**, not per client (with thousands of clients the vector would be huge). The exercise does this.
- A subtle bug: with a plain vector clock, when one write arrives on a replica and another arrives right after, the first can wrongly be treated as "old". Riak moved to **dotted version vectors** to fix this — keeping each write's own "dot" (which replica's write number it is) separate from the context it saw. The exercise's `lww.ts` uses exactly this — and that's one more reason not to write these things yourself.

### 1.7 The middle ground — Hybrid Logical Clocks and TrueTime

One drawback of logical clocks: their numbers have no relation to the wall clock. You can't ask "show me the writes of the last 5 minutes", and humans debugging don't understand what "Lamport 48213" means.

**Hybrid Logical Clock (HLC)** — a timestamp made from the wall-clock time plus a small logical counter: it usually stays close to the wall clock (humans can read it), but it advances with messages like Lamport's, so causality never breaks — even when the clock is a bit wrong.

CockroachDB uses HLCs; MongoDB's cluster time (6.3's `afterClusterTime`) is of this kind too. An HLC preserves causality, but doesn't recognise concurrency — it's still in Lamport's family.

And a solution from the opposite direction: **Google Spanner's TrueTime.** Every data center has GPS receivers and atomic clocks, and the API doesn't return a number but a **range**: "the time now is somewhere within [earliest, latest]" — usually a few ms of uncertainty. After committing a transaction, Spanner **waits** until that uncertainty has passed (commit wait), and only then makes the commit visible — so that any transaction started later anywhere is guaranteed a bigger timestamp. That is, instead of denying the clock's error, **measure it and pay for it** (a few ms on every write). Without special hardware this can't be copied.

### 1.8 Distributed Locks and Clocks

Back to 6.1's lease, this time through the eyes of the clock. A lease's expiry = a **duration** — so if you follow 1.1's rule, the two machines' clocks don't need to agree at all. They only need to run at roughly **the same speed**. Even so, clocks can break a lease in three places:

1. **Computing the expiry with the wall clock.** The lock server stores `expiresAt = Date.now() + ttl`; then NTP pushes its clock forward 2 seconds — every lease suddenly ends 2 seconds early, while the holder is still working. Two holders. (The same on the holder's side: if it computes "how long is left on my lease" with `Date.now()`, when the clock goes back it will think the lease has lots of time left.) **Fix:** monotonic clocks on both sides.
2. **Drift.** The holder's clock runs a bit slow — 10 seconds by its count, 10.002 by the lock server's. Usually small, but the holder should compute the expiry **on the safe side**: count from the moment the request is **sent** (the worker in 6.1's exercise did exactly this), and stop a bit before the last moment.
3. **Pauses** — the whole of 6.1. However precise the clock, a paused process doesn't look at it.

So 6.1's conclusion is now even stronger: let the lease use the clock for **efficiency** — but for **correctness**, a fencing token. And what is a fencing token? A number that only goes up, where the bigger one wins — a **logical clock**. 6.2's term, etcd's revision, today's Lamport clock — three forms of the same idea.

(A practical detail: etcd's lease expiry is computed by etcd's leader, on its own clock. When the leader changes, the new leader restarts every lease's expiry — so nobody's lease ends needlessly during the leader change. A mistake on the safe side: a lease sometimes lasts a bit **longer**, never shorter.)

> **Trade-off Table — Ways to decide "which came first / which is newer"**

| Method                     | Preserves causality?                   | Recognises concurrency? | Cost                                               | Where                                    |
| -------------------------- | -------------------------------------- | ----------------------- | -------------------------------------------------- | ---------------------------------------- |
| Wall-clock timestamp (LWW) | No — with skew the later write is lost | No — throws one away    | Zero; the damage is silent                         | Cassandra's default, many caches         |
| Lamport clock (LWW)        | Yes                                    | No — throws one away    | One number per message                             | Log ordering, Raft terms, fencing tokens |
| Hybrid Logical Clock       | Yes                                    | No                      | One number; close to the wall clock, readable      | CockroachDB, MongoDB cluster time        |
| Vector clock + siblings    | Yes                                    | Yes — keeps both        | One entry per replica; the app has to merge        | Dynamo, Riak; offline sync               |
| TrueTime + commit wait     | Yes, aligned with the wall clock       | —                       | GPS/atomic-clock hardware; a few ms on every write | Google Spanner                           |

---

## 2. Interview Angle

**"What's wrong with ordering two servers' events by timestamp?"** — Skew, drift, NTP jumps, leap seconds — the timestamp order and the real causal order can differ. Then say what you'd use: logical clocks when you need causality; for debugging logs, a trace id on each request (Lesson 10.4) that holds the whole chain.

**"What's wrong with last-write-wins?"** — Separate the two kinds of damage, that's the real answer: (1) the clock's error loses the **later** write — fixed with Lamport/HLC; (2) one of two **concurrent** writes is silently lost — no clock fixes this, because it's LWW's definition. Then: "for data where losing a write is fine (a cache, last-seen) LWW is fine; where it isn't, vector clocks + siblings, or avoiding conflicts (all writes to one piece of data through one leader)."

**"What's the difference between Lamport clocks and vector clocks?"** — In one sentence: "Lamport can say 'this didn't happen before', vector can say 'these are concurrent'." Then the cost: Lamport is one number, vector one per node.

**"How do you measure a timeout in a distributed lock?"** — A monotonic clock, the expiry on the safe side, and don't trust the lease for correctness — use a fencing token.

**In real production:** NTP (or the cloud's time-sync service) running on every server, and **monitored** — alert on skew. In code review, catch timeouts measured with `Date.now()`. And before choosing LWW as a conflict rule, ask: "what happens if a write on this data is silently lost?"

---

## 3. Key Takeaway

- Two kinds of clock: the **wall clock** (what time is it — can jump, can go backwards) and the **monotonic** clock (how much time passed — only for measuring durations); timeouts/leases/latency always monotonic
- Two machines' clocks never agree: drift, NTP's limits and failures, leap seconds — and you can't know the worst day in advance
- **LWW does two separate kinds of damage:** the clock's error loses the **later** write (10 in the exercise, all by bots on the replica whose clock was behind), and one of two **concurrent** writes is silently lost (43 — stays even when the clock is fixed)
- **Happens-before:** "what could have influenced what" — the order within a process and the chain of messages; if neither, concurrent
- **Lamport clock:** if a → b then L(a) < L(b), but not the reverse; preserves causality (first kind of damage zero), doesn't recognise concurrency (the second remains)
- **Vector clock:** recognises concurrency, keeps both as **siblings** — nothing is lost, but merging is the application's burden; HLC and TrueTime are middle paths
- In locks/leases, the clock only for durations (monotonic, on the safe side); correctness comes from the fencing token — which is itself a logical clock

---

## 4. New Terms (Glossary)

| Term                     | Meaning                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Monotonic Clock**      | A clock only for measuring durations — always moves forwards, isn't changed by NTP's jumps; its value means nothing on another machine |
| **Clock Skew / Drift**   | The difference between two clocks at the same moment (skew), and how much faster/slower a clock runs than real time (drift, in ppm)    |
| **Happens-Before**       | a could have influenced b — earlier/later in the same process, or through a chain of messages; if neither, the two are concurrent      |
| **Lamport Clock**        | A counter per process — goes up on every event, goes with messages, max + 1 on receipt; if a → b then L(a) < L(b)                      |
| **Vector Clock**         | Every process keeps a list of everyone's counters; comparing them says a → b, b → a, or concurrent                                     |
| **Sibling**              | Two (or more) concurrent versions, neither covering the other — the database keeps both, the application merges                        |
| **Hybrid Logical Clock** | Wall-clock time + a logical counter — readable by humans, and causality never breaks                                                   |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. Ticket 3: sorting the three regions' logs by timestamp puts "notification sent" first and "comment created" after. Is this a bug? For debugging, what would you add to the logs so the causal order always shows correctly?
2. If you found this in a code review:

   ```typescript
   const acquiredAt = Date.now();
   while (Date.now() - acquiredAt < LEASE_MS - 500) {
   	await processNextBatch();
   }
   ```

   What problems would you point out? If it's changed to `performance.now()`, does the lease become safe?

3. TaskFlow's offline mobile app: two devices, while offline, changed the same task's (a) title, (b) description, (c) list of checklist items, and (d) "done" status. Later both synced. For each, which conflict rule would you choose — LWW (with which clock?), showing siblings and asking the user, or merging automatically — and why?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Not a bug — it's the skew between three machines' wall clocks. If the server that sent the notification has a clock behind the one that created the comment, the later event gets the smaller timestamp. However good the clocks, if two events happen within a few ms of each other this will happen. The fix: record causality in the logs, not time. The most practical: a **trace id** for each request, and a **parent span id** at each step — which event was caused by which is written directly (Lesson 10.4's distributed tracing). An alternative: send a Lamport counter along with messages from service to service and write it into the logs — then sorting by `(lamport, service)` never breaks causal order. Keep the wall-clock timestamp for humans ("roughly when"), not for ordering.

**Question 2:**

- **Duration by the wall clock:** if NTP pushes the clock back, `Date.now() - acquiredAt` gets smaller — the loop keeps running past the lease's expiry. Push it forward and it stops early for no reason. → `performance.now()`.
- **Where the expiry is counted from:** `acquiredAt` is taken after **getting** the lock — but the lock server's expiry started when the request arrived, which is earlier. Safe: take the time before **sending** the request.
- **Checking only at the start of each batch:** if one `processNextBatch()` takes 3 seconds (or hits a GC pause midway), the last batch runs outside the lease. The 500 ms margin doesn't catch this.
- **And most important:** even changed to `performance.now()`, the lease **does not become safe** — 6.1's process pause can land between any check and the work. A monotonic clock fixes the clock's jumps, not pauses. Every batch's write needs a fencing token.

**Question 3:**

- **(a) Title:** short, one value; two versions can't be merged. If two devices changed it concurrently, showing the user and asking them to choose (siblings) is the most honest; but title conflicts are usually rare, and losing one does little harm — so many apps choose LWW. If you do, **not** by the device's wall clock (a phone's clock can be wrong, the user can change it) — by an HLC or the order of the server's sync, plus a small "someone else changed this" notification.
- **(b) Description:** long text, losing two people's work is serious. Keep siblings and show both (merge like Git), or better — a CRDT built for text (as in Google Docs/Notion-style collaborative editing), which merges both people's changes at the character level.
- **(c) Checklist items:** a set/list — it can merge automatically: the union of items added on both sides; for removed items keep a "tombstone" (a marker of deletion), or the removed item will come back (Dynamo's shopping-cart problem). No need to ask the user anything.
- **(d) Done status:** a boolean — but the rule belongs to the business: one person marked it done, another (looking at the old state) changed something else but didn't touch the status — then there's no status conflict at all (merge by field, not by the whole task). If both changed the status (one done, one not done), usually "done wins" or the write latest in causal order wins — but the product decides that, not a clock.

The general lesson: conflict rules must be chosen **by the kind of data, field by field** — a single LWW for the whole object is the simplest, and often loses the most data.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (deterministic)

> **Ready to run in the repo:** [`exercises/lesson-6.4-logical-clocks/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.4-logical-clocks) — `npm install`, then `npm run clocks` and `npm run lww`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`clocks.ts` is a hand-checkable example — the rules of Lamport and vector clocks, with comments. `lww.ts` is a simulation of three replicas and three conflict rules, which knows the real causality of every write and uses it to measure what each rule lost.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; both scripts were run twice with identical output. Extra checks: fixing n3's clock drops "later edit lost" from 10 → 0 (the README's experiment 1); and it was also measured that each of those 10 was a bot's write on n3. Experiments 2–4 are yours. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Paper first:** work out the Lamport and vector timestamps of `clocks.ts`'s 10 events by hand, then run `npm run clocks` and compare. If you went wrong somewhere, which rule did you miss? Then find a pair yourself (outside the table) that is concurrent.

2. Run `lww`. For each of the three rows, write one line: what this rule loses, and why.

3. **A clock ahead** (experiment 2): n3's skew `+400`. Whose writes are lost now? One line on how the damage from a clock behind and a clock ahead differs.

4. **Merge** (experiment 4): instead of a title, take a task's set of labels. Write the code that, when the `vector` rule returns siblings, writes their union. After removing a label on one device and adding another on a second device at the same time — what's left? Does the removed label come back?

5. **Design part:** write the conflict rules for TaskFlow's multi-region pilot and offline app — field by field (title, description, status, assignee, labels, checklist, due date). For each: LWW (with which kind of clock), siblings + asking the user, or merging automatically. And show where each of tickets 1, 2 and 3 is closed by your rules.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (complete, including exit challenges), 6.1, 6.2, 6.3
Current: 6.4 — Distributed Lock, Logical Clock: Lamport, Vector Clock
TaskFlow state: Nginx + Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; a version token on the read path; a multi-region write pilot and an
offline mobile app — conflict rules per field (no wall-clock LWW; HLC/Lamport ordering, siblings for
descriptions, automatic merging for labels/checklists); every timeout/lease on a monotonic clock;
alerts on NTP skew; trace ids in the logs
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility,
Replicated State Machine, Term, Randomized Election Timeout, Committed Entry,
Election Restriction, Session Guarantee, Monotonic Reads, Consistent Prefix Read,
Version Token, Read Repair, Hinted Handoff, Anti-Entropy, Monotonic Clock,
Clock Skew/Drift, Happens-Before, Lamport Clock, Vector Clock, Sibling,
Hybrid Logical Clock
Weak spots: [where you got stuck — fill this in yourself]
Next: 6.5 — Consistency models: strong → eventual, what it feels like in practice
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your hand calculation in #1 and your field-by-field rules in #5. When you are ready, write `next` — Lesson 6.5: **Consistency models — from strong to eventual.** Across Module 6 many guarantees have come up by name — linearizable (6.2's ReadIndex), read-your-writes and monotonic reads (6.3), causal (6.3–6.4), eventual (5.9). In the module's last lesson we'll arrange them on a ladder: which is stronger than which, what you lose and gain at each step, and a clear answer to the interview question "what is your system's consistency model?"
