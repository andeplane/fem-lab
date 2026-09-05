# Handoff: FEM Lab — browser FEA editor (main screen, workflow, AI assistant)

## Overview
FEM Lab is a finite-element analysis editor + solver that runs in a browser tab. Target users are
Norwegian structural/building engineers (byggingeniører) doing reinforced-concrete and steel checks
to NS-EN Eurocodes, plus students, researchers, and an in-app AI agent that drives the same
Commands. This handoff covers the **entire main screen** and its overlays in every key state, with
one worked model: a reinforced-concrete corbel (C30/37, ULS 6.10b per NS-EN 1990, checked to
NS-EN 1992-1-1 §6.5).

Read `DESIGN-BRIEF.md` first — it is the product spec (mental model, workflow, rules). This README
is the visual + behavioural spec that implements it.

## About the design files
`FEM Lab.dc.html` (+ `fem-viewer.js`, `support.js`) is a **design reference built in HTML** — an
interactive prototype showing intended look and behaviour. It is *not* production code. Open it in
Chromium from a local static server (the viewer loads three.js from unpkg and IBM Plex from Google
Fonts). Recreate it in the target codebase (the brief says: static site, TypeScript, Web Worker
solver, three.js or Babylon; UI framework is open — React or Solid are natural fits given the
Command → state → view shape). Where nothing exists yet, choose a framework and port the layout,
tokens and state machine below.

## Fidelity
**High-fidelity** for layout, colour, type, density, copy and state logic — recreate pixel-close.
Numbers in tables are realistic placeholders from a hand calc, not solver output.
The 3D viewer content (mesh, contours, glyphs) is a stylised stand-in built with three.js; the real
viewer must render the engine's mesh but should keep the visual treatment (dark ground grid, flat
grey geometry, viridis contours, cyan pins, orange arrows, axis triad, probe readout).

Prototype-only shortcuts (not to be shipped as-is):
- Geometry is a preset corbel (two boxes + union). Real app needs free numeric entry, cylinders,
  extruded polygons, booleans, IFC/SAF/STEP import.
- Face picking in the viewer is simulated (probe readout names faces by position).
- `@` mentions come from a fixed list; real app indexes Model objects, Journal ranges, project files.
- Camera presets, copy/download, Revert, "pick in viewer" are visual only.
- The bottom "Design review · key states" strip is a review aid — **do not ship it**.

---

## Information architecture & layout

Desktop only (≥ 1180 px; the shell scrolls below that). `IBM Plex Sans` for UI, `IBM Plex Mono` for
every number, name, command and code. Base font 13 px.

```
┌ Top bar 46px ──────────────────────────────────────────────────────────────────────┐
│ ◇ FEM Lab │ Model_name ● │ [Search commands or ask… ⌘K] │ mm N MPa|m N Pa ↶ ↷ engine │ Solve │ Examples Export Report │ ✳ Assistant │
├ (optional) blocker banner 32px — "W-1101 Body has no material → mat.assign(…)" ─────┤
├ Model tree 274px ┬ Viewer (flex, min 520 × 460) ─────────────┬ Properties 308px ┬ Assistant 392px (drawer) ┤
│ GEOMETRY         │ [Geometry|Mesh|Results] [glyphs clip …] [iso…] │ New body / form  │ AGENTS.md · skills     │
│  corbel          │ [@selection chip]                              │ fields…          │ messages, tool cards   │
│  base            │                                                │                  │ verification card      │
│ MATERIALS        │           3D viewer            legend (right)  │ Will be recorded │ journal diff           │
│ …                │                                                │ as: command      │ @ composer             │
│                  ├ Bottom panel 252px (min 184) ──────────────────┤ [Apply] [Revert] │                        │
│                  │ Journal | Script | Results | Checks | Console  │                  │                        │
└──────────────────┴────────────────────────────────────────────────┴──────────────────┴────────────────────────┘
```

Panel backgrounds `#101218`; page `#0a0b0e`; viewer well `#0d0f13`; assistant `#0d0f13`.
All panel borders `1px solid #23262e`; inner dividers `#1b1e25`.
Section labels: 10 px, uppercase, letter-spacing .14em, `#666c76`.

## Design tokens (dark theme — default)

Colours
- Background: page `#0a0b0e` · panel `#101218` · well `#0d0f13` · raised `#181b21` · selected row `#1b1f26` · segmented-active `#22262e`
- Borders: panel `#23262e` · divider `#1b1e25` · control `#262a33` · hover `#3a4150`
- Text: high `#e7e9ec` · body `#c8cdd4` · low `#8b929d` · faint `#666c76` · dim `#4c525b` / `#555b64`
- Accent orange `#e2703a` (primary buttons, solve, active tab underline, load glyphs `#f0824b`)
- Cyan `#58b7d6` (links, commands, constraints, face sets; tinted text `#8fd0e6`; tint bg `#131a1e`; tint border `#2c4a57`)
- Green `#5fbf8f` (passes, solved) · Yellow `#d9a441` (warnings, unsaved, skills) · Red `#e05252` (errors; text `#f0908f`; bg `#1a1012`; border `#4a2226`)
- Warning surface: bg `#1c1712` / `#1c1410`, border `#3e2f18` / `#3a2418`, text `#e0bd85` / `#f0a97b`
- Pass surface: bg `#0f1613`, border `#1e3128`
- Report paper: `#f7f6f3`, ink `#1a1c21`, muted `#5f5a52`, rule `#ddd8ce`

Contour maps: viridis `#440154 #414487 #2a788e #22a884 #7ad151 #fde725` (default);
turbo (14 stops, see `fem-viewer.js`); classic rainbow `#0000ff #00ffff #00ff00 #ffff00 #ff0000`.

Type (px / weight)
- UI body 12–13 / 400 · labels 11.5 / 400 low · section labels 10 / 500 uppercase .14em
- Mono: numbers, names, commands 11–12.5 / 400; tabular-nums, right-aligned in tables
- Panel titles 12–14 / 600 · Start-screen title 20 / 600 · Report H1 25 / 600

Spacing & shape
- Radii: 3 px (controls, cards), 4–5 px (modals). No pills except none.
- Control heights: inputs 29 px, top-bar buttons 28 px, tabs 32 px, tree rows ~38 px
- Panel padding 12 px; table cell padding 4 px 8 px; gap 6–8 px in toolbars
- Shadows only on modals: `0 24px 60px #000000aa`
- Motion: only functional — spinner `.8s linear`, pulse `1.4s`, no layout animation

Light theme: not designed in this round (brief item 9 — pending).

---

## Screens & states

One screen; state is `stage` × `built` (how much of the Model exists, 0–9). The review strip at
the bottom jumps between them; in production these arise naturally.

### 0 · Start / empty
Full-screen `#0a0b0e`, centred: logo (16 px orange rotated square + "FEM Lab"), one-line pitch,
three 248 px cards: **Ask the Assistant** (border `#3e2f18`, cue yellow), **Open an example**,
**Start from geometry**. Under them, a mono capability line: `● WebGPU available · ● 8 worker
threads · ● meshers load on demand (1.2 MB) · no install · no server · nothing leaves the tab`.
Must render before heavy bundles load.

### 1 · From scratch (build stages 0→8)
Viewer shows only the ground grid + triad, centred hint "No geometry yet …". Every tree group is
empty with one sentence + `+ add <thing>` (dashed cyan chip). Properties shows **New body**
(model name, display units, idealisation, size, position, name) with primary button **Add body**.
The blocker banner (see below) states the *next* missing thing; its mono link performs it.
Each Apply emits the Command(s) shown in "Will be recorded as", appends to Journal + Script,
selects the new object, and the viewer updates (column → corbel → mesh edges → pins → arrows).
Order: frame+box → nib+union → name faces → material → mesh → constraint → load → step → Solve.

### 2 · Geometry (no material) — blocker `W-1101`
### 3 · Meshed — Mesh badge `ok` or `1 warning` (Tet 4 chosen → inline warning with **Hex 20** fix)
### 4 · Solving — centred card 340 px: "Solving · ULS 6.10b", Cancel, 3 px progress bar, mono grid
`iter n/12 · ‖r‖ 4.5e−4 · eta 3.8 s`, "PCG + AMG · 125 709 DOF · viewer stays interactive".
Solve button becomes `Solving 47 %` (bg `#3a2a20`, text `#f0824b`) with spinner.
### 5 · Results — contours on deformed shape; legend; deformation bar; Results tab; Solve button
`Solved · rev N` (bg `#16211c`, text green).
### 6 · Stale — any Model edit after a Result: contours dim to 42 %, banner top-centre
"Result is stale — Model changed after journal line N" + orange **Re-solve**; Solve reads
`Re-solve`; Results badge `stale`; new journal lines get yellow left mark + bg `#1c1712`.
### 7 · Error — `E-3140 Mesh contains 3 inverted elements`: red card in viewer with cause, where,
and two actions: mono cyan pill `mesh.set({ size: "25 mm" })` and "Send this error to the
Assistant". Solve disabled with the same code in the banner. Console shows the error line.

### Blocker banner (well-posedness before solving)
32 px strip under the top bar, bg `#1c1410`, border-bottom `#3a2418`. Contents: code chip (mono
10.5, yellow, border `#56391c`) · plain-language cause (12 px `#f0a97b`) · mono cyan fix command
(clickable, underlined `#2c4a57`). Codes used: W-1000 no body · W-1001 one box · W-1002 no named
faces · W-1101 no material · W-1200 no mesh · W-1300 no constraint · W-1400 no load · W-1500 no
step · E-3140 inverted elements. Solve is disabled (bg `#191b21`, text `#555b64`) while shown.

---

## Components

### Top bar (46 px, `#101218`)
Logo block with right border · model name (mono 12.5 high) + 6 px yellow dot when unsaved ·
command-palette field (max 330 px, 28 px, bg `#0a0b0e`, border `#262a33`, placeholder
"Search commands or ask in plain words", `⌘K` key chip) · right cluster: units segmented
(mono 11, active `#22262e`/high) · undo/redo 26 px glyph buttons · engine chip (5 px green dot +
mono 10.5 "local GPU · 8 threads", border `#23262e`) · **Solve** button (28 px, 600, states above)
· text buttons Examples / Export / Report (12 px low, hover bg `#181b21`) · **Assistant** toggle
(28 px, outline; active: border `#56391c`, text `#f0824b`).

### Model tree (274 px)
Header "MODEL" + mono `rev N` (rev = Journal length). Groups in workflow order: Geometry,
Materials, Mesh, Constraints, Loads, Steps, Results, Plugins. Group row: caret (mono 9 dim) ·
uppercase 11 px label · right badge (mono 10; `ok` green, `1 warning` yellow, `3 errors` red,
counts faint). Item row: 2 px left mark (orange when selected), bg `#1b1f26` when selected;
9 px glyph (◈ body, ▣ face cyan, ● material, ▦ mesh, △ constraint cyan, ↓/→ load orange,
▶ step, ◧ result, ⚙ plugin) · mono 12.5 name · 11 px faint one-line summary with units
("2.4 MPa on bearing_top → 252 kN") · trailing `@` (dim; hover cyan) = reference in chat.
Empty group: one explanatory sentence (11 px `#5c626b`) + `+ add …` chip.

### Properties (308 px) — generated from the Command schema
Header "PROPERTIES" + mono command type (`load.pressure`). Name (mono 13 high) + "@ reference in
chat" link; hint sentence (11.5 faint). Fields, each with label (11.5 low) and right-aligned
dimension tag (mono 10 dim, e.g. `pressure · M L⁻¹ T⁻²`):
- **Quantity field**: 29 px, bg `#0a0b0e`, border `#262a33` (cyan `#2c4a57` when it is the
  step's key field), mono 12.5 value with unit ("2.4 MPa"), − / + steppers; below, mono 10.5
  echo of the normalised value and derived total ("= 2.40e+6 Pa · 252.0 kN over 105 000 mm²").
- **Enum**: segmented, border `#262a33`, active cell bg `#22262e` text high, 11.5 px.
- **Face/set picker**: chips (bg `#131a1e`, border `#2c4a57`, mono 11 cyan `#8fd0e6`, count in
  `#4c6b78`, ×) + dashed "pick in viewer" chip; rule note beneath ("Stored as a rule … survives
  remeshing").
- **Validation error**: red surface, ✕, plain language + fix.
- **Warning that teaches**: yellow surface, `!`, text, and a yellow filled fix button
  ("Switch to Hex 20").
Footer: "WILL BE RECORDED AS" + mono cyan command block (pre-wrap, may be 2 lines) · primary
orange **Apply** (label changes per step: Add body, Add nib + union, Name faces, Assign C30/37,
Mesh, Add constraint, Add load, Add step) · outline **Revert**.
Rule: one Apply = one Command batch; sliders emit on release.

### Viewer chrome
- Top-left: display-mode segmented (Geometry | Mesh | Results), toggles (mono 11: glyphs, clip,
  edges, rebar — on = cyan, off `#5c626b`), camera presets (iso, front, top, fit). All on
  `#101218cc` with blur.
- Under it: **selection chip** (max-width 100%−20 px, truncating): `@reentrant_corner` mono cyan ·
  meta faint · `⌘C` key chip (turns green "copied") · "name by rule" link.
- Right: **legend** 168 px (top 56, bottom 58, scrolls if short): field name + unit, "ULS 6.10b ·
  deformed ×120", 16×132 px gradient bar, six mono ticks (top tick orange), divider, peak vs
  `f_cd C30/37 17.0`, three colour-map swatches (12 px, active outlined high).
- Bottom-right: **deformation bar**: ▶/❚❚ (mode/transient animation), "deformation", range
  0–400 step 10 (accent orange), mono `×120`, "true scale", "screenshot".
- Bottom-left: probe readout (mono 11 low) — `σ_vM 12.40 MPa · node 1342 · x 0 y 412 z 1388 mm`
  in Results; face name + coordinates otherwise.
- Overlays: solving card, stale banner, error card, "No geometry yet" hint (all above).
Viewer canvas: z-up, ground grid `GridHelper(4000, 40, #232730, #171a20)` at z = −2, hemisphere +
two directional lights, geometry flat grey (0.58) with quad edges `#272b33`; mesh mode grey 0.46
with edges `#5b6472`; results vertex-coloured, edges hidden. Glyphs: constraint pins = 4-sided
cones cyan under base; loads = orange cylinder+cone arrows on bearing_top; gravity single arrow.
Clip plane along y at 520 mm. Must hold 60 fps while solving (engine in a Worker).

### Bottom panel (252 px, min 184)
Tabs (12 px; active high + 2 px orange underline; mono count): Journal 41 · Script ts · Results
3/— · Checks ok/1 warn/1 err · Console. Right: "view as Script / view as Journal", copy,
download .ts.
- **Journal**: rows mono 11.5 — line no. (dim, right) · command (cyan; `solve.*` green) · args
  (body, ellipsis) · who (`you`/`ai`) · time. Under the solve line: hairline separator
  "RESULT PRODUCED HERE · UNDO BOUNDARY". Post-result edits: yellow mark + `#1c1712` bg.
- **Script**: line numbers + TypeScript (mono 11.5, lh 1.75), imports/blank faint, checks green,
  export cyan, the edited line orange. Right rail 214 px: **▶ Run script**, console output
  green, note "The Journal, typed. Edit a line and rerun and the Model replays from there."
- **Results**: two columns. Left: Extremes table (field · min · max · location; peak orange),
  "CODE CHECK · NS-EN 1992-1-1, NA NORWAY" rows (✓/!/✕ · name · utilisation · clause). Right:
  Reactions table (kN, Fx Fy Fz per constraint, Σ, Σ applied) + pass surface
  "✓ Σ reactions = −Σ loads · 0.0000 %"; "MESH CONVERGENCE · u_z" mini bars (100/50/25 mm, last
  green) with "→ −1.42 mm (Δ 0.7 %)". Before a Result: "No Result yet" + next-command chip.
- **Checks**: groups Well-posedness (body, material, constraints, loads, named faces — each
  ✓/✕/! with an action chip that performs the fix), Mesh quality (min scaled Jacobian, element
  warning, aspect ratio), Cost estimate (DOF, memory, predicted time), Assumption log (every
  default the solver used; rules from AGENTS.md tagged cyan).
- **Console**: mono 11.5 lines — time · level (command cyan, engine cyan, assemble/solve low,
  warn yellow, check/result green, error red) · text. Errors carry codes (`W-2210`, `E-3140`).

### Command palette (⌘K)
Overlay `#05060899` blur, card 640 px at 12 vh. Header: orange `›`, mono query with orange caret,
"every entry is one Command". Rows: mono command (206 px, coloured by kind) · description · key.
Footer keys: ↑↓ move · ↵ run · ⇥ fill parameters · @ reference an object · esc close. Natural
language queries resolve to Commands with parameters.

### Assistant drawer (392 px, collapsed by default; tweak `aiDocked` shows it docked)
Header: ✳ orange ring, "Assistant", "shares this Model", ×.
Context strip (bg `#0a0b0e`): **AGENTS.md** row (caret, mono cyan name, "4 project rules in force",
paths) expanding to the rules; **Skills** chips (mono 10.5, yellow dot when on, toggle) —
`eurocode-1992`, `eurocode-1993`, `load-combos-1990`, `calc-note-no`, `convergence`, `beam-theory`.
Messages (gap 10): user bubble right-aligned (bg `#181b21`) with inline `@mention` tokens
(mono cyan on `#131a1e`); assistant text 12 px body; **skill card** (dashed `#3e2f18`, ◆ yellow,
"skill: name · what it did"); **tool call card** (border `#262a33`; header ✓/✕ · mono command ·
ms; mono cyan args; result row — red text/border on failure). Each tool call lands in the Journal
at the same moment. **Verification card** (border `#2c4a57`, bg `#0e1418`, "◎ VERIFICATION",
"also in Checks"): reaction balance, hand-calc cross-check, code check, mesh-sensitivity note.
**Files card** ("Wrote 3 files": path · size · download). **Journal diff card** ("Journal diff ·
this turn", + lines green, turn-start marker faint, red outline **Undo turn** = one unit).
Thinking line: spinner + pulsing status ("solving ULS 6.10b…").
Composer: optional paste hint (dashed cyan) "⌘V paste @reentrant_corner as a reference · copied
from the viewer"; suggestion chips; token row (removable `@` chips) + placeholder; footer `@`
button (opens mention popover), `@selection`, `/skill`, orange **Send**; cost line
"this turn: 4 commands · 1 skill · 21 s · $0.038 · key stored in this browser".
Mention popover (above composer): kinds face/body/load/result/journal/file/selection coloured
by kind, name mono, meta faint; sources: Model, Journal ranges, project files (AGENTS.md, xlsx,
ifc), current viewer selection.
Behaviour: ⌘C with a selection copies it as a reference; ⌘V in the drawer pastes as a token.
From the empty state, Send makes the Assistant build the whole model as visible tool calls,
then solve and post the verification card. Human and AI share one Model; no "AI mode".

### Export modal (880 px)
Groups: Model & mesh (IFC 4.3, SAF .xlsx, STEP AP242, Abaqus/CalculiX .inp, Gmsh .msh), Results
(VTU, CSV, XLSX, glTF, PNG), Document & model file (.md, .pdf calc note, .ts script, .femlab).
Each row: ext (mono) · name · note · mono cyan Command (`xport.model("ifc")`). Footer notes IFC/SAF
round-trip via `import.model()`. Primary **Export selected**.

### Examples gallery modal (1080 px)
Cards 238 px+: 96 px gradient thumb with tag chip (P1 · verify, P2 · NS-EN 1992 …), title 12.5/600,
sentence, footer reference label + value (mono cyan). Nine benchmarks incl. RC corbel strut-and-tie,
flat slab punching, Kirsch, Lamé, NAFEMS LE10, Cook's membrane. Opening loads the Journal; a
KaTeX theory panel sits beside the result (not drawn — spec in brief §5.7).

### Report view (full-screen)
Toolbar: title, "from rev N · Markdown · skill: calc-note-no", Export PDF, Copy Markdown, Close.
Paper 820 px `#f7f6f3`, padding 52/58: kicker (mono uppercase), H1, meta; numbered sections
(Assumptions, Geometry and material, Mesh and quality, Loads and combination, Results, Conclusion)
each a 3-column key/value/note list (value mono tabular), figure placeholders (striped, captioned
"viewer screenshot, 2400 px"); appendix = Journal as script on dark block. Blocked with an
explanatory dialog until a Result exists.

---

## Interactions & behaviour (summary)
- Every control → exactly one Command; the Properties footer shows it before Apply.
- Apply in build mode advances the model; after a Result exists any Model edit → stale (dim
  contours, Re-solve). View state (camera, colour map, scale, clip) never makes a Result stale.
- Solve: disabled + reason until well-posed; progress with cancel; viewer interactive throughout.
- Tree item click → Properties; `@` → reference in chat; `+ add` → focuses the right form.
- Keyboard: ⌘K palette, Esc closes overlays, ⌘C/⌘V selection ↔ chat, ⌘Z/⇧⌘Z undo/redo (not wired
  in prototype), view presets ⇧1–4.
- Deformation slider updates live, emits `view.contour({ scale })` once on release; ▶ animates
  the scale sinusoidally (mode shapes / transient).
- Units toggle re-renders every quantity in the chosen system (prototype changes the script and
  new-body form only).

## State model
```
stage: start | build | geometry | mesh | solving | results | stale | error
built: 0..9   (0 none, 1 box, 2 union, 3 faces, 4 material, 5 mesh, 6 constraint, 7 loads, 8 step, 9 solved)
scratch: bool (model was built by the user — never inject demo objects)
sel: selected tree item id → drives Properties
tab: journal | script | results | checks | console
view: mode, scale, colormap, glyphs, clip, play   (Command-driven, not saved)
model edits: pressure, meshSize, element, units
journal: Command list (derived from built + edits); rev = journal.length
ai: open, aiBuild, step, thinking, tokens, copied, skillsOff, rulesOpen
overlays: palette, examples, report, export, mentionOpen
```
Solve completion: stage → results, built → 9, select first Result, Results tab.

## Vocabulary (from brief §14)
Model, Geometry, Body, Face, Set, Mesh, Element, Material, Constraint (never "BC"), Load, Step,
Result, Command, Journal, Script, Solver, Plugin, Benchmark. Fix not Encastre, Pressure not DLOAD.

## Assets
No raster assets. Fonts: IBM Plex Sans 400/500/600, IBM Plex Mono 400/500/600 (Google Fonts;
self-host for the static site). Icons are Unicode glyphs in the prototype — replace with a
minimal line-icon set; keep textbook glyphs in the viewer (triangles/pins, arrows, arrow fields).
three.js r150 UMD is loaded from unpkg in the prototype.

## Files
- `FEM Lab.dc.html` — the full prototype (template + logic in one file; open via a static server)
- `fem-viewer.js` — `<fem-viewer>` web component: hex mesh generator, contours, glyphs, orbit,
  probe, clip; attributes `mode scale colormap glyphs clip play dim built meshed`
- `support.js` — prototype runtime (not for production)
- `DESIGN-BRIEF.md` — product brief this design implements

## Not designed yet (brief items still open)
Light-theme tokens; results-focused and viewer-only panel presets; theory panel (KaTeX) layout;
share-link and settings (API key, model choice) screens; structural-member idealisations
(beams/slabs/walls) beyond 3D solids.
