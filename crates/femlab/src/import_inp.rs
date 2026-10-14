//! A thin disk host for query.convertAbaqus. Conversion never solves; only its portable
//! Commands reach the existing private Candidate, and output is an ordinary femlab/1 file.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use femlab_engine::query::{Query, QueryResult};
use femlab_engine::{Error, ErrorCode};

const MAX_BYTES: usize = 16 * 1024 * 1024;

fn io_error(error: std::io::Error) -> Error {
    Error::new(ErrorCode::Internal, error.to_string())
}

pub struct ImportOptions {
    pub name: String,
    pub body: String,
    pub mode: String,
    pub unit_length: String,
    pub unit_force: Option<String>,
    pub threads: Option<usize>,
    pub cpu: bool,
}

fn input(file: &Path) -> Result<(String, String), Error> {
    let extension = file.extension().and_then(|part| part.to_str()).unwrap_or("");
    if extension.eq_ignore_ascii_case("odb") {
        return Err(Error::new(
            ErrorCode::Unsupported,
            ".odb is a binary Abaqus results database; only UTF-8 text .inp model decks can be imported",
        )
        .at("file")
        .suggest("export a flat one-Body C3D4/C3D8 .inp deck from Abaqus"));
    }
    if extension.eq_ignore_ascii_case("cae") {
        return Err(Error::new(
            ErrorCode::Unsupported,
            ".cae is an Abaqus model database; only UTF-8 text .inp model decks can be imported",
        )
        .at("file")
        .suggest("export a flat one-Body C3D4/C3D8 .inp deck from Abaqus"));
    }
    let source = File::open(file).map_err(|error| Error::new(ErrorCode::FileNotFound, error.to_string()).at("file"))?;
    let size = source.metadata().map_err(|error| io_error(error).at("file"))?.len();
    if size > MAX_BYTES as u64 {
        return Err(Error::schema("Abaqus input exceeds the 16 MiB limit").at("text"));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    source.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|error| io_error(error).at("file"))?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::schema("Abaqus input exceeds the 16 MiB limit").at("text"));
    }
    let sha256 = femlab_engine::hash::sha256_hex(&bytes);
    let text =
        String::from_utf8(bytes).map_err(|_| Error::schema("Abaqus input is not valid UTF-8 text").at("text"))?;
    Ok((text, sha256))
}

/// Write then rename inside the output directory. A failed write never truncates a prior file.
fn save(file: &Path, bytes: &[u8]) -> Result<(), Error> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = file.file_name().ok_or_else(|| Error::schema("output must name a file").at("out"))?;
    let temporary = file.parent().unwrap_or(Path::new(".")).join(format!(
        ".{}.femlab-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut output =
        OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| io_error(error).at("out"))?;
    let written = output.write_all(bytes).and_then(|()| output.sync_all());
    drop(output);
    let completed = written.and_then(|()| std::fs::rename(&temporary, file));
    if completed.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    completed.map_err(|error| io_error(error).at("out"))
}

fn convert(
    file: &Path,
    out: &Path,
    options: ImportOptions,
) -> Result<femlab_engine::query::AbaqusConversionReport, Error> {
    // Capture this invocation's owner before disk reading. No global active-engine factory exists.
    let mut engine = crate::run::new_engine(options.threads, options.cpu);
    let (text, sha256) = input(file)?;
    let mut request = serde_json::json!({
        "query": "query.convertAbaqus", "text": text, "sha256": sha256,
        "name": options.name, "body": options.body, "mode": options.mode,
        "unitLength": options.unit_length,
    });
    if let Some(force) = options.unit_force {
        request["unitForce"] = force.into();
    }
    // The engine's schema validates Quantities and mode; this host has no parallel unit/parser rules.
    let query: Query = serde_json::from_value(request).map_err(Error::from)?;
    let conversion = match engine.query(query)? {
        QueryResult::AbaqusConversion(conversion) => conversion,
        _ => return Err(Error::new(ErrorCode::Internal, "Abaqus conversion returned an unexpected response")),
    };
    let (_, bytes) = pollster::block_on(engine.replace_commands(conversion.commands))?;
    // These are the exact pretty-2 + LF bytes validated before Candidate publication.
    save(out, &bytes)?;
    Ok(conversion.report)
}

pub fn import(file: &Path, out: &Path, options: ImportOptions) -> i32 {
    match convert(file, out, options) {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
            0
        }
        Err(error) => {
            eprintln!("{}", serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()));
            1
        }
    }
}
