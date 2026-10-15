import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Provider } from '../../app/src/ai/eval-api';
import type { QueryDef } from '@femlab/registry';
import { EVAL_CASES } from '../src/cases';
import { evaluateCase, type RemoteEngine } from '../src/remote';
import { scoreCase } from '../src/score';
import { credentialAvailability, runCheckpointedLane, runLane, serializeArtifact, type EvalAdapter, type EvaluationArtifact } from '../src/runner';
import { assertInFrozenPackage, serveFrozenApp } from '../src/static-app';
import type { EvalCase, EvalEvidence, HostKind, LaneResult, ToolTrace } from '../src/types';

const valued = (value: number, unit: string) => ({ value, unit });
const entry = (cmd: Record<string, unknown>, seq: number) => ({ seq, hashAfter: `h${seq}`, cmd });

function complete(spec: EvalCase): EvalEvidence {
  const source = 'catalogue provenance';
  const catalogue = {
    id: spec.id === 'N1' ? 's355j2' : '6061-t6-sheet',
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
    resultId: `result-${spec.id}`,
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
      return { sample: { resultId: result['resultId'], step: 'step', modelHash: 'model-hash', frame: { index, timeSi } }, field: 'displacement', components: 3, nodeCount: 2, unit: 'm', values: [...node, ...node] };
    };
    frames = [frame(0, 0), frame(1, end / 2), frame(2, end)];
    framesCatalogue = { resultId: result['resultId'], step: 'step', modelHash: 'model-hash', stale: false, nodeCount: 2, field: 'displacement', components: 3, storedComponents: 3,
      frames: [{ index: 0, timeSi: 0 }, { index: 1, timeSi: end / 2 }, { index: 2, timeSi: end }] };
  }

  const trace: ToolTrace[] = [];
  if (spec.requires === 'material-library') trace.push({ name: 'query_materialLibrary', command: 'query.materialLibrary', input: {}, output: { entries: [catalogue] }, ok: true });
  if (spec.requires === 'script-validation') {
    trace.push(
      { name: 'validate_script', command: 'query.validateScript', input: { code: spec.invalidScript }, output: { ok: false }, journalBefore: 'empty-hash', journalAfter: 'empty-hash' },
      { name: 'validate_script', command: 'query.validateScript', input: { code: 'await fem.model.new({name: "corrected"});' }, output: { ok: true }, journalBefore: 'empty-hash', journalAfter: 'empty-hash' },
      { name: 'run_script', command: 'script.run', input: { code: 'await fem.model.new({name: "corrected"});' }, output: {} },
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

  it('rejects missing or mixed immutable solve identities even when all Model hashes and values agree', () => {
    const drop = EVAL_CASES.find((spec) => spec.id === 'D1')!;
    const mixedFrame = complete(drop);
    (mixedFrame.frames![1] as { sample: { resultId: string } }).sample.resultId = 'another-equal-input-solve';
    expect(failed(scoreCase(drop, mixedFrame), 'balance')).toBe(true);

    const mixedCatalogue = complete(drop);
    (mixedCatalogue.framesCatalogue as { resultId: string }).resultId = 'another-equal-input-solve';
    expect(failed(scoreCase(drop, mixedCatalogue), 'balance')).toBe(true);

    const missing = complete(EVAL_CASES[0]!);
    delete (missing.result as { resultId?: string }).resultId;
    expect(failed(scoreCase(EVAL_CASES[0]!, missing), 'model')).toBe(true);
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

    const differentExecution = complete(validation);
    (differentExecution.trace[2]!.input as { code: string }).code = 'await fem.model.new({name: "unvalidated"});';
    expect(failed(scoreCase(validation, differentExecution), 'trace')).toBe(true);

    const unvalidatedDirectExecution = complete(validation);
    unvalidatedDirectExecution.trace[2] = { name: 'model_new', command: 'model.new', input: { name: 'unvalidated' }, output: {} };
    expect(failed(scoreCase(validation, unvalidatedDirectExecution), 'trace')).toBe(true);
  });

  it('requires the named grade while allowing recovery from earlier unrelated or failed catalogue lookups', () => {
    const named = EVAL_CASES.find((spec) => spec.id === 'N1')!;
    const wrongGrade = complete(named);
    const catalogue = (wrongGrade.trace[0]!.output as { entries: { id: string }[] }).entries[0]!;
    // S235J2W has the same E, nu and density as S355J2, hence the same axial answer.
    // Copying that entry's own provenance correctly must still fail the requested grade.
    catalogue.id = 's235j2w';
    expect(failed(scoreCase(named, wrongGrade), 'trace')).toBe(true);

    const recovered = complete(named);
    recovered.trace.unshift(
      { name: 'query_materialLibrary', command: 'query.materialLibrary', input: { name: 'steel' }, error: { code: 'ambiguous' }, ok: false },
      { name: 'query_materialLibrary', command: 'query.materialLibrary', input: { name: 'unrelated' }, output: { entries: [{ id: 's235j2w', materialAddSource: 'unrelated source' }] }, ok: true },
    );
    expect(scoreCase(named, recovered).passed).toBe(true);
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
  it('durably retains failed and completed prefixes during later admissions and request checkpoints across hosts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'femlab-prefix-'));
    const output = path.join(directory, 'checkpoint.json');
    const lanes: LaneResult[] = [];
    let caseInFlight = false;
    let requestState = 'idle';
    const persist = async () => { await writeFile(output, JSON.stringify({ lanes, caseInFlight, requestState })); };
    const read = async () => JSON.parse(await readFile(output, 'utf8')) as { lanes: LaneResult[]; caseInFlight: boolean; requestState: string };
    const firstEvidence = complete(EVAL_CASES[0]!);
    // Keep a real failed observation, including its immutable solve identity and journal.
    (firstEvidence.result as { extremes: { max: { value: number } }[] }).extremes[0]!.max.value *= 2;
    const expectedFirst = JSON.parse(JSON.stringify(scoreCase(EVAL_CASES[0]!, firstEvidence)));
    expect(expectedFirst.passed).toBe(false);
    const seen: string[] = [];
    try {
      for (const host of ['browser', 'mcp'] as const) {
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const inSecond = new Promise<void>(resolve => { entered = resolve; });
        const completedBrowser = host === 'mcp' ? JSON.parse(JSON.stringify(lanes[0])) : undefined;
        const running = runCheckpointedLane({
          host, live: true, availability: async () => ({ available: true }), close: async () => undefined,
          execute: async spec => {
            seen.push(`${host}:${spec.id}`);
            if (spec.id === EVAL_CASES[1]!.id) {
              requestState = 'reserved';
              await persist();
              entered();
              await held;
            }
            return spec.id === EVAL_CASES[0]!.id ? firstEvidence : complete(spec);
          },
        }, EVAL_CASES, lanes, {
          beforeCase: async () => {
            caseInFlight = true;
            await persist();
            if (seen.includes(`${host}:${EVAL_CASES[0]!.id}`)) {
              const admitted = await read();
              expect(admitted.lanes.find(lane => lane.host === host)?.cases[0]).toEqual(expectedFirst);
            }
          },
          onCase: async () => { caseInFlight = false; await persist(); },
        });
        try {
          await inSecond;
          for (const state of ['reserved', 'settled']) {
            requestState = state;
            await persist();
            const checkpoint = await read();
            expect(checkpoint).toMatchObject({ caseInFlight: true, requestState: state });
            expect(checkpoint.lanes.find(lane => lane.host === host)).toMatchObject({ status: 'interrupted', gatePassed: false, total: 20, cases: [expectedFirst] });
            if (completedBrowser) expect(checkpoint.lanes[0]).toEqual(completedBrowser);
          }
        } finally { release(); await running; }
        const result = await running;
        await persist();
        expect(result).toMatchObject({ status: 'completed', passed: 19, total: 20 });
        expect(lanes.filter(lane => lane.host === host)).toHaveLength(1);
      }
      expect(seen).toEqual(['browser', 'mcp'].flatMap(host => EVAL_CASES.map(spec => `${host}:${spec.id}`)));
      expect((await read()).lanes.map(lane => lane.cases.length)).toEqual([20, 20]);
    } finally { await rm(directory, { recursive: true }); }
  });

  it('keeps resumed evidence at the first admission and never retries a failed completed case', async () => {
    const browser = await runLane(scriptedAdapter('browser', [], true));
    const failedEvidence: EvalEvidence = { status: 'error', reason: 'preserved original failure', trace: [] };
    const failed = scoreCase(EVAL_CASES[0]!, failedEvidence);
    const lanes: LaneResult[] = [browser, { ...browser, host: 'mcp', cases: [failed], status: 'interrupted', passed: 0, passRate: 0, gatePassed: false }];
    const seen: string[] = [];
    let admission: LaneResult[] | undefined;
    const result = await runCheckpointedLane(scriptedAdapter('mcp', seen, true), EVAL_CASES, lanes, {
      completed: [failed],
      beforeCase: async () => { admission = JSON.parse(JSON.stringify(lanes)); throw new Error('admission stopped'); },
    });
    expect(admission?.[0]).toEqual(JSON.parse(JSON.stringify(browser)));
    expect(admission?.[1]?.cases).toEqual([JSON.parse(JSON.stringify(failed))]);
    expect(result).toMatchObject({ status: 'interrupted', reason: 'admission stopped', cases: [failed] });
    expect(seen).toEqual([]);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toBe(browser);
    expect(lanes[1]).toBe(result);
  });

  it('pins every independent probe, catalogue and frame read to the captured Result id', async () => {
    for (const id of ['H1', 'D1']) {
      const spec = EVAL_CASES.find((candidate) => candidate.id === id)!;
      const reference = complete(spec);
      const resultId = (reference.result as { resultId: string }).resultId;
      const selectedReads: { command: string; input: Record<string, unknown> }[] = [];
      const close = vi.fn(async () => undefined);
      const remote: RemoteEngine = {
        definitions: async () => ({ commands: [], queries: [], defs: {} }),
        invoke: async (command, input) => {
          if (command === 'query.capabilities') return {};
          if (command === 'query.model') return reference.model;
          if (command === 'query.journal') return reference.journal;
          if (command === 'query.result') return reference.result;
          selectedReads.push({ command, input });
          // A latest-per-Step read could now resolve to a second solve with the SAME
          // Model hash. The host refuses that ambiguity in this adversarial fixture.
          expect(input['resultId']).toBe(resultId);
          if (command === 'query.probe') return reference.probe;
          if (command === 'query.frames') return reference.framesCatalogue;
          if (command === 'query.frame') return reference.frames![Number(input['index'])];
          throw new Error(`unexpected ${command}`);
        },
        close,
      };
      const provider: Provider = {
        id: 'openai', models: ['scripted'],
        async *chat() { yield { type: 'done', stopReason: 'stop' }; },
      };
      const evidence = await evaluateCase(remote, provider, 'scripted', spec, { maxTokens: 100, maxRounds: 1, timeoutMs: 1000 });
      expect(evidence.result).toEqual(reference.result);
      if (spec.measure.kind === 'probe') {
        expect(selectedReads).toEqual([{ command: 'query.probe', input: { resultId, field: 'temperature', at: ['0.1 m', '0.01 m', '0.01 m'] } }]);
        expect(evidence.probe).toEqual(reference.probe);
      } else {
        expect(selectedReads).toEqual([
          { command: 'query.frames', input: { resultId } },
          ...[0, 1, 2].map(index => ({ command: 'query.frame', input: { resultId, index } })),
        ]);
        expect(evidence.framesCatalogue).toEqual(reference.framesCatalogue);
        expect(evidence.frames).toEqual(reference.frames);
      }
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('records nonmutating validation calls through the real Assistant tool loop', async () => {
    const queries = ['query.validateScript', 'query.journal', 'query.capabilities', 'query.model', 'query.result'].map((name): QueryDef => ({
      name,
      description: `${name} evaluation query. It provides enough detail for the scripted Assistant harness test.`,
      schema: { type: 'object', properties: { query: { const: name }, code: { type: 'string' } }, required: ['query'] },
      provider: 'engine',
      execution: 'modelRead',
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
      cost: null,
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
          before: { app: 'a', nodeWasm: 'w', mcpPackage: 'm', mcpTarball: 't', mcpDependencies: 'd', mcpLock: 'l' },
          after: { app: 'a', nodeWasm: 'w', mcpPackage: 'm', mcpTarball: 't', mcpDependencies: 'd', mcpLock: 'l' }, stable: true,
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
