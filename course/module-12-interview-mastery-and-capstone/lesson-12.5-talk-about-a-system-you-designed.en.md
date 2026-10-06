# Lesson 12.5 — "Tell Me About a System You Designed" — Preparation

**Module 12 — Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 10.6):** A production table's column needs to be renamed, with no downtime, and with the option to step back at any stage. List the expand/contract steps in order. In one of today's examples, the interviewer will ask exactly this question, about your own project: "How would you roll this out to production?"

**Prerequisite:** Lesson 12.1 (signal, rubric), Lessons 12.3 and 12.4 (the mocks and their scores), Lesson 6.3 (Read-your-writes, version token), Lesson 10.6 (Expand/contract, canary)

**By the end of this lesson you will be able to:**

1. Say what the question "tell me about a system you designed" really measures, and choose which of your projects is worth telling with a few criteria
2. Shape a project into a story of three lengths (30 seconds, 5 minutes, and a 20-minute deep version), each with a problem with a number, the alternatives considered, your decision, a measured result, and an honest mistake
3. Stay honest on the interviewer's ladder of "why?" (going four or five levels deeper on the same thing): keeping "I" and "we" apart, admitting a decision that wasn't yours, and not making up a number you don't remember

**Tier:** 3 — Design Exercise (no code; the deliverable is your "story bank": three-length stories for two projects, the depth ladder, and a 5-minute recording)

---

## 0. Where TaskFlow Is Right Now

This question comes up somewhere in almost every system design loop: sometimes as a separate round ("project deep dive"), sometimes in the middle of a behavioral round, sometimes at the start of the conversation with the hiring manager. And after two mocks it sounds easy: this time there's no unknown system, the system is your own.

That's exactly why people don't prepare. The first two minutes of two candidates on the same question:

**The first:**

> "We built an e-commerce platform. Node.js and Express on the backend, PostgreSQL as the database, Redis as the cache, RabbitMQ for the queue, all in Docker, deployed on AWS with ECS. React on the frontend. We followed a microservices architecture: user service, product service, order service, payment service... CI/CD on GitHub Actions..."

Interviewer: _"Which of these decisions did you make?"_

> "Well... the team lead set the architecture. I worked on the order service."

_"What was the hardest problem in the order service?"_

> "Everything ran fine, there wasn't really any big problem."

**The second:**

> "I was on the backend of a team task management app. Let me talk about one problem whose design I did. After we added Postgres read replicas to reduce read load, tickets started coming in to support: 'I created a task, it doesn't show up in the list.' Because of replica lag. At first I shipped a simple fix, which stopped the tickets, but was quietly destroying the point of the replicas: nearly three quarters of the reads were back on the primary. Then..."

The first named ten technologies in two minutes and gave not a single signal (12.1's mistake 4, this time on their own project). The second didn't list a single technology, but in two minutes the interviewer knows: which part they owned, what the problem was, that they made a mistake and are saying so themselves, and that there's a number in the story.

And you know the second one's story: it's TaskFlow's Lesson 6.3. At the end of this lesson we'll see how, without a big production project to talk about, TaskFlow can honestly be told as "a system I designed". And if you do have one, how to shape it into a story like this.

---

## 1. Theory

### 1.1 What this question really measures

In the design round the interviewer sees how you think about an **unknown** problem. In this question they see what you did on a **known** problem, and how true it is. Five things:

- **Ownership.** What your role was, which decisions were yours. In a story told entirely with "we", the interviewer doesn't know where you are.
- **Depth.** It's your own system, so the interviewer expects you to go several levels down into any box. That's harder than the design round, because here you can't say "let's assume": the system really was built one particular way.
- **Judgement.** Which alternatives you considered, and why you chose this one. "That's how it was" isn't judgement.
- **Results.** What changed, and how you knew. A measured number, before and after.
- **Honesty and learning.** What went wrong, and what you'd do differently now. The interviewer is looking here for whether you can see your own mistakes, and whether the CV's claims are true.

The last often carries the most weight. Writing "designed a scalable microservices architecture" on a CV is easy; keeping it standing through twenty-five minutes of questions isn't. This question is a truth check on the CV, and interviewers ask it knowing that.

The question comes in a few forms, and the preparation is the same for all: _"Tell me about a system you designed"_, _"Walk me through the architecture of your current system"_, _"What's the most technically challenging project you've worked on?"_, _"Tell me about a design decision you'd make differently today."_

### 1.2 Which project to tell

Most people choose the biggest or the newest project. The criteria for a good choice are different. Give every possible project a yes/no on the seven questions below:

| criterion                                         | why                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| was at least one real decision yours?             | the only source of the ownership signal. Implementing someone else's decision is a story, not a design |
| is there a number?                                | load, latency, cost, error rate — something measurable before and after                                |
| was there a trade-off?                            | an alternative you **didn't** take, with the reason                                                    |
| did something go wrong?                           | an honest mistake and what you learned; "everything went fine" is a weak story                         |
| can you draw it on a board, from memory?          | if not, the first follow-up will stop you there                                                        |
| can you go three levels down into any box?        | "why Redis?" → "which eviction?" → "what happened when it filled up?" — 1.4's ladder                   |
| can you tell it without breaking confidentiality? | does the story hold without client names, internal numbers, security details?                          |

Tell the project with the most "yes"es, even if it isn't big or new. A small system where you owned a decision, and know why you took it and what went wrong, is better than a huge system where you wrote one endpoint of one service.

**A word on confidentiality:** saying a former or current company's internal information in an interview (client names, revenue, security weaknesses, unpublished numbers) can break a contract, and an interviewer notices, not in a good way. Generalise names ("a fintech client"), give numbers as magnitudes ("a few thousand a second", "about a million users"), and leave out security details. The story's value is in the decisions, not the secrets.

### 1.3 The story's structure

**Design Narrative** — telling a project's design in a set order so that every part gives a signal: context → problem with a number → constraints → alternatives considered → the decision and why → measured result → what went wrong and what I'd change now. A relative of 12.1's five steps, only this time in the past tense, and with an extra part at the end: the learning.

```
 context ──► problem ──► constraints ──► alternatives ──► decision ──► result ──► mistake and lesson
 (1-2 sentences)  (a number!)  (time,      (at least       (I, why)      (before    (what I'd do
  what system,               team,        two)                          vs after)   differently now)
  my role                    cost)
```

Have this structure ready in **three lengths**, because how much time you get depends on where the question comes:

- **30 seconds** — the hiring manager's "tell me a bit about your project". Context, problem, decision, result, one sentence each. At the end leave a door open: "There was an interesting mistake here too, I can tell you about it if you like."
- **5 minutes** — most of the time. The whole structure, with a picture, with a mistake. Then stop and let the interviewer choose where to go deeper.
- **The 20-minute deep version** — a full "project deep dive" round. The 5-minute version, then going deeper into three or four boxes as the interviewer asks. The preparation for this isn't a story, it's a ladder (1.4).

**Impact Metric** — a measured number showing what your decision changed: before and after, on the same measure, and how it was measured. "Performance got much better" isn't a metric; "p99 from 800 ms to 120 ms, at the peak hour, from APM" is. If you don't remember it, don't make it up: "I don't remember the exact number, but it dropped roughly six or seven times, and we measured it at the peak's p99" — honest, and credible.

**Retrospective Insight** — "what I'd do differently if I did it again today", with the reason. This is the part of the story that gives the most senior signal, because it shows you can see your own work from the outside. There's only one rule: it has to be a real change, not something general like "I'd write better tests".

### 1.4 The depth ladder

**Depth Probe** — the interviewer's successive "why?"s or "and then?"s on the same subject, each one level below the last, until you reach the bottom of what you know. The goal isn't to trap you, it's to measure the depth of your knowledge: where "I know" turns into "I've heard".

An example, from TaskFlow's read-your-writes story:

```
level 1  "Why did you add replicas?"                       → read load; the primary's CPU at peak
level 2  "How big was the lag?"                            → a few ms on average, but now and then stuck for a few seconds
level 3  "Why would it get stuck for a few seconds?"      → a long query on the replica; Postgres pauses WAL replay
                                                            (max_standby_streaming_delay, up to 30 s by default)
level 4  "How did you find that out?"                      → the replay_lag graph, matched against the tickets' times
level 5  "So what was the replica lag alert based on?"    → not the average, the tail: replay_lag above a limit for a minute
```

Write this ladder for each big box in the story, at least four levels on three boxes. If you get stuck at a level while preparing, there are two paths: go and learn it (it's your own system, it can be learned), or settle the honest answer at that level. In the interview, when you reach the bottom, say: "Below this I'm not sure; my guess is X, and this is how I'd check." (12.1's "not knowing" sentence.) That isn't a bad signal. The bad signal is a made-up answer below the bottom, which falls apart on the very next level's question.

### 1.5 "I" and "we"

**Ownership Signal** — the evidence, in what you say, of which work or decision was specifically yours. The main tool is the pronoun: "we decided" has no ownership; "I wrote up two options and put them in front of the team, and argued for this one because..." does.

Three rules:

- **Your role in one sentence, right at the start.** "I was one of three on the backend, and the design and implementation of the replica routing was mine."
- **"I" for decisions, "we" for context.** Claiming the team's work as your own is as bad as hiding your own work in "we", because then the interviewer can't give you credit.
- **Admit a decision that wasn't yours, then give your view.** "Splitting into microservices predates my joining. This is how I understand it: ... and if I were making the decision today I'd keep order and payment together, because the distributed transactions between them gave us the most incidents." This is often an even stronger signal than a story about your own decision, because it shows you've thought about what you inherited.

### 1.6 Telling TaskFlow as your own system

For anyone who doesn't yet have a production project worth telling, or has one but had no real decision in it: over this course's eleven modules you took TaskFlow from one Express server to several services, queues, caches, replicas and two regions, each step with a problem and a measured exercise. That's worth telling.

**But there's one condition, with no exceptions: say honestly what it is.** "It's a learning project, built while learning system design; the numbers come from my own simulations and labs, not from production users." Passing it off as production, or saying "our users", is a lie that a single depth probe catches ("How many users were there? Which company?"), and after that everything else you said in the interview falls under suspicion.

Told honestly, its value isn't lower, just different. A production project's story shows what you did under real pressure. A learning project's story shows how you learn, and how deep you go, especially when you've measured the problems you created yourself. Many interviewers value the second too, especially early in a career or when changing domains. But the higher the level, the stronger the expectation of a production story; use TaskFlow accepting that.

**An example 5-minute story,** TaskFlow's read-your-writes, with the numbers from 6.3's exercise:

> **Context.** "While learning system design I built the backend of a team task management app, TaskFlow, and modelled and measured every scaling step myself. Let me talk about one step."
>
> **Problem.** "To reduce read load I added three async read replicas to Postgres. Then a problem: when a user created a task and went straight back to the list, the task didn't show up. In my replica model, where the lag is a few ms on average but now and then gets stuck for a few seconds, reading from a random replica meant users didn't see their own write about 29% of the time."
>
> **Constraints.** "Sending every read to the primary would defeat the whole purpose of the replicas. And the solution has to work on both clients, web and mobile."
>
> **Alternatives and the first decision.** "First I took the simplest one: a cookie if the user had written in the last 5 seconds, and with the cookie, read from the primary. On the same device the problem dropped to 0%."
>
> **The mistake.** "But two things got past me. One, the laptop doesn't see the phone's cookie, so on the other device the problem stayed almost the same as before. Two, and this is the big one: in this workload a few reads come right after a write, so within the cookie's window **73% of reads went to the primary**. The tickets stopped, but the replicas were almost useless."
>
> **The second decision.** "Then a version token: after every write, the primary's WAL position, kept on the server under the user's name, not on the device. A read goes to a replica that has advanced at least to that position, otherwise to the primary. Not seeing your own write dropped to 0% on both devices, and only 3.4% of reads went to the primary."
>
> **The lesson.** "If I did it again today, I'd measure the primary's share of reads before implementing a fix, not just the number of tickets. The first fix wasn't wrong, but the metric on which it looked successful was the wrong metric."

Notice: no list of technologies; where every number comes from is clear ("in my model"); and there's a real mistake, my own, with its reason. And after this the interviewer's almost certain question: _"How would you roll this out to production?"_ — the place for the spaced repetition.

**The spaced repetition answer:** in expand/contract a breaking change is split into small, separate, reversible deploys (10.6). For renaming a column: (1) add the new column (expand), (2) the code writes to both, (3) backfill the old data into the new column, in small batches, (4) read from the new column, (5) stop writing to the old column, (6) a while later drop the old column (contract). After each step you can go back to the previous one, except the last. In the TaskFlow story the answer has the same shape: "the version-token routing behind a feature flag, a canary on 1% of users first, widened while watching the primary's read share and the 'didn't see own write' metric, and switching the flag off goes straight back to the old cookie path." This answer works even for a learning project, because the question is about design, not history — just say "this is how I'd roll it out", not "this is how I rolled it out".

### 1.7 Story bank

**Story Bank** — a collection of a few projects' stories written down before the interview, each in three lengths, with the depth ladder and an honest mistake, so that whatever form the question takes ("the hardest", "the one you'd change", "your current system") there's a story ready.

Two stories are enough, one where your decision went well and one where it went wrong (or both in the same story, like the example above). Two fully prepared stories are far better than ten half-prepared ones, because the difference is made on the fourth and fifth levels' questions.

> **Trade-off Table — storytelling decisions**

| decision                           | one side                               | the other side                                               | when to use which                                                                                          |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| big system vs your own decision    | big: sounds impressive                 | small but yours: ownership and depth                         | almost always your own decision; a big system only if you had a real decision there                        |
| the whole system vs one problem    | whole: the big picture, but shallow    | one problem: deep, with numbers and a mistake                | the whole picture in 30 seconds, one problem in 5 minutes, the rest if the interviewer wants it            |
| a success story vs a mistake story | success: feels safe                    | mistake: honest, shows learning                              | both together is best: a mistake, then the fix, then today's lesson                                        |
| production vs learning project     | production: real pressure, more weight | learning (TaskFlow): every decision yours, all measured      | production if you had a real decision there; if not, a learning project, by that name                      |
| exact numbers vs magnitudes        | exact: credible, if true               | magnitude ("a few thousand"): safe, protects confidentiality | exact if you remember and can say it; otherwise the magnitude and how it would be measured — never made up |

---

## 2. Interview Angle

This lesson is itself a part of the interview, so here it's seen from the interviewer's side:

- **The red flags interviewers look for:** starting with a list of technologies; the whole story in "we"; not a single number; "there were no problems"; not being able to draw a picture; and the biggest — blaming others for mistakes ("product didn't give us time", "the previous developer left bad code"). The last is sometimes true, but saying it in an interview means stepping away from your own role. Instead: "Time was short, so I gave up X, and the price of that was Y."
- **Mid-level vs senior:** at mid-level, one problem, your own implementation, and a clear result are enough. At senior the interviewer looks for the comparison of alternatives, getting others on board (how you convinced the team, who objected), the system's evolution (what happened six months later), and a retrospective insight.
- **"What would you do differently if you did it again?"** This question is almost certain, and the answer has to be ready. A specific change, with the reason, standing on something you now know.
- **The interviewer turns one part into a design round:** "Okay, your system is now ten times bigger, what would you change?" Then it's 12.3-12.4's mock, only the system is one you know. Start from the numbers (12.2), as you would with an unknown system.

**In real production:** this same skill is needed again and again inside the job: writing up your work for a promotion, telling the history of an earlier decision in a design review, an incident's postmortem (without blame, 10.3), explaining the system to a new colleague. And in each, the same structure works: context, problem with a number, alternatives, decision, result, lesson. A habit that makes this easier: at the time of a big decision, keep a one-page write-up (many teams call it an architecture decision record), so that two years later, in an interview or a review, the "why" is still remembered.

---

## 3. Key Takeaway

- **The question is a truth check on the CV:** ownership, depth, judgement, results, and honesty — a list of technologies earns points on none of them
- **Choose the project on seven criteria, not size:** your real decision, a number, a trade-off, a mistake, drawable, three levels deep, tellable without breaking confidentiality
- **The same story in three lengths:** 30 seconds, 5 minutes, 20 minutes; the structure: context → problem with a number → constraints → alternatives → decision → measured result → mistake and lesson
- **Write the depth ladder in advance:** four levels on three boxes; at the bottom, "below this I'm not sure, this is how I'd check" — not a made-up answer
- **"I" for decisions, "we" for context:** admit a decision that wasn't yours, then your view and what you'd do today
- **If you don't remember a number, give the magnitude and how it would be measured:** never made up; a made-up number breaks on one question, and then everything is under suspicion
- **TaskFlow is worth telling, if told by that name:** a learning project, simulation numbers — and there's a real mistake (73% of reads to the primary in the cookie's window), which makes the story stronger

---

## 4. New Terms (Glossary)

| Term                      | Meaning                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design Narrative**      | Telling a project's design in a set order: context → problem with a number → constraints → alternatives → decision → measured result → mistake and lesson — every part a signal                            |
| **Impact Metric**         | The measured number of what your decision changed, before and after, on the same measure, with how it was measured — if you don't remember, the magnitude and the way to measure it, never made up         |
| **Retrospective Insight** | "What I'd do differently if I did it again today", a specific change and its reason — seeing your own work from outside, the part that gives the most senior signal                                        |
| **Depth Probe**           | Successive "why?"/"and then?"s on the same subject, each one level down — the goal is to find the bottom of your knowledge; an honest answer at the bottom is good, a made-up one breaks on the next level |
| **Ownership Signal**      | Evidence of which work or decision was specifically yours — mainly "I" for decisions and "we" for context; if the whole story is "we", the interviewer can't give credit                                   |
| **Story Bank**            | Two or three projects' stories written before the interview, each in three lengths, with the depth ladder and an honest mistake — ready for any form of the question                                       |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. The first part of a candidate's 5-minute story: _"We built a notification system, very scalable. We used Kafka because it's the industry standard, and a Redis cache because it's fast. The system performed very well, the latency was very low."_ (a) Which of 1.1's five things are here, and which aren't? (b) What are the interviewer's three likely next questions, and on which is this candidate in the most trouble? (c) Rewrite the first three sentences in 1.3's structure, without naming any technology.

2. You're telling your project's story. The interviewer: _"Was the decision to split into microservices yours?"_ It wasn't; it predates your joining. And you think it was wrong. (a) What are the three parts of the answer? (b) What trap is easy to fall into when saying "it was wrong", and how do you avoid it? (c) The interviewer's next question: "So why didn't you try to change it?" — what could an honest answer be?

3. After you tell 1.6's TaskFlow story, the interviewer: _"Good. Now tell me, how credible is your model's 29%? What would it be in production?"_ (a) What's the honest answer? (b) Does this question weaken your story, or give you an opportunity? (c) If you had to measure the number in production, what would you measure?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) **Missing:** ownership (all "we"), judgement ("industry standard" and "fast" aren't reasons, and there are no alternatives), results ("performed very well", "latency was low" — no number, no before and after), honesty and learning (no mistake). **Partly:** depth — can't be told yet, because nothing deep has been said. Essentially none of the five is there.

(b) Likely: (1) "What was your role in this?" (2) "Why Kafka, and what alternatives did you consider?" (3) "What was the latency, how did you measure it?" The most trouble is on (2): if there's no real reason after "industry standard", the interviewer realises the decision was either not the candidate's, or taken without thought. And on (3), a made-up number will break at the next level ("p50 or p99?", "with which tool?").

(c) One possible version: _"I was on the backend of an app's notifications, in a team of three; the delivery part was mine. The problem: during a campaign, a few hundred thousand notifications at once, and then urgent messages like OTPs were delayed by a minute or so, which blocked logins. I considered two paths: adding workers, or keeping urgent and campaign messages in separate lines, and I chose the second because..."_ Notice: a number, ownership, an alternative, and no technology's name needed yet (11.5's priority tiers).

**Question 2:**

(a) (1) **Admit:** "No, that decision predates my joining." (2) **Understand:** "As far as I know, the reason was letting separate teams deploy independently." — meaning you tried to understand the reasoning behind the decision. (3) **Your view, with evidence:** "In my experience the split between order and payment caused the most problems — a large share of our incidents were about consistency between those two. If I were making the decision today I'd keep those two together (9.1)."

(b) The trap: blaming the people before you ("the people who did this didn't understand"), or calling the whole decision wrong without any evidence. Both are a bad signal of working with people in the interviewer's eyes. The way to avoid it: talk about the decision's **consequences** (which incidents, which costs), not the people; and accept that with the information of their time the decision may have been reasonable.

(c) A few forms of an honest answer, whichever is true: "I did try: I wrote up a proposal, the team didn't agree because the migration's cost was high that quarter, so instead I added an outbox between the two to reduce incidents." Or: "No, I was new then and didn't have the evidence to propose it; now I'd gather the incident data first and then propose it." Both are good, because both are true and both contain a lesson. There's only one bad answer: a made-up heroic story.

**Question 3:**

(a) "The 29% comes from my model's assumed lag values: a few ms on average, and now and then a stall of a few seconds. The real number depends on how often and for how long a replica stalls, and how soon after writing users read. So the percentage itself isn't credible. What is credible is the **comparison** of the strategies: which fixes it on the same device, which on another device, and how much load each puts back on the primary. That stays the same even when the lag numbers change."

(b) An opportunity. It's a depth probe, and the honest answer gives exactly the signal the interviewer is looking for: you know which part of your numbers is assumed and which part holds. It only weakens the story if you try to defend 29% as a production number.

(c) (1) The distribution of replica lag, not the average, the tail: the p99 of `replay_lag` and how often it exceeds a second; (2) the distribution of the time between a user's write and their next read (from request logs); (3) directly: at each read, the replica's replay position versus that user's last write position — how often the replica was behind. The third is the real metric, and with a version-token system it can be measured for free.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise** (no code; the deliverable is your story bank and a 5-minute recording)

> **Task:**
>
> 1. **Choose the projects:** a list of all your projects (work, personal, TaskFlow), each a yes/no on 1.2's seven criteria. Choose the two with the most "yes"es. If none gets at least four "yes"es, take TaskFlow as one, on 1.6's condition.
> 2. **Write three lengths for each:** 30 seconds (four sentences), 5 minutes (in 1.3's structure, with a picture), and for the 20-minute version, the names of three boxes where you'll go deeper.
> 3. **The depth ladder:** for each of those three boxes, four levels, as in 1.4. At any level where you get stuck, either go and learn it, or write down the honest answer.
> 4. **The "I"/"we" test:** underline every "we" in the 5-minute write-up. For each, ask: is this really "I"? Or truly the team's? If there's a "we" in a decision sentence, rewrite it.
> 5. **Recording:** the 5-minute version, out loud, in one take, with a recording. Then listen and count: how many numbers, how many alternatives, how many times "I" in a decision sentence, how many seconds on a list of technologies, and whether the mistake part is there.
> 6. **The "why" game with a friend:** ask a friend to pick any one thing in your story and say "why?" or "and then?" five times. At which level did you go from "I know" to "my guess"? Did it match what you wrote on your ladder?

Send the two stories' 5-minute write-ups, the depth ladders, and the counts from the recording. I'll look at where the interviewer's first follow-up will land, and how well your ladder holds there.

**Honest notes:** the numbers in the TaskFlow story (29%, 73%, 0%, 3.4%) come from a model in Lesson 6.3's exercise, where the replica lag is assumed; they are not measured production numbers, and the story has to say so (question 3). What interviewers look for and what counts as a red flag is general observation gathered from published interview guides and interviewers' writing; the shape and weight of this round vary a lot between companies. What's said about confidentiality is general advice, not legal advice — check what your contract says.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 11 (complete, with exit challenges), 12.1, 12.2, 12.3, 12.4
Current: 12.5 — "Tell me about a system you designed"
TaskFlow state: as at the end of Module 10; this time as the story of "a system I designed" — a learning project, by that name.
What the question measures: ownership, depth, judgement, results, honesty (a truth check on the CV). Choosing a project on
seven criteria (your own decision, a number, a trade-off, a mistake, drawable, three levels deep, confidentiality). The story:
context → problem with a number → constraints → alternatives → decision → measured result → mistake and lesson; in three
lengths (30 s, 5 minutes, 20 minutes). The depth ladder: four levels on three boxes; an honest answer at the bottom. "I" for
decisions, "we" for context. Example: TaskFlow's read-your-writes (6.3's model): on a random replica 29% don't see their own
write → with a 5 s cookie 0% but 73% of reads on the primary (the wrong metric) → a per-user version token on the server,
0% and 3.4%. Rollout: feature flag + canary, expand/contract.
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram, Content-Addressed Block, Content-Defined Chunking, Change Journal,
Namespace, Conflicted Copy, Dedupe Side Channel, Design Narrative, Impact Metric, Retrospective Insight, Depth Probe,
Ownership Signal, Story Bank
Weak spots: [where you got stuck — write it yourself; at which level of the depth ladder you got stuck]
Next: 12.6 — Capstone: TaskFlow's complete design doc + implementing one core piece
=======================
```

---

## 8. Next Step

Today's thread: **this question doesn't test your system, it tests your relationship with the system.** Which decision was yours, why, what the alternatives were, what you measured, and what went wrong. And not one of these comes from a list of technology names. Stay honest at the bottom of the ladder, keep "I" and "we" apart, and don't be afraid to tell a real mistake: it's often the strongest part of the story.

When you are ready, write `next` — **Lesson 12.6: Capstone.** Over eleven modules TaskFlow grew piece by piece, each lesson a problem. In the Capstone those pieces come together in one full design doc: requirements → estimation → architecture → DB schema → scaling plan → failure modes → cost, the way it goes to a real team's design review. With a real implementation of one core piece. Which one, the curriculum says we'll decide together: 12.6 will offer a few options, each with its price and what it teaches, and you'll pick one. And that doc will become the strongest story in this lesson's story bank.
