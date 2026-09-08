# Tutorial coverage: what other FEA products teach, and whether FEM Lab can do it

86 real, currently-live tutorials, example problems and benchmark cases from eleven other FEA
products and libraries, each checked one by one against the Commands in
`packages/registry/src/generated/engine.schema.json`. Every URL was fetched and confirmed to
load and to be that tutorial; nothing here is reconstructed from memory.

The point of the exercise is §2: **every distinct capability that blocks a tutorial becomes one
issue**, ranked by how many of the 86 need it. §3 is the other side of the same coin — the ten
tutorials FEM Lab could ship as its own today, because nothing is missing.

**What FEM Lab has** (the baseline every row is judged against): solids from box / cylinder /
sphere / extruded or revolved sketch with CSG union and subtract; lattice, mapped, free (2D
triangle) and sweep meshers; hex8 / hex20 / quad4 / quad8 / tri3 / tri6 (tet4 is engine-only, no
Command reaches it); `solid3d`, `planeStress`, `planeStrain`, `axisymmetric`; isotropic linear
elastic material only; `constraint.fix` / `prescribe` / `symmetry` / `temperature`;
`load.pressure` / `traction` / `force` / `gravity` / `temperature` / `convection` / `heatFlux` /
`heatSource`; procedures `static`, `modal`, `heat-steady`, `heat-transient` (θ-method with a
sine or table amplitude), `explicit` (linear central differences); `step.add.after` for
heat → structural chaining; `study.converge`; VTU / msh / inp / STL / report export.

**What it does not have**, which is what §2 enumerates: contact of any kind, plasticity,
hyperelasticity, geometric nonlinearity, buckling, harmonic response, random vibration, implicit
transient dynamics, shells, beams, trusses, point masses, bolt pretension, submodelling,
fatigue, composites, radiation, CAD import, and 3D free tet meshing from a Command.

Status is one of **can do** (nothing missing; the Commands are named), **partial** (the physics
is reachable but something the tutorial does is not) and **cannot** (a named capability is
absent).

---

## 1. The 86 tutorials

### Abaqus / Dassault SIMULIA

Verified against two live academic mirrors of the Abaqus documentation (University of Colorado
Boulder's `ceae-server`, Virginia Tech's `docs.software.vt.edu`); `help.3ds.com` requires a
login.

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 1 | [Appendix B: Creating and Analyzing a Simple Model in Abaqus/CAE](https://ceae-server.colorado.edu/v2016/books/gsa/ap02.html) (*Getting Started with Abaqus*) | 3D solid cantilever, linear elastic, surface pressure, fixed face, stress and displacement plots | **can do** — `model.new` → `geometry.addBox` → `material.add`/`assign` → `mesh.set{lattice}` → `constraint.fix` → `load.pressure` → `step.add{static}` → `solve.run` |
| 2 | [4.4 Mesh convergence](https://ceae-server.colorado.edu/v2016/books/gsa/ch04s04.html) (connecting lug) | Lug with a hole, stress concentration, four refined meshes, convergence of peak stress | **partial** — the plane-stress version is `mesh.set{free}` + `study.converge`; the 3D lug needs 3D free tet meshing and a filleted CAD shape |
| 3 | [10.4 Example: Connecting Lug with Plasticity](https://ceae-server.colorado.edu/v2016/books/gsa/ch10s04.html) | Same lug, elastic-plastic material, hardening data, nonlinear static | **cannot** — no plasticity, no 3D tet meshing, no CAD geometry |
| 4 | [12.11 Abaqus/Explicit example: circuit board drop test](https://ceae-server.colorado.edu/v2016/books/gsa/ch12s11.html) | Explicit dynamics, shell board, point masses, crushable foam plasticity, general contact with friction, initial velocity | **cannot** — no shells, no point masses, no contact, no plasticity, no initial-velocity condition |
| 5 | [Vibrational frequencies analysis](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEGSARefMap/simagsa-c-stppipingsysexa.htm) (piping system) | Beam elements, frequency extraction, effect of axial preload on modal frequencies | **cannot** — no beam elements, no prestressed (stress-stiffened) modal |
| 6 | [Buckling of a column with general contact](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEBMKRefMap/simabmk-c-sscxsec.htm) | Shell X-section column, eigenvalue buckling, general contact collapse, elastic-perfectly-plastic, imperfection seeding | **cannot** — no shells, no buckling, no contact, no plasticity |
| 7 | [Shell-to-solid submodeling and shell-to-solid coupling of a pipe joint](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEEXARefMap/simaexa-c-shellsolidpipe.htm) | Shell global model, solid local submodel, submodel boundary driven by the global result, shell-solid coupling | **cannot** — no shells, no submodelling |
| 8 | [Axisymmetric stress/displacement submodeling with twist](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEVERRefMap/simaver-c-submodelaxitwist.htm) | Axisymmetric solids with a twist DOF, pressure + torsion in two steps, submodelling | **cannot** — no submodelling, no twist DOF in the axisymmetric idealisation |
| 9 | [Thermal-stress analysis of a reactor pressure vessel bolted closure](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEEXARefMap/simaexa-c-reactor.htm) | Bolt pretension (40 studs), contact at the closure, internal pressure, sequential transient thermal-stress, cyclic-symmetry sector | **cannot** — no bolt pretension, no contact, no cyclic symmetry, no CAD/tet meshing |
| 10 | [LE6: Skew plate under normal pressure](https://ceae-server.colorado.edu/v2016/books/bmk/ch04s02anf06.html) (NAFEMS, Abaqus Benchmarks Guide) | Shell elements, skewed plate, uniform pressure, 2×2 / 4×4 / 8×8 convergence | **partial** — the skew geometry meshes as a `mapped` block swept by `sweep{extrude}`, and `study.converge` does the refinement, but the benchmark's reference is a shell result and there are no shells |
| 11 | [Beam/gap example](https://ceae-server.colorado.edu/v2016/books/bmk/ch01s01ach01.html) (Abaqus Benchmarks Guide) | Cubic beam elements, three cantilevers, five gap elements opening and closing | **cannot** — no beam elements, no gap/contact elements |
| 12 | [FV4: Cantilever with off-center point masses](https://ceae-server.colorado.edu/v2016/books/bmk/ch04s04anf17.html) (NAFEMS) | Beam elements, eccentric point masses, first six eigenmodes | **cannot** — no beam elements, no point masses |
| 13 | [The Hertz contact problem](https://ceae-server.colorado.edu/v2016/books/bmk/ch01s01ach11.html) (Abaqus Benchmarks Guide) | Two cylinders, frictionless finite-sliding contact, quarter symmetry, contact pressure vs the Hertz solution | **cannot** — no contact |
| 14 | [Conductive, convective, and radiative heat transfer in an exhaust manifold](https://ceae-server.colorado.edu/v2016/books/exa/ch05s01aex121.html) | Steady conduction, surface film convection, cavity radiation, nonlinear iteration | **partial** — conduction, convection and radiation to a surrounding are `step.add{heat-steady}` + `load.convection` + `load.radiation`; the tutorial's *cavity* radiation (surface-to-surface view factors) and the CAD manifold are missing |
| 15 | [Geometrically nonlinear analysis of a cantilever beam](https://ceae-server.colorado.edu/v2016/books/bmk/ch02s01ach139.html) | Large displacement and rotation, transverse and end-moment loading, Bisshopp–Drucker exact solution | **cannot** — no geometric nonlinearity, no moment loads |

### Siemens Simcenter Femap / Nastran

Applied CAx is a Siemens partner publishing the Femap seminar tutorials.

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 16 | [Linear Contact Analysis](https://www.appliedcax.com/resources/simcenter-femap-nastran/linear-contact-analysis/) | Connection regions on solids and plates, source/target pairing, linear contact in an assembly | **cannot** — no contact |
| 17 | [Principles of Vibration Analysis: Normal Modes to PSD to Direct Transient](https://www.appliedcax.com/resources/simcenter-femap-nastran/principles-of-vibration-analysis-normal-modes-to-psd-to-direct-transient/) | Normal modes, modal frequency response, PSD random vibration, direct transient | **partial** — `step.add{modal}` covers the normal modes; harmonic response, PSD and implicit transient dynamics are missing |
| 18 | [Linear and Nonlinear Buckling Workshop](https://www.appliedcax.com/resources/simcenter-femap-nastran/simcenter-femap-workshop-linear-and-nonlinear-buckling/) | Eigenvalue buckling with stress stiffening, nonlinear post-yield buckling | **cannot** — no buckling, no geometric nonlinearity, no plasticity |
| 19 | [Thermal-Stress Analysis](https://www.appliedcax.com/resources/simcenter-femap-nastran/thermal-stress-analysis/) | Steady conduction, thermal expansion into a structural solve, temperature BCs | **can do** — `step.add{heat-steady}` → `step.add{static, after: <heat step>}`, exactly the `thermal-stress-plate` example |
| 20 | [FEA of Bolted Joints – User Guide Seminar](https://www.appliedcax.com/resources/simcenter-femap-nastran/fea-of-bolted-joints-user-guide-seminar/) | Bolt/connector elements, preload, beam-force post-processing, fatigue-relevant preload comparison | **cannot** — no bolt pretension, no beam/connector elements, no fatigue |

### Ansys Mechanical (Cornell SimCafe, Ansys Innovation Space, APDL Verification Manual)

Ansys Innovation Space is mid-migration: individual lesson URLs redirect, only `/product/<slug>/`
landing pages render. Cornell SimCafe lives under the Confluence space key `SIMULATION`.

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 21 | [ANSYS – Plate With a Hole](https://confluence.cornell.edu/spaces/SIMULATION/pages/127118376/ANSYS+-+Plate+With+a+Hole) | Plane stress, hole stress concentration, symmetry BCs, mesh convergence, Kirsch verification | **can do** — `model.setIdealisation{planeStress}` → `mesh.set{mapped}` → `constraint.symmetry` ×2 → `load.pressure` → `static`; ships as `kirsch-quarter-plate` |
| 22 | [ANSYS – Pressure Vessel](https://confluence.cornell.edu/spaces/SIMULATION/pages/216399972/ANSYS+-+Pressure+Vessel) | Axisymmetric elements, internal pressure, hoop and radial stress vs thick/thin-wall theory | **can do** — `model.setIdealisation{axisymmetric}` → `mesh.set{mapped}` → `constraint.symmetry` → `load.pressure` → `static` |
| 23 | [ANSYS – Spacecraft Assembly](https://confluence.cornell.edu/spaces/SIMULATION/pages/326381474/ANSYS+-+Spacecraft+Assembly) | Multi-part assembly, frictional/separating contact, bolt pretension, NLGEOM, temperature-dependent material | **cannot** — no contact, no bolt pretension, no geometric nonlinearity, no temperature-dependent properties |
| 24 | [VM11 – Residual Stress Problem](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM11.html) (Ansys APDL Verification Manual) | LINK180 truss elements, bilinear elastic-plastic, load/unload cycle, residual stress | **cannot** — no truss elements, no plasticity, no structural load stepping |
| 25 | [VM17 – Snap-Through Buckling of a Hinged Shell](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM17.html) | Finite-strain shells, NLGEOM, arc-length method, post-buckling snap-through | **cannot** — no shells, no geometric nonlinearity, no arc-length solver |
| 26 | [ANSYS – Linear Column Buckling](https://confluence.cornell.edu/spaces/SIMULATION/pages/151193699/ANSYS+-+Linear+Column+Buckling) | Eigenvalue buckling, pinned-pinned column, critical load factor vs Euler | **cannot** — no buckling procedure (BENCHMARKS B5 is waiting on it) |
| 27 | [Harmonic Response Analysis in Ansys Mechanical](https://innovationspace.ansys.com/product/harmonic-response-analysis-in-ansys-mechanical/) | Frequency-domain forced response, resonance, mode superposition or full harmonic, damping | **cannot** — no harmonic procedure, no damping model |
| 28 | [VM19 – Random Vibration Analysis of a Deep Simply-Supported Beam](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM19.html) | PSD excitation, modal + spectrum analysis, BEAM188, 1σ displacement and stress | **cannot** — no random-vibration procedure, no beam elements |
| 29 | [VM65 – Transient Response of a Ball Impacting a Flexible Surface](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_VM65.html) | Full transient time integration, nonlinear contact, impact, initial velocity | **cannot** — no implicit dynamics, no contact, no initial-velocity condition |
| 30 | [Understanding Topics in Ansys LS-DYNA Software – Part 1](https://innovationspace.ansys.com/product/understanding-topics-in-ansys-ls-dyna-software-part-1/) | Explicit time integration, solver setup for short high-rate events | **partial** — `step.add{explicit}` integrates by central differences, but only linear elastic and with no contact |
| 31 | [ANSYS – 2D Steady Conduction](https://confluence.cornell.edu/spaces/SIMULATION/pages/146918507/ANSYS+-+2D+Steady+Conduction) | Steady conduction, prescribed temperature and flux BCs, 2D thermal solids, analytical check | **can do** — a 2D idealisation + `mesh.set{mapped}` → `constraint.temperature` / `load.heatFlux` → `step.add{heat-steady}` |
| 32 | [ANSYS – Transient Conduction](https://confluence.cornell.edu/spaces/SIMULATION/pages/175474931/ANSYS+-+Transient+Conduction) | Transient thermal, time stepping, initial temperature, convective BC, temperature history | **can do** — `step.add{heat-transient, dt, tEnd, theta, initial}` + `load.convection`; ships as `bar-transient-heat` |
| 33 | [ANSYS – Thermal Stresses in a Bar](https://confluence.cornell.edu/spaces/SIMULATION/pages/160339849/ANSYS+-+Thermal+Stresses+in+a+Bar) | Indirect coupled thermal-structural, thermal expansion, constrained expansion | **can do** — `load.temperature` in a `static` Step, or the `heat-steady` → `static{after}` chain; ships as `heated-fin` and `thermal-stress-plate` |
| 34 | [ANSYS – Modal Analysis of a Composite Monocoque](https://confluence.cornell.edu/spaces/SIMULATION/pages/213418755/ANSYS+-+Modal+Analysis+of+a+Composite+Monocoque) | Layered composite shells with per-region lay-ups, modal extraction, torsional stiffness | **cannot** — no composites, no shells, no CAD import |
| 35 | [ANSYS – Cantilever Beam](https://confluence.cornell.edu/spaces/SIMULATION/pages/125812724/ANSYS+-+Cantilever+Beam) | Static structural, tip point load, deflection, bending stress and bending-moment recovery | **can do** as a 3D solid — `geometry.addBox` → `constraint.fix` → `load.traction` → `static`; ships as `cantilever`. The beam-element form (and the moment diagram) needs beam elements |
| 36 | [ANSYS – Large Telescope Truss](https://confluence.cornell.edu/spaces/SIMULATION/pages/198119352/ANSYS+-+Large+Telescope+Truss) | Truss/spar elements, static structural, stiffness-vs-weight study | **cannot** — no truss elements |
| 37 | [ANSYS WB – Bike Crank](https://confluence.cornell.edu/spaces/SIMULATION/pages/146907513/ANSYS+WB+-+Bike+Crank+-+All+Pages) | Linear static on a CAD part, point load with a fixed support, strain-gauge-location stress, mesh refinement, DIC validation | **partial** — the physics and the refinement study are `static` + `study.converge`; the crank's CAD shape needs STEP import and 3D tet meshing |

### COMSOL Multiphysics Application Gallery

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 38 | [Bracket — Structural Mechanics Tutorials](https://www.comsol.com/model/bracket-structural-mechanics-tutorials-10314) | A suite over one bracket: static, eigenfrequency and prestressed eigenfrequency, frequency response, linear buckling, transient, shells, rigid connectors | **partial** — the static and eigenfrequency parts run on a simplified box bracket (`bracket-L` is that model); buckling, frequency response, prestressed modal, transient dynamics, shells and rigid connectors are all missing |
| 39 | [Elastoplastic Analysis of Holed Plate](https://www.comsol.com/model/elastoplastic-analysis-of-holed-plate-244) | Plate with a hole, elastoplastic material with a hardening curve, load-unload cycle, residual stress, symmetry | **cannot** — no plasticity, no structural load stepping |
| 40 | [Hyperelastic Seal](https://www.comsol.com/model/hyperelastic-seal-206) | Hyperelastic rubber, contact pair, large deformation, force-deflection curve | **cannot** — no hyperelasticity, no contact, no geometric nonlinearity |
| 41 | [Postbuckling Analysis of a Hinged Cylindrical Shell](https://www.comsol.com/model/postbuckling-analysis-of-a-hinged-cylindrical-shell-10257) | Linear buckling for the critical load, then path-following post-buckling, shells, point load | **cannot** — no buckling, no post-buckling continuation, no shells |
| 42 | [Random Vibration Analysis of a Deep Beam](https://www.comsol.com/model/random-vibration-analysis-of-a-deep-beam-75611) | Beam elements, eigenfrequency base study, PSD random vibration, output PSD of displacement and bending stress | **cannot** — no random-vibration procedure, no beam elements |
| 43 | [Thermal-Stress Analysis of a Turbine Stator Blade](https://www.comsol.com/model/thermal-stress-analysis-of-a-turbine-stator-blade-10476) | Thermal-stress multiphysics coupling, internal cooling-channel heat transfer, high temperature and pressure | **partial** — the `heat-steady` → `static{after}` chain plus `load.convection` is exactly this; the blade's CAD geometry and its tet mesh are not reachable |
| 44 | [Axisymmetric Transient Heat Transfer](https://www.comsol.com/model/axisymmetric-transient-heat-transfer-267) | Axisymmetric geometry, transient conduction, step temperature BC, NAFEMS-validated | **can do** — `model.setIdealisation{axisymmetric}` → `mesh.set{mapped}` → `constraint.temperature` → `step.add{heat-transient}` |
| 45 | [Convection Cooling of Circuit Boards](https://www.comsol.com/model/convection-cooling-of-circuit-boards-449) | Conjugate heat transfer, natural and forced convection in the fluid, multiple IC heat sources | **cannot** — conjugate heat transfer needs a fluid solver, which is out of scope; only the solid side (`load.convection` with a given `h`) exists |
| 46 | [Fatigue Analysis of a Wheel Rim](https://www.comsol.com/model/fatigue-analysis-of-a-wheel-rim-2038) | High-cycle fatigue (Findley), non-proportional rotating-load stress history, CAD rim | **cannot** — no fatigue post-processing, no load history, no CAD import |
| 47 | [Bending of a Simply Supported Composite Laminate](https://www.comsol.com/model/bending-of-a-simply-supported-composite-laminate-67641) | Layered composite shell, cross-ply layup, layerwise vs equivalent-single-layer theory, through-thickness stress | **cannot** — no composites, no shells |
| 48 | [Thermal Contact Resistance Between an Electronic Package and a Heat Sink](https://www.comsol.com/model/thermal-contact-resistance-between-an-electronic-package-and-a-heat-sink-14659) | Thermal contact resistance from contact pressure, microhardness and roughness; contact pair; steady conduction | **cannot** — no contact, no thermal contact resistance |
| 49 | [In-Plane and Space Truss](https://www.comsol.com/model/in-plane-truss-8526) | Truss elements (axial force only), linear static, 2D and 3D | **cannot** — no truss elements |
| 50 | [Pratt Truss Bridge](https://www.comsol.com/model/pratt-truss-bridge-8511) | 3D beam elements for the members, shell deck, linear static, distributed load | **cannot** — no beam elements, no shells |
| 51 | [Necking of an Elastoplastic Metal Bar](https://www.comsol.com/model/necking-of-an-elastoplastic-metal-bar-12607) | Large-strain plasticity with nonlinear isotropic hardening, axisymmetric bar, tension to necking | **cannot** — no plasticity, no geometric nonlinearity |
| 52 | [Pressurized Orthotropic Container](https://www.comsol.com/model/pressurized-orthotropic-container-12669) | Thin-walled vessel, internal pressure, Hill orthotropic plasticity | **partly** — orthotropic elasticity shipped with #68; still needs Hill plasticity (#60) |
| 53 | [Steady-State 2D Axisymmetric Heat Transfer with Conduction](https://www.comsol.com/model/steady-state-2d-axisymmetric-heat-transfer-with-conduction-453) | Pure steady conduction, axisymmetric, NAFEMS thermal benchmark | **can do** — `axisymmetric` + `mesh.set{mapped}` + `constraint.temperature` + `step.add{heat-steady}` |

### NAFEMS benchmark collections

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 54 | [Selected Benchmarks for Material Non-linearity, Volume 1 (R0026)](https://www.nafems.org/publications/resource_center/r0026/) | Ten elastoplastic small-deformation ductile-metal benchmarks | **cannot** — no plasticity |
| 55 | [Benchmark Tests for Finite Element Modelling of Contact, Gapping and Sliding (R0081)](https://www.nafems.org/publications/resource_center/r0081/) | CGS-1…CGS-10: contact patch test, Hertzian contact, sliding and rolling contact, self-contact | **cannot** — no contact (BENCHMARKS F4, the two-block tie patch test, is the first row this would unlock) |
| 56 | [Benchmarks for Membrane and Bending Analysis of Laminated Shells, Part 1 (R0092)](https://www.nafems.org/publications/resource_center/r0092/) | Classical lamination theory, membrane and bending stiffness, ply thickness/orientation/stacking | **cannot** — no composites, no shells |
| 57 | [Selected Benchmarks for Forced Vibration (R0016)](https://www.nafems.org/publications/resource_center/r0016/) | Damped forced vibration of beam and shell assemblies under harmonic, periodic, transient and random loading | **cannot** — no harmonic, no random vibration, no implicit transient, no damping |

### FreeCAD FEM workbench

`wiki.freecad.org` serves an anti-bot challenge to automated fetches; content was confirmed
against the official `FreeCAD/FreeCAD-documentation` markdown mirror of the same pages.

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 58 | [FEM tutorial](https://wiki.freecad.org/FEM_tutorial) | Solid cube in tension, fixed and force constraints, steel, mesh, CalculiX linear static | **can do** — `geometry.addBox` → `material.add`/`assign` → `constraint.fix` → `load.traction` → `step.add{static}` → `solve.run` |
| 59 | [FEM CalculiX Cantilever 3D](https://wiki.freecad.org/FEM_CalculiX_Cantilever_3D) | Cantilever beam bending, static structural, comparison against beam theory | **can do** — the `cantilever` example verbatim, δ = PL³/3EI to −0.19 % |
| 60 | [FEM Shear of a Composite Block](https://wiki.freecad.org/FEM_Shear_of_a_Composite_Block) | Two-material block (stiff core in a soft matrix), simple shear, linear static | **can do** — `geometry.add` the matrix, `geometry.subtract` the cavity, `geometry.add` the core, two `material.add` + `material.assign`, `constraint.fix` + `constraint.prescribe` for the shear |
| 61 | [Transient FEM analysis](https://wiki.freecad.org/Transient_FEM_analysis) | Bimetallic strip, 60 s transient conduction, induced stress and displacement, initial and boundary temperatures | **partial** — `heat-transient` and the two materials are there, but `step.add.after` picks up a temperature field, not a time history, so the stress is only available at the end state rather than marching with the thermal solve |
| 62 | [FEM Tutorial Python](https://wiki.freecad.org/FEM_Tutorial_Python) | The whole workflow written as a script: geometry, mesh, constraints, solve, results | **can do** — `query.script` renders the Journal as a TypeScript program against the `fem` API, and `femlab run` replays it |

### PrePoMax and CalculiX

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 63 | [Elasto-plastic plate in tension (Example 7)](https://prepomax.fs.um.si/wp-content/uploads/2021/09/2021.09.07-PrePoMax-v1.1.0-examples-manual.pdf) (PrePoMax v1.1.0 examples manual) | Quarter-symmetry plate with a hole, plasticity from a yield-stress / plastic-strain table, PEEQ output | **cannot** — no plasticity; the elastic quarter-plate itself ships as `kirsch-quarter-plate` |
| 64 | [Hertz contact of two spheres (Example 8)](https://prepomax.fs.um.si/wp-content/uploads/2021/09/2021.09.07-PrePoMax-v1.1.0-examples-manual.pdf) | Surface-to-surface hard contact, NLGEOM, Code_Aster SSNV104 benchmark, mesh sensitivity | **cannot** — no contact, no geometric nonlinearity |
| 65 | [Cylindrical shell buckling (hinged segment, point load)](https://www.dhondt.de/examples.htm) (CalculiX examples) | Shells, buckling and post-buckling snap-through, nonlinear instability | **cannot** — no shells, no buckling |
| 66 | [Artificial wing (NACA profile) eigenmode analysis](https://www.dhondt.de/examples.htm) | Ten lowest eigenmodes, bending and torsional mode shapes | **partial** — `step.add{modal, nModes}` is exactly this procedure; the NACA solid needs an imported or free-tet-meshed 3D shape |

### deal.II and FEniCSx

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 67 | [step-8: The Elasticity Equations](https://dealii.org/current/doxygen/deal.II/step_8.html) | Vector elasticity (FESystem), body force, adaptive refinement driven by a Kelly error estimator | **can do** — linear-simplex elasticity and `load.gravity` with ZZ error-estimator-driven `study.adapt` (#83); the estimator differs from the tutorial’s Kelly indicator |
| 68 | [step-18: The quasistatic elasticity equations with large deformations](https://dealii.org/current/doxygen/deal.II/step_18.html) | Quasistatic large-deformation elasticity, Lagrangian mesh update, incremental stress with rotation correction | **cannot** — no geometric nonlinearity |
| 69 | [step-44: Nonlinear Solid Mechanics (three-field formulation)](https://dealii.org/current/doxygen/deal.II/step_44.html) | Compressible neo-Hookean, quasi-incompressible, three-field (u, p̃, J̃) mixed formulation, Newton–Raphson | **cannot** — no hyperelasticity, no geometric nonlinearity, no mixed u/p element |
| 70 | [step-26: The heat equation](https://dealii.org/current/doxygen/deal.II/step_26.html) | Transient conduction by the θ-scheme, adaptive refinement and coarsening coupled to time stepping | **partial** — the θ-scheme and final-field spatial `study.adapt` are available (#83); refinement/coarsening coupled to individual time steps is tracked in #479 |
| 71 | [Elasticity using algebraic multigrid](https://docs.fenicsproject.org/dolfinx/main/python/demos/demo_elasticity.html) (DOLFINx demo) | 3D linear elasticity, near-nullspace rigid body modes, CG with an AMG preconditioner, von Mises post-processing | **can do** — `static` + `solve.run{solver: 'gpu-pcg' or 'cpu-pcg'}` + `query.cost`; the preconditioner is Jacobi rather than AMG (PLAN 2.2), so the stiffest cases converge more slowly |

### SimScale

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 72 | [Validation Case: Thick Plate Under Pressure (NAFEMS LE10)](https://www.simscale.com/docs/validation-cases/thick-plate-under-pressure/) | Elliptic plate with an elliptic hole, quarter symmetry, distributed pressure, linear elastic, element-order comparison | **variant available** — `nafems-le10-plate` uses whole-face support (ESRD reference −5.25 MPa; computed −5.234 MPa). Original LE10 mid-plane-line support is not implemented; see BENCHMARKS.md D1 and #183 |
| 73 | [Validation Case: Design Analysis of a Spherical Pressure Vessel](https://www.simscale.com/docs/validation-cases/design-analysis-of-spherical-pressure-vessel/) | 1/8 sphere, transient thermo-structural coupling, internal pressure ramp, convective BCs, thermal expansion | **partial** — sphere and symmetry are reachable, but a thin spherical wall stair-steps on the lattice mesher, and the thermal-structural chain is not transient |
| 74 | [Validation Case: Flange Under Bolt Preload](https://www.simscale.com/docs/validation-cases/flange-under-bolt-preload/) | Bolt pretension, bonded and physical contact at the flange faces and seal, nonlinear static, internal pressure, quarter symmetry | **cannot** — no bolt pretension, no contact; `bolt-flange` models the same part with a preload *pressure* instead |
| 75 | [Validation Case: Hertzian Contact Between Two Spheres](https://www.simscale.com/docs/validation-cases/hertzian-contact-between-two-spheres/) | Frictionless physical contact, nonlinear contact solve, penalty vs augmented Lagrange | **cannot** — no contact |
| 76 | [Tutorial: Harmonic Analysis of an Airfoil (2/2)](https://www.simscale.com/docs/tutorials/harmonic-analysis-airfoil/) | Harmonic forced response, frequency sweep on a pressure load, reuse of modal results, complex displacement and phase | **cannot** — no harmonic procedure |

### SolidWorks Simulation

`help.solidworks.com` is a JavaScript SPA that serves no article body to a fetch; GoEngineer and
CATI are SOLIDWORKS resellers and training centres publishing the equivalent written tutorials.

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 77 | [Using Symmetry in SOLIDWORKS Simulation Studies](https://www.goengineer.com/blog/using-symmetry-solidworks-simulation-studies) | Planar symmetry fixtures for half / quarter / eighth models, cyclic symmetry, mirrored loads, reading the full model back from the reduced one | **partial** — `constraint.symmetry` covers the planar cases (the `symmetry-and-2d` tutorial teaches them); cyclic symmetry is missing |
| 78 | [SOLIDWORKS Is Discontinuing Adaptive Meshing – What Does This Mean?](https://www.goengineer.com/blog/solidworks-discontinuing-adaptive-meshing) | h-adaptive vs p-adaptive convergence, migration to manual curvature-based meshing | **can do** — `study.adapt` adds a ZZ-driven h-adaptive loop for linear simplices (#83); `study.converge` and `mesh.set{order}` retain the manual h-study and p-switch |
| 79 | [How Do I Complete a Simulation Fatigue Analysis in SOLIDWORKS?](https://www.cati.com/blog/how-do-i-complete-a-simulation-fatigue-analysis-in-solidworks/) | Fatigue study linked to a base linear static study, S-N curve on the material, load-cycle definition (fully reversible / zero-based / load ratio), life and damage-percentage plots | **cannot** — no S-N material data, no load-cycle definition, no fatigue post-processing |

### Autodesk Fusion (Simulation)

| # | Tutorial | Physics / features needed | FEM Lab status |
|---|---|---|---|
| 80 | [Tutorial: Static stress analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-3E91212F-9158-4E7C-BB6A-662F22EF22C3.htm) | Linear static, separation (no-penetration) contact, fixed and force BCs, rigid-body-mode stabilisation, two load cases | **partial** — the static solve, the BCs and two Steps are all Commands; the separation contact and the CAD part are not |
| 81 | [Tutorial: Modal frequencies analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-49EBF17A-7E55-4FB8-8431-D222718137D6.htm) | Modal analysis of an unconstrained model, rigid-body vs functional modes, tuning frequencies through geometry | **can do** — `step.add{modal, nModes, shift}` with no constraints listed; `shift` is what makes the free-free case solvable |
| 82 | [Tutorial: Structural buckling analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-36828110-C0F0-454C-A455-FACA75CCB717.htm) | Eigenvalue buckling, load factor, buckling mode shapes, slender-member instability | **cannot** — no buckling procedure |
| 83 | [Tutorial: Nonlinear static stress analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-F60CF732-772C-496B-B480-290FB2EFA7BE.htm) | Nonlinear stress-strain curve, plastic yielding, nonlinear static solver, comparison against the linear result | **cannot** — no plasticity |
| 84 | [Tutorial: Thermal stress analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-88BCA6F7-A333-41C8-AA35-703F6F99DE13.htm) | Coupled thermal-structural, combined pressure and temperature loading, 1/8 symmetry, expansion-compatible constraints | **can do** — `constraint.symmetry` ×3 → `load.pressure` + `load.temperature` → `step.add{static}`, or the `heat-steady` → `static{after}` chain |
| 85 | [Tutorial: Thermal analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-4B1F8D61-6F33-4E6A-B08A-4E562026762C.htm) | Steady-state thermal, conduction through fins, convection to ambient, design compared against a temperature limit | **can do** — `constraint.temperature` + `load.convection` + `step.add{heat-steady}`; ships as `heated-fin-convection` |
| 86 | [Tutorial: Stresses on a SnapFit connector](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-43DF60AE-6205-4D6C-84DF-B2F5F2F87607.htm) | Dynamic event simulation, contact pairs between mating bodies, large deformation of the locking fingers, rigid vs deformable bodies, plastic material | **cannot** — no contact, no geometric nonlinearity, no plasticity, no implicit dynamics |

**Tally: 19 can do, 16 partial, 51 cannot.**

---

## 2. The gap list, ranked

One row per distinct missing capability, with the count of tutorials it blocks (a tutorial that
needs three capabilities is counted in all three). The scope paragraph says what implementing it
means *in FEM Lab* — which Command, which element or procedure, which UI — and names the PLAN
phase that already owns it where one does.

### Contact and assemblies

**1. Contact between parts — 16 tutorials.**
Tutorials 4, 6, 9, 11, 13, 16, 23, 29, 40, 48, 55, 64, 74, 75, 80, 86.
This is the single biggest blocker and the one capability that separates "a part" from "a
product". Scope: a `contact.add` Command taking two face Sets (`master`, `slave`) and a `kind`
of `bonded` (a tie — PLAN 6.5's node-to-face penalty constraint) or `frictionless`. Bonded is
the tractable half: it is a linear constraint assembled into the same operator, needs no
iteration, unlocks assemblies of several Bodies, and its gate already exists as BENCHMARKS F4
(two-block tie patch test), to which I would add NAFEMS R0081's CGS-1 patch test. Frictionless
node-to-face needs an active-set or penalty loop inside a Newton iteration and therefore depends
on geometric nonlinearity (#10); PLAN §12 already declares *frictional* contact Out. UI: a
Connections panel listing pairs, a face picker that highlights both sides, and a warning when two
Bodies overlap or the gap is larger than the mesh size. **File `bonded` and `frictionless` as two
issues** — the first is weeks, the second is a project.

**2. Bolt pretension — 4 tutorials.**
Tutorials 9, 20, 23, 74.
Scope: a `load.bolt` Command naming a body or a face Set through the bolt shank plus a preload
force, implemented as the classic pretension section — split the mesh on a plane through the
shank, insert a relative-displacement DOF, solve for the adjustment that produces the given force
in the first Step, then hold that length in later Steps. It needs `step.add` to carry that state
forward, so it lands after multi-step state carrying and realistically after #1: a preloaded
joint with no contact at the flange faces is not the model anyone means. `bolt-flange` is the
honest workaround today (a uniform seat pressure) and its `meta.json` says so.

**3. Thermal contact resistance — 1 tutorial.**
Tutorial 48.
Scope: once #1 exists, a `contact.thermal` variant carrying a conductance `h_c` across the pair,
assembled into the heat operator exactly as `load.convection` is — a surface term coupling two
temperature fields instead of one field to `tInf`. Small on its own, meaningless before #1.

### Elements

**4. Shell elements — 13 tutorials.**
Tutorials 4, 6, 7, 10, 25, 34, 38, 41, 47, 50, 52, 56, 65.
Scope: PLAN 8.1's MITC4 quadrilateral shell with a section carrying thickness, plus the
geometry/mesher path to produce a surface mesh (the `mapped` mesher already emits quads; what is
missing is placing them in 3D and giving nodes rotational DOFs). Adds three DOFs per node, a
drilling-DOF decision, and a new output set (top and bottom surface stress, moments). The gates
are already written: BENCHMARKS G1–G7 (simply-supported plate, Scordelis–Lo, LE3 hemisphere, LE2
cylindrical patch, LE5 Z-section, FV12 modal, pinched cylinder). The largest single piece of work
in this list, and the one that turns "solid parts" into "structures".

**5. Beam elements — 8 tutorials.**
Tutorials 5, 11, 12, 20, 28, 35, 42, 50.
Scope: PLAN 8.1's Timoshenko beam with a section library (rectangle, circle, tube, I, channel), a
line-geometry Command taking two points and a section, rotational DOFs shared with #4, and
post-processing that reports axial force, shear and bending moment along the member rather than a
stress tensor. Cheaper than shells and unlocks frames, piping and the whole "engineer's first
model" category. Note that FEM Lab's `cantilever` verification *quotes* Euler–Bernoulli theory
while solving a solid; the beam element is what makes that theory a model rather than a footnote.

**6. Truss elements — 3 tutorials.**
Tutorials 24, 36, 49.
Scope: the degenerate case of #5 — two nodes, axial stiffness EA/L, no rotational DOF, no
bending. Perhaps a day once a line-geometry Command and a section exist, and the best possible
teaching element (its stiffness matrix fits on a slide). Worth its own issue precisely because it
can ship before the beam.

**7. Point masses, rigid connectors and couplings — 3 tutorials.**
Tutorials 4, 12, 38.
Scope: a `geometry.addMass` (a lumped mass at a point, contributing only to the mass matrix, for
modal and explicit) and a `constraint.couple` (a reference node rigidly or distributed-coupled to
a face Set — how a bolt, a bearing or a load introduction is idealised). Both are MPC machinery:
rows in the constraint matrix, not new elements. Cheap relative to their reach, and #27 reuses
them.

**8. Mixed u/p element for near-incompressibility — 1 tutorial.**
Tutorial 69.
Scope: a three-field or B-bar formulation as a `Formulation` variant alongside
`incompatible-modes` and `full`. BENCHMARKS C3 (ν = 0.49 … 0.4999) is already green, so today's
elements survive the linear case; this only becomes load-bearing with hyperelasticity (#11).

### Materials

**9. Plasticity (J2 with hardening) — 12 tutorials.**
Tutorials 3, 4, 6, 18, 24, 39, 51, 52, 54, 63, 83, 86.
Scope: PLAN 6.2. `material.add` gains a `hardening` table alongside the `yield` field that
already exists in the schema but nothing reads; a radial-return mapping at each integration
point; a consistent tangent; per-element state variables persisted between increments; and
`step.add` gaining increments so a load can be applied in steps and unloaded (#22). It needs the
Newton loop, so it lands with or after #10. Gate: NAFEMS R0026 and the plastic zone of the holed
plate. This is also the first `MaterialLaw` Extension Point customer (PLAN P.1/P.3), so whether
to build it *through* the plugin interface rather than beside it is the design decision the issue
has to settle.

**10. Geometric nonlinearity (large deformation) — 12 tutorials.**
Tutorials 6, 15, 23, 25, 40, 41, 51, 64, 68, 69, 80, 86.
Scope: PLAN 6.1. Total or updated Lagrangian hex/quad, Newton–Raphson with load stepping and
line search, convergence controls exposed in the schema (`step.add` gaining
`increments`/`tolerance`/`maxNewton`), and a solver panel showing the residual per iteration
rather than a spinner. Gate: BENCHMARKS B6 (Bathe's large-deflection cantilever, an exact
elastica) and tutorial 15's Bisshopp–Drucker curve. Everything nonlinear downstream —
plasticity, hyperelasticity, sliding contact, post-buckling — depends on this loop existing, so
it is the highest-leverage single issue here even though its count only ties with #9.

**11. Hyperelasticity — 2 tutorials.**
Tutorials 40, 69.
Scope: neo-Hookean and Mooney–Rivlin as `MaterialLaw`s once #10 and #8 exist. Low count in this
sample, but it is the whole elastomer / seal / gasket world, a large fraction of what
consumer-product engineers actually simulate.

**12. Composites, orthotropic and layered materials — 4 tutorials.**
Tutorials 34, 47, 52, 56.
The orthotropic *solid* half **shipped** with #68: `material.add` takes an `orthotropic` block of
nine constants and an axis-and-angle `orientation`, with per-material-axis `alpha` and `k`, so
wood, rolled steel, printed parts and a unidirectional lamina are analysable today (benchmarks
A11–A15 and C10). Tutorial 52 additionally needs Hill orthotropic plasticity (#60).
Laminates are **not** covered and were deliberately not faked: `mesh.rs::lattice_bodies` never
welds coincident nodes between Bodies, so stacked plies as separate Bodies would be mechanically
disconnected, and the mapped/swept mesher welds across blocks but gives them all one implicit
Body, so per-ply materials are unreachable there. Filed as #347 (stacked solids need node welding
or ties, #61); equivalent-single-layer and layerwise shell sections are deferred to #64, which
reuses `orthotropic_d` and `voigt_rotation` unchanged in its section integral.

**13. Temperature-dependent properties — 1 tutorial.**
Tutorial 23.
Scope: PLAN 8.5's tabular fields — `material.add` accepting `E`, `k`, … as (T, value) tables
evaluated per integration point from the current temperature field. It makes `heat-steady`
nonlinear, so it wants the Newton loop from #10.

### Procedures

**14. Linear buckling — 7 tutorials.**
Tutorials 6, 18, 26, 38, 41, 65, 82.
Scope: PLAN 6.3. A `buckling` procedure: solve the static Step, form the geometric stiffness K_σ
from the resulting stress state, then run the same eigen solver `modal` already uses on
(K + λK_σ). It reuses the modal machinery and the static solve almost entirely, needs no Newton
loop, and BENCHMARKS B5 (Euler column, P_cr = π²EI/L²) is a one-line check.
**This is the cheapest high-count item in the whole list and should be the first procedure issue
filed.**

**15. Harmonic / frequency response — 5 tutorials.**
Tutorials 17, 27, 38, 57, 76.
Scope: PLAN 6.4's second half. A `harmonic` procedure taking a frequency range and a damping
model (Rayleigh α/β to start), solving (K − ω²M + iωC)u = f at each frequency, either directly or
by mode superposition on an existing `modal` Result through `step.add.after`. Needs complex
arithmetic through the solver and a new plot type (magnitude and phase against frequency), which
PLAN 5.3's XY plots already anticipate.

**16. Implicit transient dynamics — 5 tutorials.**
Tutorials 17, 29, 38, 57, 86.
Scope: PLAN 6.4's first half. Newmark or HHT-α integration for the structural problem — the same
shape as the existing `heat-transient` θ-method Step (`dt`, `tEnd`, `outputEvery`, `amplitude`)
but with mass and damping matrices. Gate: BENCHMARKS F3 (SDOF and cantilever under a step load,
closed form). It shares the amplitude machinery that already exists, so much of the schema
surface is written.

**17. Random vibration (PSD) — 4 tutorials.**
Tutorials 17, 28, 42, 57.
Scope: a `randomVibration` procedure consuming a `modal` Result plus an input PSD table and
producing 1σ displacement and stress fields by the standard modal-summation formulae. Purely
post-modal linear algebra — no new element, no new solver — so it is unusually cheap for how
exotic it sounds. Gate: Ansys VM19 and NAFEMS R0016.

**18. Explicit dynamics with contact and nonlinear material — 3 tutorials.**
Tutorials 4, 30, 86.
Scope: the `explicit` procedure exists and is verified (BENCHMARKS F1, F2, F2b) but is linear
elastic with no contact, which means it cannot do the one thing people run explicit *for*. Needs
#1's contact search inside the time loop and #9's material law at each point. It also needs an
initial-velocity condition — `step.add.initial` currently takes only a temperature — and that
part is a small standalone issue worth filing on its own.

**19. Post-buckling / arc-length continuation — 3 tutorials.**
Tutorials 25, 41, 65.
Scope: Riks arc-length control in #10's Newton loop, so a snap-through path with negative
stiffness can be traced. Small once #10 exists, impossible before it.

**20. Submodelling — 2 tutorials.**
Tutorials 7, 8.
Scope: a `study.submodel` taking a coarse global Result, a box or face Set defining the cut
boundary, and driving a fine local Model's boundary with the interpolated global displacement
field. `query.probe` already does the interpolation; what is missing is a Command that applies an
interpolated field as a boundary condition, plus bookkeeping so the local Model records which
global Result it came from. Genuinely useful and independent of everything else here.

**21. Fatigue — 3 tutorials.**
Tutorials 20, 46, 79.
Scope: post-processing, not a solver — an S-N curve on the Material, a load history (or two
Results treated as max and min), rainflow counting, and a damage/life field. A natural fit for
the `PostQuantity` Extension Point (PLAN P.1) rather than the core. Needs #22 to be interesting.

**22. Structural load stepping, histories and amplitudes — 4 tutorials.**
Tutorials 17, 24, 39, 46.
Scope: `step.add` already has `amplitude` (sine or table) but it only scales *prescribed
temperatures* in a transient heat Step. Generalise it to scale structural loads and prescribed
displacements across increments — which is what a load-unload cycle, a ramped preload and a
rotating load history all need. A prerequisite for #9's residual-stress cases and for #21.

**23. Prestressed modal / stress stiffening — 3 tutorials.**
Tutorials 5, 18, 38.
Scope: exactly #14's K_σ, reused — a `modal` Step whose `after` names a static Step solves
(K + K_σ) instead of K. If #14 ships, this is a flag rather than a project; file it as a
follow-up on that issue.

**24. Radiation boundary condition — 1 tutorial.** *Shipped (#79).*
Tutorial 14.
`load.radiation` gives a face a σε(T⁴ − T∞⁴) surface term against a large surrounding, and makes
the heat Step nonlinear — a Newton loop over temperature through `procedure::iterate`, which is
now the repository's shared nonlinear-iteration structure, governed by `step.add`'s
`nonlinearTolerance` and `nonlinearMaxIterations`. Gated by BENCHMARKS E6 (a bisection oracle on
the steady flux balance) and E7 (the analytic T(t) = T0(1 + 3cT0³t)^(−1/3) cooling curve); E4
(NAFEMS T2) stays **resolve** because its 927 K has not been read from the publication.
What is still missing for tutorial 14 is *cavity* radiation — surface-to-surface exchange with
view factors — which is a different feature, not a parameter of this one.

**25. Conjugate heat transfer / fluid-structure — 1 tutorial.**
Tutorial 45.
Mentioned for completeness only: it needs a fluid solver and is out of scope. FEM Lab's answer is
`load.convection` with a hand-supplied film coefficient, which is what the tutorial's solid side
reduces to anyway.

### Geometry and CAD

**26. CAD import and real B-rep geometry — 13 tutorials.**
Tutorials 2, 3, 9, 14, 23, 34, 37, 38, 43, 46, 66, 80, 86.
Scope: PLAN 7.1–7.3. Replicad behind the existing geometry Commands (so `geometry.add` gains
fillet, chamfer and shell), `importSTEP` or `occt-import-js` for STEP, STL straight into the tet
mesher, and defeaturing Commands that drop fillets and holes below a size. This is the single
change that would move the most rows from "partial" to "can do", because most partials in this
table are *the physics working on a shape FEM Lab cannot build*. Large and lazily loadable
(2.4–9 MB), so it is a phase rather than one issue: file STEP import separately from
fillet/chamfer.

**27. Cyclic symmetry — 2 tutorials.**
Tutorials 9, 77.
Scope: a `constraint.cyclic` tying two face Sets related by a rotation about an axis, as an MPC.
Shares all its machinery with #7's couplings. Cheap, and it is what makes a bolted flange, a
turbine disc or a gear sector a one-sector model.

**28. Axisymmetric with twist / torsion — 1 tutorial.**
Tutorial 8.
Scope: a third DOF (circumferential displacement) in the axisymmetric element, so a shaft can be
twisted in an axisymmetric model. Small and self-contained; the axisymmetric element already
exists.

**29. Moment loads and rotational DOFs — 2 tutorials.**
Tutorials 15, 50.
Scope: falls out of #4 and #5 — there is nowhere to apply a moment until nodes have rotations.
Worth recording, not worth its own issue.

### Meshing

**30. 3D free tet meshing from a Command — 10 tutorials.**
Tutorials 2, 3, 9, 14, 37, 43, 46, 66, 80, 86.
Scope: tet4 exists in the engine but no `MesherSpec` variant reaches it. PLAN 3.2 names
fTetWild; PLAN 7.4 names Gmsh-wasm as the alternative if graded, tet10-native meshing is worth
the GPL and the 12–45 MB. Add a `{kind: 'tet', of, size, refine}` mesher plus tet10 for accuracy
(linear tets are too stiff in bending and need the warning J4.3 already asks for). With #26 this
is what lets FEM Lab accept an engineer's real part at all; *without* #26 it still unlocks
meshing the CSG solids the geometry Commands can already build but the lattice mesher only
stair-steps — which is why it is worth filing independently.

**31. Error-estimator-driven adaptive refinement — 3 tutorials.**
Tutorials 67, 70, 78.
Implemented by #83: `errorEstimate` is a per-element ZZ energy-error field and
`study.adapt` uses bulk marking to add local size boxes, re-mesh, re-solve, and report progress
toward a relative-error target. Linear tri3/tet4 planar/3D static and thermal Steps are supported;
`mesh.set.refinement` exposes the same size field. Journal entries preserve the chosen regions
for deterministic replay. The base mesh still controls curved-boundary geometry error.
Transient heat adapts the final spatial field by repeating the complete Step, so tutorial 70’s
within-time-step refinement/coarsening remains outside this capability and is tracked in #479.

### Post-processing and UX

**32. Transient field chaining (a history, not an end state) — 2 tutorials.**
Tutorials 61, 73.
Scope: `step.add.after` picks up a temperature field from a heat Step. For a *transient* heat
Step it should be able to pick up the field at a chosen time, or drive a structural solve at every
output time — the difference between "the stress in the bimetallic strip after 60 s" and "the
stress history". Needs Result storage to keep more than the final state, which the transient heat
Step's `outputEvery` already implies.

**33. Damping models — 3 tutorials.**
Tutorials 17, 27, 57.
Scope: Rayleigh α/β on the Material or the Step. Needed by #15 and #16, useless without them —
fold it into whichever ships first.

---

## 3. The ten tutorials FEM Lab should ship first

Nineteen of the 86 are fully doable today. These ten are the ones worth writing as
`packages/app/tutorials/*.json` next, chosen so that each teaches something the current nine
built-ins do not and so that every one ends on a number that can be checked. Their `doIt`
sequences would be validated by `packages/app/test/tutorial-fixtures.test.ts` like the rest.

| # | Model it on | What it teaches that the current tutorials do not |
|---|---|---|
| 1 | [ANSYS – Pressure Vessel](https://confluence.cornell.edu/spaces/SIMULATION/pages/216399972/ANSYS+-+Pressure+Vessel) (Cornell SimCafe) | The axisymmetric idealisation. Nothing in the current nine touches `model.setIdealisation{axisymmetric}`, and the thick-vs-thin-wall comparison is the perfect closing theory (Lamé against pr/t). `lame-cylinder-plane-strain` supplies checked numbers to sit beside it. |
| 2 | [Axisymmetric Transient Heat Transfer](https://www.comsol.com/model/axisymmetric-transient-heat-transfer-267) (COMSOL) | Axisymmetric *and* transient together — that the same θ-method the `transient-heat` tutorial teaches in 1D works unchanged on a revolved section. |
| 3 | [FEM Shear of a Composite Block](https://wiki.freecad.org/FEM_Shear_of_a_Composite_Block) (FreeCAD) | Two materials in one model: `geometry.subtract` to make the cavity, a second Body for the core, `material.assign` per Body, `constraint.prescribe` for a pure shear. The first tutorial whose answer depends on a stiffness ratio. |
| 4 | [Tutorial: Thermal analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-4B1F8D61-6F33-4E6A-B08A-4E562026762C.htm) (Fusion) | A design decision rather than a benchmark: does this heat sink stay under the limit? The same Commands as `heated-fin-convection`, framed as a question with a pass/fail answer. |
| 5 | [Tutorial: Thermal stress analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-88BCA6F7-A333-41C8-AA35-703F6F99DE13.htm) (Fusion) | Pressure and temperature in one Step on a 1/8-symmetry model — three `constraint.symmetry` planes at once, and why a symmetry constraint must not fight thermal expansion. |
| 6 | [Thermal-Stress Analysis](https://www.appliedcax.com/resources/simcenter-femap-nastran/thermal-stress-analysis/) (Femap) | `step.add.after`: one Step's temperature field becoming the next Step's load. `thermal-stress-plate` is the checked model (σ = −EαΔT/(1−ν), −0.00 % error) and has no tutorial yet. |
| 7 | [Thick Plate Under Pressure, NAFEMS LE10](https://www.simscale.com/docs/validation-cases/thick-plate-under-pressure/) (SimScale) | A 3D benchmark comparison including element order and boundary-condition fidelity. `nafems-le10-plate` implements the ESRD whole-face-support variant: −5.234 MPa against −5.25 MPa. The original NAFEMS line-supported target −5.38 MPa belongs to a different model (#183). |
| 8 | [Tutorial: Modal frequencies analysis](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-49EBF17A-7E55-4FB8-8431-D222718137D6.htm) (Fusion) | Free-free modal: six rigid-body modes at zero, why the eigen solve needs `shift` to get past them, and how to tell a rigid-body mode from a real one. The existing `modal-analysis` tutorial is clamped, so this is its missing half. |
| 9 | [FEM Tutorial Python](https://wiki.freecad.org/FEM_Tutorial_Python) (FreeCAD) | The Journal as a program: `query.script`, editing it, replaying it, `femlab run --verify`. FEM Lab's strongest differentiator, currently taught nowhere. |
| 10 | [Elasticity using algebraic multigrid](https://docs.fenicsproject.org/dolfinx/main/python/demos/demo_elasticity.html) (FEniCSx) | Cost and solver choice: `query.cost` before solving, `solve.run{solver}`, direct vs PCG vs GPU, and what `solve.stalled` means. The only one that would teach the numerics rather than the model. |

Two more that are equally doable and worth queueing behind them: [ANSYS – 2D Steady
Conduction](https://confluence.cornell.edu/spaces/SIMULATION/pages/146918507/ANSYS+-+2D+Steady+Conduction)
(a 2D conduction field with a flux boundary — one step past the 1D `heat-conduction` tutorial)
and [Abaqus Appendix B](https://ceae-server.colorado.edu/v2016/books/gsa/ap02.html), which is the
same first model as the `cantilever` tutorial and is worth keeping as the cross-reference that
puts a FEM Lab Journal beside the Abaqus click-path.

---

## Notes on sources

- `help.3ds.com` (SIMULIA), `help.solidworks.com` and `mooseframework.inl.gov` could not be read
  by an automated fetch (login, a JavaScript SPA, and HTTP 403 respectively). Abaqus content was
  verified against two live academic mirrors of the same documentation; SOLIDWORKS against
  GoEngineer and CATI, authorised resellers and training centres. MOOSE is therefore absent —
  its solid-mechanics and heat-conduction examples would add nothing to the gap list that
  deal.II's steps do not already cover.
- `wiki.freecad.org` serves an anti-bot challenge; the five FreeCAD rows were verified against the
  official `FreeCAD/FreeCAD-documentation` markdown mirror of exactly those pages, and cite the
  canonical wiki URLs.
- Ansys Innovation Space is mid-migration: individual lesson URLs now redirect to a dead homepage,
  so only `/product/<slug>/` course landing pages are cited.
- The classic NAFEMS single-case descriptions (LE1, LE10, LE11, T1–T4, FV32) are not free-standing
  public pages; their reference values live in `docs/BENCHMARKS.md` with sources, and four real
  NAFEMS Resource Centre publications are cited here instead.
