export type Region = 'singapore' | 'mumbai' | 'frankfurt' | 'virginia';
export type City = 'Dhaka' | 'Delhi' | 'Singapore' | 'London' | 'New York';

export const REGIONS: Region[] = ['singapore', 'mumbai', 'frankfurt', 'virginia'];
export const PRIMARY: Region = 'singapore';

export const USERS: { city: City; share: number; nearest: Region; edgeRtt: number }[] = [
	{ city: 'Dhaka', share: 0.35, nearest: 'mumbai', edgeRtt: 15 },
	{ city: 'Delhi', share: 0.1, nearest: 'mumbai', edgeRtt: 10 },
	{ city: 'Singapore', share: 0.15, nearest: 'singapore', edgeRtt: 5 },
	{ city: 'London', share: 0.25, nearest: 'frankfurt', edgeRtt: 8 },
	{ city: 'New York', share: 0.15, nearest: 'virginia', edgeRtt: 8 }
];

const USER_RTT: Record<City, Record<Region, number>> = {
	Dhaka: { singapore: 55, mumbai: 45, frankfurt: 160, virginia: 230 },
	Delhi: { singapore: 70, mumbai: 30, frankfurt: 130, virginia: 220 },
	Singapore: { singapore: 5, mumbai: 60, frankfurt: 160, virginia: 220 },
	London: { singapore: 170, mumbai: 120, frankfurt: 15, virginia: 75 },
	'New York': { singapore: 230, mumbai: 200, frankfurt: 85, virginia: 10 }
};

const REGION_RTT: Record<Region, Record<Region, number>> = {
	singapore: { singapore: 1, mumbai: 60, frankfurt: 160, virginia: 220 },
	mumbai: { singapore: 60, mumbai: 1, frankfurt: 110, virginia: 190 },
	frankfurt: { singapore: 160, mumbai: 110, frankfurt: 1, virginia: 90 },
	virginia: { singapore: 220, mumbai: 190, frankfurt: 90, virginia: 1 }
};

export const userRtt = (city: City, region: Region): number => USER_RTT[city][region];
export const regionRtt = (a: Region, b: Region): number => REGION_RTT[a][b];
