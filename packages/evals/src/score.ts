import type { CaseScore, CheckResult, EvalCase, EvalEvidence, LaneResult, ToolTrace, HostKind } from './types';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

const FACTOR: Record<string, number> = {
  m: 1, mm: 1e-3, cm: 1e-2, um: 1e-6, 'µm': 1e-6,
  N: 1, kN: 1e3,
  Pa: 1, kPa: 1e3, MPa: 1e6, GPa: 1e9, psi: 6894.757293168, ksi: 6_894_757.293168,
  s: 1, ms: 1e-3,
  Hz: 1, kHz: 1e3,
  K: 1,
  '1': 1,
  'kg/m^3': 1, 'g/cm^3': 1e3,
  '1/K': 1,
  'W/(m K)': 1,
  'J/(kg K)': 1,
  'm/s^2': 1,
};

/** Convert an engine `{ value, unit }` boundary value to the SI basis used by the fixed oracles. */
export function valuedSi(value: unknown): number | null {
  const row = object(value);
  const n = finite(row?.['value']);
  const unit = typeof row?.['unit'] === 'string' ? row['unit'] : null;
  const factor = unit === null ? undefined : FACTOR[unit];
  return n === null || factor === undefined ? null : n * factor;
}

function commandEntries(journal: unknown): Record<string, unknown>[] {
  const root = object(journal);
  return array(root?.['entries']).flatMap((entry) => {
    const cmd = object(object(entry)?.['cmd']);
    return cmd === null ? [] : [cmd];
  });
}

function cmdName(cmd: Record<string, unknown>): string {
  return typeof cmd['cmd'] === 'string' ? cmd['cmd'] : '';
}

function lastCommand(entries: Record<string, unknown>[], name: string, objectName?: string): Record<string, unknown> | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (cmdName(entry) === name && (objectName === undefined || entry['name'] === objectName)) return entry;
  }
  return undefined;
}

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === 'string');
}

function sameNames(actual: unknown, expected: string[]): boolean {
  const names = strings(actual);
  return names.length === expected.length && names.every((name) => expected.includes(name));
}

function close(actual: number, expected: number, relative = 1e-9, absolute = 1e-12): boolean {
  return Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative);
}

function check(name: CheckResult['name'], passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

function resultValue(spec: EvalCase, evidence: EvalEvidence): number | null {
  const result = object(evidence.result);
  if (spec.measure.kind === 'extreme') {
    const measure = spec.measure;
    const hit = array(result?.['extremes']).map(object).find((row) =>
      row !== null && row['field'] === measure.field && row['component'] === measure.component);
    return valuedSi(hit?.[measure.side]);
  }
  if (spec.measure.kind === 'probe') return valuedSi(object(evidence.probe)?.['value']);
  if (spec.measure.kind === 'frequency') return valuedSi(array(result?.['frequencies'])[spec.measure.index]);
  const measure = spec.measure;
  const frames = evidence.frames ?? [];
  const last = object(frames[frames.length - 1]);
  const values = array(last?.['values']).map(finite);
  return values.length >= 3 && values[measure.component] !== null && values[measure.component] !== undefined ? values[measure.component]! : null;
}

function geometryAndProcedure(spec: EvalCase, evidence: EvalEvidence, entries: Record<string, unknown>[]): CheckResult {
  const names = new Set(entries.map(cmdName));
  const required = ['model.new', 'geometry.addBox', 'material.add', 'material.assign', 'mesh.set', 'step.add', 'solve.run'];
  const missing = required.filter((name) => !names.has(name));
  const model = object(evidence.model);
  const bodies = array(model?.['bodies']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const bbox = array(bodies[0]?.['bbox']).map(valuedSi);
  const extents = bbox.length === 6 && bbox.every((n) => n !== null)
    ? [bbox[3]! - bbox[0]!, bbox[4]! - bbox[1]!, bbox[5]! - bbox[2]!]
    : [];
  const dimensionsOk = extents.length === 3 && extents.every((n, i) => close(n, spec.dimensionsM[i]!, 1e-8));
  const steps = array(model?.['steps']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const solvedSteps = steps.filter((step) => step['procedure'] === spec.procedure && step['solved'] === true);
  const solved = solvedSteps.length === 1 && object(evidence.result)?.['step'] === solvedSteps[0]?.['name']
    && object(evidence.result)?.['stale'] !== true;
  const materials = array(model?.['materials']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const material = materials[0];
  const e = valuedSi(material?.['E']);
  const nu = finite(material?.['nu']);
  const rho = valuedSi(material?.['rho']);
  const materialOk = materials.length === 1 && e !== null && close(e, spec.materialE, 1e-8)
    && nu !== null && close(nu, spec.materialNu, 1e-10)
    && (spec.materialRho === undefined || (rho !== null && close(rho, spec.materialRho, 1e-8)))
    && material?.['name'] === bodies[0]?.['material']
    && sameNames(material?.['assignedTo'], [String(bodies[0]?.['name'])]);
  const meshOk = object(model?.['meshSettings']) !== null;
  const warningsOk = array(model?.['warnings']).length === 0;
  const passed = missing.length === 0 && bodies.length === 1 && dimensionsOk && steps.length === 1 && solved && materialOk && meshOk && warningsOk;
  const details = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    bodies.length !== 1 ? `expected one body, got ${bodies.length}` : '',
    dimensionsOk ? '' : 'body dimensions differ',
    solved ? '' : `no solved ${spec.procedure} Step`,
    materialOk ? '' : 'material values or assignment differ',
    meshOk ? '' : 'mesh settings are missing',
    warningsOk ? '' : 'final Model has warnings',
  ].filter(Boolean);
  return check('model', passed, passed ? 'final Model matches the fixed problem' : details.join('; '));
}

function procedureSemantics(spec: EvalCase, evidence: EvalEvidence, entries: Record<string, unknown>[]): CheckResult {
  const model = object(evidence.model);
  const steps = array(model?.['steps']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const step = steps.find((row) => row['procedure'] === spec.procedure && row['solved'] === true);
  const stepName = typeof step?.['name'] === 'string' ? step['name'] : '';
  const stepCommand = lastCommand(entries, 'step.add', stepName);
  const constraints = array(model?.['constraints']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const loads = array(model?.['loads']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const result = object(evidence.result);
  if (spec.kind === 'heat') {
    const materialName = object(array(model?.['materials'])[0])?.['name'];
    const material = lastCommand(entries, 'material.add', typeof materialName === 'string' ? materialName : undefined);
    const conductivity = quantity(material?.['k']);
    const leftRow = constraints.find((entry) => String(entry['on']).endsWith('.xmin'));
    const rightRow = constraints.find((entry) => String(entry['on']).endsWith('.xmax'));
    const left = lastCommand(entries, 'constraint.temperature', typeof leftRow?.['name'] === 'string' ? leftRow['name'] : undefined);
    const right = lastCommand(entries, 'constraint.temperature', typeof rightRow?.['name'] === 'string' ? rightRow['name'] : undefined);
    const ok = conductivity !== null && close(conductivity, spec.thermal!.conductivity, 1e-9)
      && close(quantity(left?.['value']) ?? NaN, spec.thermal!.leftK, 1e-9)
      && close(quantity(right?.['value']) ?? NaN, spec.thermal!.rightK, 1e-9)
      && constraints.length === 2 && loads.length === 0
      && sameNames(step?.['constraints'], [String(leftRow?.['name']), String(rightRow?.['name'])])
      && sameNames(step?.['loads'], [])
      && sameNames(stepCommand?.['constraints'], [String(leftRow?.['name']), String(rightRow?.['name'])])
      && sameNames(stepCommand?.['loads'], []);
    return check('physics', ok, ok ? 'conductivity, two end temperatures and no heat loads match' : 'heat material, boundary or selected Step inputs differ');
  }
  if (spec.kind === 'explicit') {
    const gravityRow = loads[0];
    const gravity = lastCommand(entries, 'load.gravity', typeof gravityRow?.['name'] === 'string' ? gravityRow['name'] : undefined);
    const actualG = array(gravity?.['g']).map(quantity);
    const measure = spec.measure;
    const expectedG = measure.kind === 'frames'
      ? [0, 0, 0].map((value, index) => index === measure.component ? measure.acceleration : value)
      : [];
    const tEnd = quantity(stepCommand?.['tEnd']);
    const ok = constraints.length === 0 && loads.length === 1 && gravityRow?.['kind'] === 'gravity'
      && sameNames(step?.['constraints'], []) && sameNames(step?.['loads'], [String(gravityRow?.['name'])])
      && sameNames(stepCommand?.['constraints'], []) && sameNames(stepCommand?.['loads'], [String(gravityRow?.['name'])])
      && actualG.length === 3 && actualG.every((value, index) => value !== null && close(value, expectedG[index]!, 1e-10))
      && tEnd !== null && close(tEnd, spec.explicit!.endS, 1e-10) && stepCommand?.['after'] === undefined;
    return check('physics', ok, ok ? 'gravity, unconstrained start-from-rest Step and end time match' : 'explicit gravity, constraints, predecessor or end time differ');
  }
  const fixedRow = constraints.find((row) => String(row['on']).endsWith('.xmin'));
  const fixed = lastCommand(entries, 'constraint.fix', typeof fixedRow?.['name'] === 'string' ? fixedRow['name'] : undefined);
  const dofs = fixed?.['dofs'];
  const fullFix = dofs === undefined || sameNames(dofs, ['ux', 'uy', 'uz']);
  if (spec.kind === 'modal') {
    const ok = constraints.length === 1 && loads.length === 0 && fixed !== undefined && fullFix
      && sameNames(step?.['constraints'], [String(fixedRow?.['name'])]) && sameNames(step?.['loads'], [])
      && sameNames(stepCommand?.['constraints'], [String(fixedRow?.['name'])]) && sameNames(stepCommand?.['loads'], []);
    return check('physics', ok, ok ? 'the modal Step selects one full xmin support and no loads' : 'modal support or selected Step inputs differ');
  }
  const loadRow = loads[0];
  const load = lastCommand(entries, 'load.traction', typeof loadRow?.['name'] === 'string' ? loadRow['name'] : undefined);
  const total = array(load?.['total']).map(quantity);
  const applied = spec.appliedN!;
  const actual = array(result?.['appliedTotal']).map(valuedSi);
  const loadOk = total.length === 3 && total.every((value, index) => value !== null && close(value, applied[index]!, 1e-8, 1e-7))
    && actual.length === 3 && actual.every((value, index) => value !== null && close(value, applied[index]!, 1e-8, 1e-7));
  const ok = constraints.length === 1 && loads.length === 1 && loadRow?.['kind'] === 'traction'
    && String(loadRow?.['on']).endsWith('.xmax') && fixed !== undefined && fullFix && loadOk
    && sameNames(step?.['constraints'], [String(fixedRow?.['name'])]) && sameNames(step?.['loads'], [String(loadRow?.['name'])])
    && sameNames(stepCommand?.['constraints'], [String(fixedRow?.['name'])]) && sameNames(stepCommand?.['loads'], [String(loadRow?.['name'])]);
  return check('physics', ok, ok ? 'the solved Step selects the exact support and traction' : 'support, traction or selected Step inputs differ');
}

/** Numeric prefix and supported unit from a Command quantity. */
function quantity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const row = object(value);
  if (row !== null && typeof row['unit'] === 'string') {
    const n = finite(row['value']);
    const factor = FACTOR[row['unit']];
    return n === null || factor === undefined ? null : n * factor;
  }
  if (typeof value !== 'string') return null;
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(.*?)\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2]!;
  if (!Number.isFinite(n)) return null;
  if (unit === '' || unit === '1') return n;
  const factor = FACTOR[unit];
  return factor === undefined ? null : n * factor;
}

function modalInvariant(evidence: EvalEvidence): CheckResult {
  const frequencies = array(object(evidence.result)?.['frequencies']).map(valuedSi);
  const ordered = frequencies.length > 0 && frequencies.every((f, i) => f !== null && f > 0 && (i === 0 || f > frequencies[i - 1]!));
  return check('balance', ordered, ordered ? 'frequencies are positive and strictly ordered' : 'modal frequency invariant failed');
}

function explicitInvariant(spec: EvalCase, evidence: EvalEvidence): CheckResult {
  const catalogue = object(evidence.framesCatalogue);
  const stamps = array(catalogue?.['frames']).map(object);
  const frames = evidence.frames ?? [];
  const nodeCount = finite(catalogue?.['nodeCount']);
  const expectedValues = nodeCount === null ? -1 : nodeCount * 3;
  const modelHash = typeof object(evidence.model)?.['hash'] === 'string' ? object(evidence.model)!['hash'] : null;
  let ok = stamps.length > 1 && frames.length === stamps.length && nodeCount !== null && nodeCount > 0
    && catalogue?.['field'] === 'displacement' && catalogue?.['components'] === 3 && catalogue?.['storedComponents'] === 3
    && catalogue?.['stale'] === false && typeof catalogue?.['modelHash'] === 'string' && catalogue['modelHash'] === modelHash;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const stamp = stamps[frameIndex];
    const frame = object(frames[frameIndex]);
    const resolved = object(frame?.['sample']);
    const resolvedStamp = object(resolved?.['frame']);
    const time = finite(resolvedStamp?.['timeSi']);
    const values = array(frame?.['values']).map(finite);
    if (stamp === null || time === null || frame?.['field'] !== 'displacement' || frame?.['components'] !== 3
      || frame?.['nodeCount'] !== nodeCount || frame?.['unit'] !== 'm'
      || resolved?.['modelHash'] !== catalogue?.['modelHash'] || resolved?.['step'] !== catalogue?.['step']
      || resolvedStamp?.['index'] !== stamp?.['index'] || time !== stamp?.['timeSi']
      || values.length !== expectedValues || values.some((v) => v === null)) {
      ok = false;
      continue;
    }
    const expected = spec.measure.kind === 'frames' ? 0.5 * spec.measure.acceleration * time * time : NaN;
    for (let i = 0; i < values.length; i += 3) {
      for (let component = 0; component < 3; component++) {
        const target = spec.measure.kind === 'frames' && component === spec.measure.component ? expected : 0;
        if (!close(values[i + component]!, target, 0.005, 1e-12)) ok = false;
      }
    }
  }
  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  const end = spec.explicit?.endS;
  ok = ok && first?.['index'] === 0 && first['timeSi'] === 0
    && typeof last?.['timeSi'] === 'number' && end !== undefined && close(last['timeSi'], end, 1e-12)
    && stamps.every((stamp, index) => stamp !== null && stamp !== undefined && stamp['index'] === index
      && typeof stamp['timeSi'] === 'number' && (index === 0 || stamp['timeSi']! > (stamps[index - 1]?.['timeSi'] as number)));
  return check('balance', ok, ok ? 'every retained frame follows uniform u = g t²/2' : 'explicit retained frames violate constant acceleration');
}

function traceRequirement(spec: EvalCase, evidence: EvalEvidence, entries: Record<string, unknown>[]): CheckResult {
  if (spec.requires === undefined) return check('trace', true, 'no extra trace requirement');
  if (spec.requires === 'material-library') {
    const lookup = evidence.trace.find((call) => call.name.replaceAll('_', '.') === 'query.materialLibrary');
    const material = object(array(object(evidence.model)?.['materials'])[0]);
    const command = lastCommand(entries, 'material.add', typeof material?.['name'] === 'string' ? material['name'] : undefined);
    const source = command?.['source'];
    const output = object(lookup?.output);
    const selected = array(output?.['entries']).map(object).find((entry) => entry?.['materialAddSource'] === source);
    const properties = ['E', 'nu', 'rho', 'alpha', 'k', 'cp', 'yield'];
    const copied = selected !== undefined && properties.every((property) => {
      const sourced = object(selected?.[property]);
      const expected = sourced?.['value'];
      const actual = command?.[property];
      if (expected === undefined) return actual === undefined;
      const a = quantity(actual);
      const b = quantity(expected);
      return a !== null && b !== null && close(a, b, 1e-10);
    });
    return check('trace', lookup !== undefined && typeof source === 'string' && source.length > 0 && copied,
      copied ? 'all reported catalogue values and provenance were copied exactly' : 'catalogue values, lookup or exact provenance differ');
  }
  const calls = evidence.trace;
  const isValidation = (call: ToolTrace) => call.command === 'query.validateScript' || call.name === 'validate_script';
  const sourceOf = (call: ToolTrace): string => typeof object(call.input)?.['code'] === 'string' ? object(call.input)!['code'] as string : '';
  const badIndex = calls.findIndex((call) => isValidation(call) && object(call.output)?.['ok'] === false && sourceOf(call).includes(spec.invalidScript ?? '\0'));
  const goodIndex = calls.findIndex((call, index) => index > badIndex && isValidation(call) && object(call.output)?.['ok'] === true
    && !sourceOf(call).includes(spec.invalidScript ?? '\0'));
  const executionIndex = calls.findIndex((call) => {
    const command = call.command ?? call.name.replaceAll('_', '.');
    return command === 'script.run' || !['query.', 'view.', 'selection.', 'panel.', 'export.', 'skill.'].some((prefix) => command.startsWith(prefix));
  });
  const stable = [calls[badIndex], calls[goodIndex]].every((call) => typeof call?.journalBefore === 'string'
    && call.journalBefore.length > 0 && call.journalBefore === call.journalAfter);
  const ordered = badIndex >= 0 && goodIndex > badIndex && executionIndex > goodIndex;
  return check('trace', stable && ordered,
    stable && ordered ? 'supplied invalid source and correction validated before execution without mutation' : 'validation source, hash stability or invalid→corrected→execution order failed');
}

function replayCheck(evidence: EvalEvidence): CheckResult {
  const forbidden = new Set(['example.open', 'file.open', 'file.openExample', 'project.open']);
  const direct = evidence.trace.find((call) => forbidden.has(call.command ?? call.name.replaceAll('_', '.')));
  const nested = evidence.trace.find((call) => {
    if ((call.command ?? call.name) !== 'script.run') return false;
    const code = typeof object(call.input)?.['code'] === 'string' ? object(call.input)!['code'] as string : '';
    return /fem\.(?:example\.open|file\.(?:open|openExample)|project\.open)\s*\(/.test(code);
  });
  const passed = direct === undefined && nested === undefined;
  return check('journal', passed, passed ? 'no direct or canonical scripted prepared-Model route was used' : `used ${direct?.command ?? nested?.command ?? 'a canonical replay route in script.run'}`);
}

export function scoreCase(spec: EvalCase, evidence: EvalEvidence): CaseScore {
  const entries = commandEntries(evidence.journal);
  const result = object(evidence.result);
  const status = check('status', evidence.status === 'completed', evidence.status === 'completed' ? 'attempt completed' : evidence.reason ?? evidence.status);
  const journal = replayCheck(evidence);
  const model = geometryAndProcedure(spec, evidence, entries);
  const semantics = procedureSemantics(spec, evidence, entries);
  const observed = resultValue(spec, evidence);
  const tolerance = Math.max(spec.absoluteTolerance ?? 0, Math.abs(spec.expected) * (spec.relativeTolerance ?? 0));
  const value = check('value', observed !== null && Math.abs(observed - spec.expected) <= tolerance,
    observed === null ? 'scored value is missing or non-finite' : `observed ${observed}, expected ${spec.expected} ± ${tolerance}`);
  const balance = spec.kind === 'modal' ? modalInvariant(evidence)
    : spec.kind === 'explicit' ? explicitInvariant(spec, evidence)
      : check('balance', finite(result?.['balance']) !== null && finite(result?.['balance'])! <= 1e-9,
        `balance ${String(result?.['balance'])}, limit 1e-9`);
  const trace = traceRequirement(spec, evidence, entries);
  const checks = [status, journal, model, semantics, value, balance, trace];
  return { id: spec.id, prompt: spec.prompt, evidence, passed: checks.every((item) => item.passed), checks, observed, expected: spec.expected };
}

export function laneResult(host: HostKind, live: boolean, scores: CaseScore[], reason?: string): LaneResult {
  if (reason !== undefined) return { host, live, status: 'not-run', reason, cases: [], passed: 0, total: 20, passRate: 0, gatePassed: false };
  const passed = scores.filter((score) => score.passed).length;
  return { host, live, status: 'completed', cases: scores, passed, total: scores.length, passRate: scores.length === 0 ? 0 : passed / scores.length, gatePassed: live && scores.length === 20 && passed >= 16 };
}
