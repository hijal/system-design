# Lesson 10.3 - Fault Tolerance, Graceful Degradation, Chaos Engineering

**Module 10 - Reliability, Security & Operations**

> **Spaced Repetition (Lesson 2.5):** Why is an `Idempotency-Key` header sent with a `POST` - when does the client send the request again with the same key, and what does the server do when it recognizes it? In today's matrix you will see a symbol, `✗!` - "the write happened, but the user saw an error". Keep in mind what the user does at that moment, and what follows if 2.5's key is missing.

**Prerequisite:** Lesson 1.5 (Availability, error budget), Lesson 1.6 (SPOF), Lesson 4.4 (Fail-safe cache), Lesson 7.4 (Retry storm, load shedding), Lesson 7.5 (Outbox), Lesson 8.1 (Failure domain), Lesson 9.4 (Circuit breaker, bulkhead, fail fast), Lesson 10.2 (Fail open)

**By the end of this lesson you will be able to:**

1. Separate the **hard and soft dependencies** of every user journey in a system, compute a journey's availability from their product - and say why the redundancy formula (`1 − (1 − a)^k`) is often wrong by a factor of thousands in practice
2. Design the degraded state before the failure - which part gets dropped, which shows old data, which happens later, which says plainly "not now"; protect the core work under load with a **brownout**; and design how the data plane stays **statically stable** even when the control plane dies
3. Plan a chaos experiment - steady state, hypothesis, **blast radius**, abort conditions - and say with numbers why, with a small blast radius and no control group, a bug simply goes unnoticed

**Tier:** 1 - Runnable Code (five deterministic simulations - dependency matrix, redundancy, brownout, static stability, chaos experiment; no Docker needed)

---

## 0. Where TaskFlow Is Right Now

After 10.2, share links have a Bloom filter in front of them, and active users are counted with HyperLogLog. Since Module 9 one small thing has quietly grown inside TaskFlow: **feature flags** (9.1). A small internal service, `flags`, one instance - every app instance fetches flag values from it ("is the new activity panel on in this workspace?") and caches them for 5 minutes. Nobody ever put it on the on-call list. Why would they - it does not do the core work of any feature.

**Saturday, 2:10 a.m.** `flags`'s disk filled up with its own logs. The service died.

- **2:10 – 2:15:** Nothing happened. Every instance had its 5-minute cache.
- **2:15:** Every instance's cache expired **at the same moment** - because they all refreshed on the same rhythm (every 30 seconds), and their last successful refresh happened at the same time. After that, any request that read a flag threw an exception. Opening a board, login, search, creating a task - **all** 500. For customers in Australia and Japan it was Monday morning.
- **2:30:** The on-call engineer's first suspicion was the app itself. They restarted the instances. A new instance pulls flags at boot - fails to get them, crashes. Kubernetes starts it again, it crashes again. Now there are no app instances either.
- **2:55:** Someone remembered `flags`. Disk cleaned, service running, everything fine at 3:00. 50 minutes in total - for a service that "does not do the core work of any feature".

**Monday, 9 a.m.** A big customer (2,000 seats) joined TaskFlow that day, along with the Monday-morning standup rush. Board-opening traffic was 2.5 times normal. Last week a new panel had shipped - **"More boards like this"** - which runs a few expensive queries on every board open. Within two minutes every board request was timing out. At 9:08 the rush eased - but the site did not recover, because the work piled up in the queue was not finishing. At 9:14 an engineer turned off the new panel's flag by hand - and within three minutes everything was normal. It was the right move, but it took one person, fourteen minutes, and luck.

In the postmortem the CTO wrote three questions:

1. "How many things does TaskFlow depend on - and when one dies, **which** feature dies?" Nobody could answer. `flags` was not on any list.
2. "When something breaks, what state do we want to be in - is that decided in advance, or do we decide at 2 a.m.?"
3. "And how will we know that whatever we design actually works? By waiting for the next outage?"

---

## 1. Theory

### 1.1 Fault and Failure - where the chain will break

Saturday's incident happened in three steps, and the steps have separate names:

```
fault                     error                           failure
─────                     ─────                           ───────
flags's disk full    →    exception reading a flag   →    user sees a 500
(a defect in one part)    (wrong state inside the system)   (what the user got breaks the promise)
```

**Fault Tolerance** - the ability to keep a defect in one part of the system (a **fault**) from reaching the user as a visible failure (a **failure**); faults cannot be prevented, but the chain from fault to failure can be broken somewhere.

There are several places to break the chain, and you have seen some of them in earlier lessons:

- **Hide the fault itself** - when one copy dies, another does the work (removing 1.6's SPOF, 5.7's replica, 3.4's failover). This is redundancy, and in 1.5 you will see how optimistic its formula is.
- **Contain the error** - timeouts, circuit breakers, bulkheads (9.4). The error stays in one place and does not spread.
- **Make the failure smaller** - drop one part instead of the whole page, an old answer instead of a wrong one. This is **graceful degradation** (1.4).

Why this distinction matters: 1.5's availability is a **measurement** - how much of the time the user got an answer as promised. Fault tolerance is a **property of the design** - faults will come; the question is how many of them become failures. On Saturday night the fault was small (one disk) and the failure was total (the whole site). The distance between them is entirely down to design.

### 1.2 The Dependency Matrix - which one dies when which dies

The direct way to answer the CTO's first question: kill each dependency one at a time and run every user journey. The exercise's `npm run matrix` does exactly that - TaskFlow's seven journeys (`src/journeys.ts`) are real TypeScript functions, and a harness makes each dependency "dead" (connection refused immediately) and runs every journey. The table is not written by hand; it is **discovered** by running the code:

```
── A. One dependency dead (connection refused) - old code ──
dead dependency          login       board  create-task     comment      search      upload  share-link
pg-primary                   ✗           ✓           ✗           ✗           ✓           ✗           ✓
pg-replica                   ✓           ✗           ✓           ✓           ✗           ✓           ✓
redis-cache                  ✓           ✓          ✗!           ✓           ✓           ✓           ✓
redis-limiter                ✗           ✓           ✓           ✓           ✓           ✓           ✓
redis-queue                  ✓           ✓           ✓          ✗!           ✓           ✓           ✓
billing                      ✓           ✗           ~           ✓           ✓           ✓           ✓
flags                        ✗           ✗           ✗           ✗           ✗           ✗           ✗
object-storage               ✓           ✓           ✓           ✓           ✓           ✗           ✓
email                        ✓           ✓           ✓           ✓           ✓           ✓           ✓
```

(`✓` = fine, `~` = ran with something dropped, `✗` = failed, `✗!` = the write happened but the user saw an error)

**Hard Dependency / Soft Dependency** - a journey's **hard** dependency is one without which the journey fails; a **soft** dependency is one without which the journey still runs, just with something dropped or somewhat worse. The same dependency can be hard for one journey and soft for another - and that is decided by the **code**, not by the dependency itself.

Five things to read from this table:

1. **`flags`'s whole row is ✗.** The most "unimportant" service is a hard dependency of every one of the seven journeys. Because the code looks like this: `const enabled = await flags.get('activity-panel')` - no default, no try. The flag itself controls a soft thing (whether to show a panel), but the way it is **read** made the whole page hard. Saturday night.
2. **`billing` is a hard dependency of the board.** Opening a board talks to billing to show the plan badge ("Pro"). In 9.4 the goal "the board opens even if billing is dead" was written down and a bulkhead installed - but later someone added this badge without knowing about that goal. A rule nobody tests erodes within months.
3. **The two `✗!` - the most dangerous cells.** The create-task code: write to the DB, commit, then invalidate the cache (`redis-cache`). If the cache is dead, the invalidation throws an exception - **after the commit**. The user sees "something went wrong", presses again, and now there are two identical tasks. The comment code likewise enqueues a job directly after the commit. 2.5's idempotency key would save the user here (the second press would be recognized), but the real disease is making an unnecessary post-commit step hard. It is another face of 7.5's dual write.
4. **`email`'s whole row is ✓.** No user-facing journey waits for email - since 7.1, email has been a background job. Async here directly means fault tolerance: if the provider dies, email goes out late, and nobody fails.
5. **`redis-limiter`'s ✗ on login is deliberate.** 9.5's decision: if the limiter dies, login fails closed - a few minutes without login beats opening the door to brute force. A `✗` is not always a bug. The matrix's job is to turn every `✗` into a **decision**, not an accident.

### 1.3 The arithmetic of the product

Now the numbers side of the CTO's question. A journey runs if **all** of its hard dependencies are alive at the same time. If they die independently:

```
journey availability = a₁ × a₂ × a₃ × …        (hard dependencies only)

board (old code):  flags × replica × billing = 0.995 × 0.999 × 0.999 = 99.301%
```

`npm run matrix`, part D - simulate 10 years, killing each dependency at random times according to its availability, and run every journey every minute:

```
journey        hard dep (old)   formula   old code  down/year   hard dep (new)    worked   in full  down/year
login                       3   99.351%    99.368%  3,320 min                2   99.861%   99.861%    731 min
board                       3   99.301%    99.300%  3,680 min                0  100.000%   99.791%      0 min
create-task                 3   99.351%    99.353%  3,399 min                1   99.948%   99.733%    274 min
comment                     3   99.351%    99.346%  3,440 min                1   99.948%   99.948%    274 min
search                      2   99.401%    99.412%  3,093 min                1   99.904%   99.904%    505 min
upload                      3   99.440%    99.438%  2,952 min                2   99.931%   99.931%    360 min
share-link                  1   99.500%    99.507%  2,592 min                0  100.000%  100.000%      0 min
```

- **The formula and the simulation match almost exactly** (board: 99.301% versus 99.300%). The product is not a theoretical guess - with independent failures, this is what happens.
- **With the old code the board is down 3,680 minutes a year - 61 hours.** And yet none of its dependencies is below 99.5%. Every new hard dependency **multiplies** availability down; it does not subtract. Ten hard dependencies at 99.9% each - the journey is 99.0%, a two-nines thing built from good parts.
- **With the new code the board has zero hard dependencies** - it was never fully down, but the "full" column is 99.791%: ~1,100 minutes a year something was dropped (the badge, comment counts, the panel). Degradation does not erase failure; it breaks it into small pieces.

The most practical rule from here: **the cheapest way to raise availability is often not making dependencies more reliable, but removing hard dependencies from the journey.** Taking `flags` from 99.5% to 99.99% would need replication, on-call and monitoring. Making it soft needs a default and a try.

(An honest caveat: this simulation only has these nine dependencies. The gateway, the network, DNS and the app itself are left out. So "100.000%" means "the board never broke in any single or combined outage of these nine", not TaskFlow's overall availability. And the dependencies are assumed to die independently - in 1.5 you will see where that assumption breaks.)

### 1.4 Graceful Degradation - deciding "bad but running" before it breaks

**Graceful Degradation** - when a dependency dies or slows down, running in a state decided in advance that does less but still works, instead of failing the whole task; what gets dropped and what the user sees are designed before the incident.

The rows that changed in the new code's matrix (`npm run matrix`, part B):

```
── B. One dependency dead - code written with degradation in mind ──
dead dependency          login       board  create-task     comment      search      upload  share-link
pg-replica                   ✓           ~           ✓           ✓           ✗           ✓           ✓
redis-cache                  ✓           ✓           ~           ✓           ✓           ✓           ✓
redis-queue                  ✓           ✓           ✓           ✓           ✓           ✓           ✓
billing                      ✓           ~           ~           ✓           ✓           ✓           ✓
flags                        ✓           ✓           ✓           ✓           ✓           ✓           ✓
```

Behind each `~` is a different kind of fallback, and the list is worth keeping in your head, because each has a different cost:

| Fallback                  | In TaskFlow                                                                                                               | Cost                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Drop it**               | Billing dead → hide the plan badge; replica dead → no comment counts and no activity panel                                | The user sees a little less; most likely nobody notices                                          |
| **Old data**              | Flags dead → last known value (1.7); cache invalidation failed → an old board for ≤ 5 minutes (10.1's TTL)                | It can be wrong - how stale is acceptable has to be decided per data type (6.5's consistency)    |
| **Alternative path**      | Replica dead → board and share link read from the primary                                                                 | Load on the alternative - a concurrency cap on this path to protect the primary (9.4's bulkhead) |
| **Do it later**           | Billing dead → the task is created, quota is `quota_pending` (9.4); the comment email goes to the outbox (7.5)            | Rules are softened for a while and reconciled later (a reconcile job)                            |
| **Say "not now" plainly** | Replica dead → "search is unavailable right now" in search, the rest of the app runs; no fallback for plan upgrades (9.4) | The user cannot do one thing - but they know why, and everything else works                      |

Notice that search's `✗` is still there in the new code. When the replica dies, search could be sent to the primary - but full-text search is an expensive query (8.3), and the primary is handling task writes at that moment. Sinking the core write path to save an optional feature would be spreading the fault. **Which things degrade and which get switched off plainly is a joint decision of product and engineering**, and the answer comes from "which task really matters to the user".

**Slow is worse than dead.** Part C of the matrix is the same table, but the dependency is not dead - it answers in 3 seconds:

```
── C. One dependency slow (answers in 3 s) - old code ──
slow dependency          login       board  create-task     comment      search      upload  share-link
redis-cache                  ✓        3.0s        3.0s           ✓           ✓           ✓        3.0s
redis-limiter             3.0s        3.0s        3.0s        3.0s        3.0s           ✓           ✓
flags                     3.0s        3.0s        3.0s        3.0s        3.0s        3.1s        3.0s
```

When `redis-limiter` is dead, nothing happens to the board (fail open - 9.5). But when it is **slow**, five journeys are stuck for 3 seconds, because the fail-open code is a `try/catch` - and to reach the `catch`, an exception has to arrive first. A slow dependency throws no exception; it just makes you wait. In the same way, a slow `redis-cache` holds the board up for 3 seconds, even though the entire point of the cache was to make the board fast.

The new code puts a timeout on every call (cache and limiter 50 ms, replica 300–500 ms, billing 150 ms), and in part C2 every cell in these rows is back to ✓ or ~ - only login's cell with a slow limiter is `✗`, but that is 9.5's deliberate fail closed, now in 50 ms instead of 3 seconds. The rule from here: **a soft dependency without a timeout is, in terms of latency, a hard dependency.** The exercise's experiment 6: remove just billing's `150` timeout from the new code, and with a slow billing the board is back to 3.0 s. In 9.4 the timeout came as part of the breaker; here is its more fundamental job - **opening the door to the fallback.** Without a timeout, no fallback ever runs.

### 1.5 Redundancy and the formula's sleight of hand

The first way to break the chain - hide the fault by keeping copies. The arithmetic from 1.6: if one instance's availability is `a`, then with `k` copies it is enough for any one to survive, so:

```
availability = 1 − (1 − a)^k

a = 99.931% (dies once every 30 days on average, back in 30 minutes)
k = 1  →  365 minutes down per year
k = 3  →  0.011 seconds down per year
```

Three copies, and a hundredth of a second a year - practically indestructible. Now `npm run redundancy` - the billing service, simulated over 40 years, with three kinds of fault: an instance dies (on average once every 30 days), a whole AZ (availability zone - a group of data centres, 8.1's failure domain) dies half a time a year for two hours, and three deploys a week, 3% of them bad:

```
design                          formula down/year   measured   failed min/year  instance      AZ   deploy  full outage
1 instance                                365 min    99.905%               497       343      82       72     461 min
3, same AZ, deployed together              0.011 s    99.970%               160         6      82       72     117 min
3, 3 AZs, deployed together               0.011 s    99.985%                78         6       0       72      35 min
3, 3 AZs, one at a time                   0.011 s    99.992%                43         6       0       37       0 min
```

- **The formula says 0.011 seconds, the measurement says 160 minutes** - almost 900,000 times more. The formula handled instances dying individually just fine (343 → 6 minutes). But the other two causes kill the three copies **together**: when the AZ dies, all three are in it, and a bad deploy goes to all three at once.
- **The formula's hidden condition: the failures are independent.** Redundancy only works against independent failures. Whatever the copies **share** - the same rack, the same AZ, the same power, the same config, the same code version, the same dependency - is a source of correlated failure, and there k = 3 means k = 1.
- **Spread across three AZs and the AZ column goes to zero** - 8.1's failure domain idea, here for a service.
- **The biggest remaining source is deploys.** A new version on every instance at once means one bug on every instance at once. Deploy one at a time (watching for 10 minutes between each) and a bad version has a chance to be caught while it is still on the first instance: 72 → 37.

An often-quoted observation from Google's SRE book: roughly 70% of outages come from **changes** to a live system (not verified here). In the simulation too, the biggest correlated fault is not hardware, it is deploys. That is why the whole of 10.6 is about deploys.

And one more caution, from the exercise's experiment 4: deploying one at a time is **not always** safe. `QUIET_DETECT=60` - if it takes 60 minutes to catch a "quiet" bug (it does not crash, it just gives some wrong answers), the deploy gradually reaches all three instances anyway, and the damage rises to **147** minutes - more than deploying together, because there a total breakage screams loudly and gets caught fast. The benefit of spreading slowly depends entirely on **being able to catch it before it spreads**. Without a way to catch it, a slow deploy just spreads the damage slowly.

### 1.6 Under load - Brownout

Now Monday morning. No dependency died here; the problem is **your own capacity**. `npm run brownout` - 48 workers, a normal 600 req/s, at 9 a.m. 2.5 times that (1,500 req/s) for seven minutes, and clients leave after 3 seconds. The worker time for one full board page:

```
full page = task list 8 ms + comment counts 5 ms + activity panel 12 ms + "more boards like this" 25 ms = 50 ms
capacity: 960 req/s with the full page; at the brownout levels 25 ms → 1,920 req/s, 13 ms → 3,692 req/s, 8 ms → 6,000 req/s
```

At full page the capacity is 960 req/s, and 1,500 arrived. But the core work - the task list - is only 16% of the total cost. What happened to the requests that arrived during the seven minutes of load:

```
policy                  got board  full page      503   timeout       p50       p99  wasted work  recovery after load
nothing                      0.0%       0.0%     0.0%    100.0%         -         -      100.0%  not even in 15 minutes
+ deadline check            34.1%      34.1%     0.0%     65.9%    2.99 s    3.00 s       59.1%          immediately
load shedding (7.4)         64.0%      64.0%    36.0%      0.0%    348 ms    373 ms        0.0%          immediately
brownout                   100.0%       2.9%     0.0%      0.0%     18 ms    360 ms        0.0%          immediately
brownout + shedding         99.7%       3.1%     0.3%      0.0%     18 ms    315 ms        0.0%          immediately
```

**Nothing:** nobody got a board. Zero. And it does not recover even after the load is gone - until the 15-minute run ended, nobody got an answer in time. Why: about a hundred thousand requests piled up in the queue, the workers are finishing them in order - and each one's client left long ago. **Wasted work 100%**: every worker moment spent on a request whose answer nobody will read. This is Monday's "the rush eased at 9:08, but the site did not recover."

**Deadline check:** check before starting the work - "is this request's client still waiting, and will the work finish in the time remaining?" If not, drop it. One line of code, and after the load it returns to normal immediately - nobody does the piled-up dead work any more. (Its larger form is called **deadline propagation** - sending the client's time limit along with every internal call, so that even a fourth-layer service knows when to stop; it is built into gRPC.) But during the load it is not enough on its own: a FIFO queue sits right at the edge of the limit - those who get an answer get it at a p50 of 2.99 s, and the ones that start at the edge and finish past the limit are still wasted (59%). (Facebook's "Fail at Scale" article has one answer to this - make the queue LIFO under load and keep queue waits short; not measured here.)

**Load shedding (7.4):** once the queue wait passes 300 ms, new requests get a 503 immediately. Now those who get an answer get it fast (p99 373 ms), and no work is wasted. But **36% of users get nothing.** Shedding accepts the capacity limit and decides who is left out.

**Brownout - everyone got a board, 100%.** p50 18 ms.

**Brownout** - when load rises, automatically switching off the **optional parts** of each request to lower the cost per request, so that the same capacity can give everyone the core work; when the load falls, the parts come back.

Load shedding and brownout are two answers to the same problem, and the difference is which dimension gets reduced:

```
capacity = number of requests × cost per request

load shedding:  reduce the number  →  some get nothing, the rest get everything
brownout:       reduce the cost    →  everyone gets something, nobody gets everything
```

Brownout's levels minute by minute (`npm run brownout`, part B) - 0 means the full page, 3 means just the task list:

```
minute     req/s  avg level  brownout p99  nothing: p99  nothing: on time
2            598      0.00         74 ms         74 ms           100.0%
3          1,048      0.84        187 ms        2.90 s            63.4%
4          1,495      1.49        350 ms             -             0.0%
7          1,500      1.47        348 ms             -             0.0%
11         1,052      0.97        235 ms             -             0.0%
12           603      0.00         74 ms             -             0.0%
```

The controller is simple: every second, if the average queue wait is over 50 ms, go up a level; after 10 quiet seconds, go down a level. During the rush the average level is ~1.45 - "More boards like this" is off almost the whole time, the activity panel now and then. And when the rush goes, it returns to level 0 by itself, and the full page comes back. Nobody stayed up all night, nobody went looking for a flag.

Three honest limits:

- **"Full page" is only 2.9%.** There was capacity to give 64% of users the full page, but this controller changes the level for everyone at once - everyone gets a bit less. A finer controller would switch parts off for a **fraction** of requests. And the level oscillates (0 ↔ 1 ↔ 2) - the 360 ms p99 is the price of that oscillation. In experiment 3, a threshold of 200 ms gives more users the full page (5.2%), but the p99 is 717 ms.
- **Brownout has a floor.** Even with just the task list the capacity is 6,000 req/s. Experiment 2: `PEAK=12` (7,200 req/s) - brownout alone serves 49.5% of users in time, the rest time out; brownout + shedding 83.3%, the rest get a fast 503. So the two tools are not alternatives - **brownout is the first layer, shedding the last net.**
- **What is optional has to be decided in advance.** "More boards like this" can be switched off because someone knows it is optional - on Monday morning that is exactly what one person did by hand, fourteen minutes late. A brownout is writing that decision into code in advance.

(The term brownout became popular for cloud applications from a 2014 study - "Brownout: building more robust cloud applications", Klein and colleagues; the name comes from running electricity at "reduced voltage". Not verified here.)

### 1.7 Static Stability - when the control plane dies

Now Saturday night, through a design lens. `flags` does not handle any user request directly; it tells the others **how** to run. These two kinds of component have names:

```
control plane  -  says what to do, changes now and then
                   flags, config, service registry (10.1), Kubernetes API, etcd (for Patroni)
data plane     -  handles the actual requests, every moment
                   app instances, Postgres, Redis, gateway
```

Saturday's root mistake: **every data plane request depended on the control plane.** And yet the control plane's job is to bring occasional changes - the flag had last changed three days earlier. Without it, new changes will not arrive, but the old values were perfectly fine.

**Static Stability** - the property of a system whereby, even if its control plane (config, flags, registry, orchestration) dies, the data plane keeps running the same way in its last known state - unable to **change** anything new, but able to **keep running** what was running, including restarts and bringing up new instances.

`npm run static` - `flags` dead from minute 30 to 75; from minute 50 to 80 traffic goes from 600 to 1,000 req/s (the autoscaler brings up new instances); and instances crash and restart now and then. Four designs:

```
design                        failed requests        worst minute  short minutes  failed boots         config age (max)
ask on every request                   44.05%              100.0%            45             0                        -
cache, TTL 5 minutes                   40.82%              100.0%            40           463                5 minutes
last-known-good                        12.08%               50.0%            25           463               45 minutes
last-known-good + snapshot              0.24%               20.0%             1             0               45 minutes
   in this run: 9 crash/restarts, the autoscaler brought up 6 new instances; failed requests = % of the total over all 120 minutes
```

- **Ask on every request:** everything fails for the full 45 minutes of the outage.
- **TTL cache (TaskFlow's actual design):** buys just 5 minutes, then everyone dies together - exactly Saturday's 2:15. The problem is the rule "when the cache expires and you can't get a new value, error", not the length of the TTL. Experiment 1: with a 30-minute TTL the damage is 22.96% - less, but in a 45-minute outage the last 15 minutes fall into the same pit.
- **Last-known-good:** if you can't get a value, keep running the old one, however old. The running instances survived - but still 12%. The reason is in the second-to-last column: **463 failed boots.** A crashed instance and the autoscaler's new instances have no "last known value" - they are being born in the middle of the outage. They need flags at boot, can't get them, crash, try again 30 seconds later - Saturday's 2:30 crash loop. And exactly at the rush (minute 50) capacity was needed, but new instances could not come up.
- **Last-known-good + snapshot:** after every successful fetch, write the values to disk (or into the image at deploy time); at boot, if the control plane is unreachable, start from the snapshot. Zero failed boots, 0.24% failed requests - and that 0.24% comes from the autoscaler's one-minute boot time, which all four designs share.

**The cost, honestly - the last column:** last-known-good means the config is **45 minutes old** for the whole outage. Usually that is no problem - flags change once every three days. But one thing is lost: **the kill switch.** Say a new feature is misbehaving during the outage and you want to switch it off with a flag - you can't, because the very tool for changing flags is dead. Static stability means "able to run even when unable to change" - and of the two, the first is what you give up. So for important kill switches it is good to keep a separate, simple path (say an environment variable, changeable through a deploy).

This idea hides in a few more places in TaskFlow, and the most dangerous one is from Module 5: **Patroni + etcd.** Patroni keeps the primary as primary by holding a lease in etcd (6.1, 6.2). According to Patroni's documentation, if it cannot reach etcd, Patroni assumes it may be on the wrong side of a partition and **makes the primary read-only itself** - to avoid split brain. In other words, an outage of etcd (the control plane) stops all of the database's writes (the data plane), even though Postgres itself is perfectly healthy. Newer versions have a `failsafe_mode` for this - if the primary can talk directly to all the other Patroni members, it stays primary without etcd (not verified here; check your version and settings). 6.1's fear of split brain and today's need for static stability meet head-on here - and this is exactly the kind of trade-off you need to know in advance, not at 2 a.m.

(The term static stability is known from an article in Amazon's Builders' Library - "Static stability using Availability Zones"; the example there is EC2: when the control plane dies you cannot launch new instances, but running instances keep running. Not verified here.)

### 1.8 Chaos Engineering - why break things on purpose

Now the CTO's third question: how will we know the new design works?

The matrix came from running code in the exercise. But production code is not exercise code. Production has real timeouts (which someone may have left at an ORM's default), real retries (hidden inside a library), real config, and dependencies nobody wrote on a list - just like `flags`, or the board's plan badge. Code review does not catch these, because each one looks harmless on its own. They are caught when the dependency really dies.

So there are two paths: wait for it to die by itself (Saturday, 2 a.m., nobody ready), or **kill it yourself** - Tuesday, 2 p.m., everyone in the office, rollback ready, on a small scale.

**Chaos Engineering** - deliberately and in a controlled way injecting faults into a production system (killing a dependency, slowing it, cutting the network) to test whether the system holds its normal behaviour (**steady state**); the goal is to find weaknesses before users do.

It is not "breaking random things to see". It is an experiment, in the scientific sense:

1. **Define the steady state** - a measurable number that means "the system is fine", in business terms: board-open success 99.95%, p99 300 ms. Not CPU or memory - what the user is getting.
2. **Write a hypothesis** - "if billing slows by 2 seconds, board-open success stays above 99.9%, p99 below 400 ms, and only the plan badge is hidden." This is one cell of the matrix, now stated as a claim about production.
3. **Inject the fault, on a small scale** - not on all traffic, on a fraction (1.9).
4. **Compare, and write the stopping rule in advance** - if the steady state breaks, the experiment stops immediately, automatically.
5. **Fix what you find, then run the experiment regularly** - a design that passed once breaks the next month as soon as someone adds a badge (the lesson of 1.2).

These steps are the core of "Principles of Chaos Engineering" (principlesofchaos.org), written by engineers at Netflix: hypotheses around the steady state, faults that resemble real events, running in production, running automatically and regularly, and **keeping the blast radius small**. Netflix's Chaos Monkey (which became public on their blog around 2011) killed random instances in production - so that every team's code was **forced** to tolerate losing instances. (From Netflix's own published writing; not verified here.)

Why production, not staging? In staging the traffic is fake, the data is small, the config is different, and dependencies behave differently - a weakness like `flags` may or may not be there. Starting in staging is reasonable (the big mistakes get caught cheaply there), but only production knows production's truth. And because production has real users, the next part - how many users you are putting at risk - is the centre of the whole method.

There is a low-tech form too: the **game day** - on a scheduled day the team injects a fault together (say "today at 2 we shut down the replica"), and everyone watches what the system and the **people** do - whether alerts arrive, whether the runbook works, whether the on-call engineer looks in the right place. On Saturday, the people failed alongside the code (the restart, nobody looking at `flags` for 25 minutes) - a game day tests that too.

### 1.9 Blast Radius - how many people you are putting at risk

**Blast Radius** - the maximum extent a fault (deliberate or accidental) can affect - what % of traffic, how many users, how many services or regions; in a chaos experiment it is deliberately kept small, and keeping it small in the design (cells, AZs, bulkheads) is one of the goals of fault tolerance.

Say the board's code still has a hidden hard dependency (1.2's plan badge). A 2-second delay is being injected into billing. What % of traffic do you inject it into? `npm run chaos` - 500 req/s, a normal error rate of 0.05%, stopped two ways: a **global alarm** (stop if the whole site's errors over the last 60 seconds exceed 0.2% - an ordinary SLO alert), and a **control group** (keep an untouched group the same size as the experiment, and stop when the difference in errors between the two groups is statistically clear). Each condition 200 times, median:

```
── A. A loud bug - 60% of injected requests fail (plan badge on every paid board, no timeout) ──
blast radius     global: caught      when     harm  control: caught      when     harm
0.1%                     3%      10 s      540         100%      30 s        8
1%                     100%      10 s       29         100%      10 s       29
5%                     100%      10 s      149         100%      10 s      149
100% (all)                 100%      10 s    2,997                -         -        -

── B. A subtle bug - 5% of injected requests fail (only on boards with 500+ tasks) ──
blast radius     global: caught      when     harm  control: caught      when     harm
0.1%                         0%         -       45             100%   6.2 min        9
1%                       2%      10 s      447         100%      40 s       11
5%                     100%      10 s       14         100%      10 s       14
25%                    100%      10 s       61         100%      10 s       61
100% (all)                 100%      10 s      250                -         -        -
```

("Damage" = user requests that failed because of the fault before it was stopped; if not caught, over the full 30 minutes.)

- **Damage grows directly with the blast radius.** With the loud bug, 1% → 29 failed requests, 100% → almost 3,000 - even though both are caught in the same 10 seconds. A big blast radius does not catch a bug faster (both were caught at the first check), it just means more people see it.
- **But at a small blast radius the global alarm is blind.** The subtle bug at 0.1%: the whole site's errors go from 0.05% to ~0.055% - noise to any alarm. It ran for 30 minutes, nobody knew, 45 users failed. Even at 1% it went uncaught in 98% of runs, with 447 failures.
- **A control group makes a small blast radius observable.** Compare the 0.1% group with another 0.1% group and the difference no longer drowns in noise - the subtle bug is caught in 6.2 minutes, with 9 damaged requests. The same bug run directly at 100% does 250.

So the shape of the decision: **start small, but when you start small keep a control group to compare against.** The published design of Netflix's ChAP (Chaos Automation Platform) is like this - experiment and control, two small, equal groups (not verified here). And sending a particular share of traffic to the "experiment" requires a routing tool - 9.2's gateway canary routing is exactly that.

**And the opposite mistake - stopping for no reason.** The same experiment, but the code is fine (the fault is harmless):

```
── C. The code is fine, the fault harmless - yet stopped by mistake, in what % of runs ──
blast radius    global: false stop  control: false stop
1%                          0.0%               0.0%
5%                          0.0%               0.5%
50%                         0.0%               1.5%
```

The control-group method occasionally (0.5–1.5%) stops by mistake, because it looks again every 10 seconds - 180 times in 30 minutes - and every look is a new chance to mistake noise for signal. Experiment 5: lowering the z threshold from 3 to 2 raises false stops to 8–22%. With 50 experiments running a week, that is several false alarms a week - and false alarms eat the team's trust, until someone starts ignoring the aborts. **There is a tension between sensitivity and false alarms, and the threshold has to be chosen deliberately.** (Statistics has "sequential testing" methods for this problem of repeated looks - not measured here.)

### 1.10 TaskFlow's decision

> **Trade-off Table - the tools of fault tolerance**

| Tool                             | Against which fault           | Measured (exercise)                                       | Cost                                                                    |
| -------------------------------- | ----------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Hard → soft dependency           | A part dead or slow           | Board fully down 3,680 → 0 minutes/year                   | Designing and testing every fallback; does not work without timeouts    |
| Redundancy (copies)              | Independent failures          | From instances 343 → 6 minutes/year                       | Almost nothing against correlated failures (AZ, deploy)                 |
| Spreading across failure domains | Shared risk like an AZ        | From the AZ 82 → 0                                        | Network latency and cost between AZs (10.7, 10.8)                       |
| Slow deploys                     | A bad version                 | From deploys 72 → 37 (if caught); 147 if not              | Slower deploys; the benefit rests entirely on catching it fast          |
| Brownout                         | Load beyond your own capacity | Got board 0% → 100%                                       | Nobody gets the full page; optional parts must be identified in advance |
| Load shedding                    | Load below brownout's floor   | 64% get an answer, fast                                   | The rest get nothing                                                    |
| Static stability                 | Control plane dead            | 44% → 0.24% failed                                        | Nothing can be changed during the outage (including kill switches)      |
| Chaos experiment                 | Weaknesses nobody knows about | 0.1% + control: subtle bug in 6.2 minutes, with 9 damaged | Real risk in production; false aborts; the team's time                  |

**Dependency map:** a list of every user journey's hard and soft dependencies, kept next to the code - and a **fault injection test** in CI like the exercise's: in an integration test, kill each dependency once, slow it once, run the journey, and compare the matrix against an expected matrix. If someone adds a new hard dependency to the board, the test breaks - before the merge, not before Saturday night.

**Code rules:**

- A timeout on every external call, and the journey's overall time limit passed to the inner calls (a deadline). Timeout values come from the journey's budget, not a library's default.
- **No hard work after the commit.** Cache invalidation is soft (if it fails, the 5-minute TTL fixes it - 10.1); the comment email goes to the outbox (7.5). Both `✗!` cells closed.
- Board and share link: when the replica dies, read from the primary, but with a separate limit of 8 connections on that path (bulkhead - 9.4). Search has no fallback - a "search is unavailable right now" banner.
- Plan badge, comment counts, activity panel - soft, 150–300 ms timeouts, hidden if unavailable.

**Flags and config (static stability):** every flag has a default in code. The app keeps the last-known-good in its own memory, writes a snapshot to disk after every successful fetch, and bakes that moment's snapshot into the image at deploy time. At boot, if `flags` is unreachable, use the snapshot; if that is missing too, the code's default - **never crash.** Refresh in the background, with jitter (not everyone at once - 7.4). Metric: the config's age; alert if it is more than 10 minutes old (because age itself does no harm, but it says the control plane is dead). Urgent kill switches - like "turn off the new panel" - also exist as an environment variable, changeable through a deploy. The decision on Patroni's `failsafe_mode` is taken with the database team, weighing 6.1's split-brain risk.

**Brownout:** three levels for parts of the board, written down with product - level 1 turns off "More boards like this", level 2 the activity panel, level 3 comment counts. The controller is automatic (driven by queue wait), plus a switch for on-call to set a level by hand. Load shedding at the gateway as the last net (7.4), and every worker checks the deadline before starting work.

**Deploys:** one at a time, watching for 10 minutes after each, automatic rollback if the error rate rises (details in 10.6). App instances across three AZs.

**Chaos program:** a monthly game day - the first four: `flags` dead, billing slow, one cache node dead (10.1's ring), one replica dead. Then weekly automated experiments: 1% of traffic, an equal control group, z > 3, abort when the steady state breaks, during working hours, and never while an incident is in progress. The first experiment's hypothesis: "if billing slows by 2 s, board success stays above 99.9%, only the plan badge is hidden." According to today's matrix, the old code would have failed it - and that is exactly the experiment's value.

---

## 2. Interview Angle

Fault tolerance almost never comes up as a question on its own - it comes near the end of every design, in one short question from the interviewer: **"What if X dies now?"** That question can come for every box in your design, and a good answer has a shape:

1. **Which journey's hard dependency is it?** "If the cache dies, reads go to the DB - a soft dependency for reads; but can the DB take the full traffic without the cache? If not, the cache is actually hard." (That last part is 4.6's cache avalanche - many people forget it.)
2. **What does the user see in the degraded state?** "If the recommendation service dies, show the feed with a static list of popular posts where the recommendations were." Show nothing, show something old, do it later - which one.
3. **What if it is slow?** "A timeout on every call, and an overall deadline" - if you do not say this sentence, the interviewer will almost certainly follow up.
4. **When you mention redundancy, mention failure domains.** "Three replicas" followed by "in three different AZs, and deployed one at a time" - that is the senior answer.

**Follow-ups that are almost certain:**

- _"We want 99.99% availability - how does your design get there?"_ - count the journey's hard dependencies and multiply: five dependencies at 99.9% each means 99.5% - far from the target. The answer is not dependencies with more nines but fewer hard dependencies. Being able to do this arithmetic out loud is a strong signal.
- _"The difference between load shedding and graceful degradation?"_ - shedding reduces the **number** of requests (some get nothing), degradation/brownout reduces the **cost** per request (everyone gets less). In a good answer they come as two layers.
- _"What if the config service dies?"_ - static stability: last-known-good, a snapshot on disk, no crash at boot; and the cost - you cannot change config during the outage.
- _"Is chaos engineering safe to do in production?"_ - a small blast radius, a control group, automatic abort, during working hours; and the reverse question: is not doing it safe? The weaknesses are there anyway - the only question is who finds them first, you or 2 a.m.

**In real production:** the most common mistakes - making an "unimportant" internal service (config, flags, auth keys, a metrics agent) a hard dependency because the code that reads it has no default; writing fallbacks without timeouts (which never run against a slow dependency); a hard step after the commit, whose failure makes the user press again and creates duplicates; three replicas in the same AZ, deployed together; at cache TTL expiry, "error if no new value", so a control plane outage kills the whole fleet together a few minutes later; and never re-testing a degradation that was tested once, until someone adds a new hard dependency.

---

## 3. Key Takeaway

- **Faults cannot be prevented; the chain from fault to failure can be broken** - by hiding the fault with copies, containing the error with timeouts/breakers, and making the failure smaller with degradation
- **A journey's availability is the product of its hard dependencies** - the board's three (99.5, 99.9, 99.9) mean 99.301%, 61 hours a year; removing hard dependencies (board: 3 → 0) is often cheaper and more effective than giving dependencies more nines
- **The most dangerous dependency is often the most "unimportant" one** - one default-less line reading flags broke every one of seven journeys; and hard work after the commit (`✗!`) pushes the user into creating duplicates
- **Slow is worse than dead - and a soft dependency without a timeout is really hard.** A dead limiter fails open; a slow limiter holds five journeys for 3 s
- **The redundancy formula assumes independent failures** - with 3 copies the formula says 0.011 seconds a year, the measurement 160 minutes, because AZs and deploys kill all three together; spread across failure domains, deploy slowly - and a slow deploy only pays off when it is caught before it spreads (otherwise 72 → 147)
- **Under load, a brownout gives everyone the core work (0% → 100%), load shedding gives some people nothing (36%), and doing nothing leaves the system dead even after the load has gone** (100% wasted work); brownout is the first layer, shedding the last net, deadline checks always
- **Static stability: when the control plane dies, the data plane runs in its last known state, including restarts and new instances** - last-known-good + snapshot takes failures from 44% → 0.24%; the cost is that nothing can be changed during the outage
- **Chaos engineering = a hypothesis around the steady state, a small blast radius, a control group, automatic abort** - at 0.1% a global alarm never sees a subtle bug, a control group sees it with 9 damaged; a bigger blast radius does not catch faster, it just hurts more people

---

## 4. New Terms (Glossary)

| Term                                | Meaning                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fault Tolerance** (fault/failure) | The ability to keep a defect in one part (a fault) from reaching the user as a visible failure - by hiding the fault with copies, containing the error, or making the failure smaller                                 |
| **Hard / Soft Dependency**          | Hard: without it the journey fails; soft: without it the journey runs, with something dropped - decided by code, not by the dependency; a journey's availability ≈ the product of its hard dependencies' availability |
| **Graceful Degradation**            | When a dependency dies or slows, running in a state designed in advance that does less but still works - drop it, old data, an alternative path, do it later, or a plain "not now"; does not work without timeouts    |
| **Brownout**                        | Under load, automatically switching off the optional parts of each request to lower the cost per request so everyone gets the core work; load shedding reduces the number, brownout the cost                          |
| **Static Stability**                | The data plane keeps running in its last known state even when the control plane (config, flags, registry, orchestration) dies - including restarts and new instances; the cost: nothing can be changed meanwhile     |
| **Chaos Engineering**               | Deliberately and in a controlled way injecting faults into production to test a hypothesis about the steady state - small blast radius, a control group, automatic abort, regularly                                   |
| **Blast Radius**                    | The maximum extent a fault can affect (what % of traffic, how many users, how many services/regions) - kept deliberately small in experiments, and keeping it small in design (AZ, bulkhead, cell) is a goal          |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines in your own words for each.

1. A new journey is coming to TaskFlow: **"export a board to PDF".** In the first design the user presses a button, and in the same request: gateway (99.95%) → read the board from the replica (99.9%) → a new PDF rendering service (99.5%, one instance) → store the PDF in object storage (99.99%) → send a link through the email provider (99.5%) → tell the user "sent". (a) Treating all of them as hard, what is the journey's availability, and how many hours a year is it down? (b) Which dependencies can be removed from the journey - how, and how does the user's experience change? (c) In the new design, what is the availability of the user-facing part? What has turned from a "failure" into a "delay", and what will you measure for it?

2. Since 9.2 the gateway verifies the user's JWT on every request, using the identity service's public keys - the gateway pulls the keys from identity every 10 minutes (JWKS). (a) If the identity service is dead for two hours, what happens with the current design, minute by minute? What if one gateway instance restarts in the middle? (b) Give a statically stable design. How will you reconcile it with key rotation (retiring an old key for a new one), so that an older key set still works? (c) What is one thing you lose with this design - and in what situation is that a real security risk?

3. Write the plan for TaskFlow's first production chaos experiment: **"one Redis node of the cache ring dies"** (10.1). (a) Which numbers will you measure the steady state with - and which numbers **not**? (b) The hypothesis. (c) How will you keep the blast radius small - can killing a cache node be split like "1% of traffic"? (d) The abort conditions, and who or what will abort. (e) From 10.1 you know what could go wrong in this experiment - name at least two, and which one could turn the experiment itself into an outage.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) All hard, independent:

```
0.9995 × 0.999 × 0.995 × 0.9999 × 0.995
= 0.9985005 × 0.995 × 0.9999 × 0.995
≈ 0.98844  →  98.84%
down per year: (1 − 0.98844) × 8,760 hours ≈ 101 hours
```

The two 99.5% dependencies are almost all of the damage - the other three together are 0.16%. And PDF rendering is one instance - an hour of deploy or crash means an hour without export.

(b) What the user really wants is "I want the PDF", not "right now, inside this request". So:

- On the button press, an `export` row (`pending`) and an outbox event, in the same transaction (7.5) - only the primary is needed. Tell the user immediately "it's being prepared - you'll get an email and a notification when it's done".
- A worker (7.3) takes the event, reads from the replica, calls the PDF service, stores the result in object storage, marks the row `ready`, and enqueues the email job. Each step with retries (backoff + jitter, 7.4), idempotent (keyed on the export id).
- The page has a list of exports, with a download link once `ready` - the user gets it even if the email never arrives. Email is now soft: just one path for delivering the news.

(c) The user-facing part: gateway × primary (writing the row and the outbox) = 0.9995 × 0.9995 ≈ **99.90%**, ~9 hours a year (versus 101 before). The death of the PDF service, the replica, object storage or email is no longer a **failure** but a **delay**: if the PDF service is dead for an hour, the export arrives an hour late, but nobody sees an error. Delays need new metrics: time from `pending` to `ready` (p50, p99), the age of the oldest `pending` export (a signal of a stuck job), how many are in the DLQ (7.4). And a limit: say if it is not `ready` within 24 hours, mark it `failed` with a clear message to the user - not letting a "delay" become a delay forever.

**Question 2:**

(a) The current design is really the exercise's "TTL cache" row: keys cached for 10 minutes, and once expired, with no new keys, nothing can be verified. Minutes 0–10: all fine. Minute ~10: the cache expires - the gateway cannot verify any token → every authenticated request is a 401. In users' eyes: everyone is suddenly "logged out" and tries to log in again - but login goes through identity, which is also dead. Effectively the whole site is down for two hours, even though only identity died. If a gateway restarts in the middle: it pulls the JWKS at boot and fails - in the good case it comes up with no keys and returns 401 to everything, in the bad case a crash loop (the exercise's 463 failed boots).

(b) A statically stable design:

- The gateway remembers the last known key set, **even after it expires** - if it cannot get new keys, it keeps using the old ones, and a metric (the key set's age) raises an alert.
- After every successful fetch, a snapshot of the key set on disk, and in the image at deploy time; at boot, if identity is unreachable, use the snapshot.
- **Reconciling with key rotation:** **publish** the new key **in advance** (say, add it to the JWKS 24 hours before it starts being used), and retire the old key **afterwards** (after the last token signed with it has expired). Then at any moment the key set contains both the upcoming and the previous key, and even a snapshot several hours old can verify new tokens. Rotation is itself a static stability design.
- What runs during the outage: those who have a token keep working. What does not: new logins (identity is needed for that) - this is a plain "not now", not the whole site.

(c) You lose **emergency revocation.** Say a signing key has leaked, and identity is dead at that very moment - you cannot remove the key from the JWKS, because the gateway will not listen; it will keep using the last known set (including the leaked key). During that time an attacker can mint tokens with the leaked key. There should be a separate, simple path for this - say a list of "banned key ids" in the gateway's config, changeable through a deploy, without identity. (1.7's kill switch reasoning, applied to security.) And this is the coincidence of rare events (a key leak **and** an identity outage together) - not worth sacrificing everything for, but it needs to be written in the runbook.

**Question 3:**

(a) **Steady state:** what the user gets - board-open success (99.95%), board p99 (300 ms), and specifically for this experiment, **queries/s on the primary and replica** (because the real risk of a cache node dying is the load that moves to the DB - 10.1's whole story). **Not:** the cache's hit rate itself is not the steady state - it will drop when a node dies, that is expected; the question is whether the user notices. Nor CPU or memory.

(b) **Hypothesis:** "If one node of the ring (one of the 160-vnode nodes) dies, it is removed from the ring within 30 seconds (10.1's rule); its keys spread across the other nodes, single-flight keeps the rise in DB queries/s below twice normal, board success stays above 99.9%, p99 below 500 ms - and when the node returns it comes back after a FLUSHALL, showing no old data."

(c) **Blast radius:** killing a cache node is hard to split by % of traffic - when a node dies, every request for its keys is affected, and on a ring every instance sees the same ring. Ways to keep it small: (1) at the quietest time; (2) the node with the smallest weight (if there is one), or first a "soft" removal by lowering a node's weight - then the full kill; (3) first, remove the node from the ring for just one app instance (inject the fault inside that instance's client) - then the blast radius = that instance's traffic, say 1/6, and the other 5 are the control group. That is the cache's version of "1% of traffic": inject the fault in the client, not the server.

(d) **Abort conditions:** board success below 99.8%, or p99 above 800 ms, or primary CPU above 70%, any one for 30 seconds → **automatically** return the node or remove the client fault. Not left to human hands - in 10.1 you saw the DB's load rises in the very first second of a membership change; humans are not that fast. And if any other deploy or incident is under way, the experiment does not start at all.

(e) **What could go wrong (from 10.1):**

- **Single-flight is not everywhere.** If some endpoint goes to the DB on a cache miss without single-flight, the dead node's hot keys produce many DB queries at once (4.6's stampede) - the DB's load jumps. **This is what could turn the experiment into an outage:** the loss of one cache node reaches the DB, and the DB is everyone's hard dependency. That is why the abort has a primary CPU condition.
- **Not everyone sees the membership change at the same time** - some instances have removed the node, some have not (the registry's version, 10.1). For a while the same key lives on two nodes, and if there is no FLUSHALL when the node returns, old data.
- **Hot keys:** if the dead node held a very hot board's key, the load piles onto whichever node it moves to (10.1's hot key) - if that node slows, the latency of all its keys rises.
- **The return path is part of the experiment too** - after the node returns, keys move again, another wave of misses. Many experiments only look at the kill, and the outage happens on the return.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (five scripts, all deterministic simulations; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-10.3-fault-tolerance/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.3-fault-tolerance) - `npm install`, then `npm run matrix`, `npm run redundancy`, `npm run brownout`, `npm run static`, `npm run chaos`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`matrix` runs TaskFlow's seven journeys in code written two ways - the old code and code written with degradation in mind - killing each dependency once and slowing it once; then it measures availability over 10 years of simulated outages. `redundancy` puts the three-copy formula up against instance, AZ and deploy failures. `brownout` runs five policies side by side through the Monday-morning rush. `static` runs four config designs through a 45-minute control plane outage, with crashes and autoscaling. `chaos` measures blast radius and two kinds of abort rule - a loud bug, a subtle bug, and a harmless fault.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` and ESLint clean; the five scripts twice each, with output identical every time (compared byte for byte). **No script has a network, DB, Redis or real time** - a dependency is a name and a latency number, and every latency is **computed**, not measured. The journeys are real TypeScript functions, and the matrix comes from running them - but they represent TaskFlow's **design**, not any real codebase. Every number comes from assumed parameters (an instance dies once in 30 days, an AZ half a time a year, 3% of deploys bad, the worker time of the board's parts) - these are plausible estimates, not measurements of any real system; the scripts show **relationships**, and every parameter can be changed with an environment variable. `matrix`'s availability covers only nine dependencies, assuming independent failures. `brownout` is an M/G/c FIFO queue with a simple controller. `chaos`'s control group is a simplified z-test. **Not measured:** any real chaos tool (Chaos Monkey, Gremlin, Litmus or others), Patroni's real `failsafe_mode`, gRPC's deadline propagation, LIFO queues, sequential testing. The 70% from Google's SRE book in 1.5, the brownout study and Facebook's article in 1.6, Amazon's article and Patroni's behaviour in 1.7, and Netflix's Chaos Monkey and ChAP in 1.8–1.9 come from their published writing and documentation, not verified here. TaskFlow's decision in 1.10 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `matrix`, read `asWritten` in `src/journeys.ts` and fill in parts A and C of the matrix yourself - ✓, ~, ✗ or ✗! in every cell. Then run it and compare. Which cells did you get wrong? Those are exactly the ones code review does not catch - and that is why chaos experiments are needed.

2. **Your own journey:** add a new journey to `journeys.ts` - "board PDF export" (question 1's first design) - and a `pdf` dependency to `deps.ts`. Everything synchronous in `asWritten`, question 1's async design in `designed`. Compare both availabilities in `matrix` against the arithmetic in the answer.

3. **Brownout's limits:** `PEAK=12 npm run brownout`, then `BROWNOUT_WAIT=200 npm run brownout`. In the first, which policy gives the most users a board, and why is brownout alone not enough? In the second, what trade-off happened between "full page" and p99? Which threshold would you choose for TaskFlow, and whose decision is it?

4. **Static stability and TTL:** `TTL=1800 npm run static`. With a 30-minute TTL, what was saved and what was not? Now `OUTAGE_TO=50 TTL=1800 npm run static` - for a 20-minute outage, is a 30-minute TTL enough after all? Then what is the real argument for last-known-good - can you know in advance how long an outage will last?

5. **The design part:** a proposal has come in for an "offline mode" in TaskFlow's mobile app - with no network, the user sees the last board they viewed, can create tasks, and syncs when the network returns. A one-page plan: (a) which kind of fallback is this (1.4's table) - or several? (b) What is the "control plane" for a mobile app, and what does the static stability question look like here? (c) What conflicts can arise when syncing tasks created offline (remember 6.4's vector clocks and siblings), and which will you reconcile automatically? (d) Which actions will you deliberately **disable** offline, and why? (e) What would a chaos experiment for this feature look like?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1, 10.2
Current: 10.3 - Fault tolerance, graceful degradation, chaos engineering
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limits
in two layers; cache ring (160 vnodes); Bloom filter on share links, active users in HLL. On Saturday
night the flags service (one instance, on nobody's list) died - the TTL cache expired for everyone at
once, the whole site down for 50 minutes, crash loop on restart; on Monday morning a 2.5x rush + the
expensive "More boards like this" panel → every board timed out, and dead work stayed in the queue after
the rush. Now: a list of every journey's hard/soft dependencies + a fault injection test in CI (the
matrix); a timeout + deadline on every call; no hard work after the commit (cache invalidation soft,
comment email in the outbox); billing/replica soft for the board (badge, counts, panel hidden), when the
replica dies board/share read from the primary (bulkhead of 8 connections), "not now" for search; flags:
a default in code + last-known-good in memory + a snapshot on disk/in the image, never crash at boot,
refresh with jitter, an alert on config age, urgent kill switches also as env vars; the Patroni
failsafe_mode decision still pending; three brownout levels (recommendations → activity panel → comment
counts), automatic + a manual switch, shedding at the gateway as the last net, deadline checks in
workers; deploys one at a time, 10 minutes of watching, automatic rollback, three AZs; chaos: a monthly
game day, weekly 1% + a control group, z > 3, automatic abort, during working hours
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius
Weak spots: [where you got stuck - write it yourself]
Next: 10.4 - Observability: logging, metrics, tracing
=======================
```

---

## 8. Next Step

Today's thread: **faults will come - the only questions are which ones become failures, and who decides that: the design, or an accident.** A journey's availability is the product of its hard dependencies, so the biggest gain comes from making hard dependencies soft - a default, a timeout, a "bad but running" decided in advance. Keeping copies only cures independent failures; under load, doing less beats turning people away; and the data plane's dependence on the control plane is a trap you only see during restarts in the middle of an outage. And the only way to know all of this works is to break things on purpose - on a small scale, with a comparison.

But every part of today quietly assumed one thing: that we can **see** what is happening. The brownout controller measures queue wait; the chaos experiment's abort measures the error rate; the static stability alert measures config age; and on Saturday night the on-call engineer could not find `flags` for 25 minutes, because no graph pointed them there. When you are ready, write `next` - we go to **Lesson 10.4: Observability - Logging, Metrics, Tracing**. The question there: when one request touches the gateway, the BFF, the monolith, billing, the cache and the database, where do you look for the answer to "why is it slow" - and which questions do logs, metrics and traces each answer, and which do they not?
