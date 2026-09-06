# Release workflow (#27)

Issue #27 requests tagged macOS, Linux and Windows CLI binaries, WASM/app builds and npm
publication. The workflow uses the standalone npm artifact from #304 and the portable built-in
CLI Benchmarks from #306. Their PRs must merge before this release workflow.

A tag whose version matches Cargo and npm invokes the reusable CI suite in strict mode: CPU,
GPU, Windows, native/WASM parity, host tests and all browser lanes must succeed. Native builds
also test the copied executable outside the checkout. Publication consumes the exact npm
tarball installed and exercised by the isolated package test, plus archives and SHA-256 sums.
A manual workflow run performs the same validation and packaging without publication.

The implementation and independent review are tracked on #27. Merge and CI prove the workflow
change; they do not claim that an npm version or GitHub release was published. Actual publication
is triggered by a release tag after the npm trusted publisher is configured as documented in
[RELEASING.md](../RELEASING.md). Rust crate publication is outside this issue's requested scope.
