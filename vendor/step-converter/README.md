# FEM Lab standalone STEP converter

This is `occt-import-js-0.0.23+femlab.1`: pinned upstream wrapper 0.0.23 and
OCCT 7.6.1, plus the two separately recorded local patches. It is a standalone
LGPL converter; it is not linked into the FEM engine. Lazy loading is a loading
policy and is not evidence of LGPL dynamic linkage. See `NOTICE.txt` and `licenses/`.

`pins.json` identifies full upstream source archives and their SHA-256 values.
`manifest.json` identifies the actual distributed JS/WASM, complete corresponding
source kit, patches and compiler/build provenance. The original npm binary is not
the patched artifact and is not substituted when a build fails.

## Rebuild

Use Python 3.12 or newer, CMake, a Unix Makefiles toolchain, and Emscripten 3.1.69.
Obtain the exact emsdk archive named in `pins.json`, verify its SHA-256, extract it,
then run `./emsdk install 3.1.69` and `./emsdk activate 3.1.69`. The SDK's own pinned
manifest selects the platform compiler/runtime binaries. Activate its environment
using `source /path/to/emsdk/emsdk_env.sh` if using the tools interactively.
The SDK may prepend its own Python 3.9; in that case set `PYTHON` to an absolute
Python 3.12+ executable when running the shell recipe. Emscripten may still use
its bundled Python internally, and both versions are recorded separately.

From the repository root:

```
PYTHON=/path/to/python3.12 bash tools/build-step-converter.sh --emsdk /path/to/emsdk --jobs 2
```

The script downloads and verifies the two complete source archives, applies each
local patch, configures CMake Release with upstream `-Oz`, Wasm exceptions, memory
growth and a 10 MiB stack, then compiles/links with at most two jobs. The packaging
patch adds ES-module output for browser Workers and Node. Build logs stay in the
reported work directory. No claim of byte-identical output across platforms or
identical output to the publisher's Windows binary is made.
`EMCC_CORES` and `BINARYEN_CORES` also follow the selected job count, including
runtime-library compilation and Wasm optimization during the final link.

The source kit contains complete unmodified wrapper and OCCT trees, the pinned
Emscripten preferred source (including generated JS/C/C++ runtime sources), the
SDK installer source, local patches, this build recipe, pins, license texts and
replacement instructions. To rebuild
without fetching those source archives, extract it and run:

```
bash tools/build-step-converter.sh --emsdk /path/to/emsdk --source-tree upstream/occt-import-js --output-dir result --jobs 2
```

To prepare the exact source kit without invoking a compiler:

```
bash tools/build-step-converter.sh --source-kit-only --output-dir /path/to/output
```

Source-kit tar entries have normalized timestamps and ownership and are sorted;
gzip has no embedded filename/time. `manifest.json` is deliberately not inside the
source kit, avoiding a self-referential source-kit hash. The kit contains all input
pins, patches and build instructions needed to produce a new manifest.

## Replace in your own installation

Modify the included preferred source or local patches, build with the same public
`ReadStepFile` interface/receipt contract, and replace JS, WASM, corresponding source
and the regenerated manifest together. `--source-tree` accepts the included source
tree, including your own modifications; upstream pins identify the baseline, not a
claim that user-modified sources are unchanged. No signature or immutable official
hash is required to build or self-host a compatible replacement. Release hashes
identify the artifacts tested by FEM Lab.

## Public conversion receipt

`ReadStepFile(Uint8Array, params)` is synchronous after asynchronous factory setup.
Pass meter output, absolute deflection and explicit positive linear/angular values.
The normal output arrays and hierarchy remain available. A successful conversion
also has `femlab` with `version`, `complete: true`, `roots`, `transferredRoots`,
`sourceRoots`, `faces`, `meshes`, and `triangles`. Roots are recognized STEP transfer
roots; sourceRoots are the document's free shape roots; faces count post-transfer
TopoDS face occurrences. Every counted face must have nonempty triangulation and
emitted output; the recognized root transfer counts must agree. This receipt does not claim universal support
for every STEP entity, application protocol or geometric convention. Transfer
warnings are rejected as well as failures: OCCT can otherwise omit an unsupported
child face while returning a valid, closed parent solid. This conservative policy
also rejects files whose transfer warning might be harmless.

Failures return `success: false`, a receipt with `complete: false`, and
`error: {code, cause, where}`. No partial output is returned. Codes distinguish file
read/integrity, no roots, transfer/check failures, missing roots, external files,
unsupported/empty topology, mesher failure, missing face triangulation, resource
limits, emitted-output mismatch and kernel exceptions. The converter caps input
at 16 MiB and output at 500,000 triangles. OCCT can allocate during tessellation
before triangle counts are available; these limits do not promise bounded peak
kernel memory. Cancellation/time limits belong to an external Worker owner.
