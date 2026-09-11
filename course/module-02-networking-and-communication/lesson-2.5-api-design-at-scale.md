# Lesson 2.5 — API Design at Scale: Versioning, Pagination, Idempotency Key, Error Contract

**Module 2 — Networking & Communication (Final Lesson)**

> **Spaced Repetition (Lesson 2.2):** TLS 1.3 কেন TLS 1.2 এর চেয়ে কম round trip এ handshake সম্পন্ন করতে পারে? আর 0-RTT কোন ধরনের operation এ ব্যবহার করা উচিত না, কেন?

**Prerequisite:** Lesson 2.3 (REST), Lesson 1.6 (Stateless/Stateful)

**তুমি এই lesson শেষে পারবে:**

1. API versioning এর বিভিন্ন approach এবং কখন version বাড়ানো প্রয়োজন — বুঝবে
2. Offset-based vs cursor-based pagination এর পার্থক্য এবং কেন বড় dataset এ cursor-based বেশি ভালো — ব্যাখ্যা করতে পারবে
3. Idempotency Key pattern implement করতে পারবে (TypeScript + Express + Zod দিয়ে), এবং এটা কেন payment/critical operation এ অপরিহার্য — বুঝবে
4. একটা consistent Error Contract ডিজাইন করতে পারবে

**Tier:** 1 — Runnable Code (এই lesson এর শেষ অংশে, sandbox এ verify করা TypeScript + Express কোড)

---

## ০. TaskFlow এখন কোথায়

Module 2 জুড়ে আমরা API এর "shape" (REST/GraphQL/gRPC), আর "transport" (HTTP, WebSocket) নিয়ে কথা বলেছি। কিন্তু একটা API যখন production এ বছরের পর বছর চলে, real user দের হাতে থাকে, তখন আরও কিছু বাস্তব সমস্যা সামনে আসে:

- তুমি API তে একটা breaking change আনতে চাও (field এর নাম বদলাতে চাও) — কিন্তু পুরনো client রা তো এখনও পুরনো format এ request পাঠাচ্ছে। কী করবে?
- `GET /api/tasks` করলে ১০ লাখ task ফেরত আসছে — এটা কীভাবে ভাগ করে পাঠাবে?
- একজন user "Create Task" button এ ক্লিক করল, কিন্তু internet slow থাকায় response আসতে দেরি হচ্ছে দেখে সে বিরক্ত হয়ে আবার ক্লিক করল — এখন কি দুইটা task তৈরি হয়ে যাবে?
- একটা error হলে, client কীভাবে বুঝবে ঠিক কী ভুল হয়েছে, প্রতিটা error কি ভিন্ন ভিন্ন format এ আসবে?

এই চারটা প্রশ্নই আজকের lesson এর বিষয়, এবং **তৃতীয় প্রশ্নটা** (idempotency) তোমার জন্য বিশেষভাবে গুরুত্বপূর্ণ — এটা ঠিক সেই ধরনের সমস্যা যেটা তুমি তোমার fintech কাজে ledger/payment নিয়ে কাজ করার সময় নিয়মিত মোকাবিলা করো।

---

## ১. Theory

### ১.১ API Versioning

যখন তোমার API এর একটা breaking change দরকার হয় (এমন পরিবর্তন যেটা পুরনো client কে ভাঙবে — field মুছে ফেলা, response shape বদলানো), তখন সবাইকে একসাথে নতুন version এ upgrade করতে বাধ্য করা যায় না — mobile app এর পুরনো version যাদের ফোনে এখনও install আছে, তারা কী করবে?

**তিনটা common approach:**

```
১. URL Versioning:        GET /api/v1/tasks   vs   GET /api/v2/tasks
২. Header Versioning:     GET /api/tasks
                           Header: Accept-Version: 2
৩. Query Param:            GET /api/tasks?version=2
```

**URL versioning সবচেয়ে বেশি ব্যবহৃত** কারণ এটা সবচেয়ে explicit এবং debug করা সহজ (browser এ URL দেখলেই বোঝা যায় কোন version হিট হচ্ছে, caching এও সহজ কারণ URL আলাদা)। Header versioning "cleaner" মনে হতে পারে (URL "resource" এর জন্য, version metadata header এ যাওয়া উচিত — এই দর্শন থেকে), কিন্তু debugging এবং caching এ একটু বেশি জটিলতা যোগ করে।

**গুরুত্বপূর্ণ নীতি — Backward Compatibility কে যতটা সম্ভব প্রাধান্য দাও:** প্রতিটা field addition version বাড়ানোর দরকার নেই (নতুন optional field যোগ করলে পুরনো client ভাঙে না, কারণ তারা সেই field জানেই না, ignore করে দেয়)। Version বাড়ানো দরকার শুধু তখনই যখন existing behavior বদলে যাচ্ছে বা কিছু সরিয়ে ফেলা হচ্ছে। আর একটা পুরনো version কে সরিয়ে ফেলার আগে একটা **deprecation period** ঘোষণা করা standard practice (যেমন, "v1, ৬ মাস পর বন্ধ হয়ে যাবে, এর মধ্যে v2 তে migrate করুন")।

### ১.২ Pagination — Offset vs Cursor

Lesson 1.3 এর estimation মনে আছে? যদি TaskFlow এ লাখ লাখ task থাকে, `GET /api/tasks` একসাথে সবকিছু ফেরত দিলে সেটা database এবং network, দুই দিকেই বিপর্যয় ডেকে আনবে। তাই data কে ছোট ছোট "page" এ ভাগ করে পাঠানো হয়।

**Offset-based Pagination (সবচেয়ে পরিচিত):**

```sql
SELECT * FROM tasks ORDER BY created_at LIMIT 20 OFFSET 40;
-- মানে: ৪১তম row থেকে শুরু করে পরের ২০টা row দাও (page 3, যদি page size 20 হয়)
```

```
GET /api/tasks?page=3&limit=20
```

**সমস্যা — বড় OFFSET এ ধীর হয়ে যায়:** Database কে `OFFSET 40` মানে বোঝাতে, প্রথমে ৪০টা row **স্ক্যান করে বাদ দিতে হয়**, তারপর পরের ২০টা ফেরত দিতে হয়। যদি তুমি page ৫০,০০০ এ যেতে চাও, database কে প্রথমে ১০ লাখ row স্ক্যান করে বাদ দিতে হবে — এটা exponentially ধীর হয়ে যায় page number বাড়ার সাথে সাথে।

**আরেকটা সূক্ষ্ম সমস্যা — "shifting" যখন concurrent write হয়:** ধরো তুমি page 1 দেখছ (row ১-২০), আর এর মধ্যেই কেউ একটা নতুন task তৈরি করল যেটা sorting এ সবার আগে চলে এলো। তুমি যখন page 2 request করবে (row ২১-৪০), তোমার আগের page 1 এর শেষ item টাই আবার page 2 এর প্রথমে চলে আসতে পারে (কারণ সবকিছু এক ঘর করে সরে গেছে) — user এর কাছে duplicate/missing item দেখা যায়।

**Cursor-based Pagination (production-scale এ বেশি প্রচলিত):**

এখানে "page number" এর বদলে, প্রতিটা response এর সাথে একটা **cursor** (সাধারণত শেষ item এর একটা unique identifier, যেমন তার `id` বা `created_at`) ফেরত দেওয়া হয়। পরের request এ সেই cursor পাঠিয়ে বলা হয় "এর পরে থেকে দাও":

```sql
SELECT * FROM tasks WHERE created_at > '2026-08-19T10:00:00Z' ORDER BY created_at LIMIT 20;
-- "এই timestamp এর পরের ২০টা task দাও" — OFFSET স্ক্যান করার দরকার নেই,
-- index সরাসরি সেই position এ jump করতে পারে
```

```
GET /api/tasks?cursor=eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTE5In0&limit=20
Response: { "tasks": [...], "next_cursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTIwIn0" }
```

> **Trade-off Table — Offset vs Cursor Pagination**

| দিক                            | Offset-based                                           | Cursor-based                        |
| ------------------------------ | ------------------------------------------------------ | ----------------------------------- |
| Implementation                 | সহজ                                                    | একটু জটিল                           |
| বড় dataset এ performance      | ধীর হয়ে যায় (deep pagination)                        | সবসময় দ্রুত (index-based jump)     |
| "নির্দিষ্ট page N এ যাও"       | সম্ভব                                                  | সম্ভব না (শুধু "পরের" বা "আগের")    |
| Concurrent write এ consistency | shifting সমস্যা হতে পারে                               | স্থিতিশীল, duplicate/missing হয় না |
| Best fit                       | ছোট dataset, admin panel (যেখানে "page 5 এ যাও" দরকার) | Infinite scroll, বড় dataset, feed  |

**তোমার Sequelize experience এর সাথে সংযোগ:** Sequelize এ `limit`/`offset` ব্যবহার করা সহজ, কিন্তু বড় scale এ cursor-based pagination করতে হলে `WHERE id > :cursor ORDER BY id LIMIT :limit` প্যাটার্নে querying করতে হয় — এটা তোমার topup-backend এর মতো বড় dataset থাকা প্রজেক্টে সরাসরি প্রাসঙ্গিক।

### ১.৩ Idempotency Key — Retry কে নিরাপদ করা

Lesson 2.2 তে আমরা idempotency শব্দটা প্রথম দেখেছিলাম (0-RTT এর context এ)। আজকে এটা পুরোপুরি formal ভাবে শিখব — এটা তোমার fintech domain knowledge এর সাথে সরাসরি মেলে।

**মূল সমস্যা:** ধরো, একজন user "Create Task" button এ ক্লিক করল। Request server এ পৌঁছালো, task তৈরি হলো, database এ save হলো — কিন্তু response client পর্যন্ত পৌঁছানোর আগেই network এ কিছু একটা সমস্যা হয়ে গেল (timeout)। Client এর দৃষ্টিকোণ থেকে — সে জানেই না request টা সফল হয়েছিল কিনা! তাই client **retry** করে, একই request আবার পাঠায়। কিন্তু server তো আগেরটা already process করে ফেলেছিল — এখন যদি এটাও process করে, **duplicate task তৈরি হয়ে যাবে**।

Payment এর প্রেক্ষিতে ভাবো (তোমার domain!) — এই একই সমস্যা মানে হতে পারে **একই টাকা দুইবার পাঠানো**।

**সমাধান — Idempotency Key:** Client প্রতিটা "attempt" এর জন্য একটা unique key তৈরি করে (সাধারণত একটা UUID), এবং সেটা একটা header এ পাঠায়:

```
POST /api/tasks
Idempotency-Key: 8f14e45f-ceea-467e-bd9f-27dc0f9df4e8
```

Server, প্রতিটা idempotency key এর সাথে তার **প্রথমবার প্রসেস করা ফলাফলটা** save করে রাখে। যদি একই key দিয়ে আবার request আসে (retry), server নতুন করে processing না করে, **আগের saved response টাই ফেরত দেয়** — কোনো duplicate side-effect ছাড়াই।

```
ধাপ ১: Client key=ABC দিয়ে request পাঠালো
        │
        ▼
Server: এই key আগে দেখিনি → processing করো → task তৈরি হলো →
        result টা key=ABC এর সাথে save করে রাখো → client কে response দাও

ধাপ ২ (network timeout এর কারণে retry): Client আবার SAME key=ABC দিয়ে request পাঠালো
        │
        ▼
Server: এই key তো আগেই দেখেছি! → নতুন processing করবে না →
        আগের saved result টাই ফেরত দাও (task আবার তৈরি হবে না)
```

**একটা গুরুত্বপূর্ণ honesty note (web search দিয়ে verify করা হয়েছে):** "Idempotency-Key" header টা একটা de-facto industry standard (Stripe এটা জনপ্রিয় করেছিল, এবং বেশিরভাগ payment/API platform এটাই copy করেছে), কিন্তু এটা আনুষ্ঠানিক RFC standard না। একটা IETF draft আছে (draft-ietf-httpapi-idempotency-key-header), কিন্তু সেটা RFC হওয়ার আগেই expire হয়ে গেছে। মানে — header এর **নাম** সবাই একই ব্যবহার করে, কিন্তু retention period, duplicate-but-different-body handling, ইত্যাদি খুঁটিনাটি প্রতিটা company নিজের মতো define করে। যদি তুমি কোনো payment provider এর সাথে integrate করো, তাদের নিজস্ব documentation পড়াটাই সঠিক পথ, "এটা তো standard" ধরে নেওয়া ঠিক না।

### ১.৪ Error Contract — সামঞ্জস্যপূর্ণ Error Response

একটা বড় API তে অনেক জায়গায় error হতে পারে — validation fail, resource not found, unauthorized, internal error। যদি প্রতিটা জায়গায় ভিন্ন ভিন্ন shape এ error response যায়, client-side code এ প্রতিটার জন্য আলাদা handling লিখতে হয়, যেটা maintain করা কঠিন।

**একটা consistent error contract** — যেকোনো error, একই shape এ আসবে:

```json
{
	"error": {
		"code": "VALIDATION_ERROR",
		"message": "Request body failed validation.",
		"details": { "field": "title", "issue": "cannot be empty" }
	}
}
```

`code` টা machine-readable (client code এটা দিয়ে `switch` করতে পারে), `message` মানুষের পড়ার জন্য, আর `details` অতিরিক্ত context (optional)। এইভাবে HTTP status code (400, 404, 500) আর এই error body একসাথে মিলে client কে সম্পূর্ণ তথ্য দেয় — শুধু status code যথেষ্ট না, কারণ "400" অনেক কারণে হতে পারে, `code` field সেটা specific করে।

---

## ২. Interview Angle

Idempotency নিয়ে একটা প্রায় guaranteed interview প্রশ্ন (বিশেষ করে fintech/payment company তে) — "তুমি কীভাবে নিশ্চিত করবে একজন user দুইবার একই payment না করে ফেলে, network retry এর কারণে?" এখানে ভালো উত্তরে Idempotency Key pattern টা explain করা উচিত, এবং সাথে এটাও বলা উচিত যে **idempotency key টা client generate করে**, server না — কারণ client-ই জানে কোনটা "একই attempt এর retry" আর কোনটা "সম্পূর্ণ নতুন request"।

Pagination নিয়ে একটা common question — "একটা social media feed এর জন্য কোন pagination ব্যবহার করবে?" এখানে cursor-based সঠিক উত্তর, কারণ feed এ নতুন post ক্রমাগত যোগ হতে থাকে (Lesson এর "shifting" সমস্যা এখানে সরাসরি প্রাসঙ্গিক), আর কেউ সাধারণত "page 47 এ যাও" করে না, শুধু scroll করে যায়, যেটা cursor-based pattern এর সাথে natural fit।

---

## ৩. Key Takeaway

- API Versioning প্রয়োজন যখন breaking change আসে; URL versioning (`/v1/`, `/v2/`) সবচেয়ে বেশি প্রচলিত এবং debug-friendly
- Offset pagination সহজ কিন্তু বড় dataset এ ধীর এবং concurrent write এ "shifting" সমস্যা তৈরি করে
- Cursor pagination দ্রুত এবং স্থিতিশীল, কিন্তু "নির্দিষ্ট page এ jump" করা যায় না — infinite scroll/feed এর জন্য আদর্শ
- Idempotency Key — client-generated unique key, retry এ duplicate side-effect প্রতিরোধ করে; POST/PATCH এর মতো non-idempotent operation এ ব্যবহৃত হয়
- "Idempotency-Key" একটা de-facto standard (Stripe থেকে জনপ্রিয়), কিন্তু আনুষ্ঠানিক RFC না — প্রতিটা provider এর নিজস্ব খুঁটিনাটি থাকতে পারে
- একটা consistent Error Contract (`code`, `message`, `details`) client-side error handling কে predictable করে তোলে

---

## ৪. নতুন Term (Glossary)

| Term                        | অর্থ                                                            |
| --------------------------- | --------------------------------------------------------------- |
| **API Versioning**          | API এর বিভিন্ন version কে আলাদা করে maintain করার কৌশল          |
| **Deprecation Period**      | পুরনো API version সরিয়ে ফেলার আগে দেওয়া সময়সীমা              |
| **Offset-based Pagination** | `LIMIT`/`OFFSET` দিয়ে page ভাগ করা                             |
| **Cursor-based Pagination** | শেষ item এর reference দিয়ে "পরের batch" চাওয়া, index-friendly |
| **Idempotency Key**         | client-generated unique identifier, retry কে নিরাপদ করার জন্য   |
| **Error Contract**          | সব API error এর জন্য একটা সামঞ্জস্যপূর্ণ response shape         |

---

## ৫. Reflection Questions

1. TaskFlow এর "Activity Log" feature (Lesson 1.3 এর exercise মনে আছে?) এর জন্য কোন ধরনের pagination (offset নাকি cursor) ব্যবহার করবে, আর কেন?
2. Idempotency Key কে server এর কাছে সংরক্ষণ করার জন্য কতক্ষণ রাখা উচিত (permanently, নাকি একটা TTL দিয়ে)? তোমার মতে কোনটা যুক্তিসঙ্গত, এবং কেন (Lesson 2.1 এর TTL concept থেকে reasoning ধার করতে পারো, কিন্তু এবার সঠিক প্রসঙ্গে)?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** Activity Log একটা ক্রমাগত বেড়ে চলা, chronological log — নতুন entry সবসময় শেষে (বা শুরুতে, timestamp অনুযায়ী) যোগ হতে থাকে, আর ইউজার সাধারণত "recent activity" দেখতে scroll করে, নির্দিষ্ট page নম্বরে যায় না। তাই **cursor-based pagination** এখানে সঠিক পছন্দ — বড় ডেটাসেট, ক্রমাগত insertion, আর "page N এ যাও" এর দরকার নেই।

**প্রশ্ন ২:** Idempotency Key permanently রাখাটা practical না — storage ক্রমাগত বাড়তেই থাকবে, আর বাস্তবেও network retry সাধারণত request পাঠানোর কয়েক সেকেন্ড থেকে কয়েক মিনিটের মধ্যেই ঘটে (client ততক্ষণে বুঝে যায় request সফল হয়েছে বা fail হয়েছে)। তাই একটা reasonable TTL (যেমন ২৪ ঘণ্টা) রাখাই যুক্তিসঙ্গত — এই সময়ের মধ্যে retry এলে idempotency protection পাওয়া যাবে, তারপর key expire হয়ে storage থেকে সরে যাবে। এটাই সেই একই TTL ধারণা যেটা 2.1 তে শিখেছিলাম, কিন্তু এখানে এটা DNS record না, এটা "কতক্ষণ একটা idempotency record মনে রাখব" — সম্পূর্ণ ভিন্ন প্রসঙ্গে একই "expiry time" ধারণার প্রয়োগ।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code**

আজকে আমরা সরাসরি একটা কাজ-করা Idempotency Key implementation দেখব এবং verify করব — এটা sandbox এ চালিয়ে পরীক্ষা করা হয়েছে, `tsc --noEmit` clean pass করেছে, এবং curl দিয়ে ৬টা scenario টেস্ট করে দেখানো হয়েছে।

**`package.json`:**

```json
{
	"name": "taskflow-idempotency-exercise",
	"version": "1.0.0",
	"private": true,
	"type": "commonjs",
	"scripts": {
		"build": "tsc",
		"typecheck": "tsc --noEmit",
		"start": "node dist/server.js",
		"dev": "ts-node server.ts"
	},
	"dependencies": {
		"express": "^4.21.2",
		"zod": "^3.24.1"
	},
	"devDependencies": {
		"@types/express": "^4.17.21",
		"@types/node": "^22.10.2",
		"ts-node": "^10.9.2",
		"typescript": "^5.7.2"
	}
}
```

**`tsconfig.json`:**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "commonjs",
		"moduleResolution": "node",
		"lib": ["ES2022"],
		"outDir": "dist",
		"rootDir": ".",
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"exactOptionalPropertyTypes": true,
		"noImplicitOverride": true,
		"noUnusedLocals": true,
		"noUnusedParameters": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true
	},
	"include": ["server.ts"]
}
```

**`server.ts`:**

```typescript
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ---------- Domain Types ----------

interface Task {
	id: string;
	title: string;
	description: string | null;
	createdAt: string;
}

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
		details?: unknown;
	};
}

type ApiResponseBody = Task | ApiErrorBody;

interface IdempotencyRecord {
	statusCode: number;
	body: ApiResponseBody;
}

// ---------- "Storage" (in-memory for this exercise) ----------
// NOTE: এই exercise এ Map ব্যবহার করা হয়েছে শুধু demonstration এর জন্য।
// Production এ (Module 4.4 এর পরে) এটা Redis এ থাকা উচিত, কারণ:
//   1. Server restart হলে in-memory data হারিয়ে যায় (durability নেই)
//   2. Horizontal scaling এ (Lesson 1.6) একাধিক server এর মধ্যে এই state শেয়ার হবে না
const idempotencyStore = new Map<string, IdempotencyRecord>();
const tasks: Task[] = [];

// ---------- Validation Schema ----------
// Runtime input (req.body) কখনো সরাসরি বিশ্বাস করা হয় না — Zod দিয়ে parse করা হয়
const createTaskSchema = z.object({
	title: z.string().min(1, 'title is required and cannot be empty'),
	description: z.string().optional()
});

type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ---------- Error Contract Helper ----------
// exactOptionalPropertyTypes: true থাকায়, `details: undefined` explicitly assign করা যায় না,
// তাই conditional object construction করা হয়েছে
function buildErrorResponse(code: string, message: string, details?: unknown): ApiErrorBody {
	if (details === undefined) {
		return { error: { code, message } };
	}
	return { error: { code, message, details } };
}

// ---------- App ----------

const app = express();
app.use(express.json());

app.post(
	'/api/tasks',
	(
		req: Request<Record<string, never>, ApiResponseBody, unknown>,
		res: Response<ApiResponseBody>
	): void => {
		const idempotencyKey = req.header('Idempotency-Key');

		if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
			const body = buildErrorResponse(
				'MISSING_IDEMPOTENCY_KEY',
				'Idempotency-Key header is required for this operation.'
			);
			res.status(400).json(body);
			return;
		}

		// ধাপ ১: এই key আগে দেখা গেছে কিনা check করো — যদি হ্যাঁ, cached result ফেরত দাও,
		// আবার business logic execute কোরো না (এটাই idempotency এর মূল কথা)
		const cached = idempotencyStore.get(idempotencyKey);
		if (cached !== undefined) {
			res.status(cached.statusCode).json(cached.body);
			return;
		}

		// ধাপ ২: body validate করো
		const parseResult = createTaskSchema.safeParse(req.body);
		if (!parseResult.success) {
			const body = buildErrorResponse(
				'VALIDATION_ERROR',
				'Request body failed validation.',
				parseResult.error.flatten()
			);
			idempotencyStore.set(idempotencyKey, { statusCode: 422, body });
			res.status(422).json(body);
			return;
		}

		// ধাপ ৩: actual "write" — এটাই সেই non-idempotent অংশ যেটা আমরা রক্ষা করছি
		const input: CreateTaskInput = parseResult.data;
		const newTask: Task = {
			id: randomUUID(),
			title: input.title,
			description: input.description ?? null,
			createdAt: new Date().toISOString()
		};
		tasks.push(newTask);

		idempotencyStore.set(idempotencyKey, { statusCode: 201, body: newTask });
		res.status(201).json(newTask);
	}
);

app.get('/api/tasks', (_req: Request, res: Response<{ tasks: Task[]; count: number }>): void => {
	res.status(200).json({ tasks, count: tasks.length });
});

const PORT = 3000;
app.listen(PORT, (): void => {
	console.log(`TaskFlow idempotency demo server listening on port ${PORT}`);
});
```

**`README.md`:**

```markdown
# Idempotency Key Demo — TaskFlow Task Creation

## কী বানাচ্ছি

একটা Express + TypeScript endpoint যেটা Idempotency-Key header দিয়ে
duplicate task creation প্রতিরোধ করে — network retry হলেও একই task দুইবার তৈরি হবে না।

## Prerequisite

Node.js 18+ (crypto.randomUUID এর জন্য), npm। Docker লাগবে না।

## Setup

npm install

## Run

npm run build && npm start

# অথবা dev mode এ: npm run dev

# Server চলবে http://localhost:3000 এ

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

# Idempotency-Key ছাড়া request -> 400 আসার কথা

curl -X POST http://localhost:3000/api/tasks \
-H "Content-Type: application/json" \
-d '{"title":"Test"}'

# Expected: {"error":{"code":"MISSING_IDEMPOTENCY_KEY",...}} status 400

# একই key দিয়ে দুইবার request পাঠাও

curl -X POST http://localhost:3000/api/tasks \
-H "Content-Type: application/json" \
-H "Idempotency-Key: test-key-1" \
-d '{"title":"Fix bug"}'

# তারপর ঠিক একই command আবার চালাও (একই key)

# Expected: দুইবারই ঠিক একই "id" ফেরত আসবে

# Verify duplicate তৈরি হয়নি

curl http://localhost:3000/api/tasks

# Expected: count হবে 1, দুইটা call সত্ত্বেও (কারণ দ্বিতীয়টা ছিল retry)

## কী দেখার জন্য এটা বানানো

লক্ষ্য করো — একই Idempotency-Key দিয়ে দুইবার POST করলেও, response এর "id"
field ঠিক একই থাকে, আর GET /api/tasks এ শুধু ১টা task দেখাবে, ২টা না।

## নিজে ভেঙে দেখো (Experiments)

1. একই key দিয়ে কিন্তু ভিন্ন body (ভিন্ন title) পাঠিয়ে দেখো কী হয় —
   এই code টা এখন body বদলে গেলেও পুরনো cached result-ই ফেরত দেয়। এটা কি
   ঠিক আচরণ? (Stripe এর মতো real-world system এখানে একটা 409 Conflict
   error দেয় যদি একই key তে ভিন্ন body আসে — এই code এ সেটা যোগ করার
   চেষ্টা করো)
2. idempotencyStore তে একটা TTL/expiry যোগ করার চেষ্টা করো (Reflection
   Question 2 এর উত্তর অনুযায়ী)
3. Server বন্ধ করে আবার চালাও — সব idempotency record হারিয়ে যায় কেন?
   (এটাই in-memory storage এর সীমাবদ্ধতা যেটা README এ mention করা আছে)

## Project Structure

idempotency-exercise/
├── package.json
├── tsconfig.json
├── server.ts # সব logic এখানে (এই exercise এর scope এ single file)
└── README.md
```

**Verification (sandbox এ চালিয়ে যাচাই করা হয়েছে):**

- `tsc --noEmit` → clean pass, কোনো type error নেই
- Missing header → `400 MISSING_IDEMPOTENCY_KEY` ✓
- Invalid body → `422 VALIDATION_ERROR` ✓
- প্রথমবার valid request → `201`, নতুন task তৈরি ✓
- **একই key দিয়ে retry → `201`, একদম SAME task id, নতুন task তৈরি হয়নি** ✓
- ভিন্ন key → নতুন, ভিন্ন task তৈরি হয় ✓
- চূড়ান্ত count = ২ (৩ না, কারণ retry টা duplicate করেনি) ✓

তুমি চাইলে এই code টা নিজের মেশিনে চালিয়ে experiment গুলো try করতে পারো।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, Module 2 (2.1–2.5)
Current: Module 2 সম্পূর্ণ, Module 2 Exit Challenge বাকি
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): [System Design, Trade-off, Requirements, Scope, Estimation,
HLD/Deep Dive, DAU/QPS, TCP Handshake, TLS, Latency/Throughput, Availability/
Reliability, SLA/SLO/Error Budget, Scaling, Stateless/Stateful]
Terms learned (Module 2): DNS, TTL, Recursive/Iterative Query, DoH/DoT, TCP vs UDP,
Cipher Suite, 0-RTT, REST, GraphQL, N+1 Problem, gRPC, Protobuf, Long Polling, SSE,
WebSocket, WebTransport, API Versioning, Offset/Cursor Pagination, Idempotency Key,
Error Contract
Weak spots: Multi-part প্রশ্নের সব sub-part কভার করা; trade-off বলার সময় cost/ছাড়
স্পষ্টভাবে বলা — তবে সামগ্রিকভাবে reasoning এবং concrete-thinking অনেক শক্ত হয়েছে
Module 2 জুড়ে (2.3, 2.4 এর উদাহরণ)
First Tier 1 exercise completed: Idempotency Key pattern in TypeScript/Express,
verified in sandbox
Next: Module 2 Exit Challenge, তারপর Module 3 — Load Balancing & Proxies
=======================
```

---

## ৮. পরের ধাপ

কোড টা নিজে চালিয়ে দেখো, আর experiment গুলো একটা করে try করো (বিশেষ করে #১ — duplicate key কিন্তু ভিন্ন body এর case টা, এটা real-world এ একটা গুরুত্বপূর্ণ edge case)। রেডি হলে `next` লিখো — **Module 2 Exit Challenge** এ যাব, যেখানে REST/GraphQL/gRPC, WebSocket/SSE, versioning/pagination/idempotency — এই পুরো module এর concept গুলো একসাথে একটা integrative challenge এ প্রয়োগ করব।
