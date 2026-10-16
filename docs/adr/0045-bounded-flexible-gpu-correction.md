---
status: proposed
date: 2026-10-16
issue: https://github.com/andeplane/fem-lab/issues/3
---

# Bound flexible f64 correction around the f32 GPU solve

The stationary update `x += inner(b-Kx)` need not contract when the inner solve
is inaccurate. The combined-source real-device 780,300-equation run reached
true residuals 1, 38.82875659079523, 440.73465384030953 and
3765.703286884391 despite meeting the f32 recurrence targets. This is numerical
failure, not evidence of resource exhaustion or successful D5 acceptance.

## Decision

For `gpu-pcg`, use right flexible GCR with the existing GPU inner solver as the
approximate inverse. Compute `z = inner(r)` and `q = K z` using the original f64
physical operator. Apply two fixed modified Gram–Schmidt passes to both members
of each pair against retained `(z,q,q dot q)` tuples, dividing each projection
by the stored squared norm. Keep the vectors unnormalized and update x by
`((r dot q)/(q dot q)) z`. When `Kz=r`, the numerator and denominator are
identical, so alpha is exactly one without a square-root normalization roundtrip. Recompute `b-Kx` in f64 before every stopping decision. In exact
arithmetic this minimizes the residual over the retained correction span; finite
precision and an ineffective inner inverse still permit failure. No convergence
or speed guarantee follows for the large cantilever.

Keep at most eight `(z,q,q dot q)` tuples. Restart by discarding the active history while
keeping x; reuse the allocated arrays. The existing default eight outer steps,
requested tolerance and factor-100 arithmetic-floor acceptance remain unchanged.
Zero or nonfinite squared direction norm reports stalled unless the already recomputed
physical residual meets the existing floor. Propagate inner errors and cancellation.
CPU iterative refinement is unchanged. The GPU operator, hierarchy and all
physical/reference gates are unchanged; there is no CPU solve fallback or
emulated-f64 GPU operator. Solver internals remain outside the plugin extension
points (ADR0010), and the registry and Journal formats do not change.

## Resource boundary

Before solver setup or upload, admit
`(4 + 2*min(max_outer,8))*n*8 + 1024` bytes for four f64 vectors,
the retained pairs and bounded metadata. GCR dot products use a fixed 64-entry
stack workspace, preserving the existing 4096-entry chunk sums and ordered
accumulation without a length-dependent partial-sum allocation. The 512-byte
workspace, eight 56-byte tuple headers and the 24-byte history Vec header
total 984 bytes on 64-bit targets (checked with `size_of`), within the 1024-byte allowance. Reject above 256 MiB or the available
setup allowance. Deduct that charge from the unchanged cumulative setup cap.
Admission is not an RSS estimate: host free-memory, swap and measured peak-memory
guards remain necessary for large hardware tests. At max_outer=0 the loop exits
before requesting an inner direction or indexing the empty history.

## Evidence and limits

Closed-form tests solve the two-dimensional system with exact solution `(1,2)`
using an inner inverse for which stationary refinement fails; a ten-dimensional
diagonal system exercises restart. Tests retain exact one/four-thread fields,
zero RHS, budget, cancellation, rank, nonfinite, inner error and admission gates.
Exact-inner identity-system tests require bit-exact `(0.25,-0.5)` and `(1,1)`
and zero residual at one/four threads. The latter also detects the normalization
roundtrip in a CPU-only run. The first normalized implementation
failed two unchanged small-GPU exact oracles: residual zero became
2.775557561562891e-15 and `(0.25,-0.5)` became
`(0.25000000000000006,-0.5000000000000001)` (19 other tests passed,
2 ignored; RSS 168 MB, footprint 235 MB, no resource guard fired). Those
failures motivate removing normalization. The final unnormalized source passed
all 21 active real Metal GPU tests and the unchanged 66,150-equation benchmark on
home-mini, including direct-displacement, B1, force/moment equilibrium and complete
one/four-thread field checks. No external resource guard fired. Strict LLVM coverage
including GPU execution passed with zero misses: 74,461 regions, 3,966 functions
and 35,143 lines, each 100%. These results are bound to the tested source hashes;
they do not establish the 780k D5 gate.

The prepared 780,300-equation run was refused before launch: only 60% of the mini's
16 GiB was available, below the predeclared 70% host-admission threshold. Prior
measured peak RSS was about 9.3 GB. This is neither a numerical result nor a reason
to lower the engine or host guards. The original 780k B1/equilibrium/true-residual
test remains mandatory and unaccepted. No larger-case convergence or performance
claim follows from the smaller tests.

## Primary references

- [PETSc KSPGCR](https://petsc.org/release/manualpages/KSP/KSPGCR/):
  right flexible preconditioning, bounded restart history and restart from x.
- [Carson and Higham, 2018](https://epubs.siam.org/doi/10.1137/17M1140819):
  mixed-precision refinement and Krylov correction. Its GMRES/LU analysis is
  motivation, not a proof of convergence for this GCR/aggregation combination.
