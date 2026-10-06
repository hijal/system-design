# Module 12 — Exit Challenge (Interview Mastery & Capstone)

**Module 12 — Interview Mastery & Capstone**

Module 12 is done: the ten mistakes and the rubric (12.1), speed at estimation (12.2), two mocks (12.3, 12.4), the story of your own system (12.5), and TaskFlow's full design doc and a measured core piece (12.6). And with it, the whole course is done.

In both mocks you had a script with you: the interviewer's answers in a closed section, follow-ups at their minute, push-back after your answer. A real interview has no script. This challenge is a new system, 50 minutes, without any closed sections. The follow-ups come **after** the mock is over, in writing, so you can see which ones you raised yourself and which ones would have had to be asked. And one part of the system is deliberately outside this course: exactly as happens in a real interview.

---

## 1. Mini Design Challenge (Tier 3)

### Part 1 — The mock, 50 minutes, no help

12.3 and 12.4's rules: recording on, timer on, all of it out loud, the time box in the corner of the board (`Req 5 · Est 5 · HLD 10 · Deep 25 · Wrap 5`) and the two lowest dimensions from 12.4's score.

**The question (00:00):**

> "Design the order and rider dispatch of a food delivery service for one city."

**Before reading the scenario below:** in two minutes, write your clarifying questions on paper, as if asking the interviewer. Then read the scenario, and tick each question whose answer is there. Any question without an answer is your stated assumption. And mark separately the important information in the scenario that you didn't ask about: in a real interview you wouldn't have known it.

> **Scenario:** A big city, about 20 million people. A customer orders in the app, a restaurant accepts and cooks, a rider (motorbike or bicycle) picks it up and delivers it. Some facts:
>
> - **Size:** ~800,000 orders a day. 12-2 pm and 8-10 pm together hold 60% of the day's orders. During Ramadan, ~25% of the day's orders come in the half hour before iftar. ~15,000 restaurants. ~30,000 riders online at peak.
> - **Riders:** while online, the rider's app sends its location (GPS) every 4 seconds. In many parts of the city the mobile network is weak, and riders' connections often drop.
> - **Customers:** see an estimated arrival time (ETA) at checkout. After the rider picks up the food, they watch the rider move on a map. An average delivery takes ~30 minutes.
> - **Payment:** ~65% digital (cards and mobile wallets, through a PSP, 11.7), ~35% cash on delivery.
> - **Time requirements:** the restaurant accepts within 3 minutes, otherwise the order is cancelled and the customer told. A rider is assigned within 2 minutes of acceptance.
> - **The current system:** a monolith, one Postgres. Riders' locations in a `rider_locations(rider_id PK, lat, lng, updated_at)` table, an `UPDATE` every 4 seconds. Dispatch is a job that every 10 seconds loops over all pending orders, computes in SQL the distance (haversine) to every free rider for each one, `ORDER BY distance LIMIT 1`, then `UPDATE orders SET rider_id = …`. Notifications are a FIFO queue. The customer's tracking screen polls the rider's location every 5 seconds.
> - **Summary of last Ramadan's postmortem:** at 5:40 the database's CPU was at 100%. One round of dispatch took 15 minutes instead of 10 seconds; ~2,000 orders cancelled, a lot of food gone cold. Some riders got assignments for two different orders at the same moment and raced to two restaurants. Some restaurants cooked orders whose payment hadn't been confirmed yet, and those later failed. On customers' maps the rider was "jumping" — from one place to another, sometimes backwards.
>
> Product's goals: (1) a rider within 2 minutes of acceptance even in the iftar wave; (2) a rider never gets assignments for two orders at once (for now); (3) a restaurant doesn't start cooking until payment is confirmed, but the customer's wait mustn't become unbearable; (4) the rider moves smoothly on the customer's map; (5) the ETA is off by less than 5 minutes on average.

Now 50 minutes. The whole design: requirements, estimation (a "so" after every number), high level, data model and API, two deep dives, wrap-up. No follow-ups. Be your own interviewer: check in at the end of each step ("now I'd like to go into the dispatch deep dive"), and bring up failures and trade-offs yourself.

**Stop at 50 minutes.** Recording off. Before reading Part 2 below, and without listening to the recording, write three lines: which two deep dives you chose and why, where you were most uncertain, and which follow-ups you think will come.

### Part 2 — Follow-ups, in writing, after the mock

The ten questions below are from an interviewer's notebook. For each, two tasks: (a) search the recording for whether you raised its subject **yourself** — if you did, write the `mm:ss`, and that's a strong signal; (b) if you didn't, write an answer now, 3-5 minutes each, as if the interviewer just asked. Next to each question is the Module 12 skill being tested.

**1. The iftar numbers (Lesson 12.2 — estimation chain, active window)**
25% of 800,000 in half an hour: how many orders a second? 30,000 riders × every 4 seconds: how many location writes a second? And tracking: how many customers keep the map open at once (which orders are active, for how many minutes), and how many reads a second at a poll every 5 seconds? Put the three numbers side by side and say: where is this system's biggest load — in orders, or in locations? A "so" at the end of each, and a sanity check ("how much per rider?"). How many times the day's average is the iftar number? Why is the usual "peak × 3" wrong here?

**2. The clock and the choice of deep dives (Lesson 12.1 — framework, time box, the list of mistakes)**
How many minutes did each step actually take? Were the two deep dives you chose this system's two hardest places — which of the postmortem's four failures did they cover? The ten-mistake checklist, with `mm:ss`.

**3. The nearest free rider (Lesson 12.5 — "not knowing", the depth ladder; 12.3 — thinking from the data structure)**
The current dispatch computes the distance to every rider for every order. 30,000 riders × the iftar order rate: how many distance calculations a second? Geospatial indexes weren't taught in this course — **on purpose.** If you don't know the name, think from first principles: if you divide the city into the cells of a grid, what does finding "a nearby rider" look like? How big is a cell, and what about orders on a cell's boundary? When a location changes, where do you keep which cell the rider is in? Then write down the exact sentence you'd have started with in the interview, not knowing whether this has a common name.

**4. One rider, two orders (Lesson 12.6 — optimistic lock, the core write path; 5.5)**
Last Ramadan a rider got two assignments at the same moment. Which row of 12.6's 50-person test does this resemble? Write an SQL statement for a rider's assignment that gives the rider to only one of two simultaneous dispatches asking for them, and what the other one does (look for another rider, or wait). And when several dispatch instances run at once, how does the same **order** not get two riders?

**5. The requirements change (Lesson 12.4 — adapting)**
The interviewer: "Product's new decision: a rider can take at most two orders at once, if the two restaurants are close and the two customers are in the same direction." Which decision or assumption in your design breaks because of this (by name)? What happens to question 4's rule? What will you change, without throwing away the whole? And how does the dispatch question change shape with this change (from "the nearest rider for one order" to what)?

**6. Push-back: payment and cooking (Lesson 12.4 — push-back; 11.7 — unknown)**
You said (or should have said): while the payment is `unknown`, the restaurant won't start cooking. The interviewer: "The PSP's webhook sometimes takes a minute. That means some customers' food starts a minute late. Product says customers will hate it. And if you start cooking first, who eats the food from a failed payment?" Choose one, accept the price, and give two ways to lower the price. Does this question even exist for cash-on-delivery orders?

**7. The location path (Lesson 12.3 — derived store, source of truth; 11.3 — connections; 6.4 — order)**
Thousands of location `UPDATE`s a second on one Postgres — one of the reasons for the postmortem's CPU at 5:40. Where will you keep locations? Which is the source of truth, and do you need to keep location history at all (for what, how long)? On the customer's map the rider "jumps" and "goes backwards" — give two possible causes (one about the network, one about ordering), and a remedy for each. Poll or push (2.4): with numbers.

**8. Three rows of failure modes (Lesson 12.6 — failure mode table; 10.3)**
Three rows in 12.6's table format: (a) the location service down for ten minutes, (b) the PSP slow, 30% of requests timing out, (c) a rider's app offline for ten minutes in the middle of a delivery. For each: how you'll know, what the customer/restaurant/rider sees, and what the design does.

**9. Scaling triggers and cost (Lesson 12.6 — scaling triggers; 10.7)**
Write three scaling triggers, each with a measured number and a specific change. Which do you think will be this system's biggest cost line (compute, the database, location writes, the map API, SMS/push)? And capacity for iftar's half hour: autoscale, or ahead of time (the same time every day — what kind of peak is this)?

**10. The story (Lesson 12.5 — design narrative, retrospective)**
Write this design's 30-second version, in 12.5's structure. Then: which decision in this design are you least sure about, and which one number, if measured, would reduce that uncertainty most? And which decision taken at the start of the mock would you take differently now?

### Part 3 — The score, and three mocks side by side

Score yourself on 12.3's rubric, an `mm:ss` next to every score. Then the three mocks side by side:

```
dimension                12.3     12.4     Exit     evidence for the difference (mm:ss)
handling ambiguity       _        _        _
a working design         _        _        _
technical depth          _        _        _
judgement and trade-offs _        _        _
communication            _        _        _
follow-ups raised yourself in Part 2:    _ / 10
```

The last line is this challenge's most important number. Of the ten, how many did you raise yourself before anyone asked? Remember 12.1's definition of senior: raising the questions **before** the interviewer asks them. Four or five is good; seven or eight means you're running an interview in a way most interviewers will remember.

**Things to remember:** this challenge has four places where it's easiest to go wrong. (a) **Looking for the load in the wrong place.** "Food delivery" sounds like the load is in orders; the numbers say the load is in locations (question 1). The order rate is easy for one database even at iftar. (b) **The wrong peak.** Iftar is a daily event with its own clock, not "3× the average" (12.2's active window and the event peak). And it's known in advance, so scheduled capacity rather than autoscale (10.7). (c) **A made-up name for something you don't know.** If you don't know the geospatial index's common name, thinking from first principles with grid cells is a far stronger signal than a wrong name (12.5). (d) **Treating an external system's timeout as a decision.** A PSP's timeout means "I don't know" (11.7), and a rider's app going silent is also "I don't know" — the rider may be in a tunnel, the app may have crashed, they may have run off with the food. Each needs an `unknown` state and a time limit.

Send a summary of Part 1's recording, Part 2's ten answers (and which ones you raised yourself), and Part 3's table. I'll critique each follow-up, and match the differences between the three mocks against the evidence.

---

## 2. Self-Check — By the End of This Module You Should Be Able To

**Module 12:**

- [ ] I can run a 45- or 60-minute interview against the clock: the time box on the board, a check-in at the end of each step, and the biggest share of time in the deep dive
- [ ] I know the interviewer's rubric's five dimensions, and understand what signal each thing I say gives; I can spot the ten common mistakes in my own recording
- [ ] I can do any estimation in two minutes as a chain, with a unit at every step; I know rounding is safe, I sanity-check to catch wrong steps, and I say a "so" at the end of every number
- [ ] When the requirements change midway I can say exactly which decision broke, and change only that; on push-back I choose one option, accept the price, and lower it
- [ ] I can tell the story of one of my own systems in three lengths, with numbers, alternatives and an honest mistake; when I reach the bottom of the depth ladder I don't make things up
- [ ] I can write a full design doc: non-goals, estimation, schema, a scaling plan by triggers, a failure mode table, cost, rejected alternatives, open questions
- [ ] I can solve a core write path's three dangers (lost update, duplicates on retry, dual write) in code and show them measured

**The whole course, one line per module:**

- [ ] **1 — Framework:** the five steps on any question; the numbers for latency, throughput, availability and SLO/error budget; stateless vs stateful
- [ ] **2 — Networking:** the path from DNS to the response; the price of TCP/TLS; the trade-offs of REST/GraphQL/gRPC and WebSocket/SSE/polling; idempotency keys and cursor pagination
- [ ] **3 — Load balancing:** L4 vs L7, algorithms, health checks and graceful shutdown
- [ ] **4 — Caching:** which layer, which strategy, invalidation and TTL, and failures like stampedes and hot keys
- [ ] **5 — Databases:** schema, storage engines, indexes, isolation and anomalies, pooling and N+1, replication, sharding, CAP and quorum
- [ ] **6 — Distributed systems:** the failure model and split brain, consensus, read-your-writes, logical clocks, consistency models
- [ ] **7 — Async:** why async, queue vs pub/sub, retry/backoff/DLQ/backpressure, the outbox, batch vs stream
- [ ] **8 — Storage:** object storage, presigned/multipart uploads, the inverted index
- [ ] **9 — Service architecture:** when to split and when not, gateways and BFFs, sagas, breakers and bulkheads, rate limiting
- [ ] **10 — Reliability and operations:** consistent hashing, probabilistic structures, graceful degradation, observability, security, deployment, cost, multi-region
- [ ] **11 — Case studies:** seven systems from scratch, in each the numbers first and then the tools

If you can't tick a line, redo that module's exit challenge before rereading its lessons. Reading feels familiar; a challenge shows how much you can really do.

---

## 3. Recommendation

**To read:**

- **Martin Kleppmann — _Designing Data-Intensive Applications_.** The background to almost every module of this course. After the course, read it all again: what felt abstract the first time (replication, consistency, streams), now has a number from one of your own exercises next to each chapter.
- **Alex Xu — _System Design Interview_ (volumes 1 and 2).** To see the breadth of interview questions: questions you haven't done here (web crawler, key-value store, proximity service, Google Maps), each raw material for a new mock. Volume 2's "proximity service" chapter is one answer to Part 2's question 3 — read it **after finishing Part 2**.
- **Roberto Vitillo — _Understanding Distributed Systems_.** Short, and a clean recap of Modules 5-10. Good for a quick skim in the week before an interview.
- **Google — _Site Reliability Engineering_ and _The Site Reliability Workbook_.** Both published online for free. The original source of Module 10's SLOs, error budgets, alerts, incidents and postmortems; the next step after 12.6's failure mode table thinking.
- **Alex Petrov — _Database Internals_.** If you want to go deeper into Modules 5.3 and 6.2: inside B-trees and LSMs, and the consensus algorithms.

**To watch:**

- **Martin Kleppmann's Cambridge distributed systems lecture series** (on YouTube, eight parts). One of the clearest explanations of Module 6's logical clocks, quorums and consensus.
- **MIT's distributed systems course (6.5840, formerly 6.824) lectures and labs.** Doing the Raft lab yourself is the next step after 6.2's exercise. Hard, it takes time, but after it "I understand consensus" in an interview isn't memorised anymore.
- **Big companies' engineering blogs:** Uber's published writing on H3 (a hexagonal-grid geospatial index), and food delivery companies' writing on dispatch. Both are the real forms of Part 2's questions 3 and 5 — read them **after writing your own answers**. They are the companies' own writing, so from their point of view.

**To build:**

- **The Capstone's next step:** add fractional positions, the client's retry, and the outbox cleanup to 12.6's exercise (12.6's experiments), then a web BFF and a small SvelteKit board, so the 409's UI is real. That makes a complete project for your story bank that you can show.
- **This challenge's dispatch:** a TypeScript simulation: the city a grid, 30,000 riders on random walks, the iftar wave of orders. Compare three dispatches (distance to everyone, grid cells, a cell and its neighbouring cells), and measure: dispatch time, riders sitting idle, customers' waiting. Deterministic and seeded like this course's exercises. The answers to Part 2's questions 1 and 3, in measured numbers.
- **A small real production:** a small app of your own or a friend's, with real users, however small. Observability (10.4), an SLO, a deploy path (10.6), and a written postmortem of the first incident. The shortest path from 12.5's "learning project" story to a "production project" story.

**In the week before an interview:**

```
day 1   Story bank (12.5): record the two stories' 5-minute versions again, reread the depth ladders
day 2   Estimation (12.2): `npm run drill` twice, then five drills of your own
day 3   A new mock, 45 minutes, with a recording; the score and the mistake log
day 4   The progress ledger's weak spots: for each, run an old exercise again and explain it out loud
day 5   A 60-minute mock with a friend, with random "why?"s and push-back
day 6   The company you're interviewing with: what their product is, which system might be hard for them, their engineering
        blog; three questions to ask the interviewer
day 7   Rest. Read 12.1's table of sentences once, go to bed early. Nothing new to learn.
```

The last day matters. Reading a new distributed systems paper the night before an interview gains less than the sleep it costs: holding numbers in your head and thinking out loud under pressure are the first two things to go in a tired brain.

---

Do the exit challenge and send it over. And this is the course's last challenge: there's no `next` after it.

At the start there were two goals, equally important: doing well in interviews, and really understanding, so that it's useful after you get the job. Module 12 was for the first, and every one of its habits (a "so" from every number, the clock, bringing up failures yourself, staying honest) was actually borrowed from the second. Over eleven modules TaskFlow went from one Express server to a full platform, and at every step one thing came back again and again: first the problem, then the numbers, then the tool, and next to every tool its price. Walking out of the interview room into your first design review, your first incident, your first "will this scale?" question, the same order works.

If you want to go back to any module, or work on a system outside the course, write `design X`, `interview me`, `critique` or `war story` — the commands keep working after the course is over.
