# Lesson 12.1 - Interview Framework Recap + 10 Common Mistakes

**Module 12 - Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 1.3):** 10 million daily active users, each sending 20 requests a day on average. What is the average QPS? Work it out in your head, in under a minute. Then say: what goes wrong if you size the servers with that average alone? One of today's ten mistakes is exactly that.

**Prerequisite:** Lesson 1.2 (the five-step framework), Lesson 1.3 (Estimation), and at least three of Module 11's case studies

**By the end of this lesson you will be able to:**

1. Run a 45- or 60-minute system design interview against the clock in five steps, and say what **signal** each step gives the interviewer
2. Spot the ten most common interview mistakes in your own or someone else's transcript, and say in one line what to say instead of each
3. Know the rubric in the interviewer's hand: the dimensions you are measured on, and where mid-level and senior expectations differ

**Tier:** 3 - Design Exercise (there is no code to write here; the deliverable is an interview you run yourself against the clock and an honest log of your mistakes)

---

## 0. Where TaskFlow Is Right Now

Eleven modules done. TaskFlow is where Module 10 left it: a few services, an API gateway, a queue, a cache, read replicas, observability, two regions. You put every piece in place yourself, with a reason, one at a time. And in Module 11 you built seven new systems from scratch.

Now say you sit your first interview. You hear the question and smile to yourself:

> "Design a team task management app, like Trello or Asana."

This is TaskFlow! The very system you grew over eleven modules. And the hour went like this:

```
time     what happened
00:00    Within 10 seconds of the question ending: "Okay, let me start with microservices - a user
         service, a task service, a notification service, an API gateway in front."
04:00    "Kafka for events, Redis for the cache, Elasticsearch for search, and the tasks in
         Cassandra, because it scales."
09:00    Interviewer: "How many users are you assuming?" - "Lots, say 100 million." Three minutes of
         storage math: 100 million × 1,000 tasks × 1 KB = 100 TB. Then back to drawing, with no decision.
13:00    "200 million requests a day, so ~2,300 a second, so 3 servers are enough."
15:00    "Let's shard the task table by user_id."
16:00 –  Load balancer, CDN, two regions, replicas, a separate database for every service.
  31:00  22 boxes on the board.
31:00    Interviewer: "What happens when two people edit the same task at the same time?"
         Four minutes of silence. Then: "Last write wins."
37:00    Interviewer: "Okay, and if this were in a single Postgres, what would that problem look like?"
         "Postgres won't scale here, so Cassandra."
41:00    Interviewer: "What if the notification service dies?" - "We'll retry."
44:00    "Do you have any questions for me?" Time's up. No data model drawn, not a single API endpoint.
```

The feedback a week later: _"The candidate knows a lot of technology. But didn't ask about requirements, took no decision from the numbers, sharded a 100 QPS app, and couldn't state trade-offs where we wanted to go deep. No hire."_

Not one line of that feedback says "doesn't know". Every line is **not being able to say what you know, at the right time, in the right order, out loud.** In this course you learned the lost update on concurrent edits (5.5), the optimistic lock, the outbox for notifications (7.5), a timeout meaning "I don't know" (11.5) - all of it. In that hour, none of it made it onto the board.

Today's lesson is about that gap: **knowing** system design and **showing** it in a system design interview are two different skills. You built the first over eleven modules. The second is Module 12's job. The hour above contains ten separate mistakes. By the end of the lesson you will recognise each one, and know what you should have said instead.

---

## 1. Theory

### 1.1 What the interview actually measures

First, a misconception to break: the interviewer is not buying **your design**. Nobody can build Trello in 45 minutes, and the interviewer knows it. They are buying a **sample** of working with you: when you get a vague problem, what you do, what you ask, what you assume, how you choose, and how you recover when you are wrong.

**Signal** - the part of what you say or do from which the interviewer can write down evidence about your skill. "The candidate said from the peak QPS that one Postgres is enough and sharding isn't needed" is a strong signal. "The candidate named Kafka" is almost no signal.

After the interview, the interviewer writes feedback, usually organised around a **rubric**.

**Rubric** - the measuring frame in the interviewer's hand: a few dimensions, and for each, what you have to see for which level. Names and splits vary by company, but published guides and interviewers' writing keep coming back to roughly the same five dimensions:

```
dimension                     what it looks for                                  which step shows it most
handling ambiguity            the right questions, cutting scope, assumptions    Steps 1, 2
                              said out loud
a working design              an end-to-end design that would run: data model,   Step 3
                              API, data flow
technical depth               going all the way down in one or two parts;        Step 4
                              failure, numbers
judgement and trade-offs      alternatives, prices, why this and not that        Steps 4, 5
communication                 driving it yourself, thinking aloud, taking         throughout
                              hints, check-ins
```

Put the hour above into this table: weak signal on four of the five dimensions, and on one (a working design) a board full of boxes but no data model and no API. And knowledge of technology earns no points on any dimension by itself - only when it shows up as the reason for a decision.

**Expectations by level** (these differ a lot by company, so take them broadly):

- **Mid-level:** a complete design that would run, with some nudging from the interviewer. Heading the right way in the deep dive, even without knowing every edge.
- **Senior:** drives the interview. Proposes which part to deep dive, with a reason. Makes decisions from numbers. Brings up failures before being asked.
- **Towards staff:** all of the above, plus the system's evolution (what changes in six months), operations (who is on call, what we measure), cost (10.7), and team limits.

The same transcript can be a mid-level "hire" at one company and a senior "no hire" at another. So know the level you are targeting, and don't be shy about asking the recruiter which level you are being considered for.

### 1.2 The framework, this time with eleven modules of experience

Lesson 1.2's five steps haven't changed. What has changed is what you know inside each step. Below is each step, its time, and what to bring into it from this course.

```
a 45-minute round (~40 minutes of design, after introductions at the start and your questions at the end)

 0        5          10                  20                              35        40
 ├────────┼───────────┼───────────────────┼───────────────────────────────┼─────────┤
 │ 1. Req │ 2. Est    │ 3. High-level     │ 4. Deep dive (1-2 parts)      │ 5. T/O  │
 │ + scope│           │ + data model + API│                               │ wrap-up │
 └────────┴───────────┴───────────────────┴───────────────────────────────┴─────────┘
            ▲ check-in            ▲ check-in            ▲ check-in
```

In a 60-minute round there are ~50 minutes of design: almost all of the extra ten minutes go to the deep dive (a second deep dive, or the failure side of the first), not to requirements or the high level.

**Time Box** - a time limit set in advance for each step; when it runs out you move to the next step yourself, even if the work isn't perfect. Write it small in the corner of the board: `Req 5 · Est 5 · HLD 10 · Deep 15 · Wrap 5`. When the interviewer sees it they get a signal: you own the clock.

**Step 1 - Requirements + scope (~5 minutes).** Three kinds of question here, each backed by a lesson from this course:

- **What it does, and what it doesn't.** Two or three core flows; drop the rest out loud (1.2).
- **How big, and what shape.** Users, the read-to-write ratio, whether there are spikes (11.7's sale day, Module 11 exit challenge's 10:00 wave), whether the data follows a power law (11.4's celebrity).
- **What must not break.** Correctness or availability (5.9, 11.7), how stale the data may be (6.5), the latency target at p99 (1.5).

**Clarifying Question** - a question in the requirements step whose answer **changes** your design. "How many users?" is a clarifying question. "Which language will we write it in?" usually isn't, because whatever the answer, the design stays the same. The rule is simple: before asking, imagine two possible answers. If the design wouldn't differ between them, drop the question.

Many interviewers answer questions with "you decide." Then you need the second thing.

**Stated Assumption** - where there is no information, you pick a value yourself and **say it out loud**, so the interviewer can change it if they want: "I'll assume 1 million daily active users, a 20:1 read-to-write ratio, and that a task being a few seconds stale is fine. Okay?" The difference between assuming silently and assuming out loud: the second is a signal (handling ambiguity), the first is a misunderstanding later.

**Step 2 - Estimation (~5 minutes).** Module 11's biggest lesson lives here: the job of the numbers is to **produce decisions**, and often the decision is which tool is **not needed** (11.1's sharding and Bloom filter, 11.7's throughput). Every number must be followed by a "so": "~700 writes a second at peak, **so** one Postgres primary is enough; sharding isn't up for discussion now." A number without a "so" is wasted time.

**Step 3 - High-level + data model + API (~10 minutes).** Boxes and arrows, but with two things people leave out: a small data model of the core entities (tables and keys, 5.2), and two or three core APIs (2.5). Without these two, the boxes are just names. And here, **walk one request's path** across the board with your finger: "the user moved the task → gateway → task service → task and outbox in one transaction → ..."

**Step 4 - Deep dive (~15 minutes).** One or two parts, and **you propose them**, with a reason: "I think this system's two hardest places are concurrent edits and the notification fan-out. Which shall we start with?" Inside the deep dive, a small pattern that worked in every one of Module 11's case studies: the simple solution → where it breaks (with numbers) → the better solution → its price.

**Step 5 - Trade-offs and wrap-up (~5 minutes).** Three sentences are enough: what you gave up and why, what breaks first and at which number, and what you'd do with more time. The "what breaks first" paragraph in each of Module 11's lessons was practice for exactly this part.

**Check-in** - at the end of each step, one line asking the interviewer for direction: "That's the high level. I'd like to go into the concurrent-edit deep dive - or would you rather go somewhere else?" It isn't asking for permission; it makes sure you spend time where the interviewer is interested. Many interviewers have a specific deep dive in mind. Without a check-in you can miss it, and 15 minutes go to the wrong place.

### 1.3 The ten mistakes

The ten mistakes below are gathered from interviewers' written feedback, published interview guides, and this course's case studies. They are not survey numbers, and there is no correct ranking of which "happens most". But almost any interviewer will recognise each one. For each: what it sounds like, which signal is lost, and what to say instead.

**Mistake 1 - Starting to draw without requirements and scope.**

- _What it sounds like:_ 00:00 in the transcript above. Boxes before the question has finished.
- _What is lost:_ the whole handling-ambiguity dimension. And worse: you may be building the wrong system. The interviewer may have had "real-time collaboration" in mind and you built a CRUD app.
- _Instead:_ the first five minutes are only questions and assumptions, and at the end, scope said out loud. "Today I'll work on three things: board and task CRUD, several people working on the same board at once, and a notification on assignment. Search, attachments and billing are out of scope today. Okay?"

**Mistake 2 - Numbers, but no decisions.**

- _What it sounds like:_ the 100 TB at 09:00. Three minutes of math, then back to drawing, as if the math were a formality.
- _What is lost:_ time, and the judgement signal. Worse: the 100 TB is wrong, because not every one of 100 million users keeps 1,000 tasks (power law, 11.4), and nobody caught it, because the number was never used anywhere.
- _Instead:_ only count the numbers that could change a decision, and end each with a "so". All of Lesson 12.2 is about this habit.

**Mistake 3 - Designing with averages.**

- _What it sounds like:_ 13:00: "200 million requests a day, so ~2,300 a second, so 3 servers."
- _What is lost:_ technical depth. Systems don't die at the average, they die at the peak.
- _Instead:_ from the average to the peak (1.3's 2-3×, and more on a sale or launch day, 10× in 11.7), from average latency to p99 (1.5), from the average user to the biggest user (11.4's celebrity, 11.2's hot tenant). One sentence is enough: "2,300 on average, I'll assume a 3× peak, ~7,000, and design for that with headroom."

**The spaced repetition answer:** 10 million × 20 = 200 million requests a day; a day has 86,400 seconds, and taking ~100,000 in your head gives ~2,000, ~2,300 QPS exactly. That is mistake 3's transcript. Size the servers by the average, and every day at peak time (~5,000-7,000 by 1.3's rule) the system can't handle even half the demand, the queue builds up and latency goes through the roof. And rounding in your head (86,400 ≈ 100,000) is completely fine in an interview - just say out loud that you rounded.

**Mistake 4 - The tool's name first, the problem later.**

- _What it sounds like:_ 04:00: "Kafka, Redis, Elasticsearch, Cassandra." Every tool arrived before any problem had appeared.
- _What is lost:_ the judgement signal, and credibility. After every name the interviewer can ask "why?", and "because it scales" is not an answer. There's a name for this: resume-driven design, designing with the tools that look good on a CV.
- _Instead:_ reverse the order: problem → need → tool. "After a task move, both the notification and the activity log have to happen, but without holding up the request, and losing them on a crash isn't acceptable. So a queue, and an outbox to write it together with the DB (7.5). At our size BullMQ does the job; we'd need Kafka if we needed event replay and many consumers." Notice the last sentence: the big tool's name came up, but as a condition.

**Mistake 5 - Google scale on day one.**

- _What it sounds like:_ 15:00: sharding by user_id, a separate database per service, two regions. By the candidate's own numbers, maybe a few hundred writes a second.
- _What is lost:_ judgement. Sharding and microservices have a price (5.8's cross-shard queries, 9.1's distributed transactions and operational burden), and it should be paid only when the numbers say so.
- _Instead:_ the simplest design for today's numbers, followed by an out-loud "when I'd change it": "Today one Postgres primary and two read replicas. If writes pass ~5,000 a second or the table reaches a few TB, I'll think about sharding, and then board_id would be a good shard key, because a board's tasks are all read together." That gives two signals at once: simplicity, and knowing the path to scale.

**Mistake 6 - Leaving out the data model and API.**

- _What it sounds like:_ at 44:00, 22 boxes on the board but not a single table, not a single endpoint.
- _What is lost:_ the working-design dimension. Without knowing what data the boxes hold and how they talk, the interviewer can't tell whether the design would actually run. And many deep-dive questions (shard key, index, pagination) can't even start without a data model.
- _Instead:_ two minutes inside the high level:

```
boards(id, team_id, name)                    GET  /boards/:id/tasks?cursor=…   (2.5's cursor pagination)
tasks(id, board_id, column, position,        POST /boards/:id/tasks            (Idempotency-Key header)
      title, assignee_id, version, …)        PATCH /tasks/:id   { …, version } (for the optimistic lock)
index: (board_id, column, position)
```

The thread for the next deep dive comes straight out of this small picture: the `version` column is half the answer to concurrent edits.

**Mistake 7 - Not watching the clock: 30 minutes in the high level.**

- _What it sounds like:_ 16:00 to 31:00, fifteen minutes of adding boxes. The deep dive started at minute 31, and only because the interviewer pushed.
- _What is lost:_ almost all of the technical-depth dimension, because there was no time left to measure it. Lesson 1.2's warning: drawing boxes is fun and safe, so people stay there.
- _Instead:_ the time box written on the board, and stopping yourself at minute 20: "I'll leave the high level here; the remaining boxes are standard. Let's go into the deep dive." Name the boxes you didn't draw in one line: "I'm assuming a CDN and a load balancer; nothing special there."

**Mistake 8 - Only the happy path.**

- _What it sounds like:_ 41:00: "What if the notification service dies?" - "We'll retry." Who retries, how many times, where it's stored, what if it arrives twice: nothing.
- _What is lost:_ technical depth, and the senior signal. What sets a senior apart is bringing up failures themselves, before being asked.
- _Instead:_ three questions in your head for every arrow: what if the other side dies? What if it's slow (a timeout means "I don't know", 11.5, 11.7)? What if it arrives twice (idempotency, 7.4)? And at least one answer out loud: "The notification is async, from the outbox to a queue; if the worker dies the job runs again, so delivery is at-least-once, deduplicated by the notification's id. After five failures, the DLQ and an alert."

**Mistake 9 - The "best" without a trade-off.**

- _What it sounds like:_ 31:00: four minutes later, "Last write wins." One answer, no alternatives, no price.
- _What is lost:_ the judgement dimension. "Last write wins" isn't a wrong answer in itself, but saying it without the price means the interviewer doesn't know whether you know the price (one person's edit silently disappears, and if two servers' clocks differ, which one is "last" is itself a question, 6.4).
- _Instead:_ at least two alternatives, each one's price, and a choice for this system: "Three options. Last write wins: simple, but one person's edit silently disappears. An optimistic lock with `version` (5.5): nothing disappears, the second person gets a conflict and tries again. Merging per field, or a CRDT: both people's changes survive, but far more complex. On a task board two people editing the same task at the same instant is rare, so the optimistic lock, and on a conflict the UI says 'this has changed, take a look'. If this were simultaneous writing like Google Docs, the answer would change." That last sentence is a small but strong signal: you know under which condition your answer becomes wrong.

**Mistake 10 - Thinking in silence, and treating hints as attacks.**

- _What it sounds like:_ the four minutes of silence at 31:00. And 37:00: the interviewer asked what it would look like in Postgres, and the answer was an argument for Cassandra.
- _What is lost:_ the communication dimension. In silence the interviewer can't write anything down: you may be thinking brilliantly, but the signal is zero. And the 37:00 question was a **hint**: the interviewer was nudging you towards transactions and row locks, where this problem has an easy answer. Resisting it means the interviewer saw that you can't take help, and that is one of the worst signals for working together.
- _Instead:_ think out loud, even half-formed thoughts: "I'm trying to reconcile two things, not relying on the clock and not losing anyone's edit..." And take every "what if ...?" from the interviewer as a gift: "Good question. In Postgres you'd get this almost for free with a transaction and a conditional update on `version`. In fact, I should rethink my Cassandra decision: at our numbers Postgres is enough, and this consistency is a big advantage of it." Changing your mind isn't weakness. Not changing it in the face of new information is.

### 1.4 The same question, the first five minutes again

The same question, this time with the first two steps done properly. Not to memorise in full, but to see the shape:

```
00:00  "Before I start, let me ask a few questions, then I'll set the scope."
00:20  "Is this for one team, or many companies - multi-tenant? And how many people work on one board
        at the same time, two or three, or several hundred?"                      → tenancy, size of concurrent edits
01:00  "When someone moves a task, how quickly should the others see it? Immediately, or is a refresh fine?" → real-time or not (2.4)
01:40  "Which is worse to break: losing one task edit, or the board not opening for a few minutes?" → correctness vs availability
02:30  "Today I'll work on three things: board/task CRUD, working together, a notification on assignment.
        Search, attachments, billing are out. Okay?"                              → scope, out loud
03:00  "I'll assume the numbers: 10 million users, 2 million active a day, each ~50 reads and 5 writes a day."
04:00  "10 million writes a day, ~120 a second on average, ~350 at a 3× peak. So one Postgres primary is enough,
        sharding isn't part of today's discussion. Reads are 10×, so I'll think about read replicas and a
        board cache. Task data is small, 1 KB, so storage isn't a problem."       → number → "so"
05:00  "I'm writing it on the board: Req 5 · Est 5 · HLD 10 · Deep 15 · Wrap 5. Shall we go to the high level?"    → time box, check-in
```

Look at the difference: in five minutes not a single tool's name came up except one ("Postgres"), and even that as the "so" of a number. Next to each question is written which decision it changes. And at the five-minute mark the interviewer's notebook already has signal on four dimensions, without a single box drawn.

One warning: memorising a list of questions and reciting the same ten in every interview is another mistake, and the interviewer catches it in the first minute. The questions come from **this** system's hardest place: for a task board that's concurrent edits, for payments it's the double charge, for chat it's ordering and delivery.

### 1.5 A few sentences worth having ready

Many interviews are in English, and under pressure the right sentence doesn't come. The sentences below aren't for memorising, but a frame for saying it in your own words:

| moment            | sentence                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| starting          | "Before I start drawing, I'd like to ask a few questions to pin down the scope."                                         |
| assuming          | "I'll assume about 2 million daily active users and a 10:1 read-to-write ratio. Does that sound reasonable?"             |
| number → decision | "That's roughly 350 writes per second at peak, so a single Postgres primary is enough. I won't shard for now."           |
| cutting scope     | "To keep us focused, I'll leave search and attachments out unless you'd like me to cover them."                          |
| check-in          | "That's the high-level picture. I'd like to go deep on concurrent edits next. Is there another area you'd prefer?"       |
| trade-off         | "There are two options here. The first is simpler but loses an edit on conflicts; the second costs an extra round trip." |
| not knowing       | "I haven't worked with that directly, but here's how I'd reason about it."                                               |
| taking a hint     | "Good point. That changes my earlier choice; let me revisit it."                                                         |
| wrap-up           | "To summarise: the biggest risk is X, it breaks first at about Y, and with more time I'd look at Z."                     |

Remember the "not knowing" sentence in particular. Making something up when you don't know a tool or an event is one of the riskiest things in an interview: one follow-up question catches it, and after that everything else you said falls under suspicion too. "I don't know, but here's how I'd think about it" is almost always a good signal, because the interview is measuring your thinking, not your memory.

> **Trade-off Table - decisions inside the interview**

| decision                                      | one side                                       | the other side                            | when to use which                                                                                                 |
| --------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| asking vs assuming                            | many questions: the right scope, but time goes | assuming out loud: fast, but can be wrong | 3-5 questions that change the design, the rest as stated assumptions                                              |
| exact vs rough math                           | exact: fewer errors, but eats minutes          | rounded: fast, order of magnitude right   | almost always rounded, and say out loud that you rounded                                                          |
| breadth vs depth                              | every box: complete picture, but shallow       | deep in one or two parts: more signal     | every box in one line in the high level, then depth; for senior, depth weighs more                                |
| choosing the deep dive yourself vs leaving it | yourself: the driving signal                   | the interviewer: where their interest is  | propose it yourself with a reason, and let the interviewer change it at the check-in                              |
| familiar vs "right" tool                      | familiar: survives deep questions              | the textbook tool: sounds good            | the one whose follow-ups you can handle, unless the numbers or a need demand the other (then state the condition) |
| simple vs future-proof                        | simple: right for today's numbers              | scaling ahead: less work later            | simple for today's numbers, and say out loud "at which number I'd change what"                                    |

---

## 2. Interview Angle

This lesson's subject is the interview itself, so the questions here are a little different: the meta-questions the interviewer asks **about your design** are really tests looking for the ten mistakes above.

- _"What would change if traffic went up ten times?"_ - a test for mistakes 3 and 5. A good answer points to a specific place that breaks first, with a number, and also says why the rest holds. A bad answer: "I'd add more servers."
- _"Where in this design are you least sure?"_ - a test for mistake 9. There is no worse answer than "it's all fine". Give one honest weakness and a way to measure it.
- _"Why X, why not Y?"_ - a test for mistake 4. Being able to state a condition in Y's favour is the signal here: "At our size, X; we'd need Y if ..."
- _"How would you know this is working in production?"_ - a form of mistake 8, and a senior favourite. Something like 10.4's metrics and alerts, or 11.7's invariant check.
- _The silent interviewer._ - some interviewers deliberately say almost nothing, to see whether you can run the interview yourself. Then the time box and the check-ins are your structure.

**The level difference in one sentence:** at mid-level the interviewer asks the questions and you answer them well; at senior you raise the questions before the interviewer does.

**In real production:** these ten mistakes aren't only interview mistakes. The same things happen in a design review or an RFC: a proposal without requirements, capacity from averages, "we'll take Kafka" without a reason, a happy-path-only diagram, and treating review comments as attacks. And the same medicine works: a written scope, a "so" after each number, the price of each alternative, and a "what breaks first" section. Lesson 12.6's capstone design doc is written in exactly this structure. Practising for interviews is really practising for your first design doc on the job.

---

## 3. Key Takeaway

- **The interview doesn't buy your design, it buys a sample of how you work:** everything you say is either a signal or wasted time. A technology's name isn't a signal; the reason for a decision is
- **Five steps, against the clock:** in 45 minutes roughly Req 5 · Est 5 · HLD 10 · Deep 15 · Wrap 5; write the time box on the board, and give the extra 60-minute time to the deep dive
- **Every question must change the design, every number needs a "so":** if two answers give the same design, drop the question; if the math brings no decision, drop the math. And not the average: the peak, p99, the biggest user
- **Problem → need → tool, and the simplest design for today's numbers:** the big tool comes as a condition ("we'd need Y if ..."), not in the first minute
- **Without a data model and API the boxes are just names:** two minutes of tables and endpoints give you the thread for the deep dive
- **Bring up failures yourself, and give at least two alternatives and their prices for every decision:** these two are the biggest differences between mid-level and senior
- **Think out loud, treat hints as gifts, don't make things up when you don't know:** changing your mind on new information isn't weakness, it's a strong signal

---

## 4. New Terms (Glossary)

| Term                    | Meaning                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signal**              | The part of what you say or do from which the interviewer can write down evidence of skill - "ruled out sharding from the numbers" is a signal, a tool's name alone almost isn't            |
| **Rubric**              | The interviewer's measuring frame: a few dimensions (handling ambiguity, a working design, technical depth, trade-offs, communication), and what to see for which level; differs by company |
| **Clarifying Question** | A requirements-step question whose answer changes the design - if the design is the same for two possible answers, the question is unnecessary                                              |
| **Stated Assumption**   | When there's no information, picking a value yourself and saying it out loud so the interviewer can change it - assuming silently brings misunderstandings later                            |
| **Time Box**            | A time limit set in advance for each step; when it runs out you move on yourself even if the work isn't perfect - the way to save time for the deep dive                                    |
| **Check-in**            | At the end of each step, one line confirming direction with the interviewer - not permission, but making sure the time is spent where the interviewer is interested                         |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. A transcript from minutes 18 to 24 of a "Design a URL shortener" interview:

   > "Okay, for the short code I'll take MD5 and the first 7 characters. Cassandra for the database, because there are lots of writes. Redis cache in front. Click events to Kafka for analytics, then Spark. And a Bloom filter to check whether a code is taken." Interviewer: "What if two URLs have the same 7 characters?" "That's very rare; MD5 collisions are practically impossible."

   (a) Which of the ten mistakes are in these six minutes? For each, the exact sentence from the transcript. (b) What should the answer to the interviewer's question have been (remember 11.1: the 7-character keyspace and the birthday bound)? (c) Rewrite these six minutes so that every tool arrives as the "so" of a problem or a number, or is dropped.

2. A 45-minute interview, and you are in the middle of the high level at minute 12. The interviewer suddenly says: "Say the Redis cluster goes down completely. What happens?" (a) What do you do now: finish the high level, or answer right away? Why? (b) How much time will you spend on the answer, and how will you fix the clock afterwards? (c) What does this question tell you about the interviewer?

3. "Design Google Docs" (several people writing one document at the same time). (a) Write four clarifying questions for the first five minutes, and next to each, which decision it changes. (b) Two stated assumptions, and two "so"s from them. (c) Which two of the ten mistakes are most tempting in this question, and why?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) **Mistake 4** (tools first): five tools (Cassandra, Redis, Kafka, Spark, Bloom filter) in six minutes, not one of them preceded by a problem or a number. "Because there are lots of writes" sounds like a reason, but in a URL shortener reads far outnumber writes (11.1), so the reason itself is wrong, and that would have been caught had the numbers come first (**mistake 2**). **Mistake 5** (over-engineering): 11.1 showed with numbers that writes don't need sharding, and that the Bloom filter isn't needed, because the way codes are produced (a counter or range allocation) doesn't allow collisions at all. **Mistake 9** (no trade-off): "MD5 collisions are practically impossible" denies a price, and it's also wrong (below). Probably **mistake 1** too: analytics and Spark are really a scope question, and there's no sign the interviewer asked for analytics.

(b) Collisions on the full MD5 hash are rare, but cutting it to the first 7 characters shrinks the keyspace: 16⁷ ≈ 268 million in hex, and by the birthday bound a collision becomes likely after roughly √(keyspace) ≈ 16,000 URLs. Even taking 62⁷ ≈ 3.5 trillion in Base62, a few tens of millions of URLs make a collision certain. A good answer: "You're right, collisions on a truncated hash are real, because of the birthday bound. Two paths: retry on collision (adding a salt), which brings a read-before-write and the price of retries; or drop the hash and use a counter or range allocation, where collisions never happen, but the codes are guessable, so a secret permutation for enumeration (11.1). I'd take the second." Notice: first accepting the interviewer's point (the medicine for mistake 10), then two alternatives and prices (for mistake 9).

(c) One possible version: "At peak, writes are a few hundred a second and reads 100×, so the load is entirely on the read side. One Postgres primary is enough for writes. For reads: the short-code-to-URL map never changes, so it caches extremely well. A Redis cache, and the 301 vs 302 question, which decides whether the browser caches it itself. A counter and range allocation for codes, so no collisions and no need for a Bloom filter. Is analytics in scope? If so, clicks go asynchronously to a queue, off the request path; Kafka when the volume gets big." Of the five tools, Redis and the queue survived, each as a "so"; Cassandra, the Bloom filter and Spark were dropped, or pushed back behind a condition.

**Question 2:**

(a) Answer right away, but briefly. A mid-way question from the interviewer is almost always an instruction: "I want signal here." Pushing it off with "I'll get to that" turns into mistake 10's resisting a hint. But the high-level picture is left unfinished, so mark the spot in one line: "I'll answer, and then finish the remaining two boxes."

(b) Two or three minutes: losing the cache sends every read to the database, so the question is whether the database can take it (the read QPS from the estimation is useful here), and if not, what to do: request coalescing to escape 4.6's stampede, a small local cache inside the process, load shedding or degraded mode for less urgent reads (10.3). Then the clock out loud: "This has become part of the deep dive, so I'll finish the high level quickly." Take any step's extra time from the rest of the high level, not from the deep dive.

(c) This interviewer is interested in failure and degradation, probably measuring senior or reliability skills. Keep that in mind when choosing the deep dive: proposing the failure side at the check-in will match the interviewer's interest.

**Question 3:**

(a) One possible set: (1) "Typically how many people write one document at the same time, and at most?" - collaboration design differs for two people and two hundred (whether all of a document's editors can sit on one server, fan-out). (2) "How quickly must others' writing appear?" - real-time (WebSocket, 2.4) or polling every few seconds. (3) "Is writing offline and merging later in scope?" - if so, the whole burden of conflict resolution shifts (leaning towards a CRDT). (4) "How far back do version history or undo go?" - it changes the storage model (snapshot + operation log).

(b) For example: "I'll assume at most ~100 people in one document at a time, usually 2-5. **So** all of a document's editors can sit on one server (routing by document id), and the order of operations is settled in one place on that server." And: "I'll assume each keystroke is one operation, ~5 a second per person. **So** 100 people means 500 operations a second on one document, easy for one server, but each has to go to the other 99, ~50,000 messages a second; operations will need to be batched before sending."

(c) **Mistake 4:** the strong temptation to start with "OT or CRDT", because both names are familiar, even though choosing without knowing the requirements (offline or not, how many people) is meaningless. **Mistake 7:** the high level looks simple (editor, server, storage), so the risk of losing time adding boxes is low, but the opposite risk is large: the whole interview's weight is in the concurrent-edit deep dive, and because it's hard people get there late. Another good answer is **mistake 9:** "last write wins" is almost certainly wrong here, because one person's sentence in the same place disappears, and not saying so is a big weak signal.

</details>

---

## 6. Practical Exercise

**Tier 3 - Design Exercise** (no code; the deliverable is an interview you run yourself against the clock, its recording, and a log of mistakes)

The point of this exercise is to find the ten mistakes in **yourself**. Seeing mistakes in someone else's transcript is easy; seeing them in yourself is hard, because under pressure you don't remember what you said. Hence the recording.

> **Task:**
>
> 1. **Preparation:** pick one of the three questions below that you haven't done in this course: (a) _Design a parking garage reservation system_ (500 garages in a city, advance booking, number-plate recognition at the gate), (b) _Design a leaderboard for a mobile game_ (tens of millions of players, real-time rank, rank among friends), (c) _Design Dropbox_ (file sync, several devices, sharing). Paper or a whiteboard, and an audio or video recording on your phone.
> 2. **45 minutes, against the clock, out loud:** even alone, say all of it out loud, as if an interviewer were in front of you. Write the time box in the corner of the board first. No notes, no books, no search. Answer your own clarifying questions as stated assumptions.
> 3. **The mistake log:** listen to the recording the next day (not the same day, when you still know what you meant to say rather than what you're hearing). One line per mistake: `mm:ss · mistake N · what I said · what I should have said`.
> 4. **The clock:** next to the time box, write how many minutes each step actually took. Which step overran the most?
> 5. **Score yourself on the rubric:** 1 to 4 on each of the five dimensions above, and next to each score a specific moment in the recording (`mm:ss`) as evidence. No score without evidence.
> 6. **Change one thing:** pick the biggest mistake in the log, and record the first ten minutes of the same question again, fixing only that one thing.

Send the full log, the clock, and the rubric scores. I'll look at where you are too hard on yourself and where too soft, and which mistake didn't make it into the log but shows in the description of the transcript. I'm not giving model answers to these questions in advance: two of them may become the raw material for Lessons 12.3 and 12.4's mock interviews, and knowing the answer beforehand would turn the mock from practice into acting.

**Honest notes:** the list of ten mistakes and the rubric's five dimensions are gathered from published interview guides, interviewers' writing, and this course's case studies - not from a survey or measured data. There is no number here for how common any mistake is. Rubrics, time splits and level expectations differ a lot between companies; somewhere the interview is 35 minutes, somewhere 60, somewhere the whole discussion is on a written design doc. The transcript is invented, not from a real interview.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 11 (complete, with exit challenges)
Current: 12.1 - Interview Framework Recap + 10 Common Mistakes
TaskFlow state: as at the end of Module 10 (services, gateway, queue, cache, replicas, observability, two regions);
in Module 12 it comes back as an interview question and as the capstone's subject.
The interview's structure: an interview doesn't buy a design, it buys a sample of how you work; the rubric's five
dimensions (ambiguity, a working design, depth, trade-offs, communication). In 45 minutes Req 5 · Est 5 · HLD 10 (with
data model + API) · Deep 15 · Wrap 5, time box on the board, a check-in at the end of each step. Ten mistakes: (1) starting
without requirements/scope, (2) numbers without a "so", (3) designing with averages, (4) the tool first, (5) big scale on
day one, (6) leaving out the data model/API, (7) 30 minutes in the high level, (8) only the happy path, (9) the "best"
without a trade-off, (10) thinking in silence and resisting hints.
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in
Weak spots: [where you got stuck - write it yourself; the two mistakes that came up most in the exercise's log]
Next: 12.2 - Estimation drill: 10 rapid-fire
=======================
```

---

## 8. Next Step

Today's thread: **in an interview, what counts isn't what you know but only what makes it onto the board and is said out loud.** Every question is there to change a decision, every number is followed by a "so", every tool is the answer to a problem, every decision comes with its price, and the clock is in your hand. Almost every one of the ten mistakes is one of these five habits missing.

When you are ready, write `next` - **Lesson 12.2: Estimation drill, 10 rapid-fire.** Two of today's ten mistakes (2 and 3) are mistakes with numbers, and their medicine isn't knowledge, it's speed. In Module 11 a script did every calculation. In 12.2, ten small questions, two minutes each, only your head and paper: storage, QPS, bandwidth, number of servers, cache size, and at the end of each that one word, "so". And this time there will be a small script to check the numbers, but you run it **after** your calculation, not before.
