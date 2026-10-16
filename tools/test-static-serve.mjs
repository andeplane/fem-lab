import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { staticServer } from './static-serve.mjs';

test('holds the real SW transport while ordinary assets serve, then receipts the actual released body', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'femlab-static-gate-'));
  mkdirSync(path.join(root, 'assets')); writeFileSync(path.join(root, 'assets/common.js'), 'shared JS');
  writeFileSync(path.join(root, 'coi-serviceworker.min.js'), 'real worker response');
  const server = staticServer(root, '/fem-lab/', true).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const control = async (action, method = 'GET') => (await fetch(`${url}/__femlab_test__/${action}`, { method })).json();
  try {
    await control('hold', 'POST');
    const worker = fetch(`${url}/fem-lab/coi-serviceworker.min.js`);
    assert.equal(await (await fetch(`${url}/fem-lab/assets/common.js`)).text(), 'shared JS');
    const waiting = await control('status');
    assert.equal(waiting.pending, 1); assert.deepEqual(waiting.requests.map(r => r.file), ['assets/common.js']);
    await control('release', 'POST');
    assert.equal(await (await worker).text(), 'real worker response');
    const completed = await control('status');
    const receipt = completed.requests.find(r => r.file === 'coi-serviceworker.min.js');
    assert.equal(receipt.bytes, 20); assert.equal(receipt.sha256, createHash('sha256').update('real worker response').digest('hex'));
    assert.equal(receipt.completed, true);
    assert.ok(receipt.gzip > 0); assert.equal(completed.pending, 0);
  } finally {
    await control('release', 'POST'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true });
  }
});
