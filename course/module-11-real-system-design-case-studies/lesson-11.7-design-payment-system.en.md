# Lesson 11.7 — Case Study: Design a Payment System

**Module 11 — Real System Design Case Studies**

> **Spaced Repetition (Lesson 7.5):** What is a dual write? In one request, writing to the database and sending an event to a queue, two separate systems — why does no ordering (DB first then queue, or the reverse) make it safe? And how does the transactional outbox do it? Today the second system is not a queue but a payment provider on the bank's side, and "a crash in the middle" means someone's money was taken and we have no record of it.

**Prerequisite:** Lesson 2.5 (Idempotency key), Lesson 5.5 (Transaction, lost update), Lesson 6.4 (Clocks), Lesson 7.4 (Retry), Lesson 7.5 (Dual write, outbox), Lesson 9.3 (Saga), Lesson 10.5 (Webhook signatures, secrets), Lesson 11.2 (Key splitting), Lesson 11.5 (A timeout means "I don't know")

**By the end of this lesson you will be able to:**

1. Design a payment as a state machine in which "I don't know" (unknown) is a full state; why treating a PSP timeout as "failed" brings both double charges and lost money, and why writing the intent first, idempotency keys, webhooks and a recovery job together give every payment a definite end
2. Build a double-entry ledger and say why it is safer than a `balance` column: money only moves, Σ = 0 is a provable rule, and history never changes; plus money in integer cents, rounding rules, and the lock trap on hot accounts
3. Design reconciliation: matching your own records against the PSP's at the end of the day, by which key, in which window, so real problems are caught and there is no flood of false alerts

**Tier:** 1 — Runnable Code (four deterministic models and a real Express + Zod payment service, with a fake PSP and HMAC-signed webhooks; no Docker needed)

---

## 0. Today's System

The interviewer:

> "Design the payment system for an e-commerce checkout. Customers pay by card, we use a payment provider, and the sellers (merchants) get paid once a week. There are refunds too."

In Module 11's previous six systems, one idea ran almost everywhere: "data a few seconds stale is fine", "losing one does little harm", "counting approximately is enough". None of that works here. The first move for payments is often: "Call the PSP at checkout, and on success set the order's `status = 'paid'` and the merchant's `balance += amount`." And the questions:

- "The PSP didn't answer in 30 seconds. What will you show the customer? Will you charge again?"
- "Your server died after calling the PSP, before writing to the DB. Now what?"
- "Two orders increased the same merchant's balance at the same time. Did both stick?"
- "What happens when you add $19.99 + $5.01 as floats?"
- "At the end of the month finance says there's a $3,210 difference between the money that came from the PSP and your books. Where is it?"

A piece of almost every module of system design comes in here, under maximum pressure: 2.5's idempotency, 5.5's transactions, 7.5's outbox, 9.3's saga, 10.5's signatures, 11.5's "a timeout means I don't know".

---

## 1. Theory

### 1.1 Step 1 — Requirements

```
Question                                   Assumed
What operations?                           card payments, full or partial refunds, merchants' weekly payouts
Through whom?                              one PSP (primary), a second one later
How much?                                  10 million payments a day, $30 on average; 10 times that on a sale day
Card data?                                 never enters our system — the PSP's tokenization (below)
Which currency?                            USD today; multiple currencies in one line at the end
Left out                                   the fraud detection model, subscriptions, currency conversion, taxes
```

**Non-functional, and here the priorities change:** correctness before availability. Showing "processing…" for a few seconds is far better than taking someone's money twice. Every payment must have a definite end (succeeded or failed, never "unknown" forever). An immutable record of every movement of money (audit), for years. And **PCI DSS** (the security standard for card data): the fewer places a card number goes, the better. So in the common design the card number goes straight from the browser to the PSP (the PSP's own form or SDK), and we get only a token. Our database never holds a card number, and the compliance burden is much smaller.

**Payment Service Provider (PSP)** — the external company that talks to the card networks and banks and takes the money on our behalf (like Stripe, Adyen, or a country's local gateway); from our side, an API, with its own slowness, failures, and its own books.

### 1.2 Step 2 — Estimation: small load, big mistakes

`npm run estimate`:

```
── Part A — load: 10 million payments a day, $30 on average ──
payments / s (average)                                           116
payments / s (on a sale day, 10×)                              1,157   small for a Postgres
money per day                                           $300 million

── Part B — the price of mistakes ──
mistakes on 0.1% of payments                                $300,000      $110 million
mistakes on 0.01% of payments                                $30,000     $10.9 million
mistakes on 0.001% of payments                                $3,000        $1,095,000

── Part C — ledger: 6 entries per payment ──
entries per day                                           60 million
kept 7 years (legal)                                     153 billion   30.7 TB

── Part D — where the money of one $30 payment goes (fee 2.9% + $0.3, approximate) ──
the customer paid                                             $30.00
processing fee                                                 $1.17   3.9%
the merchant gets                                             $28.83   a few days later, in the payout
```

The rest of this lesson explains this one table. **The load is small:** even on a sale day ~1,200 a second, easy for a good Postgres; sharding is not even a question (like 11.1). **The mistakes are big:** one mistake in ten thousand is $11 million a year. And mistakes usually come from tedious places, like a timeout, a crash, a race, a rounding, a time zone. So the design's job is not throughput but **correctness at every edge case.**

(An honest confession: while writing this script, the fee heading first printed `2.9000000000000004%`, because `0.029 * 100` is a float. That exact problem is in 1.5.)

### 1.3 Step 3 — High-level design and the payment's state machine

```
 browser ──card──► [the PSP's form/SDK] ──token──► browser ──► [checkout API]
                                                                 │
                         ① POST /payments { amount, idempotencyKey }
                                                                 ▼
                                       [payment service] ── ② DB: payment(created) + ledger
                                                │ ③ PSP.charge(ref = payment id)
                                                ▼
                                             [PSP] ──── ④ webhook (signed) ────► [payment service]
                                                │                                     │
                                                └── ⑤ end-of-day settlement report ──► [reconciliation]
                                                                                      │
                                         [recovery job] — asks the PSP about "created"/"unknown"
                                         [payout job] — weekly, the merchant's balance → bank
```

**Payment Intent** — a record of a payment created **before the PSP is called**, with a unique id (which goes to the PSP as the reference and the idempotency key) and a state. The states:

```
                 ┌───────────── declined ─────────────► failed
created ──PSP──► ├───────────── charged ──────────────► succeeded ──► (refunds, partial, repeated)
                 └── timeout / 5xx / crash ──► unknown ─┬─ webhook: charged ──► succeeded
                                                         ├─ webhook: failed ───► failed
                                                         └─ recovery: ask the PSP ──► succeeded / failed
```

**Unknown State** — the payment's state until a definite answer comes from the PSP: neither succeeded nor failed. It shows the customer "processing", and ends by one of three paths (a webhook, recovery's question, or reconciliation). This is 11.5's "a timeout means I don't know" turned into a full, visible state.

### 1.4 Deep dive 1 — Timeouts and crashes: when was the money taken?

`npm run timeout` part A: 1 million payments, 1% time out, and 60% of those were actually charged:

```
policy                                                charged twice  charged, no order     wait p99
timeout = failed, let the user try again                      4,060              1,819            —
resend it ourselves, a new request                            5,821                  0            —
resend it ourselves, the same idempotency key                     0                  0            —
keep "unknown": webhook, else ask for the status                  0                  0         52 s
```

- **Treating it as "failed":** showing the customer "payment failed, try again". Those who try again when the first one was actually charged get **charged twice** (4,060). And those who don't try again have money taken with no order (1,819): they don't know, and neither do we until reconciliation catches it. The second one is silent, and so worse. Experiment 1: when fewer people try again, double charges drop, but "charged, no order" grows to 4,248.
- **Resending ourselves, a new request:** nothing is lost, but if the first one was charged, the second one is too: 5,821. Experiment 2: when almost every timeout was actually charged (95%), 9,206.
- **The same idempotency key:** the PSP doesn't charge a second time on the same key, it returns the earlier result (the big PSPs offer this). Zero and zero. The condition: the PSP is responding.
- **Keep unknown:** the PSP's webhook (usually arrives in seconds) or, if it doesn't, asking the PSP ourselves a minute later. Zero and zero, the price: some customers see "processing" for up to ~a minute (p99 52 s). Retrying with a key and unknown work together: retry first, and if there's still no answer, unknown.

**The spaced repetition answer, and part B:** in a dual write, a crash between the two systems can leave one without the other in any order; the outbox writes both in one transaction in one system (the DB), and sends to the other later. Here the second system is the PSP, which cannot be brought into our transaction. So the only safe order: **a durable record on our side first, then the external work.** A 0.1% crash at each step:

```
order                                                         charged, we have no record      recovery finds
charge at the PSP → then write the payment to the DB                                 970                   0
intent in the DB (created) → PSP → the result in the DB                                0                 955
```

Charging at the PSP first, after a crash 970 people's money is taken and we have nothing anywhere — not even a clue to search for. Writing the intent first, the same crash leaves the payment in the `created` state, and the **recovery job** (every few minutes, looking for "created or unknown, older than X minutes") asks the PSP by payment id and fixes it: it finds 955, and loses zero. This is exactly the outbox idea: write "I'm about to do this" in your own DB, so someone can finish it after a crash.

A security side of the **webhook** (10.5): a webhook is a public endpoint, where anyone can write "pay_1 succeeded". So the PSP puts an HMAC signature of the body on every webhook (with a shared secret), and we verify it on the **raw body** (before parsing; re-serializing JSON changes the bytes), with a constant-time comparison. Smoke step 6: a fake webhook gets 401. And webhooks also arrive at-least-once, possibly twice, out of order: so processing them is idempotent (an already succeeded payment succeeding again changes nothing).

### 1.5 Deep dive 2 — The double-entry ledger

The first move's `merchant.balance += amount` has two problems. `npm run ledger`: 1,000 wallets, 200,000 transfers, 30% of them to one big merchant (like a sale day), a DB round trip of ~2 ms, 0.1% crashing midway:

```
design                                                         total change  negative wallets   lost midway       provable?  wait on locks
balance column: read, compute, write                             -5,139,292                 0           158              no        0.00 ms
balance column: each row atomic, two separate statements            -35,998                 0           157              no        0.00 ms
double-entry: one transaction, locks on both accounts                     0                 0             0      yes, Σ = 0        37.40 s
double-entry: lock only the account paying out                            0                 0             0      yes, Σ = 0        7.39 ms
```

- **Read, compute, write:** 5.5's lost update, this time with money. Two transfers to the hot merchant's balance read the same old value, and one's addition is lost. In 100 seconds **5.1 million cents** ($51,000) silently vanish. In the experiment, with a slow DB (10 ms), 8.4 million: the race window is bigger.
- **Each row atomic, but two separate statements:** no race, but a crash after the debit and before the credit means money left one place and never arrived at the other: 36,000 cents. And in both cases nobody notices, because a balance is a number with no history.
- **Double-Entry Ledger** — every movement of money is a transaction with at least two entries (a debit on one account, a credit on another), and the sum of all entries in a transaction is **zero**. Entries are never changed or deleted (to fix a mistake, another, reversing transaction). A balance is a derived value: the sum of all that account's entries. A five-hundred-year-old bookkeeping rule, and the reason shows here: **Σ of all entries = 0** must always be true, so if any bug, race or crash creates or destroys money, the maths catches it. The entries are written in one database transaction, so a crash leaves all or nothing.

Smoke step 1: a $30 payment means three entries: `psp_receivable +$30.00`(the PSP will pay us),`merchant:m_shop −$28.83` (we will pay the merchant), `revenue:fees −$1.17` (our income). The sum is zero. (The sign rule: debits positive, credits negative; liability and income accounts are normally negative.) At the last step, the sum of 12 entries is **0 cents**.

**The hot account trap:** the first ledger design locks both accounts (for the overdraft check). But the hot merchant's account gets 600 transfers a second, each holding it for ~2 ms: demand above capacity, and the line keeps growing, worst wait **37 seconds.** Experiment 3: with a 10% hot share, 20 ms. Notice: the overdraft check is only needed for the account **paying out**; the balance of the account receiving money doesn't go down, so it doesn't need a lock. A credit is an insert without a lock (append-only), and the balance is counted later: 7 ms. At a bigger scale still: split the hot account into several sub-accounts (11.2's key splitting), summed at payout time.

**Minor Units** — always keep money as an integer in its smallest unit (cents, paisa), never as a float. Part B:

```
sum in float (dollars)                              504892524.099961
sum in integers (cents) ÷ 100                       504892524.100000
0.1 + 0.2 = 0.30000000000000004; 0.029 * 100 = 2.9000000000000004

fee 2.9%: rounding each then summing 1,464,194,395 cents, rounding once on the total 1,464,188,320 cents — difference 6,075 cents
```

Summing 10 million prices, the float error is only 0.004 cents — small, but not zero, and comparison with `===` breaks, and two systems' books "almost" match, never fully. The second line is subtler: integers need a rounding **rule** too. Rounding each payment's fee separately and summing vs rounding once on the total: a difference of 6,075 cents. Both are reasonable. But if you use one and the PSP the other, the books will never match. So rounding (where, which way, half-up or banker's) is a written rule, matched to the PSP's rule. And with multiple currencies: each currency's minor unit differs (JPY has no cents, some currencies have three decimals), so an amount always goes paired with its currency.

### 1.6 Deep dive 3 — Reconciliation

Even with unknown, recovery and the ledger, something slips through: a webhook is lost and recovery has a bug, a capture didn't go through on the PSP's side, the PSP took a charge twice, an amount differs by one cent. The last line of defence to catch them:

**Reconciliation** — regularly (usually daily) matching your own records against external records (the PSP's settlement report, the bank statement) one by one, and sending every mismatch to a human or automated investigation. **Settlement** — the money the PSP took arrives in our bank account a few days later, minus fees, with a report; the ledger's `psp_receivable` goes down as it arrives, and that has to be matched too.

`npm run reconcile`: 1 million payments in one day, 372 real problems (of four kinds), and one real-world detail: the PSP's day is in UTC, ours in UTC+6 (Bangladesh):

```
matching rule                                              alert      real  false alerts  real, not caught
same date, matching amounts only                          56,020         1        56,019        371 (100%)
our payment id (in the PSP's reference), same date       500,514       318       500,196          54 (15%)
payment id, a ±1 day window                                  372       372             0            0 (0%)
```

- **Matching by amount:** many payments have the same amount, so the pairs are random, and a real problem almost always hides behind a wrong pair: **371 of the 372 are never caught,** plus 56,000 false alerts. Experiment 4: even in the same time zone, 98% hide. The matching key has to be unique, and that is why we give the PSP our payment id as the reference.
- **By id, but on the same date:** the first 6 hours of our day are in the PSP's previous day, and the last 6 hours of the PSP's day are in our next day. **500,000 false alerts** every day. No human reads that, and the 54 real problems inside it are lost too. False alerts are not just an annoyance; they make reconciliation useless.
- **Id, a ±1 day window:** a day's mismatches are held "pending" until the next day's run, then checked again. Exactly 372 alerts, all real, zero false. (Remember 6.4: two systems' "today" is never the same; keep tolerance at the boundaries.)

Smoke step 11: `pay_3` appears twice in the PSP's report (a duplicate charge on the PSP's side), and reconciliation catches it. The fix is a refund and telling the customer.

### 1.7 A real payment service

`npm run smoke` runs every rule above: integer cents, intent first, idempotency keys, unknown, HMAC webhooks, the recovery job, refund limits, a double-entry ledger, reconciliation:

```
#   step                                                        result
1   a $30.00 payment                                            201 succeeded; psp_receivable $30.00, merchant:m_shop −$28.83, revenue:fees −$1.17
2   the same idempotency key again (the client's retry)         200 pay_1 (earlier pay_1); PSP calls 1
3   $42.00, card decline                                        402 failed; 3 entries in the ledger
4   $55.00, PSP timeout (actually charged)                      202 unknown
5   the PSP's webhook arrived (correct signature)               200 → succeeded
6   a fake webhook (wrong secret)                               401; pay_1 still succeeded
7   $77.00 timeout, webhook lost; recovery job 5 minutes later  1 fixed → succeeded
8   refund $10.00 of the $30.00                                 201 ok
9   the same refund key again                                   200 duplicate
10  refund another $25.00 (over the total captured)             409 exceeds
11  matching the PSP's report at the end of the day             pay_3: 2 times at the PSP
12  the ledger's final state                                    psp_receivable $152.00, merchant:m_shop −$146.79, revenue:fees −$5.21
13  the sum of all entries                                      0 cents (12 entries)
```

- Step 2: the client (browser or checkout service) got a timeout and called again with the same key: the same payment, one call to the PSP. Idempotency at two levels: client → us (the key), us → PSP (the payment id).
- Step 3: nothing is written to the ledger on a decline — the ledger is only real movements of money.
- Steps 4–5: 202 (accepted, still unknown), then succeeded on the webhook. Step 7: recovery when the webhook is lost.
- Steps 8–10: a refund is a new ledger transaction (in the reverse direction, with a proportional share of the fee), with its own idempotency key, and refunding more than was captured is impossible.

### 1.8 Step 5 — Trade-offs and wrap-up

**The final design:**

- **Card data:** the PSP's tokenization; we hold only a token. A small PCI scope.
- **Payment:** intent first (DB), id = the PSP's reference and idempotency key; an idempotency key from the client to us as well. `unknown` as a full state in the state machine. Retries with the same key; webhooks (HMAC, raw body, idempotent processing); a recovery job every few minutes.
- **Ledger:** double-entry, append-only, in one DB transaction; a regular Σ = 0 check with an alert; balances derived (or a cache updated from the ledger, but the ledger is the truth); credits without locks on hot accounts, sub-accounts if needed. Money in integer minor units, with the currency; a written rounding rule.
- **Reconciliation:** daily, by payment id, a ±1 day window, a queue and an owner per kind of mismatch. A second layer against settlements and bank statements.
- **Payout:** a weekly job, `merchant → bank_payable` in the ledger, with idempotency and reconciliation again on the bank's side.
- **Scale:** one Postgres primary + a synchronous replica (RPO zero, 10.8) — throughput isn't needed, durability is. Strict database isolation (5.5) where balances are checked.

> **Trade-off Table — a payment system's big decisions**

| Decision        | Chose                                             | Alternative                 | What I gave                                   | What I got                                                            |
| --------------- | ------------------------------------------------- | --------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Timeout         | `unknown` + retry with a key + webhook + recovery | Show "failed" / a new retry | Some customers see "processing" for ~1 minute | Zero double charges and lost money (otherwise thousands)              |
| Order of writes | Intent first, then the PSP                        | The PSP first               | One extra write per payment                   | Zero records lost in a crash (otherwise 970 at a 0.1% crash)          |
| Keeping money   | Double-entry, append-only                         | A `balance` column          | More rows, the cost of counting balances      | Money doesn't vanish in races and crashes; proof by Σ = 0; audit      |
| Locks           | Only the debited account                          | Both accounts               | Counting the credited balance later           | 37 s down to 7 ms on the hot merchant                                 |
| Amounts         | Integer minor units + a rounding rule             | Float                       | Unit conversion in every calculation          | Exact sums and comparisons; matches the PSP                           |
| Reconciliation  | Payment id, ±1 day                                | Amount / the same date      | Mismatches confirmed a day later              | All the real ones caught, zero false alerts (otherwise 500,000 a day) |

**What breaks first:** a long PSP outage (a pile of unknowns, and the question "shall we send them to the second PSP?" — as in 11.5, failover loses the key, so unknowns never go to the second PSP); a migration that runs an UPDATE to "fix" ledger entries (breaking append-only, losing the audit); and reconciliation mismatches nobody reads, because the habit of false alerts has set in.

**Multiple currencies in one line:** every amount with its currency, separate ledger accounts per currency, a conversion as a separate ledger transaction with its own rate, and never adding amounts in two currencies directly.

---

## 2. Interview Angle

In "Design a payment system" the interviewer almost always goes to three places: idempotency and timeouts, the ledger, and reconciliation. Almost nothing about throughput — and saying that yourself (with numbers) is a good sign. The shape of a good answer:

1. **Correctness first, and why.** The load is small (thousands a second), the mistakes big (0.01% = millions a year). Card data with the PSP (PCI).
2. **The state machine and unknown.** Intent first, id = the PSP's idempotency key, unknown on timeout, webhooks (signed) and recovery.
3. **The double-entry ledger.** Why not a balance column, Σ = 0, append-only, one transaction. Integer minor units.
4. **Reconciliation.** What you match by, in which window, who gets the mismatches.

**Follow-ups that are almost certain:**

- _"How will you avoid double charges?"_ — Idempotency at two levels (client → us, us → PSP), and not treating a timeout as failure. The numbers: treating it as "failed" gives 4,060 double charges and 1,819 lost in 1 million.
- _"What if the server dies after the PSP call?"_ — The intent was written first, so it is in the `created` state; the recovery job asks the PSP by id. In the reverse order it is lost forever.
- _"Exactly-once?"_ — Not with an external system. At-least-once + idempotency + reconciliation.
- _"Why a ledger? A balance column is simpler."_ — Races (5.1 million cents vanished), crashes (a debit with no credit), and no history at all. In a ledger Σ = 0 is a mathematical check.
- _"Where is the saga?"_ — At checkout: reserve inventory → payment → confirm the order; if the payment fails, release the inventory (9.3). But inside the payment itself, compensation means a refund, which is itself a payment and can fail — hence the ledger and reconciliation.
- _"Which database?"_ — Relational, ACID, strict isolation, a synchronous replica. There is no place for eventual consistency here (balances), or only on the read side (dashboards).

**In real production:** the most common incidents: thousands of double charges in a wave of timeouts (during a slow moment at the PSP), because the checkout frontend showed a "try again" button; verifying webhook signatures on parsed JSON (the bytes change, every webhook fails) or not at all; a "small" migration that UPDATEd ledger entries; reconciliation's daily thousands of false alerts because of time zones, in which a real one was lost; and money in floats, which shows up at the end of the month as a mismatch of a few cents in finance's spreadsheet that nobody can find.

---

## 3. Key Takeaway

- **In payments the load is small and the mistakes big:** ~1,200 a second is nothing for a Postgres, but 0.01% mistakes are $11 million a year. The design's job is correctness at every edge
- **A timeout means "I don't know" — so `unknown` is a full state:** treating it as "failed" gives 4,060 double charges and 1,819 lost payments in 1 million; zero with retries on a key and webhooks/recovery
- **Your own record first, then the external work:** charging the PSP first, a 0.1% crash leaves 970 charges with no trace; writing the intent first, recovery finds them all (7.5's outbox idea)
- **In a double-entry ledger money only moves:** Σ = 0 is provable; a balance column silently loses 5.1 million cents in races and 36,000 in crashes. Append-only, one transaction
- **On a hot account, lock only the payer:** locking both accounts makes a 37 s line, locking the debit 7 ms
- **Money in integer minor units, with a written rounding rule:** in floats `0.1 + 0.2 ≠ 0.3`; and moving where you round makes a 6,075-cent difference over 10 million payments
- **Reconciliation is the last line of defence, with a unique key and tolerance at the boundaries:** matching by amount hides 100% of real problems; the same date gives 500,000 false alerts a day; id + ±1 day gives exactly the real ones

---

## 4. New Terms (Glossary)

| Term                               | Meaning                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Payment Service Provider (PSP)** | The external company that talks to card networks and banks and takes the money; from our side an API, with its own slowness, failures and books; it tokenizes card data and takes on the PCI burden                                  |
| **Payment Intent**                 | The record of a payment created **before** calling the PSP, with a unique id (the PSP's reference and idempotency key) and a state — someone can finish it after a crash                                                             |
| **Unknown State**                  | The state before a definite answer from the PSP — neither succeeded nor failed; ends by a webhook, asking the PSP (recovery), or reconciliation; treating a timeout as "failed" brings double charges and lost money                 |
| **Double-Entry Ledger**            | Every movement of money is a transaction with at least two entries summing to zero; entries never change; balances are derived — races, crashes and bugs are caught mathematically by Σ = 0                                          |
| **Minor Units**                    | Money as an integer in its smallest unit (cents, paisa), with its currency — no float errors; plus a written rounding rule, so your books and the PSP's match                                                                        |
| **Reconciliation**                 | Regularly matching your own records against external ones (the PSP's report, the bank) one by one by a unique key and investigating every mismatch — with tolerance at the boundaries (days, time zones), or a flood of false alerts |
| **Settlement**                     | The money the PSP took arriving in our bank a few days later, minus fees, with a report — it reduces the ledger's receivable, and calls for another layer of reconciliation itself                                                   |

---

## 5. Reflection Questions

Think for yourself before looking at the answers. Write at least two or three lines for each, in your own words.

1. The PSP is almost down for an hour: half the requests time out, the rest are slow. A sale is on, 1,000 checkouts a second. (a) In this lesson's design, what piles up in that hour, how many, and what does the customer see? (b) Someone says "send them to the second PSP." Which payments are safe to send to the second PSP and which aren't, and why? (c) What is the recovery job's risk once the PSP comes back (like 11.3)?

2. TaskFlow (the app from Modules 1–10) is launching a paid plan: a monthly subscription, priced by team size, with a proportional price when seats are added mid-month (proration). (a) Which accounts does the ledger need? (b) 3 seats are added mid-month, with a proportional price by the day: where will you set the rounding rule, and why must it match between the invoice and the PSP's charge? (c) What happens when the monthly charge fails because the card expired (retries, a grace period, states)?

3. Finance says: "Last month there's a $3,210 difference between what the PSP owes us in the ledger (`psp_receivable`) and the settlements that arrived in the bank." (a) For which of this lesson's reasons could this happen (at least four)? (b) With which report or query will you look for each? (c) Once you find the difference, how will you fix it in the ledger, and what will you **not** do?

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:**

(a) In one hour, half of 3.6 million checkouts (~1.8 million) time out and pile up in `unknown`, after a few retries with their keys. The customer sees "processing", then after a set time (say 2 minutes) "we are confirming your payment, you'll get an email once it's confirmed; please don't try again" — and the order is in a "payment pending" state, with the inventory reserved (the first step of 9.3's saga). Most important: **no** "try again" button on the frontend, because that is exactly the source of double charges (1.4's 4,060).

(b) **Safe:** payments that have never yet been sent to the primary PSP (new checkouts, while the primary's breaker is open), and those the primary PSP **explicitly** said failed (not declined, but a definite not-charged like "service unavailable"). **Not safe:** any `unknown` — the primary PSP may have charged it, and the second PSP doesn't know the first one's key (11.5's failover duplicates, this time with money). These are confirmed with the primary PSP itself when it comes back. And whether the customer's card token works on the second PSP at all is another question (tokens usually belong to one PSP).

(c) If, as soon as the PSP comes back, the recovery job asks for the status of 1.8 million `unknown`s at once, the freshly recovered PSP can sink again, taking new checkouts with it (11.3's reconnect storm, this time with us sending the wave). So recovery is paced (like 11.5, at a share of the PSP's limit), oldest first, keeping capacity for new checkouts. Many PSPs offer a daily report or a bulk status API, which is better than thousands of separate calls.

**Question 2:**

(a) Accounts: `customer:<team>:receivable` or straight to `psp_receivable` (for card charges), `revenue:subscriptions` (income), if needed `deferred_revenue` (money taken in advance that isn't income yet — taking a whole month's money at the start of the month, by accounting rules it becomes income day by day), `revenue:fees` or `expense:psp_fees` (the PSP's fee), and `credits:<team>` (for downgrades, deducted from the next invoice instead of refunded). Every event (invoice, charge, proration, credit) is a pair of entries.

(b) The proration is calculated **once, when the invoice is created**, in integer cents, by a written rule (for example: the price per day floored in cents, the total half-up). Then exactly the invoice's total is charged at the PSP, and the PSP does no calculation. The reason: what the customer sees on the invoice should be exactly what is taken from the card, and exactly what is in the ledger — separate rounding in three places means a permanent mismatch like 1.5's 6,075 cents, and customer tickets saying "my invoice is $29.97 but I was charged $29.98".

(c) The charge fails (declined, the card expired): the subscription goes into a "past_due" state, a few retries over a few days (dunning), each a new attempt for the same invoice but **with idempotency by the invoice's id**, so even if two attempts succeed it is charged once. An email to the customer (11.5) with a link to update the card. After a grace period (say 7 days) the plan is downgraded, without deleting data. The invoice's receivable stays in the ledger until the money arrives or it is written off (a write-off, another transaction).

**Question 3:**

(a) Possible causes: (1) **settlement timing** — the charges of the last few days of the month settle the next month (1.6's day boundary, this time a month's); (2) **fee mismatches** — the PSP's real fee (international cards, extra fees for currency conversion) differs from the fee we assumed, or the rounding is done in a different place (1.5); (3) **refunds and chargebacks** — the PSP has taken the money for a chargeback (a dispute through the customer's bank), which hasn't reached our ledger yet (the chargeback webhook was lost or not processed); (4) **lost or duplicate charges** — reconciliation mismatches nobody resolved (1.6's four kinds); (5) a PSP reserve (part of the money held back for risk) that isn't in our ledger.

(b) (1) A breakdown by charge date vs settlement date — the sum of "charged this month, settled next month"; (2) the fee on each line of the PSP's settlement report vs our calculated fee, joined by payment id, with the differences grouped by currency and card type; (3) chargeback and refund lines in the PSP's report vs the same kind of transactions in our ledger; (4) the daily reconciliation's list of open mismatches, by age; (5) the PSP's balance or reserve report.

(c) **Do:** a new ledger transaction with an explanation for each cause found (like extra fees to `expense:psp_fees`, chargebacks to `chargeback_losses`), on the right date, with a reference (which line of which report). The sum stays zero, and the history shows when and why. And fix the root cause (like processing chargeback webhooks), so it doesn't happen next month. **Don't:** UPDATE or DELETE old entries to make the numbers match, or cover the difference with a single "adjustment $3,210" entry with no explanation. Both break the audit, and next time nobody will know what each part really was.

</details>

---

## 6. Practical Exercise

**Tier 1 — Runnable Code** (four deterministic models and a real Express + Zod payment service, with a fake PSP and HMAC-signed webhooks; no Docker needed)

> **Ready to run in the repo:** [`exercises/lesson-11.7-payment-system/`](https://github.com/hijal/system-design/tree/main/exercises/lesson-11.7-payment-system) — `npm install`, then `npm run estimate`, `npm run timeout`, `npm run ledger`, `npm run reconcile`, `npm run smoke`. The full setup, acceptance criteria and experiments are in the `README.md` there.

`estimate` works out the load, the money, the price of mistakes, the ledger's size and the path of one payment's money. `timeout` measures four policies for PSP timeouts and two write orders under crashes. `ledger` runs four designs, balance column and double-entry, with a hot merchant, in virtual time, and shows float vs cents and rounding. `reconcile` compares three matching rules on one day's data. `smoke` runs a real payment service with a fake PSP through 13 steps.

**Honest notes:** Verified by running in the sandbox on Node 26: `tsc --noEmit`, ESLint and Prettier clean; the five scripts twice each, output identical byte for byte. The README's experiments 1–4 were run, with their numbers in the lesson; 5 is a code-changing task, yours. **The rates and prices are assumed** (declines, timeouts, fees, crashes), not measured; keeping the ledger 7 years is a common figure, and the law differs by country. `ledger`'s race is a virtual-time model, and a real Postgres's isolation and lock behaviour could change the results. `reconcile`'s data is synthetic. `smoke`'s PSP and store are in memory, and the clock is fake; the webhook's HMAC is real. The statements about PCI DSS, tokenization and the big PSPs' support for idempotency keys are general and come from published writing, not legal or compliance advice. **Not measured:** a real PSP, real database transactions, chargebacks, multiple currencies, fraud.

**Once the setup checks out, do these five:**

1. **Predict first:** **before** running `timeout`, write down: under the "timeout = failed" policy, how many double charges in 1 million? Work it out by hand (timeouts × actually charged × users retrying × the second one succeeding), then run it and compare.

2. **The race window:** `DB_MS=0.5` and `DB_MS=10` in `ledger`. How does the money vanishing from the balance column change? Why does the "atomic row" design barely move with the DB's speed, while "read-write" does?

3. **The day boundary:** `reconcile` with `OFFSET_H=1` and `OFFSET_H=12`. How do the "same date" rule's false alerts change, and why does the ±1 day window work in both? In which situation is even ±1 day not enough?

4. **Changing code:** the README's experiment 5 (payouts). Then add a `checkInvariant()` to `src/payments.ts` that verifies Σ = 0 and that every transaction sums to zero, and run it at the end of `smoke`. Deliberately put in a bug (the fee share on a refund with the wrong sign) and show what the check says.

5. **The design part:** a "one-page design doc" for this payment system, in Lesson 1.2's five steps: (a) the requirements, with the PCI decision; (b) five numbers and one decision from each; (c) the state machine's picture, with the way out of every state; (d) the ledger's accounts and the entries for one payment, one refund and one payout; (e) the reconciliation design: which report, which key, which window, the kinds of mismatch and the owner of each.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Modules 1 – 10 (complete, with exit challenges), 11.1 – 11.6
Current: 11.7 — Case Study: Design a Payment System
TaskFlow state: kept as it was at the end of Module 10 (set aside in Module 11). Case study 1 — URL shortener; 2 — rate
limiter service; 3 — chat; 4 — news feed; 5 — notifications; 6 — video streaming. Case study 7 — payments: 10 million
payments a day ($300 million), ~1,200 a second on a sale (small load), 0.01% mistakes = $11 million a year (big
mistakes). Card data in the PSP's tokenization. Payment intent first (id = the PSP's reference + idempotency key),
`unknown` in the state machine; treating timeout = failed gives 4,060 double charges + 1,819 lost in 1 million; zero
with retries on a key + HMAC webhooks (raw body) + a recovery job; writing to the PSP first leaves 970 untraced at a
0.1% crash. Double-entry ledger (append-only, Σ = 0): a balance column loses 5.1 million cents in races and 36,000 in
crashes; lock only the debit on the hot merchant (37 s → 7 ms). Integer minor units + a written rounding rule (6,075
cents difference over 10 million). Reconciliation: payment id + ±1 day (by amount 100% hide; same date in UTC+6,
500,000 false alerts a day). Postgres primary + synchronous replica.
Terms learned (Module 11): Base62 Encoding, Keyspace, Birthday Bound, Range Allocation (Ticket Server),
Format-Preserving Permutation, 301 / 302 Redirect, Link Enumeration, Quota (vs Rate Limit), Hash Tag,
Approximate Sync, Token Lease, Key Splitting, Degraded Mode (Local Fallback Limit), Connection Gateway,
Session Registry, Congestion Collapse (Reconnect Storm), Store-then-Push (Inbox + Sync), Delivery Receipt,
Per-Conversation Sequence (Sequencer), Presence, Fan-out on Write (Push), Fan-out on Read (Pull),
Hybrid Fan-out, Timeline Cache, Tail Amplification, Hedged Request, Candidate Generation, Priority Tier,
Provider Throughput Limit, Pacing, Provider Failover, Aggregation Window (Collapse Key), Quiet Hours,
Device Token Lifecycle, Egress, Bitrate Ladder, Manifest (HLS / DASH), Segment-Parallel Transcoding,
Adaptive Bitrate (ABR), Rebuffer Ratio, Popularity-Tiered Encoding, Payment Service Provider (PSP),
Payment Intent, Unknown State, Double-Entry Ledger, Minor Units, Reconciliation, Settlement
Weak spots: [where you got stuck — write it yourself]
Next: Module 11 Exit Challenge
=======================
```

---

## 8. Next Step

Today's thread: **where every mistake is money, the design's job is not throughput but certainty at every edge.** Don't treat a timeout as a failure; give it a name (`unknown`) and keep three ways to finish it. Write your own record before the external work. Keep money not as a number but as a history of movements, so Σ = 0 catches every mistake. And after all of that, match against the external books at the end of the day, because something always slips through.

Module 11 ends here. Seven systems, each from scratch, in Lesson 1.2's five steps. And one habit came back in every one: numbers first, then tools; and the numbers often say which tool you **won't need** (11.1's sharding and Bloom filter, 11.4's average, 11.6's transcoding cost, today's throughput). When you are ready, write `next` — we go to the **Module 11 Exit Challenge**. There I'll give you a new system that needs pieces of several of this module's case studies together, and this time no script or numbers will be given in advance: from requirements to estimation, design and trade-offs, all yours, just like an interview.
