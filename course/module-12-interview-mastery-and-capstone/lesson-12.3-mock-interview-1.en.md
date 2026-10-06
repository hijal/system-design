# Lesson 12.3 — Mock Interview #1: I'm the Interviewer, You're the Candidate

**Module 12 — Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 5.8):** What is a hot partition? Say it in one line. Then go into the mock with a question in mind: if a leaderboard's data is sharded by score range (0-1,000 on one shard, 1,000-2,000 on another, ...), where will the hot partition be born? The answer comes after the mock, in 1.4.

**Prerequisite:** Lesson 12.1 (framework, the ten mistakes, the rubric), Lesson 12.2 (the estimation chain), Lesson 4.4 (Redis), Lesson 5.8 (Sharding), Lesson 11.4 (Fan-out)

**By the end of this lesson you will be able to:**

1. Run a full 45-minute system design interview yourself, against the clock, out loud: requirement questions, estimation, high level, data model, deep dive, and the interviewer's mid-way follow-ups
2. State the core decisions of a real-time leaderboard with numbers: why a sorted set, when one Redis is enough and when it isn't, the order of equal scores, the weekly reset, and why fan-out on read for the friends' leaderboard
3. Score your own recording on 12.1's rubric with evidence, and write feedback the way an interviewer would

**Tier:** 3 — Design Exercise (this is a mock interview; the deliverable is your recording, your rubric score, and your own written feedback. In keeping with Module 12's point there is no script: the numbers in your head, the time on the clock)

---

## 0. Where TaskFlow Is Right Now

TaskFlow stays on the side today. In 12.1's transcript you saw how an interview goes wrong even on a system you know, and in 12.2 you built speed at estimation. Today they come together, for the first time, for a full hour.

In the curriculum's words, in this lesson "I'm the interviewer, you're the candidate". A written lesson can't talk back in answer to questions, so the interviewer's role here is a **script**: the question, the answers to your clarifying questions in a closed section, and each of the interviewer's follow-ups in its own closed section, by the minute. You answer out loud, then open the next one. Whatever you haven't opened, the interviewer hasn't asked yet.

After the whole mock is over (and only then), read on from 1.4: there's a framework for scoring yourself on the rubric, a model answer for what a good hour looks like, and where candidates usually fall on this question.

One thing to say up front: not doing well in your first mock is normal. The goal isn't a good score, it's an **honest recording**, from which you'll know before 12.4 which two things to change.

---

## 1. Theory

### 1.1 Preparation and rules

**You need:** a timer (45 minutes), paper or a whiteboard, an audio or video recording on your phone, and a quiet room. No notes, books, search or AI.

**Rules:**

- **Before starting**, turn the recording on, start the timer, and write the time box in the corner of the board: `Req 5 · Est 5 · HLD 10 · Deep 15 · Wrap 5` (12.1).
- **All of it out loud.** No thinking in silence just because nobody is there. Silence is zero signal on the recording.
- **Ask your clarifying questions out loud,** write them on paper, then open 1.2's "The interviewer's answers". For any question whose answer isn't there, the answer is "you decide" — then it's a stated assumption.
- **Open the follow-ups at their minute,** or earlier if you have finished what you were doing. Open one, answer out loud for 2-4 minutes, then return to your design.
- **For a follow-up whose subject you already raised yourself,** open it, say only in one line "I covered this already, at minute mm:ss", and move to the next. Raising it yourself is a big signal here (12.1's definition of senior), and it will count when scoring.
- **Stop at 45 minutes,** wherever the work is. In reality the interviewer will stop you.

### 1.2 The question (00:00)

The interviewer:

> "We have a popular mobile game. We want a leaderboard. Design it."

That's all. Start the timer now and begin.

<details>
<summary><strong>The interviewer's answers — open after asking your clarifying questions out loud</strong></summary>

Take only the answers to the questions you asked. What's here but you didn't ask, the interviewer wouldn't have said — assume you don't know it, and after the mock write down that the question was missed.

| question                        | the interviewer's answer                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| how many players?               | ~50 million active daily; in a week ~100 million distinct players get some score              |
| how does the score come in?     | 0 to 100 points at the end of each match; an active player plays ~10 matches a day on average |
| which leaderboard?              | weekly, global: the week's total points. A new week at 00:00 UTC on Monday                    |
| what is shown?                  | the top 100; my rank and score; 5 people above and below me                                   |
| how often is it viewed?         | an active player opens the leaderboard ~20 times a day on average, mostly after a match       |
| how fast must it update?        | my own new score should show immediately; a rank a few seconds stale is fine                  |
| equal scores?                   | whoever reached that score first is above                                                     |
| are there prizes?               | yes: each week the top 1,000 get an in-game reward. So the top end must be correct and fair   |
| cheating?                       | yes, a real problem. Our game servers run the matches; the client can't be trusted            |
| peak?                           | in the evening, roughly 3× the average                                                        |
| friends', country leaderboards? | "Those may come later; the global one first."                                                 |
| any other question              | "You decide."                                                                                 |

</details>

### 1.3 The interviewer's follow-ups

Each at its minute, or earlier if the work in hand is done. Open them one at a time.

<details>
<summary><strong>Follow-up 1 — minute ~15</strong></summary>

> "A player tapped 'my rank'. What exactly happens? Which data structure, and what does it cost?"

</details>

<details>
<summary><strong>Follow-up 2 — minute ~20</strong></summary>

> "A match ended. Show me the path the score takes to the leaderboard. And what if the game server sends the same match's result twice? And what if someone sends 9,999 points themselves with a modded client?"

</details>

<details>
<summary><strong>Follow-up 3 — minute ~25</strong></summary>

> "Two people have a score of 4,200. One got there on Tuesday, the other on Thursday. Who's above, and how will you keep that in your data structure?"

</details>

<details>
<summary><strong>Follow-up 4 — minute ~29</strong></summary>

> "The week ends at 00:00 UTC on Monday. What exactly will you do? And what if a match that ended at 23:59:58 on Sunday has its result arrive at 00:00:03?"

</details>

<details>
<summary><strong>Follow-up 5 — minute ~33</strong></summary>

> "Now product wants a leaderboard among friends: where am I among my friends."

</details>

<details>
<summary><strong>Follow-up 6 — minute ~37</strong></summary>

> "The game got ten times bigger: 1 billion players a week. What breaks first, and what will you change?"

</details>

<details>
<summary><strong>Follow-up 7 — minute ~41</strong></summary>

> "The machine with the leaderboard's data was completely lost, replica included. What happens, and how long until it's back?"

</details>

<details>
<summary><strong>Follow-up 8 — minute ~44</strong></summary>

> "We're nearly out of time. Where in this design are you least sure?"

</details>

**45 minutes. Stop the timer, stop the recording.** Take a break here. Before reading the rest, without listening to the recording, write three things on paper: which moment went best, which went worst, and which follow-up you were least prepared for. You'll compare them with the recording later.

### 1.4 Score: along the rubric, with evidence

**The spaced repetition answer:** a hot partition means one shard has much more data or traffic than the others, becoming the bottleneck of the whole system (5.8). Sharding by score range has two problems. First, scores aren't evenly distributed, more like a power law (11.4): most players are at the bottom, so the low-range shards are huge. Second, almost everyone's score keeps rising, so players constantly move from one shard to another, and every move is a write to two shards. And everyone's eyes are on the top 100, so the top shard is read the most. The result: the data load in one place, the read load in another, and the write load at the boundaries. Follow-up 6 comes back to this.

Now listen to the recording (as in 12.1, the next day if you can). 1 to 4 on each dimension, and next to each score an `mm:ss` from the recording as evidence. No score without evidence. The anchors in the table below are written **for this question**:

| dimension                | 1 — weak                                | 2                                                               | 3                                                                                          | 4 — strong                                                                                             |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| handling ambiguity       | started drawing straight away           | a few questions, but scope or "what is shown" was never settled | asked which leaderboard, what's shown, freshness, peak; said the scope out loud            | also asked about prizes and cheating — the two answers that change the design's correctness claims     |
| a working design         | boxes, no data model or API             | one of data model or API                                        | the score path and the read path both end-to-end, with data model and API                  | also clear which is the source of truth (DB/log) and which is derived (the leaderboard's store)        |
| technical depth          | nothing beyond "we'll keep it in Redis" | said sorted set, but no rank cost or numbers                    | O(log N), memory and op/s numbers; correct answers for equal scores and the reset          | also idempotency for duplicate results and retries, and a numbers-backed answer for what breaks at 10× |
| judgement and trade-offs | one solution, no price                  | named alternatives, but no reason for the choice                | two alternatives and a price at the big decisions (e.g. friends: fan-out on write vs read) | said with numbers which tool **isn't needed** (e.g. no sharding at today's size)                       |
| communication            | long silences, scattered on follow-ups  | thought out loud, but no clock or check-ins                     | kept to the time box, check-in when changing step                                          | raised several follow-ups' subjects before being asked; caught and corrected a mistake themselves      |

Resist the temptation to add up the five scores into one number. Real hiring decisions aren't made by sums: a 1 on one dimension (say technical depth) often outweighs everything else, and expectations differ by level (12.1). Broadly: for senior, anything below 3 on depth and judgement, and for mid-level, a 1 on any dimension, probably means "no hire". That's my general observation, not any company's rule.

Then 12.1's checklist of ten mistakes, yes/no and `mm:ss` next to each:

```
[ ] 1  starting without requirements/scope    [ ] 6  leaving out the data model / API
[ ] 2  numbers without a "so"                 [ ] 7  forgetting the clock in the high level
[ ] 3  designing with averages                [ ] 8  only the happy path
[ ] 4  the tool's name first                  [ ] 9  the "best" without a trade-off
[ ] 5  big scale on day one                   [ ] 10 silence / resisting hints
```

### 1.5 What a good hour looks like

Open the model answer below **after giving your own score**. It isn't the only correct answer: there are several reasonable designs for this question, and yours may be different and still good, as long as there's a number or reason behind each decision. What to look at is the shape: what happens at which minute, and which "so" follows each number.

<details>
<summary><strong>Model answer — open after giving your own score</strong></summary>

**00:00–05:00 — Requirements.** Almost all the questions in the table above, but in an order: first "what is shown" (the top 100, my rank, my neighbours), then size, then correctness (prizes, cheating, equal scores). At the end, the scope out loud: "A weekly global leaderboard, the score write path and the read path. Friends and country leaderboards later, if there's time."

**05:00–10:00 — Estimation**, in 12.2's chain:

```
Score writes: 50 million × 10 matches = 5 × 10⁸/day; ÷ 10⁵ ≈ 5,000/s (exactly ~5,800), × 3 → ~17,000/s peak
Reads:        50 million × 20 views = 10⁹/day;   ÷ 10⁵ ≈ 10,000/s (exactly ~11,600),  × 3 → ~35,000/s peak
Ops per read: my rank + 10 neighbours = ~2 ops (the top 100 is the same for everyone, so cached for 1 second)
              → ~70,000 read ops/s + ~17,000 write ops/s ≈ 90,000 ops/s peak
Memory:       100 million players a week × ~100 bytes per entry (assumed, must be measured) ≈ 10 GB;
              ~20 GB for the current and previous week together
Match records: 5 × 10⁸/day × ~50 bytes ≈ 25 GB/day, ~175 GB a week
```

"So": **the whole thing fits in memory on one machine** — 10 GB is small for a Redis, so the need for sharding doesn't come from memory. **The load is in op/s:** ~90,000 ops/s, and I'll plan for a Redis node at ~50,000 ops/s (the same assumption as 11.2: comfortable at ~100,000, half as headroom). Writes at 17,000/s are easy on one primary; reads are the bigger part. So **one primary and 2-3 read replicas,** no sharding. A rank a few seconds stale is fine, so replica lag isn't a problem. Match records at 25 GB a day: weekly partitions, old partitions dropped (5.8's retention).

**10:00–20:00 — High level, data model, API.**

```
 [game server] ──match result (signed)──► [score service] ──► [log, partitioned by user_id] ──► [aggregator]
                                                                                                  │
                                     ┌────────────────── in batches ──────────────────────────────┤
                                     ▼                                                             ▼
                        Postgres: match_results, weekly_totals                        Redis: lb:2026-W41 (sorted set)
                        (the source of truth)                                         (derived, can be rebuilt)
                                                                                                  ▲
 [mobile app] ──► [leaderboard API] ── the top 100 (in-process cache, 1 s) ─────────── read replica ┘
```

```
match_results(match_id PK, user_id, week, points, ended_at)       -- partitioned by week
weekly_totals(week, user_id, points, reached_at, PK(week, user_id))

GET  /leaderboard/:week/top?limit=100
GET  /leaderboard/:week/me            → { rank, score, around: [...] }
POST /internal/match-results          (game servers only, signed)
```

**Sorted Set** — a Redis data structure in which every member has a score and the set is kept sorted by score; inside, a skip list and a hash table. Adding or changing a member (`ZADD`) and finding someone's rank (`ZREVRANK`) are both O(log N). At 100 million, log₂ ≈ 27 steps. Fetching a range (`ZREVRANGE`) is O(log N + the number returned). Each of the leaderboard's three questions is one command.

**Follow-up 1 (my rank):** `ZREVRANK lb:2026-W41 user:123` → the rank, O(log N); then `ZREVRANGE` from rank − 5 to rank + 5. Two ops, from a replica. The top 100 is the same for everyone, so a 1-second cache in the leaderboard API's process: one Redis op for thousands of requests. As a comparison, one sentence: "In Postgres `COUNT(*) WHERE points > mine` is O(rank) on the index — counting tens of millions of rows for a player near the bottom."

**Follow-up 2 (the write path, duplicates, cheating):**

- **Server-Authoritative Score** — the score comes only from our game server that ran the match; the client never sends its own score. The modded client's 9,999 has no path in. The game server's requests are signed (10.5), and the score service has simple limits: no more than 100 in one match, no more matches in an hour than are possible (9.5). An anti-cheat job looks at suspicious patterns asynchronously.
- **Duplicates:** `match_id` is the primary key. The aggregator inserts in batches with `ON CONFLICT DO NOTHING`, and adds **only the newly inserted rows'** points to `weekly_totals`, in the same transaction. If the same result arrives twice, nothing is added the second time (7.4).
- **Why batches:** 17,000 separate transactions a second is heavy for one Postgres primary; in batches of, say, 200, that's ~85 transactions a second. That's the reason for a log on the write path: the game server writes to the log and is done, and the aggregator batches at its own pace.
- **Writing to Redis:** not `ZINCRBY`, because it isn't idempotent — on a retry it adds twice. Instead the DB's total directly: `ZADD lb:2026-W41 GT <total> user:123`. `GT` (Redis 6.2+) means change it only when the new value is bigger; the weekly total only rises, so an old or duplicated update is silently ignored. All of a user's events are in the same log partition, so their order is preserved.
- **My own score immediately:** at the end of a match, the game server's response already contains the new total, and the app shows that (6.3's read-your-writes). The rank comes from a replica a few seconds later.

**Follow-up 3 (equal scores):**

**Composite Score** — packing several things into one number, so that one plain sort obeys two rules. Here: `points × 2²⁰ + (604,800 − seconds since the week began)`. A week is 604,800 seconds, which is less than 2²⁰ (~1 million), so the time part never overflows into the points part. Reaching it earlier leaves more time remaining, so a bigger number, so higher up. An average player gets a few thousand points a week, but the limit has to be worked out from the possible maximum, not the average: a match takes a few minutes, so even playing all week without stopping gives, say, ~200,000 points. 200,000 × 2²⁰ ≈ 2.1 × 10¹¹, far below a Redis score (a double, exact for integers up to 2⁵³ ≈ 9 × 10¹⁵). And when points rise the composite always rises, so `GT` still works correctly. `reached_at` comes from the match's end time, on the game server's clock (6.4: not the client's clock).

**Follow-up 4 (the weekly reset):**

**Time-Bucketed Key** — a separate key for each window of time (`lb:2026-W41`, `lb:2026-W42`), so a "reset" means not deleting anything, just starting to write to a new key. Nothing needs to run at 00:00: a match whose `ended_at` is in the new week goes to the new key. A single `DEL` on a key with 100 million members can block Redis for seconds; on the old key, just an `EXPIRE` (two weeks), or `UNLINK`, which deletes in the background.

Late-arriving results: the week is decided by when the match ended, not when it arrived. The 23:59:58 match goes to the previous week's key, even if it arrives at 00:00:03. So the prize list isn't final at 00:00: a grace window (say 15 minutes, longer than the log's lag), then a snapshot of the top 1,000 in the DB, and the prizes awarded idempotently by each `(week, user_id)` (11.7). Results arriving after that don't change the prizes, they're just on record. (Like 11.7's reconciliation with its ±1 day: tolerance at the boundary.)

**Follow-up 5 (friends' leaderboard):** two paths. **Fan-out on write:** a separate sorted set of friends for each user, and when someone's score changes, writing to all their friends' sets. Assuming 50 friends on average, 17,000 × 50 = **850,000** writes a second, and 100 million × 50 entries in memory. **Fan-out on read:** take the friends list (50 on average, a limit of say 5,000), get everyone's score with one `ZMSCORE` (Redis 6.2+), then sort in the app. One command, 50 lookups. Read wins here (the opposite of 11.4's result, for the same reason: which side costs more). Friends lists are small and bounded, and score updates are far more frequent than reading a thousand times. For large lists near 5,000, the result cached for a few seconds.

**Follow-up 6 (ten times: 1 billion players):**

```
Writes: ~170,000/s peak;  read ops: ~700,000/s;  memory: ~100 GB per week's key
```

What breaks first is **writing to one primary** and **one key's memory**: both are beyond one node's limit. Now sharding. Two paths:

- **By score range:** the spaced repetition answer — most players on the lower shards, all reads of the top 100 on one shard, and players change shards as their score rises. Rejected.
- **By user (hash):** N shards, each with a sorted set of that shard's users. My rank = the sum of `ZCOUNT(above my score)` across all shards: N parallel O(log n) calls (5.8's scatter-gather; easy at N ≈ 20). The top 100 = each shard's top 100 merged and sorted, with a 1-second cache.

And one senior observation that shrinks the whole question:

**Rank Histogram** — a count of how many players have each possible score value (or each small range of values); someone's rank = the sum of all the cells above their score. Here the score domain is small: points are integers, and the possible weekly maximum is ~200,000 (follow-up 3's calculation), which means an array of ~200,000 cells, ~1.6 MB. The rank of 1 billion players, apart from the order within equal scores, comes out exactly from this small array, and it fits in any machine's memory. So the sorted set is needed only for the top end (the prize's 1,000, the top 100, where the order within equal scores matters), and for the billions of players below, a rank from the histogram instead of "#1,432,098", or "top 15%". (If the score's domain is large or fractional you have to make buckets, and then the rank is approximate.)

**Follow-up 7 (Redis completely lost):** Redis isn't the source of truth, it's derived. Rebuilt from `weekly_totals`: read 100 million rows and `ZADD` them in a pipeline, a few minutes (the exact time needs measuring). Meanwhile: the game keeps running and scores keep piling up in the log, because the write path doesn't depend on Redis; the leaderboard page shows "coming back soon" or the last cached top 100 (10.3's degraded mode). After the rebuild the aggregator runs from where it was in the log, and because of `ZADD GT`, updates run twice are safe. In the ordinary case (only the primary dies), a replica is promoted, and the last second's lost updates come from the log again.

**Follow-up 8 (least sure):** "Two numbers I assumed but didn't measure: ~100 bytes per entry in Redis, and a node's capacity for sorted set ops. If the first is wrong the memory math changes; if the second, how many replicas are needed. Both can be measured with a day's load test: 100 million synthetic members, `MEMORY USAGE`, and op/s at the peak mix. And on the business side: cheating. A server-authoritative score stops a lot, but if a real player plays through a bot, it's a valid match in the game server's eyes. That isn't a question of the leaderboard's design, but the fairness of the prizes hangs on it."

**The three sentences of the wrap-up:** "At today's size one Redis primary and a few replicas, no sharding, because memory is 10 GB and the load ~90,000 ops/s. The source of truth is Postgres and the log, Redis is derived, so if it's lost it can be rebuilt. What breaks first is writes and memory at ten times; then sharding by user, and a histogram for ranks lower down."

</details>

### 1.6 Where candidates usually fall on this question

The lines below are sample feedback written for this question. Next to each, the number of 12.1's mistake. Look for any of them in your own recording:

- _"Said 'Redis sorted set' in the first minute, but never asked what has to be shown (the top 100, or my rank, or both)."_ — mistakes 1 and 4. A sorted set is almost certainly the right answer here, but the interviewer doesn't know whether you chose it for a reason or from memory.
- _"Spent 10 minutes on leaderboard sharding, even though by their own calculation the whole thing is 10 GB."_ — mistakes 5 and 2. The most common trap in this question, because writing about "leaderboards at scale" starts with sharding.
- _"Didn't ask where the score comes from; the score sent by the client goes straight into `ZINCRBY`."_ — mistake 8. Cheating and idempotency both left open at once.
- _"Redis is the only store; thought about what happens if it's lost for the first time after the question came."_ — mistakes 8 and 6 (no source of truth in the data model).
- _"On the equal-score question, said 'Redis handles it itself'."_ — Redis orders equal scores by member name, which isn't the "whoever reached it first" rule. Mistake 9: a claim, without checking. If you don't know the right answer, 12.1's "not knowing" sentence.
- _"A separate sorted set per user for the friends' leaderboard, without counting the write cost."_ — mistakes 2 and 9. 850,000 writes/s would have been caught by one number.

**Write your own feedback,** the way an interviewer would, in the third person (calling yourself "the candidate"): three strengths and three areas to improve, each with an `mm:ss`, and at the end a decision (strong hire / hire / lean no hire / no hire) and its one-line reason. The reason for writing in the third person: writing "I was nervous" about yourself is easy; writing "the candidate was silent for four minutes at minute 18" is honest.

> **Trade-off Table — a leaderboard's big decisions**

| decision             | chosen                                         | alternative                             | what was given up                                    | what was gained                                                           |
| -------------------- | ---------------------------------------------- | --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| the rank's store     | a Redis sorted set, derived                    | `COUNT` in Postgres / rank every minute | running another store, and a rebuild path            | O(log N) rank and range; one op even for a player near the bottom         |
| at today's size      | one primary + replicas                         | sharding by user                        | a migration at 10×                                   | no scatter-gather, simple operation (10 GB of memory, ~90,000 ops/s)      |
| the source of truth  | the log + Postgres's `weekly_totals`           | Redis only                              | an extra step on the write path, seconds of batching | Redis rebuilt in minutes if lost; an audit for the prizes                 |
| writing to Redis     | `ZADD GT` with the DB's total                  | `ZINCRBY`                               | reading the total from the DB                        | retries and duplicated updates are safe                                   |
| equal scores         | a composite score (points, then reached first) | Redis's own order (by name)             | an encode/decode rule                                | the "whoever reached it first" rule, in one command                       |
| the reset            | a key per week, `EXPIRE`                       | `DEL` at 00:00                          | two weeks of memory                                  | no work at the reset, Redis doesn't block; late results in the right week |
| friends' leaderboard | fan-out on read (`ZMSCORE`)                    | a sorted set per user                   | ~50 lookups per read                                 | 850,000 writes/s and huge memory saved                                    |

---

## 2. Interview Angle

The leaderboard question comes in a few forms, and each one's deep dive is somewhere different:

- **"Top K" (trending hashtags, most-viewed videos):** here each item's score is a count, and the number of items is huge and unknown. The deep dive goes into stream processing (7.6), sliding windows, and approximate counting (something like a count-min sketch, a relative of 10.2). A sorted set alone isn't enough.
- **"Real-time ranking for a contest" (a coding contest, a live quiz):** a few hours, fewer players, but the last-minute wave and fairness (the time tie-break) are the core.
- **Mid-level vs senior:** at mid-level, a sorted set, a sound write path, and the equal-score answer are enough. At senior the interviewer looks for: which is the source of truth, idempotency, the reset's boundary, and the nerve to say "no sharding for now" with numbers.
- **"Do it without Redis":** a common push, to see whether you understand the data structure or only know its name. The answer: rank means "how many are above me", and which structure gives that fast (subtree sizes in a balanced tree, or a histogram for a small domain).

**In real production:** the most common incidents with game leaderboards aren't technical, they're about fairness: cleaning up the top of the list after a wave of cheating (removing suspicious players from the list but keeping the record, so they can be restored on appeal), and players' complaints about time zones or late-arriving results at the reset. Both have their medicine in this design: a separate source of truth, and a written rule at the boundary.

---

## 3. Key Takeaway

- **The goal of a mock is an honest recording:** out loud, against the clock, follow-ups at their minute; and every score with `mm:ss` evidence
- **"What is shown" first, the tool after:** the top 100, my rank, my neighbours — each of the three questions is one O(log N) sorted set command, and that's the reason to choose a sorted set
- **The numbers say sharding isn't needed:** at 100 million players, ~10 GB and ~90,000 ops/s — one primary and replicas. Writing on "leaderboards at scale" starts with sharding; your math doesn't
- **Redis is derived, the truth lives elsewhere:** rebuilt in minutes from the log and `weekly_totals`; `ZADD GT` on writes makes retries safe, not `ZINCRBY`
- **The edges of correctness are the deep dives:** scores only from the game server, dedupe by `match_id`, the order of equal scores in a composite score, a key per week and the week decided by the match's end time, a grace window before the prizes
- **The same question, the opposite answer:** for a friends' leaderboard fan-out on read wins (850,000 writes/s saved), for a news feed (11.4) mostly on write — because in both, it depends on which side costs more
- **A small domain means a histogram:** at most ~200,000 possible scores (an array of ~1.6 MB) gives a billion players' ranks from a small array; the sorted set only for the top end

---

## 4. New Terms (Glossary)

| Term                           | Meaning                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sorted Set**                 | Redis's set kept sorted by score (skip list + hash table): add/change and rank are both O(log N), a range O(log N + k) — each of a leaderboard's three questions is one command                     |
| **Server-Authoritative Score** | The score comes only from our server that ran the match, signed; the client never sends its own score — the biggest path to cheating closed, the rest left to limits and async investigation        |
| **Composite Score**            | Several rules packed into one number (e.g. `points × 2²⁰ + remaining time`) so one plain sort also respects the order of equal scores; work out the parts so they don't overflow into each other    |
| **Time-Bucketed Key**          | A separate key for each window of time (`lb:2026-W41`) — a reset means writing to a new key, deleting nothing; an event goes to the key of when it happened, not when it arrived                    |
| **Rank Histogram**             | A count of how many have each score value; rank = the sum of all cells above — with a small score domain, tens of millions of players' exact ranks from a small array, approximate with a large one |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. A new mode in the same game: "speedrun" — finishing a level in the shortest time, the time in milliseconds, and each player's **best** time on the leaderboard. (a) Which parts of this lesson's design change (the score's direction, `GT`, composite)? (b) Does the rank histogram still work? Why or why not, and if not, what would you do?

2. The interviewer said: "Do it without Redis, with Postgres alone." (a) Why is the cost of `SELECT COUNT(*) FROM weekly_totals WHERE week = $1 AND points > $2` bad for a player near the bottom, even with an index (5.4)? (b) Give two ways to make "my rank" fast while staying in Postgres, each with its price.

3. A candidate's answer to follow-up 6: _"At ten times I'll use Redis Cluster, it splits the data itself, so nothing needs to change."_ (a) What would you give this on technical depth, 1-4, and why? (b) Which assumption in this answer is wrong? (Hint: a sorted set is one key.) (c) How could one sentence turn this into a 3 or 4 answer?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) **Direction:** less time is better, so either store the score reversed (`ZRANK`, from small to large), or store `−time`; both work, just pick one rule and write it down. **`LT` instead of `GT`:** "the best" means change it only when the new time is **less** (`ZADD ... LT` in Redis), and this is idempotent too, because the same time arriving twice changes nothing. **Not a total, a maximum/minimum:** `best_times` instead of `weekly_totals`, and the update rule `LEAST(old, new)`; the same result arriving twice is now safe by itself (min is idempotent), though keep the `match_id` dedupe for the audit. **Composite:** equal times in milliseconds are rare but possible; the reached-first rule uses the same trick, but now the time part's direction is reversed (a smaller score is better, so reaching it earlier means adding something smaller), and the range has to be recalculated to stay below 2⁵³.

(b) The domain is now large: time in milliseconds, say from 10 seconds to 10 minutes, means hundreds of thousands of possible values, most cells empty. An exact histogram's array gets bigger (a few hundred thousand integers — still small in memory, so not a big problem), but there's another problem: time is a continuous value, so "equal scores" barely exist, and a histogram cell means one specific millisecond. The practical answer: buckets (say of 10 ms), exact ranks in a sorted set for the top end (the prizes, the top 1,000), and below that an approximate rank from the buckets or "top X%". And saying out loud that ranks lower down are now approximate, and why that's fine (nobody looks for the difference between #3,412,098 and #3,412,310).

**Question 2:**

(a) Even with a B-tree index on `(week, points)`, `COUNT(*) WHERE points > $2` has to walk and count every entry in that part of the index, because an ordinary B-tree node doesn't keep how many entries lie beneath it (5.4). The cost is O(rank): fast for someone in the top 100, but for someone in the middle of 100 million, 50 million entries, every time, thousands of times a second. Plus an index update after every match.

(b) (1) **Periodically computed ranks:** a job computes everyone's rank every minute and writes it to a table (`ROW_NUMBER() OVER (ORDER BY points DESC, reached_at)`), and "my rank" is a primary key lookup. The price: ranks a minute stale, and every minute a heavy sort and write of 100 million rows. (2) **A histogram table:** `score_counts(week, points, count)`, on every update −1 in the old score's cell and +1 in the new one, in the same transaction; rank = `SUM(count) WHERE points > mine` — only the rows for scores with at least one player, from a few thousand up to at most ~200,000, fast. The price: two extra writes per update, and popular scores' cells are hot rows (5.5's lock queue; like 11.7's hot account) — they may need splitting (11.2's key splitting). And the order within equal scores isn't here.

**Question 3:**

(a) **1, at most 2.** There's a tool's name, no number, no mechanism, and "nothing needs to change" is an unchecked claim (12.1's mistakes 4 and 9).

(b) Redis Cluster splits data by **key**: each key is in one hash slot, and a slot is on one node. A sorted set is one key, so `lb:2026-W41`'s entire 1 billion members — ~100 GB and all the writes and reads — sit on one node. The cluster splits nothing here. To split, you have to split the key itself (`lb:2026-W41:shard-07`), and then you write the rank's scatter-gather and the top 100's merge yourself.

(c) _"Redis Cluster splits by key, and a leaderboard is one key, so I'll break the key into 20 parts by user; my rank is the sum of `ZCOUNT` across the 20 shards, the top 100 is a merge of 20 lists, with a 1-second cache."_ — a mechanism, a number, and the wrong assumption caught by the candidate themselves.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise** (a mock interview; no code. The deliverable is the recording, the rubric score, the mistakes checklist, and your own written feedback)

> **Task:**
>
> 1. **Do the mock,** by 1.1's rules, 45 minutes, out loud, with a recording. Before reading 1.4 or 1.5.
> 2. **Score it,** listening to the recording the next day: 1-4 on the five dimensions, an `mm:ss` next to each; the ten mistakes checklist, yes/no and `mm:ss` for each.
> 3. **The clock:** how many minutes each step actually took, next to the time box. Which follow-ups' subjects had you already raised yourself? Write them down separately.
> 4. **Write the feedback,** by 1.6's rule, in the third person: three strengths, three improvements, one decision.
> 5. **Compare with the model answer:** where is your design different? For each difference: is it a different but reasonable path (then write the reason), or a gap?
> 6. **The weakest deep dive again:** the follow-up where you did worst, only that one again, 5 minutes, with a recording. The difference between the old and new answer in one line.
>
> **If you can find a friend:** give your friend 1.2 and 1.3 of this lesson, and they'll be the interviewer: answer your questions from the table, ask the follow-ups at their minute, and now and then say "why?". It's far closer than doing it alone, because silence in front of a person is much more uncomfortable — and in reality it's the same.

Send the full score, the checklist, the clock and the feedback. I'll check whether your scores match the evidence (when scoring themselves people are usually soft on communication and hard on depth, or the reverse), and which two things to change before 12.4.

**Honest notes:** the interviewer's answer table, the follow-ups' order and minutes, and the rubric's anchors are my own, made for this question; in a real interview questions and follow-ups vary by interviewer. The model answer's numbers are estimates done in your head as in an interview, not measured: ~100 bytes per entry in Redis and a planned ~50,000 ops/s per node are assumptions (the same assumption as 11.2), and the rebuild's "a few minutes" is unverified. `ZADD GT/LT` and `ZMSCORE` exist from Redis 6.2; older versions need a Lua script. What's said about hiring decisions is general observation, not any company's rule.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 11 (complete, with exit challenges), 12.1, 12.2
Current: 12.3 — Mock Interview #1 (game leaderboard)
TaskFlow state: as at the end of Module 10 (on the side today).
Mock #1 — a weekly global leaderboard: 50 million DAU, 100 million players a week; peak ~17,000 score writes/s, ~35,000
views/s (~70,000 read ops/s); Redis sorted set ~10 GB → one primary + 2-3 replicas, no sharding. Source of truth: log +
Postgres (dedupe by match_id in match_results, weekly_totals, written in batches); `ZADD GT` into Redis (not ZINCRBY).
Scores only from the game server, signed. Equal scores: composite (points × 2²⁰ + remaining time). Reset: a key per week,
the week decided by the match's end time, a grace window before prizes. Friends: fan-out on read (ZMSCORE) — 850,000/s
if on write. At 10×, shard by user + ZCOUNT scatter-gather (hot partitions by score range); the score domain is small
(at most ~200,000 integers) so a rank histogram. If Redis is lost, rebuild from weekly_totals, degraded mode.
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram
Weak spots: [where you got stuck — write it yourself; the two lowest dimensions in the mock's score and the checklist's mistakes]
Next: 12.4 — Mock interview #2 (harder, with follow-ups)
=======================
```

---

## 8. Next Step

Today's thread: **in an interview the right answer isn't enough; why it's right, at which number, and where it breaks — all three have to make it onto the board.** Almost everyone says sorted set. The difference comes after that: from 10 GB and 90,000 ops/s, "no sharding", not making Redis the source of truth, `ZADD GT` instead of `ZINCRBY`, and seeing the small domain and reaching for a histogram.

When you are ready, write `next` — **Lesson 12.4: Mock interview #2.** The same structure, but harder: 60 minutes, a bigger system (file sync across several devices, like Dropbox), and this time the interviewer will change the requirements midway. One follow-up will prove one of your earlier decisions wrong, and the test is whether you can accept that and change the design, without starting over. Bring the two lowest dimensions from today's score with you: at the end of 12.4 we'll see whether they moved.
