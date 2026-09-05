---
status: proposed
date: 2026-09-05
---

# User code fills fixed Extension Points, as pure functions on flat f64 arrays, in TypeScript, WGSL or wasm

Engineers who need a material law, element, load or output quantity the tool lacks write it
themselves; in Abaqus that is a Fortran UMAT, and a colleague of the owner does exactly this.
We copy the hook set every incumbent converged on (material point, element, load, output) and
add Mesher and Procedure, each a fixed, typed Extension Point that the built-ins also
implement, so there is no privileged path. A Plugin is a pure function on flat, strided
`f64` arrays in Abaqus/Explicit's *batched* VUMAT shape (n points per call), never
one-point-per-call: the same signature then has three bodies, a TypeScript function on
`Float64Array` views, a WGSL `fn` text-spliced into the kernel template at pipeline build
(f32, validated with `getCompilationInfo()` before any dispatch), and a wasm export with a
hand-written C ABI over `WebAssembly.instantiate` with an empty import object. Props, state
variable count, tensor ordering and units are declared in a manifest, as `*USER MATERIAL,
CONSTANTS=n` and `*DEPVAR` are in Abaqus (research note 06).

## Considered options

- **Component Model / WIT bindings for the wasm ABI.** jco is "experimental, no guarantees";
  wit-bindgen's CLI "IS NOT stable". A C ABI we own is ~60 lines. Revisit when stable.
- **Emscripten MAIN_MODULE/SIDE_MODULE dynamic linking.** Forces the host to be an Emscripten
  main module; the host is TypeScript. Standalone core modules only (`clang
  --target=wasm32-wasip1` or `emcc -sSTANDALONE_WASM --no-entry`).
- **Compile C/C++/Fortran in the browser.** Possible (wasm-clang, xeus-cpp-lite, LFortran's
  wasm backend) but tens of MB and alpha. The supported path is compile locally, upload the
  `.wasm`; in-browser compilers can sit behind the same manifest later.
- **Hooks inside the linear solver.** No incumbent exposes them, and it is where a WebGPU host
  differs most from a Fortran host. Not an Extension Point.

## Fortran specifically

gfortran cannot target wasm. Realistic paths, in order: LLVM flang with the r-wasm patches
(`flang-wasm`, what webR ships) plus Emscripten, compiled locally; `f2c` + clang for Fortran 77
legacy code (still what Pyodide uses for SciPy); LFortran's own wasm backend as an in-browser
demo, which its authors call alpha. We ship a documented local build recipe for the first two
and the batched ABI header they target.

## Consequences

- Plugins run only in the solver Worker; `Worker.terminate()` is the watchdog, since neither
  wasm nor JS can be interrupted. wasm gets memory isolation and no ambient I/O for free; TS
  plugins see the Extension Point arguments and nothing else.
- A Plugin is a URL to a static file plus a SHA-256; the Model records `{ id, version,
  sha256, sourceUrl }` for every Plugin a Result used and verifies the hash with
  `crypto.subtle.digest` on load, because browser SRI does not cover `fetch()` of `.wasm`.
- Spliced WGSL pipelines are cached by hash of the linked source. WGSL has no f64, recursion
  or function pointers, so a GPU plugin is a function body, and a law that needs f64 runs on
  the CPU path only; the manifest says which.
- Canonicalise NaNs on plugin output if bit-reproducibility is asserted; NaN payload is the one
  non-determinism wasm f64 permits.
