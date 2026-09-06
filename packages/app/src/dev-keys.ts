// `vite.config.ts` injects the shell's ANTHROPIC_API_KEY / OPENAI_API_KEY here while `vite dev`
// runs, so a developer does not have to paste a key into the assistant every reload. A
// production build defines the whole thing as `null`, and `test/no-secrets.test.ts` reads
// `dist/` back to prove no key string survived (ADR 0006: keys live in the browser, never in a
// bundle and never on a server).
declare const __DEV_API_KEYS__: { anthropic: string | null; openai: string | null } | null;

export interface DevApiKeys {
  anthropic: string | null;
  openai: string | null;
}

export function devApiKeys(): DevApiKeys | null {
  return typeof __DEV_API_KEYS__ === 'undefined' ? null : __DEV_API_KEYS__;
}
