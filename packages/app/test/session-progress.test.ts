import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { Command, ExecutionContext, Progress, RunLease, Stamp } from '@femlab/registry';
import { SessionRuntime } from '../src/session-runtime';
import type { SessionResponse } from '../src/session-protocol';

const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
function success(reply: SessionResponse): asserts reply is Extract<SessionResponse, { ok: true }> {
  assert('ok' in reply && reply.ok);
}
const progressOf = (messages: SessionResponse[]): Progress[] => messages.flatMap(message => 'progress' in message ? [message.progress] : []);

async function actualRuntime() {
  const engine = new wasm.SessionEngine(1, 'progress-owner');
  const runtime = new SessionRuntime(async () => engine, wasm.PreparedEngine.create);
  const bootstrap: SessionResponse[] = [];
  await runtime.accept({ id: 1, op: 'create', epoch: 'progress-owner', options: { gpu: false, threads: 1 } }, reply => bootstrap.push(reply));
  const created = bootstrap.at(-1)!; success(created);
  await runtime.accept({ id: 2, op: 'beginRun', session: created.stamp.session }, reply => bootstrap.push(reply));
  const started = bootstrap.at(-1)!; success(started);
  const lease = started.value as RunLease;
  const original = engine.dispatch.bind(engine);
  let stream: Iterable<Progress> = [];
  let callbackCalls = 0, continued = 0, sequence = 0;
  // Inject a dense typed notification stream at the public WASM boundary. The checked
  // owner still executes the real Command and produces its real Ack/error and authority.
  const dispatch = vi.spyOn(engine, 'dispatch').mockImplementation(async (request, onProgress) => {
    assert(onProgress);
    for (const sample of stream) {
      callbackCalls++;
      if (onProgress(sample.phase, sample.fraction, sample.message) === true) continued++;
    }
    return original(request);
  });
  return {
    async send(command: Command, samples: Iterable<Progress>) {
      stream = samples;
      const stamp = JSON.parse(engine.stamp()) as Stamp;
      const context: ExecutionContext = { session: stamp.session, runId: lease.runId, operationId: String(++sequence) };
      const id = 100 + sequence, messages: SessionResponse[] = [];
      await runtime.accept({ id, op: 'dispatch', context, expectedVersion: stamp.stateVersion, command }, reply => messages.push(reply));
      expect(messages.every(reply => reply.id === id && JSON.stringify(reply.context) === JSON.stringify(context))).toBe(true);
      return messages;
    },
    counts: () => ({ callbackCalls, continued }),
    dispose: () => { dispatch.mockRestore(); engine.free(); },
  };
}

describe('Worker progress delivery stays usable during a dense solve', () => {
  it('bounds same-phase UI notifications and flushes the actual final sample before the real Ack', async () => {
    const h = await actualRuntime();
    function* dense(): Iterable<Progress> {
      for (let i = 0; i < 100_000; i++) yield { phase: 'solve', fraction: i / 100_000, message: `integration tick ${i}` };
    }
    try {
      const messages = await h.send({ cmd: 'model.setName', name: 'dense progress' }, dense());
      const progress = progressOf(messages);
      expect(progress.length).toBeLessThanOrEqual(102); // 101 displayed percentages plus one final sample.
      expect(progress[0]).toEqual({ phase: 'solve', fraction: 0, message: 'integration tick 0' });
      expect(progress.at(-1)).toEqual({ phase: 'solve', fraction: 0.99999, message: 'integration tick 99999' });
      expect(h.counts()).toEqual({ callbackCalls: 100_000, continued: 100_000 });
      expect(messages.at(-2)).toHaveProperty('progress', progress.at(-1));
      const terminal = messages.at(-1)!; success(terminal);
      expect(terminal.value).toMatchObject({ seq: 0, output: { type: 'none' } });
    } finally { h.dispose(); }
  });

  it('preserves phase boundaries, changed percentages and the latest phase sample', async () => {
    const h = await actualRuntime();
    const samples: Progress[] = [
      { phase: 'assemble', fraction: 0.1, message: 'assembly started' },
      { phase: 'assemble', fraction: 0.1001, message: 'assembly finished' },
      { phase: 'solve', fraction: 0.1001, message: 'integration started' },
      { phase: 'solve', fraction: 0.1002, message: 'another integration tick' },
      { phase: 'solve', fraction: 0.2, message: 'new percentage' },
      { phase: 'solve', fraction: 0.19, message: 'revised progress' },
      { phase: 'solve', fraction: 0.1901, message: 'actual final sample' },
    ];
    try {
      const progress = progressOf(await h.send({ cmd: 'model.setName', name: 'phase boundaries' }, samples));
      // The final assembly sample must precede the first integration sample, while the
      // redundant same-percentage integration update is omitted without reordering.
      expect(progress).toEqual([samples[0], samples[1], samples[2], samples[4], samples[5], samples[6]]);
    } finally { h.dispose(); }
  });

  it('flushes latest progress before a real checked error and retains the structured failure', async () => {
    const h = await actualRuntime();
    const samples: Progress[] = [
      { phase: 'solve', fraction: 0.4, message: 'started' },
      { phase: 'solve', fraction: 0.4001, message: 'latest before failure' },
    ];
    try {
      const messages = await h.send({ cmd: 'geometry.remove', name: 'missing' }, samples);
      expect(messages.at(-2)).toHaveProperty('progress', samples[1]);
      expect(messages.at(-1)).toMatchObject({ ok: false, error: { code: 'not-found', where: "body, cut, set or point mass 'missing'" } });
    } finally { h.dispose(); }
  });

  it('starts each request independently even when its phase and percentage equal the previous one', async () => {
    const h = await actualRuntime();
    const samples: Progress[] = [{ phase: 'solve', fraction: 0.5, message: 'first' }, { phase: 'solve', fraction: 0.5001, message: 'last' }];
    try {
      const first = await h.send({ cmd: 'model.setName', name: 'first' }, samples);
      const second = await h.send({ cmd: 'model.setName', name: 'second' }, samples);
      expect(progressOf(first)).toEqual(samples);
      expect(progressOf(second)).toEqual(samples);
      success(first.at(-1)!); success(second.at(-1)!);
      expect(first[0]!.context!.operationId).not.toBe(second[0]!.context!.operationId);
    } finally { h.dispose(); }
  });
});
