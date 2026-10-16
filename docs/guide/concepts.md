# Concepts and vocabulary

FEM Lab uses the same names in forms, scripts, tool descriptions and this guide. Start with the engineering terms; the runtime identities at the end are mainly useful when integrating tools or diagnosing a stale operation.

## The engineering document

- **Model**: the complete analysis definition: Geometry, mesh settings, Materials, Sections, Constraints, Loads, Steps and output requests. An AI language model is a different thing.
- **Journal**: the ordered engine Commands used to rebuild that Model. Undo/Redo move through this history. View and account actions are not engineering Journal entries.
- **Project**: the browser's saved workspace record around a Model. A project name, engine Model name and account identity serve different purposes. See [projects and storage](./projects-storage.md).
- **Geometry**: the shapes being analyzed, before numerical discretization: primitives, sketches, booleans or imported triangle boundaries.
- **Body**: a named geometry region or the implicit geometry owned by a mapped, swept or shell mesher. Materials, Sections and targets can refer to it.
- **Face**: a named boundary patch of a Body. Auto-names such as `beam.xmin` and geometric predicates identify useful surfaces.
- **Set**: a named collection of faces, nodes or elements used to say **where** a condition or read applies. It is not merely the current screen selection.

See [geometry](./geometry.md) and [Sets, Constraints and Loads](./sets-constraints-loads.md).

## Numerical representation and properties

- **Mesh**: the nodes and Elements used to approximate the domain. Generated meshes are derived from settings; authored imported connectivity is retained as checked source data, not edited through a cached numeric mesh.
- **Node**: a mesh point carrying the relevant degrees of freedom, such as displacement or temperature.
- **Element**: a connectivity and formulation linking nodes, such as a tetrahedron, hexahedron, triangle, quadrilateral, truss, beam or shell.
- **Mesher**: the algorithm/settings that produce the Mesh. Different meshers approximate curves, topology and interpolation differently.
- **Material**: named stiffness, mass, thermal or supported constitutive data. Creating a Material does not assign it to a Body.
- **Section**: the member geometry or through-thickness description required by a truss, beam or shell, including laminate plies where supported.
- **Idealisation**: the physical dimensional reduction: solid3d, plane stress, plane strain or axisymmetric. It is not a camera choice.
- **SI / Quantity**: SI is the engine's internal unit system. A Quantity supplies a value with a physical dimension and units at the boundary. Display units do not rescale the underlying problem.

Continue with [meshing](./meshing.md), [materials and sections](./materials-sections.md) and [units](./units.md).

## Conditions and analyses

- **Constraint**: a prescribed kinematic or temperature condition, coupling or supported relationship on a Set. A clamp, pin and roller restrain different motion.
- **Contact**: a supported connection between two face Sets. Bonded and frictionless behavior have different pairing/physics limits; contact is listed among a Step's Constraints.
- **Load**: a force-like or thermal excitation, such as force, pressure, gravity, heat flux or convection.
- **Step**: one analysis definition, selecting a procedure and active Constraints/Loads. Defining one does not execute a solve.
- **Procedure**: the governing analysis, such as static equilibrium, modal response or transient heat.
- **Solver**: the numerical method used to solve that Step; CPU/GPU selection does not change the intended physical procedure.

Read [Steps and solvers](./steps-solvers.md) and [physics limits](./physics.md) before combining capabilities.

## Results and evidence

- **Result**: fields and summary data from a successful solve, tied to its Step, Model state and Mesh.
- **Field**: a spatial quantity such as displacement, stress or temperature. Its components, units and node/element sampling location matter.
- **Frame**: one retained transient output at a physical time. A retained output interval is different from the integration time step.
- **Retained Result ID**: a session-local handle to an original solved context. It can be evicted and is not a portable saved-file identifier.
- **Benchmark**: a test case with an independent known/reference answer and stated comparison criteria.
- **Convergence study**: repeating an analysis at varied mesh sizes or time steps to assess how a chosen quantity changes. A low algebraic residual alone does not establish convergence of the physical approximation.

See [Results and verification](./results-verification.md) and [examples](./examples-tutorials.md).

## Automation and optional AI

- **Command / Query**: a typed operation that changes state / reads it. Both are declared in the registry.
- **Script**: TypeScript using the asynchronous `fem` API. It executes registered operations in a bounded runtime, not arbitrary ambient browser/Node capabilities.
- **Engine / Host**: the headless engineering library / the program connecting it to UI, devices, storage and I/O. Browser, CLI and MCP are different hosts.
- **Extension Point / Plugin**: an implemented internal interface / user-supplied implementation intended to fill one. Built-ins use extension interfaces, but runtime user-plugin loading remains planned.
- **AI model**: the provider's language model used by the Assistant, separate from your engineering Model.
- **AI credit**: the hosted model-usage budget unit, USD 0.001 per public credit. It is not a raw LLM token or a unit of FEM solve time.

See [scripts](./scripting-journal.md), [architecture](./architecture-extensions.md), [Assistant](./assistant.md) and [accounts](./accounts-billing.md).

## Advanced runtime identities

These terms appear in integration contracts and structured errors; ordinary modeling does not require managing them manually.

- **Session**: one activation of one Model in a runtime. Opening/importing another Model creates a fresh activation even when its name or bytes match.
- **Run**: one revocable producer, such as a Script or Assistant turn, bound to that Session. An old producer cannot silently follow a replacement Model.
- **StateVersion**: a monotonic committed-state counter, independent of Journal length; Undo, Redo and repeated solves can advance it.
- **BackendEpoch**: the issuing runtime incarnation. Restarting a runtime invalidates the assumption that an old operation identity belongs to the new one.

For exact schemas and operation availability, use the [generated API reference](./api-reference.md).
