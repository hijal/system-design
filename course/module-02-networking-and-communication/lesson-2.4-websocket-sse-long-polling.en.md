# Lesson 2.4 — WebSocket, SSE, Long Polling (Real-time Communication)

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 2.2):** Why can TLS 1.3 complete its handshake in fewer round trips than TLS 1.2? And which kind of operation should 0-RTT not be used for, and why?

**Prerequisite:** Lesson 1.4 (Connection Lifecycle), 2.2 (TCP/UDP, TLS), 2.3 (API paradigms)

**By the end of this lesson you will be able to:**

1. Explain how long polling, SSE, and WebSocket work and how they differ.
2. Decide which suits a given scenario, based on bidirectionality and complexity.
3. Return to the "TaskFlow real-time notification" exercise from Lesson 1.1 and actually pick the solution, with reasoning.

**Tier:** 3 — Design Exercise (actual WebSocket/SSE implementation arrives in the Module 3–4 hands-on work; today is the conceptual foundation)

---

## 0. Where TaskFlow Is Right Now

Do you remember — back in Lesson 1.1, at the very start of the course, we did an exercise about "real-time notifications in TaskFlow"? You wrote something like "socket or push notification" as a non-functional requirement, and I said that was not something to decide yet — it was a _solution_, and it would come later.

**"Later" has arrived.** Today we answer exactly that question — which mechanism to use for pushing notifications from the server to the client, and why.

Let us start from a fundamental problem — HTTP is designed so that **the client asks first and then the server responds**. The server cannot send anything on its own unless the client asks. But "notify immediately when a task is assigned" requires the server to say something proactively, without the client asking! All three of today's solutions come from that basic tension.

---

## 1. Theory

### 1.1 Long Polling — Faking "Push" over HTTP

The simplest (and oldest) solution is **long polling**. The idea is easy: the client sends a request, but the server **does not respond immediately** — it "holds" the request until new data arrives (or a timeout hits). As soon as new data appears, the server sends the response — and the client immediately sends another request, starting the cycle again.

```
Client                                    Server
  │──"any new notifications?"────────────>│
  │                                        │ [request held...
  │                                        │  ...no new data yet...]
  │                                        │
  │                          [30 seconds later, a task gets assigned!]
  │<──"yes, here's the notification"────────│
  │──"any new notifications?"────────────>│ (immediately another request)
  │                                        │ [held again...]
```

**Advantage:** it uses ordinary HTTP, so no special protocol or library is needed — every server, proxy, and firewall understands it.

**Problem:** every "round" needs a new HTTP request and connection (remember the handshake cost from Lesson 1.4?), which is resource-inefficient. And when many clients hold open connections at once, a lot of server resources (threads, connection slots) sit occupied.

### 1.2 SSE (Server-Sent Events) — One-way Push, Still over HTTP

**SSE** is an elegant solution — it opens a **single, persistent HTTP connection**, and the server can keep sending data over it as many times as it likes without closing it. Browsers have a built-in API for this: `EventSource`.

```
Client                                    Server
  │──"open an EventSource connection"────>│
  │<──[connection stays open]──────────────│
  │<──"notification 1"─────────────────────│
  │<──"notification 2"─────────────────────│
  │<──"notification 3"─────────────────────│
  │  (the connection never closes; the server pushes as often as it wants)
```

**Advantages:**

- Unlike long polling, there is no repeated connection setup — one connection carries many events
- The browser provides **automatic reconnection** (if the connection breaks for any reason, `EventSource` retries by itself)
- It works over plain HTTP/1.1 or HTTP/2, so it is firewall- and proxy-friendly

**Limitations:**

- **One-directional only** — data flows server to client, but the client cannot send anything back over SSE (it has to send a normal HTTP request for that)
- Text-based (UTF-8) — binary data cannot easily be sent directly

### 1.3 WebSocket — Fully Bidirectional, Equally Fast Both Ways

**WebSocket** is the most powerful solution — it establishes a genuine **full-duplex connection**, meaning both client and server can send data to each other at any time, independently.

A WebSocket starts as an ordinary HTTP request that uses an "Upgrade" header to say "let's convert this connection from HTTP to the WebSocket protocol":

```
Client                                    Server
  │──HTTP GET + "Upgrade: websocket"──────>│
  │<──"101 Switching Protocols"────────────│
  │ [from here this is no longer an HTTP connection; it is a WebSocket]
  │
  │──"I'm sending a message"──────────────>│
  │<──"notification 1"──────────────────────│
  │──"I'm sending another one"────────────>│
  │<──"notification 2"──────────────────────│
  (data can flow both ways, independently, at any time)
```

**Advantages:**

- Genuinely bidirectional — ideal for chat applications, collaborative editing (many people editing one document), and multiplayer games
- The lowest latency, because once the connection is up there is no new HTTP overhead per message
- Both binary and text data can be sent

**Limitations:**

- The most complexity — you manage connection state and write reconnection logic yourself (not built in as with SSE, though libraries like Socket.io solve this)
- A WebSocket works over a single stream on one connection, so it can suffer TCP-level head-of-line blocking — if a packet is delayed or lost, every message behind it stalls too (that concept from Lesson 2.2, relevant again here)
- Horizontal scaling behind a load balancer gets complicated (remember stateful vs stateless from Lesson 1.6? — a WebSocket connection is itself a stateful thing, bound to one particular server; we go into this in detail in Module 3)

> **Trade-off Table — Long Polling vs SSE vs WebSocket**

| Dimension      | Long Polling                              | SSE                                              | WebSocket                           |
| -------------- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Direction      | Client-initiated, server-delayed response | Server → client (one-way)                        | Both ways (full-duplex)             |
| Connection     | A new request every time                  | One persistent connection                        | One persistent connection           |
| Browser API    | Ordinary `fetch`/XHR                      | `EventSource` (built in)                         | `WebSocket`                         |
| Auto-reconnect | You write it                              | Built in                                         | You write it (or use a library)     |
| Complexity     | Low                                       | Low to medium                                    | High                                |
| Best fit       | A fallback option, simple notifications   | One-way live feeds (stock prices, notifications) | Chat, collaborative editing, gaming |

### 1.4 A New Arrival in 2026 — WebTransport

WebTransport is a new browser API built on HTTP/3 and QUIC (that same QUIC from Lesson 1.4), giving bidirectional communication without needing an "Upgrade" the way WebSocket does — it is natively part of HTTP/3.

Its biggest advantage is that it can carry both reliable streams and "unreliable datagrams" over the same connection, without WebSocket's head-of-line blocking. Within one connection you can say "this message must definitely arrive" (a reliable stream) versus "it's fine if this one is missed, the next will do" (an unreliable datagram — like that "live cursor position" example from Lesson 2.2).

**The current reality, though:** in 2026 WebSocket is still the safest default for real-time communication, because it is supported nearly universally. WebTransport is powerful where you need multiple independent streams or unreliable datagrams, but for ordinary reliable messaging WebSocket is still simpler and good enough. For most teams the right approach is to add WebTransport as an enhancement with WebSocket as a fallback — not to replace it wholesale.

**A practical takeaway:** for a project like TaskFlow, WebSocket is the correct and safe choice today (in 2026). Knowing about WebTransport is worthwhile (it shows where things are heading), but there is no practical reason to use it yet for an internal team tool.

---

## 2. Interview Angle

The classic interview question here — "you're designing a real-time chat feature; would you use WebSocket, SSE, or long polling?" The core of a good answer is starting from the question **"does this need bidirectional communication?"**:

- Chat — bidirectional (both sides send messages) → **WebSocket**
- Stock price ticker, live score updates — one-way (only the server pushes) → **SSE** (WebSocket would work too, but SSE is simpler and sufficient here, avoiding over-engineering)
- A notification badge (our TaskFlow example) — mostly one-way, so SSE is a good fit, though many production systems use WebSocket because one connection can then serve several features at once (chat + notifications + presence)

**An important follow-up an interviewer might ask:** "how would you scale WebSocket horizontally?" — an advanced question that is hard to answer fully yet (it needs Modules 3 and 4), but this much is enough for now: "since a WebSocket connection is stateful and bound to one server, broadcasting messages across multiple servers needs a shared pub/sub layer (like Redis Pub/Sub), so that a client connected to Server A can learn about an event that happened on Server B." That answer shows you understand the problem even though you have not yet learned the full solution.

---

## 3. Key Takeaway

- HTTP's fundamental limitation — the client initiates, the server cannot push on its own — is the reason all three solutions exist
- **Long polling** — repeatedly "holding" requests; simple but resource-inefficient
- **SSE** — one persistent connection, one-directional (server→client), built-in reconnection, plenty for simple use cases
- **WebSocket** — genuinely bidirectional, the most powerful but the most complex; ideal for chat, gaming, and collaborative editing
- Being TCP-based, WebSocket can suffer head-of-line blocking; WebTransport (on HTTP/3 and QUIC) solves that, but WebSocket remains the practical default in 2026
- The key decision question: do you need bidirectionality? — pick WebSocket or SSE accordingly

---

## 4. New Terms (Glossary)

| Term                         | Meaning                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Long Polling**             | The server holds a client's request open until new data arrives                                       |
| **SSE (Server-Sent Events)** | A persistent, one-directional (server→client) HTTP connection                                         |
| **WebSocket**                | A persistent, bidirectional (full-duplex) connection, started with an HTTP "Upgrade"                  |
| **Full-Duplex**              | A communication channel where both sides can send data at the same time, independently                |
| **WebTransport**             | A new bidirectional API on HTTP/3 and QUIC, supporting both reliable streams and unreliable datagrams |

---

## 5. Reflection Questions

1. Go back to the "real-time notification" exercise from Lesson 1.1. Now that you have learned this lesson, which would you choose — long polling, SSE, or WebSocket? Give your reasons (think about whether TaskFlow only needs to push notifications, or needs something bidirectional).
2. Why is a WebSocket "stateful" (the term from Lesson 1.6) — and what challenge does that create for horizontal scaling? Answer briefly, in your own words.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** For TaskFlow's "notify on task assignment" use case, the core need is pushing from server to client — the client does not have to _send_ anything in this flow (it only receives). So strictly for this use case **SSE** is sufficient and sensible — simpler, with built-in reconnection, avoiding over-engineering. In practice, though, if TaskFlow plans to add chat or live collaboration later, choosing **WebSocket** from the start (even without needing bidirectionality today) can be a reasonable forward-looking decision, so you do not have to build a second mechanism later. Both answers are defensible — what matters is stating the reasoning clearly.

**Question 2:** A WebSocket connection is persistently bound between one particular client and one particular server — that connection sits in the server's memory as "state" (which client is connected to which server). Under horizontal scaling with several servers, if Client A is connected to Server 1 but an event triggers on Server 2 (perhaps another request landed there), Server 2 cannot tell Client A anything by itself — because the connection to Client A belongs to Server 1. Solving this needs a shared coordination mechanism (such as Redis Pub/Sub) so all servers can share "who is holding which client".

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** Three new features have been proposed for TaskFlow. For each, say whether you would use long polling, SSE, or WebSocket, and why (considering the need for bidirectionality and the complexity trade-off):
>
> 1. **"Team Presence Indicator"** — showing everyone, with a green dot, who is currently online and active in TaskFlow
> 2. **"Live Comment Thread"** — everyone can comment under a task, and new comments appear on everyone's screen immediately (including a typing indicator — "Alex is typing...")
> 3. **"Simple Server Status Page"** — an internal page where TaskFlow's server CPU and memory usage refresh every 5 seconds, viewed by a handful of admins

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, 2.1, 2.2, 2.3
Current: 2.4 — WebSocket, SSE, Long Polling
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): [System Design, Trade-off, Requirements, Scope, Estimation,
HLD/Deep Dive, DAU/QPS, TCP Handshake, TLS, Latency/Throughput, Availability/
Reliability, SLA/SLO/Error Budget, Scaling, Stateless/Stateful]
Terms learned (Module 2 so far): DNS, TTL, Recursive/Iterative Query, DoH/DoT,
TCP vs UDP, Cipher Suite, 0-RTT, REST, GraphQL, N+1 Problem, gRPC, Protobuf,
Long Polling, SSE, WebSocket, Full-Duplex, WebTransport
Weak spots: covering every sub-part of a multi-part question; when stating a trade-off,
naming the cost — what you give up — not only the benefit (this gap showed in the
GraphQL answer in 2.3). That is the main focus area now; everything else is improving well
Next: 2.5 — API Design at Scale (Versioning, Pagination, Idempotency Key, Error Contract)
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 2.5, the last lesson of Module 2: API design at scale — versioning, pagination, idempotency keys, and error contracts. It is a particularly important lesson, because without idempotency no API is safe in the face of retries.
