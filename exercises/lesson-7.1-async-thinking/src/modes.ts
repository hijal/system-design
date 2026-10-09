// The four versions of the API - used by both api.ts and scenario.ts (importing api.ts would start
// the server, hence a separate file)
export const modes = ['sync-in-tx', 'sync-after-commit', 'fire-and-forget', 'queue'] as const;
export type Mode = (typeof modes)[number];
