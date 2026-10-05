# Lesson 11.3 — Case Study: Design a Chat System (WhatsApp-style)

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 7.4):** Retry এর সময় exponential backoff এর সাথে **jitter** কেন লাগে? Jitter ছাড়া হাজারটা client একই সময়ে ব্যর্থ হলে তাদের পরের চেষ্টাগুলো কখন আসে? আজ একটা gateway মরবে আর পাঁচ লাখ ফোন একসাথে ফিরতে চাইবে, আর দেখবে jitter ছাড়া দশ মিনিটেও একজনও ফেরে না।

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.6 (Stateful), Lesson 2.4 (WebSocket), Lesson 2.5 (Idempotency key), Lesson 3.4 (Health check, draining), Lesson 6.4 (Clock skew, ordering), Lesson 7.2 (Pub/sub), Lesson 7.4 (Retry, backoff, jitter), Lesson 10.3 (Blast radius), Lesson 11.1, 11.2

**তুমি এই lesson শেষে পারবে:**

1. একটা chat system এর আসল খরচ কোথায় সেটা সংখ্যা দিয়ে বলতে পারবে: খোলা connection, heartbeat, fan-out আর receipt, আর "server এ history রাখব কিনা" এর মতো একটা product সিদ্ধান্ত storage কে কত গুণ বদলায়
2. 2.4 এর খোলা প্রশ্নের পূর্ণ উত্তর দিতে পারবে: লাখ লাখ WebSocket কয়েকশো gateway তে থাকলে একটা message কীভাবে ঠিক gateway তে পৌঁছায় (broadcast, user channel, session registry), আর একটা gateway মরলে reconnect storm কে congestion collapse থেকে কীভাবে বাঁচাবে
3. Delivery এর নিশ্চয়তা আর ক্রম নকশা করতে পারবে: "আগে store, তারপর push", ack আর retry, client_msg_id দিয়ে dedupe, conversation প্রতি seq দিয়ে ক্রম আর sync, আর sent/delivered/read এর টিক গুলো আসলে কী

**Tier:** 1 — Runnable Code (তিনটা deterministic model আর `ws` দিয়ে একটা আসল দুই-gateway chat; Docker লাগে না)

---

## ০. আজকের System

Interviewer:

> "WhatsApp এর মতো একটা chat app design করো। একজনের সাথে একজন, আর group। Message পাঠানো, পৌঁছানো, পড়ার টিক। Offline থাকলে পরে পাবে।"

আগের দুটো case study তে client জিজ্ঞেস করত, server উত্তর দিত। এবার প্রথমবার উল্টো: **server কে নিজে থেকে client কে খুঁজে বের করতে হয়।** Bob একটা message পাবে যখন সে কিছুই জিজ্ঞেস করেনি। তাই Bob এর ফোন থেকে একটা connection সবসময় খোলা থাকে (2.4 এর WebSocket), আর সেই connection একটা নির্দিষ্ট server এর সাথে বাঁধা (1.6 এর stateful)।

2.4 এ একটা প্রশ্ন খোলা রেখেছিলাম: "WebSocket কে horizontal scale করবে কীভাবে?" তখন উত্তর ছিল এক লাইনের: "একটা shared pub/sub layer লাগে।" আজ সেই লাইনটা সংখ্যা দিয়ে পরীক্ষা করব, আর দেখব এটা কোন মাপে ভাঙে। Interviewer এর follow-up গুলো এরকম:

- "Alice একটা server এ, Bob আরেকটায়। Message টা Bob এর server কীভাবে খুঁজে পায়?"
- "একটা server এ পাঁচ লাখ connection, server টা মরল। কী হয়?"
- "Bob এর ফোন সাবওয়েতে, network আসছে যাচ্ছে। Message হারায় না, দুবার আসে না, কীভাবে নিশ্চিত করবে?"
- "Group এ দুজন একসাথে লিখল। সবাই কি একই ক্রমে দেখবে?"
- "দুটো নীল টিক মানে ঠিক কী, আর কতগুলো লেখা?"

---

## ১. Theory

### ১.১ Step 1 — Requirement

```
প্রশ্ন                                     ধরে নিলাম
কত user?                                   ৫০ কোটি DAU, peak এ ৩০% online
কী ধরনের chat?                             ১:১ আর group (গড়ে ২০ জন, সর্বোচ্চ কয়েকশো); broadcast channel (লাখ সদস্য) আজ না
কী পাঠানো যায়?                             text; ছবি আর video 8.2 এর presigned upload এর পথে, এখানে শুধু তার link
Receipt?                                   sent ✓, delivered ✓✓, read (নীল ✓✓)
Offline?                                   হ্যাঁ — ফোনে ফিরলে সব পাবে, push notification সহ
History?                                   **প্রশ্নটা জিজ্ঞেস করো** (১.২ দেখো)
Presence ("online", "last seen")?           হ্যাঁ, কিন্তু সস্তায়
End-to-end encryption?                     scope এর বাইরে (একটা লাইনে বলো, নিচে)
```

**Non-functional:** message ক্রমে আসবে, হারাবে না, দুবার দেখাবে না; পাঠানো থেকে পৌঁছানো (দুজনই online) p99 কয়েকশো ms; একটা server মরলে কয়েক মিনিটে সবাই ফেরে; ফোনের battery আর data কম খরচ।

End-to-end encryption এর এক লাইন: message ফোনে encrypt হয়, server শুধু খাম বয়ে নেয়, খোলে না। নকশার উপর এর প্রভাব বড়: server text পড়তে পারে না, তাই server-side search বা spam filter text দেখে চলে না, আর একজনের একাধিক device মানে প্রতিটা device এর জন্য আলাদা encrypt করা কপি। আজকের নকশা এই খামের ভেতরে কী আছে তা নিয়ে মাথা ঘামায় না, তাই encryption পরে যোগ করা যায়।

### ১.২ Step 2 — Estimation: খরচ কোথায়

`npm run estimate`:

```
── Part A — connections: 500 million DAU, 30% online at peak ──
connections open at once                                   150 million   each is a TCP + TLS + WebSocket
connection memory (20.0 KB each, approximate)                   3.0 TB   kernel buffers, TLS, app state
gateway servers (500,000 connections each)                         300   when one dies, this many people reconnect at once
heartbeats / s (every 30 s)                                  5,000,000   more than the messages

── Part B — messages: 40 a day per user, 30% in groups (20 people on average) ──
messages sent / s (peak, 3×)                                   694,444
deliveries per message (fan-out)                                   6.4   each group member is a separate delivery
delivery / s (peak)                                          4,444,444
receipt (delivered + read) / s (peak)                        8,888,889   two from each delivery — more writes than messages

── Part C — storage: 200 B per message ──
all history forever (10 years, one copy)                       14.6 PB   history on the server (like Messenger/Slack)
only undelivered messages (deleted once delivered)              3.2 TB   50% of deliveries wait 6 hours on average
difference                                                 4,562 times   a product decision, not a storage one

── Part D — presence: 200 contacts on average, online ↔ offline 20 times a day ──
push to every contact / s                                   23,148,148   presence storm
only those with the chat open (1%) / s                         231,481   lazy presence: only if subscribed
```

1. **আসল খরচ connection এ।** ১৫ কোটি খোলা connection, ৩ TB memory শুধু তাদের ধরে রাখতে, ৩০০টা gateway। আর heartbeat (connection বেঁচে আছে কিনা দেখার ছোট ping) সেকেন্ডে ৫০ লাখ, peak এর message এর **৭ গুণ**। Heartbeat এর ব্যবধান একটা trade-off: ছোট হলে মরা connection দ্রুত ধরা পড়ে, কিন্তু ফোনের battery আর server এর CPU যায়; বড় হলে NAT আর mobile network এর মাঝের যন্ত্র চুপচাপ connection কেটে দেয়, আর server অনেকক্ষণ টের পায় না।
2. **লেখার আসল চাপ fan-out আর receipt।** একটা পাঠানো message গড়ে ৬.৪টা delivery (group এর প্রতিটা সদস্য আলাদা), আর প্রতিটা delivery থেকে দুটো receipt। একটা message মানে প্রায় ২০টা ঘটনা। আর group এর আকার ২০০ হলে (experiment) প্রতি message এ ৬০টা delivery, সেকেন্ডে ৮ কোটি receipt। তাই বড় group এ "কে কে পড়েছে" এর receipt আলাদা করে সামলাতে হয় (১.৭)।
3. **History এর প্রশ্নটা ৪,৫০০ গুণ।** Server যদি সব message চিরকাল রাখে (একটা নতুন ফোনে login করলে পুরনো সব chat, Messenger বা Slack এর মতো), দশ বছরে ~১৫ PB। যদি server শুধু **পৌঁছানো পর্যন্ত** রাখে আর ফোন নিজের history রাখে (WhatsApp এর আদি নকশা এরকম বলে প্রকাশিত, backup ফোনের দিকে), তাহলে যেকোনো মুহূর্তে শুধু অপেক্ষায় থাকা message, ~৩ TB। এটা interviewer কে জিজ্ঞেস করার প্রশ্ন, কারণ এর উত্তর database এর ধরন বদলে দেয়: একটা ছোট, দ্রুত queue এর মতো inbox, নাকি একটা বিশাল, চিরকালের log।
4. **Presence সস্তায় না করলে সবচেয়ে বড় খরচ।** কেউ online বা offline হলে তার ২০০ contact কে জানানো: সেকেন্ডে ২.৩ কোটি event, delivery এর ৫ গুণ, আর প্রায় কেউ দেখে না। **Presence** — একজন user এখন online কিনা বা শেষ কখন ছিল, তার তথ্য। সস্তা পথ (lazy presence): presence শুধু তখনই পাঠানো যখন কেউ সেই user এর chat খোলা রেখেছে (subscribe করেছে), আর "last seen" শুধু chat খুললে পড়া হয়। চাপ ১০০ ভাগের এক ভাগ।

### ১.৩ API আর data model

**Client ↔ gateway (WebSocket এর উপর frame, Zod দিয়ে parse):**

```
client → server                                         server → client
send      { conv, clientMsgId, text }                   ack      { clientMsgId, seq, duplicate }
delivered { conv, seq }                                 message  { conv, seq, from, clientMsgId, text }
read      { conv, seq }                                 receipt  { conv, seq, by, kind: delivered | read }
sync      { cursors: { conv → শেষ পাওয়া seq } }         synced   { messages[] }
```

**Data:**

```
conversation(id, members[])
message(conv_id, seq, from, client_msg_id, body, created_at)     PRIMARY KEY (conv_id, seq)
  UNIQUE (conv_id, from, client_msg_id)                          ← dedupe
cursor(user_id, conv_id, delivered_seq, read_seq)                ← কে কতদূর পেয়েছে আর পড়েছে
session(user_id → gateway_id, connected_at)                      ← registry, Redis এ, TTL সহ
```

Message এর key `(conv_id, seq)`: একটা conversation এর সব message পাশাপাশি, seq এর ক্রমে, আর "conv X এর seq ৪১ এর পরে সব" একটা range scan। Sharding (5.8) `conv_id` ধরে, যাতে একটা conversation এক জায়গায় থাকে আর তার seq একজন দেয় (১.৭)। এই আকারের data (একটা partition key, তার ভেতরে ক্রম, প্রচুর লেখা) এর জন্য wide-column store প্রচলিত: Facebook Messenger এর HBase আর Discord এর Cassandra (পরে ScyllaDB) এর কথা তাদের প্রকাশিত লেখায় আছে। Postgres এ `conv_id` ধরে shard করেও একই নকশা চলে।

### ১.৪ Step 3 — High-level design, আর কোন gateway কে পাঠাব

```
 ফোন ═══ WebSocket ═══ [gateway × 300] ──► [chat service] ──► [message store (conv_id, seq)]
  ▲                       │    ▲                │    │
  │                       │    │                │    └──► [push service] ──► APNs / FCM (offline হলে)
  │                       ▼    │                ▼
  │               [session registry]      [receipt/cursor store]
  │               user → gateway (Redis)
  └──── sync: "conv X এর seq N এর পরে" ◄── gateway ◄── store
```

**Connection Gateway** — শুধু connection ধরে রাখার server: TLS, WebSocket, heartbeat, আর frame কে chat service এ পাঠানো আর chat service এর frame কে ঠিক socket এ লেখা। এর ভেতরে কোনো business logic নেই। কারণ: gateway এর deploy মানে লাখ লাখ connection কাটা (১.৫), তাই এটা যত কম বদলায় তত ভালো। Logic থাকে পেছনের stateless chat service এ, যেটা প্রতিদিন deploy করা যায় কোনো connection না কেটে।

এখন 2.4 এর প্রশ্ন: chat service জানে message টা Bob এর জন্য। Bob কোন gateway তে? `npm run gateway` অংশ ক, peak এ সেকেন্ডে ৪৪ লাখ delivery, ৩০০টা gateway:

```
path                                                                      received/s per gateway     useful  op/s in the middle layer
broadcast to every gateway (one pub/sub channel)                                       4,444,444       0.3%             1,333,333,200
a channel per user, Redis Cluster's old PUBLISH (spread over 10 nodes)                    14,815     100.0%                44,444,440
a channel per user, sharded pub/sub (SPUBLISH)                                            14,815     100.0%                 4,444,444
session registry (user → gateway) + direct send                                           14,815     100.0%                 8,888,888
```

- **2.4 এর "একটা shared pub/sub" এর সবচেয়ে সরল রূপ, একটা channel এ সব কিছু, এই মাপে মরে।** প্রতিটা gateway প্রতিটা delivery পায় (৪৪ লাখ/s), যার ০.৩% তার নিজের। মাঝের স্তরে সেকেন্ডে ১৩৩ কোটি। ছোট মাপে (কয়েকটা server) এটা ঠিক উত্তর, আর 2.4 এ সেই মাপের কথাই ছিল।
- **User প্রতি একটা channel:** প্রতিটা gateway তার connected user দের channel এ subscribe করে। Gateway শুধু নিজেরটা পায়। কিন্তু একটা ফাঁদ: Redis Cluster এর পুরনো `PUBLISH` একটা message কে cluster এর **সব node এ** ছড়ায় (cluster জুড়ে pub/sub এভাবেই কাজ করত), তাই মাঝের স্তরে node সংখ্যার গুণ। Redis 7 এর sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`) channel কে একটা shard এ রাখে।
- **Session Registry** — `user → gateway` এর একটা ছোট map (Redis এ, TTL সহ, heartbeat এ নবায়ন)। Chat service delivery এর আগে একটা lookup করে, তারপর সরাসরি সেই gateway কে পাঠায় (RPC বা gateway প্রতি একটা queue)। মাঝের স্তরে প্রতি delivery তে দুটো op। পরিষ্কার আর debug করা সহজ ("Bob এখন কোথায়?" একটা প্রশ্ন), আর এই নকশায় এটাই।

দুটো পথেরই একটা দুর্বলতা আছে, যা পরের অংশের কেন্দ্র: **registry পুরনো হতে পারে।** Bob এর gateway মরে গেছে, কিন্তু registry তখনও বলছে "gw2"।

### ১.৫ একটা gateway মরল: reconnect storm

একটা gateway এ পাঁচ লাখ connection। Gateway টা crash করল (বা deploy এর জন্য বন্ধ হলো)। পাঁচ লাখ ফোন প্রায় একই মুহূর্তে জানতে পারে, আর সবাই ফিরতে চায়। প্রতিটা ফেরা মানে TCP, TLS, auth, registry লেখা, আর sync। বাকি fleet এর মোট ক্ষমতা ধরো সেকেন্ডে ২০,০০০ এমন handshake। আর একটা বাস্তব খুঁটিনাটি: **প্রত্যাখ্যাত চেষ্টাও বিনা মূল্যে না।** Server overload বলে না বলার আগে TCP আর TLS এর কিছু কাজ হয়ে যায়; ধরো একটা পূর্ণ handshake এর ০.২ ভাগ। `npm run gateway` অংশ খ:

```
policy                                          attempts/s (peak)  total attempts  per client  50% back  99% back        all back
at once, and again at once on failure                   5,000,000   3,000,000,000       6,000         —         —  0% (in 10 min)
at once, and exactly 1 s later on failure               5,000,000     300,000,000         600         —         —  0% (in 10 min)
exponential backoff, no jitter                          5,000,000       7,500,000          15         —         —  0% (in 10 min)
first one spread over 0–10 s + full jitter                251,980       3,304,742           7   30.47 s   76.55 s         89.40 s
best possible: 500,000 ÷ 20,000/s = 25.00 s.
```

**Spaced repetition এর উত্তর:** jitter ছাড়া একসাথে ব্যর্থ হওয়া client রা একসাথেই আবার চেষ্টা করে, কারণ সবার হিসাব একই। Backoff শুধু ঢেউ গুলোর মাঝের ফাঁক বাড়ায়, ঢেউ এর উচ্চতা কমায় না। Jitter (এলোমেলো দেরি) ঢেউ কে সময়ে ছড়িয়ে দেয়।

আর এখানে তার চরম রূপ: **Congestion Collapse (reconnect storm)** — চাহিদা ক্ষমতার এত উপরে যে প্রত্যাখ্যানের খরচেই সব ক্ষমতা যায়, আর একটাও সফল হয় না; সবাই আবার চেষ্টা করে, আর অবস্থা নিজে থেকে কখনো ভালো হয় না। পাঁচ লাখ চেষ্টার ০.২ ভাগ = এক লাখ handshake এর সমান কাজ, এক সেকেন্ডে ক্ষমতা ২০,০০০। প্রথম তিনটা নীতিতে **দশ মিনিটেও একজনও ফেরে না।** Backoff আছে, কিন্তু jitter নেই: পাঁচ লাখ ফোন ১ s পরে একসাথে, ২ s পরে একসাথে, ৪ s পরে একসাথে, প্রতিবার একই দেয়ালে। Experiment ১: প্রত্যাখ্যান ০.০২ এ নামালেও (দশ গুণ সস্তা) collapse থাকে।

চতুর্থ নীতিতে সবাই ৮৯ s এ, তাত্ত্বিক সেরা ২৫ s এর কাছাকাছি মাপে। আর experiment ২ একটা অপ্রত্যাশিত জিনিস দেখায়: প্রথম চেষ্টা ১০ s এর বদলে **৬০ s** এ ছড়ালে client প্রতি ঠিক একটা চেষ্টা, কোনো প্রত্যাখ্যান নেই, আর ৯৯% ফেরে **৫৯ s এ, ১০ s এ ছড়ানোর ৭৬ s এর আগে।** ধীরে শুরু করা দ্রুত শেষ করে, কারণ প্রত্যাখ্যানের অপচয় নেই।

তাই gateway এর নকশায়: client এর reconnect এ প্রথম চেষ্টা থেকেই jitter (৩০-৬০ s এ ছড়ানো), exponential backoff এর সাথে full jitter, আর server এর দিক থেকে সস্তা প্রত্যাখ্যান (load balancer এ, TLS এর আগে, connection এর হার ধরে, 11.2 এর limiter)। আর পরিকল্পিত বন্ধে (deploy) ঝাঁপ না দিয়ে **draining** (3.4): gateway নতুন connection নেওয়া বন্ধ করে, আর পুরনোগুলোকে কয়েক মিনিট ধরে একটু একটু করে "অন্য জায়গায় যাও" বলে। Deploy এ কোনো storm হয় না, শুধু crash এ।

**Registry পুরনো থাকার সময়টা।** অংশ গ: এই পাঁচ লাখ জনের কাছে সেকেন্ডে ~১৪,৮০০টা message আসছে, আর registry তখনও মরা gateway দেখায় যতক্ষণ না তারা অন্য জায়গায় ফেরে:

```
policy                                           push only: lost  store first, then push: lost  delay p50  delay p99
at once, and again at once on failure             444,444 (100%)                             0   > 10 min   > 10 min
first one spread over 0–10 s + full jitter          391,250 (88%)                             0   16.82 s   64.77 s
```

যদি message শুধু push করা হয় (registry দেখে gateway কে পাঠানো, ব্যস), প্রথম ৩০ সেকেন্ডের ৮৮% হারায়। যদি **আগে store, তারপর push**, কিছুই হারায় না: message store এ টেকসই, push টা শুধু একটা দ্রুত পথ, আর ফোন ফিরে এসে sync এ যা পায়নি তা নেয়। দাম শুধু দেরি (p99 ৬৫ s, ফোন ফেরার সময়)। এটা এই নকশার সবচেয়ে গুরুত্বপূর্ণ নিয়ম:

**Store-then-Push (Inbox + Sync)** — Message আগে টেকসই store এ লেখা (sender কে ack তখনই), তারপর online প্রাপককে push করা best-effort। প্রাপক যেকোনো সময় "এই conversation এ seq N এর পরে কী আছে?" জিজ্ঞেস করে সব ফাঁক পূরণ করতে পারে। Push হারালে, দুবার গেলে, বা registry ভুল হলে ক্ষতি শুধু দেরি, কখনো হারানো না। Push হলো optimization, sync হলো সত্য।

### ১.৬ Deep dive — একবারই পৌঁছানো: ack, retry, dedupe

Mobile network এ packet হারায়, connection কাটে, ফোন tunnel এ ঢোকে। `npm run delivery` অংশ ক: A → server → B, প্রতিটা packet ৩% হারায়:

```
policy                                          B missed it  B saw it twice       stored twice  packet / message
send once, no ack (at-most-once)                     5.94%          0.00%              0.00%             3.94
resend if no ack (at-least-once)                     0.00%          5.80%              2.92%             4.31
resend + drop by client_msg_id and seq               0.00%          0.00%              0.00%             4.25
```

- **Retry ছাড়া প্রায় ৬% হারায়** (দুটো hop, প্রতিটায় ৩%)। Experiment ৩: ১০% হারানো network এ ১৯%।
- **Retry আছে, dedupe নেই:** কিছুই হারায় না, কিন্তু ৫.৮% দুবার দেখায়। কেন: A এর message server এ পৌঁছেছিল, কিন্তু server এর ack টা হারাল। A ভাবল যায়নি, আবার পাঠাল, server দুবার জমা রাখল। একই ঘটনা server → B তে।
- **Retry + dedupe:** শূন্য হারানো, শূন্য দুবার। দুই hop এ দুটো আলাদা চাবি: server এ **client_msg_id** (ফোন প্রতিটা message এর জন্য একটা id বানায় আর retry তে সেটাই পাঠায়; server `UNIQUE (conv, from, client_msg_id)` দেখে আগের seq ফেরত দেয়, 2.5 এর idempotency key হুবহু), আর ফোনে **seq** (একই seq দুবার এলে একটা)। At-least-once + idempotent = effectively once, 7.4 এর কথা।

**Delivery Receipt (sent / delivered / read)** — প্রতিটা টিক একটা আলাদা ঘটনা আর একটা আলাদা লেখা: **sent ✓** = server টেকসই ভাবে জমা রেখেছে (sender এর ack, client_msg_id এর উত্তর); **delivered ✓✓** = প্রাপকের ফোন message টা পেয়ে নিজে থেকে একটা ack পাঠিয়েছে; **read (নীল)** = প্রাপক chat টা খুলেছে। শেষ দুটো sender এর কাছে receipt হিসেবে ফেরত যায়, আর server এ `cursor` এ জমা থাকে (প্রতি message এ না, প্রতি conversation এ "কতদূর": `delivered_seq`, `read_seq`; একটা cursor সব আগের message কে ঢেকে দেয়)।

Cursor এর ধারণা receipt এর চাপ কমায়: Bob দশটা message একসাথে পড়লে একটা "read পর্যন্ত seq ৫০", দশটা আলাদা না। আর বড় group এ (২০০ জন) প্রতিটা সদস্যের প্রতিটা receipt sender কে আলাদা করে পাঠানো ১.২ এর ৮ কোটি/s; তাই group এ receipt জমিয়ে, কয়েক সেকেন্ড পরপর, বা শুধু যখন sender "info" খোলে তখন পড়া।

### ১.৭ Deep dive — ক্রম: কে ঠিক করে কোনটা আগে

Group এ দুটো সমস্যা: (১) **কার্যকারণ**: C একটা প্রশ্ন দেখে উত্তর দিল; কারো screen এ যেন উত্তর প্রশ্নের উপরে না আসে। (২) **মিল**: দুজন প্রায় একসাথে লিখল; সবাই যেন একই ক্রমে দেখে, নইলে কথোপকথনের অর্থ মানুষ ভেদে বদলায়। অংশ খ, ৫ জনের group, ফোনের ঘড়ি ±৫০০ ms (২% ফোন মিনিট খানেক ভুল), তিনটা chat server (±৩০ ms):

```
order                                         answer above question   members see different orders
sorted by the sending phone's clock                          10.21%                          0.00%
shown in the order they arrived                               0.41%                         47.59%
sorted by the chat server's clock                             0.00%                          0.00%
per-conversation seq (one sequencer)                          0.00%                          0.00%
```

- **ফোনের ঘড়ি:** সবাই একই ক্রম দেখে (একই timestamp), কিন্তু **১০% উত্তর প্রশ্নের উপরে।** 6.4 এর কথা: ঘড়ি বিশ্বাসযোগ্য না, আর ফোনের ঘড়ি সবচেয়ে কম। যার ফোন দুই মিনিট পিছিয়ে, তার প্রতিটা উত্তর উপরে উঠে যায়।
- **পৌঁছানোর ক্রম:** কার্যকারণ প্রায় ঠিক (উত্তর পাঠানো হয় প্রশ্ন পৌঁছানোর পরে), কিন্তু একসাথে লেখা দুটো message এ **৪৮% ক্ষেত্রে সদস্যরা আলাদা ক্রম দেখে,** কারণ প্রতিটা সদস্যের কাছে দুটো message আলাদা পথে আসে।
- **Server এর ঘড়ি:** এখানে দুটোই শূন্য, কারণ মানুষের উত্তর দিতে সেকেন্ড লাগে আর server এর ঘড়ির ভুল কয়েক ms। Experiment ৪: উত্তর ২০ ms এ এলে (একটা bot) server এর ঘড়িতেও ০.০৯%। "প্রায় সবসময় ঠিক", নিশ্চিত না।
- **Per-Conversation Sequence (Sequencer)** — প্রতিটা conversation এর একজন মালিক (shard বা partition এর leader) প্রতিটা নতুন message কে একটা বাড়তে থাকা সংখ্যা দেয়: ১, ২, ৩... সবাই seq ধরে সাজায়, আর একটা ফাঁক দেখলে (৪১ এর পরে ৪৩) অপেক্ষা করে বা sync করে। কার্যকারণ নিশ্চিত (উত্তর server এ পৌঁছায় প্রশ্নের পরে, তাই বড় seq), আর সবাই একই ক্রম দেখে, দুটোই নির্মাণ থেকে, ঘড়ি থেকে না।

Seq এর আসল মূল্য শুধু ক্রম না: এটা **sync এর ভাষা।** "conv X এ আমি ৪১ পর্যন্ত পেয়েছি" এর মানে অস্পষ্ট না, timestamp এর মতো ("১২:০৩:০৫ এর পরে" — একই মিলিসেকেন্ডে দুটো হলে?)। Cursor (১.৬) আর sync (১.৫) এই এক সংখ্যার উপরে দাঁড়ায়। দাম: একটা conversation এর সব লেখা একজন sequencer এর মধ্য দিয়ে যায়, তাই সেটা একটা গতির সীমা (একটা group এ সেকেন্ডে কয়েক হাজার message, যেটা মানুষের group এর জন্য কখনো সমস্যা না), আর তার failover এ 6.2 এর consensus লাগে, যাতে দুজন একই seq না দেয়। Seq conversation এর ভেতরে, পুরো system এ না: দুটো আলাদা conversation এর মধ্যে ক্রমের কোনো অর্থ নেই, তাই কোনো global sequencer লাগে না।

### ১.৮ একটা আসল chat: দুটো gateway, registry, store

`npm run smoke` উপরের সব নিয়ম এক জায়গায় চালায়: দুটো আসল WebSocket gateway (`ws`), একটা `ChatCore` (registry, conversation এর log আর seq, dedupe, fan-out, receipt, sync), তিনজন user:

```
#   step                                                            result
1   alice → bob: "hi"                                               ack seq 1 (✓ durable on the server)
2   bob received it (on gw2, via the registry)                      1:hi
3   bob's phone sends "delivered" automatically                     alice got receipt: delivered (✓✓)
4   bob read it                                                     alice got receipt: read (blue ✓✓)
5   alice resent the same client_msg_id (as if the ack was lost)    ack seq 1, duplicate: true; 1 at bob
6   alice → team, 3 messages, carol offline                         bob: 1:standup?, 2:at 10, 3:ok; offline push: 3
7   carol online (gw1), sync { }                                    1:standup?, 2:at 10, 3:ok
8   gw2 crashes; alice → bob 2 messages (registry still gw2)        stale route: 2, 3 in dm in the store
9   bob reconnects on gw1, sync { dm: 1, team: 3 }                  2:you there?, 3:call me
10  alice and bob in team at the same time                          carol sees: 4:me first, 5:no, me; seq: 4, 5
11  the core's counts                                               stored 8, duplicate 1, other gateway 9, same gateway 8
```

- ধাপ ১-৪: তিনটা টিক, তিনটা আলাদা ঘটনা। Alice gw1 এ, Bob gw2 এ; registry দেখে message আর receipt দুই দিকে যায়।
- ধাপ ৫: ack হারানোর পরে retry, একই client_msg_id। Server আগের seq ফেরত দেয়, Bob একটাই পায়।
- ধাপ ৬-৭: Carol offline, তিনটা push notification গোনা হলো; সে এসে একটা sync এ তিনটাই seq এর ক্রমে পেল।
- ধাপ ৮-৯: gw2 মরল, registry তখনও gw2 দেখায়, দুটো push "stale route" এ ব্যর্থ। কিন্তু message store এ আছে। Bob gw1 এ ফিরে নিজের cursor দিয়ে sync করল, ঠিক যে দুটো পায়নি সেগুলো পেল।
- ধাপ ১০: দুজন একসাথে লিখল; sequencer ৪ আর ৫ দিল, আর Carol সেই ক্রমে দেখে।

### ১.৯ Step 5 — Trade-off আর wrap-up

**চূড়ান্ত নকশা:**

- **Connection:** ~৩০০ gateway, শুধু connection ধরে, কোনো logic না; heartbeat ৩০ s এর আশেপাশে; client এ reconnect প্রথম চেষ্টা থেকে jitter (৩০-৬০ s এ ছড়ানো) + full jitter backoff; deploy এ draining; LB এ সস্তা প্রত্যাখ্যান।
- **Routing:** session registry (Redis, TTL, heartbeat এ নবায়ন) + gateway কে সরাসরি পাঠানো।
- **Delivery:** store-then-push; sender এর ack store এর পরে; client_msg_id দিয়ে dedupe; push best-effort; offline হলে push notification; sync seq ধরে।
- **ক্রম:** conversation প্রতি seq, conversation এর shard এর leader দেয়; client seq ধরে সাজায় আর ফাঁক দেখলে sync।
- **Receipt:** cursor (`delivered_seq`, `read_seq`) প্রতি conversation এ, প্রতি message এ না; বড় group এ জমিয়ে।
- **Presence:** lazy, শুধু খোলা chat এ।
- **Storage:** product এর উত্তর অনুযায়ী — পৌঁছানো পর্যন্ত inbox (TB) বা চিরকালের log (PB), `(conv_id, seq)` key, `conv_id` ধরে shard।

> **Trade-off Table — chat এর বড় সিদ্ধান্ত**

| সিদ্ধান্ত | বেছে নিলাম                          | বিকল্প                   | কী দিলাম                                      | কী পেলাম                                                     |
| --------- | ----------------------------------- | ------------------------ | --------------------------------------------- | ------------------------------------------------------------ |
| Routing   | Session registry + সরাসরি           | একটা channel এ broadcast | Registry একটা নতুন জিনিস, পুরনো হতে পারে      | Gateway শুধু নিজেরটা পায় (broadcast এ ০.৩% কাজের)           |
| Delivery  | Store-then-push + sync              | শুধু push                | প্রতিটা message এ একটা টেকসই লেখা আগে         | Registry ভুল বা gateway মরলেও শূন্য হারানো (শুধু push এ ৮৮%) |
| Retry     | At-least-once + client_msg_id       | At-most-once             | Dedupe এর index আর state                      | শূন্য হারানো, শূন্য দুবার (না হলে ৬% হারায় বা ৬% দুবার)     |
| ক্রম      | Conversation প্রতি seq              | ফোনের বা server এর ঘড়ি  | একটা sequencer, তার failover এ consensus      | কার্যকারণ আর মিল নিশ্চিত; sync এর স্পষ্ট ভাষা                |
| Reconnect | Jitter প্রথম চেষ্টা থেকে + draining | সাথে সাথে retry          | Crash এর পরে কিছু ফোন ১ মিনিট পর্যন্ত offline | Collapse নেই (jitter ছাড়া ১০ মিনিটেও কেউ ফেরে না)           |
| Presence  | Lazy (শুধু খোলা chat)               | সব contact কে push       | "Online" কিছুটা দেরিতে বা chat খুললে তবেই     | চাপ ১০০ ভাগের এক ভাগ                                         |

**কী আগে ভাঙবে:** বড় group আর channel (হাজার বা লাখ সদস্য) — প্রতি message এ fan-out এর লেখা অসম্ভব হয়, তখন fan-out on read (11.4 এর news feed এর মূল প্রশ্ন); একজনের একাধিক device (প্রতিটা device এর আলাদা cursor আর আলাদা connection, encryption এ আলাদা কপি); আর multi-region (10.8) — একটা conversation এর sequencer একটা region এ, অন্য মহাদেশের সদস্যের লেখায় একটা দূরের round trip।

---

## ২. Interview Angle

Chat system interview এর সবচেয়ে প্রচলিত "real-time" প্রশ্ন, আর এখানে interviewer দেখে তুমি stateful system বোঝো কিনা। ভালো উত্তরের আকৃতি:

1. **Requirement এ history এর প্রশ্ন।** Server এ চিরকাল (PB) নাকি পৌঁছানো পর্যন্ত (TB)। আর group এর আকারের সীমা।
2. **সংখ্যা।** Connection আর তাদের memory, gateway এর সংখ্যা, heartbeat, fan-out আর receipt। দেখাও যে চাপ message এ না।
3. **Gateway আর routing।** Logic ছাড়া gateway, session registry, আর broadcast কেন এই মাপে ভাঙে।
4. **Delivery।** Store-then-push, ack, client_msg_id, seq, sync। তিনটা টিকের মানে।
5. **ব্যর্থতা।** একটা gateway মরলে: registry পুরনো (store বাঁচায়), reconnect storm (jitter, draining, সস্তা প্রত্যাখ্যান)।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Redis pub/sub দিয়ে সব gateway কে জানালেই তো হয়?"_ — একটা channel এ সব কিছু: প্রতিটা gateway সব delivery পায়, ৩০০ gateway এ ০.৩% কাজের। User প্রতি channel ঠিক আছে, কিন্তু Redis Cluster এর পুরনো PUBLISH সব node এ ছড়ায়; sharded pub/sub বা registry।
- _"Message এর ক্রম কীভাবে?"_ — Timestamp না (ফোনের ঘড়িতে ১০% উত্তর উপরে)। Conversation প্রতি seq, একজন sequencer। পুরো system এর ক্রম লাগে না।
- _"Exactly-once?"_ — Network এ exactly-once delivery নেই। At-least-once + idempotent receive (client_msg_id, seq) = ব্যবহারকারীর চোখে একবার।
- _"Gateway deploy করবে কীভাবে?"_ — Draining, ধীরে ধীরে, আর client এ jitter। আর gateway এ logic রেখো না, যাতে deploy কম লাগে।
- _"Group এ ১ লাখ সদস্য?"_ — Fan-out on write এর বদলে fan-out on read (conversation এর log একবার, সদস্যরা নিজে টেনে নেয়), receipt আর presence বন্ধ বা জমানো। এটা আসলে একটা আলাদা product (channel)।
- _"Offline user?"_ — Store এ থাকে; push notification (APNs/FCM) শুধু জাগায়, data বয় না (বা সামান্য); ফোন জেগে sync করে। পরের lesson (11.5) এর notification system।

**Production এ বাস্তবে:** সবচেয়ে প্রচলিত ঘটনা হলো একটা gateway বা পুরো একটা AZ এর বিভ্রাটের পরে reconnect storm, যেটা auth বা session store কে ফেলে দেয় আর বিভ্রাটকে লম্বা করে; heartbeat এর ভুল ব্যবধান (mobile NAT চুপচাপ connection কাটে আর server ভাবে user online); push এর উপর ভরসা করে store না করা, আর "message হারিয়েছে" এর ticket; আর client এর ঘড়ি ধরে সাজানো, যা শুধু কিছু মানুষের ফোনে (ভুল ঘড়ি) অদ্ভুত ক্রম দেখায় আর reproduce করা কঠিন।

---

## ৩. Key Takeaway

- **Chat এর খরচ connection এ, message এ না:** ১৫ কোটি খোলা connection, ৩ TB memory, heartbeat peak এর message এর ৭ গুণ; আর লেখার আসল চাপ fan-out আর receipt (একটা message ≈ ২০টা ঘটনা)
- **"History রাখব কিনা" ৪,৫০০ গুণ** (১৪.৬ PB বনাম ৩.২ TB) — একটা product এর প্রশ্ন যা database এর ধরন বদলায়। Presence কে lazy না করলে সবচেয়ে বড় খরচ (২.৩ কোটি/s)
- **Gateway শুধু connection ধরে; session registry বলে কে কোথায়।** একটা channel এ broadcast এই মাপে মরে (প্রতিটা gateway সব পায়, ০.৩% কাজের)
- **Reconnect storm এ jitter ছাড়া congestion collapse:** প্রত্যাখ্যানের খরচ সব ক্ষমতা খায়, দশ মিনিটেও কেউ ফেরে না। প্রথম চেষ্টা থেকেই ছড়ানো (৬০ s এ ছড়ালে client প্রতি ১টা চেষ্টা, আর দ্রুত শেষ), draining, সস্তা প্রত্যাখ্যান
- **Store-then-push: push optimization, sync সত্য।** Registry পুরনো হলে শুধু push এ ৮৮% হারায়, store থেকে শূন্য — দাম শুধু দেরি
- **At-least-once + dedupe = effectively once:** retry ছাড়া ৬% হারায়, dedupe ছাড়া ৬% দুবার। Server এ client_msg_id, ফোনে seq
- **ক্রম আসে conversation এর sequencer থেকে, ঘড়ি থেকে না:** ফোনের ঘড়িতে ১০% উত্তর উপরে, পৌঁছানোর ক্রমে ৪৮% আলাদা। Seq sync আর receipt এর cursor এর ভাষাও

---

## ৪. নতুন Term (Glossary)

| Term                                           | অর্থ                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connection Gateway**                         | শুধু দীর্ঘস্থায়ী connection ধরে রাখার server (TLS, WebSocket, heartbeat), কোনো business logic ছাড়া — যাতে কম deploy হয়, আর logic পেছনের stateless service এ প্রতিদিন বদলানো যায়       |
| **Session Registry**                           | `user → gateway` এর ছোট map (TTL সহ, heartbeat এ নবায়ন) — chat service একটা lookup করে সরাসরি ঠিক gateway কে পাঠায়; gateway মরলে কিছুক্ষণ পুরনো থাকে                                    |
| **Congestion Collapse (Reconnect Storm)**      | চাহিদা ক্ষমতার এত উপরে যে প্রত্যাখ্যানের খরচেই ক্ষমতা শেষ, কেউ সফল হয় না, আর সবার retry অবস্থা আরও খারাপ রাখে — jitter, ছড়ানো প্রথম চেষ্টা, draining আর সস্তা প্রত্যাখ্যান দিয়ে ঠেকানো |
| **Store-then-Push (Inbox + Sync)**             | Message আগে টেকসই store এ (তখনই sender এর ack), তারপর push best-effort; প্রাপক "seq N এর পরে কী?" দিয়ে ফাঁক পূরণ করে — push হারালে ক্ষতি শুধু দেরি                                       |
| **Delivery Receipt (sent / delivered / read)** | তিনটা আলাদা ঘটনা: server এ টেকসই (✓), প্রাপকের ফোনে পৌঁছেছে (✓✓), প্রাপক পড়েছে (নীল); conversation প্রতি cursor হিসেবে জমা, প্রতি message এ না                                           |
| **Per-Conversation Sequence (Sequencer)**      | প্রতিটা conversation এর মালিক প্রতিটা message কে বাড়তে থাকা seq দেয় — কার্যকারণ আর সবার একই ক্রম নিশ্চিত, ঘড়ি ছাড়া; sync আর cursor এর ভাষা; দাম একটা sequencer আর তার failover        |
| **Presence**                                   | একজন user এখন online কিনা বা শেষ কখন — সব contact কে push করলে delivery এর চেয়েও বড় চাপ; lazy presence শুধু যারা chat খুলে রেখেছে তাদের                                                 |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. Product team চায় একজন user এর চারটা device (ফোন, tablet, দুটো laptop) একসাথে চলবে, প্রতিটায় পুরো history, আর এক device এ পড়লে বাকিগুলোতেও "পড়া" দেখাবে। (ক) Registry, cursor আর fan-out এ কী বদলায়? (খ) ১.২ এর কোন সংখ্যাগুলো কত গুণ হয়? (গ) নতুন একটা laptop এ login করলে তিন বছরের history কোথা থেকে আসবে, আর storage এর সিদ্ধান্তে (inbox বনাম চিরকালের log) এর প্রভাব কী?

2. সোমবার সকালে একটা AZ এর network ৪ মিনিট খারাপ, তাতে ১০০টা gateway (পাঁচ কোটি connection) এর client রা একসাথে কেটে যায়। AZ ফিরে আসে। (ক) এই lesson এর reconnect এর সংখ্যা ধরে কী আশা করো, যদি client রা ৬০ s এ ছড়িয়ে ফেরে আর বাকি fleet এর ক্ষমতা ২০,০০০/s? (খ) Auth service আর message store এর sync এর চাপ কী হবে, আর কোনটা আগে ভাঙবে? (গ) এই ঘটনার জন্য তিনটা প্রস্তুতি, যা আজ করা যায়।

3. একটা ১০,০০০ সদস্যের community group। প্রতিদিন ২,০০০টা message। (ক) প্রতিটা message এ fan-out on write (প্রতিটা সদস্যের inbox এ লেখা) এর খরচ কত, ১.২ এর মতো করে? (খ) কোন অংশগুলো (receipt, presence, push notification, typing indicator) এই group এ বন্ধ বা বদলাবে, আর কেন? (গ) এই group এর sequencer কি একটা সমস্যা হতে পারে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) **Registry:** `user → gateway` থেকে `(user, device) → gateway`; একজন user এর চারটা entry। **Fan-out:** প্রতি delivery তে প্রাপকের প্রতিটা device এ একটা, **আর sender এর নিজের বাকি device গুলোতেও** (Alice ফোন থেকে পাঠালে তার laptop এও দেখাতে হবে)। **Cursor:** দুই স্তরে — device প্রতি `delivered_seq` (কোন device কতদূর পেয়েছে, sync এর জন্য), আর user প্রতি `read_seq` (পড়া মানুষের, device এর না)। এক device এ পড়লে user এর `read_seq` বাড়ে, আর সেটা বাকি device গুলোতে একটা event হিসেবে যায় ("conv X এ seq ৫০ পর্যন্ত পড়া হয়েছে", যাতে notification badge মুছে যায়)।

(খ) Connection: চারটা device সবসময় online না, তবে ধরো online device গড়ে ১.৫ গুণ: ১৫ কোটি থেকে ~২২ কোটি, memory আর gateway ১.৫ গুণ। Delivery: প্রাপকের device সংখ্যা দিয়ে গুণ, আর sender এর নিজের device গুলো যোগ — ধরো ২-৩ গুণ। Receipt এর "delivered" device প্রতি, "read" user প্রতি। Heartbeat connection এর সাথে বাড়ে।

(গ) "নতুন device এ পুরো history" মানে server এ history **রাখতেই হবে** — inbox এর মডেল (পৌঁছালে মুছে ফেলা) আর চলে না, কারণ পৌঁছানো এখন device প্রতি, আর নতুন device এর জন্য সব কিছুই "না-পৌঁছানো"। মানে ১.২ এর ৩ TB থেকে ১৪.৬ PB এর দিকে। বিকল্প: history এর মালিক পুরনো device (ফোন), আর নতুন device ফোনের কাছ থেকে history টেনে নেয় (ফোন online থাকতে হবে) বা user এর নিজের cloud backup থেকে। এটা product আর privacy এর সিদ্ধান্ত (end-to-end encryption থাকলে server এর কপি পড়তে পারে না, তাই প্রতিটা device এর জন্য আলাদা encrypt করা কপি বা device থেকে device এ হস্তান্তর)। যেকোনো পথে, multi-device আর "server এ history নেই" একসাথে থাকা কঠিন।

**প্রশ্ন ২:**

(ক) পাঁচ কোটি connection ÷ ২০,০০০/s = সবচেয়ে ভালো ক্ষেত্রেও ২,৫০০ s, প্রায় **৪২ মিনিট**। ৬০ s এ ছড়ালে চাহিদা ~৮.৩ লাখ/s, ক্ষমতার ৪০ গুণ: অংশ খ এর collapse এর এলাকা (প্রত্যাখ্যানের খরচ ০.২ হলে ১.৬ লাখ/s এর সমান কাজ, ক্ষমতার ৮ গুণ)। মানে ৬০ s এর ছড়ানো এই মাপে যথেষ্ট না, আর exponential backoff এর jitter এখানে কাজ করবে, কিন্তু অনেক মিনিট ধরে। আসল শিক্ষা: ছড়ানোর জানালা fleet এর ক্ষমতা আর ঘটনার আকারের সাথে মিলিয়ে হতে হবে, স্থির সংখ্যা না। আর "সবাই ফিরবে" এর সময় মিনিটের হিসাবে, সেকেন্ডের না।

(খ) প্রতিটা reconnect এ: TLS (gateway এর CPU), auth (token যাচাই — JWT হলে শুধু CPU, প্রতিবার auth service এ গেলে auth service), registry লেখা (Redis), আর sync (store এ প্রতিটা conversation এর range scan)। সবচেয়ে আগে ভাঙে সাধারণত **auth service** (যদি প্রতিটা reconnect তাকে ডাকে) আর **sync** (চার মিনিটের জমা message, প্রতিটা user এর কয়েক ডজন conversation, একসাথে)। Sync এর চাপ কমাতে: client শুধু সাম্প্রতিক conversation গুলো আগে sync করে, বাকিগুলো পরে বা chat খুললে।

(গ) প্রস্তুতি: (১) client এর reconnect এর জানালা server থেকে নিয়ন্ত্রণযোগ্য (একটা config, বা gateway reconnect এর সময় "X s পরে আসো" বলে দেয়) — ঘটনার আকার অনুযায়ী বাড়ানো যায়; (২) auth এ resumption token: ছোট মেয়াদের একটা signed token যা gateway নিজে যাচাই করতে পারে, auth service ছাড়া (10.5 এর JWT এর মতো), আর TLS session resumption, যাতে handshake সস্তা হয়; (৩) একটা game day (10.3): একটা AZ এর gateway গুলোকে ইচ্ছা করে কেটে দেখা, আর মাপা কতক্ষণে সবাই ফেরে আর কোন service প্রথমে লাল হয়। সাথে প্রবেশের পথে admission control (11.2 এর limiter, connection এর হার ধরে) যাতে প্রত্যাখ্যান সস্তা হয়।

**প্রশ্ন ৩:**

(ক) Fan-out on write: ২,০০০ message × ৯,৯৯৯ সদস্য = দিনে ~২ কোটি inbox লেখা একটা group এর জন্য, আর প্রতিটা থেকে দুটো receipt = আরও ৪ কোটি। একটা মাত্র group এর। ১,০০০টা এমন group হলে দিনে ২,০০০ কোটি লেখা, পুরো system এর message এর সমান। তাই বড় group এ **fan-out on read**: message শুধু conversation এর log এ একবার, আর প্রতিটা সদস্য নিজের cursor থেকে পড়ে নেয়। Online সদস্যদের push (gateway এ) এখনও প্রতিটা আলাদা, কিন্তু টেকসই লেখা একবার।

(খ) **Read receipt:** বন্ধ বা শুধু সংখ্যা ("২,৩১০ জন দেখেছে", sender এর অনুরোধে, cursor থেকে গোনা), কারণ প্রতিটা receipt sender কে পাঠানো অর্থহীন আর ব্যয়বহুল। **Delivered receipt:** বন্ধ। **Presence:** বন্ধ বা শুধু "এখন ৮৫ জন online" এর মতো আনুমানিক সংখ্যা। **Push notification:** প্রতিটা message এ না, user এর পছন্দে (mention হলে, বা দিনে একবার সারাংশ), নইলে দিনে ২,০০০ notification। **Typing indicator:** বন্ধ (১০,০০০ জনের মধ্যে সবসময় কেউ না কেউ লিখছে, আর প্রতিটা "typing" সবার কাছে একটা event)।

(গ) দিনে ২,০০০ message মানে গড়ে মিনিটে ১-২টা, peak এ হয়তো সেকেন্ডে কয়েকটা — sequencer এর জন্য কিছুই না। Sequencer এর সমস্যা লেখার হারে না, **পড়ার fan-out এ**: প্রতিটা নতুন message এ ১০,০০০ জনের কাছে যাওয়া, আর তাদের মধ্যে online থাকা কয়েক হাজারের gateway এ push। সেটা sequencer এর কাজ না, delivery এর; তাই sequencer (seq দেওয়া) আর fan-out (পাঠানো) আলাদা রাখা, যাতে একটা বড় group এর fan-out অন্য conversation এর seq দেওয়া ধীর না করে।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (তিনটা deterministic model আর `ws` দিয়ে একটা আসল দুই-gateway chat; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-11.3-chat-system/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.3-chat-system) — `npm install`, তারপর `npm run estimate`, `npm run gateway`, `npm run delivery`, `npm run smoke`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`estimate` connection, memory, gateway, heartbeat, fan-out, receipt, storage আর presence হিসাব করে। `gateway` routing এর চারটা পথ তুলনা করে, একটা gateway এর crash এর পরে চারটা reconnect নীতি চালায় (প্রত্যাখ্যানের খরচ সহ), আর registry পুরনো থাকার সময় হারানো message গোনে। `delivery` ৩% packet হারানো network এ তিনটা delivery নীতি, আর group এ চারটা ক্রমের নিয়ম মাপে। `smoke` দুটো আসল WebSocket gateway, একটা `ChatCore` আর তিনজন user দিয়ে ১১টা ধাপ চালায়।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean; তিনটা model দুবার করে আর smoke তিনবার, output byte ধরে হুবহু এক। README এর experiment ১–৪ চালানো হয়েছে, সংখ্যা lesson এ; ৫ code বদলানোর কাজ, তোমার। **Estimation এর input ধরে নেওয়া** (DAU, message, group, connection প্রতি ২০ KB, gateway প্রতি ৫ লাখ connection), মাপা না। Reconnect এর model এ fleet এর ক্ষমতা (২০,০০০/s) আর প্রত্যাখ্যানের খরচ (০.২) ধরে নেওয়া; collapse এর সীমা এই দুটোর উপর নির্ভর করে। Pub/sub এর অংশ হিসাব, simulation না; Redis Cluster এর `PUBLISH` আর `SPUBLISH` এর আচরণ documentation থেকে। Network আর ঘড়ির মডেল synthetic। `smoke` এর registry আর store in-memory, Redis বা database না; push notification শুধু গোনা। WhatsApp এর inbox এর নকশা, Messenger এর HBase আর Discord এর Cassandra/ScyllaDB এর কথা তাদের প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। **যা মাপা হয়নি:** আসল connection প্রতি memory, gateway এর আসল ক্ষমতা, mobile network, APNs/FCM, multi-device, encryption।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** `gateway` চালানোর **আগে** লিখে ফেলো: পাঁচ লাখ client "সাথে সাথে, ব্যর্থ হলে ১ s পরে" নীতিতে, ক্ষমতা ২০,০০০/s — কতক্ষণে সবাই ফিরবে? তারপর চালিয়ে মেলাও। ভুলটা কোথায় ছিল?

2. **নিজের ক্ষমতা:** `CAPACITY=50000 npm run gateway` আর `CAPACITY=5000`। কোন নীতিগুলো collapse এর বাইরে আসে, আর কোথায় সীমাটা? প্রত্যাখ্যানের খরচ আর চাহিদা দিয়ে collapse এর শর্তটা একটা সূত্রে লেখো।

3. **Heartbeat এর দাম:** `HEARTBEAT_S=10 npm run estimate` আর `HEARTBEAT_S=120`। প্রতিটার জন্য একটা কারণ লেখো কেন সেটা ভুল হতে পারে (battery/CPU বনাম মরা connection ধরতে দেরি আর NAT)।

4. **Code বদলানো:** README এর experiment ৫ (typing indicator)। তারপর `src/chat.ts` এ group এর জন্য "read" receipt কে জমানো করো: প্রতিটা read এ sender কে না পাঠিয়ে, sender যখন চাইবে তখন cursor থেকে "কতজন পড়েছে" গুনে দাও। `smoke` এ একটা ধাপ যোগ করো যা দেখায় কতগুলো frame বাঁচল।

5. **Design অংশ:** এই chat এর "এক পাতার design doc", Lesson 1.2 এর পাঁচ ধাপে: (ক) requirement, history এর সিদ্ধান্ত সহ; (খ) পাঁচটা সংখ্যা আর প্রতিটা থেকে একটা সিদ্ধান্ত; (গ) gateway, registry, store, push এর ছবি; (ঘ) delivery আর ক্রমের নিয়ম, একটা message এর পুরো যাত্রা (পাঠানো থেকে নীল টিক) ধাপে ধাপে; (ঙ) একটা AZ এর বিভ্রাটের runbook: reconnect এর জানালা, admission control, আর কোন তিনটা metric দেখবে।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 10 (সম্পূর্ণ, exit challenge সহ), 11.1, 11.2
Current: 11.3 — Case Study: Design a Chat System (WhatsApp-style)
TaskFlow state: Module 10 এর শেষ অবস্থায় রাখা (Module 11 এ পাশে)। Case study ১ — URL shortener (11.1);
২ — rate limiter service (11.2)। Case study ৩ — chat: ৫০ কোটি DAU, ১৫ কোটি খোলা connection (৩ TB), ~৩০০ gateway,
heartbeat ৫০ লাখ/s (message এর ৭ গুণ), fan-out ৬.৪, receipt ৮৯ লাখ/s। History: চিরকাল ১৪.৬ PB বনাম পৌঁছানো
পর্যন্ত ৩.২ TB (product এর প্রশ্ন)। Gateway শুধু connection; session registry (user → gateway) + সরাসরি পাঠানো
(broadcast এ gateway প্রতি ০.৩% কাজের)। Store-then-push: আগে টেকসই, ack, তারপর push best-effort, sync seq ধরে
(registry পুরনো হলে শুধু push এ ৮৮% হারায়, store এ ০)। At-least-once + client_msg_id + seq (না হলে ৬% হারায় বা
৬% দুবার)। ক্রম conversation প্রতি seq (ফোনের ঘড়িতে ১০% উত্তর উপরে, পৌঁছানোর ক্রমে ৪৮% আলাদা)। Receipt
cursor এ। Presence lazy। Reconnect: প্রথম চেষ্টা থেকে jitter (৬০ s এ ছড়ালে client প্রতি ১ চেষ্টা), draining,
সস্তা প্রত্যাখ্যান — jitter ছাড়া congestion collapse (১০ মিনিটে ০%)। Message key (conv_id, seq), conv_id ধরে shard।
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (বনাম Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style)
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **real-time system এর খরচ খোলা connection এ, আর তার নিশ্চয়তা আসে store আর sequence থেকে, push থেকে না।** Gateway শুধু connection ধরে, registry বলে কে কোথায়, আর message আগে টেকসই জায়গায় যায়, তারপর দ্রুত পথে। Push হারাতে পারে, দুবার যেতে পারে, ভুল জায়গায় যেতে পারে; seq আর sync সব ঠিক করে। আর একটা stateful fleet এর সবচেয়ে বিপজ্জনক মুহূর্ত কোনো একটা server এর মৃত্যু না, তার পরের পাঁচ মিনিট, যখন সবাই একসাথে ফিরতে চায়।

রেডি হলে `next` লিখো — **Lesson 11.4: Design a News Feed (Facebook/Twitter-style)** এ যাব। আজকের প্রশ্ন ৩ এর বড় group সেখানে পুরো system হয়ে ফিরবে: একজন পোস্ট করলে তার এক কোটি follower এর feed এ কীভাবে পৌঁছাবে? প্রতিটা follower এর feed এ লেখা (fan-out on write), নাকি পড়ার সময় সবার পোস্ট জোড়া (fan-out on read)? একজন celebrity আর একজন সাধারণ user এর জন্য একই উত্তর কেন চলে না, আর ranking কোথায় বসে?
