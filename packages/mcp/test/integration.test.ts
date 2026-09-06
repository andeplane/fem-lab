// The whole server, over the SDK's own in-memory transport, against the real wasm engine: an
// editor builds the cantilever tool call by tool call and reads the tip deflection back. This is
// the acceptance test PLAN 4.10 names — "Claude Code builds and solves a cantilever through
// femlab mcp with no browser" — with the client's own JSON-RPC in place of the editor's.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { loadEngine } from '../src/engine';
import { createServer } from '../src/server';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `src/` stands in for `dist/`: both are one level under packages/mcp, so the search is the same. */
const asDist = path.join(here, '..', 'src');

const CANTILEVER: [string, Record<string, unknown>][] = [
  ['model_new', { name: 'cantilever' }],
  ['model_setUnits', { units: { length: 'mm', force: 'kN', stress: 'MPa' } }],
  ['geometry_addBox', { name: 'beam', size: ['1 m', '100 mm', '100 mm'] }],
  ['material_add', { name: 'steel', E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3' }],
  ['material_assign', { material: 'steel', bodies: ['beam'] }],
  ['mesh_set', { mesher: { kind: 'lattice', size: '25 mm' }, order: 1 }],
  ['constraint_fix', { name: 'root', on: 'beam.xmin' }],
  ['load_traction', { name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] }],
  ['step_add', { name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] }],
  ['solve_run', { step: 'static' }],
];

let client: Client;
let project: string;

beforeAll(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'femlab-mcp-e2e-'));
  const { server } = createServer({ engine: loadEngine(asDist), project });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-editor', version: '0' });
  await Promise.all([server.connect(serverEnd), client.connect(clientEnd)]);
});

/** One tool call, with the engine's structured error surfaced as a failure rather than text. */
async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0]!.text;
  if (res.isError === true) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as unknown;
}

it('builds and solves the cantilever through tool calls, with no browser', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain('geometry_addBox');
  expect(names).toContain('run_script');
  for (const [name] of CANTILEVER) expect(names).toContain(name);

  for (const [name, args] of CANTILEVER) await call(name, args);

  // Euler–Bernoulli says PL³/3EI = 0.1905 mm; this mesh gives 0.1919619 mm
  const result = (await call('query_result', {})) as { balance: number; extremes: { field: string; component: number; min: { value: number } }[] };
  const uz = result.extremes.find((e) => e.field === 'displacement' && e.component === 2)!;
  expect(Math.abs(uz.min.value)).toBeCloseTo(0.1919619, 1);
  expect(Math.abs(Math.abs(uz.min.value) / 0.1919619 - 1)).toBeLessThan(0.02);
  expect(result.balance).toBeLessThan(1e-9);

  // a tool that takes no arguments at all, and the resource list itself
  expect(await call('query_capabilities', {})).toMatchObject({ gpu: false });
  const bare = (await client.callTool({ name: 'query_capabilities' })) as { content: { text: string }[] };
  expect(JSON.parse(bare.content[0]!.text)).toMatchObject({ threads: 1 });
  expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(['femlab://model', 'femlab://journal', 'femlab://schema']);

  // the resources an editor reads without calling a tool
  const read = async (uri: string): Promise<unknown> =>
    JSON.parse(String(((await client.readResource({ uri })).contents[0] as { text: string }).text)) as unknown;
  expect(await read('femlab://model')).toMatchObject({ name: 'cantilever' });
  expect(await read('femlab://schema')).toMatchObject({ schemaVersion: '1' });

  // a script does the same work in one call, and lands in the same Journal
  const script = (await call('run_script', {
    code: 'const r = await fem.query.result({}); return (r as { balance: number }).balance;',
  })) as { result: number };
  expect(script.result).toBeLessThan(1e-9);

  // and the calculation note lands in the project folder
  await call('export_file', { format: 'report', path: 'notes/beam.md' });
  const note = await readFile(path.join(project, 'notes', 'beam.md'), 'utf8');
  expect(note).toContain('# Calculation note: cantilever');
  expect(note).toContain('### Hand calculation for step `static`');

  // an error comes back as the engine's structured shape, not as a crash
  await expect(call('constraint_fix', { name: 'x', on: 'nope' })).rejects.toThrow('not-found');
});

it('leaves the real Model unchanged after a timed-out script schedules a delayed Command', async () => {
  const before = await call('query_model', {});
  const response = await client.callTool({ name: 'run_script', arguments: {
    code: 'console.log("waiting"); await new Promise(r => setTimeout(r, 1200)); await fem.model.new({ name: "too late" });',
    timeoutMs: 800,
  } }) as { isError?: boolean; content: { text: string }[] };
  expect(response.isError).toBe(true);
  const timed = JSON.parse(response.content[0]!.text) as { console: string[]; error: string };
  expect(timed.console).toEqual(['waiting']);
  expect(timed.error).toContain('did not finish');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  expect(await call('query_model', {})).toEqual(before);
});


it('returns source diagnostics as an MCP tool error before any script Command can run', async () => {
  const before = await call('query_model', {});
  const code = 'await fem.model.new({ name: "must not happen" });\nawait fem.geometry.notReal({});';
  const validation = await call('validate_script', { code });
  expect(validation).toMatchObject({ ok: false, diagnostics: [{ code: 'TS2339', where: { line: 2, column: 20 } }] });
  const response = await client.callTool({ name: 'run_script', arguments: { code } }) as { isError?: boolean; content: { text: string }[] };
  expect(response.isError).toBe(true);
  expect(JSON.parse(response.content[0]!.text)).toMatchObject({ diagnostics: (validation as { diagnostics: unknown }).diagnostics });
  expect(await call('query_model', {})).toEqual(before);
});
