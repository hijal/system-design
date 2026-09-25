# TaskFlow Raft Lab — Leader Election, Partition আর Election Restriction

> Lesson 6.2 — Consensus: Leader Election আর Raft basics · **Tier 1 — Runnable Code** (deterministic simulation)

## কী বানাচ্ছি

Raft এর মূল অংশের একটা ছোট implementation (~300 লাইন, paper এর Figure 2 এর নিয়ম মেনে) — leader
election, log replication, commit rule, election restriction — আর একটা seed দেওয়া network simulator,
যেখানে message এর দেরি আর link কাটা নিয়ন্ত্রণ করা যায়:

| Script              | কী দেখায়                                                                                                                           | Lesson §  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run election`  | Election timeout স্থির বনাম random — কতক্ষণে leader পাওয়া যায়, কতগুলো ব্যর্থ election (split vote) হয়                            | ১.৪       |
| `npm run partition` | ৫ node, network তিন ভাগে কাটা: পুরনো leader একা, একজন follower একা, বাকি ৩ জন। কে লিখতে পারে, কে পারে না, আর জোড়া লাগার পরে কী হয় | ১.৫ – ১.৭ |
| `npm run unsafe`    | একই গল্প, কিন্তু election restriction বন্ধ — পুরনো log এর node ও ভোট পায়                                                           | ১.৭       |

**কেন simulation?** Raft এর আসল কথা হলো message কখন কোথায় পৌঁছায় — আর partition, দেরি, timer এর
race সব নিয়ন্ত্রিতভাবে, বারবার একই ভাবে ঘটাতে simulation সবচেয়ে সৎ উপায়। সময় এখানে "লাফায়" (পরের event
এ), তাই ১০ সেকেন্ডের cluster এক পলকে চলে।

**কী নেই:** membership change, snapshot, disk এ persist (crash-recovery), PreVote, client session,
linearizable read। Production এ এগুলো সব লাগে — তাই এটা শেখার জন্য, ব্যবহারের জন্য না। আসল কাজে etcd
এর `raft` library বা HashiCorp এর `raft` এর মতো পরীক্ষিত implementation।

## Prerequisite

Node.js 22+। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run election
npm run partition
npm run unsafe
```

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

তিনটাই deterministic — তোমার মেশিনেও **হুবহু** এই output আসবে।

**১. `npm run election`**

```
   election timeout     leader পাওয়া গেছে    সময় p50 / p99          গড় term (১ = প্রথম চেষ্টাতেই)
   150 ms (স্থির)        837/1000           4204 /  9761 ms         30.61
   150–155 ms           1000/1000            315 /  1526 ms         2.94
   150–175 ms           1000/1000            161 /   331 ms         1.08
   150–300 ms           1000/1000            176 /   252 ms         1.00
```

**২. `npm run partition`** (মাঝের অংশ বাদ দিয়ে)

```
   ═══ 1200 ms: network কাটা — [n1] | [n2] | [n3 n4 n5] ═══

    1250 ms  A       "x=2" → n1 (log index 2, term 1)
    1329 ms  n3      ★ leader হলো (term 2)
    2008 ms  B       ✓ "x=3" নিশ্চিত (8 ms)
    2250 ms  A       ✗ "x=2" — 1000 ms এ কোনো নিশ্চয়তা আসেনি (timeout)

   ── partition চলছে — দুজন "leader"? ──
   n1  LEADER    term  1   log: x=1(t1) x=2(t1)                commit 1   x = 1
   n2  candidate term  5   log: x=1(t1)                        commit 1   x = 1
   n3  LEADER    term  2   log: x=1(t1) x=3(t2)                commit 2   x = 3
   ...
    3628 ms  n3      n2 কে ভোট দিল না — ওর log আমার চেয়ে পুরনো (term 11)
    3716 ms  n5      ★ leader হলো (term 12)

   ── ফল ──
   "x=3" client কে নিশ্চিত করা হয়েছিল: হ্যাঁ
   "x=3" এখন কয়টা node এর log এ আছে: 5/5
   "x=2" (কখনো নিশ্চিত হয়নি) কয়টা log এ আছে: 0/5
   সব node এ x এর মান এক? হ্যাঁ
```

**৩. `npm run unsafe`**

```
    3631 ms  n2      ★ leader হলো (term 11)
   ...
   "x=3" এখন কয়টা node এর log এ আছে: 0/5   ← নিশ্চিত করা লেখা হারিয়ে গেছে!
   সব node এ x এর মান এক? না — n1=4 n2=4 n3=3 n4=3 n5=3   ← replica গুলো আলাদা হয়ে গেছে!
```

## কী দেখার জন্য এটা বানানো

- **`election`:** স্থির timeout এ সবাই প্রায় একসাথে candidate হয়, সবাই নিজেকে ভোট দেয়, কেউ majority
  পায় না — আবার, আবার। গড়ে ৩০টা term, আর ১৬% ক্ষেত্রে ১০ সেকেন্ডেও leader নেই। সামান্য randomness
  (150–175) তেই প্রায় সব প্রথম চেষ্টায়।
- **`partition`, snapshot এ:** দুটো node নিজেকে LEADER বলছে — n1 (term 1) আর n3 (term 2)। কিন্তু n1
  কিছুই commit করতে পারছে না (x=2 এর commit নেই, client timeout পেয়েছে)। আর n1 এর `x = 1` — কেউ n1
  থেকে পড়লে পুরনো মান পাবে (stale read)।
- **n2 এর term:** একা বিচ্ছিন্ন n2 বারবার election শুরু করে, term বাড়তে বাড়তে 10। জোড়া লাগার পরে
  সেই বড় term দেখে সুস্থ leader n3 ও পদ ছাড়ে — অকারণ একটা বিরতি। কিন্তু n2 এর log পুরনো, তাই সে
  জিততে পারে না।
- **`unsafe`:** সেই পুরনো-log এর n2 জিতে যায়, আর তার log কে "সত্য" ধরে বাকিদের x=3 মুছে দেয় — client
  কে "নিশ্চিত" বলা লেখা। আর যারা x=3 আগেই প্রয়োগ করেছিল, তাদের মান আর মেলে না।

## নিজে ভেঙে দেখো (Experiments)

1. **Timeout range:** `src/election.ts` এর `RANGES` এ `[150, 151]` আর `[300, 600]` যোগ করো। Heartbeat
   (50 ms) এর তুলনায় timeout খুব বড় হলে কী দাম দিতে হয় — leader সত্যিই মরলে?
2. **জোড় সংখ্যা:** `src/partition.ts` এ `NODES` এ `n6` যোগ করো, আর partition বদলে দুই ভাগ সমান করো
   (তিন | তিন)। কোনো দিক কি leader পায়? `n6` যোগ করায় কয়টা node এর ব্যর্থতা সহ্য করার ক্ষমতা বাড়ল?
3. **Stale read ঠিক করো:** পুরনো leader n1 partition এর সময় `x = 1` বলছে। একটা `read()` method লেখো যেটা
   উত্তর দেওয়ার আগে majority থেকে heartbeat এর সাড়া নিশ্চিত করে (Raft এর "ReadIndex" ধারণা)। n1 এর
   `read()` কী করবে?
4. **(কঠিন) PreVote:** n2 এর বাড়তে থাকা term সুস্থ leader কে সরিয়ে দিচ্ছে। Candidate হওয়ার আগে একটা
   "আমি জিততে পারব?" জিজ্ঞাসা যোগ করো — term না বাড়িয়ে — আর majority "হ্যাঁ" বললে তবেই আসল election।
   n3 কি আর পদ ছাড়ে?

## Project Structure

```
lesson-6.2-raft/
├── package.json
├── tsconfig.json          # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
└── src/
    ├── random.ts          # seed দেওয়া PRNG, latency, percentile (Lesson 5.9 থেকে)
    ├── sim.ts             # discrete-event simulator + network (দেরি, link কাটা)
    ├── raft.ts            # RaftNode: election, replication, commit, election restriction
    ├── election.ts        # timeout range বনাম election এর সময় — ১০০০ বার করে
    └── partition.ts       # তিন ভাগের partition এর গল্প — safe আর unsafe
```

**যাচাই:** এই মেশিনে (Node 26) `tsc --noEmit` clean; তিনটা script কয়েকবার চালিয়ে হুবহু একই output
(checksum মিলিয়ে)। Experiment গুলো তোমার code বদলানোর কাজ — সেগুলোর ফল চালিয়ে দেখা হয়নি।
