# GPU convergence at large model sizes — issue #3

Issue: https://github.com/andeplane/fem-lab/issues/3. Browser CPU threading remains separate issue #17.

The D5 `[100,50,50]` incompatible-mode Hex8 cantilever has 780,300 reduced equations. At issue start, its ignored harness printed a stalled GPU solve without an acceptance assertion. This branch now declares the physical/residual assertions; execution remains pending. The 66k sibling keeps its existing numerical gate. Acceptance must preserve the f64 outer residual tolerance, reject a CPU fallback as GPU success, and avoid software-adapter performance claims.

## Establish the numerical cause

Before changing the operator, compare the f64 assembled system, the uploaded rounded f32 system, and fixed symmetric preconditioners on bounded sparse fixtures. Distinguish poor Jacobi conditioning from a loss of positive definiteness after f32 rounding. An SPD preconditioner cannot repair an indefinite CG operator. Record nonpositive curvature explicitly in the diagnostic rather than treating the device halt as convergence.

Start with at most 8,000 equations and a 512 MiB process budget; never form a dense large stiffness matrix. Use exact small SPD systems, discrete Poisson sine eigenvectors and polynomial elasticity displacement fields as independent energy/residual probes. A larger sparse extraction requires a separate explicit memory estimate and compute lease. Native compilation/device work is serialized with the other active workstreams.

## Implement through the existing solver boundary

Keep `solve.run`, `Solver::GpuPcg`, the headless engine and the existing linear-solve boundary. ADR0010 explicitly places internal solver hooks outside plugin extension points. Deterministic f64 setup may construct an aggregation hierarchy; iterative fine/coarse operator applications and vector/preconditioner work run on the GPU in f32, with the existing f64 outer residual and correction accumulation.

The preconditioner must be a fixed symmetric positive-definite linear map suitable for PCG: paired pre/post smoothing, Galerkin coarse operators and deterministic gather restriction/prolongation, with no scatter atomics. Keep `r·z` for PCG separate from `r·r` used by convergence tests. Bound coarse dimensions, hierarchy nonzeros and device allocations before allocation.

Elasticity aggregation needs the correct near-nullspace and degree-of-freedom grouping. Reduced row numbers cannot be interpreted as node components: supports, slaves and inert degrees of freedom remove rows. Trace the existing reduction map and carry typed optional solver metadata from procedures if required; document that durable tradeoff in an ADR before changing the boundary. Scalar algebraic aggregation alone is a diagnostic baseline, not evidence of robust vector elasticity convergence.

## Acceptance

- Analytical small SPD and Poisson eigenmode solutions; preconditioner linearity, symmetry and positive energy; adverse singular/indefinite and resource/cancellation cases.
- Actual GPU execution of the shipped shaders on the CI software adapter, static WGSL validation and meaningful 100% engine/geometry line, function and region coverage.
- Elasticity affine/rigid-mode patch and axial-load closed forms across multiple meshes. Use the existing B1 Timoshenko bending tolerance unchanged, with direct-factorization cross-checks as secondary consistency evidence only.
- Fixed-order setup/reductions and repeated-device/1-vs-N CPU-thread determinism. Preserve imported mean-dilatation and original source semantics.
- The 66k sibling keeps its current `1e-8` relative displacement agreement and residual policy. Promote the 780,300-equation harness from print-only to asserted solver identity, finite answer, equilibrium/residual and the independently declared B1 reference gate. No giant direct solve is required as its oracle.
- Record actual hierarchy/operator sizes, iteration counts, residuals and adapter identity. Only a real device run can support performance observations; software-adapter timings are not performance evidence.

The initial source base is frozen import candidate `1986cd9064e30aaf9fbd73270433ee87b3c0f7a7`. Issue #3 remains open until the implementation and numerical/coverage gates pass. Issue #17 is claimed and delivered separately when its work actually starts.


## Provisional source checkpoint

The source now contains a deterministic vector smoothed-aggregation setup, a fixed GPU
forward/reverse degree-four Chebyshev cycle, bounded CᵀC coarse application, and separate
r·z/ r·r PCG reductions. Static procedures carry original-node groups and reduced physical
modes through the existing solver boundary; public matrix-only entry points remain wrappers.
Exact diagonals retain their algebraic identity specialization. ADR0040 records the tradeoff.

The aggregation producers `796e58cd` and `333af63e` compiled for WASM and the native
Linux CLI. At `333af63e`, the admission/adverse unit tests, Linux lint and actual device-loss
tests passed. Aggregation mathematics remains **unaccepted**: its first GPU execution
stopped at a reserved WGSL entry name. The entry rename and snapshot correction below
await their own remote checks.
The bounded independent CPU probes guide selection only. The 66k and asserted 780,300 cases
remain required; the latter will not be allocated until a real peak/capacity estimate and
compute lease are agreed. The branch is rebased from the original 1986 candidate onto merged
import main 5c9 and incorporates the current 607 Checks freshness repair before publication.


## First actual aggregation execution

At `333af63e`, the remote Linux all-target lint check and 165 engine unit tests plus 392
engine integration tests passed. The actual software-adapter device-loss tests passed at
all three readback boundaries. GPU aggregation execution stopped on a concrete WGSL parser
error: `smooth` is a reserved identifier. This is not a convergence result. The next
checkpoint renames that entry and its host reference, updates the exact explanatory
capacity-note snapshot, moves the proposed ADR to its reserved number0040, and removes
elapsed-time logging from the correctness harness. Numerical oracles and tolerances remain
unchanged. Actual GPU numerical/coverage and 66k gates remain open.

## Bounded Metal execution and readback diagnosis

At `12aea784`, five existing bounded witnesses passed on Apple M4 Max (Metal):
Poisson eigenmodes at 31/127/1023 rows with cycle symmetry, linearity and positive energy;
the 127-row empty-transfer-chunk SPD solution; public 1200-equation B1 bending and
equilibrium with exact 1/4-thread displacement identity; the 216-equation direct comparison;
and uniaxial mean-dilatation displacement/stress at three meshes. Original tolerances and
the f64 residual gate were unchanged. These are correctness checks, not performance claims.

The one authorized 66,150-equation run at the same head remains **RED**. Symbolic-only
preflight measured 86,223,249 supernodal factor values (689,785,992 bytes) and 163,053,183
bytes of numeric scratch. The independent direct reference completed. The GPU hierarchy
admitted rows `[66150,14807,2070,264,36]`, 15,473,041 operator entries including the root,
11,336,566 transfer entries and a 221,378,772-byte conservative device payload. Its first
batched scalar readback returned `internal` at `solve/readback` before numerical acceptance.
OS-reported maximum RSS was 1,949,483,008 bytes, with a 2,304,232,352-byte peak memory
footprint; no resource cap triggered. This is a device execution/readback failure, with no
evidence of failed convergence or a long-running GPU watchdog.

The next checkpoint preserves the actual validation, poll and mapping outcomes and the
typed device-loss reason in the existing structured readback error. State belongs to the
injected GPU, with no globals or solver-decision changes. Existing real invalid-copy and
device-destruction tests must verify these diagnostics. The #740 zero-equation guard is
integrated at the shared private refinement boundary, retaining its public affine recovery
and Journal/replay test. The current software-GPU/100% gate remains on `12aea784` until its
feedback is collected. No 66k retry or 780,300-equation allocation is accepted by these checks.

The diagnostic checkpoint compiled locally and passed focused Clippy, formatting and eight
real Metal tests: the invalid-copy diagnostic, all three actual device-loss boundaries,
the integrated #740 affine recovery/replay case and the five bounded numerical witnesses.
Whole-engine software-GPU coverage remains pending. A separately authorized, resource-bound
66k diagnostic attempt may now collect the previously erased cause without changing its
original assertions; a failed diagnostic is retained and never treated as convergence.

## Metal command-buffer budget

The separately authorized `63c15b30` 66k diagnostic remained RED: the first batched
readback retained `validation=Some` (invalid staging buffer), `poll=Ok(QueueEmpty)`,
an unawaited mapping and `device_loss=Some((Unknown,"Device is lost"))`. The actual
hierarchy counts matched `12aea784`. No resource cap triggered and no convergence
result was produced. The raw HAL warning was not captured by the test binary.

Shipped-source cardinality establishes a concrete backend limit: each fine level records
22 compute passes plus its child; four fine levels and the C/CT leaf make 90. Four CG
passes make 94 per iteration, hence 2350 passes in the unchanged 25-iteration batch.
wgpu-core 30 records a native body and transition buffer per pass. At least 4700 native
buffers cannot fit Metal HAL's 4096 outstanding-unsubmitted-buffer guard, which reports
device loss before submission. The proposed repair records the complete ordered V-cycle
inside one compute pass, retaining every binding, dispatch, kernel and numerical setting.
Actual bounded Metal witnesses and the existing 66k test, followed by software-GPU
validation and 100% coverage, remain the acceptance gates. No 780k allocation is authorized.

The pass-fusion source checkpoint compiled and passed focused Clippy/formatting and the
same eight bounded real Metal tests. Independent source review confirmed wgpu's per-dispatch
usage validation/barriers when storage buffers change read/write roles inside a pass.
The original 66k regression and software-GPU/whole-engine coverage remain pending.


## Actual pass-fusion and preparation acceptance

The unchanged 66,150-equation regression passed on Apple M4 Max Metal at `c09f13be`
in both debug and production release profiles: B1/equilibrium, f64 residual and the original
`1e-8` direct displacement comparison, with exact 1/4-thread fields. Release retained
8 outer refinements, 1049 actual inner updates and residual `4.802661830863288e-10`.
The fully monitored release numerical run had OS maximum RSS 1,981,005,824 bytes;
this is resource evidence for that fixture, not a 780k peak bound or performance claim.

Exact `12aea784` software-GPU strict passed all 19 GPU tests, 165 engine unit and
392 engine integration tests. Its remaining failure was coverage: 109 regions, ten
functions and 17 lines across setup/admission/procedure propagation. The new preparation
checkpoint consolidates those admissions into one pure, explicitly limited boundary.
A borrowed physical descriptor allocates no columns until a Fine GPU root consumes them;
coarse/diagonal roots and CPU solves skip that storage. Complete pipelines compile before
admitted uploads. Widened exact phase accounting and proven internal row bounds replace
unreachable overflow/numeric propagation, without changing arithmetic order or tolerances.
Tiny exact/exact-minus-one resource oracles, physical translations/rotations and actual
device-loss propagation accompany the refactor. Fresh coverage remains required before
publication; the old RED and c09 numerical receipts remain immutable. No 780k allocation
has been performed.


The broader bounded Metal run exposed an existing oracle error, reproduced by the sealed
c09 binary: the raw rounded rank-one operator has zero curvature for `(1,-1)`, but applying
rounded C and CT first can perturb that direction. Actual Metal returned
`(67108864,-67108860)`, matching independent f32 fused arithmetic; its exact curvature under
the all-ones operator is 16. One finite inner update is therefore valid partial progress,
not a physical solution; the original f64 outer solve refused it. The corrected test retains
every raw zero-update assertion, checks public zero-update failure with the independent
one-row A=-1/identity-preconditioner oracle, and separately requires structured f64 outer
failure for the original positive-definite rank-loss fixture. No numeric production code
or acceptance threshold changes accompany this correction.


Capacity propagation is exercised through real bounded quota walks rather than invented
ledger states. Structured setup errors now state the actual requested bytes/entry count and
admitted limit; per-vector platform ceilings remain separate. The property advances only to
that declared request, checks strict progress/bounded attempts and exact final-boundary
refusal, then independently verifies Dirichlet-chain energy/transfer duality or the two-spring
inverse. Full Plan equality supplies only the secondary resource-independence check.
