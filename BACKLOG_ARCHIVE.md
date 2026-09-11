# Backlog Archive

`BACKLOG.md`-এ যা ছিল তার মধ্যে যেগুলো এখন ঠিক হয়ে গেছে বা বানানো হয়ে গেছে, সেগুলো এখানে সরিয়ে আনা হয়েছে — প্রতিটার পাশে ঠিক কী করা হয়েছে সেটাও লেখা আছে।

## Issues — সব Fixed

### 1. English locale-এ পুরো curriculum "Coming soon" দেখাত

**Fix:** `catalog.ts`-এর `otherAvailable` field ব্যবহার করে `(docs)/+page.svelte`-এ overview summary আর প্রতিটা module card-এ honest badge দেখানো হচ্ছে — কোনো module-এ EN content না থাকলেও bn-এ থাকলে "X in Bangla" (`t.readyOther`) অথবা top summary-তে "X more available in Bangla" (`t.availableOtherCount`) দেখায়, প্লেইন "Coming soon" এর বদলে।

### 2. বাংলা mode-এও sidebar-এ lesson title ইংরেজিতে দেখাত

**Fix:** `(docs)/+layout.svelte`-এ `englishTitles` lookup আর lesson-1.1 special-case বাদ দিয়ে সরাসরি locale-aware `lesson.title.split(' — ')[0]` ব্যবহার করা হয়েছে — যেহেতু `catalog.ts`-এর `entry()` ফাংশন প্রতিটা locale-এর জন্য title আগে থেকেই সঠিকভাবে resolve করে রাখে, sidebar-এ সেটা আর নিজে থেকে override করার দরকার ছিল না।

### 3 & 4. Mobile-এ table আর code block চুপচাপ কেটে (clip) যেত

**Fix:** `layout.css`-এ `.doc-content table` আর `.doc-content pre`-তে scroll-shadow affordance যোগ করা হয়েছে (classic 4-layer background-gradient trick — cover gradient + radial shadow hint, `background-attachment: local/scroll` দিয়ে)। এখন horizontally scrollable content-এর ডান/বাম কিনারায় হালকা shadow দেখা যায়, বোঝা যায় আরও content আছে।

### 5. Dark mode একদমই ছিল না

**Fix:** পুরো `layout.css`-এর ~১৫০টা hardcoded hex color কে ছোট একটা semantic token সেটে (`--ink`, `--heading`, `--muted`, `--line`, `--green`, `--green-dark`, `--green-soft`, `--bg`, `--surface`, `--surface-2` ইত্যাদি) consolidate করা হয়েছে, তারপর `@media (prefers-color-scheme: dark)` + `[data-theme="dark"]` override ব্লক যোগ করা হয়েছে। Topbar-এ moon/sun টগল বাটন (`toggleTheme`), localStorage-এ পছন্দ persist হয়, আর `app.html`-এ inline init script দিয়ে flash-of-wrong-theme আটকানো হয়েছে। সাথে সাথে দুটো near-duplicate palette (green-tinted আর blue-tinted reader-page override) এক পাল্টে unify করা হয়েছে — এখন পুরো সাইট একটাই সামঞ্জস্যপূর্ণ ভাষায় কথা বলে। কোড ব্লকের fixed dark terminal-style ইচ্ছাকৃতভাবে অপরিবর্তিত রাখা হয়েছে (দুই থিমেই একইরকম দেখানোর জন্য)।

### 6. Mobile-এ কিছু tap target ছোট ছিল

**Fix:** `.language-switch a`, `.copy-markdown`, নতুন `.mark-complete`/`.ai-actions summary` বাটনের mobile padding বাড়ানো হয়েছে (`@media (width<=560px)` ব্লকে) — আগে height ~27-31px ছিল, এখন ~34-38px।

### 7. `/demo` route production-এ খোলা ছিল

**Fix:** `src/routes/demo/` পুরো ফোল্ডার মুছে ফেলা হয়েছে — production build/route list-এ আর নেই (build output দিয়ে যাচাই করা হয়েছে)।

### 8. Search dropdown বাইরে ক্লিক করে বন্ধ করা যেত না

**Fix:** `(docs)/+layout.svelte`-এ `svelte:window onclick={closeSearchOutside}` হ্যান্ডলার যোগ করা হয়েছে — search-wrap-এর বাইরে ক্লিক করলে query খালি হয়ে dropdown বন্ধ হয়ে যায় (Playwright দিয়ে verify করা হয়েছে)।

## Feature Ideas — সব Implemented

### F1. Full-text search

**Built:** নতুন `src/routes/search/+server.ts` endpoint — build-এ একবার প্রতিটা lesson-এর plain-text (markdown স্ট্রিপ করে) index বানিয়ে রাখে, request-এ id+title+body মিলিয়ে match করে snippet-সহ ফলাফল দেয়। Topbar সার্চ এখন ১৮০ms debounce দিয়ে এই endpoint কল করে, শুধু title/id না, পুরো lesson content সার্চ করে।

### F2. Progress tracking + "resume where you left off"

**Built:** নতুন `src/lib/docs/progress.svelte.ts` (Svelte 5 rune-based reactive store, `SvelteSet` + localStorage persist) — প্রতি lesson page visit করলে "last visited" আপডেট হয়, lesson page-এ "সম্পন্ন হিসেবে চিহ্নিত করো" টগল বাটন আছে, sidebar-এ completed lesson-এ ✓ দেখায়, আর homepage-এ একটা Swiss-style progress-strip (বড় monospace সংখ্যা + thin progress bar + "Continue reading" লিংক)।

### F3. `llms.txt` + raw Markdown route + "Open in ChatGPT/Claude"

**Built:** `src/routes/llms.txt/+server.ts` (সব lesson-এর লিংক লিস্ট, plain text) এবং `src/routes/[slug].md/+server.ts` (যেকোনো lesson-এর raw markdown, যেমন `/lesson-1.1.md?lang=bn`)। লেসন পেজে existing "Markdown কপি" বাটনের পাশে একটা "আরও উপায়ে পড়ো" disclosure যোগ হয়েছে — "View as Markdown", "Open in ChatGPT", "Open in Claude" (দুটোই `?q=` prefill প্যাটার্ন ব্যবহার করে)।

### F4. bn/en hreflang + schema.org

**Built:** Homepage আর প্রতি lesson page-এ `<link rel="alternate" hreflang="bn/en/x-default">` এবং JSON-LD (`Course` / `LearningResource`) — dynamically generate করে `{@html}` দিয়ে বসানো (escape করা, XSS-safe, কারণ কনটেন্ট শুধু আমাদের নিজের static curriculum data থেকে আসে)।

### F5. Dark mode

Issue #5-এর সাথে একসাথে implement হয়েছে (উপরে দেখুন)।

### F6. Accessibility hardening

**পাওয়া গেছে যে আগে থেকেই ভালো ছিল:** `prefers-reduced-motion` support আর keyboard `focus-visible` outline (সব button/a/input/summary-তে) — এগুলো আগে থেকেই ছিল, নতুন সব element (mark-complete, ai-actions, theme-toggle) এই একই generic rule থেকে ফ্রি-তে পেয়ে গেছে।
**যা fix করা হয়েছে:** `--muted` টেক্সট কালার হালকা গাঢ় করা হয়েছে (`#707b80` → `#667176`) যাতে সাদা background-এ contrast ratio 4.34:1 থেকে 5.01:1 হয় (WCAG AA 4.5:1 পাশ করে) — dark mode-এ সব টেক্সট টোকেন 6:1+ contrast (root/heading 14-17:1, accent green 8.7-9.2:1)। সাথে `.nav-lesson-title`-এ standard `line-clamp` প্রপার্টি যোগ করে vendor-prefix-only compatibility warning ঠিক করা হয়েছে।

## Lint Debt — সব Fixed

### Pre-existing `bun run lint` errors (১৮টা)

- **`svelte/require-each-key`:** `Toc.svelte`, `(docs)/+layout.svelte` (module accordion + lesson-links + search-results), `(docs)/+page.svelte` (module-grid), `[slug]/+page.svelte` (mobile-toc headings) — সব কটা `{#each}`-এ stable key (`heading.id`, `module.id`, `lesson.id`, `result.id`) যোগ করা হয়েছে।
- **`svelte/no-at-html-tags`:** pre-existing `{@html data.html}` ([slug]/+page.svelte) — justified `eslint-disable-next-line` কমেন্ট যোগ করা হয়েছে (`render.ts`-এ `sanitize-html` দিয়ে আগেই sanitize করা, তাই নিরাপদ)।
- **`svelte/no-navigation-without-resolve`:** এই প্রজেক্টে সব `href` (`Lesson.href`, `localizedHref()`, `SearchResult.href`) হলো catalog/i18n লেয়ারে আগে থেকে বানানো plain `string`, কোনো literal route template না। `resolve()` দিয়ে wrap করার চেষ্টা করে দেখা গেছে এটা আসলে TypeScript compile error দেয় (`svelte-kit`-এর generated `Pathname` type শুধু literal template accept করে, general `string` না) — মানে পুরো href-generation architecture-টাই বদলাতে হতো, যেটা এই কাজের স্কোপের বাইরে অনেক বড় একটা refactor। এর বদলে `eslint.config.js`-এ অফিসিয়াল `ignoreLinks: true` অপশন দিয়ে rule-টা configure করা হয়েছে, কারণ-সহ কমেন্ট রেখে।

---

_Verification: প্রতিটা fix/feature-এর পর `bun run check` (svelte-check), `bun run test:unit -- --run --project server`, আর `bun run build` চালানো হয়েছে (সব pass) — সাথে Playwright দিয়ে light/dark mode, search, mark-complete, AI-actions menu, mobile scroll-shadow, hreflang/JSON-LD, llms.txt/raw-markdown endpoint সরাসরি ব্রাউজারে/HTTP রেসপন্সে চেক করা হয়েছে। `bun run format` চালানোর সময় prettier `course/main.md`-এর `*(...)*` parenthetical-কে `_(...)_ ` স্টাইলে বদলে দিয়েছিল, যেটা `catalog.ts`-এর `cleanTitle()` regex ভেঙে দিচ্ছিল (lesson 1.2/3.2/10.1-এর title-এ parenthetical leak করছিল) — সেটাও ধরা পড়ে regex ফিক্স করা হয়েছে (`\*` এবং `_` দুটোই handle করে এখন)।_
