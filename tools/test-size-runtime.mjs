import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runtimeClosures } from './size-runtime.mjs';

test('selects one actual runtime closure including nested pool workers and shared JS exactly once', () => {
  const sources = {
    'assets/session.worker-a.js': '// A worker\'s comment contains "quotes" and `templates`.\nimport("./portable-a.js"); import(`./threaded-b.js`); import("./shared-c.js")',
    'assets/portable-a.js': 'new URL("/preview/assets/portable-d.wasm", import.meta.url); import("./shared-c.js")',
    'assets/threaded-b.js': 'new URL("/preview/assets/threaded-e.wasm", import.meta.url); new Worker(new URL("/preview/assets/pool-f.js", import.meta.url))',
    'assets/pool-f.js': 'import("./threaded-glue-g.js")',
    'assets/threaded-glue-g.js': 'import("./pool-f.js"); new URL("/preview/assets/threaded-e.wasm", import.meta.url); import("./shared-c.js")',
    'assets/shared-c.js': 'export const shared = true',
    'assets/unrelated-h.js': 'new URL("./other-i.wasm", import.meta.url)',
    'assets/portable-d.wasm': '', 'assets/threaded-e.wasm': '', 'assets/other-i.wasm': '',
  };
  const profiles = runtimeClosures(Object.keys(sources), file => sources[file]);
  assert.equal(profiles.length, 2);
  assert.deepEqual([...profiles[0].files].sort(), ['assets/portable-a.js', 'assets/portable-d.wasm', 'assets/session.worker-a.js', 'assets/shared-c.js']);
  assert.deepEqual([...profiles[1].files].sort(), ['assets/pool-f.js', 'assets/session.worker-a.js', 'assets/shared-c.js', 'assets/threaded-b.js', 'assets/threaded-e.wasm', 'assets/threaded-glue-g.js']);
  assert.equal(profiles[0].binary, 'assets/portable-d.wasm');
  assert.equal(profiles[1].binary, 'assets/threaded-e.wasm');
});

test('fails closed when the emitted engine graph cannot be identified', () => {
  assert.throws(() => runtimeClosures([], () => ''), /one emitted session Worker/);
  assert.throws(() => runtimeClosures(['assets/session.worker-a.js'], () => ''), /portable and threaded engine WASM/);
});
