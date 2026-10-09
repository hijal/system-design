<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
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
	let mobileToggle: HTMLButtonElement;
	let expanded = $state<Record<number, boolean>>({});
	let searchResults = $state<SearchResult[]>([]);
	let searchTotal = $state(0);
	const tooShort = $derived(query.trim().length < 2);
	let searching = $state(false);
	let activeResult = $state(-1);
	let shortcutKey = $state('Ctrl');
	let theme = $state<'light' | 'dark' | null>(null);
	const allLessons = $derived(data.modules.flatMap((m) => m.lessons));
	const active = $derived(allLessons.find((l) => l.href.split('?')[0] === page.url.pathname));
	let systemDark = $state(false);
	const effectiveTheme = $derived<'light' | 'dark'>(theme ?? (systemDark ? 'dark' : 'light'));
	onMount(() => {
		courseProgress.load();
		if (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) shortcutKey = '⌘';
	});
	afterNavigate(() => {
		mobileOpen = false;
		query = '';
	});
	$effect(() => {
		const q = query.trim();
		activeResult = -1;
		if (!browser || q.length < 2) {
			searchResults = [];
			searchTotal = 0;
			searching = false;
			return;
		}
		searching = true;
		let cancelled = false;
		const timer = setTimeout(() => {
			fetch(`/search?q=${encodeURIComponent(q)}&lang=${data.locale}`)
				.then((res) => res.json() as Promise<{ results: SearchResult[]; total: number }>)
				.then((body) => {
					if (cancelled) return;
					searchResults = body.results;
					searchTotal = body.total;
				})
				.catch(() => {
					if (cancelled) return;
					searchResults = [];
					searchTotal = 0;
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
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const sync = () => (systemDark = media.matches);
		sync();
		media.addEventListener('change', sync);
		return () => media.removeEventListener('change', sync);
	});
	$effect(() => {
		if (!browser) return;
		try {
			const saved = localStorage.getItem('course-theme');
			if (saved === 'light' || saved === 'dark') theme = saved;
		} catch {
			// storage unavailable - fall back to system theme
		}
	});
	function toggle(id: number) {
		expanded = { ...expanded, [id]: !(expanded[id] ?? active?.moduleId === id) };
	}
	const themeColors = { light: '#ffffff', dark: '#0d1210' } as const;
	function toggleTheme() {
		const next = effectiveTheme === 'dark' ? 'light' : 'dark';
		theme = next;
		document.documentElement.setAttribute('data-theme', next);
		for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
			meta.content = themeColors[next];
		try {
			localStorage.setItem('course-theme', next);
		} catch {
			// storage unavailable - theme choice just won't persist across visits
		}
	}
	function navigateResults(event: KeyboardEvent) {
		const count = searchResults.length;
		if (!count || searching) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			activeResult =
				activeResult < 0 ? (step > 0 ? 0 : count - 1) : (activeResult + step + count) % count;
			document
				.getElementById(`search-result-${activeResult}`)
				?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter') {
			event.preventDefault();
			document.getElementById(`search-result-${Math.max(0, activeResult)}`)?.click();
		}
	}
	function closeMobileNav() {
		mobileOpen = false;
		mobileToggle?.focus({ preventScroll: true });
	}
	$effect(() => {
		document.documentElement.classList.toggle('nav-locked', mobileOpen);
	});
	$effect(() => {
		const wide = window.matchMedia('(width > 850px)');
		const close = () => {
			if (wide.matches) mobileOpen = false;
		};
		wide.addEventListener('change', close);
		return () => wide.removeEventListener('change', close);
	});
	function closeSearchOnFocusLeave(event: FocusEvent) {
		if (event.relatedTarget instanceof Node && !searchWrap.contains(event.relatedTarget))
			query = '';
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
			searchInput?.blur();
			if (mobileOpen) closeMobileNav();
		}
	}
</script>

<svelte:window onkeydown={keys} onclick={closeSearchOutside} />
<a class="skip-link" href="#main-content">{t.skip}</a>
<header class="topbar">
	<a class="brand" href={localizedHref('/', data.locale)}
		><span class="brand-mark"><Icon name="layers" size={22} /></span><span
			>system<span class="brand-light">design</span> <small>THE LEARNING HANDBOOK</small></span
		></a
	>
	<div class="search-wrap" bind:this={searchWrap} onfocusout={closeSearchOnFocusLeave}>
		<Icon name="search" size={18} /><input
			bind:this={searchInput}
			bind:value={query}
			role="combobox"
			aria-label={t.searchLabel}
			aria-autocomplete="list"
			aria-expanded={!!query.trim()}
			aria-controls={query.trim() ? 'search-listbox' : undefined}
			aria-activedescendant={activeResult >= 0 ? `search-result-${activeResult}` : undefined}
			onkeydown={navigateResults}
			placeholder={t.search}
			maxlength={100}
			autocomplete="off"
		/><kbd>{shortcutKey} K</kbd>
		{#if query.trim()}
			<div class="search-results">
				<div class="search-caption" role="status">
					{tooShort
						? t.typeMore
						: searching
							? t.searching
							: searchTotal > searchResults.length
								? t.foundSome(searchResults.length, searchTotal)
								: t.found(searchResults.length)}
				</div>
				<div id="search-listbox" role="listbox" tabindex="-1" aria-label={t.searchResults}>
					{#each searchResults as result, i (result.id)}<a
							id={`search-result-${i}`}
							role="option"
							tabindex="-1"
							onmousedown={(event) => event.preventDefault()}
							aria-selected={i === activeResult}
							class:active={i === activeResult}
							href={result.href}
							><span class="result-row"
								><span class="mono">{result.id}</span><span>{result.title}</span></span
							>{#if result.snippet}<span class="result-snippet">{result.snippet}</span>{/if}<Icon
								name="arrow"
								size={15}
							/></a
						>{/each}
				</div>
				{#if !tooShort && !searching && !searchResults.length}<p>{t.noResults}</p>{/if}
			</div>
		{/if}
	</div>
	<nav class="language-switch" aria-label={t.readingLanguage}>
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
		aria-label={effectiveTheme === 'dark' ? t.toLightTheme : t.toDarkTheme}
		onclick={toggleTheme}
		><span class="theme-icon-sun"><Icon name="sun" size={18} /></span><span class="theme-icon-moon"
			><Icon name="moon" size={18} /></span
		></button
	>
	<button
		bind:this={mobileToggle}
		class="icon-button mobile-toggle"
		aria-label={mobileOpen ? t.closeNav : t.openNav}
		aria-expanded={mobileOpen}
		onclick={() => (mobileOpen = !mobileOpen)}
		><Icon name={mobileOpen ? 'close' : 'menu'} size={18} /></button
	>
</header>
{#if mobileOpen}<button class="nav-backdrop" aria-label={t.closeNav} onclick={closeMobileNav}
	></button>{/if}
<aside class:mobile-open={mobileOpen} class="sidebar" aria-label={t.curriculumNav}>
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
		<nav aria-label={t.curriculum}>
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
										>{lesson.title.split(' - ')[0]}</span
									>{#if lesson.available && courseProgress.isCompleted(lesson.id)}<span
											class="lesson-done"
											aria-label={t.completed}
											title={t.completed}><Icon name="check" size={11} /></span
										>{:else if !lesson.available}<span class="pending-dot" aria-label={t.coming}
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
<main id="main-content" class="workspace" tabindex="-1" inert={mobileOpen}>
	{@render children()}
</main>
