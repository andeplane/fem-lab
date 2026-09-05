//! FEM Lab engine: a headless finite-element library.
//!
//! No screen, no file system, no network, no clock of its own. Hosts (browser, CLI, server)
//! construct an `Engine` and drive it through Commands and Queries. See `AGENTS.md`.
#![forbid(unsafe_code)]
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod error;
pub mod par;
pub mod units;

pub use error::{Error, ErrorCode, Warning};

/// Engine version, reported by `query.capabilities` and written into saved files.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_semver() {
        assert_eq!(super::version().split('.').count(), 3);
    }
}
