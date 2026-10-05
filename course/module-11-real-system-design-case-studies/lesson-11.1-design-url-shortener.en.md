# Lesson 11.1 — Case Study: Design a URL Shortener

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 1.3):** Roughly how many seconds are in a day, and what do we round it to for easy maths? If 100 million new things are created a month, how many is that per second on average? Today, this one division decides half the design: which part needs sharding, and which part never will.

**Prerequisite:** Lesson 1.2 (Design framework), Lesson 1.3 (Estimation), Lesson 2.5 (API design, error contract), Lesson 4.2 (Cache-aside), Lesson 4.3 (LRU, TTL), Lesson 4.6 (Hot key), Lesson 5.4 (Index), Lesson 5.8 (Sharding), Lesson 7.6 (Batch vs stream), Lesson 9.5 (Rate limiting), Lesson 10.1 (Consistent hashing), Lesson 10.2 (Bloom filter, HyperLogLog), Lesson 10.5 (Security)

**By the end of this lesson you will be able to:**

1. Take a vague question ("build a URL shortener") through Lesson 1.2's five steps to a design: the requirement questions, the numbers, the API and data model, the high-level picture, and two deep dives. And show with estimation which tools are **not** needed: sharding for writes, a Bloom filter for "is this code taken", a HyperLogLog per link
2. Compare the four ways of making a short code (random, hash, counter, counter + secret permutation) with numbers: collisions, how many trips to the database, and whether someone can find other people's links by guessing. Say why the length of the keyspace is a decision, and why the birthday bound breaks the hash approach
3. Design the redirect path: how much the cache gives and where it stops, the hot key, and why 301 is cheap but breaks both analytics and taking a link down. And keep click analytics off the redirect path

**Tier:** 1 — Runnable Code (three deterministic models and a real Express + Zod shortener; no Docker or database needed)

---

## 0. Today's System

Up to Module 10, every lesson had one of TaskFlow's problems, and the lesson's name told you which tool it needed. In Module 11 we set TaskFlow aside. From now on every lesson is a new system, from scratch, like the room of an interview.

Say you are in an interview room. 45 minutes. The interviewer says:

> "Design a URL shortener. Something like bit.ly."

Nothing more. That is the question.

The most familiar first move is to write on the board straight away: "Take the MD5 of the long URL, keep the first 7 characters, save it in the database." A design in two minutes. Then the interviewer's questions start coming, and each one opens a crack in the previous answer:

- "What if the first 7 characters of the hashes of two different URLs are the same?"
- "How many links a day? Kept for how many years? How long will 7 characters last?"
- "301 or 302? Why?"
- "Can someone try `abc1234`, `abc1235`, `abc1236` and read other people's links?"
- "What if one link suddenly gets 50,000 clicks a second?"
- "A phishing link was reported. If you disable it, is it really disabled?"

The URL shortener is one of the most common interview questions, because it looks very simple. Two endpoints, one table. But behind almost every decision there is a number, and most candidates decide without looking at that number. Today we go the other way round: numbers first, decisions after. And we will watch for something said in the Module 10 exit challenge: many tools from earlier modules will come to mind here (Bloom filter, HyperLogLog, consistent hashing, sharding). The numbers will decide which ones really belong, and which ones are not needed at all.

---

## 1. Theory

### 1.1 Step 1 — Requirements: start with questions

1.2's first step: fix the scope. Ask the interviewer these questions, and when you get no answer, state a reasonable assumption yourself and write it down:

```
Question                                    Assumed (in this lesson)
How many new links?                         100 million a month
Read-to-write ratio?                        100 : 1 (a link is clicked 100 times on average)
Kept for how long?                          10 years ("forever" if no expiry is given)
Custom alias (sho.rt/launch-2026)?          Yes, optional
Expiry?                                     Yes, optional
Analytics?                                  the link's owner sees clicks and unique visitors; not real time, a few minutes' delay is fine
Changing or disabling a link later?         Disabling yes (abuse); changing the destination not today
User accounts?                              Assume they exist, but login is out of today's scope
```

**Functional requirements:** (1) give a long URL and get a short URL, (2) visiting the short URL redirects to the original URL, (3) optional alias and expiry, (4) disabling a link, (5) click counts for the owner.

**Non-functional requirements:** this is where the real design hides.

- **Fast redirects.** A user has clicked a link, and every ms between them and us is overhead. The target inside the server is a p99 of a few ms.
- **Redirects almost never down.** A shortener being down means hundreds of millions of links breaking at once, links printed in books, on posters, in QR codes. By comparison, link **creation** being down for a few minutes does less damage. So the two paths have different SLOs (1.5).
- **A link is never lost.** A code handed out once will go to the same place ten years later.
- **Codes cannot be guessed.** People put links to private things in shorteners (Google Docs, invoices, meetings). Someone finding them by counting through codes is a data leak.
- **Codes are short.** It is in the name.

**Left out:** login, billing, QR codes, link preview pages, changing the destination. Say it in one line, so the rest of the time goes to the core.

### 1.2 Step 2 — Estimation: what the numbers say

**The spaced repetition answer:** a day is 86,400 seconds, ~100,000 for easy maths. A month is ~2.6 million seconds. 100 million a month is ~39 a second.

`npm run estimate`:

```
── Part A — traffic: 100 million new links a month, read:write = 100:1, peak 3× the average ──
                                              average     peak
new links (writes) / s                      38.6           116
redirects (reads) / s                      3,858        11,574
redirect bandwidth                      1.9 MB/s      5.8 MB/s
click events / month                    10 billion      1.0 TB

── Part B — storage: 10 years, 500 B per row ──
one year                               1.2 billion      600 GB
10 years                                12 billion      6.0 TB
```

These few numbers lead to four decisions, and some of them are a "no":

1. **Writes are tiny.** 116 inserts a second at peak. 2–3% of the approximate capacity of an ordinary Postgres primary (say a few thousand small inserts a second). So **writes do not need sharding to scale.** That is the first "no".
2. **Reads are the real load, and it is the same few things read over and over.** ~11,600 redirects a second at peak. The database could take every one, but it does not need to: the same popular links come again and again. That is the cache's job (1.6).
3. **Storage is ~6 TB in ten years.** It fits on one node, but not comfortably: restoring 6 TB from a backup takes ~6.7 hours (remember 10.8's RTO). So partitioning or sharding may come later, **but the reason is storage and recovery, not writes.** And not on day one, but three years or so in.
4. **Click data is much bigger than link data.** 10 billion events a month, ~1 TB. In six months it passes the links' whole ten-year table (~6 TB). It is a separate system (1.7), not inside the redirect database.

Now the keyspace. **Keyspace** — the number of all possible values for a code; with 62 characters and length L, 62^L. And **Base62 Encoding** — writing a number with 62 characters (`0-9`, `a-z`, `A-Z`), exactly as decimal writes it with 10. It has no character with a special meaning in a URL (`/`, `+`, `=`), so it is safer than base64.

```
── Part C — keyspace: base62, 1.2 billion new codes a year ──
length         total codes   years to fill  full in 10 yrs       random: retry    guess hits
5              916 million        9 months          100.0%                full          100%
6             56.8 billion              47           21.1%               21.1%         21.1%
7            3.52 trillion           2,935          0.341%              0.341%        0.341%
8             218 trillion         181,950          0.005%              0.005%        0.005%
```

5 characters run out in nine months. 6 characters last 47 years, so many people say "6 is enough". But look at the last two columns. 21% full in ten years means: (a) if you make random codes, one in every five is already taken, and (b) if someone makes up a random 6-character code and tries it, **one in five is someone's real link**. At 7 characters both are 0.34%. One extra character buys 62 times the space. Where that matters is in 1.5.

And one more list, the price of the tools at this size:

```
── Part D — the tools that come to mind, and their price at this size ──
Bloom filter, all 12 billion codes, 1% error               14.4 GB
HyperLogLog (dense, 12 KB) per link                          147 TB
Sharding: peak writes / one primary                           2.3%
```

These three rows will come back in the later sections.

### 1.3 API and data model

**API** (with 2.5's error contract):

```
POST /api/links          { url, alias?, expiresAt? }
                         → 201 { code, shortUrl, url, expiresAt }
                         → 400 invalid_body | unsupported_scheme | self_redirect | alias_reserved | expiry_in_past
                         → 409 alias_taken
GET  /:code              → 302 Location: <url>      (Cache-Control: private, no-store)
                         → 404 not_found  |  410 expired | disabled
GET  /api/links/:code/stats         → 200 { clicks, uniqueVisitors }
POST /api/links/:code/disable       → 204
```

Notice two things. Expired and disabled links get **410 Gone**, not 404: "this existed, now it doesn't" and "this never existed" are different statements, and search engines and clients treat them differently. And redirects are 302, not 301. Why, with numbers, is in 1.6.

**Data model** (Postgres):

```sql
CREATE TABLE links (
  code        varchar(32) PRIMARY KEY,
  long_url    text        NOT NULL,
  owner_id    bigint,
  custom      boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  disabled_at timestamptz,
  disabled_reason text
);
CREATE INDEX links_owner_created ON links (owner_id, created_at DESC);
CREATE SEQUENCE link_ids;
```

The redirect path has one query: a primary key lookup by `code` (5.4's index, a few pages of a B-tree). An index on `owner_id` for the owner's "my links" page. Clicks are **not** in this table. `UPDATE links SET clicks = clicks + 1` on every redirect means every read becomes a write: a fight over locks on the rows of popular links (5.5), and a database built for 116 writes/s suddenly getting 11,600 writes/s. Turning the read path into a write path is the most common mistake in this design.

### 1.4 Step 3 — High-level design

```
                      ┌─────────────────────────── redirect path (99%, strict SLO) ──────────────────────────┐
  browser ── GET /aB3xY9k ──► [LB] ──► [redirect service × N] ──► [Redis cache] ──miss──► [Postgres replica]
                                              │  stateless, local LRU                          ▲
                                              │                                                 │ replication
                                              └── click event (fire-and-forget) ──► [queue / log] ──► [analytics: batch or stream]
                                                                                                │
  app/API ── POST /api/links ──► [LB] ──► [API service × M] ──► [range allocator] ──► [Postgres primary]
                      └──────────────────────────── write path (1%, relaxed SLO) ──────────────────────────────┘
```

- **Two paths, two deployments.** It can be the same codebase (9.1's modular monolith), but redirect and API run separately: separate scaling, separate SLOs, and a bad API deploy does not touch redirects (10.3's blast radius).
- **The redirect service is stateless** (1.6). Each instance has a small local cache, behind it a shared Redis, behind that a Postgres read replica.
- **The click event does not make the redirect wait.** The redirect answers, and the event goes to a buffer or queue (7.1). If analytics is slow or down, redirects keep going, because analytics is a soft dependency here (10.3).
- **On the write path, a range allocator** makes the codes (1.5).

Where is consistent hashing in this picture? Only inside the Redis cluster (10.1's hash slots), which we do not write ourselves. Not for the database, because there is one database.

### 1.5 Deep dive 1 — How to make the short code

This is the real engineering question of this system, and 1.2's reflection named exactly this as the place for a deep dive. Four approaches, measured with `npm run keygen`. It runs with a smaller keyspace (4 characters, 14.8 million slots), because retries and collisions depend only on **how full** it is, and "0.341% full" is exactly ten years at 7 characters.

**Approach 1 — A random code, then check whether it is taken.** 7 random characters, `INSERT ... ON CONFLICT DO NOTHING`, and again if taken.

```
full        avg attempts  needed retry   max attempts  when at 6 chars  when at 7 chars
0.341%          1.0035        0.35%              2     1.9 months     10.0 years
21.1%           1.2693       21.28%              8     10.0 years      619 years
50.0%           2.0032       50.15%             18     23.7 years    1,467 years
90.0%          10.0904       90.13%            120     42.6 years    2,641 years
```

The retry rate is exactly how full it is. At 7 characters, 0.35% in ten years: one extra round trip every 285 links. Negligible. At 6 characters, one in five in ten years, and it keeps growing with time. At 90%, 10 attempts on average, 120 at worst. The random approach has no coordination (every server makes its own), and codes cannot be guessed. The price: a "is it taken" question on every creation, which the database's unique constraint handles by itself.

Here comes the first thought of a Bloom filter: "check the Bloom filter for whether the code is taken before going to the database." But for 12 billion codes at 1% error, that is **14.4 GB**, on every server, always kept updated with new codes. What does it save? 99.65% of inserts succeed the first time, so the Bloom filter would only save the 0.35%'s one round trip. And even when it says "not there", we still have to insert, so the database's work does not shrink. **The second "no".**

**Approach 2 — The URL's hash, first 7 characters.** Attractive, because the same URL always gets the same code, and it dedupes with no lookup. But the first 7 characters of the hashes of different URLs can match:

```
full              link     collisions  % insert  birthday estimate  avg attempts
0.341%          50,388             97    0.193%               86      1.0019
10.0%        1,477,634         73,894    5.001%           73,882      1.0536
21.1%        3,117,807        329,366   10.564%          328,929      1.1234
At 7 chars in 10 years (12,008,705,807 links): an estimated 20,474,843 links will hit a collision.
```

**Birthday Bound** — throw N things at random into K slots and roughly N²/2K pairs land in the same slot. The name comes from "in a room of 23 people, the chance that two share a birthday is over 50%". Collisions start much earlier than you would think. The measured numbers match the estimate almost exactly (329,366 vs 328,929). At 7 characters in ten years, **~20 million** links collide.

So how will you handle a collision? Add a salt to the URL and hash again. Now the hash approach's only advantage, "same URL → same code", is broken: you cannot know which URL's code was salted without looking in the database. And before every insert you have to check "is this code another URL's?", just like random. Two more problems: anyone can compute the hash of a URL and find out whether someone has shortened it (if they know the URL of a private document). And two different users giving the same URL get the same code, so they cannot have separate analytics or separate expiries. **The hash approach pays all of random's costs, and cannot deliver its own advantage.**

**Approach 3 — Counter + base62.** An increasing number (a Postgres `SEQUENCE`), written in base62. No collisions, one trip per creation, and the shortest codes (only 6 characters at 12 billion). But:

```
── Part C — finding by guessing: 0.341% full, the 10,000 codes before your own and 10,000 random attempts ──
strategy                                                      last 5 codes      hits before    hits random
counter → base62                                  0d6C 0d6D 0d6E 0d6F 0d6G          100.00%          0.34%
random                                            DB0u rO8O ypzM aKdZ fKLX            0.32%          0.44%
counter → secret permutation → base62             f6sF 5OVy JR1Y iGCX HIx8            0.43%          0.27%
```

**Link Enumeration** — finding other people's links by counting through or guessing codes. With a counter, make one link of your own and count backwards: **100%** real links, including others' freshly created private documents. This is not theoretical: a 2016 study ("Gone in Six Characters: Short URLs Considered Harmful for Cloud Services") scanned the short code space of popular shorteners and found personal information, including cloud storage share links and map addresses, because the codes of the time were only 5–6 characters. A counter leaks one more thing: the size of your business. From the difference between two codes, anyone can tell how many links you make a day.

**Approach 4 — Counter + secret permutation + base62.** Keep all the counter's advantages and hide the order. Pass the counter's number through a **secret, one-to-one (bijective) permutation**, which takes every number in [0, 62^7) to a distinct number in that same range. One-to-one, so collisions are impossible. It cannot be reversed without the secret key, so the codes of consecutive ids look random.

**Format-Preserving Permutation** — a keyed, one-to-one transformation inside a fixed range, so the output stays in the same range as the input (here, 7-character base62). In the exercise it is built with a small **Feistel network**: split the number in two, and over a few rounds XOR one half with a keyed hash of the other. The Feistel structure itself keeps it one-to-one, whatever the hash function. 62^7 is not a power of two, so when the result falls outside the range it is run again (**cycle walking**) until it lands inside:

```
whole 3-char domain (238,328 ids): 238,328 distinct outputs — no collisions; extra rounds: 23,816 (10.0%)
7 chars, ids 1–5:  0000001 → cOoEtMq   0000002 → BnqHDLC   0000003 → yhc3OjR   0000004 → NJcTAiA   0000005 → l3tBYTa
```

Verified by running every id in a small domain: 238,328 ids, 238,328 distinct codes. And in the guessing test it behaves like random (0.43%, close to the fill rate). An honest caveat: this is **not secrecy, only making guessing hard.** This 4-round Feistel is not a proven cipher, and if the key leaks the whole order can be reversed. The answer for truly private links is authentication (10.5), not hiding the code. In production this job should use proven format-preserving encryption (like NIST's FF1), or at least cycle walking over a good block cipher.

**Sharing out the counter.** One counter means going to the counter on every creation, and the counter is a single point. **Range Allocation (Ticket Server)** — each app server takes a block from the counter at once (say 1,000 ids) and hands them out from its own memory; when they run out, another block. The name "ticket server" comes from a published Flickr design, where a separate small database's only job was handing out ids. Taking a block at a time is an old, common improvement on top of that (in the ORM world it is called hi/lo).

```
── Part D — sharing out the counter: 20 app servers, 3,333,333 links a day, each server restarts 1× a day ──
block     sequence calls / day  wasted ids / day  wasted / year, 7 chars  out of time order
1                   3,333,333               0                0.00000%              0.0%
1,000                   3,354          10,161                0.00011%             47.5%
10,000                    353          99,804                0.00103%             47.5%
```

With a block of 1,000, trips to the counter drop a thousandfold. Two prices. (1) When a server restarts, the rest of its block's ids are lost: ~10,000 a day, 0.00011% of the keyspace a year. Negligible, and lost ids are never used, so it is safe. (2) Ids are no longer in time order (in 47.5% of cases the next link's id is smaller), so sorting "newest links first" needs `created_at`, not the code. After the permutation there is no order anyway.

The honest bit: at a peak of 116 links/s, calling Postgres's `nextval()` directly is no problem at all. Range allocation is needed when the counter is a separate service, or when links have to be created in several regions (10.8) (give each region a big range, and they never collide). Saying this in an interview, and saying that at today's numbers it is optional, are both signs of a senior.

> **Trade-off Table — four ways to make a short code**

| Approach                     | Collisions                               | DB trips to create    | Same URL → same code | Guessable?                    | Coordination                |
| ---------------------------- | ---------------------------------------- | --------------------- | -------------------- | ----------------------------- | --------------------------- |
| Random + check               | At the fill rate (0.35% in 10 yrs, 7 ch) | ~1.0035 attempts      | No                   | No (fill rate)                | None                        |
| First 7 of a hash (MD5)      | Birthday (~20 million in 10 years)       | check + again on salt | Until a collision    | No, but computable from URL   | None                        |
| Counter + base62             | Never                                    | 1 (1/1000 in blocks)  | No                   | **Yes, 100%**                 | Counter (cheap with blocks) |
| Counter + secret permutation | Never (one-to-one)                       | 1 (1/1000 in blocks)  | No                   | No (fill rate), if key secret | Counter + key management    |

**This design's choice: counter (range allocation) + secret permutation, 7 characters.** Random + check is a completely correct answer too, and in many places it is better for its simplicity: at 7 characters retries are negligible, and there is no key to keep. The hash approach only when dedupe is itself a requirement and the complexity of handling collisions is acceptable.

**Custom aliases colliding with generated codes.** A subtle trap: someone asks for `abcDEF1` as an alias, which is 7-character base62. It is free today. But some day the permutation will produce exactly that code, and the insert will fail. So the exercise's app forbids 7-character base62 aliases (`alias_reserved`), and aliases may contain `-` or `_`, which generated codes never do. The two namespaces are separate, so a collision is impossible. (The generator's loop also takes the next id if a code is `taken`, purely as a safety net.)

### 1.6 Deep dive 2 — The redirect path

Redirects happen ~11,600 times a second, and almost all are a primary key lookup. Two questions: how much to cache, and what to tell the browser.

**How much the cache gives.** `npm run redirect` part A: 2 million links, 6 million redirects, Zipf popularity (s = 1, a few links very popular, most opened by almost nobody), LRU (4.3):

```
cache                                          entry   hit rate  DB reads/s (peak 11,574)  memory, at 1 billion links
shared cache (Redis), 0.1% of links            2,000      43.1%                     6,591                  250 MB
shared cache (Redis), 1% of links             20,000      60.4%                     4,578                  2.5 GB
shared cache (Redis), 5% of links            100,000      73.2%                     3,100                 12.5 GB
shared cache (Redis), 20% of links           400,000      84.8%                     1,757                 50.0 GB
local 0.1% on each app server (10)             2,000      43.1%                     6,590             250 MB × 10
```

- **The first 0.1% of links get 43% of traffic.** After that every extra GB buys less: from 1% to 20%, 20 times the memory, hit rate from 60 to 85%. This is the long tail of popularity: most links are not opened even once a month, and keeping them in cache means keeping memory nobody will read.
- **Even at 85% hits, the database gets ~1,800 reads/s.** For a primary key lookup, one or two read replicas are enough (5.7). Meaning the cache's job is not saving the database, but cutting latency and absorbing spikes. So the target hit rate is not "the highest", but "the database is comfortable and p99 is met".
- **Zipf's s sets the real number.** Experiment 1: with s = 1.2, a 1% cache gets 89%. And in a real shortener most of a new link's clicks come in its first few days, which this model does not have, so the real hit rate is probably higher. Size the cache by measuring your own traffic, not by guessing.
- **A local cache does not give more for the same memory** (ten servers, 10 times the memory, the same 43%). But it gives something else, below.

**The hot key.** The most popular link is 6.6% of all redirects, ~770/s at peak. All of it on one Redis node, because it is one key (10.1: consistent hashing sends one key to one place, it does not split it). Still fine. But if a link goes viral, say 50,000 a second, all of it on one node, and that node's other keys get slow too (4.6). The answer: the redirect service's **local cache**, with a TTL of a few seconds. With ten servers that is 5,000/s on each, and almost nothing on Redis. A link's destination does not change (in today's scope), so the local cache's risk of stale data is only "a disabled link keeps working for a few more seconds". Acceptable. Two layers: local LRU (small, for hot keys) → Redis (big, for the tail) → replica.

**Codes that don't exist.** When someone scans codes (link enumeration), almost every request's answer is "not there", and nothing is in the cache, so everything goes to the database: 10.2's cache penetration. Here the Bloom filter comes to mind again, 14.4 GB. The cheap layers first: (1) a negative cache (cache the 404 answer with a short TTL), (2) a rate limit on the 404 rate by IP and ASN (9.5), because ordinary users almost never get a 404, and a scanner gets almost nothing but. And because of the permutation, the scan's results give little anyway. A Bloom filter only when these are shown not to be enough.

**301 or 302.** **301 / 302 Redirect** — both send the browser to the address in the `Location` header. 301 means "moved permanently": the browser may cache it and next time go straight to the destination without asking the server. 302 means "for now": it asks the server every time (unless `Cache-Control` says otherwise). 301's temptation: less load on the server. Part B: 100,000 people click a link, come back twice more on average, 85% of browsers keep the cache, and on the seventh day the link is disabled as phishing:

```
policy                                   click   server saw  not in analytics  clicks after off  still reached dest
301 (permanent, browser remembers)       300,664        43.2%            56.8%          189,422             62.6%
302 + Cache-Control: max-age=3600      300,664        97.7%             2.3%          189,422              2.3%
302 + Cache-Control: private, no-store      300,664       100.0%             0.0%          189,422              0.0%
```

301 cuts the server's load by more than half. But it has two prices, and both are at the heart of this product:

1. **Analytics is half blind.** 57% of clicks never reach the server. One of the product's main features ("how many people clicked my link") shows false numbers, and undercounts exactly the links that people come back to most.
2. **A link cannot be disabled.** After disabling, **63%** of clicks still went to the phishing site, from the browser's memory. The server does not even know. And there is no way to take it back: the browser's cache is not in your hands. In experiment 2 (everyone keeps the cache, coming back five times on average, like a link-in-bio or a QR code), 89%.

So **302 + `Cache-Control: private, no-store`.** We paid for the server's load in the cache (above), not in the browser. The middle road (`max-age=3600`): 2% less load, and up to an hour of working after being disabled. Some products choose it. But in a system whose responsibility is taking abusive links down, "letting phishing run for an hour" has to be a conscious decision.

### 1.7 Analytics — off the redirect path

The requirement: the owner sees clicks and unique visitors, a few minutes late. The redirect path has one job: hand a small event (code, time, a hash of the visitor, referrer, country) to a buffer, without waiting. The rest is in a separate pipeline (7.2's log, 7.6's batch or stream).

The first thought for counting unique visitors: "one HyperLogLog per link, we learned it in 10.2." Part C, 10 billion clicks a month, Zipf over 1 billion links:

```
method                                                    memory   note
exact set per link (visitor hash, 16 B)                  96.0 GB   exact; big on popular links
dense HLL (12 KB) per clicked link                        8.1 TB   656 million links clicked — most of them small
set when small, HLL when big (Redis sparse → dense)       40.2 GB   only 369,858 links have more than 768 unique
collect click events, count in a nightly batch (7.6)         0 RAM   ~1.0 TB/month of raw events on disk; hours of delay
```

**A dense HLL per link is 85 times bigger than the exact sets.** Because an HLL's cost is fixed (12 KB) however small the count, and the middle links do not get even one click a month. An HLL only wins when one thing is very big and you want to keep the cost of measuring it fixed: here only ~370,000 links have more than 768 unique visitors. (Redis itself keeps small HLLs in a sparse form, for exactly this reason. But the thought "one HLL per link" often skips that maths.) **The third "no"**, at least not for every link.

In this design: the events go to a log (Kafka or Redis Streams, 7.2), and a stream job adds up each link's clicks every few minutes into a small table (`link_daily_stats`). Unique visitors in a columnar store (7.6) from the raw events, at query time or overnight. And if the dashboard has to show "current" uniques, an HLL only for the popular links (say those with more than 1,000 clicks today). The tool was not wrong; putting it everywhere was.

The exercise's app has this in miniature: the redirect calls `ClickBuffer.record()` and returns the 302 straight away, and a timer flushes the buffer every second. Smoke steps 17 and 18: after five clicks, before the flush, stats show 0 and the buffer 5; after the flush, 5 clicks, 3 unique. The "a few minutes' delay" requirement is what makes this design possible.

### 1.8 Abuse, expiry, and validation

An open shortener is a favourite tool of phishing and malware: it hides the real address, and sits behind a trusted domain. So validation on the write path is part of the design, not something to add later. `npm run smoke` runs a real Express server:

```
#   request                                               status  result
1   POST /api/links  https://example.com/blog/syste…      201     https://sho.rt/cOoEtMq
2   POST /api/links  (the same URL again)                 201     https://sho.rt/BnqHDLC
3   GET /cOoEtMq                                          302     Location: https://example.com/blog/system-design?ref=newsletter
5   POST /api/links  url: javascript:alert(1)             400     unsupported_scheme
6   POST /api/links  url: https://sho.rt/abc (own domain)  400     self_redirect
9   POST /api/links  alias: launch-2026 (again)           409     alias_taken
10  POST /api/links  alias: abcDEF1 (7-char base62)       400     alias_reserved
14  GET /yhc3OjR  (2 hours later)                         410     expired
16  GET /cOoEtMq                                          410     disabled
```

- **Only `http` and `https`.** Zod's `url()` calls `javascript:alert(1)` a valid URL, because it is a valid URL. The scheme has to be checked separately. This is 10.5's point: "parsing" and "trusting" are different.
- **Not your own domain.** Shortening `sho.rt/abc` makes a redirect loop or chain, which abuse uses to hide addresses.
- **The same URL again gets a new code** (step 2). This is a decision: different owner, different expiry, different analytics. If you want to return the old one for the same owner, an index on `(owner_id, hash of long_url)` (experiment 5).
- **Expiry checked at read time.** The redirect query checks `expires_at`, so 410 the moment it expires. Deleting from the database is separate, slow, in a background job, and deleted codes are **not** reused: someone's new link opening from a code printed on an old poster is a bad surprise.
- **Disabled means disabled at once** (steps 15, 16). Possible only because of 302 and no-store. At the cache layer, delete the key when disabling (4.3's invalidation), and the local cache's TTL is a few seconds.
- **The other layers (not in the exercise):** a rate limit on creation by account and IP (9.5); checking the destination URL against lists of known bad URLs, asynchronously, and again later (because good URLs go bad); a way to report.

### 1.9 Step 5 — Trade-offs and wrap-up

The final design, on one page:

- **Writes:** API service → range allocator (block of 1,000, from a Postgres sequence) → secret permutation → 7-character base62 → Postgres primary. Aliases in a separate namespace. Validation: scheme, own domain, alias rules, rate limit.
- **Reads:** redirect service (stateless, separate deployment) → local LRU (TTL of a few seconds, for hot keys) → Redis (a few % of links) → Postgres read replica. 302 + `private, no-store`. Expiry and disabling checked at read time, 410.
- **Analytics:** fire-and-forget event from the redirect → log → stream job (click counts, a few minutes) + columnar store (uniques, batch). Redirects do not depend on analytics.
- **Deliberately absent:** sharding for writes (peak writes ~2% of a primary); a Bloom filter for "is the code taken" (14.4 GB, and with a counter the question does not even exist); an HLL per link (8.1 TB, bigger than exact); our own consistent hashing for the database.

**What breaks first, and when:**

- **Storage and recovery, in three or four years.** Past 2–3 TB, a backup restore takes hours. The answer: partition by `created_at` (like 5.8's retention, older partitions on separate storage), or hash-shard by `code`. Codes are random, so hash sharding gives no hot partitions, and a redirect's query always goes to one shard (the shard is known from the code itself). Consistent hashing may have a place here, then.
- **Ten times bigger** (experiment 4): peak writes are ~23% of the primary, still one primary. 6 characters would run out in five years; at 7 characters, 3.4% in ten years, so 7 holds. Reads ~116,000 a second: the cache layer grows, and keeping redirects at the CDN's edge comes up (reflection 2 below).
- **Several regions:** range allocation earns its keep here, each region with its own range. On the read path, replica lag means a new link is a 404 in a far region for a while (6.3).

> **Trade-off Table — decisions on the redirect path**

| Decision           | Chose                                     | Alternative          | What I gave                                        | What I got                                                         |
| ------------------ | ----------------------------------------- | -------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Kind of redirect   | 302 + `private, no-store`                 | 301                  | every click at the server (the cache's cost)       | correct analytics, links disabled at once (301: 63% after disable) |
| Cache              | Local LRU (TTL of seconds) + Redis        | Redis only / DB only | two layers of complexity, a few seconds on disable | hot keys never reach Redis; 60% hits at 1%                         |
| Counting clicks    | Event → log → stream/batch                | `clicks + 1` on row  | a few minutes' delay, a separate pipeline          | the read path stays a read; redirects run with analytics down      |
| Unique visitors    | Batch/columnar, HLL only on popular links | HLL per link         | "current" uniques only on big links                | almost zero RAM instead of 8.1 TB                                  |
| Non-existent codes | Negative cache + rate limit on 404s       | Bloom filter         | a scanner can send some queries to the database    | saved 14.4 GB and the machinery to update it                       |

---

## 2. Interview Angle

The URL shortener is often the first or second system design interview question, and sometimes a "warm-up" before a bigger one. Because it looks simple, the interviewer watches how deep you go on a simple thing. The shape of a good answer:

1. **Start with questions, within five minutes.** How many links, read:write, how long, aliases, expiry, analytics. And say two non-functional things on your own: redirect availability matters more than creation, and codes must not be guessable.
2. **Decisions from estimation.** "Writes are 116/s, so one primary; reads are 11,600/s and skewed, so cache; 7 characters because 6 characters are 21% full in ten years." Don't stop at saying the numbers; say what comes out of them.
3. **Deep dive: code generation.** At least three approaches, each with its price. Birthday for hash, enumeration for counter, retries for random. Then pick one and say why.
4. **The redirect path.** The reasons for 301 vs 302 (analytics, disabling), the cache, the hot key, and moving analytics off the path.

**Follow-ups that are almost certain:**

- _"What's wrong with taking MD5 and keeping the first 7 characters?"_ — The birthday bound: N²/2K, ~20 million collisions in ten years at 7 characters. Handling them needs a salt and a check, and then the "same URL → same code" advantage is gone too. And the code can be computed from the URL.
- _"Isn't the counter a single point of failure?"_ — Range allocation: each server takes a block, and the counter is called a few times a minute. Even if the counter is down for a few minutes, the servers can run on their blocks. And the redirect path never touches the counter.
- _"Why are sequential codes bad?"_ — Enumeration (counting back from your own code gives 100% real links) and leaking the size of the business. A secret permutation or random. And for truly private links, authentication, not harder guessing.
- _"What happens on a hot link?"_ — One key goes to one Redis node. A local cache in the redirect service, with a short TTL. The destination does not change, so the stale-data risk is small.
- _"How will you scale the database?"_ — Numbers first: writes don't need it, reads get a cache and replicas. When storage grows, shard by the hash of `code` (codes are random, so the split is even, and each redirect hits one shard).
- _"When will you delete expired links?"_ — Check expiry at read time (410 at once), delete separately in a background job. And never reuse codes.

**In real production:** the most common problems are not code generation but abuse (waves of phishing and spam, and the domain landing on blocklists because of it), click counters built by writing to the database on every redirect that start lock fights on popular links, starting with 301 and later regretting it for analytics or takedowns (with no way back, because old browsers' caches remain), and losing the shortener's domain itself or letting it expire, which kills every link at once.

---

## 3. Key Takeaway

- **Numbers first, tools after.** Writes are 116/s at peak (~2% of one primary), reads 11,600/s, ~6 TB in ten years. So no sharding for writes, a cache for reads, and partitioning for storage later, because of recovery
- **The keyspace's length is a security and cost decision.** At 6 characters, 21% full in ten years: one real link in every five guesses. At 7 characters, 0.34%, for the price of one extra character
- **The hash approach breaks on the birthday bound** (~20 million collisions in ten years at 7 characters), and loses its only advantage when you handle them. **A counter has no collisions but is 100% guessable.** A secret permutation gives both at once; one-to-one, so collisions are impossible
- **Range allocation cuts trips to the counter a thousandfold**, at the price of a negligible number of wasted ids and time order. Optional at today's numbers, essential in multi-region
- **301 is cheap, but hands control of the link to the browser:** 57% of clicks missing from analytics, and 63% of clicks still go to the old destination after it is disabled. Pay for load in the cache, not in the browser
- **The first 1% of cache buys the most** (60% hits), then the long tail. A local cache for hot keys, Redis for the tail. And never a write on the read path: click counts as events in a separate pipeline
- **Measure the price of the tools that "come to mind".** A Bloom filter is 14.4 GB (and with a counter the question does not exist), an HLL per link 8.1 TB (85 times bigger than exact sets). Not the wrong tool, the wrong place

---

## 4. New Terms (Glossary)

| Term                                 | Meaning                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Base62 Encoding**                  | Writing a number with 62 characters (`0-9`, `a-z`, `A-Z`); no character has a special meaning in a URL, so it is safer than base64 for short codes                                                                 |
| **Keyspace**                         | The number of all possible codes (62^L); how full it is sets random's retry rate and the chance of hitting a real link by guessing                                                                                 |
| **Birthday Bound**                   | Throw N things at random into K slots and ~N²/2K pairs land in the same slot — so a hash cut short starts colliding much earlier than you would think                                                              |
| **Range Allocation (Ticket Server)** | Each server takes a block of ids from the counter at once and hands them out from memory; trips to the counter fall by the block size, at the price of ids wasted on restart and losing time order                 |
| **Format-Preserving Permutation**    | A keyed, one-to-one transformation inside a fixed range (like Feistel + cycle walking) — makes random-looking codes from a counter with no collisions; not secrecy, the order can be reversed if the key leaks     |
| **301 / 302 Redirect**               | 301 is "permanent" — the browser caches it and stops asking the server; 302 is "for now" — it comes to the server every time. A shortener uses 302 + no-store, so analytics stay correct and links can be disabled |
| **Link Enumeration**                 | Finding other people's links by counting through or guessing codes; 100% with sequential codes, and equal to how full the keyspace is with random-looking codes                                                    |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. The product team wants two new features: (a) after creating a link, the owner can change its destination (a QR code has been printed, the address has to change), and (b) an enterprise plan where links can only be opened by the company's employees. Which of this lesson's decisions change or become more important (the kind of redirect, the cache, keeping codes secret)? Name one specific change for each.

2. The shortener's users are all over the world, and there is a new requirement: redirect latency as seen by the user, p99 50 ms, on every continent. Writes are still in one region (Singapore). (a) Which of 10.8's topologies? (b) A user in London creates a link and immediately posts it on Slack; someone else in London opens it 2 seconds later. What do they see, and why? (c) The fix, and how it relates to the negative cache?

3. One Monday, 30% of new links are phishing, from one campaign. Several email providers are flagging your domain as suspicious, and that hurts every user's links. (a) What do you do right now, and what do you not do? (b) What layers will you add on the write path, each with the price of its false positives? (c) How does the 302 and no-store decision help here?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) Changing the destination:

- **302 is now mandatory.** With 301, a browser that has opened it once keeps going to the old address, and people with a printed QR code often come back (experiment 2's 89%). With a `max-age`, the old address until it runs out.
- **Cache invalidation.** Before, links never changed, so the local cache's stale-data risk was only about disabling. Now changing is an ordinary event: delete the Redis key or write the new value (4.3), and keep the local cache's TTL short, or broadcast an invalidation (Redis pub/sub). And tell the owner "everywhere within a few seconds".
- **History.** Who changed it to which address, and when (a `link_revisions` table). This matters for abuse: creating an innocent link, passing review, and later switching it to phishing is a known trick. So re-check the destination after every change.
- Also keep the destination at the time in the analytics event, or clicks for the old and new addresses get mixed.

(b) Enterprise private links:

- **Privacy is not by hiding the code.** The permutation makes guessing hard, but links travel through Slack, email, browser history. "Employees only" means authentication and authorization before the redirect (10.5): the redirect service sees the link is private, sends the user to the company's SSO, and when they come back checks whether they are a member of that organization, then 302.
- Now there is a new dependency on the redirect path (identity). Only for private links, so the path for ordinary links stays as fast and independent as before. `visibility` and `org_id` on the link's row, and in the cache too.
- For these links 302 + no-store matters even more: a redirect from a cache means skipping the authorization check.
- And the analytics of private links contain visitors' identities, which is personal data (10.8's residency question comes back).

**Question 2:**

(a) A redirect is almost purely a read, the data is small, and the destination almost never changes. So something like 10.8's "a read replica in every region", or more cheaply **a key-value store at the edge** (the CDN's edge compute + a replicated KV): a copy of code → URL near every PoP. Writes in Singapore, then asynchronously everywhere. The problem from 10.8 (a far replica makes writes slow) hardly exists here, because the redirect path has no writes (click events go to a local buffer and are sent later).

(b) The second user in London will probably see a **404**. The link was written in Singapore and has not yet reached London's edge (replication lag, which in an edge KV can be seconds to minutes). This is 6.3's read-your-writes, but worse: the reader is **someone else**, so no session token helps.

(c) The fix: on a miss at the edge, **ask the home region** (don't treat "not there" as final), and if found, place it at the edge. The price: for codes that really don't exist (a scan), every request goes all the way to Singapore. And this is where the **negative cache** is dangerous: if London's edge caches the first 404 for 5 minutes, it is a 404 for 5 minutes after the link was created, even after replication finishes. Ways out: a very short negative cache TTL (a few seconds), or a hint of creation time inside the code (for example, telling from the counter's range whether a code is "fresh"), and never caching a 404 for a fresh code. Another way: tell the client in the creation response "it may take a few seconds to reach everywhere", and at creation write directly to the few nearest edges.

**Question 3:**

(a) **Right now:** identify the campaign (the same accounts, the same IP ranges, the same destination domains) and disable those links. Because of 302 + no-store, disabling works at once (along with deleting the Redis and local cache keys). Suspend those accounts, and a strict rate limit on their creation path. **What not to do:** block all new links or stop creation entirely (hurting the 70% of legitimate users), or delete every old link by hand (legitimate links go too, and cannot be brought back; disabling can be undone, deleting cannot). And contact the email providers and blocklist owners, because the domain's reputation takes time to recover.

(b) Layers on the write path, cheapest to most expensive:

1. **Rate limit** (9.5): by account and IP, stricter for new accounts. Price: a legitimate marketer who creates 500 links at once gets blocked. Answer: higher limits for verified accounts.
2. **Checking the destination, async:** at creation the link is "pending", checked within a few seconds against lists of known bad URLs and your own signals (new domain, many accounts to the same destination). Price: for those few seconds the link does not work, or shows a "careful" page. A false positive blocks a legitimate user's link, so there needs to be an appeal path.
3. **Checking again later:** an innocent domain goes bad later, so old links are re-checked periodically. Price: a background job and the external API's cost.
4. **Interstitial (a warning page in between):** for links that are suspicious but not certain, a "you are going to X" page. Price: one extra click for legitimate users, and some loss in analytics.

(c) Because of 302 + no-store, every layer's decision takes effect **at once**, even on links that have been opened many times before. With 301, the browsers from all of the first day's clicks would go to the phishing site forever, and nobody could fix it. From the abuse side, 302 is not just an analytics decision, it is the answer to "do we control our own links?"

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (three deterministic models and a real Express + Zod shortener; no Docker or database needed)

> **Ready to run in the repo:** [`exercises/lesson-11.1-url-shortener/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.1-url-shortener) — `npm install`, then `npm run estimate`, `npm run keygen`, `npm run redirect`, `npm run smoke` (and `npm run serve` to play with it yourself). The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out traffic, storage, the keyspace and the price of the tools. `keygen` runs the four ways of making codes and range allocation: retries, collisions (against the birthday estimate), finding by guessing, and a full check that the permutation is one-to-one. `redirect` measures an LRU cache under Zipf traffic, the hot key, 301 vs 302 (analytics and disabling links), and the memory for unique visitors. `smoke` runs a real Express server (validation with Zod, the range allocator, the Feistel permutation, the click buffer) and checks 18 steps and 10,000 links.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the four scripts twice each, output identical byte for byte; create → 302 → stats with `curl` against `npm run serve`. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **The estimation inputs are assumed** (100 million links a month, 100:1, 500 B per row), and Postgres's "5,000 inserts a second" is a rough guess, not measured. `keygen` runs on a smaller keyspace (4 characters) and translates to 7 characters by matching the fill rate. `redirect`'s traffic is synthetic (Zipf, s = 1), with no popularity decay over time; the browsers' 301 behaviour is assumed (85% keep the cache). The unique visitors part is a calculation, not a simulation, and Redis's 12 KB HLL comes from its documentation. The "Gone in Six Characters" study and Flickr's ticket server come from published writing, not verified here. The exercise's Feistel has 4 rounds, for learning; production needs proven format-preserving encryption. **Not measured:** a real Postgres (the schema is in the lesson, not run), a real Redis, real browser caches, the real latency of a redirect, multi-region.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `keygen`, write down: how many collisions will the first 7 characters of a hash have in ten years? A thousand? A hundred thousand? Then work out N²/2K by hand, and run it to compare. Where was your guess wrong?

2. **Sizing the cache:** `ZIPF_S=0.8 npm run redirect` and `ZIPF_S=1.2 npm run redirect`. How much does the 1% cache's hit rate move? Assuming your database comfortably takes 2,000 reads a second at peak, how big does the cache need to be for each of the three values of s?

3. **The temptation of 301:** someone said "301 halves the server bill." Answer with the numbers from `redirect`'s part B and the cache numbers from part A: where does 302's extra load actually go (Redis, the database, or the app servers), and roughly what does it cost, in the style of 10.7?

4. **Changing code:** in `src/app.ts`, return the old code when the same owner gives the same URL again (the README's experiment 5). What index does `MemoryLinkStore` need, and what `CREATE INDEX` is that in Postgres? What do you do for two different owners, and why?

5. **The design part:** write a "one-page design doc" for this shortener, in Lesson 1.2's five steps: (a) requirements and what was left out, (b) five numbers and one decision from each, (c) the picture, (d) two deep dives, each with the rejected alternatives and why, (e) what breaks first and when, and which three tools you deliberately did not use.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges)
Current: 11.1 — Case Study: Design a URL Shortener
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 — URL shortener:
100 million links a month, 100:1, 10 years. Writes peak at 116/s (~2% of one Postgres primary), reads 11,600/s,
~6 TB in 10 years. Codes: range allocation (block of 1,000) + secret Feistel permutation + 7-character base62
(0.34% of the keyspace in 10 years); aliases in a separate namespace (7-character base62 aliases forbidden).
Redirect: separate stateless service → local LRU (hot keys) → Redis (~60% hits at 1%) → read replica;
302 + private, no-store (with 301, 57% of clicks missing from analytics, 63% still reach the old destination
after disabling); expiry and disabling checked at read time, 410. Analytics: fire-and-forget event → log →
stream/batch; no HLL per link (8.1 TB vs 96 GB exact). Deliberately absent: write sharding, a Bloom filter for
"is it taken" (14.4 GB), our own consistent hashing. Later: shard by the hash of code or partition by
created_at, for storage.
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration
Weak spots: [where you got stuck — write it yourself]
Next: 11.2 — Case Study: Design a Rate Limiter service
=======================
```

---

## 8. Next Step

Today's thread: **in a system that looks simple, every decision has a number behind it, and the number often tells you what you won't need.** Writes are so few that sharding is not even a question, and reads are so skewed that the first 1% of cache does more than half the work. The code question has four approaches, and each pays in a different place: hash in collisions, counter in secrecy, random in retries. And one small header, 301 vs 302, decides who controls the link.

When you are ready, write `next` — we go to **Lesson 11.2: Design a Rate Limiter service**. In 9.5 we learned the rate limiting algorithms as an Express middleware, inside one process. This time the question is bigger: a **separate service** that decides on every request from hundreds of API servers, adds under a ms to each, and does not take every API down with it when it dies. Two things from today come back there: the hot key (all of one customer's requests on one counter), and the question that came up today with 301: who makes the decision, and what happens when they are wrong.
