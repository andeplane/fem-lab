# Release publication (#27)

Before publishing femlab-mcp, verify its tarball can install and run outside this checkout.
Child #304 owns packaged Node WASM, runtime dependency metadata and the isolated npm artifact
smoke test. Its PR closes only #304.

The rest of #27 remains release work: tag-triggered builds of WASM, the app and native CLI
binaries for macOS, Linux and Windows; publish Rust crates in dependency order and the validated
npm artifact; attach binaries and checksums to the GitHub release. Package versions and tag
must agree, CI and independent review must be green, and publishing must use available
repository credentials or trusted publishing configuration. A successful dry run does not
prove that registry publication or a tagged release has happened.
