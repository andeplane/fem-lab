//! A candidate cannot publish until replay, validation and its first snapshot all succeed.
//! Consuming builder methods drop partial state on failure; no mutable engine escapes.

use crate::session::{ExecutionContext, Stamp, StateVersion};
use crate::session_owner::{document_snapshot, DocumentSnapshot};
use crate::{Command, Engine, Error, Gpu, Host, JournalEntry, ModelFile, Progress};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementTicket {
    pub(crate) context: ExecutionContext,
    pub(crate) expected: Stamp,
    pub(crate) target: Stamp,
    pub(crate) nonce: StateVersion,
}

pub struct Candidate {
    engine: Engine,
    ticket: ReplacementTicket,
}

/// A trusted host's exact persisted UTF-8 representation. Encode the supplied complete
/// ModelFile faithfully, preserving Model, Journal, units and metadata. Do not replay a
/// second Model, estimate its size, mutate inputs or perform I/O here. Hosts use this same
/// encoding for saves; native writers can reuse PreparedCandidate::file_bytes directly.
pub trait ModelFileEncoder {
    fn encode(&mut self, file: &ModelFile) -> Result<String, Error>;
}

/// Only Candidate::finish constructs this type. The snapshot and engine cannot diverge.
pub struct PreparedCandidate {
    pub(crate) engine: Engine,
    pub(crate) ticket: ReplacementTicket,
    pub(crate) snapshot: DocumentSnapshot,
    file_text: String,
}
impl PreparedCandidate {
    pub fn snapshot(&self) -> &DocumentSnapshot {
        &self.snapshot
    }

    /// The exact validated UTF-8 file payload, including the host's whitespace and newline.
    pub fn file_bytes(&self) -> &[u8] {
        self.file_text.as_bytes()
    }
}

impl Candidate {
    /// Devices/clocks are injected by the host. The candidate is separate from the active owner.
    pub fn new(ticket: ReplacementTicket, gpu: Option<Gpu>, host: Box<dyn Host>, threads: usize) -> Self {
        Self { engine: Engine::new(gpu, host, threads), ticket }
    }

    /// Bundled/project Commands build only this private candidate. A failure consumes it.
    pub async fn commands(
        mut self,
        commands: Vec<Command>,
        progress: &mut dyn FnMut(Progress) -> bool,
    ) -> Result<Self, Error> {
        let offset = self.engine.journal().len();
        let count = commands.len();
        for (index, command) in commands.into_iter().enumerate() {
            if !progress(Progress {
                phase: "replay",
                fraction: index as f64 / count as f64,
                message: format!("Preparing command {}", index + 1),
            }) {
                return Err(Error::cancelled());
            }
            if offset + index > 0 && matches!(command, Command::ModelNew { .. }) {
                return Err(Error::schema("model.new may only initialize a replacement Journal")
                    .at(format!("journal[{index}]")));
            }
            self.engine.dispatch(command, progress).await?;
        }
        Ok(self)
    }

    /// Reconstruct a saved Journal and check each recorded hash, in its own engine.
    pub async fn journal(self, entries: Vec<JournalEntry>, skip_solves: bool) -> Result<Self, Error> {
        self.replay(entries, skip_solves, true).await
    }

    /// Batch inputs without recorded hashes may disable hash comparison. Validation and
    /// execution still occur only inside this private candidate, never against the live owner.
    pub async fn replay(mut self, entries: Vec<JournalEntry>, skip_solves: bool, verify: bool) -> Result<Self, Error> {
        check_entries(&entries)?;
        self.engine.replay(&entries, skip_solves, verify).await?;
        Ok(self)
    }

    /// A Model snapshot is accepted only if its Journal reconstructs exactly those inputs.
    pub async fn file(self, file: ModelFile) -> Result<Self, Error> {
        self.file_with_options(file, true, true).await
    }

    /// A batch host may recompute solves or omit historical hash verification. The supplied
    /// Model must still match the replayed Journal before the candidate can be published.
    pub async fn file_with_options(mut self, file: ModelFile, skip_solves: bool, verify: bool) -> Result<Self, Error> {
        if file.format != crate::journal::FILE_FORMAT {
            return Err(Error::schema("unknown Model file format").at("format"));
        }
        check_entries(&file.journal.entries)?;
        self.engine.replay(&file.journal.entries, skip_solves, verify).await?;
        if self.engine.model_hash() != crate::hash::model_hash(&file.model) {
            return Err(Error::schema("Model snapshot and Journal describe different models")
                .at("model")
                .suggest("open a consistent file exported by file.save"));
        }
        Ok(self)
    }

    /// Restore a complete retained solve cache without re-running any procedure. All input
    /// validation happens in this private candidate; a failed archive cannot affect its owner.
    pub async fn project(self, project: crate::portable::PortableProject) -> Result<Self, Error> {
        project.validate()?;
        let mut candidate = self.file(project.file.clone()).await?;
        candidate.engine.install_portable_results(project)?;
        Ok(candidate)
    }

    /// Snapshot once, encode the actual file once and enforce the injected host byte budget
    /// before making it committable. Equality is allowed. Any failure consumes the candidate;
    /// the host abandons its ticket while the active owner and producer remain unchanged.
    pub fn finish(
        mut self,
        encoder: &mut dyn ModelFileEncoder,
        max_file_bytes: usize,
    ) -> Result<PreparedCandidate, Error> {
        document_snapshot(&mut self.engine, self.ticket.target.clone()).and_then(|snapshot| {
            let file_text = encoder.encode(&snapshot.file)?;
            if file_text.len() > max_file_bytes {
                return Err(Error::schema(format!(
                    "prepared Model file is {} UTF-8 bytes, exceeding the {max_file_bytes}-byte host limit",
                    file_text.len()
                ))
                .at("file")
                .suggest("reduce the Model or Journal before publication or file.save"));
            }
            Ok(PreparedCandidate { engine: self.engine, ticket: self.ticket, snapshot, file_text })
        })
    }
}

fn check_entries(entries: &[JournalEntry]) -> Result<(), Error> {
    for (index, entry) in entries.iter().enumerate() {
        if entry.seq as usize != index {
            return Err(Error::schema("Journal sequence numbers must be consecutive from zero")
                .at(format!("journal.entries[{index}].seq")));
        }
        if index > 0 && matches!(entry.cmd, Command::ModelNew { .. }) {
            return Err(Error::schema("model.new may only initialize a replacement Journal")
                .at(format!("journal.entries[{index}].cmd")));
        }
    }
    Ok(())
}
