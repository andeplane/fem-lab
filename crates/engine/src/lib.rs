//! FEM Lab engine: a headless finite-element library.
//!
//! No screen, no file system, no network, no clock of its own. Hosts (browser, CLI, server)
//! construct a `SessionOwner` and drive it through checked Commands and Queries. See `AGENTS.md`.
#![forbid(unsafe_code)]
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod command;
mod definition;
#[cfg(feature = "test-internals")]
pub mod engine;
#[cfg(not(feature = "test-internals"))]
mod engine;
pub mod error;
pub mod fem;
mod frames;
pub mod gpu;
pub mod hash;
pub mod io;
pub mod journal;
mod material_library;
pub mod mesh;
pub mod model;
pub mod par;
pub mod post;
pub mod procedure;
pub mod queries;
pub mod query;
pub mod replacement;
pub mod report;
mod retained;
pub mod session;
pub mod session_owner;
pub mod solve;
pub mod solve_run;
pub mod units;

pub use command::Command;
#[cfg(feature = "test-internals")]
pub use engine::Engine;
#[cfg(not(feature = "test-internals"))]
pub(crate) use engine::Engine;
pub use engine::{GeometrySurface, Host, NoClock, OnProgress, Progress, RenderView};
pub use error::{Error, ErrorCode, Warning};
pub use gpu::Gpu;
pub use journal::{Journal, JournalEntry, ModelFile};
pub use mesh::{BuiltMesh, ResolvedSet, SetKind};
pub use model::Model;
pub use query::{Ack, Output, Query, QueryResult};
pub use session_owner::SessionOwner;

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
