// A Node-only check (no DOM): every bundled `tutorials/*.json` and every example
// `benches/journals/*.json` parses, every tutorial has the shape `types.ts` promises, and each
// tutorial's `doIt` Commands, replayed in order through the wasm build, actually run — the same
// engine the browser gets, not a second implementation to trust by coincidence.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TUTORIALS } from '../src/tutorial/tutorials';
import type { Tutorial } from '../src/tutorial/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const tutorialsDir = path.resolve(here, '..', 'tutorials');
const journalsDir = path.join(root, 'crates', 'engine', 'benches', 'journals');

const require = createRequire(import.meta.url);
const wasm = require(path.join(root, 'tools', 'wasm-node', 'femlab_engine_wasm.js')) as {
  Engine: new (threads: number) => { replay_hashes(json: string, skipSolves: boolean, verify: boolean): Promise<string> };
};

async function replay(commands: ({ cmd: string } & Record<string, unknown>)[]): Promise<void> {
  const entries = commands.map((cmd, seq) => ({ seq, cmd, hashAfter: '' }));
  const engine = new wasm.Engine(1);
  // verify=false: these are freshly-typed Commands, not a committed Journal to check hashes
  // against — the CLI's own test (`every_bundled_journal_replays_green...`) owns that job.
  await engine.replay_hashes(JSON.stringify(entries), false, false);
}

describe('tutorials/*.json', () => {
  const files = readdirSync(tutorialsDir).filter((f) => f.endsWith('.json'));

  it('bundles the four built-ins the PLAN promises plus one per procedure', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(TUTORIALS.map((t) => t.id).sort()).toEqual(
      ['cantilever', 'heat-conduction', 'mesh-convergence', 'modal-analysis', 'plate-with-hole', 'read-a-result', 'symmetry-and-2d', 'thermal-bar', 'transient-heat'].sort(),
    );
    // every file in the folder is registered: adding one and forgetting the import fails here
    expect(files.map((f) => path.basename(f, '.json')).sort()).toEqual(TUTORIALS.map((t) => t.id).sort());
  });

  // `read-a-result` builds nothing (it explains the Results and Checks panels), so it is the one
  // tutorial with no closed form to end on.
  it('every tutorial that builds a Model closes on a theory block', () => {
    for (const t of TUTORIALS.filter((t) => t.steps.some((s) => s.doIt))) {
      expect(t.steps.some((s) => typeof s.theory === 'string' && s.theory.length > 0), t.id).toBe(true);
    }
  });

  it.each(files)('%s parses and has the shape of a Tutorial', (file) => {
    const tutorial = JSON.parse(readFileSync(path.join(tutorialsDir, file), 'utf8')) as Tutorial;
    expect(typeof tutorial.id).toBe('string');
    expect(typeof tutorial.title).toBe('string');
    expect(typeof tutorial.minutes).toBe('number');
    expect(typeof tutorial.summary).toBe('string');
    expect(Array.isArray(tutorial.steps)).toBe(true);
    expect(tutorial.steps.length).toBeGreaterThan(0);
    for (const step of tutorial.steps) {
      expect(typeof step.title).toBe('string');
      expect(typeof step.explain).toBe('string');
      expect(step.expect === null || typeof step.expect?.cmd === 'string').toBe(true);
      if (step.doIt) expect(typeof step.doIt.cmd).toBe('string');
    }
  });

  it.each(TUTORIALS.map((t): [string, Tutorial] => [t.id, t]))('%s: its doIt Commands replay through the wasm engine', async (_id, tutorial) => {
    const commands = tutorial.steps.filter((s) => s.doIt).map((s) => s.doIt!);
    await replay(commands); // rejects (and fails the test) if the sequence does not run
    // mesh-convergence solves three meshes in one Command, so 5 s is not enough for this one
  }, 30_000);
});

describe('benches/journals/*.json (the Examples gallery)', () => {
  const files = readdirSync(journalsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));

  it('has at least 22 example journals (the cantilever plus ~21 new ones)', () => {
    expect(files.length).toBeGreaterThanOrEqual(22);
  });

  it.each(files)('%s parses as a Journal (an array of {seq, cmd, hashAfter})', (file) => {
    const entries = JSON.parse(readFileSync(path.join(journalsDir, file), 'utf8')) as { seq: number; cmd: { cmd: string }; hashAfter: string }[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.seq).toBe('number');
      expect(typeof e.cmd.cmd).toBe('string');
      expect(typeof e.hashAfter).toBe('string');
      expect(e.hashAfter.length).toBeGreaterThan(0);
    }
    // every example ends on a solve, so Open alone shows a Result and not a ready-to-solve Model
    expect(entries.at(-1)?.cmd.cmd).toBe('solve.run');
  });

  it.each(files)('%s replays through the wasm engine to its committed hashes', async (file) => {
    const raw = readFileSync(path.join(journalsDir, file), 'utf8');
    const entries = JSON.parse(raw) as { seq: number; cmd: unknown; hashAfter: string }[];
    const engine = new wasm.Engine(1);
    // skipSolves, like the CI hash lane: a solve entry's hash is the Model hash, so the
    // comparison is unaffected by the Result, and the suite does not re-solve 22 models.
    const hashes = JSON.parse(await engine.replay_hashes(raw, true, true)) as string[];
    expect(hashes).toEqual(entries.map((e) => e.hashAfter));
  });

  it('every journal has a title, tag, sentence, theory, difficulty and expected value in its .meta.json sidecar', () => {
    for (const file of files) {
      const name = path.basename(file, '.json');
      const meta = JSON.parse(readFileSync(path.join(journalsDir, `${name}.meta.json`), 'utf8')) as Record<string, unknown>;
      expect(typeof meta['title'], name).toBe('string');
      expect(typeof meta['tag'], name).toBe('string');
      expect(typeof meta['sentence'], name).toBe('string');
      expect(typeof meta['theory'], name).toBe('string');
      expect([1, 2, 3], name).toContain(meta['difficulty']);
      expect(Array.isArray(meta['tags']), name).toBe(true);
      // what the solved Result is checked against, and where the reference number came from
      const expected = meta['expected'] as Record<string, unknown>;
      expect(typeof expected['quantity'], name).toBe('string');
      expect(typeof expected['unit'], name).toBe('string');
      expect(typeof expected['reference'], name).toBe('string');
    }
  });
});
