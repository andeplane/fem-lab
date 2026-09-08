---
status: proposed
date: 2026-09-08
---

# MITC4 uses surface directors and a drilling penalty

Issue #64 adds a four-node shell with six global unknowns per node. Its continuum
mapping retains one unit director per corner, with director motion `theta × d`.
The covariant transverse shear strains are tied at opposite edge midpoints,
following the original MITC4 formulation reviewed in Ko, Lee and Bathe (2017),
[section 2](https://doi.org/10.1016/j.compstruc.2016.11.004).

The rotation parallel to the director does not move that director. Leaving it
unstiffened makes a flat shell's six-DOF system singular; deleting a fixed global
rotation would fail on surfaces whose normal changes and at shell/beam joints.
We retain all three global rotations and penalise the difference between the
interpolated drilling rotation and the in-plane displacement spin. The coefficient
is `1e-3 G t` per unit midsurface area, where `G` is the local condensed membrane
shear modulus. Full 2×2 integration avoids extra zero-energy modes. The penalty
vanishes on rigid motions and constant membrane and bending patches.

Mass integrates the same translational and director-motion interpolation through
the thickness. A drilling inertia of `1e-3 rho t³/12` per unit area regularises the
otherwise massless drilling rotation. This is numerical inertia, not physical
rotation of a material fibre. HRZ lumping preserves each global component's
consistent rigid-velocity inertia. Modal benchmarks and penalty sensitivity must
be checked before this decision is accepted; drilling modes must not be mistaken
for physical plate or shell modes.

The 3D material tangent is rotated into the local shell frame and condensed to
zero normal stress, retaining both transverse shear components with the classical
5/6 shear correction. Two thickness Gauss points integrate homogeneous elastic
sections. Top and bottom stresses use those physical offsets and are transformed
back to global axes. Finite-strain and stress-stiffening kernels remain separate
capabilities and return structured unsupported errors until implemented.

The assembled G1–G7 benchmarks now pass at the mesh refinements recorded in
`docs/BENCHMARKS.md`. An unconstrained plate additionally retains all six rigid
modes while its first three elastic bending frequencies converge within 1% of
the FV12 references, without low-frequency drilling modes. This decision remains
proposed until drilling-penalty sensitivity is checked.
