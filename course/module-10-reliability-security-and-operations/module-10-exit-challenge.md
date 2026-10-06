# Module 10 — Exit Challenge (Reliability, Security & Operations)

**Module 10 — Reliability, Security & Operations**

Module 10 এর আটটা lesson শেষ। TaskFlow এর গায়ে আটটা স্তর বসেছে: cache এর ring (10.1), Bloom filter আর HyperLogLog (10.2), dependency matrix, brownout আর static stability (10.3), trace, histogram আর burn rate (10.4), AuthN/AuthZ, secret আর DDoS এর স্তর (10.5), graceful shutdown, canary আর expand/contract (10.6), unit cost আর anomaly (10.7), আর DR, cell আর data residency (10.8)। প্রতিটা lesson এ একটা প্রশ্ন আলাদা করে মেপেছি। বাস্তবে একটা খারাপ রাতে সব একসাথে আসে। আর আরেকটা জিনিস আসে যেটা কোনো lesson এ আলাদা করে মাপা হয়নি: **সময়।** ছয় মাসে প্রতিটা রক্ষাকবচের উপর ছোট ছোট সিদ্ধান্ত জমে। একটা test "flaky" বলে বন্ধ, একটা TTL "performance" এর জন্য তুলে দেওয়া, একটা game day "পরের মাসে"। কেউ কোনো রক্ষাকবচ ইচ্ছা করে ভাঙে না, প্রতিটা নিজের মতো করে ক্ষয়ে যায়। এই Exit Challenge এমন একটা রাত।

---

## ১. Mini Design Challenge (Tier 3)

> **Scenario:** 10.8 এর সিদ্ধান্তগুলো বসানোর ছয় মাস পরে। আপনি এই সপ্তাহে incident review এর দায়িত্বে, আর আপনার সামনে শুক্রবার রাত থেকে সোমবার পর্যন্ত একটা ঘটনার timeline। TaskFlow এর এখনকার অবস্থা (কিছু জিনিস এই module এর lesson মেনে, কিছু ছয় মাসে বদলে গেছে):
>
> - **Region:** সিঙ্গাপুর, তিনটা AZ। Postgres primary AZ-a তে, Patroni এর sync standby AZ-b তে, একটা read replica AZ-c তে। মুম্বাইয়ে একটা async replica (pilot light), আর মুম্বাইয়ের app stack IaC তে লেখা, বন্ধ। স্বাভাবিক মাসিক বিল ~$১৪,২০০।
> - **DR runbook:** প্রথম লাইন: "সিঙ্গাপুর region down হলে → মুম্বাইয়ে failover।" RPO ~৫ s আর RTO ~৪০ মিনিট লেখা। Game day ছয় মাস পরপর হওয়ার কথা। শেষটা হয়েছিল আট মাস আগে, আর তার failback এর অংশটা "সময়ের অভাবে" বাদ গিয়েছিল।
> - **EU cell:** ফ্রাঙ্কফুর্টে, তিন মাস ধরে চলছে, দুটো customer (জার্মান customer টা সহ, ৬,০০০ seat)। Global স্তর (workspace → cell এর routing, identity এর directory, billing) সিঙ্গাপুরে, আর প্রতিটা cell এ তার cache।
> - **Secret:** একটা secret manager, সিঙ্গাপুরে, তার endpoint AZ-a তে। মুম্বাইয়ের stack boot এর সময় সেখান থেকে secret আনে।
> - **Cache:** Redis Cluster এ যাওয়া "পরের quarter এ", গত দুই quarter ধরে। এখনও client-side ring, ১৬০ virtual node, membership registry তে। গত মাসে "ring এ ফেরার আগে `FLUSHALL`" এর ধাপটা বন্ধ করা হয়েছে, কারণ "প্রতিটা flap এ DB তে miss এর ঢেউ আসে।" আর একটা performance PR এ `members:{workspace:<id>}` key এর TTL তুলে দেওয়া হয়েছে। `loadBoardFor` এই key পড়েই membership দেখে। PR এর বর্ণনা: "membership কম বদলায়, আর বদলালে তো invalidate হয়ই।"
> - **Share link:** প্রতিটা instance এ Bloom filter, প্রতি ঘণ্টায় rebuild, outbox event দিয়ে যোগ, "গত ৫ মিনিটের" recent set cache ring এ। Edge এ cache key শুধু path। Bot score শুধু login আর sign-up এ।
> - **Board:** গত মাসে নতুন "AI summary" panel। BFF একটা বাইরের LLM API ডাকে, library এর default timeout ৩০ s, বাকি অংশগুলোর সাথে একই `Promise.all` এ। Brownout এর তিন ধাপের তালিকা 10.3 এর সময়ের, নতুন panel তাতে নেই। CI এর fault injection test দুই মাস ধরে `skip` করা, কারণ "flaky"।
> - **Deploy:** Canary ১% → ৫% → ২৫% → ১০০%। Gate SLI এ, প্রতি ধাপে ন্যূনতম ১০ মিনিট আর ন্যূনতম ২০,০০০ request, তবে মোট হিসেবে, segment ধরে না। সাথে একটা expand/contract চলছে, `tasks.priority` এর backfill (ধাপ ৩)। Backfill batch এ চলে, আর replica lag দেখে থামে, তবে শুধু AZ এর replica গুলোর lag।
> - **Observability:** OTel collector এর দুটো instance, দুটোই AZ-a তে ("cost কমাতে")। Board খোলা, task তৈরি আর login এ burn rate alert।
> - **Cost:** Autoscale এর সর্বোচ্চ সীমা ৪০। Cost anomaly ভাগ ধরে দৈনিক মাপা হয়, আর ticket যায় resource এর `team` tag এর team এর কাছে।
>
> **শুক্রবার থেকে সোমবার (সিঙ্গাপুরের সময়):**
>
> 1. **শুক্রবার ১৯:৪০।** AZ-a তে storage আর network এ গোলমাল: disk এর p99 মাঝে মাঝে ৪০০ ms, আর AZ-a থেকে বাকি দুই AZ এ ৩% packet loss। কিছুই "down" না। সব health check সবুজ, cloud provider এর status page সবুজ। ১৯:৪৬ এ board এর fast burn page বাজে: সফলতা ৯৭%, p99 ২.৮ s।
> 2. **১৯:৫০ – ২০:১৫।** Brownout controller ধাপ ৩ পর্যন্ত যায়, তবু board এর সফলতা নেমে ৮১%। LLM provider নিজে সুস্থ। On-call trace খুলে দেখে গত আধা ঘণ্টার trace প্রায় নেই।
> 3. **২০:০৫ – ২০:৪৫।** AZ-a এর `cache-4` ৪০ মিনিটে চারবার ring থেকে বাদ পড়ে আবার ফেরে।
> 4. **২০:১০ – ২০:৪২।** Incident call এ ৩২ মিনিটের তর্ক। Runbook বলে "region down হলে", কিন্তু region down না। একজন বলে "AZ-a থেকে সরে যাই", আরেকজন বলে "মুম্বাই"। ২০:৪২ এ সিদ্ধান্ত হয়: মুম্বাই।
> 5. **২০:৪২ – ২১:৪০।** ২০:৫১ এ মুম্বাইয়ের replica promote হয়। সেই মুহূর্তে তার lag ছিল **৯৪ সেকেন্ড**, কারণ ১৯:০০ থেকে চলা backfill এর WAL cross-region link এ জমে ছিল। মুম্বাইয়ের app stack ১৮ মিনিট crash loop এ থাকে: boot এর সময় secret manager থেকে secret আনতে timeout। একজন হাতে secret বসিয়ে চালু করে। ২১:১২ এ DNS বদলানো হয় (TTL ৬০ s)। মুম্বাইয়ের cache খালি, মুম্বাইয়ের DB এর CPU ১৫ মিনিট ১০০%। মাঝপথে কেউ মুম্বাইয়ের ring এ চারটা নতুন cache node একসাথে যোগ করে। ২১:৪০ এ board স্বাভাবিক।
> 6. **২১:১২ – ২১:২৪।** সিঙ্গাপুরের পুরনো primary মরেনি, শুধু ধীর ছিল। DNS এর লেজের traffic নিয়ে সিঙ্গাপুরের app instance গুলো (৫ মিনিট পরেও ৯% traffic) ১২ মিনিট সেখানেই লিখল। মোট **১,৮৭০টা লেখা**, যার কোনোটা মুম্বাইয়ে নেই। পুরনো primary কে কেউ বন্ধ করেনি, কারণ runbook ধরে নিয়েছিল "region তো মরা"।
> 7. **২১:৩০ – ০১:৩০।** Share page এ বন্যা: `/s/<এলোমেলো ২২ অক্ষর>`, সেকেন্ডে ৪৫,০০০ request, ৩০,০০০ IP থেকে। Edge এ প্রতিটা path আলাদা, তাই সব miss। মুম্বাইয়ের autoscale ৬ মিনিটে ৪০ এ পৌঁছায় আর চার ঘণ্টা সেখানেই থাকে। Bloom filter অনুপস্থিত slug এর ৯৯% এর বেশি DB এর আগেই ফেরায়, তাই DB বাঁচে। কিন্তু app এর CPU ভরা, আর বৈধ user দের board ধীর। একই সময়ে support এ অভিযোগ আসে: "নতুন share link 404।" দুই রকম: (ক) ২০:৫১ এর পরে মুম্বাইয়ে তৈরি link, ৫০ মিনিট ধরে, কারণ মুম্বাইয়ের IaC এ outbox relay worker ছিল না; (খ) ১৯:৪০ থেকে ২০:৫১ এর মধ্যে সিঙ্গাপুরে তৈরি কিছু link, যেগুলোর email ইতিমধ্যে চলে গেছে। এগুলো আর কখনো খোলে না।
> 8. **২২:১৫।** Incident এর আগে একটা deploy এর canary ২৫% এ ছিল। Failover এর পরে মুম্বাইয়ে SLI সবুজ দেখে gate নিজে এগোয়, আর ২২:৪০ এ ১০০%। নতুন version এ একটা bug: EU cell এ task তৈরি এর ৬% ব্যর্থ। ২৫% ধাপে EU থেকে এসেছিল ৩১০টা request (মোট ৪১,০০০ এর মধ্যে), তার ১২টা task তৈরি। জার্মান customer সোমবার escalate করে।
> 9. **শনিবার ০২:১০।** শুক্রবার ২০:৩০ এ একটা workspace এর admin একজন contractor কে workspace থেকে সরিয়েছিলেন। ০২:১০ এ সেই contractor একটা private board খুলে ২১২টা task export করে। Audit log এ export টা আছে। `loadBoardFor` membership পেয়েছিল cache থেকে।
> 10. **শনিবার সকাল।** Leadership জানতে চায়: "কতজন প্রভাবিত?" একজন analyst প্রতিটা workspace এর শুক্র আর শনিবারের দৈনিক HLL এর `PFCOUNT` আলাদা করে নিয়ে সব যোগ করেন: **৪১,৩০০**। Finance প্রস্তাব দেয়, এই সংখ্যা ধরে প্রতি প্রভাবিত seat এ credit। আরেকজন engineer log থেকে পান **১৯,৮০০**।
> 11. **শনিবার থেকে সোমবার।** Failback কখনো অনুশীলন হয়নি, তাই team সোমবারের অপেক্ষা করে। Incident এর সময় কেউ মুম্বাইয়ের scale-in বন্ধ করেছিল "যাতে instance না সরে", আর কেউ আবার চালু করেনি। সোমবার failback: সিঙ্গাপুরকে মুম্বাইয়ের replica বানাতে ১.৮ TB নতুন করে কপি।
> 12. **মাসের শেষে বিল $২৩,৯০০** (স্বাভাবিক ~$১৪,২০০)। বাড়তি $৯,৭০০ এর লাইন: মুম্বাইয়ের app, ৪০টা instance ~৬০ ঘণ্টা, **$৩,১০০**; মুম্বাইয়ের DB failover এর সময় বড় মাপে, তিন দিন, **$১,২৮০**; log ingestion **$২,৯৫০** (মুম্বাইয়ের IaC এ `LOG_LEVEL=debug`, আট মাস আগের game day থেকে); CDN request আর WAF **$৯৪০**; cross-region transfer (re-seed আর replication) **$৬০**; বাকি সব **$১,৩৭০**। Cost anomaly ticket শনিবার সকালেই খুলেছিল, `team: platform` এর নামে। সেই team চার মাস আগে ভেঙে দেওয়া হয়েছে।
> 13. **CEO এর প্রশ্ন:** "Module 10 এর প্রতিটা জিনিস আমরা বানিয়েছিলাম: DR, canary, Bloom filter, burn rate alert, cell, cost alert। তবু এমন একটা রাত। এগুলো কি কাজ করে না, নাকি আমরা ভুল জিনিস বানিয়েছি?"

আপনার কাজ: নিচের প্রতিটা প্রশ্নে Module 10 (আর প্রাসঙ্গিক জায়গায় আগের module) এর concept প্রয়োগ করে সিদ্ধান্ত নিন, reasoning সহ। যেখানে সম্ভব, **সংখ্যা** দিয়ে বলুন।

**১. Region না, AZ (Lesson 10.8 + 10.3 + 6.1)**
১৯:৪০ এ আসলে কী ভেঙেছিল: region, নাকি তার একটা failure domain? "ধীর কিন্তু মরা না, health check সবুজ" এই ধরনের ব্যর্থতাকে 6.1 আর 10.3 এর ভাষায় কী বলে, আর runbook কেন এটা ধরতে পারেনি? তিনটা পথ তুলনা করুন: (ক) অপেক্ষা; (খ) AZ-a ছেড়ে দেওয়া (Patroni দিয়ে primary AZ-b তে, AZ-a এর app instance আর cache node সরানো); (গ) মুম্বাই। প্রতিটার RPO (sync standby বনাম async মুম্বাই), RTO আর ঝুঁকি বলুন। আপনি কোনটা বাছতে, কোন সংকেত দেখে, আর কত মিনিটের মধ্যে? তারপর runbook এর প্রথম পাতাটা আবার লিখুন: কোন সংকেতে কোন সিদ্ধান্ত, কে নেবে, আর কতক্ষণ পরে "তর্ক থামান, সিদ্ধান্ত নিন"।

**২. AI panel আর brownout (Lesson 10.3 + 10.7)**
LLM provider সুস্থ থাকা সত্ত্বেও board এর সফলতা ৮১% এ নামল। পথটা লিখুন: কোন instance, কোন network পথ (10.7 এর একটা সিদ্ধান্ত এখানে লুকিয়ে আছে), কোন timeout, আর কোন `Promise.all`। Board journey এর dependency matrix এ panel টা আসলে কোন ঘরে বসেছে, আর কোন ঘরে বসার কথা ছিল? LLM provider এর SLA ৯৯.৫% ধরলে, panel টা hard হওয়ায় board এর availability এর ছাদ কতটা নামে (10.3 এর ৯৯.৩০১% এর হিসাবের মতো করে)? Brownout ধাপ ৩ পর্যন্ত গিয়েও কিছু বদলাল না কেন? এই হার তিনটা জিনিস মিলে সম্ভব হয়েছে: panel, brownout এর পুরনো তালিকা, আর skip করা test। প্রতিটার জন্য এমন একটা নিয়ম দিন যা কোনো মানুষের মনে রাখার উপর নির্ভর করে না।

**৩. ৯৪ সেকেন্ড আর ১,৮৭০টা লেখা (Lesson 10.8 + 10.6 + 6.1 + 5.7)**
(ক) Runbook এ RPO "~৫ s", আসলে ৯৪ s। Backfill, WAL আর cross-region link মিলিয়ে ব্যাখ্যা করুন কেন। RPO যদি একটা ধ্রুবক না হয়, তাহলে সেটা কী? কোন metric এ দেখবেন, কোন alert এ? Backfill এর lag check এ কোন কোন replica থাকা উচিত ছিল?
(খ) ২১:১২ থেকে ২১:২৪ এর split brain: দুটো primary হলো কেন, আর runbook এর কোন অনুমান এটা সম্ভব করেছে? Failover মানুষের হাতে হলেও কোন যন্ত্রগুলো লাগে, আর তাদের ক্রম কী (আগে promote, না আগে fence)? 10.8 এর witness এখানে কী বদলাত?
(গ) এখন দুটো আলাদা ভাগ: ১,৮৭০টা লেখা সিঙ্গাপুরে আছে, মুম্বাইয়ে নেই; আর শেষ ৯৪ সেকেন্ডের লেখা সিঙ্গাপুরে আছে, মুম্বাইয়ে নেই। Failback এর সময় এগুলো নিয়ে কী করবেন? কোনগুলো স্বয়ংক্রিয়ভাবে মেলানো যায় আর কোনগুলোতে মানুষ লাগে (task এর edit, share link, plan এর payment)? আর customer কে কী বলবেন?

**৪. Backup এর গায়ে মূলের ছায়া (Lesson 10.3 + 10.5 + 10.8)**
মুম্বাইয়ের stack ১৮ মিনিট crash loop এ ছিল, কারণ secret manager সিঙ্গাপুরে। এটা 10.3 এর কোন নীতির লঙ্ঘন? মুম্বাইয়ের stack এর এমন সব dependency এর তালিকা বানান যেগুলো সিঙ্গাপুরে থাকতে পারে, অন্তত ছয়টা (secret ছাড়াও identity এর signing key আর JWKS, flags, registry, container image, outbox relay, ...)। প্রতিটার জন্য বলুন কীভাবে আগে থেকে মুম্বাইয়ে রাখবেন, আর সেটা 10.5 এর নিয়ম না ভেঙে (secret এর কপি কোথায় থাকবে, কে পড়তে পারবে)। আট মাস আগে game day হয়েছিল, তবু এগুলো ধরা পড়েনি কেন? `LOG_LEVEL=debug` এর মতো drift ধরতে game day ছাড়া আর কী লাগে? EU cell নিয়েও একই প্রশ্ন: ১৯:৪০ থেকে ২১:৪০ সিঙ্গাপুরের global স্তর ধীর ছিল। EU cell এর কোন কাজ চলেছে, কোনটা চলতে পারত না, আর কেন?

**৫. সরানো contractor, আর ঠান্ডা cache (Lesson 10.1 + 10.5 + 4.6)**
(ক) ০২:১০ এর export টা ধাপে ধাপে ব্যাখ্যা করুন: ২০:৩০ এর remove এর পরে cache এর delete কোন node এ গেল, `cache-4` কেন পুরনো তালিকা নিয়ে ফিরল, আর কোন দুটো সিদ্ধান্ত মিলে ভুলটা ছয় ঘণ্টা টিকল। 10.1 এর তিনটা প্রতিকারের কোনগুলো সেই রাতে বন্ধ ছিল? 10.5 এর denylist এখানে কেন কোনো কাজে আসেনি? সবচেয়ে বড় প্রশ্ন: authorization এর সিদ্ধান্ত কি cache থেকে পড়া উচিত? যদি হ্যাঁ, কোন শর্তে (TTL কত, invalidate কীভাবে, আর কোন কাজে DB থেকে আবার যাচাই, যেমন export)? এটা কি customer কে জানানোর মতো security incident, আর audit log থেকে কী কী বের করবেন?
(খ) মুম্বাইয়ের খালি cache এ failover মানে 4.6 এর কোন ঘটনা? Stampede এর মাঝখানে চারটা node একসাথে যোগ করা কেন খারাপ বুদ্ধি, ring হলেও (10.1 এর weight আর single-flight এর কথা ভাবুন)? Pilot light এর cache কে কীভাবে "গরম" রাখবেন, আর তার মাসিক দাম কী?

**৬. Share link এর বন্যা আর দুই রকম 404 (Lesson 10.2 + 10.5 + 10.7)**
(ক) Cache key normalize করা থাকা সত্ত্বেও edge cache কেন কোনো কাজে এলো না? Bloom filter কী বাঁচাল আর কী বাঁচাল না? এই আক্রমণ কোন স্তরে থামানো উচিত আর কী দিয়ে? অন্তত তিনটা উপায় দিন (যেমন share page এ bot score, edge এ slug এর আকৃতি যাচাই, challenge), আর প্রতিটা বৈধ user এর উপর কী দাম চাপায়।
(খ) "নতুন link 404" এর দুটো কারণ আলাদা করুন। প্রথমটা Bloom filter এর false negative: 10.2 এর কোন কথাটা এর ব্যাখ্যা দেয়? কোন নিরাপত্তা জাল (fail open এর শর্ত, recent set, metric) কাজ করার কথা ছিল, আর কেন করেনি? দ্বিতীয়টা Bloom এর দোষ না। তাহলে কার?
(গ) Autoscale চার ঘণ্টা ৪০ এ আটকে থাকল। এই সীমা কি ঠিক কাজ করেছে? এখানে cost আর availability এর বিনিময়টা কী? আর বন্যা edge এ থামালে বিল আনুমানিক কেমন হতো (10.7 এর DDoS এর হিসাবের মতো করে)?

**৭. Incident এর মাঝখানে canary (Lesson 10.6 + 10.4)**
Incident চলার সময় pipeline নিজে নিজে এগিয়ে গেল। এটা কোন নিয়মের অভাব, আর নিয়মটা কোথায় বসবে: মানুষ মনে রাখবে, নাকি pipeline নিজে জানবে? Gate ২৫% এ "পাস" করেছে। (ক) Failover এর পরে canary আর baseline এর তুলনা কি তখনও অর্থপূর্ণ ছিল? (খ) EU থেকে আসা ৩১০টা request এর মধ্যে ১২টা task তৈরি। ৬% ব্যর্থতা থাকলে এই ১২টায় প্রত্যাশিত বাড়তি ব্যর্থতা কতগুলো? এটা কি কোনো gate ধরতে পারে? Segment ধরে ন্যূনতম request এর নিয়ম কেমন হবে? আর EU cell এর মতো ছোট segment এর জন্য কী করবেন: প্রতি ধাপে বেশি সময়, নাকি cell ধরে আলাদা canary? শেষে backfill (expand/contract এর ধাপ ৩): incident এর সময় এটা কে থামাবে, আর কীভাবে?

**৮. অন্ধকারে দেখা, আর একটা ভুল সংখ্যা (Lesson 10.4 + 10.2)**
(ক) যখন সবচেয়ে দরকার, ঠিক তখনই trace ছিল না কেন? Collector কোথায় চলবে তার নিয়ম কী হবে? Tail sampling এর collector চাপে পড়লে কোন trace আগে রাখবে আর কোনগুলো আগে ফেলবে, তার একটা ক্রম দিন।
(খ) ৪১,৩০০ সংখ্যাটা ভুল কেন, আর কোন দিকে? অন্তত তিনটা আলাদা ভুল আছে। সঠিক HLL হিসাব কী হতো, Redis এর command সহ? তবু credit কেন HLL দিয়ে দেওয়া যাবে না? "প্রভাবিত" এর সংজ্ঞা একটা SLI এর ভাষায় দিন: কোন journey, কোন সীমা। ১৯,৮০০ সংখ্যাটা বিশ্বাসযোগ্যভাবে কোথা থেকে আসতে পারে (10.4 এর কোন log এর লাইন থেকে)?
(গ) সেই রাতে বাজা উচিত ছিল কিন্তু বাজেনি এমন অন্তত চারটা alert বলুন (যেমন মুম্বাইয়ের replica lag, ring এর membership এর দোল, segment ধরে SLI, share link এ "filter বলল নেই কিন্তু recent set এ আছে")। প্রতিটা page হবে, না ticket?

**৯. বিল (Lesson 10.7)**
বাড়তি $৯,৭০০ এর প্রতিটা লাইন দুই ভাগে ফেলুন: DR এর **ন্যায্য** দাম (দুর্যোগে যে খরচ হওয়ারই কথা) আর অপচয়। কোন লাইনটা সবচেয়ে বড় অপচয়, আর সেটা কোন lesson এর কোন নিয়ম আটকাত? Cross-region transfer এর লাইনটা ($৬০) দেখে কী শিখলে? Cost anomaly ticket কারো কাছে পৌঁছায়নি কেন, আর এই ব্যর্থতার সাথে এই রাতের আর কোন ব্যর্থতার মিল আছে? Failback যত দেরি হয়, কোন লাইনগুলো তত বাড়ে? Failback এর একটা সময়সীমা কে ঠিক করবে, আর কোন হিসাবে?

**১০. CEO এর প্রশ্ন, আর অগ্রাধিকার (Lesson 10.1 – 10.8)**
(ক) ঘটনা ১৩ এর উত্তর এক প্যারায়, দোষারোপ ছাড়া: যন্ত্রগুলো কাজ করে কিনা, আর এই রাতের ব্যর্থতাগুলোর পেছনে সাধারণ সুতোটা কী। কোন রক্ষাকবচ ঠিকঠাক কাজ করেছে, সেটাও বলুন (অন্তত তিনটা আছে)।
(খ) একটা **অগ্রাধিকার তালিকা**: এই সপ্তাহে কী (আবার ঘটার আগে), এই মাসে কী, আর এই quarter এ কী। প্রতিটার পাশে লিখুন কোন lesson, কোন ঘটনা এটা আটকাত, আর সাফল্য কীভাবে মাপবেন (কোন metric, কোন সংখ্যা)।
(গ) একটা **রক্ষাকবচের তালিকা** (safety net inventory), অন্তত দশটা লাইন। প্রতিটা লাইনে: রক্ষাকবচটা কী, তার মালিক কে, আর **আপনি কীভাবে জানবেন যে এটা এখনো চালু আছে** (একটা test, একটা metric, নাকি একটা অনুশীলন)। যে লাইনে শেষ ঘরটা ফাঁকা থাকে, সেই রক্ষাকবচ ছয় মাসে কোথায় যাবে?

**মনে রাখার কথা:** এই module এর চারটা জায়গায় সবচেয়ে সহজে ভুল হয়। (ক) **পরিষ্কার ব্যর্থতার জন্য নকশা করা**, যেখানে বাস্তবের ব্যর্থতা ধূসর। Runbook "region down" ধরে নেয়, health check "মরা" খোঁজে, failover ধরে নেয় পুরনো primary মরা। বাস্তবে বেশিরভাগ রাত "ধীর, আংশিক, আর বাইরে থেকে সুস্থ দেখায়"। (খ) **রক্ষাকবচকে একবারের কাজ ভাবা।** Flush, TTL, test, game day, tag এর মালিক, প্রতিটাই কেউ একদিন যুক্তিসঙ্গত কারণে বন্ধ করে। যে রক্ষাকবচ চালু আছে কিনা কেউ মাপে না, সেটা একসময় থাকে না। (গ) **Backup এর পথে মূলের উপর নির্ভরতা।** DR stack এর secret, image, config, worker যদি মূল region থেকে আসে, তাহলে backup ঠিক সেই দিনটায় অকেজো যেদিন তাকে দরকার। (ঘ) **আনুমানিক বা cache এর data কে কর্তৃত্ব দেওয়া।** Cache থেকে membership, HLL থেকে credit, মোট request থেকে canary এর রায়। প্রতিটা যন্ত্র তার নিজের কাজে ঠিক, কিন্তু যে সিদ্ধান্তে টাকা, অনুমতি বা customer জড়িত, সেখানে সত্যের উৎস লাগে। আজকের scenario তে চারটাই আছে, কয়েকবার করে। আর Module 10 এর সবচেয়ে গুরুত্বপূর্ণ অভ্যাস: প্রতিটা রক্ষাকবচের জন্য জিজ্ঞেস করুন, **"এটা যেদিন নিঃশব্দে বন্ধ হয়ে যাবে, সেদিন আমি কীভাবে জানব?"**

আমি এটা প্রতিটা ধাপ ধরে ধরে critique করব।

---

## ২. Self-Check — এই Module শেষে আপনি এগুলো পারার কথা

- [ ] `hash % N` এ N থেকে N+1 এ কত key নড়ে আর **কোথায়** যায়, সংখ্যা দিয়ে বলতে পারি; hash ring কীভাবে নড়াকে শুধু নতুন node এর ভাগে নামায়
- [ ] Virtual node কেন লাগে, কয়টা, আর দাম কী; replica বাছাইয়ে "পরের ৩টা বিন্দু" এর ফাঁদ, আর আলাদা node আর আলাদা AZ এর নিয়ম
- [ ] Consistent hashing যা করে না সেটা বলতে পারি: consistency দেয় না (পুরনো data নিয়ে ফেরা node), hot key সারায় না (bounded load এর দাম), আর membership এর দায় নেয় না; Redis Cluster এর hash slot কেন ring না
- [ ] Probabilistic structure এ প্রথম প্রশ্ন "কোন দিকে ভুল"; Bloom filter এর আকার (প্রতি জিনিসে ~৯.৬ bit এ ১%), ভরে গেলে নিঃশব্দ অবক্ষয়, আর system থেকে আসা false negative
- [ ] Negative cache বনাম Bloom filter, কখন কোনটা; HyperLogLog এর memory আর ভুল, merge কেন জাদু, আর কেন billing এ কখনো না; Count-Min Sketch কিসে ভালো আর কিসে খারাপ
- [ ] Fault আর failure এর পার্থক্য; একটা journey এর hard আর soft dependency এর matrix বানাতে পারি, আর availability কে hard dependency এর গুণফল হিসেবে হিসাব করতে পারি
- [ ] Timeout ছাড়া soft dependency আসলে hard কেন; redundancy এর সূত্র কেন correlated failure এ ভাঙে, আর failure domain কী
- [ ] Brownout বনাম load shedding; static stability (last-known-good, snapshot, boot এ crash না) আর তার দাম
- [ ] Chaos experiment design করতে পারি: steady state, hypothesis, blast radius, control group, abort এর শর্ত
- [ ] Monitoring বনাম observability; গড় কেন লেজ লুকায়, percentile কেন যোগ করা যায় না, আর histogram এর bucket কোথায় ঘন রাখতে হয়
- [ ] Label cardinality এর দাম হিসাব করতে পারি, আর জানি কোন তথ্য metric এ, কোনটা log আর trace এ
- [ ] Distributed trace কীভাবে জোড়া লাগে (`traceparent`, context propagation); head বনাম tail sampling; multi-window burn rate alert আর "error > ১%" এর পার্থক্য
- [ ] AuthN বনাম AuthZ; JWT যাচাইয়ের নিয়ম (algorithm allowlist, trusted key, `iss`/`aud`/`exp`); BOLA কী আর scoped loader আর route × actor test দিয়ে কীভাবে থামাই
- [ ] Token এর মেয়াদ, refresh rotation, reuse detection আর denylist এর trade-off; OAuth code flow এ state আর PKCE কোন আক্রমণ থামায়
- [ ] Secret ফাঁস হলে আগে rotate কেন; secret এর আয়ু আর ভাগ দিয়ে blast radius কমানো; credential stuffing কেন per-IP সীমা এড়ায়; volumetric বনাম L7 DDoS, কোন স্তর কোনটা থামায়
- [ ] Graceful shutdown এর সঠিক ক্রম; big-bang, rolling, blue-green আর canary এর blast radius; canary এর gate, segment আর পরিসংখ্যানের সীমা
- [ ] Feature flag দিয়ে deploy আর release আলাদা করা (sticky ভাগ, একবার সিদ্ধান্ত); version skew; DDL এর lock queue, `lock_timeout`; rename এর expand/contract এর ছয় ধাপ
- [ ] Cost এর চারটা চালক দিয়ে একটা বিল পড়তে পারি; unit economics; autoscale, commitment আর spot কোন অংশে; storage tier এর ফাঁদ; NAT আর cross-AZ transfer এর লুকানো খরচ; ভাগ ধরে anomaly detection
- [ ] Multi-region এর তিনটা কারণ (latency, DR, residency) আলাদা করতে পারি; দূরত্ব round trip এ গুণ হয় কেন; RPO আর RTO দিয়ে DR কৌশল বাছতে পারি, দাম সহ
- [ ] DNS failover এর লেজ, split brain আর witness; একাধিক region এ লেখার নীরব ক্ষতি; home region, cell আর data residency দিয়ে একটা নকশা দাঁড় করাতে পারি

---

## ৩. Recommendation

**পড়ার জন্য:**

- **Google এর _Site Reliability Engineering_ আর _The Site Reliability Workbook_।** দুটোই বিনামূল্যে পড়া যায়। Workbook এর "Alerting on SLOs" অধ্যায় 10.4 এর burn rate এর আসল উৎস, ধাপে ধাপে, প্রতিটা alert এর নিয়মের দুর্বলতা সহ। মূল বইয়ের "Managing Incidents" আর "Postmortem Culture" অধ্যায় এই challenge এর প্রশ্ন ১০ এর জন্য সরাসরি কাজে লাগবে।
- **Amazon Builders' Library এর লেখাগুলো:** "Static stability using Availability Zones", "Avoiding fallback in distributed systems", "Timeouts, retries, and backoff with jitter"। 10.3 আর 10.8 এর প্রায় প্রতিটা সিদ্ধান্তের পেছনের যুক্তি, AWS এর নিজের ভুল থেকে লেখা। সাথে AWS এর whitepaper "Reducing the Scope of Impact with Cell-Based Architecture", 10.8 এর cell এর গভীর রূপ।
- **Charity Majors, Liz Fong-Jones, George Miranda — _Observability Engineering_।** 10.4 এর "অজানা প্রশ্ন", wide event আর high-cardinality data কেন metric এ না, এর সবচেয়ে ভালো ব্যাখ্যা। কিছু অংশ একটা vendor এর দৃষ্টিভঙ্গি থেকে লেখা, সেটা মাথায় রেখে পড়ুন।
- **OWASP API Security Top 10।** তালিকার এক নম্বরে BOLA, আর প্রতিটা ঝুঁকির সাথে আক্রমণের উদাহরণ। 10.5 এর সোমবারের ঘটনা ঠিক এখানে লেখা। JWT এর জন্য RFC 8725 ("JSON Web Token Best Current Practices"), ছোট আর সরাসরি।
- **J.R. Storment, Mike Fuller — _Cloud FinOps_।** 10.7 এর tag, মালিক, showback আর anomaly এর প্রক্রিয়ার দিক। কোন সিদ্ধান্ত কে নেয়, আর engineer আর finance কীভাবে একই সংখ্যা দেখে।
- **মূল paper গুলো, ছোট আর পড়ার মতো:** Karger et al., "Consistent Hashing and Random Trees" (1997); Flajolet et al., "HyperLogLog" (2007); Lamping & Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (jump hash, 2014)। প্রতিটার শুরুর অংশ পড়লেই 10.1 আর 10.2 এর সংখ্যাগুলো কোথা থেকে আসে বোঝা যায়।

**দেখার আর পড়ার মতো postmortem:**

- **GitHub, অক্টোবর ২০১৮ ("October 21 post-incident analysis")।** ৪৩ সেকেন্ডের একটা network সমস্যার পরে স্বয়ংক্রিয় failover database এর primary কে অন্য coast এ সরাল, দুই দিকে লেখা হলো, আর ফিরতে লাগল এক দিনের বেশি। এই challenge এর প্রশ্ন ১ আর ৩ এর বাস্তব রূপ: ধূসর ব্যর্থতা, cross-region failover, আর এমন failback যেটা failover এর চেয়ে অনেক কঠিন।
- **Cloudflare, নভেম্বর ২০২৩ এর control plane আর analytics outage।** একটা data center এর বিদ্যুৎ গেল, আর দেখা গেল কিছু service যেগুলোকে "অন্য জায়গায়ও চলে" ভাবা হয়েছিল, তারা চুপচাপ ওই একটা জায়গার উপর নির্ভর করত। প্রশ্ন ৪ এর "backup এর গায়ে মূলের ছায়া" এর সবচেয়ে সৎ বিবরণগুলোর একটা।
- **Dan Luu এর "post-mortems" তালিকা (GitHub এ)।** শত শত প্রকাশিত postmortem এর একটা সংগ্রহ, ধরন অনুযায়ী সাজানো। প্রতি সপ্তাহে একটা পড়ুন, আর প্রতিটায় জিজ্ঞেস করুন এই module এর কোন lesson এটা আটকাত।

**Project এর জন্য:**

- **একটা game day, নিজের laptop এ:** Docker Compose এ দুটো "region" (দুটো network, মাঝে `tc netem` দিয়ে ৬০ ms আর packet loss), প্রতিটায় একটা Postgres (একটা primary, অন্যটা async replica) আর একটা ছোট Express app। তারপর এই challenge এর রাতটা নিজে চালান: backfill চালিয়ে replica lag মাপুন আর দেখুন RPO কত হয়; পুরনো primary কে না মেরে failover করুন আর দুই দিকে লেখা গুনুন; তারপর fencing যোগ করে আবার। শেষে failback করুন, আর সময় মাপুন। আপনার RTO এর কত অংশ যন্ত্রের, আর কত অংশ আপনার নিজের সিদ্ধান্তের?
- **একটা drift detector:** একটা TypeScript script যা প্রতিদিন চলে আর প্রতিটা রক্ষাকবচ এখনো আছে কিনা দেখে: cache এর key গুলোর একটা sample এ TTL আছে কিনা (`SCAN` + `TTL`); CI তে কতগুলো test `skip` করা আর কতদিন ধরে; কোন resource এর `team` tag এমন team এর নামে যা আর নেই; IaC তে `LOG_LEVEL` কী; শেষ game day কবে। প্রশ্ন ১০(গ) এর তালিকাকে code বানান। যেদিন প্রথমবার এটা কিছু খুঁজে পাবে, সেদিন বুঝবেন কেন এটা লাগে।
- **একটা postmortem লিখুন:** এই scenario টার জন্য, একটা আসল postmortem এর ছকে (সারাংশ, প্রভাব, timeline, মূল কারণ নয় বরং কারণগুলো, কী ঠিক কাজ করেছে, পদক্ষেপ, মালিক আর তারিখ সহ), দোষারোপ ছাড়া। তারপর উপরের GitHub এর postmortem পাশে রেখে তুলনা করুন তারা কী লিখেছে যা আপনি লেখোনি।

---

Exit challenge টা করে পাঠান। রেডি হলে `next` লিখলে আমরা **Module 11: Real System Design Case Studies** এ যাব, শুরু Lesson 11.1 দিয়ে: **Design a URL Shortener**।

Module 1 থেকে Module 10 পর্যন্ত TaskFlow একটা Express server আর একটা Postgres থেকে বেড়ে এই রাতের system এ এসেছে, আর প্রতিটা ধাপে আমরা একটা করে প্রশ্ন আলাদা করে মেপেছি। Module 11 এ TaskFlow কে পাশে রাখব। প্রতিটা lesson এ একটা নতুন system, শূন্য থেকে, interview এর মতো করে, Lesson 1.2 এর কাঠামো ধরে: requirement → estimation → high-level design → deep dive → trade-off। এবার কেউ আপনাকে বলে দেবে না কোন lesson এর কোন যন্ত্র লাগবে। URL shortener এ এই module এর তিনটা যন্ত্র ফিরে আসবে (নতুন code "নেওয়া কিনা" এর জন্য Bloom filter, unique visitor এর জন্য HyperLogLog, আর key ভাগ করার জন্য consistent hashing), সাথে Module 4 এর cache আর Module 5 এর sharding। কোনটা কোথায় বসবে, আর কোনটা আসলে লাগবেই না, সেটা এবার আপনি ঠিক করবেন।
