//! Meshers: everything that produces a [`crate::Mesh`].

pub mod free2d;
pub mod lattice;
pub mod mapped;
pub mod structured;
pub mod sweep;

pub use free2d::{free, RefineBox};
pub use lattice::lattice;
pub use mapped::{mapped, Curve, QuadBlock};
pub use structured::{annulus, elliptic_annulus, perturb_interior, split_to_simplices, Structured};
pub use sweep::{extrude, revolve};
