//! Meshers: everything that produces a [`crate::Mesh`].

pub mod lattice;
pub mod structured;

pub use lattice::lattice;
pub use structured::{annulus, elliptic_annulus, perturb_interior, split_to_simplices, Structured};
