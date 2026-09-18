# Lesson 1.3 — Back-of-the-envelope Estimation

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.2):** In the **deep dive** step of the five-step framework, which part should you pick — what criteria do you use to decide?

---

**Prerequisite:** Lesson 1.1, 1.2

**By the end of this lesson you will be able to:**

1. Work out rough storage, traffic, and bandwidth numbers quickly — in your head or on paper — during an interview or a design session.
2. Keep a handful of common reference numbers (latency numbers, storage units) memorised, because they come up again and again.
3. Take reasonable simplifying assumptions while calculating — and build the habit of saying those assumptions out loud.

**Tier:** 3 — Design Exercise (today's exercise is pure arithmetic; no code needed)

---

## 0. Where TaskFlow Is Right Now

Last lesson we learned the five-step framework, and you noticed that drawing the line between Step 2 (estimation) and Step 1 (requirements) was a little awkward. Today we go deep on exactly that Step 2.

Imagine you are settling the architecture for TaskFlow's "Search" feature (last lesson's exercise). You have two options:

1. Run a `LIKE` query directly against PostgreSQL
2. Stand up a separate Elasticsearch cluster

Which is right? It depends on **how many tasks there are and how often people search**. If TaskFlow holds 10,000 tasks total and gets 50 searches a day, option 1 works fine and Elasticsearch is overkill. If there are 10 million tasks and 500 searches per second, option 1 collapses.

**That number is what lets you decide — with arithmetic instead of a guess.** Today we learn how to do that arithmetic quickly, roughly, and in your head.

---

## 1. Theory

### 1.1 Why "Roughly" Is Enough — You Do Not Need Precision

"Back-of-the-envelope" means exactly that: a rough calculation scribbled on the back of an envelope (or a napkin), no calculator, no need to be 95% accurate. The goal is to understand the **order of magnitude**. You want to know whether the system is at "thousands" scale, "millions" scale, or "billions" scale — because the whole shape of the architecture changes with that.

For example: if you work out that you need "around 500 GB" of storage, whether it is 450 or 550 makes no difference to the architecture. But the difference between "500 GB" and "500 TB" changes everything. So at this step we never reach for a calculator — we work with round numbers (say "about a thousand" instead of 1,000; "about 360" instead of 365).

### 1.2 Base Numbers Worth Memorising

**Powers of 2 and their approximate values (for storage):**

| Power | Name            | Value                |
| ----- | --------------- | -------------------- |
| 2^10  | 1 Kilobyte (KB) | ~1 thousand bytes    |
| 2^20  | 1 Megabyte (MB) | ~1 million bytes     |
| 2^30  | 1 Gigabyte (GB) | ~1 billion bytes     |
| 2^40  | 1 Terabyte (TB) | ~1 trillion bytes    |
| 2^50  | 1 Petabyte (PB) | ~1 quadrillion bytes |

An easy trick: every 10 powers multiplies the value by about **1024** — which you can round to 1000 for mental arithmetic.

**Time numbers you will need constantly:**

| Unit    | In seconds                                       |
| ------- | ------------------------------------------------ |
| 1 day   | ~86,400 seconds (round to **~100,000**)          |
| 1 month | ~2.6 million seconds                             |
| 1 year  | ~31.5 million seconds (round to **~32 million**) |

"1 day ≈ 100,000 seconds" is the single approximation that will simplify the most calculations. (The real number is 86,400, but rounding to 100,000 makes mental division far easier, and the error is only ~15% — perfectly acceptable for this kind of estimate.)

**Latency numbers (roughly how long each operation takes):**

This table matters especially for you, because these numbers keep coming back in later modules (caching, databases).

| Operation                                      | Roughly            |
| ---------------------------------------------- | ------------------ |
| Read from memory (RAM)                         | ~100 nanoseconds   |
| Read from Redis / in-memory cache              | ~0.5–1 millisecond |
| Random read from SSD                           | ~0.1 millisecond   |
| Network round trip inside the same data center | ~0.5 millisecond   |
| An indexed query in PostgreSQL                 | ~1–10 milliseconds |
| Network round trip across continents           | ~150 milliseconds  |

**The most important takeaway from this table:** the gap between a memory read and a disk read is roughly **a thousand times**. That is the fundamental reason caching (Module 4) is such an important concept — reading the same data from memory instead of disk is a thousand times faster.

### 1.3 The General Estimation Process

To arrive at a number, you usually follow these steps:

```
1. Total users
        │
        ▼
2. Daily Active Users (DAU) — not everyone uses it every day
        │
        ▼
3. How many times per day each user performs the action
        │
        ▼
4. Total actions/day  →  requests per second (QPS)
        │
        ▼
5. Data per action  →  total storage / bandwidth
```

Let us work a concrete example with TaskFlow.

**Example: working out QPS for TaskFlow's notification feature**

Say the client has told you: "Target one million registered users."

**Step 1 — find the DAU:** not every registered user opens the app daily. A rough industry assumption is that DAU is usually 10–20% of total users (this varies enormously by product, but in an interview it is enough to state the assumption). Let us take 20%.

→ DAU = 1,000,000 × 20% = **200,000**

**Step 2 — how often does each user act:** say an active user assigns about 5 tasks a day (meaning 5 notifications generated).

→ Total notifications/day = 200,000 × 5 = **1,000,000 notifications/day**

**Step 3 — convert to QPS:** this is where "1 day ≈ 100,000 seconds" earns its keep:

→ QPS = 1,000,000 ÷ 100,000 = **~10 notifications/second (average)**

**Step 4 — peak QPS:** that is the average. But traffic is not flat across the day — heavier during office hours, lighter at night. A common rule of thumb: **peak QPS ≈ 2–3× average QPS**.

→ Peak QPS = ~10 × 3 = **~30 notifications/second**

That "~30 notifications/second" now tells you whether a single Express server can handle it (yes, easily — that is a tiny number) or whether you need a separate queue and scaling (not at this number; but if it were 30,000, you would).

**A storage example:**

Say each notification record holds an id, message text, timestamp, user_id, and a read/unread flag. Call it ~200 bytes per record (that number is a rough guess too; precision is not needed).

→ Daily storage = 1,000,000 notifications × 200 bytes = 200 million bytes = **~200 MB/day**

→ Yearly storage = 200 MB × 365 ≈ **~73 GB/year**

Looking at that number you can tell this is not a storage problem big enough to start thinking about sharding today (in Module 5.8 we will see when sharding is genuinely needed). But if the arithmetic had given you "73 PB/year", you would have had to think about storage strategy from day one.

> **Insight Table — What Goes Wrong Without Estimation**

| Situation                                  | Without estimation                          | With estimation                                                       |
| ------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| Building small scale with big architecture | More likely (over-engineering out of fear)  | The numbers show a simple architecture is enough                      |
| Building big scale with small architecture | More likely (when the guess is wrong)       | You know up front that sharding or a queue is needed                  |
| In an interview                            | "I think it'll scale" — vague, unconvincing | "30 requests per second; one server is enough" — concrete, convincing |

---

## 2. Interview Angle

The estimation step is often the scariest part of an interview, because candidates think "I have to give the exact number or I'll be wrong". In practice the interviewer **is not checking your arithmetic** — they are checking:

1. Can you take reasonable assumptions (and say them out loud)?
2. Can you use the number **in your next decision**, instead of stopping once you have it?
3. Are you working quickly and confidently, or getting stuck at every step?

One pattern that reads as confident: announce every assumption as you take it — _"I'm assuming DAU is 20% of total users; that's a common industry ballpark, and it could be different for your actual product."_ That tells the interviewer you know this is an **assumption**, not a fact — and lets them correct you if they want ("actually our DAU is 50%").

One more thing: the number you produce **must be used in the next step**. Stopping at "QPS = 30" is not enough — say "since QPS is only 30, a single server is sufficient and we don't need a load balancer yet". That is what makes estimation _actionable_ instead of just an exercise.

---

## 3. Key Takeaway

- The goal of back-of-the-envelope estimation is not precision, it is **the right order of magnitude**
- Use round numbers — 1 day ≈ 100,000 seconds makes mental arithmetic far easier
- Memory reads vs disk reads differ by roughly 1000× — that is the core reason caching matters
- The standard flow: total users → DAU → per-user actions → total actions/day → average QPS → peak QPS (2–3× average)
- Say every assumption out loud — that turns a "guess" into a "reasoned estimate" in an interview
- The number you produce must feed an architecture decision — stopping at the arithmetic is not enough

---

## 4. New Terms (Glossary)

| Term                         | Meaning                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| **DAU (Daily Active User)**  | Of all registered users, those who genuinely use the app on a given day                     |
| **QPS (Queries Per Second)** | How many requests or queries hit the system per second                                      |
| **Peak QPS**                 | QPS during the busiest part of the day, usually several times the average                   |
| **Order of Magnitude**       | Roughly which range a number falls in (thousands, millions, billions) — not the exact value |
| **Bandwidth**                | How much data moves in a given time (usually measured in bytes/second)                      |

---

## 5. Reflection Questions

Think it through yourself first, then open the answer key.

1. If a memory read takes ~100 nanoseconds and an SSD read takes ~0.1 millisecond, **how many times slower** is the SSD? (Show the arithmetic.)
2. For TaskFlow's file attachment feature (remember it from the Lesson 1.1 exercise?) — if DAU is 50,000, each active user uploads 2 files a day on average, and each file averages 5 MB, roughly how much does storage grow per day (in GB)?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** 100 nanoseconds = 0.0001 millisecond. The SSD takes 0.1 millisecond. So the SSD is 0.1 ÷ 0.0001 = **1000 times slower**. That is the "memory vs disk ≈ 1000×" rule from the lesson.

**Question 2:** Daily uploads = 50,000 × 2 = 100,000 files. At 5 MB each, that is 100,000 × 5 MB = 500,000 MB = **500 GB/day** (since 1000 MB ≈ 1 GB). From that number you can see this reaches roughly ~180 TB in a year, which is definitely not something to keep on a single server's local disk — you need object storage like S3 (Module 8.1), and this estimate is exactly what justifies that decision.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

Your turn. Work the whole estimation chain for the scenario below, showing every step (including your assumptions).

> **Scenario:** A new feature is coming to TaskFlow — an "**Activity Log**": every time a task is created, updated, or deleted, a log entry is written (who did it, when, and what).
>
> Assume:
>
> - Total registered users: 500,000
> - You choose the DAU assumption yourself (and say why)
> - You also pick a reasonable number for how many task actions (create/update/delete combined) an active user performs per day
>
> Calculate:
>
> 1. How many log entries per day?
> 2. What is the average QPS (for log writes)?
> 3. What is the peak QPS (using the 2–3× rule)?
> 4. If each log entry averages 300 bytes, how much does storage grow per day (in MB or GB)?
> 5. Looking at those numbers, do you think a single PostgreSQL instance can absorb this write load, or would you need something else (a queue, batched writes)? Give one line of reasoning.

Write your assumptions out explicitly at every step — that is the most important part, not the final number.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2
Current: 1.3 — Back-of-the-envelope Estimation
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth
Weak spots: mixing up solution and constraint in functional/non-functional (improving);
showing UI state as a component in the HLD (happened in the Lesson 1.2 exercise) — keep watching
Next: 1.4 — Client-Server, HTTP/HTTPS, connection lifecycle, keep-alive, HTTP/2 vs HTTP/3
=======================
```

---

## 8. Next Lesson

Send the exercise over — I will be looking especially at whether you state your assumptions clearly, and whether question 5 gets you from numbers to a decision. When you are ready, write `next` — we move to Lesson 1.4, going right inside client-server communication: how HTTP works, what the connection lifecycle is, and why newer versions like HTTP/2 and HTTP/3 exist at all.
