# Lesson 8.2 - File Upload at Scale: Presigned URL, Multipart, CDN Delivery

**Module 8 - Storage Systems**

> **Spaced Repetition (Lesson 3.3):** What is Nginx's `client_max_body_size`, and what is its default? And as a reverse proxy, what does Nginx do with a request's body - before sending it to the backend? Today a 2 GB upload will hit these two questions first.

**Prerequisite:** Lesson 2.5 (Idempotency), Lesson 3.3 (Nginx reverse proxy), Lesson 4.5 (CDN), Lesson 7.1 (Little's Law, what an open request holds on to), Lesson 7.4 (Retry), Lesson 7.5 (Outbox), Lesson 8.1 (Object storage, keys, the order of the dual write)

**By the end of this lesson you will be able to:**

1. Say with numbers - memory, connections and time - why big files shouldn't be uploaded through the app server; and design the flow that sends the browser straight to object storage with a presigned URL - what to sign, for how long, and what to verify after the upload
2. Send big files reliably even over a broken network with multipart upload - choosing the part size, resending a single part, resuming from where it stopped after the tab closes, and cleaning up unfinished uploads
3. Design serving private files through a CDN - why a presigned URL per person breaks the CDN's cache, how the CDN's own signed URLs/cookies fix it, and from which domain and how to serve files that users upload

**Tier:** 1 - Runnable Code (SeaweedFS in Docker - S3-compatible, authentication on; real presigned URLs, connections that are really cut midway, and a small CDN)

---

## 0. Where TaskFlow Is Right Now

In Lesson 8.1 the attachments' bytes moved out of the database into object storage. The database holds only metadata, and downloads don't go through the app. But **uploads** still take the old path: the browser sends the file to Express, Express holds it in memory, then `PUT`s it to object storage - 8.1's `saveAttachment(input, body: Buffer)`.

Then TaskFlow's biggest customer - a design agency - started attaching screen recordings. Three incidents in one week:

1. **Monday:** the first 2 GB video - the user saw `413 Request Entity Too Large`. Nginx's `client_max_body_size` had been set to 100 MB. Someone raised it to 5 GB. On Wednesday afternoon four people uploaded big files at once - one Express instance ran out of memory, the container was OOM-killed, and everyone else's requests on that instance got a `502`.
2. **Thursday:** a designer was uploading an 800 MB file on a train. At 90% the network dropped - the upload started again from the beginning. Three times. Support ticket: _"Your upload just doesn't work."_
3. **Friday:** the agency ran a webinar for its customers and posted a link to a release notes PDF in the chat. 300 people opened it at once. The egress line on the object storage bill matched a whole month in one day. And viewers in Singapore said the PDF took 8 seconds to open.

Three incidents, three separate questions: why should files go through the app at all (1.1–1.2), how does a big file get through a broken network (1.3), and how do a thousand people get the same file fast and cheaply (1.5).

---

## 1. Theory

### 1.1 Uploading through the app - what it holds on to

First the spaced repetition answer, because Monday's first hit was right there. Nginx's `client_max_body_size` defaults to **1 MB** - anything bigger gets a `413`. And as a reverse proxy, Nginx by default (`proxy_request_buffering on`) first takes the whole request body itself - in memory if small, in a temp file on disk if large - and only then sends it to the backend. So for a 2 GB upload, 2 GB on Nginx's disk, then another 2 GB to Express. Raising the limit is a one-line change; the real question is what sits behind the limit.

The exercise's `npm run through-app`: TaskFlow's API in a separate process, and 8 users each uploading two 64 MB files at once - each at 16 MB per second (good broadband). Three paths:

```
   path                                      app memory start→peak     uploads open at once    through the app   ping p50 / p99          event loop p99 / max   uploads done
   ping only                                            81 → 99 MB                        0             0.0 MB   0.5 ms / 2.1 ms              1.5 ms / 6.2 ms              -
   buffer (whole file in memory)                      79 → 1159 MB                        8          1024.0 MB   0.4 ms / 2.2 ms            1.8 ms / 434.6 ms        13.71 s
   stream (flows through the app)                      80 → 111 MB                        8          1024.0 MB   0.5 ms / 1.3 ms             1.6 ms / 19.5 ms         8.19 s
   presigned (straight to object storage)               79 → 99 MB                        0             0.0 MB   0.5 ms / 1.2 ms             1.6 ms / 16.7 ms         8.19 s
```

- **Buffer (8.1's path):** eight 64 MB files at once = the app's memory going from 79 MB to **1159 MB**. Nearly double the file size for each upload (Buffers being concatenated, the SDK's copy). And the event loop blocked once for 435 ms. Experiment 1: 624 MB with 4 users - linear. 50 people uploading 2 GB videos at once means about 200 GB of memory - the arithmetic behind Monday's OOM-kill.
- **Stream:** fixes the memory problem - 111 MB, because the body arrives in chunks and goes straight on towards object storage; the whole thing is never in memory at once. In Node, `req` is itself a stream - it can be passed as the `Body` (Lesson 7.4's idea of backpressure works here: if object storage is slow, the stream pauses and memory doesn't fill up). But two things don't change: **1 GB still goes through the app's network** (both in and out), and **every upload holds a connection for its whole duration**.
- **Presigned:** the app only hands out a URL - a request of a few ms. The file never touches the app.

The second point looks big through Lesson 7.1's Little's Law. Uploads in flight = uploads started per second × the duration of each. In the exercise each takes 4 seconds, because the users have good speeds. But that designer on the train:

```
  800 MB, on mobile at ~20 Mbps (≈ 2.5 MB/s)   →   ~5 minutes with 1 request open
  2 GB,  at the same speed                      →   ~14 minutes
```

For that whole time: a connection in Nginx, a socket in Express, and (with streaming) an open request towards object storage - fighting against Nginx's `proxy_read_timeout`, the load balancer's idle timeout, and the deploy's graceful shutdown grace period (Lessons 3.4, 7.3). A deploy means every in-flight 14-minute upload either has to be waited for or cut off. An app server is built for small, fast requests; carrying bytes for a quarter of an hour isn't its job.

So the way out: the file doesn't go through the app - it goes **directly** from the browser to object storage. But object storage is private (8.1), and its credentials can't be given to the browser.

### 1.2 Presigned URL - a limited, time-bound permission

**Presigned URL** - a URL that contains the permission for one specific action (such as "PUT to this key in this bucket"), an expiry, and a signature made with the server's secret key; whoever holds the URL can do exactly that action before it expires - without credentials.

```
  browser                          TaskFlow API                          object storage
  ───────                          ────────────                          ──────────────
  POST /api/attachments/uploads ─►  permission? (can they attach to this task?)
  { fileName, size, contentType }   builds the key: ws/12/att/{uuid}
                                    writes a pending row (1.4)
                                    signs the URL (5 minutes, this key, this size, this type)
                               ◄─  { attachmentId, url }
  PUT url  (2 GB, direct) ──────────────────────────────────────────►  verifies signature → writes
                               ◄──────────────────────────────────────  200 + ETag
  POST /api/attachments/:id/complete ─►  verifies with HEAD (size, type) → ready
```

How the signature works, in one paragraph: the API server and object storage both know a secret key (the browser doesn't). The API arranges the request's key parts - method, bucket, key, expiry, and the headers that are "signed" - into a string by a fixed rule, and computes an HMAC of it with the secret key (AWS's Signature Version 4). When object storage receives the request, it builds exactly the same string itself, computes the HMAC with the secret it holds, and compares. Change a single character and it doesn't match. No database lookup, no session - the permission is inside the URL.

So what can someone do with this URL in hand? The exercise's `npm run presign`, with real requests:

```
── Presigned URL for upload (PUT) ──
    1. correct file, correct content-type                             → 200
    2. the same URL again (before expiry)                             → 200
    3. the same URL, content-type changed (text/html)                 → 403
    4. changing the URL's key to write to another object              → 403
    5. a bigger file, the same URL (size signed)                      → 403
    6. expiry 2 s, used after 3.5 s                                   → 403
    7. a file 50 times bigger on a URL without the size signed        → 200
    8. URL signed with the SDK's default checksum                     → 400 BadDigest
```

Three lessons:

- **Only what's signed is enforced.** 3 and 5 get `403` because we explicitly put content-type and content-length in the list of signed headers. In 7 the size wasn't signed - someone sent a file 50 times bigger, and it went through. By default a presigned PUT doesn't constrain size. So either sign the size (the browser sends the correct `Content-Length` itself), or verify after the upload - better, both (1.4). (S3 has another form - presigned POST, with a policy, where you can set a range like "1 to 100 MB" with `content-length-range`.)
- **A presigned URL is a bearer permission** (2): whoever has it, as many times as they like, before it expires. Someone's browser history, a log, or a link shared by mistake - all of them are permission. So keep the expiry short (a few minutes for uploads - only to **start**; an upload in progress finishes even after the expiry passes), a new key every time (built by the server, never the client - to prevent writing to someone else's object as in 4), and block replay if needed: in experiment 5, signing `If-None-Match: *` makes a second use of the same URL return `412`.
- **A real-world trap** (8): newer versions of the AWS SDK for JavaScript v3 put a checksum of the body in presigned PUT URLs by default - but there's no body at signing time, so it's the checksum of an empty body. When the real file arrives, the server says `BadDigest`. On the client, `requestChecksumCalculation: 'WHEN_REQUIRED'`. This kind of thing lives in a corner of the documentation and gets caught on the first day in production - so keep an end-to-end test of the upload path.

**CORS.** The browser's page is from `app.taskflow.test`, and the PUT goes to object storage's domain - a different origin. By its own security rules, the browser asks first.

**CORS (Cross-Origin Resource Sharing) and preflight** - before sending certain requests (such as a PUT with custom headers) from a page on one origin (domain + port) to another origin, the browser sends an `OPTIONS` request - the preflight - asking "is this method allowed from this origin?"; if the server's answer doesn't allow it, the browser never sends the real request.

```
── CORS … (preflight) ──
       https://app.taskflow.test                → 200 · allow-origin: https://app.taskflow.test
       https://evil.example                     → 403 · allow-origin: (none)
```

So the bucket needs a CORS rule: only TaskFlow's origin, only `PUT` and `GET`, and "exposing" the `ETag` header - with multipart, the browser has to read each part's ETag (1.3). (Caution: CORS is only a browser rule. Anyone can use a presigned URL with `curl` - the security comes from the signature, not from CORS.)

### 1.3 Multipart Upload - big files, broken networks

Thursday's problem: one PUT means one long TCP connection. If it tears midway - even at 90% - object storage throws away the half body (8.1: an object is either all there or nothing), and the upload starts from zero.

**Multipart upload** - splitting a big object into several parts and sending them in separate requests: first start the upload and get an `UploadId`, then each part (with its number) in its own PUT - in any order, in parallel, and on failure only that part again - and finally say "complete" with every part's number and ETag, and object storage joins them into one object.

```
  1. CreateMultipartUpload(key)                         → UploadId           (app, from the server)
  2. UploadPart(UploadId, PartNumber=1, bytes 0–16 MB)  → ETag₁              (browser, presigned URL)
     UploadPart(UploadId, PartNumber=2, bytes 16–32 MB) → ✗ torn → again → ETag₂
     …                                                                        (can run in parallel)
     UploadPart(UploadId, PartNumber=13, last piece)    → ETag₁₃
  3. CompleteMultipartUpload(UploadId, [(1,ETag₁) … (13,ETag₁₃)])  → object created   (app)
     or AbortMultipartUpload(UploadId) → all parts deleted
```

S3's rules (from the documentation): every part except the last is at least 5 MB, at most 10,000 parts, and at most 5 GB in a single ordinary PUT - beyond that, multipart is mandatory. The ETag of an object created by multipart isn't the MD5 of the content - it's built from the parts' MD5s, with the number of parts at the end, like `-13` (in 8.1 I said "not for multipart").

**Resumable upload** - an upload that, when it stops midway (network, tab closed, laptop asleep), continues from where it stopped rather than from the beginning; with multipart this comes from `ListParts` - object storage tells you which parts have already arrived.

The exercise's `npm run resume`: a 200 MB file, on a network that tears on average every 60 MB sent. The uploads are real - presigned URLs, with the connection really cut midway; the "time" is a calculation: 2.5 MB/s (≈20 Mbps) and 150 ms per request:

```
   method                                  done?        sent    × file size  requests      torn      est. time   MD5 match   ETag
   one PUT, network fine                     yes    200.0 MB           1.00         1         0        1.3 min         yes   "…"
   one PUT, broken network                    no    819.3 MB           4.10        15        15        5.5 min           -
   multipart, 5 MB part                      yes    208.0 MB           1.04        44         4        1.5 min         yes   "…-40"
   multipart, 16 MB part                     yes    238.0 MB           1.19        17         4        1.6 min         yes   "…-13"
   multipart, 64 MB part                     yes    758.7 MB           3.79        18        14        5.1 min         yes   "…-4"
   multipart, 16 MB, tab closed midway       yes    238.0 MB           1.19        17         4        1.6 min         yes   "…-13"
                                        13 parts, 4 resent · after closing the tab 6 were already there
```

One run is one roll of the dice - so at the end the script runs a model of the same network, over 1000 different seeds:

```
── Model: the same network, 1000 different seeds (no IO, just byte accounting) ──
   method                       done    sent (avg, × file size)     time avg     time p95     requests
   one PUT                       43%                       2.61      3.5 min      6.5 min            7
   multipart, 5 MB part         100%                       1.04      1.5 min      1.6 min           43
   multipart, 16 MB part        100%                       1.14      1.6 min      1.8 min           17
   multipart, 64 MB part        100%                       1.76      2.4 min      3.7 min           10
```

- **One PUT:** the probability of getting 200 MB through in one go is e^(−200/60) ≈ 3.6%. Each attempt goes some way on average and tears, and those bytes are wasted. In the real run: 15 attempts, 819 MB sent (four times the file) - and it still didn't finish. In the model it finishes within 15 attempts in only 43% of cases. Thursday's designer.
- **Multipart:** each tear wastes only part of one part - 100% finish, with only 14% extra bytes at 16 MB parts.
- **Part size is a trade-off** - just like Lesson 7.4's batches. Bigger parts mean more wasted on each tear: 1.76× at 64 MB, and 3.79 in the real run - one part tore again and again. Smaller parts mean more requests, each with a round trip - 43 at 5 MB. Experiment 2: with a 600 ms round trip (bad mobile), 5 MB is no longer the best (1.8 minutes vs 1.7 for 16 MB). In practice, a medium size (8–16 MB), increased for very large files so the 10,000-part limit isn't exceeded.
- **Tab closed:** the list of finished parts was in the browser's memory, and it's gone. On return, the app asks `ListParts` - 6 are already there - and sends the remaining 7. Not a single byte went again. (So keep the `UploadId` in the database's pending row, not only in the browser's memory.)

And another benefit of multipart, beyond broken networks: parts can go **in parallel**. On a link to a distant region with high latency, a single TCP connection often can't use the full bandwidth; sending 4 parts at once can. (Experiment 3's question.)

**The cost of unfinished uploads:**

```
── Unfinished upload (3 parts sent, then the user left) ──
   visible in LIST objects: 0 · unfinished multipart uploads: 1, space used by parts 24.0 MB
   unfinished uploads after AbortMultipartUpload: 0
```

When a user leaves, the parts they sent stay in object storage - not visible as any object (0 in `LIST`), but they take space and are billed. Thousands of failed big uploads mean terabytes silently piling up. The fix: in the bucket's lifecycle, "abort unfinished multipart uploads after 7 days" (S3's `AbortIncompleteMultipartUpload` rule) - a rule worth having on nearly every bucket.

(In practice you don't write all of this by hand - libraries like Uppy for the browser, and `Upload` from the AWS SDK's `@aws-sdk/lib-storage` - split into parts, send in parallel and retry on their own. But you need to know which numbers to choose and what can break.)

### 1.4 The life of an upload - from pending to ready

With a presigned URL, the file no longer goes through the app - so how does the app know the upload finished, and finished correctly? 8.1's dual write again, this time in three steps: the row, the object, and the news that it's "done".

The attachment's state is a discriminated union - not a jungle of optional fields (main.md's rule, and here the reason is plain: no `etag` unless `ready`, no `reason` unless `rejected`):

```typescript
type Attachment =
	| {
			status: 'pending';
			id: number;
			storageKey: string;
			declaredSize: number;
			contentType: string;
			uploadId: string | null;
			createdAt: Date;
	  }
	| { status: 'ready'; id: number; storageKey: string; size: number; etag: string }
	| { status: 'rejected'; id: number; storageKey: string; reason: string };
```

In the confirm step the app doesn't trust the browser - it asks object storage:

```
── Confirm: the browser said "done", the app verifies ──
       correct upload                           → ready (ETag "…")
       took the URL, never uploaded             → rejected: no object - not uploaded
       size not signed, a bigger file arrived   → rejected: size 1500 (declared 30) - object deleted
```

The full flow, with the failure points:

```
  1. POST /uploads     → pending row (database)             crash → row exists, no object → nightly job: pending older than 24 hours → delete
  2. browser PUT       → object (object storage)            torn → with multipart only the part again; user left → lifecycle abort
  3. POST /complete    → HEAD, verify, ready + outbox event   browser never called it (tab closed right after the last byte) → ↓
  4. (alternative) object storage's event notification ("ObjectCreated") → the same complete, idempotent
```

The subtlety in the third step: the browser can close after sending the last byte but before calling complete. Then the object exists and the row is pending - "uploading…" forever in the user's eyes. Two answers, usually both: object storage's own event notification (S3 can send news of a new object to a queue - Lesson 7.2), and a job that checks old pending rows with `HEAD`. All three paths call the same `complete` function - so it must be idempotent (Lesson 7.4): if already `ready`, do nothing.

And in the transaction that makes it `ready`, an outbox row (Lesson 7.5) - the `attachment.uploaded` event. Everything else follows from there: building thumbnails (a BullMQ job, 7.3), virus scanning (keeping downloads closed to others until the scan finishes - so a `scanning` state in the union), and the search index (8.3).

What this looks like on TaskFlow's SvelteKit side (an example - the exercise has no browser, so this part wasn't run; the same HTTP steps were verified from Node in the exercise):

```typescript
// src/routes/api/attachments/uploads/+server.ts - a SvelteKit server route (BFF, Lesson 9.2)
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { startUpload } from '$lib/server/attachments';

const bodySchema = z.object({
	taskId: z.number().int().positive(),
	fileName: z.string().min(1).max(255),
	contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
	size: z
		.number()
		.int()
		.positive()
		.max(20 * 1024 ** 3) // 20 GB - the business limit, right here
});

export const POST: RequestHandler = async ({ request, locals }) => {
	// locals.user - set from the session in hooks.server.ts, typed via App.Locals augmentation in app.d.ts
	if (!locals.user) error(401, 'login required');
	const input = bodySchema.parse(await request.json());
	// startUpload: checks permission on the task, builds the key, the pending row, and
	// for a small file one presigned PUT, for a big file starts multipart + a presigned URL per part
	return json(await startUpload(locals.user.id, input), { status: 201 });
};
```

```svelte
<!-- src/lib/components/AttachmentUpload.svelte - Svelte 5 -->
<script lang="ts">
	import type { UploadPlan } from '$lib/attachments';

	let { taskId, onDone }: { taskId: number; onDone: (id: number) => void } = $props();

	type Phase =
		| { state: 'idle' }
		| { state: 'uploading'; sent: number; total: number }
		| { state: 'failed'; message: string };
	let phase = $state<Phase>({ state: 'idle' });

	// fetch has no upload progress events (not in every browser yet) - hence XMLHttpRequest
	function put(
		url: string,
		body: Blob,
		contentType: string | null,
		onProgress: (n: number) => void
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', url);
			if (contentType) xhr.setRequestHeader('content-type', contentType); // must send exactly the signed type
			xhr.upload.onprogress = (e) => onProgress(e.loaded);
			xhr.onload = () =>
				xhr.status === 200
					? resolve(xhr.getResponseHeader('ETag') ?? '')
					: reject(new Error(`PUT ${xhr.status}`));
			xhr.onerror = () => reject(new Error('network'));
			xhr.send(body); // the browser sets Content-Length itself - the Blob's size, which was signed
		});
	}

	async function retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
		for (let i = 1; ; i++) {
			try {
				return await fn();
			} catch (e: unknown) {
				if (i >= attempts) throw e;
				await new Promise((r) => setTimeout(r, Math.random() * 1000 * 2 ** i)); // full jitter, 7.4
			}
		}
	}

	async function upload(file: File): Promise<void> {
		const res = await fetch('/api/attachments/uploads', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				taskId,
				fileName: file.name,
				contentType: file.type || 'application/octet-stream',
				size: file.size
			})
		});
		if (!res.ok) {
			phase = { state: 'failed', message: `Could not start (${res.status})` };
			return;
		}
		const plan: UploadPlan = await res.json(); // our own server's type - so trusted here; anything external would get Zod
		const done = new Array<number>(plan.kind === 'multipart' ? plan.partUrls.length : 1).fill(0);
		const progress = (i: number) => (n: number) => {
			done[i] = n;
			phase = { state: 'uploading', sent: done.reduce((a, b) => a + b, 0), total: file.size };
		};
		try {
			if (plan.kind === 'single') {
				await retry(() =>
					put(plan.url, file, file.type || 'application/octet-stream', progress(0))
				);
			} else {
				// one at a time only to keep the example simple; in practice 3–4 at once
				for (const [i, url] of plan.partUrls.entries()) {
					const part = file.slice(i * plan.partSize, (i + 1) * plan.partSize);
					await retry(() => put(url, part, null, progress(i)));
				}
			}
			// the server verifies with ListParts/HEAD itself - it doesn't trust ETags sent by the browser
			const ok = await fetch(`/api/attachments/${plan.attachmentId}/complete`, { method: 'POST' });
			if (!ok.ok) throw new Error(`complete ${ok.status}`);
			onDone(plan.attachmentId);
		} catch (e: unknown) {
			phase = { state: 'failed', message: e instanceof Error ? e.message : 'Unknown error' };
		}
	}
</script>

<input
	type="file"
	onchange={(e) => {
		const f = e.currentTarget.files?.[0];
		if (f) void upload(f);
	}}
/>
{#if phase.state === 'uploading'}
	<progress max={phase.total} value={phase.sent}></progress>
{:else if phase.state === 'failed'}
	<p role="alert">{phase.message}</p>
{/if}
```

(`UploadPlan` is the server's own discriminated union - `{ kind: 'single'; attachmentId; url } | { kind: 'multipart'; attachmentId; partSize; partUrls }`. And the result of `res.json()` comes from the server's own code - so the type is trusted; if it were the answer from some external API, I'd parse it with Zod here.)

### 1.5 Downloads and the CDN - one file, a thousand people

Friday's webinar: 300 people opening the same PDF. The file is private - so each one gets their own presigned GET from the app. "Let's put a CDN in front" (Lesson 4.5) - seems easy. The exercise's `npm run cdn`: 300 viewers, each fetching the popular 5 MB PDF and 4 other files:

```
   path                                          downloads   cache hit   requests to object storage   out of object storage
   no CDN - presigned GET directly                 1500          0%                       1500                  1851.6 MB
   CDN + each person's own presigned URL            1500          0%                       1500                  1851.6 MB
   CDN + the CDN's signed token (cached by path)    1500         87%                        200                    63.3 MB

   token for one file, asking for another workspace's file: 403 · expired token: 403
```

The middle row is the easiest thing in this lesson to get wrong: a CDN was put in place, and not **one** cache hit.

**Cache key** - the parts a cache (browser, CDN) looks at to decide that two requests want "the same thing"; usually the URL's path and query string, sometimes a few headers.

Every viewer's presigned URL is different - signed at a different time, so a different `X-Amz-Date` and `X-Amz-Signature`. In the CDN's eyes, 300 different URLs, 300 different things. All misses, all going to object storage - the same as having no CDN (plus the CDN's own cost).

"Then drop the query from the cache key?" - experiment 4. The hit rate goes up, but now the CDN verifies nothing: once someone has fetched the file, **anyone** who knows just the path gets it from the cache - even with an expired URL, or one they were never given. The private file is no longer private.

The third row's answer: give the job of verifying to the CDN.

**CDN signed URL / signed cookie** - a permission signed with the CDN's own key (for one URL, or as a cookie for many files); the CDN checks the signature and expiry on every request first, then drops the signature and uses only the path as the cache key - and on a miss, fetches from the private bucket with its own permission.

So for 300 people the popular PDF comes from object storage once; the other 299 times from the CDN - from a nearby edge (Singapore's 8 seconds), and 63 MB leaves object storage instead of 1852 MB. The bucket stays private - only the CDN can read it (CloudFront's "Origin Access Control" on AWS). On a page with many files (all of the board's thumbnails), instead of a separate URL for each, a **signed cookie** - signed once, for every file under a path prefix.

Two extra rules, both following from 8.1's key rule:

- **Keys never change** (a new file at `ws/12/att/{uuid}` means a new key) - so the CDN and browser can cache for a long time (`Cache-Control: max-age=31536000, immutable`). Invalidation never comes up (Lesson 4.3). For private files, `private` for the browser's cache, and a separate rule for the CDN - in the CDN's configuration.
- **Don't serve user-uploaded files from your own app's domain.** Someone uploads an HTML file, and it opens from `app.taskflow.test` as `text/html` - that HTML's script runs on TaskFlow's domain, with the user's session (stored XSS). So: user content from a separate domain (e.g. `taskflow-usercontent.test` - like Google's `googleusercontent.com`), `Content-Disposition: attachment` on download, the correct `Content-Type`, and `X-Content-Type-Options: nosniff`.

### 1.6 TaskFlow's decision

- **All uploads go straight to object storage, with presigned URLs.** The app only grants permission (permission check, key, pending row, signing) and verifies at the end. Express's upload route is closed; Nginx's `client_max_body_size` is small again.
- **What gets signed:** the key (built by the server), method, content-type, content-length; expiry 5 minutes (only to start). The size limit in the API (Zod), and checked again with `HEAD` at confirm.
- **Multipart above 100 MB,** 16 MB parts (bigger for very large files, to stay under 10,000), 3 at a time in the browser, each part retried (exponential + jitter). The `UploadId` in the pending row - after the tab closes, resume with `ListParts`.
- **Complete via three paths, one idempotent function:** the browser's `POST /complete`, object storage's event notification, and a job for old pending rows. When ready, `attachment.uploaded` into the outbox → thumbnails, virus scan, search index.
- **Cleanup:** lifecycle aborts unfinished multipart after 7 days; pending rows older than 24 hours → rejected, and their object (if any) deleted.
- **Downloads:** CDN, with the CDN's signed URL (one file) or signed cookie (the board's thumbnails); only the CDN can read the bucket; a separate user-content domain, `Content-Disposition: attachment`, `nosniff`; keys are immutable, so long caching.

> **Trade-off Table - the upload path**

| Path                    | App memory                | App connection/time                     | On a broken network        | Security/control                                  | Complexity                                          | When                                                    |
| ----------------------- | ------------------------- | --------------------------------------- | -------------------------- | ------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Through the app, buffer | File × ~2 for each upload | The whole upload's duration             | From the start             | Simplest - the app sees every byte                | Lowest                                              | Small files (a few MB), few users                       |
| Through the app, stream | Nearly constant           | The whole upload's duration + bandwidth | From the start             | The app sees it, but verifies at the end          | Low                                                 | When the app must see the bytes (e.g. a scan in flight) |
| Presigned PUT (single)  | Nothing                   | A few ms                                | From the start             | Only what's signed; bearer; CORS; needs a confirm | Medium - pending/confirm, CORS                      | Up to ~100 MB                                           |
| Presigned multipart     | Nothing                   | A few ms per part                       | **Only that part; resume** | Like presigned; many part URLs                    | High - UploadId, parts, ListParts, abort, lifecycle | Big files, mobile, unstable networks                    |

---

## 2. Interview Angle

**"Design uploads for YouTube/Dropbox."** - the centre of nearly every "file" design question. The order of a good answer: the client goes straight to object storage (presigned URL - the app only grants permission, and why: memory, connections, bandwidth); multipart for big files (resume, parallelism, torn networks - one number: "2 GB at 20 Mbps = 14 minutes, it will break"); the metadata's state (pending → ready) and the confirm; and when the upload finishes, an event → a processing pipeline (transcode, thumbnail, scan - Lesson 7.x). The interviewer often follows up: "what if the user leaves midway?" (unfinished uploads, lifecycle abort, pending cleanup) and "what if someone sends 100 GB?" (sign the size, a limit in the API, HEAD at confirm).

**"Are presigned URLs safe?"** - Yes, with conditions: a short expiry, a server-built key, signing what you want to enforce (content-type, size), and remembering it's a bearer permission - whoever has it can use it, as many times as they like before it expires. Bonus: CORS isn't security, it's a browser rule.

**"How would you serve private files through a CDN?"** - bringing up the cache key trap on your own is a sign of seniority: each person's presigned URL is different, so the CDN's hit rate is zero; the fix is the CDN's signed URLs/cookies, where the CDN verifies and caches by path, and only the CDN can read the bucket.

**In real production:** the best-known incidents: unfinished multipart uploads without a lifecycle rule - piling up on the bill for months; presigned URLs written to logs (everyone who can read the logs gets the permission); `*` in CORS, and then surprise; no confirm - the database says "ready" while there's no object; presigned PUTs suddenly breaking after an SDK version bump (1.2's checksum); and user HTML served from the same domain - XSS.

---

## 3. Key Takeaway

- Uploading **through the app** means: with buffering, memory ~2× the file for each upload (1159 MB for 8 people); with streaming, memory is fine, but every byte, plus a connection for the whole upload (2 GB at 20 Mbps = ~14 minutes) - fighting Nginx's body buffering, timeouts, and deploys
- **Presigned URL**: signed with the server's secret, time-bound, permission for one action - the browser goes straight to object storage, the app spends a few ms. **Only what's signed is enforced** (content-type, size); it's bearer, reusable before expiry; the server builds the key; **CORS** is a browser rule, not security
- At confirm the app verifies with its own `HEAD`; the state is a union (pending → ready/rejected); complete is idempotent and can be called via three paths; an outbox event goes with ready
- **Multipart**: a tear costs only one part - on a broken network a single PUT finishes 43% of the time, multipart 100%; part size is a trade-off (big = more waste, small = more round trips); **resumable** via `ListParts`; unfinished uploads are invisible but billed - lifecycle abort
- **Cache key**: everyone's presigned URL is different, so the CDN's hit rate is 0% - **CDN signed URLs/cookies** verify and cache by path: 87% hits, 1852 MB → 63 MB out of object storage
- Immutable keys mean long caching; user files from a separate domain, with `attachment` and `nosniff`

---

## 4. New Terms (Glossary)

| Term                               | Meaning                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Presigned URL**                  | A URL carrying permission for one action, an expiry, and a signature made with the server's secret - whoever holds it can do that action before expiry, without credentials                 |
| **CORS / Preflight**               | Before sending a request to another origin, the browser asks permission with `OPTIONS`; if the server doesn't allow it, the browser doesn't send the request - a browser rule, not security |
| **Multipart Upload**               | Splitting a big object into numbered parts sent in separate requests (any order, in parallel, failed parts again), joined at the end by complete                                            |
| **Resumable Upload**               | An upload that continues from where it stopped - with multipart, by learning from `ListParts` which parts have already arrived                                                              |
| **Cache Key**                      | What a cache looks at to decide whether two requests want the same thing - usually path and query; if every one is different, the cache never hits                                          |
| **CDN Signed URL / Signed Cookie** | A permission signed with the CDN's own key - the CDN verifies it, drops the signature and caches by path, and on a miss fetches from the private bucket itself                              |

---

## 5. Reflection Questions

Think before you look at the answers - write at least two or three lines for each, in your own words.

1. TaskFlow's avatar upload (8.1's question 1): an image, at most 5 MB, resized to 256×256 after upload. An engineer said: "such a small file - why bother with presigned URLs? Let's take it in Express with `multer`, resize it right there with `sharp`, and put it in object storage." Which part of their reasoning is right? What could go wrong (Lesson 7.1's event loop, this lesson's 1.1)? Which design would you pick - and what happens to the user who sends an HTML file named as a 5 MB PNG?
2. A user's 3 GB upload started at 10:05, multipart, 16 MB parts. At 10:12 their laptop went to sleep, and they opened it at 11:40. The presigned part URLs had a 15-minute expiry. What happens, step by step - which URLs won't work, what information is where, and how does the upload finish? Which design makes this smoothest - all part URLs at once at the start, or asking for each part's URL separately right before it?
3. Opening a task on TaskFlow's board shows thumbnails of its 20 attachments. One presigned GET for each - 20 signatures per page, and no caching in the CDN. Compare three alternatives: (a) a presigned GET per thumbnail, (b) a CDN signed URL per thumbnail, (c) one CDN signed cookie for the workspace's prefix. For each: the CDN hit rate, the app's work, and security (how long can someone removed from the workspace still see things?).

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** The right part: a 5 MB image doesn't bring 1.1's big problems (a 14-minute connection, gigabytes of memory) - the upload takes a few seconds, the memory a few MB. In a small app this can work fine. But two things can go wrong:

- **Resizing is CPU work.** `sharp` itself runs on a native thread, so it doesn't block the event loop entirely - but many resizes at once fill the API's CPU and memory, which are shared with the board's requests (Lesson 7.1's side note, 8.1's "through the app"). On a Monday morning when a big team updates their profiles together, the API slows down.
- **Resizing sits on the request path.** If it fails (a broken image, a huge-resolution "decompression bomb"), the user's upload fails too, and a malicious image can bring down the API process.

Design: a presigned PUT (content-type `image/*` and size ≤ 5 MB signed), HEAD at confirm, then an outbox event → a BullMQ worker (a separate process, sandboxed - Lesson 7.3) resizes and writes `avatars/{userId}/{version}.webp`. To the worker the original image is "untrusted input" - decode limits (number of pixels), a timeout.

The HTML user: the content-type's name proves nothing - it's whatever the browser says. The worker fails to decode the image → the upload is rejected and the object deleted. And what gets displayed is the webp **the worker built** - the bytes the user sent are never shown directly. Plus 1.5's rule: user content from a separate domain, with `nosniff` - so that even if there's a gap, the browser won't run it as HTML.

**Question 2:** Step by step:

1. 10:05 - the upload starts: `CreateMultipartUpload`, the `UploadId` in the pending row. If all part URLs were handed out at once at the start (192 of them, 3 GB ÷ 16 MB), they all expire at 10:20.
2. 10:12 - the laptop sleeps. Say 80 parts have arrived, and 3 were in flight (those tore - they're not in object storage).
3. 11:40 - the laptop opens. The browser's memory may still have the list of parts (the tab was open), but the remaining 112 URLs have expired - each one `403`.
4. What's still fine: the `UploadId` and 80 parts in object storage (the lifecycle for unfinished uploads is 7 days - so they're there). The `UploadId` in the pending row.
5. Recovery: the browser tells the app "resume" → the app takes the `UploadId` from the pending row, calls `ListParts` (80 are there), and issues new presigned URLs for the **remaining** parts → the browser sends only those → complete.

The smooth design: ask for each part's (or a small batch's) URL right before it's needed - then the expiry can stay short (5–15 minutes), and after sleep new URLs arrive naturally; the extra cost is one small request to the app per part. Handing out everything at the start means either a long expiry (a bearer permission for hours - 1.2's risk), or handling exactly this "expired" path separately. In both cases the real dependency is the same: the `UploadId` on the server, and `ListParts` as the source of truth - not the browser's memory.

**Question 3:**

| Alternative                                | CDN hit rate                                                           | App's work                                | How long a removed member can see                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| (a) presigned GET per thumbnail            | 0% (every URL different - 1.5), or no CDN                              | 20 signatures per page (cheap, but still) | Until the URL expires (e.g. 5 minutes)                                                                          |
| (b) CDN signed URL per thumbnail           | High (cached by path)                                                  | 20 signatures per page                    | Until the URL expires                                                                                           |
| (c) signed cookie for the workspace prefix | High, plus plain stable URLs in the HTML - the browser cache works too | Once per session (and again on expiry)    | Until the cookie expires - keep it short (e.g. 15 minutes), and don't issue it at the next renewal once removed |

The pick: (c) for the board's thumbnails - many small files, the same question for all of them ("is this person a member of this workspace?"), and stable URLs in the HTML mean the browser's own cache works too (keys are immutable). The cost: the prefix boundary has to be right in the design (`ws/{workspaceId}/` - 8.1's key rule paid off here), and a window of visibility after removal until the cookie expires. For a single big file download (a 2 GB video), (b) - a specific permission for one file.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (SeaweedFS in Docker, authentication on)

> **Ready to run in the repo:** [`exercises/lesson-8.2-file-upload/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-8.2-file-upload) - `docker compose up -d --wait && npm install`, then `npm run through-app`, `npm run presign`, `npm run resume`, `npm run cdn`. The full setup, acceptance criteria, experiments and teardown (`docker compose down -v`) are in that folder's `README.md`.

`through-app` runs TaskFlow's API in a separate process and compares three upload paths - the app's memory, open uploads, the event loop. `presign` verifies the rules of presigned PUT/GET with real requests, along with the confirm step and CORS. `resume` sends a single PUT and multipart over a broken network - with the connection really cut midway - and ends with a 1000-seed model. `cdn` runs a small CDN and measures the cache hits of presigned URLs vs CDN tokens.

**Honest note:** verified by running it in the sandbox with SeaweedFS 4.47 in Docker: `tsc --noEmit` is clean; all four scripts were run - `presign` twice (identical apart from ETags), `cdn` three times (identical); `resume` on two seeds (7 and 11); `through-app` once at the defaults and once with experiment 1 - with buffering, memory is linear in the number of uploads, nearly constant in the other two. The README's experiments 1, 2 and 5 were run; 3 and 4 are code-changing tasks - yours. The object store is SeaweedFS, not AWS S3; S3's limits (5 MB, 10,000 parts, 5 GB) come from the documentation. `resume`'s default seed (11) was chosen because its tear distance is close to the average - with seed 7 two tears happen within the first 2 MB and then none, and then all the methods look about the same; so read the averages and p95 from the model's table. `resume`'s times are a calculation, not measured. `cdn` is a small Express proxy, not a real CDN; the token is the idea of a CDN signed URL, not any particular CDN's format. The SvelteKit code (1.4) wasn't run in a browser. (The scripts print their labels in Bangla; the output shown in this edition is translated - the numbers are identical.)

**Once the setup is verified, do these five:**

1. **Calculate first:** before running `through-app`, write down - with buffering, how much memory the app will use for eight 64 MB uploads, and how much with streaming. Then run it and compare. Then the arithmetic for a bad day at TaskFlow: 50 people uploading 2 GB videos at once, at 20 Mbps - how much memory with buffering, and with streaming, how many connections open for how long?

2. **The signed list:** why is `presign`'s number 7 a `200`? In `presign.ts`, remove `content-type` from `signableHeaders` and run number 3 again - what happened, and why? Then experiment 5 (replay) - which of TaskFlow's uploads would you put it on?

3. **Part size:** from `resume`'s model table, compare the averages and p95 for 5, 16 and 64 MB, then again with `RTT_MS=600` (experiment 2) and `DROP_EVERY_MB=20`. Write a short rule: "if the network is like this, the part size is this" - and what TaskFlow's default should be.

4. **The cache key trap** (experiment 4): in `cdn.ts`, drop the query from the cache key in presigned mode. What's the hit rate now? Now, if a user's presigned URL has expired, or they were never given permission - do they get the file just by knowing the path? Write one paragraph on why "the hit rate went up" isn't a success here.

5. **The design part:** a one-page design for TaskFlow's uploads: (a) the API's three routes (`POST /uploads`, `POST /:id/complete`, and `POST /:id/resume` after the tab closes) - each one's input, what it verifies, what it returns; (b) the union of the attachment's states and who triggers each transition (browser, event notification, job); (c) from what size multipart kicks in, the part size, how many at a time; (d) the cleanup rules (lifecycle, pending job) and which metric alerts (e.g. "pending for more than 24 hours"); (e) the download path - which files use which kind of signed URL/cookie.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7 (complete, including exit challenges), 8.1
Current: 8.2 - File upload at scale: presigned URLs, multipart, CDN delivery
TaskFlow state: Nginx + 6 Express instances, CDN, Redis cache; PostgreSQL primary + 3
read replicas, Patroni + etcd; outbox → Redis Streams, BullMQ; attachments: metadata in the database,
bytes in object storage (private bucket, key = ws/{workspaceId}/att/{uuid}); uploads go straight
browser → object storage, presigned URL (key, content-type, size signed, 5 minutes); above 100 MB
multipart (16 MB parts, 3 at a time, UploadId in the pending row, resume with ListParts);
state pending → ready/rejected, complete idempotent (browser, event notification, job), outbox
event on ready → thumbnail/scan/index; lifecycle: unfinished multipart aborted after 7 days; downloads
through the CDN, CDN signed URL/cookie, only the CDN reads the bucket, separate user-content domain
Terms learned (Module 8 so far): Object Storage, Bucket / Key (Prefix), Object Metadata,
Durability, Erasure Coding, Failure Domain, Storage Class / Lifecycle, Presigned URL, CORS /
Preflight, Multipart Upload, Resumable Upload, Cache Key, CDN Signed URL / Signed Cookie
Weak spots: [where you got stuck - fill this in yourself]
Next: 8.3 - Search & inverted index: why LIKE %x% doesn't scale
=======================
```

---

## 8. Next Lesson

Run the exercise and send it over - especially your part-size rule from #3 and your design from #5. When you are ready, write `next` - we'll go to Lesson 8.3: **Search & inverted index - why `LIKE '%x%'` doesn't scale.** TaskFlow now has millions of tasks, comments and attachment names - and users search: "deploy checklist", "invoice", the misspelled "recieve". Today an `attachment.uploaded` event came out at the end of an upload; one of its consumers will have the job of putting it into the search index. But what is that index, really? Why Postgres's `ILIKE '%deploy%'` reads the whole table every time over a million rows (why Lesson 5.4's indexes don't help here), how an inverted index flips things around to "which word is in which document", how results get ordered (relevance), and when Postgres's own full-text search is enough and when Elasticsearch/OpenSearch - with measured numbers.
