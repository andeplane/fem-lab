// The project folder over Chromium's File System Access API (plan B §7.9, ADR 0014). Scoping is
// structural — every read and write walks from the folder's own handle segment by segment, so
// nothing outside it is reachable — and `assertInside` runs first only to give a clean `file.scope`
// error instead of a browser exception.
//
// The handles are described here rather than taken from lib.dom, because lib.dom types neither the
// async iteration nor the permission methods, and because a structural type is what lets the tests
// hand in a 40-line in-memory fake.
import { assertInside, mergeSkills, parseSkill, type FolderInfo, type Skill } from '@femlab/registry';
import { HANDLES, tx } from '../db';

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
  async refresh(): Promise<void> {
    const files: ProjectFile[] = [];
    await walk(this.handle, '', 1, files);
    this.files = files;
    this.agentsMd = await this.readAgents();
    this.skills = [];
    for (const file of files.filter((f) => f.kind === 'skill')) {
      try {
        this.skills.push(parseSkill(await this.readText(file.path), 'project'));
      } catch {
        // A malformed SKILL.md is skipped rather than making the whole folder unopenable.
      }
    }
  }

  private async readAgents(): Promise<{ file: string; text: string; at: number } | null> {
    for (const file of AGENTS_FILES) {
      if (!this.files.some((f) => f.path === file)) continue;
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
 * call back when the text actually changed — cheaper and far less code than a FileSystemObserver
 * that Chromium only recently grew.
 */
export function watchAgents(folder: ProjectFolder, onChange: () => void, everyMs = 4000, timer = setInterval): () => void {
  const at = folder.agentsMd?.at ?? 0;
  let last = at;
  const id = timer(() => {
    void folder.refresh().then(() => {
      const now = folder.agentsMd?.at ?? 0;
      if (now !== last) {
        last = now;
        onChange();
      }
    });
  }, everyMs);
  return () => clearInterval(id as ReturnType<typeof setInterval>);
}

// --- remembering the folder across reloads ------------------------------------------------------
//
// Over `src/db.ts`, which owns the one `femlab` database. This module used to open it itself at
// version 1 with a `handles` store while `share.ts` opened the same name at the same version with
// an `autosave` store: whichever ran first won, and the other's transaction raised NotFoundError.

const KEY = 'folder';

/** `FileSystemDirectoryHandle` is structured-cloneable, so a reload can offer "reopen <name>". */
export async function rememberHandle(handle: DirHandle, factory: IDBFactory = indexedDB): Promise<void> {
  await tx(factory, HANDLES, 'readwrite', (s) => s.put(handle, KEY));
}

export async function recallHandle(factory: IDBFactory = indexedDB): Promise<DirHandle | null> {
  return (await tx<DirHandle | undefined>(factory, HANDLES, 'readonly', (s) => s.get(KEY))) ?? null;
}

export async function forgetHandle(factory: IDBFactory = indexedDB): Promise<void> {
  await tx(factory, HANDLES, 'readwrite', (s) => s.delete(KEY));
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
