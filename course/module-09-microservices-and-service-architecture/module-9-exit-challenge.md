# Module 9 - Exit Challenge (Microservices & Service Architecture)

**Module 9 - Microservices & Service Architecture**

Module 9 এর পাঁচটা lesson শেষ - কখন ভাঙবেন আর কখন ভাঙবেন না, ভাঙা service গুলোর সামনে কী বসে (gateway, BFF), সীমানা পার হওয়া transaction (saga, 2PC), একটা call এর চারপাশের তিনটা যন্ত্র (discovery, breaker, bulkhead), আর কে কতটা চাইতে পারে (rate limiting)। প্রতিটা lesson এ একটা করে প্রশ্ন আলাদা করে মেপেছি। বাস্তবে একটা "microservices migration" এর ছয় মাসে সব একসাথে আসে - আর Module 5–8 এর পুরনো প্রশ্নগুলো (dual write, replica lag, idempotency, eventual consistency) নতুন চেহারায় ফিরে আসে, কারণ service এর সীমানা পার হলে সেগুলো সহজ হয় না, কঠিন হয়। এই Exit Challenge এমন একটা ছয় মাস।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** আপনার অনুপস্থিতিতে (আপনি তিন মাস অন্য একটা project এ ছিলেন) TaskFlow এ একটা "microservices migration" হয়ে গেছে। এখন আপনি ফিরে এসেছেন, আর আপনাকে ছয় মাসের incident review করতে বলা হয়েছে। এই মুহূর্তে এর অবস্থা (কিছু সিদ্ধান্ত এই module এর lesson মেনে, অনেকগুলো না):
>
> - **ভাঙা হয়েছে ১১টা service এ**, স্তর ধরে: `api-gateway`, `web-api`, `mobile-api`, `task-read`, `task-write`, `comment`, `user`, `billing`, `notification`, `search`, `file`। প্রতিটার নিজের repo, নিজের deploy pipeline।
> - **Database:** `task-read`, `task-write` আর `comment` একই Postgres এর একই schema ব্যবহার করে ("যাতে join করা যায়")। `billing`, `user` আর `search` এর নিজের database। `notification` আর `file` এর কোনো database নেই।
> - **Browser:** SvelteKit এর page গুলো সরাসরি ৭টা service ডাকে (`task-read`, `comment`, `user`, `file`, `search`, `billing`, `notification`) - gateway এর মধ্য দিয়ে, কিন্তু কোনো BFF নেই। Board এর page load এ ২৩টা request।
> - **Gateway:** JWT যাচাই করে, তারপর পেছনের service এ `X-User-Id` আর `X-Workspace-Id` header বসিয়ে দেয়। Service গুলো ওই header বিশ্বাস করে। Service এর port গুলো VPC এর ভেতরে, কিন্তু কোনো network policy নেই।
> - **ঠিকানা:** প্রতিটা service এর config এ বাকিদের ঠিকানার একটা তালিকা (`BILLING_URLS=10.0.3.11:8080,10.0.3.12:8080,10.0.3.13:8080`)। Health endpoint সবার আছে: `app.get('/health', (_, res) => res.status(200).send('ok'))`।
> - **Call এর নিয়ম:** সব internal call এ timeout ৩০ s ("যাতে ধীর হলেও কাজ শেষ হয়")। ব্যর্থ হলে সাথে সাথে ৩ বার retry, backoff ছাড়া। কোনো circuit breaker নেই। প্রতিটা service এ একটাই HTTP connection pool (maxSockets ৫০) আর একটাই Postgres pool (১০)।
> - **"Task তৈরি":** `task-write` একটা distributed transaction চালায় - Postgres এর `PREPARE TRANSACTION` দিয়ে `task-write` এর database আর `billing` এর database জুড়ে 2PC। Coordinator হলো `task-write` এর ওই process টা, log টা তার নিজের local disk এ।
> - **"Plan upgrade":** একটা saga - `billing` এ Stripe charge → `user` এ plan বদলানো → `notification` এ email। ধাপ গুলোর কোনো compensation লেখা নেই ("ব্যর্থ হলে আমরা alert পাই, হাতে ঠিক করি")। Saga এর অবস্থা কোথাও লেখা হয় না; orchestrator টা একটা HTTP request handler।
> - **Rate limit:** প্রতিটা service এ `express-rate-limit`, default (in-memory) store, `1000 per hour`, key = `req.ip`। প্রতিটা service এর ৮টা instance চলে। App গুলো LB এর পেছনে, `trust proxy` সেট করা নেই।
> - **Cache আর limiter:** একটাই Redis, `maxmemory 4gb`, `maxmemory-policy allkeys-lru`। ওখানে আছে: task list এর cache, session, আর (নতুন করে যোগ করা) rate limiter এর গোনা।
> - **প্রস্তাব:** একজন senior engineer বলছেন, "আমাদের একটা service mesh লাগবে, তাহলে সব সমস্যা মিটে যাবে।"
>
> **ছয় মাসের ঘটনাগুলো:**
>
> 1. **Deploy এর গতি।** Migration এর আগে দিনে ৪ বার deploy হতো। এখন সপ্তাহে ২ বার - কারণ প্রায় প্রতিটা feature এ ৩–৫টা service একসাথে বদলাতে হয়, আর সেগুলো একটা নির্দিষ্ট ক্রমে deploy করতে হয়। একটা ছোট feature ("task এ due date") ১১ দিন লেগেছে, ৪টা service, ৩টা team।
> 2. **Board এর p99।** Migration এর আগে ৮০ ms। এখন desktop এ ৯৪০ ms, mobile এ ৪.২ s। Backend এর প্রতিটা service এর নিজের p99 ১৫ ms এর নিচে - কেউ ধীর না।
> 3. **২১ তারিখ, সকাল ১০:০৫।** `billing` এর database এ একটা index হারিয়ে গিয়েছিল; তার p99 ২ s এ উঠল। ১০:০৬ এ `task-write` এর সব instance এর connection pool ভরে গেল। ১০:০৭ এ board খোলা বন্ধ (`task-read` ও থেমে গেছে)। ১০:০৯ এ login বন্ধ। ১০:১১ এ পুরো site ডাউন। Postmortem এ দেখা গেল `billing` কখনো সম্পূর্ণ মরেনি - শুধু ধীর ছিল।
> 4. **একটা machine প্রতিস্থাপন।** Cloud provider `10.0.3.12` কে প্রতিস্থাপন করল, নতুন IP `10.0.3.47`। পরের ৯ দিন "task তৈরি" এর ৩৩% ব্যর্থ। Alert ছিল, কিন্তু সেটা "billing 5xx rate" দেখত - আর এগুলো 5xx না, connection refused।
> 5. **একটা খারাপ deploy।** `billing` এর একটা deploy এ database এর credential ভুল গেল। ৮টা instance ই উঠল, `/health` ২০০ দিল, LB সবগুলোকে rotation এ রাখল, আর প্রতিটা আসল call এ 500। ৪০ মিনিট ধরে সব "task তৈরি" ব্যর্থ।
> 6. **In-doubt transaction।** ৩ তারিখে `task-write` এর একটা instance PREPARE এর পরে OOM এ মরল। ২টা workspace এ পরের ৬ ঘণ্টা কোনো task তৈরি করা গেল না, আর `billing` এর database এ `VACUUM` আটকে থাকল। যে machine এ coordinator চলছিল সেটা autoscaling এ চলে গেছে - log টা তার সাথেই গেছে।
> 7. **টাকা নিল, কিছু দিল না।** ৪১ জন customer এর card এ charge হয়েছে কিন্তু plan বদলায়নি। কারণ দুই রকম: (ক) `user` service ধীর ছিল, saga এর দ্বিতীয় ধাপ timeout করেছে; (খ) কয়েকজনের ক্ষেত্রে `user` এ plan বদলেছে কিন্তু Stripe এ charge **দুবার** হয়েছে (retry এর কারণে)। Finance এর হিসাবে ১৮ জনের double charge।
> 8. **Rate limit এর দুই মুখ।** (ক) একটা integration একটা API key থেকে সেকেন্ডে ৯০০ request পাঠাচ্ছিল তিন দিন ধরে, কেউ থামায়নি। (খ) অথচ একটা enterprise customer এর office (৮০০ জন, একটা NAT) বলল "সকাল ৯টায় আমাদের সবার 429" - আর তাদের support ticket এ engineer লিখেছিল "আপনাদের দিক থেকে সমস্যা"।
> 9. **২৮ তারিখ, রাত।** Redis এর memory ৪ GB ছুঁলো (একটা বড় export এর cache)। তার পরের ঘণ্টায় rate limit কার্যত উঠে গেল - একটা scraper ৪ লাখ request পাঠাল, কেউ 429 পেল না। কেউ বুঝতেই পারল না কী হয়েছে, কারণ Redis এর dashboard এ সব সবুজ।
> 10. **নিজেদের পায়ে কুড়াল।** একটা reconcile script (রাতের) ৫০,০০০ workspace এর quota মিলাতে `billing` এ সেকেন্ডে ২,০০০ call পাঠাল। `billing` পড়ে গেল, আর তার সাথে (ঘটনা ৩ এর মতোই) আরও তিনটা service।
> 11. **একজন researcher এর report।** একটা authenticated user নিজের browser থেকে `X-User-Id` header বদলে অন্য user এর task পড়তে পেরেছে - gateway এর মধ্য দিয়ে না, সরাসরি service এর port এ (সে VPN এ ছিল, একটা ভুল configure করা VPC peering এর কারণে)।
> 12. **Manager এর প্রশ্ন:** "আমরা microservices এ গেলাম দ্রুত চলার জন্য। এখন ধীর, বেশি outage, আর তিনজন বেশি engineer লাগছে। কী ভুল হলো - আর service mesh কি এটা ঠিক করবে?"

আপনার কাজ - নিচের প্রতিটা প্রশ্নে Module 9 (আর প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নিন, reasoning সহ। যেখানে সম্ভব, **সংখ্যা** দিয়ে বলুন।

**১. ভাঙার সীমানা (Lesson 9.1)**
এই ১১টা service এর ভাগটা কোন নীতিতে করা হয়েছে, আর সমস্যাটা কী? `task-read` আর `task-write` আলাদা service হওয়া কেন একটা ভুল সীমানা - আর তারা একই schema ভাগ করা কোন নীতি ভাঙছে? ঘটনা ১ এর ১১ দিনের feature কে 9.1 এর কোন শব্দটা বর্ণনা করে, আর সেই রোগের আর কোন কোন লক্ষণ এই scenario তে আছে (অন্তত তিনটা)। আপনি ১১টাকে কতটাতে নামাবেন - নাম ধরে তালিকা দিন, প্রতিটার সীমানার যুক্তি সহ, আর বলুন কোনগুলো আবার এক deployment এ ফেরত যাবে।

**২. Board এর p99 (Lesson 9.2 + 1.3)**
প্রতিটা service এর p99 ১৫ ms এর নিচে, অথচ board এর p99 ৯৪০ ms (mobile এ ৪.২ s) - এই ফাঁকটা কোথা থেকে আসে, নাম ধরে বলুন। ২৩টা request এর জন্য mobile এ (RTT ১০০ ms ধরুন) শুধু round trip এ কত সময়, আর browser এর সমসাময়িক connection এর সীমা ধরলে কত ধাপ? একটা BFF দিয়ে design করুন: web আর mobile এর জন্য আলাদা কেন, board এর page এ কতগুলো request এ নামবে, আর BFF নিজে ভেতরে কী করবে (ক্রম, সমসাময়িকতা, আংশিক ব্যর্থতায় কী ফেরাবে)।

**৩. ১০:০৫ থেকে ১০:১১ (Lesson 9.4 + 7.1 + 5.6)**
ছয় মিনিটের cascading failure টা সময়ের রেখায় লিখুন - `billing` ধীর হওয়া থেকে login বন্ধ হওয়া পর্যন্ত, প্রতিটা ধাপে কোন সম্পদ শেষ হলো। চারটা সিদ্ধান্ত এই cascade কে সম্ভব করেছে (timeout, retry, breaker, pool) - প্রতিটার জন্য সঠিক মান বা নিয়ম দিন, সংখ্যা সহ। বিশেষ করে: timeout ৩০ s এর জায়গায় কত, আর সেই সংখ্যাটা আপনি **কোন মাপ** থেকে পাবেন? `task-read` কেন থেমেছিল যদিও সে `billing` কে ডাকেই না - এটা আটকাতে ঠিক কী লাগত?

**৪. Health endpoint আর ঠিকানা (Lesson 9.4 + 3.4)**
ঘটনা ৪ আর ৫ দুটো আলাদা সমস্যা - আলাদা করে বলুন, আর প্রতিটার জন্য কী লাগত। `/health` এ `res.status(200).send('ok')` কোন প্রশ্নের উত্তর দেয় আর কোনটার না (3.4 এর কোন দুটো শব্দ)? Billing এর জন্য একটা সঠিক health endpoint লিখুন (কী যাচাই করবে, কী **করবে না**, timeout কত)। আর ঘটনা ৪ এর ৯ দিন: registry বা platform এর discovery থাকলে কতক্ষণে সারত, আর alert টা কী দেখলে ধরা পড়ত?

**৫. 2PC আর in-doubt (Lesson 9.3 + 5.5 + 5.3)**
ঘটনা ৬ ব্যাখ্যা করুন: PREPARE এর পরে coordinator মরলে ঠিক কী অবস্থায় জিনিসগুলো আটকে থাকে, আর কেন ওই ২টা workspace এ **অন্য কেউ** task বানাতে পারল না। `VACUUM` কেন আটকাল, আর সেটা দিনের পর দিন চললে কী হতো? Coordinator এর log তার নিজের disk এ রাখা কেন একটা মৌলিক ভুল - কোথায় রাখা উচিত ছিল? আর সবচেয়ে বড় প্রশ্ন: এখানে 2PC ব্যবহার করাই কি ঠিক ছিল? আপনার বিকল্প design দিন, আর বলুন কোন সংখ্যাটা দেখে আপনি 2PC বাদ দিতে বলবেন।

**৬. ৪১ জন, আর ১৮টা double charge (Lesson 9.3 + 7.4 + 2.5)**
ঘটনা ৭ এর দুটো কারণ আলাদা করে ব্যাখ্যা করুন। এই saga টা আবার design করুন: ধাপ গুলোর **ক্রম** (কেন এই ক্রম), কোনটা **pivot**, প্রতিটার compensation (বা "শুধু retry"), saga এর state কোথায় আর কোন transaction এ লেখা হবে, আর recovery job কী করবে। Double charge আটকাতে ঠিক কী লাগে - Stripe এর কোন সুবিধা, আর তার key টা কী হবে? "ব্যর্থ হলে alert পাই, হাতে ঠিক করি" - এই নীতিটা কোন আকারের ব্যর্থতায় চলে আর কোথায় চলে না?

**৭. Rate limit এর তিনটা ভুল (Lesson 9.5 + 4.3)**
ঘটনা ৮ আর ৯ এ **অন্তত চারটা** আলাদা ভুল আছে - প্রতিটা আলাদা করে বলুন, প্রতিটার লক্ষণ, আর প্রতিটার সমাধান। বিশেষ করে: (ক) ৮টা instance আর in-memory store মিলে "1000 per hour" আসলে কত? Autoscaling এ সংখ্যাটা কীভাবে বদলায়? (খ) `req.ip` আর `trust proxy` না থাকা মিলে কী হয়েছে, আর ঘটনা ৮(খ) এর ৮০০ জনের সমস্যা এর সাথে একই না আলাদা? (গ) ঘটনা ৯ এ rate limit "উঠে গেল" কীভাবে - Lesson 4.3 এর কোন সিদ্ধান্তের কারণে, আর প্রতিকার কী? (ঘ) Fixed window `1000/hour` এ একজন client সবচেয়ে বেশি কত পাঠাতে পারে, কত সময়ে - আর আপনি কোন algorithm আর কোন দুটো সংখ্যা দিয়ে এটা বদলাবেন?

**৮. পরিচয় আর সীমানা (Lesson 9.2 + 10.5 এর পূর্বাভাস)**
ঘটনা ১১ এর আক্রমণটা ধাপে ধাপে লিখুন। "Gateway JWT যাচাই করে, তারপর header বসায়" - এই design এর অনুমানটা কী, আর সেটা কখন ভাঙে? অন্তত **তিনটা** স্তরে প্রতিরক্ষা দিন (network, token, service এর নিজের যাচাই), আর প্রতিটা একা কেন যথেষ্ট না। Service mesh (mTLS) এই সমস্যার কোন অংশটা সারায় আর কোনটা না?

**৯. নিজেদের batch job (Lesson 9.5 + 9.4 + 7.4)**
ঘটনা ১০ এ reconcile script টা কী ভুল করেছে, আর কেন এটা ঘটনা ৩ এর চেয়ে বেশি লজ্জার? Script টার জন্য একটা নিয়ম দিন - কোন algorithm দিয়ে গতি বাঁধবেন (আর কেন সেটা, token bucket না), কত হার, আর সেই হারটা আপনি কোথা থেকে ঠিক করবেন। এর বাইরে আরও দুটো রক্ষাকবচ দিন যাতে ভবিষ্যতে কোনো internal script কোনো service ফেলতে না পারে।

**১০. Manager এর প্রশ্ন, আর অগ্রাধিকার (Lesson 9.1–9.5)**
(ক) ঘটনা ১২ এর উত্তর - এক প্যারায়, দোষারোপ ছাড়া: microservices কোন সমস্যার সমাধান, TaskFlow এর আসল সমস্যাটা কি সেটা ছিল, আর "ধীর + বেশি outage + বেশি engineer" এর কারণ কোন সিদ্ধান্তগুলো। Service mesh কী ঠিক করবে (নির্দিষ্ট করে বলুন) আর কী করবে না - আর এই মুহূর্তে সেটা কি অগ্রাধিকার?
(খ) একটা **অগ্রাধিকার তালিকা**: এই সপ্তাহে কী (আবার ঘটার আগে), এই মাসে কী, এই quarter এ কী - প্রতিটার পাশে কোন lesson, কোন ঘটনা এটা আটকাত, আর সাফল্য কীভাবে মাপবেন (কোন metric, কোন সংখ্যা)।
(গ) ছয় মাস পরে TaskFlow এর architecture কেমন দেখতে চান - কতগুলো service, কোন সীমানায়, সামনে কী, আর প্রতিটা service এর চারপাশে কোন যন্ত্রগুলো বাধ্যতামূলক (একটা checklist যা নতুন service বানানোর সময় মানতে হবে)।

**মনে রাখার কথা:** এই module এর চারটা জায়গায় সবচেয়ে সহজে ভুল হয় - (ক) **স্তর ধরে ভাঙা** (`task-read`/`task-write`) আর **ব্যবসার সীমানা ধরে ভাঙা** গুলিয়ে ফেলা; প্রথমটা distributed monolith বানায়, যেখানে microservices এর সব দাম আছে আর কোনো সুবিধা নেই; (খ) **network call কে function call এর মতো লেখা** - timeout, breaker, bulkhead ছাড়া, যেন ওপাশে কেউ সবসময় আছে; (গ) **"বেঁচে আছি" কে "কাজ করছি" ভাবা** - health endpoint, heartbeat, registry - তিনটাই liveness বলে, readiness না; (ঘ) **নিজের process এর স্মৃতিতে ভাগ করা অবস্থা রাখা** - rate limiter এর গোনা, saga এর state, breaker এর গোনা, 2PC এর log - প্রতিটাই একটা instance এর সাথে মরে যায়, আর instance সংখ্যার সাথে ভুলটা বড় হয়। আজকের scenario তে চারটাই আছে, কয়েকবার করে। আর Module 9 এর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস: প্রতিটা service এর সীমানার জন্য জিজ্ঞেস করুন - **"এই call টা ব্যর্থ হলে, ধীর হলে, বা দুবার হলে কী হয় - আর সেটা কে সামলাচ্ছে?"**

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check - এই Module শেষে আপনি এগুলো পারার কথা

- [ ] Monolith ভাঙার তিনটা দাম (function call → network call, ছড়ানো ব্যর্থতা, হারানো transaction) সংখ্যা দিয়ে বলতে পারি
- [ ] Microservices কোন সমস্যার সমাধান (অনেক team, আলাদা deploy, আলাদা scale) আর কোনটার না ("app ধীর") - Conway's Law দিয়ে ব্যাখ্যা করতে পারি
- [ ] Bounded context ধরে সীমানা আঁকতে পারি, আর distributed monolith এর লক্ষণ চিনতে পারি; modular monolith আর strangler fig কখন বাছব জানি
- [ ] Database per service কেন শর্ত, আর দুটো service একই schema ভাগ করলে ঠিক কী হারায়
- [ ] Request waterfall আর over-fetching চিনতে পারি; একটা BFF design করতে পারি (web বনাম mobile আলাদা কেন) আর round trip এর হিসাব করতে পারি
- [ ] API gateway এর দায়িত্ব কী আর কী না; token কোথায় যাচাই হয়, আর gateway এর পেছনে পরিচয় নিরাপদে কীভাবে যায় (এবং header বিশ্বাস করার বিপদ)
- [ ] Synchronous call বনাম event - কোন কথাটা কোন পথে যাবে, একটা নিয়ম দিয়ে ঠিক করতে পারি
- [ ] 2PC কীভাবে কাজ করে, in-doubt transaction কী, আর কেন এটা blocking - আর service গুলোর মাঝে কেন প্রায় কেউ ব্যবহার করে না
- [ ] Saga design করতে পারি: ধাপের ক্রম, compensation, pivot, saga এর log আর recovery, প্রতিটা ধাপ idempotent; orchestration বনাম choreography বাছতে পারি
- [ ] Saga তে isolation না থাকার দাম আর semantic lock দিয়ে তার প্রশমন বুঝি
- [ ] Service discovery কেন লাগে, registry + heartbeat/TTL কীভাবে কাজ করে, আর TTL এর জানালাটা কেন শূন্য করা যায় না; client-side বনাম server-side discovery
- [ ] Heartbeat/health endpoint liveness বলে readiness না - এর ফল কী, আর সঠিক readiness probe কেমন হয়
- [ ] Circuit breaker এর তিনটা অবস্থা, threshold আর মেয়াদের trade-off, half-open কেন ঠিক একটা probe - আর breaker প্রথমত কাকে বাঁচায়
- [ ] Bulkhead দিয়ে ক্ষতির সীমানা আঁকতে পারি, আর এর দাম (সুস্থ পথ বাঁচে, অসুস্থ পথ আরও ধীর) সংখ্যা দিয়ে বলতে পারি
- [ ] পাঁচটা rate limiting algorithm এর পার্থক্য জানি - fixed window এর ২ গুণ, sliding log এর memory, sliding counter এর approximation, token বনাম leaky এর আকার
- [ ] আসল সীমা = লেখা সীমা × instance সংখ্যা - কেন, আর ভাগ করা store এর তিনটা দাম (extra call, atomicity, নতুন নির্ভরতা)
- [ ] 429 এর সঠিক contract (`Retry-After`, `X-RateLimit-*`), কোন key ধরে সীমা, আর limiter মরলে fail open বনাম fail closed - endpoint ভেদে

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Sam Newman - _Building Microservices_ (2nd edition)।** এই module এর প্রায় প্রতিটা সিদ্ধান্তের সবচেয়ে ভালো একক উৎস - বিশেষ করে সীমানা আঁকা, strangler fig, আর "কখন ভাঙবেন না" এর অধ্যায়গুলো। তার ছোট বই **_Monolith to Microservices_** আরও সরাসরি: কীভাবে ধাপে ধাপে বের করা যায়, আর database ভাঙার প্যাটার্নগুলো।
- **Chris Richardson - _Microservices Patterns_ আর তার `microservices.io` এর pattern গুলো।** Saga, transactional outbox, API composition, database per service, circuit breaker - 9.3 এর প্রায় পুরো কাঠামো এখান থেকে। Pattern গুলোর সাথে তাদের **দাম** ও লেখা আছে, সেটাই এর মূল্য।
- **Michael Nygard - _Release It!_ (2nd edition)।** Circuit breaker, bulkhead, timeout, "stability patterns" আর "antipatterns" - 9.4 এর আসল উৎস, আর বইটা পুরোটাই production এ ভাঙার গল্প দিয়ে ভরা। যদি এই তালিকার একটা বই পড়েন, এটা পড়ুন।
- **Google SRE Book - "Handling Overload" আর "Addressing Cascading Failures" অধ্যায় দুটো।** বিনামূল্যে পড়া যায়। 9.4 এর cascade আর 9.5 এর load shedding/rate limiting এর সবচেয়ে বাস্তব আলোচনা, Google এর নিজের সংখ্যা সহ - বিশেষ করে "কেন retry ক্ষতি বাড়ায়" আর "adaptive throttling"।
- **Cloudflare এর blog - "How we built rate limiting capable of scaling to millions of domains"।** 9.5 এর sliding window counter কেন আর কীভাবে, আর তার approximation টা তারা কীভাবে মেনে নিয়েছে - আমাদের মাপা ১.৯x এর বাস্তব প্রেক্ষাপট।
- **Martin Kleppmann - _Designing Data-Intensive Applications_, chapter 9 এর "Distributed Transactions and Consensus" অংশ।** 2PC এর সমস্যাগুলোর সবচেয়ে পরিষ্কার ব্যাখ্যা, XA এর বাস্তব দুর্বলতা সহ - 9.3 এর ১.২–১.৩ এর গভীর রূপ।

**দেখার জন্য:**

- **Sam Newman এর conference talk গুলো** ("Confusion In The Land Of The Serverless", "Don't Start With A Monolith" এবং তার উল্টো যুক্তির talk গুলো) - একই মানুষ দুই দিকের যুক্তি দিচ্ছেন, যেটা এই বিষয়ে সবচেয়ে দরকারি অভ্যাস।
- **"Mastering Chaos - A Netflix Guide to Microservices" (Josh Evans)।** Netflix এর নিজের ভুল থেকে শেখা - service এর সীমানা, ব্যর্থতার cascade, আর কেন তারা fallback আর bulkhead এ এত বিনিয়োগ করেছে। পুরনো talk, কিন্তু যুক্তিগুলো পুরনো হয়নি।
- **Kubernetes এর documentation এর "Configure Liveness, Readiness and Startup Probes" আর Service/Endpoints এর অংশ** - 9.4 এর discovery আর readiness এর বাস্তব রূপ, আর graceful shutdown এর ক্রম (`preStop`, `terminationGracePeriodSeconds`)।

**Project এর জন্য:**

- **একটা service বের করুন, পুরো যন্ত্রপাতি সহ:** আপনার নিজের কোনো monolith (বা TaskFlow এর মতো একটা খেলনা) থেকে একটাই bounded context বের করুন - strangler fig দিয়ে, পুরনো path টা কিছুদিন রেখে। তারপর ওই একটা call এর চারপাশে সব বসান: timeout, breaker (library দিয়ে), bulkhead, discovery (Kubernetes বা Consul), আর rate limit। তারপর **ভাঙুন**: service কে ধীর করুন, মেরে ফেলুন, 500 দিন - আর প্রতিটাতে মেপে দেখুন caller এর p99 আর ব্যর্থতার হার কী হয়। এই module এর প্রতিটা সংখ্যা আপনি নিজের হাতে আবার পাবেন।
- **একটা saga, recovery সহ:** দুটো service, দুটো database, একটা তিন-ধাপের saga (pivot সহ) - orchestrator এর `sagas` table, প্রতিটা ধাপ idempotent (idempotency key ধরে), আর একটা recovery job যা আটকে থাকা saga খুঁজে এগিয়ে নেয় বা compensate করে। তারপর orchestrator কে প্রতিটা ধাপের মাঝে মেরে দেখুন (৫টা আলাদা জায়গায়) - প্রতিবার recovery কী করে? Compensation কে ইচ্ছে করে ব্যর্থ করান, আর দেখুন DLQ আর alert এ কী যায়।
- **নিজের distributed rate limiter:** Redis + একটা Lua script দিয়ে token bucket (দুটো field, সময়-নির্ভর হিসাব, সব এক ধাপে)। তিনটা Express instance এর সামনে বসান, আর যাচাই করুন আসল সীমা ঠিক সীমার সমান (instance সংখ্যার গুণ না)। তারপর Redis বন্ধ করে দেখুন - আপনার fail open / fail closed এর সিদ্ধান্ত কেমন কাজ করে; আর দুটো instance থেকে একসাথে চাপ দিয়ে race আছে কিনা মেপে দেখুন (Lua ছাড়া একবার, Lua দিয়ে একবার)।

---

Exit challenge টা করে পাঠান। রেডি হলে `next` লিখলে আমরা **Module 10: Reliability, Security & Operations** এ যাব - Lesson 10.1 দিয়ে শুরু: **Consistent Hashing deep dive**, যেটা Lesson 3.2 এ শুধু পরিচয় করানো হয়েছিল আর 5.8 এ shard এর প্রসঙ্গে ছুঁয়ে যাওয়া হয়েছিল।

Module 9 জুড়ে TaskFlow ভেঙেছে, আর প্রতিটা ভাঙার সাথে একটা নতুন যন্ত্র যোগ হয়েছে - gateway, BFF, saga, registry, breaker, bulkhead, rate limiter। প্রতিটাই কাজ করে, আর প্রতিটার নিজের tuning আছে। কিন্তু একটা প্রশ্ন পুরো module জুড়ে আমরা এড়িয়ে গেছি: **এই সবকিছু যখন চলছে, আপনি কীভাবে জানবেন কী ঘটছে?** ঘটনা ৪ এ ৯ দিন লেগেছিল কারণ alert ভুল জিনিস দেখছিল; ঘটনা ৯ এ কেউ বুঝতেই পারেনি rate limit উঠে গেছে, কারণ Redis এর dashboard সবুজ ছিল; ঘটনা ৩ এর postmortem এ ছয় মিনিটের ক্রমটা বের করতে কয়েক দিন লেগেছে। Module 10 এর প্রশ্ন: hash ring, bloom filter, observability, security, deployment, cost আর multi-region - অর্থাৎ system টা শুধু কাজ করা না, **চালানো** যায় কি না।
