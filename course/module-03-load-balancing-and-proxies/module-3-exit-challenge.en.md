# Module 3 — Exit Challenge

**Module 3 — Load Balancing & Proxies**

That is all four lessons of Module 3 — the core idea of load balancers, the algorithms, the kinds of proxy, Nginx hands-on, and health checks, failover, and graceful shutdown. In this exit challenge you have to apply all of it together **in one realistic, high-pressure scenario**.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** The TaskFlow team is launching a big marketing campaign next week — expected traffic is **five to six times** a normal day's. In that same week, a **critical bug fix** must also be deployed to the backend (a security-related fix, so it cannot wait). TaskFlow's architecture right now:
>
> - Four identical Express server instances behind an Nginx reverse proxy (just like Lesson 3.3)
> - Most endpoints are stateless, but an old "Bulk Export" feature still keeps temporary progress-tracking state in local server memory (technical debt, not yet fixed)
> - The task creation endpoint uses an idempotency key (that in-memory implementation from Lesson 2.5, not yet migrated to Redis)

Your job — decide on each question below by applying Module 3 concepts (and Module 2 where relevant), with reasoning:

**1. LB algorithm (Lesson 3.2)**
Under five to six times the traffic, with TaskFlow's mixed workload (some endpoints fast, "Bulk Export" slow), which LB algorithm would you propose?

**2. Health check strategy (Lesson 3.4)**
In such an important week, does the default passive health check (`max_fails=1`, `fail_timeout=10s`) seem sufficient, or should you invest in active health checks (NGINX Plus or a third-party module)? Give the cost-versus-risk reasoning.

**3. Deployment strategy (Lesson 3.4 — graceful shutdown)**
During this high-traffic week, the security fix has to be deployed across four servers. How would you use graceful shutdown to do it without affecting any live user? Walk through it step by step (and consider why restarting all four servers at once would be risky).

**4. The idempotency–failover connection (Lessons 2.5 + 3.4)**
Under high traffic, transient errors and restarts among backend instances become more likely, so keeping `proxy_next_upstream` (failover) enabled on the task creation (POST) endpoint could be especially important this week. But what problem does the current in-memory idempotency key implementation create in that case? What exactly must change before this week?

**5. The legacy stateful feature (Lessons 3.2 + 1.6)**
The "Bulk Export" feature still needs sticky sessions as a workaround. Under five to six times the traffic, how risky is using IP hash (recalling the "shared IP" problem from Lesson 3.4)? Is a cookie-based sticky session a better option here, or should this be made stateless before the week begins?

**6. L4 or L7 (Lesson 3.1)**
Alongside the marketing campaign, TaskFlow is also launching a new static landing page (`taskflow.app/campaign`), hosted on a completely separate static file server from the main Express API. How would Nginx handle this routing?

**Something to keep in mind:** the habit of saying "what I'm giving up" in every answer has become solid now — today, pay special attention to reaching the **root cause** behind each decision (like #2 in the last exercise — going beyond "POST is dangerous" to "why is it dangerous, and from exactly which root cause").

I will critique this step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

- [ ] I understand the load balancer's core role and why it is indispensable for horizontal scaling
- [ ] I can correctly state the difference between L4 and L7 and when each is needed (raw performance vs content-aware routing)
- [ ] Given a traffic pattern, I can choose correctly among Round Robin, Weighted Round Robin, and Least Connections
- [ ] I understand the difference between a forward and a reverse proxy, and the relationship that a load balancer is really a special reverse proxy
- [ ] I have actually built a working reverse proxy + load balancer with Nginx (the Lesson 3.3 hands-on)
- [ ] I know the difference between passive and active health checks, and what stock Nginx does by default (`max_fails`/`fail_timeout`)
- [ ] I understand how failover works, and when it is safe (GET) versus risky (POST with a non-shared idempotency store) — and **why**
- [ ] I can state the limitations of sticky sessions (the shared-IP problem with IP-based affinity) and why it is a workaround rather than the ideal solution
- [ ] I can explain graceful shutdown's three steps and why it works for planned maintenance but not for an unexpected crash

---

## 3. Recommendation

**To read:**

- The "Load Balancing" chapter of the Google SRE Book (free at sre.google/sre-book) — you will see how Google itself thinks about load balancing at enormous scale, and what today's L4/L7 concepts look like at real-world scale

**To work through:**

- Nginx's official "High Availability" guide — practical configuration patterns for active health checks, failover, and graceful reloads

**For a project:**

- Go back to your Lesson 3.3 Docker setup (in your own time, outside the course) — experiment with `max_fails` and `fail_timeout`, and add `proxy_next_upstream` to test failover on a GET endpoint. Then, if you have any multi-instance setup you deployed previously, checking whether graceful shutdown (SIGTERM handling) is implemented there is a good practical exercise

---

Send the exit challenge over. When you are ready, write `next` and we move to **Module 4: Caching** — starting with Lesson 4.1, the cache hierarchy (browser → CDN → app → DB).
