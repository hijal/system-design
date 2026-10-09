# Module 10 - Exit Challenge (Reliability, Security & Operations)

**Module 10 - Reliability, Security & Operations**

That is the eight lessons of Module 10. Eight layers now sit on TaskFlow: the cache ring (10.1), Bloom filters and HyperLogLog (10.2), the dependency matrix, brownout and static stability (10.3), traces, histograms and burn rate (10.4), AuthN/AuthZ, secrets and the DDoS layers (10.5), graceful shutdown, canaries and expand/contract (10.6), unit cost and anomalies (10.7), and DR, cells and data residency (10.8). Each lesson measured one question in isolation. In reality one bad night brings them all at once. And it brings one more thing that no lesson measured on its own: **time.** Over six months, small decisions pile up on every safeguard. A test switched off as "flaky", a TTL removed "for performance", a game day pushed to "next month". Nobody breaks a safeguard on purpose; each one erodes in its own way. This Exit Challenge is one such night.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** six months after 10.8's decisions were put in place. This week you are in charge of incident review, and in front of you is a timeline from Friday night to Monday. TaskFlow's current state (some things follow this module's lessons, some have changed over the six months):
>
> - **Region:** Singapore, three AZs. The Postgres primary in AZ-a, Patroni's sync standby in AZ-b, a read replica in AZ-c. An async replica in Mumbai (pilot light), and Mumbai's app stack written in IaC, switched off. The normal monthly bill is ~$14,200.
> - **DR runbook:** first line: "If the Singapore region is down → fail over to Mumbai." RPO ~5 s and RTO ~40 minutes written down. Game days are supposed to happen every six months. The last one was eight months ago, and its failback part was dropped "for lack of time".
> - **EU cell:** in Frankfurt, running for three months, two customers (including the German one, 6,000 seats). The global layer (workspace → cell routing, the identity directory, billing) is in Singapore, with a cache of it in each cell.
> - **Secrets:** one secret manager, in Singapore, with its endpoint in AZ-a. Mumbai's stack fetches secrets from it at boot.
> - **Cache:** the move to Redis Cluster is "next quarter", and has been for two quarters. Still a client-side ring, 160 virtual nodes, membership in the registry. Last month the "`FLUSHALL` before returning to the ring" step was switched off, because "every flap sends a wave of misses to the DB." And a performance PR removed the TTL from the `members:{workspace:<id>}` key. `loadBoardFor` reads this key to check membership. The PR's description: "membership rarely changes, and when it does it's invalidated anyway."
> - **Share links:** a Bloom filter in each instance, rebuilt hourly, added to through outbox events, with a "last 5 minutes" recent set in the cache ring. At the edge the cache key is the path only. Bot scores only on login and sign-up.
> - **Board:** last month a new "AI summary" panel. The BFF calls an external LLM API, with the library's default timeout of 30 s, in the same `Promise.all` as the board's other parts. The brownout's three-level list dates from 10.3; the new panel is not on it. CI's fault injection test has been `skip`ped for two months, because it is "flaky".
> - **Deploys:** canary 1% → 5% → 25% → 100%. The gate on SLIs, with a minimum of 10 minutes and 20,000 requests per step - but as totals, not per segment. Alongside, an expand/contract is in progress: the backfill of `tasks.priority` (step 3). The backfill runs in batches and pauses on replica lag - but only the lag of the AZ replicas.
> - **Observability:** two OTel collector instances, both in AZ-a ("to save cost"). Burn rate alerts on opening a board, creating a task and login.
> - **Cost:** an autoscaling maximum of 40. Cost anomalies measured daily per category, with tickets going to the team named in the resource's `team` tag.
>
> **Friday to Monday (Singapore time):**
>
> 1. **Friday 19:40.** Storage and network trouble in AZ-a: disk p99 at 400 ms now and then, and 3% packet loss from AZ-a to the other two AZs. Nothing is "down". Every health check is green, and the cloud provider's status page is green. At 19:46 the board's fast-burn page fires: success 97%, p99 2.8 s.
> 2. **19:50 – 20:15.** The brownout controller goes up to level 3, yet board success falls to 81%. The LLM provider itself is healthy. On-call opens the traces and finds almost none from the last half hour.
> 3. **20:05 – 20:45.** AZ-a's `cache-4` drops out of the ring and comes back four times in 40 minutes.
> 4. **20:10 – 20:42.** A 32-minute argument on the incident call. The runbook says "if the region is down", but the region is not down. One person says "let's move out of AZ-a", another says "Mumbai". At 20:42 the decision: Mumbai.
> 5. **20:42 – 21:40.** At 20:51 Mumbai's replica is promoted. At that moment its lag was **94 seconds**, because WAL from the backfill running since 19:00 had piled up on the cross-region link. Mumbai's app stack sits in a crash loop for 18 minutes: at boot, fetching secrets from the secret manager times out. Someone puts the secrets in by hand and starts it. DNS is changed at 21:12 (TTL 60 s). Mumbai's cache is empty, and Mumbai's DB sits at 100% CPU for 15 minutes. Partway through, someone adds four new cache nodes to Mumbai's ring at once. At 21:40 boards are normal.
> 6. **21:12 – 21:24.** Singapore's old primary had not died - it was only slow. With DNS's tail traffic (still 9% of traffic after 5 minutes), Singapore's app instances kept writing there for 12 minutes. **1,870 writes** in total, none of them in Mumbai. Nobody shut down the old primary, because the runbook assumed "the region is dead anyway".
> 7. **21:30 – 01:30.** A flood on the share page: `/s/<random 22 characters>`, 45,000 requests a second from 30,000 IPs. At the edge every path is different, so every one misses. Mumbai's autoscaling reaches 40 in 6 minutes and stays there for four hours. The Bloom filter turns away over 99% of missing slugs before the DB, so the DB survives. But the app's CPU is full, and legitimate users' boards are slow. At the same time, complaints arrive at support: "new share links give 404." Two kinds: (a) links created in Mumbai after 20:51, for 50 minutes, because Mumbai's IaC had no outbox relay worker; (b) some links created in Singapore between 19:40 and 20:51, whose emails have already gone out. These will never open again.
> 8. **22:15.** Before the incident, a deploy's canary was at 25%. After the failover the gate sees green SLIs in Mumbai and advances by itself, reaching 100% at 22:40. The new version has a bug: 6% of task creations fail in the EU cell. At the 25% step, 310 requests came from the EU (out of 41,000 in total), 12 of them task creations. The German customer escalates on Monday.
> 9. **Saturday 02:10.** At 20:30 on Friday a workspace's admin removed a contractor from the workspace. At 02:10 that contractor opens a private board and exports 212 tasks. The export is in the audit log. `loadBoardFor` got the membership from the cache.
> 10. **Saturday morning.** Leadership asks: "How many people were affected?" An analyst takes `PFCOUNT` of every workspace's Friday and Saturday daily HLLs separately and adds them all up: **41,300**. Finance proposes a credit per affected seat based on this number. Another engineer gets **19,800** from the logs.
> 11. **Saturday to Monday.** Failback was never practised, so the team waits for Monday. During the incident someone had switched off scale-in in Mumbai "so instances don't get removed", and nobody switched it back on. Monday's failback: copying 1.8 TB afresh to make Singapore a replica of Mumbai.
> 12. **The month's bill: $23,900** (normally ~$14,200). The extra $9,700 in lines: Mumbai's app, 40 instances for ~60 hours, **$3,100**; Mumbai's DB at a big size during the failover, three days, **$1,280**; log ingestion **$2,950** (`LOG_LEVEL=debug` in Mumbai's IaC, since the game day eight months ago); CDN requests and WAF **$940**; cross-region transfer (re-seed and replication) **$60**; everything else **$1,370**. A cost anomaly ticket was opened on Saturday morning, in the name of `team: platform`. That team was disbanded four months ago.
> 13. **The CEO's question:** "We built every single thing from Module 10: DR, canaries, Bloom filters, burn rate alerts, cells, cost alerts. And still a night like this. Do these things not work, or did we build the wrong things?"

Your task: for each question below, make a decision by applying Module 10's concepts (and earlier modules' where relevant), with reasoning. Wherever possible, use **numbers**.

**1. Not the region - an AZ (Lessons 10.8 + 10.3 + 6.1)**
What actually broke at 19:40: the region, or one of its failure domains? In 6.1's and 10.3's terms, what is this kind of failure called - "slow but not dead, health checks green" - and why could the runbook not catch it? Compare three paths: (a) wait; (b) leave AZ-a (move the primary to AZ-b with Patroni, move AZ-a's app instances and cache nodes); (c) Mumbai. Give each one's RPO (the sync standby versus async Mumbai), RTO and risk. Which would you choose, on which signal, and within how many minutes? Then rewrite the runbook's first page: on which signal which decision, who makes it, and after how long it is "stop arguing, decide".

**2. The AI panel and the brownout (Lessons 10.3 + 10.7)**
Board success fell to 81% although the LLM provider was healthy. Write out the path: which instances, which network path (one of 10.7's decisions is hiding here), which timeout, and which `Promise.all`. In the board journey's dependency matrix, which cell did the panel actually land in, and which cell should it have been in? Taking the LLM provider's SLA as 99.5%, how far does the panel being hard lower the ceiling on the board's availability (in the manner of 10.3's 99.301% arithmetic)? Why did the brownout change nothing even at level 3? This failure was made possible by three things together: the panel, the brownout's old list, and the skipped test. For each, give a rule that does not depend on any person remembering it.

**3. 94 seconds and 1,870 writes (Lessons 10.8 + 10.6 + 6.1 + 5.7)**
(a) The runbook says RPO "~5 s"; it was really 94 s. Explain why, combining the backfill, the WAL and the cross-region link. If RPO is not a constant, then what is it? Which metric would show it, and which alert? Which replicas should the backfill's lag check have included?
(b) The split brain from 21:12 to 21:24: why two primaries, and which assumption in the runbook made it possible? Even with failover in human hands, which tools are needed, and in what order (promote first, or fence first)? What would 10.8's witness have changed?
(c) There are now two separate sets: 1,870 writes that are in Singapore but not in Mumbai; and the last 94 seconds of writes that are in Singapore but not in Mumbai. What will you do with them during failback? Which can be reconciled automatically and which need people (task edits, share links, plan payments)? And what will you tell customers?

**4. The original's shadow on the backup (Lessons 10.3 + 10.5 + 10.8)**
Mumbai's stack sat in a crash loop for 18 minutes because the secret manager is in Singapore. Which of 10.3's principles does this violate? Make a list of every dependency of Mumbai's stack that might live in Singapore, at least six (besides secrets: identity's signing key and JWKS, flags, the registry, container images, the outbox relay, ...). For each, say how you will keep it in Mumbai in advance, without breaking 10.5's rules (where the secret's copy lives, who can read it). There was a game day eight months ago - so why were none of these caught? Besides game days, what does it take to catch drift like `LOG_LEVEL=debug`? The same question for the EU cell: from 19:40 to 21:40 Singapore's global layer was slow. Which of the EU cell's functions kept running, which could not have, and why?

**5. The removed contractor, and the cold cache (Lessons 10.1 + 10.5 + 4.6)**
(a) Explain the 02:10 export step by step: after the 20:30 removal, which node did the cache delete go to, why did `cache-4` come back with the old list, and which two decisions together let the mistake last six hours. Which of 10.1's three remedies were switched off that night? Why was 10.5's denylist of no use here? The biggest question: should an authorization decision be read from a cache at all? If yes, under what conditions (what TTL, how invalidated, and for which actions re-checked against the DB, such as export)? Is this a security incident to disclose to the customer, and what will you pull from the audit log?
(b) What 4.6 event is a failover onto Mumbai's empty cache? Why is adding four nodes at once in the middle of a stampede a bad idea, even on a ring (think of 10.1's weights and single-flight)? How will you keep the pilot light's cache "warm", and what is its monthly price?

**6. The share link flood and two kinds of 404 (Lessons 10.2 + 10.5 + 10.7)**
(a) Why was the edge cache no help, even though the cache key was normalized? What did the Bloom filter save and what did it not? At which layer should this attack be stopped, and with what? Give at least three ways (such as a bot score on the share page, checking the slug's shape at the edge, a challenge), and what cost each puts on legitimate users.
(b) Separate the two causes of "new link 404". The first is a Bloom filter false negative: which point from 10.2 explains it? Which safety net (the fail-open condition, the recent set, a metric) should have worked, and why did it not? The second is not the Bloom filter's fault. Then whose?
(c) Autoscaling sat at 40 for four hours. Did this limit do its job? What is the trade between cost and availability here? And roughly what would the bill have been if the flood had been stopped at the edge (in the manner of 10.7's DDoS arithmetic)?

**7. A canary in the middle of an incident (Lessons 10.6 + 10.4)**
The pipeline advanced by itself while the incident was going on. Which rule was missing, and where will the rule live: will people remember it, or will the pipeline itself know? The gate "passed" at 25%. (a) After the failover, was the comparison between canary and baseline still meaningful? (b) Of the 310 requests from the EU, 12 were task creations. With a 6% failure rate, how many extra failures would you expect in those 12? Could any gate catch that? What will a per-segment minimum-request rule look like? And for a small segment like the EU cell, what will you do: more time per step, or a separate canary per cell? Finally, the backfill (expand/contract step 3): during an incident, who stops it, and how?

**8. Seeing in the dark, and one wrong number (Lessons 10.4 + 10.2)**
(a) Why were the traces missing exactly when they were most needed? What will the rule be for where collectors run? When the tail sampling collector comes under strain, give an order for which traces it keeps first and which it drops first.
(b) Why is 41,300 wrong, and in which direction? There are at least three separate mistakes. What would the correct HLL calculation have been, with the Redis command? Why still not give credits from HLL? Give the definition of "affected" in the language of an SLI: which journey, which threshold. Where can 19,800 credibly come from (which of 10.4's log lines)?
(c) Name at least four alerts that should have fired that night and did not (such as Mumbai's replica lag, ring membership flapping, per-segment SLIs, on share links "the filter said no but the recent set has it"). For each, page or ticket?

**9. The bill (Lesson 10.7)**
Put each line of the extra $9,700 into one of two groups: the **fair** cost of DR (spending that a disaster is supposed to bring) and waste. Which line is the biggest waste, and which rule from which lesson would have prevented it? What did you learn from the cross-region transfer line ($60)? Why did the cost anomaly ticket reach nobody, and which other failure of this night does it resemble? The later the failback, the more which lines grow? Who sets a deadline for failback, and by what arithmetic?

**10. The CEO's question, and priorities (Lessons 10.1 – 10.8)**
(a) The answer to event 13 in one paragraph, without blame: whether the tools work, and what the common thread behind this night's failures is. Also say which safeguards did work properly (there are at least three).
(b) A **priority list**: what this week (before it happens again), what this month, and what this quarter. Next to each, write which lesson, which event it would have prevented, and how success will be measured (which metric, which number).
(c) A **safety net inventory**, at least ten lines. In each line: what the safeguard is, who owns it, and **how you will know it is still switched on** (a test, a metric, or a practice). Where will a safeguard whose last cell is empty be in six months?

**Things to remember:** this module has four places where mistakes come most easily. (a) **Designing for clean failure** when real failure is grey. The runbook assumes "region down", the health check looks for "dead", the failover assumes the old primary is dead. In reality most nights are "slow, partial, and healthy-looking from outside". (b) **Treating a safeguard as a one-off job.** Flushes, TTLs, tests, game days, tag owners - each gets switched off one day by someone for a reasonable reason. A safeguard nobody measures as being on is, eventually, not there. (c) **The backup path depending on the original.** If the DR stack's secrets, images, config and workers come from the original region, the backup is useless on exactly the day it is needed. (d) **Giving authority to approximate or cached data.** Membership from a cache, credits from HLL, a canary's verdict from total requests. Each tool is right for its own job, but where a decision involves money, permissions or customers, it needs a source of truth. Today's scenario has all four, several times over. And Module 10's most important habit: for every safeguard, ask **"on the day this quietly switches off, how will I know?"**

I will critique this step by step.

---

## 2. Self-Check - By the End of This Module You Should Be Able To

- [ ] Say with numbers how many keys move with `hash % N` going from N to N+1 and **where** they go; how a hash ring brings the movement down to the new node's share
- [ ] Explain why virtual nodes are needed, how many, and their cost; the trap of "the next 3 points" when choosing replicas, and the distinct-node and distinct-AZ rules
- [ ] State what consistent hashing does not do: no consistency (a node returning with old data), no fix for hot keys (the cost of bounded load), and no responsibility for membership; why Redis Cluster's hash slots are not a ring
- [ ] For probabilistic structures, ask first "which direction is the error"; a Bloom filter's size (~9.6 bits per item for 1%), its silent decay when overfilled, and false negatives that come from the system
- [ ] Negative cache versus Bloom filter, when to use which; HyperLogLog's memory and error, why merging is magic, and why never for billing; what a Count-Min Sketch is good and bad at
- [ ] The difference between a fault and a failure; build a matrix of a journey's hard and soft dependencies, and compute availability as the product of hard dependencies
- [ ] Why a soft dependency without a timeout is really hard; why the redundancy formula breaks on correlated failures, and what a failure domain is
- [ ] Brownout versus load shedding; static stability (last-known-good, snapshots, no crash at boot) and its cost
- [ ] Design a chaos experiment: steady state, hypothesis, blast radius, control group, abort conditions
- [ ] Monitoring versus observability; why the average hides the tail, why percentiles cannot be added, and where to keep histogram buckets dense
- [ ] Compute the cost of label cardinality, and know which information goes in metrics and which in logs and traces
- [ ] How a distributed trace is joined (`traceparent`, context propagation); head versus tail sampling; the difference between a multi-window burn rate alert and "error > 1%"
- [ ] AuthN versus AuthZ; the rules of JWT verification (algorithm allowlist, trusted keys, `iss`/`aud`/`exp`); what BOLA is and how scoped loaders and route × actor tests stop it
- [ ] The trade-offs of token lifetime, refresh rotation, reuse detection and denylists; which attacks state and PKCE stop in the OAuth code flow
- [ ] Why rotate first when a secret leaks; reducing blast radius with secrets' lifetime and splitting; why credential stuffing evades per-IP limits; volumetric versus L7 DDoS, and which layer stops which
- [ ] The correct order of graceful shutdown; the blast radius of big-bang, rolling, blue-green and canary; a canary's gate, segments and statistical limits
- [ ] Separating deploy from release with feature flags (sticky splits, one decision); version skew; DDL's lock queue, `lock_timeout`; the six steps of a rename with expand/contract
- [ ] Read a bill by cost's four drivers; unit economics; which part gets autoscaling, commitments and spot; the storage tier traps; the hidden costs of NAT and cross-AZ transfer; per-category anomaly detection
- [ ] Separate multi-region's three reasons (latency, DR, residency); why distance multiplies across round trips; choose a DR strategy by RPO and RTO, with its price
- [ ] DNS failover's tail, split brain and the witness; the silent loss of writing in several regions; put together a design with home regions, cells and data residency

---

## 3. Recommendation

**To read:**

- **Google's _Site Reliability Engineering_ and _The Site Reliability Workbook_.** Both free to read. The Workbook's "Alerting on SLOs" chapter is the real source of 10.4's burn rate, step by step, with the weaknesses of each alerting rule. The main book's "Managing Incidents" and "Postmortem Culture" chapters will be directly useful for this challenge's question 10.
- **The Amazon Builders' Library articles:** "Static stability using Availability Zones", "Avoiding fallback in distributed systems", "Timeouts, retries, and backoff with jitter". The reasoning behind almost every decision in 10.3 and 10.8, written from AWS's own mistakes. Along with AWS's whitepaper "Reducing the Scope of Impact with Cell-Based Architecture", the deep form of 10.8's cells.
- **Charity Majors, Liz Fong-Jones, George Miranda - _Observability Engineering_.** The best explanation of 10.4's "unknown questions", wide events, and why high-cardinality data does not belong in metrics. Some parts are written from one vendor's point of view; keep that in mind as you read.
- **The OWASP API Security Top 10.** BOLA is number one on the list, and every risk comes with example attacks. 10.5's Monday incident is written right there. For JWTs, RFC 8725 ("JSON Web Token Best Current Practices"), short and direct.
- **J.R. Storment, Mike Fuller - _Cloud FinOps_.** The process side of 10.7's tags, owners, showback and anomalies. Who makes which decision, and how engineering and finance look at the same numbers.
- **The original papers, short and worth reading:** Karger et al., "Consistent Hashing and Random Trees" (1997); Flajolet et al., "HyperLogLog" (2007); Lamping & Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (jump hash, 2014). Reading just the opening of each shows where 10.1's and 10.2's numbers come from.

**Postmortems worth watching and reading:**

- **GitHub, October 2018 ("October 21 post-incident analysis").** After a 43-second network problem, automatic failover moved the database primaries to the other coast, writes happened on both sides, and getting back took more than a day. The real-world form of this challenge's questions 1 and 3: grey failure, cross-region failover, and a failback far harder than the failover.
- **Cloudflare, the November 2023 control plane and analytics outage.** A data centre lost power, and it turned out that some services believed to "run elsewhere too" quietly depended on that one place. One of the most honest accounts of question 4's "the original's shadow on the backup".
- **Dan Luu's "post-mortems" list (on GitHub).** A collection of hundreds of published postmortems, sorted by type. Read one a week, and for each ask which lesson of this module would have prevented it.

**For a project:**

- **A game day, on your own laptop:** two "regions" in Docker Compose (two networks, with 60 ms and packet loss between them via `tc netem`), each with a Postgres (one primary, the other an async replica) and a small Express app. Then run this challenge's night yourself: run a backfill, measure replica lag and see what the RPO comes to; fail over without killing the old primary and count the writes on both sides; then add fencing and do it again. Finally fail back, and time it. How much of your RTO is the tooling, and how much is your own decision-making?
- **A drift detector:** a TypeScript script that runs daily and checks whether every safeguard is still there: whether a sample of cache keys has a TTL (`SCAN` + `TTL`); how many tests in CI are `skip`ped and for how long; which resources' `team` tag names a team that no longer exists; what `LOG_LEVEL` is in the IaC; when the last game day was. Turn question 10(c)'s list into code. The day it first finds something, you will understand why it is needed.
- **Write a postmortem:** for this scenario, in the format of a real postmortem (summary, impact, timeline, contributing causes rather than a root cause, what worked, actions with owners and dates), without blame. Then put GitHub's postmortem above next to it and compare what they wrote that you did not.

---

Do the exit challenge and send it over. When you are ready, write `next` and we go to **Module 11: Real System Design Case Studies**, starting with Lesson 11.1: **Design a URL Shortener**.

From Module 1 to Module 10, TaskFlow grew from one Express server and one Postgres into this night's system, and at every step we measured one question in isolation. In Module 11 we set TaskFlow aside. Each lesson is a new system, from scratch, interview-style, following Lesson 1.2's framework: requirements → estimation → high-level design → deep dive → trade-offs. This time nobody will tell you which lesson's tool is needed. In the URL shortener, three tools from this module come back (a Bloom filter for "is this new code taken", HyperLogLog for unique visitors, and consistent hashing for splitting keys), along with Module 4's cache and Module 5's sharding. Which one goes where, and which is actually not needed at all, is for you to decide this time.
