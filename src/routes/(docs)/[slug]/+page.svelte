<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/docs/Icon.svelte';
	import { copy, localizedHref } from '$lib/docs/i18n';
	import { courseProgress } from '$lib/docs/progress.svelte';
	import Toc from '$lib/docs/Toc.svelte';
	let { data } = $props();
	const t = $derived(copy[data.locale]);
	const titleParts = $derived(data.lesson.title.split(' — '));
	let copyState = $state<'idle' | 'copied' | 'error'>('idle');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const mdUrl = $derived(`${page.url.origin}${page.url.pathname}.md?lang=${data.locale}`);
	const isDone = $derived(courseProgress.isCompleted(data.lesson.id));
	const aiPrompt = $derived(
		`Read ${mdUrl} and help me understand it — I'm learning system design.`
	);
	const schema = $derived(
		data.lesson.available
			? {
					'@context': 'https://schema.org',
					'@type': 'LearningResource',
					name: titleParts[0],
					description: `${data.module.title} — ${data.lesson.title}`,
					inLanguage: data.locale,
					learningResourceType: data.lesson.kind === 'challenge' ? 'Exercise' : 'Lesson',
					isPartOf: { '@type': 'Course', name: 'System Design Handbook', url: page.url.origin },
					url: `${page.url.origin}${page.url.pathname}`
				}
			: null
	);
	const schemaScript = $derived(
		schema
			? // Escaping keeps this component's own <script> block from ending early — Svelte
				// finds its closing tag textually, not JS-string-aware.
				// eslint-disable-next-line no-useless-escape
				`<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}<\/script>`
			: ''
	);
	$effect(() => {
		void data.lesson.id;
		void data.locale;
		copyState = 'idle';
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (data.lesson.available) courseProgress.visit(data.lesson.id);
	});
	async function copyMarkdown() {
		try {
			await navigator.clipboard.writeText(data.raw);
			copyState = 'copied';
		} catch {
			copyState = 'error';
		}
		clearTimeout(timer);
		timer = setTimeout(() => (copyState = 'idle'), 2200);
	}
	function enhanceCode(node: HTMLElement) {
		const cleanups: (() => void)[] = [];
		function setup() {
			for (const pre of node.querySelectorAll('pre')) {
				const code = pre.querySelector('code');
				if (!code) continue;
				const toolbar = document.createElement('div');
				toolbar.className = 'code-toolbar';
				const label = document.createElement('span');
				label.textContent = code.className.replace('language-', '') || 'text';
				const button = document.createElement('button');
				button.type = 'button';
				button.textContent = t.codeCopy;
				let timeout: ReturnType<typeof setTimeout>;
				async function click() {
					try {
						await navigator.clipboard.writeText(code?.textContent ?? '');
						button.textContent = t.codeCopied;
					} catch {
						button.textContent = t.copyError;
					}
					clearTimeout(timeout);
					timeout = setTimeout(() => (button.textContent = t.codeCopy), 2000);
				}
				button.addEventListener('click', click);
				toolbar.appendChild(label);
				toolbar.appendChild(button);
				pre.parentNode?.insertBefore(toolbar, pre);
				cleanups.push(() => {
					clearTimeout(timeout);
					button.removeEventListener('click', click);
					toolbar.remove();
				});
			}
		}
		setup();
		return {
			destroy() {
				cleanups.forEach((fn) => fn());
			}
		};
	}
</script>

<svelte:head
	><title>{data.lesson.title} — System Design</title><meta
		name="description"
		content={`${data.module.title} — ${data.lesson.title}. System Design Handbook.`}
	/><link
		rel="alternate"
		hreflang="bn"
		href={`${page.url.origin}${localizedHref(page.url.pathname, 'bn')}`}
	/><link
		rel="alternate"
		hreflang="en"
		href={`${page.url.origin}${localizedHref(page.url.pathname, 'en')}`}
	/>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- schemaScript is our own JSON.stringify output (lesson title + static copy, never user input), with "<" escaped -->
	{@html schemaScript}</svelte:head
>
<div class="reader-page">
	<div class="breadcrumb">
		<a href={localizedHref('/', data.locale)}><Icon name="book" size={15} /></a><a
			href={localizedHref('/#curriculum', data.locale)}>{t.overview}</a
		><span>/</span><strong>{data.module.title}</strong>
	</div>
	<div class="reader-grid">
		<div class="reader-main">
			<header class="lesson-header">
				<div class="lesson-kicker">
					{data.lesson.kind === 'challenge' ? t.challenge : `${t.lesson} ${data.lesson.id}`}
				</div>
				<h1>{titleParts[0]}</h1>
				{#if titleParts.length > 1}<p class="lesson-subtitle">
						{titleParts.slice(1).join(' — ')}
					</p>{/if}
				<div class="lesson-meta">
					<span><Icon name="book" size={15} />{data.locale === 'bn' ? 'বাংলা' : 'English'}</span
					>{#if data.lesson.available}<span
							><Icon name="clock" size={15} />{data.lesson.minutes} {t.read}</span
						><button class="copy-markdown" onclick={copyMarkdown}
							><Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} /><span
								aria-live="polite"
								>{copyState === 'copied'
									? t.copied
									: copyState === 'error'
										? t.copyError
										: t.copy}</span
							></button
						><button
							class="mark-complete"
							class:done={isDone}
							aria-pressed={isDone}
							onclick={() => courseProgress.toggle(data.lesson.id)}
							><Icon name="check" size={14} /><span
								>{isDone ? t.markIncomplete : t.markComplete}</span
							></button
						>
						<details class="ai-actions">
							<summary>{t.moreWays}</summary>
							<div class="ai-actions-menu">
								<a href={`${page.url.pathname}.md${page.url.search}`} target="_blank" rel="noopener"
									><Icon name="external" size={13} />{t.viewMarkdown}</a
								><a
									href={`https://chatgpt.com/?q=${encodeURIComponent(aiPrompt)}`}
									target="_blank"
									rel="noopener"><Icon name="external" size={13} />{t.openChatGPT}</a
								><a
									href={`https://claude.ai/new?q=${encodeURIComponent(aiPrompt)}`}
									target="_blank"
									rel="noopener"><Icon name="external" size={13} />{t.openClaude}</a
								>
							</div>
						</details>{:else}<span>{t.coming}</span>{/if}
				</div>
			</header>
			{#if data.lesson.available}
				{#if data.headings.length}<details class="mobile-toc">
						<summary>{t.onPage}</summary>
						<nav>
							{#each data.headings as heading (heading.id)}<a href={`#${heading.id}`}
									>{heading.text}</a
								>{/each}
						</nav>
					</details>{/if}
				{#key `${data.lesson.id}:${data.locale}:${data.html}`}<article
						class="doc-content"
						use:enhanceCode
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- data.html is server-rendered through sanitize-html (render.ts), never raw user input -->
						{@html data.html}
					</article>{/key}
			{:else}
				<section class="empty-lesson">
					<div class="empty-icon"><Icon name="book" size={28} /></div>
					<span class="eyebrow"
						>{data.lesson.otherAvailable ? 'TRANSLATION IN PROGRESS' : 'IN THE CURRICULUM'}</span
					>
					<h2>{data.lesson.otherAvailable ? t.translation : t.notReady}</h2>
					<p>{data.lesson.otherAvailable ? t.translationBody : t.notReadyBody}</p>
					<div class="empty-actions">
						{#if data.lesson.otherAvailable}<a
								class="primary-button"
								href={localizedHref(
									`/lesson-${data.lesson.id}`,
									data.locale === 'bn' ? 'en' : 'bn'
								)}>{t.otherLanguage}<Icon name="arrow" size={17} /></a
							>{/if}<a class="text-link" href={localizedHref('/#curriculum', data.locale)}
							>{t.overviewBack} <Icon name="arrow" size={15} /></a
						>
					</div>
				</section>
			{/if}
			<nav class="lesson-pagination" aria-label="Lesson navigation">
				{#if data.previous}<a href={data.previous.href}
						><span>← {t.prev}</span><strong
							>{data.previous.kind === 'lesson' ? data.previous.id : '◇'}
							<span>{data.previous.title}</span></strong
						></a
					>{:else}<div></div>{/if}
				{#if data.next}<a class="next-lesson" href={data.next.href}
						><span>{t.next} →</span><strong
							>{data.next.kind === 'lesson' ? data.next.id : '◇'}
							<span>{data.next.title}</span></strong
						></a
					>{/if}
			</nav>
			<footer class="page-footer">
				<span>System Design Handbook</span><span>{t.footer}</span>
			</footer>
		</div>
		<aside class="reader-aside">
			{#if data.lesson.available}<Toc headings={data.headings} locale={data.locale} />{/if}
		</aside>
	</div>
</div>
