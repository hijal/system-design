# Lesson 1.6 — Vertical vs Horizontal Scaling, Stateless vs Stateful

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.4):** What problem does keep-alive (a persistent connection) actually solve, and where else in system design does this same "reuse" principle show up? (Give an example from your own Sequelize experience.)

---

**Prerequisite:** Lessons 1.1 – 1.5

**By the end of this lesson you will be able to:**

1. Explain the difference between vertical and horizontal scaling, along with the limits and trade-offs of each.
2. Recognise whether a server is "stateless" or "stateful", and understand why a stateless architecture is an almost mandatory prerequisite for horizontal scaling.
3. Analyse TaskFlow's own Express server in terms of "session" and say whether it is stateful or stateless today, and what would have to change to scale it horizontally.

**Tier:** 3 — Design Exercise (this is the last lesson of Module 1; no code today, but this lesson's concepts are the foundation of every hands-on exercise from Module 3 onward)

---

## 0. Where TaskFlow Is Right Now

So far we have treated TaskFlow as "one Express server, one Postgres". From estimation (1.3) we saw that QPS grows with users. From the connection lifecycle (1.4) we learned every connection has a cost. From latency and availability (1.5) we learned some features need strict targets.

The natural question now: **when one Express server's capacity is no longer enough, what do you do?** The answer sounds easy — "add another server" — but an important question hides inside it: **how?** Do you add a _bigger_ server, or _more_ servers? And if you add more servers, is your code today even ready for that? This lesson answers both, and prepares the ground for Module 3 (Load Balancing).

---

## 1. Theory

### 1.1 Vertical Scaling — Making the Same Server Bigger

**Vertical scaling (scale up)** means **increasing the hardware resources** of your existing server — more CPU, more RAM, a faster disk. The architecture stays the same (still one server); it just gets more powerful.

```
Before:  [Server: 2 CPU, 4GB RAM] ──> handles all requests

After:   [Server: 16 CPU, 64GB RAM] ──> same server, more resources
```

For an app deployed on a VPS, vertical scaling means going to the VPS provider and upgrading to a larger plan (from 2 vCPU to 8 vCPU, and so on).

**Advantages:**

- Simplest possible implementation — no code changes, just a hardware or plan upgrade
- No need to think about data consistency (one server, one database instance)

**Limits:**

- **There is a physical ceiling** — however big a machine gets, CPU and RAM have a maximum (even the largest cloud instance type has a limit)
- **Single point of failure (SPOF)** — if that one server goes down, the whole system goes down. No redundancy.
- Cost often grows non-linearly — one "big" server can cost more per unit than two "medium" ones

### 1.2 Horizontal Scaling — Adding More Servers

**Horizontal scaling (scale out)** means adding **multiple (usually small or medium) servers** instead of one large one, and distributing traffic across them.

```
Before:  [Server: 4 CPU, 8GB RAM] ──> handles all requests

After:   [Server 1: 4 CPU, 8GB]  ─┐
         [Server 2: 4 CPU, 8GB]  ─┼──> a load balancer distributes the requests
         [Server 3: 4 CPU, 8GB]  ─┘
```

(That "load balancer" box is a black box for now — in Module 3 we go inside it, to see how it decides which request goes to which server.)

**Advantages:**

- **Practically unlimited scale in theory** — add more servers as needed; there is no hard hardware ceiling
- **Redundancy and fault tolerance** — if one server dies the others keep going; the whole system does not go down
- Usually cost-effective — many small or medium (commodity) servers can be cheaper than one enormous one

**Limits:**

- **Complex to implement** — you need a load balancer, and most importantly **your application code has to be ready for this multi-server reality** (which is the subject of the next section)
- New data consistency challenges appear — with multiple servers, how does data stay in sync between them? (We go deep on this in Module 5 with replication and sharding.)

> **Trade-off Table — Vertical vs Horizontal**

| Dimension                 | Vertical Scaling                        | Horizontal Scaling                          |
| ------------------------- | --------------------------------------- | ------------------------------------------- |
| Implementation complexity | Low (hardware upgrade)                  | High (load balancer, code changes)          |
| Scale limit               | Has a hard ceiling                      | Practically unlimited in theory             |
| Fault tolerance           | None (SPOF)                             | Yes (one down, the rest keep going)         |
| Downtime while scaling    | Usually needed (server restart/resize)  | New servers can be added with zero downtime |
| When it fits              | Small/medium scale, need a quick answer | Large scale, long-term planning             |

**What actually happens in practice:** most production systems start with vertical scaling (it is easy, and enough at small scale), and move to horizontal scaling once they hit the vertical ceiling or need redundancy. This brings back the point from Lesson 1.1 — adding the complexity of horizontal scaling from day one (when you have 100 users) can itself be over-engineering.

### 1.3 Stateless vs Stateful — the Real Prerequisite for Horizontal Scaling

Here comes the most important part of this lesson, and the one most often misunderstood.

A server is **stateful** if it **stores request-specific information** in its own memory (or local disk) that will be needed by a later request.

A server is **stateless** if it **stores no request-specific information locally** — every request is self-contained, carrying everything it needs (or fetching it from a shared, external place).

**A classic example — session management:**

Say that when a user logs into TaskFlow, the server creates a session and keeps that session data (who logged in, what permissions they have) in **its own memory**:

```
Stateful approach:

[User logs in] ──> [Server 1 builds a session in its own memory: {userId: 123, role: "admin"}]

Next request ──> [which server does the load balancer send it to?]
                        │
                ┌───────┴────────┐
                ▼                ▼
         [Server 1]       [Server 2]
       (has the session!)  (no session — tells the user to log in again!)
```

And there is the problem — if the next request lands on **Server 2** under horizontal scaling (entirely likely, since the load balancer has no idea whose session lives where), Server 2 has no information about that user and will ask them to log in again, moments after they just did. That is a terrible user-experience bug, and it appears the instant you turn on horizontal scaling.

**The fix — make it stateless:**

In a stateless architecture, session data does not live in a server's memory but in a **shared, external place** reachable from any server:

```
Stateless approach:

[User logs in] ──> [any server creates the session, but saves it to an external store]
                                        │
                                        ▼
                              [Redis / database — shared session store]

Next request ──> [load balancer sends it to any server]
                        │
                ┌───────┴────────┐
                ▼                ▼
         [Server 1]       [Server 2]
              │                 │
              └────────┬────────┘
                        ▼
              [both servers can read the session from the same external store]
```

Now a request can land on any server and the session data is always reachable — because it is not in one particular server's memory but in a shared place. This is what we build hands-on in Module 4.4 (a session store with Redis).

> **In the context of your stack:** if your Express app uses the `express-session` middleware with its default memory store (which tutorials often leave as the default), that is **stateful** — it will only work for a single-server deployment. To scale horizontally you would switch it to a Redis store (with an adapter like `connect-redis`) — that is the practical step of making it stateless.

**Statelessness is not only about sessions — more examples:**

- **File upload (remember the Lesson 1.1 exercise?):** if an uploaded file is saved to the server's local disk, that is stateful too (only that server knows where the file is). This is exactly why we marked "store it in S3" as a _solution_ in the 1.1 deep dive — that reason went unexplained then, and here it is.
- **In-memory rate limiting counters:** if "how many requests has this user sent" is kept in a server's memory, each server has its own separate count, which gives wrong results (we cover this in detail in Module 9.5).

> **A common interview question:** "How do you know whether your API is stateless?" — a simple test: **if you can shut the server down at any moment and replace it with a fresh one (without data loss) and the user notices nothing, it is stateless.** If shutting it down loses something (a session, an uploaded file, in-progress data), it is stateful.

---

## 2. Interview Angle

The stateless/stateful distinction comes back in some form in **almost every** system design interview, because it determines whether you can scale horizontally at all. A very common question:

> "How would you scale this API server as users grow?"

The first step of a good answer should be: "First I'd check whether my server is stateless. If it isn't, I'd make it stateless first — move sessions, files, and local state out to a shared store — and then scale horizontally with multiple instances behind a load balancer." That answer shows you know horizontal scaling is not "just add another server" — it has a **prerequisite**.

A common junior mistake is jumping straight to "I'll add a load balancer and run three servers" without raising the state question at all. A senior-level answer always asks or mentions first: "does this server keep any local state?"

---

## 3. Key Takeaway

- **Vertical scaling** = make the existing server bigger (more CPU/RAM). Easy, but it has a hard limit and leaves a SPOF
- **Horizontal scaling** = add more servers and split the traffic. Complex, but gives near-unlimited scale plus fault tolerance
- Most systems start vertical at small scale and move horizontal when needed
- **Stateful server** — keeps request-specific data in its own memory or disk (sessions, uploaded files, local counters)
- **Stateless server** — keeps no local state; everything lives in a shared external store (Redis, DB, S3)
- **The real prerequisite for horizontal scaling is a stateless architecture** — scaling a stateful server horizontally causes data inconsistency or loss
- The test: shut a server down and replace it — if the user notices, it is stateful; if not, it is stateless

---

## 4. New Terms (Glossary)

| Term                               | Meaning                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Vertical Scaling (Scale Up)**    | Increasing one server's hardware resources                                                                    |
| **Horizontal Scaling (Scale Out)** | Adding more servers and distributing traffic across them                                                      |
| **Single Point of Failure (SPOF)** | A component whose failure brings down the entire system                                                       |
| **Stateful**                       | The server keeps request-specific data locally (in memory or on local disk)                                   |
| **Stateless**                      | The server keeps no request-specific data locally; it lives in a shared store or the request carries it along |

---

## 5. Reflection Questions

Think it through yourself first, then open the answer key.

1. Recall TaskFlow's current state — "single Express server + 1 Postgres". In this architecture, where do you think session and user data _should_ live so that horizontal scaling is easy later — starting from now?
2. An in-memory rate limiter (keeping each user's request count in a plain JavaScript object in the server's memory) — is it stateless or stateful? What specifically goes wrong under horizontal scaling? (Apply the "name a concrete mechanism instead of being vague" habit from Lesson 1.5.)

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Even though TaskFlow has only one server today (so this causes no technical problem yet), the best practice is to keep session data in **the database** (or later in Redis) from the start, rather than in the server's own memory. Then when horizontal scaling becomes necessary, no large refactor is needed — the architecture is already "scale-ready". This is good engineering practice: making a sensible decision now to reduce future migration cost. And it does not contradict the "over-engineering" warning from Lesson 1.1 — no extra infrastructure is being added here, only a thoughtful choice about _where data lives_, which is essentially free.

**Question 2:** It is **stateful**, because the rate limit count is held in one particular server's memory (a plain object). The problem under horizontal scaling: say a user's rate limit is "10 requests per minute". If a load balancer spreads requests across three servers, each server counts separately — Server 1 might see 4 requests (within its limit), Server 2 sees 4 of its own (within its limit), Server 3 another 4. In reality the user sent 12 requests (more than 10!), but no single server has the whole picture, so the limit is never properly enforced. The fix comes in Module 9.5 — keep the rate limit counter in a shared store like Redis, so every server sees the same count.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

This is the last lesson of Module 1, so today's exercise is more integrative — it uses everything learned so far.

> **Scenario:** TaskFlow is currently "single Express server + 1 Postgres" (~100 users). Say the user count is expected to reach 50,000 in six months.
>
> Answer the following:
>
> 1. Would you go straight to horizontal scaling, or try vertical scaling first? Give one line of reasoning for your decision. (Is 50,000 users really "huge" scale, or still moderate? Use the estimation skill from Lesson 1.3 to work out a rough QPS and show why.)
> 2. If you plan to scale horizontally later, **which parts** of TaskFlow's current architecture do you suspect might be stateful? (Nothing has been stated explicitly, but think about the common places in a typical Express + Sequelize app.) Identify at least two, and say in one line how each could be made stateless.
> 3. Write a trade-off statement (applying the concrete-mechanism habit from Lesson 1.5) — what new cost or complexity would moving to horizontal scaling add to TaskFlow that does not exist today?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2, 1.3, 1.4, 1.5
Current: 1.6 — Vertical vs Horizontal Scaling, Stateless vs Stateful
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth,
TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC, Latency, Throughput, Availability, Reliability, SLA, SLO,
Error Budget, Vertical Scaling, Horizontal Scaling, SPOF, Stateful, Stateless
Weak spots: mixing up solution and constraint in functional/non-functional (improving);
treating UI state as a component in the HLD; taking assumptions without reading the
requirement carefully; stopping before covering every sub-part (a/b/c) of a multi-part
exercise (in Lesson 1.5 only one feature was answered instead of three) — build the habit
of checking all parts are covered before submitting
Next: Module 1 Exit Challenge
=======================
```

---

## 8. Next Step

Send the exercise over (and this time keep in mind covering every sub-question) — it is the last lesson-level exercise of Module 1. After that, write `next` and we move to the **Module 1 Exit Challenge** — a mini design challenge (Tier 3), a "you should be able to do these" checklist, and some book, video, and project recommendations. Then we move on to Module 2 (Networking & Communication).
