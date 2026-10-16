import { z } from 'zod';

export const MAX_RETAINED_FILE_BYTES = 16 * 1024 * 1024;
export const FileDelivery = z.object({
  name: z.string(), to: z.enum(['download', 'folder']),
  // Optional only for receipts produced before completed-file metadata was supported.
  bytes: z.number().int().nonnegative().optional(), mime: z.string().optional(),
  id: z.string().optional(),
  unavailable: z.enum(['oversize', 'capacity', 'unavailable', 'expired', 'unsupported']).optional(),
});
export type FileDelivery = z.output<typeof FileDelivery>;
export const FileArtifactMetadata = z.object({ id: z.string(), name: z.string(), mime: z.string(), bytes: z.number().int().nonnegative() });
export type FileArtifactMetadata = z.output<typeof FileArtifactMetadata>;
export interface FileDeliveryInput { name: string; mime: string; to: 'download' | 'folder'; data: string | Uint8Array }
export interface PreparedFileDelivery {
  /** An owned snapshot for eligible binary payloads, or the original immutable text. */
  readonly data: string | Uint8Array;
  readonly bytes: number;
  /** Called only after the actual awaited write or browser download handoff succeeds. */
  complete(): FileDelivery;
  /** Release any pending reservation after failed/cancelled I/O. */
  discard(): void;
}
export type FileDeliveryAdmission = (input: FileDeliveryInput) => PreparedFileDelivery;
export interface CompletedFilesHost {
  /** Capture document/folder/chat authority before any export/read/write await. */
  capture(): FileDeliveryAdmission;
  info(id: string): FileArtifactMetadata | null;
  /** Repeat the owned bytes through download I/O only; never creates another cache entry. */
  download(id: string): FileDelivery;
  clear(): void;
  dispose(): void;
}

/** UTF-8 byte count, including replacement of unpaired surrogates, without a large allocation. */
export function fileByteLength(data: string | Uint8Array): number {
  if (typeof data !== 'string') return data.byteLength;
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const unit = data.charCodeAt(i);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < data.length && data.charCodeAt(i + 1) >= 0xdc00 && data.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** Accurate completed metadata for hosts without the optional in-memory repeat-download service. */
export function unretainedFile(input: FileDeliveryInput, unavailable: FileDelivery['unavailable'] = 'unsupported'): PreparedFileDelivery {
  const { name, to, mime } = input;
  const bytes = fileByteLength(input.data);
  let data = input.data;
  try { if (typeof data !== 'string' && bytes <= MAX_RETAINED_FILE_BYTES) data = data.slice(); }
  catch { unavailable = 'unavailable'; }
  return {
    data, bytes,
    complete: () => ({ name, to, bytes, mime, unavailable }),
    discard: () => undefined,
  };
}
