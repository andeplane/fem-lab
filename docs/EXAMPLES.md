# Example catalogue

Every Model in this catalogue lives as a Journal fixture in `crates/engine/benches/journals/`,
each with a sidecar `<name>.meta.json` (title, tag, one-sentence explanation, reference value,
theory snippet, and — where one exists — the guided tutorial that builds it step by step).
`tools/copy-examples.mjs` folds the two into `packages/app/public/examples/index.json`, which the
Examples gallery (DESIGN-BRIEF §5.7) and the Start screen's "Open an example" both read.

Every entry stops before `solve.run`: the solver is not merged in this build, so the Journal ends
at a well-posed, ready-to-solve Model rather than a computed Result. `crates/femlab/tests/cli.rs`
replays every one of them against a committed `.hashes` file on every CI run
(`every_bundled_journal_replays_green_against_its_committed_hashes`), and
`packages/app/test/tutorial-fixtures.test.ts` does the same through the wasm build used in the
browser.

Tags: **P1 · verify** (a hand-checkable textbook case), **NAFEMS** (a published Standard
Benchmark or a well-known named case, cross-referenced in `docs/BENCHMARKS.md`), **everyday** (a
model an engineer would actually build, with no literature reference to check against).

## P1 · verify

| Example | Sentence | Reference | Tutorial |
|---|---|---|---|
| `cantilever` | A steel cantilever under a tip load — the first model to build, and the standard check against beam theory. | δ = PL³/3EI ≈ 0.667 mm | [cantilever](../packages/app/tutorials/cantilever.json) |
| `cantilever-hex20` | The same cantilever at quadratic order (hex20) — bending accuracy from one lattice mesh setting. | δ = PL³/3EI ≈ 0.667 mm | [cantilever](../packages/app/tutorials/cantilever.json) |

## NAFEMS and named benchmarks

Reference values and sources for these are also tabulated in `docs/BENCHMARKS.md` (rows C1, C2,
C4, C5, D1, B2).

| Example | Sentence | Reference | Source |
|---|---|---|---|
| `kirsch-quarter-plate` | A quarter-symmetry model of a plate with a circular hole, two graded mapped blocks meeting at the hole. | Kt = σxx(0,a)/σ → 3.00 (infinite plate); 3.018 for the finite VM142 geometry | Kirsch (1898); BENCHMARKS.md C1 |
| `lame-cylinder-plane-strain` | A thick-walled cylinder under internal pressure, modelled as a plane-strain quarter section. | σθθ(a) = 100 MPa, σrr(a) = −60 MPa | Lamé closed form; BENCHMARKS.md C2 |
| `cook-membrane` | The classic tapered, shear-loaded panel used to test bending accuracy in a distorted mesh. | u_y at the tip ≈ 23.9 (plane stress, ν = 1/3) — both idealisations reported, see BENCHMARKS.md #16 | Cook (1974); arXiv 1806.07500; BENCHMARKS.md C4 |
| `nafems-le1-membrane` | An elliptical plate with an elliptical hole under outward pressure — the standard curved-boundary benchmark. | σyy(D) = 92.7 MPa | NAFEMS Standard Benchmark LE1; BENCHMARKS.md C5 |
| `nafems-le10-plate` | LE1's elliptic membrane extruded into a 3D plate under uniform pressure — a 3D solid benchmark. | σyy(D) = −5.38 MPa | NAFEMS Standard Benchmark LE10; BENCHMARKS.md D1 |
| `macneal-harder-beam` | A short cantilever meshed as six regular quad elements — the classic shear-locking sensitivity check. | tip deflection 0.1081 in (regular mesh) | MacNeal & Harder (1985); BENCHMARKS.md B2 |

## Everyday models

No published reference value — these are the ordinary parts an engineer actually builds, meant
to show the Commands in a realistic setting rather than to check the solver.

| Example | Sentence | Tutorial |
|---|---|---|
| `bracket-L` | Two boxes unioned into an L-shaped bracket, wall-mounted and end-loaded — `geometry.add`'s union in one model. | — |
| `plate-with-hole-2d` | A plane-stress plate with a circular hole in tension, free-meshed with local refinement around the hole. | [plate-with-hole](../packages/app/tutorials/plate-with-hole.json) |
| `tube-under-pressure` | A pipe wall revolved a full turn and loaded with internal pressure — `geometry.add`'s revolve shape. | — |
| `bolt-flange` | A circular flange with a central bore and a six-bolt hole pattern, seated under a uniform preload pressure. | — |
| `slab-strip` | A one-way reinforced-concrete slab strip, pinned and rollered at its ends, under a uniform floor load. | — |
| `heated-fin` | An aluminium fin fixed at its root and uniformly heated — thermal strain with no mechanical load at all. | [thermal-bar](../packages/app/tutorials/thermal-bar.json) |
| `simply-supported-beam` | A beam pinned at one end and rollered at the other, under a uniform downward pressure — the textbook counterpart to the cantilever. | — |
| `column-under-gravity` | A standing column loaded only by its own self-weight — `load.gravity` on a single fixed-base body. | — |

## Guided tutorials

A tutorial (PLAN.md 5.10) walks the same kind of Model one Command at a time, with a why for
each step and "do it for me" as a fallback. `packages/app/src/tutorial/` is the runner and panel;
`packages/app/tutorials/*.json` are the built-ins:

| Tutorial | Minutes | Builds | Closing theory |
|---|---|---|---|
| `cantilever` | 6 | The nine Commands of `cantilever.json`, from `model.new` to `step.add`. | δ = PL³/3EI |
| `plate-with-hole` | 8 | A plane-stress plate with a circular hole, free-meshed (the everyday variant of `plate-with-hole-2d`). | The Kirsch factor, Kt = 3 |
| `thermal-bar` | 5 | A fixed aluminium bar heated uniformly, no mechanical load (the same Commands as `heated-fin.json`). | Thermal strain, ε = αΔT |
| `read-a-result` | 4 | Nothing — five explanation-only steps over the Results and Checks panels, for a Model you have already solved. | — |

Every tutorial's `doIt` sequence is validated two ways: `packages/app/test/tutorial-fixtures.test.ts`
replays it through the wasm build in Node, and it is, by construction, the same Command sequence
as an already-verified example Journal (`cantilever`, `plate-with-hole-2d` and `heated-fin`
respectively) — so a tutorial can never drift from a Model the CLI has also checked.
