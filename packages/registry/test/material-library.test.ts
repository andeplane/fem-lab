import { describe, expect, it, vi } from 'vitest';
import schema from '../src/generated/runtime-schema';
import type { EngineSchema } from '../src/registry';
import { Registry } from '../src/registry';
import { fakeHost, fakeTransport } from './fakes';

const reported = (value: number, unit: string) => ({ value: { value, unit }, basis: 'catalogue basis', source: 'primary-source' });
const aluminium = {
  id: '6061-t6-sheet', materialAddSource: 'Exact source; sheet 0.01–0.25 in; T6',
  E: reported(68.3, 'GPa'), nu: reported(0.33, '1'), rho: reported(2710, 'kg/m^3'),
  alpha: reported(22.7e-6, '1/K'), k: reported(152, 'W/(m K)'), cp: reported(879, 'J/(kg K)'), yield: reported(248, 'MPa'),
};

function setup(entries: unknown[] = [aluminium]) {
  const transport = fakeTransport();
  transport.query = vi.fn(async () => ({ entries, sources: [] })) as typeof transport.query;
  return { transport, registry: new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport) }) };
}

describe('material.addFromLibrary', () => {
  it('copies all sourced properties, including ones a static Step would not need, in one engine Command', async () => {
    const { registry, transport } = setup();
    const ack = await registry.dispatch({ cmd: 'material.addFromLibrary', entry: '6061-t6-sheet', name: 'sheet' });
    expect(transport.query).toHaveBeenCalledExactlyOnceWith({ query: 'query.materialLibrary', name: '6061-t6-sheet' });
    expect(transport.dispatch).toHaveBeenCalledExactlyOnceWith({
      cmd: 'material.add', name: 'sheet', source: aluminium.materialAddSource,
      E: '68.3 GPa', nu: 0.33, rho: '2710 kg/m^3', alpha: '0.0000227 1/K',
      k: '152 W/(m K)', cp: '879 J/(kg K)', yield: '248 MPa',
    }, undefined);
    expect(ack).toEqual(await vi.mocked(transport.dispatch).mock.results[0]!.value);
    expect(registry.describe('material.addFromLibrary')).toMatchObject({ tool: true, execution: 'modelWrite', journaled: false });
  });

  it('keeps absent properties absent, including nu, rather than turning null into zero or a default', async () => {
    const { registry, transport } = setup([{ ...aluminium, E: null, nu: null, rho: null, alpha: null, cp: null, yield: null }]);
    await registry.dispatch({ cmd: 'material.addFromLibrary', entry: 'thermal-only', name: 'heat' });
    expect(transport.dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'material.add', name: 'heat', source: aluminium.materialAddSource, k: '152 W/(m K)' }, undefined);
  });

  it('does not add absent conductivity or heat capacity to catalogue steel', async () => {
    const { registry, transport } = setup([{ ...aluminium, E: reported(210, 'GPa'), nu: reported(0.3, '1'), rho: reported(7850, 'kg/m^3'), alpha: reported(12e-6, '1/K'), yield: reported(355, 'MPa'), k: null, cp: null }]);
    await registry.dispatch({ cmd: 'material.addFromLibrary', entry: 's355j2', name: 'steel' });
    expect(transport.dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'material.add', name: 'steel', source: aluminium.materialAddSource, E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3', alpha: '0.000012 1/K', yield: '355 MPa' }, undefined);
  });

  it('preserves a supported dimensional text quantity and skips unreported optional properties', async () => {
    const { registry, transport } = setup([{ materialAddSource: 'Custom catalogue response', E: { value: '2 GPa' } }]);
    await registry.dispatch({ cmd: 'material.addFromLibrary', entry: 'sparse', name: 'sparse' });
    expect(transport.dispatch).toHaveBeenCalledExactlyOnceWith({ cmd: 'material.add', name: 'sparse', source: 'Custom catalogue response', E: '2 GPa' }, undefined);
  });

  it.each(['0.33', { value: 33, unit: '%' }])('refuses an unsupported ratio representation rather than guessing a unit conversion (%j)', async value => {
    const { registry, transport } = setup([{ ...aluminium, nu: { value } }]);
    await expect(registry.dispatch({ cmd: 'material.addFromLibrary', entry: 'invalid-ratio', name: 'material' })).rejects.toMatchObject({ code: 'schema', where: 'nu' });
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it.each([{ entries: [] }, { entries: [aluminium, aluminium] }])('refuses a non-unique catalogue response before mutation (%j)', async ({ entries }) => {
    const { registry, transport } = setup(entries);
    await expect(registry.dispatch({ cmd: 'material.addFromLibrary', entry: 'steel', name: 'steel' })).rejects.toMatchObject({ code: 'not-found', where: 'entry' });
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it('propagates the engine lookup error without adding any Material', async () => {
    const { registry, transport } = setup();
    const failure = { code: 'ambiguous', cause: 'steel matches two grades' };
    vi.mocked(transport.query).mockRejectedValueOnce(failure);
    await expect(registry.dispatch({ cmd: 'material.addFromLibrary', entry: 'steel', name: 'steel' })).rejects.toBe(failure);
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it.each([{ entry: '', name: 'sheet' }, { entry: '6061-t6-sheet', name: '' }, { entry: '6061-t6-sheet', name: 'sheet', rho: '1 kg/m^3' }])('rejects invalid inputs or property overrides (%j)', async input => {
    const { registry, transport } = setup();
    await expect(registry.dispatch({ cmd: 'material.addFromLibrary', ...input })).rejects.toMatchObject({ code: 'schema' });
    expect(transport.query).not.toHaveBeenCalled();
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it('leaves the ordinary custom material.add path optional and unchanged', async () => {
    const { registry, transport } = setup();
    const command = { cmd: 'material.add', name: 'custom', E: '1 GPa', nu: 0.2 };
    await registry.dispatch(command);
    expect(transport.dispatch).toHaveBeenCalledExactlyOnceWith(command);
    expect(transport.query).not.toHaveBeenCalled();
  });
});
