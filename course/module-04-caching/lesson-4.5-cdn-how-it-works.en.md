# Lesson 4.5 — How a CDN Works: Edge, Cache Key, and Purge

**Module 4 — Caching**

> **Spaced Repetition (Lesson 1.4):** What problem does HTTP keep-alive solve? If every request opened a new TCP connection, exactly what cost would go up?

**Prerequisite:** Lesson 4.1 (Cache Hierarchy), Lesson 1.4 (HTTP & Connection Lifecycle)

**By the end of this lesson you will be able to:**

1. Explain how a user's request reaches the nearest edge server, and what the cache key there is built from
2. Understand the `Cache-Control` directives (`max-age`, `s-maxage`, `private`, `stale-while-revalidate`) separately, and know who each one is addressed to
3. Decide with reasoning which parts of TaskFlow go on the CDN and which never do

**Tier:** 3 — Design Exercise

---

## 0. Where TaskFlow Is Right Now

In the last lesson TaskFlow got a working Redis caching layer — `/api/tasks` now mostly doesn't reach the DB at all. But notice that everything we have done so far is **inside the origin** — the request came all the way to your server, and then we stopped it from going to the DB.

Now a completely different question: **what if the request never had to reach your server at all?**

TaskFlow's users are in Dhaka, Singapore, London — everywhere. Your origin server is in one place. If every request from a user in London has to cross half the planet, then no matter how fast Redis is, you can't beat **the speed of light** — a round trip between Dhaka and London alone is ~200 ms.

In Lesson 4.1 we saw the CDN at a glance in the hierarchy. Today we go inside.

---

## 1. Theory

### 1.1 How the request reaches the nearest edge at all

First, a puzzle: you type `taskflow.app`, and someone in Dhaka reaches the Dhaka edge, someone in London the London edge — yet **there is only one domain name**. How?

The answer is **Anycast** — the same IP address is announced from hundreds of places around the world at the same time. Internet routing (BGP) then sends each request towards the instance of that IP that is **closest in network terms**.

```
        user in Dhaka   ──> 104.21.x.x ──> Dhaka PoP
       user in London   ──> 104.21.x.x ──> London PoP     ← same IP, different destination
     user in Sydney     ──> 104.21.x.x ──> Sydney PoP
```

In Lesson 2.1 you saw DNS-based routing (giving different users different IPs). Anycast is better than that, because there is no problem of old answers getting stuck in DNS caches — the network itself makes the routing decision for every packet.

### 1.2 Cache Key — what the edge uses to call something "the same thing"

When a request reaches the edge, it thinks: "do I already have this thing?" — but what "this thing" means is decided by the **cache key**.

By default it is roughly:

```
cache key = scheme + host + path + query string
            https   taskflow.app  /logo.svg   (no query)
```

Here is the first trap. **The query string is part of the cache key** — so to the edge these two are completely different things:

```
/logo.svg                      ← one entry
/logo.svg?utm_source=facebook  ← another entry, fetched separately
```

If links come in from a marketing campaign with 10 different `utm_*` parameters, 10 separate copies of the same logo pile up on the edge, and the first hit for each goes all the way to the origin. That is why CDNs usually get a rule — "ignore the query string for static assets".

**The second trap, and this one is more dangerous — the `Vary` header.** `Vary` says "which request headers this response depends on":

```
Vary: Accept-Encoding        ← reasonable (separate copies for gzip and brotli)
Vary: Accept-Language        ← reasonable (separate by language)
Vary: Cookie                 ← effectively turns the cache off
```

Why is the last one a disaster? Because every user's cookie is different, meaning a **separate cache entry** per user — the hit ratio drops to almost zero, while you think the CDN is working.

### 1.3 Cache-Control — who is instructing whom

This header causes the most confusion, because **the same header has two different audiences** — the browser and the CDN.

| Directive                   | Who listens                     | Meaning                                                                       |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `max-age=3600`              | the browser **and** the CDN     | treat it as fresh for 1 hour                                                  |
| `s-maxage=86400`            | **only** the CDN (shared cache) | 1 day for the CDN — overrides `max-age`                                       |
| `public`                    | everyone                        | shared caches may keep it too                                                 |
| `private`                   | everyone                        | **only the browser** keeps it, the CDN doesn't                                |
| `no-store`                  | everyone                        | nobody keeps it anywhere                                                      |
| `no-cache`                  | everyone                        | you can keep it, but check with the origin before using it                    |
| `stale-while-revalidate=60` | CDN                             | even after expiry, serve the stale copy and fetch a new one in the background |

**`no-cache` does not mean "don't cache"** — almost everyone gets this wrong. It means "cache it, but ask before every use". If you want "don't keep it at all", that is `no-store`.

This combination is the most useful one in TaskFlow:

```
Cache-Control: public, max-age=60, s-maxage=600, stale-while-revalidate=300
```

That is — 1 minute for the browser, 10 minutes for the CDN, and even after the CDN's 10 minutes are up, for the next 5 minutes it will **serve the stale copy immediately** and quietly fetch a new one in the background.

Note `stale-while-revalidate` — this is the technique that stops everyone rushing to the origin together the moment a TTL ends. In the next lesson (4.6) we'll see this problem is called a **cache stampede**, and the same technique can be applied in Redis too.

### 1.4 Conditional requests — no need to refetch the whole thing on expiry

A TTL ending doesn't mean the whole file has to be downloaded again. The edge asks the origin "has this changed?":

```
Edge ──> origin:  GET /logo.svg
                  If-None-Match: "abc123"
                          │
origin ──> Edge:  304 Not Modified      ← no body, headers only
                  (or 200 + new body, if it really changed)
```

An `ETag` is a fingerprint of the content. If it hasn't changed, the origin sends only a `304` — **without a body**. That means almost zero bandwidth, just one round trip. For a 5 MB image this is a huge saving.

### 1.5 Purge — how the news reaches 300+ PoPs

Remember question 2 of Lesson 4.1? The user changed their picture, but the old one is still sitting on the CDN for a few more hours. The fix — **purge**, i.e. telling the CDN "forget this thing right now".

Three kinds:

```
1. URL purge      →  delete just /logo.svg                 (precise, fast)
2. Tag/prefix     →  delete everything tagged "user-7"     (many at once)
3. Purge all      →  delete everything                     (last resort — dangerous)
```

**Why is "purge all" dangerous?** Because in one moment every edge in the world is emptied, and every request after that lands **on your origin**. An origin that handles 5% of traffic on a normal day is suddenly getting 100%. This is the same danger we saw in question 3 of Lesson 4.2, just at CDN scale — and this is called a **cache avalanche**.

The news spreads through the CDN's own internal network — you make one API call, and the CDN broadcasts it to all its PoPs. With big providers it takes a few seconds, but it is **not instant** — so assuming "everyone will see the new one right now" because you purged is wrong.

**A technique that removes the need for purges entirely — content hashing.** Put the hash of the content in the file's name:

```
/app.js          ← needs a purge when it changes
/app.a1b2c3.js   ← a new name when it changes, so a purge never comes up
```

A new build means a new name, which means a new cache key. The old one dies by itself when its TTL ends. That is why it is safe to give these files `max-age=31536000` (one year). **Your SvelteKit build does exactly this** — files in the `_app/immutable/` folder have a hash in their names.

### 1.6 Origin Shield — another layer between the edge and the origin

Having 300 PoPs means the first hit for a thing could go to the origin **300 times** — each PoP misses separately.

Origin Shield solves this by adding an intermediate layer:

```
[300 PoPs] ──> [1 Shield PoP] ──> [your origin]
                                   ← the origin takes the hit only once
```

All edge misses go to the shield first; the shield fetches from the origin once and serves everyone else. This is also called **tiered caching**.

> **Trade-off Table — What Goes Where in TaskFlow**

| Resource                       | On the CDN? | Cache-Control                                      | Why                                                      |
| ------------------------------ | ----------- | -------------------------------------------------- | -------------------------------------------------------- |
| `_app/immutable/*.js` (hashed) | Yes         | `public, max-age=31536000, immutable`              | The name changes, so keeping it forever is safe          |
| `/logo.svg`                    | Yes         | `public, max-age=86400`                            | Rarely changes, the same for everyone                    |
| Marketing page                 | Yes         | `public, s-maxage=600, stale-while-revalidate=300` | The same for everyone, changes occasionally              |
| `GET /api/tasks`               | **No**      | `private, no-store`                                | Different for every user — Lesson 4.1's security warning |
| `POST /api/tasks`              | **No**      | `no-store`                                         | Writes are never cached                                  |

The `no-store` on the last two isn't optional courtesy. If someone's personal task list is ever cached on the edge by mistake, it **can be served to another user**. That isn't a performance bug, it is a data breach.

---

## 2. Interview Angle

CDN questions almost always come in disguise — **"Your users are all over the world, how would you reduce latency?"** Don't stop at "I'll use a CDN". Say **what** goes on the CDN (static assets, public pages) and **what never does** (personalized API responses), and why — saying the second part shows you know the risk.

The sharpest follow-up: **"Something is cached on the CDN and you want to change it right now — what do you do?"** — talk about purges, but also talk about content hashing, and say why hashing is better (no purge needed, no reliance on propagation delay). And mentioning that "purge all" can bring an avalanche onto the origin puts you clearly ahead.

Another one that trips many people up: **"What is the difference between `no-cache` and `no-store`?"** — `no-cache` means "keep it, but check before using"; `no-store` means "don't keep it anywhere". The two names are confusing, and interviewers know that most people mix them up.

---

## 3. Key Takeaway

- **Anycast** — the same IP is announced worldwide, and routing itself sends the request to the nearest PoP
- **Cache key** = scheme + host + path + query string; the query string makes separate entries (watch out for `utm_*`)
- **`Vary: Cookie` effectively turns off CDN caching** — a separate entry per user
- `max-age` is for both browser and CDN, `s-maxage` only for the CDN, `private` means the CDN won't keep it
- **`no-cache` ≠ "don't cache"** — it means "check first"; "don't keep it" is `no-store`
- `stale-while-revalidate` — serve the stale copy immediately even after expiry and fetch the new one in the background (the cure for stampedes)
- **ETag + 304** — on expiry you don't refetch the whole body, you just revalidate
- **Content hashing is better than purging** — a new name means a new cache key, no purge needed
- "Purge all" empties every edge in the world and can bring an **avalanche** onto the origin
- Personalized/sensitive responses never go on the CDN — this isn't a performance bug, it is a **data breach**

---

## 4. New Terms (Glossary)

| Term                       | Meaning                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| **Anycast**                | Announcing the same IP from several places, with routing sending to the nearest |
| **Cache Key**              | What the edge uses to treat two requests as "the same thing"                    |
| **`s-maxage`**             | A TTL only for shared caches (CDN), overrides `max-age`                         |
| **stale-while-revalidate** | Serving the expired copy immediately while fetching a new one in the background |
| **ETag**                   | A fingerprint of the content, used in conditional requests (304)                |
| **Purge**                  | Telling the CDN it has to forget a cached thing right now                       |
| **Origin Shield**          | A layer between the edge and the origin, so the origin isn't hit repeatedly     |

---

## 5. Reflection Questions

Think about your answer first, then open the Answer Key.

1. TaskFlow's marketing page has `Cache-Control: public, max-age=3600`. A developer noticed that after updating the page, **some users still see the old one after 1 hour, and some even after 2 hours**. Even after a CDN purge, the problem remained for a few people. Why?

2. To improve performance, a developer put `Cache-Control: public, max-age=300` on TaskFlow's `/api/tasks`. Everything worked fine on staging (it got faster!), but after going to production, support got complaints — **some users can see someone else's tasks**. What exactly happened, and why wasn't it caught on staging?

3. TaskFlow's logo is at `/logo.svg`, with `max-age=86400`. The design team wants the new logo to show up everywhere **right now**. Apart from purging, how else could this have been done, and why would it have been better?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** Because `max-age=3600` is also addressed **to the browser**. A CDN purge does delete the edge copy, but users whose **browser** already holds the copy won't even ask the CDN for the next hour — the browser serves it from its own store. **A purge only reaches the CDN, not the browser.**

Why "even after 2 hours"? Because each user's clock started at a different time — someone got the page 59 minutes before the update, someone 1 minute before.

The right design: give the browser a short time and the CDN a longer one —
`Cache-Control: public, max-age=60, s-maxage=3600`. Then after a purge everyone gets the new one within at most 1 minute.

**Question 2:** `public` means **shared caches can keep it too**. So the CDN kept user A's task list under the cache key `/api/tasks` — and then when user B came to the same URL, the edge gave them **user A's data**. There is no trace of the user in the cache key (auth is in the Authorization header or a cookie, which isn't part of the default cache key).

**Why wasn't it caught on staging?** Probably for two reasons: (a) the CDN may have been bypassed on staging, (b) and even if it wasn't, perhaps only one person was testing — returning one user's data to that same person doesn't look wrong. **Unless you test the same endpoint with several users, this bug is invisible.**

The right way: `Cache-Control: private, no-store`. And if you want speed, do it in Redis with a user-specific key (Lesson 4.4) — not on the CDN.

This is Lesson 4.1's warning becoming real: it isn't a performance bug, it is a **data breach**.

**Question 3:** **Content hashing** — keep the logo under the name `/logo.a1b2c3.svg` and reference that name in the HTML. A new logo means a new hash, which means a new name, which means a **completely new cache key** — there is no conflict with any old copy anywhere.

Why it is better: (a) no reliance on purge propagation delay, (b) the browser cache is bypassed immediately too (question 1's problem doesn't exist here), (c) you can set `max-age` to a year, so the hit ratio is maximal, (d) rollback is easy — the old name still works.

This is the logic behind SvelteKit's `_app/immutable/` folder.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

TaskFlow is launching a new **public sharing** feature: any user can make one of their task lists "public", and anyone (without logging in) can view it at `taskflow.app/share/{token}`. These pages can go viral — a popular list could get thousands of hits a minute.

**What you have to decide:**

1. Exactly which `Cache-Control` header would you give `/share/{token}`? State values for `max-age`, `s-maxage` and `stale-while-revalidate` separately, with reasoning for each.

2. If the user **makes** their shared list **private**, what happens to the copy sitting on the edge? What exactly has to happen in your design so that nobody can see it within 1 second? Would content hashing help here — why, or why not?

3. The page shows the user's name and picture. If the user changes their name, how long will the old name stay on the shared page? Is that acceptable? If not, what would you change?

4. **A bit harder:** a developer proposed — "let's show a small 'you are logged in' banner on the shared page, so users can recognize their own list." How does this one small feature break the whole caching design? How can you keep the feature and avoid the problem?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3 (complete), 4.1, 4.2, 4.3, 4.4
Current: 4.5 — How a CDN works
TaskFlow state: Nginx reverse proxy + LB, horizontal-scale-ready backend,
Redis caching layer (measured: 12ms → 3.7ms), and now the CDN design is decided —
static/public content on the edge (hashed assets with a one-year max-age),
personalized API never (private, no-store)
Terms learned (Module 4 so far): Cache Hierarchy, CDN, PoP, Edge Cache TTL,
Buffer Pool, Cache-Aside, Read-Through, Write-Through, Write-Behind,
Write-Around, Cold Start, TTL, Staleness Window, Cache Invalidation,
Eviction Policy, LRU, LFU, Cache Pollution, Cache Hit Ratio,
Discriminated Union, Fail-safe, Offline Queue, Anycast, Cache Key,
s-maxage, stale-while-revalidate, ETag, Purge, Origin Shield
Weak spots: [where you got stuck — fill this in yourself]
Next: 4.6 — Cache Failure Patterns (stampede, thundering herd, hot key)
=======================
```

---

## 8. Next Lesson

Send the exercise over — especially number 4; that one has caught out countless teams in real life.

When you are ready, write `next` — Lesson 4.6, the last lesson of Module 4. So far we have seen what happens when the cache **works**. Now we'll see what happens when the cache **breaks** — and the strangest part is that the cache's most dangerous failures happen precisely when it was working fine. Stampedes, the thundering herd, hot keys — all three are problems that exist **because the cache is there**.
