//! Explicit dynamics: central differences on a lumped mass (plan A §6).
//!
//! `M` is the HRZ-lumped diagonal, so every step is a divide rather than a solve. The step size
//! is Irons' bound `Δt = dt_factor · 2/ω_max` with `ω_max = max_e ω_max(e)`, which is an upper
//! bound on the global maximum frequency and therefore a safe estimate of the stability limit.
//!
//! Stability is watched, not assumed. For a linear undamped system the energy in the model can
//! never exceed the work the loads have done (plus whatever it started with), so the monitor is
//! `E > 1e3 · max(E₀, |W|)` — that is `explicit.unstable`, and it names the step it happened
//! at. f64 on the CPU; the f32 GPU port is a later commit.

use crate::command::Field;
use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::{assemble_stiffness, pattern, resolve};
use crate::fem::checks;
use crate::fem::element::element_for;
use crate::fem::loads::assemble_loads;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, Per};
use crate::procedure::{blank, report, vector_field, History, StepResult};
use crate::solve::SolveInfo;

/// Energy above this multiple of what the loads can account for is a diverging integration.
const BLOWUP: f64 = 1e3;

type LumpedMass = (Vec<f64>, f64, Option<(u32, usize)>);

/// Integrate one explicit dynamics Step.
pub fn run(
    p: &Problem<'_>,
    t_end: f64,
    dt_factor: f64,
    initial_velocity: Option<&[f64]>,
    output_every: usize,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    // A free body is what F1 integrates, so an unconstrained model is not an error here.
    if let Some(e) = checks::all(p).into_iter().find(|e| e.code != ErrorCode::ConstraintRigidModes) {
        return Err(e);
    }
    if t_end <= 0.0 || dt_factor <= 0.0 {
        return Err(Error::schema(format!(
            "an explicit Step needs tEnd > 0 and dtFactor > 0, got tEnd = {t_end}, dtFactor = {dt_factor}"
        ))
        .at("tEnd")
        .suggest("step.add { tEnd: \"1 ms\", dtFactor: 0.9 }"));
    }
    report(&mut progress, "assemble", 0.1, "building the stiffness and the lumped mass")?;
    let dpn = p.dofs_per_node();
    let pat = pattern(p.mesh, dpn);
    // Constrained DOFs are held at their prescribed value with zero velocity and acceleration.
    let rc = resolve(p).expect("the checks resolved the constraints");
    let mut held = vec![false; p.n_dofs()];
    let mut u = vec![0.0; p.n_dofs()];
    for &(dof, value) in &rc.fixed {
        held[dof as usize] = true;
        u[dof as usize] = value;
    }
    // One `?`: the mass, the stiffness and the loads fail on exactly the same materials and the
    // same Sets, so only the first of them is an arm a test can take.
    let (a, mass, omega_max, massless_free, f) = pool.install(|| {
        lumped_mass_and_omega(p, &held).and_then(|(mass, omega_max, massless_free)| {
            assemble_stiffness(p, &pat).and_then(|a| {
                let mut f = a.f_thermal.clone();
                assemble_loads(p, &mut f).map(|_| (a, mass, omega_max, massless_free, f))
            })
        })
    })?;
    for (dof, &m) in mass.iter().enumerate() {
        if !held[dof] && (!m.is_finite() || m <= 0.0) {
            let node = dof / dpn;
            let component = ["ux", "uy", "uz"][dof % dpn];
            return Err(Error::new(
                ErrorCode::ModelIllPosed,
                format!(
                    "node {node} has {m} lumped mass on free DOF {component}; explicit dynamics requires positive mass at every free DOF"
                ),
            )
            .at(format!("node {node}.{component}"))
            .suggest("material.add with rho, then material.assign to every dynamic Body"));
        }
    }
    if let Some((elem, dof)) = massless_free {
        let node = dof / dpn;
        let component = ["ux", "uy", "uz"][dof % dpn];
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            format!(
                "element {elem} has zero density but contributes stiffness to free DOF node {node}.{component}; its finite explicit frequency bound is undefined"
            ),
        )
        .at(format!("element {elem}"))
        .suggest("material.add with rho, or constraint.fix every DOF of the massless Body"));
    }
    if !omega_max.is_finite() || omega_max <= 0.0 {
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            "the model has no mass: no Material in this Step has a density",
        )
        .at("materials")
        .suggest("material.add with rho, e.g. \"7850 kg/m^3\""));
    }
    let dt_crit = 2.0 / omega_max;
    let dt = dt_factor * dt_crit;
    let n_steps = (t_end / dt).round().max(1.0) as usize;
    let every = output_every.max(1);

    // The free lumped masses were checked above; held DOFs are never multiplied by their
    // inverse, so a constrained node may legitimately belong only to a massless element.
    let minv: Vec<f64> = mass.iter().enumerate().map(|(i, &m)| if held[i] { 0.0 } else { 1.0 / m }).collect();
    let mut v = initial_velocity.map_or_else(|| vec![0.0; a.k.n], <[f64]>::to_vec);
    for (i, vi) in v.iter_mut().enumerate() {
        if held[i] {
            *vi = 0.0;
        }
    }
    let mut ku = vec![0.0; a.k.n];
    let accel = |u: &[f64], ku: &mut [f64]| -> Vec<f64> {
        a.k.spmv(u, ku);
        (0..u.len()).map(|i| if held[i] { 0.0 } else { minv[i] * (f[i] - ku[i]) }).collect()
    };
    // Half-step kick so the leapfrog is centred: v_{1/2} = v_0 + (Δt/2) a_0.
    let a0 = accel(&u, &mut ku);
    for (vi, ai) in v.iter_mut().zip(&a0) {
        *vi += 0.5 * dt * ai;
    }
    let e0 = energy(&a.k, &mass, &u, &v, &mut ku);
    let p0 = momentum(&mass, &v, dpn);
    let mut work = 0.0;
    let mut e_max: f64 = e0;
    let mut history = History { field: Field::Displacement, times: vec![0.0], values: vec![u.clone()] };
    for step in 1..=n_steps {
        for i in 0..u.len() {
            if !held[i] {
                let du = dt * v[i];
                work += f[i] * du;
                u[i] += du;
            }
        }
        let acc = accel(&u, &mut ku);
        for (vi, ai) in v.iter_mut().zip(&acc) {
            *vi += dt * ai;
        }
        let e = energy(&a.k, &mass, &u, &v, &mut ku);
        e_max = e_max.max(e);
        let budget = e0.max(work.abs()).max(f64::MIN_POSITIVE);
        if !e.is_finite() || e > BLOWUP * budget {
            return Err(Error::new(
                ErrorCode::ExplicitUnstable,
                format!(
                    "the integration diverged at step {step} of {n_steps}: the energy reached {e:.3e}, \
                     more than {BLOWUP:.0}× the {budget:.3e} the loads can account for"
                ),
            )
            .at(format!("step {step}"))
            .suggest(format!("step.add with dtFactor below {dt_factor}, e.g. 0.9")));
        }
        if step % every == 0 || step == n_steps {
            history.times.push(step as f64 * dt);
            history.values.push(u.clone());
        }
        report(&mut progress, "solve", 0.1 + 0.8 * step as f64 / n_steps as f64, "stepping in time")?;
    }
    let e_end = energy(&a.k, &mass, &u, &v, &mut ku);
    let p_end = momentum(&mass, &v, dpn);

    let mut res = blank(SolveInfo { solver: "cpu-explicit", iterations: n_steps, rel_residual: 0.0, time_ms: 0.0 });
    res.fields.insert(Field::Displacement, vector_field(&u, dpn));
    res.scalars.insert("min_det_j".to_string(), a.min_det_j);
    res.scalars.insert("dt".to_string(), dt);
    res.scalars.insert("dt_crit".to_string(), dt_crit);
    res.scalars.insert("omega_max".to_string(), omega_max);
    res.scalars.insert("steps".to_string(), n_steps as f64);
    res.scalars.insert("energy_initial".to_string(), e0);
    res.scalars.insert("energy_final".to_string(), e_end);
    res.scalars.insert("energy_max".to_string(), e_max);
    res.scalars.insert("energy_drift".to_string(), (e_end - e0).abs() / e0.max(work.abs()).max(f64::MIN_POSITIVE));
    let scale = p0.iter().map(|x| x * x).sum::<f64>().sqrt().max(f64::MIN_POSITIVE);
    let dp = (0..3).map(|c| (p_end[c] - p0[c]).powi(2)).sum::<f64>().sqrt();
    res.scalars.insert("momentum_change".to_string(), dp / scale);
    for (c, axis) in ["x", "y", "z"].iter().enumerate() {
        res.scalars.insert(format!("momentum_{axis}"), p_end[c]);
        res.scalars.insert(format!("applied_total_{axis}"), 0.0);
    }
    res.scalars.insert("rel_residual".to_string(), 0.0);
    res.extremes = res
        .fields
        .iter()
        .filter(|(_, fd)| fd.per == Per::Node)
        .flat_map(|(name, fd)| extremes(fd, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    res.history = Some(history);
    Ok(res)
}

/// The lumped mass per DOF, the largest element frequency bound, and the first massless element
/// that contributes stiffness to a free DOF.
fn lumped_mass_and_omega(p: &Problem<'_>, held: &[bool]) -> Result<LumpedMass, Error> {
    let dpn = p.dofs_per_node();
    let mut mass = vec![0.0; p.mesh.n_nodes() * dpn];
    let mut omega: f64 = 0.0;
    let mut massless_free = None;
    let mut coords = Vec::new();
    let mut me = Vec::new();
    let t = [0.0; 0];
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let (nn, nd) = (blk.kind.n_nodes(), blk.kind.n_nodes() * dpn);
        for i in 0..blk.n_elems() {
            let elem = blk.first_elem + i as u32;
            coords.resize(nn * 3, 0.0);
            p.mesh.elem_coords(elem, &mut coords);
            me.clear();
            me.resize(nd * nd, 0.0);
            // `checks::all` has already resolved every element material. A bad density keeps
            // the mass kernel's more useful `material.rho` location.
            let c = p.ctx(elem, &coords, &t).expect("checks verified every element material");
            element.mass(&c, &mut me, true)?;
            // A zero-density element contributes stiffness without a finite local frequency
            // bound. It is supported only when every one of its DOFs is held.
            if c.material.rho > 0.0 {
                omega = omega.max(element.omega_max(&c).map_err(|e| e.at(format!("element {elem}")))?);
            } else {
                let unsupported = p.mesh.elem_nodes(elem).iter().find_map(|&node| {
                    (0..dpn).map(|k| node as usize * dpn + k).find(|&dof| !held[dof]).map(|dof| (elem, dof))
                });
                massless_free = massless_free.or(unsupported);
            }
            for (a, &node) in p.mesh.elem_nodes(elem).iter().enumerate() {
                for k in 0..dpn {
                    mass[node as usize * dpn + k] += me[(a * dpn + k) * nd + a * dpn + k];
                }
            }
        }
    }
    Ok((mass, omega, massless_free))
}

/// `½ vᵀ M v + ½ uᵀ K u`: the monitor. Positive for a stable run, unbounded for an unstable one.
fn energy(k: &crate::fem::assembly::Csr, mass: &[f64], u: &[f64], v: &[f64], ku: &mut [f64]) -> f64 {
    k.spmv(u, ku);
    let kinetic: f64 = mass.iter().zip(v).map(|(m, vi)| 0.5 * m * vi * vi).sum();
    let strain: f64 = u.iter().zip(ku.iter()).map(|(ui, kui)| 0.5 * ui * *kui).sum();
    kinetic + strain
}

/// `Σ m v` per direction.
fn momentum(mass: &[f64], v: &[f64], dpn: usize) -> [f64; 3] {
    let mut p = [0.0; 3];
    for (i, (m, vi)) in mass.iter().zip(v).enumerate() {
        p[i % dpn] += m * vi;
    }
    p
}
