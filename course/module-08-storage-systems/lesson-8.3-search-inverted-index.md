# Lesson 8.3 - Search & Inverted Index: কেন LIKE %x% Scale করে না

**Module 8 - Storage Systems**

> **Spaced Repetition (Lesson 5.4):** `(project_id, occurred_at)` এর একটা composite B-tree index `WHERE occurred_at > …` এ (project_id ছাড়া) কেন কাজে লাগে না? এক লাইনে - B-tree ভেতরে কীভাবে সাজানো থাকে সেটা দিয়ে। আজ একই কারণে `LIKE '%deploy%'` ও index পাবে না।

**Prerequisite:** Lesson 5.3 (LSM-tree), Lesson 5.4 (B-tree, composite index), Lesson 5.8 (Sharding, scatter-gather), Lesson 6.3 (Read-your-writes), Lesson 7.4 (Idempotent consumer), Lesson 7.5 (Outbox, CDC), Lesson 8.2 (`attachment.uploaded` event)

**আপনি এই lesson শেষে পারবেন:**

1. কেন `LIKE '%x%'` বড় table এ ধীর - আর কখন সেটা লুকিয়ে থাকে (`LIMIT` এর ফাঁদ) - মাপা সংখ্যা দিয়ে বলতে পারবেন; trigram index কী সারায় আর কী সারায় না, বলতে পারবেন
2. একটা inverted index কীভাবে বানানো হয় (analyzer, posting list) আর খোঁজা হয় (posting list মেলানো, BM25 দিয়ে সাজানো) - whiteboard এ আঁকতে পারবেন
3. TaskFlow এর search এর জন্য Postgres এর full-text search আর একটা আলাদা search engine (Elasticsearch/OpenSearch) এর মধ্যে বাছতে পারবেন - আর আলাদা engine হলে তাকে database এর সাথে sync রাখা, permission, আর "লিখলাম কিন্তু খুঁজে পাচ্ছি না" সামলানোর design করতে পারবেন

**Tier:** 1 - Runnable Code (Docker এ Postgres, ১০ লাখ comment; আর memory তে একটা নিজের হাতে বানানো inverted index)

---

## ০. TaskFlow এখন কোথায়

TaskFlow এর search box প্রথম দিন থেকেই আছে, আর তার code এক লাইনের:

```typescript
const results = await Comment.findAll({
	where: { workspaceId, body: { [Op.iLike]: `%${q}%` } },
	order: [['createdAt', 'DESC']],
	limit: 20
});
```

১০০ user এর দিনে এটা নিখুঁত ছিল। এখন comment ১০ লাখের বেশি, আর তিনটা অভিযোগ একসাথে:

1. **ধীর - কিন্তু সবসময় না।** Engineer রা test করে ("deploy" খুঁজে) - ১ ms। অথচ monitoring বলছে search এর p99 ৪০০ ms, আর যখন অনেকে একসাথে খোঁজে, database এর CPU ভরে যায়। সবচেয়ে ধীর search গুলোর একটা মিল আছে: তাদের কোনো ফল নেই। আর frontend প্রতিটা অক্ষর চাপার সাথে সাথে search পাঠায়।
2. **ভুল ফল।** একজন "art" খুঁজল (একটা design এর কাজ) - প্রথম পাতা ভর্তি "start", "party", "smart"। আরেকজন "deploying" খুঁজল - "deploy" লেখা comment গুলো আসেনি। আর ফলাফল সবসময় নতুন থেকে পুরনো - সবচেয়ে প্রাসঙ্গিকটা পাঁচ পাতা পরে।
3. **নতুন চাওয়া।** Product চায় ভুল বানানে খোঁজা ("recieve" লিখলে "receive"), task এর title আর attachment এর নাম একসাথে খোঁজা (8.2 এর `attachment.uploaded` event এর একটা consumer), আর project দিয়ে filter।

আজকের প্রশ্ন: এই এক লাইন কোথায় ভাঙে, database একটা search engine হতে কী লাগে, আর কখন database যথেষ্ট না।

---

## ১. Theory

### ১.১ `LIKE '%x%'` - কেন পুরো table, আর কখন সেটা লুকিয়ে থাকে

Exercise এর `npm run like`, ১০ লাখ comment, index ছাড়া:

```
── A. no index: ILIKE '%…%' ───────────────────────── time       found
   count all "deploy"                             390.4 ms    281,022
   count all "rollback" (rare word)               409.3 ms      9,117
   first 20 "deploy" (common word)                  0.5 ms         20
   first 20 "rollback" (rare word)                  2.7 ms         20
   first 20 "recieve" (misspelled - none exist)   398.0 ms          0
   plan, all "deploy" (in 28% of rows): Aggregate ← Gather · 15,584 pages
```

"গোনা" পুরো table পড়ে - ১৫,৫৮৪টা page, প্রতিটা row এর text এ অক্ষর ধরে খোঁজা। কিন্তু দেখুন মাঝের সারি দুটো: "প্রথম ২০টা deploy" **০.৫ ms**। কারণ Postgres সামনে থেকে পড়া শুরু করে, আর "deploy" এত সাধারণ যে প্রথম কয়েকশো row এর মধ্যেই ২০টা পেয়ে থামে।

এটাই ঘটনা ১ এর ফাঁদ। Engineer এর test এ সাধারণ শব্দ - দ্রুত। User এর আসল search এর বড় অংশ বিরল শব্দ, বা এমন কিছু যা নেই - ভুল বানান, মুছে ফেলা জিনিস। "কিছুই নেই" মানে ২০টা কখনো পাওয়া যায় না, তাই শেষ row পর্যন্ত - **৩৯৮ ms**, প্রতিবার। আর search-as-you-type এ "r", "re", "rec", "reci" … - প্রতিটা অক্ষর একটা পুরো table scan। আর Lesson 1.3 এর হিসাব: table দশ গুণ বাড়লে, এই সময়ও দশ গুণ।

**B-tree কেন কাজে আসে না - spaced repetition এর উত্তর।** B-tree এর ভেতরে মান গুলো সাজানো ক্রমে (Lesson 5.4)। "deploy দিয়ে শুরু" মানে সেই ক্রমের একটা টানা অংশ - গাছ বেয়ে সেখানে নামা যায়। কিন্তু "যেকোনো জায়গায় deploy আছে" সাজানো ক্রমের কোনো টানা অংশ না - "a deploy…", "fix the deploy…", "zzz deploy" অভিধানের ক্রমে সব জায়গায় ছড়ানো। Composite index এ বাঁ দিকের column ছাড়া খোঁজার মতোই।

```
── B. B-tree index, lower(body) text_pattern_ops (1.07 s to build, 113 MB) ──
   lower(body) LIKE '%deploy%' → Aggregate ← Gather · 15,584 pages
   lower(body) LIKE 'deploy%'  → Aggregate ← Bitmap Heap Scan · 11,678 pages   ← only "starts with deploy"
```

১১৩ MB এর index, আর `'%deploy%'` এ Postgres সেটা ছুঁয়েও দেখে না। Prefix এর জন্য সে কাজের (task এর title এর autocomplete - প্রশ্ন ১), কিন্তু "comment এর মাঝখানে একটা শব্দ" খোঁজার জন্য না।

### ১.২ Trigram - substring খোঁজার জন্য একটা index

**Trigram** - একটা text এর পরপর তিনটা অক্ষরের প্রতিটা টুকরো ("deploy" → `dep`, `epl`, `plo`, `loy`, আর শুরু-শেষের কয়েকটা); trigram index প্রতিটা trigram থেকে সেটা যে যে row এ আছে তার তালিকা রাখে, তাই `'%deploy%'` কে "এই চারটা trigram সবগুলো আছে এমন row" এ বদলে খোঁজা যায়।

Postgres এ এটা `pg_trgm` extension, একটা GIN index:

```
── C. pg_trgm GIN index (12.35 s to build, 81 MB) ────── time       found
   count all "deploy"                             174.8 ms    281,022
   count all "rollback" (rare word)                14.2 ms      9,117
   first 20 "rollback" (rare word)                  1.9 ms         20
   first 20 "recieve" (misspelled - none exist)     0.5 ms          0
   plan, all "deploy" (in 28% of rows): Aggregate ← Gather · 15,840 pages
   plan, all "rollback" (rare):     Aggregate ← Bitmap Heap Scan · 6,995 pages
```

- **বিরল শব্দ:** ৪০৯ ms থেকে ১৪ ms - index বলে দেয় কোন row গুলো দেখতে হবে, বাকি গুলো ছোঁয়াই হয় না।
- **কিছুই নেই:** ৩৯৮ ms থেকে ০.৫ ms - "rec", "eci", "cie", "iev" একসাথে কোথাও নেই, index থেকেই জানা যায়। ঘটনা ১ এর সবচেয়ে বড় অংশ সারল।
- **সাধারণ শব্দ গোনা:** planner তবু পুরো table পড়ে (`Gather`) - "deploy" ২৮% row এ, index থেকে ২ লাখ ৮০ হাজার row আলাদা আলাদা আনার চেয়ে সোজা পড়া সস্তা। (দুই section এর ৩৯০ বনাম ১৭৫ ms এর পার্থক্য index এর না - plan একই, পার্থক্য cache এর।) কোনো index "অর্ধেক table ফেরত দিন" কে দ্রুত করে না।

আর দাম - যেকোনো index এর মতোই (Lesson 5.4), আর এখানে বেশ ভারী: index ৮১ MB, table এর দুই-তৃতীয়াংশ; বানাতে ১২ সেকেন্ড; আর নিচে দেখবেন, প্রতিটা নতুন comment লেখা ৪.৭ গুণ ধীর।

Trigram এর আরেকটা শক্তি ঘটনা ৩ এর: ভুল বানান। দুটো শব্দের trigram কতটা মেলে, সেটা দিয়ে "কাছাকাছি" শব্দ খোঁজা যায়:

```
── Misspellings: trigram similarity against the word list ("did you mean") ──
   "recieve" → receive (0.33)
   "deplyo" → deploy (0.40), deploying (0.31)
   "chekclist" → checklist (0.43)
```

কিন্তু trigram এখনো **substring** খোঁজে - "art" এর trigram "start" এও আছে। ঘটনা ২ এর প্রথম অর্ধেক তাই রয়ে গেল।

### ১.৩ Search আসলে কী চায় - শব্দ, তার রূপ, আর analyzer

User যখন "art" লেখে, সে একটা **শব্দ** খুঁজছে, অক্ষরের একটা ক্রম না। আর যখন "deploying" লেখে, সে "deploy" এর যেকোনো রূপ চায়। Exercise এ একই comment গুলো দুইভাবে গোনা:

```
── Words vs substrings: what matches ──
   ILIKE '%deploy%': 281,022 (including redeploy) · full-text "deploy": 267,943 (including deployment, deploying; redeploy excluded - a separate word, 18,319 of them)
   ILIKE '%art%': 175,420 (start, party, article, smart …) · full-text "art": 9,104
   ILIKE '%log%': 105,336 (login, blog, catalog) · full-text "log": 0
```

"art" এর ১,৭৫,৪২০টা substring মিলের মধ্যে আসল "art" শব্দ মাত্র ৯,১০৪টা - বাকি ৯৫% ভুল ফল। আর "log" শব্দটা একটাও নেই, অথচ substring এ ১ লাখের বেশি।

এই পার্থক্য আসে text কে খোঁজার আগে একটা প্রক্রিয়ার ভেতর দিয়ে নিলে:

**Analyzer** - text কে খোঁজার একক (term) এ বদলানোর ধাপগুলো: শব্দে ভাঙা (tokenization), ছোট হাতের অক্ষরে আনা, খুব সাধারণ অর্থহীন শব্দ ফেলে দেওয়া (stopword - "the", "to", "is"), আর শব্দকে তার মূলে আনা (stemming - "deploying", "deployment" → "deploy")। একই analyzer লেখার সময় document এ, আর খোঁজার সময় query তে চলে - তাই দুই দিকের term মেলে।

```
  "Deploying the release notes after review."
       │ শব্দে ভাঙা, ছোট হাতের
       ▼
  deploying · the · release · notes · after · review
       │ stopword বাদ (the, after)
       ▼
  deploying · release · notes · review
       │ stem
       ▼
  deploy · releas · note · review            ← index এ এগুলোই যায়
```

(Stem গুলো দেখতে অদ্ভুত - "releas" - কারণ এটা শব্দ বানানো না, শুধু একই মূলের রূপ গুলোকে একই চাবি দেওয়া: release, released, releasing → releas।)

একটা জরুরি সীমা: **analyzer ভাষা ধরে।** English এর stemmer বাংলা শব্দে কিছুই করে না। Postgres এর built-in text search config এ বাংলা নেই (Postgres 17 এ hindi, nepali, tamil আছে - `bengali` না) - বাংলা comment এর জন্য সে শুধু `simple` (ভাঙা আর ছোট হাতের, stem ছাড়া) দিতে পারে; Elasticsearch/OpenSearch এ একটা `bengali` analyzer আছে। আর analyzer বদলানো মানে পুরো index আবার বানানো - কারণ index এ যা আছে সেটা পুরনো analyzer এর ফল।

### ১.৪ Inverted Index - শব্দ থেকে document

Analyzer এর পরে প্রতিটা document একটা term এর তালিকা। এবার সেটা উল্টে রাখুন:

**Inverted index** - প্রতিটা term থেকে সেই term যে যে document এ আছে তার তালিকায় যাওয়ার একটা map - বইয়ের পেছনের সূচির মতো ("deploy - পাতা ১২, ৪৭, ৯০"); "document এ কী কী শব্দ" এর উল্টো, তাই "inverted"।

**Posting list** - একটা term এর জন্য সেই document গুলোর id এর তালিকা, id এর ক্রমে সাজানো - প্রায়ই সাথে প্রতিটায় term টা কতবার আছে (term frequency) আর কোন অবস্থানে।

```
  documents                                   inverted index
  ─────────                                   ──────────────
  #1  "Deploy checklist for the release"      checklist → [1, 3]
  #2  "Fix the login bug"                     deploy    → [1, 3(×2), 4]
  #3  "Deploying now, checklist done, deploy" fix       → [2]
  #4  "Deployment failed"                     login     → [2]
                                              releas    → [1]
                                              …

  "deploy checklist" → deploy [1,3,4] ∩ checklist [1,3] → [1, 3]
```

এখন "deploy checklist" এর উত্তর দুটো ছোট তালিকার মিল - কোনো document পড়তে হয় না। Exercise এর `npm run inverted` এটা নিজে বানায়, TypeScript এ, ২ লাখ comment এ:

```
── 1. Building the index: 200,000 comments ──
   time 1181.2 ms · distinct terms 5,030 · postings 1,879,748 (~14 MB, id + tf)
   stopwords dropped: 1,083,698 / 3,098,532 words (35%) - kept, each list would be huge; share of documents: the 24%, a 24%, to 24%
   longest posting lists: kax 112,242 · lox 68,330 · deploy 53,634 · mix 48,866 · rax 37,970

── 2. "deploy checklist" - comments containing both words ──
   full scan, substring (like LIKE)               16.2 ms   4,301
   full scan, with the same analyzer             430.4 ms   4,129
   inverted index (intersecting posting lists)     1.4 ms   4,129
```

- Stopword একাই সব শব্দের ৩৫%। রাখলে প্রতিটার posting list প্রায় চার ভাগের এক ভাগ document জুড়ে - কোনো খোঁজায় কোনো সাহায্য করে না, শুধু জায়গা নেয়। (আধুনিক engine গুলো কখনো stopword রেখে দেয় - "to be or not to be" এর মতো phrase এর জন্য - আর সেটা সামলায় ranking দিয়ে, নিচে।)
- পুরো scan একই analyzer দিয়ে ৪৩০ ms, index ১.৪ ms - একই উত্তর। Experiment ৪ এ ১০ লাখ comment: scan ২০৩০ ms, index ৪.৬ ms - আর ফল ২০,২৯৩, হুবহু Postgres এর full-text এর সমান (নিচে)। Scan document এর সংখ্যার সাথে বাড়ে; index বাড়ে শুধু মেলা posting list এর দৈর্ঘ্যের সাথে।
- (Substring scan ১৬ ms - JavaScript এর `includes` memory তে খুব দ্রুত - কিন্তু ফল ভুল: ৪,৩০১, কারণ "redeploy" ও মেলে।)

**Posting list মেলানো - ক্রমটা জরুরি।** একটা খুব সাধারণ শব্দ আর একটা বিরল শব্দ একসাথে:

```
── 3. "kax AND rollback" - one very common (112,242 docs), one rare (1,785) ──
   walking both lists side by side (merge)         0.7 ms   comparisons   112,808   results 1037
   start from the short list, binary search        0.4 ms   comparisons    29,087   results 1037
```

পাশাপাশি হাঁটলে বড় list এর প্রায় সবটা ছুঁতে হয়; বিরল শব্দ থেকে শুরু করে বড়টায় লাফ দিলে (binary search, বা আসল engine এ "skip list") তুলনা চার ভাগের এক ভাগ। এটা একটা ছোট query planner - Lesson 5.4 এর "সবচেয়ে selective শর্ত আগে" এর ধারণা।

**Postgres এর ভেতরে এটা আছে।** Postgres এর GIN (Generalized Inverted Index) ঠিক এই জিনিস - trigram index ও একটা inverted index (term এর বদলে trigram)। Full-text search এ:

```
── D. Full-text search: tsvector + GIN (11.56 s to build column and index, index 25 MB, table now 264 MB) ──
   count all "deploy"                             102.0 ms    267,943
   "deploy checklist" (both present)               18.2 ms     20,293
   best 20 "deploy checklist" by ts_rank           23.4 ms         20
   "recieve" (misspelled)                           0.4 ms          0
```

`tsvector` হলো analyzer এর ফল (term গুলো, অবস্থান সহ), আর GIN তার inverted index। Index মাত্র ২৫ MB - trigram এর ৮১ MB এর তিন ভাগের এক ভাগ, কারণ term অনেক কম (৫ হাজার শব্দ বনাম অগণিত trigram)। কিন্তু দেখুন table: ১২২ MB থেকে ২৬৪ MB - `tsvector` টা আলাদা column এ রাখা (stored)। Experiment ১: column ছাড়া একটা expression index (`gin (to_tsvector('english', body))`) - table ১২২ MB ই থাকে, query প্রায় একই সময়ে (~৪০–৫৫ ms); দাম: মেলা প্রতিটা row এ `to_tsvector` আবার গোনা, আর query তে হুবহু একই expression লিখতে হয়।

TaskFlow এর stack এ, Sequelize দিয়ে (উদাহরণ - exercise এর query গুলো raw SQL এ চালানো; এই Sequelize অংশটা চালানো হয়নি):

```typescript
// migration: a generated column and GIN - Sequelize has no type for these, so raw SQL
await queryInterface.sequelize.query(`
	ALTER TABLE comments ADD COLUMN tsv tsvector
		GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
	CREATE INDEX comments_tsv ON comments USING gin (tsv);`);

const hitSchema = z.object({
	id: z.number(),
	taskId: z.number(),
	snippet: z.string(),
	rank: z.number()
});

async function searchComments(
	workspaceId: number,
	q: string
): Promise<z.infer<typeof hitSchema>[]> {
	const rows: unknown = await sequelize.query(
		`SELECT id, task_id AS "taskId",
		        ts_headline('english', body, query, 'MaxWords=20') AS snippet,
		        ts_rank(tsv, query)::float AS rank
		   FROM comments, websearch_to_tsquery('english', :q) AS query
		  WHERE workspace_id = :workspaceId AND tsv @@ query   -- always the workspace filter (1.6)
		  ORDER BY rank DESC
		  LIMIT 20`,
		{ replacements: { q, workspaceId }, type: QueryTypes.SELECT }
	);
	return z.array(hitSchema).parse(rows); // the result of a raw query - parse, not a type assertion
}
```

(`websearch_to_tsquery` user এর লেখা Google-এর মতো query বোঝে - `deploy -staging`, `"release notes"`। `ts_headline` ফলাফলে মেলা শব্দ গুলো হাইলাইট করা অংশ দেয়।)

**লেখার দাম:**

```
── Write cost: inserting 20,000 new comments (1000 at a time) ──
   primary key only       114.9 ms   1.0×
   + trigram GIN          541.8 ms   4.7×
   + full-text GIN        321.5 ms   2.8×
```

একটা comment এ ১৫টা শব্দ মানে inverted index এর ১৫টা আলাদা posting list এ একটা করে যোগ - B-tree এর একটা জায়গায় একটা entry এর চেয়ে অনেক বেশি কাজ। Postgres এর GIN এটা কিছুটা কমায় একটা "pending list" দিয়ে (`fastupdate`): নতুন entry আগে একটা ছোট তালিকায় জমে, পরে একসাথে মূল index এ - Lesson 5.3 এর LSM এর ধারণার আত্মীয়। (আর Elasticsearch এর Lucene পুরোপুরি এই পথে: নতুন document ছোট ছোট অপরিবর্তনীয় "segment" এ, পরে background এ বড় segment এ জোড়া - প্রায় হুবহু LSM।)

### ১.৫ কোনটা আগে - relevance

২০ হাজার comment এ "deploy" আর "checklist" দুটোই আছে। কোন ২০টা প্রথম পাতায়? "সবচেয়ে নতুন" (ঘটনা ২) সবচেয়ে সহজ উত্তর, কিন্তু user প্রায়ই সবচেয়ে **প্রাসঙ্গিক** টা চায়। প্রাসঙ্গিকতার তিনটা স্বাভাবিক সংকেত:

- **Term frequency (tf):** একটা document এ শব্দটা যত বেশিবার, সে তত বেশি সেই বিষয়ে - কিন্তু কমতে থাকা হারে (দশবার "deploy" দশ গুণ প্রাসঙ্গিক না)।
- **Inverse document frequency (idf):** শব্দটা যত **বিরল**, মেলাটা তত অর্থবহ। "deploy" ২৭% comment এ - মেলা সাধারণ ব্যাপার; "rollback" ১% এ - মেলা মানে বিশেষ কিছু।
- **Document এর দৈর্ঘ্য:** ৫ শব্দের একটা comment এ "deploy checklist" মানে comment টা পুরোটাই সেই বিষয়ে; ৫০০ শব্দের একটা লম্বা আলোচনায় একবার আসা মানে কম।

**Relevance scoring (TF-IDF, BM25)** - প্রতিটা মেলা document কে একটা score দেওয়া যেটা এই সংকেত গুলো জোড়ে: query এর প্রতিটা term এর জন্য idf × (tf এর একটা বাঁকানো, দৈর্ঘ্য অনুযায়ী ঠিক করা রূপ)। BM25 এর এই সূত্রই আজ Lucene, Elasticsearch, OpenSearch এর default।

```
── 4. The top 3 for "deploy checklist" - ordered by BM25 ──
   #25628 score 5.99 · 10 terms · "Dalox kax checklist release deploy mirax of can bax checklist it this to a deplo…"
   #6142 score 5.91 · 2 terms · "Deploy to on checklist and is in."
   #44060 score 5.91 · 2 terms · "To checklist deploy after can a."
   IDF (the rarer, the heavier): deploy 1.32 · checklist 2.66 · rollback 4.72 · kax 0.58
```

দ্বিতীয় আর তৃতীয়টা ছোট - stopword বাদে মাত্র ২টা term, দুটোই মেলা - দৈর্ঘ্যের সংকেত। প্রথমটা লম্বা, কিন্তু "checklist" দুবার আর "deploy" এর রূপ দুবার - tf। আর IDF এর সারিটা: "checklist" "deploy" এর চেয়ে দ্বিগুণ ভারী, কারণ বিরল; খুব সাধারণ "kax" প্রায় ওজনহীন।

Postgres এর `ts_rank` একটু আলাদা: শব্দ কতবার আর কত কাছাকাছি সেটা দেখে, কিন্তু পুরো table এ শব্দটা কত বিরল (idf) - সেটা দেখে না, কারণ তার জন্য প্রতিটা query তে গোটা corpus এর পরিসংখ্যান লাগে। (Experiment ২ এ এর প্রভাব।) বেশিরভাগ app এ এটা যথেষ্ট; relevance যদি product এর কেন্দ্রে হয় (e-commerce, docs এর search), সেখানে এটা একটা বড় পার্থক্য।

আর বাস্তবে text এর score একা কখনো শেষ কথা না। TaskFlow এ একটা ভালো ক্রম সম্ভবত: text এর score + নতুনত্ব (গত সপ্তাহের comment আগে) + user এর নিজের project + task এখনো খোলা কিনা। এই মিশ্রণ ঠিক করা একটা product এর সিদ্ধান্ত, আর মাপতে হয় (user কোন ফলে click করে)।

### ১.৬ আলাদা search engine - কখন, আর তার দাম

এতক্ষণ সব Postgres এর ভেতরে। কখন একটা আলাদা system - Elasticsearch, বা তার open-source fork OpenSearch (Elastic 2021 এ license বদলানোর পরে AWS এর নেতৃত্বে তৈরি)?

**Postgres এর full-text যথেষ্ট যখন:** কয়েক লাখ থেকে কয়েক কোটি row, একটা database এ ধরে; search এর সাথে একই transaction এর consistency চাই (লেখার সাথে সাথেই খোঁজা যায়); ranking মোটামুটি হলেই চলে; আর আলাদা একটা system চালানোর মানুষ নেই।

**আলাদা engine যখন:** data একটা machine এর চেয়ে বড়, বা search এর load এত যে database কে বাঁচাতে হবে; BM25 আর relevance এর সূক্ষ্ম নিয়ন্ত্রণ (field এর ওজন, synonym, "did you mean"); ভাষা (বাংলা analyzer); ভুল বানান built-in (fuzzy query); facet - "এই ফলাফলের মধ্যে project অনুযায়ী কয়টা" (Lesson 7.6 এর OLAP এর ছোট রূপ); আর autocomplete এর বিশেষ index।

কিন্তু আলাদা engine মানে **আরেকটা data store, যেটা database এর কপি** - আর Module 5–7 এর প্রতিটা প্রশ্ন ফিরে আসে:

- **Sync।** Database এ comment লেখা হলো - search index কীভাবে জানবে? "লিখে তারপর Elasticsearch এ পাঠান" হলো Lesson 7.5 এর dual write - crash এ index থেকে comment হারায়। উত্তরও 7.5 এর: outbox (বা CDC) → event → একটা search consumer। আর consumer idempotent (7.4) - সৌভাগ্যক্রমে এখানে এটা স্বাভাবিক: document id ধরে পুরো document "সেট" করা (upsert) দশবার হলেও একই ফল। শুধু একটা সূক্ষ্মতা: পুরনো event পরে এলে নতুনটাকে overwrite করতে পারে - তাই প্রতিটা document এ একটা version (database এর `updatedAt` বা একটা counter), আর engine কে বলা "শুধু বড় version হলে লিখুন" (Elasticsearch এর external versioning - 6.3 এর version token এর ধারণা)।
- **"লিখলাম কিন্তু খুঁজে পাচ্ছি না।"**

**Near real-time search (refresh)** - নতুন document index এ লেখা হলেও সাথে সাথে খোঁজার ফলে আসে না; engine নির্দিষ্ট সময় পর পর (Elasticsearch এর default ১ সেকেন্ড) নতুন লেখা গুলোকে খোঁজার যোগ্য করে ("refresh")। তাই লেখা থেকে খুঁজে পাওয়া পর্যন্ত একটা ছোট জানালা।

সাথে outbox relay এর দেরি (7.5 এ p99 ~৪৫০ ms) আর consumer এর দেরি - সব মিলিয়ে এক-দুই সেকেন্ড। User comment লিখে সাথে সাথে খুঁজলে পায় না - Lesson 6.3 এর read-your-writes, নতুন জায়গায় (প্রশ্ন ৩)।

- **Permission।** Database এ `WHERE workspace_id = :id` একটা join বা একটা শর্ত - আর ভুলে গেলে সেটা শুধু এক জায়গার bug। Search index এ সব workspace এর comment একসাথে; প্রতিটা query তে workspace এর filter **বাধ্যতামূলক**, একটা জায়গাতেও ভুললে একজন customer অন্যের comment দেখে। আর কেউ workspace থেকে বাদ পড়লে, বা comment মুছলে - index এ সেটা sync এর দেরি পর্যন্ত থাকে (প্রশ্ন ২)।
- **Scale এর নিয়ম।** Index কে shard করা হয় সাধারণত document ধরে (Lesson 5.8): প্রতিটা shard এর নিজের ছোট inverted index, আর একটা query সব shard এ যায় (scatter-gather), প্রতিটা নিজের সেরা ২০টা দেয়, তারপর জোড়া। একটা সূক্ষ্মতা: BM25 এর idf প্রতিটা shard এ নিজের data থেকে গোনা হয় - তাই ছোট index এ shard ভেদে score একটু আলাদা। আর গভীর pagination দামি - ৫০০ নম্বর পাতা মানে প্রতিটা shard কে ১০,০০০টা বানিয়ে পাঠাতে হয়; তাই Elasticsearch default এ `from + size` ১০,০০০ এর বেশি দেয় না (`index.max_result_window`), আর গভীরে যেতে `search_after` - Lesson 2.5 এর cursor pagination।
- **আবার বানানো।** Analyzer বা mapping বদলালে পুরো index নতুন করে - database থেকে (8.1 আর 7.2 এর সতর্কতা: source of truth database, index না)। Downtime ছাড়া করতে নতুন index পাশে বানিয়ে একটা alias ঘোরানো।

### ১.৭ TaskFlow এর সিদ্ধান্ত

TaskFlow এ ১০ লাখ comment, প্রতিদিন কয়েক হাজার নতুন, আর search এর load database কে এখনো কাবু করার মতো না - **এখন Postgres, পরে দরকার হলে OpenSearch।**

- **Comment, task এর title, attachment এর নাম:** প্রতিটায় `tsvector` + GIN। Title এর ওজন বেশি (Postgres এর `setweight` - title এ `A`, body তে `B`)। Query `websearch_to_tsquery`, ক্রম `ts_rank` + নতুনত্ব, আর **সবসময়** `workspace_id` এর filter - search এর function এর signature এই workspaceId ছাড়া নেয়ই না।
- **ভুল বানান:** শব্দের একটা তালিকা (workspace এর সব term, রাতে `ts_stat` থেকে), তার উপর trigram index - কোনো ফল না এলে "did you mean"।
- **Task এর title এর autocomplete:** `lower(title) text_pattern_ops` এর B-tree (prefix - ১.১), শুধু title এ, সর্বোচ্চ ১০টা, ২ অক্ষরের পরে, frontend এ debounce।
- **`ILIKE '%…%'` আর কোথাও না** - code review এর checklist এ।
- **OpenSearch এ যাওয়ার সংকেত:** বাংলা comment এর search এর চাওয়া; facet; search এর load database এর CPU এর বড় অংশ; বা কয়েক কোটি document। তখন: outbox → `comment.*`/`task.*`/`attachment.*` event → search consumer (version সহ upsert), workspace এর filter সহ query, নিজের লেখা comment frontend এ সাথে সাথে দেখানো (read-your-writes এর জন্য)।

> **Trade-off Table - TaskFlow এর search কীভাবে**

| উপায়                             | কী মেলে                          | ধীর কখন                                   | ভুল বানান              | Ranking                          | লেখার দাম        | Sync / consistency                 | কখন                                       |
| --------------------------------- | -------------------------------- | ----------------------------------------- | ---------------------- | -------------------------------- | ---------------- | ---------------------------------- | ----------------------------------------- |
| `ILIKE '%…%'`, index ছাড়া        | Substring (art → start)          | বিরল বা নেই এমন শব্দে সবসময় - পুরো table | না                     | না                               | কিছু না          | একই transaction                    | ছোট table, admin এর tool                  |
| B-tree (`text_pattern_ops`)       | শুধু prefix                      | মাঝের শব্দে কাজেই আসে না                  | না                     | না                               | কম               | একই transaction                    | Autocomplete (title এর শুরু)              |
| `pg_trgm` GIN                     | Substring, দ্রুত                 | খুব সাধারণ অংশ (অর্ধেক table)             | **হ্যাঁ** (similarity) | না                               | বেশি (৪.৭ গুণ)   | একই transaction                    | Code, id, নাম - যেখানে substring ই চাই    |
| Postgres full-text (tsvector+GIN) | **শব্দ**, stem সহ                | খুব সাধারণ শব্দ গোনা                      | না (trigram জুড়ে)     | `ts_rank` (idf ছাড়া)            | মাঝারি (২.৮ গুণ) | একই transaction - লিখেই খোঁজা যায় | কয়েক কোটি row পর্যন্ত, মোটামুটি ranking  |
| Elasticsearch / OpenSearch        | শব্দ, ভাষা ধরে analyzer, synonym | -                                         | হ্যাঁ (fuzzy)          | BM25 + সূক্ষ্ম নিয়ন্ত্রণ, facet | আলাদা cluster এ  | Eventual - sync + refresh (~১ s)   | বড় data, relevance কেন্দ্রে, ভাষা, facet |

---

## ২. Interview Angle

**"Search feature design করুন" (বা "design Twitter search", "design an e-commerce search")।** - ভালো উত্তরের ক্রম: কেন database এর `LIKE` না (পুরো scan, substring, ranking নেই - একটা সংখ্যা); inverted index কী (term → posting list, analyzer); ranking (BM25 + ব্যবসার সংকেত); আর তারপর আসল system design এর অংশ - **index কীভাবে sync থাকে** (outbox/CDC → consumer → upsert, eventual), **কীভাবে shard হয়** (document ধরে, scatter-gather), আর **permission**। বেশিরভাগ candidate inverted index বলে থামে; sync আর permission বলা মানুষটা production এ চালিয়েছে।

**"Inverted index কী?"** - এক বাক্যে সংজ্ঞা, তারপর ছবি (term → sorted doc id), তারপর AND query কীভাবে (posting list মেলানো, ছোটটা থেকে), তারপর কেন লেখা দামি (একটা document অনেক list এ)। বোনাস: Lucene এর segment আর LSM এর মিল।

**"User comment লিখল, খুঁজে পাচ্ছে না - কেন?"** - Near real-time: sync এর দেরি + refresh interval। উত্তর: কতক্ষণ মেনে নেওয়া যায়, আর নিজের লেখা UI তে সাথে সাথে দেখানো (6.3), বা ওই request এ refresh এর অপেক্ষা (Elasticsearch এর `refresh=wait_for` - দাম সহ)।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনা: একটা query তে tenant এর filter বাদ পড়া (অন্যের data দেখানো); index আর database এর মধ্যে নীরবে ফাঁক জমা (event হারানো, consumer বন্ধ) - তাই নিয়মিত একটা মিলিয়ে দেখার job (গোনা, নমুনা); mapping বদলে পুরো index আবার বানানো যে কয়েক ঘণ্টা নেয়; আর search-as-you-type যেটা database এ প্রতিটা অক্ষরে পুরো scan পাঠায় - ঘটনা ১।

---

## ৩. Key Takeaway

- `ILIKE '%x%'` পুরো table পড়ে; `LIMIT` এ সাধারণ শব্দ দ্রুত দেখায় (০.৫ ms), কিন্তু বিরল বা নেই এমন শব্দে প্রতিবার পুরো table (৩৯৮ ms) - আর user রা ঠিক সেগুলোই খোঁজে। B-tree শুধু prefix এ কাজে লাগে - সাজানো ক্রমে "মাঝখানে আছে" এর কোনো টানা অংশ নেই
- **Trigram** index substring কে দ্রুত করে (বিরল শব্দ ৪০৯ → ১৪ ms, "নেই" ৩৯৮ → ০.৫ ms) আর ভুল বানান ধরে - কিন্তু এখনো substring ("art" এর ৯৫% ভুল ফল), index ভারী, লেখা ৪.৭ গুণ ধীর
- **Analyzer** (শব্দে ভাঙা, ছোট হাতের, stopword, stem) text কে term এ বদলায় - লেখা আর খোঁজা দুই দিকেই একই; ভাষা ধরে (Postgres এ বাংলা নেই)
- **Inverted index** = term → **posting list** (sorted doc id + tf); AND মানে list মেলানো - বিরলটা থেকে শুরু করলে তুলনা চার ভাগের এক ভাগ; ১০ লাখে scan ২০৩০ ms, index ৪.৬ ms। Postgres এর GIN এটাই
- **Relevance**: tf, **idf** (বিরল = ভারী), দৈর্ঘ্য - **BM25**; Postgres এর `ts_rank` এ idf নেই; আর ব্যবসার সংকেত (নতুনত্ব, নিজের project) মিশিয়েই আসল ক্রম
- আলাদা engine মানে database এর একটা কপি: sync outbox/CDC দিয়ে (version সহ upsert), **near real-time** (refresh ~১ s) তাই read-your-writes এর প্রশ্ন, প্রতিটা query তে tenant এর filter, document ধরে shard আর scatter-gather, গভীর pagination এ cursor
- TaskFlow: এখন Postgres full-text (title এ বেশি ওজন, workspace filter বাধ্যতামূলক) + trigram এ "did you mean" + prefix B-tree এ autocomplete; OpenSearch যখন ভাষা, facet, load বা আকার দাবি করে

---

## ৪. নতুন Term (Glossary)

| Term                                  | অর্থ                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigram**                           | Text এর পরপর তিন অক্ষরের টুকরো; trigram index প্রতিটা trigram থেকে row এর তালিকা রাখে - substring খোঁজা আর ভুল বানানের মিল দ্রুত হয়          |
| **Analyzer**                          | Text কে term এ বদলানোর ধাপ - শব্দে ভাঙা, ছোট হাতের অক্ষর, stopword বাদ, stem; লেখা আর খোঁজা দুই দিকে একই, আর ভাষা ধরে                         |
| **Inverted Index**                    | প্রতিটা term থেকে যে যে document এ আছে তার তালিকায় যাওয়ার map - বইয়ের সূচির মতো; Postgres এর GIN, Lucene/Elasticsearch এর ভিত্তি           |
| **Posting List**                      | একটা term এর document id এর তালিকা, id এর ক্রমে - প্রায়ই সাথে term frequency আর অবস্থান; AND query মানে এদের মেলানো                          |
| **Relevance Scoring (TF-IDF / BM25)** | মেলা document কে score দেওয়া: শব্দ কতবার (tf), কত বিরল (idf), document কত লম্বা - BM25 আজকের search engine গুলোর default                     |
| **Near Real-Time Search (Refresh)**   | নতুন লেখা document সাথে সাথে না, নির্দিষ্ট সময় পর পর (Elasticsearch এ default ১ s) খোঁজার যোগ্য হয় - লেখা আর খুঁজে পাওয়ার মাঝে একটা জানালা |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর task এর title এর autocomplete: user টাইপ করতে থাকলে প্রতিটা অক্ষরে সাজেশন। ৫০ হাজার active user, প্রত্যেকে দিনে গড়ে ২০ বার খোঁজে, প্রতিটায় গড়ে ৬ অক্ষর। (ক) প্রতিটা অক্ষরে একটা request গেলে সবচেয়ে ব্যস্ত ঘণ্টায় (দিনের ২০% search) প্রতি সেকেন্ডে কত query? (খ) কোন index - prefix এর B-tree, trigram, না full-text - আর কেন? (গ) Database এর চাপ কমাতে frontend আর API এ কী কী করবেন?
2. TaskFlow OpenSearch এ গেছে: একটা `comments` index এ সব workspace এর comment, আর প্রতিটা query তে `workspace_id` এর filter। (ক) কোন ধরনের bug এ একজন customer অন্য customer এর comment দেখবে - অন্তত দুটো পরিস্থিতি? (খ) একজন member workspace থেকে বাদ পড়ল - কতক্ষণ সে কী দেখতে পারে? (গ) "প্রতিটা workspace এর আলাদা index" এর সাথে তুলনা করুন - কী সারায়, কী নতুন সমস্যা আনে (৫ হাজার workspace)?
3. একজন user comment লিখল "Release 2.1 rollback plan", আর সাথে সাথে search এ "rollback" লিখল - পেল না। দুই সেকেন্ড পরে আবার - পেল। Outbox relay (7.5), search consumer, আর OpenSearch এর refresh ধরে এই দুই সেকেন্ডের হিসাব দিন। তিনটা সমাধান দিন, প্রতিটার দাম সহ। কোনটা বাছবেন?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) দিনে ৫০,০০০ × ২০ = ১০ লাখ search; প্রতিটায় ৬ অক্ষর মানে ৬০ লাখ request। ব্যস্ততম ঘণ্টায় ২০%: ১২ লাখ ÷ ৩৬০০ ≈ **~৩৩০ query/সেকেন্ড** - আর search এর ঢেউয়ে এর কয়েক গুণ।

(খ) Title এর **prefix এর B-tree** (`lower(title) text_pattern_ops`, সাথে workspace - `(workspace_id, lower(title) text_pattern_ops)`)। Autocomplete আসলে "এভাবে শুরু হয়" এর প্রশ্ন - B-tree ঠিক এটাই ভালো পারে (১.১), index ছোট, লেখা সস্তা। Full-text শব্দ ধরে - "depl" কে শব্দ হিসেবে পাবে না (prefix এর tsquery `depl:*` আছে, সেটাও চলে, কিন্তু title এর শুরুর জন্য B-tree সরল)। Trigram মাঝের অংশও মেলাবে ("oy" → "deploy") - autocomplete এ সাধারণত সেটা চাই না, আর index ভারী।

(গ) **Debounce** (টাইপ থামার ১৫০–২০০ ms পরে পাঠানো - ৬টা request প্রায় ১–২টায় নামে); **ন্যূনতম ২ অক্ষর**; **limit ১০**; পুরনো request বাতিল (`AbortController` - দেরিতে আসা পুরনো উত্তর নতুনটাকে overwrite না করে); ছোট cache (একই workspace এ "de" এর উত্তর কয়েক সেকেন্ড - Lesson 4.x); আর query সবসময় একটা workspace এর ভেতরে - index এর প্রথম column। এতে ৩৩০ এর জায়গায় বাস্তবে ~১০০ এর ঘরে, আর প্রতিটা ~১ ms এর index scan।

**প্রশ্ন ২:**

(ক) দুটো পরিস্থিতি:

- **নতুন একটা query এর পথ** - ধরুন "সব comment এ search" এর একটা admin feature, বা একটা নতুন "similar comments" API - যেখানে কেউ filter লিখতে ভুলে গেল। Database এ একই ভুল প্রায়ই অন্য কোথাও ধরা পড়ে (row level security, join); search এ index টাই সব workspace এর মিশ্রণ।
- **Filter আছে, কিন্তু ভুল মান থেকে** - client এর পাঠানো `workspaceId` (URL বা body থেকে) সরাসরি filter এ বসানো, server এর session থেকে না। তাহলে যে কেউ অন্য id পাঠিয়ে অন্যের comment খোঁজে।
- প্রতিরোধ: search এর একটাই function যেটা server এর session থেকে workspace নেয় আর filter নিজে বসায় (signature এ অন্য পথ নেই); code review এ direct OpenSearch client নিষেধ; আর একটা test যেটা দুটো workspace বানিয়ে একটার user দিয়ে অন্যটার শব্দ খোঁজে।

(খ) বাদ পড়া member: search এর **permission** (সে কোন workspace এ আছে) যদি প্রতিটা request এ database থেকে/সেশন থেকে যাচাই হয়, তাহলে বাদ পড়ার পরের প্রথম request থেকেই সে কিছু পায় না - index এর sync এর উপর নির্ভর করে না। কিন্তু যদি permission index এর document এ বসানো থাকে (প্রতিটা comment এ "কারা দেখতে পারে" এর তালিকা), তাহলে sync এর দেরি পর্যন্ত (সেকেন্ড, বা consumer আটকে থাকলে ঘণ্টা) সে দেখে। নিয়ম: "কে কোন workspace এ" এর মতো দ্রুত বদলানো permission query এর সময় database থেকে; index এ শুধু স্থির বিভাজন (workspace_id)।

(গ) Workspace প্রতি আলাদা index: একজন অন্যের data দেখার ঝুঁকি কমে (ভুল index এ query গেলেই শুধু), একটা workspace মুছে ফেলা মানে একটা index delete (8.1 এর প্রশ্ন ২ এর মতো), আর বড় customer কে আলাদা resource দেওয়া যায়। নতুন সমস্যা: ৫ হাজার index - প্রতিটা index এর নিজের shard, আর প্রতিটা shard এর memory আর file এর overhead; ছোট workspace এর ছোট index এ BM25 এর idf অর্থহীন (কয়েকশো document); mapping বদলালে ৫ হাজার index আবার বানাতে হয়। মাঝামাঝি পথ: এক index (বা কয়েকটা), workspace_id দিয়ে routing (একটা workspace এর সব document একই shard এ - Lesson 5.8 এর shard key), আর খুব বড় customer দের আলাদা index।

**প্রশ্ন ৩:** দুই সেকেন্ডের হিসাব, একটা একটা করে:

1. Comment এর transaction commit - outbox row সহ (7.5)।
2. Relay পরের poll এ তোলে আর stream এ পাঠায় - 7.5 এর exercise এ p50 ~১০০ ms, p99 ~৪৫০ ms।
3. Search consumer পড়ে, document বানায় (হয়তো task এর title আনতে database এ একটা query), OpenSearch এ upsert - কয়েক দশ ms, আর consumer এর lag থাকলে বেশি।
4. OpenSearch এ document লেখা, কিন্তু খোঁজার যোগ্য হয় পরের refresh এ - গড়ে ~৫০০ ms, সর্বোচ্চ ১ সেকেন্ড।

যোগ: সাধারণত ১–২ সেকেন্ড, খারাপ মুহূর্তে বেশি।

সমাধান:

- **নিজের লেখা UI তে সাথে সাথে** - search এর ফলাফলে user এর এই session এ লেখা সাম্প্রতিক comment গুলো frontend নিজে জুড়ে দেয় (optimistic), বা API "গত ১০ সেকেন্ডে এই user এর লেখা" database থেকে এনে জুড়ে দেয়। দাম: সামান্য জটিলতা; অন্যদের জন্য কিছু বদলায় না - তারা ১–২ সেকেন্ড পরে পায়, সেটা সাধারণত ঠিক আছে (Lesson 6.3 এর read-your-writes শুধু লেখকের জন্য দরকার)।
- **Consumer এ `refresh=wait_for`** - OpenSearch এ লেখা ততক্ষণ ফেরে না যতক্ষণ refresh না হয়; relay আর consumer এর দেরি থেকেই যায়, আর বেশি লেখায় consumer ধীর হয়। দাম: throughput; আর প্রথম দুটো ধাপ বাকি।
- **Refresh interval ছোট করা** (ধরুন ২০০ ms) - দাম: অনেক ছোট segment, বেশি merge, লেখার খরচ বাড়ে (Lucene এর segment - LSM এর মতো); আর relay/consumer এর দেরি তবু থাকে।

বাছাই: প্রথমটা - সমস্যাটা আসলে শুধু লেখকের (read-your-writes), আর সেটা সবচেয়ে সস্তায় সারে লেখকের দিকেই; বাকি system এর eventual consistency রেখে দেওয়া যায়।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (Docker এ Postgres; `inverted` এ Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-8.3-search/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-8.3-search) - `docker compose up -d --wait && npm install && npm run seed`, তারপর `npm run like` আর `npm run inverted`। পুরো setup, acceptance criteria, experiment আর teardown (`docker compose down -v`) ওখানকার `README.md` এ আছে।

`seed` ১০ লাখ comment বানায় একটা নির্দিষ্ট সূত্রে (comment নম্বর i এর text সবসময় একই)। `like` চারটা উপায়ে খোঁজে - index ছাড়া, B-tree, trigram, full-text - সাথে শব্দ বনাম substring, লেখার দাম, আর ভুল বানান। `inverted` একই comment এর উপর নিজের একটা inverted index বানায় - analyzer, posting list, intersection, BM25।

**সৎ নোট:** Sandbox এ Postgres 17 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean; `like` কয়েকবার - প্রথম দিকের একটা run এ table আগের run এর মুছে ফেলা `tsv` column এর জায়গা নিয়ে ফোলা ছিল (২৬৪ MB), আর index ছাড়া অংশ দ্বিগুণ page পড়ছিল; তাই এখন script শুরুতে `VACUUM FULL` চালায়, আর তার পরের দুটো run এ সংখ্যা কাছাকাছি একই; `inverted` কয়েকবার, সময় ছাড়া হুবহু একই। README এর experiment ১ আর ৪ চালানো হয়েছে, সংখ্যা README তে; ২, ৩, ৫ code বা setting বদলানোর কাজ - আপনার। "সব deploy গোনা" তে index ছাড়া আর trigram section এর সময়ের পার্থক্য index এর না - plan একই, পার্থক্য cache এর। Comment গুলো বানানো text, আসলের চেয়ে নিয়মিত - আকৃতি আসল, অনুপাত না। `inverted` এর analyzer একটা খেলনা (Porter এর কয়েকটা নিয়মের নকল) - তবে এই data তে "deploy checklist" এর ফল (২০,২৯৩) Postgres এর `english` config এর সাথে হুবহু মিলেছে। Sequelize এর উদাহরণ (১.৪) চালানো হয়নি - exercise এর query গুলো raw SQL এ। Elasticsearch/OpenSearch এর কথা (refresh ১ s, `max_result_window` ১০,০০০, external versioning, `bengali` analyzer) documentation থেকে, এখানে চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **ফাঁদটা ধরুন:** `like` চালানোর আগে অনুমান করুন - index ছাড়া "প্রথম ২০টা deploy", "প্রথম ২০টা rollback", "প্রথম ২০টা recieve" - কোনটা দ্রুত, কোনটা ধীর, কেন। তারপর মেলান। TaskFlow এর search এর p99 আসলে কোন ধরনের query ঠিক করে?

2. **Trigram এর সীমা:** trigram section এ "সব deploy গোনা" এর plan কেন `Gather` (পুরো table)? `EXPLAIN` দিয়ে `ILIKE '%deploy checklist%'` আর `ILIKE '%eploy%'` দেখুন - index কোনটায় কাজে লাগে? তারপর experiment ৫ - ছোট শব্দে trigram কেন দুর্বল?

3. **নিজের index এর ভেতরে:** `inverted.ts` এর ৩ নম্বরে তুলনার সংখ্যা হাতে মোটামুটি হিসাব করুন (merge: দুটো list এর যোগফল; ছোট থেকে: ১,৭৮৫ × log₂(১,১২,২৪২))। তারপর experiment ৩ (stopword রাখুন) - posting কত বাড়ল, আর "the deploy" এ কী হয়?

4. **Ranking তুলনা** (experiment ২): "kax deploy" দিয়ে Postgres এর `ts_rank` আর আপনার BM25 এর সেরা ৫টা পাশাপাশি রাখুন। কোথায় আলাদা, আর কেন (idf)? TaskFlow এর জন্য কোনটা ঠিক মনে হয়?

5. **Design অংশ:** TaskFlow এর search এর এক পাতার design: (ক) কী কী খোঁজা যায় (comment, task এর title, attachment এর নাম) আর প্রতিটার ওজন; (খ) প্রতিটা query এর permission এর নিয়ম - কোথা থেকে workspace আসে, কোথায় filter বসে; (গ) autocomplete আর "did you mean" এর পথ; (ঘ) কোন সংখ্যা দেখলে OpenSearch এ যাবেন, আর গেলে sync এর পথ (কোন event, consumer, version) আর read-your-writes এর সমাধান; (ঙ) index আর database এর মধ্যে ফাঁক ধরার একটা নিয়মিত job।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7 (সম্পূর্ণ, exit challenge সহ), 8.1, 8.2, 8.3
Current: 8.3 - Search & inverted index (Module 8 এর শেষ lesson)
TaskFlow state: Nginx + ৬টা Express instance, CDN, Redis cache; PostgreSQL primary + ৩টা
read replica, Patroni + etcd; outbox → Redis Streams, BullMQ; attachment: metadata database এ,
bytes object storage এ, upload presigned (multipart ১০০ MB এর বেশি), download CDN signed URL/cookie;
search: Postgres full-text (tsvector + GIN; comment, task title (ওজন A), attachment এর নাম),
websearch_to_tsquery, ts_rank + নতুনত্ব, workspace filter বাধ্যতামূলক; "did you mean" trigram এর
শব্দ-তালিকায়; title autocomplete prefix B-tree এ (debounce, ২ অক্ষর, limit ১০); ILIKE '%…%' নিষেধ;
OpenSearch পরে (ভাষা/facet/load/আকার) - outbox → search consumer, version সহ upsert
Terms learned (Module 8): Object Storage, Bucket / Key (Prefix), Object Metadata, Durability,
Erasure Coding, Failure Domain, Storage Class / Lifecycle, Presigned URL, CORS / Preflight,
Multipart Upload, Resumable Upload, Cache Key, CDN Signed URL / Signed Cookie, Trigram, Analyzer,
Inverted Index, Posting List, Relevance Scoring (TF-IDF / BM25), Near Real-Time Search (Refresh)
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: Module 8 Exit Challenge
=======================
```

---

## ৮. পরের ধাপ

Exercise চালিয়ে পাঠান - বিশেষ করে ১ নম্বরের "p99 কে ঠিক করে" আর ৫ নম্বরের design। এটা Module 8 এর শেষ lesson। রেডি হলে `next` লিখুন - **Module 8 Exit Challenge** এ যাব: একটা mini design challenge (Tier 3) যেখানে পুরো module একসাথে লাগবে - কোথায় bytes রাখবেন, কীভাবে টিকে থাকবে, upload আর download এর পথ, CDN, আর search - একটা বাস্তব scenario তে; একটা "আপনি এগুলো পারার কথা" checklist; আর বই, ভিডিও, project এর recommendation। তারপর Module 9 - Microservices & Service Architecture: TaskFlow এখন একটা monolith যার ভেতরে queue, event, object storage, search সব আছে; কখন এটাকে আলাদা service এ ভাঙবেন - আর কখন **ভাঙবেন না**।
