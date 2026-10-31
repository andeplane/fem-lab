# ADR 0046 — A two-minute PR gate, CD on main, a weekly deep run

Status: accepted (2026-10-31). Issue #820. Supersedes ADR 0022.

## Context

ADR 0022 cut the PR gate to Rust on macOS, the wasm build, web and CPU browser smoke, and moved
the rest to every push to main. A month later fem-lab was the account's largest GitHub Actions
cost by far (about $794 in October 2026), and a PR still waited 30–40 minutes. Measured on
[a PR run](https://github.com/andeplane/fem-lab/actions/runs/39254606835) and
[a main run](https://github.com/andeplane/fem-lab/actions/runs/39263077484):

- `rust (macos-latest)` took 14 minutes on every PR push. macOS minutes bill at roughly ten
  times the Linux rate, so this one job was about three quarters of every PR run's cost.
- `wasm build` (11–15 min) rebuilt identical bytes on PRs and merges that never touched Rust,
  and `deploy.yml` rebuilt them a third time on every merge.
- On main, the lavapipe coverage job took 64 minutes per merge (46 min instrumented coverage,
  18 min for the release D5 case) even when the merge only changed the app or docs.
- Agents push many revisions per PR, multiplying all of the above.

## Decision

Three tiers, each in its own workflow:

- **PR gate (`pr.yml`)**, Linux only. The wasm bundle comes from the Actions cache, keyed on
  every Rust input (`.github/actions/wasm`); a PR that does not touch Rust restores it in
  seconds. Four parallel `web` slices then run what main's `web` job runs except thumbnails:
  checks and typecheck, package tests, app unit tests, and the app build with its size budget.
  When Rust changed, `rust lint` (fmt, clippy, wasm `cargo check`) and `rust tests`
  (`cargo test --workspace --exclude femlab`) also run. One aggregate check, `pr gate`, is the
  only required status, so jobs can move between tiers without changing repository settings.
- **CD on main (`ci.yml` on push, then `deploy.yml`)**, Linux only: workspace Rust tests
  including the CLI replays, the wasm bundle (cached when Rust is unchanged), web with
  thumbnails, the native-vs-wasm Journal hashes and every Chromium smoke variant (WebGPU on
  SwiftShader advisory). `deploy.yml` runs on that workflow's green completion and publishes the
  `dist` it built and tested; it no longer builds anything itself. `gpu.yml` runs the strict
  100 % lavapipe coverage gate when a merge changes the engine or geometry crates.
- **Weekly deep run** (Monday 04:00 UTC, `ci.yml` and `gpu.yml` on schedule): everything above
  plus `rust (macos-latest)`, `windows` and the D5 66k-DOF lavapipe case. A dispatch of `ci.yml`
  with `deep` runs the same set on any branch. Release validation calls both workflows, with
  `strict` making WebGPU smoke fatal, so nothing ships without the deep set.

No threshold moved; only where and how often checks run.

## Consequences

- A PR no longer runs browser smoke or the CLI replay tests. Regressions there surface on main
  minutes after the merge, and a macOS or Windows-only failure surfaces within a week (or in
  release validation). As before, whoever merged fixes forward before anything else lands.
- A PR that changes Rust takes longer than two minutes: it compiles and tests the workspace and,
  on its first push, builds the wasm bundle it then caches for its later pushes.
- The site deploys only from a green main run, so a red main also holds the deployment until it
  is fixed. `deploy.yml`'s dispatch republishes the newest green main build.
- Branch protection must require `pr gate` instead of ADR 0022's job names, which no longer
  report on pull requests.
