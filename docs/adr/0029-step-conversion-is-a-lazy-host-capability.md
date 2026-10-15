---
status: proposed
date: 2026-10-15
---

# STEP conversion is a lazy host capability; replay stores triangle geometry

Issue [#351](https://github.com/andeplane/fem-lab/issues/351),
[implementation and verification plan](../plans/351-step-import.md).

## Decision

Convert STEP to triangle geometry in a dedicated on-demand browser Worker, then issue the
existing checked `geometry.import` Command. The engine remains a headless Rust library
([ADR 0011](0011-engine-is-a-headless-library-browser-is-one-host.md),
[ADR 0012](0012-engine-in-rust-hosts-in-typescript.md)). The native CLI and other hosts replay
the resulting ordinary Journal without a CAD converter or the original STEP file.

Use an exact, pinned OCCT converter artifact with its corresponding source and build recipe;
the current candidate is `occt-import-js@0.0.23`. Read declared STEP units and request meter
output, physical absolute linear deflection and explicit angular deflection. Unit conversion
uses the engine's existing checked Query. Encode converted doubles as deterministic ASCII
STL so the existing STL command can preserve their precision. No new Rust format or geometry
kernel is added.

An import adds/reimports a named Body. It captures original session identity and stateVersion
before any input/conversion await, then uses the ordinary WriteRequest expectedVersion
check. It does not read a new stamp just before queued publication. This preserves the
existing atomic single-Command behavior and avoids a new Candidate/project protocol.
Conversion cancellation terminates its Worker; disposal and late messages cannot mutate a
replacement project. Worker creation, I/O and hashing are typed injected boundaries.

## Fidelity and names

The stored Body is a tessellated solid, not an exact STEP B-rep. Its approximation is limited
by the chosen deflection and floating-point/geometry validation. Original feature history,
CAD face identifiers and part material assignments are not retained. All source geometry
must be accounted for, with unsupported or invalid content rejected explicitly. Source
subparts are not silently dropped or advertised as independently editable Bodies.

Named analysis targets use the existing imported patches and `geometry.nameFace` predicates.
The original CAD converter is absent from replay, so a later converter upgrade cannot
silently change an existing Journal. Original-byte digest, converted digest, converter
version, units and deflection are reported at conversion; explicit triangle data and its
checked hash remain replay authority.

## Distribution and replacement

The wrapper's pinned CMake build compiles wrapper and OCCT code into one WASM executable.
Loading it lazily does **not** demonstrate LGPL dynamic linkage. The OCCT header exception
is not treated as a general exemption for the combined executable. The standalone
converter stays separate from the MIT FEM engine/application, with its own preserved
license notices and rebuild/replacement materials.

Before distribution, provide the LGPL texts, the pinned OCCT exception, complete identified
wrapper and OCCT source, and build scripts by the same distribution route as the converter.
Document how to rebuild and replace the module; do not add signature or integrity policy
that prevents a person using their compatible rebuilt module in their own installation.
Record the exact unmodified package hashes and source metadata without claiming
byte-reproducible upstream builds: the npm publication workflow does not attest such a
rebuild, and the published tarball omits OCCT's source submodule and exception text.

Primary references:

- [Pinned wrapper source/build/license](https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2).
- [Pinned OCCT source](https://github.com/Open-Cascade-SAS/OCCT/tree/d2abb6d844231cb8f29be6894440874a4700e4a5),
  including `LICENSE_LGPL_21.txt` and `OCCT_LGPL_EXCEPTION.txt`.
- [OCCT license and exception](https://dev.opencascade.org/doc/overview/html/occt_public_license.html).

The source/rebuild/distribution proof is a release gate, not a future cleanup task. A
concrete unresolved requirement is recorded on the issue before shipping is claimed.

## Alternatives

- Put OCCT inside the Rust engine: gives a second platform/toolchain boundary and burdens
  all hosts/replay with CAD code. It violates the chosen engine/host separation.
- Parse Part-21 syntax only: does not evaluate surfaces or produce an admissible solid.
- Keep an original STEP path in the Journal: replay would depend on a file, converter
  version and external state instead of the recorded geometry.
- Embed the converter at boot: pays its download/initialization for people who never import
  CAD and competes with the existing cold-boot budget.
- Add fillet/chamfer/shell now: that is the independent decision in #352, not required to
  import converted geometry. This ADR does not approve a general B-rep editing architecture.

## Consequences

The converter is large but truly on demand. Same-source analytic/refinement fixtures,
native/WASM replay without the converter, atomic session/cancellation tests, real Chromium
import-to-mesh, and source/license/lazy-loading checks are mandatory. The plan names those
gates and the known fidelity boundary; an issue closure must not imply universal STEP
support or exact-CAD preservation.
