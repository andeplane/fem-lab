// What the model is told before it is asked anything (PLAN 4.5, 4.11, 4.13, 4.15): the generated
// API reference, the units rule, the verification habit, the skills index and the project's
// AGENTS.md; then the person's turn with its `@` chips resolved and its images attached.
//
// The blocks are emitted in a fixed order, most stable first, so the one cache breakpoint the
// Anthropic adapter puts on the system prompt actually hits: blocks 1–2 change only on deploy,
// 3–4 on `project.refresh`.
import { FemError, parseMentions, stripDiscriminator, type MentionKind, type Registry, type Selection, type Skill } from '@femlab/registry';
import type { ImageBlock, Message } from './provider';

export interface ProjectContext {
  name: string;
  files: { path: string; size: number; kind: string }[];
  agentsMd: { file: string; text: string } | null;
}
export interface SystemContext {
  registry: Registry;
  /** The skills the chips leave switched on; the model may `skill.invoke` any of them. */
  skills: Skill[];
  project: ProjectContext | null;
}

const RULES = `You are the assistant inside FEM Lab, a browser finite-element editor. You and the person
share one Model: every Command you call lands in the same Journal as their clicks, and they see each
call as it happens.

- Units: write every physical quantity as a unit string ("210 GPa", "2.4 MPa", "0.5 m"); read them
  back as { value, unit }. Never send a bare number for a dimensional quantity.
- Targets are names, never node or element ids: bodies, named face Sets and Sets. Use query.objects
  to see what exists.
- Prefer run_script over more than three separate Commands: one script is one Journal entry the
  person can read, and it is faster.
- Verify before you report. After a solve, check the reaction sum against the applied load and
  compare a peak value with a hand estimate (beam theory, an equilibrium check, a known closed form).
  Say what you compared and by how much it differed. An unverified result is not an answer.
- Put those checks in a <verification> block, one per line as \`ok | what you compared | the number\`,
  with \`warn\` or \`fail\` in place of \`ok\` when the check does not hold. The block is rendered as the
  verification card; the prose around it is yours to write.
- When a Command fails you get a structured error with a code, a cause and a suggestion. Fix the
  call and retry; do not repeat the same call.`;

/** One line per parameter list, so the model can see a Command's shape without a schema dump. */
function params(schema: Record<string, unknown>): string {
  const { properties = {}, required = [] } = stripDiscriminator(schema) as { properties?: Record<string, unknown>; required?: string[] };
  const names = Object.keys(properties);
  if (names.length === 0) return '()';
  return `(${names.map((n) => (required.includes(n) ? n : `${n}?`)).join(', ')})`;
}

/** The AI's tool description is the schema's doc string; the reference is its first sentence. */
const firstLine = (description: string) => description.split('\n')[0]!.split(/(?<=\.)\s/)[0]!.trim();

/** PLAN 4.5: generated from `registry.list()`, never hand-edited. */
export function apiReference(registry: Registry): string {
  const { commands, queries } = registry.list();
  const rows = [...commands, ...queries].filter((d) => d.tool).map((d) => `  ${d.name}${params(d.schema)} — ${firstLine(d.description)}`);
  return `# The API\n\nEvery capability is a Command or a Query with the same name as its tool (dots become underscores,\nso geometry.addBox is geometry_addBox). run_script runs TypeScript against the same names as \`fem.*\`.\n\n${rows.join('\n')}`;
}

export function skillsIndex(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const rows = skills.map((s) => `  /${s.name} — ${s.description}${s.when ? ` — use when ${s.when}` : ''}`);
  return `# Skills\n\nInstructions you can load with skill.invoke { name } when its "use when" applies. The person can\ninvoke one with /name; you may invoke one yourself without being asked.\n\n${rows.join('\n')}`;
}

export function projectBlock(project: ProjectContext | null): string {
  if (!project) return '';
  const files = project.files.map((f) => `  ${f.path} (${f.size} B, ${f.kind})`).join('\n');
  const rules = project.agentsMd
    ? `\nThese are standing instructions for this project, from ${project.agentsMd.file}. Follow them without\nbeing reminded:\n\n${project.agentsMd.text.trim()}\n`
    : '';
  return `<project name="${project.name}">\nFiles you can read with file_read and write with file_write:\n${files}\n${rules}</project>`;
}

export function buildSystem(ctx: SystemContext): string {
  return [RULES, apiReference(ctx.registry), skillsIndex(ctx.skills), projectBlock(ctx.project)].filter((b) => b !== '').join('\n\n');
}

export type VerifyStatus = 'ok' | 'warn' | 'fail';
export interface VerifyRow {
  status: VerifyStatus;
  what: string;
  value: string;
}

const BLOCK = /<verification>\s*([\s\S]*?)\s*<\/verification>/g;
const ROW = /^(ok|warn|fail)\s*\|\s*(.+?)\s*\|\s*(.*)$/i;

/**
 * The verification card comes out of the assistant's own text, in the shape the system prompt asks
 * for. Nothing is injected behind the model's back: the block is part of what it wrote, and the
 * prose it sat in is what the transcript shows.
 */
export function parseVerification(text: string): { rows: VerifyRow[]; prose: string } {
  const rows: VerifyRow[] = [];
  for (const [, body] of text.matchAll(BLOCK)) {
    for (const line of body!.split('\n')) {
      const m = ROW.exec(line.trim());
      if (m) rows.push({ status: m[1]!.toLowerCase() as VerifyStatus, what: m[2]!, value: m[3]! });
    }
  }
  return { rows, prose: text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim() };
}

// --- mentions (plan B §7.7) -------------------------------------------------------------------

const MODEL_LISTS: Partial<Record<MentionKind, string>> = { body: 'bodies', material: 'materials', constraint: 'constraints', load: 'loads', step: 'steps' };

/** `@face:beam.top` → the `query.*` summary that rides along with the turn as context. */
export async function resolveMention(ref: string, registry: Registry): Promise<unknown> {
  const [kind, ...rest] = ref.split(':');
  const name = rest.join(':');
  const list = MODEL_LISTS[kind as MentionKind];
  if (list) {
    const model = (await registry.query({ query: 'query.model' })) as Record<string, { name: string }[]>;
    const row = (model[list] ?? []).find((r) => r.name === name);
    if (!row) throw await unknownRef(ref, registry);
    return row;
  }
  if (kind === 'face' || kind === 'set') return registry.query({ query: 'query.set', name });
  if (kind === 'result') return registry.query({ query: 'query.result', step: name });
  if (kind === 'journal') return registry.query({ query: 'query.journal', fromSeq: Number(name) });
  if (kind === 'file') {
    const { text } = (await registry.dispatch({ cmd: 'file.read', path: name })) as { text: string };
    return { path: name, text: text.slice(0, 4096) };
  }
  throw await unknownRef(ref, registry);
}

async function unknownRef(ref: string, registry: Registry): Promise<FemError> {
  const known = await objectIndex(registry).catch(() => []);
  return new FemError('not-found', `nothing in the Model is called '${ref}'`, ref, `known references: ${known.map((o) => o.ref).join(', ') || 'none yet'}`);
}

export interface IndexEntry {
  ref: string;
  kind: string;
  name: string;
  summary: string;
}

/** What the `@` popover lists: the engine's object index plus the open project's files. */
export async function objectIndex(registry: Registry): Promise<IndexEntry[]> {
  const { objects } = (await registry.query({ query: 'query.objects' })) as { objects: IndexEntry[] };
  const project = (await registry.query({ query: 'query.project' }).catch(() => null)) as ProjectContext | null;
  const files = (project?.files ?? []).map((f) => ({ ref: `file:${f.path}`, kind: 'file', name: f.path, summary: `${f.size} B · ${f.kind}` }));
  return [...objects, ...files];
}

// --- images (PLAN 4.15) -----------------------------------------------------------------------

export const MAX_EDGE = 1568;
export const MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Long edge to `max`, aspect kept, never scaled up. Pure, so the sizes are tested without a canvas. */
export function fitTo(width: number, height: number, max = MAX_EDGE): [number, number] {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** The two canvas facts this module needs; the browser implements them, a test fakes them. */
export interface ImageEnv {
  size(blob: Blob): Promise<{ width: number; height: number }>;
  render(blob: Blob, width: number, height: number, type: ImageType): Promise<string>;
}

export const browserImages: ImageEnv = {
  size: async (blob) => {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    bitmap.close();
    return { width, height };
  },
  render: async (blob, width, height, type) => {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await canvas.convertToBlob({ type, quality: 0.85 });
    const buffer = new Uint8Array(await out.arrayBuffer());
    let binary = '';
    for (const byte of buffer) binary += String.fromCharCode(byte);
    return btoa(binary);
  },
};

export async function downscaleImage(blob: Blob, env: ImageEnv = browserImages): Promise<ImageBlock> {
  const type = blob.type as ImageType;
  if (!IMAGE_TYPES.includes(type)) {
    throw new FemError('unsupported', `'${blob.type || 'unknown'}' is not an image the model can read`, 'image', `attach a ${IMAGE_TYPES.join(', ')} image`);
  }
  const { width, height } = await env.size(blob);
  const [w, h] = fitTo(width, height);
  const base64 = await env.render(blob, w, h, type);
  if (base64.length * 0.75 > MAX_BYTES) {
    throw new FemError('unsupported', 'the image is larger than 5 MB even after downscaling', 'image', 'save it as JPEG or crop it to the part that matters');
  }
  return { type: 'image', mediaType: type, base64 };
}

/** "Attach current view": the same PNG `query.screenshot` gives a report. */
export async function screenshotBlock(registry: Registry, width = 1200): Promise<ImageBlock> {
  const { png } = (await registry.query({ query: 'query.screenshot', width })) as { png: string };
  return { type: 'image', mediaType: 'image/png', base64: png.replace(/^data:image\/png;base64,/, ''), caption: 'the current viewer view' };
}

// --- the person's turn ------------------------------------------------------------------------

export interface TurnInput {
  text: string;
  registry: Registry;
  images?: ImageBlock[];
  /** The live selection, for `@selection`; the store has it without a round trip. */
  selection?: Selection;
  skills?: Skill[];
}
export interface BuiltTurn {
  message: Message;
  /** The `/name` the line started with, for the skill card in the transcript. */
  skill: string | null;
  unresolved: { ref: string; cause: string }[];
}

const SLASH = /^\/([a-z0-9-]+)(?=\s|$)/i;

/**
 * `parseMentions` gives the chips; each is resolved through `query.*` and the summaries ride along
 * as one `<context>` JSON block after the text, so the model sees what the person pointed at
 * without the chat having to spell it out. A ref that resolves to nothing is reported inline and
 * never sent. A leading `/name` is replaced by the skill body as a preceding block.
 */
export async function buildTurn({ text, registry, images = [], selection, skills = [] }: TurnInput): Promise<BuiltTurn> {
  const slash = SLASH.exec(text.trim());
  const skill = slash && skills.some((s) => s.name === slash[1]) ? slash[1]! : null;
  const body = skill ? text.trim().slice(1 + skill.length).trim() : text;

  const { chips, selection: wantsSelection } = parseMentions(body);
  const refs = [...chips.map((c) => c.ref), ...(wantsSelection ? (selection?.refs ?? []) : [])];
  const context: Record<string, unknown> = {};
  const unresolved: { ref: string; cause: string }[] = [];
  for (const ref of [...new Set(refs)]) {
    try {
      context[ref] = await resolveMention(ref, registry);
    } catch (e) {
      unresolved.push({ ref, cause: e instanceof FemError ? e.cause : String(e) });
    }
  }

  const parts: string[] = [];
  if (skill) {
    const invoked = (await registry.dispatch({ cmd: 'skill.invoke', name: skill, args: body })) as { body: string };
    parts.push(`Skill ${skill}:\n${invoked.body}`);
  }
  parts.push(body);
  if (Object.keys(context).length > 0) parts.push(`<context>\n${JSON.stringify(context, null, 2)}\n</context>`);

  return { message: { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }, ...images] }, skill, unresolved };
}
