//! `femlab`: the command-line host of the FEM Lab engine.
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "femlab", version, about = "FEM Lab command-line host")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print engine and geometry crate versions.
    Version,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Version => {
            println!(
                "femlab {} (engine {}, geometry {})",
                env!("CARGO_PKG_VERSION"),
                femlab_engine::version(),
                femlab_geometry::version()
            );
        }
    }
    Ok(())
}
