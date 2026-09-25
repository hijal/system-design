# Exercises

`course/main.md` §৬ অনুযায়ী প্রতিটা **Tier 1 (runnable code)** আর **Tier 2 (infra setup)**
exercise এখানে আলাদা, চালানোর মতো project হিসেবে থাকে — lesson এর ভেতরে code block
copy-paste করতে হয় না।

Tier 3 (design exercise) এখানে থাকে না — সেখানে চিন্তাটাই deliverable, code নেই।

| Exercise                                                             | Lesson                               | Tier | কী দেখায়                                  |
| -------------------------------------------------------------------- | ------------------------------------ | ---- | ------------------------------------------ |
| [`lesson-2.5-idempotency/`](lesson-2.5-idempotency/)                 | 2.5 — API Design at Scale            | 1    | Idempotency-Key দিয়ে retry-safe POST      |
| [`lesson-3.3-nginx-reverse-proxy/`](lesson-3.3-nginx-reverse-proxy/) | 3.3 — Reverse Proxy vs Forward Proxy | 2    | Nginx reverse proxy + Round Robin LB       |
| [`lesson-4.4-redis-cache/`](lesson-4.4-redis-cache/)                 | 4.4 — Redis Hands-on                 | 1    | Cache-Aside + invalidate-on-write, মাপা সহ |
| [`lesson-5.2-data-modeling/`](lesson-5.2-data-modeling/)             | 5.2 — Schema & Data Modeling         | 1    | Anomaly, denormalized counter, মাপা সহ     |

প্রতিটা folder এ নিজস্ব `README.md` আছে — setup, run, acceptance criteria, আর "নিজে ভেঙে
দেখো" experiment সহ।

## Code এর নিয়ম

`main.md` §১১ এর তিনটা hard rule এখানেও প্রযোজ্য:

1. সব code **TypeScript** এ, `strict: true`
2. **`any` একবারও না** — `unknown` + narrow, বা proper generic
3. প্রতি Tier 1 / Tier 2 exercise এ একটা `README.md`

তার সাথে প্রতিটা `tsconfig.json` এ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride` on থাকে।

## Typecheck

প্রতিটা TypeScript exercise আলাদাভাবে typecheck হয়:

```bash
cd lesson-2.5-idempotency && npm install && npm run typecheck
cd lesson-3.3-nginx-reverse-proxy/backend && npm install && npm run typecheck
cd lesson-4.4-redis-cache && npm install && npm run typecheck
cd lesson-5.2-data-modeling && npm install && npm run typecheck
```

এগুলো root SvelteKit app এর `bun run check` এর অংশ না — আলাদা project, আলাদা dependency।
