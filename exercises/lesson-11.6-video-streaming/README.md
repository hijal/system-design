# Video Streaming Lab - Egress এর বিল, Transcoding Pipeline, Adaptive Bitrate, জনপ্রিয়তা আর Codec, আর একটা আসল HLS Service

> Lesson 11.6 - Case Study: Design a Video Streaming Platform · **Tier 1 - Runnable Code**
> (চারটা deterministic model আর একটা আসল Express + Zod VOD service, HLS এর playlist সহ; Docker বা ffmpeg লাগে না)

## কী বানাচ্ছি

একটা YouTube এর মতো on-demand video platform এর পাঁচটা প্রশ্ন। বিলের বড় লাইন কোনটা - egress, storage, না transcoding? একটা
ঘণ্টার video upload এর পরে কতক্ষণে দেখা যায়, আর spot worker কেড়ে নিলে কী হয়? ওঠানামা করা mobile network এ player কোন
quality বাছবে? কোটি video এর মধ্যে কোনগুলো CDN এ রাখব, আর কোনগুলো দামি codec এ আবার encode করলে লাভ? আর এই সব একসাথে একটা
service এ, HLS এর master আর media playlist সহ।

| Script              | প্রশ্ন                                                                                             | Lesson § |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| `npm run estimate`  | ২০ কোটি DAU - egress, bandwidth, upload, storage, transcoding এর core, মাসিক খরচ                   | ১.২      |
| `npm run transcode` | এক ঘণ্টার video - পুরোটা এক worker এ, resolution প্রতি, বা ৪ s এর টুকরো ১০০ worker এ; spot এর বাধা | ১.৪      |
| `npm run abr`       | ৩০০টা session, ওঠানামা করা network - পাঁচটা bitrate নীতির rebuffer, quality আর বদল                 | ১.৫      |
| `npm run cdn`       | ১০ কোটি video এর Zipf - edge এ কতটা রাখলে কত দেখা; কোন video কে AV1 এ encode করা লাভজনক            | ১.৬      |
| `npm run smoke`     | আসল HTTP: upload → টুকরো ধরে কাজ → playable → ready, master/media playlist, Cache-Control          | ১.৭      |

**সৎ নোট:**

- **Estimation আর দামের input ধরে নেওয়া** - দিনে গড়ে ১ ঘণ্টা, গড় ৩ Mbps, প্রতি মিনিটে ৩০০ ঘণ্টা upload, CDN $০.০১/GB (বড়
  চুক্তিতে; তালিকার দাম বেশি), transcoding ঘণ্টায় ৪ CPU-ঘণ্টা (codec, preset আর hardware ভেদে অনেক বদলায়)।
- **`transcode` এ আসল encoding নেই** - প্রতিটা কাজের CPU সময় resolution এর ওজন থেকে, ±২০% এলোমেলো; spot এর বাধা Poisson
  (CPU-ঘণ্টায় ০.২ বার), কেড়ে নিলে worker আবার চালু হতে ২০ s।
- **`abr` এর network synthetic** - ০.৪ থেকে ১২ Mbps এর ছয়টা অবস্থা, গড়ে ৬ s এ বদলায়। নীতিগুলো আসল player (যেমন hls.js,
  dash.js, ExoPlayer) এর সরল রূপ, তাদের আসল algorithm না।
- **`cdn` এর জনপ্রিয়তা একটা model** (Zipf, s = ১.২)। "edge এ জায়গা" সবচেয়ে জনপ্রিয়গুলো রাখলে আদর্শ হিসাব, LRU না। AV1 এর
  ৩০% কম bit আর ১০ গুণ encode এর খরচ প্রকাশিত তুলনার মোটামুটি আন্দাজ, এখানে মাপা না।
- **`smoke` আসল HTTP চালায়**, কিন্তু video এর টুকরো গুলো নকল byte (আকার bitrate এর অনুপাতে, হাজার ভাগের এক ভাগে), store
  in-memory, worker এর `work()` হাতে ডাকা।
- **যাচাই করা হয়েছে** Node 26 এ: `tsc --noEmit`, ESLint আর Prettier clean; পাঁচটা script দুবার করে, output byte ধরে হুবহু এক।

## Prerequisite

Node.js 22+ (Node 26 এ যাচাই করা)। Docker বা ffmpeg লাগে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run estimate
npm run transcode
npm run abr
npm run cdn
npm run smoke
```

প্রতিটা কয়েক সেকেন্ড।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

`npm run estimate` - দিনে ২৭০ PB egress, বিলের ৭৮%; transcoding ১%:

```
data out per day (egress)                                       270 PB
peak bandwidth (2.5×)                                          63 Tbps   beyond any single data center
CDN egress ($0.01/GB)                                $81,000,000     78.2%
transcoding ($0.02/CPU-hour)                                $1,036,800      1.0%
```

`npm run transcode` - টুকরো করে parallel এ ঘণ্টা থেকে মিনিট, আর spot এর বাধায় প্রায় কিছু নষ্ট হয় না:

```
one worker, the whole video, one resolution after another          4.0 h     10.6 h        27.3 min      13.72%
4 s pieces, 100 workers                                         2.9 min    3.0 min            38 s       0.02%
```

`npm run abr` - সর্বোচ্চ quality তে এক-তৃতীয়াংশ সময় আটকে থাকে; মিশ্র নীতিতে প্রায় শূন্য:

```
always 1080p                                                                   5.4 s     32.63%   5.00 Mbps               0.0
throughput: the highest under 80% of the last 3 rates                          0.8 s      0.22%   2.35 Mbps              32.9
mixed: throughput, drop when the buffer is low, climb step by step             0.4 s      0.08%   2.32 Mbps              34.5
```

`npm run cdn` - ০.১% video তে ৯২% দেখা; AV1 শুধু জনপ্রিয়গুলোতে:

```
0.1%                                 103,359       92.4%                     80.6 TB
videos whose monthly watching egress costs less than their transcode: 62.1%
all videos                           100 million         $12,000,000         $24,300,000   $12,300,000
over 30 hours a month                  2,235,202            $268,224         $23,589,440   $23,321,215
```

`npm run smoke` - ১২টা ধাপ:

```
3   30 jobs (360p and 240p first)                         playable (30/75)
4   the master playlist now                               240p/index.m3u8, 360p/index.m3u8; Cache-Control: public, max-age=2
5   the remaining jobs; the worker on 720p piece 3 died   ready; failed 1, ran 76
9   player, network 3 Mbps (80% rule)                     480p; first piece 700 B
11  a piece's Cache-Control                               public, max-age=31536000, immutable
12  the queue handed out the same job again (at-least-once)  75 new writes in total, 1 skipped
```

## কী দেখার জন্য এটা বানানো

- **Video এর বিল egress এর।** প্রতিটা দর্শক প্রতিবার দাম দেয়; transcode একবার। তাই প্রতিটা bit বাঁচানো (codec, ladder, ABR)
  সরাসরি টাকা।
- **টুকরো করলে parallel আর ব্যর্থতা সস্তা।** পুরো video একটা কাজ হলে spot এর একটা বাধায় ঘণ্টার কাজ নষ্ট; ৪ s এর টুকরোয় শুধু
  সেটুকু।
- **আগে কম quality, তারপর বাকিটা।** Video "playable" হয় সব resolution এর আগেই।
- **ABR এর কাজ rebuffer আর quality এর মাঝে দাঁড়ানো।** সবচেয়ে ভালো quality সবচেয়ে খারাপ অভিজ্ঞতা দেয় খারাপ network এ।
- **জনপ্রিয়তা তীক্ষ্ণ।** অল্প কিছু video প্রায় সব দেখা; তাদের জন্য দামি encode, edge cache; লম্বা লেজের জন্য সস্তা পথ।
- **টুকরো immutable, playlist না।** নাম কখনো বদলায় না এমন জিনিস চিরকাল cache; বদলাতে পারে এমন জিনিস (processing এর সময়
  master) ছোট TTL।

## নিজে ভেঙে দেখুন (Experiments)

1. **কম worker:** `WORKERS=20 npm run transcode`। টুকরোর publish কত (মাপা: ১২.৭ মিনিট), আর "360p আগে" এখন কতটা কাজে লাগে (১.৭
   থেকে ১.৩ মিনিট)? ১০০ worker এ কেন প্রায় লাগেনি?
2. **খারাপ spot:** `INTERRUPT_PER_CPU_H=1 npm run transcode`। এক worker এর p99 কত হলো (মাপা: ২৪.৯ ঘণ্টা) আর নষ্ট CPU (৬০%), আর
   টুকরোয় (০.০৯%)? Spot কোন নকশায় সস্তা, কোনটায় দামি?
3. **লোভী player:** `SAFETY=1 npm run abr`। Throughput নীতির rebuffer কত হলো (মাপা: ০.২২% থেকে ০.৬০%), আর bitrate কতটা বাড়ল? ২০%
   এর ফাঁক কেন?
4. **দামি codec:** `AV1_COST_X=30 npm run cdn`। সব video তে AV1 এখন কী (মাপা: নিট −$১.৪৪ কোটি), আর শুধু জনপ্রিয়তে (+$২.৩ কোটি)?
5. **Code বদলানোর কাজ:** `src/vod.ts` এ "অজনপ্রিয় video" এর জন্য শুধু 240p, 360p আর 720p বানান; প্রথম দিনে ১,০০০ view পার হলে
   বাকি দুটো queue তে যোগ করুন। Master playlist আর তার Cache-Control এ কী বদলাতে হবে?

## Project Structure

```
src/
  util.ts       seed দেওয়া PRNG, lognormal, percentile, টেবিলের format, env parse
  ladder.ts     পাঁচটা resolution: উচ্চতা, Mbps, CPU এর ওজন
  estimate.ts   script ক - egress, bandwidth, upload, storage, transcoding, মাসিক খরচ
  transcode.ts  script খ - চারটা pipeline এর নকশা, spot এর বাধা, publish আর playable এর সময়
  abr.ts        script গ - network এর trace, পাঁচটা ABR নীতি, rebuffer/bitrate/বদল
  cdn.ts        script ঘ - Zipf জনপ্রিয়তা, edge এর জায়গা, লম্বা লেজ, AV1 এর অর্থনীতি
  vod.ts        VodService (টুকরো ধরে কাজ, idempotent লেখা, অবস্থা, HLS এর playlist) আর Express app
  smoke.ts      script ঙ - upload থেকে player পর্যন্ত ১২টা ধাপ
```

Environment variable: `DAU`, `WATCH_MIN`, `AVG_MBPS`, `PEAK`, `UPLOAD_H_PER_MIN`, `LADDER_MBPS`, `SOURCE_MBPS`,
`CPU_H_PER_H`, `CPU_HOUR`, `CDN_PER_GB`, `STORAGE_PER_GB`, `VIDEO_MIN`, `SEGMENT_S`, `WORKERS`, `INTERRUPT_PER_CPU_H`,
`UPLOADS`, `STARTUP_S`, `SESSIONS`, `CONTENT_S`, `MAX_BUFFER_S`, `RESERVOIR_S`, `CUSHION_S`, `SAFETY`, `STATE_S`,
`VIDEOS`, `ZIPF_S`, `WATCH_HOURS`, `H264_PER_HOUR`, `AV1_COST_X`, `AV1_SAVING`, `SEED`।
