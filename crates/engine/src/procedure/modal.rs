//! Modal analysis by subspace iteration on a shifted factorisation (plan A §6).
//!
//! `(K + K_σ) φ = λ M φ` with a consistent mass, and `K_σ = 0` unless the Step names a static
//! predecessor with `after` (#344). The iteration works with `A = K − σ M` for a small
//! negative `σ`, which is positive definite even when `K` is not — that is what lets a
//! completely free body, whose six rigid modes have `λ = 0`, be factorised at all. Each sweep
//! is `X̄ = A⁻¹ M X`, a `q × q` projection of `K` and `M` onto `X̄`, a dense generalised
//! eigenproblem, and an M-orthonormal update; `q = min(2p, p + 8)` subspace vectors converge
//! the `p` smallest eigenvalues quickly and the start vectors are Bathe's, so the answer never
//! depends on a random seed.
//!
//! **Prestress (stress stiffening).** A Step whose `after` names a solved static or
//! static-nonlinear Step is a *prestressed* modal analysis: the geometric stiffness of that
//! Step's stress state is added to `K` before the eigenproblem is formed, so a tie in tension
//! rings higher and a strut in compression lower, and a member at its buckling load has a first
//! frequency of zero. `K_σ` is the very matrix linear buckling builds
//! ([`crate::procedure::buckling::assemble_geometric`]), from the very displacement the
//! predecessor solved, so the two procedures cannot drift apart: at the preload where buckling
//! reports `λ = 1`, this reports `f₁ = 0`. Without a preload the addition never happens, and
//! the unprestressed answer is the same bits it always was.
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
use crate::error::{Error, ErrorCode, Warning};
use crate::fem::assembly::{assemble_stiffness, pattern, reduce, resolve, Csr, Pattern};
use crate::fem::checks;
use crate::fem::element::element_for;
use crate::fem::mpc;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, Per};
use crate::procedure::{blank, report, vector_field, StepResult};
use crate::solve::{direct::Direct, LinearSolve, SolveInfo, SolveOptions};

/// Relative Ritz-value stabilization, in addition to measured backward accuracy.
const TOL: f64 = 1e-10;
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

/// A preload past the buckling load, named as the modelling mistake it is.
///
/// Beyond the critical load `K + K_σ` has a negative eigenvalue, the shifted operator the
/// subspace iteration factorises is indefinite too, and no Cholesky of it exists. That comes
/// back from the linear algebra as `solve.not-positive-definite` pointing at the solver, which
/// is exactly the wrong place to look: the solver is fine and the *preload* is past the point
/// where the structure still stands. Only a prestressed Step rewrites it — an unprestressed
/// modal Step that fails to factorise has some other reason to, and keeps its own error.
fn past_buckling(e: Error, prestressed: bool) -> Error {
    if prestressed && e.code == ErrorCode::SolveNotPositiveDefinite {
        return Error::new(
            ErrorCode::ModelIllPosed,
            "the preload has passed the buckling load: K + K_sigma is indefinite, so the prestressed structure has no vibration about this state",
        )
        .at("after")
        .suggest("solve.run the preload Step at a smaller load, or step.add with procedure 'buckling' for the load factor that ends it");
    }
    e
}

/// Solve one modal Step: `n_modes` frequencies and their M-normalised shapes.
///
/// `prestress` is the preload displacement, one value per DOF, of the static Step this one
/// continues; `None` is the ordinary unprestressed analysis and adds nothing to `K`.
#[allow(clippy::too_many_arguments)]
pub fn run(
    p: &Problem<'_>,
    n_modes: usize,
    shift: Option<f64>,
    prestress: Option<&[f64]>,
    solver: &SolveOptions,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    if !solver.rel_tol.is_finite() || solver.rel_tol <= 0.0 {
        return Err(Error::schema("the modal backward-residual tolerance must be positive and finite")
            .at("tolerance")
            .suggest("solve.run with a positive finite tolerance, such as 1e-10"));
    }
    if solver.max_iterations == 0 {
        return Err(Error::schema("the modal sweep budget must be positive")
            .at("maxIterations")
            .suggest("solve.run with maxIterations greater than zero"));
    }
    checks::no_frictionless(p, "modal")?;
    // A free body is a legitimate modal model, so the rigid-mode check is not run here: its six
    // zero frequencies are the answer, not a failure. Everything else still applies.
    if let Some(e) = checks::all(p).into_iter().find(|e| e.code != ErrorCode::ConstraintRigidModes) {
        return Err(e);
    }
    report(&mut progress, "assemble", 0.1, "building the stiffness and mass matrices")?;
    let dpn = p.dofs_per_node();
    let pat = pattern(p.mesh, dpn);
    let (mut a, m) =
        pool.install(|| assemble_stiffness(p, &pat).and_then(|a| assemble_mass(p, &pat, false).map(|m| (a, m))))?;
    // The stress stiffening of the preload, added into `K` before anything is transformed or
    // reduced, so the multipoint transform, the constraint elimination and the free-DOF
    // numbering all see one operator. Adding zero is exact, so a preload that produced no
    // displacement leaves every bit of the unprestressed answer alone.
    if let Some(u) = prestress {
        let kg = pool.install(|| crate::procedure::buckling::assemble_geometric(p, &pat, u))?;
        for (v, g) in a.k.vals.iter_mut().zip(&kg.vals) {
            *v += g;
        }
    }
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
    let (lambda, shapes, sweeps, residual, unresolved) = pool
        .install(|| subspace(&red_k.k_ff, &red_m.k_ff, p_modes, shift, solver))
        .map_err(|e| past_buckling(e, prestress.is_some()))?;

    let mut res = blank(SolveInfo { solver: "cpu-direct", iterations: sweeps, rel_residual: residual, time_ms: 0.0 });
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
        res.modal_dofs.push(full);
    }
    res.warnings = mpc.warnings;
    for mode in unresolved {
        res.warnings.push(Warning {
            code: "modal.unresolved-frequency".into(),
            text: format!("mode {mode} is unresolved at the Rayleigh stiffness-contraction arithmetic cancellation scale; its backward residual passed, but relative frequency convergence is not certified. Inspect the mode shape and mesh.set a better-conditioned mesh before interpreting a near-zero frequency"),
            step: None,
            where_: Some(format!("mode:{mode}")),
        });
    }
    res.fields.insert(Field::Displacement, res.modes[0].clone());
    res.scalars.insert("min_det_j".to_string(), a.min_det_j);
    for axis in ["x", "y", "z"] {
        res.scalars.insert(format!("applied_total_{axis}"), 0.0);
    }
    res.scalars.insert("rel_residual".to_string(), residual);
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

/// Ascending eigenvalues, their M-orthonormal shapes, sweeps and maximum backward residual.
type Spectrum = (Vec<f64>, Vec<Vec<f64>>, usize, f64, Vec<usize>);

/// Subspace iteration for the `p` smallest eigenvalues of `K φ = λ M φ`.
fn subspace(k: &Csr, m: &Csr, p: usize, shift: Option<f64>, opts: &SolveOptions) -> Result<Spectrum, Error> {
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

    let mut y = vec![0.0; n];
    let mut bar: Vec<Vec<f64>> = vec![vec![0.0; n]; q];
    let mut prev = vec![f64::INFINITY; p];
    // No candidate exists before the first sweep. A finite sentinel permits that sweep;
    // thereafter budget exhaustion and a nonfinite measured candidate share one error exit.
    let mut residual = f64::MAX;
    let mut sweep = 0;
    while sweep < opts.max_iterations && residual.is_finite() {
        sweep += 1;
        for c in 0..q {
            m.spmv(&x[c], &mut y);
            // A factorization may still produce an unacceptable residual.
            factored.solve(&y, &mut bar[c])?;
        }
        orthonormalise(&mut bar);
        // K̂ = X̄ᵀ K X̄ and M̂ = X̄ᵀ M X̄, both q × q and symmetric by construction.
        let (k_hat, m_hat) = (project(k, &bar, q, n), project(m, &bar, q, n));
        let (lambda, z) = dense_eigen(&k_hat, &m_hat, q);
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
        // Certify the original, unshifted reduced pencil, not the inverse-iteration solve.
        // A small eigenvalue change alone neither certifies a shape nor handles rigid modes.
        residual = 0.0;
        let mut stable = true;
        let mut unresolved = Vec::new();
        for i in 0..p {
            let accuracy = pair_accuracy(k, m, lambda[i], &x[i]);
            residual = residual.max(accuracy.residual);
            if accuracy.unresolved {
                unresolved.push(i + 1);
            } else {
                stable &= (lambda[i] - prev[i]).abs() <= TOL * lambda[i].abs();
            }
        }
        prev[..p].copy_from_slice(&lambda[..p]);
        if residual <= opts.rel_tol && stable {
            return Ok((lambda[..p].to_vec(), x[..p].to_vec(), sweep, residual, unresolved));
        }
    }
    Err(not_converged(sweep, residual, opts.rel_tol))
}

fn not_converged(sweeps: usize, residual: f64, tolerance: f64) -> Error {
    Error::new(
        ErrorCode::SolveStalled,
        format!("modal iteration did not converge after {sweeps} sweeps: backward residual {residual:e} (target {tolerance:e}); resolved Ritz values must also stabilize to relative change {TOL:e}"),
    )
    .at("modal")
    .suggest("solve.run with a larger maxIterations budget, or mesh.set a better-conditioned mesh")
}

/// Normwise generalized-eigenpair backward residual:
/// `||Kφ − λMφ||∞ / ((||K||∞ + |λ| ||M||∞) ||φ||∞)`.
///
/// This is algebraic backward accuracy, not a frequency/continuum error estimate. Matrix
/// infinity norms are absolute row sums; the explicit vector norm makes the result invariant
/// under any nonzero shape normalization. Rigid modes never divide by λ. Scale the shape,
/// then both operators together before summing: neither huge mass-normalized shapes nor an
/// overflowing `|λ| ||M||` product may turn a bad pair into a reported zero residual.
struct PairAccuracy {
    residual: f64,
    unresolved: bool,
}

fn pair_accuracy(k: &Csr, m: &Csr, lambda: f64, phi: &[f64]) -> PairAccuracy {
    if !lambda.is_finite() || k.vals.iter().chain(&m.vals).chain(phi).any(|v| !v.is_finite()) {
        return PairAccuracy { residual: f64::INFINITY, unresolved: false };
    }
    let phi_norm = phi.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    if phi_norm == 0.0 {
        return PairAccuracy { residual: f64::INFINITY, unresolved: false };
    }
    // Use binary exponents before multiplying λ and M. Scaling a subnormal M by a tiny
    // λ first could underflow to zero, while λM can also exceed MAX for finite operands.
    let k_max = k.vals.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    let m_max = m.vals.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    let (_, k_exp) = libm::frexp(k_max);
    let (_, m_exp) = libm::frexp(m_max);
    let (lambda_mantissa, lambda_exp) = libm::frexp(lambda.abs());
    let exponent = if lambda == 0.0 || m_max == 0.0 {
        k_exp
    } else if k_max == 0.0 {
        m_exp + lambda_exp
    } else {
        k_exp.max(m_exp + lambda_exp)
    };
    let (mut residual, mut k_norm, mut m_norm) = (0.0_f64, 0.0_f64, 0.0_f64);
    let (mut absolute_stiffness, mut weighted_mass, mut mass) = (0.0, 0.0, 0.0);
    let mut max_row = 0;

    for row in 0..k.n {
        let (mut product, mut norm, mut absolute_product) = ([0.0; 3], [0.0; 3], [0.0; 3]);
        max_row = max_row.max(k.row_ptr[row + 1] - k.row_ptr[row]);
        for (index, (matrix, factor, power, common)) in
            [(k, 1.0, 0, exponent), (m, lambda_mantissa, lambda_exp, exponent), (m, 1.0, 0, m_exp)]
                .into_iter()
                .enumerate()
        {
            for at in matrix.row_ptr[row] as usize..matrix.row_ptr[row + 1] as usize {
                let (mantissa, e) = libm::frexp(matrix.vals[at]);
                let a = libm::scalbn(mantissa * factor, e + power - common);
                let term = a * (phi[matrix.col_idx[at] as usize] / phi_norm);
                product[index] += term;
                absolute_product[index] += term.abs();
                norm[index] += a.abs();
            }
        }
        let x = phi[row] / phi_norm;
        absolute_stiffness += x.abs() * absolute_product[0];
        weighted_mass += x * product[1];
        mass += x * product[2];
        residual = residual.max((product[0] - lambda.signum() * product[1]).abs());
        k_norm = k_norm.max(norm[0]);
        m_norm = m_norm.max(norm[1]);
    }
    let denominator = k_norm + m_norm;
    let residual = if denominator == 0.0 { 0.0 } else { residual / denominator };
    // Arithmetic resolution of a CSR matvec followed by a dot, using its operation depth,
    // not total nnz. Compare equally scaled contractions instead of dividing by a tiny mass.
    // This does NOT identify physical rigid modes or certify a near-zero frequency. A tiny
    // isolated soft mode has proportionally tiny |φ|ᵀ|K||φ| and remains resolved. If common
    // scaling erased a nonzero λM contraction, retain stabilization conservatively.
    let su = (2.0 * f64::from(max_row) + 2.0 * k.n as f64) * (f64::EPSILON / 2.0);
    let gamma = su / (1.0 - su);
    let unresolved = mass.is_finite()
        && mass > 0.0
        && (lambda == 0.0
            || (weighted_mass.is_finite() && weighted_mass > 0.0 && weighted_mass <= gamma * absolute_stiffness));
    PairAccuracy { residual, unresolved }
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

#[cfg(test)]
mod residual_tests {
    use super::*;

    fn backward_residual(k: &Csr, m: &Csr, lambda: f64, phi: &[f64]) -> f64 {
        pair_accuracy(k, m, lambda, phi).residual
    }

    #[test]
    fn rayleigh_resolution_distinguishes_rigid_and_genuinely_soft_pairs() {
        let m = diagonal(1.0, 1.0);
        let tiny = diagonal(1e-20, 1.0);
        assert!(!pair_accuracy(&tiny, &m, 1e-20, &[1.0, 0.0]).unresolved);
        let coupled = Csr {
            n: 2,
            row_ptr: vec![0, 2, 4],
            col_idx: vec![0, 1, 0, 1],
            vals: vec![1.0 + 5e-9, -1.0 + 5e-9, -1.0 + 5e-9, 1.0 + 5e-9],
        };
        assert!(!pair_accuracy(&coupled, &m, 1e-8, &[1.0, 1.0]).unresolved);
        let rigid = Csr { vals: vec![1.0, -1.0, -1.0, 1.0], ..coupled };
        assert!(pair_accuracy(&rigid, &m, 0.0, &[1.0, 1.0]).unresolved);
        // A roundoff-scale cancellation pair is warned; it is not claimed to be rigid.
        assert!(pair_accuracy(&rigid, &m, 1e-16, &[1.0, 1.0]).unresolved);
        assert!(!pair_accuracy(&diagonal(1e-200, 1e200), &m, 1e-200, &[1.0, 0.0]).unresolved);
        assert!(!pair_accuracy(&rigid, &diagonal(0.0, 0.0), 0.0, &[1.0, 1.0]).unresolved);
    }

    fn diagonal(a: f64, b: f64) -> Csr {
        Csr { n: 2, row_ptr: vec![0, 1, 2], col_idx: vec![0, 1], vals: vec![a, b] }
    }

    #[test]
    fn generalized_backward_residual_has_exact_and_wrong_pair_oracles() {
        let k = diagonal(2.0, 6.0);
        let m = diagonal(1.0, 2.0);
        assert_eq!(backward_residual(&k, &m, 2.0, &[1.0, 0.0]), 0.0);
        // r=[0,2], ||K||∞=6, ||2M||∞=4, ||φ||∞=1: η=2/10.
        assert_eq!(backward_residual(&k, &m, 2.0, &[1.0, 1.0]), 0.2);
        assert_eq!(backward_residual(&diagonal(-2.0, -6.0), &m, -2.0, &[1.0, 1.0]), 0.2);
        let rigid = diagonal(0.0, 2.0);
        assert_eq!(backward_residual(&rigid, &m, 0.0, &[1.0, 0.0]), 0.0);
        assert_eq!(backward_residual(&rigid, &m, 0.0, &[1.0, 1.0]), 1.0);
        assert_eq!(backward_residual(&diagonal(0.0, 0.0), &m, 0.0, &[1.0, 1.0]), 0.0);
        assert_eq!(backward_residual(&k, &diagonal(0.0, 0.0), 2.0, &[1.0, 1.0]), 1.0);
        for scale in [1e-200, -1e200] {
            assert!((backward_residual(&k, &m, 2.0, &[scale, scale]) - 0.2).abs() < 1e-15);
            assert!(
                (backward_residual(
                    &diagonal(2.0 * scale, 6.0 * scale),
                    &diagonal(scale, 2.0 * scale),
                    2.0,
                    &[1.0, 1.0]
                ) - 0.2)
                    .abs()
                    < 1e-15
            );
        }
    }

    #[test]
    fn generalized_backward_residual_does_not_hide_extreme_or_invalid_pairs() {
        let zero = diagonal(0.0, 0.0);
        let tiny = diagonal(f64::from_bits(1), f64::from_bits(1));
        // λM is below the smallest f64, but a nonzero λ with K=0 has η=1, not zero.
        assert_eq!(backward_residual(&zero, &tiny, 1e-100, &[1.0, 1.0]), 1.0);
        let huge = diagonal(f64::MAX, f64::MAX);
        assert_eq!(backward_residual(&zero, &huge, f64::MAX, &[f64::MAX, f64::MAX]), 1.0);
        assert_eq!(backward_residual(&tiny, &tiny, 1.0, &[f64::from_bits(1), f64::from_bits(1)]), 0.0);
        assert_eq!(backward_residual(&tiny, &tiny, 2.0, &[1.0, 1.0]), 1.0 / 3.0);
        for lambda in [f64::INFINITY, f64::NAN] {
            assert_eq!(backward_residual(&huge, &tiny, lambda, &[1.0, 1.0]), f64::INFINITY);
        }
        assert_eq!(backward_residual(&diagonal(f64::INFINITY, 1.0), &tiny, 1.0, &[1.0, 1.0]), f64::INFINITY);
        assert_eq!(backward_residual(&huge, &tiny, 1.0, &[f64::NAN, 1.0]), f64::INFINITY);
        assert_eq!(backward_residual(&huge, &tiny, 1.0, &[0.0, 0.0]), f64::INFINITY);
    }
}
