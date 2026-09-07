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

/// Only Candidate::finish constructs this type. The snapshot and engine cannot diverge.
pub struct PreparedCandidate {
    pub(crate) engine: Engine,
    pub(crate) ticket: ReplacementTicket,
    pub(crate) snapshot: DocumentSnapshot,
}
impl PreparedCandidate {
    pub fn snapshot(&self) -> &DocumentSnapshot {
        &self.snapshot
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
    pub async fn journal(mut self, entries: Vec<JournalEntry>, skip_solves: bool) -> Result<Self, Error> {
        check_entries(&entries)?;
        self.engine.replay(&entries, skip_solves, true).await?;
        Ok(self)
    }

    /// A Model snapshot is accepted only if its Journal reconstructs exactly those inputs.
    pub async fn file(mut self, file: ModelFile) -> Result<Self, Error> {
        if file.format != crate::journal::FILE_FORMAT {
            return Err(Error::schema("unknown Model file format").at("format"));
        }
        check_entries(&file.journal.entries)?;
        self.engine.replay(&file.journal.entries, true, true).await?;
        if self.engine.model_hash() != crate::hash::model_hash(&file.model) {
            return Err(Error::schema("Model snapshot and Journal describe different models")
                .at("model")
                .suggest("open a consistent file exported by file.save"));
        }
        Ok(self)
    }

    pub fn finish(mut self) -> Result<PreparedCandidate, Error> {
        let snapshot = document_snapshot(&mut self.engine, self.ticket.target.clone())?;
        Ok(PreparedCandidate { engine: self.engine, ticket: self.ticket, snapshot })
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
