---
status: accepted
date: 2026-11-05
---

# FV52 validates its specified discrete deck, not an invented continuum target

Issue [#7](https://github.com/andeplane/fem-lab/issues/7) asked to settle D3's two
published FV52 frequency tables before hard-coding a numerical oracle. The original
assumption that one table must be an authoritative continuum limit is unsound.

The [Abaqus 2025 FV52 manual](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEBMKRefMap/simabmk-c-fv52.htm)
labels its NAFEMS row 44.092, 106.66, 106.66, 156.23, 193.58, 200.13, 200.13 Hz.
It separately publishes the computed C3D20 row 44.796, 110.54, 110.54, 169.10,
193.92, 206.64, 206.64 Hz and the [complete input deck](https://docs.software.vt.edu/abaqusv2025/English/SIMAINPRefResources/nfv52fkc.inp).
The [Ansys 2026 R1 input](https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/ans_vm/vmp09t52187txt.html)
uses 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz as its targets.
The publishers' two NAFEMS attributions still disagree; FEM Lab cannot correct their
source publications by choosing whichever comparison passes.

[Altair's 2022.3 SimSolid VM06 discussion](https://2022.help.altair.com/2022.3/ss/en_us/topics/simsolid/verification%20manual/modal_analysis_test_problem_vm06_r.htm)
explicitly identifies the few-element reference approximation, its artificial
anisotropy, the eccentric lower-edge supports and their 3D stress singularity.
Its dense independent solid result differs from the historical reference. Thus
refining this solid cannot be required to approach either historical indexed table.
VM06 lists a different density (8300 kg/m³); its numerical frequencies are not
adopted or rescaled into this 8000 kg/m³ Benchmark. Its reference/support analysis
is the relevant evidence.

D3 therefore has two separate obligations. Its installed CLI Benchmark reproduces
**the exact published Abaqus C3D20 discrete model** against that publisher's computed
row, at the existing 3% frequency tolerance. This is an independent code-to-code
numerical reference, not a selected NAFEMS continuum answer. The model fixes the
10×10×1 m geometry, E=200 GPa, nu=0.3, rho=8000 kg/m³, full 4×4×1 Hex20 mesh,
consistent mass and UZ-only constraints on the four lower edges. The first three
modes must span Tx, Ty and Rz; seven nonzero frequencies are compared individually.

Under ADR0047, the expensive study runs explicitly on Linux main and relevant PRs;
the cheap fixed-deck/rigid-span test remains in every ordinary registry run.
A separate enlarged-spectrum study retains 24 modes on 4×4×1, 8×8×2 and 16×16×4
nested meshes. It checks quarter-turn invariance of complete modal subspaces through
the first twenty modes, exact 1/4-worker payloads, measured backward residuals,
rigid-span rank and the min-max nonincrease of the first seventeen elastic indexed
eigenvalues. Both original NAFEMS columns remain visible diagnostics. No fitted
reference, inferred power-law convergence rate or universal spectral-completeness
certificate is introduced.

This convention resolves the verification contract, not the publishers' historical
attribution. A future authoritative correction may add a separately named benchmark;
it must not silently replace the fixed-deck oracle or relabel it as continuum accuracy.
The existing D4 full-gradient/manufactured convergence and finite-width VM142 gates
remain unchanged. No solver, mesh algorithm, eigenpair tolerance or coverage exclusion
is changed by this decision.
