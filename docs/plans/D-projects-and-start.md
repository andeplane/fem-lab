# Plan D: projects, the start screen, and an Assistant that works before the Model does

Plan, 2026-09-06. Closes [#41](https://github.com/andeplane/fem-lab/issues/41) (project-based start
screen) and [#40](https://github.com/andeplane/fem-lab/issues/40) (the start screen's "Ask the
Assistant" does nothing without a Model). Companion to `B-registry-hosts-ui.md` §7, which owns the
app's architecture; where this plan changes something B decided, §9 says so. Rules are `AGENTS.md`,
vocabulary is `CONTEXT.md`, the visual spec is `docs/design/README.md`.

Everything here is host-side. The engine gains nothing: the Journal is still engine Commands only,
so a project's Journal is byte-identical to what `file.save` writes today and replays on the server
unchanged (AGENTS: "Hosts are swappable").

---

## 0. Summary

1. **A project is one Model's Journal plus metadata, in this browser's IndexedDB.** The single
   autosave slot becomes one record per project, keyed by id, migrated in place.
2. **Saves always go to the open project.** There is no "unsaved" state to lose: the background
   save writes the Journal after every Command, into the open project. **Save as file**
   (`file.save`) still downloads a `femlab/1`; the top bar says which project you are in and when
   it was last written.
3. **A project is created implicitly** the first time a Model becomes non-empty without one, named
   from `query.model().name`. That one rule covers `model.new`, `file.open`, `file.openExample`, a
   share link and the Assistant's first `model.new` — none of them needs to know projects exist.
4. **Five host Commands and two host Queries**, no engine change: `project.new`, `project.open`,
   `project.rename`, `project.delete`, `project.save`; `query.projects`, `query.project`.
5. **Two Commands are deleted**: `file.restore` and `query.autosave`. Recent projects replaces
   "restore the last model"; there is nothing left for them to do.
6. **The disk folder Commands are renamed** `project.open|close|refresh` → `folder.open|close|refresh`
   and `query.project` → `query.folder`. Two different things cannot both be `project.open { … }`.
7. **The Assistant drawer moves out of the workspace** into the top-level fragment as a fixed drawer,
   so it mounts on the start screen, keeps its conversation when the workspace comes up around it,
   and `chat.send` queues until it is mounted (#40).
8. **One `src/db.ts` owns IndexedDB.** Today `share.ts` and `ai/project.ts` both open database
   `femlab` at version 1 and each create a different object store — whichever creates the database
   first defines the store set, the other's `onupgradeneeded` never fires, and its transaction raises
   `NotFoundError`. Confirmed at `share.ts:191` (store `autosave`) and `ai/project.ts:179` (store
   `handles`). Today it is **latent, not live**: every `HostContext.project.*` in `host.ts` is a
   `soon()` stub, so `rememberHandle` is exported from `ai/index.ts` and never called. It goes live
   the moment the folder Commands are wired, and one db module is the fix.

---

## 1. The Command surface

All host, all in `packages/registry/src/host-commands.ts`, all over one new `HostContext.projects`
interface so every unit is testable with a fake (AGENTS: DI at every boundary). Nothing here is
journaled — `project.*` is host state, and the Journal holds engine Commands only.

| Command | Schema | Tool? | What it does |
|---|---|---|---|
| `project.new` | `{ name?: string }` | yes | new record + `model.new { name }` through the transport |
| `project.open` | `{ id: string }` | yes | read the Journal, replay it, make it current |
| `project.rename` | `{ id?: string, name: string }` | yes | metadata only, default the open one |
| `project.delete` | `{ id: string }` | **no** | drop record + Journal; no undo |
| `project.save` | `{}` | yes | flush the pending write now, take a thumbnail |
| `query.projects` | `{}` | yes | the Recent list |
| `query.project` | `{}` | yes | the open project and its save state |

Doc strings (these are the AI's tool descriptions; each is ≥ 80 characters and ships in this change):

```ts
def('project.new',
  'Start a new project: an empty Model and Journal under `name`, kept in this browser and saved after every Command from now on. The project that was open is left exactly as it was and stays in Recent projects, so starting another one loses nothing.',
  z.object({ name: z.string().optional() }), (i, ctx) => ctx.projects.new(i.name)),

def('project.open',
  'Open a saved project by id (query.projects lists them) and replay its Journal, so the Model, its history and its undo stack come back as they were left. Replaces whatever is open, which has already been saved under its own id.',
  z.object({ id: z.string() }), ({ id }, ctx) => ctx.projects.open(id)),

def('project.rename',
  'Rename a saved project, by default the one that is open. The name is what the top bar and the Recent projects list show; the Journal is not rewritten, so a file saved from it keeps the name the Model was created with.',
  z.object({ id: z.string().optional(), name: z.string() }), ({ id, name }, ctx) => ctx.projects.rename(id, name)),

def('project.delete',
  'Delete a saved project and its Journal from this browser for good. There is no undo and nothing was ever uploaded anywhere, so use file.save first if the model might be wanted again. Not a tool: deleting a person\u2019s work is theirs to do.',
  z.object({ id: z.string() }), ({ id }, ctx) => ctx.projects.delete(id), false),

def('project.save',
  'Write the open project now rather than waiting for the background save, and take a fresh thumbnail of the viewer for the Recent projects list. Returns `{ id, name, at, commands }`. Use file.save to write a `femlab/1` file instead.',
  none, (_, ctx) => ctx.projects.save()),

def('query.projects',
  'Every project saved in this browser, most recently edited first: id, name, when it was last written, how many Commands its Journal holds, and a small thumbnail. The start screen\u2019s Recent projects list is a view of this Query.',
  none, (_, ctx) => ({ projects: ctx.projects.list() })),

def('query.project',
  'The open project \u2014 id, name, when it was last written, how many Commands it holds and whether a write is in flight \u2014 or `null` when the Model is still empty and no project has been made yet. The top bar reads this.',
  none, (_, ctx) => ctx.projects.current()),
```

Amended: `file.autosave { on }` keeps its name and its job (the privacy switch) and its doc string
gains "…into the open project"; turning it off stops writing but does **not** delete existing
projects (today it clears the slot — that would now be data loss).

Deleted: `file.restore`, `query.autosave`, and the `AutosaveState` type.

Renamed (the collision fix): `project.open|close|refresh` → `folder.open|close|refresh`,
`query.project` → `query.folder`, `HostContext.project` → `HostContext.folder`,
`ProjectInfo` → `FolderInfo`. Optional in the same commit, recommended: the destination enum
`'download' | 'project'` on `file.save`/`file.export` → `'download' | 'folder'`, because
`to: 'project'` now reads as "into the IndexedDB project", which it is not.

**Not added:** `project.list` and `project.saveAs` from the issue text. Every read in this registry
is a Query (`query.autosave`, `query.skills`, `query.exportFormats`), so the list is
`query.projects`; and `project.saveAs` is `file.save`, which already writes a `femlab/1` to a
download or the open folder. The top bar labels that button **Save as file**. Two Commands not
written is two Commands that cannot drift.

---

## 2. The IndexedDB schema

One database, `femlab`, **version 2**, opened from exactly one module (`packages/app/src/db.ts`).

| Store | Key | Value |
|---|---|---|
| `projects` | `keyPath: 'id'` | `{ id, name, at, createdAt, commands, hash, thumbnail }` |
| `journals` | `keyPath: 'id'` | `{ id, cmds: ShareCommand[] }` |
| `handles` | out-of-line, key `'folder'` | the `FileSystemDirectoryHandle` (unchanged behaviour) |

```ts
export interface ProjectMeta {
  id: string;             // crypto.randomUUID()
  name: string;           // what the top bar and the cards show
  at: number;             // last written, ms
  createdAt: number;
  commands: number;       // journal length, so a card needs no journal read
  hash: string | null;    // query.model().hash at the last write, for the e2e identity check
  thumbnail: string | null; // a data: URL, ≤ 320×180 (see below)
}
```

Two stores, not one, so the Recent list reads a few kB of metadata and never the Commands. The
thumbnail is a **data URL string**, not a Blob: `Viewer.screenshot()` already returns one, `<img
src>` takes it directly, and no `URL.createObjectURL` needs revoking. 33 % bigger, one third the
code. `ponytail: data-URL thumbnails; move to Blobs if the projects store gets fat.`

### Migration from the single autosave slot

`onupgradeneeded` runs inside the versionchange transaction, so the old slot can be read and
rewritten in the same upgrade:

```ts
req.onupgradeneeded = (e) => {
  const db = req.result, tx = req.transaction!;
  if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('journals')) db.createObjectStore('journals', { keyPath: 'id' });
  if (!db.objectStoreNames.contains('handles'))  db.createObjectStore('handles');
  if (e.oldVersion >= 1 && db.objectStoreNames.contains('autosave')) {
    const old = tx.objectStore('autosave').get('last');
    old.onsuccess = () => {
      const saved = old.result as { name: string; at: number; cmds: ShareCommand[] } | undefined;
      if (saved) {
        const id = `migrated-${saved.at}`;
        tx.objectStore('projects').put({ id, name: saved.name, at: saved.at, createdAt: saved.at,
          commands: saved.cmds.length, hash: null, thumbnail: null });
        tx.objectStore('journals').put({ id, cmds: saved.cmds });
      }
      db.deleteObjectStore('autosave');
    };
  }
};
req.onblocked = () => reject(new FemError('unsupported',
  'another FEM Lab tab is holding an older version of this browser\u2019s storage',
  'IndexedDB femlab', 'close the other tab and reload'));
```

The person's one autosaved model therefore appears in Recent projects after the upgrade, under the
name it had. A browser with no `femlab` database at all gets v2 directly. `ai/project.ts`'s handle
helpers move onto this `openDb`, which is what removes the v1/v1 store collision.

No IndexedDB (private mode, a headless harness) → `memoryProjects()`, exactly as `memoryStore()`
does today; the start screen then says "projects need browser storage; use Save as file" in the
capability line and everything else still works.

---

## 3. The start screen

Full-screen `#0a0b0e`, one centred column, 880 px wide, on the tokens already in `style.css`.
Reading order is the issue's order and the brief's §5.9 intent: the thing a person is most likely
to want (say what they want in words) is first and is a real input, not a card that toggles a panel.

1. **Logo + one-line pitch** (unchanged).
2. **The assistant prompt.** A single wide composer, 56 px, placeholder *"Describe the part — a
   1 m steel cantilever, 50×100 mm, 10 kN at the tip…"*, with a **Send** button. Enter or the
   button opens the drawer and sends the line (§4). Under it, one faint line: *"the Assistant
   builds it as visible Commands; you can take over at any step"*. When there is no API key the
   composer still sends — the drawer opens on its Settings panel, which is where the key goes, and
   the typed line is kept in the composer.
3. **New project.** A name field (defaulting to `model`) and one primary button →
   `project.new { name }`.
4. **Recent projects.** Up to six cards from `query.projects`, newest first: 160×90 thumbnail (or a
   grid placeholder), name in mono, `12 Commands · edited 4 minutes ago`, and on hover two small
   controls, `project.rename` and `project.delete` (a confirm step for delete). The card itself is
   `project.open { id }`. A seventh-and-older row is a "show all (N)" disclosure, not a second
   screen. Nothing saved yet → one sentence: *"Projects you start are kept in this browser. Nothing
   is uploaded."*
5. **Open a file** → `file.open { picker: true }`, one line: *"a `femlab/1` file saved from here or
   from the CLI; it becomes a project when you edit it."*
6. **Examples** → `panel.toggle { panel: 'examples' }` (the existing gallery).
7. **Tutorials** → `panel.toggle { panel: 'tutorial' }` (the existing panel).
8. The capability line and the notes, unchanged.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              ◆ FEM Lab                                               │
│        A finite-element editor and solver in a browser tab. Nothing leaves this page. │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┬──────────┐  │
│  │ Describe the part — a 1 m steel cantilever, 50×100 mm, 10 kN at tip… │   Send   │  │
│  └─────────────────────────────────────────────────────────────────────┴──────────┘  │
│    the Assistant builds it as visible Commands; you can take over at any step         │
│                                                                                       │
│  NEW PROJECT                                                                          │
│  ┌───────────────────────────────┬───────────────┐                                    │
│  │ model                         │ New project   │   an empty Model, saved from the   │
│  └───────────────────────────────┴───────────────┘   first Command                    │
│                                                                                       │
│  RECENT PROJECTS                                                        show all (9)  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                                   │
│  │ [thumbnail]  │ │ [thumbnail]  │ │ [thumbnail]  │        ← project.open { id }       │
│  │ corbel-ULS   │ │ cantilever   │ │ plate-hole   │        hover: rename · delete      │
│  │ 41 cmds · 4m │ │ 12 cmds · 2d │ │ 9 cmds · 6d  │                                    │
│  └──────────────┘ └──────────────┘ └──────────────┘                                   │
│                                                                                       │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐           │
│  │ Open a file          │ │ Examples             │ │ Tutorials            │           │
│  │ a femlab/1 file;     │ │ worked benchmarks    │ │ nine guided walks,   │           │
│  │ becomes a project    │ │ with reference values│ │ one Command at a time│           │
│  │ file.open(picker)    │ │ panel.toggle examples│ │ panel.toggle tutorial│           │
│  └──────────────────────┘ └──────────────────────┘ └──────────────────────┘           │
│                                                                                       │
│  ● local GPU · 8 threads · WebGPU available · projects saved in this browser · no server│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

The same component renders as an overlay from the top bar's **Projects** button
(`panel.toggle { panel: 'projects' }`), which is how a person gets from a workspace back to the
list without a `project.close` Command existing.

---

## 4. The Assistant on the start screen (#40)

The cause: `<AssistantPanel/>` is mounted inside `.workspace`, which only renders when
`started === true`. Three changes, all small:

1. **One mount, at the top level of `App`'s fragment**, next to `<TutorialPanel/>` — which already
   works on the start screen and is the precedent. The drawer becomes
   `position: fixed; top: 0; right: 0; bottom: 0; width: 392px` and the shell reserves space with
   `.shell.with-assistant { padding-right: 392px }`, so the workspace layout is unchanged when it
   is open and the drawer simply floats over the start screen. Fixed slot in the fragment ⇒ preact
   keeps the node, so the conversation, the messages and the pending turn survive the
   `started` flip. That flip is what "the first `model.new` brings the workspace up around it"
   means: the AI's tool call goes through `main.tsx`'s `dispatch` wrapper → `refresh()` →
   `store.revision = 1` → `started` → the shell renders, the drawer is untouched, and the tool-call
   card the AI just wrote is still on screen.
2. **`chatBridge.send` queues.** Today it is a no-op until the panel's effect rebinds it, so
   "toggle the panel, then `chat.send`" is a race — the start screen composer and the existing
   `sendToAssistant` in `App.tsx` (the error card's "Send this error to the Assistant") both lose
   it. Give the bridge a one-slot pending buffer that the panel drains on mount. Root cause, both
   callers fixed.
3. **The start-screen composer** dispatches `panel.toggle { panel: 'assistant', open: true }` and
   then `chat.send { text }` — both registry Commands, both with `data-cmd`, so the enumeration test
   covers them.

The drawer's own "Ask the Assistant" card disappears from the start screen: the composer is the
card, and it is the same Command.

---

## 5. Where saves go, and the top bar

The rule, in one sentence: **the open project is where the Journal goes, and a project appears the
moment a Model does.**

- `noteProject(name, journal)` runs at the end of `refresh()`, exactly where `noteAutosave` runs
  today. If there is no current project and the journal is non-empty, it creates one named
  `query.model().name`; otherwise it debounces a write of `{ cmds }` + metadata.
- Commands that replace the whole Model — `model.new`, `file.open`, `file.openExample`,
  `example.open` (the registry's own, `host-commands.ts:336`, easy to miss) and a share link's
  replay — clear `current` first (a name set in `main.tsx`'s dispatch wrapper), so opening an
  example forks a new project instead of overwriting the one you were in.
- **Top bar**: the project name is an inline-editable mono field → `project.rename { name }` on blur
  or Enter; next to it a chip reading `saved · 12:04` (green dot), `saving…` (yellow, while a write
  is in flight) or `not saved — storage is off` when `file.autosave { on: false }`. There is no
  "unsaved dot", because with a background save there is no unsaved state, and a dot that lies is
  worse than no dot. **Save** → `project.save` (flush + thumbnail). **Save as file** → `file.save`.
  **Projects** → `panel.toggle { panel: 'projects' }`.
- Thumbnails are taken on `project.save` and after a successful `solve.run`, never on the debounce:
  a screenshot per Command would be absurd.

---

## 6. Tests

**vitest — `packages/app/test/projects.test.ts`** (new). `fake-indexeddb` as a devDependency, so the
real `openDb`, the real store and the **migration** are exercised, not a hand-rolled stand-in
(AGENTS: ponytail applies to code, never to verification).

- v1 database holding `autosave/last` → open at v2 → one project with that name, `commands` equal to
  the old `cmds.length`, the Journal readable, `autosave` store gone, a second open is a no-op.
- A fresh database gets all three stores; `handles` round-trips a fake directory handle, which is
  the regression test for the two-modules-at-v1 bug.
- `onblocked` produces a `FemError`, not a hang.
- create → list order (newest first) → rename → delete → list; delete removes the Journal too.
- The implicit fork: `note()` with no current project creates one named from the Model; `note()`
  after a Model-replacing Command creates a second, and the first still has its own Commands.
- The debounce writes once per burst (injected timer, as `makeAutosave` does today), and a failed
  write is reported through `onError` and swallowed.
- `memoryProjects()` satisfies the same table (the fake is type-checked against the real interface).

**vitest — existing files.** `data-cmd.test.tsx`'s start-screen case gets the new expected
`[data-cmd]` sequence (`chat.send`, `project.new`, `project.open` ×n, `file.open`, `panel.toggle`
×2) and a case asserting the Assistant drawer mounts with `started === false`.
`share.test.ts` loses its autosave half (that code moved). `packages/registry` keeps its 100 %
thresholds: the seven new defs get rows in `registry.test.ts`'s dispatch table and a fake
`ctx.projects`, and `tools.test.ts` already asserts every description ≥ 80 characters.

**Playwright — `packages/app/e2e/projects.spec.ts`** (new, `@cpu`), the round trip the issue asks
for:

1. `goto('./')` → fill the name field → **New project** → `.workspace` visible.
2. Build through `window.fem`: `geometry.addBox`, `material.add`, `material.assign`. Record
   `hash = (await window.fem.query.model()).hash`.
3. `window.fem.dispatch({ cmd: 'project.save' })` — the explicit flush, so the reload is not racing
   a debounce.
4. `page.reload()` → the start screen shows the project name in Recent, with `3 Commands`.
5. Click the card → `.workspace` → `(await window.fem.query.model()).hash === hash`, and
   `query.journal` has the same last `hashAfter`. Identity, not similarity.
6. Then: **Open a file** path — `file.save` to a download, `file.open` it back in a fresh project,
   same hash again.
7. #40 in the same file: on the start screen, type into the composer and press Enter with no API
   key → `aside.assistant` is visible **over the start screen** and its Settings panel is open;
   then `window.fem.model.new({ name: 'x' })` → `.shell` appears and `aside.assistant` is still
   there with the same content.
8. `[data-cmd]` ⊆ `registry.list()` on the start screen, as the smoke does for the shell.

`smoke.spec.ts` updates its two start-screen assertions (`Open an example` → `Examples`,
`button[title="model.new"]` → `project.new`); `build.spec.ts` starts from **New project**.

---

## 7. File-by-file

| File | Δ lines | What |
|---|---:|---|
| `packages/app/src/db.ts` **new** | +95 | one `openDb` at v2, the three stores, the migration, `onblocked` |
| `packages/app/src/projects.ts` **new** | +150 | `ProjectStore` (interface + IndexedDB + memory), debounced `note`, implicit fork, current id, thumbnail hook |
| `packages/app/src/share.ts` | −140 | the whole autosave half moves to `projects.ts`; share link untouched |
| `packages/registry/src/host-commands.ts` | +75 / −25 | 5 Commands, 2 Queries, `HostContext.projects`, `ProjectMeta`; delete `file.restore`, `query.autosave`, `AutosaveState`; rename `project.*` → `folder.*` |
| `packages/app/src/host.ts` | +70 / −45 | wire `ctx.projects`, `noteProject`/`primeProjects`, drop `autosave`/`restore`, rename `project` → `folder` |
| `packages/app/src/main.tsx` | +18 / −8 | prime projects at boot, the Model-replacing name set, refresh after `project.open|new`, and drop the `cmd.cmd === 'file.restore'` clause in the dispatch wrapper |
| `packages/app/src/store.ts` | +14 / −3 | `projects`, `project`, `saving`; drop `autosave` from `UiState` and `initialState` and the `AutosaveState` import |
| `packages/app/src/ui/Overlays.tsx` | +165 / −55 | `Start` rewritten (composer, New, Recent, three cards); `Projects` overlay wrapper |
| `packages/app/src/ui/App.tsx` | +30 / −8 | drawer mount moved out of `.workspace`, `.with-assistant`, top-bar name + saved chip + Projects button |
| `packages/app/src/ui/style.css` | +110 | start grid, composer, recent cards, fixed drawer, saved chip |
| `packages/app/src/ai/AssistantPanel.tsx` | +14 / −2 | `chatBridge` pending buffer, `folder.open` rename |
| `packages/app/src/ai/project.ts` | −22 | handle helpers move onto `db.ts` |
| `packages/app/src/ai/context.ts` | ±2 | `query.folder` |
| `packages/app/test/projects.test.ts` **new** | +150 | §6 |
| `packages/app/test/data-cmd.test.tsx` | +18 / −4 | new enumeration, drawer-before-Model case |
| `packages/app/test/share.test.ts` | −75 | autosave cases move |
| `packages/registry/test/{registry,fakes}.ts` | +45 / −10 | fake `projects`, new rows |
| `packages/app/e2e/projects.spec.ts` **new** | +110 | §6 |
| `packages/app/e2e/{smoke,build}.spec.ts` | ±12 | start-screen selectors |
| `packages/app/package.json` | +1 | `fake-indexeddb` devDependency |
| `docs/design/README.md` | +45 / −10 | state 0 rewritten: the new start screen, its tokens, the drawer over it |
| `docs/DESIGN-BRIEF.md` | +3 | §5.9 and §14: **Project** is now vocabulary (it was on the avoid list), meaning "one saved Model in this browser"; the disk one is **folder** |
| `docs/plans/B-registry-hosts-ui.md` | +8 | §7.3/§7.9 note the rename and point here |

≈ **1 100 added, 400 deleted**, six commits: (1) `db.ts` + migration + tests, (2) `projects.ts` +
Commands + Queries + registry tests, (3) the `folder.*` rename, (4) the start screen + CSS, (5) the
drawer move + `chatBridge` queue + #40 tests, (6) docs. Each green on its own.

---

## 8. Risks

1. **Two modules at database version 1** (latent bug, §0.8). Fixed by `db.ts`; the `handles`
   round-trip test is the regression guard.
2. **The upgrade is blocked by a second open tab.** `onblocked` → a structured error and a sentence,
   never a hang. Multi-tab beyond that is last-write-wins; `ponytail: no BroadcastChannel until two
   tabs on one project is a real complaint.`
3. **Storage is best-effort.** Chromium can evict IndexedDB under pressure. Thumbnails are capped at
   320×180, the start screen says where projects live, and **Save as file** is one click away.
   `navigator.storage.persist()` is a one-line opt-in if eviction is ever seen.
4. **Journal writes are O(n) per debounce** — the whole `cmds` array each time. Fine into the
   thousands of Commands; `ponytail: whole-array write, switch to an append-only store if a Journal
   ever gets big enough to feel it.`
5. **Project name vs Model name diverge on rename**, because there is no engine Command that renames
   the Model (`model.rename` renames objects; `model.new` sets the name and wipes). The metadata name
   wins for display; a file saved from it keeps the Journal's name. Upgrade path: a journaled
   `model.setName` in the engine, one variant, then `project.rename` dispatches it.
6. **The drawer overlays the Properties panel** on a narrow window even with `padding-right`, below
   ~1180 px, which the design already declares out of range.
7. **The rename breaks anyone's saved script or MCP call** using `project.open { picker: true }`.
   Pre-1.0, one line in the plan B update, and the error is a `NotFound` from the registry with
   `nearest()` suggesting `folder.open` — which is exactly what structured errors are for.
8. **The e2e reload could race the debounce** — hence step 3's explicit `project.save`; the
   debounced path is covered in vitest with an injected timer instead.

---

## 9. Explicitly out of scope

- Any engine change. No new Rust, no schema bump, no Journal format change.
- Cloud sync, accounts, sharing a project between browsers. `file.shareLink` and `file.save` are
  unchanged and remain the only ways a Model leaves the tab.
- Versions or history *inside* a project (no "restore yesterday's revision"). The Journal's undo
  stack and `file.save` cover it.
- Storing projects in the disk folder. `folder.*` keeps doing what it does; a project lives in
  IndexedDB. (Natural next step: `folder.link` so a project writes through to a `.femlab.json`.)
- Per-project settings: units, theme, API key, tutorial progress and the AI conversation all stay
  global and unpersisted, as today.
- Light-theme tokens for the new screen; still pending from the design round.
- Thumbnails for examples and tutorials, and a search box over Recent projects — the disclosure row
  is enough until there are more projects than a person can scan.

---

## Review (2026-09-06)

Reviewed against `main` at `f507046` (PR #51 and PR #35 both in), `AGENTS.md`, `docs/design/README.md`
and `docs/DESIGN-BRIEF.md`. Verdict: **sound, but split it.**

### Diagnoses

- **#40 confirmed.** `ui/App.tsx` renders `{registry && s.panels['assistant'] ? <AssistantPanel …/> : null}`
  *inside* `.workspace`, which is inside the `started ? …` branch; `started` is
  `s.model !== null && (bodies.length > 0 || s.revision > 0)`. `<TutorialPanel/>` is already at the top
  level of the same fragment, which is the precedent §4 claims it is.
- **`chatBridge` confirmed.** `ai/AssistantPanel.tsx:31-35` defines it as three no-ops; the panel rebinds
  them in an effect with no dependency array, so they are live only while the panel is mounted.
  `HostContext.chat` (`host.ts`) forwards into it through a dynamic `import()`. Both `chat.send` callers —
  the start screen composer to be, and `sendToAssistant` in `App.tsx` — lose the first send today. The
  one-slot pending buffer is the root-cause fix, and it is the right rung.
- **The IndexedDB collision confirmed but latent**, corrected in §0.8 above: `share.ts:191` and
  `ai/project.ts:179` both open `femlab` at version 1 with different stores, but nothing calls
  `rememberHandle` yet because `HostContext.project.*` are `soon()` stubs in `host.ts`. Keep `db.ts`; it
  is what makes the folder Commands landable later. Do not sell it as a live crash.
- **The `project.*` name collision confirmed**: `host-commands.ts:333-335` and `query.project` at 352 are
  the *disk folder*. The rename is forced, not cosmetic.

### Design against AGENTS.md

Every control named is a registry Command with `data-cmd`; the seven new defs carry doc strings over
80 characters; `HostContext.projects` is DI at the boundary; no engine change; the Journal stays engine
Commands only. Tests are named per file. Nothing here departs from a rule.

### Decisions

1. **Split this plan into two PRs, and do #40 first.** #40 is a three-file bug fix (the mount moves, the
   CSS, the `chatBridge` queue, two tests); #41 is ~1 100 lines with an IndexedDB migration. Shipping #40
   behind #41 keeps a visible bug on screen for no reason, and it frees the merge order below. Two issues,
   two PRs, as AGENTS asks.
2. **Say whether `projects.list()` and `.current()` are sync or async.** §1's bodies call them
   synchronously, but IndexedDB is not. Either return Promises (registry `def`s already await their
   handlers) or state that both read a memory cache primed by `primeProjects` and updated on every write.
   The fake in `packages/registry/test/fakes.ts` has to match whichever it is.
3. **Put the drawer's reserved space on `.under-bar`, not `.shell`.** `padding-right: 392px` on `.shell`
   shortens the top bar too, which the design draws full-width across the whole window
   (`docs/design/README.md`, layout diagram). On `.under-bar` the tree/viewer/properties/drawer row
   matches the design's five-column layout exactly, and the drawer still floats over the start screen.
4. **The thumbnail needs its own downscale.** `Viewer.screenshot()` renders at the canvas size and
   `HostContext.view.screenshot` ignores `width`/`height` (see plan F's review), so "≤ 320×180" is a
   canvas draw in `projects.ts`, not a screenshot option. One line; say so in §2.
5. **Vocabulary: the amendment is required, not optional.** `DESIGN-BRIEF.md` §14 lists *project* under
   **Avoid**. Issue #41 overrides the brief, but the §14 edit must land in the same commit as the first
   UI use of the word, together with the whole disk-side rename — including `AssistantPanel`'s folder
   button, which dispatches `project.open` from the context strip, and `ai/context.ts:145`'s
   `query.project`. The plan's file table understates AssistantPanel; it is the rename plus the queue.
6. **Migration: prefer the boring shape.** Reading `autosave/last` inside `onupgradeneeded` and calling
   `deleteObjectStore` from the request callback is legal (the versionchange transaction is still open)
   and works in Chromium and `fake-indexeddb`, but it is the fragile version. Read the old slot in the
   upgrade, delete the store unconditionally there, and let the first `openDb` caller write the migrated
   records in a normal transaction. Same behaviour, no nested-callback ordering to get wrong. Add one
   test: a v1 database whose slot is **empty** upgrades and produces no project.
7. **Scope is honest.** `project.list`/`project.saveAs` correctly declined; the renames are forced by the
   collision; the hover rename/delete, the "show all (N)" row and the thumbnails are all in the issue
   text. Nothing to cut. The `Destination` enum rename (`'project'` → `'folder'`) can wait for a
   follow-up if it makes the rename commit smaller.

### Risky assumptions to keep an eye on

- The Assistant's conversation lives in a component `useRef`, and the mount is still gated on
  `s.panels['assistant']`, so **closing** the drawer still loses the conversation. Surviving the
  `started` flip is what #40 asks for and what the fixed slot gives; say in the plan that closing it is
  unchanged, so nobody reads §4 as promising more.
- `project.new`/`project.open` are host Commands, so `main.tsx`'s dispatch wrapper will not `refresh()`
  for them unless the name set is extended — §7 covers it, but the e2e in §6 step 5 is what proves it.

## Ownership and merge order

Three plans, three worktrees, one shell. Merge **F → E → D**. F is two small bug fixes plus one
feature and touches the viewer, the results path and the Assistant's composer; E is the tutorial
module plus one attribute in `ui/cmd.tsx`; D is the largest, moves the Assistant drawer and rewrites
the start screen, so it rebases onto the other two rather than the other way round.

File ownership — a plan edits only what it owns; anything else it needs, it waits for:

- **F owns** `viewer/viewer.ts`, `results.ts`, `ui/Results.tsx`, `ui/Tree.tsx`, `ui/schema.ts`,
  `ui/SketchEditor.tsx` (new), `ui/SchemaForm.tsx`, `ai/assistant.css`, `ai/context.ts`, the mention
  half of `ai/AssistantPanel.tsx`, and in `ui/App.tsx` only `Legend`, `DeformBar` and the `shapes`
  prop. Tests: `results.test.tsx`, `schema.test.ts`, `form.test.tsx`, `tree.test.ts`,
  `ai-panel.test.tsx`, `ai-context.test.ts`, `e2e/results.spec.ts`, `e2e/build.spec.ts`.
- **E owns** `tutorial/**`, `ui/cmd.tsx`, `store.ts`'s `formHints` field, and in `ui/App.tsx` only
  the `<TutorialPanel …/>` line. Tests: `tutorial-runner.test.ts`, `tutorial-target.test.tsx`,
  `tutorial-panel.test.tsx`, `e2e/tutorial.spec.ts`. E does **not** touch `main.tsx` (its comment
  change is cut) and does **not** move the tree's `+ add …` chip — that is F #43.
- **D owns** `db.ts` (new), `projects.ts` (new), `share.ts`, `host.ts`, `main.tsx`,
  `ui/Overlays.tsx`, `packages/registry/src/host-commands.ts`, the `chatBridge` half of
  `ai/AssistantPanel.tsx`, and in `ui/App.tsx` the top bar, the `started` branch and the Assistant
  mount. Tests: `projects.test.ts`, `share.test.ts`, `packages/registry/test/*`,
  `e2e/projects.spec.ts`.

Three files are shared and get a rule instead of an owner:

- `ui/App.tsx` — the three disjoint regions above. Whoever merges later rebases; nobody reformats.
- `store.ts` — append new `UiState` fields at the end of the interface and of `initialState`, in
  merge order (E's `formHints`, then D's `project` / `projects` / `saving` and D's removal of
  `autosave`). Textual conflicts only.
- `ui/style.css` and `test/data-cmd.test.tsx` — append your block or case at the end under a comment
  naming the plan; never edit another plan's block. D rewrites the start-screen `data-cmd` case last.

Two ordering dependencies are real rather than cosmetic:

1. **E's `formHints` placeholders sit on F's `placeholder` prop.** F #43 adds `placeholder` to
   `SchemaForm`'s three input sites (lines 86, 254, 281); E only chooses the value. E's steps 1–4 are
   independent and can land first; E's step 5 rebases after F #43, or ships the store field with the
   wiring as a follow-up commit.
2. **D renames `query.project` → `query.folder` and `project.open` → `folder.open`.** F's
   `objectIndex` (`ai/context.ts:145`) reads the Query and `AssistantPanel`'s folder button
   dispatches the Command. F merges first; D carries both renames in its rename commit.

One consequence of the order: F #43's Geometry add menu gives `geometry.add` a `data-opens` control,
so E's palette fallback covers eight `highlight` values after F, not nine.
