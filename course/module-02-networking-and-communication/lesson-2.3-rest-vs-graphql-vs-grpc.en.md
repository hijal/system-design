# Lesson 2.3 — REST vs GraphQL vs gRPC

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 2.1):** What should you do about DNS TTL when migrating a server, and why (both before and after the migration)?

**Prerequisite:** Lesson 1.4, 2.2 (HTTP, TCP/UDP, TLS)

**By the end of this lesson you will be able to:**

1. Explain the core philosophy and working style of three API paradigms — REST, GraphQL, and gRPC.
2. Understand what "over-fetching" and "under-fetching" are, and how GraphQL solves them.
3. Look at a given scenario and say which API style is sensible — instead of making a hype-based decision like "GraphQL is modern, so it's better".

**Tier:** 3 — Design Exercise (hands-on gRPC/GraphQL code may come closer to Module 9; today is conceptual)

---

## 0. Where TaskFlow Is Right Now

We have been treating TaskFlow's Express API as just "an API" — but it has implicitly been following a specific style all along: **REST**. `GET /api/tasks`, `POST /api/tasks`, `PUT /api/tasks/:id` — this pattern feels so natural that you may never have thought of it as "a choice" with alternatives.

But suppose the client says: "We're building a mobile app now, and each screen needs different data — one screen only needs the task title and status, another needs the full task detail with comments and attachments. And separately, communication between our internal notification service and task service needs to be much faster, in milliseconds." — would today's REST API satisfy both of those well? This lesson answers that.

---

## 1. Theory

### 1.1 REST — What You Have Been Using All Along

**REST (Representational State Transfer)** is an architectural style where each API endpoint represents a **resource** (like `task` or `user`), and HTTP verbs (GET, POST, PUT, DELETE) perform operations on it.

```
GET    /api/tasks          →  a list of all tasks
GET    /api/tasks/123      →  one specific task
POST   /api/tasks          →  create a new task
PUT    /api/tasks/123      →  update a task
DELETE /api/tasks/123      →  delete a task
```

**Advantages:**

- Simple and universally familiar — any developer understands it immediately
- **A natural fit with HTTP caching** — CDNs and browser caches all understand HTTP semantics (caching a GET is easy, because the URL itself identifies the resource)
- Mature tooling — Postman, OpenAPI/Swagger documentation, all designed for REST from day one

**The problem — over-fetching and under-fetching:**

Say a screen in your mobile app only needs a task's `title` and `status`. But calling `GET /api/tasks` returns the whole task object — `title`, `status`, `description`, `assignee`, `comments`, `attachments`, everything. Getting **more data than you need** is **over-fetching**.

The opposite problem also exists — say another screen needs the task _and_ the assignee's full profile (name, avatar, email). In REST that usually takes **two separate API calls** — one `GET /api/tasks/123` and one `GET /api/users/456`. Not getting **enough data in one call**, and needing multiple round trips, is **under-fetching**.

### 1.2 GraphQL — the Client Decides What It Needs

**GraphQL** solves the over/under-fetching problem with a different approach — a **single endpoint** (usually `/graphql`), where the client writes a query stating exactly which fields it wants:

```
The client's query:
{
  task(id: 123) {
    title
    status
    assignee {
      name
      avatar
    }
  }
}

The server's response (exactly those fields, nothing more):
{
  "task": {
    "title": "Fix login bug",
    "status": "in-progress",
    "assignee": { "name": "Alex Rivera", "avatar": "..." }
  }
}
```

Notice — in one request, exactly the needed fields arrived (some from the task, some from the assignee), no more and no less, in a single round trip. That is GraphQL's core promise.

**The problem — GraphQL's own costs:**

- **Caching is hard** — in REST you can cache by URL (`GET /api/tasks/123` always means the same resource), but in GraphQL every query goes to one endpoint (`POST /graphql`), so traditional HTTP/CDN caching does not work easily — you have to build a separate caching layer
- **The N+1 problem** — a term you may recognise from Sequelize (it arrives formally in Module 5.6). On the GraphQL server side, if a query asks for 100 tasks and each task's assignee, a naive implementation may issue a separate assignee-fetch for each task — 100 task fetches + 100 assignee fetches = 101 database queries! This happens easily when resolvers are not designed carefully (batching patterns like DataLoader fix it, but that complexity lands on your backend)
- **More backend complexity** — defining the schema, writing resolvers, thinking about authorisation at every field level — much more setup effort than REST

### 1.3 gRPC — Built for Service-to-Service Communication

REST and GraphQL are both designed mainly for **client (browser/mobile) to server** communication. But when TaskFlow grows and splits into many internal services (we cover this in Module 9 — a Notification Service, a Task Service, and so on), **service-to-service** communication has different needs — maximum speed, strict type safety, and minimal bandwidth.

That is where **gRPC** comes in. Its key characteristics:

- It uses **Protocol Buffers (Protobuf)** — a binary data format (not text-based like JSON), which sends data in far fewer bytes and parses faster
- A **strict schema (IDL — Interface Definition Language)** — both client and server know exactly what shape of data will move, checked at compile time
- **Built on HTTP/2** (remember multiplexing from Lesson 1.4?), so many concurrent requests run efficiently over one connection
- **Supports bidirectional streaming** — not just request-response, but continuous data flow in both directions (real-time metrics streaming, for instance)

```
task.proto (schema definition):

service TaskService {
  rpc GetTask (TaskRequest) returns (TaskResponse);
}

message TaskRequest {
  int32 id = 1;
}

message TaskResponse {
  string title = 1;
  string status = 2;
}
```

**The problem — it is not browser-friendly:**

gRPC is not designed to be used directly from a browser (because of limitations in browsers' HTTP/2 access) — so using gRPC from a web frontend needs a proxy layer like "gRPC-Web". This is why **gRPC is used mainly for internal, service-to-service communication**, not for public browser-facing APIs.

> **Trade-off Table — REST vs GraphQL vs gRPC**

| Dimension          | REST                                     | GraphQL                                                             | gRPC                                                          |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Data format        | JSON (text)                              | JSON (text)                                                         | Protobuf (binary)                                             |
| Fetching precision | Over/under-fetching problems             | Client-driven, precise                                              | Schema-driven, precise                                        |
| Caching            | Easy (HTTP caching)                      | Hard                                                                | Hard (but rarely needed, being internal)                      |
| Browser support    | Native                                   | Native                                                              | Needs a proxy (gRPC-Web)                                      |
| Best for           | Public APIs, simple CRUD, browser-facing | Different clients needing different data (mobile + web + dashboard) | Internal microservice communication where performance matters |
| Setup complexity   | Low                                      | Medium to high                                                      | Medium (schema + codegen)                                     |

### 1.4 What Is Actually Happening in 2026

This topic is hype-heavy, so it was worth checking current data — figures for 2026 vary somewhat between sources (GraphQL adoption is reported anywhere from 25–28% to 60%+, depending on definitions and sample size), but one consistent pattern is clear:

- According to Postman's 2025 State of the API report, REST is still the most-used API style — around 93% of teams use it, while GraphQL is used by roughly a third of teams (and growing). Since developers can pick multiple styles in that survey, these numbers show GraphQL is **not replacing REST but being used alongside it**
- The most important observation for 2026 is that "GraphQL has replaced REST" is simply not true. Instead, the "Backend-for-Frontend" pattern (GraphQL sitting as an aggregation layer over REST or gRPC microservices) has become the most common enterprise model — Netflix, GitHub, Shopify, and Airbnb all use it
- For internal microservice communication, companies like Netflix, Square, and Google have publicly moved their internal (east-west) communication from REST/JSON to gRPC/HTTP-2. If an organisation runs 20+ microservices written in several languages, gRPC is the default choice in 2026

**A practical takeaway:** right now TaskFlow's REST API is entirely the correct choice — it is still a single monolith, browser-facing. When it splits into microservices (in Module 9), considering gRPC for internal communication will be reasonable. And if several client types (mobile app, web dashboard, partner API) later want the same data in different shapes, adding GraphQL as an aggregation layer becomes worth thinking about — but starting with GraphQL from day one would be classic over-engineering (Lesson 1.1).

---

## 2. Interview Angle

A very common question here — "you're building a new API, would you choose REST or GraphQL?" A good answer splits into three questions (straight from today's theory):

1. **Who is calling this API?** If it is a browser, a third-party developer, or a partner — REST's accessibility and caching advantages matter more
2. **Do different clients want different fields?** If one screen needs 3 fields and another needs 30, and satisfying that takes multiple round trips — then GraphQL's complexity is justified
3. **Is this internal, service-to-service communication where both sides are under your control?** Then gRPC's performance and type safety pay off

Answering with this structure shows the interviewer you are deciding by **constraints**, not by hype — exactly the philosophy from Lesson 1.1.

---

## 3. Key Takeaway

- REST — resource-based, uses HTTP verbs, easy to cache, but can suffer over/under-fetching
- GraphQL — the client picks the fields, solving over/under-fetching, but caching is hard and the backend risks the N+1 problem
- gRPC — Protobuf (binary) + strict schema + HTTP/2, extremely fast, but not browser-friendly; used mainly for internal service communication
- The real 2026 pattern: REST dominant for public and browser-facing APIs, GraphQL growing as a client-aggregation layer, gRPC dominant for internal microservice communication
- Three questions for deciding: who is calling? do different clients want different data? is this internal or external?

---

## 4. New Terms (Glossary)

| Term                                       | Meaning                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| **REST (Representational State Transfer)** | A resource-based API architectural style using HTTP verbs                               |
| **Over-fetching**                          | Receiving more data than the client needs                                               |
| **Under-fetching**                         | Not getting enough data in one call, requiring multiple round trips                     |
| **GraphQL**                                | A client-driven query language allowing precise data fetching through a single endpoint |
| **Resolver**                               | In GraphQL, the function determining how each field's data is fetched                   |
| **N+1 Problem**                            | Issuing a separate query for every item in a list (in the absence of batching)          |
| **gRPC**                                   | Google's high-performance RPC framework, based on Protobuf and HTTP/2                   |
| **Protocol Buffers (Protobuf)**            | A binary serialisation format, smaller and faster than JSON                             |
| **IDL (Interface Definition Language)**    | The language for defining a schema that fixes the client-server contract                |

---

## 5. Reflection Questions

1. TaskFlow's mobile app has a "Task List" screen (needing only title + status + due date) and a "Task Detail" screen (needing everything — description, comments, attachments, activity log). Do these two screens justify GraphQL, or can REST handle them adequately (with two separate endpoints)? Give your view, with reasons.
2. Why is gRPC hard to use directly from a browser, and how does that limitation relate to its "internal-only" usage?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** This particular case is not a textbook justification for GraphQL — there are only two fixed screens with two different data shapes. That is easily solved with two REST endpoints: `GET /api/tasks` (summary fields) and `GET /api/tasks/:id` (full detail). GraphQL would be far better justified if there were many more clients (web, iOS, Android, partner API — each with different data needs), or if the data shape were highly dynamic and nested (deeply related data in many combinations). For two fixed screens, REST is simpler and sufficient — adding GraphQL here would be over-engineering.

**Question 2:** gRPC depends on low-level HTTP/2 features (trailers, specific framing) that a browser's standard `fetch`/XHR APIs do not expose (the browser handles HTTP/2 itself but does not give JavaScript that low-level control). So using gRPC from a browser requires a translation layer called "gRPC-Web", which converts gRPC into a browser-compatible format via a proxy. Because of that extra complexity — and because gRPC's main advantages (speed, strict typing) pay off most when both sides are under your control — it has naturally gravitated to internal, service-to-service use, where the browser's limitations are irrelevant.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow is growing. Three new needs have appeared:
>
> **(A)** Third-party integration partners (Slack, Zapier) want to integrate with TaskFlow — a public API is needed for creating, updating, and reading tasks.
>
> **(B)** TaskFlow is building a new "Analytics Dashboard" where various widgets (charts, summary cards, tables) each show task data in different combinations — each dashboard configuration may need a different set of fields.
>
> **(C)** Inside TaskFlow there are now two separate internal services — a "Task Service" and a "Notification Service" (assume this as advance preparation for Module 9). When a task is created, the Task Service has to tell the Notification Service, quickly and reliably.
>
> For each scenario, which would you propose — REST, GraphQL, or gRPC — and why, in one or two lines? (Use the "three questions" framework from this lesson.)

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, 2.1, 2.2
Current: 2.3 — REST vs GraphQL vs gRPC
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): [as before — System Design, Trade-off, Requirements, Scope,
Estimation, HLD/Deep Dive, DAU/QPS, TCP Handshake, TLS, Latency/Throughput,
Availability/Reliability, SLA/SLO/Error Budget, Scaling, Stateless/Stateful]
Terms learned (Module 2 so far): DNS, TTL, Recursive/Iterative Query, DoH/DoT,
TCP vs UDP, Cipher Suite, 0-RTT, Replay Attack, REST, Over/Under-fetching, GraphQL,
Resolver, N+1 Problem, gRPC, Protobuf, IDL
Weak spots: covering every sub-part of a multi-part question; using terminology
precisely; not conflating one core term with a different concept (learned from the
DNS TTL vs data-retention TTL confusion in 2.1) — though the TCP/UDP and
idempotency/0-RTT analysis in 2.2 showed good concrete reasoning; that habit is
getting stronger
Next: 2.4 — WebSocket, SSE, Long Polling (Real-time Communication)
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 2.4: WebSocket, SSE (Server-Sent Events), and long polling — the three main approaches to real-time communication, connecting directly back to the "real-time notification" exercise we did all the way back in Lesson 1.1.
