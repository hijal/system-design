# Lesson 10.6 — Deployment: Blue-Green, Canary, Feature Flag, Zero-Downtime Migration

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 5.5):** When a transaction runs an `UPDATE` on a row, when is that row's lock released — when the statement ends, or when the transaction ends? And what happens if another transaction wants to write that row at exactly that moment? Today you will see an `UPDATE` that is just one statement, yet for the whole 5 seconds it runs it holds up every write in TaskFlow.

**Prerequisite:** Lesson 2.5 (API versioning, idempotency), Lesson 3.4 (Health checks, graceful shutdown), Lesson 5.4 (Indexes, `CONCURRENTLY`), Lesson 5.5 (Locks, transactions), Lesson 7.5 (Events, outbox), Lesson 9.2 (Gateway, BFF), Lesson 10.3 (Blast radius, static stability), Lesson 10.4 (SLI, burn rate)

**By the end of this lesson you will be able to:**

1. Compare big-bang, rolling, blue-green and canary through two separate questions. The first: **how many people** does a bad version touch. The second: **who** catches it, and when. Show with numbers why only a canary catches a bug that no alert fires on, why a canary has to be sticky by user, and why a small canary gives less evidence
2. Replace an instance without losing a request (readiness → wait → `close()` → finish in-flight requests). Separate deploy from release with feature flags, including the correct split (hash(flag + user)), a kill switch, and the same decision across services
3. Change a database schema in a running system without downtime. Which DDL blocks the whole table, what a lock queue is and why `lock_timeout`, and the six steps of expand/contract. At every step old and new code run together and the path to rollback stays open

**Tier:** 1 — Runnable Code (three deterministic simulations; a rolling restart with real HTTP on localhost; and two migration labs on real PostgreSQL, with Docker)

---

## 0. Where TaskFlow Is Right Now

After 10.5, TaskFlow has a long list of changes in front of it. Moving every route to `loadBoardFor`, a new `scope` column on `Membership`, changing the signing key across six services, a new board editor. TaskFlow's deploy setup is currently this: a pipeline every day at 2 p.m. First `sequelize db:migrate`, then the 12 instances replaced one at a time (rolling). Replacing an instance means stopping the container and starting a new one. The Node process does nothing on `SIGTERM`, so a few seconds later the orchestrator kills it with `SIGKILL`.

**Monday, 2 p.m.** The usual two-minute blip of errors. In 10.4 we excluded exactly this from alerting as "deploy noise". This time an engineer sat down to look into it. On every restart the requests in flight at that moment die. The load balancer keeps sending requests to the dead instance for another second or two. And the new instance gets traffic before its cache and connection pool have warmed up. Two users' "create task" POSTs were cut off halfway. They pressed again, and each got two tasks.

**Tuesday.** 10.5's `Membership.scope` migration: `ALTER TABLE memberships ADD COLUMN scope text`. An instantaneous job — Postgres only changes the catalog. But just then someone on the support team was running a report on the primary database with three minutes left to go. The `ALTER` waited for that report to finish. And behind it waited **every** query touching `memberships` — meaning nearly every TaskFlow request. Three minutes of site outage, for a "10 ms" migration.

**Wednesday.** At the mobile team's request, `boards.title` was renamed to `name`, to keep the name consistent across the product. The migration (`RENAME COLUMN`) ran before the deploy. For the 12 minutes of the rolling deploy, the instances still running the old code gave `column "title" does not exist` on every board. Then a separate bug was found in the new version, and it was rolled back. The old code returned, but the column is now called `name`. This time **every** instance's boards were broken, until someone wrote the reverse migration by hand. Twenty-five minutes.

**Thursday.** After Wednesday, the team was scared and chose blue-green for `loadBoardFor`: "one-click rollback." The new stack was built, passed its smoke tests, and all traffic moved to the new side in an instant. There was a bug: on very large business workspaces' boards, 20% of requests failed. Those are 1% of traffic. The whole system's error rate went from 0.1% to 0.3%. No alert fired. The number one enterprise customer reported it on Monday. Four days, and almost every one of that customer's users affected.

**Friday.** The new board editor went live behind a feature flag for 10% of users. The flag's code was `Math.random() < 0.1`, on every request. When users refreshed, the editor changed. And the BFF and the API each checked the flag on their own: the BFF showed the new UI, the API returned the old-shaped response. "Something went wrong" on a third of requests. The flag was turned off, but the instances read config every 5 minutes.

The CTO's line in the postmortem: "We treated every deploy as a jump — from one side to the other. Really every deploy is a bridge, and for a while both old and new walk on it. Old instances and new instances, old code and new schema, old browser tabs and the new API. Every incident this week happened in the middle of the bridge."

---

## 1. Theory

### 1.1 A deploy is not a jump, it is a bridge

Google's SRE book has a widely quoted claim: roughly 70% of production outages come from some **change** to a live system (not verified here). Whatever the exact number, the reason is simple. A system that does not change usually breaks from hardware or load. And we deliberately change our systems several times a day. So the design of deploys is the biggest lever on reliability.

First, a distinction between two words:

**Deploy / Release** — deploy means starting new code on production machines. Release means showing users that new behaviour. There is no rule that both must happen in the same instant. Code can be deployed and sit switched off, and later be released step by step with a flag. Separate the two, and deploy becomes a harmless, frequent task, while release becomes a controlled, reversible decision.

And the idea of the "bridge": during any deploy, old and new coexist in four places.

```
                  old                          new
instance      ┌─ v1 v1 v1 v1 v1 ─┐  rolling  ┌─ v2 v2 v2 ─┐       (minutes)
code ↔ schema │ v1 code, old column  ⇄  v2 code, new column │       (before and after the migration)
client        │ browser tab open for 8 hours, 6-month-old mobile app │  (days, months)
data / queue  │ events and rows written by v1  → read by v2   │       (7.5's outbox, weeks in a DLQ)
```

So the rule in one line: **every change has to work with at least the version before it, in both directions.** New code can read old data, and old code (after a rollback) can read data written by new code. This is called N-1 compatibility. Wednesday's rename broke exactly this rule, in both directions. The rest of this lesson walks across each part of this bridge. First replacing one instance (1.2). Then in what order to replace many instances (1.3–1.4). Then separating code from release (1.5), versions coexisting (1.6), and the hardest part, the database (1.7–1.8).

### 1.2 Replacing one instance — graceful shutdown

In 3.4 you saw the idea of graceful shutdown, and I said we would go deep on it here. Monday's blip is exactly this place.

The exercise's `npm run drain` runs a real small load balancer (round-robin, with health checks) and four real `node:http` instances on localhost. With 200 req/s flowing (80% GET, 20% POST), it replaces the four instances one at a time. Each new instance takes 800 ms to start, and stays "cold" for the first 1.5 seconds (+400 ms per request). The LB's health check runs every 500 ms, and an instance is removed after two consecutive failures. Five designs:

```
design                                  request   GET fails  POST fails  total failed  > 300 ms     p99
no health check, abrupt kill              3,090        130          35   165 (5.34%)        289   485 ms
health check, abrupt kill                  3,084         88          21   109 (3.53%)        250   482 ms
health check, abrupt kill, LB GET retry    3,132          0          20    20 (0.64%)        254   482 ms
health check, only close() on SIGTERM     3,146        111          36   147 (4.67%)        264   484 ms
graceful: readiness → wait → close       4,252          0           0     0 (0.00%)          3   157 ms
```

(In a second run the failures were 167, 107, 20, 137, 0. It is real HTTP, so the numbers wobble a little, but the order and the zero do not. The graceful run is longer, because each instance waits before stopping, so there are more requests.)

One at a time:

- **Sudden kill, no health check.** Requests in flight die. And for the whole restart the LB sends requests to the dead port, because it simply does not know. Monday.
- **Adding a health check** reduces it, but not to zero. The LB takes time to find out (up to 500 ms × 2), and every request sent in that time fails.
- **The LB's retry** covers every GET failure. After a failed connection it sends again to another instance. But **20 POSTs remain**, because the LB does not know whether it is safe to send a POST again. Maybe the first instance wrote the task before dying. With 2.5's `Idempotency-Key` the client could have retried safely itself. Monday's two duplicate tasks came through exactly this gap.
- **Only `close()`** is surprising: hardly better than a sudden kill. `server.close()` lets in-flight requests finish, but stops accepting new connections **immediately**. And the LB is still sending to this instance, because the health check does not know yet. Those get `ECONNREFUSED`.
- **Graceful: zero.** The difference is the **order**. First the instance turns its own readiness to 503, but keeps accepting requests. The LB sees that on its next two health checks and removes the instance. Then, once nobody is sending any more, `close()`. In-flight requests finish, then the process exits. And the new instance gets traffic only after warm-up, because its readiness tells the truth. So the "> 300 ms" column goes from 289 to 3. Requests sent to cold instances were that slow tail.

```
SIGTERM
  │
  ├─► readiness = 503 ─────────── LB health check ×2 ─► removed from the LB's list
  │      (still accepting requests)
  ├─► wait  ≥ check interval × fail threshold  (+ a little margin)
  ├─► server.close()   new connections refused; idle keep-alives closed
  ├─► wait for in-flight requests to finish   (with an upper limit)
  ├─► close the DB pool, queue consumers
  └─► exit(0)            ── past the limit, exit(1), before the orchestrator's SIGKILL
```

Its shape in Express (the reasoning of the exercise's `drain.ts`, in Express terms, not run):

```ts
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Sequelize } from 'sequelize';

const lifecycle = { warm: false, draining: false };

export function readiness(app: Express): void {
	app.get('/ready', (_req, res) => {
		res.status(lifecycle.warm && !lifecycle.draining ? 200 : 503).end();
	});
}

export function markWarm(): void {
	lifecycle.warm = true;
}

export function shutdownOnSigterm(
	server: Server,
	sequelize: Sequelize,
	drainMs: number,
	hardLimitMs: number
): void {
	process.once('SIGTERM', () => {
		lifecycle.draining = true;
		setTimeout(() => {
			setTimeout(() => process.exit(1), hardLimitMs).unref();
			const idle = setInterval(() => server.closeIdleConnections(), 100);
			server.close(() => {
				clearInterval(idle);
				void sequelize.close().then(() => process.exit(0));
			});
		}, drainMs);
	});
}
```

Notice three things. First, `/ready` and `/health` (liveness, 3.4) are different things. When readiness is false the LB moves traffic away, but the orchestrator does not kill the process. Second, `drainMs` has to be tied to the LB's health check. In the exercise it is `CHECK_MS × 2 + 500`. In Kubernetes this is usually a `preStop` wait, because there removing the endpoint and `SIGTERM` happen almost at the same time. Third, `hardLimitMs` has to be shorter than the orchestrator's patience (Kubernetes's `terminationGracePeriodSeconds`, default 30 s). Otherwise `SIGKILL` arrives before your own clean exit. And `markWarm()` is called after the DB connections, cache and anything else needed have been created.

### 1.3 Four strategies — how many people a bad version touches

One instance can be replaced safely. Now the question is in what order to replace 12. There are four well-known answers:

- **Big-bang:** every instance to the new version at once. Simple and fast.
- **Rolling:** replacing one (or a few) at a time. This is what Monday's TaskFlow does. No extra machines needed, but in between, two versions run at once.

**Blue-Green Deployment** — two complete, equal environments. "Blue" is getting traffic now; the new version is built and tested on "green". Then the load balancer (or DNS) moves all traffic to green in an instant. Rollback means moving back to blue, in seconds, because blue is still running. The cost is double capacity for the duration of the switch. And the database is usually shared by both, so the "instant rollback" covers only code, not data.

**Canary Release** — giving the new version to a small share of traffic first (say 1%), comparing its SLIs with the old version's over the same period (the baseline), and increasing step by step if it looks good (1% → 5% → 25% → 100%). If an automatic **gate** does the comparison, a bad version is rolled back before any human wakes up. The name comes from the canary in a coal mine, which fell ill from poisonous gas first and warned the miners.

`npm run rollout` watches 300 req/s, 60,000 users, for two hours. TaskFlow has an alert (5 minutes of errors > 1% or slow > 5%), and after the alert fires a human takes 10 minutes to decide (assumed). The canary has a z-test gate (canary versus baseline, detailed in 1.4). Three kinds of bug:

```
2% errors for everyone
strategy                                  bad requests  users hit    caught   caught by    reverted
big-bang (all at once)                           5,556      5,305 (9%)     1.0 min  alert → human   16 min
rolling (one per 2 minutes)                     4,873      4,669 (8%)      12 min  alert → human   27 min
blue-green                                         4,212      4,061 (7%)     1.0 min  alert → human   11 min
canary, gate: error, random per request              4          4 (0%)     2.0 min  gate, at 1%      2.5 min
canary, gate: error, sticky per user                   8          8 (0%)     1.0 min  gate, at 1%      1.5 min
canary, gate: error + latency + segment                 8          8 (0%)     1.0 min  gate, at 1%      1.5 min

20% errors on big business boards (1% of traffic)
big-bang (all at once)                           4,164        582 (1%)      missed  —                    —
rolling (one per 2 minutes)                     3,784        581 (1%)      missed  —                    —
blue-green                                         4,174        582 (1%)      missed  —                    —
canary, gate: error, random per request              8          7 (0%)      12 min  gate, at 5%       13 min
canary, gate: error, sticky per user                   5          5 (0%)      11 min  gate, at 5%       12 min
canary, gate: error + latency + segment                 5          5 (0%)      11 min  gate, at 5%       12 min

10% of requests slow (> 1 s), no errors
big-bang (all at once)                          27,589    22,021 (37%)     1.0 min  alert → human   16 min
rolling (one per 2 minutes)                    29,220    23,126 (39%)      14 min  alert → human   30 min
blue-green                                        20,440    17,207 (29%)     1.0 min  alert → human   11 min
canary, gate: error, random per request         28,134    22,501 (38%)      32 min  alert → human   42 min
canary, gate: error, sticky per user              28,010    21,751 (36%)      32 min  alert → human   42 min
canary, gate: error + latency + segment               24         23 (0%)     1.0 min  gate, at 1%      1.5 min
```

**The first bug (2% for everyone).** Big-bang and blue-green catch it in one minute. The alert fires immediately, because everyone is on the new version. But "caught" and "damage stopped" are different. After it is caught, 10 minutes for the human, then the rollback. Blue-green's rollback takes 30 seconds (flip the switch back), big-bang's 5 minutes (deploy again), hence 11 versus 16 minutes. For the whole time **everyone** is on the new version: 4–5 thousand bad requests, 7–9% of users. Rolling is caught slowly (12 minutes), because total errors pass 1% only when about half the instances (6 of 12) are on the new version, and the alert's 5-minute window has to notice it. And reverting takes time too. The canary's damage is **four to eight requests**, before any human knows. This is the canary's core point: it does not make finding the bug faster, **it keeps the bug small while it is being found.**

**The second bug (Thursday).** 20% errors on 1% of traffic means total errors go from 0.1% to 0.3%. It touches no alert's threshold. Under the first three strategies **nobody ever catches it.** In two hours 582 business users — nearly everyone in that segment — are hurt. And really the damage just keeps going, until a customer calls. The canary catches it at the 5% step: in a canary-versus-baseline comparison even a 0.2% difference shows up clearly given enough requests, something a fixed threshold like "error > 1%" will never see. Five bad requests. Blue-green gave a false sense of security here: an "instant rollback" only helps if someone knows a rollback is needed.

**The third bug (no errors, just slow).** Here two of the canaries fail, because their gates only look at errors. The new version produces no errors; it just takes over a second on 10% of requests. So it passes every step and reaches 100%, and the alert fires at 32 minutes. The same damage as big-bang, only later. The last row's gate looks at both latency (the canary's slow share versus the baseline's) and segments, and catches it **in one minute, at 1%**. The lesson: **a canary is only as good as what its gate looks at.** 10.4's SLIs (success **and** latency), and the important segments (plan, region, big customers) — all of them have to be in the gate.

**The cost of a good version.** The same strategies, with no bug:

```
strategy                                   reaches 100%  extra capacity  bad rollback
big-bang (all at once)                           1.0 min             0           no
rolling (one per 2 minutes)                     22 min            −1           no
blue-green                                          0 s             +12           no
canary (all three)                                  30 min              +3            no
```

Every strategy buys safety with something. Big-bang gives nothing, so it gets nothing. Rolling gives time (and one instance less capacity during the deploy). Blue-green gives money (double the machines, at least for a while). Canary gives time (30 minutes), a few extra instances, and above all, **the effort of building a good gate**. And they do not exclude each other. In practice, traffic is often moved between blue-green's two pools in canary-like steps, or a gate is placed at every step of a rolling deploy.

### 1.4 The arithmetic inside a canary — how big, how long, whom

A canary's gate answers a statistical question: "is the canary's error ratio higher than the baseline's, or is it luck?" The exercise's gate is a two-proportion z-test (the difference between two ratios divided by its expected random fluctuation). z > 3 means "a real difference". In `npm run rollout` part C, baseline errors are 0.1%, and each cell is run 400 times:

```
canary   time  canary request   +0.2% hit  +1% hit  false pos.  checked per minute  +1% damage
1%       5 min           900        25%      100%        1.5%               2.8%             9
1%      10 min         1,800        41%      100%        1.3%               4.8%            18
1%      30 min         5,400        80%      100%        1.0%               5.5%            54
5%       5 min         4,500        72%      100%        0.0%               1.0%            45
5%      10 min         9,000        95%      100%        0.5%               2.8%            90
5%      30 min        27,000       100%      100%        0.5%               4.3%           270
25%      5 min        22,500       100%      100%        0.3%               0.5%           225
25%     10 min        45,000       100%      100%        0.0%               0.5%           450
25%     30 min       135,000       100%      100%        0.0%               1.8%         1,350
```

Three lessons:

1. **Any canary catches a big regression.** For +1% (ten times the errors), 5 minutes at 1% is enough, with 9 requests of damage. That is why the first step is kept small: the worst mistakes are caught most cheaply.
2. **A small regression needs evidence, and evidence means requests.** The chance of catching +0.2% (like Thursday's) is 25% at 1% for 5 minutes, and 95% at 5% for 10 minutes. Evidence comes from the number of canary requests, so a smaller percentage needs more time. And the last column shows the flip side: the more requests go to the canary, the more damage if there is a bug. This is a real trade-off with no magic number. **On a low-traffic service** (say billing's webhooks, 2 a second), a 1% canary will never gather enough evidence. There you need a bigger percentage, a longer time, or another path (reflection question 2).
3. **Checking repeatedly increases false alarms.** Checking once at the end of the period gives a 1.0–1.5% false alarm rate. "Let's check whether z > 3" every minute gives 5.5% over 30 minutes. Every look is a new chance for luck's fluctuation to cross the threshold. This is called peeking, or multiple testing. And false alarms have a cost: a good version gets rolled back, and engineers start distrusting the gate. The remedies: a minimum number of requests and a minimum time per step, a stricter threshold for repeated looks, or a method built for exactly this, like a sequential test.

**Who is the baseline?** The comparison is against the old version **over the same period**, not yesterday. The same 2 p.m. traffic, the same state of the cache, the same mood of the dependencies. So many designs run, next to the canary, a pool of the old version of the same size, **freshly started** (a "baseline canary"). That way the effect of a new process's cold cache is the same on both sides. (Argo Rollouts, Flagger and Spinnaker's Kayenta do this kind of automated analysis. Not run here.)

**Whom to send to the canary.** In `npm run rollout` part D, the canary stays at 5% for an hour:

```
routing              saw the new version  switched between versions
random per request     35,663 (59%)            35,663 (59%)
sticky per user           2,963 (5%)                  0 (0%)
```

Split requests at random and a 5% canary actually touches **59% of users**. Each user makes ~18 requests an hour, and it only takes one of them landing on the canary. And those 59% jump between the two versions: the new UI once, the old one on the next click. If there is a bug, complaints come from almost everyone, and debugging is hard, because the same user has two different experiences. Choose the canary by a hash of the user's (or workspace's) id, and 5% really is 5% of people, the same people every time. The blast radius (10.3) can be measured, and behaviour stays stable for people.

And **segments**: Thursday's bug was on 1% of traffic. In the exercise's experiment 1 (`STEP_MINUTES=3`), with shorter steps, the errors-only gate's sticky canary does not catch it **at all**. Each step has so few requests from the segment that the difference drowns in the average, and the bug reaches 100% (3,857 bad requests, 582 people). A segment-aware gate (a separate comparison per plan) catches the same bug in 4 minutes. A gate's segments come from exactly where your customers differ: plan, region, workspace size, client (web, mobile).

### 1.5 Feature Flags — separating release from deploy

**Feature Flag** — a condition in the code (`if (flags.isOn('new-editor', user))`) whose value can be changed while running, from an external config, without changing code or deploying. Flags serve four different jobs, and each has a different lifetime. A **release flag** turns on a new feature step by step, lives for days or weeks, and then has to be deleted. An **ops flag or kill switch** turns off some part under load (10.3's brownout), and is permanent. An **experiment flag** is for A/B tests. A **permission flag** gives features by plan.

Flags separate deploy from release. The new editor's code can be deployed on Tuesday, switched off, with almost zero risk. It is released on Thursday, to 1% of users, with one click on the flag. Canaries and flags are two layers of the same idea. A canary spreads a new **binary** step by step, a flag spreads new **behaviour**. And a flag's steps need no deploy.

But Friday showed that three things about flags are easy to get wrong. `npm run flags`:

**(a) How to split.** 60,000 users, each viewing 20 pages a day, two separate flags at 10% each:

```
how it splits          saw the new  saw both (flip)  in both flags
random per request      52,705 (88%)              52,705             46,134
hash(user)                   5,869 (10%)                   0              5,869
hash(flag + user)            6,041 (10%)                   0                616
```

Friday's `Math.random() < 0.1`: a 10% flag shows the new editor to **88%** of users, and all of them jump between the two editors. `hash(user)` stops the jumping, but there is another subtle trap. The **same 5,869 people** land in both flags. The same people are guinea pigs in every 10% experiment, and the two experiments' results mix with each other. Mix the flag's name into the hash (`hash(flag + user)`) and each flag's 10% is independent: 616 people are in both, close to the expected 1%.

```ts
import { createHash } from 'node:crypto';

export function bucket(flag: string, userId: string): number {
	const digest = createHash('sha256').update(`${flag}:${userId}`).digest();
	return digest.readUInt32BE(0) / 2 ** 32;
}

export function isOn(flag: string, userId: string, percent: number): boolean {
	return bucket(flag, userId) * 100 < percent;
}
```

And one more benefit: going from 10% to 25%, everyone in the earlier 10% stays inside the 25%, because their bucket value has not changed — only the threshold moved. Nobody gets a new feature and then loses it.

**(b) How fast the kill switch is.** 12 instances, 100 req/s on the new feature, 20% of them failing. After the decision to "turn it off":

```
how it turns off           all off (avg)          worst    bad requests (avg)
flag, poll every 5 minutes                4.6 min        5.0 min            2,998
flag, poll every 30 s                          28 s            30 s                300
flag, streaming push                            3 s             3 s                 40
no flag: rollback deploy                     11 min          11 min            9,900
```

Without a flag, turning it off means a rollback deploy (a 5-minute pipeline + rolling). 9,900 bad requests. With streaming push, 40. The two middle rows show where the poll interval costs you. And remember 10.3's static stability: if the flag service dies, instances keep running on the last known values. So it is good to keep a second path for kill switches (say environment config that can be changed without a deploy), so a feature can be turned off even at the very moment the flag service is also dead.

**(c) Two services, one decision.** The BFF shows the new UI, the API returns the new-shaped response. 10 minutes, with the flag going from 10% to 50% at minute 5:

```
who decides, how                          request  UI/API mismatch
both hash(user), config at the same moment  180,000        0 (0.00%)
BFF hash(user), API hash(session)               180,000   61,331 (34.07%)
both hash(user), each polls every 30 s   180,000    1,154 (0.64%)
BFF decides once, sends it in a header     180,000        0 (0.00%)
```

Friday's second row: one hashed by session, the other by user. On **a third of requests** the UI and the API were on two different versions. And even with the same hash (the third row), the two services learn the new percentage at different moments, so there is a mismatch for a few seconds after 10%→50%. In experiment 3, with a 5-minute poll, 6.53%. The way out is the last row: **make the decision once, then send it along.** The BFF (or gateway) checks the flag and tells the downstream services in a header (`x-flags: task-api-v2`). The same reasoning as 10.4's trace id: anything that has to stay the same across a whole request is decided once and travels with it. And remember 10.5's lesson: the gateway drops any `x-flags` the client sends, otherwise anyone could turn flags on for themselves.

**Flag debt.** Every flag creates two paths in the code, and two flags create four. A release flag has to be deleted, along with its code, once it reaches 100%. Giving every flag an owner and an expiry date is a common rule. And **never reuse an old flag's name for a new purpose.** The most famous example is Knight Capital (2012), according to published accounts (not verified here). An old, unused flag was reused in new code with a different meaning. The new code was not deployed on one of the 8 servers. When the flag was switched on there, a dead code path many years old woke up. A loss of about 440 million dollars in 45 minutes. Three of this lesson's lessons in one incident: version skew (1.6), flag debt, and the lack of automatic detection of a failed deploy.

### 1.6 Version skew — old and new together

**Version Skew** — different parts of a system running different versions at the same moment: instances in the middle of a rolling deploy, client and server, producer and consumer, code and schema. This is not the exception, it is the normal state. So every change has to work with both N and N-1, and to keep rollback safe, **the new version must not write anything the old version cannot read.**

Four places, four rules:

- **API (server ↔ client):** add fields; do not delete or rename them, not in one step. On the client side, a "tolerant reader": ignore unknown fields, keep defaults for missing optional fields. Browser tabs run old JavaScript for hours. Mobile apps stay old for months (2.5's versioning).
- **Events / queues (producer ↔ consumer):** 7.5's outbox events may be read seconds later, and from the DLQ (7.4) weeks later. When adding a field, deploy the consumer first, so it understands both the new and the old shapes. Then the producer. (If the producer goes first, what will the old consumer do with a new event? Ignore it, or treat it as a poison message?)
- **Service ↔ service:** the same rule as 9.2's internal APIs, with this deploy order: whoever **understands** the new thing goes first. Whoever **sends** the new thing goes after.
- **Code ↔ schema:** the hardest, because there is one database and everyone shares it. The next two sections are about this.

Recall 10.5's key rotation here. First verify with **two** keys in every service, then sign with the new key, then remove the old key. That is exactly this rule: first **understand** the new thing, then **send** it, then delete the old one. In 1.8 we will see this same pattern in the database.

### 1.7 Database changes — what blocks, and the lock queue

Tuesday's mystery: how did an `ADD COLUMN`, which should finish instantly, keep the site down for three minutes?

In Postgres almost every `ALTER TABLE` asks for an **ACCESS EXCLUSIVE** lock on the table. It is the strictest lock: while it is held nobody can even read the table. If the work is instantaneous (only changing the catalog), nobody even notices. But to **get** the lock it has to wait until all earlier locks are released, and even an ordinary `SELECT` holds a light lock (ACCESS SHARE) on the table until its transaction ends. Here is the blow: **every newly arriving query lines up behind the waiting ACCESS EXCLUSIVE.** Even an ordinary `SELECT`, although it does not itself conflict with the long report. Postgres grants lock requests in order, so that the `ALTER` does not starve forever.

**Lock Queue** — the line of requests waiting for a lock. When a DDL waits for ACCESS EXCLUSIVE behind a long transaction, every new query (reads included) lines up behind it, so an instantaneous DDL keeps the whole table blocked for the rest of the long transaction. The remedy is `lock_timeout`: if the DDL does not get the lock within a set time it gives up (and the queue opens up), then tries again a little later.

```
time →
report (BEGIN; SELECT …)  ████████████████████████████████████████▶ COMMIT
ALTER TABLE …                  ⏳ waiting for ACCESS EXCLUSIVE ……………………▶ ✓ (10 ms)
app SELECT                        ⏳ behind the ALTER …………………………………▶ ✓
app UPDATE                          ⏳ …………………………………………………………………▶ ✓
app SELECT                             ⏳ …………………………………………………………▶ ✓
```

`npm run locks` runs on a real Postgres 17, with a million rows in the `tasks` table, and alongside it 8 workers continuously doing `SELECT` and `UPDATE` by id (the running app). What the app experienced during each change:

```
change                                      time   app op   read max     write max     > 500 ms
ADD COLUMN archived boolean DEFAULT false      10 ms       15          2 ms           3 ms          0
ADD COLUMN score float DEFAULT random()       669 ms       38        646 ms         646 ms          8
ADD COLUMN priority int, behind a 6 s query  6.05 s      476        5.70 s         5.70 s          8
   the ALTER itself waited 5.71 s — and everyone behind it
the same, lock_timeout 200 ms + retry         6.38 s    7,421        200 ms         202 ms          0
   6 attempts, each giving up and stepping aside after 200 ms
```

- **`ADD COLUMN` with a constant default: 10 ms.** Since Postgres 11 a constant default is written only to the catalog; rows are not touched.
- **`DEFAULT random()`: 669 ms, with every read and write blocked the whole time.** A volatile default (a different value per row) means Postgres has to write a different value into every row, so it **rewrites** the whole table, holding ACCESS EXCLUSIVE. 700 ms at a million rows, over a minute at 100 million. Two lines that look almost the same: one instantaneous, the other a site-wide pause.
- **Lock queue: 5.7 seconds.** A 6-second query is open, and in the middle, `ADD COLUMN priority int` (instantaneous in itself). **Every** app worker is blocked for 5.7 seconds, even plain `SELECT`s. In 6 seconds the app managed 476 operations, where it normally does ~7,400. Tuesday, in miniature.
- **`lock_timeout` + retry: at most 200 ms.** The same situation, but if the `ALTER` does not get the lock within 200 ms it gives up and tries again a second later. Six failures; on the seventh the report has finished. Each time the app waited at most 200 ms, and did 7,421 operations — practically normal.

**Indexes and backfills:**

```
change                                      time   app op   read max     write max     > 500 ms
CREATE INDEX                                  209 ms       22          0 ms         198 ms          0
CREATE INDEX CONCURRENTLY                     332 ms      455          1 ms           3 ms          0
all in one UPDATE                            4.92 s      483          0 ms         4.83 s          8
in batches (10,000 each, 20 ms apart)     6.16 s    8,271          0 ms          36 ms          0
```

- **`CREATE INDEX` blocks writes, not reads.** It takes a SHARE lock: reads run, writes wait (at most 198 ms). At a million rows that sounds small. In 5.4 I said that at 100 million it is minutes. `CONCURRENTLY` is slower (332 ms), but writes wait at most 3 ms. It has two costs: it cannot run inside a transaction, and if it fails halfway it leaves an `INVALID` index behind, which has to be dropped and run again.
- **Backfill in one `UPDATE`: every write blocked for 4.8 seconds.** **The spaced repetition answer:** row locks are released at the end of the **transaction**, not the statement. One `UPDATE tasks SET priority = 0` is one statement, one transaction. It holds the lock on every row it touches until it ends. Over 4.9 seconds, locks on a million rows pile up gradually. Any app `UPDATE` that lands on a row the backfill has already touched waits until the backfill's **end**. And alongside this are two more costs, not measured here: a huge wave of WAL that puts replicas behind (5.7, 6.3), and a million dead tuples that vacuum has to deal with.
- **In batches: writes wait at most 36 ms.** 100 small transactions of 10,000 rows each, with a short pause in between. A little more total time (6.2 s), but the app barely noticed. In practice the batch size and pause are set by watching replica lag: slow down when lag rises.

**NOT NULL:**

```
SET NOT NULL (directly)                     153 ms       23        140 ms         140 ms          0
CHECK NOT VALID → VALIDATE → SET NOT NULL     111 ms      156          2 ms           4 ms          0
   NOT VALID 5 ms, VALIDATE 78 ms (lock: SHARE UPDATE EXCLUSIVE), SET NOT NULL 5 ms (scan skipped), DROP CHECK 5 ms
```

`SET NOT NULL` has to read the whole table to check for nulls, and does it while holding ACCESS EXCLUSIVE. At a million rows, everything blocked for 140 ms. The technique: first add a `CHECK (priority IS NOT NULL) NOT VALID` constraint. This is instantaneous, because old rows are not checked, only new writes. Then `VALIDATE CONSTRAINT`. This reads the whole table, but with a light lock (SHARE UPDATE EXCLUSIVE) that blocks neither reads nor writes. Then `SET NOT NULL`. Since Postgres 12, if a valid CHECK constraint exists it skips the scan (5 ms). Finally drop the CHECK.

**The rules in one place:**

1. `lock_timeout` (a few seconds or less) and retries on every migration. Plus a `statement_timeout`, so a long DDL does not run by mistake.
2. Defaults only constant. If a volatile value is needed, add the column as null, then backfill in batches.
3. Indexes always `CONCURRENTLY`. If one fails, find and drop the `INVALID` index.
4. Backfills in batches, in small transactions, watching replica lag.
5. `NOT NULL`, foreign keys, CHECK: first `NOT VALID`, then `VALIDATE` separately.
6. No long queries on the primary during a migration (on 7.6's OLAP replica instead). And look at `pg_stat_activity` before the migration.

In Sequelize, the careful way to set `lock_timeout` inside a migration is `SET LOCAL` inside a transaction. A plain `SET` on a pool gives no guarantee which connection it went to, or that the next query will use the same connection (5.6). And retry when the lock is not obtained:

```ts
import type { Sequelize } from 'sequelize';

function isLockTimeout(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('parent' in error)) return false;
	const parent: unknown = error.parent;
	return (
		typeof parent === 'object' && parent !== null && 'code' in parent && parent.code === '55P03'
	);
}

export async function ddlWithRetry(
	sequelize: Sequelize,
	sql: string,
	attempts = 20
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await sequelize.transaction(async (transaction) => {
				await sequelize.query("SET LOCAL lock_timeout = '2s'", { transaction });
				await sequelize.query(sql, { transaction });
			});
			return;
		} catch (error: unknown) {
			if (!isLockTimeout(error) || attempt >= attempts) throw error;
			await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
		}
	}
}
```

(`55P03` is Postgres's `lock_not_available`. Sequelize's `DatabaseError` keeps the original pg error in `parent`. So it is narrowed step by step from `unknown`, without `any`. `CREATE INDEX CONCURRENTLY` does not run inside a transaction, so for that a clean path is `ALTER ROLE migrator SET lock_timeout = '2s'` on the DB user that runs migrations.)

### 1.8 Expand / Contract — the right way to rename

Now Wednesday. A column cannot be renamed in one step. There is no moment when every instance moves from the old name to the new name at once. Migrate first and old code breaks; migrate after and new code breaks. `npm run rename` runs on real Postgres and Sequelize, with 20,000 rows in the `boards` table. Four instances, each working continuously in two loops (60% reads, 35% writes, 5% new boards). In the rolling deploy one instance moves to the new version every second. Four kinds of app version, each looking at the same table through a different Sequelize model:

```
v1   = reads title, writes title                      (today's code)
v1.5 = writes both title and name, reads title
v2r  = writes both, reads name
v2   = reads and writes only name                     (the end goal)
```

**In one step (Wednesday):**

```
step                                        running   op    error  misreads
migration first, then deploy               v1 → v2   9,544    4,223          0
   v1: column "title" of relation "boards" does not exist
deploy first, then migration               v1 → v2   9,905    4,193          0
   v2: column "name" of relation "boards" does not exist
then rollback (migration not reverted)  v2 → v1   8,306    4,219          0
   v1: column "title" does not exist
```

More than four thousand errors in six seconds, in each of the three orders. And the third row is the worst part of Wednesday: the rollback broke too, because the schema did not come back. A code rollback and a data rollback are different things.

**Expand / Contract** — splitting a breaking change (a rename, a change of shape, a split) into several small steps, each of which can be deployed and rolled back on its own, with both old and new code working at every step. First **expand**: add the new thing alongside, write to both, bring the old data into the new place, move reads to the new place. Finally **contract**: when nobody uses the old thing any more, delete it. Also called "parallel change".

```
step  schema                              code (rolling)            rollback safe?
1     + name (null), drop title's NOT NULL   v1                     yes (nothing uses it)
2                                         v1 → v1.5 (write both)    yes → v1
3     backfill: name = title (batches)    v1.5                      yes
4                                         v1.5 → v2r (read name)    yes → v1.5 (still writing both)
5                                         v2r → v2 (write only name) ✗ not to v1.5 — title is going stale
6     − title  (after waiting)            v2                        ✗
```

And the measured results:

```
step                                        running      op    error  misreads
1. expand: add name, drop title's NOT NULL  v1           4,946       0          0
2. deploy: write to both                 v1 → v1.5    9,883       0          0
3. backfill: name = title, in batches         v1.5         6,607       0          0
   backfill (name IS DISTINCT FROM title): 11 batches, 18,287 rows changed; name ≠ title now: 0
4. deploy: read from name                  v1.5 → v2r   9,929       0          0
   rollback test                           v2r → v1.5   9,916       0          0
   forward again                          v1.5 → v2r   9,951       0          0
5. deploy: write only to name             v2r → v2     9,885       0          0
6. contract: drop title                     v2           4,959       0          0
   rows with an empty name at the end: 0
```

Zero errors and zero wrong reads at every step. And a rollback in the middle, also zero. The cost is **four deploys and two migrations** for one change, spread over days or weeks. That is the real cost of zero downtime: time and patience, not a tool.

Notice the line after step 5. At step 5, v2 writes only to `name`, and `title` goes stale. A rollback to v1.5 now would make v1.5 read a stale `title`. See it yourself in experiment 6. So step 5 is the **point of no return**, and before it give the new version enough time (say a week, a full business cycle). And before step 6 make sure nobody anywhere is reading `title`: other services, reports, ETL, the data warehouse sync.

**Four familiar mistakes**, each measured:

```
step                                        running      op    error  misreads
no dual-write: expand + backfill → v2       v1 → v2      9,942       0        278
   rows where name and title now differ: 3,711
contract too early: v1.5 still running    v1.5 → v2    9,944     880          1
   v1.5: column "title" of relation "boards" does not exist
expand didn't drop title's NOT NULL        v2r → v2     9,961     321          0
   v2: null value in column "title" of relation "boards" violates not-null constraint
backfill condition name IS NULL              v1 → v1.5    9,897       0          0
   then reading from name                v1.5 → v2r   9,858       0          3
   backfill (name IS NULL): 11 batches, 18,276 rows changed; name ≠ title now: 6
```

1. **Skipping the dual-write gives no errors, and that is the danger.** Straight to v2 after the backfill. During the rolling deploy, v1 instances write to `title` and v2 instances to `name`. 278 wrong reads in six seconds, and 3,711 rows with two different values in the two columns. No alert would fire. A user would see the board name they had just changed as it was before. And after the contract, the changes in `title` would be lost forever.
2. **Contract too early:** v1.5 is still running, and `title` is dropped. 880 errors, with the familiar message.
3. **Not dropping the old column's `NOT NULL` in expand:** v2 wants to create new boards with only `name`, `title` is still `NOT NULL`, so every new board fails. Expand is not only adding the new thing; it also needs **loosening the old thing's constraints**.
4. **The backfill condition `name IS NULL`:** the subtlest one, and my own first version of the exercise had exactly this mistake. During step 2's rolling deploy, a row is first written by v1.5 (`name = title = 'x'`), then by a v1 instance that is still alive (`title = 'y'`, `name` still `'x'`). The backfill looks for `name IS NULL` and does not touch this row. The result: six rows silently wrong, with no error. On a table of a million rows, over an hour-long rolling deploy, that number is in the thousands. The right condition is `name IS DISTINCT FROM title`. Once no v1 is running any more, `title` is the source of truth, and wherever the two differ, fix it. And after that, a verification query (`count(*) WHERE name IS DISTINCT FROM title` = 0) is mandatory before step 4.

**Alternatives.** The dual-write can live in the database instead of the app: a trigger that copies to `name` when `title` is written (and the reverse). Then v1 does not need changing at all, and step 2 is skipped. The cost is logic hidden in a trigger (5.2's discussion of triggers), and the risk of an infinite loop between triggers in both directions. Another path for a small rename is a view, or Sequelize's `field` mapping: change the name in the code, not in the database. Renaming a database column is often not worth that cost at all.

And this pattern exists outside the database too. Renaming an API field (add the new field → clients read both → delete the old field), changing an event's schema, 10.5's key rotation — all the same three steps: **add, move, delete.**

### 1.9 TaskFlow's decision

> **Trade-off Table — which strategy, what it buys, what it costs**

| Strategy          | What it buys                                                     | What it costs                                                            | When                                                        |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Big-bang          | Simplicity, speed (100% in 1 minute)                             | The full blast radius; rollback = another deploy                         | Dev/staging; small internal tools; when everything is small |
| Rolling           | No extra machines                                                | Caught slowly (12 min), version skew the whole time, slow rollback       | The default, if there is a gate and graceful shutdown       |
| Blue-green        | Code rollback in 30 s; full testing before the switch            | Double capacity; everyone at once on the switch; data does not roll back | Large, rare releases; stateful or long-warm-up systems      |
| Canary + gate     | A bug's damage in single digits; catches bugs no alert fires on  | Slow (30 min), the effort of a gate, statistics, sticky routing          | Any user-facing service with enough traffic                 |
| Feature flag      | Deploy ≠ release; a kill switch in 3 s; release by user in steps | Two code paths; flag debt; the same decision needed across services      | New features, risky changes, experiments                    |
| Expand / contract | The schema changes with zero errors, rollback at every step      | Four deploys, two migrations, weeks                                      | Any breaking schema / API / event change                    |

**Instances:** every service has separate `/ready` (200 when warm-up is done and not draining) and `/health` (whether the process is alive). On `SIGTERM`: readiness 503 → wait twice the LB's health check interval → `server.close()` → in-flight requests finish (a 20 s limit) → close the DB pool and queue consumers → exit. The orchestrator's grace period is 30 s. The LB retries idempotent requests (GETs, and POSTs with an `Idempotency-Key`) once.

**Rollout:** canary instead of rolling, in steps of 1% → 5% → 25% → 100%, each step with a minimum of 10 minutes **and** a minimum number of requests. Routing by a hash of the workspace's id (sticky; everyone in a workspace on the same version). The gate on 10.4's SLIs: success and p99 for opening a board, creating a task and login, canary versus a freshly started baseline over the same period, per segment (plan, region, web/mobile). If the gate fails, automatic rollback and a ticket. Keep every trace for a new version's first hour (10.4's tail sampling). Instead of one big deploy at 2 p.m., small deploys, several times a day. A small change's canary is fast, and if it breaks, finding the culprit is easy.

**Flags:** a flag service (or a vendor behind a standard API like OpenFeature), streaming push, a snapshot of the last known values on every instance (10.3). Split by `hash(flag + workspaceId)`. Decided once in the BFF, sent downstream in an `x-flags` header; the gateway drops any `x-flags` from the client. Every release flag has an owner and an expiry; a ticket to delete it 30 days after 100% is created automatically. Reusing an old flag's name is forbidden.

**Compatibility:** a question for every PR: "will this work with the previous version, in both directions?" Only additions to APIs. For events, consumer first, then producer. For mobile, the minimum supported app version is set by the server.

**Database:** migrations in a pipeline separate from deploys, and only in expand/contract steps. Every migration gets `lock_timeout = 2s`, a `statement_timeout`, and retries, plus a lint in CI that catches volatile defaults, indexes without `CONCURRENTLY`, constraints without `NOT VALID`, `RENAME`, and `DROP COLUMN` (unless tied to a contract ticket). Backfills in batches, watching replica lag, with the condition `IS DISTINCT FROM` and a verification query at the end. Reports on the primary are forbidden (7.6). The `Membership.scope` change follows this pattern, in six steps (reflection question 1).

---

## 2. Interview Angle

Deployment comes up two ways. Directly: "how would you deploy this with zero downtime?", "what is the difference between blue-green and canary?" And at the end of a design: "now you want to change the schema — how?" The weak answer is "Kubernetes rolling update, no downtime." The shape of a good answer:

1. **Start with the bridge.** "During a deploy, old and new run together: instances, clients, schema, messages in queues. So every change is N-1 compatible." This one line is the foundation of every other answer.
2. **A strategy, with its gate.** "Canary, from 1%, sticky by user, the gate on SLIs (errors and latency), per segment, automatic rollback." A canary without a gate is just a slow rolling deploy.
3. **Deploy ≠ release.** Risky features behind feature flags, with a kill switch.
4. **The database:** the expand/contract steps, and at least one detail about locks (the lock queue and `lock_timeout`, or `CONCURRENTLY`). That is the mark of a senior.

**Follow-ups that are almost certain:**

- _"Blue-green or canary?"_ — blue-green buys a fast code rollback with double capacity, but puts everyone at risk at once, and nothing rolls back if nobody knows. A canary keeps the damage small and catches bugs below the alert threshold, at the cost of time and a gate. Give numbers: for a 1% bug, blue-green hits 582 people in two hours, the canary 5.
- _"How do you rename a column?"_ — expand/contract: a new column, dual-write, batch backfill (`IS DISTINCT FROM`), move reads, write only the new one, drop the old one after waiting. And say after which step rollback is no longer safe.
- _"What happens when you add an index?"_ — a plain `CREATE INDEX` blocks writes; `CONCURRENTLY` does not, but cannot run in a transaction and leaves an `INVALID` index if it fails.
- _"How do you roll back?"_ — a code rollback and a data rollback are different. If the new version writes data the old one cannot read, there is no rollback. So keep every step rollback-safe.
- _"The risks of feature flags?"_ — flag debt, two code paths, mismatches across services, and reusing old flags (Knight Capital).

**In real production:** the most common mistakes: doing nothing on `SIGTERM` (a few requests die on every deploy, and everyone calls it "noise"). Combining readiness and liveness. A canary gate that looks only at errors, or at nothing. A random-request canary. Flags with `Math.random()`. Migration and deploy in the same step. No `lock_timeout` on migrations. `RENAME COLUMN` in one step. A backfill of millions of rows in one `UPDATE`. Never testing the rollback path.

---

## 3. Key Takeaway

- **A deploy is a bridge, not a jump.** Old and new run together in four places — instances, clients, schema, queues. So every change is N-1 compatible, in both directions; and a code rollback ≠ a data rollback
- **The order of graceful shutdown is everything.** Readiness 503 → wait until the LB removes it → `close()` → finish in-flight work. A sudden kill fails 5.3%, `close()` alone 4.7%, graceful zero. The LB's retry saves GETs, not POSTs
- **Being caught and stopping the damage are different.** Big-bang/blue-green catch a big bug in 1 minute, but by then everyone is at risk (4–5 thousand bad requests). A canary catches it at 1%, with 4–8 damaged. And a bug on 1% of traffic is caught by no alert; only by a canary (582 people versus 5)
- **A canary is only as good as its gate.** Looking only at errors, a latency bug goes all the way to 100%. SLIs (success + latency) and segments in the gate. A small canary means less evidence (a 25% chance of catching a small regression at 1% in 5 min). Repeated checking increases false alarms. And without stickiness a 5% canary touches 59% of users
- **Feature flags separate release from deploy.** Split by `hash(flag + user)` (random makes 88% of users jump, and without the flag's name the same users are in every experiment). A kill switch in 3 s versus a rollback deploy in 11 minutes. Make the decision once and send it along (otherwise 34% mismatched)
- **The real danger of DDL is the lock queue.** A 10 ms `ADD COLUMN` behind a long query blocks everything for 5.7 s; `lock_timeout` + retry bounds that to 200 ms. A volatile default rewrites the whole table. Indexes `CONCURRENTLY`. Backfills in batches (max write wait from 4.8 s to 36 ms). `NOT NULL` comes through `NOT VALID` + `VALIDATE`
- **Rename = expand/contract, six steps.** In one step, four thousand errors, and the rollback breaks too. In six steps, zero. And the most dangerous mistakes give no error at all: skipping the dual-write (3,711 rows differ), a backfill condition of `IS NULL` (silently wrong rows)

---

## 4. New Terms (Glossary)

| Term                      | Meaning                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploy / Release**      | Deploy = starting new code in production; release = showing users the new behaviour. Separating them with feature flags makes deploys harmless and frequent, and releases controlled and reversible                                         |
| **Blue-Green Deployment** | Two equal environments; the new version is built and tested on green, then all traffic moves in an instant. Code rollback in seconds, at the cost of double capacity; one database, so no data rollback                                     |
| **Canary Release**        | The new version first on a small share of traffic (1% → 5% → …); an automatic gate compares the canary's SLIs with a baseline over the same period, and advances or rolls back. Sticky by user, compared per segment                        |
| **Feature Flag**          | A condition in code whose value changes at runtime without a deploy — release, kill switch, experiment, permission. Split by `hash(flag + user)`; decided once and carried with the request; release flags must be deleted                  |
| **Version Skew**          | Parts of a system on different versions at the same time (instances, clients, producer/consumer, code/schema). The normal state; so every change is N-1 compatible, and the new version writes nothing the old one cannot read              |
| **Lock Queue**            | The line waiting for a lock. Behind a DDL asking for ACCESS EXCLUSIVE behind a long transaction, every new query (reads included) lines up. The remedy is `lock_timeout` + retry                                                            |
| **Expand / Contract**     | Splitting a breaking change into small steps that can each be deployed and rolled back — add the new one, write to both, backfill, move reads, write only the new one, finally delete the old one; old and new code both work at every step |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. 10.5's change: `memberships` (3 million rows) currently has a unique constraint on `(user_id, workspace_id)`. Guests need a new `project_id` (null means the whole workspace) and `role`, with uniqueness on `(user_id, workspace_id, project_id)`. Plus `loadBoardFor`'s new logic that understands guests. (a) Write the schema and code steps in order: at each step which DDL (with its lock), which code version is running, and where rollback is no longer safe. (b) Why is changing a unique constraint a special problem, and how will you do it without downtime? (c) How will you release the new guest feature, and which segments must be in the gate for `loadBoardFor`'s new logic's canary?

2. TaskFlow's billing service receives Stripe webhooks, 2 a second on average. And at midnight on the 1st of the month a job creates invoices for every workspace. (a) For a new version of the webhook handler, a 1% canary for 10 minutes — how many requests will the canary see, and why is catching a +1% regression with that impossible? Give three alternative paths. (b) How will you "canary" a new version of the invoice job, when it runs once a month? (c) Where does the cost of a mistake differ here from other services, and how does that change the strategy?

3. In the mobile app's API, `assignee: "email@x.com"` (a string) in a task's JSON has to become `assignee: { id, email, name }` (an object). Old app versions in the app store keep running for up to six months, and 5% of users never update. (a) Give an expand/contract plan for the API, with every step. When will you do the "contract", and on what basis? (b) How will you know which app versions how many people are running, without breaking 10.4's cardinality rules? (c) What decision will you make about the 5% who will never update?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) The steps:

```
step schema / data                                         code                          rollback
1    ADD COLUMN project_id bigint NULL,                     v1                            yes
     ADD COLUMN role text NOT NULL DEFAULT 'member'
     (both instantaneous: null and a constant default; lock_timeout + retry)
2    CREATE UNIQUE INDEX CONCURRENTLY memberships_scope_uq  v1                            yes (drop the index)
     ON memberships (user_id, workspace_id, COALESCE(project_id, 0))
3                                                          v1 → v2 (understands guests,   yes → v1, as long as no
                                                           new logic behind a flag, off)  guest row has been created
4    (no backfill needed: project_id null on old rows =    v2, flag turned on in steps    yes → flag off
     the whole workspace — exactly the right meaning)
5    drop the old unique constraint                        v2, guests can be created      ✗ not v1 any more — v1 does
                                                                                          not understand guest rows
6    delete the flag and the old code path                 v3                             ✗
```

The point of no return is step 5: the moment the first guest row is created. After that, going back to v1 would make v1 treat a guest as a member of the whole workspace, because it does not look at `project_id`. That is a **security** bug (10.5's BOLA). So an extra earlier step for v1 is good: change v1's `loadBoardFor` so that it **ignores** rows where `project_id IS NOT NULL`. Then v1 too "sees the new data and safely stays quiet", and rollback stays safe. This is the real meaning of N-1 compatibility: the old version has to know at least enough about new data not to make mistakes.

(b) With the old unique `(user_id, workspace_id)` in place, a user cannot be a guest in two projects of the same workspace (two rows, same pair). And dropping the old one first leaves a window for duplicates to slip in. The right order: create the new unique index **first**, `CONCURRENTLY` (step 2). If `CONCURRENTLY` finds a duplicate while building, the index fails as `INVALID`, and then the data has to be cleaned and it run again. The two constraints coexist for a while, then drop the old one (step 5, instantaneous). The null problem: in a Postgres unique index two nulls count as different, so `(u, w, NULL)` could go in twice. Hence an expression index like `COALESCE(project_id, 0)`, or Postgres 15+'s `NULLS NOT DISTINCT`.

(c) Release: the guest feature behind a flag, per workspace. First our own workspaces, then a few beta customers, then by plan. In the gate for `loadBoardFor`'s new logic's canary, **segments are a must**: (1) workspace size (Thursday's bug was on big workspaces), (2) plan, (3) the kind of actor — owner, member, guest. Authorization bugs often give no error, they give a wrong 200. So the gate needs a **behavioural** comparison alongside the error rate: the canary's and baseline's share of 404s (a sudden drop means someone is getting something they did not get before). Plus 10.5's matrix test, in CI, before the deploy. A canary will not catch a bug that "grants more permission" with no error, so that is the test's job.

**Question 2:**

(a) 2 req/s × 600 s × 1% = **12 requests**. Say baseline errors are 0.5%; +1% means 1.5% on the canary: an expected 0.18 errors in 12. No test can conclude anything from one error. In 1.4's table's terms, evidence comes from the number of requests, and here there are none. Alternatives:

- **A bigger percentage, a longer time:** 25% for 24 hours ≈ 43,000 requests. The risk falls on more people, but the evidence arrives.
- **Shadow traffic:** send the new version a copy of the real webhooks, but without using its responses or side effects (DB writes), only comparing with the old one: did it make the same decision? Testing on 100% of traffic, at zero risk. The cost: keeping side effects separate is hard.
- **Replay:** run last week's webhooks (with idempotency keys, 2.5) against the new version in staging and compare the results.
- And a gate on a **business metric**: "after every `invoice.paid`, did the workspace become active?" More meaningful than the error rate.

(b) A job that runs once a month is canaried with data, not time. (1) **A dry run:** the day before the 1st, the new version **computes** every workspace's invoice but does not send it; each is compared with the old version's result, and a human looks at the list of differences. (2) **A canary by workspace:** on the 1st the new version creates invoices for only 1% of workspaces (by hash), the old one does the rest; an hour later, look at the results and complaints, then do the rest. (3) A kill switch inside the job that can stop it midway, and an idempotent job, so stopping and restarting does not give anyone two invoices.

(c) A money mistake **cannot be undone** (or only with difficulty, and the customer's trust goes). After a 500 error on a board the user tries again. After a wrong charge come refunds, apologies, maybe legal questions. So here the rollout leans toward slow and careful: a mandatory dry run, a small and long canary, business metrics in the gate, and deploying on a day of the week that is not month-end and when the team is around. The cost is slower speed, which is cheap here.

**Question 3:**

(a) Expand/contract for the API:

1. **Expand:** add a new field, keeping the old one: `assignee: "email@x.com"` stays, and next to it `assigneeInfo: { id, email, name }`. (You cannot change the shape under the same name. An old app will parse `assignee` as a string, and crash when it gets an object.) The server sends both and accepts both (either one when creating a task).
2. **A new app version** reads and sends only `assigneeInfo`. Release it.
3. **Wait and measure:** which app versions still use `assignee` (see b below).
4. **Contract:** when usage by app versions that read `assignee` falls below a decided threshold (say 0.5% of active users, or six months, whichever is later), raise the minimum supported version (c), then stop sending `assignee`. The new name `assigneeInfo` stays. If you like, another cycle can bring the name `assignee` back, but usually it is not worth the cost.

The basis for the contract is not a date but **measured usage**. And after the contract, keep counting "requests asking for the old field" on the server for a few weeks.

(b) The app sends its own version in a header on every request (`x-app-version: 4.12.0`). Putting `app_version` directly as a metric label makes every new version a new series, and old versions stick around for years. Cardinality grows slowly, but not unboundedly. The way to keep it bounded under 10.4's rules: only **major.minor** in the label, and everything outside the newest 10 becomes `old`. The details (exactly which patch version) go in logs and traces, where cardinality costs nothing. And a separate counter: "requests using the old `assignee` field, by `app_version` (major.minor)" — that is what the contract decision is based on.

(c) This is a business decision, not only an engineering one. Paths: (1) **A server-driven minimum version:** an endpoint that tells the app on startup "the minimum supported version is 4.0", and below that the app shows an "update please" screen. This should exist from the app's very first version; it cannot be added later. (2) Announce a deadline, in the app and by email, a few weeks ahead. (3) For very old apps a thin compatibility layer (a BFF, 9.2) can be kept, if that 5% includes big customers: the old shape only in that BFF, not in the main API. Supporting the 5% forever means every API change exists in two shapes forever. Someone has to pay the cost of version skew, and the decision is who.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (three deterministic simulations; a rolling restart with real HTTP on localhost; two labs on real PostgreSQL, with Docker)

> **Ready to run in the repo:** [`exercises/lesson-10.6-deployment/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.6-deployment) — `docker compose up -d --wait`, `npm install`, then `npm run rollout`, `npm run flags`, `npm run drain`, `npm run locks`, `npm run rename`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`rollout` runs three kinds of bug through six strategies, measures the cost of a good version, shows the statistics of canary size and duration, and compares sticky with random routing. `flags` covers percentage splits, kill switch speed, and mismatches between two services. `drain` runs five kinds of rolling restart with a real round-robin LB and four `node:http` instances on localhost. `locks` measures `ALTER`, indexes, backfills and `NOT NULL` on real Postgres, next to a million rows with live app load. `rename` runs four kinds of app version on the same table on real Postgres and Sequelize: a one-step rename, expand/contract, and four mistakes.

**Honest notes:** Verified by running in the sandbox on Node 26 and PostgreSQL 17.11 (Docker): `tsc --noEmit`, ESLint and Prettier clean. `rollout` and `flags` twice each, output identical byte for byte. `drain`, `locks` and `rename` twice each. The numbers are close, and the zeros and the order are the same. The numbers quoted in the lesson come from one run each, and where a second run's numbers differ, that is said. The README's experiments 1 and 3 were run (numbers in the lesson); 2, 4 and 5 are yours to run, and 6 is a code-changing task, also yours. **`rollout` and `flags` have no real servers.** Fake requests, a seeded PRNG. 10 minutes for a human after an alert, 5 minutes for big-bang's rollback deploy, 10-minute canary steps, segment = 1% of traffic, baseline errors 0.1%: these are assumed numbers. The capacity shortfall while every instance restarts at once under big-bang is not in the model. `drain`'s LB is hand-written, not a real Nginx or Envoy. The instances are in one process, and their work is faked with `setTimeout`. `locks`'s timings depend on your machine, and the numbers at a million rows will be many times bigger at 100 million (not measured here). `rename`'s "wrong reads" column counts excluding races between concurrent writes. In some of the mistake rows (contract too early, NOT NULL) a wobble of 0–7 was seen, partly the limits of measurement. The main evidence is the error counts and the SQL verification query (`name IS DISTINCT FROM title`). **Not measured:** real Kubernetes, real canary tools (Argo Rollouts, Flagger), a real flag service, replica lag and WAL (5.7), mobile clients. The SRE book's 70% claim and the account of Knight Capital come from published writing, not verified here. The Express and Sequelize code in 1.2 and 1.7 is a design, not run. TaskFlow's decision in 1.9 is a design.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `rollout`, write down: a bug with 20% errors on 1% of traffic. What will the whole system's error rate be, and will the "error > 1%" alert fire? How many people will blue-green touch? Then run it and compare. Now `STEP_MINUTES=3`. Which canary lost the bug, and which caught it? Why?

2. **Your own graceful shutdown:** put 1.2's `shutdownOnSigterm` and `/ready` into a small Express app. While putting load on it with `autocannon` or a loop, `kill -TERM <pid>`. How many requests failed? Now remove the handler and do it again. Then set `drainMs` to zero. Do you get a result like the "only `close()`" row?

3. **The lock queue with your own eyes:** `LONG_QUERY_MS=20000 npm run locks`. In the lock queue row, what was the app's max latency? While it runs, in another terminal, run `SELECT pid, wait_event_type, state, left(query, 50) FROM pg_stat_activity WHERE datname = 'taskflow'` with `psql`. Can you see who is waiting for whom? (Look at `pg_blocking_pids(pid)` too.)

4. **The point of no return:** in part B of `src/rename.ts`, add a `v2 → v1.5` rollback step after step 5 (`v2r → v2`). Did you get errors, or wrong reads? Why was the rollback after step 4 safe, but not this one?

5. **The design part:** a one-page design of TaskFlow's deploy pipeline. (a) Every step from a PR merge to 100%, and who or what approves each step. (b) The canary gate's list: which SLIs, which segments, which thresholds, how many requests at minimum. (c) How the migration pipeline is separate from the deploy pipeline, and what the CI migration lint catches. (d) Deploying on a Friday afternoon: yes or no, and why? (e) Which steps of this pipeline can an urgent security fix (like 10.5's) skip, and which never?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1, 10.2, 10.3, 10.4, 10.5
Current: 10.6 — Deployment: blue-green, canary, feature flag, zero-downtime migration
TaskFlow state: modular monolith + billing; gateway + BFF; saga; breaker + bulkhead; rate limits; cache
ring; Bloom/HLL; hard/soft dependencies + brownout; OpenTelemetry, burn rate alerts; AuthN/AuthZ (jose,
scoped loaders, matrix test), refresh rotation + denylist, OAuth PKCE, secret manager, credential stuffing
and DDoS layers. A bad week: SIGKILL on every deploy (in-flight requests die, cold instances get traffic,
duplicate tasks); a 10 ms ADD COLUMN behind a report in the lock queue took the site down for 3 minutes;
title → name renamed in one step (old instances break, the rollback breaks more, 25 minutes); a 1% segment
bug in loadBoardFor under blue-green — no alert, four days; a Math.random() flag (88% of users jump), BFF
and API hashing differently (34% mismatch), a 5-minute poll. Now: /ready and /health separate; SIGTERM →
readiness 503 → wait 2 health checks → close() → in-flight finishes (20 s) → pool closed; the LB retries
idempotent requests once. Canary 1→5→25→100%, a minimum time + requests per step, sticky by workspace
hash, gate on SLIs (success + p99), per segment (plan/region/web-mobile), against a fresh baseline,
automatic rollback; small, frequent deploys. Flags: streaming push + snapshot, hash(flag + workspace),
decided once in the BFF → x-flags header (the gateway drops the client's), owner + expiry, name reuse
banned. N-1 compatibility: only additions to APIs, consumers first for events. DB: migrations in a
separate pipeline, only expand/contract; lock_timeout 2 s + statement_timeout + retry; CI lint (volatile
default, index without CONCURRENTLY, constraint without NOT VALID, RENAME, unlinked DROP); backfills in
batches, watching replica lag, condition IS DISTINCT FROM, a verification query; reports on the primary
banned. Membership.scope in six steps.
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7), Deploy / Release, Blue-Green Deployment, Canary Release, Feature Flag,
Version Skew, Lock Queue, Expand / Contract
Weak spots: [where you got stuck — write it yourself]
Next: 10.7 — Cost & cloud economics: cost as a first-class constraint in design
=======================
```

---

## 8. Next Step

Today's thread: **every deploy is a bridge, and for a while old and new walk on it together.** Follow an order when replacing instances, and not a single request dies. Choosing a strategy is really answering two questions: how many people will a bad version touch, and who will catch it. A canary is only as good as what its gate looks at. Flags separate release from deploy. And in the database the most dangerous mistakes give no error at all. They silently split the data in two, and turn a 10 ms migration into a three-minute outage.

Today I sidestepped one thing several times by naming its price: blue-green's double machines (+12), the canary's extra pool and baseline, every trace from a new version's first hour, computing the month's invoices twice in a dry run. The autoscaling bill in 10.5, log volume in 10.4. Every safety measure and every bit of visibility has a monthly price, and nobody writes that price down at design time. When you are ready, write `next` — we go to **Lesson 10.7: Cost & Cloud Economics**. The question there: where TaskFlow's monthly cloud bill comes from, how much money each design decision is worth, and why "cost" has to be treated as a requirement, just like latency and availability.
