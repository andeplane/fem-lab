// #351: the source is hand-authored exact STEP, the oracle is analytic geometry, and replay
// receives only normal Commands. OCCT output is never used as the expected physical answer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { batchModule } from './checked-batch.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(new URL('../packages/mcp/package.json', import.meta.url))('esbuild');
const bundled = await build({ entryPoints: [path.join(root, 'packages/registry/src/step-import.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
const { stepGeometry, stepCommand } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const version = 'occt-import-js-0.0.23+femlab.1';
const manifest = JSON.parse(readFileSync(path.join(root, 'vendor/step-converter/manifest.json'), 'utf8'));
assert.equal(manifest.version, version);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const key of ['javascript', 'wasm']) {
  const artifact = manifest.artifacts[key];
  assert.equal(digest(readFileSync(path.join(root, 'vendor/step-converter', artifact.path))), artifact.sha256);
}
const factory = (await import(pathToFileURL(path.join(root, 'vendor/step-converter/dist/occt-import-js.js')).href)).default;
const converter = await factory({ wasmBinary: readFileSync(path.join(root, 'vendor/step-converter/dist/occt-import-js.wasm')) });
const { Engine } = batchModule(require('./wasm-node/femlab_engine_wasm.js'));
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-step-replay-'));
const evidence = process.env.FEMLAB_STEP_EVIDENCE;
const rows = []; const replay = [];
const close = (value, expected, tolerance, what) => assert.ok(Math.abs(value - expected) <= tolerance, `${what}: ${value} != ${expected} ± ${tolerance}`);
const query = (engine, input) => JSON.parse(engine.query(JSON.stringify(input)));
const fixtures = path.join(root, 'packages/app/test/fixtures/step');
try {
  const box = readFileSync(path.join(fixtures, 'analytic-box-m.step'), 'utf8');
  const entities = (source, extra) => source.replace(/ENDSEC;\nEND-ISO-10303-21;\s*$/, `${extra}\nENDSEC;\nEND-ISO-10303-21;\n`);
  const mixed = items => box.replace("ADVANCED_BREP_SHAPE_REPRESENTATION('analytic-box',(#11,#226),#904)", `SHAPE_REPRESENTATION('mixed',(${items}),#904)`);
  const negatives = [
    ['malformed', 'not a STEP file\n', 'STEP_PARSE_FAILED'],
    ['empty-data', box.replace(/DATA;[\s\S]*?ENDSEC;\nEND-ISO/, 'DATA;\nENDSEC;\nEND-ISO'), 'STEP_LOAD_CHECK_FAILED'],
    ['invalid-entity', box.replace("CARTESIAN_POINT('A',(0.,0.,0.))", "CARTESIAN_POINT('A')"), 'STEP_LOAD_CHECK_FAILED'],
    ['empty', mixed('#226'), 'STEP_EMPTY_TOPOLOGY'],
    ['free-wire', entities(mixed('#11,#260'), "#260=GEOMETRIC_CURVE_SET('free-wire',(#261));\n#261=POLYLINE('free-wire',(#100,#101));"), 'STEP_UNSUPPORTED_TOPOLOGY'],
    ['free-point', entities(mixed('#11,#260'), "#260=GEOMETRIC_SET('free-point',(#100));"), 'STEP_UNSUPPORTED_TOPOLOGY'],
    ['empty-shell', entities(mixed('#11,#260'), "#260=SHELL_BASED_SURFACE_MODEL('unsupported-empty-shell',(#261));\n#261=OPEN_SHELL('',());"), 'STEP_EMPTY_TOPOLOGY'],
    ['warning-only-omitted-face', readFileSync(path.join(fixtures, 'untranslatable-face-child.step'), 'utf8'), 'STEP_TRANSFER_CHECK_FAILED'],
    ['external-reference', entities(box.replace("FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));", "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));").replace("'config_control_design',1994", "'automotive_design',2000"), "#250=DOCUMENT_TYPE('STEP AP203');\n#251=DOCUMENT_FILE('missing-part.step','missing-part.step','',#250,'missing-part.step','');\n#252=APPLIED_DOCUMENT_REFERENCE(#251,'',(#7));"), 'STEP_EXTERNAL_REFERENCE'],
  ];
  const rejected = [];
  for (const [name, text, code] of negatives) {
    const bytes = new TextEncoder().encode(text);
    const result = converter.ReadStepFile(bytes, { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.001, angularDeflection: Math.PI });
    assert.equal(result.success, false, name); assert.equal(result.femlab.complete, false, name);
    assert.equal(result.error.code, code, name);
    assert.equal(Object.hasOwn(result, 'meshes'), false); assert.equal(Object.hasOwn(result, 'root'), false);
    assert.throws(() => stepGeometry(result), error => error.code === 'unsupported');
    rejected.push({ name, sha256: digest(bytes), bytes: bytes.length, error: result.error, report: result.femlab });
  }
  const oversized = converter.ReadStepFile(new Uint8Array(16 * 1024 * 1024 + 1), { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: 0.001, angularDeflection: Math.PI });
  assert.equal(oversized.error.code, 'STEP_INPUT_LIMIT'); assert.equal(oversized.success, false); assert.equal(oversized.femlab.complete, false); assert.equal(Object.hasOwn(oversized, 'meshes'), false); assert.equal(Object.hasOwn(oversized, 'root'), false);
  // This directory intentionally has no STEP fixture, converter module or dependency tree.
  copyFileSync(process.env.FEMLAB_NATIVE ?? path.join(root, 'target/release/femlab'), path.join(scratch, 'femlab')); chmodSync(path.join(scratch, 'femlab'), 0o755);
  cpSync(path.join(root, 'tools/wasm-node'), path.join(scratch, 'wasm-node'), { recursive: true });
  for (const name of ['step-replay-only.mjs', 'checked-batch.mjs']) copyFileSync(path.join(root, 'tools', name), path.join(scratch, name));
  for (const spec of [
    { name: 'box-m', file: 'analytic-box-m.step', scale: 1, deflection: 0.001 },
    { name: 'box-mm', file: 'analytic-box-mm.step', scale: 0.001, deflection: 1e-6 },
    { name: 'box-inch', file: 'analytic-box-inch.step', scale: 0.0254, deflection: 0.0000254 },
    ...[0.1, 0.025, 0.00625].map((deflection, index) => ({ name: `cylinder-${index}`, file: 'analytic-cylinder-m.step', scale: 1, deflection })),
  ]) {
    const source = new Uint8Array(readFileSync(path.join(fixtures, spec.file)));
    const output = converter.ReadStepFile(source, { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection: spec.deflection, angularDeflection: Math.PI });
    const geometry = stepGeometry(output);
    const engine = new Engine(1);
    try {
      const imported = stepCommand({ name: 'part', linearDeflection: `${spec.deflection} m`, angularDeflection: `${Math.PI} rad` }, geometry.data, digest(geometry.data));
      await engine.dispatch(JSON.stringify({ cmd: 'model.new', name: spec.name }));
      await engine.dispatch(JSON.stringify(imported));
      let model = query(engine, { query: 'query.model' }); const body = model.bodies[0];
      assert.equal(body.measure.unit, 'm^3'); assert.ok(body.patches.length > 0);
      const volume = body.measure.value; const area = body.patches.reduce((sum, patch) => sum + patch.area.value, 0);
      const bbox = body.bbox.map(value => value.value);
      let row;
      if (spec.name.startsWith('box')) {
        const s = spec.scale;
        close(volume, 6 * s ** 3, 1e-10 * s ** 3, `${spec.name} volume`);
        close(area, 22 * s ** 2, 1e-10 * s ** 2, `${spec.name} area`);
        bbox.forEach((value, i) => close(value, [0, 0, 0, s, 2 * s, 3 * s][i], 1e-12 * s, `${spec.name} bbox[${i}]`));
        assert.equal(geometry.counts.faces, 6);
        row = { ...spec, triangles: geometry.counts.triangles, volume, area, bbox };
      } else {
        const error = 2 * Math.PI - volume; const areaError = 6 * Math.PI - area;
        assert.ok(error > 0 && areaError > 0, 'the convex cylinder tessellation is inscribed');
        close(bbox[2], 0, 1e-12, 'cylinder zmin'); close(bbox[5], 2, 1e-12, 'cylinder zmax');
        for (const i of [0, 1]) assert.ok(bbox[i] >= -1 - 1e-12 && bbox[i] <= -1 + spec.deflection + 1e-7);
        for (const i of [3, 4]) assert.ok(bbox[i] <= 1 + 1e-12 && bbox[i] >= 1 - spec.deflection - 1e-7);
        assert.equal(geometry.counts.faces, 3);
        const angles = new Set(); let sag = 0;
        for (const mesh of output.meshes) {
          const xyz = mesh.attributes.position.array; const index = mesh.index.array;
          for (let k = 0; k < xyz.length; k += 3) {
            const [x, y, z] = xyz.slice(k, k + 3); const radius = Math.hypot(x, y);
            assert.ok(Math.abs(radius - 1) < 1e-10 || Math.abs(z) < 1e-10 || Math.abs(z - 2) < 1e-10, 'surface vertex belongs to exact cylinder or cap');
            if (Math.abs(radius - 1) < 1e-10) angles.add(Math.round((Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI) * 1e12) / 1e12);
          }
          for (let k = 0; k < index.length; k += 3) {
            const p = index.slice(k, k + 3).map(i => xyz.slice(3 * i, 3 * i + 3));
            if (p.every(v => Math.abs(v[2]) < 1e-10) || p.every(v => Math.abs(v[2] - 2) < 1e-10)) continue;
            // The closest radial point on an inscribed lateral facet lies on a projected
            // edge, unless the origin is inside its projected triangle (which is rejected).
            const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
            const signs = p.map((a, i) => cross(a, p[(i + 1) % 3]));
            const projectedArea = cross([p[1][0] - p[0][0], p[1][1] - p[0][1]], [p[2][0] - p[0][0], p[2][1] - p[0][1]]);
            assert.ok(Math.abs(projectedArea) < 1e-14 || !(signs.every(v => v >= 0) || signs.every(v => v <= 0)), 'no lateral facet crosses cylinder axis');
            for (let edge = 0; edge < 3; edge++) {
              const a = p[edge], b = p[(edge + 1) % 3]; const dx = b[0] - a[0], dy = b[1] - a[1]; const length2 = dx * dx + dy * dy;
              const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / length2));
              sag = Math.max(sag, 1 - Math.hypot(a[0] + t * dx, a[1] + t * dy));
            }
          }
        }
        assert.ok(sag <= spec.deflection + 1e-7, `actual radial sag ${sag} exceeds requested fixture tolerance`);
        assert.ok(error <= 2 * Math.PI * (2 * sag - sag * sag) + 1e-10, 'volume lies within independently measured radial bound');
        // Circle points form a regular n-gon: its exact prism volume is a second analytic
        // oracle, independent of either OCCT or the engine's triangle integration.
        const n = angles.size; const polygonVolume = n * Math.sin(2 * Math.PI / n);
        close(volume, polygonVolume, 2e-9, 'regular polygon cylinder volume');
        close(area, 4 * n * Math.sin(Math.PI / n) + n * Math.sin(2 * Math.PI / n), 2e-9, 'regular polygon cylinder area');
        const chord = 2 * Math.sin(Math.PI / n);
        assert.ok(error / chord ** 2 > 0.8 && error / chord ** 2 < 1.3, 'second-order circumferential chord convergence');
        row = { ...spec, triangles: geometry.counts.triangles, volume, area, error, areaError, sag, n, chord, bbox };
      }
      // Exercise the normal imported-face and mesher workflow, keeping replay reasonably small.
      for (const command of [
        { cmd: 'material.add', name: 'solid', E: '1 MPa', nu: 0.25 }, { cmd: 'material.assign', material: 'solid', bodies: ['part'] },
        { cmd: 'geometry.nameFace', name: 'base', of: 'part', where: { kind: 'plane', normal: [0, 0, 1], offset: '0 m', tol: '0.0000001 m' } },
        { cmd: 'mesh.set', mesher: { kind: 'lattice', size: `${spec.scale * 0.5} m` } },
      ]) await engine.dispatch(JSON.stringify(command));
      const queries = [{ query: 'query.model' }, { query: 'query.mesh' }, { query: 'query.set', name: 'base' }];
      const expected = queries.map(input => query(engine, input));
      assert.ok(expected[1].elements > 0 && expected[2].count > 0, 'imported Body meshes and its durable face Set is nonempty');
      const file = JSON.parse(engine.export_file()); const filename = path.join(scratch, `${spec.name}.json`); const journal = path.join(scratch, `${spec.name}-journal.json`);
      writeFileSync(filename, JSON.stringify(file)); writeFileSync(journal, JSON.stringify(file.journal.entries));
      replay.push({ name: spec.name, file: filename, journal, queries, expected });
      rows.push({ ...row, sourceSha256: digest(source), geometrySha256: digest(geometry.data), meshes: geometry.counts.meshes, meshElements: expected[1].elements, baseFaces: expected[2].count, hash: expected[0].hash });
    } finally { engine.free(); }
  }
  const curves = rows.filter(row => row.name.startsWith('cylinder'));
  for (let i = 1; i < curves.length; i++) {
    assert.ok(curves[i].error < curves[i - 1].error && curves[i].areaError < curves[i - 1].areaError);
    assert.ok(curves[i].triangles > curves[i - 1].triangles);
  }
  writeFileSync(path.join(scratch, 'cases.json'), JSON.stringify(replay));
  const stdout = execFileSync(process.execPath, ['step-replay-only.mjs'], { cwd: scratch, encoding: 'utf8' });
  console.log(stdout.trim()); console.log(JSON.stringify({ converter: version, artifacts: manifest.artifacts, rejected, rows }, null, 2));
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, 'step-import-oracles.json'), JSON.stringify({ converter: version, artifacts: manifest.artifacts, rejected, rows, isolatedReplay: stdout }, null, 2));
    const portable = path.join(evidence, 'portable'); mkdirSync(portable, { recursive: true });
    for (const item of replay) for (const file of [item.file, item.journal]) copyFileSync(file, path.join(portable, path.basename(file)));
    writeFileSync(path.join(portable, 'cases.json'), JSON.stringify(replay.map(item => ({ ...item, file: path.basename(item.file), journal: path.basename(item.journal) })), null, 2));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
