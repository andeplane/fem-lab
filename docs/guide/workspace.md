# The workspace

A project holds a Model and its Journal. The workspace presents that same Model through a tree, forms, a viewer and analysis panels. UI operations use the same registry as scripts and tools, so the [API reference](./api-reference.md) can clarify a form's fields.

## Home and profile

When signed out, the home screen introduces FEM Lab and offers local modeling, examples, tutorials and your browser's Recent projects. **Start modeling — free** does not require an account. The optional sign-in route is for hosted AI and account services.

When signed in, home welcomes you with your actual account email and a workspace overview, including plan/allowance information when available. The header's avatar/email control opens your profile menu, where you can open **Account & AI settings**, refresh account state or sign out. Account settings organize your identity, AI allowance, subscriptions and account records. Values that are loading or unavailable are shown as status information, not invented zero balances.

Both home states lead to the same local modeling workspace. Recent projects belong to this browser/profile; signing in does not upload or synchronize them. Save a portable Model file for a backup or another device. See [accounts](./accounts-billing.md) and [projects/storage](./projects-storage.md).

## Follow the tree

The Model tree groups Geometry, Materials, Mesh, Constraints, Connections, Loads, Steps and Results. A warning badge identifies missing or incompatible input. Clicking an editable object opens its definition in **Properties**. Applying a change reissues a Command with the object's name; it is recorded in the Journal. A Result row selects a field rather than editing the Model.

Build in this order: choose an idealisation and geometry, assign properties, mesh, define targets and conditions, define a Step, then solve. The tree order is a useful checklist, but some meshers create their own Body and therefore need a different geometry workflow. See [geometry](./geometry.md) and [meshing](./meshing.md).

## Find an operation

Use **Search commands** or **Ctrl+K / Command+K**. Search for a Command such as `material.add`, or an existing object by name. A command with required arguments opens its form. A natural-language intent preview depends on Assistant availability; searching registered Commands does not require AI.

The bottom panels expose Results, Checks, Script, Journal and other analysis views. Examples and Tutorials open guided overlays. Escape closes the active supported overlay. You can resize docked panels; view changes do not change the engine Journal.

The modeling tour uses space above the workspace rather than changing your requested panel sizes. On phones, the viewer and its comparison controls occupy their full height before the bottom tabs; scroll the workspace to move between these panels, the Model tree and Properties.

## Revisit the modeling sequence

Open **Tutorials → Modeling tour** for the eight-stage workflow guide, including when a tutorial is already open. The guide uses its own row above the workspace, so you can still use the highlighted controls and Properties form. At small window sizes, the workspace scrolls to the relevant control. It is a guide, not a checklist that edits or validates your Model.

Use **Continue on my own**, the close button, or **Escape** to dismiss it. You can reopen it at any time; existing dismissal preferences are preserved. The last stage offers **Build the cantilever tutorial**. Opening it leaves the current Model intact, but the tutorial's explicit first modeling action replaces it, so use a new project to keep earlier work.

## Inspect the viewer

Use the camera controls to orbit, pan, zoom and fit. With focus outside an editable field, **Shift+1** selects isometric, **Shift+2** front, **Shift+3** top and **Shift+4** fits the Model. The matching Commands are `view.preset` and `view.fit`. Viewer options control mesh edges, visibility, clipping, deformation scale and the legend.

Selection can identify a Body, face or Set. Confirm the target name before applying a Constraint or Load. A selected screen face is a starting point; a durable named Set is preferable for a definition that must survive remeshing.

## Keep document and view state distinct

**Undo** and **Redo** operate on engine history; Ctrl/Command+Z and Shift+Ctrl/Command+Z use the same Commands when a text editor is not handling the shortcut. Camera position, panel sizes and displayed fields are host state. They are callable but do not become engineering definitions in a saved Journal.

The top bar reports the engine path and actual CPU worker count. Read its notes before interpreting a slow solve as a model failure. See [troubleshooting](./browser-troubleshooting.md) for capability, solve and storage errors.
