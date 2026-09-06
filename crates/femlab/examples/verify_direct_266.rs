//! Host-only replay of the verified LE10 CSR through the production Direct API (#266).
use femlab_engine::fem::assembly::Csr;
use femlab_engine::par::Pool;
use femlab_engine::solve::{direct::Direct, LinearSolve};
use std::io::Read;

fn u32_le(input: &mut &[u8]) -> u32 {
    let mut bytes = [0; 4];
    input.read_exact(&mut bytes).unwrap();
    u32::from_le_bytes(bytes)
}
fn u64_le(input: &mut &[u8]) -> u64 {
    let mut bytes = [0; 8];
    input.read_exact(&mut bytes).unwrap();
    u64::from_le_bytes(bytes)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(args.get(1).expect("verify_direct_266 <matrix.csr> [threads]")).unwrap();
    let threads = args
        .get(2)
        .map_or_else(|| std::thread::available_parallelism().unwrap().get(), |value| value.parse::<usize>().unwrap());
    assert_eq!(&bytes[..8], b"FEM266K1");
    let mut input = &bytes[8..];
    let n = u64_le(&mut input) as usize;
    let nnz = u64_le(&mut input) as usize;
    assert_eq!(bytes.len(), 24 + 4 * (n + 1) + 12 * nnz + 16 * n);
    let row_ptr = (0..=n).map(|_| u32_le(&mut input)).collect();
    let col_idx = (0..nnz).map(|_| u32_le(&mut input)).collect();
    let vals = (0..nnz).map(|_| f64::from_bits(u64_le(&mut input))).collect();
    let rhs: Vec<f64> = (0..n).map(|_| f64::from_bits(u64_le(&mut input))).collect();
    let reference: Vec<f64> = (0..n).map(|_| f64::from_bits(u64_le(&mut input))).collect();
    assert!(input.is_empty());
    println!(
        "production Direct os={} arch={} threads={threads} n={n} nnz={nnz}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    #[cfg(target_arch = "x86_64")]
    println!(
        "avx512f={} avx2={} fma={}",
        std::arch::is_x86_feature_detected!("avx512f"),
        std::arch::is_x86_feature_detected!("avx2"),
        std::arch::is_x86_feature_detected!("fma")
    );
    let k = Csr { n, row_ptr, col_idx, vals };
    // Reusable factor owns its storage after its temporary construction pool and scratch die.
    let mut factor = Pool::new(threads).install(|| Direct::factor(&k)).unwrap();
    let mut answer = vec![0.0; n];
    let info = factor.solve(&rhs, &mut answer).unwrap();
    let (mut r2, mut b2, mut d2, mut x2) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        let mut r = 0.0;
        for slot in k.row_ptr[i] as usize..k.row_ptr[i + 1] as usize {
            r += k.vals[slot] * answer[k.col_idx[slot] as usize];
        }
        r -= rhs[i];
        r2 += r * r;
        b2 += rhs[i] * rhs[i];
        d2 += (answer[i] - reference[i]).powi(2);
        x2 += reference[i].powi(2);
    }
    let residual = (r2 / b2).sqrt();
    let difference = (d2 / x2).sqrt();
    println!("reported_residual={:e} independent_original_residual={residual:e} relative_difference_from_verified_arm={difference:e}", info.rel_residual);
    assert!(residual.is_finite() && residual < 1e-10);
    assert!(difference.is_finite() && difference < 1e-9);
}
