# Module 11 — Exit Challenge (Real System Design Case Studies)

**Module 11 — Real System Design Case Studies**

Module 11 এর সাতটা case study শেষ: URL shortener (11.1), rate limiter service (11.2), chat (11.3), news feed (11.4), notification (11.5), video streaming (11.6), আর payment (11.7)। প্রতিটায় একটা system, শূন্য থেকে, Lesson 1.2 এর পাঁচ ধাপে, আর প্রতিটায় script আগে থেকে বলে দিয়েছে কোন সংখ্যা দেখতে হবে। বাস্তবে আর interview এ কেউ বলে দেয় না। আর বাস্তবের system গুলো এই সাতটার কোনো একটা না, সাতটার টুকরো দিয়ে বানানো। এই challenge এ একটা নতুন system, যেটা এই module এর প্রায় প্রতিটা case study এর একটা টুকরো চায়, কিন্তু কোনটা কোথায়, সেটা আপনাকে খুঁজে বের করতে হবে। এবার কোনো script নেই, কোনো সংখ্যা আগে থেকে হিসাব করা নেই।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** একটা ticketing platform। শনিবার সকাল ১০:০০ টায় একটা জনপ্রিয় শিল্পীর concert এর ticket বিক্রি শুরু হবে। কিছু তথ্য:
>
> - **Venue:** ৫০,০০০ seat, ৪০টা section এ। সামনের ৫টা section (৫,০০০ seat) সবচেয়ে দামি আর সবচেয়ে চাওয়া। Seat নির্দিষ্ট (A-12, row 3), আর customer map থেকে নিজে বাছতে পারে, অথবা "সবচেয়ে ভালো খালি seat দিন" চাইতে পারে।
> - **চাহিদা:** marketing এর আন্দাজে ২০ লাখ মানুষ ১০:০০ টায় উপস্থিত থাকবে, তাদের অনেকে কয়েকটা tab আর device খুলে। আগের একটা ছোট sale এর data: শুরুর প্রথম মিনিটে প্রতি মানুষ গড়ে ৩০টা request (page refresh, seat map, retry)। Bot এর অনুপাত অজানা, আগের sale এ "অনেক"।
> - **নিয়ম:** একজন সর্বোচ্চ ৬টা ticket। একটা seat বাছার পরে সেটা ৮ মিনিটের জন্য ধরে রাখা (hold), এর মধ্যে payment না হলে seat আবার খালি। Payment card এ, একটা PSP দিয়ে (11.7)। সফল হলে email এ ticket আর app এ একটা QR code, যেটা concert এর দিন gate এ scan হবে, ৮০টা gate, venue এ mobile network দুর্বল।
> - **এখনকার system:** একটা monolith, একটা Postgres, `seats(id, section, row, number, status, held_by, held_until, order_id)` table। Seat বাছার API: `SELECT … WHERE status = 'available'`, তারপর `UPDATE seats SET status = 'held' …`। Seat map এর page প্রতি request এ DB থেকে ৫০,০০০ seat এর অবস্থা পড়ে। Ticket এর id একটা auto-increment সংখ্যা, QR তে `https://tix.example/t/<id>`। Notification একটা FIFO queue, একটা email provider account।
> - **গত বছরের ছোট sale (১০,০০০ seat) এর postmortem এর সারাংশ:** ১০:০০:৩০ এ site বন্ধ, ৪০ মিনিট। ফেরার পরে ১১৪টা seat দুজনের কাছে বিক্রি। ৩০০+ মানুষের টাকা কাটা কিন্তু ticket নেই, এক সপ্তাহ ধরে support এ। ticket confirmation এর email গুলো ২ ঘণ্টা দেরিতে, আর তার মধ্যে login এর OTP আটকে ছিল। Gate এ ৩০ মিনিটের লাইন, কারণ scanner প্রতিটা QR server এ যাচাই করত। Resale site এ "জাল ticket" যেগুলো আসল id এর পাশের সংখ্যা।
>
> Product এর লক্ষ্য: (১) sale টা চালু থাকবে, যারা ঢুকতে পারছে না তারা অন্তত জানবে তারা কোথায় আছে; (২) একটা seat কখনো দুজনের না; (৩) কারো টাকা কাটা হবে না ticket ছাড়া; (৪) ন্যায্যতা: যে ১০:০০ টায় এসেছে আর যে ১০:০১ এ, তাদের মধ্যে ১০:০০ এর মানুষ একটা bot এর পেছনে পড়বে না; (৫) concert এর দিন gate এ লাইন ২০ মিনিটের কম।

আপনার কাজ: নিচের প্রতিটা প্রশ্নে Module 11 (আর প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নিন, reasoning সহ। প্রতিটা জায়গায় **নিজে সংখ্যা হিসাব করুন**, আর সেই সংখ্যা থেকে সিদ্ধান্ত বের করুন, উল্টোটা না।

**১. Requirement আর estimation (Lesson 1.2 + 1.3 + 11.1)**
Interviewer এর কাছে আপনি প্রথম পাঁচ মিনিটে কী কী প্রশ্ন করবেন (অন্তত ছয়টা), আর উত্তর না পেলে কী ধরে নেবেন? তারপর হিসাব: ১০:০০ এর প্রথম মিনিটে কোনো waiting room ছাড়া সেকেন্ডে কতগুলো request? Seat এর **লেখা** (hold, payment, confirm) পুরো sale এ সর্বোচ্চ কতগুলো হতে পারে, আর সেটা কত সময়ে? দুটো সংখ্যা পাশাপাশি রেখে বলুন: এই system এর আসল সীমা কোথায় — পড়ায়, লেখায়, না কোনো একটা নির্দিষ্ট জায়গায় (11.1 এর "কোন যন্ত্র লাগবে না" এর মতো করে একটা তালিকা দিন: sharding, Kafka, multi-region — লাগবে কি?)।

**২. Waiting room (Lesson 11.2 + 11.3 + 10.5 + 4.5)**
(ক) ২০ লাখ মানুষকে seat বাছার জায়গায় কোন হারে ঢোকাবেন? সেই হার কোন সংখ্যা থেকে আসে (checkout এর ক্ষমতা, ৮ মিনিটের hold, PSP এর সীমা)? 11.2 এর কোন যন্ত্র এখানে বসে, আর সীমাটা কি প্রতি user, না পুরো sale এর?
(খ) ন্যায্যতা: ১০:০০:০০ এর আগে যারা এসেছে, তাদের ক্রম কীভাবে ঠিক করবেন — আসার ক্রম (FIFO), না এলোমেলো? প্রতিটার পক্ষে একটা যুক্তি আর একটা আক্রমণ (যেমন কেউ ১০০টা tab খুলল)। একজন মানুষ, কয়েকটা device: তার জায়গা কী?
(গ) Waiting room এর page নিজেই ২০ লাখ মানুষের: কোন অংশ CDN থেকে (4.5, 11.6), কোন অংশ dynamic, আর আপনার জায়গা ("আপনার সামনে ৩২,০০০ জন") কত ঘন ঘন আপডেট হবে — poll, SSE না WebSocket (2.4, 11.3)? সংখ্যা দিয়ে বলুন আপনার পছন্দের চাপ।
(ঘ) Waiting room এর service ১০:০০:২০ এ মরে গেল। Fail open (সবাই ঢুকে পড়ে) না fail closed (কেউ না)? 11.2 এর degraded mode এখানে কী? আর সবাই একসাথে refresh করলে 11.3 এর কোন ঘটনা, আর তার প্রতিকার কী?
(ঙ) Bot: কোন স্তরে কী থামাবেন (10.5) — শুধু waiting room এর দরজায়, না প্রতিটা ধাপে? একটা bot সফলভাবে ঢুকলে তার পরের ধাপে কী সীমা তাকে থামায় (৬টা ticket এর নিয়ম কোথায় প্রয়োগ হয়, আর কী ধরে — account, card, ঠিকানা)?

**৩. Seat এর hold — একটা seat কখনো দুজনের না (Lesson 5.5 + 11.7 + 11.2 + 6.1)**
(ক) এখনকার `SELECT` তারপর `UPDATE` কেন ১১৪টা seat দুবার বিক্রি করেছিল? 5.5 আর 11.2 এর ভাষায় নাম দিন, আর এমন একটা লেখার নিয়ম দিন যা দুজন একই মুহূর্তে চাইলেও শুধু একজনকে দেয় (একটা SQL statement লিখুন)।
(খ) Hold এর মেয়াদ: ৮ মিনিট পরে কে seat খালি করে — একটা background job, না পড়ার সময় `held_until < now()` দেখা? প্রতিটার একটা ব্যর্থতা বলুন। আর ঘড়ির প্রশ্ন (6.1, 6.4): কোন ঘড়ি দিয়ে মেয়াদ মাপবেন?
(গ) গরম জায়গা: সামনের ৫,০০০ seat এ প্রথম মিনিটে কত জন একসাথে? "সবচেয়ে ভালো খালি seat দিন" যদি সবাইকে একই সারির প্রথম seat টা দেখায়, কী হবে (11.2 এর hot key, 11.7 এর গরম account)? Seat বরাদ্দ কে এমনভাবে নকশা করুন যাতে লড়াই কম হয় — কোন ধারণা কাজে লাগে (এলোমেলো শুরু, section ধরে ভাগ, lease)?
(ঘ) একটা অপরিবর্তনীয় নিয়ম লিখুন, 11.7 এর Σ = 0 এর মতো, যা প্রতি মুহূর্তে সত্য হতে হবে (available + held + sold = ?), আর বলুন কোথায় আর কত ঘন ঘন এটা যাচাই করবেন।

**৪. Hold আর payment এর সংঘাত (Lesson 11.7 + 9.3 + 7.4)**
একজন customer ৭ মিনিট ৫০ সেকেন্ডে "pay" চাপল। PSP এর উত্তর timeout, payment `unknown` (11.7)। ১০ সেকেন্ড পরে hold এর মেয়াদ শেষ, আর seat টা আরেকজন hold করল। দুই মিনিট পরে webhook এলো: প্রথমজনের টাকা কাটা হয়েছে।
(ক) এখন কী করবেন, আর কী কখনো করবেন না? এই অবস্থাটাই যাতে না হয়, তার জন্য hold আর payment এর মধ্যে কোন নিয়ম লাগে (unknown অবস্থায় hold এর কী হয়)? এটা 9.3 এর কোন ধারণা?
(খ) পুরো checkout কে একটা saga হিসেবে লিখুন: ধাপ, প্রতিটার উল্টো কাজ, আর কোন ধাপের পরে উল্টো কাজ আর সম্ভব না (pivot)। Idempotency key কোথায় কোথায় (client → আপনি, আপনি → PSP)?
(গ) গত বছরের "৩০০+ মানুষের টাকা কাটা কিন্তু ticket নেই" — 11.7 এর কোন তিনটা যন্ত্র একসাথে এটা শূন্যে আনে? আর sale এর দিন reconciliation কখন চালাবেন — দিনশেষে, না প্রতি ১৫ মিনিটে? কেন?

**৫. Seat map — ২০ লাখ মানুষ, প্রতিটা seat এর অবস্থা (Lesson 11.4 + 11.6 + 4.6 + 11.3)**
এখনকার page প্রতি request এ ৫০,০০০ seat পড়ে। (ক) যারা seat বাছার ধাপে আছে (ধরুন একসাথে ২০,০০০ জন), তাদের map কত ঘন ঘন আর কতটা নির্ভুল হতে হবে? একটা seat যেটা map এ খালি দেখাচ্ছে কিন্তু আসলে hold, সেটা ক্ষতি না বিরক্তি? (খ) তিনটা পথ তুলনা করুন: প্রতিটা বদল push (11.4 এর fan-out on write, ২০,০০০ জনকে), প্রতি কয়েক সেকেন্ডে পুরো map এর একটা snapshot CDN এ খুব ছোট TTL এ (11.6), আর section ধরে সংক্ষেপ ("Section C: ১২টা খালি") — প্রতিটার চাপ সংখ্যায়। (গ) Snapshot এর পথে 4.6 এর কোন সমস্যা আসে, আর তার প্রতিকার?

**৬. Ticket আর gate (Lesson 11.1 + 10.5 + 11.3)**
(ক) Auto-increment id আর resale এর "জাল ticket" এর সম্পর্ক কী? 11.1 এর কোন term? Ticket এর id কীভাবে বানাবেন, আর কেন শুধু id অনুমান-অযোগ্য করা যথেষ্ট না (একজন একটা আসল ticket এর screenshot দশজনকে বিক্রি করল)?
(খ) Gate এ দুর্বল network, ৮০টা gate, ৫০,০০০ মানুষ দুই ঘণ্টায়: সেকেন্ডে কতজন? প্রতিটা scan server এ যাচাই করলে কী হয় (গত বছরের ৩০ মিনিটের লাইন)? Offline এ যাচাই করার একটা নকশা দিন (10.5 এর signature, gate এর device এ কী আগে থেকে থাকে)। আর একই ticket দুটো gate এ একসাথে scan হলে offline এ কীভাবে ধরবেন — কোন trade-off মেনে নিচ্ছেন?

**৭. Notification (Lesson 11.5)**
৫০,০০০ confirmation email (ticket সহ), waiting room এর ২০ লাখ মানুষের "আপনার পালা এসেছে" (push বা email), checkout এ OTP, আর sale শেষে "sold out, waitlist এ যোগ দিন" ১৯ লাখ জনকে। (ক) এগুলোর প্রতিটা কোন স্তরে, কোন channel এ, কোন সময়সীমায়? (খ) গত বছর OTP কেন আটকেছিল — 11.5 এর কোন সংখ্যার মতো? Provider এর সীমা ধরুন সেকেন্ডে ৫০০ email: "sold out" এর ১৯ লাখ email কতক্ষণে যায়, আর সেই সময় OTP কোথায় থাকে? (গ) "আপনার পালা এসেছে" যদি দেরিতে পৌঁছায়, customer তার ৮ মিনিটের একটা অংশ হারায় — এই notification এর নকশায় এটা কীভাবে সামলাবেন (hold এর ঘড়ি কখন শুরু হয়)?

**৮. যা ইচ্ছা করে বানাবেন না, আর খরচ (Lesson 11.1 + 11.6 + 10.7)**
এই sale বছরে কয়েকবার, প্রতিবার কয়েক ঘণ্টা। Capacity কি autoscale এ, না আগে থেকে (11.6 এর প্রশ্ন ৩, 11.5 এর প্রশ্ন ৩ এর মতো)? প্রথম প্রশ্নের তালিকা থেকে কোন তিনটা জিনিস আপনি **বানাবেন না**, আর কোন সংখ্যা সেটা বলে দেয়? আর কোন একটা জিনিসে বেশি খরচ করবেন যা প্রথমে "অতিরিক্ত" মনে হয়?

**৯. ব্যর্থতার তিনটা ছবি**
এই sale প্রকাশ্যে ব্যর্থ হতে পারে এমন তিনটা আলাদা উপায় লিখুন (একটা capacity এর, একটা সঠিকতার, একটা ন্যায্যতার), প্রতিটার জন্য: কীভাবে আগে টের পাবেন (কোন metric, কোন alert — 10.4), আর sale এর মাঝখানে কী করবেন (কোন সুইচ আগে থেকে তৈরি থাকতে হবে — 10.3 এর brownout, 10.6 এর flag)। আর sale এর আগের সপ্তাহে একটা game day (10.3): কী পরীক্ষা করবেন, কীভাবে ২০ লাখ মানুষের চাপ নকল করবেন?

**১০. ৪৫ মিনিটের interview**
এই পুরো নকশা একটা interview এ, ৪৫ মিনিটে। Lesson 1.2 এর পাঁচ ধাপে সময় ভাগ করুন (মিনিট ধরে)। কোন দুটো জায়গায় deep dive করবেন, আর কেন সেই দুটো? কোন জিনিস গুলো শুধু এক লাইনে বলে এগিয়ে যাবেন? আর interviewer যদি মাঝখানে বলেন "ধরুন এখন এটা ১০টা দেশে, একসাথে" — কোন সিদ্ধান্ত বদলায় আর কোনটা না (10.8)?

**মনে রাখার কথা:** এই module এর সাতটা case study এর প্রতিটায় একই অভ্যাস কাজ করেছে, আর এই challenge এ চারটা জায়গায় সবচেয়ে সহজে ভুল হয়। (ক) **গড় দিয়ে নকশা।** ২০ লাখ মানুষ "সারাদিনে" না, প্রথম মিনিটে; আর তাদের চাওয়া সমান না, সামনের ৫টা section এ (11.4 এর power law, 11.1 এর Zipf)। (খ) **বাইরের system কে নিজের transaction এর অংশ ভাবা।** PSP, email provider, gate এর network — প্রত্যেকে timeout দেয়, আর timeout মানে "জানি না" (11.5, 11.7)। (গ) **ন্যায্যতা আর সঠিকতাকে capacity এর সমস্যা ভাবা।** বেশি server দুবার বিক্রি থামায় না, bot থামায় না, ক্রম ঠিক করে না; এগুলো নকশার নিয়ম, ক্ষমতা না। (ঘ) **একবারের ঘটনার জন্য সারা বছরের system।** কয়েক ঘণ্টার sale এর জন্য চিরকালের multi-region না; কিন্তু সেই কয়েক ঘণ্টার জন্য আগে থেকে তৈরি capacity, সুইচ আর অনুশীলন। আর এই module এর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস: প্রতিটা যন্ত্রের আগে জিজ্ঞেস করুন, **"কোন সংখ্যা বলছে এটা লাগবে?"**

আমি এটা প্রতিটা প্রশ্ন ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে আপনি এগুলো পারার কথা

- [ ] একটা অস্পষ্ট প্রশ্ন থেকে Lesson 1.2 এর পাঁচ ধাপে একটা নকশা দাঁড় করাতে পারি, প্রথম পাঁচ মিনিটে সঠিক প্রশ্ন সহ, আর প্রতিটা সংখ্যা থেকে একটা সিদ্ধান্ত বের করতে পারি
- [ ] Estimation দিয়ে বলতে পারি কোন যন্ত্র **লাগে না** (লেখার জন্য sharding, "code নেওয়া কিনা" এর Bloom filter, প্রতি link এ HLL, payment এ throughput এর চিন্তা)
- [ ] Short code এর চার পথ (random, hash, counter, গোপন permutation) এর দাম বলতে পারি: birthday bound, enumeration, retry, range allocation; আর 301 বনাম 302 কেন link এর নিয়ন্ত্রণের প্রশ্ন
- [ ] Rate limit আর quota আলাদা করতে পারি; কেন্দ্রে গোনার চার পথ (atomic, সীমা / N, token lease, async sync) চারটা অবস্থায় মাপতে পারি; hot tenant আর limiter এর নিজের ব্যর্থতা (timeout, breaker, উদার fallback) সামলাতে পারি
- [ ] লাখ লাখ WebSocket এর জন্য gateway আর session registry নকশা করতে পারি; reconnect storm আর congestion collapse কে jitter আর ছড়ানো দিয়ে থামাতে পারি; store-then-push, client_msg_id আর conversation প্রতি seq দিয়ে delivery আর ক্রম নিশ্চিত করতে পারি
- [ ] Fan-out on write আর read এর খরচ power law ধরে হিসাব করতে পারি, hybrid এর আসল লাভ (spike, গড় না) বলতে পারি; fan-out queue কে ভাগ করতে পারি; tail amplification আর hedged request বুঝি; চলমান feed এ cursor কেন
- [ ] বাইরের provider এর সীমার চারপাশে notification নকশা করতে পারি: অগ্রাধিকারের স্তর, pacing এর headroom, retry আর idempotency key, failover এর duplicate, aggregation, quiet hours, মরা token, আর channel এর খরচ
- [ ] একটা video platform এর খরচের আকৃতি (egress বনাম transcode) বলতে পারি; টুকরো করে transcoding, ABR এর trade-off, জনপ্রিয়তা অনুযায়ী encode, আর কোন জিনিস immutable আর কোনটা ছোট TTL
- [ ] Payment কে state machine হিসেবে নকশা করতে পারি (`unknown` সহ), intent আগে লিখতে পারি, double-entry ledger আর Σ = 0 এর মূল্য বুঝি, টাকা integer এ রাখি, আর reconciliation এর key আর জানালা বাছতে পারি
- [ ] যেকোনো system এ এই module এর চারটা ফাঁদ চিনতে পারি: গড় দিয়ে নকশা, বাইরের system এর timeout কে ব্যর্থতা ধরা, সঠিকতা আর ন্যায্যতাকে capacity এর সমস্যা ভাবা, আর এক জায়গায় বড় আর ছোট কাজ মেশানো

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Alex Xu — _System Design Interview_ (খণ্ড ১ আর ২)।** এই module এর প্রায় প্রতিটা case study (URL shortener, rate limiter, chat, news feed, notification, YouTube, payment) এর interview এর রূপ, ছবি সহ। এই module পড়ার পরে সেগুলো পড়লে দেখবেন কোথায় তারা সংক্ষেপ করেছে আর কোথায় আপনার সংখ্যা বেশি বলে। খণ্ড ২ এর "payment system" আর "ad click aggregation" অধ্যায় 11.7 আর 11.1 এর analytics এর পরের ধাপ।
- **Martin Kleppmann — _Designing Data-Intensive Applications_।** পুরো course এর পটভূমি; এই module এর জন্য বিশেষ করে অধ্যায় ১১ (stream processing, 11.1 আর 11.4 এর event pipeline) আর অধ্যায় ১২ (correctness, end-to-end idempotency — 11.7 এর গভীর রূপ)।
- **Stripe এর engineering blog এর "Designing robust and predictable APIs with idempotency"।** 11.7 এর idempotency key এর আসল উৎসের একটা, ছোট আর সরাসরি।
- **Google এর "The Tail at Scale" (Dean & Barroso, 2013)।** 11.4 এর tail amplification আর hedged request এর মূল লেখা, চার পাতা।
- **Facebook এর "TAO" আর Twitter এর timeline নিয়ে প্রকাশিত আলোচনা, Discord এর "How Discord Stores Billions of Messages" আর তার পরের ScyllaDB এর লেখা, Netflix এর tech blog এর encoding আর Open Connect এর লেখা।** 11.3, 11.4 আর 11.6 এর বাস্তব রূপ, প্রতিটায় এমন সংখ্যা আর ভুল যা কোনো বইয়ে নেই। কোম্পানির নিজের লেখা, তাই তাদের দৃষ্টিভঙ্গি থেকে — সেটা মাথায় রেখে পড়ুন।

**দেখার আর পড়ার মতো ঘটনা:**

- **২০২২ এর একটা বড় concert এর ticket এর বিক্রির ব্যর্থতা নিয়ে প্রকাশিত বিবরণ আর আলোচনা** (চাহিদা প্রত্যাশার কয়েক গুণ, bot, waiting room)। এই challenge এর প্রায় প্রতিটা প্রশ্ন সেখানে বাস্তবে ঘটেছে। কোম্পানির নিজের বিবৃতি আর স্বাধীন বিশ্লেষণ দুটোই পড়ুন, আর দেখুন কোথায় তারা আলাদা।
- **যেকোনো payment provider এর প্রকাশিত incident report** (অনেকে status page এ পুরো postmortem দেয়)। প্রতিটায় খুঁজুন: timeout এর সময় "unknown" কীভাবে সামলানো হয়েছে, আর reconciliation কতক্ষণ পরে কী ধরেছে।

**Project এর জন্য:**

- **এই challenge কে একটা ছোট আসল system বানান:** একটা Express + Postgres এর ticket service — seat এর hold একটা conditional `UPDATE` দিয়ে, মেয়াদ সহ; একটা waiting room (Redis এ একটা token bucket আর queue এর জায়গা); একটা fake PSP 11.7 এর মতো; আর k6 বা নিজের একটা TypeScript load generator দিয়ে ১০:০০ এর ঢেউ। মাপুন: কতগুলো seat দুবার (শূন্য হতে হবে), কতজনের টাকা ticket ছাড়া (শূন্য), আর waiting room না থাকলে কী হয়।
- **একটা "অপরিবর্তনীয় নিয়মের" checker:** একটা script যা প্রতি মিনিটে চলে আর প্রশ্ন ৩(ঘ) এর নিয়ম আর 11.7 এর Σ = 0 যাচাই করে, ভাঙলে alert দেয়। তারপর ইচ্ছা করে একটা race ঢোকান (hold এ `SELECT` তারপর `UPDATE`) আর দেখুন কত সেকেন্ডে checker ধরে।
- **নিজের একটা case study:** এই module এর ছকে (requirement, script দিয়ে estimation, deep dive, আসল একটা ছোট service, trade-off table) একটা নতুন system — যেমন ride-hailing এর driver matching, বা Google Docs এর মতো একসাথে লেখা — নিজে লিখুন। কোন case study এর কোন টুকরো লাগল, আর কোনটা একদম নতুন?

---

Exit challenge টা করে পাঠান। রেডি হলে `next` লিখলে আমরা **Module 12: Interview Mastery & Capstone** এ যাব, শুরু Lesson 12.1 দিয়ে: **Interview framework recap আর সবচেয়ে common ১০টা ভুল।**

Module 11 এ প্রতিটা system একটা script নিয়ে এসেছিল যা বলে দিত কোন সংখ্যা দেখতে হবে। Module 12 এ সেই সাহায্য থাকবে না: সংখ্যা মাথায়, সময় ঘড়িতে, আর সামনে একজন interviewer যে মাঝপথে প্রশ্ন বদলায়। 12.1 এ Lesson 1.2 এর কাঠামো আবার, এবার এই এগারো module এর অভিজ্ঞতা দিয়ে, আর interview এ মানুষ সবচেয়ে বেশি যে দশটা ভুল করে — যার কয়েকটা এই module এর case study গুলোতেই আপনি দেখেছেন (গড় দিয়ে নকশা, যন্ত্রের নাম আগে সংখ্যা পরে, trade-off না বলা)। তারপর estimation এর drill, দুটো mock interview, আর শেষে TaskFlow এর পুরো design doc, Capstone হিসেবে।
