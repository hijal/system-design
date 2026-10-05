# TODO Done — recall.hijal.dev audit

`todo.md` এর যেসব issue ঠিক হয়ে test হয়েছে সেগুলো এখানে আসে, একই format এ, সাথে **Fix** আর **Tested** অংশ।

---

## SD-01 · Mobile এ "সম্পন্ন" button এর কোনো accessible নাম নেই

- **Priority:** High
- **Category:** Accessibility
- **Where:** mobile (≤560px) সব available lesson — `.mark-complete`, `src/routes/(docs)/[slug]/+page.svelte` + `src/routes/layout.css`
- **Found by:** axe `button-name` (critical) — mobile `/lesson-1.1`, `/lesson-5.4`, `/lesson-1-challenge`
- **Problem:** Mobile এ text `span` CSS দিয়ে লুকানো, শুধু ✓ icon থাকে। Screen reader শুধু "button" পড়ে — কী করে বা এখন কোন অবস্থায় আছে বোঝা যায় না।
- **Expected:** Text দেখা না গেলেও button এর নাম থাকবে ("সম্পন্ন হিসেবে চিহ্নিত করো" / "Mark as complete"), `aria-pressed` আগের মতোই।
- **How to test:** mobile viewport এ axe এ `button-name` violation = 0; Playwright দিয়ে button এর accessible name check।
- **Fix:** `layout.css` এর mobile rule এ `.mark-complete span` আর `display: none` না — visually-hidden (`clip-path: inset(50%)`, ১px, `position: absolute`) করা হয়েছে, `.mark-complete` এ `position: relative`। Text চোখে দেখা যায় না কিন্তু accessibility tree তে থাকে, তাই button এর নাম আর state এক জায়গা থেকে আসে।
- **Tested:** Local dev এ axe `button-name` — desktop/mobile/dark/mobile-dark × `/lesson-1.1`, `/lesson-5.4`, `/lesson-1-challenge` = 0 violation। Playwright (375px): bn নাম "সম্পন্ন হিসেবে চিহ্নিত করো" → click এর পর "সম্পন্ন — ফিরিয়ে নিতে ক্লিক করো" [pressed]; en "Mark as complete" → "Completed — click to unmark" [pressed]; button এর আকার আগের মতো ৩৬×৩৪px।

## SD-02 · Breadcrumb এর home icon link এর কোনো নাম নেই

- **Priority:** High
- **Category:** Accessibility
- **Where:** সব lesson page — `.breadcrumb > a[href="/?lang=…"]`, `src/routes/(docs)/[slug]/+page.svelte`
- **Found by:** axe `link-name` (serious) — desktop, mobile, dark সব lesson page এ
- **Problem:** Link এ শুধু book icon, কোনো text বা `aria-label` নেই। Screen reader link টা "link" বা URL হিসেবে পড়ে।
- **Expected:** Link এর locale অনুযায়ী নাম থাকবে (যেমন "System Design Handbook home")।
- **How to test:** axe এ `link-name` violation = 0।
- **Fix:** `i18n.ts` এর `copy` তে নতুন `home` key (bn: "System Design Handbook — হোম", en: "System Design Handbook home"); `[slug]/+page.svelte` এ breadcrumb এর icon link এ `aria-label={t.home}`। Icon আগে থেকেই `aria-hidden`।
- **Tested:** Local dev এ axe `link-name` — ৪ mode × `/lesson-1.1` (bn/en), `/lesson-12.6`, `/lesson-11.7` = 0 violation। Playwright aria snapshot: bn `link "System Design Handbook — হোম"`, en `link "System Design Handbook home"`। `svelte-check` 0 error।

## SD-03 · Dark mode এ primary button এর contrast ২.০৫:১

- **Priority:** High
- **Category:** Accessibility
- **Where:** dark mode `.primary-button` — homepage "শেখা শুরু করো", 404 page এর "Curriculum-এ ফিরে যাও", untranslated lesson এর CTA — `src/routes/layout.css`
- **Found by:** axe `color-contrast` (serious) — সাদা `#ffffff` text, `#3ecb9b` background, ২.০৫:১ (দরকার ৪.৫:১)
- **Problem:** Site এর সবচেয়ে গুরুত্বপূর্ণ CTA dark mode এ পড়া কঠিন।
- **Expected:** Dark mode এ primary button text এর contrast ≥ ৪.৫:১ (যেমন উজ্জ্বল green এর উপর গাঢ় text)।
- **How to test:** dark mode এ axe `color-contrast` = 0; screenshot দেখে।
- **Fix:** `layout.css` এ নতুন token `--on-green` — light এ `#fff`, dark এ (`prefers-color-scheme` block আর `[data-theme="dark"]` দুই জায়গাতেই) `#0d1210`। `.primary-button` আর `.skip-link` (একই সমস্যা, একই green background) এখন hardcoded `#fff` এর বদলে `var(--on-green)` নেয়। শেষের পুরনো CSS comment থেকে "primary-button text" কথাটা সরানো হয়েছে, কারণ এখন সেটা আর সত্যি না।
- **Tested:** Local dev এ axe `color-contrast` — ৪ mode × `/`, `/?lang=en`, `/lesson-99.9` = 0 violation। Computed-style থেকে contrast: light OS button ৪.৯৬:১ (আগের মতোই), dark OS button ৯.২০:১ / hover ১১.৭১:১, skip-link ৯.২০:১; light OS + toggle dark → ৯.২০:১, dark OS + toggle light → ৪.৯৬:১। Screenshot এ dark mode CTA পরিষ্কার পড়া যায়।

## SD-04 · Code block এর "Code কপি" button এর contrast ২.৭৮:১

- **Priority:** High
- **Category:** Accessibility
- **Where:** light mode এ সব lesson এর code toolbar button — `.code-toolbar button`, `src/routes/layout.css`
- **Found by:** axe `color-contrast` (serious) — `#667176` text, `#1e3026` background, ২.৭৮:১; `/lesson-5.4` এ ১৮টা
- **Problem:** Code block সবসময় dark থাকে, কিন্তু button `--muted` token ব্যবহার করে যা light theme এর জন্য বানানো — তাই dark code background এ ঝাপসা দেখায়।
- **Expected:** Code toolbar এর রঙ fixed dark code palette থেকে আসবে, দুই theme এই ≥ ৪.৫:১।
- **How to test:** light + dark mode এ axe `color-contrast` = 0।
- **Fix:** `layout.css` এ `.code-toolbar button` এর রঙ `var(--muted)` থেকে fixed `#b8cbbf` — code block এর নিজস্ব dark palette এর অংশ, তাই theme বদলালেও বদলায় না। Contrast: `#1e3026` এর উপর ৮.১৯:১, hover `#314a3a` এর উপর ৫.৬৮:১।
- **Tested:** Local dev এ axe `color-contrast` — ৪ mode × `/lesson-1.1`, `/lesson-1.2?lang=en`, `/lesson-5.4` (আগে ১৮টা), `/lesson-11.7?lang=en` = 0 violation। Playwright: hover এ `rgb(184,203,191)` on `rgb(49,74,58)`; click করলে clipboard এ code যায় আর button "কপি হয়েছে" দেখায় (screenshot)।

## SD-05 · Scroll হওয়া code block আর table keyboard দিয়ে scroll করা যায় না

- **Priority:** Medium
- **Category:** Accessibility
- **Where:** lesson page এর `.doc-content pre`, `.doc-content table` (mobile এ বেশি) — `src/routes/(docs)/[slug]/+page.svelte`
- **Found by:** axe `scrollable-region-focusable` (serious) — mobile `/lesson-5.4` এ ১৮টা, `/lesson-1.1` এ ৩টা
- **Problem:** Horizontally overflow হওয়া `pre`/`table` এ focus যায় না, তাই keyboard user ডানের কাটা অংশ পড়তে পারে না।
- **Expected:** যেসব `pre`/`table` আসলেই overflow করে সেগুলো `tabindex="0"` পাবে (আর একটা accessible নাম), যাতে Tab করে arrow key দিয়ে scroll করা যায়।
- **How to test:** mobile viewport এ axe এ `scrollable-region-focusable` = 0।
- **Fix:** `[slug]/+page.svelte` এর `enhanceCode` action এ `syncScrollable()` — article এর যেসব `pre`/`table` এর `scrollWidth > clientWidth` শুধু সেগুলোতে `tabIndex = 0`, বাকিগুলো থেকে `tabindex` সরানো হয় (যাতে desktop এ অপ্রয়োজনীয় tab stop না হয়)। Article এর উপর `ResizeObserver` viewport/orientation বদলালে আবার হিসাব করে, `destroy` এ disconnect। `layout.css` এর focus-visible outline rule এ `.doc-content pre` আর `.doc-content table` যোগ।
- **Tested:** Local dev এ axe `scrollable-region-focusable` — ৪ mode × `/lesson-1.1` (bn/en), `/lesson-5.4` (আগে ১৮), `/lesson-11.7`, `/lesson-4.4` = 0 violation। Playwright (375px, `/lesson-5.4`): ১৯টা overflow region, ১৯টাই focusable; focus করে ArrowRight → `scrollLeft` ০ → ৮০, outline দেখা যায়; 1440px এ resize → ১/১; next lesson এ client-side navigation এর পর `/lesson-5.5` এ আবার ১৯/১৯।

## SD-06 · Search এ keyboard navigation আর screen reader semantics নেই

- **Priority:** Medium
- **Category:** Accessibility / UX
- **Where:** topbar search — `src/routes/(docs)/+layout.svelte`
- **Found by:** Playwright: `redis` লিখে ArrowDown → focus input এই থাকে, Enter → কোথাও যায় না; input এ `role`/`aria-expanded`/`aria-controls` নেই, result count `aria-live` এ নেই
- **Problem:** Search করে result খুলতে mouse লাগে বা অনেকবার Tab চাপতে হয়; screen reader জানতেই পারে না result এসেছে।
- **Expected:** ArrowUp/ArrowDown দিয়ে result বাছাই, Enter এ খোলা; input `role="combobox"` + `aria-expanded` + `aria-controls` + `aria-activedescendant`; result list `role="listbox"`; caption `aria-live="polite"`।
- **How to test:** Playwright — type → ArrowDown → Enter এ প্রথম result এ navigate হয়; axe clean।
- **Fix:** `(docs)/+layout.svelte`: input এ `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls="search-listbox"` (শুধু খোলা থাকলে), `aria-activedescendant`; result গুলো `role="listbox"` এর ভেতরে `role="option"` + `aria-selected`; caption এ `role="status"` (searching → "N lessons found" বদল screen reader পড়ে)। নতুন `navigateResults` — ArrowDown/ArrowUp wrap সহ selection সরায় আর `scrollIntoView({ block: "nearest" })`, Enter selected (না থাকলে প্রথম) result এর `<a>` এ `click()` করে — mouse click এর মতো একই SvelteKit link navigation, তাই `goto` লাগে না (`goto` দিলে `svelte/no-navigation-without-resolve` lint error হয়, কারণ href এ `?lang=` query আছে); searching চলাকালীন বা result না থাকলে কিছু করে না। নতুন query এলে selection reset। `layout.css` এ `.search-results a.active` hover এর মতোই highlight। `i18n.ts` এ `searchResults` label (bn/en)।
- **Tested:** Playwright (local dev, `/lesson-1.1?lang=en`): বন্ধ অবস্থায় `aria-expanded=false`; "redis" → ২০টা option, caption "20 lessons found"; ArrowDown×2 → `search-result-1` selected + activedescendant; ArrowUp×2 → `search-result-19` (wrap); Enter → selected result এর `/lesson-1.3?lang=en` এ যায়, dropdown বন্ধ; arrow ছাড়া Enter → প্রথম result `/lesson-4.1`; "zzqqxx" → no-results text, Enter/ArrowDown এ কিছু হয় না। axe — বন্ধ, খোলা, no-results তিন অবস্থাতেই 0 violation। `svelte-check` 0 error, `eslint` clean (`goto` → `click()` বদলের পর পুরো test আবার চালানো হয়েছে, একই ফল)।

## SD-07 · Open Graph / Twitter meta tag নেই

- **Priority:** Medium
- **Category:** SEO
- **Where:** `/` আর সব lesson page — `src/routes/(docs)/+page.svelte`, `src/routes/(docs)/[slug]/+page.svelte`
- **Found by:** DOM check — `meta[property^="og:"]` = 0, `meta[name^="twitter:"]` = 0
- **Problem:** Facebook/LinkedIn/Slack/Discord/X এ link share করলে title/description/locale ছাড়া ফাঁকা preview আসে।
- **Expected:** `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:locale` (+ `og:locale:alternate`), `twitter:card` প্রতিটা page এ।
- **How to test:** SSR HTML এ `curl` দিয়ে tag গুলো আছে কি না; homepage আর lesson এ মান ঠিক কি না।
- **Fix:** নতুন `src/lib/docs/SocialMeta.svelte` — `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:locale` (`bn_BD`/`en_US`) + `og:locale:alternate`, `twitter:card=summary`, `twitter:title`, `twitter:description`। Homepage (`type="website"`) আর lesson page (`type="article"`) দুটোতেই বসানো; lesson page এ `pageTitle`, `description`, `canonical` একবার `$derived` করে `<title>`, meta description, canonical আর OG — সব জায়গায় একই মান ব্যবহার হয়। `og:image` নেই (কোনো share image নেই), তাই `summary` card।
- **Tested:** Local dev SSR HTML (`curl`): `/?lang=bn`, `/?lang=en`, `/lesson-5.4?lang=bn`, `/lesson-1.1?lang=en`, `/lesson-1-challenge?lang=en` — সব tag আছে, `og:url` = canonical, locale ঠিক। Playwright client-side navigation (home → 1.1 → 1.2): প্রতিবার `og:title` ১টাই, title/url/type নতুন page অনুযায়ী বদলায়। `svelte-check` 0 error।

## SD-09 · ৩৬টা page এর `<title>` ৭০ character এর বেশি লম্বা

- **Priority:** Medium
- **Category:** SEO
- **Where:** `src/routes/(docs)/[slug]/+page.svelte` — `<title>{data.lesson.title} — System Design</title>`
- **Found by:** crawl — ১২৬ এর মধ্যে ৩৬টা > ৭০ char, সবচেয়ে লম্বা ১১২ (`/lesson-9.2?lang=bn`); `/lesson-12.6` এর title পুরো curriculum line
- **Problem:** Bangla title পুরো curriculum line (main title + subtitle) নিয়ে বানানো, তাই search result আর browser tab এ কেটে যায়।
- **Expected:** `<title>` এ শুধু মূল অংশ (`titleParts[0]`) + lesson number, subtitle থাকবে `meta description` এ।
- **How to test:** আবার crawl — কোনো title > ৭০ char না, অথবা বাকি থাকলে কারণ লেখা।
- **Fix:** `[slug]/+page.svelte` এ `pageTitle` এখন `"<lesson id> <মূল title> — System Design"` — শুধু `titleParts[0]` (প্রথম " — " এর আগের অংশ), parenthetical `(…)` বাদ; challenge এ id ছাড়া। Page এর h1/subtitle আগের মতোই পুরো title দেখায়। সাথে meta description এর "What is System Design?." ধরনের দ্বিগুণ punctuation ঠিক করা হয়েছে — এখন `"<lesson title> (<module>) — System Design Handbook"`।
- **Tested:** Local dev এ সব ১৬৮ page (available + upcoming + challenge, bn/en) crawl: > ৭০ char ৩৬ → ১১, সবচেয়ে লম্বা ১১২ → ৯৭; `/lesson-12.6` এখন "Capstone — System Design"; description এ দ্বিগুণ punctuation ০। বাকি ১১টা ইচ্ছা করে রাখা — ওগুলোর curriculum title নিজেই লম্বা (যেমন 1.4 "Client-Server, HTTP/HTTPS, connection lifecycle, keep-alive, HTTP/2 vs HTTP/3"); আরও ছোট করতে হলে `course/main.md`/`englishTitles` এর title বদলাতে হবে, যা content এর সিদ্ধান্ত। `prettier --check` pass।

## SD-08 · `sitemap.xml` নেই

- **Priority:** Medium
- **Category:** SEO
- **Where:** `/sitemap.xml` → 404; `static/robots.txt` এ `Sitemap:` line নেই
- **Found by:** `curl`
- **Problem:** Search engine কে ১২৬টা bn/en page এর list আর hreflang জোড়া জানানোর কোনো উপায় নেই।
- **Expected:** `/sitemap.xml` route — প্রতিটা available page (`?lang=bn` আর `?lang=en`), `xhtml:link` hreflang alternate সহ; robots.txt এ `Sitemap:` line।
- **How to test:** route এর unit test; `curl /sitemap.xml` valid XML দেয়, URL count = available pages।
- **Fix:** নতুন `src/lib/server/course/sitemap.ts` (`buildSitemap(origin, catalogs)`) — homepage bn/en আর প্রতিটা lesson/challenge এর শুধু লেখা হয়ে যাওয়া edition গুলো `<url>` হয়; প্রতিটায় শুধু বিদ্যমান edition এর `xhtml:link` hreflang আর bn থাকলে `x-default`। নতুন route `src/routes/sitemap.xml/+server.ts` (`application/xml`, `max-age=3600`)। `static/robots.txt` সরিয়ে `src/routes/robots.txt/+server.ts` করা হয়েছে, যাতে `Sitemap:` line request এর origin থেকে আসে (domain hardcode না); আগের rule (`User-agent: *`, `Disallow:`) অপরিবর্তিত। Unit test `sitemap.spec.ts`।
- **Tested:** `bun run test` — ২৮/২৮ pass (নতুন ৩টা: শুধু লেখা edition থাকে, unwritten বাদ; bn-only lesson এ `en` hreflang নেই; well-formed urlset)। Local dev: `/sitemap.xml` 200 `application/xml`, Python `ElementTree` parse OK — ১৪৪ url, ৪২৪ alternate; ১৪৪ = llms.txt এর ১৪২ page + ২ homepage; ১৪৪টা loc এর সবগুলো fetch করে 200 আর আসল content (কোনো placeholder না)। `/robots.txt` এ `Sitemap: <origin>/sitemap.xml`।

## SD-16 · Placeholder page গুলো indexable আর hreflang অনুপস্থিত edition কে দেখায়

- **Priority:** Medium
- **Category:** SEO
- **Where:** যেকোনো lesson যার এক বা দুই edition লেখা হয়নি — যেমন `/lesson-12.6?lang=en` ("coming soon"), অনুবাদ না হওয়া lesson এর `?lang=en` ("translation in progress") — `src/routes/(docs)/[slug]/+page.svelte`
- **Found by:** SD-08 এর sitemap বানানোর সময় — live `/lesson-12.6?lang=en` এ `hreflang="bn"` আর `hreflang="en"` দুটোই আছে, `robots` meta নেই
- **Problem:** কোনো content নেই এমন placeholder page search engine এ index হতে পারে (thin content), আর আসল lesson এর `hreflang` ওই খালি edition কে "translation" বলে দেখায়। নতুন sitemap এর সাথেও মেলে না, কারণ sitemap শুধু লেখা edition গুলো রাখে।
- **Expected:** `hreflang` শুধু লেখা হয়ে যাওয়া edition এর জন্য (bn থাকলে `x-default`); placeholder page এ `<meta name="robots" content="noindex">`।
- **How to test:** SSR HTML — দুই edition আছে এমন lesson, শুধু bn আছে এমন lesson, কোনোটাই নেই এমন lesson; sitemap এর hreflang এর সাথে মেলানো।
- **Fix:** `[slug]/+page.svelte` এ নতুন `editions` derived — বর্তমান locale এর জন্য `lesson.available`, অন্যটার জন্য `lesson.otherAvailable` দেখে শুধু লেখা edition গুলো রাখে। `hreflang` link এখন `{#each editions}` থেকে, `x-default` শুধু bn edition থাকলে (sitemap এর নিয়মের সাথে মিলিয়ে)। Lesson available না হলে `<meta name="robots" content="noindex">`।
- **Tested:** Local dev এ `course/main.md` এর সব ৮২টা id × bn/en = ১৬৪ URL এর SSR HTML: sitemap এ থাকা ১৪২টার প্রতিটার page hreflang sitemap এর hreflang এর সাথে হুবহু মেলে (mismatch ০), কোনোটায় noindex নেই; বাকি ২২টা placeholder এর সবগুলোতে noindex আর কোনো hreflang নেই। Playwright client-side navigation: `/lesson-11-challenge` (bn,x-default; robots ০) → next → `/lesson-12.1` (alternate নেই; robots ১) → back → আবার bn,x-default; robots ০।

## SD-10 · Security header নেই

- **Priority:** Medium
- **Category:** Security
- **Where:** সব HTML response — `src/hooks.server.ts`
- **Found by:** `curl -I` — `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `Permissions-Policy` কোনোটাই নেই
- **Problem:** Site অন্য origin এর iframe এ বসানো যায় (clickjacking), MIME sniffing বন্ধ না, full URL referrer হিসেবে external site এ যায়।
- **Expected:** `handle` এ এই header গুলো set হবে।
- **How to test:** `hooks.server` এর unit test + local preview এ `curl -I`।
- **Fix:** `src/hooks.server.ts` এ `handle` এখন `async` — `resolve` এর পর প্রতিটা response এ `securityHeaders` বসায়: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` (পুরনো আর নতুন browser দুটোর জন্য), `Strict-Transport-Security: max-age=31536000` (`includeSubDomains` ছাড়া, কারণ `hijal.dev` এর অন্য subdomain এর অবস্থা জানা নেই), `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`। Locale logic অপরিবর্তিত। পুরো script/style CSP ইচ্ছা করে করা হয়নি — inline theme script, JSON-LD আর Google Fonts এর জন্য hash/nonce setup লাগবে, সেটা আলাদা কাজ। নতুন `src/hooks.server.spec.ts`।
- **Tested:** `bun run test` — ৩০/৩০ pass (নতুন: সব header বসে; locale query → cookie → bn ক্রম আর cookie শুধু query থাকলে set হয়)। Local dev `curl -D -`: `/lesson-1.1` 200, `/sitemap.xml`, `/search`, `/lesson-99.9` 404, `/caching` 307 redirect, `/lesson-1.1.md` — সবগুলোতে ৬টা header। Browser smoke test: page load এ কোনো error নেই, code copy (clipboard) কাজ করে, axe ৪ mode এ clean। `eslint` clean।

## SD-15 · Mobile এ "আরও উপায়ে পড়ো" menu পুরোপুরি লুকানো

- **Priority:** Medium
- **Category:** UX
- **Where:** mobile (≤560px) lesson page — `.ai-actions summary`, `src/routes/layout.css`
- **Found by:** SD-01 ঠিক করার সময় CSS পড়ে — `@media (width<=560px) { .mark-complete span, .ai-actions summary { display: none } }`; mobile screenshot এ menu নেই
- **Problem:** `summary` এর ভেতরে শুধু text, তাই পুরো `summary` লুকিয়ে গেলে disclosure খোলার কোনো উপায় থাকে না — phone এ "View as Markdown", "Open in ChatGPT", "Open in Claude" পাওয়া যায় না। (Archive এর #6 এ এর mobile padding বাড়ানো হয়েছিল, তাই এটা visible থাকার কথা।)
- **Expected:** Mobile এ summary দেখা যায় (ছোট label বা icon), menu খোলা যায়।
- **How to test:** mobile viewport এ Playwright — summary visible, click করলে ৩টা link দেখা যায়।
- **Fix:** `[slug]/+page.svelte`: summary এ `external` icon + text `<span>` এ। `layout.css`: desktop এ icon লুকানো (`.ai-actions summary svg { display: none }`), তাই desktop আগের মতোই শুধু text। Mobile (≤560px) এ summary `display: flex`, icon দেখা যায়, text SD-01 এর একই visually-hidden rule এ (accessible নাম থাকে)। Mobile এ meta row wrap হয়ে summary বাম দিকে নেমে আসে, তাই আগের `right: 0` menu screen এর বাইরে চলে যেত — mobile এ `.lesson-meta` কে `position: relative`, `.ai-actions` কে `static` করে menu কে meta row এর বাম কিনারায় (`left: 0`) বসানো হয়েছে, summary যেখানেই থাকুক।
- **Tested:** Playwright `/lesson-1.1`: 375px, 320px, 540px — summary ৩৬×৩৪px, icon দেখা যায়, accessible নাম "আরও উপায়ে পড়ো"; click এ ৩টা link (Markdown হিসেবে দেখো, ChatGPT-তে খোলো, Claude-এ খোলো) viewport এর ভেতরে (২৯–২০৫px), page horizontal overflow নেই (প্রথম চেষ্টায় menu −১১৭px এ কাটা যাচ্ছিল, anchor বদলে ঠিক)। Desktop: summary ১০৮×৩১px, icon লুকানো, menu আগের জায়গায়। axe ৪ mode × `/lesson-1.1` (bn/en), `/lesson-5.4` = 0।

## SD-11 · `/favicon.ico` 404, `theme-color` নেই

- **Priority:** Low
- **Category:** UX
- **Where:** `static/`, `src/app.html`
- **Found by:** `curl /favicon.ico` → 404; DOM এ `meta[name=theme-color]` নেই
- **Problem:** যেসব client `<link rel=icon>` পড়ে না (RSS reader, কিছু crawler, bookmark import) তারা 404 পায়; mobile browser এর address bar site এর রঙ নেয় না।
- **Expected:** `static/favicon.svg` + `/favicon.ico` request ঠিকমতো serve হয়; light/dark `theme-color` meta।
- **How to test:** build output এ file আছে; local preview এ `curl /favicon.ico` 200।
- **Fix:** বিদ্যমান `src/lib/assets/favicon.svg` থেকেই Chrome headless এ render করে বানানো: `static/favicon.ico` (আসল ICO — ১৬/৩২/৪৮px PNG, ৩.৩KB) আর `static/apple-touch-icon.png` (১৮০px, rounded corner ছাড়া কারণ iOS নিজে corner কাটে; iOS link ছাড়াও এই path চায়)। `src/app.html` এ light/dark `theme-color` (`#ffffff` / `#0d1210` — `--bg` এর মান) আর `<link rel="apple-touch-icon">`। Page এর `<link rel="icon">` আগের মতোই hashed SVG।
- **Tested:** `bun run build` এর পর `.svelte-kit/cloudflare/` এ দুটো file আছে; `wrangler dev` (production build): `/favicon.ico` 200 `image/vnd.microsoft.icon`, `/apple-touch-icon.png` 200 `image/png`। `file` command: ICO তে ৩টা PNG icon, apple icon ১৮০×১৮০; দুটো image চোখে দেখে মিলিয়ে নেওয়া হয়েছে। SSR HTML এ দুটো `theme-color` (media সহ) আর apple-touch-icon link আছে। `prettier --check src/app.html` pass।

## SD-12 · Linux/Windows এও search এ "⌘ K" দেখায়

- **Priority:** Low
- **Category:** UX
- **Where:** `src/routes/(docs)/+layout.svelte` — `<kbd>⌘ K</kbd>`
- **Found by:** Screenshot (Linux Chrome)
- **Problem:** Mac ছাড়া অন্য OS এ shortcut আসলে `Ctrl K`, কিন্তু hint `⌘ K` বলে।
- **Expected:** Mac এ `⌘ K`, বাকি সব জায়গায় `Ctrl K`।
- **How to test:** Playwright — Linux UA তে `Ctrl K`, Mac UA তে `⌘ K`।
- **Fix:** `(docs)/+layout.svelte` এ `shortcutKey` state — server render এ `Ctrl` (Linux/Windows বেশিরভাগ user, আর server OS জানে না), `onMount` এ `navigator.userAgent` এ `Mac|iPhone|iPad|iPod` পেলে `⌘`। `<kbd>{shortcutKey} K</kbd>`। Shortcut handler আগে থেকেই Ctrl আর Meta দুটোই ধরে, সেটা বদলানো হয়নি।
- **Tested:** Playwright UA অনুযায়ী: Linux "Ctrl K", Windows "Ctrl K", macOS "⌘ K", iPad "⌘ K"; প্রতিটায় নিজের shortcut (macOS এ Meta+K, বাকিগুলোতে Ctrl+K) চাপলে search input এ focus যায়। SSR HTML এ `<kbd>Ctrl K</kbd>`। 1440px আর 900px এ screenshot — "Ctrl K" search box এর ভেতরে ঠিকমতো বসে। `eslint` clean।

## SD-13 · Mobile এ কিছু tap target ২৪px এর ছোট

- **Priority:** Low
- **Category:** Accessibility
- **Where:** mobile (375px) — mobile TOC `summary` (২০px), mobile TOC link (২২px), breadcrumb link (২০px), breadcrumb home icon (১৫×১৫px)
- **Found by:** DOM measurement, WCAG 2.2 SC 2.5.8 (target size minimum ২৪×২৪)
- **Problem:** আঙুল দিয়ে ছোঁয়া কঠিন, পাশের link এ ভুল tap হয়।
- **Expected:** এগুলো mobile এ অন্তত ২৪px উঁচু।
- **How to test:** একই measurement script আবার — তালিকার element গুলো ≥ ২৪px।
- **Fix:** `layout.css` এর "Bigger mobile tap targets" (≤560px) block এ: `.reader-page > .breadcrumb a` → `inline-flex`, `min-width`/`min-height: 24px` (home icon এর চারপাশে hit area বাড়ে, icon এর আকার একই); `.mobile-toc summary` আর `.mobile-toc nav a` এ `padding: 4px 0`, আর `nav` এর `gap` ১০px → ২px — তাই link এর মধ্যে দূরত্ব আগের মতোই ৩২px থাকে, শুধু ছোঁয়ার জায়গা বড় হয়।
- **Tested:** Playwright 375px, `/lesson-1.1?lang=bn` আর `/lesson-5.4?lang=en`: breadcrumb home icon ১৫×১৫ → ২৪×২৪, "Course overview" ২০ → ২৪px উঁচু, mobile TOC summary ২০ → ২৮px, TOC link সবচেয়ে ছোট ২২ → ৩০px, link pitch ৩২px (আগের মতো)। Article এর বাইরে ২৪px এর ছোট কোনো target বাকি নেই (search input বাদে, যার পুরো `.search-wrap` ৪০px+ এর clickable box)। Screenshot এ layout আগের মতো।

## SD-14 · Lesson HTML এ article দুইবার যায় (DOM + hydration data)

- **Priority:** Low
- **Category:** Performance
- **Where:** `src/routes/(docs)/[slug]/+page.server.ts` → `data.html`
- **Found by:** `/lesson-5.4?lang=bn` — মোট ১২১KB HTML, যার মধ্যে article ৩৭KB আর hydration `<script>` ৬৩KB (article এর escaped copy + পুরো curriculum)
- **Problem:** প্রথম load এ একই lesson content দুইবার download হয় (brotli এর পর ~৩১KB)।
- **Expected:** তদন্ত করা — hydration এর জন্য `html` serialize না করে চলে কি না; না চললে কারণ লিখে বন্ধ করা।
- **How to test:** payload size আগে/পরে; client-side navigation এ lesson ঠিকমতো render হয়।
- **Fix:** **Won't fix (তদন্তের পর)** — code বদলানো হয়নি। SvelteKit server `load` এর পুরো return value hydration এর জন্য page এ serialize করে, field বাদ দেওয়ার কোনো public option নেই। বিকল্প গুলোও কাজ করে না: universal `+page.ts` থেকে `fetch` করলে SvelteKit সেই response ও SSR page এ inline করে (একই duplication); hydration এর সময় DOM থেকে article পড়ে নেওয়া hack, আর client-side navigation এ `__data.json` থেকে `html` লাগবেই। লাভও ছোট (নিচে দেখো), তাই hack এর ঝুঁকি নেওয়ার মানে নেই। যদি কখনো দরকার হয়, পথ হবে lesson কে prerender করে static HTML বানানো — সেটা locale cookie এর design বদলায়, আলাদা কাজ।
- **Tested:** Production build (`wrangler dev`) এর `/lesson-5.4?lang=bn` (সবচেয়ে ভারী lesson গুলোর একটা): মোট ১২২.৮KB, hydration script ৬৩.৪KB যার মধ্যে `html` field ৪৪.৪KB। `html` সরালে কতটা কমে, মাপা হয়েছে: brotli q4 (Cloudflare এর মতো) ৩১.৯KB → ২৩.৮KB (−৮.১KB), brotli q11 ২২.৮KB → ১৮.৯KB (−৩.৯KB)। ছোট lesson এ লাভ আরও কম।
