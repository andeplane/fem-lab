//! Model hashing: sha256 of the canonical JSON. Only Model parameters are hashed (inputs,
//! never meshes or Results), so native and wasm agree byte-for-byte.

use sha2::{Digest, Sha256};

use crate::model::Model;

/// Hex sha256 of the Model's JSON.
pub fn model_hash(model: &Model) -> String {
    let bytes = serde_json::to_vec(model).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

/// Identity used only to decide whether a cached Result still matches its inputs. The display
/// name cannot affect a solve; every other Model field remains part of this conservative key.
/// The full Model hash above remains unchanged for Journal replay and exported files (ADR 0015).
pub(crate) fn result_hash(model: &Model) -> String {
    let mut inputs = model.clone();
    inputs.name.clear();
    model_hash(&inputs)
}

/// Hex sha256 of arbitrary bytes (plugin sources, blobs).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_changes_with_the_model() {
        let a = Model::new("a");
        let h1 = model_hash(&a);
        assert_eq!(h1.len(), 64);
        assert_eq!(h1, model_hash(&a.clone()));
        assert_ne!(h1, model_hash(&Model::new("b")));
        assert_eq!(result_hash(&a), result_hash(&Model::new("b")));
        let mut changed = a.clone();
        changed.description = Some("a conservative metadata edit".into());
        assert_ne!(result_hash(&a), result_hash(&changed));
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
