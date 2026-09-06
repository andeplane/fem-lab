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
  const forbidden = entries.find((entry) => ['example.open', 'file.open'].includes(cmdName(entry)));
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
  const solved = steps.some((step) => step['procedure'] === spec.procedure && step['solved'] === true);
  const material = array(model?.['materials']).map(object).find((row) => row !== null);
  const e = valuedSi(material?.['E']);
  const materialOk = spec.materialE === undefined || (e !== null && close(e, spec.materialE, 1e-8));
  const passed = forbidden === undefined && missing.length === 0 && bodies.length === 1 && dimensionsOk && solved && materialOk;
  const details = [
    forbidden ? `forbidden ${cmdName(forbidden)}` : '',
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    bodies.length !== 1 ? `expected one body, got ${bodies.length}` : '',
    dimensionsOk ? '' : 'body dimensions differ',
    solved ? '' : `no solved ${spec.procedure} Step`,
    materialOk ? '' : 'elastic modulus differs',
  ].filter(Boolean);
  return check('model', passed, passed ? 'final Model matches the fixed problem' : details.join('; '));
}

function staticOrHeatSemantics(spec: EvalCase, result: Record<string, unknown> | null, entries: Record<string, unknown>[]): CheckResult {
  if (spec.kind === 'modal' || spec.kind === 'explicit') return check('physics', true, 'procedure-specific invariant checked separately');
  if (spec.kind === 'heat') {
    const material = entries.find((entry) => cmdName(entry) === 'material.add');
    const conductivity = quantity(material?.['k']);
    const temperatures = entries.filter((entry) => cmdName(entry) === 'constraint.temperature');
    const left = temperatures.find((entry) => String(entry['on']).endsWith('.xmin'));
    const right = temperatures.find((entry) => String(entry['on']).endsWith('.xmax'));
    const ok = conductivity !== null && close(conductivity, spec.thermal!.conductivity, 1e-9)
      && close(quantity(left?.['value']) ?? NaN, spec.thermal!.leftK, 1e-9)
      && close(quantity(right?.['value']) ?? NaN, spec.thermal!.rightK, 1e-9);
    return check('physics', ok, ok ? 'conductivity and both end temperatures match' : 'heat material or boundary values differ');
  }
  const fixed = entries.some((entry) => cmdName(entry) === 'constraint.fix' && String(entry['on']).endsWith('.xmin'));
  const actual = array(result?.['appliedTotal']).map(valuedSi);
  const applied = spec.appliedN!;
  const loadOk = actual.length === 3 && actual.every((n, i) => n !== null && close(n, applied[i]!, 1e-8, 1e-7));
  return check('physics', fixed && loadOk, fixed && loadOk ? 'xmin is fixed and applied total matches' : 'support or applied total differs');
}

/** Numeric prefix and supported unit from a Command quantity. */
function quantity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(.*?)\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2]!;
  if (!Number.isFinite(n)) return null;
  if (unit === 'W/(m K)' || unit === 'm/s^2' || unit === '1') return n;
  const factor = FACTOR[unit];
  return factor === undefined ? null : n * factor;
}

function modalInvariant(evidence: EvalEvidence, entries: Record<string, unknown>[]): CheckResult {
  const model = object(evidence.model);
  const steps = array(model?.['steps']).map(object).filter((row): row is Record<string, unknown> => row !== null);
  const modal = steps.find((step) => step['procedure'] === 'modal');
  const noLoads = array(modal?.['loads']).length === 0;
  const fixed = entries.some((entry) => cmdName(entry) === 'constraint.fix' && String(entry['on']).endsWith('.xmin'));
  const frequencies = array(object(evidence.result)?.['frequencies']).map(valuedSi);
  const ordered = frequencies.length > 0 && frequencies.every((f, i) => f !== null && f > 0 && (i === 0 || f > frequencies[i - 1]!));
  return check('balance', fixed && noLoads && ordered, fixed && noLoads && ordered ? 'fixed support, no load, positive ordered modes' : 'modal support/load/frequency invariant failed');
}

function explicitInvariant(spec: EvalCase, evidence: EvalEvidence): CheckResult {
  const frames = evidence.frames ?? [];
  let ok = frames.length > 1;
  for (const raw of frames) {
    const frame = object(raw);
    const time = finite(frame?.['timeSi']);
    const values = array(frame?.['values']).map(finite);
    if (time === null || values.length === 0 || values.length % 3 !== 0 || values.some((v) => v === null)) {
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
  return check('balance', ok, ok ? 'every retained frame follows uniform u = g t²/2' : 'explicit retained frames violate constant acceleration');
}

function traceRequirement(spec: EvalCase, evidence: EvalEvidence, entries: Record<string, unknown>[]): CheckResult {
  if (spec.requires === undefined) return check('trace', true, 'no extra trace requirement');
  if (spec.requires === 'material-library') {
    const lookup = evidence.trace.find((call) => call.name.replaceAll('_', '.') === 'query.materialLibrary');
    const source = entries.find((entry) => cmdName(entry) === 'material.add')?.['source'];
    const output = object(lookup?.output);
    const cited = array(output?.['entries']).map(object).some((entry) => entry?.['materialAddSource'] === source);
    return check('trace', lookup !== undefined && typeof source === 'string' && source.length > 0 && cited,
      cited ? 'catalogue lookup provenance copied exactly' : 'missing catalogue lookup or exact provenance');
  }
  const calls = evidence.trace.filter((call) => call.name === 'validate_script' || call.name === 'query.validateScript');
  const bad = calls.find((call) => object(call.output)?.['ok'] === false);
  const good = calls.find((call) => object(call.output)?.['ok'] === true);
  const unchanged = bad !== undefined && bad.journalBefore !== undefined && bad.journalBefore === bad.journalAfter;
  return check('trace', bad !== undefined && good !== undefined && unchanged,
    bad !== undefined && good !== undefined && unchanged ? 'invalid and corrected scripts validated without mutation' : 'script validation trace is incomplete or mutated the Journal');
}

export function scoreCase(spec: EvalCase, evidence: EvalEvidence): CaseScore {
  const entries = commandEntries(evidence.journal);
  const result = object(evidence.result);
  const status = check('status', evidence.status === 'completed', evidence.status === 'completed' ? 'attempt completed' : evidence.reason ?? evidence.status);
  const forbidden = entries.find((entry) => ['example.open', 'file.open'].includes(cmdName(entry)));
  const journal = check('journal', forbidden === undefined, forbidden === undefined ? 'no prepared Model or example replay' : `used ${cmdName(forbidden)}`);
  const model = geometryAndProcedure(spec, evidence, entries);
  const semantics = staticOrHeatSemantics(spec, result, entries);
  const observed = resultValue(spec, evidence);
  const tolerance = Math.max(spec.absoluteTolerance ?? 0, Math.abs(spec.expected) * (spec.relativeTolerance ?? 0));
  const value = check('value', observed !== null && Math.abs(observed - spec.expected) <= tolerance,
    observed === null ? 'scored value is missing or non-finite' : `observed ${observed}, expected ${spec.expected} ± ${tolerance}`);
  const balance = spec.kind === 'modal' ? modalInvariant(evidence, entries)
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
