//! FEM Lab engine: a headless finite-element library.
//!
//! No screen, no file system, no network, no clock of its own. Hosts (browser, CLI, server)
//! construct an `Engine` and drive it through Commands and Queries. See `AGENTS.md`.
#![forbid(unsafe_code)]
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod command;
pub mod engine;
pub mod error;
pub mod fem;
pub mod hash;
pub mod journal;
pub mod model;
pub mod par;
pub mod queries;
pub mod query;
pub mod units;

pub use command::Command;
pub use engine::{Engine, Host, NoClock, OnProgress, Progress};
pub use error::{Error, ErrorCode, Warning};
pub use journal::{Journal, JournalEntry, ModelFile};
pub use model::Model;
pub use query::{Ack, Output, Query, QueryResult};

/// Engine version, reported by `query.capabilities` and written into saved files.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Schema version: bump when a Command or Query changes shape.
pub const SCHEMA_VERSION: &str = "1";

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_semver() {
        assert_eq!(super::version().split('.').count(), 3);
    }
}
