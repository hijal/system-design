<script lang="ts">
	import { copy, type Locale } from './i18n';
	import type { Heading } from '$lib/server/course/render';
	let { headings, locale }: { headings: Heading[]; locale: Locale } = $props();
	const sections = $derived(
		headings.some((h) => h.level === 2) ? headings.filter((h) => h.level === 2) : headings
	);
	let activeId = $state('');
	let progress = $state(0);
	$effect(() => {
		const items = sections;
		function update() {
			const article = document.querySelector('.doc-content');
			if (!article) return;
			const top = article.getBoundingClientRect().top + window.scrollY;
			const distance = article.scrollHeight - (window.innerHeight - 150);
			progress = Math.max(
				0,
				Math.min(100, Math.round(((window.scrollY - top + 150) / Math.max(1, distance)) * 100))
			);
			let current = items[0]?.id ?? '';
			for (const item of items) {
				const el = document.getElementById(item.id);
				if (el && el.getBoundingClientRect().top <= 175) current = item.id;
			}
			activeId = current;
		}
		const raf = requestAnimationFrame(update);
		window.addEventListener('scroll', update, { passive: true });
		window.addEventListener('resize', update);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('scroll', update);
			window.removeEventListener('resize', update);
		};
	});
</script>

{#if headings.length}<div class="toc">
		<div class="toc-label">{copy[locale].onPage}</div>
		<nav aria-label={copy[locale].onPage}>
			{#each sections as heading (heading.id)}<a
					class:active={activeId === heading.id}
					class:subheading={heading.level === 3}
					href={`#${heading.id}`}>{heading.text}</a
				>{/each}
		</nav>
		<div class="read-progress">
			<span>{copy[locale].readProgress}</span><span>{progress}%</span><progress
				value={progress}
				max="100"
				aria-label={copy[locale].readProgress}
			></progress>
		</div>
	</div>{/if}
