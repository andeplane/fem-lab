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
