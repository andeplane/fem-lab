# Getting started

[Documentation home](README.md)

## Build a checkout

Use the Rust toolchain pinned in [rust-toolchain.toml](../rust-toolchain.toml), Node 22, and
Chromium. Run these commands from the repository root:

```sh
npm ci
node tools/build-wasm.mjs
npm run dev
```

The wasm build needs `wasm-bindgen-cli` at the exact version in Cargo.lock. If it is missing or
mismatched, the build prints the matching `cargo install` command; run that command and retry
the build. Installing npm dependencies first supplies Binaryen for the optimized wasm build.
The development app is at `http://localhost:5173/fem-lab/`.

For a production build, run `npm run build`, then `npm run preview -w packages/app`. See the
[browser host guide](../packages/app/README.md) for preview, isolation headers and bundle budgets.
The app reports missing browser capabilities; Chromium is the supported browser.

## Open and solve an example

Open the Examples panel and choose the cantilever. The same action is callable in the browser
console:

```js
await fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' });
await fem.query.model();
await fem.query.result({ step: 'static' });
```

The example constructs and solves a steel beam with a fixed end and an end load. It opens
with Results already available. Inspect its Bodies, material, constraints, loads and Step to
understand the analysis. After an edit, run `await fem.solve.run({ step: 'static' })` again. Results include field extrema, reactions
and force balance. Use the Results panel for contours, and the Checks panel to inspect the
analysis. The [cantilever tutorial](../packages/app/tutorials/cantilever.json) explains its
beam-theory comparison; the [example catalogue](EXAMPLES.md) gives reference values and limits.
A single plausible-looking contour is not verification: compare reactions, independent
reference values and mesh convergence.

The bundled file is a Journal entry array, not a saved `femlab/1` ModelFile. Use the example
command for bundled examples and `file.open` for files produced by `file.save`.

## Commands, units and history

Commands change the Model and enter the engine Journal. Queries read it. Quantity arguments
include units, for example `size: ['1 m', '100 mm', '100 mm']` or `E: '210 GPa'`; incompatible
dimensions are schema errors. [The generated reference](COMMANDS.md) lists required arguments,
enums, defaults and bounds.

```js
await fem.query.journal();
await fem.dispatch({ cmd: 'journal.undo' });
await fem.dispatch({ cmd: 'journal.redo' });
await fem.dispatch({ cmd: 'file.save' });
```

Undo and redo move through engine history. Camera and panel actions are callable host Commands
but do not enter the engine Journal. Saving downloads a model file when no project folder is
open. Autosave keeps projects in this browser, and Recent projects reopens them. Use `file.save`
or an export when you need a portable copy outside this browser.

## Run without the browser

The native CLI can replay the same committed Journal and compare its recorded hashes:

```sh
cargo run --release -p femlab -- run crates/engine/benches/journals/cantilever.json --verify --cpu
cargo run --release -p femlab -- --help
```

`--cpu` explicitly selects the CPU path. The browser and native engine use the same Command
schema; CI compares native and wasm Journal hashes. For editor tools, build the
[MCP host from the checkout](../packages/mcp/README.md#install). Its setup guide includes a
local `node` command and an example `mcpServers` configuration.

Continue with the [tutorial index](TUTORIALS.md), [benchmark table](BENCHMARKS.md) or
[contribution guide](../CONTRIBUTING.md).
