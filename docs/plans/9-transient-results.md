# Transient Results: retained fields, queries and playback

Status: proposed for review; no implementation authorized by this plan yet.
Parent: [#9](https://github.com/andeplane/fem-lab/issues/9); design audit
[#90](https://github.com/andeplane/fem-lab/issues/90).
Inspected baseline: `d4bceba` (2026-09-06).

## What exists and what is missing

`procedure/mod.rs::History` already retains a field name, times and full f64 nodal vectors.
Both `procedure/heat.rs::transient` and `procedure/explicit.rs::run` keep the initial state,
every `outputEvery` integration step and the final state. The issue's original description
that only min/max histories survive is outdated: `solve_run.rs::result_summary` exposes
only extrema, but the engine still owns the vectors. Do not duplicate that storage.

`Engine::field_named` serves final fields and one-based `mode:k`; `query.probe` and
`query.path` have no time selector. Explicit history contains the raw DOFs per node;
final displacement uses `vector_field` to expand 2D fields to three components. Heat
history contains temperature only, although the final Result can contain derived fields.

The browser's `DeformBar` currently scales the final displacement sinusoidally. The design
brief [line 177](../design_handoff_fem_lab/DESIGN-BRIEF.md) requires transient animation,
play/pause/speed and a frame scrubber. The reference README's sinusoidal prototype behavior
is useful for modes, but does not constitute physical-time playback.

## Contract to implement

Reuse `History` as the authoritative primary-field storage. Retained index 0 is the initial
condition; indices count retained frames, not solver iterations. Retain each stride and a
unique final endpoint, including when `outputEvery` exceeds the integration-step count.
[#152](https://github.com/andeplane/fem-lab/issues/152), already owned elsewhere, corrects
rounded integration endpoints; integrate its schedule instead of duplicating that fix.
The existing normalization `outputEvery=0` to 1 must stay compatible unless separately
changed with an explicit schema migration.

Add schema-owned `query.frames { step? }` metadata and `query.frame { step?, index, field? }`
for one primary nodal field. Metadata includes Result identity, retained index, SI time plus
display unit, field/components, node count and retention bytes. A frame payload carries
component layout and unit alongside f64 values; bulk rendering may cast to f32 at the host
boundary, without casting scientific probe values. Avoid embedding all frame arrays in
`query.result`; leave its existing summary and final-field defaults compatible.

Add a reusable optional selector to probe/path:
`sample: { kind: "frame", index } | { kind: "time", time: Quantity, sampling: "exact" | "nearest" }`.
Omission means the final field as today. Exact selection tolerates only roundoff after SI
conversion (document a scale-aware tolerance), otherwise reports the neighboring retained
times. Nearest requires an explicit request, selects the earlier frame on a tie and rejects
times outside the retained interval. Return the resolved index/time in sampled responses.
No extrapolation or temporal interpolation in this increment. Spatial interpolation remains
the engine's existing probe operation. A future interpolation feature must distinguish
approximation from stored data and get its own numerical benchmarks.

Canonical access is typed, rather than encoding the whole protocol in a magic `frame:k`
field string. If a compatibility alias is needed, define `frame:k` as the zero-based primary
frame and delegate to the same resolver; it cannot override `mode:k`'s one-based contract.
Normalize explicit 2D displacement through the existing engine conversion. Expose only the
fields actually retained (temperature or displacement); requesting earlier-time stress,
reaction or heat flux must fail clearly, never fall back to final-time values. Advertise
availability so the UI can disable these choices. Deriving additional quantities later must
use the solved model/mesh and existing postprocessors, not the mutable current Model.

Frame access inherits stale-Result/mesh protections from
[#133](https://github.com/andeplane/fem-lab/issues/133). Retained metadata remains inspectable;
spatial probes and geometry attachment must reject incompatible meshes, including changed
meshes with the same node count. Reads never append to the Journal or rerun a solve.

## Memory and lifetime

Primary storage is approximately `8 * nodeCount * primaryComponents * frameCount` bytes,
plus time values/vector overhead and the final Result already held. For 100,000 nodes and
1,001 frames this is about 0.801 GB for temperature or 2.402 GB for 3D displacement before
solver matrices and copies. Eager retained storage is already the implementation; retaining
it avoids recomputation latency and nondeterministic cancellation behavior. Checkpointed
recomputation and disk-backed frames are deferred, not silently substituted.

[#244](https://github.com/andeplane/fem-lab/issues/244) will include retention and peak staging
in `query.cost`, checked arithmetic and the existing host budget checks before allocation.
If a request does not fit, fail with a structured suggestion to increase `outputEvery`;
never silently drop requested frames. Keep one transient Result's existing lifetime rules
for replacement/undo/replay. A failed solve must not install a partial frame series.
The browser caches at most current/next payloads, with request-generation guards; transferring
a staging buffer must never detach the engine's retained source. Measure copies in the
actual WASM/Worker route before claiming a peak-memory bound.

## Work breakdown and dependencies

| Issue | Bounded deliverable | Dependencies |
| --- | --- | --- |
| [#243](https://github.com/andeplane/fem-lab/issues/243) | Typed frame catalogue/field and time-selected probe/path, primary-field layout, numerical tests | Integrate #152 endpoint and #133 stale-mesh fixes |
| [#244](https://github.com/andeplane/fem-lab/issues/244) | Retention cost, overflow/budget rejection, documented peak storage | Share #243 metadata/schedule |
| [#245](https://github.com/andeplane/fem-lab/issues/245) | WASM/Worker/headless routes and full-solve replay parity | #243; coordinate #145 replay semantics |
| [#246](https://github.com/andeplane/fem-lab/issues/246) | Real transient playback, synchronized contour/deformation/probe/time | #243, #245 and PR #236 |

Each child gets its own numbered branch and reviewed PR. Split #243 further if implementation
reveals that a single reviewable change cannot fit a working day; do not bypass the issue
boundary with an unreviewable combined engine/UI rewrite. The recommended first increment
is #243's primary frame catalogue/access plus closed-form tests, with probe/path following
in a second commit or linked child if necessary. This plan PR does not close #9.

## Deliberate animation migration

PR [#236](https://github.com/andeplane/fem-lab/pull/236) defines `view.animate.frame` as integer
0–100 percent phase and positive speed for the amplitude sweep. Preserve that contract for
existing scripts and modal controls. Add a separately named host Command, proposed
`view.playTransient { step, playing, speed?, sample? }`, where speed is positive simulated
seconds per wall second and sample uses retained index or unit-bearing physical time.
Playback advances according to the actual retained times, not uniform index spacing.

Use the same registry path for buttons, scripts and AI. Heat playback updates temperature
colors without a meaningless deformation multiplier. Explicit playback updates displacement
colors and deformation from the same selected frame. Keep physical time visible; a spatial
probe must sample that frame. Pause and scrubbing use one final host Command per gesture;
cancel restores the previous state. Request generations prevent old async frame replies from
replacing a new Step/Result. Stop playback on Result replacement/invalidation; do not animate
stale values against new geometry. View actions never mutate the engine Journal.

## Verification required before closing #9

- Extend the existing thermal tests with an independent slab transient solution at multiple
  retained times and locations (Fourier series for a uniform initial slab with fixed face
  temperatures, with a stated truncation bound). Verify temporal order against the analytical
  values under dt refinement and spatial convergence under mesh refinement, both orders.
  Retain the independent NAFEMS T3 reference point; do not use a finer run as the only oracle.
- Extend explicit free-fall/rigid-translation cases to compare every retained displacement
  with `u(t)=v0*t + g*t²/2` for 2D and 3D, both orders and several mesh/time-step choices.
  Keep existing energy/stability benchmarks. Add these per-frame checks to BENCHMARKS.md.
- Exercise initial/stride/final retention, nonintegral endpoint (#152), unavailable fields,
  invalid indices, exact/nearest/tie/out-of-range time and dimension mismatch. Compare final
  retained primary data with the final field and assert reads leave the Journal unchanged.
- Replay the same recorded Journal with solves enabled in native CPU and Node WASM, checking
  exact hashes and retained times; compare numerical fields/probes within documented
  floating-point tolerances and against the independent oracles. Exercise existing native
  CLI/MCP/headless query routes. A future remote network server is not claimed implemented.
  Skip-solves replay must report missing Results. Test one and N native threads.
- Test Worker transfer ownership and repeated reads, generated schema/typecheck, registry
  100% coverage, and GPU-inclusive engine/geometry line/function/region coverage at 100%.
- Real-WASM Chromium checks must show two distinct known-time thermal fields and explicit
  deformed geometries, synchronized probes/legend/time, play/pause/speed/scrub/cancel,
  out-of-order replies and invalidation. Preserve #236 modal/phase tests. No mock-only claim
  of real playback; no Journal changes from any viewer action.

Architecture follows ADRs 0003, 0007, 0008, 0010, 0011 and 0012: Rust owns numerical reads,
TypeScript hosts own clocks/rendering, one generated registry defines both human and AI
capabilities. The compatibility and eager-storage decisions above require review before
implementation; record an ADR if that review chooses a materially different lifetime or
public selection contract.
