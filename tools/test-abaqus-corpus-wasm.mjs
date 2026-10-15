// Replay a completed native corpus's portable Models through the public WASM session API.
// No native executable is run and no original deck is supplied to WASM. Numerical gates
// call the existing Python corpus oracles, with their original references and tolerances.
// node tools/test-abaqus-corpus-wasm.mjs --native-results <completed-corpus-directory> \
//   --source <acquired-originals> --corpus-python <corpus.py> --out <fresh-directory> \
//   --runtime-provenance <staged-artifact-receipt.json> [--bindings <generated-node.js>]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: Object.fromEntries([
  'native-results', 'source', 'corpus-python', 'out', 'runtime-provenance', 'bindings', 'python',
].map(name => [name, { type: 'string' }])) });
for (const name of ['native-results', 'source', 'corpus-python', 'out', 'runtime-provenance']) {
  assert.ok(values[name], `missing --${name}`);
}
const nativeResults = path.resolve(values['native-results']);
const output = path.resolve(values.out);
const bindings = path.resolve(values.bindings ?? path.join(root, 'tools/wasm-node/femlab_engine_wasm.js'));
const wasmFile = bindings.replace(/\.js$/, '_bg.wasm');
assert.notEqual(wasmFile, bindings, 'bindings must be the generated Node .js file');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = filename => JSON.parse(readFileSync(filename, 'utf8'));
const save = (filename, value) => writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const nativeReceipt = json(path.join(nativeResults, 'receipt.json'));
assert.equal(nativeReceipt.completed, true, 'native corpus must have completed');
const provenanceBytes = readFileSync(values['runtime-provenance']);
const provenance = JSON.parse(provenanceBytes);
for (const filename of [bindings, wasmFile]) {
  const expected = provenance.payloads.find(row => row.path === `tools/wasm-node/${path.basename(filename)}`);
  assert.ok(expected, `missing generated artifact identity: ${filename}`);
  const bytes = readFileSync(filename);
  assert.equal(bytes.byteLength, expected.bytes);
  assert.equal(digest(bytes), expected.sha256);
}
assert.equal(provenance.completeProducerCoreTreeEqual, true);
mkdirSync(output); // Existing evidence is never overwritten, including after a failed run.
writeFileSync(path.join(output, 'runtime-provenance.json'), provenanceBytes, { flag: 'wx' });
const receipt = {
  completed: false, threads: 1, gpu: false, engine: 'public WASM SessionEngine/PreparedEngine',
  command: [process.execPath, ...process.argv.slice(1)], nodeVersion: process.version,
  originalDecksProvidedToWasm: false, nativeReceiptSha256: digest(readFileSync(path.join(nativeResults, 'receipt.json'))),
  bindingsSha256: digest(readFileSync(bindings)), wasmSha256: digest(readFileSync(wasmFile)),
  runtimeProvenanceSha256: digest(provenanceBytes), manifestSha256: nativeReceipt.manifestSha256,
  corpusPythonSha256: digest(readFileSync(values['corpus-python'])), cases: [],
};

// This bridge has no solver. It delegates numerical/source identity checks to the unchanged
// corpus functions and only adapts the captured public DTOs to those existing functions.
const verify = String.raw`
import importlib.util,json,pathlib,sys
module_path,native_path,source_path,out_path=map(pathlib.Path,sys.argv[1:])
spec=importlib.util.spec_from_file_location('corpus',module_path)
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
manifest=json.loads(c.MANIFEST.read_bytes());native=json.loads((native_path/'receipt.json').read_bytes())
assert native['completed'] and native['manifestSha256']==c.digest(c.MANIFEST.read_bytes())
c.check_sources(manifest,source_path)
assert {row['id'] for row in native['cases']}=={row['id'] for row in manifest['comparisons']}|{'authored-assembly-two-material'}
proofs=[]
for row in native['cases']:
    case=next((case for case in manifest['comparisons'] if case['id']==row['id']),None)
    folder=out_path/row['id'];report=json.loads((folder/'convert.stdout').read_bytes())
    commands=json.loads((folder/'explicit-solve.json').read_bytes())
    deck=source_path/case['deck'] if case else c.AUTHORED
    assert row['deckSha256']==report['sha256']==c.digest(deck.read_bytes()) and report['analysisConfigured']
    target=c.analysis_target(report,case['step'] if case else 'AXIAL')
    assert commands[-1]=={'cmd':'solve.run','step':target,'solver':'cpu-direct'}
    raw=json.loads((folder/'wasm-1.stdout').read_bytes())
    result,mesh,surface,u,stress,reaction=raw
    assert not result['stale'] and result['step']==target
    assert u['unit']=='m' and u['components']==3 and stress['unit']=='Pa' and stress['components']==6
    assert (mesh['nodes'],mesh['elements'])==((case['nodes'],case['elements']) if case else (24,4))
    if case:
        reference=c.case_reference(case,source_path)
        labels=c.reference_label_order(mesh,commands,case.get('referenceInstance'))
        proof={'displacements':c.compare_displacements(labels,u['values'],reference,
            case['referenceDisplacementScaleToMetres'],case['displacementRelativeTolerance'],
            case['displacementAbsoluteToleranceMetres']),
            'reactionNewtons':c.total_reaction(reaction,case['totalAppliedForceNewtons'])}
    else:
        proof=c.authored_oracle(surface,u,stress,reaction)
    canonical=json.dumps(c.without_clock(raw),sort_keys=True,separators=(',',':'),allow_nan=False)
    native_raw=json.loads((native_path/row['id']/'solve-1.stdout').read_bytes())
    native_canonical=json.dumps(c.without_clock(native_raw),sort_keys=True,separators=(',',':'),allow_nan=False)
    assert c.digest(native_canonical.encode())==row['canonicalOutputSha256']
    # JSON.stringify emits 0 for native serde's 0.0; distinguish text from decoded DTO equality.
    proof.update({'id':row['id'],'sourceStep':case['step'] if case else 'AXIAL','engineTarget':target,
        'canonicalOutputSha256':c.digest(canonical.encode()),
        'nativeAndWasmCanonicalJsonExactExcludingClock':canonical==native_canonical,
        'nativeAndWasmDtoValuesExactExcludingClock':c.without_clock(raw)==c.without_clock(native_raw)})
    c.write_once(folder/'comparison-1.json',c.json_bytes(proof));proofs.append(proof)
print(json.dumps(proofs,allow_nan=False))
`;

try {
  const wasm = createRequire(import.meta.url)(bindings);
  for (const entry of nativeReceipt.cases) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    const input = path.join(nativeResults, entry.id);
    const folder = path.join(output, entry.id);
    mkdirSync(folder);
    for (const filename of ['imported.femlab.json', 'explicit-solve.json', 'convert.stdout']) {
      writeFileSync(path.join(folder, filename), readFileSync(path.join(input, filename)), { flag: 'wx' });
    }
    const bytes = readFileSync(path.join(folder, 'imported.femlab.json'), 'utf8');
    const portable = JSON.parse(bytes);
    assert.equal(portable.format, 'femlab/1');
    assert.ok(!bytes.includes('*NODE'), 'portable model must not embed original Abaqus text');
    const commands = json(path.join(folder, 'explicit-solve.json'));
    const solve = commands.at(-1);
    assert.deepEqual(commands.slice(0, -1), portable.journal.entries.map(row => row.cmd));
    assert.ok(!commands.slice(0, -1).some(command => command.cmd === 'solve.run'));
    assert.equal(solve.cmd, 'solve.run'); assert.equal(solve.solver, 'cpu-direct');
    const owner = new wasm.SessionEngine(1, `corpus-${entry.id}`);
    let stamp = JSON.parse(owner.stamp());
    const lease = JSON.parse(owner.begin_run(JSON.stringify(stamp.session)));
    let operation = 0;
    const context = () => ({ session: stamp.session, runId: lease.runId, operationId: String(++operation) });
    try {
      const ticket = owner.begin_replacement(JSON.stringify(context()), stamp.stateVersion);
      const candidate = await wasm.PreparedEngine.create(ticket, { threads: 1, gpu: false });
      await candidate.file(bytes);
      candidate.finish(compact => `${JSON.stringify(JSON.parse(compact), null, 2)}\n`, 16 * 1024 * 1024);
      const snapshot = JSON.parse(owner.commit_candidate(candidate));
      stamp = snapshot.stamp;
      assert.equal(snapshot.model.hash, portable.journal.entries.at(-1).hashAfter);
      assert.ok(snapshot.model.steps.every(step => !step.solved), 'portable loading must not solve');
      const reply = JSON.parse(await owner.dispatch(JSON.stringify({ context: context(), expectedVersion: stamp.stateVersion, command: solve })));
      stamp = reply.stamp;
      const queries = [{ query: 'query.result', step: solve.step }, { query: 'query.mesh' },
        { query: 'query.surface', resultId: 'result-1' },
        ...['displacement', 'stress', 'reaction'].map(field => ({ query: 'query.field', step: solve.step, field }))];
      const raw = queries.map(query => JSON.parse(owner.query(JSON.stringify({ context: context(), query }))).value);
      save(path.join(folder, 'wasm-1.stdout'), raw);
      save(path.join(folder, 'session-receipt.json'), {
        portableSha256: digest(bytes), loadedModelHash: snapshot.model.hash,
        expectedJournalHash: portable.journal.entries.at(-1).hashAfter,
        threads: 1, gpu: false, solve, queries, revision: stamp.stateVersion,
      });
      receipt.cases.push({ id: entry.id, deckSha256: entry.deckSha256,
        rawOutputSha256: digest(readFileSync(path.join(folder, 'wasm-1.stdout'))) });
    } finally {
      try { owner.cancel_run(JSON.stringify(stamp.session), lease.runId); }
      finally { owner.free(); }
    }
  }
  const comparison = spawnSync(values.python ?? 'python3', ['-B', '-c', verify,
    path.resolve(values['corpus-python']), nativeResults, path.resolve(values.source), output],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(output, 'oracle.stdout'), comparison.stdout ?? '', { flag: 'wx' });
  writeFileSync(path.join(output, 'oracle.stderr'), comparison.stderr ?? '', { flag: 'wx' });
  assert.equal(comparison.status, 0, comparison.stderr || comparison.error?.message);
  receipt.proofs = JSON.parse(comparison.stdout);
  receipt.completed = true;
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt.error = String(error);
  throw error;
} finally {
  save(path.join(output, 'receipt.json'), receipt);
}
