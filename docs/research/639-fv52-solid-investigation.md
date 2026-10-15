# FV52 solid-plate refinement: bounded findings (#639)

All six native solves completed and met the modal backward-residual tolerance. The three
grids do **not** resolve the conflicting FV52 reference tables. The finest grid also exposed
a genuine exact thread-count reproducibility failure, tracked separately by [#640](https://github.com/andeplane/fem-lab/issues/640).
No solver, target or tolerance was adjusted after seeing these results. Parent [#7](https://github.com/andeplane/fem-lab/issues/7) remains open.

The [frozen plan](../plans/639-fv52-dual-reference-investigation.md) and authored
[`tools/fixtures/fv52`](../../tools/fixtures/fv52) Commands specify the full Hex20 solid,
consistent mass, bottom-edge UZ-only supports and ten requested modes. The independent
primary audit is #627; measured algebraic acceptance is the accepted #633 contract.

## Retained ten-mode spectra

The table reports native one-thread frequencies in Hz. The four-thread values are identical
on the first two grids; the finest values differ as recorded below. This is index ordering,
not a claim that physical modes at different grids or formulations have been matched.

| Grid | f1 | f2 | f3 | f4 | f5 | f6 | f7 | f8 | f9 | f10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4×4×1 | 0 | 0 | 9.06372699e-06 | 44.7962721 | 110.542681 | 110.542681 | 169.095461 | 193.924657 | 206.637809 | 206.637809 |
| 8×8×2 | 0 | 0 | 1.44865036e-05 | 43.7161894 | 105.460035 | 105.460035 | 158.277426 | 193.615345 | 198.374941 | 198.898503 |
| 16×16×4 | 0 | 0 | 2.51950378e-05 | 43.2410285 | 103.734185 | 103.734185 | 154.483269 | 193.029652 | 193.59202 | 193.865077 |

The coarse spectrum rounds to the separate **computed C3D20** row in the
[Abaqus manual](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEBMKRefMap/simabmk-c-fv52.htm):
44.796, 110.54, 110.54, 169.10, 193.92, 206.64, 206.64 Hz. This checks the reconstructed
coarse-deck behavior; the computed row is neither of the independent reference columns.
Further refinement changes the frequencies, so this coarse agreement establishes no
authoritative continuum value or known asymptotic rate.

## Both fixed reference columns

The signed differences below are percentages for mode indices 4–10. Each 3% result is a
**diagnostic only**. No row is used as an engine correctness gate or accepted D3 Benchmark.

| Source and grid | Δf4 % | Δf5 % | Δf6 % | Δf7 % | Δf8 % | Δf9 % | Δf10 % | Within 3% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Abaqus NAFEMS 1990 / 4×4×1 | +1.5973 | +3.6402 | +3.6402 | +8.2349 | +0.1780 | +3.2518 | +3.2518 | YNNNYNN |
| Abaqus NAFEMS 1990 / 8×8×2 | -0.8523 | -1.1250 | -1.1250 | +1.3105 | +0.0183 | -0.8770 | -0.6153 | YYYYYYY |
| Abaqus NAFEMS 1990 / 16×16×4 | -1.9300 | -2.7431 | -2.7431 | -1.1181 | -0.2843 | -3.2669 | -3.1304 | YYYYYNN |
| Ansys targets 1987 / 4×4×1 | -2.3983 | +1.0076 | +1.0076 | +0.7180 | +0.1729 | +0.2172 | +0.2172 | YYYYYYY |
| Ansys targets 1987 / 8×8×2 | -4.7515 | -3.6367 | -3.6367 | -5.7255 | +0.0131 | -3.7902 | -3.5363 | NNNNYNN |
| Ansys targets 1987 / 16×16×4 | -5.7868 | -5.2136 | -5.2136 | -7.9854 | -0.2895 | -6.1099 | -5.9775 | NNNNYNN |

The [Abaqus NAFEMS row](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEBMKRefMap/simabmk-c-fv52.htm)
is 44.092, 106.66, 106.66, 156.23, 193.58, 200.13, 200.13 Hz and cites TNSB Rev.3
(October 1990). The [Ansys input targets](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/ans_vm/vmp09t52187txt.html)
are 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz and cite Selected
Benchmarks for Natural Frequency Analysis (June 1987, Test52). The original publications
have not been independently reconciled. Selecting whichever column happens to pass on one
grid would give conflicting conclusions: coarse passes all Ansys comparisons, medium passes
all Abaqus comparisons, and finest passes neither complete indexed column.

## Rigidity, symmetry and the ten-mode limit

Each public Mesh/Set result matches the planned node/element/support counts and bounds.
Only the bottom perimeter UZ DOFs are fixed. The first three shapes fit the independent
analytic span {Tx, Ty, Rz}; the largest relative unweighted fit residual is 1.01e−13 across
all runs. Their normalized coefficient matrices have diagnostic rank 3 (threshold 1e−8),
with determinant magnitudes 0.9872, 0.9965 and approximately 0.9988. These distinguish a full
retained rigid subspace from three individually plausible copies of one translation.
All three modes retain `modal.unresolved-frequency` warnings; their tiny displayed frequencies
and arithmetic warnings are not certificates that the signed Ritz values were exactly zero.

The repeated f5/f6 values remain paired to roundoff in all three grids. The higher modes
cannot be treated as the same published repeated pair. An independent component diagnostic
Σuz²/Σ(ux²+uy²+uz²) changes for indices 9/10 from about 0.00196 on the coarse grid to
0.895 / 0.898 on the medium grid. At the finest grid, index 8 is z-dominated (0.931), while
index 9 is mostly in-plane (0.000312); the mostly-in-plane mode was index 8 on the coarser
grids. This is evidence of changing indexed mode content, not a complete branch identification.
The Abaqus manual explicitly notes formulation-dependent reordering among modes 8–12. Only
ten modes were retained here; no claim is made about missing higher branches, matching
across formulations, or a convergence rate for any rematched mode.

## Measured algebraic accuracy and resources

| Grid / threads | Max measured η | Sweeps | Wall seconds | Peak RSS MiB | Exact thread check |
| --- | ---: | ---: | ---: | ---: | --- |
| 4×4×1 / 1 | 4.88135569107e-11 | 18 | 0.266 | 22.1 | baseline |
| 4×4×1 / 4 | 4.88135569107e-11 | 18 | 0.263 | 22.4 | PASS |
| 8×8×2 / 1 | 6.70715278546e-11 | 21 | 1.064 | 64.4 | baseline |
| 8×8×2 / 4 | 6.70715278546e-11 | 21 | 0.798 | 67.4 | PASS |
| 16×16×4 / 1 | 5.61578728462e-11 | 20 | 7.902 | 432.8 | baseline |
| 16×16×4 / 4 | 5.6157872523e-11 | 20 | 10.353 | 438.6 | **FAIL #640** |

These are actual local ARM64 native CPU measurements, including replay, solve and public
query serialization; software-GPU timing is not involved. No process reached the 2 GiB / 180 s
guards. The reported η is the maximum requested-pair backward residual on the reduced
pencil; it is not a frequency or mesh-error estimate.

At 16×16×4 the Model/Journal, Mesh, surface and Set payloads agree exactly between 1 and 4 threads;
the 20 sweeps and three warning records agree too. The residual differs
5.615787284622413e−11 versus 5.615787252297869e−11. Nondegenerate f4 differs
43.2410285297337 versus 43.2410285297257 Hz; its full-vector relative L2 difference is
1.6446632398741653e−13. Rigid/repeated eigenvectors rotate and some signs reverse. Physical
eigenvector nonuniqueness does not waive the explicit bit-identical thread-count contract:
nondegenerate values and fields also differ. The unchanged runner exits 1 on this exact
comparison. #640 owns cause isolation/fix; there was no epsilon relaxation or rerun selection.

## Reproduction and retained evidence

```sh
python3 tools/investigate-fv52.py --native /path/to/verified/femlab --out /new/evidence/path
```

The harness performs at most six serial solves and retains raw successful/failed outputs.
It deliberately returns nonzero for the known exact-thread failure. Run in a fresh output
directory; inspect the retained `receipt.json` and all mode fields rather than interpreting
the process failure as a failed eigenpair tolerance. No browser/WASM/GPU or broad suite ran.

Accepted native source: `735831a716c022469e1b8b70821f985961496648`; protected Rust/build/schema
inputs are identical on accepted main `b11e691b`. Release CLI SHA256:
`f42631058100d22f0554f6f35d4d89030505c2a13dac854c443573066fa40e62`.
Actual emitted schema SHA256:
`a3cd0146f5eb21f93a8b57d10ac5d34b7f2b0945e82bb0d2c9a489bf4bd42e25`.
Its producer is accepted strict run [38713757295](https://github.com/andeplane/fem-lab/actions/runs/38713757295).

The [compact machine-readable findings](639-fv52-solid-investigation.json) include all raw
output hashes, six spectra, residuals, resource metrics, warnings, coefficient diagnostics
and ten mode-field hashes per case. The immutable owner archive is
`FEM-Lab-worktree-archives/2026-10-15/current-validation/639/native-study-d2de7bea`:
31 files / 31,228,352 bytes, manifest SHA256
`09a61e7d7579fe5068b2cfc101d198bcffcdec30f86d89b6be014279a2b7886d`.
It independently preserves the actual CLI/provenance, primary bytes, raw 18-query outputs
for each of six processes, the original runner/fixtures and the exact failed comparison.
