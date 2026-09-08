# FEM Lab

A browser-based finite-element editor and solver where every action the UI can take is a
named, typed command, so a script or an AI can do anything a person can. This glossary is
the vocabulary the docs, the code and the AI's tool descriptions share. Definitions say what
a thing *is*; how it is implemented lives in the ADRs and the plan.

## Execution ownership

**Session**:
One activation of one Model in a runtime. New, open and import create a fresh identity even
when the saved bytes or project name are identical. A producer is bound to that activation;
its Commands cannot silently follow a later active Model. Ownership is checked by SessionOwner; see [the session host contract](docs/session-host-contract.md) and issues #380–#385.

**StateVersion**:
A monotonic counter of committed observable engine state within the runtime. It advances for
undo, redo and repeated solves, independently of Journal length and Model/Result hashes.

**Run**:
One revocable producer of operations, such as a Script or Assistant turn, bound to a Session.
Child operations inherit its identity. An intentional successful replacement may advance only
the initiating Run to the new Session.

**BackendEpoch**:
The identity of one issuing runtime incarnation, supplied by its host. Restarted or replaced
runtimes issue fresh epochs; reconnecting never rebinds an old operation automatically.

**Operation**:
One finite read, write or control request within a Run, carrying its own operation id. Replies,
errors and progress retain the request’s execution identity.

**Project binding**:
A captured persistence destination and generation. Its immutable save jobs carry a Session,
StateVersion and ModelFile; switching or deleting projects cannot redirect an old save.

## The model

**Model**:
The complete, serialisable description of one analysis: geometry, mesh settings, materials,
sections, constraints, loads, steps and output requests. One document, one file.
_Avoid_: project, scene, case, deck, job

**Geometry**:
The shapes being analysed, defined by a script of primitives and booleans and independent of
any mesh.
_Avoid_: CAD, part file, solid model

**Body**:
One connected region of the geometry, carrying a material and a name. Explicit Bodies own
Shapes; mapped, swept mapped and shell surface meshers own an implicit Body with the same rename and
guarded-removal lifecycle (ADR 0016). A free mesher references an explicit Body.
_Avoid_: part, instance, solid, volume

**Face**:
A named surface patch of a body, the thing constraints and loads attach to. Faces are named
by the script, not picked by node numbers.
_Avoid_: surface, side, boundary patch

**Set**:
A named collection of nodes, elements or faces, resolved from a face or a region predicate
when the mesh is built. Sets are how a Model refers to "where".
_Avoid_: group, selection, region, physical group

**Mesh**:
The nodes and elements produced from the Geometry by a Mesher with given settings. A
derived object, never edited by hand.
_Avoid_: grid, discretisation

**Element**:
One finite element: a connectivity and a type (hex8, tet4, tet10, ...). A line Body's
elements are members: a truss (`truss2`, axial force only) or a beam.
_Avoid_: cell, zone

**Beam**:
A two-node Timoshenko member (`beam2`): axial force, shear, bending about two axes and St
Venant torsion, so its joints carry three rotations `rx, ry, rz` as well as the three
displacements. A Mesh with a beam Body has six unknowns per node; on nodes no beam reaches the
rotations are *inert* (no stiffness, no mass, dropped from the free set) so a solid next to a
beam answers exactly as it does alone. The section's local z (its height) follows the
`orientation` axis of `section.assign` or the default rule (global Z, global X for a
vertical member); local y closes the right-handed triad.
_Avoid_: frame element, bar (that is a truss), B31

**Shell**:
A four-node MITC4 midsurface element (`shell4`) with three displacements and three
rotations per node. A shell Section supplies its thickness; a director at each
corner identifies the positive (top) side. Transverse shear uses mixed covariant
interpolation so thin plates do not shear-lock. A small drilling penalty couples
rotation about the normal to the surface's in-plane spin (ADR 0023). Top and bottom
stress refer to offsets of plus and minus half the thickness from the midsurface.
The `stressTop` and `stressBottom` fields retain global Cartesian stresses per
element node. `shellMoment` is the stress first moment `∫ z σ dz`, in global
tensor components and N (moment per unit width), positive for tension on the top
side. It also remains per element node. The `surface` mesher owns an implicit Body and joins bilinear,
cylindrical or spherical patches while preserving separate directors at creases.

**Section force**:
The resultant a beam carries across a cut, per member end: `N, V_y, V_z` (the `sectionForce`
field) and `T, M_y, M_z` (`sectionMoment`), in the member's local axes, positive as the far side
of the cut acts on the near side, right-handed about the local axes. Per element node, never
averaged across a joint.
_Avoid_: internal force, stress resultant, BMD/SFD

**Material**:
A named constitutive description with SI properties (density, Young's modulus, ...).
_Avoid_: mat, property card

**Constraint**:
A prescribed kinematic condition on a Set: fixed, roller, prescribed displacement, tie. On a
beam joint a *clamp* (`constraint.fix` with no rotation named) holds all six DOFs and a *pin*
(`constraint.pin`) the three displacements only; a symmetry plane holds its normal displacement
and the two rotations in the plane.
_Avoid_: BC, boundary condition, support, fixture, restraint, encastre

**Load**:
A prescribed force-like condition on a Set: pressure, traction, point force, moment (on beam
joints), body force, gravity, thermal load.
_Avoid_: BC, forcing, excitation

**Step**:
One analysis to run on the Model: a procedure (static, modal, transient, thermal) and the
Constraints, Loads and output requests active in it. Steps run in order and may inherit
state.
_Avoid_: study, case, stage, load case, job

**Damping ratio**:
The fraction ζ of critical damping a mode carries, applied as Rayleigh damping
`C = αM + βK` under the hood: an implicit Step's `rayleighAlpha`/`rayleighBeta` read directly
as α and β, and a harmonic Step's `dampingRatio` (one value, every mode) or `dampingRatios`
(one value per mode, the last held for any mode past the end) convert to `ζ_k = α/(2ω_k) +
βω_k/2` and add to it. ζ = 1 is critical damping; the schema refuses ζ ≥ 1.
_Avoid_: damping factor, loss factor, Q, viscosity

**Result**:
The fields (displacement, stress, temperature, mode shapes) a Step produced, tied to the
Mesh it ran on and to the Model revision it came from.
_Avoid_: output, odb, solution

**Frame**:
One retained primary nodal field at a physical time in a transient Result. Frame indices count
retained output from zero (the initial state), independently of integration-step numbers.
`query.frames` lists them; `query.frame` reads one SI field. A probe or path can select the
same Frame by index or by exact/explicitly nearest unit-bearing time, without temporal
interpolation. Final-field Queries retain their existing defaults when no sample is supplied.
Frames carry the solved Model hash and Step name; these identify Model state, so a host must
invalidate cached Frames on every solve acknowledgement, including a re-solve of the same Model.
`view.playTransient` plays these Frames at positive simulated seconds per wall second, holds
each stored field until the next retained time, and stops at the endpoint. An explicit sample
seeks by index or engine-resolved physical time; changing speed or pausing preserves the
continuous playhead between Frames. The viewer uses one Frame for contours, displacement,
legend and probes. `view.animate` keeps its separate 0–100 percent modal/amplitude phase contract.

## Doing things

**Command**:
A named, schema-typed operation that changes the Model or the workspace. Every UI control
dispatches a Command; the script API calls the same Commands; the AI's tools are the
Commands. There is no other way to change a Model.
_Avoid_: action, operator, mutation, method

**Query**:
A named, schema-typed read of the Model, Mesh or Result that changes nothing. Queries are
what let a script or an AI observe before deciding.
_Avoid_: getter, probe, inspect

**Result-validity fingerprint**:
An internal hash of Model parameters with only the display name excluded. It determines
whether a cached Result is stale. Full Model and Journal hashes still include the name for
saved-file and replay identity ([ADR 0017](docs/adr/0017-result-validity-and-document-identity.md)).

**Journal**:
The ordered list of Commands applied to a Model since it was created. Replaying the Journal
rebuilds the Model; exporting it yields a script; undo pops it.
_Avoid_: history, log, macro, rpy, trace

**Script**:
Source text in the script language that calls Commands and Queries. Written by a person or
generated by an AI; the UI can emit one from the Journal.
_Avoid_: macro, program, deck, notebook

**Sandbox**:
The isolated runtime a Script executes in, with access to Commands and Queries and nothing
else.
_Avoid_: VM, worker, realm

**Mesher**:
The component that turns Geometry plus mesh settings into a Mesh. There may be several
(lattice, tetrahedral); the Model records which and with what settings.

**Plugin**:
User-supplied code that fills one Extension Point: a material law, an element, a load, a
post quantity, a mesher or a procedure. Written in TypeScript, WGSL or compiled to wasm from
C, C++ or Fortran. A Model records every Plugin it used by name and content hash.
_Avoid_: user subroutine, UMAT, add-on, extension, module

**Extension Point**:
A named, typed interface the core calls and a Plugin implements. The set of Extension Points
is fixed by the core; the set of Plugins is open.
_Avoid_: hook, callback, slot

**Solver**:
The component that runs a Step on a Mesh and produces a Result. Named by procedure, not by
hardware.
_Avoid_: engine, kernel, backend

**Engine**:
The headless library that owns the Model, the registry, the Meshers, the Solvers and the
Benchmarks. It has no screen and no file system of its own.
_Avoid_: core, backend, server

**Host**:
A program that constructs an Engine and connects it to the outside: the browser app, the Node
CLI, the MCP server, a Python environment. Hosts own I/O, concurrency and the GPU device; the
Engine owns everything else.
_Avoid_: frontend, client, wrapper

## Checking things

**Benchmark**:
A Model with a known reference answer (analytical, NAFEMS, or a cross-check against another
solver), run as an automated test with a stated tolerance.
_Avoid_: example, demo, validation case, verification case

**Convergence study**:
The same Benchmark run at several mesh sizes to show the error shrinks at the expected
rate. A Benchmark that only passes at one mesh size is not a Benchmark.


## Retained solve instances

An immutable **Result record** owns one successful solve's Step, revision, Model identity,
Result-input fingerprint, Model metadata, exact BuiltMesh and StepResult. Its opaque Result id
is local to the Engine instance. Equal-input re-solves have different ids; ids are not recycled
on Model new/import/replay. Those operations clear records. The eight most recent successful
records are retained, oldest first; reads do not pin records and failures do not evict them.
`query.results` reports the catalogue, limit and scoped payload accounting. Field/history and
mesh numeric payload bytes and serialized Model metadata bytes are separate measurements,
not a measured allocator or process peak.

`resultId` on Result, field, probe, path and frame Queries selects that solved context, including
its mesh and display units, even after edits. The default per-Step selection retains existing
stale-field safeguards. A supplied Step must match the id. Missing/evicted ids are errors;
old values are never attached to current geometry. The existing FrameSample time/index rules
remain canonical. See ADR0018 and issue #280.
