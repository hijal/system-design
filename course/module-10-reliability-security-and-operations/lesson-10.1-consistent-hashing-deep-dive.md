# Lesson 10.1 — Consistent Hashing Deep Dive

**Module 10 — Reliability, Security & Operations**

> **Spaced Repetition (Lesson 4.6):** Cache stampede কী, আর তার দুটো প্রতিকার এক লাইন করে বলুন। আর "hot key" সমস্যাটা stampede থেকে কোথায় আলাদা? আজ দুটোই ফিরবে — প্রথমটা এমন জায়গা থেকে যেখান থেকে আপনি আশা করবেন না: একটা cache node **যোগ** করা থেকে।

**Prerequisite:** Lesson 3.2 (IP hash আর consistent hashing এর পরিচয়), Lesson 4.2 (Cache-aside, invalidate-on-write), Lesson 4.6 (Stampede, hot key), Lesson 5.8 (Sharding, resharding — ৭৫% বনাম ~২৫%), Lesson 5.9 (Replica, quorum), Lesson 6.1 (ধীর বনাম মৃত — বাইরে থেকে আলাদা করা যায় না), Lesson 9.4 (Health check, registry)

**আপনি এই lesson শেষে পারবেন:**

1. `hash % N` কেন node বদলালে প্রায় সব key নাড়ায় — আর তার চেয়েও বড় কথা, নড়া key গুলো **কোথায়** যায় — সংখ্যা দিয়ে বলতে পারবেন, আর hash ring কীভাবে এটাকে শুধু নতুন node এর ভাগে নামিয়ে আনে
2. Virtual node কেন ছাড়া চলে না, কয়টা লাগে আর তার দাম কী, আর replica বাছাইয়ে virtual node যে ফাঁদটা বানায় সেটা ধরতে পারবেন
3. Ring, rendezvous আর jump hash এর মধ্যে বাছতে পারবেন, আর consistent hashing **যা করে না** সেটা বলতে পারবেন — consistency দেয় না, hot key সারায় না, আর সব client একই ring দেখছে কিনা সেটার দায় নেয় না

**Tier:** 1 — Runnable Code (hash ring, `hash % N`, rendezvous আর jump hash — সব deterministic simulation এ গোনা; Docker লাগে না)

---

## ০. TaskFlow এখন কোথায়

Module 9 এর পরে TaskFlow এর Redis দুই ভাগ হয়েছে: rate limiter নিজের Redis এ (9.5), আর cache আলাদা। কিন্তু cache নিজেই আর একটা machine এ ধরছে না — task list, board, workspace এর member list মিলিয়ে working set ১০ GB এর উপরে, আর `allkeys-lru` (4.3) দিনভর evict করছে, hit rate ৯৬% থেকে নেমে ৮৮%।

তাই দুই মাস আগে একজন engineer একটা ছোট wrapper লিখল:

```typescript
const clients: Redis[] = env.CACHE_NODES.split(',').map((url) => new Redis(url));

export function cacheFor(key: string): Redis {
	const client = clients[hash(key) % clients.length];
	if (!client) throw new Error('no cache nodes configured');
	return client;
}
```

তিনটা Redis, প্রত্যেকে এক-তৃতীয়াংশ key। Hit rate আবার ৯৬%। সবাই খুশি।

**সোমবার, সকাল ৯:৩০।** দুপুরে একটা বড় customer এর launch, traffic দ্বিগুণ হওয়ার কথা। Ops আগেভাগে প্রস্তুতি নিল: একটা চতুর্থ Redis চালু করল, `CACHE_NODES` এ যোগ করল, rolling deploy। **৯:৩১** এ Postgres এর CPU ১০০%। **৯:৩২** এ board এর p99 ৪ সেকেন্ড, connection pool ভরা (5.6)। **৯:৩৪** এ গোটা site প্রায় অচল। কেউ কোনো code বদলায়নি, কোনো query বদলায়নি — শুধু **একটা বাড়তি cache node**, যেটা চাপ **কমানোর** জন্য আনা হয়েছিল।

Postmortem এ দুটো প্রশ্ন উঠল। প্রথমটা সোজা: কেন? দ্বিতীয়টা CTO এর: "Consistent hashing এর নাম তো আমরা 3.2 আর 5.8 এ শুনেছিলাম। এবার পুরোটা বুঝুন — আর মাপুন, শুধু বদলে দেবেন না। কারণ আমি শুনেছি ওটারও নিজের ফাঁদ আছে।"

তিনি ঠিক শুনেছিলেন। এই lesson এ দুটোই।

---

## ১. Theory

### ১.১ `hash % N` এর আসল দাম — কত নড়ে, আর কোথায় যায়

5.8 এ আমরা একটা সংখ্যা দেখেছিলাম: ৩ থেকে ৪ shard এ `hash % N` এ ~৭৫% key নড়ে। কেন এত? একটা key জায়গায় থাকে শুধু যদি `h % 3 == h % 4` হয় — আর সেটা ১২টা ভাগশেষের মধ্যে মাত্র ৩টায় সত্যি (০, ১, ২)। অর্থাৎ ২৫% থাকে, ৭৫% নড়ে। সাধারণভাবে N থেকে N+1 এ **প্রায় N/(N+1) key নড়ে** — node যত বেশি, নড়া তত বেশি। বড় cluster এ `hash % N` প্রায় পুরো data কে ঝাঁকায়।

কিন্তু সংখ্যাটা অর্ধেক গল্প। Exercise এর `npm run rebalance`, ৪ থেকে ৫টা node, ১,০০,০০০ key:

```
routing                        moved  to the new node    among the old
hash % N                       79.9%         25.2%            74.8%
ring (vnode 1)                 30.7%        100.0%             0.0%
ring (vnode 160)               20.1%        100.0%             0.0%
   ideal: only the new node's share = 1/5 = 20.0%, and all of it to the new node
```

শেষ কলামটা দেখুন। `hash % N` এ নড়া key গুলোর **৭৪.৮% এক পুরনো node থেকে আরেক পুরনো node এ গেছে**। Node ১ এর একটা key node ৩ এ, node ৩ এর একটা key node ২ এ — যদিও ওই পুরনো node গুলোর কারো ভাগ কমার কথা ছিল না, শুধু নতুনটার ভাগ বাড়ার কথা। এটা নিছক অপচয়: যে data ঠিক জায়গাতেই ছিল, সেটাও ফেলে দিয়ে নতুন করে আনতে হচ্ছে।

**Consistent Hashing** — key কে node এ বসানোর এমন একটা পদ্ধতি যেখানে N টা node এর একটা যোগ বা বাদ দিলে গড়ে শুধু ~১/N ভাগ key নড়ে, আর নড়া key গুলো **শুধু** সেই যোগ হওয়া (বা বাদ যাওয়া) node এর সাথে আদান-প্রদান হয় — বাকি node দের নিজেদের মধ্যে কিছু নড়ে না।

উপরের টেবিলে ring এর সারি দুটো ঠিক এটাই: নড়া key এর ১০০% নতুন node এ, পুরনোদের মধ্যে ০%। আর virtual node সহ পরিমাণটাও আদর্শের প্রায় সমান — ২০.১% বনাম ২০%।

### ১.২ Hash Ring — বৃত্তের উপর key আর node দুটোই

**Hash Ring** — hash এর পুরো মানের পরিসরকে (যেমন ০ থেকে ২³²−১) একটা বৃত্ত হিসেবে দেখা, যেখানে প্রতিটা node কে তার নামের hash এর বিন্দুতে বসানো হয়, আর একটা key এর মালিক হলো তার hash এর বিন্দু থেকে **ঘড়ির কাঁটার দিকে প্রথম যে node** পাওয়া যায়।

```
                        0 / 2³²
                          │
                  ┌───── A ─────┐
                 ╱               ╲         key k1 → ঘড়ির কাঁটার দিকে প্রথম node = B
               k3                 k1
              ╱                     ╲
             C                       B      A এর ভাগ: C থেকে A পর্যন্ত বৃত্তচাপ
              ╲                     ╱       B এর ভাগ: A থেকে B পর্যন্ত
               ╲                   ╱        C এর ভাগ: B থেকে C পর্যন্ত
                └───── k2 ────────┘
                                             k2 → C,   k3 → A

   এবার D যোগ হলো — B আর C এর মাঝে, k2 এর ঠিক পরে (ঘড়ির কাঁটার দিকে):

        B ──── k2 ──── D ──── C             k2 → এখন D (আগে C)। শুধু B থেকে D পর্যন্ত চাপটা
                                            C থেকে D তে গেল; A আর B এর একটা key ও নড়েনি।
```

কেন এটা কাজ করে: একটা node যোগ হলে সে বৃত্তের একটা বিন্দুতে বসে, আর শুধু তার ঠিক আগের বৃত্তচাপটা — যেটা এতদিন তার পরের node এর ছিল — নিজের করে নেয়। বাকি বৃত্তের কোনো key এর "ঘড়ির কাঁটার দিকে প্রথম node" বদলায়নি। বাদ দিলে উল্টোটা: তার বৃত্তচাপ তার পরের node পেয়ে যায়।

Lookup টা সহজ — বৃত্তের বিন্দুগুলো সাজানো একটা array তে, আর key এর hash এর চেয়ে বড় বা সমান প্রথম বিন্দুটা binary search দিয়ে খোঁজা (শেষে পৌঁছালে শুরুতে ফিরে যান — সেটাই "বৃত্ত"):

```typescript
route(key: string): string {
	const h = hash32(key);
	let lo = 0;
	let hi = this.points.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((this.points[mid]?.point ?? 0) < h) lo = mid + 1;
		else hi = mid;
	}
	const owner = this.points[lo === this.points.length ? 0 : lo];
	if (!owner) throw new Error('empty ring');
	return owner.node.id;
}
```

কিন্তু উপরের টেবিলের দ্বিতীয় সারিটা দেখুন: শুধু একটা বিন্দুতে (`vnode 1`) বসালে নড়েছে **৩০.৭%**, ২০% না। কারণ নতুন node টা বৃত্তের কোথায় পড়বে সেটা hash ঠিক করে — আর সে এমন জায়গায় পড়েছে যেখানে তার আগের বৃত্তচাপটা বড়। একটা বিন্দুর ring এ প্রতিটা node এর ভাগ **বৃত্তচাপের দৈর্ঘ্য**, আর সেই দৈর্ঘ্য এলোমেলো। এর পরিণাম node বাদ দেওয়ার সময় আরও খারাপ:

```
routing                      cache-1   cache-2   cache-4   cache-5      heaviest
ring (vnode 1)                    0%      100%        0%        0%         1.45x
ring (vnode 160)                 29%       19%       25%       27%         1.04x
```

`cache-3` মরলে একটা বিন্দুর ring এ তার **সব** key একজন প্রতিবেশী (`cache-2`) এর ঘাড়ে। সে এখন ন্যায্য ভাগের ১.৪৫ গুণ বইছে — আর যদি সে এই চাপে ধীর হয় বা মরে, তার পুরো ভাগ (নিজের + `cache-3` এর) আবার পরের জনের ঘাড়ে। এটা Lesson 9.4 এর cascade এর হুবহু আকার, এবার data এর ভাগে। দ্বিতীয় সারিতে সেই একই key গুলো চারজনের মধ্যে প্রায় সমানভাবে ছড়িয়েছে। পার্থক্যটা একটাই জিনিস — virtual node।

### ১.৩ Virtual Node — একটা machine, বৃত্তের অনেক জায়গায়

**Virtual Node (vnode)** — প্রতিটা physical node কে বৃত্তের একটা বিন্দুতে না বসিয়ে অনেকগুলো বিন্দুতে বসানো (যেমন `cache-1#0`, `cache-1#1`, … এর hash), যাতে প্রতিটা node এর ভাগ অনেকগুলো ছোট বৃত্তচাপের যোগফল হয় — আর অনেক এলোমেলো দৈর্ঘ্যের যোগফল গড়ের কাছাকাছি থাকে।

`npm run vnodes` — ১০টা node, ২,০০,০০০ key:

```
vnode / node          heaviest       lightest  points on ring   lookup steps
1                        3.06x          0.02x             10            3.4
10                       1.51x          0.61x            100            6.7
50                       1.23x          0.80x            500            9.0
100                      1.15x          0.87x          1,000           10.0
160                      1.13x          0.90x          1,600           10.7
500                      1.06x          0.95x          5,000           12.4
1000                     1.04x          0.97x         10,000           13.3
```

তিনটা জিনিস পড়ার আছে এই টেবিলে:

1. **Virtual node ছাড়া ring প্রায় অর্থহীন।** একটা বিন্দুতে সবচেয়ে ভারী node ন্যায্য ভাগের **৩ গুণ**, আর সবচেয়ে হালকাটা প্রায় কিছুই পায় না (০.০২x)। এটা একটা ব্যতিক্রমী দুর্ভাগ্য না — ১০টা এলোমেলো বিন্দু বৃত্তকে এরকম অসমানভাবেই ভাগ করে।
2. **উন্নতি কমতে কমতে আসে।** ১০ থেকে ১০০ এ ভারীটা ১.৫১x থেকে ১.১৫x; ১০০ থেকে ১০০০ এ মাত্র ১.১৫x থেকে ১.০৪x। মোটা দাগে বিচ্যুতিটা virtual node সংখ্যার বর্গমূলের বিপরীতে কমে — ১০০ গুণ বিন্দু দিয়ে বিচ্যুতি মাত্র ~১০ গুণ কমে।
3. **Lookup এর দাম লগারিদমিক, কিন্তু বাকি দাম সরাসরি।** ১০ থেকে ১০,০০০ বিন্দুতে binary search ৬.৭ থেকে ১৩.৩ ধাপ — হাজার গুণ বিন্দু, দ্বিগুণ কাজ, সেটা নগণ্য। কিন্তু ring এর memory, আর node যোগ-বাদের সময় ring নতুন করে বানানো আর **প্রতিটা client এ পৌঁছানো**, বিন্দু সংখ্যার সাথে সরাসরি বাড়ে। হাজার হাজার client এর প্রত্যেকে ১০,০০০ বিন্দুর ring রাখলে সেটা আর নগণ্য না।

আর একটা সুবিধা যেটা টেবিলে নেই কিন্তু ১.২ এর দ্বিতীয় টেবিলে দেখেছেন: অনেক virtual node মানে একটা node মরলে তার key **সবার মধ্যে** ছড়ায় (২৯/১৯/২৫/২৭%)। একই কারণে নতুন node যোগ হলে সে data **সবার কাছ থেকে একটু একটু** টানে — একজনের কাছ থেকে সব না। Storage system এ (Cassandra এর মতো) এর মানে নতুন node কে ভরানো অনেকগুলো পুরনো node থেকে সমান্তরালে চলে।

বাস্তবে সংখ্যাগুলো কেমন: memcached এর জন্য বিখ্যাত **ketama** library প্রতি server এ ১৬০টা বিন্দু বসায় — এই exercise এর default ওখান থেকেই। Cassandra বহু বছর default হিসেবে প্রতি node এ ২৫৬টা token রাখত; 4.0 থেকে default ১৬, সাথে একটা token বরাদ্দের algorithm যা এলোমেলো না বসিয়ে ভাগ সমান রাখার চেষ্টা করে (কম বিন্দু, কিন্তু বুদ্ধি করে বসানো)। অর্থাৎ "কয়টা" এর কোনো সর্বজনীন উত্তর নেই — cluster এর আকার, কতটা অসমতা সহ্য করা যায়, আর ring কতজনকে বিতরণ করতে হয়, এই তিনটা মিলিয়ে সিদ্ধান্ত।

### ১.৪ Weight — সব machine সমান না

Virtual node এর একটা বাড়তি উপহার: ভিন্ন আকারের machine সহজেই সামলানো যায়। দ্বিগুণ RAM এর machine কে দ্বিগুণ virtual node দিন, সে দ্বিগুণ ভাগ পাবে:

```
node                weight         got    fair share
cache-1                  1       19.6%         20.0%
cache-2                  1       18.7%         20.0%
cache-3                  1       20.3%         20.0%
cache-big                2       41.3%         40.0%
```

এর একটা বাস্তব ব্যবহার এই lesson এর গল্পের সাথে সরাসরি যুক্ত: নতুন node কে **ছোট weight দিয়ে** ঢোকানো, তারপর ধাপে ধাপে বাড়ানো। তাহলে cache miss এর ঢেউ একবারে না এসে কয়েকটা ছোট ঢেউয়ে আসে (১.৬)।

### ১.৫ Preference List — ৩টা copy, কিন্তু কোন ৩টা node?

Cache এ সাধারণত প্রতিটা key এর একটা copy। কিন্তু একটা database যদি ring দিয়ে data ভাগ করে (Amazon এর Dynamo paper, Cassandra, Riak এই ধারার), সে প্রতিটা key এর N টা copy রাখে — 5.9 এর quorum এর সেই N।

**Preference List** — একটা key এর copy গুলো যে node গুলোতে থাকবে তাদের ক্রমিক তালিকা; ring এ সাধারণত key এর বিন্দু থেকে ঘড়ির কাঁটার দিকে হেঁটে পরপর node বাছাই করে বানানো হয়।

সবচেয়ে সরল নিয়ম — "ring এ পরের ৩টা বিন্দু" — virtual node থাকলে একটা লুকানো ফাঁদ: পরের দুটো বিন্দু প্রায়ই **একই physical node** এর দুটো virtual node। `npm run vnodes`, অংশ গ — ৬টা node, ৩টা AZ (availability zone — একই cloud region এর ভেতরে আলাদা data center; একটা AZ পুরোটা একসাথে ডুবতে পারে), প্রতি key এর ৩টা copy:

```
rule                         not 3 distinct nodes  not 3 distinct AZs  one AZ loss kills all copies
the next 3 points                 45.3%              76.8%                  11.2%
the next 3 distinct nodes          0.0%              59.1%                   0.0%
the next 3 distinct AZs            0.0%               0.0%                   0.0%
```

- **প্রথম নিয়মে ৪৫.৩% key এর "৩টা copy" আসলে ২টা (বা ১টা) machine এ।** Config এ লেখা replication factor ৩, dashboard এ ৩, কিন্তু প্রায় অর্ধেক data একটা machine মরলেই quorum হারায়। আর ১১.২% key এর তিনটা copy ই একটা AZ এ — ওই AZ গেলে সেগুলো পুরোপুরি হারিয়ে যায়।
- **দ্বিতীয় নিয়ম (আলাদা node) machine এর ব্যর্থতা সামলায়, কিন্তু ৫৯.১% key এর দুটো copy এক AZ এ।** 6.1 এর ভাষায়: ব্যর্থতা আলাদা আলাদা আসে না, একসাথে আসে — একই rack, একই power, একই AZ। Copy গুলো যত "স্বাধীন" মনে হয়, ততটা না।
- **তৃতীয় নিয়ম (আলাদা AZ)** — ring এ হাঁটতে হাঁটতে যে node এর AZ ইতিমধ্যে নেওয়া হয়েছে তাকে এড়িয়ে যাওয়া। Cassandra এর `NetworkTopologyStrategy` ঠিক এই ধারণায় rack-সচেতনভাবে replica বসায়।

তৃতীয় নিয়মের একটা দাম আছে যা টেবিলে নেই (Reflection প্রশ্ন ২ এ ফিরব): AZ গুলোর আকার সমান না হলে — ধরুন একটা AZ এ ৩টা node, আরেকটায় ১টা — ওই একলা node কে পুরো data এর এক-তৃতীয়াংশ একাই রাখতে হবে। নিয়মটা নিরাপত্তা দেয়, ভাগের সমতা কেড়ে নিয়ে। তাই এমন system এ AZ গুলো সমান আকারে রাখা একটা operational নিয়ম, পছন্দ না।

### ১.৬ TaskFlow এর সোমবার — সংখ্যায়, আর ring এর নিজের ফাঁদ

এবার গল্পের ঘটনাটা মাপি। `npm run cache` — ৩টা cache node থেকে ৪টা, সব key আগে থেকে গরম (তাই বদলের আগে hit rate ~১০০%), ৫,০০০ read/s, traffic Zipf বণ্টনে (অল্প কিছু key খুব জনপ্রিয়, বাকিরা কম — বাস্তব cache traffic এর মতো):

```
routing                  first 1 s hit  DB in first 1 s   first 10 s hit  total DB queries
hash % N                         56.8%            2,162            75.4%         26,370
ring (vnode 160)                 85.3%              737            91.6%          9,066
```

**প্রথম সেকেন্ডে Postgres এ ২,১৬২টা বাড়তি query**, যেখানে আগে প্রায় শূন্য। TaskFlow এর board এর ওই query গুলোর প্রতিটা কয়েকটা join (5.6), আর Postgres তখন দুপুরের জন্য তৈরি না — ঠিক এটাই ৯:৩১ এর CPU ১০০%। এটা Lesson 4.6 এর cache stampede, কিন্তু নিজের হাতে বানানো: কোনো key এর TTL শেষ হয়নি, একসাথে হাজারটা key এর **ঠিকানা** বদলে গেছে।

Ring এ প্রথম সেকেন্ডে ৭৩৭ — প্রায় তিন ভাগের এক ভাগ। মোট DB query ২৬,৩৭০ থেকে ৯,০৬৬। এটাই consistent hashing এর আসল দাম-হিসাব, "key নড়ার %" না: **node বদলের পরের কয়েক সেকেন্ডে database কত চাপ খায়**।

একটা জিনিস আপনাকে অবাক করতে পারে: `hash % N` এ ৭৫% key নড়ে, তাহলে প্রথম সেকেন্ডে hit rate ২৫% না হয়ে ৫৬.৮% কেন? কারণ traffic Zipf — সবচেয়ে জনপ্রিয় key গুলো প্রথম কয়েক মিলিসেকেন্ডেই একবার miss করে নতুন node এ ভরে যায়, তারপর বাকি সেকেন্ড hit। Traffic যত skewed, ক্ষতি তত কম **দেখায়**: exercise এ Zipf ০.৫ এ প্রথম সেকেন্ডের hit rate ৩২.১%, Zipf ১.২ এ ৮৩.৪%। এটা একটা বিপজ্জনক সান্ত্বনা — staging এ (যেখানে অল্প কয়েকটা key বারবার পড়া হয়) node যোগ করে আপনি ভাববেন "কিছুই হয়নি", আর production এর লম্বা লেজের traffic এ Postgres পড়ে যাবে।

**Ring এর নিজের ফাঁদ: consistent hashing consistency দেয় না।** নাম শুনে মনে হয় দেয়, কিন্তু "consistent" এখানে শুধু "node বদলালে mapping বেশি বদলায় না"। এখন একটা ঘটনা ভাবুন যা ring এ যাওয়ার পরে সত্যিই ঘটতে পারে: 9.4 এর health check `cache-2` কে ৩০ সেকেন্ডের জন্য নাগালের বাইরে দেখল (network এর একটা ঝাঁকুনি — machine টা মরেনি, তার memory অক্ষত), আর registry তাকে ring থেকে বাদ দিল। ওই ৩০ সেকেন্ডে তার key গুলো অন্য node এ গেল; সেখানে miss হলো, ভরে গেল, আর কিছু task এর **write** হলো — cache-aside (4.2) অনুযায়ী DB update, তারপর cache এর key delete — কিন্তু delete গেল **তখনকার** মালিকের কাছে, `cache-2` এর কাছে না। তারপর `cache-2` ফিরল, পুরনো data সহ, আর ring তার key গুলো তাকেই ফেরত দিল:

```
on return                     stale read (10 s)  distinct stale keys  miss (10 s)
put back on the ring as is                6,429                 320          197
flush first, then put back                    0                   0        4,278
```

**দশ সেকেন্ডে ৬,৪২৯টা পুরনো উত্তর, ৩২০টা আলাদা key এ** — আর cache এ TTL না থাকলে এগুলো চিরকাল পুরনোই থাকবে। User এর চোখে: "আমি task টা Done এ সরালাম, কিন্তু board এ এখনো In Progress" — কয়েক ঘণ্টা ধরে, শুধু কিছু task এ, আর refresh করলেও না। 6.1 এর মূল কথা এখানে ফিরছে: বাইরে থেকে "ধীর" আর "মৃত" আলাদা করা যায় না, আর যে node কে আপনি মৃত ধরেছিলেন সে **পুরনো অবস্থা নিয়ে** ফিরে আসে।

প্রতিকার তিনটা, আর তিনটাই সস্তা:

1. **ফেরার আগে flush** — উপরের দ্বিতীয় সারি: stale ০, বিনিময়ে ৪,২৭৮টা miss (একটা ছোট, নিয়ন্ত্রিত ঢেউ)। Cache এর জন্য এটাই সঠিক বিনিময় — ভুল উত্তরের চেয়ে ধীর উত্তর ভালো।
2. **প্রতিটা cache key এ TTL** — stale থাকার একটা ছাদ। "কখনো মেয়াদ শেষ হয় না" এমন cache key আসলে একটা ধীর-গতির bug।
3. **বাদ দেওয়ায় দেরি (hysteresis)** — একটা ব্যর্থ check এ ring থেকে বাদ না; পরপর কয়েকবার, নির্দিষ্ট সময় ধরে। প্রতিটা বাদ-দেওয়া একটা miss এর ঢেউ, আর প্রতিটা ফেরা একটা stale এর ঝুঁকি — তাই ring এর membership যত কম দোলে, তত ভালো।

### ১.৭ Ring ছাড়া আরও দুটো পথ — Rendezvous আর Jump

Hash ring একমাত্র consistent hashing না। আরও দুটো পদ্ধতি বাস্তবে ব্যবহার হয়, আর তাদের দাম-সুবিধা আলাদা।

**Rendezvous Hashing (HRW, highest random weight)** — একটা key এর জন্য প্রতিটা node এর একটা score বের করা (`hash(node + key)`), আর সবচেয়ে বেশি score এর node কে মালিক করা। Node যোগ হলে শুধু সেই key গুলো সরে যাদের জন্য নতুন node টা সবার উপরে; node বাদ গেলে শুধু তার key গুলো, আর প্রতিটা নিজের দ্বিতীয় সেরার কাছে যায় — যা key ভেদে আলাদা, তাই ভার স্বাভাবিকভাবেই ছড়ায়।

**Jump Consistent Hash** — Google এর ২০১৪ সালের একটা ছোট algorithm যা একটা key আর bucket সংখ্যা `n` থেকে সরাসরি `0…n−1` এর একটা bucket নম্বর দেয় — কোনো ring, কোনো memory ছাড়া, গড়ে ~ln(n) টা ধাপে; শর্ত একটাই, bucket গুলো শুধু সংখ্যা, আর যোগ বা বাদ শুধু **শেষ** থেকে হতে পারে।

`npm run compare` — ১০টা node, ১,০০,০০০ key:

```
method                   heaviest  node added  cache-6 removed             lookup work    extra memory
ring (vnode 160)            1.12x        8.8%        10.0%  1 hash + 10.7 comparisons    1,600 points
rendezvous (HRW)            1.02x        9.3%         9.9%                 10 hash            none
jump hash                   1.02x        9.0%        48.5%      1 hash + 2.9 jumps            none
   ideal: on add 1/11 = 9.1%, removing a middle one 1/10 = 10.0%
```

- **Rendezvous** virtual node ছাড়াই প্রায় নিখুঁত ভাগ দেয় (১.০২x, ring এর ১৬০ virtual node এর ১.১২x এর চেয়ে ভালো), কোনো ring রাখতে হয় না, আর replica বাছাই স্বাভাবিক — score এর ক্রমে প্রথম ৩টা। দাম: **প্রতি lookup এ N টা hash**। ১০টা node এ সেটা কিছুই না; ১০,০০০ টা node এ প্রতিটা request এ ১০,০০০ hash। তাই ছোট থেকে মাঝারি cluster এ এটা প্রায়ই ring এর চেয়ে ভালো পছন্দ, আর বড় cluster এ ring (বা সংখ্যাটা ছোট রাখার কোনো কাঠামো)।
- **Jump hash** ভাগে নিখুঁত, memory শূন্য, lookup সস্তা — কিন্তু মাঝের একটা node বাদ দিলে **৪৮.৫%** key নড়ে। কারণ jump hash node চেনে না, শুধু bucket নম্বর চেনে; মাঝেরটা বাদ দিলে তার পরের সবার নম্বর এক করে সরে যায়। শেষের node বাদ দিলে ~৯.৯% (exercise এর experiment ৫)। তাই jump hash মানায় সেখানে যেখানে bucket গুলো **নিজেরা কখনো মরে না** — যেমন প্রতিটা bucket নিজেই একটা replicated shard (তার ভেতরের machine বদলায়, bucket নম্বর না)। একটা machine-এর-তালিকার সামনে সরাসরি, যেখানে যেকোনোটা যেকোনো সময় মরতে পারে, এটা ভুল যন্ত্র।

আরও একটা নাম জেনে রাখুন, কারণ load balancer এর config এ দেখবেন: **Maglev** — Google এর load balancer এর জন্য বানানো একটা পদ্ধতি যা একটা নির্দিষ্ট আকারের lookup table ভরে (ring এর binary search এর বদলে সরাসরি index), ভাগ খুব সমান রাখে, বিনিময়ে node বদলালে ring এর চেয়ে সামান্য বেশি নড়ে। Envoy এর load balancing policy তে `RING_HASH` আর `MAGLEV` পাশাপাশি থাকে ঠিক এই কারণে। এটা এখানে মাপা হয়নি।

### ১.৮ Hot Key — কোনো hash এটা সারায় না, আর Bounded Load এর দাম

একটা জিনিস উপরের কোনো পদ্ধতিই করে না: **hash key সমান ভাগ করে, request না।** একটা workspace এর board যদি একাই traffic এর ১৩% হয় (ধরুন একটা বড় customer এর launch — এই lesson এর গল্পের দুপুরটাই), সেটা যে node এ পড়বে সে বাকিদের চেয়ে অনেক বেশি চাপ খাবে। Ring, rendezvous, jump — সবার ক্ষেত্রে একই, কারণ একটা key এর মালিক একটাই।

**Bounded-Load Consistent Hashing** — consistent hashing এর উপর একটা সীমা বসানো: কোনো node তার ন্যায্য ভাগের `c` গুণের (যেমন ১.২৫) বেশি চলমান কাজ নেবে না; ভরে গেলে request টা ring এ তার পরের node এ যায়। (Google এর গবেষকদের ২০১৬ সালের কাজ; Vimeo এটা HAProxy তে বসিয়েছিল, এখন সেখানে `hash-balance-factor` নামে আছে।)

`npm run compare`, অংশ খ — Zipf ১.১, একসাথে ১,০০০টা request, ২০০ বার; সবচেয়ে গরম key একাই গড়ে ~১৩.৩% traffic:

```
method                          heavy (avg)         heavy (worst)      off its own node
ring (vnode 160)                     2.06x                 2.39x                  0.0%
bounded load, c = 1.25               1.25x                 1.25x                 11.3%
   (each node's limit = ceil(1.25 × 1000 / 10) = 125; when full, the next node on the ring)
```

সাধারণ ring এ সবচেয়ে ব্যস্ত node গড়ে ন্যায্য ভাগের **২ গুণ**, খারাপ মুহূর্তে ২.৪ গুণ। Bounded load এ ঠিক ১.২৫x — কখনো বেশি না। দাম: **১১.৩% request তাদের নিজের node এ যায়নি।**

ওই শেষ কলামের মানে কী, সেটা নির্ভর করে পেছনে কী আছে তার উপর — আর এখানেই সিদ্ধান্তটা:

- **পেছনে stateless কিছু** (যেমন একই API এর server গুলো, যেখানে consistent hashing শুধু connection বা local cache এর locality এর জন্য): ১১.৩% অন্য জায়গায় যাওয়া প্রায় বিনামূল্যে — locality সামান্য কমে, কিন্তু কোনো server ডোবে না। Vimeo এর ব্যবহার ঠিক এই ধরনের।
- **পেছনে cache বা data**: "নিজের node এর বাইরে" মানে ওই node এ data **নেই** — miss, আর একই key এর copy কয়েকটা node এ ছড়ানো। Cache এর hot key এর আসল উত্তর তাই 4.6 এর গুলোই: app এর নিজের ভেতরে একটা ছোট local cache (সবচেয়ে গরম কয়েকটা key এর জন্য, কয়েক সেকেন্ডের TTL), বা hot key কে কয়েকটা suffix দিয়ে ভাগ করা (`board:42#0…#7`, পড়ার সময় এলোমেলো একটা)।

### ১.৯ সবাই কি একই ring দেখছে?

এখন পর্যন্ত একটা অনুমান লুকিয়ে ছিল: TaskFlow এর **সব** app instance একই node তালিকা থেকে একই ring বানায়। সোমবারের গল্পে ফিরে যান — `CACHE_NODES` বদলানো হয়েছিল **rolling deploy** দিয়ে। দশ মিনিট ধরে ছয়টা instance এর কিছু পুরনো তালিকায় (৩টা node), কিছু নতুনে (৪টা)। একই key এর জন্য দুই দল দুটো আলাদা node কে মালিক ভাবছে। পুরনো দলের একটা instance task update করে key টা delete করল node A থেকে; নতুন দলের একটা instance পড়ল node B থেকে — সেখানে পুরনো মান, কেউ কখনো delete করেনি।

এটা exercise এ মাপা হয়নি, কিন্তু যুক্তিটা ১.৬ এর stale read এর হুবহু একই আকার — এবার কোনো node মরেনি, শুধু **দুটো সত্য একসাথে চলেছে**। আর consistent hashing এটা ছোট করে (ring এ শুধু ~২৫% key এর মালিক বদলায়, `hash % N` এ ~৭৫%), কিন্তু শূন্য করে না।

তাই যেকোনো consistent hashing system এর একটা অংশ algorithm না — **membership**: কোন node গুলো আছে, সেই তালিকা কোথা থেকে আসে, আর সবাই কখন নতুন তালিকায় যায়। বাস্তবে তিনটা ধারা:

- **একটা কেন্দ্রীয় উৎস** (9.4 এর registry, বা একটা config service) — তালিকার একটা version থাকে, আর সবাই একটা নির্দিষ্ট মুহূর্তে বদলায়; env var এ প্রতিটা instance এর নিজের copy না।
- **Gossip** — Cassandra এর মতো system এ node গুলো নিজেরা নিজেদের মধ্যে membership এর খবর ছড়ায়; client যেকোনো node কে জিজ্ঞেস করে।
- **Server নিজেই মালিকানার সত্য রাখে** — Redis Cluster এর পথ, আর এটা একটা আলাদা term চায়।

**Hash Slot** — key এর hash কে একটা নির্দিষ্ট, বড় সংখ্যক slot এ ভাগ করা (Redis Cluster এ `CRC16(key) % 16384`), আর **কোন slot কোন node এ**, সেই তালিকাটা আলাদাভাবে রাখা; node যোগ হলে কিছু slot, তাদের data সহ, নতুন node এ সরানো হয়।

এটা ring না — এটা 5.8 এ বলা "শুরু থেকেই অনেক logical shard" এর ধারণা। Key এর slot কখনো বদলায় না; বদলায় শুধু slot এর মালিক। আর দুটো জিনিস এটাকে client-side ring এর চেয়ে নিরাপদ করে: (১) slot সরানোর সময় Redis **data টাও সরায়** — তাই নতুন node খালি অবস্থায় আসে না, miss এর ঢেউ হয় না; (২) কোনো client পুরনো তালিকা ধরে ভুল node এ গেলে, সেই node নিজেই `MOVED` দিয়ে জানিয়ে দেয় সঠিক মালিক কে — সত্যটা server এ, client এর env var এ না। বিনিময়ে: একাধিক key এর command (যেমন `MGET`) শুধু একই slot এর key এ চলে, তাই যে key গুলো একসাথে লাগে তাদের hash tag দিয়ে একই slot এ রাখতে হয় (`{workspace:42}:board`, `{workspace:42}:members`)।

### ১.১০ TaskFlow এর সিদ্ধান্ত

**Cache এর দীর্ঘমেয়াদি পথ: Redis Cluster**, নিজের বানানো ring না। কারণ ১.৯ এর দুটো জিনিস — slot এর সাথে data সরে (নতুন node এ miss এর ঢেউ নেই), আর মালিকানার সত্য server এ (`MOVED`), rolling deploy এর দুই দলের সমস্যা নেই। Hash tag এর নিয়ম: একই workspace এর যে key গুলো একসাথে পড়া হয়, সেগুলো `{workspace:<id>}` দিয়ে।

**ততদিন, এই সপ্তাহে:** wrapper টা `hash % N` থেকে ১৬০ virtual node এর ring এ (একটা পরীক্ষিত library, ketama-সামঞ্জস্যপূর্ণ; নিজে লেখা না)। সাথে:

- **Node যোগ শুধু ধীরে, আর ব্যস্ত সময়ের বাইরে** — নতুন node weight ০.২৫ দিয়ে ঢুকবে, প্রতি ১৫ মিনিটে বাড়বে (১.৪); প্রতিটা ধাপে DB এর p99 দেখে পরেরটা। আর 4.6 এর single-flight প্রতিটা miss এর সামনে, যাতে একই key এর হাজারটা miss একটা query হয়।
- **Membership একটা জায়গা থেকে** — cache node এর তালিকা registry তে, version সহ; সব instance ১০ সেকেন্ডের মধ্যে একই version এ। Env var না।
- **বাদ দেওয়ায় দেরি, ফেরার আগে flush** — ৩০ সেকেন্ডে পরপর ৩টা ব্যর্থ check এর পরে ring থেকে বাদ; ফিরতে হলে আগে `FLUSHALL`, তারপর ছোট weight দিয়ে। আর প্রতিটা cache key এ TTL (৫ মিনিট) — stale থাকার একটা ছাদ, যে ভুলই হোক।
- **Hot key**: bounded load **না** (পেছনে cache, ১.৮)। গরম board গুলোর জন্য প্রতিটা app instance এ ২ সেকেন্ডের local cache।

**যা এখনো দরকার নেই:** replica আর zone-সচেতন preference list (১.৫) — cache এ copy একটা, আর হারালে DB আছে। কিন্তু 10.8 এ multi-region এ গেলে এই প্রশ্নটা পুরো ওজন নিয়ে ফিরবে।

**Dashboard এ তিনটা সংখ্যা:** প্রতিটা node এর hit rate (আলাদা করে — মোট hit rate একটা node এর সমস্যা লুকিয়ে ফেলে); সবচেয়ে ব্যস্ত node এর ops/s ÷ গড় (hot key বা খারাপ ভাগ এর প্রথম লক্ষণ); আর membership বদলের পরের ৬০ সেকেন্ডে DB এর query/s — প্রতিটা বদলের দাম, সংখ্যায়।

---

## ২. Interview Angle

**"একটা distributed cache (বা key-value store) design করুন"** — এখানে consistent hashing প্রায় নিশ্চিতভাবে আসবে, আর interviewer দেখে আপনি নামটার বাইরে কতদূর যান। কাঠামো: আগে **কেন `hash % N` না** (সংখ্যা দিয়ে: N থেকে N+1 এ ~N/(N+1) নড়ে; আর নড়া key এর বেশিরভাগ পুরনো node দের মধ্যেই ঘোরে), তারপর **ring** (ঘড়ির কাঁটার দিকে প্রথম node), তারপর **virtual node** (কেন — ভাগ আর ব্যর্থতায় ভার ছড়ানো; কত — দাম সহ), তারপর **replica** (preference list, আলাদা node আর আলাদা AZ), আর শেষে **membership** (কে ring টা জানে, আর বদল কীভাবে সবার কাছে পৌঁছায়)।

**প্রায় নিশ্চিত follow-up গুলো:**

- _"একটা node মরলে কী হয়?"_ — তার ভাগ কার কাছে যায় (virtual node ছাড়া একজনের কাছে, সহ সবার মধ্যে), cache এ miss এর ঢেউ, আর ফিরলে stale data এর ঝুঁকি।
- _"Hot key?"_ — hash key ভাগ করে, request না; তাই কোনো hash সারায় না। Stateless এর সামনে bounded load, cache এর সামনে local cache বা key ভাগ করা।
- _"Redis Cluster কি consistent hashing ব্যবহার করে?"_ — না, এটা একটা ভালো ফাঁদ প্রশ্ন। ১৬৩৮৪টা hash slot, আর slot থেকে node এর একটা তালিকা। নিজের ভাষায় দুটোর পার্থক্য বলতে পারা একটা senior লক্ষণ।
- _"Ring না rendezvous?"_ — ছোট cluster এ rendezvous (virtual node ছাড়াই সমান, replica বাছাই সহজ), বড় cluster এ ring (lookup O(log n))। আর jump hash শুধু যেখানে bucket নিজে মরে না।

**Production এ বাস্তবে:** সবচেয়ে পরিচিত ঘটনাগুলো — `hash % N` দিয়ে cache ভাগ করে node যোগের দিন database ফেলে দেওয়া (এই lesson এর গল্প); virtual node ছাড়া ring, যেখানে একটা node এর মৃত্যু প্রতিবেশীকে ডুবিয়ে cascade শুরু করে; replica বাছাইয়ে একই machine এর দুটো virtual node, যা কেউ টের পায় না যতক্ষণ না একটা machine মরে আর quorum হারায়; flapping node পুরনো data নিয়ে ring এ ফিরে আসা; আর client গুলোর মধ্যে node তালিকার অমিল — বিশেষ করে rolling deploy এর সময়, বা যখন দুটো আলাদা language এর client দুটো আলাদা hash function ব্যবহার করে একই cluster পড়ে।

---

## ৩. Key Takeaway

- `hash % N` এ N থেকে N+1 এ **~N/(N+1) key নড়ে** — মাপা: ৪→৫ এ ৭৯.৯%; আর নড়া key এর **৭৪.৮% পুরনো node দের মধ্যেই** ঘোরে, যা নিছক অপচয়
- **Consistent hashing** = node যোগ-বাদে শুধু ~১/N নড়ে, আর শুধু সেই node এর সাথে — মাপা: ২০.১%, আর নড়া key এর ১০০% নতুন node এ
- **Virtual node ছাড়া ring প্রায় অর্থহীন** — ১টা বিন্দুতে সবচেয়ে ভারী node ৩.০৬x, আর মরা node এর **সব** key একজন প্রতিবেশীর ঘাড়ে; ১৬০ এ ১.১৩x, আর ভার সবার মধ্যে ছড়ায়
- Virtual node এর উন্নতি কমতে কমতে আসে (বর্গমূলের বিপরীতে), lookup এর দাম লগারিদমিক, কিন্তু ring এর আকার আর বিতরণের দাম সরাসরি; weight দিয়ে ভিন্ন আকারের machine আর ধীরে ধীরে node ঢোকানো
- **Replica বাছাইয়ে "পরের ৩টা বিন্দু" একটা ফাঁদ** — মাপা: ৪৫.৩% key এর দুটো copy একই machine এ; আলাদা node আর আলাদা AZ দুটোই নিয়মে বসাতে হয়
- Node যোগের আসল দাম "কত % নড়ল" না, **পরের কয়েক সেকেন্ডে DB কত চাপ খায়** — মাপা: প্রথম সেকেন্ডে ২,১৬২ বনাম ৭৩৭; আর skewed traffic ক্ষতিটা কম **দেখায়**, কম করে না
- **Consistent hashing consistency দেয় না** — পুরনো data নিয়ে ফেরা node এ ১০ সেকেন্ডে ৬,৪২৯টা stale read; প্রতিকার: ফেরার আগে flush, সব key এ TTL, বাদ দেওয়ায় দেরি
- **Rendezvous** ছোট cluster এ ring এর চেয়ে ভালো (১.০২x, কোনো ring নেই, দাম N hash/lookup); **jump hash** মাঝের node বাদে ৪৮.৫% নাড়ায় — শুধু যেখানে bucket নিজে মরে না
- **Hot key কোনো hash সারায় না** — ring এ সবচেয়ে ব্যস্ত node ~২x; bounded load ১.২৫x এ বাঁধে কিন্তু ১১.৩% request নিজের node এর বাইরে — stateless এর সামনে ভালো, cache এর সামনে miss
- সবাই একই ring দেখছে কিনা — **membership** — algorithm এর অংশ না, কিন্তু system এর অংশ; Redis Cluster ring না, hash slot + server-এ-রাখা মালিকানা (`MOVED`)

---

## ৪. নতুন Term (Glossary)

| Term                                | অর্থ                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hash Ring**                       | Hash এর পুরো মানের পরিসরকে একটা বৃত্ত ধরে node গুলোকে তাদের hash এর বিন্দুতে বসানো; একটা key এর মালিক তার বিন্দু থেকে ঘড়ির কাঁটার দিকে প্রথম node — তাই node যোগ-বাদে শুধু পাশের বৃত্তচাপ বদলায় |
| **Virtual Node (vnode)**            | একটা physical node কে বৃত্তের অনেকগুলো বিন্দুতে বসানো, যাতে তার ভাগ অনেক ছোট বৃত্তচাপের যোগফল হয় — ভাগ সমান হয়, আর node মরলে তার ভার সবার মধ্যে ছড়ায়; weight = virtual node এর সংখ্যা         |
| **Preference List**                 | একটা key এর copy গুলো যে node গুলোতে থাকবে তাদের ক্রমিক তালিকা — ring এ হেঁটে বাছাই; একই physical node আর একই AZ এড়িয়ে যাওয়া নিয়মে বসাতে হয়                                                  |
| **Rendezvous Hashing (HRW)**        | প্রতিটা node এর জন্য `hash(node + key)` score, সবচেয়ে বেশি score এর node মালিক; virtual node ছাড়াই সমান ভাগ, কোনো ring নেই — দাম প্রতি lookup এ N টা hash                                       |
| **Jump Consistent Hash**            | Key আর bucket সংখ্যা থেকে সরাসরি bucket নম্বর, কোনো memory ছাড়া, ~ln(n) ধাপে; নিখুঁত ভাগ, কিন্তু যোগ-বাদ শুধু শেষ থেকে — মাঝের bucket বাদ দিলে প্রায় অর্ধেক key নড়ে                            |
| **Bounded-Load Consistent Hashing** | Consistent hashing এর উপর একটা সীমা — কোনো node ন্যায্য ভাগের `c` গুণের বেশি নেবে না, ভরা থাকলে পরের node; hot key এর চাপ বাঁধে, বিনিময়ে কিছু request নিজের node এর বাইরে যায়                   |
| **Hash Slot**                       | Key এর hash কে নির্দিষ্ট বড় সংখ্যক slot এ ভাগ করা (Redis Cluster এ ১৬৩৮৪), আর slot থেকে node এর তালিকা আলাদা রাখা; key এর slot কখনো বদলায় না, বদলায় শুধু slot এর মালিক — data সহ               |

---

## ৫. Reflection Questions

উত্তর দেখার আগে নিজে ভাবুন — প্রতিটার জন্য অন্তত দুই-তিন লাইন নিজের ভাষায় লিখে ফেলুন।

1. TaskFlow এর (Redis Cluster এর আগের) cache এখন ৬টা node এ, আর দুটো node একসাথে যোগ করে ৮টা করা হবে। (ক) `hash % N` এ কত % key নড়বে? ভাগশেষ দিয়ে হিসাব করে দেখান। (খ) Ring এ (virtual node সহ) কত %? আর দুটো node একসাথে যোগ করা বনাম একটা একটা করে ১৫ মিনিট ব্যবধানে — মোট নড়া কি বদলায়? কোনটা database এর জন্য ভালো, আর কেন? (গ) এই lesson এর exercise এ ৩→৪ এ ring এর প্রথম সেকেন্ডে ৭৩৭টা DB query। আপনার ৬→৮ এর জন্য প্রথম সেকেন্ডে মোটামুটি কত আশা করবেন (একবারে দুটো যোগ করলে), আর কী কী অনুমান আপনার হিসাবে ঢুকছে?

2. একজন teammate একটা ছোট key-value store বানিয়েছে: ৬টা node, ৩টা AZ (প্রতিটায় ২টা), ring এ ১৬০ virtual node, প্রতিটা key এর ৩টা copy — "ring এ পরের ৩টা বিন্দু" নিয়মে। Read আর write দুটোই quorum এ (R = W = 2, 5.9)। (ক) Exercise এর সংখ্যা দিয়ে বলুন, একটা **machine** মরলে কী ধরনের key সমস্যায় পড়বে, আর একটা **AZ** গেলে কী ধরনের। (খ) শুধু "আলাদা node" নিয়মে বদলালে কোন সমস্যা যায়, কোনটা থাকে? (গ) "আলাদা AZ" নিয়মে বদলানোর পরে একটা AZ থেকে একটা machine অবসরে গেল, নতুনটা আসতে দুই সপ্তাহ — AZ গুলো এখন ২, ২, ১ টা node। ওই একলা node এর ভাগে কী হয়, আর কেন?

3. সোমবারের ঘটনার পরে TaskFlow ring এ গেছে, কিন্তু node তালিকা এখনো `CACHE_NODES` env var এ, আর deploy rolling (ছয়টা instance, দশ মিনিট)। Write এর পথ cache-aside: DB update, তারপর cache key `DEL` (4.2)। (ক) Node ৪ থেকে ৫ করার rolling deploy এর দশ মিনিটে ঠিক কোন ক্রমে ঘটনা ঘটলে একজন user পুরনো board দেখবে? ধাপে ধাপে লিখুন, কোন instance কোন node ধরে। (খ) Deploy শেষ হওয়ার পরেও কি সমস্যা থেকে যেতে পারে — কোন অবস্থায়? (গ) তিনটা আলাদা প্রতিকার বলুন — একটা membership এর, একটা write এর পথের, একটা cache এর নিজের — আর প্রতিটার দাম।

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:**

(ক) একটা key জায়গায় থাকে যদি `h % 6 == h % 8`। দুটোর ল.সা.গু. ২৪, তাই `h % 24` এর ২৪টা মান দেখলেই হয়: কোন `r` এর জন্য `r % 6 == r % 8`? `r = 0…5` — এখানে দুটোই `r` নিজে। `r = 6…23` এ আর কোনোটা মেলে না (যেমন ৬: `0` বনাম `6`; ১২: `0` বনাম `4`; ১৮: `0` বনাম `2`)। তাই ২৪ এর মধ্যে ৬টা থাকে — **২৫% থাকে, ৭৫% নড়ে**। (৩→৪ এর মতোই ৭৫% — কাকতালীয়, কিন্তু মনে রাখার মতো: দুটো node একসাথে যোগ করলে `hash % N` এ ক্ষতি কমে না।)

(খ) Ring এ আদর্শভাবে নতুন দুটো node এর ভাগ — **২/৮ = ২৫%**। একটা একটা করে: প্রথম ধাপে ~১/৭ (~১৪.৩%) নড়ে, দ্বিতীয় ধাপে ~১/৮ (১২.৫%)। যোগফল ~২৬.৮%, ২৫% এর একটু বেশি — কারণ প্রথম ধাপে নতুন node ৭ এ যাওয়া কিছু key দ্বিতীয় ধাপে node ৮ এ আবার নড়ে (মোটামুটি ১/৭ × ১/৮ ≈ ১.৮%)। অর্থাৎ মোট কাজ প্রায় একই, সামান্য বেশি। কিন্তু **database এর জন্য একটা একটা করে ভালো**: miss এর ঢেউটা দুটো ছোট ঢেউ, মাঝে ১৫ মিনিট — প্রথমটার পরে cache আবার গরম হয়ে যায়, আর আপনি প্রথম ঢেউয়ের DB p99 দেখে সিদ্ধান্ত নিতে পারেন দ্বিতীয়টা করবেন কিনা। Database কে যা মারে সেটা মোট miss না, **শীর্ষ** miss/s — 9.5 এর "কত না, কত একসাথে" এর একই যুক্তি। (আর weight দিয়ে ধীরে ঢোকানো, ১.৪, এটাকে আরও ছোট ঢেউয়ে ভাঙে।)

(গ) একটা মোটা অনুমান: ৩→৪ এ ring এ ~২৫% key নড়েছিল আর প্রথম সেকেন্ডে ৭৩৭ query। ৬→৮ এ একসাথে ~২৫% নড়বে — একই ভগ্নাংশ। তাই traffic আর key সংখ্যা একই থাকলে প্রথম সেকেন্ডেও মোটামুটি একই মাপের, **~৭০০–৮০০**। কিন্তু অনুমানগুলো সৎভাবে লিখুন: (১) traffic ৫,০০০ read/s আর একই Zipf আকার — ৮টা node লাগছে মানে traffic সম্ভবত বেড়েছে, তাহলে সংখ্যাটা অনুপাতে বাড়বে; (২) cache আগে থেকে পুরো গরম; (৩) single-flight নেই — থাকলে একই key এর অনেক miss একটা query হয়, সংখ্যাটা অনেক কমে; (৪) Zipf এর exponent — ১.৬ এ দেখেছেন, এটা প্রথম সেকেন্ডের সংখ্যা কয়েক গুণ বদলাতে পারে। সবচেয়ে ভালো উত্তর: `KEYS`, `RPS` আর `ZIPF` নিজের production এর সংখ্যায় বসিয়ে exercise টা চালান — অনুমানের চেয়ে একটা simulation ভালো, আর production এ একটা ধাপ (একটা node, ছোট weight) তার চেয়েও ভালো।

**প্রশ্ন ২:**

(ক) "পরের ৩টা বিন্দু" নিয়মে exercise এর সংখ্যা:

- **Machine মরলে:** ৪৫.৩% key এর অন্তত দুটো copy একই machine এ। ওই machine টা মরলে এমন key এর জন্য বাকি থাকে ১টা (বা ০টা) copy — R = W = 2 এর quorum আর হয় না, অর্থাৎ ওই key গুলো পড়া-লেখা দুটোই বন্ধ (যতক্ষণ না data অন্য node এ তৈরি হয়)। একটা machine মরা সবচেয়ে সাধারণ ব্যর্থতা, আর "RF 3, একটা machine এর মৃত্যু সহ্য করে" দাবিটা প্রায় অর্ধেক data এর জন্য মিথ্যা।
- **AZ গেলে:** ৭৬.৮% key এর অন্তত দুটো copy একই AZ এ, আর ১১.২% এর তিনটাই একটায়। ৩টা AZ, তাই মোটামুটি এক-তৃতীয়াংশ ক্ষেত্রে ওই "দ্বিগুণ" AZ টাই হবে যেটা গেছে — অর্থাৎ মোটা দাগে ~২৫% key quorum হারাবে, আর তার মধ্যে কিছু key এর সব copy ই চলে যাবে। (এই শেষ হিসাবটা exercise এর সংখ্যা থেকে একটা মোটা অনুমান, মাপা না — "কোন AZ গেল" ধরে মাপতে `vnodes.ts` এ একটা কলাম যোগ করতে হবে।)

(খ) "আলাদা node" নিয়মে: machine এর সমস্যা **পুরো** যায় (০%), আর "এক AZ এ সব copy" ও যায় (০% — ৬টা node, প্রতি AZ এ ২টা, তাই তিনটা আলাদা node কখনো একটা AZ এ আঁটে না)। কিন্তু **৫৯.১% key এর দুটো copy এখনো এক AZ এ** — AZ গেলে এগুলোর quorum থাকে না। অর্থাৎ machine এর ব্যর্থতা থেকে রক্ষা পেলে, AZ এর থেকে না। 6.1 এর কথাটা: ব্যর্থতা একসাথে আসে, আর failure domain (machine, rack, AZ, region) এর প্রতিটা স্তরে আলাদা করে নিয়ম বসাতে হয়।

(গ) "আলাদা AZ" নিয়মে প্রতিটা key এর একটা copy প্রতিটা AZ এ। AZ গুলো ২, ২, ১ হলে, তৃতীয় AZ এর **একলা node টাকে সব key এর একটা copy রাখতে হবে** — পুরো data এর এক-তৃতীয়াংশ (৩টা copy এর একটা), যেখানে বাকি চারজনের প্রত্যেকে ~১/৬। মানে তার disk আর চাপ বাকিদের **দ্বিগুণ**। দুই সপ্তাহ ধরে সে সবচেয়ে ভারী node, আর সে মরলে পুরো একটা AZ এর copy শেষ — ঠিক সেই দুই সপ্তাহে যখন system সবচেয়ে ভঙ্গুর। তিনটা বিকল্প, কোনোটাই বিনামূল্যে না: (১) দুই সপ্তাহের জন্য নিয়মটা শিথিল করা (সেই AZ এ copy কম — নিরাপত্তা কমে); (২) অন্য দুটো AZ থেকে একটা করে node সরিয়ে ১, ১, ১ করা (capacity কমে); (৩) তাড়াতাড়ি একটা সাময়িক machine আনা। এজন্যই rack-সচেতন system চালানোর একটা operational নিয়ম: **failure domain গুলোর আকার সমান রাখুন** — এটা algorithm এর অংশ না, কিন্তু algorithm এর নিরাপত্তা এর উপর দাঁড়িয়ে।

**প্রশ্ন ৩:**

(ক) ধাপে ধাপে, একটা key `board:42` নিয়ে যার মালিক ৪ node এ `cache-2`, ৫ node এ `cache-5` (ring এ ~২০% key এর জন্য এমন হয়):

1. Rolling deploy শুরু। Instance ১–৩ নতুন তালিকায় (৫টা node), ৪–৬ এখনো পুরনোয় (৪টা)।
2. একজন user board খুলল, request গেল instance ১ এ (নতুন)। `cache-5` এ `board:42` নেই — miss, DB থেকে পড়ে `cache-5` এ রাখল। এখন `cache-2` আর `cache-5` দুজনের কাছেই একই (এখনো সঠিক) মান।
3. আরেকজন user একটা task Done এ সরাল, request গেল instance ৫ এ (পুরনো)। DB update, তারপর `DEL board:42` — **`cache-2` থেকে**।
4. প্রথম user refresh করল, request আবার নতুন instance এ — `cache-5` থেকে পুরনো মান। **Stale**, আর `cache-5` এর ওই key কেউ কখনো delete করবে না যতক্ষণ না আরেকটা write নতুন instance দিয়ে আসে।

উল্টো দিকও একই রকম: নতুন instance `cache-5` থেকে delete করল, পুরনো instance `cache-2` থেকে পুরনো মান পড়ল। অর্থাৎ দশ মিনিট ধরে write এর invalidation আর read দুটো আলাদা সত্য অনুসরণ করছে।

(খ) হ্যাঁ। Deploy শেষে সবাই নতুন তালিকায়, তাই `board:42` এখন শুধু `cache-5` থেকে পড়া হয় — আর ধাপ ৪ এর stale মানটা ঠিক সেখানেই আছে। TTL না থাকলে সেটা পরের write পর্যন্ত থাকে, হয়তো দিনের পর দিন। আর আরেকটা লুকানো অবস্থা: `cache-2` তে ওই key এর পুরনো copy গুলো পড়ে থাকে (এখন আর কেউ পড়ে না, তাই ক্ষতিহীন) — কিন্তু পরে কখনো `cache-5` বাদ গেলে (বা node তালিকা আবার বদলালে) ওই key গুলো `cache-2` তে ফেরত যেতে পারে, আর তখন সেই পুরনো মান আবার জীবিত হয় — ১.৬ এর flapping এর হুবহু আকার।

(গ) তিন স্তরে:

- **Membership:** node তালিকা একটা জায়গা থেকে (registry / config service), version সহ, আর সবাই একই মুহূর্তে বদলায় — rolling deploy এর সাথে জড়ানো না। আরও ভালো: Redis Cluster, যেখানে সত্যটা server এ আর ভুল node `MOVED` দেয় (১.৯)। দাম: একটা নতুন নির্ভরতা (registry মরলে কী? — শেষ জানা version ধরে চলা), বা Redis Cluster এ migration এর কাজ আর multi-key command এর সীমা।
- **Write এর পথ:** তালিকা বদলের সময়টায় invalidation **দুই মালিকের কাছেই** পাঠানো — পুরনো ring আর নতুন ring দুটো ধরে `DEL`। দাম: বদলের সময় প্রতিটা write এ একটা বাড়তি call, আর code এ "দুটো ring জানেন" এর জটিলতা; আর ভুলে গেলে (একটা পুরনো code path) সুরক্ষাটা নিঃশব্দে উঠে যায়।
- **Cache নিজে:** প্রতিটা key এ TTL — যত bug ই থাকুক, stale এর একটা ছাদ (যেমন ৫ মিনিট)। দাম: TTL যত ছোট, miss তত বেশি; আর TTL "ঠিক" করে না, শুধু ক্ষতির সময় বাঁধে। এজন্যই এটা শেষ স্তর, একমাত্র না।

</details>

---

## ৬. Practical Exercise

**Tier 1 — Runnable Code** (deterministic simulation; Docker লাগে না)

> **Repo তে চালানোর মতো অবস্থায় আছে:** [`exercises/lesson-10.1-consistent-hashing/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-10.1-consistent-hashing) — `npm install`, তারপর `npm run rebalance`, `npm run vnodes`, `npm run cache`, `npm run compare`। পুরো setup, acceptance criteria আর experiment ওখানকার `README.md` এ আছে।

একটা hash ring (virtual node, weight, আর replica বাছাইয়ের তিনটা নিয়ম), আর তার পাশে `hash % N`, rendezvous hashing আর jump hash — সবাই একই `Router` interface এ। `rebalance` node যোগ আর বাদে কত key নড়ে, কোথায় যায়, আর মরা node এর ভার কে নেয় সেটা গোনে। `vnodes` virtual node এর সংখ্যা বনাম ভাগের সমতা, weight, আর ৬টা node / ৩টা AZ এ replica এর তিন নিয়ম পাশাপাশি দেখায়। `cache` TaskFlow এর গল্পটা চালায় — গরম cache এ ৩ থেকে ৪ node, প্রথম সেকেন্ডে DB তে কত query; তারপর একটা node ৩০ সেকেন্ড বাইরে থেকে পুরনো data নিয়ে ফিরলে কত stale read। `compare` তিনটা পদ্ধতি পাশাপাশি রাখে, আর শেষে Zipf traffic এ hot key আর bounded load।

**সৎ নোট:** Sandbox এ Node 26 এ চালিয়ে যাচাই করা হয়েছে: `tsc --noEmit` আর ESLint clean; চারটা script **তিনবার করে**, প্রতিবার output হুবহু এক (byte ধরে মেলানো)। এখানে **কোনো আসল Redis বা network নেই** — cache node গুলো একই process এর `Map`, "request" একটা function call; তাই কোথাও সময় মাপা হয়নি, সব সংখ্যা **গোনা** (কত key নড়ল, কত hit, কত miss, কত stale)। "প্রথম ১ সেকেন্ড" মানে প্রথম ৫,০০০টা request (`RPS=5000` ধরে), ঘড়ির সময় না। Cache এ কোনো memory সীমা, TTL বা eviction নেই, আর বদলের আগে সব key গরম ধরা — তাই প্রতিটা miss এর কারণ শুধু routing বদল; আসল cache এ আগে থেকেই কিছু miss থাকে। Bounded load একটা সরল রূপ (১,০০০ request এর একেকটা batch কে "একসাথে চলছে" ধরা), আসল implementation চলমান connection গোনে। Jump hash `BigInt` দিয়ে লেখা, তাই তার গতি এখানে অর্থহীন — শুধু ধাপ গোনা। **যা মাপা হয়নি:** আসল network এ lookup এর latency; data সরানোর সময় (streaming, দুই জায়গায় লেখা); rolling deploy এ দুটো node তালিকা একসাথে চলা (১.৯ আর প্রশ্ন ৩ — যুক্তি, চালানো না); Maglev; আর AZ ধরে quorum হারানোর হিসাব (প্রশ্ন ২ এর "~২৫%" একটা অনুমান)। ১.৩ এর ketama আর Cassandra এর সংখ্যা, আর ১.৮ এর Vimeo/HAProxy এর কথা তাদের প্রকাশিত লেখা আর documentation থেকে — এখানে যাচাই করা না, আর Cassandra এর default version ভেদে আলাদা। ১.১০ এর TaskFlow এর সিদ্ধান্ত একটা নকশা, চালানো না।

**সেটআপ যাচাই হলে, এই পাঁচটা করুন:**

1. **আগে অনুমান:** `rebalance` চালানোর **আগে** লিখে ফেলুন — ৪ থেকে ৫ node এ `hash % N` এ কত % নড়বে, আর নড়া key এর কত % নতুন node এ যাবে? তারপর virtual node ছাড়া ring এ। দুটো মিলিয়ে দেখুন, আর "পুরনোদের মধ্যে" কলামটা কেন আপনার অনুমানে ছিল না (বা ছিল), এক লাইনে লিখুন।

2. **Virtual node এর দাম-হিসাব:** `VNODES=10 npm run rebalance`, তারপর `VNODES=1000`, আর `vnodes` এর টেবিল পাশে রাখুন। আপনার ১০টা node এর cache এ কত virtual node বাছবেন? সিদ্ধান্তে তিনটা জিনিস রাখুন — সবচেয়ে ভারী node কত x পর্যন্ত সহ্য করবে, node মরলে ভার কতজনে ছড়াবে, আর ring টা কতগুলো client কে কত ঘন ঘন পাঠাতে হবে।

3. **Traffic এর আকারের ফাঁদ:** `ZIPF=0.5 npm run cache`, তারপর `ZIPF=1.2`. প্রথম সেকেন্ডের hit rate আর DB query কীভাবে বদলায়? এবার ভাবুন: TaskFlow এর staging এ ২০ জন tester অল্প কয়েকটা workspace বারবার খোলে। Staging এ node যোগের পরীক্ষা কী দেখাবে, আর কেন সেটা production এর জন্য ভুল আশ্বাস?

4. **Bounded load এর বিনিময়:** `FACTOR=1.1 npm run compare`, তারপর `FACTOR=2`. "ভারী" আর "নিজের node এর বাইরে" দুটো কলাম লিখে রাখুন। এবার দুটো আলাদা পেছন ধরে বলুন কোন factor বাছবেন: (ক) TaskFlow এর WebSocket server গুলো (2.4) যেখানে workspace ধরে connection পাঠানো হয় শুধু locality এর জন্য, (খ) TaskFlow এর cache।

5. **Design অংশ:** TaskFlow এর cache কে Redis Cluster এ নেওয়ার এক পাতার plan: (ক) কোন key গুলো একসাথে পড়া হয়, আর তাদের hash tag কী হবে — আর একটা workspace এর সব key এক slot এ রাখলে কোন নতুন সমস্যা আসে (১.৮ মনে রাখুন); (খ) migration এর সময় পুরনো ring আর নতুন cluster দুটো একসাথে — read কোথা থেকে, invalidation কোথায়; (গ) node যোগের runbook — কখন, কত ধাপে, কোন সংখ্যা দেখে পরের ধাপ; (ঘ) একটা node নাগালের বাইরে গেলে আর ফিরলে কী হবে (Redis Cluster এ replica আর failover ধরে); (ঙ) dashboard এর তিনটা সংখ্যা, আর প্রতিটার alert এর মান।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1, 2, 3, 4, 5, 6, 7, 8, 9 (সম্পূর্ণ, exit challenge সহ)
Current: 10.1 — Consistent Hashing deep dive
TaskFlow state: modular monolith (work, identity, files, search) + files processing + billing service;
gateway + web/mobile BFF (9.2); "task তৈরি" = orchestrated saga (9.3); breaker + bulkhead (9.4);
rate limit দুই স্তরে, limiter এর আলাদা Redis (9.5); cache ভাগ করা হয়েছিল `hash % N` দিয়ে ৩টা Redis
এ — ৪র্থ node যোগের দিন প্রথম সেকেন্ডে ~2,000+ বাড়তি DB query, site প্রায় অচল; এখন ১৬০ virtual
node এর ring (পরীক্ষিত library), node যোগ শুধু ধীরে (weight 0.25 থেকে, ১৫ মিনিট ধাপে) আর ব্যস্ত
সময়ের বাইরে, প্রতিটা miss এর সামনে single-flight; node তালিকা registry থেকে, version সহ (env var না);
ring থেকে বাদ ৩০ s এ ৩টা ব্যর্থ check এর পরে, ফেরার আগে FLUSHALL; সব cache key এ TTL 5 মিনিট;
hot board এর জন্য app এ ২ s local cache (bounded load না — পেছনে cache); দীর্ঘমেয়াদে Redis Cluster
(hash slot, data সহ slot সরানো, MOVED), hash tag {workspace:<id>}; dashboard: per-node hit rate,
সবচেয়ে ব্যস্ত node ÷ গড়, membership বদলের পরের 60 s এ DB query/s
Terms learned (Module 10): Hash Ring, Virtual Node, Preference List, Rendezvous Hashing (HRW), Jump
Consistent Hash, Bounded-Load Consistent Hashing, Hash Slot
Weak spots: [আপনি যেখানে আটকেছিলেন — নিজে লিখুন]
Next: 10.2 — Bloom Filter, HyperLogLog (probabilistic data structures)
=======================
```

---

## ৮. পরের Lesson

আজকের lesson এর সুতোটা ছিল: **একটা নিরীহ দেখতে সিদ্ধান্ত — "key কোন node এ যাবে" — system এর সবচেয়ে খারাপ মুহূর্তগুলো ঠিক করে দেয়।** Node যোগের দিন, node মরার দিন, node ফেরার দিন, আর deploy এর দশ মিনিট। Consistent hashing এগুলোর প্রথম দুটোর দাম কমায়; বাকিগুলোর জন্য membership, flush, TTL আর ধৈর্য লাগে। আর একটা শিক্ষা যেটা 9.5 থেকে চলে আসছে: একটা algorithm কে "কত % নড়ল" এর মতো একটা সুন্দর সংখ্যা দিয়ে বিচার করবেন না — প্রশ্ন সবসময়, **পেছনের system টা ওই মুহূর্তে কী অনুভব করে**।

রেডি হলে `next` লিখুন — **Lesson 10.2: Bloom Filter আর HyperLogLog** এ যাব। আজ আমরা hash দিয়ে ঠিক করেছি data **কোথায়** থাকবে; কাল hash দিয়ে এমন প্রশ্নের উত্তর দেব যেখানে data টা রাখাই সম্ভব না — "এই username কি আগে নেওয়া হয়েছে?" কোটি কোটি নামের মধ্যে, কয়েক MB memory তে; আর "আজ কতজন আলাদা user board খুলেছে?" প্রত্যেককে মনে না রেখে। দুটোরই দাম একটা ছোট, মাপা যায় এমন ভুলের সম্ভাবনা — আর সেই ভুলটা কোন দিকে হয়, সেটাই পুরো design।
