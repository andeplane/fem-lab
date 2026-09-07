// The project folder over Chromium's File System Access API (plan B §7.9, ADR 0014). Scoping is
// structural — every read and write walks from the folder's own handle segment by segment, so
// nothing outside it is reachable — and `assertInside` runs first only to give a clean `file.scope`
// error instead of a browser exception.
//
// The handles are described here rather than taken from lib.dom, because lib.dom types neither the
// async iteration nor the permission methods, and because a structural type is what lets the tests
// hand in a 40-line in-memory fake.
import { FemError, assertInside, mergeSkills, parseSkill, type FolderInfo, type Skill } from '@femlab/registry';
import { HANDLES, done, openDb, tx } from '../db';

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

export type FileKind = FolderInfo['files'][number]['kind'];
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

  info(): FolderInfo {
    return {
      name: this.name,
      files: this.files,
      agentsMd: (this.agentsMd?.file ?? null) as FolderInfo['agentsMd'],
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
//
// Over `src/db.ts`, which owns the one `femlab` database. This module used to open it itself at
// version 1 with a `handles` store while `share.ts` opened the same name at the same version with
// an `autosave` store: whichever ran first won, and the other's transaction raised NotFoundError.
//
// Two records, not one, and that is issue #247. Chromium 153 ends the **browser process** when
// IndexedDB deserialises a stored `FileSystemHandle` in an off-the-record profile: no exception,
// no `crash` event, nothing a `try` can catch (151 is fine; a normal profile is fine). So the
// handle is never read at start-up. The plain `{ name, at }` record beside it carries everything
// the "reopen" affordance needs and deserialises like any other object, `getAllKeys`, `count`,
// `delete` and `put` never touch the value, and the handle itself is read only from a click,
// behind a breadcrumb that outlives the process dying — so a folder this browser cannot restore
// costs at most one crash and is then forgotten rather than retried on every start.

const KEY = 'folder';
const INFO = 'folder:info';
/** Set across the one read that can take the browser down with it; cleared when it comes back. */
export const RESTORING = 'femlab.folder.restoring';

/** What start-up may read: the folder's name, and when it was remembered. Never the handle. */
export interface RememberedFolder {
  name: string;
  at: number;
}

/** The three `localStorage` calls this module makes, injected so a test can drive them. */
export type Breadcrumbs = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const unavailable = (cause: string): FemError =>
  new FemError('file.not-found', cause, 'the remembered project folder', 'open a project folder again to pick it');

const isRemembered = (value: unknown): value is RememberedFolder =>
  typeof value === 'object' && value !== null && typeof (value as RememberedFolder).name === 'string' && typeof (value as RememberedFolder).at === 'number';

/**
 * Does the record still look like a directory handle at all? A file handle, a record from another
 * app, or whatever an older browser's structured clone left behind is refused here; whether the
 * folder is still *readable* is settled by `reopenRemembered`, which is the only honest test.
 */
const isDirHandle = (value: unknown): value is DirHandle =>
  typeof value === 'object' && value !== null && (value as DirHandle).kind === 'directory' && typeof (value as DirHandle).name === 'string';

/** `FileSystemDirectoryHandle` is structured-cloneable, so a reload can offer "reopen <name>". */
export async function rememberHandle(handle: DirHandle, factory: IDBFactory = indexedDB, now: () => number = () => Date.now()): Promise<void> {
  // One transaction over both records: a handle without its descriptor is never offered, and a
  // descriptor without its handle would offer a folder that cannot be restored.
  const db = await openDb(factory);
  try {
    const store = db.transaction(HANDLES, 'readwrite').objectStore(HANDLES);
    await done(store.put(handle, KEY));
    await done(store.put({ name: handle.name, at: now() } satisfies RememberedFolder, INFO));
  } finally {
    db.close();
  }
}

/**
 * The remembered folder's name, read without deserialising the handle — the only handle-store
 * read that is safe to make at start-up (#247). A handle left by an older build has no descriptor
 * beside it and can never be offered again, so it is dropped rather than kept unreadable forever.
 */
export async function rememberedFolder(factory: IDBFactory = indexedDB): Promise<RememberedFolder | null> {
  const info = await tx<unknown>(factory, HANDLES, 'readonly', (s) => s.get(INFO));
  if (isRemembered(info)) return info;
  const keys = await tx<IDBValidKey[]>(factory, HANDLES, 'readonly', (s) => s.getAllKeys());
  if (keys.length > 0) await forgetHandle(factory);
  return null;
}

/**
 * Deserialise the remembered handle. `null` when nothing is remembered; a structured
 * `file.not-found` when the record cannot become a usable handle — including when the previous
 * attempt never came back, which is how the Chromium 153 crash is survived exactly once.
 */
export async function recallHandle(factory: IDBFactory = indexedDB, crumbs: Breadcrumbs = localStorage): Promise<DirHandle | null> {
  const remembered = await rememberedFolder(factory);
  if (!remembered) return null;
  if (crumbs.getItem(RESTORING) === remembered.name) {
    await forgetHandle(factory, crumbs);
    throw unavailable(`restoring ‘${remembered.name}’ ended this browser last time, so it is not tried again`);
  }
  crumbs.setItem(RESTORING, remembered.name);
  const value = await tx<unknown>(factory, HANDLES, 'readonly', (s) => s.get(KEY));
  crumbs.removeItem(RESTORING);
  if (isDirHandle(value)) return value;
  await forgetHandle(factory, crumbs);
  throw unavailable(`the remembered folder ‘${remembered.name}’ is no longer available in this browser`);
}

export async function forgetHandle(factory: IDBFactory = indexedDB, crumbs: Breadcrumbs = localStorage): Promise<void> {
  crumbs.removeItem(RESTORING);
  const db = await openDb(factory);
  try {
    const store = db.transaction(HANDLES, 'readwrite').objectStore(HANDLES);
    await done(store.delete(KEY));
    await done(store.delete(INFO));
  } finally {
    db.close();
  }
}

/**
 * Reopen the remembered folder end to end: deserialise the handle, then prove it still reads.
 * A folder that was moved, deleted or whose permission is gone is forgotten and reported the same
 * way as one that never deserialised, so the caller has one failure to handle instead of three.
 */
export async function reopenRemembered(factory: IDBFactory = indexedDB, crumbs: Breadcrumbs = localStorage): Promise<ProjectFolder | null> {
  const handle = await recallHandle(factory, crumbs);
  if (!handle) return null;
  try {
    return await ProjectFolder.fromHandle(handle);
  } catch (error) {
    await forgetHandle(factory, crumbs);
    throw unavailable(`the remembered folder ‘${handle.name}’ could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
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
