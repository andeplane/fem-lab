# Releasing FEM Lab

The `release` workflow packages the CLI for Linux x86-64, Windows x86-64 and both macOS
architectures, the browser app, browser WASM, and `femlab-mcp`. Each ZIP includes its license. Run the extracted CLI with `--help` for its commands. `SHA256SUMS` covers every release artifact.

## Prepare and verify

Keep `[workspace.package].version` in `Cargo.toml` and the version in
`packages/mcp/package.json` equal, update the npm lockfile, and merge the version change through
a reviewed PR with green CI. The release tag must be exactly `v` followed by that version.

PRs changing the release workflow or packaging helpers run its full build without publishing.
You can also run the `release` workflow manually from GitHub Actions to validate and build without publishing.
It runs the same CI workflow with all Windows, GPU and browser GPU checks required. Native builds
test a copied CLI outside the checkout; npm packaging installs the tarball in a temporary project
and exercises the actual engine, script worker and validation worker. The downloadable
`release-bundle` artifact contains these checked outputs. An npm failure or any failed check
prevents the publishing job.

## Configure npm publication

Configure `femlab-mcp` with an npm trusted publisher for GitHub repository `andeplane/fem-lab`,
workflow filename `release.yml`, and environment `release`. The workflow grants `id-token: write`
only to its publishing job and uses npm 11 on Node 22. It publishes the already tested tarball
with provenance. Follow [npm's trusted publishing setup](https://docs.npmjs.com/trusted-publishers/)
for package ownership and initial configuration. The GitHub `release` environment can use the
repository's chosen deployment approval rules.

## Publish a version

From the reviewed release commit on main, create and push its matching tag, for example:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow refuses a tag that disagrees with either package version or points outside main's
history. After validation and packaging succeed, it creates a draft GitHub release, publishes
the npm tarball, then makes the GitHub release public. Prerelease versions use npm's `next` tag
and a GitHub prerelease; stable versions use `latest`.

A partial publication leaves the GitHub release as a draft. Inspect that run's npm result and
the attached checksums before recovery: npm versions are immutable, and the workflow refuses
to overwrite an existing release. Do not move the tag or publish a different tarball under the
same version. The manual workflow is always a build-only run, including when selected on a tag.

Runner architectures follow [GitHub's hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The app ZIP is a static site built for the `/fem-lab/` base path; the existing Pages workflow
continues to deploy main independently.
