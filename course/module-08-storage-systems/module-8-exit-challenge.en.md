# Module 8 - Exit Challenge (Storage Systems)

**Module 8 - Storage Systems**

Module 8's three lessons are done - where to keep bytes and how object storage survives inside, how big files are uploaded and downloaded (presigned URLs, multipart, CDN), and how to search (inverted indexes). In each lesson we measured one question on its own. In real life, all of it arrives together in a new feature's first month - and the old questions from Modules 5–7 (dual writes, eventual consistency, idempotency) often come back in a new form. This Exit Challenge is that kind of month.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** Last month TaskFlow launched "Recordings & Docs" - attaching screen recordings, design files and PDFs to tasks, and searching inside all of it. You've been handed the whole month's incidents for an incident review. Its current state (some decisions follow this module's lessons, some don't):
>
> - **Bucket:** a single bucket `taskflow-files`, versioning on, no lifecycle rules. Key: `uploads/{userId}/{originalFileName}`.
> - **Upload:** the browser uploads straight to the bucket with a presigned PUT; the URL's expiry is **7 days** ("so big uploads don't expire midway"). Only the key is signed - not the content-type or size. Above 1 GB, multipart, 64 MB parts. When the upload finishes, the browser sends `POST /complete` with `{ key, size, etag }`; the API uses those to mark the row `ready` directly.
> - **Download:** a presigned GET per file for the user (1-hour expiry), with a CDN in front - the CDN's cache key is the full URL. Files are served via `app.taskflow.test/files/…` (Nginx proxying to the bucket).
> - **Cleanup:** a nightly job matches the bucket's LIST against the database's `attachments`; it deletes objects that have no row. The job reads from a **read replica**.
> - **Search:** for the first two weeks, `Comment.findAll({ where: { body: { [Op.iLike]: '%…%' } } })`, on every keystroke (search-as-you-type). Then it moved to OpenSearch: after writing a comment, the API `index`es it into OpenSearch directly (without `await`, with `.catch(() => {})`). The query's workspace filter comes from the `workspaceId` sent by the client.
> - **Proposal:** an infra engineer says, "the S3 bill is high - let's run our own object store on our 4 racks, erasure coding 6+3, fragments on any disk."
>
> **The month's incidents:**
>
> 1. **The object storage bill** is 4 times the expected amount. Broken down: a big share is "noncurrent versions", another share is space that doesn't show up in any LIST of objects, and the egress line is separately very high.
> 2. **The 9th:** 120 files belonging to a design agency vanished - rows in the database, no objects in the bucket. That night the replica was 40 minutes behind (a big migration). The cleanup job's log shows those 120 keys deleted as "orphans".
> 3. **The 14th:** a link to a customer's confidential PDF is circulating in a public Slack channel - a presigned **PUT** URL, copied by someone from the customer's Nginx access log. And someone used that URL to overwrite the file with a different file.
> 4. **Support tickets:** "it's in the file list, opening it gives 404" (37 of them) - and "the upload showed 100%, but the file is stuck on 'processing…'" (52). And after two users uploaded files with the same name, one person's file was replaced by the other's.
> 5. **Webinar day:** 400 people opened a 200 MB recording. The CDN's hit rate was 0%, 80 GB left object storage, and viewers in Singapore said the video took 15 seconds to start.
> 6. **Security report:** a researcher showed that if you upload an `.html` file and send someone its link, the file opens from `app.taskflow.test`, and the script inside it can call TaskFlow's API with the user's session.
> 7. **Search, the first two weeks:** at 10 a.m. the database's CPU was at 90% and search's p99 at 600 ms - most of the slowest queries returned no results. And searching "art" gave a first page of "start" and "party".
> 8. **Search, after OpenSearch:** (a) deleted comments keep showing up in search for hours, and some new comments never arrived - OpenSearch was down for 2 minutes during a deploy; (b) one customer saw parts of another customer's comments - in the new "similar comments" API; (c) users say "when I write a comment and search right away, I can't find it."
> 9. **The manager's question:** "S3's durability is 11 nines - so how did we lose files on the 9th? And would our own racks be even better?"

Your task - for each question below, make a decision by applying Module 8's concepts (and earlier modules' where relevant), with reasoning. Where possible, answer **with numbers**.

**1. The bill's three parts (Lesson 8.1 + 8.2)**
"Noncurrent versions", "space not visible in LIST", and egress - where does each come from, from which decision in this setup? Give a lifecycle rule or a design change for each (how many days, which class). Using TaskFlow's size (1.5 TB new per month, each file opened 5 times on average), calculate the monthly egress - with and without a CDN.

**2. 120 files vanished (Lesson 8.1 + 5.7 + 7.4)**
Show on a timeline how a lagging replica turned real files into "orphans". Which way was the dual write supposed to fail here (8.1's "object first, row second"), and how did the cleanup job turn that rule upside down? Can the files be recovered - because of which feature, and until when? Give at least four safeguards for the cleanup job (where it reads from, how old, what it logs first, how it deletes).

**3. The leaked presigned URL (Lesson 8.2)**
What could someone do with this URL, and why - which three decisions (expiry, what's signed, the key rule) made the damage bigger? Give the right value for each. If you shorten the expiry, how do you handle the fear that "a big upload expires midway" (a URL per multipart part)? And what's the way to prevent the overwrite?

**4. "There but 404", "stuck", and the same name (Lesson 8.2 + 8.1 + 7.5)**
Give the cause of each of the three tickets separately. What goes wrong when the complete step trusts the `size`/`etag` sent by the browser? Write the attachment's state union (a discriminated union), who triggers each transition (the browser, object storage's event notification, a job), and make complete idempotent. What should the key rule be, and why shouldn't the user-given name be in the key?

**5. The webinar (Lesson 8.2 + 4.5)**
Why is the hit rate 0% despite the CDN - in one sentence, using the cache key. Give the corrected design: which kind of signed permission, who verifies it, what the cache key is, who can read the bucket. 400 people × 200 MB - after the fix, roughly how much leaves object storage? What else for Singapore's 15 seconds (range requests for video - 8.1)?

**6. `.html` and XSS (Lesson 8.2)**
Write out the researcher's attack step by step. Give three defences (domain, headers, content-type verification) - and why none of them is enough on its own.

**7. The first two weeks of search (Lesson 8.3 + 5.4)**
The arithmetic for 10 a.m.'s 90% CPU: say 2000 people are active at once, each searching once a minute, 6 characters each on average, and every "found nothing" query is a ~400 ms full scan - how many queries/second, how many CPU-seconds/second? Why are "queries with no results the slowest"? And why "art → start"? Without moving to OpenSearch, using only Postgres, what would you do (at least four steps)?

**8. OpenSearch's three problems (Lesson 8.3 + 7.5 + 7.4 + 6.3)**
(a) Deleted comments staying and new comments not arriving - what is this sync problem called, and which pattern fixes it? How would you stop an old event overwriting a newer one? How would you find and repair the gaps that have already piled up? (b) The permission leak - two separate mistakes (no filter, the filter's value from the client) - the prevention for each. (c) "I can't find it right after writing it" - the sources of delay (the sync path, refresh) and which fix you'd pick.

**9. Our own racks and "11 nines" (Lesson 8.1 + 5.9)**
(a) The answer for the manager: what 11 nines protects against, and what not - which category does the 9th's incident fall into? And which three things protect against incidents of that category? (b) EC 6+3 on 4 racks, fragments on any disk - what happens when one rack goes down, and why (remember `RACKS=4` from 8.1's exercise)? Which scheme makes sense with this number of racks? (c) Beyond cost, what else would you account for (repair time, people, on-call) - your recommendation in one paragraph.

**10. The design doc and priorities (Lesson 8.1–8.3)**
(a) A one-page design doc for "Recordings & Docs": the bucket and key rules; the upload path (what's signed, what expiry, when multipart, part size); the attachment's state and complete; downloads and the CDN; lifecycle; cleanup; search (Postgres or OpenSearch, sync, permissions).
(b) A **priority list**: what this week (before it happens again), what this month, what this quarter - beside each, which lesson, and how you'll measure success (which metric, which number).

**Things to remember:** in this module there are three places where it's easiest to go wrong - (a) **thinking object storage is a file system** - no rename, no folders, no partial writes, and what doesn't show up in LIST is billed too; (b) **thinking "durable" means "safe"** - durability saves you from hardware, not from your own jobs, bugs, and leaked permissions; (c) **treating a copy as the source of truth** - the CDN, the search index, a replica - every copy can lag behind, so **deleting** something or **granting** someone permission based on it is dangerous. All three are in today's scenario, several times over. And Module 8's most important habit: for every file, ask - **"who owns these bytes, which source of truth says it should exist, and who can read or change it, and for how long?"**

I'll critique this step by step.

---

## 2. Self-Check - You Should Be Able to Do These by Now

- [ ] I can tell block, file and object storage apart; why object storage writes whole objects, and why a "folder" is only a prefix
- [ ] I can state the three costs of keeping files in the database (WAL and replicas, backup/restore, serving through the app) with numbers - and when it's still fine
- [ ] Why files on the app server's disk break statelessness, and why sticky sessions don't save the teammate
- [ ] I can draw an object store's internal structure (metadata index and bytes kept apart, the Haystack idea)
- [ ] The difference between durability and availability; where replication vs erasure coding fit, and the durability arithmetic; why spreading across failure domains is a precondition - and what "11 nines" doesn't protect against
- [ ] The S3 API's rules: strong read-after-write (and verifying it on other systems), last writer wins and conditional writes, range reads, the ETag, versioning, storage classes and lifecycle
- [ ] The key rule (immutable, no user-given names, a tenant prefix) and the order of writing to two places (object first, row second, orphan cleanup - done safely)
- [ ] Why uploads shouldn't go through the app - memory, connections, time (with Little's Law)
- [ ] How presigned URLs work; what has to be signed and why; the risk of bearer permissions and expiry; what CORS is and what it isn't
- [ ] Multipart upload: why, the part size trade-off, resuming with `ListParts`, unfinished uploads and their lifecycle
- [ ] The life of an upload (pending → ready/rejected), confirming without trusting the browser, an idempotent complete, and an event → processing when the upload finishes
- [ ] A CDN for private files: why everyone's presigned URL breaks the cache, CDN signed URLs/cookies, and user content from a separate domain
- [ ] Why `LIKE '%x%'` doesn't scale (and the `LIMIT` trap); where a B-tree helps; what trigrams fix and what they don't
- [ ] I can draw the analyzer, inverted index and posting lists on a whiteboard - building and searching (the order of intersection); BM25's three signals
- [ ] How I'd choose between Postgres full-text and Elasticsearch/OpenSearch; with a separate engine, the rules for sync (outbox, versions), near real-time, permissions, shards and pagination

---

## 3. Recommendation

**To read:**

- **Doug Beaver et al. - "Finding a needle in Haystack: Facebook's photo storage" (OSDI 2010).** The source of 8.1's "metadata and bytes kept apart"; short, clear, and the best explanation of why file system metadata collapses at billions of files. Its follow-up paper - **"f4: Facebook's Warm BLOB Storage System" (OSDI 2014)** - the real-world arithmetic of erasure coding and failure domains.
- **The AWS S3 documentation - "Amazon S3 data consistency model", "Uploading and copying objects using multipart upload", "Sharing objects with presigned URLs", and the section on conditional requests.** The real source of nearly every rule in 8.1 and 8.2 - read with an eye on the dates; the rules have changed over time.
- **Christopher Manning, Prabhakar Raghavan, Hinrich Schütze - _Introduction to Information Retrieval_.** Inverted indexes, posting list intersection, tf-idf, compression - the whole theory of 8.3. The book can be read free on the authors' website; the first six chapters are enough.
- **The PostgreSQL documentation - the "Full Text Search" chapter and the section on `pg_trgm`.** The Postgres side of 8.3 - analyzers (text search configurations), ranking, index types.
- **Martin Kleppmann - _Designing Data-Intensive Applications_, the "Full-text search and fuzzy indexes" section of chapter 3, and "Keeping Systems in Sync" in chapter 11.** Seeing a search index as a derived copy of the database - 8.3's 1.6.
- **Backblaze's "Drive Stats" blog (every quarter).** How often real disks die, by model and manufacturer - for checking the assumptions of 8.1's durability arithmetic against reality.

**To watch:**

- **AWS re:Invent's S3 deep dive talks** (from various years - "Deep dive on Amazon S3" or talks on S3's internal design). How a giant object store handles repair, durability and consistency - from the people inside. Check the year; a lot has changed inside.
- **Elasticsearch/OpenSearch's own introductory "how search works" talks, and the "Near real-time search" and "Scalability and resilience" sections of the documentation** - segments, refresh, shards, replicas - the details behind 8.3's 1.6.

**For a project:**

- **Your own small object store:** metadata in Postgres (key → which offset in which file), bytes in a few big append-only files (like Haystack); PUT, GET, Range GET, DELETE (tombstones and later compaction - Lesson 5.3). Then 2+1 erasure coding across three "disks" (folders) with a Reed–Solomon library - delete a folder and recover the file.
- **TaskFlow's resumable uploader, end to end:** a SvelteKit page, presigned multipart (a URL per part, right before it's needed), progress and retry in the browser, resuming with `ListParts` after the tab closes, and on the server a pending → ready union, with the same idempotent complete via three paths - event notification + job + browser. Break it by setting the network to "Slow 3G" or offline in Chrome's DevTools.
- **A search service, as a copy of the database:** outbox (7.5) → consumer → OpenSearch (upsert with versions, routing by workspace); and a nightly "reconcile" job that compares counts and samples between the database and the index, and reindexes when it finds gaps. Then stop the consumer for an hour - what does the job catch?

---

Do the exit challenge and send it over. When you are ready, write `next` and we'll move to **Module 9: Microservices & Service Architecture** - starting with Lesson 9.1: Monolith vs Microservices - when to split, and when **not** to.

Across Module 8, new systems have been attached around TaskFlow - object storage, a CDN, a search index - each outside the database, each with its own rules, and each with its own question of sync. Yet TaskFlow's code is still one Express app: tasks, comments, attachments, search, billing, notifications - all in one repo, in one deploy. The team is growing, and with every deploy someone breaks someone else's work. Module 9's question: should this one app be split into separate services - and if it is, how many times harder does everything we learned in Modules 5–8 (dual writes, eventual consistency, idempotency, transactions in one place) become?
