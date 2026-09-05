//! Finite-element kernels: quadrature, shape functions and material laws (and, in later
//! commits, the isoparametric solid, loads and assembly).
//!
//! Each kernel family is an Extension Point (ADR 0010): one trait with flat `f64` slices and
//! no generic methods, so it is dyn-compatible. The built-ins (`LinearElastic`, the `Iso`
//! elements) implement the same trait through the same call path as a plugin written later in
//! TypeScript, WGSL or wasm from the schema and the doc string alone; there is no privileged
//! built-in route.

pub mod material;
pub mod quadrature;
pub mod shape;
