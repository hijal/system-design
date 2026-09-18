# Lesson 3.4 — Health Checks, Failover, Sticky Sessions, Graceful Shutdown

**Module 3 — Load Balancing & Proxies**

> **Spaced Repetition (Lesson 2.1):** What do you gain and what do you lose by keeping a low DNS TTL? And what should you do about the TTL before a server migration?

**Prerequisite:** Lessons 3.1–3.3

**By the end of this lesson you will be able to:**

1. Understand the difference between passive and active health checks, and know which one open-source Nginx gives you by default.
2. Explain how failover works (how a request reaches another backend when one fails).
3. Understand the real problems with sticky sessions (the limits of IP-based affinity) and why graceful shutdown matters during deployment.

**Tier:** 3 — Design Exercise (with an optional hands-on suggestion extending the Lesson 3.3 Docker setup)

---

## 0. Where TaskFlow Is Right Now

In experiment #3 of Lesson 3.3 I asked you to stop a backend container and see what happens. You may have noticed (or will notice) that Nginx **does not ignore it entirely**, but the first few requests can still fail. This lesson explains the mechanism behind that behaviour — and includes an honesty check, because what I wrote in the Lesson 3.3 README now needs to be made more precise.

---

## 1. Theory

### 1.1 Passive Health Checks — Open-Source Nginx's Default Behaviour

In Lesson 3.3 I said "plain Nginx does not do active health checks by default". That is true, but it is not the whole picture — here is an important correction.

With passive health checks, Nginx monitors real transactions, and if a connection fails (and cannot be resumed), Nginx marks that server "unavailable" and temporarily stops sending requests to it until it is marked active again. Two parameters control this — `fail_timeout` (within what window how many failed attempts make a server unavailable, and how long it stays that way — default 10 seconds) and `max_fails` (how many failed attempts before a server is called unavailable — default just 1).

So — **stock Nginx does have basic protection by default** (`max_fails=1`, `fail_timeout=10s`); it is not the case that nothing happens. But there is a critical limitation:

```
The problem with passive health checks:

Backend 2 crashes
      │
      ▼
[a REAL USER's request goes to Backend 2] ──> FAILS, the user sees an error!
      │
      ▼
only now does Nginx learn Backend 2 is unavailable, and drop it for 10 seconds
```

The problem with passive checks is that real users feel the failures. With `max_fails=3`, three users get errors before Nginx stops sending traffic there.

**Active health checks** work differently — Nginx sends dedicated "probe" requests to the backends at regular intervals, entirely independently of real client traffic. If a server does not answer a probe, Nginx removes it from rotation _beforehand_, before any real user request reaches it.

**An important honesty note:** active health checks are only available in NGINX Plus (a paid product), not in stock open-source Nginx — although third-party modules like `nginx_upstream_check_module` can achieve it in the open-source build. So my original point in Lesson 3.3 was correct (plain Nginx does not do active checks), but the impression that "it does nothing" was wrong — it does react passively; the first few users just have to absorb an error.

### 1.2 Failover — Sending a Failed Request to Another Server

Marking a server unavailable is not enough on its own — what happens to the request that failed? That is where **failover** comes in. You can tell Nginx (with the `proxy_next_upstream` directive) that if one backend returns an error, it should **automatically retry that same request on another backend** before showing the client an error:

```
Client request ──> Nginx ──> Backend 2 (down) ──> ERROR
                      │
                      └──> Nginx retries by itself ──> Backend 3 ──> SUCCESS
                                                              │
The client only ever sees a SUCCESS response, never noticing an error!
```

This matters for user experience — remember availability from Lesson 1.5? Even with a backend down, properly configured failover means **the client never notices the downtime at all**, because Nginx retries transparently.

### 1.3 Sticky Sessions — the Real Problem with IP Hash

In Lesson 3.2 we learned about IP hash, but one real problem went unmentioned — **many different users can come from the same IP**. Think of an office, a university campus, or a mobile network (carrier-grade NAT) — hundreds of different users share one public IP address! With IP hash, **all of them get sent to the same backend server**, which:

1. Makes load distribution unfair (abnormal pressure on one server)
2. Means that if that one server goes down, every user in that office or campus is affected at once

**A more reliable alternative — cookie-based sticky sessions.** Here the LB, after handling the first request, sets a cookie on the response (something like `X-Backend-Server: backend-2`). On the next request the client returns that cookie and the LB routes directly to that backend — regardless of IP, tracking each individual browser or user independently.

**But the core question remains — the lesson from 1.6:** sticky sessions (whether IP-based or cookie-based) are both really **a workaround for a stateful architecture**, not the ideal solution. If TaskFlow's servers are genuinely stateless (session data in Redis, files in S3), sticky sessions are **not needed at all** — which you correctly said yourself in the Lesson 3.2 exercise.

### 1.4 Graceful Shutdown — Saying Goodbye to a Server Gently

Now a new problem — say you want to deploy new code to one of TaskFlow's backends. The easy way is to stop that server and start it again with the new code. But if that server was **processing requests at that moment** (mid-flight), stopping it abruptly makes those requests **fail incomplete** — and users see errors.

**Graceful shutdown** solves this, in three steps:

```
1. Put the server into "draining" mode — it accepts no new requests,
   but in-flight requests are allowed to finish

2. Tell the LB — "stop sending this server new traffic"
   (in Nginx, comment out or remove that server's line from the upstream
    and reload; or drain it via the dynamic API in Nginx Plus)

3. Once all in-flight requests have finished (or a timeout has passed) —
   only then shut the server down completely
```

In Node.js/Express this is implemented practically by handling the SIGTERM signal — the server stops accepting new connections, lets existing ones finish, then exits the process. This is a pattern directly relevant during deployment in any production system — and we go deeper into it in Module 10.6 (deployment strategies — blue-green, canary).

> **Trade-off Table — This Lesson's Concepts**

| Concept                          | The problem it solves                                      | Limitation                                                     |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Passive health check             | Detecting a downed server (with delay)                     | The first few users get errors                                 |
| Active health check              | Proactive detection; users never see an error              | Needs NGINX Plus (paid) or a third-party module                |
| Failover (`proxy_next_upstream`) | The client gets a clean response even when a backend fails | Retrying can add a little latency                              |
| Cookie-based sticky session      | Avoids IP hash's "shared IP" problem                       | Still a workaround for a stateful architecture, not a root fix |
| Graceful shutdown                | In-flight requests are not harmed during deployment        | Needs extra care to implement (SIGTERM handling)               |

---

## 2. Interview Angle

A common terminology distinction (Kubernetes-influenced, but important generally) — **liveness vs readiness**. A "liveness check" asks "is this server alive (has it crashed)?" while a "readiness check" asks "is this server ready to take new traffic **right now**?" (it might be alive but still opening database connections at startup, or in the middle of a graceful shutdown). A good `/health` endpoint should be able to answer those two questions separately — just returning "OK" is not deep enough for a production system.

Another frequent question — "how would you do a zero-downtime deployment?" Mention graceful shutdown together with the load balancer's draining ability — starting servers on the new version, telling the LB to shift traffic over gradually, draining the old version and only then shutting it down. That whole pattern is called a **rolling deployment** (detailed in Module 10.6).

---

## 3. Key Takeaway

- Stock Nginx **does have passive health checks by default** (`max_fails=1`, `fail_timeout=10s`) — not unprotected, but the first few users can still get errors
- Active health checks (proactive, invisible to users) need NGINX Plus or a third-party module
- Failover (`proxy_next_upstream`) transparently sends a failed request to another backend
- IP hash sticky sessions have a "shared IP" problem (offices, campuses, carrier NAT) — cookie-based sticky sessions avoid it, but the root fix is a stateless architecture
- Graceful shutdown — drain, then shut down — protects in-flight requests, and is essential during deployment

---

## 4. New Terms (Glossary)

| Term                      | Meaning                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Passive Health Check**  | Marking a server unavailable by observing failures in real traffic                                           |
| **Active Health Check**   | Proactively verifying server health with dedicated probes at regular intervals                               |
| **Failover**              | Transparently sending a request to another backend when one fails                                            |
| **Draining**              | Stopping a server from taking new requests while letting in-flight ones finish                               |
| **Graceful Shutdown**     | Shutting a server down fully only after draining and completing all in-flight requests                       |
| **Liveness vs Readiness** | Whether a server is "alive" versus whether it is "ready to take traffic right now" — two different questions |

---

## 5. Reflection Questions

1. If you keep only the default passive health check in TaskFlow (`max_fails=1`, `fail_timeout=10s`), roughly how many users would see an error directly when a backend crashes, given those default values?
2. Without graceful shutdown (stopping a backend with a plain `docker stop`), what can happen to an in-flight "Create Task" request? (Think about how this relates to the idempotency key from Lesson 2.5.)

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** `max_fails=1` means Nginx marks a server unavailable **after just one failed attempt** — so in theory only one user (whose request happened to hit the crashed backend first) sees an error directly, after which Nginx avoids that server for `fail_timeout=10s`. In practice, though, under high traffic, once `fail_timeout` expires Nginx tries that (still crashed) server again, so another user can get an error — and this cycle repeats until the server is actually fixed or manually removed from rotation.

**Question 2:** Without graceful shutdown, an abrupt stop **cuts that "Create Task" request off mid-flight** — the client may receive no response at all (a timeout) or a connection error. This is exactly where the idempotency key matters — having received no response, the client can safely **retry** (with the same idempotency key), and if the first request actually did save to the database (only the response never got back), the retry returns that earlier result and no duplicate task is created. It shows how a Module 2 concept (idempotency) and a Module 3 concept (graceful shutdown and failure) combine to make a resilient system — each gives incomplete protection without the other.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise** (if you still have the Lesson 3.3 Docker setup, you can extend it hands-on, but that is optional)

> Answer the following:
>
> 1. If you added `max_fails=2` and `fail_timeout=5s` to each `server` line in the Lesson 3.3 `nginx.conf` — how would that change the user experience when a backend crashes, compared with the defaults (`max_fails=1`, `fail_timeout=10s`)?
> 2. Between TaskFlow's "Create Task" and "Get Task List" endpoints — for which is `proxy_next_upstream` (failover) comparatively safer, and where should you be careful? (Hint: think about idempotency and the difference between GET and POST.)
> 3. For "planned maintenance" (you knowingly stop a backend to deploy) versus an "unexpected crash" — is graceful shutdown's role the same in both, or different? Explain.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 + Module 2 (complete), 3.1, 3.2, 3.3
Current: 3.4 — Health Checks, Failover, Sticky Sessions, Graceful Shutdown
TaskFlow state: a multi-instance Nginx reverse proxy + LB setup (with the Docker demo),
now adding health check and failover concepts on the way to production readiness
Terms learned (Module 3 so far): Load Balancer, L4/L7, SSL Termination,
Content-based Routing, Round Robin, Weighted Round Robin, Least Connections,
Session Affinity, IP Hash, Consistent Hashing (intro), Forward/Reverse Proxy,
Upstream, Passive/Active Health Check, Failover, Draining, Graceful Shutdown,
Liveness/Readiness
Weak spots: [unchanged from before; no significant new gap appeared in this lesson,
since it is mostly conceptual and the new exercise has not been submitted yet]
Next: Module 3 Exit Challenge, then Module 4 — Caching
=======================
```

---

## 8. Next Step

Send the exercise over. When you are ready, write `next` — we move to the **Module 3 Exit Challenge**, where load balancers, L4/L7, algorithms, proxies, and health checks all come together in one integrative challenge.
