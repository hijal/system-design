export interface Rendition {
	name: string;
	height: number;
	mbps: number;
	cpu: number;
}

export const LADDER: readonly Rendition[] = [
	{ name: '240p', height: 240, mbps: 0.4, cpu: 0.15 },
	{ name: '360p', height: 360, mbps: 0.8, cpu: 0.3 },
	{ name: '480p', height: 480, mbps: 1.4, cpu: 0.5 },
	{ name: '720p', height: 720, mbps: 2.8, cpu: 1.0 },
	{ name: '1080p', height: 1080, mbps: 5.0, cpu: 2.05 }
];
