# TaskFlow Security Lab - JWT, BOLA, Revocation, OAuth, Secret, Credential Stuffing, DDoS

> Lesson 10.5 - Security at Scale: AuthN vs AuthZ, OAuth/JWT, Secret Management, DDoS · **Tier 1 - Runnable Code**
> (পাঁচটা deterministic script; কোনো network, identity provider, CDN বা Docker লাগে না)

## কী বানাচ্ছি

TaskFlow এর খারাপ সপ্তাহটা - অন্যের board export, ফাঁস হওয়া `.env`, log এ token, এক রাতে সাড়ে তিন হাজার account দখল,
আর share page এর flood - পাঁচটা script এ। প্রতিটা script একটা প্রশ্নের উত্তর মাপে: কোন প্রতিরক্ষা কোন আক্রমণ আটকায়,
কোনটা আটকায় **না**, আর তার দাম কী।

| Script             | প্রশ্ন                                                                                                                          | Lesson §  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run authz`    | হাতে লেখা JWT যাচাই কোন জাল token নেয়? বৈধ token নিয়ে অন্যের board পড়া যায় কোন route এ? UUID কি সমাধান? Matrix test কী ধরে? | ১.২ – ১.৩ |
| `npm run sessions` | Access token এর মেয়াদ ২৪ ঘ / ১৫ মি / ৫ মি - revoke এর পরে কতক্ষণ চলে, identity তে কত call? চুরি হওয়া refresh token কতদিন চলে? | ১.৪       |
| `npm run oauth`    | Authorization code flow এ চারটা আক্রমণ - state, PKCE, exact redirect, single-use এর কোনটা কোনটাকে আটকায়?                       | ১.৫       |
| `npm run secrets`  | `.env` মুছে দেওয়া commit কি secret মোছে? Rotation আর dynamic credential এ ফাঁস হওয়া secret কতদিন কাজ করে?                     | ১.৬       |
| `npm run abuse`    | ৩৮,০০০ IP এর credential stuffing এ 9.5 এর login limit কী করে? Volumetric আর L7 flood এ কোন স্তর বাঁচায়?                        | ১.৭ – ১.৮ |

**সৎ নোট:**

- **সব script in-memory, কোনো network নেই।** JWT গুলো আসল - Node এর `node:crypto` দিয়ে RS256 sign আর verify, প্রতি run এ
  নতুন RSA key। OAuth এর authorization server আর client একটা process এর ভেতরে দুটো class, HTTP redirect নেই।
- **Output deterministic।** এলোমেলো যা আছে (RSA key, state, PKCE verifier, UUID) তা ফলাফল বদলায় না; বাকি সব seed দেওয়া
  PRNG। পাঁচটা script দুবার করে চালিয়ে output byte ধরে হুবহু এক পাওয়া গেছে।
- **ধরে নেওয়া সংখ্যা** - এগুলো model এর input, মাপা না: credential তালিকার ৩% email TaskFlow এ আছে, তাদের ১০% একই password
  ব্যবহার করে; ২৫% user এর MFA; breach corpus আসল তালিকার ৮৫% password জানে; challenge bot ১০% পার হয়, মানুষ ৯৭%; ফাঁস
  হওয়া secret ধরা পড়তে median ২০ দিন; push protection git এর ফাঁসের ৮০% আটকায়; ৩০% বৈধ login ৪০টা office NAT এর পেছন
  থেকে। প্রতিটা environment variable দিয়ে বদলানো যায়।
- **DDoS এর অংশ একটা সরল fluid model** - ক্ষমতার বেশি load এলে সবাইকে সমান ভাগে ফেলে। আসল overload এ queue, timeout আর
  retry মিলে ফল আরও খারাপ হয়।
- **JWT library নিজের হাতে লেখা শুধু দেখানোর জন্য** - কোন ভুল কীভাবে ঘটে। Production এ `jose` এর মতো পরীক্ষিত library,
  algorithm এর allowlist সহ।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে, output হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run authz
npm run sessions
npm run oauth
npm run secrets
npm run abuse
```

`abuse` সবচেয়ে ভারী - ১২ লাখ চেষ্টা ছয়টা নীতিতে, ~১০ সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run authz` - naive verifier আটটার মধ্যে ছয়টা token নেয়, তার দুটো জাল `admin`; strict একটাই নেয়। দুটো route
অন্যের ৫৯,৯৭০টা board দেয়, আর matrix test ঠিক সেই তিনটা ঘর ধরে:

```
alg: none, empty signature                 200 (admin)  401 alg none not in the allowlist
HS256, signed using the public key as the secret  200 (admin)  401 alg HS256 not in the allowlist
naive accepted 6/8, strict 1/8

GET    /boards/:id/export                   59,970          59,970
DELETE /boards/:id                          59,970          59,970

guessing random UUIDs              1,000,000          0
ids from a leaked support log          340        340

3 cells failed - with this test in CI it would have been caught before merge
```

`npm run sessions` - মেয়াদ ছোট করলে revoke দ্রুত, কিন্তু identity তে call বাড়ে; denylist দুটো আলাদা করে:

```
JWT 24 h, no revoke                     0.0     0.0%     19.6 h    24.0 h    24.0 h
session lookup on every request      299.9   100.0%        0 s       0 s       0 s
access 15 min + refresh                43.7    14.6%     4.8 min   15 min  15 min
access 15 min + refresh + denylist     43.7    14.6%        5 s       5 s   15 min

stolen Monday 10:00, alice at work
no rotation                       29.6 days   0     0
rotation + reuse detection           15 min   1     1
```

`npm run oauth` - redirect_uri এর টোপ শুধু exact match এ আটকায়, PKCE তে না:

```
Code theft (mobile scheme / log), mallory redeems first  succeeded ✗  succeeded ✗  blocked  blocked  blocked
redirect_uri bait (open redirect), mallory's PKCE  succeeded ✗  succeeded ✗  succeeded ✗  succeeded ✗  blocked
```

`npm run secrets` - HEAD এ শূন্য, history তে তিনটা আসল secret; rotation একা ফাঁসের সময় খুব একটা কমায় না:

```
real production secrets: 3 in history, 0 at HEAD - the "oops remove .env" commit deleted nothing

static secret, never changes    1,000     19.1 days  117.3 days   76.6%     46,312
rotate every 90 days            1,000     13.5 days   54.5 days   70.5%     21,256
dynamic credential (60 min lease)  1,000        30 min      54 min    0.0%         21
```

`npm run abuse` - 9.5 এর login limit একটা bot কেও থামায় না, কিন্তু বৈধ office user থামায়:

```
5.3 attempts per IP per hour on average, once per email on average; the password really matches for 3,547 accounts on the list
9.5: IP 20/h + email 10/h               1,200,000    3,547      946 (4.7%)        0     -
9.5 + failure ratio → challenge           123,183      395    1,104 (5.5%)    4,935  1 min
all + MFA (25% of users)                  123,183       46    1,104 (5.5%)    6,137  1 min

leaked IP + CDN allowlist on origin firewall  300.8 Gbps     3.3%
CDN cache, but busted with ?x=random    60,080     3.3%
normalized cache key (unknown query dropped)   105   100.0%
```

## কী দেখার জন্য এটা বানানো

- **Signature মেলা মানে token বিশ্বাসযোগ্য না।** Verifier যদি token এর header থেকে algorithm নেয়, তাহলে `alg: none` আর
  "public key কে HMAC secret" - দুটোই জাল `admin` token কে পাশ করায়। Algorithm, key, `iss`, `aud`, `exp` - সব server ঠিক
  করে, token না।
- **AuthN ঠিক থাকলেও AuthZ এর একটা ফাঁকা route পুরো data দেয়।** আটটা route এর ছয়টা ঠিক; একটা check ভুলে গেছে, আরেকটা
  token এর `role: admin` কে বিশ্বাস করেছে - দুটোই ৫৯,৯৭০টা board। UUID অনুমান থামায়, কিন্তু ফাঁস হওয়া id থামায় না।
- **Token এর মেয়াদ একটা knob, যা দুটো জিনিস একসাথে ঘোরায়** - revoke এর দেরি আর identity outage সহ্য করার সময়। Denylist
  এই দুটোকে আলাদা করে।
- **Refresh token rotation এর আসল শক্তি reuse detection এ** - শুধু rotation চোর কে থামায় না, বৈধ user কে বের করে দেয়।
- **OAuth এর প্রতিটা প্রতিরক্ষা একটা নির্দিষ্ট আক্রমণের জন্য।** PKCE চুরি হওয়া code থামায়, redirect এর টোপ না।
- **Git history তে যা গেছে তা গেছে** - প্রথম কাজ rotate করা, history মোছা না। আর ফাঁসের ক্ষতি কমায় secret এর আয়ু
  ছোট করা, rotation এর ক্যালেন্ডার না।
- **Credential stuffing প্রতি IP আর প্রতি email এর সীমার নিচে থাকে** - ধরতে হয় সামগ্রিক failure ratio আর password এর
  নিজের অবস্থা (breached কিনা, MFA আছে কিনা) দিয়ে।
- **Volumetric DDoS app এ পৌঁছানোর আগেই link ভরে দেয়** - app এর rate limit আর origin এর firewall কিছু করে না; বাঁচায়
  CDN/scrubbing আর একটা গোপন origin।

## নিজে ভেঙে দেখুন (Experiments)

1. **কম IP এর botnet:** `BOT_IPS=5000 npm run abuse`. প্রতি IP এ ঘণ্টায় ৪০ চেষ্টা - এবার 9.5 এর সীমা কতটা আটকাল
   (মাপা: দখল ৩,৫৪৭ → ১,৭৫৯)? আক্রমণকারীর জন্য এর সমাধান কত সস্তা?
2. **CAPTCHA farm:** `BOT_SOLVE=0.5 npm run abuse`. Challenge এর সারিতে দখল ৩৯৫ থেকে কত হলো (মাপা: ১,৭৯৬)? কোন সারিটা
   প্রায় বদলায়নি, আর কেন?
3. **দ্রুত ধরা বনাম ছোট আয়ু:** `DETECT_MEDIAN_DAYS=3 npm run secrets`, তারপর `ROTATE_DAYS=7 npm run secrets`. ধরা পড়া দ্রুত
   করলে আর rotation ঘন করলে "মোট attacker-দিন" কত হয়? Dynamic credential এর সারি কি বদলায়?
4. **Denylist এর দেরি:** `PUSH_SECONDS=60 npm run sessions`. Revoke এর পরে গড় কত হলো? কোন কলামটা বদলায়নি?
5. **নতুন route, পুরনো ভুল:** `src/authz.ts` এর `routes()` এ `GET /boards/:id/comments` যোগ করুন `guarded(() => true, 200)`
   দিয়ে। Matrix test কী বলে? এবার এমনভাবে বদলান যাতে কোনো route board টা **load করতেই না পারে** permission না দেখে -
   একটা `loadBoardFor(principal, id)` বানান, `boards.get` সরাসরি নিষেধ।
6. **PKCE এর `plain`:** `src/oauth.ts` এ `s256` এর বদলে challenge = verifier (`plain` method) করুন। চুরি হওয়া code এর
   আক্রমণ কি এখনও আটকায়? কোন অবস্থায় `plain` আর `S256` এর পার্থক্য আসল?

## Project Structure

```
src/
  util.ts       seed দেওয়া PRNG, lognormal, percentile, সময়ের format, grapheme-সচেতন টেবিল
  jwt.ts        RS256 sign; naive verifier (header এর alg মানে) আর strict verifier (allowlist, kid, iss, aud, exp)
  authz.ts      script ক - জাল token এর matrix, BOLA scan, UUID, route × actor authorization test
  sessions.ts   script খ - ৬০,০০০ session এর ৮ ঘণ্টা: মেয়াদ, refresh এর load, revoke এর দেরি; refresh token চুরি
  oauth.ts      script গ - authorization server + client, চারটা আক্রমণ × পাঁচটা প্রতিরক্ষা, ID token বনাম access token
  secrets.ts    script ঘ - git history scanner, ফাঁসের আয়ু চারটা নীতিতে, service ধরে secret ভাগ
  abuse.ts      script ঙ - credential stuffing ছয়টা নীতিতে, volumetric আর L7 flood
```

Environment variable: `WORKSPACES`, `BOARDS_PER_WORKSPACE`, `LEAKED_IDS`, `UUID_GUESSES`, `SESSIONS`, `RPS`, `HOURS`,
`REVOCATIONS`, `PUSH_SECONDS`, `LEAKS`, `DETECT_MEDIAN_DAYS`, `ROTATE_DAYS`, `LEASE_MINUTES`, `PUSH_PROTECTION`, `ATTEMPTS`,
`BOT_IPS`, `ATTACK_MINUTES`, `HIT_RATE`, `REUSE`, `LEGIT_LOGINS`, `MFA`, `CORPUS`, `BOT_SOLVE`, `SEED`।
