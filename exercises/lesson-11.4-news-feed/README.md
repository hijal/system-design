# News Feed Lab — Follower এর Power Law, Push বনাম Pull বনাম Hybrid, Fan-out Queue, Tail Latency, Pagination, আর একটা আসল Feed

> Lesson 11.4 — Case Study: Design a News Feed (Facebook/Twitter-style) · **Tier 1 — Runnable Code**
> (তিনটা deterministic model আর একটা আসল Express + Zod hybrid feed service; Docker লাগে না)

## কী বানাচ্ছি

একটা Twitter এর মতো feed এর চারটা প্রশ্ন। Follower সংখ্যা যখন power law মেনে চলে, তখন প্রতিটা post সব follower এর timeline এ
লেখা (push), পড়ার সময় সবার post জোড়া (pull), আর দুটোর মিশ্রণ (hybrid) — কোনটার খরচ কোথায়? একজন celebrity post করলে fan-out
এর queue তে বাকি সবার কী হয়? Pull এ একটা feed পড়ায় ২০০টা জায়গা থেকে আনলে p99 এর কী হয়? আর scroll করার সময় নতুন post এলে
offset আর cursor pagination এর কী হয়?

| Script             | প্রশ্ন                                                                                          | Lesson §  |
| ------------------ | ----------------------------------------------------------------------------------------------- | --------- |
| `npm run estimate` | ৫০ কোটি account এর follower এর বণ্টন; traffic; push, pull আর hybrid এর লেখা, পড়া আর cache      | ১.২ – ১.৪ |
| `npm run fanout`   | Celebrity এর post একটা FIFO queue, দুটো queue আর hybrid এ — সাধারণ post কতক্ষণ আটকায়           | ১.৫       |
| `npm run read`     | K টা জায়গা থেকে একসাথে আনার tail latency, hedge সহ; offset বনাম cursor এ দ্বিতীয় page         | ১.৬ – ১.৭ |
| `npm run smoke`    | আসল HTTP: hybrid fan-out, async queue, push + pull মেশানো, cursor বনাম offset, unfollow, delete | ১.৮       |

**সৎ নোট:**

- **Follower এর বণ্টন একটা model** — power law (α = ১.২), সর্বোচ্চ ১৫ কোটি, গড় ২০০ তে মেলানো। আসল social network এর বণ্টন এর
  কাছাকাছি আকারের বলে প্রকাশিত গবেষণায় দেখা যায়, কিন্তু α আর গড় এখানে ধরে নেওয়া, মাপা না। প্রতিটা account সমান হারে post
  করে বলে ধরা (বাস্তবে বড় account বেশি post করে)।
- **`fanout` এর queue সরল** — মোট ক্ষমতা ২০ লাখ লেখা/s, ১০০ ms এর ধাপে; একটা post এর fan-out ক্রমে চলে, ছোট টুকরোয় না।
- **`read` এর latency synthetic** — প্রতিটা fetch median ২ ms, ১% সময় ৫০ ms (GC, network, ব্যস্ত shard)। Hedge মানে ১০ ms এ
  দ্বিতীয় একটা চেষ্টা আর যেটা আগে আসে।
- **`smoke` আসল HTTP চালায়**, store in-memory, Redis বা database না; fan-out queue একটা array, worker হাতে `drain()` করা হয়
  যাতে "এখনও পৌঁছায়নি" অবস্থাটা দেখা যায়। Ranking নেই, শুধু সময়ের ক্রম।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run estimate
npm run fanout
npm run read
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` — মাঝের account এর ৬২ জন follower, সবচেয়ে বড়র ১৫ কোটি; hybrid গড় লেখা প্রায় কমায় না, কিন্তু সবচেয়ে বড়
post কে ৬ কোটি থেকে ৪ লাখে নামায়; pull এ প্রতি পড়ায় ২০০ fetch:

```
median account (p50)                                      62
biggest account                                  150,000,000
push, active followers only                          46,296      60,000,000             1.0         104,167    3.8 TB
fan-out on read (pull from everyone)                      0               0           200.0      20,833,333         —
hybrid: over 1,000,000 → pull                        42,091         400,000            19.2       1,996,773    3.8 TB
over 1,000,000 followers: 2,178 accounts, 9.1% of all follows
```

`npm run fanout` — এক FIFO queue তে celebrity এর post এর পেছনে তিন লাখ সাধারণ post ৫ s এর বেশি আটকায়:

```
one FIFO queue, push to everyone                                         100 ms  142.10 s     147.70 s     311,955       147.80 s
two queues: big jobs (> 100,000) separate, 25% of capacity               100 ms    100 ms     156.60 s           8       157.40 s
hybrid: over 1,000,000 followers are not pushed                          100 ms    100 ms       300 ms           0        by pull
```

`npm run read` — K বাড়লে p99 একটা ধীর fetch এ আটকায়; hedge কিছুটা বাঁচায়; offset এ দ্বিতীয় page এ আগে দেখা post:

```
push: your own timeline only                             1   2.01 ms   6.69 ms               0.9%
hybrid: timeline + ~19 celebrities                      20   4.40 ms     53 ms              18.2%
hybrid, slow ones hedged (second try at 10 ms)          20   4.40 ms     14 ms              18.1%
pull: posts from all 200                               200     52 ms     54 ms              86.7%
?offset=20 (skip the first 20)                                  40.6%           18.4%
?cursor=<last seen id> (id < cursor)                        0.0%            0.0%
```

`npm run smoke` — ১০টা ধাপ:

```
1   alice posted a1; the fan-out queue hasn't run yet           bob: (empty); 2 in the queue
3   star posted s1 (4 followers → not pushed)                   0 in the queue; amy: s1[pull]
4   bob's feed: push and pull merged, in id order               s1[pull] a1[push]
6   meanwhile a8, a9 arrived; second page ?offset=3             a6[push] a5[push] a4[push]
7   second page ?cursor=6                                       a4[push] a3[push] a2[push]
8   bob unfollows alice (the ids remain in his timeline)        bob: s1[pull]
```

## কী দেখার জন্য এটা বানানো

- **Power law সব কিছু ঠিক করে।** মাঝের account এর ৬২ জন follower, উপরের ০.০১% account এর কাছে সব follow এর ১৮%। গড় দিয়ে নকশা
  করলে celebrity কে ভুলে যাবেন।
- **Push পড়াকে সস্তা করে, লেখাকে ব্যয়বহুল আর অসমান।** একটা post এ ৬ কোটি লেখা পর্যন্ত। Pull লেখাকে সস্তা, পড়াকে ২০০ গুণ।
- **Hybrid এর লাভ গড়ে না, spike এ।** গড় লেখা ৪৬k থেকে ৪২k, কিন্তু সবচেয়ে বড় post ৬ কোটি থেকে ৪ লাখ, আর queue আর আটকায় না।
- **একটা queue তে বড় আর ছোট কাজ মেশালে ছোটরা বড়র পেছনে মরে** (9.4 এর bulkhead, fan-out এর queue তে)।
- **একসাথে অনেক জায়গা থেকে আনলে p99 সবচেয়ে ধীরটার।** K = ২০০ এ ৮৭% feed এ অন্তত একটা ধীর fetch।
- **Feed এ offset pagination ভাঙে।** নতুন post এলে আগের post আবার, মুছলে একটা বাদ। Cursor এ দুটোই শূন্য।
- **Unfollow আর delete পড়ার সময় ছাঁকা হয়**, timeline cache থেকে মুছতে হয় না।

## নিজে ভেঙে দেখুন (Experiments)

1. **কম তীক্ষ্ণ বণ্টন:** `ALPHA=1.5 npm run estimate`। উপরের ০.০১% এর ভাগ কত (মাপা: ৪.৫%), আর ১০ লাখের বেশি follower এর account
   কয়টা (২৭১)? Hybrid এ পড়ার খরচ কত হলো (১৯.২ থেকে ২.৪ fetch)?
2. **Queue এর সীমা:** `BIG_JOB=1000000 npm run fanout`। মাঝারি account (১-১০ লাখ follower) এর post এখন কোথায় যায়, আর সাধারণ post
   এর সবচেয়ে খারাপ দেরি কত (৪০০ ms)? `BIG_SHARE=0.5` এ কী বদলাল (কিছুই না — কেন)?
3. **কম ধীর fetch:** `SLOW_SHARE=0.001 npm run read`। Pull এর p50 কত হলো (৬ ms), p99 (৫৩ ms)? Tail এর কারণ কী, আর hedge কেন
   p99 এ কাজ করে কিন্তু p50 এ না?
4. **ব্যস্ত feed:** `NEW_PER_MIN=10 npm run read`। Offset এ দ্বিতীয় page এ আগে দেখা post কত % session এ (মাপা: ৭৮%)?
5. **Code বদলানোর কাজ:** `src/feed.ts` এ একজন user celebrity এর সীমা পার হলে (নতুন follower এর পরে) কী হবে? এখন তার পুরনো post
   follower দের timeline এ আছে, নতুনগুলো pull এ। দুটো একসাথে দেখাতে কোনো সমস্যা হয় কিনা পরীক্ষা করুন, আর উল্টোটা (follower
   কমে সীমার নিচে নামা) কীভাবে সামলাবেন।

## Project Structure

```
src/
  util.ts      seed দেওয়া PRNG, lognormal, percentile, টেবিলের format, env parse
  graph.ts     follower এর power law বণ্টন, গড় ২০০ তে মেলানো (rank → follower, সীমার উপরের account আর follow)
  estimate.ts  script ক — বণ্টন, traffic, push/pull/hybrid এর খরচ
  fanout.ts    script খ — fan-out queue এর তিনটা নীতি, সাধারণ আর বড় post এর দেরি
  read.ts      script গ — K টা fetch এর tail, hedge; offset বনাম cursor
  feed.ts      FeedStore (follow, post, fan-out queue, timeline cap, hybrid পড়া, delete/unfollow ছাঁকা) আর Express app
  smoke.ts     script ঘ — feed service চালিয়ে ১০টা ধাপ
```

Environment variable: `ACCOUNTS`, `ALPHA`, `CAP`, `MEAN_FOLLOWS`, `DAU`, `OPENS`, `POSTS_PER_ACCOUNT`, `PEAK`,
`ACTIVE_SHARE`, `TIMELINE_CAP`, `ENTRY_BYTES`, `FANOUT_CAPACITY`, `POSTS_PER_S`, `SECONDS`, `TICK_MS`, `THRESHOLD`,
`BIG_JOB`, `BIG_SHARE`, `READS`, `FETCH_MS`, `SLOW_SHARE`, `SLOW_MS`, `HEDGE_AFTER_MS`, `SESSIONS`, `PAGE`, `NEW_PER_MIN`,
`READ_S`, `DELETE_SHARE`, `SEED`।
