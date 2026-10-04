# Chat System Lab — Connection এর মাপ, Gateway Routing, Reconnect Storm, Delivery আর ক্রম, আর একটা আসল দুই-Gateway Chat

> Lesson 11.3 — Case Study: Design a Chat System (WhatsApp-style) · **Tier 1 — Runnable Code**
> (তিনটা deterministic model আর `ws` দিয়ে একটা আসল দুই-gateway chat; Docker লাগে না)

## কী বানাচ্ছি

একটা WhatsApp এর মতো chat এর চারটা প্রশ্ন। কত connection, কত heartbeat, কত delivery আর receipt, আর history রাখা বনাম না রাখা
storage এ কী বদলায়? একটা message কোন gateway তে যাবে, আর একটা gateway মরলে তার লাখ লাখ user কীভাবে ফেরে? Mobile network এ
message কীভাবে হারায় বা দুবার আসে, আর group এ ক্রম কে ঠিক করে? আর শেষে একটা আসল chat: দুটো WebSocket gateway, একটা registry,
একটা store, receipt, offline sync, আর একটা gateway এর crash।

| Script             | প্রশ্ন                                                                                               | Lesson §  |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------- |
| `npm run estimate` | ৫০ কোটি DAU — connection, memory, gateway, heartbeat, fan-out, receipt, storage, presence            | ১.২       |
| `npm run gateway`  | Broadcast বনাম user channel বনাম registry; একটা gateway মরলে reconnect এর চারটা নীতি; হারানো message | ১.৪ – ১.৫ |
| `npm run delivery` | ৩% packet হারানো network এ at-most/at-least/dedupe; group এ চারটা ক্রমের নিয়ম                       | ১.৬ – ১.৭ |
| `npm run smoke`    | আসল `ws`: দুটো gateway, registry, ack আর receipt, duplicate, offline sync, crash, একসাথে পাঠানো      | ১.৮       |

**সৎ নোট:**

- **Estimation এর input ধরে নেওয়া** — DAU, message এর সংখ্যা, group এর ভাগ, connection প্রতি ২০ KB memory, gateway প্রতি ৫
  লাখ connection। Connection প্রতি memory OS, TLS library আর buffer এর setting এ অনেক বদলায়; এখানে মাপা না।
- **`gateway` এর reconnect model সরল** — বাকি fleet এর মোট ক্ষমতা ২০,০০০ handshake/s (TLS + auth + sync) ধরা, আর প্রত্যাখ্যাত
  চেষ্টাও একটা পূর্ণ handshake এর ০.২ ভাগ খরচ করে বলে ধরা (TCP + TLS শুরু হওয়ার পরে প্রত্যাখ্যান)। এই সংখ্যাটা বদলালে
  collapse এর সীমা বদলায় (experiment ১)। Pub/sub এর অংশটা হিসাব, simulation না; Redis Cluster এর পুরনো `PUBLISH` সব node এ
  ছড়ানো আর `SPUBLISH` (Redis 7) এর কথা documentation থেকে।
- **`delivery` এর network আর ঘড়ি synthetic** — প্রতিটা packet স্বাধীনভাবে ৩% হারায়, ফোনের ঘড়ি ±৫০০ ms আর ২% ফোন মিনিট খানেক
  ভুল, chat server এর ঘড়ি ±৩০ ms।
- **`smoke` আসল WebSocket (`ws`) চালায়**, এক process এ, কিন্তু registry আর store একটা in-memory `ChatCore`, Redis বা database
  না। Gateway এর "crash" মানে socket গুলো `terminate()` আর server বন্ধ। Push notification শুধু গোনা হয়, পাঠানো না।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; তিনটা model দুবার করে আর smoke তিনবার, output byte
  ধরে হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run estimate
npm run gateway
npm run delivery
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` — heartbeat message এর চেয়ে বেশি; receipt delivery এর দ্বিগুণ; history রাখা বনাম না রাখা হাজার গুণ:

```
heartbeat / s (প্রতি 30 s এ)                                    5,000,000   message এর চেয়েও বেশি
delivery / s (peak)                                          4,444,444
receipt (delivered + read) / s (peak)                        8,888,889
সব history চিরকাল (10 বছর, এক কপি)                                14.6 PB
শুধু না-পৌঁছানো message (পৌঁছালে মুছে ফেলা)                                    3.2 TB
সব contact কে push / s                                       23,148,148   presence storm
```

`npm run gateway` — broadcast এ প্রতিটা gateway সব কিছু পায়; jitter ছাড়া reconnect এ congestion collapse; শুধু push এ message
হারায়:

```
সব gateway কে broadcast (একটা pub/sub channel)                   4,444,444       0.3%     1,333,333,200
session registry (user → gateway) + সরাসরি পাঠানো                      14,815     100.0%         8,888,888
সাথে সাথে, ব্যর্থ হলে আবার সাথে সাথে                               5,000,000   3,000,000,000       6,000         —         —     0% (10 মি এ)
প্রথমটা ০–10 s এ ছড়ানো + full jitter                        251,980       3,304,742           7   30.47 s   76.55 s         89.40 s
প্রথমটা ০–10 s এ ছড়ানো + full jitter                    391,250 (88%)                             0   16.82 s   64.77 s
```

`npm run delivery` — retry ছাড়া হারায়, dedupe ছাড়া দুবার; ফোনের ঘড়িতে উত্তর প্রশ্নের উপরে; পৌঁছানোর ক্রমে সদস্যরা আলাদা ক্রম
দেখে:

```
একবার পাঠাও, ack নেই (at-most-once)                      5.94%          0.00%              0.00%             3.94
ack না এলে আবার পাঠাও (at-least-once)                     0.00%          5.80%              2.92%             4.31
আবার পাঠাও + client_msg_id আর seq দিয়ে বাদ                 0.00%          0.00%              0.00%             4.25
পাঠানোর ফোনের ঘড়ি ধরে সাজানো                                         10.21%                   0.00%
যে ক্রমে পৌঁছাল সেভাবে দেখানো                                            0.41%                  47.59%
conversation প্রতি seq (একটা sequencer)                         0.00%                   0.00%
```

`npm run smoke` — ১১টা ধাপ:

```
2   bob পেল (gw2 তে, registry দেখে)                             1:hi
5   alice আবার পাঠাল একই client_msg_id (ack হারিয়েছিল ধরে)          ack seq 1, duplicate: true; bob এ 1টা
7   carol online (gw1), sync { }                            1:standup?, 2:১০টায়, 3:ok
8   gw2 crash; alice → bob ২টা (registry তখনও gw2)           stale route: 2, store এ dm: 3টা
9   bob gw1 এ reconnect, sync { dm: 1, team: 3 }            2:আছো?, 3:call দাও
10  alice আর bob একসাথে team এ                                carol দেখে: 4:আমি আগে, 5:না আমি; seq: 4, 5
```

## কী দেখার জন্য এটা বানানো

- **Chat এর খরচ connection এ, message এ না।** ১৫ কোটি খোলা connection, ৩ TB memory, আর heartbeat message এর চেয়ে ৭ গুণ বেশি।
- **Fan-out আর receipt আসল লেখার চাপ।** একটা পাঠানো message গড়ে ৬.৪টা delivery আর ১৩টা receipt।
- **"History রাখব কিনা" একটা product এর সিদ্ধান্ত যা storage কে হাজার গুণ বদলায়** — ১৪.৬ PB বনাম ৩.২ TB।
- **Broadcast pub/sub এ প্রতিটা gateway সব message পায়, ০.৩% কাজে লাগে।** Registry বা user channel এ শুধু নিজেরটা।
- **Reconnect storm এ jitter ছাড়া কেউ ফেরে না** — প্রত্যাখ্যাত চেষ্টার খরচ সব ক্ষমতা খেয়ে ফেলে (congestion collapse)।
- **আগে store, তারপর push।** Push একটা দ্রুত পথ, সত্য না; registry পুরনো হলে push হারায়, store থেকে sync আনে।
- **At-least-once + dedupe = effectively once।** client_msg_id server এ, seq client এ।
- **ক্রম আসে sequencer থেকে, ঘড়ি থেকে না।** ফোনের ঘড়ি কার্যকারণ ভাঙে, পৌঁছানোর ক্রম সদস্যদের মধ্যে মিল ভাঙে।

## নিজে ভেঙে দেখো (Experiments)

1. **সস্তা প্রত্যাখ্যান:** `REJECT_COST=0.05 npm run gateway` আর `REJECT_COST=0.02`। সাথে সাথে retry কি এখন ফেরে (মাপা: না, দুটোতেই
   ০%)? Jitter এর ৯৯% কত (০.০৫ এ ৪৮.৭৮ s)? প্রত্যাখ্যানকে আরও সস্তা করার উপায় কী (TLS এর আগে, load balancer এ)?
2. **আরও ছড়ানো:** `FIRST_SPREAD_MS=60000 npm run gateway`। Client প্রতি চেষ্টা কত (মাপা: ১), আর ৯৯% কখন ফেরে (৫৯.৪১ s, ১০ s এ
   ছড়ানোর ৭৬.৫৫ s এর চেয়ে আগে)? কেন ধীরে শুরু করা দ্রুত শেষ করে?
3. **খারাপ network:** `DROP=0.1 npm run delivery`। Retry ছাড়া কত হারায় (মাপা: ১৮.৯৩%), আর dedupe ছাড়া কত দুবার দেখায়
   (১৭.৪২%)?
4. **দ্রুত উত্তর (bot):** `THINK_MS=20 npm run delivery`। ফোনের ঘড়িতে উত্তর উপরে কত (মাপা: ৩৮.৮৭%), পৌঁছানোর ক্রমে (৯.২৮%),
   আর server এর ঘড়িতে (০.০৯%)? Server এর ঘড়ি কেন যথেষ্ট না?
5. **Code বদলানোর কাজ:** `src/chat.ts` এ একটা "typing…" indicator যোগ করো — এটা কি store এ যাবে, receipt চাইবে, sync এ আসবে?
   Message এর সাথে এর নকশার পার্থক্যটা কোথায়?

## Project Structure

```
src/
  util.ts      seed দেওয়া PRNG, lognormal, percentile, টেবিলের format, env parse
  estimate.ts  script ক — connection, heartbeat, fan-out, receipt, storage, presence
  gateway.ts   script খ — routing এর চার পথ, reconnect storm (চারটা নীতি), হারানো message
  delivery.ts  script গ — ack/retry/dedupe, group এ চারটা ক্রমের নিয়ম
  chat.ts      ChatCore (registry, conversation log + seq, dedupe, fan-out, receipt, sync) আর Gateway (ws, Zod frame)
  smoke.ts     script ঘ — দুটো gateway, তিনজন user, ১১টা ধাপ
```

Environment variable: `DAU`, `ONLINE_SHARE`, `MESSAGES_PER_USER`, `PEAK`, `GROUP_SHARE`, `GROUP_SIZE`, `CONN_BYTES`,
`CONNS_PER_GATEWAY`, `HEARTBEAT_S`, `MESSAGE_BYTES`, `YEARS`, `OFFLINE_SHARE`, `OFFLINE_WAIT_H`, `CONTACTS`, `TRANSITIONS`,
`CHAT_OPEN_SHARE`, `GATEWAYS`, `DELIVERIES`, `ONLINE`, `REDIS_NODES`, `CLIENTS`, `CAPACITY`, `TICK_MS`, `HORIZON_S`,
`BASE_MS`, `CAP_MS`, `FIRST_SPREAD_MS`, `REJECT_COST`, `MESSAGES`, `DROP`, `EVENTS`, `MEMBERS`, `CLOCK_SD_MS`,
`WRONG_CLOCK`, `SERVERS`, `SERVER_SD_MS`, `LATENCY_MS`, `THINK_MS`, `REPLY_SHARE`, `SEED`।
