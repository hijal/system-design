# Lesson 1.1 — What is System Design, Why Learn It, and How Engineers Think

**Module 1 — Foundations of Scalability and System Design Principles**

**Prerequisite:** None (this is the very beginning)

**By the end of this lesson you will be able to:**

1. Explain in your own words what "System Design" actually is, and how it differs from "writing code".
2. Understand how a small, perfectly working system turns into a "system design problem" as it grows.
3. Tell functional and non-functional requirements apart, and explain why that distinction is the foundation of all design.

**Tier:** 3 — No code today, pure thinking exercise. (Coding starts once the theory has some ground under it.)

> **Spaced repetition note:** Since this is the first lesson, there is nothing earlier to ask about. This starts from Lesson 1.2.

---

## 0. Where TaskFlow Is Right Now

Say you have built TaskFlow — a team task management app. An Express server on the backend, a PostgreSQL database, Sequelize as the ORM. SvelteKit on the frontend. About 100 people use it — one small startup team. Everything runs smoothly. `npm start` brings the server up, queries reach the database, responses come back in 20–30 milliseconds. You are happy, and so are your users.

Now the client says: "We like this app. We want to grow it. Target: one million users in the next six months."

And here is the real question: **can the code you have today handle a million users?**

The answer is almost certainly no. But understanding _why_ not is the work of this lesson. Today we will not write any code and we will not fix anything. Today we will only understand **what question this thing called "system design" actually answers** — and why it is a completely different kind of thinking from the "coding" you have learned so far.

---

## 1. Theory

### 1.1 Coding vs System Design — Where Exactly the Difference Lies

When you code a feature — say, "assign a task" in TaskFlow — your questions are:

- What are this function's inputs and outputs?
- What should the database schema look like?
- How do I handle edge cases (an empty title, a double click)?

Every one of these questions has a **specific, fixed answer** — you write the code and it either "works" or it "doesn't".

System design questions are of a completely different kind:

- What happens if this feature is called **10,000 times a second**?
- If the server **suddenly dies**, does the user lose data?
- If we add **a second server**, will both servers see the same data?
- What will this system **cost per month**, and how does that cost grow as users grow?

Notice — none of these have one "correct" answer. Every answer carries a **cost** and a **trade-off**. System design means **choosing the most reasonable option among several incomplete, mutually conflicting solutions, based on your constraints (time, money, team size, user needs) — and being able to explain why you chose it.**

This is exactly why there is no "right answer" in a system design interview. The interviewer wants to see **how you think**, not just what you conclude.

### 1.2 What Can Break Inside a Simple System

Here is TaskFlow as an ASCII diagram:

```
[Browser/Client] ---- HTTP request ----> [Express Server] ---- SQL query ----> [PostgreSQL]
       <---------- HTTP response -----------------<---------- result ------------
```

At 100 users this picture is flawless. But think about how many **hidden assumptions** are buried in this one diagram:

1. **The server is always up** — but what if it crashes? Does the user lose everything at that moment?
2. **The server can handle every request at once** — but what if 50,000 requests arrive in one second?
3. **The database always answers fast** — but what happens when the data grows from 100 rows to 10 million?
4. **The network between client and server always works** — but what about delay or packet loss?
5. **One server, so the data is always consistent** — but with two servers, which one holds the "correct" data?

At 100 users these questions feel "theoretical", because the probability is so low that the problem never shows up. But as the user count grows, those "theoretical" problems turn into **real, routine events**. That is what **scale** actually means — the numbers grow until things that "would never happen" now "happen every day".

> **Trade-off table — Simple Architecture vs Scalable Architecture**

| Dimension                   | Simple (one server, one DB)                | Scalable (multi-server, distributed) |
| --------------------------- | ------------------------------------------ | ------------------------------------ |
| Time to build               | Low                                        | High                                 |
| Operational complexity      | Low                                        | High (harder to monitor and debug)   |
| Cost (few users)            | Low                                        | High — money spent for nothing       |
| Cost (many users)           | The system collapses, or cost grows wildly | Grows in a controlled way            |
| What happens during failure | The whole system goes down                 | Part goes down, the rest keeps going |

And here is the first big lesson: **"scalable architecture" is not always "better".** Building an app for 100 users with Netflix's architecture is just as much a design mistake as building an app for 10 million users on a single server. The job of system design is **to stand in the right place for your actual constraints** — over-engineering and under-engineering are equally dangerous. That is precisely why this whole course evolves TaskFlow step by step: so you can see _which problem_ brings _which solution_, instead of piling everything on from day one.

### 1.3 Functional vs Non-functional Requirements

The first job in system design is to split a system into two views:

- **Functional requirements** — what the system _does_. For example: "a user can create a task", "a user can assign a task". This is the territory you already know from coding.
- **Non-functional requirements** — _how_ the system does it. For example: "the response must arrive within 200ms", "the system must be available 99.9% of the time", "it must handle 10,000 concurrent users".

A coding interview works mostly on functional requirements — "build this feature". A system design interview works mostly on non-functional ones — "run this feature for 10 million users, at 99.99% uptime, within 100ms". **It is the non-functional requirements that actually drive every architectural decision** — and that is the single most important mindset shift to start building in yourself today.

---

## 2. Interview Angle

In a system design round the interviewer usually gives you an open-ended prompt — "Design a URL shortener" or "Design TaskFlow for 1 million users". The most common mistake among people who do badly in this round is **starting to draw architecture immediately**, without clarifying requirements first.

What the interviewer actually wants to see:

1. Do you **ask questions first** — to pin down functional and non-functional requirements? (For example: "How many users are we expecting?", "Is this read-heavy or write-heavy?")
2. Can you **state trade-offs**, instead of just saying "I'll use this tool" — explaining why that tool, and what you would give up by choosing something else?
3. Can you **communicate** — make what is in your head clear to someone else?

Here is the interesting part: in this round, naming the "correct architecture" is the least important thing. A junior and a senior engineer can propose the same architecture, but the senior can explain far better **why** they chose it and which trade-offs they accepted. Throughout this course we will build both things together — **the theory**, and **the ability to put it into words**.

---

## 3. Key Takeaway

- System design is not about finding "the right answer" — it is about choosing trade-offs that fit your constraints
- A coding question's answer "works or doesn't"; a design question's answer "works at what cost"
- A simple system hides many assumptions that break once scale arrives
- Scale means: what used to "almost never happen" is now "a regular event"
- Over-engineering (more complex than needed) and under-engineering (built without thinking about scale) are both bad design
- Functional requirement = what the system does; non-functional requirement = how it does it (speed, availability, scale)
- In an interview, clarifying requirements and explaining trade-offs matters more than the architecture itself

---

## 4. New Terms (Glossary)

| Term                           | Meaning                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **System Design**              | The process of deciding how to structure a software system so it works within given constraints (scale, cost, reliability) |
| **Scale / Scaling**            | The growing pressure on a system as users, data, or traffic increase — and the ability to absorb that pressure             |
| **Trade-off**                  | Giving something up in order to gain something else (for example, accepting more complexity to gain speed)                 |
| **Functional Requirement**     | A description of what the system does                                                                                      |
| **Non-functional Requirement** | A description of the performance, reliability, and scale at which it does it                                               |

---

## 5. Reflection Questions

Think it through yourself first, then open the answer key.

1. TaskFlow runs perfectly at 100 users — one Express server, one Postgres. If a million users suddenly arrived, **what do you think would break first**, and why?
2. If someone asked you to "design TaskFlow", what are the first **three questions** you would ask the client or interviewer before drawing any architecture?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Usually the **database connections** break first. Postgres has a default connection limit (typically around 100). Even if a million users are not all online at once, a few thousand concurrent requests — each holding a DB connection — will exhaust the connection pool, and new requests will either error out or wait a long time. After that, the single server's CPU and memory go: there is a hard limit to how many concurrent requests one Node.js process can handle.

**Question 2:** Good questions would be: "How many users are we expecting, and how quickly do we reach that number?", "Is this read-heavy or write-heavy — will users mostly view tasks, or mostly create and update them?", "How much downtime can the system tolerate — five minutes, or five seconds?" The answers to these are exactly what real architectural decisions are built on — which is what the next lesson (1.2, The Design Framework) covers in detail.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

Read the scenario below, then answer. I am not giving a model answer up front — I will critique yours after you try.

> **Scenario:** TaskFlow's client tells you: "We want real-time notifications in TaskFlow — when someone assigns you a task, you should know immediately, without reloading the page."
>
> From that single line of requirement:
>
> 1. Write down the **functional requirements** hiding in it (at least two).
> 2. Write down the **non-functional requirements** that might apply — the ones the client never said out loud but implicitly expects (at least three — for example, how fast the notification must arrive, how many users can be online at once, and so on).
> 3. Of those three non-functional requirements, which do you think will influence the architecture the most, and why?

Send me your answer. I will be looking at whether you can genuinely separate functional from non-functional requirements, or whether you are still mixing up "feature list" with "requirements". That confusion is a very common junior-level mistake, and catching it is the real point of today's exercise.
