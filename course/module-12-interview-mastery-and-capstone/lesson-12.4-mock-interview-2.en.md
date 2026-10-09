# Lesson 12.4 - Mock Interview #2: Harder, with Follow-up Questions

**Module 12 - Interview Mastery & Capstone**

> **Spaced Repetition (Lesson 6.4):** Between a Lamport clock and a vector clock, which can tell that two events happened "at the same time" (concurrent), meaning neither affected the other? One line, with the reason. Then go into the mock. One follow-up stands on exactly this question, and the answer may surprise you: this system may not need a vector clock at all. The answer comes after the mock, in 1.4.

**Prerequisite:** Lesson 12.3 (the mock's rules and your score), Lesson 5.5 (optimistic lock), Lesson 5.8 (Sharding), Lesson 6.4 (Logical clocks, siblings), Lessons 8.1 and 8.2 (Object storage, presigned URLs, multipart), Lesson 11.3 (Connection gateway)

**By the end of this lesson you will be able to:**

1. When the requirements change midway through a 60-minute interview, say which of your earlier decisions broke, and show a way to change the design without throwing all of it away
2. State the core decisions of a file sync system (like Dropbox) with numbers: content-hash blocks, separate paths for bytes and metadata, a change journal and cursors, why keep two copies on a conflict, and the namespace as the unit of sharding
3. Handle the interviewer's push-back (pressure that comes after your answer): accepting the price, with numbers, and saying clearly when you change your position

**Tier:** 3 - Design Exercise (a mock interview; the deliverable is the recording, the score, and a comparison with 12.3's score. No script)

---

## 0. Where TaskFlow Is Right Now

TaskFlow is on the side again today. At the end of 12.3 you brought two things: the rubric's two lowest dimensions, and the experience of an honest recording. Today is about whether those two dimensions move.

This mock is harder for three reasons:

- **A bigger system.** File sync has two completely different worlds of data: the files' bytes (petabytes, object storage) and the metadata (which file, which version, which device knows). Keeping the two apart, and then joining them correctly again, is the core of the question.
- **The requirements change.** Midway, the interviewer will ask for something that was out of scope at the start. And one of the decisions you reasonably took at the start may break because of it. In real interviews this is done on purpose: to see how you adapt.
- **Push-back.** Some follow-ups have a second closed section inside: the interviewer's pressure, which you open **after** your answer. However good your first answer, the interviewer will press on one of its weaknesses.

One line from 12.1 will matter most today: _"Changing your mind on new information isn't weakness."_ Today it gets tested.

---

## 1. Theory

### 1.1 Preparation and rules

All of 12.3's rules, with three changes:

- **50 minutes** (a 60-minute round minus the introductions at the start and the questions at the end). Time box: `Req 5 · Est 5 · HLD 10 · Deep 25 · Wrap 5`. All the extra time goes to the deep dive (12.1).
- **Open the push-back sections** only after finishing your first answer out loud. Then another 1-2 minutes.
- **Before starting,** write 12.3's two lowest dimensions in the corner of the board. When your eye falls on them mid-mock, you'll remember.

### 1.2 The question (00:00)

The interviewer:

> "Design Dropbox. That is, a user's files stay in sync across all their devices."

Start the timer.

<details>
<summary><strong>The interviewer's answers - open after asking your clarifying questions out loud</strong></summary>

Take only the answers to what you asked. Assume you don't know the rest.

| question                             | the interviewer's answer                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| how many users?                      | 50 million registered, ~10 million active daily                                                          |
| how many devices?                    | 2 on average: a computer (desktop client, watches a folder) and a phone (app, downloads files on demand) |
| how much data?                       | ~2 GB per user on average, ~1,000 files                                                                  |
| how often does it change?            | an active user changes or adds ~20 files a day on average; a changed file is ~500 KB on average          |
| the biggest file?                    | up to 50 GB                                                                                              |
| how fast must it sync?               | within ~10 seconds on an online device                                                                   |
| offline?                             | yes: a laptop can edit offline, and syncs when back online                                               |
| old versions?                        | 30 days of history, old versions can be restored                                                         |
| sharing?                             | "Out of today's scope. One user, their own devices."                                                     |
| peak?                                | roughly 3× the average                                                                                   |
| editing together (like Google Docs)? | no. This is file sync, not a document editor                                                             |
| any other question                   | "You decide."                                                                                            |

</details>

### 1.3 The interviewer's follow-ups

<details>
<summary><strong>Follow-up 1 - minute ~13</strong></summary>

> "A 2 GB video file. I changed one byte in the middle of it. What gets uploaded?"

<details>
<summary><strong>Push-back - open after your own answer</strong></summary>

> "Okay. And what if instead of changing one, I **insert** one byte at the **start** of the file?"

</details>

</details>

<details>
<summary><strong>Follow-up 2 - minute ~17</strong></summary>

> "I saved a file on my laptop. How does my phone find out, and how fast?"

</details>

<details>
<summary><strong>Follow-up 3 - minute ~21</strong></summary>

> "Halfway through a 50 GB upload, the laptop's battery dies. What happens when I open it the next day? And did my phone see half a file in the meantime?"

</details>

<details>
<summary><strong>Follow-up 4 - minute ~25 (the requirements change)</strong></summary>

> "A new decision from the product team: we need shared folders, this quarter. A company's team folder with 5,000 members, all of whom can write. What breaks in your current design, and what will you change?"

</details>

<details>
<summary><strong>Follow-up 5 - minute ~31</strong></summary>

> "Someone on a plane edited a file in the team folder offline for three hours. At the same time a colleague online changed the same file. What happens after the plane lands?"

<details>
<summary><strong>Push-back - open after your own answer</strong></summary>

> "If you made one version win: the loser's three hours of work are gone, and tomorrow they'll call our support. If you kept both: hundreds of 'conflicted copies' a week in a 5,000-person folder, and nobody knows which is the real one. Which do you choose, and how do you lower the price?"

</details>

</details>

<details>
<summary><strong>Follow-up 6 - minute ~37</strong></summary>

> "Finance says the storage bill is growing 40% a year. Where will you cut?"

</details>

<details>
<summary><strong>Follow-up 7 - minute ~42</strong></summary>

> "The security team raised a problem: apparently your deduplication can leak information. How, and what will you do?"

</details>

<details>
<summary><strong>Follow-up 8 - minute ~47</strong></summary>

> "Last question. Which decision taken at the start would you take differently now?"

</details>

**50 minutes. Stop the timer, stop the recording.** As in 12.3, write three things before reading on: the best moment, the worst, and the first thing that came to mind after follow-up 4 (the honest answer: "I'll have to redo all of it" or "this part needs to change").

### 1.4 Score: along the rubric, with evidence

**The spaced repetition answer:** a Lamport clock gives a total order that respects causality (if a happened first and affected b, a's number is smaller), but it can't say the reverse: a smaller number doesn't mean it affected the other. So Lamport can't tell whether two events are concurrent. A vector clock can: if neither of two vectors is ≥ the other in every slot, they are concurrent (6.4). But this system probably doesn't need a vector clock, because all of a folder's commits pass through **one server**, which settles an order. Then, to catch concurrent edits, it's enough for every commit to say "which version I worked on top of" (the base revision) - 5.5's optimistic lock. A vector clock is needed when there's no single place to settle an order: peer-to-peer sync, or a multi-leader database (6.4's siblings). It comes up in follow-up 5's model answer.

Listen to the recording, 1-4 on each dimension with an `mm:ss`. The anchors are for this question, and this time "judgement" and "communication" include adapting:

| dimension                | 1 - weak                                       | 2                                                                   | 3                                                                                                        | 4 - strong                                                                                                                   |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| handling ambiguity       | started drawing straight away                  | asked about size, but not offline, versions or big files            | offline, versions, the biggest file, sync speed - questions that change the design                       | also asked about sharing, and even on hearing "out of scope" said the design would be kept so it could be added later        |
| a working design         | one "file server", bytes and metadata together | object storage is there, but no sync path (how a device finds out)  | bytes and metadata on separate paths; upload, commit, notify, pull - end-to-end, with data model and API | also the commit's atomicity: blocks first, metadata after, so half a file is never visible                                   |
| technical depth          | nothing beyond "we'll keep it in S3"           | split into blocks, but no reason for hashes or dedupe               | content-hash blocks, only new blocks uploaded, pulling changes by cursor, conflicts by base revision     | also the fixed-block problem on insert (content-defined chunking), the block-size trade-off in numbers, the dedupe leak      |
| judgement and trade-offs | one solution                                   | alternatives, no prices                                             | prices at the big decisions (conflict: winning vs keeping both; block size)                              | when the requirements changed, said themselves which earlier decision broke, and changed only the broken part, not all of it |
| communication            | silence, defensiveness on push-back            | thought out loud, but argued on push-back without changing position | time box, check-ins; answered push-back by accepting the price                                           | on push-back clearly changed position or held it with a reason; calm and step by step on follow-up 4                         |

Then the ten-mistake checklist (as in 12.3's 1.4), and a new section: **comparing with 12.3.**

```
dimension                12.3     12.4     evidence for the difference (mm:ss)
handling ambiguity       _        _
a working design         _        _
technical depth          _        _
judgement and trade-offs _        _
communication            _        _
```

Did 12.3's two lowest dimensions move? If not, why: was the question harder, or has the habit not changed yet? The two have different medicines. For the first, another mock; for the second, separate practice on that particular mistake from 12.1.

### 1.5 What a good hour looks like

<details>
<summary><strong>Model answer - open after giving your own score</strong></summary>

**00:00–05:00 - Requirements.** Almost all the questions in the table, plus one extra sentence that pays off later: "Sharing is out of today's scope, understood. But I'll partition the data so that adding sharing later doesn't mean changing everything." (That sentence makes follow-up 4 half as hard. Not saying it does no harm; follow-up 4's answer is below.) Scope: "Sync across all of one user's devices, offline edits, 30 days of versions. Today mainly two paths: a change from the laptop to the server, and from the server to the other devices."

**05:00–10:00 - Estimation:**

```
Commits (metadata writes): 10 million × 20 = 2 × 10⁸/day; ÷ 10⁵ ≈ 2,000/s (exactly ~2,300), × 3 → ~7,000/s peak
Upload bytes:              2 × 10⁸ × 500 KB = 100 TB/day ≈ 1 GB/s ≈ 8 Gbps average, peak ~25 Gbps
Download:                  each change to ~2 other devices on average → ~200 TB/day, ~6 PB of egress a month
Total storage:             50 million × 2 GB = 10⁸ GB = 100 PB (before versions and dedupe)
Metadata:                  50 million × 1,000 files = 5 × 10¹⁰ entries × ~500 B ≈ 25 TB (excluding versions)
Online connections:        10 million × 2 devices × ~50% online = ~10 million; 200,000 per gateway, 50% headroom → ~100 gateways
```

"So": (1) **Bytes and metadata are two separate worlds.** The 100 PB of bytes go to object storage (8.1), and the API servers never touch bytes: the client sends them directly to a presigned URL (8.2). (2) **Metadata doesn't fit in one database:** 25 TB and 7,000 commits/s, so sharded from the start. What to shard by becomes a big question later. (3) **The egress bill is a main cost** (as in 11.6): ~6 PB a month. So send only what changed, not the whole file. (4) ~10 million open connections means 11.3's gateway.

**10:00–20:00 - High level, data model, API.**

```
 [desktop client] ── ① hash into a list of blocks ──► [metadata service] ── "which of these are missing?" ──► block index
        │                                                   │
        │ ② only the missing blocks, to presigned URLs      │ ③ commit: path, base_rev, list of blocks
        ▼                                                   ▼
 [object storage: blocks, named by their hash]       [metadata DB (sharded): change journal]
                                                            │ ④ "something new in this namespace"
                                                            ▼
                                                    [notification gateway] ──► [phone] ── ⑤ fetch changes from the cursor,
                                                                                            download the blocks needed
```

```
namespaces(ns_id, kind)                                   -- today: each user's root is one namespace
journal(ns_id, seq, path, rev, blocks[], size, deleted,
        device_id, base_rev, committed_at, PK(ns_id, seq)) -- append-only; seq increases per namespace
files(ns_id, path, latest_rev, latest_seq)                -- the current state, from the journal
blocks(hash PK, size, stored_at)

POST /blocks/missing          { hashes[] }                → { missing[], uploadUrls[] }
POST /ns/:ns/commit           { path, baseRev, blocks[] } → { rev, seq } | 409 { currentRev }
GET  /ns/:ns/changes?cursor=  → { changes[], cursor }
GET  /notify?ns=…&cursor=…    (long-poll or WebSocket) → "there's something new"
```

**Content-Addressed Block** - splitting a file into pieces (blocks) and naming each piece by the hash of its content (e.g. SHA-256). The same content means the same name, so a block is stored and sent only once; and the name is itself the proof that the content is intact. A file is then just a list of block hashes.

**Change Journal** - an append-only list of all of a namespace's changes, each with an increasing `seq`. Each device remembers up to which `seq` it has seen (a cursor, 2.5), and asks "what changed after this?" It's the same idea as 11.3's per-conversation sequence: order is settled in one place, and losing or getting something twice is easy to catch.

**Follow-up 1 (one byte in the middle of 2 GB):** say blocks are 4 MB. 2 GB = 500 blocks. **Changing** one byte changes only that block's hash: the client sends 500 hashes, the server says "one is missing", the client sends 4 MB. 4 MB instead of 2 GB.

_Push-back (inserting one byte at the start):_ here fixed-size blocks fall apart. Insert one byte and every byte after it shifts one place, so **every** block's content changes, every hash is new: the whole 2 GB again. The solution: **content-defined chunking** - block boundaries are decided not at a fixed distance but by looking at the content (a boundary wherever a rolling hash finds a particular pattern). After an insert only one or two nearby boundaries move; the rest of the blocks are as before, with their old hashes. The price: uneven block sizes, and a bit more CPU for hashing. And one honest thing: many files (zip, many video formats) rewrite the whole file on a small change, and then no chunking helps.

**Follow-up 2 (how the phone finds out):** after a commit, the metadata service sends a "something new" message for that namespace to the gateway. The phone's app (if open) sits on a long-poll or WebSocket (2.4); on the message it asks for `changes` with its own cursor, gets the new journal entries, and **doesn't download the file** - on the phone only the metadata updates, and the file comes down when the user opens it. The desktop client downloads, but only the missing blocks. The notification carries no data, only "take a look": so if a notification is lost or arrives twice there's no harm, the truth is always in the journal (as in 11.5). If the app is closed, a mobile push (11.5), and a pull when it opens. Speed: under a second from commit to message, then the pull; comfortable for a 10-second target.

**Follow-up 3 (the battery dies halfway through 50 GB):** 50 GB = 12,500 blocks. The upload order: **all** blocks first, then one commit. When the battery dies some blocks are in object storage, and there's no commit. The next day the client sends the hash list again, the server says which are missing, and only those go (8.2's resumable upload, here the block's hash is the part's identity). The phone saw nothing, because a journal entry appears only on commit, and a commit comes only after every block has arrived: **half a file is never visible.** At commit time the server checks every block exists. And the blocks of a commit that never happened are on nobody's list, so a few days later they go to garbage collection (follow-up 6).

**Follow-up 4 (the requirements change: shared folders):** here your initial shard key is tested.

If you sharded the metadata **by user_id** (very natural, since there was no sharing at the start): a team folder's files now belong to 5,000 people. Whose shard do they live on? Two bad paths: (a) a copy on each of the 5,000 people's shards, meaning 5,000 writes for every edit, and no way to keep them consistent together (if two members edit at the same moment, which order on which shard?); (b) on one "owner's" shard, and the rest read from there: then seeing one user's files means going to many shards, and what happens when the owner leaves the company?

A good answer accepts that the shard key was wrong, but **not the rest of the design.**

**Namespace** - an independent tree of files (one user's root folder, or a shared folder), with its own change journal and its own `seq`, and the unit of sharding. One user's view is a few namespaces **mounted** somewhere in their tree: `mounts(user_id, ns_id, path)`. A shared folder means one namespace and 5,000 mounts.

The migration path: call each user's root today a namespace, with `ns_id` = the old user_id. The old user_id's shard is now that namespace's shard, so **no data has to move**, just a renamed concept and a `mounts` table. New shared folders are new namespaces, on their own shards. The client now keeps one cursor per namespace, and `notify` listens to several namespaces. Journal, blocks, commit, conflicts: nothing changes, because they were already written around "a place where order is settled", and now that place is called a namespace.

The numbers: in a 5,000-person folder, 20 changes per person a day = 100,000 a day; in the 8-hour office active window (12.2) ~3.5 commits a second, nothing for one shard. The real load is in notifications: for every commit, "take a look" to 5,000 people - ~17,500 messages a second from one folder. The medicine: coalescing per client, once every few seconds (11.5's aggregation), because the client pulls everything from the cursor at once anyway. Then a folder's message rate is bounded by the number of members, not the number of commits.

**Follow-up 5 (three hours offline vs an online colleague):** on the plane, the laptop had the file at `rev 7`. The colleague online committed `rev 8`. After landing, the laptop sends a commit with `base_rev = 7`. The namespace's server sees it's now at `rev 8`, meaning the laptop's work didn't know about `rev 8`: a concurrent edit. No vector clock is needed here, because the namespace's server settles a single order, and comparing the base revision says it all (the spaced repetition answer; 5.5's optimistic lock). The server returns `409`. The client keeps its version under a new name: `report (Rafi's laptop's conflicted copy, 2026-10-06).docx`, and `rev 8` stays under the real name.

**Conflicted Copy** - losing neither of two concurrent edits, keeping the losing one next to it under a separate name, so a person can reconcile them. 6.4's sibling idea, except the burden of resolving it is on a person instead of the application, because the system can't merge two versions of a Word file itself.

_Push-back (winning vs keeping both):_ "Keep both, and I accept that price: nobody loses work, but now and then there's an extra file. Silently losing three hours of work is a mistake that can't be undone; an extra file can be. To lower the price: (1) measure how often conflicts happen - two edits have to land on the same file in the same sync window (~10 seconds online), so online it's rare, and most come from offline; (2) when a conflicted copy is created, tell both people, with a clear mark next to the file; (3) when someone opens a file, a hint to the others that 'Rafi is editing this', not a lock (a lock is meaningless offline), just information; (4) repeated conflicts on the same file are a signal that this file is for writing together - that's a document editor's job (OT/CRDT), not file sync's, and we left that out of scope at the start."

**Follow-up 6 (the storage bill):** four levers, biggest to smallest:

- **Version history and garbage collection:** deleting blocks of versions older than 30 days that are no longer on any version's list. But not by reference count (if a bug or crash makes a count wrong, a block someone still needs can be deleted - and it can't be brought back). Instead mark-and-sweep: mark blocks from every live list, delete unmarked blocks older than a few days (follow-up 3's uncommitted blocks go this way too).
- **A cold tier:** blocks untouched for a year to a cheaper storage class (8.1, 10.7). Almost every file store is largely cold, but how much has to be measured.
- **Dedupe:** because of the content hash, the same block once - a user's several copies, an old version's unchanged blocks. How much it saves depends on the data; measure, don't guess. (Follow-up 7 has a limit on this.)
- **Block size:** smaller blocks give better deltas (fewer bytes sent and stored), but bigger metadata. 100 PB split into 4 MB is 2.5 × 10¹⁰ blocks, and at ~100 B of index each ~2.5 TB. Split into 64 KB it's ~1.6 × 10¹² blocks, an index of ~156 TB - 62× bigger. So size is a numbers decision, and in content-defined chunking you keep an average size with upper and lower bounds.

**Follow-up 7 (the dedupe leak):**

**Dedupe Side Channel** - when the system says a block "already exists" (no upload needed, so instant), an attacker can upload a guessed file and see whether it was instant, and from that learn whether **someone else** has exactly this file. By trying a few thousand variants of a template (say a letter where only one number changes), even someone else's private information can be extracted.

Three solutions, each with a different price: (a) dedupe only within the same namespace, not between users - the leak is closed, but the savings between users are lost (usually most of the savings are within the same user, but that needs measuring); (b) the client always sends the bytes, and the server quietly stores them once - no signal and the storage savings stay, but the bandwidth savings are lost; (c) client-side encryption with a per-user key - no dedupe at all, the most private. I'd take (a): the leak is real, and with the lost portion of the savings unmeasured, there's no reason to take the risk for it.

**Follow-up 8 (which decision to change):** "Two. First, the shard key: namespace from the start instead of user_id, because even without sharing, 'a place where order is settled' and 'a person' are different concepts, and keeping them separate cost nothing. Second, I assumed the 4 MB fixed-block number; in reality I'd choose the size with content-defined chunking, measured on a sample of real files."

**The three sentences of the wrap-up:** "Bytes and metadata are separate: bytes in content-hash blocks in object storage, sent directly by the client; metadata in a journal sharded by namespace, where the commit is atomic and sync goes by cursor. On a conflict work is never lost, it stays alongside in a conflicted copy. What breaks first is a huge team folder's notification fan-out, and on the bill side egress and old versions' storage."

</details>

### 1.6 Where candidates usually fall on this question

- _"The upload API goes straight to the API server, then the server sends it on to S3."_ - 8-25 Gbps of bytes through the app servers. 12.1's mistake 2: the "so" from the candidate's own numbers never came out. 8.2's presigned URL exists exactly for this.
- _"When a file changes, the whole file is uploaded again."_ - mistakes 8 and 2: the ~6 PB of monthly egress says this is impossible.
- _"The devices ask the server every 30 seconds whether anything changed."_ - 20 million devices × every 30 seconds = ~670,000 requests a second, nearly all answered "no". Mistake 2.
- _"After follow-up 4: 'Then let me redo the whole design.'"_ - a big loss on judgement and communication, because the rest of the time goes to redrawing old things. The right answer: which one decision broke, its name, and changing only that.
- _"Last write wins on a conflict, using timestamps."_ - mistake 9 and 6.4: the two devices' clocks differ, and one person's work silently disappears. The push-back catches this.
- _"Dedupe across everyone, because it saves the most."_ - reasonable before follow-up 7. It's a mistake not to change it even after follow-up 7 (mistake 10).

**Write your own feedback,** as in 12.3, in the third person. This time one extra line: "After the requirements changed, the candidate …" - how you adapted, with an `mm:ss`.

> **Trade-off Table - file sync's big decisions**

| decision             | chosen                                         | alternative                              | what was given up                     | what was gained                                                               |
| -------------------- | ---------------------------------------------- | ---------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| the bytes' path      | client → presigned URL → object storage        | client → API server → storage            | making URLs and managing their expiry | ~25 Gbps kept off the app servers                                             |
| a file's structure   | content-defined chunking, the hash as the name | the whole file, or fixed-size blocks     | hashing CPU, uneven blocks            | only nearby blocks sent on both change and insert; resume and dedupe for free |
| commit               | blocks first, then metadata in one transaction | together, or metadata first              | an extra round trip                   | half a file is never visible                                                  |
| the sync path        | a "take a look" message + pull from a cursor   | polling, or the full data in the message | a gateway and long-poll               | polling's ~670,000/s saved; no harm when a message is lost                    |
| the unit of sharding | namespace                                      | user_id                                  | an extra concept (mount)              | no copies for shared folders; no data moved in the migration                  |
| conflicts            | base revision + conflicted copy                | last write wins / vector clock           | an extra file now and then            | work is never lost; no reliance on clocks                                     |
| dedupe               | within a namespace                             | across all users                         | the savings between users             | the dedupe side channel closed                                                |

---

## 2. Interview Angle

Two new techniques in this mock, which interviewers use on purpose:

- **Changing the requirements.** "Now we need sharing", "now ten times", "now in another country". The interviewer watches three things: whether you can say exactly which decision broke (by name), whether you keep the rest of the design alive, and whether you stay calm. The best answer often finds a path where old data doesn't have to move (today's "a user's root = a namespace").
- **Push-back.** "If you make one win, someone loses work; if you keep both, chaos." Both options are made to sound bad, to see whether you can choose one and **accept the price**, or swing between the two. The shape of a good answer: choose, say why (which mistake can be undone and which can't), measure the price, lower the price.
- **Mid-level vs senior:** at mid-level, separating bytes and metadata, splitting into blocks, and losing nothing on a conflict are enough. At senior the interviewer looks for: the commit's atomicity, the chunking problem on insert, why the namespace is the unit of sharding, and an unexpected angle like the dedupe leak.

**In real production:** the hardest parts of file sync aren't on the server, they're in the **client**: watching thousands of files change in a folder (the limits of the OS's file watcher), not hashing a file while another program is still writing it, the difference between case-insensitive and case-sensitive file systems, and a bad client release running wrong syncs on thousands of devices at once. That last one needs a safeguard on the server side: when an unusual number of deletions suddenly comes from one device, stop and ask a person. Bringing up any one of these yourself in an interview is a strong senior signal.

---

## 3. Key Takeaway

- **When the requirements change, don't throw the design away:** name the broken decision (here the shard key), change only that, and look for a way to change it without moving data (a user's root = a namespace)
- **On push-back, choose and accept the price:** a price that can be undone (an extra file) is better than a mistake that can't (lost work); then measure the price and lower it
- **In file sync, bytes and metadata are two separate worlds:** 100 PB and ~25 Gbps of bytes go directly to object storage by presigned URL; 25 TB and 7,000 commits/s of metadata in a sharded journal
- **Content-hash blocks:** only changed blocks are sent, resume and dedupe for free; but with fixed-size blocks, inserting one byte at the start sends the whole file - content-defined chunking
- **Commit atomically, blocks first:** half a file is never visible; uncommitted blocks go to garbage collection, by mark-and-sweep, not reference counts
- **With order settled in one place, no vector clock is needed:** the namespace's server settles the order, comparing the base revision catches concurrent edits; on a conflict a conflicted copy, nothing is lost
- **Dedupe has a security price:** the "already exists" signal leaks the existence of someone else's file; dedupe within a namespace

---

## 4. New Terms (Glossary)

| Term                         | Meaning                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content-Addressed Block**  | A piece of a file named by the hash of its content - the same content stored and sent once, the name is the content's proof; a file is a list of hashes                                       |
| **Content-Defined Chunking** | Block boundaries set not at fixed distances but by the content (at a rolling hash's pattern) - even if a byte is inserted in the middle only nearby blocks change, the rest keep their hashes |
| **Change Journal**           | An append-only list of all of a namespace's changes with an increasing `seq` - a device keeps a cursor and asks "what came after this?"; losing or getting something twice is easy to catch   |
| **Namespace**                | An independent tree of files (a user's root, or a shared folder), with its own journal and `seq`, the unit of sharding; a user's view = a few mounted namespaces                              |
| **Conflicted Copy**          | Keeping the loser of two concurrent edits alongside under a separate name - nothing is lost, the burden of reconciling is on a person; 6.4's sibling in file-sync form                        |
| **Dedupe Side Channel**      | Learning from an instant "block already exists" whether someone else has a file - the medicine is keeping dedupe within a namespace, or always taking the bytes                               |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. A user's phone has a 200 GB folder, but only 30 GB of space. (a) Where does the phone's client behave differently from the desktop's? (b) The user opened a 4 GB video, on mobile data. What will it download, and when? (c) A file was edited offline on the phone, and then the phone was lost. What was lost, and which part of the design could have reduced it?

2. After follow-up 4 the interviewer went one step further: "A big company's entire file server is with us: 20 million files in one namespace, 50,000 members." (a) What breaks in a one-namespace = one-shard design, with numbers? (b) How would you split it while keeping the main advantage of one namespace's single journal (one order), and what would you lose?

3. A candidate's answer to follow-up 4: _"Okay, if we need sharing, I'll keep a copy of the file on every member's shard, and a background job will keep them all in sync. If there's a problem, I'll run the job again."_ (a) What would you give this on judgement, 1-4, and why? (b) "Two members edited the same file at the same moment" - what happens in this design? (c) Which part of this answer can be saved?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) The phone's client **syncs all the metadata, but not the bytes**: it shows the whole tree (names, sizes, thumbnails), but downloads a file only when it's opened, or when the user marks it "keep offline". Downloaded files go into a bounded cache, and when space runs short the least recently opened go first (4.3's LRU). The desktop is the opposite: everything downloaded, because the folder is a real OS folder. And on a notification the phone only updates metadata (follow-up 2), batching many changes together, to save battery and data.

(b) Not all 4 GB in advance: for a video, only the blocks for where you're watching, a little ahead of how far you've watched (downloading by range; the block list says which block sits at which offset). Better: a low-bitrate preview on the server (11.6's transcoding), and on mobile data, that. Asking the user "download the whole thing on Wi-Fi?". The data cost is the user's, so the default is restrained.

(c) An offline edit on the phone exists only on the phone until it's committed. Losing the phone lost that edit, and nothing else (all the versions on the server are intact). Ways to reduce it: commit immediately on coming online (no delay), and in the middle of a big edit upload its blocks ahead of time now and then (without a commit, as in follow-up 3), so at the moment of coming online only the commit is left. But there will always be a window for offline edits, and saying so out loud is the honest answer.

**Question 2:**

(a) 20 million files × ~500 B = ~10 GB for the current state alone, plus versions and the journal - big for one shard, but not impossible. The real problem is writes and messages: 50,000 members × 20 changes a day = 1 million a day, in the 8 office hours ~35 commits a second, ~70 at peak - possible on one shard, but all in one journal, in one order, meaning one primary's row-ordering limit and lock queue. And messages: to 50,000 people after every change, thousands a second even with coalescing. And a new device's first sync: reading a journal of 20 million entries from the start is impossible - start from a snapshot (the current state), then the journal.

(b) Split the namespace by its sub-folders into a few parts (sub-namespaces), each with its own journal and `seq`, the parts on different shards. Within one part, order holds. What's lost: order and atomicity **across** parts - moving a folder from one part to another is now two writes in two journals, so two steps (a small saga, 9.3), and in the moment between, someone may see it in both places, or in neither. The honest answer: this makes a rare operation hard and keeps everything else possible, and the client has to keep several cursors.

**Question 3:**

(a) **1, at most 2.** "A background job will keep it in sync" isn't a mechanism, it's a hope, and "run it again" means there's no guarantee of correctness. Plus the price of 5,000 writes per edit isn't counted (12.1's mistakes 2 and 9).

(b) The two write to their own copies on two different shards, each successfully. The job now sees two different versions among the 5,000 copies, and there is no single order to tell which is "right" - choosing by clock is 6.4's problem, and someone loses work. Meanwhile some of the remaining 4,998 see one version, some the other. This is the flip side of the spaced repetition question: without a single place to settle order you need vector clocks and siblings, and this design has nothing for that.

(c) "The folder appears in every member's view" - that goal is right. It can be saved this way: a **reference** instead of a copy - a mount (a small row) in each member's tree, and the file itself in one place, in one order. In one sentence: "Not copies, one namespace and 5,000 mounts."

</details>

---

## 6. Practical Exercise

**Tier 3 - Design Exercise** (a mock interview; no code. The deliverable is the recording, the score, the comparison with 12.3, and the feedback)

> **Task:**
>
> 1. **Do the mock,** by 1.1's rules, 50 minutes, out loud, with a recording. Open the push-back sections only after your own first answer.
> 2. **Score it,** the next day: the five dimensions, with `mm:ss`; the ten-mistake checklist; and 1.4's 12.3 vs 12.4 table.
> 3. **Listen to the follow-up 4 part separately,** and write answers to three questions: (a) how many seconds later did you name which decision broke? (b) how much of the old design survived? (c) did you give a path for moving data, or avoid it?
> 4. **For the two push-backs:** write your first answer and your answer after the push-back side by side. Did you change position, hold it, or swing between the two? If you swung, choose now in one sentence and state the price.
> 5. **Feedback,** in the third person, with the line "After the requirements changed, the candidate …".
> 6. **After two mocks, pick one habit:** the mistake that came up in both 12.3 and 12.4. For the next week, 10 minutes a day practising only that (e.g. for mistake 2, three 12.2-style drills a day, saying "so" out loud at the end of each; for mistake 10, one old case study's deep dive out loud each day, with a recording).
>
> **With a friend:** this time give your friend one more power: at any moment, outside the script, to say "why?" or "what's the number?". You can anticipate the script's follow-ups; you can't anticipate a person's random questions, and that's what happens in a real interview.

Send the full score, the comparison table, the three answers on follow-up 4, and the two push-back pairs. I'll check whether the change in your score matches the evidence, and where the time went on follow-up 4.

**Honest notes:** the interviewer's answers, the follow-ups' order, the push-backs and the rubric's anchors are my own. The model answer's numbers are estimates done in your head as in an interview: 4 MB blocks, bytes per entry for the metadata and block index, 50% online, 200,000 connections per gateway (the assumption from 12.2's drill 7), all assumed, not measured. How much dedupe saves and how much of the storage is cold depend on the data, so I gave no numbers. Content-defined chunking, block-level dedupe and the dedupe side channel are published, well-known ideas; no claim is made here about how any particular company does them.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 11 (complete, with exit challenges), 12.1, 12.2, 12.3
Current: 12.4 - Mock Interview #2 (file sync, like Dropbox)
TaskFlow state: as at the end of Module 10 (on the side today).
Mock #2 - 10 million DAU, 50 million users × 2 GB = 100 PB; peak ~7,000 commits/s, upload ~25 Gbps, ~6 PB of egress a
month, metadata ~25 TB, ~10 million online connections (~100 gateways). Bytes to object storage by presigned URL
(content-hash blocks, content-defined chunking - with fixed blocks, inserting one byte at the start sends the whole
file); metadata in a change journal sharded by namespace (seq, cursor). Commit: blocks first, then atomic metadata - half
a file is never visible. Sync: a "take a look" message + pull from the cursor. The requirements change (shared folders,
5,000 members): the user_id shard key breaks → namespace + mount, a user's root = a namespace so no data moves;
notifications coalesced. Conflicts: base revision (no vector clock needed, order in one place) + conflicted copy.
Storage: mark-and-sweep GC, a cold tier, block size (at 4 MB an index of ~2.5 TB, at 64 KB ~156 TB). Dedupe within a
namespace (side channel).
Terms learned (Module 12): Signal, Rubric, Clarifying Question, Stated Assumption, Time Box, Check-in, Estimation Chain,
Powers-of-Ten Rounding, Active Window, Headroom, Unit Slip, Sanity Check, Sorted Set, Server-Authoritative Score,
Composite Score, Time-Bucketed Key, Rank Histogram, Content-Addressed Block, Content-Defined Chunking, Change Journal,
Namespace, Conflicted Copy, Dedupe Side Channel
Weak spots: [where you got stuck - write it yourself; the mistake that came up in both 12.3 and 12.4]
Next: 12.5 - "Tell me about a system you designed"
=======================
```

---

## 8. Next Step

Today's thread: **what's on show isn't a good design, but the ability to change a good design.** The interviewer knows the initial shard key will be proven wrong later, because they will change the requirements themselves. What they're watching is exactly that moment: which decision broke, by name, how much of the rest survived, and whether there's a way to change it without moving data. And on push-back, choosing one of two bad options and accepting the price.

When you are ready, write `next` - **Lesson 12.5: "Tell me about a system you designed."** This question comes up somewhere in almost every system design loop, sometimes as a separate round. Here there's no unknown system: the system is your own, so the question sounds easy, and that's exactly why people don't prepare. In 12.5 we'll see what this question really measures (your role, your decisions, and what went wrong), how to shape a real project into a five-minute story, and how to stay honest on the deep follow-up questions when the decision wasn't yours. And for anyone who doesn't yet have a big project to talk about, a path: TaskFlow, this course's eleven modules, is your system.
