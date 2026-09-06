# Contributing to FEM Lab

[AGENTS.md](AGENTS.md) is the working contract for people and agents. Read it before changing
code; this guide provides the practical sequence. The [docs index](docs/README.md) is the
entry point for users, and [CONTEXT.md](CONTEXT.md) defines the vocabulary.

## Claim an issue and isolate the work

Every change starts with an issue on `andeplane/fem-lab`. Search existing issues and PRs first.
For a new issue, describe the symptom or request, the known cause and how it will be verified;
add an area label. Split work that would take more than a day.

Apply `in progress` as soon as investigation starts. Do not take an already claimed issue;
coordinate with its owner. Keep the main checkout on main and create an isolated worktree
with an issue-numbered branch, for example `codex/123-short-description`. Use an unused port
for browser tests and do not stop another contributor's servers or modify their worktree.

Commit feature-sized, tested steps and stage files by name. Open one PR per issue, with the
issue number in the title and `Closes #123` at the end of the body. Describe the changed
behavior, verification and any remaining limitations. Review before merging; all CI must be
green. After merge, verify that the issue closed and remove `in progress` if it remains. If
work stops, remove the label and explain why on the issue.

## Preserve the architecture

The engine and geometry libraries are Rust; hosts are TypeScript. The engine is headless:
hosts supply I/O, clocks, devices and concurrency through typed interfaces. Every capability
is a Command or Query in the schema-first registry. Engine Commands enter the Journal; host
view state does not. Physical values use SI internally and unit-bearing quantities at the
boundary. CPU numerical work uses f64; GPU kernels use f32 inside the f64 outer calculation.

Use the existing extension points for numerical capabilities. Read the relevant
[ADR](docs/adr/) before departing from a rule. Record a new ADR for a difficult-to-reverse
trade-off, and update CONTEXT.md when terminology changes. Add Command schema descriptions
with the implementation: they are also the AI tool descriptions.

## Validate the change

Build the wasm artifacts before host tests using the sequence in
[Getting started](docs/GETTING-STARTED.md). The exact current CI commands and platforms are in
[ci.yml](.github/workflows/ci.yml). Typical checks from the repository root are:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
npm run codegen:check
npm run typecheck
npm test
npm run build
npm run size
```

For a schema change, regenerate the native schema and TypeScript/reference outputs together:

```sh
cargo run -p femlab -- schema --out packages/registry/src/generated/engine.schema.json
npm run codegen
```

Engine and geometry coverage must be 100% of lines, functions and regions. Regions are the
stable-toolchain proxy for branches. Tests must detect broken logic; do not exclude code or
weaken thresholds. Coverage should use unoptimized instrumentation even when ordinary tests
use an optimized profile:

```sh
CARGO_PROFILE_TEST_OPT_LEVEL=0 cargo llvm-cov -p femlab-engine -p femlab-geometry --features gpu-tests --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100
```

This command needs a working GPU adapter. CI runs the kernels on lavapipe; software adapters
are for correctness, never performance measurements. The CPU-only coverage bridge and the
GPU job's promotion status are described in [ADR 0007](docs/adr/0007-three-test-tiers-and-gpu-in-ci.md).
Registry vitest thresholds are also 100%; thin hosts use unit and smoke tests. Browser checks
run against Chromium, including CPU, service-worker and software-GPU lanes.

Every numerical capability needs independent analytical or published oracles and the relevant
[Benchmarks](docs/BENCHMARKS.md), including a convergence study where a rate is known. Update
BENCHMARKS.md in the same change. Use property tests for invariants such as replay determinism,
undo, stiffness symmetry/PSD and unit round trips. Follow AGENTS.md's integration-test layout
rules so coverage merges generic and async instantiations correctly.

Report test commands and outcomes accurately. A focused test does not establish full coverage;
a local pass does not replace CI. Preserve failure output when a check fails.
