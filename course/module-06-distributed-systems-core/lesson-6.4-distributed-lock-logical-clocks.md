# Lesson 6.4 — Distributed Lock আর Logical Clock: কেন ঘড়ি বিশ্বাস করা যায় না, Lamport, Vector Clock

**Module 6 — Distributed Systems Core**

> **Spaced Repetition (Lesson 2.2):** একটা server এর ঘড়ি ভুল করে দুই দিন পিছিয়ে আছে। এই server যখন অন্য একটা HTTPS API কে call করবে, TLS handshake এ কী ঘটতে পারে — আর কেন? (Certificate এর ভেতরে কোন দুটো তারিখ থাকে?)

**Prerequisite:** Lesson 5.7 (Multi-leader, LWW), Lesson 5.9 (Partition এ LWW এর গল্প), Lesson 6.1 (Lease, fencing token), Lesson 6.2 (Term), Lesson 6.3 (Consistent prefix)

**তুমি এই lesson শেষে পারবে:**

1. দুই রকম ঘড়ি (time-of-day আর monotonic) আলাদা করতে পারবে, বলতে পারবে দুটো machine এর ঘড়ি কেন কখনো মেলে না — আর কোড এ কোনটা কোথায় ব্যবহার করবে
2. "Happens-before" সম্পর্ক দিয়ে ঘটনার ক্রম ভাবতে পারবে, আর Lamport clock আর vector clock হাতে হিসাব করতে পারবে — কোনটা কী বলতে পারে আর কী পারে না
3. Last-write-wins এর দাম মেপে বলতে পারবে, concurrent লেখা চিনে রাখার (sibling) দাম জানবে — আর distributed lock/lease এ ঘড়ি কোথায় ঢোকে, কোথায় ঢুকতে দেবে না

**Tier:** 1 — Runnable Code (একটা হাতে মেলানোর মতো উদাহরণ, আর একটা deterministic simulation)

---

## ০. TaskFlow এখন কোথায়

TaskFlow দুটো বড় জিনিস চালু করেছে: একটা mobile app যেটা **offline এ** task edit করতে দেয় (পরে sync হয়), আর তিনটা region এ লেখা নেওয়ার একটা pilot — ঢাকা, সিঙ্গাপুর, ফ্রাঙ্কফুর্ট, প্রতিটায় একটা replica যেটা task এর title আর description এর লেখা নেয় আর বাকিদের পাঠায় (5.7 এর multi-leader)। Conflict হলে নিয়ম সরল, Cassandra এর মতো: **যার timestamp বড়, সে জেতে** (last-write-wins)।

এক সপ্তাহে তিনটা ticket:

1. **"Status 'Done' করলাম, কিন্তু title এ [DONE] আসেনি।"** TaskFlow এর একটা automation আছে: status Done হলে title এর সামনে `[DONE]` লাগিয়ে দেয়, ২০০ ms এর মধ্যে। কিছু task এ automation এর লেখাটা **হারিয়ে গেছে** — আগের title টাই রয়ে গেছে। সব ঘটনা সিঙ্গাপুরের replica তে।
2. **"আমি আর আমার সহকর্মী একই সময়ে description edit করলাম — আমারটা কোনো চিহ্ন ছাড়াই উধাও।"** কোনো error নেই, কোনো conflict এর সতর্কতা নেই।
3. Debugging করতে গিয়ে একজন engineer তিনটা region এর log timestamp দিয়ে সাজাল — আর দেখল, একটা task এর "comment notification পাঠানো হলো" লাইনটা "comment তৈরি হলো" এর **আগে**।

তদন্তে দেখা গেল সিঙ্গাপুরের machine এর NTP কয়েক দিন ধরে ভাঙা — ঘড়ি ৪০০ ms পিছিয়ে। কিন্তু ঘড়ি ঠিক করার পরেও ticket ২ থামেনি।

Lesson 5.7, 5.9, 6.1, 6.3 — চারবার আমরা বলেছি "ঘড়ি বিশ্বাস করা যায় না, 6.4 এ।" আজ সেই lesson। প্রথম অর্ধেক: কেন। দ্বিতীয় অর্ধেক: ঘড়ি ছাড়া "কোনটা আগে ঘটেছে" জানার উপায়।

---

## ১. Theory

### ১.১ দুই রকম ঘড়ি

প্রতিটা computer এ আসলে দুটো ঘড়ি, আর দুটোর কাজ আলাদা:

- **Time-of-day clock (wall clock)** — "এখন কয়টা বাজে": ১৯৭০ থেকে কত millisecond। Node এ `Date.now()`, `new Date()`। NTP এটাকে ঠিক রাখে — আর ঠিক করতে গিয়ে **সামনে বা পেছনে লাফ** দেওয়াতে পারে।
- **Monotonic clock** — কোনো নির্দিষ্ট মুহূর্ত থেকে কত সময় গেছে; শুধু সামনে যায়, কখনো লাফায় না, কখনো পেছনে না।

**Monotonic clock** — একটা ঘড়ি যেটা শুধু সময়ের **দৈর্ঘ্য** মাপার জন্য: সবসময় সামনে যায়, NTP এর লাফে বদলায় না; কিন্তু এর মানের কোনো অর্থ নেই অন্য machine এ (Node এ `performance.now()`, `process.hrtime.bigint()`)।

সবচেয়ে সাধারণ bug:

```typescript
// ✗ ভুল — NTP ঘড়ি পেছনে ঠেললে elapsed ঋণাত্মক, সামনে ঠেললে হঠাৎ বিশাল
const start = Date.now();
await doWork();
const elapsed = Date.now() - start;

// ✓ দৈর্ঘ্য মাপতে সবসময় monotonic
const t0 = performance.now();
await doWork();
const elapsedMs = performance.now() - t0;
```

এটা তাত্ত্বিক না। **31 ডিসেম্বর 2016** এর শেষ মিনিটে (UTC) একটা leap second যোগ হয়েছিল — মিনিটটা ছিল ৬১ সেকেন্ডের। Cloudflare এর DNS software এর একটা অংশ দুটো wall clock এর পার্থক্য থেকে একটা সময়কাল হিসাব করত — আর সেই মুহূর্তে সময় "পেছনে গেল", পার্থক্য ঋণাত্মক হলো, আর code টা crash করল। কিছু customer এর DNS resolution ব্যর্থ হলো। (তারা যে ভাষায় লিখত — Go — পরের version এ `time` package এ monotonic ঘড়ি যোগ করে, অনেকটা এই ঘটনার কারণেই।)

নিয়ম: **সময়ের দৈর্ঘ্য মাপতে (timeout, lease, latency) monotonic। "কখন ঘটেছে" মানুষকে দেখাতে wall clock।** আর দুই machine এর ঘটনার ক্রম ঠিক করতে — কোনোটাই না (বাকি lesson)।

### ১.২ দুটো ঘড়ি কেন কখনো মেলে না

প্রতিটা machine এর ঘড়ি একটা quartz crystal এর কম্পন গোনে। Crystal গুলো একদম এক গতিতে কাঁপে না, আর তাপমাত্রায় গতি বদলায়।

**Clock skew** — দুটো machine এর ঘড়ির একই মুহূর্তের পার্থক্য; আর **drift** — একটা ঘড়ি আসল সময়ের চেয়ে কত দ্রুত বা ধীরে চলে (সাধারণত "প্রতি মিলিয়নে কত অংশ", ppm এ)।

কিছু সংখ্যা:

- Google এর Spanner paper ধরে নেয় একটা server এর ঘড়ি সবচেয়ে খারাপ ক্ষেত্রে **২০০ ppm** drift করে — প্রতি সেকেন্ডে ২০০ মাইক্রোসেকেন্ড, দিনে ~১৭ সেকেন্ড। বাস্তবে সাধারণত এর চেয়ে ভালো, কিন্তু NTP ছাড়া একটা machine কয়েক দিনে সেকেন্ডের পর সেকেন্ড সরে যায়।
- NTP ঘড়ি ঠিক রাখে — data center এর ভেতরে ভালো setup এ millisecond বা তার কম, internet এর উপর দিয়ে কয়েক ডজন ms। কিছু cloud এখন আরও নিখুঁত সময় দেয় (PTP, মাইক্রোসেকেন্ড পর্যায়ে)।
- কিন্তু NTP নিজেও ভাঙে: firewall NTP আটকায়, config ভুল, VM এক host থেকে আরেকটায় সরানো হলো, container এর ঘড়ি host এর উপর নির্ভর — আর তখন skew সেকেন্ড, মিনিট, দিন। TaskFlow এর সিঙ্গাপুর machine এর ৪০০ ms এমন একটা সাধারণ দিনের ঘটনা।
- **Leap second:** পৃথিবীর ঘূর্ণন মেলাতে মাঝে মাঝে একটা সেকেন্ড যোগ হয়। 2012 সালের leap second এ Linux এর একটা bug এ অনেক server এর CPU ১০০% এ উঠে গিয়েছিল (Reddit, Mozilla সহ অনেকে ভুগেছিল)। এখন বড় cloud গুলো leap second কে পুরো একটা দিনে ছড়িয়ে দেয় ("leap smear") — কিন্তু তখন তাদের ঘড়ি ইচ্ছা করে সরকারি সময় থেকে কয়েক শ ms আলাদা থাকে।

সারকথা: **দুটো machine এর ঘড়ির পার্থক্য কখনো শূন্য না, সাধারণত ছোট, আর সবচেয়ে খারাপ দিনে অজানা রকম বড়।** আর তুমি জানবে না কোন দিনটা খারাপ দিন।

### ১.৩ Last-Write-Wins — ঘড়ি দিয়ে বিচার

Ticket ১ এর যন্ত্র: প্রতিটা লেখার সাথে যে replica লিখল তার ঘড়ির timestamp; দুটো লেখার conflict এ বড় timestamp জেতে, ছোটটা **ফেলে দেওয়া হয়**। Cassandra প্রতিটা column এর মানের জন্য এটাই করে, আর অনেক multi-leader system এর default এটা।

Exercise এর `npm run lww` — TaskFlow এর pilot এর মতো: তিনটা replica, n3 (সিঙ্গাপুর) এর ঘড়ি ৪০০ ms পিছিয়ে, n2 ৩০ ms এগিয়ে। ৬ জন মানুষ আর ২টা automation bot দুই মিনিট ধরে একই title edit করে — একটা replica থেকে পড়ে, ভাবে (মানুষ গড়ে ৩ s, bot ৫০–৩০০ ms), তারপর কোনো একটা replica তে লেখে। Simulation প্রতিটা লেখার **সত্যিকারের** কার্যকারণ জানে (কোন version দেখে লেখা হয়েছিল), আর প্রতিটা বাদ পড়া লেখাকে দুই ভাগে গোনে:

```
   নিয়ম                 মোট edit   পরে-করা edit আগেরটার    একসাথে-করা edit    app কে মেলাতে    শেষ title এর    replica
                                     কাছে হারল            নীরবে বাদ          বলা হলো         ইতিহাসে নেই       এক?
   LWW — ঘড়ির সময়          164               10                   43               0               100       হ্যাঁ
```

**"পরে-করা edit আগেরটার কাছে হারল" — ১০টা।** মানে: bot title টা **দেখল**, তারপর `[DONE]` লাগিয়ে লিখল — তার লেখা আসলেই পরে, আর আগেরটা জেনেই — তবু আগেরটা জিতল। মেপে দেখা হয়েছে: ১০টাই bot এর, ১০টাই n3 তে। Bot ২০০ ms এ প্রতিক্রিয়া দেয়, n3 এর ঘড়ি ৪০০ ms পিছিয়ে, তাই bot এর লেখার timestamp সে যে লেখা দেখে লিখেছে, **তার চেয়েও পুরনো**। Ticket ১ হুবহু।

(Exercise এর experiment ১: n3 এর ঘড়ি ঠিক করলে এই কলাম ১০ থেকে ০ তে নামে। মানে এই ক্ষতি পুরোটাই ঘড়ির।)

**"একসাথে-করা edit নীরবে বাদ" — ৪৩টা।** দুজন একই version দেখে প্রায় একসাথে লিখল — কেউ কারোটা জানত না। LWW একটা রাখে, অন্যটা ফেলে — কোনো error ছাড়া, কাউকে না জানিয়ে। Ticket ২। আর experiment ১ এ ঘড়ি ঠিক করার পরেও এই সংখ্যা প্রায় একই থাকে (৪৩ → ৪৫): **এই ক্ষতি ঘড়ির না, নিয়মের।** যত নিখুঁত ঘড়িই হোক, LWW দুটো concurrent লেখার একটা ফেলবেই — এটাই তার সংজ্ঞা।

আর শেষ কলামটা লক্ষ করো: "replica এক? হ্যাঁ।" সব replica একটা উত্তরে একমত — ভুল উত্তরে। LWW সবসময় **converge** করে; সঠিকতা আলাদা প্রশ্ন।

### ১.৪ Happens-Before — সময় ছাড়া ক্রম

1978 সালে Leslie Lamport (হ্যাঁ, 6.2 এর Paxos এর) একটা paper লেখেন যেটা এই পুরো ক্ষেত্রের ভিত্তি: "Time, Clocks, and the Ordering of Events in a Distributed System"। মূল ধারণা: distributed system এ আমরা আসলে জানতে চাই না "কোনটা কয়টায় ঘটেছে" — জানতে চাই **"কোনটা কোনটাকে প্রভাবিত করতে পারত।"**

**Happens-before (a → b)** — ঘটনা a, ঘটনা b কে প্রভাবিত করতে পারত; তিনটা নিয়মে: (১) একই process এ a আগে, b পরে; (২) a একটা message পাঠানো, b সেই message পাওয়া; (৩) a → b আর b → c হলে a → c। আর a → b না, b → a ও না — তাহলে a আর b **concurrent**: কেউ কারো কথা জানত না।

Exercise এর `npm run clocks` এর ঘটনাগুলো একটা space-time diagram এ (সময় বাম থেকে ডানে):

```
   A (রহিমের laptop)  a1 ──── a2 ──────── a3 ──────────────────────────── a4
                              │ m1                                         ▲
                              ▼                                            │ m3
   B (server)                 b1 ──── b2 ──── b3                           │
                                      │ m2                                 │
                                      ▼                                    │
   C (করিমের phone)   c1 ──────────── c2 ──── c3 ─────────────────────────┘
```

- a1 → a4 (একই process)। a2 → c2 (a2 → b1 → b2 → c2, message এর শিকল ধরে)।
- **c1 আর a2 concurrent** — করিম offline এ comment লিখেছে, রহিম তার কথা জানত না, রহিমের কাজও করিমের কাছে পৌঁছায়নি।
- **a3 আর b3 concurrent** — a3 এর কথা B জানে না (a3 এর পরে A কোনো message পাঠায়নি); b3 এর কথা A জানে না।

"Concurrent" মানে "একই সময়ে" না — a3 আর b3 wall clock এ ১ সেকেন্ড আলাদা হতে পারে। মানে **কেউ কারো কথা জানত না।** আর ঠিক এই ধরনের জোড়াতেই conflict হয় — ticket ২ এর দুটো description edit।

### ১.৫ Lamport Clock

Happens-before কে একটা সংখ্যায় ধরার সবচেয়ে সরল উপায়:

**Lamport clock** — প্রতিটা process এর একটা counter: প্রতিটা ঘটনায় এক বাড়ায়; message পাঠানোর সময় counter সাথে পাঠায়; message পেলে নিজের counter = max(নিজের, পাওয়া) + 1।

```
   ঘটনা  process  ধরন       Lamport   কী হলো
   a1    A        local        1      রহিম title লিখল
   c1    C        local        1      করিম offline এ একটা comment লিখল
   a2    A        send m1      2      title server এ পাঠাল
   b1    B        recv m1      3      server title পেল            ← max(0, 2) + 1
   a3    A        local        3      রহিম description বদলাল
   b2    B        send m2      4      server করিমকে notify করল
   b3    B        local        5      server audit log লিখল
   c2    C        recv m2      5      করিম notification পেল       ← max(1, 4) + 1
   c3    C        send m3      6      করিম উত্তর দিল রহিমকে
   a4    A        recv m3      7      রহিম উত্তর পেল              ← max(3, 6) + 1
```

নিশ্চয়তাটা: **a → b হলে L(a) < L(b)।** যে ঘটনা অন্যটাকে প্রভাবিত করতে পারত, তার সংখ্যা সবসময় ছোট। আর সমান সংখ্যা হলে process এর নাম দিয়ে ভাঙলে (`(L, process)` জোড়া) সব ঘটনার একটা **সম্পূর্ণ ক্রম** পাওয়া যায়, যেটা কার্যকারণের সাথে কখনো বিরোধ করে না।

তাই Lamport clock দিয়ে LWW করলে ticket ১ এর সমস্যা যায়:

```
   LWW — Lamport clock       164                0                   45               0               101       হ্যাঁ
```

"পরে-করা edit হারল" — **০।** Bot যে version দেখে লিখেছে, তার Lamport সংখ্যা bot এর replica তে পৌঁছায় (পড়ার সাথে), তাই bot এর লেখার সংখ্যা সবসময় বড় — কোনো ঘড়ির দরকার নেই।

কিন্তু "একসাথে-করা edit নীরবে বাদ" — এখনো **৪৫।** কারণ Lamport এর নিশ্চয়তা **একমুখী**: a → b হলে L(a) < L(b) — কিন্তু L(a) < L(b) হলে a → b, এমন **না**। `clocks` এর শেষ অংশ:

```
   জোড়া       Lamport বলে       Vector clock বলে
   c1, a2      c1 < a2           concurrent — কেউ কারো কথা জানত না
   a3, b3      a3 < b3           concurrent — কেউ কারো কথা জানত না
```

Lamport ৩ < ৫ দেখে a3 কে "আগে" বলে, অথচ a3 আর b3 একে অপরের কথা জানত না। Lamport clock concurrent ঘটনাকেও একটা ক্রমে বসিয়ে দেয় — আর LWW সেই ক্রম দেখে একটা ফেলে দেয়। Ticket ২ থাকে।

(পরিচিত লাগছে? 6.2 এর Raft এর **term** আসলে একটা Lamport-ধরনের clock: প্রতিটা message এ যায়, বড়টা দেখলে নিজেরটা বাড়াও। Logical clock distributed system এর সবখানে।)

### ১.৬ Vector Clock — Concurrent চেনা

Concurrent চিনতে একটা সংখ্যা যথেষ্ট না — প্রতিটা process এর জন্য একটা করে লাগে।

**Vector clock** — প্রতিটা process এর কাছে সব process এর একটা counter এর তালিকা: নিজের ঘটনায় নিজের ঘর এক বাড়ায়; message এর সাথে পুরো তালিকা পাঠায়; পেলে প্রতিটা ঘরে max নেয় (তারপর নিজের ঘর এক বাড়ায়)।

```
   ঘটনা  vector [A,B,C]
   a3    [3,0,0]        A এর ৩টা ঘটনা জানে, B আর C এর কিছুই না
   b3    [2,3,0]        A এর প্রথম ২টা জানে (m1 দিয়ে), নিজের ৩টা
   c3    [2,2,3]
   a4    [4,2,3]        ← [3,0,0] আর [2,2,3] এর প্রতিটা ঘরে max, তারপর A এর ঘর +1
```

তুলনার নিয়ম: V(a) এর **প্রতিটা** ঘর V(b) এর সমান বা ছোট (আর অন্তত একটা ছোট) → a → b। কোনো ঘরে a বড়, কোনো ঘরে b বড় → **concurrent**। a3 = [3,0,0], b3 = [2,3,0]: A এর ঘরে a3 বড়, B এর ঘরে b3 বড় → concurrent। এটাই Lamport বলতে পারেনি।

এখন database এর ভাষায়: প্রতিটা version এর সাথে একটা vector (কোন কোন replica র কতগুলো লেখা এই version "জানে")। নতুন লেখা পুরনোটার vector এর সব ঘর ঢেকে দিলে → পুরনোটা নিশ্চিন্তে ফেলো (কার্যকারণ আছে)। না ঢাকলে → দুটোই concurrent → **দুটোই রাখো**:

**Sibling** — concurrent দুটো (বা বেশি) version, যাদের কেউ অন্যটাকে ঢাকে না; database দুটোই রাখে আর পরের পাঠককে দুটোই দেয়, মেলানোর দায়িত্ব application এর।

```
   Vector clock (sibling)    164                0                    0              48                 0       হ্যাঁ
```

কিছুই হারায়নি — দুটো ক্ষতির কলামই শূন্য, শেষ title এর ইতিহাসে সব edit আছে। কিন্তু **৪৮ বার** app কে বলা হয়েছে "এই দুটো (বা তিনটা) মান আছে — তুমি মেলাও।" দাম উধাও হয়নি, সরে গেছে: database থেকে application এ। আর মেলানো সবসময় সহজ না: দুটো title কীভাবে মেলাবে? (User কে দেখিয়ে জিজ্ঞেস করা — Git এর merge conflict এর মতো।) কিছু data তে এটা স্বাভাবিক: task এর label এর **set** — দুটো sibling এর union নাও। Amazon এর Dynamo paper (2007) এর বিখ্যাত উদাহরণ ঠিক এটা — shopping cart এর sibling এর union। (দাম: মুছে ফেলা item কখনো কখনো ফিরে আসে — 5.9 এর label এর উদাহরণ মনে করো। আর এই ধরনের "নিজেই মিলে যায়" এমন data type এর নাম CRDT।)

**বাস্তবের দুটো সতর্কতা:**

- Vector এর আকার — **প্রতিটা replica** এর জন্য একটা ঘর, প্রতিটা client এর জন্য না (হাজার হাজার client হলে vector বিশাল)। Exercise তাই করে।
- একটা সূক্ষ্ম bug: সাধারণ vector clock এ, একই replica তে একটা লেখা আসার ঠিক পরে আরেকটা লেখা আসলে, ভুল করে প্রথমটাকে "পুরনো" ধরে ফেলা যায়। Riak এটা ঠিক করতে **dotted version vector** এ গিয়েছিল — প্রতিটা লেখার নিজের একটা "dot" (কোন replica র কত নম্বর লেখা) আর তার দেখা context আলাদা রেখে। Exercise এর `lww.ts` এটাই ব্যবহার করে — আর এটা আরেকটা কারণ, কেন এসব নিজে লিখতে নেই।

### ১.৭ মাঝামাঝি পথ — Hybrid Logical Clock আর TrueTime

Logical clock এর একটা অসুবিধা: সংখ্যাগুলোর wall clock এর সাথে কোনো সম্পর্ক নেই। "গত ৫ মিনিটের লেখা দেখাও" জাতীয় query করা যায় না, আর মানুষ debug করতে গিয়ে "Lamport 48213" এর মানে বোঝে না।

**Hybrid Logical Clock (HLC)** — একটা timestamp যেটা wall clock এর সময় আর একটা ছোট logical counter মিলিয়ে বানানো: সাধারণত wall clock এর কাছাকাছি থাকে (মানুষ পড়তে পারে), কিন্তু message এর সাথে Lamport এর মতো এগোয়, তাই কার্যকারণ কখনো ভাঙে না — এমনকি ঘড়ি একটু ভুল হলেও।

CockroachDB HLC ব্যবহার করে; MongoDB এর cluster time (6.3 এর `afterClusterTime`) ও এই ধরনের। HLC কার্যকারণ রক্ষা করে, কিন্তু concurrent চেনে না — সে এখনো Lamport এর পরিবারের।

আর উল্টো দিক থেকে সমাধান: **Google Spanner এর TrueTime।** প্রতিটা data center এ GPS receiver আর atomic clock, আর API টা একটা সংখ্যা না দিয়ে একটা **সীমা** দেয়: "এখন সময় [earliest, latest] এর মধ্যে কোথাও" — সাধারণত কয়েক ms এর অনিশ্চয়তা। একটা transaction commit করার পরে Spanner সেই অনিশ্চয়তা পেরোনো পর্যন্ত **অপেক্ষা করে** (commit wait), তারপর commit টা দৃশ্যমান করে — যাতে পরে যে কোনো জায়গায় শুরু হওয়া transaction নিশ্চিতভাবে বড় timestamp পায়। মানে ঘড়ির ভুলকে অস্বীকার না করে, **মেপে, তার দাম দিয়ে** (প্রতিটা লেখায় কয়েক ms)। Special hardware ছাড়া এটা নকল করা যায় না।

### ১.৮ Distributed Lock আর ঘড়ি

6.1 এর lease এ ফিরি, এবার ঘড়ির চোখে। Lease এর মেয়াদ = একটা সময়ের **দৈর্ঘ্য** — তাই ১.১ এর নিয়ম মানলে দুই machine এর ঘড়ি মেলার দরকারই নেই। দরকার শুধু দুটো ঘড়ি মোটামুটি **একই গতিতে** চলুক। তবু তিনটা জায়গায় ঘড়ি lease কে ভাঙতে পারে:

1. **Wall clock দিয়ে মেয়াদ হিসাব।** Lock server `expiresAt = Date.now() + ttl` রাখল; তারপর NTP তার ঘড়ি ২ সেকেন্ড সামনে ঠেলল — সব lease হঠাৎ ২ সেকেন্ড আগে শেষ, আর holder এখনো কাজ করছে। দুজন holder। (Holder এর দিকেও একই: সে `Date.now()` দিয়ে "আমার lease আর কতক্ষণ" হিসাব করলে ঘড়ি পেছনে গেলে ভাববে lease এখনো অনেক বাকি।) **সমাধান:** দুই দিকেই monotonic ঘড়ি।
2. **Drift।** Holder এর ঘড়ি একটু ধীরে চলে — তার হিসাবে ১০ সেকেন্ড, lock server এর হিসাবে ১০.০০২। সাধারণত ছোট, কিন্তু holder এর উচিত মেয়াদ **নিরাপদ দিকে** হিসাব করা: request **পাঠানোর** মুহূর্ত থেকে গোনা (6.1 এর exercise এ worker ঠিক এটা করত), আর শেষ মুহূর্ত পর্যন্ত না গিয়ে একটু আগে থামা।
3. **Pause** — 6.1 পুরোটা। ঘড়ি যত নিখুঁতই হোক, থেমে থাকা process ঘড়ি দেখে না।

তাই 6.1 এর সিদ্ধান্তটা এখন আরও জোরালো: lease **কার্যক্ষমতার (efficiency)** জন্য ঘড়ি ব্যবহার করুক — কিন্তু **সঠিকতার** জন্য fencing token। আর fencing token কী? একটা সংখ্যা যেটা শুধু বাড়ে, আর বড়টা জেতে — একটা **logical clock**। 6.2 এর term, etcd এর revision, আজকের Lamport clock — একই ধারণার তিনটা রূপ।

(একটা ব্যবহারিক খুঁটিনাটি: etcd এর lease এর মেয়াদ হিসাব করে etcd এর leader, নিজের ঘড়িতে। Leader বদলালে নতুন leader সব lease এর মেয়াদ নতুন করে শুরু করে — যাতে leader বদলের সময়টুকুর জন্য কারো lease অকারণে শেষ না হয়। নিরাপদ দিকে ভুল: lease কখনো কখনো একটু **বেশি** সময় টেকে, কখনো কম না।)

> **Trade-off Table — "কোনটা আগে/নতুন" ঠিক করার উপায়**

| উপায়                      | কার্যকারণ রক্ষা করে?              | Concurrent চেনে?   | দাম                                                | কোথায়                             |
| -------------------------- | --------------------------------- | ------------------ | -------------------------------------------------- | ---------------------------------- |
| Wall clock timestamp (LWW) | না — skew এ পরের লেখা হারায়      | না — একটা ফেলে     | শূন্য; ক্ষতি নীরব                                  | Cassandra default, অনেক cache      |
| Lamport clock (LWW)        | হ্যাঁ                             | না — একটা ফেলে     | প্রতিটা message এ একটা সংখ্যা                      | Log ক্রম, Raft term, fencing token |
| Hybrid Logical Clock       | হ্যাঁ                             | না                 | একটা সংখ্যা; wall clock এর কাছাকাছি, পড়া যায়     | CockroachDB, MongoDB cluster time  |
| Vector clock + sibling     | হ্যাঁ                             | হ্যাঁ — দুটোই রাখে | replica প্রতি একটা ঘর; app কে মেলাতে হয়           | Dynamo, Riak; offline sync         |
| TrueTime + commit wait     | হ্যাঁ, wall clock এর সাথে মিলিয়ে | —                  | GPS/atomic clock hardware; প্রতিটা লেখায় কয়েক ms | Google Spanner                     |

---

## ২. Interview Angle

**"দুটো server এর ঘটনা timestamp দিয়ে সাজালে সমস্যা কী?"** — Skew, drift, NTP এর লাফ, leap second — timestamp এর ক্রম আর আসল কার্যকারণের ক্রম আলাদা হতে পারে। তারপর বলো কী ব্যবহার করবে: কার্যকারণ দরকার হলে logical clock; debugging log এর জন্য request এ একটা trace id (Lesson 10.4) যেটা পুরো শিকল ধরে রাখে।

**"Last-write-wins এ সমস্যা কী?"** — দুটো আলাদা ক্ষতি আলাদা করে বলো, এটাই আসল উত্তর: (১) ঘড়ির ভুলে **পরের** লেখা হারায় — Lamport/HLC দিয়ে ঠিক হয়; (২) **concurrent** লেখার একটা নীরবে হারায় — এটা কোনো ঘড়ি দিয়ে ঠিক হয় না, কারণ এটাই LWW এর সংজ্ঞা। তারপর: "যে data তে একটা লেখা হারানো চলে (cache, last-seen) সেখানে LWW ঠিক আছে; না চললে vector clock + sibling, বা conflict এড়ানো (একটা data এর সব লেখা এক leader এ)।"

**"Lamport clock আর vector clock এর পার্থক্য?"** — একটা বাক্যে: "Lamport বলতে পারে 'এটা আগে ঘটেনি', vector বলতে পারে 'এরা concurrent'।" তারপর দাম: Lamport একটা সংখ্যা, vector প্রতি node একটা।

**"Distributed lock এ timeout কীভাবে মাপবে?"** — Monotonic ঘড়ি, নিরাপদ দিকে মেয়াদ, আর lease কে সঠিকতার জন্য বিশ্বাস না করে fencing token।

**Production এ বাস্তবে:** প্রতিটা server এ NTP (বা cloud এর time sync service) চালু আর **monitored** — skew এ alert। Code review তে `Date.now()` দিয়ে timeout মাপা ধরো। আর conflict এর নিয়ম হিসেবে LWW বাছার আগে জিজ্ঞেস করো: "এই data তে একটা লেখা নীরবে হারালে কী হবে?"

---

## ৩. Key Takeaway

- দুই রকম ঘড়ি: **wall clock** (কয়টা বাজে — লাফাতে পারে, পেছনে যেতে পারে) আর **monotonic** (কত সময় গেল — শুধু দৈর্ঘ্য মাপতে); timeout/lease/latency সবসময় monotonic দিয়ে
- দুটো machine এর ঘড়ি কখনো মেলে না: drift, NTP এর সীমা আর ব্যর্থতা, leap second — আর সবচেয়ে খারাপ দিনটা আগে থেকে জানা যায় না
- **LWW দুটো আলাদা ক্ষতি করে:** ঘড়ির ভুলে **পরের** লেখা হারায় (exercise এ ১০টা, সবই ঘড়ি পিছিয়ে থাকা replica তে bot এর), আর **concurrent** লেখার একটা নীরবে হারায় (৪৩টা — ঘড়ি ঠিক করলেও থাকে)
- **Happens-before:** "কোনটা কোনটাকে প্রভাবিত করতে পারত" — একই process এর ক্রম আর message এর শিকল; কোনোটাই না হলে concurrent
- **Lamport clock:** a → b হলে L(a) < L(b), কিন্তু উল্টোটা না; কার্যকারণ রক্ষা করে (প্রথম ক্ষতি শূন্য), concurrent চেনে না (দ্বিতীয়টা থাকে)
- **Vector clock:** concurrent চেনে, দুটোই **sibling** হিসেবে রাখে — কিছু হারায় না, কিন্তু মেলানোর দায় application এর; HLC আর TrueTime মাঝামাঝি পথ
- Lock/lease এ ঘড়ি শুধু দৈর্ঘ্যের জন্য (monotonic, নিরাপদ দিকে); সঠিকতা আসে fencing token থেকে — যেটা নিজেই একটা logical clock

---

## ৪. নতুন Term (Glossary)

| Term                     | অর্থ                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Monotonic Clock**      | শুধু সময়ের দৈর্ঘ্য মাপার ঘড়ি — সবসময় সামনে যায়, NTP এর লাফে বদলায় না; এর মানের অন্য machine এ কোনো অর্থ নেই |
| **Clock Skew / Drift**   | দুটো ঘড়ির একই মুহূর্তের পার্থক্য (skew), আর একটা ঘড়ি আসল সময়ের চেয়ে কত দ্রুত/ধীরে চলে (drift, ppm এ)         |
| **Happens-Before**       | a, b কে প্রভাবিত করতে পারত — একই process এ আগে-পরে, বা message এর শিকল ধরে; কোনোটাই না হলে দুটো concurrent       |
| **Lamport Clock**        | প্রতি process এর একটা counter — প্রতি ঘটনায় বাড়ে, message এ যায়, পেলে max + 1; a → b হলে L(a) < L(b)          |
| **Vector Clock**         | প্রতি process এর কাছে সবার counter এর তালিকা; তুলনা করে বলা যায় a → b, b → a, নাকি concurrent                   |
| **Sibling**              | Concurrent দুটো (বা বেশি) version যাদের কেউ অন্যটাকে ঢাকে না — database দুটোই রাখে, application মেলায়           |
| **Hybrid Logical Clock** | Wall clock এর সময় + একটা logical counter — মানুষ পড়তে পারে, আর কার্যকারণ কখনো ভাঙে না                          |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. Ticket ৩: তিনটা region এর log timestamp দিয়ে সাজালে "comment notification পাঠানো হলো" আগে আসছে, "comment তৈরি হলো" পরে। এটা কি bug? Debugging এর জন্য log এ কী যোগ করলে কার্যকারণের ক্রম সবসময় ঠিক দেখা যাবে?
2. একটা code review তে এই অংশ পেলে:

   ```typescript
   const acquiredAt = Date.now();
   while (Date.now() - acquiredAt < LEASE_MS - 500) {
   	await processNextBatch();
   }
   ```

   কী কী সমস্যা বলবে? `performance.now()` এ বদলালে কি lease নিরাপদ হয়ে যায়?

3. TaskFlow এর offline mobile app: দুটো device offline অবস্থায় একই task এর (ক) title, (খ) description, (গ) checklist item এর তালিকা, আর (ঘ) "done" status বদলাল। পরে দুটোই sync করল। প্রতিটার জন্য কোন conflict নিয়ম নেবে — LWW (কোন ঘড়ি দিয়ে?), sibling দেখিয়ে user কে জিজ্ঞেস করা, নাকি নিজে থেকে মেলানো — আর কেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Bug না — তিনটা machine এর wall clock এর skew। Notification পাঠানো server এর ঘড়ি comment তৈরি করা server এর চেয়ে পিছিয়ে থাকলে, পরে ঘটা ঘটনার timestamp ছোট। ঘড়ি যত ভালোই হোক, দুটো ঘটনা কয়েক ms এর মধ্যে ঘটলে এটা হবেই। সমাধান: log এ কার্যকারণ রাখো, সময় না। সবচেয়ে ব্যবহারিক: প্রতিটা request এর একটা **trace id**, আর প্রতিটা ধাপে একটা **parent span id** — কোন ঘটনা কোনটার কারণে ঘটেছে সেটা সরাসরি লেখা থাকে (Lesson 10.4 এর distributed tracing)। বিকল্প: service থেকে service এ message এর সাথে একটা Lamport counter পাঠানো আর log এ লেখা — তখন `(lamport, service)` দিয়ে সাজালে কার্যকারণের ক্রম কখনো ভাঙে না। Wall clock এর timestamp মানুষের জন্য রাখো ("প্রায় কখন"), ক্রমের জন্য না।

**প্রশ্ন ২:**

- **Wall clock দিয়ে দৈর্ঘ্য:** NTP ঘড়ি পেছনে ঠেললে `Date.now() - acquiredAt` ছোট হয়ে যায় — loop lease এর মেয়াদ পেরিয়েও চলতে থাকে। সামনে ঠেললে অকারণে আগে থামে। → `performance.now()`।
- **মেয়াদ কোথা থেকে গোনা:** `acquiredAt` lock **পাওয়ার** পরে নেওয়া — কিন্তু lock server এর মেয়াদ শুরু হয়েছিল request পৌঁছানোর সময়, যেটা আগে। নিরাপদ: request **পাঠানোর** আগে সময় নাও।
- **যাচাই শুধু batch এর শুরুতে:** একটা `processNextBatch()` যদি ৩ সেকেন্ড নেয় (বা মাঝপথে GC pause), শেষ batch টা lease এর বাইরে চলে যায়। ৫০০ ms এর margin এটা ধরে না।
- **আর সবচেয়ে বড় কথা:** `performance.now()` এ বদলালেও lease **নিরাপদ হয় না** — 6.1 এর process pause যেকোনো যাচাই আর কাজের মাঝে আসতে পারে। Monotonic ঘড়ি ঘড়ির লাফ ঠিক করে, pause না। প্রতিটা batch এর লেখায় fencing token দরকার।

**প্রশ্ন ৩:**

- **(ক) Title:** ছোট, একটা মান; দুটো version মেলানো যায় না। দুটো device concurrent বদলালে user কে দেখিয়ে বাছতে বলা (sibling) সবচেয়ে সৎ; কিন্তু সাধারণত title এ conflict বিরল, আর একটা হারালে ক্ষতি ছোট — তাই অনেক app LWW নেয়। নিলে device এর wall clock দিয়ে **না** (phone এর ঘড়ি ভুল হতে পারে, user বদলাতে পারে) — HLC বা server এর sync এর সময়ের ক্রম দিয়ে, আর "অন্য কেউ এটা বদলেছিল" একটা ছোট notification।
- **(খ) Description:** লম্বা text, দুজনের কাজ হারানো গুরুতর। Sibling রেখে দুটোই দেখানো (Git এর মতো merge), বা আরও ভালো — text এর জন্য বানানো CRDT (Google Docs/Notion জাতীয় collaborative editing এর মতো), যেটা অক্ষর-পর্যায়ে দুজনের পরিবর্তন মিলিয়ে দেয়।
- **(গ) Checklist item:** একটা set/list — নিজে থেকে মেলানো যায়: দুই দিকের যোগ করা item এর union; মুছে ফেলা item এর জন্য "tombstone" (মুছে ফেলার চিহ্ন) রাখা, নইলে মুছে ফেলা item ফিরে আসবে (Dynamo এর shopping cart এর সমস্যা)। User কে কিছু জিজ্ঞেস করার দরকার নেই।
- **(ঘ) Done status:** একটা boolean — কিন্তু নিয়মটা business এর: একজন done করল, আরেকজন (যে পুরনো অবস্থা দেখছিল) অন্য কিছু বদলাল কিন্তু status ছুঁয়নি — তাহলে status এর কোনো conflict নেই (field ধরে merge, পুরো task ধরে না)। দুজনেই status বদলালে (একজন done, একজন not done), সাধারণত "done জেতে" বা শেষ কার্যকারণ-ক্রমের লেখা জেতে — কিন্তু সেটা ঠিক করবে product, ঘড়ি না।

সাধারণ শিক্ষা: conflict এর নিয়ম **data এর ধরন দেখে, field ধরে** বাছতে হয় — পুরো object এর জন্য একটা LWW সবচেয়ে সহজ, আর প্রায়ই সবচেয়ে বেশি data হারায়।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (deterministic)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-6.4-logical-clocks/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-6.4-logical-clocks) — `npm install`, তারপর `npm run clocks` আর `npm run lww`। Docker লাগবে না। পুরো setup, acceptance criteria আর experiment গুলো ওখানকার `README.md` এ আছে।

`clocks.ts` একটা হাতে মেলানোর মতো উদাহরণ — Lamport আর vector clock এর নিয়ম comment সহ। `lww.ts` তিনটা replica আর তিনটা conflict নিয়মের simulation, যেটা প্রতিটা লেখার সত্যিকারের কার্যকারণ জানে আর সেটা দিয়ে মাপে কোন নিয়ম কী হারাল।

**সৎ নোট:** Sandbox এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; দুটো script দুবার করে চালিয়ে হুবহু একই output। বাড়তি যাচাই: n3 এর ঘড়ি ঠিক করলে "পরে-করা edit হারল" ১০ → ০ (README এর experiment ১); আর সেই ১০টার প্রতিটা যে bot এর আর n3 তে লেখা — সেটাও মেপে দেখা হয়েছে। Experiment ২–৪ তোমার কাজ।

**সেটআপ যাচাই হলে, এই পাঁচটা করো:**

1. **আগে কাগজে:** `clocks.ts` এর ১০টা ঘটনার Lamport আর vector timestamp নিজে হিসাব করো, তারপর `npm run clocks` চালিয়ে মেলাও। কোথাও ভুল হলে কোন নিয়মটা বাদ পড়েছিল? তারপর নিজে একটা জোড়া খুঁজে বের করো (table এর বাইরে) যেটা concurrent।

2. `lww` চালাও। তিনটা সারির প্রতিটার জন্য এক লাইনে লেখো: এই নিয়ম কী হারায়, আর কেন।

3. **ঘড়ি এগিয়ে** (experiment ২): n3 এর skew `+400`। এবার কার লেখা হারায়? পিছিয়ে থাকা আর এগিয়ে থাকা ঘড়ির ক্ষতি কীভাবে আলাদা — এক লাইনে।

4. **Merge** (experiment ৪): title এর বদলে task এর label এর set ধরো। `vector` নিয়মে sibling পেলে union নিয়ে লেখার code লেখো। একটা label মুছে ফেলা আর অন্য device এ একই সময়ে আরেকটা যোগ করা — দুটোর পরে কী থাকে? মুছে ফেলা label ফিরে আসে কি?

5. **Design অংশ:** TaskFlow এর multi-region pilot আর offline app এর জন্য conflict এর নিয়ম লেখো — field ধরে (title, description, status, assignee, label, checklist, due date)। প্রতিটার জন্য: LWW (কোন ধরনের clock দিয়ে), sibling + user কে জিজ্ঞেস করা, নাকি নিজে থেকে মেলানো। আর ticket ১, ২, ৩ — প্রতিটা তোমার নিয়মে কোথায় বন্ধ হয়, দেখাও।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5 (সম্পূর্ণ, exit challenge সহ), 6.1, 6.2, 6.3
Current: 6.4 — Distributed Lock, Logical Clock: Lamport, Vector Clock
TaskFlow state: Nginx + Express instance গুলো, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; read path এ version token; multi-region লেখার pilot আর offline
mobile app — conflict নিয়ম field ধরে (ঘড়ির LWW বাদ; HLC/Lamport ক্রম, description এ sibling,
label/checklist এ নিজে থেকে মেলানো); সব timeout/lease monotonic ঘড়িতে; NTP skew এ alert;
log এ trace id
Terms learned (Module 6 so far): Partial Failure, Failure Model, Failure Detector,
Process Pause, Split Brain, Lease, Fencing Token, Consensus, FLP Impossibility,
Replicated State Machine, Term, Randomized Election Timeout, Committed Entry,
Election Restriction, Session Guarantee, Monotonic Reads, Consistent Prefix Read,
Version Token, Read Repair, Hinted Handoff, Anti-Entropy, Monotonic Clock,
Clock Skew/Drift, Happens-Before, Lamport Clock, Vector Clock, Sibling,
Hybrid Logical Clock
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 6.5 — Consistency models: strong → eventual, বাস্তবে কেমন লাগে
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠাও — বিশেষ করে ১ নম্বরের হাতের হিসাব আর ৫ নম্বরের field-ধরে নিয়ম। রেডি হলে `next` লিখো — Lesson 6.5 এ যাব: **Consistency models — strong থেকে eventual।** Module 6 জুড়ে অনেকগুলো নিশ্চয়তার নাম এসেছে — linearizable (6.2 এর ReadIndex), read-your-writes আর monotonic read (6.3), causal (6.3–6.4), eventual (5.9)। Module এর শেষ lesson এ এগুলোকে একটা মই এ সাজাব: কোনটা কোনটার চেয়ে শক্ত, প্রতিটা ধাপে কী হারাও আর কী পাও, আর interview এ "আমার system এর consistency model কী" প্রশ্নের একটা পরিষ্কার উত্তর।
