//! `femlab`: the command-line host of the FEM Lab engine.
//!
//! The only place in the workspace that touches the file system and the clock; the engine
//! stays headless (ADR 0011). Paths go through `std::path` so Windows works unchanged.

mod bench;
mod export;
mod mcp;
mod run;

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::export::{ExportKind, ExportOptions};

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
    /// Replay a saved Model file or a Journal and print the Model summary.
    Run {
        /// A `femlab/1` file, a Journal (array of entries) or an array of Commands.
        file: PathBuf,
        /// Print the per-entry Model hashes instead of the summary.
        #[arg(long)]
        hashes: bool,
        /// Append solve.run / study.converge entries without running them.
        #[arg(long)]
        skip_solves: bool,
        /// Compare every recorded hash with the recomputed one; exit 3 on the first mismatch.
        #[arg(long)]
        verify: bool,
        /// Print the Journal as a TypeScript script.
        #[arg(long)]
        as_script: bool,
        /// Print the replayed Journal (entries with their hashes) as JSON; turns a list of
        /// Commands into a verifiable Journal fixture.
        #[arg(long)]
        journal: bool,
        /// Print the summary as JSON.
        #[arg(long)]
        json: bool,
        /// CPU threads for the engine (default: all cores).
        #[arg(long)]
        threads: Option<usize>,
        /// Do not request a GPU.
        #[arg(long)]
        cpu: bool,
    },
    /// Run the Benchmark cases (Journal + checks) and report.
    Bench {
        /// Directory of `*.json` cases (default: built-in cases packaged in this executable).
        #[arg(long)]
        cases: Option<PathBuf>,
        /// Only cases whose name contains this text.
        #[arg(long)]
        filter: Option<String>,
        /// Print results as JSON.
        #[arg(long)]
        json: bool,
        /// Print a Markdown status table.
        #[arg(long)]
        markdown: bool,
        /// Rewrite the `<!-- bench:start -->` … `<!-- bench:end -->` block of this Markdown
        /// file with the status table (docs/BENCHMARKS.md).
        #[arg(long)]
        update_docs: Option<PathBuf>,
        #[arg(long)]
        threads: Option<usize>,
        /// Do not request a GPU.
        #[arg(long)]
        cpu: bool,
    },
    /// Replay a file and write one export: mesh, calculation note, script or model file.
    Export {
        /// A `femlab/1` file, a Journal (array of entries) or an array of Commands.
        file: PathBuf,
        /// What to write.
        #[arg(long, value_enum)]
        format: ExportKind,
        /// The Step whose Result the export carries (default: the last solved one, and every
        /// solved one for the calculation note).
        #[arg(long)]
        step: Option<String>,
        /// Write here instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Replay solve.run / study.converge without running them.
        #[arg(long)]
        skip_solves: bool,
        /// CPU threads for the engine (default: all cores).
        #[arg(long)]
        threads: Option<usize>,
        /// Do not request a GPU.
        #[arg(long)]
        cpu: bool,
    },
    /// Print the schema document (Commands, Queries, responses) as JSON.
    Schema {
        /// Write to this path instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Compare with `--out` and exit 1 if it differs (for CI).
        #[arg(long)]
        check: bool,
    },
    /// Serve the engine over the wire protocol (planned, phase S).
    Serve {
        #[arg(long, default_value_t = 7777)]
        port: u16,
    },
    /// Speak MCP over stdio: every Command and Query as a tool, for Claude Code and friends.
    Mcp {
        /// The folder `export_file` may write into and the server may read from.
        #[arg(long)]
        project: Option<PathBuf>,
    },
}

fn main() {
    let cli = Cli::parse();
    let code = match cli.cmd {
        Cmd::Version => {
            println!(
                "femlab {} (engine {}, geometry {})",
                env!("CARGO_PKG_VERSION"),
                femlab_engine::version(),
                femlab_geometry::version()
            );
            0
        }
        Cmd::Run { file, hashes, skip_solves, verify, as_script, journal, json, threads, cpu } => {
            run::run(&file, run::RunOptions { hashes, skip_solves, verify, as_script, journal, json, threads, cpu })
        }
        Cmd::Bench { cases, filter, json, markdown, update_docs, threads, cpu } => {
            bench::bench(cases.as_deref(), filter.as_deref(), json, markdown, update_docs.as_deref(), threads, cpu)
        }
        Cmd::Export { file, format, step, out, skip_solves, threads, cpu } => {
            export::export(&file, out.as_deref(), ExportOptions { format, step, skip_solves, threads, cpu })
        }
        Cmd::Schema { out, check } => run::schema(out.as_deref(), check),
        Cmd::Serve { port } => {
            eprintln!("femlab serve (port {port}) is planned for phase S; the wire protocol is packages/registry/src/transport.ts");
            2
        }
        Cmd::Mcp { project } => mcp::mcp(project.as_deref()),
    };
    std::process::exit(code);
}
