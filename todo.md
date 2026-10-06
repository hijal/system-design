# TODO — recall.hijal.dev audit

Audit date: 2026-10-05. Live site `https://recall.hijal.dev` এ চালানো হয়েছে — Chrome headless + axe-core (WCAG 2.1 AA + best-practice), desktop 1440px / mobile 375px / dark mode, ১২৬টা page এর link + anchor crawl, `curl` দিয়ে header আর route check।

যা ঠিক আছে: কোনো broken internal link, missing anchor, বা dead external link নেই (১২৬ page, ৩৪টা external link); কোনো console error নেই; mobile এ horizontal overflow নেই; static asset `immutable` cache + brotli পায়।

কোনো issue ঠিক হলে এখান থেকে মুছে `todo_done.md` এ সরানো হয়, সাথে Fix আর Tested অংশ যোগ করে।

## Format

```md
## SD-XX · ছোট শিরোনাম

- **Priority:** High | Medium | Low
- **Category:** Accessibility | SEO | Security | UX | Performance | Bug
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

Round 2 এর ১১টাই ঠিক হয়ে `todo_done.md` এ গেছে।

## Round 3 — বাইরের audit report যাচাই (2026-10-05)

একটা বাইরের audit report এর প্রতিটা দাবি live site এ মিলিয়ে দেখা হয়েছে, সাথে নিজের কিছু নতুন check (সব focusable element এর focus ring, placeholder contrast pixel মেপে, ৩২০px reflow, WCAG text-spacing, forced-colors, reduced motion)। যেসব আগে থেকেই ঠিক আছে বা report এর দাবি ভুল, সেগুলো এখানে নেই — শুধু আসল ঘাটতি। Round 4 এর ১৫টাই ঠিক হয়ে `todo_done.md` এ গেছে।

Round 3 এর ৩টাই ঠিক হয়ে `todo_done.md` এ গেছে।

## Round 4 — action, form আর edge case audit (2026-10-05)

Live site এ (commit `3238959` deploy হওয়ার পরে) চালানো হয়েছে। এবার নজর ছিল আগের round গুলো যেসব অবস্থা ছোঁয়নি সেগুলোতে: progress থাকা অবস্থা (sidebar এ ✓, homepage progress strip), একাধিক tab, English edition এর "Coming soon" lesson, "আরও উপায়ে পড়ো" menu, mobile TOC, search এর edge case (১ অক্ষর, ৫০০০ অক্ষর, `<script>`, বাংলা query, Tab/Escape), theme toggle + reload, language switch, Markdown/code copy, `.md` route, alias route, HTTP method, HTTP→HTTPS, Cloudflare edge cache আর cookie এর আচরণ। Tool: Playwright (Chromium) + axe-core 4.13 (WCAG 2.2 AA + best-practice), `curl`, sitemap এর ১৪৪টা URL crawl।

যা ঠিক আছে: ১০টা interactive অবস্থায় axe ০ violation (light/dark, desktop/mobile); নতুন strict CSP (`style-src 'self'`) এ কোনো CSP violation বা console error নেই (search → result → copy → mark complete → next → back → language switch পুরো flow দুই viewport এ); ৪৫টা external link এর সবগুলো চলে; `POST`/`PUT`/`DELETE` → ৪০৫, ৫০০ না; search এ `<script>` query নিরাপদ (JSON + Svelte text); Markdown copy আর code copy clipboard এ ঠিক জিনিস দেয়; theme reload এর পরেও থাকে; sticky header কোনো focused content ঢাকে না; HTML page Cloudflare edge এ cache হয় না।

ইচ্ছা করে বাদ: ৭০ এর বেশি অক্ষরের ১৬টা `<title>` (SD-09 এ content এর সিদ্ধান্ত হিসেবে রাখা); bn/en challenge page এর একই title (এগুলো hreflang জোড়া); বাংলা অক্ষরে "ক্যাশ" search এ ০ result (content এ term গুলো English এ লেখা, তাই এটা bug না); language switch এ `#section` hash হারানো (দুই edition এর heading id আলাদা, তাই hash রাখা যায় না)।

Round 4 এর ১৫টাই ঠিক হয়ে `todo_done.md` এ গেছে।

## Round 5 — Module 12 এর নতুন page audit (2026-10-06)

Live site এ (commit `f28cdfa` deploy হওয়ার পরে) চালানো হয়েছে। নজর ছিল Round 4 এর পরে যোগ হওয়া জিনিসে: Module 12 এর ১৪টা page (৬টা lesson আর exit challenge, bn + en), দুটো নতুন exercise, আর mock interview এর একটার ভেতরে আরেকটা `<details>` (push-back)। Tool: Playwright (Chromium) + axe-core (WCAG 2.2 AA + best-practice), Node `fetch` দিয়ে sitemap এর ১৬৬টা URL crawl, `curl`।

যা ঠিক আছে: ১৬৬টা page এর সবগুলো 200; ৪,৩৫৪টা internal link আর ২,৬১০টা anchor এর একটাও ভাঙা না; chatgpt.com আর claude.ai এর link বাদে সব external link চলে, দুটো নতুন exercise এর GitHub link সহ; Module 12 এর ১৪টা page × চার অবস্থা (desktop light, desktop dark, mobile 375, mobile 320) = ৫৬টায় axe ০ violation, সব `<details>` খোলা অবস্থায় (12.4 এ ১৩টা, ভেতরের push-back সহ); horizontal overflow ০ (চওড়া table আর code block নিজের ভেতরে scroll করে, page না); heading level skip ০, duplicate id ০; console error বা CSP violation ০; sitemap, `llms.txt` আর `.md` route এ Module 12 আছে; সব page এর `<title>` ঠিক (en এর title `i18n.ts` থেকে); কোনো edition এ আর "Coming soon" নেই; search এ নতুন term (Scaling Trigger, Conflicted Copy, Story Bank, Estimation Chain) দুই ভাষায় ঠিক lesson দেয়।

ইচ্ছা করে বাদ: chatgpt.com আর claude.ai এর "lesson নিয়ে প্রশ্ন করো" link এ ৪০৩ (bot আটকায়, browser এ খোলে — broken link না)।

## SD-46 · Search এ যে lesson একটা term এর সংজ্ঞা দেয়, সেটা শুধু উল্লেখ করা lesson গুলোর পরে আসে

- **Priority:** Low
- **Category:** UX
- **Where:** `src/lib/server/course/search.ts` — `search()` এর ক্রম
- **Found by:** `curl /search?lang=en&q=Sorted%20Set`: ফল ৫.১, ৭.৩, ৯.৫, ১১.৪, তারপর ১২.৩। "Sorted Set" এর glossary এর সংজ্ঞা শুধু ১২.৩ এ (`| **Sorted Set** |`); বাকিগুলোয় এক লাইনে উল্লেখ। একই আচরণ পুরো course জুড়ে, যেকোনো term এ যা আগের lesson এ নাম হিসেবে আসে আর পরে define হয়: `Lost Update` এ প্রথম ফল ৫.২, সংজ্ঞা ৫.৫ এ; `Hot Partition` এ প্রথম ফল ৫.৭, সংজ্ঞা ৫.৮ এ।
- **Problem:** এখনকার নিয়ম: title এ মিললে আগে, বাকি সব curriculum এর ক্রমে। তাই একজন learner যে একটা term এর মানে খুঁজছে, সে প্রথমে এমন lesson পায় যেখানে term টা শুধু পাশ দিয়ে গেছে, আর আসল ব্যাখ্যা তালিকার শেষে। ২০টার বেশি ফলের term এ সংজ্ঞাটা প্রথম পাতায় না-ও আসতে পারে।
- **Expected:** তিন স্তরের ক্রম: title এ মিল → যে lesson এর glossary table এ term টা define করা (`| **<term>** |`, বা বড় অংশের মিল) → বাকিগুলো curriculum এর ক্রমে। প্রতিটা স্তরের ভেতরে curriculum এর ক্রম আগের মতো।
- **How to test:** `search.spec.ts` এ একটা test: একটা lesson এ term টা শুধু উল্লেখ, পরের lesson এর glossary তে সংজ্ঞা → সংজ্ঞার lesson আগে। Live এ `q=Sorted Set` → প্রথম ফল ১২.৩ (এখন ৫.১), `q=Lost Update` → ৫.৫ (এখন ৫.২), `q=Hot Partition` → ৫.৮ (এখন ৫.৭)।
