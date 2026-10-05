<script lang="ts">
	import type { Locale } from './i18n';
	let {
		title,
		description,
		url,
		locale,
		type
	}: {
		title: string;
		description: string;
		url: string;
		locale: Locale;
		type: 'website' | 'article';
	} = $props();
	const ogLocale = { bn: 'bn_BD', en: 'en_US' } as const;
</script>

<svelte:head>
	<meta property="og:type" content={type} />
	<meta property="og:site_name" content="System Design Handbook" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:locale" content={ogLocale[locale]} />
	<meta property="og:locale:alternate" content={ogLocale[locale === 'bn' ? 'en' : 'bn']} />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
</svelte:head>
