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

এই মুহূর্তে কোনো open issue নেই — ১৬টাই `todo_done.md` এ (১৫টা fixed, SD-14 তদন্তের পর won't fix)।
