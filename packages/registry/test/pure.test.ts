import { describe, expect, it } from 'vitest';
import { FemError, nearest } from '../src/error';
import { MENTION_KINDS, parseMentions, refOf } from '../src/mentions';
import { assertInside, normalisePath } from '../src/project-paths';
import { makeFemProxy } from '../src/script-api';
import { mergeSkills, parseSkill, type Skill } from '../src/skills';
import { decodeBulk } from '../src/transport';

describe('FemError', () => {
  it('is an Error with the engine error fields and defaults', () => {
    const e = new FemError('schema', 'bad');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('schema: bad');
    expect(e.name).toBe('FemError');
    expect(e.toJSON()).toEqual({ code: 'schema', cause: 'bad', where: null, suggestion: null });
  });
  it('nearest prefers the same namespace and falls back to everything', () => {
    expect(nearest('geometry.addSphere', ['geometry.addBox', 'view.fit'])).toBe('geometry.addBox');
    expect(nearest('nope.x', ['geometry.addBox', 'view.fit'])).toBe('geometry.addBox, view.fit');
  });
});

describe('makeFemProxy', () => {
  it('maps namespaces and verbs to dispatch and query', async () => {
    const calls: unknown[] = [];
    const fem = makeFemProxy(
      async (c) => (calls.push(c), 'ack'),
      async (q) => (calls.push(q), 'result'),
    );
    await expect(fem.geometry.addBox({ name: 'beam', size: ['1 m', '1 m', '1 m'] })).resolves.toBe('ack');
    await expect(fem.query.model()).resolves.toBe('result');
    await expect(fem.query.set({ name: 'beam.top' })).resolves.toBe('result');
    await expect(fem.journal.undo()).resolves.toBe('ack');
    // `new` is quoted in the generated `fem.d.ts`, so it stays a plain method here too.
    await expect(fem.model.new({ name: 'beam' })).resolves.toBe('ack');
    expect(calls).toEqual([
      { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '1 m', '1 m'] },
      { query: 'query.model' },
      { query: 'query.set', name: 'beam.top' },
      { cmd: 'journal.undo' },
      { cmd: 'model.new', name: 'beam' },
    ]);
  });
  it('is inert for then and symbols so it can be awaited and inspected', () => {
    const fem = makeFemProxy(async () => 0, async () => 0) as unknown as Record<string | symbol, unknown>;
    expect(fem['then']).toBeUndefined();
    expect(fem[Symbol.toPrimitive]).toBeUndefined();
    const ns = fem['geometry'] as Record<string | symbol, unknown>;
    expect(ns['then']).toBeUndefined();
    expect(ns[Symbol.iterator]).toBeUndefined();
  });
});

describe('mentions', () => {
  it('parses kinded chips, @selection, dedupes, and leaves bare @names as text', () => {
    const r = parseMentions('Check @face:beam.top and @body:beam, then @face:beam.top (see @selection) and @bob.');
    expect(r.text).toContain('@bob.');
    expect(r.selection).toBe(true);
    expect(r.chips).toEqual([
      { ref: 'face:beam.top', kind: 'face', name: 'beam.top' },
      { ref: 'body:beam', kind: 'body', name: 'beam' },
    ]);
    expect(parseMentions('plain text')).toEqual({ text: 'plain text', chips: [], selection: false });
    expect(parseMentions('@selectionist').selection).toBe(false);
  });
  it('round-trips refOf through parseMentions for every kind', () => {
    for (const kind of MENTION_KINDS) {
      const ref = refOf(kind, 'x.y');
      expect(parseMentions(`see @${ref};`).chips).toEqual([{ ref, kind, name: 'x.y' }]);
    }
  });
});

describe('skills', () => {
  const md = '---\nname: beam-theory-check\ndescription: Compare with Euler–Bernoulli.\nwhen: a slender beam\n---\n\n# Steps\n1. Solve.\n';
  it('parses frontmatter and body', () => {
    expect(parseSkill(md, 'builtin')).toEqual({ name: 'beam-theory-check', description: 'Compare with Euler–Bernoulli.', when: 'a slender beam', body: '# Steps\n1. Solve.', source: 'builtin' });
    expect(parseSkill('---\r\nname: x\r\n\r\nnot a key value line\r\n---\r\nbody', 'project')).toEqual({ name: 'x', description: '', body: 'body', source: 'project' });
  });
  it('rejects missing frontmatter or name with a structured error', () => {
    expect(() => parseSkill('# no frontmatter', 'builtin')).toThrow(expect.objectContaining({ code: 'schema', where: 'frontmatter' }));
    expect(() => parseSkill('---\nonly: this\n---', 'builtin')).toThrow(expect.objectContaining({ code: 'schema', where: 'frontmatter.name' }));
    expect(() => parseSkill('---\nname: x', 'builtin')).toThrow(expect.objectContaining({ where: 'frontmatter' }));
  });
  it('mergeSkills lets project override builtin and sorts by name', () => {
    const s = (name: string, source: Skill['source']): Skill => ({ name, description: '', body: source, source });
    expect(mergeSkills([s('b', 'builtin'), s('a', 'builtin')], [s('b', 'project'), s('c', 'project')])).toEqual([s('a', 'builtin'), s('b', 'project'), s('c', 'project')]);
  });
});

describe('project paths', () => {
  it('normalisePath splits on either slash and drops empty and dot segments', () => {
    expect(normalisePath('a/b.md')).toEqual(['a', 'b.md']);
    expect(normalisePath('./a//b\\c/.')).toEqual(['a', 'b', 'c']);
  });
  it('assertInside refuses escapes, absolute paths and odd characters', () => {
    expect(assertInside('reports/./beam.md')).toEqual(['reports', 'beam.md']);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '\\\\server\\share', 'C:\\x', 'a:b', '', '.', 'a/\u0007']) {
      let err: unknown;
      try {
        assertInside(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(FemError);
      expect((err as FemError).code).toBe('file.scope');
      expect((err as FemError).where).toBe(`path '${bad}'`);
    }
  });
});

describe('decodeBulk', () => {
  it('attaches typed arrays by name in header order', () => {
    const positions = new Float32Array([1, 2, 3]);
    const indices = new Uint32Array([0, 1, 2]);
    const flags = new Uint8Array([1]);
    const frame = new Float64Array([1 + 2 ** -40]);
    const out = decodeBulk(
      { value: { faceNames: ['top'] }, buffers: [{ name: 'positions', dtype: 'f32', length: 3 }, { name: 'indices', dtype: 'u32', length: 3 }, { name: 'flags', dtype: 'u8', length: 1 }, { name: 'frame', dtype: 'f64', length: 1 }] },
      [positions.buffer, indices.buffer, flags.buffer, frame.buffer],
    );
    expect(out).toEqual({ faceNames: ['top'], positions, indices, flags, frame });
    expect(out['positions']).toBeInstanceOf(Float32Array);
    expect(decodeBulk({ value: { n: 1 } }, [])).toEqual({ n: 1 });
  });
  it('rejects count and length mismatches with structured errors', () => {
    expect(() => decodeBulk({ value: {}, buffers: [{ name: 'a', dtype: 'f32', length: 1 }] }, [])).toThrow(expect.objectContaining({ code: 'internal', where: 'buffers' }));
    expect(() => decodeBulk({ value: {}, buffers: [{ name: 'a', dtype: 'f32', length: 2 }] }, [new ArrayBuffer(4)])).toThrow(expect.objectContaining({ code: 'internal', where: 'a' }));
  });
});
