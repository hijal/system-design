# System Design Handbook

A bilingual Bangla / English course reader built with SvelteKit 2, Svelte 5, TypeScript, and Tailwind CSS. `course/main.md` is the source of truth for module names, lesson order, and exit challenges.

## Development

```sh
bun install
bun run dev
```

## Add course content

1. Keep the module and lesson entry in the Curriculum section of `course/main.md`.
2. Add the numbered Markdown file inside its `course/module-*` directory:

```text
course/module-01-fundamentals-and-thinking-framework/
  lesson-1.1-what-is-system-design.md      # Bangla (existing convention)
  lesson-1.1-what-is-system-design.en.md   # English
  module-1-exit-challenge.md              # Bangla challenge
  module-1-exit-challenge.en.md           # English challenge
```

An explicit `.bn.md` suffix is also supported instead of the unsuffixed Bangla file. Do not keep both for the same lesson: duplicate language/number pairs are rejected to avoid silently loading the wrong file. The descriptive part of the filename can change; links use only the lesson number.

- Bangla: `/lesson-1.1?lang=bn`
- English: `/lesson-1.1?lang=en`
- Exit challenge: `/lesson-1-challenge?lang=bn`

The language switch keeps the current lesson and remembers the selection in a cookie. An untranslated lesson displays an availability message and links to the other edition when available; it never presents Bangla as an English translation.

The file's first `#` heading is optional and is omitted from the article to avoid duplicating the page title. Bangla titles come from the base curriculum; English display titles are in `src/lib/docs/i18n.ts`. For newly added English lessons without a display title in that map, the English Markdown heading supplies the title.

A file containing only its heading is treated as an upcoming lesson. Adding body text makes it available automatically. Use `##` / `###` headings for the table of contents. Markdown tables, syntax-highlighted code fences, safe HTML `<details>` / `<summary>` answer keys, and relative links to other numbered Markdown files are supported. Unsafe scripts and event handlers are stripped.

During development, Vite watches content changes. For an already deployed site, build and deploy again to publish new content. No route or sidebar edits are needed.

## Validation

```sh
bun run check
bun run test:unit -- --run --project server
bun run build
```

## Cloudflare Workers

The existing Cloudflare adapter and Wrangler configuration are retained.

```sh
bun run deploy
```
