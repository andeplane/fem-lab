//! Geometry, meshes and meshers for FEM Lab.
//!
//! A standalone library with no I/O: shapes, solids, sketches, predicates, the `Mesh`
//! type shared with the engine, and the meshers that produce it. Everything is SI `f64`.
#![forbid(unsafe_code)]
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

/// Crate version, for hosts that report it.
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
