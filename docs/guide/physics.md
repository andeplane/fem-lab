# Physics and capability limits

FEM Lab supports the procedures below, but a procedure name is not a promise that every Material, element, constraint and idealisation can be combined. The schema describes inputs; solve-time checks enforce restrictions on the resolved Model. Use the [generated reference](./api-reference.md) and a relevant [example](./examples-tutorials.md) together.

## Procedures

| Procedure | What it computes | Important limits |
|---|---|---|
| `static` | Linear static equilibrium, optionally sampled through a load amplitude. | Small-displacement elastic response; loading increments do not turn it into dynamics. |
| `static-nonlinear` | Geometrically nonlinear continuum and elastic corotational-beam equilibrium by Newton iteration, increments and cutbacks. | 3D solids or plane strain; beam2 allows large rotations with small elastic section strains. No finite-deformation truss/shell kernels, follower loads or arc-length continuation. Pressure retains reference direction and area. |
| `modal` | Natural frequencies and mode shapes, with optional static prestress. | Needs stiffness and mass. Prestress excludes axisymmetry, beams and shells. Free-free modes are supported. |
| `buckling` | Linear eigenvalue critical-load factors and mode shapes. | Direct solver; excludes axisymmetry and beam/shell stress stiffening. Does not include imperfections, yielding or nonlinear prebuckling history. |
| `heat-steady` | Steady conduction with prescribed temperature, convection, heat flux/source, radiation and supported thermal connections. | Requires conductivity and a suitable temperature reference/ambient exchange. |
| `heat-transient` | Time-dependent conduction using the theta method. | Requires conductivity, density, specific heat, `dt` and `tEnd`; assess time-step accuracy independently. |
| `explicit` | Linear structural dynamics with central differences and lumped mass. | Needs positive mass on free degrees of freedom; rejects multipoint couplings and contacts. A stable time step is not proof of adequate accuracy. |
| `implicit` | Linear structural dynamics using HHT-alpha/Newmark and optional Rayleigh damping. | Requires `dt` and `tEnd`; rejects multipoint couplings. An amplitude with nonzero prescribed displacement is unsupported. |
| `harmonic` | Modal-superposition response over a frequency sweep. | Requires a solved modal predecessor; no frictionless contact or prescribed-displacement base excitation. |
| `randomVibration` | Response covariance and componentwise one-sigma fields from a one-sided PSD. | One spatial Load pattern times one stationary random process; a modal predecessor with identical homogeneous constraints. Not arbitrary multi-input random loading. |

Mode and buckling shape amplitudes are arbitrary. A buckling factor is not a safety factor or a post-buckling load capacity. Random-vibration stress-component standard deviations are not an RMS von Mises field.

## Elements and material laws

Continuum elements include hex8/hex20, tet4/tet10, quad4/quad8 and tri3/tri6. Line models use truss2 or Timoshenko beam2; shell surfaces use MITC4 shell4. Idealisations and meshers determine which families are produced. Unsupported imported formulations are rejected rather than replaced.

Materials provide isotropic/orthotropic elasticity, directional thermal properties, expansion and a supported rate-independent J2 plasticity law with isotropic hardening. J2 is a small-strain material model integrated only by `static-nonlinear`; other procedures use the elastic part with a warning. Do not infer finite-strain plasticity, viscoelasticity, fracture, composite damage or delamination from the presence of a yield property or laminate Section.

## Connections and nonlinear interpretation

Bonded contact provides a tied connection. Frictionless contact uses an active-set, small-sliding formulation with pairing established on the undeformed geometry, only for supported static/nonlinear static analyses. It is not general finite-sliding frictional contact. Thermal connection/resistance has a separate Command.

In finite-deformation continuum analysis, the elastic law uses a St Venant–Kirchhoff interpretation; output stress is Cauchy stress and probe coordinates remain in the reference geometry. Incompatible modes are disabled there, so use suitable quadratic elements for bending. Mean-dilatation Hex8 and plane-strain/axisymmetric Quad4 use a small-strain B-bar mechanical strain, with thermal dilatation averaged consistently. They cannot run finite deformation; they do not establish a finite-strain mixed formulation for hyperelasticity or plasticity.

Heat Results include endpoint `temperatureGradient` and conductive `heatFlux` vectors on
Hex8/Hex20, Tet4/Tet10, Quad4/Quad8 and Tri3/Tri6 thermal meshes. They use unaveraged
element-node recovery; retained transient frames still contain temperature only. Current
2D material axes must remain in plane. See [thermal field interpretation](./results-verification.md#temperature-gradient-and-conductive-heat-flux)
for components, units, anisotropy, interpolation and power-accounting distinctions.

Elastic beam2 members use an objective corotational frame in `static-nonlinear`: chord extension and relative section rotations feed the same elastic Timoshenko stiffness used by `static`. The force and tangent are the exact first and second derivatives of that energy. Rotations are total global rotation vectors, in radians, and `load.moment` supplies generalized dead-load components conjugate to those coordinates. A planar end moment is the ordinary bending moment; arbitrary physical global dead torques and follower torques are unsupported because their rotation-Jacobian pullback is not implemented. General finite three-axis coefficients must be understood as generalized work coefficients, not physical spatial torque components. Use load increments and spatial refinement. The retained `rotation` field reports those coordinates.

Beam output strain is engineering axial section strain and output stress is the extreme-fibre elastic stress, rather than the continuum Green–Lagrange/Cauchy pair. Stateful/plastic beam materials are explicitly unsupported. Collapsed chords, opposed averaged section directors and relative rotations at the principal-logarithm cut are rejected so the nonlinear procedure can cut back; refine the member and reduce increments. This kernel does not add beam eigenvalue buckling, finite-strain plasticity, warping, or finite-deformation truss/shell support.

Total beam rotation vectors must remain strictly inside the principal exponential chart, with magnitude less than pi radians at every node. Reaching that limit or a nonfinite rotation is an explicit unsupported error; reducing load increments does not extend the supported final-rotation range. This prevents the rank loss of exponential coordinates near full turns.

The corotational beam kernel rejects gravity loads. Its finite-rotation distributed-load interpolation and within-element self-weight stress recovery are not implemented. Use linear `static` beams or a solid model for self-weight; manually replacing gravity with nodal loads does not establish an equivalent distributed-load model. Nodal dead forces/moments and axial thermal expansion remain supported within the stated limits.

## Establish suitability

Examples, analytical Benchmarks and convergence tests establish specific known-answer cases. They do not certify every model assembled from those capabilities. Check geometry approximation, boundary assumptions, property provenance, mesh/time convergence, equilibrium and relevant failure mechanisms. See [Results and verification](./results-verification.md). Remote FEM solving, Python bindings and arbitrary user plugin loading are not current product capabilities; see [architecture](./architecture-extensions.md).

## Modal reference models

A small measured eigenpair residual establishes algebraic accuracy for the specified
mesh; it does not establish accuracy against the continuous structure. Refine the
mesh and compare complete repeated-mode subspaces before drawing that conclusion.
Frequency ordering can change when bending and in-plane mode branches cross.

The CLI case `fv52-published-hex20-deck` reproduces the independent published Abaqus
C3D20 model at its exact 4×4×1 full Hex20 mesh, with consistent mass and UZ-only
supports on the lower perimeter. It checks that **discrete model** at 3%; it does
not certify a NAFEMS continuum frequency. Its eccentric edge constraints introduce
a singularity, and the two published NAFEMS-attributed tables disagree. The separate
24-mode study checks symmetry and nested-mesh behavior without fitting a new target.
See the [benchmark reference decision](https://github.com/andeplane/fem-lab/blob/main/docs/adr/0051-fv52-fixed-deck-is-not-a-continuum-reference.md)
for sources and supported limits.
