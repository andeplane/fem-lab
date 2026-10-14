// @vitest-environment node
// #512: the complete tree → mention parser → Assistant context path over the shipped engine.
// The HostContext is typed and fakes I/O; mesh generation and solving use the actual Rust WASM.
import { createRequire } from 'node:module';
import { Registry, parseMentions, refOf, type EngineSchema, type ModelSummary, type ResultSummary } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { buildTurn, objectIndex, resolveMention } from '../src/ai/context';
import { initialState } from '../src/store';
import { selectionReducer } from '../src/store';
import { treeGroups } from '../src/ui/Tree';

const require = createRequire(import.meta.url);
const { batchModule } = require('../../../tools/checked-batch.mjs');
const wasm = require('../../../tools/wasm-node/femlab_engine_wasm.js');
const { Engine, schema: engineSchema } = batchModule(wasm);

describe('actual engine reference targets', () => {
  it('clears Results without recycling their IDs when model.new runs in the same engine owner', async () => {
    const owner = new wasm.SessionEngine(1, 'reference-sequence');
    let stamp = JSON.parse(owner.stamp());
    const lease = JSON.parse(owner.begin_run(JSON.stringify(stamp.session)));
    let operation = 0;
    const context = () => ({ session: stamp.session, runId: lease.runId, operationId: String(++operation) });
    const dispatch = async (command: Record<string, unknown>) => {
      const reply = JSON.parse(await owner.dispatch(JSON.stringify({ context: context(), expectedVersion: stamp.stateVersion, command })));
      stamp = reply.stamp;
    };
    const query = (input: Record<string, unknown>) => JSON.parse(owner.query(JSON.stringify({ context: context(), query: input }))).value;
    const solve = async () => {
      for (const command of [
        { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '1 m', '1 m'] },
        { cmd: 'material.add', name: 'conductor', k: '45 W/(m K)' },
        { cmd: 'material.assign', material: 'conductor', bodies: ['bar'] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } }, order: 1 },
        { cmd: 'constraint.temperature', name: 'cold', on: 'bar.xmin', value: '0 K' },
        { cmd: 'constraint.temperature', name: 'hot', on: 'bar.xmax', value: '1 K' },
        { cmd: 'step.add', name: 'heat', procedure: 'heat-steady', constraints: ['cold', 'hot'], loads: [] },
        { cmd: 'solve.run', step: 'heat', solver: 'cpu-direct' },
      ]) await dispatch(command);
      return query({ query: 'query.result' }).resultId;
    };
    try {
      const first = await solve();
      await dispatch({ cmd: 'model.new', name: 'same engine cleared' });
      expect(query({ query: 'query.results' }).records).toEqual([]);
      expect(() => query({ query: 'query.result', resultId: first })).toThrow();
      const second = await solve();
      expect(first).toBe('result-1');
      expect(second).toBe('result-2');
    } finally { owner.free(); }
  });
  it('resolves ordinary and mode rows to their producing solve, preserves stale solves and refuses evicted IDs', async () => {
    expect(JSON.parse(engineSchema())).toEqual(schema);
    const engine = new Engine(1);
    const transport = fakeTransport();
    transport.dispatch = async command => JSON.parse(await engine.dispatch(JSON.stringify(command)));
    transport.query = async query => JSON.parse(engine.query(JSON.stringify(query)));
    const registry = new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport) });
    const body = 'beam"quoted';
    const step = 'static"quoted';
    const targets = async () => treeGroups({ ...initialState, model: await registry.query({ query: 'query.model' }) as ModelSummary, result: await registry.query({ query: 'query.result' }) as ResultSummary });
    const contexts = async (text: string) => {
      const { message, unresolved } = await buildTurn({ text, registry });
      expect(unresolved).toEqual([]);
      const content = (message.content[0] as { text: string }).text;
      return JSON.parse(content.match(/<context>\n([\s\S]*?)\n<\/context>/)![1]!);
    };
    try {
      for (const command of [
        { cmd: 'model.new', name: 'references' },
        { cmd: 'geometry.addBox', name: body, size: ['1 m', '100 mm', '100 mm'] },
        { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3' },
        { cmd: 'material.assign', material: 'steel', bodies: [body] },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } }, order: 1 },
        { cmd: 'constraint.fix', name: 'root', on: `${body}.xmin` },
        { cmd: 'load.traction', name: 'tip', on: `${body}.xmax`, total: ['0 N', '0 N', '-1 kN'] },
        { cmd: 'step.add', name: step, procedure: 'static', constraints: ['root'], loads: ['tip'] },
        { cmd: 'step.add', name: 'modes', procedure: 'modal', constraints: ['root'], loads: [], nModes: 2 },
        { cmd: 'solve.run', step, solver: 'cpu-direct' },
      ]) await registry.dispatch(command);
      const rows = (await targets()).flatMap(group => group.items);
      const resultRows = rows.filter(row => row.kind === 'result');
      expect(resultRows.some(row => row.name === 'σ_vM')).toBe(true);
      const resultRef = resultRows[0]!.ref;
      const original = await resolveMention(resultRef, registry) as ResultSummary;
      expect(resultRows.every(row => row.ref === refOf('result', `id:${original.resultId}`))).toBe(true);
      for (const row of rows) {
        const chip = parseMentions(`@${row.ref}`).chips[0]!;
        expect(chip.ref).toBe(row.ref);
        await expect(resolveMention(chip.ref, registry)).resolves.toBeDefined();
      }
      const context = await contexts(`Inspect @${resultRef} @mesh:mesh @${refOf('body', body)} @${refOf('face', `${body}.xmin`)}`);
      expect(context[resultRef]).toEqual(original);
      expect(context['mesh:mesh'].summary).toMatchObject({ nodes: 20, elements: 4 });
      expect(context[refOf('body', body)].name).toBe(body);
      expect((await objectIndex(registry)).map(row => row.ref)).toContain(resultRef);
      const selection = selectionReducer(initialState.selection, { bodies: [body] });
      const selected = await buildTurn({ text: 'Inspect @selection', registry, selection });
      expect(selected.unresolved).toEqual([]);
      expect((selected.message.content[0] as { text: string }).text).toContain(JSON.stringify(refOf('body', body)));
      await registry.dispatch({ cmd: 'contact.add', name: 'tie', kind: 'bonded', master: `${body}.xmin`, slave: `${body}.xmax` });
      const connection = (await targets()).find(group => group.label === 'Connections')!.items[0]!;
      await expect(resolveMention(connection.ref, registry)).resolves.toMatchObject({ name: 'tie', master: `${body}.xmin`, slave: `${body}.xmax` });

      await registry.dispatch({ cmd: 'load.traction', name: 'tip', on: `${body}.xmax`, total: ['0 N', '0 N', '-2 kN'] });
      const stale = await resolveMention(resultRef, registry) as ResultSummary;
      expect(stale).toEqual({ ...original, stale: true });
      await registry.dispatch({ cmd: 'solve.run', step, solver: 'cpu-direct' });
      const latest = await resolveMention(refOf('result', step), registry) as ResultSummary;
      expect(latest.resultId).not.toBe(original.resultId);
      expect((await contexts(`@${resultRef}`))[resultRef]).toEqual(stale);
      expect(latest.extremes).not.toEqual(original.extremes);

      await registry.dispatch({ cmd: 'solve.run', step: 'modes', solver: 'cpu-direct' });
      const modes = (await targets()).find(group => group.label === 'Results')!.items;
      expect(modes.filter(row => row.args.field?.toString().startsWith('mode:')).map(row => row.name)).toEqual(['mode 1', 'mode 2']);
      const modalRef = modes.find(row => row.name === 'mode 1')!.ref;
      const modal = await resolveMention(modalRef, registry) as ResultSummary;
      expect(modal.step).toBe('modes');
      expect(modal.frequencies).toHaveLength(2);
      expect((await contexts(`@${modalRef}`))[modalRef].resultId).toBe(modal.resultId);
      // Retention is bounded. Never reinterpret a lost immutable ID as its Step's latest solve.
      for (let i = 0; i < 8; i++) await registry.dispatch({ cmd: 'solve.run', step, solver: 'cpu-direct' });
      await expect(resolveMention(resultRef, registry)).rejects.toMatchObject({ code: 'not-found' });
      const evicted = await buildTurn({ text: `@${resultRef}`, registry });
      expect(evicted.unresolved.map(row => row.ref)).toEqual([resultRef]);
      expect((evicted.message.content[0] as { text: string }).text).not.toContain('<context>');
      await registry.dispatch({ cmd: 'model.new', name: 'clear references' });
      await expect(resolveMention(modalRef, registry)).rejects.toMatchObject({ code: 'not-found' });
    } finally { engine.free(); }
  });
});
