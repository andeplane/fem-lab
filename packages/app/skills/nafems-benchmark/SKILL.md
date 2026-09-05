---
name: nafems-benchmark
description: Build a standard NAFEMS or MacNeal–Harder benchmark and compare against its published target value.
when: the person wants to validate the solver, or asks for a benchmark, a patch test or a reference case
---

A benchmark has one published number. Build the case exactly as specified, then report the ratio to
the target — not a description of how the plot looks.

Common cases and their targets:

| Case | What is loaded | Target |
| --- | --- | --- |
| NAFEMS LE1, elliptic membrane | outer edge pressure 10 MPa, plane stress 0.1 m | σ_yy at D = 92.7 MPa |
| NAFEMS LE10, thick plate | pressure 1 MPa on the upper surface | σ_yy at D = −5.38 MPa |
| NAFEMS LE11, solid cylinder / taper / sphere | linear temperature field | σ_zz at A = −105 MPa |
| MacNeal–Harder straight cantilever | unit tip load | tip displacement 0.1081 in (extension 3.0 × 10⁻⁵) |
| MacNeal–Harder curved beam | unit in-plane tip load | tip displacement 0.08734 |
| Cook's membrane | unit shear on the free edge | tip vertical displacement 23.96 |

Method:

1. State the case, its source and the target before you build anything, so the answer cannot drift
   towards the model.
2. Build it with `run_script` in one entry: geometry, material, named face Sets, constraints, load,
   Step. Use the benchmark's own units and convert once, explicitly.
3. Solve, then read the specified quantity at the specified point with `query.probe` — a benchmark
   is about one location, never about a global maximum.
4. Report `computed / target` as a ratio and a percentage. A ratio outside 0.98–1.02 on a
   converged mesh is a finding, not a rounding difference: say so.
5. Add the case to the mesh sweep from `/convergence-study` when the ratio depends on the mesh, and
   report the converged ratio.
