# ADR 0047 — A two-minute PR gate, CD on main, a scheduled deep run

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
  including the CLI replays when Rust inputs change, the wasm bundle (cached when Rust is
  unchanged), web with thumbnails, the native-vs-wasm Journal hashes and every Chromium smoke
  variant (WebGPU on
  SwiftShader advisory). `deploy.yml` runs on that workflow's green completion and publishes the
  `dist` it built and tested; it no longer builds anything itself. `gpu.yml` runs the strict
  100 % lavapipe coverage gate when a merge changes the engine or geometry crates.
- **Deep run twice a month** (04:00 UTC on the 1st and 15th, `ci.yml` and `gpu.yml` on
  schedule): everything above
  plus `rust (macos-latest)`, `windows` and the D5 66k-DOF lavapipe case. A dispatch of `ci.yml`
  with `deep` runs the same set on any branch. Release validation calls both workflows, with
  `strict` making WebGPU smoke fatal, so nothing ships without the deep set.
  `deep-report.yml` turns each failed job of a scheduled run into a `bug`, `ci` issue (or, if that job already has one, a
  comment that reopens it when closed), because no PR goes red to tell anyone; agents take
  those issues like any other.

No threshold moved; only where and how often checks run.

## Consequences

- A PR no longer runs browser smoke or the CLI replay tests. Regressions there surface on main
  minutes after the merge, and a macOS or Windows-only failure surfaces within about two weeks
  (or in release validation) as an issue. As before, whoever merged fixes forward before anything else lands.
- A PR that changes Rust takes longer than two minutes: it compiles and tests the workspace and,
  on its first push, builds the wasm bundle it then caches for its later pushes.
- The site deploys only from a green main run, so a red main also holds the deployment until it
  is fixed. `deploy.yml`'s dispatch republishes the newest green main build.
  Pages uploads use an attempt-specific name, also passed to the deploy action, so retrying a
  failed deployment selects exactly one artifact despite retained artifacts from earlier attempts
  ([#834](https://github.com/andeplane/fem-lab/issues/834)). The tested `dist` is reused each time.
- Branch protection must require `pr gate` instead of ADR 0022's job names, which no longer
  report on pull requests.

## Follow-up: skip unchanged native checks on main (#858)

Two successful main runs on 5 November spent
[11.3 minutes](https://github.com/andeplane/fem-lab/actions/runs/42038839484) and
[16.7 minutes](https://github.com/andeplane/fem-lab/actions/runs/42024825945) in the Linux Rust job.
The latter merge changed only a browser test; this filter would skip its 16.7-minute Rust job.
The former also changed a tool and remains conservatively included.

On ordinary main pushes, compare the entire push to `github.event.before` and run the Rust job
only when its inputs changed: crates (including shaders, tests and benchmark decks), vendor,
Cargo manifests/lockfile/configuration, toolchain/lint configuration, GitHub configuration,
tools/fixtures and the committed registry schema. Tool changes conservatively run Rust because
native tests consume fixtures outside the crates. Add any future external native-test input to
this filter in `ci.yml` in the same change that introduces it. Deletions and renames count too.
A comparison failure fails CI and prevents deployment; it does not grant a green skip.

Scheduled and manual runs always run Rust, as does strict release validation, including the
deep platform matrix. Web tests, browser smoke, native-vs-wasm Journal
replays, the WASM bundle and the separate GPU coverage workflow keep their existing gates.
The observed Rust job cost was 11–17 runner-minutes. The app-only sample would avoid 16.7
runner-minutes (about 39 % of that run's total job time), less the small change-detection job.
These are estimates of avoided compute, not a measured reduction in the monthly bill.


## Follow-up: near-zero artifact storage (#858)

The owner's target is at least a 100× cost reduction, not a modest compute optimization.
FEM Lab is public: standard hosted runner compute is free under
[GitHub's billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Artifact storage is separately metered. The 11 November inventory found 4,488 live artifacts,
69.23 GB in total: 31.38 GB of `dist`, 13.41 GB of `wasm`, 10.01 GB of browser reports and
repeated release intermediates. The account screenshot is **gross** usage, not evidence of
net billed charges; account billing access is required to verify financial savings.

`artifact cleanup` runs after PR, CI, GPU, release and deployment workflows complete. It runs
only the trusted main-branch cleanup script and never executes a PR's artifact or code.
The script defaults to a dry run; `--apply` removes consumed intermediate artifacts and older
duplicated diagnostics. It preserves active runs, all artifacts younger than ten minutes,
all `dist` artifacts while deployment is active, the latest successful main CI's `dist`,
and the latest artifact of each diagnostic name. It refuses cleanup if the latest successful
main CI cannot be identified. API failures stop deletion; the initial backlog sweep can wait
for rate reset while preserving an API-call reserve for other work.

Temporary artifacts also have one-day retention as a backstop. Main's `dist` has seven days,
so manual redeployment requires a successful main CI build from the last seven days; dispatch
CI first to rebuild when older. The latest green source is still protected from the cleanup
script within that lifetime. Published GitHub Release assets, build caches, Actions logs,
repository contents and the already-deployed Pages site are not removed by this policy.
GPU failure coverage detail retains its existing seven-day lifetime. The final release bundle
also has seven days so a release-environment approval need not happen on the build day.

Local cleanup usage, from the repository checkout:

```sh
python3 -m unittest discover -s tools -p 'test_clean_ci_artifacts.py'
python3 tools/clean-ci-artifacts.py --repo andeplane/fem-lab
python3 tools/clean-ci-artifacts.py --repo andeplane/fem-lab --apply
```

The initial dry run retained 148.6 MB (about 466× less than 69.23 GB), including the current
GPU failure artifact and the latest deployable app. These are storage-footprint measurements;
future net charges must be checked after billing's usage reporting catches up. Already accrued
monthly storage charges cannot be undone by deleting artifacts.
