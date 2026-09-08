//! Static equilibrium with geometric nonlinearity: total Lagrangian, full Newton–Raphson,
//! load stepping with automatic cutback (PLAN 6.1).
//!
//! Everything the linear static procedure does is still here — the same checks, the same
//! sparsity pattern, the same linear solver, the same Result fields — with one difference: the
//! equilibrium it solves is `f_int(u) = λ f_ext` rather than `K u = f`, so it is solved
//! iteratively and the load is applied in increments.
//!
//! **Kinematics.** Total Lagrangian and nothing else: strains are Green–Lagrange, stresses are
//! second Piola–Kirchhoff, and both are integrated over the reference configuration
//! ([`Element::tangent_and_force`](crate::fem::element::Element::tangent_and_force)). The
//! existing linear elastic law, evaluated on `(E, S)` instead of `(ε, σ)`, *is* the St
//! Venant–Kirchhoff material, so this procedure adds no constitutive code at all. The Result's
//! stress field is Cauchy stress — what a gauge on the deformed part would read — and its
//! strain field is Green–Lagrange.
//!
//! **Pseudo-time.** One increment is a step in `t` over `[0, tEnd]`; the load factor is the
//! Step's `Amplitude` at `t`, or `t / tEnd` without one. A load–unload cycle is therefore one
//! Step with an amplitude table, not two Steps with state carried between them, which is what
//! keeps the Journal, the Model hash and staleness out of this entirely.
//!
//! **Robustness.** Full Newton with no line search. An increment that does not converge — or
//! folds an element, or reaches a tangent the direct solver finds indefinite, which is what a
//! plastic collapse mechanism looks like under load control — is halved and retried from the
//! last converged state, up to `maxCutbacks` times, after which the Step fails with
//! `newton.diverged` naming the increment, the load factor and the residual. Snap-through
//! needs arc-length control, which is #75 and is why the increment control lives in
//! [`next_increment`] with `λ` an explicit variable rather than inline.
//!
//! **Why not [`iterate`](super::iterate).** The shared fixed-point loop advances a state
//! vector and converges on its relative change, which is exactly right for a radiating heat
//! Step. A Newton increment is a different shape: it has a load factor, a residual criterion
//! measured against a force rather than a state, a per-point material state that is committed
//! or rolled back, an increment size that halves, and an `await` on the linear solve. It reads
//! the same `nonlinearTolerance` and `nonlinearMaxIterations` from `step.add`, because a user
//! should not have to learn two names for one idea.
//!
//! **What is not here.** Follower loads: the external force is deformation-independent, so a
//! pressure keeps the direction and the area it had on the reference mesh. A temperature field
//! is applied in full at every increment rather than ramped with `λ`, because the Problem's
//! temperature is a field rather than a Load. Both are stated on `Procedure::StaticNonlinear`.

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode, Warning};
use crate::fem::assembly::{self, Assembled, NlInput, Pattern, ResolvedConstraints};
use crate::fem::checks;
use crate::fem::contact::{self, ActiveSet};
use crate::fem::element::element_for;
use crate::fem::loads::{self, LoadTotals};
use crate::fem::material::PEEQ;
use crate::fem::mpc::{self, Mpc};
use crate::fem::problem::Problem;
use crate::fem::state::GpState;
use crate::model::Idealisation;
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, stress, FieldData, Per};
use crate::procedure::{report, vector_field, Amplitude, History, StepResult};
use crate::solve::{solve, SolveInfo, SolveOptions};

use femlab_geometry::ElementKind;

/// Halvings a Step may ask for. Each one doubles the increments left to run, so the bound is
/// what keeps a pathological Model finite rather than merely slow.
const MAX_CUTBACKS: usize = 20;

/// The linear-solver report before any correction has been taken. No increment converges on
/// its first pass — the displacement criterion starts at infinity — so this is the shape of a
/// value rather than a result, and a constant costs no branch nobody can cover.
const NO_SOLVE: SolveInfo = SolveInfo { solver: "none", iterations: 0, rel_residual: 0.0, time_ms: 0.0 };

/// Floor under the reference force and displacement of the convergence tests, so an increment
/// that asks for nothing converges instead of dividing by zero.
const FLOOR: f64 = 1e-30;

/// How exactly a Newton correction has to be solved. Inexact on purpose: a correction is a
/// *direction*, the next residual measures how far it actually got, and near convergence its
/// right-hand side is itself round-off — so a linear solve held to the accuracy of the answer
/// would refuse a correction that is perfectly good to iterate on. The nonlinear tolerance is
/// the gate; a Step that asks for something looser than this keeps what it asked for.
const CORRECTION_TOL: f64 = 1e-6;

/// When a Newton iteration is finished. Both criteria are relative and both must hold.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Converge {
    /// Relative tolerance on the residual force and on the displacement correction.
    pub tolerance: f64,
    /// Iterations allowed in one increment before the increment is cut back.
    pub max_newton: usize,
}

/// Everything a nonlinear Step is driven by.
#[derive(Debug, Clone)]
pub struct Options {
    /// Equal increments of pseudo-time over `[0, t_end]` before any cutback.
    pub increments: usize,
    pub converge: Converge,
    /// Halvings allowed over the whole Step; the `(increments · 2^max_cutbacks)` bound this
    /// puts on the increment count is what stops a pathological model running forever.
    pub max_cutbacks: usize,
    pub t_end: f64,
    /// `λ(t)`; without one the load factor is `t / t_end`.
    pub amplitude: Option<Amplitude>,
    /// The *linear* solver each Newton correction goes through.
    pub solver: SolveOptions,
}

/// What one assembly at a trial displacement produces: `k` is the consistent tangent `K_T`,
/// `f_int` the internal force, `stress_gp` and `strain_gp` the Gauss-point fields, and `state`
/// the advanced per-point material state.
///
/// It is [`Assembled`] itself rather than a copy of four of its fields, so the residual
/// `r = λ f_ref − f_int` that #62's contact and #75's arc-length both need to reach into is
/// formed from exactly the values the assembler produced.
pub type Tangent = Assembled;

/// The consistent tangent and internal force at a trial displacement.
pub fn tangent(p: &Problem<'_>, pat: &Pattern, u: &[f64], state: &GpState) -> Result<Tangent, Error> {
    assembly::assemble_tangent(p, pat, Some(NlInput { u, state }))
}

/// The external force at load factor 1, and the applied total that goes with it.
///
/// Deformation-independent, so it is assembled once for the whole Step and every increment is
/// a multiple of it. The thermal load is *not* part of it: under finite strain the thermal
/// strain is subtracted inside the element, so it is already in `f_int`.
pub fn reference_load(p: &Problem<'_>) -> Result<(Vec<f64>, LoadTotals), Error> {
    let mut f = vec![0.0; p.n_dofs()];
    let applied = loads::assemble_loads(p, &mut f)?;
    Ok((f, applied))
}

/// The infinity norm, in index order and NaN-preserving.
///
/// `f64::max` swallows a NaN, and a residual that has gone non-finite is precisely what the
/// cutback has to see, so this compares rather than folds. Fixed order, so the convergence
/// *decision* is the same at 1 and N threads (ADR 0013).
pub fn norm_inf(v: &[f64]) -> f64 {
    let mut m = 0.0f64;
    for x in v {
        let a = x.abs();
        if a.is_nan() {
            return f64::NAN;
        }
        if a > m {
            m = a;
        }
    }
    m
}

/// Both convergence criteria, both relative: the residual against the largest force the Step
/// has carried so far, and the last correction against the displacement this increment has
/// accumulated.
///
/// `force` is the running peak rather than the current force on purpose. Unloading back to
/// zero — the second half of a load cycle — drives the residual and the current internal force
/// to zero together, and a criterion measured against the current force would then never be
/// met however exactly the equilibrium was found.
pub fn converged(c: &Converge, residual: f64, force: f64, correction: f64, increment: f64) -> bool {
    residual.is_finite()
        && residual <= c.tolerance * force.max(FLOOR)
        && correction <= c.tolerance * increment.max(FLOOR)
}

/// The load factor at pseudo-time `t`.
pub fn load_factor(o: &Options, t: f64) -> f64 {
    o.amplitude.as_ref().map_or(t / o.t_end, |a| a.at(t))
}

/// The next increment size after an attempt: unchanged when it converged, halved when it did
/// not. #75 replaces this with an arc-length control and nothing else in the loop moves.
pub fn next_increment(dt: f64, converged: bool) -> f64 {
    if converged {
        dt
    } else {
        0.5 * dt
    }
}

/// The Step's controls, checked before anything is assembled.
fn check(o: &Options) -> Result<(), Error> {
    let positive = |v: f64| v.is_finite() && v > 0.0;
    for (bad, field, fix) in [
        (o.increments == 0, "increments", "step.add with increments of 1 or more"),
        (o.converge.max_newton == 0, "nonlinearMaxIterations", "step.add with nonlinearMaxIterations of 1 or more"),
        (!positive(o.converge.tolerance), "nonlinearTolerance", "step.add with a positive nonlinearTolerance"),
        (!positive(o.t_end), "tEnd", "step.add with a positive tEnd"),
        (o.max_cutbacks > MAX_CUTBACKS, "maxCutbacks", "step.add with maxCutbacks of 20 or fewer"),
    ] {
        if bad {
            return Err(Error::schema(format!("the 'static-nonlinear' procedure cannot run with this {field}"))
                .at(field)
                .suggest(fix));
        }
    }
    Ok(())
}

/// The idealisations this kernel covers. Plane stress needs the condensed thickness stretch to
/// form `det F`, and axisymmetry needs the hoop row of `B_L` and its own `K_geo` term; neither
/// is silently approximated here.
fn supported(idealisation: &Idealisation) -> Result<(), Error> {
    let what = match idealisation {
        Idealisation::Solid3d | Idealisation::PlaneStrain => return Ok(()),
        Idealisation::PlaneStress { .. } => "plane stress",
        Idealisation::Axisymmetric { .. } => "axisymmetric",
    };
    Err(Error::new(
        ErrorCode::Unsupported,
        format!("the 'static-nonlinear' procedure has no finite-strain kernel for the {what} idealisation"),
    )
    .at("idealisation")
    .suggest("model.setIdealisation with kind solid3d or planeStrain, or step.add with procedure static"))
}

/// `newton.diverged`: which increment, at what load factor, with what residual, and the way out.
fn diverged(increment: usize, lambda: f64, residual: f64, o: &Options) -> Error {
    Error::new(
        ErrorCode::NewtonDiverged,
        format!(
            "increment {increment} at load factor {lambda:.6} did not converge in {} iterations after {} cutbacks; \
             last relative residual {residual:.2e}",
            o.converge.max_newton, o.max_cutbacks
        ),
    )
    .at("step")
    .suggest("step.add with more increments, a larger nonlinearMaxIterations, or a smaller final load")
}

/// The equivalent plastic strain at every Gauss point, elements in order: the state slot each
/// element's law names [`PEEQ`], zero for a law without one. `None` when no material of the
/// Problem has such a slot, so an elastic Model reports no plastic strain rather than a field
/// of zeros.
pub fn plastic_strain_gp(p: &Problem<'_>, state: &GpState) -> Option<FieldData> {
    let plastic = p.materials.iter().any(|m| m.law.state_names().contains(&PEEQ));
    if !plastic {
        return None;
    }
    let mut data = Vec::new();
    for elem in 0..p.mesh.n_elems() as u32 {
        let law = p.material_of(elem).expect("the checks found a material for every element").law;
        let n_gp = element_for(p.mesh.kind_of(elem)).n_gp();
        let ns = law.n_state();
        let slot = law.state_names().iter().position(|name| *name == PEEQ);
        let st = state.of(elem);
        data.extend((0..n_gp).map(|g| slot.map_or(0.0, |k| st[g * ns + k])));
    }
    Some(FieldData::new(Per::ElemGp, 1, data))
}

/// The fraction of the Gauss points that have yielded: those with a positive equivalent plastic
/// strain. By point, not by volume, so it is a count and no element measure enters.
pub fn yielded_fraction(peeq: &FieldData) -> f64 {
    let yielded = peeq.data.iter().filter(|v| **v > 0.0).count();
    yielded as f64 / peeq.data.len().max(1) as f64
}

/// Elements whose enhanced modes the finite-strain kernel switches off.
fn locking_kinds(p: &Problem<'_>) -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = p
        .mesh
        .blocks
        .iter()
        .filter_map(|b| match b.kind {
            ElementKind::Hex8 => Some("hex8"),
            ElementKind::Quad4 => Some("quad4"),
            _ => None,
        })
        .collect();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

/// How one increment ended.
enum Attempt {
    /// The displacement it converged to, the assembly there, the iterations it took and the
    /// last linear solve it went through.
    Converged(Vec<f64>, Box<Tangent>, usize, SolveInfo),
    /// It did not, after this many iterations and at this residual; halve and retry.
    CutBack(usize, f64),
}

/// Everything a Newton iteration needs that does not change between increments.
struct Newton<'a> {
    p: &'a Problem<'a>,
    pat: &'a Pattern,
    o: &'a Options,
    /// The prescribed values at load factor 1.
    rc: &'a ResolvedConstraints,
    /// The same DOFs at zero: every correction solves the homogeneous Dirichlet system.
    rc_zero: &'a ResolvedConstraints,
    /// True on the free DOFs. The residual and the force norms are measured there only,
    /// because a constrained DOF's out-of-balance is its reaction, not an error.
    free: Vec<bool>,
    /// The multipoint constraints, eliminated the same way the linear Step eliminates them:
    /// `TᵀK_T T` and `Tᵀr` per iteration, the slaves dropped from the free set, and the
    /// correction recovered onto them afterwards. With every frictionless candidate's row in
    /// it; an increment works on [`Mpc::with_active`] of it.
    base: &'a Mpc,
    f_ref: &'a [f64],
    /// `|f_ref|_inf`, which does not change between increments.
    f_ref_norm: f64,
    pool: &'a Pool,
    gpu: Option<&'a crate::gpu::Gpu>,
}

impl Newton<'_> {
    /// One increment, from the last converged displacement and state to `lambda`.
    ///
    /// `set` is the active set of the frictionless candidates. It is consulted only at a
    /// converged state: the contact force at a slave DOF is a constraint force only in
    /// equilibrium, so a set read off a half-corrected residual would release nodes that a
    /// converged one holds. When the converged state moves the set, the constraints change,
    /// `u` is snapped onto the new master surface and the iteration goes on; the increment is
    /// accepted only once both the residual and the set have stopped moving.
    #[allow(clippy::too_many_arguments)]
    async fn increment(
        &self,
        u_conv: &[f64],
        committed: &GpState,
        lambda: f64,
        number: usize,
        scale: &mut f64,
        set: &mut ActiveSet,
        progress: &mut OnProgress<'_>,
    ) -> Result<Attempt, Error> {
        let o = self.o;
        let dpn = self.p.dofs_per_node();
        // The prescribed displacements are applied once, at the top of the increment; the
        // corrections that follow leave them alone because `rc_zero` holds them at zero.
        let mut u = u_conv.to_vec();
        for &(dof, value) in &self.rc.fixed {
            u[dof as usize] = lambda * value;
        }
        // `held` carries `g` and puts `u` itself on the master surface; `corr` is the same set
        // with `g = 0`, for the corrections, which must keep a satisfied constraint satisfied.
        let mut held = self.base.with_active(&set.active, true, dpn);
        let mut corr = self.base.with_active(&set.active, false, dpn);
        mpc::recover(&held, &mut u);
        // No correction has been taken yet, so the displacement criterion cannot be met on the
        // first pass: a nonlinear increment always costs at least one solve.
        let mut correction = f64::INFINITY;
        let mut residual = f64::INFINITY;
        let mut info = NO_SOLVE;
        let mut iteration = 0;
        loop {
            let a = match self.pool.install(|| tangent(self.p, self.pat, &u, committed)) {
                Ok(a) => a,
                // A folded deformed element is what a too-large increment looks like from
                // inside the element loop; anything else is a real failure of the Model.
                Err(e) if e.code == ErrorCode::MeshInverted => {
                    return Ok(Attempt::CutBack(iteration, residual / scale.max(FLOOR)))
                }
                Err(e) => return Err(e),
            };
            // The residual lives on the free DOFs — a constrained DOF's out-of-balance is its
            // reaction, not an error — but the *forces* it is measured against are the whole
            // vectors, because in a displacement-driven Step the reaction is the only force.
            let mut r = vec![0.0; u.len()];
            for (i, free) in self.free.iter().enumerate() {
                if *free {
                    r[i] = lambda * self.f_ref[i] - a.f_int[i];
                }
            }
            let external = lambda.abs() * self.f_ref_norm;
            let internal = norm_inf(&a.f_int);
            // The residual is measured on the *reduced* system: what a tie carries at a slave
            // DOF is a constraint force, not an out-of-balance, exactly as a support reaction
            // at a fixed DOF is not one. `transform` copies the whole operator, and a Newton
            // Step would pay for that once per iteration rather than once per Step, so a Model
            // with no ties goes straight to `reduce`.
            let tied = (!corr.is_empty()).then(|| mpc::transform(&a.k, &r, &corr));
            let (kt, rt) = tied.as_ref().map_or((&a.k, r.as_slice()), |(k, f)| (k, f.as_slice()));
            let red = assembly::reduce(kt, rt, self.rc_zero, &corr.slaves);
            residual = norm_inf(&red.f_f);
            *scale = scale.max(external).max(internal);
            let increment: Vec<f64> = u.iter().zip(u_conv).map(|(a, b)| a - b).collect();
            if converged(&o.converge, residual, *scale, correction, norm_inf(&increment)) {
                // Equilibrium on this set: now the slave residuals are contact forces.
                let out_of_balance: Vec<f64> = a.f_int.iter().zip(self.f_ref).map(|(i, e)| i - lambda * e).collect();
                let stiffness = a.k.diag().into_iter().fold(0.0f64, f64::max);
                // Chatter and a host saying stop both end the increment here, as one error.
                let moved = set.update(self.p, &held, &u, &out_of_balance, stiffness).and_then(|moved| {
                    if moved {
                        let text = format!(
                            "increment {number}: active set changed, {} of {} paired nodes in contact",
                            set.count(),
                            set.active.len()
                        );
                        report(
                            progress,
                            "contact",
                            0.05 + 0.85 * ((number - 1) as f64 / o.increments as f64).min(1.0),
                            &text,
                        )?;
                    }
                    Ok(moved)
                })?;
                if !moved {
                    return Ok(Attempt::Converged(u, Box::new(a), iteration, info));
                }
                held = self.base.with_active(&set.active, true, dpn);
                corr = self.base.with_active(&set.active, false, dpn);
                mpc::recover(&held, &mut u);
                correction = f64::INFINITY;
                iteration += 1;
                if iteration > o.converge.max_newton {
                    return Ok(Attempt::CutBack(iteration, residual / scale.max(FLOOR)));
                }
                continue;
            }
            let relative = residual / scale.max(FLOOR);
            if iteration == o.converge.max_newton || !residual.is_finite() {
                return Ok(Attempt::CutBack(iteration, relative));
            }
            // The fraction advances with the increment, never inside it: a cut-back increment
            // is retried, and a progress bar that walked backwards would look like a fault.
            report(
                progress,
                "newton",
                0.05 + 0.85 * ((number - 1) as f64 / o.increments as f64).min(1.0),
                &format!("increment {number}, iteration {iteration}, relative residual {relative:.2e}"),
            )?;
            let inexact = SolveOptions { rel_tol: o.solver.rel_tol.max(CORRECTION_TOL), ..o.solver };
            let (du_f, solved) = match solve(&red.k_ff, &red.f_f, &inexact, self.pool, self.gpu, progress).await {
                Ok(s) => s,
                // A tangent that has lost positive definiteness is a structure at or past a
                // limit point — a plastic collapse mechanism under load control — and is the
                // other signal, with a folded element, that this increment asked for too much.
                // The cutback retries from the last equilibrium; when no increment can be
                // carried the Step ends with `newton.diverged` naming the load factor reached.
                Err(e) if e.code == ErrorCode::SolveNotPositiveDefinite => {
                    return Ok(Attempt::CutBack(iteration, relative))
                }
                Err(e) => return Err(e),
            };
            let mut du = assembly::expand(&red, &du_f);
            mpc::recover(&corr, &mut du);
            for (ui, d) in u.iter_mut().zip(&du) {
                *ui += d;
            }
            correction = norm_inf(&du);
            info = solved;
            iteration += 1;
        }
    }
}

/// Solve one nonlinear static Step.
pub async fn run(
    p: &Problem<'_>,
    o: &Options,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    check(o)?;
    supported(&p.idealisation)?;
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    report(&mut progress, "assemble", 0.05, "building the sparsity pattern")?;
    let dpn = p.dofs_per_node();
    let pat = assembly::pattern(p.mesh, dpn);
    // The checks have already established every Load's Set, every Body's material and every
    // element's Jacobian, which are the only three things a load assembly can fail on — the
    // same reasoning `resolve` below is called with.
    let (f_ref, applied) = pool.install(|| reference_load(p)).expect("the checks accepted every Load Set and material");
    // `checks::all` has already resolved these and found no conflict.
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let rc_zero = ResolvedConstraints {
        fixed: rc.fixed.iter().map(|&(d, _)| (d, 0.0)).collect(),
        owner: rc.owner.clone(),
        inert: rc.inert.clone(),
    };
    let mut free = vec![true; p.n_dofs()];
    for &(dof, _) in &rc.fixed {
        free[dof as usize] = false;
    }
    let f_ref_norm = norm_inf(&f_ref);
    // `checks::all` has already paired every contact.
    let base = mpc::build(p).expect("the checks built the multipoint constraints");
    let newton =
        Newton { p, pat: &pat, o, rc: &rc, rc_zero: &rc_zero, free, base: &base, f_ref: &f_ref, f_ref_norm, pool, gpu };

    let mut u = vec![0.0; p.n_dofs()];
    let mut committed = GpState::new(p).expect("the checks found a material for every element");
    let mut set = ActiveSet::initial(&base);
    let mut dt = o.t_end / o.increments as f64;
    let mut t = 0.0;
    let mut lambda = 0.0;
    let (mut cutbacks, mut iterations, mut taken) = (0usize, 0usize, 0usize);
    let mut history = History { field: Field::Displacement, times: vec![0.0], values: vec![u.clone()] };
    let mut converged_at = None;
    let mut solved = NO_SOLVE;
    // The largest force the Step has carried, which every residual is measured against.
    let mut scale = 0.0f64;
    while t < o.t_end {
        // Reaching the end within a rounding error *is* reaching it. Ten increments of a tenth
        // land a few ulps short, and the sliver left over would be an increment that asks for
        // no displacement change at all — which no relative displacement criterion can meet.
        let t_next = if t + dt >= o.t_end * (1.0 - 1e-9) { o.t_end } else { t + dt };
        let lambda_next = load_factor(o, t_next);
        // A cut-back increment retries from the last converged state, active set included.
        let mut trial = set.clone();
        let attempt =
            newton.increment(&u, &committed, lambda_next, taken + 1, &mut scale, &mut trial, &mut progress).await?;
        let ok = match attempt {
            Attempt::Converged(u_next, a, its, info) => {
                iterations += its;
                taken += 1;
                t = t_next;
                lambda = lambda_next;
                u = u_next;
                set = trial;
                committed = a.state.clone();
                history.times.push(lambda);
                history.values.push(u.clone());
                converged_at = Some(a);
                solved = info;
                true
            }
            Attempt::CutBack(its, residual) => {
                iterations += its;
                cutbacks += 1;
                if cutbacks > o.max_cutbacks {
                    return Err(diverged(taken + 1, lambda_next, residual, o));
                }
                false
            }
        };
        dt = next_increment(dt, ok);
    }
    let a = *converged_at.expect("a Step with at least one increment converges or fails");
    report(&mut progress, "post", 0.9, "recovering fields")?;

    // Reactions are the internal force the supports carry against the external one, which is
    // the finite-strain reading of `K u − f`, plus the tie force a bonded contact hands to its
    // masters — a tie's own internal force is never a support reaction.
    let mpc = base.with_active(&set.active, true, dpn);
    let out_of_balance: Vec<f64> =
        a.f_int.iter().zip(&f_ref).map(|(internal, external)| internal - lambda * external).collect();
    let mut tie = vec![0.0; u.len()];
    mpc::master_forces(&mpc, &out_of_balance, &mut tie);
    let mut reactions = vec![0.0; u.len()];
    for &(dof, _) in &rc.fixed {
        reactions[dof as usize] = out_of_balance[dof as usize] + tie[dof as usize];
    }
    let unaveraged = stress::gp_to_nodes(p.mesh, &a.stress_gp);
    let nodal_stress = stress::average_at_nodes(p, &unaveraged);
    let nodal_strain = stress::average_at_nodes(p, &stress::gp_to_nodes(p.mesh, &a.strain_gp));
    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&u, dpn));
    fields.insert(Field::Reaction, vector_field(&reactions, dpn));
    fields.insert(Field::VonMises, stress::von_mises(&nodal_stress));
    fields.insert(Field::Principal, stress::principal(&nodal_stress));
    fields.insert(Field::Stress, nodal_stress);
    fields.insert(Field::StressUnaveraged, unaveraged);
    fields.insert(Field::Strain, nodal_strain);
    let mut scalars = BTreeMap::new();
    if let Some(peeq) = plastic_strain_gp(p, &a.state) {
        scalars.insert("yielded_fraction".to_string(), yielded_fraction(&peeq));
        fields.insert(Field::PlasticStrain, stress::average_at_nodes(p, &stress::gp_to_nodes(p.mesh, &peeq)));
    }
    let mut warnings = mpc.warnings.clone();
    let mut contacts = Vec::new();
    if !set.is_empty() {
        let (pressure, summaries) = contact::finish(p, &mpc, &set, &out_of_balance, &mut warnings);
        fields.insert(Field::ContactPressure, pressure);
        contacts = summaries;
        scalars.insert("contact_changes".to_string(), set.changes as f64);
    }
    scalars.insert("min_det_j".to_string(), a.min_det_j);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        scalars.insert(format!("applied_total_{axis}"), lambda * applied.force[c]);
    }
    scalars.insert("rel_residual".to_string(), solved.rel_residual);
    scalars.insert("increments_taken".to_string(), taken as f64);
    scalars.insert("newton_iterations".to_string(), iterations as f64);
    scalars.insert("cutbacks".to_string(), cutbacks as f64);
    scalars.insert("load_factor".to_string(), lambda);
    let ex = fields
        .iter()
        .filter(|(_, f)| f.per == Per::Node)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    let per_constraint = reactions_per_constraint(p, &rc, &fields[&Field::Reaction]);
    let locking = locking_kinds(p);
    if !locking.is_empty() {
        warnings.push(Warning {
            code: "nlgeom.incompatibleModes".to_string(),
            text: format!(
                "incompatible modes are off under finite deformation, so the {} elements integrate fully and \
                 lock in bending; use mesh.set with order 2 for a quadratic element",
                locking.join(" and ")
            ),
            where_: Some("formulation".to_string()),
        });
    }
    Ok(StepResult {
        reaction_quantity: crate::units::ReactionQuantity::Force,
        fields,
        scalars,
        extremes: ex,
        reactions: per_constraint,
        frequencies: Vec::new(),
        buckling_factors: Vec::new(),
        modes: Vec::new(),
        modal_dofs: Vec::new(),
        history: Some(history),
        sweep: None,
        prestress_from: None,
        // The Step's own iteration count, not the last linear solve's: a nonlinear Step is
        // measured in Newton iterations, and `solver` names the linear solver each went through.
        solver: SolveInfo { iterations, ..solved },
        warnings,
        assumptions: Vec::new(),
        contacts,
    })
}

#[cfg(test)]
mod tests {
    use super::{converged, load_factor, next_increment, norm_inf, Converge, Options};
    use crate::procedure::Amplitude;
    use crate::solve::SolveOptions;

    fn options(amplitude: Option<Amplitude>) -> Options {
        Options {
            increments: 4,
            converge: Converge { tolerance: 1e-8, max_newton: 20 },
            max_cutbacks: 5,
            t_end: 2.0,
            amplitude,
            solver: SolveOptions::default(),
        }
    }

    #[test]
    fn the_infinity_norm_is_the_largest_magnitude_and_keeps_a_nan() {
        assert_eq!(norm_inf(&[]), 0.0);
        assert_eq!(norm_inf(&[1.0, -3.5, 2.0]), 3.5);
        assert_eq!(norm_inf(&[f64::INFINITY, 1.0]), f64::INFINITY);
        assert!(norm_inf(&[1.0, f64::NAN, 1e300]).is_nan());
    }

    #[test]
    fn both_criteria_must_hold_and_a_zero_increment_still_converges() {
        let c = Converge { tolerance: 1e-8, max_newton: 20 };
        assert!(converged(&c, 1e-9, 1.0, 1e-12, 1e-3));
        assert!(!converged(&c, 1e-7, 1.0, 1e-12, 1e-3), "the force criterion alone is not enough");
        assert!(!converged(&c, 1e-9, 1.0, 1e-4, 1e-3), "nor is the displacement criterion alone");
        assert!(converged(&c, 0.0, 0.0, 0.0, 0.0), "an increment that asks for nothing is converged");
        assert!(!converged(&c, f64::INFINITY, f64::INFINITY, 0.0, 1.0), "an infinite residual is not converged");
    }

    #[test]
    fn the_load_factor_ramps_linearly_without_an_amplitude_and_follows_one_with() {
        let plain = options(None);
        assert_eq!(load_factor(&plain, 0.5), 0.25);
        assert_eq!(load_factor(&plain, 2.0), 1.0);
        let table = options(Some(Amplitude::Table { t: vec![0.0, 1.0, 2.0], value: vec![0.0, 1.0, -1.0] }));
        assert_eq!(load_factor(&table, 1.0), 1.0);
        assert_eq!(load_factor(&table, 1.5), 0.0);
        assert_eq!(load_factor(&table, 2.0), -1.0);
    }

    #[test]
    fn an_increment_halves_only_when_it_failed() {
        assert_eq!(next_increment(0.25, true), 0.25);
        assert_eq!(next_increment(0.25, false), 0.125);
    }
}
