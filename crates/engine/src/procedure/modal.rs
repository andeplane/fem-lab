//! Modal analysis by subspace iteration on a shifted factorisation (plan A §6).
//!
//! `K φ = λ M φ` with a consistent mass. The iteration works with `A = K − σ M` for a small
//! negative `σ`, which is positive definite even when `K` is not — that is what lets a
//! completely free body, whose six rigid modes have `λ = 0`, be factorised at all. Each sweep
//! is `X̄ = A⁻¹ M X`, a `q × q` projection of `K` and `M` onto `X̄`, a dense generalised
//! eigenproblem, and an M-orthonormal update; `q = min(2p, p + 8)` subspace vectors converge
//! the `p` smallest eigenvalues quickly and the start vectors are Bathe's, so the answer never
//! depends on a random seed.
//!
//! The dense `q × q` work runs under `Par::Seq`: it is tiny, and a sequential reduction keeps
//! the frequencies bit-identical at any thread count. That parallelism is passed per call, so a
//! modal Step never touches faer's process-global setting other Engines read (ADR 0019).

use dyn_stack::{MemBuffer, MemStack};
use faer::linalg::cholesky::llt::factor::{cholesky_in_place, cholesky_in_place_scratch};
use faer::linalg::evd::{self_adjoint_evd, self_adjoint_evd_scratch, ComputeEigenvectors};
use faer::Par;

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::{assemble_stiffness, pattern, reduce, resolve, Csr, Pattern};
use crate::fem::checks;
use crate::fem::element::element_for;
use crate::fem::mpc;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, Per};
use crate::procedure::{blank, report, vector_field, StepResult};
use crate::solve::{direct::Direct, LinearSolve, SolveInfo, SolveOptions};

/// Relative change in the `p` smallest eigenvalues below which the subspace has converged.
const TOL: f64 = 1e-10;
/// Sweeps before the iteration gives up and says so.
const MAX_SWEEPS: usize = 60;
/// `σ = −SHIFT · tr(K)/tr(M)` when the Step does not name one.
const SHIFT: f64 = 1e-6;
/// The `q × q` dense reduction is sequential at any host thread count, per call, never globally.
const DENSE_PAR: Par = Par::Seq;

/// `M = ∫ ρ NᵀN dV` for the whole mesh plus every point mass, into a fresh copy of `pat.csr`.
///
/// `lumped` gives the HRZ-scaled diagonal instead, which is what the explicit integrator
/// needs; the modal path always wants the consistent matrix. A point mass is lumped either
/// way — it has no shape function to spread it — so it lands on its own node's diagonal.
pub fn assemble_mass(p: &Problem<'_>, pat: &Pattern, lumped: bool) -> Result<Csr, Error> {
    let dpn = p.dofs_per_node();
    let mut m = pat.csr.clone();
    let mut coords = Vec::new();
    let mut me = Vec::new();
    let t = [0.0; 0];
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let (nn, nd) = (blk.kind.n_nodes(), blk.kind.n_nodes() * p.node_dofs(blk.kind));
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(elem, &mut coords);
            me.clear();
            me.resize(nd * nd, 0.0);
            // One `?`: the context and the mass integral fail on the same material.
            p.ctx(elem, &coords, &t)
                .and_then(|c| element.mass(&c, &mut me, lumped))
                .map_err(|e| e.at(format!("element {elem}")))?;
            let slot = &pat.slot[pat.slot_ptr[elem as usize] as usize..pat.slot_ptr[elem as usize + 1] as usize];
            for (s, v) in slot.iter().zip(me.iter()) {
                m.vals[*s as usize] += v;
            }
        }
    }
    // A point mass has no rotational inertia: it loads the three displacements only.
    for pm in &p.points {
        for c in 0..dpn.min(3) {
            let r = pm.node as usize * dpn + c;
            let (lo, hi) = (m.row_ptr[r] as usize, m.row_ptr[r + 1] as usize);
            let at = m.col_idx[lo..hi].binary_search(&(r as u32)).expect("the pattern seeds every node's diagonal");
            m.vals[lo + at] += pm.mass;
        }
    }
    Ok(m)
}

/// The modal damping ratio of each mode, shared by every post-modal procedure.
///
/// `ratio` gives the constant or per-mode fraction of critical: empty is undamped, one entry
/// applies to every mode (the scalar `dampingRatio` shorthand), and more than one gives mode k
/// its own entry with the last one held for any mode past the end (`dampingRatios`). `rayleigh`
/// is the `(alpha, beta)` of `C = alpha M + beta K`, which a mass-orthonormal basis
/// diagonalises into `zeta_k = alpha / (2 omega_k) + beta omega_k / 2` — alpha damping the low
/// modes and beta the high ones — and is added to `ratio` exactly as the scalar always was. A
/// rigid mode has `omega_k = 0` and no mass-proportional term to speak of: its response is
/// multiplied by `omega_k` anyway, so it takes the ratio alone rather than an infinity.
pub fn damping_ratios(frequencies: &[f64], ratio: &[f64], rayleigh: (f64, f64)) -> Vec<f64> {
    let (alpha, beta) = rayleigh;
    frequencies
        .iter()
        .enumerate()
        .map(|(k, hz)| {
            let w = 2.0 * std::f64::consts::PI * hz;
            let mass_term = if w > 0.0 { alpha / (2.0 * w) } else { 0.0 };
            let zeta = ratio.get(k).or_else(|| ratio.last()).copied().unwrap_or(0.0);
            zeta + mass_term + beta * w / 2.0
        })
        .collect()
}

/// The `no-density` error: a modal or explicit Step over a Material without `rho`.
fn no_density() -> Error {
    Error::new(ErrorCode::ModelIllPosed, "the mass matrix is zero: no Material in this Step has a density")
        .at("materials")
        .suggest("material.add with rho, e.g. \"7850 kg/m^3\"")
}

/// The `model.ill-posed` error a Step with nothing left to move answers with. Buckling shares
/// it: an eigenproblem over an empty free set is the same modelling mistake either way.
pub(crate) fn no_free_dofs() -> Error {
    Error::new(
        ErrorCode::ModelIllPosed,
        "modal analysis has no free displacement DOFs; every displacement DOF is constrained",
    )
    .at("constraints")
    .suggest("constraint.remove on an over-constraining displacement constraint")
}

/// Solve one modal Step: `n_modes` frequencies and their M-normalised shapes.
pub fn run(
    p: &Problem<'_>,
    n_modes: usize,
    shift: Option<f64>,
    _solver: &SolveOptions,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    // A free body is a legitimate modal model, so the rigid-mode check is not run here: its six
    // zero frequencies are the answer, not a failure. Everything else still applies.
    if let Some(e) = checks::all(p).into_iter().find(|e| e.code != ErrorCode::ConstraintRigidModes) {
        return Err(e);
    }
    report(&mut progress, "assemble", 0.1, "building the stiffness and mass matrices")?;
    let dpn = p.dofs_per_node();
    let pat = pattern(p.mesh, dpn);
    let (a, m) =
        pool.install(|| assemble_stiffness(p, &pat).and_then(|a| assemble_mass(p, &pat, false).map(|m| (a, m))))?;
    let rc = resolve(p).expect("the checks resolved the constraints");
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    let zeros = vec![0.0; a.k.n];
    // Both operators take the same `T`, so the eigenproblem stays the generalised symmetric
    // one the subspace iteration wants.
    let (kt, _) = pool.install(|| mpc::transform(&a.k, &zeros, &mpc));
    let (mt, _) = pool.install(|| mpc::transform(&m, &zeros, &mpc));
    let red_k = reduce(&kt, &zeros, &rc, &mpc.slaves);
    let red_m = reduce(&mt, &zeros, &rc, &mpc.slaves);
    let n = red_k.k_ff.n;
    if n == 0 {
        return Err(no_free_dofs());
    }
    let p_modes = n_modes.clamp(1, n);
    report(&mut progress, "solve", 0.3, "subspace iteration")?;
    let (lambda, shapes, sweeps) = pool.install(|| subspace(&red_k.k_ff, &red_m.k_ff, p_modes, shift))?;

    let mut res = blank(SolveInfo { solver: "cpu-direct", iterations: sweeps, rel_residual: 0.0, time_ms: 0.0 });
    // Negative eigenvalues are shift noise around the rigid modes; a frequency is √λ of the
    // magnitude, which reads as zero exactly where it should.
    res.frequencies = lambda.iter().map(|&l| l.max(0.0).sqrt() / (2.0 * std::f64::consts::PI)).collect();
    for shape in &shapes {
        let mut full = vec![0.0; a.k.n];
        for (i, &dof) in red_k.free.iter().enumerate() {
            full[dof as usize] = shape[i];
        }
        mpc::recover(&mpc, &mut full);
        res.modes.push(vector_field(&full, dpn));
    }
    res.warnings = mpc.warnings;
    res.fields.insert(Field::Displacement, res.modes[0].clone());
    res.scalars.insert("min_det_j".to_string(), a.min_det_j);
    for axis in ["x", "y", "z"] {
        res.scalars.insert(format!("applied_total_{axis}"), 0.0);
    }
    res.scalars.insert("rel_residual".to_string(), 0.0);
    for (i, f) in res.frequencies.iter().enumerate() {
        res.scalars.insert(format!("frequency_{}", i + 1), *f);
    }
    res.extremes = res
        .fields
        .iter()
        .filter(|(_, f)| f.per == Per::Node)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    report(&mut progress, "post", 0.9, "normalising the mode shapes")?;
    Ok(res)
}

/// The eigenvalues ascending, the M-orthonormal shapes that go with them, and the sweeps taken.
type Spectrum = (Vec<f64>, Vec<Vec<f64>>, usize);

/// Subspace iteration for the `p` smallest eigenvalues of `K φ = λ M φ`.
fn subspace(k: &Csr, m: &Csr, p: usize, shift: Option<f64>) -> Result<Spectrum, Error> {
    let n = k.n;
    let q = (2 * p).min(p + 8).min(n);
    let kd = k.diag();
    let md = m.diag();
    let trace_m: f64 = md.iter().sum();
    if trace_m <= 0.0 {
        return Err(no_density());
    }
    let sigma = shift.unwrap_or(-SHIFT * kd.iter().sum::<f64>() / trace_m);
    // `A = K − σM` is positive definite for σ < 0 even when K has rigid modes.
    let mut a = k.clone();
    for (v, &mv) in a.vals.iter_mut().zip(&m.vals) {
        *v -= sigma * mv;
    }
    // Positive definite for σ < 0 whatever K does; a positive shift above the first
    // eigenvalue makes it indefinite, and the factorisation says so.
    let mut factored = Direct::factor(&a)?;

    // Bathe's start vectors: the mass diagonal, then unit vectors at the DOFs with the largest
    // `m_ii / k_ii` — the ones that carry mass with the least stiffness.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| {
        let (ri, rj) = (md[i] / kd[i], md[j] / kd[j]);
        rj.partial_cmp(&ri).unwrap_or(std::cmp::Ordering::Equal).then(i.cmp(&j))
    });
    let mut x: Vec<Vec<f64>> = Vec::with_capacity(q);
    x.push(md.clone());
    for &i in order.iter().take(q - 1) {
        let mut v = vec![0.0; n];
        v[i] = 1.0;
        x.push(v);
    }

    let mut prev = vec![f64::INFINITY; p];
    let mut lambda = vec![0.0; q];
    let mut y = vec![0.0; n];
    let mut bar: Vec<Vec<f64>> = vec![vec![0.0; n]; q];
    // The iterate improves monotonically, so running out of sweeps is not a failure: it is the
    // best subspace found, reported with the sweep count so a Result says how hard it was.
    let mut sweeps = 0;
    for sweep in 1..=MAX_SWEEPS {
        sweeps = sweep;
        for c in 0..q {
            m.spmv(&x[c], &mut y);
            // A factorization may still produce an unacceptable residual.
            factored.solve(&y, &mut bar[c])?;
        }
        orthonormalise(&mut bar);
        // K̂ = X̄ᵀ K X̄ and M̂ = X̄ᵀ M X̄, both q × q and symmetric by construction.
        let (k_hat, m_hat) = (project(k, &bar, q, n), project(m, &bar, q, n));
        let (lam, z) = dense_eigen(&k_hat, &m_hat, q);
        lambda = lam;
        for c in 0..q {
            let mut col = vec![0.0; n];
            for (j, b) in bar.iter().enumerate() {
                let zc = z[j * q + c];
                for (i, v) in col.iter_mut().enumerate() {
                    *v += zc * b[i];
                }
            }
            x[c] = col;
        }
        let done = (0..p).all(|i| (lambda[i] - prev[i]).abs() <= TOL * lambda[i].abs().max(f64::MIN_POSITIVE));
        prev[..p].copy_from_slice(&lambda[..p]);
        if done {
            break;
        }
    }
    Ok((lambda[..p].to_vec(), x[..p].to_vec(), sweeps))
}

/// Modified Gram-Schmidt on the iterated block, in place.
///
/// Subspace iteration drives every column towards the same lowest mode, and one dominant lumped
/// mass makes `M` nearly rank-one on the DOFs it is coupled to, so `A⁻¹ M X` comes back with
/// columns that are numerically parallel; `X̄ᵀ M X̄` is then singular and the Cholesky below has
/// nothing to factorise. Orthonormalising changes the basis of the subspace and never the
/// subspace, so the Ritz values are the same numbers — and with orthonormal columns and a
/// positive definite `M`, `X̄ᵀ M X̄` is positive definite by construction.
///
/// The columns are taken in order and each is swept against the ones before it, so the result
/// is the same at any thread count.
fn orthonormalise(bar: &mut [Vec<f64>]) {
    for c in 0..bar.len() {
        for j in 0..c {
            let (before, rest) = bar.split_at_mut(c);
            let (col, basis) = (&mut rest[0], &before[j]);
            let d: f64 = col.iter().zip(basis.iter()).map(|(a, b)| a * b).sum();
            for (v, b) in col.iter_mut().zip(basis.iter()) {
                *v -= d * b;
            }
        }
        // `A⁻¹M` is invertible, so a column can only shrink towards its predecessors, never
        // vanish exactly; the floor makes a shrunken one scaled rather than divided by zero.
        let norm = bar[c].iter().map(|v| v * v).sum::<f64>().sqrt();
        let scale = 1.0 / norm.max(f64::MIN_POSITIVE);
        for v in bar[c].iter_mut() {
            *v *= scale;
        }
    }
}

/// `Xᵀ A X` for `q` columns of length `n`, row-major `q × q`.
pub(crate) fn project(a: &Csr, x: &[Vec<f64>], q: usize, n: usize) -> Vec<f64> {
    let mut out = vec![0.0; q * q];
    let mut ax = vec![0.0; n];
    for c in 0..q {
        a.spmv(&x[c], &mut ax);
        for (r, xr) in x.iter().enumerate().take(q) {
            out[r * q + c] = xr.iter().zip(&ax).map(|(u, v)| u * v).sum();
        }
    }
    out
}

/// The dense generalised eigenproblem `K̂ z = λ M̂ z` for a small symmetric pair.
///
/// `M̂ = L Lᵀ`, and `L⁻¹ K̂ L⁻ᵀ` is symmetric with the same eigenvalues; faer's self-adjoint
/// eigendecomposition returns them nondecreasing, and `z = L⁻ᵀ Q` makes the eigenvectors
/// M̂-orthonormal, which is what keeps the iterated subspace M-orthonormal too.
///
/// Only the *second* operand is factorised, so a linear buckling Step passes its indefinite
/// `X̄ᵀ(−K_σ)X̄` first and its positive definite `X̄ᵀKX̄` second and this needs no change.
pub(crate) fn dense_eigen(k_hat: &[f64], m_hat: &[f64], q: usize) -> (Vec<f64>, Vec<f64>) {
    // `M̂ = X̄ᵀ M X̄` with `M` positive definite (the density check above) and `X̄` of full rank,
    // so the factorisation and the symmetric eigendecomposition below cannot fail. Both are the
    // low-level faer entry points, which take the parallelism as an argument: the high-level
    // `llt`/`self_adjoint_eigen` read the process-global setting instead, and pinning that to
    // `Par::Seq` here would pin it for every other Engine in the host as well.
    let mut lower = faer::Mat::<f64>::from_fn(q, q, |i, j| if j <= i { m_hat[i * q + j] } else { 0.0 });
    cholesky_in_place(
        lower.as_mut(),
        Default::default(),
        DENSE_PAR,
        MemStack::new(&mut MemBuffer::new(cholesky_in_place_scratch::<f64>(q, DENSE_PAR, Default::default()))),
        Default::default(),
    )
    .expect("the projected mass matrix is positive definite");
    // Only the lower triangle and the diagonal are ever read below, which is all `cholesky_in_place` writes.
    let l = lower.as_ref();
    // c = L⁻¹ K̂ L⁻ᵀ, built as (L⁻¹ (L⁻¹ K̂)ᵀ), which is the same matrix because it is symmetric.
    let mut c: Vec<f64> = forward(&l, k_hat, q);
    c = forward(&l, &transpose(&c, q), q);
    let a = faer::Mat::<f64>::from_fn(q, q, |i, j| c[i * q + j]);
    let mut s = faer::diag::Diag::<f64>::zeros(q);
    let mut u = faer::Mat::<f64>::zeros(q, q);
    self_adjoint_evd(
        a.as_ref(),
        s.as_mut(),
        Some(u.as_mut()),
        DENSE_PAR,
        MemStack::new(&mut MemBuffer::new(self_adjoint_evd_scratch::<f64>(
            q,
            ComputeEigenvectors::Yes,
            DENSE_PAR,
            Default::default(),
        ))),
        Default::default(),
    )
    .expect("a real symmetric matrix has a real eigendecomposition");
    let lambda: Vec<f64> = (0..q).map(|i| s.column_vector()[i]).collect();
    let qmat: Vec<f64> = (0..q * q).map(|idx| u[(idx / q, idx % q)]).collect();
    (lambda, backward(&l, &qmat, q))
}

/// `L⁻¹ B` for a lower-triangular `L` and a row-major `q × q` right-hand side.
fn forward(l: &faer::MatRef<'_, f64>, b: &[f64], q: usize) -> Vec<f64> {
    let mut x = b.to_vec();
    for c in 0..q {
        for i in 0..q {
            let mut s = x[i * q + c];
            for j in 0..i {
                s -= l[(i, j)] * x[j * q + c];
            }
            x[i * q + c] = s / l[(i, i)];
        }
    }
    x
}

/// `L⁻ᵀ B` for a lower-triangular `L` and a row-major `q × q` right-hand side.
fn backward(l: &faer::MatRef<'_, f64>, b: &[f64], q: usize) -> Vec<f64> {
    let mut x = b.to_vec();
    for c in 0..q {
        for i in (0..q).rev() {
            let mut s = x[i * q + c];
            for j in i + 1..q {
                s -= l[(j, i)] * x[j * q + c];
            }
            x[i * q + c] = s / l[(i, i)];
        }
    }
    x
}

fn transpose(a: &[f64], q: usize) -> Vec<f64> {
    let mut out = vec![0.0; q * q];
    for i in 0..q {
        for j in 0..q {
            out[j * q + i] = a[i * q + j];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn damping_ratios_add_the_constant_and_both_rayleigh_terms() {
        // omega = 2 pi for 1 Hz: alpha/(2w) = 1/(4 pi), beta w / 2 = pi.
        let z = super::damping_ratios(&[0.0, 1.0], &[0.02], (1.0, 1.0));
        assert_eq!(z[0], 0.02, "a rigid mode takes the constant ratio alone");
        let expected = 0.02 + 1.0 / (4.0 * std::f64::consts::PI) + std::f64::consts::PI;
        assert!(libm::fabs(z[1] - expected) < 1e-15, "{z:?}");
        // No ratio and no Rayleigh is an undamped basis.
        assert_eq!(super::damping_ratios(&[3.0], &[], (0.0, 0.0)), vec![0.0]);
    }

    #[test]
    fn damping_ratios_per_mode_holds_the_last_entry() {
        // Three modes, two entries: mode 0 takes 0.01, modes 1 and 2 both take 0.03 (held).
        let z = super::damping_ratios(&[1.0, 2.0, 3.0], &[0.01, 0.03], (0.0, 0.0));
        assert_eq!(z, vec![0.01, 0.03, 0.03]);
    }

    #[test]
    fn dense_modes_preserve_global_parallelism_and_the_generalized_eigenproblem() {
        let before = faer::get_global_parallelism();
        // M=diag(4,9), M^-1/2 K M^-1/2=[[6.5,2.5],[2.5,6.5]]:
        // its eigenvalues are exactly 4 and 9. Both eigenvectors must have unit M-norm.
        let k = [26.0, 15.0, 15.0, 58.5];
        let m = [4.0, 0.0, 0.0, 9.0];
        let (values, vectors) = super::dense_eigen(&k, &m, 2);
        assert_eq!(faer::get_global_parallelism(), before);
        for (column, expected) in [4.0, 9.0].into_iter().enumerate() {
            assert!((values[column] - expected).abs() < 1e-12);
            let x = vectors[column];
            let y = vectors[2 + column];
            assert!((4.0 * x * x + 9.0 * y * y - 1.0).abs() < 1e-12);
            assert!((26.0 * x + 15.0 * y - expected * 4.0 * x).abs() < 1e-12);
            assert!((15.0 * x + 58.5 * y - expected * 9.0 * y).abs() < 1e-12);
        }
        assert!((4.0 * vectors[0] * vectors[1] + 9.0 * vectors[2] * vectors[3]).abs() < 1e-12);
    }
}
