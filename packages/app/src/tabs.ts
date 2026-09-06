/** Bottom-panel tabs shared by the app and its browser test without loading the Vite-only app graph. */
export type Tab = 'history' | 'journal' | 'script' | 'results' | 'checks' | 'console';
export const TABS: Tab[] = ['journal', 'history', 'script', 'results', 'checks', 'console'];
