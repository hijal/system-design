# TaskFlow Multi-Region Lab - Latency, Failover, Conflict, Data Residency

> Lesson 10.8 - Multi-Region & Geo-Distribution · **Tier 1 - Runnable Code**
> (চারটা deterministic model; কোনো cloud account, network বা Docker লাগে না)

## কী বানাচ্ছি

TaskFlow সিঙ্গাপুরের একটা region থেকে চার region এ যাওয়ার চারটা প্রশ্ন, চারটা script এ। দূরের user এর জন্য কোন topology কতটা
দ্রুত, আর কোনটা নতুন সমস্যা আনে? একটা region মরলে কতক্ষণ বন্ধ, কত data হারায়, আর তার মাসিক দাম কত? একাধিক region এ লেখা
নিলে কত লেখা নীরবে হারায়? আর একজন EU customer এর data কোন কোন পথে EU এর বাইরে যায়?

| Script              | প্রশ্ন                                                                                                        | Lesson §  |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| `npm run latency`   | পাঁচটা শহর × চারটা topology - board খোলা, task তৈরি, লেখার পরে পুরনো পড়া; region জুড়ে consensus এর commit   | ১.২ – ১.৩ |
| `npm run failover`  | সিঙ্গাপুর ৪ ঘণ্টা বন্ধ - পাঁচটা DR কৌশলের RTO, RPO, খরচ; DNS TTL এর লেজ; partition এ split brain বনাম witness | ১.৪ – ১.৫ |
| `npm run conflicts` | এক দিনের ১০ লাখ edit, প্রতিটা region এ লেখা - row/field LWW, wall clock বনাম HLC, আর home region              | ১.৬       |
| `npm run residency` | একজন EU customer এর data এর ১২টা পথ × তিনটা নকশা; একটা cell এর দাম বনাম আয়                                   | ১.৭       |

**সৎ নোট:**

- **RTT গুলো আনুমানিক** (`src/geo.ts`) - শহর থেকে region আর region থেকে region এর সাধারণ public internet এর round trip এর
  আন্দাজ, এখানে মাপা না। Model এ প্রতিটা RTT এ ±১৫% এর মতো এলোমেলো ওঠানামা।
- **Failover এর ধাপের সময় ধরে নেওয়া** - ধরা ৫ মিনিট, মানুষের সিদ্ধান্ত ১৫ মিনিট, app চালু ১৫ মিনিট, ৯০০ GB restore ২৫০ MB/s
  এ। Replication এর lag ৫ s। খরচ 10.7 এর দামের সাথে মেলানো, আনুমানিক।
- **DNS এর client এর আচরণ ধরে নেওয়া** - ৭০% TTL মানে, ২০% এর resolver অন্তত ৫ মিনিট রাখে, ১০% পুরনো IP এক ঘণ্টা পর্যন্ত
  ধরে থাকে। আসল অনুপাত আপনার client আর তাদের ISP এর উপর।
- **`conflicts` এর session আর edit synthetic** - ২০,০০০টা যৌথ session, ৩০% এ অন্য region এর মানুষ। "হারানো" মানে LWW এর
  নিয়মে বাদ পড়া edit, আসল database এর replication না।
- **`residency` একটা নকশার checklist, আইনি পরামর্শ না।** কোন data কোথায় থাকতে হবে, সেটা চুক্তি আর দেশের আইনের প্রশ্ন।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; চারটা script দুবার করে, output byte ধরে হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run latency
npm run failover
npm run conflicts
npm run residency
```

প্রতিটা কয়েক সেকেন্ডের কম।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run latency` - শুধু read replica দূরে বসালে লন্ডনের লেখা **ধীর** হয় আর লেখার পরের পড়া প্রায়ই পুরনো; cell এ লেখা
দ্রুত, কিন্তু অন্য region এর workspace এ p95 বাড়ে:

```
all in Singapore
London             25%      925 ms      1.05 s           192 ms                    0.0%
+ app + read replica in every region
London             25%      131 ms      139 ms           355 ms                   61.1%
the workspace's home region (cell)
London             25%      132 ms      567 ms            38 ms                    0.0%
all (weighted)                186 ms      698 ms

four regions, leader in Singapore        4         3    160 ms                                     1
```

`npm run failover` - RTO আর মাসিক দাম উল্টো দিকে চলে; DNS এর লেজ TTL এ থামে না; witness ছাড়া স্বয়ংক্রিয় failover split brain
আনে:

```
backup & restore (daily snapshot to another region)  2.2 h    12.0 h    1,296,000      2,340,000         $359
pilot light (DB replica running, app off)          42 min     5 s          150        756,000         $833
active-active (running in every region)            4 min     5 s          150         72,000       $3,836

DNS, TTL 60 s                                      26%        9%        8%        5%        0%              69,450
anycast / global LB (DNS doesn't change)            0%        0%        0%        0%        0%               9,150

Mumbai promotes itself after 2 minutes                  3,060                 2,160    both sides - two primaries (split brain)
with a witness (majority + lease, fencing)              5,625                     0    the Mumbai side; Singapore stops itself after 30 s
```

`npm run conflicts` - হারানো edit এর বেশিরভাগ link খারাপ থাকা দুই ঘণ্টায়; HLC ঘড়ির ভুল সরায়, concurrent না:

```
LWW, whole row, wall clock                             2,068     0.207%               2,025                 43               1,858
LWW, per field, wall clock                               642     0.064%                 633                  9                 599
LWW, per field, HLC                                      633     0.063%                 633                  0                 599
writes to the workspace's home region                    0        0%                   0                 0                   0
their extra latency p50                               119 ms
```

`npm run residency` - DB আর S3 EU তে সরালেও ১১টার ৯টা পথ বাইরে:

```
paths taking personal data outside                                                                        11 / 11              9 / 11              0 / 11
personal data going outside / month                                                                        6.9 TB              3.9 TB                0 GB
the cell's cost as % of revenue                                13%
```

## কী দেখার জন্য এটা বানানো

- **দূরত্ব round trip এ গুণ হয়।** একটা board এ handshake + তিনটা call + প্রতিটায় query। লন্ডনের user এর জন্য ১৭০ ms এর RTT
  প্রায় এক সেকেন্ড হয়ে যায়। Edge এ TLS handshake কে ছোট করে, read replica query কে, আর কোনোটাই লেখাকে না।
- **App কে user এর কাছে নিলে, কিন্তু database কে না, লেখা আরও ধীর।** "Chatty" app আর দূরের DB - user এর ১৫ ms বাঁচে, DB
  এর দুটো ১৬০ ms যোগ হয়।
- **Read replica দূরে মানে read-your-writes ভাঙে** (6.3) - লন্ডনে ৬১% সময়।
- **RTO আর RPO কেনা যায়, আর দাম স্পষ্ট** - backup এ মাসে $৩৫৯ এ ২ ঘণ্টা আর ১২ ঘণ্টার data; active-active এ $৩,৮৩৬ এ ৪ মিনিট
  আর ৫ সেকেন্ড। আর ছোট outage এ ধীর কৌশল কিছুই কেনে না।
- **DNS failover এর একটা লেজ আছে যা TTL ছোঁয় না।** Anycast বা global load balancer সেটা এড়ায়।
- **স্বয়ংক্রিয় failover এর আসল বিপদ partition, মৃত্যু না।** Witness আর fencing (6.1) ছাড়া দুটো primary।
- **Multi-region লেখার conflict সবচেয়ে বেশি যখন replication ধীর** - মানে ঠিক খারাপ সময়ে। Home region এ conflict শূন্য, দাম
  কিছু edit এ একটা round trip।
- **Data residency শুধু database না।** Backup, log, trace, search, analytics, identity, email, error tracker - প্রতিটা একটা
  পথ।

## নিজে ভেঙে দেখুন (Experiments)

1. **বেশি দূরের সহযোগিতা:** `AWAY_SHARE=0.5 npm run latency`। Cell এর overall p50 আর p95 কত হলো (মাপা: ২৫৩ ms, ৭৯৩ ms)? কোন
   topology এখন ভালো, আর কোন ধরনের customer এর জন্য cell ভুল নকশা?
2. **ছোট outage:** `OUTAGE_MINUTES=30 npm run failover`। কোন কৌশলগুলো কিছুই কিনল না (মাপা: backup আর pilot light - শেষ
   হওয়ার আগেই region ফেরে)? আর মাঝপথে failover শুরু করে ফেললে, region ফিরলে কী সমস্যা?
3. **ভালো link:** `INCIDENT_LAG_S=2 npm run conflicts`। হারানো edit কত কমল (মাপা: row LWW ২,০৬৮ → ৫১৮)? বাকিগুলো কোথা থেকে?
4. **খারাপ ঘড়ি:** `FRANKFURT_SKEW_MS=-2000 npm run conflicts`। "ঘড়ির জন্য উল্টো" কলাম কী হলো (মাপা: row ৪৩ → ৬৮৫, HLC এ ০)?
   6.4 এর কোন কথা মেলে?
5. **নিজের region:** `src/geo.ts` এ একটা পঞ্চম region যোগ করুন (ধরুন `tokyo`), RTT সহ। Consensus এর টেবিলে পাঁচটা region এ
   commit কত, আর কয়টা region হারানো সহ্য করে?

## Project Structure

```
src/
  geo.ts        region, শহর, user এর ভাগ, আনুমানিক RTT
  util.ts       seed দেওয়া PRNG, percentile (ওজন সহ), টেবিল আর সময়ের format, env parse
  latency.ts    script ক - চারটা topology × পাঁচটা শহর, read-your-writes, consensus এর commit
  failover.ts   script খ - DR কৌশল (RTO, RPO, খরচ), DNS TTL এর লেজ, partition এ split brain
  conflicts.ts  script গ - multi-region লেখা: LWW (row/field), wall clock বনাম HLC, home region
  residency.ts  script ঘ - EU data এর ১২টা পথ, তিনটা নকশা, cell এর দাম
```

Environment variable: `SAMPLES`, `API_CALLS`, `DB_READS`, `APP_MS`, `AWAY_SHARE`, `JITTER`, `RPS`, `WRITE_SHARE`,
`OUTAGE_MINUTES`, `DETECT_MINUTES`, `DECIDE_MINUTES`, `LAG_SECONDS`, `BACKUP_HOURS`, `DB_GB`, `RESTORE_MB_S`,
`PARTITION_MINUTES`, `SG_WRITE_SHARE`, `SESSIONS`, `BACKGROUND_EDITS`, `CROSS_REGION`, `INCIDENT_LAG_S`,
`FRANKFURT_SKEW_MS`, `EU_WORKSPACES`, `EU_SEATS`, `EU_PAID_SEATS`, `SEAT_PRICE`, `SEED`।
