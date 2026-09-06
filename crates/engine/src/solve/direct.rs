//! The sparse direct solver: faer's supernodal `LLᵀ` over our own CSR arrays.
//!
//! A symmetric matrix in CSR is byte-for-byte its own CSC, so faer factorises
//! [`Csr`](crate::fem::assembly::Csr) in place with no copy and reads only the lower triangle.
//! A non-positive pivot means the reduced system still has a free mode that the rigid-body
//! check did not name — a mechanism — so every `LltError` maps to one engine error with the
//! Command that fixes it.

use faer::prelude::Solve;
use faer::sparse::linalg::solvers::{Llt, SymbolicLlt};
use faer::sparse::linalg::LltError;
use faer::Side;

use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::par;
use crate::solve::{LinearSolve, SolveInfo};

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
    llt: Llt<u32, f64>,
    /// The matrix itself, for the residual the solve reports.
    k: Csr,
}

impl Direct {
    /// Factorise `k`. The symbolic analysis (fill-reducing ordering, elimination tree) and the
    /// numeric factorisation both run under faer's parallelism, which is set from the engine's
    /// thread pool so the same pool covers assembly and factorisation.
    pub fn factor(k: &Csr) -> Result<Direct, Error> {
        set_parallelism();
        let a = k.as_faer();
        // `Generic` wraps the allocation failure the symbolic analysis can report, so both
        // stages reach `Error` through the single `From` impl above and neither needs an arm
        // of its own that no test could take.
        let llt = SymbolicLlt::try_new(a.symbolic(), Side::Lower)
            .map_err(LltError::Generic)
            .and_then(|symbolic| Llt::try_new_with_symbolic(symbolic, a, Side::Lower))?;
        Ok(Direct { llt, k: k.clone() })
    }
}

/// faer reads its parallelism from a global; set it from the pool the engine installed, so a
/// one-thread pool really does factorise on one thread. `Par::rayon` needs the `rayon`
/// feature, which is a native-only dependency, so wasm stays sequential.
#[cfg(not(target_arch = "wasm32"))]
fn set_parallelism() {
    faer::set_global_parallelism(faer::Par::rayon(rayon::current_num_threads()));
}

#[cfg(target_arch = "wasm32")]
fn set_parallelism() {
    faer::set_global_parallelism(faer::Par::Seq);
}

impl LinearSolve for Direct {
    fn solve(&mut self, b: &[f64], x: &mut [f64]) -> Result<SolveInfo, Error> {
        let n = self.k.n;
        let mut rhs = faer::Mat::<f64>::from_fn(n, 1, |i, _| b[i]);
        self.llt.solve_in_place(rhs.as_mut());
        for (i, xi) in x.iter_mut().enumerate() {
            *xi = rhs[(i, 0)];
        }
        // ‖K x − b‖ / ‖b‖: what a direct solve actually achieved, reported like an iterative one.
        let mut kx = vec![0.0; n];
        self.k.spmv(x, &mut kx);
        for (v, bi) in kx.iter_mut().zip(b) {
            *v -= bi;
        }
        let norm_b = par::dot(b, b).sqrt();
        let rel_residual = par::dot(&kx, &kx).sqrt() / norm_b.max(f64::MIN_POSITIVE);
        Ok(SolveInfo { solver: "cpu-direct", iterations: 1, rel_residual, time_ms: 0.0 })
    }
}
