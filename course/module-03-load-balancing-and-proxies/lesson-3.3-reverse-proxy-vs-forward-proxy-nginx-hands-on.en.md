# Lesson 3.3 — Reverse Proxy vs Forward Proxy, Nginx Hands-on

**Module 3 — Load Balancing & Proxies**

> **Spaced Repetition (Lesson 1.5):** Why does p99 latency matter more than average latency? If an API's average is 80ms but its p99 is 3 seconds, what would you suspect?

**Prerequisite:** Lesson 3.1 (Load Balancer, L4/L7), Lesson 3.2 (LB Algorithms)

**By the end of this lesson you will be able to:**

1. Explain the core difference between a forward proxy and a reverse proxy (who is being "hidden" — the client or the server).
2. Understand why a load balancer is really a special kind of reverse proxy.
3. Set up a working reverse proxy + load balancer with Nginx, and verify Round Robin behaviour with your own eyes.

**Tier:** 2 — Infra Setup (Docker Compose + Nginx config + TypeScript backend)

---

## 0. Where TaskFlow Is Right Now

In Lessons 3.1 and 3.2 we learned the theory of load balancers — L4/L7, Round Robin, Least Connections. Today it is time to **actually build one** — with Nginx, in a real multi-container setup running on your own machine.

But first one concept needs clearing up. You have been using the word "proxy" as a synonym for "load balancer", but a proxy is a broader concept with two completely different kinds — one protects the client, the other protects the server. Today's lesson starts with that distinction.

---

## 1. Theory

### 1.1 Forward Proxy — the Client's Representative

A **forward proxy** sits between the client and the internet, sending requests **on the client's behalf**. The server being talked to never sees the real client — it only sees the proxy.

```
[Client] ──> [Forward Proxy] ──> [Internet / Target Server]

From the server's point of view: "a request arrived, but I don't know
whether it came from the real client or a proxy" (client identity hidden)
```

**Real-world examples:** an office's corporate proxy (all employee traffic goes through one central proxy so the company can monitor or filter it), or a VPN (hiding your real IP so the server only sees the VPN's).

### 1.2 Reverse Proxy — the Server's Representative

A **reverse proxy** also sits between client and server(s), but works in the other direction — it receives requests **on the server's behalf**. The client never knows how many servers are behind it, or which — it only sees the proxy.

```
[Client] ──> [Reverse Proxy] ──> [Server 1 / Server 2 / Server 3]

From the client's point of view: "it looks like there's just one server"
(backend topology hidden)
```

**And here is the connection you were expecting** — the "load balancer" we discussed in Lessons 3.1 and 3.2 is really **a special kind of reverse proxy**, whose job is not only hiding the servers but also **intelligently splitting traffic** among them.

> **Trade-off Table — Forward vs Reverse Proxy**

| Dimension                  | Forward Proxy                       | Reverse Proxy                                      |
| -------------------------- | ----------------------------------- | -------------------------------------------------- |
| Who it protects/represents | The client                          | The server                                         |
| Who stays "hidden"         | The client, from the server         | The server(s), from the client                     |
| Common uses                | Corporate filtering, VPN, anonymity | Load balancing, caching, SSL termination, security |
| Where it lives             | Usually in the client's network     | Usually in the server's infrastructure             |

**An easy way to remember it:** a forward proxy takes _your_ side (the client's) facing the internet. A reverse proxy takes the _server's_ side facing clients (protectively, not adversarially). "Forward" means you as a client use the proxy going outward; "reverse" means the flow is set up from the other end, the server's side.

### 1.3 A Reverse Proxy Does More Than Load Balancing

A reverse proxy like Nginx does much more than split traffic, and these connect directly to concepts you have already learned:

- **SSL/TLS termination** (Lesson 3.1) — handling client-facing HTTPS while speaking plain HTTP to the backends
- **Static file serving** — serving CSS/JS/images straight from Nginx, freeing the Express server from that work
- **Content-based routing** (L7, Lesson 3.1) — `/api/*` one place, `/assets/*` another
- **Caching** — instead of fetching the same response from the backend repeatedly, remembering the first response for a while and serving it directly (detailed in Module 4)

---

## 2. Interview Angle

A common conceptual question — "are a load balancer and a reverse proxy the same thing?" A good answer: **every load balancer is a reverse proxy, but not every reverse proxy is a load balancer.** Putting Nginx in front of a single backend server (for SSL termination or static file serving) makes it a reverse proxy but not a load balancer (there are no multiple backends to split between). The moment logic for distributing traffic across several backends is added, it becomes a load balancer as well.

---

## 3. Key Takeaway

- A forward proxy represents the client (hiding the client from the server) — corporate filtering, VPNs
- A reverse proxy represents the server(s) (hiding backend topology from the client) — load balancing, SSL termination, caching
- A load balancer is really a specialised reverse proxy
- Nginx is a multi-purpose reverse proxy — load balancing, SSL termination, static serving, and content-based routing all at once

---

## 4. New Terms (Glossary)

| Term              | Meaning                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| **Forward Proxy** | A proxy sending requests to the internet on the client's behalf, hiding client identity   |
| **Reverse Proxy** | A proxy receiving client requests on the server's behalf, hiding backend topology         |
| **Upstream**      | In Nginx terminology, the block describing a pool of backend servers (`upstream { ... }`) |

---

## 5. Reflection Questions

1. A company wants to block social media access for its employees on the office network — is that a job for a forward or a reverse proxy?
2. In TaskFlow's Nginx setup, if there were only one backend server (no horizontal scaling yet), would there be any point in putting Nginx in front? Why? (Think about SSL termination and static serving.)

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** That is a job for a **forward proxy** — the company is controlling its own employees' (clients') internet access, filtering where they can go. It is acting on the client side (controlling client traffic), not protecting any backend server.

**Question 2:** Yes, it still has a point — even with a single backend, Nginx gives you SSL/TLS termination (Express never has to handle HTTPS), static file serving (moving that work off Express, which performs better), and future-proofing (more backends can be added later with no architectural change). So the idea that "a reverse proxy is only a load balancer" is wrong — it has distinct value even with a single backend.

</details>

---

## 6. Practical Exercise

**Tier 2 — Infra Setup**

> **It is ready to run in the repo:** [`exercises/lesson-3.3-nginx-reverse-proxy/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-3.3-nginx-reverse-proxy) — `docker compose up` and it runs. The full setup, acceptance criteria, and experiments are in that folder's `README.md`.

We build three identical TypeScript/Express backend instances with Nginx in front of them as a reverse proxy and load balancer. The backend's TypeScript part is verified with `tsc --noEmit` (clean pass). But the full Docker Compose + Nginx integration was **not** verified by running it here — **honestly, you have to run that on your own machine.**

**Project structure:**

```text
lesson-3.3-nginx-reverse-proxy/
├── docker-compose.yml
├── nginx.conf
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── server.ts
└── README.md
```

**The key trick** that makes Round Robin visible: each backend gets a name from an environment variable and returns it in the response, so you can see which instance served you.

```typescript
// Docker Compose gives each instance a name via an environment variable,
// so we can see which instance Nginx sent the request to.
// This is the key trick for verifying Round Robin.
const INSTANCE_ID: string = process.env.INSTANCE_ID ?? 'unknown-instance';

app.get('/api/tasks', (_req: Request, res: Response<TaskListResponse>): void => {
	res.status(200).json({ tasks, servedBy: INSTANCE_ID });
});
```

And the Nginx side — the `upstream` block naming the backend pool:

```nginx
upstream taskflow_backend {
    # The default algorithm is Round Robin (Lesson 3.2) — you get it
    # by specifying nothing.

    server backend1:3000;
    server backend2:3000;
    server backend3:3000;

    # For the experiments — uncomment these lines and see:
    # least_conn;   # the Least Connections algorithm
    # ip_hash;      # session affinity (IP hash)
}
```

**Verify it (acceptance criteria):**

```bash
curl http://localhost:8080/api/tasks   # repeat several times
```

Expected: `servedBy` rotates — `backend-1`, `backend-2`, `backend-3`, `backend-1`, ... That is the proof of Round Robin. Note too that you never talk directly to backend1/2/3 (none of their ports are exposed to the host) — only to Nginx on port 8080. That is the essence of a reverse proxy: the backend topology is entirely hidden from the client.

**Then break it yourself (experiments):**

1. Uncomment `least_conn;` in `nginx.conf` and run `docker compose restart nginx`. Then add a deliberate delay to one backend (a new endpoint with a `setTimeout`) and watch how the distribution changes.
2. Uncomment `ip_hash;` and see — do repeated calls always land on the same backend? (Because all your requests come from one IP.)
3. Stop one backend container (`docker compose stop backend2`) and curl a few times — what happens? Does Nginx skip it, or return an error? You will find a limitation here: plain open-source Nginx does not do **active health checks** by default. That is the subject of Lesson 3.4.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (complete) + Module 2 (complete), 3.1, 3.2
Current: 3.3 — Reverse/Forward Proxy, Nginx Hands-on
TaskFlow state: the multi-instance architecture is now established both conceptually and
practically (Docker demo) — an Nginx reverse proxy + Round Robin LB in front
Terms learned (Module 3 so far): Load Balancer, L4/L7, SSL Termination,
Content-based Routing, Round Robin, Weighted Round Robin, Least Connections,
Session Affinity, IP Hash, Consistent Hashing (intro), Forward Proxy, Reverse Proxy,
Upstream (an Nginx term)
Weak spots: reaching the right answer with the wrong or irrelevant reason (3.1); small gaps
in arithmetic and communication clarity (3.2 Q2) — though conceptual depth and proactive
connection-making (3.2 Q3) keep improving
First Tier 2 exercise completed: Nginx reverse proxy + load balancer, Docker Compose,
TypeScript backend (the TS part verified; full integration needs self-verification)
Next: 3.4 — Health Check, Failover, Sticky Session, Graceful Shutdown
=======================
```

---

## 8. Next Step

Run the Docker Compose setup on your own machine, especially experiment #3 (what happens when a backend goes down) — it is a perfect setup for the next lesson. When you are ready, write `next` — Lesson 3.4: health checks, failover, sticky sessions, and graceful shutdown, where we solve exactly the problem experiment #3 shows you.
