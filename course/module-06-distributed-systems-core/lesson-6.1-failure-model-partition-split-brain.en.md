# Lesson 6.1 — What Breaks in a Distributed System: Failure Models, Network Partitions, Split Brain

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 2.5):** TaskFlow's client sent a `POST /api/tasks` and got a timeout after 5 seconds. Was the task created on the server or not — does the client know? What exact problem does an idempotency key solve here?

**Prerequisite:** Lesson 1.6 (SPOF), Lesson 2.5 (Idempotency), Lesson 3.4 (Health checks, failover), Lesson 5.7 (Failover, RPO/RTO), Lesson 5.9 (Network partitions, quorums)

**By the end of this lesson you will be able to:**

1. Organise the ways a distributed system breaks into a **failure model** — how nodes fail, how the network fails — and explain why it is impossible to tell "the other node is dead" apart from "the other node is slow"
2. State the trade-off in choosing a failure-detection timeout with numbers, and show how a **process pause** turns a leader with perfectly correct code into a "zombie"
3. Explain why **split brain** happens, and know what each of four defences — majority, lease, fencing token, idempotency — prevents and, just as important, what it does **not**

**Tier:** 1 — Runnable Code (a seeded simulation, and two real Node processes fighting to be leader)

---

## 0. Where TaskFlow Is Right Now

At the end of Module 5 TaskFlow looks like this: several Express instances behind Nginx, a Redis cache, and a PostgreSQL primary + read replica — with automatic failover (following the plan from Lesson 5.7: if the primary doesn't respond for 10 seconds, the replica is promoted).

And one new thing: **due-date reminders**. Every few seconds a job runs and emails the assignee of every task due tomorrow. There are six Express instances, but the job must run on **exactly one** — otherwise every email goes out six times. The team picked a simple solution: a lock in Redis with a 30-second expiry. Whichever instance holds the lock is the "leader" — it sends the reminders and renews the lock before it expires.

Two incidents in the same week:

1. **Tuesday, 2:14 a.m.** A network switch in the data center misbehaved for 40 seconds. The monitor couldn't reach the primary, and after 10 seconds the replica was promoted. But the primary hadn't died — three app instances could still talk to it, and for 40 seconds they kept writing to the **old** primary. In the morning, 212 tasks existed only on the old primary and not on the new one.
2. **Thursday.** A support ticket: "I got tomorrow's deadline reminder four times." Digging through the logs showed that the leader instance had been stuck for several seconds parsing the JSON of a huge export. Its lock had expired, another instance had become leader — and the old leader woke up and finished its half-done work.

In the post-mortem meeting, one engineer said: "I read the reminder code line by line — the lock is checked before every step. There's no bug."

They are right. And that is the subject of today's lesson: in a distributed system **every line can be correct and the whole system can still be wrong** — because the failures are not in the lines of code but **between** them. In the exercise we'll reproduce Thursday's incident exactly, with two real processes.

---

## 1. Theory

### 1.1 Partial Failure — the core difference between one machine and many

A program on your laptop either runs or crashes. There is almost no in-between — a machine where part of the RAM works and the rest doesn't just doesn't happen; if it did, the whole machine would go down. That's deliberate design: when something goes wrong in hardware, it's better to stop everything than to give wrong answers.

A distributed system doesn't get this luxury.

**Partial failure** — some parts of the system have failed while the rest keep running, and often you can't know for sure which part has failed.

Look at the most ordinary moment: an app server sent a request to the database, and no answer came back. What could have happened?

```
  app server                    network                    database
  ──────────                    ───────                    ────────
  sent request ──────► ① lost on the way
               ──────► ② stuck on the way (in a queue), will arrive later
               ─────────────────────────────────► ③ database died before it arrived
               ─────────────────────────────────► ④ did the work, then died
               ◄────── ⑤ the reply got lost ◄──────────── did the work and replied
               ◄────── ⑥ the reply is coming, just late ◄─ was slow / paused (GC)

  To the app server all six look the same:  … silence.
```

In ④ and ⑤ the work **has been done**; in ① and ③ it hasn't; in ② and ⑥ it may still happen. The app server doesn't know which. This is the real reason for Lesson 2.5's idempotency key — a timeout doesn't mean "failed", a timeout means **"I don't know"**. (That's also the answer to today's spaced-repetition question.)

And notice: the **only** way to know what state another machine is in is a message over the network. If no message arrives, you know nothing — you can only guess.

### 1.2 Failure Model — deciding up front what can break

No algorithm stays correct under "every kind of failure". So every distributed-system design starts with a contract: I assume these things can break, and these can't.

**Failure model** — an explicit list of the kinds of failure a system is designed to handle.

**How nodes (machines/processes) fail:**

| Kind               | What happens                                                                  | Real example                                                             |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Crash-stop**     | The node dies and never comes back                                            | Hardware completely destroyed; a simplified model, common in textbooks   |
| **Crash-recovery** | The node dies and later comes back — with what was on disk, losing all memory | Process restart, machine reboot — Postgres comes back via the WAL (5.3)  |
| **Byzantine**      | The node gives wrong or false answers — a bug, corrupted data, or on purpose  | Blockchains, aircraft control systems; not assumed for ordinary backends |

Ordinary backend systems (Postgres, Kafka, etcd, and TaskFlow) assume **crash-recovery** — a node can die and come back, but it doesn't lie. Handling Byzantine failures is far more expensive, and for your own servers in your own data center it usually isn't needed.

**How the network fails:** a message can get lost, arrive late, arrive out of order, arrive twice (from a retry). And the most important point: **there is no upper bound on delay.** One message arrives in 1 ms, another in 30 seconds — and both are "normal". This kind of network is called asynchronous — and the internet and data-center networks are all of this kind.

**How clocks fail:** every machine's clock runs at a slightly different speed, and when NTP corrects it, the clock can suddenly jump forwards or backwards. This is a big enough topic that a whole lesson (6.4) is saved for it — for today just remember: **you can't trust another machine's clock, and not fully your own either.**

This model isn't something to memorise — it's a question to ask in every design: "Which failures does this survive, and which doesn't it?" The Raft algorithm in Lesson 6.2 assumes exactly this model: crash-recovery nodes, an asynchronous network, no Byzantine failures.

### 1.3 "Dead, or Just Quiet?" — Failure Detectors and Timeouts

Failover (5.7), a load balancer's health check (3.4), a lock's expiry — all of them start with one question: **is the other node dead?**

**Failure detector** — the mechanism that decides whether a node is dead; almost always built from a heartbeat (a regular "I'm alive" message) and a timeout (if nothing arrives for this long, consider it dead).

From 1.1 we know what it's really doing: **guessing from silence.** And guesses are wrong. The only questions are — which way wrong, and how often.

The exercise's `npm run detector` runs a primary for 24 hours. The primary is **alive** the whole time — it never crashes once. It just goes quiet now and then: 1% of heartbeats are lost on the network, and on average once every ~200 seconds the process stops (mostly briefly, like a GC; occasionally for 1–8 seconds, like a VM or disk problem):

```
   heartbeats arrived: 852,617; the longest silence between two was 7.75 s

   timeout     false "dead" declarations / day     time to notice a real crash (p50 / p99)
     150 ms           8751                101 ms /   151 ms
     300 ms            241                251 ms /   301 ms
     500 ms            102                451 ms /   501 ms
     1.00 s             53                951 ms /   1.00 s
     2.00 s             42                1.95 s /   2.00 s
     5.00 s             22                4.95 s /   5.00 s
    10.00 s              0                9.95 s /  10.00 s
```

(An honest note: the pause and loss rates are a model I assumed, not measurements of any particular system. It's not the numbers but **the shape** that is real — and that shape is the same in every real system. The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

Read the table from both sides:

- **Left side:** with a 1-second timeout, a perfectly healthy primary is declared "dead" 53 times a day. Every declaration means a failover — and Tuesday's incident showed that a needless failover is an accident in itself.
- **Right side:** with a 10-second timeout there are zero false declarations — but when the primary really dies, nobody notices for 10 seconds. For those 10 seconds TaskFlow takes no writes (5.7's RTO).
- And even the "0" in the 10-second row is a trap. The longest silence in these 24 hours was 7.75 seconds. What if next week brings a 12-second pause? **No timeout is safe** — only more or less risky.

**So how do you choose a timeout?** By looking at the **cost** of a false declaration:

- A load balancer health check (3.4): what happens if a server is wrongly removed from rotation? For a few seconds the others take extra traffic, then the server comes back. Cheap, reversible → **a short timeout** is fine.
- A database failover: a false declaration means two primaries, lost writes, hours of reconciliation. Expensive, hard to reverse → **a cautious timeout**, plus agreement between several observers.

Real-world defaults follow exactly this reasoning (they vary by version): Redis Sentinel's example value for `down-after-milliseconds` is 30 seconds, and failover doesn't happen unless several Sentinels agree; Patroni's leader lock has a default `ttl` of 30 seconds; a Kubernetes liveness probe by default runs every 10 seconds and restarts after 3 consecutive failures. Some systems, instead of a fixed timeout, look at the history of heartbeat arrivals and compute a level of suspicion (Cassandra's "phi accrual" failure detector) — but that's still a guess, just a smarter one.

The most important lesson comes from here: **the failure detector will be wrong. So the system's correctness cannot depend on it.** Let the detector decide only "when do we attempt a failover"; design the failover itself so that data isn't damaged even when the detector is wrong. That's the rest of this lesson.

### 1.4 Process Pause — the node didn't die, it just lost time

Most of the false declarations in 1.3's table aren't caused by the network — they're caused by **the process itself stopping**.

**Process pause** — a running process can stop completely for a while at any moment, and when it comes back it doesn't even know it was stopped.

Why it stops:

- **Garbage collection** — many runtimes stop the whole program while cleaning up memory ("stop-the-world"). On a large heap this can be seconds.
- **A blocked event loop** — in Node.js this is even easier: one huge `JSON.parse`, one synchronous `crypto` call, one heavy loop — for the whole duration no other callback runs, no timer fires. Thursday's incident is exactly this.
- **VMs and containers** — the hypervisor is giving the CPU to another VM (steal time), the VM is being moved to another host (live migration), the container's CPU quota ran out (throttling).
- **Memory swapping, slow disks** — a memory page has to come back from disk, or the process is stuck writing a log to disk.
- Closing a laptop lid, `SIGSTOP`, a debugger breakpoint.

To the paused process, time didn't stop — time **jumped**. It executed one line, then the next — 3 seconds passed in between, but to it that was zero. And during those 3 seconds the rest of the world assumed it was dead and moved on.

That's exactly what the exercise builds. Two real Node processes, A and B, take a **lease** from a lock service to become the reminder job's leader (details in 1.6; for now: a lock with an expiry, 1 second, renewed at the halfway point). On every tick the leader does four things: check the lease → read the cursor from storage (which batch is next) → send that batch's reminder emails → write cursor + 1.

A becomes leader, and on batch 3, right after reading the cursor, it freezes for 2.5 seconds (a synchronous busy loop — an exact imitation of a blocked event loop). `npm run split-brain`:

```
     703 ms  A      read cursor = 3 … then the process froze (2500 ms, stop-the-world)
    1793 ms  lock   lease → B (token 2)
    1796 ms  email  B sent batch 3
    1798 ms  store  cursor 3 → 4  (B, token 2)
      …              (B sends batches 4 to 9)
    3025 ms  store  cursor 9 → 10  (B, token 2)
    3203 ms  A      running again — it looks to me like nothing happened, sending batch 3
    3204 ms  email  A sent batch 3   ← again! duplicate
    3206 ms  store  cursor 10 → 4  (A, token 1)   ← went backwards!
    3228 ms  email  B sent batch 4   ← again! duplicate
      …              (B faithfully sends 5, 6, 7, 8 again)
    3408 ms  A      lease renewal failed — someone else is leader, I'm a follower

   reminder batches sent: 16 times, 10 distinct batches
   sent more than once: 6 batches  (3: B+A, 4: B+B, 5: B+B, 6: B+B, 7: B+B, 8: B+B)
```

Read it slowly, because the whole lesson is here:

1. **A's code isn't wrong.** It checked the lease, and at the moment of checking the lease really was valid. The mistake is **between** checking and using — that's exactly where the pause landed.
2. **The lock service isn't wrong either.** A's lease expired, B asked, B got it — by the rules.
3. At the 3.2-second mark, two processes think they are leader, and both are acting. That's split brain (1.6).
4. And look at the size of the damage: **one** stale write by A (cursor 10 → 4) — and as a result **six** batches went out twice. The damage from a stale write often doesn't stop at that one write; it spreads to everything after it.

"So just check the lease again right before sending the email?" — in this case that would have saved it. But a pause can land between **any** two lines — even right after the new check. However many times you check, there is always a gap between checking and acting. (You'll see this yourself in the exercise's experiment 4.)

### 1.5 Network Partitions — again, this time from the inside

In Lesson 5.9 you saw the definition of a network partition and the CAP choice: when the link is cut, neither side knows whether the other is dead or just cut off. Today, add two things.

**First, a partition isn't always a clean split into two.** The shape of Tuesday's incident:

```
                   ┌──────────────┐
                   │   Monitor    │
                   └──────┬───────┘
                          ╳  ← this link is cut
     ┌─────────────┐      │       ┌──────────────┐
     │ app 1, 2, 3 │──────┼──────►│   PRIMARY    │   to apps 1–3: the primary is fine
     └─────────────┘      │       └──────────────┘
                          ▼
     ┌─────────────┐  ┌──────────────┐
     │ app 4, 5, 6 │─►│   REPLICA    │   to the monitor: the primary is dead → promote the replica
     └─────────────┘  └──────────────┘
```

The monitor can't see the primary, but some apps can. This is called a **partial** (or asymmetric) partition — who can see whom depends on where you're standing. From the monitor's point of view its decision was completely correct. The problem is that its view isn't the whole picture.

There's another shape too, perhaps the hardest of all: **gray failure** — the node hasn't died and there's no partition, it's just impossibly slow or fails intermittently (a disk about to die, a network card dropping half its packets). The health check passes, but real requests time out.

**Second, these aren't rare.** Peter Bailis and Kyle Kingsbury's "The Network is Reliable" (ACM Queue, 2014) collected many real partition incidents at large companies in one place — the title is ironic. And one famous example: **GitHub, October 2018.** Connectivity between a US East Coast network hub and the primary data center was lost for 43 seconds. Their automatic failover tool moved the MySQL primaries to the West Coast. When connectivity came back, both sides had writes the other didn't. The result of a 43-second partition was about 24 hours of degraded service while the data was reconciled. (Their post-incident report is worth reading — it's Tuesday's story, at huge scale.)

### 1.6 Split Brain — and four defences

**Split brain** — more than one node thinks it is the leader (or primary) at the same time, and both are doing work that only one should do.

The two incidents arrived here by two different paths:

- **Tuesday:** the failure detector was wrong (a partial partition) → a new primary was created → the old one is alive and doesn't know it's been replaced.
- **Thursday:** the leader paused → its lease expired → a new leader → the old one woke up and doesn't know it's no longer leader.

The root of both is the same: **the old leader doesn't know it's old.** Nobody can tell it — because it's either cut off or paused. So every defence answers one question: "When the old leader tries to act by mistake, who stops it?"

**Defence 1 — decide by majority.** The decision to create a new leader isn't made by one monitor alone — only when a **majority** of nodes (more than half) agree. Lesson 5.9's reasoning: two majorities always overlap in at least one node, so two sides of a partition can't both have a majority at the same time — **two new leaders being elected on the two sides** is impossible.

That's why clusters usually have an **odd** number of nodes — 3 or 5. In a two-node cluster, a partition leaves 1 node on each side and nobody has a majority — either both stop (availability gone) or both proceed (split brain). So automatic failover is unsafe with a two-server setup; you need a third "witness" node that only votes. (Tuesday's problem was rooted in exactly this: one monitor, alone, making the decision.)

But notice what majority does **not** prevent: the old leader's own actions on Thursday. Majority makes choosing the new leader correct; but the old leader was paused, it never heard about the vote — when it wakes up, it acts on its old belief.

**Defence 2 — Lease.**

**Lease** — a lock with an expiry: the holder gets the right for a fixed time, and if it doesn't renew regularly the right ends on its own.

A lease handles crashes nicely — if the holder dies, nobody has to do anything; once it expires, someone else can take it (with an ordinary lock, a dead holder would keep it locked forever). And from the holder's side the rule is: "when the lease expires by my clock, stop working."

But the exercise broke exactly this. To obey the lease the holder must **notice** its expiry — and a paused process notices nothing. The safety of a lease depends on an assumption: pauses and clock errors are much shorter than the lease duration. 1.4 showed that assumption breaks.

(What about a longer lease? The exercise's experiment 2 — `LEASE_MS=5000`: zero duplicates, but for the whole time A was paused **nobody** sent reminders; total batches dropped from 16 to 8. A lease duration is really 1.3's timeout — the same trade-off under another name.)

**Defence 3 — Fencing Token.** This is the real solution, and the idea is simple: give the job of stopping the old leader to **the resource it is writing to**.

**Fencing token** — a number that always increases, handed out every time someone new gets a lease; the resource checks the token with every write and rejects any write whose token is smaller than the largest it has seen so far.

```
  lock service      A (token 1)               B (token 2)          storage (largest token seen)
  ────────────      ───────────               ───────────          ────────────────────────────
  lease → A, 1
                    write (token 1) ────────────────────────────►  1 ≥ 1 ✓  largest = 1
                    ░░ paused ░░
  expired
  lease → B, 2                                write (token 2) ───►  2 ≥ 1 ✓  largest = 2
                    ░░ woke up ░░
                    write (token 1) ────────────────────────────►  1 < 2 ✗  rejected!
```

`npm run fenced` — the same story, but this time the storage checks the token:

```
    3201 ms  A      running again — it looks to me like nothing happened, sending batch 3
    3202 ms  email  A sent batch 3   ← again! duplicate
    3203 ms  store  ✗ A's write rejected: token 1 < 2
    3204 ms  A      storage rejected my write: my token 1 < 2 — I'm no longer leader, stopping

   sent more than once: 1 batch  (3: B+A)
   writes rejected by storage: 1
```

The cursor is intact, B's work is safe, and there's a bonus: from the rejection A **found out** that it's old, and stopped on its own. Fencing doesn't depend on any timeout, any clock, or the length of any pause — just comparing numbers.

In TaskFlow this is easy to build with Postgres — it's Lesson 5.5's conditional atomic update:

```typescript
// write only if the token hasn't gone down — in one statement, so no race even if two arrive together
const [affected] = await ReminderCursor.update(
	{ value: cursor + 1, fenceToken: token },
	{ where: { id: 1, fenceToken: { [Op.lte]: token } } }
);
if (affected === 0) {
	// someone new has written with a bigger token — I'm no longer leader
	throw new Error(`stale leader: token ${token} rejected`);
}
```

There's one condition: the source of the token must be reliable — the service that hands out the lease also hands out the token, and it must not have a split brain of its own. That's why in practice this job uses a consensus-based store like etcd, ZooKeeper or Consul (etcd's revision and ZooKeeper's zxid are exactly this kind of always-increasing number). Why those don't have split brains of their own — that's the next lesson's Raft.

**Defence 4 — Idempotency, where fencing can't reach.** Look again at the fenced run's output: batch 3 **still** went out twice. Because the email provider doesn't look at tokens — and in real life it won't; you can't teach SendGrid your fencing token.

Fencing protects only the resource that checks the token. For every other side effect — email, payments, another company's API — use Lesson 2.5's idempotency: a stable key for each piece of work (here, the batch number), and the receiver doesn't do the work again if the same key arrives a second time. Stripe's `Idempotency-Key` header is exactly this. For your own email sending: a `sent_reminders` table with a unique constraint on `(taskId, dueDate)`, and send only if the insert succeeds.

**And the last resort — kill the old one by force.** Some systems (especially database failover) make sure the old primary is stopped: cut its power or disconnect it from storage. Its old name is STONITH ("shoot the other node in the head"). Tools like Patroni use a watchdog — if the primary can't talk to the consensus store, it demotes itself or the machine is reset. Effective, but it depends on the "kill" order getting through — which it doesn't during a partition.

**A famous debate:** in 2016 Martin Kleppmann (author of "Designing Data-Intensive Applications") wrote that Redis's distributed lock algorithm (Redlock) is unsafe for exactly this exercise's reasons — process pauses and reliance on clocks — unless there's a fencing token. Redis's creator Salvatore Sanfilippo (antirez) replied, disagreeing. Both pieces are worth reading, and the debate was never fully settled. But one distinction of Kleppmann's is accepted by everyone, and it's worth remembering:

- **Efficiency lock** — if the lock breaks, a bit of extra work gets done (the same report built twice). Annoying, not harmful. Redis `SET NX PX` is enough.
- **Correctness lock** — if the lock breaks, data is damaged or money is charged twice. Here a lock isn't enough — you need a fencing token and idempotency.

Which kind is TaskFlow's reminder? A duplicate email now and then is annoying, but the cursor going backwards and six batches being resent — and, for an invoice job, charging twice — that's correctness.

> **Trade-off Table — Defences against split brain**

| Defence                       | What it prevents                                                         | What it does not prevent                                            | Cost                                                        |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Majority (votes of 3/5 nodes) | Two new leaders being elected on two sides at once                       | The old leader's own actions (it doesn't know about the vote)       | Odd number of nodes; the minority side stops                |
| Lease (lock with expiry)      | A crashed holder's lock staying locked forever                           | A holder whose lease expired during a pause or clock error acting   | Expiry = timeout; short → needless changes, long → slow     |
| Fencing token                 | The old leader's writes to a resource that checks the token              | Side effects that don't see tokens (email, external APIs)           | Conditional writes at the resource; a reliable token source |
| Idempotency key               | The **result** of the same work happening twice (duplicate email/charge) | Different work (the cursor going backwards) — unless the keys match | Dedupe at every receiver (a table, a header)                |
| Forcibly stopping the old one | Any further writes by the old primary                                    | When the stop order itself is stuck in the partition                | Hardware/infra support; get it wrong and both are dead      |

In practice these are used together: majority to choose the leader, a lease to handle crashes, fencing to protect storage, idempotency for the remaining side effects.

---

## 2. Interview Angle

**"Your service has 10 instances, but a cron job must run only once — how?"** — A very common question, and right after the usual answer "a Redis lock with a TTL" comes the real one: "what if the lock holder gets stuck in a GC pause?" A good answer, in order: lease (TTL) → why a lease isn't enough under process pauses → fencing token (a conditional write at the storage) → an idempotency key for external side effects. Bonus: the efficiency vs correctness lock distinction, and "I won't build leader election myself — I'll use etcd/ZooKeeper/a Kubernetes Lease."

**"What timeout would you set for the database primary's health check?"** — Before giving a number, state the trade-off: a short timeout = needless failovers (and every failover risks split brain), a long timeout = more RTO. Then: "I'd choose based on the cost of a false declaration — aggressive for an LB health check, cautious for a DB failover with agreement from a majority. And I'd design failover so that data isn't damaged even when the detector is wrong." That last sentence is what sets a senior answer apart.

**"What does your system do during a network partition?"** — Add split brain to 5.9's CAP: "how do I stop the old primary on the minority side" — without a majority it won't take writes (like Patroni: if it loses contact with the consensus store it demotes itself), plus fencing.

**In real production:** nobody writes their own leader election or distributed lock — it's etcd, ZooKeeper, Consul, a Kubernetes Lease object, or the database's own failover tool (Patroni, a managed database). But even when you use those, **fencing and idempotency are your app's responsibility** — no lock service will check tokens in your storage for you, or teach your email provider to dedupe.

---

## 3. Key Takeaway

- The core difficulty of distributed systems is **partial failure**: some parts break, the rest run, and when no answer comes you can't know what happened — a timeout doesn't mean "failed", it means "I don't know"
- Decide the **failure model** up front: ordinary backends assume crash-recovery nodes (that don't lie), an asynchronous network (no bound on delay), and untrustworthy clocks
- A **failure detector** (heartbeat + timeout) is a guess — a short timeout gives needless failovers, a long one slow recovery; in the exercise, with a 1 s timeout a healthy primary was "dead" 53 times a day. Choose timeouts by the cost of a false declaration, and don't let correctness depend on the detector
- In a **process pause** (GC, a blocked event loop, a VM) the node doesn't die, it just loses time — and in the gap between checking and using, the old leader does the wrong thing with correct code
- The root of **split brain**: the old leader doesn't know it's old; it arrives by two paths — partial partitions and pauses
- Majority keeps the choice of new leader correct (hence 3/5 nodes), a lease handles crashes — but neither stops a paused old leader
- **Fencing token** — the resource itself rejects writes with an old token; and where the token can't reach (email, payments), an **idempotency key**

---

## 4. New Terms (Glossary)

| Term                 | Meaning                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Partial Failure**  | Some parts of the system have failed while the rest keep running, and often you can't know for sure which part failed                       |
| **Failure Model**    | The list of failure kinds (crash-stop, crash-recovery, Byzantine; network, clocks) a system is designed to handle                           |
| **Failure Detector** | The mechanism that decides whether a node is dead — usually a heartbeat and a timeout; always a guess                                       |
| **Process Pause**    | A running process suddenly stopping completely for a while (GC, a blocked event loop, a VM) — when it comes back it doesn't know it stopped |
| **Split Brain**      | More than one node thinks it's the leader/primary at the same time and does work only one should do                                         |
| **Lease**            | A lock with an expiry — the right for a fixed time, which ends on its own unless renewed                                                    |
| **Fencing Token**    | A number that increases with every new lease; the resource rejects writes with an older (smaller) token                                     |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. A small company has two Postgres servers: a primary and a replica. A script runs on the replica: "if the primary doesn't answer pings for 10 seconds, promote yourself." What can go wrong in this setup — name at least two different situations. What would you change?
2. TaskFlow's billing job runs on the 1st of every month: it takes the next invoice number, writes the invoice to the database, then charges the card with Stripe. A Redis lock with a 30-second TTL keeps it to one instance. One day the leader instance got stuck in a 40-second pause. What could go wrong? What defence does each side effect (invoice number, invoice row, Stripe charge) need?
3. Looking at 1.3's table, a manager says: "53 false failovers at 1 second? Then set every timeout to 30 seconds and the problem's solved." How do you reply? Which timeouts should stay short, which should be long — and besides a long timeout, what else is needed?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Several problems:

- **Partition:** the primary is alive, only the link between the replica and the primary is cut. The replica promotes itself while apps are still writing to the primary → split brain (Tuesday's incident). There's no safe solution in a two-node setup — neither side can tell "dead" from "cut off", and there's no third party to form a majority.
- **Process pause:** the primary is in a 12-second pause (or under heavy load) → the replica is promoted → the primary wakes up and still takes writes as primary.
- **Async lag:** whatever the replica hadn't received at the moment of promotion is lost (5.7's RPO).
- **Nobody stops the old one:** the script only says "promote yourself"; there's no "stop the old one", and no moving the apps to the new address.

What to change: add a third node (a witness) and decide by majority — in practice Patroni + etcd (3 nodes), where to be leader you must hold a lease in the consensus store, and a primary that loses its lease demotes itself (with a watchdog). App connections go through one place (a proxy or DNS that Patroni updates). The 10-second number should be checked too — with 1.3's table in mind.

**Question 2:** A 40-second pause, a 30-second TTL — the lock expires in the middle of the pause, another instance becomes leader and starts billing. The old leader wakes up and finishes its half-done work. Result: the same invoice number twice (or gaps/reversals in the sequence), two invoice rows for the same customer, and worst of all — **the card charged twice**. Defences, per side effect:

- **Invoice number:** don't let the lock holder assign it — let the database do it (a sequence), or put a fencing-token condition on writing the number (`WHERE fence_token <= $token`).
- **Invoice row:** a unique constraint on `(customerId, billingMonth)` — the database itself rejects a second invoice for the same month. This is idempotency in the database's language.
- **Stripe charge:** Stripe doesn't see tokens — so `Idempotency-Key: invoice-{customerId}-{month}`. Even if two leaders ask to charge with the same key, Stripe charges only once.

The lesson: here the lock is fine as an "efficiency lock" (it's better that two don't work at once), but correctness comes from the unique constraint, fencing and the idempotency key — not from the lock.

**Question 3:** Setting every timeout to 30 seconds reduces false failovers, but for every real failure nobody notices for 30+ seconds — the load balancer sends traffic to a dead server for 30 seconds (thousands of failed requests), and when the database dies there are no writes for 30 seconds. The answer: **choose timeouts by the cost of a false declaration.**

- **Keep short:** the load balancer's health check (3.4) — a wrong removal is cheap and reversible; a client's request timeout + retry (if idempotent).
- **Long/cautious:** database failover, leader election — a false declaration is expensive and hard to reverse.
- **Alongside a long timeout:** fail over only when a majority of several observers agree (not one monitor alone); and make failover itself safe — fencing, self-demotion of the old primary — so data isn't damaged even when the detector is wrong. Then the timeout is no longer a "safety" number, just a "how soon do we try" number — and it can be kept relatively short.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (a seeded simulation + two real Node processes)

> **Ready to run in the repo:** [`exercises/lesson-6.1-split-brain/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.1-split-brain) — `npm install`, then `npm run detector`, `npm run split-brain`, `npm run fenced`. No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`detector` is a seeded simulation — exactly the same numbers every time. In `split-brain` and `fenced`, three small services (lock, storage, email provider) run in one Express process, and A and B are separate Node processes — so A's pause is real: its event loop is blocked while the rest keep running.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; several runs of `detector` gave identical output; `split-brain` and `fenced` were each run three times with the same sequence of events and the same final result (the milliseconds differ slightly each time — real timers). README experiments 1 and 2 were also run; 3 and 4 are yours, since they involve changing the code. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. Run all three scripts. From the `split-brain` output, write one line: which line of A's code is "wrong"? (The answer will sound like a question — that's right.)

2. **Choosing timeouts:** from `detector`'s table choose two timeouts — (a) for Nginx's health check, (b) for TaskFlow's Postgres failover. One line of reasoning for each: what a false declaration costs, and what noticing late costs.

3. **Lease expiry = timeout** (experiment 2): compare the total batch count of `LEASE_MS=5000 npm run split-brain` with the default. Why are there zero duplicates, and what did you lose? Now think — if A had really crashed, how long would reminders have stopped with a 5-second lease?

4. **Where fencing can't reach** (experiment 3): make `/email` idempotent by batch number, then `npm run fenced`. Did duplicates go to zero? Now run `split-brain` (no fencing) too — was idempotent email alone enough? What happened to the cursor?

5. **Design part:** write a plan for TaskFlow in two parts. (a) The reminder job: how the leader is chosen (which tool), the lease duration, how the cursor is fenced (which table, which condition), how duplicate emails are prevented. (b) Postgres failover: how many nodes vote on the decision, the timeout (with a number), how the old primary is stopped, and how apps find the new primary. Show exactly where each of the two incidents, Tuesday's and Thursday's, is stopped by your plan.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (complete, including exit challenges)
Current: 6.1 — Failure Models, Network Partitions, Split Brain
TaskFlow state: Nginx + Express instances, CDN, Redis cache; PostgreSQL primary +
read replica, automatic failover (now: planned majority vote + self-demotion of the old primary);
reminder job on one leader — lease + fenced cursor (conditional update) + idempotency key on email
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token
Weak spots: [where you got stuck — fill this in yourself]
Next: 6.2 — Consensus: leader election, Raft basics
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially the reasoning for your two timeouts in #2 and your plan in #5. When you are ready, write `next` — Lesson 6.2: **Consensus — Leader Election and Raft basics.** Today we kept saying "decide by majority", "a reliable store hands out the tokens" — but that store itself runs on several nodes, and it gets partitioned too, it pauses too. So how does it avoid split brain? How do several nodes agree on a decision that will never change — even when messages are lost and nodes die? Raft's terms, votes and log give the answer.
