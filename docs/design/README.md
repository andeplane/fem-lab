# Handoff: FEM Lab — browser FEA editor (main screen, workflow, AI assistant)

## Overview
FEM Lab is a finite-element analysis editor + solver that runs in a browser tab. Target users are
Norwegian structural/building engineers (byggingeniører) doing reinforced-concrete and steel checks
to NS-EN Eurocodes, plus students, researchers, and an in-app AI agent that drives the same
Commands. This handoff covers the **entire main screen** and its overlays in every key state, with
a mechanical prototype model: a reinforced-concrete corbel (C30/37, ULS 6.10b per NS-EN 1990,
checked to NS-EN 1992-1-1 §6.5), and the [production thermal flow](#thermal-flow-production)
for steady conduction and the NAFEMS T3 transient bar.

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

The mechanical prototype uses `stage` × `built` (how much of the Model exists, 0–9). Its review
strip jumps between them. Production readiness comes from the engine warnings for the requested
Step; the corbel build counter and mandatory mechanical load/support stages do not apply to heat.

### 0 · Start / projects (issue #41)
Full-screen `#0a0b0e`, one centred column 880 px wide, left-aligned inside it. Reading order is
the order a person wants: **say what you want in words** first, and as a real input rather than a
card that toggles a panel.

1. Logo (16 px orange rotated square + "FEM Lab") and the one-line pitch.
2. **The assistant composer**: one wide field, 56 px, placeholder *"Describe the part — a 1 m
   steel cantilever, 50×100 mm, 10 kN at the tip…"*, and an orange **Send**. Enter or the button
   dispatches `panel.toggle { panel: 'assistant', open: true }` and then `chat.send { text }`.
   With no API key the drawer still opens, on its Settings panel where the key goes, and the
   typed line stays in the composer. Under it one faint line: *"the Assistant builds it as
   visible Commands; you can take over at any step"*.
3. **NEW PROJECT**: a name field (default `model`) and one primary button → `project.new { name }`.
4. **RECENT PROJECTS**: up to six cards from `query.projects`, newest first — a 16:9 thumbnail
   (or a grid placeholder), the name in mono 12, and `41 Commands · edited 4 minutes ago` in
   faint mono. The card is `project.open { id }`; on hover two small controls, `project.rename`
   (an inline field) and `project.delete` (which asks once). A seventh-and-older row is a
   "show all (N)" disclosure, not a second screen. Nothing saved yet → one sentence: *"Projects
   you start are kept in this browser. Nothing is uploaded."*
5. Three 248 px cards: **Open a file** (`file.open { picker: true }`), **Examples**
   (`panel.toggle { panel: 'examples' }`), **Tutorials** (`panel.toggle { panel: 'tutorial' }`).
6. The mono capability line, which now also says where a project lives: `● local GPU · 8 threads
   · WebGPU available · projects saved in this browser · no server · nothing leaves the tab`.

Must render before heavy bundles load; the Recent list is read from IndexedDB before the wasm.
The same component is the **Projects** overlay from the top bar, which is how a person gets from
a workspace back to the list.

The **Assistant drawer** is a fixed 392 px panel outside the workspace, so it opens over this
screen too and survives the flip into the workspace (issue #40).

### 1 · From scratch (build stages 0→8)
Viewer shows only the ground grid + triad, centred hint "No geometry yet …". Every tree group is
empty with one sentence + `+ add <thing>` (dashed cyan chip). Properties shows **New body**
(model name, display units, idealisation, size, position, name) with primary button **Add body**.
The blocker banner (see below) states the *next* missing thing; its mono link performs it.
Each Apply emits the Command(s) shown in "Will be recorded as", appends to Journal + Script,
selects the new object, and the viewer updates (column → corbel → mesh edges → pins → arrows).
Mechanical prototype order: frame+box → nib+union → name faces → material → mesh → constraint →
load → step → Solve. The thermal order and procedure-specific requirements follow below.

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
(clickable, underlined `#2c4a57`). Solve is disabled while a blocking warning or error applies.
The banner and top-bar Solve use the same requested Step (the first Step in run order) and its
`after` predecessors. Warnings on unrelated later Steps remain visible in the tree and Checks;
global warnings still apply. Engine error cards keep their structured cause, location and fix.

These are the current production warning meanings; the prototype's W-1001 “one box” and
W-1002 “no named faces” are not production readiness rules.

| Screen code | Meaning | Fix Command |
|---|---|---|
| W-1000 | No Body to analyse | `geometry.addBox` |
| W-1002 | Body dimensions disagree with idealisation | `model.setIdealisation` |
| W-1101 | Analysed Body has no assigned Material | `material.assign` |
| W-1102 | Line member has no Section | `section.assign` |
| W-1103 | Assigned Material lacks a property required by this Step | `material.add` |
| W-1200 | No mesh | `mesh.set` |
| W-1300 | Mechanical Step lacks active mechanical supports | `constraint.fix` |
| W-1301 | Steady heat Step lacks an active temperature reference | `constraint.temperature` |
| W-1400 | Step has no effective driving input | heat: `load.heatFlux`; mechanical: `load.pressure` |
| W-1500 | No Step | `step.add` |

### Thermal flow (production)

Use Body → Material → mesh → thermal boundary conditions → heat Step → Solve. A prescribed
nonzero temperature can drive the problem with `loads: []`; an empty Loads group is then `—`,
not a blocker. Defining a Constraint or Load only stores it: the Step must name it in its active
`constraints` or `loads` list. A mechanical fixed support does not fix temperature.

| State | Tree, banner and action |
|---|---|
| Material configured | Material rows show all configured properties. A thermal-only Material may omit `E` and `nu`. `heat-steady` needs `k`; `heat-transient` needs `k`, `rho` and `cp`. Properties needed by the Model’s procedures are bold; stored unused properties remain visible in faint text. |
| Conductivity missing | W-1103: `heat-transient Step 'transient' needs finite positive k; use material.add with k`, at `material 'slab'`. Solve is disabled; its fix opens `material.add`. A steady Step names `heat-steady` in the same cause. Transient density/capacity failures name `rho`/`cp`; they are not requests for elastic stiffness. |
| Reference missing | W-1301: `heat-steady needs a temperature reference in this Step; use constraint.temperature or load.convection on the analysed Body`. A prescribed temperature (including 0 K) or an anchoring positive convection film supplies the reference. This steady requirement is not imposed on an otherwise valid transient initial-value problem. |
| Driver missing | W-1400: `no heat load or nonzero prescribed temperature in this Step; use load.heatFlux or constraint.temperature`. A nonzero initial or inherited transient temperature can also drive evolution. |
| Steady ready | Step summary: `heat-steady · needs k · gives T, reaction power · 2 constraints · 0 loads`. A k-only bar with two different prescribed end temperatures can solve without density, heat capacity or mechanical properties. |
| Transient ready | Step summary: `heat-transient · needs k, ρ, cp · gives T, reaction power, stored-energy rate · 2 constraints · 0 loads`. Configure `dt`, `tEnd`, `theta`, initial temperature and output retention on this Step. |
| Solved | Solve reads `Solved · rev N`; the Step adds `· solved`. Results tree contains `T` with its temperature range. Open the bottom `results` tab for Extremes, Probe / Path, reaction power, thermal balance and transient history. |
| Stale | Editing the Model after the solve retains the old Result with stale status; the Results badge says `stale`, the header marks its producing revision, and Solve reads `Re-solve`. Selecting another retained frame is view state and does not append an engine Journal Command or stale the Result. |

The temperature field is labelled **T**, with **K** as the default unit. It colours the actual
undeformed mesh. Transient temperature uses a frame scrubber, displayed physical time and playback
speed; there is no displacement exaggeration slider. The legend subtitle is `transient · 32 s`
at the final T3 frame. The scrubber selects stored engine fields; it does not invent a sinusoidal
motion between output times. Probe values follow the selected frame.

Thermal Reactions are headed **Power W**, not three structural force components. The table shows
`Σ reactions`, `Σ applied` and, when supplied, `Storage rate`; the conservation label is
`Net applied = removed + storage`. Transient `History · transient` plots extrema at retained
output times. Temperature models do not acquire displacement/stress fields merely to populate
mechanical widgets.

Current UI limitation ([#573](https://github.com/andeplane/fem-lab/issues/573)): steady temperature
still shows the generic exaggeration/true-scale bar and `steady · true scale` legend subtitle;
the Results header also retains drawing-scale wording for thermal Results. Those controls/captions
do not imply a thermal displacement field. The intended scalar chrome should follow the transient
temperature treatment; the linked QA record reports the current screen faithfully.

#### Build the NAFEMS T3 bar from this handoff

The gallery card is **Transient heat in a bar (NAFEMS T3)**. Opening it prepares the Model;
press **Solve** to run it. To build the same model, use these Commands in the Script tab's editor
and press **Run script**, or enter each Command's arguments in its Properties form. Box faces
`bar.xmin`/`bar.xmax` are created automatically; no manual named-face step is needed.

```ts
await fem.model.new({ name: "bar-transient-heat" });
await fem.model.setUnits({ units: { length: "mm", time: "s" } });
await fem.geometry.addBox({ name: "bar", size: ["0.1 m", "5 mm", "5 mm"] });
await fem.material.add({ name: "slab", E: "210 GPa", nu: 0.3,
  rho: "7200 kg/m^3", k: "35 W/(m K)", cp: "440.5 J/(kg K)", source: "NAFEMS T3" });
await fem.material.assign({ material: "slab", bodies: ["bar"] });
await fem.mesh.set({ mesher: { kind: "lattice", size: { nx: 20, ny: 1, nz: 1 } } });
await fem.constraint.temperature({ name: "driven", on: "bar.xmax", value: "100 K" });
await fem.constraint.temperature({ name: "cold", on: "bar.xmin", value: "0 K" });
await fem.step.add({ name: "transient", procedure: "heat-transient",
  constraints: ["driven", "cold"], loads: [], output: ["temperature"],
  dt: "0.5 s", tEnd: "32 s", theta: 0.5, outputEvery: 16, initial: "0 K",
  amplitude: { kind: "sine", amplitude: 1, period: "80 s" } });
await fem.solve.run({ step: "transient" });
```

This matches the [bundled Journal](../../crates/engine/benches/journals/bar-transient-heat.json).
Its `E`/`nu` are retained legacy data and are unused by heat; an equivalent thermal-only Material
can omit them. The material tree shows `k 35 W/(m K)`, `cp 440.5 J/(kg K)` and `ρ 7200 kg/m^3`.
The mesh has 20 first-order Hex cells. The sine amplitude gives the driven face
`100 sin(πt/40)` and the other face stays zero; lateral faces are insulated by default.
There are 64 time increments and five retained frames: **0, 8, 16, 24, 32 s**.

In the `results` tab, enter **80 mm, 2.5 mm, 2.5 mm** in Probe / Path's `from` field and press
**probe**. At 32 s the display reads approximately **temperature 36.79 K** (the element number
is mesh-dependent). Home/End on the retained-frame slider select 0/32 s; the same probe reads
0 K at the initial frame. The comparison reference is **36.60**, with a 0.5 K absolute UI
comparison tolerance; the independent solver/convergence evidence lives in
[the Benchmarks](../BENCHMARKS.md).

The [NAFEMS P18 publication](https://www.nafems.org/publications/resource_center/p18/) defines T3;
[Coreform's published verification case](https://docs.coreform.com/cifa/latest/verification-manual/problems/heat_transfer/transient/nafems-p18-t3/nafems-p18-t3.html)
records its 0 °C initial/cold end and 36.60 °C reference at 32 s, 20 mm inside the driven end.
The bundled linear-conduction model uses **temperature rise from zero, expressed in K**.
A rise of 36.60 K matches that published 36.60 °C rise; converting the bundled probe to an
absolute Celsius temperature would misread the benchmark convention. Physical models should
use their intended absolute temperature quantities. See [ADR 0008](../adr/0008-si-inside-units-at-the-boundary.md).

The actual Chromium pass and its scope are recorded in
[UX-NOTES](../../packages/app/e2e/UX-NOTES.md#thermal-production-pass-issue-473).

---

## Components

### Top bar (46 px, `#101218`)
Logo block with right border · **project name**, an inline-editable mono 12.5 field
(`project.rename` on blur or Enter) · **saved chip**: `saved · 12:04` with a green dot,
`saving…` yellow while a write is in flight, or `not saved — storage is off` when
`file.autosave { on: false }`. There is no "unsaved" dot: the Journal is written into the open
project after every Command, so there is no unsaved state, and a dot that lies is worse than no
dot. Then ·
command-palette field (max 330 px, 28 px, bg `#0a0b0e`, border `#262a33`, placeholder
"Search commands or ask in plain words", `⌘K` key chip) · right cluster: units segmented
(mono 11, active `#22262e`/high) · undo/redo 26 px glyph buttons · engine chip (5 px green dot +
mono 10.5 "local GPU · 8 threads", border `#23262e`) · **Solve** button (28 px, 600, states above)
· text buttons Projects / Examples / Open / **Save** (`project.save`) / **Save as file**
(`file.save`) / Export / Report (12 px low, hover bg `#181b21`) · **Assistant** toggle
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
  exaggerated ×120" (or "true scale" at ×1), 16×132 px gradient bar, six mono ticks (top tick orange), divider, peak vs
  `f_cd C30/37 17.0`, three colour-map swatches (12 px, active outlined high).
- Bottom-right: **deformation bar**: ▶/❚❚ (mode/transient animation), "exaggeration", range
  0–max(400, the drawn scale) in a hundred steps (accent orange), mono `×120`, "true scale"
  (pressed at ×1), "screenshot".
- Bottom-left: probe readout (mono 11 low) — `σ_vM 12.40 MPa · node 1342 · x 0 y 412 z 1388 mm`
  in Results; face name + coordinates otherwise.
- Overlays: solving card, stale banner, error card, "No geometry yet" hint (all above).
Viewer canvas: z-up, ground grid `GridHelper(4000, 40, #232730, #171a20)` at z = −2, hemisphere +
two directional lights, geometry flat grey (0.58) with quad edges `#272b33`; mesh mode grey 0.46
with edges `#5b6472`; results vertex-coloured, edges hidden — except while the shape is drawn
exaggerated, where the edges (built from the undeformed positions and never moved) are kept as a
ghost outline `#4a5260` so the departure from the real body is visible; `view.toggle
{ layer: 'edges' }` still turns them off. Glyphs: constraint pins = 4-sided
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
- **Results**: a header across both columns saying a Result exists and what made it — "Result ·
  step static · linear-static · cpu-direct · 12 ms · solved at rev 10 · drawn exaggerated ×1000",
  in warn tones when it is stale — then two columns. Left: Extremes table (field · min · max · location; peak orange),
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
**Project** = one saved Model in this browser (issue #41 overrides the brief's avoid list);
**folder** = a directory on disk, over the File System Access API.

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
