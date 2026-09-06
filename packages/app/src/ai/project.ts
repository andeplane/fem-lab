// The project folder over Chromium's File System Access API (plan B §7.9, ADR 0014). Scoping is
// structural — every read and write walks from the folder's own handle segment by segment, so
// nothing outside it is reachable — and `assertInside` runs first only to give a clean `file.scope`
// error instead of a browser exception.
//
// The handles are described here rather than taken from lib.dom, because lib.dom types neither the
// async iteration nor the permission methods, and because a structural type is what lets the tests
// hand in a 40-line in-memory fake.
import { assertInside, mergeSkills, parseSkill, type ProjectInfo, type Skill } from '@femlab/registry';

export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<{ size: number; lastModified: number; text(): Promise<string> }>;
  createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>;
}
export interface DirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FileHandle | DirHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

export type FileKind = ProjectInfo['files'][number]['kind'];
export interface ProjectFile {
  path: string;
  size: number;
  kind: FileKind;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'target', '.venv']);
const MAX_DEPTH = 4;
export const AGENTS_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

export function kindOf(path: string): FileKind {
  if (AGENTS_FILES.some((f) => path === f || path.endsWith(`/${f}`))) return 'agents';
  if (/(^|\/)skills\/[^/]+\/SKILL\.md$/.test(path)) return 'skill';
  if (path.endsWith('.femlab.json')) return 'journal';
  if (/\.(ts|js)$/.test(path)) return 'script';
  if (/\.(md|pdf|vtu|csv|xlsx|inp|msh|stl|step|png)$/.test(path)) return 'export';
  return 'other';
}

async function walk(dir: DirHandle, prefix: string, depth: number, out: ProjectFile[]): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.') || SKIP.has(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (depth < MAX_DEPTH) await walk(handle, path, depth + 1, out);
    } else {
      out.push({ path, size: (await handle.getFile()).size, kind: kindOf(path) });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A folder the person opened, listed and read. `AGENTS.md` (or `CLAUDE.md`) becomes standing
 * instructions in the system prompt and the badge in the context strip; `skills/<name>/SKILL.md` become
 * project skills that override a built-in of the same name.
 */
export class ProjectFolder {
  files: ProjectFile[] = [];
  agentsMd: { file: string; text: string; at: number } | null = null;
  skills: Skill[] = [];
  private refreshing: Promise<void> = Promise.resolve();

  handle: DirHandle;

  private constructor(handle: DirHandle) {
    this.handle = handle;
  }

  static async fromHandle(handle: DirHandle): Promise<ProjectFolder> {
    const folder = new ProjectFolder(handle);
    await folder.refresh();
    return folder;
  }

  get name(): string {
    return this.handle.name;
  }

  /** Re-list and re-read after files changed outside the app; `project.refresh` calls this. */
  refresh(): Promise<void> {
    // Polling and explicit refresh share a queue, so an older read cannot overwrite a newer one.
    const next = this.refreshing.then(() => this.readFolder());
    this.refreshing = next.catch(() => undefined);
    return next;
  }

  private async readFolder(): Promise<void> {
    const files: ProjectFile[] = [];
    await walk(this.handle, '', 1, files);
    const agentsMd = await this.readAgents(files);
    const skills: Skill[] = [];
    for (const file of files.filter((f) => f.kind === 'skill')) {
      const text = await this.readText(file.path);
      try {
        skills.push(parseSkill(text, 'project'));
      } catch {
        // A malformed SKILL.md is skipped rather than making the whole folder unopenable.
      }
    }
    // Publish together only after all reads succeeded; a failed refresh keeps the old catalog.
    this.files = files;
    this.agentsMd = agentsMd;
    this.skills = skills;
  }

  private async readAgents(files: ProjectFile[]): Promise<{ file: string; text: string; at: number } | null> {
    for (const file of AGENTS_FILES) {
      if (!files.some((f) => f.path === file)) continue;
      const handle = await this.fileHandle([file]);
      const blob = await handle.getFile();
      return { file, text: await blob.text(), at: blob.lastModified };
    }
    return null;
  }

  info(): ProjectInfo {
    return {
      name: this.name,
      files: this.files,
      agentsMd: (this.agentsMd?.file ?? null) as ProjectInfo['agentsMd'],
      skills: this.skills.map((s) => s.name),
    };
  }

  private async fileHandle(segments: string[], create = false): Promise<FileHandle> {
    let dir = this.handle;
    for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create });
    return dir.getFileHandle(segments.at(-1)!, { create });
  }

  async readText(path: string): Promise<string> {
    return (await (await this.fileHandle(assertInside(path))).getFile()).text();
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.write(path, text);
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.write(path, bytes);
  }

  private async write(path: string, data: string | Uint8Array): Promise<void> {
    const writable = await (await this.fileHandle(assertInside(path), true)).createWritable();
    await writable.write(data);
    await writable.close();
    await this.refresh();
  }
}

/** The merged skills the chat offers: the app's built-ins with the project's overriding by name. */
export function projectSkills(builtin: Skill[], folder: ProjectFolder | null): Skill[] {
  return mergeSkills(builtin, folder?.skills ?? []);
}

/**
 * AGENTS.md changes under the app all the time (the person edits it in their editor). Poll it, and
 * call back when the rules or skill content changed — cheaper and far less code than a FileSystemObserver
 * that Chromium only recently grew.
 */
export function watchAgents(folder: ProjectFolder, onChange: () => void, everyMs = 4000, timer = setInterval, onError?: (error: unknown) => void): () => void {
  const snapshot = () => JSON.stringify([folder.agentsMd, folder.skills]);
  let last = snapshot();
  let active = true;
  let reading = false;
  let failed = false;
  const id = timer(() => {
    if (!active || reading) return;
    reading = true;
    void folder.refresh().then(() => {
      if (!active) return;
      failed = false;
      const now = snapshot();
      if (now !== last) {
        last = now;
        onChange();
      }
    }).catch((error: unknown) => {
      // Keep the last successful catalog and retry next tick; report an outage only once.
      if (active && !failed) onError?.(error);
      failed = true;
    }).finally(() => { reading = false; });
  }, everyMs);
  return () => {
    active = false;
    clearInterval(id as ReturnType<typeof setInterval>);
  };
}

// --- remembering the folder across reloads ------------------------------------------------------

const DB = 'femlab';
const STORE = 'handles';
const KEY = 'project';

function open(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** `FileSystemDirectoryHandle` is structured-cloneable, so a reload can offer "reopen <name>". */
export async function rememberHandle(handle: DirHandle, factory: IDBFactory = indexedDB): Promise<void> {
  await transact(await open(factory), 'readwrite', (s) => s.put(handle, KEY));
}

export async function recallHandle(factory: IDBFactory = indexedDB): Promise<DirHandle | null> {
  return (await transact<DirHandle | undefined>(await open(factory), 'readonly', (s) => s.get(KEY))) ?? null;
}

export async function forgetHandle(factory: IDBFactory = indexedDB): Promise<void> {
  await transact(await open(factory), 'readwrite', (s) => s.delete(KEY));
}

/** Chromium only, and only from a click: `showDirectoryPicker` is a user-gesture API (ADR 0014). */
export interface PickerWindow {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<DirHandle>;
}

export async function pickFolder(win: PickerWindow = window as PickerWindow): Promise<DirHandle> {
  if (!win.showDirectoryPicker) {
    throw new Error('this browser has no directory picker; FEM Lab needs Chromium for the project folder');
  }
  return win.showDirectoryPicker({ mode: 'readwrite' });
}
