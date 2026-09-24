# Module 4 — Exit Challenge

**Module 4 — Caching**

Module 4's six lessons are done — the cache hierarchy, four caching strategies, invalidation/TTL/eviction, a real Redis layer (built by hand and measured), the inner workings of a CDN, and the failures that are born from the cache's existence. In this Exit Challenge you have to apply all of it together **in a realistic scenario under pressure**.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** One of TaskFlow's features has suddenly gone viral — the **public shared task list** (that `taskflow.app/share/{token}` from Lesson 4.5). A popular productivity YouTuber shared their template list, and it is now taking **40,000 hits a second**. TaskFlow's current state:
>
> - 4 Express instances behind Nginx (Module 3)
> - One Redis instance — holding **both** cache and sessions, `maxmemory-policy` was never set
> - PostgreSQL with `pool: { max: 10 }` per instance
> - `/share/{token}` has `Cache-Control: public, max-age=300`
> - The shared list's data comes from the `tasks:project:{id}` cache key, TTL 300s, every key's TTL exactly 300
> - A small banner at the top of the page: _"You are logged in — view your own list"_ (not shown when not logged in)
>
> **What is happening:** the DB's CPU climbs to 100% once every 5 minutes, then drops back. One single Redis process is at 95% CPU. Two users have complained to support that they saw **someone else's name** in the banner. And last night some users were suddenly logged out.

Your task — for each question below, apply Module 4's concepts (and Modules 1-3 where relevant) to make a decision, with reasoning:

**1. The DB spike every 5 minutes (Lesson 4.6)**
The CPU climbs to 100% exactly every 5 minutes — this rhythm is the biggest clue. Which failure is happening, and how will you confirm it? What exactly will you do as a remedy, and in what order (most gain for least cost first)?

**2. Someone else's name in the banner (Lesson 4.5)**
This isn't a performance bug — what is it, and exactly how did it happen? Why does it _have_ to happen when `Cache-Control: public, max-age=300` and that banner exist together? Give two separate solutions — one where the banner stays, and one where it doesn't — and say which one you would choose, and why.

**3. One Redis process at 95% CPU (Lesson 4.6)**
Will adding Redis nodes fix this? Why, or why not? What new layer of staleness does your proposed solution add, and is that acceptable for this use case — say so.

**4. The sudden logouts at night (Lesson 4.3)**
Cache and sessions share one Redis, and `maxmemory-policy` isn't set. What do you think exactly happened last night? What is the default policy, and does it explain this symptom, or did something else happen? Also say whether **just changing the policy is enough** in your solution.

**5. Connection pool (Lessons 4.6 + 1.6)**
4 instances × `pool: { max: 10 }` = at most 40 concurrent DB connections. At the moment of a stampede, how many of the 40,000 requests per second will want to reach the DB, and what happens to the rest when the pool runs out? Is increasing the pool size the right remedy?

**6. Redesign the whole thing (Lessons 4.1-4.6)**
Knowing everything, write a complete caching design for `/share/{token}` — what sits at every layer from the browser to the DB, the TTLs, the keys, how invalidation works, and which safeguard protects against which failure. It has to fit on one page.

**Something to keep in mind:** two places in this module are where people slip most easily — (a) latency collapsing when the cache is down, (b) the security implications of `public` versus `private`. Both are hidden in today's scenario. And the most important habit: **diagnose before applying a remedy** — "the DB load is high" isn't enough; "is it a spike or constant, and in what rhythm" is the real question.

I will critique this step by step.

---

## 2. Self-Check — You Should Be Able to Do These by Now

- [ ] I can name the layers of caching along a request's whole path (browser → CDN → proxy → app → DB buffer pool), and I know which layer suits which kind of data
- [ ] I can explain Cache-Aside, Read-Through, Write-Through, Write-Behind and Write-Around — the workings and trade-offs of all five separately
- [ ] I understand that the read path and the write path have to be thought about separately, and why
- [ ] I can explain with an example that even inside the same application different data needs different strategies (task title versus view counter)
- [ ] TTL, invalidation and eviction — three separate processes, and who controls each — I don't mix them up
- [ ] I can explain why **deleting** the cache on a write is better than updating it, and why the order is **DB first, cache after**
- [ ] I remember that a write also has to invalidate derived/filtered views (`:completed`, `:page:2`)
- [ ] I can state the difference between LRU and LFU, and which traffic pattern suits which
- [ ] I **built** a working Cache-Aside layer myself with Express + Sequelize + Redis, and measured the cache's benefit (Lesson 4.4)
- [ ] I understand why data coming from the cache is runtime input too — validated with Zod, not `as`
- [ ] I have seen hands-on that a cache failure should never fail a request, and how "cache down" turns into "site down" when the client's offline queue or command timeout isn't right
- [ ] `max-age` / `s-maxage` / `private` / `no-cache` / `no-store` — I know who each one is addressed to, and that `no-cache` doesn't mean "don't cache"
- [ ] I recognize the risk that a personalized response cached on a CDN isn't a bug, it's a **breach**
- [ ] I can say why content hashing is better than purging
- [ ] Stampede, avalanche, hot key, penetration — I can recognize the four **by their symptoms** and pick the right remedy
- [ ] I have run single-flight myself, and I know why an in-process lock across multiple instances _reduces_ the problem but doesn't _eliminate_ it

---

## 3. Recommendation

**To read:**

- The "Key eviction" page of the official Redis documentation — every `maxmemory-policy` option, and it makes clear that LRU is actually an **approximate** LRU (it samples rather than scanning the whole keyspace). Directly related to today's question 4.
- MDN's `Cache-Control` page — the complete, reliable list of Lesson 4.5's directives. Its explanation of `no-cache` versus `no-store` is the clearest.

**To work through:**

- Cloudflare's "Cache Rules" and "Tiered Cache" documentation — you'll see exactly how Lesson 4.5's ideas of cache keys, `Vary` and origin shield are configured on a real CDN. Since TaskFlow is on Cloudflare, this is directly useful.

**For a project:**

- Go back to Lesson 4.4's exercise (in your own time) and add both **negative caching** and **TTL jitter** — Lesson 4.6's exercises 3 and 4. Then run `npm run stampede` and `npm run bench` again and compare the numbers with the earlier ones.
- If you want to go a step further: replace the in-process Map in `src/singleflight.ts` with a Redis-based distributed lock (`SET key val NX PX 5000`). Run 4 instances (like Lesson 3.3's docker-compose) and measure the stampede — does it drop from 4 to 1? This is excellent preparation for Lesson 6.4.

---

Send the exit challenge over. When you are ready, write `next` and we move to **Module 5: Database Design & Scaling** — starting with Lesson 5.1, the real trade-off of SQL vs NoSQL.

Throughout Module 4 we tried to protect the DB — we reduced its work with the cache and held a shield in front of it. In Module 5 we go **inside** that DB: how it actually stores data, why an index makes a query fast, what a transaction costs, and what happens when one machine is no longer enough.
