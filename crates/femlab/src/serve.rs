//! Launch the TypeScript host; the Rust engine never owns a socket or Python runtime.
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn serve(port: u16) -> i32 {
    let server = if let Some(explicit) = std::env::var_os("FEMLAB_SERVE") {
        Some(PathBuf::from(explicit)).filter(|path| path.is_file())
    } else {
        std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).and_then(|dir| {
            [dir.join("femlab-serve.js"), dir.join("../../packages/server/dist/femlab-serve.js")]
                .into_iter()
                .find(|path| path.is_file())
        })
    };
    let Some(server) = server else {
        eprintln!("femlab serve needs the Node registry host. Run npm run build -w packages/server and node tools/build-wasm.mjs, then set FEMLAB_SERVE to packages/server/dist/femlab-serve.js.");
        return 2;
    };
    match Command::new("node").arg(server).arg("--port").arg(port.to_string()).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("cannot run femlab serve: {error}");
            2
        }
    }
}
