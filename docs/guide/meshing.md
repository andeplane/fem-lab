# Meshing

A mesh decides where the approximation can represent geometry and fields. More elements do not repair incorrect supports, material data or an unsuitable element formulation. Start with a simple domain and a quantity you can compare, then refine deliberately.

## Select a mesher

| Mesher | Appropriate starting point and limits |
|---|---|
| `lattice` | Structured hexes or 2D quads. Exact for axis-aligned boxes; curved boundaries are stair-stepped. Per-Body size overrides are available. |
| `mapped` | Tagged 2D blocks, including curved edges and graded divisions. Blocks create the sheet Body. |
| `free` | Unstructured triangles in an existing 2D sketch, with local refinement boxes. Use when a block layout is impractical. |
| `sweep` | Extrude or revolve a mapped quadrilateral base into a 3D hex mesh. A free triangular base would need wedge elements and is unsupported. |
| `tet` | Unstructured tetrahedra in 3D solids with curved-surface projection. Small sharp details can still be chamfered at the chosen size. |
| `surface` | MITC4 shell midsurface patches. Requires a shell Section, matching shared-edge divisions and compatible settings. |
| `imported` | Authored nodes/connectivity/Sets. Preserve the imported element kinds; this is not an automatic remesher. |

Line Bodies carry their own member divisions for truss/beam models. Consult the [complete schema](./api-reference.md) for each mesher's geometry, order and refinement fields.

## Size, order and formulation

```ts
await fem.mesh.set({ mesher: { kind: 'lattice', size: '20 mm' }, order: 2 });
console.log(await fem.query.mesh());
```

Generated order 1 is linear; order 2 is quadratic and often improves bending and curved-boundary accuracy. Default incompatible modes improve generated hex8/quad4 bending. Full-integration linear hexes/quads can lock in bending. For near-incompressible small-strain analysis, choose `formulation: 'mean-dilatation'` on `mesh.set`. This B-bar choice uses full quadrature for deviatoric strain and a physical-volume average for mechanical dilatation, including thermal expansion. It applies to Hex8 (including Abaqus C3D8 import) and Quad4 in plane strain or axisymmetry, with or without twist. Axisymmetric averaging includes the ring-volume weight `2πr`. Plane-stress Quad4 and other element kinds retain full integration. This is not uniformly reduced integration, a pressure degree of freedom, or a finite-deformation formulation.

A structural `step.add` can set its own `formulation` to compare full integration, incompatible modes and mean dilatation on the same mesh. Omitting the Step setting inherits the mesh default; an explicit Step setting survives later changes to that default. Heat Steps do not accept a formulation override. B-bar Hex8/Quad4 reject `static-nonlinear` until a finite-strain formulation and consistent tangent are implemented. Thus this choice does not enable incompressible hyperelasticity or finite-strain plasticity.

The near-incompressible Lamé cylinder is checked against analytical displacement and radial/hoop stress at successive mesh refinements. Refine the stress field as well as the displacement: a good displacement alone does not demonstrate a resolved boundary stress.

`simplices: true` splits generated hexes/quads into tetrahedra/triangles. It does not turn a stair-stepped lattice boundary into a freely fitted curved mesh. Choose `tet` for that geometry task. Imported sources use their authored interpolation: their `order: 1` setting means preserve the source, including any quadratic connectivity. The Model tree therefore reports the actual source element kinds (for example `imported · hex20 · full`, or mixed kinds), rather than presenting that preserve-source setting as a linear element order.

## Check before increasing size

Inspect element coverage, target Sets, curved boundaries and interfaces. Query solve cost before a large run:

```ts
console.log(await fem.query.cost({ step: 'static' }));
```

Cost counts equations, matrix bounds, retained frames and scoped memory. It omits some solver/allocator/host overhead and cannot guarantee the current device has enough memory.

## Demonstrate refinement

Compare the same displacement, temperature, reaction or stress away from a singularity at three or more mesh sizes. `study.converge` can report an observed rate and Richardson limit when its conditions are met; `study.adapt` supports selected linear-simplex error-indicator/refinement workflows. An error indicator is not a certified bound. Studies have procedure/mesher restrictions and do not replace physical validation. See [verification](./results-verification.md).
