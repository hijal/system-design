# Lesson 8.3 — Search & Inverted Index: Why LIKE %x% Doesn't Scale

**Module 8 — Storage Systems**

> **Spaced Repetition (Lesson 5.4):** Why doesn't a composite B-tree index on `(project_id, occurred_at)` help with `WHERE occurred_at > …` (without project_id)? In one line — using how a B-tree is ordered inside. Today, for the same reason, `LIKE '%deploy%'` won't get an index either.

**Prerequisite:** Lesson 5.3 (LSM-tree), Lesson 5.4 (B-tree, composite index), Lesson 5.8 (Sharding, scatter-gather), Lesson 6.3 (Read-your-writes), Lesson 7.4 (Idempotent consumer), Lesson 7.5 (Outbox, CDC), Lesson 8.2 (the `attachment.uploaded` event)

**By the end of this lesson you will be able to:**

1. Say with measured numbers why `LIKE '%x%'` is slow on a big table — and when that slowness hides (the `LIMIT` trap); and say what a trigram index fixes and what it doesn't
2. Draw on a whiteboard how an inverted index is built (analyzer, posting lists) and searched (intersecting posting lists, ranking with BM25)
3. Choose between Postgres's full-text search and a separate search engine (Elasticsearch/OpenSearch) for TaskFlow's search — and, with a separate engine, design keeping it in sync with the database, permissions, and handling "I wrote it but I can't find it"

**Tier:** 1 — Runnable Code (Postgres in Docker, a million comments; and a hand-built inverted index in memory)

---

## 0. Where TaskFlow Is Right Now

TaskFlow has had a search box since day one, and its code is one line:

```typescript
const results = await Comment.findAll({
	where: { workspaceId, body: { [Op.iLike]: `%${q}%` } },
	order: [['createdAt', 'DESC']],
	limit: 20
});
```

In the days of 100 users it was perfect. Now there are more than a million comments, and three complaints at once:

1. **Slow — but not always.** Engineers test it (searching "deploy") — 1 ms. Yet monitoring says search's p99 is 400 ms, and when many people search at once, the database's CPU fills up. The slowest searches have one thing in common: they have no results. And the frontend sends a search on every keystroke.
2. **Wrong results.** Someone searched "art" (a design task) — the first page was full of "start", "party", "smart". Someone else searched "deploying" — comments that said "deploy" didn't come up. And results are always newest to oldest — the most relevant one is five pages in.
3. **New asks.** Product wants misspelled searches ("recieve" finding "receive"), searching task titles and attachment names together (one consumer of 8.2's `attachment.uploaded` event), and filtering by project.

Today's question: where does this one line break, what does it take for a database to be a search engine, and when is a database not enough.

---

## 1. Theory

### 1.1 `LIKE '%x%'` — why the whole table, and when that hides

The exercise's `npm run like`, a million comments, no index:

```
── A. no index: ILIKE '%…%' ───────────────────────── time       found
   count all "deploy"                             390.4 ms    281,022
   count all "rollback" (rare word)               409.3 ms      9,117
   first 20 "deploy" (common word)                  0.5 ms         20
   first 20 "rollback" (rare word)                  2.7 ms         20
   first 20 "recieve" (misspelled — none exist)   398.0 ms          0
   plan, all "deploy" (in 28% of rows): Aggregate ← Gather · 15,584 pages
```

"Count" reads the whole table — 15,584 pages, searching character by character in every row's text. But look at the middle two rows: "first 20 deploy" is **0.5 ms**. Because Postgres starts reading from the front, and "deploy" is so common that it finds 20 within the first few hundred rows and stops.

That's incident 1's trap. The engineers' tests use common words — fast. A large share of users' real searches are rare words, or things that don't exist — misspellings, deleted things. "None" means 20 are never found, so it goes to the last row — **398 ms**, every time. And with search-as-you-type, "r", "re", "rec", "reci" … — every keystroke is a full table scan. And Lesson 1.3's arithmetic: if the table grows tenfold, so does this time.

**Why a B-tree doesn't help — the spaced repetition answer.** Inside a B-tree the values are kept in sorted order (Lesson 5.4). "Starts with deploy" is one contiguous stretch of that order — you can descend the tree to it. But "has deploy anywhere" isn't a contiguous stretch of the sorted order — "a deploy…", "fix the deploy…", "zzz deploy" are scattered all over the dictionary order. It's the same as searching a composite index without its leftmost column.

```
── B. B-tree index, lower(body) text_pattern_ops (1.07 s to build, 113 MB) ──
   lower(body) LIKE '%deploy%' → Aggregate ← Gather · 15,584 pages
   lower(body) LIKE 'deploy%'  → Aggregate ← Bitmap Heap Scan · 11,678 pages   ← only "starts with deploy"
```

A 113 MB index, and for `'%deploy%'` Postgres doesn't even touch it. It's useful for prefixes (autocomplete on task titles — question 1), but not for finding "a word in the middle of a comment".

### 1.2 Trigrams — an index for substring search

**Trigram** — every run of three consecutive characters in a text ("deploy" → `dep`, `epl`, `plo`, `loy`, plus a few at the start and end); a trigram index keeps, for each trigram, the list of rows it appears in, so `'%deploy%'` can be turned into "rows that have all four of these trigrams".

In Postgres this is the `pg_trgm` extension, as a GIN index:

```
── C. pg_trgm GIN index (12.35 s to build, 81 MB) ────── time       found
   count all "deploy"                             174.8 ms    281,022
   count all "rollback" (rare word)                14.2 ms      9,117
   first 20 "rollback" (rare word)                  1.9 ms         20
   first 20 "recieve" (misspelled — none exist)     0.5 ms          0
   plan, all "deploy" (in 28% of rows): Aggregate ← Gather · 15,840 pages
   plan, all "rollback" (rare):     Aggregate ← Bitmap Heap Scan · 6,995 pages
```

- **Rare words:** from 409 ms to 14 ms — the index says which rows to look at, and the rest aren't touched.
- **None:** from 398 ms to 0.5 ms — "rec", "eci", "cie", "iev" together exist nowhere, and the index alone tells you so. The biggest part of incident 1 is fixed.
- **Counting a common word:** the planner still reads the whole table (`Gather`) — "deploy" is in 28% of rows, and reading straight through is cheaper than fetching 280 thousand rows one by one from the index. (The difference between 390 and 175 ms in the two sections isn't the index — the plan is the same; the difference is the cache.) No index makes "give me half the table" fast.

And the cost — like any index (Lesson 5.4), and quite heavy here: the index is 81 MB, two-thirds of the table; 12 seconds to build; and as you'll see below, every new comment write gets 4.7 times slower.

Trigrams have another strength for incident 3: misspellings. How many trigrams two words share lets you find "nearby" words:

```
── Misspellings: trigram similarity against the word list ("did you mean") ──
   "recieve" → receive (0.33)
   "deplyo" → deploy (0.40), deploying (0.31)
   "chekclist" → checklist (0.43)
```

But trigrams still search **substrings** — "art"'s trigrams are in "start" too. So the first half of incident 2 remains.

### 1.3 What search actually wants — words, their forms, and the analyzer

When a user types "art", they're looking for a **word**, not a sequence of characters. And when they type "deploying", they want any form of "deploy". In the exercise, the same comments counted two ways:

```
── Words vs substrings: what matches ──
   ILIKE '%deploy%': 281,022 (including redeploy) · full-text "deploy": 267,943 (including deployment, deploying; redeploy excluded — a separate word, 18,319 of them)
   ILIKE '%art%': 175,420 (start, party, article, smart …) · full-text "art": 9,104
   ILIKE '%log%': 105,336 (login, blog, catalog) · full-text "log": 0
```

Of "art"'s 175,420 substring matches, only 9,104 are the actual word "art" — the other 95% are wrong results. And the word "log" doesn't appear once, yet as a substring it matches over 100 thousand.

The difference comes from running text through a process before searching it:

**Analyzer** — the steps that turn text into units of search (terms): splitting into words (tokenization), lowercasing, dropping very common, meaningless words (stopwords — "the", "to", "is"), and reducing words to their root (stemming — "deploying", "deployment" → "deploy"). The same analyzer runs on documents at write time and on queries at search time — so the terms on both sides match.

```
  "Deploying the release notes after review."
       │ split into words, lowercase
       ▼
  deploying · the · release · notes · after · review
       │ drop stopwords (the, after)
       ▼
  deploying · release · notes · review
       │ stem
       ▼
  deploy · releas · note · review            ← these are what go into the index
```

(The stems look odd — "releas" — because the point isn't making words, just giving forms of the same root the same key: release, released, releasing → releas.)

One important limit: **analyzers are language-specific.** The English stemmer does nothing to Bangla words. Postgres's built-in text search configs have no Bangla (Postgres 17 has hindi, nepali and tamil — not `bengali`) — for Bangla comments it can only offer `simple` (splitting and lowercasing, no stemming); Elasticsearch/OpenSearch have a `bengali` analyzer. And changing the analyzer means rebuilding the whole index — because what's in the index is the old analyzer's output.

### 1.4 Inverted Index — from words to documents

After the analyzer, each document is a list of terms. Now flip it around:

**Inverted index** — a map from each term to the list of documents containing that term — like the index at the back of a book ("deploy — pages 12, 47, 90"); the reverse of "which words are in a document", hence "inverted".

**Posting list** — for one term, the list of ids of the documents containing it, sorted by id — often with how many times the term appears in each (term frequency) and at which positions.

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

Now the answer to "deploy checklist" is the overlap of two short lists — no document has to be read. The exercise's `npm run inverted` builds this itself, in TypeScript, over 200 thousand comments:

```
── 1. Building the index: 200,000 comments ──
   time 1181.2 ms · distinct terms 5,030 · postings 1,879,748 (~14 MB, id + tf)
   stopwords dropped: 1,083,698 / 3,098,532 words (35%) — kept, each list would be huge; share of documents: the 24%, a 24%, to 24%
   longest posting lists: kax 112,242 · lox 68,330 · deploy 53,634 · mix 48,866 · rax 37,970

── 2. "deploy checklist" — comments containing both words ──
   full scan, substring (like LIKE)               16.2 ms   4,301
   full scan, with the same analyzer             430.4 ms   4,129
   inverted index (intersecting posting lists)     1.4 ms   4,129
```

- Stopwords alone are 35% of all words. Kept, each one's posting list would span about a quarter of all documents — helping no search, just taking space. (Modern engines sometimes keep stopwords — for phrases like "to be or not to be" — and deal with them through ranking, below.)
- A full scan with the same analyzer takes 430 ms, the index 1.4 ms — the same answer. With a million comments in experiment 4: scan 2030 ms, index 4.6 ms — and 20,293 results, exactly the same as Postgres's full-text (below). A scan grows with the number of documents; the index grows only with the length of the posting lists it intersects.
- (The substring scan is 16 ms — JavaScript's `includes` is very fast in memory — but the result is wrong: 4,301, because "redeploy" matches too.)

**Intersecting posting lists — order matters.** A very common word and a rare word together:

```
── 3. "kax AND rollback" — one very common (112,242 docs), one rare (1,785) ──
   walking both lists side by side (merge)         0.7 ms   comparisons   112,808   results 1037
   start from the short list, binary search        0.4 ms   comparisons    29,087   results 1037
```

Walking side by side touches nearly all of the long list; starting from the rare word and jumping into the long one (binary search, or "skip lists" in a real engine) needs a quarter of the comparisons. It's a tiny query planner — Lesson 5.4's idea of "the most selective condition first".

**Postgres has this inside.** Postgres's GIN (Generalized Inverted Index) is exactly this — a trigram index is an inverted index too (trigrams instead of terms). For full-text search:

```
── D. Full-text search: tsvector + GIN (11.56 s to build column and index, index 25 MB, table now 264 MB) ──
   count all "deploy"                             102.0 ms    267,943
   "deploy checklist" (both present)               18.2 ms     20,293
   best 20 "deploy checklist" by ts_rank           23.4 ms         20
   "recieve" (misspelled)                           0.4 ms          0
```

`tsvector` is the analyzer's output (the terms, with positions), and GIN is its inverted index. The index is only 25 MB — a third of the trigram index's 81 MB, because there are far fewer terms (5 thousand words vs countless trigrams). But look at the table: from 122 MB to 264 MB — the `tsvector` is kept in a separate column (stored). Experiment 1: an expression index without the column (`gin (to_tsvector('english', body))`) — the table stays at 122 MB, queries take about the same time (~40–55 ms); the cost: recomputing `to_tsvector` for every matching row, and queries have to use exactly the same expression.

In TaskFlow's stack, with Sequelize (an example — the exercise runs its queries in raw SQL; this Sequelize part wasn't run):

```typescript
// migration: a generated column and GIN — Sequelize has no type for these, so raw SQL
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
	return z.array(hitSchema).parse(rows); // the result of a raw query — parse, not a type assertion
}
```

(`websearch_to_tsquery` understands Google-style queries typed by users — `deploy -staging`, `"release notes"`. `ts_headline` gives a snippet of the result with the matched words highlighted.)

**The cost of writes:**

```
── Write cost: inserting 20,000 new comments (1000 at a time) ──
   primary key only       114.9 ms   1.0×
   + trigram GIN          541.8 ms   4.7×
   + full-text GIN        321.5 ms   2.8×
```

15 words in a comment means adding one entry to 15 separate posting lists in the inverted index — far more work than one entry in one place in a B-tree. Postgres's GIN softens this with a "pending list" (`fastupdate`): new entries collect in a small list first, and go into the main index later, together — a relative of Lesson 5.3's LSM idea. (And Elasticsearch's Lucene goes fully down this path: new documents go into small immutable "segments", later merged into bigger segments in the background — almost exactly an LSM.)

### 1.5 What comes first — relevance

20 thousand comments contain both "deploy" and "checklist". Which 20 go on the first page? "Newest" (incident 2) is the easiest answer, but users often want the most **relevant**. Three natural signals of relevance:

- **Term frequency (tf):** the more often a word appears in a document, the more the document is about that topic — but with diminishing returns (ten "deploy"s isn't ten times as relevant).
- **Inverse document frequency (idf):** the **rarer** the word, the more meaningful a match. "deploy" is in 27% of comments — a match is ordinary; "rollback" is in 1% — a match means something specific.
- **Document length:** "deploy checklist" in a 5-word comment means the comment is entirely about that; appearing once in a 500-word discussion means less.

**Relevance scoring (TF-IDF, BM25)** — giving each matching document a score that combines these signals: for each query term, idf × (a curved, length-adjusted form of tf). This BM25 formula is the default today in Lucene, Elasticsearch and OpenSearch.

```
── 4. The top 3 for "deploy checklist" — ordered by BM25 ──
   #25628 score 5.99 · 10 terms · "Dalox kax checklist release deploy mirax of can bax checklist it this to a deplo…"
   #6142 score 5.91 · 2 terms · "Deploy to on checklist and is in."
   #44060 score 5.91 · 2 terms · "To checklist deploy after can a."
   IDF (the rarer, the heavier): deploy 1.32 · checklist 2.66 · rollback 4.72 · kax 0.58
```

The second and third are short — only 2 terms without stopwords, both matching — the length signal. The first is long, but has "checklist" twice and forms of "deploy" twice — tf. And the IDF row: "checklist" weighs twice as much as "deploy", because it's rarer; the very common "kax" weighs almost nothing.

Postgres's `ts_rank` is a bit different: it looks at how often and how close together the words are, but not at how rare a word is across the whole table (idf), because that needs statistics over the whole corpus on every query. (Experiment 2 shows the effect.) For most apps it's enough; if relevance is at the heart of the product (e-commerce, docs search), it's a big difference.

And in practice, the text score alone is never the last word. For TaskFlow a good order is probably: text score + recency (last week's comments first) + the user's own projects + whether the task is still open. Settling that mix is a product decision, and it has to be measured (which results users click).

### 1.6 A separate search engine — when, and its price

Everything so far has been inside Postgres. When a separate system — Elasticsearch, or its open-source fork OpenSearch (created under AWS's lead after Elastic changed its license in 2021)?

**Postgres full-text is enough when:** a few hundred thousand to tens of millions of rows, fitting in one database; you want search consistent with the same transaction (searchable as soon as it's written); roughly-right ranking is fine; and there's nobody to run a separate system.

**A separate engine when:** the data is bigger than one machine, or the search load is high enough that the database needs protecting; fine control over BM25 and relevance (field weights, synonyms, "did you mean"); languages (a Bangla analyzer); built-in misspelling handling (fuzzy queries); facets — "how many of these results per project" (a small form of Lesson 7.6's OLAP); and special indexes for autocomplete.

But a separate engine means **another data store, a copy of the database** — and every question from Modules 5–7 comes back:

- **Sync.** A comment was written to the database — how does the search index find out? "Write it, then send it to Elasticsearch" is Lesson 7.5's dual write — on a crash the comment goes missing from the index. The answer is also 7.5's: outbox (or CDC) → event → a search consumer. And the consumer is idempotent (7.4) — luckily that's natural here: "setting" the whole document by its document id (upsert) gives the same result even ten times. Just one subtlety: an old event arriving late can overwrite a newer one — so each document carries a version (the database's `updatedAt` or a counter), and the engine is told "write only if the version is higher" (Elasticsearch's external versioning — the idea of 6.3's version token).
- **"I wrote it but I can't find it."**

**Near real-time search (refresh)** — a new document written to the index doesn't show up in search results immediately; the engine makes new writes searchable at fixed intervals ("refresh" — 1 second by default in Elasticsearch). So there's a small window between writing and being findable.

Add the outbox relay's delay (p99 ~450 ms in 7.5) and the consumer's delay — altogether a second or two. A user who writes a comment and searches right away doesn't find it — Lesson 6.3's read-your-writes, in a new place (question 3).

- **Permissions.** In the database, `WHERE workspace_id = :id` is a join or a condition — and forgetting it is a bug in just one place. In the search index, every workspace's comments are together; the workspace filter is **mandatory** on every query, and forgetting it in a single place means one customer sees another's comments. And when someone is removed from a workspace, or a comment is deleted — it stays in the index until sync catches up (question 2).
- **The rules of scale.** The index is usually sharded by document (Lesson 5.8): each shard has its own small inverted index, and a query goes to every shard (scatter-gather), each returns its own best 20, and they're merged. One subtlety: BM25's idf is computed on each shard from its own data — so on small indexes scores differ slightly between shards. And deep pagination is expensive — page 500 means every shard has to build and send 10,000 results; so by default Elasticsearch won't serve `from + size` beyond 10,000 (`index.max_result_window`), and going deeper uses `search_after` — Lesson 2.5's cursor pagination.
- **Rebuilding.** Changing the analyzer or mapping means building the whole index anew — from the database (8.1's and 7.2's warning: the source of truth is the database, not the index). Doing it without downtime means building the new index alongside and switching an alias.

### 1.7 TaskFlow's decision

TaskFlow has a million comments, a few thousand new ones a day, and a search load that can't yet overwhelm the database — **Postgres now, OpenSearch later if needed.**

- **Comments, task titles, attachment names:** a `tsvector` + GIN on each. Titles weigh more (Postgres's `setweight` — `A` for the title, `B` for the body). Queries through `websearch_to_tsquery`, ordered by `ts_rank` + recency, and **always** with the `workspace_id` filter — the search function's signature doesn't accept anything without this workspaceId.
- **Misspellings:** a word list (all of the workspace's terms, built nightly from `ts_stat`), with a trigram index on it — "did you mean" when no results come back.
- **Task title autocomplete:** a B-tree on `lower(title) text_pattern_ops` (prefix — 1.1), on titles only, at most 10, after 2 characters, debounced in the frontend.
- **No `ILIKE '%…%'` anywhere else** — on the code review checklist.
- **Signals to move to OpenSearch:** a need for searching Bangla comments; facets; search load being a big share of the database's CPU; or tens of millions of documents. Then: outbox → `comment.*`/`task.*`/`attachment.*` events → a search consumer (upsert with versions), queries with the workspace filter, and the user's own new comments shown in the frontend right away (for read-your-writes).

> **Trade-off Table — how TaskFlow searches**

| Approach                          | What matches                              | Slow when                                          | Misspellings         | Ranking                     | Write cost            | Sync / consistency                         | When                                                  |
| --------------------------------- | ----------------------------------------- | -------------------------------------------------- | -------------------- | --------------------------- | --------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `ILIKE '%…%'`, no index           | Substring (art → start)                   | Always, for rare or absent words — the whole table | No                   | No                          | None                  | Same transaction                           | Small tables, admin tools                             |
| B-tree (`text_pattern_ops`)       | Prefix only                               | Useless for words in the middle                    | No                   | No                          | Low                   | Same transaction                           | Autocomplete (the start of a title)                   |
| `pg_trgm` GIN                     | Substring, fast                           | Very common fragments (half the table)             | **Yes** (similarity) | No                          | High (4.7×)           | Same transaction                           | Codes, ids, names — where you do want substrings      |
| Postgres full-text (tsvector+GIN) | **Words**, with stems                     | Counting very common words                         | No (add trigrams)    | `ts_rank` (no idf)          | Medium (2.8×)         | Same transaction — searchable once written | Up to tens of millions of rows, roughly-right ranking |
| Elasticsearch / OpenSearch        | Words, language-aware analyzers, synonyms | —                                                  | Yes (fuzzy)          | BM25 + fine control, facets | On a separate cluster | Eventual — sync + refresh (~1 s)           | Big data, relevance at the core, languages, facets    |

---

## 2. Interview Angle

**"Design a search feature" (or "design Twitter search", "design an e-commerce search").** — the order of a good answer: why not the database's `LIKE` (full scan, substrings, no ranking — with one number); what an inverted index is (term → posting list, analyzer); ranking (BM25 + business signals); and then the real system design part — **how the index stays in sync** (outbox/CDC → consumer → upsert, eventual), **how it's sharded** (by document, scatter-gather), and **permissions**. Most candidates stop at the inverted index; the person who talks about sync and permissions has run it in production.

**"What is an inverted index?"** — a one-sentence definition, then the picture (term → sorted doc ids), then how an AND query works (intersecting posting lists, starting from the shortest), then why writes are expensive (one document goes into many lists). Bonus: the similarity between Lucene's segments and an LSM.

**"A user wrote a comment and can't find it — why?"** — Near real-time: sync delay + the refresh interval. The answer: how long is acceptable, and showing the user's own writes in the UI immediately (6.3), or waiting for a refresh on that request (Elasticsearch's `refresh=wait_for` — with its cost).

**In real production:** the best-known incidents: a query missing the tenant filter (showing someone else's data); a gap silently building up between the index and the database (lost events, a stopped consumer) — hence a regular reconciliation job (counts, samples); a mapping change that means rebuilding the whole index, which takes hours; and search-as-you-type sending a full scan to the database on every keystroke — incident 1.

---

## 3. Key Takeaway

- `ILIKE '%x%'` reads the whole table; with `LIMIT` a common word looks fast (0.5 ms), but a rare or absent word means the whole table every time (398 ms) — and those are exactly what users search. A B-tree only helps with prefixes — there's no contiguous stretch of "contains it in the middle" in sorted order
- A **trigram** index speeds up substrings (rare word 409 → 14 ms, "none" 398 → 0.5 ms) and catches misspellings — but it's still substrings ("art": 95% wrong results), the index is heavy, and writes get 4.7× slower
- An **analyzer** (split into words, lowercase, stopwords, stem) turns text into terms — the same on the write side and the search side; it's language-specific (no Bangla in Postgres)
- **Inverted index** = term → **posting list** (sorted doc ids + tf); AND means intersecting lists — starting from the rare one needs a quarter of the comparisons; at a million, scan 2030 ms vs index 4.6 ms. Postgres's GIN is exactly this
- **Relevance**: tf, **idf** (rare = heavy), length — **BM25**; Postgres's `ts_rank` has no idf; and the real order comes from mixing in business signals (recency, your own projects)
- A separate engine is a copy of the database: sync through outbox/CDC (upsert with versions), **near real-time** (refresh ~1 s) and so a read-your-writes question, a tenant filter on every query, sharding by document with scatter-gather, and cursors for deep pagination
- TaskFlow: Postgres full-text now (titles weighted higher, workspace filter mandatory) + "did you mean" via trigrams + autocomplete via a prefix B-tree; OpenSearch when language, facets, load or size demand it

---

## 4. New Terms (Glossary)

| Term                                  | Meaning                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigram**                           | A run of three consecutive characters of a text; a trigram index keeps a list of rows for each trigram — speeding up substring search and misspelling matches |
| **Analyzer**                          | The steps that turn text into terms — split into words, lowercase, drop stopwords, stem; the same on the write and search sides, and language-specific        |
| **Inverted Index**                    | A map from each term to the documents that contain it — like a book's index; the basis of Postgres's GIN and of Lucene/Elasticsearch                          |
| **Posting List**                      | A term's list of document ids, in id order — often with term frequency and positions; an AND query means intersecting them                                    |
| **Relevance Scoring (TF-IDF / BM25)** | Scoring matching documents: how often the word appears (tf), how rare it is (idf), how long the document is — BM25 is the default in today's search engines   |
| **Near Real-Time Search (Refresh)**   | Newly written documents become searchable not immediately but at fixed intervals (1 s by default in Elasticsearch) — a window between writing and finding     |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines for each, in your own words.

1. Autocomplete on TaskFlow's task titles: suggestions on every keystroke as the user types. 50 thousand active users, each searching 20 times a day on average, 6 characters each on average. (a) If every keystroke sends a request, how many queries per second in the busiest hour (20% of the day's searches)? (b) Which index — a prefix B-tree, trigrams, or full-text — and why? (c) What would you do in the frontend and the API to reduce the load on the database?
2. TaskFlow has moved to OpenSearch: one `comments` index with every workspace's comments, and a `workspace_id` filter on every query. (a) What kinds of bugs would let one customer see another customer's comments — at least two situations? (b) A member is removed from a workspace — for how long can they see what? (c) Compare with "a separate index per workspace" — what does it fix, and what new problems does it bring (5 thousand workspaces)?
3. A user wrote the comment "Release 2.1 rollback plan", and immediately searched "rollback" — and didn't find it. Two seconds later, again — found it. Account for those two seconds through the outbox relay (7.5), the search consumer, and OpenSearch's refresh. Give three fixes, each with its cost. Which would you pick?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) 50,000 × 20 = a million searches a day; 6 characters each means 6 million requests. 20% in the busiest hour: 1.2 million ÷ 3600 ≈ **~330 queries/second** — and several times that in a burst of searching.

(b) A **prefix B-tree** on the title (`lower(title) text_pattern_ops`, together with the workspace — `(workspace_id, lower(title) text_pattern_ops)`). Autocomplete is really a "starts with" question — exactly what a B-tree is good at (1.1); the index is small and writes are cheap. Full-text works on words — it won't find "depl" as a word (there's a prefix tsquery `depl:*`, and that works too, but for the start of a title a B-tree is simpler). Trigrams would also match the middle ("oy" → "deploy") — usually not what you want in autocomplete, and the index is heavy.

(c) **Debounce** (send 150–200 ms after typing stops — 6 requests drop to about 1–2); **a minimum of 2 characters**; **limit 10**; cancel old requests (`AbortController` — so a late old answer doesn't overwrite the new one); a small cache (the answer for "de" in the same workspace for a few seconds — Lesson 4.x); and the query always inside one workspace — the index's first column. That brings the 330 down to around 100 in practice, each a ~1 ms index scan.

**Question 2:**

(a) Two situations:

- **A new query path** — say an admin feature for "search across all comments", or a new "similar comments" API — where someone forgot to write the filter. In the database, the same mistake is often caught elsewhere (row level security, joins); in search, the index itself is a mix of every workspace.
- **The filter is there, but from the wrong value** — the `workspaceId` sent by the client (from the URL or the body) put straight into the filter, not taken from the server's session. Then anyone can send another id and search someone else's comments.
- Prevention: a single search function that takes the workspace from the server's session and sets the filter itself (its signature allows no other way); direct OpenSearch clients forbidden in code review; and a test that creates two workspaces and searches one's words as a user of the other.

(b) The removed member: if search **permission** (which workspaces they belong to) is checked from the database/session on every request, then from their first request after removal they get nothing — it doesn't depend on the index's sync. But if the permission is stored in the index's documents (a "who can see this" list on every comment), they can see until sync catches up (seconds, or hours if the consumer is stuck). The rule: fast-changing permissions like "who's in which workspace" come from the database at query time; the index holds only stable partitions (workspace_id).

(c) A separate index per workspace: the risk of seeing someone else's data drops (only if a query goes to the wrong index), deleting a workspace means deleting one index (like 8.1's question 2), and big customers can get separate resources. New problems: 5 thousand indexes — each index has its own shards, and every shard has memory and file overhead; in a small workspace's small index BM25's idf is meaningless (a few hundred documents); a mapping change means rebuilding 5 thousand indexes. The middle path: one index (or a few), routing by workspace_id (all of a workspace's documents on the same shard — Lesson 5.8's shard key), and separate indexes for very large customers.

**Question 3:** Accounting for the two seconds, step by step:

1. The comment's transaction commits — with the outbox row (7.5).
2. The relay picks it up on its next poll and sends it to the stream — p50 ~100 ms, p99 ~450 ms in 7.5's exercise.
3. The search consumer reads it, builds the document (maybe a database query to fetch the task title), and upserts into OpenSearch — a few tens of ms, more if the consumer has lag.
4. The document is written in OpenSearch, but becomes searchable at the next refresh — ~500 ms on average, at most 1 second.

Total: usually 1–2 seconds, more at bad moments.

Fixes:

- **Show your own writes in the UI immediately** — the frontend itself merges the user's recent comments from this session into the search results (optimistic), or the API fetches "what this user wrote in the last 10 seconds" from the database and merges it in. Cost: a little complexity; nothing changes for everyone else — they get it 1–2 seconds later, which is usually fine (Lesson 6.3's read-your-writes is only needed by the writer).
- **`refresh=wait_for` in the consumer** — the write to OpenSearch doesn't return until the refresh happens; the relay and consumer delays remain, and under heavy writes the consumer slows down. Cost: throughput; and the first two steps remain.
- **A shorter refresh interval** (say 200 ms) — cost: many small segments, more merging, higher write cost (Lucene's segments — like an LSM); and the relay/consumer delay still remains.

The pick: the first — the problem really is only the writer's (read-your-writes), and it's fixed most cheaply on the writer's side; the rest of the system can keep its eventual consistency.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (Postgres in Docker; `inverted` doesn't need Docker)

> **Ready to run in the repo:** [`exercises/lesson-8.3-search/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-8.3-search) — `docker compose up -d --wait && npm install && npm run seed`, then `npm run like` and `npm run inverted`. The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in that folder's `README.md`.

`seed` builds a million comments from a fixed formula (comment number i always has the same text). `like` searches four ways — no index, B-tree, trigram, full-text — along with words vs substrings, write cost, and misspellings. `inverted` builds its own inverted index over the same comments — analyzer, posting lists, intersection, BM25.

**Honest note:** verified by running it in the sandbox with Postgres 17: `tsc --noEmit` is clean; `like` several times — in one early run the table was bloated (264 MB) with the space of a `tsv` column dropped by the previous run, and the no-index part was reading twice the pages; so the script now runs `VACUUM FULL` at the start, and the two runs after that gave nearly the same numbers; `inverted` several times, identical apart from timings. The README's experiments 1 and 4 were run, with the numbers in the README; 2, 3 and 5 are code- or setting-changing tasks — yours. In "count all deploy", the time difference between the no-index and trigram sections isn't the index — the plan is the same; the difference is the cache. The comments are generated text, more regular than real ones — the shape is real, the ratios aren't. `inverted`'s analyzer is a toy (an imitation of a few of Porter's rules) — but on this data its result for "deploy checklist" (20,293) matched Postgres's `english` config exactly. The Sequelize example (1.4) wasn't run — the exercise's queries are raw SQL. The statements about Elasticsearch/OpenSearch (1 s refresh, `max_result_window` of 10,000, external versioning, the `bengali` analyzer) come from the documentation, not from running them here. (The scripts print their labels in Bangla; the output shown in this edition is translated — the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Catch the trap:** before running `like`, predict — with no index, "first 20 deploy", "first 20 rollback", "first 20 recieve" — which is fast, which is slow, and why. Then compare. Which kind of query really sets TaskFlow's search p99?

2. **The limits of trigrams:** why is the plan for "count all deploy" in the trigram section a `Gather` (the whole table)? Look at `ILIKE '%deploy checklist%'` and `ILIKE '%eploy%'` with `EXPLAIN` — where does the index help? Then experiment 5 — why are trigrams weak for short words?

3. **Inside your own index:** roughly calculate by hand the comparison counts in `inverted.ts`'s number 3 (merge: the sum of the two lists; from the short one: 1,785 × log₂(112,242)). Then experiment 3 (keep stopwords) — how much did the postings grow, and what happens with "the deploy"?

4. **Comparing rankings** (experiment 2): put Postgres's `ts_rank` top 5 and your BM25 top 5 for "kax deploy" side by side. Where do they differ, and why (idf)? Which seems right for TaskFlow?

5. **The design part:** a one-page design for TaskFlow's search: (a) what can be searched (comments, task titles, attachment names) and the weight of each; (b) the permission rule for every query — where the workspace comes from, where the filter goes; (c) the paths for autocomplete and "did you mean"; (d) which numbers would make you move to OpenSearch, and if you did, the sync path (which events, consumer, versions) and the read-your-writes fix; (e) a regular job to catch gaps between the index and the database.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7 (complete, including exit challenges), 8.1, 8.2, 8.3
Current: 8.3 — Search & inverted index (the last lesson of Module 8)
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; outbox → Redis Streams, BullMQ; attachments: metadata in the database,
bytes in object storage, presigned uploads (multipart above 100 MB), downloads via CDN signed URL/cookie;
search: Postgres full-text (tsvector + GIN; comments, task titles (weight A), attachment names),
websearch_to_tsquery, ts_rank + recency, workspace filter mandatory; "did you mean" on a trigram
word list; title autocomplete on a prefix B-tree (debounce, 2 characters, limit 10); ILIKE '%…%' banned;
OpenSearch later (language/facets/load/size) — outbox → search consumer, upsert with versions
Terms learned (Module 8): Object Storage, Bucket / Key (Prefix), Object Metadata, Durability,
Erasure Coding, Failure Domain, Storage Class / Lifecycle, Presigned URL, CORS / Preflight,
Multipart Upload, Resumable Upload, Cache Key, CDN Signed URL / Signed Cookie, Trigram, Analyzer,
Inverted Index, Posting List, Relevance Scoring (TF-IDF / BM25), Near Real-Time Search (Refresh)
Weak spots: [where you got stuck — fill this in yourself]
Next: Module 8 Exit Challenge
=======================
```

---

## 8. Next Step

Run the exercise and send it over — especially your "what sets the p99" from #1 and your design from #5. This is the last lesson of Module 8. When you are ready, write `next` — we'll go to the **Module 8 Exit Challenge**: a mini design challenge (Tier 3) where the whole module is needed together — where to keep the bytes, how they survive, the upload and download paths, the CDN, and search — in a realistic scenario; a "you should be able to do these" checklist; and recommendations for books, videos and projects. Then Module 9 — Microservices & Service Architecture: TaskFlow is now a monolith with queues, events, object storage and search inside; when to break it into separate services — and when **not** to.
