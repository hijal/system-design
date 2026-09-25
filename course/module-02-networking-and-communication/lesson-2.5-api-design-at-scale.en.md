# Lesson 2.5 — API Design at Scale: Versioning, Pagination, Idempotency Key, Error Contract

**Module 2 — Networking & Communication (Final Lesson)**

> **Spaced Repetition (Lesson 2.2):** Why can TLS 1.3 complete its handshake in fewer round trips than TLS 1.2? And which kind of operation should 0-RTT not be used for, and why?

**Prerequisite:** Lesson 2.3 (REST), Lesson 1.6 (Stateless/Stateful)

**By the end of this lesson you will be able to:**

1. Understand the different approaches to API versioning and when a version bump is actually needed.
2. Explain the difference between offset-based and cursor-based pagination, and why cursor-based is better for large datasets.
3. Implement the idempotency key pattern (with TypeScript + Express + Zod), and understand why it is essential for payments and other critical operations.
4. Design a consistent error contract.

**Tier:** 1 — Runnable Code (the last part of this lesson is TypeScript + Express code, verified by running it)

---

## 0. Where TaskFlow Is Right Now

Through Module 2 we have talked about an API's "shape" (REST/GraphQL/gRPC) and its "transport" (HTTP, WebSocket). But once an API runs in production for years, in the hands of real users, more practical problems surface:

- You want to make a breaking change (rename a field) — but old clients are still sending requests in the old format. What do you do?
- `GET /api/tasks` returns a million tasks — how do you break that up?
- A user clicks "Create Task", the internet is slow, the response is taking a while, so they click again in frustration — do two tasks now get created?
- When an error happens, how does the client know exactly what went wrong? Does every error arrive in a different shape?

Those four questions are this lesson, and **the third one** (idempotency) matters most — it always comes up wherever money or any other irreversible action is involved.

---

## 1. Theory

### 1.1 API Versioning

When your API needs a breaking change (something that will break old clients — removing a field, changing the response shape), you cannot force everyone to upgrade at once — what about the older mobile app versions still installed on people's phones?

**Three common approaches:**

```
1. URL versioning:       GET /api/v1/tasks   vs   GET /api/v2/tasks
2. Header versioning:    GET /api/tasks
                          Header: Accept-Version: 2
3. Query parameter:      GET /api/tasks?version=2
```

**URL versioning is the most widely used**, because it is the most explicit and easiest to debug (you can see from the URL which version is being hit, and caching is simpler because the URLs differ). Header versioning can feel "cleaner" (the URL is for the resource; version metadata belongs in a header), but it adds a little complexity to debugging and caching.

**An important principle — favour backward compatibility wherever possible:** not every field addition needs a version bump (adding a new optional field does not break old clients, because they do not know about it and simply ignore it). A version bump is needed only when existing behaviour changes or something is removed. And before retiring an old version, announcing a **deprecation period** is standard practice ("v1 shuts down in 6 months; migrate to v2 before then").

### 1.2 Pagination — Offset vs Cursor

Remember the estimation from Lesson 1.3? If TaskFlow holds millions of tasks, returning everything from `GET /api/tasks` at once would be a disaster for both the database and the network. So data is split into small "pages".

**Offset-based pagination (the most familiar):**

```sql
SELECT * FROM tasks ORDER BY created_at LIMIT 20 OFFSET 40;
-- meaning: skip to row 41 and give me the next 20 (page 3, if page size is 20)
```

```
GET /api/tasks?page=3&limit=20
```

**The problem — it gets slow at large offsets:** to honour `OFFSET 40`, the database must first **scan and discard 40 rows**, then return the next 20. If you want page 50,000, the database first has to scan and discard a million rows — which gets exponentially slower as the page number grows.

**Another subtle problem — "shifting" under concurrent writes:** say you are viewing page 1 (rows 1–20), and meanwhile someone creates a new task that sorts to the very top. When you request page 2 (rows 21–40), the last item from your page 1 can reappear at the start of page 2 (because everything shifted by one) — the user sees duplicates or missing items.

**Cursor-based pagination (more common at production scale):**

Instead of a page number, each response returns a **cursor** (usually a unique identifier of the last item, such as its `id` or `created_at`). The next request sends that cursor and says "give me what comes after this":

```sql
SELECT * FROM tasks WHERE created_at > '2026-08-19T10:00:00Z' ORDER BY created_at LIMIT 20;
-- "give me the 20 tasks after this timestamp" — no OFFSET scanning needed;
-- the index can jump straight to that position
```

```
GET /api/tasks?cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTE5In0&limit=20
Response: { "tasks": [...], "next_cursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTIwIn0" }
```

> **Trade-off Table — Offset vs Cursor Pagination**

| Dimension                           | Offset-based                                                | Cursor-based                           |
| ----------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| Implementation                      | Simple                                                      | A bit more complex                     |
| Performance on large datasets       | Degrades (deep pagination)                                  | Always fast (index-based jump)         |
| "Jump to page N"                    | Possible                                                    | Not possible (only next/previous)      |
| Consistency under concurrent writes | Shifting problems                                           | Stable; no duplicates or gaps          |
| Best fit                            | Small datasets, admin panels (where "go to page 5" matters) | Infinite scroll, large datasets, feeds |

**A connection to your Sequelize experience:** `limit`/`offset` are easy in Sequelize, but cursor-based pagination at scale means querying in the `WHERE id > :cursor ORDER BY id LIMIT :limit` pattern — directly relevant in any project with a large dataset.

### 1.3 Idempotency Key — Making Retries Safe

We first met the word idempotency in Lesson 2.2 (in the 0-RTT context). Today we learn it formally.

**The core problem:** a user clicks "Create Task". The request reaches the server, the task is created and saved to the database — but before the response gets back to the client, something goes wrong on the network (a timeout). From the client's point of view, it has no idea whether the request succeeded! So the client **retries**, sending the same request again. But the server already processed the first one — if it processes this one too, **a duplicate task gets created**.

Think about it for payments — the same problem means **sending the same money twice**.

**The solution — an idempotency key:** the client generates a unique key for each "attempt" (usually a UUID) and sends it in a header:

```
POST /api/tasks
Idempotency-Key: 8f14e45f-ceea-467e-bd9f-27dc0f9df4e8
```

The server stores **the result of the first time it processed** each idempotency key. If a request arrives with the same key again (a retry), the server does not process it afresh — it **returns the stored response**, with no duplicate side effects.

```
Step 1: client sends a request with key=ABC
        │
        ▼
Server: haven't seen this key → process it → the task is created →
        store the result against key=ABC → send the response

Step 2 (retry after a network timeout): client sends again with the SAME key=ABC
        │
        ▼
Server: I've seen this key before! → don't process again →
        return the stored result (no second task is created)
```

**An honesty note:** the "Idempotency-Key" header is a de-facto industry standard (Stripe popularised it, and most payment and API platforms copied it), but it is not a formal RFC standard. There is an IETF draft (draft-ietf-httpapi-idempotency-key-header), but it expired before becoming an RFC. Meaning — everyone uses the same header _name_, but the details (retention period, handling a duplicate key with a different body, and so on) are defined by each company itself. If you integrate with a payment provider, read their own documentation rather than assuming "it's standard".

### 1.4 Error Contract — a Consistent Error Response

A large API can fail in many places — validation failure, resource not found, unauthorised, internal error. If each place returns errors in a different shape, client-side code needs separate handling for every one, which is hard to maintain.

**A consistent error contract** means every error arrives in the same shape:

```json
{
	"error": {
		"code": "VALIDATION_ERROR",
		"message": "Request body failed validation.",
		"details": { "field": "title", "issue": "cannot be empty" }
	}
}
```

The `code` is machine-readable (client code can `switch` on it), the `message` is for humans, and `details` carries extra context (optional). This way the HTTP status code (400, 404, 500) plus the error body together give the client complete information — the status code alone is not enough, because "400" can happen for many reasons and the `code` field makes it specific.

---

## 2. Interview Angle

An almost guaranteed interview question on idempotency (especially at fintech and payment companies) — "how do you make sure a user doesn't make the same payment twice because of a network retry?" A good answer explains the idempotency key pattern, and adds that **the client generates the idempotency key, not the server** — because only the client knows what is "a retry of the same attempt" and what is "an entirely new request".

A common pagination question — "which pagination would you use for a social media feed?" Cursor-based is the right answer, because a feed has posts constantly being added (the "shifting" problem from this lesson applies directly), and nobody says "go to page 47" — they just scroll, which is a natural fit for the cursor pattern.

---

## 3. Key Takeaway

- API versioning is needed when a breaking change arrives; URL versioning (`/v1/`, `/v2/`) is the most common and the most debug-friendly
- Offset pagination is simple but slow on large datasets, and creates "shifting" problems under concurrent writes
- Cursor pagination is fast and stable, but cannot jump to a specific page — ideal for infinite scroll and feeds
- An idempotency key is a client-generated unique key that prevents duplicate side effects on retry; used for non-idempotent operations like POST and PATCH
- "Idempotency-Key" is a de-facto standard (popularised by Stripe) but not a formal RFC — each provider has its own details
- A consistent error contract (`code`, `message`, `details`) makes client-side error handling predictable

---

## 4. New Terms (Glossary)

| Term                        | Meaning                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| **API Versioning**          | The technique of maintaining different versions of an API separately           |
| **Deprecation Period**      | The notice period given before removing an old API version                     |
| **Offset-based Pagination** | Splitting pages with `LIMIT`/`OFFSET`                                          |
| **Cursor-based Pagination** | Asking for "the next batch" using a reference to the last item; index-friendly |
| **Idempotency Key**         | A client-generated unique identifier that makes retries safe                   |
| **Error Contract**          | A consistent response shape for every API error                                |

---

## 5. Reflection Questions

1. For TaskFlow's "Activity Log" feature (remember the Lesson 1.3 exercise?), which pagination would you use — offset or cursor — and why?
2. How long should the server keep an idempotency key — permanently, or with a TTL? Which do you think is sensible, and why? (You can borrow the reasoning from the TTL concept in Lesson 2.1 — but apply it in the right context this time.)

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** An activity log is a continuously growing, chronological log — new entries are always added at one end, and users typically scroll through "recent activity" rather than jumping to a specific page number. So **cursor-based pagination** is the right choice here: a large dataset, constant insertion, and no need for "go to page N".

**Question 2:** Keeping idempotency keys permanently is not practical — storage would grow without bound, and in reality a network retry happens within seconds or minutes of the original request (by then the client knows whether it succeeded or failed). So a reasonable TTL (say 24 hours) makes sense — retries within that window get idempotency protection, and afterwards the key expires and leaves storage. This is the same TTL idea from 2.1, but here it is not a DNS record — it is "how long do I remember an idempotency record". The same "expiry time" concept applied in a completely different context.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code**

> **It is ready to run in the repo:** [`exercises/lesson-2.5-idempotency/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-2.5-idempotency) — `npm install && npm run dev` and it runs. The full setup, acceptance criteria, and experiments are in that folder's `README.md`.

The exercise is an Express + TypeScript endpoint that uses the `Idempotency-Key` header to prevent duplicate task creation — so that a network retry never creates the same task twice. It follows all the code rules: TypeScript with `strict: true`, not a single `any`, and Zod validating the runtime input.

**The heart of the mechanism** — three steps inside the handler:

```typescript
// Step 1 — has this key been seen before? If so, return the cached result
// and do NOT run the business logic again. That is the whole point of idempotency.
const cached = idempotencyStore.get(idempotencyKey);
if (cached !== undefined) {
	res.status(cached.statusCode).json(cached.body);
	return;
}

// Step 2 — validate the body (runtime input is never trusted via a type assertion)
const parseResult = createTaskSchema.safeParse(req.body);
if (!parseResult.success) {
	// 422 with the error contract. NOT cached: nothing was executed, so a retry
	// with a corrected body and the same key must be processed fresh (Stripe does the same).
	/* ... */
}

// Step 3 — the actual "write", the non-idempotent part we are protecting
const newTask: Task = { id: randomUUID() /* ... */ };
tasks.push(newTask);

idempotencyStore.set(idempotencyKey, { statusCode: 201, body: newTask });
res.status(201).json(newTask);
```

**Verify it (acceptance criteria):**

1. Without the header → `400 MISSING_IDEMPOTENCY_KEY`
2. An invalid body → `422 VALIDATION_ERROR` (the error contract from §1.4)
3. A valid request → `201`, a new task created
4. **The same key again → `201`, exactly the SAME task id, and no new task created**
5. A different key → a new, different task
6. `GET /api/tasks` → the count proves no duplicates were made

**Then break it yourself (experiments):**

1. Send the same key but a **different body** (a different title). This code currently returns the old cached result even though the body changed. Is that the right behaviour? (Real-world systems like Stripe return a `409 Conflict` when the same key arrives with a different body — try adding that.)
2. Add a TTL/expiry to the `idempotencyStore` (following your answer to reflection question 2).
3. Stop the server and start it again — why did all the idempotency records vanish? That is the limitation of in-memory storage, and it is exactly why this belongs in Redis after Module 4.4: (a) data survives a restart, (b) with horizontal scaling (Lesson 1.6) the state is shared across servers.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, Module 2 (2.1–2.5)
Current: Module 2 complete; Module 2 Exit Challenge remaining
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): [System Design, Trade-off, Requirements, Scope, Estimation,
HLD/Deep Dive, DAU/QPS, TCP Handshake, TLS, Latency/Throughput, Availability/
Reliability, SLA/SLO/Error Budget, Scaling, Stateless/Stateful]
Terms learned (Module 2): DNS, TTL, Recursive/Iterative Query, DoH/DoT, TCP vs UDP,
Cipher Suite, 0-RTT, REST, GraphQL, N+1 Problem, gRPC, Protobuf, Long Polling, SSE,
WebSocket, WebTransport, API Versioning, Offset/Cursor Pagination, Idempotency Key,
Error Contract
Weak spots: covering every sub-part of a multi-part question; naming the cost clearly
when stating a trade-off — though overall the reasoning and concrete thinking got much
stronger through Module 2 (see 2.3 and 2.4)
First Tier 1 exercise completed: the idempotency key pattern in TypeScript/Express,
verified by running it
Next: Module 2 Exit Challenge, then Module 3 — Load Balancing & Proxies
=======================
```

---

## 8. Next Step

Run the code yourself and try the experiments one at a time (especially #1 — the duplicate key with a different body, an important real-world edge case). When you are ready, write `next` — we move to the **Module 2 Exit Challenge**, where REST/GraphQL/gRPC, WebSocket/SSE, and versioning/pagination/idempotency all come together in one integrative challenge.
