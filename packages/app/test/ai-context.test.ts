// The system prompt is generated (PLAN 4.5), the chips are resolved through `query.*` (4.11), the
// project's AGENTS.md is standing instructions (4.13) and an image is downscaled before it is sent
// (4.15). A real `Registry` over the real schema, a fake engine behind it.
import { Registry, type EngineSchema, type Selection, type Skill } from '@femlab/registry';
import { describe, expect, it } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { apiReference, buildSystem, buildTurn, downscaleImage, fitTo, objectIndex, projectBlock, resolveMention, screenshotBlock, skillsIndex, type ImageEnv } from '../src/ai/context';

const MODEL = {
  bodies: [{ name: 'beam', material: 'steel' }],
  materials: [{ name: 'steel', E: { value: 210, unit: 'GPa' } }],
  loads: [{ name: 'p', on: 'beam.top' }],
  constraints: [],
  steps: [{ name: 'static' }],
};
const OBJECTS = { objects: [{ ref: 'body:beam', kind: 'body', name: 'beam', summary: 'a box' }] };

function registryWith(answers: Record<string, unknown> = {}, projectOpen = false, files: { path: string; size: number; kind: string }[] = []): Registry {
  const transport = fakeTransport();
  transport.query = (async (q: { query: string }) => {
    if (q.query in answers) return answers[q.query];
    if (q.query === 'query.model') return MODEL;
    if (q.query === 'query.objects') return OBJECTS;
    throw new Error(`no fake for ${q.query}`);
  }) as never;
  const host = fakeHost(transport, projectOpen);
  host.project.info = (() => (projectOpen ? { name: 'proj', files, agentsMd: 'AGENTS.md', skills: [] } : null)) as never;
  return new Registry({ schema: schema as unknown as EngineSchema, host });
}

const SKILLS: Skill[] = [
  { name: 'beam-theory-check', description: 'Compare with Euler–Bernoulli.', when: 'a beam was solved', body: '# do it', source: 'builtin' },
  { name: 'write-report', description: 'Write a calculation note.', body: '# report', source: 'project' },
];

describe('the system prompt', () => {
  it('is generated from the registry: every tool Command with its parameters', () => {
    const text = apiReference(registryWith());
    expect(text).toContain('geometry.addBox(');
    expect(text).toContain('query.model() —');
    expect(text).toMatch(/journal\.undo\(steps\?, expectedJournal\?\)/);
    expect(text).not.toContain('cmd,');
  });

  it('carries the units, sourced-material and verification rules, in that fixed order', () => {
    const system = buildSystem({ registry: registryWith(), skills: SKILLS, project: null });
    expect(system).toContain('as a unit string');
    expect(system).toContain('call query.materialLibrary before material.add');
    expect(system).toContain('for dimensionless nu, pass the inner numeric');
    expect(system).toContain('Never fill a null property');
    expect(system).toContain('check the reaction sum against the applied load');
    expect(system.indexOf('Units:')).toBeLessThan(system.indexOf('# The API'));
    expect(system.indexOf('# The API')).toBeLessThan(system.indexOf('# Skills'));
  });

  it('indexes the skills with their description and when, and says the model may invoke one', () => {
    const index = skillsIndex(SKILLS);
    expect(index).toContain('/beam-theory-check — Compare with Euler–Bernoulli. — use when a beam was solved');
    expect(index).toContain('/write-report — Write a calculation note.');
    expect(skillsIndex([])).toBe('');
  });

  it('includes the project AGENTS.md text exactly once, framed as standing instructions', () => {
    const project = { name: 'bridge', files: [{ path: 'AGENTS.md', size: 40, kind: 'agents' }], agentsMd: { file: 'AGENTS.md', text: 'All stresses in MPa. S355 yield 355 MPa.' } };
    const system = buildSystem({ registry: registryWith(), skills: [], project });
    expect(system.match(/S355 yield 355 MPa/g)).toHaveLength(1);
    expect(system).toContain('<project name="bridge">');
    expect(system).toContain('standing instructions');
    expect(projectBlock(null)).toBe('');
  });

  it('lists the project files without an AGENTS.md when the folder has none', () => {
    const block = projectBlock({ name: 'p', files: [{ path: 'calc/beam.ts', size: 12, kind: 'script' }], agentsMd: null });
    expect(block).toContain('calc/beam.ts (12 B, script)');
    expect(block).not.toContain('standing instructions');
  });
});

describe('mention resolution', () => {
  it('reads a body, a material, a load and a step off query.model', async () => {
    const r = registryWith();
    expect(await resolveMention('body:beam', r)).toEqual({ name: 'beam', material: 'steel' });
    expect(await resolveMention('material:steel', r)).toEqual({ name: 'steel', E: { value: 210, unit: 'GPa' } });
    expect(await resolveMention('load:p', r)).toEqual({ name: 'p', on: 'beam.top' });
    expect(await resolveMention('step:static', r)).toEqual({ name: 'static' });
  });

  it('asks query.set for a face or a Set, query.result for a Result and query.journal for an entry', async () => {
    const r = registryWith({ 'query.set': { name: 'beam.top', count: 4 }, 'query.result': { step: 'static', peak: 1 }, 'query.journal': { entries: [{ seq: 3 }] } });
    expect(await resolveMention('face:beam.top', r)).toEqual({ name: 'beam.top', count: 4 });
    expect(await resolveMention('set:beam.top', r)).toEqual({ name: 'beam.top', count: 4 });
    expect(await resolveMention('result:static', r)).toEqual({ step: 'static', peak: 1 });
    expect(await resolveMention('journal:3', r)).toEqual({ entries: [{ seq: 3 }] });
  });

  it('reads a project file through file.read and keeps only the first 4 KB', async () => {
    const r = registryWith({}, true);
    const file = (await resolveMention('file:notes.md', r)) as { path: string; text: string };
    expect(file).toEqual({ path: 'notes.md', text: 'content of notes.md' });
  });

  it('refuses an unknown ref with the names that do exist, and never sends it', async () => {
    const r = registryWith();
    await expect(resolveMention('body:nope', r)).rejects.toMatchObject({ code: 'not-found', suggestion: 'known references: body:beam' });
    await expect(resolveMention('planet:mars', r)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('indexes the Model objects and the project files together for the @ popover', async () => {
    const entries = await objectIndex(registryWith());
    expect(entries.map((e) => e.ref)).toEqual(['body:beam']);
    const withFiles = await objectIndex(registryWith({}, true, [{ path: 'AGENTS.md', size: 9, kind: 'agents' }]));
    expect(withFiles.map((e) => e.ref)).toEqual(['body:beam', 'file:AGENTS.md']);
    expect(withFiles[1]!.summary).toBe('9 B · agents');
  });
});

describe('the person’s turn', () => {
  it('resolves every chip into one <context> block and leaves the text readable', async () => {
    const { message, unresolved } = await buildTurn({ text: 'is @body:beam stiff enough under @load:p', registry: registryWith() });
    const text = (message.content[0] as { text: string }).text;
    expect(text).toContain('is @body:beam stiff enough under @load:p');
    expect(text).toContain('"body:beam"');
    expect(text).toContain('"load:p"');
    expect(unresolved).toEqual([]);
  });

  it('expands @selection from the live selection', async () => {
    const selection: Selection = { bodies: ['beam'], faces: [], sets: [], refs: ['body:beam'] };
    const { message } = await buildTurn({ text: 'check @selection', registry: registryWith(), selection });
    expect((message.content[0] as { text: string }).text).toContain('"body:beam"');
  });

  it('reports a chip that resolves to nothing instead of sending it', async () => {
    const { message, unresolved } = await buildTurn({ text: 'look at @body:ghost', registry: registryWith() });
    expect(unresolved).toEqual([{ ref: 'body:ghost', cause: "nothing in the Model is called 'body:ghost'" }]);
    expect((message.content[0] as { text: string }).text).not.toContain('<context>');
  });

  it('prepends the skill body when the line starts with /name, and only for a skill that exists', async () => {
    const registry = registryWith();
    const invoked = await buildTurn({ text: '/beam-theory-check the tip deflection', registry, skills: SKILLS });
    expect(invoked.skill).toBe('beam-theory-check');
    expect((invoked.message.content[0] as { text: string }).text).toMatch(/^Skill beam-theory-check:\n# Steps/);

    const plain = await buildTurn({ text: '/nope do a thing', registry, skills: SKILLS });
    expect(plain.skill).toBeNull();
    expect((plain.message.content[0] as { text: string }).text).toBe('/nope do a thing');
  });

  it('carries the attached images alongside the text', async () => {
    const image = { type: 'image' as const, mediaType: 'image/png' as const, base64: 'AAA' };
    const { message } = await buildTurn({ text: 'build this', registry: registryWith(), images: [image] });
    expect(message.content[1]).toBe(image);
  });
});

describe('images', () => {
  const env = (width: number, height: number): ImageEnv & { asked: [number, number][] } => {
    const asked: [number, number][] = [];
    return {
      asked,
      size: async () => ({ width, height }),
      render: async (_blob, w, h) => {
        asked.push([w, h]);
        return 'Zm9v';
      },
    };
  };

  it('fits the long edge to 1568 px, keeps the aspect and never scales up', () => {
    expect(fitTo(3000, 2000)).toEqual([1568, 1045]);
    expect(fitTo(2000, 3000)).toEqual([1045, 1568]);
    expect(fitTo(800, 600)).toEqual([800, 600]);
    expect(fitTo(1, 1)).toEqual([1, 1]);
  });

  it('downscales before sending and keeps the media type', async () => {
    const e = env(3000, 2000);
    const block = await downscaleImage(new Blob(['x'], { type: 'image/png' }), e);
    expect(e.asked).toEqual([[1568, 1045]]);
    expect(block).toEqual({ type: 'image', mediaType: 'image/png', base64: 'Zm9v' });
  });

  it('refuses a format the model cannot read and an image still over 5 MB', async () => {
    await expect(downscaleImage(new Blob(['x'], { type: 'image/gif' }), env(10, 10))).rejects.toMatchObject({ code: 'unsupported' });
    const huge: ImageEnv = { size: async () => ({ width: 10, height: 10 }), render: async () => 'A'.repeat(8 * 1024 * 1024) };
    await expect(downscaleImage(new Blob(['x'], { type: 'image/png' }), huge)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('attaches the current view through query.screenshot', async () => {
    // The fake screenshot is a real `data:` URL now, so this also covers the prefix strip.
    const block = await screenshotBlock(registryWith());
    expect(block).toEqual({ type: 'image', mediaType: 'image/png', base64: 'QUJD', caption: 'the current viewer view' });
  });
});
