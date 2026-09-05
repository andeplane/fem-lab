//! Mesh and result writers. Every writer returns a `String` so one code path serves the CLI,
//! the browser and a server without a bytes channel; the host saves the text (plan C §3).

pub mod vtu;

pub use vtu::write_vtu;
