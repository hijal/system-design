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

## SD-17 · Nested URL এ unstyled SvelteKit default 404

- **Priority:** Medium
- **Category:** UX
- **Where:** `/a/b`, `/lesson-1.1/extra` এর মতো এক segment এর বেশি URL — `src/routes/(docs)/[slug]` শুধু এক segment ধরে
- **Found by:** Playwright — `/a/b` এ title নেই, topbar নেই, শুধু "404 Not Found" plain text
- **Problem:** ভুল বা পুরনো link এ আসা user site এর কোনো navigation, theme, বা ফিরে যাওয়ার link পায় না; `(docs)/+error.svelte` এখানে চলে না।
- **Expected:** যেকোনো অচেনা URL একই styled 404 page দেখায় (topbar, sidebar, "Curriculum-এ ফিরে যাও")।
- **How to test:** `/a/b`, `/lesson-1.1/x`, `/x/y/z` — status 404, topbar আছে, locale অনুযায়ী text।
- **Fix:** নতুন catch-all route `src/routes/(docs)/[...rest]/+page.server.ts` — যেকোনো অচেনা multi-segment URL এ locale অনুযায়ী message দিয়ে `error(404, …)` ("এই ঠিকানায় কোনো পাতা নেই।" / "There is no page at this address.")। Route টা `(docs)` group এর ভেতরে, তাই `(docs)/+layout` (topbar, sidebar, theme) আর `(docs)/+error.svelte` দুটোই পায়। SvelteKit এর route priority তে `/`, `[slug]`, `[slug].md`, `/search`, `/llms.txt`, `/sitemap.xml`, `/robots.txt` আগে আসে, তাই ওগুলোর কিছু বদলায় না।
- **Tested:** Production build (`wrangler dev`): `/a/b`, `/lesson-1.1/x`, `/x/y/z`, `/a/b?lang=en` → 404, `<title>404 — System Design</title>`, topbar + sidebar আছে; bn এ "এই পাতাটি পাওয়া যায়নি। / এই ঠিকানায় কোনো পাতা নেই। / Curriculum-এ ফিরে যাও", en এ English, `<html lang>` ঠিক; "ফিরে যাও" link → `/?lang=…`। বাকি route গুলো আগের মতো: `/`, `/lesson-1.1` 200, `/lesson-99.9` 404 (lesson message), `/sitemap.xml`, `/llms.txt`, `/search`, `/lesson-1.1.md`, `/robots.txt` 200 সঠিক content-type সহ।

## SD-18 · Mobile curriculum drawer এ focus আর scroll ঠিকমতো manage হয় না

- **Priority:** Medium
- **Category:** Accessibility / UX
- **Where:** mobile (≤ drawer breakpoint) — `src/routes/(docs)/+layout.svelte`, `.sidebar.mobile-open`
- **Found by:** Playwright 375px — drawer খোলা অবস্থায় Escape চাপলে focus `<body>` এ হারিয়ে যায়; drawer খোলা অবস্থায় পেছনের page scroll হয় (scrollY ১৫০০ → ১৯১৪); পেছনের `main` inert না, তাই Tab drawer থেকে বেরিয়ে আড়ালের content এ যায়
- **Problem:** Keyboard user drawer বন্ধ করে কোথায় আছে হারিয়ে ফেলে; touch user drawer scroll করতে গিয়ে পেছনের lesson এ নিজের জায়গা হারায়।
- **Expected:** Escape বা backdrop এ বন্ধ হলে focus toggle button এ ফেরে; drawer খোলা থাকলে page scroll lock আর `main` inert।
- **How to test:** Playwright — Escape এর পর focus `.mobile-toggle`; খোলা অবস্থায় wheel এ scrollY বদলায় না; Tab শুধু topbar/drawer এর ভেতরে ঘোরে; বন্ধ করলে scroll আগের জায়গায়।
- **Fix:** `(docs)/+layout.svelte`: নতুন `closeMobileNav()` — drawer বন্ধ করে `mobileToggle.focus({ preventScroll: true })`; Escape আর backdrop দুটোই এটা ডাকে (link এ navigate করলে `afterNavigate` আগের মতো বন্ধ করে, focus SvelteKit সামলায়)। Drawer খোলা থাকলে `<html>` এ `nav-locked` class (`layout.css` এর ≤850px block এ `overflow: hidden`) আর `<main inert>` — তাই পেছনের page scroll বা Tab হয় না। `matchMedia("(width > 850px)")` — drawer খোলা অবস্থায় window চওড়া হলে drawer বন্ধ, যাতে desktop এ `main` inert থেকে না যায়। প্রথম চেষ্টায় `focus()` toggle কে "scroll into view" করে page ১৫০০ → ১১১৪ এ সরিয়ে দিচ্ছিল, `preventScroll` দিয়ে ঠিক।
- **Tested:** Playwright 375px `/lesson-5.4`: scrollY ১৫০০ এ drawer খোলা → `nav-locked` + `overflow: hidden` + `main.inert`; backdrop এর উপর wheel এ scrollY ১৫০০ ই থাকে, drawer নিজে scroll হয় (০ → ৩০০); ৪০ বার Tab — focus শুধু topbar/drawer এ, `main` এ যায় না; Escape → focus `.mobile-toggle`, scrollY ১৫০০ অপরিবর্তিত, lock/inert উঠে যায়; backdrop click → focus toggle; drawer এর lesson link → `/lesson-5.5`, drawer বন্ধ, lock/inert নেই; খোলা অবস্থায় 1200px এ resize → বন্ধ, inert/lock নেই। `svelte-check` 0 error, `eslint` clean।

## SD-19 · Google Fonts render-blocking, আর CSS এর ৪৫০/৫৫০/৬৫০/৭৫০ weight আসলে render হয় না

- **Priority:** Medium
- **Category:** Performance
- **Where:** `src/app.html` এর Google Fonts `<link>`; `src/routes/layout.css`
- **Found by:** Lighthouse — "Render blocking requests", আনুমানিক ৭১০–৯৪০ms সাশ্রয় সম্ভব (third-party CSS → তারপর font file, দুটো আলাদা origin); প্রতি page এ ৪টা font file ২০৬KB; CSS এ `font-weight: 550` (১১ জায়গায়), `650` (৫), `450` (৩), `750` (১) — static font এ শুধু ৪০০/৫০০/৬০০/৭০০/৮০০ আছে, তাই browser কাছের weight এ snap করে
- **Problem:** প্রথম paint একটা অন্য origin এর CSS এর জন্য আটকে থাকে; design এ যে মাঝামাঝি weight লেখা সেটা কখনো দেখা যায় না।
- **Expected:** Font self-host (same origin, hashed + immutable cache), variable font যাতে যেকোনো weight ঠিক render হয়; Google Fonts এর render-blocking request আর থাকে না।
- **How to test:** Lighthouse render-blocking audit pass; network এ `fonts.googleapis.com` / `fonts.gstatic.com` request ০; `document.fonts` এ তিনটা family loaded; screenshot এ Bangla/English/mono text ঠিক।
- **Fix:** Google Fonts `<link>` আর দুটো `preconnect` `src/app.html` থেকে সরানো; `@fontsource-variable/inter`, `@fontsource-variable/noto-sans-bengali`, `@fontsource-variable/jetbrains-mono` (OFL-1.1, `package.json` + `bun.lock` এ নতুন dependency) root `+layout.svelte` এ import — Vite hashed `woff2` হিসেবে bundle করে, same-origin, `immutable` cache, `unicode-range` এর কারণে শুধু দরকারি subset নামে। `layout.css` এ নতুন `--sans` token (`Inter Variable`, `Noto Sans Bengali Variable`), `--mono` → `JetBrains Mono Variable`; চারটা আলাদা font stack এখন token থেকে। Variable font তাই CSS এর ৪৫০/৫৫০/৬৫০/৭৫০ weight এখন হুবহু render হয় (আগে কাছের static weight এ snap করত — heading গুলো একটু হালকা দেখাবে, কারণ এটাই CSS এ লেখা ছিল)। **Font preload চেষ্টা করে বাদ দেওয়া হয়েছে** — নিচের মাপে real throttled load এ preload ধীর করছিল।
- **Tested:** একই machine এ A/B — HEAD (Google Fonts) একটা git worktree এ build করে port 8798 এ, নতুনটা 8799 এ, দুটোই `wrangler dev`। Network: Google এর request ০, ৩টা font file (Inter latin ৪৭KB, Noto Bengali ১০৫KB, JetBrains latin ৩৯KB = ১৯২KB, আগে ২০৬KB), `font/woff2` + `public, immutable, max-age=31536000`; `document.fonts` এ তিন family loaded; computed weight `.lesson-header h1` = ৬৫০, `.module-card h3` = ৫৫০। Lighthouse **simulated**: render-blocking audit fail → pass, `/lesson-5.4?lang=bn` perf ৮১–৮২ → ৯৫–৯৬ (FCP ৩.৬s → ১.৬s), কিন্তু en homepage LCP ১.৬s → ২.৬–২.৭s (preload এর কারণে simulation artifact)। Lighthouse **real devtools throttling** (যেটা বেশি বিশ্বাসযোগ্য): Google Fonts FCP/LCP ১.৪–১.৬s; self-host + preload ১.৬–১.৮s (খারাপ); self-host preload ছাড়া ১.৫–১.৭s, perf ৯২–১০০ — অর্থাৎ **গতিতে প্রায় সমান**, বড় জয় না। তবু রাখা হয়েছে কারণ: weight এখন design অনুযায়ী, third-party request নেই (user এর IP Google এ যায় না, Google down হলেও font আসে), আর SD-20 এর CSP সহজ হয়। CLS দুই ক্ষেত্রেই একই (lesson ০.০৬৭)। Screenshot এ bn/en/mono text ঠিক।

## SD-20 · পূর্ণ Content-Security-Policy নেই

- **Priority:** Medium
- **Category:** Security
- **Where:** `vite.config.ts` (SvelteKit config), `src/app.html`
- **Found by:** Round 1 এ শুধু `frame-ancestors` দেওয়া হয়েছিল; live HTML এ Cloudflare এর inject করা কোনো script নেই, তাই পূর্ণ CSP সম্ভব
- **Problem:** Rendered markdown বা কোনো dependency দিয়ে কখনো script ঢুকলে browser এর কোনো দ্বিতীয় স্তরের বাধা নেই।
- **Expected:** SvelteKit `kit.csp` (hash mode) দিয়ে `default-src 'self'`, `script-src 'self'` + hash, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` ইত্যাদি; theme init inline script এর hash।
- **How to test:** সব page type এ CSP header; browser console এ CSP violation ০ (home, lesson, search, theme toggle, copy, 404); inline script hash ভুল হলে violation ধরা পড়ে তা নিশ্চিত করা।
- **Fix:** `vite.config.ts` এ SvelteKit `csp` — **`mode: "auto"`** (তোমার কথা মতো; dynamic SSR page এ প্রতি request এ নতুন nonce, prerender করা page থাকলে hash): `default-src 'self'`, `script-src 'self'` (+ SvelteKit এর nonce), `style-src 'self' 'unsafe-inline'` (`app.html` এর `style="display: contents"` attribute এর জন্য), `img-src 'self' data:` (hashed SVG favicon data URI), `font-src 'self'`, `connect-src 'self'` (search fetch), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`। `src/app.html` এর theme script এ `nonce="%sveltekit.nonce%"`। `hooks.server.ts` এর আগের আলাদা `content-security-policy: frame-ancestors` header সরানো (নইলে SvelteKit এর CSP overwrite করত; `frame-ancestors` এখন এই CSP তে, `X-Frame-Options: DENY` আগের মতো সব response এ)। Test এ ধরা পড়ল Vite ৪KB এর ছোট font (JetBrains Mono `cyrillic-ext`, ২KB) CSS এর ভেতর `data:` URI করে inline করছে, যা `font-src` block করে — `font-src` এ `data:` খোলার বদলে `build.assetsInlineLimit` দিয়ে `.woff2` inline বন্ধ, তাই সব font আলাদা same-origin file (CSS ২.৭KB ছোট হয়েছে)। প্রথমে hash mode + build-time hash চেষ্টা করেছিলাম, `auto` তে nonce দিয়ে সেটার দরকার নেই, তাই সরানো।
- **Tested:** Production build (`wrangler dev`): CSP header প্রতি request এ আলাদা nonce (`script-src 'self' 'nonce-…'`), HTML এর দুটো inline script (theme + SvelteKit hydration) এ একই nonce; `/search` (endpoint) এ CSP header নেই, যা ঠিক। Playwright `securitypolicyviolation` listener + console: home, theme toggle, search fetch, search থেকে Enter এ client nav, Markdown কপি ("কপি হয়েছে"), code copy, next lesson, `/lesson-5.4?lang=en`, `/lesson-12.6`, `/lesson-99.9`, `/a/b`, `/lesson-1-challenge` — সব জায়গায় violation ০, page error ০; saved dark theme আগের মতো প্রথম paint এর আগেই বসে (`data-theme=dark`), ৩টা font loaded। Negative test (prod আর `bun run dev` দুটোতেই): JS দিয়ে inject করা inline script চলে না আর external script block হয় (`script-src-elem` ×২)। `bun run test` ৩০/৩০, `svelte-check` ০ error।

## SD-21 · Bangla UI তে screen reader label গুলো ইংরেজিতে hardcoded

- **Priority:** Low
- **Category:** Accessibility
- **Where:** `src/routes/(docs)/+layout.svelte`, `src/routes/(docs)/[slug]/+page.svelte` — "Search lessons", "Reading language", "Open/Close curriculum", "Switch to dark/light theme", "Course curriculum", "Lesson navigation", "Completed", "Coming soon"
- **Found by:** Source + aria snapshot — bn mode এ sidebar link পড়ে "1.1 System Design আসলে কী… Completed"
- **Problem:** `lang="bn"` page এ Bangla voice ইংরেজি label ভুল উচ্চারণে পড়ে; visible UI বাংলা কিন্তু শোনা যায় ইংরেজি।
- **Expected:** এই label গুলো `copy` (i18n) থেকে locale অনুযায়ী।
- **How to test:** bn আর en দুই mode এ aria snapshot।
- **Fix:** `i18n.ts` এর `copy` তে bn/en দুই locale এ নতুন key: `searchLabel`, `readingLanguage`, `openNav`, `closeNav`, `toLightTheme`, `toDarkTheme`, `curriculumNav`, `lessonNav`, `completed` ("Coming soon" এর জন্য আগের `coming` key)। `(docs)/+layout.svelte` এর search input, language switch, theme toggle, mobile toggle, backdrop, sidebar `aside`, completed ✓ (aria-label + title), pending dot, আর `[slug]/+page.svelte` এর pagination `nav` এখন `t.*` থেকে। Brand link এর label SD-22 তে আলাদা করে।
- **Tested:** Playwright (375px), bn: aria-label গুলো "Lesson খোঁজো · পড়ার ভাষা · Dark theme এ যাও · Curriculum খোলো · কোর্সের curriculum · শীঘ্রই আসছে · আগের আর পরের lesson", খোলার পর toggle "Curriculum বন্ধ করো"; sidebar link "1.1 System Design আসলে কী… সম্পন্ন", "12.5 … শীঘ্রই আসছে"। en: "Search lessons · Reading language · Switch to dark theme · Open curriculum · Course curriculum · Coming soon · Lesson navigation", "1.1 What is System Design? Completed"। Source এ `aria-label="<English>"` hardcoded বাকি শুধু brand link (SD-22)।

## SD-22 · Brand link এর accessible নাম visible text এর সাথে মেলে না

- **Priority:** Low
- **Category:** Accessibility
- **Where:** topbar `.brand` — `aria-label="System Design home"`, visible "systemdesign THE LEARNING HANDBOOK"
- **Found by:** Lighthouse `label-content-name-mismatch` (WCAG 2.5.3 Label in Name)
- **Problem:** Voice control user যা দেখে ("system design") বললে link match নাও হতে পারে।
- **Expected:** Accessible নাম visible text দিয়ে শুরু হয়।
- **How to test:** Lighthouse `label-content-name-mismatch` pass।
- **Fix:** `(docs)/+layout.svelte` এ brand link থেকে `aria-label="System Design home"` সরানো — নাম এখন visible text থেকেই আসে, তাই কখনো mismatch হবে না। `design</span>` আর `<small>` এর মাঝে একটা space, যাতে নাম "systemdesignTHE…" না হয়ে "systemdesign THE LEARNING HANDBOOK" হয়; `<small>` `display: block`, তাই space চোখে পড়ে না।
- **Tested:** Playwright aria snapshot: homepage (1440px আর 375px) `link "systemdesign THE LEARNING HANDBOOK"`, lesson page এ (যেখানে `<small>` `display: none`) `link "systemdesign"` — দুটোই visible text এর সাথে হুবহু মেলে। Screenshot এ logo আগের মতো, আকার একই (২৪৪×৪০)। Lighthouse accessibility `/` আর `/lesson-5.4`: ১০০, `label-content-name-mismatch` আর প্রযোজ্য নয় (আগে fail)।

## SD-23 · দুটো `nav` landmark এর আলাদা নাম নেই

- **Priority:** Low
- **Category:** Accessibility
- **Where:** sidebar এর ভেতরের `<nav>` (label নেই) — `src/routes/(docs)/+layout.svelte`
- **Found by:** axe `landmark-unique` (moderate) — mobile drawer খোলা অবস্থায়
- **Problem:** Screen reader এর landmark list এ নামহীন "navigation" — কোনটা কী বোঝা যায় না।
- **Expected:** Curriculum `nav` এর নিজের label।
- **How to test:** mobile drawer খোলা অবস্থায় axe clean।
- **Fix:** `(docs)/+layout.svelte` এ sidebar এর `<nav>` এ `aria-label={t.curriculum}` ("তোমার curriculum" / "Your curriculum"), যা বাইরের `aside` এর label ("কোর্সের curriculum") থেকে আলাদা। পরীক্ষার সময় আরেকটা নামহীন `nav` পাওয়া গেছে — mobile TOC এর — সেটাতেও desktop TOC এর মতো `aria-label={t.onPage}` (`[slug]/+page.svelte`)।
- **Tested:** axe (WCAG 2.2 + best-practice), local dev `/lesson-1.1`: 375px এ drawer খোলা bn/en — `landmark-unique` আর নেই; 1440px — clean। সব landmark এর নাম: bn "পড়ার ভাষা · কোর্সের curriculum · তোমার curriculum · এই lesson-এ · আগের আর পরের lesson", en এর মতো। Drawer খোলা অবস্থায় axe `landmark-one-main` আর `page-has-heading-one` (best-practice) দেখায় — এটা ইচ্ছাকৃত, কারণ SD-18 এ drawer খোলা থাকলে `main` inert করা হয়েছে (modal এর মতো); drawer বন্ধ থাকলে দুটোই নেই।

## SD-24 · TOC এর active section screen reader কে জানানো হয় না

- **Priority:** Low
- **Category:** Accessibility
- **Where:** `src/lib/docs/Toc.svelte` — `.toc a.active`
- **Found by:** DOM check — active link এ `aria-current` নেই
- **Problem:** চোখে দেখা highlight শুধু রঙে; screen reader জানে না কোন section এ আছে।
- **Expected:** Active link এ `aria-current="location"`।
- **How to test:** scroll করলে `aria-current` active link এর সাথে সরে।
- **Fix:** `src/lib/docs/Toc.svelte` এ প্রতিটা TOC link এ `aria-current={activeId === heading.id ? "location" : undefined}` — চোখে দেখা `.active` highlight যে state থেকে আসে, সেই একই `activeId` থেকে।
- **Tested:** Playwright 1440px `/lesson-5.4?lang=en`: শুরুতে, scrollY ৩০০০, ৯০০০, ২০০০০ এ, আর TOC link click এর পর — প্রতিবার ঠিক ১টা link এ `aria-current`, আর সেটাই `.active` link ("0. Where TaskFlow…" → "1.1 Learning to read EXPLAIN…" → "1.6 Selectivity…" → "7. Progress Ledger" → click এ "1.2 The first step…")। `prettier --check` pass।

## SD-25 · Print stylesheet নেই

- **Priority:** Low
- **Category:** UX
- **Where:** `src/routes/layout.css`
- **Found by:** Playwright `emulateMedia({ media: 'print' })` — topbar, sidebar, TOC, pagination, code copy toolbar সব print হয়
- **Problem:** Lesson বা answer key print/PDF করলে অর্ধেক পাতা navigation এ যায়, article সরু হয়ে থাকে।
- **Expected:** Print এ শুধু lesson header + article, পুরো চওড়া; `<details>` answer key খোলা; code block wrap হয়।
- **How to test:** print emulate করে screenshot আর PDF; chrome element গুলো `display: none`।
- **Fix:** `layout.css` এর শেষে `@media print` block: `@page { margin: 15mm }`; light token জোর করে (`:root:is([data-theme], :not([data-theme]))` — যেকোনো theme এ মেলে আর dark rule গুলোর পরে আসে, তাই dark mode থেকেও print এ কাগজে সাদা background + গাঢ় text); skip link, topbar, sidebar, backdrop, TOC (desktop + mobile), pagination, Markdown/সম্পন্ন/আরও উপায়ে button, code copy button লুকানো; workspace এর sidebar margin আর reader grid সরিয়ে article পুরো চওড়া; code block `pre-wrap` (কাটা যায় না) আর `print-color-adjust: exact` (syntax রঙ থাকে); scroll-shadow background বন্ধ; code/table/blockquote ভাঙে না, heading এর পর page break হয় না। `[slug]/+page.svelte` এ `beforeprint` এ article এর বন্ধ `<details>` (Answer Key) খোলে, `afterprint` এ শুধু ওইগুলো আবার বন্ধ করে।
- **Tested:** Playwright, dark theme (localStorage + OS dark), `/lesson-1.1?lang=en`: print media তে topbar/sidebar/TOC/pagination/copy button `display: none`, article left ০ আর পুরো চওড়া, body text `rgb(32,41,45)` সাদা background এ, `pre` → `pre-wrap`। `beforeprint` event → details [১ টা, খোলা ১], `afterprint` → আবার বন্ধ ০। A4 PDF (৭ পাতা) চোখে দেখে নেওয়া: হালকা পাতা, শুধু lesson, code block রঙিন। Headless `page.pdf()` নিজে `beforeprint` fire করে না (CDP এর সীমা), তাই event dispatch করে PDF বানালে "Answer Key / Question 1: Usually the database connections…" PDF এ আসে; আসল browser এর Ctrl+P `beforeprint` fire করে।

## SD-26 · `/search` আর `/llms.txt` এ কোনো cache header নেই

- **Priority:** Low
- **Category:** Performance
- **Where:** `src/routes/search/+server.ts`, `src/routes/llms.txt/+server.ts`
- **Found by:** `curl -D -` — `cache-control` নেই
- **Problem:** Content শুধু deploy এ বদলায়, তবু একই query (debounce করা প্রতিটা keystroke) প্রতিবার worker এ যায়।
- **Expected:** অল্প সময়ের public cache (যেমন `max-age=300`), `.md` route এর মতো।
- **How to test:** `curl -D -` এ header; unit/route check।
- **Fix:** `src/routes/search/+server.ts` আর `src/routes/llms.txt/+server.ts` এ `cache-control: public, max-age=300` — `.md` route এর মতোই। দুটোর ফল শুধু URL (`q`, `lang`) আর deploy এর উপর নির্ভর করে, cookie এর উপর না, তাই `Vary` লাগে না; ৫ মিনিট পরে নতুন deploy এর content আসে। নতুন `src/routes/search/server.spec.ts`।
- **Tested:** `bun run test` — ৩২/৩২ pass (নতুন ২টা: header + en result এর সব href `lang=en`; খালি আর এক অক্ষরের query তে `results: []`)। Local dev `curl -D -`: `/search?q=redis&lang=bn` আর `/llms.txt` দুটোতেই `cache-control: public, max-age=300`। `eslint` clean।

## SD-27 · `/caching`, `/load-balancing` alias এ temporary (307) redirect

- **Priority:** Low
- **Category:** SEO
- **Where:** `src/routes/(docs)/[slug]/+page.server.ts` — `redirect(307, …)`
- **Found by:** `curl` — `/caching` → 307 → `/lesson-4.1?lang=bn`
- **Problem:** Alias স্থায়ী, কিন্তু 307 বলে "সাময়িক" — search engine পুরনো URL রেখে দেয়, link equity সরে না।
- **Expected:** Permanent redirect (308)।
- **How to test:** `curl` — 308 + সঠিক `location`।
- **Fix:** `(docs)/[slug]/+page.server.ts`: alias redirect `307` → `308` (permanent)। সাথে একটা ঝুঁকি এড়ানো হয়েছে — browser permanent redirect cache করে, আর আগের target এ cookie থেকে `?lang=` বসত; cache হওয়া `/caching → ?lang=bn` পরে English এ চলে যাওয়া user এর cookie আবার bn করে দিত। তাই target এখন locale-neutral (`/lesson-4.1`, page নিজে cookie পড়ে); request URL এ বৈধ `?lang=bn|en` থাকলে শুধু তখন সেটা রাখা হয়। নতুন `page.server.spec.ts`।
- **Tested:** `bun run test` — ৩৫/৩৫ pass (নতুন ৩টা: `caching` আর `load-balancing` 308 + lang ছাড়া, cookie en হলেও; `?lang=en` থাকলে রাখে, `?lang=xx` বাদ দেয়; আসল lesson redirect হয় না)। Local dev `curl`: `/caching` → 308 `/lesson-4.1`, `/load-balancing` → 308 `/lesson-3.1`, `/caching?lang=en` → `/lesson-4.1?lang=en`; cookie `course-language=en` নিয়ে `/caching` follow করলে `<html lang="en">`, title "4.1 Cache Hierarchy"।

## SD-28 · Search placeholder এর contrast ২.৪৩:১ (light) / ৩.১০:১ (dark)

- **Priority:** Medium
- **Category:** Accessibility
- **Where:** topbar search input এর `::placeholder` — Tailwind preflight `color-mix(in oklab, currentColor 50%, transparent)` দেয়, `src/routes/layout.css` এ override নেই
- **Found by:** Live site screenshot থেকে pixel মেপে — light এ সবচেয়ে গাঢ় placeholder pixel `rgb(154,163,164)` on `rgb(246,249,246)` = ২.৪৩:১; dark এ `rgb(96,108,103)` on `rgb(23,30,26)` = ৩.১০:১। axe placeholder check করে না, তাই আগের দুই round এ ধরা পড়েনি।
- **Problem:** "কোন বিষয়টি খুঁজছো?" hint কম দৃষ্টিশক্তির user পড়তে পারে না; WCAG 1.4.3 (৪.৫:১) fail।
- **Expected:** দুই theme এ placeholder ≥ ৪.৫:১ (যেমন `--muted` token)।
- **How to test:** একই pixel measurement — light আর dark দুটোতেই ≥ ৪.৫:১।
- **Fix:** `layout.css` এ `.search-wrap input::placeholder { color: var(--muted); opacity: 1 }` — Tailwind preflight এর ৫০% `color-mix` এর বদলে theme token (Firefox placeholder এ নিজে opacity কমায়, তাই `opacity: 1`)। কাজ করতে গিয়ে আরেকটা জিনিস বেরোলো: typed text আগে থেকেই `--muted` ছিল (wrapper থেকে inherit), ফলে fix এর পর placeholder আর লেখা query একই রঙ হয়ে যেত — input এ `color: var(--ink)`, তাই লেখা text এখন স্বাভাবিক গাঢ় রঙে, hint হালকা।
- **Tested:** Local dev, screenshot pixel মেপে (সবচেয়ে গাঢ় placeholder pixel vs background): light bn/en 1440px আর bn 375px — ৪.৭৩–৪.৭৫:১ (আগে ২.৪৩:১); dark — ৫.৭২:১ (আগে ৩.১০:১)। Typed text: light `rgb(32,41,45)`, dark `rgb(221,229,224)` — placeholder থেকে আলাদা। Dark screenshot এ hint পরিষ্কার পড়া যায়। `prettier --check` pass।

## SD-29 · CSP তে `style-src 'unsafe-inline'` আছে, অথচ দরকার মাত্র একটা জায়গায়

- **Priority:** Low
- **Category:** Security
- **Where:** `vite.config.ts` এর `csp.directives['style-src']`; একমাত্র inline style `src/app.html` এর `<div style="display: contents">`
- **Found by:** বাইরের audit এর মন্তব্য, যাচাই করে দেখা হয়েছে — live HTML এ `<style>` tag ০টা, `style=""` attribute ১টা (ওই div)
- **Problem:** `'unsafe-inline'` থাকায় কেউ HTML এ `style` inject করতে পারলে (CSS-based data exfiltration, UI redress) CSP আটকায় না।
- **Expected:** ওই div এর style CSS এ সরিয়ে `'unsafe-inline'` বাদ; `bun run dev` এ Vite এর inline style কাজ করে কি না আলাদা করে দেখা।
- **How to test:** prod আর dev দুটোতেই CSP violation ০ (theme, search, nav, copy, print); inject করা `style` attribute/`<style>` block হয়।
- **Fix:** `src/app.html` এর `<div style="display: contents">` → `<div class="app-root">`, `layout.css` এ `.app-root { display: contents }`। CSP directive গুলো `vite.config.ts` থেকে নতুন `src/lib/server/csp.ts` এ (`satisfies` SvelteKit এর CSP type), `style-src` এখন শুধু `'self'`। Test এ ধরা পড়ল আরেকটা inline style: SvelteKit এর route announcer (`#svelte-announcer`, page বদলের কথা screen reader কে জানায়) এর template এ `style="…"` আছে, যা Svelte `innerHTML` দিয়ে বানায় — প্রতি page এ console এ CSP error দিচ্ছিল। আবার `'unsafe-inline'` খোলার বদলে শুধু ওই হুবহু style string টা অনুমোদন: `style-src-attr 'unsafe-hashes' 'sha256-S8qM…'` (Chrome এর বলা hash আর `.svelte-kit/generated/root.svelte` থেকে হিসাব করা hash একই)। নতুন `csp.spec.ts` — generated root থেকে announcer style পড়ে hash মেলায়, তাই SvelteKit upgrade এ style বদলালে test fail করবে; আর কোনো directive এ `unsafe-inline` নেই সেটাও দেখে। `bun run dev` এ SvelteKit নিজে `style-src` এ `unsafe-inline` যোগ করে (Vite এর HMR style এর জন্য), তাই dev অপরিবর্তিত।
- **Tested:** Production build (`wrangler dev`): header `style-src 'self'; style-src-attr 'unsafe-hashes' 'sha256-S8qM…'`। Playwright: normal load এ violation ০; ১১ ধাপের interaction (theme, search, client nav, Markdown/code copy, lesson, 404 ইত্যাদি) — violation ০, page error ০; announcer ১×১px লুকানো থাকে আর navigation এর পর "1.2 The Design Framework — System Design" ঘোষণা করে; `.app-root` computed `display: contents`, layout অপরিবর্তিত (sidebar ২৭২px, article left ৩০৮px)। Negative test: inject করা `<style>` (body লাল হয় না), `setAttribute("style")` আর `innerHTML` এর `style` — সব block (`style-src-elem`, `style-src-attr` ×২); JS `element.style` আগের মতো চলে। Sitemap এর ১৪৪টা page crawl — `style=""` বা `<style>` ০। Hash ইচ্ছা করে ভুল করলে `csp.spec.ts` fail করে (দেখা হয়েছে), ঠিক করলে ৩৭/৩৭ pass। `svelte-check` ০ error, `eslint` clean।

## SD-30 · Share preview এ কোনো image নেই (`og:image` / `twitter:image`)

- **Priority:** Low
- **Category:** SEO
- **Where:** `src/lib/docs/SocialMeta.svelte`
- **Found by:** বাইরের audit; live HTML এ `og:image`/`twitter:image` নেই (SD-07 এ জেনেশুনে বাদ ছিল, কারণ কোনো image ছিল না)
- **Problem:** Facebook/LinkedIn/X/Slack এ link শুধু text card হিসেবে আসে, চোখে কম পড়ে।
- **Expected:** একটা ১২০০×৬৩০ brand image (logo + "System Design Handbook", bn/en), `og:image` + `og:image:width/height/alt`, `twitter:card` → `summary_large_image`। প্রতি lesson এ আলাদা image বানানো (Worker এ render) আলাদা, বড় কাজ — আপাতত একটা static image।
- **How to test:** SSR HTML এ tag; image URL 200 `image/png`, সঠিক মাপ; কোনো OG validator / debugger এ preview।
- **Fix:** নতুন `static/og-bn.png` আর `static/og-en.png` (১২০০×৬৩০, ~১৭৫KB করে) — site এর নিজের brand: dark green background, layers logo, "systemdesign / THE LEARNING HANDBOOK", homepage এর headline (bn: "বড় system-এর চিন্তা। শুরু হোক ছোট থেকে।", en: "Think in systems. Start with the fundamentals."), একটা tagline আর "বাংলা · English" pill। HTML template থেকে headless Chrome এ site এর self-hosted font দিয়ে render করা। `SocialMeta.svelte` এ locale অনুযায়ী `og:image` (absolute URL), `og:image:type/width/height/alt`, `twitter:card` → `summary_large_image`, `twitter:image` + `twitter:image:alt` (alt = brand + headline, i18n `copy` থেকে)। আপাতত সব page এ একটা site-wide image; প্রতি lesson এর আলাদা image (Worker এ render) আলাদা কাজ।
- **Tested:** Render: দুই image এ font loaded (Inter, Noto Sans Bengali, JetBrains Mono), কোনো overflow নেই, চোখে দেখে নেওয়া (প্রথম version এর "English · EN" pill বদলে "English · বাংলা")। Production build (`wrangler dev`): `/og-bn.png`, `/og-en.png` 200 `image/png`; `/?lang=bn`, `/lesson-5.4?lang=en`, `/lesson-1-challenge` এর SSR HTML এ সব tag, locale অনুযায়ী ঠিক image; bn lesson এ `og-bn.png` → EN switch (client nav) এর পর `og-en.png`, tag একটাই। axe ৪ mode = ০, CSP ১১ ধাপ = ০ violation। `prettier`/`eslint`/`svelte-check`/test ৩৭/৩৭/build pass। Deploy এর পর আসল preview দেখতে Facebook Sharing Debugger / LinkedIn Post Inspector এ URL দেওয়া যাবে — localhost এ সেটা সম্ভব না।
