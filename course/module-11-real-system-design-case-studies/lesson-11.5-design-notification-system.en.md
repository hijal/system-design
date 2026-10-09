# Lesson 11.5 - Case Study: Design a Notification System

**Module 11 - Real System Design Case Studies**

> **Spaced Repetition (Lesson 2.5):** A client sent a payment request, got a timeout, and sent it again. How does the server make sure the money was not taken twice? And does the client that got the timeout know whether the first request worked? Today the roles are reversed: **we** are the client, and the email or SMS provider is the server. We will measure how many emails go out twice when we resend after a timeout.

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 7.2 (Queue), Lesson 7.4 (Retry, backoff, DLQ), Lesson 9.4 (Circuit breaker, bulkhead), Lesson 9.5 (Rate limiting), Lesson 10.7 (Cost), Lesson 11.2 (Limiter), Lesson 11.3 (Push, offline), Lesson 11.4 (Fan-out, queue isolation)

**By the end of this lesson you will be able to:**

1. Recognise a notification system's real limits: the cost comes from the channel (SMS), the speed limit comes from the external providers, and the scarcest resource is the user's attention. And build a design from them: priority tiers, channel plans, preferences and quiet hours
2. Talk to external providers reliably: a timeout does not mean failure, retries and idempotency keys, why failover loses the key, backoff vs a breaker in an outage, and pacing a campaign below the provider's limit
3. Send notifications without annoying the user: aggregation and collapse keys, the price of a cap, quiet hours and their morning wave, and keeping dead device tokens cleaned out

**Tier:** 1 - Runnable Code (four deterministic models and a real Express + Zod notification service, with a fake provider; no Docker needed)

---

## 0. Today's System

In the previous four case studies I kept setting a box aside: "notifications (11.5)". Waking an offline user in 11.3, news of a new post in 11.4, the password reset email in 10.5. Today we open that box. The interviewer:

> "Design a central system for all of our company's notifications. A few hundred services will call it: login OTPs, order updates, social likes and comments, and the marketing team's campaigns. Push, email, SMS."

The first picture is almost always a queue and a worker: "services put messages on the queue, a worker sends them." That's right, and this is where the questions begin:

- "The marketing team sent a campaign to 100 million people. If someone logs in during that hour, when will their OTP arrive?"
- "The SMS provider takes no more than 100 a second. Whose problem is that?"
- "The email provider timed out. Will you send again? What if the first one actually went out?"
- "Someone's post went viral, 500 likes in 10 minutes. Will their phone ring 500 times?"
- "The month's bill arrived. Where did all that money go?"

This system's real character: it does almost nothing itself; it gets a few external providers (APNs, FCM, the email and SMS services) to do the work. Their speed, prices and failures are not in our hands. So the design is mostly **our own rules around someone else's limits**.

---

## 1. Theory

### 1.1 Step 1 - Requirements

```
Question                                   Assumed
Who sends?                                 a few hundred internal services, through one API: { userId, type, data, idempotencyKey }
What kinds?                                OTP and security (urgent), orders and social (normal), marketing (bulk)
Which channels?                            push (iOS/Android), email, SMS, in-app
User control?                              turning off by type (not marketing), night-time quiet, unsubscribe
How fast?                                  OTP in seconds (5-minute expiry), social seconds to minutes is fine, marketing within hours
Guarantees?                                nothing lost (OTP, orders), as few duplicates as possible
Left out                                   the template editor, A/B tests, the campaign UI
```

Two **non-functional** things that are rarer in other systems: **the user's attention is a resource** (too many notifications and the user turns notifications off, and then even the urgent one doesn't get through), and **legal obligations** (an unsubscribe link in marketing and honouring it, time limits on SMS in some countries; which applies where is a question for a lawyer, not verified here).

### 1.2 Step 2 - Estimation: where the cost is

`npm run estimate`:

```
── Part A - load: 300 million DAU, 10 notifications a day per user ──
all notifications                                     34,722         104,167
one campaign: 100 million people, in 1 h              27,778    0.8× the average

── Part B - channels and monthly cost (approximate prices) ──
channel              share         per day        each       monthly  share of cost
push (APNs/FCM)        80%     2.4 billion          $0            $0           0.0%
email                  17%     510 million     $0.0001    $1,530,000          17.5%
SMS                     1%      30 million      $0.008    $7,200,000          82.5%
in-app                  2%      60 million          $0            $0           0.0%

── Part C - device tokens: 900 million tokens, 30% dead ──
sending to every token of every user is 7.2 billion pushes a day, 2.16 billion of them to dead tokens

── Part D - the history of every notification (500 B, 90 days) ──
1.5 TB a day, 135 TB over 90 days
```

1. **The load is moderate, but the waves are big.** 35,000 a second on average, 100,000 at peak. One campaign adds almost another 28,000/s for an hour, suddenly. Like 11.4's celebrity, but this time we make it ourselves.
2. **The cost is not in volume but in the channel.** SMS is only 1% of notifications but **82%** of the monthly bill. Push has no price of its own (sending to APNs and FCM is free), and email is almost free. In the language of 10.7's unit economics: the biggest saving is one rule, "SMS only as a fallback": an OTP goes by push first (inside the app), and only by SMS if push doesn't get through. SMS prices vary a lot by country, so which countries' users are being sent SMS is a cost metric too.
3. **Dead tokens are a hidden waste.** A user has three tokens on average (an old phone, a tablet, a reinstalled app), 30% of which are dead (app deleted, phone changed). 2.16 billion pushes a day go nowhere. The price is not in money (push is free), but in workers' time, the provider's throughput limit, and a false "delivered" count.
4. **History has to be kept.** For answering "I didn't get the OTP" tickets ("handed to the SMS provider at 12:03:05, the provider says it was delivered") and for dedupe. 135 TB over 90 days, so the recent part in a fast store and the old part in cheap storage (10.7's tiering).

### 1.3 Step 3 - High-level design

```
 services ──► POST /notify { userId, type, data, idempotencyKey }
                       │
                 [notification API] ── dedupe (userId + key) ──► 202
                       │
                 [preferences + rules] ── opt-out? quiet hours? daily limit? aggregation window?
                       │
         ┌─────────────┼───────────────┐
   [critical queue] [normal queue] [bulk queue]          ← priority tiers
         │             │               │
   [channel worker: push]  [email]  [SMS]                ← per channel, within the provider's limit
         │             │               │
   APNs / FCM     email provider ×2   SMS provider ×2     ← primary + backup
         │
   result (sent / unregistered / failed) ──► history, token removal, metrics
```

Three core ideas, each with a new term:

**Priority Tier (Transactional vs Bulk)** - splitting notifications into separate tiers by urgency (OTP and security; orders and social; marketing), each with its own queue, workers and share of the provider, so one tier's wave doesn't hold up another. The tier is decided by the system from the type, not by the calling service (otherwise everyone calls themselves "urgent").

**Channel Plan:** an order of channels for each type. OTP: push, else SMS. Social: push only (and in-app). Orders: email (a receipt, findable later). Marketing: email. This is config, not code.

**Preferences and rules are checked just before sending,** not when the request is accepted. The reason: while a notification sits in the queue, the user may turn marketing off, or quiet hours may begin.

### 1.4 Deep dive 1 - The provider's limit: campaign vs OTP

**Provider Throughput Limit** - the limit on how many per second an external provider will take from one account (for SMS often a few hundred a second, depending on the kind of sender and the country), above which it rejects (429) or silently delays. It is not our decision, but our design is built around it.

`npm run queue`: the SMS provider's limit is 100/s, OTPs arrive at 20/s, and at the one-minute mark a campaign of 300,000 marketing SMS enters the queue. OTPs expire after 5 minutes:

```
policy                                                       OTP p50   OTP p99        worst    expired  campaign done
one FIFO queue, one provider account                        120.00 s  2942.40 s    3000.00 s     67,500        50 min
FIFO, but the campaign enters slowly (50% of the limit)       100 ms    100 ms       100 ms          0       100 min
priority: OTP first, the campaign gets the rest               100 ms    100 ms       100 ms          0        63 min
separate accounts: separate limits for OTP and campaign       100 ms    100 ms       100 ms          0        50 min
```

- **One FIFO:** 300,000 SMS at 100/s is 50 minutes. Every OTP is behind it. p50 two minutes, p99 49 minutes, and **67,500 OTPs arrive after expiring.** Each one is a person who couldn't log in, and probably pressed "send code" again, adding another one to the queue. 11.4's fan-out queue lesson, this time with a harder limit, because it isn't ours: more workers don't raise the provider's limit.
- **Pacing** - releasing a big job not all at once into the queue but at a fixed rate (with 11.2's token bucket), so part of the provider's capacity is always free for everyone else. Released at 50% of the limit, OTPs no longer get stuck, but the campaign takes twice as long (100 minutes). And the headroom maths matters: in experiment 1, releasing at 90% gives 90 + the OTPs' 20 = 110%, the queue builds up again, and **7,503 OTPs expire.** Pacing rate = limit − peak of urgent load − safety margin.
- **A priority queue:** OTPs always first, the campaign in the remaining space. Zero problems for OTPs, 63 minutes for the campaign. The campaign pays, and in experiment 2, with OTPs at 90/s, the campaign doesn't finish even in two hours (starvation). But here that is the right price.
- **Separate provider accounts** (or separate senders, for transactional and marketing): each with its own limit. The cleanest, and the campaign runs at full speed too. Price: the second account's cost and management. And one more gain: when spam complaints come in about marketing, the provider or the email receivers lower that sender's reputation; with a separate sender for transactional, OTPs don't get that punishment. In email this is almost a mandatory habit.

In the design: three priority queues, separate provider accounts (or senders) for transactional and marketing, and campaigns always paced.

### 1.5 Deep dive 2 - Provider failures: timeouts, duplicates, failover

**The spaced repetition answer:** an idempotency key on the server: the client sends a key for each separate piece of work, and the same key on retry; the server sees the key and returns the earlier result instead of doing the work again. And a client that got a timeout **does not know** whether the first one happened; that is exactly why the key exists.

Today we are the client. `npm run retry` part A: 1 million emails, 1% clearly failed (the provider said it didn't send), 2% timed out, and half of the timeouts were actually sent:

```
policy                                                      not delivered  delivered twice  provider call
once, no retry                                                      2.03%            0.00%          1.000
again on failure or timeout                                         0.00%            1.01%          1.031
again, with an idempotency key at the provider                      0.00%            0.00%          1.031
on timeout to a second provider (the key is not shared)             0.00%            0.99%          1.031
```

- **Without retries, 2% is lost,** half of it actually timeouts (we don't know whether they went).
- **With retries nothing is lost, but 1% goes twice:** the ones that timed out but were actually sent. Out of 1 million, 10,000 people get two "your order has shipped" messages. An OTP arriving twice is a small problem; "5,000 taka has been charged" arriving twice is a big one.
- **If the provider honours an idempotency key, zero and zero.** On a second request with the same key, the provider doesn't send again. But not every provider offers this. If not, the ways out: a durable "sent" record on our own side, and after a timeout asking the provider's status API (if there is one), or accepting the risk by type (OTP: send again; money news: not without asking).
- **Provider Failover** - sending the same notification through a backup provider when the primary fails or is down. But look at the table's last row: sending to a second provider after a timeout gives **1% twice** again, because the second provider doesn't know the first one's key. Failover and idempotency are hard together. So the condition for failover should be "the primary has **certainly** failed" (a clear error, or an open breaker), not "one timeout".

Part B, the primary email provider down for ten minutes, 1,000 emails a second:

```
policy                                                      delay p50  delay p99  attempts on primary
exponential backoff on the same provider (max 5 minutes)     402.63 s   786.52 s            5,860,100
breaker: second provider after 30 s of failures                500 ms    39.98 s              167,550
```

Backoff (7.4) saves the dead provider from load, but doesn't save the emails: p50 **6.7 minutes**, p99 13 minutes. And a subtle thing: even when the provider comes back at ten minutes, many emails are in the middle of a 4–5 minute backoff, so they wait a minute or so even after it is back. The breaker (9.4) sees 30 seconds of failures and moves all traffic to the second provider: p99 40 s, and 35 times less load on the primary. Experiment 4: with the breaker opening at 120 s, p99 204 s. The breaker's timing is a trade-off: too short and one momentary blip triggers failover (and its duplicates), too long and delays in an outage.

And the ones that don't go out after every attempt go to a DLQ (7.4), with an alert, because somebody needs to know "an order email didn't go out".

### 1.6 Deep dive 3 - The user's attention: aggregation, caps, quiet hours

Someone's post went viral, 500 likes in ten minutes. `npm run aggregate`:

```
policy                                                            push  first one at          last like reported
one push per like                                                  500       115 ms                 immediately
at most one per 5 minutes, drop the rest                             4       115 ms  no (last 112.64 s dropped)
batch in a 30 s window, "X and N others" (collapse key)             26      30.12 s               30.00 s later
first one at once, then the window doubles (30 s, 1, 2… min)         6       115 ms              847.36 s later
```

- **One per like:** the phone rings 500 times. The user's reaction is almost certain: notifications off, and then the next OTP doesn't come by push either.
- **Cap (at most one per 5 minutes, drop the rest):** 4 pushes, but information is lost: the last two minutes' likes are never reported, and each push only says "X liked this", nothing about the other 124 people. A cap is a safety net, not a design.
- **Aggregation Window (Collapse Key)** - collecting notifications for the same user, the same type, the same subject in a window and merging them into one ("X and 49 others liked this"), and sending to the device with a **collapse key**, so the new one replaces the old one instead of piling up (APNs and FCM both offer this idea, under different names). With a 30 s window, 26 pushes, nothing lost, but even the first one is 30 s late.
- **A window that grows:** the first one at once (the user learns "your post is getting responses"), then the window doubles: 30 s, 1 minute, 2 minutes… Only 6 pushes, the first one immediate, nothing lost. The price: the last like is reported 14 minutes later, which nobody notices for a like. The idea of exponential backoff, this time for the user's attention.

Smoke steps 3–4 run this: bob's 50 likes, 0 pushes before the window closes, then one: "fan0 and 49 others liked this".

**Quiet Hours** - holding non-urgent notifications during the user's own night (say 10 pm to 7 am) and sending them in the morning. Part B: about 37% of the day's notifications for 1 million users are created at night, and 95% of them (excluding the urgent ones) wait until morning. And a trap: if everyone is released at exactly 7:00, there is a wave at 7 am in every time zone, 3.5 million here, which is itself an unplanned campaign (and 1.4's OTP problem again). The way out: spread them randomly between 7:00 and 7:30 (11.3's jitter), in the bulk queue. Urgent ones (OTPs, security alerts) are never held.

**The life of a device token:** a push token is the address of one app install on one phone. When the app is deleted or the phone changed it dies, and on the next send APNs or FCM says "unregistered" (or something similar). The rule: delete the token as soon as that answer arrives. Smoke step 7: erin has two tokens, one dead; the first OTP makes two calls and deletes the dead one, the second OTP makes one call. Without this, 1.2's 2.16 billion wasted pushes keep growing every day.

### 1.7 A real notification service

`npm run smoke` runs every rule above in one Express service: three priority queues, channel plans from types, idempotency, aggregation windows, opt-outs, quiet hours, deleting dead tokens, and retries with the same key. The provider is a fake, which simulates dead tokens and "timed out but actually sent":

```
#   step                                                        result
1   1,000 marketing in the queue, then alice's OTP; 1 sent      push:a-phone ← code: 482913
2   OTP again with the same idempotency key                     id 1001 (earlier 1001), duplicate: true
3   50 likes on bob's post; before the window closes            0 pushes
4   window closes 30 s later                                    push:b-phone ← fan0 and 49 others liked this; merged 49
5   carol has turned marketing off                              suppressed
6   dave: marketing at 11 pm, quiet 22–7                        at night: deferred; at 7 am: sent
7   erin has two tokens, one dead; two OTPs                     provider calls: 2, then 1; tokens deleted 1
8   frank has no device, OTP                                    sms:phone:frank ← code: 999999
9   gina's order email: first call timed out (actually sent)    email: timeout → email: sent
10  in gina's inbox                                             1 email
```

- Step 1: 1,000 marketing notifications were in the queue first, but the first one sent is the OTP.
- Step 2: the calling service got a timeout and called again with the same key; the same id, nothing new. 2.5's key, this time on our API.
- Steps 5–6: preferences checked just before sending: carol's marketing dropped, dave's marketing held until 7 am.
- Step 8: frank has no push, so the OTP's channel plan moves to the next step, SMS.
- Steps 9–10: the provider timed out on the first call but had sent the email; the service sent again with the same key, and the provider recognised the key and didn't send again. gina got one email.

### 1.8 Step 5 - Trade-offs and wrap-up

**The final design:**

- **API:** dedupe on `POST /notify` by `userId + idempotencyKey`; the system decides the tier and channel plan from the type.
- **Rules just before sending:** opt-outs, quiet hours (except urgent, spread out in the morning), daily limits, aggregation windows (the first one at once, then growing) and collapse keys.
- **Queues:** three tiers; campaigns always paced, with headroom; separate provider accounts/senders for transactional and marketing.
- **Providers:** an idempotency key on every call (the `notification id`); retry on the same provider on timeout; a backup provider only when the breaker opens; a DLQ and alert after every attempt.
- **Tokens:** deleted immediately on "unregistered"; regular cleanup of old tokens.
- **Cost:** SMS only as a fallback; an SMS cost metric by country.
- **History:** a timeline for every notification, 90 days, to answer "why didn't I get it".

> **Trade-off Table - a notification system's big decisions**

| Decision     | Chose                                    | Alternative         | What I gave                                    | What I got                                                 |
| ------------ | ---------------------------------------- | ------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Queue        | Three tiers + separate provider accounts | One FIFO            | Extra accounts, a slower campaign              | OTPs never get stuck (67,500 expired in FIFO)              |
| Campaign     | Paced, with headroom                     | Poured in at once   | Twice as long for the campaign                 | The provider's limit stays free for everyone else          |
| Timeout      | Retry on the same provider, with a key   | No retry / no key   | Provider key support or our own record         | Zero lost, zero twice (otherwise 2% lost or 1% twice)      |
| Failover     | Only when the breaker opens              | On every timeout    | 30 s of delay at the start of an outage        | Fewer duplicates; p99 in an outage from 13 minutes to 40 s |
| Social burst | A growing window + collapse key          | One each / a cap    | The latest news a few minutes late             | 500 down to 6, losing nothing                              |
| SMS          | Only as a fallback                       | OTP straight to SMS | A few seconds' delay when push isn't available | The biggest line on the bill drops                         |

**What breaks first:** a new service that registers its type as "urgent" and sends everything through it (abuse of the tiers, hence ownership of types and limits on them); a provider's silent failure (it says "sent" but nothing arrives; for this, delivery receipts and regularly sending to our own test accounts, 10.4's synthetic probe); and the email domain's reputation being ruined by spam complaints about marketing, which takes weeks to fix.

---

## 2. Interview Angle

"Design a notification system" comes up often, and what makes it interesting is that it is a "pipeline" question where the hardest part is outside our control. The shape of a good answer:

1. **Types and urgency first.** OTP, transactional, social, marketing - different SLOs, different tiers. Say "all in one queue" and the interviewer will ask about the campaign.
2. **Numbers and cost.** The load, the campaign wave, and cost by channel (SMS).
3. **The relationship with providers.** Limits (pacing, separate accounts), timeouts (retry + idempotency key), outages (breaker + failover, and the price of its duplicates).
4. **The user's experience.** Preferences, quiet hours, aggregation, collapse keys, unsubscribe.
5. **Observability.** Every notification's history, delivery rate by channel, dead tokens.

**Follow-ups that are almost certain:**

- _"OTPs while a campaign is running?"_ - Separate tiers, and the limit is the provider's, so more workers don't help. Pacing (with headroom), priority, separate accounts. The number: 67,500 OTPs expired in one FIFO.
- _"Exactly once?"_ - Not possible; on a timeout we don't know. At-least-once + a key, if the provider honours it; if not, risk by type.
- _"What if a provider goes down?"_ - A breaker, a backup provider; and accounting for duplicates, because failover loses the key.
- _"Without spamming the user?"_ - Aggregation (a growing window), collapse keys, daily limits, quiet hours (spreading the morning wave).
- _"How do you know a notification arrived?"_ - The provider's "accepted" is not delivery. Push has limited delivery receipts; email has bounce and complaint webhooks; SMS has delivery receipts (DLR). And an "opened" event from inside the app.
- _"Templates and languages?"_ - Template versions, the user's language, and rendering the template at send time, so if a name changes, notifications already in the queue show the right name too.

**In real production:** the most common incidents: OTPs and password resets getting stuck during a big campaign, and a wave of "I can't log in"; a bug that sends the same notification a thousand times (a retry loop without a key), which users screenshot and post on social media; the SMS bill growing tenfold in a month (an SMS pumping attack: someone requests OTPs to fake numbers over and over to send SMS to expensive countries, which needs limits like 11.2's and per-country alerts); and push delivery rates slowly falling because of dead tokens, which nobody notices.

---

## 3. Key Takeaway

- **A notification system's limits are outside it:** the provider's speed limit, its prices, its failures. Design means your own rules around someone else's limits
- **Cost is in the channel:** SMS is 1% of notifications but 82% of the bill. SMS only as a fallback, and watch the cost by country
- **Urgent and bulk die in one queue:** 67,500 OTPs expired behind a campaign. Priority tiers, separate provider accounts, and campaigns paced - with headroom (released at 90%, 7,503 expire again)
- **A timeout means "I don't know":** without retries 2% is lost, retries without a key send 1% twice, with a key at the provider zero. Failover loses the key, so fail over only on certain failure (a breaker)
- **Backoff alone doesn't save you in an outage** (p99 13 minutes); a breaker + a backup provider does (p99 40 s)
- **The user's attention is a limited resource:** 500 likes down to 6 pushes, the first one immediate and nothing lost (a growing window + collapse key). A cap loses information; quiet hours create a morning wave, so spread it
- **Delete dead tokens immediately,** or a third of push is wasted, and the delivery count is a lie

---

## 4. New Terms (Glossary)

| Term                                      | Meaning                                                                                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Priority Tier (Transactional vs Bulk)** | Notifications in separate tiers by urgency (OTP/security, transactional/social, marketing), each with its own queue and share of the provider; the system sets the tier from the type, not the calling service               |
| **Provider Throughput Limit**             | The limit on how many per second an external provider takes from one account - more workers don't raise it; pacing, priority and separate accounts are built around it                                                       |
| **Pacing**                                | Releasing a big job (a campaign) at a fixed rate instead of all at once (token bucket), so part of the limit is always free for the urgent - rate = limit − urgent peak − margin                                             |
| **Provider Failover**                     | Sending through a backup provider when the primary fails - cuts delay in an outage, but an idempotency key doesn't carry from one provider to another, so failing over on a timeout means duplicates                         |
| **Aggregation Window (Collapse Key)**     | Merging notifications for the same user and subject in a window into one ("X and N others"), and replacing the old one on the device with a collapse key; let the window grow and the first is immediate and the total small |
| **Quiet Hours**                           | Holding non-urgent notifications during the user's night and sending them in the morning - releasing everyone together in the morning is an unplanned campaign, so spread it                                                 |
| **Device Token Lifecycle**                | A push token is the address of one app install; it dies when the app is deleted or the phone changed, and the provider says "unregistered" - delete it on that answer, or waste and a false delivery rate                    |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. In one month the SMS bill went from $7.2 million to $40 million. The dashboard says the number of OTPs is six times higher, mostly to numbers in countries where you have almost no users, and almost none of those OTPs were used. (a) What is happening? (b) What do you do today, and what do you not do? (c) With which tools from this lesson and 11.2 will you stop it permanently, and what is the price of their false positives?

2. A bank's app: a notification saying "50,000 taka has been withdrawn from your account". (a) Which channel plan, which tier, and which quiet hours rule for it? (b) Here, which is worse, "sent twice" or "not sent", and how does that change the retry and failover policy? (c) The provider said "sent", but the user says they didn't get it. How will you find out who is right?

3. The marketing team wants a flash sale push "to everyone, at once, at exactly 8 pm", to 100 million people. (a) Using this lesson's numbers, which parts of this are a problem: the push provider, your own workers, and the wave of people opening the notification and coming into the app (like 11.3's reconnect storm)? (b) Give a design that respects both marketing's goal (most people find out close to 8) and the system's limits.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) **SMS pumping (or "toll fraud"):** someone is using your OTP endpoint to send SMS to numbers in expensive countries, where they or a collaborating carrier get a cut of the money on every SMS. Nobody uses the OTPs because the goal is sending the SMS, not logging in. Your OTP API has become an open "send SMS on my money" button.

(b) **Today:** turn off SMS OTP in countries where you have almost no real users (or make it harder: a captcha first, then the SMS); strict limits on the OTP endpoint by IP, device and number prefix; a monthly cost cap and alert on the provider. **Don't:** turn off all SMS (real users can't log in), or block only by IP (attackers come from thousands of IPs, like 10.5's credential stuffing).

(c) Permanently: (1) **rate limits and budgets by country and prefix** (11.2): a daily SMS limit per country, a few times its normal usage; when exceeded, turn off the fallback in that country and alert. False positive: a sudden legitimate rise in that country (a marketing drive) gets blocked, so have a fast way to raise the limit. (2) **The OTP conversion metric:** what % of sent OTPs are used, by country; normally 60–80%, nearly zero in an attack - this is the best signal. (3) **SMS only as a fallback** (1.2): push or in-app verification first; SMS only for those without push. (4) Checking the type of number (many providers offer a lookup: whether the number is mobile, which carrier). The price of each: one extra step for real users.

**Question 2:**

(a) **Tier:** critical (security). **Channel plan:** push and SMS **both** (not a fallback, together), because if the phone is stolen or the app deleted, push doesn't get through, and this is exactly the moment when telling them matters most; plus a permanent record inside the app and an email. **Quiet hours:** never - if money is withdrawn at 3 am, they need to know right then.

(b) Here **not sending is much worse** (fraud goes unnoticed), and sending twice is annoying and confusing ("was it withdrawn twice?"). So: aggressive retries, fast failover (a short breaker time), and to soften duplicates, the transaction's specific id and time in the text ("transaction #A93F, 14:02"), so when the user gets the same news twice they understand it is one event. Meaning: reduce the harm of duplicates, increase the certainty of sending.

(c) "sent" means the provider took it, not that it was delivered. The ladder of evidence: (1) our history: when, which provider, which answer; (2) the SMS delivery receipt (DLR) from the carrier, if the provider offers it - "delivered to handset" vs "accepted"; (3) for push, a "received" ack from inside the app (when the app is open or it arrives in the background, within the platform's limits); (4) regular synthetic notifications to our own test numbers and devices (10.4), so we learn about a provider's or carrier's silent failure before the users do. In the end, what happened inside the carrier cannot be fully seen, and honestly accepting that and sending over several channels is the answer.

**Question 3:**

(a) 100 million pushes "at exactly 8":

- **Provider:** APNs/FCM take a very high rate, but not unlimited, and a sudden huge wave may get throttled (the limit is not published, it's the provider's policy). Sending in one minute means 1.6 million+ a second.
- **Your own workers:** sixteen times 1.2's peak (100,000/s). Doing it in one minute holds up every other notification (OTPs included), 1.4's problem.
- **The return wave:** a few percent of people open the app together after getting the notification: say 5% = 5 million people in one or two minutes. Login, feed, product pages - this is 11.3's reconnect storm, this time across the whole backend. And on the flash sale's inventory database (an early glimpse of 11.7).

(b) The design: make "close to 8" a window, say 7:45 to 8:15, and spread the sending (pacing), with headroom: ~55,000 a second, in the bulk tier. "Starts at 8" in the push's text (the time in the words, not in the moment of sending), so people who get it early also come at 8 or watch the clock. For the return wave: the sale page cached in advance on the CDN (4.5), a waiting room inside the app (a virtual queue) that controls the rate of entry, and capacity raised before 8 (10.7's autoscale, but planned in advance, because autoscale's delay can't catch this wave). And an agreement with marketing: campaigns of this size always follow this pattern, and requests for "everyone at once" get answered with numbers.

</details>

---

## 6. Practical Exercise

**Tier 1 - Runnable Code** (four deterministic models and a real Express + Zod notification service, with a fake provider; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-11.5-notification-system/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.5-notification-system) - `npm install`, then `npm run estimate`, `npm run queue`, `npm run retry`, `npm run aggregate`, `npm run smoke`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out the load, campaigns, cost by channel, dead tokens and history. `queue` runs a campaign and OTPs below the provider's limit under four policies. `retry` measures retries on timeouts and failures, idempotency keys and failover, and backoff vs a breaker in a provider outage. `aggregate` shows four policies for viral likes, and night-time quiet. `smoke` runs a real notification service with a fake provider through 10 steps.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the five scripts twice each, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **Prices are approximate** (email $0.0001, SMS $0.008; SMS prices vary a lot by country), and sending push is assumed to have no price of its own. The provider's limit (100 SMS/s), the failure and timeout rates, and the timing of likes are synthetic. Which providers honour an idempotency key varies by provider. APNs/FCM's "unregistered" and the collapse key idea come from their documentation; names and details differ by platform, not verified here. SMS pumping incidents come from published writing. The legal obligations (unsubscribe, SMS timing) are general statements, not legal advice. `smoke`'s provider and store are in memory, and the clock is fake. **Not measured:** real providers' speed and behaviour, delivery receipts, email deliverability, templates.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `queue`, write down: in one FIFO, what will the OTP p50 be, and how many will expire? How many minutes for the campaign? Then run it and compare.

2. **Your own cost:** `SMS_SHARE=0.002 npm run estimate` (after moving OTPs to push). How much was saved a month? Then the earlier state with `SMS_COST=0.05` (an expensive country). Which metric would have shown you this difference earlier?

3. **The price of duplicates:** in `retry`, `TIMEOUT=0.1` (a bad day). How many go twice with retries without a key, and with failover? For which types of notification would you accept retries without a key, and for which not?

4. **Changing code:** the README's experiment 5 (a daily marketing limit). Then in `src/notify.ts`, spread the notifications released at the end of quiet hours over 30 minutes (a random delay, with a seed, so smoke stays deterministic).

5. **The design part:** a "one-page design doc" for this notification system, in Lesson 1.2's five steps: (a) a table of types, tiers and channel plans; (b) five numbers and one decision from each (including cost); (c) the picture, including where preferences and rules are checked; (d) the contract with providers: limits, pacing, retries, keys, breaker, failover; (e) a campaign runbook and an SMS cost alert.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges), 11.1 – 11.4
Current: 11.5 - Case Study: Design a Notification System
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 - URL shortener; 2 - rate
limiter service; 3 - chat; 4 - news feed. Case study 5 - notifications: 300 million DAU, 35,000/s on average (peak
100,000), a campaign +28,000/s for an hour. Cost: SMS is 1% of notifications but 82% of the bill → SMS only as a
fallback. Three tiers (critical/normal/bulk), tier and channel plan from the type; separate provider accounts
(transactional/marketing); campaigns paced, with headroom (67,500 OTPs expired in FIFO; 7,503 with 90% pacing).
Providers: retry on the same provider + idempotency key (otherwise 2% lost or 1% twice); failover only when the breaker
opens (the key is lost); in an outage backoff p99 13 min vs breaker 40 s; DLQ. Users: a growing aggregation window +
collapse key (500 likes → 6 pushes), a cap loses information, quiet hours spread in the morning; dead tokens deleted
immediately (30%). History 90 days (135 TB).
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (vs Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation, Priority Tier,
Provider Throughput Limit, Pacing, Provider Failover, Aggregation Window (Collapse Key), Quiet Hours,
Device Token Lifecycle
Weak spots: [where you got stuck - write it yourself]
Next: 11.6 - Case Study: Design a Video Streaming Platform
=======================
```

---

## 8. Next Step

Today's thread: **for a system whose real work is done by others, design means your own rules around their limits.** A provider's speed limit doesn't grow with more workers, so urgent and bulk are separate, and big jobs are paced. A provider's timeout means "I don't know", so retries come with a key, and failover only on certain failure. And the scarcest resource is the user's attention: annoy them 500 times and they turn everything off, the urgent ones included.

When you are ready, write `next` - we go to **Lesson 11.6: Design a Video Streaming Platform**. This time the size of the data decides everything: a few GB for an hour of video, in several resolutions, and hundreds of thousands of people watching at once. 8.1's and 8.2's object storage and uploads, 4.5's CDN, and 10.7's data transfer cost come together in one place. The questions: after an upload, how do we cut the video into pieces and make different qualities (the transcoding pipeline), how does quality drop on its own when the viewer's network gets bad (adaptive bitrate), and why is the biggest line on the month's bill almost always the CDN's egress.
