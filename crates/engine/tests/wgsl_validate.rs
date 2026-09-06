//! Every shader in `gpu::SHADERS` parses and validates with naga, without a GPU; a broken
//! shader fails, so the validator itself is tested.

use femlab_engine::gpu::SHADERS;

fn validate(src: &str) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(src).map_err(|e| e.emit_to_string(src))?;
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

#[test]
fn every_shader_validates() {
    assert!(!SHADERS.is_empty());
    for (name, src) in SHADERS {
        validate(src).unwrap_or_else(|e| panic!("{name}: {e}"));
        // the entry points the engine uses are present
        assert!(src.contains("@compute"), "{name} has no compute entry point");
    }
}

#[test]
fn a_broken_shader_is_rejected() {
    assert!(validate("fn broken( { }").is_err());
    // valid syntax, invalid semantics: assigning to a read-only buffer
    let bad =
        "@group(0) @binding(0) var<storage, read> a: array<f32>;\n@compute @workgroup_size(1) fn f() { a[0] = 1.0; }";
    assert!(validate(bad).is_err());
}

/// The engine runs without a device (no `gpu-tests` needed): both accessors report `None`.
#[test]
fn an_engine_without_a_device_has_no_gpu() {
    let mut e = femlab_engine::Engine::new(None, Box::new(femlab_engine::NoClock), 1);
    assert!(e.gpu().is_none());
    assert!(e.gpu_mut().is_none());
}
