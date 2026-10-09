# Lesson 10.5 - Security at Scale: AuthN vs AuthZ, OAuth/JWT, Secret Management, DDoS

**Module 10 - Reliability, Security & Operations**

> **Spaced Repetition (Lesson 8.2):** Presigned URL এর মেয়াদ কেন কয়েক মিনিটে রাখা হয়, কয়েক দিন না? আর একবার বানিয়ে দেওয়ার পরে মেয়াদের আগে সেটা বাতিল করার কোনো উপায় আছে কি? আজ একই প্রশ্ন আরও বড় আকারে ফিরবে - TaskFlow এর প্রতিটা user এর হাতে এমন একটা জিনিস আছে, আর একজনকে চাকরি থেকে বের করে দেওয়ার পরেও সেটা প্রায় এক দিন কাজ করেছে।

**Prerequisite:** Lesson 2.2 (TLS), Lesson 4.5 (CDN, anycast), Lesson 8.2 (Presigned URL), Lesson 9.2 (Gateway, edge authentication, internal token), Lesson 9.5 (Rate limiting), Lesson 10.3 (Static stability, JWKS), Lesson 10.4 (Structured log)

**আপনি এই lesson শেষে পারবেন:**

1. AuthN আর AuthZ কে আলাদা করে বলতে পারবেন, আর একটা JWT কে ঠিকভাবে যাচাই করতে পারবেন। ঠিকভাবে মানে কোন field server ঠিক করে আর কোনটা token, সেটা জানা। সাথে সংখ্যা দিয়ে দেখাতে পারবেন যে authorization এর একটা ফাঁকা route কীভাবে পুরো database ফাঁস করে, আর সেটা CI তে কীভাবে ধরা যায়
2. Token এর মেয়াদ, refresh token rotation আর denylist এর trade-off বলতে পারবেন। কতক্ষণ পরে revoke কার্যকর হয়, identity service এ কত চাপ পড়ে, আর identity মরলে কী হয়। আর OAuth এর authorization code flow এ state, PKCE, exact redirect আর single-use এর প্রতিটা **কোন** আক্রমণ থামায় সেটা বলতে পারবেন
3. একটা secret ফাঁস হলে কী করতে হয় আর কেন ফাঁসের ক্ষতি কমায় secret এর ছোট আয়ু, rotation এর ক্যালেন্ডার না, সেটা বলতে পারবেন। Credential stuffing আর DDoS এর সামনে কোন স্তর কাজ করে আর কোনটা শুধু কাজ করার ভান করে, সেটাও সংখ্যা দিয়ে আলাদা করতে পারবেন

**Tier:** 1 - Runnable Code (পাঁচটা deterministic script। JWT, BOLA, session, OAuth, secret, credential stuffing আর DDoS। কোনো network, identity provider, CDN বা Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

10.4 এর পরে TaskFlow নিজেকে দেখতে পায়। প্রতিটা request এর trace আছে, log structured, alert burn rate এ। 9.2 থেকে সব বাইরের traffic একটা gateway দিয়ে আসে। Gateway user এর JWT যাচাই করে, client এর পাঠানো পরিচয়ের header ফেলে দেয়, আর ভেতরে একটা ৬০ s এর signed internal token বসায়। 9.5 থেকে login এ rate limit আছে: IP ধরে ঘণ্টায় ২০টা চেষ্টা, email ধরে ১০টা। Identity module এর access token JWT, মেয়াদ ২৪ ঘণ্টা, revoke এর কোনো ব্যবস্থা নেই - "stateless, তাই scale করে।"

TaskFlow এর এখন ২,০০০ workspace, ৬০,০০০ board। তারপর এলো এক সপ্তাহ।

**সোমবার।** একজন customer এর CTO support এ লিখলেন: "আমাদের একটা private board এর পুরো export একটা প্রতিযোগীর কাছে আছে।" খুঁজে পাওয়া গেল `mallory` নামের একজনকে। তার একটা free workspace আছে, যার সে admin। তার **বৈধ** token দিয়ে সে একটা script চালিয়েছিল: `GET /boards/1/export`, `/boards/2/export`, … `/boards/60000/export`। Board এর id ছিল sequential। Export route টা নতুন, এক sprint এ লেখা। সে token যাচাই করে, কিন্তু board টা user এর workspace এর কিনা দেখে না। অন্যের **৫৯,৯৭০টা board** গেছে। Token এ কোনো ভুল ছিল না, gateway তার কাজ ঠিকই করেছে।

**মঙ্গলবার।** Billing team একজন contractor কে repo তে access দিয়েছিল। তিন সপ্তাহ পরে Stripe একটা email পাঠাল: TaskFlow এর live key দিয়ে অচেনা refund হচ্ছে। চার মাস আগের একটা commit, `wip: local test`, এ একটা `.env` ছিল। তার পরের commit এর নাম `oops remove .env`। File টা আজকের code এ নেই, কিন্তু git history তে আছে। সেই `.env` এ আরও ছিল token sign করার secret আর production database এর password।

**বুধবার।** 10.4 এর পরে কেউ একজন debug করার সময় gateway এর structured log এ পুরো request header যোগ করেছিল। তার মধ্যে `Authorization: Bearer eyJ...` ও আছে। Log store এ ৪০ জনের পড়ার অনুমতি। একই দিনে HR জানাল, একজন employee কে সকালে বরখাস্ত করা হয়েছে, আর তার account disable করার পরেও সে সারাদিন TaskFlow এ ঢুকে data নামিয়েছে। কারণ: ২৪ ঘণ্টার JWT, যা কেউ ফেরত নিতে পারে না।

**শনিবার রাত।** ৬ ঘণ্টায় ১২ লাখ login চেষ্টা, ৩৮,০০০টা আলাদা IP থেকে। প্রতি IP ঘণ্টায় গড়ে ৫টা চেষ্টা, আর প্রতি email গড়ে একবার। 9.5 এর সীমা একবারও বাজেনি। সকালে দেখা গেল **৩,৫৪৭টা account দখল হয়েছে**। এরা সবাই এমন user যারা অন্য কোনো ফাঁস হওয়া site এর password টাই TaskFlow এ ব্যবহার করত। আর বিদ্রূপের ব্যাপার: সেই রাতেই ৯৪৬ জন বৈধ user login করতে পারেনি। তারা একটা বড় office এর NAT এর পেছনে, এক IP থেকে আসে, তাই ঘণ্টায় ২০ এর সীমা তাদেরকেই আটকেছে।

**রবিবার।** Public share page `/s/:token` এ সেকেন্ডে ৬০,০০০ request এলো, ২০,০০০ IP থেকে। CDN আছে (4.5), কিন্তু প্রতিটা URL এর শেষে `?x=` আর এলোমেলো একটা সংখ্যা। প্রতিটা request cache miss, সোজা origin এ। Origin এর ক্ষমতা সেকেন্ডে ২,০০০। চার ঘণ্টা TaskFlow প্রায় বন্ধ।

Postmortem এ security এর দায়িত্বে থাকা engineer এর এক লাইন: "আমাদের login এ একটা দরজা ছিল, আর আমরা ভেবেছিলাম দরজাটাই নিরাপত্তা। প্রতিটা ঘটনা দরজার **পরে** ঘটেছে - অথবা দরজার পাশের দেয়াল দিয়ে।"

---

## ১. Theory

### ১.১ দুটো আলাদা প্রশ্ন - "আপনি কে?" আর "আপনি কি এটা করতে পারেন?"

সোমবারের ঘটনাটা ভালো করে দেখুন। Mallory এর token বৈধ ছিল। Gateway ঠিক বলেছিল "এটা mallory"। ভুলটা হয়েছিল পরের প্রশ্নে, যেটা কেউ করেনি।

**Authentication (AuthN) / Authorization (AuthZ)** - Authentication প্রমাণ করে request টা **কে** পাঠিয়েছে (password, token, certificate দিয়ে); authorization ঠিক করে সেই পরিচয়ের **এই resource এ এই কাজ** করার অনুমতি আছে কিনা। AuthN একবার, সীমানায় হতে পারে; AuthZ প্রতিটা resource এর প্রতিটা কাজে, যেখানে data আছে সেখানে হতে হয়।

```
            AuthN - "আপনি কে?"                    AuthZ - "এটা কি আপনার?"
browser ──► gateway ─────────────────────► service ───────────────────────► DB
            token যাচাই: signature,              user 42 কি board 4821 এর
            মেয়াদ, iss, aud                       workspace এর member? কোন role?
            ফল: principal = user 42               ফল: 200 / 404
            (একবার, এক জায়গায় - 9.2)             (প্রতিটা route, প্রতিটা object)
```

9.2 এ AuthN কে সীমানায় এক জায়গায় আনা হয়েছিল। এতে ভুলের জায়গা একটা হয়ে গিয়েছিল। AuthZ কে এভাবে এক জায়গায় আনা যায় না। Gateway জানে না board 4821 কোন workspace এর, ওটা জানে database। তাই AuthZ এর ভুলের জায়গা হলো **প্রতিটা route**, আর প্রতিটা নতুন route একটা নতুন সুযোগ।

এই lesson এর বাকিটা এই দুই প্রশ্নের চারপাশে ঘোরে। প্রথমে দেখব AuthN এর টুকরো ঠিক কী (JWT) আর সেটা কীভাবে ভুলভাবে যাচাই হয় (১.২)। তারপর AuthZ এর সবচেয়ে সাধারণ ভুল (১.৩)। তারপর AuthN কে **ফেরত নেওয়া** (১.৪), আর অন্য কারো হয়ে AuthN (OAuth, ১.৫)। শেষে তিনটা জিনিস যা দরজার পাশের দেয়াল: secret (১.৬), দরজায় ধাক্কা (১.৭), আর পুরো বাড়িতে বন্যা (১.৮)।

### ১.২ JWT - signature মেলা মানেই বিশ্বাসযোগ্য না

**JWT (JSON Web Token)** - তিনটা base64url অংশ, বিন্দু দিয়ে জোড়া: `header.payload.signature`। Header বলে কোন algorithm দিয়ে sign হয়েছে (`alg`) আর কোন key দিয়ে (`kid`)। Payload এ **claim** থাকে: `sub` (কে), `iss` (কে বানিয়েছে), `aud` (কার জন্য), `exp` (কখন মরবে)। Signature প্রমাণ করে header আর payload কেউ বদলায়নি। JWT সাধারণত **signed, encrypted না** - যে কেউ payload পড়তে পারে।

```
eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMTAifQ . eyJzdWIiOiJhbGljZSIsImF1ZCI6InRhc2tmbG93LWFwaSIsImV4cCI6...} . kQ3x...
└──── header ─────────────────────────────┘   └──── payload (claims) ──────────────────────────────────┘   └ signature ┘
{"alg":"RS256","kid":"2026-10"}               {"sub":"alice","iss":"https://id.taskflow.test",
                                               "aud":"taskflow-api","exp":1790000900,"role":"member"}
```

RS256 এ identity service একটা **private key** দিয়ে sign করে, আর বাকি সবাই তার **public key** দিয়ে যাচাই করে। Public key সবার কাছে থাকে (10.3 এর JWKS endpoint থেকে)। শুধু identity sign করতে পারে।

এখন সমস্যা: payload পড়া যায় বলে token এ password, secret বা অন্য সংবেদনশীল কিছু রাখা যাবে না। আর তার চেয়েও বড় সমস্যা হলো **যাচাইটা কীভাবে লেখা হয়েছে।** Exercise এর `npm run authz` অংশ ক তে দুটো verifier আছে। Naive verifier header এর `alg` পড়ে সেই algorithm দিয়ে যাচাই করে, আর শুধু signature দেখে। Strict verifier algorithm নিজে ঠিক করে, `kid` দিয়ে নিজের key ring থেকে key নেয়, তারপর `iss`, `aud` আর `exp` দেখে। দুটোকে আটটা token দেওয়া হলো:

```
token                                           naive                     strict
valid token                                    200 (member)              200 (member)
role → admin in the payload (old signature)   401 invalid signature  401 signature mismatch
alg: none, empty signature                    200 (admin)         401 alg none not in the allowlist
HS256, signed using the public key as the secret  200 (admin)         401 alg HS256 not in the allowlist
expired 2 hours ago                        200 (member)             401 expired
aud = billing-api (another service's)          200 (member)          401 aud mismatch
iss = staging (sharing the same key)          200 (member)          401 iss mismatch
signed with another key (the attacker's own)  401 invalid signature  401 signature mismatch

naive accepted 6/8, strict 1/8
```

প্রথমে খেয়াল করুন কী **কাজ করেছে**: payload বদলানো আর অন্য key দিয়ে sign করা, দুটোই naive ও ধরেছে। Cryptography ঠিক আছে। ভাঙার জায়গা অন্য তিনটা:

1. **`alg: none`।** JWT এর standard এ "unsecured JWT" বলে একটা জিনিস আছে, যার algorithm `none` আর signature খালি। Verifier যদি token কে জিজ্ঞেস করে "আপনাকে কীভাবে যাচাই করব?", token বলবে "করতে হবে না"। এভাবে একটা জাল `admin` token পাশ হয়ে যায়।
2. **Algorithm confusion (RS256 → HS256)।** এটা আরও সূক্ষ্ম। HS256 একটা symmetric algorithm, মানে একই secret দিয়ে sign আর যাচাই হয়। Naive verifier এর হাতে আছে public key এর text, আর সে সেটাই "key" হিসেবে ব্যবহার করে। Attacker এর হাতেও সেই public key আছে, কারণ এটা public। সে header এ `HS256` লিখে, public key এর text কে HMAC secret বানিয়ে নিজেই sign করে। Verifier একই কাজ করে, signature মিলে যায়। দ্বিতীয় জাল `admin`।
3. **Claim না দেখা।** মেয়াদ শেষের token, অন্য service এর token (`aud = billing-api`), staging এর token (একই key ভাগ করা)। Signature সব ঠিক, কিন্তু কোনোটাই **এই API এর জন্য, এখন** বৈধ না। 9.2 এর files team এর ঘটনা মনে করুন: `exp` না দেখায় logout করা user এর token তিন দিন চলেছিল।

নিয়মটা এক লাইনে: **কীভাবে যাচাই হবে সেটা server ঠিক করে, token না।** Algorithm একটা allowlist থেকে আসে (এখানে শুধু RS256)। Key আসে নিজের trusted key ring থেকে, `kid` দিয়ে। `kid` শুধু বেছে নেওয়ার জন্য, key এর **উৎস** কখনো token থেকে আসে না। কিছু JWT header এ `jku` বা `x5u` থাকে, মানে "এই URL থেকে key নিন"। ওগুলো কখনো মানবেন না, কারণ তাহলে attacker নিজের key এর URL দিয়ে দিতে পারে। তারপর `iss`, `aud`, `exp` (আর `nbf`, `iat`) দেখুন, সাথে ঘড়ির skew এর জন্য অল্প ছাড় (6.4)।

এই নিয়মগুলো IETF এর **JWT Best Current Practices (RFC 8725)** এ লেখা আছে (এখানে যাচাই করা না)। আর এখানকার সবচেয়ে বড় শিক্ষা: **JWT এর verifier নিজে লিখবেন না।** Exercise এর verifier নিজের হাতে লেখা, শুধু দেখানোর জন্য কোথায় ভাঙে। Production এ একটা পরীক্ষিত library ব্যবহার করুন, যেমন Node এ `jose`, আর algorithm এর allowlist সবসময় নিজে পাঠান:

```ts
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { env } from './env';
import { denylist } from './denylist';

const jwks = createRemoteJWKSet(new URL(env.JWKS_URL));

const accessClaims = z.object({
	sub: z.string().min(1),
	jti: z.string().min(1)
});

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
	const header = req.get('authorization');
	const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
	if (token === undefined) {
		res.status(401).end();
		return;
	}
	try {
		const { payload } = await jwtVerify(token, jwks, {
			algorithms: ['RS256'],
			issuer: env.TOKEN_ISSUER,
			audience: 'taskflow-api',
			clockTolerance: 60
		});
		const claims = accessClaims.parse(payload);
		if (await denylist.has(claims.jti)) {
			res.status(401).end();
			return;
		}
		res.locals.userId = claims.sub;
		next();
	} catch {
		res.status(401).end();
	}
}
```

দুটো জিনিস লক্ষ করুন। প্রথমত, `jwtVerify` signature আর `iss`/`aud`/`exp` যাচাই করে, কিন্তু payload এর **আকার** যাচাই করে না। তাই তার পরে Zod দিয়ে parse করা হয়েছে। Payload ও একটা runtime input, বিশ্বাস করার আগে parse করতে হয়। দ্বিতীয়ত, token থেকে **`role` নেওয়া হয়নি**, শুধু `sub`। কেন, সেটা পরের অংশে। (`denylist` এর কথা ১.৪ এ।)

**আর 10.3 এর JWKS এর কথা।** `createRemoteJWKSet` key গুলো cache করে, অজানা `kid` এলে নতুন করে আনে। 10.3 এর reflection question এ দেখেছিলাম, identity মরলে key এর cache শেষ হয়ে গেলে কী হয়। সেখানকার statically stable নকশা এখানেও প্রযোজ্য: শেষ জানা key set ধরে রাখুন, আর নতুন key **আগে প্রকাশ** করুন, পুরনো key **পরে** সরান।

### ১.৩ BOLA - একটা ফাঁকা route, পুরো database

এবার সোমবার। `npm run authz` অংশ খ এ ২,০০০ workspace × ৩০টা board = ৬০,০০০ board, id `1..60000`। Mallory নিজের free workspace এর admin, তার token বৈধ। আটটা route এর প্রতিটায় সে অন্যের সব board এর id দিয়ে চেষ্টা করে:

```
route                          got others' boards  learned existence
GET    /boards/:id                         0          59,970
GET    /boards/:id/tasks                   0          59,970
PATCH  /boards/:id                         0          59,970
GET    /boards/:id/activity                0          59,970
POST   /boards/:id/share-link              0          59,970
GET    /boards/:id/export             59,970          59,970
DELETE /boards/:id                    59,970          59,970
POST   /boards/:id/archive                 0          59,970
```

আটটার ছয়টা ঠিক। দুটো ভুল, আর দুটো ভুল দুই রকম:

- **`export` check ভুলে গেছে।** Token যাচাই হয়েছে (gateway এ), board টা load হয়েছে, পাঠিয়ে দেওয়া হয়েছে। মাঝখানে "এই board কি আপনার workspace এর?" প্রশ্নটা নেই। এটাই সোমবারের ঘটনা।
- **`DELETE` ভুল জিনিস বিশ্বাস করেছে।** এর check হলো `role === 'admin' || member`, আর `role` আসে token থেকে। Mallory সত্যিই admin, কিন্তু **নিজের** workspace এর। Token এর একটা global `role: admin` বলে না সে কোথায় admin। Role একটা সম্পর্ক (user × workspace), আর সেটা থাকে database এ, token এ না।

**BOLA (Broken Object Level Authorization)** - একটা API একটা object এর id নেয় (`/boards/:id`), user authenticated কিনা দেখে, কিন্তু **এই নির্দিষ্ট object** এ তার অনুমতি আছে কিনা দেখে না। ফলে যেকোনো বৈধ user id বদলে অন্যের data পড়তে বা বদলাতে পারে। পুরনো নাম IDOR (Insecure Direct Object Reference)। OWASP এর API Security Top 10 (২০২৩) এর এক নম্বর ঝুঁকি।

খেয়াল করুন, এটা AuthN এর ব্যর্থতা না। প্রতিটা request এ mallory সত্যিই mallory। আর তৃতীয় কলামটা দেখুন: ছয়টা "ঠিক" route ও প্রতিটা board এর **অস্তিত্ব** ফাঁস করে, কারণ "নেই" হলে 404 আর "আপনার না" হলে 403। Attacker কে এতটুকু জানানোও একটা তথ্য: কোন id আছে, কতগুলো board, কত দ্রুত বাড়ছে। তাই অন্যের object এর জন্য সাধারণত **404** ফেরত দেওয়া হয়, "এমন কিছু আপনার জন্য নেই"।

**UUID কি সমাধান?** একটা স্বাভাবিক প্রতিক্রিয়া: "id sequential না রেখে এলোমেলো UUID করুন।" অংশ গ:

```
mallory's attempt                       attempts  got others' boards
guessing random UUIDs              1,000,000                 0
ids from a leaked support log          340               340
```

দশ লাখ অনুমানে একটাও না। UUID v4 এর ১২২ bit এলোমেলো, অনুমান করে পাওয়ার কোনো আশা নেই। কিন্তু id **গোপন জিনিস না।** URL এ থাকে, browser history তে থাকে, screenshot এ, support ticket এ, log এ (10.4), share করা link এ। ৩৪০টা ফাঁস হওয়া id এর **৩৪০টাই** কাজ করেছে। UUID enumeration থামায়, আর সেটা ভালো জিনিস, রাখুন। কিন্তু এটা authorization না। Authorization মানে "id জানলেও আপনি পাবেন না।"

**কীভাবে ঠিক করবেন - আর কীভাবে আবার না ঘটে।** একটা route ঠিক করা সহজ। কঠিন হলো পরের sprint এর নতুন route টা। দুটো কৌশল একসাথে লাগে:

**(ক) Authorization কে data পড়ার পথে বসান, route এর ভেতরে না।** কোনো route যেন permission না দেখে board load **করতেই না পারে**:

```ts
import { Op } from 'sequelize';
import { Board, Membership } from './models';

export async function loadBoardFor(userId: string, boardId: string): Promise<Board | null> {
	const memberships = await Membership.findAll({
		where: { userId },
		attributes: ['workspaceId']
	});
	return Board.findOne({
		where: {
			id: boardId,
			workspaceId: { [Op.in]: memberships.map((m) => m.workspaceId) }
		}
	});
}
```

প্রতিটা route `loadBoardFor` ডাকে, `Board.findByPk` সরাসরি ডাকা নিষেধ। এটা একটা lint rule দিয়ে আটকানো যায়, বা model টা শুধু এই module থেকে export করে। `null` এলে route 404 দেয়। "কার?" প্রশ্নটা তখন query এর **ভেতরে**, তাই ভুলে যাওয়ার মতো কোনো আলাদা লাইন থাকে না। Role ও আসে `Membership` থেকে (workspace ধরে), token থেকে না।

**(খ) Authorization matrix test।** প্রতিটা route × প্রতিটা ধরনের actor, আর প্রত্যাশিত ফল। অংশ ঘ:

```
route                           owner   member of another ws  admin of another ws  no token  result
GET    /boards/:id              200       404                 404                401           pass
…
GET    /boards/:id/export       200       200 ✗               200 ✗              401           FAIL
DELETE /boards/:id              204       404                 204 ✗              401           FAIL
POST   /boards/:id/archive      200       404                 404                401           pass

3 cells failed - with this test in CI it would have been caught before merge
```

তিনটা ঘর, আর ঠিক সেই তিনটা যা সোমবারে আসল ক্ষতি করেছে। এই test এর শক্তি হলো এটা route এর তালিকা থেকে **নিজে** তৈরি হয়। নতুন route যোগ করলে সে matrix এ নিজেই ঢুকে যায়, আর কেউ প্রত্যাশিত ফল না লিখলে test ব্যর্থ হয়। 10.3 এর dependency matrix এর একই যুক্তি: যে প্রশ্ন সবাই ভুলে যায়, সেটা CI কে করতে দিন।

### ১.৪ Session - একটা token কে ফেরত নেওয়া

বুধবারের দ্বিতীয় অর্ধেক। বরখাস্ত employee এর account সকালে disable হয়েছিল। কিন্তু তার হাতে একটা ২৪ ঘণ্টার JWT ছিল, আর API সেটা যাচাই করে signature আর মেয়াদ দিয়ে। Account disable হয়েছে কিনা, সেটা কেউ দেখে না। 8.2 এর presigned URL এর মতোই এটা একটা **bearer** অনুমতি: যার হাতে, সে-ই মালিক, মেয়াদ শেষ না হওয়া পর্যন্ত।

**Spaced repetition এর উত্তর:** presigned URL এর মেয়াদ ছোট রাখা হয় ঠিক এই কারণে। একবার দিয়ে দিলে তাকে ফেরত নেওয়ার কোনো উপায় নেই (signing key টাই বদলানো ছাড়া, যাতে **সবগুলো** একসাথে মরে)। তাই ছোট মেয়াদই একমাত্র revoke। Stateless JWT এর ক্ষেত্রেও হুবহু একই কথা। "Stateless" এর সুবিধা (কাউকে জিজ্ঞেস না করেই যাচাই) আর অসুবিধা (কাউকে জিজ্ঞেস না করে ফেরত নেওয়া যায় না) একই জিনিসের দুই দিক।

কতটা ছোট? `npm run sessions` অংশ ক তে ৬০,০০০ সক্রিয় session, সেকেন্ডে ৩০০ request, ৮ ঘণ্টা (৮৬ লাখ request)। মাঝে ২,০০০টা revoke (logout, password বদল, account disable), আর ছয়টা নীতি:

```
policy                        store/identity call/s   % of requests  after revoke: avg  worst  works if identity dies
JWT 24 h, no revoke                            0.0          0.0%            19.6 h         24.0 h          24.0 h
session lookup on every request             299.9        100.0%               0 s            0 s             0 s
access 1 h + refresh                           14.8          4.9%             27 min        1.0 h           1.0 h
access 15 min + refresh                       43.7         14.6%            4.8 min         15 min        15 min
access 5 min + refresh                        88.0         29.3%            1.1 min        5.0 min       5.0 min
access 15 min + refresh + denylist            43.7         14.6%               5 s            5 s           15 min
```

প্রথম দুটো সারি দুই প্রান্ত:

- **২৪ ঘণ্টার JWT:** identity কে কেউ ডাকে না। কিন্তু revoke এর পরে token গড়ে **১৯.৬ ঘণ্টা** চলে। বুধবারের employee ঠিক এই সারিতে ছিল।
- **প্রতি request এ session lookup:** পুরনো ধাঁচের server-side session (Express এর `express-session` + Redis এর মতো)। Revoke তাৎক্ষণিক। দাম: প্রতিটা request এ session store এ একটা lookup, সেকেন্ডে ৩০০টা। আর session store মরলে **কেউ** কিছু করতে পারে না (শেষ কলামে ০)। 10.3 এর ভাষায়, session store একটা hard dependency।

মাঝের সারিগুলো হলো আজকের সাধারণ নকশা। দুই রকম token:

**Refresh Token Rotation** - একটা ছোট মেয়াদের **access token** (JWT, ৫–১৫ মিনিট; API প্রতিটা request এ যাচাই করে, কাউকে না জিজ্ঞেস করে) আর একটা লম্বা মেয়াদের **refresh token** (opaque, মানে ভেতরে কোনো অর্থ নেই এমন এলোমেলো string; দিন বা সপ্তাহ; শুধু identity কে দেখানো হয় নতুন access token পেতে)। প্রতিবার refresh এ পুরনো refresh token মরে আর নতুন একটা আসে (**rotation**)। আর একটা পুরনো, ব্যবহার হয়ে যাওয়া refresh token আবার এলে পুরো পরিবার (সেই login এর সব refresh token) বাতিল হয় (**reuse detection**)।

Access token এর মেয়াদ একটা knob। এটা ঘোরালে **তিনটা** জিনিস একসাথে ঘোরে। ১৫ মিনিট থেকে ৫ মিনিট করলে revoke এর দেরি ৪.৮ মিনিট থেকে ১.১ মিনিটে নামে, ভালো। Identity এর চাপ দ্বিগুণ (৪৩.৭ থেকে ৮৮ call/s), খারাপ। আর identity মরলে মানুষ কতক্ষণ কাজ চালাতে পারে, সেটা ১৫ মিনিট থেকে ৫ মিনিটে নামে, এটাও খারাপ। Revoke দ্রুত হওয়া আর outage সহ্য করা পরস্পরের শত্রু, যতক্ষণ একটা knob দিয়ে দুটো চালাচ্ছেন।

শেষ সারিটা এই দুটোকে আলাদা করে। **Denylist** হলো revoke হওয়া token এর `jti` বা user এর একটা ছোট তালিকা। Identity এটা প্রতিটা API instance এ push করে, আর API প্রতিটা request এ নিজের memory তে দেখে (১.২ এর code এ `denylist.has`)। Revoke এর দেরি ৫ সেকেন্ড, মানে push এর সময়। কিন্তু identity call বাড়েনি (৪৩.৭), আর identity মরলেও access token ১৫ মিনিট চলে। তখন শুধু নতুন revoke পৌঁছায় না। তালিকাটা ছোট থাকে কারণ একটা entry কে শুধু token এর মেয়াদ পর্যন্ত রাখতে হয়, তার পরে token নিজেই মরা। Denylist এর দাম হলো **state**: "stateless JWT" আর পুরো stateless থাকে না। বেশিরভাগ বড় system এখানেই শেষ পর্যন্ত পৌঁছায়।

**Refresh token চুরি হলে।** বুধবারের log এ access token এর পাশে refresh token ও ছিল। অংশ খ তে access token ১৫ মিনিট, refresh token ৩০ দিন। Attacker চুরির ১০ মিনিট পরে কাজ শুরু করে:

```
stolen Monday 10:00, alice at work
policy                      attacker holds it  alice forced to log out  security alert
no rotation                         29.6 days                    0                0
rotation, no reuse detection        29.6 days                    1                0
rotation + reuse detection              15 min                    1                1

stolen Friday 16:50, alice back Monday
no rotation                         25.3 days                    0                0
rotation, no reuse detection        25.3 days                    1                0
rotation + reuse detection             2.7 days                    1                1
```

মাঝের সারিটা সবচেয়ে শিক্ষণীয়। **শুধু rotation চোরকে থামায় না, বৈধ user কে বের করে দেয়।** Attacker আগে refresh করেছে, তাই পরিবারের "বর্তমান" token এখন তার হাতে। Alice এর token পুরনো হয়ে গেছে, সে logout হয়, আবার login করে, আর ভাবে "অদ্ভুত"। Attacker ২৯.৬ দিন থেকে যায়। Reuse detection এই মুহূর্তটাকেই একটা সংকেত বানায়: alice তার পুরনো token টা দেখাল, server চিনল "এটা আগে ব্যবহার হয়েছে, মানে দুজন মানুষ এই পরিবার চালাচ্ছে", আর পুরো পরিবার বাতিল করল। Attacker এর হাতে থাকল শুধু তার শেষ access token এর ১৫ মিনিট। সাথে একটা security alert।

কিন্তু দ্বিতীয় দৃশ্যটা দেখুন। শুক্রবার বিকেলে চুরি, alice সোমবার সকালে ফেরে। Reuse ধরা পড়ে শুধু যখন **দুজনেই** token ব্যবহার করে। তাই সপ্তাহান্তে attacker একা, **২.৭ দিন**। প্রতিকার আরও স্তর: refresh token এর একটা **idle timeout** (ধরুন ১২ ঘণ্টা ব্যবহার না হলে মরে, কিন্তু attacker তো ব্যবহার করছে), নতুন device বা দেশ থেকে refresh হলে alert বা challenge, আর token কে একটা device এর key এর সাথে বেঁধে ফেলা (DPoP, mTLS-bound token)। শেষেরটায় চুরি হওয়া token একা অকেজো। আর সবার আগে: **token log এ যাবে না।** 10.4 এ বলেছিলাম log এর field এর একটা allowlist রাখুন। বুধবার সেটা ছিল না।

**Browser এ token কোথায় রাখবেন।** JavaScript পড়তে পারে এমন জায়গায় (`localStorage`) রাখলে একটা XSS bug (অন্যের script page এ চালানো) সব token নিয়ে যায়। `HttpOnly; Secure; SameSite` cookie তে রাখলে JavaScript সেটা পড়তে পারে না। এজন্যই 9.2 এর BFF pattern এ (SvelteKit এর server route) access token browser এ যায়ই না। Browser এর কাছে শুধু একটা session cookie থাকে, আর token থাকে BFF এর কাছে। Cookie এর নিজের ঝুঁকি আছে: CSRF, মানে অন্য site থেকে আপনার নামে request। `SameSite=Lax` বা `Strict` আর state বদলানো request এ CSRF token দিয়ে সেটা সামলাতে হয়।

### ১.৫ OAuth 2.0 আর OIDC - অন্য কারো হয়ে পরিচয়

TaskFlow এ দুটো নতুন চাওয়া এসেছে: "Google দিয়ে login" আর একটা public API, যাতে Slack এর মতো বাইরের app user এর হয়ে task পড়তে পারে। দুটোই একই প্রশ্ন: একটা app কীভাবে user এর password না জেনে user এর হয়ে কাজ করবে?

**OAuth 2.0 / OIDC** - OAuth 2.0 হলো **delegated authorization** এর একটা framework: user একটা app কে (client) সীমিত অনুমতি (scope) দেয়, password না দিয়ে, আর app পায় একটা **access token**। OIDC (OpenID Connect) তার উপরে একটা পরিচয়ের স্তর: সাথে একটা **ID token** (JWT) দেয়, যা client কে বলে "কে login করেছে"। দুটোর সবচেয়ে প্রচলিত flow হলো **authorization code flow + PKCE**।

```
 browser                 TaskFlow (client)                   authorization server (identity)
    │  "Google দিয়ে login" ──►│
    │                         │ state = random, verifier = random
    │                         │ challenge = SHA256(verifier)
    │◄── redirect: /authorize?client_id&redirect_uri&state&code_challenge ──
    │──────────────────────────────────────────────────────────────►│ user login + "অনুমতি দিন"
    │◄──────────── redirect: redirect_uri?code=abc&state=… ──────────│
    │── code, state ─────────►│
    │                         │ state মেলে? (CSRF)
    │                         │── POST /token: code + verifier + redirect_uri ──►│ SHA256(verifier) == challenge?
    │                         │                                                   │ code একবারই? মেয়াদ ৬০ s?
    │                         │◄────────── access token (+ ID token, refresh) ────│
```

Code টা browser এর URL দিয়ে যায়, তাই সেটাকে "চুরি হতে পারে" ধরে নিতে হয়। Token আসে back channel এ, মানে server থেকে server এ। Flow এর প্রতিটা প্রতিরক্ষা একটা নির্দিষ্ট পথ বন্ধ করে। `npm run oauth` অংশ ক তে চারটা আক্রমণ × পাঁচটা প্রতিরক্ষার সেট:

```
attack                                               nothing  state    PKCE only  state + PKCE  all (+exact, single-use)
Login CSRF: mallory's code in alice's browser         succeeded ✗  blocked  blocked  blocked   blocked
Code theft (mobile scheme / log), mallory redeems first  succeeded ✗  succeeded ✗  blocked  blocked   blocked
Code replay: the same code after alice               succeeded ✗  succeeded ✗  blocked  blocked   blocked
redirect_uri bait (prefix match), mallory's own PKCE  succeeded ✗  succeeded ✗  succeeded ✗  succeeded ✗  blocked
```

এক এক করে দেখি:

- **Login CSRF।** Mallory নিজে login করে নিজের code নেয়, তারপর alice কে একটা link এ click করায় যা TaskFlow এর callback এ **mallory এর** code পাঠায়। Alice এখন mallory এর account এ logged in, আর সে যা upload করবে তা mallory এর কাছে যাবে। **`state`** এটা থামায়। এটা একটা এলোমেলো মান যা alice এর browser এর login শুরুর সাথে বাঁধা, আর mallory এর callback এ সেটা মেলে না। এখানে PKCE ও থামিয়েছে, কারণ alice এর verifier mallory এর challenge এর সাথে মেলে না।
- **Code চুরি।** Code টা কোনোভাবে attacker এর হাতে গেছে। হতে পারে mobile app এর custom URL scheme অন্য একটা app ও নিবন্ধন করেছে, বা code কোনো log এ পড়েছে (বুধবার)। Attacker সরাসরি `/token` এ গিয়ে redeem করে। `state` এখানে কিছু করে না, কারণ attacker callback দিয়েই যাচ্ছে না। **PKCE** থামায়। Code redeem করতে verifier লাগে, আর verifier কখনো browser এর URL দিয়ে যায়নি, TaskFlow এর server এই ছিল।
- **Code replay।** একই code দ্বিতীয়বার। এখানে PKCE ই থামিয়েছে (attacker এর verifier নেই)। কিন্তু **single-use** এর নিয়মটা স্বাধীনভাবে লাগে। Code একবার ব্যবহার হলে তার পরের যেকোনো চেষ্টা ব্যর্থ হওয়া উচিত, আর ভালো authorization server তখন সেই code থেকে দেওয়া token ও বাতিল করে।
- **Redirect URI এর টোপ।** এটা সবচেয়ে শিক্ষণীয় সারি। Authorization server redirect URI এর **prefix** মেলায়: `https://app.taskflow.test` দিয়ে শুরু হলেই চলে। Mallory alice কে একটা link পাঠায় যার `redirect_uri` হলো `https://app.taskflow.test.evil.example/auth/callback`। এটা ঠিকই `https://app.taskflow.test` দিয়ে শুরু হয়, কিন্তু domain টা mallory এর। Flow টা mallory নিজে শুরু করেছে, **নিজের** PKCE challenge দিয়ে, তাই তার কাছে verifier আছে। Alice "অনুমতি দিন" চাপে, code যায় mallory এর domain এ, mallory redeem করে। State আর PKCE দুটোই অসহায়, কারণ দুটোই mallory এর। **শুধু exact match** থামায়।

শিক্ষাটা সব security নকশার জন্যই সত্যি: **প্রতিটা প্রতিরক্ষার একটা নির্দিষ্ট threat আছে।** "আমরা PKCE ব্যবহার করি" বলাটা নিরাপত্তার দাবি না, যতক্ষণ না বলছেন কোন আক্রমণের বিরুদ্ধে। আর তালিকার সব একসাথে লাগে, কারণ প্রতিটা আলাদা দরজা বন্ধ করে। OAuth এর নতুন সংস্করণ (OAuth 2.1 এর খসড়া) আর IETF এর OAuth Security BCP (RFC 9700) ঠিক এই চারটাকেই বাধ্যতামূলক করার দিকে যায়: সব client এ PKCE, exact redirect URI match, আর implicit flow বাদ (যেখানে token সরাসরি URL এ আসত)। এগুলো তাদের প্রকাশিত লেখা থেকে, এখানে যাচাই করা না।

অংশ খ তে এর দাম দেখা যায়: code এর মেয়াদ ৬০ সেকেন্ড, তাই ৯০ সেকেন্ড পরে আসা callback ব্যর্থ হয় (সব সেটে)। একটা ধীর phone, একটা ঘুমিয়ে পড়া tab, আর user কে আবার "login" চাপতে হয়। এই দাম ইচ্ছা করে দেওয়া হয়।

**ID token ≠ access token।** অংশ গ:

```
ID token (aud = taskflow-web)         API ignoring aud: 200   API checking aud: 401 aud mismatch
access token (aud = taskflow-api)     API ignoring aud: 200   API checking aud: 200
```

ID token TaskFlow এর **web app** কে বলে "এটা alice"। তার `aud` হলো client (`taskflow-web`)। এটা API এর দরজা খোলার চাবি না। কোনো API যদি `aud` না দেখে, তাহলে যেকোনো app এর জন্য বানানো যেকোনো ID token তার দরজা খোলে। এর মধ্যে এমন app ও আছে যেটা একই identity provider ব্যবহার করে, কিন্তু অন্য কারো। ১.২ এর তৃতীয় নিয়মেরই একটা রূপ।

### ১.৬ Secret - git এ যা গেছে, তা গেছে

মঙ্গলবার। `npm run secrets` অংশ ক তে একটা ছোট git history আর একটা secret scanner আছে। Scanner দুইভাবে চালানো হয়েছে, শুধু আজকের code এ আর পুরো history তে:

```
HEAD only (today's code):  2 findings
whole git history:         5 findings

commit    file                rule                            verdict
7f20b4d   .env                tfsk key pattern                 real - live payment key
7f20b4d   .env                SECRET/KEY = high entropy       real - the token signing secret
7f20b4d   .env                password in a URL                real - production DB
c08a5f2   package-lock.json   any long high-entropy string  false positive (lockfile hash)
c08a5f2   test/fixtures.ts    tfsk key pattern     test key - low risk, remove it anyway

real production secrets: 3 in history, 0 at HEAD - the "oops remove .env" commit deleted nothing
```

তিনটা শিক্ষা:

1. **Commit মোছে না।** `git rm .env` আর একটা নতুন commit শুধু আজকের snapshot থেকে file টা সরায়। আগের commit এর snapshot এ file টা চিরকাল থাকে, প্রতিটা clone এ, প্রতিটা fork এ, প্রতিটা CI cache এ। History ঘষে মুছে ফেলা যায় (`git filter-repo`), কিন্তু যারা আগে clone করেছে তাদের কপিতে থেকে যায়। তাই ফাঁসের পরে **প্রথম কাজ rotate**, মানে secret টা বাতিল করে নতুন একটা বানানো। History পরিষ্কার করা দ্বিতীয়, ঐচ্ছিক কাজ।
2. **শুধু HEAD scan করা একটা মিথ্যা নিশ্চয়তা।** HEAD এ যে দুটো পাওয়া গেল তার একটা false positive (lockfile এর hash), আরেকটা test key। আসল তিনটা আছে শুধু history তে।
3. **Scanner নিখুঁত না।** Pattern rule (`tfsk_live_…` এর মতো key এর নিজস্ব ধরন) নির্ভুল, কিন্তু শুধু জানা ধরন ধরে। Entropy rule অজানা secret ধরে, কিন্তু hash আর id এ false positive দেয়। বাস্তবের scanner (gitleaks, trufflehog, GitHub এর secret scanning) দুটোই মেলায়। আর কিছু provider এর সাথে চুক্তি থাকে, যাতে public repo তে তাদের key পাওয়া গেলে তারা নিজেরাই key বাতিল করে দেয়।

**ফাঁসের ক্ষতি কীসে কমে?** ক্ষতি = ফাঁস হওয়া secret কতদিন **কাজ করে**। অংশ খ তে ১,০০০টা ফাঁস চারটা চ্যানেলে (git, log, CI output, laptop)। ধরা পড়তে median ২০ দিন লাগে (ধরে নেওয়া সংখ্যা, নিচে দেখুন):

```
policy                          working leaks  median        p90   > 7 days  total attacker-days
static secret, never changes        1,000   19.1 days  117.3 days   76.6%             46,312
rotate every 90 days                1,000   13.5 days  54.5 days   70.5%             21,256
90 days + push protection               677   13.0 days  52.2 days   47.1%             14,010
dynamic credential (60 min lease)      1,000      30 min     54 min    0.0%                 21
```

৯০ দিনের rotation, যেটা অনেক compliance checklist চায়, মোট ক্ষতি অর্ধেক করে। কিন্তু median ফাঁস এখনও ১৩.৫ দিন কাজ করে, আর ৭০% ফাঁস এক সপ্তাহের বেশি। Rotation সাহায্য করে শুধু যদি তারিখটা ঘটনাক্রমে ধরা পড়ার আগে আসে। Push protection (git এ push এর মুহূর্তে secret ধরে push আটকানো, এখানে git এর ফাঁসের ৮০% ধরে) git এর পথটা অনেকখানি বন্ধ করে। কিন্তু log, CI, laptop এর পথ খোলা থাকে।

শেষ সারিটা অন্য জাতের। **Dynamic credential** হলো যে credential চাওয়ার মুহূর্তে বানানো হয়, ছোট একটা lease সহ (এখানে ৬০ মিনিট), আর lease শেষে নিজেই মরে। ধরুন worker চালু হওয়ার সময় secret manager কে বলে "আমাকে DB এর জন্য একটা user দিন"। Secret manager database এ সেই মুহূর্তে একটা user বানায়, এক ঘণ্টা পরে মুছে দেয়। এমন secret ফাঁস হলে তার **আয়ু কয়েক মিনিট**, ধরা পড়ুক বা না পড়ুক: মোট ২১ attacker-দিন, ৪৬,৩১২ এর বদলে। Experiment ৩ এ দেখুন: ধরা পড়া ২০ দিন থেকে ৩ দিন করলেও স্থির secret এ ৮,২৫৬ attacker-দিন হয়, আর rotation ৭ দিন করলে ৩,২৯৭। দুটোই এখনও dynamic এর ১৫০ গুণের বেশি।

নিয়মটা: **ফাঁস ধরার উপর ভরসা করবেন না, secret এর আয়ু ছোট করুন।** আরও ভালো হলো secret ই না থাকা। Cloud এ একটা service কে তার **পরিচয়** দিয়ে অনুমতি দেওয়া যায় (workload identity, যেমন AWS IAM role, GCP service account), তাহলে code এ কোনো key ই থাকে না। আর internal service এর মধ্যে mTLS (9.2) এর certificate ও স্বয়ংক্রিয়ভাবে ছোট আয়ুর হয়।

**একটা ভাঙা দেয়াল কতটা ক্ষতি করে।** অংশ গ: TaskFlow এর ছয়টা service, আর একটা service এর ভেতরে কেউ ঢুকলে কয়টা secret তার হাতে যায়:

```
got into  one shared .env  separate per service  what they got
gateway                    10                   2  no payment/DB
web-bff                    10                   2  no payment/DB
monolith                   10                   4  incl. DATABASE_URL
billing                    10                   4  incl. STRIPE_KEY
files                      10                   2  no payment/DB
worker                     10                   4  incl. DATABASE_URL
```

একটা ভাগ করা `.env` মানে যেকোনো service এ ঢুকলেই সব দশটা। আলাদা করলে ২–৪টা, আর ছয়টার তিনটায় payment বা DB এর key একদমই নেই। এটা 10.3 এর **blast radius** এর যুক্তি, নিরাপত্তায় প্রয়োগ। এর নাম **least privilege**: প্রতিটা অংশ ঠিক ততটুকু পায় যতটুকু তার কাজে লাগে।

**Secret manager** (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) এই সব কিছুর জায়গা। Secret code এ বা image এ না, চালু হওয়ার সময় service এর পরিচয় দিয়ে আনা হয়। প্রতিটা পড়া audit log এ যায়। Rotation আর dynamic credential এক জায়গায় চলে। আর একটা সূক্ষ্মতা: secret manager নিজেই একটা hard dependency হয়ে যায়। 10.3 এর static stability এখানেও প্রযোজ্য: service চালু থাকা অবস্থায় শেষ পাওয়া secret ধরে রাখুন, যাতে secret manager এর পাঁচ মিনিটের outage পুরো TaskFlow না থামায়।

### ১.৭ Credential Stuffing - দরজায় কোটি ধাক্কা, প্রতিটা আলাদা হাতে

শনিবার রাত। আক্রমণটা কেমন ছিল ভালো করে দেখুন, কারণ 9.5 এর rate limit ঠিক এই ধরনের আক্রমণের জন্য বানানো **মনে** হয়েছিল।

**Credential Stuffing** - অন্য site এর data breach থেকে পাওয়া কোটি কোটি (email, password) জোড়া নিয়ে স্বয়ংক্রিয়ভাবে নিজের site এ login চেষ্টা করা। এটা কাজ করে কারণ মানুষ একই password অনেক জায়গায় ব্যবহার করে। Brute force এর মতো এক account এ অনেক password চেষ্টা করা হয় না, **অনেক account এ একটা করে** চেষ্টা হয়। আর হাজার হাজার IP থেকে আসে (botnet, residential proxy), তাই প্রতি IP আর প্রতি account এর সীমার অনেক নিচে থাকে।

`npm run abuse` অংশ ক তে ১২ লাখ চেষ্টা, ৩৮,০০০ IP, ৬ ঘণ্টা। তালিকার ৩% email TaskFlow এ আছে, আর তাদের ১০% একই password ব্যবহার করে। সাথে একই সময়ে ২০,০০০ বৈধ login, যার ৩০% আসে ৪০টা office এর NAT এর পেছন থেকে:

```
5.3 attempts per IP per hour on average, once per email on average; the password really matches for 3,547 accounts on the list

policy                           bot reached password  takeovers     legit logins blocked  legit user friction  detected
no limits                               1,200,000         3,547          0 (0.0%)                  0          -
9.5: IP 20/h + email 10/h                     1,200,000         3,547        946 (4.7%)                  0          -
strict: IP 5/h + email 10/h                    853,658         2,532     4,484 (22.4%)                  0          -
9.5 + breached password check                1,200,000           531        946 (4.7%)              1,210          -
9.5 + failure ratio → challenge                123,183           395      1,104 (5.5%)              4,935     1 min
all + MFA (25% of users)                       123,183            46      1,104 (5.5%)              6,137     1 min
```

- **9.5 এর সীমা একটা চেষ্টাও আটকায়নি** (১২ লাখের ১২ লাখ password পর্যন্ত পৌঁছেছে)। প্রতি IP ঘণ্টায় ৫.৩, সীমা ২০। প্রতি email একবার, সীমা ১০। আর **বৈধ user আটকেছে ৯৪৬ জন**, সবাই office NAT এর পেছনে। সীমাটা ভুল লোকদের থামিয়েছে।
- **কঠোর করলে:** IP ঘণ্টায় ৫ করলে ১,০০০ এর মতো দখল কমে। কিন্তু বৈধ login এর **২২.৪%** আটকায়, মানে প্রায় প্রতি চারজন office user এর একজন। আর attacker এর জন্য সমাধান সস্তা: আরও IP ভাড়া করা। Experiment ১ এ দেখুন, ৫,০০০ IP দিয়ে (প্রতি IP ঘণ্টায় ৪০) 9.5 এর সীমা দখল ৩,৫৪৭ থেকে ১,৭৫৯ এ নামায়। সেটা একমাত্র অবস্থা যখন per-IP সীমা কাজ করে, আর সেই অবস্থা থেকে বেরোতে attacker এর এক বিকেল লাগে।
- **Breached password check:** login এর সময় password টা জানা breach এর তালিকায় আছে কিনা দেখা (যেমন Have I Been Pwned এর password range API। এতে পুরো password বা তার hash পাঠাতে হয় না, শুধু hash এর প্রথম ৫টা অক্ষর)। থাকলে login না দিয়ে password reset এ পাঠান। দখল ৩,৫৪৭ থেকে ৫৩১ এ নামে, কারণ attacker এর তালিকা মানেই breach এর তালিকা। দাম: ১,২১০ জন বৈধ user কে password বদলাতে হয়েছে। সেটা সত্যিই তাদের ভালোর জন্য।
- **Failure ratio এর detector:** এটা কোনো একজনকে দেখে না, **সামগ্রিক** অবস্থা দেখে। গত ১০ মিনিটে login এর ২৫% এর বেশি ব্যর্থ হলে চেনা না এমন device এর জন্য challenge (CAPTCHA বা এমন কিছু) চালু হয়। স্বাভাবিক দিনে ~৮% ব্যর্থ হয়। আক্রমণের সময় ৯০% এর বেশি, কারণ তালিকার বেশিরভাগ email এর account TaskFlow এ নেই। **১ মিনিটে ধরা পড়ে।** Bot এর ১২ লাখ থেকে ১.২৩ লাখ পৌঁছায়, দখল ৩৯৫। দাম: ৪,৯৩৫ জন বৈধ user challenge দেখেছে।
- **সব একসাথে + MFA:** দখল **৪৬**। MFA (দ্বিতীয় একটা প্রমাণ: phone এর code, authenticator app, passkey) থাকলে password মিললেও account যায় না। কিন্তু এখানে মাত্র ২৫% user এর MFA আছে, তাই বাকি ৪৬টা।

আর experiment ২ এর সতর্কবাণী: `BOT_SOLVE=0.5`, মানে CAPTCHA solving farm (মানুষ দিয়ে টাকার বিনিময়ে CAPTCHA সমাধান, এটা একটা আসল ব্যবসা)। Challenge এর সারিতে দখল ৩৯৫ থেকে ১,৭৯৬ এ উঠে যায়। কিন্তু breached password check এর সারি (৫৩১) একটুও বদলায় না। আর সব একসাথে + MFA এর সারি ৪৬ থেকে ১৯৯ এ ওঠে, যা challenge এর একার সারির চেয়ে অনেক নিচে। কারণ breached check আর MFA bot আর মানুষ চেনার উপর নির্ভর করে না। নির্ভর করে **password এর নিজের অবস্থার** উপর, তাই challenge পার হলেও তারা দাঁড়িয়ে থাকে।

শিক্ষা: **প্রতি-key এর সীমা (IP, email) একটা আক্রমণকারী থামায়, একটা বিতরণ করা আক্রমণ না।** বিতরণ করা আক্রমণ ধরতে সামগ্রিক সংকেত লাগে (failure ratio, নতুন device এর অনুপাত, একই password এর অনেক email এ চেষ্টা)। আর তাকে অকেজো করতে লাগে credential এর গুণমান: breached check, MFA, আর সবচেয়ে ভালো, passkey। Passkey তে চুরি করার মতো কোনো password ই থাকে না। আর সবকিছুর শেষে একটা কাজ যা কোনো সারিতে নেই: নতুন device থেকে login হলে user কে email দিন। ৪৬ জনের অনেকে সকালে নিজেরাই জানাবে।

### ১.৮ DDoS - কোন স্তর কোন বন্যা থামায়

**DDoS (Distributed Denial of Service)** - অনেক উৎস থেকে একসাথে traffic পাঠিয়ে একটা service কে বৈধ user দের জন্য অচল করা। দুটো মৌলিক ধরন আছে। **Volumetric** (network/L3–L4) আক্রমণ link এর bandwidth ভরে দেয় (যেমন UDP reflection, যেখানে খোলা DNS বা NTP server কে জাল উৎস দিয়ে প্রশ্ন করা হয়, আর তারা অনেক গুণ বড় উত্তর শিকারের কাছে পাঠায়)। **Application layer** (L7) আক্রমণ দেখতে বৈধ HTTP request এর মতো, কিন্তু server এর CPU, DB বা connection শেষ করে দেয়।

দুটোর প্রতিরক্ষা সম্পূর্ণ আলাদা। এটাই মূল কথা।

**Volumetric।** `npm run abuse` অংশ খ তে ৩০০ Gbps এর UDP reflection, origin এর link ১০ Gbps, বৈধ traffic ০.৮ Gbps:

```
design                                        reaches link  legit traffic arrives
origin directly on the internet              300.8 Gbps                3.3%
app rate limit at the origin                   300.8 Gbps                3.3%
behind anycast CDN/scrubbing                   0.8 Gbps              100.0%
CDN, but origin IP leaked (old DNS)      300.8 Gbps                3.3%
leaked IP + CDN allowlist on origin firewall  300.8 Gbps                3.3%
new origin IP, only through the CDN tunnel  0.8 Gbps              100.0%
```

দ্বিতীয় সারিটা দেখুন: **app এর rate limit কিছুই করে না।** Packet গুলো app পর্যন্ত পৌঁছানোর আগেই ১০ Gbps এর পাইপ ভরে গেছে। App এর limiter এর কাছে বৈধ আর অবৈধ দুই রকম request এর ৯৭% ই পৌঁছায় না। কাজের জিনিস হলো এমন একটা নেটওয়ার্ক যার ক্ষমতা আক্রমণের চেয়ে বড়। 4.5 এর **anycast** CDN একই IP শত শত জায়গা থেকে ঘোষণা করে, তাই আক্রমণ ভাগ হয়ে শত শত PoP এ পড়ে, প্রতিটা ছোট ভাগ শোষণ করে। আর UDP reflection এর মতো traffic যা HTTP ই না, সেটা edge এই ফেলে দেওয়া হয়।

কিন্তু চতুর্থ আর পঞ্চম সারি: **CDN কেবল তখনই রক্ষা করে যখন attacker origin কে খুঁজে পায় না।** পুরনো একটা DNS record, একটা email এর header, একটা subdomain যা CDN এর পেছনে নেই, এগুলো থেকে origin এর আসল IP বেরিয়ে আসে। তখন attacker সরাসরি origin এ মারে। আর origin এর firewall এ "শুধু CDN এর IP allow করুন" নিয়ম থাকলেও লাভ নেই, কারণ firewall তো link এর **ভেতরের** দিকে। Packet ফেলার আগে সেগুলো পাইপ পেরিয়ে আসতে হয়। একমাত্র পথ শেষ সারিটা: origin এর IP বদলান, আর origin কে এমনভাবে বানান যাতে সে internet থেকে কোনো connection ই নেয় না। শুধু CDN এর দিকে একটা বের-হওয়া tunnel থাকে (যেমন Cloudflare Tunnel), বা cloud provider এর private link।

**L7।** অংশ গ: public share page `/s/:token`, ২০,০০০ IP × সেকেন্ডে ৩টা, origin এর ক্ষমতা সেকেন্ডে ২,০০০:

```
design                                         req/s at origin  legit requests ok
nothing                                              60,400              3.3%
per-IP 10 req/s                                                      60,400               3.3%
CDN cache (60 s, 300 PoPs), attacker with 5 real tokens   105            100.0%
CDN cache, but busted with ?x=random           60,080              3.3%
normalized cache key (unknown query dropped)            105            100.0%
challenge at the edge (5% of bots pass), no cache      3,400             58.8%
```

- **Per-IP সীমা আবার অকেজো।** প্রতি IP সেকেন্ডে ৩টা, সীমা ১০। ১.৭ এর একই গল্প। বিতরণ করা আক্রমণ প্রতি-key এর সীমার নিচে থাকে।
- **CDN cache এর শক্তি বিশাল।** Attacker এর হাতে ৫টা আসল share token। CDN প্রতিটা page প্রতিটা PoP এ ৬০ সেকেন্ডে একবার origin থেকে আনে, তাই ৫ × ৩০০ ÷ ৬০ = সেকেন্ডে ২৫টা। বৈধ traffic এর ৮০% ও cache থেকে যায়। ৬০,৪০০ থেকে ১০৫।
- **কিন্তু রবিবার:** `?x=এলোমেলো`। Cache key এ পুরো URL ধরা হয়, তাই প্রতিটা request একটা নতুন key, প্রতিটা miss। ১০৫ থেকে আবার ৬০,০৮০। এটা 4.6 এর cache penetration এর ভাই, এবার ইচ্ছাকৃত। প্রতিকার **cache key normalization**: share page যে query parameter চেনে না, সেটা cache key থেকে বাদ দিন (বা request টাই প্রত্যাখ্যান করুন)। আবার ১০৫।
- **Edge এ challenge:** cache করা যায় না এমন page এর জন্য edge এ একটা challenge বা bot score (JavaScript challenge, proof-of-work)। এখানে bot এর ৫% পার হয়, তবু ৩,৪০০ req/s, ক্ষমতার বেশি। ৫৮.৮% সফল, অর্ধেক বাঁচানো। Challenge একা যথেষ্ট না যখন আক্রমণ ক্ষমতার ত্রিশ গুণ।

শিক্ষা: **DDoS এর প্রতিরক্ষা app এর ভেতরে না, তার সামনে।** Volumetric থামায় এমন একটা network যা আক্রমণের চেয়ে বড়, আর যার পেছনের origin খুঁজে পাওয়া যায় না। L7 থামায় cache (সবচেয়ে সস্তা request হলো যেটা origin এ আসে না), cache key এর শৃঙ্খলা, আর edge এর সংকেত (bot score, challenge, WAF এর নিয়ম, edge এর rate limit, যা হাজার PoP এর তথ্য একসাথে দেখে)। App এর নিজের rate limit (9.5) থাকে **তার পেছনে**, শেষ স্তর হিসেবে, প্রতি user আর প্রতি tenant এর ন্যায্যতার জন্য। বন্যা থামানোর জন্য না। আর একটা জিনিস যা কোনো সারিতে নেই: autoscaling দিয়ে L7 বন্যা "শোষণ" করার চেষ্টা কাজ করতে পারে, কিন্তু মাসের শেষে bill আসে। 10.7 এ আবার দেখব।

(এই model টা একটা সরল fluid model। ক্ষমতার বেশি load এলে সবাইকে সমান ভাগে ফেলে। আসল overload এ queue, timeout আর retry এর ঝড় (7.4) ফলকে আরও খারাপ করে।)

### ১.৯ TaskFlow এর সিদ্ধান্ত

> **Trade-off Table - কোন আক্রমণ, কোন স্তর, কী দাম**

| আক্রমণ / ঝুঁকি          | যা কাজ করে                                                        | যা কাজ করার ভান করে                 | দাম                                                               |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| জাল / ভুল জায়গার JWT   | Algorithm allowlist, trusted key ring, `iss`/`aud`/`exp`, library | Signature মেলানো একা                | কিছুই না - শুধু শৃঙ্খলা                                           |
| BOLA                    | Data পড়ার পথে authorization, route × actor matrix test           | UUID একা, token এর `role`           | প্রতিটা query তে membership এর শর্ত                               |
| চুরি / revoke করা token | ছোট access token + refresh rotation + reuse detection + denylist  | লম্বা stateless JWT                 | Identity এর চাপ, denylist এর state                                |
| OAuth code চুরি / টোপ   | State + PKCE (S256) + exact redirect + single-use, ছোট মেয়াদ     | যেকোনো একটা একা                     | ধীর callback ব্যর্থ                                               |
| ফাঁস হওয়া secret       | ছোট আয়ু (dynamic credential, workload identity), service ধরে ভাগ | ৯০ দিনের rotation একা, history মোছা | Secret manager একটা নতুন hard dependency                          |
| Credential stuffing     | Failure ratio → challenge, breached password check, MFA / passkey | Per-IP / per-email সীমা কঠোর করা    | বৈধ user এর ঝামেলা (challenge, reset)                             |
| Volumetric DDoS         | Anycast CDN / scrubbing, লুকানো origin (শুধু tunnel)              | App rate limit, origin এর firewall  | CDN এর খরচ, CDN নিজেই একটা dependency                             |
| L7 DDoS                 | CDN cache + cache key normalization, edge এ bot score / challenge | Per-IP সীমা, autoscaling            | Cache এর মেয়াদের জন্য পুরনো data, challenge এ বৈধ user এর ঝামেলা |

**পরিচয় (AuthN):** Access token RS256, ১৫ মিনিট, `jose` দিয়ে যাচাই: algorithm এর allowlist, JWKS শুধু config এর URL থেকে (token এর `jku` কখনো না), `iss`, `aud` (প্রতিটা API এর নিজের), `exp`, ৬০ s skew। Token এ শুধু `sub`, `jti`, `sid`, কোনো role না। Refresh token opaque, ৩০ দিন, ১২ ঘণ্টা idle timeout, rotation + reuse detection (পুরো পরিবার বাতিল + security alert + user কে email)। Database এ শুধু তার hash। Web এ token browser এ যায় না: SvelteKit BFF এর `HttpOnly; Secure; SameSite=Lax` session cookie, আর state বদলানো request এ CSRF token। Denylist: logout, password বদল, account disable এ identity প্রতিটা gateway instance এ push করে (৫ s)। Identity মরলে শেষ পাওয়া তালিকা নিয়ে চলে (10.3)। Key rotation: নতুন key ২৪ ঘণ্টা আগে JWKS এ, পুরনো key শেষ token মরার পরে সরানো। আর gateway এর config এ একটা "নিষিদ্ধ `kid`" এর তালিকা, যা identity ছাড়াই deploy করা যায় (10.3 এর প্রশ্ন ২)।

**Authorization (AuthZ):** প্রতিটা service নিজে, data পড়ার পথে: `loadBoardFor(user, id)` এর মতো scoped loader, model এ সরাসরি `findByPk` lint দিয়ে নিষেধ। Role আসে `Membership` (user × workspace) থেকে। অন্যের object এ 404। CI তে route × actor matrix test, route এর তালিকা থেকে নিজে তৈরি। নতুন route এর প্রত্যাশিত ফল না লিখলে merge হবে না। Public id UUID। Export, delete, share-link তৈরি audit log এ যায় (কে, কোন workspace, কতগুলো)। আর একটা metric: এক user এক ঘণ্টায় কতগুলো **আলাদা** board এ 404 পেয়েছে (10.4 এর মতো, log থেকে)। Mallory এর script এর মতো কিছু এক ঘণ্টায় ধরা পড়ত।

**OAuth / OIDC:** "Google দিয়ে login" আর public API এর integration, দুটোই authorization code + PKCE (S256), `state`, exact redirect URI এর নিবন্ধন, ৬০ s এর single-use code, implicit flow নেই। ID token শুধু web app এর login এ, API এ কখনো না (API এর `aud` আলাদা)। Integration এর token এর scope ছোট (`tasks:read`) আর workspace এ সীমিত।

**Secret:** সব secret একটা secret manager এ। Service তার workload identity দিয়ে চালু হওয়ার সময় আনে, প্রতিটা পড়া audit log এ। প্রতিটা service শুধু নিজেরটা (এখন ২–৪টা, আগে ১০টা)। DB এর credential dynamic (১ ঘণ্টার lease)। Stripe key restricted, শুধু billing এ। Git এ push protection আর CI তে পুরো history এর scan। Log এ `Authorization`, `Cookie`, `Set-Cookie` header আর body কখনো না: 10.4 এর field allowlist, এবার CI তে test সহ। Runbook এর প্রথম লাইন: "Secret ফাঁস? আগে rotate, তারপর প্রশ্ন।"

**Login:** 9.5 এর সীমা থাকছে (সস্তা, একক attacker থামায়), কিন্তু চেনা office NAT এর জন্য per-IP সীমা উঁচু। তার উপরে সামগ্রিক failure ratio এর detector, যা চেনা না এমন device এ challenge চালু করে। Login আর sign-up এ breached password check। Admin আর billing এর role এ MFA বাধ্যতামূলক, সবার জন্য passkey এর প্রস্তাব। নতুন device থেকে login হলে email।

**DDoS:** সব traffic একটা anycast CDN এর পেছনে, WAF আর edge এর rate limit সহ। Origin এর IP বদলানো, পুরনো DNS record পরিষ্কার, origin শুধু CDN এর tunnel দিয়ে পৌঁছানো যায়। Share page cacheable (৬০ s), cache key এ শুধু path, অজানা query বাদ। Login আর sign-up এ edge এর bot score। Autoscaling এর একটা উপরের সীমা, যাতে বন্যা bill এ না গড়ায়।

---

## ২. Interview Angle

Security প্রায় কখনো আলাদা প্রশ্ন হয় না। আসে design এর ভেতরে: "how do you authenticate users?", "এই API কি multi-tenant safe?", "কেউ এটা DDoS করলে?" দুর্বল উত্তর হলো "JWT ব্যবহার করব, আর Cloudflare।" ভালো উত্তরের আকৃতি:

1. **AuthN আর AuthZ আলাদা করে বলুন।** "Gateway এ token যাচাই (একবার), কিন্তু authorization প্রতিটা service এ, data এর কাছে, প্রতিটা object এ।" এই এক লাইনেই অনেক candidate থেকে আলাদা হয়ে যাবেন।
2. **Token এর জীবনচক্র।** ছোট access token, refresh token rotation, revoke কীভাবে হয়। প্রায় নিশ্চিত follow-up: "JWT stateless, তাহলে logout কীভাবে?"
3. **Multi-tenant এ data isolation।** প্রতিটা query তে tenant এর শর্ত, আর সেটা কীভাবে নিশ্চিত করবেন (scoped repository, Postgres row-level security, test)।
4. **হুমকি ধরে স্তর।** Edge এ (CDN, WAF, DDoS), সীমানায় (gateway: AuthN, rate limit), service এ (AuthZ), data এ (encryption, least privilege)। প্রতিটা স্তরে বলুন কোন হুমকি থামায়।

**যে follow-up গুলো প্রায় নিশ্চিত:**

- _"JWT নাকি session?"_ - দুটোই এক প্রশ্নের দুই প্রান্ত: revoke এর গতি বনাম প্রতি request এ lookup। বাস্তবে মাঝখানে: ছোট JWT + refresh + denylist। সংখ্যা দিন: ২৪ ঘণ্টার JWT revoke এর পরে গড়ে ১৯.৬ ঘণ্টা চলে, ১৫ মিনিটের টা ৪.৮ মিনিট, denylist দিয়ে ৫ সেকেন্ড।
- _"JWT এ কী রাখবেন?"_ - পরিচয় (`sub`), মেয়াদ, `aud`। Permission না (বদলায়, আর tenant ধরে আলাদা), গোপন কিছু না (payload পড়া যায়)।
- _"OAuth এ PKCE কেন?"_ - চুরি হওয়া code কে অকেজো করে। আর বলুন কী **থামায় না**: redirect URI এর টোপ। সেটার জন্য exact match।
- _"Rate limit দিয়ে DDoS থামাবেন?"_ - না। Volumetric app এ পৌঁছানোর আগেই link ভরে দেয়। Edge এ (anycast CDN / scrubbing) আর লুকানো origin। L7 এ cache আর bot সংকেত। App এর rate limit ন্যায্যতার জন্য।
- _"Password ফাঁস / credential stuffing?"_ - Per-IP সীমা বিতরণ করা আক্রমণে অন্ধ। সামগ্রিক failure ratio, breached password check, MFA / passkey।

**Production এ বাস্তবে:** সবচেয়ে সাধারণ ভুলগুলো হলো নিজের লেখা JWT verifier, বা library কে algorithm না বলে দেওয়া। Authorization route এ, data এর পথে না, তাই নতুন route এ ভুলে যাওয়া। Token এর `role` বা client এর পাঠানো `tenant_id` বিশ্বাস করা। লম্বা মেয়াদের token, revoke নেই। Token আর secret log এ। `.env` কে "মুছে" ফেলা ভাবা, rotate না করা। সব service এর জন্য একটা `.env`। Login এ শুধু per-IP সীমা। CDN এর পেছনে থেকেও origin এর IP প্রকাশ্য। আর query string দিয়ে cache ভাঙতে দেওয়া।

---

## ৩. Key Takeaway

- **AuthN একবার, সীমানায়; AuthZ প্রতিটা object এ, data এর কাছে।** সোমবারের ৫৯,৯৭০টা board এর ফাঁস হয়েছে বৈধ token দিয়ে। ভুল ছিল দুটো route এ, একটায় check নেই আর একটায় token এর `role` বিশ্বাস করা হয়েছিল
- **JWT কীভাবে যাচাই হবে, সেটা server ঠিক করে, token না।** Naive verifier আটটার ছয়টা নেয়, তার দুটো জাল admin (`alg: none`, RS256→HS256)। Allowlist, trusted key ring, `iss`/`aud`/`exp`, আর পরীক্ষিত library
- **UUID enumeration থামায়, authorization না।** দশ লাখ অনুমানে শূন্য, ফাঁস হওয়া ৩৪০টা id এর ৩৪০টাই কাজ করে। Scoped loader আর route × actor matrix test (ঠিক সেই তিনটা ঘর ধরে)
- **Token এর মেয়াদ একটা knob যা revoke এর দেরি, identity এর চাপ আর outage সহ্য করা একসাথে ঘোরায়।** Denylist এগুলোকে আলাদা করে (৫ s revoke, ১৫ মিনিট outage সহ্য)। শুধু refresh rotation চোরকে না, alice কে বের করে দেয়। Reuse detection ২৯.৬ দিনকে ১৫ মিনিট বানায়
- **OAuth এর প্রতিটা প্রতিরক্ষার নিজের আক্রমণ আছে।** State থামায় login CSRF, PKCE থামায় চুরি হওয়া code, আর redirect এর টোপ থামায় শুধু exact match। ID token API এর চাবি না
- **Git এ যা গেছে তা গেছে, তাই আগে rotate।** ফাঁসের ক্ষতি কমায় secret এর আয়ু: স্থির secret এ ৪৬,৩১২ attacker-দিন, ৯০ দিনের rotation এ ২১,২৫৬, dynamic credential এ ২১। Service ধরে ভাগ করলে blast radius ১০ থেকে ২–৪
- **বিতরণ করা আক্রমণ প্রতি-key এর সীমার নিচে থাকে।** 9.5 এর সীমা ১২ লাখের একটাও আটকায়নি, আটকেছে ৯৪৬ জন বৈধ user। সামগ্রিক failure ratio + breached check + MFA দখল ৩,৫৪৭ থেকে ৪৬ এ নামায়। Volumetric DDoS এ app এর rate limit অর্থহীন, বাঁচায় anycast আর লুকানো origin। L7 এ বাঁচায় cache, যদি cache key কে ভাঙতে না দেন

---

## ৪. নতুন Term (Glossary)

| Term                               | অর্থ                                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication / Authorization** | AuthN প্রমাণ করে request কে পাঠিয়েছে; AuthZ ঠিক করে সেই পরিচয় এই resource এ এই কাজ করতে পারে কিনা। AuthN সীমানায় একবার হতে পারে, AuthZ প্রতিটা object এ, data এর কাছে                                                           |
| **JWT (JSON Web Token)**           | `header.payload.signature`, base64url এ। Header এ `alg` আর `kid`, payload এ claim (`sub`, `iss`, `aud`, `exp`)। Signed, encrypted না। যাচাইয়ের algorithm আর key server ঠিক করে, token না                                          |
| **BOLA**                           | Broken Object Level Authorization (পুরনো নাম IDOR): API object এর id নেয়, user authenticated কিনা দেখে, কিন্তু এই object এ তার অনুমতি আছে কিনা দেখে না। OWASP API Top 10 এর এক নম্বর                                              |
| **Refresh Token Rotation**         | ছোট মেয়াদের access token + লম্বা মেয়াদের opaque refresh token। প্রতি refresh এ নতুন refresh token আসে, পুরনোটা মরে, আর পুরনোটা আবার এলে (reuse) পুরো পরিবার বাতিল হয়                                                            |
| **OAuth 2.0 + PKCE / OIDC**        | OAuth: user এর হয়ে সীমিত অনুমতি, password ছাড়া (access token)। OIDC: তার উপরে পরিচয় (ID token)। Authorization code flow এ PKCE চুরি হওয়া code কে অকেজো করে, state থামায় login CSRF, exact redirect থামায় redirect এর টোপ     |
| **Credential Stuffing**            | অন্য site এর breach এর (email, password) জোড়া দিয়ে বিতরণ করা, স্বয়ংক্রিয় login চেষ্টা। অনেক account এ একটা করে, হাজার IP থেকে, তাই প্রতি-key এর সীমার নিচে থাকে                                                                |
| **DDoS (Volumetric / L7)**         | অনেক উৎস থেকে traffic দিয়ে service অচল করা। Volumetric link এর bandwidth ভরে (থামায় anycast CDN / scrubbing আর লুকানো origin); L7 বৈধ দেখতে request দিয়ে server শেষ করে (থামায় cache, cache key এর শৃঙ্খলা, edge এর bot সংকেত) |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন। প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এ একটা নতুন feature এলো: "guest" user, যাকে একটা workspace এর **একটা নির্দিষ্ট project** এর board গুলো দেখার অনুমতি দেওয়া যায়, বাকি workspace না। (ক) `loadBoardFor` আর `Membership` কীভাবে বদলাবেন? Role কি এখনও token এ আসবে না, আর কেন? (খ) Matrix test এ কোন নতুন actor আর কোন নতুন ঘর যোগ করবেন? অন্তত তিনটা এমন ঘর লিখুন যেখানে ভুল হওয়ার সম্ভাবনা বেশি। (গ) একজন guest এর অনুমতি সরিয়ে নেওয়া হলো। তার হাতে ১৫ মিনিটের access token আছে। সে আর কতক্ষণ board দেখতে পারবে, এই lesson এর নকশায়? Denylist কি এখানে লাগে?

2. TaskFlow এর mobile app এ "Google দিয়ে login" আসছে। Mobile app একটা **public client**, মানে তার ভেতরে রাখা যেকোনো secret যে কেউ app টা খুলে বের করতে পারে। (ক) Web এর client secret এর মতো কিছু mobile এ কেন রাখা যায় না, আর PKCE কীভাবে সেই অভাব পূরণ করে? (খ) Callback এর জন্য custom URL scheme (`taskflow://callback`) এর বদলে কেন HTTPS এর "app link" / "universal link" ভালো? ১.৫ এর কোন আক্রমণ এখানে আসল? (গ) Phone এ refresh token কোথায় রাখবেন, আর phone চুরি হলে user কীভাবে সেটা বাতিল করবে?

3. বৃহস্পতিবার বিকেলে একজন engineer ভুলে একটা public GitHub gist এ billing service এর config paste করল। তাতে আছে `STRIPE_KEY`, `BILLING_DB_URL` (dynamic না, স্থির password), আর `INTERNAL_SIGNING_KEY` (9.2 এর internal token sign করার key, সব service এ এক)। ২০ মিনিট পরে কেউ খেয়াল করল। (ক) পরের এক ঘণ্টার runbook লিখুন, ক্রম সহ। কোনটা আগে, আর কেন? (খ) `INTERNAL_SIGNING_KEY` বদলানো কেন বাকি দুটোর চেয়ে কঠিন, আর এর মধ্যে কোন service গুলো একে অপরের token প্রত্যাখ্যান করতে পারে? এটা কীভাবে নিরাপদে করবেন? (গ) এই ঘটনা থেকে নকশায় কোন দুটো জিনিস বদলাবেন, যাতে পরের বার একই ভুলের ক্ষতি অনেক কম হয়?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) অনুমতি এখন আর শুধু "user × workspace" না, "user × workspace **বা** user × project"। `Membership` এ একটা `scope` যোগ হয়: `{ userId, workspaceId, projectId: null, role }` হলো পুরো workspace এর member, আর `{ userId, workspaceId, projectId: 'p-17', role: 'guest' }` হলো শুধু একটা project। `loadBoardFor` এর শর্ত হয়:

```
board.workspaceId ∈ (যেসব workspace এ user পুরো member)
OR
board.projectId ∈ (যেসব project এ user guest)
```

আর **কাজ ধরে** আলাদা করা লাগে। Guest পড়তে পারে, কিন্তু board মুছতে, export করতে, share-link বানাতে পারে না। তাই loader টা `loadBoardFor(user, id, action)` হয়, অথবা load এর পরে একটা `can(user, action, board)` থাকে যা membership এর role থেকে উত্তর দেয়।

Role token এ আসবে না, আর এখানে কারণটা আরও স্পষ্ট। একজন user একটা workspace এ admin, আরেকটায় member, তৃতীয়টার একটা project এ guest হতে পারে। একটা token এ এগুলো রাখলে token বড় হয়। আরও খারাপ, অনুমতি বদলালে token এর মেয়াদ শেষ না হওয়া পর্যন্ত পুরনো অনুমতি চলে (প্রশ্ন গ)। Token এ পরিচয় থাকে, অনুমতি থাকে database এ।

(খ) নতুন actor: "একই workspace এর অন্য project এর guest", "এই project এর guest", "guest যার অনুমতি সরানো হয়েছে"। ভুলের সবচেয়ে সম্ভাব্য ঘর:

- **অন্য project এর guest × `GET /boards/:id`** (একই workspace)। এখানে প্রত্যাশা 404। একটা ভুল loader যা শুধু `workspaceId` দেখে, সে 200 দেবে, কারণ guest টা "এই workspace এর সাথে সম্পর্কিত"।
- **এই project এর guest × `GET /boards/:id/export`** আর **× `POST /boards/:id/share-link`**। প্রত্যাশা 403/404। এগুলো "পড়ার মতো" দেখায়, কিন্তু export এ পুরো data যায়, আর share-link guest এর অনুমতিকে public করে দেয়, অর্থাৎ guest নিজের অনুমতি অন্যকে বিলাতে পারে।
- **এই project এর guest × `GET /workspaces/:id/members`** বা activity feed। Workspace এর তালিকা ধরনের route, যা object এর id নেয় না কিন্তু workspace এর id নেয়, আর সাধারণত "member হলেই দেখান" লেখা থাকে। List route এ BOLA এর রূপ হলো "তালিকায় অন্য project এর board এর নাম ফাঁস"।

আর matrix test এর একটা নিয়ম যোগ হয়: list route এ শুধু status code না, **উত্তরের ভেতরে কোন id আছে** সেটাও দেখুন।

(গ) `loadBoardFor` প্রতি request এ `Membership` database থেকে পড়ে, token থেকে না। তাই অনুমতি সরানোর **পরের request থেকেই** guest 404 পায়। Access token এর ১৫ মিনিট এখানে কোনো ভূমিকা রাখে না, কারণ token শুধু বলে "এটা guest-42", আর guest-42 এর আর অনুমতি নেই। **Denylist এখানে লাগে না।** Denylist লাগে যখন পরিচয়টাই বাতিল করতে হয় (account disable, logout, চুরি)। অনুমতি বদলের জন্য না। এটাই role কে token এর বাইরে রাখার সবচেয়ে বড় লাভ। (সতর্কতা: যদি `Membership` এর উপর একটা cache বসান, 4.3 এর মতো, তাহলে সেই cache এর TTL ই revoke এর দেরি। অনুমতি সরানোর সময় cache টা invalidate করুন।)

**প্রশ্ন ২:**

(ক) Web এ TaskFlow এর server এর কাছে একটা client secret থাকে, আর `/token` এ code redeem করার সময় সেটা দেখাতে হয়। তাই চুরি হওয়া code কেউ redeem করতে পারে না, কারণ তার secret নেই। Mobile app এর binary যে কেউ নামিয়ে খুলতে পারে, তাই তার ভেতরের যেকোনো "secret" আসলে public। Authorization server জানে এটা public client, তাই secret চায় না। PKCE এই অভাব পূরণ করে **প্রতি login এ একটা নতুন, এক-বারের secret** দিয়ে। Verifier টা login শুরুর মুহূর্তে phone এ এলোমেলোভাবে তৈরি হয়, phone এর memory তে থাকে, আর URL দিয়ে যায় শুধু তার hash। App এ কিছু লুকাতে হয় না। প্রতিটা login নিজেই নিজের secret বানায়।

(খ) Custom URL scheme (`taskflow://`) কোনো একটা app এর মালিকানায় থাকে না। একই phone এ অন্য একটা app ও `taskflow://` নিবন্ধন করতে পারে, আর OS যেকোনো একটাকে callback দিতে পারে। এটাই ১.৫ এর **code চুরি** এর আক্রমণ ("mobile scheme")। এটা থামায় PKCE (চোরের কাছে verifier নেই)। HTTPS এর app link / universal link এ OS যাচাই করে যে domain টা (`app.taskflow.test`) সত্যিই এই app কে callback দেওয়ার অনুমতি দিয়েছে (domain এ রাখা একটা file দিয়ে)। তাই অন্য app সেটা দাবি করতে পারে না। দুটো একসাথে: app link code কে ভুল জায়গায় যেতেই দেয় না, আর PKCE গেলেও তাকে অকেজো করে। আর exact redirect URI এর নিবন্ধনও এখানে প্রযোজ্য।

(গ) Phone এর OS এর secure storage এ: iOS এর Keychain, Android এর Keystore দিয়ে encrypt করা storage। সাধারণ file বা app এর preference এ না, যাতে backup বা অন্য app এর হাতে না যায়। আর যদি সম্ভব হয়, refresh token কে device এর একটা key এর সাথে বাঁধা (DPoP), যাতে কপি করা token অন্য device এ অকেজো হয়। Phone চুরি হলে: TaskFlow এর web এ "সক্রিয় device" এর একটা তালিকা থাকে (প্রতিটা refresh token পরিবার = একটা device), user সেখান থেকে "এই device logout" চাপে। তাতে সেই পরিবার বাতিল হয় আর তার access token এর `sid` denylist এ যায়। Password বদলালে সব পরিবার বাতিল হয়।

**প্রশ্ন ৩:**

(ক) ক্রম ঠিক হয় **ক্ষতির গতি আর বিপরীতযোগ্যতা** দিয়ে। প্রশ্ন হলো কোনটা দিয়ে attacker সবচেয়ে দ্রুত, সবচেয়ে অপরিবর্তনীয় ক্ষতি করতে পারে:

1. **মিনিট ০–৫: `STRIPE_KEY` revoke + নতুন key।** টাকা সরে গেলে ফেরানো কঠিন (মঙ্গলবারের refund)। Stripe এর dashboard এ রোল করা এক click। নতুন key secret manager এ দিয়ে billing restart। কয়েক মিনিট payment ব্যর্থ হতে পারে, সেটা মেনে নিন।
2. **মিনিট ৫–১৫: `BILLING_DB_URL` এর password বদলানো।** Billing এর database এ নতুন password, তারপর billing restart, তারপর পুরনো password বাতিল। এর মধ্যে database এর audit log দেখুন: অচেনা IP থেকে connection হয়েছে কি? Database টা private network এ থাকলে (থাকা উচিত) internet থেকে এই password দিয়ে কিছু হয় না। কিন্তু সেটা ধরে নিয়ে দেরি করবেন না।
3. **মিনিট ১৫–৬০: `INTERNAL_SIGNING_KEY`।** এটা দিয়ে attacker যেকোনো user হিসেবে internal token বানাতে পারে। কিন্তু সেটা কাজে লাগাতে তাকে **ভেতরের network এ** পৌঁছাতে হবে (9.2: service গুলো private, gateway client এর internal header ফেলে দেয়)। তাই এটা সবচেয়ে বিপজ্জনক key, কিন্তু সবচেয়ে কম তাৎক্ষণিক। আর এটাই সবচেয়ে কঠিন (খ)।
4. সমান্তরালে: gist মোছা (GitHub এর কাছে cache মোছার অনুরোধ সহ), কে কখন gist দেখেছে বা fork করেছে তার খোঁজ, আর security channel এ ঘোষণা। Gist মোছা **তালিকার শেষে**, rotate এর পরে, কারণ ২০ মিনিট public থাকা মানে কপি হয়ে গেছে বলে ধরে নিতে হবে।

(খ) Stripe key আর DB password একটা জায়গায় (billing) ব্যবহার হয়। `INTERNAL_SIGNING_KEY` **ছয়টা service** এ। Gateway এটা দিয়ে sign করে, বাকি সবাই যাচাই করে। একসাথে বদলালে deploy এর কয়েক মিনিটে কিছু instance নতুন key দিয়ে sign করবে আর কিছু instance এখনও পুরনো key দিয়ে যাচাই করবে, বা উল্টো। ফলে সব জায়গায় 401। নিরাপদ পথ হলো ১.২ এর key rotation, `kid` সহ:

1. সব service এ যাচাইয়ের জন্য **দুটো** key রাখুন (পুরনো আর নতুন, `kid` দিয়ে আলাদা)। Deploy।
2. Gateway কে নতুন key দিয়ে sign করান। Deploy।
3. ৬০ s পরে (internal token এর মেয়াদ) সব service থেকে পুরনো key সরান। Deploy।

এটা যত দ্রুত সম্ভব করুন, কারণ পুরনো key যতক্ষণ যাচাই এ থাকে, attacker এর বানানো token ও ততক্ষণ চলে। আর ভবিষ্যতের জন্য: ভাগ করা symmetric key (HMAC) মানে প্রতিটা service ই sign করতে পারে, শুধু gateway না। Asymmetric key (gateway এর private key, বাকিদের কাছে শুধু public key) হলে service গুলোর কাছে থাকা key ফাঁস হলে কেউ token বানাতে পারে না। ফাঁস হলে বদলাতে হয় শুধু gateway এর private key টা।

(গ) দুটো বদল:

- **Static secret কে স্বল্পায়ু বানানো।** `BILLING_DB_URL` dynamic credential হবে (১ ঘণ্টার lease)। তাহলে ফাঁস হলেও ১ ঘণ্টায় মরে, আর কাউকে কিছু করতে হয় না। Internal token এর signing key asymmetric হবে, আর সেটা gateway এর বাইরে কারো কাছে থাকবে না। Stripe key এর বদলে restricted key, শুধু billing এর যতটুকু দরকার (refund এর অনুমতি আলাদা key এ)।
- **Config কে secret থেকে আলাদা করা।** Engineer config paste করেছিল কারণ config আর secret এক file এ ছিল। Secret secret manager এ থাকলে config এ শুধু তাদের **নাম** থাকে (`STRIPE_KEY_REF=billing/stripe`), মান না। Paste করলে ক্ষতি নেই। সাথে company এর GitHub org এ secret scanning (public gist সহ, যেখানে provider সরাসরি জানায়)।

আর একটা তৃতীয় জিনিস প্রায় সবসময় postmortem এ আসে: ২০ মিনিটে কেউ খেয়াল করেছিল, ভালো কথা। কিন্তু runbook না থাকলে প্রথম ২০ মিনিট যায় "কী করব" ঠিক করতে। এই প্রশ্নের (ক) টাই runbook।

</details>

---

## ৬. Practical Exercise

**Tier 1 - Runnable Code** (পাঁচটা deterministic script; কোনো network, identity provider, CDN বা Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.5-security-jwt-oauth-ddos/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.5-security-jwt-oauth-ddos) - `npm install`, তারপর `npm run authz`, `npm run sessions`, `npm run oauth`, `npm run secrets`, `npm run abuse`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

`authz` এ আসল RS256 token দিয়ে naive আর strict verifier, ৬০,০০০ board এ BOLA এর scan, UUID বনাম ফাঁস হওয়া id, আর route × actor matrix test। `sessions` এ ৬০,০০০ session এর ৮ ঘণ্টা ছয়টা token নীতিতে চলে (revoke এর দেরি, identity এর চাপ, outage সহ্য করা), সাথে refresh token চুরির দুটো দৃশ্য। `oauth` এ একটা authorization server আর client আছে, চারটা আক্রমণ × পাঁচটা প্রতিরক্ষার সেট, আর ID token বনাম access token। `secrets` এ একটা ছোট git history এ secret scanner, ১,০০০টা ফাঁসের আয়ু চারটা নীতিতে, আর service ধরে secret এর ভাগ। `abuse` এ ১২ লাখ চেষ্টার credential stuffing ছয়টা নীতিতে, volumetric আর L7 flood।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` clean, পাঁচটা script দুবার করে, output byte ধরে হুবহু এক। README এর experiment ১, ২, ৩ আর ৪ চালানো হয়েছে, আর lesson এ যে সংখ্যা quote করা হয়েছে (১,৭৫৯, ১,৭৯৬, ৮,২৫৬, ৩,২৯৭) সেগুলো সেখান থেকে। ৫ আর ৬ code বদলানোর কাজ, আপনার। **সব script in-memory।** JWT গুলো আসল (Node এর `node:crypto` এ RS256, প্রতি run এ নতুন RSA key), কিন্তু verifier নিজের হাতে লেখা, শুধু দেখানোর জন্য কোথায় ভাঙে। OAuth এর server আর client একটা process এর দুটো class, HTTP redirect নেই। **ধরে নেওয়া সংখ্যা**, যা model এর input, মাপা না: তালিকার ৩% email TaskFlow এ আছে আর তাদের ১০% একই password ব্যবহার করে; ২৫% user এর MFA; breach এর তালিকা আসল password এর ৮৫% জানে; challenge এ bot ১০% পার হয়, মানুষ ৯৭%; ফাঁস ধরা পড়তে median ২০ দিন; push protection git এর ফাঁসের ৮০% ধরে; ৩০% বৈধ login ৪০টা office NAT থেকে। প্রতিটা environment variable দিয়ে বদলানো যায়, আর lesson এর **শিক্ষা** এই সংখ্যাগুলোর আকারের উপর নির্ভর করে, নির্দিষ্ট মানের উপর না। DDoS এর অংশ একটা সরল fluid model, আসল network না। **যা মাপা হয়নি:** আসল identity provider, `jose` library, আসল CDN বা WAF, CAPTCHA, HIBP এর API, Vault। ১.২ আর ১.৩ এর TypeScript code (`authenticate`, `loadBoardFor`) একটা নকশা, চালানো না। RFC 8725, RFC 9700, OAuth 2.1 এর খসড়া আর OWASP API Top 10 এর দাবিগুলো তাদের প্রকাশিত লেখা থেকে, এখানে যাচাই করা না। ১.৯ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `abuse` চালানোর **আগে** লিখে ফেলুন: ১২ লাখ চেষ্টা, ৩৮,০০০ IP, ৬ ঘণ্টা। 9.5 এর সীমা (IP ঘণ্টায় ২০, email ঘণ্টায় ১০) কয়টা চেষ্টা আটকাবে? তারপর চালিয়ে মেলান। এবার `BOT_IPS=5000` আর `BOT_IPS=1000`। কোন বিন্দু থেকে per-IP সীমা কাজ শুরু করে, আর attacker এর জন্য সেই বিন্দু এড়ানোর খরচ কত?

2. **নতুন route, পুরনো ভুল:** `src/authz.ts` এর `routes()` এ `GET /boards/:id/comments` যোগ করুন `guarded(() => true, 200)` দিয়ে। Matrix test কী বলে? এবার এমনভাবে বদলান যাতে কোনো route permission না দেখে board load **করতেই না পারে**: একটা `loadBoardFor(principal, id)` বানান, `boards.get` সরাসরি নিষেধ। এখন একই ভুল করার চেষ্টা করুন। কোথায় আটকায়?

3. **Revoke এর দেরি:** `PUSH_SECONDS=60 npm run sessions`। Denylist এর সারিতে revoke এর পরে গড় কত হলো? কোন কলাম বদলায়নি, আর কেন? এবার ভাবুন: denylist এর push identity থেকে না এসে একটা Redis pub/sub থেকে এলে (7.2), আর Redis পাঁচ মিনিট বন্ধ থাকলে কী হয়?

4. **PKCE এর `plain`:** `src/oauth.ts` এ `s256` এর বদলে challenge = verifier (`plain` method) করুন। চুরি হওয়া code এর আক্রমণ কি এখনও আটকায়? কোন অবস্থায় `plain` আর `S256` এর পার্থক্য আসল? (ইঙ্গিত: attacker authorization request এর URL টাও দেখতে পেলে।)

5. **Design অংশ:** TaskFlow এর **public API** এর security এর এক পাতার plan। বাইরের developer রা integration বানাবে। (ক) API key নাকি OAuth? কোন ক্ষেত্রে কোনটা (ধরুন একটা company এর নিজের script বনাম একটা marketplace এর app যা অনেক company ব্যবহার করে)? (খ) Scope এর তালিকা, আর একটা token কোন workspace এ সীমিত থাকবে সেটা কীভাবে নিশ্চিত করবেন? (গ) API key ফাঁস হলে (একটা public repo তে, প্রশ্ন ৩ এর মতো) developer কীভাবে জানবে, আর TaskFlow কী করবে? (ঘ) Rate limit: প্রতি key, প্রতি workspace, নাকি দুটোই (9.5)? আর একটা integration যা হঠাৎ সেকেন্ডে ১০,০০০ request পাঠায়, সেটা কি DDoS, bug, নাকি বৈধ? কীভাবে আলাদা করবেন? (ঙ) কোন একটা ঘটনায় page করবেন (10.4 এর burn rate এর মতো), আর কোনটায় শুধু ticket?

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ), 10.1, 10.2, 10.3, 10.4
Current: 10.5 - Security at scale: authN vs authZ, OAuth/JWT, secret management, DDoS
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limit
দুই স্তরে; cache ring; Bloom/HLL; hard/soft dependency + fault injection; brownout; OpenTelemetry, structured
log, histogram, tail sampling, burn rate alert। খারাপ সপ্তাহ: export route এ BOLA (sequential id, অন্যের
৫৯,৯৭০ board), DELETE token এর role বিশ্বাস করত; git history তে .env (Stripe live, JWT secret, DB password);
log এ Authorization header; ২৪ ঘ JWT, revoke নেই (বরখাস্ত employee সারাদিন); credential stuffing ১২ লাখ
চেষ্টা ৩৮,০০০ IP → ৩,৫৪৭ দখল, 9.5 এর সীমা শূন্য আটকাল, ৯৪৬ office NAT user আটকাল; share page এ ?x= দিয়ে
cache ভেঙে L7 flood। এখন: access token RS256 ১৫ মি (jose, alg allowlist, JWKS config থেকে, iss/aud/exp),
token এ role নেই; opaque refresh ৩০ দিন + rotation + reuse detection (পরিবার বাতিল + alert), hash এ রাখা;
web এ BFF এর HttpOnly cookie; denylist push ৫ s; key rotation + নিষিদ্ধ kid এর তালিকা। AuthZ: scoped loader
(loadBoardFor), Membership থেকে role, অন্যের object এ 404, route × actor matrix test CI তে, UUID, audit log,
"আলাদা board এ 404" metric। OAuth/OIDC: code + PKCE S256 + state + exact redirect + single-use ৬০ s; ID token
API তে না। Secret: secret manager + workload identity, service ধরে ভাগ, DB এর dynamic credential, push
protection + history scan, log এ auth header নিষেধ (CI test), runbook "আগে rotate"। Login: 9.5 + failure
ratio → challenge + breached password check + MFA (admin এ বাধ্যতামূলক) + নতুন device এর email। DDoS:
anycast CDN + WAF, নতুন origin IP শুধু tunnel দিয়ে, share page cache key normalize, autoscaling এর সীমা
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7)
Weak spots: [আপনি যেখানে আটকেছিলেন - নিজে লিখুন]
Next: 10.6 - Deployment: blue-green, canary, feature flag, zero-downtime migration
=======================
```

---

## ৮. পরের Lesson

আজকের সুতোটা: **দরজাটা নিরাপত্তা না।** TaskFlow এর login ঠিক ছিল, gateway ঠিক ছিল, আর সপ্তাহের প্রতিটা ঘটনা ঘটেছে তার পরে বা পাশ দিয়ে। একটা route প্রশ্ন করতে ভুলে গেছে "এটা কি আপনার?"। একটা token কে ফেরত নেওয়া যায়নি। একটা secret "মুছে" ফেলা হয়েছিল কিন্তু চলে যায়নি। আর আক্রমণ এসেছে হাজার হাতে, প্রতিটা সীমার নিচে। প্রতিটা প্রতিরক্ষার একটা নির্দিষ্ট হুমকি আছে, আর "আমরা X ব্যবহার করি" কখনো উত্তর না, যতক্ষণ না বলছেন X কোন আক্রমণ থামায় আর কোনটা থামায় **না**।

খেয়াল করুন, এই সপ্তাহের অনেক সমাধান একটা কাজে আটকে আছে: **নিরাপদে বদলানো।** ছয়টা service এ একসাথে key rotate করা, যাতে কেউ কাউকে প্রত্যাখ্যান না করে। `findByPk` কে scoped loader এ বদলানো, চলমান system এ। `Membership` table এ নতুন `scope` column, ৬০,০০০ board এর উপর, কোনো downtime ছাড়া। রেডি হলে `next` লিখুন - **Lesson 10.6: Deployment - Blue-Green, Canary, Feature Flag, Zero-Downtime Migration** এ যাব। সেখানে প্রশ্নটা: একটা পরিবর্তনকে production এ কীভাবে আনবেন যাতে ভুল হলে তা অল্প মানুষকে, অল্প সময়ের জন্য ছোঁয়, আর এক click এ ফেরানো যায়। আর database এর schema কীভাবে বদলাবেন যখন পুরনো আর নতুন code একই সময়ে একই table পড়ছে।
