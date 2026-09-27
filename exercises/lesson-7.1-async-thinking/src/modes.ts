// API এর চারটা সংস্করণ — api.ts আর scenario.ts দুজনেই ব্যবহার করে (api.ts import করলে server চালু
// হয়ে যেত, তাই আলাদা file)
export const modes = ['sync-in-tx', 'sync-after-commit', 'fire-and-forget', 'queue'] as const;
export type Mode = (typeof modes)[number];
