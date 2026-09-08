//! Linear (eigenvalue) buckling: the static stress state, its geometric stiffness, and the
//! smallest load factor that makes the two cancel.
//!
//! The Step solves `K u = f` exactly as a static one does, builds `K_σ(u)` from the Gauss-point
//! stress that state carries, and answers `(K + λ K_σ) φ = 0`, written as `K φ = λ (−K_σ) φ`.
//!
//! **Which operand is factorised is the whole design.** `−K_σ` is indefinite — a structure part
//! in tension and part in compression has both signs in it — so it cannot stand where the
//! modal iteration puts the mass matrix, which is Cholesky-factorised. So the small projected
//! problem is solved the other way round: `Ĝ z = ν K̂ z` with `K̂ = X̄ᵀKX̄` positive definite and
//! `Ĝ = X̄ᵀ(−K_σ)X̄` merely symmetric, and `λ = 1/ν`. [`crate::procedure::modal::dense_eigen`]
//! factorises its *second* operand, so it solves this unchanged.
//!
//! The subspace is `p + 8` vectors, never the modal path's `min(2p, p + 8)`: a square column and
//! a square plate both have degenerate buckling pairs, and a two-vector subspace cannot separate
//! a pair.
//!
//! There is one assembly and one factorisation. The stiffness, the reduced system, the
//! displacement *and* the factorisation all come from the static solve
//! ([`crate::procedure::static_::statics`]); the geometric stiffness reduces against the same
//! Constraints, and every sweep back-substitutes through the same factor.
//!
//! **What a load factor means.** `λ` multiplies the Step's Loads: `λ = 3` says three times this
//! load. A *negative* factor is not an error and is not filtered out — it says the structure
//! buckles under the reversed load, which is real information about a load you may yet reverse.
//! And the prediction is an upper bound: it ignores imperfections, pre-buckling rotation and
//! yielding, all of which lower the real capacity.

use std::cmp::Ordering;

use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::{reduce, Csr, Pattern};
use crate::fem::checks;
use crate::fem::element::element_for;
use crate::fem::mpc;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::procedure::modal::{dense_eigen, no_free_dofs, project};
use crate::procedure::{report, static_, vector_field, StepResult};
use crate::solve::{direct::Direct, SolveOptions};

/// Spare subspace vectors beyond the factors asked for. Wide enough to separate a degenerate
/// pair, which is why this is not the modal path's `min(2p, p + 8)`.
const EXTRA: usize = 8;
/// Relative change in the `p` retained Ritz values below which the subspace has converged.
const TOL: f64 = 1e-10;
/// Sweeps before the iteration settles for the best subspace it found.
const MAX_SWEEPS: usize = 60;
/// Largest `|ν|` that still counts as "the projected geometric stiffness is zero".
const NU_FLOOR: f64 = 1e-30;

/// `K_σ = Σ_e ∫ (∂N_a/∂x_i) σ_ij (∂N_b/∂x_j) δ_kl dV` over the whole mesh, into a fresh copy of
/// `pat.csr`.
///
/// It reuses the stiffness's own sparsity pattern, so the two operators have identical rows and
/// reduce against one set of constraints. Each element recomputes its own Gauss-point stress
/// from the gathered `u`: the integral wants unaveraged stress, and the nodal `Stress` field has
/// already been smoothed. Elements are integrated and scattered in ascending element order, so
/// `vals` is bit-identical at any thread count.
pub fn assemble_geometric(p: &Problem<'_>, pat: &Pattern, u: &[f64]) -> Result<Csr, Error> {
    let dpn = p.dofs_per_node();
    let mut kg = pat.csr.clone();
    let mut coords = Vec::new();
    let mut temperature = Vec::new();
    let mut ue = Vec::new();
    let mut ke = Vec::new();
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let ldpn = p.node_dofs(blk.kind);
        let (nn, nd) = (blk.kind.n_nodes(), blk.kind.n_nodes() * ldpn);
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(elem, &mut coords);
            temperature.clear();
            temperature.resize(nn, 0.0);
            p.gather_temperature(elem, &mut temperature);
            ue.clear();
            ue.resize(nd, 0.0);
            crate::fem::assembly::gather(u, p.mesh.elem_nodes(elem), ldpn, dpn, &mut ue);
            ke.clear();
            ke.resize(nd * nd, 0.0);
            // One `?`: the context and the geometric integral fail on the same material, and the
            // axisymmetric refusal is the element's, reported with the element it came from.
            p.ctx(elem, &coords, &temperature)
                .and_then(|c| element.geometric(&c, &ue, &mut ke))
                .map_err(|e| e.at(format!("element {elem}")))?;
            let slot = &pat.slot[pat.slot_ptr[elem as usize] as usize..pat.slot_ptr[elem as usize + 1] as usize];
            for (s, v) in slot.iter().zip(ke.iter()) {
                kg.vals[*s as usize] += v;
            }
        }
    }
    Ok(kg)
}

/// The `unsupported` error a buckling Step answers with when no factorisation is available.
///
/// The subspace iteration applies `K⁻¹` once per subspace vector per sweep — hundreds of
/// right-hand sides against one operator, which is exactly what a factorisation is for and what
/// an iterative solver does not build. Rather than quietly factorising a system the caller asked
/// to be solved iteratively — usually because it is too large to factorise — this says so.
fn needs_a_factorisation() -> Error {
    Error::new(
        ErrorCode::Unsupported,
        "linear buckling iterates against a factorisation of the stiffness, which the iterative solvers do not build",
    )
    .at("solver")
    .suggest("solve.run { solver: 'cpu-direct' }")
}

/// The `model.ill-posed` error a Step whose Loads leave the structure unstressed answers with.
fn no_stress() -> Error {
    Error::new(
        ErrorCode::ModelIllPosed,
        "the geometric stiffness is zero: this Step's Loads put no stress into the structure, so no load multiplies it into buckling",
    )
    .at("loads")
    .suggest("step.add listing a Load that stresses the structure, such as load.pressure on the loaded face")
}

/// The load factors, the shapes over the free DOFs, and the sweeps the iteration took.
type Buckled = (Vec<f64>, Vec<Vec<f64>>, usize);

/// Subspace iteration for the `p` load factors of smallest magnitude of `K φ = λ (−K_σ) φ`.
///
/// The iteration operator is `K⁻¹(−K_σ)`, whose dominant eigenvalues `ν` are the reciprocals of
/// the load factors closest to zero — so a plain power-like sweep converges to what a user
/// wants, without a shift.
fn subspace(k: &Csr, g: &Csr, p: usize, rel_tol: f64, factored: &mut Direct) -> Result<Buckled, Error> {
    let n = k.n;
    let q = (p + EXTRA).min(n);
    let kd = k.diag();
    let gd = g.diag();
    // Bathe's start vectors with `−K_σ` in the mass matrix's role: unit vectors at the DOFs
    // carrying the most stress per unit stiffness. The *first* vector is `K`'s diagonal rather
    // than the geometric one, because `K` is positive definite whatever the loads did — which
    // is what keeps `X̄ᵀKX̄` factorisable even for a Step whose Loads produce no stress at all,
    // so that case reaches the `|ν|` test below instead of a failed Cholesky.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| {
        let (ri, rj) = (libm::fabs(gd[i]) / kd[i], libm::fabs(gd[j]) / kd[j]);
        rj.partial_cmp(&ri).unwrap_or(Ordering::Equal).then(i.cmp(&j))
    });
    let mut x: Vec<Vec<f64>> = Vec::with_capacity(q);
    x.push(kd);
    for &i in order.iter().take(q - 1) {
        let mut v = vec![0.0; n];
        v[i] = 1.0;
        x.push(v);
    }
    let mut prev = vec![f64::INFINITY; p];
    let mut nu = vec![0.0; p];
    let mut shapes: Vec<Vec<f64>> = Vec::new();
    let mut y = vec![0.0; n];
    // The iterate improves monotonically, so running out of sweeps is not a failure: it is the
    // best subspace found, reported with the sweep count so a Result says how hard it was.
    let mut sweeps = 0;
    for sweep in 1..=MAX_SWEEPS {
        sweeps = sweep;
        // `Ĝ z = ν K̂ z`, indefinite operand first: `dense_eigen` factorises the second one.
        let (g_hat, k_hat) = (project(g, &x, q, n), project(k, &x, q, n));
        let (values, z) = dense_eigen(&g_hat, &k_hat, q);
        // `|ν|` descending, so the sign is reasoned about exactly once: after this the p-th
        // entry is the p-th smallest `|λ|`, and inverting carries its sign untouched.
        let mut idx: Vec<usize> = (0..q).collect();
        idx.sort_by(|&i, &j| {
            libm::fabs(values[j]).partial_cmp(&libm::fabs(values[i])).unwrap_or(Ordering::Equal).then(i.cmp(&j))
        });
        if libm::fabs(values[idx[0]]) <= NU_FLOOR {
            return Err(no_stress());
        }
        shapes = idx.iter().map(|&c| combine(&x, &z, c, q, n)).collect();
        for (slot, &c) in nu.iter_mut().zip(&idx) {
            *slot = values[c];
        }
        let done = (0..p).all(|i| libm::fabs(nu[i] - prev[i]) <= TOL * libm::fabs(nu[i]).max(f64::MIN_POSITIVE));
        prev.copy_from_slice(&nu);
        if done {
            break;
        }
        for (c, shape) in shapes.iter().enumerate() {
            g.spmv(shape, &mut y);
            // The Step's own tolerance, not the default: a factorisation may still produce an
            // unacceptable residual, and a slender column — exactly what a buckling Step is
            // usually about — is conditioned badly enough for that to be the user's call.
            factored.solve_with_tolerance(&y, &mut x[c], rel_tol)?;
        }
    }
    Ok((nu.iter().map(|v| 1.0 / v).collect(), shapes[..p].to_vec(), sweeps))
}

/// Column `c` of `X Z`: one Ritz vector of the current subspace.
fn combine(x: &[Vec<f64>], z: &[f64], c: usize, q: usize, n: usize) -> Vec<f64> {
    let mut col = vec![0.0; n];
    for (j, b) in x.iter().enumerate() {
        let zc = z[j * q + c];
        for (i, v) in col.iter_mut().enumerate() {
            *v += zc * b[i];
        }
    }
    col
}

/// Solve one linear buckling Step: the static state, then `n_modes` load factors and shapes.
///
/// The Result keeps the static solution in its fields — displacement, stress, reactions — so the
/// reaction balance still says whether the pre-buckling state was solved correctly, and the
/// shapes go in `modes` next to the factors, reachable as the field `mode:k` like any mode.
pub async fn run(
    p: &Problem<'_>,
    n_modes: usize,
    opts: &SolveOptions,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    checks::no_frictionless(p, "buckling")?;
    let mut s = static_::statics(p, opts, pool, gpu, &mut progress).await?;
    let n = s.red.k_ff.n;
    if n == 0 {
        return Err(no_free_dofs());
    }
    // The static solve's own factorisation, taken rather than rebuilt: one factorisation of the
    // reduced stiffness serves the equilibrium solve and every sweep of the iteration below.
    let Some(mut factored) = s.factored.take() else {
        return Err(needs_a_factorisation());
    };
    report(&mut progress, "assemble", 0.5, "building the geometric stiffness")?;
    let mut minus = pool.install(|| assemble_geometric(p, &s.pat, &s.u))?;
    // `−K_σ`, so the pair `(K, −K_σ)` is the one the projection below assumes.
    for v in minus.vals.iter_mut() {
        *v = -*v;
    }
    // The same `T`, the same Constraints and the same eliminated slaves the stiffness took, so
    // the two reduced operators are row-for-row the same numbering.
    let zeros = vec![0.0; minus.n];
    let (gt, _) = pool.install(|| mpc::transform(&minus, &zeros, &s.mpc));
    let red_g = reduce(&gt, &zeros, &s.rc, &s.mpc.slaves);
    report(&mut progress, "solve", 0.6, "subspace iteration")?;
    let (factors, shapes, sweeps) =
        pool.install(|| subspace(&s.red.k_ff, &red_g.k_ff, n_modes.clamp(1, n), opts.rel_tol, &mut factored))?;
    let dpn = p.dofs_per_node();
    let full: Vec<Vec<f64>> = shapes
        .iter()
        .map(|shape| {
            let mut v = vec![0.0; s.a.k.n];
            for (i, &dof) in s.red.free.iter().enumerate() {
                v[dof as usize] = shape[i];
            }
            mpc::recover(&s.mpc, &mut v);
            // Unit peak. A buckling shape has no amplitude of its own — it says *where* the
            // structure buckles, never how far — so the one scaling that means anything is the
            // one that makes the largest component 1.
            let peak = v.iter().fold(0.0f64, |m, x| m.max(libm::fabs(*x)));
            for x in v.iter_mut() {
                *x /= peak;
            }
            v
        })
        .collect();
    let mut res = static_::post(p, s, opts, 1.0, 1.0, None, 1, pool, gpu, progress).await?;
    // The sweeps, not the one static right-hand side: they are what this procedure spent.
    res.solver.iterations = sweeps;
    res.modes = full.iter().map(|v| vector_field(v, dpn)).collect();
    for (i, l) in factors.iter().enumerate() {
        res.scalars.insert(format!("buckling_factor_{}", i + 1), *l);
    }
    res.buckling_factors = factors;
    Ok(res)
}
