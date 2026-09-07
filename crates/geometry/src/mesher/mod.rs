//! Meshers: everything that produces a [`crate::Mesh`].

pub mod free2d;
pub mod lattice;
pub mod line;
pub mod mapped;
pub mod structured;
pub mod sweep;

pub use free2d::{free, free_sheet, RefineBox};
pub use lattice::lattice;
pub use line::line;
pub use mapped::{mapped, Curve, QuadBlock};
pub use structured::{annulus, elliptic_annulus, perturb_interior, split_to_simplices, Structured};
pub use sweep::{extrude, revolve};
