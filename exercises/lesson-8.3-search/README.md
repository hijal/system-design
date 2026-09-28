# TaskFlow Search Lab — LIKE, Trigram, Full-text, আর নিজের Inverted Index

> Lesson 8.3 — Search & Inverted Index · **Tier 1 — Runnable Code** (Docker এ Postgres; আর memory তে একটা নিজের বানানো inverted index)

## কী বানাচ্ছি

TaskFlow এর ১০ লাখ comment এ খোঁজা — তিনটা script:

| Script             | প্রশ্ন                                                                                                                                                   | Lesson §  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run seed`     | ১০ লাখ comment Postgres এ — একটা নির্দিষ্ট সূত্রে, তাই comment নম্বর i এর text সবসময় একই                                                                | —         |
| `npm run like`     | চার উপায়: index ছাড়া `ILIKE '%…%'`, B-tree, `pg_trgm` এর GIN, full-text search (tsvector + GIN + `ts_rank`); শব্দ বনাম substring; লেখার দাম; ভুল বানান | ১.১ – ১.৪ |
| `npm run inverted` | একটা inverted index নিজের হাতে — analyzer, posting list, পুরো scan বনাম index, দুটো শব্দ মেলানোর দুই উপায়, BM25 দিয়ে সাজানো                            | ১.৫ – ১.৬ |

**সৎ নোট:**

- Comment গুলো বানানো: ৩৫% ছোট সাধারণ শব্দ (the, to …), ১৫% TaskFlow এর কাজের শব্দ (deploy, invoice, bug …), বাকিটা
  ৫০০০টা বানানো শব্দ Zipf বণ্টনে। আসল লেখার চেয়ে অনেক নিয়মিত — **আকৃতি** আসল (কোন উপায়ে কী পড়া হয়, কী মেলে), অনুপাত
  না। কয়েকটা শব্দ ইচ্ছা করে রাখা (redeploy, login/blog/catalog, start/party/article/smart) — substring এর ভুল দেখাতে।
- `like` আসল database, আসল সময় — Postgres `cpus: 2`; সংখ্যা মেশিন ভেদে বদলাবে। প্রতিটা query তিনবার, মাঝেরটা।
  `like` শুরুতে `VACUUM FULL` চালায় — আগের run এর `tsv` column এর জায়গা ফেরত আনতে, যাতে প্রতিটা run একই table দিয়ে শুরু হয়।
- "সব deploy গোনা" তে দুই section এর সময়ের পার্থক্য (৩৯০ বনাম ১৭৫ ms) index এর না — দুই ক্ষেত্রেই planner পুরো table
  পড়ে (plan এ `Gather`), কারণ "deploy" ২৮% row এ আছে; পার্থক্যটা cache এর। Index এর প্রভাব দেখো বিরল শব্দের সারিতে।
- `inverted` এর analyzer একটা খেলনা — stopword এর তালিকা ছোট, stemmer টা Porter এর কয়েকটা নিয়মের নকল। Elasticsearch/Lucene
  বা Postgres এর `english` config এর নিয়ম অনেক বেশি। Index টা memory তে, একটা process এ — কোনো persistence, update, বা
  shard নেই।
- যাচাই করা হয়েছে Postgres 17 এ।

## Prerequisite

Node.js 22+, Docker (Postgres এর জন্য; `inverted` এ Docker লাগে না)।

## Setup

```bash
docker compose up -d --wait
npm install
npm run seed        # ~৫ সেকেন্ড
```

## Run

```bash
npm run like        # ~১ মিনিট (তিনটা index বানানো সহ)
npm run inverted    # ~৫ সেকেন্ড
```

Teardown:

```bash
docker compose down -v
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run like` (এই মেশিনে):

```
── ক. index ছাড়া: ILIKE '%…%' ─────────────────────────────── সময়       পাওয়া গেল
   সব "deploy" গোনা                               390.4 ms    281,022 টা
   সব "rollback" গোনা (বিরল শব্দ)                 409.3 ms      9,117 টা
   প্রথম ২০টা "deploy" (সাধারণ শব্দ)                0.5 ms         20 টা
   প্রথম ২০টা "rollback" (বিরল শব্দ)                2.7 ms         20 টা
   প্রথম ২০টা "recieve" (ভুল বানান — কিছুই নেই)   398.0 ms          0 টা
   plan, সব "deploy" (২৮% row এ আছে): Aggregate ← Gather · 15,584 page
   plan, সব "rollback" (বিরল):     Aggregate ← Gather · 15,584 page

── খ. B-tree index, lower(body) text_pattern_ops (বানাতে 1.07 s, 113 MB) ──
   lower(body) LIKE '%deploy%' → Aggregate ← Gather · 15,584 page
   lower(body) LIKE 'deploy%'  → Aggregate ← Bitmap Heap Scan · 11,678 page   ← শুধু "deploy দিয়ে শুরু"

── গ. pg_trgm GIN index (বানাতে 12.35 s, 81 MB) ──── সময়       পাওয়া গেল
   সব "deploy" গোনা                               174.8 ms    281,022 টা
   সব "rollback" গোনা (বিরল শব্দ)                  14.2 ms      9,117 টা
   প্রথম ২০টা "deploy" (সাধারণ শব্দ)                0.5 ms         20 টা
   প্রথম ২০টা "rollback" (বিরল শব্দ)                1.9 ms         20 টা
   প্রথম ২০টা "recieve" (ভুল বানান — কিছুই নেই)     0.5 ms          0 টা
   plan, সব "deploy" (২৮% row এ আছে): Aggregate ← Gather · 15,840 page
   plan, সব "rollback" (বিরল):     Aggregate ← Bitmap Heap Scan · 6,995 page

── ঘ. Full-text search: tsvector + GIN (column আর index বানাতে 11.56 s, index 25 MB, table এখন 264 MB) ──
   সব "deploy" গোনা                               102.0 ms    267,943 টা
   "deploy checklist" (দুটোই আছে)                  18.2 ms     20,293 টা
   সেরা ২০টা "deploy checklist", ts_rank দিয়ে সাজানো    23.4 ms         20 টা
   "recieve" (ভুল বানান)                            0.4 ms          0 টা

── শব্দ বনাম substring: কী মেলে ──
   ILIKE '%deploy%': 281,022 (redeploy সহ) · full-text "deploy": 267,943 (deployment, deploying সহ, redeploy বাদ — আলাদা শব্দ, 18,319 টা)
   ILIKE '%art%': 175,420 (start, party, article, smart …) · full-text "art": 9,104
   ILIKE '%log%': 105,336 (login, blog, catalog) · full-text "log": 0

── লেখার দাম: নতুন 20,000 টা comment insert (১০০০ করে) ──
   শুধু primary key       114.9 ms   1.0 গুণ
   + trigram GIN          541.8 ms   4.7 গুণ
   + full-text GIN        321.5 ms   2.8 গুণ

── ভুল বানান: শব্দের তালিকায় trigram এর মিল ("did you mean") ──
   "recieve" → receive (0.33)
   "deplyo" → deploy (0.40), deploying (0.31)
   "chekclist" → checklist (0.43)
```

মিলতে হবে: index ছাড়া "গোনা" আর "কিছুই নেই" পুরো table পড়ে (কয়েকশো ms), B-tree শুধু prefix এ কাজে লাগে, trigram বিরল
শব্দে আর "কিছুই নেই" তে দশ গুণের বেশি দ্রুত, full-text এ "deploy checklist" কয়েক দশ ms; শব্দ বনাম substring এর গোনা
একই; index এ লেখা কয়েক গুণ ধীর।

`npm run inverted`:

```
── ১. Index বানানো: 200,000 টা comment ──
   সময় 1181.2 ms · আলাদা term 5,030 · posting 1,879,748 (~14 MB, id + tf)
   বাদ পড়া stopword: 1,083,698 / 3,098,532 শব্দ (35%) — রাখলে প্রতিটার list বিশাল, কত ভাগ document এ: the 24%, a 24%, to 24%
   সবচেয়ে লম্বা posting list: kax 112,242 · lox 68,330 · deploy 53,634 · mix 48,866 · rax 37,970

── ২. "deploy checklist" — দুটো শব্দই আছে এমন comment ──
   পুরো scan, substring (LIKE এর মতো)           16.2 ms   4,301 টা
   পুরো scan, একই analyzer দিয়ে               430.4 ms   4,129 টা
   inverted index (দুটো posting list মেলানো)     1.4 ms   4,129 টা

── ৩. "kax AND rollback" — একটা খুব সাধারণ (112,242 টা doc), একটা বিরল (1,785 টা) ──
   দুটো list পাশাপাশি হাঁটা (merge)              0.7 ms   তুলনা   112,808   ফল 1037
   ছোট list থেকে শুরু, বড়টায় binary search       0.4 ms   তুলনা    29,087   ফল 1037

── ৪. "deploy checklist" এর সেরা ৩টা — BM25 দিয়ে সাজানো ──
   #25628 score 5.99 · 10 টা term · "Dalox kax checklist release deploy mirax of can bax checklist it this to a deplo…"
   #6142 score 5.91 · 2 টা term · "Deploy to on checklist and is in."
   #44060 score 5.91 · 2 টা term · "To checklist deploy after can a."
   IDF (যত বিরল, তত ভারী): deploy 1.32 · checklist 2.66 · rollback 4.72 · kax 0.58
```

`inverted` এর সময় ছাড়া সব সংখ্যা প্রতিবার হুবহু একই।

## কী দেখার জন্য এটা বানানো

- **"প্রথম ২০টা" এর ফাঁদ:** index ছাড়াও সাধারণ শব্দের প্রথম ২০টা দ্রুত (০.৫ ms) — Postgres প্রথম কয়েকশো row এর মধ্যেই ২০টা পেয়ে
  থামে। Test এ সব ঠিক দেখায়। কিন্তু যে শব্দ নেই (ভুল বানান) — পুরো table, প্রতিবার। আর user রা ঠিক সেটাই বেশি খোঁজে যেটা
  খুঁজে পায় না।
- **B-tree:** `'%deploy%'` এ কাজে লাগে না — B-tree সাজানো ক্রমে থাকে, আর মাঝের একটা অংশ দিয়ে সাজানো ক্রমে খোঁজা যায় না
  (Lesson 5.4 এর composite index এর বাঁ দিকের নিয়মের মতো)। কাজে লাগে শুধু "দিয়ে শুরু" তে।
- **শব্দ বনাম substring:** `ILIKE '%art%'` এর ১,৭৫,৪২০টার বেশিরভাগ "art" না — start, party, article। Full-text শব্দ ধরে
  খোঁজে, আর "deploying", "deployment" কে "deploy" এর সাথে মেলায় (stemming)।
- **নিজের index এর ৩ নম্বর:** একই উত্তর, চার ভাগের এক ভাগ তুলনায় — বিরল শব্দ থেকে শুরু করলে বিশাল list এর বেশিরভাগ ছুঁতেই হয় না।
- **BM25 এর দ্বিতীয় আর তৃতীয়:** মাত্র ২টা term এর comment — দুটো শব্দই আছে আর আর কিছু প্রায় নেই, তাই উঁচুতে। প্রথমটা লম্বা,
  কিন্তু checklist দুবার আর deploy দুবার (tf)।

## নিজে ভেঙে দেখো (Experiments)

1. **Index এর আকার বনাম table:** `like` এর শেষে table ১২২ MB থেকে ২৬৪ MB — কেন? (`tsv` column টা stored।) Column ছাড়া
   expression index — `CREATE INDEX ON comments USING gin (to_tsvector('english', body))` — বানিয়ে আকার আর "deploy checklist"
   এর সময় মেলাও। Query তে কী বদলাতে হয় যাতে index টা ব্যবহার হয়? (এই মেশিনে: expression index ২৫ MB, বানাতে ১০ s, "deploy
   checklist" ~৪০–৫৫ ms বনাম stored column এ ~৪৭ ms — আর table ১২২ MB ই থাকে; দাম: প্রতিটা মেলানো row এ `to_tsvector` আবার
   গোনা, আর query তে হুবহু একই expression লিখতে হয়।)
2. **`ts_rank` এ IDF নেই:** `like.ts` এর সেরা ৩টা দেখো, আর `inverted` এর BM25 এর সেরা ৩টা। Postgres এর `ts_rank` শব্দ কত বার
   আর কত কাছাকাছি সেটা দেখে, কিন্তু পুরো corpus এ শব্দটা কত বিরল (IDF) সেটা দেখে না। "kax deploy" (খুব সাধারণ + সাধারণ) দিয়ে
   দুটোই চালিয়ে দেখো — সাজানো কীভাবে আলাদা হয়?
3. **Stopword রাখলে:** `inverted.ts` এ `STOP` খালি করে দাও (`new Set<string>()`)। Posting এর মোট সংখ্যা আর index এর আকার কত বাড়ল?
   "the deploy" খুঁজলে intersection এ কী হয়?
4. **বড় হলে:** `DOCS=1000000 npm run inverted` — প্রতিটা সময় কত গুণ বাড়ল? পুরো scan আর index এর অনুপাত কি একই থাকল? (এই
   মেশিনে: বানাতে ৫.২ s, posting ৯৪ লাখ (~৭২ MB); substring scan ৭১.৫ ms, analyzer সহ scan ২০৩০ ms, index ৪.৬ ms — আর index এর
   ফল ২০,২৯৩, হুবহু `like` এ Postgres এর full-text এর "deploy checklist" এর সমান।)
5. **ভুল বানানের সীমা:** `like.ts` এর শেষে `pg_trgm.similarity_threshold` কমিয়ে (`SET pg_trgm.similarity_threshold = 0.2`)
   "recieve" আবার খোঁজো। কী কী এলো? খুব ছোট শব্দে (যেমন "bgu" → "bug") trigram কেন দুর্বল?

## Project Structure

```
lesson-8.3-search/
├── docker-compose.yml   # Postgres 17 (5446), cpus: 2
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── data.ts          # comment এর সূত্র (একই i → একই text), শব্দের তালিকা, Postgres pool
    ├── seed.ts          # ১০ লাখ comment Postgres এ
    ├── like.ts          # ILIKE, B-tree, trigram, full-text, লেখার দাম, ভুল বানান
    └── inverted.ts      # নিজের inverted index: analyzer, posting list, intersection, BM25
```

সব env: `ROWS` (1000000, seed), `WRITE_ROWS` (20000, like), `DOCS` (200000, inverted), `DATABASE_URL`।
