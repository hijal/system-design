# Module 6 — Exit Challenge (Distributed Systems Core)

**Module 6 — Distributed Systems Core**

Module 6's five lessons are done — what breaks and why "is the other one dead?" can't be known, consensus and Raft, session guarantees when reading from replicas, clocks and logical clocks, and the ladder of consistency models. Each lesson looked at one problem on its own — and measured it in the exercise. In real life these don't arrive separately: one network glitch touches failover, locks and the data users see, all at once. This Exit Challenge is that kind of month.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow has had a bad month. You've been handed the whole month's incidents for an incident review. TaskFlow's current state:
>
> - PostgreSQL primary + 3 async read replicas, failover via **Patroni**. Patroni's leader lock is in **etcd** — etcd has 3 nodes: 2 in AZ-a, 1 in AZ-b. The Postgres primary is currently in AZ-b.
> - Apps find the primary through a DNS name (`db-primary.internal`), TTL 60 seconds; Patroni updates the DNS after a failover.
> - The monthly **invoice job**: on the 1st of every month one instance runs it — takes the invoice number, writes to the `invoices` table, charges with Stripe. A **Redis lock** keeps it to one instance: `SET invoice-lock <id> NX PX 30000`, renewed every 10 seconds. If the lock is lost, the job stops — it checks "do I still have the lock" with a `GET` before every customer.
> - Read path: 6.3's version token — but the token is kept in a **cookie**.
> - Multi-region pilot (Dhaka, Singapore, Frankfurt): task titles and descriptions can be written in all three regions; conflicts use **last-write-wins**, by the timestamp of the region server's clock.
> - Notification unread count: a leaderless quorum store, `N = 3, W = 2, R = 2`, read repair off.
>
> **The month's incidents:**
>
> 1. **The 3rd:** AZ-a was cut off entirely for 20 minutes (a power problem). The Postgres primary was in AZ-b and **healthy** — yet for the whole 20 minutes nothing was written to TaskFlow. Patroni's log: `failed to update leader lock` then `demoting self because DCS is not accessible`.
> 2. **The 1st, the invoice job:** 37 customers' cards were charged **twice**, and they have two invoices each (with different numbers). In the leader instance's log, just before those 37: a 45-second GC pause while building a large PDF. The second instance's log: "lock acquired" — in the middle of the pause.
> 3. **The 12th:** because of a network switch problem Patroni couldn't consider the primary healthy, and promoted a replica. For 40 seconds some app instances kept writing to the old primary. Later, 180 tasks were found only on the old primary.
> 4. After the 12th, an engineer "reduced RTO" by changing Patroni's `ttl` from 30 to 5 seconds. Last week there were 11 failovers — not one of them a hardware problem.
> 5. **Support tickets:** "I created a task on my phone, opened my laptop, and it isn't there" — and another kind: "I hit refresh and a comment I'd just seen vanished." The second started on exactly the day a fourth replica was being trialled.
> 6. **Multi-region pilot:** users in Singapore say description edits "save, then the old one comes back." The Singapore server's clock was found to be 2 seconds behind. Even after the clock was fixed, now and then when two people edit at once, one person's edit is silently lost. And sorting the three regions' logs by timestamp puts "notification sent" before "comment created".
> 7. Unread count: "5, then 4, then 5 again."
> 8. Meanwhile a vendor's sales team came and said: "Move to our database — strongly consistent, globally distributed, always available, and 1 ms reads in every region." The CTO wants to know whether this solves everything.

Your task — for each question below, apply Module 6's concepts (and earlier modules' where relevant) to make a decision, with your reasoning. Wherever possible, give **numbers**.

**1. A healthy primary, and still no writes (Lesson 6.2 + 6.1)**
The Postgres primary was healthy — so why did Patroni demote it? Is this a Patroni bug, or deliberate? If it hadn't done this, what danger could there have been (which 6.1 incident)? What's wrong with where the 3 etcd nodes are placed — if AZ-a goes, how many nodes are left, and what's the majority? Your fix: how many nodes, where, and what if TaskFlow really only has two AZs?

**2. Charged twice (Lesson 6.1 + 6.4 + 2.5)**
Draw the incident on a timeline — the 45-second pause, the 30-second lock, the second instance. Why didn't "check the lock before every customer" save it? Give a separate defence for each of the three side effects (invoice number, invoice row, Stripe charge) — which fencing, which constraint, which idempotency key. Does switching the Redis lock to an etcd lease make the problem go away? And which clock should the lock-renewal timer run on?

**3. 40 seconds on the old primary (Lesson 6.1 + 5.7)**
What kind of partition is this, and exactly how did the split brain happen — explain it with Patroni, the DNS TTL and the app's connection pool together. Who could have stopped the old primary, and why didn't they? Give at least three changes so this doesn't happen again (one on the Postgres/Patroni side, one on the app's connection side, one on the data side). And what do you do now with the 180 tasks?

**4. 11 needless failovers (Lesson 6.1 + 6.2)**
Why so many failovers with a 5-second `ttl` — reason with 6.1's detector table. What does each needless failover cost (RPO, split-brain risk, a connection storm)? What's the **right** way to reduce RTO — besides the timeout, where else does the time go (detect → promote → move the apps)?

**5. Two kinds of ticket (Lesson 6.3)**
Name each (which session guarantee), and say why it's happening — the cookie's role in the first, the fourth replica's role in the second (how reads choose a replica — guess which strategy, if enabled, would cause this). Give one fix that stops both, and estimate how much it increases the load on the primary (using 6.3's exercise numbers). Where will you keep the token, and with what TTL?

**6. The multi-region pilot's three problems (Lesson 6.4)**
Three separate problems: (a) edits reverting because a clock is behind, (b) concurrent edits being lost even after the clock is fixed, (c) the log order being reversed. Give each one's cause separately, and each one's fix. Which goes away by fixing the clock, which doesn't, and why? Should the title and the description have the same conflict rule?

**7. 5, 4, 5 (Lesson 6.3)**
Why, even though `R + W > N`? What kind of write creates this state? Compare two fixes, and say what the client of a "failed" write should do.

**8. The vendor's claim (Lesson 6.5 + 5.9)**
Of the claim's four parts, which are impossible together, and why (with CAP and PACELC, and a rough number for the Dhaka–Frankfurt round trip)? Which four questions would you ask the vendor? And of this month's eight incidents, which would still happen even with a new database — because they're outside the database?

**9. The design doc and priorities (Lesson 6.1–6.5)**
(a) The "consistency" section of TaskFlow's design doc — for at least six pieces of data (leader lock, invoices/billing, task list, comments, multi-region title/description, unread count): the model's name, how it's achieved, and the worst the user can see.
(b) A **priority list**: what this week (before it happens again), what this month, what this quarter — beside each, which lesson, and how you'll measure success.

**Things to remember:** in this module there are three places where it's easiest to go wrong — (a) **treating a timeout as the truth** ("no answer for 30 seconds means dead", "the lock hasn't expired so I'm the owner"); (b) **deciding order with clocks**; (c) **stating consistency in one word** ("strong", "eventual") — instead of per piece of data. All three are hiding in today's scenario. And Module 6's most important habit: for every solution ask — **"if the failure detector is wrong, or the process pauses, is this still correct?"** If not, the correctness is coming from luck.

I'll critique this step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

- [ ] I can say what partial failure is, and which six possibilities exist when a request gets no answer; a timeout doesn't mean "failed", it means "I don't know"
- [ ] I can make a design's assumptions explicit with a failure model (crash-stop, crash-recovery, Byzantine; an asynchronous network; untrustworthy clocks)
- [ ] I can state the failure-detector timeout trade-off (false declarations vs time to notice) with numbers, and I choose timeouts by the **cost** of a false declaration
- [ ] I know where process pauses come from (GC, a blocked event loop, VMs), and why "check, then act" breaks under a pause — I've seen it with my own eyes
- [ ] I recognise the two paths to split brain (a wrong failure detection, a lease expiring during a pause); I can say what majority, leases, fencing tokens and idempotency each prevent and don't prevent
- [ ] I know the difference between an efficiency lock and a correctness lock; for correctness I can put conditional writes (fencing) on the resource and idempotency keys on external side effects
- [ ] I can say what consensus is, which problems are consensus in disguise, and why FLP makes Raft "safety always, liveness through timeouts"
- [ ] I can draw Raft's terms, elections (one vote per term, majority, random timeouts), log replication and commit, and the election restriction on a whiteboard
- [ ] I know why an old leader on the minority side of a partition can't commit, but why its local reads can be stale; I can state the idea of ReadIndex
- [ ] I can decide a consensus cluster's node count (3/5, not even) and placement (three failure domains); I know which data consensus is for and which it isn't
- [ ] I recognise the three session guarantees (read-your-writes, monotonic reads, consistent prefix), and I've measured what sticky replicas, cookies and version tokens each fix
- [ ] I know where to keep a version token so it works across multiple devices; for consistent prefix I keep causally related data in one partition
- [ ] I know why `R + W > N` breaks on failed writes; I can say what read repair, hinted handoff/sloppy quorums and anti-entropy repair
- [ ] I know the difference between wall clocks and monotonic clocks — timeouts/leases always monotonic; I can give examples of drift, skew, NTP jumps and leap seconds
- [ ] I can separate LWW's two kinds of damage (the clock's error losing a later write; concurrent writes silently lost), and I know which one fixing the clock doesn't remove
- [ ] I can think in happens-before; I can compute Lamport and vector clocks by hand, and I know which one recognises concurrency; I understand siblings and the cost of merging
- [ ] I can arrange the ladder of consistency models (strict serializable → linearizable → sequential → causal → session → eventual), and say from a small history which it satisfies
- [ ] I can explain the difference between serializable and linearizable; and I can write consistency models per piece of data in a design doc — including what users see through caches/replicas

---

## 3. Recommendation

**To read:**

- **Martin Kleppmann — _Designing Data-Intensive Applications_.** I mentioned this book in Module 5's recommendations; this time the other two most important parts: chapter 8 of the first edition ("The Trouble with Distributed Systems" — the full version of 6.1 and 6.4: pauses, clocks, and the fencing-token example became famous from here) and chapter 9 ("Consistency and Consensus" — 6.2, 6.5). Chapter numbers may have changed in the new edition — search by name.
- **Diego Ongaro and John Ousterhout — "In Search of an Understandable Consensus Algorithm" (the Raft paper, 2014).** Unusually readable for a paper. Figure 2 is the whole algorithm on one page — match it line by line with 6.2's exercise `raft.ts`. Plus raft.github.io — which has an interactive visualisation where you can kill nodes and block messages.
- **Martin Kleppmann — "How to do distributed locking" (blog post, 2016), and antirez's reply "Is Redlock safe?".** 6.1's Redlock debate, the original pieces from both sides. The background to question 2 of this exit challenge.
- **Leslie Lamport — "Time, Clocks, and the Ordering of Events in a Distributed System" (1978).** The source of 6.4. Short, and astonishingly clear — one of the most cited papers in computer science.
- **Jepsen's "Consistency Models" page (jepsen.io).** A big, full map of 6.5's ladder — each model's definition and which is stronger than which, along with analyses of many databases.

**To watch:**

- **Martin Kleppmann's Cambridge University "Distributed Systems" lecture series (YouTube).** Short videos, exactly this module's topics — failure models, clocks, logical time, replication, quorums, consensus — from the book's author.
- **MIT's Distributed Systems course (6.824, now 6.5840) lectures (YouTube).** Robert Morris's lectures — paper by paper through Raft, ZooKeeper, Spanner. A bit deeper, but worth following after 6.2.

**For a project:**

- **MIT 6.5840's Raft lab** (public on the course website) — implementing the whole of Raft in Go, against a strict test suite (cut networks, lost messages, restarts). It starts where 6.2's exercise stopped (persistence, many details). Hard, but one of the best ways to learn distributed systems.
- **TaskFlow's reminder job, with real etcd:** a 3-node etcd in Docker, lease-based leader election with a Node etcd client, and the lease's revision as a fencing token in Postgres's cursor table (6.1's conditional update). Then, like 6.1's exercise, pause a process with `SIGSTOP` — does fencing stop the stale write?
- **Your own Jepsen:** on Lesson 5.7's Postgres primary + replica cluster, read and write with several clients (some reads from the replica), record every operation's start, finish and result, and check them with 6.5's `checker.ts`. Then add 6.3's version token and do it again — which models' percentages change? What if you delay the replica midway with `recovery_min_apply_delay`?

---

Do the exit challenge and send it over. When you are ready, write `next` and we'll move to **Module 7: Asynchronous Processing & Messaging** — starting with Lesson 7.1: why a system dies if everything is synchronous.

Across Module 6 one question kept coming back: "after the timeout, did the work happen?" — the Stripe charge, the invoice, the quorum's "failed" write, Raft's uncommitted entry. The answer was the same every time: we don't know, so retry — and to make the retry safe, idempotency. In Module 7 this question is at the centre: when work leaves the request, sits in a queue, and later lands in some worker's hands — what "exactly once" means, and whether it's actually possible.
