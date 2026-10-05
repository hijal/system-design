# TODO — recall.hijal.dev audit

Audit date: 2026-10-05. Live site `https://recall.hijal.dev` এ চালানো হয়েছে — Chrome headless + axe-core (WCAG 2.1 AA + best-practice), desktop 1440px / mobile 375px / dark mode, ১২৬টা page এর link + anchor crawl, `curl` দিয়ে header আর route check।

যা ঠিক আছে: কোনো broken internal link, missing anchor, বা dead external link নেই (১২৬ page, ৩৪টা external link); কোনো console error নেই; mobile এ horizontal overflow নেই; static asset `immutable` cache + brotli পায়।

কোনো issue ঠিক হলে এখান থেকে মুছে `todo_done.md` এ সরানো হয়, সাথে Fix আর Tested অংশ যোগ করে।

## Format

```md
## SD-XX · ছোট শিরোনাম

- **Priority:** High | Medium | Low
- **Category:** Accessibility | SEO | Security | UX | Performance
- **Where:** URL / file
- **Found by:** কোন tool বা check
- **Problem:** কী ভুল, কার উপর প্রভাব
- **Expected:** ঠিক হলে কেমন হবে
- **How to test:** কীভাবে verify করা হবে
```

---

## Round 2 — deep audit (2026-10-05)

Round 1 এর ১৬টা issue বাদে। Local production build (`wrangler dev`) এ চালানো হয়েছে, কারণ live site এ তখনো round 1 deploy হয়নি। যা দেখা হয়েছে: interactive অবস্থায় axe (সব sidebar module খোলা, mobile nav খোলা, search খোলা, TOC/menu/answer-key `<details>` খোলা, light + dark, WCAG 2.2 AA সহ), keyboard/focus flow, Lighthouse, font loading, CLS/LCP, print, nested route, cache header, ১৪২টা lesson এর heading structure, duplicate id, code highlighting।

যা ঠিক আছে: Lighthouse (`/lesson-5.4`) — Performance ৯৮, Accessibility ১০০, Best Practices ১০০, SEO ১০০; heading level skip ০, duplicate id ০; সব code fence language এর Prism grammar আছে; CLS ০.০১৪ এর নিচে; skip link কাজ করে; deep link এ heading sticky header এর নিচে লুকায় না।

Round 2 এর ১১টাই ঠিক হয়ে `todo_done.md` এ গেছে — এই মুহূর্তে কোনো open issue নেই।
