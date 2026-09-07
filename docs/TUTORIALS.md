# Guided tutorials

A tutorial (PLAN.md 5.10) is **data, not code**: a JSON file in `packages/app/tutorials/`.
Adding one is adding a file and one import; nothing in `packages/app/src/tutorial/` changes.
The runner watches `query.journal` and advances a step when the Command it is waiting for
appears — whether the person clicked it, typed it in a script, or asked the Assistant — so a
tutorial teaches the app rather than a scripted click-path.

Progress is an **index into the Journal**, not a `seq`: the engine hands out `seq` again
whenever it rewrites the Journal (`model.new`, `journal.undo`, `file.restore`), so a watermark
kept across a rewrite stranded the step for good (#87). The index is seeded from the Journal's
length when the tutorial starts, which is also what stops a Model you already built from
satisfying the steps of a tutorial you are only now beginning.

## The built-ins

| Tutorial | Min | Builds | Closing theory |
|---|---|---|---|
| [`cantilever`](../packages/app/tutorials/cantilever.json) | 6 | The nine Commands of the `cantilever` example, from `model.new` to `step.add`. | δ = PL³/3EI = 0.1905 mm |
| [`plate-with-hole`](../packages/app/tutorials/plate-with-hole.json) | 8 | A plane-stress plate with a circular hole, free-meshed (the everyday variant of `plate-with-hole-2d`). | The Kirsch factor, Kt = 3 |
| [`thermal-bar`](../packages/app/tutorials/thermal-bar.json) | 5 | A fixed aluminium bar heated uniformly, no mechanical load (the same Commands as `heated-fin`). | Thermal strain, ε = αΔT |
| [`read-a-result`](../packages/app/tutorials/read-a-result.json) | 4 | Nothing — five explanation-only steps over the Results and Checks panels, for a Model you have already solved. | — |
| [`heat-conduction`](../packages/app/tutorials/heat-conduction.json) | 8 | A bar held at two temperatures, solved, then re-solved with a convection face. What a boundary condition *is*, Fourier's law, and reading a scalar field. | Fourier, Dirichlet vs Newton cooling, and why an unnamed face is insulated |
| [`modal-analysis`](../packages/app/tutorials/modal-analysis.json) | 7 | The `cantilever-modal` example: a rectangular-section cantilever, four modes. | fₙ = (βₙ²/2π)√(EI/ρAL⁴); why consistent mass converges from above; degenerate pairs |
| [`transient-heat`](../packages/app/tutorials/transient-heat.json) | 9 | NAFEMS T3 twice: once with Crank–Nicolson, once with backward Euler at the same Δt. | The θ-method, order vs damping, and why Crank–Nicolson rings |
| [`mesh-convergence`](../packages/app/tutorials/mesh-convergence.json) | 7 | The cantilever plus one `study.converge` over three sizes. | Observed rate p, Richardson extrapolation, and when to stop |
| [`symmetry-and-2d`](../packages/app/tutorials/symmetry-and-2d.json) | 9 | The `kirsch-quarter-plate` example: plane stress, two symmetry planes, mapped blocks on the hole. | Kirsch's field, plane stress vs plane strain, what symmetry costs you |
| [`journal-as-program`](../packages/app/tutorials/journal-as-program.json) | 8 | The `cantilever` example again, then exported, edited and replayed as a script instead of clicked. | L³ scaling of a doubled beam, and the CLI `--verify` check against the committed fixture |
| [`thermal-stress-chaining`](../packages/app/tutorials/thermal-stress-chaining.json) | 14 | `step.add.after`: a heat Step's temperature field consumed as the next Step's load (the `thermal-stress-plate` example), plus the same model with one edge genuinely free and one wrongly given a symmetry constraint. | σₓₓ = −EαΔT/(1−ν) = −150 MPa at −0.00 % error, and why the same number can be real physics or a restraint artefact |
| [`pressure-vessel`](../packages/app/tutorials/pressure-vessel.json) | 10 | A thick cylinder revolved into an axisymmetric slice instead of meshed as a 3D solid (the `lame-cylinder-axisymmetric` example). | Lamé's σθθ(a) = 100 MPa, σrr(a) = −60 MPa against the pr/t thin-wall shortcut, which breaks at this vessel's t/a = 1 |
| [`composite-block-shear`](../packages/app/tutorials/composite-block-shear.json) | 12 | A steel-faced, aluminium-cored sandwich panel in pure shear: `geometry.subtract` for the cavity, a second Body for the core, `constraint.prescribe` for the shear, `contact.add` to bond the two. | The Reuss/Voigt series and parallel bounds, and why a finite specimen falls just outside them |
| [`solve-cost-and-solvers`](../packages/app/tutorials/solve-cost-and-solvers.json) | 8 | The cantilever at two mesh sizes, `query.cost` before each solve, `cpu-direct` and `cpu-pcg` forced on the same model. | The auto solver threshold (200 000 / 100 000 dofs), and `solve.stalled` on issue #3's 780 300-dof case |

The first four are the phase-1 set. The rest each own one procedure, one idealisation or one
piece of method that the Commands alone do not explain.

## The file format

`packages/app/src/tutorial/types.ts` is the contract; this is what the fields mean in practice.

```jsonc
{
  "id": "heat-conduction",          // must equal the filename without .json
  "title": "Heat conduction in a bar",
  "minutes": 8,                     // honest estimate, shown on the card
  "summary": "…",                   // one sentence, on the card
  "steps": [ /* … */ ]
}
```

A step:

```jsonc
{
  "title": "Hold the cold end",
  "explain": "…",                   // the why. Markdown-lite: plain text with `code` spans.
  "expect": {                       // what advances the step, watched in query.journal
    "cmd": "constraint.temperature",
    "match": { "name": "cold" }     // optional; only the listed fields are compared (===)
  },
  "highlight": "constraint.temperature",  // a data-cmd value, or a raw CSS selector
  "doIt": {                         // what "do it for me" dispatches
    "cmd": "constraint.temperature", "name": "cold", "on": "bar.xmin", "value": "0 degC"
  }
}
```

- **`fields`** overrides the values the card lists and the form offers as placeholders. Omit
  it. They are derived from `doIt` minus `cmd`, so the card can never disagree with the button
  beside it, and the nine bundled files need no edit; set it only when the derived list reads
  badly (a Command with a dozen arguments where three are the point).
- **`expect: null`** makes a read-only step: Next always advances it. Use it for the closing
  theory and for steps that ask the reader to look at something rather than do something.
- **`theory`** is a KaTeX-ready block, `$…$` inline and `$$…$$` display, on the closing step. It
  is where the tutorial earns its keep: the Commands are discoverable, the physics is not.
- **`doIt` may include `solve.run`.** It used to be forbidden because the solver was not merged;
  it now is, so every tutorial that builds a Model ends by solving it and reading the answer.
- **Omit `doIt`** on a read-only step. Omit `highlight` when no single control emits the
  Command.

## What `highlight` resolves to

A step does not only name its Command — it points at the control that runs it, spotlights that
control and puts the card beside it. `src/tutorial/target.ts` walks these rungs in order and
takes the first that is on screen:

1. **`.props [data-field="<key>"]`**, one per key of the step's values — but only while the
   Properties form is already open on the step's own Command. This is the "now fill it in" rung,
   and it is the *only* one allowed to point inside the Properties panel.
2. **`[data-cmd="<highlight>"]`** — a control that dispatches the Command itself: Solve, the
   units segmented, the start screen's cards, a tree row that re-runs its Command.
3. **`[data-opens="<highlight>"]`** — a control that fills the form with it. `Cmd` writes this
   attribute whenever it dispatches `form.open` with a `command`, which covers the tree's
   `+ add …` chips, every tree row and the blocker banner's fix links in one place.
4. **the raw string**, for a `highlight` that is a CSS selector rather than a Command id
   (`[title="panel.toggle results"]`). A selector that does not parse is a miss, not an error.
5. **`.palette-field`** — the ⌘K field, with the card reading "nothing on screen runs
   `material.assign` yet — press ⌘K, type it and press ↵".

Rungs 2–5 skip `aside.props` deliberately: the form's **Revert** button is `form.open` with the
very Command the step is about, so without that skip the spotlight would land on Revert.

Nine of the twenty `highlight` values across the bundled tutorials take rung 5 today —
`material.assign`, `load.traction`, `constraint.temperature`, `constraint.symmetry`,
`load.temperature`, `load.convection`, `study.converge`, `model.setIdealisation` and
`geometry.add`. That is honest rather than a gap to paper over: it teaches the palette, which
runs every Command whether or not it has a button. Issue #43 gives most of them a control.

A read-only step that names no `highlight` points at nothing at all, and the card stays docked:
it is asking the reader to look, not to press.

## The rules a new tutorial has to keep

`packages/app/test/tutorial-fixtures.test.ts` enforces all of these:

1. Every `tutorials/*.json` is registered in `src/tutorial/tutorials.ts`, and nothing else is.
2. Every file parses into the shape of `types.ts`.
3. Every tutorial that builds a Model has a step with a `theory` block.
4. **Every tutorial's `doIt` sequence, replayed in order through the wasm engine, actually
   runs.** This is the one that matters: a tutorial cannot teach a Command sequence the engine
   would refuse. It runs the real solves, in the same build the browser loads.

Beyond the test, two conventions worth keeping:

- **Prefer a sequence an example Journal already checks.** Seven of the nine tutorials are the
  Command list of a bundled example, so the CLI's `--verify` run and `docs/EXAMPLES.md`'s table
  are also a check on the tutorial's numbers. When you quote a value in `explain`, quote the one
  the example computes, not the one the formula gives — and say what the gap is.
- **One idea per step.** If `explain` needs two paragraphs to cover two things, it is two steps.

## Where the runner is mounted

`packages/app/src/tutorial/index.ts` documents the one-line mount; nothing in the tutorial
module reaches into `src/ui/**` or `src/ai/**`.
