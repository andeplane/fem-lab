---
status: accepted
date: 2026-10-15
---

# Exact CAD editing is deferred; analysis replay stays independent of a CAD kernel

Decision issue: [#352](https://github.com/andeplane/fem-lab/issues/352). Umbrella
[#80](https://github.com/andeplane/fem-lab/issues/80) remains open. This supersedes the
committed-v2 reading of [ADR 0005](0005-geometry-is-a-script-lattice-first-csg-next-brep-last.md)
and the corresponding [Phase 7 roadmap](../PLAN.md#9-phase-7-geometry-preparation-and-cad-interop).

## Decision

General fillet/chamfer of existing solid edges, CAD hollowing/offset and feature-aware
defeaturing are **deferred and uncommitted**. No release or date is assigned. This records
the current product scope; a later issue and ADR can approve a concrete implementation.
Closing #352 delivers this decision, not those operations or the rest of #80.

The analysis Model and Journal remain authoritative through ordinary engine Commands.
An optional future exact-CAD authoring tool could publish its tessellated result through
the checked `geometry.import` boundary. Hosts without that tool must still open, replay,
mesh and solve the resulting analysis. This ADR does not authorize or implement such a tool.

## Repository evidence and the STEP boundary

The engine preserves primitive parameters, analytic sketch lines/arcs and a Shape tree;
it is not devoid of analytic geometry. Its solid evaluator produces a tagged triangle
boundary using `manifold-rust`. `Shape` and `geometry.import` do not persist arbitrary
trimmed CAD surfaces, CAD edges, a B-rep object or a CAD feature-history tree. See
[`shape.rs`](../../crates/geometry/src/shape.rs),
[`solid.rs`](../../crates/geometry/src/solid.rs),
[`sketch.rs`](../../crates/geometry/src/sketch.rs) and the
[`geometry.import` contract](../../crates/engine/src/command.rs).

The active [#351](https://github.com/andeplane/fem-lab/issues/351) design,
[proposed ADR 0029 and plan at reviewed commit `b1181246`](https://github.com/andeplane/fem-lab/tree/b1181246086118136a6c89fc958e1cc309709c92/docs),
converts STEP in a lazy host Worker and records explicit converted geometry. Exact B-rep,
source face identifiers and feature history are discarded at that boundary. Its converter
does not make an imported Body an editable CAD document. Its implementation and acceptance
remain owned by #351; this decision adds no STEP support or completion claim.

The old issue rationale that working kernels are inherently JavaScript-only is too broad.
OCCT supplies native C++ modeling APIs, including
[fillet](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/src/BRepFilletAPI/BRepFilletAPI_MakeFillet.hxx),
[chamfer](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/src/BRepFilletAPI/BRepFilletAPI_MakeChamfer.hxx)
and [hollowing](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/src/BRepOffsetAPI/BRepOffsetAPI_MakeThickSolid.hxx).
A Rust/native/WASM binding is technically possible. The selected STEP wrapper is a host
converter; its limitations do not prove that a portable B-rep engine is impossible.

## Options and tradeoffs

| Option | Consequence | Current choice |
|---|---|---|
| Existing constructive geometry and imported triangles | Preserves the implemented registry, replay and meshing model; general edge editing is unavailable | Keep |
| Exact CAD authoring in an optional host, followed by an explicit geometry bake | Can preserve converter-free analysis replay, but needs a separate exact-source/editor lifecycle and loses CAD editability in the baked analysis | Possible future proposal; uncommitted |
| B-rep representation and operations inside the engine, with native and WASM bindings | Could make CAD operations replayable everywhere, but requires new persistence, topology identity, kernel/version and cross-platform contracts plus a C++ toolchain/distribution commitment | Defer; no architectural impossibility asserted |
| Approximate mesh beveling or offsets presented as exact CAD operations | Facets and patch edges do not establish the original analytic edge/surface or feature semantics | Do not use as a substitute for this capability; any approximate operation needs its own explicit contract |

Host authoring would follow the headless library and registry boundaries in
[ADR 0011](0011-engine-is-a-headless-library-browser-is-one-host.md) and
[ADR 0012](0012-engine-in-rust-hosts-in-typescript.md). The Journal must not contain an
ambient CAD handle, a local source path or a requirement to rerun a host-only kernel.
An unavailable authoring tool may prevent a new edit; it must not prevent analysis replay.
Upgrading the optional CAD kernel must not recompute recorded geometry on open or undo.

## Implemented workflows and their limits

- Use `geometry.add` with explicit sketch arcs/lines and extrusion or revolution for
  rounded or chamfered profiles where that construction represents the intended shape.
  These are authored profiles, not a general existing-edge fillet command.
- Construct cavities from explicit inner/outer shapes and boolean subtraction where the
  dimensions can be defined directly. This does not promise a general uniform offset.
- Edit or remove explicitly authored cuts, subject to the existing guarded lifecycle.
  Import `simplifyBelow` performs mesh simplification; it does not identify and remove a
  semantic CAD hole or fillet by its design radius.
- Create the required features in an external CAD tool, then import its STL geometry.
  The #351 STEP conversion path is separately in progress and remains tessellation-limited.
- Use the implemented `shell4` idealisation for an analysis midsurface with a Section
  thickness. A finite-element Shell is distinct from CAD hollowing and does not extract a
  midsurface or manufacture a hollow solid automatically.

Imported `face0`, `face1`, etc. are area-ordered triangle patches and can change on re-import.
`geometry.nameFace` predicates are re-evaluated, preserving the rule rather than a universal
CAD face identity. A rule can select a different region after a substantial shape edit;
its physical meaning still needs checking. CAD edits can split, merge or delete entities.
Kernel operation history is input to a naming design, not permission to retarget an analysis
load using an ordinal. The current engine has no persistent CAD edge-selection contract.

## Conditions for reopening exact CAD editing

A future issue must choose the supported operations and input representation, with a
reviewed ADR before implementation. Its plan must establish:

1. **Source and ownership.** Specify exact source/recipe storage, kernel version and hashes,
   source identity, units and physical tolerances. A triangle import does not recover the
   source B-rep or feature history. Any optional authoring artifact needs an explicit
   persistence contract; the analysis must remain usable without it.
2. **Topology and assignments.** Define target selection and generated/modified/deleted
   entity handling, including split/merge ambiguity, re-import and kernel upgrades. Define
   how affected named Sets, loads and constraints are checked and reported. No silent
   semantic reassignment by face or edge index.
3. **Atomic publication.** Use registry-backed actions, typed injected host boundaries,
   captured session/state admission and cancellation. Reject invalid or partial CAD output
   before publishing a checked ordinary geometry Command; preserve Model/Journal/Results
   on failure. Existing add/re-import semantics and undo remain explicit.
4. **Independent proof.** Analytical rounded-profile/chamfered-prism/hollow-box measurements,
   tolerances and refinement; invalid radius/thickness, self-intersection and topology
   changes; real Chromium authoring; and save/open/undo plus native 1/N-thread and WASM
   replay without the authoring kernel. A kernel round trip alone is not the oracle.
5. **Distribution.** Pin the actual modeling build and account for wrapper and kernel
   licenses. The OCCT version considered by #351 uses
   [LGPL 2.1](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/LICENSE_LGPL_21.txt)
   with a [header-use exception](https://github.com/Open-Cascade-SAS/OCCT/blob/d2abb6d844231cb8f29be6894440874a4700e4a5/OCCT_LGPL_EXCEPTION.txt).
   Lazy loading and a wrapper license do not settle obligations for a combined WASM build.
   Establish notices, corresponding source, build and compatible replacement materials for
   the chosen distribution, as #351 requires for its converter; a modeling build needs its
   own assessment. A commercial license is a separate possible tradeoff, not an assumption.

These are reopening gates, not scheduled deliverables. The independent #351 conversion,
existing primitive/sketch/CSG workflows and FE Shell support retain their own scope.
