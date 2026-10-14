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
await engine.dispatch(JSON.stringify({ cmd: "model.new", name: "quantity validation" }));
await engine.dispatch(JSON.stringify({ cmd: "geometry.addBox", name: "beam", size: ["1 m", "1 m", "1 m"] }));
const before = engine.export_file();
const hash = engine.model_hash();
const unchanged = () => {
  assert.equal(engine.model_hash(), hash);
  assert.equal(engine.export_file(), before);
};
for (const { input, code } of fixture.commands) {
  await assert.rejects(engine.dispatch(JSON.stringify(input)), (error) => error.code === code && typeof error.where === "string");
  unchanged();
}
for (const { input, code } of fixture.queries) {
  assert.throws(() => engine.query(JSON.stringify(input)), (error) => error.code === code && typeof error.where === "string");
  unchanged();
}
console.log(`wasm schema and quantity validation: ${fixture.commands.length} commands and ${fixture.queries.length} queries passed`);

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
