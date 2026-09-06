//! Geometry, meshes and meshers for FEM Lab.
//!
//! A standalone library with no I/O: shapes, solids, sketches, predicates, the `Mesh`
//! type shared with the engine, and the meshers that produce it. Everything is SI `f64`.
#![forbid(unsafe_code)]
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod mesh;
pub mod mesher;
pub mod predicate;
pub mod quality;
pub mod shape;
pub mod sketch;
pub mod solid;

pub use mesh::{merge_coincident, Adjacency, ElementBlock, ElementKind, Face, FaceKind, Mesh, Surface};
pub use mesher::{
    annulus, elliptic_annulus, extrude, free, lattice, line, mapped, perturb_interior, revolve, split_to_simplices,
    Curve, QuadBlock, RefineBox, Structured,
};
pub use predicate::{
    elem_centroid, face_centroid_normal, nearest_boundary_face, resolve_face_set, resolve_region, FacePredicate,
    RegionPredicate,
};
pub use quality::{quality, Quality};
pub use shape::{Affine3, Shape};
pub use sketch::{Segment, Sketch, SketchError};
pub use solid::{Solid, TriMesh};

/// A geometry failure with a one-line, user-readable cause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeomError(pub String);

impl std::fmt::Display for GeomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GeomError {}

/// Crate version, for hosts that report it.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_semver_and_error_displays() {
        assert_eq!(super::version().split('.').count(), 3);
        assert_eq!(super::GeomError("x".into()).to_string(), "x");
    }
}
