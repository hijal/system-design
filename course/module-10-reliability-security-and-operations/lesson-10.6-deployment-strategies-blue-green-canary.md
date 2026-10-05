# Lesson 10.6 — Deployment: Blue-Green, Canary, Feature Flag, Zero-Downtime Migration

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 5.5):** একটা transaction একটা row এ `UPDATE` করলে সেই row এর lock কখন ছাড়ে — statement শেষ হলে, নাকি transaction শেষ হলে? আর ঠিক তখন আরেকটা transaction সেই row লিখতে চাইলে কী করে? আজ একটা `UPDATE` দেখবে যা মাত্র একটা statement, কিন্তু চলার পুরো ৫ সেকেন্ড TaskFlow এর সব লেখা আটকে রাখে।

**Prerequisite:** Lesson 2.5 (API versioning, idempotency), Lesson 3.4 (Health check, graceful shutdown), Lesson 5.4 (Index, `CONCURRENTLY`), Lesson 5.5 (Lock, transaction), Lesson 7.5 (Event, outbox), Lesson 9.2 (Gateway, BFF), Lesson 10.3 (Blast radius, static stability), Lesson 10.4 (SLI, burn rate)

**তুমি এই lesson শেষে পারবে:**

1. Big-bang, rolling, blue-green আর canary কে দুটো আলাদা প্রশ্ন দিয়ে তুলনা করতে পারবে। প্রথম প্রশ্ন, একটা খারাপ version **কতজনকে** ছোঁয়। দ্বিতীয়, **কে** সেটা ধরে আর কখন। সংখ্যা দিয়ে দেখাতে পারবে কেন একটা alert বাজে না এমন bug শুধু canary ধরে, কেন canary কে user ধরে sticky করতে হয়, আর ছোট canary কেন কম প্রমাণ দেয়
2. একটা instance কে request না হারিয়ে বদলাতে পারবে (readiness → অপেক্ষা → `close()` → চলমান request শেষ)। Deploy আর release আলাদা করতে পারবে feature flag দিয়ে, flag এর সঠিক ভাগ (hash(flag + user)), kill switch আর service জুড়ে একই সিদ্ধান্ত সহ
3. চলমান system এ database এর schema বদলাতে পারবে downtime ছাড়া। কোন DDL পুরো table আটকায়, lock queue কী আর `lock_timeout` কেন, আর expand/contract এর ছয়টা ধাপ। প্রতিটা ধাপে পুরনো আর নতুন code একসাথে চলে আর rollback এর পথ খোলা থাকে

**Tier:** 1 — Runnable Code (তিনটা deterministic simulation; localhost এ আসল HTTP দিয়ে rolling restart; আর আসল PostgreSQL এ দুটো migration lab, Docker দিয়ে)

---

## ০. TaskFlow এখন কোথায়

10.5 এর পরে TaskFlow এর সামনে পরিবর্তনের একটা লম্বা তালিকা। প্রতিটা route কে `loadBoardFor` এ আনা, `Membership` এ নতুন `scope` column, ছয়টা service এ signing key বদলানো, নতুন board editor। TaskFlow এর deploy এর ব্যবস্থা এখন এরকম: প্রতিদিন দুপুর ২টায় একটা pipeline। প্রথমে `sequelize db:migrate`, তারপর ১২টা instance একটা একটা করে বদলানো (rolling)। Instance বদলানো মানে container কে বন্ধ করে নতুনটা চালানো। Node process টা `SIGTERM` এ কিছুই করে না, তাই কয়েক সেকেন্ড পরে orchestrator তাকে `SIGKILL` দিয়ে মেরে ফেলে।

**সোমবার, দুপুর ২টা।** রোজকার মতো দুই মিনিট error এর একটা ঝাঁকুনি। 10.4 এ এটাকেই আমরা "deploy এর noise" বলে alert থেকে বাদ দিয়েছিলাম। এবার একজন engineer খুঁজতে বসল। প্রতিটা restart এ যেসব request তখন চলছিল সেগুলো মরে। Load balancer আরও এক-দুই সেকেন্ড মরা instance এ request পাঠায়। আর নতুন instance cache আর connection pool গরম হওয়ার আগেই traffic পায়। দুজন user এর "task তৈরি" এর POST মাঝপথে কেটে গিয়েছিল। তারা আবার চাপে, আর তৈরি হয় দুটো করে task।

**মঙ্গলবার।** 10.5 এর `Membership.scope` এর migration: `ALTER TABLE memberships ADD COLUMN scope text`। এটা একটা মুহূর্তের কাজ, Postgres শুধু catalog বদলায়। কিন্তু ঠিক তখন support team এর একজন primary database এ একটা report চালাচ্ছিল, যার তখনও তিন মিনিট বাকি। `ALTER` সেই report এর শেষ হওয়ার অপেক্ষায় দাঁড়াল। আর তার পেছনে দাঁড়াল `memberships` ছোঁয় এমন **প্রতিটা** query, মানে TaskFlow এর প্রায় সব request। তিন মিনিট site বন্ধ, একটা "১০ ms এর" migration এর জন্য।

**বুধবার।** Mobile team এর অনুরোধে `boards.title` কে `name` করা হলো, পুরো product এ নামটা এক রাখার জন্য। Migration (`RENAME COLUMN`) চলল deploy এর আগে। Rolling deploy এর ১২ মিনিট ধরে যে instance গুলো এখনও পুরনো code চালাচ্ছিল, সেগুলো প্রতিটা board এ `column "title" does not exist` দিল। তারপর নতুন version এ একটা আলাদা bug পাওয়া গেল, আর rollback করা হলো। পুরনো code ফিরল, কিন্তু column এর নাম তো `name`। এবার **সব** instance এ board ভাঙা, যতক্ষণ না কেউ হাতে উল্টো migration লিখল। পঁচিশ মিনিট।

**বৃহস্পতিবার।** বুধবারের পরে team ভয় পেয়ে `loadBoardFor` এর জন্য blue-green বেছে নিল: "এক click এ rollback।" নতুন stack তৈরি হলো, smoke test পাশ করল, সব traffic এক মুহূর্তে নতুন দিকে গেল। একটা bug ছিল: খুব বড় business workspace এর board এ ২০% request ব্যর্থ। এরা traffic এর ১%। পুরো system এর error rate ০.১% থেকে ০.৩% হলো। কোনো alert বাজল না। এক নম্বর enterprise customer সোমবার জানাল। চার দিন, আর সেই customer এর প্রায় প্রতিটা user ভুক্তভোগী।

**শুক্রবার।** নতুন board editor একটা feature flag এর পেছনে ১০% user এর জন্য চালু হলো। Flag এর code ছিল `Math.random() < 0.1`, প্রতি request এ। User রা refresh করলে editor বদলে যায়। আর BFF আর API নিজে নিজে flag দেখে: BFF নতুন UI দেখায়, API পুরনো আকারের উত্তর দেয়। এক তৃতীয়াংশ request এ "Something went wrong"। Flag বন্ধ করা হলো, কিন্তু instance গুলো config পড়ে প্রতি ৫ মিনিটে।

Postmortem এ CTO এর লাইন: "আমরা প্রতিটা deploy কে একটা লাফ ভেবেছি — এক পাশ থেকে আরেক পাশে। আসলে প্রতিটা deploy একটা সেতু, আর সেতুর উপরে কিছুক্ষণ পুরনো আর নতুন দুজনেই হাঁটে। পুরনো instance আর নতুন instance, পুরনো code আর নতুন schema, পুরনো browser tab আর নতুন API। এই সপ্তাহের প্রতিটা ঘটনা সেতুর মাঝখানে।"

---

## ১. Theory

### ১.১ Deploy একটা লাফ না, একটা সেতু

Google এর SRE বই এর একটা বহুল উদ্ধৃত দাবি আছে: production এর outage এর মোটামুটি ৭০% আসে চলমান system এ কোনো **পরিবর্তন** থেকে (এখানে যাচাই করা না)। সংখ্যাটা যাই হোক, কারণটা সহজ। একটা system যা বদলায় না, সে সাধারণত ভাঙে hardware বা load এ। আর আমরা দিনে কয়েকবার ইচ্ছা করে system বদলাই। তাই deploy এর নকশা reliability এর সবচেয়ে বড় হাতল।

প্রথম শব্দটা আলাদা করা দরকার:

**Deploy / Release** — Deploy মানে নতুন code কে production এর machine এ চালু করা। Release মানে user দের সেই নতুন আচরণ দেখানো। দুটো এক মুহূর্তে হতে হবে এমন কোনো কথা নেই। Code deploy হয়ে বন্ধ অবস্থায় পড়ে থাকতে পারে, আর পরে একটা flag দিয়ে ধাপে ধাপে release হতে পারে। দুটো আলাদা করলে deploy হয় একটা নিরীহ, ঘন ঘন কাজ, আর release হয় একটা নিয়ন্ত্রিত, ফেরানো যায় এমন সিদ্ধান্ত।

আর "সেতু" এর ধারণাটা: যেকোনো deploy এর সময় চার জায়গায় পুরনো আর নতুন একসাথে থাকে।

```
                  পুরনো                        নতুন
instance      ┌─ v1 v1 v1 v1 v1 ─┐  rolling  ┌─ v2 v2 v2 ─┐       (মিনিট)
code ↔ schema │ v1 code, পুরনো column  ⇄  v2 code, নতুন column │       (migration এর আগে-পরে)
client        │ ৮ ঘণ্টা খোলা browser tab, ৬ মাস পুরনো mobile app │       (দিন, মাস)
data / queue  │ v1 এর লেখা event, v1 এর লেখা row  → v2 পড়ে      │       (৭.৫ এর outbox, DLQ এ সপ্তাহ)
```

তাই নিয়মটা এক লাইনে: **প্রতিটা পরিবর্তনকে অন্তত তার আগের version এর সাথে চলতে হবে, দুই দিকে।** নতুন code পুরনো data পড়তে পারবে, আর পুরনো code (rollback হলে) নতুন code এর লেখা data পড়তে পারবে। একে বলে N-1 compatibility। বুধবারের rename এই নিয়মটাই দুই দিকে ভেঙেছিল। এই lesson এর বাকিটা এই সেতুর প্রতিটা অংশ ধরে এগোবে। প্রথমে একটা instance বদলানো (১.২)। তারপর অনেক instance কে কোন ক্রমে বদলাবে (১.৩–১.৪)। তারপর code কে release থেকে আলাদা করা (১.৫), version এর সহাবস্থান (১.৬), আর সবচেয়ে কঠিন অংশ, database (১.৭–১.৮)।

### ১.২ একটা instance বদলানো — graceful shutdown

3.4 এ graceful shutdown এর ধারণা দেখেছিলে, আর বলেছিলাম এর গভীরে যাব এখানে। সোমবারের ঝাঁকুনিটা ঠিক এই জায়গার।

Exercise এর `npm run drain` localhost এ একটা আসল ছোট load balancer (round-robin, health check সহ) আর চারটা আসল `node:http` instance চালায়। ২০০ req/s (৮০% GET, ২০% POST) চলার সময় চারটা instance কে একটা একটা করে বদলায়। প্রতিটা নতুন instance চালু হতে ৮০০ ms লাগে, আর প্রথম ১.৫ সেকেন্ড "ঠান্ডা" থাকে (প্রতি request এ +৪০০ ms)। LB এর health check প্রতি ৫০০ ms এ, পরপর দুবার ব্যর্থ হলে instance বাদ। পাঁচ রকম নকশা:

```
design                                  request   GET fails  POST fails  total failed  > 300 ms     p99
no health check, abrupt kill              3,090        130          35   165 (5.34%)        289   485 ms
health check, abrupt kill                  3,084         88          21   109 (3.53%)        250   482 ms
health check, abrupt kill, LB GET retry    3,132          0          20    20 (0.64%)        254   482 ms
health check, only close() on SIGTERM     3,146        111          36   147 (4.67%)        264   484 ms
graceful: readiness → wait → close       4,252          0           0     0 (0.00%)          3   157 ms
```

(দ্বিতীয় run এ ব্যর্থ ১৬৭, ১০৭, ২০, ১৩৭, ০। আসল HTTP, তাই সংখ্যা একটু নড়ে, কিন্তু ক্রম আর শূন্যটা নড়ে না। Graceful এর run লম্বা, কারণ প্রতিটা instance বন্ধ হওয়ার আগে অপেক্ষা করে, তাই request বেশি।)

এক এক করে:

- **হঠাৎ kill, health check নেই।** চলমান request গুলো মরে। আর restart এর পুরো সময়টা LB মরা port এ request পাঠায়, কারণ সে জানেই না। সোমবার।
- **Health check যোগ করলে** কমে, কিন্তু শূন্য হয় না। LB এর জানতে সময় লাগে (৫০০ ms × ২ পর্যন্ত), আর সেই সময়ে পাঠানো সব request ব্যর্থ।
- **LB এর retry** GET এর সব ব্যর্থতা ঢেকে দেয়। ব্যর্থ connection এর পরে অন্য instance এ আবার পাঠায়। কিন্তু **POST এর ২০টা থেকেই যায়**, কারণ LB জানে না POST টা আবার পাঠানো নিরাপদ কিনা। হয়তো প্রথম instance মরার আগে task টা লিখে ফেলেছিল। 2.5 এর `Idempotency-Key` থাকলে client নিজে নিরাপদে retry করতে পারত। সোমবারের দুটো duplicate task ঠিক এই ফাঁক দিয়ে।
- **শুধু `close()`** অবাক করে: হঠাৎ kill এর চেয়ে প্রায় ভালো না। `server.close()` চলমান request শেষ করতে দেয়, কিন্তু নতুন connection নেওয়া **তখনই** বন্ধ করে। আর LB তখনও এই instance এ পাঠাচ্ছে, কারণ health check এখনও জানে না। সেগুলো `ECONNREFUSED`।
- **Graceful: শূন্য।** পার্থক্যটা **ক্রমে**। প্রথমে instance নিজের readiness কে 503 করে, কিন্তু request নেওয়া চালিয়ে যায়। LB পরের দুটো health check এ সেটা দেখে instance কে সরিয়ে নেয়। তারপর, যখন আর কেউ পাঠাচ্ছে না, তখন `close()`। চলমান request শেষ হয়, তারপর process বের হয়। আর নতুন instance traffic পায় শুধু warm-up এর পরে, কারণ তার readiness সত্যি কথা বলে। তাই "> ৩০০ ms" এর কলামটা ২৮৯ থেকে ৩। ঠান্ডা instance এ পাঠানো request ই ছিল সেই ধীর লেজ।

```
SIGTERM
  │
  ├─► readiness = 503 ─────────── LB health check ×2 ─► LB এর তালিকা থেকে বাদ
  │      (request নেওয়া চলছে)
  ├─► অপেক্ষা  ≥ check interval × fail threshold  (+ একটু margin)
  ├─► server.close()   নতুন connection বন্ধ; idle keep-alive বন্ধ
  ├─► চলমান request শেষ হওয়ার অপেক্ষা   (একটা উপরের সীমা সহ)
  ├─► DB pool, queue consumer বন্ধ
  └─► exit(0)            ── সীমা পেরোলে exit(1), orchestrator এর SIGKILL এর আগে
```

Express এ এর আকৃতি (exercise এর `drain.ts` এর যুক্তি, Express এর ভাষায়, চালানো না):

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

তিনটা জিনিস লক্ষ করো। প্রথমত, `/ready` আর `/health` (liveness, 3.4) আলাদা জিনিস। Readiness মিথ্যা হলে LB traffic সরায়, কিন্তু orchestrator process কে মারে না। দ্বিতীয়ত, `drainMs` কে LB এর health check এর সাথে বাঁধতে হয়। Exercise এ `CHECK_MS × 2 + 500`। Kubernetes এ এটা সাধারণত একটা `preStop` এর অপেক্ষা, কারণ সেখানে endpoint সরানো আর `SIGTERM` প্রায় একসাথে ঘটে। তৃতীয়ত, `hardLimitMs` কে orchestrator এর ধৈর্যের চেয়ে ছোট রাখতে হয় (Kubernetes এর `terminationGracePeriodSeconds`, default ৩০ s)। না হলে নিজের পরিষ্কার exit এর আগেই `SIGKILL` আসে। আর `markWarm()` ডাকা হয় DB connection, cache আর অন্য যা লাগে তা তৈরি হওয়ার পরে।

### ১.৩ চারটা কৌশল — একটা খারাপ version কতজনকে ছোঁয়

একটা instance নিরাপদে বদলানো গেল। এবার প্রশ্ন হলো ১২টাকে কোন ক্রমে বদলাবে। চারটা পরিচিত উত্তর আছে:

- **Big-bang:** সব instance একসাথে নতুন version এ। সরল আর দ্রুত।
- **Rolling:** একটা একটা করে (বা কয়েকটা করে) বদলানো। সোমবারের TaskFlow এটাই করে। বাড়তি machine লাগে না, কিন্তু মাঝখানে দুই version একসাথে চলে।

**Blue-Green Deployment** — দুটো পুরো, সমান environment। "Blue" এখন traffic পাচ্ছে, "green" এ নতুন version তৈরি আর পরীক্ষা করা হয়। তারপর load balancer (বা DNS) এক মুহূর্তে সব traffic green এ সরায়। Rollback মানে আবার blue তে সরানো, কয়েক সেকেন্ডে, কারণ blue এখনও চলছে। দাম হলো switch এর সময়টায় দ্বিগুণ capacity। আর database সাধারণত দুটোরই এক, তাই "instant rollback" শুধু code এর, data এর না।

**Canary Release** — নতুন version কে প্রথমে traffic এর একটা ছোট অংশে দেওয়া (ধরো ১%), তার SLI কে একই সময়ের পুরনো version এর (baseline) সাথে তুলনা করা, আর ভালো হলে ধাপে ধাপে বাড়ানো (১% → ৫% → ২৫% → ১০০%)। তুলনাটা একটা স্বয়ংক্রিয় **gate** করলে খারাপ version মানুষ জাগার আগেই ফেরত যায়। নামটা খনির ক্যানারি পাখি থেকে, যে বিষাক্ত গ্যাসে আগে অসুস্থ হয়ে খনি শ্রমিকদের সতর্ক করত।

`npm run rollout` এ ৩০০ req/s, ৬০,০০০ user, দুই ঘণ্টা দেখা হয়েছে। TaskFlow এর alert আছে (৫ মিনিটের error > ১% বা ধীর > ৫%), আর alert বাজার পরে মানুষের সিদ্ধান্ত নিতে ১০ মিনিট লাগে (ধরে নেওয়া)। Canary তে আছে z-test এর একটা gate (canary বনাম baseline, ১.৪ এ বিস্তারিত)। তিন রকম bug:

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

**প্রথম bug (সবার জন্য ২%)।** Big-bang আর blue-green এক মিনিটে ধরা পড়ে। Alert সঙ্গে সঙ্গে বাজে, কারণ সবাই নতুন version এ। কিন্তু "ধরা পড়া" আর "ক্ষতি থামা" আলাদা। ধরা পড়ার পরে মানুষের ১০ মিনিট, তারপর rollback। Blue-green এর rollback ৩০ সেকেন্ডে (switch ফেরানো), big-bang এর ৫ মিনিটে (আবার deploy), তাই ১১ বনাম ১৬ মিনিট। পুরো সময়টা **সবাই** নতুন version এ: ৪–৫ হাজার খারাপ request, ৭–৯% user। Rolling ধীরে ধরা পড়ে (১২ মিনিট), কারণ মোট error ১% পেরোয় শুধু যখন প্রায় অর্ধেক instance (১২টার ৬টা) নতুন version এ, আর alert এর ৫ মিনিটের window কে সেটা টের পেতে হয়। আর ফেরাতেও সময় লাগে। Canary এর ক্ষতি **চার থেকে আটটা request**, মানুষ জানার আগেই। এটাই canary এর মূল কথা: সে bug খুঁজে পাওয়া দ্রুত করে না, **bug কে ছোট রাখে যখন খুঁজে পাওয়া হচ্ছে।**

**দ্বিতীয় bug (বৃহস্পতিবার)।** ১% traffic এ ২০% error মানে মোট error ০.১% থেকে ০.৩%। কোনো alert এর সীমা ছোঁয় না। প্রথম তিনটা কৌশলে **কেউ কখনো ধরে না।** দুই ঘণ্টায় ৫৮২ জন business user, মানে সেই segment এর প্রায় সবাই, ক্ষতিগ্রস্ত। আর আসলে ক্ষতি চলতেই থাকে, যতক্ষণ না customer ফোন করে। Canary ধরে ৫% এর ধাপে: canary বনাম baseline এর তুলনায় ০.২% এর পার্থক্যও যথেষ্ট request পেলে পরিষ্কার দেখা যায়, যেটা "error > ১%" এর মতো স্থির সীমা কখনো দেখবে না। পাঁচটা খারাপ request। Blue-green এখানে একটা মিথ্যা নিরাপত্তা দিয়েছিল: "instant rollback" কাজে লাগে শুধু যদি কেউ জানে যে rollback করতে হবে।

**তৃতীয় bug (error নেই, শুধু ধীর)।** এখানে দুটো canary ব্যর্থ, কারণ তাদের gate শুধু error দেখে। নতুন version কোনো error দেয় না, শুধু ১০% request এক সেকেন্ডের বেশি নেয়। তাই সে প্রতিটা ধাপ পেরিয়ে ১০০% এ পৌঁছায়, আর ৩২ মিনিটে alert বাজে। Big-bang এর মতোই ক্ষতি, শুধু দেরিতে। শেষ সারির gate latency (canary এর ধীর অনুপাত বনাম baseline) আর segment দুটোই দেখে, আর **এক মিনিটে, ১% এ** ধরে। শিক্ষা: **canary ততটাই ভালো, যতটা তার gate যা দেখে।** 10.4 এর SLI গুলো (সফলতা **আর** latency), আর গুরুত্বপূর্ণ segment (plan, region, বড় customer) — সব gate এ থাকতে হয়।

**ভালো version এর দাম।** একই কৌশল, কোনো bug ছাড়া:

```
strategy                                   reaches 100%  extra capacity  bad rollback
big-bang (all at once)                           1.0 min             0           no
rolling (one per 2 minutes)                     22 min            −1           no
blue-green                                          0 s             +12           no
canary (all three)                                  30 min              +3            no
```

প্রতিটা কৌশল কিছু একটা দিয়ে নিরাপত্তা কেনে। Big-bang কিছুই দেয় না, তাই কিছুই পায় না। Rolling সময় দেয় (আর deploy এর সময়ে এক instance কম capacity)। Blue-green টাকা দেয় (দ্বিগুণ machine, অন্তত কিছুক্ষণ)। Canary সময় দেয় (৩০ মিনিট), কিছু বাড়তি instance, আর সবচেয়ে বড় কথা, **একটা ভালো gate বানানোর পরিশ্রম**। আর এগুলো একে অপরকে বাদ দেয় না। বাস্তবে প্রায়ই blue-green এর দুটো pool এর মাঝে canary এর মতো ধাপে traffic সরানো হয়, বা rolling এর প্রতিটা ধাপে একটা gate বসানো হয়।

### ১.৪ Canary এর ভেতরের অঙ্ক — কত বড়, কতক্ষণ, কাদের

Canary এর gate একটা পরিসংখ্যানের প্রশ্নের উত্তর দেয়: "canary এর error অনুপাত কি baseline এর চেয়ে বেশি, নাকি এটা ভাগ্য?" Exercise এর gate একটা two-proportion z-test (দুটো অনুপাতের পার্থক্যকে তার প্রত্যাশিত এলোমেলো ওঠানামা দিয়ে ভাগ করা)। z > ৩ হলে "আসল পার্থক্য"। `npm run rollout` এর অংশ গ তে baseline error ০.১%, প্রতিটা ঘর ৪০০বার চালানো:

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

তিনটা শিক্ষা:

1. **বড় regression যেকোনো canary ধরে।** +১% (দশ গুণ error) এর জন্য ১% এ ৫ মিনিটই যথেষ্ট, ক্ষতি ৯টা request। এজন্যই প্রথম ধাপ ছোট রাখা হয়: সবচেয়ে খারাপ ভুল গুলো সবচেয়ে সস্তায় ধরা পড়ে।
2. **ছোট regression এর জন্য প্রমাণ লাগে, আর প্রমাণ মানে request।** +০.২% (বৃহস্পতিবারের মতো) ধরার সম্ভাবনা ১% এ ৫ মিনিটে ২৫%, ৫% এ ১০ মিনিটে ৯৫%। প্রমাণ আসে canary request এর সংখ্যা থেকে, তাই শতাংশ ছোট করলে সময় বাড়াতে হয়। আর শেষ কলাম দেখায় এর উল্টো দিক: যত বেশি request canary তে, bug থাকলে তত বেশি ক্ষতি। এটা একটা আসল trade-off, কোনো জাদুর সংখ্যা নেই। **কম traffic এর service এ** (ধরো billing এর webhook, সেকেন্ডে ২টা) ১% এর canary কখনোই যথেষ্ট প্রমাণ জোগাড় করবে না। সেখানে লাগে বড় শতাংশ, লম্বা সময়, বা অন্য পথ (reflection question ২)।
3. **বারবার দেখলে ভুল alarm বাড়ে।** সময় শেষে একবার দেখলে ভুল alarm ১.০–১.৫%। প্রতি মিনিটে "দেখে নিই, z > ৩ কিনা" করলে ৩০ মিনিটে ৫.৫%। প্রতিটা দেখা একটা নতুন সুযোগ, ভাগ্যের ওঠানামা সীমা পেরোনোর। একে বলে peeking বা multiple testing। আর ভুল alarm এর দাম আছে: একটা ভালো version ফেরত যায়, engineer রা gate কে অবিশ্বাস করা শুরু করে। প্রতিকার: প্রতি ধাপে একটা ন্যূনতম request সংখ্যা আর সময়, বারবার দেখার জন্য কঠোর সীমা, অথবা sequential test এর মতো এর জন্যই বানানো পদ্ধতি।

**Baseline কে?** তুলনা হয় **একই সময়ের** পুরনো version এর সাথে, গতকালের সাথে না। দুপুর ২টার traffic, একই cache এর অবস্থা, একই dependency এর মেজাজ। তাই অনেক নকশায় canary এর পাশে একটা সমান আকারের, **নতুন করে চালু করা** পুরনো version এর pool রাখা হয় ("baseline canary")। তাতে নতুন process এর ঠান্ডা cache এর প্রভাব দুই দিকেই সমান থাকে। (Argo Rollouts, Flagger, Spinnaker এর Kayenta এই ধরনের স্বয়ংক্রিয় বিশ্লেষণ করে। এখানে চালানো না।)

**কাদের canary তে পাঠাবে।** `npm run rollout` এর অংশ ঘ তে canary ৫% এ এক ঘণ্টা থাকে:

```
routing              saw the new version  switched between versions
random per request     35,663 (59%)            35,663 (59%)
sticky per user           2,963 (5%)                  0 (0%)
```

Request এলোমেলো ভাগ করলে ৫% এর canary আসলে **৫৯% user** ছোঁয়। প্রত্যেক user ঘণ্টায় ~১৮টা request করে, তাদের কোনো একটা canary তে পড়লেই হলো। আর সেই ৫৯% দুই version এর মাঝে লাফায়: একবার নতুন UI, পরের click এ পুরনো। Bug থাকলে অভিযোগ আসে প্রায় সবার কাছ থেকে, আর debug করা কঠিন, কারণ একই user এর দুই রকম অভিজ্ঞতা। User (বা workspace) এর id এর hash ধরে canary বাছলে ৫% মানে সত্যিই ৫% মানুষ, প্রতিবার একই মানুষ। Blast radius (10.3) মাপা যায়, আর মানুষের কাছে আচরণ স্থির থাকে।

আর **segment**: বৃহস্পতিবারের bug ছিল ১% traffic এ। Exercise এর experiment ১ (`STEP_MINUTES=3`) এ ধাপ ছোট করলে শুধু-error gate এর sticky canary এটা **একদমই** ধরে না। প্রতিটা ধাপে segment এর request এত কম যে গড়ে পার্থক্য ডুবে যায়, আর bug ১০০% এ পৌঁছায় (৩,৮৫৭টা খারাপ request, ৫৮২ জন)। Segment-aware gate (plan ধরে আলাদা তুলনা) একই bug ৪ মিনিটে ধরে। Gate এর segment গুলো আসে ঠিক সেখান থেকে, যেখানে তোমার customer রা আলাদা: plan, region, workspace এর আকার, client (web, mobile)।

### ১.৫ Feature Flag — deploy থেকে release আলাদা করা

**Feature Flag** — code এর ভেতরে একটা শর্ত (`if (flags.isOn('new-editor', user))`), যার মান code বদলানো বা deploy ছাড়াই, চলমান অবস্থায়, বাইরের একটা config থেকে বদলানো যায়। চারটা আলাদা কাজে ব্যবহার হয়, আর প্রতিটার আয়ু আলাদা। **Release flag** নতুন feature ধাপে ধাপে চালু করে, দিন বা সপ্তাহ বাঁচে, তারপর মুছে ফেলতে হয়। **Ops flag বা kill switch** চাপের সময় কোনো অংশ বন্ধ করে (10.3 এর brownout), স্থায়ী। **Experiment flag** A/B test এর জন্য। **Permission flag** plan ধরে feature দেয়।

Flag দিয়ে deploy আর release আলাদা হয়ে যায়। নতুন editor এর code মঙ্গলবার deploy হতে পারে, বন্ধ অবস্থায়, আর তার ঝুঁকি প্রায় শূন্য। Release হয় বৃহস্পতিবার, ১% user এ, flag এর একটা click এ। Canary আর flag একই ধারণার দুই স্তর। Canary নতুন **binary** কে ধাপে ধাপে ছড়ায়, flag নতুন **আচরণ** কে। আর flag এর ধাপের মধ্যে কোনো deploy লাগে না।

কিন্তু শুক্রবার দেখাল, flag এর তিনটা জিনিস ভুল করা সহজ। `npm run flags`:

**(ক) কীভাবে ভাগ করবে।** ৬০,০০০ user, প্রত্যেকে দিনে ২০টা page, দুটো আলাদা flag ১০% করে:

```
how it splits          saw the new  saw both (flip)  in both flags
random per request      52,705 (88%)              52,705             46,134
hash(user)                   5,869 (10%)                   0              5,869
hash(flag + user)            6,041 (10%)                   0                616
```

শুক্রবারের `Math.random() < 0.1`: ১০% এর flag **৮৮%** user কে নতুন editor দেখায়, আর তাদের সবাই দুই editor এর মাঝে লাফায়। `hash(user)` এই লাফ থামায়, কিন্তু আরেকটা সূক্ষ্ম ফাঁদ আছে। দুটো আলাদা flag এ **একই ৫,৮৬৯ জন** পড়ে। প্রতিটা ১০% experiment এ একই মানুষ গিনিপিগ, আর দুটো experiment এর ফল একে অপরের সাথে মিশে যায়। Flag এর নাম hash এ মেশালে (`hash(flag + user)`) প্রতিটা flag এর ১০% স্বাধীন: দুটোতেই আছে ৬১৬ জন, প্রত্যাশিত ১% এর কাছাকাছি।

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

আর একটা সুবিধা: ১০% থেকে ২৫% এ বাড়ালে আগের ১০% এর সবাই ২৫% এর ভেতরেই থাকে, কারণ তাদের bucket এর মান বদলায়নি, সীমা সরেছে। কেউ নতুন feature পেয়ে হারায় না।

**(খ) Kill switch কত দ্রুত।** ১২টা instance, নতুন feature এ ১০০ req/s, তার ২০% ব্যর্থ। "বন্ধ করো" সিদ্ধান্তের পরে:

```
how it turns off           all off (avg)          worst    bad requests (avg)
flag, poll every 5 minutes                4.6 min        5.0 min            2,998
flag, poll every 30 s                          28 s            30 s                300
flag, streaming push                            3 s             3 s                 40
no flag: rollback deploy                     11 min          11 min            9,900
```

Flag না থাকলে বন্ধ করা মানে rollback deploy (pipeline ৫ মিনিট + rolling)। ৯,৯০০টা খারাপ request। Streaming push এ ৪০। মাঝের সারি দুটো দেখায় poll এর interval কোথায় দাম নেয়। আর 10.3 এর static stability মনে রাখো: flag service মরে গেলে instance শেষ জানা মান ধরে চলে। তাই kill switch এর জন্য একটা দ্বিতীয় পথ রাখা ভালো (ধরো deploy ছাড়া বদলানো যায় এমন environment এর config), যাতে ঠিক যে মুহূর্তে flag service ও মরা, তখনও feature বন্ধ করা যায়।

**(গ) দুই service, একটা সিদ্ধান্ত।** BFF নতুন UI দেখায়, API নতুন আকারের উত্তর দেয়। ১০ মিনিট, ৫ মিনিটে flag ১০% থেকে ৫০%:

```
who decides, how                          request  UI/API mismatch
both hash(user), config at the same moment  180,000        0 (0.00%)
BFF hash(user), API hash(session)               180,000   61,331 (34.07%)
both hash(user), each polls every 30 s   180,000    1,154 (0.64%)
BFF decides once, sends it in a header     180,000        0 (0.00%)
```

শুক্রবারের দ্বিতীয় সারি: একজন session ধরে hash করছিল, আরেকজন user ধরে। **এক তৃতীয়াংশ request** এ UI আর API দুই version এ। আর একই hash হলেও (তৃতীয় সারি), দুই service আলাদা মুহূর্তে নতুন শতাংশ জানে, তাই ১০%→৫০% এর পরের কয়েক সেকেন্ডে অমিল হয়। Experiment ৩ এ poll ৫ মিনিট করলে ৬.৫৩%। উপায় শেষ সারিটা: **সিদ্ধান্ত একবার নাও, তারপর পাঠাও।** BFF (বা gateway) flag দেখে, আর নিচের service কে header এ বলে দেয় (`x-flags: task-api-v2`)। 10.4 এর trace id এর একই যুক্তি: যা পুরো request জুড়ে একই থাকতে হবে, সেটা একবার ঠিক হয় আর সাথে যায়। আর 10.5 এর শিক্ষা মনে রাখো: gateway client এর পাঠানো `x-flags` ফেলে দেয়, নইলে যে কেউ নিজের জন্য flag চালু করতে পারে।

**Flag এর ঋণ।** প্রতিটা flag code এ দুটো পথ বানায়, আর দুটো flag চারটা। Release flag ১০০% এ পৌঁছানোর পরে মুছে ফেলতে হয়, code সহ। প্রতিটা flag এর একজন মালিক আর একটা মেয়াদের তারিখ রাখা একটা সাধারণ নিয়ম। আর **কখনো একটা পুরনো flag এর নাম নতুন কাজে পুনর্ব্যবহার কোরো না।** এর সবচেয়ে বিখ্যাত উদাহরণ Knight Capital (২০১২), প্রকাশিত বিবরণ অনুযায়ী (এখানে যাচাই করা না)। একটা পুরনো, অব্যবহৃত flag কে নতুন code এ অন্য অর্থে ব্যবহার করা হয়েছিল। ৮টা server এর একটায় নতুন code deploy হয়নি। সেখানে flag টা চালু হতেই বহু বছরের পুরনো, মরা একটা code পথ জেগে উঠল। ৪৫ মিনিটে প্রায় ৪৪ কোটি ডলারের ক্ষতি। একটা ঘটনায় এই lesson এর তিনটা শিক্ষা: version skew (১.৬), flag এর ঋণ, আর deploy এর ব্যর্থতা ধরার স্বয়ংক্রিয় ব্যবস্থার অভাব।

### ১.৬ Version skew — পুরনো আর নতুন একসাথে

**Version Skew** — একটা system এর বিভিন্ন অংশ একই মুহূর্তে আলাদা version এ চলা: rolling deploy এর মাঝে instance, client আর server, producer আর consumer, code আর schema। এটা ব্যতিক্রম না, স্বাভাবিক অবস্থা। তাই প্রতিটা পরিবর্তনকে N আর N-1 দুটোর সাথেই চলতে হবে, আর rollback নিরাপদ রাখতে হলে **নতুন version এমন কিছু লিখবে না যা পুরনো version পড়তে পারে না।**

চারটা জায়গা, চারটা নিয়ম:

- **API (server ↔ client):** field যোগ করো, মুছো না, নাম বদলিও না, এক ধাপে না। Client এর দিকে "tolerant reader": অজানা field উপেক্ষা করো, অনুপস্থিত ঐচ্ছিক field এর জন্য default রাখো। Browser এর tab ঘণ্টার পর ঘণ্টা পুরনো JavaScript চালায়। Mobile app মাস ধরে পুরনো থাকে (2.5 এর versioning)।
- **Event / queue (producer ↔ consumer):** 7.5 এর outbox এর event কয়েক সেকেন্ড, আর DLQ এ (7.4) সপ্তাহ পরে পড়া হতে পারে। নতুন field যোগ করলে আগে consumer কে deploy করো, যাতে সে নতুন আর পুরনো দুই আকারই বোঝে। তারপর producer। (Producer আগে গেলে পুরনো consumer নতুন event এ কী করবে? উপেক্ষা, নাকি poison message?)
- **Service ↔ service:** 9.2 এর internal API এর একই নিয়ম, আর deploy এর ক্রম: যে নতুন জিনিস **বোঝে**, সে আগে। যে নতুন জিনিস **পাঠায়**, সে পরে।
- **Code ↔ schema:** সবচেয়ে কঠিন, কারণ database একটাই আর সবাই তাকে ভাগ করে। পরের দুটো অংশ এর।

এখানে 10.5 এর key rotation এর কথা মনে করো। প্রথমে সব service এ **দুটো** key দিয়ে যাচাই, তারপর নতুন key দিয়ে sign, তারপর পুরনো key সরানো। এটা ঠিক এই নিয়ম: প্রথমে নতুন জিনিস **বোঝা**, তারপর **পাঠানো**, তারপর পুরনোটা মুছে ফেলা। ১.৮ এ এই একই ছক database এ দেখব।

### ১.৭ Database এর পরিবর্তন — কোনটা আটকায়, আর lock এর লাইন

মঙ্গলবারের রহস্য: একটা `ADD COLUMN`, যা মুহূর্তে শেষ হওয়ার কথা, কীভাবে তিন মিনিট site বন্ধ রাখল?

Postgres এ প্রায় প্রতিটা `ALTER TABLE` table এর উপর **ACCESS EXCLUSIVE** lock চায়। এটা সবচেয়ে কঠোর lock: সে থাকলে কেউ table পড়তেও পারে না। কাজটা যদি মুহূর্তের হয় (শুধু catalog বদলানো), তাহলে কেউ টেরও পায় না। কিন্তু lock টা **পেতে** হলে আগের সব lock ছাড়া পর্যন্ত অপেক্ষা করতে হয়, আর একটা সাধারণ `SELECT` ও table এ একটা হালকা lock (ACCESS SHARE) রাখে তার transaction শেষ হওয়া পর্যন্ত। এখানেই মারটা: **অপেক্ষারত ACCESS EXCLUSIVE এর পেছনে নতুন আসা প্রতিটা query দাঁড়ায়।** এমনকি সাধারণ `SELECT` ও, যদিও সে নিজে লম্বা report এর সাথে বিরোধ করে না। Postgres lock এর অনুরোধ ক্রমে দেয়, যাতে `ALTER` চিরকাল না-খেয়ে থাকে।

**Lock Queue** — একটা lock এর জন্য অপেক্ষারত অনুরোধের সারি। একটা DDL যখন একটা লম্বা transaction এর পেছনে ACCESS EXCLUSIVE এর জন্য অপেক্ষা করে, তার পেছনে সব নতুন query (পড়াও) সারিতে দাঁড়ায়, তাই মুহূর্তের একটা DDL পুরো table কে লম্বা transaction এর বাকি সময় পর্যন্ত বন্ধ রাখে। প্রতিকার `lock_timeout`: নির্দিষ্ট সময়ে lock না পেলে DDL হাল ছেড়ে দেয় (আর সারি খুলে যায়), তারপর একটু পরে আবার চেষ্টা।

```
সময় →
report (BEGIN; SELECT …)  ████████████████████████████████████████▶ COMMIT
ALTER TABLE …                  ⏳ ACCESS EXCLUSIVE এর অপেক্ষা ……………………▶ ✓ (১০ ms)
app SELECT                        ⏳ ALTER এর পেছনে …………………………………▶ ✓
app UPDATE                          ⏳ …………………………………………………………………▶ ✓
app SELECT                             ⏳ …………………………………………………………▶ ✓
```

`npm run locks` আসল Postgres 17 এ চলে, `tasks` table এ ১০ লাখ row, আর পাশে ৮টা worker সারাক্ষণ id ধরে `SELECT` আর `UPDATE` করছে (চলমান app)। প্রতিটা পরিবর্তনের সময় app কী অনুভব করল:

```
change                                      time   app op   read max     write max     > 500 ms
ADD COLUMN archived boolean DEFAULT false      10 ms       15          2 ms           3 ms          0
ADD COLUMN score float DEFAULT random()       669 ms       38        646 ms         646 ms          8
ADD COLUMN priority int, behind a 6 s query  6.05 s      476        5.70 s         5.70 s          8
   the ALTER itself waited 5.71 s — and everyone behind it
the same, lock_timeout 200 ms + retry         6.38 s    7,421        200 ms         202 ms          0
   6 attempts, each giving up and stepping aside after 200 ms
```

- **ধ্রুবক default এর `ADD COLUMN`: ১০ ms।** Postgres 11 থেকে ধ্রুবক default শুধু catalog এ লেখা হয়, row ছোঁয়া হয় না।
- **`DEFAULT random()`: ৬৬৯ ms, পুরো সময় সব read আর write আটকে।** Volatile (প্রতি row এ আলাদা মান) default মানে Postgres কে প্রতিটা row এ আলাদা মান লিখতে হবে, তাই পুরো table **নতুন করে লেখে**, ACCESS EXCLUSIVE ধরে রেখে। ১০ লাখ row এ ৭০০ ms, ১০ কোটিতে এক মিনিটের বেশি। দেখতে প্রায় একই দুটো লাইন, একটা মুহূর্তের, আরেকটা পুরো site এর বিরতি।
- **Lock queue: ৫.৭ সেকেন্ড।** একটা ৬ সেকেন্ডের query খোলা, তার মধ্যে `ADD COLUMN priority int` (নিজে মুহূর্তের)। App এর **সব** worker ৫.৭ সেকেন্ড আটকে, এমনকি সাধারণ `SELECT` ও। ৬ সেকেন্ডে app ৪৭৬টা কাজ করতে পারল, যেখানে স্বাভাবিকভাবে ~৭,৪০০টা করে। মঙ্গলবার, ছোট আকারে।
- **`lock_timeout` + retry: সর্বোচ্চ ২০০ ms।** একই অবস্থা, কিন্তু `ALTER` ২০০ ms এ lock না পেলে হাল ছেড়ে দেয়, এক সেকেন্ড পরে আবার চেষ্টা করে। ছয়বার ব্যর্থ, সপ্তমবার report শেষ হয়ে গেছে। App প্রতিবার সর্বোচ্চ ২০০ ms অপেক্ষা করেছে, আর ৭,৪২১টা কাজ করেছে, মানে প্রায় স্বাভাবিক।

**Index আর backfill:**

```
change                                      time   app op   read max     write max     > 500 ms
CREATE INDEX                                  209 ms       22          0 ms         198 ms          0
CREATE INDEX CONCURRENTLY                     332 ms      455          1 ms           3 ms          0
all in one UPDATE                            4.92 s      483          0 ms         4.83 s          8
in batches (10,000 each, 20 ms apart)     6.16 s    8,271          0 ms          36 ms          0
```

- **`CREATE INDEX` লেখা আটকায়, পড়া না।** এটা SHARE lock নেয়: read চলে, write অপেক্ষা করে (সর্বোচ্চ ১৯৮ ms)। ১০ লাখ row এ ছোট শোনায়। ৫.৪ এ বলেছিলাম ১০ কোটিতে এটা মিনিট। `CONCURRENTLY` ধীর (৩৩২ ms), কিন্তু write এর সর্বোচ্চ ৩ ms। দুটো দাম আছে: এটা transaction এর ভেতরে চলে না, আর মাঝপথে ব্যর্থ হলে একটা `INVALID` index রেখে যায়, যাকে মুছে আবার চালাতে হয়।
- **একটা `UPDATE` এ backfill: সব write ৪.৮ সেকেন্ড আটকে।** **Spaced repetition এর উত্তর:** row এর lock ছাড়ে **transaction** শেষে, statement শেষে না। একটা `UPDATE tasks SET priority = 0` একটাই statement, একটাই transaction। সে যে row ছোঁয়, তার lock তার শেষ পর্যন্ত ধরে রাখে। ৪.৯ সেকেন্ডে ধীরে ধীরে ১০ লাখ row এর lock জমে। App এর যে `UPDATE` এমন একটা row এ পড়ে যা backfill ইতিমধ্যে ছুঁয়েছে, সে backfill এর **শেষ** পর্যন্ত অপেক্ষা করে। আর এর পাশে আরও দুটো দাম, যা এখানে মাপা না: এক বিশাল WAL এর ঢেউ, যা replica কে পিছিয়ে দেয় (5.7, 6.3), আর ১০ লাখ dead tuple, যা vacuum কে দিতে হয়।
- **Batch এ: write এর সর্বোচ্চ ৩৬ ms।** ১০০টা ছোট transaction, প্রতিটা ১০,০০০ row, মাঝে একটু বিরতি। মোট সময় একটু বেশি (৬.২ s), কিন্তু app প্রায় টেরই পায়নি। বাস্তবে batch এর আকার আর বিরতি replica lag দেখে ঠিক করা হয়: lag বাড়লে ধীর হও।

**NOT NULL:**

```
SET NOT NULL (directly)                     153 ms       23        140 ms         140 ms          0
CHECK NOT VALID → VALIDATE → SET NOT NULL     111 ms      156          2 ms           4 ms          0
   NOT VALID 5 ms, VALIDATE 78 ms (lock: SHARE UPDATE EXCLUSIVE), SET NOT NULL 5 ms (scan skipped), DROP CHECK 5 ms
```

`SET NOT NULL` কে পুরো table পড়ে দেখতে হয় কোনো null আছে কিনা, আর সেটা করে ACCESS EXCLUSIVE ধরে। ১০ লাখ row এ ১৪০ ms সব আটকে। কৌশলটা: আগে একটা `CHECK (priority IS NOT NULL) NOT VALID` constraint যোগ করো। এটা মুহূর্তের, কারণ পুরনো row যাচাই হয় না, শুধু নতুন লেখা। তারপর `VALIDATE CONSTRAINT`। এটা পুরো table পড়ে, কিন্তু একটা হালকা lock (SHARE UPDATE EXCLUSIVE) দিয়ে, যা read বা write আটকায় না। তারপর `SET NOT NULL`। Postgres 12 থেকে একটা বৈধ CHECK constraint থাকলে সে scan বাদ দেয় (৫ ms)। শেষে CHECK টা মুছে ফেলো।

**নিয়মগুলো এক জায়গায়:**

1. প্রতিটা migration এ `lock_timeout` (কয়েক সেকেন্ড বা কম) আর retry। আর সাথে `statement_timeout`, যাতে ভুলে একটা লম্বা DDL না চলে।
2. Default শুধু ধ্রুবক। Volatile মান লাগলে column যোগ করো null দিয়ে, তারপর batch এ backfill।
3. Index সবসময় `CONCURRENTLY`। ব্যর্থ হলে `INVALID` index খুঁজে মুছো।
4. Backfill batch এ, ছোট transaction এ, replica lag দেখে।
5. `NOT NULL`, foreign key, CHECK: আগে `NOT VALID`, তারপর আলাদা করে `VALIDATE`।
6. Migration এর সময় primary তে লম্বা query নেই (7.6 এর OLAP replica তে)। আর migration এর আগে `pg_stat_activity` তে দেখে নাও।

Sequelize এ migration এর ভেতরে `lock_timeout` বসানোর সাবধান পথ হলো transaction এর ভেতরে `SET LOCAL`। Pool এ সাধারণ `SET` দিলে সেটা কোন connection এ গেল, আর পরের query একই connection এ যাবে কিনা, তার কোনো নিশ্চয়তা নেই (5.6)। আর lock না পেলে retry:

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

(`55P03` হলো Postgres এর `lock_not_available`। Sequelize এর `DatabaseError` আসল pg error কে `parent` এ রাখে। তাই `unknown` থেকে ধাপে ধাপে narrow করা হয়েছে, `any` ছাড়া। `CREATE INDEX CONCURRENTLY` transaction এ চলে না, তাই তার জন্য migration চালানো DB user এর উপরেই `ALTER ROLE migrator SET lock_timeout = '2s'` দেওয়া একটা পরিষ্কার পথ।)

### ১.৮ Expand / Contract — rename এর সঠিক পথ

এবার বুধবার। Column এর নাম বদলানো এক ধাপে করা যায় না। এমন কোনো মুহূর্ত নেই যখন সব instance একসাথে পুরনো নাম থেকে নতুন নামে যায়। Migration আগে হলে পুরনো code ভাঙে, পরে হলে নতুন code ভাঙে। `npm run rename` আসল Postgres আর Sequelize এ চলে, `boards` table এ ২০,০০০ row। চারটা instance, প্রত্যেকে দুটো loop এ (৬০% পড়া, ৩৫% লেখা, ৫% নতুন board) টানা কাজ করে। Rolling এ প্রতি সেকেন্ডে একটা instance নতুন version এ যায়। চার রকম app version, প্রতিটা একটা আলাদা Sequelize model দিয়ে একই table দেখে:

```
v1   = title পড়ে, title লেখে                      (আজকের code)
v1.5 = title আর name দুটোতেই লেখে, title পড়ে
v2r  = দুটোতেই লেখে, name পড়ে
v2   = শুধু name পড়ে আর লেখে                       (শেষ লক্ষ্য)
```

**এক ধাপে (বুধবার):**

```
step                                        running   op    error  misreads
migration first, then deploy               v1 → v2   9,544    4,223          0
   v1: column "title" of relation "boards" does not exist
deploy first, then migration               v1 → v2   9,905    4,193          0
   v2: column "name" of relation "boards" does not exist
then rollback (migration not reverted)  v2 → v1   8,306    4,219          0
   v1: column "title" does not exist
```

ছয় সেকেন্ডে চার হাজারের বেশি error, তিনটা ক্রমের প্রতিটায়। আর তৃতীয় সারিটা বুধবারের সবচেয়ে খারাপ অংশ: rollback ও ভেঙেছে, কারণ schema ফেরেনি। Code এর rollback আর data এর rollback আলাদা জিনিস।

**Expand / Contract** — একটা ভাঙা পরিবর্তনকে (rename, আকার বদল, বিভাজন) কয়েকটা ছোট ধাপে ভাগ করা, যার প্রতিটা নিজে নিজে deploy করা যায় আর ফেরানো যায়, আর প্রতিটা ধাপে পুরনো আর নতুন code দুটোই চলে। আগে **expand**: নতুন জিনিসটা পাশে যোগ করো, দুটোতে লেখো, পুরনো data নতুন জায়গায় আনো, পড়া নতুন জায়গায় সরাও। শেষে **contract**: যখন আর কেউ পুরনোটা ব্যবহার করে না, তখন সেটা মুছে ফেলো। একে "parallel change" ও বলে।

```
ধাপ   schema                           code (rolling)          rollback নিরাপদ?
১     + name (null), title NOT NULL তোলা    v1                      হ্যাঁ (কিছুই ব্যবহার করে না)
২                                       v1 → v1.5 (দুটোতে লেখা)   হ্যাঁ → v1
৩     backfill: name = title (batch)     v1.5                    হ্যাঁ
৪                                       v1.5 → v2r (name পড়া)     হ্যাঁ → v1.5 (দুটোতে লেখা চলছে)
৫                                       v2r → v2 (শুধু name লেখা)  ✗ v1.5 আর না — title পুরনো হচ্ছে
৬     − title  (অপেক্ষার পরে)            v2                      ✗
```

আর মাপা ফল:

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

প্রতিটা ধাপে শূন্য error, শূন্য ভুল পড়া। আর মাঝখানে একটা rollback, সেটাও শূন্য। দাম হলো একটা পরিবর্তনের জন্য **চারটা deploy আর দুটো migration**, কয়েক দিন বা সপ্তাহ জুড়ে। এটাই zero-downtime এর আসল দাম: সময় আর ধৈর্য, কোনো যন্ত্র না।

ধাপ ৫ এর পরের দাগটা লক্ষ করো। ধাপ ৫ এ v2 শুধু `name` এ লেখে, `title` পুরনো হতে থাকে। এখন v1.5 এ rollback করলে v1.5 পুরনো `title` পড়বে। Experiment ৬ এ নিজে দেখো। তাই ধাপ ৫ হলো **point of no return**, আর তার আগে নতুন version কে যথেষ্ট সময় দাও (ধরো এক সপ্তাহ, পুরো একটা ব্যবসার চক্র)। আর ধাপ ৬ এর আগে নিশ্চিত হও যে কোথাও কেউ `title` পড়ছে না: অন্য service, report, ETL, data warehouse এর sync।

**চারটা পরিচিত ভুল**, প্রতিটা মাপা:

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

1. **Dual-write বাদ দিলে কোনো error নেই, আর সেটাই বিপদ।** Backfill এর পরে সরাসরি v2। Rolling এর সময় v1 instance গুলো `title` এ লেখে, v2 গুলো `name` এ। ছয় সেকেন্ডে ২৭৮টা ভুল পড়া, আর ৩,৭১১টা row এর দুই column এ দুই রকম মান। কোনো alert বাজত না। User দেখত তার সদ্য বদলানো board এর নাম আগের মতো। আর contract এর পরে `title` এর পরিবর্তনগুলো চিরতরে হারাত।
2. **Contract আগেভাগে:** v1.5 এখনও চলছে, `title` মুছে ফেলা হলো। ৮৮০টা error, আর পরিচিত বার্তা।
3. **Expand এ পুরনো column এর `NOT NULL` না তোলা:** v2 শুধু `name` দিয়ে নতুন board বানাতে চায়, `title` তখনও `NOT NULL`, তাই প্রতিটা নতুন board ব্যর্থ। Expand এ শুধু নতুন জিনিস যোগ করা না, পুরনো জিনিসের **বাধ্যবাধকতা ঢিলে করা** ও লাগে।
4. **Backfill এর শর্ত `name IS NULL`:** এটা সবচেয়ে সূক্ষ্ম, আর exercise বানানোর সময় আমার নিজের প্রথম সংস্করণে এই ভুলটাই ছিল। ধাপ ২ এর rolling এর সময় একটা row আগে v1.5 লিখেছে (`name = title = 'x'`), তারপর এখনও বেঁচে থাকা একটা v1 instance লিখেছে (`title = 'y'`, `name` তখনও `'x'`)। Backfill `name IS NULL` খোঁজে, এই row কে ছোঁয় না। ফল: ছয়টা row চুপচাপ ভুল, কোনো error নেই। ১০ লাখ row এর table এ, ঘণ্টাব্যাপী rolling এ, এই সংখ্যা হাজার। সঠিক শর্ত `name IS DISTINCT FROM title`। একবার কোনো v1 আর চলছে না, তখন `title` ই সত্যের উৎস, আর যেখানেই দুটো আলাদা, ঠিক করো। আর তার পরে একটা যাচাই query (`count(*) WHERE name IS DISTINCT FROM title` = ০) ধাপ ৪ এর আগে বাধ্যতামূলক।

**বিকল্প।** Dual-write কে app এর বদলে database এ রাখা যায়: একটা trigger, যা `title` লেখা হলে `name` এ কপি করে (আর উল্টো)। এতে v1 কে বদলাতেই হয় না, ধাপ ২ বাদ। দাম হলো trigger এর logic লুকানো (5.2 এর trigger এর আলোচনা), আর দুই দিকের trigger এর অসীম loop এর ঝুঁকি। ছোট rename এর জন্য আরেকটা পথ হলো একটা view বা Sequelize এর `field` mapping: code এ নাম বদলাও, database এ না। Database এর column এর নাম বদলানো অনেক সময় সেই দামের যোগ্যই না।

আর এই ছক database এর বাইরেও আছে। API এর field rename (নতুন field যোগ → client রা দুটোই পড়ে → পুরনো field মোছা), event এর schema বদল, 10.5 এর key rotation, সব একই তিন ধাপ: **যোগ করো, সরাও, মোছো।**

### ১.৯ TaskFlow এর সিদ্ধান্ত

> **Trade-off Table — কোন কৌশল, কী কেনে, কী দেয়**

| কৌশল              | কী কেনে                                                    | কী দেয়                                                       | কখন                                                    |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Big-bang          | সরলতা, গতি (১ মিনিটে ১০০%)                                 | পুরো blast radius; rollback = আরেকটা deploy                   | Dev/staging; ছোট internal tool; সব কিছু ছোট থাকলে      |
| Rolling           | বাড়তি machine লাগে না                                     | ধীরে ধরা পড়ে (১২ মি), version skew পুরো সময়, ধীর rollback   | Default, যদি gate আর graceful shutdown থাকে            |
| Blue-green        | Code এর rollback ৩০ s এ; switch এর আগে পুরো পরীক্ষা        | দ্বিগুণ capacity; switch এ সবাই একসাথে; data rollback হয় না  | বড়, বিরল release; stateful বা দীর্ঘ warm-up এর system |
| Canary + gate     | Bug এর ক্ষতি এককের ঘরে; alert বাজে না এমন bug ও ধরে        | ধীর (৩০ মি), gate বানানোর পরিশ্রম, পরিসংখ্যান, sticky routing | যেকোনো user-facing service, যথেষ্ট traffic থাকলে       |
| Feature flag      | Deploy ≠ release; ৩ s এ kill switch; user ধরে ধাপে release | দুটো code পথ; flag এর ঋণ; service জুড়ে একই সিদ্ধান্ত লাগে    | নতুন feature, ঝুঁকির পরিবর্তন, experiment              |
| Expand / contract | Schema বদলায়, error শূন্য, প্রতিটা ধাপে rollback          | চারটা deploy, দুটো migration, সপ্তাহ                          | যেকোনো ভাঙা schema / API / event এর পরিবর্তন           |

**Instance:** প্রতিটা service এ `/ready` (warm-up শেষ আর draining না হলে 200) আর `/health` (process বেঁচে আছে কিনা) আলাদা। `SIGTERM` এ readiness 503 → LB এর health check এর দ্বিগুণ সময় অপেক্ষা → `server.close()` → চলমান request শেষ (২০ s এর সীমা) → DB pool আর queue consumer বন্ধ → exit। Orchestrator এর grace period ৩০ s। LB idempotent request (GET, আর `Idempotency-Key` সহ POST) একবার retry করে।

**Rollout:** Rolling এর বদলে canary, ধাপ ১% → ৫% → ২৫% → ১০০%, প্রতি ধাপে ন্যূনতম ১০ মিনিট **আর** ন্যূনতম request সংখ্যা। Routing workspace এর id এর hash ধরে (sticky; একটা workspace এর সবাই একই version এ)। Gate 10.4 এর SLI এ: board খোলা, task তৈরি, login এর সফলতা আর p99, canary বনাম একই সময়ে নতুন চালু করা baseline, segment ধরে (plan, region, web/mobile)। Gate ব্যর্থ হলে স্বয়ংক্রিয় rollback আর একটা ticket। নতুন version এর প্রথম ঘণ্টার সব trace রাখা (10.4 এর tail sampling)। দুপুর ২টার একটা বড় deploy এর বদলে ছোট ছোট deploy, দিনে কয়েকবার। ছোট পরিবর্তনের canary দ্রুত, আর ভাঙলে দোষী খোঁজা সহজ।

**Flag:** একটা flag service (বা OpenFeature এর মতো একটা standard API এর পেছনে একটা vendor), streaming push, প্রতিটা instance এ শেষ জানা মানের snapshot (10.3)। ভাগ `hash(flag + workspaceId)`। সিদ্ধান্ত BFF এ একবার, নিচে `x-flags` header এ; gateway client এর `x-flags` ফেলে দেয়। প্রতিটা release flag এর মালিক আর মেয়াদ; ১০০% এর ৩০ দিন পরে মুছে ফেলার ticket স্বয়ংক্রিয়ভাবে। পুরনো flag এর নাম পুনর্ব্যবহার নিষেধ।

**Compatibility:** প্রতিটা PR এর জন্য প্রশ্ন: "এটা কি আগের version এর সাথে চলবে, দুই দিকে?" API এ শুধু যোগ। Event এ আগে consumer, তারপর producer। Mobile এর জন্য সর্বনিম্ন সমর্থিত app version server থেকে বলা।

**Database:** Migration deploy থেকে আলাদা pipeline এ, আর শুধু expand/contract এর ধাপে। প্রতিটা migration এ `lock_timeout = 2s`, `statement_timeout`, retry, আর CI তে একটা lint: volatile default, `CONCURRENTLY` ছাড়া index, `NOT VALID` ছাড়া constraint, `RENAME`, আর `DROP COLUMN` (যদি না সেটা contract এর ticket এর সাথে বাঁধা) — এগুলো ধরা পড়ে। Backfill batch এ, replica lag দেখে, শর্ত `IS DISTINCT FROM`, শেষে যাচাই query। Primary তে report নিষেধ (7.6)। `Membership.scope` এর পরিবর্তন এই ছকে, ছয় ধাপে (reflection question ১)।

---

## ২. Interview Angle

Deployment দুইভাবে আসে। সরাসরি: "how would you deploy this with zero downtime?", "blue-green আর canary এর পার্থক্য?" আর design এর শেষে: "এখন তুমি schema বদলাতে চাও — কীভাবে?" দুর্বল উত্তর হলো "Kubernetes rolling update করবে, কোনো downtime নেই।" ভালো উত্তরের আকৃতি:

1. **সেতুর কথা দিয়ে শুরু করো।** "Deploy এর সময় পুরনো আর নতুন একসাথে চলে: instance, client, schema, queue এর message। তাই প্রতিটা পরিবর্তন N-1 compatible।" এই এক লাইন বাকি সব উত্তরের ভিত্তি।
2. **কৌশল, তার gate সহ।** "Canary, ১% থেকে, user ধরে sticky, gate SLI এ (error আর latency), segment ধরে, স্বয়ংক্রিয় rollback।" Gate ছাড়া canary শুধু ধীর rolling।
3. **Deploy ≠ release।** ঝুঁকির feature flag এর পেছনে, kill switch সহ।
4. **Database:** expand/contract এর ধাপ, আর অন্তত একটা lock এর বিস্তারিত (lock queue আর `lock_timeout`, বা `CONCURRENTLY`)। এটাই senior এর চিহ্ন।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"Blue-green না canary?"_ — Blue-green কেনে দ্রুত code rollback, দ্বিগুণ capacity দিয়ে, কিন্তু সবাইকে একসাথে ঝুঁকিতে ফেলে আর কেউ না জানলে rollback হয় না। Canary ক্ষতি ছোট রাখে আর alert এর নিচের bug ধরে, দাম সময় আর gate। সংখ্যা দাও: ১% এর bug এ blue-green দুই ঘণ্টায় ৫৮২ জন, canary ৫ জন।
- _"Column rename কীভাবে করবে?"_ — Expand/contract: নতুন column, dual-write, batch backfill (`IS DISTINCT FROM`), পড়া সরানো, শুধু নতুনটায় লেখা, অপেক্ষার পরে পুরনোটা মোছা। আর বলো কোন ধাপের পরে rollback আর নিরাপদ না।
- _"Index যোগ করলে কী হয়?"_ — সাধারণ `CREATE INDEX` write আটকায়; `CONCURRENTLY` আটকায় না, কিন্তু transaction এ চলে না আর ব্যর্থ হলে `INVALID` index রাখে।
- _"Rollback কীভাবে?"_ — Code এর rollback আর data এর rollback আলাদা। নতুন version যদি এমন data লেখে যা পুরনো পড়তে পারে না, তাহলে rollback নেই। তাই প্রতিটা ধাপ rollback-safe রাখা।
- _"Feature flag এর ঝুঁকি?"_ — Flag এর ঋণ, দুটো code পথ, service জুড়ে অমিল, আর পুরনো flag এর পুনর্ব্যবহার (Knight Capital)।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ভুলগুলো: `SIGTERM` এ কিছু না করা (প্রতিটা deploy এ কয়েকটা request মরে, আর সবাই সেটাকে "noise" বলে)। Readiness আর liveness এক করা। Canary এর gate শুধু error দেখে, বা কিছুই দেখে না। Request এলোমেলো canary। `Math.random()` দিয়ে flag। Migration আর deploy একই ধাপে। Migration এ `lock_timeout` নেই। `RENAME COLUMN` এক ধাপে। এক `UPDATE` এ লাখ row এর backfill। Rollback এর পথ কখনো পরীক্ষা না করা।

---

## ৩. Key Takeaway

- **Deploy একটা সেতু, লাফ না।** Instance, client, schema, queue, চার জায়গায় পুরনো আর নতুন একসাথে চলে। তাই প্রতিটা পরিবর্তন N-1 compatible, দুই দিকে; আর code এর rollback ≠ data এর rollback
- **Graceful shutdown এর ক্রমটাই সব।** Readiness 503 → LB সরানো পর্যন্ত অপেক্ষা → `close()` → চলমান শেষ। হঠাৎ kill এ ৫.৩% ব্যর্থ, শুধু `close()` এ ৪.৭%, graceful এ শূন্য। LB এর retry GET বাঁচায়, POST না
- **ধরা পড়া আর ক্ষতি থামা আলাদা।** Big-bang/blue-green বড় bug ১ মিনিটে ধরে, কিন্তু ততক্ষণে সবাই ঝুঁকিতে (৪–৫ হাজার খারাপ request)। Canary ধরে ১% এ, ক্ষতি ৪–৮টা। আর ১% traffic এর bug কোনো alert ধরে না; শুধু canary (৫৮২ জন বনাম ৫ জন)
- **Canary ততটাই ভালো যতটা তার gate।** শুধু error দেখলে latency এর bug ১০০% পর্যন্ত যায়। Gate এ SLI (সফলতা + latency) আর segment। ছোট canary মানে কম প্রমাণ (১%, ৫ মি এ ছোট regression ধরার সম্ভাবনা ২৫%)। বারবার দেখলে ভুল alarm বাড়ে। আর sticky না হলে ৫% canary ৫৯% user ছোঁয়
- **Feature flag deploy থেকে release আলাদা করে।** ভাগ `hash(flag + user)` (এলোমেলো হলে ৮৮% user লাফায়, flag এর নাম না মেশালে একই user সব experiment এ)। Kill switch ৩ s বনাম rollback deploy ১১ মিনিট। সিদ্ধান্ত একবার নিয়ে পাঠাও (নইলে ৩৪% অমিল)
- **DDL এর আসল বিপদ lock এর লাইন।** একটা ১০ ms এর `ADD COLUMN` একটা লম্বা query এর পেছনে ৫.৭ s সব আটকায়; `lock_timeout` + retry সেটা ২০০ ms এ বাঁধে। Volatile default পুরো table নতুন করে লেখে। Index `CONCURRENTLY`। Backfill batch এ (write সর্বোচ্চ ৪.৮ s থেকে ৩৬ ms)। `NOT NULL` আসে `NOT VALID` + `VALIDATE` দিয়ে
- **Rename = expand/contract, ছয় ধাপ।** এক ধাপে চার হাজার error, rollback ও ভাঙে। ছয় ধাপে শূন্য। আর সবচেয়ে বিপজ্জনক ভুলগুলো কোনো error দেয় না: dual-write বাদ (৩,৭১১টা row আলাদা), backfill এর শর্ত `IS NULL` (নীরবে ভুল row)

---

## ৪. নতুন Term (Glossary)

| Term                      | অর্থ                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploy / Release**      | Deploy = নতুন code production এ চালু করা; release = user দের নতুন আচরণ দেখানো। Feature flag দিয়ে দুটো আলাদা করলে deploy নিরীহ আর ঘন ঘন, release নিয়ন্ত্রিত আর ফেরানো যায়                                    |
| **Blue-Green Deployment** | দুটো সমান environment; নতুন version green এ তৈরি ও পরীক্ষা, তারপর সব traffic এক মুহূর্তে সরানো। Code এর rollback সেকেন্ডে, দাম দ্বিগুণ capacity; database একটাই, তাই data এর rollback না                       |
| **Canary Release**        | নতুন version প্রথমে traffic এর ছোট অংশে (১% → ৫% → …), canary বনাম একই সময়ের baseline এর SLI তুলনা করে একটা স্বয়ংক্রিয় gate এগোয় বা ফেরায়। User ধরে sticky, segment ধরে তুলনা                             |
| **Feature Flag**          | Code এর একটা শর্ত যার মান deploy ছাড়া চলমান অবস্থায় বদলায় — release, kill switch, experiment, permission। ভাগ `hash(flag + user)`; সিদ্ধান্ত একবার, request এর সাথে যায়; release flag মুছে ফেলতে হয়       |
| **Version Skew**          | System এর অংশগুলো একই সময়ে আলাদা version এ (instance, client, producer/consumer, code/schema)। স্বাভাবিক অবস্থা; তাই প্রতিটা পরিবর্তন N-1 compatible, আর নতুন version এমন কিছু লেখে না যা পুরনো পড়তে পারে না |
| **Lock Queue**            | Lock এর অপেক্ষার সারি। লম্বা transaction এর পেছনে ACCESS EXCLUSIVE চাওয়া একটা DDL এর পেছনে সব নতুন query (পড়াও) দাঁড়ায়। প্রতিকার `lock_timeout` + retry                                                    |
| **Expand / Contract**     | ভাঙা পরিবর্তনকে ছোট, আলাদা deploy করা যায় আর ফেরানো যায় এমন ধাপে ভাগ করা — নতুনটা যোগ, দুটোতে লেখা, backfill, পড়া সরানো, শুধু নতুনটায় লেখা, শেষে পুরনোটা মোছা; প্রতিটা ধাপে পুরনো আর নতুন code চলে         |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. 10.5 এর পরিবর্তন: `memberships` (৩০ লাখ row) এ এখন `(user_id, workspace_id)` এর উপর একটা unique constraint। Guest আনতে লাগবে একটা নতুন `project_id` (null মানে পুরো workspace) আর `role`, আর unique হবে `(user_id, workspace_id, project_id)`। আর `loadBoardFor` এর নতুন logic যা guest বোঝে। (ক) Schema আর code এর ধাপগুলো ক্রমে লেখো: প্রতিটা ধাপে কোন DDL (lock সহ), কোন code version চলছে, আর কোথায় rollback আর নিরাপদ না। (খ) Unique constraint বদলানো কেন একটা বিশেষ সমস্যা, আর downtime ছাড়া কীভাবে করবে? (গ) নতুন guest feature টা কীভাবে release করবে, আর `loadBoardFor` এর নতুন logic এর canary এর gate এ কোন segment অবশ্যই থাকবে?

2. TaskFlow এর billing service Stripe এর webhook নেয়, সেকেন্ডে গড়ে ২টা। আর মাসের ১ তারিখ রাত ১২টায় একটা job সব workspace এর invoice বানায়। (ক) Webhook handler এর নতুন version এর জন্য ১% এর canary, ১০ মিনিট — কতগুলো request canary দেখবে, আর এতে একটা +১% এর regression ধরা কেন অসম্ভব? তিনটা বিকল্প পথ দাও। (খ) Invoice job এর নতুন version কীভাবে "canary" করবে, যখন সে মাসে একবার চলে? (গ) এখানে ভুলের দাম অন্য service এর চেয়ে কোথায় আলাদা, আর সেটা কৌশলকে কীভাবে বদলায়?

3. Mobile app এর API তে task এর JSON এ `assignee: "email@x.com"` (string) কে `assignee: { id, email, name }` (object) করতে হবে। App store এ পুরনো app version গুলো ছয় মাস পর্যন্ত চলে, আর ৫% user কখনো update করে না। (ক) API এর জন্য একটা expand/contract পরিকল্পনা দাও, প্রতিটা ধাপ সহ। "contract" কখন করবে, আর কীসের ভিত্তিতে? (খ) কোন app version কতজন চালাচ্ছে, সেটা কীভাবে জানবে, 10.4 এর cardinality এর নিয়ম না ভেঙে? (গ) যে ৫% কখনো update করবে না, তাদের নিয়ে কী সিদ্ধান্ত নেবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) ধাপগুলো:

```
step  schema / data                                         code                         rollback
১    ADD COLUMN project_id bigint NULL,                     v1                           হ্যাঁ
     ADD COLUMN role text NOT NULL DEFAULT 'member'
     (দুটোই মুহূর্তের: null আর ধ্রুবক default; lock_timeout + retry)
২    CREATE UNIQUE INDEX CONCURRENTLY memberships_scope_uq  v1                           হ্যাঁ (index মুছে ফেলা)
     ON memberships (user_id, workspace_id, COALESCE(project_id, 0))
৩                                                          v1 → v2 (guest বোঝে, নতুন      হ্যাঁ → v1, যতক্ষণ কোনো
                                                           logic flag এর পেছনে, বন্ধ)      guest row তৈরি হয়নি
৪    (backfill লাগে না: পুরনো row এ project_id null =      v2, flag ধাপে ধাপে চালু        হ্যাঁ → flag বন্ধ
     পুরো workspace — এটাই সঠিক অর্থ)
৫    পুরনো unique constraint মোছা                          v2, guest তৈরি করা যায়        ✗ v1 আর না — v1 guest
                                                                                         row বোঝে না
৬    flag আর পুরনো code পথ মোছা                            v3                           ✗
```

Point of no return হলো ধাপ ৫: প্রথম guest row তৈরি হওয়ার মুহূর্ত। তার পরে v1 এ ফিরলে v1 একটা guest কে পুরো workspace এর member ভাববে, কারণ সে `project_id` দেখে না। এটা একটা **security** bug (10.5 এর BOLA)। তাই v1 এর জন্য আরেকটা আগের ধাপ ভালো: v1 এর `loadBoardFor` কে এমনভাবে বদলাও যাতে `project_id IS NOT NULL` এর row সে **উপেক্ষা** করে। এতে v1 ও "নতুন data দেখে নিরাপদে চুপ থাকে", আর rollback নিরাপদ থাকে। N-1 compatibility এর আসল অর্থ এটাই: পুরনো version কে নতুন data সম্পর্কে অন্তত এতটুকু জানতে হয় যাতে ভুল না করে।

(খ) পুরনো unique `(user_id, workspace_id)` থাকলে একজন user একই workspace এ দুটো project এর guest হতে পারে না (দুটো row, একই জোড়া)। আর পুরনোটা আগে মুছলে মাঝখানে duplicate ঢুকে পড়ার সুযোগ থাকে। সঠিক ক্রম: নতুন unique index **আগে** `CONCURRENTLY` তৈরি করো (ধাপ ২)। `CONCURRENTLY` তৈরির সময় যদি কোনো duplicate পায়, index `INVALID` হয়ে ব্যর্থ হয়, আর তখন data পরিষ্কার করে আবার চালাতে হয়। দুটো constraint কিছুক্ষণ একসাথে থাকে, তারপর পুরনোটা মোছো (ধাপ ৫, মুহূর্তের)। Null এর সমস্যা: Postgres এ unique index এ দুটো null আলাদা গণ্য হয়, তাই `(u, w, NULL)` দুবার ঢুকতে পারে। এজন্য `COALESCE(project_id, 0)` এর মতো একটা expression index, অথবা Postgres 15+ এর `NULLS NOT DISTINCT`।

(গ) Release: guest feature একটা flag এর পেছনে, workspace ধরে। প্রথমে নিজেদের workspace, তারপর কয়েকটা beta customer, তারপর plan ধরে। `loadBoardFor` এর নতুন logic এর canary এর gate এ **segment অবশ্যই**: (১) workspace এর আকার (বৃহস্পতিবারের bug বড় workspace এ ছিল), (২) plan, (৩) actor এর ধরন — owner, member, guest। Authorization এর bug প্রায়ই error দেয় না, ভুল 200 দেয়। তাই gate এ error rate এর পাশে একটা **আচরণের** তুলনা লাগে: canary আর baseline এর 404 এর অনুপাত (হঠাৎ কমে গেলে মানে কেউ এমন কিছু পাচ্ছে যা আগে পেত না)। সাথে 10.5 এর matrix test, CI তে, deploy এর আগে। Canary এমন bug ধরবে না যা "আরও বেশি অনুমতি দেয়" আর কোনো error দেয় না, তাই সেটা test এর কাজ।

**প্রশ্ন ২:**

(ক) ২ req/s × ৬০০ s × ১% = **১২টা request**। Baseline error ধরো ০.৫%; +১% মানে canary তে ১.৫%: ১২টার মধ্যে প্রত্যাশিত ০.১৮টা error। কোনো test একটা error থেকে কিছু বলতে পারে না। ১.৪ এর টেবিলের ভাষায়, প্রমাণ আসে request এর সংখ্যা থেকে, আর এখানে নেই। বিকল্প:

- **বড় শতাংশ, লম্বা সময়:** ২৫% এ ২৪ ঘণ্টা ≈ ৪৩,০০০টা request। ঝুঁকি বেশি মানুষে, কিন্তু প্রমাণ আসে।
- **Shadow traffic:** নতুন version কে আসল webhook এর একটা কপি পাঠাও, কিন্তু তার উত্তর বা side effect (DB লেখা) ব্যবহার না করে, শুধু তুলনা করো পুরনোটার সাথে: একই সিদ্ধান্ত নিল কিনা। ১০০% traffic এ পরীক্ষা, শূন্য ঝুঁকিতে। দাম: side effect আলাদা রাখা কঠিন।
- **Replay:** গত সপ্তাহের webhook (idempotency key সহ, 2.5) staging এ নতুন version এ চালিয়ে ফল মেলানো।
- এবং **ব্যবসার metric** এ gate: "প্রতিটা `invoice.paid` এর পরে workspace সক্রিয় হলো কিনা"। Error rate এর চেয়ে বেশি অর্থবহ।

(খ) মাসে একবার চলা job এর canary হয় data দিয়ে, সময় দিয়ে না। (১) **Dry run:** নতুন version মাসের ১ তারিখের আগের দিন সব workspace এর invoice **হিসাব** করে, কিন্তু পাঠায় না; পুরনো version এর ফলের সাথে প্রতিটা মেলানো হয়, আর পার্থক্যের তালিকা মানুষ দেখে। (২) **Workspace ধরে canary:** ১ তারিখে নতুন version শুধু ১% workspace এর invoice বানায় (hash ধরে), বাকি পুরনোটা; এক ঘণ্টা পরে ফল আর অভিযোগ দেখে বাকিদের। (৩) Job এর ভেতরে একটা kill switch, যা মাঝপথে থামাতে পারে, আর job টা idempotent, যাতে থেমে আবার শুরু করলে কেউ দুটো invoice না পায়।

(গ) টাকার ভুল **ফেরানো যায় না** (বা কঠিন, আর customer এর আস্থা যায়)। Board এর একটা 500 error এর পরে user আবার চেষ্টা করে। একটা ভুল charge এর পরে refund, ক্ষমা, হয়তো আইনি প্রশ্ন। তাই এখানে rollout এর পাল্লা ধীর আর সতর্ক দিকে: dry run বাধ্যতামূলক, canary ছোট আর লম্বা, gate এ ব্যবসার metric, আর deploy সপ্তাহের এমন দিনে যখন মাস শেষ না আর team উপস্থিত। দাম ধীর গতি, যা এখানে সস্তা।

**প্রশ্ন ৩:**

(ক) API এর expand/contract:

1. **Expand:** নতুন field যোগ, পুরনোটা রেখে: `assignee: "email@x.com"` থাকে, পাশে `assigneeInfo: { id, email, name }`। (একই নামে আকার বদলানো যায় না। পুরনো app `assignee` কে string হিসেবে parse করবে, object পেলে crash।) Server দুটোই পাঠায়, দুটোই নেয় (task তৈরিতে যেকোনো একটা)।
2. **নতুন app version** শুধু `assigneeInfo` পড়ে আর পাঠায়। Release।
3. **অপেক্ষা ও মাপা:** কোন app version এখনও `assignee` ব্যবহার করে (নিচে খ)।
4. **Contract:** যখন `assignee` পড়ে এমন app version এর ব্যবহার একটা সিদ্ধান্তের সীমার নিচে (ধরো ০.৫% সক্রিয় user, বা ছয় মাস, যেটা পরে), তখন সর্বনিম্ন সমর্থিত version বাড়াও (গ), তারপর `assignee` পাঠানো বন্ধ। নতুন নাম `assigneeInfo` রয়ে যায়। চাইলে আরেকটা চক্রে আবার `assignee` নাম ফিরিয়ে আনা যায়, কিন্তু সাধারণত দাম যোগ্য না।

Contract এর ভিত্তি তারিখ না, **মাপা ব্যবহার**। আর contract এর পরে কিছু সপ্তাহ server এ "পুরনো field চাওয়া request" গোনা চালু রাখো।

(খ) App প্রতিটা request এ header এ নিজের version পাঠায় (`x-app-version: 4.12.0`)। Metric এ `app_version` label সরাসরি দিলে প্রতিটা নতুন version নতুন series বানায়, আর পুরনো version গুলো বছর ধরে থাকে। Cardinality ধীরে ধীরে বাড়ে, কিন্তু সীমাহীন না। 10.4 এর নিয়মে এটা সীমিত রাখার পথ: label এ শুধু **major.minor**, আর সবচেয়ে নতুন ১০টার বাইরের সব `old`। বিস্তারিত (ঠিক কোন patch version) log আর trace এ, যেখানে cardinality এর দাম নেই। আর আলাদা একটা counter: "পুরনো `assignee` field ব্যবহার করা request, `app_version` (major.minor) ধরে" — contract এর সিদ্ধান্ত এটা দিয়েই।

(গ) এটা একটা ব্যবসার সিদ্ধান্ত, শুধু engineering এর না। পথ: (১) **Server-driven minimum version:** একটা endpoint যা app চালু হলে বলে "সর্বনিম্ন সমর্থিত version 4.0", আর তার নিচে app একটা "update করুন" screen দেখায়। এটা app এর প্রথম version থেকেই থাকা উচিত, পরে যোগ করা যায় না। (২) সময়সীমা ঘোষণা, app এর ভেতরে আর email এ, কয়েক সপ্তাহ আগে। (৩) অনেক পুরনো app এর জন্য একটা পাতলা compatibility layer (BFF, 9.2) রাখা যায়, যদি সেই ৫% এর মধ্যে বড় customer থাকে: পুরনো আকার শুধু সেই BFF এ, মূল API তে না। ৫% চিরকাল সমর্থন করা মানে প্রতিটা API পরিবর্তন চিরকাল দুটো আকারে। Version skew এর দাম কাউকে দিতে হয়, আর সিদ্ধান্তটা হলো কে।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (তিনটা deterministic simulation; localhost এ আসল HTTP দিয়ে rolling restart; আসল PostgreSQL এ দুটো lab, Docker দিয়ে)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.6-deployment/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.6-deployment) — `docker compose up -d --wait`, `npm install`, তারপর `npm run rollout`, `npm run flags`, `npm run drain`, `npm run locks`, `npm run rename`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`rollout` তিন রকম bug কে ছয়টা কৌশলে চালায়, ভালো version এর দাম মাপে, canary এর আকার আর সময়ের পরিসংখ্যান দেখায়, আর sticky বনাম এলোমেলো routing তুলনা করে। `flags` এ percentage এর ভাগ, kill switch এর গতি আর দুই service এর অমিল। `drain` localhost এ একটা আসল round-robin LB আর চারটা `node:http` instance দিয়ে পাঁচ রকম rolling restart চালায়। `locks` আসল Postgres এ ১০ লাখ row এর পাশে চলমান app load রেখে `ALTER`, index, backfill আর `NOT NULL` মাপে। `rename` আসল Postgres আর Sequelize এ চার রকম app version একই table এ চালায়: এক ধাপে rename, expand/contract, আর চারটা ভুল।

**সৎ নোট:** Sandbox এ Node 26 আর PostgreSQL 17.11 (Docker) এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit`, ESLint আর Prettier clean। `rollout` আর `flags` দুবার করে, output byte ধরে হুবহু এক। `drain`, `locks` আর `rename` দুবার করে। সংখ্যা কাছাকাছি, শূন্য গুলো আর ক্রম একই। Lesson এ quote করা সংখ্যা এক একটা run থেকে, আর দ্বিতীয় run এর সংখ্যা যেখানে আলাদা সেখানে বলা আছে। README এর experiment ১ আর ৩ চালানো হয়েছে (সংখ্যা lesson এ); ২, ৪, ৫ চালানোর কাজ, আর ৬ code বদলানোর কাজ, তোমার। **`rollout` আর `flags` এ কোনো আসল server নেই।** নকল request, seed দেওয়া PRNG। Alert এর পরে মানুষের ১০ মিনিট, big-bang এর rollback deploy ৫ মিনিট, canary এর ধাপ ১০ মিনিট, segment = ১% traffic, baseline error ০.১%: এগুলো ধরে নেওয়া সংখ্যা। Big-bang এ সব instance একসাথে restart হওয়ার সময়ের capacity এর ঘাটতি model এ নেই। `drain` এর LB নিজের হাতে লেখা, আসল Nginx বা Envoy না। Instance গুলো একই process এ, আর কাজ `setTimeout` দিয়ে নকল। `locks` এর সময় তোমার machine এর উপর নির্ভর করে, আর ১০ লাখ row এর সংখ্যা ১০ কোটিতে বহু গুণ বড় হবে (এখানে মাপা না)। `rename` এর "ভুল পড়া" কলাম একসাথে চলা write এর race বাদ দিয়ে গোনে। কোনো কোনো ভুলের সারিতে (contract আগেভাগে, NOT NULL) ০–৭ এর ওঠানামা দেখা গেছে, যার কিছুটা মাপার সীমা। মূল প্রমাণ error এর সংখ্যা আর SQL এর যাচাই query (`name IS DISTINCT FROM title`)। **যা মাপা হয়নি:** আসল Kubernetes, আসল canary এর tool (Argo Rollouts, Flagger), আসল flag service, replica lag আর WAL (5.7), mobile client। Google SRE বই এর ৭০% এর দাবি আর Knight Capital এর বিবরণ প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। ১.২ আর ১.৭ এর Express আর Sequelize এর code নকশা, চালানো না। ১.৯ এর TaskFlow এর সিদ্ধান্ত একটা নকশা।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে অনুমান:** `rollout` চালানোর **আগে** লিখে ফেলো: ১% traffic এ ২০% error এর bug। পুরো system এর error rate কত হবে, আর "error > ১%" এর alert কি বাজবে? Blue-green কতজনকে ছোঁবে? তারপর চালিয়ে মেলাও। এবার `STEP_MINUTES=3`। কোন canary bug টা হারাল, আর কোনটা ধরল? কেন?

2. **নিজের graceful shutdown:** একটা ছোট Express app এ ১.২ এর `shutdownOnSigterm` আর `/ready` বসাও। `autocannon` বা একটা loop দিয়ে load দিতে দিতে `kill -TERM <pid>` করো। কয়টা request ব্যর্থ? এবার handler সরিয়ে আবার করো। তারপর `drainMs` শূন্য করো। শুধু `close()` এর সারির মতো ফল আসে?

3. **Lock queue নিজের চোখে:** `LONG_QUERY_MS=20000 npm run locks`। Lock queue এর সারিতে app এর সর্বোচ্চ latency কত হলো? চলার সময় আরেকটা terminal এ `psql` দিয়ে `SELECT pid, wait_event_type, state, left(query, 50) FROM pg_stat_activity WHERE datname = 'taskflow'` চালাও। কে কার জন্য অপেক্ষা করছে, দেখতে পাচ্ছ? (`pg_blocking_pids(pid)` ও দেখো।)

4. **Point of no return:** `src/rename.ts` এর অংশ খ এ ধাপ ৫ (`v2r → v2`) এর পরে একটা `v2 → v1.5` rollback ধাপ যোগ করো। Error এলো, নাকি ভুল পড়া? কেন ধাপ ৪ এর পরের rollback নিরাপদ ছিল, কিন্তু এটা না?

5. **Design অংশ:** TaskFlow এর deploy pipeline এর এক পাতার নকশা। (ক) একটা PR merge থেকে ১০০% পর্যন্ত প্রতিটা ধাপ, কে বা কী প্রতিটা ধাপকে অনুমোদন দেয়। (খ) Canary এর gate এর তালিকা: কোন SLI, কোন segment, কোন সীমা, ন্যূনতম কত request। (গ) Migration এর pipeline কীভাবে deploy এর pipeline থেকে আলাদা, আর CI এর migration lint কী কী ধরে। (ঘ) শুক্রবার বিকেলে deploy: হ্যাঁ না না, আর কেন? (ঙ) একটা জরুরি security fix (10.5 এর মতো) এই pipeline এর কোন ধাপ এড়াতে পারে, আর কোনটা কখনো না?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ), 10.1, 10.2, 10.3, 10.4, 10.5
Current: 10.6 — Deployment: blue-green, canary, feature flag, zero-downtime migration
TaskFlow state: modular monolith + billing; gateway + BFF; saga; breaker + bulkhead; rate limit; cache ring;
Bloom/HLL; hard/soft dependency + brownout; OpenTelemetry, burn rate alert; AuthN/AuthZ (jose, scoped loader,
matrix test), refresh rotation + denylist, OAuth PKCE, secret manager, credential stuffing আর DDoS এর স্তর।
খারাপ সপ্তাহ: প্রতিটা deploy এ SIGKILL (চলমান request মরে, ঠান্ডা instance traffic পায়, duplicate task);
১০ ms এর ADD COLUMN একটা report এর পেছনে lock queue এ ৩ মিনিট site বন্ধ; title → name এক ধাপে rename
(পুরনো instance ভাঙে, rollback আরও ভাঙে, ২৫ মিনিট); blue-green এ loadBoardFor এর ১% segment bug — কোনো
alert নেই, চার দিন; Math.random() flag (৮৮% user লাফায়), BFF আর API আলাদা hash (৩৪% অমিল), ৫ মিনিটের poll।
এখন: /ready আর /health আলাদা; SIGTERM → readiness 503 → health check ×2 অপেক্ষা → close() → চলমান শেষ (২০ s)
→ pool বন্ধ; LB idempotent request এ একবার retry। Canary ১→৫→২৫→১০০%, প্রতি ধাপে ন্যূনতম সময় + request,
workspace hash ধরে sticky, gate SLI (সফলতা + p99) এ, segment (plan/region/web-mobile) ধরে, নতুন baseline এর
সাথে, স্বয়ংক্রিয় rollback; ছোট ঘন deploy। Flag: streaming push + snapshot, hash(flag + workspace), BFF এ
একবার → x-flags header (gateway client এর টা ফেলে), মালিক + মেয়াদ, নাম পুনর্ব্যবহার নিষেধ। N-1 compatibility:
API এ শুধু যোগ, event এ আগে consumer। DB: migration আলাদা pipeline এ, শুধু expand/contract; lock_timeout ২ s +
statement_timeout + retry; CI lint (volatile default, CONCURRENTLY ছাড়া index, NOT VALID ছাড়া constraint,
RENAME, অসংলগ্ন DROP); backfill batch এ, replica lag দেখে, শর্ত IS DISTINCT FROM, যাচাই query; primary তে
report নিষেধ। Membership.scope ছয় ধাপে।
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7), Deploy / Release, Blue-Green Deployment, Canary Release, Feature Flag,
Version Skew, Lock Queue, Expand / Contract
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 10.7 — Cost & cloud economics: design এ cost একটা first-class constraint
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **প্রতিটা deploy একটা সেতু, আর সেতুর উপরে কিছুক্ষণ পুরনো আর নতুন একসাথে হাঁটে।** Instance বদলানোর সময় একটা ক্রম মানলে একটা request ও মরে না। কৌশল বাছাই আসলে দুটো প্রশ্নের উত্তর: খারাপ version কতজনকে ছোঁবে, আর কে ধরবে। Canary শুধু ততটা ভালো, যতটা তার gate যা দেখে। Flag deploy থেকে release আলাদা করে। আর database এ সবচেয়ে বিপজ্জনক ভুলগুলো কোনো error দেয় না। সেগুলো চুপচাপ data কে দুই ভাগ করে, আর একটা ১০ ms এর migration কে তিন মিনিটের বিরতি বানায়।

আজ বেশ কয়েকবার একটা জিনিসের দাম বলে পাশ কাটিয়ে গেছি: blue-green এর দ্বিগুণ machine (+১২), canary এর বাড়তি pool আর baseline, প্রতিটা নতুন version এর প্রথম ঘণ্টার সব trace, dry run এ মাসের সব invoice দুবার হিসাব করা। 10.5 এ autoscaling এর বিল, 10.4 এ log এর আয়তন। প্রতিটা নিরাপত্তা আর প্রতিটা দৃশ্যমানতার একটা মাসিক দাম আছে, আর সেই দাম কেউ design এর সময় লেখে না। রেডি হলে `next` লিখো — **Lesson 10.7: Cost & Cloud Economics** এ যাব। সেখানে প্রশ্নটা: TaskFlow এর মাসের cloud বিল কোথা থেকে আসে, কোন design এর সিদ্ধান্ত কত টাকার, আর কেন "cost" কে latency আর availability এর মতোই একটা requirement হিসেবে ধরতে হয়।
