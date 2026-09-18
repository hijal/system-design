# Lesson 1.2 — The Design Framework

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.1):** What was the core difference between answering a system design question and answering a coding question? (One line.)

---

**Prerequisite:** Lesson 1.1

**By the end of this lesson you will be able to:**

1. Approach any system design question through a fixed five-step structure, instead of randomly starting to draw architecture.
2. Understand why setting "scope" is the single most important first move, and what goes wrong without it.
3. Explain why discussing trade-offs is mandatory before declaring a design "done".

**Tier:** 3 — Design Exercise (no code today either; this framework has to settle into your bones first, then code-adjacent material starts from Lesson 1.4)

---

## 0. Where TaskFlow Is Right Now

Over the last two lessons we played with two separate TaskFlow feature requests — real-time notifications and file attachments. Each time we started by separating functional from non-functional requirements. But did you notice how **scattered** that felt? Sometimes I never asked for a scenario and you built the list yourself. In a real interview — or in real sprint planning — "write down whatever comes to mind" does not hold up: things get missed, and other things get far more detail than they deserve.

Today we will bind that scattered process into a **fixed, repeatable structure**. This structure is the backbone of the entire course — every case study in Module 11 (URL shortener, chat system, and the rest) and every mock interview in Module 12 runs on these same five steps. Understand it properly once, and for the rest of the course you will always know "which step am I on right now".

---

## 1. Theory

### 1.1 Why You Need a Framework

Think about it: when a doctor sees a patient, do they immediately say "you need this medicine"? No. They ask about symptoms, take a history, run an examination, then diagnose, then prescribe. Shuffle those steps and the odds of the wrong treatment go up enormously.

System design works exactly the same way. Starting to draw an architecture straight away is "prescribing without hearing the symptoms". That is why you need a framework — so that every time, for every system, you follow the same disciplined process and no important step falls through.

### 1.2 The 5-Step Framework

```
┌─────────────────────┐
│ 1. Requirements     │  what to build, how it must behave — set the scope
│    Gathering        │
└──────────┬──────────┘
           │
┌──────────▼───────────┐
│ 2. Capacity          │  the numbers — how many users, how much data, how much traffic
│    Estimation        │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ 3. High-Level Design │  big boxes and arrows — client, server, DB, cache...
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ 4. Deep Dive         │  go deep on one or two critical pieces
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ 5. Trade-off &       │  what you gave up, what could break later
│    Wrap-up           │
└──────────────────────┘
```

Let us walk through each step.

### Step 1 — Requirements Gathering

This is the work we did in the last two lessons — pulling out functional and non-functional requirements. But something new gets added here: **setting the scope**.

A real system (even a small imaginary app like TaskFlow) can have endless features. In a 45-minute interview — or in real sprint planning — you cannot design all of it. So the first job is to state clearly **what you will design today and what you are leaving out**.

For TaskFlow's notification feature, you might say:

> "Today we will design only the 'notify on task assignment' flow. Email digests and notification preference settings are out of scope for now."

That single sentence is what keeps you **focused** for the remaining 44 minutes. Start without stating scope and you will find, halfway through, that time is gone and you never touched the actual problem.

> **A common interview trap:** Interviewers often hand you a deliberately vague prompt ("Design Twitter"). People who do badly start designing immediately. People who do well narrow the scope first — "Twitter is a big surface; shall we focus on the core flow of posting a tweet and viewing a timeline?" Saying that tells the interviewer: I understand why scope matters.

### Step 2 — Capacity Estimation (Back-of-the-envelope)

Once the requirements are settled, the next question is: **how big is this actually?** The architecture for 100 users and for 10 million users is completely different. So you work out rough numbers:

- How many users (daily active)?
- How many requests per second?
- How much data gets stored, per day and per year?

This step has a whole lesson of its own (1.3, the very next one) because it is a skill you have to practise. For today, just hold on to this: **after Step 1 and before drawing architecture, you estimate the numbers roughly.** Those numbers are what will drive your decisions in the next step — one server or ten, cache or no cache.

### Step 3 — High-Level Design

Now comes the drawing — client, server, database, and the arrows between them. In this step, **going into detail is forbidden**. The goal is to stand up a bird's-eye view of the whole system that satisfies the requirements from Step 1.

A very basic high-level design for TaskFlow notifications might look like this:

```
[Client (SvelteKit)] <---> [Express API Server] <---> [PostgreSQL]
                                    │
                                    ▼
                          [Notification Service]
                                    │
                                    ▼
                          [How does this reach the client?]
```

Notice that the last box is still a question mark. That is fine at this step — we do not yet know whether we will use WebSocket or polling. That gets decided next.

### Step 4 — Deep Dive

The high-level design gave the system a shape, but most of the boxes are still black boxes. In this step you (or the interviewer) pick **the one or two most important or complex pieces** and go inside them.

For TaskFlow, the deep dive would be exactly that question-mark box — "how does the client receive a real-time notification?" Here you would compare WebSocket vs Server-Sent Events vs polling, state the trade-offs of each, and choose one.

**Important:** You cannot go equally deep on everything, and you do not need to. You choose — which part is the most "risky", the most "interesting", or the one with the most trade-offs. The rest stays high-level, and that is fine.

### Step 5 — Trade-off & Wrap-up

In the last step you come back and say, honestly:

- Where is this design weak?
- Where could problems show up later (say, as users grow)?
- What alternative did you not choose, and why?

This step often gets dropped for lack of time, but it is **the one that shows senior thinking most clearly**. A junior engineer hands over a design and thinks "done". A senior engineer knows **no design is perfect**, and being able to say that explicitly is the mark of skill.

> **Trade-off Table — What You Lose by Skipping Each Step**

| Skipping this step | What goes wrong                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- |
| Requirements       | Risk of designing the wrong thing — wasted time                                     |
| Estimation         | Architecture that does not match the user count (over- or under-engineered)         |
| High-Level Design  | Diving into detail and losing the big picture                                       |
| Deep Dive          | The design stays shallow; the real challenge never gets addressed                   |
| Trade-off          | Claiming the design is "perfect" — exactly where senior interviewers get suspicious |

---

## 2. Interview Angle

This framework is also a **time management tool** for the interview. A 45-minute round splits roughly like this:

- Requirements + scope: ~5–7 minutes
- Estimation: ~5 minutes
- High-level design: ~10–15 minutes
- Deep dive: ~15–20 minutes
- Trade-off / wrap-up: ~5 minutes

The most common mistake: candidates burn 25–30 minutes on the high-level design (it is "fun", drawing boxes is easy) and leave no time for the deep dive. But **the deep dive is where your technical depth is actually tested**. Anyone can memorise a high-level design from a video; discussing trade-offs inside a deep dive cannot be memorised, and that is where real understanding shows.

That is why the curriculum has a separate lesson on the "ten most common mistakes" in Module 12.1 — but remember this now: **knowing the five steps is not enough, you have to practise the clock as well.** We will practise exactly that, with a timer, in the Module 12 mock interviews.

---

## 3. Key Takeaway

- Use the same five-step framework for any system design question: Requirements → Estimation → High-Level Design → Deep Dive → Trade-off
- The requirements step is not just splitting functional from non-functional — setting **scope** is mandatory; trying to design everything means time runs out and nothing gets done properly
- Estimation tells you how "heavy" the architecture needs to be — choosing architecture without knowing the numbers is deciding blind
- No detail in the high-level design — it is only the big picture
- In the deep dive, do not go equally deep everywhere; pick one or two of the most important pieces
- Skipping the trade-off discussion means falsely claiming the design is "perfect" — this step shows senior-level thinking more than any other
- Budget your time in an interview — most of it should go to the deep dive, not the high-level design

---

## 4. New Terms (Glossary)

| Term                                | Meaning                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| **Scope**                           | Which features and behaviours fall inside today's design, and which are deliberately excluded |
| **Back-of-the-envelope Estimation** | Quick, rough arithmetic — user counts, data size, traffic — without aiming for precision      |
| **High-Level Design**               | A simplified, detail-free picture of the system's main components                             |
| **Deep Dive**                       | A detailed, in-depth exploration of one specific part of the high-level design                |
| **Black Box**                       | A component whose internals are not yet decided — only its inputs and outputs are known       |

---

## 5. Reflection Questions

Think it through yourself first, then open the answer key.

1. If you sat down to "Design a URL Shortener" in Module 11, what would you leave out of today's scope in Step 1 (Requirements + Scope)? Give at least two examples.
2. In the deep dive step, how do you think you should decide "which part to pick"? What tells you that something is worth a deep dive?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Things you could cut from a URL shortener's scope: custom aliases (letting users pick their own short URL), analytics and click tracking, link expiration, and user authentication or accounts. The core flow is only: "give a long URL, get a short URL; click the short URL, get redirected." Everything else is nice-to-have that can be added later if time allows.

**Question 2:** Generally you pick where there is **the most trade-off, complexity, or uncertainty** — or whatever separates this particular system from a plain CRUD app. In a URL shortener, "how do I generate a unique short code without collisions, at scale" is the deep-dive-worthy question, because that is where the real engineering challenge lives. "How do I save it to the database" is not worth a deep dive, because it is trivial.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

This time you have to **apply** the whole five-step framework — not just Step 1, but a line or two of thinking for every step.

> **Task:** A new feature for TaskFlow — "**Search**: a user can search across all their tasks by title or description."
>
> Write one or two lines for each of the five steps:
>
> 1. **Requirements + Scope** — which functional and non-functional requirements you want, and what you are leaving out of today's scope
> 2. **Estimation** — roughly which numbers you would want to know (no precise arithmetic needed; just write down "what questions would I ask")
> 3. **High-Level Design** — a very simple ASCII sketch or a one-line description
> 4. **Deep Dive** — which part seems worth a deep dive, and why
> 5. **Trade-off** — what you think the weaknesses of this design might be

Remember — I am not expecting a "correct answer" here. What I am looking at is whether your **thinking process** follows the framework.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1
Current: 1.2 — The Design Framework
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation,
High-Level Design, Deep Dive, Black Box
Weak spots: a tendency to mix up "constraint" and "solution" when separating
functional from non-functional (seen in the 1.1 exercise) — improving now, but
consistency still needs watching
Next: 1.3 — Back-of-the-envelope Estimation (numbers every engineer should know)
=======================
```

---

## 8. Next Lesson

Send me the exercise and I will walk through each step to see whether the framework is really being followed. When you are ready, write `next` — we move to Lesson 1.3, going deep on the estimation step: which numbers are worth memorising (QPS, storage math, latency numbers), and how to do the arithmetic quickly in your head.
