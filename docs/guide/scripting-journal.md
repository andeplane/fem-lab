# Scripts, Commands and the Journal

A **Command** changes the engineering Model or host workspace. A **Query** reads state. A **Script** calls them through the asynchronous `fem` API. The engine **Journal** records engineering operations so the Model can be rebuilt; camera, account, panel and other host state are not engineering history.

## Use the same surface as the UI

The Script panel supports TypeScript. Forms, tutorials, the Assistant and scripts use the same registered argument schemas. The [API reference](./api-reference.md) describes exact fields, defaults and available host operations.

```ts
const before = await fem.query.model();
console.log(before);
await fem.mesh.set({ mesher: { kind: 'lattice', size: '20 mm' }, order: 2 });
await fem.solve.run({ step: 'static' });
console.log(await fem.query.result({ step: 'static' }));
```

This snippet assumes a compatible existing Model with a Step named `static`. Read before modifying: a correctly typed name can still refer to a nonexistent object or an inappropriate target.

## Validate before execution

`query.validateScript` checks source against generated API declarations without running it. `script.run` validates automatically before starting execution. Diagnostics identify a code, cause, source location and hint. Types do not establish physical correctness, object existence, termination or a converged solution.

Scripts run in an isolated QuickJS runtime with registry access, supported console methods and timers. They do not have ordinary browser/Node filesystem, network, module-loader or environment access. Host file Commands are explicit capabilities, not ambient disk access. Account operations, secrets and consent are not delegated through Assistant scripts.

A timeout stops future script calls and terminates its runtime. Commands already admitted can finish and remain in the Journal; a timeout is not a transaction rollback. `script.stop` and `solve.cancel` have different scopes. Start a separate project or save a baseline before experimenting with a script that changes many definitions.

## Replay, Undo and portability

```ts
console.log(await fem.query.journal());
await fem.journal.undo({ steps: 1 });
await fem.journal.redo({ steps: 1 });
```

A saved `femlab/1` file contains the Model definition and Journal. Replaying restores engineering state; Results with session-local retained IDs must not be treated as portable stored simulation output. A Journal containing `solve.run` performs that solve during replay. A definition-only Journal remains unsolved until asked.

Exporting a Script gives a readable/reusable sequence. A Script export is different from a JSON Model file and is not opened through the same file picker. For reproducible comparisons, keep the Model, exact inputs, relevant mesh/procedure settings, reference result and exports together. See [projects](./projects-storage.md), [import/export](./import-export.md) and [CLI/MCP](./cli-mcp.md).
