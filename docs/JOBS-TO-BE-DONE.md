# Jobs to be done

What a finite-element engineer actually does, from the first sketch to the report, written
down so the plan can be checked against it. Every job below is numbered; `PLAN.md` carries a
coverage matrix that assigns each one to a phase or says explicitly why it is out of scope.
"Today" columns describe how Abaqus/CAE, COMSOL and Ansys Mechanical users do it, because
those are the habits our users arrive with.

Format: *When [situation], I want to [action], so that [outcome].*

## Who

| Persona | Typical model | What they care about |
|---|---|---|
| **P1 Student** (NTNU TKT4192/TKT4197-style course, first FEA) | cantilever, plate with hole, L-bracket, simple frame | understanding what the numbers mean, matching a hand calculation, not fighting the tool |
| **P2 Practising structural / mechanical engineer** | bracket, weld detail, pressure vessel, connection, slab | trustworthy stresses and deflections against a code, reactions, a report, repeatability |
| **P3 Researcher / method developer** | odd physics, custom material, parametric studies | control over every knob, scripting, export to their own tooling |
| **P4 Teacher / demo author** | canonical benchmarks, live "what if" | a shareable link that just runs, clear pictures, theory next to the result |
| **P5 AI agent** (Claude, driven by any of the above) | whatever the human asked for | a complete, typed, observable API; errors as text; a way to look at the result |

P5 is not a bolt-on. Every job below is written so that P5 can do it too, which is the
reason for the "everything is a Command" rule (see the glossary and ADR 0003).

## J1 Frame the problem

| # | Job | Today (Abaqus / COMSOL / Ansys) |
|---|---|---|
| J1.1 | When I start, I want to state the question (max stress? deflection? first frequency? will it buckle?) so the rest of the setup serves it | in the engineer's head or a report template; the tools have no notion of "the question" |
| J1.2 | I want to choose an idealisation (3D solid, 2D plane stress/strain, axisymmetric, shell, beam, truss) so the model is as small as the question allows | Abaqus part "modelling space"; COMSOL space dimension; Ansys analysis type |
| J1.3 | I want to exploit symmetry (half, quarter, cyclic) so I solve a fraction of the model | manual: cut geometry, apply symmetry constraints |
| J1.4 | I want to work in a consistent unit system and be told when I mix units | Abaqus: no units, user's responsibility (classic error source); COMSOL/Ansys: unit-aware |
| J1.5 | I want a rough hand-calculation or order-of-magnitude estimate next to the model so I know what answer to expect | done on paper or in a spreadsheet |
| J1.6 | I want to pick the physics (structural, thermal, thermo-structural, modal, buckling, dynamics) | analysis/step type |

## J2 Build geometry

| # | Job | Today |
|---|---|---|
| J2.1 | I want to create solids from primitives and booleans (box, cylinder, extrude a sketch, revolve, cut a hole, fillet an edge) | Abaqus/CAE Part module sketcher; COMSOL geometry sequence; SpaceClaim/DesignModeler |
| J2.2 | I want to make the geometry parametric (hole diameter d, thickness t) so I can change one number and everything updates | COMSOL parameters; Abaqus Python; Ansys DesignModeler parameters |
| J2.3 | I want to import a CAD file (STEP, IGES, STL) from a colleague | STEP import everywhere; STL usually via mesh import |
| J2.4 | I want to clean and defeature imported geometry (remove small fillets, holes, logos) so it meshes | SpaceClaim, Abaqus virtual topology, COMSOL "remove details" |
| J2.5 | I want to partition or split geometry to control meshing or to define regions for loads/materials | Abaqus partition tools; COMSOL work planes; Ansys slice |
| J2.6 | I want to name faces, edges, and volumes so I can refer to them for loads, constraints, materials, and results | Abaqus sets/surfaces; COMSOL selections; Ansys named selections |
| J2.7 | I want to assemble several parts, position them, and say which faces touch, are bonded, or are welded | Abaqus Assembly module + constraints; COMSOL form union/assembly; Ansys contact regions |
| J2.8 | I want to measure the geometry (volume, area, bounding box, distance, mass) to sanity-check it | query tools |
| J2.9 | I want to build 1D/2D idealisations (beams with profiles, shells with thickness) not only solids | Abaqus wire/shell parts + sections; Ansys line/surface bodies |
| J2.10 | I want to see the geometry from any angle, section it, hide parts, and see it with the mesh | viewport |

## J3 Materials and sections

| # | Job | Today |
|---|---|---|
| J3.1 | I want to pick a material from a library (S355 steel, 6061-T6, concrete C30/37, ABS) with the right properties | Ansys Engineering Data; COMSOL material library; Abaqus: none built in |
| J3.2 | I want to define a custom material (E, ν, ρ, α, k, cp, yield, hardening curve) | material editor |
| J3.3 | I want temperature-dependent or orthotropic/anisotropic properties | tabular fields, orientations |
| J3.4 | I want nonlinear material behaviour (plasticity with hardening, hyperelastic, damage/cracking, creep) | Abaqus material models; Ansys; COMSOL nonlinear structural module |
| J3.5 | I want to assign materials to bodies and section properties (shell thickness, beam profile) to idealised parts | section assignments |
| J3.6 | I want the material orientation for composites/orthotropic parts | orientation definitions |

## J4 Mesh

| # | Job | Today |
|---|---|---|
| J4.1 | I want a mesh with one global size, and to see how many elements/nodes it makes | seed/size controls |
| J4.2 | I want local refinement where stress concentrates (hole, notch, fillet) | local seeds, size fields, sphere of influence |
| J4.3 | I want to choose element type and order (hex vs tet, linear vs quadratic, reduced integration, incompatible modes) and be warned when linear tets will be too stiff | element type dialog; Abaqus C3D8R/C3D10 etc. |
| J4.4 | I want structured/hex meshes on simple parts and tets where I must | Abaqus mesh controls (structured, sweep, free); Ansys MultiZone |
| J4.5 | I want to check mesh quality (aspect ratio, Jacobian, skew, min angle) and locate bad elements | mesh verify tools |
| J4.6 | I want to run a mesh convergence study (h-refinement) and see the quantity of interest converge | manual re-mesh + rerun, or Ansys convergence tool |
| J4.7 | I want to know the cost (DOF, memory, time) before I run | job estimate; usually trial and error |
| J4.8 | I want to import an existing mesh (Gmsh .msh, Abaqus .inp, VTK) and export mine | import/export |
| J4.9 | I want the mesh to respect named faces so my loads land on the right nodes after remeshing | sets tied to geometry, not nodes |

## J5 Constraints and loads

| # | Job | Today |
|---|---|---|
| J5.1 | I want to fix, pin, or roller-support faces/edges/points, and apply symmetry constraints | BC manager |
| J5.2 | I want prescribed displacements/rotations, including ramped over a step | BCs with amplitudes |
| J5.3 | I want pressure, traction, point/line forces, moments, gravity/acceleration, centrifugal loads | load manager |
| J5.4 | I want a total force spread over a face ("10 kN on this face") rather than a per-node value | Abaqus surface traction with total force; Ansys force on face |
| J5.5 | I want thermal loads (temperature field, convection, flux, heat source) and thermal expansion into a structural step | thermal BCs + predefined fields |
| J5.6 | I want loads and constraints that vary in time or with a parameter (amplitude curves, functions) | amplitudes, expressions |
| J5.7 | I want remote points / rigid bodies / couplings for bolts, hinges, and lumped masses | coupling constraints, MPCs, connectors |
| J5.8 | I want contact between parts (frictionless, frictional, bonded, no-separation) | contact pairs / general contact |
| J5.9 | I want to see every load and constraint drawn on the model, and to verify total applied load | BC/load symbols; total-load queries are indirect |

## J6 Analysis steps

| # | Job | Today |
|---|---|---|
| J6.1 | I want a linear static analysis | static step |
| J6.2 | I want natural frequencies and mode shapes (modal), optionally prestressed | frequency step / eigen |
| J6.3 | I want linear buckling load factors and modes | buckle step |
| J6.4 | I want steady-state and transient heat transfer | heat transfer steps |
| J6.5 | I want geometric nonlinearity (large deflection, follower loads) with load stepping and convergence control | NLGEOM, increments, Newton settings |
| J6.6 | I want material nonlinearity (plasticity) with the same controls | same |
| J6.7 | I want implicit transient dynamics (e.g. drop, impulse) and harmonic/frequency response | dynamic implicit, steady-state dynamics |
| J6.8 | I want explicit dynamics for impact/blast/crash | Abaqus/Explicit, LS-DYNA |
| J6.9 | I want to chain steps (preload then modal; thermal then structural) with state carried over | multi-step, predefined fields |
| J6.10 | I want to control what is written out (which fields, how often) so results stay manageable | field/history output requests |
| J6.11 | I want to know that my model is well-posed before I solve (rigid body modes, missing material, unconstrained parts, zero-volume elements) | datacheck; error messages after the fact |

## J7 Solve

| # | Job | Today |
|---|---|---|
| J7.1 | I want to run the solve and see progress (increment, residual, time remaining) and cancel | job monitor |
| J7.2 | I want the solver to keep the UI responsive and to run several jobs | background jobs, queues, HPC |
| J7.3 | I want to be told plainly why a solve failed (singular matrix ↔ unconstrained part; non-convergence ↔ which increment, where) | .msg/.dat files, cryptic |
| J7.4 | I want to restart from a step or change a load and re-run only what changed | restart files |
| J7.5 | I want to choose or trust a linear solver (direct vs iterative) and its precision, and see its cost | solver controls; mostly hidden |
| J7.6 | I want deterministic results (same model, same numbers) so I can regress-test | mostly, but parallel reductions vary |

## J8 Post-process

| # | Job | Today |
|---|---|---|
| J8.1 | I want contour plots of displacement, stress components, von Mises, principal stresses, strain, temperature, on the deformed shape with a scale factor | Visualization module |
| J8.2 | I want to probe values at a point, along a path, or on a face; and the min/max with its location | probe, path plots, extremes |
| J8.3 | I want reaction forces at supports and to check they equal the applied load | RF output, free-body cuts |
| J8.4 | I want XY plots over time/frequency/load factor (history) and over a path | XY data |
| J8.5 | I want mode shapes animated, and transient results as an animation/video | animate |
| J8.6 | I want section cuts and iso-surfaces through solids | view cut |
| J8.7 | I want nodal vs element (integration-point) quantities, averaged/unaveraged, so I understand what I am looking at | averaging options; a common misunderstanding |
| J8.8 | I want derived quantities (safety factor vs yield, utilisation, stress linearisation, fatigue inputs) | field calculator |
| J8.9 | I want to export results (VTU for ParaView, CSV tables, images at set resolution) | export |
| J8.10 | I want to compare two results (before/after a change; two meshes; two materials) side by side or as a difference | overlay plots; manual |

## J9 Verify and validate

| # | Job | Today |
|---|---|---|
| J9.1 | I want to compare against an analytical solution (beam theory, Kirsch plate, Lamé cylinder, Euler buckling, Euler–Bernoulli frequencies) | by hand |
| J9.2 | I want standard benchmarks (NAFEMS LE1/LE10/FV32, Cook's membrane, patch tests) available as ready models with their reference values | vendor verification manuals |
| J9.3 | I want automatic sanity checks: reactions balance loads, energy is consistent, no inverted elements, displacements are small if the analysis is linear | manual |
| J9.4 | I want a mesh-convergence result before I trust a number | manual (J4.6) |
| J9.5 | I want to cross-check with another solver (CalculiX/Abaqus .inp export) | export deck and run elsewhere |
| J9.6 | I want the theory the solver used (element formulation, integration, solver) stated next to the result | theory manuals |

## J10 Parametric studies and optimisation

| # | Job | Today |
|---|---|---|
| J10.1 | I want to sweep a parameter (thickness 5–20 mm) and plot the response | COMSOL parametric sweep; Abaqus Python loop; Ansys DesignXplorer |
| J10.2 | I want a design of experiments over several parameters and a response surface | DesignXplorer, Isight, COMSOL |
| J10.3 | I want to optimise (min mass s.t. stress ≤ limit; topology optimisation) | Tosca, COMSOL Optimization, Ansys |
| J10.4 | I want to reuse a model as a template with different inputs | scripts, COMSOL apps |

## J11 Report and communicate

| # | Job | Today |
|---|---|---|
| J11.1 | I want publication-quality images with legends, units, and consistent views | print/export with fiddling |
| J11.2 | I want a report: assumptions, geometry, materials, mesh (count, quality), loads, results tables, verification, conclusion | Ansys report generator; COMSOL report; Abaqus: manual |
| J11.3 | I want the model to be reproducible from the report (the exact script, the version) | rarely achieved |
| J11.4 | I want to share a model with a colleague/teacher as a link or a small file | .cae/.mph files, tens of MB; links only in cloud CAE |

## J12 Collaborate, manage, reuse

| # | Job | Today |
|---|---|---|
| J12.1 | I want versions of a model and to diff two versions | file copies; COMSOL Model Manager |
| J12.2 | I want to save, reopen, and not lose work | files; autosave |
| J12.3 | I want a library of my own materials, parts, and load cases | user libraries |
| J12.4 | I want to review a colleague's model and see what they did, step by step | read the journal/rpy or click around |

## J13 Automate and extend

| # | Job | Today |
|---|---|---|
| J13.1 | I want to record what I click as a script and replay/edit it | Abaqus .rpy journal; ParaView trace; Blender Info editor |
| J13.2 | I want to drive everything from a script without the UI (batch) | Abaqus Python noGUI; COMSOL Java/MATLAB; PyAnsys |
| J13.3 | When the built-in laws do not describe my material (a research model, a code-specific rule, a company standard), I want to write the constitutive law myself and have the solver call it at every integration point | Abaqus UMAT/VUMAT in Fortran; Ansys USERMAT; LS-DYNA umat; CalculiX umat; COMSOL external material (C) |
| J13.6 | I want to write a custom element, load, or post-processing quantity the same way | Abaqus UEL/DLOAD/UVARM; OpenSees C++ classes |
| J13.7 | I want to bring the Fortran or C++ I already have rather than rewrite it, and to run it on the GPU when it is a per-point law | recompile against the vendor's toolchain; GPU: not available to users |
| J13.8 | I want a result to record exactly which custom code (and version) produced it, and a colleague to be able to load it | not tracked; the .for file lives next to the job if you are lucky |
| J13.4 | I want an AI to build/modify/run/interpret models for me and show me what it did | Blender-MCP-style: only where an API exists |
| J13.5 | I want the script API to be discoverable and typed so I (or the AI) can find the right call without reading a manual | API reference; autocomplete |
| J13.9 | When I talk to the AI, I want to point at things (`@top`, `@steel`, `@result`) instead of describing them, so it acts on exactly what I mean | none; screenshots pasted into chat |
| J13.10 | I want reusable instruction packs (skills: "verify against beam theory", "write the report our way") that I or the AI can invoke | none; prompt copy-paste |
| J13.11 | I want the AI to respect my project's standing rules (an `AGENTS.md` in the project folder: material limits, units, naming, report template) and my project's own skills | none |

## J14 Learn and teach

| # | Job | Today |
|---|---|---|
| J14.1 | I want worked examples that open in one click and explain themselves | tutorials, PDFs |
| J14.2 | I want to understand an error or a warning (what it means, how to fix it) | forums |
| J14.3 | I want to see the effect of a choice immediately (linear vs quadratic tets; coarse vs fine; fixed vs pinned) | re-run |
| J14.4 | I want the theory (weak form, element matrices, solver) alongside the tool, with the notation the course uses | textbooks |

## J15 Interoperate

| # | Job | Today |
|---|---|---|
| J15.1 | I want to import/export meshes (Gmsh .msh, Abaqus .inp, VTK/VTU) and results (VTU, CSV) | meshio, vendor exporters |
| J15.2 | I want to import geometry (STEP, STL) | CAD import |
| J15.3 | I want to hand the model to a bigger solver when it outgrows the browser | export deck |
| J15.4 | I want to export to the formats my colleagues' tools read: VTU, Gmsh .msh, Abaqus .inp, STL/STEP geometry, CSV tables, PNG/SVG images, Markdown/PDF report | per-tool exporters |

## What the incumbents get wrong that we can get right

- **Units**: Abaqus has none; users burn hours on N/mm² vs Pa. Be unit-aware from day one (J1.4).
- **Journaling as an afterthought**: the .rpy is a side effect nobody reads. Make the Journal
  the primary artefact: it *is* the model (J13.1, J12.4, J11.3).
- **Verification is a manual virtue**: build the sanity checks (J9.3) and benchmarks (J9.2)
  into the product, run them in CI, show them in the UI.
- **Well-posedness discovered after a solve** (J6.11): check before, with a message a student
  understands.
- **Sharing is heavy**: a Model is a Journal plus a version, so a link can carry it (J11.4).
- **The AI is bolted on**: because every UI action is a Command, P5 has the same reach as P2
  with no extra work (J13.4).
- **User code is a second-class citizen**: a Fortran file compiled outside the tool, untracked
  by the model, CPU-only. Make Plugins first-class: loaded by a Command, hashed into the
  Journal, runnable on the GPU when the interface allows it (J13.3, J13.7, J13.8).
