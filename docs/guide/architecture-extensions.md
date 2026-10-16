# Architecture, extensions and product status

FEM Lab's engineering engine is a Rust library. The browser compiles it to WebAssembly, the native CLI runs it directly, and the Node MCP host uses the Node wasm build. TypeScript hosts own UI, storage, network, workers and device access. The registry is their typed Command/Query boundary.

## What is shared

The engineering Model is a replayable Journal. Geometry, Material definitions, mesh settings, Loads, Constraints and Steps use the same engine schemas across hosts. A host can add view/file/account Commands without putting those operations into engineering history.

The engine works in SI. CPU assembly, residuals and factorization use f64; GPU operator work uses f32 inside the supported refinement approach. CPU threading and GPU use depend on the host and requested solver. Browser capability notes report the path that actually initialized.

This separation makes a Journal portable; it does not guarantee identical availability for a file picker, viewer screenshot, STEP converter or account flow in every host. See [CLI/MCP](./cli-mcp.md) and the [API reference](./api-reference.md).

## Implemented extension structure

Built-in material laws, elements, loads, meshers, procedures and post-processing components use explicit extension interfaces. The current engine includes linear/orthotropic elasticity, supported J2 plasticity, continuum/line/shell elements and the [listed procedures](./physics.md). A new implementation should fit the relevant interface, schema metadata and independent Benchmarks.

This internal architecture is not yet an end-user plugin marketplace. `plugin.load` is exposed as a schema stub and currently returns unsupported. Arbitrary TypeScript/WGSL/wasm user material or solver loading is planned; do not build a production workflow that assumes it is already functional.

## Current product and planned hosts

| Current | Planned or not provided by the current product |
|---|---|
| Local browser geometry, mesh, solves, viewer and exports | A paid remote FEM engine/compute endpoint |
| Native Rust CLI and Node MCP tools from a checkout | A working `femlab serve` remote server |
| Optional hosted account-based AI, credits and subscriptions | A shipped Python binding/notebook environment |
| Browser-local projects, portable Model files and share links | Account-synchronized cloud project storage or multiuser live editing |
| Built-in extension interfaces and implemented physics | General runtime user-plugin loading |

The repository contains research/plans as well as executable code. A planned phase, schema placeholder or intended architecture is not evidence that a user-facing capability works today. This guide describes implemented surfaces and calls out those boundaries.

## Contributing a capability

Read the repository's [working rules](https://github.com/andeplane/fem-lab/blob/main/AGENTS.md), vocabulary and ADRs. Add the registry schema/docstring, real host integration and independent tests; numerical behavior needs appropriate Benchmarks and convergence evidence. Update this guide and regenerate the public reference in the same PR. Source and documentation checks should catch missing Commands, broken links and claims that have drifted from current behavior.

For users evaluating suitability, start with [physics limits](./physics.md) and [Results verification](./results-verification.md), rather than architecture goals alone.
