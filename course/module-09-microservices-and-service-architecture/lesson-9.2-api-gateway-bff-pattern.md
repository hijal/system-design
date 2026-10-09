# Lesson 9.2 - Service Communication, API Gateway, BFF Pattern

**Module 9 - Microservices & Service Architecture**

> **Spaced Repetition (Lesson 3.1):** L4 আর L7 load balancer এর পার্থক্য কী - কোনটা URL এর path বা একটা header দেখে ঠিক করতে পারে request কোথায় যাবে, আর কোনটা শুধু IP আর port দেখে? আজকের API gateway এই দুটোর কোনটা, এক লাইনে বলতে পারবেন।

**Prerequisite:** Lesson 1.3 (Latency এর সংখ্যা), Lesson 2.3 (REST vs GraphQL vs gRPC), Lesson 2.5 (API versioning), Lesson 3.1 (L4 vs L7), Lesson 3.3 (Reverse proxy), Lesson 7.1 (Temporal coupling), Lesson 7.5 (Event), Lesson 9.1 (Strangler fig, database per service)

**আপনি এই lesson শেষে পারবেন:**

1. দুটো service এর মধ্যে কোন কথা synchronous (request/response) আর কোনটা event হবে, একটা নিয়ম দিয়ে ঠিক করতে পারবেন - আর ভেতরের call এর protocol (REST বনাম gRPC) বাছতে পারবেন
2. কেন browser বা mobile app কে ভেতরের service গুলো সরাসরি ডাকতে দেওয়া উচিত না - round trip এর ধাপ আর byte এর মাপা সংখ্যা দিয়ে বলতে পারবেন; আর একটা **BFF** design করতে পারবেন (TaskFlow এর SvelteKit এর server route সহ)
3. একটা **API gateway** এর দায়িত্ব কী আর কী না, বলতে পারবেন - বিশেষ করে পরিচয় (token) কোথায় যাচাই হয় আর gateway এর পেছনে সেটা কীভাবে নিরাপদে যায়; আর gateway দিয়ে canary routing

**Tier:** 1 - Runnable Code (আলাদা Node process গুলো আলাদা service, browser এর network এর একটা model, একটা খেলনা gateway; Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

Lesson 9.1 এ সিদ্ধান্ত: TaskFlow একটা modular monolith, আর শুধু files processing আলাদা service এ। কাজ শুরু হলো। একই মাসে TaskFlow এর iOS/Android app ও বের হলো। তিন সপ্তাহে তিনটা ঘটনা:

1. **Mobile app ধীর।** Task খুললে app চারটা request পাঠায় - task, assignee, comment, comment এর author। ঢাকায় 4G তে একটা task খুলতে প্রায় আধা সেকেন্ড, আর app store এর review তে: "প্রতিটা task খুলতে loading spinner"। Monitoring এ server এর p99 ২০ ms এর নিচে - server দোষী না।
2. **Files service এর নিজের login।** Files team তাদের নতুন service এর জন্য নিজেরা JWT যাচাই লিখল - আর মেয়াদ (`exp`) দেখতে ভুলে গেল। Logout করা user এর পুরনো token দিয়ে তিন দিন ধরে thumbnail আসছিল। আর browser এখন দুটো domain এ কথা বলে - CORS এর config দুই জায়গায়।
3. **Security review।** একজন pentester দেখাল: একটা ভুল load balancer এর নিয়মে tasks এর ভেতরের port বাইরে থেকে পৌঁছানো যাচ্ছিল। আর tasks service `x-user-id` header দেখে বোঝে request কার - তাই যে কেউ header এ অন্যের id লিখে অন্যের task পড়তে পারত।

তিনটা ঘটনার পেছনে একটাই প্রশ্ন: service গুলো একে অপরের সাথে আর বাইরের দুনিয়ার সাথে **কীভাবে** কথা বলবে - কে কাকে ডাকবে, কোন দরজা দিয়ে, আর "এটা কে পাঠাল" এর উত্তর পথে কীভাবে যাবে।

---

## ১. Theory

### ১.১ দুটো service কীভাবে কথা বলে - ডাক, নাকি খবর

দুটো service এর কথা বলার দুটো মৌলিক ধরন, আর দুটোই আমরা আগে দেখেছি:

- **Request/response (synchronous):** "আমাকে এখন এটা দিন" - HTTP বা gRPC, উত্তরের অপেক্ষা। Lesson 9.1 এর board: tasks service users কে ডাকে, উত্তর না আসা পর্যন্ত board আটকে থাকে।
- **Event/message (asynchronous):** "এটা ঘটেছে" - outbox → stream (Lesson 7.5), যার দরকার সে শোনে, কেউ অপেক্ষা করে না।

কোনটা কখন? একটা সরল প্রশ্ন: **user কি এই উত্তরের জন্য এখন অপেক্ষা করছে?**

| পরিস্থিতি                                                         | ধরন              | কেন                                                                                            |
| ----------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| Task খুললে assignee এর নাম দেখানো                                 | Request/response | User এখনই দেখবে; উত্তর ছাড়া page বানানো যায় না                                               |
| Task assign হলে email পাঠানো                                      | Event            | User email এর জন্য অপেক্ষা করছে না; notification service বন্ধ থাকলেও assign হওয়া উচিত (7.1)   |
| File upload হলে thumbnail বানানো (9.1 এর files service)           | Event            | কয়েক সেকেন্ডের কাজ; upload এর উত্তর তার জন্য আটকানো যায় না                                   |
| Task তৈরির আগে plan এর সীমা পেরিয়েছে কিনা দেখা                   | Request/response | উত্তরের উপর নির্ভর করে তৈরি হবে কি হবে না - কিন্তু এটা কি অন্য service এ থাকা উচিত? (9.1, 9.3) |
| অন্য service এর data এর একটা কপি নিজের কাছে রাখা (search, report) | Event            | Lesson 7.5 এর event-carried state, 8.3 এর search index                                         |

Request/response এর দাম Lesson 7.1 এর **temporal coupling**: দুটো service কে একই মুহূর্তে জীবিত থাকতে হয়। তাই যেখানে সম্ভব, event; যেখানে user অপেক্ষা করছে, request - আর তখন timeout আর fallback (9.1 এর ১.৩, 9.4)।

**Protocol - REST, নাকি gRPC?** (Lesson 2.3) বাইরের দুনিয়ার জন্য (browser, অন্য কোম্পানি) REST/JSON প্রায় সবসময়। ভেতরের service থেকে service এ gRPC এর যুক্তি আছে: binary (Protocol Buffers - JSON এর চেয়ে ছোট আর parse দ্রুত), HTTP/2 এর একটা connection এ অনেক call, streaming, আর সবচেয়ে বড় - `.proto` file থেকে দুই দিকের typed client বানানো, তাই contract ভাঙলে compile এর সময়ই ধরা পড়ে। দাম: আরেকটা tool এর শিকল, browser এ সরাসরি চলে না (grpc-web লাগে), আর debugging এ `curl` দিয়ে দেখা কঠিন। অল্প কয়েকটা service আর TypeScript সব জায়গায় হলে, REST আর একটা ভাগ করা **Zod schema এর package** (দুই দিকই একই schema দিয়ে parse করে, version সহ) প্রায় একই নিরাপত্তা দেয় - কম জটিলতায়।

### ১.২ Browser সরাসরি service গুলো ডাকলে

Monolith এ browser একটা server কে চিনত। এখন service অনেক - browser কি প্রতিটাকে আলাদা ডাকবে? ঘটনা ১ এর page টা মাপি।

Exercise এর `npm run bff`: TaskFlow এর "task detail" page - task, assignee, ২০টা comment, আর তাদের author। Browser এর network একটা model: প্রতিটা request এ একটা round trip (RTT), আর উত্তরের byte একটা ভাগ করা পাইপে - desktop (RTT 20 ms, 50 Mbps) আর mobile (RTT 100 ms, 5 Mbps)। সার্ভারের কাজ আসল:

```
── "Task detail" page: task + assignee + 20 comments + authors · 1 ms per call inside the data center · 40 times ──
   path                           browser network                requests  steps  to browser        p50        p95
   browser → services, direct     desktop (RTT 20 ms, 50 Mbps)          4      3     25.2 KB    71.5 ms    74.1 ms
   browser → web BFF              desktop (RTT 20 ms, 50 Mbps)          1      1     10.2 KB    28.9 ms    30.3 ms
   browser → services, direct     mobile (RTT 100 ms, 5 Mbps)           4      3     25.2 KB   348.7 ms   350.9 ms
   browser → web BFF              mobile (RTT 100 ms, 5 Mbps)           1      1     10.2 KB   123.6 ms   125.0 ms
   app → mobile BFF               mobile (RTT 100 ms, 5 Mbps)           1      1      1.8 KB   109.2 ms   110.3 ms
```

সরাসরি পথে দুটো আলাদা সমস্যা, আর দুটোর নাম আছে:

**Request Waterfall** - এমন একটা ক্রম যেখানে পরের request টা আগেরটার উত্তর না আসা পর্যন্ত পাঠানো যায় না (কারণ উত্তরে পরের request এর তথ্য থাকে), তাই মোট সময় প্রায় ধাপের সংখ্যা × round trip।

এখানে ৪টা request কিন্তু ৩টা **ধাপ**: task না এলে জানা যায় না assignee কে; comment না এলে জানা যায় না author কারা। দ্বিতীয় ধাপের দুটো request একসাথে যায়, তবু তিনটা ধাপ। Mobile এ ৩ × ১০০ ms = ৩০০ ms শুধু অপেক্ষা - server এর কাজের চেয়ে একশো গুণ। আর মনে রাখবেন (Lesson 1.3): RTT আলোর গতি আর দূরত্বের ব্যাপার, bandwidth কিনে কমানো যায় না।

**Over-fetching** - client এর যা দরকার তার চেয়ে অনেক বেশি data নামানো, কারণ API টা অনেক caller এর জন্য বানানো আর পুরো object দেয়।

প্রতিটা service তার **পুরো** object দেয় - user এর notification setting আর bio, task এর checklist আর custom field - কারণ সে জানে না কার কী লাগে। Page এর দরকার এর অর্ধেকও না: browser এ ২৫ KB, যার ১০ KB কাজের। Mobile এর 5 Mbps এ ২৫ KB মানে ~৪০ ms শুধু byte - আর user এর data plan।

আর দুটো দাম যা exercise মাপে না, কিন্তু প্রায়ই বড়:

- **ভেতরের গঠন বাইরে ফাঁস।** Browser যদি জানে "comment আছে comments service এ", তাহলে কাল comments কে tasks এর সাথে জুড়ে দিলে বা আলাদা করলে browser এর code ও বদলাতে হয়। Web এ সেটা একটা deploy। কিন্তু **mobile app এর পুরনো version মাসের পর মাস চলে** - user update না করলে। তখন ভেতরের প্রতিটা বদল একটা বাইরের API এর বদল, versioning সহ (Lesson 2.5)।
- **প্রতিটা service এর নিজের দরজা** - নিজের TLS, নিজের CORS, নিজের token যাচাই। ঘটনা ২ ঠিক এটাই: পাঁচ জায়গায় একই নিরাপত্তার code মানে পাঁচ জায়গায় ভুলের সুযোগ।

### ১.৩ BFF - প্রতিটা frontend এর নিজের backend

**Backend for Frontend (BFF)** - একটা নির্দিষ্ট frontend (web, mobile app, একটা partner এর integration) এর জন্য বানানো একটা পাতলা server-side layer, যেটা সেই frontend এর একেকটা screen এর জন্য ভেতরের service গুলো ডাকে, data জোড়া দেয়, আর ঠিক সেই screen এর আকৃতিতে ফেরত দেয় - সাধারণত সেই frontend এর team এর মালিকানায়।

নামটা এসেছে SoundCloud এর অভিজ্ঞতা থেকে, Sam Newman এর 2015 এর লেখায়। Table এ ফিরে দেখুন:

- **ধাপ ৩ থেকে ১।** BFF একই তিন ধাপ চালায় - কিন্তু data center এর ভেতরে, যেখানে প্রতিটা ধাপ ~১ ms। Browser এর দিকে একটা round trip। Mobile এ ৩৪৯ থেকে ১২৪ ms। Experiment ১ এ ভেতরের প্রতিটা call ৫ ms করলেও BFF ১৩৭ ms - ভেতরের ধাপ বাইরের ধাপের চেয়ে সবসময় সস্তা।
- **Byte ২৫ থেকে ১০ KB** - BFF শুধু page এর দরকারি field পাঠায়।
- **Mobile এর নিজের BFF: ১.৮ KB।** ছোট পর্দা - বিবরণের প্রথম ২০০ অক্ষর, শেষ ৫টা comment। একই service, আলাদা আকৃতি। "একটা BFF সবার জন্য" হলে সেটা আবার সবার জন্য পুরো object দেওয়ার দিকে ফেরে - তাই "প্রতিটা frontend এর **নিজের**"।
- Web BFF এর page আর browser এর নিজের জোড়া দেওয়া page **হুবহু একই** - exercise যাচাই করে। কাজ একই, শুধু কোথায় হচ্ছে সেটা বদলেছে।

**TaskFlow এর web এর BFF আসলে আগে থেকেই আছে** - SvelteKit এর server route। `+page.server.ts` এর `load` function server এ চলে, browser এর একটা request এর উত্তরে:

```typescript
// src/routes/tasks/[id]/+page.server.ts - TaskFlow web's BFF
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { internal } from '$lib/server/internal'; // the client for internal services: base URL, internal token, timeout, Zod

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) error(401, 'login required');
	const id = z.coerce.number().int().positive().parse(params.id);
	const as = locals.user; // on whose behalf we call - goes on every internal call (1.5)

	const task = await internal.work.getTask(id, as); // step 1
	const comments = await internal.work.listComments(id, as); // step 2 - inside the data center, ~1 ms
	const people = await internal.identity.usersByIds(
		[task.assigneeId, ...comments.map((c) => c.authorId)],
		as
	); // step 3 - all at once (9.1's batched)
	const byId = new Map(people.map((u) => [u.id, { name: u.name, avatar: u.avatar }]));

	// whatever is returned is serialized and sent to the browser - so only what the page will show
	return {
		task: { id: task.id, title: task.title, description: task.description, status: task.status },
		assignee: byId.get(task.assigneeId) ?? null,
		comments: comments.map((c) => ({
			id: c.id,
			body: c.body,
			at: c.createdAt,
			author: byId.get(c.authorId) ?? null
		}))
	};
};
```

(উদাহরণ - `internal` client টা TaskFlow এর নিজের; exercise এ একই flow Express এর BFF এ চালানো আর মাপা। SvelteKit এ `load` থেকে একটা promise না-`await` করে ফেরত দিলে সেটা পরে stream হয় - comment গুলো দেরিতে এলে task আগে দেখানো যায়।)

দুটো সূক্ষ্মতা:

- `load` যা return করে, সব browser এ যায় - page এর HTML এর ভেতরে serialized। Service এর পুরো object return করলে over-fetching BFF এর ভেতর দিয়ে আবার browser এ পৌঁছায়, আর কখনো কখনো এমন field (email, internal flag) যেটা browser এ যাওয়াই উচিত না।
- BFF এ **ব্যবসার নিয়ম না** - "free plan এ কয়টা task", "কে task delete করতে পারে" থাকে service এ (work module)। BFF জোড়া দেয় আর আকৃতি দেয়। নইলে web আর mobile এর BFF এ একই নিয়ম দুবার লেখা, আর একদিন দুটো আলাদা হয়ে যায়।

**GraphQL কি এর বিকল্প?** (Lesson 2.3) - আংশিক। একটা GraphQL server client কে নিজের field বাছতে দেয় - over-fetching সারে, আর একটা query তে পুরো page - waterfall সারে। দাম: HTTP cache কঠিন (সব `POST /graphql`), server এ resolver এর N+1 (DataLoader এর মতো batching লাগে - 9.1 এর chatty call এর ভেতরের রূপ), আর যেকোনো client যেকোনো ভারী query পাঠাতে পারে (query এর জটিলতার সীমা লাগে)। অনেক কোম্পানি GraphQL কে BFF হিসেবেই চালায়। TaskFlow এর জন্য দুটো screen-ভিত্তিক BFF - web (SvelteKit) আর mobile - সরল।

### ১.৪ API Gateway - একটা দরজা

BFF screen এর আকৃতির সমস্যা সারে। কিন্তু ঘটনা ২ আর ৩ - প্রতিটা service এর নিজের token যাচাই, CORS, আর ভেতরের port বাইরে খোলা - এর উত্তর একটা দরজা।

**API Gateway** - সব বাইরের request এর একমাত্র প্রবেশপথ: একটা L7 reverse proxy (Lesson 3.1, 3.3) যেটা path বা header দেখে request কে ঠিক service এ পাঠায়, আর পথে সবার জন্য একই কাজ গুলো একবারে করে - TLS শেষ করা, token যাচাই, rate limit, request id, log।

```
                     ┌──────────────────── API gateway (L7) ────────────────────┐
  browser  ──TLS──►  │ TLS · token যাচাই · rate limit (9.5) · request id · CORS │
  mobile   ──TLS──►  │ route:  /           → web BFF (SvelteKit)                │
  partner  ──TLS──►  │         /m/*        → mobile BFF                          │
                     │         /api/files/* → files service (canary: 10%)        │
                     │         /api/*      → TaskFlow monolith                   │
                     └──────────────┬──────────────────────┬────────────────────┘
                                    │  ভেতরের network - বাইরে থেকে পৌঁছানো যায় না
                                    ▼                      ▼
                           [web BFF] [mobile BFF] → [monolith]  [files service]
```

Spaced repetition এর উত্তর: gateway L7 - path (`/api/files/*`) আর header (`Authorization`) দেখে; L4 শুধু IP আর port দেখে, তাই এই কাজ পারে না। বাস্তবে প্রায়ই দুটোই থাকে: সামনে একটা L4 load balancer, তার পেছনে কয়েকটা gateway instance।

**বাড়তি hop এর দাম।** Exercise এর `npm run gateway`, অংশ ক:

```
── a. Extra hop: tasks service directly vs through the gateway (token check + proxy) ──
   path                               1 client p50  16 clients: req/s        p50        p99   gateway CPU / request
   client → tasks (direct)                  0.2 ms              11982     1.2 ms     2.7 ms   -
   client → gateway → tasks                 0.4 ms               6312     2.4 ms     3.9 ms   0.2 ms
```

একজন user এর চোখে +০.২ ms - প্রায় কিছুই না। কিন্তু দেখুন ডান দিকে: প্রতিটা request এ gateway এর CPU ০.২ ms - একটা gateway process সরাসরির অর্ধেক request দিতে পারে। মানে gateway এর নিজের capacity plan লাগে (অনেক instance, horizontal - Lesson 1.6), আর সে **সবার** পথে: gateway বসে গেলে পুরো TaskFlow বসে যায়। তাই gateway stateless, অনেক instance, আর সরল রাখা হয়। (Exercise এর gateway একটা Express এর খেলনা - Envoy, NGINX, Kong এর মতো আসল gateway প্রতি request এ অনেক কম CPU নেয়। আকৃতিটা একই: একটা বাড়তি hop, সবার পথে।)

**Gateway দিয়ে routing - 9.1 এর strangler fig।** Thumbnail এর route টা পুরনো পথ (monolith) থেকে নতুন files service এ সরানো হচ্ছে - একবারে না, একটা ভাগ করে:

**Canary Routing** - একটা route এর traffic এর ছোট একটা অংশ (যেমন ১০%) নতুন version বা নতুন service এ পাঠানো, বাকিটা পুরনোতে; সমস্যা না হলে ধীরে ধীরে ভাগ বাড়ানো, সমস্যা হলে এক setting এ ফেরানো। ভাগ সাধারণত user (বা workspace) ধরে, যাতে একজনের অভিজ্ঞতা request ভেদে লাফায় না।

```
── c. The thumbnail route: old path (monolith) vs new files service - 1000 users, 2 times each ──
   canary %   to new service    old path     same side both times
         0%                0        1000                     100%
        10%              104         896                     100%
        50%              499         501                     100%
       100%             1000           0                     100%
```

User id এর hash ধরে ভাগ - ১০% মানে ১০৪ জন (hash এর স্বাভাবিক ওঠানামা), আর প্রত্যেকে দুবারই একই দিকে। Client কিছুই জানে না - URL একই, শুধু gateway এর একটা সংখ্যা বদলায়। (Deploy এর canary - একই service এর নতুন version - Lesson 10.6।)

**Gateway এ কী রাখবেন না।** Gateway সবার পথে, তাই লোভ হয় সেখানে সব রাখার: "free plan এর user দের preview লুকান", "এই response এ এই field জুড়ে দিন"। না। ব্যবসার নিয়ম gateway এ ঢুকলে gateway হয়ে যায় একটা দ্বিতীয় monolith - সবার change একটা team এর (platform) লাইনে, আর সবচেয়ে ঝুঁকির জায়গায়। ২০০০ এর দশকের "Enterprise Service Bus" এর ঠিক এই পরিণতি হয়েছিল - আর তার উত্তরেই microservices এর পরিচিত নীতি: "smart endpoints, dumb pipes" (Martin Fowler ও James Lewis, 2014) - বুদ্ধি service এ, পাইপ বোকা। নিয়ম: **সবার জন্য একই** কাজ (TLS, token যাচাই, rate limit, route, log) gateway এ; **একটা frontend এর** কাজ (জোড়া, আকৃতি) BFF এ; **ব্যবসার** নিয়ম service এ।

### ১.৫ "এটা কে পাঠাল?" - gateway এর পেছনে পরিচয়

**Edge Authentication** - user এর token (JWT বা session) সীমানায় - gateway এ - একবার যাচাই করা, আর তারপর ভেতরের service গুলোকে "এটা user 42 এর request" জানানো; ভেতরের service আর token যাচাই করে না, কিন্তু সেই খবরটা **কীভাবে** বিশ্বাস করবে, সেটা design এর অংশ।

ঘটনা ২ এর সমাধান প্রথম অর্ধেক: token যাচাই এক জায়গায় - gateway এ - তাই মেয়াদ দেখতে ভোলার জায়গা একটা। কিন্তু ঘটনা ৩: gateway যাচাই করে `x-user-id: 42` বসায়, আর service সেটা বিশ্বাস করে। কেউ gateway এড়িয়ে service এ পৌঁছালে? অংশ খ:

```
── b. Who sent it? - the gateway's check, and bypassing the gateway to the service directly ──
   request                                                    trust mode                       signed mode
   gateway, no token                                          401                              401
   gateway, valid token for user 42                           200 · user 42                    200 · user 42
   gateway, valid token + self-set x-user-id: 1               200 · user 42                    200 · user 42
   gateway, expired token                                     401                              401
   gateway, token made with another secret (sub: 1)           401                              401
   service directly (bypassing gateway), x-user-id: 1         200 · user 1 ← impersonated      401
   service directly, real x-internal-auth 70 s old (user 42)  -                                401
```

- **Gateway এর ভেতর দিয়ে সব ঠিক** - দুই mode এ। তৃতীয় সারিটা জরুরি: client নিজে `x-user-id: 1` পাঠাল, gateway সেটা **ফেলে দিয়ে** নিজে বসাল (৪২)। এটা না করলে gateway নিজেই ফাঁক।
- **Trust mode, gateway এড়িয়ে: user 1 হয়ে যাওয়া গেল।** Service শুধু একটা header বিশ্বাস করে - যে কেউ সেটা লিখতে পারে। ঘটনা ৩।
- **Signed mode:** gateway `x-internal-auth` এ user id আর সময় বসিয়ে নিজের secret দিয়ে sign করে (HMAC); service যাচাই করে। সরাসরি এলে sign নেই - 401। আর পুরনো একটা আসল header (৭০ s আগের - কোনো log থেকে চুরি হলো ধরুন) ও 401: sign এ সময় আছে, আর service ৬০ s এর বেশি পুরনো মানে না।

তাই স্তরে স্তরে:

1. **Network:** ভেতরের service গুলো বাইরে থেকে পৌঁছানো যায় না (private network, security group)। জরুরি - কিন্তু একা যথেষ্ট না, কারণ ঘটনা ৩ দেখায় একটা ভুল নিয়মই যথেষ্ট; আর ভেতরের একটা service এর bug (যেমন SSRF - user এর দেওয়া URL এ server নিজে request পাঠায়) ভেতর থেকেই দরজা খোলে।
2. **ভেতরের পরিচয় যাচাইযোগ্য:** gateway একটা ছোট মেয়াদের signed token বসায় (এখানকার HMAC header, বা বাস্তবে প্রায়ই একটা ছোট internal JWT), service যাচাই করে। Client এর পাঠানো পরিচয়ের header কখনো ভেতরে যায় না।
3. **Service থেকে service এর পরিচয়ও:** "এই request টা কি আসলেই BFF থেকে এলো, নাকি অন্য কেউ?" - এর জন্য প্রায়ই:

**Service Mesh (mTLS)** - প্রতিটা service এর পাশে একটা ছোট proxy (sidecar), যেগুলো মিলে service থেকে service এর সব traffic সামলায়: দুই দিকের certificate দিয়ে পরিচয় যাচাই আর encryption (mutual TLS - "কে ডাকছে" আর "কাকে ডাকছে" দুটোই প্রমাণিত), সাথে retry, timeout, আর metric - service এর code না বদলে (Istio, Linkerd)। দাম: প্রতিটা call এ আরেকটা proxy (latency, CPU), আর চালানোর অনেক জটিলতা - অনেক service না হলে সাধারণত লাভের চেয়ে বেশি।

4. **Authorization service এ।** Gateway জানে **কে** (user 42); কিন্তু user 42 এই workspace এর task পড়তে পারে কিনা - সেটা work module জানে, কারণ membership তার data। Gateway এ এটা রাখলে ১.৪ এর "gateway এ ব্যবসা" এর ভুল।

### ১.৬ TaskFlow এর সিদ্ধান্ত

- **একটা gateway, সব বাইরের traffic এর জন্য** - Module 3 এর Nginx এর জায়গায় একটা আসল API gateway (যেমন Envoy বা Kong ভিত্তিক; নিজে লেখা না), কয়েকটা instance, সামনে L4 load balancer। কাজ: TLS, JWT যাচাই (একবার, মেয়াদ সহ), rate limit (Lesson 9.5), request id (Lesson 10.4 এর tracing এর শুরু), একটা origin - তাই CORS এর ঝামেলা শেষ। Route: `/` → web BFF, `/m/*` → mobile BFF, `/api/files/*` → files service (canary ১০% → ৫০% → ১০০%, workspace ধরে), বাকি `/api/*` → monolith।
- **পরিচয়:** gateway client এর পরিচয়ের সব header ফেলে দেয়, আর বসায় একটা ৬০ s মেয়াদের signed internal token। প্রতিটা service যাচাই করে - shared middleware এ, একবার লেখা। ভেতরের service গুলো private network এ। Authorization প্রতিটা service এ। Service mesh এখন না - দুটো service এর জন্য খুব ভারী।
- **দুটো BFF:** web = SvelteKit এর server route (web team এর); mobile = একটা ছোট Node service (mobile team এর), mobile এর screen ধরে endpoint। দুটোতেই ব্যবসার নিয়ম নেই - জোড়া আর আকৃতি।
- **ভেতরের কথা:** যেখানে user অপেক্ষা করছে - REST, ভাগ করা Zod schema এর package (version সহ), timeout আর fallback (9.4); বাকি সব event (outbox → Redis Streams)। Files service এ ঢোকে `attachment.uploaded`, বেরোয় `attachment.processed`। gRPC এখন না - দুটো service, একটা ভাষা।
- **Browser কখনো ভেতরের service সরাসরি ডাকে না।** Mobile app ও না - তাই পুরনো app version গুলো ভেতরের বদল থেকে সুরক্ষিত; BFF এর endpoint এর version থাকে।

> **Trade-off Table - বাইরের client ভেতরে কীভাবে পৌঁছায়**

| উপায়                           | Round trip / byte                        | ভেতরের গঠন লুকানো?                | নিরাপত্তা (token, CORS)                    | কে মালিক, কী জটিলতা                                   | কখন                                                          |
| ------------------------------- | ---------------------------------------- | --------------------------------- | ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------ |
| Client → service সরাসরি         | ধাপ × RTT (mobile এ ৩৪৯ ms), পুরো object | না - service বদলালে client বদলায় | প্রতিটা service এ আলাদা - ভুলের সুযোগ      | কেউ না - সবচেয়ে সরল শুরুতে                           | একটা service; বা ভেতরের tool                                 |
| API gateway (শুধু)              | একই ধাপ, একই byte (+০.২ ms)              | আংশিক - path লুকায়, আকৃতি না     | এক জায়গায় - TLS, token, rate limit       | Platform team; স্থিতিশীল, সবার পথে - সরল রাখতে হয়    | প্রায় সবসময়, অনেক service হলে                              |
| Gateway + BFF (frontend প্রতি)  | ১ ধাপ, screen এর আকৃতি (১.৮–১০ KB)       | হ্যাঁ - BFF এর contract স্থির     | Gateway এ; BFF ও internal token নিয়ে ডাকে | Frontend team; প্রতিটা frontend এ একটা বাড়তি service | কয়েকটা frontend (web, mobile), ভিন্ন screen - **TaskFlow**  |
| GraphQL (gateway বা BFF হিসেবে) | ১ ধাপ, client যা চায়                    | হ্যাঁ - schema স্থির              | Gateway এ; query এর জটিলতার সীমা লাগে      | Schema এর মালিক; resolver এর N+1, cache কঠিন          | অনেক ভিন্ন client, দ্রুত বদলানো UI, schema এর জন্য একটা team |

---

## ২. Interview Angle

**প্রায় প্রতিটা design প্রশ্নে** (Uber, Instagram, e-commerce) client আর service এর মাঝে একটা বাক্স আঁকা হয় - "API gateway"। দুর্বল উত্তর শুধু নামটা বলে। ভালো উত্তর বলে gateway **কী করে** (TLS, auth, rate limit, routing) আর **কী করে না** (ব্যবসার নিয়ম); mobile থাকলে BFF আর কেন (round trip - একটা সংখ্যা: "mobile এ ৩ ধাপ × ১০০ ms"); আর কোন ভেতরের কথা synchronous, কোনটা event। Follow-up প্রায়ই: "gateway কি single point of failure?" - হ্যাঁ, তাই stateless, অনেক instance, L4 load balancer এর পেছনে, আর সরল।

**"Gateway এ token যাচাই করলে service গুলো কীভাবে জানে user কে?"** - এখানে senior আর junior এর পার্থক্য: header বিশ্বাস করা যথেষ্ট না (gateway এড়িয়ে আসা, SSRF); gateway client এর header ফেলে দেয়, একটা signed ছোট মেয়াদের internal token বসায়, service যাচাই করে; network isolation তার উপরে একটা স্তর; আর authorization service এ থাকে।

**"BFF আর API gateway এর পার্থক্য?"** - Gateway সবার জন্য একটা, সবার জন্য একই কাজ, platform team এর; BFF প্রতিটা frontend এর একটা, screen এর জোড়া আর আকৃতি, frontend team এর। বোনাস: GraphQL কখন এর বিকল্প।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনা: gateway এ ব্যবসার নিয়ম জমতে জমতে কেউ বুঝতে পারে না কোন নিয়ম কোথায়; gateway এর timeout ভেতরের service এর timeout এর চেয়ে ছোট (gateway আগে ছেড়ে দেয়, service তবু কাজ করে - Lesson 9.4); ভেতরের service বাইরে খোলা আর header এ পরিচয় (ঘটনা ৩); আর mobile app এর পুরনো version যেটা একটা মোছা endpoint ডাকে - তাই BFF এর endpoint এর version আর "কোন version এখনো চলছে" এর metric।

---

## ৩. Key Takeaway

- দুটো service এর কথা: **user এখন অপেক্ষা করছে?** - তাহলে request/response (timeout আর fallback সহ); নইলে event। ভেতরে REST + ভাগ করা Zod schema অল্প service এ যথেষ্ট; gRPC typed contract আর দক্ষতা দেয়, জটিলতার দামে
- Browser সরাসরি service ডাকলে: **request waterfall** (৪টা request, ৩টা ধাপ - mobile এ ৩৪৯ ms), **over-fetching** (২৫ KB, দরকার ১০ KB), ভেতরের গঠন ফাঁস (পুরনো mobile app), আর প্রতিটা service এ আলাদা নিরাপত্তা
- **BFF**: একটা frontend এর জন্য জোড়া আর আকৃতি, data center এর ভেতরে - ১ ধাপ, mobile এ ১২৪ ms (mobile BFF ১০৯ ms, ১.৮ KB)। SvelteKit এর `+page.server.ts` টাই web এর BFF; `load` যা return করে সব browser এ যায়। ব্যবসার নিয়ম BFF এ না
- **API gateway**: সব বাইরের traffic এর এক দরজা, L7 - TLS, token যাচাই, rate limit, route, log। একা +০.২ ms, কিন্তু request প্রতি CPU - gateway নিজে scale করতে হয়, সবার পথে। ব্যবসার নিয়ম gateway এ না ("smart endpoints, dumb pipes")
- **Canary routing** gateway এ: user বা workspace এর hash ধরে ভাগ - ১০% মানে ~১০%, একজন সবসময় একই দিকে; strangler fig এর হাতিয়ার
- **Edge authentication** এর পরে পরিচয় পথে: client এর header ফেলে দেওয়া, signed ছোট মেয়াদের internal token (সরাসরি এলে 401, পুরনো হলে 401), network isolation, আর authorization service এ; অনেক service হলে **service mesh** এর mTLS

---

## ৪. নতুন Term (Glossary)

| Term                           | অর্থ                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Request Waterfall**          | পরের request আগেরটার উত্তরের উপর নির্ভর করে, তাই একটার পর একটা - মোট সময় ≈ ধাপের সংখ্যা × round trip                                                   |
| **Over-fetching**              | Client এর দরকারের চেয়ে বেশি data নামানো - কারণ API অনেক caller এর জন্য পুরো object দেয়                                                                |
| **Backend for Frontend (BFF)** | একটা নির্দিষ্ট frontend এর জন্য পাতলা server-side layer - ভেতরের service ডেকে screen এর আকৃতিতে data জোড়া দেয়; frontend team এর                       |
| **API Gateway**                | সব বাইরের request এর একমাত্র প্রবেশপথ - L7 reverse proxy যেটা route করে আর সবার জন্য একই কাজ (TLS, token যাচাই, rate limit, log) একবারে করে             |
| **Canary Routing**             | একটা route এর traffic এর ছোট ভাগ (user/workspace ধরে) নতুন service বা version এ, বাকিটা পুরনোতে; ধীরে ধীরে বাড়ানো, এক setting এ ফেরানো                 |
| **Edge Authentication**        | User এর token সীমানায় (gateway এ) একবার যাচাই করা, তারপর ভেতরে যাচাইযোগ্য (signed) উপায়ে "কে" জানানো - client এর পাঠানো পরিচয়ের header কখনো ভেতরে না |
| **Service Mesh (mTLS)**        | প্রতিটা service এর পাশে proxy (sidecar) যেগুলো service থেকে service এর traffic সামলায় - দুই দিকের certificate এ পরিচয় আর encryption, retry, metric    |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন - প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর mobile app এর version 1.2 সরাসরি `comments` এর endpoint ডাকে (BFF আসার আগের)। ৩০% user তিন মাস ধরে update করেনি। এখন work team comments এর response এর আকৃতি বদলাতে চায় (`author` একটা nested object হবে, `authorId` না)। (ক) BFF না থাকলে কী কী উপায়, আর প্রতিটার দাম? (খ) Mobile BFF থাকলে একই বদলের পথ কী? (গ) BFF এর নিজের endpoint এর version কেন তবু লাগে?
2. Platform team বলছে: "Gateway সব request দেখে - তাই 'free plan এর workspace এ attachment এর preview লুকান' এর নিয়মটা gateway এ বসাই, এক জায়গায়।" তিনটা যুক্তি দিন কেন এটা ভুল জায়গা। নিয়মটা কোথায় যাবে? আর gateway এ কোন ধরনের নিয়ম ঠিক আছে - একটা উদাহরণ যেটা শুনতে ব্যবসার মতো কিন্তু আসলে gateway এর কাজ।
3. একটা request এর পুরো পথ: browser → gateway → web BFF (SvelteKit) → work module (monolith) → outbox event → notifications worker (email পাঠায়)। প্রতিটা ধাপে "কে" (user 42) কীভাবে যায় আর কে যাচাই করে? Worker টা event পায় কয়েক সেকেন্ড পরে - internal token এর ৬০ s মেয়াদ তখন কি সমস্যা? Event এ user এর JWT টাই রেখে দিলে কী ভুল?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) BFF ছাড়া - পুরনো app সরাসরি comments এর endpoint এর মালিক। উপায়:

- **পুরনো আকৃতি রাখা, নতুনটা পাশে** - `/v1/comments` (পুরনো, `authorId`) আর `/v2/comments` (নতুন) একসাথে চালানো (Lesson 2.5), যতদিন না পুরনো app এর ব্যবহার প্রায় শূন্য। দাম: work team দুটো আকৃতি চালায় - মাসের পর মাস, আর প্রতিটা ভবিষ্যৎ বদলে আরও একটা।
- **Force update** - পুরনো app কে "update করুন" দেখানো। দাম: user বিরক্ত, কিছু user চলে যায়; আর app store এর review এর দেরি।
- **বদল না করা** - প্রায়ই যা হয়। দাম: ভেতরের design এর উন্নতি আটকে থাকে বাইরের একটা পুরনো client এর জন্য।

(খ) Mobile BFF থাকলে: app ডাকে BFF এর `/m/tasks/:id`, যেটা mobile screen এর আকৃতি দেয় - comments এর ভেতরের আকৃতি app কখনো দেখে না। Work team comments বদলায়; mobile BFF এর ভেতরের code নতুন আকৃতি থেকে সেই একই screen এর আকৃতি বানায় - একটা deploy, mobile team এর, app এর কোনো বদল না। ভেতরের বদল ভেতরেই থাকে।

(গ) কারণ BFF এর contract টাই এখন বাইরের API - পুরনো app গুলো তার পুরনো আকৃতি ডাকে। Mobile screen নিজে বদলালে (নতুন field, অন্য layout) BFF এর endpoint ও বদলায়, আর পুরনো app এর জন্য পুরনোটা রাখতে হয়: `/m/v3/tasks/:id`। পার্থক্য: এই version গুলো mobile team এর নিজের - একটা team, একটা client - ভেতরের প্রতিটা service এর আলাদা version এর জঙ্গল না। আর একটা metric: কোন app version থেকে কোন endpoint কতবার ডাকা হচ্ছে - পুরনোটা কবে মোছা যায় সেটা সংখ্যা বলে।

**প্রশ্ন ২:** তিনটা যুক্তি:

- **নিয়মটা ডেটা চায় যা gateway এর না।** "Free plan" billing এর data; "preview" একটা files/work এর ধারণা। Gateway কে এটা জানতে হলে তার billing কে ডাকতে হয় (প্রতি request এ আরেকটা hop, আর billing বসলে gateway বসে) বা একটা কপি রাখতে হয় (sync)। সবার পথের জায়গায় একটা নতুন নির্ভরতা।
- **সবার পথে ব্যবসার ঝুঁকি।** Gateway এর একটা bug পুরো TaskFlow কে বসায়। ব্যবসার নিয়ম প্রায়ই বদলায় - প্রতিটা বদল সবচেয়ে ঝুঁকির জায়গায় deploy, platform team এর লাইনে (ESB এর গল্প)।
- **নিয়ম দুই জায়গায় ছড়ায়।** Mobile app এর offline sync, একটা export job, একটা partner API - যেগুলো gateway এর এই route এর ভেতর দিয়ে যায় না - সেখানে নিয়মটা কাজ করে না, বা আবার লেখা হয়। একই নিয়মের দুটো কপি একদিন আলাদা হয়।

কোথায়: files/work service এ - preview এর data যে দেয়, সেই ঠিক করে কাকে দেবে (billing থেকে plan এর তথ্য event এ তার নিজের কপিতে - 7.5)। BFF শুধু যা পায় দেখায়।

Gateway এ ঠিক আছে এমন "ব্যবসার মতো শোনা" নিয়ম: **plan অনুযায়ী rate limit** - "free plan এ মিনিটে ৬০টা API call, pro তে ৬০০"। শুনতে ব্যবসার, কিন্তু এটা সবার জন্য একই ধরনের কাজ (গোনা আর থামানো), request এর content বোঝা লাগে না, আর plan টা token এর claim এ থাকতে পারে (token বানানোর সময় বসানো) - তাই gateway কাউকে ডাকে না। (Lesson 9.5।)

**প্রশ্ন ৩:** ধাপে ধাপে:

1. **Browser → gateway:** user এর JWT (বা session cookie)। Gateway যাচাই করে - signature, মেয়াদ। Client এর পাঠানো `x-user-id`, `x-internal-auth` ফেলে দেয়।
2. **Gateway → web BFF:** signed internal token (user 42, এখনকার সময়, ৬০ s)। BFF যাচাই করে (shared middleware) - `locals.user` বসায়।
3. **BFF → work module:** BFF একই internal token এগিয়ে দেয় (বা নিজের একটা নতুন বানায়, যদি BFF এর নিজের signing এর অনুমতি থাকে)। Work module যাচাই করে, তারপর **authorization**: user 42 কি এই workspace এর member?
4. **Work module → outbox event:** event এ থাকে `actorId: 42` - একটা সাধারণ data field, token না। Event টা trust করা হয় কারণ সেটা এসেছে আমাদের নিজের outbox থেকে, stream এ যেখানে শুধু আমাদের service লিখতে পারে (stream এর নিজের access control)।
5. **Notifications worker:** event পড়ে, `actorId` দেখে ("Karim আপনাকে একটা task দিয়েছে")। Token যাচাইয়ের কিছু নেই - worker user এর **হয়ে** কিছু করছে না; সে system এর হয়ে কাজ করছে, একটা ঘটে যাওয়া ঘটনার ভিত্তিতে।

৬০ s এর মেয়াদ: worker এর জন্য সমস্যা না, কারণ worker token ব্যবহার করে না। কিন্তু যদি worker কে user 42 এর হয়ে অন্য service ডাকতে হতো (ধরুন user এর private data আনতে), তখন: হয় worker এর নিজের service identity (mTLS বা service token) আর service টা "system এর হয়ে, user 42 এর ঘটনার জন্য" বিশ্বাস করে, নয়তো সেই মুহূর্তে একটা নতুন ছোট token - পুরনোটা বাঁচিয়ে রাখা না।

Event এ user এর JWT রাখলে ভুল: (ক) token টা একটা bearer অনুমতি (8.2 এর presigned URL এর মতো) - stream এ, log এ, DLQ তে (7.4) দিনের পর দিন পড়ে থাকে, যে পড়তে পারে সে user 42 হতে পারে; (খ) event এর replay (7.2) হয় কয়েক ঘণ্টা বা দিন পরে - token এর মেয়াদ ততক্ষণে শেষ, তাই হয় কাজ ব্যর্থ, নয়তো কেউ মেয়াদ লম্বা করে (আরও খারাপ); (গ) user logout বা ban হলেও token টা event এ থেকে যায়। Event এ **কী ঘটেছে আর কে ঘটিয়েছে** - অনুমতি না।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (আলাদা Node process গুলো আলাদা service; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-9.2-gateway-bff/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.2-gateway-bff) - `npm install`, তারপর `npm run bff` আর `npm run gateway`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`bff` একটা "task detail" page তিনভাবে খোলে - browser নিজে তিনটা service ডেকে, web BFF দিয়ে, আর mobile BFF দিয়ে - desktop আর mobile এর network এর model এ, আর মাপে request, ধাপ, byte আর সময়; web BFF এর page আর browser এর নিজের জোড়া দেওয়া page হুবহু একই কিনা যাচাই করে। `gateway` একটা খেলনা gateway চালায়: বাড়তি hop এর দাম, token যাচাই আর gateway এড়িয়ে সরাসরি service এ পৌঁছানো (trust আর signed দুই mode এ), আর user ধরে canary routing।

**সৎ নোট:** Sandbox এ Node 26 দিয়ে চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` আর ESLint clean; `bff` তিনবার - request, ধাপ আর byte হুবহু একই, সময় ১–২% এর মধ্যে; `gateway` চারবার - অংশ খ আর গ হুবহু একই, অংশ ক এর req/s কয়েক শতাংশ ওঠানামা করে। README এর experiment ১ আর ৪ চালানো হয়েছে, সংখ্যা README তে; ২, ৩, ৫ code বদলানোর কাজ - আপনার। Browser এর network একটা model - RTT আর ভাগ করা bandwidth; TCP slow start, TLS, packet loss নেই; দুটো profile বাছাই করা, মাপা না। Exercise এর HTTP client `node:http` - Node 26 এর built-in `fetch` এ এই machine এ অল্প বিরতির পরে ~৫০০ ms এর একটা অদ্ভুত দেরি পাওয়া গেছে (localhost এও), কারণটা খোঁজা হয়নি, শুধু মেপে এড়ানো হয়েছে। Gateway একটা Express এর খেলনা - আসল gateway এর CPU এর সংখ্যা আলাদা হবে। JWT HS256, secret code এ নির্দিষ্ট - শুধু exercise এর জন্য। ১.৩ এর SvelteKit এর code আর ১.৬ এর gateway এর পছন্দ একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে হিসাব:** `bff` চালানোর **আগে** প্রতিটা সারির p50 হিসাব করুন - ধাপ × RTT + byte ÷ bandwidth + ভেতরের কাজ (ধরুন কয়েক ms)। তারপর চালিয়ে মেলান। কোন সারিতে আপনার হিসাব সবচেয়ে বেশি মিলল, কোনটায় কম - কেন?

2. **Waterfall লম্বা হলে:** experiment ২ - `directPage` এ ধাপ ২ কে একটা একটা করে। Mobile এ কত ms হলো? তারপর ভাবুন: BFF এর ভেতরে একই ভুল করলে ক্ষতি কত (NET_MS=1)? এই সংখ্যা দিয়ে বলুন, একটা BFF এর code review এ কোন ভুল সবচেয়ে কম ক্ষতির আর browser এর code এ কোনটা সবচেয়ে বেশি।

3. **পরিচয়ের ফাঁক:** `gateway` এর অংশ খ এর সাতটা সারির প্রতিটার জন্য এক লাইনে লিখুন - বাস্তবে কোন ঘটনায় এটা ঘটে (যেমন "মেয়াদ পেরোনো token: user এর tab সারারাত খোলা ছিল")। তারপর `service.ts` এর gateway থেকে "client এর x-user-id ফেলে দেওয়া" অংশটা সরিয়ে দেখুন (header গুলো client থেকে এগিয়ে দিন) - কোন সারি ভাঙে?

4. **Canary এর একক:** experiment ৪ (`USERS=100`) চালান। TaskFlow এ একটা workspace এর ১০ জন user - user ধরে ১০% canary মানে একই team এর একজন নতুন thumbnail দেখে, বাকিরা পুরনো। Workspace ধরে ভাগ করলে কী ভালো হয়, আর কী খারাপ (একটা বড় workspace এ bug)? `gateway` এর `bucket` কে workspace ধরে বদলানোর জন্য gateway কে কী জানতে হবে, আর সেটা সে কোথা থেকে পাবে?

5. **Design অংশ:** TaskFlow এর বাইরের দরজার এক পাতার design: (ক) gateway এর route এর তালিকা, প্রতিটা কোথায় যায়, কোনটায় canary; (খ) gateway এর কাজের তালিকা আর "কী কখনো gateway এ যাবে না" এর তিনটা উদাহরণ; (গ) পরিচয়ের পথ - কোন header, কে বসায়, কে যাচাই করে, মেয়াদ কত, আর event এ কী যায়; (ঘ) mobile BFF এর তিনটা endpoint (screen ধরে) আর তাদের version এর নিয়ম; (ঙ) কোন metric দেখে বলবেন gateway সুস্থ (latency এর যোগ, error, instance এর CPU)।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8 (সম্পূর্ণ, exit challenge সহ), 9.1
Current: 9.2 - Service communication, API Gateway, BFF pattern
TaskFlow state: modular monolith (work, identity, billing, files, search) + files processing service;
সামনে API gateway (Envoy/Kong ভিত্তিক, কয়েকটা instance, L4 LB এর পেছনে): TLS, JWT যাচাই একবার,
rate limit, request id, এক origin; route: / → web BFF (SvelteKit server route), /m/* → mobile BFF
(mobile team), /api/files/* → files service (workspace ধরে canary), /api/* → monolith; gateway client
এর পরিচয়ের header ফেলে দিয়ে ৬০ s এর signed internal token বসায়, প্রতিটা service যাচাই করে, ভেতরের
service private network এ, authorization service এ; ভেতরে: user অপেক্ষা করছে → REST + ভাগ করা Zod
schema, বাকি সব event (outbox → Redis Streams); service mesh আর gRPC এখন না
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall,
Over-fetching, Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication,
Service Mesh (mTLS)
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 9.3 - Distributed transactions: Saga pattern, 2PC
=======================
```

---

## ৮. পরের Lesson

Exercise চালিয়ে পাঠান - বিশেষ করে ১ নম্বরের হিসাব আর ৫ নম্বরের design। রেডি হলে `next` লিখুন - Lesson 9.3 এ যাব: **Distributed transactions - Saga pattern আর 2PC।** Lesson 9.1 এ দেখেছি একটা transaction দুটো database এ ভাগ হলে কী হয়: ৮৩টা অমিল, আর "আবার চেষ্টা" এ duplicate। TaskFlow এর billing কে কখনো আলাদা করতে হলে "task তৈরি + usage বাড়ানো + সীমা পেরোলে থামানো" একসাথে ঠিক রাখতে হবে - কোনো ভাগ করা `BEGIN … COMMIT` ছাড়া। দুটো পুরনো উত্তর: two-phase commit (সবাই একসাথে "হ্যাঁ" বলে তবেই commit - আর coordinator মরলে কী হয়), আর saga (ধাপে ধাপে, প্রতিটা ধাপের একটা উল্টো কাজ - আর মাঝপথে অন্যরা কী দেখে)। দুটোই মেপে দেখব।
