# Lesson 11.3 — Case Study: Design a Chat System (WhatsApp-style)

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 7.4):** Why does a retry need **jitter** along with exponential backoff? Without jitter, when a thousand clients fail at the same moment, when do their next attempts arrive? Today a gateway will die and half a million phones will try to come back at once, and you will see that without jitter not a single one is back after ten minutes.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.6 (Stateful), Lesson 2.4 (WebSocket), Lesson 2.5 (Idempotency key), Lesson 3.4 (Health check, draining), Lesson 6.4 (Clock skew, ordering), Lesson 7.2 (Pub/sub), Lesson 7.4 (Retry, backoff, jitter), Lesson 10.3 (Blast radius), Lesson 11.1, 11.2

**By the end of this lesson you will be able to:**

1. Say with numbers where a chat system's real cost is: open connections, heartbeats, fan-out and receipts, and how many times over a product decision like "do we keep history on the server" changes storage
2. Give the full answer to 2.4's open question: with millions of WebSockets on a few hundred gateways, how a message reaches the right gateway (broadcast, per-user channel, session registry), and when a gateway dies, how to keep the reconnect storm from becoming a congestion collapse
3. Design delivery guarantees and ordering: "store first, then push", ack and retry, dedupe with client_msg_id, ordering and sync with a per-conversation seq, and what the sent/delivered/read ticks really are

**Tier:** 1 — Runnable Code (three deterministic models and a real two-gateway chat with `ws`; no Docker needed)

---

## 0. Today's System

The interviewer:

> "Design a chat app like WhatsApp. One to one, and groups. Sending messages, delivery, read ticks. If you're offline you get them later."

In the previous two case studies the client asked and the server answered. This time, for the first time, it is the other way round: **the server has to find the client on its own.** Bob will get a message when he has asked for nothing. So a connection from Bob's phone is always open (2.4's WebSocket), and that connection is tied to one particular server (1.6's stateful).

In 2.4 we left a question open: "how will you scale WebSockets horizontally?" Back then the answer was one line: "you need a shared pub/sub layer." Today we test that line with numbers, and see at what size it breaks. The interviewer's follow-ups go like this:

- "Alice is on one server, Bob on another. How does the message find Bob's server?"
- "Half a million connections on one server, and the server dies. What happens?"
- "Bob's phone is on the subway, the network comes and goes. How will you make sure a message is not lost and does not arrive twice?"
- "Two people write in a group at the same time. Will everyone see the same order?"
- "What exactly do two blue ticks mean, and how many writes is that?"

---

## 1. Theory

### 1.1 Step 1 — Requirements

```
Question                                   Assumed
How many users?                            500 million DAU, 30% online at peak
What kind of chat?                         1:1 and groups (20 people on average, a few hundred at most); broadcast channels (100,000s of members) not today
What can be sent?                          text; images and video go through 8.2's presigned upload path, only their link here
Receipts?                                  sent ✓, delivered ✓✓, read (blue ✓✓)
Offline?                                   yes — gets everything when back on the phone, with push notifications
History?                                   **ask the question** (see 1.2)
Presence ("online", "last seen")?          yes, but cheaply
End-to-end encryption?                     out of scope (say it in one line, below)
```

**Non-functional:** messages arrive in order, are never lost, are never shown twice; from sending to delivery (both online) p99 a few hundred ms; when a server dies, everyone is back within minutes; low cost to the phone's battery and data.

The one line on end-to-end encryption: a message is encrypted on the phone, and the server only carries the envelope, it does not open it. Its effect on the design is big: the server cannot read the text, so server-side search or spam filters cannot work by looking at text, and one person's several devices means a separately encrypted copy for each device. Today's design does not care what is inside the envelope, so encryption can be added later.

### 1.2 Step 2 — Estimation: where the cost is

`npm run estimate`:

```
── Part A — connections: 500 million DAU, 30% online at peak ──
connections open at once                                       150 million   each is a TCP + TLS + WebSocket
connection memory (20.0 KB each, approximate)                       3.0 TB   kernel buffers, TLS, app state
gateway servers (500,000 connections each)                             300   when one dies, this many people reconnect at once
heartbeats / s (every 30 s)                                      5,000,000   more than the messages

── Part B — messages: 40 a day per user, 30% in groups (20 people on average) ──
messages sent / s (peak, 3×)                                       694,444
deliveries per message (fan-out)                                       6.4   each group member is a separate delivery
deliveries / s (peak)                                            4,444,444
receipts (delivered + read) / s (peak)                           8,888,889   two from each delivery — more writes than messages

── Part C — storage: 200 B per message ──
all history forever (10 years, one copy)                           14.6 PB   history on the server (like Messenger/Slack)
only undelivered messages (deleted once delivered)                  3.2 TB   50% of deliveries wait 6 hours on average
difference                                                     4,562 times   a product decision, not a storage one

── Part D — presence: 200 contacts on average, online ↔ offline 20 times a day ──
push to every contact / s                                       23,148,148   presence storm
only those with the chat open (1%) / s                             231,481   lazy presence: only if subscribed
```

1. **The real cost is in connections.** 150 million open connections, 3 TB of memory just to hold them, 300 gateways. And heartbeats (small pings to check a connection is alive) at 5 million a second, **7 times** the peak messages. The heartbeat interval is a trade-off: short, and dead connections are caught quickly, but the phone's battery and the server's CPU go; long, and the NAT and mobile network boxes in between silently cut the connection, and the server does not notice for a long time.
2. **The real write load is fan-out and receipts.** One message sent is 6.4 deliveries on average (each group member separately), and each delivery brings two receipts. One message means almost 20 events. And with groups of 200 (experiment), 60 deliveries per message, 80 million receipts a second. So in big groups the "who has read it" receipts have to be handled separately (1.7).
3. **The history question is 4,500 times.** If the server keeps every message forever (log into a new phone and see all your old chats, like Messenger or Slack), ~15 PB in ten years. If the server keeps them only **until delivered** and the phone keeps its own history (WhatsApp's original design is published as working this way, with backups on the phone's side), then at any moment only the waiting messages, ~3 TB. This is a question to ask the interviewer, because its answer changes the kind of database: a small, fast queue-like inbox, or a huge, permanent log.
4. **Presence, unless done cheaply, is the biggest cost.** When someone comes online or goes offline, telling their 200 contacts: 23 million events a second, 5 times the deliveries, and almost nobody looks. **Presence** — whether a user is online right now, or when they last were. The cheap way (lazy presence): send presence only when someone has that user's chat open (has subscribed), and read "last seen" only when a chat is opened. One hundredth of the load.

### 1.3 API and data model

**Client ↔ gateway (frames over the WebSocket, parsed with Zod):**

```
client → server                                         server → client
send      { conv, clientMsgId, text }                   ack      { clientMsgId, seq, duplicate }
delivered { conv, seq }                                 message  { conv, seq, from, clientMsgId, text }
read      { conv, seq }                                 receipt  { conv, seq, by, kind: delivered | read }
sync      { cursors: { conv → last seq received } }     synced   { messages[] }
```

**Data:**

```
conversation(id, members[])
message(conv_id, seq, from, client_msg_id, body, created_at)     PRIMARY KEY (conv_id, seq)
  UNIQUE (conv_id, from, client_msg_id)                          ← dedupe
cursor(user_id, conv_id, delivered_seq, read_seq)                ← how far each person has received and read
session(user_id → gateway_id, connected_at)                      ← the registry, in Redis, with a TTL
```

A message's key is `(conv_id, seq)`: all of a conversation's messages side by side, in seq order, and "everything after seq 41 in conv X" is one range scan. Sharding (5.8) by `conv_id`, so a conversation stays in one place and one party hands out its seqs (1.7). For data of this shape (one partition key, order inside it, lots of writes) a wide-column store is common: Facebook Messenger's HBase and Discord's Cassandra (later ScyllaDB) are described in their published writing. The same design also works in Postgres sharded by `conv_id`.

### 1.4 Step 3 — High-level design, and which gateway to send to

```
 phone ══ WebSocket ══ [gateway × 300] ──► [chat service] ──► [message store (conv_id, seq)]
  ▲                       │    ▲                │    │
  │                       │    │                │    └──► [push service] ──► APNs / FCM (when offline)
  │                       ▼    │                ▼
  │               [session registry]      [receipt/cursor store]
  │               user → gateway (Redis)
  └──── sync: "conv X after seq N" ◄── gateway ◄── store
```

**Connection Gateway** — a server only for holding connections: TLS, WebSocket, heartbeats, and passing frames to the chat service and writing the chat service's frames to the right socket. No business logic inside. The reason: deploying a gateway means cutting hundreds of thousands of connections (1.5), so the less it changes the better. The logic lives in the stateless chat service behind it, which can be deployed every day without cutting a single connection.

Now 2.4's question: the chat service knows the message is for Bob. Which gateway is Bob on? `npm run gateway` part A, 4.4 million deliveries a second at peak, 300 gateways:

```
path                                                                   received/s per gateway   useful    op/s in the middle layer
broadcast to every gateway (one pub/sub channel)                                 4,444,444       0.3%     1,333,333,200
a channel per user, Redis Cluster's old PUBLISH (spread over 10 nodes)              14,815     100.0%        44,444,440
a channel per user, sharded pub/sub (SPUBLISH)                                      14,815     100.0%         4,444,444
session registry (user → gateway) + direct send                                     14,815     100.0%         8,888,888
```

- **The simplest form of 2.4's "one shared pub/sub", everything on one channel, dies at this size.** Every gateway gets every delivery (4.4 million/s), 0.3% of which are its own. 1.33 billion a second in the middle layer. At a small size (a few servers) it is the right answer, and 2.4 was talking about that size.
- **A channel per user:** each gateway subscribes to the channels of its connected users. A gateway only gets its own. But there is a trap: Redis Cluster's old `PUBLISH` spreads a message to **every node** in the cluster (that is how pub/sub across the cluster used to work), so the middle layer is multiplied by the number of nodes. Redis 7's sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`) keeps a channel on one shard.
- **Session Registry** — a small `user → gateway` map (in Redis, with a TTL, renewed on heartbeat). The chat service does one lookup before a delivery, then sends straight to that gateway (RPC or a queue per gateway). Two ops per delivery in the middle layer. Clear and easy to debug ("where is Bob right now?" is one question), and that is what this design uses.

Both paths share a weakness, which is the centre of the next section: **the registry can be stale.** Bob's gateway has died, but the registry still says "gw2".

### 1.5 A gateway died: the reconnect storm

Half a million connections on one gateway. The gateway crashed (or was shut down for a deploy). Half a million phones find out at almost the same moment, and they all want to come back. Every return means TCP, TLS, auth, a registry write, and a sync. Say the rest of the fleet's total capacity is 20,000 such handshakes a second. And one real-world detail: **a rejected attempt is not free either.** Some TCP and TLS work happens before the server says no because of overload; say 0.2 of a full handshake. `npm run gateway` part B:

```
policy                                                 attempts/s (peak)    total attempts   per client   50% back   99% back          all back
at once, and again at once on failure                       5,000,000   3,000,000,000       6,000         —         —     0% (in 10 min)
at once, and exactly 1 s later on failure                   5,000,000     300,000,000         600         —         —     0% (in 10 min)
exponential backoff, no jitter                              5,000,000       7,500,000          15         —         —     0% (in 10 min)
first one spread over 0–10 s + full jitter                    251,980       3,304,742           7   30.47 s   76.55 s         89.40 s
best possible: 500,000 ÷ 20,000/s = 25.00 s.
```

**The spaced repetition answer:** without jitter, clients that failed together retry together, because they all do the same maths. Backoff only widens the gap between the waves; it does not lower the height of a wave. Jitter (a random delay) spreads the wave out in time.

And here is its extreme form: **Congestion Collapse (reconnect storm)** — demand so far above capacity that all the capacity goes on the cost of rejections, and not one attempt succeeds; everyone tries again, and things never get better on their own. 0.2 of half a million attempts = the work of 100,000 handshakes, against a capacity of 20,000 a second. Under the first three policies **not a single client is back after ten minutes.** There is backoff, but no jitter: half a million phones together after 1 s, together after 2 s, together after 4 s, hitting the same wall each time. Experiment 1: even with the rejection cost down at 0.02 (ten times cheaper), the collapse remains.

Under the fourth policy everyone is back in 89 s, close to the theoretical best of 25 s. And experiment 2 shows something unexpected: spreading the first attempt over **60 s** instead of 10 s gives exactly one attempt per client, no rejections, and 99% back **in 59 s, before the 10 s spread's 76 s.** Starting slower finishes faster, because nothing is wasted on rejections.

So in the gateway's design: jitter on the client's reconnect from the very first attempt (spread over 30–60 s), full jitter with exponential backoff, and cheap rejection from the server's side (at the load balancer, before TLS, by connection rate, 11.2's limiter). And on a planned shutdown (deploy), not a cliff but **draining** (3.4): the gateway stops taking new connections, and tells the old ones "go elsewhere" a few at a time over a few minutes. Deploys cause no storm, only crashes do.

**The time the registry is stale.** Part C: these half a million people are receiving ~14,800 messages a second, and the registry keeps pointing at the dead gateway until they come back somewhere else:

```
policy                                                push only: lost        store first, then push: lost    delay p50    delay p99
at once, and again at once on failure                    444,444 (100%)                             0    > 10 min    > 10 min
first one spread over 0–10 s + full jitter                391,250 (88%)                             0   16.82 s   64.77 s
```

If messages are only pushed (look up the registry, send to the gateway, done), 88% of the first 30 seconds are lost. If it is **store first, then push**, nothing is lost: the message is durable in the store, the push is only a fast path, and the phone takes whatever it missed in a sync when it comes back. The only price is delay (p99 65 s, the time for the phone to return). This is the most important rule of this design:

**Store-then-Push (Inbox + Sync)** — a message is first written to a durable store (and the sender is acked right then), then pushed to an online recipient as best-effort. The recipient can ask at any time "what is there after seq N in this conversation?" and fill every gap. If a push is lost, goes twice, or the registry is wrong, the damage is only delay, never loss. Push is an optimization; sync is the truth.

### 1.6 Deep dive — delivering exactly once: ack, retry, dedupe

On mobile networks packets get lost, connections drop, phones go into tunnels. `npm run delivery` part A: A → server → B, each packet lost 3% of the time:

```
policy                                                 B didn't get it   B saw it twice   stored twice on server   packets / message
send once, no ack (at-most-once)                              5.94%          0.00%              0.00%             3.94
resend if no ack (at-least-once)                              0.00%          5.80%              2.92%             4.31
resend + drop by client_msg_id and seq                        0.00%          0.00%              0.00%             4.25
```

- **Without retries, almost 6% is lost** (two hops, 3% on each). Experiment 3: 19% on a network losing 10%.
- **Retries, no dedupe:** nothing is lost, but 5.8% is shown twice. Why: A's message reached the server, but the server's ack was lost. A thought it hadn't gone, sent it again, and the server stored it twice. The same happens on server → B.
- **Retries + dedupe:** zero lost, zero twice. Two separate keys on the two hops: on the server, **client_msg_id** (the phone makes an id for each message and sends the same one on retry; the server checks `UNIQUE (conv, from, client_msg_id)` and returns the earlier seq, 2.5's idempotency key exactly), and on the phone, **seq** (the same seq arriving twice is one message). At-least-once + idempotent = effectively once, as 7.4 said.

**Delivery Receipt (sent / delivered / read)** — each tick is a separate event and a separate write: **sent ✓** = the server has stored it durably (the sender's ack, the answer to client_msg_id); **delivered ✓✓** = the recipient's phone got the message and sent an ack on its own; **read (blue)** = the recipient opened the chat. The last two go back to the sender as receipts, and are stored on the server in `cursor` (not per message, but "how far" per conversation: `delivered_seq`, `read_seq`; one cursor covers every earlier message).

The cursor idea cuts the receipt load: when Bob reads ten messages together, it is one "read up to seq 50", not ten. And in a big group (200 people), sending every member's every receipt to the sender separately is 1.2's 80 million/s; so in groups receipts are batched, every few seconds, or read only when the sender opens "info".

### 1.7 Deep dive — ordering: who decides which came first

Two problems in a group: (1) **causality**: C saw a question and answered it; the answer must not appear above the question on anyone's screen. (2) **agreement**: two people wrote at almost the same time; everyone must see the same order, or the conversation means different things to different people. Part B, a group of 5, phone clocks ±500 ms (2% of phones a minute or so off), three chat servers (±30 ms):

```
order                                                   answer above question        members see different orders
sorted by the sending phone's clock                                  10.21%                   0.00%
shown in the order they arrived                                       0.41%                  47.59%
sorted by the chat server's clock                                     0.00%                   0.00%
per-conversation seq (one sequencer)                                  0.00%                   0.00%
```

- **The phone's clock:** everyone sees the same order (the same timestamps), but **10% of answers are above their question.** 6.4's point: clocks can't be trusted, and phone clocks least of all. Someone whose phone is two minutes behind has every answer jump up.
- **Arrival order:** causality is almost right (an answer is sent after the question arrives), but for two messages written together, **members see different orders in 48% of cases,** because the two messages reach each member by different paths.
- **The server's clock:** both are zero here, because people take seconds to answer and the server clocks are off by a few ms. Experiment 4: with answers coming in 20 ms (a bot), 0.09% even with the server's clock. "Almost always right", not guaranteed.
- **Per-Conversation Sequence (Sequencer)** — each conversation has one owner (the leader of its shard or partition), which gives every new message an increasing number: 1, 2, 3... Everyone sorts by seq, and on seeing a gap (43 after 41) waits or syncs. Causality is guaranteed (the answer reaches the server after the question, so it gets a bigger seq), and everyone sees the same order, both by construction, not from clocks.

The real value of seq is not just ordering: it is **the language of sync.** "I have received up to 41 in conv X" is unambiguous, unlike a timestamp ("after 12:03:05" — what if two were in the same millisecond?). The cursor (1.6) and sync (1.5) stand on this one number. The price: every write to a conversation goes through one sequencer, so it is a speed limit (a few thousand messages a second in one group, which is never a problem for a human group), and its failover needs 6.2's consensus, so two parties never hand out the same seq. Seq is inside a conversation, not across the whole system: order between two different conversations has no meaning, so no global sequencer is needed.

### 1.8 A real chat: two gateways, a registry, a store

`npm run smoke` runs every rule above in one place: two real WebSocket gateways (`ws`), a `ChatCore` (registry, the conversation's log and seq, dedupe, fan-out, receipts, sync), three users:

```
#   step                                                     result
1   alice → bob: "hi"                                        ack seq 1 (✓ durable on the server)
2   bob received it (on gw2, via the registry)               1:hi
3   bob's phone sends "delivered" automatically              alice got receipt: delivered (✓✓)
4   bob read it                                              alice got receipt: read (blue ✓✓)
5   alice resent the same client_msg_id (as if the ack was lost)   ack seq 1, duplicate: true; 1 at bob
6   alice → team, 3 messages, carol offline                  bob: 1:standup?, 2:at 10, 3:ok; offline push: 3
7   carol online (gw1), sync { }                             1:standup?, 2:at 10, 3:ok
8   gw2 crashes; alice → bob 2 messages (registry still gw2) stale route: 2, 3 in dm in the store
9   bob reconnects on gw1, sync { dm: 1, team: 3 }           2:you there?, 3:call me
10  alice and bob in team at the same time                   carol sees: 4:me first, 5:no, me; seq: 4, 5
11  the core's counts                                        stored 8, duplicate 1, other gateway 9, same gateway 8
```

- Steps 1–4: three ticks, three separate events. Alice is on gw1, Bob on gw2; messages and receipts go both ways via the registry.
- Step 5: a retry after a lost ack, the same client_msg_id. The server returns the earlier seq, and Bob gets only one.
- Steps 6–7: Carol is offline, three push notifications are counted; she comes and gets all three in seq order in one sync.
- Steps 8–9: gw2 dies, the registry still shows gw2, and two pushes fail as "stale route". But the messages are in the store. Bob comes back on gw1 and syncs with his cursor, getting exactly the two he missed.
- Step 10: two people write at once; the sequencer gives 4 and 5, and Carol sees them in that order.

### 1.9 Step 5 — Trade-offs and wrap-up

**The final design:**

- **Connections:** ~300 gateways, holding connections only, no logic; heartbeat around 30 s; on the client, reconnect with jitter from the first attempt (spread over 30–60 s) + full jitter backoff; draining on deploy; cheap rejection at the LB.
- **Routing:** session registry (Redis, TTL, renewed on heartbeat) + sending straight to the gateway.
- **Delivery:** store-then-push; the sender's ack after the store; dedupe by client_msg_id; push best-effort; a push notification when offline; sync by seq.
- **Ordering:** a per-conversation seq, handed out by the leader of the conversation's shard; clients sort by seq and sync on seeing a gap.
- **Receipts:** cursors (`delivered_seq`, `read_seq`) per conversation, not per message; batched in big groups.
- **Presence:** lazy, only for open chats.
- **Storage:** according to the product's answer — an inbox until delivered (TB) or a permanent log (PB), key `(conv_id, seq)`, sharded by `conv_id`.

> **Trade-off Table — chat's big decisions**

| Decision  | Chose                                    | Alternative              | What I gave                                           | What I got                                                                     |
| --------- | ---------------------------------------- | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| Routing   | Session registry + direct                | Broadcast on one channel | The registry is a new thing, and can be stale         | A gateway gets only its own (0.3% useful with broadcast)                       |
| Delivery  | Store-then-push + sync                   | Push only                | A durable write first on every message                | Zero lost even if the registry is wrong or a gateway dies (88% with push only) |
| Retry     | At-least-once + client_msg_id            | At-most-once             | The dedupe index and state                            | Zero lost, zero twice (otherwise 6% lost or 6% twice)                          |
| Ordering  | Per-conversation seq                     | Phone or server clock    | A sequencer, and consensus for its failover           | Causality and agreement guaranteed; a clear language for sync                  |
| Reconnect | Jitter from the first attempt + draining | Retry at once            | After a crash, some phones offline for up to 1 minute | No collapse (without jitter nobody is back in 10 minutes)                      |
| Presence  | Lazy (open chats only)                   | Push to every contact    | "Online" somewhat late, or only once a chat is open   | One hundredth of the load                                                      |

**What breaks first:** big groups and channels (thousands or hundreds of thousands of members) — fan-out writes per message become impossible, and then fan-out on read (the central question of 11.4's news feed); one person's several devices (a separate cursor and a separate connection per device, and a separate copy under encryption); and multi-region (10.8) — a conversation's sequencer is in one region, and members on another continent pay a far round trip on every write.

---

## 2. Interview Angle

The chat system is the most common "real-time" interview question, and here the interviewer watches whether you understand stateful systems. The shape of a good answer:

1. **The history question in the requirements.** On the server forever (PB) or until delivered (TB). And the limit on group size.
2. **Numbers.** Connections and their memory, the number of gateways, heartbeats, fan-out and receipts. Show that the load is not in messages.
3. **Gateways and routing.** Gateways without logic, the session registry, and why broadcast breaks at this size.
4. **Delivery.** Store-then-push, ack, client_msg_id, seq, sync. The meaning of the three ticks.
5. **Failure.** When a gateway dies: the registry is stale (the store saves you), the reconnect storm (jitter, draining, cheap rejection).

**Follow-ups that are almost certain:**

- _"Can't you just tell every gateway with Redis pub/sub?"_ — Everything on one channel: every gateway gets every delivery, 0.3% useful with 300 gateways. A channel per user is fine, but Redis Cluster's old PUBLISH spreads to every node; sharded pub/sub or a registry.
- _"How do you order messages?"_ — Not by timestamp (10% of answers above the question with phone clocks). A per-conversation seq, one sequencer. No system-wide order is needed.
- _"Exactly-once?"_ — There is no exactly-once delivery over a network. At-least-once + idempotent receive (client_msg_id, seq) = once in the user's eyes.
- _"How will you deploy the gateways?"_ — Draining, slowly, and jitter on the client. And keep no logic in the gateway, so it needs fewer deploys.
- _"A group of 100,000 members?"_ — Fan-out on read instead of fan-out on write (the conversation's log once, members pull it themselves), receipts and presence off or batched. It is really a separate product (a channel).
- _"Offline users?"_ — The message stays in the store; the push notification (APNs/FCM) only wakes the phone, carrying no data (or very little); the phone wakes up and syncs. That is Lesson 11.5's notification system.

**In real production:** the most common incident is a reconnect storm after a gateway or a whole AZ outage, which brings down the auth or session store and makes the outage longer; the wrong heartbeat interval (mobile NAT silently cuts connections and the server thinks the user is online); relying on push and not storing, and the "my message was lost" tickets; and sorting by the client's clock, which shows strange orders only on some people's phones (wrong clocks) and is hard to reproduce.

---

## 3. Key Takeaway

- **A chat's cost is in connections, not messages:** 150 million open connections, 3 TB of memory, heartbeats 7 times the peak messages; and the real write load is fan-out and receipts (one message ≈ 20 events)
- **"Do we keep history" is 4,500 times** (14.6 PB vs 3.2 TB) — a product question that changes the kind of database. Presence, unless lazy, is the biggest cost (23 million/s)
- **The gateway only holds connections; the session registry says who is where.** Broadcast on one channel dies at this size (every gateway gets everything, 0.3% useful)
- **A reconnect storm without jitter is congestion collapse:** the cost of rejections eats all the capacity, and nobody is back in ten minutes. Spread from the first attempt (spread over 60 s, one attempt per client, and it finishes faster), draining, cheap rejection
- **Store-then-push: push is the optimization, sync is the truth.** With a stale registry, push alone loses 88%, the store zero — the only price is delay
- **At-least-once + dedupe = effectively once:** without retries 6% is lost, without dedupe 6% is shown twice. client_msg_id on the server, seq on the phone
- **Order comes from the conversation's sequencer, not from clocks:** with phone clocks 10% of answers are above the question, with arrival order 48% see different orders. The seq is also the language of sync and of receipt cursors

---

## 4. New Terms (Glossary)

| Term                                           | Meaning                                                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connection Gateway**                         | A server only for holding long-lived connections (TLS, WebSocket, heartbeats), with no business logic — so it is deployed less, and the logic can change every day in the stateless service behind it                 |
| **Session Registry**                           | A small `user → gateway` map (with a TTL, renewed on heartbeat) — the chat service does one lookup and sends straight to the right gateway; stale for a while when a gateway dies                                     |
| **Congestion Collapse (Reconnect Storm)**      | Demand so far above capacity that the cost of rejections uses up the capacity, nobody succeeds, and everyone's retries keep it worse — prevented with jitter, a spread first attempt, draining and cheap rejection    |
| **Store-then-Push (Inbox + Sync)**             | A message first to a durable store (the sender is acked then), then push as best-effort; the recipient fills gaps with "what is after seq N?" — a lost push costs only delay                                          |
| **Delivery Receipt (sent / delivered / read)** | Three separate events: durable on the server (✓), reached the recipient's phone (✓✓), the recipient read it (blue); stored as a cursor per conversation, not per message                                              |
| **Per-Conversation Sequence (Sequencer)**      | Each conversation's owner gives every message an increasing seq — causality and the same order for everyone guaranteed, without clocks; the language of sync and cursors; the price is one sequencer and its failover |
| **Presence**                                   | Whether a user is online now or when they last were — pushed to every contact it is a bigger load than delivery itself; lazy presence only to those with the chat open                                                |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. The product team wants one user's four devices (phone, tablet, two laptops) to work together, each with the full history, and reading on one device to show as "read" on the others. (a) What changes in the registry, cursors and fan-out? (b) Which of 1.2's numbers multiply, and by how much? (c) When someone logs into a new laptop, where will three years of history come from, and what does that do to the storage decision (inbox vs permanent log)?

2. On Monday morning one AZ's network is bad for 4 minutes, and the clients of 100 gateways (50 million connections) are cut off at once. The AZ comes back. (a) Going by this lesson's reconnect numbers, what do you expect if the clients come back spread over 60 s and the rest of the fleet's capacity is 20,000/s? (b) What will the load on the auth service and on the message store's sync be, and which breaks first? (c) Three preparations for this event that can be made today.

3. A community group with 10,000 members. 2,000 messages a day. (a) What does fan-out on write (writing to every member's inbox) cost per message, in the style of 1.2? (b) Which parts (receipts, presence, push notifications, typing indicators) will be switched off or changed in this group, and why? (c) Could this group's sequencer be a problem?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) **Registry:** from `user → gateway` to `(user, device) → gateway`; four entries for one user. **Fan-out:** one per delivery to each of the recipient's devices, **and to the sender's own other devices too** (when Alice sends from her phone, it has to show on her laptop as well). **Cursors:** at two levels — `delivered_seq` per device (how far each device has received, for sync), and `read_seq` per user (reading is done by a person, not a device). Reading on one device moves the user's `read_seq`, and that goes to the other devices as an event ("read up to seq 50 in conv X", so the notification badge clears).

(b) Connections: the four devices are not always online, but say online devices are 1.5 times on average: from 150 million to ~220 million, memory and gateways 1.5 times. Deliveries: multiplied by the recipient's device count, plus the sender's own devices — say 2–3 times. The "delivered" receipt per device, "read" per user. Heartbeats grow with connections.

(c) "Full history on a new device" means the server **has to keep** history — the inbox model (delete once delivered) no longer works, because delivery is now per device, and for a new device everything is "undelivered". Meaning from 1.2's 3 TB towards 14.6 PB. The alternative: the old device (the phone) owns the history, and the new device pulls history from the phone (which must be online) or from the user's own cloud backup. This is a product and privacy decision (with end-to-end encryption the server cannot read its copy, so either a separately encrypted copy per device or a handover from device to device). Either way, multi-device and "no history on the server" are hard to have together.

**Question 2:**

(a) 50 million connections ÷ 20,000/s = 2,500 s even in the best case, almost **42 minutes**. Spread over 60 s, demand is ~830,000/s, 40 times the capacity: the territory of part B's collapse (with a rejection cost of 0.2, the work of 160,000/s, 8 times the capacity). Meaning a 60 s spread is not enough at this size, and exponential backoff's jitter will work here, but over many minutes. The real lesson: the spread window has to match the fleet's capacity and the size of the event, not be a fixed number. And the time for "everyone is back" is counted in minutes, not seconds.

(b) On every reconnect: TLS (the gateway's CPU), auth (verifying a token — only CPU with a JWT, the auth service if it is called every time), a registry write (Redis), and a sync (a range scan in the store for each conversation). What usually breaks first is the **auth service** (if every reconnect calls it) and **sync** (four minutes of accumulated messages, a few dozen conversations per user, all at once). To cut the sync load: the client syncs only the recent conversations first, and the rest later or when a chat is opened.

(c) Preparations: (1) the client's reconnect window can be controlled from the server (a config, or the gateway says "come back after X s" on reconnect) — it can be widened to match the size of the event; (2) a resumption token for auth: a short-lived signed token the gateway can verify itself, without the auth service (like 10.5's JWT), and TLS session resumption, so the handshake is cheap; (3) a game day (10.3): deliberately cut off one AZ's gateways, and measure how long it takes for everyone to come back and which service goes red first. Plus admission control at the entrance (11.2's limiter, by connection rate) so rejection is cheap.

**Question 3:**

(a) Fan-out on write: 2,000 messages × 9,999 members = ~20 million inbox writes a day for one group, and two receipts from each = another 40 million. For one single group. With 1,000 such groups, 20 billion writes a day, equal to the whole system's messages. So in big groups, **fan-out on read**: the message only once in the conversation's log, and each member reads it from their own cursor. Pushes to online members (at the gateway) are still separate for each, but the durable write is once.

(b) **Read receipts:** off, or only a count ("2,310 people saw this", on the sender's request, counted from cursors), because sending each receipt to the sender is pointless and expensive. **Delivered receipts:** off. **Presence:** off, or only an approximate number like "85 online now". **Push notifications:** not on every message, by the user's preference (when mentioned, or a daily summary), otherwise 2,000 notifications a day. **Typing indicators:** off (among 10,000 people someone is always typing, and every "typing" is an event to everyone).

(c) 2,000 messages a day is one or two a minute on average, maybe a few a second at peak — nothing for a sequencer. The sequencer's problem is not the write rate but **the read fan-out**: going to 10,000 people on every new message, and pushing to the gateways of the few thousand of them who are online. That is not the sequencer's job, it is delivery's; so keep the sequencer (handing out seqs) and fan-out (sending) separate, so one big group's fan-out does not slow down handing out seqs for other conversations.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (three deterministic models and a real two-gateway chat with `ws`; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-11.3-chat-system/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.3-chat-system) — `npm install`, then `npm run estimate`, `npm run gateway`, `npm run delivery`, `npm run smoke`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out connections, memory, gateways, heartbeats, fan-out, receipts, storage and presence. `gateway` compares four routing paths, runs four reconnect policies after a gateway crash (with the cost of rejections), and counts the messages lost while the registry is stale. `delivery` measures three delivery policies on a network losing 3% of packets, and four ordering rules in a group. `smoke` runs 11 steps with two real WebSocket gateways, a `ChatCore` and three users.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the three models twice each and smoke three times, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **The estimation inputs are assumed** (DAU, messages, groups, 20 KB per connection, 500,000 connections per gateway), not measured. In the reconnect model the fleet's capacity (20,000/s) and the cost of a rejection (0.2) are assumed; where the collapse sets in depends on these two. The pub/sub part is a calculation, not a simulation; the behaviour of Redis Cluster's `PUBLISH` and `SPUBLISH` comes from the documentation. The network and clock models are synthetic. `smoke`'s registry and store are in memory, not Redis or a database; push notifications are only counted. WhatsApp's inbox design, Messenger's HBase and Discord's Cassandra/ScyllaDB come from their published writing, not verified here. **Not measured:** real memory per connection, a gateway's real capacity, mobile networks, APNs/FCM, multi-device, encryption.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `gateway`, write down: half a million clients on the "at once, and 1 s later on failure" policy, capacity 20,000/s — how long until everyone is back? Then run it and compare. Where was your mistake?

2. **Your own capacity:** `CAPACITY=50000 npm run gateway` and `CAPACITY=5000`. Which policies come out of collapse, and where is the line? Write the condition for collapse as one formula, in terms of the cost of a rejection and the demand.

3. **The price of heartbeats:** `HEARTBEAT_S=10 npm run estimate` and `HEARTBEAT_S=120`. For each, write one reason it could be wrong (battery/CPU vs being slow to catch dead connections, and NAT).

4. **Changing code:** the README's experiment 5 (typing indicators). Then in `src/chat.ts`, batch the "read" receipts for groups: instead of sending to the sender on every read, count "how many have read it" from the cursors when the sender asks. Add a step to `smoke` that shows how many frames were saved.

5. **The design part:** a "one-page design doc" for this chat, in Lesson 1.2's five steps: (a) the requirements, including the history decision; (b) five numbers and one decision from each; (c) the picture of gateways, registry, store and push; (d) the delivery and ordering rules, with a message's whole journey (from sending to the blue tick) step by step; (e) a runbook for an AZ outage: the reconnect window, admission control, and which three metrics you will watch.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges), 11.1, 11.2
Current: 11.3 — Case Study: Design a Chat System (WhatsApp-style)
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 — URL shortener (11.1);
2 — rate limiter service (11.2). Case study 3 — chat: 500 million DAU, 150 million open connections (3 TB), ~300
gateways, heartbeats 5 million/s (7 times the messages), fan-out 6.4, receipts 8.9 million/s. History: forever 14.6 PB
vs until delivered 3.2 TB (a product question). Gateways only hold connections; session registry (user → gateway) +
direct send (broadcast is 0.3% useful per gateway). Store-then-push: durable first, ack, then push best-effort, sync by
seq (with a stale registry, push alone loses 88%, the store 0). At-least-once + client_msg_id + seq (otherwise 6% lost
or 6% twice). Ordering by per-conversation seq (phone clocks put 10% of answers above the question, arrival order 48%
different). Receipts as cursors. Presence lazy. Reconnect: jitter from the first attempt (spread over 60 s, one
attempt per client), draining, cheap rejection — without jitter, congestion collapse (0% in 10 minutes). Message key
(conv_id, seq), sharded by conv_id.
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (vs Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence
Weak spots: [where you got stuck — write it yourself]
Next: 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style)
=======================
```

---

## 8. Next Step

Today's thread: **a real-time system's cost is in open connections, and its guarantees come from the store and the sequence, not from push.** The gateway only holds connections, the registry says who is where, and a message goes to a durable place first, then down the fast path. A push can be lost, can go twice, can go to the wrong place; seq and sync fix all of it. And the most dangerous moment for a stateful fleet is not one server's death, but the five minutes after it, when everyone wants to come back at once.

When you are ready, write `next` — we go to **Lesson 11.4: Design a News Feed (Facebook/Twitter-style)**. Today's question 3, the big group, comes back there as a whole system: when someone posts, how does it reach the feeds of their 10 million followers? Write into every follower's feed (fan-out on write), or stitch everyone's posts together at read time (fan-out on read)? Why doesn't the same answer work for a celebrity and an ordinary user, and where does ranking sit?
