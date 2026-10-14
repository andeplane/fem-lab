// The text-import boundary is shared by browser and Node hosts. Device access and SHA-256
// are injected; the converter and checked project replacement remain separate operations.
import { FemError } from './error';
import { assertInside } from './project-paths';
import { z } from 'zod';

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
  sha256(bytes: Uint8Array): Promise<string>;
}

export type AbaqusInput = { text: string } | { picker: true } | { path: string };
export interface AbaqusText { text: string; sha256: string }

const quantity = z.union([z.string().min(1), z.object({ value: z.number(), unit: z.string().min(1) })]);
const options = {
  name: z.string().min(1), body: z.string().min(1),
  unitLength: quantity.meta({ description: 'Explicit positive length per source coordinate; for example 1 mm. Independent of display units.', 'x-dimension': 'length' }),
};
const force = quantity.meta({ description: 'Explicit positive force per source force; for example 1 N. Required in static mode and absent in mesh mode.', 'x-dimension': 'force' });
const mode = z.discriminatedUnion('mode', [
  z.object({ ...options, mode: z.literal('mesh'), unitForce: force.optional() }),
  z.object({ ...options, mode: z.literal('static'), unitForce: force }),
]);
const sourceOptions = { ...options, mode: z.enum(['mesh', 'static']), unitForce: force.optional() };
/** Mode-specific requirements retain precise field errors; source choice is exclusive. */
export const AbaqusImport = z.intersection(mode, z.union([
  z.strictObject({ ...sourceOptions, text: z.string() }),
  z.strictObject({ ...sourceOptions, picker: z.literal(true) }),
  z.strictObject({ ...sourceOptions, path: z.string() }),
]));

function bound(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ABAQUS_BYTES) {
    throw new FemError('schema', 'Abaqus input exceeds the 16 MiB limit or has invalid byte metadata', 'text', 'import a smaller flat C3D4/C3D8 .inp deck');
  }
}

function supportedName(name: string): void {
  const lower = name.toLowerCase();
  if (lower.endsWith('.odb')) {
    throw new FemError('unsupported', '.odb is a binary Abaqus results database; only text .inp model decks can be imported', 'path', 'export a supported flat C3D4/C3D8 .inp deck from Abaqus');
  }
  if (lower.endsWith('.cae')) {
    throw new FemError('unsupported', '.cae is an Abaqus model database; only text .inp model decks can be imported', 'path', 'export a supported flat C3D4/C3D8 .inp deck from Abaqus');
  }
}

/** Preserve original UTF-8 bytes, including line endings and BOM, for converter provenance. */
export async function readAbaqus(input: AbaqusInput, io: AbaqusIo): Promise<AbaqusText | null> {
  let bytes: Uint8Array;
  if ('text' in input) {
    // UTF-16 length is a cheap lower bound before the UTF-8 allocation.
    bound(input.text.length);
    bytes = new TextEncoder().encode(input.text);
    bound(bytes.byteLength);
  } else {
    const file = 'path' in input ? await io.read(assertInside(input.path).join('/')) : await io.pick();
    if (file === null) return null;
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
  return { text, sha256: await io.sha256(bytes) };
}
