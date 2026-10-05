# Lesson 9.1 — Monolith vs Microservices: When to Split, and When Not To

**Module 9 — Microservices & Service Architecture**

> **Spaced Repetition (Lesson 1.5):** Two components sit in series on a request's path — both are required — and each is independently 99.9% available. How available is the whole path? And if they were in parallel (either one alone is enough)? Today that question comes back — this time inside your own app, counting services.

**Prerequisite:** Lesson 1.5 (Availability), Lesson 1.6 (Scaling), Lesson 2.5 (API versioning), Lesson 3.4 (Deploys, graceful shutdown), Lesson 5.5 (Transactions), Lesson 5.6 (N+1), Lesson 6.1 (Partial failure), Lesson 7.1 (Cascading failure, the event loop), Lesson 7.5 (Outbox, events), Lesson 8.3 (Search index — a copy of the database)

**By the end of this lesson you will be able to:**

1. State, with measured numbers, the three costs of splitting a monolith into microservices — network calls, spreading failure, and the lost transaction — and know what each one requires in return (batched APIs, timeout + fallback, saga/outbox)
2. Explain which problem microservices actually solve (many teams, independent deploys, independent scaling) and which they do not ("the app is slow") — using Conway's Law
3. Make a decision: monolith, modular monolith, or extracting one specific service — where the boundary goes (bounded context), and how to recognise a distributed monolith

**Tier:** 1 — Runnable Code (separate Node processes as separate services — function call vs network call, crashes and timeouts; plus Postgres in Docker, one database vs database per service)

---

## 0. Where TaskFlow Is Right Now

By the end of Module 8 there are many systems around TaskFlow: a Postgres primary and replicas, Redis, BullMQ, object storage, a CDN, search. But TaskFlow's **code** is still one thing: one Express app, one repo, one deploy pipeline, six identical instances. Tasks, comments, users, workspaces, billing, notifications, attachments, search — all in one place.

Meanwhile the engineering team has gone from 6 people to 30, split across five teams. And three things happened in one month:

1. **The deploy queue.** 40 PRs a day, one pipeline, a 45-minute test run. On Friday a change from the billing team had a bug — the whole deploy was rolled back, and an urgent fix from the tasks team went back with it. The tasks team's lead: "Why is our fix blocked by someone else's bug?"
2. **Monday morning.** The billing team shipped a new feature: "export all comments as CSV" for finance. While an export runs, everyone's task board is slow — Lesson 7.1's event loop, again.
3. **The scaling argument.** Attachment thumbnails and the search consumer need CPU and memory; the board needs many small instances. It is all one app, so it all scales together — big machines, lots of them.

A newly hired staff engineer proposed: "Let's do what Netflix and Uber did — split TaskFlow into 12 microservices: tasks, comments, users, workspaces, auth, billing, notifications, files, thumbnails, search, reports, gateway. Each team deploys its own."

The CTO's answer: "Before we split, tell me what splitting costs. Measure it." That is today.

---

## 1. Theory

### 1.1 What the two words actually mean

The two words are often used with the wrong meaning — "monolith" as old and tangled code, "microservices" as modern. The real difference is not code quality, it is **how it deploys and who owns the data**.

**Monolith and Microservices** — A monolith is an app that is built and deployed as a single unit (one kind of process, usually one database) — its internal parts call each other with function calls. Microservices are several small services, each **deployed independently**, each **owning its own data**, talking to each other over the network (HTTP, gRPC, messages).

```
  monolith                                    microservices
  ────────                                    ─────────────
  ┌──────────── one deploy ──────────────┐     ┌─ tasks ─┐   HTTP   ┌─ users ─┐
  │ tasks ─fn()─► users                  │     │ deploy  │ ───────► │ deploy  │
  │   │                                  │     │   │     │          │   │     │
  │   └──fn()──► comments   billing …    │     │  [DB]   │          │  [DB]   │
  │                                      │     └─────────┘          └─────────┘
  │            one Postgres              │          │ HTTP / event
  │   [tasks][users][comments][billing]  │          ▼
  └──────────────────────────────────────┘     ┌─ comments ┐   ┌─ billing ─┐
   any table, in one transaction               │ deploy [DB]│   │ deploy [DB]│
                                              └───────────┘   └───────────┘
```

Notice two things in this picture, because the three costs in the rest of the lesson all come from them: on the left the arrows are **function calls**, on the right **network calls**; and on the left there is one database where a single transaction can touch every table, on the right each service has its own.

### 1.2 Cost 1 — from function call to network call

A function call is a jump within the same memory — nanoseconds. A network call means: serialising an object to JSON, writing to a socket, arriving in another process, parsing, validating, doing the work, JSON again, coming back, parsing, validating. In Lesson 1.3's numbers: a round trip within one data centre is ~0.5 ms — a hundred thousand times more than reading memory.

From the exercise, `npm run latency`: TaskFlow's board — 50 tasks in a project, each with its assignee and comment count. The same logic, three ways. In the microservices version the tasks service calls the other two — either once per task (**chatty** — the simple code you get from an ORM's lazy loading) or all at once (**batched**):

```
── Opening the board — all processes on one machine ──
                                                    1 user alone  busy: 16 concurrent, 5 s
   path                                         calls        p50   boards/s        p99   CPU / board (all processes)
   monolith (function call)                         0     0.3 ms       6234     5.0 ms   0.1 ms
   microservices, chatty (call per task)          100    11.3 ms         86   203.6 ms   24.4 ms
   microservices, batched (2 calls)                 2     0.8 ms       2206    11.1 ms   0.8 ms
```

- **Chatty:** one board = 100 HTTP calls. To a single user it looks like 11 ms (the 100 calls go out together, so that is all it costs) — but in system CPU it is **24 ms per board**, more than two hundred times the monolith. With 16 users at once you get just 86 boards per second and a p99 of 200 ms. This is Lesson 5.6's N+1 — not database queries this time, network calls. And in the monolith that same "lazy" code was harmless, because a function call is nearly free.
- **Batched:** 2 calls, together — 0.8 ms of CPU, 0.8 ms alone. Eight times the monolith's CPU, but in the same room. In microservices your APIs have to be **coarse** — "give me many at once" — because every call has a fixed price.
- These numbers are on **localhost** — all processes on one machine. In experiment 1, adding 1 ms of delay to each internal call (closer to separate machines) takes batched from 0.8 to 2.0 ms. And a real deploy has a load balancer, TLS, and often a service mesh proxy in between — each adding a little more.

(Honest note: the monolith's 6234 boards/s is limited by the load generator itself — it eats ~1.3 cores, with the monolith at ~73% of one core. So compare using the CPU column. Microservices have 3 processes and can therefore use 3 cores — and still deliver less.)

**Another hidden cost — changing things.** In a monolith, changing a function's signature is one PR: the compiler shows you every caller, and it all deploys together. Changing an API between two services means Lesson 2.5's versioning: running the old and new side by side, waiting for every caller to move, then deleting the old one — because the two services deploy at different times. TypeScript's types do not cross the boundary; there you need Zod and contracts.

(In the 1990s engineers at Sun Microsystems — L. Peter Deutsch and others — compiled a famous list, the "fallacies of distributed computing": the network is reliable, latency is zero, bandwidth is infinite … — the things newcomers to distributed systems assume that are not true. Splitting a monolith means importing those mistakes into your own app.)

### 1.3 Cost 2 — failure now lives inside your app

Lesson 6.1's partial failure — "some parts work, some do not, and you are not sure which" — used to live out with the database or Redis. In microservices it is inside your own app, at every boundary.

The first question: do separate processes mean separate failures? Let's measure incident 2. From the exercise, `npm run failure`: boards are being opened while someone runs an "export all comments" — each one ~300 ms of CPU work, back to back:

```
── A. Heavy neighbour: opening the board (8 clients) while an export runs (~300 ms CPU each, back to back) ──
   path                                         boards/s ok        p50        p99     full  no comments   error
   monolith, no export (for comparison)                5979     1.3 ms     3.2 ms     100%           0%      0%
   monolith, export in the same process                  28   301.4 ms   302.8 ms     100%           0%      0%
   microservices, no timeout                             28   301.8 ms   306.5 ms     100%           0%      0%
   microservices, timeout 50 ms + fallback              154    51.7 ms    58.1 ms       1%          99%      0%
```

- **Monolith:** the export and the board share one event loop — the board goes from 1.3 ms to 301 ms. Incident 2, exactly.
- **Microservices, no timeout:** the export now lives in the comments service and the board in the tasks service — separate processes. And yet the board is **exactly as slow**: 301 ms. Because the board needs comment counts, and the tasks service waits quietly for the comments service to answer. The slowness crossed the network — Lesson 7.1's cascading failure, this time service to service.
- **Timeout + fallback:** the tasks service waits no more than 50 ms; if nothing comes it shows the board without comment counts. The board is 52 ms, but 99% of boards are "incomplete".

The lesson: **separate processes isolate nothing by themselves.** The benefit of separation only arrives when the calling side has a timeout and an answer to "what do I show if I do not get this?" (Which is what Lesson 9.4's circuit breaker and bulkhead are about.)

Now a crash — a bug in the export killed the process (like an OOM):

```
── B. Crash: a bug in the export killed the process — then 5 s of opening boards ──
   path                                         boards/s ok        p50        p99     full  no comments   error
   monolith (the only process died)                       0     1.2 ms     3.9 ms       0%           0%    100%
   microservices, comments died, no timeout               0     3.6 ms     7.8 ms       0%           0%    100%
   microservices, comments died, + fallback            1759     4.2 ms     8.3 ms       0%         100%      0%
      … then users died (no fallback)                     0     3.1 ms     7.0 ms       0%           0%    100%
```

Here you see microservices' real benefit: in the monolith the export's bug shuts down **all** of TaskFlow (six instances in reality, but the same bug in all of them). In microservices only comments goes — and with a fallback the board still works. But look at the last two rows: without a fallback it is 100% errors, and a fallback has to be designed **separately for every dependency** — users did not have one.

**And availability multiplies.** The spaced repetition's answer: two 99.9%s in series are 0.999 × 0.999 = 99.8%. The more services on the board's path, the more multiplications:

```
── C. Arithmetic: k services on the board's path, each independently 99.9% available ──
   k        path availability   downtime per 30 days
   1                   99.90%       43 minutes
   3                   99.70%      129 minutes
   5                   99.50%      216 minutes
  10                   99.00%      430 minutes
```

If even half of the proposed 12 services sit on the board's path, then even with every one of them good (99.9%) the board is down three and a half hours a month — instead of the monolith's 43 minutes. A fallback takes that service off the path (like a parallel component) — so a fallback is not just nice UX, it is the arithmetic of availability.

And one cost the exercise does not measure: **finding out what broke.** In a monolith, one stack trace. In microservices a slow request crossed six services — where did the time go? For that you need distributed tracing (Lesson 10.4) — without it, on-call nights get long.

### 1.4 Cost 3 — transactions and data get divided

The microservices rule: each service owns its own data.

**Database per Service** — each service has its own database (or at least its own schema that nobody else reads or writes directly); another service's data comes through its API or its events — never straight from its tables.

Why this rule? Because if two services read the same table, one of them renaming a column breaks the other — and then they have to deploy together, which destroys the entire point of independent deploys (1.6's distributed monolith). But the rule has a price: **Lesson 5.5's transactions do not cross the boundary.**

In TaskFlow, "create a task" means two things: a row in the tasks table, and `task_count + 1` on billing's workspace (the plan limit and the invoice come from that number). From the exercise, `npm run transaction`: 3000 task creations, with the process dying after the first write in 3% of them (a deploy, an OOM, a timeout):

```
── 3000 "create task", 100 workspaces, crash after the first write in 83 of them (3%), 8 concurrent ──
   path                                               ok failed    tasks  counter    bad ws   result                  ops/s      p50
   monolith: one transaction                        2917     83     2917     2917         0   they match               2917   2.6 ms
   services: task first, then billing               2917     83     3000     2917        57   83 tasks with no bill    1516   5.2 ms
   services: billing first, then task               2917     83     2917     3000        57   83 bills with no task    1513   5.2 ms
   services: task first + the user retried          3000      0     3083     3000        57   83 tasks with no bill    1477   5.2 ms
```

- **Monolith:** a crash means the whole transaction is void. The user sees an error, but nothing is left half-done — zero mismatches.
- **Services:** the first write commits on its own — it cannot be taken back. Exactly 83 mismatches, and **which direction** they go is decided by the ordering: task first means tasks with no bill (plan limits can be exceeded); billing first means bills with no task (customer complaints). Like Lesson 8.1's "object first, row second" — you cannot stop the error, you can only choose which way it falls.
- **The retry:** the user saw an error and pressed again. The first attempt's task still exists, so now there are **3083 tasks** — 83 duplicates. Retrying does not fix this problem; it needs Lesson 2.5's idempotency key.
- And even without crashes (experiment 3): two commits and two round trips per operation — ops/s goes from 2810 to ~1490.

There are solutions — Lesson 7.5's outbox (sending billing an event, in the same transaction) and Lesson 9.3's saga (multi-step work with a reverse action per step). But every solution means eventual consistency and extra code — where the monolith had one `BEGIN … COMMIT`.

**JOINs are lost too.** "Last week's tasks for workspaces on the Pro plan" — one SQL statement in a monolith. Across services: the list of workspaces from billing, tasks from tasks, and the join in application code — or a separate copy that contains both (like Lesson 7.6's analytics or 8.3's search — a derived copy of the database, with syncing and lag).

### 1.5 So why split at all — what you get

We have seen three costs. Big companies split anyway — because some problems are hard to solve in a monolith, and nearly all of them are **people** problems, not machine problems:

- **Independent deploys.** Incident 1: billing's bug blocks tasks' fix. Separate services mean each team deploys on its own schedule and rolls back on its own.
- **Independent scaling.** Incident 3: thumbnails need CPU and the board needs many small instances — separate services mean separate machine types and separate counts.
- **Isolating failure** — but only if you design for it (1.3's timeouts and fallbacks).
- **Different technology** — a Python ML library in one service, TypeScript in the rest. In practice this is usually the least important reason.

Behind all of this sits an old observation:

**Conway's Law** — "any organization that designs a system will produce a design whose structure is a copy of the organization's communication structure" — Melvin Conway, 1968. Meaning: with five teams working in one codebase, the code's boundaries will eventually settle on the team boundaries, whether anyone intended it or not.

So microservices are primarily a tool for **scaling an organization**: keeping many teams out of each other's way. They are almost never the solution to "the app is slow" — as 1.2's numbers showed, adding network calls makes the app slower.

**A few real stories** (from published writing; read the full context in the originals):

- **Amazon:** according to Steve Yegge's famous (and accidentally public) 2011 post, in the early 2000s a mandate went out at Amazon — every team's data and functionality would be available only through service interfaces, and by no other path. In big companies this is retold as a story about "team autonomy" — but there were thousands of engineers there.
- **Segment (2018, "Goodbye Microservices"):** a separate service per destination — over a hundred — with three engineers spending most of their time keeping them alive. They went back to a single service, and productivity went up.
- **Amazon Prime Video (2023):** a tool for monitoring video quality, built out of many small distributed pieces (Step Functions, Lambda) — bringing it back into one process cut that tool's infrastructure cost by 90%. (This is not the whole of Prime Video — it is one specific tool; but the lesson is 1.2's: the price of crossing a boundary.)
- **Shopify:** a very large Ruby on Rails app — instead of splitting into microservices, a "modular monolith" (1.6) — one deploy, but strict internal boundaries, with tooling to verify them.

And Martin Fowler's 2015 "MonolithFirst" post: most successful microservices stories begin with a monolith that grew and was split; stories that begin with microservices often ran into trouble — because at the start nobody knows where the right boundaries are.

### 1.6 The middle path — the modular monolith, and what to avoid

The question is not "one versus twelve". There is a middle path, and there is a trap.

**Modular Monolith** — one deploy, one kind of process, one database — but with clear boundaries between modules inside: each module owns its own tables, calls other modules only through their public interface (functions), and that rule is enforced with tooling.

Where do you draw the boundary? An idea from Domain-Driven Design (Eric Evans, 2003):

**Bounded Context** — a boundary within which a word has exactly one meaning and one model; outside it, the same word can mean something else. In TaskFlow, "task": on the board it is a title, an assignee, a status, comments; in billing it is just a number — how many, against the plan's limit. Two different contexts, two different models.

Signs of a good boundary: the things inside change together, get written together in a transaction, and are owned by one team; conversation with the outside is infrequent and coarse. A bad boundary: every feature requires changing two modules together.

What a modular monolith looks like in TypeScript:

```
src/modules/
├── work/            ← tasks, projects, comments — one bounded context
│   ├── index.ts     ← the public interface: the only thing importable from outside
│   ├── models/      ← Sequelize models — Postgres's `work` schema
│   └── internal/    ← importing from outside is forbidden (lint rule)
├── billing/
│   ├── index.ts     ← recordTaskCreated(tx, workspaceId), usage(workspaceId)
│   └── …            ← Postgres's `billing` schema
├── identity/        ← users, workspace membership, auth
├── files/           ← attachments (8.1, 8.2)
└── search/          ← search (8.3)
```

```typescript
// src/modules/work/index.ts — the work module's public interface
import type { Transaction } from 'sequelize';
import { billing } from '../billing';
import { Task } from './models/task';

export async function createTask(input: NewTask, tx: Transaction): Promise<TaskDto> {
	const task = await Task.create(input, { transaction: tx });
	// calling another module — through its public function, never its table directly.
	// But still the same process, the same database, the same transaction — 1.4's mismatch can't happen here.
	await billing.recordTaskCreated(tx, input.workspaceId);
	return toDto(task);
}
```

Calling another module goes through its public function, never straight into its tables — but this is still one process, one database and one transaction, so 1.4's mismatches cannot happen here.

And the rule lives in tooling, not on paper: ESLint's `no-restricted-imports` (or `dependency-cruiser`) — importing `modules/*/internal/**` from outside fails CI. In Postgres each module gets its own schema, and the code review rule is: no direct queries into another schema's tables. This gets you microservices' biggest benefit — **boundaries** — with no network, no spreading failure, no lost transactions. And if you later need to extract a module, the boundary is already clean.

Now the trap:

**Distributed Monolith** — a system that looks like microservices (separate processes, network calls) but behaves like a monolith: the services share tables in one database, they have to be deployed together, and one request produces a chain of many synchronous calls. Both sides' costs, neither side's benefits.

```
  signs of a distributed monolith
  ───────────────────────────────
  ┌─ tasks ─┐ ──HTTP──► ┌─ users ─┐ ──HTTP──► ┌─ auth ─┐        ← a synchronous chain (1.3's multiplication)
  └────┬────┘           └────┬────┘           └───┬────┘
       └───────────┬─────────┴────────────────────┘
                   ▼
            [ one shared Postgres ]                             ← everyone reads everyone's tables
  "I'll change a column in users" → tasks, auth, reports deploy together  ← no independent deploys
```

Questions to ask yourself: can one service be deployed alone without touching the others? If one service changes its database, does anything else break? If one service dies, how many others die with it? If the answers are "no, yes, all of them", it is a distributed monolith.

**Extract slowly.** When you really do have to extract a part, not all at once:

**Strangler Fig** — building the new service alongside the old system and moving traffic to it one route or feature at a time (with a proxy or gateway in front deciding where each request goes), until the old part is empty and can be removed — Martin Fowler's 2004 name for it, after a tree that grows around another tree and gradually replaces it.

Every step is small, every step is reversible, and the old system keeps running throughout. (That gateway in front — Lesson 9.2.)

### 1.7 TaskFlow's decision

**Not twelve services. A modular monolith, and extracting exactly one service — the one where the conditions are met.**

First, the real answers to the three incidents:

- **The deploy queue (incident 1):** the problem is one pipeline with everyone's changes together. The answer: `CODEOWNERS` for module ownership, tests split by module and run in parallel (45 minutes down to ~10), and feature flags (Lesson 10.6) — a half-built feature deploys but stays off, so a bug means flipping a flag instead of rolling back everyone's deploy.
- **The export (incident 2):** heavy work in a web process — the answer to that is in Module 7: a BullMQ job in a separate worker process (Lesson 7.3). No new service needed.
- **Scaling (incident 3):** web and worker as separate process types — the same code, different deploy sizes.

Then the modular monolith: five modules aligned with the five teams (using Conway's Law rather than fighting it) — `work` (tasks, projects, comments), `identity`, `billing`, `files`, `search`. Each with its own Postgres schema, a public `index.ts`, lint rules, and writes between modules still in one transaction.

**Which part to extract — five questions:**

1. Does one team fully own it, and does it change at a different pace from the rest?
2. Are its resource demands very different from the rest of the app (CPU, memory, GPU)?
3. Does anything need to be written **in the same transaction** as the rest? (If so, extracting it means paying 1.4's price.)
4. Can the others talk to it asynchronously (with events) — or is a synchronous call needed on every user request's path? (If so, 1.2's and 1.3's prices.)
5. Is its boundary stable — has its interface changed much over the last few months?

**Files processing** (thumbnails, video transcoding, virus scanning) meets all of them: owned by the files team; heavy on CPU and memory, sometimes GPU; shares no transaction — it starts from Lesson 8.2's `attachment.uploaded` event and ends with an event going back; it is not on a user request's path; and its interface is small and stable ("make a thumbnail of this object"). This one gets extracted — its own deploy, its own machines, its own scaling.

**Billing** is tempting (separate team, compliance), but it fails question 3: creating a task and recording usage are in the same transaction (1.4's exercise). Not now — first turn usage into an event with an outbox, then Lesson 9.3's saga, then look again.

> **Trade-off Table — TaskFlow's shape**

| Shape                    | Deploy                                       | Team autonomy                           | Boundary cost (latency/CPU)    | Failure                                            | Transactions / consistency       | Operational complexity                                | When                                                    |
| ------------------------ | -------------------------------------------- | --------------------------------------- | ------------------------------ | -------------------------------------------------- | -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Monolith (no boundaries) | One, everyone together                       | Low — everyone's code tangled together  | None (function calls)          | One bug takes everyone down                        | One transaction, JOINs           | Lowest                                                | The start, a small team, boundaries still unknown       |
| Modular monolith         | One, but with ownership and tests per module | Medium — boundaries enforced by tooling | None                           | Same process — one bug hits all (workers separate) | One transaction, via module APIs | Low                                                   | Most apps, a few teams — **TaskFlow today**             |
| Microservices            | Each independently                           | High                                    | On every call (200× if chatty) | Isolated — **only** with timeouts + fallbacks      | None — outbox, saga, eventual    | High — tracing, discovery, versioning, many pipelines | Many teams, very different scaling, stable boundaries   |
| Distributed monolith     | Separate in name, together in fact           | Low                                     | On every call                  | A chain — everyone falls together                  | Shared DB, but no transactions   | High                                                  | Never — when you recognise it, rejoin or truly separate |

---

## 2. Interview Angle

**"Monolith or microservices?" (or mid-design-question: "would you split this into services?")** — a weak answer: "microservices, because they scale." A good answer asks first: how many teams, how many engineers, which part scales differently? Then it gives both the costs and the benefits — network calls (with a number: "chatty calls cost 200× the CPU per board"), availability multiplication, the lost transaction — and says: start with a modular monolith, and once the boundaries are clear extract only the part whose resources or team are genuinely different. In a system design interview (say "design Uber") drawing services is normal — but next to every boundary, say which call is synchronous, which is an event, and who owns which data.

**"What's the biggest drawback of microservices?"** — distributed data: no transactions, no JOINs, eventual consistency; then partial failure and debugging (tracing). Bonus: naming the distributed monolith and its symptoms.

**"How would you split a monolith?"** — strangler fig: a gateway/proxy in front, one route at a time into the new service, the old one still running; split data ownership first (who writes), then code. Which part first — the least entangled with the highest payoff (TaskFlow's files processing).

**In production, in practice:** the most familiar stories — chains of synchronous calls with no timeouts, where one slow service stops everyone (1.3); services sharing one database where a migration breaks everybody; "we run 40 services with 8 engineers" — the operational cost exceeding the work; and coming back — like Segment, many companies have rejoined their services.

---

## 3. Key Takeaway

- The difference between a **monolith** and **microservices** is not code quality — it is **the unit of deployment and the ownership of data**: one deploy and one database, versus each service deploying independently and owning its data, talking over the network
- **Cost 1 — network calls:** the same board, chatty (100 calls) costs 24 ms of CPU per board versus the monolith's 0.1 ms, and 86 boards/s under load versus thousands; batched (2 calls) is 0.8 ms. Boundary APIs have to be coarse, and changing them needs versioning
- **Cost 2 — failure:** separate processes isolate nothing by themselves — with no timeout the board is 301 ms just like the monolith; with timeout + fallback it is 52 ms (incomplete). Microservices win on a crash — but only for the dependencies that have a fallback. k services on the path means multiplying availability k times
- **Cost 3 — transactions:** database per service means half-done work on a crash — 83 mismatches, with the direction decided by the write ordering; retries create duplicates; and even without crashes throughput roughly halves. The answers are the outbox and sagas (9.3) — with eventual consistency
- Microservices mainly solve an **organizational** problem (independent deploys, independent scaling, team autonomy — **Conway's Law**), not "the app is slow"
- **Modular monolith**: one deploy, one database, but boundaries drawn along **bounded contexts** and enforced with tooling — the right starting point for most apps; a **distributed monolith** (shared DB, coupled deploys, synchronous chains) is the worst of both
- Extract one piece at a time (**strangler fig**), against five questions: ownership, resources, shared transactions, whether async is possible, stable boundaries — in TaskFlow, only files processing

---

## 4. New Terms (Glossary)

| Term                         | Meaning                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Monolith / Microservices** | Monolith — an app built and deployed as a single unit, function calls inside, usually one database; Microservices — independently deployed services, each owning its own data, talking over the network |
| **Database per Service**     | Each service has its own database or schema that nobody else touches directly — other services' data comes via their API or events; the price: no transactions and no JOINs across the boundary         |
| **Conway's Law**             | An organization that designs a system produces a design whose structure copies that organization's communication structure (Melvin Conway, 1968)                                                        |
| **Modular Monolith**         | One deploy and one database, but with clear module boundaries inside — each owning its own tables, called only through its public interface, enforced with tooling                                      |
| **Bounded Context**          | A boundary within which a word has one meaning and one model (Domain-Driven Design) — the primary way to find service or module boundaries                                                              |
| **Distributed Monolith**     | Microservices in appearance, a monolith in behaviour — a shared database, coupled deploys, chains of synchronous calls; both sides' costs, neither side's benefits                                      |
| **Strangler Fig**            | Building a new service alongside the old system and moving one route at a time through a front proxy, until the old part is empty                                                                       |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines in your own words for each.

1. A new startup — four engineers, an MVP in six months. The CTO says: "Microservices from day one — user, order, payment, notification, catalog — so we don't have to rewrite later." Which part of that reasoning is right and which is wrong? How heavy are this lesson's three costs for this team, and which of the benefits will they actually get? What would you propose — and how would you address the fear of "having to rewrite later"?
2. TaskFlow's notifications (email when a task is assigned, push when you are mentioned in a comment) — someone says this should be extracted. Judge it against 1.7's five questions. The notification service needs to know users' emails and notification preferences — how should it get them: an HTTP call to identity every time, or something else (Lesson 7.5)? What should happen if the notification service is down for an hour?
3. Another team at TaskFlow previously built a `reports` service — separate process, separate deploy — but it reads the monolith's Postgres `tasks` and `comments` tables directly. Now the tasks team wants to move `tasks.status` into a separate table. What happens? Which anti-pattern is this? Give three alternatives with the cost of each.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The right part: splitting later really can be hard — **if** the code has no boundaries at all. The wrong part: microservices as the solution.

- **The costs:** four engineers means a deploy pipeline, monitoring and on-call per service — roughly one human per service. Order and payment ought to be in the same transaction — splitting them means a saga (9.3) from day one. And in an MVP's first six months the product changes constantly — draw the boundaries in the wrong place (nearly certain, since nobody yet knows what changes together) and every feature means changing several services and API versions together.
- **The benefits:** independent deploys — a team of four does not need them, they are not in each other's way. Independent scaling — an MVP's traffic fits on one machine. Isolated failure — they will not even get it without timeouts and fallbacks.
- **The proposal:** a modular monolith — `user`, `order`, `payment`, `catalog`, `notification` modules, each with its own schema and public interface, enforced with lint. That is also the answer to the fear of rewriting: the boundaries exist from today, just without the network — extracting a module later means turning its `index.ts` functions into an HTTP client and moving its schema into a separate database. And whatever will almost certainly need to be separate (heavy work, say) goes into a worker from the start (Module 7).

**Question 2:** The five questions:

1. Ownership — say one team (collaboration) owns it; email/push providers, templates and retry rules change at their own pace. ✓
2. Resources — not very different (I/O, provider APIs), but the bursts are (a thousand emails on one big import — Lesson 7.4). Partly ✓
3. Shared transactions — no: a notification is not part of the task-creation transaction; the task gets created, then "tell people". ✓
4. Async — entirely: `task.assigned`, `comment.mentioned` events (outbox → stream, 7.5), not on a user request's path. ✓
5. Stable boundary — "on this event, notify this user" — small and stable. ✓

So it is a good candidate — second after files processing.

Preferences and emails: an HTTP call to identity for every notification puts identity's availability on notification's path (1.3's multiplication), and a burst of a thousand emails means a thousand calls against identity. Better: **event-carried state transfer** (Lesson 7.5) — identity emits `user.email_changed` and `user.preferences_changed`, and the notification service keeps its own small copy (in its own database, only what it needs). The price: that copy can lag by seconds — a notification right after an email change may go to the old address; usually acceptable.

Down for an hour: the events pile up in the stream (a consumer group's offset, 7.2) — when it comes back it sends the backlog. Nothing about creating tasks or the board stops. Two decisions are needed: should an hour-old notification still be sent ("you have been assigned a task" — yes; "X is typing" — no, so events need an expiry); and when sending a thousand piled-up events, the provider's rate limit (backpressure, 7.4).

**Question 3:** `reports`' queries read `tasks.status` — move the column and reports breaks, right after the deploy, and the tasks team's tests do not catch it (reports is a separate repo). Only one way out remains: the two teams change together and deploy together. This is a **distributed monolith** — independent deploys in name, but the shared database binds them. In effect the database schema has become the API between two teams — with no versioning.

The alternatives:

- **(a) A reporting API from tasks** (or a "view" the tasks team promises to maintain — treating a database view as a public contract). The price: the tasks team now owns an interface, with versioning (2.5); and pulling a million rows through an API for a large report is slow.
- **(b) Reports' own copy from events** — `task.*` events (outbox, 7.5) → tables shaped for reports in its own database (a read model). The price: eventual (a few seconds behind — usually fine for reports), an initial backfill, and a job to detect sync gaps (like 8.3's). This is the cleanest separation — and it matches Lesson 7.6's analytics path.
- **(c) Rejoin** — make reports a module of the monolith, reading through the `work` module's public functions. The price: independent deploys end; but if independent deploys were never actually needed (same team, same pace), this is the cheapest option.

The choice depends on how separate the reports team really is: separate team, separate pace, large analytics → (b); small, same people → (c). (a) is the middle ground and the quick fix.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (separate Node processes as separate services; Postgres in Docker for `transaction`)

> **Ready to run in the repo:** [`exercises/lesson-9.1-monolith-vs-microservices/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.1-monolith-vs-microservices) — `npm install`, then `npm run latency` and `npm run failure` (no Docker); `docker compose up -d --wait`, then `npm run transaction`. The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in the `README.md` there.

`latency` serves the same board three ways — in one process, and across three processes with chatty or batched calls — measuring one user's latency alone, boards/s under load, and CPU per board across all processes. `failure` shows what happens to the board during a heavy export and a crash — with and without timeouts and fallbacks — plus the availability multiplication. `transaction` runs "create task" as one transaction in one database and as two writes across two databases, with seeded crashes in between.

**Honest notes:** Verified by running in the sandbox on Node 26 with Postgres 17 in Docker: `tsc --noEmit` clean; `latency` five times — timings vary by a few percent (chatty alone 10–14 ms, batched under load ~2200 boards/s) while the CPU/board column is stable; `failure` three times — the percentage and error columns identical; `transaction` three times — everything identical except ops/s and p50. Experiments 1–3 in the README were run and their numbers are in the README; the `for … of` part of experiment 1, plus 4 and 5, involve changing code — those are yours. All "services" are on one machine over localhost — faster than a real network; `NET_MS` is an approximate pretence of delay, not real network variance. The monolith's boards/s is limited by the load generator itself — compare via the CPU column. The export's CPU work and the crash (`SIGKILL`) are manufactured, not real bugs. The company stories in 1.5 are summarised from their published writing — read the originals for full context. The TypeScript in 1.6 (the modular monolith's `index.ts`) is a sketch, not code that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** before running `latency`, write down — how many HTTP calls does one board make on the chatty path, and how many times the monolith's CPU per board will it be (ten? a hundred?). Then compare. Where was your guess wrong, and why is the "1 user alone" latency so much lower than the CPU?

2. **Network distance:** run experiment 1 (`NET_MS=1`). How much did batched go up, and how much chatty — and why did chatty barely move? Then change chatty's `Promise.all` in `service.ts` to a `for … of` with `await` (one call at a time — plenty of real code looks like this). Before running it, compute: at `NET_MS=1`, how many ms will one user's board take?

3. **The value of the timeout:** run experiment 2 (`TIMEOUT_MS=500`), then `TIMEOUT_MS=10`. What percentage comes back "without comments" in each? If TaskFlow's board has an SLO of "p99 < 200 ms", how would you set the comments call's timeout — from which two numbers?

4. **The direction of the mismatch:** for each of `transaction`'s four rows, write one line on what the customer experiences and what the billing team sees. Which ordering would you choose for TaskFlow? Then write experiment 5 (the reconcile job), and say what your job could get wrong given that it cannot read both databases at one instant.

5. **The design part:** a one-page design for TaskFlow's modular monolith: (a) the five module names, each one's owning team and Postgres schema; (b) 3–5 function signatures for each module's public interface (TypeScript); (c) which rule is enforced by which tool (lint, schema permissions, CODEOWNERS, CI); (d) the plan for extracting files processing — the strangler fig steps, which events go in and out, and which metric will tell you the extraction succeeded; (e) what would have to change before billing could ever be extracted.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8 (complete, with exit challenges)
Current: 9.1 — Monolith vs Microservices: when to split, when not to
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3 read
replicas, Patroni + etcd; outbox → Redis Streams, BullMQ workers; object storage (presigned,
multipart, CDN signed URLs); search on Postgres full-text; code: modular monolith — five modules
(work, identity, billing, files, search), each with its own Postgres schema and public index.ts,
boundaries enforced with lint, writes between modules still in one transaction; web and worker as
separate process types; CODEOWNERS, tests split by module, feature flags; being extracted: only
files processing (thumbnails, transcode, scan) — it talks in events; billing not now (same
transaction as creating a task)
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig
Weak spots: [where you got stuck — write it yourself]
Next: 9.2 — Service communication, API Gateway, BFF pattern (SvelteKit server routes)
=======================
```

---

## 8. Next Step

Run the exercise and send me the results — especially your prediction in 1 and the design in 5. When you are ready, write `next` — in Lesson 9.2 we go to **service communication, the API Gateway, and the BFF pattern.** Today we decided to extract files processing, and for the strangler fig I mentioned "a proxy or gateway" in front — but what is that, actually? When a browser wants data from three services for one page, does it call all three itself — or does something in the middle stitch them together? Will the services talk to each other over REST, gRPC, or events? And TaskFlow's SvelteKit server routes (`+page.server.ts`) are already a BFF — a Backend for Frontend — so which responsibilities should it take and which should it not.
