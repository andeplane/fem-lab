import { build } from 'esbuild';
import { cp } from 'node:fs/promises';

await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  // Bundle the shared source seam; deployed host SDKs stay ordinary Node dependencies.
  external: ['firebase-admin', 'firebase-admin/*', 'pg', 'stripe', '@google-cloud/*', 'openai'],
});
await cp(new URL('./migrations', import.meta.url), new URL('./dist/migrations', import.meta.url), { recursive: true });
