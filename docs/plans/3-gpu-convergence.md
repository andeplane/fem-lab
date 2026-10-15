# GPU convergence at large model sizes — issue #3

Issue: https://github.com/andeplane/fem-lab/issues/3. Browser CPU threading remains separate issue #17.

The current D5 `[100,50,50]` incompatible-mode Hex8 cantilever has 780,300 reduced equations. Its ignored harness prints a stalled GPU solve and asserts no acceptance criterion. The 66k sibling has a numerical gate. This work must turn the large case into an asserted result without changing the existing f64 outer residual tolerance, accepting a CPU fallback as GPU success, or using software adapters for performance claims.

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
Exact diagonals retain their algebraic identity specialization. ADR0038 records the tradeoff.

This checkpoint is **uncompiled and unaccepted** pending remote compiler and actual GPU
checks. No local build/device run is authorized during the shared disk resource window.
The bounded independent CPU probes guide selection only. The 66k and asserted 780,300 cases
remain required; the latter will not be allocated until a real peak/capacity estimate and
compute lease are agreed. The branch is rebased from the original 1986 candidate onto merged
import main 5c9 and incorporates the current 607 Checks freshness repair before publication.
