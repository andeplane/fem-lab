# Getting started

You can complete a local analysis without signing in or paying for AI. Open FEM Lab in current Chromium, let the engine finish starting, and keep the capability notes visible if it reports a CPU or single-threaded path. See [browser requirements](./browser-troubleshooting.md) if startup fails. The 3D viewer downloads when you open a modeling workspace, so the introduction does not need to load it first.

## Start modeling with the workflow tour

Choose **Start modeling — free** to open a local project. On your first workspace entry in this browser, the **Modeling tour** explains Geometry → Material → Mesh → Constraints → Loads → Step → Solve → Results. Its outlined control stays available in the workspace; the tour does not create engineering definitions or run AI.

An empty new local Model opens the starter Body form with an uncommitted preview. If your Model already contains geometry—because you opened a project, an example or ran a geometry Command—FEM Lab does not add another starter draft. Choose **+ add body** when you want another Body; existing Properties edits are preserved.

Use **Next** and **Back** at your own pace. **Continue on my own**, the close button, or **Escape** dismisses it. That preference is remembered when browser storage is available. To revisit it, choose **Tutorials → Modeling tour**. Reopening does not reset your saved dismissal preference or change the Model.

The final **Build the cantilever tutorial** action opens the existing tutorial at its first step. It runs no modeling Commands until you explicitly choose **Do it for me** or perform the action yourself. Use a new project before starting the tutorial if you want to keep an existing Model; its first step creates a new Model. All of this works without an account or AI.

## Inspect a solved example

1. Choose **Examples** and open **Cantilever beam** (`cantilever`). Opening an example creates a local project from its Journal; the included solve produces Results.
2. Expand Geometry, Materials, Mesh, Constraints, Loads and Steps in the Model tree. Click an object to inspect its definition in Properties.
3. In Results, choose displacement and then stress. The deformed shape is usually magnified; read the legend and actual displacement values.
4. Open Checks. Compare the support reaction with the applied 1 kN load, then examine the deflection and mesh sensitivity.
5. Save a portable Model file before making changes you want to compare later.

The same bundled example can be opened through the registry:

```ts
await fem.example.open({ name: 'cantilever' });
console.log(await fem.query.result({ step: 'static' }));
```

## Build the beam yourself

Start a new project, open the Script panel and run the following. Running `model.new` replaces the current engine Model; use a new project so the previous one remains in Recent projects.

```ts
await fem.model.new({ name: 'My cantilever' });
await fem.model.setUnits({ units: { length: 'mm', force: 'N', stress: 'MPa' } });
await fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] });
await fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3' });
await fem.material.assign({ material: 'steel', bodies: ['beam'] });
await fem.mesh.set({ mesher: { kind: 'lattice', size: '25 mm' }, order: 1 });
await fem.constraint.fix({ name: 'root', on: 'beam.xmin' });
await fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] });
await fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
await fem.solve.run({ step: 'static' });
```

These are the same Commands that forms and tutorials use. The box's faces are named `beam.xmin` through `beam.zmax`; material creation and assignment are separate operations. Defining a Load does not activate it until a Step lists it.

## Know what to expect

For a slender cantilever, beam theory gives `tip displacement = P L³ / (3 E I)` and `I = b h³ / 12`. With this geometry and load, the reference is about **0.1905 mm downward**. The 3D finite-element answer can differ because of shear, the support idealization and discretization. The support should carry the applied load and its moment. A small residual alone does not prove the chosen physical model is appropriate.

Try a finer mesh and compare the same quantity. See [Results and verification](./results-verification.md), then [meshing](./meshing.md). When an edit makes a Result stale, solve the relevant Step again.
