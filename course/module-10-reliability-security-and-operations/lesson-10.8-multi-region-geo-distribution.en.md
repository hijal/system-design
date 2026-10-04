# Lesson 10.8 — Multi-Region & Geo-Distribution

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 2.1):** Why is DNS TTL lowered before changing a server's IP (a migration)? And does lowering the TTL send every user to the new IP immediately? Today, after a region dies, DNS will be changed, and you will see that even with a 60-second TTL, 9% of traffic is still going to the dead region five minutes later.

**Prerequisite:** Lesson 1.5 (SLO, error budget), Lesson 2.1 (DNS, TTL), Lesson 4.5 (CDN, anycast), Lesson 5.7 (Replication, multi-leader), Lesson 5.9 (CAP, quorum), Lesson 6.1 (Split brain, fencing), Lesson 6.2 (Raft), Lesson 6.3 (Read-your-writes), Lesson 6.4 (LWW, HLC), Lesson 10.3 (Blast radius, static stability), Lesson 10.7 (Data transfer, cost)

**By the end of this lesson you will be able to:**

1. Separate the three distinct reasons for going multi-region (latency, disaster recovery, data residency), and say how each calls for a different design. Show with numbers why distance multiplies across round trips, why moving the app close to the user without the DB makes writes **slower**, and where the cost of consensus across regions comes from
2. Choose a DR strategy (backup, pilot light, warm standby, active-active) by RPO and RTO, with each one's monthly price. Understand the tail of DNS failover, and say why the real danger of automatic failover is not a region dying but a partition, and what a witness does
3. Say how many writes are silently lost, and when, if several regions accept writes. And put together a design with home regions, cells and data residency in which you know which path a customer's data takes and where it goes

**Tier:** 1 — Runnable Code (four deterministic models; no cloud account or Docker needed)

---

## 0. Where TaskFlow Is Right Now

Since 5.7, everything of TaskFlow's has been in one region in Singapore: three AZs, a primary and replicas, the cache, every service. In front of it, a CDN (4.5, 10.5). After 10.7 the bill is under control. And one pilot from 6.4 is still running: accepting writes to tasks' titles and descriptions in three regions, reconciled with LWW.

In one month, three pressures arrived at once.

**The first pressure: distance.** A spreadsheet from the sales team: three big trial customers in London and New York did not buy. All three gave the same feedback: "slow." Opening a board takes almost a second from London, a second and a quarter from New York. In Dhaka, three hundred and fifty ms.

**The second pressure: a region's outage.** One Tuesday the cloud provider's Singapore region had four hours of trouble: part of the network, then some storage. TaskFlow was almost completely down for four hours, for every customer, in every country. 10.3's AZ redundancy was no help, because what broke was a shared part of the region. All day the status page said "we are waiting on the provider."

**The third pressure: a contract.** A big German company, 6,000 seats, sent a draft one-year contract. Two conditions: "all personal data stays inside the EU" and "DR plan: RPO ≤ 1 minute, RTO ≤ 30 minutes, tested and demonstrated once a year."

And a pile of old support tickets, from 6.4's pilot: "I changed the title, and later saw the old one." Nobody had ever counted how many there were.

In the engineering meeting, the first proposal came: "Run everything in every region, active-active, writes everywhere. All three problems solved at once." The CTO's reply: "Three problems, three different kinds. It's unlikely one answer is right for all three. And I want to see the bill for 'everything in every region' first. Bring numbers for each."

---

## 1. Theory

### 1.1 Three reasons, three designs

There are usually three reasons to go multi-region, and they want different things:

```
reason                  wants                                         measured by
latency for far users   compute and data near the user (at least reads)   p50/p95, by city
disaster recovery       a copy of the data in another region and the ability to start   RPO, RTO
data residency          specific data inside a specific boundary, on every path   which paths leave
```

These are not the same, and they can even work against each other. DR wants data copied **somewhere else**. Residency wants data **not to leave** one place. Keeping the EU data's DR copy in Singapore breaks residency. Keeping a read replica in every region for latency spreads residency-bound data to every region. So the first question is always: **for which reason?** And the question before that: can it be met by a cheaper path? Much of the distance problem is met by a CDN and the edge (1.2). Some of a region outage is met by backups (1.4). A second region roughly means a second production: double the cost (10.7), double the deploys (10.6), and all the hard consistency questions (Module 6) all over again, this time at 100 ms of distance.

### 1.2 Latency — distance multiplies across round trips

Light travels about two hundred thousand kilometres a second in optical fibre. Singapore to London is more than 10,000 kilometres, and the round trip along the internet's actual paths is about 170 ms. No engineering gets below that. What you can do is **reduce the number of round trips**, and do the remaining ones with something **nearby**.

`npm run latency` runs users in five cities (Dhaka 35%, Delhi 10%, Singapore 15%, London 25%, New York 15%), with approximate RTTs and ±15% fluctuation. Opening a board means one new connection (TCP + TLS 1.3, two round trips, 2.2), then three API calls one after another, each with three queries to the database. 20% of workspaces are shared with people in another region. Four topologies:

```
everything in Singapore
city         users   board p50   board p95   create task p50   stale read after write
Dhaka           35%      346 ms      386 ms           77 ms                 0.0%
Delhi           10%      422 ms      472 ms           92 ms                 0.0%
Singapore       15%       94 ms       98 ms           27 ms                 0.0%
London          25%      925 ms      1.05 s          192 ms                 0.0%
New York        15%      1.23 s      1.39 s          252 ms                 0.0%
everyone (weighted)      390 ms      1.27 s

+ TLS at the CDN edge
London          25%      599 ms      678 ms          192 ms                 0.0%
New York        15%      780 ms      887 ms          252 ms                 0.0%
everyone (weighted)      289 ms      807 ms

+ app + read replica in every region (writes to the Singapore primary)
Dhaka           35%      236 ms      258 ms          185 ms                 0.2%
Delhi           10%      180 ms      195 ms          170 ms                 9.6%
London          25%      131 ms      139 ms          355 ms                61.1%
New York        15%      116 ms      122 ms          470 ms                66.8%
everyone (weighted)      135 ms      250 ms

workspace home region (cell)
Dhaka           35%      239 ms      758 ms           69 ms                 0.0%
London          25%      132 ms      567 ms           38 ms                 0.0%
New York        15%      117 ms      755 ms           32 ms                 0.0%
everyone (weighted)      186 ms      698 ms
```

Four lessons, one at a time:

1. **Distance multiplies.** London's RTT is 170 ms, but opening a board takes 925 ms: five round trips (two for the handshake, three calls) plus a little server time. So the first job is to cut round trips: 9.2's BFF makes three calls into one, HTTP/2 and keep-alive (1.4) save the handshake. Run the edge topology with `API_CALLS=1` (the BFF's single call) and London is **209 ms**, New York 269 ms, everyone's overall p50 117 ms. Without any second region, close to the 131 ms of a replica in every region.
2. **TLS at the edge: only the handshake gets cheaper.** The CDN's PoP is near the user, so the two handshake round trips happen 8 ms from London. London goes from 925 to 599 ms, without any second region, almost for free. But every API call still goes to Singapore. A cheap first step, not the last.
3. **Bringing the app and a read replica closer makes reads fast (131 ms in London), but writes even slower.** Creating a task in London goes from 192 ms to **355 ms**. Because before, the user talked to the Singapore app once, and the app talked to its own AZ's database several times (1 ms each). Now the user talks to the Frankfurt app (15 ms), but the app talks to the Singapore database several times for one transaction, 160 ms each time. **Moving a "chatty" app away from its database is the worst place to be.** The write path either goes entirely near the primary (writes sent to the Singapore app), or happens in one round trip (a stored procedure, or one heavy call).
4. **And read-your-writes breaks.** A London user created a task (the write goes to Singapore), and the next read hits the Frankfurt replica. The replica has not yet received that write **61% of the time**. 6.3's problem, this time at region distance. The solutions from there (reading from the primary for a while after a write, version tokens, optimistic UI on the client) are mandatory here.

The last topology, the **cell**: every workspace has a home region, and all of that workspace's data and all its writes are there. In a workspace in your own region, everything is fast. Writes in London take 38 ms, because writes are local too. But the p95 is near 700 ms: the 20% of the time a user opens a workspace in another region, the whole board goes to the far home region. In experiment 1, with half the workspaces in another region, the overall p50 is 253 ms. Cells are good when **most collaboration stays within one region** (one company, one country). And bad when the people of one workspace are spread across the world.

### 1.3 Writes and consensus — the price of physics

Reads can be brought close (replicas). Writes are harder, because a write needs an owner (5.7). And if you want writes to be durable across several regions, so that a write is not lost even if a region dies, the write's commit has to wait for another region's ack. `npm run latency` part B, a Raft-like majority commit (6.2):

```
where                               nodes   majority   commit   regions that can be lost
3 AZs in Singapore                       3          2     2 ms   0 (lose the region, lose it all)
Singapore + Mumbai + Frankfurt           3          2    60 ms   1
same, leader in Mumbai                   3          2    60 ms   1
four regions, leader in Singapore        4          3   160 ms   1
four regions, leader in Frankfurt        4          3   110 ms   1
```

A majority commit needs the ack of the **second-nearest** node. 2 ms across three AZs, but lose the region and you lose it all. 60 ms across three regions: 30 times more on every write, in exchange for surviving the loss of a whole region **with zero data lost** (RPO = 0). Four regions do not increase how many can be lost (the majority of four is three, so only one can be lost), but the commit is 160 ms. The rule: **an odd number, and the leader near the writers.** Systems like Google Spanner or CockroachDB pay exactly this price, and much of their design is about hiding or reducing it (moving the leader near the writer, leases for reads). This is the "else" part of 5.9's PACELC: even with no partition, the price of consistency is latency.

Most user-facing writes do not want to pay this price. So the usual path is: writes synchronous within one region (across AZs), and **asynchronous** to other regions, with a few seconds of lag. The price is those few seconds of writes when a region is lost. The next section's RPO.

### 1.4 Disaster recovery — RPO, RTO and their prices

**RPO / RTO** — Recovery Point Objective: after a disaster, **how old** a state you are willing to return to, meaning the maximum span of writes you can tolerate losing (RPO 5 seconds = the last 5 seconds of writes may be lost). Recovery Time Objective: after a disaster, **how soon** you must be running again. Two separate levers, and both have a price. A small RPO is bought with replication, a small RTO with capacity already running somewhere else.

`npm run failover` part A: the Singapore region down for 4 hours, 300 req/s, 10% of them writes. Five strategies. Each one's RTO is the sum of its steps (assumed times), and the monthly extra cost is on top of 10.7's $8,276:

```
strategy                                      RTO     RPO    writes lost   failed requests   extra / month
one region, wait for it to return            4.0 h      0             0       4,320,000            $0
backup & restore (daily snapshot to another region) 2.2 h  12.0 h  1,296,000   2,340,000          $359
pilot light (DB replica running, app off)    42 min    5 s           150         756,000          $833
warm standby (small app running)             27 min    5 s           150         486,000        $1,259
active-active (running in every region)       4 min    5 s           150          72,000        $3,836

backup:      detect 5 → decide 15 → infra via IaC 30 → DB restore (900 GB) 60 → verify 15 → DNS 5
pilot light: detect 5 → decide 15 → start the app from zero 15 → promote replica 2 → DNS 5
warm:        detect 5 → decide 10 → scale out 5 → promote replica 2 → DNS 5
active:      detect 2 → automatic promotion (with a witness) 1 → global LB / anycast 1
```

**Active-Passive / Active-Active** — in active-passive one region takes traffic and another waits. There are three well-known levels of how ready it waits: **backup & restore** (only a copy of the data), **pilot light** (data on a running replica, compute off), **warm standby** (everything running at small size). In active-active every region takes traffic, so when one dies the others just take its share. The more preparation, the smaller the RTO and the bigger the monthly price.

Four things from the table:

1. **RPO and RTO prices go opposite ways.** For $359 a month (backup), 2.2 hours down and on average **12 hours of writes lost** (a daily snapshot, with the disaster striking at any moment). For $833 a month (pilot light), an RPO of 5 seconds. The biggest leap in lost writes comes cheapest: one async replica. After that, every minute of RTO costs more.
2. **Most of the RTO is human.** Of pilot light's 42 minutes, 15 are "decide": someone woke up, understood, asked someone, took responsibility for "shall we fail over?". Bigger than the restore or the boot. So a runbook (who decides, on which signal) and **practice** (10.3's game day) are the cheapest improvements to RTO.
3. **Slow strategies buy nothing in a short outage.** Experiment 2: if the outage lasts 30 minutes, the region comes back before backup's or pilot light's failover is done. Only warm standby (27 minutes) and active-active help. And starting a failover midway brings another problem: the region came back, now there is data in two places — which is the truth? **Failback** (returning to the old region) is often harder than failover, because this time there is no rush, but data has moved in both directions.
4. **The German customer's contract (RPO ≤ 1 minute, RTO ≤ 30 minutes):** backup is out, pilot light is out (42 minutes), warm standby just about fits (27 minutes), and only if the "decide" step takes 10 minutes, which means rules written in advance and practice. Active-active fits comfortably, at $3,836 a month. This is a business question: whether the contract's revenue (1.7) carries this cost.

### 1.5 Moving traffic — DNS's tail and split brain

The last step of RTO: sending users' traffic to the new region.

**Geo-Routing** — sending a user's request to one of the regions by their location or measured latency, and moving it to the others when a region dies. There are two main tools. **GeoDNS / latency-based DNS** gives different IPs for the same name in different places, and failover means changing the DNS answer. **Anycast / a global load balancer** announces the same IP from many places around the world (4.5), and the provider's network itself sends traffic to a healthy region, without changing DNS.

**The spaced repetition answer:** the TTL is lowered before a migration so that resolvers do not cache the old answer for long. But not everyone respects TTLs. `npm run failover` part B, an assumed mix of clients: 70% respect the TTL, 20% have resolvers that treat the TTL as at least 5 minutes, 10% hold on to the old IP for up to an hour (open connections, the app's own DNS cache). After DNS is changed, what % of traffic still goes to the dead region:

```
routing                              +1 min   +5 min   +15 min   +30 min   +60 min   failed in the first hour
DNS, TTL 60 s                          26%      9%       8%       5%       0%               69,450
DNS, TTL 300 s                         82%      9%       8%       5%       0%               94,650
DNS, TTL 3,600 s                       98%     92%      75%      50%       0%              540,150
anycast / global LB (DNS unchanged)     0%      0%       0%       0%       0%                9,150
```

The difference between TTL 60 and 300 is only in the first few minutes. After that both get stuck on the same tail: the 10% who do not respect the TTL at all. TTLs cannot stop that. And with an hour-long TTL, the first half hour of a failover is almost pointless. So in DR planning the DNS TTL is always kept short (2.1's migration advice, this time permanent). And for a small RTO, anycast or a global load balancer, where nothing has to change on the client. (In a mobile app there is another path: the app itself knows two endpoints and switches to the other on failure.)

**Who says the region has died?** Now the most dangerous question. In active-active or automatic failover, a machine decides "Singapore is dead, make Mumbai primary." But remember 6.1: from another machine, "dead" and "unreachable" look exactly the same. `npm run failover` part C: Singapore has not died, it is just cut off from the others for 10 minutes (a partition), and Singapore's users can still reach it (15% of writes):

```
policy                                     failed writes   writes diverging on both sides   who could write
no automatic failover                         15,300                   0   only Singapore; everyone else's writes fail
Mumbai promotes itself after 2 minutes         3,060               2,160   both sides — two primaries (split brain)
with a witness (majority + lease, fencing)     5,625                   0   Mumbai's side; Singapore stops itself after 30 s
```

- **No failover:** nothing is lost, but for 10 minutes everyone outside Singapore has their writes fail. CAP's C.
- **Mumbai decides by what it sees:** fewer failed writes, but for 8 minutes **two primaries**. Singapore does not know it is "dead", and accepts 2,160 writes from its users. When the partition heals, these writes do not fit Mumbai's history. They have to be reconciled by hand, or they are lost. 6.1's split brain, at region scale.
- **A witness:** a third region (say Frankfurt, a small node) votes. Becoming primary takes a majority, and a primary can renew its lease only by talking to a majority. Singapore is cut off, so when its lease ends after 30 seconds it **stops itself** (fencing). Two primaries never exist at once. The cost: Singapore's users' writes fail for 9.5 minutes (5,625 failed in total, fewer than not failing over). This is 6.2's Raft reasoning, at region scale. Automatic failover is safe only with a quorum and fencing. Otherwise the safest automatic failover is a button in a human's hand.

### 1.6 Writes in several regions — the real cost of 6.4's pilot

Now the pile of support tickets. 6.4's pilot accepts writes in every region and reconciles them with LWW. How many writes is it losing?

`npm run conflicts`, one day: a million edits, about 200,000 of them in 20,000 joint sessions (2–4 people working on the same task for a few minutes, with people from another region in 30% of sessions). Replication between regions is usually half the distance + 50 ms. But from 2 p.m. to 4 p.m. the link is bad, with a median of 20 seconds. And Frankfurt's clock is 250 ms behind (6.4). Two edits are concurrent if one is written before the other has reached its region:

```
rule                          edits silently lost   % of total   concurrent   reversed by the clock   in the 2-hour incident
LWW, whole row, wall clock                2,068    0.207%                2,025               43                1,858
LWW, per field, wall clock                  642    0.064%                  633                9                  599
LWW, per field, HLC                         633    0.063%                  633                0                  599
writes in the workspace's home region         0        0%                    0                0                    0
```

- **2,068 edits are silently lost a day** with whole-row LWW. 0.2% sounds small, but each one is a person who wrote something and later found it gone, with no error. The pile of tickets is real.
- **90% are lost in two hours.** 1,858 while the link was bad. Slow replication means a wider concurrency window, and more conflicts. Meaning conflicts arrive **exactly when the system is already under strain**. Experiment 3: cutting link lag from 20 s to 2 s takes it from 2,068 to 518.
- **Reconciling per field cuts lost edits to a third.** One person changed the status, another the title: both survive. This is the cheapest improvement.
- **HLC removes clock errors, not concurrency.** "Reversed by the clock" (one edit was written after seeing the other, but the old one won because of a lagging clock) is zero with HLC. Experiment 4: with Frankfurt's clock 2 seconds behind, 685 on the wall clock, 0 with HLC. But the 633 truly concurrent edits are lost with HLC too. 6.4's point: HLC preserves causality, it does not recognize concurrency.

**Home Region** — every piece of data (here, every workspace) has one owning region, and all its writes go there, wherever the user is. Writing in one place means single-leader (5.7), so there are no write conflicts. A write from a user in another region pays one far round trip to reach home. 5.7's "avoid conflicts — the most common in practice."

The cost, part B: 14.3% of joint-session edits come from another region, with extra latency of p50 119 ms, p95 235 ms. Of all edits, only 2.86% pay this price. And in exchange, from 2,068 silent losses a day to **zero**. For most products this is an easy decision: optimistic UI (the client shows its own write immediately) hides 119 ms, and no UI can hide a lost write.

Where many people really do write the same text at once (rich-text descriptions, like Google Docs), instead of LWW use a **CRDT** or operational transform: data structures whose concurrent changes always merge by themselves, losing nothing (an automatic form of 6.4's siblings). The cost is complexity and metadata. And even then a home region often acts as the sequencer.

### 1.7 Data residency and cells — where data goes

The German contract: "all personal data inside the EU." The first plan was a database and app in Frankfurt. But data does not live only in the database.

**Data Residency** — the obligation to store and process specific data (often personal data) inside a specific geographic boundary. It comes from contracts, or from a country's law (data localization). A caution: the EU's GDPR itself does not always require **keeping** data in the EU; it requires a legal basis and safeguards for **transferring** it out. Many contracts and some countries' laws are stricter than that. Which one applies is a lawyer's question, not an engineer's (not verified here). The engineer's question is: **which paths does the data actually take?**

`npm run residency` counts this customer's (300 workspaces, 6,000 users) data paths, under three designs:

```
path                                  GB/month   personal data              all in Singapore   DB + app + S3 in EU   full EU cell
Postgres (primary + replica)              80   names, emails, tasks           out ✗              in EU              in EU
attachments (S3)                       3,000   files                          out ✗              in EU              in EU
DR copy: backups and replica           3,100   everything                     out ✗             out ✗             in EU
CDN edge cache                           600   files                          out ✗             out ✗             in EU
logs (central log store)                  45   user id, IP                    out ✗             out ✗             in EU
traces                                    15   user id, workspace             out ✗             out ✗             in EU
metrics                                    2   none (labels cleaned)          out ✗             out ✗            out ✗
search index (8.3)                        40   task text                      out ✗             out ✗             in EU
analytics warehouse (7.6)                 60   events, user id                out ✗             out ✗             in EU
analytics: aggregates only (no user id)    1   none                           out ✗             out ✗            out ✗
identity: users' email and profile         1   email, name                    out ✗             out ✗             in EU
email provider                             5   email, name, task titles       out ✗             out ✗             in EU
error tracker (with request bodies)        3   whatever is in the body        out ✗             out ✗             in EU
paths taking personal data out                                               11 / 11              9 / 11            0 / 11
personal data leaving / month                                                  6.9 TB              3.9 TB              0 GB
```

**Moving the database and S3 to Frankfurt fixes only 2 of the 11 paths.** The other 9 are each a decision from almost every module of this course. 10.3's DR copy (in Singapore, because "another region"), 4.5's CDN (private files cached in PoPs around the world), 10.4's central logs and traces (user ids, IPs — IPs are personal data too), 8.3's search cluster, 7.6's analytics, 9.2's identity, and external services (email, the error tracker, whose request bodies nobody knows the contents of). Residency is not a database setting. It is a property of every path in the system.

**Cell-Based Architecture** — splitting a system into several independent, complete copies (cells). Each cell has its own app, database, cache, queue, logs and search, and each customer (or workspace) lives in exactly one cell. On top sits a thin global layer (routing, the identity directory, billing) that knows which customer is in which cell. Cells by region meet residency and latency. And several cells in the same region shrink the blast radius (10.3): a bad deploy or bad data in one cell touches only that cell's customers.

In the full EU cell, no path takes personal data out. What does leave (metrics, aggregate analytics) carries no personal data, and that is guaranteed by design (10.4's label rules, analytics computed without user ids). The DR copy is in a second EU region (the resolution of 1.1's conflict: DR's "somewhere else" means somewhere else inside the boundary). In identity, the user's profile is in the EU, and the global directory holds only a hash of the email, mapping to "this user's home cell". The first step of login knows only that much.

**The cost**, part B:

```
app (min 3, commit)                                $273
Postgres Multi-AZ + 1 replica                    $1,444
Redis (cache + queue)                              $190
NAT ×3 + LB + endpoints                            $221
log/trace/metric stack (the cell's own)            $450
DR: pilot light in a second EU region              $512
search (the cell's own)                            $280
people's time on average (on-call, upgrades × 2 cells) $1,500
cell total / month                               $4,870
this customer's revenue (4,200 paid seats × $9)  $37,800
cell cost as % of revenue                           13%
```

A cell has a **fixed base cost**, however small the customer: the database's Multi-AZ, NAT, the observability stack, and the biggest line, people. Two cells means every deploy, every migration (10.6's expand/contract), every on-call incident in two places. 13% of this customer's revenue, four times TaskFlow's usual 3% (10.7). For the first EU customer, a cell is an investment. The second and third EU customers go in the same cell, and the base cost is shared. So it is a business decision: "do we expect more customers in the EU market?" And that comes before the cell's design.

### 1.8 TaskFlow's decision

> **Trade-off Table — four topologies, three reasons**

| Topology                          | Latency (far users)                                            | DR (when a region is lost)            | Residency                               | Cost and complexity                                                |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| One region + CDN edge             | Shorter handshake; every call far (London 599 ms)              | Nothing, or backups (RPO hours)       | One place — either it fits or not       | Lowest                                                             |
| + read replica in every region    | Fast reads (131 ms); slow writes (355), RYW breaks             | Promote a replica — like pilot light  | Data spreads to every region ✗          | App + replica per region; RYW design                               |
| Active-passive (warm standby)     | No gain                                                        | RTO 27 min, RPO 5 s                   | ✓ if the standby is inside the boundary | +$1,259; practising failover                                       |
| Active-active, home region (cell) | Everything fast in your own region; slow in others' workspaces | One region's cells lost, the rest run | ✓ cells by region                       | Each cell's base cost; a global layer; everything N times          |
| Active-active, writes everywhere  | Everything fast                                                | RTO minutes                           | ✗                                       | Write conflicts (thousands of lost writes a day), the most complex |

**Now:** TLS at the CDN edge and one call in the BFF (London's board from 925 to ~209 ms, measured in the model, with no second region). A DNS TTL of 60 s. 6.4's multi-region write pilot **shut down**: all writes in one place again, after first moving it to per-field LWW + HLC for as long as it takes to shut it down.

**DR (for everyone):** an async replica of Singapore's database in Mumbai, S3 replication, and the ability to run the whole stack in Mumbai through IaC: pilot light, RPO ~5 s, RTO ~40 minutes, ~$833 a month. A written runbook: on which signal, who decides, every step. Failover in human hands, with one button — not automatic without a witness. A game day every six months (10.3), in which traffic really is moved to Mumbai and back. The failback part is practised too.

**EU cell (with the German contract):** a complete cell in Frankfurt, including every path of personal data (logs, traces, search, the error tracker, the email provider's EU processing, the CDN cache for private files off or on EU edges only). DR in another EU region, warm standby, to meet RTO ≤ 30 minutes. Only metrics and aggregate analytics leave, with no user-level data. The global layer: routing (workspace → cell), the identity directory (email hash → cell), billing. This layer is small, almost read-only, and each cell keeps a cache of it (10.3's static stability: cells keep running even if the global layer dies). When a new workspace is created, the customer chooses its region themselves, and changing it later is a migration, not a click.

**Later, if needed:** if more customers come in London and New York, open the Frankfurt and Virginia cells to ordinary customers too (home regions). A read replica in every region: **no** — it breaks residency and slows writes.

---

## 2. Interview Angle

Multi-region comes at the end of almost every big design question: "now make it global", "what happens if a region dies?" And here the difference between junior and senior is clearest. The weak answer is "a copy in every region, active-active, a global database." The shape of a good answer:

1. **Ask for the reason.** "Why multi-region? Latency, DR, or residency?" Each has a different answer. And name the cheap paths first: CDN, edge, fewer round trips.
2. **Decide where writes go first.** Single-leader with read replicas, home region (cells), or multi-leader. Each one's consistency price: RYW, conflicts, cross-region commit latency.
3. **Speak about DR in numbers.** RPO and RTO, the strategy, and the monthly price. Who decides on failover (witness, fencing), and how traffic moves (DNS's tail, anycast).
4. **The costs.** Every region is almost a new production. Inter-region data transfer (10.7), every deploy N times. And for data residency, every path, not just the database.

**Follow-ups that are almost certain:**

- _"Why not use a global database (Spanner, CockroachDB, DynamoDB global tables)?"_ — they do not remove the problem, they make its price explicit. If synchronous, every write's commit needs a majority ack across regions (60 ms+ across three regions). If multi-leader async, conflicts and LWW. The question is which price you are choosing.
- _"In active-active, what if the same row is written in two regions?"_ — LWW (silent loss; reduced per field, HLC removes clock errors), CRDTs (merge by themselves, complex), or a home region (no conflicts, one round trip for far writes). Give numbers: conflicts jump when the link is bad.
- _"How would you automate failover?"_ — a partition and a death cannot be told apart. So a quorum (a witness in a third region) and fencing with leases. Otherwise split brain. In many places database failover is deliberately kept in human hands.
- _"We want RPO zero."_ — then every write's commit waits for another region's ack. The price on every write is the RTT to the second-nearest region. Which data really needs zero (money), and for which is 5 seconds fine (a task's title)?

**In real production:** the most common incidents: a DR region that was never tested, and on the day of the disaster config, secrets or quotas turn out to be missing. Long DNS TTLs. Automatic failover on a network blip, followed by split brain. Read replicas far away, and complaints about read-your-writes. Multi-leader LWW whose losses nobody counts. Claims of "data in the EU" while logs, backups and search are in Singapore. And a global layer (identity, routing) that is itself a single point of failure, taking every cell down at once.

---

## 3. Key Takeaway

- **Multi-region's three reasons (latency, DR, residency) call for three different designs, and sometimes work against each other.** Cheap paths first: TLS at the CDN edge takes London's board from 925 to 599 ms, and with one call in the BFF, 209 ms — without any second region
- **Distance multiplies across round trips, and moving the app away from the DB is the worst move.** A far read replica makes reads fast (131 ms), but London's writes go from 192 to 355 ms, and reads after writes are stale 61% of the time
- **The price of durable writes across regions is the RTT to the second-nearest region.** 2 ms across three AZs, 60 ms across three regions. An odd number, the leader near the writers. So most writes are sync within a region and async beyond it
- **RPO and RTO can be bought, at an explicit price.** An async replica (pilot light, $833) brings RPO from 12 hours to 5 seconds. Every minute of RTO costs more after that (active-active $3,836, 4 minutes). The biggest part of RTO is the human decision, hence runbooks and practice. In a short outage slow strategies buy nothing
- **DNS failover has a tail the TTL does not touch** (TTL 60 or 300, 9% after 5 minutes). And the danger of automatic failover is the partition: without a witness, two primaries (2,160 diverging writes); with a witness and leases, zero
- **Writes in several regions mean silent loss, and the loss comes at bad times.** 2,068 a day (row LWW), 90% of them in the two hours the link was bad. Per field, a third; HLC removes clock errors but not concurrency. Zero with home regions, at a cost of ~119 ms on 2.86% of edits
- **Residency is a property of every path in the system.** Moving the DB and S3 leaves 9 of 11 paths outside (DR, CDN, logs, traces, search, analytics, identity, email, the error tracker). A cell keeps everything inside the boundary, but has a fixed base cost (13% of the first customer's revenue)

---

## 4. New Terms (Glossary)

| Term                                  | Meaning                                                                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO / RTO**                         | RPO = the maximum span of writes you tolerate losing in a disaster (bought with replication); RTO = how soon you are running again (bought with capacity already running, and practice). Two separate levers, each with a monthly price                  |
| **Active-Passive / Active-Active**    | Active-passive: one region takes traffic, another waits — backup & restore, pilot light (data running, compute off), warm standby (everything running at small size). Active-active: every region takes traffic                                          |
| **Geo-Routing**                       | Sending users to a region by location or latency, and moving them when a region dies — GeoDNS (failover has DNS's tail) or anycast / a global load balancer (DNS does not change)                                                                        |
| **Witness (the quorum's third vote)** | A small node in a third region that forms the majority in the failover vote; a primary can renew its lease only with a majority, and stops itself when cut off — preventing split brain at region scale (6.1, 6.2)                                       |
| **Home Region**                       | Every piece of data (like a workspace) has one owning region, and all writes go there — single-leader across regions, no write conflicts; the cost is one far round trip on writes from users in other regions                                           |
| **Cell-Based Architecture**           | Splitting a system into independent, complete copies (cells), each customer in one cell, with a thin global layer on top (routing, identity directory, billing); gives residency, latency and a small blast radius, at the cost of each cell's base cost |
| **Data Residency**                    | The obligation to store and process specific data inside a specific boundary (from a contract or law); not a database setting but a property of every path — backups, CDN, logs, traces, search, analytics, external services                            |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. The German customer's contract: RPO ≤ 1 minute, RTO ≤ 30 minutes, all personal data in the EU, and proof of DR once a year. The EU cell is in Frankfurt. (a) Which strategy and which second region for DR, and show your RTO arithmetic step by step using `npm run failover`'s steps. Which step is the most uncertain? (b) Write the first five lines of the failover runbook: who, on which signal, which button. (c) What happens to the global layer (identity directory, routing) if **Singapore**, where this layer runs, dies? Will the EU cell still work?

2. TaskFlow wants a new feature: several people writing in a task's description at once, like Google Docs, with people from the same workspace in Dhaka and London. The workspace's home region is Mumbai. (a) If every keystroke is sent to the home region, what will the London user's experience be like, using the numbers from `npm run conflicts` and `latency`? (b) Why does LWW not work here at all? (c) Give a design: what is on the client, what on the server, what is the home region's role, and do fields like a task's status or assignee need the same design?

3. A user is a member of two workspaces: one in the EU cell (their company), one in the Singapore cell (an open-source project). Three TaskFlow features: login, "all my work" (a list of tasks assigned to them across every workspace), and search across every workspace. (a) For each, where does the data live and which path does the request take, so that EU data does not leave the EU? (b) What will the "all my work" page show when one cell dies (10.3)? (c) Which cell will the user's own profile (name, email, photo) live in, and why is this a hard question?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) RPO ≤ 1 minute means an async replica (pilot light or above). RTO ≤ 30 minutes means warm standby or active-active. The second region must be inside the EU, a failure domain separate from Frankfurt (say Ireland or Paris). The warm standby steps:

```
detect          5 min   (10.4's burn rate page — Frankfurt's SLI, measured from outside)
decide         10 min   (conditions written in the runbook in advance; who decides, by name)
scale out       5 min   (the standby's app from 2 → full size; autoscaling max raised in advance)
promote         2 min   (replica → primary, fencing Frankfurt — so the old primary cannot write)
traffic         5 min   (DNS TTL 60 s, or one click on the global LB)
total          27 min   — under the 30 limit, but with only 3 minutes of margin
```

The most uncertain is **decide**. In a partial outage (some services slow, some fine), the argument over "is this bad enough for a failover?" easily takes 20 minutes. The remedy: conditions in numbers in the runbook ("Frankfurt's success SLI below 90% for 10 minutes, and a region-level incident on the provider's status page — fail over, without asking"). And the annual proof is not just for the contract; it is the only way to know whether these 27 minutes really are 27. The second uncertainty: something exists in prod but not in the standby (a secret, a new queue, a quota). So the standby's config comes from the same IaC as prod, with a diff in CI.

(b) The start of the runbook:

1. **Condition:** Frankfurt's board/login SLI < 90% for 10 minutes (from an external synthetic probe), **or** the provider has declared a region-level incident in Frankfurt. The on-call engineer opens an incident and calls the EU cell's owner (name, alternate name).
2. **Decision:** the EU cell's owner or the on-call lead, within 5 minutes, against this runbook's conditions. At most 10 minutes for "let's wait a little longer".
3. **Fencing first:** stop writes to Frankfurt's database (close the app's connections in the security group, or make the DB read-only) — if it can be reached. If not, rely on the witness's lease (it will stop itself).
4. **Promote and scale the standby:** one script (`dr-failover eu`), run again and again on game days. Promote the replica, bring the app's minimum capacity to full size.
5. **Traffic:** change the EU cell's target on the global LB. Notify the status page and the customer's contacts (the contract has a notice period).

(c) This is the subtlest question in cell design. The global layer is in Singapore; if Singapore dies, the first step of a new login (email → which cell) cannot answer. The design: (1) **cache the directory in every cell** (10.3's static stability) — the EU cell knows its own users, so an EU user's login completes in the EU cell, without the global layer. (2) The routing list (workspace → cell) lives in the global LB's config, with a copy in every cell too. (3) The global layer itself runs in several regions (small, almost read-only, so cheap to replicate), and its data holds no personal information, only hashes and cell ids. The test: on a game day, switch off the global layer and see whether EU users can log in and work. If not, your "independent" cell is not actually independent.

**Question 2:**

(a) Every keystroke to Mumbai (London → Mumbai ~120 ms RTT): every character takes ~120 ms+ to reach the server and come back. If the UI waits for the server's answer, typing will stutter, unbearably. `conflicts` part B's p50 of 119 ms was acceptable for a **save**, not for every character. And in `conflicts`'s model, an edit is concurrent when two writes fall within the replication window. When two people type rich text together, almost **every** keystroke is concurrent.

(b) LWW treats the whole description as one value. The Dhaka user wrote one paragraph, the London user another, at the same time. LWW throws away one person's entire text. Per-field LWW does not help, because there is only one field. HLC does not help, because they really are concurrent. 1.6's rate of lost edits would be nearly 100% here.

(c) The design:

- **Client:** shows its own writes immediately (optimistic, local-first), and sends changes as CRDT (a library like Yjs or Automerge) or OT operations: "insert 'abc' after position X", not the whole text.
- **Server (home region Mumbai):** sequencer and relay. It accepts operations, orders them (essential for OT; CRDTs merge without ordering, but keeping them in one place and forwarding them to others is easier), makes them durable, and sends them to the other clients over WebSocket (2.4). The London user sees their own writing immediately, and the Dhaka user's writing ~120 ms later. Acceptable, because nobody waits for someone else's writing.
- **The home region's role:** the document's only durable place, and the relay. An edge relay near London (in Frankfurt) can hold the WebSockets, but there is one source of truth.
- **Status, assignee:** no, they do not need the same design. They are small, single values, and change less often. Write them in the home region (one round trip, optimistic UI), and on conflict the last write wins, because for "two people changed the status at the same moment" LWW is actually the right behaviour (per field, with HLC). Spend complexity only where merging means something.

**Question 3:**

(a)

- **Login:** the browser gives the email to the global layer. The global directory holds only `hash(email) → [EU cell, SG cell]`. Login (password or SSO) happens in the user's **home cell**, where their credential lives (see c below). After login, a token that both cells can verify (10.5's JWT, each cell holding the public key). The token holds only the user id, no personal data.
- **"All my work":** the browser (or BFF) asks each cell separately, with the user's token, and the results are joined **in the browser** or in the BFF of the user's own region. The EU task list goes straight from the EU cell to the user, and is not stored in any other cell. A global "all work" table (a copy of every cell's tasks) is the simplest design, and exactly what breaks residency.
- **Search:** the same pattern — each cell's own index, query fan-out (5.8's scatter-gather), results joined on the user's side. No global index.

(b) When one cell dies (10.3): that part of the fan-out fails on timeout. The page does not break entirely. It shows the work from the other cell, with a clear message: "work from EU workspaces cannot be shown right now." This is a soft dependency. A short timeout (one slow cell should not make the whole page slow), and a breaker for that cell (9.4).

(c) Where the profile lives is hard because the user is one person, but their relationships span two boundaries. The paths: (1) the user has a **home cell** (their own country, or their first workspace's cell), with the profile there, and only a small copy of the user id and display name in other cells. But the display name is itself personal data, so an EU user's name goes to the SG cell when they work in an SG workspace. (2) Deciding which parts of the profile go where through the user's own choice or the contract: "you are joining this workspace, which is in Singapore; your name and photo will be visible there." This is really a product and legal question, whose engineering answer is: every piece of personal data has a known home, and every copy is a known, deliberate decision. That is what 1.7's table is for.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (four deterministic models; no cloud account or Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-10.8-multi-region/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.8-multi-region) — `npm install`, then `npm run latency`, `npm run failover`, `npm run conflicts`, `npm run residency`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`latency` runs users from five cities through four topologies: opening a board, creating a task, stale reads after writes. Plus majority commits across regions. `failover` covers five DR strategies in Singapore's four-hour outage (RTO, RPO, cost), the tail after a DNS change, and three failover policies under a partition. `conflicts` compares three LWW rules and home regions over a day of a million edits. `residency` counts an EU customer's 12 data paths under three designs, and compares a cell's cost with its revenue.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the four scripts twice each, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **Every RTT is approximate** (`src/geo.ts`), an estimate of typical public internet round trips, not measured here. **Failover step times, DNS client behaviour, replication lag, clock skew and the structure of sessions are all assumed** numbers, changeable through env vars. Costs are matched to 10.7's approximate prices. `conflicts` runs the LWW rules in a simple replication model, not a real database. `residency` is a design checklist, not legal advice, and its claims about GDPR and data localization are general, not verified here. The speed of light and the design of Spanner/CockroachDB come from published writing. **Not measured:** real cloud region latency, real DNS resolver behaviour, real replication lag, CRDTs, a global database's commit. TaskFlow's decision in 1.8 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `latency`, write down: with an app and a read replica in every region, will creating a task in London get faster or slower, and by how much? Then run it and compare. Now, with `DB_READS=1` and `API_CALLS=1` (the BFF's single call), what does London come to under "everything in Singapore + edge"? How much do you get before a second region?

2. **Your own DR:** `DECIDE_MINUTES=3 npm run failover` and `DECIDE_MINUTES=30 npm run failover`. How much does each strategy's RTO move? Then, together with `OUTAGE_MINUTES=30`, say: if most of TaskFlow's region outages last less than an hour, which strategy actually buys anything?

3. **The conflict window:** `CROSS_REGION=0.6 npm run conflicts`, then `INCIDENT_LAG_S=60`. How do lost edits grow? Who actually controls these two numbers in TaskFlow — product, or infrastructure?

4. **A fifth region:** add `tokyo` to `src/geo.ts` (RTTs by your estimate), and a five-region row to `latency.ts`'s consensus table. What is the commit, and how many regions can be lost? Why is it better than four regions?

5. **The design part:** one page of TaskFlow's "multi-region policy". (a) TaskFlow's answer for each of the three reasons, with numbers. (b) Where each kind of data (tasks, comments, attachments, user profiles, billing, logs, analytics) lives and where it is copied. (c) DR's RPO/RTO, strategy, and practice schedule. (d) Who decides on failover and how, including the measures that prevent split brain. (e) On what conditions a new cell will be opened (number of customers, revenue, contracts), and on what conditions **not**.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1 – 10.7
Current: 10.8 — Multi-region & geo-distribution
TaskFlow state: modular monolith + billing; gateway + BFF; saga; breaker + bulkhead; rate limits; cache ring;
Bloom/HLL; brownout; OpenTelemetry, burn rate; AuthN/AuthZ, OAuth PKCE, secret manager, DDoS layers;
graceful shutdown, canary + gate, flags, expand/contract; bill $8,276 (autoscale, commit, endpoints,
lifecycle, anomaly). Three pressures in one month: board ~1 s in London/New York (trials lost); a 4-hour
outage of the Singapore region took all of TaskFlow down; a German customer (6,000 seats) wants all
personal data in the EU, RPO ≤ 1 min, RTO ≤ 30 min; 6.4's multi-region write pilot silently loses ~2,000
edits a day (90% while the link is bad). Now: TLS at the CDN edge + one call in the BFF (London 925 →
~209 ms with no second region); DNS TTL 60 s; the multi-region write pilot shut down, all writes in one
place (shut down after per-field LWW + HLC). DR for everyone: an async replica in Mumbai + S3 replication
+ IaC (pilot light, RPO ~5 s, RTO ~40 min, ~$833/month), a runbook, failover by one button in human hands
(not automatic without a witness), a game day every six months (including failback). EU cell in
Frankfurt: every path of personal data (logs, traces, search, error tracker, the email provider's EU
processing, CDN cache), DR as warm standby in another EU region (RTO ~27 min), only metrics and aggregate
analytics leave; a small global layer (routing, hash(email) → cell, billing), a cache of it in every cell
(static stability); region chosen when a workspace is created. The cell costs ~$4,870/month (13% of the
first EU customer's revenue). A read replica in every region — no (breaks both residency and writes).
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7), Deploy / Release, Blue-Green Deployment, Canary Release, Feature Flag,
Version Skew, Lock Queue, Expand / Contract, Unit Economics, Cost Allocation, Commitment Discount, Spot
Instance, Data Transfer Cost, Storage Tiering, Cost Anomaly Detection, RPO / RTO, Active-Passive /
Active-Active, Geo-Routing, Witness, Home Region, Cell-Based Architecture, Data Residency
Weak spots: [where you got stuck — write it yourself]
Next: Module 10 Exit Challenge
=======================
```

---

## 8. Next Step

Today's thread: **multi-region is three different problems with three different answers, each with an explicit price.** Distance multiplies across round trips, so first cut round trips, then bring reads closer. Bring writes closer and you pay in consistency; make written data durable and you pay in latency. RPO and RTO can be bought, and a big part of them is human practice. The real danger of failover is the partition, and its answer is a quorum. And data residency is not a database setting but a property of every path in the system.

Module 10 ends here. Over eight lessons, eight layers were put on TaskFlow: consistent hashing and probabilistic structures, fault tolerance and chaos, observability, security, safe deploys, cost, and multi-region. In each lesson we measured one question in isolation. In reality, one bad night brings them all at once: a region outage, a canary in the middle of it, a DDoS, and a bill at the end of the month. When you are ready, write `next` — we go to the **Module 10 Exit Challenge**. There I will give you an incident timeline with a piece of every lesson in this module in it. You will read it and say what broke, why, and which decision could have stopped it. Then a checklist and a reading list.
