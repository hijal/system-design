# Lesson 10.2 - Bloom Filter, HyperLogLog: Probabilistic Data Structures

**Module 10 - Reliability, Security & Operations**

> **Spaced Repetition (Lesson 5.3):** Why does reading one key in an LSM-tree sometimes require opening several SSTables, when in a B-tree you just walk down one tree? And in 5.3 I mentioned a small structure and said "we'll look at this later" - what is it, and which question can it answer with certainty? Today that debt gets paid.

**Prerequisite:** Lesson 4.6 (Cache penetration, negative caching), Lesson 5.3 (LSM-tree, SSTable), Lesson 7.5 (Outbox, events), Lesson 7.6 (OLTP versus OLAP, approximate answers), Lesson 9.5 (Rate limiting), Lesson 10.1 (Hashing, hot keys, membership)

**By the end of this lesson you will be able to:**

1. Explain how a Bloom filter says "definitely not here", and calculate how many bits and how many hashes it needs - and say in which situations its "never a false negative" promise is broken by the **system**, even though the algorithm never breaks it
2. Explain how HyperLogLog counts tens of millions of people in 12 KB, and use its real strength - merging - to get a week's number from daily numbers; and say with numbers where it **must not be used** (intersections, billing)
3. Ask the first question in front of any probabilistic structure - **which direction is the error in, and can this place tolerate an error in that direction** - and from that answer choose between a Bloom filter, HyperLogLog or a Count-Min Sketch

**Tier:** 1 - Runnable Code (Bloom filter, HyperLogLog and Count-Min Sketch written by hand, counted in a deterministic simulation; plus memory measured on a real Redis 8 - Docker for that last part)

---

## 0. Where TaskFlow Is Right Now

After 10.1, TaskFlow's cache sits on a ring, nodes are added slowly, and the dashboard has three new numbers. Last month the product team shipped a feature everyone is pleased with: **Share board** - a read-only public link for any board, like `taskflow.app/s/Xk3m9QaZ`. The slug is 8 characters, random, from a 62-character alphabet - 62⁸ ≈ 218 trillion possible slugs, practically impossible to guess. 200,000 links were created in a month.

**Tuesday, 2 p.m.** Postgres CPU has been climbing slowly for an hour - from 35% to 70%. No spike, no TTL rhythm, just steady. The on-call engineer remembered 4.6's table: steady load while the cache hit ratio is normal - the signature of **penetration**. The log had the answer: `GET /s/*` → 404, ~1,000 per second, from almost 40,000 distinct IPs. Someone is guessing random slugs to find public boards - boards hold companies' roadmaps, so they have a market value. Each IP sends one or two requests a minute, so in the eyes of 9.5's per-IP rate limiter, nobody is guilty.

Every guess is a cache miss (the thing does not exist), then one DB query, and the answer "not found" - which is not written to the cache. The engineer put 4.6's remedy in place: **negative caching**, 30 seconds. Ten minutes after the deploy, the DB's queries/s had **risen further**, and real users were taking longer than before to open boards.

That same week something else happened, apparently unrelated. The growth dashboard showed "Weekly Active Users: **1.4 million**" - three times the previous month. A celebration in Slack. On Thursday a data engineer noticed the number was actually the **sum** of seven days' daily active users. And counting it "properly" with `COUNT(DISTINCT user_id)` on the analytics replica (7.6) takes minutes.

Both incidents come down to the same kind of question - "is this here?" and "how many distinct ones?" - whose exact answer requires **remembering everything**. Today's lesson is about the things that do not remember everything, and in exchange make a small, measured and - most importantly - **one-directional** error.

---

## 1. Theory

### 1.1 The price of an exact answer, and the direction of the error

First, a measured number. The exercise's `npm run redis` - one million distinct user IDs on a real Redis 8, stored three ways:

```
structure                    MEMORY USAGE                  what it can tell
SET (SADD)                       35.55 MB        exactly 1,000,000, and who
HyperLogLog (PFADD)               14.0 KB    ~999,674 (-0.03% off), not who
Bloom (BF.RESERVE 0.01)           1.31 MB  "is it there?" - 0.51% wrong "yes"
```

A `SET` answers every question exactly - how many, who, whether so-and-so is there - because it **remembers everyone**. Its price is 35.55 MB. The other two do not remember: HyperLogLog, in a mere 14 KB (about **1/2,600**), only says "how many"; a Bloom filter, in 1.31 MB (1/27), only says "is so-and-so here". Both are wrong now and then.

**Probabilistic Data Structure** - a data structure that answers one specific question **approximately**, in far less memory, without remembering all the data; the amount of its error can be calculated in advance, and the error usually goes in **one specific direction**.

That last part is the key to the whole lesson. Three questions, three structures, and each one's direction of error:

| Question                                    | Structure        | Direction of error                                                                  |
| ------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| "Is this here?" (membership)                | Bloom filter     | "Not here" is **certain**; "here" is **maybe** - errors only in the "yes" direction |
| "How many distinct?" (cardinality)          | HyperLogLog      | Both directions, but small and known in advance (~0.81%)                            |
| "How many times did this come?" (frequency) | Count-Min Sketch | Never undercounts, only **over**                                                    |

Before installing a probabilistic structure, the question is never "what % is wrong?". The question is: **in this place, which direction of error is harmless, and which is damaging?** A Bloom filter can stand in front of a DB because its error ("here", when actually not) means only one extra DB query - harmless. The opposite error ("not here", when actually it is) would mean a 404 on a user's real link - and a Bloom filter never makes it. At least, the algorithm never does (1.6).

### 1.2 Bloom Filter - a few bits, a few hashes

**Bloom Filter** - an array of `m` bits (all 0 to start) and `k` hash functions; to **add** an item, set to 1 the `k` bits its `k` hashes point to, and to **look up**, check those `k` bits - if even one is 0 the item has definitely never been added, and if all are 1, "maybe here".

```
m = 16 bits, k = 3

start                     0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
                          0 1 2 3 4 5 6 7 8 9 ...       15

add("Xk3m9QaZ")  → 2, 7, 13
                          0 0 1 0 0 0 0 1 0 0 0 0 0 1 0 0
add("Pq9zLm2B")  → 5, 7, 11
                          0 0 1 0 0 1 0 1 0 0 0 1 0 1 0 0

has("Ab12Cd34")  → 2, 9, 13     bit 9 = 0   →  "definitely not here"  ✓
has("Zz77Yy66")  → 5, 11, 13    all 1       →  "maybe here"
                                               nobody ever added it - still.  ← false positive
```

Two things follow directly from this picture:

- **Why there are no false negatives:** bits only go from 0 to 1, never from 1 to 0. Once an item is added, its `k` bits stay 1 forever - so looking it up always says "maybe here". (Unless someone clears bits - 1.4.)
- **Why there are false positives:** other items' bits can coincidentally add up to setting all `k` bits of a new item. The fuller the filter, the higher the chance.

**False Positive Rate (FPR)** - the probability that the filter says "maybe here" about an item that was never added; a Bloom filter's only error, and the main yardstick for sizing it.

You do not need `k` separate hash functions. The exercise builds the rest from two hashes (`h1`, `h2`) - position number `i` = `(h1 + i × h2) mod m`. This is a well-known technique (double hashing), and the measured FPR matches theory (you will see below), so there is no harm in it.

And notice what is **missing**: the item itself is never stored anywhere in the filter. Whether it is an 8-character slug or a 200-character URL - each costs the same few bits. That is where the memory saving comes from, and it is why a filter can never say "what is here" - only "is this here".

### 1.3 How many bits, how many hashes - in numbers

`npm run bloom`, part A - insert one million names, then look up one million names that were **never** inserted:

```
bits/name       k      measured FP rate    theory      memory
4               3               14.680%   14.689%      488 KB
6               4                5.593%    5.606%      732 KB
8               6                2.163%    2.158%      977 KB
10              7                0.832%    0.819%    1,221 KB
12              8                0.313%    0.314%    1,465 KB
16             11                0.047%    0.046%    1,953 KB
20             14                0.006%    0.007%    2,441 KB
   inserted names called "absent" (false negatives), out of 1,000,000: 0
   1.0% needs 9.59 bits/name; 0.1% needs 14.38
```

Three things to read:

1. **The measured numbers match theory almost exactly.** The theoretical formula is `(1 − e^(−kn/m))^k` - `n` items, `m` bits, `k` hashes. This means you can **calculate and choose** the FPR in advance, rather than guess.
2. **1% needs ~9.6 bits per item - however large the item is.** And cutting the FPR tenfold costs only ~4.8 more bits per item (9.59 → 14.38). The rule of thumb: **bits/item ≈ 1.44 × log₂(1/FPR)**. A million items at 1% is ~1.2 MB - and in 10.1's terms, small enough to keep in every app instance's memory.
3. **Zero false negatives** - not one in a million.

How many hashes? More hashes means checking more bits per lookup (good), but setting more bits per insert (the filter fills faster, bad). Part B - fixed at 10 bits/name, varying `k`:

```
k          measured FP rate    theory   % of bits set
1                    9.483%    9.516%            9.5%
3                    1.761%    1.741%           25.9%
5                    0.937%    0.943%           39.3%
7                    0.832%    0.819%           50.3%
10                   1.032%    1.019%           63.2%
16                   2.699%    2.710%           79.8%
```

The best `k` is `(m/n) × ln 2` ≈ 10 × 0.69 ≈ 7 - and look at the last column: exactly there, **half the filter's bits are 1**. This is no coincidence: the best Bloom filter is one whose bits are half 0 and half 1 - it carries the most information. The curve is flat, though: anything from 5 to 8 is almost equally good.

The same calculation on real Redis (`BF.RESERVE key 0.01 1000000`) took 1.31 MB, with a measured FPR of 0.51% - better than the requested 1%, and a little larger than the formula's 1.17 MB. Redis's internal sizing details were not examined here; the practical point is that it stays below the FPR you asked for.

### 1.4 When the filter fills up, and when you want to delete something

A Bloom filter's size has to be fixed **in advance** - `m` and `k` are chosen for a particular `n`. What happens if you insert more? Part C - a filter built for one million at 1%:

```
inserted        of capacity      measured FP rate   % of bits set
500,000                0.5x                 0.03%           30.6%
1,000,000                1x                 0.99%           51.8%
1,500,000              1.5x                 5.77%           66.6%
2,000,000                2x                15.76%           76.8%
3,000,000                3x                43.70%           88.8%
5,000,000                5x                83.19%           97.4%
```

At twice the capacity the FPR is 16 times higher; at five times, the filter says "maybe here" to almost everything - meaning it no longer filters anything out. And no error appears, no alert; the filter just becomes silently useless. So **the number of items in the filter, as a ratio of its capacity, is a metric** - and capacity is not today's number, it is sized for growth.

Redis's `BF` has its own answer. `npm run redis`, part C - 750,000 inserted into a filter built for 250,000:

```
filter             MEMORY USAGE  inner filters      measured FP rate    inserted → "no"
default                 1.07 MB              2                 0.74%                  0
NONSCALING             292.6 KB              1                 1.00%            494,508
   NONSCALING: BF.MADD's reply says "non scaling filter is full" - 499,558 names not inserted, and no exception
```

- When a **default** filter fills up, Redis adds a new, larger filter alongside it (2 here), and checks all of them on lookup. The FPR stays bounded (0.74%) and memory grows. This is called a scalable Bloom filter - it saves you even if you misjudged capacity, at the price of checking several filters on every lookup.
- A **`NONSCALING`** filter keeps memory bounded, and when full it **accepts no new items**. Look at the last column: **494,508 names the app believes it "inserted" - and the filter says "not here".** These are false negatives - the Bloom error that "never happens" - and the cause is not the algorithm but an error nobody read. `BF.MADD`'s reply is an array, and the "full" error arrives as an element inside that array, not as an exception (measured in the exercise with ioredis). If the code only checks "did the call succeed", it will never know.

Now deletion. A user deleted their account, and their username is free again. Can you take it out of the filter? Part D - delete 100,000 of one million names:

```
approach                            memory        kept → "no"    deleted → "yes"   new false positive
don't delete, keep them           1,170 KB                  0             100.0%                0.99%
plain bloom, clear bits           1,170 KB            360,187               0.0%                0.36%
counting bloom (4-bit)            4,680 KB                  0               0.6%                0.60%
```

- **Clearing bits in a plain Bloom filter is a disaster.** One bit is shared by many items; clearing the bits of 100,000 names turned **360,187 remaining names** into "not here" too - 40% of the 900,000. No structure at all is better than a structure whose safety promise is broken.
- **Don't delete, leave it** - deleted names stay "maybe here" (100%). That means one extra DB check for them, then the right answer. So deleted items only create **false positives** - the harmless direction of error. Over time they accumulate and fill the filter, so it has to be rebuilt from the DB now and then.
- **Counting Bloom Filter** - a small counter (usually 4 bits) in place of each bit; adding increments, deleting decrements, and a lookup treats "not 0" as set - deletion is possible, at the price of roughly 4 times the memory.

  4,680 KB here, zero false negatives. (A counter that reaches 15 gets stuck and can no longer be decremented - none reached it in this run.)

One more name worth knowing, because you will see it next to these in Redis: the **Cuckoo filter** (`CF.*`) - it supports deletion (Redis 8 has `CF.DEL`, verified), and by the measurements in the paper that introduced it, it takes less space than a Bloom filter at low FPRs (roughly below 3%); in exchange, inserts can fail as it fills up. Its numbers were not measured here.

### 1.5 TaskFlow's penetration - in numbers

Now let us measure Tuesday's incident. `npm run penetration`, part A - 200,000 share links, 5,000 requests/s of which 20% are bots' random guesses, real users' traffic Zipf-distributed (some boards very popular), room for 50,000 entries in the cache:

```
approach                    DB query/s  of which "none"   real user hits    negative entries     evict
cache only                       2,074            48.4%            73.2%                   0   164,145
+ negative cache 30 s            2,320            43.2%            67.0%              18,647   414,036
+ bloom filter 1%                1,081             0.9%            73.2%                   0   164,145
   filter: 234 KB, k = 7 - built once, in every app instance's memory
```

**The first row:** almost half the DB's work (48.4%) is looking up links that do not exist. Every one of the bots' 1,000 requests/s goes all the way to the DB.

**The second row - the negative cache increased the load.** Why? Because every bot slug arrives **only once**. A "not found" entry is kept in the cache for the next time the same question is asked - but the next time never comes. Meanwhile each entry occupies cache space for 30 seconds: at the end, **18,647** of the 50,000 entries were garbage. Real boards were evicted to make that room (164,145 → 414,036), real users' hit rate dropped from 73.2% to 67.0%, and their misses went to the DB. The net result: not one bot query was saved, and real users' queries rose.

Shorter TTLs? In the exercise `NEGATIVE_TTL=5` → 2,129 queries/s, `NEGATIVE_TTL=1` → 2,084 - the damage shrinks, but it **never** drops below "cache only"'s 2,074. It cannot, because on this traffic a negative entry's hit rate is zero.

This does not contradict 4.6 - it is a subtlety of diagnosis. 4.6's penetration was the **same** missing key over and over (a buggy client polling a deleted task) - there, the negative cache saves every subsequent request. Today's penetration is a **new** missing key every time - there, the negative cache has nothing to save. So the question is not just "is the DB busy with missing keys?" but **"do the missing keys repeat?"** Look in the log at the ratio of distinct slugs among the `GET /s/*` 404s and you have the answer - and amusingly, the cheap tool for computing that ratio is also in today's lesson (1.8).

**The third row - Bloom filter:** DB queries/s halved (1,081), and of those only 0.9% are "missing" - ~1% (the FPR) of the bots' 1,000 requests/s slip through, and the other 99% never reach the DB. Nothing changed for real users (73.2%), because all their links are in the filter. The price: 234 KB, built once.

There is a real decision about where the filter lives:

- **In each app instance's own memory** - a lookup is a function call (a few hashes, a few bits), no network. But each instance has its own copy - and when a new link is created, everyone has to be told (1.6).
- **One key in Redis** (`BF.EXISTS`) - a single copy, everyone sees the same truth. But one network round trip per share link request, and worse, in 10.1's terms: **all** share link traffic on one key, meaning one Redis node - by definition the hottest hot key there is.

And one more point: the filter protects the DB, but it does not stop the bots. 1,000 requests/s are still reaching the app. 9.5's rate limiting needs a new dimension - not per IP, but by **404 rate** (how many missing slugs per minute from a subnet or ASN), because that is the signature of enumeration.

### 1.6 Bloom's real trap - what the filter does not know

A Bloom filter's core promise: if it says "not here", it definitely is not. But the promise has a hidden condition - **every item that exists has been added to the filter.** Share links are being created every second. If the filter is built from the DB once at startup, it does not know about new links. `npm run penetration`, part B - 20 new links per second, and 5% of requests go to freshly created links (people create a link and send it straight away, and colleagues open it within minutes):

```
filter upkeep                      404 on a real link    of new-link requests
built once at startup                          49,773                   99.7%
rebuilt from the DB every 60 s                   24,766                   49.6%
add to the filter on create                         0                    0.0%
```

**99.7% of requests for new links got a 404.** In the user's eyes: "I shared the board and nobody on my team can open it." This is the worst kind of bug - the feature is broken **at exactly its key moment**, and the person seeing it assumes the link itself is wrong.

Rebuilding every minute gets you half (49.6%) - because a new link is opened most right after it is created, and that is exactly when it is not in the filter. In the exercise, `REBUILD=10` gives 12.8% - better, but reading the whole DB every 10 seconds, and still not zero. The only zero row: **adding to the filter on the creation path.**

This is exactly the shape of 10.1's membership problem: the algorithm is perfect, but whether every part of the system sees the same truth is not the algorithm's responsibility. With several instances, "on creation" means:

- An **outbox event** (7.5) in the link-creation transaction - `share_link.created` - which every instance listens for and adds to its own filter (fanned out via Redis pub/sub or a stream, 7.2). Why outbox and not a direct publish? Because of 7.5's dual write: if the DB commits but the publish fails, the filter never learns - and that direction of error is the damaging one.
- An event takes from a few milliseconds to a few seconds to arrive. A small net for that gap: when the filter says "not here", check a small "created in the last 5 minutes" set in Redis before returning a 404. Every bot request costs one cheap Redis lookup, not a DB query.
- A periodic full rebuild as a **safety net** (say hourly) - if any event is lost, it does not last more than an hour. Revoked links (which we do not delete, 1.4) also drop out this way.
- **Fail open:** if the filter has not loaded, or its age is past a limit, skip the filter and go straight to the DB. The filter is an optimization; without it the system becomes slower, not wrong.

That last point is worth remembering as a general rule, and it also answers the question left at the end of 10.1: **"Has this username been taken?"** If the filter says "definitely not" in the signup form, you can show a green tick immediately - without touching the DB. If it says "maybe", check the DB. But when the account is created, the decision is made by the DB's `UNIQUE` constraint, not the filter - because two people can choose the same name at the same moment, and the filter will tell both it is "free". **A filter is never the source of truth; it only saves the cost of going to the source of truth.**

### 1.7 Where else Bloom filters sit

Even if you never write a Bloom filter yourself, you use them every day:

- **In every SSTable of an LSM-tree** (5.3's debt) - reading one key may require checking the memtable and several SSTables; each SSTable carries a Bloom filter, and when it says "definitely not here", that file's disk read is skipped. Cassandra has a per-table setting called `bloom_filter_fp_chance` - lower means more memory, fewer disk reads. That is this lesson's entire trade-off, in one line of config.
- **Web crawlers** - "have I seen this URL before?" among billions of URLs. A false positive means a new page gets skipped (the crawler assumes it has seen it) - a tolerable error for a crawler, but notice that here the error goes in the **"not visited"** direction. The direction can flip depending on the use.
- **A CDN's "one-hit wonders"** - according to published writing, Akamai used a Bloom filter to decide whether to cache an object: the first time it is requested, only its name is written to the filter; only on the second request does it go into the cache. Because many objects are requested only once in their lifetime, and caching them wastes space - exactly the flip side of 1.5's negative cache problem. (Not verified here.)

### 1.8 HyperLogLog - counting without remembering each one

Now the second incident: "how many distinct users this week?"

**Cardinality** - the number of **distinct** items in a collection; the same user arriving ten times counts once.

To count exactly you have to remember everyone - otherwise, when someone arrives, how would you know they are new? At a million users a Redis `SET` is 35.55 MB. One set per day for each of TaskFlow's 200,000 workspaces? Out of the question. And daily numbers cannot be added - the same person gets counted on both Monday and Tuesday (we measure this in 1.10).

The idea behind HyperLogLog comes from a coin-tossing game. Someone tells you: "I tossed a coin many times, and once I got 10 tails in a row." Roughly how many times did they toss? The chance of 10 tails in a row is 1/1,024 - so probably around a thousand times. They did not remember a single number, only **the longest run**.

The same with hashes: the hash of each user ID is a random string of bits. Look at how many 0s it starts with. Half of hashes start with 1, a quarter with `01`, an eighth with `001`… seeing 20 leading 0s typically takes ~a million distinct hashes. So remembering just the largest number of leading 0s gives you the approximate cardinality. And if the same user comes again? Same hash, same number of 0s - nothing changes. **Duplicates drop out by themselves, without remembering anyone.**

A single "maximum" is very uncertain - one lucky hash doubles the whole estimate. So the first few bits of the hash send each user to one of many buckets (registers), each register keeps its own "maximum", and at the end you take an average across all of them:

```
p = 14  →  2^14 = 16,384 registers, 6 bits each  →  12,288 bytes

user:42  →  hash = 00000101101101 | 0001 0110 1011 …
                   └─ first 14 bits ─┘ └─ where is the first 1 in the rest? ─┘
                   register #365       in position 4  →  rank = 4

register[365] = max(register[365], 4)

estimate = α · m² / Σ 2^(−register[j])        (m = 16,384; harmonic mean - suppresses large outliers)
```

**HyperLogLog (HLL)** - an algorithm that sends each item to one of `2^p` registers using the first `p` bits of its hash, keeps in each register the longest run of leading 0s seen in the remaining bits, and estimates cardinality from the harmonic mean of all of them; memory is fixed (`2^p` × 6 bits), and the error is ~`1.04/√(2^p)`.

### 1.9 HyperLogLog's numbers

`npm run hll`, part A - one HLL (p = 14, 12,288 bytes), fed from 10 to 10 million distinct users (one in three of them twice, to test duplicates):

```
real users              estimate    error  no correction        error  exact needs ≥
10                        10    +0.03%            11,822  +118117.81%           80 B
100                      100    +0.31%            11,864   +11764.38%          800 B
1,000                  1,002    +0.20%            12,304    +1130.41%           8 KB
10,000                 9,987    -0.13%            17,321      +73.21%          78 KB
30,000                29,940    -0.20%            32,201       +7.34%         234 KB
50,000                50,041    +0.08%            50,041       +0.08%         391 KB
100,000              101,693    +1.69%           101,693       +1.69%         781 KB
1,000,000            996,033    -0.40%           996,033       -0.40%       7,813 KB
10,000,000         9,932,247    -0.68%         9,932,247       -0.68%      78,125 KB
```

- **From 10 to 10 million in 12 KB, with error under 2% everywhere.** The last column shows the minimum cost of counting exactly - even storing just one 8-byte hash per user is 78 MB at 10 million, and a real `SET` is several times that.
- **The "without correction" column:** the raw formula is completely useless at small numbers - it says 11,822 for 10 people. That is because almost all of the 16,384 registers are empty, and empty registers inject a big error into the formula. So at small numbers, real implementations count another way: **how many registers are still empty** (linear counting) - with 10 people, 10 of the 16,384 are filled, and from that the number is almost exact. At large numbers the two agree. Redis and Google's HLL++ apply a finer bias correction for the region in between; the original 2007 algorithm in the exercise lacks it, which is why +1.69% at 100,000 looks a little large (though still within the expected range).

How many registers? Part B - 100,000 users, 40 different days (40 different sets of users), varying the precision:

```
p       register     memory  theory (1.04/√m)     measured RMS         worst day
4             16       12 B            26.00%           26.54%            69.00%
8            256      192 B             6.50%            6.15%            14.34%
10         1,024      768 B             3.25%            3.57%             8.62%
12         4,096    3,072 B             1.63%            1.67%             5.12%
14        16,384   12,288 B             0.81%            0.78%             2.13%
16        65,536   49,152 B             0.41%            0.50%             1.05%
```

The error falls with the inverse **square root** of the number of registers - just like 10.1's virtual nodes. Halving the error takes four times the memory. And remember the "worst day" column: a typical error of 0.81% does not mean 0.81% every day - on one of the 40 days it was 2.13%. Writing "~470K" on a dashboard is honest; writing "469,026" claims a precision you do not have.

Redis's HLL is fixed at p = 14 (so always ~0.81%), and comes in two forms. `npm run redis`, part B:

```
structure                    MEMORY USAGE      answer
SET (listpack)                      475 B          50
HyperLogLog (sparse)                252 B          50
HyperLogLog, at 5,000             14.0 KB        5025
```

With few users, Redis keeps an HLL in a dense compressed form (sparse) - 252 bytes at 50 people, smaller even than a small `SET`. As it grows (past the default `hll-sparse-max-bytes` of 3,000 bytes) it switches to the full 12 KB form, and then grows no further - a million or a hundred million, 14 KB. For TaskFlow this means: most workspaces are small, so the total cost of keeping one HLL per workspace per day is set by the number of large workspaces.

### 1.10 Merge - HyperLogLog's real magic

Back to Thursday's dashboard. `npm run hll`, part C - 7 days, ~200,000 active users per day, 150,000 of them regulars (who come daily), the rest drawn at random from a large population:

```
approach                              weekly users       error
exact (a Set of every ID)                  472,981      +0.00%
sum of the 7 daily counts                1,415,230    +199.21%
merge 7 HLLs (max per register)            469,026      -0.84%
   each day's HLL is 12,288 bytes; still the same size after merging - even merging 30 days
```

**Summing the daily numbers gives +199%** - the dashboard's "1.4 million". The 150,000 regulars were counted seven times. This error is not HLL's, it is the addition's - even if the daily numbers were **perfectly exact**, the sum would be just as wrong. Cardinalities cannot be added.

HLLs can be merged: take the **max** of each register across the two HLLs. If a user came on both Monday and Tuesday, their hash lands in the same register with the same rank on both days - taking the max keeps it once. In other words, **the merged HLL is exactly the HLL you would have got by inserting the whole week's users together.** The result: −0.84%, in the same 12 KB.

Three practical benefits come from this one property:

- **Any time range, for free.** Keep one HLL per day; a week = merge 7, a month = 30. In Redis, `PFCOUNT key1 key2 … key7` gives the union's estimate by itself, without a separate merge. "Active users in the last 17 days"? 17 keys.
- **Distributed counting.** Each app instance, or each shard, keeps its own HLL; at the end, ship 12 KB each and merge. No need to move tens of millions of user IDs over the network - this is the natural path in 7.6's stream processing.
- **The previous section's diagnosis.** 1.5 asked: "do the 404 slugs repeat?" Per minute, the total number of 404s and the number of distinct slugs in an HLL - if the two are about equal, there is no repetition, and a negative cache is pointless.

(Bloom filters can merge too: a bitwise OR of two filters with the same `m` and `k` = a filter of the union of the two sets. But a bitwise AND for the intersection does not give a correct filter - its FPR is higher. For intersections HLL has an even bigger problem, in the next section.)

### 1.11 What HyperLogLog cannot do

After the success of merging, a product manager's next request: "How many users do two workspaces have in common?" (Two companies are merging.) By inclusion–exclusion: `|A ∩ B| = |A| + |B| − |A ∪ B|`, and all three can be obtained from HLLs. Part D - two workspaces, a million viewers each:

```
real overlap    real in both      with HLL       error
50.0%                500,000       499,187      -0.16%
10.0%                100,000        89,831     -10.17%
1.0%                  10,000        10,618      +6.18%
0.1%                   1,000         4,381    +338.10%
```

With a large overlap it works; with a small one the error is **hundreds of percent**. The reason: HLL's error is proportional to the number being estimated - `|A ∪ B|` is ~2 million, and 0.81% of that ≈ 16,000. All of that 16,000 of uncertainty lands on an answer of 1,000. Subtracting to get a small number keeps the errors of two big numbers, and the small number drowns. **Intersection is not HLL's job** - to find a small overlap, take the exact path (a join in the DB, or a batch job, 7.6).

The other limits follow directly from the design:

- **It does not say "who".** There are no IDs in an HLL. "Email this week's active users" - impossible with an HLL.
- **No delete.** If a user leaves, their register's max cannot be lowered (nobody knows who raised it). That is why an HLL is always kept per **time window** - a new key every day, the old ones dying by TTL.
- **Not for money.** TaskFlow's price is set by "active seats" - how many distinct users in a month. A ±2% error on an invoice means some customer is paying more, and that can be shown with numbers. Here the "direction of error" question returns: HLL's error goes **both ways**, and with money no direction of error is acceptable. Billing takes the exact path - a nightly batch `COUNT(DISTINCT)` on the analytics store (7.6), where taking a few minutes does not matter.

### 1.12 Count-Min Sketch - who is the biggest?

The third question has been hanging since 10.1. The decision there was: "a 2-second local cache in each app instance for hot boards." But **which** boards are hot? Keeping a counter per board means about a hundred thousand entries per instance, renewed every minute.

**Count-Min Sketch (CMS)** - a small table of `d` rows × `w` counters; for each incoming item one counter per row (chosen by that row's hash) is incremented, and to get an item's count you take the **smallest** of its `d` counters; other items sharing a counter can only make the count **go up**, never down.

Why "the smallest": every counter holds your item's true count **plus** the counts of the others sharing that counter. The row with the least sharing is closest to the truth. `npm run heavy` - 2 million requests, ~124,000 distinct boards, Zipf 1.1 (like 10.1's hot key; the hottest board alone is 13.1%):

```
width × depth       memory  top 10 hit     top 10 overcount  cold boards (≤5 times)
64 × 4                1 KB        1/10             ≤ 66.80%          7969.3x actual
256 × 4               4 KB        5/10             ≤ 10.56%          1534.2x actual
1024 × 4             16 KB        7/10              ≤ 2.53%           284.6x actual
4096 × 4             64 KB       10/10              ≤ 0.31%            48.3x actual
16384 × 4           256 KB       10/10              ≤ 0.10%             7.7x actual
```

- **The whole top 10 in 64 KB, with counts off by under 0.31%.** Instead of a `Map` of 124,000 counters.
- **But cold boards' counts are inflated 48 times.** A CMS's overcount is proportional to total traffic (in theory roughly `e/w × total requests`), not to an item's own count. A board opened 5 times gets a few hundred extra counts piled on top. So a CMS is **excellent at finding heavy items and useless at counting light ones**.

The direction of error again: a CMS never undercounts. For hot key detection this means - a truly hot board is never missed; occasionally a medium board is mistaken for hot and put in the local cache. The cost of that error is one unnecessary 2-second local cache entry - harmless. (Redis 8 has both the `CMS.*` and `TOPK.*` command families; the exercise writes its own by hand, and Redis's were not measured.)

### 1.13 Side by side, and TaskFlow's decision

> **Trade-off Table - which question, which structure**

| Structure        | Question             | Direction of error   | Memory at 1M (measured) | Delete                 | Merge                  |
| ---------------- | -------------------- | -------------------- | ----------------------- | ---------------------- | ---------------------- |
| `SET` (exact)    | Everything           | None                 | 35.55 MB (Redis)        | Yes                    | Yes (union)            |
| Bloom filter     | "Is it here?"        | False positives only | 1.31 MB (Redis, 1%)     | No (counting: yes, 4x) | Yes (OR, same m and k) |
| HyperLogLog      | "How many distinct?" | Both ways, ~0.81%    | 14 KB (Redis)           | No                     | Yes (max per register) |
| Count-Min Sketch | "How many times?"    | Only overcounts      | 64 KB (4096 × 4)        | No (in its basic form) | Yes (add counters)     |

**Share links:**

- **A Bloom filter in each app instance's memory**, 1% FPR, capacity twice today's (400,000 links - ~470 KB). Not a shared key in Redis - putting all share link traffic on one key is 10.1's hot key.
- **On the creation path:** an outbox event `share_link.created` in the transaction (7.5), which every instance listens for and adds to its filter. For the gap before the event arrives, a "created in the last 5 minutes" set in Redis; when the filter says "not here", check it before the 404.
- **Safety net:** a new filter from the DB every hour (revoked links drop out too); if the filter is older than 2 hours or failed to load, **fail open** - straight to the DB.
- **No negative cache TTL** for share links (1.5 - on this traffic it does nothing but harm).
- **Metrics:** links in the filter ÷ capacity (alert at 80% - 1.4's silent decay); the rate of not finding a link in the DB after the filter said "here" (the measured FPR - above 1% means the filter is filling up); and **most urgent**: the number of hits in the recent set after the filter said "not here" - above zero means events are arriving late, and if it grows, users are seeing 404s.
- A new rule in 9.5's rate limiting: a 429 for more than 30 missing slugs per minute from one /24 subnet.

**Active users:**

- **One Redis HLL per workspace per day** - `PFADD active:{workspace:42}:2026-09-30 user:7`, TTL 40 days. Small workspaces stay sparse at a few hundred bytes. (10.1's hash tag: a workspace's days sit in one slot, so `PFCOUNT` over seven keys works in one go.)
- A week or a month = `PFCOUNT` over 7 or 30 keys. A separate daily HLL for the whole site.
- On the dashboard the numbers carry a **"~"**, rounded to two significant digits.
- **Billing never from HLL** - an exact `COUNT(DISTINCT)` in the nightly batch (7.6).

**Hot boards:** a Count-Min Sketch in each instance (4096 × 4, 64 KB), renewed every minute, plus a small top-20 list - the boards on that list are the ones that go into 10.1's 2-second local cache.

---

## 2. Interview Angle

Probabilistic data structures rarely come up as a question on their own - they come up inside a bigger design, when the interviewer scales the numbers up and your exact solution no longer fits in memory. Some familiar moments:

- **"Design a web crawler"** → "have I seen this URL before?" - a Bloom filter; and a good answer says that a false positive here means **skipping** a new page, and why that is tolerable.
- **"Design a URL shortener"** → when generating a new short code, "is this one taken?" - a Bloom filter in front of the DB, with the final decision made by a `UNIQUE` constraint.
- **"How many unique visitors / DAU / MAU?"** → HyperLogLog, immediately followed by merging (daily to monthly), and "not for billing".
- **"Trending / top-K / heavy hitters"** → a Count-Min Sketch + a small heap; and why small counts cannot be trusted.
- **"How would you handle cache penetration?"** → a negative cache **and** a Bloom filter, and when to use which - whether the missing keys repeat.

**Follow-ups that are almost certain:**

- _"Can a Bloom filter have false negatives?"_ - not in the algorithm (bits only go 0→1). But **it can in the system** - if an insert never arrives (a stale filter, a lost event, a full `NONSCALING` filter), or if someone clears bits. Being able to say this second part puts you beyond the memorized answer.
- _"Deleting from a Bloom filter?"_ - no; a counting Bloom filter (4 times the memory) or a Cuckoo filter, or - often best of all - don't delete, accept it as a false positive, and rebuild regularly.
- _"HyperLogLog's memory and error?"_ - 12 KB in Redis, ~0.81%; the error is `1.04/√m`, and halving it takes four times the memory.
- _"The intersection of two HLLs?"_ - possible via inclusion–exclusion, but with a small overlap the error is huge, because the error is proportional to the union.

**In real production:** the most common mistakes - building a Bloom filter once at startup and never updating it (false negatives on new items, and only on new items, so tests never catch it); sizing capacity to today's number and then watching the filter silently become useless; adding up daily HLL numbers and calling it a weekly figure; approximate numbers creeping into places where money or contracts are involved; and putting a negative cache in front of random keys, pushing the cache's real data out.

---

## 3. Key Takeaway

- **The first question for a probabilistic data structure is not "what % is wrong" but "which direction is it wrong in"** - and whether an error in that direction is harmless here. Bloom errs only toward "yes", CMS only upward, HLL both ways
- **Bloom filter**: ~9.6 bits per item for 1%, however large the item; +4.8 bits for each tenfold reduction in error - the measured FPR matches theory (0.832% versus 0.819% at 10 bits); 1.31 MB for a million in Redis versus a `SET`'s 35.55 MB
- A filter filled past capacity becomes useless **silently** (15.76% FPR at double); deleting by clearing bits loses items that are still there too (360,187 of 900,000); when Redis's `NONSCALING` fills up, the error arrives inside the reply, not as an exception
- **Bloom's false negatives come from the system, not the algorithm** - with a filter built once at startup, 99.7% of requests for new share links got a 404; with a rebuild every minute, 49.6%; added on the creation path, 0. A filter is never the source of truth - fail open
- **A negative cache against random missing keys does harm** - DB queries/s 2,074 → 2,320, real users' hits 73.2% → 67.0%; with a Bloom filter, 1,081. The diagnostic question: do the missing keys repeat?
- **HyperLogLog**: from 10 to 10 million in 12 KB, error `1.04/√m` (0.81% at p = 14, measured 0.78%); useless at small numbers without linear counting
- **HLL's real strength is merging** - summing the days overstates the week by +199%, taking the max per register gives −0.84%, at the same size; but **with a small intersection the error is hundreds of percent** (+338% at a 0.1% overlap), and never for billing
- **Count-Min Sketch** catches the whole top 10 in 64 KB (overcount ≤ 0.31%), but inflates cold items' counts 48 times - for finding the heavy, not counting the light

---

## 4. New Terms (Glossary)

| Term                             | Meaning                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Probabilistic Data Structure** | A structure that answers one specific question approximately without remembering all the data - far less memory, an error that can be calculated in advance, and usually an error in one specific direction             |
| **Bloom Filter**                 | An array of `m` bits and `k` hashes - adding sets `k` bits to 1, and a lookup says "maybe here" if all are 1 and "definitely not here" if any is 0; no false negatives (provided every insert arrives), no delete       |
| **False Positive Rate (FPR)**    | The probability of saying "maybe here" about something never added; ~`(1 − e^(−kn/m))^k` - ~9.6 bits/item at 1%, and it climbs quickly once filled past capacity                                                        |
| **Counting Bloom Filter**        | Small counters (usually 4 bits) in place of bits - incremented on add, decremented on delete; deletion is possible, at the price of ~4 times the memory                                                                 |
| **Cardinality**                  | The number of distinct items in a collection - the same item arriving repeatedly counts once; counting it exactly requires remembering each one, and adding two counts does not give the union                          |
| **HyperLogLog (HLL)**            | Picks a register with the first `p` bits of the hash, keeps the longest run of 0s in each, and estimates from the harmonic mean - fixed memory (12 KB in Redis), error `1.04/√m`, merged by taking the max per register |
| **Count-Min Sketch (CMS)**       | A table of `d × w` counters - one counter per row is incremented, and the count = the smallest of the `d`; never undercounts, overcounting is proportional to total traffic - for finding heavy hitters                 |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines in your own words for each.

1. TaskFlow's signup will get a Bloom filter for usernames - there are 50 million usernames now. (a) How big will the filter be (in MB) at 1% and at 0.1% FPR? Can it be kept in every app instance? (b) When the filter says "definitely not here" and when it says "maybe here", what does the signup form show, and what happens in the DB? What happens when two people choose the same free name at the same moment? (c) When an account is deleted, the username becomes free again (after 30 days). What will you do about the filter - and if your decision is wrong, exactly what error does the user see?

2. One HLL per day for each of TaskFlow's 200,000 workspaces (1.13). (a) If they were all dense (12 KB), how much memory in total over 40 days? Why will it really be less, and what would you need to know to calculate the real number? (b) Product now wants "retention": what % of last week's active users are also active this week. Can two weekly HLLs do this? Think separately about a large workspace (50,000 people a week, 60% retention) and a small one (200 people a week). (c) The sales team says, "Since HLL's error is only 0.81%, let's take active seats for the invoice straight from HLL - then we can switch off the nightly batch job." What do you reply?

3. Instead of 1.13's decision, a teammate proposed a "simpler" design: one key in Redis, `BF.RESERVE share:links 0.01 200000 NONSCALING` ("memory will never grow"), a `BF.ADD` in the link-creation handler (after the DB commit), and on every `GET /s/:slug`, first `BF.EXISTS` - "not here" means 404. Find three separate problems - when each will show up, what the user will see, and which number from the exercise or the lesson demonstrates it. Finally, say which part of this design is actually right.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) Formula: bits/item ≈ 1.44 × log₂(1/FPR). 9.59 bits at 1%, 14.38 bits at 0.1% (the last line of the exercise's part A).

- 1%: 50 million × 9.59 ≈ 480 million bits ≈ **~60 MB**
- 0.1%: 50 million × 14.38 ≈ 720 million bits ≈ **~90 MB**

60–90 MB per instance is possible, but not cheap - and building it from 50 million names at startup takes time (on every deploy, on every new instance). Growth has to be accounted for too (1.4): build it for today's 50 million and the FPR at 100 million is ~16%. Here a shared Redis `BF` is reasonable - signup traffic is nowhere near as hot as share links (a few per second, not thousands), so there is no hot key problem; one copy is easier to build and update. 1.13's decision flips here, and the reason is the shape of the traffic - not the algorithm.

(b) "Definitely not here" → a green tick immediately, without touching the DB. "Maybe here" → one `SELECT` in the DB; if it is there, red, if not, green (that was a false positive - ~1% of the time). But **the form's tick is a suggestion, not a decision.** The `UNIQUE` constraint on the account-creation `INSERT` is the real judge. Two people, the same free name, at the same moment: the filter told both "not here" (nobody had been added yet), both saw green, both submitted - one `INSERT` succeeds, the other hits a unique violation; show that person "this name was just taken". The filter's only job is to save the DB check in most cases; the truth is in the DB.

(c) After a delete, a name cannot be removed from a plain Bloom filter. Two paths, with errors in different directions:

- **Do nothing** - the freed name stays "maybe here" in the filter → DB check → not there → green. So just one extra DB query - **an error in the harmless direction**. Deleted names pile up over time and raise the FPR, so rebuild the filter from the DB regularly (say once a month). This is the right answer.
- **Clear the bits** - the exercise's part D: deleting 100,000 made 360,187 remaining names "not here". In the user's eyes: the signup form showed a **taken** name as green, the user filled everything in and submitted, and the `INSERT` failed - "this name is taken". The promise is broken; and because the form itself said the wrong thing, the user's trust breaks. (A counting Bloom filter solves this, at 4 times the memory - 240 MB instead of 60 MB. That is expensive for so few deletions.)

**Question 2:**

(a) If all were dense: 200,000 × 12 KB = ~2.4 GB **per day**, ~96 GB over 40 days. Far less in reality, because a small Redis HLL stays sparse (252 bytes at 50 people) and only becomes dense past ~3,000 bytes (the exercise's `npm run redis`, part B - dense at 5,000 people). To calculate it you need **the distribution of workspace sizes**: how many workspaces have how many active people per day. Say 1% (2,000) are large and dense - 2,000 × 12 KB × 40 ≈ ~1 GB; the remaining 198,000 at an average of 300 bytes × 40 ≈ ~2.4 GB. A few GB in total - workable, but worth putting in the Redis memory plan. (The exercise's experiment 4: at p = 10 a dense HLL is only 768 bytes - but Redis's p is fixed, so that is only possible if you write your own HLL.)

(b) Retention = |last week ∩ this week| ÷ |last week|. Intersection = |A| + |B| − |A ∪ B|, and the error is proportional to the union (part D).

- **The large workspace:** A = B ≈ 50,000, intersection ≈ 30,000, union ≈ 70,000. 0.81% of the union ≈ 570 of uncertainty (plus ~400 each from A and B), so roughly ±800 on the intersection overall - ~2–3% of 30,000. Retention reads "58–62%" instead of "60%". Fine for a trend on a dashboard. (This is an estimate, not measured - in the exercise the error was −0.16% at a 50% overlap and −10% at 10%.)
- **The small workspace:** 200 people - here the Redis HLL is sparse, and at small numbers linear counting is almost exact (part A: +0.31% at 100). But 200 people do not need an HLL at all - an exact `SET` is a few KB. The rule: **an approximate structure only when the exact one is genuinely expensive.**
- And if the retention number is small (say 5% of users of a new feature), the intersection is small and the error enormous - there, an exact join in a batch.

(c) No - and the reason is not the **size** of the error but its **direction**. HLL's error goes both ways: some customers will be overcharged. 0.81% is the "typical" error, but part B: on one of 40 days it was 2.13% - 21 extra seats on the invoice of a 1,000-seat customer. If the customer asks "which 21 people?", there is no answer - HLL does not know "who". An invoice that cannot be proven is a legal risk. The batch job runs for a few minutes at night - saving that is not worth this risk. Keep HLL on the dashboard, with a "~".

**Question 3:**

Three problems:

1. **`NONSCALING` + a capacity of 200,000** - there are 200,000 links today. As soon as capacity is passed, `BF.ADD` fails - "non scaling filter is full". With ioredis, a single `BF.ADD` gives a rejected promise (an exception), and `BF.MADD` gives an element inside the reply array (both verified here). After the DB commit, a handler typically catches this error, logs it and carries on - the link has been created, so there is no point showing the user an error - and that is exactly how new links **never enter** the filter → `BF.EXISTS` says "not here" → 404. It shows up: from the moment the link count passes 200,000, **only on new links** - exactly 1.6's situation, permanently. The number: `npm run redis` part C - 494,508 "inserted" names reported "not here". "Memory will never grow" is true - because it stops accepting anything new.
2. **One key, every request** - all share link traffic on one Redis key, on one node (in Redis Cluster a key has one slot). 10.1's hot key - with the bots' 1,000 req/s, that node's load is far above the others'. It shows up: as traffic grows, or in the next enumeration attack - and the other cache keys on that node get slower too. Plus one extra network round trip per request.
3. **What if Redis is not there?** The design does not say. If the handler treats a `BF.EXISTS` failure as "not here" (fail closed) → **every** share link is a 404. If it returns a 500 → every share link is broken. The filter is an optimization, so the right behaviour is fail open - without Redis, go straight to the DB (slow, but correct). It shows up: on the first Redis failover or network blip (like the 30 seconds in 10.1's 1.6).

One more subtle gap (a bonus if you name it as a fourth): "`BF.ADD` after the DB commit" - the commit happens, then a process crash or a Redis timeout, and `BF.ADD` never happens. The link is in the DB but not in the filter - a 404 forever, because there is no rebuild. 7.5's dual write. The remedy: an outbox, and regular rebuilds.

**What is right:** the order "add to the filter **after** the DB commit" is correct - adding first and then having the commit fail would leave a non-existent link in the filter, which is only a false positive (the harmless direction). And the idea of a shared filter is not bad in itself - for a low-traffic place like signup (question 1) it is the better choice. The problem is where it is used, and the three conditions (capacity, hot key, fail open) that were left out.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (four scripts are deterministic simulations, no Docker needed; Docker for `npm run redis`)

> **Ready to run in the repo:** [`exercises/lesson-10.2-bloom-hll/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.2-bloom-hll) - `npm install`, then `npm run bloom`, `npm run penetration`, `npm run hll`, `npm run heavy`; and `docker compose up -d --wait` followed by `npm run redis`. The full setup, acceptance criteria and experiments are in the `README.md` there.

A Bloom filter (with a counting Bloom filter), HyperLogLog and a Count-Min Sketch - all three by hand, on top of a MurmurHash3. `bloom` shows bits/item and hash count versus FPR (next to theory), filling past capacity, and the three ways to delete. `penetration` runs Tuesday's incident - cache only, negative cache and Bloom filter side by side; then what happens when the filter does not know about new links. `hll` measures the error from 10 to 10 million, the cost of precision, a weekly merge versus a sum, and how intersection breaks down. `heavy` finds hot boards with a Count-Min Sketch. `redis` measures the memory of a `SET`, a HyperLogLog and a `BF` on a real Redis 8, and shows what happens when a `NONSCALING` filter fills up.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` and ESLint clean; the five scripts **three times each**, with output identical every time (compared byte for byte) - including `npm run redis`, on `redis:8-alpine` (8.10.1). The first four scripts have **no network, DB or Redis** - the "DB" is a `Set`, the cache is an LRU built on a `Map`, and a "request" is a function call; so no time was measured anywhere, and every number is **counted**. "DB queries/s" means total queries ÷ (requests ÷ `RPS`). The penetration cache is a simple LRU, not Redis's approximate LRU. The HyperLogLog is the original 2007 form (with linear counting, without HLL++'s bias correction). The memory figures from `npm run redis` may change with the Redis version and allocator. **Not measured:** Redis's `CMS.*`, `TOPK.*` and `CF.*` (the commands exist in Redis 8 - verified - but their numbers were not measured); updating the filter through an outbox and its delay (1.6 and 1.13 - a design, not run); 1.5's per-subnet 404 rate limit; question 2's retention error (an estimate). The Cassandra and Akamai remarks in 1.7 come from their documentation and published writing - not verified here. TaskFlow's decision in 1.13 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `bloom`, write down - what will the FPR be at 8 bits/name, and at double the capacity? Then run it and compare. However wrong your second guess was is exactly why capacity should be an alerting metric.

2. **The limits of a negative cache:** `NEGATIVE_TTL=5 npm run penetration`, then `NEGATIVE_TTL=1`, then `CACHE=200000`. Does the negative cache ever give fewer DB queries than "cache only"? Now, in `penetration.ts`, make the bots cycle through 1,000 fixed slugs instead of random ones (like a buggy client). What does the negative cache do now? Put the two results side by side and write one line on when to use which.

3. **The cost of keeping the filter fresh:** `REBUILD=10 npm run penetration`, then `REBUILD=300`. How many wrong 404s? Now calculate: with 20 million links, how many rows must each instance read to rebuild the filter from the whole DB every 10 seconds, and how many in total across 10 instances? That number is why it is the strongest argument for "add on the creation path".

4. **HLL precision and merging:** `PRECISION=10 npm run hll`. What was the weekly merge's error, and what is in the "worst day" column? Which p is enough for TaskFlow's dashboard - and for which question is even p = 16 not enough?

5. **The design part:** a new feature is coming to TaskFlow - "Recommended for you": showing each user public boards they have **not seen before**. The list of boards seen per user averages 2,000, with a maximum of 200,000; 10 million users. A one-page plan: (a) one Bloom filter per user - what is the direction of error (showing an already-seen board again, or skipping an unseen one)? Which direction is harmless here? (b) 2,000 and 200,000 - the same size filter for both? What will you do? (c) Total memory, and where will you keep it (Redis, or a blob in the DB)? (d) What if a user clears their history? (e) In which one place would you deliberately keep an exact structure (a table), and why?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1
Current: 10.2 - Bloom Filter, HyperLogLog (probabilistic data structures)
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limits
in two layers; cache on a 160-vnode ring (membership from the registry, nodes added slowly, FLUSHALL
before returning, 5-minute TTL), long term Redis Cluster. Share board (public links, 8-character slugs,
200,000 links) hit by an enumeration attack - 1,000 req/s of random slugs, half the DB's work looking up
"missing"; the negative cache backfired (random keys, zero hits, real entries evicted). Now: a Bloom
filter in memory on each instance (1%, capacity 400,000, ~470 KB), outbox event on the creation path →
added on every instance, a "created in the last 5 minutes" set in Redis for the gap, rebuilt hourly,
fail open if the filter is stale/missing; no negative cache for share links; a per-subnet rate limit on
missing slugs. Active users: a Redis HLL per workspace per day (hash tag {workspace:<id>}, TTL 40 days),
week/month = union via PFCOUNT, "~" on the dashboard; billing is an exact COUNT(DISTINCT) in the nightly
batch, never HLL. Hot boards: a Count-Min Sketch per instance (4096 × 4, renewed every minute) + top 20
→ 2 s local cache
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch
Weak spots: [where you got stuck - write it yourself]
Next: 10.3 - Fault tolerance, graceful degradation, chaos engineering
=======================
```

---

## 8. Next Step

Today's thread: **the price of an exact answer is often remembering everything, and once that is no longer possible, the question changes - from "how wrong" to "wrong in which direction".** A Bloom filter can stand in front of a DB precisely because it errs in the harmless direction; HyperLogLog cannot go on an invoice precisely because it errs both ways. And one lesson running straight on from 10.1: an algorithm's promise ("never a false negative") is not the system's promise - whether the insert arrived, whether the filter is fresh, whether anyone read the error, those are your responsibility.

One phrase kept coming up today: **fail open** - when the filter is not there, be slower, not wrong. It is a small form of a big idea. When you are ready, write `next` - we go to **Lesson 10.3: Fault Tolerance, Graceful Degradation, Chaos Engineering**. There the question covers the whole system: which feature stops and which keeps running when some part of TaskFlow dies, how to design the "bad but running" state in advance - and why the only way to trust that design is to deliberately break something in production and see.
