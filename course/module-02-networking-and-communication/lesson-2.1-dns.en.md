# Lesson 2.1 — How DNS Works: The Whole Journey from URL to Response

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 1.6):** What was the simple practical test for checking whether a server is genuinely "stateless"?

**Prerequisite:** Lesson 1.4 (Client–Server, Connection Lifecycle)

**By the end of this lesson you will be able to:**

1. Walk through every step of how a domain name (like `taskflow.app`) is turned into an IP address.
2. Understand and explain recursive vs authoritative DNS servers, and how DNS caching and TTL work.
3. Know how to reduce DNS lookup latency (caching, TTL tuning), and why that is an important optimisation point in system design.

**Tier:** 3 — Design Exercise (mostly conceptual; at the end there is an optional terminal command to watch a real DNS lookup, but that is not a formal Tier 1 exercise)

---

## 0. Where TaskFlow Is Right Now

In Lesson 1.4 we saw the seven stages of the client-server journey, and the first one was "DNS lookup" — which we only mentioned at the time, promising "we'll open this fully in Lesson 2.1". Today we keep that promise.

Think about it — you type `https://taskflow.app` in the browser. Your computer has no idea where TaskFlow's server actually is (at which IP address) — it is like knowing a person's name but not their address. DNS is exactly that "phone book" or "address book" that finds the address from the name. How efficient that lookup is directly affects how long your app's first response takes.

---

## 1. Theory

### 1.1 Why DNS Exists

On a computer network every machine is identified by a number — an **IP address** (like `104.21.45.67`). But numbers are hard for people to remember and names are easy. Hence **DNS (Domain Name System)** — a distributed, hierarchical system that converts human-readable domain names (like `taskflow.app`) into machine-readable IP addresses.

### 1.2 The Full Lookup Journey — Step by Step

When you type `taskflow.app` in the browser, this happens:

```
Browser                Local DNS         Root          TLD           Authoritative
(your device)           Resolver         Server        Server        Name Server
   │                   (ISP/8.8.8.8)    (.)            (.app)        (taskflow.app's own)
   │                       │              │              │                  │
   │──"what's the IP       │              │              │                  │
   │   for taskflow.app?"─>│              │              │                  │
   │                       │──"who handles │              │                  │
   │                       │  the .app     │              │                  │
   │                       │  domain?"────>│              │                  │
   │                       │<──"here's the │              │                  │
   │                       │   address of  │              │                  │
   │                       │   .app's TLD"─│              │                  │
   │                       │                              │                  │
   │                       │──"who is authoritative        │                  │
   │                       │  for taskflow.app?"─────────>│                  │
   │                       │<──"ask at this               │                  │
   │                       │   address"──────────────────│                  │
   │                       │                                                 │
   │                       │──"what's the IP for taskflow.app?"───────────>│
   │                       │<──"104.21.45.67"──────────────────────────────│
   │<──"104.21.45.67"──────│                                                 │
   │                       │
   │ [now the browser knows the IP and can start the TCP connection —
   │  this is where the Lesson 1.4 journey begins]
```

There are four parts worth knowing:

- **Local DNS resolver** — usually your ISP's, or a public resolver you chose (Google's `8.8.8.8`, Cloudflare's `1.1.1.1`). It receives your first question and makes all the other queries _on your behalf_
- **Root server** — at the top of the DNS hierarchy; it only says "this server handles the `.app` TLD"
- **TLD (Top-Level Domain) server** — `.app`, `.com`, `.org` each have their own TLD server, which says which authoritative server owns a particular domain
- **Authoritative name server** — the one that actually knows the correct IP for `taskflow.app` (usually your DNS provider: Cloudflare DNS, Route 53, and so on)

Notice — each query the local resolver makes to the root, TLD, and authoritative servers is its own **network round trip** (remember RTT from Lesson 1.4?). If this whole chain had to run from scratch every time, every website visit would waste a lot of time in DNS lookup.

### 1.3 Caching and TTL — Avoiding That Chain Every Time

"Doing the same expensive thing repeatedly" — this pattern should be familiar by now (connection reuse in keep-alive, the connection pool in Sequelize). DNS uses the same answer: **caching**.

Every DNS record carries a **TTL (Time To Live)** value in seconds, which says: "it is safe to cache this for this long; after that, query again for a fresh answer."

```
First visit:
Browser -> local resolver -> [the whole root->TLD->authoritative chain] -> got the IP
                                    │
                                    ▼
                          the local resolver caches this IP,
                          with its TTL (say 3600 seconds = 1 hour)

Next visit (30 minutes later, same resolver):
Browser -> local resolver -> [in cache, TTL hasn't expired] -> returns the IP directly
                              (no need to trouble root/TLD/authoritative at all!)
```

**The TTL trade-off:**

| TTL                                  | Advantage                                                    | Disadvantage                                                                          |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Low** (say 60 seconds)             | IP changes propagate quickly (e.g. when migrating servers)   | Fresh lookups happen constantly, latency rises, more load on DNS infra                |
| **High** (say 86400 seconds = 1 day) | Most requests are served from cache — fast, with little load | After an IP change, users with a stale cache keep going to the old IP for a long time |

**A common scenario in interviews and in practice:** if you are about to migrate a server (from an old IP to a new one), you should lower the TTL **before** the migration (say from 24 hours to 5 minutes), so that during the migration most users switch to the new IP quickly instead of being stuck on a stale cache. This is a practical step experienced engineers take and juniors forget — with the result that, long after the migration, many users keep sending requests to an old and possibly dead server for hours.

### 1.4 Recursive vs Iterative Queries

The query between your browser and the local resolver is **recursive** — the browser asks one question ("what's the IP?") and the local resolver does all the hard work itself (going around asking root, TLD, and authoritative), never involving the browser.

But the queries between the local resolver and the root/TLD/authoritative servers are **iterative** — each server only says "ask over there next", instead of doing the whole job. The root server does not give an IP; it says "here is the TLD server's address" — and so on, step by step.

The difference is essentially about **who takes responsibility** — in a recursive query one intermediary (the local resolver) does everything; in an iterative one each party only gives the next direction.

### 1.5 Encrypted DNS — a Current Trend

One thing that has become important: traditional DNS queries travel in **plaintext**, meaning anyone in the middle (an ISP, a network observer) can see which domains you visit. To fix this privacy problem, **DNS over HTTPS (DoH)** and **DNS over TLS (DoT)** appeared — they encrypt the DNS query. Today (in 2026) this trend is quite mature: Chrome, Firefox, Edge, Windows, and iOS all support DoH by default, and a newer variant, DoH3, adds speed by building on HTTP/3. According to Mozilla's reporting, DoH adoption among US Firefox users is above 85% — meaning encrypted DNS is no longer niche, it is mainstream.

**Why this matters for system design:** DoH/DoT wrap the DNS query inside HTTPS or TLS, so they can add slightly more overhead than a traditional plain UDP port 53 lookup (because it now requires a TLS/HTTPS connection of its own — remember the TLS handshake from Lesson 1.4?). But the privacy benefit is significant enough that it has become the default in most modern browsers. This is practical to know, because when you debug latency ("why is this request slow?") this subtle change at the DNS layer can be a factor — though in most cases its effect is very small.

---

## 2. Interview Angle

The most common DNS interview question is "explain everything that happens from typing a URL to the response arriving" (known as "what happens when you type a URL" — a classic, asked at nearly every company). A good answer walks through DNS lookup (root→TLD→authoritative), TCP handshake, TLS handshake, HTTP request-response, and browser rendering, in order. Between today's lesson and Lesson 1.4, you can now give that whole answer.

A frequent follow-up: "how would you reduce DNS lookup latency?" — mention caching and TTL, and also **Anycast** (an advanced concept where one IP address is served from many locations worldwide, so the response comes from near the user — we will not go deep here, but the name is worth knowing, because large DNS providers like Cloudflare and Google rely on it).

---

## 3. Key Takeaway

- DNS is the distributed, hierarchical system that turns a domain name into an IP address
- The lookup chain: local resolver → root server → TLD server → authoritative name server
- Browser-to-resolver queries are **recursive** (the resolver does all the work); the resolver's queries to the other servers are **iterative** (each one only gives the next address)
- **TTL** decides how long a DNS record stays cached — a low TTL gives fast propagation but more lookups; a high TTL gives fewer lookups but slower propagation
- Lowering the TTL before a server migration is a practical habit of experienced engineers
- DoH/DoT are now mainstream (in 2026, 85%+ of Firefox users are on DoH) — they encrypt DNS queries for privacy, at the cost of a little overhead

---

## 4. New Terms (Glossary)

| Term                                 | Meaning                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **DNS (Domain Name System)**         | The distributed system that converts domain names into IP addresses                                      |
| **Recursive Query**                  | A query where one server (the local resolver) does the whole lookup itself, without involving the caller |
| **Iterative Query**                  | A query where each server only says "ask here next" rather than doing the whole job                      |
| **TTL (Time To Live)**               | How long a DNS record is safe to keep cached, expressed in seconds                                       |
| **Authoritative Name Server**        | The server holding a domain's correct, final DNS records                                                 |
| **DoH / DoT (DNS over HTTPS / TLS)** | Protocols for sending DNS queries encrypted, for privacy                                                 |

---

## 5. Reflection Questions

1. If you are about to migrate TaskFlow's server IP (from old hosting to new), what would you do about the TTL just before the migration, and why?
2. Explain the difference between recursive and iterative queries in your own words, with a small analogy of your own (not the digital example from the lesson).

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Some hours (or days) before the migration, you should lower the TTL to something small (say 5 minutes). If the TTL is already high (say one day), then even after migrating, many local resolvers will hold the old IP in cache for a long time, and many users will keep sending requests to the old — possibly dead — server. Lowering the TTL in advance means that during the migration most resolvers do a fresh lookup quickly and pick up the new IP.

**Question 2:** One possible analogy: you walk into an office and ask the receptionist "which room is manager X in?" — if the receptionist goes and finds out and comes back with "they're in this room", that is **recursive** (the receptionist did the whole job). But if the receptionist says "go to the third floor and ask someone there" — and that person says "go to room 305" — that is **iterative** (each step only gives directions; you have to do the walking yourself).

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** TaskFlow's domain is `taskflow.app`. Your DevOps team has decided to change server infrastructure every three months (migrating to new providers for cost optimisation). They are asking you — **what TTL should TaskFlow's DNS records use?**
>
> Think it through and write:
>
> 1. What TTL would you propose for "normal" times (when no migration is happening)? Why?
> 2. What would you change about the TTL just before and just after a migration?
> 3. If TaskFlow migrated every single day (hypothetically, very frequently), how would the TTL strategy change?

There is no "right number" here — understanding the reasoning and the trade-off is the point.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge
Current: 2.1 — DNS
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): System Design, Scale, Trade-off, Functional/Non-functional
Requirement, Scope, Estimation, HLD, Deep Dive, Black Box, DAU, QPS, Peak QPS,
Order of Magnitude, TCP 3-Way Handshake, TLS Handshake, RTT, Keep-Alive,
Head-of-Line Blocking, Multiplexing, QUIC, Latency, Throughput, Availability,
Reliability, SLA, SLO, Error Budget, Vertical/Horizontal Scaling, SPOF,
Stateful/Stateless
Terms learned (Module 2 so far): DNS, Recursive Query, Iterative Query, TTL,
Authoritative Name Server, DoH/DoT
Weak spots: covering every sub-part of a multi-part question; using terminology
precisely (e.g. "consistency" vs "isolation"); clearly justifying it when you
calculate one number and then use another
Next: 2.2 — TCP vs UDP, TLS Handshake (in depth)
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 2.2: the core differences between TCP and UDP, and the TLS handshake in more depth (in Lesson 1.4 we only touched the surface; now we look at the mechanism inside).
