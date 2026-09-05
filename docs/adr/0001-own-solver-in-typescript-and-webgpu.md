---
status: proposed; language choice superseded by ADR 0012 (Rust engine, TypeScript hosts)
date: 2026-09-05
---

# Write our own FEM core instead of porting an existing engine

We want a finite-element editor that runs entirely in the browser, on a static host, with a
typed script API an LLM can drive. No existing engine gets us there: DOLFINx needs MPI and a C
compiler at runtime and nobody has ever built it for wasm; PETSc builds under Emscripten but
only serially and without petsc4py; NGSolve runs in Pyodide but costs 31 MB, a second language
runtime, and a Python API we would have to wrap anyway; scikit-fem is Python-only and slow;
no maintained JS, Rust or wasm FEM library covers 3D solids with a real element library
(research note 01). We therefore write the core ourselves in TypeScript, with WGSL kernels as
template strings, the way the owner's Blast Wall and Flow Defence demos already do, as a
headless library with the browser and Node as hosts (ADR 0011).

## Considered options

- **FEniCSx → wasm.** Months of unmaintained forking (stub MPI, drop HDF5, AOT the FFCx
  kernels or ship clang-in-wasm). Kills the "any PDE" flexibility that is its point.
- **NGSolve in Pyodide.** Works today, but 31 MB, no direct solvers beyond SuperLU, 32-bit,
  LGPL, and every command would still need a TS wrapper for the UI and the AI tools.
- **Rust → wasm + wgpu from scratch.** Same amount of new code, plus a toolchain, plus a
  wasm–JS boundary for every command. Rust-wasm measured 1.0–1.8× faster than typed-array
  JS for dense kernels and ~10 % for element-wise ones (note 02); not worth the boundary.
  Kept as an escape hatch for one thing: a supernodal sparse direct factorisation (faer),
  if a measured bottleneck ever asks for it.
- **TypeScript + WGSL (chosen).** f64 on the CPU where it matters, GPU for the bandwidth-bound
  inner loop, one language for model, commands, UI and tests, 100 % coverage tooling already
  proven in the owner's other demos.

## Consequences

- We own the element library, the solver and, above all, the verification suite. The
  benchmark set (NAFEMS, analytical solutions, patch tests) is not optional; it is the
  substitute for thirty years of someone else's users.
- Scope is set by what one person can verify, not by what FEniCS can express: solids,
  shells later, no arbitrary weak forms.
