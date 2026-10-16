# CLI and MCP workflows

The browser is one host for the same headless engine. The native Rust CLI can replay engineering definitions and write artifacts without the UI. The Node MCP host lets a compatible editor/agent use the schema and engine tools in a project directory. Hosted AI subscriptions do not provide a remote FEM compute service.

## Native CLI

From a source checkout with its pinned Rust toolchain:

```sh
cargo run --release -p femlab -- --help
cargo run --release -p femlab -- run crates/engine/benches/journals/cantilever.json --verify --cpu
```

`run` replays a Model/Journal/Command input, including only the solves explicitly present in it. `--verify` checks recorded hashes where supplied; `--cpu` requests the CPU path. Export supports the listed mesh, report, Script and Journal formats. Use the current command's `--help` for exact arguments and destinations.

The Abaqus converter can write an unsolved normal Model file:

```sh
cargo run -p femlab -- import-inp bar.inp --out bar.femlab.json --name 'Imported bar' --body bar --mode static --unit-length '1 mm' --unit-force '1 N' --unit-time '1 s' --cpu
```

Replaying that definition-only file does not add a solve. Open it in the browser and solve the named Steps, or explicitly include `solve.run` in your replay workflow. See [import/export](./import-export.md).

## Build the Node MCP host

The checkout setup uses Node 22 and generated Node wasm assets:

```sh
npm ci
node tools/build-wasm.mjs
node tools/build-project-io.mjs
npm run build -w packages/mcp
node packages/mcp/dist/femlab-mcp.js --project /path/to/your/work
```

The wasm builder prints the matching wasm-bindgen installation command when required. The MCP server uses stdio; configure your editor to run the final `node` command with an absolute checkout path. Detailed platform packaging and editor configuration live in the [MCP host README](https://github.com/andeplane/fem-lab/blob/main/packages/mcp/README.md).

## Know the host boundary

Engine tools are generated from the schema, with names such as `geometry_addBox` and `query_model`. `validate_script` typechecks without executing; `run_script` runs a bounded QuickJS worker. Export/import host operations require their appropriate capabilities. Project-relative paths are checked against the retained directory capability; starting without `--project` leaves disk operations unavailable while inline engine work can still be used.

The MCP sandbox has no ambient network/filesystem or Node globals. Timeouts stop future admission, not Commands already completed. Host-specific view, file-picker, account and camera operations are not universally available in a headless process. Use the generated [reference](./api-reference.md) and [script guide](./scripting-journal.md) rather than assume every browser control maps to a working Node capability.

`femlab serve` is still a planned/stubbed remote-host entry point. There is no shipped Python binding/environment in the current workspace. See [architecture and extensions](./architecture-extensions.md).

## Hosted AI HTTP integration

The hosted AI service exposes `POST /v1/ai/completions`, with `/chat/completions` as an alias. It accepts FEM Lab's strict normalized completion protocol, a Firebase bearer ID token and an `Idempotency-Key`; it is not a drop-in OpenAI Chat Completions payload. Streaming uses request, receipt and chat SSE envelopes. The request-status endpoint reconciles authoritative usage rather than replaying generated text. `/v1/ai/models` reports the authenticated account's available models.

Public credit quantities are negotiated using `X-Femlab-Credit-Unit: usd-milli-v1`; omitting it retains the legacy numeric contract. Do not infer an account balance from token counts or treat a disconnected stream as a canceled debit. Start with the browser/MCP registry for Model operations and read the [service protocol documentation](https://github.com/andeplane/fem-lab/blob/main/packages/service/README.md) before building an HTTP client. Provider secrets belong on the service, not in a browser integration. See [credits and billing](./accounts-billing.md).
