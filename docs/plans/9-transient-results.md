# Transient Results: retained fields, queries and playback

Status: implemented through closed #243–#246, with retained comparison integrated by #286.
Implementation is complete; final epic closeout is tracked on #9.
Reconciliation: [status reconciliation #612](https://github.com/andeplane/fem-lab/issues/612).
Parent: [#9](https://github.com/andeplane/fem-lab/issues/9); design audit
[#90](https://github.com/andeplane/fem-lab/issues/90).
Inspected baseline: `d4bceba` (2026-09-06).

## Historical baseline (2026-09-06)

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

## Accepted contract

The original requirements below are preserved; their current implementation and verification
are mapped in the acceptance audit at the end of this plan.

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

[#244](https://github.com/andeplane/fem-lab/issues/244) implements counted retention and staging
in `query.cost`, checked arithmetic and host budget checks before allocation. The current
WASM estimate explicitly reports its incomplete host-memory scope, as audited below.
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
existing scripts and modal controls. The implemented separate host Command is
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
capabilities. The compatibility and eager-storage decisions were accepted in plan review. A future
materially different lifetime or public selection contract still requires an ADR.

## Acceptance audit at main `eced67dd` (2026-10-15)

The accepted source is main `eced67dd09906269c8bd946c442225846bcb99db`, whole tree
`0abc2e2799c62f21c7128565a1b93a1a09efa66b`, identical to tested #286 head `79d9b7f5`.
[Final fast CI](https://github.com/andeplane/fem-lab/actions/runs/38676074047) and
[full strict validation](https://github.com/andeplane/fem-lab/actions/runs/38676136571) passed.
The GPU-inclusive report covers 28,545 lines, 3,328 functions and 61,241 regions at 100%, with
no exclusions. The separate CPU bridge excludes `src/gpu/`; its totals are not the full report.
Native/WASM replay, registry 135/135 at 100%, app 1,274 passes plus five existing skips,
27 thumbnails, build/size, CPU Chromium 204 passes plus two skips, service-worker four passes
and SwiftShader four passes are recorded in those runs.

[Deployment 38679221526](https://github.com/andeplane/fem-lab/actions/runs/38679221526)
succeeded at that main commit. Three existing production Chromium cases passed against the
actual deployed app, zero retries: independent retained panes, sampled thermal comparison
and sampled explicit comparison. Each browser trace loaded WASM SHA256
`471980d4942142d0bb319e1b265b15f5cfc912756e3882d0872010f08747cfba`, matching the tested
complete browser/Node binding pair and emitted schema `088b6ebd…`. The deployment receipt,
source/runtime manifests, original logs and standalone replay dependencies are retained in the
#612 issue evidence index. Browser/raster acceptance does not claim physical-device or user
visual acceptance.

All four implementation children #243–#246 are closed. The original brief is implemented with
typed `query.frames`/`query.frame` and `FrameSample`, the protocol selected by the accepted
plan rather than a magic `frame:k` field string. Historical stress, reaction and heat-flux
fields remain explicitly unavailable; no final-time fallback or temporal interpolation is claimed.

| Original final verification requirement | Concrete current evidence and scope |
| --- | --- |
| Initial hot slab with fixed cold faces; several retained times/locations, both orders, spatial and temporal refinement, independent series tail and NAFEMS T3 | [`registry.rs`](../../crates/engine/tests/registry.rs), `retained_frames_cooling_slab_converges_to_the_fourier_solution`: all nodes and five path locations at 0.05/0.10/0.15 s, orders 1/2, 8/16/32 cells, spatial rates ≥1.8/3.5; backward-Euler dt 0.01/0.005/0.0025 improves >1.7 per halving. [`BENCHMARKS.md`](../BENCHMARKS.md) gives the 50-term series and conservative tail <1e−2186 K, and retains the separate NAFEMS T3 row. This is the original cooled-slab test, not merely #286’s later forced-slab comparison. |
| Retained explicit fields in 2D/3D, both orders, several meshes and time steps | `retained_frames_free_fall_match_every_node_in_two_and_three_dimensions` in the same registry binary checks every node/frame against free fall from rest, `uy=−4.905t²`, at 1/2/4 axial divisions, orders 1/2 and dt factors 0.5/0.9. The final frame equals the final field; 2D z is zero padded. Nonzero authored initial velocity is not claimed. |
| Initial/stride/final, endpoint, unavailable fields, selector errors, units and immutable reads | `retained_frames_uniform_heat_are_si_exact_and_follow_the_retention_schedule`, `retained_frames_sample_selection_errors_and_staleness_are_read_only` and the frame-selector regressions in `registry.rs` cover zero/normal/oversized strides, nonintegral endpoints, exact/nearest/tie/out-of-range and dimensional errors, final-field equality and unchanged Journal. |
| Full-solve native 1/N and Node-WASM parity; CLI/MCP/headless reads; skip-solves refusal | [`tools/test-transient-replay.mjs`](../../tools/test-transient-replay.mjs) exercises native one/four threads, real WASM and CLI `run --query`, exact hashes/times and independent frame/probe/path values. [`packages/mcp/test/integration.test.ts`](../../packages/mcp/test/integration.test.ts), “serves retained transient frames and sampled values through the actual MCP tools”, uses the real SDK/server/WASM for heat and 2D/3D explicit, both orders and two meshes. Final strict CI runs both. A future remote-network engine host is not claimed. |
| Retention cost, overflow/preallocation rejection, and measured WASM/Worker copy ownership before claiming a bound | `the_cost_of_a_step_is_the_sparsity_of_its_mesh`, `transient_cost_errors_are_structured_before_allocation` and `an_over_budget_transient_preserves_the_prior_result_and_engine` in `registry.rs` check retained counts/bytes, staging estimates and atomic over-budget rejection. [`transient-transport.spec.ts`](../../packages/app/e2e/transient-transport.spec.ts) measures actual transferred f64 payload byte lengths; the permanent replay detaches/mutates received buffers and checks unchanged repeated reads. `query.cost` labels `wasmTransportStagingComplete=false`; [`BENCHMARKS.md`](../BENCHMARKS.md), “Transient retention and peak phases”, separates the known 48×nodes numeric staging from strings, object/allocator overhead and GC. The measured scope is known payload/copies and counted costs. Total process/Worker heap and GC peaks remain unclaimed, consistently with the explicit completeness flag. |
| Real thermal/explicit playback, synchronized probe/legend/time, controls/cancel, ordering/invalidation and preserved modal behavior | [`transient-playback.spec.ts`](../../packages/app/e2e/transient-playback.spec.ts), [`transient-transport.spec.ts`](../../packages/app/e2e/transient-transport.spec.ts) and [`transient-comparison.spec.ts`](../../packages/app/e2e/transient-comparison.spec.ts) run actual WASM/Worker solves. They exercise distinct known-time contours/deformation/probes, playback and cancellation with unchanged Journal; deferred controller tests preserve late-reply fences. Existing modal/phase regressions remain in the same full CPU gate. Final deployed thermal/explicit cases supplement the local/CI evidence. |
| Fresh schema/types, registry 100%, full engine/geometry coverage including software GPU | Final strict validation above passes the actual native emitter/codegen and all host gates; its no-exclusion GPU-inclusive coverage is the full proof. |

No unmet implementation requirement was found in this original acceptance list. Known limits
remain deliberate: primary historical fields, eager budget-checked retention, no temporal interpolation,
and an explicitly incomplete total host-memory estimate. Final epic closeout is recorded on #9; this documentation change closes only #612.
