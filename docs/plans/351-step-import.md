# STEP geometry import (#351)

Issue: [#351](https://github.com/andeplane/fem-lab/issues/351). Related umbrella:
[#80](https://github.com/andeplane/fem-lab/issues/80). The separate decision about fillet,
chamfer and shell remains [#352](https://github.com/andeplane/fem-lab/issues/352).
Decision: [ADR 0029](../adr/0029-step-conversion-is-a-lazy-host-capability.md).

This plan starts from main `eced67dd`. It does not change the Rust engine, Candidate,
project-folder I/O (#13), imported-file consistency (#341), or session architecture (#378).

## Outcome and fidelity

Read a STEP file in the browser, convert its geometry on demand, and add or re-import a named
Body through the ordinary checked `geometry.import` Command. The Model and Journal contain
the converted triangle geometry, so native CLI, MCP and future hosts replay without OCCT,
the original STEP file, a file handle, or a network request.

This is tessellated geometry. Exact B-rep, CAD feature history, original face identifiers,
CAD material assignments and editable fillets are not retained. Existing imported patches
and `geometry.nameFace` predicates provide the same face-target workflow as STL. Every
returned mesh must be accounted for: unsupported topology or geometry is rejected rather
than silently dropping a face, a mesh or an instance. Multiple returned meshes, if supported,
become one explicitly reported Body; part-level identity is not invented. The first proved
acceptance fixtures are a closed box and an exact cylindrical surface, not a claim to read
every STEP application protocol or assembly convention.

## Primary-source dependency evidence

The chosen candidate is the exact published `occt-import-js@0.0.23`, not the repository's
unpublished 0.0.24 package version. Package metadata identifies wrapper commit
[`c2148e54`](https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2)
and its OCCT submodule
[`d2abb6d8`](https://github.com/Open-Cascade-SAS/OCCT/tree/d2abb6d844231cb8f29be6894440874a4700e4a5)
(7.6.1). This is source metadata, not a claim of reproducible binary attestation.

The published converter consists of a 7,604,031-byte WASM executable and 96,871-byte JS glue.
The WASM SHA-256 is `33391fc9d94ea5c869a6718488bf0a9a464222bac9bdc764dfe1690cef281952`.
It is a standalone converter, never linked into the FEM engine. Its entire download and
initialisation remain outside landing, preloads and engine boot. The existing landing and
3 MiB gzip cold-boot budgets remain required.

The wrapper and OCCT code are compiled together into the converter. A lazy JS import is
not evidence of LGPL dynamic linkage. Distribution must include the actual LGPL notices,
the pinned OCCT exception, corresponding wrapper/OCCT source and build scripts, plus a
documented rebuilding/replacement route. The npm archive omits the OCCT submodule and its
exception text, so copying only that archive's notices is insufficient. The implementation
must establish the source-distribution route before adding the converter to a shipped build.

## Units and conversion contract

- STEP's declared length units are read by OCCT. Ask the converter for **meters**, absolute
  linear deflection and an explicit angular deflection in radians. Do not guess `1 mm` for
  STEP or reuse the toolbar's display units. The resulting Command uses `unitLength: '1 m'`.
- Require a positive length Quantity for linear deflection. Convert it with checked
  `query.convert {to: 'm'}`; use the same existing unit parser for the angular Quantity
  (`to: 'rad'`). Reject wrong dimensions, nonfinite/nonpositive values and invalid ranges.
- The report states meter output, requested physical deflection, angular deflection,
  converter version, original-byte SHA-256, converted-byte hash, source mesh/triangle counts
  and the fidelity loss. The API does not return original STEP unit metadata, so do not
  invent that provenance. Saved replay authority is the explicit converted Command.
- The converter runs synchronously inside a dedicated lazily loaded Worker. Its factory,
  file input, hashing and cancellation boundaries are injected and fakeable. No OCCT, DOM,
  Worker, file system or network capability enters Rust.
- Output positions are C++ doubles exposed as JS Numbers. Preserve that precision through
  deterministic ASCII STL encoding; do not narrow through binary STL's f32 records.
  Reject nonfinite coordinates, malformed indices and incomplete/empty output. Preserve
  supplied transformed coordinates and winding; do not infer new transforms.
- Bound file metadata before reading, recheck actual bytes, and bound converted geometry
  against the existing 500,000-triangle engine ceiling and geometry payload limit before
  dispatch. Native engine geometry checks remain authoritative for watertightness and shape
  validity. Ordinary saves retain the existing exact 16 MiB ModelFile encoding policy.

## Admission, cancellation and publication

Preserve STL's existing add/re-import Body semantics. Capture the initiating session and
stateVersion before input I/O or converter loading. After conversion, submit exactly one
ordinary `geometry.import` with that captured admission, through the existing checked
WriteRequest expectedVersion boundary. A small typed SessionTransport helper may supply
that explicit admission; it must never recapture a newer stamp when its queued write runs.

An intervening model edit, project switch, expired producer or cancelled run rejects the
late import. View-only actions do not change admission. Converter errors, incomplete output,
engine geometry errors and file-picker cancellation leave Model, Journal, retained Results
and checked identity unchanged. The Cancel Command terminates the dedicated Worker, and
late worker messages cannot publish. A second conversion has a defined conflict/cancel
policy and cannot adopt the first one's response. Disposal releases all listeners/workers.

The UI is a registry-backed import action with explicit deflection fields, progress/cancel,
clear tessellation wording, and access to the normal imported face/meshing workflow.
The unsupported host boundary is explicit: hosts without a converter can replay the
Journal, but cannot pretend to parse an original STEP file.

## Verification gates

1. Independent self-authored STEP box and cylinder fixtures. Check box volume 6 m³, area
   22 m² and bounds for dimensions 1×2×3 m. Check cylinder volume 2π m³, area 6π m² and
   bounds for radius 1 m and height 2 m. Prove declared mm/m/inch unit conversion where
   fixtures cover it. Refine deflection at multiple levels, check analytic errors/bounds
   and convergence of the curved surface; a round trip through the same CAD kernel is
   supplementary, never the oracle.
2. Pure adapter and typed fake Worker/I/O tests for every meaningful success/error branch:
   bad parameters, corrupt/unsupported/empty geometry, bounds, load failure, termination,
   picker cancellation, deferred reads/conversion, second import and disposal. Registry
   retains 100% on all four metrics.
3. Real SessionWorkspace/SessionOwner tests: append and re-import, exact SI geometry and
   one Journal Command, assignment preservation, rejected geometry preserving full state,
   same-session edit and project replacement while conversion is pending, queued writes,
   producer cancellation and late responses. No private Engine bypass.
4. Save the converted Journal, remove the source fixture from the replay environment,
   and replay with the existing native CLI at 1 and 4 threads and Node WASM. Compare full
   geometry/patch measurements and hashes; the replay process has no converter installed.
5. Production Chromium: exercise the actual picker and lazy module, import a box/cylinder,
   inspect bounds/patches, create a durable face rule, mesh, and verify nonempty resolved
   face Sets. Test failed/cancelled/stale imports and useful UI copy. Record screenshots,
   trace, exact source/runtime provenance, and no converter request during cold boot.
6. Actual app build/size/license/source-asset checks, codegen freshness, workspace types,
   focused hosts and final CI gates. Reuse the authentic main engine/native pair only after
   source/schema equality, because this feature adds no Rust implementation. Coordinate
   the sole local JS/browser and native streams with the parent before heavy verification.

Any new material restriction found by real conversion or distribution proof is recorded
here and on #351 before changing scope. The completed feature is one issue and one PR.
