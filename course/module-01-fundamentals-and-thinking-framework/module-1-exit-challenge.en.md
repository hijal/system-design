# Module 1 — Exit Challenge

**Module 1 — Foundations of Scalability and System Design Principles**

That is all six lessons of Module 1. Until now we have learned concepts in pieces — trade-off thinking, the five-step framework, estimation, the connection lifecycle, latency and availability, scaling. In this exit challenge you have to apply all of those pieces **together, in one complete mini-design** — exactly as you would in an interview or in real work, without them being conveniently split into separate lessons.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow's client comes to you one day:
>
> "We want a new feature: a **'Daily Digest'** — every morning at 8am, each user gets an email summarising yesterday's task activity (which tasks were created, which were completed, which ones they were assigned)."
>
> Assume TaskFlow now has 50,000 registered users (the same figure as Lesson 1.6; feel free to pick your own number instead, just say what it is).

Your job — design this feature using the complete **five-step framework** (Lesson 1.2). At every step, try to apply what you have learned so far:

**Step 1 — Requirements + Scope**

- Separate functional from non-functional requirements (Lesson 1.1) — remember, "how we'll send it" (an email service, a queue) is a _solution_, not a requirement
- State what you are leaving out of today's scope

**Step 2 — Estimation**

- Assume a DAU (and state the assumption — Lesson 1.3)
- How many emails have to go out per day in total?
- There is a special challenge here that has not come up before — this work is not a request load spread evenly through the day; it has to **go out to every user at once, at 8am**. What would you call this kind of traffic pattern, and why does it need to be thought about differently from normal API traffic? Answer in one line. (We have not formally covered this in a lesson yet — reason it out yourself; being wrong is fine.)

**Step 3 — High-Level Design**

- Draw a simple ASCII diagram (beyond client/server/DB, what new component do you think sending email might need? Show it as a "black box" without going into detail)

**Step 4 — Deep Dive**

- Which part of this feature do you think is most worth a deep dive (where the most challenge or trade-off lives), and why? Use the "which part do I pick" criteria from Lesson 1.2 to judge

**Step 5 — Trade-off**

- Compared to login or task creation, what availability and latency targets do you think this "Daily Digest" feature should have, and why? (Apply the reasoning from Lesson 1.5 — does it block every user? How strict does the timing need to be?)

**One piece of guidance:** based on the trend in your earlier exercises — after finishing each step, reread your answer and check that you gave exactly what the question asked, and that no step or sub-part got skipped. That habit has been your main improvement area over the last few lessons.

I will critique this exactly as before — step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

Assess yourself honestly:

- [ ] I can explain to someone else why a system design answer is not "correct" but "trade-off based"
- [ ] I can separate functional from non-functional requirements, and I do not confuse a "solution" with either of them
- [ ] I can recite the five-step design framework and know what belongs in each step and what does not
- [ ] I can run the whole estimation chain — from DAU through QPS, storage, and peak load — with stated assumptions
- [ ] I understand how the TCP handshake, TLS handshake, and keep-alive contribute to latency
- [ ] I know why p99 latency matters more than the average, and I can calculate what the "nines" (99.9%, 99.99%) mean in real downtime
- [ ] I understand how SLA, SLO, and error budget relate, and how they are used in engineering decisions
- [ ] I can explain vertical vs horizontal scaling, and why a stateless architecture is a prerequisite for horizontal scaling
- [ ] Given an architecture, I can say whether it is stateful or stateless, and why

If any box feels shaky, do not worry — all of this gets applied repeatedly in Modules 2 and 3, and you will get another chance to solidify it. But if more than three boxes feel genuinely stuck, say so — we can do a `recap` before starting a new module.

---

## 3. Recommendation

**To read:**

- _"Designing Data-Intensive Applications"_ by Martin Kleppmann — Chapter 1 ("Reliable, Scalable, and Maintainable Applications"). This book comes up repeatedly throughout the course, especially in Modules 5 and 6. Chapter 1 takes today's reliability and scalability concepts a step deeper.

**To watch or browse:**

- The SLO and error budget chapters of Google's SRE (Site Reliability Engineering) book, available free online — you will see today's Lesson 1.5 concepts in exactly the industry-standard language (free at sre.google/sre-book).

**For a project:**

- In your own time (outside the course) — take any Node.js app you have deployed before and think it through: is it stateful or stateless? If you ran multiple instances in PM2 cluster mode, where would session or in-progress data live — in the process's memory, or outside it? Auditing that is a good practical exercise, though it is not an official course exercise.

---

Send the exit challenge over and I will critique it. After that, write `next` and we move to **Module 2: Networking & Communication**, starting with Lesson 2.1 — how DNS works, and the whole journey from typing a URL to the response arriving (in 1.4 we only mentioned "DNS lookup" as a step without opening it; now we open it fully).
