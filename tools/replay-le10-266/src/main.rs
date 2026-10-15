//! Replay an immutable verified LE10 operator without FEM assembly or the engine residual guard.
use faer::prelude::Solve;
use faer::sparse::linalg::solvers::{Llt, SymbolicLlt};
use faer::{Mat, Par, Side};
use std::io::Read;

fn read_u32(input: &mut &[u8]) -> u32 {
    let mut bytes = [0_u8; 4];
    input.read_exact(&mut bytes).unwrap();
    u32::from_le_bytes(bytes)
}
fn read_u64(input: &mut &[u8]) -> u64 {
    let mut bytes = [0_u8; 8];
    input.read_exact(&mut bytes).unwrap();
    u64::from_le_bytes(bytes)
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("replay <FEM266K1.csr> [seq|rayon1|rayon4|factor4-solve-seq|factor-seq-solve4]");
    let mode = args.get(2).map(String::as_str).unwrap_or("rayon4");
    let (factor_mode, solve_mode, factor_par, solve_par) = match mode {
        "seq" => ("seq", "seq", Par::Seq, Par::Seq),
        "rayon1" => ("rayon1", "rayon1", Par::rayon(1), Par::rayon(1)),
        "rayon4" => ("rayon4", "rayon4", Par::rayon(4), Par::rayon(4)),
        "factor4-solve-seq" => ("rayon4", "seq", Par::rayon(4), Par::Seq),
        "factor-seq-solve4" => ("seq", "rayon4", Par::Seq, Par::rayon(4)),
        _ => panic!("unknown parallelism"),
    };
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..8], b"FEM266K1");
    let mut input = &bytes[8..];
    let n = read_u64(&mut input) as usize;
    let nnz = read_u64(&mut input) as usize;
    assert_eq!(bytes.len(), 24 + 4 * (n + 1) + 12 * nnz + 16 * n);
    let ptr: Vec<u32> = (0..=n).map(|_| read_u32(&mut input)).collect();
    let indices: Vec<u32> = (0..nnz).map(|_| read_u32(&mut input)).collect();
    let values: Vec<f64> = (0..nnz).map(|_| f64::from_bits(read_u64(&mut input))).collect();
    let rhs: Vec<f64> = (0..n).map(|_| f64::from_bits(read_u64(&mut input))).collect();
    let reference: Vec<f64> = (0..n).map(|_| f64::from_bits(read_u64(&mut input))).collect();
    assert!(input.is_empty());
    println!(
        "os={} arch={} mode={mode} factor={factor_mode} solve={solve_mode} n={n} nnz={nnz} available_threads={:?}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::thread::available_parallelism()
    );
    #[cfg(target_arch = "x86_64")]
    println!(
        "avx512f={} avx2={} fma={}",
        std::arch::is_x86_feature_detected!("avx512f"),
        std::arch::is_x86_feature_detected!("avx2"),
        std::arch::is_x86_feature_detected!("fma")
    );
    let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap();
    pool.install(|| {
        // faer 0.24.4 reads global parallelism separately in numeric LLT and SolveCore.
        // Each control is a fresh process: changing it here cannot race another solve.
        faer::set_global_parallelism(factor_par);
        let symbolic = faer::sparse::SymbolicSparseColMatRef::new_checked(n, n, &ptr, None, &indices);
        let matrix = faer::sparse::SparseColMatRef::new(symbolic, &values);
        let symbolic = SymbolicLlt::try_new(matrix.symbolic(), Side::Lower).unwrap();
        let factor = Llt::try_new_with_symbolic(symbolic, matrix, Side::Lower).unwrap();
        faer::set_global_parallelism(solve_par);
        let mut answer = Mat::from_fn(n, 1, |i, _| rhs[i]);
        factor.solve_in_place(answer.as_mut());
        let mut r2 = 0.0;
        let mut b2 = 0.0;
        let mut d2 = 0.0;
        let mut x2 = 0.0;
        let mut different_bits = 0;
        for i in 0..n {
            let x = answer[(i, 0)];
            let mut r = 0.0;
            for slot in ptr[i] as usize..ptr[i + 1] as usize { r += values[slot] * answer[(indices[slot] as usize, 0)]; }
            r -= rhs[i];
            r2 += r * r;
            b2 += rhs[i] * rhs[i];
            d2 += (x - reference[i]).powi(2);
            x2 += reference[i].powi(2);
            different_bits += usize::from(x.to_bits() != reference[i].to_bits());
        }
        let residual = (r2 / b2).sqrt();
        let difference = (d2 / x2).sqrt();
        println!("relative_residual={residual:e} relative_difference_from_verified_arm={difference:e} different_bits={different_bits}");
        assert!(residual.is_finite() && residual < 1e-10);
        assert!(difference.is_finite() && difference < 1e-9);
    });
}
