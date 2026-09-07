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
use crate::error::Error;
use crate::fem::problem::Problem;
use crate::fem::{assembly, checks, loads};
use crate::par::Pool;
use crate::post::{extremes, reactions_per_constraint, stress, Per};
use crate::procedure::{report, retained_frame_count, time_grid, vector_field, Amplitude, History, StepResult};
use crate::solve::{solve, SolveOptions};

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
    // `solve.run` refuses with the first failing check; `query.model.warnings` lists them all.
    if let Some(e) = checks::all(p).into_iter().next() {
        return Err(e);
    }
    report(&mut progress, "assemble", 0.1, "building the sparsity pattern")?;
    let dpn = p.dofs_per_node();
    let pat = assembly::pattern(p.mesh, dpn);
    // One `?`: the loads and the stiffness fail on the same materials and the same Sets, both
    // of which `checks::all` has already looked at, so a second one would be an arm no test
    // could take.
    let (a, applied, mut f) = pool.install(|| {
        assembly::assemble_stiffness(p, &pat).and_then(|a| {
            let mut f = a.f_thermal.clone();
            loads::assemble_loads(p, &mut f).map(|applied| (a, applied, f))
        })
    })?;
    // `checks::all` has already resolved these and found no conflict.
    let rc = assembly::resolve(p).expect("the checks resolved the constraints");
    let red = assembly::reduce(&a.k, &f, &rc);
    let (u_f, mut solver) = solve(&red.k_ff, &red.f_f, opts, pool, gpu, &mut progress).await?;
    let mut u = assembly::expand(&red, &u_f);
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
            let f_th: Vec<f64> = red.free.iter().map(|&dof| a.f_thermal[dof as usize]).collect();
            let (th_f, th) = solve(&red.k_ff, &f_th, opts, pool, gpu, &mut progress).await?;
            for (i, &dof) in red.free.iter().enumerate() {
                u_th[dof as usize] = th_f[i];
            }
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
    let r = assembly::reactions(&a.k, &u, &f, &red);
    report(&mut progress, "post", 0.9, "recovering fields")?;

    // The stiffness integral above already called this material on these elements, so the
    // recovery cannot fail here; `stress_gp` still reports it for a caller that skipped it.
    let (gp_stress, gp_strain) =
        pool.install(|| stress::stress_gp(p, &u)).expect("the stiffness integral accepted this material");
    let unaveraged = stress::gp_to_nodes(p.mesh, &gp_stress);
    let nodal_stress = stress::average_at_nodes(p, &unaveraged);
    let nodal_strain = stress::average_at_nodes(p, &stress::gp_to_nodes(p.mesh, &gp_strain));
    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vector_field(&u, dpn));
    fields.insert(Field::Reaction, vector_field(&r, dpn));
    fields.insert(Field::VonMises, stress::von_mises(&nodal_stress));
    fields.insert(Field::Principal, stress::principal(&nodal_stress));
    fields.insert(Field::Stress, nodal_stress);
    fields.insert(Field::StressUnaveraged, unaveraged);
    fields.insert(Field::Strain, nodal_strain);
    scalars.insert("min_det_j".to_string(), a.min_det_j);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        scalars.insert(format!("applied_total_{axis}"), applied.force[c] * g_end);
    }
    scalars.insert("rel_residual".to_string(), solver.rel_residual);
    let ex = fields
        .iter()
        .filter(|(_, f)| f.per == Per::Node)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    let reactions = reactions_per_constraint(p, &rc, &fields[&Field::Reaction]);
    Ok(StepResult {
        reaction_quantity: crate::units::ReactionQuantity::Force,
        fields,
        scalars,
        extremes: ex,
        reactions,
        frequencies: Vec::new(),
        modes: Vec::new(),
        history,
        solver,
        warnings: Vec::new(),
        assumptions: Vec::new(),
    })
}
