# Lesson 7.2 — Message Queue vs Pub/Sub: RabbitMQ, Kafka, Redis Streams

**Module 7 — Asynchronous Processing & Messaging**

> **Spaced Repetition (Lesson 5.8):** TaskFlow's `tasks` table is sharded by `projectId`. One huge enterprise customer has 40% of all tasks in a single project. What problem will this cause, and what is it called? Today you'll see exactly this problem again — not in the database, but in a line of messages.

**Prerequisite:** Lesson 5.8 (Partition, shard key, hot partition), Lesson 6.1 (A timeout means "I don't know"), Lesson 6.3 (Session guarantees), Lesson 7.1 (Job queue, backlog, the weakness of an in-memory queue)

**By the end of this lesson you will be able to:**

1. Recognise any messaging system with three questions — **who gets a message**, **whether it stays after it's read**, and **in what order it arrives** — and give the separate answers for a queue, pub/sub and a log
2. Explain with numbers how acks and offsets are a choice between "lost" and "twice" — and why in practice almost every system gives "at least once"
3. Choose one of RabbitMQ, Kafka, Redis Pub/Sub and Redis Streams for each of TaskFlow's messages — with a partition key and retention — and say why the others are **not** the choice

**Tier:** 1 — Runnable Code (a deterministic simulation of the rules of three kinds of broker, in five situations)

---

## 0. Where TaskFlow Is Right Now

In Lesson 7.1 TaskFlow's assign email moved off the request's path — into an in-memory queue and 8 workers. And there we saw the price: 103 emails lost on a deploy. The queue has to move out of the process, somewhere durable.

But meanwhile the demands have grown. When a comment is created, the news is now supposed to go to four places:

- **notification** — email and push for the people mentioned
- **search** — putting the comment into the search index (details in Lesson 8.3)
- **analytics** — the "how much discussion is happening in which project" dashboard
- **Slack integration** — a line in the task's channel

Three proposals came up in the team meeting, from three people:

- Backend lead: _"We already have Redis. Redis Pub/Sub — `PUBLISH comment.created`, whoever needs it subscribes. No new infrastructure needed."_
- Data engineer: _"Kafka. All the big companies use Kafka, and we'll need it for analytics later anyway."_
- Someone else: _"RabbitMQ. Queue means RabbitMQ; we had it at my last job."_

Redis Pub/Sub was the simplest, so a prototype was built with it for one week. At the end of the week, three pieces of news:

1. **Tuesday:** a deploy of the search service, down for 10 seconds. The comments written in those 10 seconds never showed up in search. Nobody saw an error either.
2. **Thursday:** after one slow analytics query, in Redis's log: `Client … scheduled to be closed ASAP for overcoming of output buffer limits` — Redis itself cut analytics off. A gap of a few minutes in the dashboard.
3. **And next month's plan:** the search team will change the index format — building the new index needs **every comment written so far**, again.

The CTO wanted a one-page comparison: "which one, and why." That page can't be written by memorising the names of three tools — because the three people answered three **different questions**. Today, those three questions, and each one's answer in numbers from the exercise.

---

## 1. Theory

### 1.1 Message Broker — why you need someone in the middle

Lesson 7.1's queue was in the API process's own memory — the producer and the queue in the same place, so the queue died with the process. The fix: put the queue in a separate process that does only this job.

**Message broker** — a separate server that takes messages from producers, stores them, and delivers them to consumers; producers and consumers don't know each other, they only know the broker.

```
   producers                      broker                         consumers
   ─────────────                ──────────                      ──────────────
   API instance 1 ──┐                                      ┌──► notification worker
   API instance 2 ──┼──► "comment.created" ──► [ … ] ──────┼──► search worker
   API instance 6 ──┘                                      └──► analytics worker

   • the API doesn't know who will read it, how many will, or whether they're alive right now
   • the worker doesn't know who wrote it
   • the two sides run at different speeds, at different times — and are deployed separately
```

This is the full fix for 7.1's temporal coupling: for the API to succeed, only the broker has to be alive, not the consumers. (The broker itself can die too — so real brokers replicate themselves across several nodes; RabbitMQ's quorum queues and Kafka's controller are both relatives of Lesson 6.2's Raft. That isn't today's topic — today we assume the broker survives.)

Now the three questions.

### 1.2 Question 1: who gets a message — one, or everyone?

There are two basic answers, and both are right — for different jobs.

**Competing consumers** — many consumers read from the same queue, and each message goes to **only one** of them; add consumers and the work is shared out and finishes faster.

This is 7.1's job queue: "send this email" is a **task**, and a task must be done once. 8 workers means 8 times faster, not the same email 8 times.

**Publish/Subscribe (pub/sub)** — the producer sends a message to a **topic**, and every **subscriber** of that topic gets its own copy of the message.

This is **news**: "a comment was created." News goes to everyone who wants to hear it — notification, search, analytics, Slack — all four.

The exercise's `npm run fanout` shows what happens if you pick the wrong answer. 1069 events; email, search and analytics all need every one of them:

```
   broker                                 email got   search got   analytics got
   queue — one queue, shared by all            40%          40%             20%
   queue — one queue per service              100%         100%            100%
   pub/sub                                    100%         100%            100%
   log — one group per service                100%         100%            100%
```

(The script prints its labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

Read the first row: the three services' workers on one queue (2 for email, 2 for search, 1 for analytics) — the broker shares messages among them round-robin. Each comment goes to **one** of them, so 60% of the comments are missing from the search index, and 80% from analytics. The queue is doing exactly its job — "each message once" — and here that's exactly wrong.

**In practice you need both at once.** The search service has 2 workers of its own — comments should be **shared** among them (competing), but search, analytics and notification should each get the **whole** copy (pub/sub). So the rule is:

```
                       ┌──► [ queue: search ]        ──► search worker 1, 2      (shared among themselves)
   comment.created ────┼──► [ queue: analytics ]     ──► analytics worker 1
     (written once)    └──► [ queue: notification ]  ──► notification worker 1, 2, 3

   between services: pub/sub (each gets everything)
   within a service: competing consumers (the workers share)
```

This is exactly what's built in RabbitMQ: the producer sends to a **fanout exchange**, and each service creates its own queue and joins it to the exchange (a binding). The exchange puts a copy of every message into every bound queue. (There are more kinds of exchange — direct and topic exchanges look at the routing key to pick which queue a message goes to, like `comment.*` or `task.completed`.) This is the second row of the table. On AWS, the same shape is called an SNS topic → several SQS queues.

In Kafka both levels live in a single idea — the consumer group, in 1.4. And a warning about names: the name "Pub/Sub" is confusing. Redis's Pub/Sub is genuinely simple pub/sub (it stores nothing, as you'll see in 1.3), but Google Cloud's "Pub/Sub" product is really fanout + a durable queue per subscription — like the picture above. Don't go by the name; recognise it by the answers to the three questions.

### 1.3 Question 2 (a): when a consumer is missing, or slow — what happens to the message?

Tuesday's incident question. `npm run crash` — the search service is down from 20 to 30 seconds (a deploy), the others are running:

```
   broker                          lost   processed twice   delay p99    delay max
   pub/sub                          193                0      36 ms      43 ms
   queue (ack per message)            0                0      9.6 s      9.8 s
   log (commit every 5.0 s)           0              110     10.6 s     11.0 s
   log (commit every 100 ms)          0                2      9.6 s      9.8 s
```

**The pub/sub row:** 193 comments never reached search — and its delay is just 36 ms! Both for the same reason: Redis Pub/Sub **doesn't store** messages. The subscriber connected at the moment of publish gets it; for one that isn't, the message exists nowhere — ever. The delay is low because the ones that could have arrived late never arrived at all. This isn't a defect, it's the design: Redis Pub/Sub is a tool for "tell whoever is listening right now" — **at most once (at-most-once)**.

Where is it right? Where lost news is worthless in itself: "X is typing…", someone's online/offline status, telling a cache "invalidate this key" (if it's lost, there's still the TTL — Lesson 4.3). Where is it wrong: any work that has to happen.

**The queue row:** nothing lost, nothing done twice; only the comments from the downtime were ~10 seconds late. The messages waited in the queue. But there's a question hidden here: the search worker got a message, then crashed — what happens to the message? How does the broker know the work is done?

**Acknowledgement (ack)** — the consumer tells the broker "the work for this message is done, delete it"; if the consumer's connection breaks before the ack arrives, the broker puts the message back in the queue, to give to someone else.

And here Lesson 6.1's old question comes back — when do you send the ack?

```
  ack before the work:   ack ──► write to the index ──► ✗ crash
                         the broker thinks it's done, deleted it; not written to the index  →  lost    (at-most-once)

  ack after the work:    write to the index ──► ✗ crash ──► (no ack sent)
                         the broker returns the message; a new worker writes again          →  twice   (at-least-once)
```

You have to pick one of the two situations, because "doing the work" and "telling the broker" are two separate events on two separate machines — a crash can always come in between. In practice almost everyone picks the second (twice is better than lost, if twice can be made safe). In the exercise the ack's round trip is only 5 ms, so there are 0 duplicates in this crash — but the gap is there, and in a big system someone falls into exactly that gap every day. The broker alone can't give "exactly once" delivery; an "exactly once" **result** comes from at-least-once delivery + an idempotent consumer — the whole of Lesson 7.4.

**The log row:** nothing lost — but **110** comments went into the index twice. Why so many more than the queue? Because in a log there's no ack per message; every so often the consumer reports "I've read up to here" (the offset commit, in 1.4). In Kafka's client the default is every **5 seconds** (`auto.commit.interval.ms`). After a crash the consumer starts from the last commit, so whatever was processed after the last commit — here ~5 seconds of work — happens again. Committing every 100 ms drops the duplicates to 2 (experiment 1: 18 at 1 second) — but every commit is a write on the broker, and it never gets to zero.

**Now the slow consumer** — Thursday's incident. `npm run slow` — one analytics worker takes 60–100 ms per event (≈12.5/s), and events arrive at ≈17.8/s. In Lesson 7.1's language: the consumer is slower than the arrivals, so the backlog will grow. The question is **where** the backlog lives:

```
   broker     analytics lost   stored (max)   analytics delay max   email delay p99
   pubsub                367            101                6.0 s            171 ms
   queue                   0            375               32.1 s            199 ms
   log                     0            334               27.7 s            271 ms
```

Look at the last column first: **email is untouched in all three.** The slow analytics doesn't drag anyone else down — because each service has its own copy, its own line. The exact opposite of 7.1's cascading failure; the broker keeps the slow consumer isolated.

The only difference is for the slow one itself:

- **Pub/Sub:** Redis keeps an output buffer for each subscriber; when it passes a limit, Redis **cuts off** the subscriber and throws the buffer away — to protect its own memory. (Redis's default is `client-output-buffer-limit pubsub 32mb 8mb 60`; in the exercise, for simplicity, "100 messages".) Analytics connects again, falls behind again, gets cut off again — 367 lost. Thursday's log line is exactly this.
- **Queue:** nothing is lost — but 375 messages are stored in **the broker's** memory/disk, and the last one is 32 seconds late. This number can grow without bound. A well-known warning in the RabbitMQ world: long queues are heavy for the broker (memory, disk, recovery time) — a queue is at its best when it's empty. You can set limits (a queue's max length, message TTL) — but then what to drop is your decision (7.4's backpressure).
- **Log:** nothing is lost, and the 334 are **not extra storage** — in a log every message is kept anyway (until retention), analytics is just behind. This distance is called **consumer lag**, and it's the most important metric for a team running Kafka. To the broker a slow consumer and a fast consumer cost the same.

(Why the queue stores a little more than the log — 375 vs 334 — is in the exercise's README: with prefetch 1, the ack's round-trip time is added to every message. In real RabbitMQ prefetch is kept larger for this reason.)

### 1.4 Question 2 (b): does a message stay after it's read, or is it deleted?

Now next month's plan: building the new search index needs **all the old comments**. In the queue, acked messages have been deleted — the broker has no such thing as history. This is where the third model stands apart.

**Append-only log and offset** — the broker keeps adding messages to the end like a ledger and **doesn't delete them after they're read** (up to a set time or size — **retention**). Every message has a sequence number — the **offset**. How far someone has read is written not on the broker's messages but in the reader's own offset.

```
   partition 0:   [0] [1] [2] [3] [4] [5] [6] [7] [8] [9] …   ← new messages are added at the end
                                   ▲                   ▲
                    analytics offset = 3     search offset = 9
                    (behind — lag 7)         (nearly at the end)

   • reading deletes nothing — even after search reads, [3]…[9] stay for analytics
   • a newcomer can start from offset 0 — the whole history
   • after a bug fix you can go back to an old offset and read again (replay)
```

The core difference from a queue in one sentence: **in a queue the record of "who read what" is on the message (deleted when acked); in a log the record is on the reader (a number).** Everything else follows from this one difference.

And 1.2's "shared within a service, everyone between services" — in a log it's called:

**Consumer group** — a team of several consumers for the same job, with one set of offsets; within the group the messages are shared out (each partition to one member), and separate groups read the whole log independently of each other.

Search is a group, analytics is a group — each reads everything at its own speed. Adding a new service means a new group; neither the producer nor the broker's configuration has to change.

`npm run replay` — a new `search-v2` service joins at 60 seconds, and wants all the earlier events too:

```
   broker                   earlier events got   later events got
   pub/sub                        0 / 1069            551 / 551
   queue                          0 / 1069            551 / 551
   log (retention 7 days)      1069 / 1069            551 / 551
   log (retention 30 s)         566 / 1069            551 / 551
```

For the queue and pub/sub there's no such thing as history — messages from before the new queue was created never went there. The log gives the whole history — **up to the retention limit**. Kafka's default retention is 7 days (`log.retention.hours=168`, changeable per topic); with 30 seconds of retention, only the 566 from the last 30 seconds. (There's another kind — **log compaction**: instead of deleting by time, it keeps only the latest value for each key; for data like "the current state of each task".)

**An honest warning:** "everything is in the log, so we don't need the database" — this thought is dangerous. For work like search-v2, the usually safe path is to build the full index once **from the database** (that's the source of truth), then catch new changes from the log. Making the log the source of everything (event sourcing) is a valid but big design decision — it comes up in 7.5.

### 1.5 Question 3: in what order does it arrive?

Events for the same task: `task.created` → `task.assigned` → `comment.created` → `task.completed`. If the notification service processes "completed" first and "assigned" later, the assignee gets an "you've been assigned" email for an already-finished task — and if the service keeps the task's state, it ends up stuck at "assigned", not "completed".

A queue itself is FIFO — the broker hands out messages in order. But with **competing consumers** the order doesn't hold: worker A got "assigned" (slow, 120 ms), worker B got "completed" (fast, 20 ms) — B finished first. **Handing out** in order and **finishing** in order aren't the same thing. And when a message that wasn't acked returns to the queue (1.3), it's processed after the messages that came after it.

The log's answer: **partitions** and **keys**. Just like Lesson 5.8's shards — a topic is split into several partitions, and each message's key decides which partition it goes to (usually hash of the key % number of partitions). Two rules:

1. Same key → always the same partition, and within a partition the order is strictly preserved.
2. In a group, a partition is read by **one** consumer at a time — and it reads one at a time, in order.

So with key = `taskId`, all of one task's events are in one consumer's hands, in order. Different tasks' events are in different partitions, in parallel. Kafka doesn't give an order for **the whole topic** — only per partition; and that's usually enough, because what we really want is order **per entity**.

`npm run ordering` — a notifier service, 20–120 ms per event, but 3 seconds for 1% of events (a slow moment at the provider):

```
   broker                           tasks out of order   delay p50   delay p99   delay max   consumers with work
   queue, 4 workers                             11          76 ms      3.0 s      3.1 s   4
   log, key = task, 4 partitions                 0          94 ms      4.8 s      7.0 s   4
   log, key = random, 4 partitions              69          97 ms      4.2 s      4.7 s   4
   log, key = task, 8 consumers                  0          94 ms      4.8 s      7.0 s   4 (4 sit idle)
```

Four lessons, one per row:

1. **Queue, 4 workers:** 11 out of 252 tasks got out of order. Rare — and dangerous for exactly that reason: it isn't caught in testing, it happens a few times a month in production.
2. **Log, key = task:** **0** out of order. But the delay max is 7 seconds — more than double the queue's. Why? The 3-second slow message holds up everyone behind it in its partition; preserving order means the next one waits for the one before. In the queue the other workers move ahead — so it's faster, but loses the order.

   **Head-of-line blocking** — one slow or stuck message at the front of the line holds up everything behind it, even though the ones behind could have finished quickly on their own.

   An even worse form: the message at the front fails **every time** (broken data — a "poison message"). In a log the offset can't move past it, so the whole partition stops. A queue has per-message acks — one message can be set aside on its own. In a log the fix is the consumer's own: drop the failing message into a separate topic and move on (7.4's dead letter).

3. **Log, key = random:** there are partitions, but the key is wrong — one task's events are scattered across different partitions, 69 tasks got out of order, even more than the queue. A partition doesn't give order by itself; **the right key** does.
4. **Log, 8 consumers:** 4 partitions, 8 consumers — 4 get no work at all, and the result is identical to 4 consumers. A group's parallelism is capped at the number of partitions. So the number of partitions has to be chosen with thought up front (it can be increased later, but then the key → partition calculation changes, and the ordering guarantee for events in flight can break). Experiment 3: with `PARTITIONS=8` all 8 get work, and p99 goes from 4.8 to 3.0 seconds.

And the spaced repetition question comes back right here: with key = `projectId`, every event of that enterprise customer's project goes to **one** partition — a **hot partition**, just like Lesson 5.8. That partition's consumer lag keeps growing, while the other consumers sit idle. The rule for choosing a key: the smallest unit of the entity whose order you **really** need (here the task, not the project).

"Then I want one order for the whole system" — experiment 4: `PARTITIONS=1`. 0 out of order, and a delay p99 of 52 seconds: one partition means one consumer, and it's slower than the arrivals (7.1's backlog). **You can't have total order and parallelism at the same time** — just like Module 6's consistency, every ordering guarantee has a price.

(The queue world has ways to get per-key order too: RabbitMQ's "single active consumer" keeps one consumer at a time on a queue; the consistent hash exchange splits queues by key; AWS SQS FIFO queues give order per group with a "message group ID". They're all the same idea — if you want order, put everything for one key in one line.)

### 1.6 Three (really four) tools

Now the tools' names can be read through the answers to the three questions.

**Redis Pub/Sub** — simple pub/sub. Nothing is stored, no acks, slow subscribers get cut off. At-most-once. Fast and simple — for where losing things is fine. (Redis 7 added sharded pub/sub for clusters; the rules are the same.)

**RabbitMQ** — a queue-centred broker (its main protocol is AMQP 0-9-1). The producer sends to an exchange, the exchange puts it into queues by routing rules, and the consumer takes it from the queue and acks **each message separately**. Strengths: flexible routing (direct, topic, fanout, headers exchanges), per-message acks and redelivery, priorities, message TTL, dead-letter exchanges. Acked messages are deleted — no history. For durable, replicated queues newer versions have quorum queues (Raft-based); and RabbitMQ Streams has been added for log-style work too (since 3.9) — "RabbitMQ means only queues" is no longer entirely true.

**Apache Kafka** — log-centred. Topic → partition → append-only log, kept until retention, consumer groups and offsets. Strengths: huge throughput (sequential disk writes — an idea like Lesson 5.3's LSM), many groups can read the same data independently, replay, and stream processing on top of it (7.6). Weaknesses: no per-message ack (the offset is a boundary, hence poison messages and head-of-line blocking), parallelism tied to partitions, and heavy to run (planning clusters, partitions, replication — though there are plenty of managed services). (Honest note: in Kafka 4.x, queue-like per-message consumption is arriving under the name "share groups" — KIP-932; at the time of writing it's at the early access/preview stage, so check the version before using it. And since Kafka 4.0 ZooKeeper is gone entirely; metadata is now in Kafka's own Raft — KRaft.)

**Redis Streams** (since Redis 5.0) — an interesting mixture. Like a log: append at the end with `XADD`, an ID for every entry, reading doesn't delete (trimmed with `MAXLEN`/`MINID`), multiple consumer groups, and you can read again from an old ID. But like a queue: within a group every message is acked **separately** (`XACK`), and there's a list of what hasn't been acked (the pending entries list), so a dead consumer's messages can be picked up by someone else (`XAUTOCLAIM`, Redis 6.2+). Limits: the data is in memory (persistence depends on Redis's AOF/RDB), and one stream is one key — in a cluster it lives on one shard, and isn't partitioned automatically like Kafka (if you need that, you build several streams yourself).

> **Trade-off Table — four tools through three questions**

| Tool              | Who gets it                                             | After reading                | Order                                                           | Slow/missing consumer                        | Good for                                               |
| ----------------- | ------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| **Redis Pub/Sub** | Every connected subscriber                              | Nothing is stored            | In order, to one subscriber                                     | Missing → lost; slow → cut off               | Presence, typing, cache invalidation — no harm if lost |
| **RabbitMQ**      | One per queue (with fanout, everything per service)     | Deleted on ack               | Queue is FIFO, but breaks with competing consumers              | Stored at the broker (long queues are heavy) | Jobs/tasks, complex routing, per-message retry         |
| **Kafka**         | Everything per group; within a group, one per partition | Kept until retention; replay | Strict within a partition, by key                               | Just lag; same cost to the broker            | Event streams, many consumers, replay, high throughput |
| **Redis Streams** | Everything per group; within a group, one               | Kept until trimmed; replay   | In order in the stream, but a group's consumers run in parallel | Stored (in memory)                           | Medium-sized events/jobs, when you already have Redis  |

(Each has relatives in the cloud: SQS ≈ queue, SNS ≈ pub/sub fanout, SNS→SQS ≈ RabbitMQ's fanout exchange; Kinesis and managed Kafka ≈ log. Different names, the same three questions.)

### 1.7 TaskFlow's decision — per message, not per tool

The first mistake was assuming "pick one tool". Actually TaskFlow has two kinds of message, and they want different answers to the questions:

- **Tasks (job / command):** "send this email", "build this thumbnail", "generate this export". One worker does it, once (or at least once, idempotently); if it fails, that one is retried on its own, maybe with a delay (a reminder in 5 minutes). No history needed. → **queue semantics**: per-message ack, retry, delay. On TaskFlow's Node stack the easiest path to this is BullMQ (on top of Redis) — Lesson 7.3.
- **News (event):** "a comment was created", "a task was completed". Everyone who wants to hear it, each at their own pace, in order per task, and ideally a new service gets the old news too. → **log semantics**: consumer groups, partition key = `taskId`, retention.

Do we need Kafka for the second? The honest answer: **at TaskFlow's size, probably not.** ~20 events per second — for Kafka that's close to zero, and less than the cost of running a Kafka cluster (or the bill for a managed service). Redis is already there; Redis Streams has consumer groups, per-message acks and limited replay. The day it's needed — many teams, many consumers, weeks of retention, stream processing — that's the day for Kafka. This is also a Lesson 10.7 cost question.

And Redis Pub/Sub has a place — just for other work: showing "Rahim is typing…" next to a comment, where lost news has no value.

One last warning, useful both in interviews and in production: **using a tool for its opposite job** is a well-known failure. Turning Kafka into a job queue with per-message retry (the partition gets stuck on a poison message), or keeping event history in RabbitMQ (long queues, no history) — both are possible, both are painful.

---

## 2. Interview Angle

**"What's the difference between Kafka and RabbitMQ?"** — The most common question, and the most common weak answer is "Kafka is faster". A good answer starts from the core difference: "RabbitMQ is a queue — a message is deleted when acked, the bookkeeping is on the message. Kafka is a log — messages stay, the bookkeeping is in the reader's offset." Then its consequences: replay and many consumer groups (Kafka), per-message acks, routing and retry (RabbitMQ), order per partition and parallelism tied to partitions (Kafka). Finally: "a queue for jobs, a log for event streams" — and one example.

**In a design interview ("design a notification system", "design a news feed"):** after you draw a box labelled "Kafka" in the diagram, the interviewer almost always asks — what's the partition key? How many partitions? What happens if a consumer crashes? Have the answers ready: key = the entity whose order you need (user, task), number of partitions = the maximum consumer parallelism you expect (plus some headroom), crash → again from the last commit, so duplicates, so an idempotent consumer. Bonus: bring up the hot partition yourself (the celebrity user).

**"Is exactly-once delivery possible?"** — A trap. The answer: along the whole path from the broker to the consumer's side effect, in general, no — the ack and the work are two separate events (1.3's picture). In practice: at-least-once delivery + idempotent processing = an exactly-once **result**. Kafka's "exactly-once semantics" (transactions and the idempotent producer) is for read-process-write **inside** Kafka; when the consumer touches something outside (an email, another database), idempotency is your responsibility again.

**In real production:** for a queue, measure the queue's length and the age of the oldest message (7.1); for a log, each consumer group's lag — per group and per partition. And one real thing that happens to almost every team: when a Kafka consumer's processing gets slow it doesn't poll in time, the broker assumes it's dead and gives its partitions to someone else (a rebalance), it wakes up and fails when it tries to commit — and that batch is processed again. Lesson 6.1's process pause, in new clothes.

---

## 3. Key Takeaway

- Recognise any messaging system by three questions: **who gets a message**, **whether it stays after reading**, **in what order it arrives** — not by the name (a product called "Pub/Sub" can really be a queue)
- **Competing consumers** (one gets it) for tasks, **pub/sub** (everyone gets it) for news; in practice both together — everyone between services, shared within a service (fanout exchange + queues, or consumer groups). In the exercise, three services on one queue → 40/40/20%
- **Redis Pub/Sub** stores nothing: 193 lost on a deploy, slow subscribers get cut off. For news where losing it is fine
- **Ack** before the work → lost, after → twice; the broker alone can't give "exactly once". With a log's offset commit the duplicate window is even bigger (110 at 5 s) — at-least-once + an idempotent consumer (7.4)
- A slow consumer doesn't drag others down at the broker; the backlog is **stored** in a queue, and exists only as **lag** in a log
- A **log** doesn't delete after reading — offsets per **consumer group**, **replay** up to retention, history for a new service
- Order comes from **partition + the right key** (key = task → 0 out of order, random → 69); the price is **head-of-line blocking** (delay max 3.1 → 7.0 s), parallelism tied to partitions, and a hot partition with the wrong key

---

## 4. New Terms (Glossary)

| Term                         | Meaning                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Message Broker**           | A separate server that takes producers' messages, stores them and delivers them to consumers; the two sides don't know each other                             |
| **Competing Consumers**      | Many consumers read from the same queue, each message goes to only one — the work is shared                                                                   |
| **Publish/Subscribe**        | The producer sends to a topic, every subscriber gets its own copy                                                                                             |
| **Acknowledgement (Ack)**    | The consumer tells the broker "the work for this message is done"; if the consumer is lost before the ack, the broker hands the message out again             |
| **Append-only Log / Offset** | Messages are added at the end and not deleted after reading (until retention); the offset is a message's sequence number, and marks how far a reader has read |
| **Consumer Group**           | A team of consumers for the same job, with one set of offsets — partitions are shared within it, separate groups read the whole log independently             |
| **Head-of-line Blocking**    | One slow or stuck message at the front of the line holds up everything behind it — the price of preserving order                                              |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each in your own words.

1. For each of TaskFlow's four messages, choose — queue, simple pub/sub, or log — and give the reason through the answers to the three questions (who gets it, whether it stays, order): (a) the password reset email; (b) `task.completed`, which notification, analytics, billing (counting usage per completed task) and a webhook integration listen to; (c) when someone else drags a card on the board, it moving live in everyone's browser; (d) the audit team's request: "we want to be able to look again, at any time, at who changed what on which task in the last 30 days."
2. TaskFlow's `task-events` Kafka topic has 6 partitions, key = `projectId`, and 6 consumers in the notification group. One project of one enterprise customer now produces 60% of all events. What will you see on the dashboard (which metric, where)? What happens if you add 6 more consumers? If you add 6 more partitions? What's the real fix — and what's its price?
3. A teammate says: "In RabbitMQ a message is deleted after it's acked, and if it isn't acked it comes again — so every message is processed exactly once." Where is this wrong? Draw a timeline showing how the same message is processed twice, and how (with another ack policy) not even once. For TaskFlow's "comment mention email", which policy would you choose, and what would you do against duplicates?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

- **(a) Password reset email → queue.** One worker sends it (competing), once; if it fails, that email is retried; after sending there's no need for history (it shouldn't even be kept — the link has a token in it); order is irrelevant. This is a **task**, not news. BullMQ/RabbitMQ/SQS.
- **(b) `task.completed` → log (or fanout + a queue per service).** Four listeners — pub/sub's "everyone gets it". And for billing losing is not acceptable, so not simple Redis Pub/Sub. Order per task (reopened can come after completed) → key = `taskId`. If something goes wrong in billing, being able to count old events again (replay) is a big advantage → leaning towards a log. The webhook is a separate group, because an outside server can be slow — and in a log it only increases its own lag, not others' (1.3).
- **(c) Live card movement → simple pub/sub (Redis Pub/Sub, then WebSocket — Lesson 2.4).** Only those who have the board open right now need it; someone who's offline will read the current state from the database when they open the page later — old "moved" news is worthless. Losing is fine, speed matters. (One subtlety: if two move events arrive in reverse order, the card can show in the wrong place — send a version number and drop the older one, like 6.3's version token.)
- **(d) Audit → it can arrive via the log, but the place to keep it is the database.** An audit consumer reads the events from the log (retention 30+ days) and writes them into an `audit_log` table — because audit's question is about **searching** ("who did what on this task"), and a log isn't for searching, it's for reading in order. Making the broker the only home of long-term records is 1.4's warning. (An alternative: the API itself writes the audit row inside the transaction — then there's no need for the broker at all. Which to choose depends on how strongly audit needs "must not be lost" — 7.5's outbox question.)

**Question 2:** `hash(projectId) % 6` — every event of that project in one partition. On the dashboard: the consumer lag of that **one** partition keeps growing, the other 5 have lag near zero; that partition's consumer is at 100% CPU, the others nearly idle. That customer's notifications are minutes — then hours — late.

- **6 more consumers:** no benefit. There are 6 partitions, so at most 6 in the group get work (the exercise's "4 sit idle"). And the hot partition belongs to just one.
- **6 more partitions:** the hot project still goes to **one** partition (same key → same partition) — its problem doesn't go away. Worse, adding partitions changes `hash % n`, so other projects' events start going to new partitions — at the moment of change, the same project's old and new events are in two partitions, and order can break temporarily.
- **The real fix — change the key:** at what unit do you actually need order? For notifications, order "per task" is enough — not across the project. With key = `taskId`, a big project's events spread over thousands of tasks, across every partition. The price: there's no longer any order between the events of two different tasks in the same project — if some consumer needs that (e.g. a "project total count" that grows in order), it needs a separate arrangement. If you really need project-level order, handle that one hot key separately (its own topic, or split the key into `projectId + bucket` and give up the order) — the same list of fixes as 5.8's celebrity problem.

**Question 3:** The mistake: "deleted when acked" and "the work is done" aren't the same thing — the work (sending the email) and the ack (telling the broker) are two separate events, on separate machines.

```
  ack after the work (at-least-once):
    t0  the worker got the message
    t1  sent the email ✓                          ← the side effect has happened
    t2  ✗ crash (or the network broke), no ack sent
    t3  broker: the connection is gone, no ack → the message goes back into the queue
    t4  another worker got it → sent the email again   ← twice

  ack before the work (at-most-once):
    t0  the worker got the message → acks right away → the broker deletes it
    t1  ✗ crash before sending the email
        the message no longer exists anywhere     ← not even once
```

For the mention email: **ack after the work** — because a mention email not going (someone never learns they were called) is worse than it going twice. Against duplicates: a fixed idempotency key for each email (e.g. `mention:{commentId}:{userId}`), and before sending, an insert into a `sent_notifications` table with a unique constraint on that key — if the insert fails, it was already sent, so skip it this time. (An exact match with the solution for Lesson 6.1's reminder.) Still a small gap remains — the insert succeeds, a crash before sending the email — and then the email won't go; the way to close that (and the provider's own idempotency key) is in Lesson 7.4.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (deterministic simulation)

> **Ready to run in the repo:** [`exercises/lesson-7.2-queue-vs-pubsub/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-7.2-queue-vs-pubsub) — `npm install`, then `npm run all` (or `fanout`, `crash`, `slow`, `replay`, `ordering` separately). No Docker needed. The full setup, acceptance criteria and experiments are in that folder's `README.md`.

`brokers.ts` has the rules of three brokers — `runPubSub` (like Redis Pub/Sub), `runQueue` (like a RabbitMQ queue, with round-robin and acks), `runLog` (like Kafka/Redis Streams, with partitions, consumer groups, offset commits and retention). `model.ts`'s `Recorder` measures through each service's eyes: what it got, how many times, in what order, how late. Each event's processing time is the same on every broker — so the comparison stays honest.

**Honest note:** verified by running it in the sandbox: `tsc --noEmit` is clean; `npm run all` was run twice with identical output; all five of the README's experiments were run, and the numbers are in the README. These aren't real brokers — they're imitations of their core rules. The broker's own crashes and replication, the network, disk, Kafka's rebalances, Redis Streams' pending entry claims — none of these are here; and pub/sub's buffer limit is in number of messages here, in bytes in Redis. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Guess first:** **before** running, guess and write down every cell of the `crash` and `ordering` tables (which are zero, which are big). Then run and compare. Which cell did you get wrong, and which rule had you misunderstood?

2. **The duplicate window:** why is the log's duplicate count in `crash` 110 — do a rough calculation by hand (how many events/second arrive at the search service, how often it commits). Then run with `COMMIT_MS=1000` (experiment 1) and check your calculation. Why won't it be zero even if you commit after every message?

3. **Trying to turn Pub/Sub into a queue** (experiment 2): `BUFFER_LIMIT=100000 npm run slow`. The losses went to zero — so is Redis Pub/Sub durable now? Will `crash`'s pub/sub row change now? Why not?

4. **Partitions and order** (experiments 3 and 4): run `ordering` with `PARTITIONS=8` and `PARTITIONS=1`. Make a small table of three numbers (out of order, delay p99, consumers with work) — for 1, 4 and 8 partitions. From this table, how many partitions would you choose for TaskFlow's `task-events` topic, and why?

5. **Design part:** a one-page design doc for TaskFlow's messaging — the page the CTO asked for. (a) A list of all of TaskFlow's messages (at least 8: assign email, mention email, password reset, export, thumbnail, `comment.created`, `task.completed`, typing indicator…) — mark each "task" or "news". (b) For each: the model (queue / pub/sub / log), the tool, who the consumers are, the key (if order is needed), retention (if needed), the ack/commit policy. (c) Tuesday's and Thursday's two incidents and next month's search-v2 — show where each is stopped in your design. (d) Whether to take on Kafka — in one paragraph, with TaskFlow's size and the team in mind.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6 (complete, including exit challenges), 7.1
Current: 7.2 — Message Queue vs Pub/Sub: RabbitMQ, Kafka, Redis Streams
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; messaging design: "tasks" (email, export, thumbnail) → queue
semantics, BullMQ on Redis (to be built in 7.3); "news" (comment.created, task.completed) →
log semantics, Redis Streams, one consumer group per service, key = taskId; typing/presence →
Redis Pub/Sub; every consumer at-least-once (idempotency still to come — 7.4)
Terms learned (Module 7 so far): Synchronous/Asynchronous Processing, Critical Path,
Temporal Coupling, Cascading Failure, Fire-and-Forget, Job Queue (Producer/Worker), Backlog,
Message Broker, Competing Consumers, Publish/Subscribe, Acknowledgement, Append-only Log /
Offset, Consumer Group, Head-of-line Blocking
Weak spots: [where you got stuck — fill this in yourself]
Next: 7.3 — BullMQ hands-on: background job processing in Express
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over — especially your duplicate calculation in #2 and your design doc in #5. When you are ready, write `next` — we'll go to Lesson 7.3: **BullMQ hands-on — background job processing in Express.** Today we saw the rules in a simulation; now the real thing. We'll move 7.1's assign email into a BullMQ queue on Redis — a separate worker process, with retry and delay — and then run 7.1's experiment again: `SIGKILL` the API process in the middle of the slow phase. What happens to the 103 emails this time? Along with that, how a job inside BullMQ goes from "waiting" to "active" to "completed" or "failed" — and what happens to a "stalled" job when a worker dies — a real answer to today's ack question.
