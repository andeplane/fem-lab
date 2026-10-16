import { readdirSync } from 'node:fs';
import type { PortableProject, RunLease } from '@femlab/registry';
import type { SessionMessage, SessionResponse } from '../src/session-protocol';
import { expect, test } from './fixtures';

test('@cpu portable scientific fields preserve signed-zero bits through a real Chromium Worker restore', async ({ page }) => {
  test.setTimeout(60_000);
  const workers = readdirSync('dist/assets').filter(file => /^session\.worker-[^/]+\.js$/.test(file));
  expect(workers).toHaveLength(1);
  await page.goto('./');
  await page.waitForFunction(() => window.fem !== undefined);
  const restored = await page.evaluate(async file => {
    await window.fem.dispatch({ cmd: 'example.open', name: 'cantilever' });
    const project = await window.fem.query.portableProject();
    const displacement = project.results[0]!.result.fields.displacement!;
    const zero = displacement.data.findIndex(value => value === 0);
    if (zero < 0) throw new Error('fixture requires a constrained zero displacement');
    displacement.data[zero] = -0;
    const worker = new Worker(new URL(file, document.baseURI), { type: 'module' });
    let sequence = 0;
    const request = (message: SessionMessage): Promise<Extract<SessionResponse, { ok: true }>> => new Promise((resolve, reject) => {
      const id = ++sequence;
      worker.onerror = error => reject(new Error(error.message));
      worker.onmessage = (event: MessageEvent<SessionResponse>) => {
        const reply = event.data;
        if (reply.id !== id || !('ok' in reply)) return;
        if (reply.ok) resolve(reply); else reject(new Error(reply.error.cause));
      };
      worker.postMessage({ ...message, id });
    });
    try {
      const options = { gpu: false, threads: 1 };
      const created = await request({ op: 'create', epoch: 'portable-signed-zero-browser', options });
      const lease = (await request({ op: 'beginRun', session: created.stamp.session })).value as RunLease;
      const prepared = await request({ op: 'prepare', context: { session: lease.stamp.session, runId: lease.runId, operationId: '1' },
        expectedVersion: lease.stamp.stateVersion, options, source: { kind: 'portable', portable: project } });
      const reader = (await request({ op: 'beginRun', session: prepared.stamp.session })).value as RunLease;
      const reply = await request({ op: 'query', context: { session: reader.stamp.session, runId: reader.runId, operationId: '1' },
        query: { query: 'query.portableProject' } });
      const actual = reply.value as PortableProject;
      return { negativeZero: Object.is(actual.results[0]!.result.fields.displacement!.data[zero], -0),
        sourceIds: project.results.map(result => result.id), restoredIds: actual.results.map(result => result.id),
        sourceHistory: project.file.journal, restoredHistory: actual.file.journal };
    } finally { worker.terminate(); }
  }, `assets/${workers[0]!}`);
  expect(restored.negativeZero).toBe(true);
  expect(restored.restoredIds).toEqual(restored.sourceIds);
  expect(restored.restoredHistory).toEqual(restored.sourceHistory);
});
