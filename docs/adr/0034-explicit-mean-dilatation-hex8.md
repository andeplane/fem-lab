---
status: accepted
date: 2026-10-15
---

# Explicit mean-dilatation Hex8 preserves imported C3D8 physics

Issue #673, part of [#650](https://github.com/andeplane/fem-lab/issues/650), closes a
formulation mismatch exposed by an unchanged author-published Abaqus/CAE C3D8 deck.
Its 275 nodes, 160 elements, loads, constraints and material imported correctly, but our
pointwise full-integration Hex8 displaced differently. An independent bounded diagnostic
reproduced the old maximum error of 1.5003315e-5 m. Replacing only its volumetric strain
by the element-volume average reduced that error to 4.980294e-10 m against the authored
printed displacements. This diagnostic identifies the cause; it is not a kernel oracle.

Abaqus documents its C3D8 as an eight-point element with modified volumetric strain,
[the mean-dilatation B-bar method](https://docs.software.vt.edu/abaqusv2025/English/SIMACAETHERefMap/simathe-c-solidisoquadhex.htm).
The centroid approximation agrees on parallelepipeds but is a different operator on
warped elements. Neither approach is the uniformly reduced, hourglass-controlled C3D8R.

Add `mean-dilatation` to the existing Formulation extension-point input. For Hex8,
replace the three normal B rows at every Gauss point by

`Bbar_i = B_i + (mean(trace B) - trace B)/3`,

where the mean uses physical-volume weights from full eight-point quadrature. Shear
and deviatoric strain remain unchanged. Pass this same Bbar through the existing material
law, stiffness, thermal-load and recovery paths. No special isotropic constitutive branch
is introduced. The assembled operator and its preconditioner therefore represent the
same formulation on the CPU and GPU; no new shader is needed.

Other element kinds retain their ordinary full integration under this choice, consistent
with the existing kind-specific incompatible-mode strategy. Current supported source
families are C3D4, C3D8, C3D10 and C3D20; a mixed import chooses mean-dilatation if it
contains C3D8, affecting only those Hex8 cells. No C3D8I, C3D8R or hybrid alias is added.
The explicit mesh/static conversion versions advance to `abaqus-mesh/2` and
`abaqus-static/3`. The source geometry, original labels and material regions are unchanged.

Existing `full` and omitted imported-source formulations retain their old meaning on
open, replay and direct mesh.set. This avoids silently changing saved analyses.
The new Hex8 strategy supports small strain. Finite-deformation evaluation returns a
structured unsupported error rather than silently using the old full operator. Future
finite-strain B-bar requires its own consistent tangent and numerical Benchmarks.

Verification uses polynomial energy and strain integrals, distorted constant-strain
patches, exactly six rigid modes, known first-order strain consistency under refinement,
an unchanged independently published Abaqus result, and software-adapter GPU execution.
An external application result retains its source and printing precision; a discrepancy
is recorded, not corrected by reference fitting or relaxed tolerances.
