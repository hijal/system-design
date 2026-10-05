<script lang="ts">
	import { page } from '$app/state';
	import '@fontsource-variable/inter';
	import '@fontsource-variable/noto-sans-bengali';
	import '@fontsource-variable/jetbrains-mono';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	let { children } = $props();
	$effect(() => {
		document.documentElement.lang = page.data.locale ?? 'bn';
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
