# Lesson 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style)

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 2.5):** Why is offset pagination slow on a big table, and how does cursor pagination avoid it? There the question was about **speed**. Today you will see another problem with offset in a feed, one that happens even on a small table: new posts pile up on top while the user is reading, and in 41% of sessions the second page brings back posts already seen.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 2.5 (Pagination), Lesson 4.2 (Cache-aside), Lesson 4.6 (Hot key), Lesson 5.8 (Sharding, scatter-gather), Lesson 7.2 (Queue), Lesson 7.6 (Batch vs stream), Lesson 9.4 (Bulkhead), Lesson 10.4 (Tail latency, percentile), Lesson 11.3 (Fan-out, sequence)

**By the end of this lesson you will be able to:**

1. Answer a feed's central question, **when do we stitch it together** (into every follower's timeline at write time, or from everyone's posts at read time), with numbers, going by the power law distribution of follower counts, not the average
2. Design hybrid fan-out, and say where its real gain is (average writes are about the same, but there is no celebrity spike), how to split the fan-out queue so one celebrity does not hold up everyone else, and where it costs on the read side
3. Catch two subtle problems on the read path: the p99 explosion when fetching from many places at once (and hedged requests), and offset pagination's mistakes on a moving feed; plus where ranking sits

**Tier:** 1 — Runnable Code (three deterministic models and a real Express + Zod hybrid feed service; no Docker needed)

---

## 0. Today's System

The interviewer:

> "Design Twitter's home timeline. Users follow some people and see their new posts on the home page. 300 million daily users."

Remember 11.3's question 3? In a group of 10,000 members, writing every message to every member's inbox was becoming impossible. The news feed is that question as a whole system: every "follow" is a one-way relationship, and one person's followers range from ten people to 150 million. The first move is almost always one of two:

- "Keep a timeline list for every user. When someone posts, put it in all their followers' lists. Reading is then reading one list."
- "At read time, fetch the latest posts of everyone the user follows and sort them by time."

Both are correct answers, for different people. The interviewer's follow-ups:

- "Someone has 150 million followers. They posted. How many writes in the first approach? How long until it's done? What happens to everyone else's posts meanwhile?"
- "In the second approach, how many places do you go to for one feed read? What is its p99?"
- "The user is scrolling, and new posts are arriving at the top. What will they see on the second page?"
- "On an unfollow, or when a post is deleted, will you remove it from every timeline?"

---

## 1. Theory

### 1.1 Step 1 — Requirements

```
Question                                     Assumed
How many users?                              500 million accounts, 300 million DAU, opening the feed 10 times a day
How many posts?                              0.1 a day per account on average (most only read)
Following how many?                          200 on average; follower counts follow a power law (below)
Feed order?                                  time order today; ranking discussed at the end
How soon does a new post show?               a few seconds is fine (not real time like chat)
How far back can you scroll?                 a few hundred posts; nobody goes further
Left out                                     post creation and media (8.2), search (8.3), like/comment counts, notifications (11.5)
```

Non-functional: opening the feed is fast (p99 ~100 ms on the server), reading the feed almost always works (if one part is slow, show the rest, 10.3), new posts in a few seconds, and **eventual consistency is fine**: if my followers see my post a few seconds late, nobody notices. But **I myself** see my post immediately (6.3's read-your-writes).

### 1.2 Step 2 — Estimation, and why the average lies

**Fan-out on Write (Push)** — when a post is created, place it right then in the prepared timeline of every one of the author's followers; reading means reading one list, your own timeline. **Fan-out on Read (Pull)** — the post only goes in the author's own list; at read time, fetch the recent posts of everyone you follow and stitch them together.

The cost of both depends on one number: how many followers a post has. And that number is not even. In social networks follower counts roughly follow a power law: most people have few, a few people have enormous numbers. `npm run estimate` fits a power law (α = 1.2) to an average of 200:

```
── Part A — the follower distribution: 500 million accounts, following 200 on average, power law (α = 1.2), max 150 million ──
median account (p50)                                      62
p99                                                    1,613
p99.99                                                74,850
biggest account                                  150,000,000
the top 0.01% of accounts (50,000) hold 18.2% of all follows
the top 1% of accounts (5,000,000) hold 44.3% of all follows

── Part B — traffic ──
                                                 average/s        peak/s
feed reads                                          34,722       104,167
new posts                                              579         1,736
```

The average is 200, but the median account has 62. And 50,000 accounts (0.01%) hold 18% of all follows. When you say "200 writes per post on average", you are forgetting exactly the posts that bring the system down. So in estimation always ask: **what does the distribution look like, and what is in the tail?**

And reads are 60 times writes (104,000 vs 1,700 at peak). This ratio favours push: make the thing that happens over and over (reading) cheap, and pay on the thing that happens rarely (writing). The only question is the celebrities in the tail.

### 1.3 API and data model

```
POST   /users/:id/posts                → 201 { id }
POST   /users/:id/follow/:target       → 204       DELETE the same → 204
DELETE /posts/:id                      → 204
GET    /users/:id/feed?limit=20&cursor=<last seen id>  → { items[], nextCursor }
```

```
post(id, author_id, body, created_at, deleted_at)           ← durable, sharded by author
follow(follower_id, followee_id, created_at)                ← indexed both ways: "who I follow" and "who follows me"
author_posts: author → [post id, …] (the recent few hundred)  ← cache, for pull
home_timeline: user → [post id, …] (at most 800)           ← cache, for push, ids only
```

Three details:

- **Only ids in the timeline.** The post's text, images and the author's name come from a separate cache (hydration). A popular post's text is in the cache once, not in 150 million timelines. And when a post is edited, it changes in one place.
- **The post id is itself time order.** An id like Snowflake's (time + machine + sequence number) that roughly grows with time. Then "sort by id descending" means "newest first", and a cursor means "smaller than this id". A relative of 11.1's range allocation, but here time order is kept on purpose, because it is not a secret.
- **Timeline Cache** — a bounded list of each active user's home timeline (here 800 ids), in memory (a Redis list or sorted set). Bounded because nobody scrolls past 800, and whoever does can fall back to pull. Inactive users' timelines are not kept; when they come back, it is built once by pull. Twitter's published timeline design (talks from 2012–13) is roughly this: a list of ~800 ids in Redis, a fan-out service, and big accounts' posts merged in at read time.

### 1.4 Step 3 — Push, pull, hybrid: in numbers

```
── Part C — three paths (40% of followers active; 800 ids × 16 B in a timeline) ──
path                                      timeline writes/s    biggest post  fetch per read  fetch/s (peak)     cache
fan-out on write (push to everyone)                 115,741     150,000,000             1.0         104,167    3.8 TB
push, active followers only                          46,296      60,000,000             1.0         104,167    3.8 TB
fan-out on read (pull from everyone)                      0               0           200.0      20,833,333         —
hybrid: over 1,000,000 → pull                        42,091         400,000            19.2       1,996,773    3.8 TB
hybrid: over 100,000 → pull                          38,446          40,000            34.9       3,636,764    3.8 TB
hybrid: over 10,000 → pull                           32,660           4,000            59.9       6,240,577    3.8 TB
over 1,000,000 followers: 2,178 accounts, 9.1% of all follows
```

- **Push:** a read is one fetch, but writes are 116,000 a second, and 150 million for one post. Pushing only to active followers (those who came in the last month, 40%) is two and a half times less; the rest are pulled once when they come back. This is a nearly free first improvement.
- **Pull:** zero writes, but every feed read goes to 200 places: 20 million fetches a second at peak. And its latency (1.6).
- **Hybrid Fan-out** — ordinary accounts' posts are pushed, and posts from accounts with followers above a threshold (celebrities) stay only in their own list; at read time, the user's prepared timeline is merged with the recent posts of the few celebrities they follow.

There is something unexpected in the hybrid rows: **average writes barely drop** (46k to 42k, at the 1 million threshold). Because there are only 2,178 accounts with more than 1 million followers, and they hold 9% of all follows. Hybrid's gain is not in the average, **the gain is in the spike:** the writes for the single biggest post go from 60 million to 400,000. Why that matters so much is in the next section.

And the price: fetches per read go from 1 to 19 (the average user follows 18 accounts with over 1 million followers). But these fetches are the recent posts of the same 2,178 accounts, which can be kept in every feed server's local memory (a few MB), so they are not really network fetches but memory reads. The lower you set the threshold (10,000), the more celebrities there are (570,000), the less their posts fit in local memory, and the read cost turns into real fetches. So the threshold sits where the celebrities' posts fit in a small, hot cache.

### 1.5 The fan-out queue: how one celebrity holds up everyone

With push, creating a post is fast (one write), then the fan-out goes to a queue (7.2), and workers place it into followers' timelines. Say the fan-out's total capacity is 2 million writes a second, and the normal load is ~7% of that. `npm run fanout`: 1,736 posts/s at peak, the biggest account posts at the one-minute mark, and the next five together at 200 seconds (at the end of a match, say):

```
policy                                                        ordinary post p50       p99        worst  > 5 s late  big post done
one FIFO queue, push to everyone                                         100 ms  142.10 s     147.70 s     311,955       147.80 s
two queues: big jobs (> 100,000) separate, 25% of capacity               100 ms    100 ms     156.60 s           8       157.40 s
hybrid: over 1,000,000 followers are not pushed                          100 ms    100 ms       300 ms           0        by pull
```

- **One FIFO queue:** the celebrity's 60 million writes sit at the head of the queue, and every ordinary post waits behind them. **More than 300,000** ordinary posts arrive more than 5 seconds late, p99 142 seconds. Someone tweeted after a big match, and the rest of the world's feeds stood still for two and a half minutes. This is 9.4's bulkhead problem, inside a queue: **put big and small work in one line and the small die behind the big.**
- **Two queues:** big jobs in a separate queue, with their own share of capacity. Ordinary posts no longer get stuck (p99 100 ms). But 8 posts still got stuck: these are mid-sized accounts (100,000 to 1 million followers), whose jobs crossed the "big" threshold and landed in the same line as the celebrities. Experiment 2: raising the "big" threshold to 1 million puts them back in the small queue, worst case 400 ms. And raising the big queue's share from 25% to 50% **changes nothing,** because the small queue's load is low anyway and the big queue gets the remaining capacity. The share only matters when both queues are busy.
- **Hybrid:** a celebrity's post never enters the queue. The ordinary posts' worst case is 300 ms, and the celebrity's post "arrives" instantly, because followers pull it at read time.

So hybrid's real argument: **bound the worst-case cost of a single post.** The average stays about the same, but the system's behaviour no longer depends on one person's one tweet.

### 1.6 The read path: whose p99 is it when you fetch from many places?

The cost of pull is not just the number of fetches. A feed read finishes when **the slowest fetch** arrives. In 10.4 we saw that the average hides the tail; here the tail multiplies. `npm run read` part A: each fetch has a median of 2 ms, but 1% of the time 50 ms (GC, a busy shard, the network):

```
path                                                     K       p50       p99  at least one slow
push: your own timeline only                             1   2.01 ms   6.69 ms               0.9%
hybrid: timeline + ~19 celebrities                      20   4.40 ms     53 ms              18.2%
hybrid, slow ones hedged (second try at 10 ms)          20   4.40 ms     14 ms              18.1%
pull: posts from all 200                               200     52 ms     54 ms              86.7%
pull, with hedging                                     200     12 ms     52 ms              86.8%
```

**Tail Amplification** — if a request depends on K parts and each has probability p of being slow, the probability that at least one is slow is 1 − (1 − p)^K. With K = 200 and p = 1%, **87%**: even pull's **median** feed read (p50) is 52 ms, because almost every read has some slow part. One part's "rare" tail becomes the whole system's "normal" state. (That is the core of Google's "The Tail at Scale".) Experiment 3: even with only 0.1% slow, 18% of pull reads have a slow part, and p99 is still 53 ms.

**Hedged Request** — if a part does not answer within a set time (here 10 ms, near the normal p95), send the same request to another replica, and take whichever comes first. Slowness is often temporary and on one machine, so the second try is often fast. In hybrid, p99 goes from 53 to **14 ms**. The price: one extra request for the parts that take longer than 10 ms (a few % here). But in pull, hedging saves p50 (52 to 12) and not p99 (52): with 200 parts, somewhere a hedge's second try is slow too. Keeping K small is a stronger tool than hedging.

Here is push's real argument on the read side: one fetch, one tail. And if hybrid's celebrity part is in local memory, it doesn't even add to K.

### 1.7 Pagination: offset on a moving feed

**The spaced repetition answer:** offset is slow because the database has to read all the earlier rows and throw them away; a cursor starts from "after this", going straight there via the index. That was about speed. A feed has another problem: while the user reads the first page, new posts pile up on top. Part B, 2 new posts a minute, 30 s on average to read a page, 2% of the first page deleted:

```
how the page works                        already seen on page 2     one skipped
?offset=20 (skip the first 20)                                  40.6%           18.4%
?cursor=<last seen id> (id < cursor)                        0.0%            0.0%
```

Offset 20 means "skip the first 20 of the current list". But two new posts have arrived at the top of the current list, so the last two of the first page come back on the second page: repeats in **41%** of sessions. And if a post is deleted from the first page, everything moves up one slot, and one post is never seen: in **18%**. Experiment 4: with 10 new posts a minute, 78% repeats. With a cursor ("give me older than the id I last saw") both are zero, because it anchors on a specific post, not a position in the list. And the new posts on top? That is a separate question: "what is newer than this id" (pull-to-refresh, or a "12 new posts" button).

### 1.8 Ranking (not measured, the structure)

Today's feed is in time order. Facebook's or Instagram's feed is ranked: the most "relevant" first. The structure sits on top of today's design, in three steps:

1. **Candidate Generation** — picking a few hundred candidates from thousands of possible posts, cheaply: the user's timeline cache (push), the celebrities' recent posts (pull), and some sources outside follows (popular posts, "what your friends liked"). Today's whole design is really this step.
2. **Scoring:** for each candidate, fetch features (how much interaction with the author, the post's age, its type, how many likes) and score it with a model. The latency budget is tightest here: a few hundred candidates × feature lookups, so the features are computed ahead of time into a fast store (from 7.6's stream or batch).
3. **Mixing and rules:** not three in a row from the same author, slots for ads, dropping what has already been shown.

One design consequence of ranking: a cursor and "smaller than the id" no longer work, because the order is not by time. So at the first page the whole ranked list (a few hundred) is built once and kept in a small session cache, and later pages come from that list, so the order does not change and repeat mid-scroll.

### 1.9 A real hybrid feed

`npm run smoke` runs an Express feed service: a celebrity threshold of 3 followers (small, for demonstration), star with 4 followers (pull), alice with 2 (push), and a fan-out queue that is `drain()`ed by hand:

```
#   step                                                        result
1   alice posted a1; the fan-out queue hasn't run yet           bob: (empty); 2 in the queue
2   the fan-out worker ran                                      bob: a1[push]; 2 timeline writes
3   star posted s1 (4 followers → not pushed)                   0 in the queue; amy: s1[pull]
4   bob's feed: push and pull merged, in id order               s1[pull] a1[push]
5   cat, first page (limit 3)                                   a7[push] a6[push] a5[push]
6   meanwhile a8, a9 arrived; second page ?offset=3             a6[push] a5[push] a4[push]
7   second page ?cursor=6                                       a4[push] a3[push] a2[push]
8   bob unfollows alice (the ids remain in his timeline)        bob: s1[pull]
9   s1 deleted                                                  amy: (empty)
10  the counts                                                  18 timeline writes (22 if everyone were pushed), 9 pull reads
```

- Steps 1–2: push's eventual consistency, visible: the post exists, but it reaches bob's timeline only after the fan-out worker runs. In this exercise the author also sees it only after the fan-out. Read-your-writes needs the author's own list merged in at read time too, and that is task 4 of the practical exercise.
- Steps 3–4: star's post goes into no queue, and at read time merges with the push timeline in id order.
- Steps 6–7: 1.7's numbers, before your eyes: with offset, a6 and a5 again; with a cursor, exactly the next ones.
- Steps 8–9: **Unfollows and deletes are filtered at read time.** Alice's ids are still in bob's timeline cache, but at read time "do I still follow this author" and "has the post been deleted" are checked and they are dropped. Much cheaper than a fan-out to delete a post from 150 million timelines (another celebrity spike). The dead ids left in the cache gradually fall off on their own at the 800 limit.

### 1.10 Step 5 — Trade-offs and wrap-up

**The final design:**

- **Writes:** the post into the durable store (sharded by author), into the author list, then, if the author has fewer than 1 million followers, into the fan-out queue, for active followers only. The fan-out queue in two parts (small and big jobs), so that mid-sized accounts don't hold up ordinary ones either.
- **Reads:** the timeline cache (800 ids) + the recent posts of the celebrities among those you follow (a cache in local memory), merged by id, then filtered (unfollow, delete, block), then hydrated (the post's text and author from a separate cache). When an inactive user comes back, the timeline is built once by pull.
- **Pagination:** a cursor (the last seen id), and "newer than this" for new posts.
- **Tail:** keep K small (hybrid's celebrity part local), hedge the remaining fetches.

> **Trade-off Table — when to stitch it together**

| Path                       | Write cost                                            | Read cost                                 | Delay before a new post shows               | Where it's good                                          |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Push (all followers)       | 116,000/s on average, up to 150 million for one post  | 1 fetch, a short tail                     | When the fan-out finishes (minutes in FIFO) | Many reads, few and even followers                       |
| Push (active only)         | Two and a half times less                             | 1 fetch; one pull for a returning user    | The same                                    | Almost always better than push                           |
| Pull                       | Zero                                                  | 200 fetches, even p50 in the tail (52 ms) | Immediate                                   | Many writes, few reads; or a very small system           |
| Hybrid (1 million+ → pull) | About the same on average, but no spike (400,000 max) | 1 + celebrities from local memory         | Ordinary: seconds; celebrity: immediate     | Big social networks — wherever there is a power law tail |

**What breaks first:** accounts near the threshold (if followers hover around 1 million, they swing between push and pull; give the threshold some hysteresis, like pull when rising to 1 million, push when falling to 800,000); a viral post's hydration (one post id in everyone's feed, its text and like count a hot key in the cache, 4.6); and the feature store's latency once ranking is added.

---

## 2. Interview Angle

"Design Twitter/news feed" is one of the most common questions, and the interviewer will almost certainly go to push vs pull and celebrities. The shape of a good answer:

1. **The read-write ratio and the distribution in the requirements.** "Reads are 60 times writes, so lean towards push. But follower counts follow a power law, so let's look at the tail."
2. **Both paths, with numbers.** Push's writes (average and worst case), pull's reads (fetches and the tail).
3. **Hybrid, and its real reason.** Not the average, the spike: bounding the worst-case cost of a single post, and not jamming the fan-out queue.
4. **The details that set a senior apart:** push only to active followers, only ids in the timeline, unfollows and deletes filtered at read time, cursor pagination, hedged requests, and seeing your own post immediately.

**Follow-ups that are almost certain:**

- _"How will you handle celebrities?"_ — Hybrid: pull above the threshold, their posts in a small hot cache (a few thousand accounts). The numbers: 2,178 accounts over 1 million, 9% of all follows.
- _"How long does the fan-out take? What happens meanwhile?"_ — In one FIFO everyone gets stuck behind the celebrity (p99 142 s). Hybrid, or at least separate queues for big and small jobs.
- _"Will you delete from timelines on an unfollow?"_ — No, filter at read time; it falls off on its own at the cache's limit. The same for deletes.
- _"Inactive users' timelines?"_ — Don't keep them. Build once by pull when they come back.
- _"Pagination?"_ — A cursor (id < last seen). Offset on a moving feed repeats and skips (41%, 18%). In a ranked feed, build the session's list once and keep it.
- _"The feed server's latency?"_ — One fetch with push. With pull, as K grows, p99 is the slowest part's, and even p50 is. Keep K small, hedge.

**In real production:** the most common incidents: after a big event (a match, an election), a fan-out backlog on celebrities' posts and everyone's feeds a few minutes stale; losing the timeline cache (a Redis failover) and the load of rebuilding millions of timelines at once (like 11.3's reconnect storm, on the database); "the same post twice" complaints with offset pagination; and the whole feed slowing down when the ranking's feature store is slow, where a time-ordered fallback (10.3's degradation) could have saved it.

---

## 3. Key Takeaway

- **A feed's central question: when to stitch — at write (push) or at read (pull).** Reads are 60 times writes, so the lean is towards push, but the answer comes from the distribution's tail
- **Follower counts follow a power law, and the average lies:** average 200, median 62, biggest 150 million; 0.01% of accounts hold 18% of all follows
- **Hybrid's gain is not in the average, it's in the spike:** average writes 46k to 42k, but the biggest post 60 million to 400,000. Celebrities' posts in a small, hot, local cache, so the read cost is almost nothing
- **Mix big and small work in one queue and the small die:** in a FIFO, 300,000 posts are stuck more than 5 s behind a celebrity (p99 142 s). Separate queues or hybrid
- **Fetching from many places at once multiplies the tail:** with K = 200 and 1% slow, 87% of reads have a slow part, and pull's p50 itself is 52 ms. Keep K small; hedge (hybrid p99 53 → 14 ms)
- **Offset shows wrong results on a moving feed:** in 41% of sessions posts already seen come back, in 18% one is skipped. Zero with a cursor
- **Push only to the active, only ids in the timeline, filter unfollows and deletes at read time** — each one saves a fan-out

---

## 4. New Terms (Glossary)

| Term                        | Meaning                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fan-out on Write (Push)** | Placing a post into the timeline of every one of the author's (active) followers when it is created; reads are cheap (one list), writes equal the follower count — tens of millions for one celebrity post   |
| **Fan-out on Read (Pull)**  | The post only in the author's list; at read time, fetch everyone's recent posts and merge — cheap writes, reads as many fetches as you follow, and their tail                                                |
| **Hybrid Fan-out**          | Accounts below a threshold push, those above (celebrities) pull, merged at read time — about the same average cost, but the worst-case cost of one post is bounded and the fan-out queue doesn't jam         |
| **Timeline Cache**          | A bounded list (say 800) of post ids for each active user's home timeline, in memory; ids only, text in a separate cache; none for inactive users, built once by pull when they return                       |
| **Tail Amplification**      | For a request that depends on K parts, the chance that at least one is slow is 1 − (1 − p)^K — one part's rare tail becomes the whole request's normal state                                                 |
| **Hedged Request**          | When a part doesn't answer within a set time (near the normal p95), the same request to another replica, taking whichever comes first — a few extra requests cut p99 a lot, as long as K is small            |
| **Candidate Generation**    | The first step of a ranked feed: cheaply picking a few hundred candidates from thousands of possible posts (timeline, celebrities, other sources); then scoring with features and a model, then mixing rules |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. A new product: a professional network like LinkedIn, where instead of follows there are two-way "connections" (at most 30,000), and some "influencers" can be followed (up to tens of millions of followers). The feed is ranked, and every post shows its likes and comments. (a) Which of this lesson's decisions change, and which stay the same? (b) Where will you put the threshold (push vs pull), and why might it differ from Twitter's? (c) Where is the cost of showing a post's like count in everyone's feed hiding?

2. One shard of the timeline cache's Redis cluster was lost (with its data), and it held the timelines of 30 million active users. (a) What happens on their next feed read, and what is the load on the database (posts and follows), using the numbers from 1.2 and 1.4? (b) Where does this match 11.3's reconnect storm? (c) Three ways to soften this event.

3. A user complained: "I posted, and my friend didn't see it for 5 minutes, yet they saw someone else's post right away." (a) For which three of this lesson's reasons could this happen? (b) Which metric would you look at for each? (c) Which of them is "correct behaviour" and which is a bug?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) **Stays the same:** hybrid's core structure (influencers have tens of millions of followers, so their posts are pulled), only ids in the timeline, push only to the active, cursors, filtering. **Changes:** (1) connections are two-way with a maximum of 30,000, so the tail of ordinary relationships is short and bounded — push's worst-case cost is known; (2) the feed is ranked, so 1.8's three steps are mandatory, and pagination uses the session's list; (3) for ranking, candidates come from a bigger area (posts your connections liked or commented on — "your connection X liked this"), meaning another fan-out: even a like is now an event that may go into connections' feeds.

(b) Push's threshold is about two different relationships: connections (at most 30,000) can always be pushed because the worst-case cost is bounded; follows (influencers) get a threshold like Twitter's. And in a ranked feed "new posts immediately" matters less, so the threshold can be lowered (more pull), because the candidates for ranking are gathered at read time anyway, and a few seconds of extra work is small next to the ranking's own work.

(c) The like count: every feed read has to show every post's count. A viral post is in tens of millions of feeds, so its counter is a hot key (4.6) — on both reads and writes. On writes: `UPDATE … SET likes = likes + 1` on every like is a fight over a row lock (like 11.1's click counter); so split the counter (several sub-counters, summed on read, 11.2's key splitting) or count in batches from events. On reads: nobody notices if the number is a few seconds old, so a short-TTL cache and a local cache.

**Question 2:**

(a) 30 million users have no timeline. When they next open the feed, the system takes the "inactive user returned" path: building by pull, meaning the recent posts of 200 people for each one. 1.2 has 104,000 feed reads a second at peak, 10% of which are on this shard (30 million / 300 million) = ~10,000 reads/s, each 200 fetches = **2 million fetches/s**, just like 1.4's pull row, but suddenly, with no preparation. And even if most fetches hit the author list cache, the misses go to the post database.

(b) The same shape: a stateful part was lost, and all its clients want "build it again" at once. Handshakes in 11.3, timeline rebuilds here. And the same risk: the rebuild load slows the database, rebuilds fail on the slow database, failed rebuilds retry — heading towards congestion collapse.

(c) (1) **A limit on the rebuild rate, and partial answers:** without a timeline, show only celebrities' and the closest few people's posts on the first feed (cheap, 10.3's degradation), and the full rebuild through a queue, at a controlled rate. (2) **Replicas:** a replica of the timeline cache's shard (Redis replication), so losing one node doesn't lose data — double the memory, but this event becomes seconds instead of hours. (3) **Request coalescing and keeping the author list cache warm:** many users want the same authors' posts, so keep the author list cache's hit rate high and merge simultaneous requests for the same author into one (4.6's stampede prevention).

**Question 3:**

(a) (1) **A fan-out backlog:** the author's post is being pushed, and the queue is stuck behind a celebrity's job (1.5, minutes in a FIFO). The other post that showed immediately was perhaps a celebrity's (pull), which never goes into the queue. (2) **The friend was inactive:** only active followers are pushed to; if the friend was on the "inactive" list their timeline was not built, and part of the rebuild on their first feed came from a stale author list cache. (3) **Stale cache:** the whole feed page came from a small session cache (in a ranked feed), or the friend's app is showing an old page without a pull-to-refresh.

(b) (1) The fan-out queue's length and the age of the oldest job (lag), per queue; the p99 from post to the last timeline. (2) The rate of followers skipped as "inactive", and the number of rebuilds. (3) A "built at" timestamp in the feed response, and the client's refresh events.

(c) Five minutes is outside this design's promise (a few seconds), so if it is (1), it is a **bug or a capacity problem** (the queue not split). (2) is partly correct behaviour, but if the definition of inactive is so strict that daily users get skipped, it is a bug. (3) is the client's behaviour, often a product decision (it should have shown a new-posts button). And the "someone else's post immediately" part is correct behaviour: in hybrid, celebrities' posts are always immediate, because they are fetched at read time. This asymmetry is part of the design, and the product should be told about it.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (three deterministic models and a real Express + Zod hybrid feed service; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-11.4-news-feed/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.4-news-feed) — `npm install`, then `npm run estimate`, `npm run fanout`, `npm run read`, `npm run smoke`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out traffic and the writes, reads and cache of push, pull and hybrid from a power law follower distribution (fitted to an average of 200). `fanout` runs a 10-minute fan-out queue, with celebrities' posts, under three policies. `read` measures the tail of K fetches in a feed read (with hedging) and offset vs cursor on a moving feed. `smoke` runs a real hybrid feed service and shows 10 steps.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the four scripts twice each, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **The follower distribution is a model** (α = 1.2, average 200, max 150 million), not measured; every account is assumed to post at the same rate. The fan-out capacity (2 million/s) and fetch latency (median 2 ms, 50 ms 1% of the time) are assumed. `smoke`'s store is in memory, with no ranking. Twitter's timeline design (~800 ids in Redis, hybrid) and Google's "The Tail at Scale" come from published writing, not verified here. **Not measured:** a real social graph, a real Redis, ranking and a feature store, the cost of hydration, like/comment counters.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `estimate`, write down: if people follow 200 on average, how many followers does the median account have? And how many accounts have more than 1 million followers? Then run it and compare.

2. **Find the threshold:** looking at `THRESHOLD` (in fanout) and the hybrid rows (in estimate), pick a threshold where (a) the biggest push job is less than one second of the fan-out's capacity, and (b) there are so few celebrities that their last 100 posts (~1 KB each) fit in 1 GB of a feed server's memory. Can both conditions be met at once?

3. **The price of hedging:** in `read`, `HEDGE_AFTER_MS=5` and `HEDGE_AFTER_MS=20`. How does p99 change? Roughly what % of fetches are doubled in each (estimate it from the fetch latency distribution)?

4. **Changing code:** the README's experiment 5 (crossing the threshold). Then in `src/feed.ts`, guarantee "seeing your own post immediately": when the author reads their own feed, show their new post without waiting for the fan-out. Add a step to `smoke` that shows it.

5. **The design part:** a "one-page design doc" for this feed, in Lesson 1.2's five steps: (a) the requirements, with read:write and the distribution; (b) five numbers and one decision from each; (c) the picture of the write and read paths, with hydration; (d) the hybrid threshold and the fan-out queue split, with numbers; (e) a runbook for losing the timeline cache (reflection 2).

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges), 11.1 – 11.3
Current: 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style)
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 — URL shortener (11.1);
2 — rate limiter service (11.2); 3 — chat (11.3). Case study 4 — news feed: 500 million accounts, 300 million DAU,
reads 104,000/s vs posts 1,700/s (peak). Followers follow a power law (average 200, median 62, max 150 million; 0.01%
of accounts hold 18% of all follows). Hybrid: over 1 million followers → pull (2,178 accounts, their posts in a local
cache), the rest pushed to active followers only; average writes about the same (46k → 42k), but the biggest post
60 million → 400,000. The fan-out queue in two parts (in one FIFO, 300,000 posts stuck 5 s+ behind a celebrity, p99
142 s). Timeline cache: 800 ids, ids only, active users, 3.8 TB. Unfollow/delete filtered at read time. Tail
amplification on pull (K = 200, with 1% slow 87% of reads have a slow part); hedging (hybrid p99 53 → 14 ms). Cursor
pagination (offset: 41% repeats, 18% skipped). Ranking: candidate generation → scoring → mixing, a session list.
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (vs Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation
Weak spots: [where you got stuck — write it yourself]
Next: 11.5 — Case Study: Design a Notification System
=======================
```

---

## 8. Next Step

Today's thread: **whether to do the stitching at write or at read is decided by the distribution's tail, not the average.** With more reads, push is natural, but a few thousand accounts in the power law's tail want tens of millions of writes for one post and jam everyone else's queue. Hybrid cuts off that tail without changing the average. And on the read path, a rule that will come back in many more places: the more places you fetch from at once, the more your p99 belongs to the slowest of them.

When you are ready, write `next` — we go to **Lesson 11.5: Design a Notification System**. Today I kept setting "notifications (11.5)" aside: waking an offline user (11.3), news of a new post, a password reset email. The questions are new: which channel an event goes to (push, email, SMS), where the user's preferences and night-time quiet hours are checked, what happens when the external providers (APNs, FCM, the email service) are slow or down, how to make sure the same notification doesn't go out twice, and how a "tell everyone" campaign keeps from holding up every other notification.
