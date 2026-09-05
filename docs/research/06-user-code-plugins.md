# 06 — User code and plugins: how incumbents shape it, and how C/C++/Fortran reaches the browser

Research note, 2026-09-05. Primary sources fetched directly where possible; items marked **[unverified]** could not be fetched (login walls, 3000-page PDFs, 403s) and are stated from memory of the vendor manuals — check before relying on the exact argument order.

## Executive summary and recommendations

1. Every incumbent exposes the same five hooks, and Abaqus names them best: **material point** (UMAT/VUMAT: stress + state + tangent at one Gauss point), **element** (UEL: residual + Jacobian for one element), **load** (DLOAD: scalar magnitude at one load integration point), **output** (UVARM: derived quantity at one Gauss point), plus "mesher" which no solver hooks — meshers are external tools. Copy the hook set; copy VUMAT's *batched* shape (`nblock` points per call) rather than UMAT's one-point-per-call shape, because a JS→wasm call costs ~2.5–5 ns but a JS loop dispatching 10⁶ points still burns milliseconds and kills GPU-side execution.
2. Define each hook once as a **pure function on flat f64 arrays** (SoA, fixed strides). The same signature then has three bodies: a TypeScript function (`Float64Array` views), a WGSL `fn` spliced into a kernel template (f32 only), and a wasm export with a C ABI (pointers into linear memory). Props, state-variable count, tensor ordering and units live in the plugin manifest, exactly as Abaqus's `*USER MATERIAL, CONSTANTS=n` + `*DEPVAR` do.
3. **Fortran → wasm realistic path (2026):** (a) LLVM `flang` with the r-wasm patches (`flang-wasm`, what webR ships) + Emscripten, compiled *locally* by the user; (b) `f2c` + clang for Fortran 77 legacy UMATs — this is still what Pyodide uses for SciPy 1.18 (`hoodmane/f2c` fork); (c) LFortran, which has a native `--backend=wasm` and compiles *in the browser* (dev.lfortran.org) but is self-declared **alpha**, "expected to not work on third-party codes". gfortran cannot target wasm (GCC has no wasm backend; Dragonegg needs gcc-4.8/llvm-3.3). Ship (a)+(b) as "compile locally, upload `.wasm`"; offer LFortran in-browser as a demo, not the supported path.
4. **C/C++ → wasm:** `clang --target=wasm32-wasip1` (wasi-sdk) or `emcc -sSTANDALONE_WASM --no-entry` producing a *dependency-free* core module with a handful of `extern "C"` exports. Do **not** use Emscripten `MAIN_MODULE`/`SIDE_MODULE` dynamic linking — it forces the host to be an Emscripten main module, and our host is TypeScript. Do not adopt the Component Model/`jco` yet: jco says "experimental… no guarantees", wit-bindgen says its CLI "IS NOT stable"; a hand-written C ABI over `WebAssembly.instantiate` is 60 lines and we control it.
5. **In-browser compile vs upload:** TS and WGSL compile in-browser natively (`import(blobURL)`, `createShaderModule`). C/C++ in-browser compile exists (binji/wasm-clang, "alpha demoware"; xeus-cpp-lite via CppInterOp) but costs tens of MB of download; Fortran in-browser exists only via LFortran alpha. Decision: **upload `.wasm`** is the supported path for compiled languages; in-browser compilers are optional later add-ons behind the same manifest.
6. **WGSL splice:** WGSL has no `f64`, no function pointers, no recursion, so GPU plugins must be text-spliced at pipeline-build time. Use a kernel template with named hook points (Babylon `MaterialPluginBase.getCustomCode` pattern: `CUSTOM_FRAGMENT_MAIN_END` etc.), or WESL `link()` (superset of WGSL; imports + `@if`; linker < 20 kB, `wesl` on npm). Validate with `GPUShaderModule.getCompilationInfo()` (line/col/offset per message) before creating a pipeline; cache pipelines by hash of the spliced source (three.js `customProgramCacheKey` pattern).
7. **Sandbox:** wasm gives memory isolation and no ambient I/O when we pass an empty import object; TS plugins get the same by running in a dedicated Worker with no DOM. Neither wasm nor JS can be interrupted, so all plugin execution runs in a Worker with a watchdog that calls `Worker.terminate()` ("stopped at once"). f64 arithmetic in wasm is IEEE-deterministic except NaN payload/sign bits — canonicalise NaNs on output if bit-reproducibility matters.
8. **Manifest:** a small JSON (`schema`, `id`, `version`, `kind`, `entry` per language, `abi`, `props` schema, `nstatev`, `permissions: []`, `sha256`). Blender's `blender_manifest.toml` (permissions each with a 64-char `reason`), Figma's `manifest.json` (`networkAccess.allowedDomains`), VS Code's `engines.vscode` are the models.
9. **Reproducibility:** the Model file records `{pluginId, version, sha256, sourceUrl}` per used plugin; on load, `fetch` the bytes, `crypto.subtle.digest("SHA-256")`, compare before instantiating. Browser SRI only covers `<script>`/`<link>` and import-map `integrity`, not `fetch()` of `.wasm`, so hash verification is ours to do. No server needed: a plugin is a URL to a static file plus a hash.
10. Granularity decision: material and output hooks per Gauss point (batched), element hook per element, load hook per load integration point; **no** hook inside the linear solver (nobody exposes it, and it is where a WebGPU host differs most from Fortran hosts).

## 1. User-subroutine interfaces in incumbents

### 1.1 Comparison table

| System | Pluggable things | Granularity | Language | How invoked / linked |
|---|---|---|---|---|
| Abaqus/Standard | UMAT, UEL, DLOAD/UTRACLOAD, UVARM/URDFIL, many more | UMAT/UVARM: one Gauss point per call; UEL: one element; DLOAD: one load integration point | Fortran (C/C++ possible via `bind(c)` naming) | `abaqus job=x user=umat.f`; Abaqus compiles+links a shared lib per job ([UMAT doc](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-umat.htm)) |
| Abaqus/Explicit | VUMAT, VUEL, VDLOAD, VUAMP… | **Block of `nblock` material points** per call | Fortran | same |
| Ansys MAPDL | UserMat, UserElem, USERCREEP, USERHYPER, UserFld… ("UPF") | UserMat: one integration point | Fortran/C | `/UPF` or ANSUSERSHARED → shared lib; `TB,USER` / `TB,STATE` **[unverified — login-walled]** |
| LS-DYNA | umat41–50, umat41v–50v (vectorised), user elements, EOS | scalar: one point; `v` variants: block of `lft:llt` points | Fortran (dyn21.f) | Relink LS-DYNA with the "usermat" object package; `*MAT_USER_DEFINED_MATERIAL_MODELS` **[unverified — Vol I PDF]** |
| COMSOL | External Material (`eval` C fn), external function; equation-based modelling (PDE forms typed in GUI) | one Gauss point per call | C shared lib (DLL/.so); GUI expressions | Compile to shared lib, point the External Material node at it ([COMSOL blog](https://www.comsol.com/blogs/accessing-external-material-models-for-structural-mechanics/)) |
| CalculiX | `umat_user`, `umat_<name>`, Abaqus-UMAT shim `umat_abaqus` | one Gauss point | Fortran | Material name prefix dispatch (`USER`, `ABAQUS`, `@…` for external lib); recompile ccx ([umat_main.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_main.f)) |
| FEniCS/dolfinx | UFL form is the user code; custom `tabulate_tensor` kernels | one element (cell/facet) tensor per call | Python (UFL), Numba `@cfunc`, C via cffi | Kernel address passed into `Form` constructor ([test_custom_jit_kernels.py](https://raw.githubusercontent.com/FEniCS/dolfinx/main/python/test/unit/fem/test_custom_jit_kernels.py)) |
| deal.II | everything — user writes the assembly loop | user's choice | C++ (header library) | Compile your program against the library ([step-3](https://www.dealii.org/current/doxygen/deal.II/step_3.html)) |
| MFEM | `BilinearFormIntegrator::AssembleElementMatrix` etc. | one element | C++ inheritance | Link against libmfem ([doc](https://docs.mfem.org/html/classmfem_1_1BilinearFormIntegrator.html)) |
| FEBio | materials, loads, plot variables, solvers… | class-level (material: one point) | C++ shared lib | exports `PluginNumClasses`, `PluginGetFactory`, `GetSDKVersion`, `PluginInitialize`; `REGISTER_FECORE_CLASS`; `<import>` in `.feb` ([febio.org/plugins](https://febio.org/plugins/)) |
| OpenSees | UniaxialMaterial, NDMaterial, Element, … | material: one point (trial strain → stress, tangent) | C++ class + `OPS_Export void* OPS_<Name>()` factory | Dynamic lib loaded by interpreter when `uniaxialMaterial ElasticPPcpp tag E eyp` is parsed ([ElasticPPcpp.cpp](https://raw.githubusercontent.com/OpenSees/OpenSees/master/DEVELOPER/material/cpp/ElasticPPcpp.cpp)) |

### 1.2 Abaqus in detail (the de-facto standard)

**UMAT (implicit).** Signature, from the 2017 docs mirror:

```fortran
SUBROUTINE UMAT(STRESS,STATEV,DDSDDE,SSE,SPD,SCD,RPL,DDSDDT,DRPLDE,DRPLDT,
     STRAN,DSTRAN,TIME,DTIME,TEMP,DTEMP,PREDEF,DPRED,CMNAME,
     NDI,NSHR,NTENS,NSTATV,PROPS,NPROPS,COORDS,DROT,PNEWDT,
     CELENT,DFGRD0,DFGRD1,NOEL,NPT,LAYER,KSPT,JSTEP,KINC)
```

- Must define: `STRESS(NTENS)` (updated), `STATEV(NSTATV)` (updated), `DDSDDE(NTENS,NTENS)` = ∂Δσ/∂Δε (the consistent tangent), `SSE/SPD/SCD` energies; for coupled thermal also `RPL, DDSDDT, DRPLDE, DRPLDT`. May update `PNEWDT` (suggested Δt ratio → automatic time stepping).
- Inputs: `STRAN, DSTRAN` (strain and increment, already rotated), `TIME(2), DTIME, TEMP, DTEMP, PREDEF, DPRED`, `PROPS(NPROPS)` from `*USER MATERIAL, CONSTANTS=n`, `COORDS(3)`, `DROT(3,3)`, `CELENT`, `DFGRD0/DFGRD1(3,3)`, and ids `NOEL, NPT, LAYER, KSPT, JSTEP(4), KINC`.
- Called once per material point per Newton iteration. State variable count set by `*DEPVAR`.
- Build: `abaqus job=jobname user=umat.f` compiles and links automatically.
Source: [simasub-c-umat](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-umat.htm).

**VUMAT (explicit).** "Called for blocks of material calculation points": read-only `nblock, ndir, nshr, nstatev, nfieldv, nprops, lanneal, stepTime, totalTime, dt, cmname, coordMp, charLength, props, density, strainInc, relSpinInc, tempOld, stretchOld, defgradOld, fieldOld, stressOld, stateOld, enerInternOld, enerInelasOld, tempNew, stretchNew, defgradNew, fieldNew`; write-only `stressNew, stateNew, enerInternNew, enerInelasNew`. Everything is in a corotational material frame (Green–Naghdi rate), and **no tangent is required**. Source: [simasub-c-vumat](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-vumat.htm). This is the shape to copy for GPU: SoA arrays with an `nblock` leading dimension.

**UEL (user element).** 36 arguments: `RHS, AMATRX, SVARS, ENERGY, NDOFEL, NRHS, NSVARS, PROPS, NPROPS, COORDS, MCRD, NNODE, U, DU, V, A, JTYPE, TIME, DTIME, KSTEP, KINC, JELEM, PARAMS, NDLOAD, JDLTYP, ADLMAG, PREDEF, NPREDF, LFLAGS, MLVARX, DDLMAG, MDLOAD, PNEWDT, JPROPS, NJPROP, PERIOD`. `LFLAGS(3)` tells the routine what to compute: 1 = residual + stiffness, 2 = stiffness only, 4 = mass only, 5 = residual only, 6 = mass + residual, 100 = perturbation output. Element topology is declared in the input deck: `*USER ELEMENT, NODES=N, TYPE=Un, PROPERTIES=P, COORDINATES=C, VARIABLES=V`. User returns `RHS` = external − internal forces and `AMATRX` = Jacobian. Source: [simasub-c-uel](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-uel.htm).

**DLOAD.** `SUBROUTINE DLOAD(F,KSTEP,KINC,TIME,NOEL,NPT,LAYER,KSPT,COORDS,JLTYP,SNAME)`; returns one scalar `F` (units F·L⁻² surface / F·L⁻³ body), "called at each load integration point for each element-based or surface-based nonuniform distributed load" (`PNU`, `PENU`, …). Source: [simasub-c-dload](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-dload.htm). UTRACLOAD is the vector analogue (traction direction + magnitude).

**UVARM.** `UVAR(NUVARM)` out; inputs `DIRECT(3,3), T(3,3), TIME(2), DTIME, CMNAME, ORNAME, NUVARM, NOEL, NPT, LAYER, KSPT, KSTEP, KINC, NDI, NSHR, COORD, JMAC, JMATYP, MATLAYO, LACCFLA`; pulls solver quantities via `CALL GETVRM('S', ARRAY, JARRAY, FLGRAY, JRCD, JMAC, JMATYP, MATLAYO, LACCFLA)`. One call per material point at output time. Source: [simasub-c-uvarm](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-uvarm.htm). URDFIL instead reads the `.fil` results file at increment end — post-processing over the whole result, not per point.

### 1.3 Others, briefly

- **Ansys UserMat [unverified]:** `usermat(matId, elemId, kDomIntPt, kLayer, kSectPt, ldstep, isubst, keycut, nDirect, nShear, ncomp, nStatev, nProp, Time, dTime, Temp, dTemp, stress, ustatev, dsdePl, sedEl, sedPl, epseq, Strain, dStrain, epsPl, prop, coords, var0, defGrad_t, defGrad, tsstif, epsZZ, cutFactor, var1…var8)`; update `stress`, `ustatev`, `dsdePl` (material Jacobian), `keycut` to request bisection. Props via `TB,USER,,,nprop` + `TBDATA`; state count via `TB,STATE`. The public help (ansyshelp.ansys.com) returned 401; the BME mirror path guessed here returned 404.
- **LS-DYNA [unverified]:** `subroutine umat41(cm, eps, sig, epsps, hsv, dt1, capa, etype, tt, temper, failel, crv, nnpcrv, cma, qmat, elsiz, idele, reject)` — `cm` = material constants from the keyword card, `eps` = strain increments, `sig` = stress in/out, `hsv` = history variables (`NHV` on the card), no tangent (explicit; `IBULK`/`IG` on the card tell LS-DYNA where bulk and shear moduli live in `cm` for the time step). Vectorised `umat41v` gets `lft, llt` bounds and arrays `sig1(*)…sig6(*)`. Appendix A of the Keyword Manual Vol I ([R13 PDF](https://www.dynasupport.com/manuals/ls-dyna-manuals/ls-dyna_manual_volume_i_r13.pdf)); the dynasupport how-to pages were 404 today.
- **COMSOL External Material:** `int eval(double e[], double s[], double D[], int *nPar, double *par, int *nStates, double *states)` — strain in, stress and tangent `D` out, `states[]` history; two socket types, "General stress-strain relation" and "Inelastic residual strain"; compiled to DLL/.so and called per Gauss point. Source: [COMSOL blog](https://www.comsol.com/blogs/accessing-external-material-models-for-structural-mechanics/). COMSOL's *other* user-code route, equation-based modelling, is typed weak-form expressions in the GUI — the same idea as UFL, no compiler needed.
- **CalculiX:** `umat_user(amat, iel, iint, kode, elconloc, emec, emec0, beta, xokl, voj, xkl, vj, ithermal, t1l, dtime, time, ttime, icmd, ielas, mi, nstate_, xstateini, xstate, stre, stiff, iorien, pgauss, orab, pnewdt, ipkon)`; returns `stre(6)` = PK2 stress, `stiff(21)` = symmetric 6×6 consistent tangent d(PK2)/d(Lagrange strain), `xstate`, `pnewdt`; `icmd=3` means stress only. `umat_abaqus` wraps a real Abaqus UMAT but "should only be used for small deformations and small rotations" and does not support `sse, spd, scd, rpl, ddsddt, drplde, drpldt, predef, dpred, drot, pnewdt, celent, layer, kspt`. Dispatch is on material-name prefix; `@` prefix loads an external library. Sources: [umat_user.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_user.f), [umat_abaqus.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_abaqus.f), [umat_main.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_main.f).
- **dolfinx:** the C kernel signature is `void tabulate_tensor(double* restrict A, const double* restrict w, const double* restrict c, const double* restrict coordinate_dofs, const int* restrict entity_local_index, const uint8_t* restrict quadrature_permutation, void* custom_data)` ([ufcx.h](https://raw.githubusercontent.com/FEniCS/ffcx/main/ffcx/codegeneration/ufcx.h)); Python users write it as `@numba.cfunc(ufcx_signature(dtype, xdtype), nopython=True)` and pass `{IntegralType.cell: [(subdomain_id, kernel.address, cells, active_coeffs)]}` into the `Form` constructor ([test](https://raw.githubusercontent.com/FEniCS/dolfinx/main/python/test/unit/fem/test_custom_jit_kernels.py)). Note the element-level granularity: the kernel produces the whole local tensor `A`, i.e. it is a UEL, not a UMAT.
- **MFEM:** override `virtual void AssembleElementMatrix(const FiniteElement& el, ElementTransformation& Trans, DenseMatrix& elmat)` (plus `AssembleFaceMatrix`, `AssemblePA`/`AddMultPA` for matrix-free) ([doc](https://docs.mfem.org/html/classmfem_1_1BilinearFormIntegrator.html)). **deal.II** has no plugin seam at all — the tutorial's `assemble_system` loop over `cell`, `q_index`, `fe_values.shape_grad(i,q)*fe_values.shape_grad(j,q)*fe_values.JxW(q)` *is* the user code ([step-3](https://www.dealii.org/current/doxygen/deal.II/step_3.html)).
- **OpenSees:** pure virtuals `setTrialStrain(strain, strainRate)`, `getStrain`, `getStress`, `getTangent`, `getInitialTangent`, `commitState`, `revertToLastCommit`, `revertToStart`, `getCopy` ([UniaxialMaterial.h](https://raw.githubusercontent.com/OpenSees/OpenSees/master/SRC/material/uniaxial/UniaxialMaterial.h)). A DLL exports `OPS_Export void* OPS_ElasticPPcpp()` that parses with `OPS_GetIntInput`/`OPS_GetDoubleInput` and returns `new ElasticPPcpp(...)`; the interpreter loads it when it sees an unknown material name. The trial/commit/revert triad is the cleanest statement of *state-variable semantics* in any of these APIs and is worth copying (we hold `stateOld`, plugin writes `stateNew`; commit is ours).

### 1.4 What to take from this

| Our hook | Model | In | Out | Batched? |
|---|---|---|---|---|
| `material` | VUMAT + UMAT tangent | strain/def-grad (old,new), stressOld, stateOld, props, dt, temp, coords, ids | stressNew, stateNew, tangent (optional, flag like `icmd`/`LFLAGS(3)`), energy, `pnewdt` | yes, `nblock` SoA |
| `element` | UEL / ufcx | node coords, u, du, v, a, props, svars, `what` flag (residual / stiffness / mass) | RHS, K (row-major dense), svars | one element per call; batch of elements per call for wasm |
| `load` | DLOAD / UTRACLOAD | x, t, step, element id, face id, normal | magnitude or traction vector | yes |
| `output` | UVARM | stress, strain, state, props, x, t | n user scalars | yes |
| `mesher` | none of the above; external tool | geometry (B-rep/STL/params) | nodes `Float64Array`, elements `Uint32Array`, sets | one call |

## 2. Fortran to WebAssembly

| Path | Status (verified) | Fortran subset | JS interop | Notes |
|---|---|---|---|---|
| **gfortran + Emscripten** | Not possible: GCC has no wasm backend; Dragonegg needs gcc-4.8 + llvm-3.3 and "fairly nasty post-processing" ([Stagg 2024](https://gws.phd/posts/fortran_wasm/)) | — | — | Dead end. |
| **f2c + clang/emcc** | Works for Fortran 77 only; Pyodide's SciPy 1.18 recipe still uses `hoodmane/f2c` with `-DUNDERSCORE_G77` and five ABI patches; comment: "Declaration error: adjustable dimension on non-argument… you are trying to compile code that isn't written to the fortran 77 standard" ([scipy meta.yaml](https://raw.githubusercontent.com/pyodide/pyodide-recipes/main/packages/scipy/meta.yaml)) | F77 | C ABI (hidden string-length args are `int`) | netlib f2c page last modified 18 Mar 2024 ([netlib](https://www.netlib.org/f2c/)). Fine for classic UMATs, which are F77. |
| **LLVM flang, patched (`flang-wasm`)** | Works; compiled BLAS/LAPACK; powers webR. Patches: register `wasm32-unknown-emscripten` target in `Target.cpp` (complex as `{t,t}` byval align 4), build `flang/runtime` with `em++` into `libFortranRuntime.a`, force `long`=4 bytes to fix the hidden `size_t` CHARACTER-length ABI ([Stagg](https://gws.phd/posts/fortran_wasm/), [r-wasm/flang-wasm](https://github.com/r-wasm/flang-wasm)) | Fortran 95/2003+ (whatever upstream flang handles) | Emscripten module or `-sSTANDALONE_WASM` | Needs a local toolchain (Makefile/Docker/Nix provided). Upstream flang has no wasm32 target list entry as of the post; the author "lacked compiler expertise to implement a proper upstream fix". Pyodide changelog mentions only f2c ABI fixes (0.20.0) and "Recursive fortran functions now work correctly in scipy" (0.26.2) ([changelog](https://raw.githubusercontent.com/pyodide/pyodide/main/docs/project/changelog.md)); the Pyodide blog post itself was 403 — claim that Pyodide adopted flang is **not verified**. |
| **LFortran** | Alpha ("expected to not work on third-party codes"; 9/10 production codes needed for beta). Compiles 60% of SciPy (Jan 2024), stdlib, SNAP, PRIMA, POT3D, LAPACK (Feb 2026), fpm (Feb 2026). Backends: LLVM, C, x86, **WASM** ([lfortran.org](https://lfortran.org/)) | Full F2018 parser; smaller ASR subset compiles | Three routes: `lfortran main.f90 --backend=wasm -o main` (native backend, emits `.wasm` + `.js`), `--target=wasm32-wasi -o main.wasm`, `--target=wasm32-unknown-emscripten -o main.js` ([blog May 2024](https://lfortran.org/blog/2024/05/fortran-on-web-using-lfortran/)) | Compiles **in the browser** at [dev.lfortran.org](https://dev.lfortran.org/) (the compiler itself is wasm). No docs page for the wasm backend exists on docs.lfortran.org; output sizes not published. Use for demos/teaching, not as the guaranteed path. |

Recommendation: document two supported recipes — `f2c` for F77 UMATs and `flang-wasm` for modern Fortran — each producing a core `.wasm` with `bind(c, name="fem_material")` exports; and embed LFortran's playground as an "experimental: compile here" option. Fortran hidden arguments (CHARACTER lengths) are the classic ABI trap; require `bind(c)` wrappers so the exported ABI is C, never raw Fortran.

## 3. C/C++ to wasm for plugins

### 3.1 Toolchains

- **wasi-sdk:** upstream clang + wasi-libc; targets `wasm32-wasip1`, `wasm32-wasip2`, `wasm32-wasip3`, `wasm32-wasip1-threads`. `clang --sysroot=$WASI_SDK_PATH/share/wasi-sysroot foo.c -o foo.wasm`. C++ exceptions and setjmp need extra configuration; dynamic linking "less stable than static"; no 64-bit memory ([wasi-sdk](https://github.com/WebAssembly/wasi-sdk)). A plugin that touches no libc I/O imports nothing but (maybe) `memory` — instantiate with `{}`.
- **Emscripten standalone:** `-sSTANDALONE_WASM` is implied by `-o foo.wasm`; a trivial `add()` is **87 bytes**; meshoptimizer's custom loader is 57 lines; no C++ exceptions/setjmp/pthreads without JS ([V8 blog](https://v8.dev/blog/emscripten-standalone-wasm)). Use `--no-entry` for libraries, `EMSCRIPTEN_KEEPALIVE` or `-sEXPORTED_FUNCTIONS` to keep exports ([Interacting with code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html)).
- **Emscripten dynamic linking:** `-sMAIN_MODULE` host + `-sSIDE_MODULE`/`-shared` plugins, `dlopen()` at runtime, `-sMAIN_MODULE=2` for dead-code elimination; Chromium refuses synchronous compile of modules > 8 MB on the main thread; `EM_ASM` in side modules needs `eval` ([Dynamic-Linking](https://emscripten.org/docs/compiling/Dynamic-Linking.html)). Only relevant if the *host solver* were an Emscripten C++ program. Ours is TypeScript, so skip.

### 3.2 A stable C ABI for a material point plugin

Design rule: the plugin sees only `f64`/`i32` and offsets into *its own* linear memory. The host allocates via an exported `fem_alloc(bytes) -> i32`, writes SoA input blocks with `new Float64Array(memory.buffer, ptr, n)`, calls once per block, reads outputs back. Shape (VUMAT-derived):

```c
// exported by the plugin; all pointers are byte offsets into the plugin's own memory
int32_t fem_abi_version(void);                       // returns 1
int32_t fem_material_info(int32_t* nprops, int32_t* nstatev, int32_t* ntens);
int32_t fem_material_eval(
    int32_t nblock, int32_t what,                    // what: 1 stress, 2 stress+tangent (UMAT/LFLAGS(3) style)
    const double* props,                             // [nprops]
    const double* strain_old, const double* dstrain, // [nblock*ntens], SoA: component-major
    const double* F_old, const double* F_new,        // [nblock*9] or NULL
    const double* stress_old, const double* state_old, // [nblock*ntens], [nblock*nstatev]
    double dt, double t, const double* temp,         // [nblock]
    double* stress_new, double* state_new,           // out
    double* tangent,                                 // out [nblock*ntens*ntens] when what==2
    double* pnewdt);                                 // out [1]; <1 requests cut-back
```

Element and load hooks follow the same pattern (`fem_element_eval(nelem, what, ...)`, `fem_load_eval(npts, x, t, ..., out)`). The TypeScript and WGSL bodies get the same field list; only the container type differs.

### 3.3 Call overhead — batch anyway

Firefox's 2018 measurements: 10⁸ JS→wasm calls fell from ~5,500 ms to ~450 ms (≈4.5 ns/call), monomorphic case ~250 ms (≈2.5 ns/call), "faster than non-inlined JS to JS function calls" ([Mozilla Hacks](https://hacks.mozilla.org/2018/10/calls-between-javascript-and-webassembly-are-finally-fast/)). So a per-point call is *not* the bottleneck — argument marshalling and the JS loop are. Emscripten's own guidance is to `_malloc` once, `HEAPF64.set(...)` and make one call ([Interacting with code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html)). For 10⁶ Gauss points, a block size of 1024–8192 keeps per-call overhead < 1% and the working set in L2.

### 3.4 Compile in the browser vs upload `.wasm`

| Option | Evidence | Verdict |
|---|---|---|
| clang/lld in wasm (binji/wasm-clang) | clang + lld compiled with WASI, in-memory FS, runs in a Worker; "still very much alpha demoware", CppCon 2019, 45 commits ([repo](https://github.com/binji/wasm-clang)) | Proof it works; not a dependency to ship. |
| xeus-cpp-lite / CppInterOp | Emscripten build of clang-repl; live JupyterLite demos; tested on Firefox/Chrome/Safari via `emrun` ([repo](https://github.com/compiler-research/xeus-cpp)) | C++ REPL semantics, heavy download; interesting for teaching, not for plugin builds. |
| LFortran playground | compiles Fortran in-browser, alpha ([dev.lfortran.org](https://dev.lfortran.org/)) | Embed as experiment. |
| TS / WGSL in-browser | native: `import(URL.createObjectURL(new Blob([src],{type:"text/javascript"})))`, `device.createShaderModule` | This *is* the compiler; no download. |
| **Upload `.wasm`** | `WebAssembly.instantiate(bytes, {})`; static site only | **Supported path for C/C++/Fortran.** Provide a `Dockerfile`/`Makefile` in the repo that turns `umat.f`/`umat.c` into a conforming `.wasm`. |

### 3.5 Component Model / WIT in 2026

- WASI 0.2.0 stable since 25 Jan 2024; WIT gives typed interfaces/worlds and a canonical ABI ([component-model book](https://component-model.bytecodealliance.org/)).
- `wit-bindgen c ./wit` generates `host.c/host.h/host_component_type.o`; compile with clang to `wasm32-wasip1/2`, then `wasm-tools component new core.wasm -o comp.wasm`. Repo states "This CLI **IS NOT** stable and may change", all crates `0.x` ([wit-bindgen](https://github.com/bytecodealliance/wit-bindgen)).
- `jco transpile component.wasm -o out` emits ESM + core wasm, maps WASI imports to `@bytecodealliance/preview2-shim`, has `--instantiation async|sync`, runs in browsers (`import { transpile } from '@bytecodealliance/jco/component'`). Book front page: "This is an experimental project. **No guarantees** are provided for stability, security or support" ([jco](https://github.com/bytecodealliance/jco), [transpiling](https://bytecodealliance.github.io/jco/transpiling.html)).
- Verdict: typed lists/records over the canonical ABI would replace our hand-rolled pointer protocol, but it adds a Rust toolchain for authors, a JS shim, and unstable CLIs, for a plugin whose entire surface is "arrays of f64". Revisit when jco drops the "experimental" banner; design the manifest's `abi` field so `"c-v1"` can later coexist with `"wit-v1"`.

## 4. Sandboxing and determinism

### 4.1 wasm plugins

- Memory isolation is structural: a module can only address its own `memory`; the host passes data by copying into it. No ambient I/O: a module built without WASI imports has nothing to call; instantiate with an empty import object and refuse modules whose `WebAssembly.Module.imports()` list is non-empty (or allow only `env.memory`, `env.abort`).
- **No interruption.** wasm has no fuel or preemption in browsers; neither has JS. Run every plugin in a dedicated `Worker`; a host-side timer calls `worker.terminate()`, which "immediately terminates the Worker… stopped at once" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate)). Re-instantiate the module afterwards (memory is lost — which is also the sandbox reset we want).
- **Determinism.** IEEE arithmetic is deterministic across engines; the spec-level nondeterminism is: NaN payload bits ("when an arithmetic operator returns NaN, there is nondeterminism in determining the specific bits of the NaN"), NaN sign when no input is NaN, relaxed-SIMD, threads/shared memory, resource exhaustion, and host calls ([Nondeterminism.md](https://github.com/WebAssembly/design/blob/master/Nondeterminism.md)). For bit-reproducible results: no relaxed SIMD, no threads inside the plugin, canonicalise NaNs (or treat any NaN as failure — for a material law it is).
- Stack overflow / OOM inside the plugin traps; catch `WebAssembly.RuntimeError` in the Worker and report `(element, point)`.

### 4.2 TypeScript plugins

Same Worker (no DOM, no `fetch` unless the manifest requests `network`), loaded via `import()` of a Blob URL or a pinned URL. JS `Float64Array` math is the same IEEE f64 as wasm; `Math.fma` absent, `Math.pow`/transcendentals are implementation-defined (not correctly rounded), so TS ≠ wasm bit-for-bit for anything calling `exp`/`pow` — document, don't fight.

### 4.3 WGSL snippets as GPU plugins

- Constraints from the spec: scalars are `bool, i32, u32, f32, f16` (extension) plus abstract types — **no f64**; "A user-defined function must not be recursively defined"; no function pointers ([WGSL types](https://www.w3.org/TR/WGSL/#types)). Hence dispatch is by *text*: the user's `fn material_eval(...)` is spliced into the kernel template and a new pipeline is compiled.
- Composition options: (a) plain template with named markers — three.js does `shader.fragmentShader.replace('#include <x>', ...)` in `onBeforeCompile(shaderobject, renderer)` and keys the program cache on `customProgramCacheKey()` (default: `this.onBeforeCompile.toString()`) ([Material.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/src/materials/Material.js)); Babylon's `MaterialPluginBase.getCustomCode(shaderType, shaderLanguage)` returns `{ "CUSTOM_FRAGMENT_MAIN_END": "...", "CUSTOM_VERTEX_DEFINITIONS": "..." }` and supports `ShaderLanguage.WGSL` ([materialPlugins](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/materialPlugins)); (b) **WESL** — strict superset of WGSL with `import`, `@if` conditional compilation, npm/Cargo packages; `wesl` npm package exposes a runtime `link()` that emits plain WGSL, linkers "< 20kb"; wesl-js and wesl-rs interoperate ([wesl-lang.dev](https://wesl-lang.dev/), [wesl-js](https://github.com/wgsl-tooling-wg/wesl-js)).
- Recommendation: template + markers for v1 (`// @plugin material_eval`, `// @plugin load_eval`), with the user snippet required to define exactly the named function signature the template calls. Adopt WESL `link()` when we want plugins to import shared helper modules. Validate every spliced module with `getCompilationInfo()` — messages carry `type` (`error|warning|info`), `lineNum`, `linePos`, `offset`, `length` ([WebGPU](https://www.w3.org/TR/webgpu/#shader-module-compilation-information)); subtract the template prefix length to map back to the user's line numbers. Cache pipelines by SHA-256 of the final WGSL text.
- Sandbox: WGSL is memory-safe by construction (bounds-checked or clamped accesses), and a hung shader ends as device loss — there is no partial time limit. Run plugin pipelines on their own `GPUDevice` if a hostile snippet must not take down the viewport.
- The f32-only limit means a WGSL material plugin is for explicit/visual/interactive paths; implicit tangents that need f64 go to wasm/TS on the CPU (see note 02 on numerics).

## 5. Plugin registries and reproducibility

### 5.1 What others record

| System | Manifest | Identity/version | Permissions | Distribution | Sandbox |
|---|---|---|---|---|---|
| VS Code | `package.json`: `name`, `publisher`, `version` (SemVer), `engines.vscode`, `main`/`browser`, `activationEvents`, `contributes`, `extensionKind`, `capabilities.untrustedWorkspaces` ([ref](https://code.visualstudio.com/api/references/extension-manifest)) | `publisher.name@version` | declared capabilities, not enforced sandbox | Marketplace / `.vsix` | none (extension host process) |
| Blender 4.2+ | `blender_manifest.toml`: `schema_version`, `id`, `version`, `name`, `tagline` (≤64 chars), `maintainer`, `type`, `blender_version_min`, `license` (SPDX), optional `platforms`, `wheels`, `permissions` = `files|network|clipboard|camera|microphone` each with a `reason` ≤64 chars ([manual](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/advanced/extensions/getting_started.rst)); legacy `bl_info` dict + `register()/unregister()` | `id` + SemVer | declared, shown to user, not enforced | remote repository = static `index.json` + zip files | none |
| Figma | `manifest.json`: `name`, `id`, `api`, `main`, `ui`, `editorType`, `networkAccess.allowedDomains` (+ `reasoning`, `devAllowedDomains`), `permissions`, `documentAccess`, `capabilities`, `parameters`, `menu` ([manifest](https://developers.figma.com/docs/plugins/manifest/)) | Figma-assigned `id` | `networkAccess` **enforced via CSP** | Figma community | main-thread sandbox: originally Realms shim, replaced after a disclosed vulnerability by a C JS interpreter compiled to wasm ("Duktape does not support any browser APIs — and that's a feature!"); UI in a null-origin iframe; postMessage between ([how plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/), [blog](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)) |
| ParaView | CMake `paraview_add_plugin(... VERSION ...)` + server-manager XML; `.plugins` XML for auto-load **[not fetched — gitlab 403]** | plugin must match exact ParaView build | none | shared libs / Python files on `PV_PLUGIN_PATH` | none |
| JupyterLite | `jupyter-lite.json` → `federated_extensions: [{name, load (remoteEntry*.js), extension, mimeExtension, style}]`; no hash/version fields in the schema; prebuilt extensions copied to `{output}/extensions` at `jupyter lite build` ([schema](https://jupyterlite.readthedocs.io/en/latest/reference/schema-v0.html), [how-to](https://jupyterlite.readthedocs.io/en/latest/howto/configure/simple_extensions.html)) | npm name | none | static site | none |
| Observable Framework | `npm:` imports self-hosted at build **[page 429'd twice — unverified]** | resolved version | — | static | — |
| Browser platform | SRI `integrity="sha384-…"` on `<script>`/`<link rel=stylesheet|preload|modulepreload>`, requires CORS ([MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)); import maps have an `integrity` map keyed by URL ([HTML spec](https://html.spec.whatwg.org/multipage/webappapis.html#import-maps)) | URL + hash | — | any static host | — |

Observation: nobody except Figma enforces permissions, and nobody except the browser's SRI pins content by hash; everyone pins by *version string*, which is not reproducible. We can do better cheaply because our plugins are pure functions and our loader is ours.

### 5.2 Minimal manifest (proposal)

```json
{
  "schema": "femlab-plugin/1",
  "id": "org.example.drucker-prager",
  "version": "1.2.0",
  "kind": "material",
  "abi": "c-v1",
  "entry": { "wasm": "dp.wasm", "ts": "dp.js", "wgsl": "dp.wgsl" },
  "exports": { "eval": "fem_material_eval", "info": "fem_material_info" },
  "props": [ {"name": "E", "unit": "Pa"}, {"name": "nu"}, {"name": "phi", "unit": "rad"} ],
  "nstatev": 7,
  "tensor": "voigt-6-abaqus",
  "provides": { "tangent": true, "f64": ["wasm", "ts"] },
  "permissions": [],
  "sha256": { "dp.wasm": "…", "dp.js": "…", "dp.wgsl": "…" },
  "license": "MIT",
  "source": "https://github.com/example/dp"
}
```

- `kind ∈ {material, element, load, output, mesher}`; `abi` versions the argument protocol independently of the plugin.
- `permissions` is an allow-list (`network`, `files`) in the Blender style, each with a `reason`; default empty = pure function; the Worker is created without the corresponding capability otherwise.
- Every entry file is content-addressed. The **Model file** stores, per plugin actually used: `{ "id", "version", "sha256": { … }, "manifestUrl" }` (a copy of the manifest is embedded, so an offline model still knows what it needs). On load: fetch each entry from `manifestUrl`'s directory (or from an in-file embedded copy for small TS/WGSL plugins), `crypto.subtle.digest("SHA-256", bytes)`, compare, else refuse with "result was produced with material plugin X@1.2.0 (sha256 ab12…) — not available or hash mismatch". A result is reproducible iff every hash matches and the engine version matches; record `engineVersion` alongside.
- Distribution without a server: a directory on any static host (GitHub Pages, S3, the user's own site) containing `manifest.json` + entries; a "registry" is just a static `index.json` listing manifest URLs — Blender's extension repositories work exactly this way. Users can also drag a `.zip` into the app; it is stored in IndexedDB keyed by hash.

## Open questions / not verified

- Ansys UserMat and LS-DYNA `umat41` exact argument lists (login wall / PDF) — see §1.3 flags.
- Whether Pyodide ever moved SciPy from f2c to flang: the SciPy recipe today still says f2c; the Pyodide blog post was not reachable.
- LFortran wasm output sizes and the exact JS export convention (`bind(c)` names) — no documentation page found; test empirically on dev.lfortran.org.
- ParaView plugin-howto text (403); Observable Framework `npm:` pinning (429).
- Upstream `flang` wasm32 target support status in LLVM 20/21 — only the r-wasm fork is confirmed.

## Sources

- Abaqus 2017 user subroutine reference (MIT mirror): [UMAT](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-umat.htm), [VUMAT](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-vumat.htm), [UEL](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-uel.htm), [DLOAD](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-dload.htm), [UVARM](https://abaqus-docs.mit.edu/2017/English/SIMACAESUBRefMap/simasub-c-uvarm.htm)
- COMSOL blog, "Accessing External Material Models for Structural Mechanics": https://www.comsol.com/blogs/accessing-external-material-models-for-structural-mechanics/
- CalculiX source: [umat_main.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_main.f), [umat_user.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_user.f), [umat_abaqus.f](https://raw.githubusercontent.com/Dhondtguido/CalculiX/master/src/umat_abaqus.f)
- FFCx `ufcx.h`: https://raw.githubusercontent.com/FEniCS/ffcx/main/ffcx/codegeneration/ufcx.h; dolfinx custom kernel test: https://raw.githubusercontent.com/FEniCS/dolfinx/main/python/test/unit/fem/test_custom_jit_kernels.py
- MFEM `BilinearFormIntegrator`: https://docs.mfem.org/html/classmfem_1_1BilinearFormIntegrator.html; deal.II step-3: https://www.dealii.org/current/doxygen/deal.II/step_3.html
- FEBio plugins: https://febio.org/plugins/
- OpenSees: [UniaxialMaterial.h](https://raw.githubusercontent.com/OpenSees/OpenSees/master/SRC/material/uniaxial/UniaxialMaterial.h), [DEVELOPER/material/cpp/ElasticPPcpp.cpp](https://raw.githubusercontent.com/OpenSees/OpenSees/master/DEVELOPER/material/cpp/ElasticPPcpp.cpp)
- LS-DYNA manuals index: https://lsdyna.ansys.com/manuals/ (Vol I R13 PDF: https://www.dynasupport.com/manuals/ls-dyna-manuals/ls-dyna_manual_volume_i_r13.pdf)
- G. Stagg, "Fortran on WebAssembly" (12 Mar 2024): https://gws.phd/posts/fortran_wasm/; r-wasm/flang-wasm: https://github.com/r-wasm/flang-wasm
- Pyodide SciPy recipe: https://raw.githubusercontent.com/pyodide/pyodide-recipes/main/packages/scipy/meta.yaml; Pyodide changelog: https://raw.githubusercontent.com/pyodide/pyodide/main/docs/project/changelog.md
- LFortran: https://lfortran.org/, https://github.com/lfortran/lfortran, blog "Fortran On Web Using LFortran" (2 May 2024): https://lfortran.org/blog/2024/05/fortran-on-web-using-lfortran/, playground https://dev.lfortran.org/
- netlib f2c: https://www.netlib.org/f2c/
- Emscripten: [Dynamic linking](https://emscripten.org/docs/compiling/Dynamic-Linking.html), [Interacting with code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html); V8 blog "Outside the web: standalone WebAssembly binaries using Emscripten": https://v8.dev/blog/emscripten-standalone-wasm
- wasi-sdk: https://github.com/WebAssembly/wasi-sdk
- Component model book: https://component-model.bytecodealliance.org/; wit-bindgen: https://github.com/bytecodealliance/wit-bindgen; jco: https://github.com/bytecodealliance/jco, https://bytecodealliance.github.io/jco/transpiling.html
- binji/wasm-clang: https://github.com/binji/wasm-clang; xeus-cpp: https://github.com/compiler-research/xeus-cpp
- Mozilla Hacks, "Calls between JavaScript and WebAssembly are finally fast" (2018): https://hacks.mozilla.org/2018/10/calls-between-javascript-and-webassembly-are-finally-fast/
- WebAssembly design, Nondeterminism.md: https://github.com/WebAssembly/design/blob/master/Nondeterminism.md
- MDN `Worker.terminate()`: https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate; MDN SRI: https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity; HTML spec import maps (`integrity`): https://html.spec.whatwg.org/multipage/webappapis.html#import-maps
- WGSL spec types: https://www.w3.org/TR/WGSL/#types; WebGPU compilation info: https://www.w3.org/TR/webgpu/#shader-module-compilation-information
- WESL: https://wesl-lang.dev/, https://github.com/wgsl-tooling-wg/wesl-js
- three.js `Material.js` (`onBeforeCompile`, `customProgramCacheKey`): https://raw.githubusercontent.com/mrdoob/three.js/dev/src/materials/Material.js; Babylon.js material plugins: https://doc.babylonjs.com/features/featuresDeepDive/materials/using/materialPlugins
- Figma: [manifest](https://developers.figma.com/docs/plugins/manifest/), [how plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/), blog "How we built the Figma plugin system": https://www.figma.com/blog/how-we-built-the-figma-plugin-system/
- Blender extensions manual (getting started / manifest): https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/advanced/extensions/getting_started.rst
- VS Code extension manifest: https://code.visualstudio.com/api/references/extension-manifest
- JupyterLite: [schema v0](https://jupyterlite.readthedocs.io/en/latest/reference/schema-v0.html), [prebuilt extensions how-to](https://jupyterlite.readthedocs.io/en/latest/howto/configure/simple_extensions.html)
