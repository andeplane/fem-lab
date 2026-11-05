# Results and verification

A Result belongs to the Step, solved Model state and exact Mesh that produced it. Read those identities and the field's units before comparing colors or numbers. Deformation magnification and modal animation amplitude are display choices.

## Read the appropriate field

Results can include displacement, stress, strain, reaction, temperature and procedure-specific fields. Mechanical reactions are forces; thermal reactions are removed heat power. Beam section forces/moments use member-local axes and retain separate end values. Shell top/bottom and ply stresses are unaveraged element-node values; they are not a single smoothly averaged solid stress field.

For transient heat, temperature is the retained endpoint field, while heat powers/reactions refer to the last theta-method integration stage. Compare applied minus removed heat power with the stored-energy rate at that stage; an endpoint steady-state balance is the wrong check for a body still heating or cooling.

### Temperature gradient and conductive heat flux

Every solved heat-steady or heat-transient Result also carries `temperatureGradient`
(`∇T`, K/m) and `heatFlux` (`q = −K∇T`, W/m²). Choose their magnitude or signed x/y/z
components in the field picker. These are endpoint fields: transient heat reactions and
storage powers still use the last theta integration stage. A static Step chained after heat
consumes temperature; read these vectors from its heat predecessor, not the structural Result.

The engine differentiates temperature at thermal Gauss points and fits each element's
corner shape functions by least squares to extrapolate to its nodes.
Single-point Tri3/Tet4 recovery is constant within each element. Raw `query.field`
reports `per: 'elementNode'`, three components, SI units and the solved Mesh's element-node
order. Values are never averaged between elements, even where they share nodes or a material
interface. Linear-element gradients are generally discontinuous; the displayed contour and
`query.probe`/`query.path` interpolate the recovered values inside the containing element.
A point exactly on an interface selects the lowest element id, so inspect points on both
sides to assess a jump. This recovery is not an independent higher-accuracy solution.

In 3D components use global x/y/z. In planar models the gradient is x/y/0; in axisymmetric
sections it is radial/axial/0. Heat flux uses the full rotated material conductivity tensor,
including tilted coupling in 3D. Current 2D Models reject out-of-plane material axes, so the
omitted flux is zero under that supported contract. The reduced thermal operator balances
only the represented directions; it is not a full 3D model. A positive component points along
the corresponding positive axis; the boundary `load.heatFlux` input is instead positive
**into** the surface. Flux density (W/m²), prescribed temperature (K) and total support heat
power (W) are different quantities.

```ts
// After solving the heat Step named 'conduct':
await fem.model.setUnits({ units: { temperatureGradient: 'K/mm', heatFlux: 'kW/m^2' } });
console.log(await fem.query.probe({ step: 'conduct', field: 'heatFlux', component: 0,
  at: ['0.5 m', '50 mm', '50 mm'] }));
console.log(await fem.query.field({ step: 'conduct', field: 'temperatureGradient' })); // raw SI
```

Retained transient frames contain nodal temperature only. `query.frame` or sampled
probe/path requests for either derived vector explicitly reject; omit the frame/sample for
the final endpoint field. In the browser, choosing a gradient/flux contour exits playback
and labels the final endpoint time, including in exported legend text. The playback button
returns to retained temperature frames; an earlier frame's time never labels an endpoint
vector. Difference Queries currently accept nodal fields, so these
element-node vectors cannot be used in that comparison operation. `study.converge` also
rejects element-node quantities; refine meshes explicitly and compare the same probe/path
locations for these vectors. Cost estimates include
both endpoint fields and intermediate Gauss arrays in `recoveryBytes`; element-local scratch
and host/allocator overhead remain additional. Heat `solve.run` rejects a counted estimate
above the planning budget before allocating endpoint output; coarsen the mesh and query the cost
again. See [physics](./physics.md) and
[units](./units.md) for model and display conventions.

```ts
console.log(await fem.query.result({ step: 'static' }));
console.log(await fem.query.probe({ step: 'static', field: 'displacement', component: 2, at: ['1 m', '50 mm', '50 mm'] }));
```

For a line plot, `query.path` samples between unit-bearing endpoints. Probe coordinates are model/reference coordinates; a visibly magnified deformed shape does not move the query point. Inspect field availability and sampling location in the [reference](./api-reference.md).

## Current and retained Results

An edit that changes analysis inputs can make the current per-Step Result stale. Current-context field, surface, frame, probe and path reads reject stale selections rather than attach old values to new geometry. `query.result` can still return summary metadata with `stale: true`. `query.results` lists retained solve records; an explicit `resultId` selects its original solved context even after edits. IDs are local to that engine session, can be evicted, and are not portable saved-result identifiers.

The comparison view can select two retained Results with separate legends, visibility and physical-time playback. Compare like quantities and understand coverage/interpolation when meshes differ. A screenshot of two contours is not a numerical error measure.

## Frames, modes and amplitudes

`query.frames` lists retained transient output; `query.frame` reads one frame. A sample can use a frame index or an explicit time rule. Playback holds stored frames between retained times; it does not invent intermediate integration output. A mode shape has arbitrary amplitude. A buckling mode likewise shows a shape, not a predicted post-buckling displacement. Random-vibration output has RMS/standard-deviation semantics rather than signed static equilibrium semantics.

## A practical verification checklist

1. Check dimensions, material values, active conditions and target Set membership.
2. Check reactions and force/moment or heat/energy accounting appropriate to the procedure.
3. Compare a quantity with an independent analytical/reference answer.
4. Refine mesh size/order and compare the same quantity away from singularities.
5. For time integration, reduce the time step independently of mesh refinement.
6. Record assumptions, solver settings, Results identity and exports in a calculation note.

`study.converge` needs at least three distinct positive sizes for its finite-limit/rate estimate, has procedure restrictions, and can report an unavailable estimate. Adaptive error indicators are not certified error bounds. Point loads, sharp re-entrant corners and ideal clamps can create singular stresses that do not converge to a finite peak. Use an engineering quantity suited to the question. See [examples](./examples-tutorials.md) and [physics limitations](./physics.md).
