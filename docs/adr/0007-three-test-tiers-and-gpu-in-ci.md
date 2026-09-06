---
status: proposed
date: 2026-09-05
---

# Three test tiers, GPU kernels run in CI, and no CPU mirror is ever the oracle

Tests run in three tiers, all on every pull request: (1) vitest in Node on the pure core
(schemas, commands, journal, mesh, assembly, CPU solver) with `coverage.thresholds:
{ 100: true }`; (2) static WGSL validation with no GPU (naga-cli, or compile-and-assert on
`getCompilationInfo()`); (3) the shipped WGSL kernels executed for real on a GPU-less
Ubuntu runner, via dawn.node (npm `webgpu`, MIT, prebuilt linux-x64) or Deno with Mesa
lavapipe, and a Chromium + SwiftShader smoke test of the actual page. The repo's earlier
conclusion that CI cannot run WebGPU was wrong in a specific way: the missing piece was a
Vulkan loader and ICD on the runner, not headless mode (note 02, note 05; dawn.node verified
locally on 2026-09-05 with an axpy kernel).

The Blast Wall lesson stands and becomes a rule: the oracle for a GPU kernel is never a CPU
re-implementation of the same kernel. Oracles are closed-form solutions, conservation laws,
symmetry, patch tests, NAFEMS reference values and observed convergence rates. The pure-TS
f64 solver path is a product feature (no-WebGPU fallback, small problems) and may be
cross-checked against the GPU path, but both are checked against the independent oracles.

## Consequences

- Kernel tests are `*.gpu.test.ts` importing the same WGSL template strings the app ships;
  there is one copy of every shader.
- The GPU job starts `continue-on-error: true` with a `vulkaninfo` pre-flight and is
  promoted to required once green for a week. Software adapters are never used for timing.
- 100 % coverage is a threshold on the core, not a claim about the renderer; the render and
  DOM layers are covered by the browser smoke test and by keeping them thin.

## Status 2026-09-06

The first kernel (`dot.wgsl`, `crates/engine/shaders/`) runs on Metal locally with results
inside the f32 bound and bit-identical across runs for every tested size, and `src/gpu/` is
at 100 % coverage under `--features gpu-tests`. The Chromium + SwiftShader lane runs with the
browser shell.

The 2026-09-06 promotion audit read the job and step conclusions for all 75 completed,
non-cancelled Actions runs recorded since the GPU and Windows lanes first appeared. Windows
completed `cargo test --workspace` successfully in all 64 runs that received a runner, with no
test failure, so #271 makes it required. Eleven runs failed to allocate any runner for Windows,
GPU, Linux and macOS alike and contain zero steps; these are service-level failures rather than
hidden test results.

Lavapipe is not ready for promotion under the week-long rule. Its job completed successfully 57
times, but seven earlier executions failed in the coverage step while that lane's release/debug
instrumentation was being corrected. Since the last executed failure it has 42 successful runs,
from 2026-09-06 01:46 UTC through 07:47 UTC, plus the same eleven service-level no-run failures.
That is hours of evidence, not a week. Issue #19 therefore remains open, the job retains
`continue-on-error: true`, and the required CPU coverage job continues to exclude `src/gpu/` as
its bridge. Re-audit no earlier than 2026-09-13; once a full week is green, make the GPU job
required and remove the CPU exclusion in the same change.
