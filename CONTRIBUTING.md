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

`main` requires an up-to-date PR and one GitHub Actions check, **pr gate**, which aggregates
the Linux pull-request jobs in [pr.yml](.github/workflows/pr.yml). It finishes in about two
minutes when Rust is untouched; Rust changes add `rust lint` and `rust tests`. The protection
applies to administrators too. Wait for the check on the current PR head; a local pass, an
earlier revision or a pending job cannot authorize a merge. Browser smoke, the CLI replays, the
native-vs-wasm hashes and engine coverage run on merge to main, and macOS, Windows and the D5
GPU case run on the 1st and 15th of each month, as [ADR 0046](docs/adr/0046-two-minute-pr-gate-cd-on-main-scheduled-deep-run.md)
describes. Because the PR gate does not run browser smoke, run the affected Chromium specs
locally (below) before pushing; to run the deep set on a branch, dispatch the `ci` workflow
with `deep`.

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
[pr.yml](.github/workflows/pr.yml), [ci.yml](.github/workflows/ci.yml) and
[gpu.yml](.github/workflows/gpu.yml). Typical checks from the repository root are:

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

Run affected checks before pushing each candidate, using Node 22 as CI does. For changes to
shared app layout, onboarding, navigation or startup, run the full Chromium CPU suite against
a fresh development build from this worktree. Set `PW_PORT` to an unused port (the headerless
server also uses the port seven above it):

```sh
npm run typecheck
npm run test -w packages/app
FEMLAB_AI_MODE=development npm run build -w packages/app
PW_PORT=4910 npm run e2e -w packages/app -- --project=cpu
```

For bundle or runtime changes, also run `npm run size` and the cold Pages check:

```sh
PW_PORT=4910 npm run e2e -w packages/app -- --project=sw --grep "cold Pages bootstrap"
```

Changes to hosted account behavior also need the hosted build and its separate smoke, before
rebuilding in development mode for the supplier-fixture CPU suite:

```sh
FEMLAB_AI_MODE=hosted npm run build -w packages/app
PW_PORT=4910 npm run e2e -w packages/app -- --project=cpu e2e/hosted-account.spec.ts
```

The first-run tour is part of the default product state. A test asserting the workspace's
unobstructed panel dimensions must explicitly dismiss it; tests for onboarding must keep it
enabled. Do not make selectors ambiguous, drop assertions or lower budgets to accommodate a
red run. Diagnose the failure, then run the affected checks again. Record any local platform
or adapter limitation in the PR and wait for the corresponding CI result.

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

The browser app has a separate measured coverage baseline in
[its Vitest configuration](packages/app/vitest.config.ts): 82.5% lines, 79.76% statements,
74.7% functions and 76.43% branches. This is a minimum for the whole app, including pure UI
modules, workers and browser entry points; it is not a 100% app-coverage requirement. Raise
the committed thresholds as meaningful tests improve coverage; never lower them to pass a
change. The decision in [#474](https://github.com/andeplane/fem-lab/issues/474) retains this
baseline and behavioral checks (option 3), following the host policy in
[ADR 0007](docs/adr/0007-three-test-tiers-and-gpu-in-ci.md). It does not add an automatic
threshold ratchet or a separate 100% pure-UI gate.

`npm run test -w packages/app` collects coverage and runs
[the source-inclusion check](packages/app/scripts/check-coverage.mjs), which fails if any
authored `.ts` or `.tsx` module is absent from the report. Only type declarations are
excluded. Coverage thresholds do not prove that an assertion detects incorrect behavior:
UI tests must exercise the action and its outcome, rather than only checking a control's
label. The app baseline supplements those unit and Chromium checks.

Every numerical capability needs independent analytical or published oracles and the relevant
[Benchmarks](docs/BENCHMARKS.md), including a convergence study where a rate is known. Update
BENCHMARKS.md in the same change. Use property tests for invariants such as replay determinism,
undo, stiffness symmetry/PSD and unit round trips. Follow AGENTS.md's integration-test layout
rules so coverage merges generic and async instantiations correctly.

Report test commands and outcomes accurately. A focused test does not establish full coverage;
a local pass does not replace CI. Preserve failure output when a check fails.
