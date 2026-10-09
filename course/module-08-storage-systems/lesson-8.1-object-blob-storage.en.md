# Lesson 8.1 - Object / Blob Storage (S3-style): How It Works, When You Need It

**Module 8 - Storage Systems**

> **Spaced Repetition (Lesson 1.6):** When do we call an Express instance "stateless" - and why is that a precondition for horizontal scaling? Now suppose you keep the files users upload in that instance's own `/uploads` folder. Is it still stateless? Today you'll measure it.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 1.6 (Stateless), Lesson 3.4 (Sticky session), Lesson 5.3 (WAL), Lesson 5.5 (Lost update), Lesson 5.7 (Replication), Lesson 7.1 (Cascading failure), Lesson 7.5 (Dual write)

**By the end of this lesson you will be able to:**

1. Say, with measured numbers, where a file should live - the database, the app server's disk, or object storage - and show where each option's cost lands (WAL, backup, replicas, statelessness, the app's event loop)
2. Draw on a whiteboard how an object store works inside - metadata and bytes kept apart, replication vs erasure coding, failure domains - and explain what the "11 nines" claim means and where it stops
3. Design TaskFlow's attachments within the rules of an object storage API (whole-object writes, flat namespace, consistency, conditional writes, versioning, storage classes) - with the key, the metadata table, the order of the two writes, and the cost

**Tier:** 1 - Runnable Code (Postgres and SeaweedFS - an S3-compatible object store - in Docker; plus a seeded durability simulation)

---

## 0. Where TaskFlow Is Right Now

At the end of Module 7, TaskFlow's data means small things: rows, events, jobs - a few hundred bytes each. But six months ago an attachment feature arrived from a hackathon: attach files to a task - screenshots, spec PDFs, design files. It was built the simplest way, in a Sequelize model:

```typescript
class Attachment extends Model<InferAttributes<Attachment>, InferCreationAttributes<Attachment>> {
	declare id: CreationOptional<number>;
	declare taskId: number;
	declare fileName: string;
	declare contentType: string;
	declare data: Buffer; // DataTypes.BLOB → bytea in Postgres - the file itself lives inside the row
}
```

The reasoning sounded good: "everything in one place, the same transaction, the same backup." Six months later, three incidents:

1. **The nightly backup** grew from 6 minutes to two and a half hours. In the quarterly restore drill, bringing the database back took 5 hours - while TaskFlow's RTO is one hour (Lesson 1.5). The size of the database's real data - tasks, comments, users - barely changed in those six months.
2. **Replica lag alerts**, every time a design agency uploads a few hundred MB of files at once. Lesson 5.7's replicas fall behind, and because of Lesson 6.3's version tokens, many reads get sent to the primary at that moment.
3. **The morning of a review meeting:** one team opens all of the week's attachments at once - and for those ten minutes everyone's task board is slow. The database's CPU is normal.

A team lead proposed: "move the files out of the database onto each instance's disk, at `/var/taskflow/uploads`." It was tried on staging. On the first day, a bug report: "I uploaded it, and half the time opening it says 'file not found'." And overnight staging's autoscaling removed an instance - in the morning, all of that instance's files were gone.

The CTO's answer was one line: "put them in S3." But what S3 actually is, how it differs from a file system, what it promises and what it does **not** - that's today, with numbers.

---

## 1. Theory

### 1.1 Three kinds of storage - block, file, object

"Storage" can mean three very different things:

- **Block storage** - a raw disk: fixed-size blocks, read and written anywhere. It attaches to one machine, and a file system or database sits on top. (AWS EBS, a server's SSD.) Postgres's data lives here.
- **File storage** - folders, files, paths, permissions; write into the middle of any file, append, rename. Either a machine's own, or shared over the network by several machines (NFS, AWS EFS).
- **Object storage** - today's topic.

**Object storage** - keeping data as **objects**: each object is some bytes, some metadata alongside, and a key; objects live in a **bucket**, and they are read and written over an HTTP API (PUT, GET, DELETE, LIST) - always as a whole object; you can't change the middle.

```
   block storage                  file storage                     object storage
   ─────────────                  ────────────                     ──────────────
   [blk 0][blk 1][blk 2] …        /uploads/                         bucket: taskflow-attachments
   read/write any block           ├── ws-12/                          key: ws/12/att/7f3a…   → bytes + metadata
   attached to one machine        │   └── spec.pdf  (write middle ✓)  key: ws/12/att/91bc…   → bytes + metadata
   file system/database on top    └── ws-40/ …      (rename ✓)       HTTP: PUT / GET / DELETE / LIST
                                                                    whole object, no rename
```

So why object storage, with all these limits? Because in exchange for exactly these limits it gives three things the other two don't give easily: nearly unlimited size (billions of objects in one bucket), very high durability (1.5), and a price several times lower than a database's disk (1.7). And an HTTP API means any machine, any instance, even the browser directly - everyone reaches the same place.

### 1.2 Files in the database - where the cost lands

First question: how bad is TaskFlow's hackathon path, really? The exercise's `npm run where` stores the same 200 files (315 MB in total; mostly small, a few up to 10 MB) in two places - in a Postgres `bytea` column, and in object storage (with only a metadata row in the database):

```
── 1. Storing (4 uploads at a time) ─────────────────────────────
   where                               time         WAL         DB growth    object storage
   Postgres (bytea)                  1.14 s    336.9 MB          327.2 MB                 -
   object storage + metadata row     1.69 s       49 KB             80 KB          314.5 MB
   (for comparison: the whole tasks table of 200k tasks + indexes = 23.3 MB)

── 2. Backup (pg_dump -Fc, inside the container) ─────────────────
   database with files                   361.1 MB    21.56 s
   without files (metadata only)           2.4 MB   399.8 ms
```

Storing takes about the same time - nothing to blame the database for here. The cost lands in three other places:

- **WAL.** Lesson 5.3: Postgres writes every change to the WAL first, then to the table. 315 MB of files means 337 MB of WAL (including the table's own overhead) - and every replica from Lesson 5.7 receives and applies exactly that much WAL. TaskFlow's 3 replicas mean 1 GB on the network for one big upload, and the replicas fall behind - incident 2. On the object storage path the WAL is 49 KB: just the metadata row.
- **Database size.** The whole table of 200k tasks is 23 MB; 200 files are 327 MB. In reality the ratio gets worse - files keep piling up while task rows stay roughly the same. And the database's disk is the most expensive disk you have (fast SSD, and a copy on the primary plus every replica).
- **Backup and restore.** The backup with files is 361 MB and 21 seconds; without files, 2.4 MB and half a second - more than 50 times. Restore is slower by the same ratio - incident 1's RTO. And nearly all of the backup is data that never changes (nobody edits an uploaded PDF) - yet all of it again, every night.

**Now incident 3 - serving files.** The board's queries (8 clients) are running, and alongside them 8 people download files:

```
── 3. Board queries while files are served (8 OLTP clients, pool max 10; 8 downloading files) ──
   step                                        OLTP q/s   OLTP p50   OLTP p99   file/s     MB/s   file p50 / p99
   OLTP only                                      14437     0.4 ms     0.8 ms        0        0   -
   + files, Postgres → through the app              350    20.9 ms    66.1 ms      192      289   27.9 ms / 170.8 ms
   + files, Postgres → separate process           14687     0.4 ms     0.8 ms      194      290   23.3 ms / 218.0 ms
   + files, object storage → direct               14968     0.4 ms     0.7 ms      348      516   17.5 ms / 91.6 ms
```

Look at the third row first, because it's an honest surprise: Postgres itself serves files just fine. Downloading 290 MB per second from a separate process leaves the board's p99 unchanged - 0.8 ms. So why, in the second row, did the board drop from 14 thousand per second to **350**?

Because the database doesn't speak HTTP. If the file is in the database, the only way to reach the user is **through the app**: the app reads from the database, then sends to the user. And then:

- For the entire duration of every file, one connection from the app's pool is held - 8 of the 10 are with files, and the board's queries queue up. Lesson 7.1's cascading failure, exactly.
- Every byte passes through the app's event loop. Postgres sends `bytea` as hex text - two characters per byte, double the size - and Node has to parse that into a Buffer. That's CPU work, and it blocks the event loop (7.1's side note).

Which one is bigger? Experiment 1: with the pool at 20 (enough room for the files), the board is still at 374 q/s, p50 20 ms - so the bigger part here is the app's event loop. And experiment 2 gives the exact proof: if the app itself downloads files from object storage and hands them to the user (a proxy), the board is at 486 q/s - nearly the same as serving from the database. **The lesson isn't "database vs object storage" - it's "through the app vs direct".** With files in the database there's no way to serve them directly; with object storage there is - the browser or a CDN downloads straight from object storage without touching the app (the last row; how, that's Lesson 8.2's presigned URLs).

**A hidden trap in TaskFlow's stack:** by default Sequelize reads **all** of a model's attributes. `Attachment.findAll({ where: { taskId } })` - to show a task's list of attachments - pulls the full bytes of every file. Ten 5 MB files means 50 MB (100 MB in hex) just for a list. Forget `attributes: { exclude: ['data'] }` once and you have Lesson 5.6's hydration cost, at a large scale.

**So never files in the database?** The honest answer: small and few is fine. Postgres's own documentation supports `bytea`, and in a small app, keeping a few KB-sized things (a small icon, an image of a signature) in the database gives you real benefits from having the transaction and the backup together. The trouble starts when the files are big, many, and keep growing - which is to say, in nearly every user-upload feature.

### 1.3 On the app server's disk - statelessness breaks

The team lead's proposal: files on each Express instance's own disk. All of the database problems go away - but this is where the spaced repetition question bites. The exercise's `npm run stateless`: two Express instances behind a load balancer, 20 users each upload 10 files; then the uploader opens them again, a teammate opens them, and finally instance A is replaced (a deploy, a crash, an autoscaling scale-in - a new container, an empty disk):

```
   where files live · load balancer   own reopen 404    teammate open 404     lost after replacing A
   local disk, round robin                       50%                  47%                  148 / 200
   local disk, sticky (per user)                  0%                  47%                  100 / 200
   object storage, round robin                    0%                   0%                    0 / 200
```

- **Round robin:** half the time the request goes to the other instance, whose disk doesn't have the file - staging's "half the time, file not found".
- **Sticky session (Lesson 3.4):** the same user always reaches the same instance - the uploader no longer gets a 404. But look at the teammate column: **47%**. A sticky session binds a **user** to an instance, but an attachment doesn't belong to one person - it belongs to a team. The teammate's own sticky instance can easily be the other one.
- **After replacing the instance:** with local disk, the instance's disk went with it - 100 files gone forever, and with round robin the other 100 also reach the wrong instance half the time (hence 148). With sticky, exactly those 100 whose uploader's instance was A.

In Lesson 1.6's terms: the moment it stored files, the instance became **stateful** - and every benefit of horizontal scaling that comes with statelessness (any instance takes any request, instances come and go) broke. In the object storage row both instances talk to the same bucket; the instances are stateless again, and a file's life is independent of an instance's life.

(There's a middle path: a network file system shared by all instances - NFS, AWS EFS. Statelessness comes back, and the code doesn't change - still `fs.writeFile`. The price: it's expensive, file system guarantees are hard to keep over a network (locks, renames, slow with many small files), and the browser can't reach it directly - files still go through the app, 1.2's problem.)

### 1.4 Inside an object store - metadata and bytes kept apart

From outside, an object store is simple: give it a key, get the bytes. What's inside that lets it handle billions of objects and petabytes of data?

The core design is nearly the same everywhere: **where things are** (metadata) and **the actual bytes** live in separate systems.

```
                         ┌─────────────── API layer (stateless, many of them) ────────────┐
   client ── HTTP ──────►│  PUT /bucket/key  ·  GET  ·  LIST  ·  auth, checksum           │
                         └──────────┬───────────────────────────────────┬────────────────┘
                                    │ "where is this key?"              │ bytes
                                    ▼                                   ▼
                  ┌───────── metadata index ─────────┐     ┌──────── storage nodes (thousands of disks) ─────┐
                  │ bucket + key → size, ETag,       │     │  [fragment][fragment][fragment] …                │
                  │   version, which fragment        │     │  many objects packed side by side in big files   │
                  │   on which node                  │     │  (one object ≠ one file)                         │
                  │ sharded by key range (5.8),      │     │  replication or erasure coding (1.5)             │
                  │ each shard replicated (6.2)      │     │  spread across racks/AZs                         │
                  └──────────────────────────────────┘     └─────────────────────────────────────────────────┘
```

There's a famous reason behind this. Facebook's 2010 paper "Finding a needle in Haystack: Facebook's photo storage" shows: if every photo was a separate file, reading one photo meant the file system first had to go to disk several times to find its metadata (directory, inode) - and with billions of small files that metadata didn't fit in memory. The fix: pack many photos side by side into one huge file, and keep a small index of "which photo is at which offset in which file" in memory - then one photo = one trip to disk. The exercise's SeaweedFS is built from exactly this idea: its **master** knows where each volume is, and the **volume servers** keep the bytes of many objects in big volume files.

This split explains three things you can see in the API:

- **The metadata index is a giant key-value database** - sharded by key range (Lesson 5.8), each shard replicated and coordinated through consensus (Lesson 6.2). "LIST every object under this prefix" is a range scan over that index - so LIST is cheap, but a question like "the total size of all objects" really means counting everything.
- **There's no such thing as a "folder".** The index holds only full keys: `ws/12/att/7f3a…`. `/` is an ordinary character. (1.6)
- **Bytes can't be changed, only rewritten.** An object's bytes sit in the middle of a big file or are split across several disks - "write 3 bytes at this offset" would mean rebuilding everything. So the rule is: PUT means the whole object, from scratch. (1.6)

**Bucket and key** - a bucket is a named container for objects (where permission, versioning and lifecycle rules are set); inside it, every object has a unique **key** - a string that looks like a path but is really just a name; the leading part of a key is called a **prefix**.

**Object metadata** - small pieces of information kept alongside an object's bytes: size, `Content-Type`, `Content-Disposition` (what name to show on download), the **ETag** (a fingerprint of the object's content - for an ordinary single PUT usually the MD5 of the content, but not for multipart uploads or some kinds of encryption), and your own key-values (`x-amz-meta-task-id: 42`). Metadata comes back from `HEAD`, without downloading the bytes.

### 1.5 Durability - copies, erasure coding, and failure domains

In Lesson 1.5 we learned availability: whether you can get an answer right now. Object storage's biggest claim is about something else.

**Durability** - the probability that data, once successfully written, is **not lost** over a given period (usually a year); different from availability - an object that can't be read for a while (unavailable) hasn't been lost.

AWS says S3 Standard's durability design target is **99.999999999%** - "11 nines". That means if you store 10 billion objects, you'd expect to lose one per year on average. By comparison its availability target is 99.99% (and the SLA 99.9%) - far fewer nines. Two different questions, two different answers.

Where do so many nines come from? A disk dies with a probability of a few percent per year (in disk statistics published by companies like Backblaze, around 1–2% per year is typical). The first answer - keep copies. The second answer, cleverer:

**Erasure coding** - splitting an object into k data fragments, computing m extra parity fragments from them, and storing the k + m fragments on separate disks; the whole object can be rebuilt from any k fragments - so it survives m dead disks, using only (k + m) ÷ k times the space.

(The maths is the Reed–Solomon code - what CDs and QR codes use to correct errors. RAID 6 is the same idea. All we need is the result: "any k are enough".)

The exercise's `npm run durability`, part A - a simple model: disks die independently at 2% per year, and rebuilding a dead disk's data onto other disks takes 24 hours. An object is lost if, after one of its disks dies, m more die before the repair finishes:

```
── A. Calculation (AFR 2%, 24 hours to repair, disks die independently) ──
   scheme          disk for 1 TB   survives     annual loss chance   durability        lost/yr of 1B objects
   1 copy                1.00 TB    0 disks                 2.0e-2    1.7 nines                     20000000
   2 copies              2.00 TB     1 disk                 2.2e-6    5.7 nines                         2192
   3 copies              3.00 TB    2 disks                1.8e-10    9.7 nines                          0.2
   EC 4+2                1.50 TB    2 disks                 3.6e-9    8.4 nines                            4
   EC 6+3                1.50 TB    3 disks                1.7e-12   11.8 nines                        0.002
   EC 10+4               1.40 TB    4 disks                1.8e-15   14.7 nines                     0.000002
```

- **3 copies vs EC 6+3:** EC gives more durability on half the disk (1.5 TB vs 3 TB) - because it survives not one extra copy but three dead disks. At petabyte scale, "half the disk" means a fortune. That's why nearly every large object store uses erasure coding (e.g. Facebook's f4 system, in a 2014 paper, with Reed–Solomon 10+4).
- **EC 4+2 vs 3 copies:** both survive two disks, but EC 4+2 has fewer nines - because it uses 6 disks, and the more disks, the higher the chance that one of them dies. "How many it survives" alone isn't enough; how many disks in total it depends on matters too.
- **Where's the cost?** Erasure coding's cost is CPU and network: computing parity on writes, and when a disk dies, reading from k other disks to rebuild its fragments. Reads are often assembled from several disks too - for small objects, copies are simpler. So many systems keep small or very frequently read data as copies, and large, cold data in erasure coding.

**Repair speed is part of the nines too.** Experiment 3: if repair takes a week (big disks, slow rebuilds), 3 copies drop from 9.7 to 8.1 nines, EC 6+3 from 11.8 to 9.2. The longer the window of vulnerability, the higher the chance of a second death. That's why, in a large object store, repair is itself a big distributed job - a thousand disks rebuilding one dead disk's data together.

Now the most important part. The model above assumed disks die **independently**. In reality they die together: a rack loses power, a switch goes down, a data center catches fire.

**Failure domain** - a unit (disk, server, rack, power feed, availability zone, region) inside which everything can fail together from a single event.

Part B - 10 racks × 12 disks, 100,000 objects; fragments placed on random disks without thinking about racks, versus each fragment on a different rack; then a whole rack goes down:

```
── B. Failure domain (10 racks × 12 disks, 100,000 objects) ──
   scheme · where the fragments are     unreadable when down:   1 rack  2 racks  3 racks
   3 copies · random disks                                        89      718    2,541
   3 copies · each on a different rack                             0        0      860
   EC 6+3 · random disks                                         611    8,021   26,556
   EC 6+3 · each on a different rack                               0        0        0
```

- **EC 6+3, random:** a single rack going down makes 611 objects unreadable - **more** than 3 copies. Place 9 fragments randomly and the chance that four of them land on the same rack isn't small. Part A's 11.8 nines mean nothing here - that number assumed independent disks.
- **EC 6+3, on different racks:** not one, even with three racks down at once. Erasure coding's strength comes from **spreading across failure domains**.
- And so EC needs many failure domains: keeping 9 fragments apart needs at least 9 racks (with experiment 3's `RACKS=4` this row isn't even possible). At a larger scale the same logic applies to availability zones: S3 Standard keeps its data across several AZs in a region - even if an entire data center goes, the data survives.

**An honest reading of the "11 nines" claim:**

1. It's a **design target**, not a measured guarantee - events that rare never happen often enough to be measured. The more realistic the model's assumptions (independent failures, repair time), the more meaningful the number.
2. It protects you from **hardware** - not from your own mistakes. If a bug in your code or an engineer's wrong command sends a `DELETE`, the object store will delete it very durably. In practice this is the biggest cause of data loss - and the answer to it is versioning (1.6), object lock, and a copy in a separate account or region.

### 1.6 The API's rules - this isn't a file system

The exercise's `npm run inspect` runs seven small tests against SeaweedFS through the S3 API. Each one is a rule that trips you up if you come with file system habits.

**1. Read right after write.** Overwrite the same key 200 times, with a GET immediately each time:

```
   old value returned: 0 / 200
```

Since December 2020, AWS S3 gives **strong read-after-write consistency** for every PUT, DELETE and LIST - after a successful PUT, any GET gets the new one (in Lesson 6.5's terms, close to linearizable for a single object). Before that, overwrites and deletes were eventual - and many old blog posts and Stack Overflow answers still say so. In other S3-compatible systems (or in cross-region replication copies) the rules may differ - "S3-compatible" means the same API, not the same guarantees. Not the claim - the documentation and a test (6.5's Jepsen lesson).

**2. A "folder" is really a prefix.**

```
   LIST Prefix='workspaces/12/' Delimiter='/':
     object  workspaces/12/avatar.png
     "folder" workspaces/12/tasks/   ← not a real thing, just keys that match
   workspaces/12/ → workspaces/99/ "rename": 9 requests (1 LIST + COPY + DELETE per object)
```

LIST with a `Delimiter` makes the API itself split keys at `/` and show them like "folders" (`CommonPrefixes`) - but there are no folders in the index. So "rename the folder" isn't one operation - every object is copied and deleted separately: here 9 requests for 4 objects, two million for a million objects. The design lesson: **don't put anything in a key that might change** (a user-given file name, a task title) - in 1.8.

**3. Writes are whole objects; reads can be partial.**

```
   to change 1 byte, had to send: 8,388,608 bytes (the whole 8 MB)
   reading 1 KB from the middle returned: 1024 bytes · bytes 4194304-4195327/8388608 · matches: yes
```

No append, no "write at this offset" - a direct consequence of 1.4's internal structure. So object storage isn't the place for log files or a database's data files (anything that keeps growing at the end). But reads with `Range` can be partial - playing a video from the middle, a part of a big file, the rest of a download that stopped halfway. (The way to split up writing a big file - multipart upload - is Lesson 8.2.)

**4 and 5. Metadata and the ETag.** `HEAD` gives the size, `Content-Type`, `Content-Disposition` and your own metadata - without the bytes. And for an object uploaded in a single PUT, ETag = the MD5 of the content - after uploading, the client can compare it with its own calculation to check that everything arrived intact.

**6. When two people write at once.** A task's checklist is a JSON object; Rahim and Karim both read it, add their own item, and write:

```
   unconditional:         ["draft","Karim: deploy"]   ← Rahim's item silently lost (last writer wins)
   If-Match (ETag):       Rahim wrote · Karim rejected (412 PreconditionFailed) · after re-reading, Karim wrote
                          ["draft","Rahim: review","Karim: deploy"]
   If-None-Match: * (on a key that already exists): rejected (412 PreconditionFailed)
```

Lesson 5.5's lost update, in object storage. There's no lock - the last PUT wins. The fix is also like 5.5's optimistic concurrency: a **conditional write**. `If-Match: <the ETag at read time>` - "write only if what I read is still there" (compare-and-swap); if it doesn't match, `412`, re-read and retry. `If-None-Match: *` - "create only if it doesn't exist" - blocks the second of two uploads to the same key. (In AWS S3 these two arrived in 2024 - before that, this kind of coordination needed an external database or lock. Again: check whether your system has them.)

But in practice the best answer here is often something else: data that changes together (a checklist) doesn't belong in object storage - keep it in the database. Object storage is good for **write once, read many** things.

**7. Versioning.**

```
   PUT "version one" → PUT "version two" → DELETE
   versions present: 2 · delete markers: 1 · plain GET: 404
   the first version by VersionId: "version one" · GET after copying it back: "version one"
```

With versioning enabled on a bucket, an overwrite doesn't remove the old version, and a DELETE actually places a "delete marker" - a plain GET returns 404, but the old versions are there and can be restored. This is the first layer of 1.5's "protection from your own mistakes". The cost: every version takes space and is billed - so it needs a lifecycle rule alongside (1.7).

### 1.7 Cost, storage classes and lifecycle

An object storage bill arrives in several separate parts, and each one affects the design differently. (The numbers below are approximate AWS us-east-1 list prices at the time of writing - they vary by region and over time; check the pricing page before doing the math. The shape is real, the decimals aren't.)

- **Space:** S3 Standard ~$0.023 per GB-month. By comparison, a database's SSD (EBS gp3) is ~$0.08 per GB-month - and that's separately on the primary and on each replica.
- **Requests:** PUT ~$0.005 and GET ~$0.0004, per thousand. With many small objects this can be the biggest part.
- **Sending data out (egress):** ~$0.09 per GB to the internet - often the biggest and most unexpected part. (Serving through a CDN - Lessons 4.5, 8.2 - and Lesson 10.7's cost questions.)

**Storage class and lifecycle** - objects in the same bucket can be kept in different "classes": frequently read (Standard), rarely read (Infrequent Access - cheaper space, but a separate fee for reads and a minimum duration), and archive (Glacier-style - very cheap, but minutes to hours to get back); and with lifecycle rules objects move from one class to another, or get deleted, automatically by age.

A Lesson 1.3-style estimate for TaskFlow: 50 thousand active users, each averaging 20 attachments a month, 1.5 MB on average:

```
  new each month:   50,000 × 20 × 1.5 MB  =  1.5 TB
  after a year:     ~18 TB

  object storage (Standard):   18,000 GB × $0.023             ≈  $414 / month
  in Postgres (primary + 3 replicas, SSD):
                               18,000 GB × 4 copies × $0.08    ≈  $5,760 / month   (backups extra)

  sending out: if each file is opened 5 times on average, 7.5 TB a month × $0.09 ≈ $675 / month
                → CDN and cache (8.2) - a file opened again and again shouldn't come from object storage every time
```

And most attachments have a familiar life: opened many times in the first week, then almost never. This is where lifecycle rules earn their keep: to Infrequent Access after 90 days; files of deleted workspaces removed completely after 30 days; old versions from versioning removed after 30 days.

### 1.8 TaskFlow's decision

**Only metadata in the database, the bytes in object storage.**

```typescript
class Attachment extends Model<InferAttributes<Attachment>, InferCreationAttributes<Attachment>> {
	declare id: CreationOptional<number>;
	declare taskId: number;
	declare workspaceId: number;
	declare fileName: string; // the user-given name - only for display, never in the key
	declare contentType: string;
	declare size: number;
	declare storageKey: string; // ws/{workspaceId}/att/{uuid} - once set, never changes
	declare etag: string;
	declare createdAt: CreationOptional<Date>;
}
```

**The key rule:** `ws/{workspaceId}/att/{uuid}`. The user-given file name isn't in the key - two `spec.pdf`s would collide, renaming in the UI would mean moving the object (1.6's copy + delete), and putting user-written text in a key means strange characters and path tricks. The real name lives in the database and in `Content-Disposition`. The workspace prefix is there so deleting a workspace (or exporting all of its files) can start with a LIST of one prefix. (In many older articles you'll find advice to put a random hash at the start of S3 keys - to spread the load. AWS announced in 2018 that S3 now handles far more requests per prefix on its own - at least 3,500 writes and 5,500 reads per second per prefix - so that advice isn't needed any more.)

**Dual write again - this time, choose which way it goes wrong.** An attachment means two writes: the object in object storage, the row in the database - Lesson 7.5's dual write, with no shared transaction. Two orders:

```
  row first, then object:   crash in between → row exists, no object → user sees the file in the list, opening it gives 404   ✗ visible to the user
  object first, then row:   crash in between → object exists, no row → nobody sees it, it just costs space                ✓ quiet, fixable
```

Pick the second, plus a nightly job for "orphan" objects: match the bucket's LIST against the database rows, and delete objects older than 24 hours that have no row. (Just like Lesson 7.4 - the gap can't be closed; you can only decide which way it falls and who cleans it up.)

```typescript
type NewAttachment = Pick<
	InferCreationAttributes<Attachment>,
	'taskId' | 'workspaceId' | 'fileName' | 'contentType'
>;

async function saveAttachment(input: NewAttachment, body: Buffer): Promise<Attachment> {
	const storageKey = `ws/${input.workspaceId}/att/${randomUUID()}`;
	// 1. The object first - stopping here leaves only an orphan object (the nightly job removes it)
	const put = await s3.send(
		new PutObjectCommand({
			Bucket: env.ATTACHMENTS_BUCKET,
			Key: storageKey,
			Body: body,
			ContentType: input.contentType,
			// RFC 5987 - non-ASCII names (Bangla file names) survive too
			ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`
		})
	);
	// 2. Then the row - if this fails the user sees an error and retries; nothing else breaks
	return Attachment.create({ ...input, storageKey, size: body.length, etag: put.ETag ?? '' });
}
```

(Here the file is still **uploaded** through the app - `body: Buffer`. What that does with a 1 GB file, and how the browser sends straight to object storage - Lesson 8.2.)

**The remaining decisions:**

- **The bucket is private** - no public access. Files are shown through time-limited links (8.2). (Data leaking from public buckets has been one of the best-known cloud incidents for years; since 2023 AWS keeps public access blocked by default on new buckets.)
- **Versioning on**, with old versions deleted by lifecycle after 30 days. Files of deleted workspaces kept 30 days (to recover from accidental deletion), then removed completely.
- **Attachments older than 90 days go to Infrequent Access.**
- **Things that change together, like a task's checklist or comments - in the database.** Object storage is only for write-once, read-many bytes.

> **Trade-off Table - where TaskFlow's attachments go**

| Where                        | App stateless?    | Load on the database                   | Serving (download)                | Durability                                          | Cost (per GB)                              | Partial change       | When                                                        |
| ---------------------------- | ----------------- | -------------------------------------- | --------------------------------- | --------------------------------------------------- | ------------------------------------------ | -------------------- | ----------------------------------------------------------- |
| Database (`bytea`)           | Yes               | WAL, replicas, backups all heavy (1.2) | Only through the app - board slow | Same as the database (replicas + backups)           | Highest (SSD × copies)                     | No (whole value)     | A few small KB-sized items needed together in a transaction |
| App server's disk            | **No** - 50% 404s | None                                   | Through the instance              | Gone when the instance dies                         | Low                                        | Yes                  | Never (except temp files)                                   |
| Shared file system (NFS/EFS) | Yes               | None                                   | Through the app                   | Good (if managed)                                   | High                                       | Yes                  | Old code that needs `fs`, for a short while                 |
| Object storage (S3-style)    | Yes               | Only the metadata row                  | **Directly** by browser/CDN (8.2) | Very high (EC + across AZs); not from your mistakes | Low; egress and requests billed separately | No - only a full PUT | Nearly all user uploads, backups, exports, log archives     |

---

## 2. Interview Angle

**"Design Instagram/Dropbox - where do the photos/files go?"** - this moment comes up in nearly every design question. A weak answer: "in the database", or just "in S3" (without saying why). A good answer splits it: **metadata** (who, when, which album, the file's key) in the database, **bytes** in object storage; downloads straight from object storage/CDN, not through the app; the key rule (immutable, no user-given names); and the order of the two writes (object first, clean up orphans). Bonus: estimation - how many TB per day, per year, what it costs (in one line, like 1.7).

**"What's wrong with keeping files in the database?"** - name three specific costs, not a vague "slow": WAL and replicas (every byte on every replica), backup/restore size and time (RTO), and serving through the app (pool, event loop). And the honest exception: small and few is fine.

**"How is S3 so durable?"** - Erasure coding (k + m, any k are enough, survive more with less space), spreading across failure domains (AZs), fast repair, and regular verification with checksums. Then name the limit yourself: durability saves you from hardware, not from accidental deletion - versioning, object lock, a copy in a separate account.

**"What's S3's consistency like?"** - Strong read-after-write since 2020 (PUT, DELETE, LIST); before that, eventual for overwrites/deletes - older sources still say so, so answer with the date. Concurrent writes are last writer wins, and the answer to that is a conditional write (`If-Match`).

**In real production:** the best-known incidents: an accidentally public bucket (a data leak); versioning without a lifecycle rule (the bill grows silently); an egress bill nobody estimated (serving big files without a CDN); millions of tiny objects (the request bill larger than the space bill - pack small things into big objects, the Haystack idea); and a script that runs `DeleteObjects` on the wrong prefix - without versioning, there's no way back.

---

## 3. Key Takeaway

- **Object storage** = bytes + metadata + key, in a bucket, over an HTTP API, always the whole object - in exchange for these limits, nearly unlimited size, very high durability, low cost, and reachable from anywhere
- Files **in the database**: the cost lands on the WAL (315 MB of files → 337 MB of WAL, on every replica), backups (361 MB/21 s vs 2.4 MB/0.4 s), and serving - files have to go through the app, the board drops from 14 thousand → 350 q/s. Postgres itself isn't slow; the culprit is "through the app" (proxying object storage does the same)
- Files **on the app server's disk**: statelessness breaks - 50% 404s with round robin, with sticky sessions the uploader is fine but the teammate gets 47% 404s, and replacing an instance loses the files
- Inside, the **metadata index** (key → where, sharded + replicated) and the **bytes** (many objects packed into big files - Haystack) are separate; so there are no "folders", a rename is copy + delete, and bytes can only be rewritten whole
- **Durability** ≠ availability. **Erasure coding** (EC 6+3: 11.8 nines on 1.5× the space, versus 9.7 for 3 copies on 3×) - but only when spread across **failure domains**: placed randomly, one rack makes 611 unreadable; on separate racks, 0
- The API's rules: strong read-after-write (S3, since 2020 - verify on other systems), last writer wins → **conditional writes** (`If-Match`, `If-None-Match`), range reads, the ETag, **versioning** (protection from accidental deletion)
- Metadata in the database, bytes in object storage; keys immutable and free of user-given names; **object first, row second**, with a cleanup job for orphans; a private bucket, versioning + **lifecycle**; and don't forget egress and requests on the bill

---

## 4. New Terms (Glossary)

| Term                          | Meaning                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Object Storage**            | Keeping data as objects (bytes + metadata + key) in a bucket, read and written whole over an HTTP API - the middle can't be changed                                                          |
| **Bucket / Key (Prefix)**     | Bucket - a named container for objects (permission, versioning and lifecycle rules live here); key - an object's unique name; prefix - the leading part of a key, the illusion of a "folder" |
| **Object Metadata**           | Small information kept with the bytes - size, Content-Type, ETag (a fingerprint of the content), your own key-values; available through HEAD without the bytes                               |
| **Durability**                | The probability that data, once written, is not lost over a period (usually a year) - different from availability (whether it can be read right now)                                         |
| **Erasure Coding**            | Splitting an object into k data and m parity fragments, any k of which rebuild the whole - survives m losses on (k+m)/k times the space                                                      |
| **Failure Domain**            | Something inside which everything can fail together from one event - disk, server, rack, AZ, region; copies or fragments must be spread across them                                          |
| **Storage Class / Lifecycle** | Classes of objects by price and read speed (Standard, Infrequent Access, archive); lifecycle rules move or delete objects by age                                                             |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines for each, in your own words.

1. Two more things are coming to TaskFlow: (a) user avatars - one per user, ~30 KB, shown on nearly every page (comments, the board, member lists); (b) a monthly invoice PDF for every workspace, ~100 KB, generated together with the billing transaction and legally required to be kept for 7 years. Where would you keep each - the database or object storage - and why? Assuming 50 thousand users and 5 thousand workspaces, calculate the total size of each. For which would you think about storage classes or lifecycle?
2. Two proposals for the key of TaskFlow's attachments: (a) `ws/{workspaceId}/att/{uuid}`, (b) `att/{uuid}` (the workspace only in the database row). Compare them for three events: moving a task from one workspace to another; deleting all of a workspace's files when a customer leaves (a legal obligation, within 30 days); and the nightly orphan cleanup job. Which would you pick?
3. A manager said: "S3's durability is 11 nines - so attachments don't need a separate backup at all." Which part is right, which part is wrong? Name at least three situations where TaskFlow would lose files despite the 11 nines - and what you'd put in place against each.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

- **(a) Avatars → object storage, with a CDN in front.** Size: 50,000 × 30 KB ≈ 1.5 GB - small, it would fit in the database too. But the question isn't size, it's **serving**: several avatars on nearly every page, meaning millions of reads a day. In the database each one goes through the app (1.2's damage to the board), and caching is hard. In object storage you get a stable URL, cached in the CDN (Lesson 4.5) and in the browser - neither the app nor the database is touched. One subtlety: when an avatar changes, change the key (`avatars/{userId}/{version}.webp`) - the old URL stays cached in the CDN, and a new key means no invalidation hassle (Lesson 4.3).
- **(b) Invoice PDFs → object storage, but carefully.** Size: 5,000 × 12 months × 100 KB ≈ 6 GB a year, ~42 GB over 7 years - not huge even in the database, and "together with the billing transaction" tempts you to put it there. Object storage is still better: it never changes, it's read very rarely, and there's no point carrying it through every nightly backup for 7 years. Handle the transaction question the 1.8 way - the invoice row in the database (the amounts, the status), the PDF generated afterwards into object storage (a BullMQ job, 7.3 - idempotent, key = `invoices/{workspaceId}/{yyyy-mm}.pdf`). Storage class and lifecycle are clear-cut here: Infrequent Access after 90 days, archive after a year, deleted after 7 years. And for legal retention, object lock (nobody can delete it until a set date) - against mistaken or malicious deletes.

**Question 2:**

| Event                               | (a) `ws/{workspaceId}/att/{uuid}`                                                                      | (b) `att/{uuid}`                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Moving a task to another workspace  | Copy + delete every attachment's object (1.6) - or the key and workspace disagree                      | Only the database row changes - the object isn't touched                                  |
| Deleting all of a workspace's files | LIST the prefix `ws/{id}/`, then delete 1000 at a time - complete without even looking at the database | Needs the list of every key from the database - if the database is wrong, some are missed |
| Orphan cleanup                      | Can be split per workspace (one job per prefix)                                                        | A LIST of the whole bucket in one go                                                      |

The pick: in TaskFlow, moving a task between workspaces is very rare, but deleting a workspace is a legal obligation that has to be **complete** - (a). And lifecycle rules can be set by prefix too ("expire the deleted workspace's prefix after 30 days"). When a move does happen, it's a BullMQ job (copy, change the row, then delete the old one - 1.8's order again: new object first, then the row, the old one last). (b) would be the right answer if moves were frequent - the core rule is that whatever is in the key should never need to change.

**Question 3:** The right part: for hardware failures (a disk, a server, even a data center) a separate backup against losing files is almost unnecessary - that's what 11 nines means. The wrong part: durability only protects you from hardware. Situations where files are lost:

- **A code bug or a wrong script:** a wrong condition in the orphan cleanup job (say it read from a database replica that was lagging - Lesson 5.7 - so it thought new files were orphans) deletes real files. The object store will delete them very durably. → **Versioning** (a delete becomes a delete marker, recoverable for 30 days), and safety in the cleanup job: only older than 24 hours, read from the primary, and log the "will delete" list first.
- **Stolen credentials or a malicious person (ransomware):** someone gets an access key and deletes everything, versions included (whoever has the permission can delete old versions too). → **Object lock** (nobody can delete until a set date), and a copy in a **separate account** (replication) where production credentials don't reach.
- **A major region event or a wrong configuration:** a whole region unavailable for a while (durability intact, availability not), or someone writes the bucket's lifecycle rule wrong ("expire after 1 day"). → Replication to another region for important data (Lesson 10.8), and reviewing and testing lifecycle rules like code.

The last word: the question isn't "do we need a backup", it's "which failure do we want protection from, and what are its RPO/RTO" (Lessons 5.7, 1.5). 11 nines for hardware; versioning, locks and separate copies for people and bugs.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (Postgres + SeaweedFS in Docker; `durability` doesn't need Docker)

> **Ready to run in the repo:** [`exercises/lesson-8.1-object-storage/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-8.1-object-storage) - `docker compose up -d --wait && npm install`, then `npm run where`, `npm run stateless`, `npm run durability`, `npm run inspect`. The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in that folder's `README.md`.

`where` stores the same files in Postgres's `bytea` and in object storage - measuring WAL, size and `pg_dump` - then serves files three ways while the board's queries run (through the app, the database from a separate process, and directly from object storage). `stateless` runs two Express instances, local disk vs a bucket, round robin and sticky. `durability` is a calculation and a seeded rack simulation. `inspect` shows the S3 API's seven rules directly.

**Honest note:** verified by running it in the sandbox with Postgres 17 and SeaweedFS 4.47 in Docker: `tsc --noEmit` is clean; `where` several times - every time `bytea`'s WAL ≈ 337 MB, backup 361 MB, and in the "through the app" row the board at 269–369 q/s (nearly unchanged in the other two rows); `stateless` and `durability` run twice each with identical output; all seven parts of `inspect` gave the expected results. The README's experiments 1–3 were run, with the numbers in the README; 4 and 5 are code-changing tasks - yours. The object store is SeaweedFS, not AWS S3 - the statements about S3's consistency, conditional writes and versioning come from AWS's documentation, and SeaweedFS behaved the same way here; verify on other S3-compatible systems. (MinIO's community Docker image is no longer available on Docker Hub - hence SeaweedFS.) Part A of durability is a simple model - the numbers show the shape of a design target, not the measured rate of any real system. The prices in 1.7 are approximate at the time of writing, not a verified bill. (The scripts print their labels in Bangla; the output shown in this edition is translated - the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Predict first:** **before** running `npm run where`, write down - how much WAL `bytea` will produce (less than, equal to, or more than the files' size - why?), and in which of step 3's four rows the board will be slowest. Then run it and compare. With your 3 replicas, how many bytes in total would this upload have put on the network?

2. **Whose fault is it?** Run experiment 1 (`POOL_MAX=20`) and 2 (`PROXY_S3=1`). Put the two numbers side by side and write one paragraph - how much of the board's damage comes from the pool, how much from the app's event loop, and how much from the database. From this result, write a rule for TaskFlow's download route.

3. **Accounting for 148:** in `stateless`'s "local disk, round robin" row, why is it 148 after replacing the instance - not 100, not 200? Explain by hand. Then experiment 4 (sticky by workspace) - it fixes the teammate column, but which column does it never fix, and why?

4. **Nines by hand:** calculate 3 copies' "9.7 nines" by hand - q = AFR × repair time ÷ one year, then 3 × AFR × q². Then `REPAIR_HOURS=168` and `RACKS=4` (experiment 3). If TaskFlow ran its own object store in its own data center (say 4 racks), which scheme would it pick, and why?

5. **The design part:** a one-page design for TaskFlow's attachments: (a) the schema of the `attachments` table (with the Sequelize model); (b) the key rule and why (with question 2 in mind); (c) the upload steps and what happens on a crash, and the conditions of the orphan cleanup job (where it reads from, how old, how it stays safe); (d) the bucket's rules - private, versioning, lifecycle (what happens after how many days), where object lock applies; (e) an estimate like 1.7 - with your own assumed numbers, the space after a year and the monthly bill for requests and egress.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7 (complete, including exit challenges)
Current: 8.1 - Object / Blob Storage (S3-style): How It Works, When You Need It
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; outbox → Redis Streams, BullMQ; nightly analytics in Parquet + DuckDB;
attachments: only metadata in the database (attachments table: storageKey, etag, size, fileName),
bytes in object storage - private bucket, key = ws/{workspaceId}/att/{uuid}, object first then
row, nightly orphan cleanup, versioning + lifecycle (old versions deleted after 30 days,
Infrequent Access after 90 days); uploads still go through the app (changes in 8.2)
Terms learned (Module 8 so far): Object Storage, Bucket / Key (Prefix), Object Metadata,
Durability, Erasure Coding, Failure Domain, Storage Class / Lifecycle
Weak spots: [where you got stuck - fill this in yourself]
Next: 8.2 - File upload at scale: presigned URLs, multipart, CDN delivery (with a SvelteKit frontend)
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over - especially your "whose fault is it" paragraph from #2 and your design from #5. When you are ready, write `next` - we'll go to Lesson 8.2: **File upload at scale - presigned URLs, multipart, CDN delivery (with a SvelteKit frontend).** Today we saw how the board slows down when file **downloads** go through the app. But our **uploads** still go through the app - `saveAttachment(input, body: Buffer)`. What happens when a user uploads a 2 GB screen recording: Express's memory, Nginx's body size and timeouts, and if the network drops at 90%, the whole thing starts again from zero. In 8.2 the browser sends straight to object storage - the app only grants a time-limited permission - big files in pieces, resuming from where they stopped, and then that file reaching the whole world quickly through a CDN.
