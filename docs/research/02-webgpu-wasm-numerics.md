# 02 — Numerical foundations for a browser FEM solver: WebGPU, WebAssembly, and the Rust/C++ linear-algebra ecosystem

Research note, 2026-09-05. Primary sources preferred (W3C/gpuweb specs, MDN, browser
release notes, wgpu/Dawn/Deno repos, papers). Where a claim could not be verified this
session it is marked **not verified** or **not found**. The search budget ran out before
every secondary claim could be chased; those are flagged.

## Executive summary

1. **WGSL has no f64 and none is coming soon.** The only numeric scalars are `i32`, `u32`,
   `f32`, and `f16` (behind `shader-f16`). gpuweb issue #2805 (opened 2022) is still open on
   "Milestone 4+"; the Chrome WebGPU lead wrote in Aug 2025 that work "hasn't started yet",
   that it is "a huge amount of work", and that consumer GPUs run f64 ~8x slower anyway.
2. **No float atomics.** `atomic<T>` only takes `i32`/`u32`. GPU assembly must gather
   (as Blast Wall already does), colour, or use integer fixed-point atomics.
3. **f32-only GPU is *not* a showstopper for implicit FEM, but it dictates the architecture:**
   use the GPU for the f32 inner solve (PCG / AMG-ish preconditioner, matrix-free or CSR SpMV)
   and keep an f64 outer loop on the CPU — iterative refinement, residuals, norms, and any
   direct factorisation. This is exactly the Göddeke–Strzodka–Turek 2007 recipe, and the
   recent error analysis (arXiv 2510.11379) says a low-precision preconditioner does not
   degrade the attainable accuracy when the outer PCG runs in working precision.
4. **Emulated double (df64) in WGSL is possible but fragile:** ~48 significand bits, more than
   an order of magnitude slower than f32, and WGSL's permission to reassociate/fuse means
   the classic Dekker/Thall two-float tricks are unreliable on Metal; luma.gl had to fall back
   to bit-twiddling integer implementations on Apple adapters. Reserve it for reductions
   (dot products, residual norms), not for the whole solve.
5. **Explicit dynamics in f32 is industry standard** (LS-DYNA: double costs ~30 % and is
   recommended mainly for implicit or >200k-cycle runs), so Blast Wall's approach stands.
6. **Default WebGPU limits are small but requestable**: 128 MiB storage binding, 256 MiB
   buffer, 8 storage buffers/stage, 65 535 workgroups/dim, 256 invocations/workgroup.
   Real adapters (web3dsurvey) offer 1–2 GiB buffers on ~78–100 % of desktop devices.
   Always `requestDevice` with the adapter's limits.
7. **Browser support (Sep 2026)**: Chrome 113+ desktop, 121+ Android, Linux 144+/147+ per
   GPU vendor; Safari 26 (Sep 2025) on macOS/iOS/iPadOS/visionOS; Firefox 141 Windows
   (Jul 2025), 145/147 macOS Apple Silicon, Linux still Nightly, Android behind flag.
8. **CI**: Chrome headless with SwiftShader (`--use-webgpu-adapter=swiftshader` +
   `--enable-unsafe-webgpu` + Vulkan flags + `libvulkan1 mesa-vulkan-drivers`) exposes a
   software adapter; Deno still needs `--unstable-webgpu`; npm `webgpu` (dawn.node) works
   headless and can point `VK_ICD_FILENAMES` at lavapipe. wgpu's own CI runs on Mesa
   lavapipe/llvmpipe (Linux) and WARP (Windows).
9. **Wasm**: wasm32 = 4 GiB; Memory64 shipped Chrome 133/Firefox 134 (Jan 2025) with a
   16 GiB JS-API cap and a 10 %–2x slowdown from bounds checks; Safari status **not
   verified**. Threads need COOP/COEP; GitHub Pages cannot set headers; `coi-serviceworker`
   works with a first-load reload and same-origin script constraints.
10. **Libraries**: faer 0.24 (pure Rust, Jun 2026) has real sparse LLT/LDLT/LU/QR with AMD/
    COLAMD and supernodal paths and compiles to wasm; Eigen builds under Emscripten with
    `EIGEN_DONT_VECTORIZE`; CHOLMOD has been built to wasm by hand (Aug 2025) with size_t
    pain; MUMPS/PARDISO/PETSc to wasm: **not found**. OpenBLAS-in-wasm is ~10x slower than
    native (single-thread, no SIMD).
11. **TypeScript is competitive** for assembly and sparse CG (Rust-wasm measured 1.0–1.84x
    faster than typed-array JS for dense matmul; wasm+SIMD only 10–12 % faster on
    element-wise kernels). For a sparse direct Cholesky, expect wasm (faer) to be perhaps
    1.5–2x faster than TS. **Recommended split**: TS (f64) for mesh, assembly, outer
    refinement, small direct solves; WGSL (f32) for SpMV/matrix-free operator,
    preconditioner, and vector ops; add Rust→wasm only if a sparse direct factorisation
    becomes a measured bottleneck.

---

## 1. WebGPU / WGSL numerics and platform status

### 1.1 Scalar types, f64, f16, atomics

- WGSL numeric scalar types are `i32`, `u32`, `f32`, and `f16` (extension). There is no f64
  anywhere in the spec ([WGSL spec](https://www.w3.org/TR/WGSL/)).
- **f64 proposal**: [gpuweb/gpuweb#2805](https://github.com/gpuweb/gpuweb/issues/2805),
  opened 2022-04-28, still **open**, label `wgsl`, milestone "Milestone 4+", 10 comments,
  last activity 2025-12-15. Kangz (Chrome WebGPU lead), 2025-08-25: "This hasn't started yet
  ... it is a huge amount of work to add (in part to determine the precision of every single
  builtin) and the feature is not as available on HW as others ... on consumer GPU the rate
  of computation with f64 is often much slower than for f32 (8x slower is usual)." Metal
  has no f64 at all, which is the portability blocker behind "not as available".
- **shader-f16**: shipped in Chrome 120 ([Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/AsKn-UwMYAE));
  [webgpu.report](https://webgpu.report/features/shader-f16) reports ~95 % adapter availability.
  Irrelevant to FEM accuracy but useful for the bandwidth of visualisation data.
- **subgroups**: proposal status "Merged" ([proposals/subgroups.md](https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroups.md));
  shipped without flag in Chrome 134 (2025-02-26,
  [Chrome blog](https://developer.chrome.com/blog/new-in-webgpu-134)); `subgroups-f16` folded
  in. [webgpu.report](https://webgpu.report/features/subgroups) (last 30 days, n=123):
  Chrome 93 %, Edge 100 %, **Firefox 0 %**. Requires Vulkan 1.1 + SPIR-V 1.3, Metal
  Apple7+/Mac2, D3D12 SM6.0 with WaveOps. Useful for dot-product reductions in CG; must
  have a plain workgroup-reduction fallback.
- **Atomics**: `atomic<T>` with T ∈ {`i32`, `u32`} only; functions `atomicLoad/Store/Add/Sub/
  Max/Min/And/Or/Xor/Exchange/CompareExchangeWeak` ([WGSL atomic types](https://www.w3.org/TR/WGSL/#atomic-types)).
  **No f32 atomicAdd.** Options: gather (deterministic; Blast Wall does this — see
  `src/content/projects/blast-wall.ts`: "forces are gathered rather than scattered (WGSL has
  no float atomics, and gathering is deterministic anyway)"), graph colouring of elements,
  or fixed-point i32 atomics with a scale factor.
- **Floating-point semantics**: WGSL allows reassociation and fusion (fma contraction) and
  does not specify a single rounding mode; luma.gl documents that this breaks Dekker-style
  error-free transforms ([luma.gl precision guide](https://luma.gl/docs/api-guide/shaders/gpu-floating-point-precision)).
  Also relevant for reproducibility: sums over elements are not bitwise reproducible unless
  the summation order is fixed (gather achieves this).

### 1.2 Limits: default vs typical adapters

Defaults from [MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits)
and the [WebGPU spec](https://gpuweb.github.io/gpuweb/#limits); distributions from
[web3dsurvey](https://web3dsurvey.com/webgpu/limits/maxBufferSize).

| Limit | Spec default | Typical adapter (2026) | Notes |
|---|---|---|---|
| `maxBufferSize` | 268 435 456 (256 MiB) | 1 GiB on 100 % of Windows/Android surveyed; 2 147 483 647 on 78 % overall (65 % macOS, 92 % Windows); iOS tops out at 1 GiB on 76 % | Chrome error hints report e.g. "supports a higher maxBufferSize of 4294967296" ([Chrome 133 blog](https://developer.chrome.com/blog/new-in-webgpu-133)) |
| `maxStorageBufferBindingSize` | 134 217 728 (128 MiB) | 256 MiB on 97 %, 512 MiB on 94 %, 1 GiB on ~90 %, ~2 GiB on 16 % overall; Android tops out at 1 GiB on 36 % | A 1M-DOF CSR f32 matrix (~80 nnz/row → ~650 MB values+indices) will not fit one default binding; split or raise |
| `maxStorageBuffersPerShaderStage` | 8 | Chrome ≥120 lets you request up to 10 ([Chrome 120 blog](https://developer.chrome.com/blog/new-in-webgpu-120)); Chrome 146 raised the ceiling to 16 on some platforms, but a user still saw 10 on an M4/Metal ([gpuweb#4235](https://github.com/gpuweb/gpuweb/issues/4235), Apr 2026) | Pack arrays into fewer, larger buffers (Blast Wall's "three arenas") |
| `maxComputeWorkgroupsPerDimension` | 65 535 | universally 65 535 | Use 2-D dispatch or grid-stride loops above 65 535 × 256 = 16.7 M threads |
| `maxComputeInvocationsPerWorkgroup` | 256 | 256; up to 1024 requestable on most desktop adapters | |
| `maxComputeWorkgroupSizeX/Y/Z` | 256 / 256 / 64 | | |
| `maxComputeWorkgroupStorageSize` | 16 384 B | 32 KiB commonly requestable | Limits shared-memory element blocks |
| `maxBindGroups` | 4 | | |
| `maxBindingsPerBindGroup` | 1000 (spec; MDN page still lists 640) | | |
| `maxUniformBufferBindingSize` | 65 536 | | |
| `maxStorageBuffersInVertexStage` / `InFragmentStage` | 0 / 4 (compat-mode limits added to spec) | | ([gpuweb#5103](https://github.com/gpuweb/gpuweb/issues/5103)) |

Apple M-series specifics: [webgpureport.org](https://webgpureport.org) reads your own
adapter; a citable per-chip table was **not found** this session. The web3dsurvey macOS
column (2 147 483 647 on 65 %) is consistent with Apple Silicon reporting `maxBufferSize`
≈ 2–4 GiB. Always check `adapter.limits` and pass them into `requestDevice`.

### 1.3 Browser support (as of Sep 2026)

From the [gpuweb Implementation Status wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
unless noted:

- **Chrome/Edge (Dawn)**: macOS/Windows/ChromeOS 113+; Android 121+ (ARM/Qualcomm/Intel,
  Android 12+), Imagination 139+, Samsung Xclipse est. 154; Linux Intel Gen12+ 144+, NVIDIA
  (driver ≥535.183.01, Wayland) 147+, others behind flag; Windows ARM64 behind flag.
- **Safari (WebKit)**: shipped in Safari 26.0 for macOS, iOS, iPadOS, visionOS, Sep 2025
  ([WebKit blog](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)). Which
  optional features (shader-f16, subgroups) Safari exposes: **not verified**.
- **Firefox (wgpu)**: Windows in 141 (2025-07-22,
  [Mozilla Gfx blog](https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/));
  macOS 26 on Apple Silicon in 145 (2025-11-11,
  [release notes](https://www.firefox.com/en-US/firefox/145.0/releasenotes/)); all macOS
  versions on Apple Silicon in 147 (2026-01-13); Intel Macs Nightly; **Linux Nightly, release
  expected 2026**; Android behind flag. The 141 blog lists known gaps: IPC overhead (fixed in
  142), timer-based completion latency, missing `importExternalTexture`.

### 1.4 Headless / CI WebGPU

- **Chrome headless + SwiftShader**: [agent-browser.dev/webgpu](https://agent-browser.dev/webgpu)
  documents a working Linux preset: `--enable-unsafe-webgpu --enable-features=Vulkan
  --use-angle=vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader
  --disable-vulkan-surface`, and states "The SwiftShader Vulkan path needs the system Vulkan
  loader and Mesa ICD. Without them `requestAdapter()` returns `null`" (install `libvulkan1
  mesa-vulkan-drivers`). "SwiftShader is a CPU rasterizer" — fine for correctness, not for
  timing. `--use-webgpu-adapter=swiftshader` is confirmed as a Chromium switch in
  [electron/electron#38189](https://github.com/electron/electron/issues/38189). Chromium's
  SwiftShader doc only covers WebGL/GL and says WebGL-on-SwiftShader fallback is deprecated
  ([swiftshader.md](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)).
- **Puppeteer gotchas** ([tigerabrodi blog](https://tigerabrodi.blog/how-to-get-webgpu-in-headless-chrome-on-cloud-gpus)):
  Puppeteer injects `--use-angle=swiftshader-webgl`, which overrides `--use-angle=vulkan` →
  pass `ignoreDefaultArgs: ["--use-angle=swiftshader-webgl"]`; `about:blank` is not a secure
  context, `http://localhost` is; Dawn has its own adapter blocklist
  (`--enable-dawn-features=disable_adapter_blocklist`).
- Chrome's Jan-2024 recipe for GPU-equipped Linux CI: `--no-sandbox --headless=new
  --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --enable-unsafe-webgpu`
  ([Chrome blog](https://developer.chrome.com/blog/supercharge-web-ai-testing)); official
  `requestAdapter()===null` checklist at
  [developer.chrome.com](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips).
  This repo's memory note "WebGPU verification loop" already warns not to trust
  `--virtual-time-budget` screenshots.
- **Deno**: `navigator.gpu` exists but is still behind `--unstable-webgpu` / `"unstable":
  ["webgpu"]` as of Deno 2.9.6 (2026-08-27) ([unstable flags](https://docs.deno.com/runtime/reference/cli/unstable_flags/),
  [compute example](https://docs.deno.com/examples/webgpu_compute/)). Implementation is wgpu
  (`deno_webgpu`). Known breakages: Deno 2.0.0 panicked on `requestAdapter()` ("Unexpected
  backend Gl", Windows Intel HD 4600, fixed by PR #26206,
  [deno#26144](https://github.com/denoland/deno/issues/26144)); 2.2 surface regression
  ([deno#28207](https://github.com/denoland/deno/issues/28207)). Deno + lavapipe on Linux CI
  end-to-end: **not directly verified**; wgpu installs Mesa on Ubuntu runners (`install-mesa`
  step in [wgpu ci.yml](https://github.com/gfx-rs/wgpu/blob/trunk/.github/workflows/ci.yml))
  and lavapipe is a normal Vulkan ICD, so it should work via `VK_ICD_FILENAMES`.
- **Node: npm `webgpu` (dawn.node)** ([dawn-gpu/node-webgpu](https://github.com/dawn-gpu/node-webgpu)):
  `import { create, globals } from 'webgpu'`; `create(['backend=vulkan'])`,
  `create(['adapter=...'])`, `enable-dawn-features=allow_unsafe_apis,...`. Headless only (no
  canvas). The Dawn node README shows running the CTS on software Vulkan with
  `VK_ICD_FILENAMES=<build>/lvp_icd.json` (lavapipe) or `vk_swiftshader_icd.json`
  ([dawn/node README](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/node/README.md)).
  npm version/date: page returned 403 — **not verified**.
- **Practical CI verdict**: the same WGSL runs under Node (dawn.node) or Deno (wgpu) on a
  GPU-less Ubuntu runner with `mesa-vulkan-drivers`, and under headless Chrome with
  SwiftShader. Use the Node path for numerical unit tests (fast start, no browser), keep a
  Chrome+SwiftShader smoke test for the real page. Never benchmark on software adapters.

## 2. Getting double precision out of an f32 GPU

### 2.1 Emulated double (double-single / df64)

- Thall, "Extended-Precision Floating-Point Numbers for GPU Computation" (2006,
  [PDF](https://andrewthall.org/papers/df64_qf128.pdf)): df64 = unevaluated sum of two f32
  → ~48 significand bits at f32 exponent range; qf128 → ~96 bits. Tested on GeForce 6800/
  7900/8800. Key warning (p. 4): the fast FMA-based `twoProd` "does not correctly yield the
  df64 product and error term, due as expected to the aggressive optimization of the Cg
  compiler", so the longer Dekker split is used. Cost: twoSum ≈ 6 flops, Dekker twoProd ≈
  17 flops; a df64 multiply ≈ 20+ f32 ops, add ≈ 10–20.
- Rule-of-thumb throughput (secondary): df64 ≈ 40 % of f32 rate vs ~1/64 for native f64 on
  consumer GPUs ([arrayfire#1886](https://github.com/arrayfire/arrayfire/issues/1886)).
  luma.gl states emulated 64-bit "costs significantly more GPU cycles than native 32-bit math
  (more than an order of magnitude)" ([luma.gl fp64](https://luma.gl/docs/api-reference/shadertools/shader-modules/fp64)).
- **WGSL implementation exists**: luma.gl `fp64arithmetic` (add/sub/mul/div/sqrt in GLSL and
  WGSL, `vec2f` representation). Because WGSL permits reassociation and fma contraction, on
  Apple adapters luma.gl decodes f32 into sign/exponent/significand and does TwoSum/TwoProd/
  renormalisation with explicit `u32` limbs ("integer-controlled"), overridable via
  `LUMA_FP64_INTEGER_ARITHMETIC`; precision "up to about 48 binary digits, about 14 decimal
  digits"; cost "higher than classic double-single; implementation-dependent"
  ([luma.gl precision guide](https://luma.gl/docs/api-guide/shaders/gpu-floating-point-precision)).
  The same guide notes WGSL's `fma` does not provide "the portable, correctly rounded
  fused-operation contract that Dekker-style TwoProd would need".
- **Verdict**: df64 is a tool for *reductions* (dot products, residual norms, energy sums)
  and for coordinates with large offsets, not for the whole SpMV/CG. Even then, without a
  no-contract guarantee you must either use the integer-limb path or validate per adapter.

### 2.2 Mixed precision / iterative refinement for FEM

- Göddeke, Strzodka, Turek, "Performance and accuracy of hardware-oriented native-,
  emulated- and mixed-precision solvers in FEM simulations", IJPEDS 22(4), 2007
  ([tandfonline](https://www.tandfonline.com/doi/full/10.1080/17445760601122076)): residuals
  and solution updates in double on CPU, residual systems solved in single on GPU with CG and
  multigrid; double-precision accuracy is recovered; speedup ≈1.7x vs double-only
  (second-hand summary; original tables paywalled). Part 2 (Göddeke & Strzodka 2008) covers
  double-precision GPUs.
- Error analysis: "Forward and backward error bounds for a mixed precision preconditioned
  conjugate gradient algorithm" ([arXiv:2510.11379](https://arxiv.org/abs/2510.11379)):
  PCG attains relative backward error O(u) and relative forward error O(u)·κ(A)^{1/2} in the
  working precision u, and "applying preconditioners in low precision does not compromise
  the accuracy of the final results, provided that reasonable conditions are satisfied".
  For us: outer PCG (or refinement) in f64 on CPU, preconditioner/inner solve in f32 on GPU,
  is theoretically sound. See also adaptive mixed-precision PCG
  ([arXiv:2505.04155](https://arxiv.org/pdf/2505.04155)).
- "Mixed Precision Algebraic Multigrid on GPUs" (Springer 2023,
  [link](https://link.springer.com/chapter/10.1007/978-3-031-30442-2_9)) — a low-precision
  AMG hierarchy as preconditioner is accepted practice.

### 2.3 How badly does f32 hurt implicit FEM?

- κ(K) ~ h^-2 for second-order elliptic problems (Poisson, elasticity) on quasi-uniform
  meshes; mass matrix κ bounded ([survey in arXiv:1406.6808](https://arxiv.org/pdf/1406.6808),
  [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0898122120302169)).
  Elasticity adds factors for ν → 0.5, element aspect ratio, and material contrast; thin
  shells/beams are far worse than h^-2. Typical 3-D meshes land at κ ≈ 1e6–1e10.
- With u_f32 ≈ 6e-8: a *direct* solve in f32 has forward-error bound κ·u ≈ 6e-2…6e2 for
  κ = 1e6…1e10 — useless above κ ≈ 1e6. For *PCG* the O(u)·κ^{1/2} bound gives
  6e-5…6e-3 relative — marginal for stresses at the high end. So f32 alone is fine for
  coarse meshes and as an inner solver, not as the final answer on fine 3-D meshes.
- Mitigations: (a) non-dimensionalise (E→1, L→1) so K entries are O(1); (b) Jacobi scaling
  D^{-1/2} K D^{-1/2} before f32; (c) f64 outer refinement — 2–3 outer iterations recover
  f64 accuracy when the inner solve is accurate to ~1e-4 (Göddeke et al.).
- **Explicit dynamics**: LS-DYNA support says "Double precision run times will be
  approximately 30% longer than single precision", single is the common explicit default,
  double is advised "where number of cycles (timesteps) is large, e.g., over 200,000
  timesteps" and for implicit ("more sensitive to numerical roundoff")
  ([dynasupport](https://www.dynasupport.com/howtos/general/double-precision)). Blast
  Wall's f32 corotational explicit scheme is in the accepted regime; a long
  settle-under-gravity phase can approach the cycle-count caveat.

## 3. Sparse solvers on GPU for FEM

### 3.1 Iterative solvers and preconditioners

- **PCG + Jacobi** is the baseline: one SpMV, two dot products, three AXPYs per iteration;
  iterations ~ O(κ^{1/2}) = O(h^{-1}). Jacobi is embarrassingly parallel; SSOR/IC(0) need
  level scheduling or colouring on GPU (AmgX uses graph colouring for Gauss–Seidel/ILU).
- **AMG on GPU**: AmgX (Naumov et al., SISC 37(5), 2015,
  [NVIDIA](https://research.nvidia.com/publication/2015-10_amgx-library-gpu-accelerated-algebraic-multigrid-and-preconditioned-iterative))
  — classical and aggregation AMG, parallel graph matching for aggregation, colouring for
  smoothers; "2-5x speedup on a single GPU against a competitive implementation on the
  CPU". hypre BoomerAMG GPU port (Falgout, Li, Sjögreen, Wang, Yang, Parallel Computing
  2021, [OSTI](https://www.osti.gov/servlets/purl/1860740)) — new memory model, modularised
  BoomerAMG; aggressive coarsening that helps CPUs is "not as effective for GPUs"
  ([hypre#120](https://github.com/hypre-space/hypre/issues/120)). For a browser, plain or
  smoothed aggregation AMG with Jacobi/Chebyshev smoothing is the realistic target;
  classical Ruge–Stüben setup on GPU is a research project.
- **Matrix-free**: Ljungkvist 2014 (atomics vs mesh colouring for conflicting updates,
  [Springer](https://link.springer.com/chapter/10.1007/978-3-319-14313-2_38)); Kronbichler
  & Ljungkvist, ACM TOPC 2019 ([ACM](https://dl.acm.org/doi/10.1145/3322813)): matrix-free
  geometric multigrid with sum-factorisation on P100/V100 reaching 375–430 GB/s and ~400
  GFLOP/s on P100, ~2x over multi-core Broadwell; 80 % efficiency needs ≥3–4e5 DoF per GPU
  (via the Frontiers 2025 review,
  [PDF](https://www.frontiersin.org/journals/high-performance-computing/articles/10.3389/fhpcp.2024.1303358/pdf)).
  For low-order hex/tet elasticity the operator is a 24×24 (hex8) or 12×12 (tet4) block per
  element; Blast Wall already has "exactly one 24×24 stiffness matrix for the whole wall"
  because every element is the same box — the ideal matrix-free case.
- Kiran et al. 2024, IJNME ([Wiley](https://onlinelibrary.wiley.com/doi/10.1002/nme.7421)):
  GPU matrix-free CG for large-scale elastoplasticity; numbers **not retrieved** (403). An
  image-based PCG study ([ScienceDirect 2022](https://www.sciencedirect.com/science/article/abs/pii/S0045782522003978))
  reports ~500 M-DOF elasticity/heat solves "taking seconds or a few minutes per system
  solve" on a CUDA workstation.

### 3.2 Assembly strategies on GPU

- Cecka, Lew, Darve, "Assembly of finite element methods on graphics processors", IJNME
  85:640–669 (2011, [Wiley](https://onlinelibrary.wiley.com/doi/10.1002/nme.2989)): for
  low-order elements store element data in shared memory and assign threads to *non-zero
  entries* (gather); for high-order use one thread per element with parallel reduction.
- AD-based GPU FEM ([arXiv:2602.12365](https://arxiv.org/html/2602.12365v1)): scatter-add
  (atomics) throughput "decreases with increasing degrees of freedom due to memory access
  bottlenecks and atomic contention", while matrix-free/gather throughput is constant.
  Warp-based colouring assembly: [JCDE 2018](https://doi.org/10.1016/j.jcde.2018.11.001).
- **WebGPU-specific**: no float atomics forces gather or colouring anyway. Gather (node →
  incident elements via a CSR-like adjacency) is deterministic and matches Blast Wall. For
  CSR *matrix* assembly, precompute per nnz the list of (element, local i, local j)
  contributions once on the CPU (mesh is static), then one thread per nnz sums them — this
  is Cecka's low-order recipe and reuses the gather map.

### 3.3 What is realistic in a browser on Apple M2-class hardware?

Back-of-envelope, labelled as such. Bandwidth figures are Apple's published specs, not
re-verified this session (M2 ≈ 100 GB/s, M2 Pro 200, M2 Max 400); WebGPU-on-Metal
streaming kernels get a good fraction of that.

- 1 M DOF 3-D elasticity (≈ 340 k nodes, ~40 k–170 k hex8/tet4 elements): CSR f32 with
  ~81 nnz/row → 81 M nnz × (4 B value + 4 B index) ≈ 650 MB. Exceeds the 128 MiB default
  binding and the 256 MiB default buffer; needs raised limits (available on Apple Silicon),
  chunking into ≤128 MiB bindings, or matrix-free.
- One CSR SpMV ≈ 650 MB traffic → ~6.5 ms at 100 GB/s; a PCG iteration ≈ 8–10 ms including
  vectors and dispatch overhead. Jacobi-PCG on an h ≈ 1/70 mesh may need 1 000–3 000
  iterations → **10–30 s** per solve on an M2; ~3–8 s on M2 Max; with a decent AMG
  preconditioner (~30–80 iterations, each ~3x costlier) → **1–3 s**. Matrix-free hex8 with a
  shared 24×24 K_e reads only 8 node ids + 24 displacements per element (~100 B/elem vs
  ~1.6 kB/elem of CSR rows) and becomes compute-bound; Kronbichler/Ljungkvist see 2–4x per
  iteration over CSR for low order, so Jacobi-PCG in ~3–10 s.
- Dispatch overhead: WebGPU costs 24–36 µs per dispatch on Vulkan and 32–71 µs on Metal
  ([arXiv:2604.02344](https://arxiv.org/abs/2604.02344), Feb 2026); a CG iteration with ~8
  dispatches → ~0.3–0.5 ms overhead, negligible above ~50 k DOF but dominant for small
  systems (keep <10 k-DOF solves on the CPU). Never read dot products back per iteration —
  check convergence on-GPU every k iterations or read back asynchronously.
- WebGPU vs native: wgpu on M3 Max ran a compute workload 1.65–2x slower than a direct
  Vulkan/Metal path (wgpu v23–v25), while on an A100 wgpu was 20 % *faster* than the
  author's Vulkan code ([wgpu discussion #6688](https://github.com/gfx-rs/wgpu/discussions/6688));
  a torch-on-WebGPU port reached 11–12 % of CUDA on the same GPU at batch size 1, dominated
  by per-dispatch overhead ([arXiv:2604.02344](https://arxiv.org/abs/2604.02344)). For
  bandwidth-bound SpMV expect browser WebGPU within ~1.2–2x of native.

## 4. WebAssembly side

- **wasm32**: 4 GiB linear memory max (32-bit pointers); Emscripten's `MAXIMUM_MEMORY=4GB`
  is the ceiling ([emscripten#20946](https://github.com/emscripten-core/emscripten/issues/20946)).
- **Memory64**: shipped in Chrome 133 and Firefox 134 (Jan 2025)
  ([SpiderMonkey blog, 2025-01-15](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html),
  [chromestatus](https://chromestatus.com/feature/5070065734516736)). The JS API caps
  Memory64 at **16 GiB**. Cost: bounds checks can no longer be elided via 4 GiB guard
  regions → "from just 10% to over 100%—a 2x slowdown just from changing your pointer
  size"; recommendation: "The only reason to use Memory64 is if you actually need more than
  4GB". Safari: **not verified** (search results contradictory).
- **SIMD128**: universal since 2021 (Chrome 91, Firefox 89, Safari 16.4). **Relaxed SIMD**:
  Chrome 114+, Firefox 146+ (another source says 145), Safari **not supported** per
  [caniuse](https://caniuse.com/wf-wasm-simd-relaxed); relaxed FMA is the one instruction
  FEM kernels would want. Rust: `-C target-feature=+simd128` and `std::arch::wasm32`.
- **Threads** need `SharedArrayBuffer` → cross-origin isolation (COOP `same-origin` + COEP
  `require-corp`/`credentialless`). GitHub Pages cannot set headers
  ([community discussion #13309](https://github.com/orgs/community/discussions/13309)).
  Workaround [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker): a service
  worker injects the headers; "This script will reload the page on the user's first load";
  must be a separate file, served same-origin (no CDN), HTTPS or localhost; supports
  `credentialless` with fallback to `require-corp`. Consequences: every cross-origin
  subresource (fonts, images, KaTeX from a CDN, iframes) must be CORP/CORS-clean or rely on
  `credentialless`; the first visit flashes. Thomas Steiner's 2025 write-up confirms
  service-worker headers are honoured
  ([blog.tomayac.com](https://blog.tomayac.com/2025/03/08/setting-coop-coep-headers-on-static-hosting-like-github-pages/)).
  Alternative: host on Cloudflare Pages/Netlify/Vercel where `_headers` works. The GPU path
  needs none of this — WebGPU does not require cross-origin isolation.
- **Performance vs native**: Jangda et al., USENIX ATC'19, "Not So Fast": SPEC CPU in wasm
  ran 45 % (Firefox) to 55 % (Chrome) slower on average, peaks 2.08x / 2.5x, due to register
  pressure, extra branches, and bounds checks ([USENIX](https://www.usenix.org/conference/atc19/presentation/jangda)).
  For BLAS specifically, OpenBLAS built with Emscripten (Pyodide) is 2–3x faster than
  reference BLAS but "around 10x slower than almost the same OpenBLAS version built for a
  modern x86-64 CPU (single-threaded)" — single-thread, no SIMD, `TARGET=RISCV64_GENERIC`
  ([OpenBLAS#4023](https://github.com/OpenMathLib/OpenBLAS/issues/4023), Apr 2023). f64 is
  native in wasm, so scalar f64 code is a fair 1.5–2.5x off native; hand-vectorised native
  BLAS is where wasm loses badly.
- **Per-tab memory**: V8's JS heap limit is ~4 GB per renderer on 64-bit
  ([Chromium issue 41133247](https://issues.chromium.org/issues/41133247), content not
  readable without sign-in — treat as secondary); wasm linear memory is separate from the JS
  heap (4 GiB wasm32, 16 GiB Memory64 cap). GPU buffers are separate again. Practical:
  plan for ≤2 GiB wasm heap + ≤2 GiB GPU on a 16 GB Mac.

## 5. Rust and C++ numerical libraries that reach wasm / WebGPU

### 5.1 Sparse direct and dense (CPU, wasm)

| Library | Sparse capability | wasm | Notes |
|---|---|---|---|
| **faer** 0.24.4 (Rust, 2026-06-24, [docs](https://docs.rs/faer/latest/faer/sparse/linalg/index.html)) | CSC/CSR; Cholesky LLᵀ / LDLᵀ / LBLᵀ (Bunch–Kaufman), LU, QR; **simplicial and supernodal** (`SupernodalThreshold`); AMD and COLAMD orderings; symbolic/numeric split; triangular solves | Pure Rust, generic over scalar → compiles to wasm32; explicit SIMD only for x86-64/AArch64 ([paper.md](https://github.com/sarah-quinones/faer-rs/blob/main/paper.md)), so wasm gets scalar code | Dense perf claimed to match/surpass OpenBLAS/Eigen; sparse Lanczos benchmarks put faer level with Eigen, behind PETSc's blocked CSR ([arXiv:2606.19213](https://arxiv.org/abs/2606.19213), Jun 2026). Supports user scalar types incl. double-double. |
| nalgebra / nalgebra-sparse | CSR/CSC/COO formats and products; no factorisation found in docs checked (**not verified**) | yes | Good for mesh/geometry types |
| sprs + sprs-ldl | simplicial LDLᵀ (LGPL opt-in), triangular solves ([docs](https://docs.rs/sprs)) | yes | slower than faer for large problems (no supernodes) |
| rsparse | CSparse port: LU, Cholesky (`cholsol`), QR ([GitHub](https://github.com/RLado/rsparse)) | yes | small, educational-grade |
| russell_sparse | wraps **MUMPS/UMFPACK** via C FFI, needs OpenBLAS/SuiteSparse ([GitHub](https://github.com/cpmech/russell)) | **no** (native only) | |
| Eigen 3.4 (C++) | SimplicialLLT/LDLT, SparseLU, SparseQR, CG/BiCGSTAB, IncompleteCholesky | yes with Emscripten, but must define `EIGEN_DONT_VECTORIZE` (x86 intrinsics headers / inline asm break, [eigen#2514](https://gitlab.com/libeigen/eigen/-/issues/2514)) | header-only, easiest C++ path |
| SuiteSparse CHOLMOD/AMD | supernodal Cholesky | **done by hand** (Aug 2025, [cprimozic.net](https://cprimozic.net/notes/posts/compiling-boundary-first-flattening-to-wasm/)): `emcmake` with CUDA/Fortran off; source patches for 32-bit `size_t` vs 64-bit indices; OpenBLAS built with RISCV64 target and duplicated as libopenblas.a/liblapack.a | no published npm package found |
| UMFPACK / MUMPS / PARDISO / PETSc / Kokkos → wasm | | **not found** | PETSc-with-Emscripten: no hits |
| OpenBLAS / BLIS → wasm | dense BLAS/LAPACK | yes (Pyodide) | ~10x slower than native x86 single-thread |

### 5.2 Rust on the GPU

- **wgpu**: v30.0.1 (2026-08-22), v30.0.0 (2026-07-01), v29.x spring 2026
  ([releases](https://github.com/gfx-rs/wgpu/releases)). WebGPU backend for wasm via vendored
  `wasm-bindgen` bindings; recent fixes include a panic when `requestAdapter()` fails on the
  WebGPU backend ([CHANGELOG](https://github.com/gfx-rs/wgpu/blob/trunk/CHANGELOG.md)).
  CI runs GPU tests on Windows WARP and Linux Mesa (lavapipe Vulkan / llvmpipe GL) —
  `install-mesa` / `install-warp` steps in [ci.yml](https://github.com/gfx-rs/wgpu/blob/trunk/.github/workflows/ci.yml);
  the WebGPU CTS is hooked into wgpu CI. The same crate is Firefox's and Deno's
  implementation.
- **rust-gpu**: EmbarkStudios repo archived 2025-10-31, continued at
  [Rust-GPU/rust-gpu](https://github.com/Rust-GPU/rust-gpu); compiles Rust → SPIR-V, then
  naga → WGSL/MSL; "a very specific version of nightly Rust is necessary"; maintainers:
  "There are still many rough edges" ([blog 2025-07-25](https://rust-gpu.github.io/blog/2025/07/25/rust-on-every-gpu/)).
  Not for production shaders yet.
- **CubeCL** (tracel-ai, Burn team): `#[cube]` Rust kernels JIT-compiled to CUDA, HIP,
  Metal, SPIR-V, WGSL, or CPU SIMD; runtimes cuda / hip / wgpu (Metal, Vulkan, WebGPU) /
  cpu; autotuning; optimised matmul; "tensor core acceleration is not yet available on
  WebGPU" ([README](https://github.com/tracel-ai/cubecl)). **No sparse kernels found.**
- **Bundle size**: no measured wgpu-app wasm size found this session. General Rust→wasm
  guidance: `opt-level="z"`, `lto`, `panic="abort"`, `wasm-opt -Oz` shrink typical apps
  50–90 % ([rustwasm book](https://rustwasm.github.io/book/game-of-life/code-size.html)).
  Expect a wgpu+winit app in the low single-digit MB before gzip and a pure-solver crate
  (faer + FEM) in the hundreds of kB — **estimate, not measurement**.

### 5.3 Can wgpu-native tests run on Linux CI?

Yes: wgpu's own CI does it on GitHub-hosted Ubuntu with Mesa lavapipe (Vulkan) and
llvmpipe (GL); `mesa-vulkan-drivers` via apt or the `julia-lavapipe` action are the common
install paths ([runner-images#2998](https://github.com/actions/runner-images/issues/2998)).
Lavapipe prints "not a conformant vulkan implementation, for testing purposes only" — fine
for correctness, useless for timing.

## 6. TypeScript-native solver vs Rust→wasm

Evidence:

- Master's thesis (Chankseliani, Nov 2025, Playwright-driven, Chromium+Firefox,
  [GitHub](https://github.com/Chankse/JavaScript-vs-WebAssembly-Comparative-Analysis)):
  dense matmul JS typed arrays vs Rust-wasm: 64² 1.00x, 128² 1.57x, 256² **1.84x**,
  512² 1.60x; physics kernels 1.7–2.8x.
- ndesmic, "Fast Matrix Math in JS 2: WASM" ([dev.to](https://dev.to/ndesmic/fast-matrix-math-in-js-2-wasm-3mbn)):
  256×256 element-wise add — JS Float32Array 116 µs vs wasm SIMD 94 µs (**~10–12 %**);
  below 64×64 JS wins because of copy overhead; "WASM by itself does not yield great
  performance gains until it actually overcomes the overhead of memory copy".
- Marketing-grade "8–10x" claims ([byteiota](https://byteiota.com/rust-webassembly-performance-8-10x-faster-2025-benchmarks/))
  are not against typed-array JS; discount them.
- V8 on `Float64Array` with monomorphic loops is routinely within 1.5–3x of native scalar C;
  wasm is within 1.5–2.5x of native (ATC'19). The two overlap; wasm's real advantages are
  SIMD, predictable performance (no deopts, no GC pauses), and reuse of existing libraries.

Verdict per component:

| Component | TS (f64 typed arrays) | Rust→wasm | Recommendation |
|---|---|---|---|
| (a) Assembly (element loops, K_e, gather maps) | Fine; f64 native; hot loops over Float64Array/Int32Array JIT well | 1.2–2x faster, SIMD possible | **TS**; move to GPU (f32) only if assembly time dominates |
| (b) Sparse CG / SpMV | Memory-bound; JS ≈ wasm within ~1.5x; both ~10x slower than GPU | little gain | **GPU f32 inner + TS f64 outer**; TS fallback when no WebGPU |
| (c) Sparse direct Cholesky (supernodal, dense kernels) | Doable (CSparse-style simplicial in ~500 lines) but supernodal+BLAS in JS is slow and a lot of code | faer gives supernodal LLᵀ/LDLᵀ + AMD out of the box; expect 1.5–2x over TS, more with SIMD | **faer via wasm-bindgen if a direct solver is needed** (2-D problems, ≤200 k DOF, nonlinear with repeated back-substitution); otherwise skip direct entirely |

Overall recommended split for this repo (which already writes WGSL as template strings and
runs GPU demos in TS): keep the solver in TypeScript — f64 on CPU for mesh, assembly,
boundary conditions, refinement loop, and small direct solves; f32 WGSL for the operator
(matrix-free where the mesh is structured, CSR otherwise), Jacobi/Chebyshev or
aggregation-AMG preconditioner, and vector kernels; a Node + dawn.node (or Chrome +
SwiftShader) test lane for the WGSL; add a Rust→wasm faer module only when a sparse direct
factorisation becomes a measured bottleneck. Do not build on threads/SharedArrayBuffer while
hosting on GitHub Pages unless you accept the coi-serviceworker reload.

## Open items / not verified this session

- Exact Apple M-series adapter limits table (run webgpureport.org on the target machine).
- Safari 26.x optional WebGPU features (shader-f16, subgroups) and Safari Memory64 status.
- Göddeke 2007 exact speedup/accuracy tables (paywalled; the 1.7x figure is second-hand).
- Kiran 2024 (IJNME) DOF/time numbers (403).
- npm `webgpu` (dawn.node) latest version/date (403).
- Any measured wasm bundle size for a wgpu app.
- Deno + lavapipe on a GPU-less GitHub runner end-to-end.

## Sources

WebGPU / WGSL
- WGSL spec — https://www.w3.org/TR/WGSL/ (atomics: https://www.w3.org/TR/WGSL/#atomic-types)
- WebGPU spec limits — https://gpuweb.github.io/gpuweb/#limits ; https://www.w3.org/TR/webgpu/#limits
- MDN GPUSupportedLimits — https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits
- gpuweb f64 issue #2805 — https://github.com/gpuweb/gpuweb/issues/2805
- gpuweb #4235 (maxStorageBuffersPerShaderStage) — https://github.com/gpuweb/gpuweb/issues/4235 ; #5103 — https://github.com/gpuweb/gpuweb/issues/5103
- Subgroups proposal — https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroups.md
- Chrome 120 — https://developer.chrome.com/blog/new-in-webgpu-120 ; Intent to ship f16 — https://groups.google.com/a/chromium.org/g/blink-dev/c/AsKn-UwMYAE
- Chrome 133 — https://developer.chrome.com/blog/new-in-webgpu-133 ; Chrome 134 — https://developer.chrome.com/blog/new-in-webgpu-134
- webgpu.report — https://webgpu.report/features/shader-f16 ; https://webgpu.report/features/subgroups
- web3dsurvey — https://web3dsurvey.com/webgpu/limits/maxBufferSize ; https://web3dsurvey.com/webgpu/limits/maxStorageBufferBindingSize
- Implementation status — https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- Firefox 141 — https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/ ; Firefox 145 notes — https://www.firefox.com/en-US/firefox/145.0/releasenotes/
- Safari 26.0 — https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ ; Safari 26.2 — https://webkit.org/blog/17640/webkit-features-for-safari-26-2/
- WebGPU dispatch overhead — https://arxiv.org/abs/2604.02344
- wgpu compute perf discussion — https://github.com/gfx-rs/wgpu/discussions/6688

Headless / CI
- agent-browser WebGPU preset — https://agent-browser.dev/webgpu
- Chrome headless WebGPU — https://developer.chrome.com/blog/supercharge-web-ai-testing
- Chrome WebGPU troubleshooting — https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
- Chromium SwiftShader doc — https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
- Puppeteer WebGPU write-up — https://tigerabrodi.blog/how-to-get-webgpu-in-headless-chrome-on-cloud-gpus
- electron#38189 — https://github.com/electron/electron/issues/38189
- Deno unstable flags — https://docs.deno.com/runtime/reference/cli/unstable_flags/ ; compute example — https://docs.deno.com/examples/webgpu_compute/
- deno#26144 — https://github.com/denoland/deno/issues/26144 ; deno#28207 — https://github.com/denoland/deno/issues/28207
- node-webgpu — https://github.com/dawn-gpu/node-webgpu ; Dawn node README — https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/node/README.md
- wgpu CI — https://github.com/gfx-rs/wgpu/blob/trunk/.github/workflows/ci.yml ; runner-images lavapipe — https://github.com/actions/runner-images/issues/2998

Precision
- Thall df64/qf128 — https://andrewthall.org/papers/df64_qf128.pdf
- luma.gl precision guide — https://luma.gl/docs/api-guide/shaders/gpu-floating-point-precision ; fp64 module — https://luma.gl/docs/api-reference/shadertools/shader-modules/fp64
- arrayfire df64 — https://github.com/arrayfire/arrayfire/issues/1886
- Göddeke, Strzodka, Turek 2007 — https://www.tandfonline.com/doi/full/10.1080/17445760601122076
- Mixed-precision PCG bounds — https://arxiv.org/abs/2510.11379 ; adaptive MP PCG — https://arxiv.org/pdf/2505.04155
- Mixed-precision AMG on GPUs — https://link.springer.com/chapter/10.1007/978-3-031-30442-2_9
- FEM conditioning — https://arxiv.org/pdf/1406.6808 ; https://www.sciencedirect.com/science/article/pii/S0898122120302169
- LS-DYNA double precision — https://www.dynasupport.com/howtos/general/double-precision

GPU solvers / assembly
- AmgX — https://research.nvidia.com/publication/2015-10_amgx-library-gpu-accelerated-algebraic-multigrid-and-preconditioned-iterative
- hypre GPU port — https://www.osti.gov/servlets/purl/1860740 ; hypre#120 — https://github.com/hypre-space/hypre/issues/120
- Ljungkvist 2014 — https://link.springer.com/chapter/10.1007/978-3-319-14313-2_38 ; Kronbichler & Ljungkvist 2019 — https://dl.acm.org/doi/10.1145/3322813
- Frontiers HPC 2025 review — https://www.frontiersin.org/journals/high-performance-computing/articles/10.3389/fhpcp.2024.1303358/pdf
- Cecka, Lew, Darve 2011 — https://onlinelibrary.wiley.com/doi/10.1002/nme.2989
- AD-based GPU FEM — https://arxiv.org/html/2602.12365v1 ; warp colouring assembly — https://doi.org/10.1016/j.jcde.2018.11.001
- Kiran 2024 — https://onlinelibrary.wiley.com/doi/10.1002/nme.7421 ; image-based PCG — https://www.sciencedirect.com/science/article/abs/pii/S0045782522003978

WebAssembly
- SpiderMonkey Memory64 — https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html ; chromestatus — https://chromestatus.com/feature/5070065734516736
- caniuse relaxed SIMD — https://caniuse.com/wf-wasm-simd-relaxed
- coi-serviceworker — https://github.com/gzuidhof/coi-serviceworker ; GH Pages headers — https://github.com/orgs/community/discussions/13309 ; tomayac — https://blog.tomayac.com/2025/03/08/setting-coop-coep-headers-on-static-hosting-like-github-pages/
- Jangda et al. ATC'19 — https://www.usenix.org/conference/atc19/presentation/jangda
- OpenBLAS wasm — https://github.com/OpenMathLib/OpenBLAS/issues/4023 ; emscripten 4GB — https://github.com/emscripten-core/emscripten/issues/20946
- Chromium 4 GB/tab — https://issues.chromium.org/issues/41133247

Libraries
- faer sparse — https://docs.rs/faer/latest/faer/sparse/linalg/index.html ; faer paper — https://github.com/sarah-quinones/faer-rs/blob/main/paper.md
- Rust sparse kernels evaluation — https://arxiv.org/abs/2606.19213
- sprs — https://docs.rs/sprs ; rsparse — https://github.com/RLado/rsparse ; russell — https://github.com/cpmech/russell
- Eigen + Emscripten — https://gitlab.com/libeigen/eigen/-/issues/2514
- CHOLMOD to wasm — https://cprimozic.net/notes/posts/compiling-boundary-first-flattening-to-wasm/
- wgpu releases — https://github.com/gfx-rs/wgpu/releases ; CHANGELOG — https://github.com/gfx-rs/wgpu/blob/trunk/CHANGELOG.md
- rust-gpu — https://github.com/Rust-GPU/rust-gpu ; blog — https://rust-gpu.github.io/blog/2025/07/25/rust-on-every-gpu/
- CubeCL — https://github.com/tracel-ai/cubecl
- Rust wasm size — https://rustwasm.github.io/book/game-of-life/code-size.html

TS vs wasm
- Chankseliani thesis repo — https://github.com/Chankse/JavaScript-vs-WebAssembly-Comparative-Analysis
- ndesmic JS vs wasm — https://dev.to/ndesmic/fast-matrix-math-in-js-2-wasm-3mbn
- takahirox benchmark suite — https://takahirox.github.io/WebAssembly-benchmark/
