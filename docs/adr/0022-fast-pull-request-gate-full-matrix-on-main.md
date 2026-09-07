# ADR 0022 — A fast pull-request gate, the full matrix on main

Status: accepted (2026-09-07). Issue #441.

## Context

CI ran the same matrix on every pull-request push and on main: Rust on Linux and macOS with the
100 % coverage gate, Windows, the native-vs-wasm Journal hash comparison, the web build and three
browser-smoke variants, about fourteen minutes when a runner is free. With a dozen open PRs and
the rule that every merge to main is remerged into the rest, the shared queue was seventeen runs
deep and landing fourteen PRs took an afternoon of waiting on jobs that rarely fail.

## Decision

One workflow, `ci.yml`, with the job set chosen by event:

- A pull request runs the fast gate: `rust (macos-latest)` (fmt, clippy `-D warnings`,
  `cargo test --workspace`, the wasm `cargo check`), the `wasm build`, `web (codegen, typecheck,
  tests, app build)` and `browser smoke` on Chromium's CPU path. That proves the change works on
  macOS and in Chrome, the supported browser (ADR 0014).
- A push to main, and release validation (`workflow_call` with `strict: true`), run everything
  the PR ran plus `rust (ubuntu-latest)` with the llvm-cov 100 % lines/functions/regions gate,
  `windows`, `native vs wasm Journal hashes`, the service-worker and WebGPU smoke variants and
  the advisory lavapipe GPU job.

No threshold moved; only where it runs. The wasm build is its own job so the artifact every
web-side job consumes is produced on both event kinds.

## Consequences

- Main can go red after a squash merge: a coverage gap, a Windows-only failure or a hash
  divergence surfaces on the push, not on the PR. Whoever merged fixes forward, before anything
  else merges. The full run on main is the strict gate, and the release workflow still runs it in
  full before publishing.
- A contributor who wants the full set before merging pushes to a branch and runs the workflow
  with `strict: true`, or reads the coverage table from the last run on main.
- If branch protection lists `rust (ubuntu-latest)`, `windows` or `native vs wasm Journal hashes`
  as required checks, those entries must be removed: they never report on a pull request now.
