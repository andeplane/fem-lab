# Thermal Result vectors (#850)

Tracks [#850](https://github.com/andeplane/fem-lab/issues/850), the result-field
prerequisite of [original rotor workflow #848](https://github.com/andeplane/fem-lab/issues/848)
and [tutorial umbrella #86](https://github.com/andeplane/fem-lab/issues/86).

## Contract

- Every successful heat-steady/heat-transient Result retains endpoint `temperatureGradient`
  (K/m) and `heatFlux` (W/m²), with three components per element node.
- Differentiate the solved element temperature at its thermal Gauss points, then use the
  existing corner-shape least-squares extrapolation. Never average across elements/materials.
- Fourier's law uses the full rotated conductivity tensor, including tilted coupling in
  3D. Current 2D Models permit only material axes rotated in plane: omitted gradient and
  flux are zero. Axisymmetric x/y/z means radial/axial/circumferential. The reduced operator
  only balances represented divergence components; it is not a full 3D thermal model.
- Stored transient frames remain primary temperature only. Derived frame/sample requests
  reject explicitly; final derived fields are not theta-stage heat powers/reactions.
- Raw field Queries stay SI. Summary/probe/path/contour units have independent
  `temperatureGradient` and `heatFlux` settings. A compound degC/m uses temperature intervals.
- Probes and paths interpolate within one element; shared-face ties select the lowest
  element id. Retained Result identity and geometry are preserved after edits.
- Cost planning counts both endpoint arrays and GP intermediates; existing history counts
  and thermal-to-static chaining semantics remain unchanged.

## Verification

Independent Fourier bar solves at 2/4/8 cells across eight thermal families; quadratic
manufactured conduction and order-one linear gradient refinement; anisotropic tensor-vector
products including tilted axes; absolute-temperature shift invariance; unaveraged interface
values; endpoint-vs-theta-stage distinction; integrated support/source/film power;
heat-to-static expansion; exact replay and 1/4-worker fields; SI/display conversions and
explicit frame limits; Chromium component selection and unit labels.

Native/schema validation uses the normal Linux PR lane because fresh Mini native launches
have a known OS startup stall. The M4 is not a heavy build/test fallback. Final source-bound
receipts are recorded in the PR and issue before closure; initial source work is not a pass.
