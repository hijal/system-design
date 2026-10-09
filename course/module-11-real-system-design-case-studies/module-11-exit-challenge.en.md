# Module 11 - Exit Challenge (Real System Design Case Studies)

**Module 11 - Real System Design Case Studies**

That is all seven of Module 11's case studies: URL shortener (11.1), rate limiter service (11.2), chat (11.3), news feed (11.4), notifications (11.5), video streaming (11.6), and payments (11.7). In each one a system, from scratch, in Lesson 1.2's five steps, and in each one a script told you in advance which numbers to look at. In reality and in interviews nobody tells you. And real systems are not any one of these seven; they are built from pieces of all seven. This challenge is a new system that needs a piece of almost every case study in this module, but finding which piece goes where is up to you. This time there is no script, and no numbers worked out in advance.

---

## 1. Mini Design Challenge (Tier 3)

> **Scenario:** A ticketing platform. On Saturday at 10:00 am, ticket sales open for a popular artist's concert. Some facts:
>
> - **Venue:** 50,000 seats, in 40 sections. The front 5 sections (5,000 seats) are the most expensive and the most wanted. Seats are specific (A-12, row 3), and customers can pick from the map themselves, or ask for "give me the best available seat".
> - **Demand:** marketing estimates 2 million people will be there at 10:00, many of them with several tabs and devices open. Data from an earlier, smaller sale: in the first minute after opening, 30 requests per person on average (page refreshes, seat map, retries). The share of bots is unknown, "a lot" in the previous sale.
> - **Rules:** at most 6 tickets per person. Once a seat is picked it is held for 8 minutes; if payment doesn't happen within that time, the seat is free again. Payment by card, through one PSP (11.7). On success, the ticket by email and a QR code in the app, which will be scanned at the gate on the day of the concert; 80 gates, and the mobile network at the venue is weak.
> - **The current system:** a monolith, one Postgres, a `seats(id, section, row, number, status, held_by, held_until, order_id)` table. The seat picking API: `SELECT … WHERE status = 'available'`, then `UPDATE seats SET status = 'held' …`. The seat map page reads the state of 50,000 seats from the DB on every request. The ticket id is an auto-increment number, and the QR holds `https://tix.example/t/<id>`. Notifications are one FIFO queue, one email provider account.
> - **A summary of the postmortem of last year's small sale (10,000 seats):** the site went down at 10:00:30, for 40 minutes. After it came back, 114 seats were sold to two people. 300+ people had money taken but no ticket, at support for a week. Ticket confirmation emails were 2 hours late, and login OTPs were stuck behind them. A 30-minute line at the gate, because the scanner verified every QR on the server. "Fake tickets" on resale sites that were the numbers next to real ids.
>
> The product's goals: (1) the sale stays up, and those who can't get in at least know where they stand; (2) a seat is never sold to two people; (3) nobody has money taken without a ticket; (4) fairness: between someone who arrived at 10:00 and someone at 10:01, the 10:00 person doesn't end up behind a bot; (5) on the day of the concert, the line at the gate is under 20 minutes.

Your job: for each question below, make decisions by applying the concepts of Module 11 (and earlier modules where relevant), with reasoning. Everywhere, **work out the numbers yourself**, and derive the decision from those numbers, not the other way round.

**1. Requirements and estimation (Lessons 1.2 + 1.3 + 11.1)**
What questions will you ask the interviewer in the first five minutes (at least six), and what will you assume if you get no answer? Then the maths: in the first minute after 10:00, with no waiting room, how many requests a second? What is the most seat **writes** (hold, payment, confirm) there can be across the whole sale, and over what time? Put the two numbers side by side and say: where is this system's real limit - in reads, in writes, or in one particular place? (Give a list in the style of 11.1's "which tools won't be needed": sharding, Kafka, multi-region - needed or not?)

**2. Waiting room (Lessons 11.2 + 11.3 + 10.5 + 4.5)**
(a) At what rate will you let the 2 million people into the seat picking area? Which numbers does that rate come from (checkout capacity, the 8-minute hold, the PSP's limit)? Which of 11.2's tools sits here, and is the limit per user, or for the whole sale?
(b) Fairness: how will you order those who arrived before 10:00:00 - by arrival (FIFO), or at random? One argument for each and one attack on each (for example, someone opening 100 tabs). One person, several devices: what is their place?
(c) The waiting room page itself belongs to 2 million people: which part comes from the CDN (4.5, 11.6), which part is dynamic, and how often will your position ("32,000 people ahead of you") update - poll, SSE or WebSocket (2.4, 11.3)? Say with numbers the load of your choice.
(d) The waiting room service died at 10:00:20. Fail open (everyone pours in) or fail closed (nobody)? What is 11.2's degraded mode here? And if everyone refreshes at once, which event from 11.3 is it, and what is the remedy?
(e) Bots: what will you stop at which layer (10.5) - only at the waiting room's door, or at every step? If a bot gets in successfully, what limit stops it at the next step (where is the 6-ticket rule enforced, and by what - account, card, address)?

**3. The seat hold - a seat is never sold to two people (Lessons 5.5 + 11.7 + 11.2 + 6.1)**
(a) Why did the current `SELECT` then `UPDATE` sell 114 seats twice? Name it in the language of 5.5 and 11.2, and give a write rule that gives a seat to only one person even if two ask at the same moment (write one SQL statement).
(b) The hold's expiry: after 8 minutes, who frees the seat - a background job, or checking `held_until < now()` at read time? Name one failure for each. And the clock question (6.1, 6.4): which clock will you measure the expiry with?
(c) Hot spots: how many people at once in the front 5,000 seats in the first minute? If "give me the best available seat" shows everyone the first seat of the same row, what happens (11.2's hot key, 11.7's hot account)? Design seat allocation so there is less contention - which idea helps (a random start, splitting by section, a lease)?
(d) Write an invariant, like 11.7's Σ = 0, that must be true at every moment (available + held + sold = ?), and say where and how often you will check it.

**4. The clash between the hold and the payment (Lessons 11.7 + 9.3 + 7.4)**
A customer pressed "pay" at 7 minutes 50 seconds. The PSP's answer timed out, and the payment is `unknown` (11.7). 10 seconds later the hold expired, and someone else held the seat. Two minutes later the webhook arrived: the first person's money was taken.
(a) What will you do now, and what will you never do? To keep this state from happening at all, what rule is needed between the hold and the payment (what happens to the hold in the unknown state)? Which idea from 9.3 is this?
(b) Write the whole checkout as a saga: the steps, each one's reverse action, and after which step a reverse action is no longer possible (the pivot). Where are the idempotency keys (client → you, you → PSP)?
(c) Last year's "300+ people had money taken but no ticket" - which three of 11.7's tools together bring this to zero? And on the day of the sale, when will you run reconciliation - at the end of the day, or every 15 minutes? Why?

**5. The seat map - 2 million people, every seat's state (Lessons 11.4 + 11.6 + 4.6 + 11.3)**
The current page reads 50,000 seats on every request. (a) For those in the seat picking step (say 20,000 people at once), how often and how accurately must their map be updated? Is a seat that shows as free on the map but is actually held a harm or an annoyance? (b) Compare three paths: pushing every change (11.4's fan-out on write, to 20,000 people), a snapshot of the whole map on the CDN every few seconds with a very short TTL (11.6), and a summary by section ("Section C: 12 free") - the load of each in numbers. (c) Which of 4.6's problems comes up on the snapshot path, and what is the remedy?

**6. Tickets and gates (Lessons 11.1 + 10.5 + 11.3)**
(a) What is the connection between the auto-increment id and the resale "fake tickets"? Which term from 11.1? How will you make the ticket id, and why is making the id unguessable not enough on its own (someone sold a screenshot of one real ticket to ten people)?
(b) A weak network at the gate, 80 gates, 50,000 people in two hours: how many a second? What happens if every scan is verified on the server (last year's 30-minute line)? Give a design for verifying offline (10.5's signatures, what is on the gate's device in advance). And if the same ticket is scanned at two gates at the same time, how will you catch it offline - which trade-off are you accepting?

**7. Notifications (Lesson 11.5)**
50,000 confirmation emails (with tickets), "it's your turn" (push or email) for the waiting room's 2 million people, OTPs at checkout, and after the sale "sold out, join the waitlist" to 1.9 million people. (a) Which tier, which channel and which time limit for each of these? (b) Why were the OTPs stuck last year - like which of 11.5's numbers? Assume the provider's limit is 500 emails a second: how long do the 1.9 million "sold out" emails take, and where are the OTPs during that time? (c) If "it's your turn" arrives late, the customer loses part of their 8 minutes - how will you handle this in the design of the notification (when does the hold's clock start)?

**8. What you deliberately won't build, and cost (Lessons 11.1 + 11.6 + 10.7)**
This sale happens a few times a year, a few hours each time. Is capacity on autoscale, or prepared in advance (like 11.6's question 3 and 11.5's question 3)? Which three things from the list in the first question will you **not build**, and which number tells you so? And which one thing will you spend more on that seems "excessive" at first?

**9. Three pictures of failure**
Write three separate ways this sale could fail publicly (one of capacity, one of correctness, one of fairness), and for each: how you will notice early (which metric, which alert - 10.4), and what you will do in the middle of the sale (which switch must be ready in advance - 10.3's brownout, 10.6's flags). And a game day the week before the sale (10.3): what will you test, and how will you simulate the load of 2 million people?

**10. A 45-minute interview**
This whole design in one interview, in 45 minutes. Split the time across Lesson 1.2's five steps (by the minute). In which two places will you deep dive, and why those two? Which things will you mention in just one line and move on? And if the interviewer says midway "now say this is in 10 countries, at once" - which decisions change and which don't (10.8)?

**Things to remember:** the same habit worked in every one of this module's seven case studies, and there are four places in this challenge where mistakes come most easily. (a) **Designing with averages.** The 2 million people aren't "over the whole day", they're in the first minute; and what they want isn't even, it's in the front 5 sections (11.4's power law, 11.1's Zipf). (b) **Treating an external system as part of your own transaction.** The PSP, the email provider, the gate's network - each one times out, and a timeout means "I don't know" (11.5, 11.7). (c) **Treating fairness and correctness as capacity problems.** More servers don't stop double sales, don't stop bots, don't fix the order; these are rules of the design, not capacity. (d) **A year-round system for a one-off event.** Not permanent multi-region for a sale of a few hours; but capacity, switches and practice prepared in advance for those few hours. And this module's most important habit: before every tool, ask **"which number says this is needed?"**

I'll critique it question by question.

---

## 2. Self-Check - By the End of This Module You Should Be Able To

- [ ] Build a design from a vague question in Lesson 1.2's five steps, with the right questions in the first five minutes, and derive a decision from every number
- [ ] Say with estimation which tools are **not needed** (sharding for writes, a Bloom filter for "is the code taken", an HLL per link, throughput worries in payments)
- [ ] State the prices of the four short code approaches (random, hash, counter, secret permutation): the birthday bound, enumeration, retries, range allocation; and why 301 vs 302 is a question of who controls the link
- [ ] Separate rate limits from quotas; measure the four ways of counting centrally (atomic, limit / N, token lease, async sync) in four situations; handle hot tenants and the limiter's own failure (timeout, breaker, generous fallback)
- [ ] Design gateways and a session registry for millions of WebSockets; stop reconnect storms and congestion collapse with jitter and spreading; guarantee delivery and ordering with store-then-push, client_msg_id and a per-conversation seq
- [ ] Work out the costs of fan-out on write and read along a power law, and say hybrid's real gain (the spike, not the average); split the fan-out queue; understand tail amplification and hedged requests; why a cursor on a moving feed
- [ ] Design notifications around external providers' limits: priority tiers, pacing headroom, retries and idempotency keys, failover's duplicates, aggregation, quiet hours, dead tokens, and the cost of channels
- [ ] Say what a video platform's cost looks like (egress vs transcode); transcoding in pieces, ABR's trade-offs, encoding by popularity, and which things are immutable and which get a short TTL
- [ ] Design a payment as a state machine (with `unknown`), write the intent first, understand the value of a double-entry ledger and Σ = 0, keep money in integers, and choose reconciliation's key and window
- [ ] Recognise this module's four traps in any system: designing with averages, treating an external system's timeout as failure, treating correctness and fairness as capacity problems, and mixing big and small work in one place

---

## 3. Recommendation

**To read:**

- **Alex Xu - _System Design Interview_ (volumes 1 and 2).** The interview form of almost every case study in this module (URL shortener, rate limiter, chat, news feed, notifications, YouTube, payments), with diagrams. Reading them after this module, you'll see where they abbreviate and where your numbers say more. Volume 2's "payment system" and "ad click aggregation" chapters are the next step after 11.7 and 11.1's analytics.
- **Martin Kleppmann - _Designing Data-Intensive Applications_.** The background of the whole course; for this module especially chapter 11 (stream processing, the event pipelines of 11.1 and 11.4) and chapter 12 (correctness, end-to-end idempotency - the deep form of 11.7).
- **Stripe's engineering blog post "Designing robust and predictable APIs with idempotency".** One of the real sources of 11.7's idempotency key, short and direct.
- **Google's "The Tail at Scale" (Dean & Barroso, 2013).** The original writing behind 11.4's tail amplification and hedged requests, four pages.
- **The published talks on Facebook's "TAO" and Twitter's timelines, Discord's "How Discord Stores Billions of Messages" and the later ScyllaDB post, and the Netflix tech blog's posts on encoding and Open Connect.** The real forms of 11.3, 11.4 and 11.6, each with numbers and mistakes that no book has. They are the companies' own writing, so from their point of view - read them with that in mind.

**Events worth watching and reading:**

- **The published accounts and discussion of a big concert's ticket sale failure in 2022** (demand several times what was expected, bots, a waiting room). Almost every question in this challenge happened there for real. Read both the company's own statements and independent analyses, and see where they differ.
- **Any payment provider's published incident reports** (many put a full postmortem on their status page). In each, look for: how "unknown" was handled during the timeouts, and what reconciliation caught, and how long after.

**For a project:**

- **Build this challenge as a small real system:** an Express + Postgres ticket service - the seat hold with a conditional `UPDATE`, with an expiry; a waiting room (a token bucket and queue positions in Redis); a fake PSP like 11.7's; and the 10:00 wave with k6 or your own TypeScript load generator. Measure: how many seats sold twice (must be zero), how many people charged without a ticket (zero), and what happens without the waiting room.
- **An "invariant" checker:** a script that runs every minute and verifies question 3(d)'s rule and 11.7's Σ = 0, alerting when they break. Then deliberately introduce a race (`SELECT` then `UPDATE` on the hold) and see how many seconds the checker takes to catch it.
- **A case study of your own:** in this module's pattern (requirements, estimation with a script, deep dives, one real small service, trade-off tables), write up a new system yourself - like a ride-hailing app's driver matching, or simultaneous editing like Google Docs. Which piece of which case study did you need, and what was completely new?

---

Do the exit challenge and send it over. When you are ready, write `next` and we go to **Module 12: Interview Mastery & Capstone**, starting with Lesson 12.1: **the interview framework recap and the 10 most common mistakes.**

In Module 11 every system came with a script that told you which numbers to look at. In Module 12 that help won't be there: the numbers in your head, the time on the clock, and an interviewer in front of you who changes the question midway. 12.1 goes over Lesson 1.2's structure again, this time with the experience of these eleven modules, and the ten mistakes people make most in interviews - several of which you have already seen in this module's case studies (designing with averages, naming the tool before the number, not stating the trade-off). Then estimation drills, two mock interviews, and finally TaskFlow's complete design doc, as the Capstone.
