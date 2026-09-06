# femlab-mcp

FEM Lab as an [MCP](https://modelcontextprotocol.io) server: every engine Command and Query is a
tool, so an editor can build a model, mesh it, solve it and write the calculation note without a
browser. The engine is the same wasm build the app runs, so a Journal built here replays there
byte for byte.

## Tools

- **every engine Command**, named `namespace_verb`: `model_new`, `geometry_addBox`,
  `material_add`, `material_assign`, `mesh_set`, `constraint_fix`, `load_traction`, `step_add`,
  `solve_run`, `study_converge`, `journal_undo`, … The tool list is generated from the engine
  schema, so it is exactly what the app's buttons dispatch — there is no second surface.
- **every engine Query**: `query_model`, `query_mesh`, `query_set`, `query_result`, `query_probe`,
  `query_path`, `query_cost`, `query_journal`, `query_script`, `query_report`, `query_convert`,
  `query_objects`, `query_capabilities`, `query_materialLibrary`.
- **`validate_script { code, timeoutMs? }`** — parse and type-check against the generated
  engine API and this host's registered argument schemas, without running code or changing
  the Model. Returns `{ ok, diagnostics }` with codes, causes, one-based source locations and hints.
- **`run_script`** — TypeScript against the `fem` API (`await fem.geometry.addBox({ … })`,
  `await fem.query.model()`), an optional `timeoutMs` up to 30 s (default 30 s). Its Commands enter the Journal like any other.
- **`export_file { format, path, step? }`** — writes `vtu`, `msh`, `inp`, `stl`, `report` (the
  Markdown calculation note), `script` or `journal` into the `--project` folder. Paths are
  relative to that folder; `..`, absolute paths and symlinks out of it are refused.

Validation has a separate worker and deadline: 10 s by default, configurable up to 30 s for
`validate_script`, with a 64,000-character source limit. `run_script` first validates with the
default validation deadline; only valid input reaches its execution worker and starts the
execution timeout. Validation and execution failures are returned as MCP tool errors with
their diagnostics or script output intact. Compiler work does not block the MCP event loop.

Engine result fields have generated types. Host argument types come from the actual host
registry; host results without declared response schemas remain dynamically typed. Type
checking cannot establish physical correctness, object existence, termination or the behavior
of dynamically generated code. Runtime registry validation and execution isolation still apply.
The browser exposes the same `query.validateScript` capability and automatically validates
`script.run`, using its own registered host commands and a lazy compiler worker.

## Script execution permissions

Each `run_script` uses a fresh QuickJS interpreter in WebAssembly inside a disposable Node
worker. Scripts have JavaScript built-ins, the asynchronous `fem` API, five console methods,
and `setTimeout`/`clearTimeout`. They have no Node globals, environment variables, module
loader, filesystem or network APIs. `Function` and `eval` stay inside QuickJS. The same
registry proxy implements the browser and MCP `fem` APIs.

Scripts may invoke the host's `fem.export.file` Command, which uses the same project export
policy as `export_file`; runtime isolation does not strengthen that host capability's path
checks. Nested `fem.script.run` calls are refused. The registry remains responsible for
validating all Commands and Queries.

The deadline includes worker startup and pending engine calls. At expiry the host closes the
RPC gate and terminates the worker, including synchronous loops and pending timers. No new
Command is admitted after the deadline. Commands admitted earlier may still finish: timeout
is not a transaction or an engine cancellation, and completed Commands remain in the Journal.
A successful return also terminates the worker, discarding detached callbacks.

QuickJS has a 64 MiB heap and 512 KiB stack limit; the worker has a 128 MiB V8 old-generation
limit. A script is limited to 10,000 messages, with at most 1,048,576 characters per message
and across console output. These contain ordinary script resource exhaustion; this is not an
OS sandbox or a guarantee against vulnerabilities in QuickJS, WebAssembly, Node or the host
Commands. Host engine work and large trusted Query responses are outside the script heap.

## Resources

`femlab://model` (`query.model`), `femlab://journal` (`query.journal`), `femlab://schema` (the
whole Command/Query schema document).

## Install

Build the engine and server from a checkout. This setup does not require a published npm
package:

```
npm ci
node tools/build-wasm.mjs          # writes tools/wasm-node (gitignored)
npm run build -w packages/mcp      # writes packages/mcp/dist/femlab-mcp.js
node packages/mcp/dist/femlab-mcp.js --project /path/to/your/work
```

`femlab mcp --project <dir>` runs the same server: the Rust CLI looks for
`packages/mcp/dist/femlab-mcp.js` next to its own binary or in the checkout it was built in, or
at `FEMLAB_MCP`, and reports setup instructions if it finds none. Point `FEMLAB_WASM` at a
folder holding `femlab_engine_wasm.js` if the engine lives somewhere unusual.

### Build and verify an npm artifact

Node 22 or newer is required. After the checkout build above, run:

```sh
npm pack -w packages/mcp
npm run test:package -w packages/mcp
```

The packing hook rebuilds the host and copies the generated Node engine into `dist/wasm-node`,
including a CommonJS package boundary for wasm-bindgen's Node output. The private registry is
bundled at build time and is not an installation dependency. Worker entry points remain in the
artifact. Packing fails if the Node WASM engine has not been built.

The package smoke test installs the real tarball into a fresh temporary directory, starts its
stdio server, lists tools, makes engine calls and executes a worker script. It also checks that
the installed WASM bytes match the build. No checkout engine override is supplied. Publication
and tagged platform releases remain tracked by [#27](https://github.com/andeplane/fem-lab/issues/27).

## Claude Code / Claude Desktop

Point the editor's MCP configuration at the built bundle. For a configuration that accepts
`mcpServers`, use:

```json
{
  "mcpServers": {
    "femlab": {
      "command": "node",
      "args": ["/path/to/fem-lab/packages/mcp/dist/femlab-mcp.js", "--project", "/path/to/your/work"]
    }
  }
}
```

Claude Code also takes it in one line:

```
claude mcp add femlab -- node /path/to/fem-lab/packages/mcp/dist/femlab-mcp.js --project /path/to/your/work
```

## A first session

> Build a 1 m steel cantilever, 100 × 100 mm, fixed at one end with 1 kN down at the other,
> solve it and write me the calculation note.

The model, the Journal and the note are all reproducible: `femlab run <journal>` replays it
natively, `query_report` writes the same Markdown twice, and the Model hash is in its header.
