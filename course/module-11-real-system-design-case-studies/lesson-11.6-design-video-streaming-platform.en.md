# Lesson 11.6 - Case Study: Design a Video Streaming Platform

**Module 11 - Real System Design Case Studies**

> **Spaced Repetition (Lesson 4.5):** What goes wrong on a CDN if you change a file's content without changing its name? And how do `Cache-Control: immutable` and keeping a version (hash) in the name solve it? Today a video will be broken into a few thousand pieces whose names never change, and a small playlist, which does change. How long each is cached comes from the answer to this question.

**Prerequisite:** Lesson 1.3 (Estimation), Lesson 4.5 (CDN, Cache-Control), Lesson 7.3 (Background job), Lesson 7.4 (Retry, idempotency), Lesson 8.1 (Object storage), Lesson 8.2 (Presigned, multipart upload), Lesson 10.7 (Cost, spot, storage tier), Lesson 11.1 (Zipf, cache), Lesson 11.4 (Power law)

**By the end of this lesson you will be able to:**

1. Say with numbers what a video platform's cost looks like: egress is almost the whole bill, transcoding almost nothing, and so why saving every bit (codec, bitrate ladder, ABR) is money directly
2. Design a transcoding pipeline: cutting the video into pieces in parallel, tolerating interruptions of spot workers, making it "watchable" in low quality first, with idempotent work; and what an HLS/DASH manifest is, and which part is cached for how long
3. Measure the trade-offs of adaptive bitrate on the player's side (rebuffering vs quality vs switching back and forth), and decide from the sharp popularity distribution: which videos at the edge, which in an expensive codec, and which cheap path for the long tail

**Tier:** 1 - Runnable Code (four deterministic models and a real Express + Zod VOD service, with HLS playlists; no Docker or ffmpeg needed)

---

## 0. Today's System

The interviewer:

> "Design a video platform like YouTube. Creators upload, viewers watch. On phones, on TVs, on bad networks."

In the earlier case studies the data was small: a URL, a message, a post id. This time one thing is a few GB, and hundreds of thousands of people watch the same thing. 8.1's object storage, 8.2's uploads, 4.5's CDN, and 10.7's data transfer cost come together. The first move is often: "Upload to S3, serve the file through a CDN." The questions from here:

- "A 1-hour 4K file is 15 GB. What will a viewer on 3G on their phone see?"
- "When can a video be watched after it's uploaded? An hour?"
- "What will the biggest line on the month's bill be?"
- "Out of 100 million videos, which ones will you keep on the CDN?"
- "Live streaming?" (not today, one line at the end)

---

## 1. Theory

### 1.1 Step 1 - Requirements

```
Question                                     Assumed
How many viewers?                            200 million DAU, 1 hour a day on average
How many uploads?                            300 hours of video every minute
Which devices and networks?                  phones to TVs, 3G to fibre - the same video in several qualities
How soon watchable after upload?             within minutes, at least in low quality
How long until a video starts?               ~1–2 s; as few stalls while watching (rebuffering) as possible
Left out                                     live streaming, recommendations, comments, monetization, copyright scanning
```

**Non-functional:** the viewing experience first (start-up delay and rebuffering are the biggest reasons viewers leave), uploads are never lost (it's the creator's work), and cost - because in this system cost is the biggest constraint, see the next section.

### 1.2 Step 2 - Estimation: whose bill is it

`npm run estimate`:

```
── Part A - watching: 200 million DAU, 60 minutes a day on average, 3 Mbps on average ──
data out per day (egress)                                       270 PB
average bandwidth                                              25 Tbps
peak bandwidth (2.5×)                                          63 Tbps   beyond any single data center
watching at once (peak)                                   20.8 million

── Part B - uploads: 300 hours of video every minute ──
uploaded per day                                         432,000 hours
stored (original 20 + all resolutions 10.4 Mbps)            5.9 PB/day   2157 PB a year
transcoding (4 CPU-hours per hour)                        72,000 cores   running all the time

── Part C - monthly cost (approximate prices) ──
CDN egress ($0.01/GB)                                $81,000,000     78.2%
storage, one year's accumulation ($0.01/GB-month)          $21,570,624     20.8%
transcoding ($0.02/CPU-hour)                                $1,036,800      1.0%

the cost of watching one hour: $0.0135 egress - for every viewer, every time.
the cost of transcoding one hour: $0.08 - once. 6 hours watched = one hour transcoded.
```

1. **Egress is 78% of the bill.** **Egress** - data leaving a data center or CDN (to the viewer), paid per GB; in video, every viewer pays the full price every time they watch. 270 PB a day, 63 Tbps at peak, which is impossible to push out of any single data center's network. So the CDN here is not an optimization but mandatory, and many big platforms put their own cache servers inside ISPs (Netflix's Open Connect is described in their published writing).
2. **Transcoding is 1% of the bill.** 72,000 cores sounds huge, but in money it's small. What this means: **spending more on encoding to save bits is almost always worth it.** Transcoding one hour costs as much as the egress for 6 hours of watching. A popular video gets watched for hundreds of thousands of hours. That maths is in 1.6.
3. **Storage grows every day.** 6 PB a day, never deleted, so this line of the bill keeps growing year after year. For old and unpopular videos, a cheaper storage tier (10.7) and lower resolutions.
4. **20 million people watching at once.** But most of them are watching the same few videos (1.6), which is what makes the CDN possible.

### 1.3 Step 3 - High-level design

```
 creator ──presigned multipart upload (8.2)──► [object storage: original file]
                                                     │ event
                                                     ▼
                                    [transcoding pipeline]
                     split ──► [piece × resolution jobs, in a queue] ──► package (HLS/DASH)
                                     │  spot workers × hundreds
                                     ▼
                       [object storage: pieces + playlists]   [metadata DB: video, state]
                                     │
                       [origin shield (4.5)] ──► [CDN edge / cache inside the ISP] ──► the viewer's player
                                                                                           │
                                                      ABR: picks the quality for each piece ◄─┘
```

Two terms that everything else is built on:

**Bitrate Ladder** - several versions of the same video, at different resolutions and bitrates (here five steps, from 240p at 0.4 Mbps to 1080p at 5 Mbps). The player picks one to suit its network. The more steps on the ladder, the smoother, but the more encoding and storage. And some platforms build a separate ladder for every video (a cartoon gives the same quality at fewer bits, a sports video needs more) - "per-title encoding".

**Manifest (HLS / DASH)** - a small text file describing how the video is split up and where to find it. In HLS there is a **master playlist** (which qualities exist, each one's bandwidth and resolution) and a **media playlist** for each quality (the list of pieces, each a few seconds long). The player reads the master first, picks a quality, reads its media playlist, then fetches the pieces one by one, each as a separate HTTP request. Its biggest advantage: **every piece is an ordinary static file**, so any CDN can serve it with no special server.

### 1.4 Deep dive 1 - The transcoding pipeline

Making the ladder's five versions from the uploaded original (often a big 15–20 Mbps file) takes 4 CPU-hours for an hour of video. `npm run transcode`: forty 1-hour uploads, **spot workers** (10.7: much cheaper, but the cloud can take them back at any time; here 0.2 times per CPU-hour on average), and 20 s for a worker to start again after being taken back:

```
plan                                                        publish p50        p99  360p watchable  wasted CPU
one worker, the whole video, one resolution after another          4.0 h     10.6 h        27.3 min      13.72%
one worker per resolution (5)                                     2.1 h      3.0 h        18.1 min      13.72%
4 s pieces, 100 workers                                         2.9 min    3.0 min            38 s       0.02%
the same, but 360p pieces first                                 2.9 min    3.0 min            32 s       0.02%
```

- **The whole video as one job:** four hours, and one spot interruption wastes that resolution's whole job. p99 **10.6 hours**, 14% of the CPU thrown away. Experiment 2: with one interruption an hour, p99 25 hours, 60% wasted.
- **A worker per resolution:** the fastest it can be is the slowest resolution (1080p, 2 hours). The same waste.
- **Segment-Parallel Transcoding** - splitting the video into small pieces (here 4 s, at keyframe boundaries) and making every piece × resolution a separate job; hundreds of workers run them at once, and at the end the pieces are joined in a playlist. An hour of video in **3 minutes**, and a spot interruption only redoes that 4-second piece: 0.02% wasted. This one decision makes spot workers both cheap and safe. The published encoding pipelines of platforms like Netflix have this shape.
- **Low quality first:** the video is "watchable" (360p and 240p ready) in 32–38 seconds. The creator can share the link almost immediately, and 1080p arrives a few minutes later. With 100 workers the order barely changes anything (everything is fast anyway), but in experiment 1, with 20 workers, it is 1.7 vs 1.3 minutes: this priority helps when workers are few or the queue is busy.

The price: the complexity of splitting the pieces and joining them (every piece must start with a keyframe, or there's a jolt at the joins), and managing many small jobs. Every job is **idempotent**: the output's name is fixed by `video/resolution/piece`, so if the queue hands out the same job twice (7.4's at-least-once), nothing is written the second time (smoke step 12).

### 1.5 Deep dive 2 - Adaptive bitrate: the player's decision

With a ladder and pieces, the player decides which quality to show, piece by piece. **Adaptive Bitrate (ABR)** - before fetching each piece, the player looks at its network's measured speed and how much is stored in the buffer, and picks a quality from the ladder; it goes down when the network gets bad and up when it gets good. And its central failure: **Rebuffer Ratio** - what share of the watching time the video was stopped because the buffer ran empty (the spinning wheel). Viewers are happy with lower quality; they leave when it stops.

`npm run abr`: 300 sessions, a 10-minute video, 4 s pieces, a mobile network that swings between 0.4 and 12 Mbps:

```
policy                                                                start-up delay    stalled  avg bitrate  quality switches
always 1080p                                                                   5.4 s     32.63%   5.00 Mbps               0.0
always 240p                                                                    0.4 s      0.00%   0.40 Mbps               0.0
throughput: the highest under 80% of the last 3 rates                          0.8 s      0.22%   2.35 Mbps              32.9
buffer: lowest below 8 s, highest at 24 s                                      0.4 s      0.40%   3.06 Mbps              46.9
mixed: throughput, drop when the buffer is low, climb step by step             0.4 s      0.08%   2.32 Mbps              34.5
```

- **Always the highest:** stopped for **a third** of the watching time. That is what handing out the 15 GB file directly leads to.
- **Always the lowest:** never stops, but everyone at 240p.
- **Throughput-based:** measure the speed of the last few pieces and take the best one under 80% of it. 0.22% stalled, 2.35 Mbps average. Why the 20% margin: in experiment 3, taking 100% triples the rebuffering (0.60%), because the measured speed is always a little old and the network can get bad right then.
- **Buffer-based:** don't measure speed, look at the buffer: low buffer, low quality; high buffer, high quality. The highest average bitrate (3.06), but more switching (47 times), and quality jumping back and forth is noticeable.
- **Mixed:** the throughput maths, but drop immediately when the buffer is very low, and climb one step at a time. Rebuffering **0.08%**, the lowest. The algorithms of published players have this kind of mixed shape.

And one more design aspect: the piece length. Short pieces (2 s) mean quality switches faster and start-up is faster, but more requests and less efficient encoding (every piece starts with a keyframe, and keyframes are expensive). Long pieces (10 s) the opposite. 2–6 s is common.

### 1.6 Deep dive 3 - Popularity: what to keep where, and who gets the expensive codec

Like 11.1 and 11.4, popularity is sharp. `npm run cdn`: 100 million videos (10 minutes on average), 6 billion hours watched a month, Zipf (s = 1.2):

```
most popular                           video  share of watching  space at the edge (all resolutions)
0.1%                                 103,359       92.4%                     80.6 TB
1%                                 1,023,965       96.1%                      799 TB
10%                             10.1 million              98.5%                               7.9 PB

videos not watched even once a month (approx.): 4.0%
videos whose monthly watching egress costs less than their transcode: 62.1%
```

- **0.1% of videos get 92% of the watching,** and all their resolutions together are only 81 TB. That fits in every big edge location. So in video the CDN's hit rate is very high, and the load on the origin small. (This is the ideal maths of "keeping the most popular"; a real LRU gets a bit less, and the first few minutes of a newly popular video come from the origin, a wave that 4.5's origin shield absorbs.)
- **The long tail:** for 62% of videos, a whole month's watching egress costs less than their one-time transcode. Building every resolution in advance for every video is waste for them. The cheap path: a ladder with fewer steps for unpopular videos, and the remaining steps built on first demand (just-in-time), or added later if it becomes popular.

**Popularity-Tiered Encoding** - choosing how much to spend on encoding by the video's popularity: everyone gets a cheap, fast codec (H.264); when a video becomes popular it is re-encoded in an expensive but efficient codec (like AV1, about 30% fewer bits at the same quality, but many times more expensive to encode). The reason is 1.2: encode once, egress every time. Part B:

```
extra encode for a 10-minute video: $0.120; saved per hour watched $0.00405
break-even: at ~30 hours watched a month (assuming it pays back within a month)

policy                                     video  extra encode/month  egress saved/month           net
all videos                           100 million         $12,000,000         $24,300,000   $12,300,000
over 30 hours a month                  2,235,202            $268,224         $23,589,440   $23,321,215
over 296 hours a month                   333,367             $40,004         $22,971,363   $22,931,359
```

Moving every video to AV1 is still a gain (net $12.3 million). But moving only the 2.2 million videos (2.2%) watched more than 30 hours a month is **almost double the gain** ($23.3 million), because they deliver almost all the savings for only 2% of the extra encoding. Experiment 4: if encoding is 30 times more expensive, AV1 on every video is a **loss** (−$14.4 million), but on the popular ones still +$23 million. And another real-world aspect: not every device can decode AV1, so the H.264 copy always stays, and AV1 is an extra copy only for devices that can play it.

### 1.7 A real VOD service

`npm run smoke` runs an Express service: after upload, piece × resolution jobs go into a queue, workers are run by hand, states (`uploaded → processing → playable → ready`), and real HLS master and media playlists:

```
#   step                                            result
1   upload done, jobs in the pipeline          id 1; 75 jobs in the queue (15 pieces × 5)
2   master playlist, nothing built yet                    404
3   30 jobs (360p and 240p first)                         playable (30/75)
4   the master playlist now                               240p/index.m3u8, 360p/index.m3u8; Cache-Control: public, max-age=2
5   the remaining jobs; the worker on 720p piece 3 died   ready; failed 1, ran 76
6   master playlist (ready)                           Cache-Control: public, max-age=86400
                                                      #EXTM3U
                                                      #EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=427x240
                                                      240p/index.m3u8
                                                      …
                                                      #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
                                                      1080p/index.m3u8
7   480p's playlist (first 5 lines)                       #EXTM3U | #EXT-X-TARGETDURATION:4 | #EXT-X-PLAYLIST-TYPE:VOD | #EXTINF:4.0, | 0.ts
8   player, network 1 Mbps (80% rule)                     360p; first piece 400 B
9   player, network 3 Mbps (80% rule)                     480p; first piece 700 B
10  player, network 8 Mbps (80% rule)                     1080p; first piece 2500 B
11  a piece's Cache-Control                               public, max-age=31536000, immutable
12  the queue handed out the same job again (at-least-once)  75 new writes in total, 1 skipped
```

**The spaced repetition answer:** change the content without changing the name and the CDN's edges keep serving the old one until the TTL runs out, and purging (4.5) is slow and uncertain. The fix: when the content changes, change the name too (a version or hash), and make whatever has that name `immutable`, cached forever. Here every piece never changes once built, so a year and `immutable` (step 11). But the master playlist changes during processing (two qualities first, five later), so `max-age=2` then (step 4), and a day once it's `ready` (step 6). The mistake would have been caching the master from during processing for a day: viewers would have got nothing above 360p for a day.

Step 5: one worker died, and only that one piece was redone (76 jobs, 75 needed). Steps 8–10: three qualities from the same master on three networks, by 1.5's 80% rule.

### 1.8 Step 5 - Trade-offs and wrap-up

**The final design:**

- **Upload:** presigned multipart (8.2), the original file in durable storage; then an event.
- **Pipeline:** 4 s pieces × the ladder, on spot workers, with idempotent output; 360p and 240p first (playable in seconds), the rest in minutes. A small ladder for unpopular videos, the remaining steps and AV1 when popular.
- **Delivery:** HLS/DASH; pieces `immutable`, playlists with a short TTL while they can change; origin shield, CDN, and at large scale caches inside ISPs.
- **Player:** mixed ABR (throughput + buffer safety + climbing step by step), 2–6 s pieces.
- **Storage:** the original file and every step for popular videos; old and unpopular ones in a cheap tier, with fewer steps.

> **Trade-off Table - video's big decisions**

| Decision   | Chose                                     | Alternative                      | What I gave                                       | What I got                                                 |
| ---------- | ----------------------------------------- | -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Pipeline   | 4 s pieces, hundreds of workers, spot     | The whole video as one job       | The complexity of splitting and joining pieces    | 4 hours → 3 minutes; spot waste 14% → 0.02%                |
| What first | 240p/360p first                           | Everything together              | No HD for the first few minutes                   | Watchable in ~30 s                                         |
| Player     | Mixed ABR                                 | The highest, or throughput alone | A somewhat lower average bitrate                  | Rebuffering 33% (highest) → 0.08%                          |
| Codec      | H.264 for all, AV1 too for the popular 2% | AV1 for all / for none           | Two copies, two pipelines                         | Almost double the net gain of AV1 on every video           |
| Ladder     | By popularity                             | The full ladder for everyone     | Lower quality for the first viewer (just-in-time) | Saves needless transcoding and storage for 62% of videos   |
| Cache      | Pieces immutable, playlists a short TTL   | The same TTL for everything      | Rules for two kinds of headers                    | Hits on the CDN forever, but new qualities show up quickly |

**Live streaming in one line:** the same structure (pieces, playlists, ABR), but the playlist changes every few seconds, transcoding is in real time (as soon as each piece arrives), and delay (glass-to-glass latency) is a new constraint, hence short pieces or special low-latency variants.

**What breaks first:** a sudden viral video (misses on every edge for the first few minutes, a wave on the origin - 4.5's origin shield and request coalescing); a big creator's thousand videos at once in the transcoding queue (like 11.4, split the queue); and the egress bill, which every new feature (autoplay, previews) quietly increases.

---

## 2. Interview Angle

The core of "Design YouTube/Netflix" is almost always three places: upload and transcoding, delivery and the CDN, and the player's adaptive bitrate. The shape of a good answer:

1. **Numbers and cost first.** Egress in PB and Tbps, and 78% of the bill. Say this and the interviewer knows you understand why the rest of the decisions are what they are.
2. **The ladder and the manifest.** Why not one file but several qualities and small pieces, and how the player chooses.
3. **The pipeline.** Pieces in parallel, idempotent, spot, low quality first.
4. **Popularity.** Why the CDN's hit rate is high, a cheap path for the long tail, and an expensive codec for the popular.

**Follow-ups that are almost certain:**

- _"How will you cut the start-up delay?"_ - The first piece in low quality (arrives fast), short pieces, caching on the CDN, and fetching the first piece along with the playlist (prefetch).
- _"How will you make transcoding fast?"_ - Pieces in parallel; 4 hours to 3 minutes. And low quality first.
- _"What if the network is bad?"_ - ABR; the numbers: always the highest is stopped 33% of the time, the mixed policy 0.08%.
- _"How will you cut the cost?"_ - On egress: a better codec for the popular, per-title ladders, caches inside ISPs. On storage: fewer steps and a cheap tier for the unpopular.
- _"Will you keep every video on the CDN?"_ - No; 0.1% get 92% of the watching, 81 TB. The tail from the origin, through the shield.
- _"View counts?"_ - Like 11.1's clicks: as events, in a separate pipeline, no writes on the read path.

**In real production:** the most common problems: hundreds of thousands of people starting at the same moment for a big match or premiere (a wave on the origin and the CDN's capacity); an encoder bug that brings jolts or audio mismatches into some pieces, and thousands of videos needing re-encoding; a wrong ABR setting in the player that makes rebuffering jump on a particular network (in one country, on one carrier), which only shows up when metrics are split by country; and a sudden jump in the egress bill because some app version defaulted to the wrong quality.

---

## 3. Key Takeaway

- **A video bill is an egress bill:** 270 PB a day, 78% of the bill; transcoding 1%. Encode once, egress every time - so saving bits is money directly, and spending more on encoding often pays
- **Not one file, but a ladder and small pieces:** the player picks a quality for each piece; the manifest says what is where; every piece is a static file that any CDN can serve
- **The pipeline runs in pieces, in parallel:** an hour of video from 4 hours to 3 minutes, and waste on spot interruptions from 14% to 0.02%. Low quality first, idempotent output
- **ABR's job is between rebuffering and quality:** always the highest is stopped 33% of the time; the mixed policy (throughput + buffer safety + climbing in steps) 0.08%; keep a 20% margin on the measured speed
- **Popularity is sharp:** 0.1% of videos get 92% of the watching (81 TB, fits at the edge); 62% of videos have less monthly egress than their transcode
- **Encode by popularity:** AV1 only on the popular 2% is almost double the net gain of giving it to every video; if encoding gets more expensive, a loss for everyone
- **Pieces immutable, playlists a short TTL while they change** - 4.5's rule, this time applied differently to two kinds of things

---

## 4. New Terms (Glossary)

| Term                             | Meaning                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Egress**                       | Data leaving a data center or CDN, priced per GB - in video every viewer pays the full price every time, so it is most of the bill                                                                         |
| **Bitrate Ladder**               | Several resolution/bitrate versions of the same video (here 240p at 0.4 Mbps to 1080p at 5 Mbps); the player picks one; with per-title encoding every video has its own ladder                             |
| **Manifest (HLS / DASH)**        | A text file saying how the video is split up and where to find it - master (which qualities exist) and media (the list of pieces); the pieces are static files, so any CDN can serve them                  |
| **Segment-Parallel Transcoding** | Splitting the video into small pieces at keyframe boundaries and making piece × resolution separate jobs - hundreds of workers at once, only one piece redone on failure; makes spot workers safe          |
| **Adaptive Bitrate (ABR)**       | The player picks a quality before each piece by looking at the measured speed and the buffer; throughput-based, buffer-based, or mixed - the trade-off is between rebuffering, quality and switching       |
| **Rebuffer Ratio**               | The share of watching time the video was stopped because the buffer was empty - the biggest reason viewers leave; low quality is far better than stopping                                                  |
| **Popularity-Tiered Encoding**   | Choosing encoding cost by popularity - everyone gets a cheap codec and a small ladder, the popular get an expensive efficient codec (AV1) and the full ladder; because encoding is once, egress every time |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. On one mobile carrier in one country, rebuffering has gone from 0.1% to 2% for a week, while everywhere else is normal. (a) What could the causes be (at least three, from this lesson)? (b) Which metrics, if not split by country and carrier, would never have caught this? (c) One fix from the player's side and one from the CDN's side.

2. A new feature: hovering the mouse over any video's thumbnail on the home page (or scrolling on a phone) plays a 5-second preview. Product says "it's a small thing". (a) Using 1.2's numbers, what could this do to egress? (b) Which design (ladder, where it's cached, when it plays) keeps the cost within limits? (c) Which one metric would you make mandatory before this feature launches?

3. A big creator has 20,000 old videos from 10 years on their channel, and today they are re-uploading all of them at once (better-quality original files). (a) What will happen in 1.4's pipeline, and what will happen to every other creator's uploads? (b) Which design keeps this separate from everyone else (like 11.4 and 11.5)? (c) Which of these 20,000 videos will you give the full ladder and AV1, and how will you decide?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) (1) **That carrier's network behaviour changed** (new traffic shaping, or slowing down video, which some carriers do) and the player's 20% ABR margin isn't enough there; (2) **a problem with the CDN's PoP in that region or the cache inside the ISP** (full, a bad node, or routing changed so it goes to a far PoP), so pieces arrive late and misses are higher; (3) **a new version of an app** that is used more in that country, with changed ABR settings or start-up quality; (4) a popular new video in that country that isn't warm at the edge yet (the first few minutes from the origin, from far away).

(b) Rebuffer ratio, start-up delay, and average bitrate - split by **country × carrier (ASN) × app version × CDN PoP**. In the overall number, 2% on one carrier in one country is a drop in the ocean: the whole system's average barely moves (10.4's "the average hides"). Plus metrics on the CDN side: hit rate and piece latency by PoP.

(c) **Player:** for that carrier (by ASN, or from measured behaviour), widen the ABR margin and enlarge the buffer reservoir so it drops earlier; a lower start-up quality. **CDN:** fix the PoP's capacity or routing in that region, peer with the ISP, or warm popular pieces there in advance (prefetch/pre-warm).

**Question 2:**

(a) On the home page a viewer may pass over 10–20 thumbnails a minute. Each preview is 5 s × say 1.5 Mbps ≈ 1 MB. 200 million DAU × say 50 previews a day = 10 billion MB a day ≈ 10 PB, about 4% of 1.2's 270 PB, ~$3 million a month, just on this "small thing". And if it autoplays (plays as soon as you scroll), the number is several times that.

(b) For previews: (1) **a separate, very small ladder** - 240p or 360p, low bitrate, no sound, one 5 s piece, built once when the video is made; (2) only for **popular videos** (1.6: they are warm at the edge anyway), just an image for the rest; (3) it starts after a delay (500 ms of the mouse resting on it), not mid-scroll; (4) off on cellular networks, or by the user's setting.

(c) **Conversion from preview to a real view vs the egress cost of previews** - the price of a view in dollars. If watching a preview doesn't increase real views, the feature is just cost. This is a 10.7 unit economics question, answered before launch with an A/B test.

**Question 3:**

(a) 20,000 videos × 10 minutes on average × 4 CPU-hours per hour ≈ 13,000 CPU-hours, and millions of piece jobs in the queue at once. In one FIFO queue, every other creator's new uploads are behind them: 11.4's celebrity fan-out problem. The "playable" target for the day's uploads (a few minutes) breaks for hours.

(b) **Priority tiers** (11.5): new uploads in the upper tier, re-encoding the old catalogue in the lower tier; and a **per-creator limit** (how many jobs at once, like 11.2), so one creator can't take every worker. Batch work can be run at spot's cheapest time (at night), because it isn't urgent.

(c) 1.6's rule: first everyone gets the cheap ladder (240p–720p, H.264), so the channel works. Then **popularity is known from history** (the old videos' watching data): the videos watched more than 30 hours in the last month get the full ladder and AV1, in order of popularity. The rest only when needed (1080p just-in-time if someone wants to watch). There is an advantage here: unlike a new upload, popularity doesn't have to be guessed, the data exists.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (four deterministic models and a real Express + Zod VOD service, with HLS playlists; no Docker or ffmpeg needed)

> **Ready to run in the repo:** [`exercises/lesson-11.6-video-streaming/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.6-video-streaming) - `npm install`, then `npm run estimate`, `npm run transcode`, `npm run abr`, `npm run cdn`, `npm run smoke`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out egress, bandwidth, uploads, storage, transcoding and the monthly cost. `transcode` runs four pipeline designs with spot worker interruptions. `abr` measures five bitrate policies on a fluctuating network. `cdn` works out edge space, the long tail and AV1's economics from the popularity distribution. `smoke` runs a real VOD service and shows 12 steps from upload to player.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the five scripts twice each, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **The estimation and price inputs are assumed** (1 hour a day, 3 Mbps, 300 hours uploaded a minute, CDN $0.01/GB, 4 CPU-hours per hour), not measured. `transcode` has no real encoding, and spot interruptions are Poisson. `abr`'s network is synthetic and its policies are simplified versions of real players. `cdn`'s popularity is a Zipf (s = 1.2) model, and the edge maths is ideal; the AV1 numbers are a rough estimate from published comparisons. `smoke`'s pieces are fake bytes, and the store is in memory. Netflix's Open Connect and encoding pipeline come from their published writing, not verified here. **Not measured:** real encoding time and quality, a real player, a real CDN's hit rate, DRM, live.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `estimate`, write down: what share of the bill goes to egress, storage and transcoding? Then run it and compare. Then, with `AVG_MBPS=2` (a better codec or ABR), how much is saved a month?

2. **Piece length:** `SEGMENT_S=2` and `SEGMENT_S=10` in `transcode`, and the same in `abr`. How do publish time, wasted CPU, rebuffering and quality switches move? The encoding efficiency side (keyframes) is not in the model - which way would it have pulled?

3. **A more unstable network:** `STATE_S=2 npm run abr`. Which policy's rebuffering grew the most, and why does the buffer-based policy hold up comparatively well here?

4. **Changing code:** the README's experiment 5 (a ladder by popularity). Then add a view count to `src/vod.ts` that goes up on every request for the first piece (`0.ts`) - but behind a CDN, almost no requests will reach the origin. So where will you count views?

5. **The design part:** a "one-page design doc" for this platform, in Lesson 1.2's five steps: (a) the requirements and what was left out; (b) five numbers and one decision from each (including cost); (c) the picture from upload to viewer; (d) the pipeline and ABR policies, with numbers; (e) a cost plan: which three decisions cut egress, and with which metric you will measure each.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges), 11.1 – 11.5
Current: 11.6 - Case Study: Design a Video Streaming Platform
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 - URL shortener; 2 - rate
limiter service; 3 - chat; 4 - news feed; 5 - notifications. Case study 6 - video: 200 million DAU, 270 PB of egress a
day (peak 63 Tbps), egress 78% of the bill, transcoding 1% → encode once, egress every time. Bitrate ladder
(240p–1080p, 5 steps), HLS manifest (master + media), pieces as static files. Pipeline: 4 s pieces × resolution,
hundreds of spot workers, idempotent (4 hours → 3 minutes, spot waste 14% → 0.02%), 360p/240p first (playable in
~30 s). Mixed ABR (throughput + buffer + climbing in steps): rebuffering 33% (always highest) → 0.08%. Popularity: 0.1%
of videos get 92% of the watching (81 TB at the edge); 62% of videos have egress < transcode → a small ladder,
just-in-time; AV1 only for the popular 2% (double the net gain of all). Pieces immutable, the master a short TTL during
processing.
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (vs Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation, Priority Tier,
Provider Throughput Limit, Pacing, Provider Failover, Aggregation Window (Collapse Key), Quiet Hours,
Device Token Lifecycle, Egress, Bitrate Ladder, Manifest (HLS / DASH), Segment-Parallel Transcoding,
Adaptive Bitrate (ABR), Rebuffer Ratio, Popularity-Tiered Encoding
Weak spots: [where you got stuck - write it yourself]
Next: 11.7 - Case Study: Design a Payment System
=======================
```

---

## 8. Next Step

Today's thread: **when something costs money every time it is watched and once when it is made, spend more on making it to cut the cost of watching - but only where the watching really happens.** The ladder and pieces protect the viewer on a bad network, pieces make the parallel pipeline fast and spot safe, and the sharp popularity distribution tells you who gets the expensive encoding and the space at the edge.

When you are ready, write `next` - we go to **Lesson 11.7: Design a Payment System**, Module 11's last case study. Here every rule turns upside down: approximations don't work, eventual consistency is dangerous with money, and "twice" means someone's money taken twice. 2.5's idempotency key, 5.5's transactions, 7.5's outbox, 9.3's saga, and 11.5's "a timeout means I don't know" - all in one place, under maximum pressure. The questions: when the external payment provider times out, how will you know whether the money was taken, why a double-entry ledger, and why matching your own records against the bank's at the end of the day (reconciliation) is the most important job.
