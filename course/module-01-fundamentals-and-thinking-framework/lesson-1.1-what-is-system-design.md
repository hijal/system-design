# Lesson 1.1 — System Design আসলে কী, কেন শিখবো, Engineer রা কীভাবে চিন্তা করে

**Module 1 — Foundations of Scalability and System Design Principles**

---

**Prerequisite:** নেই (এটাই একদম শুরু)

**তুমি এই lesson শেষে পারবে:**

1. "System Design" জিনিসটা আসলে কী, আর এটা "code লেখা"-র চেয়ে কীভাবে আলাদা — নিজের ভাষায় বলতে পারবে।
2. একটা ছোট, নিখুঁতভাবে চলা system কীভাবে scale বাড়ার সাথে সাথে "system design সমস্যা"-য় রূপ নেয় — বুঝবে।
3. Functional আর Non-functional requirement এর পার্থক্য করতে পারবে, এবং কেন এই পার্থক্যটাই পুরো design এর ভিত্তি — ব্যাখ্যা করতে পারবে।

**Tier:** 3 — আজকে কোনো code লিখবো না, pure thinking exercise। (Coding শুরু হবে যখন theory একটু গড়ে উঠবে।)

> **Spaced repetition note:** যেহেতু এটাই প্রথম lesson, আগের কিছু থেকে প্রশ্ন করার সুযোগ নেই। Lesson 1.2 থেকে এটা শুরু হবে।

---

## ০. TaskFlow এখন কোথায়

ধরো, তুমি TaskFlow বানিয়েছ — একটা team task management app। Backend এ একটা Express server, একটা PostgreSQL database, Sequelize দিয়ে ORM। Frontend SvelteKit। মোটামুটি ১০০ জন ইউজার ব্যবহার করছে — একটা ছোট স্টার্টআপের টিম। সবকিছু smooth চলছে। `npm start` করলে server ওঠে, database এ query যায়, response আসে ২০-৩০ millisecond এ। তুমি খুশি, ইউজাররাও খুশি।

এখন client বলল — "আমাদের app টা ভালো লাগছে, আমরা এটা বড় করতে চাই। পরের ৬ মাসে ১০ লাখ ইউজার টার্গেট।"

এখানেই আসল প্রশ্নটা দাঁড়ায়: **তোমার আজকের কোড কি ১০ লাখ ইউজার handle করতে পারবে?**

উত্তরটা প্রায় নিশ্চিতভাবে "না"। কিন্তু কেন না — সেটা বোঝাই আজকের lesson এর কাজ। আজকে আমরা কোনো code লিখব না, কোনো fix করব না। আজকে শুধু বুঝব — **"system design" নামের এই জিনিসটা আসলে কোন প্রশ্নের উত্তর দেয়**, আর কেন এটা তোমার এখন পর্যন্ত শেখা "coding" থেকে একদম আলাদা এক ধরনের চিন্তা।

---

## ১. Theory

### ১.১ Coding vs System Design — পার্থক্যটা ঠিক কোথায়

তুমি যখন একটা feature কোড করো — ধরো, TaskFlow এ "task assign করা" ফিচার — তখন তোমার প্রশ্ন থাকে:

- এই function এর input/output কী হবে?
- Database schema কী হবে?
- Edge case (যেমন, খালি title, দুইবার click) কীভাবে handle করব?

এই প্রশ্নগুলোর প্রতিটার একটা **নির্দিষ্ট, স্থির উত্তর** আছে — কোড লিখলেই সেটা "কাজ করে" বা "কাজ করে না"।

System Design এর প্রশ্ন সম্পূর্ণ ভিন্ন ধরনের:

- এই feature টা যদি **এক সেকেন্ডে ১০,০০০ বার** call হয়, তাহলে কী হবে?
- Server টা যদি **হঠাৎ বন্ধ হয়ে যায়**, ইউজার কি data হারাবে?
- আমরা যদি **আরেকটা server** যোগ করি, দুটো server কি একই data দেখবে?
- এই system বানাতে **মাসে কত খরচ** হবে, আর ইউজার বাড়লে খরচ কীভাবে বাড়বে?

লক্ষ্য করো — এই প্রশ্নগুলোর কোনোটারই একটা "সঠিক" উত্তর নেই। প্রতিটা উত্তরের একটা **cost** আছে, একটা **trade-off** আছে। System Design মানে হলো — **অনেকগুলো অসম্পূর্ণ, একে অপরের বিরোধী সমাধানের মধ্যে থেকে, তোমার constraint (সময়, টাকা, টিমের সাইজ, ইউজারের চাহিদা) অনুযায়ী সবচেয়ে যুক্তিসঙ্গত সমাধানটা বেছে নেওয়া, এবং সেই বাছাইয়ের কারণ ব্যাখ্যা করতে পারা।**

এইজন্যই system design ইন্টারভিউতে "সঠিক উত্তর" বলে কিছু নেই — interviewer দেখতে চায় তুমি **কীভাবে চিন্তা করছ**, শুধু answer না।

### ১.২ একটা simple system এর ভেতরে কী কী "ভাঙতে পারে"

TaskFlow কে একটা ASCII diagram এ দেখি:

```
[Browser/Client] ---- HTTP request ----> [Express Server] ---- SQL query ----> [PostgreSQL]
       <---------- HTTP response -----------------<---------- result ------------
```

১০০ ইউজারে এই ছবিটা একদম নিখুঁত। কিন্তু চিন্তা করো — এই একটামাত্র ছবির ভেতরে কতগুলো **hidden assumption** লুকিয়ে আছে:

1. **Server টা সবসময় চালু থাকবে** — কিন্তু যদি server crash করে? ইউজার তখনই কি সব হারাবে?
2. **Server টা একসাথে সব request handle করতে পারবে** — কিন্তু ১ সেকেন্ডে যদি ৫০,০০০ request আসে?
3. **Database সবসময় দ্রুত উত্তর দেবে** — কিন্তু data ১০০ row থেকে ১ কোটি row হলে?
4. **Client আর Server এর মাঝের network সবসময় কাজ করবে** — কিন্তু network delay/loss হলে?
5. **একটাই server, তাই data সবসময় consistent** — কিন্তু দুটো server হলে, কোনটা "সঠিক" data রাখবে?

১০০ ইউজারে এই প্রশ্নগুলো "তাত্ত্বিক" মনে হয় — কারণ probability এতটাই কম যে সমস্যা কখনো চোখে পড়ে না। কিন্তু ইউজার সংখ্যা যত বাড়ে, এই "তাত্ত্বিক" সমস্যাগুলো তত বেশি **বাস্তব ও নিয়মিত ঘটনা**য় পরিণত হয়। এটাই **scale**-এর আসল মানে — সংখ্যা এমনভাবে বাড়ে যে, যে জিনিসগুলো আগে "কখনো ঘটবে না" মনে হতো, সেগুলো এখন "প্রতিদিন ঘটে"।

> **Trade-off table — Simple Architecture vs Scalable Architecture**

| দিক                    | Simple (একটা server, একটা DB)            | Scalable (multi-server, distributed) |
| ---------------------- | ---------------------------------------- | ------------------------------------ |
| Build করতে সময়        | কম                                       | বেশি                                 |
| Operational complexity | কম                                       | বেশি (monitor, debug করা কঠিন)       |
| খরচ (কম ইউজারে)        | কম                                       | বেশি — অপ্রয়োজনীয় খরচ              |
| খরচ (বেশি ইউজারে)      | সিস্টেম ভেঙে পড়ে, বা খরচ বেহিসেবি বাড়ে | নিয়ন্ত্রিতভাবে বাড়ে                |
| Failure এ কী হয়       | পুরো system down                         | অংশবিশেষ down, বাকিটা চলে            |

এখানেই প্রথম বড় শিক্ষা: **"Scalable architecture" সবসময় "ভালো" না।** ১০০ ইউজারের app কে Netflix-এর মতো architecture দিয়ে বানানো — এটাও একটা ভুল design decision, ঠিক যেমন ১ কোটি ইউজারের app কে single-server দিয়ে বানানো ভুল। System Design এর কাজ হলো **তোমার আসল constraint অনুযায়ী সঠিক জায়গায় দাঁড়ানো** — over-engineering আর under-engineering দুটোই সমান বিপজ্জনক। এই পুরো course জুড়ে আমরা TaskFlow কে ধাপে ধাপে evolve করব ঠিক এই কারণেই — যাতে তুমি দেখতে পাও, _কোন সমস্যা এলে_ কোন সমাধান আসে, শুরু থেকেই সব যোগ করে না।

### ১.৩ Functional vs Non-functional Requirements

System design এর প্রথম কাজ — একটা system কে দুই ভাগে ভাগ করে দেখা:

- **Functional Requirements** — system টা _কী করে_। যেমন: "ইউজার task তৈরি করতে পারবে", "ইউজার task assign করতে পারবে"। এগুলো তুমি এতদিন coding এ যা করেছ, তার সাথেই পরিচিত।
- **Non-functional Requirements** — system টা _কেমনভাবে_ সেই কাজ করে। যেমন: "response ২০০ms এর মধ্যে আসতে হবে", "সিস্টেম ৯৯.৯% সময় available থাকতে হবে", "একসাথে ১০,০০০ ইউজার handle করতে পারতে হবে"।

Coding interview মূলত functional requirement নিয়ে কাজ করে — "এই feature বানাও"। System design interview মূলত non-functional requirement নিয়ে কাজ করে — "এই feature টা ১ কোটি ইউজারে, ৯৯.৯৯% uptime এ, ১০০ms এর মধ্যে চালাও"। **এই non-functional requirement গুলোই আসলে সব architecture decision কে চালায়** — এটাই সবচেয়ে গুরুত্বপূর্ণ mindset shift যেটা আজকে থেকে তোমার মধ্যে গড়ে তুলতে হবে।

---

## ২. Interview Angle

System design round এ সাধারণত interviewer একটা open-ended প্রশ্ন দেয় — "Design a URL shortener" বা "Design TaskFlow for 1 million users"। যারা এই round এ খারাপ করে, তাদের সবচেয়ে common ভুল হলো — **সরাসরি architecture আঁকা শুরু করে দেওয়া**, requirement স্পষ্ট না করেই।

Interviewer আসলে যা দেখতে চায়:

1. তুমি কি প্রথমে **প্রশ্ন করছ** — functional আর non-functional requirement স্পষ্ট করতে? (যেমন: "কত ইউজার আশা করছি?", "read বেশি হবে না write বেশি?")
2. তুমি কি **trade-off বলতে পারছ**, শুধু "এই টুল ব্যবহার করব" না বলে "এই টুলটা কেন, আর এর বদলে অন্য কিছু ব্যবহার করলে কী হারাতাম"?
3. তুমি কি **communicate** করতে পারছ — মাথায় যা আছে সেটা অন্যের কাছে স্পষ্টভাবে বোঝাতে পারছ?

মজার বিষয় হলো — এই round এ "সঠিক architecture" বলাটা আসলে সবচেয়ে কম গুরুত্বপূর্ণ। একজন junior engineer আর senior engineer একই architecture বলতে পারে, কিন্তু senior engineer **কেন** সেই architecture বেছে নিল, কী trade-off মেনে নিল — সেটা ব্যাখ্যা করতে পারে অনেক ভালোভাবে। এই পুরো course এ আমরা প্রতিটা lesson এই দুই জিনিস একসাথে গড়ে তুলব — **theory** আর **সেটা ভাষায় বলার ক্ষমতা**।

---

## ৩. Key Takeaway

- System Design মানে "সঠিক উত্তর" খোঁজা না — constraint অনুযায়ী trade-off বেছে নেওয়া
- Coding প্রশ্নের উত্তর "কাজ করে/করে না" — Design প্রশ্নের উত্তর "কোন cost এ কাজ করে"
- একটা simple system এর মধ্যে অনেক hidden assumption থাকে, যেগুলো scale বাড়লে ভেঙে পড়ে
- Scale মানে — যে জিনিস আগে "প্রায় কখনো ঘটে না" ছিল, সেটা এখন "নিয়মিত ঘটনা"
- Over-engineering (দরকারের চেয়ে বেশি জটিল বানানো) আর Under-engineering (স্কেল না ভেবে বানানো) — দুটোই খারাপ design
- Functional requirement = system কী করে; Non-functional requirement = কেমনভাবে করে (speed, availability, scale)
- Interview এ architecture এর চেয়ে বেশি গুরুত্বপূর্ণ — requirement স্পষ্ট করা আর trade-off ব্যাখ্যা করতে পারা

---

## ৪. নতুন Term (Glossary)

| Term                           | অর্থ                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **System Design**              | একটা software system কে কীভাবে গঠন করলে সেটা নির্দিষ্ট constraint (scale, cost, reliability) এর মধ্যে কাজ করবে, সেটা ঠিক করার প্রক্রিয়া |
| **Scale / Scaling**            | ইউজার, ডেটা, বা ট্রাফিক বাড়ার সাথে সাথে system এর ওপর চাপ বাড়া, এবং সেই চাপ সামলানোর ক্ষমতা                                            |
| **Trade-off**                  | একটা সুবিধা পেতে গিয়ে আরেকটা কিছু ছাড় দেওয়া (যেমন: speed বাড়াতে গিয়ে complexity বাড়ানো)                                            |
| **Functional Requirement**     | system টা কী কাজ করে, তার বর্ণনা                                                                                                         |
| **Non-functional Requirement** | system টা কেমন performance, reliability, scale এ সেই কাজ করে, তার বর্ণনা                                                                 |

---

## ৫. Reflection Questions

আগে নিজে ভেবে উত্তর দাও, তারপর নিচের Answer Key দেখো।

1. TaskFlow এখন ১০০ ইউজারে নিখুঁত চলছে — একটা Express server, একটা Postgres। যদি হঠাৎ ১০ লাখ ইউজার আসে, তোমার মতে **সবচেয়ে আগে কোন জিনিসটা ভেঙে পড়বে**, এবং কেন?
2. তোমাকে যদি বলা হয় "TaskFlow টা design করো" — architecture আঁকার আগে, ক্লায়েন্ট/interviewer কে তুমি প্রথম কোন ৩টা প্রশ্ন করবে?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** সাধারণত সবচেয়ে আগে ভাঙে **database connection**। Postgres এর একটা default connection limit থাকে (সাধারণত ১০০-এর কাছাকাছি)। ১০ লাখ ইউজার একসাথে না হলেও, যদি হাজার খানেক concurrent request আসে, আর প্রতিটা request একটা করে DB connection ধরে রাখে, তাহলে connection pool শেষ হয়ে যাবে আর নতুন request গুলো error পাবে বা অনেকক্ষণ wait করবে। এরপর ভাঙে single server এর CPU/memory — একটা মাত্র Node.js process কতগুলো concurrent request handle করতে পারে তার একটা সীমা আছে।

**প্রশ্ন ২:** ভালো প্রশ্নগুলো হতে পারে — "কত ইউজার আশা করছি, এবং কত দ্রুত এই সংখ্যায় পৌঁছাবে?", "Read বেশি হবে নাকি Write বেশি (মানে, ইউজাররা বেশি task দেখবে, নাকি বেশি নতুন task/update করবে)?", "System টা কতটা downtime সহ্য করতে পারবে (৫ মিনিট? ৫ সেকেন্ড?)"। এই প্রশ্নগুলোর উত্তরের ওপর ভিত্তি করেই আসল architecture decision নেওয়া হয় — এটাই পরের lesson (1.2, The Design Framework) এ বিস্তারিত শিখব।

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise**

নিচের scenario টা পড়ো, তারপর উত্তর দাও। আমি এখনই model answer দিচ্ছি না — তুমি চেষ্টা করার পর আমি critique করব।

> **Scenario:** TaskFlow এর client তোমাকে বলল — "আমরা চাই TaskFlow এ real-time notification থাকুক — কেউ যখন তোমাকে task assign করে, সাথে সাথে তুমি জানতে পারবে, page reload ছাড়াই।"
>
> এই একটা লাইনের requirement থেকে —
>
> 1. এখানে কোন কোন **Functional Requirement** লুকিয়ে আছে সেটা লিখো (কমপক্ষে ২টা)
> 2. এখানে কোন কোন **Non-functional Requirement** থাকতে পারে, যেগুলো client explicitly বলেনি কিন্তু implicitly আশা করছে (কমপক্ষে ৩টা — যেমন: notification কত দ্রুত পৌঁছাতে হবে, কতজন ইউজার একসাথে online থাকতে পারবে, ইত্যাদি)
> 3. এই ৩টা non-functional requirement এর মধ্যে কোনটা সবচেয়ে বেশি architecture কে প্রভাবিত করবে বলে তোমার মনে হয়, এবং কেন?

তোমার উত্তর লিখে পাঠাও — আমি দেখব তুমি functional আর non-functional requirement এর পার্থক্যটা আসলেই ধরতে পারছ কিনা, নাকি এখনো "feature list" আর "requirement" গুলিয়ে ফেলছ। এটা খুবই common একটা junior-level ভুল, আর এটা ধরিয়ে দেওয়াটাই আজকের exercise এর আসল উদ্দেশ্য।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: —
Current: 1.1 — System Design আসলে কী, কেন শিখবো, Engineer রা কীভাবে চিন্তা করে
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned: System Design, Scale/Scaling, Trade-off, Functional Requirement,
Non-functional Requirement
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো]
Next: 1.2 — The Design Framework (requirements → estimation → high-level design → deep dive → trade-off)
=======================
```

---

## ৮. পরের Lesson

Exercise টা করে পাঠাও, আমি দেখব functional আর non-functional requirement ঠিকমতো আলাদা করতে পারছ কিনা। রেডি হলে `next` লিখো — Lesson 1.2 এ যাব, যেখানে একটা **Design Framework** শিখব: যেকোনো system design প্রশ্নে requirements → estimation → high-level design → deep dive → trade-off — এই কাঠামো ধরে কীভাবে এগোতে হয়। বাকি পুরো course এই কাঠামোর উপরেই দাঁড়াবে।
