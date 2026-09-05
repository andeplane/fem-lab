---
status: proposed
date: 2026-09-05
---

# Every change to a Model is a Command from one schema-first registry; the Journal is the model

The requirement is Blender's: anything the UI can do, a script or an AI can do, with no
exceptions. The only way to make that true and keep it true is structural: there is exactly
one way to change a Model, which is to dispatch a named Command whose input is declared once
as a Zod 4 schema. UI controls dispatch Commands. The script API calls Commands. The AI's
tool definitions are the Commands' JSON Schemas (`z.toJSONSchema()`), plus one `run_script`
tool. Queries are declared the same way for reads. The Journal, the ordered list of Commands
applied since the Model was created, is the authoritative history: replay rebuilds the
Model, export yields a script, undo pops it. A saved file is a snapshot plus the Journal.

## Considered options

- **Operators bolted onto a mutable document (Blender's actual implementation).** Blender
  has the principle but not the enforcement; context-dependent and modal operators are the
  known holes. We enforce it at the type level: the document store exposes no setters.
- **Event-sourced only (no snapshot).** Replaying a Journal that includes a 30 s solve to open
  a file is unacceptable; snapshots of the Model (not the Results) are cheap.
- **CRDTs (Yjs/Automerge) for collaboration.** No collaboration requirement. YAGNI.
- **Many hand-written AI tools separate from the UI.** This is how every CAE MCP server works
  today and it is why they drift. One registry, derived everywhere.

## Consequences

- A Command's schema is its documentation, its validation, its form in the UI, and its LLM
  tool definition. Adding a UI control that is not a Command is a bug, and a test enumerates
  the registry against the UI to catch it.
- Undo is `produceWithPatches` on an immutable document (immer); inverse patches come for
  free. Results are keyed by the Model revision they were computed from, so undoing past a
  solve simply orphans the Result.
- Every Command is deterministic given its input and the Model; anything nondeterministic
  (a random seed, a timestamp) is an explicit input.
- **No Command reads hidden context.** Blender's most-reported failure is "context is
  incorrect": operators that act on the active object or the selection. Here the target is
  always an explicit argument, and selectors are named Sets or geometric predicates, never
  internal ids (Abaqus's own manual tells users to replace recorded ids with `findAt`).
- **Interactive gestures end in one Command.** A drag or a rubber band emits nothing while it
  moves and a single Command with final values when it ends, so the Journal is replayable and
  readable. Blender logs only `REGISTER` operators; we log everything that changes the Model.
- Model *state* and Commands are separated the way Blender separates the data API from
  operators: `query.model` returns plain data, Commands change it, and the Journal records
  Commands only.
