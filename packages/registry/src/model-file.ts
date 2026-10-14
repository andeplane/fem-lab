import type { ModelFile } from './generated/engine';
import { FemError } from './error';

/** Host publication/save budget, measured on the complete persisted UTF-8 ModelFile text. */
export const MAX_MODEL_FILE_BYTES = 16 * 1024 * 1024;

/** Trusted host encoder: faithfully encode the complete supplied ModelFile, including Journal.
 * Its returned text is the actual save format, not a compact-size estimate or another replay. */
export type ModelFileEncoder = (compactModelFileJson: string) => string;
/** Captured trusted host policy, injected into private preparation; never supplied by a Model. */
export interface ModelFilePublicationPolicy {
  readonly encode: ModelFileEncoder;
  readonly maxBytes: number;
}

/** The existing browser format; MCP appends one LF. Number formatting is ECMAScript's. */
export function modelFileText(file: ModelFile, trailingNewline = false): string {
  return JSON.stringify(file, null, 2) + (trailingNewline ? '\n' : '');
}

/** Use the same encoder at private candidate finish and the corresponding host's writer. */
export function modelFileEncoder(trailingNewline = false): ModelFileEncoder {
  return json => modelFileText(JSON.parse(json) as ModelFile, trailingNewline);
}

/** Refuse before host I/O; equality is allowed and UTF-16 string length is not a byte count. */
export function boundedModelFileText(file: ModelFile, trailingNewline = false, maxBytes = MAX_MODEL_FILE_BYTES): string {
  const text = modelFileText(file, trailingNewline);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) throw new FemError('schema', `Model file is ${bytes} UTF-8 bytes, exceeding the ${maxBytes}-byte host limit`, 'file', 'reduce the Model or Journal before calling file.save');
  return text;
}
