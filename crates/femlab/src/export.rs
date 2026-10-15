//! `femlab export`: replay a file and write one artefact — the same exporters the app's Export
//! dialog offers, with no browser (plan B §6).

use std::path::Path;

use clap::ValueEnum;
use femlab_engine::command::ExportFormat;
use femlab_engine::query::{Output, Query, QueryResult};
use femlab_engine::Command;

use crate::run::{bounded_model_file_text, dispatch, new_engine, read_input};

/// What `--format` accepts. The five the engine writes go through `mesh.export`; the other two
/// are reads of the Journal itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ExportKind {
    /// VTK XML UnstructuredGrid: the mesh with the Step's nodal fields. Opens in ParaView.
    Vtu,
    /// Gmsh 4.1 ASCII mesh with the Sets as physical names.
    Msh,
    /// Abaqus/CalculiX input deck, for the cross-check.
    Inp,
    /// ASCII STL of the mesh boundary surface.
    Stl,
    /// The Markdown calculation note (`query.report`).
    Report,
    /// The Journal as a TypeScript script against the `fem` API.
    Script,
    /// The `femlab/1` model file: Model plus Journal, at most 16 MiB including pretty JSON and LF.
    Journal,
}

impl ExportKind {
    /// The `mesh.export` format this kind is, when it is one.
    fn engine_format(self) -> Option<ExportFormat> {
        match self {
            ExportKind::Vtu => Some(ExportFormat::Vtu),
            ExportKind::Msh => Some(ExportFormat::Msh),
            ExportKind::Inp => Some(ExportFormat::Inp),
            ExportKind::Stl => Some(ExportFormat::Stl),
            ExportKind::Report => Some(ExportFormat::Report),
            ExportKind::Script | ExportKind::Journal => None,
        }
    }
}

pub struct ExportOptions {
    pub format: ExportKind,
    pub step: Option<String>,
    pub skip_solves: bool,
    pub threads: Option<usize>,
    pub cpu: bool,
}

/// Replay `file`, then write the artefact to `out` (or stdout). Exit code, like every other
/// subcommand: 0 fine, 1 the file could not be read, replayed or written.
pub fn export(file: &Path, out: Option<&Path>, opts: ExportOptions) -> i32 {
    let input = match read_input(file) {
        Ok(x) => x,
        Err(code) => return code,
    };
    let mut engine = new_engine(opts.threads, opts.cpu);
    if let Err(e) = pollster::block_on(engine.load(input, opts.skip_solves, true)) {
        eprintln!("{}", serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()));
        return 1;
    }
    let text = match opts.format.engine_format() {
        None => match engine.query(Query::Document {}) {
            Ok(QueryResult::Document(document)) if opts.format == ExportKind::Script => {
                document.file.journal.as_script(&document.file.engine_version)
            }
            Ok(QueryResult::Document(document)) => match bounded_model_file_text(&document.file) {
                Ok(text) => text,
                Err(error) => {
                    eprintln!("{}", serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()));
                    return 1;
                }
            },
            Err(error) => {
                eprintln!("{}", serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()));
                return 1;
            }
            Ok(_) => {
                let error = femlab_engine::Error::new(
                    femlab_engine::ErrorCode::Internal,
                    "query.document did not return a Model document",
                )
                .at("query.document");
                eprintln!("{}", serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()));
                return 1;
            }
        },
        Some(format) => match dispatch(&mut engine, Command::MeshExport { format, step: opts.step }) {
            Ok(ack) => match ack.output {
                Output::Export { text, .. } => text,
                other => {
                    eprintln!("mesh.export answered {other:?}, which is not a file");
                    return 1;
                }
            },
            Err(e) => {
                eprintln!("{}", serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()));
                return 1;
            }
        },
    };
    match out {
        Some(p) => match std::fs::write(p, &text) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("cannot write {}: {e}", p.display());
                1
            }
        },
        None => {
            print!("{text}");
            0
        }
    }
}
