use base64::{engine::general_purpose::STANDARD, Engine};
use femlab_project_io::{Project, MAX_WRITE_BYTES};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Stat { path: String },
    Read { path: String },
    Write { path: String, data: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    code: &'static str,
    cause: String,
    r#where: &'static str,
    suggestion: &'static str,
}
fn failure(error: io::Error) -> Failure {
    let code = if error.kind() == io::ErrorKind::NotFound { "file.not-found" } else { "file.scope" };
    Failure {
        code,
        cause: error.to_string(),
        r#where: "path",
        suggestion: "use a regular file inside the configured project folder",
    }
}
fn run(project: &Project, request: Request) -> io::Result<serde_json::Value> {
    match request {
        Request::Stat { path } => Ok(serde_json::json!({ "size": project.prepare(&path, false)?.size()? })),
        Request::Read { path } => {
            Ok(serde_json::json!({ "data": STANDARD.encode(project.prepare(&path, false)?.read()?) }))
        }
        Request::Write { path, data } => {
            let bytes = STANDARD.decode(data).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            if bytes.len() > MAX_WRITE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "export exceeds the 64 MiB host transfer limit",
                ));
            }
            project.prepare(&path, true)?.write(&bytes)?;
            Ok(serde_json::json!({ "bytes": bytes.len() }))
        }
    }
}
fn main() -> io::Result<()> {
    let root = std::env::args_os()
        .nth(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "project root required"))?;
    let project = Project::open(std::path::Path::new(&root));
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let project = match project {
        Ok(project) => {
            writeln!(output, "{{\"ready\":true}}")?;
            output.flush()?;
            project
        }
        Err(error) => {
            writeln!(output, "{}", serde_json::json!({"error":failure(error)}))?;
            return Ok(());
        }
    };
    let mut input = io::stdin().lock();
    loop {
        // Base64 plus JSON has bounded expansion; malformed oversized IPC never allocates
        // an arbitrary line. EOF releases the captured directory and all file handles.
        let mut line = Vec::new();
        let read = input.by_ref().take((MAX_WRITE_BYTES * 2 + 1) as u64).read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(());
        }
        if line.len() > MAX_WRITE_BYTES * 2 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "IPC request too large"));
        }
        let result = serde_json::from_slice(&line)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
            .and_then(|request| run(&project, request));
        let reply = match result {
            Ok(value) => value,
            Err(error) => serde_json::json!({"error":failure(error)}),
        };
        writeln!(output, "{reply}")?;
        output.flush()?;
    }
}
