//! GPU kernel tests: run on a real adapter (Metal locally, Mesa lavapipe in CI). Compiled only
//! with `--features gpu-tests`; a missing adapter is a hard failure, never a skip, so coverage
//! of `src/gpu/` cannot silently drop.
#![cfg(feature = "gpu-tests")]

use femlab_engine::gpu::{Gpu, MAX_WORKGROUPS, WORKGROUP};
use femlab_engine::{Engine, ErrorCode, NoClock, Query, QueryResult};

fn gpu() -> Gpu {
    pollster::block_on(Gpu::request(Gpu::default_backends())).expect("a GPU adapter is required for gpu-tests")
}

fn data(n: usize, seed: f64) -> (Vec<f32>, Vec<f32>) {
    let a: Vec<f32> = (0..n).map(|i| (libm::sin(i as f64 * 0.37 + seed) * 10.0) as f32).collect();
    let b: Vec<f32> = (0..n).map(|i| (libm::cos(i as f64 * 0.11 - seed) + 0.5) as f32).collect();
    (a, b)
}

fn dot_f64(a: &[f32], b: &[f32]) -> (f64, f64) {
    let mut s = 0.0;
    let mut abs = 0.0;
    for i in 0..a.len() {
        let p = a[i] as f64 * b[i] as f64;
        s += p;
        abs += p.abs();
    }
    (s, abs)
}

#[test]
fn dot_matches_f64_within_f32_rounding_and_is_bit_identical() {
    let mut g = gpu();
    assert!(!g.adapter.is_empty());
    assert!(format!("{g:?}").starts_with("Gpu("));
    for n in [1usize, 7, 255, 256, 257, 4096, 100_000, (MAX_WORKGROUPS as usize + 3) * WORKGROUP as usize] {
        let (a, b) = data(n, 0.3);
        let got = pollster::block_on(g.dot(&a, &b)).unwrap();
        let (exact, abs) = dot_f64(&a, &b);
        let bound = 32.0 * f32::EPSILON as f64 * abs + 1e-30;
        assert!((got as f64 - exact).abs() <= bound, "n = {n}: gpu {got} vs f64 {exact} (bound {bound:e})");
        let again = pollster::block_on(g.dot(&a, &b)).unwrap();
        assert_eq!(got.to_bits(), again.to_bits(), "n = {n}: not deterministic");
    }
    assert_eq!(pollster::block_on(g.dot(&[], &[])).unwrap(), 0.0);
    let e = pollster::block_on(g.dot(&[1.0], &[1.0, 2.0])).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
}

#[test]
fn grid_is_always_2d_and_capped() {
    assert_eq!(Gpu::grid(1), (1, [1, 1]));
    assert_eq!(Gpu::grid(256 * 10), (10, [10, 1]));
    assert_eq!(Gpu::grid(256 * 100_000), (MAX_WORKGROUPS, [MAX_WORKGROUPS, 1]));
}

#[test]
fn broken_shaders_and_tiny_limits_are_structured_errors() {
    let mut g = gpu();
    let e = pollster::block_on(g.compile("broken", "fn nope( {", "nope")).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuShader);
    assert!(e.where_.as_deref().unwrap().contains("broken"));
    let e = pollster::block_on(g.pipeline("missing.wgsl", "x")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    // a real shader with an entry point it does not have
    let e = pollster::block_on(g.pipeline("dot.wgsl", "nope")).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuShader);
    // the pipeline cache returns the same pipeline twice
    let p1 = pollster::block_on(g.pipeline("dot.wgsl", "dot_final")).unwrap().clone();
    let p2 = pollster::block_on(g.pipeline("dot.wgsl", "dot_final")).unwrap().clone();
    assert_eq!(p1, p2);
    g.limits.max_buffer_size = 1024;
    g.limits.max_storage_buffer_binding_size = 1024;
    assert_eq!(g.max_buffer_bytes(), 1024);
    let (a, b) = data(10_000, 0.1);
    let e = pollster::block_on(g.dot(&a, &b)).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("40000 bytes"));
    assert!(g.check_size("x", 1024).is_ok());
    // reading past the end of a buffer is a validation error, caught by the scope, never a panic
    let small = g.buffer_f32("small", &[1.0, 2.0], wgpu::BufferUsages::COPY_SRC);
    let e = pollster::block_on(g.read_back(&small, 64)).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    assert!(e.cause.contains("64 bytes"));
    assert_eq!(pollster::block_on(g.read_back(&small, 8)).unwrap(), bytemuck::cast_slice::<f32, u8>(&[1.0, 2.0]));
    // an adapter below WebGPU's guaranteed workgroup size cannot run the kernels
    g.limits.max_compute_invocations_per_workgroup = WORKGROUP - 1;
    let e = pollster::block_on(g.dot(&[1.0], &[1.0])).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("255"));
}

#[test]
fn engine_reports_the_adapter_in_capabilities() {
    let g = gpu();
    let name = g.adapter.clone();
    let mut e = Engine::new(Some(g), Box::new(NoClock), 1);
    let QueryResult::Capabilities(c) = e.query(Query::Capabilities {}).unwrap() else { panic!() };
    assert!(c.gpu);
    assert_eq!(c.adapter.as_deref(), Some(name.as_str()));
    assert!(e.gpu().is_some());
    assert!(e.gpu_mut().is_some());
    let mut e2 = Engine::new(None, Box::new(NoClock), 1);
    let QueryResult::Capabilities(c) = e2.query(Query::Capabilities {}).unwrap() else { panic!() };
    assert!(!c.gpu && c.adapter.is_none());
}

#[test]
fn requesting_a_backend_nobody_has_is_an_error() {
    let e = pollster::block_on(Gpu::request(wgpu::Backends::empty())).unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.cause.contains("no GPU adapter"));
    let e = pollster::block_on(Gpu::request_with(Gpu::default_backends(), wgpu::Features::all())).unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.cause.contains("device request failed"));
}
