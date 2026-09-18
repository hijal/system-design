# Idempotency Key Demo — TaskFlow Task Creation

> Lesson 2.5 — API Design at Scale · **Tier 1 — Runnable Code**

## কী বানাচ্ছি

একটা Express + TypeScript endpoint যেটা `Idempotency-Key` header দিয়ে duplicate task creation
প্রতিরোধ করে — network retry হলেও একই task দুইবার তৈরি হবে না।

## Prerequisite

Node.js 18+ (`crypto.randomUUID` এর জন্য), npm। Docker লাগবে না।

## Setup

```bash
npm install
```

## Run

```bash
npm run build && npm start

# অথবা dev mode এ:
npm run dev
```

Server চলবে http://localhost:3000 এ।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. Idempotency-Key ছাড়া request → 400**

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test"}'
```

Expected: `{"error":{"code":"MISSING_IDEMPOTENCY_KEY",...}}`, status 400

**২. একই key দিয়ে দুইবার request**

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-1" \
  -d '{"title":"Fix bug"}'
```

ঠিক একই command আবার চালাও (একই key)। Expected: দুইবারই ঠিক একই `id` ফেরত আসবে।

**৩. Duplicate তৈরি হয়নি — verify**

```bash
curl http://localhost:3000/api/tasks
```

Expected: `count` হবে `1`, দুইটা POST call সত্ত্বেও (কারণ দ্বিতীয়টা ছিল retry)।

## কী দেখার জন্য এটা বানানো

লক্ষ্য করো — একই `Idempotency-Key` দিয়ে দুইবার POST করলেও response এর `id` field ঠিক একই
থাকে, আর `GET /api/tasks` এ শুধু ১টা task দেখাবে, ২টা না।

## নিজে ভেঙে দেখো (Experiments)

1. একই key দিয়ে কিন্তু **ভিন্ন body** (ভিন্ন title) পাঠিয়ে দেখো কী হয় — এই code টা এখন body
   বদলে গেলেও পুরনো cached result-ই ফেরত দেয়। এটা কি ঠিক আচরণ? (Stripe এর মতো real-world
   system এখানে `409 Conflict` দেয় যদি একই key তে ভিন্ন body আসে — এই code এ সেটা যোগ
   করার চেষ্টা করো।)
2. `idempotencyStore` তে একটা TTL/expiry যোগ করার চেষ্টা করো।
3. Server বন্ধ করে আবার চালাও — সব idempotency record হারিয়ে যায় কেন? এটাই in-memory
   storage এর সীমাবদ্ধতা। Module 4.4 এর পরে এটা Redis এ থাকা উচিত, কারণ (ক) restart এ
   data হারায় না, (খ) horizontal scaling এ একাধিক server এর মধ্যে state শেয়ার হয়।

## Project Structure

```text
lesson-2.5-idempotency/
├── package.json
├── tsconfig.json
├── server.ts       # সব logic এখানে (এই exercise এর scope এ single file)
└── README.md
```
