# FEM Lab patch for issue #17

Upstream atomic-wait 1.1.0 supports Linux, FreeBSD, Windows and Apple platforms.
faer 0.24.4 enables this dependency through spindle when its Rayon feature is enabled,
so the threaded browser build otherwise fails with an unresolved `platform` module.

This exact BSD-2-Clause source copy adds only a wasm32 shared-memory backend and
wasm-only feature/platform declarations. Native platform source files are unchanged;
`UPSTREAM.json` records their original hashes and source identity. The upstream README,
Cargo manifests, license and tests are retained without edits.

The wasm implementation uses the standard wait32/notify instructions, with an infinite
wait timeout and the expected unsigned bit pattern. Safe wake accepts null/dangling
pointers, so notification checks alignment and linear-memory bounds without dereferencing
its pointer. Shared memory only grows, making the bounds check safe. Blocking occurs
inside dedicated browser Workers, never on the UI thread. The already pinned nightly
is required for Rust's wasm atomic wait intrinsics.

CI compiles `tools/wasm-wait-smoke.rs` against this exact backend and tests actual
shared-memory wait, wake-one, wake-all, unequal values and invalid safe notifications
with Node workers. Chromium separately verifies the actual engine's one/four-worker
numerical outputs and Journals. Native strict CI retains all existing gates.

Remove this patch when upstream provides equivalent wasm32 support. Do not replace it
with a spin loop or disable faer's parallel factorization to hide the build failure.
