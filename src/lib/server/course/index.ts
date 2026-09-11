import base from '../../../../course/main.md?raw';
import { createCatalog } from './catalog';
const sources = import.meta.glob<string>('/course/module-*/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
});
export const catalogs = {
	bn: createCatalog(base, sources, 'bn'),
	en: createCatalog(base, sources, 'en')
};
