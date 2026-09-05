//! Meshers: everything that produces a [`crate::Mesh`].

pub mod structured;

pub use structured::{annulus, elliptic_annulus, perturb_interior, split_to_simplices, Structured};
