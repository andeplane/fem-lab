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
  `query_objects`, `query_capabilities`.
- **`run_script`** — TypeScript against the `fem` API (`await fem.geometry.addBox({ … })`,
  `await fem.query.model()`), 30 s budget. Its Commands enter the Journal like any other.
- **`export_file { format, path, step? }`** — writes `vtu`, `msh`, `inp`, `stl`, `report` (the
  Markdown calculation note), `script` or `journal` into the `--project` folder. Paths are
  relative to that folder; `..`, absolute paths and symlinks out of it are refused.

## Resources

`femlab://model` (`query.model`), `femlab://journal` (`query.journal`), `femlab://schema` (the
whole Command/Query schema document).

## Install

```
npx femlab-mcp --project /path/to/your/work
```

From a checkout, build the engine and the server first:

```
npm ci
node tools/build-wasm.mjs          # writes tools/wasm-node (gitignored)
npm run build -w packages/mcp      # writes packages/mcp/dist/femlab-mcp.js
```

`femlab mcp --project <dir>` runs the same server: the Rust CLI looks for
`packages/mcp/dist/femlab-mcp.js` next to its own binary or in the checkout it was built in, or
at `FEMLAB_MCP`, and prints the install line above if it finds none. Point `FEMLAB_WASM` at a
folder holding `femlab_engine_wasm.js` if the engine lives somewhere unusual.

## Claude Code / Claude Desktop

Add to `~/.claude.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "femlab": {
      "command": "npx",
      "args": ["-y", "femlab-mcp", "--project", "/path/to/your/work"]
    }
  }
}
```

From a checkout, point it at the built bundle instead:

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
claude mcp add femlab -- npx -y femlab-mcp --project /path/to/your/work
```

## A first session

> Build a 1 m steel cantilever, 100 × 100 mm, fixed at one end with 1 kN down at the other,
> solve it and write me the calculation note.

The model, the Journal and the note are all reproducible: `femlab run <journal>` replays it
natively, `query_report` writes the same Markdown twice, and the Model hash is in its header.
