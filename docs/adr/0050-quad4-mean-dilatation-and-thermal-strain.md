---
status: accepted
date: 2026-11-05
---

# Quad4 mean dilatation and consistent thermal strain

Issues #343 and #8 extend the existing [Hex8 decision](./0034-explicit-mean-dilatation-hex8.md) rather than introducing a second Formulation name. Small-strain `mean-dilatation` also applies to Quad4 in plane strain and axisymmetry, including twist. Plane-stress Quad4 retains full integration because its normal stress is condensed before integration and does not have the same incompressible volumetric constraint. Other element kinds retain their previous full integration.

Use the same three-dimensional trace projection for Hex8 and supported Quad4:

`P(epsilon) = epsilon + I * (mean(trace(epsilon)) - trace(epsilon))/3`.

The average uses the full integration rule and physical volume, including `2πr` in axisymmetry. Deviatoric and shear strains are unchanged. Plane strain adds no displacement unknown: its third projected normal strain is an assumed constitutive strain. Axisymmetric twist retains its ordinary circumferential shear kinematics.

Apply P to displacement strain **and thermal eigenstrain**, so the constitutive input is `P(epsilon(u) - epsilon_th)`. Projecting only displacement leaves a fictitious varying bulk pressure under a spatially varying isotropic temperature field. Because P is linear, the stiffness, thermal load and stress recovery continue through their existing material-law and Element extension points. No separate isotropic kernel or GPU shader is needed.

A structural `step.add.formulation` optionally overrides `mesh.set.formulation`; omission inherits the mesh default. This permits controlled comparisons on identical connectivity without changing the authoritative mesh setting. Save/open, definition regeneration and Journal replay retain the explicit override. Heat Steps retain this structural setting as metadata without changing the heat operator, consistent with retaining other inactive procedure settings. Existing saved Steps without the field retain their behavior, except that the previously full-integration Quad4 under explicit mean-dilatation now uses the documented B-bar extension. Existing full Journals are unchanged.

This is small-strain B-bar only. Hex8 and applicable Quad4 reject finite-deformation tangent evaluation explicitly. A finite-strain F-bar or mixed formulation requires its own kinematics, tangent and benchmarks; this work does not claim incompressible hyperelasticity or plasticity support.

Independent verification covers polynomial energy and stress, weighted axisymmetric strain, constant-strain distorted patches, the exact physical nullspace at nu=0.4999, and refinement of Lamé displacement and both bore stresses. A temperature-gradient polynomial distinguishes consistent projection from a spurious bulk-pressure field. Structural Step tests check operator selection as well as metadata and replay.

Primary method references: [MOOSE volumetric locking correction](https://mooseframework.inl.gov/falcon/modules/solid_mechanics/VolumetricLocking.html) and [OpenGeoSys B-bar examples](https://www.opengeosys.org/6.5.7/docs/benchmarks/small-deformations/evaluating_bbbar_with_simple_examples/).
