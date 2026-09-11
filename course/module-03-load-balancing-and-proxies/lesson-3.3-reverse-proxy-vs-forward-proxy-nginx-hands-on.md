# Lesson 3.3 — Reverse Proxy vs Forward Proxy, Nginx Hands-on

**Module 3 — Load Balancing & Proxies**

**Prerequisite:** Lesson 3.1 (Load Balancer, L4/L7), Lesson 3.2 (LB Algorithms)

**তুমি এই lesson শেষে পারবে:**

1. Forward Proxy আর Reverse Proxy এর মূল পার্থক্য (কে "লুকিয়ে" আছে — client নাকি server) ব্যাখ্যা করতে পারবে
2. বুঝবে কেন Load Balancer আসলে একটা বিশেষ ধরনের Reverse Proxy
3. Nginx দিয়ে একটা কাজ-করা reverse proxy + load balancer setup করতে পারবে, এবং Round Robin আচরণ নিজের চোখে verify করতে পারবে

**Tier:** 2 — Infra Setup (Docker Compose + Nginx config + TypeScript backend)

---

## ০. TaskFlow এখন কোথায়

Lesson 3.1-3.2 এ আমরা load balancer এর তত্ত্ব শিখেছি — L4/L7, Round Robin, Least Connections। আজকে সময় এসেছে এটা **সত্যিই বানানোর** — Nginx দিয়ে, তোমার নিজের মেশিনে চলা একটা বাস্তব multi-container setup।

কিন্তু তার আগে একটা concept পরিষ্কার করা দরকার — "Proxy" শব্দটা তুমি "Load Balancer" এর সমার্থক হিসেবে ব্যবহার করে আসছ এতদিন, কিন্তু আসলে Proxy একটা বৃহত্তর concept, আর এর দুটো সম্পূর্ণ ভিন্ন ধরন আছে — একটা client কে রক্ষা করে, আরেকটা server কে। আজকের lesson এই পার্থক্যটা দিয়ে শুরু হবে।

---

## ১. Theory

### ১.১ Forward Proxy — Client এর প্রতিনিধি

**Forward Proxy** client আর internet এর মাঝে বসে, এবং **client এর হয়ে** request পাঠায়। Server (যেটার সাথে communicate করা হচ্ছে) কখনো real client কে দেখে না — সে শুধু proxy কে দেখে।

```
[Client] ──> [Forward Proxy] ──> [Internet / Target Server]

Server এর দৃষ্টিকোণ থেকে: "একটা request এসেছে, কিন্তু কার থেকে
আসল client, নাকি proxy - সেটা জানি না" (client identity hidden)
```

**বাস্তব উদাহরণ:** office এর corporate proxy (সব employee এর traffic একটা central proxy দিয়ে যায়, company সেটা monitor/filter করতে পারে), অথবা VPN (তোমার real IP hide করে, server শুধু VPN এর IP দেখে)।

### ১.২ Reverse Proxy — Server এর প্রতিনিধি

**Reverse Proxy** client আর server(s) এর মাঝে বসে, কিন্তু এবার উল্টো দিকে কাজ করে — এটা **server এর হয়ে** request receive করে। Client কখনো জানে না backend এ আসলে কয়টা server আছে, কোনটা — সে শুধু proxy কে দেখে।

```
[Client] ──> [Reverse Proxy] ──> [Server 1 / Server 2 / Server 3]

Client এর দৃষ্টিকোণ থেকে: "একটাই server আছে বলে মনে হচ্ছে"
(backend topology hidden)
```

**এখানেই সেই connection যেটা তুমি আশা করছিলে** — Lesson 3.1-3.2 এ যে "Load Balancer" নিয়ে আমরা কথা বলেছি, সেটা আসলে **একটা বিশেষ ধরনের Reverse Proxy** — যার কাজ শুধু "server কে হাইড করা" না, বরং একাধিক server এর মধ্যে **intelligently traffic ভাগ করাও**।

> **Trade-off Table — Forward vs Reverse Proxy**

| দিক                         | Forward Proxy                       | Reverse Proxy                                      |
| --------------------------- | ----------------------------------- | -------------------------------------------------- |
| কাকে রক্ষা/প্রতিনিধিত্ব করে | Client                              | Server                                             |
| কে "hidden" থাকে            | Client, server এর কাছে              | Server(s), client এর কাছে                          |
| সাধারণ ব্যবহার              | Corporate filtering, VPN, anonymity | Load balancing, caching, SSL termination, security |
| কার infrastructure এ বসে    | সাধারণত client এর network এ         | সাধারণত server এর infrastructure এ                 |

**একটা সহজ মনে রাখার উপায়:** Forward Proxy তোমার (client এর) _পক্ষ_ নেয় internet এর বিরুদ্ধে। Reverse Proxy server এর _পক্ষ_ নেয় client দের বিরুদ্ধে (protective অর্থে, adversarial না)। "Forward" মানে তুমি client হিসেবে সামনের দিকে proxy ব্যবহার করছ; "Reverse" মানে flow টা উল্টো দিক থেকে (server দিকে থেকে) সেট আপ করা।

### ১.৩ Reverse Proxy এর বাড়তি কাজ — শুধু Load Balancing না

একটা Reverse Proxy (যেমন Nginx) শুধু traffic ভাগ করা ছাড়াও আরও অনেক কাজ করে, যেগুলো তোমার এখন পর্যন্ত শেখা concept গুলোর সাথে সরাসরি যুক্ত:

- **SSL/TLS Termination** (Lesson 3.1) — client-facing HTTPS handle করে, backend এর সাথে সাধারণ HTTP এ কথা বলে
- **Static file serving** — CSS/JS/images সরাসরি Nginx থেকে সার্ভ করা, Express server কে এই কাজ থেকে মুক্ত রাখা
- **Content-based routing** (L7, Lesson 3.1) — `/api/*` এক জায়গায়, `/assets/*` আরেক জায়গায়
- **Caching** — বারবার একই response backend থেকে না এনে, প্রথমবারের response টা কিছুক্ষণ মনে রেখে সরাসরি সেটা দিয়ে দেওয়া (Module 4 তে বিস্তারিত)

---

## ২. Interview Angle

একটা common conceptual প্রশ্ন — "Load Balancer আর Reverse Proxy এক জিনিস কিনা?" ভালো উত্তর: **সব Load Balancer একটা Reverse Proxy, কিন্তু সব Reverse Proxy Load Balancer না।** Nginx কে শুধু একটা backend server এর সামনে (SSL termination বা static file serving এর জন্য) বসানো হলে সেটা একটা Reverse Proxy, কিন্তু Load Balancer না (কারণ ভাগ করার মতো একাধিক backend নেই)। যখনই একাধিক backend এর মধ্যে traffic ভাগ করার logic যোগ হয়, তখনই সেটা "Load Balancer" ও বটে।

---

## ৩. Key Takeaway

- Forward Proxy client কে representer করে (client hidden, server এর কাছে) — corporate filtering, VPN
- Reverse Proxy server(s) কে representer করে (server topology hidden, client এর কাছে) — load balancing, SSL termination, caching
- Load Balancer আসলে একটা বিশেষায়িত Reverse Proxy
- Nginx একটা multi-purpose reverse proxy — load balancing, SSL termination, static serving, content-based routing — সবকিছু একসাথে করতে পারে

---

## ৪. নতুন Term (Glossary)

| Term              | অর্থ                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| **Forward Proxy** | client এর পক্ষে internet এ request পাঠানো proxy, client identity hide করে         |
| **Reverse Proxy** | server এর পক্ষে client এর request receive করা proxy, backend topology hide করে    |
| **Upstream**      | Nginx এর পরিভাষায়, backend server pool কে বোঝানো একটা block (`upstream { ... }`) |

---

## ৫. Reflection Questions

1. একটা company তাদের employee দের social media access বন্ধ করতে চায় office network এ — এটা কি Forward নাকি Reverse Proxy এর কাজ?
2. TaskFlow এর Nginx setup এ, যদি শুধু ১টা backend server থাকে (horizontal scaling এখনো না হয়ে থাকলে), তাহলে কি Nginx বসানোর কোনো মানে আছে? কেন (SSL termination, static serving এর কথা চিন্তা করো)?

<details>
<summary><strong>Answer Key</strong></summary>

**প্রশ্ন ১:** এটা **Forward Proxy** এর কাজ — company তাদের নিজেদের employee দের (client) internet access নিয়ন্ত্রণ করছে, filter করছে কোথায় যেতে পারবে না — client এর পক্ষ থেকে (client এর ট্রাফিক নিয়ন্ত্রণ) কাজ করা হচ্ছে, কোনো backend server কে protect করা হচ্ছে না।

**প্রশ্ন ২:** হ্যাঁ, এখনও মানে আছে — এমনকি একটা মাত্র backend থাকলেও, Nginx SSL/TLS termination (Express কে HTTPS handle করতে হয় না), static file serving (Express থেকে এই কাজ সরিয়ে নেওয়া, performance ভালো), এবং future-proofing (ভবিষ্যতে easily আরও backend যোগ করা যায়, কোনো architecture পরিবর্তন ছাড়াই) — এই সুবিধাগুলো দেয়। তাই "Reverse Proxy = শুধু Load Balancer" এই ধারণাটা ভুল, single-backend এও এটার আলাদা মূল্য আছে।

</details>

---

## ৬. Practical Exercise

**Tier 2 — Infra Setup**

আমরা ৩টা identical TypeScript/Express backend instance বানাব, আর তাদের সামনে Nginx বসাব reverse proxy + load balancer হিসেবে। Backend এর TypeScript অংশ sandbox এ `tsc --noEmit` দিয়ে verify করা হয়েছে (clean pass)। কিন্তু পুরো Docker Compose + Nginx integration টা এই sandbox এ Docker না থাকায় সরাসরি চালিয়ে verify করিনি — **সততার সাথে বলছি, এটা তোমার নিজের মেশিনে চালিয়ে দেখতে হবে।**

**Project Structure:**

```
nginx-exercise/
├── docker-compose.yml
├── nginx.conf
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── server.ts
└── README.md
```

**`backend/package.json`:**

```json
{
	"name": "taskflow-backend-demo",
	"version": "1.0.0",
	"private": true,
	"type": "commonjs",
	"scripts": {
		"build": "tsc",
		"typecheck": "tsc --noEmit",
		"start": "node dist/server.js"
	},
	"dependencies": {
		"express": "^4.21.2"
	},
	"devDependencies": {
		"@types/express": "^4.17.21",
		"@types/node": "^22.10.2",
		"typescript": "^5.7.2"
	}
}
```

**`backend/tsconfig.json`:**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "commonjs",
		"moduleResolution": "node",
		"lib": ["ES2022"],
		"outDir": "dist",
		"rootDir": ".",
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"exactOptionalPropertyTypes": true,
		"noImplicitOverride": true,
		"noUnusedLocals": true,
		"noUnusedParameters": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true
	},
	"include": ["server.ts"]
}
```

**`backend/server.ts`** (verified — `tsc --noEmit` clean):

```typescript
import express, { type Request, type Response } from 'express';

interface Task {
	id: number;
	title: string;
}

interface TaskListResponse {
	tasks: Task[];
	servedBy: string;
}

interface HealthResponse {
	status: 'ok';
	instance: string;
}

// Docker Compose থেকে environment variable দিয়ে প্রতিটা instance কে
// একটা নাম দেওয়া হবে, যাতে আমরা দেখতে পারি Nginx কোন instance এ
// request পাঠাচ্ছে (Round Robin verify করার জন্য এটাই key trick)
const INSTANCE_ID: string = process.env.INSTANCE_ID ?? 'unknown-instance';

const tasks: Task[] = [
	{ id: 1, title: 'Fix login bug' },
	{ id: 2, title: 'Write Q3 report' }
];

const app = express();

app.get('/api/tasks', (_req: Request, res: Response<TaskListResponse>): void => {
	res.status(200).json({ tasks, servedBy: INSTANCE_ID });
});

app.get('/health', (_req: Request, res: Response<HealthResponse>): void => {
	res.status(200).json({ status: 'ok', instance: INSTANCE_ID });
});

const PORT = 3000;
app.listen(PORT, (): void => {
	console.log(`Backend instance "${INSTANCE_ID}" listening on port ${PORT}`);
});
```

**`backend/Dockerfile`:**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY server.ts ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

_(Node 24 ব্যবহার করা হয়েছে কারণ এটা ২০২৬ এর current Active LTS version।)_

**`nginx.conf`:**

```nginx
events {}

http {
    upstream taskflow_backend {
        # Default algorithm Round Robin (Lesson 3.2) — কিছু specify না করলে এটাই হয়

        server backend1:3000;
        server backend2:3000;
        server backend3:3000;

        # Experiment এর জন্য — নিচের লাইনগুলো uncomment করে দেখো:
        # least_conn;   # Least Connections algorithm
        # ip_hash;      # Session Affinity (IP Hash)
    }

    server {
        listen 80;

        location /api/ {
            proxy_pass http://taskflow_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        location /health {
            proxy_pass http://taskflow_backend;
        }
    }
}
```

**`docker-compose.yml`:**

```yaml
services:
  backend1:
    build: ./backend
    environment:
      - INSTANCE_ID=backend-1

  backend2:
    build: ./backend
    environment:
      - INSTANCE_ID=backend-2

  backend3:
    build: ./backend
    environment:
      - INSTANCE_ID=backend-3

  nginx:
    image: nginx:stable-alpine
    ports:
      - '8080:80'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - backend1
      - backend2
      - backend3
```

**`README.md`:**

```markdown
# Nginx Reverse Proxy + Load Balancer Demo

## কী বানাচ্ছি

৩টা identical TypeScript/Express backend, আর তাদের সামনে Nginx reverse
proxy + load balancer — Round Robin আচরণ চোখে দেখার জন্য।

## Prerequisite

Docker এবং Docker Compose ইনস্টল থাকতে হবে।

## Setup

docker compose build

## Run

docker compose up

# Nginx চলবে http://localhost:8080 এ

## কীভাবে বুঝবো কাজ করছে (Acceptance Criteria)

# একই endpoint বারবার call করো, "servedBy" field বদলাতে থাকবে

curl http://localhost:8080/api/tasks
curl http://localhost:8080/api/tasks
curl http://localhost:8080/api/tasks
curl http://localhost:8080/api/tasks

# Expected: servedBy ঘুরে ঘুরে আসবে: backend-1, backend-2, backend-3,

# backend-1, ... (Round Robin এর প্রমাণ)

curl http://localhost:8080/health

# Expected: {"status":"ok","instance":"backend-X"} (কোনো একটা instance)

## কী দেখার জন্য এটা বানানো

লক্ষ্য করো — তুমি কখনোই সরাসরি backend1/backend2/backend3 এর সাথে কথা
বলছ না (তাদের কোনো port ই host machine এ expose করা হয়নি) — শুধু Nginx
এর port 8080 এর সাথে কথা বলছ। এটাই Reverse Proxy এর মূল কথা — backend
topology client থেকে সম্পূর্ণ হিডেন।

## নিজে ভেঙে দেখো (Experiments)

1. nginx.conf এ `least_conn;` uncomment করে `docker compose restart nginx`
   করো। তারপর একটা backend এ ইচ্ছাকৃতভাবে delay যোগ করে (server.ts এ
   একটা setTimeout সহ নতুন endpoint বানিয়ে) দেখো distribution কীভাবে বদলায়।
2. `ip_hash;` uncomment করে দেখো — বারবার call করলে কি সবসময় একই
   backend এ যাচ্ছে? (তোমার নিজের IP থেকে সব request আসছে বলে)
3. একটা backend container বন্ধ করে দাও (`docker compose stop backend2`),
   তারপর কয়েকবার curl করো — কী হয়? Nginx কি সেটা এড়িয়ে যায়, নাকি error
   দেয়? (এখানে একটা সীমাবদ্ধতা দেখবে — plain open-source Nginx নিজে থেকে
   "active health check" করে না by default, এটাই Lesson 3.4 এর বিষয়)

## Teardown

docker compose down -v
```

**Verification status:**

- Backend `server.ts` — sandbox এ `tsc --noEmit` দিয়ে যাচাই করা হয়েছে, clean pass (কোনো type error নেই)
- পুরো Docker Compose + Nginx integration — **এই sandbox এ Docker না থাকায় সরাসরি চালিয়ে verify করা হয়নি।** তোমার মেশিনে চালিয়ে উপরের acceptance criteria মিলিয়ে দেখো।

---

## ৭. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (সম্পূর্ণ) + Module 2 (সম্পূর্ণ), 3.1, 3.2
Current: 3.3 — Reverse/Forward Proxy, Nginx Hands-on
TaskFlow state: multi-instance architecture এখন conceptually + practically (Docker demo)
প্রতিষ্ঠিত — Nginx reverse proxy + Round Robin LB সামনে
Terms learned (Module 3 so far): Load Balancer, L4/L7, SSL Termination,
Content-based Routing, Round Robin, Weighted Round Robin, Least Connections,
Session Affinity, IP Hash, Consistent Hashing (intro), Forward Proxy, Reverse Proxy,
Upstream (Nginx term)
Weak spots: সঠিক উত্তরে পৌঁছেও ভুল/অপ্রাসঙ্গিক কারণ (3.1); arithmetic/communication
clarity ছোট গ্যাপ (3.2 Q2) — তবে conceptual depth এবং proactive connection-making
(3.2 Q3) ক্রমাগত ভালো হচ্ছে
First Tier 2 exercise completed: Nginx reverse proxy + load balancer, Docker Compose,
TypeScript backend (TS অংশ verified, full integration self-verify করতে হবে)
Next: 3.4 — Health Check, Failover, Sticky Session, Graceful Shutdown
=======================
```

---

## ৮. পরের ধাপ

Docker Compose টা নিজের মেশিনে চালিয়ে দেখো, বিশেষ করে experiment #৩ (backend বন্ধ করলে কী হয়) — এটা পরের lesson এর জন্য একটা perfect setup। রেডি হলে `next` লিখো — Lesson 3.4, Health Check, Failover, Sticky Session, Graceful Shutdown — এখানে ঠিক সেই সমস্যাটার সমাধান আসবে যেটা experiment #৩ এ তুমি দেখবে।
