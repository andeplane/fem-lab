# faer platform discriminator for #266

This small standalone host isolates dependency behavior from FEM assembly and the engine's
residual guard. It uses the engine's locked faer 0.24.4 configuration and prints OS, architecture,
x86 AVX512/AVX2/FMA capabilities, and results for explicit `Par::Seq`, `Par::rayon(1)`, and
`Par::rayon(4)`. All modes run inside one four-thread Rayon pool, without concurrent tests
changing faer's global parallelism.

From the repository root:

```sh
cargo run --locked --manifest-path tools/diagnose-faer-266/Cargo.toml
```

Set `CARGO_TARGET_DIR` to an available existing cache when needed. The two-job diagnostic
workflow runs this same command on Windows and Linux; neither job changes a dependency or
relaxes an oracle.

The controls have independent closed forms:

- **Integer block products.** `A = u vᵀ`, `B = w zᵀ`, so `AB = u (vᵀw) zᵀ`, where `vᵀw`
  is just the integer overlap of two intervals. Three output quadrants are exactly zero.
  Every arithmetic value is an exactly representable integer, so every output entry must
  match exactly. Dimensions `(m,n,k) = (33,31,33), (129,127,513), (513,509,513)` exercise
  odd row/column tails and a depth crossing 512. Row-major, column-major, and mixed
  column/row/column storage run `C = AB` with NaN-filled destinations and `C = 1 - AB`
  to test update semantics, including the layout used by Schur-complement updates.
- **Sparse SPD grid.** A 3D seven-point Dirichlet Laplacian has diagonal 6 and off-diagonal
  -1 for each interior neighbor. Set `b` to the number of exterior neighbors: the exact
  solution is the constant vector 1. Its energy is a sum of squared edge differences plus
  exterior-boundary squares, so it is positive definite. Widths 5, 9, 13 produce 125,
  729, 2197 equations. Maximum solution error and relative residual must both be ≤1e-10.

Failure identifies an error below FEM assembly and retains all product/grid/mode output for
comparison. Passing this control does not rule out shape- or size-dependent failures in the
LE10 factorization. The original #266 LE10 stress and force-balance checks remain necessary.
