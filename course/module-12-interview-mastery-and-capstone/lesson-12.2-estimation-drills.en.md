# Lesson 12.2 — Estimation Drill: 10 Rapid-Fire

**Module 12 — Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 1.5):** A service's availability is 99.9%. In a 30-day month, how many minutes at most can it be down? No paper, thirty seconds. One of today's ten drills stands on this number.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.5 (Availability), Lesson 12.1 (the ten mistakes, especially 2 and 3)

**By the end of this lesson you will be able to:**

1. Do any estimation question of six shapes — rate, volume, bandwidth, fleet, concurrency and probability — on paper as a **chain** in under two minutes, with a unit next to every number
2. Say with numbers where rounding in your head is safe and where it isn't: rounding moves the answer by a few tens of percent, a wrong step moves it by a few times to a thousand times
3. Say a "so" at the end of every number: which decision the number changes, which tool it brings in or rules out

**Tier:** 1 — Runnable Code (an interactive drill that times you and checks your answers, and a script that measures the effect of rounding and of wrong steps; no Docker needed)

---

## 0. Where TaskFlow Is Right Now

TaskFlow's quarterly planning meeting. News from sales: a big company wants TaskFlow, 200,000 users, all in one country, all working the same office hours. The product manager looked around the table and asked: "Do we need a new database? I want to know before we sign the contract."

One engineer said: "I'll look into it." Three days later a six-page document arrived, with Grafana screenshots. The answer: no.

But during the meeting another, senior engineer had written this on the corner of a sheet of paper, in ninety seconds:

```
200,000 users, assume half are active daily          → 100,000
each ~6 writes a day (create task, move, comment)     → 600,000 writes/day
but everyone in the 8 office hours: 8 × 3,600 ≈ 3 × 10⁴ s
6 × 10⁵ / 3 × 10⁴                                      → ~20 writes/s
within the office day there's a 10 am rush, × 2        → ~40 writes/s peak
reads 10×                                              → ~400 reads/s
so: this is nothing for the current primary and replicas. No new database.
    the real question is different: one tenant's 10 am rush must not slow everyone else (11.2's hot tenant).
```

Both answers are the same. The difference is time: three days versus ninety seconds. And the second answer gave one more thing the first didn't: the real risk isn't the database's size, it's one big tenant's rush.

There's a subtle step here that many people skip: the senior didn't divide by 24 hours, but by 8. Dividing by 24 hours gives ~7 writes/s, a third of the real load. In this lesson's language that's a question of the **active window**, and it isn't a rounding error, it's a step error.

Two of 12.1's ten mistakes (2: numbers without a "so", 3: designing with averages) are mistakes with numbers. And the estimation step in an interview gets five minutes. The medicine for these two mistakes isn't new knowledge, it's **speed and habit.** In Module 11 a script did every calculation. Today, ten small questions, two minutes each, only your head and paper. There will be a script, but it runs **after** your calculation, to check it.

---

## 1. Theory

### 1.1 Why fast, not exact

The goal of estimation isn't a correct number. The goal is the right **magnitude** (order of magnitude, 1.3), so a decision can be made. 70,000 or 60,000 reads a second doesn't change the design: neither can be served by one database directly, a cache is needed. But 700 or 70,000 a second changes the whole design.

So there is no reward for exact math in an interview, only a cost: time. In 12.1's time box estimation gets five minutes, and in that time you usually need three or four numbers. That means under two minutes for each.

**The spaced repetition answer:** 99.9% means 0.1% of the time may be down. A 30-day month has 30 × 24 × 60 = 43,200 minutes, and 0.1% of that is **43.2 minutes** (the number from 1.5's nines table). Notice that the calculation starts from a memorised constant: a month has ~43,000 minutes. With five or six such constants in your head, the rest is multiplication and division.

### 1.2 The toolkit: a few constants and a chain

**Constants worth rounding.** Part C of `npm run rounding` measures how much error each rounding brings:

```
constant                                   exact       rounded    off by
seconds in a day                          86,400          10^5     1.16×
seconds in a 30-day month              2,592,000    2.5 × 10^6     1.04×
seconds in a year                     31,536,000      3 × 10^7     1.05×
days in a year                               365           400     1.10×
minutes in a 30-day month                 43,200      4 × 10^4     1.08×
```

The most useful line is the first: **a day ≈ 10⁵ seconds.** Then to go from "X a day" to "per second", just count zeros: 2 billion a day (2 × 10⁹) means 2 × 10⁴ a second, ~20,000. The error is 16%, and always in the same direction: dividing by 10⁵ gives a slightly **lower** answer. Knowing that, nudge it up a little in your head.

**Powers-of-Ten Rounding** — writing every number in the calculation as 1, 2, 3 or 5 times a power of ten (86,400 → 10⁵, 365 → 400, 47,000 → 5 × 10⁴), so multiplication becomes adding exponents and division becomes subtracting them. This is where the speed of mental math comes from.

**Two unit traps.** Bandwidth is usually in **bits** (Mbps, Gbps), storage in **bytes** (MB, GB). There's a factor of 8 between them. And KB → MB → GB → TB → PB, each step is 1,000×. Both are the source of the biggest errors in Part B below.

**Estimation Chain** — writing an estimation as a chain of small steps, each step multiplying or dividing the previous step's result by one number, with a unit written next to every step. Almost every system design estimation has the same shape:

```
 total amount           per second             peak              resource            headroom          so
 (users × actions) ──÷ time──►  (average) ──× peak──►  (top)  ──÷ capacity──►  (servers, ──÷ utilisation──►  (final   ──►  (decision)
  /day                     /s                    /s          per unit)     GB, Gbps)    limit)        number)
```

Every arrow is a step, and every step is a place where an error can happen: dividing by the wrong time (24 hours versus the 8 office hours), forgetting the peak, mixing up units, forgetting headroom. That's why you write the chain on paper: when there's an error, you can find which step.

**Active Window** — the part of the day when traffic actually comes. For an app with users all over the world it's 24 hours. For an office app in one country it's 8-10 hours, and that alone makes the average 2-3× bigger, before you even add the peak factor. This is the place the senior in the TaskFlow story caught.

**Headroom** — the empty space you deliberately leave between the calculated demand and the capacity you build: keeping a server at most 60% busy, keeping a gateway half full. The reasons: if a machine or a zone dies, the others have to take its work, and near 100% the latency queue explodes (11.7's 37 seconds on the hot account).

**Six shapes.** The ten drills are of these six kinds, and so is almost any interview question:

| shape       | question                                             | chain                                               |
| ----------- | ---------------------------------------------------- | --------------------------------------------------- |
| Rate        | how many requests/writes a second?                   | users × actions ÷ active window × peak              |
| Volume      | how much storage a year?                             | daily count × size × days                           |
| Bandwidth   | how many Gbps?                                       | how many at once × each one's bitrate (bits!)       |
| Fleet       | how many servers?                                    | rate × CPU per request ÷ cores ÷ utilisation limit  |
| Concurrency | how many connections at once, how many gateways?     | users × online share ÷ per-machine limit ÷ headroom |
| Probability | what share of requests are slow? downtime per month? | not multiplication, compounding: 1 − (1 − p)ⁿ       |

The last row differs from the others, so remember it separately: if each of n parts has probability p, the chance of "at least one" is **not** n × p, it's 1 − (1 − p)ⁿ. n × p is a good approximation only when n × p is small (roughly below 0.1). When it's large, n × p says too much, and can even exceed 1, which is impossible. You'll see this in drill 8.

### 1.3 The drill rules

- Each drill is **two minutes.** Start a timer, or use the timing in `npm run drill`.
- **Write the chain on paper,** with a unit next to every number. Don't try to hold all of it in your head.
- **Round,** and remember that you rounded (and in which direction).
- **A one-line "so" at the end:** which decision does this number give?
- The answers section below, `npm run answers` and `npm run rounding` come **after the drills are done.** Looking first turns this from a drill into reading.

### 1.4 The ten drills

**Stop here.** Take a sheet of paper, start the timer, and do the ten below. Each one's givens are provided so the answers can be compared; in a real interview you'd state these yourself as stated assumptions (12.1).

1. **Photo app, peak reads:** 50 million daily active users, each views 40 photos a day, peak = 3× the average. **How many photo views a second at peak?**
2. **Photo app, storage:** 25 million uploads a day, 2 MB on average, originals only. **How many PB of storage are added a year?**
3. **Live video, egress:** 2 million viewers at once at peak, 3 Mbps average bitrate. **Peak egress in Tbps?**
4. **API fleet:** 30,000 requests a second at peak, 20 ms of CPU per request, 8 cores per server, no server more than 60% busy. **How many servers?**
5. **Catalog cache:** 10 million products, each 5 KB as JSON in the cache, the hottest 20% cached, × 2 for Redis overhead. **How many GB of cache memory?**
6. **Chat, writes:** 100 million daily active users, each sends 40 messages a day, peak = 3× the average. **How many message writes a second at peak?**
7. **Chat, gateways:** 100 million daily active users, 20% online at peak, one gateway holds 200,000 connections, 50% headroom. **How many gateway servers?**
8. **Fan-out tail:** one request goes to 50 shards at once and waits for all their answers; each shard takes more than 100 ms 1% of the time. **What percentage of requests take more than 100 ms?**
9. **Availability chain:** a request passes through 3 services one after another, each 99.9% available, a 30-day month. **How many minutes of downtime a month?**
10. **Log volume:** 500 service instances, each 50 log lines a second, 500 bytes per line. **How many GB of logs a day?**

<details>
<summary><strong>The answers to the ten drills (open after doing them yourself)</strong></summary>

For each: the exact calculation (from `npm run answers`), one rounded-in-your-head version, and the "so".

**1. Photo app, peak reads — ~69,000 /s.** 50 million × 40 = 2 billion views/day; ÷ 86,400 = 23,148 /s average; × 3 = **69,444**. In your head: 2 × 10⁹ ÷ 10⁵ = 20,000, × 3 = 60,000. **So:** one database won't handle this directly. Photo metadata in a cache, the images from a CDN (4.1, 4.5).

**2. Photo app, storage — ~18 PB/year.** 25 million × 2 MB = 50 TB/day; × 365 = **18.3 PB**. In your head: 50 TB × 400 = 20 PB. **So:** object storage, never the database. Moving old photos to a colder tier is a cost decision (8.1, 10.7).

**3. Live video, egress — 6 Tbps.** 2 million × 3 Mbps = 6 × 10¹² bit/s = **6 Tbps**. The same in your head. **So:** only a CDN can do it. The origin serves the CDN, not the viewers (4.5, 11.6).

**4. API fleet — ~125 servers.** 30,000 × 0.02 s = 600 cores always busy; at the 60% limit ÷ 0.6 = 1,000 cores; ÷ 8 = **125**. **So:** ~125, plus some spares per zone. And the real lever is CPU per request: halving it saves ~60 machines (1.6, 10.7).

**5. Catalog cache — ~20 GB.** 10 million × 0.2 = 2 million items; × 5 KB = 10 GB; × 2 = **20 GB**. **So:** it fits in one Redis node and a replica. No cache cluster or sharding needed (4.4).

**6. Chat, writes — ~139,000 /s.** 100 million × 40 = 4 billion messages/day; ÷ 86,400 = 46,296 /s; × 3 = **138,889**. In your head: 4 × 10⁹ ÷ 10⁵ = 40,000, × 3 = 120,000. **So:** past one primary's limit. Partition by conversation, and an LSM-style store for an append-heavy log (5.3, 5.8, 11.3).

**7. Chat, gateways — ~200.** 100 million × 0.2 = 20 million connections; ÷ 200,000 = 100; ÷ 0.5 = **200**. **So:** 200 gateways means that to send a message you need to know which gateway the receiver is on: a session registry (11.3).

**8. Fan-out tail — ~39.5%.** The chance that every shard is fast is 0.99⁵⁰ = 60.5%; so at least one slow = **39.5%**. In your head: 50 × 1% = 50% (n × p = 0.5, not "small", so the approximation says a bit too much). **So:** a rare per-shard tail becomes a common per-request tail. Hedged requests, or fan out to fewer shards (11.4).

**9. Availability chain — ~129 minutes/month.** 0.999³ = 99.7%; (1 − 0.997) × 43,200 = **129.5**. In your head: 3 × 0.1% = 0.3%, × 43,200 ≈ 130 (here n × p = 0.003, very small, so the approximation is nearly perfect). **So:** three times one service's budget. If the product promises 99.9% for the whole, take one service off the path or make it async (1.5, 10.3).

**10. Log volume — ~1,080 GB/day.** 500 × 50 × 500 B = 12.5 MB/s; × 86,400 = **1,080 GB** (~1 TB). In your head: 12.5 MB × 10⁵ = 1,250 GB. **So:** ~32 TB in 30 days in a search cluster. Sample the debug logs, keep metrics for trends, move old logs to object storage (10.4, 10.7).

</details>

### 1.5 Rounding versus a wrong step

The biggest question after the drill: if my answer differs from the reference, is that a problem? Part A of `npm run rounding` puts the exact calculation and the rounded-in-your-head calculation (the "in your head" lines above) side by side across the ten drills:

```
drill                                      exact  in your head    off by
1. Photo app: peak reads                  69,444        60,000     1.16×
2. Photo app: storage per year              18.3          20.0     1.10×
6. Chat: peak message writes             138,889       120,000     1.16×
8. Fan-out: tail latency                    39.5          50.0     1.27×
10. Logs: volume per day                   1,080         1,250     1.16×
worst rounding error: 1.27×
```

(The other five had nothing to round, 1.00×.) The biggest error across the ten is **1.27×**, and even that isn't from rounding but from the n × p approximation (drill 8). No decision changes at this size of error: both 60,000 and 69,000 need a cache.

Part B makes **one step** wrong in the same chains:

```
drill                             the slip                                                  wrong answer    off by
1. Photo app: peak reads          forgot the peak (sized for the average)                         23,148     3.00×
3. Live video: peak egress        mixed bits and bytes (3 MB/s per viewer)                          48.0     8.00×
4. API fleet: servers             forgot the 60% ceiling (ran at 100%)                              75.0     1.67×
5. Catalog: cache size            read 5 KB as 5 MB                                               20,000    1,000×
6. Chat: peak message writes      forgot to divide by 86,400 (per day as per second)      12,000,000,000   86,400×
9. Availability: three in series  used one service’s availability for the chain                     43.2     3.00×
10. Logs: volume per day          forgot the 500 instances                                          2.16      500×
smallest slip: 1.67×
```

Even the smallest wrong step (forgetting headroom, 1.67×) is bigger than the biggest rounding error. And the rest are 3× to 86,400×. And almost every one of them **flips** a decision: forget the peak and you design for 23,000 and the system dies in the morning rush; mix bits and bytes and you budget for a 48 Tbps CDN; read 5 KB as 5 MB and you get a 20 TB cache cluster that was never needed.

**Unit Slip** — an error of unit or quantity in one step of an estimation chain (bits vs bytes, day vs second, KB vs MB, a missing factor), which moves the answer not by a few percent like rounding, but by a few times to a thousand times.

The habit that follows is clear: **don't be afraid of the decimals, be afraid of the units.** And there's a cheap way to catch a wrong step.

**Sanity Check** — after an answer comes out, checking by a separate, independent route whether the number is believable: what it works out to per user, or how it compares to a known large system. For example drill 6's 12 billion/s: "120 messages a second per user?" is caught in a second. Drill 5's 20 TB: "5 MB of JSON per product page?" too. A five-second "how much per user?" after every answer catches almost every big wrong step.

### 1.6 "So": from numbers to decisions

Put the ten drills' "so"s side by side and four kinds appear, and in an interview almost every number falls into one of these four:

- **A tool isn't needed.** Drill 5 (one Redis node, not a cluster), the TaskFlow story (no new database). The biggest lesson of 11.1 and 11.7. This is the most valuable "so", because it saves complexity and shows judgement (the medicine for 12.1's mistake 5).
- **A limit has been crossed.** Drill 1 (one database can't do it directly), 6 (one primary can't), 7 (one gateway can't, so a registry). A new tool arrives here, but because of a number.
- **Cost is the real question.** Drills 2, 3, 4, 10. The technology here is simple (object storage, CDN, servers, logs), the question is the bill (10.7). And the "so" is which lever lowers it.
- **The shape of the problem changes.** Drills 8 and 9: the number doesn't point to a tool but to an unexpected behaviour (a rare tail becomes common, a chain is weaker than each of its parts). These are usually the best places for a deep dive.

> **Trade-off Table — estimation decisions**

| decision                  | one side                                                                     | the other side                                       | when to use which                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| exact vs rounded math     | exact: zero error, but eats minutes and the risk of a wrong step is the same | rounded: seconds, error within ~1.3×                 | almost always rounded, said out loud; exact only where the answer sits right next to a limit                          |
| 24 hours vs active window | 24 hours: simple, right for a global app                                     | active window: right for a one-country or office app | ask where and when users are active in the requirements; the answer changes things 2-3×                               |
| the peak factor           | 2-3× (1.3): the ordinary daily wave                                          | 10× or more: a sale, a launch, a ticket moment       | in event-driven systems treat the peak as a separate question (11.7, Module 11 exit challenge)                        |
| how many numbers to count | many: the full picture, but the five minutes are gone                        | three or four: only the ones that change a decision  | don't count a number that has no "so"                                                                                 |
| n × p vs 1 − (1 − p)ⁿ     | n × p: one second in your head                                               | compounding: correct, but needs a power              | approximate when n × p is small (≲ 0.1), compound when it's large, and say out loud that the approximation overstates |

---

## 2. Interview Angle

Estimation comes up in interviews in a few familiar forms:

- **"Skip the estimation, we're short on time."** Some interviewers say this, especially in senior rounds where they want more time in the deep dive. Even then say one line: "Okay, I'll just assume this much: a few thousand writes a second at peak, so one primary is enough." A design without numbers leaves the door open to 12.1's mistake 5.
- **"Is your number right?"** The interviewer challenges your peak or DAU, often deliberately, to see how you change the design when the number changes. A good answer: accept the new number, redo only that step of the chain, and say which decision flipped and which survived. Don't redo the whole calculation.
- **"How many servers?"** Drill 4's shape, but often without the givens. Then CPU per request or throughput per server is a stated assumption, and say out loud that it should be measured (load test, profiling), not assumed.
- **The senior signal: which assumption matters most.** "The most uncertain thing in this calculation is the number of messages per user. If it doubles, we cross one primary's limit, so I'm keeping the partition design in place now." It shows you know which number the answer hangs on.

**In real production:** capacity planning, cost reviews, and the "what would we need if we took this new client" question are all this drill. And the most common real errors are Part B's wrong steps, not rounding: reading a dashboard's bits/s as bytes/s, reading a metric's "per minute" as "per second", budgeting every region with one region's numbers. As in the TaskFlow story, a ninety-second chain often gives the same answer as a three-day document, and shows the real risk sooner.

---

## 3. Key Takeaway

- **The goal of estimation is the right magnitude and a decision, not a correct number:** 60,000 and 69,000 give the same design; 700 and 70,000 give different ones
- **One chain, a unit at every step:** total → ÷ active window → × peak → ÷ capacity → ÷ headroom → so. When there's an error, you can find which step on paper
- **Round a few constants:** a day ≈ 10⁵ s (says 16% less), a month ≈ 2.5 × 10⁶ s or ~43,000 minutes, a year ≈ 3 × 10⁷ s
- **Rounding is safe, a wrong step isn't:** across ten drills the biggest rounding error is 1.27×; one wrong step is 1.67× to 86,400×. Bits vs bytes, day vs second, a missing factor
- **Active window and peak are two separate steps:** dividing an office app by 8 hours alone triples the average, before the peak
- **Probabilities don't multiply, they compound:** 1 − (1 − p)ⁿ; n × p only works when small, and overstates (39.5% vs 50% across 50 shards)
- **A sanity check after every answer, and a "so" at the end:** "how much per user?" catches most wrong steps; and a number with no "so" didn't need counting

---

## 4. New Terms (Glossary)

| Term                       | Meaning                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Estimation Chain**       | Writing an estimation as a chain of small steps, each a multiplication or division, with its unit — both fast math and finding the wrong step come from this                                       |
| **Powers-of-Ten Rounding** | Writing every number as 1, 2, 3 or 5 × 10ⁿ (86,400 → 10⁵), so multiplying and dividing means adding and subtracting exponents; moves the answer a few tens of percent, doesn't change the decision |
| **Active Window**          | The part of the day when traffic actually comes — 24 hours for a global app, 8-10 hours for a one-country office app; dividing by the wrong window gives an average 2-3× too low                   |
| **Headroom**               | The empty space deliberately left between the calculated demand and the built capacity (servers up to 60%, gateways half full) — for failover and the latency queue                                |
| **Unit Slip**              | An error of unit or quantity in one step of the chain (bits/bytes, day/second, KB/MB, a missing factor) — moves the answer by a few times to a thousand times                                      |
| **Sanity Check**           | After an answer comes out, checking by an independent route — "how much per user?" or a comparison with a known system; catches most unit slips in five seconds                                    |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. A candidate answered drill 3 with "48 Tbps". (a) At exactly which step, and what went wrong? (b) Had this error gone uncaught in the interview, what would have happened to the design, and with which question could the interviewer have caught it? (c) Which sanity check would have caught it in five seconds?

2. The big company from the TaskFlow story came back the next year: "Our offices are now in three countries, in three different time zones, and the users have gone from 200,000 to 1 million." (a) Which steps of the senior's chain change, and what is the new peak write rate? (b) Does spreading across time zones increase the load or reduce it, and why? (c) Did the "so" change?

3. After drill 6 the interviewer said: "This is a chat app, but at midnight on New Year everyone sends 'Happy New Year' at once. Will your 3× peak work here?" (a) How would you estimate that moment's peak, with which assumptions? (b) Which decision changes: more machines, or something else? (c) Without redoing the whole calculation, which step of the chain alone changes?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) 48 = 6 × 8. The candidate took the bitrate as **bytes** (3 MB/s per viewer) and then converted the answer to bits again, or read Mbps as MBps. A video's bitrate is almost always given in bits (Mbps), and network bandwidth is in bits too, so no conversion was needed here: 2 million × 3 Mbps = 6 Tbps.

(b) A CDN budget and contract 8× too big (the egress bill is roughly linear, 11.6), or a big and wrong decision like "even a CDN can't do it, we'll build our own edge". The interviewer could have caught it with a simple question: "How much bandwidth does each viewer get in your calculation?" — the answer is 24 Mbps, several times an ordinary HD stream.

(c) "How much per viewer?" — 48 Tbps ÷ 2 million = 24 Mbps. For a live stream on a phone that's implausibly high (a 1080p stream is usually a few Mbps). That's exactly the five-second "how much per user" sanity check.

**Question 2:**

(a) Users 1 million, half active = 500,000; each 6 writes = 3 million writes/day. But the active window is now bigger, the three offices' days combined: if the three time zones are spread out reasonably, say work runs across ~16-20 hours. 3 × 10⁶ ÷ (18 × 3,600 ≈ 6.5 × 10⁴) ≈ 46 writes/s on average. And the peak: each office's 10 am rush now comes at a different time, so the peak factor may be lower than one office's 2, say 1.5 → ~70 writes/s. (In an hour where two offices overlap it's more; that should be said out loud too.)

(b) Users went up five times, but the peak write rate less than doubled (from 40 to ~70). Because the load has spread over time: when the active window grows, the same work arrives at a lower density. Spreading almost always reduces the peak, as long as the office hours don't overlap.

(c) No. ~70 writes/s and ~700 reads/s are still nothing for one primary and replica. What changes is a different question: latency for users in three countries (10.8's multi-region, or is one region enough?), the law on where data must be kept, and the maintenance window — "night" is now someone's day.

**Question 3:**

(a) 3× is for an ordinary day's wave, not for the moment of an event. Estimate: a large share of active users (say 20%, 20 million) send 5 messages on average in the ~1 minute after midnight = 100 million messages in 60 seconds ≈ 1.7 million/s, ~12× the ordinary peak, ~36× the average. And that's itself an average; the first few seconds are higher. Say every assumption out loud: how many people, how many messages, in how many seconds.

(b) Keeping 12× the machines all year for one minute makes no sense. The decision changes towards design: a buffer on the write path (a queue or log, 7.2) so the wave spreads over a few seconds; relaxed delivery order (a message arriving a few seconds late is fine, being lost isn't); switching off less urgent work (typing indicator, read receipts, presence, 10.3's degraded mode); and since the event is known in advance, scaling up ahead of time (10.7).

(c) Only the "× peak" step, and with it the active window: "÷ 86,400 per day" becomes "÷ 60 seconds per event". The total amount, the message size, the per-machine capacity all stay the same. That's the advantage of the chain: when the interviewer changes one number, redo one step, not all of it.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (an interactive drill that times you and checks your answers, and a script that measures the effect of rounding and of wrong steps; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-12.2-estimation-drills/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-12.2-estimation-drills) — `npm install`, then `npm run drill`, `npm run answers`, `npm run rounding`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`drill` shows the ten questions one at a time, times each one, compares your answer (written like `70k` or `20 GB`, validated with Zod) with the reference, and gives a summary at the end: how many within 2×, how many within 10×, how many over the time limit. `answers` shows each drill's chain step by step. `rounding` gives the three tables in 1.5 above.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; `answers` and `rounding` twice each, output byte-for-byte identical; `drill` with piped input (answers with units, bad input, an empty line, input ending early). The drills' givens are assumed, not measured numbers from hardware or any company. The "in your head" chain is one version of how I'd round; yours may differ a little, and so may the result. The 2× and 10× grading thresholds are judgement, not a standard. One thing to know: `drill` drops the unit text next to an answer, it doesn't convert it, so if the question asks for GB, `1.2 tb` is taken as 1.2 GB — answering in the unit asked is part of the drill.

**Once the setup checks out, do these five:**

1. **A cold first round:** run `npm run drill` without opening the answers in 1.4 above. Write each one's chain on paper. Save the summary: within 2×, within 10×, total time.

2. **Classify each error:** for every answer outside 2×, compare your paper with the chain from `npm run answers`, and write: is this a rounding error or a wrong step? If a wrong step, which — peak, active window, unit, headroom, a missing factor, or n × p? By 1.5's numbers most should be wrong steps. Are yours?

3. **"So" first:** before doing the drill a second time, write a one-line "so" for each question, then compare with `drill`'s "so". Where is your decision different, and is that a different but reasonable path?

4. **Changing code:** the README's experiments 3 and 4: a new slip, and an 11th drill of your own (a number from your 12.1 exercise question), with an exact and a mental chain and a "so", keeping `tsc --noEmit` clean.

5. **The design part:** redo the estimation part of the question you picked in 12.1's exercise (parking garage, leaderboard or Dropbox), in exactly five minutes, out loud: three stated assumptions, three or four chains, a "so" at the end of each, and a sanity check. Compare it with the estimation part of the earlier recording: how long it took, and how many numbers had no "so".

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 11 (complete, with exit challenges), 12.1
Current: 12.2 — Estimation Drill: 10 Rapid-Fire
TaskFlow state: as at the end of Module 10; the math for an enterprise tenant of 200,000 users: in the 8-hour office
active window ~40 writes/s peak, ~400 reads/s — no new database, the real risk is the hot tenant (11.2).
Estimation: chain (total → ÷ active window → × peak → ÷ capacity → ÷ headroom → so), a unit at every step; constants:
a day ≈ 10⁵ s (1.16×), a month ≈ 43,200 minutes, a year ≈ 3 × 10⁷ s. Across ten drills the biggest rounding error is
1.27× (the n × p approximation); one wrong step is 1.67× to 86,400× (bits/bytes 8×, KB/MB 1,000×, day/second 86,400×).
Probabilities compound: 50 shards × 1% = 39.5% slow, three 99.9% services = ~130 minutes a month. Four kinds of "so":
a tool isn't needed, a limit is crossed, cost, the shape of the problem.
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check
Weak spots: [where you got stuck — write it yourself; from the drill's summary and the error classes]
Next: 12.3 — Mock interview #1
=======================
```

---

## 8. Next Step

Today's thread: **don't be afraid to round, be afraid to skip a step.** Decimals don't change any decision; a forgotten peak, a bits-and-bytes mix-up, dividing by the wrong time do. So the chain on paper, a unit at every step, the five seconds of "how much per user?" at the end, and then a "so".

When you are ready, write `next` — **Lesson 12.3: Mock interview #1.** This time one question, the full 45 minutes, and you are the candidate. The lesson is laid out as an interviewer's script: the question, a clock for your answer, and each of the interviewer's follow-ups in a closed section that you open only after giving your own answer. At the end, a framework for honest feedback and a score along 12.1's rubric, and what a model answer's hour looks like — without 12.1's ten mistakes, and with a five-minute estimation like today's.
