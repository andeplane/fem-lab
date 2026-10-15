---
status: proposed
date: 2026-10-15
---

# Imported quadratic solids retain their original geometry and full interpolation

Issue [#655](https://github.com/andeplane/fem-lab/issues/655), under
[#650](https://github.com/andeplane/fem-lab/issues/650), extends ADR 0026's imported
source to Abaqus-order Tet10 and Hex20. Quadratic solids are common exchange meshes;
throwing away their midside nodes would change both the authored geometry and the
finite-element approximation. A sampled positive determinant is not an injectivity
or inter-element contact proof.

## Decision

The source kind selects the existing full-integration Tet10/Hex20 Extension Point.
Every node label, coordinate, connectivity position and quadratic face membership
survives the ordinary mesh.set Journal, save/open and native/WASM replay. The
unchanged-source order setting remains 1, including mixed-order sources: it does
not upgrade, downgrade or regenerate authored elements. Reduced-integration Abaqus
variants remain distinct and must not be relabelled as these full formulations.

The existing conservative certificate now constructs the **complete exact original
map** from all interpolation nodes. Hex20 uses its serendipity polynomial, including
terms of total degree four; Tet10 uses its quadratic barycentric polynomial. Finite
f64 source coordinates remain exact rational input to the certificate.

Let A be the adjugate of the original reference Jacobian at the cell center (the
simplex centroid for Tet10). Exact polynomial Sylvester minors certify that
Sym(A J) is positive definite over the reference domain. Tensor Bernstein bounds
and bounded dyadic subdivision prove positivity. For a tetrahedron, the minors
of the original J are composed with the surjective Duffy cube-to-simplex map;
we never differentiate that boundary-collapsing map. The monotonicity argument
from ADR 0026 then proves injectivity on the original convex reference domain.
An actual nonpositive determinant at a checked point inside that domain is an
invalidity witness. Failure to prove the sufficient condition is Unsupported.

Broad-phase bounds are exact Bernstein convex hull bounds for the original map.
Quadratic shape functions can be negative, so nodal extrema are not safe bounds:
a cell can bulge beyond every authored node and intersect an apparently separate
neighbor. Rational bounds avoid an inward floating-point rounding error.

Contacts retain ADR 0026's original-map separator argument. For quadratic faces,
a bounded, ten-coefficient exact linear system finds an implicit physical quadric
only when its composition with the **whole face polynomial** is identically zero.
This is not a fit through sample points. Separator composition is checked over the
whole original cell. Exact factorization plus strictly positive quotients limits
the zero set to one reference entity. Tetrahedral factors are excluded barycentric
coordinates; hexahedral factors are fixed Cartesian reference coordinates.
Matching entities require complete labelled corner and midside connectivity with
compatible edge incidence and cyclic corner order. That identifies the same
Tri6/Quad8 interpolant under its permitted reference reparameterization.

## Limits and consequences

- Curved cells and matching curved shared faces are supported when this sufficient
  certificate succeeds. Coordinate straightening, corner-only geometry and a
  triangulated substitute are forbidden.
- Some valid quadratic interfaces have implicit degree above two. The bounded
  separator family can be inconclusive there. Such sources return a structured
  Unsupported error with the original element labels, not a false invalidity
  claim or a silently modified model.
- Proof retains the existing 12-level/4096-box bounds. This is correctness work,
  not a software-adapter performance promise or a universal mesh-quality test.
- The existing Tet4/Hex8 path and its independent invalidity checks remain in use.

Verification includes independent determinant-one polynomial shears with genuinely
curved shared Tet10/Hex20 faces; physical affine-strain patches; folded maps;
between-node bulge overlap; save/open and Journal identity; full-integration axial
closed forms across three meshes; and a curved annulus geometry convergence study
with its independent fourth-order area error. A deliberately quartic implicit
interface exercises the honest Unsupported outcome.

## Current external admission evidence

The first implementation admits the untouched CalculiX 2.23 `beam20p.inp` node
and connectivity source (261 nodes, 32 Hex20 cells), but rejects `beam10p.inp`
(90 nodes, 31 Tet10 cells): source elements 37 and 38 meet at one labelled vertex
and need a more complete pair proof. This is an open #655 acceptance blocker;
analytical curved fixtures passing does not establish practical deck coverage.
Original source coordinates/connectivity and the failing output are retained in
the external #655/#656 evidence, with independent raw-deck attestation.
