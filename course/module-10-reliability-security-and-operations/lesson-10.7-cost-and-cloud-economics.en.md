# Lesson 10.7 - Cost & Cloud Economics

**Module 10 - Reliability, Security & Operations**

> **Spaced Repetition (Lesson 1.3):** How do you get the average QPS from a system's total daily requests, and how do you estimate the peak QPS? Which one sets the number of servers - the average or the peak? Today you will see that the "peak" answer is true, but buying it 24 hours a day has a price. In TaskFlow's case, 80% of the capacity bought at that price sits idle.

**Prerequisite:** Lesson 1.3 (Estimation, peak versus average), Lesson 4.5 (CDN), Lesson 7.4 (Idempotent jobs), Lesson 7.6 (OLTP versus OLAP), Lesson 8.1 (Object storage pricing), Lesson 8.2 (Previews, CDN), Lesson 9.1 (Monolith versus services), Lesson 10.3 (AZ, static stability), Lesson 10.4 (Log and metric volume), Lesson 10.5 (DDoS), Lesson 10.6 (Blue-green, canary)

**By the end of this lesson you will be able to:**

1. Trace a cloud bill line by line back to design decisions: which lines grow with time (instance-hours), which with storage (GB-months), which with movement (GB transferred), which with events (requests). And split cost by a unit (unit economics: per workspace, per plan, per endpoint), so you can see which decisions make money and which eat it
2. Use compute's three levers separately: autoscaling (the part that rises and falls), commitments (the part that always runs, and the arithmetic for how much to commit), and spot (the part that can tolerate interruptions). And say how much a DDoS bill comes to depending on where it is stopped
3. Design cost around where data lives and where it moves: storage tiers and lifecycles (including the small-object trap), where the cost of logs is, NAT versus VPC endpoints, traffic across AZs. And make cost something you watch, so a mistake is caught the next day, not at the end of the month

**Tier:** 1 - Runnable Code (four deterministic cost models; no cloud account or Docker needed)

---

## 0. Where TaskFlow Is Right Now

After 10.6, TaskFlow deploys safely, in small steps, several times a day. Since the start of Module 10 the system has grown a lot: the gateway and BFF, the cache ring, tracing and collectors, replicas across three AZs, a CDN, a secret manager, a canary pool.

**Monday morning.** An email from the CFO, to the whole engineering team:

> "Six months ago our cloud bill was ~$11,000 a month. Last month it was $26,290. Over the same period users grew 30%. Our revenue is $260,000 a month, so this isn't a danger yet, but the line is heading the wrong way. Can anyone tell me where the money is going? And what are we actually buying?"

Nobody could. The engineers knew how many instances each service ran. But nobody knew that 30% of the bill went to the network. And nobody had ever designed a single network line. The team had one budget alert: "email if the month's bill exceeds $30,000." It never fired once.

For a week, two engineers traced every line of the bill back to its source. Almost every line was one decision from one lesson of this course, and most of them were right decisions. It was just that nobody had written down their monthly price.

- **Staging** at prod's size, 24 hours a day, seven days a week. "So load tests are realistic." Load tests happen twice a month.
- **NAT gateway**, a line most people did not even know the name of. 8.2's thumbnail and export workers read S3 from a private subnet, and every byte goes through the NAT.
- **Traffic across AZs.** 9.x's services call each other, and the load balancer sends more than half the calls to another AZ.
- **20 app instances**, sized for the peak, all the time.
- **Blue-green's** old pools, not deleted after some deploys (10.6), and a debug log nobody turned off after 10.4.

The CTO's one line in the postmortem: "We keep a budget for latency, and a budget for errors. We keep a budget for money only at the end of the month, as a number, with no owner. Cost is a requirement. We were using it as a surprise."

---

## 1. Theory

### 1.1 Reading the bill - the four drivers of cost

Almost every cloud price grows with one of four things:

```
time         instance-hours, NAT/LB/endpoint hours           - whenever it's on, used or not
storage      GB-months (disk, objects, backups, logs)        - for as long as you keep it
movement     GB transferred (internet, across AZs, via NAT)  - how many bytes, how often, by which path
events       requests (S3 GET/PUT, CDN, lifecycle)           - how many times
```

Every design decision changes the number for one or more of these four. The exercise's `npm run bill` builds a monthly bill from TaskFlow's quantities (300 req/s, 60,000 MAU, 18 TB of attachments, numbers from earlier lessons) and the approximate list prices of a big public cloud. The prices are matched to 8.1's numbers and can be changed through env vars. Prices change, so look at the **proportions** of the lines rather than the dollars:

```
line                                             now   now %     after     saved                                      what changed
staging + dev (prod-sized, 24/7)              $4,701   17.9%      $420    $4,281                        ¼ size, working hours only
NAT gateway (hourly + per GB)                 $3,001   11.4%      $139    $2,862               S3 gateway endpoint, image endpoint
app instances (sized for peak, 20 24/7)       $2,803   10.7%      $869    $1,934                  autoscale (avg 7.6), 5 committed
cross-AZ: service → service                   $1,866    7.1%      $280    $1,586                                  AZ-aware routing
metric series                                 $1,800    6.8%      $900      $900                          labels cleaned up (10.4)
internet egress: API JSON                     $1,750    6.7%      $350    $1,400                             gzip/br (~5× smaller)
Postgres primary (Multi-AZ)                   $1,460    5.6%      $949      $511                                            commit
Postgres read replica ×2                      $1,460    5.6%      $949      $511                                            commit
Postgres storage (2 TB × 4 copies)              $920    3.5%      $414      $506                 activity older than 90 days in S3
log ingest + keep 90 days                       $846    3.2%    $23.13      $823    debug off, sample successful requests, 14 days
gateway + BFF + billing + files                 $771    2.9%      $501      $270                           commit (always running)
S3: attachments + old versions                  $736    2.8%      $314      $422                   lifecycle: versions 30 days, IA
Redis (cache 3 + queue 2)                       $730    2.8%      $475      $256                                            commit
undeleted blue-green pool                       $691    2.6%    $17.28      $674              teardown fixed; canary +3, 1 h a day
internet egress: attachment                     $675    2.6%      $660    $15.00                        CDN (about the same price)
backup snapshot                                 $570    2.2%      $285      $285                                 keep 30 → 14 days
background worker                               $561    2.1%      $196      $364                        spot (job idempotent, 7.4)
cross-AZ: app → database                        $415    1.6%    $82.94      $332                        a read replica in every AZ
trace collector                                 $280    1.1%      $140      $140                                       right-sized
load balancer                                   $200    0.8%      $200        $0                                                 -
S3 request                                    $45.00    0.2%    $45.00        $0                                                 -
trace storage (tail sampling)                  $9.00    0.0%     $9.00        $0                                                 -
VPC interface endpoint (image pull)               $0    0.0%    $57.90   −$57.90                                    instead of NAT
total                                        $26,290    100%    $8,276   $18,014                                          69% less

by category:  compute 18% · database 20% · network 30% · storage 3% · observability 11% · other (staging) 18%
per unit:  per workspace $13.15 → $4.14 · per MAU $0.438 → $0.138 · per 1 million requests $33.81 → $10.64
```

Three things stand out:

1. **The biggest line is not even production.** Staging, 18%. Someone once copied prod's terraform, and it stayed that way.
2. **Network is 30% of the bill, more than compute.** NAT, calls across AZs, uncompressed JSON. Nobody designed these lines. They come from defaults (everything in a private subnet goes out through NAT, the load balancer sends to any AZ) and from habit.
3. **Fixing most of the 23 lines needed no architecture change.** An endpoint, a config, a lifecycle rule, a commitment. 69% less. Of these, only three lines needed a real design change (AZ-aware routing, a replica in each AZ, offloading activity). This is the usual picture: the first half of cost can be cut almost for free; the second half takes design.

And behind every number in the "after" column there is a trade-off. That is in 1.7.

### 1.2 Unit economics - who costs how much

$26,290 is one number. To make decisions, it has to be split.

**Unit Economics** - dividing total cost by a business unit: per customer, per workspace, per seat, per request, per GB. Then comparing that with the revenue per unit. The total bill says "how much"; unit cost says "is this sustainable, and what happens as it grows". The bill doubled but the cost per workspace stayed the same - the business grew. The cost per workspace doubled - something broke.

TaskFlow costs $13.15 per workspace per month. But workspaces are not all alike. `npm run bill` part B splits the bill by plan. No cost is labelled with a plan directly, so each line is split by its **driver**: compute, DB and cache by share of requests; storage and backups by share of GB; attachment egress by GB; staging and the load balancer by seat.

**Cost Allocation** - splitting shared costs that are not in anyone's name among teams, products, plans or customers by their driver. In the cloud it rests on resource tags (`team=billing`, `env=staging`). Showing the split is **showback**; actually charging the money is **chargeback**.

```
plan                          workspace    seat   revenue      cost    margin  cost / seat  cost / workspace
free                             1,399  25,000        $0    $8,161         -      $0.326             $5.83
free: one school district            1   3,000        $0    $1,528         -      $0.509            $1,528
pro                                500  15,000   $90,000    $7,695       91%      $0.513            $15.39
business                           100  17,000  $170,000    $8,907       95%      $0.524            $89.07
```

Pro and business margins are above 90%. That is healthy for SaaS, and the bill is 10% of revenue. The real questions are elsewhere:

- **The free plan costs $8,161 a month**, almost a third of the bill, with no revenue. That is a business decision (converting free to paid), but now the decision can be made with a number: $0.33 per free seat per month.
- **One workspace costs $1,528 a month.** A school district on the free plan, 3,000 students, 2 TB of attachments, 1.2 TB downloaded a month. The other free workspaces average $5.83 - this one is 260 times that. Without a statistic showing this one, it could not have been found. And the answer is not engineering's but product's: storage and seat limits on the free plan (9.5's quotas), or talking to them.
- Look at the last column: **cost per seat is almost the same on every plan** ($0.33–0.52). Cost grows with seats. So pricing by seat matches the shape of the cost. A fixed price per workspace would have made big customers loss-making.

**By endpoint.** The same question, at a finer grain. Part C gives the variable cost of one call to each endpoint: CPU ms, DB ms, bytes going out, bytes of internal calls, S3 through NAT:

```
endpoint                    calls / month    per call   per million   monthly  % of calls  % of cost
GET /boards/:id              400,000,000  $0.0000047         $4.74    $1,895    85.096%       71%
POST /tasks                   50,000,000  $0.0000012         $1.16    $58.21    10.637%        2%
GET /search                   20,000,000  $0.0000025         $2.55    $50.96     4.255%        2%
POST /boards/:id/export           60,000      $0.011       $10,920      $655     0.013%       25%
```

Export: 0.013% of calls, 25% of variable cost. One export costs **2,300 times** one board open, because it fetches 200 files from S3 through NAT, zips them, and sends 80 MB out. That does not mean export is bad. It means export needs its own rules: a rate limit (in 9.5 export was 3 a day), a background job (7.3), and an endpoint instead of NAT (1.5). And this is how the interview question "what will this feature cost" is answered: the resources of one call, times the number of calls.

### 1.3 Compute - peak, average, and three levers

**The spaced repetition answer:** average QPS = daily requests ÷ 86,400. The peak is usually taken as 2–3 times the average (1.3), and the number of servers is set by the **peak**, because without capacity at the peak, users suffer. That is right. But the peak lasts a few hours a day, five days a week. The rest of the time you are paying for that capacity.

`npm run capacity` runs a week of traffic one minute at a time. A daily peak at 2 p.m., low at night and at weekends, a marketing email at 10 a.m. on Wednesday (+700 req/s), and some random fluctuation. Average 300 req/s, peak 1,150. Each instance handles up to 75 req/s, and a new instance takes 5 minutes to start and take traffic (10.6's readiness):

```
policy                                    avg instances  cost / month     avg use  strained min  overflowing req  overflow in spike  spot lost
fixed: peak + 25%, 24/7                            20.0        $2,803         20%             0       0 (0.00%)                  0          0
reactive autoscale (target 60%)                     7.6        $1,072         53%             4  15,252 (0.01%)             15,252          0
scheduled (known pattern) + reactive                8.0        $1,121         50%             3   8,713 (0.00%)              8,713          0
reactive, 70% spot                                  7.6          $942         53%             4  15,252 (0.01%)             15,252          2
```

- **The fixed fleet's average utilization is 20%.** 80% of the capacity bought is idle. And in exchange not a single request overflowed. That is its price: certainty.
- **Reactive autoscale:** 7.6 instances on average, 62% cheaper. 4 minutes of strain a week, all at the start of Wednesday's spike. Traffic jumps 700 req/s in 10 minutes, and new instances take 5 minutes to arrive. 15,252 requests (0.01% of the week) slow or 503. This is why the target is 60% (not 100%): the remaining 40% is the headroom to survive until new instances arrive.
- **Scheduled + reactive:** starting the known pattern (the midday peak) 5 minutes ahead. Strain almost halved (8,713 versus 15,252 overflowing requests), at 5% more cost. The marketing email was known (the marketing team knew!). Put it on the calendar and that would have been scheduled too. A cheap bridge between cost and reliability: teams talking to each other.
- **Spot:** the same autoscaling, but 70% of the instances on spot.

**Spot Instance** - a cloud provider's unused capacity, at a much lower price (often 20–40% of on-demand), on the condition that the provider can take it back at short notice (2 minutes on AWS). For work that can tolerate being taken back: stateless, idempotent, short jobs (7.4's workers, batch, CI). You cannot depend entirely on one price or one AZ, so it is spread across several instance types and several AZs.

With spot, another 12% cheaper. In experiment 2, with the interruption rate 15 times higher (30% per instance per hour), instances are lost 83 times a week, but the strained minutes stay the same, 4. Again that 40% headroom, and a base of 3 on-demand instances. Spot is safe because of headroom and stateless design, not luck.

**Commitments.** Even after autoscaling, one part always runs: a few instances even at 3 a.m. For that part, the second lever:

**Commitment Discount** - getting a discount in exchange for promising a fixed amount of usage (so many instances per hour, or so many dollars per hour) for one or three years. Reserved Instances and Savings Plans on AWS, committed use discounts on other clouds, usually 30–60%. You pay whether you use it or not. So the question is **how much** to commit.

Part B, using reactive's hourly usage, with a 35% discount (a one-year estimate):

```
commit (instance)   cost / month  vs on-demand        % of hours with use ≥ commit  unused commit
0                      $1,072                  0.0%                          100%                $0
3                        $925                 13.7%                          100%                $0
4                        $894                 16.6%                           85%            $11.86
5  ← lowest            $869                 18.9%                           79%            $27.97
6                        $875                 18.3%                           54%            $63.56
8                        $943                 12.0%                           34%              $171
12                     $1,164                 −8.6%                           20%              $443
```

The arithmetic is neat. One extra committed instance costs `(1 − discount) × price` every hour, used or not. And it saves the full price, but only in the hours when usage is above it. So it pays off as long as **usage stays above it for more than `(1 − discount)` of the hours**. At a 35% discount the threshold is 65%. At 5, usage is above it 79% of the time, so it pays. At 6, 54%, so it does not. Experiment 1: at a three-year discount (60%) the threshold is 40%, and the best commit is 7. A bigger discount means a bigger commit. But in three years TaskFlow's instance types, region, even architecture may change, and the commitment remains. For that risk you usually pick a flexible kind (committing in dollars, not instance types) and commit a little less.

So the three levers are for three different parts:

```
instances
  ▲         ╭╮ spike
  │        ╭╯╰╮              ← on-demand (autoscaling's rise and fall)
  │   ╭───╯   ╰───╮          ← spot (workers, batch - tolerate interruption)
  │──╯────────────╰────── ← commitment (the always-running base, "usage ≥ c for > 1 − discount of the time")
  └──────────────────────► time
```

### 1.4 Storage - tiers, lifecycles, and the trap of "cheap"

In 8.1 you saw that object storage is far cheaper than database disk. Now, within object storage too there are tiers.

**Storage Tiering** - keeping data in classes with different prices according to its age and usage. Frequently read data in an expensive, fast class (S3 Standard), rarely read data in cheaper classes (Infrequent Access, Glacier). And the movement is automatic, through **lifecycle rules**. Cheaper classes cost less per GB-month, but charge separately for reading (retrieval), for moving (transition requests), and for small or short-lived objects (minimum size and duration).

`npm run storage` part A, 24 months: starting with 18 TB of attachments and 14 TB of old versions (8.1's versioning, without a lifecycle), 1.2 TB new per month (+3%/month). Files are read a lot in their first month, then hardly at all. By count, 60% are small objects (thumbnails, avatars, ~40 KB), but by bytes only 2.9%:

```

```

- **The old-version lifecycle alone is a third.** Versioning is on (to protect against accidental deletes, 8.1), but old versions are never deleted. Over 24 months, 30.5 TB of old versions nobody will ever read. One rule: "delete old versions after 30 days."
- **Tiering by age: another two-thirds.** IA after 30 days, Glacier Instant Retrieval after 180 days. From $32,424 to $7,445 over 24 months.
- **The fear of retrieval is small here.** In month 18 a customer exported their 3 TB of old files, from Glacier IR: $88 extra. The fear becomes real in Glacier's deeper classes (Deep Archive), where reading takes hours and the per-GB price differs. There, treating "old" as "will never be read" is a bet.

But look at the difference between the third and fourth rows: in one every object goes to IA, in the other only the big ones. Why? Part B:

```
1 TB of only 40 KB objects, one year
class                                 object   billed size  in one year
Standard                          25,000,000        1.0 TB        $276
IA (with transition)              25,000,000        3.2 TB        $730
Glacier IR (with transition)      25,000,000        3.2 TB        $654
```

**Small objects cost more in the "cheap" classes.** IA and Glacier IR bill every object as at least 128 KB, so a 40 KB file is counted as 3.2 times bigger. And moving every object is a request: 25 million transitions × $0.01/thousand = $250, in one go. Together, keeping small files in the cheap classes costs 2.6 times as much as Standard. Experiment 3: at 200 KB objects the trap disappears (IA $200, Glacier IR $148, Standard $276). So a lifecycle rule needs a size filter (`ObjectSizeGreaterThan`). This kind of rule does not show up if you only look at "price per GB". That is why you have to run a model.

**Logs: where is the cost?** Part C, 10.4's logs:

```
per day                               GB/day  ingest / month         keep: 14 days         keep: 90 days        keep: 365 days  keep: 14 days + 1 year in S3
one line per request (10.4)              2.8          $42.00                 $1.18                 $7.56                $30.66                 $2.77
+ debug in three services               47.8            $717                $20.08                  $129                  $523                $47.34
10% sample of successful requests        1.5          $22.50                $0.630                 $4.05                $16.43                 $1.49
```

The cost of logs is in **ingestion**, not retention. Indexing, parsing and making each GB searchable ($0.50) costs 16 times as much as keeping that GB for a month ($0.03). Raising retention from 14 days to 90 adds $6 a month. A debug log accidentally left on adds $675 a month. So 10.4's rules (one full line per request, debug only through a flag and time-limited, sampling successful requests) are cost rules too. And when long retention is needed (audit, law), the cheap way is 14 days in the searchable store and the rest compressed in S3.

**Database disk.** Part D, 5.8's activity table: grows by 60 GB a month, and in Postgres every GB lives in four places (primary, standby, two replicas) plus backups:

```
design                                           month 1  month 24  total, 24 months  in DB, month 24
all in Postgres (4 copies + backup)                 $644    $1,410           $24,642           2.5 TB
90 days in Postgres, the rest in S3 Parquet         $102      $105            $2,481           180 GB
```

5.8's partitioning and 7.6's OLAP reasoning, this time in money: `DETACH` partitions older than 90 days to Parquet (6 times compressed) in S3, and read them with something like DuckDB or Athena. A tenth of the cost, and the database stays small. A small database means faster backups, faster restores, faster replica creation (10.3). Here cost and reliability point the same way.

### 1.5 Data Transfer - where the bytes move

**Data Transfer Cost** - the price of bytes moving from one place to another, which differs by path. Going to the internet (egress) is the most expensive. Crossing AZs within one region (per GB, in both directions), going through a NAT gateway (per-GB processing), crossing regions (10.8) - each has its own price. Arriving in a region (ingress) and staying within one AZ are usually free. On the bill these are often scattered under different names, so they go unnoticed.

`npm run traffic` part A, egress:

```
design                                        GB / month  cost / month  note
API JSON, no compression                        19.4 TB     $1,750  25 KB on average
API JSON, gzip/br (~5×)                           3.9 TB       $350  the CPU cost is tiny
attachments straight from S3                   7.5 TB       $687    S3 egress + GET
attachments through a CDN (hit 90%)              7.5 TB       $661  S3 → CDN assumed free within one provider
CDN + small previews on the board (40% bytes)     3.0 TB       $279   resize once, at upload time (8.2)
```

- **Compression: $1,400 for one line of config.** JSON is very repetitive (the same keys over and over), so gzip or brotli makes it 4–10 times smaller. The `compression` middleware in Express, or at the gateway/CDN. There is a CPU cost, but it is usually far smaller than the cost of the bytes.
- **A CDN is not always cheaper.** The same provider's CDN costs almost the same per GB as S3 egress, plus request fees. The CDN's real gains were latency and origin load (4.5, 8.2), and DDoS (10.5). Money is saved at volume-discount tiers, or with another provider. Do not claim "a CDN will cut costs" without checking.
- **Not sending the bytes is cheapest of all.** A 200 KB preview on the board instead of the original 3 MB image. 8.2's resize, once, at upload. 60% fewer bytes, and a faster page.

**NAT gateway, part B.** Instances in a private subnet (with no direct path to the internet, which is right for security) go out through a NAT gateway. And NAT charges per GB processed, whatever the destination. **Even for S3 in the same region.**

```
design                                      GB / month  cost / month  note
everything through NAT, one NAT per AZ    64.5 TB     $3,001  today's TaskFlow
+ S3 gateway endpoint                           4.5 TB       $301  the gateway endpoint is free
+ an interface endpoint for images               900 GB       $197  hourly + per GB, less than NAT
+ smaller images (500 → 150 MB)                 900 GB       $172  multi-stage build, runtime only
everything through NAT, but one NAT for three AZs  64.5 TB     $3,795  fewer NAT hours, more cross-AZ, a SPOF in one AZ
with endpoints, one NAT for three AZs           900 GB       $143  cheap - but if that AZ dies, nothing gets out
```

A **gateway endpoint** for S3 (one line in the VPC's route table, free) saves ~$2,700 a month. The cheapest win on TaskFlow's bill. And the last two rows show a trap. "One NAT instead of three" sounds economical, but the other two AZs' traffic has to travel to the NAT's AZ (the cross-AZ price), so at high traffic it is **more** expensive ($3,795). After the endpoints traffic is low, and then one NAT really is cheaper ($143 versus $197). But in 10.3's terms, if that AZ dies, the other two AZs lose their way out: Stripe, the email provider, everything. Making one AZ's outage the whole system's outage to save $54 a month. This is a pure trade between cost and reliability, and the answer depends on whether the outbound calls are hard or soft dependencies.

**Across AZs, part C.** 6 internal calls per request (30 KB each) and 40 KB to the DB, three AZs:

```
design                                 GB / month  cost / month  note
monolith: internal calls are function calls  20.7 TB       $415  only app → primary
services, sent to any AZ           114.0 TB     $2,281  67% of internal calls to another AZ
services, same AZ first (AZ-aware)       34.7 TB       $695  10% to another AZ (fallback)
+ a read replica in every AZ           18.1 TB       $363  reads in their own AZ, writes to the primary
```

Another dimension of 9.1's "a network call is not a function call": it costs money too. If the load balancer ignores AZs, two-thirds of calls across three AZs go to another AZ, and every GB is charged in both directions. Experiment 4: at 20 calls per request, $6,636, 16 times the monolith. **AZ-aware routing** (instances in the same AZ first, another AZ only if none) cuts that by two-thirds. Topology-aware routing in Kubernetes, locality-weighted load balancing in a service mesh. And it has a reliability cost too: if more traffic arrives in one AZ, that AZ's instances come under strain even while other AZs are idle. So this routing needs a separate autoscaler per AZ and a limit ("if your own AZ's instances are more than 80% busy, send to another AZ"). (Latency drops too, because round trips within one AZ are usually shorter. Not measured here.)

### 1.6 The price of security and visibility - and a DDoS bill

In 10.4 and 10.5 I said several times "this has a price". Now in numbers.

**Observability:** 11% of the bill. Metric series ($1,800, 10.4's cardinality: every series has a monthly price, and old experiments with unnecessary labels are still running), logs ($846, the forgotten debug log), the trace collector ($280). Notice that after tail sampling, **trace storage costs $9 a month**. 10.4's tail sampling costs not in storage but in the collector's compute ($280). There is a common rule of thumb for observability spending, and it is usually seen at 5–15% of the bill. TaskFlow's 11% is fine, but half of it was waste.

**The DDoS bill.** 10.5's L7 flood: 60,000 req/s, 4 hours, 30 KB per response. `npm run capacity` part C:

```
where it stopped                                extra instances   compute  data transfer   request fees     total
autoscale at the origin, no limit                         1,334    $1,025        $2,333             $0    $3,357
autoscale at the origin, limit 40                            40    $30.72          $117             $0      $147
answered from CDN cache (cache key fixed)                     0        $0        $2,203           $648    $2,851
block / challenge at the edge (1 KB answer)                   0        $0        $73.44           $648      $721
```

One four-hour attack, a bill from $721 to $3,357, depending on where it was stopped. Without an autoscaling limit the system **happily serves** the attack, and sends the bill. (In reality the database would have collapsed long before, 10.3.) With a limit of 40 the bill is $147, but the origin is swamped by the attack, so most legitimate users' requests fail too (10.5's part C). Answering from the CDN cache saves the origin, but you pay the CDN's egress and request fees. Cheapest of all is giving the attack a **small** answer, at the edge. And one thing not captured here at list prices: many CDN and DDoS protection services waive the bill for attack traffic, or keep it under a separate agreement. Check their terms (not verified here). The lesson: **an upper limit on autoscaling is a cost control**, just as 10.3's bulkhead is a reliability control.

### 1.7 Watching cost - anomalies, owners, and trade-offs

TaskFlow's budget alert was: email if the month's bill exceeds $30,000. It never fired once in six months. And yet the bill grew two and a half times. Why?

`npm run bill` part D: 60 days of daily bills, by category (compute, database, network, storage, logs, …). Each has its own daily fluctuation and slow growth, starting from the clean "after" state (~$287 a day). On day 42 someone turns on debug logging on three services and forgets about it (+$22.50/day, 7.8% of the total). On day 51 a bug puts export into a loop (+$270/day, in NAT and egress). Four detectors:

```
detector                                       caught debug logs  caught export loop  false alarms (days 1–40)
over the monthly budget (last month +10%)    missed      6 days later                   0
end-of-month forecast > budget                 9 days later    1 day later                    0
total daily > 7-day average × 1.2               missed      1 day later                    0
each category daily > its own 7-day average × 1.5  1 day later     1 day later                    0
```

**Cost Anomaly Detection** - looking at the bill not as one number at the end of the month but as a daily (or hourly) time series, split by category (service, team, line), and comparing each to its own history. A small jump gets lost in the total bill; in its own category it is tenfold.

Sound familiar? In 10.4 the average latency hid the p99. In 10.6 the total error rate hid a segment's bug. Here the total bill hides a tenfold rise in one line. The debug log is 8% of the total bill and is never caught by the monthly budget. But in the log line itself it is **30 times** ($0.77 to $23 a day), and the per-category detector catches it the very next day. And even the big incident (the export loop) is caught by the monthly budget **6 days** later, meaning $1,600 later. An alert that looks at one number once a month is really an accounting statement, not monitoring.

The habits behind this have a name, **FinOps**: making cost a daily part of engineering work. A tag on every resource (team, service, env), so the bill can be split (1.2). Every team with its own cost dashboard and an owner. Tracking unit cost as a metric. And one question in design reviews: "what is its monthly price, and what drives it?"

**Trade-offs.** Almost every number in the "after" column has a price, and that price is often paid in reliability or speed:

| Saving                                | How much (monthly) | What is lost                                                                     | When it is worth it                                     |
| ------------------------------------- | ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Staging at ¼ size, working hours only | $4,281             | Load tests matching reality; testing the night jobs                              | Almost always; a separate, temporary env for load tests |
| S3 gateway endpoint                   | ~$2,700            | Almost nothing                                                                   | Always                                                  |
| Autoscale (instead of fixed)          | $1,934             | A few minutes of strain at the start of a spike; the risk of new instances' boot | When traffic fluctuates and boot is fast                |
| Commitment                            | ~19% of compute    | Flexibility - tied for 1–3 years                                                 | On the always-running base, committing a little less    |
| Spot (workers)                        | $364               | Interruptions - harmful unless jobs are idempotent and short                     | 7.4's workers, batch, CI                                |
| AZ-aware routing                      | $1,586             | Balance between AZs; load can pile up in one AZ                                  | When there are many internal calls                      |
| One NAT                               | $54                | If one AZ dies, everyone loses the way out                                       | Almost never, in production                             |
| Log sampling, 14 days                 | $823               | Logs of old and rare events                                                      | If errors and slow requests are always kept             |
| Storage tiers                         | ~$422              | Retrieval cost for reading old files, and (in the deep classes) time             | With a file-size filter                                 |

One principle comes out of this table: **savings that only cut waste (staging, endpoints, debug logs, undeleted pools, compression) come first.** Savings that sell reliability (one NAT, fewer replicas, dropping Multi-AZ) only through error-budget (1.5) arithmetic, and with numbers: "to save $54 a month, how many hours of outage risk a year are we taking on, and what do they cost?"

### 1.8 TaskFlow's decision

> **Trade-off Table - the three questions of cost, in every design**

| Question                            | Where to look                              | What changed in TaskFlow                                    |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| "Which driver does this grow with?" | Time / storage / movement / events         | A one-line cost estimate in every design doc                |
| "How much per unit?"                | Unit cost: workspace, seat, endpoint       | Showback by plan, export limits, free-plan quotas           |
| "Who will know when this changes?"  | Tags, daily anomalies per category, owners | A dashboard per team, alerts per category, a monthly review |

**Compute:** autoscaling on the app (target 60%, min 3, max 40), with known peaks and marketing events scheduled. A one-year flexible commitment on the always-running base, near the 75–80th percentile of hourly usage (a little under the measured rule). Workers and CI on spot, across several instance types and three AZs. Staging at ¼ size, off at night and at weekends, with a temporary full-size env on demand for load tests. Blue-green's pool deleted automatically at the end of a deploy (a step in 10.6's pipeline).

**Network:** an S3 gateway endpoint, an interface endpoint for container images, smaller images. One NAT per AZ (kept, for reliability). Compression on the API. AZ-aware routing between services, with each AZ's own autoscaler and an 80% limit. A read replica in each AZ. Previews on the board, not the original images.

**Storage:** S3 lifecycle: old versions deleted after 30 days, objects ≥128 KB to IA after 30 days and Glacier IR after 180 days. Small objects stay in Standard. Activity partitions older than 90 days go to S3 as Parquet. Backups for 14 days, plus a monthly long-term copy in cheap storage.

**Observability:** debug logs only through a flag, off after 30 minutes (10.4's rule, now with a test in CI). A 10% sample of successful requests' logs, every error and slow request. 14 days in the searchable store, then S3. Metric labels cleaned up, a series limit per metric.

**Watching:** `team`, `service` and `env` tags on every resource. CI blocks resources without tags. Daily cost, by category, each compared with its own 7-day average, and a ticket to that team at 1.5 times. An alert on the forecast of the month's budget. A 30-minute review every month: the line of unit cost, the five biggest changes. An autoscaling maximum on every service, for DDoS and runaway loops. And a new section in the design review template: "monthly price and its driver."

---

## 2. Interview Angle

Cost almost never comes up as a separate question. It comes in two ways. First, inside estimation: "how much will this cost to run?" Second, during trade-offs: "you're keeping three replicas - why not two?", "would this be cheaper on serverless?" At senior level, often directly: "you've been asked to halve this system's cost - where would you start?" The weak answer is "buy reserved instances, use spot." The shape of a good answer:

1. **Measure first, then cut.** "I'd split the bill by driver: compute, storage, network, observability. Usually the biggest surprises are in network and non-production." Speak in unit cost: per user or per request.
2. **Waste first, reliability later.** Idle resources, old data, default network paths (NAT, cross-AZ), compression. Then autoscaling, commitments and spot, each in its own part.
3. **State the cost of every cut.** "One NAT saves $54, but one AZ's outage becomes everyone's outage." The trade between cost and reliability, in the language of error budgets.
4. **Watching.** Tags, daily anomalies per category, team ownership. A one-off cut grows back if nobody watches.

**Follow-ups that are almost certain:**

- _"How many reserved instances / how much savings plan would you buy?"_ - for the always-running base. The rule: where usage stays above it for more than `(1 − discount)` of the time. For TaskFlow at a 35% discount, 5, where the average is 7.6. And choose a flexible kind.
- _"Where does spot go?"_ - on stateless, idempotent work that tolerates interruption: workers, batch, CI. With headroom and several instance types. Not on the database or a sole instance.
- _"Are microservices expensive?"_ - every internal call has a network price, more if it crosses AZs. AZ-aware routing, fewer and fatter calls. And each service's minimum capacity, monitoring and people.
- _"Where would you keep the data?"_ - tiered by age and usage, with lifecycles. And know the three hidden costs: minimum object size, transition requests, retrieval.
- _"Is serverless cheaper?"_ - at low or irregular traffic yes, because idle time costs nothing. At steady, high traffic often not, because the per-request price is higher than an instance's. Draw the two lines and say where they cross. (Not measured here.)

**In real production:** the most common incidents: a prod-size staging, 24/7. S3 or container image traffic through NAT. Cross-AZ calls nobody knows about. Versioning without a lifecycle. Debug logs and unnecessary metric labels. Snapshots, volumes, load balancers and IPs that were never deleted (the leftovers of deleted instances). A loop with no autoscaling maximum. And a monthly budget alert as the only monitoring.

---

## 3. Key Takeaway

- **Cost is a requirement, like latency and availability.** Every design decision changes one of four drivers: time, storage, movement, events. Nobody designed the biggest lines on TaskFlow's bill (staging 18%, NAT 11%, cross-AZ 7%), and most of the 69% was cut without changing any architecture
- **Unit economics makes decisions possible.** $13.15 per workspace on average, but one free workspace $1,528. Export is 0.013% of calls and 25% of variable cost. Cost per seat is almost the same on every plan, so pricing by seat matches the shape of the cost
- **80% of capacity bought for the peak is idle.** Autoscale the part that rises and falls (62% cheaper, 4 minutes of strain a week). Commit the always-running base (usage ≥ c for more than `(1 − discount)` of the time; 5 for TaskFlow). Spot for the part that tolerates interruptions, with headroom
- **A storage class's price is not just GB-months.** Lifecycles for old versions plus tiering by age turn $32,424 into $7,445 over 24 months. But for small objects the "cheap" classes cost 2.6 times as much (the 128 KB minimum + transitions). And the cost of logs is in ingestion, not retention
- **Where bytes move is often the biggest hidden cost.** $1,400 from compression, ~$2,700 from an S3 gateway endpoint, ~$1,900 from AZ-aware routing and a replica per AZ. A CDN is not always cheaper. And one NAT saves $54 a month by making one AZ's outage everyone's
- **A DDoS bill is decided by where it is stopped.** $3,357 with unlimited autoscaling, $721 with a small answer at the edge. An autoscaling maximum is a cost control
- **The total bill hides a jump in one line.** A monthly budget alert never catches the debug log, and catches the export loop in 6 days. Per category, compared with its own history, it is caught the next day. Tags, owners and daily watching (FinOps)

---

## 4. New Terms (Glossary)

| Term                       | Meaning                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit Economics**         | Dividing total cost by a business unit (customer, workspace, seat, request) and comparing it with that unit's revenue; the total bill says "how much", unit cost says "is it sustainable, and what happens as it grows"           |
| **Cost Allocation**        | Splitting shared cost among teams, products, plans or customers by its driver (requests, GB, seats); rests on resource tags. Showing it is showback, charging it is chargeback                                                    |
| **Commitment Discount**    | A discount for promising fixed usage for 1–3 years (Reserved Instances, Savings Plans); paid even if unused. One more committed unit pays off as long as usage stays above it for more than `(1 − discount)` of the time          |
| **Spot Instance**          | A provider's unused capacity, much cheaper, that can be taken back at short notice; for stateless, idempotent, interruption-tolerant work (workers, batch, CI), with headroom and several instance types                          |
| **Data Transfer Cost**     | Pricing by the bytes' path: internet egress is most expensive, crossing AZs is charged both ways, NAT charges per-GB processing, crossing regions is separate; ingress and same-AZ are usually free                               |
| **Storage Tiering**        | Moving data from expensive-fast to cheap-slow classes by age and usage, with lifecycle rules; the cheap classes' hidden costs: minimum object size and duration, transition requests, retrieval                                   |
| **Cost Anomaly Detection** | Viewing the bill as a daily time series, by category (service, team, line), comparing each with its own history; a small jump lost in the total is big in its own category - a monthly budget alert is accounting, not monitoring |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. The product team wants a new feature: a "today's boards" digest email to every user every morning. 60,000 MAU. For each digest, a 50 ms query on a replica, 20 ms of rendering, a 20 KB email. The email provider charges $0.10 per 1,000 emails (assumed). (a) Estimate the monthly cost, by driver. Which driver is biggest? (b) Should this be offered to the free plan's 28,000 users, and which design halves the cost without killing the feature? (c) What would a cost alert for this feature be, and which one bug could make it ten times bigger overnight?

2. TaskFlow's traffic is growing 5% a month. The CFO asked: "A three-year commitment gets 60% off, a one-year one 35%. Why don't we buy the whole thing for three years, equal to today's peak?" (a) Using the numbers from `npm run capacity` part B, what is the problem with "equal to today's peak"? (b) With growth, how much will you commit, and when? (c) What could change in three years that makes a commitment useless, and which kind of commitment reduces that risk?

3. The CFO asked for another 30% cut. Four proposals came in: (1) all app instances on spot, (2) drop the Multi-AZ standby, (3) drop one of the two read replicas, (4) metric retention from 13 months to 1 month. For each: how much it saves (using the bill's numbers), what is lost (in the language of 10.3 and 1.5), and your decision. Finally, write the CFO a one-paragraph answer.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) 60,000 digests a day, 1.8 million a month:

```
email provider:   1.8M ÷ 1,000 × $0.10                          = $180
DB (replica):     1.8M × 50 ms = 90,000 s CPU-ish ≈ 25 hours - ~$0 if the replica already has spare capacity;
                  if not, a morning peak: spread 60,000 queries over 1 hour, ~17 queries/s, easy
render (worker):  1.8M × 20 ms = 10 worker-hours → ~$1 on spot
egress:           sent to the email provider 1.8M × 20 KB = 36 GB × $0.09 (+$0.045 if through NAT) ≈ $5
log:              one line per email, 1.8M × 350 B = 0.6 GB × $0.5 ≈ $0.3
total ≈ $190 / month - almost all of it the email provider
```

The biggest driver is **events** (the number of emails), not compute. This is a common picture: external APIs (email, SMS, push, LLMs) charge per call, and that sets the shape of the cost.

(b) ~$90/month for the free plan's 28,000 users. Small, but the question is about proportion: only the **active** part of free users will read a digest. Designs that cut the cost without killing the feature:

- Send only to users active in the last 7 days, and not to anyone whose boards had no changes yesterday (nobody wants a "nothing today" email). Usually the number drops below half.
- A weekly digest on the free plan, daily on paid. A seventh of the cost on free, and a reason to upgrade.
- Users can turn it off themselves (and unopened emails switch themselves off after 30 days).

(c) Alert: the daily number of digests, and the email provider's daily cost, against their own 7-day average (1.7's detector). A good alert is "emails sent ÷ MAU > 1.1" - more than one per user means something is wrong. The bug that makes it ten times bigger overnight: **duplicates on retry** - the job fails and runs again, and without idempotency (7.4) every retry sends to everyone again. Or a loop that sends every member of every workspace a separate email per board. An idempotency key (`digest:{userId}:{date}`) and a daily upper limit ("no more than 100,000 today") are both needed.

**Question 2:**

(a) "Equal to today's peak" means 20 (the size of part A's fixed fleet). In part B's table, at a 35% discount, committing 12 is already **8.6% more expensive** than on-demand. 21 would be 78.5% more. Even at a 60% discount (experiment 1), 21 is 9.9% more. The peak lasts less than 20% of the week, so a commitment for that capacity sits unused most of the year. Commit the base, not the peak.

(b) With growth the base rises, so commit not all at once but **like a staircase**: today the amount measured by the rule (5 at 35%, or a little less), then every 3–6 months add another small commitment based on the new usage, each with its own term. Each step then matches the base of its time, and the terms end at different times (no pressure to renew everything at once). Take the three-year discount only on the part of the base you are nearly certain will be there for three years (say the database, or the app's minimum of 3). The rest on one year.

(c) What could change in three years: a new generation or type of instance (moving to ARM is 20% cheaper, and reservations for the old type become useless), region (a second region in 10.8), architecture (some parts moving to serverless or a container platform), the business (traffic not growing, or a big customer leaving), and prices themselves (cloud list prices often fall over time). **Flexible commitments** reduce the risk: a promise of so many **dollars** of compute per hour, not a specific instance type (like AWS's Compute Savings Plan), which applies across types, sizes, regions, even some serverless. A slightly smaller discount, but a much smaller cost for future mistakes.

**Question 3:**

(1) **All app instances on spot:** the app line could fall by another ~$400 from $869 (with commitment). But commitments and spot do not combine, so the real saving is less, and the base of 3 on-demand is lost. Many spot instances can be taken back at once (when demand rises for the same instance type in the same AZ). Then the app's capacity suddenly halves, and users suffer during the 5-minute boot. In experiment 2, 83 interruptions were tolerated because there was a base of 3 on-demand and 40% headroom. All on spot, and that certainty goes. **Decision:** no. The base on on-demand + commitment, part of the upper fluctuation on spot (several instance types, across three AZs), all workers on spot.

(2) **Drop the Multi-AZ standby:** half of the primary's $1,460 line, ~$475/month with commitment. Lost: when the primary's AZ or machine dies, instead of an automatic failover (1–2 minutes), promoting a replica by hand, or restoring from backup. Hours of outage, and if promoting from an async replica, the chance of losing the last few seconds of writes (5.7, 6.1). On a 99.9% SLO the month's error budget is 43 minutes. One failover incident uses it all up. **Decision:** no. The production primary database is exactly the place where redundancy is bought. In staging, yes.

(3) **Drop one read replica:** ~$475 with commitment. Lost: half the read capacity (all reads on one replica), all reads on the primary while a replica is in maintenance or dies (5.7). And 1.5's cross-AZ saving from "a replica per AZ" shrinks. **Decision:** measure it. What is the replicas' CPU? If both are under 30%, shrinking the replicas (fewer vCPUs) is better than dropping one: cost falls by about as much, and the redundancy stays.

(4) **Metric retention from 13 months → 1 month:** metric cost is usually in the number of series, less in retention (1.4's log reasoning). So the saving is probably small; it depends on the provider's pricing structure. Lost: year-over-year comparison, capacity planning (last November's peak), finding slow regressions. **Decision:** no; instead downsample old data (keep 13 months, but at 1-hour resolution after 30 days). Far less space and cost, and long-term comparison stays.

**Answer to the CFO:** "We have already cut the bill by 69% ($26,290 → $8,276, from 10% of revenue to 3%). Almost all of it by cutting waste, with no concession on reliability. Three of the four new proposals (all spot, dropping Multi-AZ, dropping a replica) together save ~$1,300 a month, but each turns a specific failure into an hours-long outage. On our 99.9% promise, one of them alone uses up a whole month's error budget, and the SLA compensation to business-plan customers for one incident would exceed this. Instead of the fourth (metrics) we will downsample. The remaining opportunity is right-sizing the replicas and a storage limit on the free plan (the school district alone costs $1,528 a month). That is a product decision, and we can provide the numbers. And from now on every team has its own cost dashboard and daily alerts, so this conversation happens in six days, not six months."

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (four deterministic cost models; no cloud account or Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-10.7-cost/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.7-cost) - `npm install`, then `npm run bill`, `npm run capacity`, `npm run storage`, `npm run traffic`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`bill` builds TaskFlow's monthly bill in 23 lines (before and after), splits it by plan and by endpoint, and runs four anomaly detectors over 60 days of daily bills. `capacity` runs a week of traffic one minute at a time under four policies, finds the commitment amount, and measures a DDoS bill stopped in four places. `storage` measures the attachment lifecycle over 24 months, the small-object trap, log ingestion versus retention, and the activity offload. `traffic` compares designs for egress, NAT versus endpoints, and traffic across AZs. `bill`'s app line comes from the same model as `capacity` (`src/fleet.ts`).

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the four scripts twice each, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is yours. **Every price is approximate.** An estimate of a big public cloud's list prices, matched to 8.1's numbers, in one place in `src/prices.ts`, and not verified here. Real prices vary by region, provider, volume tier and contract. **TaskFlow's quantities are assumed too** (300 req/s, 6 internal calls and 30 KB per request, 60 TB of S3 traffic through NAT, the free plan's share, endpoints' CPU and DB ms, email prices), taken from earlier lessons' numbers. The "$11,000 six months ago" in the CFO's email is part of the story, not measured. Cost by plan uses one particular driver rule (requests, GB, seats); another rule would give other numbers. `capacity` is a simulation: spot interruption is a per-hour probability, instance boot is 5 minutes, and a real autoscaler may behave differently. **Not measured:** a real cloud bill, serverless pricing, the effect of AZ-aware routing on latency, the terms for waiving bills under DDoS protection, CDN volume discounts. TaskFlow's decision in 1.8 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `bill`, write down: what will the three biggest lines on TaskFlow's bill be, and what % will network be? Then run it and compare. Which line surprised you most, and why did nobody design it?

2. **Your own commitment:** `COMMIT_DISCOUNT=0.6 npm run capacity` and `COMMIT_DISCOUNT=0.2 npm run capacity`. How does the best commit change? Check the "% of hours usage ≥ c" column against the `(1 − discount)` rule.

3. **Your own lifecycle rule:** add a new policy in `src/storage.ts`: IA at 90 days, Glacier IR at 365 days, and small objects never. What is the 24-month total? Then try `EXPORT_GB=20000`: from what point does retrieval eat up the tiering saving?

4. **A feature's price:** add reflection question 1's digest to `ENDPOINTS` in `src/bill.ts` (`callsPerMonth: 1_800_000`, DB and CPU ms, 20 KB out) and a line for the email provider's cost. Do your hand arithmetic and the model agree?

5. **The design part:** a one-page "cost policy" for TaskFlow. (a) The list of tags for every resource and how CI will enforce them. (b) Three unit-cost metrics, and for each, which change wakes whom (ticket, not page). (c) Which three questions will be in the cost section of the design review template. (d) Which savings will never be made (the reliability line), and why. (e) Two limits for the free plan, with the reasoning from unit-economics numbers.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
Current: 10.7 - Cost & cloud economics
TaskFlow state: modular monolith + billing; gateway + BFF; saga; breaker + bulkhead; rate limits; cache ring;
Bloom/HLL; hard/soft dependencies + brownout; OpenTelemetry, burn rate alerts; AuthN/AuthZ, OAuth PKCE,
secret manager, DDoS layers; graceful shutdown, canary + gate, flags, expand/contract. The bill went from
~$11k to $26,290 in six months (users +30%), nobody knew where; the budget alert never fired. By line:
staging at prod size 24/7 (18%), S3 and images through NAT (11%), 20 app instances sized for the peak (20%
average utilization), cross-AZ calls, metric labels, uncompressed JSON, no lifecycle for versions, an
undeleted blue-green pool, a forgotten debug log. Now ($8,276, 69% less): app autoscaling (60%, min 3, max
40) + scheduled + 5 flexible commits; workers and CI on spot; staging ¼, off at night; S3 gateway endpoint
+ image endpoint, one NAT per AZ kept; compression; AZ-aware routing (autoscaling per AZ, 80% limit) + a
read replica per AZ; previews; S3 lifecycle (versions 30 days, ≥128 KB to IA at 30 days, Glacier IR at 180
days); activity after 90 days as Parquet in S3; backups 14 days; log sampling + 14 days; metric labels
cleaned up. Watching: team/service/env tags (enforced in CI), unit cost by plan and endpoint, daily
anomalies per category (own 7-day average × 1.5), budget forecast, autoscaling maximums, "monthly price
and driver" in design reviews. Free plan: one school district alone $1,528/month - storage and seat limits
are product's decision.
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7), Deploy / Release, Blue-Green Deployment, Canary Release, Feature Flag,
Version Skew, Lock Queue, Expand / Contract, Unit Economics, Cost Allocation, Commitment Discount, Spot
Instance, Data Transfer Cost, Storage Tiering, Cost Anomaly Detection
Weak spots: [where you got stuck - write it yourself]
Next: 10.8 - Multi-region & geo-distribution
=======================
```

---

## 8. Next Step

Today's thread: **cost is a requirement, and every line of the bill is a design decision whose price nobody wrote down.** The biggest lines come from defaults and habits: staging, NAT, calls across AZs. Split cost by unit and decisions become possible. Compute's three levers are for three different parts. The "cheap" classes have hidden costs. Where bytes move is often the biggest surprise. And one number at the end of the month is not monitoring.

One price kept coming up today, but we never saw all of it: the cost of crossing AZs. Between three AZs in one region, a few miles apart, a millisecond round trip. Now picture two regions, Dhaka and Frankfurt, thousands of kilometres apart, 150 ms per round trip. One of TaskFlow's big European customers has said their data cannot leave Europe. And users in Singapore are complaining that opening a board takes 800 ms. When you are ready, write `next` - we go to **Lesson 10.8: Multi-Region & Geo-Distribution**. The question there: what becomes hard again when a system runs in several regions (consistency, where writes go, failover, where data lives), and when that is worth the cost and the complexity. And when it is not.
