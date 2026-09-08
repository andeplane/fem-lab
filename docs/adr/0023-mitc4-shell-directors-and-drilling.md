---
status: accepted
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
consistent rigid-velocity inertia. The modal and sensitivity checks below distinguish
the physical plate modes from the numerical drilling modes.

The 3D material tangent is rotated into the local shell frame and condensed to
zero normal stress, retaining both transverse shear components with the classical
5/6 shear correction. Two thickness Gauss points integrate homogeneous elastic
sections. Top and bottom stresses use those physical offsets and are transformed
back to global axes. Finite-strain and stress-stiffening kernels remain separate
capabilities and return structured unsupported errors until implemented.

The assembled G1–G7 benchmarks now pass at the mesh refinements recorded in
`docs/BENCHMARKS.md`. An unconstrained plate additionally retains all six rigid
modes while its first three elastic bending frequencies converge within 1% of
the FV12 references, without low-frequency drilling modes.

On 2026-09-08, the complete 22-test shell suite was also run with `DRILL=1e-4`
and `DRILL=1e-2`, changing both the penalty and its matching numerical inertia.
Both runs passed every G1–G7 refinement gate and the unconstrained modal test.
Across this hundredfold coefficient range, the largest finest-mesh change in a
reported static benchmark output was 0.00652% (hemisphere displacement). The
coarsest hemisphere changed by 1.44%, so the refinement requirement remains
essential. FV12's bending frequencies were unchanged, and the unconstrained
plate's first three elastic frequencies changed by less than 1e-9 relative.
The production coefficient remains `1e-3`.

To repeat this sensitivity check, substitute each coefficient in `fem/shell.rs`,
run `cargo test -p femlab-engine --test fem shell:: -- --nocapture`, compare the
printed benchmark values, and restore `1e-3`. This is a formulation experiment;
the coefficient is deliberately not a model setting or a runtime environment input.
