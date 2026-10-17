---
status: proposed
date: 2026-10-17
issue: https://github.com/andeplane/fem-lab/issues/3
---

# Bound flexible f64 correction and preserve translation forces in the f32 operator

The stationary update `x += inner(b-Kx)` need not contract when the inner solve
is inaccurate. The 780,300-equation cantilever failed both stationary correction
and bounded flexible correction around an independently rounded CSR operator.
The latter reached a true f64 residual of 0.9996519469439982 after eight outer
steps. A better outer iteration alone did not repair the inner operator's lost
low-energy displacement modes.

## Decision

Use right flexible GMRES for `gpu-pcg`: apply the existing approximate GPU inverse
to successive Arnoldi basis vectors, multiply its returned directions by the
original f64 physical K, and perform two fixed modified Gram–Schmidt passes.
Keep the Arnoldi vectors unnormalized, retain their squared norms, and weight
the Hessenberg rows by those norms before Givens QR and back substitution.
For the first direction, compute `(r dot Kz)/(Kz dot Kz)` directly, preserving
bit-exact corrections when `Kz=r`. Recompute `b-Kx` in f64 before acceptance.

Keep at most eight Arnoldi/direction pairs, restarting from the current solution
when a larger outer budget is explicitly requested. The default eight outer
steps, 5000 inner iterations and factor-100 arithmetic-floor allowance remain
unchanged. Zero or nonfinite direction/rank reports `solve.stalled` unless the
already measured physical residual meets that allowance. Cancellation and inner
errors propagate. CPU refinement, solver selection and Journal formats do not change.

For a reduced `Solid3d` displacement system with three DOFs per node, evaluate
the fine f32 operator in local translation coordinates. Let S be the symmetric
Jacobi scale, and a(i,c) the free component-c DOF at row i's node, if present.
Compute the three row moments in fixed-order f64:

```
m(i,c) = S_i * sum_{j in component c} K_ij * S_a(i,c)
```

The shared WGSL gathers each row as

```
sum_c f32(m(i,c)) * p_a(i,c)
  + sum_j f32(S_i K_ij S_j) * (p_j - (f32(S_a)/f32(S_j))*p_a)
```

For an absent anchor its contribution is simply the ordinary scaled CSR term.
Before rounding this is exactly `S K S p`: the added anchor moments cancel the
subtracted anchor terms. This algebraic identity does not claim exact symmetry
after f32 rounding. It avoids subtracting large independently rounded stiffness
forces for a nearly uniform physical translation. All WGSL coefficients,
operations and vectors remain single f32, with one value per CSR entry; there
is no paired-float or emulated-f64 operator (ADR0002).

Matrix-only callers, other idealisations, coarse operators and transfers keep
ordinary CSR. The hierarchy is still constructed in f64 from the original
physical K and scaled coefficients. Only the original physical f64 residual,
plus the established physical benchmark gates, can accept a result. This is
an internal solver change, not a new plugin extension point (ADR0010).

## Resource boundary

Before setup/upload, admit `(4 + 2*min(max_outer,8))*n*8 + 4096` correction bytes,
including four work vectors, retained pairs, bounded Hessenberg/QR arrays and
fixed dot-product workspace. Keep the separate 256 MiB correction cap, charged
against the unchanged native 8 GiB / wasm 1536 MiB setup allowance. Dot products
retain the fixed 4096-entry chunk sums and ordered accumulation at one/N workers.
At max_outer=0 the loop exits before indexing the empty history.

Translation coordinates add `32*n` device bytes, and admit `32*n + 4*full_dofs +
1024` host bytes before allocating metadata. Check the metadata buffers against
the actual adapter limit. Conservative fine/device matrix charges include
the extended uniforms and dummy bindings. The native 4 GiB / wasm 1 GiB device
caps and all hierarchy limits remain unchanged. Uploaded fine/transfer/coarse
arrays are released before recursive hierarchy upload once device buffers own
their copies. These accounting bounds do not guarantee available host memory;
large hardware tests retain independent free-memory, swap, disk and peak guards.

## Evidence and limits

Closed-form CPU tests cover exact identity, an inaccurate inverse with known
two-dimensional solution `(1,2)`, restart on a diagonal system, cancellation,
rank/nonfinite failures, budgets and preallocation admission. Exact-inner cases
require bit-identical solutions at one/four workers. Metadata tests cover
partially prescribed nodes, translation-null spring rows, thread identity,
range checks and exact admission boundaries.

The actual shared WGSL is checked against two independent springs of stiffness
1 and 2^-26. Independently rounding `1 + 2^-26` loses the weak spring and creates
a spurious force under uniform translation; translation coordinates give exact
zero. Deformed and rigid-offset cases check exact spring forces in all three
components, with unequal dyadic scaling and rebased chunks.

On 17 October 2026 the translated-row candidate passed the unchanged 66,150-
equation B1, direct-comparison, equilibrium and one/four-thread gates on Metal
(true residual 5.222915328431264e-10). On Apple M1 Max Metal the unchanged 780,300-
equation case passed its 2% B1, force/moment equilibrium and true f64 residual
below 1e-8 gates: residual 2.267548104643227e-9 after six accepted corrections
and 1642 GPU updates. Its initial peak RSS was 10,643,292,160 bytes, below the
unchanged 10 GiB guard.

After explicit early release of uploaded host arrays, the final-source repeat
passed the same unchanged physical gates with the same residual, corrections
and GPU updates. Test time was 525.31 s, peak RSS 9,810,329,600 bytes and peak
physical footprint 8,783,695,232 bytes. No resource guard fired. The actual
arm64 binary SHA-256 was
`41408a4791dd210f4695b882f97bc4174a7bac96668d2a2436881ffecb7b51fe`;
all 395 runtime input hashes match committed source `c6b731ef`. This one-case
measurement is not a host-memory guarantee.

The final source also passed all 22 active native Metal GPU tests and the
unchanged 66k physical/direct comparison with complete one/four-worker identity.
Fresh Chromium SwiftShader execution passed both homogeneous/laminated shell
studies, the dot kernel and B1 cantilever through the wasm/WebGPU host. The
complete CPU browser suite passed 255 tests with five existing mode-specific
skips; cold Pages bootstrap passed.

A separate one-worker Chromium SwiftShader run also solved the unchanged
66,150-free-equation grid through the public wasm/WebGPU host. It reached true
f64 residual 5.422607126350388e-10 in eight corrections, with tip displacement
-0.00019029079207446805 m inside B1's 2% bound and all force/moment residuals
below .001 in SI units. This is software-adapter correctness evidence only;
it is neither a timing claim nor the native CI sibling's direct/one-four-worker
comparison. No general convergence,
speed, browser-capacity or larger-mesh claim follows from these cases.

Engine/geometry coverage reached **100% of 74,991 regions, 3,977 functions and 35,411 lines**, with zero misses and no exclusions. The full suite passed; a final library rerun added the caller-level metadata-error propagation witness using preserved profiles. This final change is test-only: all production code is byte-identical to the source accepted by the Metal, M1 and browser runs above. Fresh native lavapipe CI remains required before merge.

## Primary references

- [PETSc KSPFGMRES](https://petsc.org/release/manualpages/KSP/KSPFGMRES/)
  documents right flexible preconditioning with a nonlinear inner Krylov solve.
  The raw-basis representation and translation-coordinate evaluation above are
  this implementation's choices, not claims about PETSc's implementation.
- [Carson and Higham, 2018](https://epubs.siam.org/doi/10.1137/17M1140819)
  motivates mixed-precision Krylov refinement; its GMRES/LU analysis is not a
  convergence proof for this operator and aggregation hierarchy.
