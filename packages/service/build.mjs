import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  // Bundle the shared source seam; deployed host SDKs stay ordinary Node dependencies.
  external: ['firebase-admin', 'firebase-admin/*', 'pg', 'stripe', '@google-cloud/*', 'openai'],
});
