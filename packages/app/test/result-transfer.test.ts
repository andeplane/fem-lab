// @vitest-environment node
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { Query, ResultSurface, ResultField, DifferenceField } from '@femlab/registry';
import { SessionTransport, SessionChannel } from '../src/session-transport';
import { SessionRuntime } from '../src/session-runtime';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import type { RunLease } from '@femlab/registry';
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm.js');

it('transfers independent retained meshes and f64 fields repeatedly without exposing engine storage', async () => {
  const engine = new wasm.SessionEngine(1, 'retained-transfer');
  const runtime = new SessionRuntime(async () => engine, wasm.PreparedEngine.create);
  const detached: number[] = [];
  const worker = {
    onmessage: null as ((event: MessageEvent<SessionResponse>) => void) | null,
    onerror: null,
    terminate() {},
    postMessage(request: SessionRequest) {
      void runtime.accept(request, (reply, raw = []) => {
        const response = structuredClone(reply, { transfer: raw });
        detached.push(...raw.map(buffer => buffer.byteLength));
        worker.onmessage?.({ data: response } as MessageEvent<SessionResponse>);
      });
    },
  };
  const channel = new SessionChannel(worker as unknown as Worker);
  const created = await channel.request({ op: 'create', epoch: 'retained-transfer', options: { gpu: false, threads: 1 } });
  const admitted = await channel.request({ op: 'beginRun', session: created.stamp.session });
  const transport = new SessionTransport(channel, admitted.value as RunLease, async () => { throw new Error('replacement is not used by this transfer test'); });
  const dispatch = (command: object) => transport.dispatch(command as Parameters<SessionTransport['dispatch']>[0]);
  const direct = (query: Query) => JSON.parse(engine.query(JSON.stringify({ context: { session: transport.stamp.session, runId: transport.runId, operationId: '1' }, query }))).value;
  try {
    await expect(transport.surface({})).rejects.toMatchObject({ code: 'not-found' });
    for (const command of [
      { cmd: 'model.setName', name: 'retained transfer' },
      { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'] },
      { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, k: '45 W/(m K)' },
      { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
      { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 3, ny: 1, nz: 1 } } },
      { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '0 degC' },
      { cmd: 'load.heatFlux', name: 'hot', on: 'bar.xmax', q: '1000 W/m^2' },
      { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['cold'], loads: ['hot'] },
      { cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' },
    ]) await dispatch(command);
    const first = direct({ query: 'query.result', step: 'heat' }).resultId as string;
    const sq = { query: 'query.surface', resultId: first } as const;
    const fq = { query: 'query.field', resultId: first, field: 'temperature' } as const;
    const surface = await transport.query(sq) as ResultSurface;
    const field = await transport.query(fq) as ResultField;
    expect(surface).toEqual(direct(sq));
    expect(field).toEqual(direct(fq));
    expect(surface.positions.some(v => Math.fround(v) !== v)).toBe(true);
    expect(field.values.some(v => Math.fround(v) !== v)).toBe(true);
    for (let node = 0; node < surface.nodeCount; node++) {
      expect(field.values[3 * node]).toBeCloseTo(273.15 + 1000 / 45 * surface.positions[3 * node]!, 8);
    }
    const rendered = await transport.surface({ resultId: first });
    expect(rendered.resultId).toBe(first);
    expect(rendered.positions).toBeInstanceOf(Float32Array);
    expect(rendered.triElementNode).toBeInstanceOf(Uint32Array);
    expect([...rendered.triElementNode!]).toEqual(surface.triElementNode);
    expect(surface.triElementNode.length).toBe(surface.indices.length);
    expect([...rendered.positions]).toEqual(surface.positions.map(Math.fround));
    const rf = await transport.field('heat', 'temperature', 0, first);
    expect(rf.resultId).toBe(first);
    expect(rf.values).toBeInstanceOf(Float32Array);
    expect(rf.max).toBe(Math.max(...rf.values));
    const allComponents = await transport.field('heat', 'temperature', undefined, first);
    expect([...allComponents.values]).toEqual(field.values.map(Math.fround));
    const power = await transport.field('heat', 'reaction', 0, first);
    expect(power.unit).toBe('W');
    expect([...power.values].reduce((sum, value) => sum + value, 0)).toBeCloseTo(10, 6); // q A

    await expect(transport.field('heat', 'temperature', 3, first)).rejects.toMatchObject({ code: 'schema' });
    await dispatch({ cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '0.1 m', '0.1 m'], at: ['0.5 m', '0 m', '0 m'] });
    await expect(transport.surface({})).rejects.toMatchObject({ code: 'result.stale' });
    await dispatch({ cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } }, order: 2 });
    await dispatch({ cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' });
    const second = direct({ query: 'query.result', step: 'heat' }).resultId as string;
    expect(second).not.toBe(first);
    const current = await transport.query({ query: 'query.surface', step: 'heat' }) as ResultSurface;
    expect(current.resultId).toBe(second);
    expect(current.nodeCount).not.toBe(surface.nodeCount);
    expect((await transport.surface({ step: 'heat' })).resultId).toBe(second);
    for (const onto of ['left', 'right'] as const) {
      const q = { query: 'query.difference', left: { resultId: first, field: 'temperature' }, right: { resultId: second, field: 'temperature' }, onto } as const;
      const diff = await transport.query(q) as DifferenceField;
      expect(diff).toEqual(direct(q));
      expect(diff.values).toContain(null);
      expect(diff.coverage.outsideNodes.length).toBeGreaterThan(0);
      expect(diff.comparisonResultId).toBe(onto === 'left' ? first : second);
      expect(diff.values.filter(v => v !== null).length).toBeGreaterThan(0);
      expect(await transport.query(q)).toEqual(diff);
    }
    rendered.positions.fill(999);
    rf.values.fill(999);
    expect(await transport.query(sq)).toEqual(surface);
    expect(await transport.query(fq)).toEqual(field);
    expect(direct(sq)).toEqual(surface);
    expect(direct(fq)).toEqual(field);
    expect(detached.length).toBeGreaterThan(20);
    expect(detached.every(length => length === 0)).toBe(true);
    await transport.release();
    await expect(transport.query(sq)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(transport.surface({ resultId: first })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(transport.field('heat', 'temperature', 0, first)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(transport.surface()).rejects.toMatchObject({ code: 'cancelled' });
  } finally {
    channel.close();
    engine.free();
  }
});
