import { expect, it } from 'vitest';
import { HOST_COMMANDS, HOST_QUERIES } from '../src/host-commands';
import { Registry, type EngineSchema } from '../src/registry';
import schema from '../src/generated/runtime-schema';
import { fakeHost, fakeTransport } from './fakes';

function setup() {
  const transport = fakeTransport(), host = fakeHost(transport);
  return { host, transport, registry: new Registry({ schema: schema as unknown as EngineSchema, host }) };
}
const left = { resultId: 'solve-before', field: 'displacement', component: 0 };
const right = { resultId: 'solve-after', field: 'temperature' };
const at = [{ value: 100, unit: 'mm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' }];

it('makes synchronized lens zoom reproducible through the existing camera Command', async () => {
  const { registry, host } = setup();
  const camera = { position: [1, 2, 3], target: [0, 0, 0], zoom: 2.5 };
  await registry.dispatch({ cmd: 'view.setCamera', ...camera });
  expect(host.view.setCamera).toHaveBeenCalledWith(camera);
  await expect(registry.dispatch({ cmd: 'view.setCamera', ...camera, zoom: 0 })).rejects.toMatchObject({ code: 'schema' });
});

it('exposes independent retained identities and an explicit difference target through the real registry', async () => {
  const { registry, host, transport } = setup();
  for (const configuration of [
    { mode: 'single' }, { mode: 'sideBySide', left, right },
    { mode: 'difference', left, right, onto: 'left' }, { mode: 'difference', left, right, onto: 'right' },
  ]) {
    await registry.dispatch({ cmd: 'view.compareResults', ...configuration });
    expect(host.resultComparison!.configure).toHaveBeenLastCalledWith(configuration);
  }
  await expect(registry.dispatch({ cmd: 'view.compareResults', mode: 'difference', left, right })).rejects.toMatchObject({ code: 'schema' });
  await expect(registry.dispatch({ cmd: 'view.compareResults', mode: 'sideBySide', left: { ...left, resultId: '' }, right })).rejects.toMatchObject({ code: 'schema' });
  await expect(registry.dispatch({ cmd: 'view.compareResults', mode: 'sideBySide', left: { ...left, component: -1 }, right })).rejects.toMatchObject({ code: 'schema' });
  expect(transport.dispatch).not.toHaveBeenCalled();
});

it('keeps physical ranges and pick points unit-bearing and scoped to pane plus Result', async () => {
  const { registry, host, transport } = setup();
  const legend = { pane: 'difference', resultId: 'solve-before', colormap: 'turbo', range: [{ value: -1, unit: 'K' }, { value: 1, unit: 'K' }] };
  await registry.dispatch({ cmd: 'view.setComparisonLegend', ...legend });
  expect(host.resultComparison!.legend).toHaveBeenCalledWith(legend);
  await registry.dispatch({ cmd: 'view.setComparisonLegend', pane: 'left', resultId: 'solve-before', range: 'auto' });
  const pick = { pane: 'right', resultId: 'solve-after', at, body: 'old-body', face: 'old-face' };
  await expect(registry.dispatch({ cmd: 'view.pickComparison', ...pick })).resolves.toBeNull();
  expect(host.resultComparison!.pick).toHaveBeenCalledWith(pick);
  await registry.dispatch({ cmd: 'view.setComparisonVisible', pane: 'left', resultId: 'solve-before', bodies: ['old-body'], on: false });
  expect(host.resultComparison!.visible).toHaveBeenCalledWith({ pane: 'left', resultId: 'solve-before', bodies: ['old-body'], on: false });
  for (const invalid of [
    { cmd: 'view.setComparisonLegend', pane: 'left', resultId: 'r', range: [0, 1] },
    { cmd: 'view.pickComparison', pane: 'left', resultId: 'r', at: [0, 0, 0] },
    { cmd: 'view.pickComparison', pane: 'left', at },
  ]) await expect(registry.dispatch(invalid)).rejects.toMatchObject({ code: 'schema' });
  await expect(registry.query({ query: 'query.resultComparison' })).resolves.toEqual(host.resultComparison!.state());
  expect(host.selection.set).not.toHaveBeenCalled();
  expect(transport.dispatch).not.toHaveBeenCalled();
});

it('reports an absent workspace in a headless host rather than selecting hidden context', async () => {
  const { registry, host } = setup();
  delete host.resultComparison;
  await expect(registry.dispatch({ cmd: 'view.compareResults', mode: 'single' })).rejects.toMatchObject({ code: 'unsupported', where: 'view.compareResults' });
  await expect(registry.query({ query: 'query.resultComparison' })).rejects.toMatchObject({ code: 'unsupported' });
  for (const name of ['view.compareResults', 'view.setComparisonLegend', 'view.setComparisonVisible', 'view.pickComparison', 'query.resultComparison']) {
    const definition = [...HOST_COMMANDS, ...HOST_QUERIES].find(row => row.name === name)!;
    expect(definition.description.length).toBeGreaterThan(80);
    expect(registry.describe(name).provider).toBe('host');
    expect(registry.describe(name).execution).toBe(name.startsWith('query.') ? 'modelRead' : 'sessionView');
  }
});

it('registers independent typed retained index/time selection and rejects malformed samples before host actions', async () => {
  const { registry, host, transport } = setup();
  const configuration = { mode: 'sideBySide', left: { ...left, sample: { kind: 'frame', index: 2 } }, right: { ...right, sample: { kind: 'time', time: { value: 400, unit: 'ms' }, sampling: 'nearest' } } };
  await registry.dispatch({ cmd: 'view.compareResults', ...configuration });
  expect(host.resultComparison!.configure).toHaveBeenLastCalledWith(configuration);
  for (const sample of [
    { kind: 'frame', index: -1 }, { kind: 'frame', index: 1.5 }, { kind: 'frame', index: 4294967296 },
    { kind: 'time', time: '0.4 s' }, { kind: 'time', time: '0.4 s', sampling: 'interpolate' },
  ]) await expect(registry.dispatch({ cmd: 'view.compareResults', mode: 'sideBySide', left: { ...left, sample }, right })).rejects.toMatchObject({ code: 'schema' });
  expect(host.resultComparison!.configure).toHaveBeenCalledTimes(1);
  expect(transport.dispatch).not.toHaveBeenCalled();
});
