import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { HOST_COMMANDS, Registry, type Command, type DocumentSnapshot, type EngineSchema, type StepIo, type StepImportResult } from '@femlab/registry';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, TETRA_STL } from '../../registry/test/fakes';
import { triangle } from '../../registry/test/step-fixture';
import { SessionRuntime } from '../src/session-runtime';
import { SessionWorkspace } from '../src/session-workspace';
import type { SessionTransport } from '../src/session-transport';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import { StepImporter, type StepWorker } from '../src/step-import';
import { Store } from '../src/store';
import { StepImportReport } from '../src/ui/ImportStep';
const wasm = createRequire(import.meta.url)('../../../tools/wasm-node/femlab_engine_wasm.js') as typeof import('../src/generated/wasm/femlab_engine_wasm');
class EngineWorker {
  onmessage: ((event: MessageEvent<SessionResponse>) => void) | null = null;
  onerror = null;
  runtime = new SessionRuntime(async (options, epoch) => new wasm.SessionEngine(options.threads, epoch), (ticket, options) => wasm.PreparedEngine.create(ticket, options), () => 0);
  postMessage(request: SessionRequest) { void this.runtime.accept(request, response => this.onmessage?.({ data: response } as MessageEvent<SessionResponse>)); }
  terminate() {}
}
const source: Command = { cmd: 'geometry.import', name: 'part', format: 'stl', data: TETRA_STL, unitLength: '1 m' };
const edit: Command = { cmd: 'geometry.addBox', name: 'intervening', size: ['1 m', '1 m', '1 m'] };
function setup() {
  let epoch = 0;
  return new SessionWorkspace({ spawn: () => new EngineWorker() as unknown as Worker, epoch: () => `step-${++epoch}`, engine: { gpu: false, threads: 1 }, build: async (_t, snapshot) => ({ snapshot, dispose() {} }), publish: () => undefined });
}
async function state(transport: SessionTransport) {
  return { snapshot: await transport.snapshot(), document: await transport.query({ query: 'query.document' }), catalogue: await transport.query({ query: 'query.results' }), stamp: transport.stamp };
}
function tetraConversion() {
  const tetra = triangle(); tetra.femlab.faces = 4; tetra.femlab.triangles = 4;
  tetra.meshes[0]!.attributes.position.array = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  tetra.meshes[0]!.index.array = [0, 2, 1, 0, 3, 2, 0, 1, 3, 1, 2, 3];
  tetra.meshes[0]!.brep_faces = [0, 1, 2, 3].map(i => ({ first: i, last: i }));
  return tetra;
}
function setupImport(transport: SessionTransport) {
  const worker: StepWorker = { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  const reports = vi.fn(); const importer = new StepImporter(() => worker, 'unused/', () => undefined, reports);
  const io: StepIo = { pick: async () => ({ name: 'tetra.step', size: 1, read: async () => new Uint8Array([1]) }), read: vi.fn(), sha256: async bytes => createHash('sha256').update(bytes).digest('hex') };
  const host = fakeHost(transport);
  host.step = { import: input => {
    const admitted = transport.stamp;
    return importer.run(input, io, { signal: transport.channel.signal, convert: async (quantity, to) => {
      const result = await transport.query({ query: 'query.convert', quantity, to });
      if (!('value' in result) || typeof result.value !== 'number') throw new Error('missing numeric unit conversion'); return result.value;
    }, commit: command => transport.dispatchAtAdmission(command, admitted) });
  }, cancel: name => importer.cancel(name) };
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host, hostCommands: HOST_COMMANDS });
  return { registry, worker, reports, importer, host };
}
it('retains captured admission across queued writes and refreshed reads, preserving the entire checked document on refusal', async () => {
  for (const anotherProducer of [false, true]) {
    const workspace = setup(); const active = await workspace.start(); const transport = active.transport;
    try {
      await transport.dispatch(source);
      const admitted = transport.stamp; const writer = anotherProducer ? await transport.fork() : transport;
      const writing = writer.dispatch(edit);
      const pending = anotherProducer ? undefined : transport.dispatchAtAdmission(source, admitted);
      const refusal = pending && expect(pending).rejects.toMatchObject({ code: 'session.conflict' });
      await writing;
      const before = await state(writer);
      // Observing the new version must not authorize conversion admitted at the old version.
      await transport.query({ query: 'query.model' });
      if (refusal) await refusal;
      else await expect(transport.dispatchAtAdmission(source, admitted)).rejects.toMatchObject({ code: 'session.conflict' });
      expect(await state(writer)).toEqual(before);
      expect(workspace.active).toBe(active);
    } finally { transport.channel.close(); }
  }
});
it('allows read-only view work and preserves material assignment on a single-command re-import', async () => {
  const workspace = setup(); const transport = (await workspace.start()).transport;
  try {
    await transport.dispatch(source);
    await transport.dispatch({ cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3 });
    await transport.dispatch({ cmd: 'material.assign', material: 'steel', bodies: ['part'] });
    const before = await transport.snapshot(); const admitted = transport.stamp;
    await transport.query({ query: 'query.model' }); await transport.query({ query: 'query.capabilities' });
    const callerOwned = { ...source };
    const pending = transport.dispatchAtAdmission(callerOwned, admitted);
    callerOwned.name = 'mutated-after-submission'; admitted.session.sessionId = 'mutated-after-submission';
    const ack = await pending;
    const after = await transport.snapshot();
    expect(ack.seq).toBe(before.journal.entries.length);
    expect(after.journal.entries).toHaveLength(before.journal.entries.length + 1);
    expect(after.model.bodies[0]).toMatchObject({ name: 'part', material: 'steel', measure: { value: 1 / 6, unit: 'm^3' } });
    expect(after.file.journal.entries.at(-1)!.cmd).toEqual(source);
  } finally { transport.channel.close(); }
});
it('refuses foreign sessions, replaced/cancelled producers and invalid geometry without changing their active project', async () => {
  const workspace = setup(); const initial = await workspace.start(); const transport = initial.transport;
  await transport.dispatch(source);
  const admitted = transport.stamp;
  try {
    const before = await state(transport);
    await expect(transport.dispatchAtAdmission({ ...source, data: 'broken STL' }, admitted)).rejects.toMatchObject({ code: 'schema' });
    expect(await state(transport)).toEqual(before);
    await expect(transport.dispatchAtAdmission(source, { ...admitted, session: { ...admitted.session, sessionId: 'foreign' } })).rejects.toMatchObject({ code: 'session.expired' });
    expect(await state(transport)).toEqual(before);
    const cancelled = await transport.fork(); await cancelled.release();
    await expect(cancelled.dispatchAtAdmission(source, cancelled.stamp)).rejects.toMatchObject({ code: 'cancelled' });
    expect(await state(transport)).toEqual(before);
    const next = await workspace.replace(transport, { kind: 'commands', commands: [{ cmd: 'model.new', name: 'new project' }] });
    const replacement = await state(next);
    await expect(transport.dispatchAtAdmission(source, admitted)).rejects.toMatchObject({ code: 'session.expired' });
    expect(await state(next)).toEqual(replacement);
    next.channel.close();
  } finally { transport.channel.close(); }
});
it('runs the registry host converter into a real checked Workspace, with portable f64 geometry and one appended Journal Command', async () => {
  const workspace = setup(); const transport = (await workspace.start()).transport;
  const { registry, worker, reports, importer } = setupImport(transport);
  try {
    const before: DocumentSnapshot = await transport.snapshot();
    const pending = registry.dispatch({ cmd: 'geometry.importStep', name: 'part', linearDeflection: '1 mm', angularDeflection: '15 deg' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    worker.onmessage!({ data: tetraConversion() } as MessageEvent<unknown>);
    expect(await pending).toMatchObject({ report: { outputUnit: 'm', triangles: 4 } });
    const after = await transport.snapshot();
    expect(after.journal.entries).toHaveLength(before.journal.entries.length + 1);
    expect(after.model.bodies[0]).toMatchObject({ name: 'part', measure: { value: 1 / 6, unit: 'm^3' } });
    expect(after.file.journal.entries.at(-1)!.cmd).toMatchObject({ cmd: 'geometry.import', unitLength: '1 m', format: 'stl', encoding: 'utf8' });
    expect(after.file.journal.entries.at(-1)!.cmd).not.toHaveProperty('path');
    expect(reports).toHaveBeenCalledOnce();
  } finally { importer.dispose(); transport.channel.close(); }
});
it.each(['edit', 'switch', 'cancel', 'invalid'] as const)('keeps checked scientific state intact when a deferred conversion ends in %s', async ending => {
  const workspace = setup(); const transport = (await workspace.start()).transport;
  const commands: Command[] = [
    { cmd: 'geometry.addLine', name: 'shaft', points: [['0 m', '0 m', '0 m'], ['1 m', '0 m', '0 m']], divisions: 1, kind: 'beam' },
    { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3 }, { cmd: 'material.assign', material: 'steel', bodies: ['shaft'] },
    { cmd: 'section.add', name: 'round', shape: { kind: 'circle', radius: '50 mm' } }, { cmd: 'section.assign', section: 'round', bodies: ['shaft'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' } }, { cmd: 'constraint.fix', name: 'root', on: 'shaft.p0' },
    { cmd: 'load.force', name: 'tip', on: 'shaft.p1', total: ['1000 N', '0 N', '0 N'] },
    { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['root'], loads: ['tip'] }, { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' },
  ];
  for (const command of commands) await transport.dispatch(command);
  const { registry, worker, reports, importer } = setupImport(transport);
  let active = transport;
  try {
    const result = await transport.query({ query: 'query.result', step: 'axial' });
    expect(result).toHaveProperty('resultId');
    const pending = registry.dispatch({ cmd: 'geometry.importStep', name: 'part', linearDeflection: '1 mm', angularDeflection: '15 deg' });
    const refused = expect(pending).rejects.toMatchObject({ code: ending === 'edit' ? 'session.conflict' : ending === 'invalid' ? 'schema' : 'cancelled' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce()); const late = worker.onmessage!;
    if (ending === 'edit') await transport.dispatch({ cmd: 'load.force', name: 'extra', on: 'shaft.p1', total: ['1 N', '0 N', '0 N'] });
    if (ending === 'switch') active = await workspace.replace(transport, { kind: 'commands', commands: [{ cmd: 'model.new', name: 'replacement' }] });
    const before = await state(active);
    const currentResult = ending === 'switch' ? null : await active.query({ query: 'query.result', step: 'axial' });
    if (ending === 'cancel') expect(await registry.dispatch({ cmd: 'geometry.cancelStep', name: 'part' })).toEqual({ cancelled: true });
    late({ data: ending === 'invalid' ? triangle() : tetraConversion() } as MessageEvent<unknown>);
    await refused;
    expect(await state(active)).toEqual(before);
    if (ending !== 'switch') expect(await active.query({ query: 'query.result', step: 'axial' })).toEqual(currentResult);
    expect(reports).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledOnce();
  } finally { importer.dispose(); active.channel.close(); transport.channel.close(); }
});
it('reopens an explicitly historical receipt after Undo removes the actual Body and source Command', async () => {
  const workspace = setup(); const transport = (await workspace.start()).transport;
  await transport.dispatch(edit); // Keep the normal workspace mounted after undoing the import.
  const { registry, worker, importer, host } = setupImport(transport); const store = new Store();
  host.panels.toggle = (panel, open) => store.togglePanel(panel, open);
  const element = document.createElement('div');
  try {
    const pending = registry.dispatch({ cmd: 'geometry.importStep', name: 'part', linearDeflection: '1 mm', angularDeflection: '15 deg' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    worker.onmessage!({ data: tetraConversion() } as MessageEvent<unknown>);
    const imported = await pending as StepImportResult;
    store.set({ stepReport: imported.report });
    await transport.dispatch({ cmd: 'journal.undo', steps: 1 });
    const current = await transport.snapshot();
    expect(current.model.bodies.map(body => body.name)).toEqual(['intervening']);
    expect(current.journal.entries.some(entry => entry.cmd.cmd === 'geometry.import')).toBe(false);
    store.set({ model: current.model, journal: current.journal });
    await registry.dispatch({ cmd: 'panel.toggle', panel: 'stepReport', open: true });
    act(() => render(h(StepImportReport, { s: store.state, dispatch: command => registry.dispatch(command) }), element));
    expect(element.querySelector('[role="dialog"]')).not.toBeNull();
    expect(element.textContent).toContain('Last successful STEP conversion');
    expect(element.textContent).toContain('Later edits or Undo may change or remove this geometry');
    expect(element.textContent).toContain(imported.report.geometrySha256);
    expect(element.textContent).not.toContain('The Journal contains the converted geometry');
    expect(store.state.stepReport).toEqual(imported.report);
  } finally { act(() => render(null, element)); importer.dispose(); transport.channel.close(); }
});
