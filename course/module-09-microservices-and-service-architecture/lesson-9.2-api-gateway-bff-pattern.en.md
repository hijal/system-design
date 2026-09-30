# Lesson 9.2 — Service Communication, API Gateway, BFF Pattern

**Module 9 — Microservices & Service Architecture**

> **Spaced Repetition (Lesson 3.1):** What is the difference between an L4 and an L7 load balancer — which one can decide where a request goes by looking at the URL path or a header, and which only sees IP and port? By the end of today you will be able to say in one line which of the two an API gateway is.

**Prerequisite:** Lesson 1.3 (Latency numbers), Lesson 2.3 (REST vs GraphQL vs gRPC), Lesson 2.5 (API versioning), Lesson 3.1 (L4 vs L7), Lesson 3.3 (Reverse proxy), Lesson 7.1 (Temporal coupling), Lesson 7.5 (Events), Lesson 9.1 (Strangler fig, database per service)

**By the end of this lesson you will be able to:**

1. Decide, with a rule, which conversation between two services should be synchronous (request/response) and which should be an event — and choose the protocol for internal calls (REST vs gRPC)
2. Say why a browser or mobile app should not call internal services directly — with measured numbers for round-trip steps and bytes; and design a **BFF** (including TaskFlow's SvelteKit server routes)
3. Say what an **API gateway** is responsible for and what it is not — in particular where a token (identity) is verified and how that identity travels safely behind the gateway; plus canary routing with a gateway

**Tier:** 1 — Runnable Code (separate Node processes as separate services, a model of the browser's network, a toy gateway; no Docker needed)

---

## 0. Where TaskFlow Is Right Now

Lesson 9.1's decision: TaskFlow is a modular monolith, with only files processing as a separate service. Work started. In the same month TaskFlow's iOS/Android app shipped too. Three things happened in three weeks:

1. **The mobile app is slow.** Opening a task sends four requests — task, assignee, comments, comment authors. On 4G in Dhaka, opening one task takes nearly half a second, and the app store reviews say: "a loading spinner for every task". Monitoring shows server p99 under 20 ms — the server is not at fault.
2. **The files service's own login.** The files team wrote their own JWT verification for their new service — and forgot to check the expiry (`exp`). Thumbnails kept coming back for three days using a logged-out user's old token. And the browser now talks to two domains — CORS configuration in two places.
3. **A security review.** A pentester showed: a misconfigured load balancer rule made the tasks service's internal port reachable from outside. And the tasks service reads the `x-user-id` header to know whose request it is — so anyone could write someone else's id in the header and read their tasks.

Behind all three incidents is one question: **how** do the services talk to each other and to the outside world — who calls whom, through which door, and how does the answer to "who sent this?" travel along the path.

---

## 1. Theory

### 1.1 How two services talk — a call, or news

Two services have two fundamental ways of talking, and we have seen both before:

- **Request/response (synchronous):** "give me this now" — HTTP or gRPC, waiting for the answer. Lesson 9.1's board: the tasks service calls users, and the board is stuck until the answer arrives.
- **Event/message (asynchronous):** "this happened" — outbox → stream (Lesson 7.5), whoever needs it listens, nobody waits.

Which one, when? One simple question: **is a user waiting for this answer right now?**

| Situation                                                          | Kind             | Why                                                                                                      |
| ------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------- |
| Showing the assignee's name when a task opens                      | Request/response | The user sees it now; the page cannot be built without the answer                                        |
| Sending an email when a task is assigned                           | Event            | The user is not waiting for the email; assignment should work even if notifications is down (7.1)        |
| Making a thumbnail after an upload (9.1's files service)           | Event            | Seconds of work; the upload's response cannot be held for it                                             |
| Checking the plan limit before creating a task                     | Request/response | Whether it gets created depends on the answer — but should this even live in another service? (9.1, 9.3) |
| Keeping a copy of another service's data locally (search, reports) | Event            | Lesson 7.5's event-carried state, 8.3's search index                                                     |

Request/response costs you Lesson 7.1's **temporal coupling**: the two services have to be alive at the same moment. So events wherever possible; requests where a user is waiting — and then timeouts and fallbacks (9.1's 1.3, and 9.4).

**Protocol — REST or gRPC?** (Lesson 2.3) For the outside world (browsers, other companies) REST/JSON almost always. Between internal services gRPC has a case: binary (Protocol Buffers — smaller than JSON and faster to parse), many calls over one HTTP/2 connection, streaming, and the biggest one — generating typed clients for both sides from a `.proto` file, so a broken contract is caught at compile time. The cost: another toolchain, it does not run directly in browsers (you need grpc-web), and debugging with `curl` is harder. With a handful of services and TypeScript everywhere, REST plus a shared **Zod schema package** (both sides parse with the same schema, versioned) gives nearly the same safety with less complexity.

### 1.2 When the browser calls the services directly

In the monolith the browser knew one server. Now there are many services — should the browser call each one separately? Let's measure incident 1's page.

From the exercise, `npm run bff`: TaskFlow's "task detail" page — the task, the assignee, 20 comments and their authors. The browser's network is modelled: one round trip per request, and the response bytes through a shared pipe — desktop (RTT 20 ms, 50 Mbps) and mobile (RTT 100 ms, 5 Mbps). The server work is real:

```
── "Task detail" page: task + assignee + 20 comments + authors · 1 ms per call inside the data centre · 40 runs ──
   path                           browser network                    requests   steps   arrived at browser        p50        p95
   browser → services, direct     desktop (RTT 20 ms, 50 Mbps)              4       3             25.2 KB    71.5 ms    74.1 ms
   browser → web BFF              desktop (RTT 20 ms, 50 Mbps)              1       1             10.2 KB    28.9 ms    30.3 ms
   browser → services, direct     mobile (RTT 100 ms, 5 Mbps)               4       3             25.2 KB   348.7 ms   350.9 ms
   browser → web BFF              mobile (RTT 100 ms, 5 Mbps)               1       1             10.2 KB   123.6 ms   125.0 ms
   app → mobile BFF               mobile (RTT 100 ms, 5 Mbps)               1       1              1.8 KB   109.2 ms   110.3 ms
```

The direct path has two distinct problems, and both have names:

**Request Waterfall** — a sequence where the next request cannot be sent until the previous one's answer arrives (because the answer contains what the next request needs), so the total time is roughly the number of steps × the round trip.

Here there are 4 requests but 3 **steps**: without the task you do not know who the assignee is; without the comments you do not know who the authors are. The second step's two requests go together, and it is still three steps. On mobile that is 3 × 100 ms = 300 ms of pure waiting — a hundred times the server's work. And remember (Lesson 1.3): RTT is a matter of the speed of light and distance; you cannot buy it down with bandwidth.

**Over-fetching** — downloading far more than the client needs, because the API was built for many callers and returns whole objects.

Each service returns its **whole** object — a user's notification settings and bio, a task's checklist and custom fields — because it does not know who needs what. The page needs less than half of it: 25 KB at the browser, of which 10 KB is useful. On mobile's 5 Mbps, 25 KB is ~40 ms of pure bytes — and the user's data plan.

And two costs the exercise does not measure but which are often larger:

- **The internal structure leaks outward.** If the browser knows "comments live in the comments service", then merging comments into tasks tomorrow, or splitting them apart, means changing browser code too. On the web that is one deploy. But **old versions of a mobile app run for months** — as long as users do not update. Then every internal change becomes an external API change, with versioning (Lesson 2.5).
- **Every service needs its own door** — its own TLS, its own CORS, its own token verification. Incident 2 is exactly this: the same security code in five places means five places to get it wrong.

### 1.3 BFF — each frontend's own backend

**Backend for Frontend (BFF)** — a thin server-side layer built for one specific frontend (web, a mobile app, a partner's integration) which, for each of that frontend's screens, calls the internal services, stitches the data together, and returns it in exactly that screen's shape — usually owned by that frontend's team.

The name comes from SoundCloud's experience, via Sam Newman's 2015 writing. Look back at the table:

- **Three steps down to one.** The BFF runs the same three steps — but inside the data centre, where each step is ~1 ms. One round trip towards the browser. On mobile, 349 ms down to 124 ms. Even with each internal call at 5 ms (experiment 1) the BFF is 137 ms — internal steps are always cheaper than external ones.
- **Bytes from 25 KB to 10 KB** — the BFF sends only the fields the page needs.
- **Mobile's own BFF: 1.8 KB.** A small screen — the first 200 characters of the description, the last 5 comments. The same services, a different shape. "One BFF for everyone" drifts back towards returning whole objects for everyone — hence "each frontend's **own**".
- The web BFF's page and the browser's own stitched-together page are **byte-for-byte identical** — the exercise verifies it. The same work, only the place it happens changed.

**TaskFlow's web BFF already exists** — the SvelteKit server route. `+page.server.ts`'s `load` function runs on the server in response to one browser request:

```typescript
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { internal } from '$lib/server/internal';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) error(401, 'login required');
	const id = z.coerce.number().int().positive().parse(params.id);
	const as = locals.user;

	const task = await internal.work.getTask(id, as);
	const comments = await internal.work.listComments(id, as);
	const people = await internal.identity.usersByIds(
		[task.assigneeId, ...comments.map((c) => c.authorId)],
		as
	);
	const byId = new Map(people.map((u) => [u.id, { name: u.name, avatar: u.avatar }]));

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

The `internal` client is TaskFlow's own (base URL, internal token, timeout, Zod). `as` carries who we are calling on behalf of into every internal call (1.5). The three `await`s are the same three steps — but inside the data centre at ~1 ms each, and the third one batches every id into one call (9.1's batched). What `load` returns is serialised to the browser, so it holds only what the page will display. (An example — the exercise runs and measures the same flow in an Express BFF. In SvelteKit, returning a promise from `load` without awaiting it streams it later, so the task can render before slow comments arrive.)

Two subtleties:

- Everything `load` returns goes to the browser — serialised inside the page's HTML. Returning a service's whole object carries over-fetching straight through the BFF to the browser, and sometimes fields (email, internal flags) that should never go there at all.
- **No business rules in the BFF** — "how many tasks on the free plan", "who can delete a task" live in the service (the work module). The BFF stitches and shapes. Otherwise the same rule is written twice, in the web and mobile BFFs, and one day the two drift apart.

**Is GraphQL an alternative?** (Lesson 2.3) — partly. A GraphQL server lets the client pick its own fields — fixing over-fetching — and get a whole page in one query, fixing the waterfall. The costs: HTTP caching is hard (everything is `POST /graphql`), resolvers have an N+1 problem on the server (you need batching like DataLoader — the internal form of 9.1's chatty calls), and any client can send an arbitrarily heavy query (you need query-complexity limits). Many companies run GraphQL as their BFF. For TaskFlow, two screen-shaped BFFs — web (SvelteKit) and mobile — are simpler.

### 1.4 API Gateway — one door

A BFF fixes the screen-shape problem. But incidents 2 and 3 — every service's own token verification and CORS, and an internal port open to the world — are answered by a door.

**API Gateway** — the single entry point for all external requests: an L7 reverse proxy (Lessons 3.1, 3.3) that routes a request to the right service by path or header, and along the way does the work that is the same for everyone, once — terminating TLS, verifying tokens, rate limiting, request ids, logging.

```
                     ┌──────────────────── API gateway (L7) ────────────────────┐
  browser  ──TLS──►  │ TLS · verify token · rate limit (9.5) · request id · CORS │
  mobile   ──TLS──►  │ route:  /           → web BFF (SvelteKit)                │
  partner  ──TLS──►  │         /m/*        → mobile BFF                          │
                     │         /api/files/* → files service (canary: 10%)        │
                     │         /api/*      → TaskFlow monolith                    │
                     └──────────────┬──────────────────────┬────────────────────┘
                                    │  internal network — unreachable from outside
                                    ▼                      ▼
                           [web BFF] [mobile BFF] → [monolith]  [files service]
```

The spaced repetition's answer: a gateway is L7 — it looks at paths (`/api/files/*`) and headers (`Authorization`); L4 only sees IP and port and therefore cannot do this. In practice you usually have both: an L4 load balancer in front, with several gateway instances behind it.

**The cost of the extra hop.** From the exercise, `npm run gateway`, part A:

```
── A. The extra hop: the tasks service directly vs through the gateway (token verification + proxy) ──
   path                               1 user alone p50   busy (16): req/s        p50        p99   gateway CPU / request
   client → tasks (direct)                      0.2 ms              11982     1.2 ms     2.7 ms   —
   client → gateway → tasks                     0.4 ms               6312     2.4 ms     3.9 ms   0.2 ms
```

To one user it is +0.2 ms — practically nothing. But look at the right-hand column: 0.2 ms of gateway CPU per request — one gateway process can serve half as many requests as going direct. Which means the gateway needs a capacity plan of its own (many instances, horizontally — Lesson 1.6), and it is on **everyone's** path: if the gateway goes down, all of TaskFlow goes down. So gateways are kept stateless, numerous, and simple. (The exercise's gateway is an Express toy — real gateways like Envoy, NGINX or Kong use far less CPU per request. The shape is the same: one extra hop, on everyone's path.)

**Routing with a gateway — 9.1's strangler fig.** The thumbnail route is being moved from the old path (the monolith) to the new files service — not all at once, a fraction at a time:

**Canary Routing** — sending a small share of a route's traffic (say 10%) to a new version or a new service and the rest to the old one; increasing the share gradually if nothing goes wrong, and reverting with one setting if it does. The split is usually by user (or workspace), so one person's experience does not jump between requests.

```
── C. The thumbnail route: the old path (monolith) vs the new files service — 1000 users, twice each ──
   canary %   to the new service   to the old path   same user, both times the same way
         0%                    0              1000                                 100%
        10%                  104               896                                 100%
        50%                  499               501                                 100%
       100%                 1000                 0                                 100%
```

The split is by a hash of the user id — 10% gives 104 people (the natural variance of a hash), and each of them goes the same way both times. The client knows nothing — the URL is the same, only a number in the gateway changed. (Canary for deploys — a new version of the same service — is Lesson 10.6.)

**What not to put in the gateway.** The gateway is on everyone's path, so there is a temptation to put everything there: "hide previews for free-plan users", "add this field to this response". No. Business rules in a gateway turn the gateway into a second monolith — everyone's changes queue behind one team (platform), in the riskiest place in the system. This is exactly what happened to the "Enterprise Service Bus" of the 2000s — and microservices' well-known principle is the reply to it: "smart endpoints, dumb pipes" (Martin Fowler and James Lewis, 2014) — intelligence in the services, dumb pipes between them. The rule: work that is **the same for everyone** (TLS, token verification, rate limiting, routing, logging) in the gateway; work for **one frontend** (stitching, shaping) in the BFF; **business** rules in the service.

### 1.5 "Who sent this?" — identity behind the gateway

**Edge Authentication** — verifying a user's token (JWT or session) once at the boundary — the gateway — and then telling the internal services "this is user 42's request"; the internal services no longer verify the token, but **how** they are supposed to trust that claim is part of the design.

The first half of incident 2's fix: token verification in one place — the gateway — so there is only one place to forget the expiry check. But incident 3: the gateway verifies and sets `x-user-id: 42`, and the service trusts it. What if someone reaches the service bypassing the gateway? Part B:

```
── B. Who sent this? — the gateway's verification, and reaching the service directly ──
   request                                                       trust mode                        signed mode
   gateway, no token                                             401                               401
   gateway, user 42's valid token                                200 · user 42                     200 · user 42
   gateway, valid token + a self-set x-user-id: 1                200 · user 42                     200 · user 42
   gateway, expired token                                        401                               401
   gateway, token signed with another secret (sub: 1)            401                               401
   service directly (bypassing the gateway), x-user-id: 1        200 · user 1 ← someone else's identity   401
   service directly, a real x-internal-auth from 70 s ago (42)   —                                 401
```

- **Everything through the gateway is fine** — in both modes. The third row matters: the client sent its own `x-user-id: 1`, and the gateway **dropped it** and set its own (42). Without that, the gateway is itself the hole.
- **Trust mode, bypassing the gateway: you can become user 1.** The service trusts a header, and anyone can write a header. Incident 3.
- **Signed mode:** the gateway puts the user id and a timestamp into `x-internal-auth` and signs it with its own secret (HMAC); the service verifies. Arriving directly there is no signature — 401. And a real old header (from 70 s ago — imagine it was stolen from a log) is also 401: the signature covers the time, and the service rejects anything older than 60 s.

So, in layers:

1. **Network:** internal services are unreachable from outside (private network, security groups). Essential — but not sufficient alone, because incident 3 shows that one wrong rule is enough; and a bug in an internal service (SSRF, say — where the server itself fetches a user-supplied URL) opens the door from the inside.
2. **Verifiable internal identity:** the gateway sets a short-lived signed token (the HMAC header here, or in practice often a small internal JWT), and the service verifies it. Identity headers sent by a client never travel inward.
3. **Service-to-service identity too:** "did this request really come from the BFF, or from someone else?" — for which you often want:

**Service Mesh (mTLS)** — a small proxy (a sidecar) next to every service, which together handle all service-to-service traffic: identity verification and encryption with certificates on both sides (mutual TLS — both "who is calling" and "who is being called" are proven), plus retries, timeouts and metrics — without changing the services' code (Istio, Linkerd). The cost: another proxy on every call (latency, CPU) and a lot of operational complexity — usually more than it is worth unless you have many services.

4. **Authorization in the service.** The gateway knows **who** (user 42); but whether user 42 may read this workspace's tasks is known by the work module, because membership is its data. Putting that in the gateway is 1.4's "business in the gateway" mistake.

### 1.6 TaskFlow's decision

- **One gateway for all external traffic** — replacing Module 3's Nginx with a real API gateway (based on Envoy or Kong, say; not hand-written), several instances, an L4 load balancer in front. Its job: TLS, JWT verification (once, expiry included), rate limiting (Lesson 9.5), request ids (the start of Lesson 10.4's tracing), and one origin — so the CORS mess ends. Routes: `/` → web BFF, `/m/*` → mobile BFF, `/api/files/*` → files service (canary 10% → 50% → 100%, by workspace), and the rest of `/api/*` → the monolith.
- **Identity:** the gateway drops all of the client's identity headers and sets a signed internal token valid for 60 s. Every service verifies it — in shared middleware, written once. Internal services sit on a private network. Authorization in each service. No service mesh for now — far too heavy for two services.
- **Two BFFs:** web = the SvelteKit server routes (the web team's); mobile = a small Node service (the mobile team's) with endpoints per mobile screen. Neither holds business rules — they stitch and shape.
- **Internal conversation:** where a user is waiting — REST, a shared Zod schema package (versioned), timeouts and fallbacks (9.4); everything else events (outbox → Redis Streams). `attachment.uploaded` goes into the files service, `attachment.processed` comes out. No gRPC for now — two services, one language.
- **The browser never calls an internal service directly.** Nor does the mobile app — which is what protects old app versions from internal changes; the BFF's endpoints are versioned.

> **Trade-off Table — how an external client reaches the inside**

| Approach                         | Round trips / bytes                           | Internal structure hidden?            | Security (tokens, CORS)                                   | Owner, complexity                                       | When                                                                  |
| -------------------------------- | --------------------------------------------- | ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Client → service, direct         | steps × RTT (349 ms on mobile), whole objects | No — a service change changes clients | Separate in each service — room for mistakes              | Nobody — simplest at the start                          | One service; or an internal tool                                      |
| API gateway (only)               | Same steps, same bytes (+0.2 ms)              | Partly — hides paths, not shapes      | In one place — TLS, tokens, rate limits                   | Platform team; stable, on everyone's path — keep simple | Nearly always, once there are several services                        |
| Gateway + BFF (one per frontend) | 1 step, screen-shaped (1.8–10 KB)             | Yes — the BFF's contract is stable    | At the gateway; the BFF also calls with an internal token | Frontend team; one extra service per frontend           | Several frontends (web, mobile) with different screens — **TaskFlow** |
| GraphQL (as a gateway or BFF)    | 1 step, whatever the client asks for          | Yes — the schema is stable            | At the gateway; needs query-complexity limits             | The schema's owner; resolver N+1, caching is hard       | Many different clients, fast-moving UI, a team for the schema         |

---

## 2. Interview Angle

**In almost every design question** (Uber, Instagram, e-commerce) a box gets drawn between the client and the services — "API gateway". A weak answer just says the name. A good answer says what a gateway **does** (TLS, auth, rate limiting, routing) and what it does **not** (business rules); if mobile is involved, a BFF and why (round trips — with a number: "3 steps × 100 ms on mobile"); and which internal conversations are synchronous and which are events. The follow-up is often: "isn't the gateway a single point of failure?" — yes, which is why it is stateless, numerous, behind an L4 load balancer, and simple.

**"If the gateway verifies the token, how do the services know who the user is?"** — this is where senior and junior separate: trusting a header is not enough (bypassing the gateway, SSRF); the gateway drops the client's headers and sets a signed short-lived internal token which the service verifies; network isolation is a layer on top of that; and authorization lives in the service.

**"What's the difference between a BFF and an API gateway?"** — a gateway is one for everyone, doing the same work for everyone, owned by the platform team; a BFF is one per frontend, stitching and shaping for screens, owned by that frontend's team. Bonus: when GraphQL is an alternative.

**In production, in practice:** the familiar stories — business rules accumulating in the gateway until nobody can tell which rule lives where; the gateway's timeout shorter than the internal service's (the gateway gives up first while the service keeps working — Lesson 9.4); internal services exposed and identity in a header (incident 3); and an old mobile app version calling an endpoint that was deleted — hence versioned BFF endpoints and a metric for "which versions are still out there".

---

## 3. Key Takeaway

- The conversation between two services: **is a user waiting right now?** — then request/response (with timeout and fallback); otherwise an event. Internally, REST plus a shared Zod schema is enough with few services; gRPC gives typed contracts and efficiency at the price of complexity
- When the browser calls services directly: **request waterfall** (4 requests, 3 steps — 349 ms on mobile), **over-fetching** (25 KB where 10 KB is needed), leaking internal structure (old mobile apps), and separate security in every service
- **BFF**: stitching and shaping for one frontend, inside the data centre — 1 step, 124 ms on mobile (the mobile BFF 109 ms, 1.8 KB). SvelteKit's `+page.server.ts` is the web's BFF; everything `load` returns goes to the browser. No business rules in the BFF
- **API gateway**: one door for all external traffic, L7 — TLS, token verification, rate limiting, routing, logging. +0.2 ms alone, but CPU per request — the gateway has to scale itself, and it is on everyone's path. No business rules in the gateway ("smart endpoints, dumb pipes")
- **Canary routing** at the gateway: split by a hash of user or workspace — 10% means ~10%, and one person always goes the same way; the tool of the strangler fig
- After **edge authentication**, identity along the path: drop the client's headers, set a signed short-lived internal token (401 if it arrives directly, 401 if it is old), network isolation, and authorization in the service; with many services, a **service mesh**'s mTLS

---

## 4. New Terms (Glossary)

| Term                           | Meaning                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Request Waterfall**          | Each request depends on the previous one's answer, so they go one after another — total time ≈ the number of steps × the round trip                                                           |
| **Over-fetching**              | Downloading more than the client needs — because the API returns whole objects for many callers                                                                                               |
| **Backend for Frontend (BFF)** | A thin server-side layer for one specific frontend — it calls internal services and stitches data into that screen's shape; owned by that frontend's team                                     |
| **API Gateway**                | The single entry point for all external requests — an L7 reverse proxy that routes and performs the work that is the same for everyone (TLS, token verification, rate limiting, logging) once |
| **Canary Routing**             | Sending a small share of a route's traffic (split by user/workspace) to a new service or version and the rest to the old one; increased gradually, reverted with one setting                  |
| **Edge Authentication**        | Verifying a user's token once at the boundary (the gateway), then conveying "who" inward in a verifiable (signed) way — identity headers sent by a client never travel inward                 |
| **Service Mesh (mTLS)**        | A proxy (sidecar) beside every service handling service-to-service traffic — identity and encryption with certificates on both sides, plus retries and metrics                                |

---

## 5. Reflection Questions

Think before you look at the answers — write at least two or three lines in your own words for each.

1. Version 1.2 of TaskFlow's mobile app calls the `comments` endpoint directly (from before the BFF). 30% of users have not updated in three months. Now the work team wants to change the comments response's shape (`author` becomes a nested object instead of `authorId`). (a) Without a BFF, what are the options and what does each cost? (b) With a mobile BFF, what is the path for the same change? (c) Why do the BFF's own endpoints still need versions?
2. The platform team says: "The gateway sees every request — so let's put the 'hide attachment previews for free-plan workspaces' rule in the gateway, in one place." Give three arguments for why that is the wrong place. Where should the rule go? And what kind of rule _is_ right for a gateway — give an example that sounds like a business rule but is really the gateway's job.
3. A request's full path: browser → gateway → web BFF (SvelteKit) → work module (monolith) → outbox event → notifications worker (sends the email). At each step, how does "who" (user 42) travel and who verifies it? The worker gets the event seconds later — is the internal token's 60 s expiry a problem then? What would be wrong with putting the user's JWT into the event?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) Without a BFF the old app owns the comments endpoint directly. The options:

- **Keep the old shape, add the new one beside it** — running `/v1/comments` (old, `authorId`) and `/v2/comments` (new) together (Lesson 2.5) until usage of the old app is near zero. The cost: the work team maintains two shapes — for months, with one more added by every future change.
- **Force update** — show old apps an "please update" screen. The cost: annoyed users, some churn; plus app store review delays.
- **Do not make the change** — which is what usually happens. The cost: internal design improvements stay blocked by one old external client.

(b) With a mobile BFF: the app calls the BFF's `/m/tasks/:id`, which returns the mobile screen's shape — the app never sees comments' internal shape. The work team changes comments; the mobile BFF's internal code builds the same screen shape from the new one — one deploy, by the mobile team, with no app change at all. The internal change stays internal.

(c) Because the BFF's contract is now the external API — old apps call its old shape. When the mobile screen itself changes (new fields, a different layout) the BFF's endpoint changes too, and the old one has to stay for old apps: `/m/v3/tasks/:id`. The difference: these versions belong to the mobile team — one team, one client — rather than a jungle of separate versions across every internal service. Plus a metric: which app version calls which endpoint how often — the numbers tell you when the old one can be deleted.

**Question 2:** Three arguments:

- **The rule needs data the gateway does not own.** "Free plan" is billing's data; "preview" is a files/work concept. For the gateway to know it, it has to call billing (another hop on every request, and when billing goes down so does the gateway) or keep a copy (syncing). A new dependency in the place that is on everyone's path.
- **Business risk on everyone's path.** One bug in the gateway takes all of TaskFlow down. Business rules change often — and every change deploys in the riskiest place, queued behind the platform team (the ESB story).
- **The rule spreads to two places.** A mobile app's offline sync, an export job, a partner API — anything that does not pass through that gateway route — will not have the rule, or will have it rewritten. Two copies of one rule drift apart eventually.

Where it goes: in the files/work service — whoever serves the preview decides who gets it (with plan information arriving from billing by event into its own copy — 7.5). The BFF just displays what it is given.

A "business-sounding" rule that is right for a gateway: **rate limits by plan** — "60 API calls a minute on free, 600 on pro". It sounds like business, but it is the same kind of work for everyone (count and stop), needs no understanding of request content, and the plan can live as a claim in the token (set when the token is issued) — so the gateway calls nobody. (Lesson 9.5.)

**Question 3:** Step by step:

1. **Browser → gateway:** the user's JWT (or session cookie). The gateway verifies it — signature, expiry. It drops any `x-user-id` or `x-internal-auth` the client sent.
2. **Gateway → web BFF:** a signed internal token (user 42, the current time, 60 s). The BFF verifies it (shared middleware) and sets `locals.user`.
3. **BFF → work module:** the BFF forwards the same internal token (or mints a new one, if the BFF is allowed to sign). The work module verifies it, then does **authorization**: is user 42 a member of this workspace?
4. **Work module → outbox event:** the event carries `actorId: 42` — an ordinary data field, not a token. The event is trusted because it came from our own outbox, in a stream only our services can write to (the stream's own access control).
5. **Notifications worker:** reads the event and uses `actorId` ("Karim assigned you a task"). There is no token to verify — the worker is not acting **on behalf of** the user; it is acting on the system's behalf, on the basis of something that already happened.

The 60 s expiry: not a problem for the worker, because the worker does not use a token. But if the worker did have to call another service on user 42's behalf (to fetch the user's private data, say), then: either the worker has its own service identity (mTLS or a service token) and the service trusts "on the system's behalf, for user 42's event", or a fresh short-lived token is minted at that moment — never keeping the old one alive.

Putting the user's JWT in the event is wrong because: (a) a token is a bearer credential (like 8.2's presigned URL) — it sits in the stream, in logs, in the DLQ (7.4) for days, and whoever can read it can become user 42; (b) event replay (7.2) happens hours or days later — the token has expired by then, so either the work fails or somebody lengthens the expiry (worse still); (c) the token stays in the event even after the user logs out or is banned. An event carries **what happened and who did it** — not permission.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (separate Node processes as separate services; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-9.2-gateway-bff/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-9.2-gateway-bff) — `npm install`, then `npm run bff` and `npm run gateway`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`bff` opens a "task detail" page three ways — the browser calling three services itself, through the web BFF, and through the mobile BFF — under desktop and mobile network models, measuring requests, steps, bytes and time; and it verifies that the web BFF's page and the browser's own stitched page are identical. `gateway` runs a toy gateway: the cost of the extra hop, token verification and reaching the service directly past the gateway (in both trust and signed modes), and canary routing by user.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` and ESLint clean; `bff` three times — requests, steps and bytes identical, timings within 1–2%; `gateway` four times — parts B and C identical, part A's req/s varying by a few percent. Experiments 1 and 4 in the README were run and their numbers are in the README; 2, 3 and 5 involve changing code — those are yours. The browser's network is a model — RTT and a shared bandwidth; no TCP slow start, TLS or packet loss; the two profiles are chosen, not measured. The exercise's HTTP client is `node:http` — Node 26's built-in `fetch` showed a strange ~500 ms delay after a short pause on this machine (even on localhost); the cause was not investigated, only measured and avoided. The gateway is an Express toy — a real gateway's CPU numbers will differ. JWTs are HS256 with the secret hard-coded — for the exercise only. The SvelteKit code in 1.3 and the gateway choices in 1.6 are a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Compute first:** before running `bff`, work out each row's p50 — steps × RTT + bytes ÷ bandwidth + internal work (assume a few ms). Then run it and compare. Which row matched your arithmetic best and which worst — why?

2. **When the waterfall gets longer:** experiment 2 — make step 2 in `directPage` one request at a time. How many ms on mobile? Then think: how much does the same mistake cost inside the BFF (`NET_MS=1`)? Using those numbers, say which mistake matters least in a BFF's code review and which matters most in the browser's.

3. **The identity gap:** for each of the seven rows in `gateway`'s part B, write one line on the real situation that produces it (e.g. "expired token: the user's tab was open all night"). Then remove the "drop the client's x-user-id" part from the gateway in `service.ts` (forward the client's headers instead) — which row breaks?

4. **The unit of a canary:** run experiment 4 (`USERS=100`). In TaskFlow a workspace has 10 users — a 10% canary by user means one person on a team sees the new thumbnails and the rest see the old. What gets better if you split by workspace, and what gets worse (a bug in one large workspace)? To change `gateway`'s `bucket` to split by workspace, what would the gateway need to know, and where would it get it?

5. **The design part:** a one-page design for TaskFlow's front door: (a) the gateway's route list, where each goes, and which have a canary; (b) the gateway's list of duties plus three examples of "what will never go in the gateway"; (c) the identity path — which header, who sets it, who verifies it, what expiry, and what goes into events; (d) three mobile BFF endpoints (per screen) and their versioning rule; (e) which metrics tell you the gateway is healthy (added latency, errors, instance CPU).

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8 (complete, with exit challenges), 9.1
Current: 9.2 — Service communication, API Gateway, BFF pattern
TaskFlow state: modular monolith (work, identity, billing, files, search) + files processing service;
an API gateway in front (Envoy/Kong based, several instances, behind an L4 LB): TLS, JWT verified
once, rate limiting, request ids, one origin; routes: / → web BFF (SvelteKit server routes),
/m/* → mobile BFF (mobile team), /api/files/* → files service (canary by workspace), /api/* →
monolith; the gateway drops the client's identity headers and sets a 60 s signed internal token that
every service verifies, internal services on a private network, authorization in each service;
internally: a user is waiting → REST + a shared Zod schema, everything else events (outbox → Redis
Streams); no service mesh and no gRPC for now
Terms learned (Module 9 so far): Monolith / Microservices, Database per Service, Conway's Law,
Modular Monolith, Bounded Context, Distributed Monolith, Strangler Fig, Request Waterfall,
Over-fetching, Backend for Frontend (BFF), API Gateway, Canary Routing, Edge Authentication,
Service Mesh (mTLS)
Weak spots: [where you got stuck — write it yourself]
Next: 9.3 — Distributed transactions: Saga pattern, 2PC
=======================
```

---

## 8. Next Step

Run the exercise and send me the results — especially your arithmetic in 1 and the design in 5. When you are ready, write `next` — in Lesson 9.3 we go to **distributed transactions — the Saga pattern and 2PC.** In Lesson 9.1 we saw what happens when one transaction is split across two databases: 83 mismatches, and duplicates on "try again". If TaskFlow's billing ever has to be separated, "create the task + increment usage + stop if the limit is exceeded" has to stay correct together — with no shared `BEGIN … COMMIT`. There are two old answers: two-phase commit (everyone says "yes" before anything commits — and what happens when the coordinator dies), and the saga (step by step, each step with a reverse action — and what others see in the middle). We will measure both.
