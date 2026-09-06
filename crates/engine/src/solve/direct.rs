//! The sparse direct solver: faer's supernodal `LLᵀ` over our own CSR arrays.
//!
//! A symmetric matrix in CSR is byte-for-byte its own CSC, so faer factorises
//! [`Csr`](crate::fem::assembly::Csr) in place with no copy and reads only the lower triangle.
//! A non-positive pivot means the reduced system still has a free mode that the rigid-body
//! check did not name — a mechanism — so every `LltError` maps to one engine error with the
//! Command that fixes it.

use dyn_stack::{MemBuffer, MemStack};
use faer::sparse::linalg::cholesky::{factorize_symbolic_cholesky, LltRef, SymbolicCholesky};
use faer::sparse::linalg::LltError;
use faer::{Conj, Par, Side};

use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::par;
use crate::solve::{LinearSolve, SolveInfo, SolveOptions};

impl From<LltError> for Error {
    /// One arm on purpose: `Generic` is an allocation failure no test can provoke, and an
    /// unreachable `match` arm would be a coverage hole (plan A §5.1, §10).
    fn from(e: LltError) -> Error {
        Error::new(ErrorCode::SolveNotPositiveDefinite, format!("the stiffness matrix is not positive definite: {e:?}"))
            .at("solve")
            .suggest("constraint.fix")
    }
}

/// A factorised matrix, kept so several right-hand sides share one factorisation.
pub struct Direct {
    symbolic: SymbolicCholesky<u32>,
    numeric: Vec<f64>,
    solve_par: Par,
    /// The matrix itself, for the residual the solve reports.
    k: Csr,
}

impl Direct {
    /// Factorise `k` using per-call parallelism, never faer's process-global setting.
    /// Windows numeric LLT is sequential because faer 0.24.4's parallel factorization
    /// can silently corrupt the factor (#266, ADR0019). Assembly and triangular solves
    /// keep the caller's pool parallelism; other native platforms also factor in parallel.
    pub fn factor(k: &Csr) -> Result<Direct, Error> {
        let a = k.as_faer();
        let solve_par = solve_parallelism();
        let par = factor_parallelism(solve_par);
        // Keep faer's fallible stages in one Result chain: all allocation and pivot errors
        // share the same engine boundary conversion, without a separate allocation arm.
        factorize_symbolic_cholesky(a.symbolic(), Side::Lower, Default::default(), Default::default())
            .map_err(LltError::Generic)
            .and_then(|symbolic| numeric_values(symbolic.len_val()).map(|numeric| (symbolic, numeric)))
            .and_then(|(symbolic, mut numeric)| {
                MemBuffer::try_new(symbolic.factorize_numeric_llt_scratch::<f64>(par, Default::default()))
                    .map_err(LltError::from)
                    .and_then(|mut scratch| {
                        symbolic
                            .factorize_numeric_llt(
                                &mut numeric,
                                a,
                                Side::Lower,
                                Default::default(),
                                par,
                                MemStack::new(&mut scratch),
                                Default::default(),
                            )
                            .map_err(LltError::from)
                            .map(|_| ())
                    })
                    .map(|()| Direct { symbolic, numeric, solve_par, k: k.clone() })
            })
            .map_err(Error::from)
    }

    /// Solve and verify the result against the original matrix, allowing the same f64
    /// arithmetic floor as iterative refinement. A factorization is not a success guarantee.
    /// `rel_tol` must be positive and its 100-fold allowance finite; otherwise return a schema error.
    pub fn solve_with_tolerance(&mut self, b: &[f64], x: &mut [f64], rel_tol: f64) -> Result<SolveInfo, Error> {
        let limit = super::refine::FLOOR_GRACE * rel_tol;
        if !limit.is_finite() || rel_tol <= 0.0 {
            return Err(Error::new(
                ErrorCode::Schema,
                "the direct-solve tolerance must be positive with a finite 100-fold roundoff allowance",
            )
            .at("tolerance")
            .suggest("solve.run with a positive finite tolerance, such as 1e-10"));
        }
        let n = self.k.n;
        let mut rhs = faer::Mat::<f64>::from_fn(n, 1, |i, _| b[i]);
        let par = self.solve_par;
        MemBuffer::try_new(self.symbolic.solve_in_place_scratch::<f64>(1, par))
            .map_err(LltError::from)
            .map_err(Error::from)
            .and_then(|mut scratch| {
                LltRef::new(&self.symbolic, &self.numeric).solve_in_place_with_conj(
                    Conj::No,
                    rhs.as_mut(),
                    par,
                    MemStack::new(&mut scratch),
                );
                for (i, xi) in x.iter_mut().enumerate() {
                    *xi = rhs[(i, 0)];
                }
                let mut residual = vec![0.0; n];
                self.k.spmv(x, &mut residual);
                for (v, bi) in residual.iter_mut().zip(b) {
                    *v -= bi;
                }
                let rel_residual = relative_residual(&residual, b);
                if !rel_residual.is_finite() || rel_residual > limit {
                    return Err(Error::new(
                        ErrorCode::SolveStalled,
                        format!(
                    "the direct solve has relative residual {rel_residual:e}, exceeding its acceptance limit {limit:e}"
                ),
                    )
                    .at("solve")
                    .suggest("solve.run { solver: 'cpu-pcg' }"));
                }
                Ok(SolveInfo { solver: "cpu-direct", iterations: 1, rel_residual, time_ms: 0.0 })
            })
    }
}

/// Scale each norm before squaring, then take their ratio without forming either large norm.
/// Nonfinite residuals are failures even when an overflowing denominator could mask them.
fn relative_residual(residual: &[f64], b: &[f64]) -> f64 {
    if residual.iter().chain(b).any(|v| !v.is_finite()) {
        return f64::INFINITY;
    }
    let r_scale = residual.iter().fold(0.0_f64, |largest, v| largest.max(v.abs()));
    let b_scale = b.iter().fold(0.0_f64, |largest, v| largest.max(v.abs()));
    if r_scale == 0.0 {
        return 0.0;
    }
    if b_scale == 0.0 {
        return f64::INFINITY;
    }
    let r: Vec<f64> = residual.iter().map(|v| v / r_scale).collect();
    let rhs: Vec<f64> = b.iter().map(|v| v / b_scale).collect();
    (r_scale / b_scale) * (par::dot(&r, &r) / par::dot(&rhs, &rhs)).sqrt()
}

/// Match faer's fallible numeric allocation, including capacity overflow.
fn numeric_values(len: usize) -> Result<Vec<f64>, LltError> {
    let mut values = Vec::new();
    values.try_reserve_exact(len).map_err(|_| faer::sparse::FaerError::OutOfMemory)?;
    values.resize(len, 0.0);
    Ok(values)
}

/// Per-call policy: never modify the process-global faer setting shared by other Engines.
#[cfg(not(target_arch = "wasm32"))]
fn solve_parallelism() -> Par {
    Par::rayon(rayon::current_num_threads())
}

#[cfg(target_arch = "wasm32")]
fn solve_parallelism() -> Par {
    Par::Seq
}

#[cfg(target_os = "windows")]
fn factor_parallelism(_solve_par: Par) -> Par {
    Par::Seq
}

#[cfg(not(target_os = "windows"))]
fn factor_parallelism(solve_par: Par) -> Par {
    solve_par
}

impl LinearSolve for Direct {
    fn solve(&mut self, b: &[f64], x: &mut [f64]) -> Result<SolveInfo, Error> {
        self.solve_with_tolerance(b, x, SolveOptions::default().rel_tol)
    }
}

#[cfg(test)]
mod tests {
    use super::{numeric_values, relative_residual};

    #[test]
    fn numeric_storage_is_zeroed_and_capacity_overflow_is_a_structured_error() {
        assert_eq!(numeric_values(3).unwrap(), vec![0.0; 3]);
        let error = crate::error::Error::from(numeric_values(usize::MAX).unwrap_err());
        assert_eq!(error.code, crate::error::ErrorCode::SolveNotPositiveDefinite);
        assert!(error.cause.contains("OutOfMemory"));
    }

    #[test]
    fn residual_ratio_is_scale_invariant_and_rejects_nonfinite_values() {
        for scale in [1e-300, 1.0, 1e300] {
            let actual = relative_residual(&[3.0 * scale, 4.0 * scale], &[6.0 * scale, 8.0 * scale]);
            assert!((actual - 0.5).abs() < 1e-15);
        }
        assert_eq!(relative_residual(&[1e-200], &[1.0]), 1e-200);
        assert_eq!(relative_residual(&[], &[]), 0.0);
        assert_eq!(relative_residual(&[0.0], &[0.0]), 0.0);
        assert_eq!(relative_residual(&[0.0], &[1.0]), 0.0);
        assert_eq!(relative_residual(&[1.0], &[0.0]), f64::INFINITY);
        assert_eq!(relative_residual(&[f64::NAN], &[1.0]), f64::INFINITY);
        assert_eq!(relative_residual(&[1.0], &[f64::INFINITY]), f64::INFINITY);
    }
}
