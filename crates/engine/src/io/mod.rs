//! Mesh and result writers. Every writer returns a `String` so one code path serves the CLI,
//! the browser and a server without a bytes channel; the host saves the text (plan C §3).

pub mod inp;
pub mod msh;
pub mod stl;
pub mod vtu;

pub use inp::write_inp;
pub use msh::{read_msh, write_msh};
pub use stl::{read_stl, write_stl, write_stl_mesh};
pub use vtu::{base64_decode, write_vtu};
