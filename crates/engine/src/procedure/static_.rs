//! Linear static equilibrium: checks → pattern → assemble → reduce → solve → expand →
//! reactions → post (plan A §6).
//!
//! With an `amplitude` the same Step is stepped in time. Linear static is **affine** in that
//! amplitude, not proportional: `u(t) = u_th + g(t)·u_L`, where `u_th` answers the thermal load
//! alone at zero prescribed values and `u_L` is everything `g` scales. So the whole schedule
//! costs at most two solves against one reduced system, and the temperature field is
//! deliberately left unscaled — that is what keeps the recovered stress consistent with the
//! `αΔT` term [`crate::fem::element::Element::recover`] subtracts.

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode};
use crate::fem::contact::{self, ActiveSet};
use crate::fem::problem::{Coupling, Problem};
use crate::fem::{assembly, checks, loads, mpc};
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, stress, FieldData, Per};
use crate::procedure::{
    report, retained_frame_count, rotation_field, time_grid, vector_field, Amplitude, History, StepResult,
};
use crate::solve::{direct::Direct, solve, solve_reusable, LinearSolve, SolveInfo, SolveOptions};

/// The retained frames of an amplituded Step, from the two solved parts of `u(t) = u_th + g·u_L`.
///
/// ponytail: linear static is affine in its forcing, so an increment is one scaling of two
/// solved vectors rather than a re-solve. That is exact only while the procedure is linear;
/// when a nonlinear material, contact or large deflection lands, this becomes a real increment
/// loop driven by the shared nonlinear iteration.
fn ramp(u: &[f64], u_th: &[f64], amp: &Amplitude, steps: usize, dt: f64, t_end: f64, output_every: usize) -> History {
    let u_l: Vec<f64> = u.iter().zip(u_th).map(|(all, th)| all - th).collect();
    let at = |g: f64| u_th.iter().zip(&u_l).map(|(th, l)| th + g * l).collect::<Vec<f64>>();
    let every = output_every.max(1);
    let frames = retained_frame_count(steps, every).expect("time_grid bounds the retained-frame count");
    let mut history = History::with_initial(Field::Displacement, at(amp.at(0.0)), frames);
    for step in 1..=steps {
        if step % every == 0 || step == steps {
            // The last increment lands on the requested endpoint exactly, not on `steps · dt`.
            let time = if step == steps { t_end } else { step as f64 * dt };
            history.times.push(time);
            history.values.push(at(amp.at(time)));
        }
    }
    history
}

/// Everything the static solve produced and a caller that wants more than a Result needs: the
/// operator, the reduced system it was solved against, and the displacement.
///
/// Linear buckling is that caller. It reuses all of this rather than assembling and factorising
/// a second time, and reduces its geometric stiffness against the very same `pat`, `rc` and
/// `mpc`, so both operators of the eigenproblem carry identical row numbering.
pub(crate) struct Statics {
    pub pat: assembly::Pattern,
    pub a: assembly::Assembled,
    pub applied: loads::LoadTotals,
    /// The load vector the reactions are measured against; an amplitude scales it in [`post`].
    pub f: Vec<f64>,
    pub rc: assembly::ResolvedConstraints,
    pub mpc: mpc::Mpc,
    pub red: assembly::Reduced,
    pub u: Vec<f64>,
    pub solver: crate::solve::SolveInfo,
    /// The factorisation the direct path built, so a caller that needs many more right-hand
    /// sides against `red.k_ff` pays for one. `None` when an iterative solver ran.
    pub factored: Option<crate::solve::direct::Direct>,
}

/// Assemble, constrain, reduce and solve `K u = f` once.
pub(crate) async fn statics(
    p: &Problem<'_>,
    opts: &SolveOptions,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    progress: &mut OnProgress<'_>,
) -> Result<Statics, Error> {
    // `solve.run` refuses with the first failing check; `query.model.warnings` lists them all.
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    report(progress, "assemble", 0.1, "building the sparsity pattern")?;
    let dpn = p.dofs_per_node();
    let pat = assembly::pattern(p.mesh, dpn);
    // One `?`: the loads and the stiffness fail on the same materials and the same Sets, both
    // of which `checks::all` has already looked at, so a second one would be an arm no test
    // could take.
    let (a, applied, f) = pool.install(|| {
        assembly::assemble_stiffness(p, &pat).and_then(|a| {
            let mut f = a.f_thermal.clone();
            loads::assemble_loads(p, &mut f).map(|applied| (a, applied, f))
        })
    })?;
    // `checks::all` has already resolved these and paired every contact.
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    // `TᵀKT v = Tᵀf` with the slaves dropped from the free set; the GPU never sees this step,
    // because what reaches a solver is still a plain reduced `k_ff` (plan B §1).
    let (kt, ft) = pool.install(|| mpc::transform(&a.k, &f, &mpc));
    let red = assembly::reduce(&kt, &ft, &rc, &mpc.slaves);
    let (u_f, solver, factored) = solve_reusable(&red.k_ff, &red.f_f, opts, pool, gpu, progress).await?;
    let mut u = assembly::expand(&red, &u_f);
    mpc::recover(&mpc, &mut u);
    Ok(Statics { pat, a, applied, f, rc, mpc, red, u, solver, factored })
}

/// The stress, strain, von Mises and principal fields recovered from a displacement `u`, for
/// every procedure that ends on a displacement field.
///
/// The stiffness integral has already called this material on these elements, so the recovery
/// cannot fail here; `stress_gp` still reports it for a caller that skipped it.
pub(crate) fn stress_fields(p: &Problem<'_>, u: &[f64], pool: &Pool, fields: &mut BTreeMap<Field, FieldData>) {
    let (gp_stress, gp_strain) =
        pool.install(|| stress::stress_gp(p, u)).expect("the stiffness integral accepted this material");
    let unaveraged = stress::gp_to_nodes(p.mesh, &gp_stress);
    let nodal_stress = stress::average_at_nodes(p, &unaveraged);
    let nodal_strain = stress::average_at_nodes(p, &stress::gp_to_nodes(p.mesh, &gp_strain));
    fields.insert(Field::VonMises, stress::von_mises(&nodal_stress));
    fields.insert(Field::Principal, stress::principal(&nodal_stress));
    fields.insert(Field::Stress, nodal_stress);
    fields.insert(Field::StressUnaveraged, unaveraged);
    fields.insert(Field::Strain, nodal_strain);
    if p.mesh.blocks.iter().any(|b| b.kind == femlab_geometry::ElementKind::Shell4) {
        for (field, side) in [(Field::StressTop, 1.0), (Field::StressBottom, -1.0)] {
            let stress = pool
                .install(|| stress::shell_surface_stress(p, u, side))
                .expect("the shell stiffness integral accepted this section and material");
            fields.insert(field, stress);
        }
        let moment = pool
            .install(|| stress::shell_moments(p, u))
            .expect("the shell stiffness integral accepted this section and material");
        fields.insert(Field::ShellMoment, moment);
    }
    // Per-member section forces exist only where a beam does; a Result without beams keeps
    // exactly the fields it had.
    if p.has_beams() {
        let (force, moment) =
            pool.install(|| stress::section_fields(p, u)).expect("the stiffness integral accepted this member");
        fields.insert(Field::SectionForce, force);
        fields.insert(Field::SectionMoment, moment);
    }
}

/// Solve one linear static Step, over one increment or over an amplitude's schedule.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    p: &Problem<'_>,
    opts: &SolveOptions,
    dt: f64,
    t_end: f64,
    amplitude: Option<&Amplitude>,
    output_every: usize,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    if p.couplings.iter().any(Coupling::is_frictionless) {
        return run_contact(p, opts, dt, t_end, amplitude, output_every, pool, gpu, progress).await;
    }
    let s = statics(p, opts, pool, gpu, &mut progress).await?;
    post(p, s, opts, dt, t_end, amplitude, output_every, pool, gpu, progress).await
}

/// The same Constraints with every prescribed value scaled by `g`: what an amplitude does to
/// them at one instant.
fn scaled(rc: &assembly::ResolvedConstraints, g: f64) -> assembly::ResolvedConstraints {
    assembly::ResolvedConstraints {
        fixed: rc.fixed.iter().map(|&(d, v)| (d, g * v)).collect(),
        owner: rc.owner.clone(),
        inert: rc.inert.clone(),
    }
}

/// Everything one converged active-set solve leaves behind.
struct Settled {
    u: Vec<f64>,
    mpc: mpc::Mpc,
    red: assembly::Reduced,
    solver: SolveInfo,
    factored: Option<Direct>,
}

/// Linear contact: solve `TᵀKT v = Tᵀ(f − K g)` with the rows of the current active set,
/// move the set by what that solution says, and repeat until it stops moving.
///
/// `set` comes in as the starting guess and goes out as the settled set, so an amplitude's
/// increments each start from where the previous one ended. A reduced system that has lost
/// positive definiteness on the way is a part the contact alone was holding that has lifted
/// off: `contact.open`, rather than the solver's own complaint about a mechanism.
#[allow(clippy::too_many_arguments)]
async fn active_set_solve(
    p: &Problem<'_>,
    a: &assembly::Assembled,
    f: &[f64],
    rc: &assembly::ResolvedConstraints,
    base: &mpc::Mpc,
    set: &mut ActiveSet,
    opts: &SolveOptions,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    progress: &mut OnProgress<'_>,
) -> Result<Settled, Error> {
    let dpn = p.dofs_per_node();
    let stiffness = a.k.diag().into_iter().fold(0.0f64, f64::max);
    loop {
        let m = base.with_active(&set.active, true, dpn);
        let (kt, ft) = pool.install(|| mpc::transform(&a.k, f, &m));
        let red = assembly::reduce(&kt, &ft, rc, &m.slaves);
        let (u_f, solver, factored) = match solve_reusable(&red.k_ff, &red.f_f, opts, pool, gpu, progress).await {
            Ok(s) => s,
            Err(e) if e.code == ErrorCode::SolveNotPositiveDefinite => return Err(contact::lifted_off(p, &m, set)),
            Err(e) => return Err(e),
        };
        let mut u = assembly::expand(&red, &u_f);
        mpc::recover(&m, &mut u);
        let r = contact::residual(&a.k, &u, f);
        // Two things end a pass early, chatter and the host saying stop, and both are one
        // structured error out of the same place.
        let moved = set.update(p, &m, &u, &r, stiffness).and_then(|moved| {
            if moved {
                let text =
                    format!("active set changed: {} of {} paired nodes in contact", set.count(), set.active.len());
                report(progress, "contact", 0.5, &text)?;
            }
            Ok(moved)
        })?;
        if !moved {
            return Ok(Settled { u, mpc: m, red, solver, factored });
        }
    }
}

/// A static Step with a frictionless contact: the active-set solve of [`active_set_solve`],
/// once at full load or once per increment of the amplitude's schedule.
///
/// The schedule is a real increment loop rather than [`ramp`]'s scaling of two solved vectors,
/// because the active set — and with it the operator — depends on the load level; every
/// increment starts from the set the previous one settled on, which is what lets a gap close
/// partway through a Step and stay closed.
#[allow(clippy::too_many_arguments)]
async fn run_contact(
    p: &Problem<'_>,
    opts: &SolveOptions,
    dt: f64,
    t_end: f64,
    amplitude: Option<&Amplitude>,
    output_every: usize,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    report(&mut progress, "assemble", 0.1, "building the sparsity pattern")?;
    let dpn = p.dofs_per_node();
    let pat = assembly::pattern(p.mesh, dpn);
    let (a, mut applied, f) = pool.install(|| {
        assembly::assemble_stiffness(p, &pat).and_then(|a| {
            let mut f = a.f_thermal.clone();
            loads::assemble_loads(p, &mut f).map(|applied| (a, applied, f))
        })
    })?;
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let base = mpc::build(p).expect("the checks built the multipoint constraints");
    let mut set = ActiveSet::initial(&base);
    let mut scalars = BTreeMap::new();
    let mut history = None;
    let (settled, f_end, rc_end, g_end) = match amplitude {
        None => (active_set_solve(p, &a, &f, &rc, &base, &mut set, opts, pool, gpu, &mut progress).await?, f, rc, 1.0),
        Some(amp) => {
            let (steps, dt) = time_grid(dt, t_end)?;
            let every = output_every.max(1);
            let frames = retained_frame_count(steps, every).expect("time_grid bounds the retained-frame count");
            let mut h: Option<History> = None;
            let mut last = None;
            for step in 0..=steps {
                // The last increment lands on the requested endpoint exactly, not on `steps · dt`.
                let time = if step == steps { t_end } else { step as f64 * dt };
                let g = amp.at(time);
                // The thermal load is never scaled: the temperature is a field, not a Load.
                let f_t: Vec<f64> = f.iter().zip(&a.f_thermal).map(|(v, th)| th + g * (v - th)).collect();
                let rc_t = scaled(&rc, g);
                let s = active_set_solve(p, &a, &f_t, &rc_t, &base, &mut set, opts, pool, gpu, &mut progress).await?;
                match h.as_mut() {
                    None => h = Some(History::with_initial(Field::Displacement, s.u.clone(), frames)),
                    Some(h) if step % every == 0 || step == steps => {
                        h.times.push(time);
                        h.values.push(s.u.clone());
                    }
                    Some(_) => {}
                }
                last = Some((s, f_t, rc_t, g));
                report(&mut progress, "solve", 0.1 + 0.8 * step as f64 / steps as f64, "solving an increment")?;
            }
            scalars.insert("increments".to_string(), steps as f64);
            scalars.insert("dt".to_string(), dt);
            history = h;
            last.expect("a time grid has at least one step")
        }
    };
    for v in applied.force.iter_mut() {
        *v *= g_end;
    }
    let r = contact::residual(&a.k, &settled.u, &f_end);
    let Settled { u, mpc: m, red, solver, factored } = settled;
    let s = Statics { pat, a, applied, f: f_end, rc: rc_end, mpc: m, red, u, solver, factored };
    let mut res = post(p, s, opts, dt, t_end, None, output_every, pool, gpu, progress).await?;
    let (pressure, contacts) = contact::finish(p, &base, &set, &r, &mut res.warnings);
    res.extremes.extend(extremes(&pressure, p.mesh).into_iter().map(|e| (Field::ContactPressure, e)));
    res.fields.insert(Field::ContactPressure, pressure);
    res.contacts = contacts;
    res.history = history;
    res.scalars.extend(scalars);
    res.scalars.insert("contact_changes".to_string(), set.changes as f64);
    Ok(res)
}

/// The amplitude schedule, the reactions and the recovered fields of a solved static state.
///
/// A buckling Step reports the same static Result, so this is shared rather than copied: what
/// the two procedures disagree about is only what they add on top.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn post(
    p: &Problem<'_>,
    s: Statics,
    opts: &SolveOptions,
    dt: f64,
    t_end: f64,
    amplitude: Option<&Amplitude>,
    output_every: usize,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    let Statics { pat: _, a, applied, mut f, rc, mpc, red, mut u, mut solver, factored } = s;
    // A supernodal factor is the largest thing a solve allocates, and nothing below reads it.
    // Release it before the recovery buffers are allocated rather than at the end of the scope.
    drop(factored);
    let dpn = p.dofs_per_node();
    let mut scalars = BTreeMap::new();
    // Everything the amplitude scales: the applied totals, the load vector the reactions are
    // measured against, and `u_L`. One without an amplitude leaves all three exactly as they
    // were, because `g` is then the constant 1.
    let mut g_end = 1.0;
    let mut history = None;
    if let Some(amp) = amplitude {
        let (steps, dt) = time_grid(dt, t_end)?;
        // `u_th`: the thermal load alone at zero prescribed values. It is exactly zero without
        // a temperature field, and then the whole schedule costs the one solve above.
        let mut u_th = vec![0.0; a.k.n];
        if p.temperature.is_some() {
            // `Tᵀf_thermal`, because the reduced system this is solved against is `TᵀKT`.
            let ft_th = mpc::transpose_load(&mpc, &a.f_thermal);
            let f_th: Vec<f64> = red.free.iter().map(|&dof| ft_th[dof as usize]).collect();
            let (th_f, th) = solve(&red.k_ff, &f_th, opts, pool, gpu, &mut progress).await?;
            for (i, &dof) in red.free.iter().enumerate() {
                u_th[dof as usize] = th_f[i];
            }
            // `recover` is linear, so recovering the two parts separately and subtracting is
            // the same as recovering `u_L` itself; `ramp` then works on full fields.
            mpc::recover(&mpc, &mut u_th);
            // Two solves, one reported residual: the worse of them, never the flattering one.
            solver.rel_residual = solver.rel_residual.max(th.rel_residual);
        }
        let h = ramp(&u, &u_th, amp, steps, dt, t_end, output_every);
        g_end = amp.at(t_end);
        u.clone_from(&h.values[h.values.len() - 1]);
        for (v, th) in f.iter_mut().zip(&a.f_thermal) {
            *v = th + g_end * (*v - th);
        }
        scalars.insert("increments".to_string(), steps as f64);
        scalars.insert("dt".to_string(), dt);
        history = Some(h);
    }
    // The original `k` and `f`: a tie's internal force is never a support reaction.
    let r = assembly::reactions(&a.k, &u, &f, &red.fixed, &mpc);
    report(&mut progress, "post", 0.9, "recovering fields")?;

    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&u, dpn));
    if dpn == crate::fem::problem::NODE_DOFS_MAX {
        fields.insert(Field::Rotation, rotation_field(&u));
    }
    fields.insert(Field::Reaction, vector_field(&r, dpn));
    stress_fields(p, &u, pool, &mut fields);
    scalars.insert("min_det_j".to_string(), a.min_det_j);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        scalars.insert(format!("applied_total_{axis}"), applied.force[c] * g_end);
    }
    scalars.insert("rel_residual".to_string(), solver.rel_residual);
    let ex = fields
        .iter()
        .filter(|(_, f)| f.per != Per::ElemGp)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    let reactions = reactions_per_constraint(p, &rc, &fields[&Field::Reaction]);
    Ok(StepResult {
        reaction_quantity: crate::units::ReactionQuantity::Force,
        ply_stresses: pool
            .install(|| stress::shell_ply_stresses(p, &u))
            .expect("assembly and stress recovery accepted these shell sections"),
        fields,
        scalars,
        extremes: ex,
        reactions,
        frequencies: Vec::new(),
        buckling_factors: Vec::new(),
        modes: Vec::new(),
        modal_dofs: Vec::new(),
        history,
        sweep: None,
        prestress_from: None,
        solver,
        warnings: mpc.warnings,
        assumptions: Vec::new(),
        contacts: Vec::new(),
    })
}

/// Solve this static Step once per retained frame of a heat-transient predecessor's
/// temperature History (#84), instead of once at its final state.
///
/// `K` never depends on temperature — only the thermal load does — so this assembles the
/// stiffness and factorises it exactly once and reuses that factorisation for every frame; what
/// changes each pass is [`assembly::thermal_load`] alone. Solving N frames the way [`run`]
/// solves one (assemble, factorise, solve) would cost N full static solves for an operator that
/// never moves, which is what the first cut of this plan got wrong.
///
/// One frame's raw nodal values in, `solve_run`'s per-Body composed `(nodal, reference)` out —
/// exactly [`Problem::temperature`]'s own shape.
pub type ComposeTemperature<'a> = &'a mut dyn FnMut(&[f64]) -> Result<Option<(Vec<f64>, f64)>, Error>;

/// Everything [`run_history`] keeps from its last retained frame, once, to build the fields a
/// plain [`run`] would answer for that frame alone.
struct FinalFrame {
    u: Vec<f64>,
    reactions: Vec<f64>,
    stress: FieldData,
    strain: FieldData,
    unaveraged: FieldData,
}

/// `compose` is `solve_run`'s per-Body temperature composition (`thermal_field`), called once
/// per frame with that frame's raw nodal values so a chained Step reads the same reference
/// handling an unchained one already does; `p.temperature` carries whatever it answers and is
/// left holding the last frame's on return, so the kept [`StepResult`]'s fields are exactly
/// what [`run`] would answer for that frame alone — the final-field contract every other Step
/// keeps. `history` then carries one von Mises frame per output time.
///
/// ponytail: von Mises is the one field the two tutorials #84 targets read per frame — about
/// 8 bytes/node/frame, an order of magnitude under a displacement history. Widen `History` to
/// more than one field only when a case asks for stress components at every output time too.
pub fn run_history(
    p: &mut Problem<'_>,
    history: &History,
    compose: ComposeTemperature<'_>,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    // One factorisation serves every frame here, and a frictionless pair would need a new one
    // per frame per active-set pass; that is a loop this path was built not to have.
    if let Some(c) = p.couplings.iter().find(|c| c.is_frictionless()) {
        return Err(Error::unsupported(&format!(
            "frictionless contact '{}' in a static Step solved once per retained frame of a transient temperature",
            c.name()
        ))
        .at("after")
        .suggest("step.add after a steady heat Step, or contact.add with kind bonded"));
    }
    report(&mut progress, "assemble", 0.1, "building the sparsity pattern")?;
    let dpn = p.dofs_per_node();
    let pat = assembly::pattern(p.mesh, dpn);
    p.temperature = None;
    let (a, other, applied) = pool.install(|| {
        assembly::assemble_stiffness(p, &pat).and_then(|a| {
            let mut other = vec![0.0; a.k.n];
            loads::assemble_loads(p, &mut other).map(|applied| (a, other, applied))
        })
    })?;
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let mpc = mpc::build(p).expect("the checks built the multipoint constraints");
    let zeros = vec![0.0; a.k.n];
    let (kt, _) = pool.install(|| mpc::transform(&a.k, &zeros, &mpc));
    // `red.f_f`, folded against the all-zero load above, is exactly `-K_fc u_c`: the one
    // constant every frame's reduced right-hand side adds to its own transformed load.
    let red = assembly::reduce(&kt, &zeros, &rc, &mpc.slaves);
    drop(kt);
    drop(zeros);
    let mut factored = pool.install(|| Direct::factor(&red.k_ff))?;

    let n = history.times.len();
    let mut times = Vec::with_capacity(n);
    let mut von_mises_frames = Vec::with_capacity(n);
    let mut f_f = vec![0.0; red.free.len()];
    let mut u_f = vec![0.0; red.free.len()];
    let mut worst_residual = 0.0f64;
    let mut solver = SolveInfo { solver: "cpu-direct", iterations: 0, rel_residual: 0.0, time_ms: 0.0 };
    let mut last: Option<FinalFrame> = None;
    for (idx, (&time, values)) in history.times.iter().zip(&history.values).enumerate() {
        p.temperature = compose(values)?;
        let mut f = pool.install(|| assembly::thermal_load(p))?;
        for (v, o) in f.iter_mut().zip(&other) {
            *v += *o;
        }
        let load = mpc::transpose_load(&mpc, &f);
        for (i, &dof) in red.free.iter().enumerate() {
            f_f[i] = load[dof as usize] + red.f_f[i];
        }
        let info = factored.solve(&f_f, &mut u_f)?;
        worst_residual = worst_residual.max(info.rel_residual);
        solver = info;
        let mut u = assembly::expand(&red, &u_f);
        mpc::recover(&mpc, &mut u);
        let (gp_stress, gp_strain) =
            pool.install(|| stress::stress_gp(p, &u)).expect("the stiffness integral accepted this material");
        let unaveraged = stress::gp_to_nodes(p.mesh, &gp_stress);
        let nodal_stress = stress::average_at_nodes(p, &unaveraged);
        let von_mises = stress::von_mises(&nodal_stress);
        times.push(time);
        von_mises_frames.push(von_mises.data);
        if idx + 1 == n {
            let nodal_strain = stress::average_at_nodes(p, &stress::gp_to_nodes(p.mesh, &gp_strain));
            let reactions = assembly::reactions(&a.k, &u, &f, &red.fixed, &mpc);
            last = Some(FinalFrame { u, reactions, stress: nodal_stress, strain: nodal_strain, unaveraged });
        }
        report(&mut progress, "solve", 0.1 + 0.8 * (idx + 1) as f64 / n as f64, "solving a retained frame")?;
    }
    solver.rel_residual = worst_residual;
    // `history` is never empty: `solve_run` only takes this path for a predecessor History,
    // and `retained_frame_count` never answers zero.
    let FinalFrame { u, reactions: r, stress: nodal_stress, strain: nodal_strain, unaveraged } =
        last.expect("a retained History has at least one frame");
    report(&mut progress, "post", 0.9, "recovering fields")?;

    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&u, dpn));
    fields.insert(Field::Reaction, vector_field(&r, dpn));
    fields.insert(Field::VonMises, FieldData::new(Per::Node, 1, von_mises_frames[n - 1].clone()));
    fields.insert(Field::Principal, stress::principal(&nodal_stress));
    fields.insert(Field::Stress, nodal_stress);
    fields.insert(Field::StressUnaveraged, unaveraged);
    fields.insert(Field::Strain, nodal_strain);
    let mut scalars = BTreeMap::new();
    if dpn == crate::fem::problem::NODE_DOFS_MAX {
        fields.insert(Field::Rotation, rotation_field(&u));
    }
    if p.mesh.blocks.iter().any(|b| b.kind == femlab_geometry::ElementKind::Shell4) {
        stress_fields(p, &u, pool, &mut fields);
    }
    scalars.insert("min_det_j".to_string(), a.min_det_j);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        scalars.insert(format!("applied_total_{axis}"), applied.force[c]);
    }
    scalars.insert("rel_residual".to_string(), solver.rel_residual);
    let ex = fields
        .iter()
        .filter(|(_, f)| f.per != Per::ElemGp)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    let reactions = reactions_per_constraint(p, &rc, &fields[&Field::Reaction]);
    Ok(StepResult {
        reaction_quantity: crate::units::ReactionQuantity::Force,
        ply_stresses: pool
            .install(|| stress::shell_ply_stresses(p, &u))
            .expect("assembly and stress recovery accepted these shell sections"),
        fields,
        scalars,
        extremes: ex,
        reactions,
        frequencies: Vec::new(),
        modes: Vec::new(),
        modal_dofs: Vec::new(),
        history: Some(History { field: Field::VonMises, times, values: von_mises_frames }),
        buckling_factors: Vec::new(),
        sweep: None,
        prestress_from: None,
        solver,
        warnings: mpc.warnings,
        assumptions: Vec::new(),
        contacts: Vec::new(),
    })
}
