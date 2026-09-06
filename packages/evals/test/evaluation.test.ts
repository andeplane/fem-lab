import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Provider } from '../../app/src/ai/eval-api';
import type { QueryDef } from '@femlab/registry';
import { EVAL_CASES } from '../src/cases';
import { evaluateCase, type RemoteEngine } from '../src/remote';
import { scoreCase } from '../src/score';
import { credentialAvailability, runLane, serializeArtifact, type EvalAdapter, type EvaluationArtifact } from '../src/runner';
import { assertInFrozenPackage, serveFrozenApp } from '../src/static-app';
import type { EvalCase, EvalEvidence, HostKind, ToolTrace } from '../src/types';

const valued = (value: number, unit: string) => ({ value, unit });
const entry = (cmd: Record<string, unknown>, seq: number) => ({ seq, hashAfter: `h${seq}`, cmd });

function complete(spec: EvalCase): EvalEvidence {
  const source = 'catalogue provenance';
  const catalogue = {
    materialAddSource: source,
    E: { value: valued(spec.materialE, 'Pa') },
    nu: { value: valued(spec.materialNu, '1') },
    rho: spec.materialRho === undefined ? null : { value: valued(spec.materialRho, 'kg/m^3') },
    alpha: null, k: null, cp: null, yield: null,
  };
  const commands: Record<string, unknown>[] = [
    { cmd: 'model.new', name: spec.id },
    { cmd: 'geometry.addBox', name: 'body', size: spec.dimensionsM.map((n) => `${n} m`) },
    { cmd: 'material.add', name: 'material', E: `${spec.materialE} Pa`, nu: spec.materialNu,
      ...(spec.materialRho === undefined ? {} : { rho: `${spec.materialRho} kg/m^3` }),
      ...(spec.thermal ? { k: `${spec.thermal.conductivity} W/(m K)` } : {}), ...(spec.requires === 'material-library' ? { source } : {}) },
    { cmd: 'material.assign', material: 'material', bodies: ['body'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } } },
  ];
  const constraints: { name: string; on: string; summary: string }[] = [];
  const loads: { name: string; kind: string; on?: string; summary: string }[] = [];
  if (spec.kind === 'heat') {
    commands.push(
      { cmd: 'constraint.temperature', name: 'left', on: 'body.xmin', value: `${spec.thermal!.leftK} K` },
      { cmd: 'constraint.temperature', name: 'right', on: 'body.xmax', value: `${spec.thermal!.rightK} K` },
    );
    constraints.push({ name: 'left', on: 'body.xmin', summary: 'temperature' }, { name: 'right', on: 'body.xmax', summary: 'temperature' });
  } else if (spec.kind !== 'explicit') {
    commands.push({ cmd: 'constraint.fix', name: 'root', on: 'body.xmin' });
    constraints.push({ name: 'root', on: 'body.xmin', summary: 'fix ux, uy, uz' });
  }
  if (spec.kind === 'axial' || spec.kind === 'bending') {
    commands.push({ cmd: 'load.traction', name: 'load', on: 'body.xmax', total: spec.appliedN!.map((n) => `${n} N`) });
    loads.push({ name: 'load', kind: 'traction', on: 'body.xmax', summary: 'total' });
  }
  if (spec.kind === 'explicit' && spec.measure.kind === 'frames') {
    const g = [0, 0, 0];
    g[spec.measure.component] = spec.measure.acceleration;
    commands.push({ cmd: 'load.gravity', name: 'gravity', g: g.map((n) => `${n} m/s^2`) });
    loads.push({ name: 'gravity', kind: 'gravity', summary: 'body load' });
  }
  const selectedConstraints = constraints.map((row) => row.name);
  const selectedLoads = loads.map((row) => row.name);
  commands.push(
    { cmd: 'step.add', name: 'step', procedure: spec.procedure, constraints: selectedConstraints, loads: selectedLoads,
      ...(spec.explicit === undefined ? {} : { tEnd: `${spec.explicit.endS} s` }) },
    { cmd: 'solve.run', step: 'step' },
  );

  const model = {
    hash: 'model-hash',
    bodies: [{ name: 'body', material: 'material', bbox: [valued(0, 'm'), valued(0, 'm'), valued(0, 'm'), ...spec.dimensionsM.map((n) => valued(n, 'm'))] }],
    materials: [{ name: 'material', E: valued(spec.materialE, 'Pa'), nu: spec.materialNu,
      ...(spec.materialRho === undefined ? {} : { rho: valued(spec.materialRho, 'kg/m^3') }), assignedTo: ['body'] }],
    constraints,
    loads,
    steps: [{ name: 'step', procedure: spec.procedure, solved: true, constraints: selectedConstraints, loads: selectedLoads }],
    meshSettings: { mesher: { kind: 'lattice' } },
    warnings: [],
  };
  const result: Record<string, unknown> = {
    step: 'step',
    stale: false,
    balance: 1e-12,
    appliedTotal: (spec.appliedN ?? [0, 0, 0]).map((n) => valued(n, 'N')),
    extremes: [],
    frequencies: [],
  };
  let probe: unknown;
  let framesCatalogue: unknown;
  let frames: unknown[] | undefined;
  if (spec.measure.kind === 'extreme') {
    result['extremes'] = [{ field: spec.measure.field, component: spec.measure.component, min: valued(spec.expected, 'm'), max: valued(spec.expected, 'm') }];
  } else if (spec.measure.kind === 'probe') probe = { value: valued(spec.expected, 'K') };
  else if (spec.measure.kind === 'frequency') result['frequencies'] = [valued(spec.expected, 'Hz'), valued(spec.expected * 2, 'Hz')];
  else {
    const measure = spec.measure;
    const end = spec.explicit!.endS;
    const frame = (index: number, timeSi: number) => {
      const displacement = 0.5 * measure.acceleration * timeSi * timeSi;
      const node = [0, 0, 0];
      node[measure.component] = displacement;
      return { sample: { step: 'step', modelHash: 'model-hash', frame: { index, timeSi } }, field: 'displacement', components: 3, nodeCount: 2, unit: 'm', values: [...node, ...node] };
    };
    frames = [frame(0, 0), frame(1, end / 2), frame(2, end)];
    framesCatalogue = { step: 'step', modelHash: 'model-hash', stale: false, nodeCount: 2, field: 'displacement', components: 3, storedComponents: 3,
      frames: [{ index: 0, timeSi: 0 }, { index: 1, timeSi: end / 2 }, { index: 2, timeSi: end }] };
  }

  const trace: ToolTrace[] = [];
  if (spec.requires === 'material-library') trace.push({ name: 'query_materialLibrary', command: 'query.materialLibrary', input: {}, output: { entries: [catalogue] } });
  if (spec.requires === 'script-validation') {
    trace.push(
      { name: 'validate_script', command: 'query.validateScript', input: { code: spec.invalidScript }, output: { ok: false }, journalBefore: 'empty-hash', journalAfter: 'empty-hash' },
      { name: 'validate_script', command: 'query.validateScript', input: { code: 'await fem.model.new({name: "corrected"});' }, output: { ok: true }, journalBefore: 'empty-hash', journalAfter: 'empty-hash' },
      { name: 'run_script', command: 'script.run', input: { code: 'corrected' }, output: {} },
    );
  }
  return { status: 'completed', model, result, probe, framesCatalogue, frames, journal: { entries: commands.map(entry) }, trace };
}

function failed(score: ReturnType<typeof scoreCase>, name: string): boolean {
  return score.checks.some((item) => item.name === name && !item.passed);
}

describe('the fixed cases', () => {
  it('contains exactly the frozen twenty IDs and independent reference variants', () => {
    expect(EVAL_CASES.map((spec) => spec.id)).toEqual([
      'A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'H1', 'H2', 'H3', 'H4', 'M1', 'M2', 'D1', 'D2', 'N1', 'N2', 'V1', 'V2',
    ]);
    expect(new Set(EVAL_CASES.map((spec) => spec.prompt)).size).toBe(20);
    expect(EVAL_CASES.find((spec) => spec.id === 'A1')?.expected).toBeCloseTo(0.00018, 12);
    expect(EVAL_CASES.find((spec) => spec.id === 'M1')?.expected).toBeCloseTo(20.8879148611, 9);
  });
});

describe('independent scoring', () => {
  it('passes every complete reference observation', () => {
    for (const spec of EVAL_CASES) expect(scoreCase(spec, complete(spec)), spec.id).toMatchObject({ id: spec.id, passed: true });
  });

  it('fails a wrong answer even when equilibrium passes', () => {
    const spec = EVAL_CASES[0]!;
    const evidence = complete(spec);
    const result = evidence.result as { extremes: { max: { value: number } }[] };
    result.extremes[0]!.max.value *= 1.2;
    const score = scoreCase(spec, evidence);
    expect(score.passed).toBe(false);
    expect(failed(score, 'value')).toBe(true);
    expect(failed(score, 'balance')).toBe(false);
  });

  it('fails unbalanced reactions independently of a correct answer', () => {
    const spec = EVAL_CASES[1]!;
    const evidence = complete(spec);
    (evidence.result as { balance: number }).balance = 2e-9;
    const score = scoreCase(spec, evidence);
    expect(failed(score, 'value')).toBe(false);
    expect(failed(score, 'balance')).toBe(true);
  });

  it('rejects a correct scalar from the wrong material or selected Step inputs', () => {
    const axial = EVAL_CASES[0]!;
    const wrongNu = complete(axial);
    (wrongNu.model as { materials: { nu: number }[] }).materials[0]!.nu = 0.2;
    expect(failed(scoreCase(axial, wrongNu), 'model')).toBe(true);

    const wrongStep = complete(axial);
    (wrongStep.model as { steps: { constraints: string[] }[] }).steps[0]!.constraints = [];
    expect(failed(scoreCase(axial, wrongStep), 'physics')).toBe(true);

    const modal = EVAL_CASES.find((spec) => spec.id === 'M1')!;
    const wrongRho = complete(modal);
    (wrongRho.model as { materials: { rho: { value: number } }[] }).materials[0]!.rho.value *= 2;
    expect(failed(scoreCase(modal, wrongRho), 'model')).toBe(true);
  });

  it('accepts only the procedure-inapplicable unloaded warning for heat and modal cases', () => {
    for (const id of ['H1', 'M1']) {
      const spec = EVAL_CASES.find((candidate) => candidate.id === id)!;
      const expected = complete(spec);
      (expected.model as { warnings: unknown[] }).warnings = [{ code: 'model.unloaded', text: 'no loads yet' }];
      expect(failed(scoreCase(spec, expected), 'model')).toBe(false);

      const unexpected = complete(spec);
      (unexpected.model as { warnings: unknown[] }).warnings = [{ code: 'model.ill-posed', text: 'bad model' }];
      expect(failed(scoreCase(spec, unexpected), 'model')).toBe(true);
    }
  });

  it('rejects forbidden direct and script-nested prepared Model routes', () => {
    const spec = EVAL_CASES[0]!;
    const direct = complete(spec);
    direct.trace.push({ name: 'example_open', command: 'example.open', input: { name: 'cantilever' } });
    expect(failed(scoreCase(spec, direct), 'journal')).toBe(true);

    const nested = complete(spec);
    nested.trace.push({ name: 'run_script', command: 'script.run', input: { code: 'await fem.file.open({path: "answer.json"});' } });
    expect(failed(scoreCase(spec, nested), 'journal')).toBe(true);
  });

  it('uses modal and explicit physics invariants instead of their zero balance fields', () => {
    const modal = EVAL_CASES.find((spec) => spec.id === 'M1')!;
    const modalEvidence = complete(modal);
    (modalEvidence.result as { frequencies: { value: number }[] }).frequencies[1]!.value = -1;
    expect(failed(scoreCase(modal, modalEvidence), 'balance')).toBe(true);

    const drop = EVAL_CASES.find((spec) => spec.id === 'D1')!;
    const dropEvidence = complete(drop);
    const values = (dropEvidence.frames![1] as { values: number[] }).values;
    const component = drop.measure.kind === 'frames' ? drop.measure.component : 0;
    values[component] = values[component]! * 1.1;
    expect(failed(scoreCase(drop, dropEvidence), 'balance')).toBe(true);

    const missingFrame = complete(drop);
    missingFrame.frames!.splice(1, 1);
    expect(failed(scoreCase(drop, missingFrame), 'balance')).toBe(true);

    const wrongEnd = complete(drop);
    const step = (wrongEnd.journal as { entries: { cmd: { cmd: string; tEnd?: string } }[] }).entries.find((row) => row.cmd.cmd === 'step.add')!;
    step.cmd.tEnd = '2 ms';
    expect(failed(scoreCase(drop, wrongEnd), 'physics')).toBe(true);

    const wrongGravity = complete(drop);
    const gravity = (wrongGravity.journal as { entries: { cmd: { cmd: string; g?: string[] } }[] }).entries.find((row) => row.cmd.cmd === 'load.gravity')!;
    gravity.cmd.g![2] = '-8 m/s^2';
    expect(failed(scoreCase(drop, wrongGravity), 'physics')).toBe(true);
  });

  it('requires exact catalogue provenance and nonmutating invalid-script validation', () => {
    const named = EVAL_CASES.find((spec) => spec.id === 'N1')!;
    const namedEvidence = complete(named);
    namedEvidence.trace = [];
    expect(failed(scoreCase(named, namedEvidence), 'trace')).toBe(true);

    const partialCopy = complete(named);
    const material = (partialCopy.journal as { entries: { cmd: { cmd: string; rho?: string } }[] }).entries.find((row) => row.cmd.cmd === 'material.add')!;
    material.cmd.rho = '1 kg/m^3';
    expect(failed(scoreCase(named, partialCopy), 'trace')).toBe(true);

    const validation = EVAL_CASES.find((spec) => spec.id === 'V1')!;
    const validationEvidence = complete(validation);
    validationEvidence.trace[0]!.journalAfter = 'changed';
    expect(failed(scoreCase(validation, validationEvidence), 'trace')).toBe(true);

    const wrongSource = complete(validation);
    (wrongSource.trace[0]!.input as { code: string }).code = 'const unrelated = false;';
    expect(failed(scoreCase(validation, wrongSource), 'trace')).toBe(true);

    const wrongOrder = complete(validation);
    wrongOrder.trace.unshift(wrongOrder.trace.pop()!);
    expect(failed(scoreCase(validation, wrongOrder), 'trace')).toBe(true);

    const emptyHash = complete(validation);
    emptyHash.trace[0]!.journalBefore = '';
    emptyHash.trace[0]!.journalAfter = '';
    expect(failed(scoreCase(validation, emptyHash), 'trace')).toBe(true);
  });

  it('rejects heat sources and unselected boundary conditions', () => {
    const heat = EVAL_CASES.find((spec) => spec.id === 'H1')!;
    const evidence = complete(heat);
    (evidence.model as { loads: unknown[] }).loads.push({ name: 'source', kind: 'heatSource', summary: 'wrong' });
    expect(failed(scoreCase(heat, evidence), 'physics')).toBe(true);
  });
});

function scriptedAdapter(host: HostKind, seen: string[], live = false): EvalAdapter {
  return {
    host,
    live,
    availability: async () => ({ available: true }),
    execute: async (spec) => {
      seen.push(`${host}:${spec.id}`);
      return complete(spec);
    },
    close: vi.fn(async () => undefined),
  };
}

describe('lane orchestration and artifacts', () => {
  it('records nonmutating validation calls through the real Assistant tool loop', async () => {
    const queries = ['query.validateScript', 'query.journal', 'query.capabilities', 'query.model', 'query.result'].map((name): QueryDef => ({
      name,
      description: `${name} evaluation query. It provides enough detail for the scripted Assistant harness test.`,
      schema: { type: 'object', properties: { query: { const: name }, code: { type: 'string' } }, required: ['query'] },
      provider: 'engine',
      tool: name === 'query.validateScript',
    }));
    let round = 0;
    const provider: Provider = {
      id: 'openai',
      models: ['scripted'],
      async *chat(request) {
        expect(request.messages[0]?.content[0]).toMatchObject({ type: 'text', text: EVAL_CASES[18]!.prompt });
        if (round < 2) {
          yield { type: 'tool_use' as const, id: `validate-${round}`, name: 'validate_script', input: { code: round === 0 ? EVAL_CASES[18]!.invalidScript : 'good' } };
        } else {
          yield { type: 'text_delta' as const, text: 'Validation repaired.' };
        }
        round++;
        yield { type: 'usage' as const, usage: { input: 10, output: 2, cacheRead: 1 } };
        yield { type: 'done' as const, stopReason: round < 3 ? 'tool_use' : 'stop' };
      },
    };
    const close = vi.fn(async () => undefined);
    const remote: RemoteEngine = {
      definitions: async () => ({ commands: [], queries, defs: {} }),
      invoke: async (command, input) => {
        if (command === 'query.journal') return { hash: 'stable', revision: 0, entries: [] };
        if (command === 'query.validateScript') return { ok: input['code'] === 'good' };
        if (command === 'query.capabilities') return { engineVersion: 'test' };
        if (command === 'query.model') return { bodies: [] };
        if (command === 'query.result') return null;
        throw new Error(`unexpected ${command}`);
      },
      close,
    };
    const evidence = await evaluateCase(remote, provider, 'scripted', EVAL_CASES[18]!, { maxTokens: 100, maxRounds: 3, timeoutMs: 1000 });
    expect(evidence).toMatchObject({
      status: 'completed',
      assistantText: 'Validation repaired.',
      usage: { input: 30, output: 6, cacheRead: 3 },
      trace: [
        { command: 'query.validateScript', output: { ok: false }, journalBefore: 'stable', journalAfter: 'stable' },
        { command: 'query.validateScript', output: { ok: true }, journalBefore: 'stable', journalAfter: 'stable' },
      ],
    });
    expect(round).toBe(3);
    expect(close).toHaveBeenCalledOnce();
  });

  it('exercises all twenty IDs through both host interfaces without calling a fake run live', async () => {
    const seen: string[] = [];
    const browser = await runLane(scriptedAdapter('browser', seen));
    const mcp = await runLane(scriptedAdapter('mcp', seen));
    expect(seen).toHaveLength(40);
    expect(seen.slice(0, 20)).toEqual(EVAL_CASES.map((spec) => `browser:${spec.id}`));
    expect(seen.slice(20)).toEqual(EVAL_CASES.map((spec) => `mcp:${spec.id}`));
    expect(browser).toMatchObject({ passed: 20, live: false, gatePassed: false });
    expect(mcp).toMatchObject({ passed: 20, live: false, gatePassed: false });
  });

  it('records unavailable credentials as not-run and closes without executing', async () => {
    const execute = vi.fn();
    const close = vi.fn(async () => undefined);
    const lane = await runLane({ host: 'browser', live: true, availability: async () => credentialAvailability(undefined), execute, close });
    expect(lane).toMatchObject({ status: 'not-run', reason: 'provider credential unavailable', gatePassed: false });
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('refuses to serialize a provider credential and never promotes a scripted lane', async () => {
    const lane = await runLane(scriptedAdapter('browser', [], false));
    const artifact: EvaluationArtifact = {
      format: 'femlab-assistant-eval/1',
      manifest: {
        gitCommit: 'abc', dirty: false, engineVersion: '0', schemaVersion: '1', specificationSha256: 'sha',
        artifacts: {
          before: { app: 'a', nodeWasm: 'w', mcpPackage: 'm', mcpTarball: 't' },
          after: { app: 'a', nodeWasm: 'w', mcpPackage: 'm', mcpTarball: 't' }, stable: true,
        },
        provenance: { source: 'built-from-clean-HEAD', buildCommands: [], appServer: 'runner-loopback', mcp: 'isolated-tarball-install' },
        provider: 'openai', model: 'model', configuration: {},
        hosts: { browser: { capabilities: {} }, mcp: { node: 'v1', platform: 'test', arch: 'test', capabilities: {} } },
        startedAt: '2026-09-06T00:00:00Z', finishedAt: '2026-09-06T00:01:00Z',
      },
      lanes: [lane],
    };
    expect(JSON.parse(serializeArtifact(artifact, ['secret']))).toMatchObject({ lanes: [{ gatePassed: false }] });
    artifact.manifest.configuration['accidental'] = 'secret';
    expect(() => serializeArtifact(artifact, ['secret'])).toThrow('provider credential');
  });

  it('serves only the frozen app tree with threaded-wasm isolation headers', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'femlab-frozen-app-'));
    await writeFile(path.join(directory, 'index.html'), '<p>frozen</p>');
    const server = await serveFrozenApp(directory);
    try {
      const response = await fetch(server.url);
      expect(await response.text()).toBe('<p>frozen</p>');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
      expect((await fetch(`${server.url}..%2Foutside`)).status).toBe(404);
      expect((await fetch(`${server.url}%E0%A4%A`)).status).toBe(400);
    } finally {
      await server.close();
      await rm(directory, { recursive: true });
    }
  });

  it('rejects an MCP executable outside the hashed package directory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'femlab-frozen-mcp-'));
    const entry = path.join(directory, 'femlab-mcp.js');
    await writeFile(entry, '');
    try {
      await expect(assertInFrozenPackage(directory, [entry])).resolves.toBe(await realpath(directory));
      await expect(assertInFrozenPackage(directory, [import.meta.filename])).rejects.toThrow('outside frozen MCP package');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
