# Can an existing finite-element engine run in the browser? (WebAssembly / WebGPU)

Research note, 2026-09-05. Primary sources only; every non-trivial claim has a URL in the Sources list.
Web-search budget ran out near the end, so a few items are explicitly marked "not checked".

## Executive summary

1. **FEniCSx (DOLFINx) does not run in the browser today, and nobody has tried publicly.** Zero hits for wasm / webassembly / emscripten / pyodide on the FEniCS Discourse and across all FEniCS GitHub repos' issues. No Pyodide or emscripten-forge package exists for dolfinx, basix, ffcx, ufl, petsc4py or mpi4py.
2. **Why it is hard:** DOLFINx's C++ core *requires* MPI (>= 3) and HDF5-with-MPI, plus Boost, pugixml, spdlog, a graph partitioner (ParMETIS/KaHIP/PT-SCOTCH); the Python layer needs mpi4py and CFFI; and FFCx generates C code at *runtime* that is compiled with a C compiler through CFFI. A browser has no MPI and no C compiler.
3. **The surprise: PETSc officially supports Emscripten.** Its install docs have a section "Installing To Run in Browser with Emscripten" (`--with-mpi=0 --with-batch --download-f2cblaslapack`), there is a `config/examples/arch-ci-linux-emcc.py` and a `linux-emcc` GitLab CI job. Serial PETSc in wasm is real; the 2020 issue #766 is still formally open.
4. **Verdict on FEniCS-in-browser:** feasible only as a research project: stub MPI (serial), build HDF5 serial or drop it, compile Basix + DOLFINx C++ with emcc, and replace the runtime FFCx->C->CFFI JIT with ahead-of-time compiled kernels (or ship clang-in-wasm). Months of work, unmaintained fork. Not a weekend.
5. **NGSolve/Netgen is the one full C++ FEM engine that already runs in the browser**, via Pyodide/JupyterLite since Sept 2023. Current build: `ngsolve_pyodide_314.0.6.tar.bz2` = 31.1 MB (2 Sep 2026); ngsolve wheel 11.6 MB + libnglib 8.6 MB + netgen 3.9 MB. Limits: no UMFPACK/Pardiso (use SuperLU or iterative), 32-bit memory, threads "underdeveloped".
6. **scikit-fem is the easiest Python route**: pure Python (178 KB wheel), numpy+scipy only, BSD-3, has had explicit Pyodide workarounds since 2022. Pyodide 314.0.6 ships numpy 2.4.6 / scipy 1.18.0 (with SuperLU `spsolve` compiled in, now linked against OpenBLAS 0.3.31).
7. **MFEM compiles with Emscripten** (glvis-js builds MFEM + GLVis to wasm; MFEM PR #1918 "Fix emscripten build", Dec 2020), but the public artifact (`glvis` npm, 6.6 MB) is visualization only.
8. **JavaScript-native FEM:** FEAScript-core (MIT, 68 stars, active Sep 2026, has a WebGPU Jacobi solver) is the only maintained one. Rust: fenris (MIT/Apache, last release Sep 2023, no wasm story); `fea_app` is a small Rust->wasm + WebGPU PCG demo (Jan 2026, MIT).
9. **GPU FEM in the browser is essentially unexplored**: only toy repos (fea_app, FEAScript's WebGPU Jacobi, taichi.js which is stale since Jul 2024). No research demo of full WebGPU FEM assembly+solve found.
10. **Pyodide costs:** runtime `pyodide.asm.wasm` 9.2 MB + stdlib, numpy wheel 2.8 MB, scipy wheel > 10 MB; Pyodide docs say Python code runs ~3-5x slower than native, wasm C code near-native to ~2-2.5x slower. gmsh, meshio, pyvista/vtk, petsc4py, sfepy, pyamg are **absent** from Pyodide (vtk exists in emscripten-forge; gmsh exists as a separate 40.8 MB npm wasm build).

---

## 1. FEniCSx / DOLFINx architecture and browser feasibility

### 1.1 Components and languages

| Component | Language | Role | Browser-relevant facts |
|---|---|---|---|
| UFL | Python | symbolic form language | pure Python; would run in Pyodide unchanged (not packaged, but pip-installable pure wheel) |
| FFCx | Python | form compiler: UFL -> **C source** (`ufcx.h` kernels) | generates C that must be compiled at runtime [FFCx README] |
| Basix | C++ (+ nanobind Python bindings) | element definition/tabulation | no MPI; wheels for manylinux/macOS/Windows (0.11.0, 9 Jun 2026; linux x86_64 wheel ~13 MB) [PyPI basix]; no emscripten wheel |
| DOLFINx C++ core | C++20 | meshes, function spaces, assembly, I/O | **required**: MPI>=3, HDF5 with MPI, Boost, pugixml, spdlog, UFCx header, graph partitioner (ParMETIS/KaHIP/PT-SCOTCH). Optional: PETSc (recommended), SLEPc, SuperLU_DIST, ADIOS2 [DOLFINx install docs] |
| DOLFINx Python | Python + nanobind | user API | runtime deps: basix, ffcx, ufl, **cffi**, **mpi4py**, numpy; optional petsc4py, numba, pyamg+scipy [DOLFINx install docs] |

`fenics-dolfinx` is not on PyPI at all (404 on the JSON API); distribution is conda-forge, apt, Docker, Spack [DOLFINx README].

### 1.2 The runtime C-compiler dependency

`python/dolfinx/jit.py` is titled "Just-in-time (JIT) compilation using FFCx"; it imports `ffcx.codegeneration.jit` and exposes `cffi_extra_compile_args` ("Extra C compiler arguments to pass to CFFI"), `cffi_libraries`, etc. The README states it explicitly for Windows: "Because FEniCS uses just-in-time compilation it necessary to install Microsoft Visual Studio." Every `dolfinx.fem.form(...)` call therefore needs a working C toolchain at runtime. In a browser that means either:

- shipping clang/LLVM compiled to wasm (emscripten-forge does have `clang-resource-headers`, `llvm`, `xeus-cpp` recipes, so it is not impossible) and dynamically linking freshly-built wasm into Pyodide, or
- pre-compiling every form's kernels ahead of time (FFCx can be run offline; DOLFINx C++ demos link against generated `.c` files), which kills the "write any PDE" flexibility that is FEniCS's whole point.

### 1.3 Has anyone tried?

- FEniCS Discourse `search.json` for `webassembly`, `pyodide`, `emscripten`, `wasm`: **0 posts each**. `browser javascript`: one unrelated Ubuntu install thread.
- GitHub issue search over `org:FEniCS` for `wasm`, `webassembly`, `emscripten`, `pyodide`: the only matches are dependabot `cibuildwheel` bumps in Basix (which mention pyodide in the cibuildwheel changelog). Nothing about FEniCS itself.
- GitHub repo search `fenics wasm|webassembly|dolfinx pyodide`: nothing.
- `pyodide/pyodide` and `pyodide/pyodide-recipes` issues: no fenics/dolfinx/petsc4py requests found.
- Legacy FEniCS (dolfin 2019): no evidence found either (not exhaustively checked; search budget).

Conclusion: **nobody has publicly compiled DOLFINx or legacy DOLFIN to WebAssembly.**

### 1.4 Is PETSc buildable with Emscripten? Yes (serial).

- PETSc `doc/install/install.md` section "Installing To Run in Browser with Emscripten": `./configure --with-cc=emcc --with-cxx=0 --with-fc=0 --with-ranlib=emranlib --with-ar=emar --with-shared-libraries=0 --download-f2cblaslapack=1 --with-mpi=0 --with-batch`, then `make ex19.html`.
- `config/examples/arch-ci-linux-emcc.py` holds exactly that configuration (plus `--with-strict-petscerrorcode`).
- `.gitlab-ci.yml` has a stage-2 job `linux-emcc` using `emsdk_env.sh` with `DISABLE_TESTS: 1` -- i.e. it is compile-tested, not run-tested, in CI.
- `lib/petsc/conf/rules` has a rule "makes an Emscripten executable from a PETSc C main program".
- GitLab issue #766 "Cross Compiling With Emscripten" (opened 2020-11-02) is still in state "opened"; the original blocker was configure trying to run generated binaries -- solved by `--with-batch`. Comments were not readable without auth.

Caveats: C only (`--with-cxx=0`), no Fortran, f2c BLAS/LAPACK (slow), no MPI, static libs. petsc4py for Pyodide: **not found** anywhere.

### 1.5 Honest feasibility verdict for FEniCSx in the browser

| Piece | Effort | Notes |
|---|---|---|
| UFL | trivial | pure Python |
| Basix | low-medium | C++ + nanobind, no MPI; needs a pyodide-build cross-compile recipe |
| PETSc | low | already supported upstream, serial |
| DOLFINx C++ | high | hard MPI requirement; needs a fake single-rank MPI (no `--with-mpi=0` equivalent exists); HDF5-parallel -> serial HDF5 or disable I/O; partitioner libs; Boost |
| mpi4py | high | would need a stub package exposing `MPI.COMM_WORLD` with size 1 |
| FFCx JIT | very high | runtime C compilation; needs clang-in-wasm + dynamic linking, or AOT kernels |
| Total | months, unmaintained fork | and the result is single-threaded 32-bit wasm |

Realistic alternatives ranked: **NGSolve in Pyodide (exists)** > **scikit-fem in Pyodide (trivial)** > **own small JS/Rust/WebGPU kernel** > MFEM-via-emscripten (compiles, no bindings) > FEniCSx port.

---

## 2. Other engines: browser / wasm evidence

### 2.1 Comparison table

| Engine | Lang | Hard deps | Browser status (verified) | Size in browser | License | Notes |
|---|---|---|---|---|---|---|
| **FEniCSx/DOLFINx** | C++20 / Python | MPI, HDF5-MPI, Boost, pugixml, spdlog, PETSc (opt), C compiler at runtime | **none**; no attempts found | n/a | LGPL-3 | see section 1 |
| **PETSc** | C | BLAS/LAPACK (f2c ok) | **compiles with emcc, upstream-documented, CI job** (serial, no tests) | not measured | BSD-2 | petsc4py-in-Pyodide not found |
| **NGSolve/Netgen** | C++ / Python | own core, OCC optional | **runs in Pyodide/JupyterLite since Sept 2023**; official tarballs tracked to Pyodide 314.0.6 (2 Sep 2026) | tarball 31.1 MB; ngsolve 11.6 MB + libnglib 8.6 MB + netgen 3.9 MB + pyngcore 0.1 MB | LGPL-2.1 (per project; not re-verified here) | no UMFPACK/Pardiso; SuperLU or iterative; 32-bit; threads weak |
| **scikit-fem** | pure Python | numpy, scipy | **runs in Pyodide** (project added pure-Python CG "for environments that do not have sparse solver libraries (e.g., Pyodide)" in v7.0.0, 2022; PRs #864/#885/#886) | wheel 178 KB (+ numpy 2.8 MB + scipy >10 MB) | BSD-3 | v12.0.2, Jun 2026; assembly ~0.5 s for 64k 3D dofs on M2 natively |
| **sfepy** | Python + Cython | numpy, scipy, Cython ext | **not found** in Pyodide or emscripten-forge; needs a cross-compiled wheel | n/a | BSD | `pyproject.toml` requires Cython >= 0.29.30 |
| **MFEM** | C++ | none (serial) | **compiles with Emscripten** (glvis-js Makefile builds mfem; PR #1918 fixed emscripten build Dec 2020) | glvis npm 0.6.3 unpacked 6.6 MB (pre-built glvis.js in git-lfs) | BSD-3 | only visualization exposed; no JS solver API found |
| **GLVis-js** | C++ -> wasm | MFEM | **live at glvis.org/live**; README notes "memory growth" issue | 6.6 MB | BSD-3 | 20 stars, last commit Feb 2026 |
| **CalculiX** | C / Fortran | ARPACK, SPOOLES | **not found** (no repos; GitHub search for Dhondt/CalculiX not permitted) | n/a | GPL-2 | Fortran + SPOOLES make emcc port unattractive |
| **Code_Aster** | Fortran/Python | many | **not found** | n/a | GPL | huge dependency tree |
| **Elmer** | Fortran | MPI, MUMPS etc. | **not found** | n/a | GPL/LGPL | |
| **deal.II** | C++ | Boost, (Trilinos/PETSc opt) | **no wasm mentions** in issues | n/a | LGPL-2.1 | header-heavy, could in principle compile serially |
| **libMesh** | C++ | PETSc, MPI | **none found** | n/a | LGPL | MPI-centric |
| **GetFEM** | C++ / Python | SuperLU, MUMPS opt | **not found** | n/a | LGPL | not checked in depth |
| **Kratos** | C++ / Python | Boost, pybind11 | **none found** (only an unrelated mesh-I/O PR matched) | n/a | BSD | |
| **FEBio** | C++ | MKL/Pardiso | **none found** | n/a | MIT | solver depends on MKL |
| **OpenSees / OpenSeesPy** | C++ / Tcl / Python | LAPACK, SuperLU, (MUMPS) | **none found** (issues + repo search) | n/a | proprietary-ish OpenSees license | |
| **Gridap.jl / JuliaFEM** | Julia | Julia runtime | **no wasm** for Gridap; Julia->wasm only via StaticCompiler.jl for tiny static code (Feb 2026 blog: sand game, manual memory alignment hacks) | n/a | MIT | Julia runtime itself is not in browsers |
| **fenris** (Rust) | Rust | nalgebra, nalgebra-sparse, rayon, vtkio | **no wasm mention**; last release 0.0.33 Sep 2023, 153 stars; "no PDE solvers, no GPU" | n/a (would compile to wasm minus rayon) | MIT OR Apache-2.0 | 43k downloads total |
| **russell_sparse** (Rust) | Rust + C/CUDA | MUMPS/UMFPACK via C | not wasm-friendly | n/a | MIT | 2.8.1, Aug 2026 |
| **gemlab** (Rust) | Rust | -- | mesh lab only, no browser claims | n/a | MIT | 2.4.0 Jul 2026 |
| **fea_app** (Rust) | Rust -> wasm-bindgen + WebGPU | web-sys | **runs in browser**: PCG + block-Jacobi(6x6) on WebGPU, CSR SpMV, CPU reference | not measured | MIT | 4 stars, "completed milestone", Jan 2026 |
| **FEAScript-core** (JS) | JavaScript | mathjs, plotly (peer) | **runs in browser and Node**; Stokes flow, Euler-Bernoulli beam, heat conduction, general PDE; frontal / Jacobi (CPU **and WebGPU**) / LU; Gmsh .msh import; vtk.js viz | npm `feascript` 0.2.0 unpacked 5.2 MB | MIT | 68 stars, pushed 4 Sep 2026, "under heavy development" |
| **js-fea** (JS) | JavaScript | -- | historic pure-JS FEA, online editor | small | none stated | 23 stars, dead since 2015 |
| **@jtgtools/xsparse** (TS) | TypeScript | -- | "pure TypeScript sparse linear algebra toolkit for FEM", 0.0.1 | small | ? | published 22 Aug 2026 |
| **gmsh-wasm** (`@loumalouomega/gmsh-wasm`) | C++ -> wasm | OpenCASCADE bundled | **runs in browser + Node**, pthreads/OpenMP (needs COOP/COEP), 342 API functions, STEP/IGES import | unpacked 40.8 MB | GPL-2.0-or-later | 0.3.0, Jul 2026, 1 star |
| **VTK.wasm** | C++ -> wasm | -- | **rendering in browser**, WebGL/WebGPU | `@kitware/vtk-wasm` 3.0.3 loader 408 KB (wasm fetched separately) | Apache-2.0 | Kitware, pushed Sep 2026; also `vtk` recipe in emscripten-forge |
| **Frame3DD** | ANSI C | -- | desktop only; no browser build found | n/a | GPL-3 | would be an easy emcc target |
| **PyNite** | Python | numpy, scipy | pure Python -> should run in Pyodide; not verified | n/a | MIT | not checked |
| **SkyCiv / commercial** | ? | ? | **not checked** (search budget) | | | |

### 2.2 NGSolve in detail (the existence proof)

- Announcement: NGSolve forum, Joachim Schöberl, 21 Sep 2023: "it is now possible to run Netgen/NGSolve within JupyterLite in a browser"; Matthias Hochsteger did the port; ngsxfem extension followed 12 Oct 2023.
- Docs (NGSolve 24, "NGSolve in JupyterLite"): compiled to WebAssembly, delivered through Pyodide + JupyterLite. Limitations quoted: "External nonsymmetric sparse direct solvers (like umfpack and pardiso) are currently unavailable" (use iterative solvers or `ngs.directsolvers.SuperLU`); WebAssembly is 32-bit; "thread parallelism ... underdeveloped". Recommended for conference demos, tutorials, intro courses.
- Deployment: template repo `NGSolve/jupyterlite_ngsolve` runs `jupyter lite build --pyodide https://ngsolve.org/files/ngsolve_pyodide_0.27.6.tar.bz2` (last commit 21 Aug 2025; pins jupyterlite-core 0.5.1, webgui_jupyter_widgets 0.2.37). The deployed lock file reports Pyodide 0.27.6 / Python 3.12.7 / emscripten 3.1.58.
- Official artifacts at `ngsolve.org/files/`: tarballs for Pyodide 0.24.1 (31.6 MB), 0.26.2 (35.8 MB), 0.27.2 (33.6 MB), 0.27.5, 0.27.6 (34.1 MB), 0.28.3 (33.8 MB), 0.29.0 (28.1 MB), 0.29.1 (29.2 MB), **314.0.6 (31.1 MB, 2 Sep 2026)**. So NGSolve tracks new Pyodide releases within weeks -- this is maintained, not a one-off.
- Wheel-level sizes (314.0.6/master): `ngsolve.zip` 11,572,430 B; `libnglib.zip` 8,599,460 B; `netgen.zip` 3,869,050 B; `libngcore.zip` 119 KB; `pyngcore.zip` 112 KB.
- Performance numbers: **not published** anywhere I could find.

### 2.3 MFEM / GLVis

- glvis-js README: "Using Emscripten GLVis can be built as a JavaScript & WebAssembly library"; build steps clone mfem + glvis and `make install` with emsdk. Pre-built `src/glvis.js` is in git-lfs "because of its size". Known issue: memory growth when opening examples.
- MFEM PR #1918 (merged 6 Dec 2020): "use XSI-compliant strerror_r with emscripten instead of default GNU style that was causing compilation errors" -- upstream MFEM keeps the emscripten build working for GLVis.
- No JS bindings to MFEM's solvers/examples exist; MFEM-in-browser would mean writing embind wrappers yourself. Serial MFEM has no hard external deps, so this is the most tractable "big C++ FEM library" port after NGSolve.

### 2.4 scikit-fem

- README: "pure Python 3.10+ library", "contains no compiled code", deps numpy + scipy (optional matplotlib, meshio, jax, shapely). BSD-3. Latest 12.0.2 (5 Jun 2026), wheel `py3-none-any`, 178,478 B.
- Pyodide history: PR #864 "make assembly compatible with Pyodide" (Jan 2022), #885 "Workaround for Pyodide old scipy", #886 "Add pure Python cg solver and more Pyodide workarounds" (Mar 2022). Changelog 7.0.0: pure-Python CG "for environments that do not have sparse solver libraries (e.g., Pyodide)". Today's Pyodide scipy does include SuperLU (see section 4), so `spsolve` should work; not re-tested here.
- Native benchmark (M2, P1 tets, Laplace, `spsolve`): 64k dofs -> assembly 0.54 s, solve 62.7 s; 1.03M dofs -> assembly 12.6 s (solve not run). Direct solve dominates; in wasm expect roughly 2-5x on top.

### 2.5 Rust and JavaScript ecosystems

- crates.io `finite element` / `fem` searches surface only: fenris (43k downloads, 0.0.33, 2023), finite_element_method (0.9.12, Jan 2026), gmt-fem (telescope-specific), gemlab (2.4.0), electro (2017). No crate advertises wasm/WebGPU FEM.
- fenris deps: nalgebra, nalgebra-sparse, rayon, vtkio, mshio, rstar -- all pure Rust, so a `wasm32-unknown-unknown` build is plausible (rayon needs wasm-bindgen-rayon + COOP/COEP), but the README says "not recommended for general usage... no API stability".
- npm `finite element`: msh-parser (TS .msh parser, 2023), feascript 0.2.0, @jtgtools/xsparse 0.0.1, webgui 0.2.39 (NGSolve's three.js viewer), js-fea 0.0.1 (2015). Ecosystem is thin.
- GitHub repo search `finite element javascript`: FEAScript-core (68 stars) is the only project above a handful of stars.

---

## 3. GPU FEM in the browser (WebGPU / WebGL)

What exists (all small):

| Project | What it does on the GPU | Status |
|---|---|---|
| `RomanShushakov/fea_app` | PCG with block-Jacobi preconditioner, CSR SpMV, dot-product reductions, AXPY in WGSL via Rust `web-sys`; one command submission per iteration; CPU reference for validation; small dense LU as reference | "completed WebGPU milestone", not a framework; 4 stars; MIT; Jan 2026 |
| FEAScript-core | Jacobi solver "CPU/WebGPU"; assembly on CPU | active; MIT |
| taichi.js | compiles JS kernels to WebGPU compute; fluid demos, no FEM | 536 stars, **last push 18 Jul 2024** (stale) |
| `Thymath/wgpu_fem` | Rust/wgpu, no README, 0 stars | abandoned |
| `scttfrdmn/webgpu-compute-exploration`, `s-macke/WebGPU-Lab` | SPH, MD, boids, fractals -- no FEM | demos |

Not found: any research demo of FEM **assembly** on WebGPU (element-wise integration in a compute shader, coloring/atomics for scatter), any WebGPU multigrid/AMG, any port of GPU FEM libraries (SCI-Solver_FEM is CUDA-only). Warp/Genesis are CUDA/Taichi-native with no web export; taichi.js is the only Taichi-to-WebGPU path and is dormant.

Big C/C++ physics libraries that *have* shipped as wasm (as scale references):

| Library | npm package | Unpacked size | License | Notes |
|---|---|---|---|---|
| MuJoCo (official DeepMind) | `@mujoco/mujoco` 3.12.0 | 21.7 MB | Apache-2.0 | Embind, emsdk 4.0.10; single-threaded default + `/mt` build needing COOP/COEP; "still a WIP"; Windows experimental as of 13 Nov 2025; no perf numbers published |
| MuJoCo (community) | zalo/mujoco_wasm | -- | MIT | 476 stars, demos at zalo.github.io/mujoco_wasm; older `mujoco-js` 0.0.7 (10.6 MB) is deprecated |
| Jolt Physics | `jolt-physics` 1.1.0 | 46.4 MB (incl. JS and wasm flavours, debug builds) | MIT | JoltPhysics.js 565 stars |
| NVIDIA PhysX 5.6.1 | `physx-js-webidl` 2.7.3 | 10.3 MB | MIT (bindings) | |
| Gmsh (mesher) | `@loumalouomega/gmsh-wasm` 0.3.0 | 40.8 MB | GPL-2.0+ | includes OpenCASCADE; pthreads |
| VTK | `@kitware/vtk-wasm` 3.0.3 | 0.4 MB loader (+ wasm download) | Apache-2.0 | rendering only |
| GLVis + MFEM | `glvis` 0.6.3 | 6.6 MB | BSD-3 | visualization only |

Takeaway: a serial C++ FEM core of MFEM/NGSolve scale lands in the 10-35 MB range as wasm, and the 4-thread `SharedArrayBuffer` path requires cross-origin-isolation headers on the hosting page.

Structural-analysis web products (SkyCiv etc.) and "Quick FEA online": **not checked** -- search budget exhausted. Frame3DD (ANSI C, GPL-3) and PyNite (Python, MIT) are desktop/library tools with no browser build found.

---

## 4. Pyodide as a vehicle

### 4.1 Version and payload

- Current release **Pyodide 314.0.6, 25 Aug 2026** (GitHub releases). Version numbering switched to track CPython: 314.0.0 (9 Jun 2026) upgraded to **Python 3.14.2** and **Emscripten 5.0.3**; earlier 2026 releases were 0.29.2/0.29.3 (Jan 2026).
- Release assets: `pyodide-314.0.6.tar.bz2` (all packages) = 350,203,134 B; `pyodide-core-314.0.6.tar.bz2` = 6,758,172 B.
- CDN payloads (jsdelivr `v314.0.6/full/`): `pyodide.asm.wasm` 9.2 MB; `numpy-2.4.6-cp314-...-wasm32.whl` 2.8 MB; `scipy-1.18.0-cp314-...-wasm32.whl` **> 10 MB** (exceeded the 10,485,760-byte fetch cap; exact size not measured). Historical: SciPy "shrank dramatically from 92 MB to 15 MB" with a 2021 toolchain update (LWN).
- 314.0.0 notes: `ssl` is now a stub, stdlib no longer unvendored, `pyodide.asm.js` renamed `pyodide.asm.mjs` (classic workers unsupported).

### 4.2 Performance vs native

- Pyodide roadmap: "Across benchmarks Pyodide is currently around 3x to 5x slower than native Python", and "C code compiled to WebAssembly typically runs between near native speed and 2x to 2.5x times slower (Jangda et al. 2019)". Roadmap still lists "packaging a high performance BLAS library such as BLIS" as future work.
- However, the current scipy recipe in `pyodide-recipes` links against **libopenblas** (`NPY_BLAS_LIBS=... libopenblas.so`, package `libopenblas-0.3.31.zip`; a `libblis-2.1.zip` also ships), so the 2021 "reference BLAS only" numbers are stale.
- Data point (Roman Yurchak gist, Apr 2021, Pyodide 0.17 dev, Netlib BLAS): dgemm N=1000 -> native Netlib 0.28 s, BLIS 0.04 s, Pyodide 1.0 s (Chrome) / 1.3 s (Firefox); "4 to 10 times slower in Firefox and 3 to 7 slower in Chrome", worse (>10x) at N=4000, no SIMD/threads then.
- LWN (May 2021): early benchmarks "1x-12x slower than native on Firefox and 1x-16x slower on Chrome", later "near native to 3-5x slower"; a newer Emscripten gave "25-30% improvement".
- Open issue #6390 (Jul 2026): synchronous wasm compilation limits on the main thread -- i.e. run Pyodide in a Web Worker.

### 4.3 Sparse direct solvers

- The `scipy` recipe explicitly patches and builds `scipy/sparse/linalg/_dsolve/SuperLU/SRC/*` and `_superluobject.h`, and lists `scipy.sparse.linalg` among shipped modules. So `scipy.sparse.linalg.spsolve` (SuperLU) is compiled into the Pyodide scipy wheel. (scikit-fem's 2022 pure-Python CG fallback predates today's scipy build.) Not re-executed in this session.
- Also in Pyodide: `libsuitesparse-5.11.0` and `sparseqr-1.2` (SuiteSparseQR bindings). Not in Pyodide: pyamg, scikit-sparse (CHOLMOD), umfpack bindings.

### 4.4 FEM-relevant packages: present / absent

Pyodide 314.0.6 lockfile: **present** numpy 2.4.6, scipy 1.18.0, sympy 1.14.0, matplotlib 3.10.8, h5py 3.13.0, shapely 2.1.2, sparseqr, libsuitesparse, libopenblas, libblis. **Absent**: meshio, gmsh, pyvista, vtk, petsc4py, mpi4py, netgen, ngsolve, scikit-fem (pure -> `micropip.install` from PyPI works), sfepy, pyamg, dolfinx/basix/ffcx/ufl.

emscripten-forge `recipes_emscripten` (the conda-style alternative used by xeus-python/JupyterLite) has: vtk, pugixml, boost-cpp, eigen, hdf5, h5py, openblas, lapack, arpack, clapack, numba, llvmlite, pythran, xtensor, xeus-cpp, clang-resource-headers, cgal-cpp, qhull, geos -- but **no** gmsh, petsc, fenics, ngsolve, sfepy, scikit-fem. Notably several DOLFINx C++ deps (Boost, pugixml, HDF5 serial) already exist there; MPI and the partitioners do not.

meshio is pure Python (should micropip-install; not verified). Gmsh in the browser exists only as the separate 40.8 MB `gmsh-wasm` npm build (GPL), not as a Python module. PyVista needs VTK Python bindings which are not in Pyodide; VTK.wasm/vtk.js are the browser-side rendering options.

---

## 5. Bottom line for a "FEM lab" web page

- If the goal is *running FEniCS*: not achievable without a large porting project (section 1.5). Use FEniCS server-side or offline, and ship results.
- If the goal is *a real FEM engine in the browser*: NGSolve-in-Pyodide is the only maintained one (31 MB, Python API, SuperLU/iterative solvers, single-threaded); scikit-fem-in-Pyodide is the lightweight Python option (numpy+scipy ~15+ MB payload); FEAScript is the only maintained pure-JS engine (5 MB, limited physics).
- If the goal is *GPU FEM*: there is nothing to reuse; you write WGSL assembly/PCG yourself (fea_app shows the solver half in ~one repo).
- PETSc's serial emscripten build is the one pleasant surprise and would give a battle-tested KSP/PC layer to a hand-rolled C assembly kernel compiled with emcc.

---

## Sources

FEniCS / DOLFINx
- DOLFINx README: https://github.com/FEniCS/dolfinx (Windows JIT/VS note; distribution channels)
- DOLFINx installation docs (dependency list): https://docs.fenicsproject.org/dolfinx/main/python/installation
- DOLFINx JIT (`ffcx_jit`, CFFI options): https://github.com/FEniCS/dolfinx/blob/main/python/dolfinx/jit.py
- FFCx README (generates C code): https://github.com/FEniCS/ffcx
- Basix README: https://github.com/FEniCS/basix ; PyPI metadata: https://pypi.org/pypi/fenics-basix/json
- fenics-dolfinx not on PyPI: https://pypi.org/pypi/fenics-dolfinx/json (404)
- FEniCS Discourse search (0 results): https://fenicsproject.discourse.group/search.json?q=webassembly , ...?q=pyodide , ...?q=emscripten , ...?q=wasm
- GitHub issue search `org:FEniCS wasm|webassembly|emscripten|pyodide` (only cibuildwheel bumps, e.g. https://github.com/FEniCS/basix/pull/1052)

PETSc
- Install docs, "Installing To Run in Browser with Emscripten": https://github.com/petsc/petsc/blob/main/doc/install/install.md (mirror of https://petsc.org/release/install/install/)
- CI config example: https://github.com/petsc/petsc/blob/main/config/examples/arch-ci-linux-emcc.py
- GitLab CI `linux-emcc` job: https://github.com/petsc/petsc/blob/main/.gitlab-ci.yml
- Emscripten link rule: https://github.com/petsc/petsc/blob/main/lib/petsc/conf/rules
- Issue #766 "Cross Compiling With Emscripten" (2020-11-02, open): https://gitlab.com/petsc/petsc/-/issues/766

NGSolve
- Forum announcement (21 Sep 2023): https://forum.ngsolve.org/t/ngsolve-in-jupyterlite/2452
- Docs "NGSolve in JupyterLite" (limitations): https://docu.ngsolve.org/ngs24/myaddons/lite.html
- Template repo + deploy workflow: https://github.com/NGSolve/jupyterlite_ngsolve , https://github.com/NGSolve/jupyterlite_ngsolve/blob/main/.github/workflows/deploy.yml
- Live demo: https://ngsolve.github.io/jupyterlite_ngsolve/lab?path=poisson.ipynb
- Artifact directory with sizes/dates: https://ngsolve.org/files/ , https://ngsolve.org/files/pyodide-314.0.6/master/ , https://ngsolve.org/files/pyodide/

MFEM / GLVis
- glvis-js README: https://github.com/glvis/glvis-js
- MFEM PR #1918 "Fix emscripten build": https://github.com/mfem/mfem/pull/1918
- glvis npm: https://registry.npmjs.org/glvis/latest
- GLVis live: https://glvis.org/live

scikit-fem / sfepy
- scikit-fem README (pure Python, benchmark table, 7.0.0 Pyodide note): https://github.com/kinnala/scikit-fem
- scikit-fem Pyodide PRs: https://github.com/kinnala/scikit-fem/pull/864 , https://github.com/kinnala/scikit-fem/pull/885 , https://github.com/kinnala/scikit-fem/pull/886
- scikit-fem PyPI: https://pypi.org/pypi/scikit-fem/json
- sfepy pyproject (Cython build requirement): https://github.com/sfepy/sfepy/blob/master/pyproject.toml

Rust / JS / WebGPU
- fenris: https://github.com/InteractiveComputerGraphics/fenris ; crates.io: https://crates.io/api/v1/crates/fenris ; Cargo.toml deps: https://github.com/InteractiveComputerGraphics/fenris/blob/master/Cargo.toml
- russell_sparse: https://crates.io/api/v1/crates/russell_sparse
- crates.io searches: https://crates.io/api/v1/crates?q=finite%20element&sort=downloads , https://crates.io/api/v1/crates?q=fem&sort=downloads
- npm search: https://registry.npmjs.org/-/v1/search?text=finite%20element&size=30
- FEAScript-core: https://github.com/FEAScript/FEAScript-core ; npm: https://registry.npmjs.org/feascript/latest
- fea_app (Rust + WebGPU PCG): https://github.com/RomanShushakov/fea_app
- js-fea: https://github.com/lge88/js-fea
- taichi.js: https://github.com/AmesingFlank/taichi.js ; article: https://taichi-js.com/docs/articles/painless-webgpu-programming
- WebGPU compute demo repos (no FEM): https://github.com/scttfrdmn/webgpu-compute-exploration , https://github.com/s-macke/WebGPU-Lab
- SCI-Solver_FEM (CUDA only): https://github.com/SCIInstitute/SCI-Solver_FEM
- Julia wasm status: https://julialang.org/blog/2026/02/this-month-in-julia-world/ , https://julialang.org/jsoc/gsoc/wasm/ , https://github.com/tshort/ExportWebAssembly.jl
- Gridap: https://gridap.github.io/Gridap.jl/stable/
- Frame3DD: https://frame3dd.sourceforge.net/ ; PyNite: https://github.com/JWock82/Pynite

Big physics libs in wasm (size references)
- MuJoCo official wasm README: https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md ; npm: https://registry.npmjs.org/@mujoco%2Fmujoco/latest ; deprecated mujoco-js: https://registry.npmjs.org/mujoco-js/latest
- zalo/mujoco_wasm: https://github.com/zalo/mujoco_wasm
- JoltPhysics.js: https://github.com/jrouwe/JoltPhysics.js ; npm: https://registry.npmjs.org/jolt-physics/latest
- PhysX wasm: https://registry.npmjs.org/physx-js-webidl/latest
- gmsh-wasm: https://github.com/loumalouomega/GMSH-JS ; npm: https://registry.npmjs.org/@loumalouomega%2Fgmsh-wasm/latest
- VTK.wasm: https://github.com/Kitware/vtk-wasm ; npm: https://registry.npmjs.org/@kitware%2Fvtk-wasm/latest

Pyodide
- Releases (314.0.6, asset sizes): https://github.com/pyodide/pyodide/releases
- Changelog (314.0.0: Python 3.14.2, Emscripten 5.0.3): https://github.com/pyodide/pyodide/blob/main/docs/project/changelog.md
- Roadmap (3-5x slower; BLIS wish): https://github.com/pyodide/pyodide/blob/main/docs/project/roadmap.md
- Lockfile 314.0.6 (package list): https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide-lock.json
- Runtime/wheel payloads: https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide.asm.wasm , .../numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl , .../scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl
- scipy recipe (SuperLU patched in, OpenBLAS linked): https://github.com/pyodide/pyodide-recipes/blob/main/packages/scipy/meta.yaml
- pyodide-recipes package directory: https://github.com/pyodide/pyodide-recipes/tree/main/packages
- emscripten-forge recipes: https://github.com/emscripten-forge/recipes/tree/main/recipes/recipes_emscripten
- dgemm benchmark gist (2021): https://gist.github.com/rth/c71fe792eb56fb271317e35e08576c7a
- LWN "Pyodide: Python for the browser" (May 2021): https://lwn.net/Articles/855875/
- Main-thread sync compile limitation issue (Jul 2026): https://github.com/pyodide/pyodide/issues/6390
- Jangda et al. 2019 wasm performance paper: https://www.usenix.org/system/files/atc19-jangda.pdf
