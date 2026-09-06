---
status: proposed
date: 2026-09-05
---

# Double precision on the CPU wraps a single-precision GPU inner loop

WGSL has no f64 and none is planned (gpuweb #2805, still open; Chrome lead in 2025: work
"hasn't started"), and it has no float atomics. Implicit FEM systems have condition numbers
of 1e6–1e10, at which an all-f32 solve is not a solve. So the architecture is fixed by the
platform: the mesh, the assembly, boundary conditions, residuals, norms, convergence tests
and any direct factorisation run in f64 on the CPU; the GPU runs the f32 operator
(matrix-free or CSR SpMV), the preconditioner and the vector kernels inside a
preconditioned CG, wrapped in an f64 iterative-refinement loop (Göddeke–Strzodka–Turek 2007;
arXiv 2510.11379 shows a low-precision preconditioner does not cap attainable accuracy).
Explicit dynamics stays pure f32 on the GPU, which is the industry norm.

## Consequences

- Small systems (under roughly 10k DOF) never go to the GPU; per-dispatch overhead of
  30–70 µs dominates. A pure-TS f64 path must exist anyway for browsers without WebGPU, so
  it doubles as the small-problem path and as the independent oracle for the GPU path.
- Assembly on the GPU gathers or colours; it never scatters with atomics.
- Emulated double (df64) is not used in the operator. WGSL may reassociate and fuse, which
  breaks the Dekker/Thall tricks on Metal (luma.gl fell back to integer limbs). At most it
  is used for on-GPU reductions.
- Request the adapter's real limits at device creation. Defaults are 128 MiB per binding and
  256 MiB per buffer; a 1M-DOF CSR matrix in f32 is ~650 MB. Desktop adapters offer 1–4 GiB.

## Status, 2026-09-06

Shipped as `solve/{pcg,refine}.rs` and `gpu/cg.rs` with `shaders/{spmv_csr,cg_vec}.wgsl`. The
recipe is unchanged: symmetric Jacobi scaling on the CPU (so the GPU preconditioner is the
identity), plain f32 CG with α and β on the device, 25 iterations per submit, f64 refinement
outside. `Auto` sends a system to `cpu-direct` up to 200 000 equations (100 000 on wasm32),
then to `gpu-pcg` if the host granted a device and `cpu-pcg` if it did not.

Measured on an Apple M4 Max (Metal), the 66k-DOF `[50,20,20]` hex8 cantilever:

| Path | Iterations | Relative residual | Time (release) |
|---|---|---|---|
| `cpu-direct` (faer LLᵀ) | one factorisation | exact | 1.5 s |
| `gpu-pcg` | 8 refinement steps × 5000 inner CG | 4.8e-10 | 4.3 s |
| `cpu-pcg` on B1 `[8,2,2]`, 216 equations | 2 refinement steps | < 1e-10 | ms |

Two things the plan did not anticipate:

- **The inner tolerance does not bind.** f32 CG on the scaled 66k system never reaches even
  1e-2 in its own norm; it is always iteration-limited, and `inner_tol` from 1e-2 to 1e-5 gives
  the same result. The knob that matters is `max_iterations`.
- **The residual has a floor.** `‖b − Kx‖/‖b‖` is itself f64, so it bottoms out near
  `ε·κ(K)` — 4.8e-10 here, against a requested 1e-10, and no number of refinement steps gets
  under it. `refine` therefore accepts a residual that has stopped falling within a factor of
  100 of the tolerance as converged and reports what it reached; further out it is still
  `solve.stalled`, naming `cpu-direct`.

At 66k DOF the GPU is not yet faster than the direct factorisation, which is what the first
consequence above already said: this size is below where the GPU pays.

**The Jacobi preconditioner runs out at D5's own size.** The 780 300-DOF `[100,50,50]` cantilever
(κ ≈ 1e8) does *not* converge: 5000 f32 CG iterations leave a correction worse than no
correction at all, the residual grows to 1.5e4, and refinement stops after three steps with
`solve.stalled` naming `cpu-direct` — which is exactly the fall-through plan A's R3 specified.
So the recipe above is right and the *preconditioner* is what is missing; an aggregation or
Chebyshev preconditioner (PLAN 2.2) is the next step, and this number is what it has to beat.
The `#[ignore]` test prints the outcome and asserts nothing, so the day it converges is a
number in a log.

One operational consequence: D5's CI sibling is 40 000 f32 CG iterations and one 66k-DOF
Cholesky — 4 s in `--release` on Metal, 218 s for the whole `gpu_kernels` binary under
`cargo llvm-cov` (instrumented debug) and ten minutes on lavapipe. Measuring coverage in
release was tried and mis-attributes inlined functions (99 % on code that ran), so the
coverage job stays in debug and the sibling is `#[ignore]`d out of it; the `gpu` job runs it
on its own in release afterwards (`cargo test --release … -- --ignored sixty_six`).
