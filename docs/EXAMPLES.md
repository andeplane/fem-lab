# Example catalogue

Every Model in this catalogue lives as a Journal fixture in `crates/engine/benches/journals/`,
each with a sidecar `<name>.meta.json` (title, tag and keywords, one-sentence explanation, the
expected value with its reference, a KaTeX theory snippet, a difficulty and — where one exists —
the guided tutorial that builds it step by step). `tools/copy-examples.mjs` folds the two into
`packages/app/public/examples/index.json`, sorted by difficulty then name, which the Examples
gallery (DESIGN-BRIEF §5.7) and the Start screen's "Open an example" both read.

CI and the Pages deploy build the app once, replay each Journal through its real Mesh Commands
in Chromium, and capture the viewer canvas at 320×180 before the final build. Solve and study
Commands are omitted from this image pass, so the cards show the actual model shape without
pretending to show a Result; the expected-value metadata beside each image carries the physics.
The PNGs total less than 200 kB and are lazy-loaded only after the gallery opens.

**Every entry ends on `solve.run`.** Opening an example therefore shows a solved Result, not a
ready-to-solve Model: the fastest path from a blank page to a contour plot is one click.
`crates/femlab/tests/cli.rs` replays every one of them with `--verify` — solves included — on
every CI run (`every_bundled_journal_replays_green_against_its_committed_hashes`), and no example
takes more than about a second in a release build; `packages/app/test/tutorial-fixtures.test.ts` replays the same
Journals through the wasm build used in the browser, with `--skip-solves`, since a solve entry's
hash is the Model hash and is unaffected by the Result.

Tags: **P1 · verify** (a hand-checkable textbook case), **NAFEMS** (a published Standard
Benchmark or a well-known named case, cross-referenced in `docs/BENCHMARKS.md`), **everyday** (a
model an engineer would actually build, with no literature reference to check against).
Difficulty is 1 (a first model), 2 (a real workflow) or 3 (needs the theory to read the answer).

## The numbers, checked

Every reference-bearing example, its published or closed-form reference, and what the bundled
Journal actually computes. Solve times are `femlab run <journal> --verify --cpu` on one laptop
core in a release build; all 27 together take a couple of seconds on an idle machine.

Native tests use Cargo's level-1 test profile: debug assertions remain enabled, while sparse
assembly and factorisation get enough optimisation for this full-catalogue check. The CPU and
GPU coverage lanes explicitly restore level 0 because optimised inlining makes source-region
counts unreliable. Reproduce the source-accurate CPU gate with
`CARGO_PROFILE_TEST_OPT_LEVEL=0 cargo llvm-cov -p femlab-engine -p femlab-geometry
--ignore-filename-regex 'src/gpu/' --fail-under-lines 100 --fail-under-functions 100
--fail-under-regions 100`. A paired warm-binary measurement on one Apple M4 Max core replayed
the then-22 Journals, including every solve and hash comparison, in 170.86 s at level 0 and
9.12 s at level 1. Those execution times exclude compilation and do not predict a CI runner's
total job time; runner load, compiler cache state and host hardware all affect wall time.

A bundled example that is bigger than the picture it draws still wastes verification time. Keep
them around 20 000 degrees of freedom at the very most — the largest here are
`plate-with-hole-2d` (19 396) and `slab-strip` (19 215), and the three building-structures
examples added for issue #440 cost 36, 3 480 and 5 805 dofs — and prefer a mesh that shows the physics
to one that resolves it, since `docs/BENCHMARKS.md` owns the resolved answers.

| Example | Quantity | Reference | Computed | Error | Solve |
|---|---|---|---|---|---|
| `cantilever` | tip deflection δ | 0.1905 mm (PL³/3EI) | 0.19011 mm | −0.19 % | 0.04 s |
| `cantilever-hex20` | tip deflection δ | 0.1905 mm (PL³/3EI) | 0.18994 mm | −0.28 % | 0.03 s |
| `cantilever-modal` | f₁ … f₄ | 20.96 / 41.91 / 131.32 / 262.66 Hz (Euler–Bernoulli) | 21.06 / 42.01 / 131.67 / 260.33 Hz | +0.50 / +0.23 / +0.27 / −0.89 % | 0.22 s |
| `free-free-beam-modal` | f₁ … f₈ | 0×6, 133.3, 266.7 Hz (rigid modes, then free-free Euler–Bernoulli) | ~0×6 (≤ 0.0012 Hz), 133.1, 264.4 Hz | −0.18 / −0.87 % on the two real modes | 0.24 s |
| `mesh-convergence-cantilever` | Richardson estimate of δ | 0.1905 mm (PL³/3EI) | 0.19073 mm | +0.13 % | 0.23 s |
| `heated-fin-convection` | tip temperature | 37.39 °C (1D fin, adiabatic tip) | 37.41 °C | +0.03 % | 0.03 s |
| `bar-transient-heat` | T 20 mm inside the driven face, t = 32 s | 36.60 (NAFEMS T3) | 36.79 | +0.53 % | 0.04 s |
| `thermal-stress-plate` | σₓₓ at mid-height | −150 MPa (−EαΔT/(1−ν)) | −150.00 MPa | −0.00 % | 0.03 s |
| `explicit-free-fall` | u_z after 1 ms | −4.905 µm (gt²/2) | −4.915 µm | +0.20 % | 0.03 s |
| `kirsch-quarter-plate` | σₓₓ at the hole edge | 300 MPa (Kirsch, Kₜ = 3) | 302.19 MPa | +0.73 % | 0.07 s |
| `lame-cylinder-plane-strain` | σ_rr at the bore | −60 MPa (Lamé, = −p) | −59.65 MPa | −0.58 % | 0.02 s |
| `lame-cylinder-axisymmetric` | σ_θθ at the bore | 100 MPa (Lamé) | 99.59 MPa | −0.41 % | — |
| `cook-membrane` | tip u_y | 23.9 (Cook 1974, plane stress) | 23.93 | +0.14 % | 0.02 s |
| `nafems-le1-membrane` | σ_yy at D | 92.7 MPa (NAFEMS LE1) | 92.16 MPa | −0.58 % | 0.02 s |
| `nafems-le10-plate` | σ_yy at D, upper surface | −5.25 MPa (ESRD full-face LE10 variant) | −5.234 MPa | −0.30 % | — |
| `macneal-harder-beam` | tip deflection | 0.1081 (MacNeal & Harder 1985) | 0.10733 | −0.71 % | 0.02 s |
| `steel-roof-truss` | mid-span bottom-chord δ | 7.0427 mm (unit-load virtual work) | 7.04266 mm | −0.00 % | 0.02 s |
| `steel-roof-truss` | diagonal U2–L3 axial stress | 10.731 MPa (method of sections, N = 10√2 kN) | 10.7308 MPa | −0.00 % | — |
| `column-buckling` | P_cr | 11 054 kN (π²EI/L², K = 1) | 10 912 kN (λ = 272.81 × 40 kN) | −1.28 % | 0.08 s |
| `concrete-floor-slab` | mid-span δ | 7.617 mm (5wL⁴/384EI + wL²/8GA_s) | 7.5922 mm | −0.33 % | 0.04 s |

The everyday models have no published reference, so their `expected` sidecar names the hand
estimate to sanity-check against instead: `bracket-L` 15.7 MPa peak von Mises (at a singular
re-entrant corner — the number rises with refinement and should not be reported),
`plate-with-hole-2d` 104.5 MPa (≈ 3σ, raised by the finite width), `tube-under-pressure`
86.2 MPa (against pr/t = 76 MPa away from the restrained base), `bolt-flange` 7.23 MPa (a load
path, not a stress: the lattice puts two or three elements across a bolt hole),
`slab-strip` 1.55 MPa (against 6M/bh² with M = wL²/8), `simply-supported-beam` 0.773 MPa,
`column-under-gravity` 0.0782 MPa (against ρgL), `heated-fin` 160.2 MPa.

## P1 · verify

| Example | Diff | Sentence | Reference | Tutorial |
|---|---|---|---|---|
| `cantilever` | 1 | A steel cantilever under a tip load — the first model to build, and the standard check against beam theory. | δ = PL³/3EI = 0.1905 mm | [cantilever](../packages/app/tutorials/cantilever.json) |
| `cantilever-hex20` | 1 | The same cantilever at quadratic order (hex20) — bending accuracy from one lattice mesh setting. | δ = PL³/3EI = 0.1905 mm | [cantilever](../packages/app/tutorials/cantilever.json) |
| `cantilever-modal` | 2 | A clamped-free steel beam with a rectangular section — four bending frequencies from one modal Step, two in each plane. | fₙ = (βₙ²/2π)·√(EI/ρAL⁴) | [modal-analysis](../packages/app/tutorials/modal-analysis.json) |
| `free-free-beam-modal` | 3 | The same rectangular-section beam as `cantilever-modal`, this time with no constraints at all — six zero-frequency rigid-body modes, then the beam's own bending frequencies. | Free-free fₙ = (βₙ²/2π)·√(EI/ρAL⁴), β₁ = 4.730041 | [free-free-modal](../packages/app/tutorials/free-free-modal.json) |
| `mesh-convergence-cantilever` | 2 | The cantilever solved at three mesh sizes by `study.converge`, with the observed rate and a Richardson estimate of the converged value. | δ = PL³/3EI = 0.1905 mm | [mesh-convergence](../packages/app/tutorials/mesh-convergence.json) |
| `heated-fin-convection` | 2 | An aluminium fin held at its root temperature and cooled by air on all four long faces — steady conduction against the 1D fin formula. | θ/θ_b = cosh m(L−x) / cosh mL | [heat-conduction](../packages/app/tutorials/heat-conduction.json) |
| `thermal-stress-plate` | 3 | A heat Step conducts a linear temperature field through a plate, and a static Step named after it picks that field up as thermal stress. | σₓₓ = −EαΔT/(1−ν) = −150 MPa | [thermal-stress-chaining](../packages/app/tutorials/thermal-stress-chaining.json) |
| `explicit-free-fall` | 3 | An unconstrained block under gravity, integrated by central differences — explicit dynamics checked against a schoolbook drop. | u = gt²/2 = 4.905 µm at 1 ms | — |
| `steel-roof-truss` | 2 | A 12 m parallel-chord Pratt roof truss in CHS 88.9 × 5 S355, pinned one end and rollered the other, 20 kN at each top-chord joint. | δ = Σ N n L / EA = 7.0427 mm | [steel-roof-truss](../packages/app/tutorials/steel-roof-truss.json) |
| `column-buckling` | 3 | A 200 × 200 mm S355 column, 5 m between pins, modelled as its lower half with a symmetry plane at mid-height. | P_cr = π²EI/(KL)² = 11 054 kN | [column-buckling](../packages/app/tutorials/column-buckling.json) |
| `concrete-floor-slab` | 2 | A 6 m one-way C30/37 floor strip on knife-edge bearings under self-weight plus a 5 kN/m² imposed load. | δ = 5wL⁴/384EI + wL²/8GA_s = 7.617 mm | [concrete-floor-slab](../packages/app/tutorials/concrete-floor-slab.json) |

## NAFEMS and named benchmarks

Reference values and sources for these are also tabulated in `docs/BENCHMARKS.md` (rows C1, C2,
C4, C5, D1, B2, E3). `kirsch-quarter-plate`, `nafems-le10-plate` and `macneal-harder-beam` use
the same mesh and units as the Benchmark case that verifies them, so the gallery card's number
is the one the example computes.

| Example | Diff | Sentence | Reference | Source |
|---|---|---|---|---|
| `kirsch-quarter-plate` | 3 | A quarter-symmetry model of a plate with a circular hole, two graded mapped blocks meeting at the hole. | Kt = σxx(0,a)/σ → 3.00 | Kirsch (1898); BENCHMARKS.md C1; [symmetry-and-2d](../packages/app/tutorials/symmetry-and-2d.json) |
| `lame-cylinder-plane-strain` | 3 | A thick-walled cylinder under internal pressure, modelled as a plane-strain quarter section. | σθθ(a) = 100 MPa, σrr(a) = −60 MPa | Lamé closed form; BENCHMARKS.md C2 |
| `lame-cylinder-axisymmetric` | 3 | The same cylinder, this time revolved into an axisymmetric slice instead of meshed as a flat quarter section. | σθθ(a) = 100 MPa, σrr(a) = −60 MPa | Lamé closed form; BENCHMARKS.md C2; [pressure-vessel](../packages/app/tutorials/pressure-vessel.json) |
| `cook-membrane` | 2 | The classic tapered, shear-loaded panel used to test bending accuracy in a distorted mesh. | u_y at the tip ≈ 23.9 (plane stress, ν = 1/3) | Cook (1974); BENCHMARKS.md C4 |
| `nafems-le1-membrane` | 3 | An elliptical plate with an elliptical hole under outward pressure — the standard curved-boundary benchmark. | σyy(D) = 92.7 MPa | NAFEMS Standard Benchmark LE1; BENCHMARKS.md C5 |
| `nafems-le10-plate` | 3 | Elliptic thick plate with the whole outer face held; ESRD's variant of LE10. | σyy(D) = −5.25 MPa | ESRD StressCheck Benchmarks Guide pp. 29–31; BENCHMARKS.md D1 (#183) |
| `macneal-harder-beam` | 2 | A short cantilever meshed as six regular quad elements — the classic shear-locking sensitivity check. | tip deflection 0.1081 (regular mesh) | MacNeal & Harder (1985); BENCHMARKS.md B2 |
| `bar-transient-heat` | 3 | A bar driven by a sinusoidal surface temperature and held at zero at the other end — the θ-method marching in time. | 36.60 at x = 80 mm, t = 32 s | NAFEMS T3; BENCHMARKS.md E3; [transient-heat](../packages/app/tutorials/transient-heat.json) |

## Everyday models

No published reference — these are the ordinary parts an engineer actually builds, meant to show
the Commands in a realistic setting rather than to check the solver. They still solve, and their
sidecar names the hand estimate to compare against.

| Example | Diff | Sentence | Tutorial |
|---|---|---|---|
| `bracket-L` | 1 | Two boxes unioned into an L-shaped bracket, wall-mounted and end-loaded — `geometry.add`'s union in one model. | — |
| `heated-fin` | 1 | An aluminium fin fixed at its root and uniformly heated — thermal strain with no mechanical load at all. | [thermal-bar](../packages/app/tutorials/thermal-bar.json) |
| `slab-strip` | 1 | A one-way reinforced-concrete slab strip, pinned and rollered at its ends, under a uniform floor load. | — |
| `simply-supported-beam` | 1 | A beam pinned at one end and rollered at the other, under a uniform downward pressure — the textbook counterpart to the cantilever. | — |
| `column-under-gravity` | 1 | A standing column loaded only by its own self-weight — `load.gravity` on a single fixed-base body. | — |
| `plate-with-hole-2d` | 2 | A plane-stress plate with a circular hole in tension, free-meshed with local refinement around the hole. | [plate-with-hole](../packages/app/tutorials/plate-with-hole.json) |
| `tube-under-pressure` | 2 | A pipe wall meshed as a revolved section and loaded with internal pressure — the sweep mesher's revolve in one model. | — |
| `bolt-flange` | 2 | A circular flange with a central bore and a six-bolt hole pattern, seated under a uniform preload pressure. | — |

## Four models that never actually solved

Adding `solve.run` to the bundled Journals turned up four that built a well-formed Model and then
failed the moment a solver looked at it — the mesh and the Sets are only realised at solve time,
so a Journal that stops at `step.add` cannot see any of this. All four are fixed; they are
recorded here because each is a mistake worth recognising.

- **`bolt-flange`** — `set.empty`: the lattice mesher stair-steps a CSG solid, so the Body's own
  `flange.bottom` and `flange.top` face Sets had no faces on the mesh. Fixed by naming the seat
  and crown with `geometry.nameFace` plane predicates, which resolve against the mesh itself.
- **`tube-under-pressure`** — the same `set.empty`, for the same reason on a revolved solid.
  Fixed by meshing it properly: a `sweep` of a mapped section, revolved 360°, which carries the
  section's edge tags onto the solid.
- **`lame-cylinder-plane-strain`** — `mesh.inverted`: the block's inner arc was written
  `ccw: true` where the verified Benchmark case has `ccw: false`, folding element 0.
- **`plate-with-hole-2d`** — the hole's sketch repeated a point instead of closing on four
  quarter arcs, and the free mesher **panicked** rather than returning an error. The sketch is
  fixed; the panic is an engine robustness bug for whoever owns `crates/geometry` (a malformed
  sketch should be a structured `Error`, not an abort).

## Guided tutorials

`docs/TUTORIALS.md` is the index and the file format. In short: a tutorial (PLAN.md 5.10) walks
the same kind of Model one Command at a time, with a why for each step and "do it for me" as a
fallback; `packages/app/src/tutorial/` is the runner and panel, `packages/app/tutorials/*.json`
are the built-ins.

Every tutorial's `doIt` sequence is validated by `packages/app/test/tutorial-fixtures.test.ts`,
which replays it through the wasm build in Node — the same engine the browser gets. Where a
tutorial shadows an example (`cantilever`, `plate-with-hole-2d`, `heated-fin`,
`cantilever-modal`, `bar-transient-heat`, `mesh-convergence-cantilever`,
`kirsch-quarter-plate`, `free-free-beam-modal`, `steel-roof-truss`, `column-buckling`,
`concrete-floor-slab`), it is by construction the same Command sequence
the CLI has also checked, so a tutorial can never drift from a Model with a known answer.
