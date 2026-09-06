//! Standalone dependency discriminator for andeplane/fem-lab#266.
//! Integer block products and a Dirichlet grid supply closed forms, with no FEM assembly.
use faer::linalg::matmul::matmul;
use faer::prelude::Solve;
use faer::sparse::linalg::solvers::{Llt, SymbolicLlt};
use faer::{Accum, Mat, Par, Side};

fn block_product(m: usize, n: usize, k: usize, layout: [bool; 3], add: bool, par: Par) -> bool {
    let [a_rows, b_rows, c_rows] = layout;
    let a_value = |i: usize, l: usize| if i < m / 2 && l < 3 * k / 4 { (i % 7 + 1) as f64 } else { 0.0 };
    let b_value = |l: usize, j: usize| if l >= k / 4 && j >= n / 2 { (j % 5) as f64 - 2.0 } else { 0.0 };
    let a = if a_rows { Mat::from_fn(k, m, |l, i| a_value(i, l)) } else { Mat::from_fn(m, k, a_value) };
    let b = if b_rows { Mat::from_fn(n, k, |j, l| b_value(l, j)) } else { Mat::from_fn(k, n, b_value) };
    let initial = if add { 1.0 } else { f64::NAN };
    let mut c = if c_rows { Mat::from_fn(n, m, |_, _| initial) } else { Mat::from_fn(m, n, |_, _| initial) };
    let av = if a_rows { a.as_ref().transpose() } else { a.as_ref() };
    let bv = if b_rows { b.as_ref().transpose() } else { b.as_ref() };
    let cv = if c_rows { c.as_mut().transpose_mut() } else { c.as_mut() };
    matmul(cv, if add { Accum::Add } else { Accum::Replace }, av, bv, if add { -1.0 } else { 1.0 }, par);
    let overlap = (3 * k / 4 - k / 4) as f64;
    let mut wrong = 0;
    let mut max_error = 0.0_f64;
    for i in 0..m {
        for j in 0..n {
            // A = u v^T and B = w z^T; v^T w is the integer intersection length.
            let ab = if i < m / 2 && j >= n / 2 { (i % 7 + 1) as f64 * ((j % 5) as f64 - 2.0) * overlap } else { 0.0 };
            let expected = if add { 1.0 - ab } else { ab };
            let got = if c_rows { c[(j, i)] } else { c[(i, j)] };
            if got != expected {
                wrong += 1;
            }
            max_error = max_error.max(if got.is_finite() { (got - expected).abs() } else { f64::INFINITY });
        }
    }
    println!("product m={m} n={n} k={k} row_major_abc={layout:?} add={add} wrong={wrong} max_abs_error={max_error:e}");
    wrong == 0
}

fn grid(width: usize, par: Par) -> bool {
    let count = width * width * width;
    let mut ptr = vec![0_u32];
    let mut indices = Vec::new();
    let mut values = Vec::new();
    let mut boundary = Vec::new();
    for i in 0..count {
        let xyz = [i % width, i / width % width, i / (width * width)];
        let mut neighbors = Vec::new();
        for (axis, stride) in [1, width, width * width].into_iter().enumerate() {
            if xyz[axis] > 0 {
                neighbors.push(i - stride);
            }
            if xyz[axis] + 1 < width {
                neighbors.push(i + stride);
            }
        }
        // K = the seven-point positive Dirichlet Laplacian; K*1 counts exterior neighbors.
        boundary.push((6 - neighbors.len()) as f64);
        neighbors.push(i);
        neighbors.sort_unstable();
        for j in neighbors {
            indices.push(j as u32);
            values.push(if i == j { 6.0 } else { -1.0 });
        }
        ptr.push(indices.len() as u32);
    }
    let symbolic = faer::sparse::SymbolicSparseColMatRef::new_checked(count, count, &ptr, None, &indices);
    let matrix = faer::sparse::SparseColMatRef::new(symbolic, &values);
    faer::set_global_parallelism(par);
    let symbolic = SymbolicLlt::try_new(matrix.symbolic(), Side::Lower).expect("valid grid sparsity");
    let factor = Llt::try_new_with_symbolic(symbolic, matrix, Side::Lower).expect("positive Dirichlet Laplacian");
    let mut answer = Mat::from_fn(count, 1, |i, _| boundary[i]);
    factor.solve_in_place(answer.as_mut());
    let mut error = 0.0_f64;
    let mut r2 = 0.0;
    let mut b2 = 0.0;
    for i in 0..count {
        let x = answer[(i, 0)];
        error = error.max(if x.is_finite() { (x - 1.0).abs() } else { f64::INFINITY });
        let mut residual = -boundary[i];
        for slot in ptr[i] as usize..ptr[i + 1] as usize {
            residual += values[slot] * answer[(indices[slot] as usize, 0)];
        }
        r2 += residual * residual;
        b2 += boundary[i] * boundary[i];
    }
    let relative = (r2 / b2).sqrt();
    println!("grid width={width} n={count} max_abs_solution_error={error:e} relative_residual={relative:e}");
    error <= 1e-10 && relative.is_finite() && relative <= 1e-10
}

fn main() {
    println!(
        "os={} arch={} available_threads={:?}",
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
    let good = pool.install(|| {
        let mut good = true;
        for (name, par) in [("seq", Par::Seq), ("rayon1", Par::rayon(1)), ("rayon4", Par::rayon(4))] {
            println!("mode={name}");
            for (m, n, k) in [(33, 31, 33), (129, 127, 513), (513, 509, 513)] {
                for layout in [[false, false, false], [true, true, true], [false, true, false]] {
                    for add in [false, true] {
                        good &= block_product(m, n, k, layout, add, par);
                    }
                }
            }
            for width in [5, 9, 13] {
                good &= grid(width, par);
            }
        }
        good
    });
    assert!(good, "faer failed an independent exact-product or SPD-grid oracle");
}
