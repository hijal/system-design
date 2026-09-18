# Module 1 — Exit Challenge

**Module 1 — Foundations of Scalability and System Design Principles**

Module 1 এর ৬টা lesson শেষ। এতদিন আমরা টুকরো টুকরো concept শিখেছি — trade-off thinking, 5-step framework, estimation, connection lifecycle, latency/availability, scaling। এই Exit Challenge এ এই সবগুলো টুকরো **একসাথে, একটা সম্পূর্ণ mini-design** এ প্রয়োগ করতে হবে — ঠিক যেভাবে ইন্টারভিউতে বা বাস্তব কাজে করতে হবে, আলাদা আলাদা lesson হিসেবে ভাগ করা ছাড়াই।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow এর client একদিন এসে বলল —
>
> "আমরা একটা নতুন feature চাই: **'Daily Digest'** — প্রতিদিন সকাল ৮টায়, প্রতিটা ইউজারকে একটা ইমেইল পাঠানো হবে, যেখানে গতকালের সব task activity (কী কী task তৈরি হলো, কোনগুলো complete হলো, কোনগুলোতে তাকে assign করা হলো) এর সারাংশ থাকবে।"
>
> ধরে নাও, TaskFlow এখন ৫০,০০০ registered user (Lesson 1.6 এর মতোই ধরে নিতে পারো, চাও তো নিজের মতো নতুন সংখ্যাও ধরতে পারো, শুধু বলে দিও)।

তোমার কাজ — সম্পূর্ণ **৫-ধাপ Framework** (Lesson 1.2) ব্যবহার করে এই feature টা design করো। প্রতিটা ধাপে যা যা এখন পর্যন্ত শিখেছ তা প্রয়োগ করার চেষ্টা করো:

**Step 1 — Requirements + Scope**

- Functional আর Non-functional requirement আলাদা করো (Lesson 1.1) — মনে রেখো, "কীভাবে পাঠাব" (email service, queue) সেটা Solution, Requirement না
- কী আজকের scope এর বাইরে রাখবে বলে দাও

**Step 2 — Estimation**

- DAU ধরে নাও (assumption বলে দিয়ে — Lesson 1.3)
- মোট কতগুলো email পাঠাতে হবে প্রতিদিন?
- এখানে একটা বিশেষ challenge আছে যা আগে আসেনি — এই কাজটা সারাদিন সমানভাবে ছড়ানো request না, বরং **সকাল ৮টায় একসাথে সব ইউজারকে পাঠাতে হয়**। এই ধরনের ট্রাফিক প্যাটার্নকে কী বলা যেতে পারে বলে তোমার মনে হয়, আর এটা কেন normal API traffic থেকে আলাদাভাবে চিন্তা করা দরকার — এক লাইনে বলো (এটা এখনো আমরা lesson এ formally covers করিনি — নিজের logic দিয়ে অনুমান করে দেখো, ভুল হলে সমস্যা নেই)

**Step 3 — High-Level Design**

- একটা simple ASCII diagram আঁকো (Client/Server/DB এর বাইরে এখানে email পাঠানোর জন্য নতুন কী component লাগতে পারে বলে মনে হয়, সেটা একটা "black box" হিসেবে দেখাও, বিস্তারিত না গিয়ে)

**Step 4 — Deep Dive**

- এই feature এর মধ্যে কোন অংশটা তোমার মনে হয় সবচেয়ে বেশি deep dive করার যোগ্য (সবচেয়ে বেশি challenge/trade-off আছে), আর কেন — Lesson 1.2 এর "কোন অংশ বেছে নেব" criteria ব্যবহার করে বিচার করো

**Step 5 — Trade-off**

- Login বা Task Creation এর তুলনায় এই "Daily Digest" feature এর জন্য কী availability/latency target হওয়া উচিত বলে তোমার মনে হয়, আর কেন (Lesson 1.5 এর reasoning প্রয়োগ করো — এটা কি সব ইউজারকে ব্লক করে? সময়ের ব্যাপারে কতটা strict হতে হবে?)

**একটা নির্দেশনা:** আগের exercise গুলোর trend দেখে বলছি — প্রতিটা ধাপ শেষ করার পর, একবার নিজের উত্তরটা আবার পড়ে দেখো প্রশ্ন যা চেয়েছে ঠিক তাই দিয়েছ কিনা, আর কোনো ধাপ বা sub-part বাদ পড়েনি তো। এটা একটা habit যেটা গত কয়েকটা lesson জুড়ে তোমার মূল improvement area ছিল।

আমি এটা critique করব ঠিক আগের মতোই — ধাপে ধাপে।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

নিজেকে সৎভাবে যাচাই করো:

- [ ] System Design প্রশ্নের উত্তর কেন "সঠিক" না বরং "trade-off-based" — এটা অন্য কাউকে বুঝিয়ে বলতে পারি
- [ ] Functional আর Non-functional Requirement এর মধ্যে পার্থক্য করতে পারি, এবং "Solution" কে এই দুটোর কোনোটার সাথে গুলিয়ে ফেলি না
- [ ] 5-step Design Framework টা মুখস্থ বলতে পারি, এবং প্রতিটা ধাপে কী থাকে/থাকে না সেটা জানি
- [ ] DAU থেকে শুরু করে QPS, storage, এবং peak load পর্যন্ত পুরো estimation chain টা assumption সহ করতে পারি
- [ ] TCP handshake, TLS handshake, আর keep-alive — এগুলো latency তে কীভাবে অবদান রাখে বুঝি
- [ ] p99 latency কেন average এর চেয়ে বেশি গুরুত্বপূর্ণ, এবং "নাইনস" (99.9%, 99.99%) মানে বাস্তবে কত downtime — হিসাব করতে পারি
- [ ] SLA, SLO, Error Budget এই তিনটার সম্পর্ক এবং engineering decision এ এর ব্যবহার বুঝি
- [ ] Vertical vs Horizontal scaling, এবং কেন Stateless architecture horizontal scaling এর পূর্বশর্ত — ব্যাখ্যা করতে পারি
- [ ] একটা architecture দেখে বলতে পারি সেটা stateful না stateless, আর কেন

যদি কোনো বক্সে সন্দেহ থাকে, চিন্তা নেই — এগুলো Module 2-3 তেও বারবার প্রয়োগ হবে, তখন আবার শক্ত হওয়ার সুযোগ পাবে। কিন্তু যদি ৩টার বেশি বক্সে সত্যিই আটকে থাকো মনে হয়, বলো — আমরা `recap` করে নিতে পারি নতুন module শুরুর আগে।

---

## ৩. Recommendation

**পড়ার জন্য:**

- _"Designing Data-Intensive Applications"_ by Martin Kleppmann — Chapter 1 ("Reliable, Scalable, and Maintainable Applications")। এই বইটা পুরো course জুড়ে বারবার reference আসবে, বিশেষ করে Module 5-6 এ। Chapter 1 ঠিক আজকের Reliability/Scalability concept গুলোই আরেকটু গভীরে নিয়ে যায়।

**দেখার জন্য:**

- Google-এর SRE (Site Reliability Engineering) বই এর ফ্রি অনলাইন version এর SLO/Error Budget সংক্রান্ত chapter — আজকের 1.5 lesson এর concept গুলো একদম industry-standard ভাষায় দেখতে পাবে (sre.google/sre-book এ ফ্রি পাওয়া যায়)

**Project এর জন্য:**

- নিজের সময়ে (course এর বাইরে) — তুমি আগে deploy করেছ এমন যেকোনো Node.js app নিয়ে একবার ভেবে দেখো: সেটা stateful নাকি stateless? PM2 cluster mode এ একাধিক instance চালালে session বা in-progress data কোথায় থাকত — process এর memory তে, নাকি বাইরে? এই audit টা করে দেখা একটা ভালো practical exercise, যদিও এটা course এর official exercise না।

---

Exit challenge টা করে পাঠাও — critique করব। এরপর `next` লিখলে আমরা **Module 2: Networking & Communication** এ যাব, শুরু হবে Lesson 2.1 — DNS কীভাবে কাজ করে, URL লেখা থেকে response আসা পর্যন্ত পুরো journey (যেটা আজকে 1.4 তে আমরা "DNS Lookup" বলে একটা ধাপ mention করেছিলাম মাত্র, না খুলেই — এবার সেটা পুরোপুরি খুলব)।
