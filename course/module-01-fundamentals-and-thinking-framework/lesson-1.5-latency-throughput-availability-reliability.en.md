# Lesson 1.5 — Latency, Throughput, Availability, Reliability + SLA / SLO / Error Budget

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.2):** In a high-level design (HLD), what does a "box" actually represent — and what kind of thing should **not** be shown as a box? (Remember, this is exactly where a mistake crept into the Lesson 1.2 exercise.)

> **Module Recap (Lessons 1.1–1.4):** System design means choosing trade-offs (1.1) → there is a five-step framework for all of it: Requirements → Estimation → HLD → Deep Dive → Trade-off (1.2) → how to work the numbers: DAU, QPS, storage (1.3) → what stages a request passes through from client to server, and why connection reuse matters (1.4). Today, on top of all that, we learn the **language** you use to describe how good a system is — precisely, in numbers.

---

**Prerequisite:** Lesson 1.1, 1.2, 1.3, 1.4

**By the end of this lesson you will be able to:**

1. Explain the difference between latency and throughput, and understand why knowing p99 latency matters more than knowing the average.
2. Distinguish availability from reliability (a system being "up" does not mean it is trustworthy), and calculate what the "nines" (99.9%, 99.99%) mean in real downtime.
3. Explain how SLA, SLO, and error budget relate to each other and how they are used in engineering decisions.

**Tier:** 3 — Design Exercise

---

## 0. Where TaskFlow Is Right Now

Say TaskFlow has grown a bit, and one day the client comes to you: "The app feels slow sometimes, and yesterday it was completely down for five minutes. This needs fixing."

You ask: "Slow means exactly how slow? And was that outage within some acceptable limit, or did it break a contract?"

The client pauses, because there is no definite answer. And that is the problem — you are both using the words "slow" and "down", but neither of you can give them a **measurable definition**. In engineering you cannot make decisions out of "feels slow" — you need specific numbers and specific words. This lesson builds exactly that language.

---

## 1. Theory

### 1.1 Latency — How Long a Single Request Takes

**Latency** is the time from sending a request to receiving a response. In Lesson 1.4 we saw the stages inside it (DNS, TCP handshake, TLS handshake, processing, response) — latency is the sum of all of them.

But there is an important trap here: **average latency often paints a false picture.**

Say that out of 100 requests, 99 take 50ms but one takes 5 seconds (perhaps the database was locked during that request). The average comes out around 99.5ms, which looks "reasonably fine". But in reality **the user who got that 5-second request had a terrible experience** — and the average hid it.

This is why engineers use **percentiles** instead of averages:

- **p50 (median)** — 50% of requests finish within this time or less
- **p95** — 95% of requests finish within this time (i.e. excluding the worst 5%)
- **p99** — 99% of requests finish within this time (excluding the worst 1%)

```
Sorting request latencies from smallest to largest:

[■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■]────►
50ms                                    p50                p95         p99            5000ms
                                        (~55ms)           (~150ms)   (~800ms)      (worst outlier)
```

**Talking about p99 latency is standard in both interviews and production**, because it tells you how your **worst-served users** are doing — and in a large product, even 1% of users means thousands of people.

### 1.2 Throughput — How Much Work the System Can Do

**Throughput** is how many requests a system can process per unit of time (usually measured in requests per second — the QPS from Lesson 1.3).

Note carefully: **latency and throughput are not the same thing**, even though both relate to "speed". An analogy:

> At a toll plaza with a single booth, each car takes 5 seconds to pay (that is latency). In one minute, 12 cars get through that booth (that is throughput). Now add three more booths: each car's latency is still 5 seconds (paying did not get faster), but throughput rises to 48 cars/minute — because four cars are being processed at once.

The important lesson: **reducing latency and increasing throughput demand different kinds of solutions.** To reduce latency you make each individual request faster (caching, a faster query, fewer network hops). To increase throughput you add parallelism (more servers, more workers) — and sometimes doing so slightly _increases_ individual latency (because of batching, which we will see in Module 7).

> **Trade-off insight:** Batching is a good example of trading latency away for throughput. Instead of processing each request the moment it arrives, you collect 100 and process them together: total work per second goes up, but the first request now waits for the other 99, so its own latency goes up. That is the classic latency vs throughput trade-off — pushing hard in one direction always concedes something in the other.

### 1.3 Availability — How Much of the Time the System Is "Up"

**Availability** is measured as:

```
Availability = Uptime / (Uptime + Downtime)
```

It is usually expressed as a percentage, and the industry talks about it in terms of how many "nines" it has — because each extra nine cuts the allowed downtime by roughly 10×.

> **The Nines Table — allowed downtime per year**

| Availability | Common name   | Downtime per year | Downtime per month |
| ------------ | ------------- | ----------------- | ------------------ |
| 99%          | "two nines"   | ~3.65 days        | ~7.3 hours         |
| 99.9%        | "three nines" | ~8.76 hours       | ~43.2 minutes      |
| 99.99%       | "four nines"  | ~52.6 minutes     | ~4.3 minutes       |
| 99.999%      | "five nines"  | ~5.26 minutes     | ~26 seconds        |

This table is worth memorising — interviewers often ask "what availability target is reasonable for your design?", and being able to state both the number and what it means in practice ("99.99% means only 52 minutes of downtime a year") is a strong signal.

**An important reality:** each additional nine is exponentially more expensive and complex. Going from 99% to 99.9% is relatively easy (make a single server redundant), but going from 99.99% to 99.999% takes multi-region deployment, automated failover, extensive monitoring — a great deal (all of which we cover in Module 10). So **targeting "five nines" for every system is a mistake** — an internal team tool like TaskFlow may be fine at 99.9%, while that would be inadequate for a payment gateway. This brings back the Lesson 1.1 point: over-engineering is a mistake too, not only under-engineering.

### 1.4 Reliability — Being Available Does Not Mean Being Correct

Here comes a subtle but important distinction. **Reliability** means the system is doing its expected job **correctly**, not merely "responding".

Think about it: TaskFlow's server is running, accepting requests, returning HTTP 200 — by every measure "available". But suppose the response contains the wrong data (perhaps a bug is showing one user another user's task list). That system is **available but not reliable**.

```
Available + Reliable    →  up and answering correctly            (the ideal)
Available + Unreliable  →  up, but returning wrong/corrupt data  (dangerous — hard to notice)
Unavailable             →  not responding at all                 (obvious, so caught quickly)
```

This distinction matters because **an unreliable but available system is often the more dangerous one** — monitoring does not catch it easily (the server shows as "up"!). This is exactly why checking "is the server running" is not enough — in Module 10.4 (Observability) we will see how to monitor correctness, not just uptime.

### 1.5 SLA, SLO, and Error Budget — How They Work Together

Now we arrive at the formal language companies use to write these commitments down.

**SLA (Service Level Agreement)** — an **external, contractual promise**, usually between a company and its customers. A cloud provider might say "we guarantee 99.9% uptime; below that, you get bill credits." Money can be attached (penalty clauses) — this is a legal and business document, not just an engineering target.

**SLO (Service Level Objective)** — an **internal engineering target** the team sets for itself. Importantly, **an SLO is usually stricter than the SLA**. Why? Because you want missing your internal target to mean "a warning", while missing the SLA means "refunding customers" — keeping a buffer between the two is sensible, so that problems surface at the SLO and you have time to fix them before the SLA breaks.

```
                     SLA (customer-facing promise) — e.g. 99.9%
                              ▲
                              │  (safety margin)
                              │
                     SLO (internal target) — e.g. 99.95%
                              ▲
                              │  (this gap is monitored via the SLI)
                              │
                     SLI — what is actually measured (the real metric)
```

_(A small note: SLI stands for "Service Level Indicator" — the actual measured number that tells you whether the SLO is being met. For example, "actual availability over the last 30 days was 99.97%" is an SLI. We are not counting it as a separate glossary term, but you need the context to understand SLOs.)_

**Error Budget** — the most practical and interesting concept here. If your SLO is 99.9% (meaning you must work correctly 99.9% of the time), then the remaining **0.1%** is your "error budget" — your **permitted amount of failure**.

This idea (popularised largely by Google's SRE practice) gives engineering teams a practical decision-making tool:

- If the error budget is **still available** (not much downtime this month) → the team can ship features quickly and take a little risk
- If the error budget is **exhausted** (lots of downtime or errors this month) → the team pauses feature releases, focuses on stability, and holds back risky deployments

```
Error Budget = 100% - SLO target
If SLO = 99.9%, then Error Budget = 0.1%

Over a 30-day month, 0.1% of error budget = ~43 minutes of "allowed failure" per month
```

This matters because it moves reliability away from a **binary "perfect vs broken"** idea and turns it into a **measurable, budgetable resource** — just as you have a budget for money, you have a budget for "how much failure is allowed", and you can make business decisions (feature velocity vs stability) with it.

> **Trade-off Table — SLA vs SLO vs Error Budget**

|                        | SLA                                    | SLO                           | Error Budget                                 |
| ---------------------- | -------------------------------------- | ----------------------------- | -------------------------------------------- |
| Who it is for          | External customers / contracts         | Internal engineering team     | An internal decision-making tool             |
| What happens if missed | Financial penalty, reputational damage | Internal alert, team explains | Pause feature releases, focus on reliability |
| Strictness             | Comparatively lenient                  | Stricter than the SLA         | Derived from the SLO                         |

---

## 2. Interview Angle

These concepts usually appear in an interview in this form:

> "What latency and availability targets would you set for this system, and why?"

A good answer's structure: first say what kind of system it is (real-time chat? a batch reporting tool?), then propose a reasonable target for that kind, and give specific numbers for both **p99 latency** (not average) and **how many nines** of availability. For example: "Since this is real-time chat, I'd target p99 latency under 200ms and availability at 99.9% — it's an internal tool, not a payment system, so the expensive infrastructure that five nines requires isn't justified here."

Another common follow-up: "How does the error budget concept help decision-making?" — your answer should say that it gives an **objective, data-driven** way to answer "when is it safe to take risk and when is it not", instead of relying on gut feeling.

---

## 3. Key Takeaway

- **Latency** = time for a single request. Averages mislead — use **p99**, because it shows the state of your worst-served users
- **Throughput** = how much work the system does per unit time (QPS). Latency and throughput are different — parallelism can raise throughput without lowering latency
- **Availability** = how much of the time the system is "up". Each extra "nine" cuts allowed downtime ~10× and costs exponentially more
- **Reliability** = whether the system is doing its job correctly; being "up" is not enough. Available-but-unreliable systems are often the most dangerous, because they are hard to detect
- **SLA** = external, contractual promise (penalties can be attached)
- **SLO** = internal target, usually stricter than the SLA (to keep a buffer)
- **Error budget** = 100% − SLO target; a measurable "allowed amount of failure" used to decide between feature velocity and stability

---

## 4. New Terms (Glossary)

| Term                              | Meaning                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| **Latency**                       | The time it takes for a single request to complete                        |
| **Throughput**                    | How many requests a system can process per unit of time                   |
| **Availability**                  | How much of the time the system responds usefully (uptime / total time)   |
| **Reliability**                   | How correctly the system does its job, not merely whether it responds     |
| **SLA (Service Level Agreement)** | An external, contractual promise made to customers                        |
| **SLO (Service Level Objective)** | The team's internal target, usually stricter than the SLA                 |
| **Error Budget**                  | Derived from the SLO — the measurable amount of failure that is permitted |

---

## 5. Reflection Questions

Think it through yourself first, then open the answer key.

1. Your API's average latency is 80ms, but its p99 latency is 3 seconds. What would you suspect from that gap?
2. A company claims their system is "available" — the server always responds, HTTP 200 comes back. How would you verify it is genuinely "reliable" and not merely "available"?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Such a large gap between the average and p99 (80ms vs 3000ms) says **most requests are fast, but a small slice (~1%) is very slow for some reason**. That usually points to a specific edge case or resource contention — certain queries getting stuck on a database lock, a particular user's dataset being unusually large (the N+1 query problem, which we cover in Module 5.6), or periodic garbage collection pauses. The key insight is that the gap itself tells you the problem is _not_ evenly spread — it happens under some specific condition, which is what you need to find.

**Question 2:** To verify reliability you cannot only check "did a response come back" — you have to check **whether the content of the response is correct**. That needs synthetic monitoring (sending test requests with known inputs and comparing against expected outputs), error rate tracking (an HTTP 200 can still carry an error message in the body), and alerts on data correctness (for example, "task count suddenly dropped to 0" is suspicious even while the server is "up"). This deeper monitoring is covered in detail in Module 10.4.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** Propose availability and latency targets for three different kinds of TaskFlow feature. For each one give (a) the availability target (how many nines), (b) the p99 latency target, and (c) **one line of reasoning** — why that target is right for this feature (avoiding both over- and under-engineering):
>
> 1. **Login / authentication** — whether a user can get into the app at all
> 2. **Task creation** — creating a new task
> 3. **"Export to PDF" report** — downloading a monthly report as a PDF, which a user might use once a week
>
> Then, say you have set the SLO for task creation at 99.95%. For this month (calculate over 30 days), **how many minutes of error budget** does that give you? (Use the nines table and the formula from this lesson.)

Notice that the targets for these three features should be quite different, because the cost of failure differs for each. That is what will show you have understood why "five nines for everything" is the wrong approach.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2, 1.3, 1.4
Current: 1.5 — Latency, Throughput, Availability, Reliability + SLA/SLO/Error Budget
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth,
TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC, Latency, Throughput, Availability, Reliability, SLA, SLO, Error Budget
Weak spots: mixing up solution and constraint in functional/non-functional (improving);
treating UI state as a component in the HLD; taking assumptions without reading the
requirement carefully; a tendency to use vague words in reasoning ("might go wrong",
"could break") — the habit to build is naming a concrete mechanism
Next: 1.6 — Vertical vs Horizontal Scaling, Stateless vs Stateful
=======================
```

---

## 8. Next Lesson

Send the exercise over — I will be looking especially at whether the reasoning behind each feature's target holds up, and whether the error budget arithmetic is right. When you are ready, write `next` — we move to Lesson 1.6, the last lesson of Module 1: vertical vs horizontal scaling, and stateless vs stateful. These two concepts are the foundation for every module that follows (load balancing, caching, database scaling).
