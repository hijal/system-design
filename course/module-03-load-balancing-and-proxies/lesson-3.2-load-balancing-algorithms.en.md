# Lesson 3.2 — Load Balancing Algorithms: Round Robin, Least Connections, Consistent Hashing (Intro)

**Module 3 — Load Balancing & Proxies**

> **Spaced Repetition (Lesson 2.4):** Why is SSE one-directional (server→client only)? And for a notification use case like TaskFlow's, why might SSE often still be a better choice than WebSocket despite that limitation?

**Prerequisite:** Lesson 3.1 (Load Balancer, L4/L7)

**By the end of this lesson you will be able to:**

1. Understand how Round Robin, Weighted Round Robin, and Least Connections work, and when each fits.
2. Grasp the basic idea of IP hash and consistent hashing (in the context of session affinity) — an introduction, with full depth in Module 10.1.
3. Look at TaskFlow's specific traffic pattern and pick the right algorithm.

**Tier:** 3 — Design Exercise

---

## 0. Where TaskFlow Is Right Now

In Lesson 3.1 we learned that a load balancer decides **where** a request goes (L4 vs L7, which backend pool). But one question is still open — if three identical servers sit behind the LB, **which one does this particular request go to right now**? At random? In turn? By some other logic? That is today's subject — the **decision algorithm** inside the LB.

---

## 1. Theory

### 1.1 Round Robin — the Simplest, Taking Turns

**Round Robin** is the simplest algorithm — requests go to each server in turn, in order:

```
Request 1 -> Server A
Request 2 -> Server B
Request 3 -> Server C
Request 4 -> Server A   (back to the start)
Request 5 -> Server B
...
```

**Advantage:** the easiest to implement, with no extra state to track (a single "who's next" counter is enough).

**Problem:** it assumes **every server has equal capacity and every request costs roughly the same to process.** When either assumption is false, problems appear. For example, if Server A's hardware is weaker than B's and C's, Round Robin still gives all three an equal share, and Server A overloads quickly.

**Weighted Round Robin** is one fix — each server gets a "weight" matching its capacity:

```
Server A (weight 1) — weaker hardware
Server B (weight 2) — stronger hardware
Server C (weight 2) — stronger hardware

Distribution: A, B, C, B, C, A, B, C, B, C ...
(B and C receive twice as many requests as A)
```

### 1.2 Least Connections — Sending to Whoever Is Least Busy

Round Robin has a deeper problem — it knows "who gets the next one" but not **how busy each server is right now**. Take TaskFlow's "Export to PDF" feature (remember the Module 1 exit challenge?) — those requests can take seconds to process, while an ordinary `GET /api/tasks` finishes in milliseconds. If Round Robin keeps handing Server A these heavy PDF export requests, it will keep sending it new ones even while it is busy, simply because "its turn has come" — which is not fair and creates genuinely unequal load.

The **Least Connections** algorithm fixes this — it tracks **how many active connections or requests each server currently has**, and always sends the new request to the **least busy** one:

```
Right now:
Server A — 12 active connections (processing heavy requests)
Server B — 3 active connections
Server C — 5 active connections

A new request arrives -> it goes to Server B (least busy)
```

**When this matters most:** when request processing times **vary widely** (some fast, some slow) — then splitting request counts evenly (Round Robin) is not enough, and looking at actual load (who is busy right now) is far more accurate.

### 1.3 IP Hash / Session Affinity — Same Client, Same Server (an Introduction)

Sometimes you want **the same client to keep reaching the same server** (called **session affinity** or a **sticky session**). One simple implementation hashes the client's IP address and picks a server from that hash:

```
hash(client_IP) % number_of_servers = which server
```

**Why you might need this:** recall the stateful vs stateless discussion from Lesson 1.6 — suppose TaskFlow rushed out a feature where session data still lives in local server memory (not yet migrated to Redis; not ideal, but this kind of technical debt is real). In that situation, sending the same user to the same server every time (via IP hash) can be a **temporary workaround** until it is properly made stateless.

**But there is a big problem — adding or removing a server upends everything:**

```
With 3 servers: hash(IP) % 3
Add one to make 4: hash(IP) % 4

The same client IP can give completely different results under % 3 and % 4 —
meaning nearly every client suddenly lands on a different server!
```

That is exactly the problem **consistent hashing** solves — a more sophisticated hashing technique where adding or removing a server re-maps only **a small fraction** of clients, not almost all of them. It is such an important and deep topic (used not only in load balancing but in distributed database sharding, CDN routing, and much else) that we have given it **an entire separate lesson — Module 10.1**. For today, just know this: the problem (all hashes collapsing when the server count changes) exists, and there is an elegant solution we will go into later.

> **Trade-off Table — LB Algorithms**

| Algorithm            | What it considers               | Best fit                                       | Limitation                                                                    |
| -------------------- | ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Round Robin          | Nothing, just order             | Uniform server capacity, uniform request cost  | Unfair when capacity or request cost varies                                   |
| Weighted Round Robin | Server capacity (manual weight) | A pool of servers with different capacities    | Weights must be set manually; not dynamic                                     |
| Least Connections    | Current active load             | Widely varying request processing times        | Slightly more overhead (state must be tracked)                                |
| IP Hash              | Client identity                 | When session affinity is needed (a workaround) | Big disruption when servers are added or removed (without consistent hashing) |

---

## 2. Interview Angle

A common question — "some of your backend endpoints are fast (a few ms) and some are slow (several seconds) — which LB algorithm would you choose?" The right answer is **Least Connections**, because under Round Robin the slow requests can tie up a server while its next "turn" brings it more new requests anyway, breaking fair load distribution.

Another question that connects directly to Lesson 1.6 — "is session affinity (sticky sessions) good practice?" A good answer says **it is a workaround, not the ideal solution.** The right approach is making the application stateless (Lesson 1.6, an external session store), so that **any request can go to any server with no session affinity at all** — which makes horizontal scaling maximally flexible and resilient (if one server goes down, no user is blocked, because nothing was pinned to it).

---

## 3. Key Takeaway

- **Round Robin** — simple, sequential, assuming uniform capacity and cost
- **Weighted Round Robin** — handles differing server capacity with manual weights
- **Least Connections** — routes by current active load, fairer when request costs vary
- **IP hash / session affinity** — pins a client to one server, but changing the server count causes big disruption
- **Consistent hashing** solves that disruption problem — details in Module 10.1
- Session affinity is a workaround; a stateless architecture (Lesson 1.6) is the ideal long-term solution

---

## 4. New Terms (Glossary)

| Term                                  | Meaning                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Round Robin**                       | An algorithm sending requests to each server in turn, in order                               |
| **Weighted Round Robin**              | Splitting requests in different proportions according to each server's capacity              |
| **Least Connections**                 | Sending a new request to whichever server has the fewest active connections                  |
| **Session Affinity (Sticky Session)** | Repeatedly sending the same client to the same backend server                                |
| **IP Hash**                           | Picking a specific server by hashing the client's IP                                         |
| **Consistent Hashing**                | A hashing technique where most mappings survive a change in the server count (details later) |

---

## 5. Reflection Questions

1. Most TaskFlow endpoints (task CRUD) are fast and cost roughly the same, but "Export to PDF" (remember the exit challenge?) arrives occasionally and takes time. Which algorithm would you propose for this mixed traffic pattern, and why?
2. If all of TaskFlow's servers were properly stateless (per Lesson 1.6), would there be any need for IP hash or session affinity? Why or why not?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** **Least Connections** is the most sensible here, because request processing costs vary widely (fast CRUD vs slow PDF export). Under Round Robin, a server busy with a PDF export still receives new requests on its next turn, overloading it further. Least Connections automatically avoids the busy server and sends new requests to a less busy one.

**Question 2:** If every server is genuinely stateless (sessions, files, everything in external stores), then **IP hash and session affinity are unnecessary** — any server can handle any request without depending on where the previous one went. In that case Round Robin or Least Connections is better, because they distribute traffic most flexibly and evenly, with no unnecessary constraint like session affinity.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow has four server instances. Which LB algorithm would you propose for each of the three situations below, and why:
>
> 1. All four servers have identical hardware, and every TaskFlow endpoint is roughly equally fast (an ordinary CRUD app)
> 2. One server was recently upgraded (double the CPU and RAM), while the other three are still on the old hardware
> 3. TaskFlow has a legacy feature still keeping some temporary state in local server memory (making it stateless is still pending, marked as technical debt) — for now you have to work around this limitation

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (complete) + Module 2 (complete), 3.1
Current: 3.2 — LB Algorithms
TaskFlow state: multi-instance transition — stateless Express server instances,
a single Postgres, a ~100-user base, with the horizontal-scale architecture now established
Terms learned (Module 3 so far): Load Balancer, L4/L7, SSL Termination,
Content-based Routing, Round Robin, Weighted Round Robin, Least Connections,
Session Affinity, IP Hash, Consistent Hashing (intro)
Weak spots: reaching the right answer but justifying it with the wrong or irrelevant reason
(the Idempotency-Key vs Host-header confusion in 3.1) — build the habit of identifying
exactly which specific factor drives a decision
Next: 3.3 — Reverse Proxy vs Forward Proxy, Nginx Hands-on
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 3.3: reverse proxy vs forward proxy, where we do our first **Nginx hands-on** (Tier 2 — a Docker and config-based exercise).
