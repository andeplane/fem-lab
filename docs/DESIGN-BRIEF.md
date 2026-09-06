# FEM Lab: design brief for the browser app

Everything a designer needs to design the FEM Lab web app, in one file. FEM Lab is a
finite-element analysis (FEA) editor and solver that runs entirely in the browser, where every
action a person can take is also a typed command a script or an AI can call. The engine (Rust,
WebGPU) is being built separately; this brief is about the app around it.

Contents: 1 the product · 2 the users · 3 the mental model the UI must teach · 4 the workflow
· 5 screen inventory (every panel, every control) · 6 the 3D viewer · 7 the AI · 8 states and
feedback · 9 rules the design must obey · 10 look and feel · 11 constraints · 12 what not to
design · 13 deliverables wanted · 14 vocabulary.

---

## 1. The product in one paragraph

An engineer describes a part (a box with a hole, a bracket, a cylinder), gives it a material,
holds some faces, pushes on others, meshes it, presses Solve and gets coloured stress and
deflection pictures, numbers, and a check against textbook theory. Today that needs Abaqus,
Ansys or COMSOL: desktop software, licences, a mesh of dialogs, no units, a journal file
nobody reads. FEM Lab does it in a browser tab on a static web page: no install, no server,
the laptop GPU does the maths. What makes it different: **everything is a Command** (so an AI
can do anything a person can), **the Journal is the model** (the click history *is* the file
and *is* a script), **units are first-class** ("2 MPa" is valid input; a pressure of "250 mm"
is an error), **verification is built in** (benchmarks with known answers ship in the app and
one click compares your model with theory), and **it says why before it fails** (unconstrained
part, missing material, bad element, reported before solving).

## 2. The users

| Persona | Typical model | Cares about | Design implication |
|---|---|---|---|
| **P1 Student** (first FEA course) | cantilever, plate with hole, L-bracket | understanding the numbers, matching a hand calculation, not fighting the tool | guided flow; plain-language errors; theory next to results; examples gallery |
| **P2 Practising engineer** | bracket, weld, pressure vessel, slab | trustworthy stresses and deflections, reactions, a report, repeatability | dense information, tables, units everywhere, reaction totals, report export |
| **P3 Researcher** | odd physics, custom material laws, parametric sweeps | every knob, scripting, export | script panel is a first-class surface, not hidden; plugins; raw data export |
| **P4 Teacher / demo author** | canonical benchmarks, live "what if" | a link that just runs, clear pictures, theory next to result | share link; examples open in one click; presentation-quality viewer |
| **P5 AI agent** (Claude, driven by any of the above) | whatever the human asked | a complete, typed, observable API; a way to look at the result | the chat panel shows exactly which Commands the AI ran; "show me what you did" as a Journal diff |

Desktop-first (laptop with trackpad or mouse; 13" to 27"). Tablet is not a target. Users
arrive with Abaqus/Ansys/COMSOL habits: a 3D viewport in the centre, a tree on the left,
properties on the right, a status bar below. Keep that shape; improve everything inside it.

## 3. The mental model the UI must teach

Three objects, one truth:

- **Model**: the complete description of one analysis (geometry, materials, mesh settings,
  constraints, loads, steps). One document.
- **Journal**: the ordered list of Commands that built the Model. Replaying it rebuilds the
  Model. Undo pops it. Exporting it yields a **Script**.
- **Result**: what a Step produced (displacements, stresses, temperatures, mode shapes), tied
  to the mesh and the Model revision it came from.

The Model, the Journal and the Script are the same information in three views. The UI should
make this visible: change a value in a form, and the corresponding line appears in the Journal
panel and in the script text at the same moment. This is the feature that makes the AI
trustworthy and the model reproducible, so it deserves prominence, not a hidden "macro
recorder".

Two kinds of state, and the UI must never blur them:
- **Model state** changes only through Commands and is recorded in the Journal.
- **View state** (camera, hover, which panel is open, contour colour map) is *not* in the
  Journal but is still Command-driven (so the AI can move the camera too); it just isn't part
  of the saved Model.

## 4. The workflow

The order every FEA engineer follows. The UI should read left-to-right or top-to-bottom in
this order, allow jumping back, and make "what is missing before I can solve" obvious at all
times.

1. **Frame**: name the model, choose units for display (mm/N/MPa or m/N/Pa), choose the
   idealisation (3D solid, 2D plane stress, plane strain, axisymmetric).
2. **Geometry**: add boxes, cylinders, extruded polygons; subtract holes; name faces
   ("top", "bolt_holes") by clicking or by rule ("all faces with normal +z").
3. **Material**: pick from a small library (S355 steel, 6061-T6 aluminium, C30/37 concrete,
   ABS, PLA) or type E, ν, ρ, α; assign to bodies.
4. **Mesh**: one global size (or element count), element type and order (linear/quadratic hex,
   tet, quad, tri), see node/element counts and a cost estimate before solving. A warning when
   the choice is known to be bad (linear tets are too stiff in bending).
5. **Constraints**: fix / roller / symmetry / prescribed displacement on named faces.
6. **Loads**: pressure, traction, total force on a face, gravity, temperature. Every load and
   constraint is drawn on the model with a glyph; the total applied force is shown.
7. **Steps**: static, modal (frequencies), steady or transient heat, explicit dynamics; chain
   them (thermal then structural).
8. **Solve**: progress (iteration, residual, time left), cancel; the UI stays responsive.
9. **Results**: contour plots on the deformed shape with a scale factor, legend with units,
   probe a point, path plot, min/max with location, reactions table (do they balance the
   loads?), mode-shape animation, section cut.
10. **Verify**: compare with theory (beam formula, Kirsch, Lamé), run a mesh-convergence
    study, see the benchmark reference values.
11. **Report and share**: Markdown/PDF report with assumptions, pictures, tables and the
    script as appendix; share link (the whole Model compressed into the URL); save/load file.
12. **Export**: one Export menu that covers the usual formats: mesh and results as VTU
    (ParaView), mesh as Gmsh `.msh` and Abaqus `.inp` (CalculiX), geometry as STL and (later)
    STEP, tables as CSV, pictures as PNG/SVG at set resolution, the Model as a Journal file or a
    TypeScript script, the report as Markdown/PDF. Each export names the format, what it
    contains and its size before writing.

The AI (§7) can drive any of these steps, and the person can take over at any step.

## 5. Screen inventory

One main screen, resizable panels, collapsible to a distraction-free viewer. Everything below
is a panel or a control; each control corresponds to exactly one Command (§9).

### 5.1 Top bar
- Model name (editable), unsaved indicator, units selector (display units), undo / redo.
- Global search / command palette (⌘K): type any Command name or natural language;
  results are Commands with their parameters.
- Solve button with state (disabled + reason when the model is not well-posed; progress ring
  when running; result age when stale after an edit).
- Share, Save, Open (file or project folder), Export (§4 step 12), Examples, Report,
  Settings (API key for AI, theme).
- Capability badges: WebGPU on/off, threads on/off, with a one-line reason when off ("Open in
  Chrome for GPU solving").

### 5.2 Left: Model tree (the outline)
Grouped by workflow order: Geometry (bodies, named faces), Materials, Mesh, Constraints,
Loads, Steps, Results, Plugins. Each item has: name, one-line summary (e.g. "pressure 2 MPa on
top"), warning/error badge, visibility eye, context menu (rename, duplicate, delete, "select in
viewer", "copy as script"). Drag to reorder where order matters (steps). Empty groups show a
"+ add" affordance and one sentence explaining what the group is.

### 5.3 Right: Properties (the form)
The form for the selected item, generated from the Command's schema: fields typed as
quantities ("2 MPa", "50 mm"), enums as segmented controls, set/face pickers as chips with a
"pick in viewer" button. Field-level validation (unit dimension mismatch, empty set, negative
modulus) shown inline in plain language with the fix. Applying emits one Command with final
values (dragging a slider emits once on release, not per pixel). A footer shows the exact
Command that will be recorded, as one line of script.

### 5.4 Centre: 3D viewer (§6)

### 5.5 Bottom: tabbed panel
- **Journal**: the list of Commands applied so far, most recent last, each showing name,
  parameters, time; click to select the object; hover highlights it in the viewer; undo stack
  boundary visible; toggle to view as **Script** (TypeScript text that reproduces the Model,
  live-updating); copy, download.
- **Script**: an editor (monospace, syntax highlight, line numbers) where a person or the AI
  writes and runs TypeScript against the API; run/stop; console output; errors with line
  numbers; "insert from Journal". Autocomplete from the typed API is a goal.
- **Results**: extremes table (field, min, max, location), reactions per constraint with the
  balance check ("Σ reactions = −Σ loads ✓ 0.0000 %"), probe/path tool output, frequencies
  table for modal, XY plots for transient/convergence.
- **Checks**: well-posedness (unconstrained bodies, missing material, empty sets, inverted
  elements), mesh quality (aspect ratio, Jacobian), cost estimate (DOF, memory, predicted
  time), assumption log (every default the solver used).
- **Console / log**: solver progress lines, warnings, errors with codes.

### 5.6 AI chat (right drawer or split, §7)

### 5.7 Examples gallery (modal or start page)
Cards for each worked example / benchmark: cantilever vs beam theory, plate with hole
(Kirsch), thick cylinder (Lamé), Cook's membrane, NAFEMS LE1/LE10, thermal fin, cantilever
frequencies. Each card: thumbnail, one sentence, reference value, "open". Opening loads the
Journal; a theory panel (KaTeX maths) sits next to the result.

### 5.8 Report view
Rendered Markdown: assumptions, geometry, materials, mesh and quality, loads with totals,
result tables, pictures (viewer screenshots at set resolution), benchmark comparison, Journal
as appendix. Print / export.

### 5.8b Onboarding, tutorials and examples
First-run onboarding and a tutorial system are part of the product, not a help page:
- **Guided tutorials**: step-by-step walkthroughs of simple models (a cantilever, a plate with
  a hole, a thermal bar), where each step names one Command, explains why, highlights the
  control that emits it, and lets the person either click it or press "do it for me". A step
  is complete when the Journal contains the expected Command; the tutorial reads the Journal,
  never a hidden flag. Progress is visible (step n of m), skippable, resumable.
- **Many examples**: the gallery (§5.7) holds every benchmark plus everyday models; each opens
  in one click, has a one-paragraph explanation, its reference value and a theory panel.
  Simpler examples have a tutorial variant ("build this yourself, step by step").
- **First-run tour**: on the first visit, a short overlay tour of the five regions (tree,
  viewer, properties, bottom panel, assistant), one sentence each, dismissable, with a
  "start the cantilever tutorial" button at the end.
- **Contextual help**: every panel header and every form field has a `?` that opens the
  relevant glossary entry or theory section; errors link to the fix.

### 5.9 Start / empty state
Lead with the chat box ("Describe the part…"), then **New project**, then **Recent projects**
kept in this browser, then "Open a file", "Examples" and "Tutorials". A one-line capability
check underneath, which also says where a project lives. (Issue #41 replaced the original four
cards; the design is `docs/design/README.md` state 0.)

## 6. The 3D viewer

- Orbit / pan / zoom with trackpad and mouse; view presets (iso, front, top, ...); fit; 
  perspective/orthographic; a small axis triad; grid at the model's scale with unit ticks.
- Display modes: geometry (shaded, edges), mesh (wireframe over shading), results (contour on
  deformed shape with a deformation scale factor slider and "true scale" button).
- Contour legend: colour bar with units, min/max, number of bands, colour map choice, clamp
  range; hover shows the value under the cursor.
- Selection and picking: hover highlights a face; click selects it; the UI proposes a
  *named face by rule* ("the face where z = 100 mm", "faces with normal +z") so the selection
  survives remeshing; multi-select with shift. Selection is a Command; the click never produces
  a bare node list.
- Glyphs: constraints (triangles/pins on faces), loads (arrows scaled to magnitude, pressure
  as arrow fields), gravity as a single arrow, named faces as tinted overlays; toggleable.
- Section cut: a clip plane with a handle; iso-surfaces later.
- Animation: mode shapes and transient results, play/pause/speed, frame scrubber.
- Screenshot at chosen resolution with legend and title burned in (for reports).
- Performance: must stay at 60 fps while a solve runs (engine is in a Worker); a 1 M-node mesh
  should still orbit smoothly.

## 7. The AI

An in-page assistant (Claude) whose tools are exactly the app's Commands plus "run a script".
Bring-your-own API key, stored locally, with a plain notice about cost.

- Chat panel: messages, streaming text, and *visible tool calls*: each Command the AI runs
  appears as a compact card (name, parameters) and simultaneously in the Journal; failures
  show the structured error the AI saw.
- "Show me what you did": a Journal diff since the conversation turn started, with a button to
  undo the whole turn as one unit.
- The AI's verification habit is a feature: after solving it checks reactions and compares
  with a hand estimate; the UI should give those checks a place (a "verification" card in the
  chat and the Checks tab).
- The person and the AI share one Model; either can act next. No "AI mode".
- Cost/time shown per turn. Settings: provider (Anthropic or OpenAI), model, API key and
  where it came from (typed in, or injected by the local dev server from the shell).
- **@-mentions**: typing `@` in the chat opens a picker over everything in the Model and the
  project: bodies, faces, sets, materials, constraints, loads, steps, results, Journal entries,
  project files. `@bracket.top` or `@result:static-1` inserts a chip; the AI receives the
  object's summary (a Query result), so "make @top thicker" or "why is @vonMises high near
  @hole" need no further explanation. Three more ways to point: `@selection` (or a short
  alias the design chooses) inserts whatever is currently selected in the viewer or tree, and
  stays live until sent; clicking an object in the viewer while the chat input is focused
  inserts its chip; and a selected object can be copied with ⌘C (from the viewer or the tree)
  and pasted into the chat as a chip (the clipboard carries a plain-text form such as
  `@face:bracket.top`, so the paste also works in any other text field). Chips are also drag
  targets from the model tree and the viewer.
- **Images in**: the chat accepts images by paste, drag-and-drop or a file button: a hand
  drawing of a geometry, a photo of a sketch or a hand calculation, a screenshot of a drawing
  or a table from a report, a plot to compare with. The image shows as a thumbnail chip in the
  composer (removable, with a caption field) and in the sent message; the model receives it as
  an image block next to the text, so "build this" with a drawing produces geometry Commands,
  and "does my hand calc agree?" with a photo produces a comparison. Several images per
  message; the viewer screenshot can be attached with one click ("attach current view").
  Images are kept with the conversation, never in the Journal.
- **Skills**: reusable instruction packs the AI can invoke, shown as a `/` menu in the chat
  (built-in: "verify against beam theory", "mesh convergence study", "write report", "NAFEMS
  benchmark"; user skills come from the project folder). A skill card shows name, one-line
  description and what it will do before it runs.
- **Project folder and AGENTS.md**: a Model can live in a project folder on disk (Chromium
  File System Access API). If the folder contains `AGENTS.md` (or `CLAUDE.md`), the AI reads
  it as standing instructions for that project (company material limits, report template,
  units, naming rules), and `skills/*/SKILL.md` become skills. The chat shows a small
  "following AGENTS.md" badge with a click-through to the file; a project panel lists the
  folder's files (Journal, scripts, plugins, exports) and lets the AI read and write them.

The success story to design for: a student opens a link, types "a 1 m steel cantilever,
50×100 mm, 10 kN at the tip, quadratic hexes, compare the tip deflection with beam theory",
watches the Model build, mesh, solve, plot and report a 0.4 % difference with a convergence
table, then opens the script the AI wrote, changes the load and reruns.

## 8. States and feedback

- **Well-posedness before solving**: the Solve button is disabled with the reason and a fix
  ("Body 'bracket' has no material → assign one") rather than failing afterwards.
- **Solving**: progress with iteration/residual/time remaining, cancel; viewer still usable.
- **Stale results**: after any Model edit, results dim and a "re-solve" affordance appears;
  the Journal shows where the result was produced.
- **Errors** are structured everywhere: a code, one-line cause, where (which object), and a
  suggested Command. The same text the AI sees. Never a stack trace to the user.
- **Warnings that teach**: "Linear tetrahedra are too stiff in bending; expect ~30 % error
  here. Use quadratic." shown at the mesh step, with a "switch" button.
- **Capability notices**: no WebGPU → "Solving on CPU; open in Chrome for GPU"; not
  cross-origin isolated → "Running single-threaded; reload to enable threads".
- **Units**: every number displays with its unit in the chosen display system; inputs accept
  any unit of the right dimension and echo back the normalised value.

## 9. Rules the design must obey

1. **Every control maps to exactly one Command.** If a designed control cannot be expressed as
   "run Command X with parameters Y", it is either view state (also a Command, but not saved)
   or it must be redesigned. Interactive gestures (drag, slider) emit one Command with the
   final value.
2. **The Journal and the Script are always one click away** and update live. They are the
   model's audit trail and the AI's transcript.
3. **Selection produces rules, not node lists.** Clicking a face should offer "name this face
   by rule" so loads survive remeshing.
4. **Units on every number**, chosen system, no bare values in any form.
5. **Verification is visible**: reaction balance, benchmark comparison and mesh convergence
   have permanent homes, not buried menus.
6. **Same UI, local or remote engine**: nothing in the design may assume the solver is in the
   same tab (a later paid backend swaps the transport). A subtle "engine: local GPU / remote"
   indicator is enough.
7. **Plain language before jargon**: Fix, not Encastre; Pressure, not DLOAD; a tooltip can
   carry the Abaqus/Ansys equivalent for users coming from there.
8. **Keyboard-complete**: command palette, undo/redo, view presets, focus order; the AI uses
   the same Commands, so a person should be able to too.

## 10. Look and feel

- Serious engineering tool, quiet and dense, not a consumer app. Dark theme default (viewer
  contours read better on dark), light theme available. The owner's other demos use a dark
  near-black background (#0a0b0e to #14161b), soft grey text (#c8cdd4, #e7e9ec), a warm
  orange accent (#e2703a, #f0824b) and a cool cyan secondary (#58b7d6); monospace for numbers
  and code (CSS var `--mono`), a humanist sans for UI text. Continuity with those is welcome
  but not required.
- Numbers are the content: tabular figures, right-aligned in tables, units in a lighter
  weight, 3–4 significant digits by default with full precision on hover/copy.
- Contour colour maps: perceptually uniform default (viridis-like) plus the classic
  rainbow engineers expect, with a discrete-band option; colour-blind safe default.
- Icons: minimal line icons; glyphs for constraints/loads should follow textbook conventions
  (triangles for supports, arrows for forces, a distributed arrow field for pressure).
- Motion: only functional (panel open/close, solve progress, mode animation).

## 11. Constraints

- Web app on a static site (GitHub Pages), no server; the solver runs in the tab (WebGPU via
  wasm) inside a Web Worker. Chromium is the supported browser; others get a notice.
- Rendering via a WebGL/WebGPU 3D library (Babylon.js or three.js; decision pending). Assume
  vertex-coloured meshes, wireframe overlays, arrows/glyphs, clip planes and screenshots are
  available; assume no fancy post-processing.
- Model sizes up to ~1 M nodes in the browser; the UI must scale lists (virtualised trees,
  no per-node UI).
- Landing bundle should be small; heavy pieces (viewer, meshers, Python) load lazily, so the
  start screen must work before they arrive.
- Accessibility: keyboard navigation, focus states, contrast AA, no information carried by
  colour alone (contours always have a legend and probe values).

## 12. What not to design

- No CAD sketcher with fillets/chamfers in v1 (boxes, cylinders, extruded polygons, booleans
  only). No assembly/contact UI. No topology optimisation. No multi-user/collaboration. No
  mobile layout.

## 13. Deliverables wanted from the design

1. Information architecture and panel layout (default, results-focused, viewer-only).
2. The main screen in the key states: empty, geometry, meshed with a warning, solving, results
   with legend and reactions, stale result, error.
3. Properties form patterns: quantity field, enum, face/set picker, validation message.
4. Journal ↔ Script panel and the "AI did this" diff.
5. AI chat with visible tool calls, a verification card, the `@` mention picker, the `/`
   skills menu, image attachments (chips in the composer and the message) and the AGENTS.md
   badge.
6. Examples gallery card and the theory-next-to-result view.
6b. Tutorial mode: the step panel, the highlighted control, "do it for me", progress; the
   first-run tour.
7. Viewer chrome: legend, deformation scale, glyph toggles, clip plane, animation bar.
8. Command palette.
8b. Export dialog and project-folder panel.
9. Colour/type tokens for dark and light themes.

## 14. Vocabulary (use these words in the UI)

Model, Geometry, Body, Face, Set, Mesh, Element, Material, Constraint (not "BC"), Load,
Step, Result, Command, Query, Journal, Script, Mesher, Solver, Plugin, Benchmark, Convergence
study. Avoid: part file, BC, job, deck, macro, history, backend.

**Project** was on the avoid list until issue #41; it is now vocabulary, and it means exactly one
thing: **one saved Model in this browser** — its Journal and its metadata, in IndexedDB, listed
by `query.projects` and opened by `project.open`. A directory on disk is a **folder**
(`folder.open`, `query.folder`), never a project.
