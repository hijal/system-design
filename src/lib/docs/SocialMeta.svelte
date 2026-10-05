<script lang="ts">
	import { copy, type Locale } from './i18n';
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
	const image = $derived(`${new URL(url).origin}/og-${locale}.png`);
	const imageAlt = $derived(
		`System Design Handbook — ${copy[locale].intro1} ${copy[locale].intro2}`
	);
</script>

<svelte:head>
	<meta property="og:type" content={type} />
	<meta property="og:site_name" content="System Design Handbook" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:locale" content={ogLocale[locale]} />
	<meta property="og:locale:alternate" content={ogLocale[locale === 'bn' ? 'en' : 'bn']} />
	<meta property="og:image" content={image} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={imageAlt} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:image" content={image} />
	<meta name="twitter:image:alt" content={imageAlt} />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
</svelte:head>
