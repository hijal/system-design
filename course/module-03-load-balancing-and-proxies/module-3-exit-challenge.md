# Module 3 — Exit Challenge

**Module 3 — Load Balancing & Proxies**

Module 3 এর ৪টা lesson শেষ — Load Balancer এর মূল ধারণা, algorithm, proxy এর ধরন, Nginx hands-on, আর health check/failover/graceful shutdown। এই Exit Challenge এ এই সবগুলো concept **একটা realistic, high-pressure scenario তে** একসাথে প্রয়োগ করতে হবে।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** TaskFlow টিম আগামী সপ্তাহে একটা বড় marketing campaign launch করছে — expected traffic normal দিনের **৫-৬ গুণ**। ঠিক একই সপ্তাহে, backend এ একটা **critical bug fix** ও deploy করতে হবে (একটা security-related fix, তাই দেরি করা যাবে না)। এই মুহূর্তে TaskFlow এর architecture:
>
> - ৪টা identical Express server instance, Nginx reverse proxy এর পেছনে (Lesson 3.3 এর মতোই)
> - বেশিরভাগ endpoint stateless, কিন্তু একটা পুরনো "Bulk Export" feature এখনও local server memory তে একটা temporary progress-tracking state রাখে (technical debt, এখনও ঠিক করা হয়নি)
> - Task creation endpoint এ Idempotency Key ব্যবহৃত হয় (Lesson 2.5 এর সেই in-memory implementation, এখনও Redis এ migrate করা হয়নি)

তোমার কাজ — নিচের প্রতিটা প্রশ্নে Module 3 (এবং প্রাসঙ্গিক জায়গায় Module 2) এর concept প্রয়োগ করে সিদ্ধান্ত নাও, reasoning সহ:

**১. LB Algorithm (Lesson 3.2)**
৫-৬ গুণ বেশি traffic এ, TaskFlow এর mixed workload (কিছু endpoint দ্রুত, "Bulk Export" ধীর) এর জন্য কোন LB algorithm প্রস্তাব করবে?

**২. Health Check Strategy (Lesson 3.4)**
এত গুরুত্বপূর্ণ একটা সপ্তাহে, শুধু default passive health check (`max_fails=1`, `fail_timeout=10s`) যথেষ্ট মনে হয়, নাকি active health check (NGINX Plus বা third-party module) এ invest করা উচিত? Cost বনাম risk এর reasoning দাও।

**৩. Deployment Strategy (Lesson 3.4 — Graceful Shutdown)**
High-traffic এই সপ্তাহে, security fix টা deploy করতে হবে ৪টা server জুড়ে। Graceful Shutdown ব্যবহার করে কীভাবে এটা করবে, যাতে কোনো live user affected না হয়? ধাপে ধাপে বলো (একবারে সব ৪টা server restart করা কেন ঝুঁকিপূর্ণ হবে সেটাও ভাবো)।

**৪. Idempotency + Failover এর সংযোগ (Lesson 2.5 + 3.4)**
High traffic এ, backend instance গুলোর মধ্যে সাময়িক error/restart হওয়ার সম্ভাবনা বেড়ে যায়, তাই Task Creation (POST) endpoint এ `proxy_next_upstream` (failover) enable রাখাটা এই সপ্তাহে বিশেষভাবে গুরুত্বপূর্ণ হতে পারে। কিন্তু বর্তমান Idempotency Key implementation (in-memory) এই ক্ষেত্রে কী সমস্যা তৈরি করবে? এই সপ্তাহের আগে ঠিক কী change করা জরুরি?

**৫. Legacy Stateful Feature (Lesson 3.2 + 1.6)**
"Bulk Export" feature এর জন্য এখনও sticky session (workaround) দরকার। ৫-৬ গুণ বেশি traffic এ, IP Hash ব্যবহার করা কতটা ঝুঁকিপূর্ণ হতে পারে (Lesson 3.4 এর "shared IP" সমস্যা মনে করে)? Cookie-based sticky session কি এখানে ভালো বিকল্প, নাকি এই সপ্তাহের আগেই এটা stateless বানানো উচিত?

**৬. L4 নাকি L7 (Lesson 3.1)**
Marketing campaign এর সাথে সাথে, TaskFlow একটা নতুন static landing page (`taskflow.app/campaign`) ও launch করছে, যেটা মূল Express API থেকে সম্পূর্ণ আলাদা একটা static file server এ hosted। Nginx কীভাবে এই routing করবে?

**মনে রাখার কথা:** প্রতিটা উত্তরে "কী ছাড় দিচ্ছি" বলার habit টা এখন ভালো হয়ে গেছে — আজকে বিশেষভাবে খেয়াল রাখো যেন প্রতিটা সিদ্ধান্তের **root cause** পর্যন্ত পৌঁছাও (গত exercise এর #২ এর মতো — "POST বিপজ্জনক" না বলে "কেন বিপজ্জনক, ঠিক কোন root cause এর জন্য" পর্যন্ত যাওয়া)।

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে তুমি এগুলো পারার কথা

- [ ] Load Balancer এর মূল ভূমিকা এবং কেন horizontal scaling এর জন্য অপরিহার্য — বুঝি
- [ ] L4 vs L7 এর পার্থক্য এবং কখন কোনটা প্রয়োজন (raw performance vs content-aware routing) সঠিকভাবে বলতে পারি
- [ ] Round Robin, Weighted Round Robin, Least Connections — এই algorithm গুলোর মধ্যে traffic pattern দেখে সঠিক পছন্দ করতে পারি
- [ ] Forward Proxy vs Reverse Proxy এর পার্থক্য, এবং Load Balancer আসলে একটা বিশেষ Reverse Proxy — এই সম্পর্ক বুঝি
- [ ] Nginx দিয়ে একটা কাজ-করা reverse proxy + load balancer বাস্তবে বানাতে পেরেছি (Lesson 3.3 hands-on)
- [ ] Passive vs Active health check এর পার্থক্য, এবং stock Nginx এ কী default আচরণ (`max_fails`/`fail_timeout`) — জানি
- [ ] Failover কীভাবে কাজ করে, এবং এটা কখন (GET) নিরাপদ, কখন (POST, non-shared idempotency store) ঝুঁকিপূর্ণ — বুঝি এবং **কেন** সেটাও বুঝি
- [ ] Sticky Session এর সীমাবদ্ধতা (IP-based এর shared-IP সমস্যা) এবং এটা কেন একটা workaround, ideal সমাধান না — বলতে পারি
- [ ] Graceful Shutdown এর তিনটা ধাপ এবং কেন এটা planned maintenance এ কাজ করে কিন্তু unexpected crash এ করে না — ব্যাখ্যা করতে পারি

---

## ৩. Recommendation

**পড়ার জন্য:**

- Google SRE Book এর "Load Balancing" chapter (sre.google/sre-book এ ফ্রি) — এখানে Google নিজে কীভাবে বিশাল scale এ load balancing চিন্তা করে সেটা দেখতে পাবে, আজকের L4/L7 concept গুলোই real-world scale এ কেমন দেখতে লাগে

**দেখার জন্য:**

- Nginx এর official "High Availability" guide — active health check, failover, এবং graceful reload নিয়ে practical configuration pattern

**Project এর জন্য:**

- তোমার Lesson 3.3 এর Docker setup এ ফিরে গিয়ে (course এর বাইরে, নিজের সময়ে) — `max_fails`/`fail_timeout` নিয়ে experiment করে দেখো, আর `proxy_next_upstream` যোগ করে GET endpoint এ failover test করো। এরপর তুমি আগে deploy করেছ এমন কোনো multi-instance setup থাকলে, সেখানে graceful shutdown (SIGTERM handling) implement করা আছে কিনা check করে দেখা একটা ভালো practical exercise হতে পারে

---

Exit challenge টা করে পাঠাও। রেডি হলে `next` লিখলে আমরা **Module 4: Caching** এ যাব — Lesson 4.1 দিয়ে শুরু, cache hierarchy (browser → CDN → app → DB) থেকে।
