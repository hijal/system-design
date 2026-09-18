# Lesson 3.1 — What a Load Balancer Is, Why You Need One, L4 vs L7

**Module 3 — Load Balancing & Proxies**

> **Spaced Repetition (Lesson 2.3):** What were the "three questions" in the framework for deciding between REST, GraphQL, and gRPC?

**Prerequisite:** Lesson 1.6 (Vertical/Horizontal Scaling, Stateless/Stateful)

**By the end of this lesson you will be able to:**

1. Understand what a load balancer does and why it is essential for horizontal scaling.
2. Explain the difference between L4 (transport layer) and L7 (application layer) load balancing, and the trade-offs of each.
3. Look at a given scenario and say whether an L4 or L7 load balancer fits.

**Tier:** 3 — Design Exercise (hands-on Nginx configuration arrives in Lesson 3.3)

---

## 0. Where TaskFlow Is Right Now

In Lesson 1.6 we said that horizontal scaling requires making the server **stateless** first. Let us assume the TaskFlow team has done that — session data and uploaded files have all moved to external stores. TaskFlow now runs **three identical Express server instances**, same codebase, connected to the same database.

But that creates a new problem — when a client (browser) sends a request to `taskflow.app`, **which server does it go to**? The client does not know there are three servers; it only knows one domain name. Somebody has to do this job — **intelligently distributing requests** across those three servers. That is exactly what a **load balancer** does — and Module 3 starts right here.

---

## 1. Theory

### 1.1 What a Load Balancer Is and Why You Need One

A **load balancer (LB)** is a component that sits between the client and multiple backend servers, deciding which server each incoming request goes to.

```
                          ┌──> [Server 1]
[Client] ──> [Load Balancer] ──> [Server 2]
                          └──> [Server 3]
```

**A load balancer's main responsibilities:**

1. **Distributing traffic** — so no one server gets overloaded while the others sit idle
2. **Failover and health checks** — if Server 2 goes down, the LB detects it and stops sending requests there, routing to the live servers instead (covered in detail in Lesson 3.4)
3. **Providing a single entry point** — the client only needs to know one address (the LB's); it never needs to know how many servers are behind it

Notice — without a load balancer, horizontal scaling is **meaningless**. Three servers are useless if everything goes manually to one specific server's IP. This is the "missing piece" we left as a black box back in Lesson 1.6.

### 1.2 L4 (Transport Layer) Load Balancing

An **L4 load balancer**, as the name suggests, works at **layer 4 (the transport layer)** of the OSI model — meaning it only looks at **IP addresses and ports**, and **does not look inside the request** (it understands nothing of HTTP headers or URL paths; it just forwards packets).

```
Client ──[TCP packet: dest=LB_IP:443]──> L4 LB
                                            │
                          [looks only at IP/port, picks a backend]
                                            │
                                            ▼
                                     [forwards to Server IP:Port]
```

**Advantages:**

- **Extremely fast** — it never parses the packet's contents, deciding purely from headers
- Low overhead, high throughput — it can handle hundreds of thousands of connections per second
- Works for any TCP/UDP traffic, not just HTTP (balancing database connections, for instance)

**Limitations:**

- **It cannot do content-aware routing** — a decision like "send `/api/*` to one backend and `/static/*` to another" is impossible for L4, because it never sees the URL path
- Cookie-based or header-based routing is not possible

### 1.3 L7 (Application Layer) Load Balancing

An **L7 load balancer** works at **layer 7 (the application layer)** — meaning it **reads and understands** the entire HTTP request: URL path, headers, cookies, method (GET/POST), all of it.

```
Client ──[HTTP GET /api/tasks, Cookie: session=xyz]──> L7 LB
                                                          │
                          [sees the URL path, headers, and cookies, and makes
                           an intelligent routing decision]
                                                          │
                                                          ▼
                                          [forwards to a specific backend,
                                           possibly modifying headers on the way]
```

**Advantages:**

- **Content-based routing** — `/api/*` can go to the API server and `/images/*` to a static file server
- **Cookie-based sticky sessions** are possible (the same user always reaching the same server — though by the stateless principle from Lesson 1.6 this is not the ideal solution, it is used in practice; details in Lesson 3.4)
- It can do SSL/TLS termination (HTTPS facing the client, plain internal HTTP to the backend — moving the encryption overhead off the backends and centralising it at the LB)

**Limitations:**

- **More overhead** — it must parse each request's full HTTP content, so it is slower and needs more resources than L4
- More complexity — configuration and routing rules are all more sophisticated

> **Trade-off Table — L4 vs L7 Load Balancer**

| Dimension             | L4                                                                  | L7                                                   |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| What it sees          | IP address, port                                                    | The whole HTTP request (URL, headers, cookies, body) |
| Speed/Overhead        | Extremely fast, low overhead                                        | Comparatively slower, more overhead                  |
| Content-based routing | No                                                                  | Yes (`/api/*` vs `/static/*`)                        |
| SSL termination       | Usually not (pass-through)                                          | Yes                                                  |
| Protocol              | Any TCP/UDP                                                         | Mainly HTTP/HTTPS                                    |
| Best fit              | Raw performance-critical, non-HTTP traffic (databases, generic TCP) | Web applications and APIs needing smart routing      |

### 1.4 What Is Actually Used in 2026

In the context of your stack (Express + SvelteKit + Cloudflare), this matters — which tool gets picked when:

- Nginx is the best general-purpose L7 reverse proxy — it should be the default choice in most cases, unless there is a specific reason for something else
- HAProxy is best when the routing logic is simple and raw performance/throughput is what matters most — it is not a web server, it only balances, nothing else (it does not serve static files or cache)
- Envoy is a high-performance proxy especially suited to microservices and gRPC, and it is used as the data plane in service meshes — but the cost is much more operational complexity; for a simple two-backend website it is overkill
- HAProxy still has no production-ready HTTP/3 support — even in early 2026 it is marked "experimental" for high-traffic deployments, so Nginx or Envoy is used where HTTP/3 is needed

**A practical takeaway:** since TaskFlow is an HTTP-based web application (an Express API plus a SvelteKit frontend), **an L7 load balancer like Nginx** is the natural choice — and that is what we build hands-on in the next lesson (3.3). If TaskFlow later splits into microservices using gRPC (Module 9), Envoy becomes a reasonable upgrade path to consider.

---

## 2. Interview Angle

A common interview question — "when setting up a load balancer, would you pick L4 or L7?" The core of a good answer: **if the routing decision requires knowing what is inside the request (URL, headers, cookies), L7 is mandatory — not optional.** But if you only need raw traffic distribution with no smart routing, and performance matters most (balancing a database connection pool, say), L4 is sufficient and more efficient.

A frequent follow-up — "can one LB sit in front of another?" — yes, and it is common in practice: an **L4 LB first takes raw traffic and splits it across large regional clusters (for speed), and then inside each cluster an L7 LB does smart, content-based routing**. This kind of layered architecture is common at large companies (Google, Netflix).

---

## 3. Key Takeaway

- A load balancer sits between the client and multiple backend servers distributing traffic — an essential part of horizontal scaling
- **L4** — sees only IP and port, extremely fast, but cannot do content-based routing
- **L7** — understands the whole HTTP request (URL, headers, cookies), can route intelligently, but has more overhead
- Web applications and APIs usually need L7 (path-based routing, SSL termination); pure raw traffic is fine with L4, which is more efficient
- In 2026, Nginx is the default for general-purpose L7, HAProxy leads on pure L4/L7 performance, and Envoy dominates microservices and gRPC

---

## 4. New Terms (Glossary)

| Term                            | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| **Load Balancer (LB)**          | A component distributing traffic between the client and multiple backend servers         |
| **L4 (Layer 4) Load Balancing** | Working at the transport layer, routing purely on IP and port                            |
| **L7 (Layer 7) Load Balancing** | Working at the application layer, routing on HTTP content                                |
| **SSL/TLS Termination**         | Decrypting client-facing HTTPS at the LB and talking plain internal HTTP to the backends |
| **Content-based Routing**       | Sending requests to different backends based on URL path, headers, or cookies            |

---

## 5. Reflection Questions

1. In a TaskFlow architecture, `/api/*` requests go to the Express backend and `/assets/*` requests (images, CSS, JS) go straight to a static file server. Does this need an L4 or an L7 load balancer, and why?
2. For an internal database connection pooler (distributing connections from many app servers to a database cluster) — which seems more appropriate, L4 or L7, and why?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** This needs **L7**, because the decision depends on the URL path (`/api/*` vs `/assets/*`) — exactly the content-based routing only L7 can do, since L4 never gets to see the URL path (it operates purely at the IP/port level).

**Question 2:** Here **L4 is more appropriate**, because a database connection has no "URL path" or "HTTP header" to judge by (it is a raw TCP connection, not HTTP at all) — deciding which server receives the connection is all that is needed, and here performance (low latency, high throughput) matters most, which is exactly L4's strength.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow is scaling horizontally now — three Express server instances. At the moment there are three different kinds of traffic:
>
> 1. `/api/tasks`, `/api/users` — the main application API (JSON responses)
> 2. `/health` — a lightweight endpoint returning just "OK", called by the monitoring system every few seconds
> 3. A separate internal service — TaskFlow's background job workers connecting to Redis (raw TCP, not HTTP)
>
> Questions:
>
> 1. Do #1 and #2 need L4 or L7? Can one LB handle both?
> 2. What kind of load balancing does #3 need, and why is it fundamentally different from #1 and #2?
> 3. If TaskFlow later wants to route `api.taskflow.app` (the partner API from the Module 2 exit challenge) to a separate backend cluster from the main app — how would that be possible, with L4 or L7?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (complete) + Module 2 (complete)
Current: 3.1 — Load Balancer, L4 vs L7
TaskFlow state: the multi-instance transition has begun — three stateless Express server
instances (conceptually), a single Postgres, a ~100-user base but an architecture that is
now horizontal-scale-ready
Terms learned (Modules 1 & 2): [all previous terms retained]
Terms learned (Module 3 so far): Load Balancer, L4/L7 Load Balancing, SSL/TLS Termination,
Content-based Routing
Weak spots: covering every sub-part of a multi-part question; stating trade-offs and costs
clearly (much improved through Module 2); re-checking whether a trade-off you identified
could actually be avoided (this gap showed in the TLS question of the Module 2 exit challenge)
Next: 3.2 — LB Algorithms (Round Robin, Least Connections, Consistent Hashing — intro)
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 3.2: load balancing algorithms — Round Robin, Least Connections, and an introduction to consistent hashing (full depth later, in Module 10.1).
