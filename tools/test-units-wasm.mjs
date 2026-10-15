#!/usr/bin/env node
import { batchModule } from './checked-batch.mjs';
// Exercise the same public boundary cases as the native registry regression in the shipped wasm.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Engine, schema } = batchModule(require("./wasm-node/femlab_engine_wasm.js"));
const fixture = JSON.parse(readFileSync(new URL("../crates/engine/tests/fixtures/invalid-quantities.json", import.meta.url), "utf8"));
const committedSchema = JSON.parse(readFileSync(new URL("../packages/registry/src/generated/engine.schema.json", import.meta.url), "utf8"));
assert.deepEqual(JSON.parse(schema()), committedSchema);
const engine = new Engine(1);
for (const command of [
  { cmd: "model.new", name: "quantity validation" },
  { cmd: "geometry.addBox", name: "beam", size: ["1 m", "100 mm", "100 mm"] },
  { cmd: "material.add", name: "steel", E: "210 GPa", nu: 0.3, rho: "7850 kg/m^3" },
  { cmd: "material.assign", material: "steel", bodies: ["beam"] },
  { cmd: "mesh.set", mesher: { kind: "lattice", size: { nx: 2, ny: 1, nz: 1 } }, order: 1 },
  { cmd: "constraint.fix", name: "root", on: "beam.xmin" },
  { cmd: "load.traction", name: "tip", on: "beam.xmax", total: ["0 N", "0 N", "-1 kN"] },
  { cmd: "step.add", name: "static", procedure: "static", constraints: ["root"], loads: ["tip"] },
  { cmd: "solve.run", step: "static" },
]) await engine.dispatch(JSON.stringify(command));
const before = engine.export_file();
const hash = engine.model_hash();
const retained = engine.query(JSON.stringify({ query: "query.result", step: "static" }));
const displacement = engine.query(JSON.stringify({ query: "query.field", step: "static", field: "displacement" }));
const unchanged = () => {
  assert.equal(engine.model_hash(), hash);
  assert.equal(engine.export_file(), before);
  assert.equal(engine.query(JSON.stringify({ query: "query.result", step: "static" })), retained);
  assert.equal(engine.query(JSON.stringify({ query: "query.field", step: "static", field: "displacement" })), displacement);
};
const rejectsCase = ({ code, cause }) => error => error.code === code && typeof error.where === "string"
  && (cause === undefined || (error.cause.includes(cause) && typeof error.suggestion === "string"));
for (const test of fixture.commands) {
  await assert.rejects(engine.dispatch(JSON.stringify(test.input)), rejectsCase(test));
  unchanged();
}
for (const test of fixture.queries) {
  assert.throws(() => engine.query(JSON.stringify(test.input)), rejectsCase(test));
  unchanged();
}
const numberBits = value => {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  return bytes.getBigUint64(0).toString(16).padStart(16, "0");
};
for (const { input, bits, value } of fixture.conversions) {
  const converted = JSON.parse(engine.query(JSON.stringify(input)));
  if (bits !== undefined) assert.equal(numberBits(converted.value), bits, JSON.stringify(input));
  else assert.equal(converted.value, value, JSON.stringify(input));
  assert.equal(converted.unit, input.to);
  unchanged();
}
engine.free();
console.log(`wasm schema and quantity validation: ${fixture.commands.length} rejected commands, ${fixture.queries.length} rejected queries and ${fixture.conversions.length} conversion oracles passed; Model, Journal and Result preserved`);

// #580/#582: checked display formatting uses the same public registry as native tests.
const displayRead = (owner, input) => JSON.parse(owner.query(JSON.stringify(input)));
// A checked document snapshot intentionally rejects an unreadable display summary. The
// independently callable Journal/definition/retained queries remain available for invariance.
const displaySnapshot = owner => displayRead(owner, { query: 'query.journal' });
const assertDisplaySnapshot = (owner, expected) => assert.deepEqual(displaySnapshot(owner), expected);
const displayError = error => error.code === 'unit.display' && typeof error.where === 'string';
const displayCommand = (owner, command) => owner.dispatch(JSON.stringify(command));

const materialDisplay = new Engine(1);
try {
  for (const command of [
    { cmd: 'model.new', name: 'large finite material' },
    { cmd: 'material.add', name: 'finite', E: '1e308 Pa', nu: 0 },
    { cmd: 'model.setUnits', units: { stress: 'mPa' } },
  ]) await displayCommand(materialDisplay, command);
  const before = displaySnapshot(materialDisplay);
  const definition = displayRead(materialDisplay, { query: 'query.definition', kind: 'material', name: 'finite' });
  for (const query of [{ query: 'query.model' }, { query: 'query.report' }]) {
    assert.throws(() => displayRead(materialDisplay, query), displayError);
    assertDisplaySnapshot(materialDisplay, before);
    assert.deepEqual(displayRead(materialDisplay, { query: 'query.definition', kind: 'material', name: 'finite' }), definition);
  }
  await displayCommand(materialDisplay, { cmd: 'model.setUnits', units: { stress: 'Pa' } });
  assert.deepEqual(displayRead(materialDisplay, { query: 'query.model' }).materials[0].E, { value: 1e308, unit: 'Pa' });
} finally { materialDisplay.free(); }

const compoundDisplay = new Engine(1);
try {
  for (const command of [
    { cmd: 'model.new', name: 'composite length' },
    { cmd: 'model.setUnits', units: { length: 'm*s/s' } },
    { cmd: 'geometry.addBox', name: 'box', size: ['1 m', '1 m', '1 m'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' } },
  ]) await displayCommand(compoundDisplay, command);
  const volume = displayRead(compoundDisplay, { query: 'query.model' }).bodies[0].measure;
  const area = displayRead(compoundDisplay, { query: 'query.set', name: 'box.xmax' }).measure;
  assert.deepEqual(volume, { value: 1, unit: '(m*s/s)*(m*s/s)*(m*s/s)' });
  assert.equal(area.unit, '(m*s/s)*(m*s/s)');
  assert.ok(Math.abs(area.value - 1) < 1e-14);
  assert.deepEqual(displayRead(compoundDisplay, { query: 'query.convert', quantity: volume, to: 'm^3' }), { value: 1, unit: 'm^3' });
  assert.ok(Math.abs(displayRead(compoundDisplay, { query: 'query.convert', quantity: area, to: 'm^2' }).value - 1) < 1e-14);
  for (const command of [
    { cmd: 'model.new', name: 'compound torque' },
    { cmd: 'geometry.addLine', name: 'shaft', points: [['0 m', '0 m', '0 m'], ['1 m', '0 m', '0 m']], divisions: 1, kind: 'beam' },
    { cmd: 'load.moment', name: 'moment', on: 'shaft.p0', total: ['1 N m', '0 N m', '0 N m'] },
    { cmd: 'model.setUnits', units: { force: 'N*Gm^30/m^30', length: 'Gm^5/nm^5*nm^35/m^34' } },
  ]) await displayCommand(compoundDisplay, command);
  const summary = displayRead(compoundDisplay, { query: 'query.model' }).loads[0].summary;
  assert.equal(summary, 'total [1e-45, 0, 0] (N*Gm^30/m^30) (Gm^5/nm^5*nm^35/m^34)');
  const converted = displayRead(compoundDisplay, { query: 'query.convert', quantity: '1 N m', to: '(N*Gm^30/m^30) (Gm^5/nm^5*nm^35/m^34)' });
  assert.ok(Math.abs(converted.value / 1e-45 - 1) < 1e-8);
} finally { compoundDisplay.free(); }

const mappedDisplay = new Engine(1);
try {
  for (const command of [
    { cmd: 'model.new', name: 'mapped display boundary' },
    { cmd: 'model.setIdealisation', idealisation: { kind: 'planeStress', thickness: '1 m' } },
    { cmd: 'mesh.set', mesher: { kind: 'mapped', body: 'plate', blocks: [{ corners: [['0 m', '0 m'], ['1 m', '0 m'], ['1 m', '1 m'], ['0 m', '1 m']], n: [1, 1] }] } },
    { cmd: 'geometry.nameRegion', name: 'outside', where: { kind: 'bbox', min: ['2 m', '0 m', '0 m'], max: ['3 m', '1 m', '1 m'] } },
  ]) await displayCommand(mappedDisplay, command);
  assert.deepEqual(displayRead(mappedDisplay, { query: 'query.model' }).bodies, []);
  assert.throws(() => displayRead(mappedDisplay, { query: 'query.mesh' }), error => error.code === 'set.empty');
  await displayCommand(mappedDisplay, { cmd: 'model.setUnits', units: { length: 'nm^35/m^34' } });
  const before = displaySnapshot(mappedDisplay);
  for (const query of [{ query: 'query.mesh' }, { query: 'query.model' }, { query: 'query.report' }]) {
    assert.throws(() => displayRead(mappedDisplay, query), displayError);
    assertDisplaySnapshot(mappedDisplay, before);
  }
} finally { mappedDisplay.free(); }

const publicationDisplay = new Engine(1);
try {
  for (const command of [
    { cmd: 'model.new', name: 'display publication shaft' },
    { cmd: 'geometry.addLine', name: 'shaft', points: [['0 m', '0 m', '0 m'], ['1 m', '0 m', '0 m']], divisions: 3, kind: 'beam' },
    { cmd: 'material.add', name: 'steel', E: '200 GPa', nu: 0.3 },
    { cmd: 'material.assign', material: 'steel', bodies: ['shaft'] },
    { cmd: 'section.add', name: 'round', shape: { kind: 'circle', radius: '50 mm' } },
    { cmd: 'section.assign', section: 'round', bodies: ['shaft'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '1 m' } },
    { cmd: 'geometry.nameRegion', name: 'whole', where: { kind: 'body', name: 'shaft' } },
    { cmd: 'constraint.fix', name: 'held', on: 'whole' },
    { cmd: 'load.force', name: 'tip', on: 'shaft.p1', total: ['1000 N', '0 N', '0 N'] },
    { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['held'], loads: ['tip'] },
    { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' },
    { cmd: 'constraint.fix', name: 'held', on: 'shaft.p0' },
    { cmd: 'model.setUnits', units: { stress: 'Pa*nm^34/m^34' } },
  ]) await displayCommand(publicationDisplay, command);
  const selected = displayRead(publicationDisplay, { query: 'query.result', step: 'axial' });
  const catalogue = displayRead(publicationDisplay, { query: 'query.results' });
  const before = displaySnapshot(publicationDisplay);
  await assert.rejects(displayCommand(publicationDisplay, { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' }), displayError);
  assertDisplaySnapshot(publicationDisplay, before);
  assert.deepEqual(displayRead(publicationDisplay, { query: 'query.result', step: 'axial' }), selected);
  assert.deepEqual(displayRead(publicationDisplay, { query: 'query.results' }), catalogue);
  await displayCommand(publicationDisplay, { cmd: 'model.setUnits', units: { stress: 'Pa' } });
  await displayCommand(publicationDisplay, { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' });
  const result = displayRead(publicationDisplay, { query: 'query.result', step: 'axial' });
  assert.equal(result.resultId, 'result-2');
  assert.ok(Math.abs(result.reactions[0].total[0].value + 1000) < 1e-8);
  const displacement = displayRead(publicationDisplay, { query: 'query.probe', step: 'axial', field: 'displacement', component: 0, at: ['1 m', '0 m', '0 m'] }).value;
  assert.ok(Math.abs(displacement.value - 1000 / (2e11 * Math.PI * 0.05 ** 2)) < 1e-16);
  // #445 retains its narrower, named ledger error before the wider summary check.
  await displayCommand(publicationDisplay, { cmd: 'model.setUnits', units: { force: 'N*nm^34/m^34' } });
  const held = displaySnapshot(publicationDisplay);
  assert.throws(() => displayRead(publicationDisplay, { query: 'query.result', step: 'axial' }), error => error.code === 'schema' && error.where === 'staticEquilibrium.forceScale');
  assertDisplaySnapshot(publicationDisplay, held);
} finally { publicationDisplay.free(); }
console.log('Checked display/compound units and atomic Result publication passed in shipped WASM; scoped equilibrium errors retain their contract.');

// The native #580 geometry/Set/edge fixtures also cross the actual checked-owner ABI.
// #591 exports canonical SI documents even when a display summary is unreadable.
// Strict snapshots still reject; failed reads preserve the entire file and checked state.
async function checkedDisplayReads(commands, oracle, queries, unreadableModel = false) {
  const owner = new Engine(1);
  try {
    for (const command of commands.slice(0, -1)) await displayCommand(owner, command);
    oracle(owner);
    const baseline = JSON.parse(owner.export_file());
    const baselineHash = owner.model_hash();
    const baselineJournal = displaySnapshot(owner);
    const baselineCatalogue = displayRead(owner, { query: 'query.results' });
    await displayCommand(owner, commands.at(-1));
    const journal = displaySnapshot(owner);
    const catalogue = displayRead(owner, { query: 'query.results' });
    const file = owner.export_file();
    const hash = owner.model_hash();
    const revision = owner.revision();
    const stamp = structuredClone(owner.lease.stamp);
    const exported = JSON.parse(file);
    assert.deepEqual(exported.model, { ...baseline.model, units: commands.at(-1).units },
      'selected display units must not change any canonical SI Model value');
    assert.deepEqual(exported.journal.entries, journal.entries);
    assert.equal(revision, journal.entries.length);
    assert.equal(hash, journal.entries.at(-1).hashAfter);
    if (unreadableModel) assert.throws(() => owner.snapshot(), displayError);
    else displayRead(owner, { query: 'query.model' });
    for (const query of queries) {
      assert.throws(() => displayRead(owner, query), displayError);
      assertDisplaySnapshot(owner, journal);
      assert.deepEqual(displayRead(owner, { query: 'query.results' }), catalogue);
      assert.equal(owner.export_file(), file);
      assert.equal(owner.model_hash(), hash);
      assert.equal(owner.revision(), revision);
      assert.deepEqual(owner.lease.stamp, stamp);
      if (unreadableModel) assert.throws(() => owner.snapshot(), displayError);
    }
    if (unreadableModel) {
      // Recovery is an expected new Command; the whole Journal gains entries. The
      // physical Model/hash returns exactly, while the original prefix stays intact.
      await displayCommand(owner, { cmd: 'model.setUnits', units: baseline.model.units ?? {} });
      assert.deepEqual(JSON.parse(owner.export_file()).model, baseline.model);
      assert.equal(owner.model_hash(), baselineHash);
      assert.deepEqual(displaySnapshot(owner).entries.slice(0, baselineJournal.entries.length), baselineJournal.entries);
      assert.deepEqual(displayRead(owner, { query: 'query.results' }), baselineCatalogue);
    }
  } finally { owner.free(); }
}
const sparseTet = JSON.parse(readFileSync(new URL('../crates/engine/tests/fixtures/imported/sparse-tet.json', import.meta.url), 'utf8'));
for (const [unit, queries] of [
  ['nm^35/m^34', [{ query: 'query.model' }]],
  ['nm^12/m^11', [{ query: 'query.model' }, { query: 'query.set', name: 'part.elset_ALL' }]],
  ['nm^19/m^18', [{ query: 'query.set', name: 'part.surface_BASE' }]],
]) {
  await checkedDisplayReads([
    { cmd: 'model.new', name: 'sparse unit simplex' }, sparseTet,
    { cmd: 'model.setUnits', units: { length: unit } },
  ], owner => {
    const body = displayRead(owner, { query: 'query.model' }).bodies[0];
    assert.equal(body.measure.unit, 'm^3');
    assert.ok(Math.abs(body.measure.value - 1 / 6) < 1e-15);
    assert.deepEqual(displayRead(owner, { query: 'query.set', name: 'part.surface_BASE' }).measure, { value: .5, unit: 'm^2' });
  }, queries, true);
}
await checkedDisplayReads([
  { cmd: 'model.new', name: 'loaded versus geometric face area' },
  { cmd: 'model.setIdealisation', idealisation: { kind: 'planeStress', thickness: '1e100 m' } },
  { cmd: 'mesh.set', mesher: { kind: 'mapped', body: 'square', blocks: [{ corners: [['0 m', '0 m'], ['1 m', '0 m'], ['1 m', '1 m'], ['0 m', '1 m']], n: [1, 1], tags: ['bottom', 'right', 'top', 'left'] }] } },
  { cmd: 'model.setUnits', units: { length: 'nm^12/m^11' } },
], owner => {
  const face = displayRead(owner, { query: 'query.set', name: 'square.bottom' });
  assert.deepEqual(face.measure, { value: 1, unit: 'm' });
  assert.equal(face.pressureArea.unit, 'm^2');
  assert.ok(Math.abs(face.pressureArea.value / 1e100 - 1) < 1e-14);
}, [{ query: 'query.set', name: 'square.bottom' }]);
for (const [points, min, max] of [
  [[[-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], Math.SQRT2, 2],
  [[[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]], Math.sqrt(8), Math.sqrt(8)],
]) {
  await checkedDisplayReads([
    { cmd: 'model.new', name: 'readable bounds, unreadable edge' },
    { cmd: 'mesh.set', mesher: { kind: 'imported', body: 'part', nodes: points.map((point, i) => ({ label: i + 1, at: point.map(x => `${x} m`) })), elements: [{ label: 10, kind: 'tet4', nodes: [1, 2, 3, 4] }] } },
    { cmd: 'model.setUnits', units: { length: 'nm^34*mm*in/(m^33*cm*ft)' } },
  ], owner => {
    const mesh = displayRead(owner, { query: 'query.mesh' });
    assert.deepEqual(mesh.minEdge, { value: min, unit: 'm' });
    assert.deepEqual(mesh.maxEdge, { value: max, unit: 'm' });
  }, [{ query: 'query.mesh' }], true);
}
console.log('Imported Body/Set measures, loaded pressureArea and checked min/max edge boundaries passed in shipped WASM.');

// Exercise the new report composition with exact authored inputs and an independent FL/EA.
const checkedReport = new Engine(1);
try {
  for (const command of [
    { cmd: 'model.new', name: 'authored axial reference' },
    { cmd: 'model.setUnits', units: { length: 'mm', force: 'kN', stress: 'MPa' } },
    { cmd: 'geometry.addBox', name: 'bar', size: ['1 m', '.1 m', '.1 m'] },
    { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: .3 },
    { cmd: 'material.assign', material: 'steel', bodies: ['bar'] },
    { cmd: 'mesh.set', mesher: { kind: 'lattice', size: { nx: 1, ny: 1, nz: 1 } } },
    { cmd: 'constraint.fix', name: 'root', on: 'bar.xmin' },
    { cmd: 'load.traction', name: 'pull', on: 'bar.xmax', total: ['100 kN', '0 N', '0 N'] },
    { cmd: 'step.add', name: 'axial', procedure: 'static', constraints: ['root'], loads: ['pull'] },
    { cmd: 'solve.run', step: 'axial', solver: 'cpu-direct' },
  ]) await displayCommand(checkedReport, command);
  const file = checkedReport.export_file();
  const hash = checkedReport.model_hash();
  const report = displayRead(checkedReport, { query: 'query.report' }).markdown;
  assert.ok(report.includes('end load = total [100, 0, 0] kN, L = 1000 mm, A = 10000 mm^2, E = 210000 MPa'));
  assert.ok(report.includes('F/P is the magnitude of the end load\'s sole nonzero component.'));
  assert.ok(report.includes('| Hand calculation | 0.047619 mm |')); // 100000*1/(210e9*.01), in mm.
  assert.equal(checkedReport.export_file(), file);
  assert.equal(checkedReport.model_hash(), hash);
} finally { checkedReport.free(); }
console.log('Checked report givens retain authored force and the independent FL/EA reference in shipped WASM.');

// #583: a finite positive modulus must not be silently displayed as zero in GPa.
const subnormalDisplay = new Engine(1);
try {
  for (const command of [
    { cmd: 'model.new', name: 'subnormal modulus' },
    { cmd: 'material.add', name: 'small', E: '1e-320 Pa', nu: 0 },
    { cmd: 'model.setUnits', units: { stress: 'GPa' } },
  ]) await displayCommand(subnormalDisplay, command);
  const before = displaySnapshot(subnormalDisplay);
  const definition = displayRead(subnormalDisplay, { query: 'query.definition', kind: 'material', name: 'small' });
  for (const query of [{ query: 'query.model' }, { query: 'query.report' }]) {
    assert.throws(() => displayRead(subnormalDisplay, query), error => displayError(error)
      && error.cause.includes('underflows to zero') && error.suggestion.includes('model.setUnits'));
    assertDisplaySnapshot(subnormalDisplay, before);
    assert.deepEqual(displayRead(subnormalDisplay, { query: 'query.definition', kind: 'material', name: 'small' }), definition);
  }
  await displayCommand(subnormalDisplay, { cmd: 'model.setUnits', units: { stress: 'Pa' } });
  const restored = displayRead(subnormalDisplay, { query: 'query.model' }).materials[0].E;
  assert.equal(numberBits(restored.value), '00000000000007e8');
  assert.equal(restored.unit, 'Pa');
} finally { subnormalDisplay.free(); }
console.log('Subnormal display rejection and exact SI recovery passed in shipped WASM.');
