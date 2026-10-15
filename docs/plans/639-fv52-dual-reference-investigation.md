---
status: in progress
issue: 639
parent: 7
---

# FV52 original-solid refinement investigation

This bounded investigation implements [#639](https://github.com/andeplane/fem-lab/issues/639)
under [#7](https://github.com/andeplane/fem-lab/issues/7). Reference wording was corrected by
#627; the modal acceptance prerequisite #633 is accepted. D3 remains unresolved: numerical
agreement with either vendor column will not establish which publication is authoritative.

## Frozen physical problem and comparisons

Use the original Abaqus C3D20 geometry: a 10 × 10 × 1 m isotropic solid, minimum corner
(0,0,−0.5) m, E=200 GPa, ν=0.3, ρ=8000 kg/m³. Full Hex20 integration and consistent mass
are existing engine capabilities. Restrain **only UZ** on the four perimeter edges at
z=−0.5 m. Do not pin UX/UY or replace edge support by a whole side/bottom face. Translation
in X/Y and rotation about Z remain admissible rigid motions.

Run exactly three uniform grids and two thread counts, sequentially:

| Grid | Elements | Nodes | UZ support nodes, union | Free DOFs |
| --- | ---: | ---: | ---: | ---: |
| 4×4×1 | 16 | 155 | 32 | 433 |
| 8×8×2 | 128 | 837 | 64 | 2447 |
| 16×16×4 | 1024 | 5321 | 128 | 15835 |

Request ten modes using the existing default negative shift, tolerance 1e−10 and budget
5000. Do not tune parameters after inspecting reference errors. Use the public native CLI
with threads 1 and 4, querying all ten retained mode fields in the same process as its solve.
Retain the complete public Model/Journal, Mesh/Set summaries, Result, fields, stdout/stderr,
CLI/source/schema hashes, actual elapsed time and peak RSS. Preserve structured failures.

The immutable diagnostic columns for **mode indices 4–10** are:

| Source | Reference frequencies (Hz) |
| --- | --- |
| Abaqus 2025 NAFEMS row | 44.092, 106.66, 106.66, 156.23, 193.58, 200.13, 200.13 |
| Ansys 2026 R1 targets | 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 |

Print signed relative differences and the original 3% comparison for **both** columns.
The 3% columns are diagnostics, not correctness gates or an accepted FV52 Benchmark.
Abaqus notes that element formulations can reorder higher physical modes: retain the shapes
and describe index comparison honestly; do not rematch modes to improve an error column.
Record refinement changes without claiming a known asymptotic rate or extrapolated truth.
The separate Abaqus computed C3D20 row (44.796, 110.54, 110.54, 169.10, 193.92,
206.64, 206.64 Hz) is formulation context only, never a third reference or fitted target.

## Verification and resource boundary

1. Independently check the public Mesh/Set counts and bounds against the table/geometry;
   each edge contains 2n+1 nodes with corner overlap in the union. All fixed DOFs are UZ.
2. Require finite sorted frequencies, ten owned mode fields with the public nodal layout,
   current Result identity, and actual maximum measured backward residual ≤1e−10. Preserve
   every arithmetic-unresolved warning; a displayed zero frequency does not certify λ=0.
   Pair residuals do not certify completeness of the lowest ten or every degenerate subspace.
3. Report the low-three/first-deformational separation, individual rigid fits and normalized
   Tx/Ty/Rz coefficient matrix/determinant/rank diagnostics (rank threshold1e−8), without
   declaring the warning itself a physical rigid-mode classifier. Preserve repeated-mode
   shapes; do not compare arbitrary eigenvector signs/bases across different meshes.
4. Compare Model/Journal, Mesh/Set metadata, frequencies, residual, iterations, warnings and
   all ten shapes exactly between native threads 1/4, excluding host elapsed-time metadata.
5. Keep the unresolved D3 status, both reference columns and parent #7 open. This study can
   close only its own reproducible investigation, including honest partial/resource results.

At most six serial native solves; no broad suite, LLVM, GPU, browser, WASM build or solver
change. The finest grid's uncoalesced element-entry upper bound is 3.69 million entries
(~44 MB per CSR for f64 values/u32 columns), before direct-factor fill. Actual direct-factor
memory/time is unmeasured. Record it; cap each owned CLI process at 2 GiB RSS / 180 s,
then stop and report partial evidence on nonconvergence or
resource pressure rather than changing physics or selecting a favorable target.

Runtime: accepted #633 release ARM64 CLI SHA256
`f42631058100d22f0554f6f35d4d89030505c2a13dac854c443573066fa40e62`, schema
`a3cd0146f5eb21f93a8b57d10ac5d34b7f2b0945e82bb0d2c9a489bf4bd42e25`, from
strict run [38713757295](https://github.com/andeplane/fem-lab/actions/runs/38713757295).
Before use, verify protected engine/build source equivalence with this worktree's accepted
main b11e691b. No credit is claimed from historical pre-#633 modal spectra.

## Primary sources

- [Abaqus 2025 FV52](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEBMKRefMap/simabmk-c-fv52.htm)
  identifies its reference as TNSB Rev.3, October 1990, and prints the separate C3D20 result row.
- [Original C3D20 input](https://docs.software.vt.edu/abaqusv2025/English/SIMAINPRefResources/nfv52fkc.inp)
  defines the 4×4×1 solid and bottom-edge UZ sets.
- [Ansys 2026 R1 SOLID187 input](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/ans_vm/vmp09t52187txt.html)
  cites Selected Benchmarks for Natural Frequency Analysis, June 1987, Test52, and fixes its
  separate targets. Its z=0…1 origin is a translation of the same supported solid geometry.

Primary bytes and the previous independently verified source table are retained by #627;
copy them independently into this investigation's evidence before checkout cleanup.
