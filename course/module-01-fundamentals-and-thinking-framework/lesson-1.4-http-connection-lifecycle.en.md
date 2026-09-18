# Lesson 1.4 — Client–Server, HTTP/HTTPS, Connection Lifecycle, Keep-Alive, HTTP/2 vs HTTP/3

**Module 1 — Foundations of Scalability and System Design Principles**

> **Spaced Repetition (Lesson 1.3):** Roughly how many times faster is a memory (RAM) read than a disk (SSD) read — and which important system design concept is built on that gap?

---

**Prerequisite:** Lesson 1.1, 1.2, 1.3

**By the end of this lesson you will be able to:**

1. Walk through the entire journey, step by step, from typing a URL in the browser to the response arriving.
2. Understand what a TCP connection, a TLS handshake, and keep-alive actually do — and why building a fresh connection for every request is expensive.
3. Explain the core differences between HTTP/1.1, HTTP/2, and HTTP/3, and which problem each one arrived to solve.

**Tier:** 3 — Design Exercise (conceptual today, no code needed; doing connection-level work hands-on requires packet-capture tooling that is outside this course's scope)

---

## 0. Where TaskFlow Is Right Now

So far we have treated TaskFlow as a box — an arrow between "Client" and "Server", and that was it. But inside the arrow you drew in the Lesson 1.2 high-level design (`[Client] <---> [Express Server]`) there are **many hidden steps** that we have been leaving as a black box.

Today we go inside that arrow. Because when you say "the notification must arrive within 300ms" (a non-functional requirement from Lesson 1.3), part of that 300ms is spent purely on establishing the connection — before any of the request's actual data is sent. Miss that hidden cost and your latency budget will be wrong.

---

## 1. Theory

### 1.1 From URL to Response — the Whole Journey

You type `https://taskflow.app/api/tasks` in the browser. Here is what happens after you press enter:

```
1. DNS lookup        →  the name "taskflow.app" is resolved to an IP address
                          (we cover this fully in Lesson 2.1; just noting it today)
2. TCP connection    →  a "connection" is established between client and server
   (3-way handshake)
3. TLS handshake     →  (only for HTTPS) keys are exchanged to encrypt the connection
4. Send HTTP request →  the client sends the request (method, headers, body)
5. Server processing →  the server handles the request (DB queries and so on)
6. HTTP response     →  the server sends the response
7. Close or reuse    →  the connection closes, or is kept for the next request
```

Today's lesson is mostly about steps 2, 3, and 7 — because those are the most misunderstood, and they contribute the latency you cannot see.

### 1.2 TCP Connection — the 3-Way Handshake

Before any data moves between client and server, they have to establish a "connection" — rather like a phone call, where you confirm "hello, can you hear me?" before talking.

It happens in three steps (hence "3-way handshake"):

```
Client                              Server
  │                                    │
  │ ────────── SYN ──────────────────>│   "I want to connect"
  │                                    │
  │ <───────── SYN-ACK ────────────────│   "Fine, I'm willing too"
  │                                    │
  │ ────────── ACK ──────────────────>│   "Confirmed, let's start"
  │                                    │
  │ [connection established, data can flow] │
```

Notice — **three network messages have already gone by before any actual data (your HTTP request) is sent.** If the round trip time (RTT) between client and server is 50ms (remember the latency table from Lesson 1.3?), establishing the connection alone costs about one and a half round trips' worth of time.

### 1.3 TLS Handshake — When HTTPS Is Used

Once the TCP connection exists, if it is HTTPS (which nearly every production system uses today), another step is needed — the **TLS handshake**. Its job is to get client and server to agree on a secret encryption key, so nobody in the middle can read what passes between them.

```
Client                              Server
  │ ─────── "Hello, here are the ciphers I support" ──────>│
  │ <────── "OK, let's use this one + here's my certificate" ──│
  │ ─────── key exchange complete ───────────────────────>│
  │ [connection encrypted; HTTP request can now be sent]    │
```

This adds another one or two round trips (it depends on the TLS version — TLS 1.3 optimised this down to one round trip; TLS 1.2 needed two).

**The core point:** between the TCP handshake and the TLS handshake, two to three network round trips are spent _before_ your actual data goes out. If the client is far from the server (a different continent, RTT ~150ms from the Lesson 1.3 table), just establishing the connection can cost **300–450ms** — before the real request and response even begin.

This is exactly why things like CDNs (Module 4.5) and multi-region deployment (Module 10.8) matter — putting a server closer to the client shrinks this handshake cost too.

### 1.4 Keep-Alive — Not Doing the Handshake Over and Over

Now the question: if every HTTP request needed a new TCP + TLS handshake, then loading a single web page (which might need 50 resources — CSS, JS, images) would be unbearably slow.

The answer is **keep-alive** (also called a **persistent connection**). It means: once a TCP+TLS connection is established, do not close it — **reuse it for multiple request-response pairs**.

```
[one connection established — TCP + TLS handshake, once]
        │
        ├──> Request 1 (GET /api/tasks)  → Response 1
        ├──> Request 2 (GET /api/user)   → Response 2
        ├──> Request 3 (POST /api/task)  → Response 3
        │
[closes after an idle timeout (typically seconds to minutes)]
```

For your Express server, think of it this way: Node.js's `http` module supports HTTP keep-alive by default. And this is the same reason you use the `pool` option in Sequelize for database connections — it solves the identical underlying problem, just for database connections. **Creating a connection is expensive, so reuse it** — the same principle applies to TCP connections, database connections, even Redis connections (you will see this in Module 4.4). This is a repeating pattern in system design, not something specific to HTTP.

> **A common interview question:** "Why does keep-alive matter?" — answering just "it's faster" is incomplete. A good answer: "Every new connection costs extra round trips for the TCP handshake, plus the TLS handshake if it is HTTPS, which adds meaningful latency proportional to RTT. Keep-alive pays that cost once and amortises it across many requests."

### 1.5 HTTP/1.1 → HTTP/2 → HTTP/3 — Why It Evolved

**The HTTP/1.1 problem — head-of-line blocking:**

In HTTP/1.1, only one request can be "in flight" on a connection at a time (even with keep-alive, requests generally go sequentially — browsers work around this by opening up to six parallel connections per domain, but that is still a limit, and each connection carries its own handshake cost).

```
HTTP/1.1 — on one connection:
Request 1 ──> [wait for response 1] ──> Request 2 ──> [wait] ──> Request 3
     (if one request stalls, everything behind it stalls too)
```

**HTTP/2's answer — multiplexing:**

HTTP/2 can carry **many request-response pairs simultaneously** over a single TCP connection, with no one waiting on another.

```
HTTP/2 — on one connection:
Request 1 ─┐
Request 2 ─┼──> [all "in flight"; whichever response is ready first arrives first]
Request 3 ─┘
```

This cuts page load time dramatically, because 50 resources no longer have to be split across six connections and loaded sequentially.

**HTTP/2's own problem — TCP-level head-of-line blocking:**

HTTP/2 multiplexes at the application layer, but it still sits on top of TCP. And TCP itself guarantees that data arrives **in order**. So if a single TCP packet is lost (packet loss is a normal event on a network, especially on mobile), TCP **waits** for that one packet — even if every packet after it has already arrived. As a result, all of HTTP/2's multiplexed streams stall **together**, over one packet.

**HTTP/3's answer — QUIC (built on UDP):**

HTTP/3 takes a completely different approach — it does not use TCP at all, but a new protocol called **QUIC**, built on UDP. QUIC handles multiple independent streams internally, so when a packet is lost in one stream, **only that stream** waits while the others keep going.

QUIC has another big advantage — it **combines** the TCP handshake and the TLS handshake into one (because with TLS 1.3, encryption is built into QUIC itself), cutting the number of round trips needed to establish a connection even further.

> **Trade-off Table — Comparing the HTTP Versions**

|                       | HTTP/1.1                                               | HTTP/2                    | HTTP/3                                      |
| --------------------- | ------------------------------------------------------ | ------------------------- | ------------------------------------------- |
| Transport             | TCP                                                    | TCP                       | QUIC (UDP-based)                            |
| Multiplexing          | No (browsers work around it with parallel connections) | Yes, on one connection    | Yes, with stream-level isolation            |
| Head-of-line blocking | Severe, at the application level                       | Remains, at the TCP level | Largely solved                              |
| Connection setup cost | High (needs multiple connections)                      | Lower                     | Lowest (handshakes combined)                |
| Adoption              | Supported everywhere                                   | Widely used               | Growing, but not yet universal across infra |
| Complexity            | Simple                                                 | Moderate                  | Complex (a whole new protocol stack)        |

**In the context of your stack:** Cloudflare automatically supports both HTTP/2 and HTTP/3 when it proxies your traffic — so this is something that happens "in the layer below", and your Express code never has to be aware of it. But knowing it matters in an interview, because it shows you understand that performance is determined at the network layer too, not only in application code.

---

## 2. Interview Angle

This topic shows up more often in "networking fundamentals" or "performance" discussions than in a system design round proper, but a common follow-up in system design interviews is:

> "Your API latency is high — walk me through where the time could be going."

A good answer identifies each stage separately: DNS lookup, TCP handshake, TLS handshake, server processing, and response transfer. People who stop at "the database query might be slow" are seeing half the picture — connection-level latency matters just as much, especially when the client is geographically far from the server.

Another common question: "Why does keep-alive matter, or why does connection pooling matter?" — this connects directly to your experience with Sequelize's `pool`. Exactly as creating database connections repeatedly is expensive (hence the pool), HTTP connections are reused for the same reason. **That single principle — connection reuse — keeps coming back throughout system design**, so it helps to remember this lesson not as networking trivia but as the first instance of a repeating pattern.

---

## 3. Key Takeaway

- Getting from URL to response actually takes seven stages: DNS → TCP handshake → TLS handshake → request → processing → response → close/reuse
- The TCP 3-way handshake (SYN, SYN-ACK, ACK) spends network round trips _before_ any real data is sent
- The TLS handshake (for HTTPS) adds more round trips — TLS 1.3 optimised this
- Keep-alive / persistent connections reuse one connection for many requests, avoiding repeated handshakes
- This "connection reuse" principle is not HTTP-specific — database connection pools and Redis connections follow the same logic
- HTTP/1.1's problem: head-of-line blocking and limited parallelism
- HTTP/2 solves it with multiplexing (many requests at once on one connection), but TCP-level blocking remains
- HTTP/3 (QUIC) solves that: UDP-based, per-stream isolation, and the fastest connection setup

---

## 4. New Terms (Glossary)

| Term                                   | Meaning                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **TCP 3-Way Handshake**                | The three-step process of establishing a connection between client and server (SYN, SYN-ACK, ACK) |
| **TLS Handshake**                      | The key-exchange process that encrypts an HTTPS connection                                        |
| **RTT (Round Trip Time)**              | The time for a packet to travel from client to server and back                                    |
| **Keep-Alive (Persistent Connection)** | Reusing one open connection for multiple request-response pairs instead of closing it             |
| **Head-of-Line Blocking**              | When one stalled request or packet holds up everything queued behind it                           |
| **Multiplexing**                       | The ability to send multiple independent request-response pairs concurrently over one connection  |
| **QUIC**                               | The UDP-based transport protocol underneath HTTP/3, which solves per-stream head-of-line blocking |

---

## 5. Reflection Questions

Think it through yourself first, then open the answer key.

1. Say a TaskFlow user is in the Middle East and your server is in Singapore, with an RTT of ~100ms. If HTTPS is used (TLS 1.2, which needs two round trips for TLS) — roughly how long does establishing the connection take (TCP + TLS, before the actual request is sent)?
2. If you loaded a page needing 10 separate resources (images, CSS, JS) **without** keep-alive — a new connection per request — how does that compare to having keep-alive? Explain in your own words.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The TCP handshake takes 1 RTT (SYN + SYN-ACK count as one RTT, and data starts flowing with the ACK — conventionally counted as 1 RTT). TLS 1.2 adds another 2 RTT. Total = 3 RTT × 100ms = **~300ms**, just to establish the connection, before any request or response. This is why geographic distance has such a large effect on latency, and why CDNs and multi-region deployments (coming in later modules) matter.

**Question 2:** Without keep-alive, every resource needs its own TCP (and TLS) handshake — so 10 resources means paying the connection overhead 10 times. With keep-alive, one connection is established and reused for all 10 requests, so the handshake cost is paid once. This cuts page load time significantly, especially on high-RTT networks (mobile, or distant users).

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

A short reasoning exercise applying the connection lifecycle to a real situation.

> **Scenario:** TaskFlow is adding a "Live Dashboard" feature, where the user's browser polls the server every 2 seconds to check for new task status (not WebSocket yet — just repeated HTTP requests, i.e. polling).
>
> Think it through and write:
>
> 1. If keep-alive is **active**, does the request going out every 2 seconds need a fresh TCP+TLS handshake? Why or why not?
> 2. If the server's keep-alive timeout is set very **low** (say 1 second) while the client polls every 2 seconds — what problem does that create?
> 3. From this scenario, what trade-off do you see in choosing a keep-alive timeout (very short vs very long — what does each cost)?

I am not expecting exact engineering numbers here — I want to see your reasoning, and whether you can apply the connection lifecycle concept to a real scenario.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: 1.1, 1.2, 1.3
Current: 1.4 — Client–Server, HTTP/HTTPS, Connection Lifecycle, Keep-Alive, HTTP/2 vs HTTP/3
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement, Scope, Back-of-the-envelope Estimation, High-Level Design,
Deep Dive, Black Box, DAU, QPS, Peak QPS, Order of Magnitude, Bandwidth,
TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC
Weak spots: mixing up solution and constraint in functional/non-functional (improving);
treating UI state as a component in the HLD; taking assumptions without reading the
requirement carefully (the read/log slip in 1.3) — these small inattention errors are
decreasing lesson by lesson
Next: 1.5 — Latency, Throughput, Availability, Reliability + SLA/SLO/Error Budget
=======================
```

---

## 8. Next Lesson

Send the exercise over — I want to see how you apply the connection lifecycle reasoning. When you are ready, write `next` — we move to Lesson 1.5, with concrete definitions of latency, throughput, availability, and reliability, plus SLA, SLO, and error budgets. You have already brushed against these in pieces; now we tie them together formally.
