//! wasm-bindgen surface of the FEM Lab engine. Thin: JSON in, JSON out, typed arrays for bulk.
use wasm_bindgen::prelude::*;

/// Engine version string.
#[wasm_bindgen]
pub fn version() -> String {
    femlab_engine::version().to_string()
}
