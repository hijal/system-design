---
title: Caching
order: 2
summary: Baar baar compute/fetch na kore result store kore rakha, jate response fast hoy.
---

## Ki ebong keno

Cache holo ekta fast-access temporary storage layer, jekhane frequently
accessed data rakha hoy jate database/backend-e baar baar hit na jete hoy.

## Common strategies

- **Cache-aside** — app nijei cache check kore, miss hole DB theke niye cache-e likhe
- **Write-through** — write hobar shomoy shathe shathe cache update hoy
- **Write-back** — write cache-e hoy, DB te async likha hoy pore

## Eviction policy

- **LRU** — jei ta sobcheye kom recently use hoyeche, oita age remove hoy
- **LFU** — jei ta sobcheye kom frequently use hoyeche, oita age remove hoy
- **TTL** — ekta shomoy pore automatically expire hoye jay

## Notes

> Ei part ta tomar আসল notes diye replace kore dio.
