<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import Icon from '$lib/docs/Icon.svelte';
	import { copy, localizedHref } from '$lib/docs/i18n';
	import { courseProgress } from '$lib/docs/progress.svelte';
	type SearchResult = { id: string; title: string; href: string; snippet: string };
	let { data, children } = $props();
	const t = $derived(copy[data.locale]);
	let query = $state('');
	let mobileOpen = $state(false);
	let searchInput: HTMLInputElement;
	let searchWrap: HTMLDivElement;
	let expanded = $state<Record<number, boolean>>({});
	let searchResults = $state<SearchResult[]>([]);
	let searching = $state(false);
	let theme = $state<'light' | 'dark' | null>(null);
	const allLessons = $derived(data.modules.flatMap((m) => m.lessons));
	const active = $derived(allLessons.find((l) => l.href.split('?')[0] === page.url.pathname));
	const effectiveTheme = $derived<'light' | 'dark'>(
		theme ??
			(browser && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
	);
	afterNavigate(() => {
		mobileOpen = false;
		query = '';
	});
	$effect(() => {
		const q = query.trim();
		if (!browser || !q) {
			searchResults = [];
			searching = false;
			return;
		}
		searching = true;
		let cancelled = false;
		const timer = setTimeout(() => {
			fetch(`/search?q=${encodeURIComponent(q)}&lang=${data.locale}`)
				.then((res) => res.json() as Promise<{ results: SearchResult[] }>)
				.then((body) => {
					if (!cancelled) searchResults = body.results;
				})
				.catch(() => {
					if (!cancelled) searchResults = [];
				})
				.finally(() => {
					if (!cancelled) searching = false;
				});
		}, 180);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});
	$effect(() => {
		if (!browser) return;
		try {
			const saved = localStorage.getItem('course-theme');
			if (saved === 'light' || saved === 'dark') theme = saved;
		} catch {
			// storage unavailable — fall back to system theme
		}
	});
	function toggle(id: number) {
		expanded = { ...expanded, [id]: !(expanded[id] ?? active?.moduleId === id) };
	}
	function toggleTheme() {
		const next = effectiveTheme === 'dark' ? 'light' : 'dark';
		theme = next;
		document.documentElement.setAttribute('data-theme', next);
		try {
			localStorage.setItem('course-theme', next);
		} catch {
			// storage unavailable — theme choice just won't persist across visits
		}
	}
	function closeSearchOutside(event: MouseEvent) {
		if (query.trim() && searchWrap && !searchWrap.contains(event.target as Node)) query = '';
	}
	function keys(event: KeyboardEvent) {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			searchInput?.focus();
		}
		if (event.key === 'Escape') {
			query = '';
			mobileOpen = false;
			searchInput?.blur();
		}
	}
</script>

<svelte:window onkeydown={keys} onclick={closeSearchOutside} />
<svelte:head
	><meta
		name="description"
		content="বাংলায় System Design: fundamentals থেকে distributed systems, practical lessons ও interview preparation।"
	/></svelte:head
>
<a class="skip-link" href="#main-content">{t.skip}</a>
<header class="topbar">
	<a class="brand" href={localizedHref('/', data.locale)} aria-label="System Design home"
		><span class="brand-mark"><Icon name="layers" size={22} /></span><span
			>system<span class="brand-light">design</span><small>THE LEARNING HANDBOOK</small></span
		></a
	>
	<div class="search-wrap" bind:this={searchWrap}>
		<Icon name="search" size={18} /><input
			bind:this={searchInput}
			bind:value={query}
			aria-label="Search lessons"
			placeholder={t.search}
			autocomplete="off"
		/><kbd>⌘ K</kbd>
		{#if query.trim()}
			<div class="search-results">
				<div class="search-caption">
					{searching ? t.searching : t.found(searchResults.length)}
				</div>
				{#each searchResults as result (result.id)}<a href={result.href}
						><span class="result-row"
							><span class="mono">{result.id}</span><span>{result.title}</span></span
						>{#if result.snippet}<span class="result-snippet">{result.snippet}</span>{/if}<Icon
							name="arrow"
							size={15}
						/></a
					>{/each}
				{#if !searching && !searchResults.length}<p>{t.noResults}</p>{/if}
			</div>
		{/if}
	</div>
	<nav class="language-switch" aria-label="Reading language">
		<a
			href={localizedHref(page.url.pathname, 'bn')}
			class:selected={data.locale === 'bn'}
			aria-current={data.locale === 'bn' ? 'true' : undefined}>বাংলা</a
		><a
			href={localizedHref(page.url.pathname, 'en')}
			class:selected={data.locale === 'en'}
			aria-current={data.locale === 'en' ? 'true' : undefined}>EN</a
		>
	</nav>
	<button
		class="icon-button theme-toggle"
		aria-label={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
		onclick={toggleTheme}
		><Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} size={18} /></button
	>
	<button
		class="icon-button mobile-toggle"
		aria-label={mobileOpen ? 'Close curriculum' : 'Open curriculum'}
		aria-expanded={mobileOpen}
		onclick={() => (mobileOpen = !mobileOpen)}
		><Icon name={mobileOpen ? 'close' : 'menu'} size={18} /></button
	>
</header>
{#if mobileOpen}<button
		class="nav-backdrop"
		aria-label="Close curriculum"
		onclick={() => (mobileOpen = false)}
	></button>{/if}
<aside class:mobile-open={mobileOpen} class="sidebar" aria-label="Course curriculum">
	<div class="sidebar-inner">
		<div class="sidebar-caption">YOUR LEARNING SPACE</div>
		<a
			class:current={!active && page.url.pathname === '/'}
			class="overview-link"
			href={localizedHref('/', data.locale)}
			><Icon name="grid" size={17} />{t.overview}<Icon name="arrow" size={15} /></a
		>
		<div class="sidebar-caption curriculum-caption">
			CURRICULUM <span>{data.modules.length} MODULES</span>
		</div>
		<nav>
			{#each data.modules as module (module.id)}
				{@const open = expanded[module.id] ?? active?.moduleId === module.id}
				<div class="nav-module" class:module-active={active?.moduleId === module.id}>
					<button class="module-toggle" aria-expanded={open} onclick={() => toggle(module.id)}
						><span class="module-number">{String(module.id).padStart(2, '0')}</span><span
							>{module.title}</span
						><span class:rotated={open} class="nav-chevron"><Icon name="chevron" size={13} /></span
						></button
					>
					{#if open}<div class="lesson-links">
							{#each module.lessons as lesson (lesson.id)}<a
									href={lesson.href}
									class:active={active?.id === lesson.id}
									aria-current={active?.id === lesson.id ? 'page' : undefined}
									><span class="lesson-number">{lesson.kind === 'challenge' ? '◇' : lesson.id}</span
									><span class="nav-lesson-title" title={lesson.title}
										>{lesson.title.split(' — ')[0]}</span
									>{#if lesson.available && courseProgress.isCompleted(lesson.id)}<span
											class="lesson-done"
											aria-label="Completed"
											title="Completed"><Icon name="check" size={11} /></span
										>{:else if !lesson.available}<span class="pending-dot" aria-label="Coming soon"
										></span>{/if}</a
								>{/each}
						</div>{/if}
				</div>
			{/each}
		</nav>
		<div class="sidebar-footer">
			<Icon name="code" size={18} /><span
				>Understand the why.<br /><strong>Then build the how.</strong></span
			>
		</div>
	</div>
</aside>
<main id="main-content" class="workspace" tabindex="-1">{@render children()}</main>
