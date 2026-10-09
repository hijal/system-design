# Lesson 10.1 - Consistent Hashing Deep Dive

**Module 10 - Reliability, Security & Operations**

> **Spaced Repetition (Lesson 4.6):** What is a cache stampede, and what are two remedies for it, one line each? And where does the "hot key" problem differ from a stampede? Both come back today - the first from a place you would not expect: **adding** a cache node.

**Prerequisite:** Lesson 3.2 (Introduction to IP hash and consistent hashing), Lesson 4.2 (Cache-aside, invalidate-on-write), Lesson 4.6 (Stampede, hot key), Lesson 5.8 (Sharding, resharding - 75% versus ~25%), Lesson 5.9 (Replicas, quorum), Lesson 6.1 (Slow versus dead - indistinguishable from outside), Lesson 9.4 (Health checks, registry)

**By the end of this lesson you will be able to:**

1. Say with numbers why `hash % N` moves almost every key when the node count changes - and, more importantly, **where** the moved keys go - and how a hash ring brings that down to just the new node's share
2. Explain why virtual nodes are not optional, how many you need and what they cost, and spot the trap virtual nodes create when choosing replicas
3. Choose between a ring, rendezvous hashing and jump hash, and state what consistent hashing **does not** do - it gives no consistency, does not fix hot keys, and takes no responsibility for whether every client sees the same ring

**Tier:** 1 - Runnable Code (hash ring, `hash % N`, rendezvous and jump hash - all counted in a deterministic simulation; no Docker needed)

---

## 0. Where TaskFlow Is Right Now

After Module 9, TaskFlow's Redis was split in two: the rate limiter got its own Redis (9.5), and the cache was kept separate. But the cache itself no longer fits on one machine - task lists, boards and workspace member lists together make a working set over 10 GB, and `allkeys-lru` (4.3) is evicting all day long; the hit rate has dropped from 96% to 88%.

So two months ago an engineer wrote a small wrapper:

```typescript
const clients: Redis[] = env.CACHE_NODES.split(',').map((url) => new Redis(url));

export function cacheFor(key: string): Redis {
	const client = clients[hash(key) % clients.length];
	if (!client) throw new Error('no cache nodes configured');
	return client;
}
```

Three Redis instances, each holding a third of the keys. The hit rate is back to 96%. Everyone is happy.

**Monday, 9:30 a.m.** A big customer launches at noon, and traffic is expected to double. Ops prepared ahead of time: they started a fourth Redis, added it to `CACHE_NODES`, and did a rolling deploy. At **9:31** Postgres CPU is at 100%. At **9:32** the board's p99 is 4 seconds and the connection pool is full (5.6). By **9:34** the whole site is nearly unusable. Nobody changed any code, nobody changed any query - just **one extra cache node**, brought in to **reduce** load.

Two questions came up in the postmortem. The first was simple: why? The second came from the CTO: "We heard the name consistent hashing back in 3.2 and 5.8. This time understand it fully - and measure, don't just swap it in. Because I've heard it has traps of its own."

The CTO heard right. This lesson covers both.

---

## 1. Theory

### 1.1 The real cost of `hash % N` - how much moves, and where it goes

In 5.8 we saw a number: going from 3 to 4 shards with `hash % N` moves ~75% of keys. Why so many? A key stays put only if `h % 3 == h % 4` - and that holds for only 3 of the 12 remainders (0, 1, 2). So 25% stay and 75% move. In general, going from N to N+1 moves **roughly N/(N+1) of the keys** - the more nodes, the more moves. In a large cluster, `hash % N` shakes up almost all the data.

But that number is half the story. The exercise's `npm run rebalance`, 4 to 5 nodes, 100,000 keys:

```
routing                        moved  to the new node    among the old
hash % N                       79.9%         25.2%            74.8%
ring (vnode 1)                 30.7%        100.0%             0.0%
ring (vnode 160)               20.1%        100.0%             0.0%
   ideal: only the new node's share = 1/5 = 20.0%, and all of it to the new node
```

Look at the last column. With `hash % N`, **74.8% of the moved keys went from one old node to another old node**. A key on node 1 went to node 3, a key on node 3 went to node 2 - even though none of those old nodes' shares were supposed to shrink; only the new node's share was supposed to grow. This is pure waste: data that was already in the right place is thrown away and has to be fetched again.

**Consistent Hashing** - a way of placing keys on nodes such that adding or removing one of N nodes moves only ~1/N of the keys on average, and the moved keys are exchanged **only** with that added (or removed) node - nothing moves among the other nodes.

The two ring rows in the table above show exactly this: 100% of the moved keys went to the new node, 0% among the old ones. And with virtual nodes, the amount is almost exactly ideal too - 20.1% versus 20%.

### 1.2 The Hash Ring - keys and nodes on the same circle

**Hash Ring** - treating the full range of hash values (say 0 to 2³²−1) as a circle, placing each node at the point given by the hash of its name, and making the owner of a key **the first node found going clockwise** from the key's hash point.

```
                        0 / 2³²
                          │
                  ┌───── A ─────┐
                 ╱               ╲         key k1 → first node clockwise = B
               k3                 k1
              ╱                     ╲
             C                       B      A's share: the arc from C to A
              ╲                     ╱       B's share: from A to B
               ╲                   ╱        C's share: from B to C
                └───── k2 ────────┘
                                             k2 → C,   k3 → A

   Now D is added - between B and C, just after k2 (clockwise):

        B ──── k2 ──── D ──── C             k2 → now D (was C). Only the arc from B to D
                                            moved from C to D; not one key of A or B moved.
```

Why this works: when a node is added it sits at one point on the circle and takes over only the arc just before it - the one that until now belonged to the next node. For the rest of the circle, no key's "first node clockwise" has changed. Removal is the reverse: the next node inherits its arc.

Lookup is simple - the circle's points sit in a sorted array, and you binary-search for the first point greater than or equal to the key's hash (if you reach the end, wrap around to the start - that is the "circle"):

```typescript
route(key: string): string {
	const h = hash32(key);
	let lo = 0;
	let hi = this.points.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((this.points[mid]?.point ?? 0) < h) lo = mid + 1;
		else hi = mid;
	}
	const owner = this.points[lo === this.points.length ? 0 : lo];
	if (!owner) throw new Error('empty ring');
	return owner.node.id;
}
```

But look at the second row of the table above: placing each node at a single point (`vnode 1`) moved **30.7%**, not 20%. That is because the hash decides where on the circle the new node lands - and it landed somewhere with a long arc before it. In a one-point ring each node's share is **the length of its arc**, and that length is random. The consequence is even worse when a node is removed:

```
routing                      cache-1   cache-2   cache-4   cache-5      heaviest
ring (vnode 1)                    0%      100%        0%        0%         1.45x
ring (vnode 160)                 29%       19%       25%       27%         1.04x
```

When `cache-3` dies in a one-point ring, **all** of its keys land on a single neighbour (`cache-2`). That node now carries 1.45 times its fair share - and if it slows or dies under that load, its whole share (its own plus `cache-3`'s) lands on the next one. This is exactly the shape of Lesson 9.4's cascade, this time in the partitioning of data. In the second row the same keys spread almost evenly across four nodes. The difference is a single thing - virtual nodes.

### 1.3 Virtual Nodes - one machine, many places on the circle

**Virtual Node (vnode)** - placing each physical node not at one point on the circle but at many (say the hashes of `cache-1#0`, `cache-1#1`, …), so each node's share is the sum of many small arcs - and the sum of many random lengths stays close to the average.

`npm run vnodes` - 10 nodes, 200,000 keys:

```
vnode / node          heaviest       lightest  points on ring   lookup steps
1                        3.06x          0.02x             10            3.4
10                       1.51x          0.61x            100            6.7
50                       1.23x          0.80x            500            9.0
100                      1.15x          0.87x          1,000           10.0
160                      1.13x          0.90x          1,600           10.7
500                      1.06x          0.95x          5,000           12.4
1000                     1.04x          0.97x         10,000           13.3
```

Three things to read in this table:

1. **A ring without virtual nodes is nearly meaningless.** With one point, the heaviest node gets **3 times** its fair share, and the lightest gets almost nothing (0.02x). This is not unusual bad luck - ten random points divide a circle this unevenly as a matter of course.
2. **The improvement shrinks as you go.** From 10 to 100 the heaviest goes from 1.51x to 1.15x; from 100 to 1000 only from 1.15x to 1.04x. Roughly speaking, the deviation falls with the inverse square root of the number of virtual nodes - 100 times as many points cuts the deviation only ~10 times.
3. **Lookup cost is logarithmic, but the other costs are linear.** From 10 to 10,000 points the binary search goes from 6.7 to 13.3 steps - a thousand times the points for twice the work, which is negligible. But the ring's memory, and rebuilding the ring and **delivering it to every client** whenever a node is added or removed, grow directly with the number of points. Thousands of clients each holding a 10,000-point ring is no longer negligible.

And one benefit not in this table, but which you saw in 1.2's second table: many virtual nodes means that when a node dies its keys spread **across everyone** (29/19/25/27%). For the same reason, when a node is added it pulls data **a little from everyone** - not everything from one node. In a storage system (like Cassandra) this means filling a new node runs in parallel from many old nodes.

What the numbers look like in practice: the well-known **ketama** library for memcached places 160 points per server - this exercise's default comes from there. For many years Cassandra's default was 256 tokens per node; from 4.0 the default is 16, together with a token allocation algorithm that tries to keep shares even rather than placing them at random (fewer points, but placed intelligently). In other words, there is no universal answer to "how many" - it is a decision combining the cluster's size, how much imbalance you can tolerate, and how many clients the ring has to be distributed to.

### 1.4 Weight - not every machine is the same

Virtual nodes come with a bonus: machines of different sizes are easy to handle. Give a machine with twice the RAM twice the virtual nodes, and it gets twice the share:

```
node                weight         got    fair share
cache-1                  1       19.6%         20.0%
cache-2                  1       18.7%         20.0%
cache-3                  1       20.3%         20.0%
cache-big                2       41.3%         40.0%
```

One real use of this ties directly to this lesson's story: bring a new node in **with a small weight**, then raise it step by step. That way the wave of cache misses arrives not all at once but as several small waves (1.6).

### 1.5 Preference List - 3 copies, but which 3 nodes?

A cache usually keeps one copy of each key. But if a database partitions data with a ring (Amazon's Dynamo paper, Cassandra and Riak are in this line), it keeps N copies of each key - the same N as 5.9's quorum.

**Preference List** - the ordered list of nodes that will hold a key's copies; on a ring it is usually built by walking clockwise from the key's point and picking successive nodes.

The simplest rule - "the next 3 points on the ring" - hides a trap once there are virtual nodes: the next two points are often two virtual nodes of the **same physical node**. `npm run vnodes`, part C - 6 nodes, 3 AZs (availability zone - separate data centres within one cloud region; a whole AZ can go down at once), 3 copies per key:

```
rule                         not 3 distinct nodes  not 3 distinct AZs  one AZ loss kills all copies
the next 3 points                 45.3%              76.8%                  11.2%
the next 3 distinct nodes          0.0%              59.1%                   0.0%
the next 3 distinct AZs            0.0%               0.0%                   0.0%
```

- **Under the first rule, 45.3% of keys' "3 copies" actually sit on 2 (or 1) machines.** The config says replication factor 3, the dashboard says 3, but nearly half the data loses its quorum when one machine dies. And for 11.2% of keys all three copies are in one AZ - if that AZ goes, those keys are lost entirely.
- **The second rule (distinct nodes) handles machine failure, but 59.1% of keys have two copies in one AZ.** In 6.1's terms: failures do not arrive independently, they arrive together - the same rack, the same power, the same AZ. The copies are not as "independent" as they look.
- **The third rule (distinct AZs)** - while walking the ring, skip any node whose AZ has already been taken. Cassandra's `NetworkTopologyStrategy` places replicas rack-aware on exactly this idea.

The third rule has a cost not in the table (we come back to it in Reflection question 2): if the AZs are not the same size - say one AZ has 3 nodes and another has 1 - that lone node has to hold a third of all the data by itself. The rule buys safety by taking away an even share. That is why, in such systems, keeping AZs the same size is an operational rule, not a preference.

### 1.6 TaskFlow's Monday - in numbers, and the ring's own trap

Now let us measure the incident from the story. `npm run cache` - from 3 cache nodes to 4, every key warm beforehand (so the hit rate before the change is ~100%), 5,000 reads/s, traffic following a Zipf distribution (a few keys very popular, the rest less so - like real cache traffic):

```
routing                  first 1 s hit  DB in first 1 s   first 10 s hit  total DB queries
hash % N                         56.8%            2,162            75.4%         26,370
ring (vnode 160)                 85.3%              737            91.6%          9,066
```

**2,162 extra queries hit Postgres in the first second**, where before there were almost none. Each of those board queries in TaskFlow involves several joins (5.6), and Postgres was not ready for noon yet - this is exactly the 9:31 CPU at 100%. This is Lesson 4.6's cache stampede, but self-inflicted: no key's TTL expired; the **addresses** of thousands of keys changed at once.

With the ring, 737 in the first second - about a third. Total DB queries fall from 26,370 to 9,066. This is the real accounting of consistent hashing, not "percentage of keys moved": **how much load the database takes in the few seconds after a node change**.

One thing might surprise you: if `hash % N` moves 75% of keys, why is the first-second hit rate 56.8% rather than 25%? Because the traffic is Zipf - the most popular keys miss once in the first few milliseconds, get filled on their new node, and hit for the rest of the second. The more skewed the traffic, the smaller the damage **looks**: in the exercise, at Zipf 0.5 the first-second hit rate is 32.1%, at Zipf 1.2 it is 83.4%. This is a dangerous comfort - add a node in staging (where a handful of keys are read over and over) and you will think "nothing happened", while production's long-tail traffic knocks Postgres over.

**The ring's own trap: consistent hashing does not give consistency.** The name suggests it does, but "consistent" here only means "the mapping does not change much when nodes change". Now picture an incident that really can happen after moving to the ring: 9.4's health check sees `cache-2` as unreachable for 30 seconds (a network blip - the machine did not die, its memory is intact), and the registry removes it from the ring. During those 30 seconds its keys go to other nodes; there they miss, get filled, and some tasks get **written** - per cache-aside (4.2), update the DB, then delete the cache key - but the delete goes to **the owner at that moment**, not to `cache-2`. Then `cache-2` comes back, with its old data, and the ring hands its keys straight back to it:

```
on return                     stale read (10 s)  distinct stale keys  miss (10 s)
put back on the ring as is                6,429                 320          197
flush first, then put back                    0                   0        4,278
```

**6,429 stale answers in ten seconds, across 320 distinct keys** - and if the cache has no TTL, they stay stale forever. In the user's eyes: "I moved the task to Done, but the board still says In Progress" - for hours, only on some tasks, and not even a refresh fixes it. 6.1's central point returns here: from outside you cannot tell "slow" from "dead", and the node you declared dead comes back **carrying old state**.

There are three remedies, all three cheap:

1. **Flush before returning** - the second row above: 0 stale, in exchange for 4,278 misses (a small, controlled wave). For a cache this is the right trade - a slow answer is better than a wrong one.
2. **A TTL on every cache key** - a ceiling on how long anything stays stale. A cache key that "never expires" is really a slow-motion bug.
3. **Delay before removal (hysteresis)** - do not remove a node from the ring on one failed check; require several in a row, over a set period. Every removal is a wave of misses, and every return is a risk of staleness - so the less the ring's membership flaps, the better.

### 1.7 Two more paths besides the ring - Rendezvous and Jump

The hash ring is not the only consistent hashing. Two other methods are used in practice, with different costs and benefits.

**Rendezvous Hashing (HRW, highest random weight)** - for a key, compute a score for every node (`hash(node + key)`) and make the node with the highest score the owner. When a node is added, only the keys for which the new node scores highest move; when a node is removed, only its keys move, each to its own second-best - which differs from key to key, so the load spreads naturally.

**Jump Consistent Hash** - a small algorithm from Google (2014) that turns a key and a bucket count `n` directly into a bucket number in `0…n−1` - no ring, no memory, ~ln(n) steps on average; the one condition is that buckets are just numbers, and they can only be added or removed **at the end**.

`npm run compare` - 10 nodes, 100,000 keys:

```
method                   heaviest  node added  cache-6 removed             lookup work    extra memory
ring (vnode 160)            1.12x        8.8%        10.0%  1 hash + 10.7 comparisons    1,600 points
rendezvous (HRW)            1.02x        9.3%         9.9%                 10 hash            none
jump hash                   1.02x        9.0%        48.5%      1 hash + 2.9 jumps            none
   ideal: on add 1/11 = 9.1%, removing a middle one 1/10 = 10.0%
```

- **Rendezvous** gives an almost perfect split without any virtual nodes (1.02x, better than the ring's 1.12x with 160 virtual nodes), needs no ring, and picks replicas naturally - the top 3 by score. The cost: **N hashes per lookup**. With 10 nodes that is nothing; with 10,000 nodes it is 10,000 hashes on every request. So in small to medium clusters it is often a better choice than a ring, and in large clusters a ring (or some structure that keeps that number small) wins.
- **Jump hash** is perfect in its split, uses zero memory and has a cheap lookup - but removing a node from the middle moves **48.5%** of keys. That is because jump hash knows nothing of nodes, only bucket numbers; remove one in the middle and everyone after it shifts down by one. Removing the last node moves ~9.9% (exercise experiment 5). So jump hash fits where buckets **themselves never die** - for example, where each bucket is itself a replicated shard (the machines inside it change, the bucket number does not). Placed directly in front of a list of machines, any of which may die at any moment, it is the wrong tool.

One more name worth knowing, because you will see it in load balancer configs: **Maglev** - a method built for Google's load balancer that fills a fixed-size lookup table (a direct index instead of the ring's binary search), keeps the split very even, and in exchange moves slightly more than a ring when nodes change. Envoy's load balancing policies list `RING_HASH` and `MAGLEV` side by side for exactly this reason. It was not measured here.

### 1.8 Hot Keys - no hash fixes them, and the cost of Bounded Load

There is one thing none of the methods above do: **a hash splits keys evenly, not requests.** If one workspace's board is 13% of all traffic on its own (say a big customer's launch - this lesson's noon), whichever node it lands on will take far more load than the others. The same holds for ring, rendezvous and jump, because a key has exactly one owner.

**Bounded-Load Consistent Hashing** - placing a cap on top of consistent hashing: no node takes more than `c` times (say 1.25) its fair share of in-flight work; when it is full, the request goes to the next node on the ring. (Work by Google researchers from 2016; Vimeo built it into HAProxy, where it now lives as `hash-balance-factor`.)

`npm run compare`, part B - Zipf 1.1, 1,000 concurrent requests, 200 times; the single hottest key carries ~13.3% of traffic on average:

```
method                          heavy (avg)         heavy (worst)      off its own node
ring (vnode 160)                     2.06x                 2.39x                  0.0%
bounded load, c = 1.25               1.25x                 1.25x                 11.3%
   (each node's limit = ceil(1.25 × 1000 / 10) = 125; when full, the next node on the ring)
```

On a plain ring the busiest node carries **twice** its fair share on average, 2.4 times at bad moments. With bounded load it is exactly 1.25x - never more. The cost: **11.3% of requests did not go to their own node.**

What that last column means depends on what sits behind it - and that is where the decision lies:

- **Something stateless behind it** (say identical API servers, where consistent hashing is only for connection or local-cache locality): sending 11.3% elsewhere is nearly free - locality drops a little, but no server drowns. Vimeo's use was of this kind.
- **A cache or data behind it**: "off its own node" means the data is **not** on that node - a miss, and copies of the same key scattered across several nodes. The real answer to a hot key in a cache is therefore 4.6's: a small local cache inside the app itself (for the few hottest keys, with a TTL of a few seconds), or splitting the hot key with a few suffixes (`board:42#0…#7`, reading a random one).

### 1.9 Is everyone looking at the same ring?

So far an assumption has been hiding: **every** TaskFlow app instance builds the same ring from the same node list. Go back to Monday's story - `CACHE_NODES` was changed with a **rolling deploy**. For ten minutes, of the six instances some were on the old list (3 nodes) and some on the new one (4). For the same key, the two groups consider two different nodes the owner. An instance from the old group updated a task and deleted the key from node A; an instance from the new group read from node B - where the old value sat, deleted by nobody.

This was not measured in the exercise, but the reasoning has exactly the same shape as 1.6's stale reads - this time no node died, just **two truths ran side by side**. And consistent hashing makes it smaller (on a ring only ~25% of keys change owner, versus ~75% with `hash % N`), but not zero.

So part of any consistent hashing system is not an algorithm - it is **membership**: which nodes exist, where that list comes from, and when everyone switches to the new list. In practice there are three approaches:

- **A central source** (9.4's registry, or a config service) - the list has a version, and everyone switches at a defined moment; not each instance's own copy in an env var.
- **Gossip** - in systems like Cassandra the nodes spread membership news among themselves; a client can ask any node.
- **The server keeps the truth of ownership itself** - Redis Cluster's approach, and it needs its own term.

**Hash Slot** - dividing the key's hash into a fixed, large number of slots (in Redis Cluster `CRC16(key) % 16384`), and keeping **which slot lives on which node** as a separate list; when a node is added, some slots are moved to the new node along with their data.

This is not a ring - it is the idea from 5.8 of "many logical shards from the start". A key's slot never changes; only the slot's owner changes. And two things make it safer than a client-side ring: (1) when a slot moves, Redis **moves the data too** - so the new node does not arrive empty and there is no wave of misses; (2) if a client goes to the wrong node based on an old list, that node itself replies `MOVED` with the correct owner - the truth lives on the server, not in the client's env var. In exchange: multi-key commands (like `MGET`) only work on keys in the same slot, so keys needed together have to be placed in the same slot with a hash tag (`{workspace:42}:board`, `{workspace:42}:members`).

### 1.10 TaskFlow's decision

**The long-term path for the cache: Redis Cluster**, not a home-built ring. Because of the two things in 1.9 - data moves with the slot (no wave of misses on a new node), and the truth of ownership lives on the server (`MOVED`), so there is no two-group problem during a rolling deploy. The hash tag rule: keys of one workspace that are read together get `{workspace:<id>}`.

**Until then, this week:** the wrapper moves from `hash % N` to a ring with 160 virtual nodes (a tested, ketama-compatible library; not hand-written). Along with that:

- **Nodes are added only slowly, and outside busy hours** - a new node comes in at weight 0.25 and is raised every 15 minutes (1.4); at each step, look at the DB's p99 before taking the next one. And 4.6's single-flight in front of every miss, so a thousand misses for the same key become one query.
- **Membership from one place** - the cache node list lives in the registry, with a version; every instance is on the same version within 10 seconds. Not an env var.
- **Delay before removal, flush before return** - removed from the ring after 3 consecutive failed checks within 30 seconds; to come back, first `FLUSHALL`, then a small weight. And a TTL (5 minutes) on every cache key - a ceiling on staleness, whatever the mistake.
- **Hot keys**: **not** bounded load (there is a cache behind it, 1.8). For hot boards, a 2-second local cache in each app instance.

**Not needed yet:** replicas and a zone-aware preference list (1.5) - the cache keeps one copy, and if it is lost the DB is there. But once we go multi-region in 10.8, this question will come back with its full weight.

**Three numbers on the dashboard:** each node's hit rate (separately - the overall hit rate hides one node's problem); the busiest node's ops/s ÷ the average (the first sign of a hot key or a bad split); and DB queries/s in the 60 seconds after a membership change - the price of each change, in numbers.

---

## 2. Interview Angle

**"Design a distributed cache (or key-value store)"** - consistent hashing will almost certainly come up here, and the interviewer is watching how far beyond the name you go. The structure: first **why not `hash % N`** (with numbers: N to N+1 moves ~N/(N+1); and most moved keys just shuffle among the old nodes), then the **ring** (first node clockwise), then **virtual nodes** (why - the split and spreading load on failure; how many - with the cost), then **replicas** (preference list, distinct nodes and distinct AZs), and finally **membership** (who knows the ring, and how a change reaches everyone).

**Follow-ups that are almost certain:**

- _"What happens when a node dies?"_ - who gets its share (without virtual nodes, one neighbour; with them, everyone), the wave of misses in a cache, and the risk of stale data when it returns.
- _"Hot keys?"_ - a hash splits keys, not requests; so no hash fixes it. In front of something stateless, bounded load; in front of a cache, a local cache or splitting the key.
- _"Does Redis Cluster use consistent hashing?"_ - No, and it is a good trap question. 16384 hash slots, and a slot-to-node list. Being able to explain the difference in your own words is a senior signal.
- _"Ring or rendezvous?"_ - in a small cluster rendezvous (even without virtual nodes, easy replica choice), in a large cluster a ring (O(log n) lookup). And jump hash only where a bucket itself never dies.

**In real production:** the best-known incidents - splitting a cache with `hash % N` and taking down the database on the day a node is added (this lesson's story); a ring without virtual nodes, where one node's death drowns its neighbour and starts a cascade; two virtual nodes of the same machine chosen as replicas, which nobody notices until a machine dies and quorum is lost; a flapping node returning to the ring with old data; and mismatched node lists across clients - especially during a rolling deploy, or when clients in two different languages read the same cluster using two different hash functions.

---

## 3. Key Takeaway

- With `hash % N`, going from N to N+1 **moves ~N/(N+1) of the keys** - measured: 79.9% for 4→5; and **74.8% of the moved keys just shuffle among old nodes**, which is pure waste
- **Consistent hashing** = adding or removing a node moves only ~1/N, and only with that node - measured: 20.1%, and 100% of moved keys to the new node
- **A ring without virtual nodes is nearly meaningless** - with 1 point the heaviest node is 3.06x, and **all** of a dead node's keys land on one neighbour; with 160 it is 1.13x, and the load spreads across everyone
- The improvement from virtual nodes shrinks as you go (inverse square root), lookup cost is logarithmic, but the ring's size and the cost of distributing it are linear; weights handle machines of different sizes and bringing nodes in gradually
- **"The next 3 points" is a trap for choosing replicas** - measured: 45.3% of keys have two copies on the same machine; distinct nodes and distinct AZs both have to be written into the rule
- The real cost of adding a node is not "what % moved" but **how much load the DB takes in the next few seconds** - measured: 2,162 versus 737 in the first second; and skewed traffic makes the damage **look** smaller, not be smaller
- **Consistent hashing does not give consistency** - 6,429 stale reads in 10 seconds from a node returning with old data; remedies: flush before return, a TTL on every key, delay before removal
- **Rendezvous** beats a ring in small clusters (1.02x, no ring, costs N hashes per lookup); **jump hash** moves 48.5% when a middle node is removed - only where a bucket itself never dies
- **No hash fixes a hot key** - on a ring the busiest node is ~2x; bounded load caps it at 1.25x but 11.3% of requests go off their own node - good in front of something stateless, misses in front of a cache
- Whether everyone sees the same ring - **membership** - is not part of the algorithm but is part of the system; Redis Cluster is not a ring, it is hash slots + ownership kept on the server (`MOVED`)

---

## 4. New Terms (Glossary)

| Term                                | Meaning                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hash Ring**                       | Treating the full range of hash values as a circle and placing nodes at their hash points; a key's owner is the first node clockwise from its point - so adding or removing a node changes only the adjacent arc           |
| **Virtual Node (vnode)**            | Placing one physical node at many points on the circle, so its share is the sum of many small arcs - the split becomes even, and when a node dies its load spreads across everyone; weight = the number of vnodes          |
| **Preference List**                 | The ordered list of nodes that will hold a key's copies - chosen by walking the ring; skipping the same physical node and the same AZ has to be written into the rule                                                      |
| **Rendezvous Hashing (HRW)**        | A `hash(node + key)` score for every node, and the highest-scoring node owns the key; an even split without virtual nodes and no ring - the cost is N hashes per lookup                                                    |
| **Jump Consistent Hash**            | A bucket number computed directly from a key and the bucket count, with no memory, in ~ln(n) steps; a perfect split, but buckets can only be added or removed at the end - removing a middle one moves about half the keys |
| **Bounded-Load Consistent Hashing** | A cap on top of consistent hashing - no node takes more than `c` times its fair share, and when full the request goes to the next node; it bounds hot-key load, in exchange for some requests leaving their own node       |
| **Hash Slot**                       | Dividing a key's hash into a fixed, large number of slots (16384 in Redis Cluster) and keeping the slot-to-node list separately; a key's slot never changes, only the slot's owner - along with its data                   |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines in your own words for each.

1. TaskFlow's (pre-Redis Cluster) cache is now on 6 nodes, and two nodes will be added at once to make 8. (a) With `hash % N`, what % of keys will move? Show it by working through the remainders. (b) On a ring (with virtual nodes), what %? And adding two nodes at once versus one at a time 15 minutes apart - does the total amount moved change? Which is better for the database, and why? (c) In this lesson's exercise, 3→4 on the ring produced 737 DB queries in the first second. Roughly how many would you expect in the first second for your 6→8 (adding both at once), and what assumptions go into your estimate?

2. A teammate built a small key-value store: 6 nodes, 3 AZs (2 in each), a ring with 160 virtual nodes, 3 copies of each key - using the "next 3 points on the ring" rule. Both reads and writes use a quorum (R = W = 2, 5.9). (a) Using the exercise's numbers, say what kind of keys get into trouble when one **machine** dies, and what kind when one **AZ** goes. (b) If you switch to the "distinct nodes" rule only, which problem goes away and which remains? (c) After switching to the "distinct AZs" rule, one machine in one AZ is retired, and its replacement takes two weeks - the AZs now have 2, 2 and 1 nodes. What happens to that lone node's share, and why?

3. After Monday's incident TaskFlow moved to a ring, but the node list is still in the `CACHE_NODES` env var, and deploys are rolling (six instances, ten minutes). The write path is cache-aside: DB update, then `DEL` the cache key (4.2). (a) During the ten minutes of a rolling deploy from 4 to 5 nodes, in exactly what order must things happen for a user to see an old board? Write it step by step - which instance, holding which node. (b) Can the problem remain even after the deploy finishes - in what situation? (c) Give three separate remedies - one for membership, one for the write path, one for the cache itself - and the cost of each.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) A key stays put if `h % 6 == h % 8`. Their LCM is 24, so it is enough to look at the 24 values of `h % 24`: for which `r` is `r % 6 == r % 8`? For `r = 0…5` - here both are `r` itself. For `r = 6…23` none match (e.g. 6: `0` versus `6`; 12: `0` versus `4`; 18: `0` versus `2`). So 6 out of 24 stay - **25% stay, 75% move**. (The same 75% as 3→4 - a coincidence, but worth remembering: adding two nodes at once does not reduce the damage with `hash % N`.)

(b) On a ring, ideally the two new nodes' share - **2/8 = 25%**. One at a time: the first step moves ~1/7 (~14.3%), the second ~1/8 (12.5%). The total is ~26.8%, a little over 25% - because some keys that moved to node 7 in the first step move again to node 8 in the second (roughly 1/7 × 1/8 ≈ 1.8%). In other words the total work is about the same, slightly more. But **one at a time is better for the database**: the wave of misses becomes two small waves, 15 minutes apart - after the first, the cache warms up again, and you can look at the DB's p99 from the first wave before deciding whether to do the second. What kills a database is not the total misses but the **peak** misses/s - the same reasoning as 9.5's "not how much, but how much at once". (And bringing nodes in gradually with weights, 1.4, breaks this into even smaller waves.)

(c) A rough estimate: in 3→4 the ring moved ~25% of keys and produced 737 queries in the first second. 6→8 at once will move ~25% - the same fraction. So with the same traffic and key count, the first second is roughly the same size, **~700–800**. But write your assumptions down honestly: (1) traffic at 5,000 reads/s with the same Zipf shape - needing 8 nodes probably means traffic has grown, in which case the number scales up proportionally; (2) the cache was fully warm beforehand; (3) no single-flight - with it, many misses for the same key become one query and the number falls a lot; (4) the Zipf exponent - you saw in 1.6 that it can change the first-second number several-fold. The best answer: run the exercise with `KEYS`, `RPS` and `ZIPF` set to your own production numbers - a simulation beats a guess, and one step in production (one node, small weight) beats both.

**Question 2:**

(a) The exercise's numbers under the "next 3 points" rule:

- **When a machine dies:** for 45.3% of keys at least two copies are on the same machine. If that machine dies, such keys are left with 1 (or 0) copies - R = W = 2 no longer forms a quorum, so those keys can neither be read nor written (until the data is rebuilt on another node). A machine dying is the most common failure, and the claim "RF 3, survives one machine dying" is false for nearly half the data.
- **When an AZ goes:** 76.8% of keys have at least two copies in the same AZ, and 11.2% have all three in one. With 3 AZs, in roughly a third of cases the "doubled" AZ will be the one that went - so, roughly, ~25% of keys lose quorum, and some of those lose every copy. (This last figure is a rough estimate from the exercise's numbers, not measured - to measure it by "which AZ went" you would need to add a column to `vnodes.ts`.)

(b) Under the "distinct nodes" rule: the machine problem goes away **entirely** (0%), and "all copies in one AZ" also goes away (0% - 6 nodes, 2 per AZ, so three distinct nodes never fit in one AZ). But **59.1% of keys still have two copies in one AZ** - if the AZ goes, those lose quorum. In other words, you are protected from machine failure but not from AZ failure. 6.1's point: failures arrive together, and a rule has to be set separately at each layer of failure domain (machine, rack, AZ, region).

(c) Under the "distinct AZs" rule, every key has one copy in each AZ. With AZs at 2, 2 and 1, **the lone node in the third AZ has to hold one copy of every key** - a third of all the data (one of the three copies), while each of the other four holds ~1/6. So its disk and load are **double** everyone else's. For two weeks it is the heaviest node, and if it dies the copies for an entire AZ are gone - in exactly the two weeks when the system is most fragile. Three options, none free: (1) relax the rule for two weeks (fewer copies in that AZ - less safety); (2) remove one node each from the other two AZs to make it 1, 1, 1 (less capacity); (3) bring in a temporary machine quickly. That is why one operational rule for running rack-aware systems is: **keep failure domains the same size** - it is not part of the algorithm, but the algorithm's safety stands on it.

**Question 3:**

(a) Step by step, with a key `board:42` whose owner is `cache-2` with 4 nodes and `cache-5` with 5 nodes (true for ~20% of keys on a ring):

1. The rolling deploy starts. Instances 1–3 are on the new list (5 nodes), 4–6 still on the old one (4).
2. A user opens the board, and the request goes to instance 1 (new). `board:42` is not on `cache-5` - a miss, so it reads from the DB and stores it on `cache-5`. Now both `cache-2` and `cache-5` hold the same (still correct) value.
3. Another user moves a task to Done, and the request goes to instance 5 (old). DB update, then `DEL board:42` - **from `cache-2`**.
4. The first user refreshes, the request again goes to a new instance - the old value from `cache-5`. **Stale**, and nobody will ever delete that key on `cache-5` until another write comes through a new instance.

The reverse is the same: a new instance deletes from `cache-5`, an old instance reads the old value from `cache-2`. For ten minutes, write invalidation and reads are following two different truths.

(b) Yes. After the deploy everyone is on the new list, so `board:42` is now read only from `cache-5` - and step 4's stale value is sitting right there. Without a TTL it stays until the next write, perhaps for days. And another hidden state: the old copies of those keys are left lying on `cache-2` (nobody reads them now, so harmless) - but if `cache-5` is ever removed later (or the node list changes again), those keys can route back to `cache-2`, and that old value comes back to life - exactly the shape of 1.6's flapping.

(c) At three layers:

- **Membership:** the node list from one place (registry / config service), with a version, and everyone switching at the same moment - not tangled up with the rolling deploy. Better still: Redis Cluster, where the truth lives on the server and the wrong node returns `MOVED` (1.9). The cost: a new dependency (what if the registry dies? - keep running on the last known version), or the migration work for Redis Cluster and its limits on multi-key commands.
- **The write path:** during the list change, send the invalidation **to both owners** - `DEL` against both the old ring and the new ring. The cost: an extra call on every write during the change, and the complexity of "know two rings" in the code; and if it is forgotten (one old code path), the protection silently disappears.
- **The cache itself:** a TTL on every key - whatever the bug, a ceiling on staleness (say 5 minutes). The cost: the shorter the TTL, the more misses; and a TTL does not "fix" anything, it only bounds how long the damage lasts. That is why it is the last layer, not the only one.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (deterministic simulation; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-10.1-consistent-hashing/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.1-consistent-hashing) - `npm install`, then `npm run rebalance`, `npm run vnodes`, `npm run cache`, `npm run compare`. The full setup, acceptance criteria and experiments are in the `README.md` there.

A hash ring (virtual nodes, weights, and three rules for choosing replicas), and alongside it `hash % N`, rendezvous hashing and jump hash - all behind the same `Router` interface. `rebalance` counts how many keys move when a node is added or removed, where they go, and who takes a dead node's load. `vnodes` shows the number of virtual nodes versus how even the split is, weights, and the three replica rules side by side on 6 nodes / 3 AZs. `cache` runs TaskFlow's story - 3 to 4 nodes on a warm cache, and how many DB queries in the first second; then how many stale reads when a node comes back with old data after 30 seconds away. `compare` puts the three methods side by side, and finally hot keys and bounded load on Zipf traffic.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` and ESLint clean; the four scripts **three times each**, with output identical every time (compared byte for byte). There is **no real Redis or network** here - the cache nodes are `Map`s in the same process, and a "request" is a function call; so no time was measured anywhere, and every number is **counted** (how many keys moved, how many hits, misses, stale reads). "First 1 second" means the first 5,000 requests (assuming `RPS=5000`), not wall-clock time. The cache has no memory limit, TTL or eviction, and every key is assumed warm before the change - so every miss is caused only by the routing change; a real cache already has some misses. Bounded load is a simplified form (each batch of 1,000 requests is treated as "running concurrently"); a real implementation counts in-flight connections. Jump hash is written with `BigInt`, so its speed here is meaningless - only the steps are counted. **Not measured:** lookup latency over a real network; the time to move data (streaming, writing to two places); two node lists running side by side during a rolling deploy (1.9 and question 3 - reasoning, not run); Maglev; and the loss of quorum by AZ (the "~25%" in question 2 is an estimate). The ketama and Cassandra figures in 1.3, and the Vimeo/HAProxy remarks in 1.8, come from their published writing and documentation - not verified here, and Cassandra's default differs by version. TaskFlow's decision in 1.10 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `rebalance`, write down - going from 4 to 5 nodes with `hash % N`, what % will move, and what % of the moved keys will go to the new node? Then the same for a ring without virtual nodes. Compare them, and write one line on why the "among old nodes" column was (or was not) in your prediction.

2. **The accounting of virtual nodes:** `VNODES=10 npm run rebalance`, then `VNODES=1000`, and put the `vnodes` table next to them. How many virtual nodes would you choose for your 10-node cache? Base the decision on three things - how many x the heaviest node can tolerate, how many nodes a dead node's load spreads across, and how many clients the ring must be sent to, and how often.

3. **The trap of traffic shape:** `ZIPF=0.5 npm run cache`, then `ZIPF=1.2`. How do the first-second hit rate and DB queries change? Now think: in TaskFlow's staging, 20 testers open a handful of workspaces over and over. What will a node-add test in staging show, and why is that false reassurance for production?

4. **The bounded load trade-off:** `FACTOR=1.1 npm run compare`, then `FACTOR=2`. Write down the "heaviest" and "off its own node" columns. Now, for two different backends, say which factor you would choose: (a) TaskFlow's WebSocket servers (2.4), where connections are routed by workspace purely for locality, (b) TaskFlow's cache.

5. **The design part:** a one-page plan for moving TaskFlow's cache to Redis Cluster: (a) which keys are read together, and what their hash tags will be - and what new problem appears if all of one workspace's keys sit in one slot (remember 1.8); (b) during the migration, with the old ring and the new cluster running side by side - where reads come from, and where invalidations go; (c) a runbook for adding nodes - when, in how many steps, and which number you watch before the next step; (d) what happens when a node becomes unreachable and then returns (with Redis Cluster's replicas and failover); (e) three numbers for the dashboard, and the alert value for each.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges)
Current: 10.1 - Consistent Hashing deep dive
TaskFlow state: modular monolith (work, identity, files, search) + files processing + billing service;
gateway + web/mobile BFF (9.2); "create task" = orchestrated saga (9.3); breaker + bulkhead (9.4);
rate limits in two layers, a separate Redis for the limiter (9.5); the cache had been split across 3
Redis instances with `hash % N` - on the day a 4th node was added, ~2,000+ extra DB queries in the first
second, site nearly unusable; now a ring with 160 virtual nodes (a tested library), nodes added only
slowly (from weight 0.25, in 15-minute steps) and outside busy hours, single-flight in front of every
miss; node list from the registry, with a version (not an env var); removed from the ring after 3 failed
checks within 30 s, FLUSHALL before returning; a 5-minute TTL on every cache key; a 2 s local cache in
the app for hot boards (not bounded load - there is a cache behind it); long term, Redis Cluster (hash
slots, slots moved with their data, MOVED), hash tag {workspace:<id>}; dashboard: per-node hit rate,
busiest node ÷ average, DB queries/s in the 60 s after a membership change
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot
Weak spots: [where you got stuck - write it yourself]
Next: 10.2 - Bloom Filter, HyperLogLog (probabilistic data structures)
=======================
```

---

## 8. Next Step

Today's thread was: **an innocent-looking decision - "which node does a key go to" - determines the system's worst moments.** The day a node is added, the day a node dies, the day a node returns, and the ten minutes of a deploy. Consistent hashing lowers the cost of the first two; the rest take membership, flushing, TTLs and patience. And one lesson carried over from 9.5: do not judge an algorithm by a pretty number like "what % moved" - the question is always **what the system behind it feels at that moment**.

When you are ready, write `next` - we go to **Lesson 10.2: Bloom Filter and HyperLogLog**. Today we used a hash to decide **where** data lives; next we use a hash to answer questions where keeping the data is not even possible - "has this username been taken before?" among billions of names, in a few MB of memory; and "how many distinct users opened a board today?" without remembering each one. Both cost a small, measurable chance of error - and which direction that error goes is the whole design.
