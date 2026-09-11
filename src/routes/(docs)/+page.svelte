<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/docs/Icon.svelte';
	import { copy, moduleDescriptions, localizedHref } from '$lib/docs/i18n';
	import { courseProgress } from '$lib/docs/progress.svelte';
	let { data } = $props();
	const lessons = $derived(
		data.modules.flatMap((m) => m.lessons).filter((l) => l.kind === 'lesson')
	);
	const available = $derived(lessons.filter((l) => l.available));
	const availableOther = $derived(lessons.filter((l) => !l.available && l.otherAvailable));
	const t = $derived(copy[data.locale]);
	const descriptions = $derived(moduleDescriptions[data.locale]);
	const allLessons = $derived(data.modules.flatMap((m) => m.lessons));
	const continueLesson = $derived(
		allLessons.find((l) => l.id === courseProgress.lastVisited && l.available)
	);
	const completedCount = $derived(lessons.filter((l) => courseProgress.isCompleted(l.id)).length);
	const schema = $derived({
		'@context': 'https://schema.org',
		'@type': 'Course',
		name: 'System Design Handbook',
		description: t.intro,
		inLanguage: data.locale,
		url: `${page.url.origin}/`,
		provider: { '@type': 'Organization', name: 'System Design Handbook' }
	});
	const schemaScript = $derived(
		// eslint-disable-next-line no-useless-escape
		`<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}<\/script>`
	);
</script>

<svelte:head>
	<title>{t.title}</title>
	<link rel="alternate" hreflang="bn" href={`${page.url.origin}${localizedHref('/', 'bn')}`} />
	<link rel="alternate" hreflang="en" href={`${page.url.origin}${localizedHref('/', 'en')}`} />
	<link
		rel="alternate"
		hreflang="x-default"
		href={`${page.url.origin}${localizedHref('/', 'bn')}`}
	/>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- schemaScript is our own JSON.stringify output (curriculum titles + static copy, never user input), with "<" escaped -->
	{@html schemaScript}
</svelte:head>
<div class="overview-page">
	<div class="breadcrumb">
		<Icon name="book" size={15} /><span>The handbook</span><span>/</span><strong>Overview</strong>
	</div>
	<section class="intro">
		<div class="eyebrow"><span></span> A PRACTICAL GUIDE TO SYSTEM DESIGN</div>
		<h1>{t.intro1}<br /><span>{t.intro2}</span></h1>
		<p>{t.intro}</p>
		<div class="intro-actions">
			<a
				class="primary-button"
				href={available[0]?.href ?? localizedHref('/lesson-1.1', data.locale)}
				>{t.start} <Icon name="arrow" size={18} /></a
			><a class="text-link" href="#curriculum">{t.curriculumLink} <span>↗</span></a>
		</div>
		<div class="course-facts">
			<span><Icon name="layers" size={17} /><strong>{data.modules.length}</strong> modules</span
			><span><Icon name="book" size={17} /><strong>{lessons.length}</strong> lessons</span><span
				><Icon name="code" size={17} />TypeScript-first</span
			><span class="fact-language">{t.language}</span>
		</div>
		{#if completedCount > 0 || continueLesson}
			<div class="progress-strip">
				<div class="progress-strip-stat">
					<span class="progress-strip-number">{completedCount}</span><span
						class="progress-strip-total">/{available.length}</span
					>
					<progress value={completedCount} max={Math.max(1, available.length)}></progress>
				</div>
				{#if continueLesson}<a class="continue-link" href={continueLesson.href}
						>{t.continueReading}<Icon name="arrow" size={16} /></a
					>{/if}
			</div>
		{/if}
	</section>
	<section class="learning-note">
		<div class="note-icon"><Icon name="spark" size={22} /></div>
		<div>
			<strong>{t.journey}</strong>
			<p>{t.journeyBody}</p>
		</div>
		<span class="note-label">WHY → HOW</span>
	</section>
	<section id="curriculum" class="curriculum-section">
		<div class="section-heading">
			<div>
				<div class="eyebrow">THE LEARNING PATH</div>
				<h2>{t.curriculum}</h2>
			</div>
			<div class="section-heading-counts">
				<span>{t.readyCount(available.length)}</span>
				{#if availableOther.length}<span class="ready-other-note"
						>{t.availableOtherCount(availableOther.length)}</span
					>{/if}
			</div>
		</div>
		<div class="module-grid">
			{#each data.modules as module (module.id)}
				{@const ready = module.lessons.filter((l) => l.kind === 'lesson' && l.available).length}
				{@const readyOther = module.lessons.filter(
					(l) => l.kind === 'lesson' && !l.available && l.otherAvailable
				).length}
				{@const count = module.lessons.filter((l) => l.kind === 'lesson').length}
				<a class="module-card" href={module.lessons[0]?.href ?? '/'}>
					<div class="card-top">
						<span class="card-number">{String(module.id).padStart(2, '0')}</span><span
							class="card-stage"
							>{module.id <= 3
								? 'FOUNDATIONS'
								: module.id <= 8
									? 'CORE CONCEPTS'
									: 'PUT IT INTO PRACTICE'}</span
						><Icon name="arrow" size={18} />
					</div>
					<h3>{module.title}</h3>
					<p>{descriptions[module.id] ?? 'Concept, practice আর design trade-off—ধাপে ধাপে।'}</p>
					<div class="card-bottom">
						<span><Icon name="book" size={14} />{count} lessons</span><span
							class:ready={ready > 0}
							class:ready-other={ready === 0 && readyOther > 0}
							>{ready ? t.ready(ready) : readyOther ? t.readyOther(readyOther) : t.coming}</span
						>
					</div>
				</a>
			{/each}
		</div>
	</section>
	<footer class="page-footer"><span>System Design Handbook</span><span>{t.footer}</span></footer>
</div>
