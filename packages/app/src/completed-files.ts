import { FemError, MAX_RETAINED_FILE_BYTES, fileByteLength, type CompletedFilesHost, type FileArtifactMetadata, type FileDelivery, type FileDeliveryInput } from '@femlab/registry';

export interface CompletedFilesIo {
  download(name: string, mime: string, data: string | Uint8Array): void;
  nextId(): string;
  changed?(): void;
}
export interface CompletedFilesPolicy { maxEntries?: number; maxBytes?: number; maxFileBytes?: number }

/** A bounded document-local cache, including pending owned snapshots. It does not bound the
 * caller's original export allocation or the browser download implementation's allocations. */
export function createCompletedFiles(io: CompletedFilesIo, policy: CompletedFilesPolicy = {}): CompletedFilesHost {
  const maxEntries = policy.maxEntries ?? 16;
  const maxBytes = policy.maxBytes ?? 32 * 1024 * 1024;
  const maxFileBytes = Math.min(policy.maxFileBytes ?? MAX_RETAINED_FILE_BYTES, MAX_RETAINED_FILE_BYTES);
  if (![maxEntries, maxBytes, maxFileBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid completed-file cache limits');
  const entries = new Map<string, { metadata: FileArtifactMetadata; data: string | Uint8Array }>();
  let bytesHeld = 0;
  let countHeld = 0;
  let generation = 0;
  let alive = true;
  let sequence = 0;
  const changed = (): void => { try { io.changed?.(); } catch { /* Availability notifications cannot fail completed I/O. */ } };
  const remove = (id: string): void => {
    const entry = entries.get(id);
    if (!entry) return;
    bytesHeld -= entry.metadata.bytes;
    countHeld--;
    entries.delete(id);
    changed();
  };
  const clear = (): void => {
    generation++;
    for (const id of entries.keys()) remove(id);
    changed();
    // In-flight deliveries still own their snapshots until complete/discard releases them.
  };
  return {
    capture: () => {
      const captured = generation;
      return (input: FileDeliveryInput) => {
        const bytes = fileByteLength(input.data);
        const base: FileDelivery = { name: input.name, to: input.to, mime: input.mime, bytes };
        let data = input.data;
        let unavailable: FileDelivery['unavailable'];
        let reserved = false;
        let receipt: FileDelivery | undefined;
        const release = (): void => {
          if (!reserved) return;
          reserved = false;
          bytesHeld -= bytes;
          countHeld--;
        };
        if (!alive || captured !== generation) unavailable = 'expired';
        else if (bytes > maxFileBytes) unavailable = 'oversize';
        else if (maxEntries === 0 || bytes > maxBytes) unavailable = 'capacity';
        else {
          for (const id of entries.keys()) {
            if (countHeld < maxEntries && bytesHeld + bytes <= maxBytes) break;
            remove(id);
          }
          if (countHeld >= maxEntries || bytesHeld + bytes > maxBytes) unavailable = 'capacity';
          else {
            bytesHeld += bytes;
            countHeld++;
            reserved = true;
            try { if (typeof data !== 'string') data = data.slice(); }
            catch { release(); unavailable = 'unavailable'; }
          }
        }
        return {
          data, bytes,
          complete: () => {
            if (receipt) return { ...receipt };
            if (!alive || captured !== generation) { release(); unavailable = 'expired'; }
            if (reserved) {
              try {
                const prefix = io.nextId();
                if (typeof prefix !== 'string' || prefix.length === 0 || !Number.isSafeInteger(sequence + 1)) throw new Error('Invalid completed-file id');
                const id = `${prefix}:${++sequence}`;
                entries.set(id, { metadata: { id, name: base.name, mime: base.mime!, bytes }, data });
                reserved = false; // The completed entry now owns the same reservation and snapshot.
                receipt = { ...base, id };
                changed();
              } catch { release(); unavailable = 'unavailable'; }
            }
            receipt ??= { ...base, unavailable: unavailable ?? 'expired' };
            return { ...receipt };
          },
          discard: () => { release(); receipt ??= { ...base, unavailable: 'expired' }; },
        };
      };
    },
    info: id => {
      const entry = entries.get(id);
      return entry ? { ...entry.metadata } : null;
    },
    download: id => {
      const entry = entries.get(id);
      if (!entry) throw new FemError('file.not-found', 'The completed file is unknown or expired', id, 'export or write the file again');
      const { name, mime, bytes } = entry.metadata;
      const basename = name.split('/').at(-1)!;
      io.download(basename, mime, typeof entry.data === 'string' ? entry.data : entry.data.slice());
      return { name: basename, mime, bytes, id, to: 'download' };
    },
    clear,
    dispose: () => { alive = false; clear(); },
  };
}
