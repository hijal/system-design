---
title: Load Balancing
order: 1
summary: Traffic ke multiple server-e distribute kore ekta server overload howa thekay.
---

## Ki ebong keno

Load balancer ekta component ja incoming request ke multiple backend server-er
moddhe distribute kore, jate ekta single server-er upor beshi chap na pore.

## Common algorithms

- **Round robin** — request gula pöthomukhi order-e proti server-e ja
- **Least connections** — jei server-er active connection sobcheye kom, oita pay
- **IP hash** — client IP-r upor base kore consistent server select kora hoy

## Layer 4 vs Layer 7

- **L4 (transport layer)** — IP + port dekhe route kore, faster kintu content-aware na
- **L7 (application layer)** — HTTP header/URL dekhe route kore, smarter routing possible

## Notes

> Ei part ta tomar আসল notes diye replace kore dio.
