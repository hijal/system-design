# Lesson 4.1 — Cache Hierarchy: Browser → CDN → App → DB

**Module 4 — Caching**

> **Spaced Repetition (Lesson 3.1):** What is the core difference between L4 and L7 load balancers, and which one can make routing decisions by looking at the URL path or headers?

**Prerequisite:** Lesson 1.3 (Latency numbers), Lesson 3.3 (Nginx/Reverse Proxy)

**By the end of this lesson you will be able to:**

1. Name every place along a request's path (from the browser all the way to the database) where caching is possible — the complete hierarchy
2. Understand what problem each layer's cache solves, and why it all works on the principle of "the closer, the faster"
3. Know how this hierarchy maps onto TaskFlow's own stack (Cloudflare) in practice

**Tier:** 3 — Design Exercise (hands-on Redis caching comes in Lesson 4.4)

---

## 0. Where TaskFlow Is Right Now

Throughout Module 3 we learned how to **spread load across multiple servers**. But there is a completely different way to improve performance — **not letting the request reach the backend at all**, if the same answer is already "remembered" (cached) somewhere.

Remember the latency table from Lesson 1.3? A memory read takes ~100 nanoseconds, a disk read ~0.1 milliseconds — a difference of roughly **1000x**. The whole of Module 4 really rests on this one fact — **if an answer can be kept somewhere nearby (and on a fast medium), the work can be finished without going all the way to the database.** Today we look at the whole hierarchy — exactly where this "caching" can happen, from the client to the database.

---

## 1. Theory

### 1.1 The Full Cache Hierarchy — a Request's Complete Journey

```
[Browser Cache] ──> [CDN / Edge Cache] ──> [Reverse Proxy Cache] ──> [App Cache
                                                                       (Redis)] ──> [DB Cache
                                                                                    (internal buffer)] ──> [Disk]

     ~0ms              ~10-50ms                 ~1-5ms                ~0.5-1ms            ~0.1ms          ~1-10ms+
  (no network at all)  (nearby data center)   (same data center)     (in-memory)        (in RAM, but the    (actual
                                                                                        DB engine's own     storage read)
                                                                                        cache)
```

Every layer shares one general principle — **the less distance a request travels, the faster the answer arrives.** Let's look at each layer separately.

### 1.2 Layer 1 — Browser Cache

This is the closest and fastest layer — the request **never even touches the network**, because the browser answers from its own local storage. It is controlled by the HTTP response's `Cache-Control` header:

```
Cache-Control: max-age=3600
```

This means — "keep this resource in the browser for up to 1 hour, don't ask the server again". It is mainly used for static assets (CSS, JS, images) — there is no need to fetch TaskFlow's logo again and again if the browser already has it.

### 1.3 Layer 2 — CDN / Edge Cache

If the browser cache misses (first visit, or the cache expired), the next nearest layer is the **CDN (Content Delivery Network)** — in your own stack, that is Cloudflare. In 2026, big CDN providers like Cloudflare are spread across the world with 300+ PoPs (Points of Presence, i.e. data centers), so wherever a user is, a response can come from a nearby edge location without going all the way to the main (origin) server.

Cloudflare works with two kinds of TTL — "Edge Cache TTL" (how long content is kept on Cloudflare's own global network) and "Browser Cache TTL" (how long it is kept in the visitor's browser). Notice — the same **TTL** idea is back here, the one we saw in Lesson 2.1 (DNS) and Lesson 2.5 (Idempotency Key) — the same "how long do I remember this" idea, applied in a different context each time.

**An important warning:** personal/sensitive data of a logged-in user (for example TaskFlow's dashboard, which is different for every user) must never be cached on the CDN — it should bypass the cache based on the session cookie or auth token. This matters because if one person's task list were accidentally cached and served to another person's browser, that would be a serious security bug.

### 1.4 Layer 3 — Reverse Proxy Cache

In Lesson 3.3 we used Nginx only as a load balancer, but Nginx itself can also be a caching layer — fetching a response from the backend once and keeping it for a while, so the same request doesn't have to go to the backend over and over. It works like a CDN, but it isn't geographically distributed — it sits inside your own infrastructure, right in front of the backend.

### 1.5 Layer 4 — Application Cache (Redis)

Everything we have seen so far works well for **static or semi-static content**. But for dynamic, personalized data like TaskFlow's `/api/tasks`, browser/CDN caching is hard (the result differs per user). Here you need an **application-level cache** — a fast, in-memory data store like Redis that sits right next to your Express server.

Here the logic lives inside the application code: "before querying the database for the task list, check Redis once — if it's there, return it without going to the database." This is Module 4's main hands-on topic; we implement it directly in Lesson 4.4.

### 1.6 Layer 5 — The Database's Own Cache

Even if the data isn't in Redis and the request reaches the DB, it doesn't go straight to disk. PostgreSQL has its own internal memory cache — the **buffer pool** (controlled by the `shared_buffers` setting) — where recently used data pages are kept in memory. If the same row is queried repeatedly, PostgreSQL serves it from memory by itself, without going to disk.

**Connecting it to your Sequelize experience:** you don't control this layer directly (PostgreSQL manages it itself), but it is important to know — it explains why **running the same query repeatedly gets faster from the second time on** (the first time it is loaded from disk, afterwards from the buffer pool).

> **Trade-off Table — Each Layer of the Cache Hierarchy**

| Layer                | What it caches                    | Who controls it                                                     | Best fit                                  |
| -------------------- | --------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Browser              | Static assets                     | `Cache-Control` header (your backend sets it, the browser obeys it) | CSS, JS, images                           |
| CDN                  | Static + semi-static content      | CDN configuration (Cloudflare Dashboard/Cache Rules)                | Public, non-personalized content          |
| Reverse Proxy        | Backend responses                 | Nginx config                                                        | Semi-dynamic, shared content              |
| Application (Redis)  | Personalized/dynamic query result | Your application code                                               | User-specific data, expensive computation |
| Database Buffer Pool | Data pages                        | The database engine itself                                          | Every query (automatic, transparent)      |

---

## 2. Interview Angle

An almost guaranteed question — "Explain where caching can happen for a request." A good answer walks through exactly today's hierarchy top-to-bottom, including **why** each layer is needed and **what kind of data** it suits. A common follow-up: "How would you cache personalized data (say, a user's own dashboard) when it can't go on the CDN?" — this is where you bring up the application-level cache (Redis), with the user ID included in the key (e.g. `tasks:user:123`), so that each user's data is cached separately.

---

## 3. Key Takeaway

- Cache hierarchy: Browser → CDN → Reverse Proxy → Application (Redis) → Database Buffer Pool → Disk
- Each layer is "closer" and "faster", but the higher up you go (browser/CDN), the less able it is to handle "personalization"
- Static/shared content → a good fit for browser/CDN; personalized/dynamic content → needs an application-level cache (Redis)
- Sensitive/personal data must never be cached on a CDN — it is a serious security risk
- The database's own buffer pool works automatically, without any explicit configuration (some tuning is possible)
- The same "TTL" idea (Lessons 2.1, 2.5) applies here too — every cache layer has its own "how long do I remember this" decision

---

## 4. New Terms (Glossary)

| Term                               | Meaning                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| **Cache Hierarchy**                | The different levels of caching between the client and the database                   |
| **CDN (Content Delivery Network)** | A geographically distributed server network that keeps content close to users         |
| **PoP (Point of Presence)**        | A specific geographic data center of a CDN                                            |
| **Edge Cache TTL**                 | How long content is kept on the CDN's own global network                              |
| **Buffer Pool**                    | The database engine's own internal memory cache, for keeping recently used data pages |

---

## 5. Reflection Questions

1. TaskFlow's landing page (marketing content, the same for everyone) and `/api/tasks` (different for every user) — which layers of the cache hierarchy apply to each of these, and which don't?
2. If a user updates their profile picture but the CDN still has the old picture cached for a few more hours (Edge Cache TTL), what will the user see? What kind of problem does this create (a preview of upcoming lessons)?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** For the landing page **every layer** applies — browser cache, CDN, even the reverse proxy cache — because it is the same content for everyone, with no personalization. For `/api/tasks`, the browser cache and CDN **do not apply** (or only in a very limited way, with a short TTL) because it is different for every user and frequently changing data — only the application-level cache (Redis, with a user-specific key) and the database buffer pool apply here.

**Question 2:** The user keeps seeing the old picture until the Edge Cache TTL expires (or it is manually purged). This is the **Cache Invalidation** problem — "telling the cache that the underlying data has changed, so the old cached version is no longer usable" — a famously hard problem in Computer Science ("There are only two hard things in Computer Science: cache invalidation and naming things"), and it is the main topic of Lesson 4.3.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> For the following four TaskFlow resources, which **layers** of the cache hierarchy do you think apply (there can be more than one), and why:
>
> 1. TaskFlow's logo (an SVG file that never changes)
> 2. `GET /api/tasks` (each user's own task list)
> 3. A public "What you can do with TaskFlow" marketing blog post (the same for everyone, updated once a month)
> 4. `POST /api/tasks` (creating a new task)

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (complete)
Current: 4.1 — Cache Hierarchy
TaskFlow state: Nginx reverse proxy + LB in front, horizontal-scale-ready backend,
now starting to prepare for a caching layer
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool
Weak spots: [where you got stuck — fill this in yourself]
Next: 4.2 — Caching Strategies (Cache-Aside, Write-Through, Write-Behind, Read-Through)
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 4.2: Caching Strategies — Cache-Aside, Write-Through, Write-Behind, Read-Through — how application code and the cache work together, with the trade-offs of each pattern.
