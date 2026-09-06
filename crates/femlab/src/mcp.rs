//! `femlab mcp`: hand stdio to the Node MCP server in `packages/mcp`.
//!
//! The server itself is TypeScript because the MCP SDK is (ADR 0012, plan B §4): it speaks the
//! registry's own tool definitions over `@femlab/registry` and runs the engine's wasm build. The
//! Rust CLI keeps the entry point, so `femlab mcp` is one command whether or not the person has
//! the npm package, and says how to get it when they do not.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The built server. `FEMLAB_MCP` is the whole answer when it is set — an explicit override that
/// points at nothing should say so, not quietly run a different server — and otherwise the search
/// is next to this binary, then the repository checkout it was built in
/// (`target/<profile>/femlab` → `packages/mcp/dist`).
fn locate() -> Option<PathBuf> {
    if let Some(from_env) = std::env::var_os("FEMLAB_MCP") {
        return Some(PathBuf::from(from_env)).filter(|p| p.is_file());
    }
    let dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf))?;
    [
        dir.join("femlab-mcp.js"),
        dir.join("..").join("..").join("packages").join("mcp").join("dist").join("femlab-mcp.js"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// Run the server with this process's stdio, or explain how to install it and exit 2.
pub fn mcp(project: Option<&Path>) -> i32 {
    let Some(server) = locate() else {
        eprintln!(
            "femlab mcp needs the Node server from packages/mcp, which is not installed here.\n\
             Run it directly with `npx femlab-mcp --project <dir>`, or build it in a checkout with\n\
             `npm ci && npm run build -w packages/mcp && node tools/build-wasm.mjs`, then point\n\
             FEMLAB_MCP at packages/mcp/dist/femlab-mcp.js."
        );
        return 2;
    };
    let mut cmd = Command::new("node");
    cmd.arg(&server);
    if let Some(dir) = project {
        cmd.arg("--project").arg(dir);
    }
    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("cannot run node {}: {e}", server.display());
            2
        }
    }
}
