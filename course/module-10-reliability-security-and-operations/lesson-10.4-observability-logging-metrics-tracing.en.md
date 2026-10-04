# Lesson 10.4 — Observability: Logging, Metrics, Tracing

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 6.4):** What can go wrong if you sort the log lines of two different machines by timestamp — and why does "an earlier timestamp" not mean "happened earlier"? Today you will have to read four services' logs together, and you will have something in hand that tells you which piece of work happened **inside** which other, without relying on clocks.

**Prerequisite:** Lesson 1.5 (Percentiles, SLO, error budget), Lesson 5.6 (N+1, connection pool), Lesson 6.4 (Clock skew), Lesson 7.3 (Background jobs), Lesson 9.2 (Gateway, request id), Lesson 10.2 (Cardinality), Lesson 10.3 (Steady state, brownout)

**By the end of this lesson you will be able to:**

1. Say **which questions** logs, metrics and traces each answer and which they do not — and design a latency metric (histogram, buckets, labels) so that the p99 stays honest and the metric system does not die
2. Tie one request across four services into one trace — the `traceparent` header, context propagation, the trace id in logs — and say which traces to keep (head versus tail sampling) and what that costs
3. Build a **burn rate** alert from an SLO, and say with numbers why an alert like "error > 1%, 5 minutes" both misses slow decay and wakes people up for nothing every day

**Tier:** 1 — Runnable Code (four deterministic simulations — percentiles, cardinality, sampling, burn rate; plus a distributed trace across four real HTTP services on localhost; no Docker needed)

---

## 0. Where TaskFlow Is Right Now

After 10.3, every TaskFlow journey has its hard and soft dependencies written down, flags have a snapshot, and the board knows how to brown out. And one question was left hanging at the end of 10.3: on Saturday night the on-call engineer could not find `flags` for 25 minutes, because no graph pointed them there.

TaskFlow's way of "seeing" is currently this: every instance writes text lines with `console.log` (`loading board 4821`), and they go to a log store. There is a Prometheus with a few metrics — each service's average latency and error rate. One dashboard, and one alert: "page if the error rate is above 1% for 5 minutes". That alert fires every day at 2 p.m. during the deploy — a two-minute blip — so most of the on-call people have muted it on their phones.

**Wednesday.** Tickets started arriving at support: "opening a board sometimes takes 4–5 seconds." On the dashboard the board's average latency is 170 ms — the alert threshold is 300 ms, so green. The error rate is normal.

**Wednesday afternoon.** The on-call engineer opened the logs. Six instances, millions of lines. `loading board`, `board loaded`, `query done` — no line carries any request id. A 4.2-second request turned up in the gateway's log, but there was no way to tell which lines in the work service belonged to it. They tried matching timestamps — the six machines' clocks were a few ms apart (6.4), and at that moment there were 300 requests a second.

**Wednesday night.** Another engineer had an idea: add `user_id` and the actual `path` as labels on the latency metric, and then we can see which user and which board are slow. They deployed it. Forty minutes later Prometheus ran out of memory and the process died. It restarted, filled up again, died again. That night TaskFlow had **no metrics and no alerts at all.**

**Thursday.** Someone turned on `DEBUG` logging on every instance. Log volume went up twenty-five times, and log store ingestion fell two hours behind — meaning the current logs could only be seen two hours later. At the end of the month, the log bill.

**Friday.** A DBA, in the cloud console for an unrelated task, happened to notice: one of the three read replicas, `r3`, had sharp spikes now and then on its disk latency graph. A "noisy neighbour" on the cloud provider's storage. Two days.

The CTO's one line in the postmortem: "We had data — gigabytes and gigabytes of it. We didn't have answers. And while looking for answers, we broke two things ourselves."

---

## 1. Theory

### 1.1 Monitoring versus Observability — and the three signals

What TaskFlow had was **monitoring**: a few questions decided in advance ("what is the average latency? what is the error rate?"), and graphs of their answers. The problem was that Wednesday's question was not decided in advance: "**which** board requests are slow, and **how** do they differ from the rest?" A question like that required deploying new code (adding labels), and that is what broke everything.

**Observability** — the ability to answer **new, unanticipated** questions about a system's internal state from the signals it emits (logs, metrics, traces) — without deploying new code; if monitoring answers known questions, observability lets you search for answers to unknown ones.

The word comes from control theory — how "observable" a system is means how much of its internal state can be understood from its outputs. In software three kinds of signal are commonly used, and each answers a different question:

| Signal     | What                                                                               | The question it answers                                              | The question it does not                                          | What drives its cost                             |
| ---------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| **Metric** | A time series of numbers, aggregated up front (count, sum, histogram), with labels | "How much, how often, since when?" — trends, alerts, dashboards      | "What happened in **this** request?" — individual events are gone | The number of label value **combinations** (1.4) |
| **Log**    | A record of each event, with any fields                                            | "What exactly happened in this event, with what values?"             | "How often?" — counting means reading everything, slow and costly | Number of events × their size                    |
| **Trace**  | One request's whole path — which service, which work, how long, what inside what   | "**Where** did this request's time go, and which work called which?" | "What's the state across all requests?" — most traces are dropped | Requests × spans; hence sampling (1.6)           |

These are not three separate tools but three views of the same event. The path to solving Wednesday's problem should have looked like this: the **metric** says "something is bad" (the p99 went up), the **trace** says "where" (in r3's query), the **log** says "why, with exactly what values" (which query, which board, which error). And one thing binds the three together — an **id**, which takes you from a metric to a trace and from a trace to logs. TaskFlow had none of the three in proper shape, and no id at all.

### 1.2 What the average hides

In 1.5 you learned that averages mislead and to look at the p99. Now let us see the numbers. The exercise's `npm run percentiles` — an hour of board opens (1.08 million requests), six instances, three replicas; `r3`'s disk stalls three times an hour for 90 seconds each:

```
average           p50       p90       p99     p99.9       max     > 1 s
172 ms         79 ms    132 ms    3.79 s    4.50 s    4.77 s     2.50%
```

The average is 172 ms — under the dashboard's 300 ms threshold, green. The p99 is 3.79 seconds. And **2.5% of requests take more than a second** — one in every 40 board opens.

2.5% sounds small. But a user does not open a board once. Say a project manager opens 20 boards a day. The probability that they hit at least one slow one:

```
1 − (1 − 0.025)^20 = 1 − 0.975^20 ≈ 40%
```

**Every day 40% of users wait 4 seconds at least once**, and the dashboard says everything is fine. That is why the tickets were coming in — they were not exceptions, they were nearly half the users. The tail of the percentiles is where users live, because every user makes many requests, and if any one of them is slow, the experience is slow.

And notice where the 172 ms average came from: normal requests are ~84 ms, and the 2.5% at ~3.5 seconds doubled the average. The average did move — but it did not cross the threshold, and nobody took "84 to 172" as a signal.

### 1.3 Percentiles cannot be added — the Histogram

Now a subtle trap that almost every dashboard falls into. Say you do watch the p99 — you measure a p99 every minute. The dashboard has to show "the p99 over the last hour". How do you build it from 60 per-minute p99s? `npm run percentiles`, part B:

```
true p99 (all requests together)            3.79 s
average of 60 per-minute p99s                617 ms
median of 60 per-minute p99s                 187 ms
max of 60 per-minute p99s                   4.52 s

minute          avg       p99     > 1 s
11           84 ms    183 ms      0.0%
12          1.25 s    4.52 s     33.2%
13          675 ms    4.46 s     16.9%
14           84 ms    184 ms      0.0%
```

**The average of the per-minute p99s is 617 ms — a sixth of the truth. The median is 187 ms — the problem has almost vanished.** Because only 6 of the 60 minutes had a stall; the other 54 have a p99 of ~185 ms, and when you average, those 54 drown the 6. Yet with the hour's requests taken together, 2.5% are slow — well above the p99's threshold (1%).

A percentile is a **position** — "who is at the 99th percent when sorted". You cannot derive the position in a combined group from the positions in two groups, just as in 10.2 you could not get a week's count by adding two days' distinct user counts. Nor is it even certain which direction the error goes — in the exercise's experiment 1 (`STALL_SECONDS=20`, short stalls) the true p99 is 208 ms, and the average of the per-minute p99s is 396 ms — this time it **overstates**. Averaging percentiles gives a meaningless number, whichever way it goes.

The solution is to keep not percentiles but something that **can be added**:

**Histogram** — a metric that does not store every value, but only counts how many values fell into which bucket (like "under 50 ms", "under 100 ms", …); bucket counts can be added — across instances, across minutes — and any percentile can be estimated from the sum, with accuracy depending on where the bucket boundaries are.

Add six instances' histograms and you get exactly one big histogram; add 60 minutes' and you get exactly the hour's histogram — nothing is lost. In Prometheus this is `histogram_quantile(0.99, sum by (le) (rate(...[1h])))` — add the buckets first, then take the percentile. But how good the estimate is depends on the buckets. Part C:

```
percentile        true  default buckets    error   own buckets       error
p50              79 ms           82 ms      +3%         80 ms      +1%
p90             132 ms          205 ms     +55%        141 ms      +7%
p99             3.79 s          4.00 s      +6%        3.78 s      -0%
p99.9           4.50 s          4.90 s      +9%        4.86 s      +8%
   default buckets (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000
   own buckets     (ms): 50, 75, 100, 150, 200, 300, 500, 1000, 2000, 3000, 4000, 5000
```

With the Prometheus client library's default buckets the p90 estimate is **55% too high** — because the true p90 (132 ms) sits in a wide bucket between 100 and 250, and inside a bucket the estimate is linear. Buckets should be **where your decisions are made** — dense around the SLO threshold (say for a 300 ms SLO: 200, 250, 300, 350), and sparse far away. Experiment 2: adding just 150 and 200 to the defaults takes the p90 error from +55% to +7%. But every bucket is a separate time series — and that is the cost in the next section.

**Now the right dimension.** We know the p99, but there is no answer to "why?". Part D — the same requests, split two ways:

```
dimension          requests       avg       p50       p99     > 1 s
instance 1       180,000    170 ms     79 ms    3.77 s     2.47%
instance 2       180,000    173 ms     79 ms    3.79 s     2.53%
…
replica r1       359,847     84 ms     78 ms    185 ms     0.00%
replica r2       360,375     84 ms     78 ms    187 ms     0.00%
replica r3       359,778    346 ms     81 ms    4.31 s     7.49%
```

Split by instance, all six are identical — no information. Split by replica, the answer is visible at a glance: **r3**. The Wednesday-night engineer's instinct was right — "add a dimension and split by it". What was wrong was which dimension, and where it was added.

### 1.4 Cardinality — the label that kills the metric system

`replica` is a good label: three values. How many values do `user_id` and the actual `path` have? A metric system keeps a separate time series for **every distinct combination of labels** — in memory, each with its own series of numbers. `npm run cardinality` — one day's traffic (8.64 million requests, 100,000 users, 200,000 boards), one latency metric, varying the set of labels:

```
labels                              counter series   histogram (×15)      estimated memory
method, route, status, instance              2,400            36,000            103 MB
+ plan (free/pro/business)                   7,114           106,710            305 MB
actual path instead of route             2,529,996        37,949,940            106 GB
+ user_id                                2,534,244        38,013,660            106 GB
+ trace_id                               8,640,000       129,600,000            362 GB
```

**Label Cardinality** — the number of possible combinations of a metric's label values, i.e. how many separate time series it creates; it can reach the **product** of the number of distinct values of each label, and the metric system's memory, CPU and cost grow with this number — not with traffic.

(In 10.2 cardinality meant "how many distinct things" — counted with HyperLogLog. Here it is the same word with the same meaning, only the things are label combinations. And here too the price of an exact answer is remembering every one.)

Three things from the table:

1. **The problem is a product.** 40 routes × 10 statuses × 6 instances = 2,400. Adding plan (3 values) almost triples it. Every new label **multiplies** the previous ones, it does not add.
2. **A histogram is another 15 times.** Each combination has 13 buckets (including +Inf) plus `_sum` and `_count`. So 1.3's "add more buckets" has a price.
3. **The actual path and `user_id` — 2.5 million series, ~106 GB.** Wednesday night's OOM. And notice that this is a single day's number — new users and new boards create new series every day. The memory figure is an estimate (assuming ~3 KB per series); but the **number** of series is counted, and going from 2,400 to 2.5 million — a thousandfold — is a death sentence under any estimate.

So the rule: **only small, bounded-value things in metric labels** — the route template (`/boards/:id`, not the actual path), status, method, instance, region, plan, replica. Anything with unbounded values, or different per user/request — user id, board id, trace id, email, the actual URL — goes **in logs and traces**, never in metrics.

Then where is the answer to "which user is slow"? In logs and traces — there each event is a separate record, and a field with a hundred thousand different values is no problem, because the cost is in the number of events, not the variety of values. A metric's job is to say "something is bad, and in which coarse slice"; finding the details is the job of traces and logs. (Prometheus and OpenMetrics have a bridge — the **exemplar**: attaching an example trace id to a histogram bucket, so you can jump from a spike on a graph straight into a trace. Not measured here.)

**Log volume.** Part B — how much a day comes to depending on where each request's events are kept:

```
what we keep                                    per request        per day
log, one JSON line per request                         350 B      2.8 GB
log, debug on (25 lines)                              8.5 KB     70.4 GB
trace, every request (20 spans)                       7.8 KB     64.4 GB
trace, 1% sample                                        80 B      659 MB
```

Thursday's debug logs — from 2.8 GB to 70 GB a day. Log cost grows directly with the number of events, so the log policy has three parts: **one full line per request beats ten empty ones** (one line at the end with route, status, time, user, board and trace id all in it); debug logging only where it is needed (one instance, one user, a few minutes — say behind a flag), not everywhere; and logs of successful, ordinary requests can be sampled — always keep errors and slow ones.

**Structured Logging** — writing a log line not as a sentence for humans to read but as a record of fields and values (usually one JSON per line), so it can be searched, filtered and counted by any field; always with a **correlation id** (the trace id) that joins all the lines of one request across services.

```
before: loading board 4821
        query done in 3912ms

after:  {"ts":"2026-10-01T09:12:44.118Z","level":"warn","service":"work","trace_id":"4bf92f35…",
         "span_id":"00f067aa…","msg":"slow query","replica":"r3","board":4821,"ms":3912}
```

In the first, finding "all of r3's slow queries" means writing a regex and praying; in the second, `replica = "r3" AND ms > 1000`. And with `trace_id`, the same request's gateway, bff and billing lines come together — no need to match timestamps at all. One caution that will come back in 10.5: it is easy to put everything into structured logs, so passwords, tokens, entire request bodies and personal data end up in them. Keep an allowlist of log fields.

### 1.5 Distributed Tracing — seeing one request across four services

To put a trace id in the logs, there first has to be a trace id — and it has to be the **same** in every service. That is the whole trick of tracing.

**Trace / Span** — one request's whole journey is a **trace**, with a unique trace id; each piece of work along the journey (an HTTP call, a database query, a cache lookup) is a **span** — with its own id, start, end, some attributes, and the id of its **parent** span; the parent-child relationships form the tree, which shows which work happened inside which.

The trace id travels from one service to the next in a header — **context propagation**. Today's standard is W3C Trace Context, with the header name `traceparent`:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  └──────────── trace id ──────────┘ └─ parent span ─┘ └ flags (01 = sampled)
             version
```

What each service does:

```
request arrives ──► read traceparent ──► open its own span (same trace id, parent = the header's span)
                                         │
                                         ├─ its own work (DB, cache) → each a child span
                                         ├─ write logs → with trace_id, span_id
                                         └─ call another service → traceparent in the header (its own span as parent)
                ◄── close the span, send it to the collector
```

A question comes up in Node: inside an Express handler, five `await`s later, when a deep function writes a log or calls `fetch`, how does it know the current trace id? Passing it as a parameter to every function is impossible. The answer is **`AsyncLocalStorage`** (`node:async_hooks`) — a Node built-in that binds a value to an async task's entire chain, across `await`s and callbacks. In the exercise's `src/tracing.ts` the whole tracing library is ~140 lines: `storage.run(span, handler)` when the request arrives, and `storage.getStore()` anywhere gives you the current span. In production this job is done by **OpenTelemetry** — a vendor-neutral standard and SDK that instruments libraries like Express, `http`, `pg` and `ioredis` by itself (auto-instrumentation), and ships spans to any backend. A hand-written library is for learning; OpenTelemetry is for production.

`npm run trace` — four **real** HTTP services on localhost: gateway → bff → (work and billing in parallel); work does a cache lookup and a replica query (faked with `setTimeout`), and replica `r3` stalls for 1.2 seconds on some requests. 30 requests, the trace of the slowest:

```
gateway · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
  gateway · HTTP GET → bff                  1,203 ms   |████████████████████████████████████████|
    bff · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
      bff · HTTP GET → work                 1,203 ms   |████████████████████████████████████████|
        work · GET /api/boards/:id          1,202 ms   |████████████████████████████████████████|
          work · cache.get board                1 ms   |█                                       |
          work · db.query tasks r3          1,200 ms   |████████████████████████████████████████|
      bff · HTTP GET → billing                 16 ms   |█                                       |
        billing · GET /plan/:id                15 ms   |█                                       |
```

At a glance: almost all of the 1.2 seconds is in one span — `db.query tasks`, with the attribute `r3`. Billing ran in parallel and finished in 16 ms; it is not the culprit. The answer to Wednesday afternoon's two-day question, in one picture.

And searching the logs by the same trace id (part B) brings four services' lines together — exactly this request's 4 lines out of 92:

```
{"ms":1533,"level":"warn","service":"work","trace_id":"0af27ba0…","span_id":"d1a17a…","msg":"slow query","replica":"r3","board":118}
{"ms":1533,"level":"info","service":"work","trace_id":"0af27ba0…","span_id":"1a9cae…","msg":"board loaded","board":118,"tasks":46}
{"ms":1533,"level":"info","service":"bff","trace_id":"0af27ba0…","span_id":"8935ce…","msg":"page composed","board":118}
{"ms":1534,"level":"info","service":"gateway","trace_id":"0af27ba0…","span_id":"01ae15…","msg":"request done","path":"/boards/118","status":200}
```

And splitting every trace's `db.query` spans by replica (part C) — r1 and r2 max out at 8 ms, r3 at 1,200 ms. 1.3's split by dimension, this time from traces — and here you can split by any attribute, not just replica, because traces carry no cardinality cost.

**The spaced repetition answer:** the cells of the waterfall are measured with **the same machine's clock** (a span's start and end — a monotonic clock, 6.4). The positions of spans from different machines (say how far right to place bff's span inside gateway's) can shift by a few ms with clock skew — but **who is inside whom** does not come from clocks, it comes from the parent span id. A trace's structure is causality, just like Lamport's "happens-before": the gateway's span is the parent of bff's span, so the gateway's work started first — whatever any clock says.

**When one hop goes wrong.** Part D — the same 30 requests, but bff forgets to send `traceparent` when calling downstream services (a new HTTP client nobody instrumented — very common in practice):

```
                              spans  traces
header sent                       270      30
bff sends no header               270      90

   the gateway trace of the slowest request
gateway · GET /boards/:id                   1,203 ms   |████████████████████████████████████████|
  gateway · HTTP GET → bff                  1,203 ms   |████████████████████████████████████████|
    bff · GET /boards/:id                   1,202 ms   |████████████████████████████████████████|
      bff · HTTP GET → work                 1,202 ms   |████████████████████████████████████████|
      bff · HTTP GET → billing                 16 ms   |█                                       |

   the slow query is in a different trace
work · GET /api/boards/:id                  1,202 ms   |████████████████████████████████████████|
  work · cache.get board                        1 ms   |█                                       |
  work · db.query tasks r3                  1,200 ms   |████████████████████████████████████████|
```

The same number of spans (270), but 90 traces — every request in three pieces. The user's trace shows bff waited 1.2 seconds for work, but not what happened inside work. And the slow query sits in an orphan trace that starts in work — no way to know which user or which page. A tracing chain is only as strong as its weakest hop, and every new HTTP client, every queue, every new service is a potentially broken hop.

**The async path.** The same problem in queues: 7.3's BullMQ jobs, 7.5's outbox events — these are not HTTP, so there are no headers. To keep the trace going, `traceparent` has to go in the job's data or the event's payload, and the worker reads it and opens its own span. (A job may run much later — minutes or hours — so often it is joined not as parent-child but with a **link**: "this span happened because of that span, but not inside it". OpenTelemetry has span links.)

### 1.6 Sampling — which traces to keep

How much if you keep every trace? `npm run sampling` — 25.9 million traces in a day (300 req/s), 20 spans each; among them 13,088 errors, 130,236 slower than a second, and a rare bug (for one workspace) 45 times a day:

```
policy                          traces kept   complete      errors      slow   rare bug    stored/day   arriving at collector
keep everything               25,920,000    100.000%    13,088   130,236     45/45     193 GB           193 GB
head 10%                       2,593,300    100.000%     1,322    12,876      2/45    19.3 GB          19.3 GB
head 1%                          259,702    100.000%       129     1,319      0/45     1.9 GB           1.9 GB
head 0.1%                         26,119    100.000%        18       128      0/45     199 MB           199 MB
tail: errors + slow + 1%         401,513    100.000%    13,088   130,236     45/45     3.0 GB           193 GB
tail: errors + slow + 0.1%       169,232    100.000%    13,088   130,236     45/45     1.3 GB           193 GB
each service samples 10% itself 10,620,422      0.002%         0         2      0/45     1.9 MB          19.3 GB
```

**Head sampling:** a random decision at the **start** of the request — at the gateway — "keep this trace or not", which travels to every later service in `traceparent`'s flag (`01`/`00`). Cheap and simple: nobody even sends the spans of traces not being kept. But the decision is made **blind** — at the start of a request nobody knows whether it will error or be slow. So head 1% keeps exactly 1% of errors (129) — and **not one** of the rare bug's 45. From part B, the chance of having at least one trace of a bug that happens 40 times a day:

```
head rate          in 1 day     in 1 week
10%              98.5%      100.0%
1%               33.1%       94.0%
0.1%              3.9%       24.4%
```

**Tail Sampling** — making the decision to keep a trace **after the request finishes**, looking at the whole trace: keep it if it errored, keep it if it was slow, keep it if it is special (a particular customer, a new version), plus a small fraction of the remaining ordinary traces; the cost — every span of every trace has to be held in a collector until the decision.

The result is the table's fifth row: **every error, every slow request, every instance of the rare bug — in 3.0 GB, a 64th of keeping everything.** This is really what you want: the interesting traces, plus a few ordinary ones for comparison.

The cost is in the last column: **193 GB arrives at the collector** — the same as keeping everything. Tail sampling saves storage, not network or collector costs; every span has to reach the collector, and stay in memory for a few seconds before the decision (here ~25 MB at any moment). And all the spans of one trace have to reach the same collector instance — so it can see the whole trace and decide — which means splitting by trace id in front of the collectors (10.1's consistent hashing, again).

**And the last row — the most common mistake.** Each service samples 10% on its own, ignoring the flag. A trace survives whole only if all five services happen to say "keep": 0.1⁵ = 0.001%. Fragments of 10 million traces are kept, almost no complete traces, and zero complete error traces. The sampling decision is made **once** and everyone obeys it — via the flag with head sampling, at the collector with tail sampling.

### 1.7 Alerts — when to wake someone up

Another part of Wednesday: TaskFlow's only alert fired every day at 2 p.m., so everyone had muted it. An alert that always fires never fires. The question is how to build an alert that fires on **real** problems, quickly, and not for nothing.

Recall from 1.5: an SLO of 99.9% means 0.1% of requests may fail over 30 days — the **error budget**. At 300 req/s that is 777,600 failed requests in 30 days. The real question for an alert is then not "what is the error rate?" but **"at this rate, how fast will the budget run out?"**

**Burn Rate** — how fast the error budget is being spent, relative to the rate the SLO allows: a burn rate of 1 means the budget runs out in exactly 30 days, 14.4 means the 30-day budget runs out in ~2 days (and an hour eats 2% of it); `burn rate = observed error ratio ÷ (1 − SLO)`. Alerts are built on burn-rate thresholds, not error-rate ones.

`npm run alerts` — 7 days, a normal 0.02% error rate, 3% errors for two minutes during the deploy every day at 2 p.m., and an incident at 9 a.m. on day 4. Four alert policies:

- **error > 1%, 5 min** — TaskFlow's current alert
- **error > 0.1%, 5 min** — "let's alert right at the SLO threshold"
- **burn > 14.4, 1 h** — if an hour eats 2% of the budget
- **multi-window** — page if (burn > 14.4 in **both** 1 hour **and** 5 minutes) or (burn > 6 in both 6 hours and 30 minutes); a ticket (not waking anyone at night, looked at during working hours) if burn > 1 in both 3 days and 6 hours

```
incident                              budget eaten   error > 1%, 5 min   error > 0.1%, 5 min    burn > 14.4, 1 h        multi-window
big outage: 30 minutes, 20%                 13.9%        1 min (0.5%)        1 min (0.5%)        5 min (2.3%)        5 min (2.3%)
medium: 2 hours, 1.5%                        4.1%        4 min (0.1%)        1 min (0.0%)       58 min (2.0%)       58 min (2.0%)
slow decay: 3 days, 0.4%                    38.4%             missed        2 min (0.0%)              missed ticket 14.4 h (7.7%)
short blip: 3 minutes, 30%                   2.1%        1 min (0.7%)        1 min (0.7%)        3 min (2.1%)        3 min (2.1%)

── total pages in 7 days ──
nothing (just the deploy blips)                                    7                   7                   0                   0
```

(In brackets: what % of the month's budget the incident had eaten at the moment it was caught.)

- **TaskFlow's current alert (1%):** catches big incidents fast — but **never catches slow decay.** 0.4% errors for three days — under the threshold, so silent — and in those three days **38.4%** of the month's budget is gone. And even with nothing happening, 7 pages a week — every deploy. This alert is both blind and chatty.
- **Alerting at the SLO threshold (0.1%):** catches everything, fast — and wakes people for nothing 7 times a week. A two-minute blip eats a negligible part of the budget, but its momentary error rate is thirty times the threshold.
- **One-hour burn rate:** zero pointless pages — a two-minute blip disappears into an hour's average. But slow decay (burn 4) never touches 14.4.
- **Multi-window:** zero pointless pages, big incidents in 5 minutes, and slow decay caught at 14.4 hours as a **ticket** — at 7.7% of the budget, not 38.4%. The reasoning for two windows: the long window (1 hour) says "enough budget has gone that someone should wake up"; the short window (5 minutes) says "and it is **still** happening" — so when the incident stops, the alert turns itself off quickly.

And the cost, honestly: **the burn rate alert takes 58 minutes to catch the medium incident (1.5% errors, two hours)** — the 1% alert takes 4 minutes. For an hour, one in every 67 requests failed, and nobody woke up. This is a conscious design decision: in exchange there are no seven false pages a week, and people trust the alerts. Which way to lean is again a matter of error-budget arithmetic — spending 4.1% in two hours is tolerable within a month's budget; being woken seven times a day is not tolerable for people.

These thresholds and windows (14.4 — 1 h/5 min, 6 — 6 h/30 min, 1 — 3 days/6 h) are the recommendation in the "Alerting on SLOs" chapter of Google's SRE Workbook (not verified here). The exercise's experiment 4: with an SLO of 99.99%, multi-window raises a ticket with no incident at all — the normal 0.02% errors plus the daily deploys burn faster than that budget allows. The SLO itself is dishonest; the alert is only pointing it out.

**What to alert on.** A burn rate alert stands on one thing: what the user experiences (did opening the board succeed, how fast) — called the SLI, service level indicator. CPU at 90%, disk at 80%, replica lag — these are **causes**, not the user's **symptoms**. Paging on causes brings many nights when CPU is at 90% but no user notices anything; and nights too when every cause is green but users are suffering (Wednesday). The rule: **page on symptoms, causes on the dashboard** — once the page arrives, a person will look for the cause. (Two well-known layouts for dashboards: **RED** for each service — Rate, Errors, Duration; **USE** for each resource (CPU, disk, pool) — Utilization, Saturation, Errors.)

### 1.8 TaskFlow's decision

> **Trade-off Table — three signals, what goes where**

| Question                                          | Where                               | Why not elsewhere                                                                       |
| ------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| "Is something bad? Since when?"                   | Metric (histogram), burn rate alert | From logs/traces you have to count every time — slow, costly, incomplete under sampling |
| "In which coarse slice? (route, region, replica)" | Metric labels — bounded values only | —                                                                                       |
| "Where did this request's time go?"               | Trace                               | Metrics have no individual requests; logs have no structure of time                     |
| "Which user / board / workspace?"                 | Trace attributes, log fields        | In a metric, cardinality (2,400 → 2.5 million series)                                   |
| "What exactly happened, with what values?"        | Structured log, with the trace id   | Metrics have no detail; traces usually hold only time and a few attributes              |

**Instrumentation:** the OpenTelemetry SDK in every service (gateway, BFF, monolith, billing, files, worker), auto-instrumentation for `http`, `express`, `pg`, `ioredis` and BullMQ. W3C `traceparent` on every HTTP call; `traceparent` in the payload of outbox events and BullMQ jobs (the worker joins them with a span link). A test in CI: run a request and check that the four services' spans are in one trace — so that 1.5's broken hop is caught before the merge (just like 10.3's matrix).

**Logs:** structured JSON in every service, one event per line; every line carries `trace_id`, `span_id`, `service` and `version`. One "wide" line at the end of each request (route, status, time, user, workspace, board, replica, cache hit). Debug logs only through a flag, for a specific user or workspace, switching themselves off after 30 minutes. A field allowlist (never passwords, tokens or bodies). Retention: 14 days hot, then cheap storage.

**Metrics:** a latency histogram on every endpoint — labels only `route` (the template), `method`, `status_class` (2xx/4xx/5xx), `instance`, `region`; buckets dense around the SLO threshold. Never `user_id`, `board_id`, `workspace_id` or the actual path as labels — a lint in CI that looks at the number of values of new labels. A per-metric series limit in Prometheus, and a dashboard of total series (cardinality is itself a metric). Separate metrics for dependencies — `db_query_seconds{replica}`, `cache_requests{node, result}`, `flags_config_age_seconds` (10.3) — so that on a night like Saturday the graph itself points at `flags`.

**Traces:** tail sampling — every error, everything > 1 s, everything in the first hour of a new version (10.6), and 1% of the rest. Split by trace id in front of the collectors. Exemplars on histograms, so a spike on a graph is one click away from a trace.

**Alerts:** SLIs (success and latency) for three journeys — opening a board, creating a task, login — each with a multi-window burn rate: page and ticket. The old "error > 1%" alert is deleted. Every page carries a runbook link, and the runbook's first line: "Which dependency? → this dashboard". Brownout levels (10.3) and config age — tickets, not pages.

---

## 2. Interview Angle

Observability is almost never a separate question — it comes at the end of a design, as "how would you monitor this?" or "if this is slow in production, how would you find out why?". A weak answer here is "I'd set up Prometheus and Grafana, logs in ELK" — tool names, not thinking. The shape of a good answer:

1. **Start with SLIs and SLOs** — "What matters to the user in this system? Feed-load success and p99 latency. SLO: 99.9% success, 99% under 500 ms." Then say alerts will be on this SLO's burn rate.
2. **The three signals, with their jobs** — metrics (what is bad), traces (where), logs (why); and the trace id that joins all three.
3. **The design's special places** — if there is a queue, its age (how long the oldest message has been waiting); if a cache, the hit rate; if replicas, lag; trace context on the async path.
4. **The costs** — sampling, cardinality, log volume. One sentence is enough: "user id goes in the trace, not the metric."

**Follow-ups that are almost certain:**

- _"Why p99, why not the average?"_ — users live in the tail, because each user makes many requests: 2.5% slow means ~40% of users hit at least one slow one in 20 pages. And a bonus: percentiles cannot be averaged, but histogram buckets can be added.
- _"How would you debug one slow request across microservices?"_ — distributed tracing: trace id, spans, context propagation (W3C traceparent), where the time went in the waterfall. And carrying context across async hops.
- _"Would you keep every trace?"_ — no; head sampling is cheap but blind, tail sampling keeps errors and slow ones at the cost of the collector. The decision is made once and everyone obeys it.
- _"What do you alert on?"_ — symptoms (the SLI's burn rate), not causes (CPU); multi-window, page versus ticket; and name alert fatigue.

**In real production:** the most common mistakes — only averages on the dashboard; averaging percentiles to show "the hour's p99"; a new label (user id, actual URL, the full text of an error message) that silently swells the metric system and then kills it; no request id in logs, or one that does not get passed to the next service; every service sampling on its own, so no trace is ever complete; traces breaking when they cross a queue; alerts on everything, so effectively on nothing; and turning on debug logging and forgetting to turn it off.

---

## 3. Key Takeaway

- **Monitoring answers known questions, observability unknown ones** — metrics say something is bad, traces say where, logs say why; and one trace id joins all three
- **The average hides the tail** — average 172 ms (green), p99 3.79 s; 2.5% slow means ~40% of users who open 20 boards a day wait 4 seconds at least once
- **Percentiles cannot be added or averaged** — the average of per-minute p99s is 617 ms, the median 187 ms, the truth 3.79 s; histogram buckets can be added — and keep buckets dense where decisions are made (the defaults put p90 off by +55%)
- **A metric's cost is the product of its label values** — from 2,400 series to 2.5 million with the actual path or user id; bounded values in metrics, unbounded values (user, board, trace id) in logs and traces
- **A distributed trace = one trace id + `traceparent` on every hop + AsyncLocalStorage** — the slow request's 1.2 seconds is visible in one span; if one hop does not send the header, 30 requests become 90 traces and the slow query is orphaned
- **Head sampling is cheap but blind** (at 1%, none of the rare bug's 45), **tail sampling keeps every error and slow request** (in 3 GB, but 193 GB arrives at the collector); and if each service samples on its own, complete traces are 0.002%
- **Alert on burn rate, on symptoms, with multiple windows** — "error > 1%" misses slow decay (38% of the budget) and wakes people for nothing 7 times a week; multi-window has zero pointless pages, at the cost of a 58-minute delay on a medium incident

---

## 4. New Terms (Glossary)

| Term                   | Meaning                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Observability**      | Being able to answer unanticipated questions about a system's internal state from its outside signals (logs, metrics, traces), without deploying new code; monitoring answers known questions                                       |
| **Histogram** (metric) | Counting how many values fell into which bucket instead of storing each value — buckets can be added (across instances and time), percentiles estimated from the sum; accuracy depends on bucket boundaries                         |
| **Label Cardinality**  | The number of combinations of a metric's label values = its number of time series; up to the product of each label's value count; labels with unbounded values (user id, path) kill the metric system                               |
| **Structured Logging** | Writing logs not as sentences but as field-value records (one JSON per line), with a correlation id (trace id) — so they can be searched, filtered, counted and joined across services by field                                     |
| **Trace / Span**       | Trace = one request's whole journey (one trace id); span = one piece of its work (id, start, end, attributes, parent span id); context propagation (W3C `traceparent`) carries the id from service to service                       |
| **Tail Sampling**      | Deciding whether to keep a trace at the end of the request, looking at the whole trace (errors, slow, special — all; a fraction of the rest); head sampling decides blind at the start — cheap, but loses rare events               |
| **Burn Rate**          | How fast the error budget is being spent relative to the SLO's allowed rate (`error ratio ÷ (1 − SLO)`); 1 = runs out exactly on time, 14.4 = 2% of the month in an hour; alert on burn rate, not error rate, over multiple windows |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines in your own words for each.

1. Design a latency metric for TaskFlow's "create task" endpoint. SLO: over 30 days, 99% of task creations under 300 ms. (a) Which labels will you keep, and how many time series will that make (including the histogram) — show the arithmetic. (b) Where will you put the buckets, and why? (c) The sales team wants separate latency graphs for their 20 largest enterprise customers. Someone says "add a `workspace_id` label". Why not — and how will you meet their need?

2. A user writes: "A task was assigned to me, and the email arrived 20 minutes later." The path from assignment to email: API (task update + outbox row, 7.5) → outbox relay → Redis Streams → BullMQ worker (7.3) → email provider. (a) What has to be done to see this one event's whole path in one trace — how does context travel at each hop? (b) The trace will be 20 minutes long. Should it be parent-child or a link — why? What problem does this cause for tail sampling? (c) Which metric would catch this kind of delay **ahead of time**, and what would you alert on?

3. Two SLOs for opening a board: success 99.9%, and latency — over 30 days, 99% of boards under 500 ms. (a) What is a "bad event" for the latency SLO, and what is the monthly budget at 300 req/s? (b) When the burn-rate-14.4 page fires, what % of the budget has gone in an hour, and how many slow requests is that? (c) 10.3's brownout kicks in — "More boards like this" and the activity panel are off, but boards are arriving fast. The latency SLO is green, the success SLO is green. Is this a problem? What will you measure, and what will you not page on?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) "Create task" is a single route and method, so those are fixed. Labels: `status_class` (2xx, 4xx, 5xx — 3; not the full status code, because 20 status codes help no decision), `instance` (6), `region` (say 2), `plan` (3 — free/pro/business, because the quota path differs by plan, 9.4).

```
combinations = 3 × 6 × 2 × 3 = 108
say 11 buckets → 12 bucket series per combination (including +Inf) + _sum + _count = 14
total = 108 × 14 = 1,512 series
```

Workable. Keeping `instance` is debatable (under autoscaling new instances create new series, and the old ones linger for a while) — but it is needed to find a bad instance, and the number is small.

(b) Buckets dense around the SLO threshold (300 ms), because that is where the question "are 99% under 300?" lives: 25, 50, 100, 150, 200, 250, **300**, 400, 600, 1,000, 3,000 ms. It is essential that 300 is a bucket boundary — then the answer to "what % is under 300" is not an estimate but a direct count (`le="300"`'s count ÷ the total). For SLO accounting you do not even need a percentile estimate — just that bucket. Far buckets sparse (nothing is needed beyond 3 s — those will be counted as failures anyway).

(c) `workspace_id` has 200,000 values — 108 × 200,000 × 14 ≈ 300 million series. The metric system dies (1.4), and you pay for the other 199,980 to get 20. The ways forward:

- **A bounded list:** a `customer_tier` label with values `enterprise_top20` or `other` — then one graph of the 20 combined, at only double the series. But not the 20 separately.
- **If they are needed separately:** an allowlist — a small metric whose `workspace` label takes only those 20 names, everything else `other` — 21 values, with the list in config, not code. The cost is bounded, and stays bounded as long as nobody grows the list by mistake.
- **For detailed analysis:** `workspace_id` always in the trace attributes, and a tail sampling rule to keep every trace for these 20 ("special customer — keep all"). Then any question ("what do this customer's slow requests have in common?") comes from traces.

**Question 2:**

(a) Carrying context across each hop:

- **API → outbox:** when writing the outbox row in the task-update transaction, put the current `traceparent` in its payload.
- **Relay → Redis Streams:** the relay reads the row and sends the event — that `traceparent` in one of the event's fields (the relay opens its own span, with a link).
- **Stream consumer → BullMQ:** `traceparent` in the job's data.
- **Worker:** at the start of the job, read `traceparent` and open its own span; the HTTP call to the provider carries the usual `traceparent` header.

Get any hop wrong and it is 1.5's part D — the trace in pieces, and the worker's span orphaned.

(b) **A link, not parent-child.** Parent-child means "this work is **inside** that work" — the child starts before the parent span ends. But the API's request ended in 50 ms, and the user already has the answer; the email work happens 20 minutes later. Making it parent-child shows a 20-minute "request", which is false — the waterfall becomes meaningless. A link says "this work happened because of that work" — two separate traces, joined. **The tail sampling problem:** the collector waits a few seconds before deciding (10 s here). It cannot wait for a span that comes 20 minutes later — the decision on the API's trace was made long ago. So each part is sampled as a separate trace; the worker's trace is not "slow" (it is fast itself), so it may be dropped. The remedy: an attribute on the worker's span for "how long it sat in the queue" (`queue.wait_ms`), and a tail sampling rule "keep if the queue wait > 5 minutes".

(c) This delay is not a request's latency — it is **the queue's age**. Metrics:

- For each queue/stream, **the age of the oldest waiting message** (a gauge) — the most important one; not the queue's length, because 1,000 messages finishing in a second is no problem, while 10 messages sitting for 20 minutes is.
- The age of the oldest unsent outbox row (if the relay gets stuck).
- A histogram of the time from assignment to reaching the email provider (put the assignment time in the event, measure at the end in the worker).

Alert: an SLO — "99% of assignment emails reach the provider within 2 minutes" — with page/ticket on its burn rate. The queue-age graph goes on the dashboard, as a cause.

**Question 3:**

(a) "Bad event" = a board open that took more than 500 ms (failures also count as bad, or sit in a separate SLO — pick one and write the rule down). Budget: 1% —

```
300 req/s × 86,400 s × 30 = 777.6 million board opens
1% = 7,776,000 slow board opens — per month
```

(Here 500 ms has to be a histogram bucket boundary — question 1(b).)

(b) A burn rate of 14.4 for an hour = 14.4 ÷ 720 = **2%** of the month's budget in an hour. In numbers: 7,776,000 × 0.02 ≈ **155,520** slow requests, i.e. ~14.4% of that hour's 1.08 million requests took more than 500 ms. (Directly from the definition of burn rate: 14.4 × 1% = 14.4% bad.)

(c) A problem — both SLOs are green, yet users are getting less. A brownout is designed to do exactly this (10.3): protect latency, drop parts. So **this is not a paging event** — the system is doing exactly what it is meant to, and nobody waking up has anything to do. But **it must not stay invisible either**:

- Metrics: `brownout_level` (a gauge) and "% of board opens that got the full page" — a third SLI, say "95% of board opens get the full page". A **ticket** on that (looked at during working hours): a brownout running for hours on end means capacity is short — a decision to add capacity is needed.
- Why not a page: the brownout comes down by itself; there is no point waking someone at 3 a.m. to say "the panel is off" unless they can change something.
- One more subtlety: during a brownout the latency SLO looks green **because** less work is being done. This number does not tell you what would have happened without the brownout — so treating brownout time as "normal" in capacity planning is a mistake.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (four scripts are deterministic simulations; the fifth is four real HTTP services on localhost; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-10.4-observability/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.4-observability) — `npm install`, then `npm run percentiles`, `npm run cardinality`, `npm run sampling`, `npm run alerts`, `npm run trace`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`percentiles` measures, over an hour of board opens, the average, percentiles, per-minute rollups, histogram buckets and splitting by dimension. `cardinality` counts time series by label set over a day's traffic, plus the volume of logs and traces. `sampling` compares head, tail and uncoordinated sampling over a day of traces. `alerts` runs four alert policies over seven days of errors — which catches which incident when, and how many times each wakes people for nothing. `trace` runs four real `node:http` services on localhost with a small hand-written tracing library (`traceparent`, `AsyncLocalStorage`, JSON logs) — the waterfall, finding logs by trace id, and what happens when one hop does not send the header.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` and ESLint clean; the first four scripts twice each, output identical (compared byte for byte); `trace` three times — the structure of the traces and the numbers of spans and traces the same every time; the ms values differ by a few ms (real time is measured), and because two requests are almost equally slow, which one is shown as "the slowest" — and therefore the trace id shown — can change from run to run. **The first four scripts have no network, Prometheus, log store or real time** — latencies are seeded random values, and every number is counted and computed. `trace`'s services are real HTTP, but the cache, replica and billing work is faked with `setTimeout`; the tracing library is hand-written, not OpenTelemetry. Assumed numbers: ~3 KB of memory per series, ~350-byte log lines, ~400-byte spans, 20 spans per trace — these are estimates; the **number** of series is counted. **Not measured:** real Prometheus memory, a real OpenTelemetry collector and tail sampling processor, exemplars, span links, traces crossing queues, the cost of a real log store. 1.7's burn rate thresholds and windows come from Google's SRE Workbook; 1.3's default buckets from the Prometheus client library; RED and USE are well-known layouts — these come from their documentation and published writing, not verified here. TaskFlow's decision in 1.8 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `percentiles`, write down — three 90-second stalls an hour, on one of three replicas, ~3.5 seconds extra: what will the average be, what % of requests will take more than a second, and where will the p99 be? Then run it and compare. Now `STALL_SECONDS=20` — why is the average of the per-minute p99s larger than the truth this time?

2. **Your own metric's arithmetic:** add question 1's metric to `cardinality.ts` as a new variant (the create-task route, `status_class`, `instance`, `plan`). Do your hand arithmetic and the counted series agree? If not, why (which combinations never occurred in a day)?

3. **A new hop in the trace:** in `trace.ts`, have the work service call a fifth service ("flags") with `call`. Then deliberately call it with `propagate = false`. How many traces did you get, as in part D? What was lost from the waterfall? Now make flags 500 ms slow — if this waterfall had existed on 10.3's Saturday night, how fast would on-call have found `flags`?

4. **Alert thresholds:** `SLO=0.9999 npm run alerts`, then `DEPLOY_BLIP=0.2 npm run alerts`. In the first, what fired with no incident, and why is that the SLO's problem, not the alert's? In the second, what did multi-window do when the deploy blip got bigger — and is that the right behaviour?

5. **The design part:** a one-page observability plan for TaskFlow's mobile app. (a) What is the mobile SLI — server latency, or the time until the board appears on the user's phone? Where does the difference between the two come from? (b) Will you start the trace on the phone? Where is the sampling decision made, and what happens to spans when there is no network? (c) What will you keep out of the phone's logs and crash reports (looking ahead to 10.5)? (d) Old app versions run for years — how will you keep a new label (`app_version`)'s cardinality bounded? (e) What one thing will you page on, and what only gets a ticket?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1, 10.2, 10.3
Current: 10.4 — Observability: logging, metrics, tracing
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limits
in two layers; cache ring; Bloom filter on share links, active users in HLL; hard/soft dependencies per
journey + fault injection in CI; flags snapshot; brownout on the board; chaos program. Wednesday: replica
r3's disk stalls now and then → 2.5% of boards at 4 s, average 170 ms (green), nobody saw it; no id in
logs; user_id and path labels on a metric gave Prometheus an OOM (no metrics/alerts all night); debug logs
25x the volume; found by chance after two days. Now: OpenTelemetry in every service (auto-instrumentation
http/express/pg/ioredis/BullMQ), W3C traceparent on all HTTP, in outbox event and job payloads (span
links); a "four services in one trace" test in CI; structured JSON logs, trace_id/span_id/service/version
on every line, one wide line per request, field allowlist, debug only through a flag for one
user/workspace for 30 minutes; latency histograms, labels only route template/method/status_class/
instance/region, buckets dense around the SLO, unbounded-value labels banned (CI lint, per-metric series
limit, cardinality dashboard); dependency metrics (db_query_seconds{replica}, cache, flags_config_age);
tail sampling (every error, > 1 s, the first hour of a new version, 1% of the rest), split by trace id in
front of the collectors, exemplars; alerts: multi-window burn rate on the board/task/login SLIs (page +
ticket), the old "error > 1%" deleted, a runbook with every page; brownout and config age as tickets
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate
Weak spots: [where you got stuck — write it yourself]
Next: 10.5 — Security at scale: authN vs authZ, OAuth/JWT, secret management, DDoS
=======================
```

---

## 8. Next Step

Today's thread: **having data and having answers are not the same thing.** The average hides the tail, averaged percentiles lie, and one label in the wrong place kills the whole metric system. Metrics say something is bad, traces say where, logs say why — and one id binds the three, an id that does not travel across each hop by itself, but has to be sent. And the alerting question is not "what % errors" but "how fast is the budget burning" — because an alert that fires every day never really fires.

Today I sidestepped a few points several times: that passwords or tokens must not go into logs; that the gateway verifies the JWT and sets an internal token (9.2); that traces carry `user_id` — so who can see traces? These are all pieces of one big question. When you are ready, write `next` — we go to **Lesson 10.5: Security at Scale — authN vs authZ, OAuth/JWT, Secret Management, DDoS**. The question there: when a request crosses six services, who answers "who is this user?" and "are they allowed to do this?", and where — and what TaskFlow does in the face of a leaked token, a secret forgotten in a commit, or a hundred thousand requests a second.
