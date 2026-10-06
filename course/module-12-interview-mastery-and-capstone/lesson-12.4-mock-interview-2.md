# Lesson 12.4 — Mock Interview #2: Harder, Follow-up Question সহ

**Module 12 — Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 6.4):** Lamport clock আর vector clock এর মধ্যে কোনটা বলতে পারে দুটো ঘটনা "একসাথে" (concurrent) ঘটেছে, মানে কেউ কাউকে প্রভাবিত করেনি? এক লাইনে, কারণসহ। তারপর mock এ ঢোকো। একটা follow-up ঠিক এই প্রশ্নের উপর দাঁড়ানো, আর উত্তরটা হয়তো তোমাকে অবাক করবে: এই system এ vector clock না-ও লাগতে পারে। উত্তর mock এর পরে, ১.৪ এ।

**Prerequisite:** Lesson 12.3 (mock এর নিয়ম আর তোমার score), Lesson 5.5 (optimistic lock), Lesson 5.8 (Sharding), Lesson 6.4 (Logical clock, sibling), Lesson 8.1 আর 8.2 (Object storage, presigned URL, multipart), Lesson 11.3 (Connection gateway)

**তুমি এই lesson শেষে পারবে:**

1. একটা ৬০ মিনিটের interview এ মাঝপথে requirement বদলে গেলে নিজের আগের সিদ্ধান্তের কোনটা ভাঙল তা বলতে পারবে, আর পুরোটা ফেলে না দিয়ে নকশা বদলানোর একটা পথ দেখাতে পারবে
2. একটা file sync system (Dropbox এর মতো) এর মূল সিদ্ধান্তগুলো সংখ্যা দিয়ে বলতে পারবে: content hash এর block, bytes আর metadata এর আলাদা পথ, change journal আর cursor, conflict এ কেন দুটো copy রাখা, আর sharding এর একক হিসেবে namespace
3. Interviewer এর push-back (তোমার উত্তরের পরে আসা চাপ) সামলাতে পারবে: দাম মেনে নিয়ে, সংখ্যা দিয়ে, নিজের অবস্থান বদলাতে হলে সেটা স্পষ্ট বলে

**Tier:** 3 — Design Exercise (mock interview; deliverable হলো recording, score, আর 12.3 এর score এর সাথে তুলনা। Script নেই)

---

## ০. TaskFlow এখন কোথায়

TaskFlow আজও পাশে। 12.3 এর শেষে তুমি দুটো জিনিস নিয়ে এসেছ: rubric এর সবচেয়ে কম দুটো মাত্রা, আর একটা সৎ recording এর অভিজ্ঞতা। আজ সেই দুটো মাত্রা নড়ে কিনা, সেটাই দেখার।

এই mock তিনটা কারণে কঠিন:

- **বড় system।** File sync এ data এর দুটো সম্পূর্ণ আলাদা জগৎ: file এর bytes (petabyte, object storage) আর metadata (কোন file, কোন version, কোন device জানে)। দুটোকে আলাদা রাখা, আর তারপর আবার ঠিকভাবে জোড়া, এটাই প্রশ্নের মূল।
- **Requirement বদলায়।** মাঝপথে interviewer একটা জিনিস চাইবে যা শুরুতে scope এর বাইরে ছিল। আর তুমি শুরুতে যে সিদ্ধান্ত যুক্তিসঙ্গতভাবে নিয়েছিলে, তার একটা এতে ভেঙে যেতে পারে। বাস্তব interview এ এটা ইচ্ছা করে করা হয়: দেখা হয় তুমি কীভাবে খাপ খাওয়াও।
- **Push-back।** কিছু follow-up এর ভেতরে দ্বিতীয় একটা বন্ধ অংশ আছে: interviewer এর চাপ, যেটা তুমি উত্তর দেওয়ার **পরে** খুলবে। প্রথম উত্তর যত ভালোই হোক, interviewer তার একটা দুর্বলতা চেপে ধরবে।

12.1 এর একটা কথা আজ সবচেয়ে বেশি কাজে লাগবে: _"নতুন তথ্যে মত বদলানো দুর্বলতা না।"_ আজ সেটা পরীক্ষা হবে।

---

## ১. Theory

### ১.১ প্রস্তুতি আর নিয়ম

12.3 এর সব নিয়ম, সাথে তিনটা পরিবর্তন:

- **সময় ৫০ মিনিট** (৬০ মিনিটের round এ শুরুর পরিচয় আর শেষের প্রশ্ন বাদে)। Time box: `Req 5 · Est 5 · HLD 10 · Deep 25 · Wrap 5`। বাড়তি সময় পুরোটা deep dive এ (12.1)।
- **Push-back এর অংশ** খোলো শুধু নিজের প্রথম উত্তর জোরে শেষ করার পরে। তারপর আবার ১-২ মিনিট।
- **শুরুর আগে** 12.3 এর score এর সবচেয়ে কম দুটো মাত্রা board এর কোণে লেখো। Mock এর মাঝে চোখ পড়লে মনে পড়বে।

### ১.২ প্রশ্ন (00:00)

Interviewer:

> "Design Dropbox. মানে, একজন user এর file তার সব device এ sync থাকবে।"

Timer চালু করো।

<details>
<summary><strong>Interviewer এর উত্তর — নিজের clarifying question গুলো জোরে করার পরে খোলো</strong></summary>

শুধু তুমি যা জিজ্ঞেস করেছ তার উত্তর নাও। বাকিটা জানো না ধরে নাও।

| প্রশ্ন                            | Interviewer এর উত্তর                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| কতজন user?                        | ৫ কোটি registered, রোজ ~১ কোটি active                                                             |
| কয়টা device?                     | গড়ে ২টা: একটা computer (desktop client, একটা folder দেখে) আর একটা phone (app, চাইলে file নামায়) |
| কত data?                          | একজন user এর গড়ে ~২ GB, ~১,০০০টা file                                                            |
| কতবার বদলায়?                     | একজন active user দিনে গড়ে ~২০টা file বদলায় বা যোগ করে; বদলানো file গড়ে ~৫০০ KB                 |
| সবচেয়ে বড় file?                 | ৫০ GB পর্যন্ত                                                                                     |
| কত দ্রুত sync?                    | Online device এ ~১০ সেকেন্ডের মধ্যে                                                               |
| Offline?                          | হ্যাঁ: laptop offline এ edit করতে পারে, online হলে sync                                           |
| পুরনো version?                    | ৩০ দিনের ইতিহাস, পুরনো version ফেরানো যায়                                                        |
| Share করা?                        | "আজকের scope এর বাইরে। একজন user, তার নিজের device।"                                              |
| Peak?                             | গড়ের মোটামুটি ৩ গুণ                                                                              |
| একসাথে edit (Google Docs এর মতো)? | না। এটা file sync, document editor না                                                             |
| অন্য যেকোনো প্রশ্ন                | "তুমিই ঠিক করো।"                                                                                  |

</details>

### ১.৩ Interviewer এর follow-up

<details>
<summary><strong>Follow-up ১ — মিনিট ~১৩</strong></summary>

> "একটা ২ GB এর video file। তার মাঝখানে এক byte বদলালাম। কী upload হয়?"

<details>
<summary><strong>Push-back — নিজের উত্তরের পরে খোলো</strong></summary>

> "আচ্ছা। আর যদি বদলানোর বদলে file এর **শুরুতে** এক byte **ঢোকাই**?"

</details>

</details>

<details>
<summary><strong>Follow-up ২ — মিনিট ~১৭</strong></summary>

> "Laptop এ একটা file save করলাম। আমার phone এটা কীভাবে জানে, আর কত দ্রুত?"

</details>

<details>
<summary><strong>Follow-up ৩ — মিনিট ~২১</strong></summary>

> "৫০ GB এর upload এর অর্ধেকে laptop এর battery শেষ। পরের দিন খুললে কী হয়? আর এর মধ্যে আমার phone কি একটা অর্ধেক file দেখেছে?"

</details>

<details>
<summary><strong>Follow-up ৪ — মিনিট ~২৫ (requirement বদল)</strong></summary>

> "Product team এর নতুন সিদ্ধান্ত: share করা folder লাগবে, এই quarter এই। একটা company র team folder এ ৫,০০০ member, সবাই লিখতে পারে। তোমার এখনকার নকশায় কী ভাঙে, আর কী বদলাবে?"

</details>

<details>
<summary><strong>Follow-up ৫ — মিনিট ~৩১</strong></summary>

> "একজন plane এ offline অবস্থায় team folder এর একটা file তিন ঘণ্টা ধরে edit করল। একই সময়ে একজন সহকর্মী online এ একই file বদলেছে। Plane নামার পরে কী হয়?"

<details>
<summary><strong>Push-back — নিজের উত্তরের পরে খোলো</strong></summary>

> "যদি তুমি একটা version কে জিতিয়েছ: যে হারল, তার তিন ঘণ্টার কাজ গেল, আর সে কাল আমাদের support এ ফোন করবে। যদি দুটোই রেখেছ: ৫,০০০ জনের folder এ প্রতি সপ্তাহে শত শত 'conflicted copy', আর কেউ জানে না কোনটা আসল। কোনটা বাছবে, আর দামটা কীভাবে কমাবে?"

</details>

</details>

<details>
<summary><strong>Follow-up ৬ — মিনিট ~৩৭</strong></summary>

> "Finance বলছে storage এর বিল বছরে ৪০% বাড়ছে। কোথায় কাটবে?"

</details>

<details>
<summary><strong>Follow-up ৭ — মিনিট ~৪২</strong></summary>

> "Security team একটা সমস্যা তুলেছে: তোমার deduplication থেকে নাকি তথ্য ফাঁস হতে পারে। কীভাবে, আর কী করবে?"

</details>

<details>
<summary><strong>Follow-up ৮ — মিনিট ~৪৭</strong></summary>

> "শেষ প্রশ্ন। শুরুতে নেওয়া কোন সিদ্ধান্ত এখন আলাদাভাবে নিতে?"

</details>

**৫০ মিনিট। Timer থামাও, recording বন্ধ করো।** 12.3 এর মতো, পড়ার আগে তিনটা জিনিস লেখো: সবচেয়ে ভালো মুহূর্ত, সবচেয়ে খারাপ, আর follow-up ৪ এর পরে তোমার মনে প্রথম কী এসেছিল (সৎ উত্তর: "পুরোটা আবার করতে হবে" নাকি "এই অংশটা বদলাতে হবে")।

### ১.৪ Score: rubric ধরে, প্রমাণ সহ

**Spaced repetition এর উত্তর:** Lamport clock একটা মোট ক্রম দেয় যা কার্যকারণ মানে (a আগে ঘটে b কে প্রভাবিত করলে a এর সংখ্যা ছোট), কিন্তু উল্টোটা বলতে পারে না: সংখ্যা ছোট মানেই প্রভাবিত করেছে না। তাই দুটো ঘটনা concurrent কিনা, Lamport বলতে পারে না। Vector clock পারে: দুটো vector এর কোনোটা অন্যটার সব ঘরে ≥ না হলে তারা concurrent (6.4)। কিন্তু এই system এ সম্ভবত vector clock লাগে না, কারণ প্রতিটা folder এর সব commit **একটা server** এর মধ্য দিয়ে যায়, যেটা একটা ক্রম ঠিক করে দেয়। তখন concurrent edit ধরার জন্য প্রতিটা commit এ "আমি কোন version এর উপর কাজ করেছি" (base revision) বলে দেওয়াই যথেষ্ট — 5.5 এর optimistic lock। Vector clock এর দরকার হয় যখন কোনো একক ক্রম ঠিক করার জায়গা নেই: peer-to-peer sync, বা বহু leader এর database (6.4 এর sibling)। Follow-up ৫ এর model answer এ এটা আসবে।

Recording শোনো, প্রতিটা মাত্রায় ১-৪ আর `mm:ss`। নোঙরগুলো এই প্রশ্নের জন্য, আর এবার "বিচার" আর "যোগাযোগ" এ খাপ খাওয়ানোর অংশ আছে:

| মাত্রা             | ১ — দুর্বল                                   | ২                                                              | ৩                                                                                                 | ৪ — শক্ত                                                                                                           |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| অস্পষ্টতা সামলানো  | সরাসরি আঁকা শুরু                             | মাপ জিজ্ঞেস করেছে, কিন্তু offline, version বা বড় file না      | Offline, version, সবচেয়ে বড় file, sync এর গতি — নকশা বদলায় এমন প্রশ্ন                          | সাথে share জিজ্ঞেস করেছে আর "scope এর বাইরে" শুনেও বলেছে যে নকশা এমন রাখবে যাতে পরে যোগ করা যায়                   |
| কাজের নকশা         | একটা "file server", bytes আর metadata একসাথে | Object storage আছে, কিন্তু sync এর পথ (device কীভাবে জানে) নেই | Bytes আর metadata আলাদা পথে; upload, commit, notify, pull — end-to-end, data model আর API সহ      | সাথে commit এর atomicity: block আগে, metadata পরে, তাই অর্ধেক file কখনো দেখা যায় না                               |
| Technical গভীরতা   | "S3 এ রাখব" এর বেশি না                       | Block এ ভাগ করেছে, কিন্তু hash বা dedupe এর কারণ না            | Content hash এর block, শুধু নতুন block upload, cursor দিয়ে change pull, base revision এ conflict | সাথে insert এ fixed block এর সমস্যা (content-defined chunking), block এর আকারের trade-off সংখ্যায়, dedupe এর ফাঁস |
| বিচার আর trade-off | একটাই সমাধান                                 | বিকল্প আছে, দাম নেই                                            | বড় সিদ্ধান্তে দাম সহ (conflict: জেতানো বনাম দুটো রাখা; block এর আকার)                            | Requirement বদলে নিজের আগের সিদ্ধান্তের কোনটা ভাঙল সেটা নিজে বলেছে, আর পুরোটা না, শুধু ভাঙা অংশটা বদলেছে           |
| যোগাযোগ            | নীরবতা, push-back এ আত্মরক্ষা                | জোরে ভেবেছে, কিন্তু push-back এ অবস্থান না বদলে তর্ক           | Time box, check-in; push-back এ দাম মেনে উত্তর                                                    | Push-back এ নিজের অবস্থান স্পষ্টভাবে বদলেছে বা কারণসহ ধরে রেখেছে; follow-up ৪ এ শান্ত, ধাপে ধাপে                   |

তারপর দশটা ভুলের checklist (12.3 এর ১.৪ এর মতো), আর একটা নতুন অংশ: **12.3 এর সাথে তুলনা।**

```
মাত্রা                   12.3     12.4     পার্থক্যের প্রমাণ (mm:ss)
অস্পষ্টতা সামলানো        _        _
কাজের নকশা               _        _
Technical গভীরতা         _        _
বিচার আর trade-off       _        _
যোগাযোগ                  _        _
```

12.3 এর দুটো সবচেয়ে কম মাত্রা কি নড়েছে? না নড়লে, কেন: প্রশ্ন কঠিন ছিল, নাকি অভ্যাসটা এখনও বদলায়নি? দুটোর ওষুধ আলাদা। প্রথমটায় আরেকটা mock, দ্বিতীয়টায় 12.1 এর ওই ভুলটা নিয়ে আলাদা অনুশীলন।

### ১.৫ একটা ভালো ঘণ্টা কেমন দেখায়

<details>
<summary><strong>Model answer — নিজের score দেওয়ার পরে খোলো</strong></summary>

**00:00–05:00 — Requirement।** টেবিলের প্রায় সব প্রশ্ন, আর একটা বাড়তি বাক্য যা পরে কাজে লাগবে: "Share আজকের scope এর বাইরে, বুঝলাম। তবে data কে এমনভাবে ভাগ করব যাতে পরে share যোগ করতে সব বদলাতে না হয়।" (এই বাক্যটা follow-up ৪ কে অর্ধেক সহজ করে দেয়। না বললেও ক্ষতি নেই, follow-up ৪ এর উত্তর নিচে আছে।) Scope: "একজন user এর সব device এ sync, offline edit, ৩০ দিনের version। আজ মূলত দুটো পথ: একটা বদল laptop থেকে server এ, আর server থেকে অন্য device এ।"

**05:00–10:00 — Estimation:**

```
Commit (metadata এ লেখা): ১ কোটি × ২০ = ২ × ১০⁸/দিন; ÷ ১০⁵ ≈ ২,০০০/s (ঠিক ~২,৩০০), × ৩ → ~৭,০০০/s peak
Upload এর bytes:         ২ × ১০⁸ × ৫০০ KB = ১০০ TB/দিন ≈ ১ GB/s ≈ ৮ Gbps গড়, peak ~২৫ Gbps
Download:                প্রতিটা বদল গড়ে ~২টা অন্য device এ → ~২০০ TB/দিন, মাসে ~৬ PB egress
মোট storage:             ৫ কোটি × ২ GB = ১০⁸ GB = ১০০ PB (version আর dedupe এর আগে)
Metadata:                ৫ কোটি × ১,০০০ file = ৫ × ১০¹⁰ entry × ~৫০০ B ≈ ২৫ TB (version বাদে)
Online connection:       ১ কোটি × ২ device × ~৫০% online = ~১ কোটি; ২ লাখ প্রতি gateway, ৫০% headroom → ~১০০ gateway
```

"তাই": (১) **Bytes আর metadata দুটো আলাদা জগৎ।** ১০০ PB এর bytes object storage এ (8.1), আর API server কখনো bytes ছোঁয় না: client presigned URL এ সরাসরি পাঠায় (8.2)। (২) **Metadata একটা database এ আঁটে না:** ২৫ TB আর ৭,০০০ commit/s, তাই শুরু থেকেই shard। কী দিয়ে shard, সেটা পরে বড় প্রশ্ন হবে। (৩) **Egress এর বিল একটা প্রধান খরচ** (11.6 এর মতো): মাসে ~৬ PB। তাই যা বদলেছে শুধু সেটা পাঠানো, পুরো file না। (৪) ~১ কোটি খোলা connection মানে 11.3 এর gateway।

**10:00–20:00 — High-level, data model, API।**

```
 [desktop client] ── ① hash করে block এর তালিকা ──► [metadata service] ── "এর কোনগুলো নেই?" ──► block index
        │                                                   │
        │ ② শুধু নেই এমন block, presigned URL এ              │ ③ commit: path, base_rev, block এর তালিকা
        ▼                                                   ▼
 [object storage: block, hash ই নাম]                [metadata DB (shard করা): change journal]
                                                            │ ④ "এই namespace এ নতুন কিছু আছে"
                                                            ▼
                                                    [notification gateway] ──► [phone] ── ⑤ cursor থেকে বদল আনো,
                                                                                            দরকারি block নামাও
```

```
namespaces(ns_id, kind)                                   -- আজ: প্রতিটা user এর root একটা namespace
journal(ns_id, seq, path, rev, blocks[], size, deleted,
        device_id, base_rev, committed_at, PK(ns_id, seq)) -- append-only; seq প্রতি namespace এ বাড়ে
files(ns_id, path, latest_rev, latest_seq)                -- বর্তমান অবস্থা, journal থেকে
blocks(hash PK, size, stored_at)

POST /blocks/missing          { hashes[] }                → { missing[], uploadUrls[] }
POST /ns/:ns/commit           { path, baseRev, blocks[] } → { rev, seq } | 409 { currentRev }
GET  /ns/:ns/changes?cursor=  → { changes[], cursor }
GET  /notify?ns=…&cursor=…    (long-poll বা WebSocket) → "নতুন আছে"
```

**Content-Addressed Block** — file কে টুকরো (block) এ ভাগ করে প্রতিটা টুকরোর নাম দেওয়া তার content এর hash দিয়ে (যেমন SHA-256)। একই content মানে একই নাম, তাই একটা block একবারই রাখা আর পাঠানো লাগে; আর নামটাই প্রমাণ যে content ঠিক আছে। একটা file তখন শুধু block এর hash এর একটা তালিকা।

**Change Journal** — প্রতিটা namespace এর সব বদলের একটা append-only তালিকা, প্রতিটায় একটা বাড়তে থাকা `seq`। প্রতিটা device মনে রাখে সে কোন `seq` পর্যন্ত দেখেছে (cursor, 2.5), আর জিজ্ঞেস করে "এর পরে কী বদলেছে?" এটা 11.3 এর conversation প্রতি sequence এর একই ধারণা: একটা জায়গায় ক্রম ঠিক, আর হারানো বা দুবার পাওয়া সহজে ধরা যায়।

**Follow-up ১ (২ GB এর মাঝে এক byte):** ধরো block ৪ MB। ২ GB = ৫০০টা block। এক byte **বদলালে** শুধু সেই block এর hash বদলায়: client ৫০০টা hash পাঠায়, server বলে "একটা নেই", client ৪ MB পাঠায়। ২ GB এর বদলে ৪ MB।

_Push-back (শুরুতে এক byte ঢোকানো):_ এখানে fixed-size block ভেঙে পড়ে। এক byte ঢোকালে তার পরের সব byte এক ঘর সরে যায়, তাই **প্রতিটা** block এর content বদলায়, প্রতিটা hash নতুন: পুরো ২ GB আবার। সমাধান: **content-defined chunking** — block এর সীমানা ঠিক হয় একটা নির্দিষ্ট দূরত্বে না, content দেখে (একটা rolling hash একটা নির্দিষ্ট pattern পেলে সেখানে সীমানা)। ঢোকানোর পরে শুধু কাছের এক-দুটো সীমানা সরে, বাকি block আগের মতোই, আগের hash। দাম: block এর আকার অসমান, আর hash করার CPU একটু বেশি। আর সৎ একটা কথা: অনেক file (zip, অনেক video format) ছোট বদলেই পুরো file নতুন করে লেখে, তখন কোনো chunking ই সাহায্য করে না।

**Follow-up ২ (phone কীভাবে জানে):** Commit এর পরে metadata service ওই namespace এর জন্য একটা "নতুন আছে" খবর gateway তে পাঠায়। Phone এর app (খোলা থাকলে) একটা long-poll বা WebSocket এ বসে আছে (2.4); খবর পেলে সে নিজের cursor দিয়ে `changes` চায়, পায় নতুন journal entry, আর **file নামায় না** — phone এ শুধু metadata update হয়, file নামে যখন user খোলে। Desktop client নামায়, কিন্তু শুধু নেই এমন block। Notification এ data থাকে না, শুধু "দেখো": তাই notification হারালে বা দুবার এলে ক্ষতি নেই, সত্যটা সবসময় journal এ (11.5 এর মতো)। App বন্ধ থাকলে mobile push (11.5), আর খোলার সময় একটা pull। গতি: commit থেকে খবর এক সেকেন্ডের নিচে, তারপর pull; ১০ সেকেন্ডের লক্ষ্যে আরাম।

**Follow-up ৩ (৫০ GB এর মাঝে battery শেষ):** ৫০ GB = ১২,৫০০টা block। Upload এর ক্রম: আগে **সব** block, তারপর একটা commit। Battery শেষ হলে কিছু block object storage এ আছে, কোনো commit নেই। পরের দিন client আবার hash এর তালিকা পাঠায়, server বলে কোনগুলো নেই, শুধু সেগুলো যায় (8.2 এর resumable upload, এখানে block এর hash ই part এর পরিচয়)। Phone কিছুই দেখেনি, কারণ journal এ entry আসে শুধু commit এ, আর commit আসে শুধু সব block পৌঁছানোর পরে: **অর্ধেক file কখনো দৃশ্যমান না।** Commit এর সময় server যাচাই করে প্রতিটা block আছে। আর commit না হওয়া block গুলো কারো তালিকায় নেই, তাই কয়েক দিন পরে garbage collection এ যায় (follow-up ৬)।

**Follow-up ৪ (requirement বদল: shared folder):** এখানে তোমার শুরুর shard key এর পরীক্ষা।

যদি metadata **user_id দিয়ে** shard করে থাকো (খুবই স্বাভাবিক, কারণ শুরুতে share ছিল না): একটা team folder এর file এখন ৫,০০০ জনের। কার shard এ থাকবে? দুটো খারাপ পথ: (ক) ৫,০০০ জনের প্রত্যেকের shard এ একটা copy, মানে প্রতিটা edit এ ৫,০০০টা লেখা, আর সেগুলো একসাথে ঠিক রাখার কোনো উপায় নেই (দুটো member একই সাথে edit করলে কোন shard এ কোন ক্রম?); (খ) একজন "মালিক" এর shard এ, আর বাকিরা সেখান থেকে পড়ে: তখন একজন user এর file দেখতে অনেক shard এ যেতে হয়, আর মালিক company ছাড়লে কী?

ভালো উত্তর এটা মেনে নেয় যে shard key টা ভুল ছিল, কিন্তু **নকশার বাকিটা না।**

**Namespace** — file এর একটা স্বাধীন গাছ (একজন user এর root folder, বা একটা shared folder), যার নিজের change journal আর নিজের `seq`, আর যেটা sharding এর একক। একজন user এর দৃশ্য হলো কয়েকটা namespace কে নিজের গাছের কোথাও **mount** করা: `mounts(user_id, ns_id, path)`। Shared folder মানে একটা namespace, ৫,০০০টা mount।

বদলের পথ: আজকের প্রতিটা user এর root কে একটা namespace বলো, `ns_id` = আগের user_id। আগের user_id এর shard ই এখন সেই namespace এর shard, তাই **কোনো data সরাতে হয় না**, শুধু ধারণার নাম বদল আর `mounts` table। নতুন shared folder গুলো নতুন namespace, নিজেদের shard এ। Client এর cursor এখন প্রতি namespace এ একটা, আর `notify` কয়েকটা namespace শোনে। Journal, block, commit, conflict: কিছুই বদলায় না, কারণ সেগুলো আগে থেকেই "একটা ক্রমের জায়গা" ধরে লেখা ছিল, এখন সেই জায়গার নাম namespace।

সংখ্যা: ৫,০০০ জনের folder এ জন প্রতি দিনে ২০টা বদল = দিনে ১ লাখ; অফিসের ৮ ঘণ্টার active window এ (12.2) সেকেন্ডে ~৩.৫টা commit, এক shard এর জন্য কিছু না। আসল চাপ notification এ: প্রতিটা commit এ ৫,০০০ জনকে "দেখো" — সেকেন্ডে ~১৭,৫০০টা খবর একটা folder থেকে। ওষুধ: প্রতি client এ খবর জমিয়ে (coalesce) কয়েক সেকেন্ডে একবার (11.5 এর aggregation), কারণ client যাই হোক cursor থেকে সব একসাথে টানে। তাতে প্রতি folder এর খবর এর হার member এর সংখ্যা দিয়ে সীমিত, commit এর সংখ্যা দিয়ে না।

**Follow-up ৫ (offline তিন ঘণ্টা বনাম online সহকর্মী):** Plane এ laptop file টা পেয়েছিল `rev 7` এ। সহকর্মী online এ `rev 8` commit করেছে। Plane নামার পরে laptop commit পাঠায় `base_rev = 7`। Namespace এর server দেখে এখন `rev 8`, মানে laptop এর কাজ `rev 8` জানত না: concurrent edit। এখানে vector clock লাগে না, কারণ namespace এর server একটাই ক্রম ঠিক করে, আর base revision এর তুলনাই বলে দেয় (spaced repetition এর উত্তর; 5.5 এর optimistic lock)। Server `409` দেয়। Client তার version টা রাখে একটা নতুন নামে: `report (Rafi এর laptop এর conflicted copy, 2026-10-06).docx`, আর `rev 8` থাকে আসল নামে।

**Conflicted Copy** — দুটো concurrent edit এর একটাকেও না হারিয়ে, হেরে যাওয়াটা পাশে আলাদা নামে রাখা, যাতে মানুষ মেলাতে পারে। 6.4 এর sibling এর ধারণা, শুধু সমাধানের ভার application এর বদলে মানুষের হাতে, কারণ একটা Word file এর দুটো version system নিজে মেলাতে পারে না।

_Push-back (জেতানো বনাম দুটো রাখা):_ "দুটোই রাখি, আর সেই দামটা মেনে নিচ্ছি: কেউ কাজ হারায় না, কিন্তু মাঝে মাঝে একটা বাড়তি file। তিন ঘণ্টার কাজ চুপচাপ হারানো এমন একটা ভুল যা ফেরানো যায় না, আর একটা বাড়তি file ফেরানো যায়। দাম কমাতে: (১) conflict কতবার হয় সেটা মাপি — দুটো edit কে একই file এ, একই sync জানালায় (online এ ~১০ সেকেন্ড) পড়তে হয়, তাই online এ এটা বিরল, বেশিরভাগ আসে offline থেকে; (২) conflicted copy তৈরি হলে দুজনকেই জানানো, file এর পাশে একটা স্পষ্ট চিহ্ন; (৩) কেউ একটা file খুললে অন্যদের একটা 'Rafi এটা edit করছে' এর ইঙ্গিত, lock না (offline এ lock অর্থহীন), শুধু তথ্য; (৪) সেই একই file এ বারবার conflict হলে, সেটা একটা সংকেত যে এই file একসাথে লেখার জন্য — সেটা document editor এর কাজ (OT/CRDT), file sync এর না, আর আমরা শুরুতে সেটা scope এর বাইরে রেখেছিলাম।"

**Follow-up ৬ (storage এর বিল):** চারটা লিভার, বড় থেকে ছোট:

- **Version এর ইতিহাস আর garbage collection:** ৩০ দিনের পুরনো version এর block যেগুলো আর কোনো version এর তালিকায় নেই, সেগুলো মোছা। কিন্তু reference count দিয়ে না (একটা bug বা crash এ count ভুল হলে, একটা block মোছা যায় যা এখনও কারো দরকার — ফেরানো যায় না)। বরং mark-and-sweep: সব জীবিত তালিকা থেকে block চিহ্নিত করো, চিহ্নহীন আর কয়েক দিনের বেশি পুরনো block মুছো (follow-up ৩ এর commit না হওয়া block ও এভাবেই যায়)।
- **ঠান্ডা স্তর:** এক বছর ছোঁয়া হয়নি এমন block কম দামের storage class এ (8.1, 10.7)। প্রায় সব file storage এর বড় অংশ ঠান্ডা, কিন্তু কত ভাগ সেটা মাপতে হবে।
- **Dedupe:** content hash এর কারণে একই block একবার — একই user এর কয়েকটা copy, পুরনো version এর না-বদলানো block। কত বাঁচে সেটা data এর উপর নির্ভর করে, আন্দাজ না করে মাপতে হবে। (Follow-up ৭ এ এর একটা সীমা।)
- **Block এর আকার:** ছোট block এ delta ভালো (কম bytes পাঠানো আর রাখা), কিন্তু metadata বড়। ১০০ PB কে ৪ MB এ ভাগ করলে ২.৫ × ১০¹⁰ block, প্রতিটার index ~১০০ B ধরলে ~২.৫ TB। ৬৪ KB এ ভাগ করলে ~১.৬ × ১০¹² block, index ~১৫৬ TB — ৬২ গুণ বড়। তাই আকার একটা সংখ্যার সিদ্ধান্ত, আর content-defined chunking এ একটা গড় আকার রেখে উপর-নিচে সীমা।

**Follow-up ৭ (dedupe এর ফাঁস):**

**Dedupe Side Channel** — যখন system বলে দেয় একটা block "আগেই আছে" (upload লাগেনি, তাই তাৎক্ষণিক), তখন একজন attacker একটা আন্দাজ করা file upload করে দেখতে পারে সেটা তাৎক্ষণিক হলো কিনা, আর তা থেকে জানতে পারে **অন্য কারো** কাছে ঠিক এই file আছে কিনা। একটা template এর কয়েক হাজার রূপ (যেমন একটা চিঠি, যাতে শুধু একটা সংখ্যা বদলায়) চেষ্টা করে অন্যের গোপন তথ্যও বের করা যায়।

সমাধান তিনটা, প্রতিটার দাম আলাদা: (ক) dedupe শুধু একই namespace এর ভেতরে, user দের মধ্যে না — ফাঁস বন্ধ, কিন্তু user দের মধ্যের সাশ্রয় হারায় (সাধারণত সাশ্রয়ের বড় অংশ একই user এর ভেতরেই, কিন্তু মাপতে হবে); (খ) client সবসময় bytes পাঠায়, server চুপচাপ একবার রাখে — signal নেই আর storage এর সাশ্রয় থাকে, কিন্তু bandwidth এর সাশ্রয় হারায়; (গ) প্রতি user এর key দিয়ে client এ encryption — কোনো dedupe ই নেই, সবচেয়ে গোপন। আমি (ক) নেব: ফাঁসটা বাস্তব, আর সাশ্রয়ের যে অংশটা যায়, সেটা মাপা না হলে তার জন্য ঝুঁকি নেওয়ার কারণ নেই।

**Follow-up ৮ (কোন সিদ্ধান্ত বদলাতে):** "দুটো। প্রথম, shard key: user_id এর বদলে শুরু থেকেই namespace, কারণ share না থাকলেও 'একটা ক্রমের জায়গা' আর 'একজন মানুষ' আলাদা ধারণা, আর আলাদা রাখার দাম শূন্য ছিল। দ্বিতীয়, ৪ MB এর fixed block এর সংখ্যাটা আমি ধরে নিয়েছিলাম; বাস্তবে content-defined chunking আর আসল file এর একটা নমুনায় মেপে আকার বাছতাম।"

**Wrap-up এর তিনটা বাক্য:** "Bytes আর metadata আলাদা: bytes content hash এর block এ object storage এ, client সরাসরি পাঠায়; metadata namespace ধরে shard করা journal এ, যেখানে commit atomic আর cursor দিয়ে sync। Conflict এ কাজ কখনো হারায় না, conflicted copy তে পাশে থাকে। প্রথমে ভাঙবে একটা বিশাল team folder এর notification এর fan-out, আর বিলের দিকে egress আর পুরনো version এর storage।"

</details>

### ১.৬ এই প্রশ্নে candidate রা সাধারণত কোথায় পড়ে

- _"Upload এর API সরাসরি API server এ, তারপর server S3 এ পাঠায়।"_ — ৮-২৫ Gbps এর bytes app server এর মধ্য দিয়ে। 12.1 এর ভুল ২: নিজের হিসাবের সংখ্যা থেকে "তাই" টা বের হয়নি। 8.2 এর presigned URL ঠিক এর জন্য।
- _"File বদলালে পুরো file আবার upload।"_ — ভুল ৮ আর ২: মাসে ~৬ PB egress এর সংখ্যা এটাকে অসম্ভব বলে।
- _"Device গুলো প্রতি ৩০ সেকেন্ডে server কে জিজ্ঞেস করে কিছু বদলেছে কিনা।"_ — ২ কোটি device × প্রতি ৩০ সেকেন্ডে = সেকেন্ডে ~৬.৭ লাখ request, প্রায় সবগুলোর উত্তর "না"। ভুল ২।
- _"Follow-up ৪ এর পরে: 'তাহলে পুরো নকশা নতুন করে করি।'"_ — বিচার আর যোগাযোগে বড় ক্ষতি, কারণ বাকি সময় যায় পুরনো জিনিস আবার আঁকতে। ঠিক উত্তর: কোন একটা সিদ্ধান্ত ভাঙল, তার নাম, আর শুধু সেটা বদলানো।
- _"Conflict এ last write wins, কারণ timestamp দিয়ে।"_ — ভুল ৯ আর 6.4: দুটো device এর ঘড়ি আলাদা, আর এক জনের কাজ চুপচাপ হারায়। Push-back এ এটা ধরা পড়ে।
- _"Dedupe সবার মধ্যে, কারণ সবচেয়ে বেশি সাশ্রয়।"_ — Follow-up ৭ এর আগে এটা যুক্তিসঙ্গত। ভুল হয় follow-up ৭ এর পরেও না বদলালে (ভুল ১০)।

**নিজের feedback লেখো,** 12.3 এর মতো, তৃতীয় পুরুষে। এবার একটা বাড়তি লাইন: "Requirement বদলের পরে candidate …" — তুমি কীভাবে খাপ খাইয়েছ, `mm:ss` সহ।

> **Trade-off Table — file sync এর বড় সিদ্ধান্ত**

| সিদ্ধান্ত    | বেছে নিলাম                                 | বিকল্প                         | কী দিলাম                        | কী পেলাম                                                                   |
| ------------ | ------------------------------------------ | ------------------------------ | ------------------------------- | -------------------------------------------------------------------------- |
| Bytes এর পথ  | Client → presigned URL → object storage    | Client → API server → storage  | URL বানানো আর মেয়াদের ব্যবস্থা | ~২৫ Gbps app server এর বাইরে                                               |
| File এর গঠন  | Content-defined chunking, hash ই নাম       | পুরো file, বা fixed-size block | Hash এর CPU, অসমান block        | বদল আর ঢোকানো দুটোতেই শুধু কাছের block পাঠানো; resume আর dedupe বিনামূল্যে |
| Commit       | Block আগে, তারপর metadata এক transaction এ | একসাথে, বা metadata আগে        | একটা বাড়তি round trip          | অর্ধেক file কখনো দৃশ্যমান না                                               |
| Sync এর পথ   | "দেখো" এর খবর + cursor থেকে pull           | Polling, বা খবরে পুরো data     | একটা gateway আর long-poll       | Polling এর ~৬.৭ লাখ/s বাঁচল; হারানো খবরে ক্ষতি নেই                         |
| Shard এর একক | Namespace                                  | user_id                        | একটা বাড়তি ধারণা (mount)       | Shared folder এ কোনো copy নেই; migration এ data সরাতে হয় না               |
| Conflict     | Base revision + conflicted copy            | Last write wins / vector clock | মাঝে মাঝে একটা বাড়তি file      | কাজ কখনো হারায় না; ঘড়ির উপর নির্ভরতা নেই                                 |
| Dedupe       | Namespace এর ভেতরে                         | সব user এর মধ্যে               | User দের মধ্যের সাশ্রয়         | Dedupe side channel বন্ধ                                                   |

---

## ২. Interview Angle

এই mock এর দুটো নতুন কৌশল, যা interviewer রা ইচ্ছা করে ব্যবহার করে:

- **Requirement বদল।** "এখন share লাগবে", "এখন দশ গুণ", "এখন অন্য দেশে"। Interviewer দেখে তিনটা জিনিস: তুমি কি বলতে পারো ঠিক কোন সিদ্ধান্ত ভাঙল (নাম ধরে), তুমি কি বাকি নকশা বাঁচিয়ে রাখো, আর তুমি কি শান্ত থাকো। সবচেয়ে ভালো উত্তর প্রায়ই এমন একটা পথ খোঁজে যেখানে পুরনো data সরাতে হয় না (আজকের "user এর root = একটা namespace")।
- **Push-back।** "যদি জেতাও, কেউ কাজ হারায়; যদি দুটো রাখো, বিশৃঙ্খলা।" দুটো বিকল্পই খারাপ শোনানো হয়, যাতে দেখা যায় তুমি একটা বেছে **দাম মেনে নিতে** পারো কিনা, নাকি দুটোর মাঝে দোলো। ভালো উত্তরের আকৃতি: বাছো, কেন (কোন ভুল ফেরানো যায় আর কোনটা যায় না), দামটা মাপো, দামটা কমাও।
- **Mid-level বনাম senior:** mid-level এ bytes/metadata আলাদা করা, block এ ভাগ, আর conflict এ কিছু না হারানো যথেষ্ট। Senior এ interviewer খোঁজে: commit এর atomicity, insert এর chunking সমস্যা, shard এর একক কেন namespace, আর dedupe এর ফাঁসের মতো একটা অপ্রত্যাশিত দিক।

**Production এ বাস্তবে:** file sync এর সবচেয়ে কঠিন অংশগুলো server এ না, **client** এ: একটা folder এর হাজার হাজার file এর বদল দেখা (OS এর file watcher এর সীমা), file টা যখন অন্য program এখনও লিখছে তখন hash না করা, case-insensitive আর case-sensitive file system এর পার্থক্য, আর একটা খারাপ client release যা হাজার হাজার device এ একসাথে ভুল sync চালায়। শেষেরটার জন্য server এর দিকে একটা সুরক্ষা লাগে: হঠাৎ একটা device থেকে অস্বাভাবিক সংখ্যক মোছা এলে থামানো আর মানুষকে জিজ্ঞেস করা। Interview এ এর যেকোনো একটা নিজে থেকে তোলা একটা শক্ত senior signal।

---

## ৩. Key Takeaway

- **Requirement বদলে নকশা ফেলে দিও না:** ভাঙা সিদ্ধান্তের নাম বলো (এখানে shard key), শুধু সেটা বদলাও, আর data না সরিয়ে বদলানোর পথ খোঁজো (user এর root = একটা namespace)
- **Push-back এ বাছো আর দাম মেনে নাও:** যে ভুল ফেরানো যায় না (কাজ হারানো) তার চেয়ে যে দাম ফেরানো যায় (একটা বাড়তি file) ভালো; তারপর দামটা মাপো আর কমাও
- **File sync এ bytes আর metadata দুটো আলাদা জগৎ:** ১০০ PB আর ~২৫ Gbps এর bytes presigned URL এ সরাসরি object storage এ; ২৫ TB আর ৭,০০০ commit/s এর metadata shard করা journal এ
- **Content hash এর block:** শুধু বদলানো block যায়, resume আর dedupe বিনামূল্যে; কিন্তু fixed-size block এ শুরুতে এক byte ঢোকালে পুরো file — content-defined chunking
- **Commit atomic, block আগে:** অর্ধেক file কখনো দেখা যায় না; commit না হওয়া block garbage collection এ, reference count এ না, mark-and-sweep এ
- **এক জায়গায় ক্রম থাকলে vector clock লাগে না:** namespace এর server ক্রম ঠিক করে, base revision এর তুলনা concurrent edit ধরে; conflict এ conflicted copy, কিছু হারায় না
- **Dedupe এর একটা নিরাপত্তার দাম আছে:** "আগেই আছে" এর signal অন্যের file এর অস্তিত্ব ফাঁস করে; dedupe namespace এর ভেতরে

---

## ৪. নতুন Term (Glossary)

| Term                         | অর্থ                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content-Addressed Block**  | File এর টুকরো, যার নাম তার content এর hash — একই content একবার রাখা আর পাঠানো, নামই content এর প্রমাণ; file মানে hash এর তালিকা                             |
| **Content-Defined Chunking** | Block এর সীমানা নির্দিষ্ট দূরত্বে না, content দেখে (rolling hash এর একটা pattern এ) — মাঝে byte ঢোকালেও শুধু কাছের block বদলায়, বাকিগুলোর hash একই থাকে    |
| **Change Journal**           | প্রতি namespace এর সব বদলের append-only তালিকা, বাড়তে থাকা `seq` সহ — device cursor রাখে আর "এর পরে কী?" জিজ্ঞেস করে; হারানো আর দুবার পাওয়া সহজে ধরা পড়ে |
| **Namespace**                | File এর একটা স্বাধীন গাছ (user এর root, বা shared folder), নিজের journal আর `seq` সহ, sharding এর একক; user এর দৃশ্য = কয়েকটা namespace এর mount           |
| **Conflicted Copy**          | দুটো concurrent edit এর হেরে যাওয়াটা আলাদা নামে পাশে রাখা — কিছু হারায় না, মেলানোর ভার মানুষের; 6.4 এর sibling এর file sync রূপ                           |
| **Dedupe Side Channel**      | "Block আগেই আছে" এর তাৎক্ষণিক উত্তর থেকে অন্যের কাছে একটা file আছে কিনা জানা — dedupe কে namespace এর ভেতরে রাখা, বা সবসময় bytes নেওয়া এর ওষুধ            |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবো। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলো।

1. একজন user এর phone এ ২০০ GB এর একটা folder, কিন্তু phone এ জায়গা ৩০ GB। (ক) Phone এর client desktop এর থেকে কোথায় আলাদা আচরণ করবে? (খ) User একটা ৪ GB এর video খুলল, mobile data তে। কী নামাবে, কখন? (গ) Phone এ offline এ একটা file edit হলো, তারপর phone টা হারিয়ে গেল। কী হারাল, আর নকশার কোন অংশ এটাকে কম করতে পারত?

2. Follow-up ৪ এর পরে interviewer আরেক ধাপ এগোল: "একটা বড় company র পুরো file server আমাদের কাছে: একটা namespace এ ২ কোটি file, ৫০,০০০ member।" (ক) এক namespace = এক shard এর নকশায় কী ভাঙে, সংখ্যা সহ? (খ) এক namespace এর একটা journal এর মূল সুবিধাটা (একটা ক্রম) রেখে এটাকে কীভাবে ভাগ করবে, আর কী হারাবে?

3. এক candidate এর follow-up ৪ এর উত্তর: _"ঠিক আছে, share লাগলে প্রতিটা member এর shard এ file এর একটা copy রাখব, আর একটা background job সবগুলো sync রাখবে। কোনো সমস্যা হলে job টা আবার চালাব।"_ (ক) বিচারের মাত্রায় ১-৪ এর কত দেবে, আর কেন? (খ) "দুজন member একই মুহূর্তে একই file edit করল" — এই নকশায় কী হয়? (গ) এই উত্তরের কোন অংশটা বাঁচানো যায়?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) Phone এর client **metadata পুরো sync করে, bytes না**: পুরো গাছ দেখায় (নাম, আকার, thumbnail), কিন্তু file নামায় শুধু খুললে, বা user "offline এ রাখো" চিহ্ন দিলে। নামানো file গুলো একটা সীমিত cache এ, জায়গা কম পড়লে সবচেয়ে পুরনো খোলা টা আগে বাদ (4.3 এর LRU)। Desktop এ উল্টো: সব নামানো, কারণ folder টা OS এর একটা আসল folder। আর notification এ phone শুধু metadata update করে (follow-up ২), battery আর data বাঁচাতে, অনেক বদল একসাথে জমিয়ে।

(খ) ৪ GB পুরোটা আগে নামানো না: video এর জন্য শুধু দেখার জায়গার block গুলো, যতটুকু দেখা হচ্ছে তার একটু আগে পর্যন্ত (range এ নামানো, block এর তালিকা থেকে কোন block কোন offset এ জানা থাকে)। আরও ভালো: server এ একটা কম bitrate এর preview (11.6 এর transcoding), mobile data তে সেটাই। User কে জিজ্ঞেস করা "Wi-Fi এ পুরোটা নামাব?"। Data এর খরচ user এর, তাই default সংযমী।

(গ) Phone এ offline এর edit যতক্ষণ commit হয়নি, ততক্ষণ শুধু phone এ। Phone হারালে সেই edit হারাল, আর কিছু না (server এর সব version ঠিক আছে)। কম করার উপায়: online হলেই সাথে সাথে commit (দেরি না করে), আর বড় edit এর মাঝে মাঝে block গুলো আগেই upload করে রাখা (commit ছাড়া, follow-up ৩ এর মতো), যাতে online হওয়ার মুহূর্তে শুধু commit বাকি থাকে। কিন্তু offline এর edit এর একটা জানালা থাকবেই, আর সেটা জোরে বলা সৎ উত্তর।

**প্রশ্ন ২:**

(ক) ২ কোটি file × ~৫০০ B = ~১০ GB শুধু বর্তমান অবস্থা, সাথে version আর journal — একটা shard এর জন্য বড়, তবে অসম্ভব না। আসল সমস্যা লেখা আর খবর: ৫০,০০০ member × দিনে ২০ বদল = দিনে ১০ লাখ, অফিসের ৮ ঘণ্টায় সেকেন্ডে ~৩৫টা commit, peak এ ~৭০ — একটা shard এ সম্ভব, কিন্তু সব একটা journal এ, একটা ক্রমে, মানে একটা primary এর একটা row-ক্রম এর সীমা আর lock এর লাইন। আর খবর: ৫০,০০০ জনকে প্রতিটা বদলের পরে, coalesce করেও সেকেন্ডে হাজার হাজার। আর একটা নতুন device এর প্রথম sync: ২ কোটি entry এর journal শুরু থেকে পড়া অসম্ভব — একটা snapshot (বর্তমান অবস্থা) থেকে শুরু, তারপর journal।

(খ) Namespace কে তার ভেতরের sub-folder ধরে কয়েকটা ভাগে (sub-namespace) ভাঙা, প্রতিটার নিজের journal আর `seq`, আর ভাগগুলো আলাদা shard এ। একটা ভাগের ভেতরে ক্রম ঠিক থাকে। হারায়: **ভাগ পেরিয়ে** ক্রম আর atomicity — একটা folder এক ভাগ থেকে আরেক ভাগে সরানো এখন দুটো journal এ দুটো লেখা, তাই দুটো ধাপে (একটা ছোট saga, 9.3), আর মাঝের মুহূর্তে কেউ হয়তো দুটো জায়গাতেই, বা কোথাও না দেখে। সৎ উত্তর: এটা বিরল একটা কাজকে কঠিন করে বাকি সবকিছু সম্ভব রাখে, আর client কে বেশ কয়েকটা cursor রাখতে হয়।

**প্রশ্ন ৩:**

(ক) **১, বড়জোর ২।** "Background job sync রাখবে" একটা mechanism না, একটা আশা, আর "আবার চালাব" মানে কোনো সঠিকতার নিশ্চয়তা নেই। সাথে প্রতিটা edit এ ৫,০০০টা লেখার দাম গোনা হয়নি (12.1 এর ভুল ২ আর ৯)।

(খ) দুজন দুটো আলাদা shard এ নিজের copy তে লেখে, প্রত্যেকে সফল। Job এখন দুটো ভিন্ন version দেখে ৫,০০০টা copy এর মধ্যে, আর কোনটা "ঠিক" সেটা জানার কোনো একক ক্রম নেই — ঘড়ি দিয়ে বাছলে 6.4 এর সমস্যা, আর কেউ একজন কাজ হারায়। এর মাঝে বাকি ৪,৯৯৮ জনের কেউ কেউ একটা version দেখে, কেউ আরেকটা। এটাই spaced repetition এর প্রশ্নের উল্টো দিক: ক্রমের একটা একক জায়গা না থাকলে vector clock আর sibling লাগে, আর এই নকশায় সেটার কোনো ব্যবস্থা নেই।

(গ) "প্রতিটা member এর দৃশ্যে folder টা দেখা যায়" — এই লক্ষ্যটা ঠিক। বাঁচানো যায় এভাবে: copy এর বদলে **reference** — প্রতিটা member এর গাছে একটা mount (একটা ছোট row), আর file নিজে একটা জায়গায়, একটা ক্রমে। এক বাক্যে: "copy না, একটা namespace আর ৫,০০০টা mount।"

</details>

---

## ৬. Practical Exercise

**Tier 3 — Design Exercise** (mock interview; code নেই। Deliverable হলো recording, score, 12.3 এর সাথে তুলনা, আর feedback)

> **Task:**
>
> 1. **Mock টা করো,** ১.১ এর নিয়মে, ৫০ মিনিট, জোরে, recording সহ। Push-back এর অংশ শুধু নিজের প্রথম উত্তরের পরে।
> 2. **Score করো,** পরের দিন: পাঁচটা মাত্রা, `mm:ss` সহ; দশটা ভুলের checklist; আর ১.৪ এর 12.3 বনাম 12.4 এর টেবিল।
> 3. **Follow-up ৪ এর অংশটা আলাদা করে শোনো,** আর তিনটা প্রশ্নের উত্তর লেখো: (ক) কত সেকেন্ড পরে তুমি নাম ধরে বলেছিলে কোন সিদ্ধান্ত ভাঙল? (খ) পুরনো নকশার কত ভাগ টিকে গেল? (গ) তুমি কি data সরানোর একটা পথ বলেছিলে, নাকি সেটা এড়িয়ে গেছ?
> 4. **Push-back দুটোর জন্য:** তোমার প্রথম উত্তর আর push-back এর পরের উত্তর পাশাপাশি লেখো। তুমি কি অবস্থান বদলেছ, ধরে রেখেছ, নাকি দুটোর মাঝে দুলেছ? দুলে থাকলে, এখন এক বাক্যে বাছো আর দামটা বলো।
> 5. **Feedback,** তৃতীয় পুরুষে, "Requirement বদলের পরে candidate …" এর লাইন সহ।
> 6. **দুটো mock এর পরে একটা অভ্যাস বাছো:** 12.3 আর 12.4 দুটোতেই যে ভুলটা এসেছে, সেটা। পরের এক সপ্তাহ প্রতিদিন ১০ মিনিট শুধু সেটার অনুশীলন (যেমন: ভুল ২ হলে প্রতিদিন তিনটা 12.2 এর মতো drill, প্রতিটার শেষে জোরে "তাই"; ভুল ১০ হলে প্রতিদিন একটা পুরনো case study এর deep dive জোরে, recording সহ)।
>
> **বন্ধুর সাথে:** এবার বন্ধুকে আরেকটা ক্ষমতা দাও: যেকোনো একটা মুহূর্তে, script এর বাইরে, একটা "কেন?" বা "সংখ্যাটা কত?" বলার। Script এর follow-up তুমি আগে থেকে আন্দাজ করতে পারো; একজন মানুষের এলোমেলো প্রশ্ন পারো না, আর আসল interview এ সেটাই হয়।

পুরো score, তুলনার টেবিল, follow-up ৪ এর তিনটা উত্তর, আর push-back এর দুটো জোড়া পাঠাও। আমি দেখব তোমার score এর পরিবর্তন প্রমাণের সাথে মেলে কিনা, আর follow-up ৪ এ কোথায় সময় গেছে।

**সৎ নোট:** Interviewer এর উত্তর, follow-up এর ক্রম, push-back আর rubric এর নোঙর আমার বানানো। Model answer এর সংখ্যা interview এর মতো মাথায় করা আন্দাজ: ৪ MB block, metadata আর block index এর entry প্রতি byte, ৫০% online, gateway প্রতি ২ লাখ connection (12.2 এর drill ৭ এর ধরে নেওয়া), সব ধরে নেওয়া, মাপা না। Dedupe কত বাঁচায় আর storage এর কত ভাগ ঠান্ডা, এগুলো data নির্ভর, তাই কোনো সংখ্যা দিইনি। Content-defined chunking, block-level dedupe আর dedupe এর side channel প্রকাশিত, সুপরিচিত ধারণা; কোনো নির্দিষ্ট কোম্পানি এগুলো কীভাবে করে, সেটা এখানে দাবি করা হচ্ছে না।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 – 11 (সম্পূর্ণ, exit challenge সহ), 12.1, 12.2, 12.3
Current: 12.4 — Mock Interview #2 (file sync, Dropbox এর মতো)
TaskFlow state: Module 10 এর শেষ অবস্থায় (আজ পাশে)।
Mock #2 — ১ কোটি DAU, ৫ কোটি user × ২ GB = ১০০ PB; peak ~৭,০০০ commit/s, upload ~২৫ Gbps, মাসে ~৬ PB egress, metadata
~২৫ TB, ~১ কোটি online connection (~১০০ gateway)। Bytes presigned URL এ object storage এ (content hash এর block,
content-defined chunking — fixed block এ শুরুতে এক byte ঢোকালে পুরো file); metadata namespace ধরে shard করা change journal
এ (seq, cursor)। Commit: block আগে, তারপর atomic metadata — অর্ধেক file দৃশ্যমান না। Sync: "দেখো" এর খবর + cursor থেকে
pull। Requirement বদল (shared folder, ৫,০০০ member): user_id এর shard key ভাঙে → namespace + mount, user এর root =
namespace তাই data সরাতে হয় না; notification coalesce। Conflict: base revision (vector clock লাগে না, এক জায়গায় ক্রম)
+ conflicted copy। Storage: mark-and-sweep GC, ঠান্ডা স্তর, block এর আকার (৪ MB এ index ~২.৫ TB, ৬৪ KB এ ~১৫৬ TB)।
Dedupe namespace এর ভেতরে (side channel)।
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram, Content-Addressed Block, Content-Defined Chunking, Change Journal,
Namespace, Conflicted Copy, Dedupe Side Channel
Weak spots: [তুমি যেখানে আটকেছিলে — নিজে লিখো; 12.3 আর 12.4 দুটোতেই আসা ভুলটা]
Next: 12.5 — "একটা system এর কথা বলো যেটা তুমি design করেছ"
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **একটা ভালো নকশা না, একটা ভালো নকশা বদলানোর ক্ষমতা দেখানো হয়।** Interviewer জানে শুরুর shard key টা পরে ভুল প্রমাণ হবে, কারণ সে নিজেই requirement বদলাবে। দেখার জিনিস ঠিক সেই মুহূর্ত: নাম ধরে কোন সিদ্ধান্ত ভাঙল, বাকিটা কতটা টিকল, আর data না সরিয়ে বদলানোর পথ আছে কিনা। আর push-back এ দুটো খারাপ বিকল্পের মধ্যে একটা বেছে দাম মেনে নেওয়া।

রেডি হলে `next` লিখো — **Lesson 12.5: "একটা system এর কথা বলো যেটা তুমি design করেছ।"** প্রায় প্রতিটা system design loop এ এই প্রশ্নটা কোথাও আসে, কখনো আলাদা একটা round হিসেবে। এখানে কোনো অজানা system নেই: system টা তোমার নিজের, তাই প্রশ্নটা সহজ শোনায়, আর সেজন্যই মানুষ প্রস্তুতি নেয় না। 12.5 এ দেখব এই প্রশ্নে আসলে কী মাপা হয় (তোমার ভূমিকা, তোমার সিদ্ধান্ত, আর কী ভুল হয়েছিল), কীভাবে একটা বাস্তব project কে পাঁচ মিনিটের একটা গল্পে সাজাতে হয়, আর follow-up এর গভীর প্রশ্নে কীভাবে সৎ থাকতে হয় যখন সিদ্ধান্তটা তোমার ছিল না। আর যার এখনও বলার মতো বড় project নেই, তার জন্য একটা পথ: TaskFlow, এই course এর এগারো module, সেটাই তোমার system।
