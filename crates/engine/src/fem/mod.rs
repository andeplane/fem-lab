//! Finite-element kernels: quadrature, shape functions, material laws and the isoparametric
//! solid (and, in later commits, loads and assembly).
//!
//! Each kernel family is an Extension Point (ADR 0010): one trait with flat `f64` slices and
//! no generic methods, so it is dyn-compatible. The built-ins (`LinearElastic`, the `Iso`
//! elements) implement the same trait through the same call path as a plugin written later in
//! TypeScript, WGSL or wasm from the schema and the doc string alone; there is no privileged
//! built-in route.

pub mod assembly;
pub mod checks;
pub mod element;
pub mod heat;
pub mod loads;
pub mod material;
pub mod mpc;
pub mod problem;
pub mod quadrature;
pub mod shape;
