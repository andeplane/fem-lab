# Benchmark catalogue

Every case below has a known answer: closed form, a published NAFEMS/MacNeal–Harder value, or
a manufactured solution with a known convergence rate. Together they are the engine's test
suite for physics: each is a script against the engine's Command API (so the suite also proves
the engine is scriptable and headless), each runs in CI in the Node host, and each is one
click away in the browser app as an example with its theory. A case that only passes at one
mesh size is not a Benchmark; every case with a rate carries a convergence study.

Values and sources are from research note 04 §5 unless stated. Items marked **resolve** have
conflicting published values and must be settled before the number is hard-coded.

The **Status** column has three states. `engine test` means a Rust test in
`crates/engine/tests/` asserts it; `green` means the Command-level form in
`crates/engine/benches/cases/*.json` passes under `femlab bench`, which is what makes a row a
Benchmark in the sense of PLAN rule 8; blank means not implemented yet.

## A. Element-level (phase 1)

| # | Case | Reference | Tolerance | Proves | Status |
|---|---|---|---|---|---|
| A1 | Patch tests, all six constant-strain modes, hex8/hex20/tet4/tet10/quad4/quad8/tri3/tri6 | exact constant stress | 1e-10 rel | conforming, complete elements | engine test |
| A2 | Rigid-body modes of a single element (3 translations, 3 rotations) | zero internal force | 1e-12 | no spurious stiffness | engine test |
| A3 | Eigenvalues of a single hex8 stiffness matrix | 6 zeros, 18 positive | 1e-9 | K symmetric PSD (also a fast-check property over random element shapes) | engine test |
| A4 | Symmetry of the assembled operator, `⟨Ku,v⟩ = ⟨u,Kv⟩` for random u,v | 0 | 1e-12 (f64), f32 rounding (GPU) | assembly and GPU operator agree with themselves | engine test (f64) |
| A5 | Uniaxial bar under end force | σ = F/A, δ = FL/EA | 1e-8 | loads, constraints, stress recovery | engine test |
| A6 | Free thermal expansion of a block | ε = αΔT, σ = 0 | 1e-10 | thermal strain path | engine test |
| A7 | Reaction balance, every case | Σ reactions = −Σ applied loads | 1e-9 rel | Dirichlet handling and reaction recovery | engine test + green |
| A8 | Journal replay, every case | Model hash identical after replay | exact | the engine is deterministic and scriptable | engine test |

A5 is run for all eight element kinds, driven by a prescribed end displacement so the reaction
*is* `F`; A7's scale is the largest force that flows through the model, because a Step driven by
a displacement or a temperature has no applied total to be relative to. A6 covers hex8, hex20, a
plane-stress sheet and an axisymmetric ring. A8's numerics half is
`a_step_result_is_bit_identical_at_one_and_many_threads`, which asserts every field of a
`StepResult` bit for bit at one thread and at `max(2, available_parallelism())`, faer's parallel
`LLᵀ` included.

## B. Beams and locking (phase 1–2)

| # | Case | Reference | Tolerance | Proves | Status |
|---|---|---|---|---|---|
| B1 | Cantilever, tip force, Euler–Bernoulli + Timoshenko shear correction | δ = PL³/3EI + PL/κGA = 0.1919619 mm | hex20 within 1 %; hex8 with incompatible modes within 2 %; full integration recorded | bending; full-integration hex8 shows shear locking, the improved hex8 does not | green |
| B2 | MacNeal–Harder straight cantilever, in-plane shear, regular / trapezoidal / parallelogram meshes | 0.1081 in (regular) | quad8/hex20 ≤ 1 %; quad4/hex8 error recorded and shown, not gated | mesh-distortion sensitivity | |
| B3 | MacNeal–Harder twisted beam (90° twist, 12 elements) | 0.005424 in (in-plane), 0.001754 in (out-of-plane) — **verify against the paper** | 2 % | warped elements | |
| B4 | Cantilever modal, first three bending modes | β_nL = 1.8751, 4.6941, 7.8548 → f_n = (β_n²/2π)·√(EI/ρAL⁴) | 1.5 % (mode 1), 3 % (mode 3, Timoshenko drift) | mass matrix, eigen solver | |
| B5 | Euler column buckling, pinned–pinned | P_cr = π²EI/L² | 1 % (hex20) | linear buckling (phase 6) | |
| B6 | Large-deflection cantilever, end moment / end force (Bathe) | closed-form elastica curves | 1 % | NLGEOM Newton loop (phase 6) | |

B1 runs as three cases at a 25 mm lattice on a 1 m × 100 mm × 100 mm steel beam under a 1 kN
tip traction with the root fully fixed: `cantilever-hex8-im` (0.1901125 mm, 0.96 % below the
formula), `cantilever-hex20` (0.1904070 mm, 0.81 %) and `cantilever-hex8-full` (0.1837801 mm,
4.26 %, recorded not gated). Two things are worth knowing before reading those numbers.

**The last 0.7 % is the formula, not the mesh.** Refining hex20 to 12.5 mm moves the answer only
from 0.1904070 to 0.1905657 mm. A fully clamped three-dimensional root holds the cross-section
flat and stops it contracting, which Timoshenko theory does not, and that makes the solid about
0.7 % stiffer than the formula. The hex20 gate is therefore 1 %, not the plan's 0.5 %, which this
fixture cannot meet for a reason that is physics rather than error.

**The locking ratio needs a coarse mesh to be dramatic.** At 25 mm there are four elements through
the depth and full integration is 4.4× worse than incompatible modes; at 50 mm it is 9.8× and at
100 mm 24×. `the_fully_integrated_hexahedron_locks` in `tests/registry.rs` asserts the > 5× ratio
at 50 mm.

## C. Two-dimensional and axisymmetric (phase 3)

| # | Case | Reference | Tolerance | Proves |
|---|---|---|---|---|
| C1 | Kirsch plate with a hole, plane stress | K_t = 3.00 (infinite plate); 3.018 for the Ansys VM142 finite geometry | 2 % at p=2 with refinement | stress concentration, local refinement, symmetry (quarter model equals full) |
| C2 | Lamé thick cylinder, plane strain and 3D | u_r(a) = 5.90e-5 m, σθθ(a) = 100 MPa, σrr(a) = −60 MPa (SimScale/SSLV04 data) | 1 % disp, 2 % stress at p=2 | axisymmetric and 3D agree |
| C3 | Near-incompressible cylinder, ν = 0.49, 0.499, 0.4999 | regenerated from Lamé | monotone; < 2 % for a locking-free element | volumetric locking exposed and fixed (B-bar / mixed) |
| C4 | Cook's membrane | 21.520 (ν = 1/3, arXiv 1806.07500) vs 23.9 (plane-stress classic) — **resolve** | 1 % at fine mesh + Richardson extrapolation | bending-dominated distorted mesh |
| C5 | NAFEMS LE1 elliptic membrane, plane stress | σyy(D) = 92.7 MPa | 2 % (p=2), 5 % (p=1) | curved boundaries, pressure load |
| C6 | NAFEMS FV32 cantilevered tapered membrane, modal | 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz | 1 % | 2D eigen |
| C7 | NAFEMS T4 steady conduction + convection | T(E) = 18.3 °C (converged 18.25) | 0.5 °C | convection BC |
| C8 | NAFEMS T1 membrane with hot spot | σyy(D) = 50.0 MPa | 2 % | thermal → structural coupling |

## D. Three-dimensional solids (phase 2–3)

| # | Case | Reference | Tolerance | Proves |
|---|---|---|---|---|
| D1 | NAFEMS LE10 thick plate under pressure | σyy(D) = −5.38 MPa | 2 % (hex20/tet10); hex8 error (~−29 %) recorded and shown as the element-order lesson | 3D solid benchmark |
| D2 | NAFEMS LE11 solid cylinder/taper/sphere, thermal stress | σzz(A) = −105 MPa | 3 % | thermal stress in 3D / axisymmetric |
| D3 | NAFEMS FV52 simply-supported solid plate, modal | 45.897, 109.44, 109.44, 167.89, 193.59, 206.19 Hz (Ansys) vs Abaqus row 44.092, 106.66, … — **resolve** | 3 % | 3D eigen |
| D4 | Manufactured solution, elasticity and Poisson, hex/tet p=1,2 | prescribed u(x); L2 rate p+1, H1 rate p | rate ± 0.1 | convergence machinery, body loads |
| D5 | 1M-DOF cantilever, hex8, static (`#[ignore]`, run by hand) and its CI sibling at 66k DOF (`[50,20,20]`) | same as B1 at that size | CI sibling **green**: `‖u_gpu − u_direct‖ ≤ 1e-8 ‖u‖` after 8 refinement steps at a 4.8e-10 relative residual, 4.3 s on an M4 Max against 1.5 s for `cpu-direct`. The 780 300-DOF run is **unresolved**: Jacobi-scaled f32 CG does not converge at κ ≈ 1e8 (residual grows to 1.5e4, `solve.stalled` → `cpu-direct`), so it prints its outcome and is not gated until a stronger preconditioner lands (PLAN 2.2). Times are never asserted on software adapters | GPU PCG + iterative refinement at scale |

## E. Heat transfer (phase 2)

| # | Case | Reference | Tolerance | Proves |
|---|---|---|---|---|
| E1 | 1D bar, fixed temperatures | linear profile | 1e-10 | conduction |
| E2 | Ansys VM97 fin, conduction + convection | tip 416 °F | 1 % | convection with analytical fin solution |
| E3 | NAFEMS T3 1D transient, sinusoidal boundary | T(x = 0.08 m, t = 32 s) = 36.60 °C | 0.5 °C | transient integrator |
| E4 | NAFEMS T2 conduction + radiation | T(B) = 927 K | 1 % | radiation BC (if/when added) |

## F. Dynamics and explicit (phase 2, 6)

| # | Case | Reference | Tolerance | Proves |
|---|---|---|---|---|
| F1 | Linear momentum conservation, free body, 2000 explicit steps | Δp = 0 | 1e-6 | explicit integrator symmetry (Blast Wall's test) |
| F2 | Critical time step | 0.9 Δt_crit stable, 1.25 Δt_crit diverges | as stated | Δt estimator really is critical |
| F3 | SDOF and cantilever transient under step load | closed form | 1 % | Newmark/HHT (phase 6) |
| F4 | Two-block tie / bonded contact patch test | continuous stress across the tie | 1e-8 | constraints between bodies (phase 6) |

## G. Shells and plates (phase 8)

| # | Case | Reference | Tolerance |
|---|---|---|---|
| G1 | Simply-supported square plate, uniform load | w_max = 0.00406 qa⁴/D | 1 % |
| G2 | Scordelis–Lo roof | 0.3024 (midside vertical displacement) | 2 % |
| G3 | NAFEMS LE3 hemispherical shell, point loads | u_x(A) = 0.185 m | 2 % |
| G4 | NAFEMS LE2 cylindrical shell patch | 60 MPa | 2 % |
| G5 | NAFEMS LE5 Z-section cantilever | −108 MPa | 3 % |
| G6 | NAFEMS FV12 free thin square plate, modal | 1.622, 2.360, 2.922, 4.233, 4.233, 7.416, 7.416 Hz | 1 % |
| G7 | Pinched cylinder / hemisphere (MacNeal–Harder) | 1.8248e-5 / 0.0924 — **verify against the paper** | 2 % |

## H. Plugins (phase P)

| # | Case | Reference | Proves |
|---|---|---|---|
| H1 | Built-in linear elastic law re-implemented as a TS Plugin | identical to built-in, 1e-12 | Extension Point parity |
| H2 | J2 plasticity as TS, WGSL and wasm (C and Fortran-via-f2c) Plugins | identical to built-in J2 to 1e-12 (TS/wasm) and f32 rounding (WGSL) | three languages, one law |
| H3 | Plugin hash mismatch on load | refused with message | reproducibility |

## I. Cross-solver checks (phase 3, manual, documented)

| # | Case | Method |
|---|---|---|
| I1 | Export B1, C5, D1 as Abaqus `.inp`, run in CalculiX, compare nodal displacements | within 1e-6 relative for identical mesh and element type; documented run, not CI |

## Where the reference values are published

- NAFEMS "The Standard NAFEMS Benchmarks" P18 (1990); FV set in R0015 (1987). Values as
  printed in the public Abaqus 2017 Benchmarks Guide mirror and cross-checked against the
  Ansys VM manual, SimScale validation cases and COMSOL models (note 04 §5.1 has the URLs).
- MacNeal & Harder, "A proposed standard set of problems to test finite element accuracy",
  FEAD 1 (1985). Only 0.1081, the twisted beam and Scordelis–Lo were verified this session.
- Kirsch (1898), Lamé, Euler–Bernoulli, Timoshenko: any strength-of-materials text.
- Cook's membrane: Cook (1974); converged values in arXiv 1806.07500.
- deal.II step-7 for the manufactured-solution methodology.
