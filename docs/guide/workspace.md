# The workspace

A project holds a Model and its Journal. The workspace presents that same Model through a tree, forms, a viewer and analysis panels. UI operations use the same registry as scripts and tools, so the [API reference](./api-reference.md) can clarify a form's fields.

## Follow the tree

The Model tree groups Geometry, Materials, Mesh, Constraints, Connections, Loads, Steps and Results. A warning badge identifies missing or incompatible input. Clicking an editable object opens its definition in **Properties**. Applying a change reissues a Command with the object's name; it is recorded in the Journal. A Result row selects a field rather than editing the Model.

Build in this order: choose an idealisation and geometry, assign properties, mesh, define targets and conditions, define a Step, then solve. The tree order is a useful checklist, but some meshers create their own Body and therefore need a different geometry workflow. See [geometry](./geometry.md) and [meshing](./meshing.md).

## Find an operation

Use **Search commands** or **Ctrl+K / Command+K**. Search for a Command such as `material.add`, or an existing object by name. A command with required arguments opens its form. A natural-language intent preview depends on Assistant availability; searching registered Commands does not require AI.

The bottom panels expose Results, Checks, Script, Journal and other analysis views. Examples and Tutorials open guided overlays. Escape closes the active supported overlay. You can resize docked panels; view changes do not change the engine Journal.

## Inspect the viewer

Use the camera controls to orbit, pan, zoom and fit. With focus outside an editable field, **Shift+1** selects isometric, **Shift+2** front, **Shift+3** top and **Shift+4** fits the Model. The matching Commands are `view.preset` and `view.fit`. Viewer options control mesh edges, visibility, clipping, deformation scale and the legend.

Selection can identify a Body, face or Set. Confirm the target name before applying a Constraint or Load. A selected screen face is a starting point; a durable named Set is preferable for a definition that must survive remeshing.

## Keep document and view state distinct

**Undo** and **Redo** operate on engine history; Ctrl/Command+Z and Shift+Ctrl/Command+Z use the same Commands when a text editor is not handling the shortcut. Camera position, panel sizes and displayed fields are host state. They are callable but do not become engineering definitions in a saved Journal.

The top bar reports the engine path and actual CPU worker count. Read its notes before interpreting a slow solve as a model failure. See [troubleshooting](./browser-troubleshooting.md) for capability, solve and storage errors.
