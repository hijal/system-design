# TaskFlow Gateway & BFF Lab - একটা দরজা, প্রতিটা frontend এর নিজের backend

> Lesson 9.2 - Service Communication, API Gateway, BFF · **Tier 1 - Runnable Code** (আলাদা Node process গুলো আলাদা service; Docker লাগে না)

## কী বানাচ্ছি

TaskFlow এর তিনটা service (tasks, users, comments) - প্রতিটা তার **পুরো** object ফেরত দেয়। তাদের সামনে দুটো জিনিস:
একটা **BFF** (Backend for Frontend - web আর mobile এর জন্য আলাদা), আর একটা **API gateway**। দুটো script:

| Script            | প্রশ্ন                                                                                                                              | Lesson §  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run bff`     | "Task detail" page - browser নিজে তিনটা service ডাকে, নাকি একটা BFF? কয়টা request, কয় ধাপ, কত byte, কত সময় - desktop আর mobile এ | ১.২ – ১.৩ |
| `npm run gateway` | Gateway এর বাড়তি hop এর দাম; token কোথায় যাচাই হয়, আর gateway এড়িয়ে service এ পৌঁছালে কী হয়; user ধরে canary routing          | ১.৪ – ১.৫ |

**সৎ নোট:**

- Browser এর network একটা **model** (`link.ts`): প্রতিটা request এ একটা round trip (RTT), আর উত্তরের byte গুলো একটা ভাগ করা
  পাইপে (bandwidth)। TCP slow start, TLS handshake, packet loss, HTTP/2 এর খুঁটিনাটি - নেই। সার্ভারের কাজ আসল (localhost এ আসল HTTP)।
  দুটো profile: desktop (RTT 20 ms, 50 Mbps) আর mobile (RTT 100 ms, 5 Mbps) - বাছাই করা, মাপা না।
- Data center এর ভেতরের দেরি `NET_MS` (default 1 ms) - tasks/users/comments এর প্রতিটা উত্তরে যোগ হয়, দুই পথেই।
- **`fetch` না, `node:http`।** Node 26 এর built-in `fetch` এ এই machine এ একটা অদ্ভুততা পাওয়া গেছে: অল্প বিরতির (১০ ms) পরে পরের
  request প্রায়ই ~৫০০ ms দেরি করে - localhost এও, একই process এর server এও; `node:http` এ একই request ~১ ms। এই exercise এর
  browser model এ round trip এর ফাঁক ঠিক এমন বিরতি, তাই `http.ts` এ একটা ছোট keep-alive client। (কারণটা খুঁজে বের করা হয়নি -
  শুধু মাপা আর এড়ানো হয়েছে।)
- Gateway একটা খেলনা (Express + একটা proxy) - আসল gateway (Envoy, Kong, AWS API Gateway, NGINX) দ্রুত আর অনেক বেশি কাজ করে।
  Token HS256 JWT, secret গুলো code এ নির্দিষ্ট - আসল system এ secret manager (Lesson 10.5), আর প্রায়ই asymmetric (RS256/ES256)।
- `gateway` এর "gateway এড়িয়ে সরাসরি service এ" মানে service এর port টা বাইরে থেকে পৌঁছানো যায় - আসল system এ এটা একটা ভুল
  configuration (বা SSRF) এর ফল; এখানে সব localhost, তাই সরাসরি ডাকা যায়।
- যাচাই করা হয়েছে Node 26 এ; সময় machine ভেদে বদলাবে, request, ধাপ, byte, status আর canary এর গোনা বদলাবে না।

## Prerequisite

Node.js 22+। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run bff       # ~15 seconds
npm run gateway   # ~30 seconds
```

Teardown: কিছু লাগে না - script শেষে সব process বন্ধ করে।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run bff` (এই machine এ):

```
── "Task detail" page: task + assignee + 20 comments + authors · 1 ms per call inside the data center · 40 times ──
   path                           browser network                requests  steps  to browser        p50        p95
   browser → services, direct     desktop (RTT 20 ms, 50 Mbps)          4      3     25.2 KB    71.5 ms    74.1 ms
   browser → web BFF              desktop (RTT 20 ms, 50 Mbps)          1      1     10.2 KB    28.9 ms    30.3 ms
   browser → services, direct     mobile (RTT 100 ms, 5 Mbps)           4      3     25.2 KB   348.7 ms   350.9 ms
   browser → web BFF              mobile (RTT 100 ms, 5 Mbps)           1      1     10.2 KB   123.6 ms   125.0 ms
   app → mobile BFF               mobile (RTT 100 ms, 5 Mbps)           1      1      1.8 KB   109.2 ms   110.3 ms
```

মিলতে হবে: web BFF এর page আর browser এর নিজের জোড়া দেওয়া page হুবহু একই (script নিজে যাচাই করে, না মিললে থামে); request,
ধাপ আর byte প্রতিবার একই; সরাসরি পথ মোটামুটি ৩ × RTT, BFF ১ × RTT।

`npm run gateway`:

```
── a. Extra hop: tasks service directly vs through the gateway (token check + proxy) ──
   path                               1 client p50  16 clients: req/s        p50        p99   gateway CPU / request
   client → tasks (direct)                  0.2 ms              11982     1.2 ms     2.7 ms   -
   client → gateway → tasks                 0.4 ms               6312     2.4 ms     3.9 ms   0.2 ms

── b. Who sent it? - the gateway's check, and bypassing the gateway to the service directly ──
   request                                                    trust mode                       signed mode
   gateway, no token                                          401                              401
   gateway, valid token for user 42                           200 · user 42                    200 · user 42
   gateway, valid token + self-set x-user-id: 1               200 · user 42                    200 · user 42
   gateway, expired token                                     401                              401
   gateway, token made with another secret (sub: 1)           401                              401
   service directly (bypassing gateway), x-user-id: 1         200 · user 1 ← impersonated      401
   service directly, real x-internal-auth 70 s old (user 42)  -                                401

── c. The thumbnail route: old path (monolith) vs new files service - 1000 users, 2 times each ──
   canary %   to new service    old path     same side both times
         0%                0        1000                     100%
        10%              104         896                     100%
        50%              499         501                     100%
       100%             1000           0                     100%
```

মিলতে হবে: খ আর গ প্রতিবার হুবহু একই; ক তে gateway এর পথ একা থাকলে কয়েক দশমাংশ ms বেশি, আর একটা gateway process এর
ভেতর দিয়ে ব্যস্ত সময়ে req/s মোটামুটি অর্ধেক।

## কী দেখার জন্য এটা বানানো

- **ধাপ গুনুন, request না:** সরাসরি পথে ৪টা request কিন্তু ৩টা **ধাপ** - task না এলে assignee আর comment জানা যায় না, comment
  না এলে author। প্রতিটা ধাপ একটা পুরো round trip। Mobile এ ৩ × ১০০ ms = ৩০০ ms শুধু অপেক্ষা; BFF এ সেই তিন ধাপ data center এর
  ভেতরে, ১ ms করে।
- **Byte:** service গুলো পুরো object দেয় (settings, checklist, custom field) - page এর দরকার নেই। Browser এ ২৫ KB; web BFF
  ১০ KB; mobile BFF ১.৮ KB (ছোট পর্দা - বিবরণ ২০০ অক্ষর, শেষ ৫টা comment)। Mobile এর 5 Mbps এ ২৫ KB মানে ~৪০ ms শুধু byte।
- **Gateway বিনামূল্যে না:** একা থাকলে +০.২ ms, কিন্তু প্রতিটা request এ gateway এর CPU ০.২ ms - একটা gateway process সরাসরির
  অর্ধেক req/s দেয়। মানে gateway নিজে scale করতে হয়, আর সে সবার পথে।
- **পরিচয় সীমানায় শেষ হয় না:** trust mode এ service `x-user-id` বিশ্বাস করে - gateway এর ভেতর দিয়ে এলে নিরাপদ (gateway client
  এর header ফেলে দিয়ে নিজে বসায়), কিন্তু কেউ service এ সরাসরি পৌঁছালে যে কেউ যে কেউ হতে পারে। Signed mode এ service gateway
  এর sign যাচাই করে - সরাসরি এলে 401, আর পুরনো sign (৭০ s) ও 401।
- **Canary:** user id এর hash ধরে ভাগ - ১০% মানে ~১০% user, আর একজন user সবসময় একই দিকে (১০০%)।

## নিজে ভেঙে দেখুন (Experiments)

1. **Data center এর ভেতর ধীর হলে:** `NET_MS=5 npm run bff`। BFF এর সুবিধা কি হারায়? কেন না? (এই machine এ: mobile এ সরাসরি
   ৩৬১ ms, web BFF ১৩৭ ms, mobile BFF ১২২ ms - ভেতরের ৩ ধাপ × ৫ ms বাইরের ৩ ধাপ × ১০০ ms এর চেয়ে অনেক সস্তা।)
2. **Waterfall আরও লম্বা** (code বদলানো): `bff.ts` এর `directPage` এ ধাপ ২ এর `Promise.all` সরিয়ে একটা একটা করে `await` করুন
   (assignee, তারপর comment)। Mobile এ সময় কত হবে - আগে হিসাব করুন, তারপর চালান। BFF এর ভেতরে একই ভুল করলে কত ক্ষতি?
3. **Sign এর দাম** (code বদলানো): `gateway.ts` এর `hopCost` এ দুটো process এর `AUTH_MODE` `'signed'` করুন। Gateway এর CPU /
   request কত বাড়ল? (HMAC-SHA256 - microsecond এর ঘরে হওয়ার কথা; RS256 এর যাচাই এর চেয়ে অনেক সস্তা।)
4. **কম user এ canary:** `USERS=100 npm run gateway` - ১০% এ কয়জন? (এই machine এ: ১০, ৫০% এ ৪৯।) ১০ জন user এর একটা workspace এ
   ১০% canary এর মানে কী - আর workspace ধরে ভাগ করলে (user ধরে না) কী সুবিধা, কী অসুবিধা?
5. **Mobile BFF এর আকৃতি** (code বদলানো): `service.ts` এর BFF এ mobile এর জন্য `description` পুরো বাদ দিন আর comment ৩টা করুন।
   Byte আর সময় কত কমল? কোন বিন্দুর পরে byte কমিয়ে আর লাভ নেই - আর কেন (RTT)?

## Project Structure

```
lesson-9.2-gateway-bff/
├── package.json
├── tsconfig.json        # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
├── README.md
└── src/
    ├── domain.ts        # user, task, comment - পুরো object (service যা দেয়), আর page এর আকৃতি (BFF যা দেয়)
    ├── service.ts       # একটা process: ROLE = tasks | users | comments | bff | gateway | files-old | files-new
    ├── token.ts         # HS256 JWT (user এর token) আর gateway এর signed internal header
    ├── http.ts          # node:http keep-alive GET client (fetch এর ৫০০ ms এর অদ্ভুততা এড়াতে)
    ├── link.ts          # browser এর network এর model - RTT + ভাগ করা bandwidth
    ├── cluster.ts       # process চালানো/থামানো, IPC তে port আর CPU
    ├── bff.ts           # সরাসরি বনাম web BFF বনাম mobile BFF
    ├── gateway.ts       # hop এর দাম, পরিচয়, canary
    └── random.ts        # percentile, format
```

সব env: `PAGES` (40), `NET_MS` (1) - bff; `CONCURRENCY` (16), `DURATION_MS` (5000), `USERS` (1000) - gateway।
