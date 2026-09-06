//! Jacobi-preconditioned conjugate gradient in f64 (plan A §5.2).
//!
//! Textbook PCG: the preconditioner is the reciprocal diagonal, the SpMV is [`Csr::spmv`]
//! (parallel over rows, sequential inside a row) and every inner product goes through
//! [`par::dot`], whose chunk boundaries are functions of `n` alone. The whole iteration is
//! therefore bit-identical at any thread count.
//!
//! It is the no-GPU path above the direct threshold and, at a loose tolerance, the inner
//! solver of the refinement loop the GPU also uses — so the refinement machinery is exercised
//! on every machine, adapter or not.

use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::par;
use crate::solve::{LinearSolve, SolveInfo};

/// The Jacobi preconditioner of `k`: `1/K_ii`, or 1 where a row has no diagonal at all (an
/// ill-posed system, which the `pᵀKp` test below catches on the first iteration).
///
/// The GPU takes the square root of the same vector to scale its copy of the system
/// symmetrically, so there is one definition of "the diagonal we divide by" (plan A §5.4).
pub fn inv_diagonal(k: &Csr) -> Vec<f64> {
    k.diag().into_iter().map(|d| if d > 0.0 { 1.0 / d } else { 1.0 }).collect()
}

/// A matrix and its Jacobi preconditioner. Borrows the matrix: nothing is factorised, so there
/// is nothing to keep beyond the reciprocal diagonal.
pub struct CpuPcg<'a> {
    k: &'a Csr,
    inv_diag: Vec<f64>,
    rel_tol: f64,
    max_iterations: usize,
}

impl<'a> CpuPcg<'a> {
    /// The preconditioner is built once per matrix; `rel_tol` and `max_iterations` are the
    /// inner budget, which [`refine`](crate::solve::refine::refine) sets to `inner_tol`.
    pub fn new(k: &'a Csr, rel_tol: f64, max_iterations: usize) -> CpuPcg<'a> {
        CpuPcg { k, inv_diag: inv_diagonal(k), rel_tol, max_iterations }
    }

    /// `z = M⁻¹ r`.
    fn precondition(&self, r: &[f64], z: &mut [f64]) {
        for (i, zi) in z.iter_mut().enumerate() {
            *zi = self.inv_diag[i] * r[i];
        }
    }
}

impl LinearSolve for CpuPcg<'_> {
    fn solve(&mut self, b: &[f64], x: &mut [f64]) -> Result<SolveInfo, Error> {
        let n = self.k.n;
        let norm_b = par::dot(b, b).sqrt().max(f64::MIN_POSITIVE);
        x.fill(0.0);
        // x = 0, so the initial residual is b itself.
        let mut r = b.to_vec();
        let mut z = vec![0.0; n];
        self.precondition(&r, &mut z);
        let mut p = z.clone();
        let mut q = vec![0.0; n];
        let mut rz = par::dot(&r, &z);
        let mut iterations = 0;
        let mut rel_residual = par::dot(&r, &r).sqrt() / norm_b;
        while iterations < self.max_iterations && rel_residual >= self.rel_tol {
            self.k.spmv(&p, &mut q);
            let pq = par::dot(&p, &q);
            if pq <= 0.0 {
                return Err(Error::new(
                    ErrorCode::SolveNotPositiveDefinite,
                    format!(
                        "the conjugate gradient met a non-positive curvature pᵀKp = {pq} at iteration {iterations}"
                    ),
                )
                .at("solve")
                .suggest("constraint.fix"));
            }
            let alpha = rz / pq;
            for i in 0..n {
                x[i] += alpha * p[i];
                r[i] -= alpha * q[i];
            }
            self.precondition(&r, &mut z);
            let rz_new = par::dot(&r, &z);
            let beta = rz_new / rz;
            rz = rz_new;
            for i in 0..n {
                p[i] = z[i] + beta * p[i];
            }
            iterations += 1;
            rel_residual = par::dot(&r, &r).sqrt() / norm_b;
        }
        Ok(SolveInfo { solver: "cpu-pcg", iterations, rel_residual, time_ms: 0.0 })
    }
}
