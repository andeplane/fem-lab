// The text-import boundary is shared by browser and Node hosts. Device access and SHA-256
// are injected; the converter and checked project replacement remain separate operations.
import { FemError } from './error';
import { assertInside } from './project-paths';
import { z } from 'zod';
import type { Query, AbaqusDependencies } from './generated/engine';

export const MAX_ABAQUS_BYTES = 16 * 1024 * 1024;
export const ABAQUS_ACCEPT = '.inp,text/plain';

/** Metadata is available before reading, so an oversized picked file is never allocated. */
export interface AbaqusFile {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}

/** Captured at Command admission; none of these operations acquires a different project. */
export interface AbaqusIo {
  pick(): Promise<AbaqusFile | null>;
  read(path: string): Promise<AbaqusFile>;
  /** Resolve exact include paths from a user-selected submission folder. No file is read here. */
  pickIncludes?(paths: readonly string[]): Promise<readonly AbaqusFile[] | null>;
  sha256(bytes: Uint8Array): Promise<string>;
}

export type AbaqusInput = ({ text: string } | { picker: true } | { path: string }) & {
  sourceName?: string;
  sourceFiles?: Record<string, string>;
};
export interface AbaqusText { text: string; sha256: string; sourceName?: string }
export interface AbaqusBundle extends AbaqusText { sourceFiles?: Record<string, string> }
export type AbaqusDependencyQuery = (source: Pick<Extract<Query, { query: 'query.abaqusDependencies' }>, 'text' | 'sourceName' | 'sourceFiles'>) => Promise<AbaqusDependencies>;

const quantity = z.union([z.string().min(1), z.object({ value: z.number(), unit: z.string().min(1) })]);
const options = {
  name: z.string().min(1), body: z.string().min(1),
  unitLength: quantity.meta({ description: 'Explicit positive length per source coordinate; for example 1 mm. Independent of display units.', 'x-dimension': 'length' }),
};
const force = quantity.meta({ description: 'Explicit positive force per source force; for example 1 N. Required in static mode and absent in mesh mode.', 'x-dimension': 'force' });
const time = quantity.meta({ description: 'Explicit positive time per source time unit, for example 1 s. Required to preserve density; source mass follows force × time² / length.', 'x-dimension': 'time' });
const bundle = {
  sourceName: z.string().min(1).optional().meta({ description: 'Submission-relative root filename for source diagnostics and provenance.' }),
  sourceFiles: z.record(z.string(), z.string()).optional().meta({ description: 'Provided submission-relative include filenames and exact UTF-8 contents. Includes never fetch network or outside paths.' }),
  unitTime: time.optional(),
};
const mode = z.discriminatedUnion('mode', [
  z.object({ ...options, ...bundle, mode: z.literal('mesh'), unitForce: force.optional() }),
  z.object({ ...options, ...bundle, mode: z.literal('static'), unitForce: force }),
]);
const sourceOptions = { ...options, ...bundle, mode: z.enum(['mesh', 'static']), unitForce: force.optional() };
/** Mode-specific requirements retain precise field errors; source choice is exclusive. */
export const AbaqusImport = z.intersection(mode, z.union([
  z.strictObject({ ...sourceOptions, text: z.string() }),
  z.strictObject({ ...sourceOptions, picker: z.literal(true) }),
  z.strictObject({ ...sourceOptions, path: z.string() }),
]));

function bound(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ABAQUS_BYTES) {
    throw new FemError('schema', 'Abaqus input exceeds the 16 MiB limit or has invalid byte metadata', 'text', 'reduce the submitted deck and include bundle to 16 MiB');
  }
}

function supportedName(name: string): void {
  const lower = name.toLowerCase();
  if (lower.endsWith('.odb')) {
    throw new FemError('unsupported', '.odb is a binary Abaqus results database; only text .inp model decks can be imported', 'path', 'export a text .inp model deck from Abaqus');
  }
  if (lower.endsWith('.cae')) {
    throw new FemError('unsupported', '.cae is an Abaqus model database; only text .inp model decks can be imported', 'path', 'export a text .inp model deck from Abaqus');
  }
}

/** Preserve original UTF-8 bytes, including line endings and BOM, for converter provenance. */
export async function readAbaqus(input: AbaqusInput, io: AbaqusIo): Promise<AbaqusText | null> {
  let bytes: Uint8Array;
  let sourceName = input.sourceName;
  if ('text' in input) {
    // UTF-16 length is a cheap lower bound before the UTF-8 allocation.
    bound(input.text.length);
    bytes = new TextEncoder().encode(input.text);
    bound(bytes.byteLength);
  } else {
    const file = 'path' in input ? await io.read(assertInside(input.path).join('/')) : await io.pick();
    if (file === null) return null;
    sourceName ??= file.name;
    supportedName(file.name);
    bound(file.size);
    // A fake or a changed file may disagree with metadata. Bound the actual snapshot too.
    bytes = (await file.read()).slice();
    bound(bytes.byteLength);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FemError('schema', 'Abaqus input is not valid UTF-8 text', 'text', 'export a UTF-8 text .inp deck');
  }
  if ('text' in input && text !== input.text) {
    throw new FemError('schema', 'Abaqus inline text contains an invalid Unicode surrogate', 'text', 'supply UTF-8 text from a .inp deck');
  }
  return { text, sha256: await io.sha256(bytes), ...(sourceName === undefined ? {} : { sourceName }) };
}

/** Acquire the closure requested by the engine's lexer, without duplicating Abaqus syntax here.
 * Every byte belongs to the admitted host capability; publication happens only after conversion.
 */
export async function readAbaqusBundle(input: AbaqusInput, io: AbaqusIo, dependencies: AbaqusDependencyQuery): Promise<AbaqusBundle | null> {
  const root = await readAbaqus(input, io);
  if (root === null) return null;
  const sourceFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  let total = new TextEncoder().encode(root.text).byteLength;
  const add = (path: string, text: string): void => {
    const normalized = assertInside(path).join('/');
    if (normalized !== path) throw new FemError('file.scope', 'include filenames must use canonical submission-relative paths', path, 'use slash-separated filenames without empty or dot segments');
    if (Object.keys(sourceFiles).length >= 128) throw new FemError('schema', 'Abaqus bundle exceeds 128 include files', 'sourceFiles', 'submit a smaller include graph');
    const bytes = new TextEncoder().encode(text);
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text) throw new FemError('schema', 'include text contains an invalid Unicode surrogate', path, 'supply the original UTF-8 include file');
    total += bytes.byteLength;
    bound(total);
    sourceFiles[path] = text;
  };
  for (const [path, text] of Object.entries(input.sourceFiles ?? {})) add(path, text);
  const submission = 'path' in input ? assertInside(input.path).slice(0, -1) : null;
  for (;;) {
    const source = { ...root, ...(Object.keys(sourceFiles).length ? { sourceFiles } : {}) };
    const { sha256: _digest, ...inspection } = source;
    const { missingFiles } = await dependencies(inspection);
    if (!missingFiles.length) return source;
    const missing = [...new Set(missingFiles.map(path => assertInside(path).join('/')))];
    if (missing.some(path => Object.hasOwn(sourceFiles, path))) throw new FemError('internal', 'include discovery requested a file already provided', 'sourceFiles', 'retry the import with a complete source bundle');
    if (missing.length + Object.keys(sourceFiles).length > 128) throw new FemError('schema', 'Abaqus bundle exceeds 128 include files', 'sourceFiles', 'submit a smaller include graph');
    let files: readonly AbaqusFile[];
    if (submission !== null) {
      files = await Promise.all(missing.map(async path => {
        const file = await io.read([...submission, path].join('/'));
        return { name: path, size: file.size, read: () => file.read() };
      }));
    } else {
      if (!io.pickIncludes) throw new FemError('file.not-found', `Included files are missing: ${missing.join(', ')}`, 'sourceFiles', 'provide sourceFiles or import a path inside the open project folder');
      const picked = await io.pickIncludes(missing);
      if (picked === null) return null;
      files = picked;
    }
    const byName = new Map<string, AbaqusFile>();
    for (const file of files) {
      if (byName.has(file.name)) throw new FemError('schema', 'selected include files have duplicate names', file.name, 'choose the submission folder so relative paths are preserved');
      byName.set(file.name, file);
    }
    // Validate all metadata before reading any of the new bodies.
    let declared = total;
    for (const path of missing) {
      const file = byName.get(path);
      if (!file) throw new FemError('file.not-found', `Included file is missing: ${path}`, path, 'select the submission folder containing this exact relative filename');
      bound(file.size); declared += file.size; bound(declared);
    }
    for (const path of missing) {
      const file = byName.get(path)!;
      const bytes = (await file.read()).slice();
      bound(bytes.byteLength);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new FemError('schema', 'included file is not valid UTF-8 text', path, 'export the include as UTF-8 text'); }
      add(path, text);
    }
  }
}
