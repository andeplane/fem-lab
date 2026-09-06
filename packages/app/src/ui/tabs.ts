// The bottom panel's tabs, as a leaf module with no imports: the store re-exports them, and
// the Playwright specs read them from here. A spec that imported the store pulled the whole
// module graph into Node, down to `import.meta.glob` in ai/skills.ts, which only Vite provides.
export type Tab = 'history' | 'journal' | 'script' | 'results' | 'checks' | 'console';
export const TABS: Tab[] = ['journal', 'history', 'script', 'results', 'checks', 'console'];
