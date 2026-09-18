# Nginx Reverse Proxy + Load Balancer Demo

> Lesson 3.3 — Reverse Proxy vs Forward Proxy · **Tier 2 — Infra Setup**

## কী বানাচ্ছি

৩টা identical TypeScript/Express backend, আর তাদের সামনে Nginx reverse proxy + load
balancer — Round Robin আচরণ চোখে দেখার জন্য।

## Prerequisite

Docker এবং Docker Compose ইনস্টল থাকতে হবে।

## Setup

```bash
docker compose build
```

## Run

```bash
docker compose up
```

Nginx চলবে http://localhost:8080 এ।

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

**১. একই endpoint বারবার call করো — `servedBy` field বদলাতে থাকবে**

```bash
curl http://localhost:8080/api/tasks
curl http://localhost:8080/api/tasks
curl http://localhost:8080/api/tasks
curl http://localhost:8080/api/tasks
```

Expected: `servedBy` ঘুরে ঘুরে আসবে — `backend-1`, `backend-2`, `backend-3`, `backend-1`, ...
এটাই Round Robin এর প্রমাণ।

**২. Health check**

```bash
curl http://localhost:8080/health
```

Expected: `{"status":"ok","instance":"backend-X"}` (কোনো একটা instance)

## কী দেখার জন্য এটা বানানো

লক্ষ্য করো — তুমি কখনোই সরাসরি backend1/backend2/backend3 এর সাথে কথা বলছ না (তাদের কোনো
port ই host machine এ expose করা হয়নি), শুধু Nginx এর port 8080 এর সাথে কথা বলছ। এটাই
Reverse Proxy এর মূল কথা — backend topology client থেকে সম্পূর্ণ হিডেন।

## নিজে ভেঙে দেখো (Experiments)

1. `nginx.conf` এ `least_conn;` uncomment করে `docker compose restart nginx` করো। তারপর
   একটা backend এ ইচ্ছাকৃতভাবে delay যোগ করে (`server.ts` এ `setTimeout` সহ নতুন endpoint
   বানিয়ে) দেখো distribution কীভাবে বদলায়।
2. `ip_hash;` uncomment করে দেখো — বারবার call করলে কি সবসময় একই backend এ যাচ্ছে?
   (তোমার নিজের IP থেকে সব request আসছে বলে।)
3. একটা backend container বন্ধ করে দাও (`docker compose stop backend2`), তারপর কয়েকবার
   curl করো — কী হয়? Nginx কি সেটা এড়িয়ে যায়, নাকি error দেয়? এখানে একটা সীমাবদ্ধতা
   দেখবে: plain open-source Nginx নিজে থেকে **active health check** করে না by default।
   এটাই Lesson 3.4 এর বিষয়।

## Teardown

```bash
docker compose down -v
```

## Project Structure

```text
lesson-3.3-nginx-reverse-proxy/
├── docker-compose.yml
├── nginx.conf
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── server.ts
└── README.md
```

## Verification status

- Backend `server.ts` — `tsc --noEmit` clean pass (repo তে যাচাই করা)
- পুরো Docker Compose + Nginx integration — **সরাসরি চালিয়ে verify করা হয়নি** (এই
  environment এ Docker নেই)। তোমার মেশিনে চালিয়ে উপরের acceptance criteria মিলিয়ে দেখো।
