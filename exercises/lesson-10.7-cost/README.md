# TaskFlow Cost Lab — বিল, Unit Economics, Capacity, Commitment, Storage Tier, Data Transfer

> Lesson 10.7 — Cost & Cloud Economics · **Tier 1 — Runnable Code**
> (চারটা deterministic cost model; কোনো cloud account, network বা Docker লাগে না)

## কী বানাচ্ছি

TaskFlow এর মাসের cloud বিল, লাইন ধরে, প্রতিটা লাইন আগের কোনো lesson এর একটা design সিদ্ধান্তের সাথে বাঁধা। তারপর চারটা
প্রশ্ন: কোন plan আর কোন endpoint কত খরচ করে, peak আর গড়ের মাঝে কত টাকা পড়ে থাকে, data কোথায় রাখলে কত, আর bytes কোথায়
নড়লে কত।

| Script             | প্রশ্ন                                                                                                                | Lesson §       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| `npm run bill`     | মাসিক বিল ২৩টা লাইনে, আগে আর পরে; plan ধরে unit economics; endpoint ধরে খরচ; একটা cost anomaly কোন detector কখন ধরে   | ১.১ – ১.২, ১.৬ |
| `npm run capacity` | এক সপ্তাহের traffic এ স্থির, autoscale, scheduled আর spot; কত instance commit করবে; একটা DDoS কোথায় থামালে কত বিল    | ১.৩, ১.৫       |
| `npm run storage`  | ২৪ মাসে attachment এর storage class আর lifecycle; ছোট object এর ফাঁদ; log এর ঢোকানো বনাম রাখা; পুরনো activity কোথায়  | ১.৪            |
| `npm run traffic`  | Egress (compression, CDN, preview), NAT বনাম VPC endpoint, আর AZ জুড়ে traffic (monolith, service, AZ-aware, replica) | ১.৫            |

**সৎ নোট:**

- **দাম আনুমানিক।** `src/prices.ts` এ সব দাম এক জায়গায় — একটা বড় public cloud এর তালিকা মূল্যের আন্দাজ (us-east এর মতো
  region, on-demand), Lesson 8.1 এর সংখ্যার সাথে মিলিয়ে। দাম region, provider, সময় আর চুক্তি ভেদে বদলায়; এখানে যাচাই
  করা না। প্রতিটা দাম environment variable দিয়ে বদলানো যায় (`PRICE_*`, `COMMIT_DISCOUNT`, `SPOT_SHARE_OF_ON_DEMAND`)।
- **TaskFlow এর পরিমাণও ধরে নেওয়া** — ৩০০ req/s, ৬০,০০০ MAU, ২,০০০ workspace, ১৮ TB attachment (8.1), দিনে ২.৮ GB log
  (10.4), প্রতি request এ ৬টা ভেতরের call — আগের lesson গুলোর সংখ্যা থেকে। শিক্ষা নির্ভর করে লাইনগুলোর **অনুপাত** আর
  **আকৃতির** উপর, নির্দিষ্ট ডলারের উপর না।
- **`capacity` একটা মিনিট ধরে simulation** — seed দেওয়া noise, একটা marketing spike, instance চালু হতে ৫ মিনিট, ১৫ মিনিটের
  cooldown। Spot এর interruption একটা ঘণ্টা প্রতি সম্ভাবনা, আসল spot market না।
- **`bill` এর app instance এর লাইন `capacity` এর একই model থেকে আসে** (`src/fleet.ts`), তাই দুটোর সংখ্যা মেলে।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু
  এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run bill
npm run capacity
npm run storage
npm run traffic
```

প্রতিটা এক সেকেন্ডের কম।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run bill` — সবচেয়ে বড় লাইন production এর না; network এর লাইনগুলো compute এর চেয়ে বড়; একটা endpoint ০.০১৩% call এ
খরচের ২৫%:

```
staging + dev (prod এর মাপে, ২৪/৭)            $4,701   17.9%      $420    $4,281                        ¼ মাপ, শুধু কাজের সময়
NAT gateway (ঘণ্টা + প্রতি GB)                    $3,001   11.4%      $139    $2,862     S3 gateway endpoint, image endpoint
app instance (peak এর মাপে, 20টা ২৪/৭)         $2,803   10.7%      $869    $1,934           autoscale (গড় 7.6), 5টা commit
মোট                                         $26,290    100%    $8,276   $18,014                                  69% কম

POST /boards/:id/export           60,000      $0.011       $10,920      $655    0.013%       25%

প্রতি ভাগ দৈনিক > নিজের ৭ দিনের গড় × ১.৫                         1 দিন পরে           1 দিন পরে                     0
```

`npm run capacity` — peak ধরে স্থির fleet এর ২০% ব্যবহার; commit এর সেরা বিন্দু যেখানে ব্যবহার ৬৫% সময়ের বেশি:

```
স্থির: peak + ২৫%, ২৪/৭                         20.0      $2,803         20%          0       0 (0.00%)
reactive autoscale (লক্ষ্য 60%)                   7.6      $1,072         53%          4  15,252 (0.01%)
5  ← সবচেয়ে কম              $869               18.9%                           79%          $27.97
origin এ autoscale, কোনো সীমা নেই                      1,334    $1,025        $2,333             $0    $3,357
edge এ block / challenge (১ KB উত্তর)                   0        $0        $73.44           $648      $721
```

`npm run storage` — "সস্তা" class এ ছোট object বেশি দামি; log এর দাম ঢোকানোয়:

```
সব Standard, পুরনো version চিরকাল                       $775    $2,066       $32,424             $0             $0
+ শুধু ≥১২৮ KB IA, ১৮০ দিনে Glacier IR                  $126      $479        $7,445           $462           $364
Standard                  25,000,000        1.0 TB        $276
IA (transition সহ)        25,000,000        3.2 TB        $730
প্রতি request এ একটা লাইন (10.4)            2.8        $42.00                 $1.18                 $7.56                $30.66                 $2.77
```

`npm run traffic` — S3 এর traffic NAT দিয়ে গেলে মাসে ~$৩,০০০; gateway endpoint এ প্রায় শূন্য:

```
সব NAT দিয়ে, প্রতি AZ এ একটা NAT                         64.5 TB      $3,001                             আজকের TaskFlow
+ S3 gateway endpoint                               4.5 TB        $301                    gateway endpoint বিনা মূল্যে
service, যেকোনো AZ এ পাঠানো                             114.0 TB      $2,281                  ভেতরের call এর 67% অন্য AZ এ
+ প্রতি AZ এ একটা read replica                         18.1 TB        $363                 পড়া নিজের AZ এ, লেখা primary তে
```

## কী দেখার জন্য এটা বানানো

- **বিলের সবচেয়ে বড় লাইনগুলো কেউ design করেনি** — staging এর মাপ, NAT এর পেছনে S3 এর traffic, AZ জুড়ে call। এগুলো আসে
  default থেকে আর অভ্যাস থেকে।
- **Unit economics** — খরচকে একক দিয়ে ভাগ করলে (workspace, seat, request, endpoint) সিদ্ধান্ত নেওয়া যায়: কোন plan লাভজনক,
  কোন customer লোকসানের, কোন endpoint এর জন্য সীমা লাগবে।
- **Peak এর জন্য কেনা capacity এর ৮০% অলস।** Autoscale সেটা ফেরত দেয়; commit দেয় সবসময় চলা অংশে ছাড়; spot দেয় বাধা সহ্য
  করতে পারা অংশে ছাড়। প্রতিটা আলাদা অংশের জন্য।
- **Commit এর অঙ্ক:** একটা বাড়তি commit লাভজনক যতক্ষণ ব্যবহার তার উপরে থাকে `(১ − ছাড়)` এর বেশি সময়।
- **Storage class এর দাম শুধু GB-মাস না** — transition request, ন্যূনতম object আকার, retrieval। ছোট object এ "সস্তা"
  class বেশি দামি।
- **Bytes কোথায় নড়ে, সেটাই প্রায়ই সবচেয়ে বড় খরচ** — compression, endpoint আর AZ-aware routing প্রায় বিনা মূল্যে বড়
  অংশ কাটে।
- **Cost anomaly ও একটা observability এর প্রশ্ন** — মোট বিলে ৮% এর লাফ হারিয়ে যায়; প্রতিটা ভাগ নিজের ইতিহাসের সাথে তুলনা
  করলে পরের দিনই ধরা পড়ে।

## নিজে ভেঙে দেখো (Experiments)

1. **তিন বছরের commit:** `COMMIT_DISCOUNT=0.6 npm run capacity`। সেরা commit কত হলো (মাপা: ৭, ব্যবহার ৪২% সময়ে ≥ ৭)? নিয়মের
   সীমা কোথায় সরল? এই ছাড়ের দাম কী — তিন বছরে কী কী বদলাতে পারে?
2. **Spot এর ঝুঁকি:** `SPOT_HAZARD=0.3 npm run capacity`। Interruption কয়টা হলো (মাপা: ৮৩), আর চাপে মিনিট বদলাল কি (মাপা: না,
   ৪)? কেন — লক্ষ্য ৬০% এর headroom কী করছে? `TARGET_UTIL=0.85` দিয়ে আবার দেখো।
3. **ছোট object এর সীমা:** `SMALL_KB=200 npm run storage`। ফাঁদটা কোথায় গেল (মাপা: IA $২০০, Glacier IR $১৪৮, Standard
   $২৭৬)? কোন আকার থেকে IA লাভজনক?
4. **Chatty service:** `CALLS_PER_REQUEST=20 npm run traffic`। এলোমেলো routing এ cross-AZ কত হলো (মাপা: $৬,৬৩৬), আর monolith এর
   সাথে পার্থক্য? এটা 9.1 এর কোন যুক্তির সাথে মেলে?
5. **নিজের দাম:** তোমার পছন্দের cloud এর আজকের দাম দেখে `PRICE_*` গুলো বদলাও। বিলের লাইনগুলোর ক্রম কি বদলাল?

## Project Structure

```
src/
  prices.ts    সব আনুমানিক দাম, env দিয়ে বদলানো যায়
  util.ts      seed দেওয়া PRNG, টেবিল আর টাকার format, env parse
  fleet.ts     এক সপ্তাহের traffic আর instance এর simulation — capacity আর bill দুজনেই ব্যবহার করে
  bill.ts      script ক — মাসিক বিল, unit economics, endpoint এর খরচ, cost anomaly
  capacity.ts  script খ — স্থির / autoscale / scheduled / spot, commitment, DDoS এর বিল
  storage.ts   script গ — attachment এর lifecycle, ছোট object, log retention, activity এর offload
  traffic.ts   script ঘ — egress, NAT বনাম endpoint, AZ জুড়ে traffic
```

Environment variable: `RPS`, `MAU`, `WORKSPACES`, `INSTANCE_RPS`, `TARGET_UTIL`, `BOOT_MINUTES`, `COOLDOWN_MINUTES`,
`MIN_INSTANCES`, `SPIKE_RPS`, `SPOT_FRACTION`, `SPOT_HAZARD`, `MONTHS`, `START_GB`, `START_NONCURRENT_GB`, `UPLOAD_GB`,
`GROWTH`, `SMALL_SHARE`, `SMALL_KB`, `LARGE_MB`, `EXPORT_GB`, `EXPORT_MONTH`, `ACTIVITY_GB`, `ACTIVITY_MONTHLY_GB`, `API_KB`,
`COMPRESSION`, `ATTACHMENT_GB`, `ATTACHMENT_GETS`, `CDN_HIT`, `S3_WORKER_GB`, `DEPLOYS_PER_DAY`, `INSTANCES`, `IMAGE_GB`,
`LOG_SHIP_GB`, `CALLS_PER_REQUEST`, `CALL_KB`, `DB_KB`, `READ_SHARE`, `SEED`, আর সব `PRICE_*`।
