import { describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../app/src/ai/eval-api';
import type { QueryDef } from '@femlab/registry';
import { EVAL_CASES } from '../src/cases';
import { evaluateCase, type RemoteEngine } from '../src/remote';
import { scoreCase } from '../src/score';
import { credentialAvailability, runLane, serializeArtifact, type EvalAdapter, type EvaluationArtifact } from '../src/runner';
import type { EvalCase, EvalEvidence, HostKind, ToolTrace } from '../src/types';

const valued = (value: number, unit: string) => ({ value, unit });
const entry = (cmd: Record<string, unknown>, seq: number) => ({ seq, hashAfter: `h${seq}`, cmd });

function complete(spec: EvalCase): EvalEvidence {
  const source = 'catalogue provenance';
  const commands: Record<string, unknown>[] = [
    { cmd: 'model.new', name: spec.id },
    { cmd: 'geometry.addBox', name: 'body', size: spec.dimensionsM.map((n) => `${n} m`) },
    { cmd: 'material.add', name: 'material', E: `${spec.materialE ?? 1e9} Pa`, nu: 0.3, ...(spec.thermal ? { k: `${spec.thermal.conductivity} W/(m K)` } : {}), ...(spec.requires === 'material-library' ? { source } : {}) },
    { cmd: 'material.assign', material: 'material', bodies: ['body'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 4, ny: 1, nz: 1 } } },
  ];
  if (spec.kind === 'heat') {
    commands.push(
      { cmd: 'constraint.temperature', name: 'left', on: 'body.xmin', value: `${spec.thermal!.leftK} K` },
      { cmd: 'constraint.temperature', name: 'right', on: 'body.xmax', value: `${spec.thermal!.rightK} K` },
    );
  } else if (spec.kind !== 'explicit') commands.push({ cmd: 'constraint.fix', name: 'root', on: 'body.xmin' });
  if (spec.kind === 'axial' || spec.kind === 'bending') commands.push({ cmd: 'load.traction', name: 'load', on: 'body.xmax', total: spec.appliedN!.map((n) => `${n} N`) });
  if (spec.kind === 'explicit') commands.push({ cmd: 'load.gravity', name: 'gravity' });
  commands.push(
    { cmd: 'step.add', name: 'step', procedure: spec.procedure },
    { cmd: 'solve.run', step: 'step' },
  );

  const model = {
    bodies: [{ name: 'body', bbox: [valued(0, 'm'), valued(0, 'm'), valued(0, 'm'), ...spec.dimensionsM.map((n) => valued(n, 'm'))] }],
    materials: [{ name: 'material', E: valued(spec.materialE ?? 1e9, 'Pa') }],
    steps: [{ name: 'step', procedure: spec.procedure, solved: true, loads: spec.kind === 'modal' ? [] : ['load'] }],
  };
  const result: Record<string, unknown> = {
    balance: 1e-12,
    appliedTotal: (spec.appliedN ?? [0, 0, 0]).map((n) => valued(n, 'N')),
    extremes: [],
    frequencies: [],
  };
  let probe: unknown;
  let frames: unknown[] | undefined;
  if (spec.measure.kind === 'extreme') {
    result['extremes'] = [{ field: spec.measure.field, component: spec.measure.component, min: valued(spec.expected, 'm'), max: valued(spec.expected, 'm') }];
  } else if (spec.measure.kind === 'probe') probe = { value: valued(spec.expected, 'K') };
  else if (spec.measure.kind === 'frequency') result['frequencies'] = [valued(spec.expected, 'Hz'), valued(spec.expected * 2, 'Hz')];
  else {
    const measure = spec.measure;
    const end = spec.explicit!.endS;
    const frame = (timeSi: number) => {
      const displacement = 0.5 * measure.acceleration * timeSi * timeSi;
      const node = [0, 0, 0];
      node[measure.component] = displacement;
      return { timeSi, values: [...node, ...node] };
    };
    frames = [frame(0), frame(end / 2), frame(end)];
  }

  const trace: ToolTrace[] = [];
  if (spec.requires === 'material-library') trace.push({ name: 'query_materialLibrary', input: {}, output: { entries: [{ materialAddSource: source }] } });
  if (spec.requires === 'script-validation') {
    trace.push(
      { name: 'validate_script', input: { code: 'bad' }, output: { ok: false }, journalBefore: 'empty', journalAfter: 'empty' },
      { name: 'validate_script', input: { code: 'good' }, output: { ok: true }, journalBefore: 'empty', journalAfter: 'empty' },
    );
  }
  return { status: 'completed', model, result, probe, frames, journal: { entries: commands.map(entry) }, trace };
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
  });

  it('requires exact catalogue provenance and nonmutating invalid-script validation', () => {
    const named = EVAL_CASES.find((spec) => spec.id === 'N1')!;
    const namedEvidence = complete(named);
    namedEvidence.trace = [];
    expect(failed(scoreCase(named, namedEvidence), 'trace')).toBe(true);

    const validation = EVAL_CASES.find((spec) => spec.id === 'V1')!;
    const validationEvidence = complete(validation);
    validationEvidence.trace[0]!.journalAfter = 'changed';
    expect(failed(scoreCase(validation, validationEvidence), 'trace')).toBe(true);
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
          yield { type: 'tool_use' as const, id: `validate-${round}`, name: 'query_validateScript', input: { code: round === 0 ? 'bad' : 'good' } };
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
        artifacts: { app: 'a', nodeWasm: 'w', mcpPackage: 'm' }, provider: 'openai', model: 'model', configuration: {},
        hosts: { browser: { capabilities: {} }, mcp: { node: 'v1', platform: 'test', arch: 'test', capabilities: {} } },
        startedAt: '2026-09-06T00:00:00Z', finishedAt: '2026-09-06T00:01:00Z',
      },
      lanes: [lane],
    };
    expect(JSON.parse(serializeArtifact(artifact, ['secret']))).toMatchObject({ lanes: [{ gatePassed: false }] });
    artifact.manifest.configuration['accidental'] = 'secret';
    expect(() => serializeArtifact(artifact, ['secret'])).toThrow('provider credential');
  });
});
