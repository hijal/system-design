# TaskFlow Monolith vs Microservices Lab — ভাঙলে কী দাম দিতে হয়

> Lesson 9.1 — Monolith vs Microservices · **Tier 1 — Runnable Code** (আলাদা Node process গুলো আলাদা "service"; `transaction` এ Docker এ Postgres)

## কী বানাচ্ছি

TaskFlow এর board এর তিনটা অংশ — tasks, users, comments — একবার এক process এ (monolith), একবার তিনটা আলাদা process এ
(microservices)। Module এর code দুই ক্ষেত্রেই হুবহু এক; বদলায় শুধু মাঝের সীমানা: function call, নাকি network call।
তিনটা script, তিনটা দাম:

| Script                | প্রশ্ন                                                                                                                  | Lesson § |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run latency`     | একই board — function call বনাম HTTP call, task প্রতি call (chatty) বনাম একসাথে (batched)। সময় আর CPU                   | ১.২      |
| `npm run failure`     | একটা অংশ ভারী কাজে আটকালে বা মরে গেলে board এর কী হয় — timeout আর fallback সহ ও ছাড়া; availability এর গুণ             | ১.৩      |
| `npm run transaction` | "task তৈরি" = task row + billing এর counter। এক database এ একটা transaction, বনাম দুটো database এ দুটো লেখা, মাঝে crash | ১.৪      |

**সৎ নোট:**

- সব "service" একই machine এ, localhost এ কথা বলে — আসল network এর চেয়ে দ্রুত আর স্থির। `NET_MS` দিয়ে প্রতিটা internal
  call এ দেরি যোগ করা যায় (experiment ১)। আসল deploy এ load balancer, TLS, service mesh এর sidecar — প্রতিটা আরও একটু যোগ করে।
- Data memory তে (database নেই) — যাতে `latency` শুধু সীমানার দাম মাপে। আসল board এ query এর সময় দুই পথেই যোগ হতো।
- `latency` এ monolith এর board/s এর সীমা **load generator নিজে** (parent process ~১.৩ core খায়), monolith না — monolith
  process তখন একটা core এর ~৭৩% এ। তাই তুলনার জন্য "CPU / board" এর কলাম দেখো, board/s না।
- Microservices এ ৩টা process মানে ৩টা core ব্যবহার করতে পারে, monolith এ ১টা। CPU এর কলাম সব process এর যোগফল।
- `failure` এর export একটা CPU এর কাজ (string বানানো আর জোড়া) যেটা ~৩০০ ms ধরে event loop আটকায় — আসল export এর মতো,
  কিন্তু সময়টা বেছে নেওয়া। Crash মানে `SIGKILL` — graceful shutdown না।
- `transaction` এ "crash" মানে প্রথম লেখার পরে operation টা থেমে যাওয়া; monolith এ সেটা transaction এর ভেতরে, তাই
  `ROLLBACK` (আসল crash এ connection কেটে গেলে Postgres নিজেই সেটা করে)। কোন operation crash করবে সেটা seed দেওয়া —
  চারটা পথে হুবহু একই ৮৩টা।
- যাচাই করা হয়েছে Node 26 আর Postgres 17 এ; সময় machine ভেদে বদলাবে, গোনা (সফল, অমিল, error %) বদলাবে না।

## Prerequisite

Node.js 22+। `transaction` এর জন্য Docker (Postgres); `latency` আর `failure` এ Docker লাগে না।

## Setup

```bash
npm install
docker compose up -d --wait     # শুধু transaction এর জন্য
```

## Run

```bash
npm run latency       # ~৩০ সেকেন্ড
npm run failure       # ~৫০ সেকেন্ড
npm run transaction   # ~১০ সেকেন্ড
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run latency` (এই machine এ):

```
── Board খোলা — সব process একই machine এ ──
                                                        একা ১ জন   ব্যস্ত: 16 জন একসাথে, 5 s
   পথ                                       ভেতরের call        p50    board/s        p99   CPU / board (সব process)
   monolith (function call)                         0     0.3 ms       6234     5.0 ms   0.1 ms
   microservices, chatty (task প্রতি call)        100    11.3 ms         86   203.6 ms   24.4 ms
   microservices, batched (২টা call)                2     0.8 ms       2206    11.1 ms   0.8 ms
```

মিলতে হবে: তিনটা পথে board হুবহু একই (script নিজে যাচাই করে, না মিললে থামে); chatty তে CPU / board monolith এর দুশো গুণের
কাছাকাছি, board/s কয়েক দশক; batched monolith এর চেয়ে ধীর কিন্তু একই ঘরে।

`npm run failure`:

```
── ক. ভারী প্রতিবেশী: board খোলা (8 client) আর একই সময়ে export (প্রতিটা ~300 ms CPU, পরপর) ──
   পথ                                           সফল board/s     p50        p99    পুরো   comments ছাড়া   error
   monolith, export ছাড়া (তুলনার জন্য)            5979     1.3 ms     3.2 ms     100%           0%      0%
   monolith, export একই process এ                    28   301.4 ms   302.8 ms     100%           0%      0%
   microservices, timeout ছাড়া                      28   301.8 ms   306.5 ms     100%           0%      0%
   microservices, timeout 50 ms + fallback          154    51.7 ms    58.1 ms       1%          99%      0%

── খ. Crash: export এর bug এ process মারা গেল — তারপর 5 s board খোলা ──
   পথ                                           সফল board/s     p50        p99    পুরো   comments ছাড়া   error
   monolith (একমাত্র process মারা গেল)                0     1.2 ms     3.9 ms       0%           0%    100%
   microservices, comments মারা গেল, timeout ছাড়া       0     3.6 ms     7.8 ms       0%           0%    100%
   microservices, comments মারা গেল, + fallback    1759     4.2 ms     8.3 ms       0%         100%      0%
      … তারপর users ও মারা গেল (তার fallback নেই)       0     3.1 ms     7.0 ms       0%           0%    100%

── গ. হিসাব: board এর পথে k টা service, প্রতিটা আলাদাভাবে 99.9% available ──
   k   পুরো পথের availability   মাসে বন্ধ (৩০ দিন)
   1                   99.90%       43 মিনিট
   3                   99.70%      129 মিনিট
   5                   99.50%      216 মিনিট
  10                   99.00%      430 মিনিট
  20                   98.02%      856 মিনিট
```

মিলতে হবে: export চলার সময় monolith আর timeout ছাড়া microservices দুটোই p50 ~৩০০ ms; timeout + fallback এ p99 ~৫০–৬০ ms
আর প্রায় সব board "comments ছাড়া"; crash এ শুধু fallback এর সারিতে error ০%। Error আর % এর কলাম প্রতিবার একই।

`npm run transaction`:

```
── 3000 টা "task তৈরি", 100 টা workspace, 83 টায় প্রথম লেখার পরে crash (3%), 8 টা একসাথে ──
   পথ                                              সফল   ব্যর্থ  task row  counter  অমিল ws   ফল                     ops/s      p50
   monolith: একটা transaction                       2917     83     2917     2917         0   মেলে                     2917   2.6 ms
   services: task আগে, তারপর billing                2917     83     3000     2917        57   83 টা task বিনা বিলে     1516   5.2 ms
   services: billing আগে, তারপর task                2917     83     2917     3000        57   83 টা task এর বিল, task নেই   1513   5.2 ms
   services: task আগে + user আবার চেষ্টা            3000      0     3083     3000        57   83 টা task বিনা বিলে     1477   5.2 ms
```

মিলতে হবে: ops/s আর p50 ছাড়া সব সংখ্যা প্রতিবার হুবহু একই। Monolith এ অমিল ০; দুটো database এ ঠিক ৮৩টা অমিল —
কোন দিকে, সেটা লেখার ক্রম ঠিক করে।

## কী দেখার জন্য এটা বানানো

- **সীমানার দাম CPU তে:** chatty পথে একটা board মানে ১০০টা HTTP request — প্রতিটায় serialize, socket, parse, Zod এর
  যাচাই। একজন user এর চোখে ১১ ms (100টা call একসাথে যায়), কিন্তু system এর CPU তে board প্রতি ~২৪ ms — monolith এর
  দুশো গুণের বেশি। এটাই network এর উপর N+1 (Lesson 5.6)। Batched এ ২টা call — দাম ৮ গুণ, দুশো না।
- **আলাদা process মানেই আলাদা ব্যর্থতা না:** comments আটকে থাকলে timeout ছাড়া tasks service ও অপেক্ষা করে — board ঠিক
  monolith এর মতোই ধীর (দুটোই ~৩০১ ms)। আলাদা হওয়ার সুবিধা আসে শুধু যখন ডাকার দিকে timeout আর একটা fallback থাকে।
- **Fallback প্রতিটা নির্ভরতার জন্য আলাদা করে design করতে হয়:** comments এর ছিল, users এর ছিল না — users মরলে board আবার ১০০% error।
- **একটা transaction এর দাম আর সুবিধা:** monolith এ crash মানে কিছুই না ঘটা। দুটো database এ crash মানে অর্ধেক ঘটা —
  আর "আবার চেষ্টা" সেটা সারায় না, বরং duplicate task বানায় (৩০৮৩টা task, ৩০০০ বার বিল)। কোন দিকে ভুল হবে সেটা বাছা যায়,
  ভুল হওয়া বন্ধ করা যায় না — তার জন্য Lesson 9.3 (saga) আর 7.5 (outbox)।
- **আর crash ছাড়াও:** দুটো database এ প্রতিটা operation দুটো commit — ops/s প্রায় অর্ধেক (experiment ৩)।

## নিজে ভেঙে দেখো (Experiments)

1. **Network কে দূরে সরাও:** `NET_MS=1 npm run latency` — প্রতিটা internal call এ ১ ms (একই data center এ আলাদা machine
   এর কাছাকাছি)। "একা ১ জন" এর কলামে batched কত বাড়ল, chatty কত? কেন chatty প্রায় বাড়েনি (১০০টা call কীভাবে যায়)? `service.ts`
   এর chatty তে `Promise.all` এর বদলে `for … of` দিয়ে একটা একটা করে ডাকলে কী হতো — আগে অনুমান করো, তারপর বদলে দেখো। (এই
   machine এ, `Promise.all` সহ: batched ০.৮ → ২.০ ms, chatty ১১.৩ → ১১.১ ms — কিন্তু CPU / board chatty তে তখনো ~২৩ ms।)
2. **Timeout কত?** `TIMEOUT_MS=500 npm run failure` — export ৩০০ ms, timeout ৫০০ ms। কী হলো? (এই machine এ: fallback এর
   সারিও ৩০১ ms, "comments ছাড়া" ০% — timeout কখনো বাজেনি।) Timeout কীসের সাথে মিলিয়ে ঠিক করতে হয় — নির্ভরতার স্বাভাবিক
   p99, নাকি নিজের SLO? `EXPORT_MS=30` দিয়েও চালিয়ে দেখো।
3. **Crash ছাড়া দাম:** `CRASH_RATE=0 npm run transaction` — সব মেলে। কিন্তু ops/s? (এই machine এ: monolith ২৮১০, services
   ~১৪৯০ — প্রতিটা operation এ দুটো commit, দুটো round trip।)
4. **Users এর fallback** (code বদলানো): `service.ts` এর batched পথে users এর call কেও `soft()` এ মোড়াও — assignee ছাড়া
   card দেখানো (`assignee: null`)। `failure` এর শেষ সারি কী হয়? কোন তথ্য ছাড়া board দেখানো চলে, আর কোনটা ছাড়া চলে না —
   এটা কার সিদ্ধান্ত, engineer এর না product এর?
5. **মেলানোর job** (code বদলানো): `transaction.ts` এ চারটা পথের পরে একটা "reconcile" লেখো — প্রতিটা workspace এর
   `count(*)` tasks_svc থেকে আর `task_count` billing_svc থেকে, অমিল হলে billing ঠিক করা। দুটো database একই মুহূর্তে পড়া যায়
   না — এর মাঝে নতুন task এলে তোমার job কী ভুল করতে পারে?

## Project Structure

```
lesson-9.1-monolith-vs-microservices/
├── docker-compose.yml   # Postgres 17 (5447), cpus: 2 — taskflow, tasks_svc, billing_svc
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── domain.ts        # tasks, users, comments — তিনটা module এর code (memory তে data), আর export
    ├── service.ts       # একটা process: ROLE = monolith | tasks | users | comments; board এর দুই পথ
    ├── cluster.ts       # process চালানো/মারা (fork, SIGKILL), IPC তে port আর CPU এর হিসাব
    ├── load.ts          # board এর load generator — client, p50/p99, পুরো/comments ছাড়া/error
    ├── latency.ts       # function call বনাম chatty বনাম batched
    ├── failure.ts       # ভারী প্রতিবেশী, crash, availability এর গুণ
    ├── transaction.ts   # এক transaction বনাম দুটো database, crash, আবার চেষ্টা
    └── random.ts        # seed দেওয়া PRNG, percentile, format
```

সব env: `CONCURRENCY` (latency 16, failure 8, transaction 8), `DURATION_MS` (5000), `NET_MS` (0), `EXPORT_MS` (300),
`TIMEOUT_MS` (50), `OPS` (3000), `WORKSPACES` (100), `CRASH_RATE` (0.03), `SEED` (7), `DATABASE_URL`।
