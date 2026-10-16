# Physics and capability limits

FEM Lab supports the procedures below, but a procedure name is not a promise that every Material, element, constraint and idealisation can be combined. The schema describes inputs; solve-time checks enforce restrictions on the resolved Model. Use the [generated reference](./api-reference.md) and a relevant [example](./examples-tutorials.md) together.

## Procedures

| Procedure | What it computes | Important limits |
|---|---|---|
| `static` | Linear static equilibrium, optionally sampled through a load amplitude. | Small-displacement elastic response; loading increments do not turn it into dynamics. |
| `static-nonlinear` | Geometrically nonlinear continuum equilibrium by Newton iteration, increments and cutbacks. | 3D solids or plane strain. No finite-deformation beam/truss/shell kernels, follower loads or arc-length continuation. Pressure retains reference direction and area. |
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

In finite-deformation continuum analysis, the elastic law uses a St Venant–Kirchhoff interpretation; output stress is Cauchy stress and probe coordinates remain in the reference geometry. Incompatible modes are disabled there, so use suitable quadratic elements for bending. Mean-dilatation Hex8 cannot run finite deformation.

## Establish suitability

Examples, analytical Benchmarks and convergence tests establish specific known-answer cases. They do not certify every model assembled from those capabilities. Check geometry approximation, boundary assumptions, property provenance, mesh/time convergence, equilibrium and relevant failure mechanisms. See [Results and verification](./results-verification.md). Remote FEM solving, Python bindings and arbitrary user plugin loading are not current product capabilities; see [architecture](./architecture-extensions.md).
