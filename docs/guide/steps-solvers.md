# Steps and solvers

A **Step** selects a procedure and names its active Constraints and Loads. Its settings belong to that analysis; unrelated fields shown in an older definition do not turn on another procedure. A Step definition does not solve until `solve.run` is called.

## Define and run a Step

```ts
await fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
console.log(await fem.query.cost({ step: 'static' }));
await fem.solve.run({ step: 'static' });
console.log(await fem.query.result({ step: 'static' }));
```

In the UI, inspect the Step in Properties and use its solve action. The top-bar Solve control uses the first Step in Model order; use an explicit Step name when running a multi-Step workflow. Solve blockers and warnings should be read before choosing a larger mesh.

## Order and dependencies

`step.reorder` changes Step order. `after` refers to an earlier solved Step whose state the procedure can consume. Examples include static thermal stress after a heat solve, modal response about a static prestress, and frequency-response procedures using a modal basis. Solve dependencies explicitly and keep them current. Reordering a list is not evidence that a missing predecessor Result was computed.

Transient procedures require physical time settings and relevant initial conditions. Output cadence determines which frames are retained; it is different from the integration time step. A static amplitude can retain ramped equilibrium frames; it does not become a dynamic solution. See [physics](./physics.md).

## Choose the numerical path

`solve.run` supports `auto`, `cpu-direct`, `cpu-pcg` and `gpu-pcg`. Auto chooses a sparse direct solve for smaller systems and an iterative path for larger systems, using GPU availability where applicable. Some procedures require direct factorization; the schema and errors state those restrictions. Explicitly requesting an unsupported GPU/procedure combination is not a reason to accept a different physical result.

Use `query.cost` first for large models. Its memory accounting is scoped, not a guarantee of fit. A failed iterative solve can justify trying `cpu-direct` on a model small enough for it, after checking constraints and conditioning. Finer meshes can increase direct-solver memory sharply.

## Cancel and continue

`solve.cancel` cancels the active solve or study; the host restores its pre-solve Model state and does not append a successful solve entry. A script timeout has different semantics: Commands already admitted may finish. See [scripts](./scripting-journal.md).

A successful numerical solve establishes a Result for a specific Model and Mesh. It does not establish mesh convergence, material suitability or agreement with the physical system. Continue with [Results and verification](./results-verification.md).

## GPU correction and memory limits

`gpu-pcg` requires a host-provided GPU device. Its f32 inner solve supplies
approximate directions to a bounded flexible f64 GMRES correction using the original
physical operator. The reported residual is recomputed in f64. The default outer
budget remains eight steps; the existing arithmetic-floor allowance remains
100 times the requested tolerance. Exhausting the budget outside that allowance
returns `solve.stalled`.

For solid 3D displacement systems, the fine GPU operator evaluates displacement
differences relative to the same node's free components, together with row moments
computed from the original f64 stiffness. This reduces cancellation of large forces
under nearly uniform translations. GPU arithmetic remains f32; the f64 physical
residual still decides convergence. Other idealisations retain ordinary scaled CSR.

Correction history retains at most eight vector pairs and restarts if a larger
outer budget is requested. Its four work vectors and history have a separate
256 MiB admission limit, charged against the existing setup allowance before
solver upload. Translation metadata, hierarchy and device-buffer limits also
apply. `solve.too_large` means the requested path was refused; reduce the mesh
or explicitly select a supported solver after assessing its memory needs.
These bounds do not guarantee that the host has enough free memory. Hardware
acceptance of the 780,300-equation cantilever does not establish capacity or
convergence for a different model or for a browser host.
