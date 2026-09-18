# Module 2 — Exit Challenge

**Module 2 — Networking & Communication**

That is all five lessons of Module 2 — DNS, TCP/UDP/TLS, REST/GraphQL/gRPC, WebSocket/SSE/long polling, and API design at scale. In this exit challenge you have to apply all of it **together**, in one realistic scenario.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow is doing well and has made a big decision — it will launch a **public integration API for third-party developers**. Through it, partners (Slack, Zapier, or a company's own internal tools) will be able to create, list, and update TaskFlow tasks.
>
> Alongside that, a new internal admin feature is coming — a **"Live Partner Activity Monitor"**, where TaskFlow's own team can watch, in real time on a dashboard, how many requests each partner API is sending.

Your job — decide on each of the questions below, applying Module 2 concepts, with reasoning:

**1. API paradigm (Lesson 2.3)**
For the partner-facing API, would you choose REST, GraphQL, or gRPC? Argue it using the "three questions" framework from the lesson.

**2. Versioning + pagination (Lesson 2.5)**
Partners will call `GET /tasks` to list tasks. For this endpoint:

- Which versioning strategy would you use?
- Offset or cursor-based pagination? Why — think specifically about this partner-API context and how partners will actually use this endpoint.

**3. Idempotency (Lesson 2.5)**
Partners will create tasks with `POST /tasks`. How does the idempotency key pattern apply here? And in this case, **if the same key arrives with a different body**, how should that be handled? (Answer from the hands-on exercise you did yourself.)

**4. Real-time mechanism (Lesson 2.4)**
For the "Live Partner Activity Monitor" — WebSocket, SSE, or long polling? Decide based on whether bidirectionality is needed, and give your reasons.

**5. Transport and security (Lessons 2.1, 2.2)**
Partners will use a new subdomain, `api.taskflow.app`.

- What would you think about regarding this new subdomain's DNS TTL at launch?
- Which TLS version(s) would you support (recalling the 2026 standard from Lesson 2.2)?

**6. Error contract (Lesson 2.5)**
If a partner calls `GET /tasks/:id` with an invalid task ID (the task does not exist), write a concrete JSON example of the error response, following the error contract format from the lesson.

**One thing to remember:** in every answer, try to state not only "what I chose" but also **"what I'm giving up"**, in one line — that has been your main improvement area throughout Module 2 (starting with the GraphQL answer in 2.3).

I will critique this step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

- [ ] I can explain the whole DNS lookup chain from URL to response (recursive/iterative, TTL)
- [ ] I can say when TCP or UDP is appropriate, with examples
- [ ] I understand the steps of the TLS handshake and the round-trip difference between TLS 1.2 and 1.3
- [ ] I can choose correctly between REST, GraphQL, and gRPC based on constraints, not hype
- [ ] I use the terms over-fetching, under-fetching, and N+1 problem in the right contexts
- [ ] I can decide between WebSocket, SSE, and long polling based on bidirectionality and frequency
- [ ] I can state the trade-offs of offset vs cursor pagination and when to use which
- [ ] I can **implement the idempotency key pattern myself** (including the difference between a legitimate retry and a payload mismatch) — you proved this today with verified code
- [ ] I can design a consistent error contract

Given your hands-on idempotency key exercise, you should have no doubt about that second-to-last box — you verified it in practice.

---

## 3. Recommendation

**To read:**

- Stripe's own [idempotency keys documentation](https://docs.stripe.com/api/idempotent_requests) — you can compare it directly with today's exercise and see exactly which edge cases a real production system handles (for example, what happens when concurrent requests arrive with the same key — something your current in-memory implementation does not handle, because it needs locking or atomic operations, which we cover later in the database transaction context)

**To work through:**

- gRPC's official "Basics tutorial" (on grpc.io) — a hands-on guide to building a small service with Node.js/TypeScript, which will build familiarity before Module 9

**For a project:**

- In your own time (outside the course) — if any payment-related endpoint you have written lacks an idempotency key, today's pattern (hash-based payload comparison + TTL) applies directly; you would only replace the in-memory Map with Redis (for persistence and multiple instances, recalling the stateless principle from Lesson 1.6)

---

Send the exit challenge over. When you are ready, write `next` and we move to **Module 3: Load Balancing & Proxies**, starting with Lesson 3.1 — where TaskFlow moves to a genuine multi-server architecture for the first time, and your "stateless" knowledge from Lesson 1.6 pays off directly.
