# Geometry and idealisation

Choose the physical simplification before building detail. A **Body** is a named geometric or mesher-defined region to which properties and targets can refer. A **Mesh** is its numerical discretization. Importing a faceted shape is different from importing an authored finite-element mesh.

## Choose the dimensional model

`model.setIdealisation` supports `solid3d`, `planeStress`, `planeStrain` and `axisymmetric`.

| Choice | Use and required interpretation |
|---|---|
| 3D solid | Displacements and geometry in all three dimensions. |
| Plane stress | An xy sheet with free out-of-plane surfaces; supply its physical thickness. |
| Plane strain | An xy section whose out-of-plane strain is zero. |
| Axisymmetric | An xy meridional section: x is radius, y is the revolution axis. Optional twist adds circumferential displacement. |

A 2D idealisation requires compatible sheet geometry; it is not a view setting that flattens a 3D solid. Axisymmetric loading represents a body of revolution, not an arbitrary sector with non-axisymmetric loads. See [physics](./physics.md).

## Create or modify a Body

The Geometry add menu is generated from the shape schema. It includes boxes, cylinders, spheres, sheets, extruded sketches, revolved sketches, unions, subtraction, intersection and transformations. `geometry.addBox` is a convenient box Command; `geometry.add` accepts a general shape definition. Coordinates and sizes require [length units](./units.md).

In Properties, the **Shape kind** buttons form an aligned grid that adapts to the panel width. The selected kind stays highlighted; use Tab to reach a choice and Space or Enter to select it. Choosing a kind shows its fields underneath, with nested shapes indented. These edits update the draft through `form.open`; **Add body** records one geometry Command after the required fields are complete.

```ts
await fem.geometry.addBox({ name: 'block', size: ['80 mm', '40 mm', '20 mm'] });
```

### Preview and place a draft

In **geometry** view, opening `geometry.addBox` or `geometry.add` in Properties draws a cyan, translucent Body with a dashed outline when its arguments are valid. **Draft · not added** identifies this temporary drawing. It uses the same engine geometry as the committed Body, including inline unions, cuts, intersections and transforms. A 2D sheet still requires the matching Model idealisation.

Edit unit-bearing **at** coordinates to position boxes, cylinders and spheres. For rotated or scaled geometry, use the **transform** shape and its translation, rotation in degrees and scale. These edits use `form.open`; they change neither the active Model nor its Journal. The camera remains where you put it while editing. Use **Fit** to frame the draft and existing Bodies together, and orbit to inspect placement.

**Add body** commits exactly one geometry Command. **Cancel** discards the draft; **Revert** restores the form's original values. Changing selection, opening a different form or committing a Model edit clears the old preview. Drafts are view state and are not saved or synced as project geometry. Invalid or incomplete inputs clear the old drawing and show a structured explanation; correct Properties to preview again. Preview calculation runs locally on the CPU in a separate Worker, stops after five seconds, and never runs a Mesh or solve. Complex drafts may exceed that preview limit even when the engine can ultimately add them. Drag handles are not available; use the explicit coordinates and transform fields.

Boxes expose `xmin`, `xmax`, `ymin`, `ymax`, `zmin` and `zmax` face names prefixed by the Body name. Cylinders have side/top/bottom faces. Prefer these names when they express your intended target.

For a cut, use `geometry.subtract` with an explicit source Body and cutting shape. Keep names meaningful: `housing`, `inlet` and `mountingFace` are easier to audit than screen coordinates. The exact shape and predicate fields are in the [API reference](./api-reference.md).

## Geometry created by a mesher

Mapped blocks, swept blocks and shell surface patches can define an implicit Body directly through `mesh.set`. Their Body name is still used for Material/Section assignment and Sets. Do not create a second overlapping explicit Body for the same domain. Line Bodies support truss and beam models; their divisions and Section describe a one-dimensional member. Those line members still require the Model's `solid3d` idealisation, not a plane-stress or plane-strain Model.

## Imported geometry

[STEP conversion](./import-export.md#import-step-geometry) creates one tessellated Body, not editable CAD feature history. Surface imports must be checked for closedness, scale and usable face targets before a solid solve. Named geometric predicates can survive a change in mesh; fragile screen picks and original CAD face IDs are not a substitute.

After a geometry edit, inspect target Sets and remesh. Existing Results may still be available as retained solved contexts, but they do not silently become Results on the new geometry. See [Results](./results-verification.md).
