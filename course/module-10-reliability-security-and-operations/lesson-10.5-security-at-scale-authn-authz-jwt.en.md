# Lesson 10.5 — Security at Scale: AuthN vs AuthZ, OAuth/JWT, Secret Management, DDoS

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 8.2):** Why is a presigned URL's expiry kept to a few minutes, not a few days? And once issued, is there any way to cancel it before it expires? Today the same question returns at a bigger size — every TaskFlow user holds something like this, and after one person was fired it kept working for almost a day.

**Prerequisite:** Lesson 2.2 (TLS), Lesson 4.5 (CDN, anycast), Lesson 8.2 (Presigned URL), Lesson 9.2 (Gateway, edge authentication, internal token), Lesson 9.5 (Rate limiting), Lesson 10.3 (Static stability, JWKS), Lesson 10.4 (Structured logs)

**By the end of this lesson you will be able to:**

1. Tell AuthN and AuthZ apart, and verify a JWT correctly — correctly meaning you know which fields the server decides and which the token does. And show with numbers how one route with a gap in authorization leaks a whole database, and how to catch that in CI
2. State the trade-offs between token lifetime, refresh token rotation and a denylist: how long until a revocation takes effect, how much load lands on the identity service, and what happens when identity dies. And say **which** attack each of state, PKCE, exact redirect and single-use stops in OAuth's authorization code flow
3. Say what to do when a secret leaks, and why the damage of a leak is reduced by a secret's short lifetime, not by a rotation calendar. And separate with numbers which layers actually work against credential stuffing and DDoS, and which only pretend to

**Tier:** 1 — Runnable Code (five deterministic scripts: JWT, BOLA, sessions, OAuth, secrets, credential stuffing and DDoS. No network, identity provider, CDN or Docker needed)

---

## 0. Where TaskFlow Is Right Now

After 10.4, TaskFlow can see itself. Every request has a trace, logs are structured, alerts run on burn rate. Since 9.2 all outside traffic comes through a gateway. The gateway verifies the user's JWT, drops any identity headers the client sent, and sets a signed 60 s internal token for the inside. Since 9.5 login has a rate limit: 20 attempts an hour per IP, 10 per email. The identity module's access token is a JWT with a 24-hour lifetime and no means of revocation — "it's stateless, so it scales."

TaskFlow now has 2,000 workspaces and 60,000 boards. Then came a week.

**Monday.** A customer's CTO wrote to support: "A competitor has a full export of one of our private boards." The trail led to someone named `mallory`. Mallory has a free workspace and is its admin. With their **valid** token, mallory ran a script: `GET /boards/1/export`, `/boards/2/export`, … `/boards/60000/export`. Board ids were sequential. The export route was new, written in one sprint. It verifies the token, but does not check whether the board belongs to the user's workspace. **59,970 boards** belonging to others went out. There was nothing wrong with the token, and the gateway did its job correctly.

**Tuesday.** The billing team had given a contractor access to the repo. Three weeks later Stripe sent an email: unfamiliar refunds were being issued with TaskFlow's live key. A commit from four months earlier, `wip: local test`, contained a `.env`. The next commit was named `oops remove .env`. The file is not in today's code, but it is in the git history. That `.env` also held the token-signing secret and the production database password.

**Wednesday.** After 10.4, someone debugging had added the full request headers to the gateway's structured logs. Including `Authorization: Bearer eyJ...`. Forty people have read access to the log store. The same day HR reported that an employee had been fired that morning, and even after their account was disabled, they spent the whole day logged into TaskFlow downloading data. The reason: a 24-hour JWT that nobody can take back.

**Saturday night.** 1.2 million login attempts in 6 hours, from 38,000 distinct IPs. On average 5 attempts per IP per hour, and one per email. 9.5's limits never fired once. In the morning, **3,547 accounts had been taken over**. All of them were users who used the same password on TaskFlow as on some other site that had leaked. And the irony: that same night 946 legitimate users could not log in. They sit behind a big office's NAT, coming from one IP, so the 20-an-hour limit stopped them.

**Sunday.** The public share page `/s/:token` received 60,000 requests a second from 20,000 IPs. There is a CDN (4.5), but every URL ended with `?x=` and a random number. Every request was a cache miss, straight to the origin. The origin's capacity is 2,000 a second. For four hours TaskFlow was nearly down.

The one line in the postmortem from the engineer responsible for security: "We had a door at login, and we thought the door was the security. Every incident happened **after** the door — or through the wall next to it."

---

## 1. Theory

### 1.1 Two separate questions — "who are you?" and "may you do this?"

Look closely at Monday's incident. Mallory's token was valid. The gateway was right to say "this is mallory". The mistake was in the next question, which nobody asked.

**Authentication (AuthN) / Authorization (AuthZ)** — authentication proves **who** sent the request (with a password, token or certificate); authorization decides whether that identity has permission to do **this action on this resource**. AuthN can happen once, at the boundary; AuthZ has to happen for every action on every resource, where the data is.

```
            AuthN — "who are you?"                AuthZ — "is this yours?"
browser ──► gateway ─────────────────────► service ───────────────────────► DB
            verify the token: signature,          is user 42 a member of board
            expiry, iss, aud                      4821's workspace? which role?
            result: principal = user 42           result: 200 / 404
            (once, in one place — 9.2)            (every route, every object)
```

In 9.2, AuthN was brought to one place at the boundary. That made the place for mistakes a single one. AuthZ cannot be brought to one place like that. The gateway does not know which workspace board 4821 belongs to — the database does. So the place for AuthZ mistakes is **every route**, and every new route is a new opportunity.

The rest of this lesson circles these two questions. First we look at exactly what AuthN's piece is (the JWT) and how it gets verified wrongly (1.2). Then AuthZ's most common mistake (1.3). Then **taking back** AuthN (1.4), and AuthN on someone else's behalf (OAuth, 1.5). Finally three things that are the wall next to the door: secrets (1.6), hammering on the door (1.7), and a flood through the whole house (1.8).

### 1.2 JWT — a matching signature does not mean trustworthy

**JWT (JSON Web Token)** — three base64url parts joined by dots: `header.payload.signature`. The header says which algorithm signed it (`alg`) and with which key (`kid`). The payload holds **claims**: `sub` (who), `iss` (who issued it), `aud` (who it is for), `exp` (when it dies). The signature proves nobody altered the header and payload. A JWT is usually **signed, not encrypted** — anyone can read the payload.

```
eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMTAifQ . eyJzdWIiOiJhbGljZSIsImF1ZCI6InRhc2tmbG93LWFwaSIsImV4cCI6...} . kQ3x...
└──── header ─────────────────────────────┘   └──── payload (claims) ──────────────────────────────────┘   └ signature ┘
{"alg":"RS256","kid":"2026-10"}               {"sub":"alice","iss":"https://id.taskflow.test",
                                               "aud":"taskflow-api","exp":1790000900,"role":"member"}
```

With RS256 the identity service signs with a **private key**, and everyone else verifies with its **public key**. Everyone has the public key (from 10.3's JWKS endpoint). Only identity can sign.

Now the problem: because the payload is readable, no password, secret or anything else sensitive may go in a token. And the even bigger problem is **how the verification is written.** The exercise's `npm run authz` part A has two verifiers. The naive verifier reads `alg` from the header, verifies with that algorithm, and looks only at the signature. The strict verifier decides the algorithm itself, takes the key from its own key ring by `kid`, then checks `iss`, `aud` and `exp`. Both were given eight tokens:

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

First notice what **worked**: changing the payload and signing with another key were both caught even by the naive verifier. The cryptography is fine. It breaks in three other places:

1. **`alg: none`.** The JWT standard has something called an "unsecured JWT", whose algorithm is `none` and whose signature is empty. If the verifier asks the token "how should I verify you?", the token says "you don't have to". That is how a forged `admin` token gets through.
2. **Algorithm confusion (RS256 → HS256).** This one is subtler. HS256 is a symmetric algorithm — the same secret signs and verifies. The naive verifier holds the public key's text and uses it as "the key". The attacker has that public key too, because it is public. They write `HS256` in the header, use the public key's text as the HMAC secret, and sign the token themselves. The verifier does the same computation, and the signature matches. A second forged `admin`.
3. **Not checking claims.** An expired token, another service's token (`aud = billing-api`), a staging token (sharing the same key). All signatures are fine, but none is valid **for this API, now**. Remember 9.2's files-team incident: not checking `exp` let a logged-out user's token run for three days.

The rule in one line: **the server decides how to verify, not the token.** The algorithm comes from an allowlist (here only RS256). The key comes from your own trusted key ring, by `kid`. `kid` is only for selecting; the key's **source** never comes from the token. Some JWT headers carry `jku` or `x5u`, meaning "fetch the key from this URL". Never honour those, because then an attacker can supply the URL of their own key. Then check `iss`, `aud`, `exp` (and `nbf`, `iat`), with a small allowance for clock skew (6.4).

These rules are written down in the IETF's **JWT Best Current Practices (RFC 8725)** (not verified here). And the biggest lesson here: **do not write your own JWT verifier.** The exercise's verifier is hand-written only to show where things break. In production use a tested library, such as `jose` in Node, and always pass the algorithm allowlist yourself:

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

Notice two things. First, `jwtVerify` checks the signature and `iss`/`aud`/`exp`, but not the **shape** of the payload. So it is parsed with Zod afterwards. The payload is a runtime input too, and has to be parsed before it is trusted. Second, **`role` is not taken from the token**, only `sub`. Why, in the next section. (More on `denylist` in 1.4.)

**And 10.3's JWKS.** `createRemoteJWKSet` caches the keys and fetches again when an unknown `kid` arrives. In 10.3's reflection question we saw what happens when identity dies and the key cache runs out. The statically stable design from there applies here too: hold on to the last known key set, **publish** new keys **in advance**, and remove old keys **afterwards**.

### 1.3 BOLA — one unguarded route, the whole database

Now Monday. In `npm run authz` part B: 2,000 workspaces × 30 boards = 60,000 boards, ids `1..60000`. Mallory is the admin of their own free workspace, with a valid token. On each of eight routes, mallory tries the id of every board belonging to someone else:

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

Six of the eight are right. Two are wrong, and the two are wrong in different ways:

- **`export` forgot the check.** The token was verified (at the gateway), the board was loaded and sent. The question "is this board in your workspace?" is missing in between. This is Monday's incident.
- **`DELETE` trusted the wrong thing.** Its check is `role === 'admin' || member`, and `role` comes from the token. Mallory really is an admin — of **their own** workspace. A global `role: admin` in a token does not say where someone is an admin. A role is a relationship (user × workspace), and it lives in the database, not in the token.

**BOLA (Broken Object Level Authorization)** — an API takes an object's id (`/boards/:id`), checks whether the user is authenticated, but not whether they have permission on **this particular object**. As a result any valid user can change the id and read or modify someone else's data. The older name is IDOR (Insecure Direct Object Reference). It is risk number one in OWASP's API Security Top 10 (2023).

Notice that this is not a failure of AuthN. On every request mallory really is mallory. And look at the third column: even the six "correct" routes leak every board's **existence**, because "doesn't exist" gives a 404 and "not yours" gives a 403. Telling an attacker even that much is information: which ids exist, how many boards, how fast they grow. So for someone else's object you usually return a **404** — "nothing like that exists for you".

**Are UUIDs the solution?** A natural reaction: "make ids random UUIDs instead of sequential." Part C:

```
mallory's attempt                       attempts  got others' boards
guessing random UUIDs              1,000,000                 0
ids from a leaked support log          340               340
```

Not one in a million guesses. A v4 UUID has 122 random bits; there is no hope of guessing one. But an id **is not a secret.** It sits in URLs, in browser history, in screenshots, in support tickets, in logs (10.4), in shared links. **All 340** of the 340 leaked ids worked. UUIDs stop enumeration, which is a good thing — keep them. But that is not authorization. Authorization means "even if you know the id, you won't get it."

**How to fix it — and keep it from happening again.** Fixing one route is easy. The hard part is next sprint's new route. Two techniques are needed together:

**(a) Put authorization in the path that reads data, not inside the route.** No route should even be **able** to load a board without checking permission:

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

Every route calls `loadBoardFor`; calling `Board.findByPk` directly is forbidden. That can be enforced with a lint rule, or by exporting the model only from this module. If it returns `null`, the route returns 404. The question "whose?" is then **inside** the query, so there is no separate line to forget. The role also comes from `Membership` (per workspace), not from the token.

**(b) An authorization matrix test.** Every route × every kind of actor, with the expected result. Part D:

```
route                           owner   member of another ws  admin of another ws  no token  result
GET    /boards/:id              200       404                 404                401           pass
…
GET    /boards/:id/export       200       200 ✗               200 ✗              401           FAIL
DELETE /boards/:id              204       404                 204 ✗              401           FAIL
POST   /boards/:id/archive      200       404                 404                401           pass

3 cells failed — with this test in CI it would have been caught before merge
```

Three cells, and exactly the three that did the real damage on Monday. This test's power is that it generates **itself** from the list of routes. Add a new route and it enters the matrix by itself, and if nobody writes down the expected results, the test fails. The same reasoning as 10.3's dependency matrix: let CI ask the question everyone forgets.

### 1.4 Sessions — taking a token back

The second half of Wednesday. The fired employee's account was disabled in the morning. But they held a 24-hour JWT, and the API verifies it by signature and expiry. Nobody checks whether the account has been disabled. Like 8.2's presigned URL, this is a **bearer** permission: whoever holds it owns it, until it expires.

**The spaced repetition answer:** this is exactly why a presigned URL's expiry is kept short. Once handed out there is no way to take it back (short of changing the signing key itself, so that **all** of them die at once). So a short expiry is the only revocation. With a stateless JWT it is exactly the same. The benefit of "stateless" (verifying without asking anyone) and its drawback (it cannot be taken back without asking anyone) are two sides of the same thing.

How short? In `npm run sessions` part A: 60,000 active sessions, 300 requests a second, 8 hours (8.6 million requests). In the middle, 2,000 revocations (logout, password change, account disable), and six policies:

```
policy                        store/identity call/s   % of requests  after revoke: avg  worst  works if identity dies
JWT 24 h, no revoke                            0.0          0.0%            19.6 h         24.0 h          24.0 h
session lookup on every request             299.9        100.0%               0 s            0 s             0 s
access 1 h + refresh                           14.8          4.9%             27 min        1.0 h           1.0 h
access 15 min + refresh                       43.7         14.6%            4.8 min         15 min        15 min
access 5 min + refresh                        88.0         29.3%            1.1 min        5.0 min       5.0 min
access 15 min + refresh + denylist            43.7         14.6%               5 s            5 s           15 min
```

The first two rows are the two extremes:

- **A 24-hour JWT:** nobody calls identity. But after revocation a token keeps working for **19.6 hours** on average. Wednesday's employee was in exactly this row.
- **Session lookup on every request:** an old-style server-side session (like Express's `express-session` + Redis). Revocation is instant. The cost: a session store lookup on every request, 300 a second. And if the session store dies, **nobody** can do anything (0 in the last column). In 10.3's terms, the session store is a hard dependency.

The rows in between are today's usual design. Two kinds of token:

**Refresh Token Rotation** — a short-lived **access token** (a JWT, 5–15 minutes; the API verifies it on every request without asking anyone) and a long-lived **refresh token** (opaque — a random string with no meaning inside; days or weeks; shown only to identity to get a new access token). On every refresh the old refresh token dies and a new one arrives (**rotation**). And if an old, already-used refresh token shows up again, the whole family (every refresh token from that login) is cancelled (**reuse detection**).

The access token's lifetime is a knob. Turning it turns **three** things at once. Going from 15 minutes to 5 lowers the revocation delay from 4.8 minutes to 1.1 — good. It doubles the load on identity (43.7 to 88 calls/s) — bad. And it lowers how long people can keep working when identity dies from 15 minutes to 5 — also bad. Fast revocation and tolerating outages are enemies, as long as you drive both with one knob.

The last row separates them. A **denylist** is a small list of revoked tokens' `jti`s or users. Identity pushes it to every API instance, and the API checks it in its own memory on every request (`denylist.has` in 1.2's code). The revocation delay is 5 seconds — the push time. But identity calls did not increase (43.7), and even if identity dies, access tokens keep working for 15 minutes. Only new revocations fail to arrive. The list stays small because an entry only has to be kept until the token's expiry — after that the token is dead by itself. The denylist's cost is **state**: the "stateless JWT" is no longer fully stateless. Most large systems end up here.

**When a refresh token is stolen.** Wednesday's log had refresh tokens alongside the access tokens. In part B the access token is 15 minutes and the refresh token 30 days. The attacker starts work 10 minutes after the theft:

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

The middle row is the most instructive. **Rotation alone does not stop the thief — it throws out the legitimate user.** The attacker refreshed first, so the family's "current" token is now in their hands. Alice's token has become stale; alice is logged out, logs in again, and thinks "odd". The attacker stays for 29.6 days. Reuse detection turns exactly this moment into a signal: alice presented their old token, the server recognized "this has been used before, so two people are driving this family", and cancelled the whole family. The attacker is left with only the 15 minutes of their last access token. Plus a security alert.

But look at the second scenario. Stolen on Friday afternoon, alice returns on Monday morning. Reuse is detected only when **both** use the token. So over the weekend the attacker is alone, for **2.7 days**. The remedies are more layers: an **idle timeout** on refresh tokens (say it dies after 12 hours unused — but the attacker is using it), an alert or challenge when a refresh comes from a new device or country, and binding the token to a device key (DPoP, mTLS-bound tokens). With the last one, a stolen token is useless on its own. And above all: **tokens do not go in logs.** In 10.4 I said keep an allowlist of log fields. On Wednesday there wasn't one.

**Where to keep tokens in the browser.** Keep them somewhere JavaScript can read (`localStorage`) and one XSS bug (someone else's script running on your page) takes every token. Keep them in an `HttpOnly; Secure; SameSite` cookie and JavaScript cannot read them. That is why, in 9.2's BFF pattern (a SvelteKit server route), the access token never goes to the browser at all. The browser holds only a session cookie, and the token stays with the BFF. Cookies have their own risk: CSRF, meaning requests in your name from another site. That is handled with `SameSite=Lax` or `Strict` and a CSRF token on state-changing requests.

### 1.5 OAuth 2.0 and OIDC — identity on someone else's behalf

Two new requests have come to TaskFlow: "log in with Google", and a public API so outside apps like Slack can read tasks on a user's behalf. Both are the same question: how does an app act on a user's behalf without knowing the user's password?

**OAuth 2.0 / OIDC** — OAuth 2.0 is a framework for **delegated authorization**: a user grants an app (the client) limited permission (a scope) without handing over a password, and the app gets an **access token**. OIDC (OpenID Connect) is an identity layer on top: it adds an **ID token** (a JWT) that tells the client "who logged in". The most common flow for both is the **authorization code flow + PKCE**.

```
 browser                 TaskFlow (client)                   authorization server (identity)
    │  "log in with Google" ─►│
    │                         │ state = random, verifier = random
    │                         │ challenge = SHA256(verifier)
    │◄── redirect: /authorize?client_id&redirect_uri&state&code_challenge ──
    │──────────────────────────────────────────────────────────────►│ user logs in + "allow"
    │◄──────────── redirect: redirect_uri?code=abc&state=… ──────────│
    │── code, state ─────────►│
    │                         │ does state match? (CSRF)
    │                         │── POST /token: code + verifier + redirect_uri ──►│ SHA256(verifier) == challenge?
    │                         │                                                   │ code used once? expiry 60 s?
    │                         │◄────────── access token (+ ID token, refresh) ────│
```

The code travels through the browser's URL, so it has to be assumed "may be stolen". Tokens arrive over the back channel, server to server. Each defence in the flow closes one specific path. In `npm run oauth` part A: four attacks × five sets of defences:

```
attack                                               nothing  state    PKCE only  state + PKCE  all (+exact, single-use)
Login CSRF: mallory's code in alice's browser         succeeded ✗  blocked  blocked  blocked   blocked
Code theft (mobile scheme / log), mallory redeems first  succeeded ✗  succeeded ✗  blocked  blocked   blocked
Code replay: the same code after alice               succeeded ✗  succeeded ✗  blocked  blocked   blocked
redirect_uri bait (prefix match), mallory's own PKCE  succeeded ✗  succeeded ✗  succeeded ✗  succeeded ✗  blocked
```

One at a time:

- **Login CSRF.** Mallory logs in themselves and takes their own code, then gets alice to click a link that sends **mallory's** code to TaskFlow's callback. Alice is now logged into mallory's account, and whatever alice uploads goes to mallory. **`state`** stops this. It is a random value bound to the start of login in alice's browser, and it does not match on mallory's callback. PKCE also stopped it here, because alice's verifier does not match mallory's challenge.
- **Code theft.** The code has somehow reached the attacker. Maybe another app registered the mobile app's custom URL scheme too, or the code landed in some log (Wednesday). The attacker goes straight to `/token` and redeems it. `state` does nothing here, because the attacker is not going through the callback at all. **PKCE** stops it. Redeeming the code needs the verifier, and the verifier never travelled through the browser's URL — it stayed on TaskFlow's server.
- **Code replay.** The same code a second time. Here PKCE stopped it too (the attacker has no verifier). But the **single-use** rule is needed independently. Once a code has been used, any later attempt should fail, and a good authorization server will then also cancel the tokens issued from that code.
- **Redirect URI bait.** This is the most instructive row. The authorization server matches the **prefix** of the redirect URI: anything starting with `https://app.taskflow.test` is accepted. Mallory sends alice a link whose `redirect_uri` is `https://app.taskflow.test.evil.example/auth/callback`. It does start with `https://app.taskflow.test`, but the domain is mallory's. Mallory started the flow themselves, with **their own** PKCE challenge, so they hold the verifier. Alice presses "allow", the code goes to mallory's domain, mallory redeems it. State and PKCE are both helpless, because both are mallory's. **Only exact matching** stops it.

The lesson holds for all security design: **every defence has a specific threat.** Saying "we use PKCE" is not a security claim until you say against which attack. And the whole list is needed together, because each closes a different door. The newer version of OAuth (the OAuth 2.1 draft) and the IETF's OAuth Security BCP (RFC 9700) move toward making exactly these four mandatory: PKCE for every client, exact redirect URI matching, and dropping the implicit flow (where the token came directly in the URL). These come from their published writing, not verified here.

Part B shows the cost: the code's expiry is 60 seconds, so a callback arriving after 90 seconds fails (in every set). A slow phone, a tab that went to sleep, and the user has to press "log in" again. That cost is paid deliberately.

**ID token ≠ access token.** Part C:

```
ID token (aud = taskflow-web)         API ignoring aud: 200   API checking aud: 401 aud mismatch
access token (aud = taskflow-api)     API ignoring aud: 200   API checking aud: 200
```

The ID token tells TaskFlow's **web app** "this is alice". Its `aud` is the client (`taskflow-web`). It is not a key to the API's door. If an API does not check `aud`, then any ID token made for any app opens its door — including apps that use the same identity provider but belong to someone else. A form of 1.2's third rule.

### 1.6 Secrets — what goes into git, is gone

Tuesday. `npm run secrets` part A has a small git history and a secret scanner. The scanner was run two ways, on today's code only and on the whole history:

```
HEAD only (today's code):  2 findings
whole git history:         5 findings

commit    file                rule                            verdict
7f20b4d   .env                tfsk key pattern                 real — live payment key
7f20b4d   .env                SECRET/KEY = high entropy       real — the token signing secret
7f20b4d   .env                password in a URL                real — production DB
c08a5f2   package-lock.json   any long high-entropy string  false positive (lockfile hash)
c08a5f2   test/fixtures.ts    tfsk key pattern     test key — low risk, remove it anyway

real production secrets: 3 in history, 0 at HEAD — the "oops remove .env" commit deleted nothing
```

Three lessons:

1. **A commit does not delete.** `git rm .env` and a new commit only remove the file from today's snapshot. The file lives forever in the earlier commit's snapshot, in every clone, every fork, every CI cache. History can be scrubbed (`git filter-repo`), but it stays in the copies of anyone who cloned before. So after a leak **the first job is to rotate** — cancel the secret and create a new one. Cleaning history is a second, optional job.
2. **Scanning only HEAD is false reassurance.** Of the two found in HEAD, one is a false positive (a lockfile hash) and the other a test key. The real three are only in the history.
3. **Scanners are not perfect.** Pattern rules (a key's own format, like `tfsk_live_…`) are precise, but only catch known formats. Entropy rules catch unknown secrets, but give false positives on hashes and ids. Real scanners (gitleaks, trufflehog, GitHub's secret scanning) combine both. And some providers have agreements so that when their key is found in a public repo, they cancel it themselves.

**What reduces the damage of a leak?** Damage = how long a leaked secret **keeps working**. In part B, 1,000 leaks across four channels (git, logs, CI output, laptops). It takes a median of 20 days to be caught (an assumed number, see below):

```
policy                          working leaks  median        p90   > 7 days  total attacker-days
static secret, never changes        1,000   19.1 days  117.3 days   76.6%             46,312
rotate every 90 days                1,000   13.5 days  54.5 days   70.5%             21,256
90 days + push protection               677   13.0 days  52.2 days   47.1%             14,010
dynamic credential (60 min lease)      1,000      30 min     54 min    0.0%                 21
```

90-day rotation, which many compliance checklists demand, halves the total damage. But the median leak still works for 13.5 days, and 70% of leaks work for more than a week. Rotation only helps if the date happens to come before the leak is caught. Push protection (catching a secret at the moment of a git push and blocking the push; here it catches 80% of git leaks) closes much of the git path. But the log, CI and laptop paths stay open.

The last row is a different kind of thing. A **dynamic credential** is one created at the moment it is requested, with a short lease (here 60 minutes), that dies by itself when the lease ends. Say a worker, on startup, asks the secret manager "give me a user for the DB". The secret manager creates that user in the database right then, and deletes it an hour later. If such a secret leaks, its **lifetime is minutes**, caught or not: 21 attacker-days in total instead of 46,312. Look at experiment 3: even cutting detection from 20 days to 3, a static secret gives 8,256 attacker-days, and rotating every 7 days gives 3,297. Both are still more than 150 times dynamic.

The rule: **don't rely on catching the leak — shorten the secret's lifetime.** Better still is having no secret at all. In the cloud a service can be granted permission by its **identity** (workload identity, like an AWS IAM role or a GCP service account), so there is no key in the code at all. And between internal services, mTLS (9.2) certificates are automatically short-lived too.

**How much damage one broken wall does.** Part C: TaskFlow's six services, and how many secrets someone gets if they get inside one service:

```
got into  one shared .env  separate per service  what they got
gateway                    10                   2  no payment/DB
web-bff                    10                   2  no payment/DB
monolith                   10                   4  incl. DATABASE_URL
billing                    10                   4  incl. STRIPE_KEY
files                      10                   2  no payment/DB
worker                     10                   4  incl. DATABASE_URL
```

One shared `.env` means getting into any service gets all ten. Separated, it is 2–4, and three of the six have no payment or DB key at all. This is 10.3's **blast radius** reasoning, applied to security. Its name is **least privilege**: each part gets exactly as much as its job needs.

A **secret manager** (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) is the home for all of this. Secrets are not in code or images; they are fetched at startup using the service's identity. Every read goes to an audit log. Rotation and dynamic credentials run in one place. And one subtlety: the secret manager itself becomes a hard dependency. 10.3's static stability applies here too: hold on to the last secrets you received while the service is running, so that a five-minute secret manager outage does not stop all of TaskFlow.

### 1.7 Credential Stuffing — millions of knocks on the door, each from a different hand

Saturday night. Look closely at what the attack looked like, because 9.5's rate limit **seemed** built for exactly this kind of attack.

**Credential Stuffing** — taking millions of (email, password) pairs from other sites' data breaches and automatically trying them as logins on your own site. It works because people reuse the same password in many places. Unlike brute force, it does not try many passwords on one account, but **one on each of many accounts**. And it comes from thousands of IPs (botnets, residential proxies), so it stays far below per-IP and per-account limits.

In `npm run abuse` part A: 1.2 million attempts, 38,000 IPs, 6 hours. 3% of the list's emails exist on TaskFlow, and 10% of those use the same password. Alongside, 20,000 legitimate logins at the same time, 30% of them from behind 40 offices' NATs:

```
5.3 attempts per IP per hour on average, once per email on average; the password really matches for 3,547 accounts on the list

policy                           bot reached password  takeovers     legit logins blocked  legit user friction  detected
no limits                               1,200,000         3,547          0 (0.0%)                  0          —
9.5: IP 20/h + email 10/h                     1,200,000         3,547        946 (4.7%)                  0          —
strict: IP 5/h + email 10/h                    853,658         2,532     4,484 (22.4%)                  0          —
9.5 + breached password check                1,200,000           531        946 (4.7%)              1,210          —
9.5 + failure ratio → challenge                123,183           395      1,104 (5.5%)              4,935     1 min
all + MFA (25% of users)                       123,183            46      1,104 (5.5%)              6,137     1 min
```

- **9.5's limits did not stop a single attempt** (1.2 million of 1.2 million reached the password check). 5.3 per IP per hour, limit 20. Once per email, limit 10. And **it blocked 946 legitimate users**, all behind office NATs. The limit stopped the wrong people.
- **Making it strict:** at 5 per IP per hour, takeovers drop by about 1,000. But it blocks **22.4%** of legitimate logins — nearly one in four office users. And the fix for the attacker is cheap: rent more IPs. See experiment 1: with 5,000 IPs (40 per IP per hour), 9.5's limit cuts takeovers from 3,547 to 1,759. That is the only situation in which a per-IP limit works, and getting out of it takes the attacker an afternoon.
- **Breached password check:** at login, check whether the password is on a list of known breaches (for example the Have I Been Pwned password range API — you send neither the password nor its full hash, only the first 5 characters of the hash). If it is, send the user to a password reset instead of logging them in. Takeovers fall from 3,547 to 531, because the attacker's list is, by definition, a breach list. The cost: 1,210 legitimate users had to change their password. That really is for their own good.
- **A failure-ratio detector:** this does not look at any individual, it looks at the **aggregate** state. If more than 25% of logins in the last 10 minutes failed, it turns on a challenge (a CAPTCHA or similar) for unfamiliar devices. On a normal day ~8% fail. During the attack, over 90%, because most emails on the list have no TaskFlow account. **Detected in 1 minute.** Of the bots' 1.2 million, 123,000 get through, and takeovers are 395. The cost: 4,935 legitimate users saw a challenge.
- **All together + MFA:** **46** takeovers. With MFA (a second proof: a code on the phone, an authenticator app, a passkey) the account is not lost even if the password matches. But here only 25% of users have MFA, hence the remaining 46.

And experiment 2's warning: `BOT_SOLVE=0.5`, meaning a CAPTCHA-solving farm (people solving CAPTCHAs for money — a real business). In the challenge row, takeovers rise from 395 to 1,796. But the breached password check row (531) does not change at all. And the all-together + MFA row rises from 46 to 199, far below the challenge-only row. Because the breached check and MFA do not depend on telling bots from humans. They depend on **the state of the password itself**, so they stand even when the challenge is passed.

The lesson: **per-key limits (IP, email) stop one attacker, not a distributed attack.** Catching a distributed attack takes aggregate signals (the failure ratio, the share of new devices, the same password being tried across many emails). And making it useless takes credential quality: breached checks, MFA, and best of all, passkeys. With a passkey there is no password to steal at all. And at the end of it all, one thing that is in no row: email the user when there is a login from a new device. Many of the 46 will report it themselves in the morning.

### 1.8 DDoS — which layer stops which flood

**DDoS (Distributed Denial of Service)** — sending traffic from many sources at once to make a service unusable for legitimate users. There are two basic kinds. **Volumetric** (network/L3–L4) attacks fill a link's bandwidth (like UDP reflection, where open DNS or NTP servers are sent queries with a forged source, and they send answers many times larger to the victim). **Application layer** (L7) attacks look like valid HTTP requests, but exhaust the server's CPU, DB or connections.

The defences for the two are completely different. That is the key point.

**Volumetric.** In `npm run abuse` part B: 300 Gbps of UDP reflection, the origin's link is 10 Gbps, legitimate traffic 0.8 Gbps:

```
design                                        reaches link  legit traffic arrives
origin directly on the internet              300.8 Gbps                3.3%
app rate limit at the origin                   300.8 Gbps                3.3%
behind anycast CDN/scrubbing                   0.8 Gbps              100.0%
CDN, but origin IP leaked (old DNS)      300.8 Gbps                3.3%
leaked IP + CDN allowlist on origin firewall  300.8 Gbps                3.3%
new origin IP, only through the CDN tunnel  0.8 Gbps              100.0%
```

Look at the second row: **the app's rate limit does nothing.** The 10 Gbps pipe is full before the packets ever reach the app. 97% of requests, valid and invalid alike, never reach the app's limiter. What works is a network with more capacity than the attack. 4.5's **anycast** CDN announces the same IP from hundreds of places, so the attack is split across hundreds of PoPs, each absorbing a small share. And traffic like UDP reflection that is not even HTTP is dropped right at the edge.

But the fourth and fifth rows: **a CDN only protects you while the attacker cannot find the origin.** An old DNS record, an email header, a subdomain not behind the CDN — these reveal the origin's real IP. Then the attacker hits the origin directly. And even a rule in the origin's firewall saying "allow only CDN IPs" does not help, because the firewall is on the **inner** side of the link. The packets have to come through the pipe before they can be dropped. The only way is the last row: change the origin's IP, and build the origin so that it accepts no connections from the internet at all. Only an outbound tunnel toward the CDN (like Cloudflare Tunnel), or the cloud provider's private link.

**L7.** Part C: the public share page `/s/:token`, 20,000 IPs × 3 a second, origin capacity 2,000 a second:

```
design                                         req/s at origin  legit requests ok
nothing                                              60,400              3.3%
per-IP 10 req/s                                                      60,400               3.3%
CDN cache (60 s, 300 PoPs), attacker with 5 real tokens   105            100.0%
CDN cache, but busted with ?x=random           60,080              3.3%
normalized cache key (unknown query dropped)            105            100.0%
challenge at the edge (5% of bots pass), no cache      3,400             58.8%
```

- **The per-IP limit is useless again.** 3 a second per IP, limit 10. The same story as 1.7. A distributed attack stays below per-key limits.
- **The CDN cache's power is enormous.** The attacker holds 5 real share tokens. The CDN fetches each page from the origin once every 60 seconds per PoP, so 5 × 300 ÷ 60 = 25 a second. 80% of legitimate traffic is also served from cache. From 60,400 to 105.
- **But Sunday:** `?x=random`. The cache key includes the full URL, so every request is a new key, every one a miss. From 105 back to 60,080. This is a sibling of 4.6's cache penetration, this time deliberate. The remedy is **cache key normalization**: drop query parameters the share page does not recognize from the cache key (or reject the request outright). Back to 105.
- **A challenge at the edge:** for pages that cannot be cached, a challenge or bot score at the edge (a JavaScript challenge, proof-of-work). Here 5% of bots get through, still 3,400 req/s, over capacity. 58.8% succeed — half saved. A challenge alone is not enough when the attack is thirty times capacity.

The lesson: **DDoS defence is not inside the app but in front of it.** Volumetric is stopped by a network bigger than the attack, with an origin behind it that cannot be found. L7 is stopped by caching (the cheapest request is the one that never reaches the origin), cache key discipline, and edge signals (bot scores, challenges, WAF rules, edge rate limits that see data from a thousand PoPs together). The app's own rate limit (9.5) sits **behind all of that**, as the last layer, for fairness per user and per tenant. Not for stopping floods. And one thing that is in no row: trying to "absorb" an L7 flood with autoscaling can work, but the bill arrives at the end of the month. We will see it again in 10.7.

(This model is a simple fluid model. When load exceeds capacity it drops everyone equally. In a real overload, queues, timeouts and retry storms (7.4) make the result worse.)

### 1.9 TaskFlow's decision

> **Trade-off Table — which attack, which layer, what cost**

| Attack / risk            | What works                                                                  | What pretends to work                   | Cost                                                                             |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Forged / misdirected JWT | Algorithm allowlist, trusted key ring, `iss`/`aud`/`exp`, a library         | Matching the signature alone            | Nothing — just discipline                                                        |
| BOLA                     | Authorization in the data-reading path, route × actor matrix test           | UUIDs alone, the token's `role`         | A membership condition on every query                                            |
| Stolen / revoked token   | Short access token + refresh rotation + reuse detection + denylist          | Long-lived stateless JWT                | Load on identity, the denylist's state                                           |
| Stolen OAuth code / bait | State + PKCE (S256) + exact redirect + single-use, short expiry             | Any one of them alone                   | Slow callbacks fail                                                              |
| Leaked secret            | Short lifetimes (dynamic credentials, workload identity), split per service | 90-day rotation alone, deleting history | The secret manager becomes a new hard dependency                                 |
| Credential stuffing      | Failure ratio → challenge, breached password check, MFA / passkeys          | Tightening per-IP / per-email limits    | Hassle for legitimate users (challenges, resets)                                 |
| Volumetric DDoS          | Anycast CDN / scrubbing, a hidden origin (tunnel only)                      | App rate limits, the origin's firewall  | CDN cost, the CDN itself becomes a dependency                                    |
| L7 DDoS                  | CDN cache + cache key normalization, bot scores / challenges at the edge    | Per-IP limits, autoscaling              | Stale data for the cache's lifetime, hassle for legitimate users from challenges |

**Identity (AuthN):** access tokens RS256, 15 minutes, verified with `jose`: an algorithm allowlist, JWKS only from the URL in config (never the token's `jku`), `iss`, `aud` (each API's own), `exp`, 60 s skew. The token carries only `sub`, `jti`, `sid` — no role. Refresh tokens opaque, 30 days, a 12-hour idle timeout, rotation + reuse detection (the whole family cancelled + a security alert + an email to the user). Only their hash is stored in the database. On the web, tokens never reach the browser: an `HttpOnly; Secure; SameSite=Lax` session cookie from the SvelteKit BFF, and a CSRF token on state-changing requests. Denylist: on logout, password change or account disable, identity pushes to every gateway instance (5 s). If identity dies, run on the last list received (10.3). Key rotation: the new key goes into the JWKS 24 hours in advance, the old key is removed after the last token signed with it has died. And a list of "banned `kid`s" in the gateway's config, deployable without identity (10.3's question 2).

**Authorization (AuthZ):** every service itself, in the data-reading path: scoped loaders like `loadBoardFor`, with direct `findByPk` on models forbidden by lint. Roles come from `Membership` (user × workspace). 404 on other people's objects. A route × actor matrix test in CI, generated from the list of routes. A new route without its expected results written down will not merge. Public ids are UUIDs. Export, delete and share-link creation go to an audit log (who, which workspace, how many). And a metric: how many **distinct** boards one user got a 404 on in an hour (from logs, as in 10.4). Something like mallory's script would be caught within an hour.

**OAuth / OIDC:** both "log in with Google" and public API integrations use the authorization code + PKCE (S256), `state`, registration of exact redirect URIs, single-use codes for 60 s, no implicit flow. ID tokens only for the web app's login, never at the API (the API's `aud` is different). Integration tokens have small scopes (`tasks:read`) and are limited to a workspace.

**Secrets:** every secret in a secret manager. A service fetches them at startup with its workload identity, and every read goes to an audit log. Each service gets only its own (now 2–4, previously 10). DB credentials are dynamic (a 1-hour lease). The Stripe key is restricted, billing only. Push protection on git and a full-history scan in CI. Never the `Authorization`, `Cookie` or `Set-Cookie` headers or bodies in logs: 10.4's field allowlist, this time with a test in CI. The runbook's first line: "Leaked secret? Rotate first, ask questions later."

**Login:** 9.5's limits stay (cheap, stop a lone attacker), but the per-IP limit is raised for known office NATs. On top of that, an aggregate failure-ratio detector that turns on a challenge for unfamiliar devices. A breached password check at login and sign-up. MFA mandatory for admin and billing roles, passkeys offered to everyone. An email on login from a new device.

**DDoS:** all traffic behind an anycast CDN, with a WAF and edge rate limits. The origin's IP changed, old DNS records cleaned up, the origin reachable only through the CDN's tunnel. Share pages cacheable (60 s), with only the path in the cache key and unknown query parameters dropped. Edge bot scores on login and sign-up. An upper limit on autoscaling, so a flood does not roll into the bill.

---

## 2. Interview Angle

Security almost never comes up as a separate question. It comes inside a design: "how do you authenticate users?", "is this API multi-tenant safe?", "what if someone DDoSes this?" The weak answer is "we'll use JWT, and Cloudflare." The shape of a good answer:

1. **Name AuthN and AuthZ separately.** "Verify the token at the gateway (once), but authorization in every service, near the data, on every object." This one line alone sets you apart from many candidates.
2. **The token's lifecycle.** Short access tokens, refresh token rotation, how revocation happens. The near-certain follow-up: "JWTs are stateless — so how does logout work?"
3. **Data isolation in multi-tenancy.** A tenant condition on every query, and how you will guarantee it (a scoped repository, Postgres row-level security, tests).
4. **Layers by threat.** At the edge (CDN, WAF, DDoS), at the boundary (gateway: AuthN, rate limits), in services (AuthZ), at the data (encryption, least privilege). At each layer, say which threat it stops.

**Follow-ups that are almost certain:**

- _"JWT or sessions?"_ — two ends of the same question: speed of revocation versus a lookup on every request. In practice, the middle: short JWT + refresh + denylist. Give numbers: a 24-hour JWT keeps working 19.6 hours on average after revocation, a 15-minute one 4.8 minutes, with a denylist 5 seconds.
- _"What goes in a JWT?"_ — identity (`sub`), expiry, `aud`. Not permissions (they change, and differ per tenant), nothing secret (the payload is readable).
- _"Why PKCE in OAuth?"_ — it makes a stolen code useless. And say what it does **not** stop: redirect URI bait. For that, exact matching.
- _"Will you stop DDoS with a rate limit?"_ — no. Volumetric fills the link before it reaches the app. At the edge (anycast CDN / scrubbing) and a hidden origin. For L7, caching and bot signals. The app's rate limit is for fairness.
- _"Password leaks / credential stuffing?"_ — per-IP limits are blind to distributed attacks. An aggregate failure ratio, breached password checks, MFA / passkeys.

**In real production:** the most common mistakes are a home-written JWT verifier, or not telling the library the algorithm. Authorization in the route rather than in the data path, so it gets forgotten on a new route. Trusting the token's `role` or a client-sent `tenant_id`. Long-lived tokens with no revocation. Tokens and secrets in logs. Thinking a `.env` has been "deleted" instead of rotating. One `.env` for every service. Only per-IP limits on login. The origin's IP public even though it is behind a CDN. And letting query strings bust the cache.

---

## 3. Key Takeaway

- **AuthN once, at the boundary; AuthZ on every object, near the data.** Monday's leak of 59,970 boards happened with a valid token. The mistakes were in two routes: one had no check, and one trusted the token's `role`
- **The server decides how a JWT is verified, not the token.** The naive verifier accepts six of eight, two of them forged admins (`alg: none`, RS256→HS256). An allowlist, a trusted key ring, `iss`/`aud`/`exp`, and a tested library
- **UUIDs stop enumeration, not authorization.** Zero in a million guesses, all 340 of 340 leaked ids work. Scoped loaders and a route × actor matrix test (which catches exactly those three cells)
- **A token's lifetime is a knob that turns revocation delay, identity load and outage tolerance together.** A denylist separates them (5 s revocation, 15 minutes of outage tolerance). Refresh rotation alone throws out alice, not the thief. Reuse detection turns 29.6 days into 15 minutes
- **Every OAuth defence has its own attack.** State stops login CSRF, PKCE stops stolen codes, and only exact matching stops redirect bait. An ID token is not a key to the API
- **What goes into git is gone, so rotate first.** A secret's lifetime is what reduces the damage of a leak: 46,312 attacker-days for a static secret, 21,256 with 90-day rotation, 21 with dynamic credentials. Splitting per service cuts the blast radius from 10 to 2–4
- **A distributed attack stays below per-key limits.** 9.5's limits stopped none of 1.2 million, and stopped 946 legitimate users. An aggregate failure ratio + breached check + MFA brings takeovers from 3,547 to 46. Against volumetric DDoS an app rate limit is meaningless; anycast and a hidden origin save you. For L7, caching saves you, as long as you do not let the cache key be busted

---

## 4. New Terms (Glossary)

| Term                               | Meaning                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication / Authorization** | AuthN proves who sent the request; AuthZ decides whether that identity may do this action on this resource. AuthN can happen once at the boundary, AuthZ on every object, near the data                                                                                      |
| **JWT (JSON Web Token)**           | `header.payload.signature`, in base64url. `alg` and `kid` in the header, claims (`sub`, `iss`, `aud`, `exp`) in the payload. Signed, not encrypted. The server decides the verification algorithm and key, not the token                                                     |
| **BOLA**                           | Broken Object Level Authorization (older name IDOR): an API takes an object's id and checks that the user is authenticated, but not whether they have permission on this object. Number one in the OWASP API Top 10                                                          |
| **Refresh Token Rotation**         | A short-lived access token + a long-lived opaque refresh token. Every refresh brings a new refresh token and kills the old one, and if the old one shows up again (reuse) the whole family is cancelled                                                                      |
| **OAuth 2.0 + PKCE / OIDC**        | OAuth: limited permission on a user's behalf, without a password (access token). OIDC: identity on top (ID token). In the authorization code flow, PKCE makes a stolen code useless, state stops login CSRF, exact redirect stops redirect bait                              |
| **Credential Stuffing**            | Distributed, automated login attempts with (email, password) pairs from other sites' breaches. One attempt on each of many accounts, from thousands of IPs, so it stays below per-key limits                                                                                 |
| **DDoS (Volumetric / L7)**         | Making a service unusable with traffic from many sources. Volumetric fills the link's bandwidth (stopped by an anycast CDN / scrubbing and a hidden origin); L7 exhausts the server with valid-looking requests (stopped by caching, cache key discipline, edge bot signals) |

---

## 5. Reflection Questions

Think before you look at the answers. Write at least two or three lines in your own words for each.

1. A new feature has come to TaskFlow: "guest" users, who can be given permission to see the boards of **one specific project** in a workspace, but not the rest of the workspace. (a) How will `loadBoardFor` and `Membership` change? Will the role still stay out of the token, and why? (b) Which new actors and which new cells will you add to the matrix test? Write at least three cells where a mistake is most likely. (c) A guest's permission is removed. They hold a 15-minute access token. How much longer can they see the board, in this lesson's design? Is a denylist needed here?

2. "Log in with Google" is coming to TaskFlow's mobile app. A mobile app is a **public client**, meaning anyone can extract any secret kept inside it by opening the app. (a) Why can't something like the web's client secret be kept on mobile, and how does PKCE fill that gap? (b) Why is an HTTPS "app link" / "universal link" better for the callback than a custom URL scheme (`taskflow://callback`)? Which attack from 1.5 is real here? (c) Where will you keep the refresh token on the phone, and if the phone is stolen, how will the user cancel it?

3. On Thursday afternoon an engineer accidentally pasted the billing service's config into a public GitHub gist. It contains `STRIPE_KEY`, `BILLING_DB_URL` (not dynamic, a static password), and `INTERNAL_SIGNING_KEY` (the key that signs 9.2's internal token, the same in every service). Someone noticed 20 minutes later. (a) Write the runbook for the next hour, in order. Which first, and why? (b) Why is changing `INTERNAL_SIGNING_KEY` harder than the other two, and which services might reject each other's tokens in the meantime? How will you do it safely? (c) Which two things in the design will you change from this incident, so that the same mistake does far less damage next time?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) Permission is no longer only "user × workspace", but "user × workspace **or** user × project". `Membership` gains a `scope`: `{ userId, workspaceId, projectId: null, role }` is a member of the whole workspace, and `{ userId, workspaceId, projectId: 'p-17', role: 'guest' }` is a member of just one project. `loadBoardFor`'s condition becomes:

```
board.workspaceId ∈ (workspaces where the user is a full member)
OR
board.projectId ∈ (projects where the user is a guest)
```

And it has to be separated **by action**. A guest can read, but cannot delete, export or create a share-link for a board. So the loader becomes `loadBoardFor(user, id, action)`, or after loading there is a `can(user, action, board)` that answers from the membership's role.

The role will not go in the token, and here the reason is even clearer. A user can be an admin in one workspace, a member in another, and a guest in one project of a third. Putting all that in a token makes the token large. Worse, when permissions change, the old permissions keep working until the token expires (question c). Identity goes in the token; permissions live in the database.

(b) New actors: "a guest of another project in the same workspace", "a guest of this project", "a guest whose permission has been removed". The cells most likely to be wrong:

- **Guest of another project × `GET /boards/:id`** (same workspace). Expected 404. A buggy loader that only checks `workspaceId` will return 200, because the guest is "associated with this workspace".
- **Guest of this project × `GET /boards/:id/export`** and **× `POST /boards/:id/share-link`**. Expected 403/404. These look "read-like", but export ships all the data, and a share-link turns the guest's permission public — meaning a guest could hand out their own permission to others.
- **Guest of this project × `GET /workspaces/:id/members`** or the activity feed. List-style workspace routes, which take the workspace's id rather than an object's, and are usually written as "show it to any member". BOLA's form on a list route is "leaking the names of other projects' boards in the list".

And one rule is added to the matrix test: on list routes, check not just the status code but **which ids are inside the response**.

(c) `loadBoardFor` reads `Membership` from the database on every request, not from the token. So **from the very next request** after the permission is removed, the guest gets a 404. The access token's 15 minutes play no part here, because the token only says "this is guest-42", and guest-42 no longer has permission. **No denylist is needed here.** A denylist is needed when the identity itself has to be cancelled (account disable, logout, theft). Not for permission changes. This is the biggest benefit of keeping roles out of the token. (A caution: if you put a cache in front of `Membership`, like 4.3, then that cache's TTL is your revocation delay. Invalidate the cache when removing a permission.)

**Question 2:**

(a) On the web, TaskFlow's server holds a client secret, and has to present it when redeeming a code at `/token`. So nobody can redeem a stolen code, because they lack the secret. Anyone can download and open a mobile app's binary, so any "secret" inside it is effectively public. The authorization server knows it is a public client, so it does not ask for a secret. PKCE fills the gap with **a new, one-time secret for every login**. The verifier is generated randomly on the phone at the moment login starts, stays in the phone's memory, and only its hash travels in the URL. Nothing needs to be hidden in the app. Every login creates its own secret.

(b) A custom URL scheme (`taskflow://`) is not owned by any one app. Another app on the same phone can also register `taskflow://`, and the OS may hand the callback to either. This is 1.5's **code theft** attack ("mobile scheme"). PKCE stops it (the thief has no verifier). With an HTTPS app link / universal link, the OS verifies that the domain (`app.taskflow.test`) really has authorized this app to receive the callback (via a file hosted on the domain). So another app cannot claim it. The two together: the app link keeps the code from going to the wrong place at all, and PKCE makes it useless even if it does. And registering the exact redirect URI applies here too.

(c) In the phone OS's secure storage: iOS's Keychain, storage encrypted with Android's Keystore. Not in a plain file or the app's preferences, so it does not end up in backups or in another app's hands. And if possible, bind the refresh token to a device key (DPoP), so a copied token is useless on another device. If the phone is stolen: TaskFlow's web has a list of "active devices" (each refresh token family = one device), and the user presses "log out this device" there. That cancels that family and puts its access tokens' `sid` on the denylist. Changing the password cancels every family.

**Question 3:**

(a) The order is set by **the speed of damage and its reversibility**. The question is which one lets the attacker do the fastest, most irreversible damage:

1. **Minutes 0–5: revoke `STRIPE_KEY` + a new key.** Once money moves it is hard to bring back (Tuesday's refunds). Rolling it is one click in Stripe's dashboard. Put the new key in the secret manager and restart billing. Payments may fail for a few minutes — accept that.
2. **Minutes 5–15: change `BILLING_DB_URL`'s password.** A new password on billing's database, then restart billing, then cancel the old password. Meanwhile look at the database's audit log: were there connections from unfamiliar IPs? If the database is on a private network (it should be), nothing happens from the internet with this password. But don't assume that and delay.
3. **Minutes 15–60: `INTERNAL_SIGNING_KEY`.** With this, an attacker can mint an internal token as any user. But to use it they have to reach the **internal network** (9.2: services are private, the gateway drops the client's internal headers). So it is the most dangerous key, but the least immediate. And it is the hardest (b).
4. In parallel: delete the gist (with a request to GitHub to clear caches), find out who viewed or forked it and when, and announce in the security channel. Deleting the gist is **at the end of the list**, after rotating, because 20 minutes in public means you have to assume it has been copied.

(b) The Stripe key and the DB password are used in one place (billing). `INTERNAL_SIGNING_KEY` is in **six services**. The gateway signs with it, everyone else verifies. Change it everywhere at once, and during the minutes of the deploy some instances will sign with the new key while others still verify with the old key, or vice versa. The result: 401s everywhere. The safe path is 1.2's key rotation, with `kid`:

1. Keep **two** keys for verification in every service (old and new, distinguished by `kid`). Deploy.
2. Make the gateway sign with the new key. Deploy.
3. After 60 s (the internal token's lifetime), remove the old key from every service. Deploy.

Do it as fast as possible, because as long as the old key is accepted for verification, tokens minted by the attacker keep working too. And for the future: a shared symmetric key (HMAC) means every service can sign, not just the gateway. With an asymmetric key (the gateway's private key, only the public key with everyone else), a leaked key from the services lets nobody mint tokens. On a leak, only the gateway's private key needs changing.

(c) Two changes:

- **Make static secrets short-lived.** `BILLING_DB_URL` becomes a dynamic credential (a 1-hour lease). Then even if it leaks it dies within an hour, and nobody has to do anything. The internal token's signing key becomes asymmetric, and nobody outside the gateway holds it. A restricted Stripe key instead of the full one, with only what billing needs (refund permission on a separate key).
- **Separate config from secrets.** The engineer pasted the config because config and secrets lived in one file. With secrets in the secret manager, config holds only their **names** (`STRIPE_KEY_REF=billing/stripe`), not their values. Pasting it does no harm. Plus secret scanning on the company's GitHub org (including public gists, where providers notify directly).

And a third thing almost always comes up in the postmortem: someone noticed within 20 minutes, which is good. But without a runbook the first 20 minutes go to deciding "what do we do". Part (a) of this question is that runbook.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (five deterministic scripts; no network, identity provider, CDN or Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-10.5-security-jwt-oauth-ddos/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.5-security-jwt-oauth-ddos) — `npm install`, then `npm run authz`, `npm run sessions`, `npm run oauth`, `npm run secrets`, `npm run abuse`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`authz` has naive and strict verifiers with real RS256 tokens, a BOLA scan over 60,000 boards, UUIDs versus leaked ids, and the route × actor matrix test. `sessions` runs 60,000 sessions for 8 hours under six token policies (revocation delay, identity load, outage tolerance), plus two refresh-token-theft scenarios. `oauth` has an authorization server and a client, four attacks × five sets of defences, and ID tokens versus access tokens. `secrets` has a secret scanner on a small git history, the lifetime of 1,000 leaks under four policies, and splitting secrets per service. `abuse` has 1.2 million attempts of credential stuffing under six policies, and volumetric and L7 floods.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit` clean, the five scripts twice each, output identical byte for byte. The README's experiments 1, 2, 3 and 4 were run, and the numbers quoted in the lesson (1,759, 1,796, 8,256, 3,297) come from there. 5 and 6 are code-changing tasks — yours. **Every script is in-memory.** The JWTs are real (RS256 with Node's `node:crypto`, a fresh RSA key each run), but the verifier is hand-written, only to show where things break. The OAuth server and client are two classes in one process, with no HTTP redirects. **Assumed numbers**, which are inputs to the model, not measurements: 3% of the list's emails exist on TaskFlow and 10% of those reuse the password; 25% of users have MFA; the breach list knows 85% of real passwords; 10% of bots and 97% of humans pass the challenge; a median of 20 days to catch a leak; push protection catches 80% of git leaks; 30% of legitimate logins come from 40 office NATs. Each can be changed with an environment variable, and the lesson's **lessons** depend on the shape of these numbers, not their exact values. The DDoS part is a simple fluid model, not a real network. **Not measured:** a real identity provider, the `jose` library, a real CDN or WAF, CAPTCHAs, the HIBP API, Vault. The TypeScript code in 1.2 and 1.3 (`authenticate`, `loadBoardFor`) is a design, not something that was run. The claims about RFC 8725, RFC 9700, the OAuth 2.1 draft and the OWASP API Top 10 come from their published writing, not verified here. TaskFlow's decision in 1.9 is a design, not something that was run.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `abuse`, write down: 1.2 million attempts, 38,000 IPs, 6 hours. How many attempts will 9.5's limits (20 per IP per hour, 10 per email per hour) stop? Then run it and compare. Now `BOT_IPS=5000` and `BOT_IPS=1000`. From what point does the per-IP limit start working, and what does it cost the attacker to avoid that point?

2. **New route, old mistake:** add `GET /boards/:id/comments` to `routes()` in `src/authz.ts` with `guarded(() => true, 200)`. What does the matrix test say? Now change things so that no route can even **load** a board without checking permission: build a `loadBoardFor(principal, id)`, and forbid `boards.get` directly. Now try to make the same mistake. Where does it get stopped?

3. **Revocation delay:** `PUSH_SECONDS=60 npm run sessions`. In the denylist row, what is the average after revocation? Which column did not change, and why? Now think: if the denylist push came not from identity but from a Redis pub/sub (7.2), and Redis was down for five minutes, what happens?

4. **PKCE's `plain`:** in `src/oauth.ts`, replace `s256` with challenge = verifier (the `plain` method). Is the stolen-code attack still stopped? In what situation does the difference between `plain` and `S256` actually matter? (Hint: if the attacker can also see the authorization request's URL.)

5. **The design part:** a one-page security plan for TaskFlow's **public API**. Outside developers will build integrations. (a) API keys or OAuth? Which in which case (say a company's own script versus a marketplace app used by many companies)? (b) The list of scopes, and how you will guarantee a token stays limited to one workspace. (c) If an API key leaks (in a public repo, as in question 3), how will the developer find out, and what will TaskFlow do? (d) Rate limiting: per key, per workspace, or both (9.5)? And an integration that suddenly sends 10,000 requests a second — is it a DDoS, a bug, or legitimate? How will you tell? (e) Which one event will you page on (like 10.4's burn rate), and which only gets a ticket?

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1, 2, 3, 4, 5, 6, 7, 8, 9 (complete, with exit challenges), 10.1, 10.2, 10.3, 10.4
Current: 10.5 — Security at scale: authN vs authZ, OAuth/JWT, secret management, DDoS
TaskFlow state: modular monolith + billing service; gateway + BFF; saga; breaker + bulkhead; rate limits
in two layers; cache ring; Bloom/HLL; hard/soft dependencies + fault injection; brownout; OpenTelemetry,
structured logs, histograms, tail sampling, burn rate alerts. A bad week: BOLA on the export route
(sequential ids, 59,970 boards of others), DELETE trusted the token's role; .env in git history (Stripe
live, JWT secret, DB password); the Authorization header in logs; 24 h JWT, no revocation (a fired
employee, all day); credential stuffing, 1.2 million attempts from 38,000 IPs → 3,547 takeovers, 9.5's
limits stopped none and stopped 946 office-NAT users; L7 flood on the share page busting the cache with ?x=.
Now: access tokens RS256 15 min (jose, alg allowlist, JWKS from config, iss/aud/exp), no role in the
token; opaque refresh 30 days + rotation + reuse detection (family cancelled + alert), stored as a hash;
the BFF's HttpOnly cookie on the web; denylist push 5 s; key rotation + a banned-kid list. AuthZ: scoped
loaders (loadBoardFor), roles from Membership, 404 on others' objects, a route × actor matrix test in
CI, UUIDs, audit log, a "404s on distinct boards" metric. OAuth/OIDC: code + PKCE S256 + state + exact
redirect + single-use 60 s; ID tokens not at the API. Secrets: secret manager + workload identity, split
per service, dynamic DB credentials, push protection + history scan, auth headers banned from logs (CI
test), runbook "rotate first". Login: 9.5 + failure ratio → challenge + breached password check + MFA
(mandatory for admins) + new-device email. DDoS: anycast CDN + WAF, a new origin IP reachable only
through a tunnel, share page cache key normalized, an autoscaling cap
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot, Probabilistic Data Structure, Bloom Filter,
False Positive Rate, Counting Bloom Filter, Cardinality, HyperLogLog, Count-Min Sketch, Fault Tolerance,
Hard / Soft Dependency, Graceful Degradation, Brownout, Static Stability, Chaos Engineering, Blast Radius,
Observability, Histogram, Label Cardinality, Structured Logging, Trace / Span, Tail Sampling, Burn Rate,
Authentication / Authorization, JWT, BOLA, Refresh Token Rotation, OAuth 2.0 + PKCE / OIDC, Credential
Stuffing, DDoS (Volumetric / L7)
Weak spots: [where you got stuck — write it yourself]
Next: 10.6 — Deployment: blue-green, canary, feature flag, zero-downtime migration
=======================
```

---

## 8. Next Step

Today's thread: **the door is not the security.** TaskFlow's login was fine, the gateway was fine, and every incident of the week happened after them or around them. One route forgot to ask "is this yours?". One token could not be taken back. One secret was "deleted" but never gone. And attacks came from a thousand hands, each below the limit. Every defence has a specific threat, and "we use X" is never an answer until you say which attack X stops, and which it does **not**.

Notice that many of this week's fixes hinge on one task: **changing things safely.** Rotating a key across six services at once so nobody rejects anybody. Replacing `findByPk` with a scoped loader in a running system. A new `scope` column on the `Membership` table, under 60,000 boards, with no downtime. When you are ready, write `next` — we go to **Lesson 10.6: Deployment — Blue-Green, Canary, Feature Flag, Zero-Downtime Migration**. The question there: how to bring a change into production so that if it is wrong, it touches few people, for a short time, and can be rolled back with one click. And how to change a database schema while old and new code are reading the same table at the same time.
