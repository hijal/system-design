<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/docs/Icon.svelte';
	import { localizedHref } from '$lib/docs/i18n';
	const locale = $derived(page.data.locale ?? 'bn');
	const notFound = $derived(page.status === 404);
	const heading = $derived(
		locale === 'bn'
			? notFound
				? 'এই পাতাটি পাওয়া যায়নি।'
				: 'কিছু একটা ভুল হয়েছে।'
			: notFound
				? 'This page could not be found.'
				: 'Something went wrong.'
	);
</script>

<svelte:head><title>{page.status} — System Design</title></svelte:head>
<div class="reader-page">
	<section class="empty-lesson error-state">
		<div class="eyebrow">{page.status}</div>
		<h1>{heading}</h1>
		<p>{page.error?.message}</p>
		<a class="primary-button" href={localizedHref('/', locale)}
			>{locale === 'bn' ? 'Curriculum-এ ফিরে যাও' : 'Back to curriculum'}<Icon
				name="arrow"
				size={17}
			/></a
		>
	</section>
</div>
