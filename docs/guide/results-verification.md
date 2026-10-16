# Results and verification

A Result belongs to the Step, solved Model state and exact Mesh that produced it. Read those identities and the field's units before comparing colors or numbers. Deformation magnification and modal animation amplitude are display choices.

## Read the appropriate field

Results can include displacement, stress, strain, reaction, temperature and procedure-specific fields. Mechanical reactions are forces; thermal reactions are removed heat power. Beam section forces/moments use member-local axes and retain separate end values. Shell top/bottom and ply stresses are unaveraged element-node values; they are not a single smoothly averaged solid stress field.

For transient heat, temperature is the retained endpoint field, while heat powers/reactions refer to the last theta-method integration stage. Compare applied minus removed heat power with the stored-energy rate at that stage; an endpoint steady-state balance is the wrong check for a body still heating or cooling.

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
